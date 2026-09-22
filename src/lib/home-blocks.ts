/**
 * 首页自定义图文区块配置的清洗/白名单（与 footer.ts/seo.ts 同构）。
 *
 * 存储契约：SiteSetting.homeConfig = JSON.stringify(HomeConfig)。
 * - 后台 PATCH 传入任意 JSON → sanitizeHomeConfig 白名单过滤后落库；
 * - 前台 GET 读回时同样过白名单（历史行可能存入非法结构，渲染链不抛错）。
 */
import type { HomeBlockConfig, HomeConfig } from '@/lib/types'

/** 数据来源白名单：latest / hot / featured / cat:<正整数> */
export function isHomeBlockSource(v: unknown): v is string {
  return (
    v === 'latest' ||
    v === 'hot' ||
    v === 'featured' ||
    (typeof v === 'string' && /^cat:\d{1,6}$/.test(v))
  )
}

function sanitizeBlock(raw: unknown): HomeBlockConfig | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const title = typeof r.title === 'string' ? r.title.trim().slice(0, 30) : ''
  if (!title || !isHomeBlockSource(r.source)) return null
  const countRaw = Number(r.count)
  const count = Number.isFinite(countRaw) ? Math.min(24, Math.max(4, Math.floor(countRaw))) : 8
  const id = typeof r.id === 'string' && r.id.length <= 40 ? r.id : `blk${Math.random().toString(36).slice(2, 8)}`
  return { id, title, source: r.source, count }
}

export function sanitizeHomeConfig(raw: unknown): HomeConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { blocks: [] }
  const blocksRaw = (raw as Record<string, unknown>).blocks
  if (!Array.isArray(blocksRaw)) return { blocks: [] }
  // 上限 8 个区块，防止配置爆炸
  return { blocks: blocksRaw.slice(0, 8).map(sanitizeBlock).filter((b): b is HomeBlockConfig => b !== null) }
}
