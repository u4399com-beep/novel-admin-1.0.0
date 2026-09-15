import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { DEFAULT_SEO, renderTpl } from '@/lib/seo'
import type { SeoConfig } from '@/lib/types'
import { fetchSuggestions, type SuggestResult } from '@/lib/suggest'

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
    keyword?: string
    useSuggest?: boolean
    sources?: string[]
    limit?: number
  }

  const sources = body.sources?.length ? body.sources : ['baidu', 'bing', 'duckduckgo', 'sogou', 'so360']

  // 1) 获取搜索引擎下拉词
  const collected: SuggestResult[] = []
  if (body.useSuggest !== false) {
    const base = body.keyword?.trim()
    if (!base) return NextResponse.json({ error: 'keyword 必填' }, { status: 400 })
    const results = await Promise.all(sources.map((s) => fetchSuggestions(s, base)))
    collected.push(...results)
  }

  // 2) 关键词入库（去重）
  const allWords = new Set<string>()
  if (body.keyword?.trim()) allWords.add(body.keyword.trim().slice(0, 60))
  for (const r of collected) for (const w of r.words) allWords.add(w.trim().slice(0, 60))
  allWords.delete('')

  let added = 0
  for (const kw of allWords) {
    const exists = await db.pseoKeyword.findUnique({ where: { keyword: kw } })
    if (exists) continue
    const src = collected.find((r) => r.words.includes(kw))?.engine ?? 'manual'
    await db.pseoKeyword.create({ data: { keyword: kw, source: src } })
    added++
  }

  // 3) 为 pending 关键词生成聚合页数据（自动 TDK）
  const limit = Math.min(50, Math.max(1, body.limit ?? 20))
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
    suggestions: collected.map((r) => ({ engine: r.engine, ok: r.ok, count: r.words.length, error: r.error })),
  })
}
