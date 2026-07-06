/**
 * Sanitize a string for safe storage and display
 */
export function sanitizeString(input: unknown, maxLength: number = 10000): string {
  if (typeof input !== 'string') return '';
  // Remove null bytes and control characters except newline/tab
  let sanitized = input.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  // Trim and limit length
  sanitized = sanitized.trim().slice(0, maxLength);
  return sanitized;
}

/**
 * Validate a URL is safe to fetch
 */
export function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Only allow http/https
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}