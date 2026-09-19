/**
 * PSEO 共享逻辑（服务端专用）：
 * - PseoRunnerConfig 定义默认值/清洗校验/持久化（存储于 SiteSetting.seoConfig JSON 的 pseo 字段，免 schema 变更）
 * - 关键词批量入库（批内去重 + P2002 容错）与 pending/failed 聚合页生成
 * - 关键词→书籍匹配（matchNovels）与已生成页读取（getGeneratedPseoPage）
 * - 供 /api/pseo/{generate,batch,config,[kw]} 与 /pseo/[kw] 落地页复用
 */
import { db, serializeSettingsWrite } from '@/lib/db'
import { renderTpl, sanitizeSeoConfig } from '@/lib/seo'
import { SUPPORTED_ENGINES, sanitizeKeyword } from '@/lib/suggest'
import type { NovelListItem, PseoRunnerConfig } from '@/lib/types'

export const DEFAULT_PSEO_CONFIG: PseoRunnerConfig = {
  sources: [...SUPPORTED_ENGINES],
  seeds: [],
  perSeedLimit: 12,
  maxKeywords: 200,
  expand: false,
  autoGenerate: true,
  collectBind: true,
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

function dedupTrim(words: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const w of words) {
    if (!w || seen.has(w)) continue
    seen.add(w)
    out.push(w)
  }
  return out
}

/** 任意来源的配置对象 → 合法 PseoRunnerConfig（引擎白名单、种子清洗限 20、数值夹取、布尔归一） */
export function sanitizePseoConfig(raw: unknown): PseoRunnerConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const sources = Array.isArray(r.sources)
    ? dedupTrim(r.sources.filter((s): s is string => typeof s === 'string' && (SUPPORTED_ENGINES as readonly string[]).includes(s)))
    : []
  // seeds 兼容数组（API）与多行字符串（调试直传）两种形态；逐条走 sanitizeKeyword 白名单清洗
  const seedsRaw = Array.isArray(r.seeds) ? r.seeds : typeof r.seeds === 'string' ? (r.seeds as string).split('\n') : []
  const seeds = dedupTrim(seedsRaw.map((s) => sanitizeKeyword(s)).filter(Boolean)).slice(0, 20)
  return {
    sources: sources.length ? sources : [...SUPPORTED_ENGINES],
    seeds,
    perSeedLimit: clamp(Math.round(Number(r.perSeedLimit)) || DEFAULT_PSEO_CONFIG.perSeedLimit, 3, 20),
    maxKeywords: clamp(Math.round(Number(r.maxKeywords)) || DEFAULT_PSEO_CONFIG.maxKeywords, 10, 500),
    expand: r.expand === true,
    autoGenerate: r.autoGenerate !== false,
    collectBind: r.collectBind !== false,
  }
}

function parseSeoConfigBlob(blob: string | null | undefined): Record<string, unknown> {
  try {
    return JSON.parse(blob || '{}') as Record<string, unknown>
  } catch {
    return {} // 配置损坏时从空重建，避免读写路径永久 500
  }
}

/** 读取站点设置中的 PSEO 运行配置（缺失/损坏时回退默认值） */
export async function getPseoConfig(): Promise<PseoRunnerConfig> {
  const row = await db.siteSetting.findUnique({ where: { id: 1 }, select: { seoConfig: true } })
  return sanitizePseoConfig(parseSeoConfigBlob(row?.seoConfig).pseo)
}

/** 合并写入 PSEO 运行配置（服务端读改写 seoConfig JSON，只动 pseo 字段，不影响 TDK 模板），返回保存后的完整配置 */
export async function savePseoConfig(patch: unknown): Promise<PseoRunnerConfig> {
  // 与 settings PATCH 共享同一 seoConfig JSON 读改写：进程内串行锁防并发互覆丢字段
  return serializeSettingsWrite(async () => {
    await db.siteSetting.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } })
    const row = await db.siteSetting.findUnique({ where: { id: 1 }, select: { seoConfig: true } })
    const parsed = parseSeoConfigBlob(row?.seoConfig)
    const merged = sanitizePseoConfig({ ...sanitizePseoConfig(parsed.pseo), ...(typeof patch === 'object' && patch ? patch : {}) })
    parsed.pseo = merged
    await db.siteSetting.update({ where: { id: 1 }, data: { seoConfig: JSON.stringify(parsed) } })
    return merged
  })
}

/**
 * 关键词按序入库（跳过已存在 + P2002 竞态容错），返回新增数。
 * entries 先批内去重再截断到 cap；source 取该词首次出现时的引擎标记。
 */
export async function insertKeywords(entries: { word: string; engine: string }[], cap = 200): Promise<number> {
  const engineOf = new Map<string, string>()
  const ordered: string[] = []
  for (const e of entries.slice(0, cap)) {
    if (!e.word) continue
    if (!engineOf.has(e.word)) {
      engineOf.set(e.word, e.engine)
      ordered.push(e.word)
    }
  }
  if (ordered.length === 0) return 0
  const existing = await db.pseoKeyword.findMany({ where: { keyword: { in: ordered } }, select: { keyword: true } })
  const existingSet = new Set(existing.map((r) => r.keyword))
  let added = 0
  for (const kw of ordered) {
    if (existingSet.has(kw)) continue
    const ok = await db.pseoKeyword
      .create({ data: { keyword: kw, source: engineOf.get(kw) ?? 'manual' } })
      .then(() => true)
      .catch(() => false) // 并发竞态撞 UNIQUE：视为已存在，不中断批次
    if (ok) added++
  }
  return added
}

/** 关键词 → 命中书籍聚合（标题/作者/分类/简介包含关键词，命中不足回退热门书）。
 * 回退为「垫底补位」而非整体替换：保留已命中书籍，热门书去重后补足 12 本；
 * 关键词完全无命中时即纯热门书兑底（聚合页永不空窗）。 */
const MATCH_SELECT = {
  id: true, title: true, author: true, description: true, cover: true, categoryId: true,
  category: { select: { name: true } }, status: true, isFeatured: true, isHot: true,
  wordCount: true, clicks: true, updatedAt: true,
  _count: { select: { chapters: true } },
  chapters: { orderBy: { idx: 'desc' as const }, take: 1, select: { title: true } },
} as const

export interface PseoNovelRow {
  id: number
  title: string
  author: string
  description: string
  cover: string
  categoryId: number
  category: { name: string } | null
  status: string
  isFeatured: boolean
  isHot: boolean
  wordCount: number
  clicks: number
  updatedAt: Date
  _count: { chapters: number }
  chapters: { title: string }[]
}

/** Prisma 行 → 前台 NovelListItem（/api/pseo/[kw] 与 /pseo/[kw] 落地页共用） */
export function toListItem(r: PseoNovelRow): NovelListItem {
  return {
    id: r.id, title: r.title, author: r.author, description: r.description, cover: r.cover,
    categoryId: r.categoryId, categoryName: r.category?.name ?? '未分类',
    status: r.status === 'finished' ? 'finished' : 'serial',
    isFeatured: r.isFeatured, isHot: r.isHot, wordCount: r.wordCount, clicks: r.clicks,
    chapterCount: r._count.chapters, lastChapterTitle: r.chapters[0]?.title ?? null,
    updatedAt: r.updatedAt.toISOString(),
  }
}

export async function matchNovels(keyword: string): Promise<PseoNovelRow[]> {
  const parts = keyword.split(/\s+/).filter(Boolean)
  const or = parts.flatMap((p) => [
    { title: { contains: p } },
    { author: { contains: p } },
    { description: { contains: p } },
    { category: { is: { name: { contains: p } } } },
  ])
  const novels = await db.novel.findMany({ where: { OR: or }, orderBy: { clicks: 'desc' }, take: 12, select: MATCH_SELECT })
  if (novels.length >= 3) return novels
  const hot = await db.novel.findMany({ orderBy: { clicks: 'desc' }, take: 12, select: MATCH_SELECT })
  const seen = new Set(novels.map((n) => n.id))
  for (const n of hot) {
    if (novels.length >= 12) break
    if (seen.has(n.id)) continue
    novels.push(n)
  }
  return novels
}

/** 取单本小说行（与 MATCH_SELECT 同构，供聚合页把绑定书强制排第一） */
export async function getNovelRowById(id: number): Promise<PseoNovelRow | null> {
  if (!Number.isInteger(id) || id <= 0) return null
  return db.novel.findUnique({ where: { id }, select: MATCH_SELECT })
}

/** novelIds 中把目标书移到首位（已在其位不动；不在列表则置顶插入），返回新数组 */
function putFirst(ids: number[], novelId: number): number[] {
  return [novelId, ...ids.filter((id) => id !== novelId)]
}

/**
 * 读取已生成的 PSEO 聚合页（仅 status='generated' 且 pageData 可解析时返回）。
 * 服务端复用：/api/pseo/[kw]（实时计算兑底）与 /pseo/[kw] 落地页（仅已生成页）。
 * 书单严格按 pageData.novelIds 保存顺序返回（采集绑定词的页绑定书第一，不被 clicks 排序打乱）；
 * 行上 novelId 有值但 novelIds 缺失/乱序的历史数据防御性置顶。
 */
export async function getGeneratedPseoPage(keyword: string) {
  const row = await db.pseoKeyword.findUnique({ where: { keyword } })
  if (row?.status !== 'generated' || !row.pageData) return null
  let saved: { novelIds?: unknown; title?: unknown; description?: unknown; keywords?: unknown }
  try {
    saved = JSON.parse(row.pageData) as typeof saved
  } catch {
    return null // pageData 损坏 → 调用方走实时计算/404
  }
  let ids = Array.isArray(saved.novelIds)
    ? saved.novelIds.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0)
    : []
  if (row.novelId != null) ids = putFirst(ids, row.novelId)
  const rows = ids.length
    ? await db.novel.findMany({ where: { id: { in: ids } }, select: MATCH_SELECT })
    : []
  // 按 novelIds 顺序还原（findMany 无序返回；已删除的书自然剔除）
  const byId = new Map(rows.map((r) => [r.id, r]))
  const ordered = ids.flatMap((id) => {
    const r = byId.get(id)
    return r ? [r] : []
  })
  return {
    keyword,
    novels: ordered.map(toListItem),
    generatedTitle: typeof saved.title === 'string' ? saved.title : '',
    generatedDescription: typeof saved.description === 'string' ? saved.description : '',
    generatedKeywords: typeof saved.keywords === 'string' ? saved.keywords : '',
  }
}

/** 为 pending/failed 关键词生成 PSEO 聚合页数据（自动 TDK 模板），返回生成数。
 * failed 一并重试：显式触发的重跑（如「重新生成聚合页」）即为失败关键词的恢复路径，
 * 否则 failed 是终态死路（无任何重置入口）。 */
export async function generatePendingPages(limit = 20): Promise<number> {
  const pending = await db.pseoKeyword.findMany({
    where: { status: { in: ['pending', 'failed'] } },
    take: Math.min(50, Math.max(1, limit)),
  })
  const setting = await db.siteSetting.findUnique({ where: { id: 1 } })
  // 白名单清洗：seoConfig 可能含非字符串模板（历史脏数据），renderTpl 需拿到可靠字符串
  const seo = sanitizeSeoConfig(parseSeoConfigBlob(setting?.seoConfig))
  const siteName = setting?.siteName ?? '青阅文学'

  let generated = 0
  for (const row of pending) {
    try {
      const novels = await matchNovels(row.keyword)
      const vars = {
        siteName,
        keyword: row.keyword,
        count: novels.length,
        novelTitle: novels[0]?.title ?? '',
        author: novels[0]?.author ?? '',
      }
      const pageData = {
        novelIds: novels.map((n) => n.id),
        title: renderTpl(seo.pseoTitle, vars),
        description: renderTpl(seo.pseoDescription, vars),
        keywords: renderTpl(seo.pseoKeywords, vars),
      }
      await db.pseoKeyword.update({
        where: { id: row.id },
        data: { status: 'generated', pageData: JSON.stringify(pageData) },
      })
      generated++
    } catch {
      await db.pseoKeyword.update({ where: { id: row.id }, data: { status: 'failed' } }).catch(() => {})
    }
  }
  return generated
}
