/**
 * IP Fingerprint Diversification
 *
 * Varies HTTP connection characteristics per-domain to make each request
 * look like it comes from a different (or at least inconsistent) client.
 * This defeats fingerprinting systems that rely on static header combinations.
 *
 * Features:
 *   - TCP fingerprint hints: Connection/Keep-Alive header variation
 *   - Accept-Encoding variation: random subsets of gzip/deflate/br
 *   - Accept header variation: 5+ realistic browser Accept patterns
 *   - Per-domain consistency: same domain gets same overrides within a session
 *   - LRU cache with TTL for per-domain header profiles
 */

// ==================== Types ====================

interface DomainHeaderProfile {
  connection: 'keep-alive' | 'close';
  keepAlive: string | null;
  acceptEncoding: string;
  accept: string;
  createdAt: number;
}

// ==================== Constants ====================

const ACCEPT_PATTERNS: string[] = [
  // Chrome/Edge with full image format support
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  // Chrome without avif (older versions)
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  // Firefox-style (no webp preference)
  'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  // Safari-style
  'text/html,application/xhtml+xml,image/webp,*/*;q=0.8',
  // Minimalist (older browsers / bots that try to look simple)
  'text/html,*/*;q=0.9',
];

const ACCEPT_ENCODING_PATTERNS: string[] = [
  'gzip, deflate, br',
  'gzip, deflate',
  'gzip, br',
  'deflate, br',
  'gzip',
];

const KEEP_ALIVE_TIMEOUTS = ['5', '10', '15', '30', '60'];

const CACHE_MAX_SIZE = 200;
const CACHE_TTL_MS = 20 * 60 * 1000; // 20 minutes

// ==================== Domain Header Cache ====================

const domainHeaderCache = new Map<string, DomainHeaderProfile>();

function getOrCreateProfile(domain: string): DomainHeaderProfile {
  const now = Date.now();
  const cached = domainHeaderCache.get(domain);

  if (cached && (now - cached.createdAt) < CACHE_TTL_MS) {
    return cached;
  }

  // Evict oldest if cache is full
  if (domainHeaderCache.size >= CACHE_MAX_SIZE) {
    let oldestKey = '';
    let oldestTime = Infinity;
    for (const [key, entry] of domainHeaderCache) {
      if (entry.createdAt < oldestTime) {
        oldestTime = entry.createdAt;
        oldestKey = key;
      }
    }
    if (oldestKey) domainHeaderCache.delete(oldestKey);
  }

  const connection: 'keep-alive' | 'close' = Math.random() < 0.85 ? 'keep-alive' : 'close';
  const keepAlive = connection === 'keep-alive'
    ? `timeout=${KEEP_ALIVE_TIMEOUTS[Math.floor(Math.random() * KEEP_ALIVE_TIMEOUTS.length)]}`
    : null;

  const profile: DomainHeaderProfile = {
    connection,
    keepAlive,
    acceptEncoding: ACCEPT_ENCODING_PATTERNS[Math.floor(Math.random() * ACCEPT_ENCODING_PATTERNS.length)],
    accept: ACCEPT_PATTERNS[Math.floor(Math.random() * ACCEPT_PATTERNS.length)],
    createdAt: now,
  };

  domainHeaderCache.set(domain, profile);
  return profile;
}

// ==================== Public API ====================

/**
 * Get diversified header overrides for a URL.
 * Returns header key-value pairs that should be merged into the request headers.
 *
 * The same domain always gets the same profile until TTL expires,
 * ensuring consistency within a scraping session while varying across domains.
 *
 * @param url - The target URL.
 * @returns Header overrides (never null, may be empty object).
 */
export function getDiversifiedHeaders(url: string): Record<string, string> {
  if (!url) return {};

  let domain: string;
  try {
    domain = new URL(url).hostname;
  } catch {
    return {};
  }

  const profile = getOrCreateProfile(domain);
  const overrides: Record<string, string> = {
    Connection: profile.connection,
    'Accept-Encoding': profile.acceptEncoding,
    Accept: profile.accept,
  };

  if (profile.keepAlive) {
    overrides['Keep-Alive'] = profile.keepAlive;
  }

  return overrides;
}

/**
 * Clear the domain header cache (useful for testing or forced rotation).
 */
export function clearDomainHeaderCache(): void {
  domainHeaderCache.clear();
}

/**
 * Get stats about the domain header cache.
 */
export function getDomainHeaderStats(): { domainsCached: number; cacheSize: number } {
  return {
    domainsCached: domainHeaderCache.size,
    cacheSize: domainHeaderCache.size,
  };
}
