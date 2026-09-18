import { NextRequest, NextResponse } from 'next/server'
import { fetchSuggestionsMulti, sanitizeKeyword, SUPPORTED_ENGINES } from '@/lib/suggest'

export const dynamic = 'force-dynamic'

// POST /api/pseo/suggest — 试取预览：只调用 multi-search-engine 获取下拉词，不入库不生成聚合页
// body: { keyword: string, sources?: string[] }
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { keyword?: unknown; sources?: unknown }
  const keyword = sanitizeKeyword(body.keyword)
  if (!keyword) {
    return NextResponse.json({ error: 'keyword 必填', detail: '关键词须为 1-60 个可见字符' }, { status: 400 })
  }
  const rawSources = Array.isArray(body.sources) ? body.sources.filter((s): s is string => typeof s === 'string') : []
  const invalid = rawSources.filter((s) => !(SUPPORTED_ENGINES as readonly string[]).includes(s))
  if (invalid.length > 0) {
    return NextResponse.json(
      { error: 'sources 含不支持的引擎', detail: `不支持的引擎: ${invalid.join(', ')}；可用: ${SUPPORTED_ENGINES.join(', ')}` },
      { status: 400 },
    )
  }
  const agg = await fetchSuggestionsMulti(keyword, rawSources.length ? rawSources : [...SUPPORTED_ENGINES])
  return NextResponse.json({
    results: agg.results.map((r) => ({ engine: r.engine, ok: r.ok, count: r.words.length, error: r.error })),
    words: agg.words.slice(0, 40),
  })
}
