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

  // Evict oldest if cache is full (skip if refreshing an existing entry — set() will overwrite it)
  if (domainHeaderCache.size >= CACHE_MAX_SIZE && !domainHeaderCache.has(domain)) {
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

// ==================== IP Reputation Scoring ====================

/**
 * IP reputation scoring system.
 *
 * Tracks per-IP reputation based on response patterns:
 *   - IPs with many 429/403 responses have low reputation
 *   - IPs with consistent success have high reputation
 *   - Reputation affects proxy selection and rotation strategy
 */

export interface IPReputation {
  /** IP address or proxy identifier */
  ip: string;
  /** Reputation score (0-100, higher = better) */
  score: number;
  /** Total requests made from this IP */
  totalRequests: number;
  /** Total successful requests */
  successCount: number;
  /** Total block responses (429/403) */
  blockCount: number;
  /** Last used timestamp */
  lastUsed: number;
  /** Geographic region (if known) */
  region?: string;
}

const ipReputationCache = new Map<string, IPReputation>();
const MAX_IP_REPUTATIONS = 500;
const IP_REPUTATION_DECAY = 0.98; // Decay factor per request (reputation slowly recovers)

/**
 * Record a response for an IP and update its reputation.
 *
 * @param ip - IP address or proxy identifier
 * @param success - Whether the request succeeded
 * @param statusCode - HTTP status code
 */
export function recordIPResponse(ip: string, success: boolean, statusCode?: number): void {
  let rep = ipReputationCache.get(ip);

  if (!rep) {
    if (ipReputationCache.size >= MAX_IP_REPUTATIONS) {
      // Evict least recently used
      let lruKey = '';
      let lruTime = Infinity;
      for (const [key, r] of ipReputationCache) {
        if (r.lastUsed < lruTime) { lruTime = r.lastUsed; lruKey = key; }
      }
      if (lruKey) ipReputationCache.delete(lruKey);
    }
    rep = { ip, score: 50, totalRequests: 0, successCount: 0, blockCount: 0, lastUsed: Date.now() };
    ipReputationCache.set(ip, rep);
  }

  rep.totalRequests++;
  rep.lastUsed = Date.now();

  if (success) {
    rep.successCount++;
    // Success slowly increases reputation
    rep.score = Math.min(100, rep.score + (100 - rep.score) * 0.05);
  } else if (statusCode === 429 || statusCode === 403) {
    rep.blockCount++;
    // Block significantly decreases reputation
    rep.score = Math.max(0, rep.score - 15);
  } else {
    // Other failure moderately decreases reputation
    rep.score = Math.max(0, rep.score - 5);
  }

  // Apply decay (reputation slowly recovers over time)
  rep.score = rep.score * IP_REPUTATION_DECAY + 50 * (1 - IP_REPUTATION_DECAY);
}

/**
 * Get the reputation score for an IP.
 *
 * @param ip - IP address or proxy identifier
 * @returns Reputation score (0-100), or 50 (neutral) if unknown
 */
export function getIPReputation(ip: string): number {
  return ipReputationCache.get(ip)?.score ?? 50;
}

/**
 * Get all IP reputation entries (for dashboard).
 */
export function getAllIPReputations(): IPReputation[] {
  return Array.from(ipReputationCache.values())
    .sort((a, b) => b.score - a.score);
}

// ==================== IP Rotation Strategy Optimization ====================

/**
 * IP rotation strategy optimization.
 *
 * Determines when to rotate IPs based on:
 *   - Current IP reputation (low reputation → rotate sooner)
 *   - Request success pattern (consecutive failures → rotate immediately)
 *   - Domain-specific IP affinity (some domains prefer certain IP ranges)
 *   - Geographic consistency (IP should match Accept-Language region)
 */

export interface IPRotationDecision {
  /** Whether to rotate the IP */
  shouldRotate: boolean;
  /** Reason for rotation (or keeping) */
  reason: string;
  /** Urgency: 0 = no rotation, 1 = normal rotation, 2 = urgent, 3 = immediate */
  urgency: number;
  /** Preferred region for next IP (for geo-consistency) */
  preferredRegion?: string;
}

/**
 * Determine if the current IP should be rotated.
 *
 * @param currentIP - Current IP address
 * @param domain - Target domain
 * @param consecutiveFailures - Number of consecutive failures with this IP
 * @param currentRegion - Geographic region of current IP
 * @param targetRegion - Required geographic region (from Accept-Language)
 * @returns IP rotation decision
 */
export function shouldRotateIP(
  currentIP: string,
  domain: string,
  consecutiveFailures: number,
  currentRegion?: string,
  targetRegion?: string,
): IPRotationDecision {
  const reputation = getIPReputation(currentIP);

  // Immediate rotation on consecutive failures
  if (consecutiveFailures >= 3) {
    return { shouldRotate: true, reason: `${consecutiveFailures} consecutive failures`, urgency: 3, preferredRegion: targetRegion };
  }

  // Urgent rotation on very low reputation
  if (reputation < 20) {
    return { shouldRotate: true, reason: `IP reputation critically low (${reputation.toFixed(0)})`, urgency: 2, preferredRegion: targetRegion };
  }

  // Normal rotation on low reputation
  if (reputation < 40) {
    return { shouldRotate: true, reason: `IP reputation low (${reputation.toFixed(0)})`, urgency: 1, preferredRegion: targetRegion };
  }

  // Geographic mismatch rotation
  if (targetRegion && currentRegion && targetRegion !== currentRegion) {
    return { shouldRotate: true, reason: `Geo mismatch: IP in ${currentRegion}, need ${targetRegion}`, urgency: 1, preferredRegion: targetRegion };
  }

  // Keep current IP
  return { shouldRotate: false, reason: `IP reputation OK (${reputation.toFixed(0)})`, urgency: 0 };
}

// ==================== Geographic Consistency Checks ====================

/**
 * Geographic consistency checks.
 *
 * Verifies that the IP's geographic location is consistent with:
 *   - Accept-Language header
 *   - Timezone hints
 *   - DNS resolution location
 *
 * A mismatch (e.g., IP in US but Accept-Language is zh-CN) is a
 * moderate-strength detection signal.
 */

export interface GeoConsistencyResult {
  /** Whether the geography is consistent */
  consistent: boolean;
  /** Issues detected */
  issues: string[];
  /** Confidence of consistency (0-1) */
  confidence: number;
}

/** Map of country codes to primary language prefixes */
const COUNTRY_LANGUAGE_MAP: Record<string, string[]> = {
  CN: ['zh-CN', 'zh'],
  TW: ['zh-TW', 'zh'],
  HK: ['zh-HK', 'zh'],
  US: ['en-US', 'en'],
  JP: ['ja'],
  KR: ['ko'],
  DE: ['de'],
  FR: ['fr'],
  GB: ['en-GB', 'en'],
};

/**
 * Check geographic consistency between IP location and Accept-Language.
 *
 * @param ipCountry - Country of the IP (ISO 3166-1 alpha-2)
 * @param acceptLanguage - Accept-Language header value
 * @returns Consistency check result
 */
export function checkGeoConsistency(ipCountry: string, acceptLanguage: string): GeoConsistencyResult {
  const issues: string[] = [];
  const expectedLanguages = COUNTRY_LANGUAGE_MAP[ipCountry];

  if (!expectedLanguages) {
    // Unknown country — can't check consistency
    return { consistent: true, issues: [], confidence: 0.5 };
  }

  // Check if Accept-Language contains expected language
  const alLower = acceptLanguage.toLowerCase();
  const languageMatches = expectedLanguages.some(lang => alLower.includes(lang.toLowerCase()));

  if (!languageMatches) {
    issues.push(`IP in ${ipCountry} but Accept-Language doesn't include ${expectedLanguages.join('/')}`);
  }

  // Chinese IP with English-only Accept-Language is a red flag
  if (['CN', 'TW', 'HK'].includes(ipCountry) && !alLower.includes('zh')) {
    issues.push(`Chinese IP but no Chinese in Accept-Language`);
  }

  const consistent = issues.length === 0;
  const confidence = consistent ? 0.9 : 0.3;

  return { consistent, issues, confidence };
}
