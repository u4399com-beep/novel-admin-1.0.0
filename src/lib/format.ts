/** 字数/时间等展示格式化工具 */

/** 一位小数并去掉无意义的 .0（250.0 → 250，123.4 保留） */
function trim1(n: number): string {
  return n.toFixed(1).replace(/\.0$/, '')
}

/**
 * 字数展示格式化：
 * - 防御非法输入（NaN/负数/Infinity → "0"），非整数向下取整；
 * - ≥1亿 → x.x亿、≥1万 → x.x万（去尾 .0）、其余千分位（3,200）。
 */
export function formatWordCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  const v = Math.floor(n)
  if (v >= 10000_0000) return trim1(v / 10000_0000) + '亿'
  if (v >= 10000) return trim1(v / 10000) + '万'
  return v.toLocaleString('en-US')
}

export function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 相对时间：x分钟前 / x小时前 / x天前 */
export function timeAgo(iso: string): string {
  const d = new Date(iso).getTime()
  if (Number.isNaN(d)) return ''
  const diff = Date.now() - d
  const m = Math.floor(diff / 60_000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m}分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}小时前`
  const days = Math.floor(h / 24)
  if (days < 30) return `${days}天前`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}个月前`
  return `${Math.floor(months / 12)}年前`
}
