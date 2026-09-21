/**
 * 智能分类归并（服务端专用）：把源站五花八门的分类名归并到固定规范集，
 * 避免每个源站直建一套分类导致类目爆炸（取证实证：15 类中 7 个为源站原始名直建）。
 *
 * 三级流水线（逐级兜底）：
 *  L1 归一化 + 同义词精确映射 —— 零成本，覆盖绝大多数常见源站分类名
 *  L2 规范关键词包含匹配 —— 「玄幻魔法」含「玄幻」→ 玄幻奇幻（长关键词优先）
 *  L3 LLM 兜底 —— ZAI SDK（仅服务端），3s 超时、进程内缓存、in-flight 去重；
 *     失败/超时/非法输出一律静默归「未分类」，绝不阻塞采集主流程
 *
 * 规范集与站点种子分类保持一致（8 类）；「未分类」为唯一兜底类。
 */
import ZAI from 'z-ai-web-dev-sdk'
import { db } from '@/lib/db'

export const FALLBACK_CATEGORY = '未分类'

/** 规范分类集（与首页/分类页种子体系一致；清库重采后全站只会出现这些类目） */
export const CANONICAL_CATEGORIES = [
  '玄幻奇幻',
  '武侠仙侠',
  '都市言情',
  '历史军事',
  '科幻未来',
  '游戏竞技',
  '悬疑灵异',
  '轻小说',
] as const

const CANONICAL_SET: ReadonlySet<string> = new Set<string>(CANONICAL_CATEGORIES)

/** L1 同义词精确映射（key 为归一化后的分类名） */
const CATEGORY_SYNONYMS: Readonly<Record<string, string>> = {
  // 玄幻奇幻
  玄幻: '玄幻奇幻', 玄幻小说: '玄幻奇幻', 玄幻魔法: '玄幻奇幻', 玄幻奇缘: '玄幻奇幻',
  奇幻: '玄幻奇幻', 奇幻小说: '玄幻奇幻', 魔法: '玄幻奇幻', 异界: '玄幻奇幻',
  异世: '玄幻奇幻', 玄幻科幻: '玄幻奇幻', 东方玄幻: '玄幻奇幻', 西方奇幻: '玄幻奇幻',
  // 武侠仙侠
  武侠: '武侠仙侠', 武侠小说: '武侠仙侠', 仙侠: '武侠仙侠', 仙侠小说: '武侠仙侠',
  修真: '武侠仙侠', 修真小说: '武侠仙侠', 修仙: '武侠仙侠', 古典武侠: '武侠仙侠',
  武侠仙侠: '武侠仙侠', 仙侠修真: '武侠仙侠', 洪荒: '武侠仙侠',
  // 都市言情
  都市: '都市言情', 都市小说: '都市言情', 都市生活: '都市言情', 都市言情: '都市言情',
  言情: '都市言情', 言情小说: '都市言情', 现代都市: '都市言情', 现实: '都市言情',
  现实百态: '都市言情', 官场: '都市言情', 商战: '都市言情', 婚恋: '都市言情',
  女生: '都市言情', 女生频道: '都市言情', 女频: '都市言情', 职场: '都市言情',
  // 历史军事
  历史: '历史军事', 历史小说: '历史军事', 历史军事: '历史军事', 军事: '历史军事',
  军事小说: '历史军事', 架空历史: '历史军事', 秦汉三国: '历史军事', 抗战: '历史军事',
  // 科幻未来
  科幻: '科幻未来', 科幻小说: '科幻未来', 科幻空间: '科幻未来', 科幻未来: '科幻未来',
  未来: '科幻未来', 末世: '科幻未来', 末世危机: '科幻未来', 星际: '科幻未来',
  星际文明: '科幻未来', 机甲: '科幻未来', 末日: '科幻未来', 赛博朋克: '科幻未来',
  // 游戏竞技
  游戏: '游戏竞技', 游戏小说: '游戏竞技', 游戏竞技: '游戏竞技', 竞技: '游戏竞技',
  网游: '游戏竞技', 网游小说: '游戏竞技', 电竞: '游戏竞技', 体育: '游戏竞技',
  体育竞技: '游戏竞技', 虚拟网游: '游戏竞技',
  // 悬疑灵异
  悬疑: '悬疑灵异', 悬疑小说: '悬疑灵异', 悬疑灵异: '悬疑灵异', 灵异: '悬疑灵异',
  恐怖: '悬疑灵异', 惊悚: '悬疑灵异', 推理: '悬疑灵异', 推理侦探: '悬疑灵异',
  侦探: '悬疑灵异', 盗墓: '悬疑灵异', 灵异推理: '悬疑灵异', 悬疑探险: '悬疑灵异',
  // 轻小说
  轻小说: '轻小说', 二次元: '轻小说', 同人: '轻小说', 同人小说: '轻小说',
  同人衍生: '轻小说', 衍生: '轻小说', 日轻: '轻小说', 动漫: '轻小说',
  // 兜底类名直接命中
  未分类: FALLBACK_CATEGORY, 其他: FALLBACK_CATEGORY, 其他小说: FALLBACK_CATEGORY,
  unknown: FALLBACK_CATEGORY,
}

/** L2 关键词包含匹配表：[关键词, 规范类]（长关键词优先，命中即返回） */
const CATEGORY_KEYWORDS: ReadonlyArray<readonly [string, string]> = [
  ['玄幻', '玄幻奇幻'], ['奇幻', '玄幻奇幻'], ['魔法', '玄幻奇幻'], ['异界', '玄幻奇幻'],
  ['御兽', '玄幻奇幻'], ['魔导', '玄幻奇幻'], ['斗气', '玄幻奇幻'], ['武魂', '玄幻奇幻'],
  ['仙侠', '武侠仙侠'], ['武侠', '武侠仙侠'], ['修真', '武侠仙侠'], ['修仙', '武侠仙侠'], ['洪荒', '武侠仙侠'], ['长生', '武侠仙侠'],
  ['言情', '都市言情'], ['都市', '都市言情'], ['现实', '都市言情'], ['官场', '都市言情'], ['商战', '都市言情'], ['职场', '都市言情'],
  ['官道', '都市言情'], ['七零', '都市言情'], ['八零', '都市言情'], ['神豪', '都市言情'], ['美食', '都市言情'], ['种田', '都市言情'], ['婚恋', '都市言情'], ['竹马', '都市言情'],
  ['历史', '历史军事'], ['军事', '历史军事'], ['战争', '历史军事'], ['逃荒', '历史军事'], ['宦海', '历史军事'], ['皇宫', '历史军事'],
  ['科幻', '科幻未来'], ['末世', '科幻未来'], ['末日', '科幻未来'], ['星际', '科幻未来'], ['机甲', '科幻未来'], ['未来', '科幻未来'], ['外星', '科幻未来'], ['无限流', '科幻未来'],
  ['游戏', '游戏竞技'], ['竞技', '游戏竞技'], ['网游', '游戏竞技'], ['电竞', '游戏竞技'], ['体育', '游戏竞技'], ['直播', '游戏竞技'],
  ['悬疑', '悬疑灵异'], ['灵异', '悬疑灵异'], ['恐怖', '悬疑灵异'], ['惊悚', '悬疑灵异'],
  ['推理', '悬疑灵异'], ['侦探', '悬疑灵异'], ['盗墓', '悬疑灵异'], ['探险', '悬疑灵异'],
  ['轻小说', '轻小说'], ['二次元', '轻小说'], ['同人', '轻小说'], ['动漫', '轻小说'], ['人外', '轻小说'],
]

/** 归一化：去空白与常见分隔符、全角转半角、小写 */
function normalizeCategory(raw: string): string {
  return (raw || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[·・_\-—~～/／\\|｜:：,，、。.()（）[\]【】<>《》"'']+/g, '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    .slice(0, 50)
}

// ==================== 进程内缓存与 LLM 调用治理 ====================
const gCat = globalThis as unknown as {
  __catCache?: Map<string, string> // normalized → 规范分类名（L1/L2/L3 结果统一缓存）
  __catInflight?: Map<string, Promise<string>>
  __zai?: Awaited<ReturnType<typeof ZAI.create>> | false // false = 初始化失败，不再重试
  __catLlmChain?: Promise<unknown> // LLM 全局串行链（并发 429 防护）
  __catLlmCooldownUntil?: number // LLM 失败冷却窗：期间直接走兜底，不再触发限流
}
const catCache: Map<string, string> = (gCat.__catCache ??= new Map())
const catInflight: Map<string, Promise<string>> = (gCat.__catInflight ??= new Map())

const LLM_TIMEOUT_MS = 3_000
const LLM_COOLDOWN_MS = 30_000 // 失败后 30s 内不再调用（429 等限流退避）

async function getZai(): Promise<Awaited<ReturnType<typeof ZAI.create>> | null> {
  if (gCat.__zai === false) return null
  if (gCat.__zai) return gCat.__zai
  try {
    gCat.__zai = await ZAI.create()
    return gCat.__zai
  } catch {
    gCat.__zai = false // SDK 不可用时永久走 L1/L2/兜底，避免每本书都白等超时
    return null
  }
}

const LLM_SYSTEM_PROMPT =
  `你是中文网文分类器。把给定的源站分类名归入以下候选之一，` +
  `只输出分类名本身，不要任何其他文字：` +
  `${CANONICAL_CATEGORIES.join('、')}、${FALLBACK_CATEGORY}。无法判断时输出 ${FALLBACK_CATEGORY}。`

/** L3 LLM 兜底核心（分类名场景，不设并发闸，由 llmClassify 串行化调用） */
async function llmClassifyOnce(rawName: string): Promise<string> {
  const zai = await getZai()
  if (!zai) return FALLBACK_CATEGORY
  try {
    const completion = await Promise.race([
      zai.chat.completions.create({
        messages: [
          { role: 'assistant', content: LLM_SYSTEM_PROMPT },
          { role: 'user', content: `源站分类名：「${rawName.slice(0, 40)}」` },
        ],
        thinking: { type: 'disabled' },
      }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('LLM 超时')), LLM_TIMEOUT_MS)),
    ])
    const out = (completion.choices[0]?.message?.content ?? '').trim().slice(0, 20)
    return CANONICAL_SET.has(out) ? out : FALLBACK_CATEGORY
  } catch {
    // 429/超时/网络失败：进入冷却窗，避免重采高峰把限流打穿
    gCat.__catLlmCooldownUntil = Date.now() + LLM_COOLDOWN_MS
    return FALLBACK_CATEGORY
  }
}

/** L3 LLM 兜底：全局串行 + 冷却窗，失败一律返回 FALLBACK，绝不 throw、绝不阻塞采集主流程 */
async function llmClassify(rawName: string): Promise<string> {
  if (Date.now() < (gCat.__catLlmCooldownUntil ?? 0)) return FALLBACK_CATEGORY
  // 挂到全局 Promise 链上串行执行：LLM 限流下并发调用只会放大失败
  const run = (gCat.__catLlmChain ?? Promise.resolve()).then(
    () => llmClassifyOnce(rawName),
    () => llmClassifyOnce(rawName),
  )
  gCat.__catLlmChain = run.catch(() => {})
  return run
}

/** 书名+简介推断分类的缓存键（与分类名缓存同 Map，前缀隔离） */
function hintKey(title: string): string {
  return `hint:${normalizeCategory(title)}`
}

/** L3+ 书名+简介推断：源站分类名缺失/不可归并时，由书名与简介推断规范类（同样串行+冷却+缓存） */
async function llmClassifyBook(title: string, description: string): Promise<string> {
  if (Date.now() < (gCat.__catLlmCooldownUntil ?? 0)) return FALLBACK_CATEGORY
  const key = hintKey(title)
  const run = (gCat.__catLlmChain ?? Promise.resolve()).then(
    async () => {
      try {
        const zai = await getZai()
        if (!zai) return FALLBACK_CATEGORY
        const desc = (description || '').replace(/\s+/g, ' ').trim().slice(0, 160)
        const completion = await Promise.race([
          zai.chat.completions.create({
            messages: [
              { role: 'assistant', content: LLM_SYSTEM_PROMPT },
              {
                role: 'user',
                content: `书名《${title.slice(0, 40)}》${desc ? `，简介：${desc}` : ''}。判断它属于哪个分类，只输出分类名。`,
              },
            ],
            thinking: { type: 'disabled' },
          }),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('LLM 超时')), LLM_TIMEOUT_MS)),
        ])
        const out = (completion.choices[0]?.message?.content ?? '').trim().slice(0, 20)
        return CANONICAL_SET.has(out) ? out : FALLBACK_CATEGORY
      } catch {
        gCat.__catLlmCooldownUntil = Date.now() + LLM_COOLDOWN_MS
        return FALLBACK_CATEGORY
      }
    },
    () => FALLBACK_CATEGORY,
  )
  gCat.__catLlmChain = run.catch(() => {})
  return run
}

/**
 * 把源站分类名归并为规范分类名（纯映射，不触 DB；带缓存与 in-flight 去重）。
 * 供采集入库与诊断脚本共用。
 */
export async function canonicalCategory(rawName: string): Promise<string> {
  const clean = (rawName || '').trim().slice(0, 50)
  const norm = normalizeCategory(clean)
  if (!norm) return FALLBACK_CATEGORY

  const cached = catCache.get(norm)
  if (cached) return cached

  // L1 同义词精确命中
  const syn = CATEGORY_SYNONYMS[norm]
  if (syn) {
    catCache.set(norm, syn)
    return syn
  }
  // L1.5 源站名本身已是规范名
  if (CANONICAL_SET.has(clean)) {
    catCache.set(norm, clean)
    return clean
  }
  // L2 关键词包含命中
  for (const [kw, canon] of CATEGORY_KEYWORDS) {
    if (norm.includes(kw)) {
      catCache.set(norm, canon)
      return canon
    }
  }
  // L3 LLM 兜底（in-flight 去重：同分类名并发采集只调一次）
  const inflight = catInflight.get(norm)
  if (inflight) return inflight
  const task = llmClassify(clean)
    .then((canon) => {
      catCache.set(norm, canon)
      return canon
    })
    .finally(() => catInflight.delete(norm))
  catInflight.set(norm, task)
  return task
}

/**
 * 书名关键词本地归类（零成本）：网文书名普遍自带类型词（如「都市」「仙」「末世」「游戏」），
 * 未分类书批量重归类时先跑本地匹配，仅残余走 LLM。命中返回规范类，未命中返回 null。
 */
export function classifyBookByTitle(title: string): string | null {
  const norm = normalizeCategory(title)
  if (!norm) return null
  for (const [kw, canon] of CATEGORY_KEYWORDS) {
    if (norm.includes(kw)) return canon
  }
  return null
}

/**
 * 带书名/简介提示的归并：分类名归并失败（含源站无分类信息）时，退而由书名+简介 LLM 推断。
 * 采集入库主入口；重采后的未分类书重归类脚本也复用。
 */
export async function canonicalCategoryWithHint(
  rawName: string,
  hint?: { title?: string; description?: string },
): Promise<string> {
  const direct = await canonicalCategory(rawName)
  if (direct !== FALLBACK_CATEGORY) return direct
  const title = (hint?.title || '').trim()
  if (!title) return FALLBACK_CATEGORY
  const key = hintKey(title)
  const cached = catCache.get(key)
  if (cached) return cached
  // 先书名关键词本地匹配（零成本），残余才走 LLM
  const local = classifyBookByTitle(title)
  if (local) {
    catCache.set(key, local)
    return local
  }
  const canon = await llmClassifyBook(title, hint?.description ?? '')
  catCache.set(key, canon)
  return canon
}

/**
 * 分类保障：归并出规范名后确保 DB 存在该分类（并发创建撞唯一约束 → 回读）。
 * 返回分类 id；失败抛错由调用方决定任务成败（与原 ensureCategory 契约一致）。
 */
export async function ensureCategory(
  name: string,
  hint?: { title?: string; description?: string },
): Promise<number> {
  const canon = await canonicalCategoryWithHint(name, hint)
  const found = await db.category.findUnique({ where: { name: canon } }).catch(() => null)
  if (found) return found.id
  try {
    const created = await db.category.create({ data: { name: canon } })
    return created.id
  } catch {
    // 并发创建撞唯一约束 → 重查
    const again = await db.category.findUnique({ where: { name: canon } }).catch(() => null)
    if (!again) throw new Error(`分类「${canon}」创建失败`)
    return again.id
  }
}
