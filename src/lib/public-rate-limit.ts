// ─── Shared IP-based rate limiter for public endpoints ──────────────
// Uses x-real-ip (set by reverse proxy) with fallback to rightmost
// x-forwarded-for to prevent client IP spoofing.

const store = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 60;
const MAX_ENTRIES = 10000;

// Cleanup expired entries periodically
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    for (const [key, val] of store) {
      if (now > val.resetAt) store.delete(key);
    }
  }, 60_000);
}

/**
 * Extract the real client IP from a request.
 * Prioritizes x-real-ip, then the rightmost entry in x-forwarded-for.
 */
export function getClientIp(request: Request): string {
  return (
    request.headers.get('x-real-ip') ||
    request.headers.get('x-forwarded-for')?.split(',').pop()?.trim() ||
    'unknown'
  );
}

/**
 * Check whether the given IP has exceeded the rate limit.
 * Returns `true` when the request should be **rejected** (over limit).
 *
 * @param ip       Client IP string
 * @param maxRequests Optional per-window ceiling (default 60)
 */
export function publicRateLimit(ip: string, maxRequests = MAX_REQUESTS): boolean {
  const now = Date.now();

  // Evict expired entries when approaching capacity
  if (store.size > MAX_ENTRIES * 0.8) {
    for (const [key, val] of store) {
      if (now > val.resetAt) store.delete(key);
    }
  }

  // Hard cap: reject new entries when at max capacity
  if (!store.has(ip) && store.size >= MAX_ENTRIES) {
    return true; // over limit
  }

  let entry = store.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
    store.set(ip, entry);
  }
  entry.count++;
  return entry.count > maxRequests;
}
