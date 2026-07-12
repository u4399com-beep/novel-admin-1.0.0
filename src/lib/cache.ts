type CacheEntry<T> = {
  data: T;
  expiresAt: number;
};

const cache = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, { promise: Promise<unknown>; expiresAt: number; gen: number }>();

const DEFAULT_TTL = 30 * 1000; // 30 seconds
const MAX_ENTRIES = 500;
const MAX_VALUE_SIZE = 512000; // 500KB
const CLEANUP_INTERVAL = 60 * 1000; // 1 minute
const INFLIGHT_TIMEOUT = 60 * 1000; // 1 minute max wait for inflight promises

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function startCleanupTimer(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
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
}

// Start the cleanup timer when this module is loaded
startCleanupTimer();

/**
 * Single-flight cache: deduplicates concurrent compute calls for the same key.
 */
export async function getOrCompute<T>(
  key: string,
  ttl: number = DEFAULT_TTL,
  computeFn: () => Promise<T>
): Promise<T> {
  const cached = getCached<T>(key);
  if (cached) return cached;

  const inflightEntry = inflight.get(key);
  if (inflightEntry && Date.now() < inflightEntry.expiresAt) {
    // Race with timeout: if the inflight promise hangs, reject after remaining time
    const remaining = inflightEntry.expiresAt - Date.now();
    let timeoutId: ReturnType<typeof setTimeout>;
    return Promise.race([
      inflightEntry.promise as Promise<T>,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Cache inflight timeout')), remaining);
      }),
    ]).finally(() => clearTimeout(timeoutId));
  }
  // Stale inflight entry, remove it
  if (inflightEntry) inflight.delete(key);

  const gen = Date.now();
  const promise = computeFn().then(data => {
    if (inflight.get(key)?.gen === gen) inflight.delete(key);
    setCache(key, data, ttl);
    return data;
  }).catch(e => {
    if (inflight.get(key)?.gen === gen) inflight.delete(key);
    throw e;
  });

  inflight.set(key, { promise, expiresAt: Date.now() + INFLIGHT_TIMEOUT, gen });
  return promise;
}

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCache<T>(key: string, data: T, ttl: number = DEFAULT_TTL): void {
  // Don't cache values that exceed the size limit
  const sizeEstimate = JSON.stringify(data).length;
  if (sizeEstimate > MAX_VALUE_SIZE) {
    return;
  }
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