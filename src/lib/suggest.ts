/**
 * 多搜索引擎下拉词获取（服务端专用）
 * 每个引擎 4 秒超时、失败静默，返回结构化结果。
 * 说明：仅抓取搜索引擎公开的 suggest 接口，用于关键词研究，遵守低频调用原则。
 */

export interface SuggestResult {
  engine: string
  ok: boolean
  words: string[]
  error?: string
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

export async function fetchSuggestions(engine: string, keyword: string): Promise<SuggestResult> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 4000)
  try {
    let words: string[] = []

    if (engine === 'baidu') {
      const res = await fetch(`https://www.baidu.com/sugrec?prod=pc&wd=${encodeURIComponent(keyword)}`, {
        signal: ctrl.signal,
        headers: { 'User-Agent': UA },
      })
      if (res.ok) {
        const j = (await res.json()) as { g?: { k?: string }[] }
        words = (j.g ?? []).map((x) => x.k ?? '').filter(Boolean)
      }
    } else if (engine === 'bing') {
      const res = await fetch(`https://api.bing.com/osjson.aspx?query=${encodeURIComponent(keyword)}`, { signal: ctrl.signal })
      if (res.ok) {
        const j = (await res.json()) as [string, string[]]
        words = (j[1] ?? []).filter(Boolean)
      }
    } else if (engine === 'duckduckgo') {
      const res = await fetch(`https://duckduckgo.com/ac/?q=${encodeURIComponent(keyword)}&type=list`, {
        signal: ctrl.signal,
        headers: { 'User-Agent': UA },
      })
      if (res.ok) {
        const j = (await res.json()) as [string, string[]]
        words = (j[1] ?? []).filter(Boolean)
      }
    } else if (engine === 'sogou') {
      const res = await fetch(`https://www.sogou.com/sugproxy?p=1&ie=utf8&from=pc&wd=${encodeURIComponent(keyword)}`, {
        signal: ctrl.signal,
        headers: { 'User-Agent': UA },
      })
      if (res.ok) {
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
      }
    } else if (engine === 'so360') {
      const res = await fetch(`https://sug.so.360.cn/suggest?word=${encodeURIComponent(keyword)}&ie=utf-8`, {
        signal: ctrl.signal,
        headers: { 'User-Agent': UA },
      })
      if (res.ok) {
        const text = await res.text()
        try {
          const j = JSON.parse(text) as { data?: string[] }
          words = (j.data ?? []).filter(Boolean)
        } catch {
          const m = text.match(/\[([\s\S]*)\]/)
          if (m) {
            try {
              const arr = JSON.parse(m[1]) as unknown
              if (Array.isArray(arr)) words = arr.filter((x): x is string => typeof x === 'string')
            } catch { /* 忽略 */ }
          }
        }
      }
    }

    return { engine, ok: words.length > 0, words: words.slice(0, 20) }
  } catch (e) {
    return { engine, ok: false, words: [], error: e instanceof Error ? e.message : 'unknown' }
  } finally {
    clearTimeout(timer)
  }
}
