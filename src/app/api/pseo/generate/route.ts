import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { DEFAULT_SEO, renderTpl } from '@/lib/seo'
import type { SeoConfig } from '@/lib/types'
import { fetchSuggestionsMulti, sanitizeKeyword, SUPPORTED_ENGINES } from '@/lib/suggest'

export const dynamic = 'force-dynamic'

/** 关键词 → 命中书籍聚合（标题/作者/分类/简介包含关键词） */
async function matchNovels(keyword: string) {
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

// POST /api/pseo/generate
// body: { keyword?: string, useSuggest?: boolean, sources?: string[], limit?: number }
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    keyword?: unknown
    useSuggest?: boolean
    sources?: unknown
    limit?: number
  }

  // ---- 输入校验：keyword 字符白名单 + 长度限制 ----
  const keyword = sanitizeKeyword(body.keyword)
  const useSuggest = body.useSuggest !== false
  if (useSuggest && !keyword) {
    return NextResponse.json(
      { error: 'keyword 必填', detail: '关键词须为 1-60 个可见字符，不允许控制字符与 <>{}[]$%|\\/"\'`^*#&~;= 等' },
      { status: 400 },
    )
  }

  // ---- sources 白名单校验 ----
  const rawSources = Array.isArray(body.sources) ? body.sources.filter((s): s is string => typeof s === 'string') : []
  const invalidSources = rawSources.filter((s) => !(SUPPORTED_ENGINES as readonly string[]).includes(s))
  if (invalidSources.length > 0) {
    return NextResponse.json(
      { error: 'sources 含不支持的引擎', detail: `不支持的引擎: ${invalidSources.join(', ')}；可用: ${SUPPORTED_ENGINES.join(', ')}` },
      { status: 400 },
    )
  }
  const sources = rawSources.length ? rawSources : [...SUPPORTED_ENGINES]

  // 1) 获取搜索引擎下拉词（allSettled + 限并发 3 + 跨引擎去重，单引擎失败不影响其他）
  const aggregate = useSuggest
    ? await fetchSuggestionsMulti(keyword, sources)
    : { results: [], words: [] }

  // 2) 关键词入库（有序去重：基础词最优先，来源标记为首个命中引擎）
  const keywordEntries: { word: string; engine: string }[] = []
  if (keyword) keywordEntries.push({ word: keyword, engine: 'manual' })
  keywordEntries.push(...aggregate.words)

  const allWords = keywordEntries.slice(0, 200).map((e) => e.word).filter(Boolean)
  const engineOf = new Map(keywordEntries.map((e) => [e.word, e.engine]))

  let added = 0
  if (allWords.length > 0) {
    const existing = await db.pseoKeyword.findMany({
      where: { keyword: { in: allWords } },
      select: { keyword: true },
    })
    const existingSet = new Set(existing.map((r) => r.keyword))
    for (const kw of allWords) {
      if (existingSet.has(kw)) continue
      await db.pseoKeyword.create({ data: { keyword: kw, source: engineOf.get(kw) ?? 'manual' } })
      added++
    }
  }

  // 3) 为 pending 关键词生成聚合页数据（自动 TDK）
  const limit = Math.min(50, Math.max(1, Number(body.limit) || 20))
  const pending = await db.pseoKeyword.findMany({ where: { status: 'pending' }, take: limit })

  const setting = await db.siteSetting.findUnique({ where: { id: 1 } })
  let seo: SeoConfig = { ...DEFAULT_SEO }
  try {
    seo = { ...seo, ...JSON.parse(setting?.seoConfig || '{}') }
  } catch { /* 默认 */ }
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
      await db.pseoKeyword.update({ where: { id: row.id }, data: { status: 'failed' } })
    }
  }

  return NextResponse.json({
    added,
    generated,
    suggestions: aggregate.results.map((r) => ({ engine: r.engine, ok: r.ok, count: r.words.length, error: r.error })),
  })
}
