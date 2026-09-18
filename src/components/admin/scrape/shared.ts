/** 采集中心共享工具（自 ScrapeCenter.tsx 拆分，逻辑保持原样） */

// api 实现与后台面板共用同一版本（原 shared 内重复实现收敛至 ui-shared）
export { api } from '@/components/admin/ui-shared'

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
