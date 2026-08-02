/**
 * Safely format a date string, returning a fallback for invalid dates.
 */
export function safeFormatDate(dateStr: string | null | undefined, formatFn?: (date: Date) => string): string {
  if (!dateStr) return '—';
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '—';
  return formatFn ? formatFn(date) : date.toLocaleDateString('zh-CN');
}

/**
 * Format a word count into a human-readable Chinese string.
 * 12345 → 1.2万字, 999 → 999字
 */
export function formatWordCount(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万字`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}千字`;
  return `${n}字`;
}

/**
 * Format a relative time string in Chinese.
 * Returns e.g. "3分钟前", "2小时前", "5天前", "2024-01-01"
 */
export function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '—';
  const now = Date.now();
  const diff = now - date.getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}个月前`;
  return date.toLocaleDateString('zh-CN');
}

/**
 * Format a number with compact notation.
 * 1500 → 1.5K, 1500000 → 1.5M
 */
export function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}