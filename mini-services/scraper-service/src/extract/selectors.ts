/**
 * cheerio 选择器工具层：备选拆分 / @attr 解析 / 文本与链接提取。
 *
 * 约定（自 extract.ts 巨石拆分而来，代码逐行原样迁移）：
 * - 所有选择器字符串支持逗号分隔的"备选"，从左到右取第一个非空结果；
 *   （CSS 原生逗号是并集语义，这里按备选语义逐个尝试，且能容忍单个选择器非法）
 * - 选择器支持 `sel@attr` 后缀取属性（如 `meta[property="og:image"]@content`），纯加法扩展，
 *   不影响主站传来的普通 CSS 选择器；
 * - 匹配语义：优先在 scope 内查找（find），scope 自身命中选择器时同样采纳（is）；
 * - 链接一律 new URL(href, base) 补全为绝对地址。
 */
import type { Cheerio } from 'cheerio'

export type Scope = Cheerio<any>

/** 逗号拆分备选选择器（跳过括号/属性选择器内部的逗号） */
export function splitAlternatives(sel: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of sel) {
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/** 解析 `sel@attr` 语法 */
export function parseSel(raw: string): { selector: string; attr: string | null } {
  const m = /@([a-zA-Z][\w:-]*)$/.exec(raw)
  if (m && m.index !== undefined) {
    return { selector: raw.slice(0, m.index).trim(), attr: m[1] }
  }
  return { selector: raw.trim(), attr: null }
}

/** 单行文本规范化 */
export function collapse(s: string): string {
  return s.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
}

/** 在 scope 内按备选顺序取第一个非空文本/属性（find 优先，scope 自身命中亦采纳） */
export function pickText(scope: Scope, rawSelectors: string[]): string {
  for (const raw of rawSelectors) {
    const { selector, attr } = parseSel(raw)
    if (!selector) continue
    let val = ''
    try {
      const el = scope.find(selector).first()
      if (el.length) {
        val = attr ? (el.attr(attr) ?? '') : el.text()
      } else if (scope.length && scope.is(selector)) {
        // scope 自身命中选择器（如 scope 是 <a> 而 selector 为 a@title）
        val = attr ? (scope.attr(attr) ?? '') : scope.text()
      }
    } catch {
      continue // 非法选择器直接跳过
    }
    const t = collapse(val)
    if (t) return t
  }
  return ''
}

export function firstMatch(scope: Scope, rawSelectors: string[]): Scope | null {
  for (const raw of rawSelectors) {
    const { selector } = parseSel(raw)
    if (!selector) continue
    try {
      const el = scope.find(selector).first()
      if (el.length) return el
      if (scope.length && scope.is(selector)) return scope
    } catch {
      continue
    }
  }
  return null
}

export function toAbs(href: string | undefined | null, base: string): string | null {
  if (!href) return null
  const h = href.trim()
  if (!h || /^javascript:/i.test(h) || h.startsWith('#')) return null // 空链接/JS 伪协议/纯锚点（同页跳转）均非可采内容链接
  try {
    const u = new URL(h, base)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.toString()
  } catch {
    return null
  }
}

/** 按备选顺序取第一个可解析为绝对 URL 的链接（支持 @attr，默认取 href） */
export function pickHref(scope: Scope, rawSelectors: string[], base: string): string | null {
  for (const raw of rawSelectors) {
    const { selector, attr } = parseSel(raw)
    if (!selector) continue
    try {
      const el = scope.find(selector).first()
      let node: Scope | null = el.length ? el : null
      if (!node && scope.length && scope.is(selector)) node = scope
      if (!node) continue
      const href = attr ? (node.attr(attr) ?? '') : (node.attr('href') ?? '')
      const abs = toAbs(href, base)
      if (abs) return abs
    } catch {
      continue
    }
  }
  return null
}
