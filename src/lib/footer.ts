/**
 * 页面底部（页脚）配置的清洗与默认值（settings API 与后台 UI 共用）。
 *
 * 语义：text/extra 留空 = 沿用主题默认文案；links 追加在主题页脚导航后。
 * href 仅接受 http(s) 绝对地址或站内相对路径（/、# 开头），防 javascript: 伪协议注入。
 */
import type { FooterConfig, FooterLink } from '@/lib/types'

export const FOOTER_LIMITS = {
  textMax: 300,
  extraMax: 300,
  linkCount: 10,
  linkLabelMax: 20,
  linkHrefMax: 300,
} as const

/** href 白名单：http(s) 绝对地址或站内相对路径（/、#、? 开头） */
function sanitizeHref(raw: string): string {
  const h = raw.trim()
  if (!h) return ''
  if (/^https?:\/\//i.test(h)) return h.slice(0, FOOTER_LIMITS.linkHrefMax)
  if (/^[/#?]/.test(h) && !/^javascript:/i.test(h)) return h.slice(0, FOOTER_LIMITS.linkHrefMax)
  return ''
}

/** 清洗任意输入为安全的 FooterConfig（非法字段一律丢弃，绝不抛错） */
export function sanitizeFooterConfig(raw: unknown): FooterConfig {
  const out: FooterConfig = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  const r = raw as Record<string, unknown>

  if (typeof r.text === 'string') out.text = r.text.trim().slice(0, FOOTER_LIMITS.textMax)
  if (typeof r.extra === 'string') out.extra = r.extra.trim().slice(0, FOOTER_LIMITS.extraMax)

  if (Array.isArray(r.links)) {
    const links: FooterLink[] = []
    const seen = new Set<string>()
    for (const item of r.links) {
      if (links.length >= FOOTER_LIMITS.linkCount) break
      if (!item || typeof item !== 'object') continue
      const label = typeof (item as Record<string, unknown>).label === 'string'
        ? ((item as Record<string, unknown>).label as string).trim().slice(0, FOOTER_LIMITS.linkLabelMax)
        : ''
      const href = typeof (item as Record<string, unknown>).href === 'string'
        ? sanitizeHref((item as Record<string, unknown>).href as string)
        : ''
      if (!label || !href) continue
      const key = `${label}|${href}`
      if (seen.has(key)) continue
      seen.add(key)
      links.push({ label, href })
    }
    if (links.length) out.links = links
  }

  return out
}

/** 解析 DB 中的 footerConfig JSON（损坏时回退空配置） */
export function parseFooterConfig(json: string | null | undefined): FooterConfig {
  if (!json) return {}
  try {
    return sanitizeFooterConfig(JSON.parse(json))
  } catch {
    return {}
  }
}
