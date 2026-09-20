/**
 * 智能分类归并（服务端专用）：源站分类名 → 站点规范分类。
 *
 * 三级归并策略（解决分类泛滥与"未分类"两大问题）：
 *   a. 规范化 + 同义词表精确/包含匹配 —— 覆盖绝大多数源站分类词
 *   b. 关键词计分匹配 —— 处理复合词（如「网游竞技」「科幻末世」）
 *   c. LLM 兜底 —— 源站分类缺失或无法识别时，按书名+简介推断规范分类
 *
 * 不变量：数据库中只可能存在 CANONICAL 中定义的分类（其余一律归并），
 * 任何失败路径最终都落到「其他」，绝不再产生「未分类」或源站原始分类名。
 */
import { db } from '@/lib/db'

/** 站点规范分类（有序；与前台分类导航一致） */
export const CANONICAL_CATEGORIES = [
  '玄幻奇幻',
  '武侠仙侠',
  '都市言情',
  '历史军事',
  '科幻未来',
  '游戏竞技',
  '悬疑灵异',
  '轻小说',
  '其他',
] as const

export type CanonicalCategory = (typeof CANONICAL_CATEGORIES)[number]

/** 兜底分类：所有无法归类的最终归宿（不再使用「未分类」） */
const FALLBACK_CATEGORY: CanonicalCategory = '其他'

/**
 * 同义词表：源站常见分类词（含变体/后缀）→ 规范分类。
 * 匹配时对规范化后的源站分类名做「全等或包含」判断。
 */
const SYNONYMS: ReadonlyArray<readonly [string, CanonicalCategory]> = [
  // 玄幻奇幻
  ['玄幻', '玄幻奇幻'],
  ['奇幻', '玄幻奇幻'],
  ['魔法', '玄幻奇幻'],
  ['异世', '玄幻奇幻'],
  ['玄奇', '玄幻奇幻'],
  ['魔幻', '玄幻奇幻'],
  // 武侠仙侠
  ['武侠', '武侠仙侠'],
  ['仙侠', '武侠仙侠'],
  ['修真', '武侠仙侠'],
  ['修仙', '武侠仙侠'],
  ['仙侠武侠', '武侠仙侠'],
  ['江湖', '武侠仙侠'],
  ['武侠仙侠', '武侠仙侠'],
  // 都市言情
  ['都市', '都市言情'],
  ['言情', '都市言情'],
  ['总裁', '都市言情'],
  ['婚恋', '都市言情'],
  ['现言', '都市言情'],
  ['古言', '都市言情'],
  ['情感', '都市言情'],
  ['校园', '都市言情'],
  ['商战', '都市言情'],
  ['官场', '都市言情'],
  ['职场', '都市言情'],
  ['豪门', '都市言情'],
  ['都市言情', '都市言情'],
  // 历史军事
  ['历史', '历史军事'],
  ['军事', '历史军事'],
  ['战争', '历史军事'],
  ['抗战', '历史军事'],
  ['架空', '历史军事'],
  ['历代', '历史军事'],
  ['历史军事', '历史军事'],
  // 科幻未来
  ['科幻', '科幻未来'],
  ['未来', '科幻未来'],
  ['星际', '科幻未来'],
  ['机甲', '科幻未来'],
  ['末世', '科幻未来'],
  ['末日', '科幻未来'],
  ['太空', '科幻未来'],
  ['科幻未来', '科幻未来'],
  // 游戏竞技
  ['游戏', '游戏竞技'],
  ['网游', '游戏竞技'],
  ['竞技', '游戏竞技'],
  ['电竞', '游戏竞技'],
  ['电竞', '游戏竞技'],
  ['游戏竞技', '游戏竞技'],
  // 悬疑灵异
  ['悬疑', '悬疑灵异'],
  ['灵异', '悬疑灵异'],
  ['惊悚', '悬疑灵异'],
  ['推理', '悬疑灵异'],
  ['侦探', '悬疑灵异'],
  ['恐怖', '悬疑灵异'],
  ['盗墓', '悬疑灵异'],
  ['鬼怪', '悬疑灵异'],
  ['悬疑灵异', '悬疑灵异'],
  // 轻小说
  ['轻小说', '轻小说'],
  ['同人', '轻小说'],
  ['二次元', '轻小说'],
  ['衍生', '轻小说'],
  // 直名规范集
  ...CANONICAL_CATEGORIES.map((n) => [n, n] as const),
]

/** 规范化源站分类名：去空白/全角空格、去「小说/类」后缀、截断 */
function normalizeCategoryName(raw: string): string {
  return (raw || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/(小说|分类|频道|书库|作品)$/u, '')
    .slice(0, 30)
}

/**
 * 同义词 + 关键词计分匹配。
 * 返回规范分类名；无法匹配返回 null（交给 LLM 兜底）。
 * 计分规则：命中关键词按长度累加，取最高分（同分取先声明者），解决
 * 「网游竞技」「科幻末世」一类复合词的归属歧义。
 */
export function matchCanonical(raw: string): CanonicalCategory | null {
  const name = normalizeCategoryName(raw)
  if (!name) return null
  let best: CanonicalCategory | null = null
  let bestScore = 0
  for (const [syn, canonical] of SYNONYMS) {
    if (!syn) continue
    if (name === syn) return canonical // 全等直接命中（最常见路径，如「玄幻」）
    if (name.includes(syn)) {
      const score = syn.length
      if (score > bestScore) {
        best = canonical
        bestScore = score
      }
    }
  }
  return best
}

// ==================== LLM 兜底（仅服务端） ====================

import ZAI from 'z-ai-web-dev-sdk'

const LLM_TIMEOUT_MS = 8_000
const MAX_LLM_INPUT_CHARS = 600

/** 进程内缓存：同一原始分类词/书名只问一次 LLM（跨 HMR 稳定） */
const gCache = globalThis as unknown as {
  __catLLMCache?: Map<string, CanonicalCategory | null>
  __catLLMInflight?: Map<string, Promise<CanonicalCategory | null>>
}
const llmCache: Map<string, CanonicalCategory | null> = (gCache.__catLLMCache ??= new Map())
const llmInflight: Map<string, Promise<CanonicalCategory | null>> = (gCache.__catLLMInflight ??= new Map())

let zaiInstance: Awaited<ReturnType<typeof ZAI.create>> | null = null
async function getZai() {
  if (!zaiInstance) zaiInstance = await ZAI.create()
  return zaiInstance
}

function buildLLMPrompt(rawCategory: string, title: string, description: string): string {
  const info: string[] = []
  if (rawCategory) info.push(`源站分类：${rawCategory}`)
  if (title) info.push(`书名：《${title.slice(0, 60)}》`)
  if (description) info.push(`简介：${description.slice(0, MAX_LLM_INPUT_CHARS)}`)
  return [
    '请判断这本网络小说属于以下哪个分类，必须从列表中选一个，用完整名称回复，只回复分类名称本身，不要任何其他文字：',
    CANONICAL_CATEGORIES.join(' / '),
    '（示例回复：玄幻奇幻）',
    '',
    ...info,
  ].join('\n')
}

/** 校验 LLM 输出：先走同义词链（容忍「都市」「玄幻」等短形回答），再全名包含匹配 */
function parseLLMCategory(text: string | null | undefined): CanonicalCategory | null {
  if (!text) return null
  const cleaned = text.replace(/[「」"'‘’“”\s]/g, '')
  const viaSynonym = matchCanonical(cleaned)
  if (viaSynonym) return viaSynonym
  for (const c of CANONICAL_CATEGORIES) {
    if (cleaned.includes(c)) return c
  }
  return null
}

/**
 * LLM 推断规范分类：带超时、进程内缓存与 in-flight 去重（并发同名只问一次）。
 * 限流/瞬时失败重试一次（采集阶段1多任务并发易触发 429）；两次都失败返回 null
 * （调用方落「其他」，不缓存失败结果，下次任务仍可重试）。
 */
async function llmClassify(cacheKey: string, rawCategory: string, title: string, description: string): Promise<CanonicalCategory | null> {
  if (llmCache.has(cacheKey)) return llmCache.get(cacheKey) ?? null
  const existing = llmInflight.get(cacheKey)
  if (existing) return existing
  const task = (async (): Promise<CanonicalCategory | null> => {
    try {
      const zai = await getZai()
      const prompt = buildLLMPrompt(rawCategory, title, description)
      const callOnce = () =>
        Promise.race([
          zai.chat.completions.create({
            messages: [{ role: 'user', content: prompt }],
            thinking: { type: 'disabled' },
          }),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('llm-timeout')), LLM_TIMEOUT_MS)),
        ])
      let completion: Awaited<ReturnType<typeof zai.chat.completions.create>>
      try {
        completion = (await callOnce()) as Awaited<ReturnType<typeof zai.chat.completions.create>>
      } catch {
        // 限流/瞬时错误：退避后重试一次
        await new Promise((resolve) => setTimeout(resolve, 1_500))
        completion = (await callOnce()) as Awaited<ReturnType<typeof zai.chat.completions.create>>
      }
      const result = parseLLMCategory(completion.choices[0]?.message?.content)
      llmCache.set(cacheKey, result)
      return result
    } catch {
      return null // 失败不缓存，下次任务仍可重试
    } finally {
      llmInflight.delete(cacheKey)
    }
  })()
  llmInflight.set(cacheKey, task)
  return task
}

// ==================== 入口 ====================

/**
 * 解析规范分类 id。
 * - raw：源站分类名（可为空）
 * - hint：书名/简介，供 LLM 在源站分类缺失时推断
 * 三级归并：同义词 → 关键词计分 → LLM（源站分类缺失或未命中时）→ 其他。
 * 保证只返回 CANONICAL_CATEGORIES 中分类的 id；分类行不存在则创建（并发安全）。
 */
export async function ensureCategory(raw: string, hint?: { title?: string; description?: string }): Promise<number> {
  let canonical = matchCanonical(raw)

  // 源站分类缺失或无法识别 → LLM 兜底（缓存键：非空分类词优先，其次书名）
  if (!canonical) {
    const name = normalizeCategoryName(raw)
    const cacheKey = name || `t:${(hint?.title || '').trim()}`
    const llmResult = await llmClassify(cacheKey, name, hint?.title ?? '', hint?.description ?? '')
    canonical = llmResult ?? FALLBACK_CATEGORY
  }

  const found = await db.category.findUnique({ where: { name: canonical } }).catch(() => null)
  if (found) return found.id
  try {
    const created = await db.category.create({ data: { name: canonical, sort: CANONICAL_CATEGORIES.indexOf(canonical) } })
    return created.id
  } catch {
    // 并发创建撞唯一约束 → 重查
    const again = await db.category.findUnique({ where: { name: canonical } }).catch(() => null)
    if (!again) throw new Error(`分类「${canonical}」创建失败`)
    return again.id
  }
}
