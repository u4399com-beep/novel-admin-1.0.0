/**
 * 采集相关 API 路由共用的小工具（URL 校验 / 正整数解析）。
 * 仅供服务端使用，勿在客户端 import。
 */

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string }

/** 校验 http/https URL 并规范化为绝对地址（限长截断） */
export function parseHttpUrl(raw: unknown, field: string, maxLen: number): Parsed<string> {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, message: `${field} 必填` }
  try {
    const u = new URL(raw.trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, message: `${field} 仅支持 http/https（收到 ${u.protocol}）` }
    }
    return { ok: true, value: u.toString().slice(0, maxLen) }
  } catch {
    return { ok: false, message: `${field} 无法解析: ${String(raw).slice(0, 100)}` }
  }
}

/**
 * 正整数解析；非整数/非正数返回 null。
 * （Prisma/SQLite 对 12.5 之类会静默截断取整，语义上应显式拒绝）
 */
export function parsePositiveInt(raw: unknown): number | null {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}
