/**
 * PSEO 共享逻辑（服务端专用）：
 * - PseoRunnerConfig 定义默认值/清洗校验/持久化（存储于 SiteSetting.seoConfig JSON 的 pseo 字段，免 schema 变更）
 * - 关键词批量入库（批内去重 + P2002 容错）与 pending 聚合页生成
 * - 供 /api/pseo/generate、/api/pseo/batch、/api/pseo/config 三个路由复用
 */
import { db, serializeSettingsWrite } from '@/lib/db'
import { renderTpl, sanitizeSeoConfig } from '@/lib/seo'
import { SUPPORTED_ENGINES, sanitizeKeyword } from '@/lib/suggest'
import type { NovelListItem, PseoPageData, PseoRunnerConfig } from '@/lib/types'

export const DEFAULT_PSEO_CONFIG: PseoRunnerConfig = {
  sources: [...SUPPORTED_ENGINES],
  seeds: [],
  perSeedLimit: 12,
  maxKeywords: 200,
  expand: false,
  autoGenerate: true,
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

/** 关键词 → 命中书籍聚合（标题/作者/分类/简介包含关键词，命中不足回退热门书） */
export async function matchNovels(keyword: string) {
  const parts = keyword.split(/\s+/).filter(Boolean)
  const or = parts.flatMap((p) => [
    { title: { contains: p } },
    { author: { contains: p } },
    { description: { contains: p } },
    { category: { is: { name: { contains: p } } } },
  ])
  const select = {
    id: true, title: true, author: true, description: true, cover: true, categoryId: true,
    category: { select: { name: true } }, status: true, isFeatured: true, isHot: true,
    wordCount: true, clicks: true, updatedAt: true,
    _count: { select: { chapters: true } },
    chapters: { orderBy: { idx: 'desc' as const }, take: 1, select: { title: true } },
  }
  let novels = await db.novel.findMany({ where: { OR: or }, orderBy: { clicks: 'desc' }, take: 12, select })
  if (novels.length < 3) {
    novels = await db.novel.findMany({ orderBy: { clicks: 'desc' }, take: 12, select })
  }
  return novels
}

/** 为 pending 关键词生成 PSEO 聚合页数据（自动 TDK 模板），返回生成数 */
export async function generatePendingPages(limit = 20): Promise<number> {
  const pending = await db.pseoKeyword.findMany({ where: { status: 'pending' }, take: Math.min(50, Math.max(1, limit)) })
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

// ==================== PSEO 落地页数据（/pseo/{keyword} 服务端渲染用） ====================

/** 聚合页书籍查询（与 /api/pseo/[kw] 同口径：含分类名/章节数/最新章节标题） */
const PSEO_PAGE_SELECT = {
  id: true, title: true, author: true, description: true, cover: true, categoryId: true,
  category: { select: { name: true } }, status: true, isFeatured: true, isHot: true,
  wordCount: true, clicks: true, updatedAt: true,
  _count: { select: { chapters: true } },
  chapters: { orderBy: { idx: 'desc' as const }, take: 1, select: { title: true } },
} as const

type PseoPageRow = {
  id: number; title: string; author: string; description: string; cover: string; categoryId: number
  category: { name: string } | null; status: string; isFeatured: boolean; isHot: boolean
  wordCount: number; clicks: number; updatedAt: Date
  _count: { chapters: number }; chapters: { title: string }[]
}

function toPseoPageItem(r: PseoPageRow): NovelListItem {
  return {
    id: r.id, title: r.title, author: r.author, description: r.description, cover: r.cover,
    categoryId: r.categoryId, categoryName: r.category?.name ?? '未分类',
    status: r.status === 'finished' ? 'finished' : 'serial',
    isFeatured: r.isFeatured, isHot: r.isHot, wordCount: r.wordCount, clicks: r.clicks,
    chapterCount: r._count.chapters, lastChapterTitle: r.chapters[0]?.title ?? null,
    updatedAt: r.updatedAt.toISOString(),
  }
}

/**
 * 读取已生成（status='generated'）关键词的聚合页数据，供 /pseo/{keyword} 落地页与
 * generateMetadata 使用。未生成/不存在/pageData 损坏 → null（落地页据此 404，
 * 不实时兜底，避免任意关键词产生薄内容页）。
 * 书单按 pageData.novelIds 原序返回：绑定词页（采集自动取词）首位即绑定书。
 */
export async function getGeneratedPseoPage(keyword: string): Promise<PseoPageData | null> {
  const kw = sanitizeKeyword(keyword)
  if (!kw) return null
  const row = await db.pseoKeyword.findUnique({ where: { keyword: kw } }).catch(() => null)
  if (!row || row.status !== 'generated' || !row.pageData) return null
  try {
    const saved = JSON.parse(row.pageData) as {
      novelIds: number[]; title: string; description: string; keywords: string
    }
    if (!Array.isArray(saved.novelIds) || saved.novelIds.length === 0) return null
    const rows = await db.novel.findMany({
      where: { id: { in: saved.novelIds } },
      select: PSEO_PAGE_SELECT,
    })
    const byId = new Map(rows.map((r) => [r.id, r]))
    const novels: NovelListItem[] = []
    for (const id of saved.novelIds) {
      const r = byId.get(id)
      if (r) novels.push(toPseoPageItem(r))
    }
    return {
      keyword: kw,
      novels,
      generatedTitle: saved.title ?? '',
      generatedDescription: saved.description ?? '',
      generatedKeywords: saved.keywords ?? '',
    }
  } catch {
    return null
  }
}
