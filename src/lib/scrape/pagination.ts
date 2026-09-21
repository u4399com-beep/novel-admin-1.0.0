/**
 * 列表页翻页 URL 生成：
 * - 规则配置了 listRule.paginationTemplate 时严格按模板生成（{k}=页码、{url}=首页 URL encode），
 *   适配杰奇系 /list/1_{k}.html 等自动猜测永远落空的翻页形态
 * - 未配置时回退历史猜测：?page=k（已有 query 则 &page=k）与 /page/k 两种变体
 */
import type { RuleMap } from './types'

/** 规则是否配置了分页模板（运行时清洗后的 listRule 里为非空字符串） */
export function hasPaginationTemplate(listRule: RuleMap): boolean {
  return typeof listRule.paginationTemplate === 'string' && !!listRule.paginationTemplate.trim()
}

/** 生成第 k 页（k≥2）候选 URL 列表：模板优先，未配置时给猜测变体 */
export function buildPageVariants(listRule: RuleMap, baseUrl: string, k: number): string[] {
  const tpl = (listRule.paginationTemplate || '').trim()
  if (tpl) {
    const url = tpl.includes('{url}')
      ? tpl.replace('{url}', encodeURIComponent(baseUrl)).replace(/\{k\}/g, String(k))
      : tpl.replace(/\{k\}/g, String(k))
    return [url]
  }
  return guessPageVariants(baseUrl, k)
}

/** 历史猜测逻辑（自 worker.ts 迁入）：?page=k 与 /page/k 两种变体，去重 */
function guessPageVariants(url: string, k: number): string[] {
  const out: string[] = []
  try {
    const u = new URL(url)
    u.searchParams.set('page', String(k))
    out.push(u.toString())
    const p = new URL(url)
    p.pathname = `${p.pathname.replace(/\/+$/, '')}/page/${k}`
    p.search = ''
    if (p.toString() !== u.toString()) out.push(p.toString())
  } catch {
    out.push(url.includes('?') ? `${url}&page=${k}` : `${url}?page=${k}`)
    out.push(`${url.replace(/\/+$/, '')}/page/${k}`)
  }
  return [...new Set(out)]
}
