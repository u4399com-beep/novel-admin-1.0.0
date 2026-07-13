/**
 * Safely format a date string, returning a fallback for invalid dates.
 */
export function safeFormatDate(dateStr: string | null | undefined, formatFn?: (date: Date) => string): string {
  if (!dateStr) return '—';
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '—';
  return formatFn ? formatFn(date) : date.toLocaleDateString('zh-CN');
}