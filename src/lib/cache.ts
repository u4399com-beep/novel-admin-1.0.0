type CacheEntry<T> = {
  data: T;
  expiresAt: number;
};

const cache = new Map<string, CacheEntry<unknown>>();

const DEFAULT_TTL = 30 * 1000; // 30 seconds
const MAX_ENTRIES = 500;
const CLEANUP_INTERVAL = 60 * 1000; // 1 minute

// Cleanup stale entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now > entry.expiresAt) {
      cache.delete(key);
    }
  }
  // If still over max, remove oldest entries
  if (cache.size > MAX_ENTRIES) {
    const entries = Array.from(cache.entries()).sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    const toRemove = entries.slice(0, cache.size - MAX_ENTRIES);
    for (const [key] of toRemove) {
      cache.delete(key);
    }
  }
}, CLEANUP_INTERVAL);

export function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

export function setCache<T>(key: string, data: T, ttl: number = DEFAULT_TTL): void {
  // Don't cache if at capacity and this key is new
  if (!cache.has(key) && cache.size >= MAX_ENTRIES) {
    return;
  }
  cache.set(key, { data, expiresAt: Date.now() + ttl });
}

export function invalidateCache(key?: string): void {
  if (key) {
    cache.delete(key);
  } else {
    cache.clear();
  }
}