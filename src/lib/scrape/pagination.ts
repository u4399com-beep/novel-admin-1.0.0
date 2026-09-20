/**
 * 列表页翻页 URL 生成（服务端专用）。
 *
 * 支持规则级分页模板（listRule.pagination），解决各站翻页形态差异：
 *   - "{url} 静态页形态"：如 ggd66 `/sort/1/{k}/`（路径段页码）、x2552 `/list/1_{k}.html`
 *   - 查询串形态：如 xinjianpan `/rank/lastupdate/?page={k}`
 * 占位符：`{k}` = 页码；`{url}` = 任务目标 URL（encodeURIComponent 后替换）。
 * 模板为相对路径时基于目标 URL 解析。
 *
 * 未配置模板时回退两个通用猜测：`?page=k`（已有 query 则 `&page=k`）与 `/page/k`。
 */
import type { RuleMap } from './types'

export function buildPageVariants(listRule: RuleMap, baseUrl: string, k: number): string[] {
  const template = typeof listRule.pagination === 'string' ? listRule.pagination.trim() : ''
  if (template) {
    const raw = template.replaceAll('{k}', String(k)).replaceAll('{url}', encodeURIComponent(baseUrl))
    try {
      const u = new URL(raw, baseUrl)
      return [u.toString()]
    } catch {
      return [] // 模板非法（如站点域名变更），不猜
    }
  }
  return legacyPageVariants(baseUrl, k)
}

/** 通用翻页猜测（未配置模板时的回退，与历史行为一致） */
function legacyPageVariants(url: string, k: number): string[] {
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
