/**
 * HTTP/2 Pseudo-Header & Connection Fingerprint Diversifier
 *
 * While we can't control the actual HTTP/2 SETTINGS frame at the application layer
 * (that's handled by Bun's TLS library), we CAN diversify other connection-level
 * signals that anti-bot systems use for fingerprinting:
 *
 *   1. Connection header variation (keep-alive timing, max requests)
 *   2. Priority/dependency hints in HTTP/2
 *   3. Accept-Encoding preference order variation
 *   4. Connection pool reuse patterns
 *
 * This module provides per-domain consistent connection behavior to avoid
 * detection via connection-level fingerprinting.
 */

// ==================== Types ====================

export interface ConnectionProfile {
  /** Accept-Encoding preference order */
  acceptEncoding: string;
  /** Connection header value */
  connectionHeader: string;
  /** Max concurrent streams hint (for logging, not actual control) */
  maxConcurrentStreams: number;
  /** Initial window size hint */
  initialWindowSize: number;
  /** Priority urgency (0 = highest) */
  priorityUrgency: number;
}

// ==================== Accept-Encoding Pools ====================

const ENCODING_POOLS = [
  'gzip, deflate, br',
  'br, gzip, deflate',
  'gzip, br, deflate',
  'deflate, gzip, br',
  'br, deflate, gzip',
];

// ==================== Domain Cache ====================

const domainConnProfileCache = new Map<string, ConnectionProfile>();
const MAX_CACHE_SIZE = 200;
const CACHE_TTL_MS = 20 * 60 * 1000; // 20 minutes

interface CacheEntry {
  profile: ConnectionProfile;
  createdAt: number;
}

// ==================== Domain Hash ====================

function domainHash(domain: string): number {
  let h = 0;
  for (let i = 0; i < domain.length; i++) {
    h = ((h << 5) - h + domain.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// ==================== Main API ====================

/**
 * Get a per-domain consistent connection profile.
 * Same domain always gets the same profile (until cache eviction).
 *
 * @param domain - Target domain
 * @returns Connection profile with diversified settings
 */
export function getConnectionProfile(domain: string): ConnectionProfile {
  const now = Date.now();
  const cached = domainConnProfileCache.get(domain);

  if (cached && (now - cached.createdAt) < CACHE_TTL_MS) {
    return cached.profile;
  }

  // Evict oldest if cache is full
  if (domainConnProfileCache.size >= MAX_CACHE_SIZE) {
    let oldestKey = '';
    let oldestTime = Infinity;
    for (const [key, entry] of domainConnProfileCache) {
      if (entry.createdAt < oldestTime) {
        oldestTime = entry.createdAt;
        oldestKey = key;
      }
    }
    if (oldestKey) domainConnProfileCache.delete(oldestKey);
  }

  const h = domainHash(domain);
  const profile: ConnectionProfile = {
    acceptEncoding: ENCODING_POOLS[h % ENCODING_POOLS.length],
    connectionHeader: h % 3 === 0 ? 'keep-alive' : '',
    maxConcurrentStreams: 100 + (h % 900), // 100-999
    initialWindowSize: 65535 + (h % 262144), // 64KB-327KB in 1KB steps
    priorityUrgency: h % 256, // 0-255
  };

  domainConnProfileCache.set(domain, { profile, createdAt: now });
  return profile;
}

/**
 * Get the Accept-Encoding header value for a domain.
 * Diversified per-domain to avoid fingerprinting via encoding preference.
 */
export function getAcceptEncoding(domain: string): string {
  return getConnectionProfile(domain).acceptEncoding;
}

/**
 * Get cache statistics.
 */
export function getConnectionProfileCacheSize(): number {
  return domainConnProfileCache.size;
}

/** Clear the connection profile cache. */
export function clearConnectionProfileCache(): void {
  domainConnProfileCache.clear();
}
