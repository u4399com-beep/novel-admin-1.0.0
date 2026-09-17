/** 采集中心共享工具（自 ScrapeCenter.tsx 拆分，逻辑保持原样） */

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init })
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new Error(data.error ?? `请求失败(${res.status})`)
  return data as T
}

/** 仅保留非空字符串字段 */
export function cleanRule(obj: object): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && v.trim()) out[k] = v.trim()
  }
  return out
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}
