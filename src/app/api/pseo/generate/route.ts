import { NextRequest, NextResponse } from 'next/server'
import { fetchSuggestionsMulti, sanitizeKeyword, SUPPORTED_ENGINES } from '@/lib/suggest'
import { generatePendingPages, insertKeywords } from '@/lib/pseo'

export const dynamic = 'force-dynamic'

// POST /api/pseo/generate — 单种子快捷获取（multi-search-engine 下拉词 → 入库 → 生成聚合页）
// body: { keyword?: string, useSuggest?: boolean, sources?: string[], limit?: number }
// useSuggest=false 时仅重新生成 pending 关键词的聚合页（TDK 模板变更后的重跑入口）
// 批量/持久化配置场景请用 /api/pseo/batch
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
  const aggregate = useSuggest ? await fetchSuggestionsMulti(keyword, sources) : { results: [], words: [] }

  // 2) 关键词入库（基础词最优先，来源标记为首个命中引擎；去重与 P2002 容错在 lib 内）
  const keywordEntries = keyword ? [{ word: keyword, engine: 'manual' }, ...aggregate.words] : aggregate.words
  const added = await insertKeywords(keywordEntries, 200)

  // 3) 为 pending 关键词生成聚合页数据（自动 TDK）
  const generated = await generatePendingPages(Math.min(50, Math.max(1, Number(body.limit) || 20)))

  return NextResponse.json({
    added,
    generated,
    suggestions: aggregate.results.map((r) => ({ engine: r.engine, ok: r.ok, count: r.words.length, error: r.error })),
  })
}
