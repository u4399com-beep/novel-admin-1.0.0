/**
 * 多搜索引擎下拉词获取（服务端专用）
 * 每个引擎独立超时 + 失败隔离（单引擎挂掉不影响其他引擎），
 * 聚合层 Promise.allSettled + 并发限制 3 + 跨引擎去重。
 * 说明：仅抓取搜索引擎公开的 suggest 接口，用于关键词研究，遵守低频调用原则。
 */

import { decodeHtmlEntities } from '@/lib/text-clean'

export interface SuggestResult {
  engine: string
  ok: boolean
  words: string[]
  error?: string
}

export interface SuggestionsAggregate {
  /** 每个引擎的独立结果（含失败信息） */
  results: SuggestResult[]
  /** 跨引擎去重后的关键词（按引擎优先序，已 trim/去空白/限长） */
  words: { word: string; engine: string }[]
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const MAX_WORD_LEN = 60
export const SUPPORTED_ENGINES = ['baidu', 'bing', 'duckduckgo', 'sogou', 'so360'] as const

/** 关键词清洗：去控制字符/尖括号/引号等危险字符，折叠空白，限长（供 pseo 相关接口共用） */
export function sanitizeKeyword(raw: unknown, maxLen = MAX_WORD_LEN): string {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/[\u0000-\u001f\u007f<>{}[\]$%|\\/"'`^*#&~;=]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen)
}

function normalizeWords(words: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const w of words) {
    const t = sanitizeKeyword(w)
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out.slice(0, 20)
}

export async function fetchSuggestions(engine: string, keyword: string, timeoutMs = 4000): Promise<SuggestResult> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    let words: string[] = []

    if (engine === 'baidu') {
      const res = await fetch(`https://www.baidu.com/sugrec?prod=pc&wd=${encodeURIComponent(keyword)}`, {
        signal: ctrl.signal,
        headers: { 'User-Agent': UA },
      })
      if (!res.ok) return { engine, ok: false, words: [], error: `HTTP ${res.status}` }
      // 百度 sugrec 响应字段已从 g[].k 变为 g[].q（2024 实测）；保留 k 兼容回退防再次变更
      const j = (await res.json()) as { g?: { q?: string; k?: string }[] }
      words = (j.g ?? []).map((x) => x.q ?? x.k ?? '').filter(Boolean)
    } else if (engine === 'bing') {
      // 旧接口 api.bing.com/osjson.aspx 已下线（200 但空体）；改用 cn.bing.com AS 页面接口：
      // 必须带 Referer 与浏览器 UA 才返回建议，响应为 HTML，从 <li class="sa_sg" query="词"> 提取
      const res = await fetch(
        `https://cn.bing.com/AS/Suggestions?mkt=zh-CN&qry=${encodeURIComponent(keyword)}&cp=1&cvid=abc123`,
        {
          signal: ctrl.signal,
          headers: { 'User-Agent': UA, Referer: 'https://cn.bing.com/' },
        },
      )
      if (!res.ok) return { engine, ok: false, words: [], error: `HTTP ${res.status}` }
      const html = await res.text()
      const lis = html.match(/<li\b[^>]*>/g) ?? []
      for (const li of lis) {
        if (!li.includes('sa_sg')) continue
        const m = li.match(/\bquery="([^"]*)"/)
        if (m?.[1]) words.push(decodeHtmlEntities(m[1])) // 属性值含 &amp; 等实体，先解码再清洗
      }
    } else if (engine === 'duckduckgo') {
      const res = await fetch(`https://duckduckgo.com/ac/?q=${encodeURIComponent(keyword)}&type=list`, {
        signal: ctrl.signal,
        headers: { 'User-Agent': UA },
      })
      if (!res.ok) return { engine, ok: false, words: [], error: `HTTP ${res.status}` }
      const j = (await res.json()) as [string, string[]]
      words = (j[1] ?? []).filter(Boolean)
    } else if (engine === 'sogou') {
      const res = await fetch(`https://www.sogou.com/sugproxy?p=1&ie=utf8&from=pc&wd=${encodeURIComponent(keyword)}`, {
        signal: ctrl.signal,
        headers: { 'User-Agent': UA },
      })
      if (!res.ok) return { engine, ok: false, words: [], error: `HTTP ${res.status}` }
      const text = await res.text()
      // 容错解析 JSON/JSONP 混合返回
      const arrMatch = text.match(/\[([\s\S]*)\]/)
      if (arrMatch) {
        try {
          const arr = JSON.parse(arrMatch[1]) as unknown
          if (Array.isArray(arr)) {
            words = arr.filter((x): x is string => typeof x === 'string')
          }
        } catch { /* 忽略解析失败 */ }
      }
    } else if (engine === 'so360') {
      const res = await fetch(`https://sug.so.360.cn/suggest?word=${encodeURIComponent(keyword)}&ie=utf-8`, {
        signal: ctrl.signal,
        headers: { 'User-Agent': UA },
      })
      if (!res.ok) return { engine, ok: false, words: [], error: `HTTP ${res.status}` }
      const text = await res.text()
      try {
        // 360 响应字段已从 data[] 变为 result[{word}]（实测）；保留 data 兼容回退
        const j = JSON.parse(text) as { result?: { word?: string }[]; data?: string[] }
        words = (j.result ?? []).map((x) => x.word ?? '').filter(Boolean)
        if (words.length === 0 && Array.isArray(j.data)) words = j.data.filter(Boolean)
      } catch {
        const m = text.match(/\[([\s\S]*)\]/)
        if (m) {
          try {
            const arr = JSON.parse(m[1]) as unknown
            if (Array.isArray(arr)) words = arr.filter((x): x is string => typeof x === 'string')
          } catch { /* 忽略 */ }
        }
      }
    } else {
      return { engine, ok: false, words: [], error: `不支持的引擎: ${engine}` }
    }

    const clean = normalizeWords(words)
    return { engine, ok: clean.length > 0, words: clean }
  } catch (e) {
    return { engine, ok: false, words: [], error: e instanceof Error ? e.message : 'unknown' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 限制并发数的执行器：把任务按 concurrency 个一批依次跑（批内并行）。
 */
async function runWithConcurrency<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    for (;;) {
      const idx = cursor++
      if (idx >= tasks.length) return
      results[idx] = await tasks[idx]()
    }
  })
  await Promise.allSettled(workers)
  return results
}

/**
 * 多引擎聚合入口：Promise.allSettled + 限并发 3 + 跨引擎去重。
 * 单引擎超时/解析失败只影响自身 result，绝不抛出。
 */
export async function fetchSuggestionsMulti(
  keyword: string,
  engines: readonly string[] = SUPPORTED_ENGINES,
  opts: { timeoutMs?: number; concurrency?: number } = {},
): Promise<SuggestionsAggregate> {
  const validEngines = engines.filter((e) => (SUPPORTED_ENGINES as readonly string[]).includes(e))
  const tasks = validEngines.map((e) => () => fetchSuggestions(e, keyword, opts.timeoutMs ?? 4000))
  const settled = await runWithConcurrency(tasks, opts.concurrency ?? 3)

  const results = settled.map((r, i) => r ?? { engine: validEngines[i], ok: false, words: [], error: '未返回结果' })
  const seen = new Set<string>()
  const words: { word: string; engine: string }[] = []
  for (const r of results) {
    for (const w of r.words) {
      if (seen.has(w)) continue
      seen.add(w)
      words.push({ word: w, engine: r.engine })
    }
  }
  return { results, words }
}
