// ==================== Sec-CH-UA (Client Hints) Headers ====================

/**
 * Generate Sec-CH-UA client hints headers matching the browser from the UA string.
 * These headers MUST be consistent with the User-Agent — a mismatch is a strong
 * detection signal used by Cloudflare, PerimeterX, and Akamai.
 *
 * Format: Sec-CH-UA: "Chromium";v="134", "Not A(Brand";v="99", "Google Chrome";v="134"
 * Format: Sec-CH-UA-Mobile: ?0
 * Format: Sec-CH-UA-Platform: "Windows"
 */
export function generateSecChUAHeaders(ua: string): Record<string, string> {
  const headers: Record<string, string> = {};

  // Extract Chrome version from UA
  const chromeMatch = ua.match(/Chrome\/(\d+)/);
  const chromeVersion = chromeMatch ? chromeMatch[1] : '134';

  // Detect browser family
  const isEdge = /Edg\//.test(ua);
  const isFirefox = /Firefox\//.test(ua);
  const edgeMatch = ua.match(/Edg\/(\d+)/);
  const edgeVersion = edgeMatch ? edgeMatch[1] : chromeVersion;

  // Firefox doesn't send Sec-CH-UA headers
  if (isFirefox) {
    return {};
  }

  // Sec-CH-UA
  if (isEdge) {
    headers['Sec-CH-UA'] = `"Chromium";v="${chromeVersion}", "Not_A Brand";v="99", "Microsoft Edge";v="${edgeVersion}"`;
  } else {
    headers['Sec-CH-UA'] = `"Chromium";v="${chromeVersion}", "Not_A Brand";v="99", "Google Chrome";v="${chromeVersion}"`;
  }

  // Sec-CH-UA-Mobile
  headers['Sec-CH-UA-Mobile'] = '?0';

  // Sec-CH-UA-Platform
  if (/Macintosh/.test(ua)) {
    headers['Sec-CH-UA-Platform'] = '"macOS"';
  } else if (/Linux/.test(ua)) {
    headers['Sec-CH-UA-Platform'] = '"Linux"';
  } else {
    headers['Sec-CH-UA-Platform'] = '"Windows"';
  }

  // Sec-CH-UA-Full-Version-List (optional, newer browsers)
  if (isEdge) {
    headers['Sec-CH-UA-Full-Version-List'] = `"Chromium";v="${chromeVersion}.0.0.0", "Not_A Brand";v="99.0.0.0", "Microsoft Edge";v="${edgeVersion}.0.0.0"`;
  } else {
    headers['Sec-CH-UA-Full-Version-List'] = `"Chromium";v="${chromeVersion}.0.0.0", "Not_A Brand";v="99.0.0.0", "Google Chrome";v="${chromeVersion}.0.0.0"`;
  }

  return headers;
}

// ==================== Sec-Fetch-* Headers ====================

export type FetchDest = 'document' | 'iframe' | 'script' | 'style' | 'image' | 'font' | 'empty' | 'video' | 'audio';
export type FetchMode = 'navigate' | 'no-cors' | 'cors' | 'same-origin' | 'websocket';
export type FetchSite = 'none' | 'same-origin' | 'same-site' | 'cross-site';

export interface SecFetchHeaders {
  'Sec-Fetch-Dest': string;
  'Sec-Fetch-Mode': string;
  'Sec-Fetch-Site': string;
  'Sec-Fetch-User'?: string;
}

/**
 * Generate Sec-Fetch-* headers for a request.
 * These headers indicate how the browser initiated the request and are
 * checked by anti-bot systems for consistency.
 *
 * @param dest - The destination type of the request
 * @param isNavigation - Whether this is a top-level navigation (user clicked a link)
 * @param site - The relationship between the request origin and target origin
 */
export function generateSecFetchHeaders(
  dest: FetchDest = 'document',
  isNavigation: boolean = true,
  site: FetchSite = 'cross-site'
): SecFetchHeaders {
  const mode: FetchMode = isNavigation ? 'navigate' : (dest === 'script' || dest === 'style' ? 'no-cors' : 'cors');

  const headers: SecFetchHeaders = {
    'Sec-Fetch-Dest': dest,
    'Sec-Fetch-Mode': mode,
    'Sec-Fetch-Site': site,
  };

  // Sec-Fetch-User is only sent with navigate requests
  if (isNavigation) {
    headers['Sec-Fetch-User'] = '?1';
  }

  return headers;
}

/**
 * Infer Sec-Fetch-* headers from a URL and context.
 * Uses the URL path to determine the likely destination type.
 */
export function inferSecFetchHeaders(url: string, isNavigation: boolean = true, site: FetchSite = 'cross-site'): SecFetchHeaders {
  try {
    const path = new URL(url).pathname.toLowerCase();
    const ext = path.split('.').pop() || '';

    let dest: FetchDest = 'document';
    if (ext === 'js' || ext === 'mjs') dest = 'script';
    else if (ext === 'css') dest = 'style';
    else if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'avif'].includes(ext)) dest = 'image';
    else if (['woff', 'woff2', 'ttf', 'otf', 'eot'].includes(ext)) dest = 'font';
    else if (['mp4', 'webm', 'ogg'].includes(ext)) dest = 'video';
    else if (['mp3', 'wav', 'flac'].includes(ext)) dest = 'audio';
    // HTML pages and paths without recognizable extensions are document

    return generateSecFetchHeaders(dest, isNavigation, site);
  } catch {
    return generateSecFetchHeaders('document', isNavigation, site);
  }
}

// ==================== Accept-Language Rotation ====================

/**
 * Accept-Language rotation: rotate every 50 requests, not just per-domain.
 * This prevents Accept-Language fingerprinting across many requests.
 */

const ACCEPT_LANGUAGE_VARIANTS = [
  'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
  'zh-CN,zh;q=0.9,en;q=0.8',
  'zh-CN,zh;q=0.8,en-US;q=0.6,en;q=0.4',
  'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
  'zh-CN,en-US;q=0.9,en;q=0.8',
  'zh-CN,zh;q=0.9',
  'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
  'en-US,en;q=0.8,zh-CN;q=0.6,zh;q=0.4',
] as const;

let acceptLanguageIndex = 0;
let acceptLanguageRequestCount = 0;
const ACCEPT_LANGUAGE_ROTATE_EVERY = 50;

/**
 * Get the current Accept-Language header value.
 * Rotates every 50 requests to avoid fingerprint correlation.
 */
export function getAcceptLanguage(): string {
  acceptLanguageRequestCount++;
  if (acceptLanguageRequestCount % ACCEPT_LANGUAGE_ROTATE_EVERY === 0) {
    acceptLanguageIndex = (acceptLanguageIndex + 1) % ACCEPT_LANGUAGE_VARIANTS.length;
  }
  return ACCEPT_LANGUAGE_VARIANTS[acceptLanguageIndex]!;
}

/**
 * Reset Accept-Language rotation state.
 */
export function resetAcceptLanguageRotation(): void {
  acceptLanguageIndex = 0;
  acceptLanguageRequestCount = 0;
}

// ==================== Connection Header Variation ====================

/**
 * Connection header variation: use keep-alive ~95% of the time and close ~5%.
 * This matches real browser behavior where keep-alive is the default but
 * occasional connection closes happen (e.g., server-sent close, timeout).
 */
export function getConnectionHeader(): string {
  // 95% keep-alive, 5% close (matches real browser behavior)
  return Math.random() < 0.95 ? 'keep-alive' : 'close';
}

// ==================== Complete Request Headers Builder ====================

/**
 * Build a complete set of anti-detection request headers for a URL.
 * Combines: Sec-CH-UA + Sec-Fetch-* + Accept-Language + Connection
 *
 * @param ua - User-Agent string
 * @param url - Target URL
 * @param isNavigation - Whether this is a navigation request
 * @param site - Fetch site relationship
 */
export function buildAntiDetectionHeaders(
  ua: string,
  url: string,
  isNavigation: boolean = true,
  site: FetchSite = 'cross-site'
): Record<string, string> {
  const headers: Record<string, string> = {};

  // 1. Sec-CH-UA headers (matching the UA)
  const chHeaders = generateSecChUAHeaders(ua);
  Object.assign(headers, chHeaders);

  // 2. Sec-Fetch-* headers
  const fetchHeaders = inferSecFetchHeaders(url, isNavigation, site);
  Object.assign(headers, fetchHeaders);

  // 3. Accept-Language (rotated)
  headers['Accept-Language'] = getAcceptLanguage();

  // 4. Connection header
  headers['Connection'] = getConnectionHeader();

  // 5. Accept header based on request type
  if (isNavigation) {
    headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';
  } else {
    headers['Accept'] = '*/*';
  }

  // 6. Upgrade-Insecure-Requests for navigations
  if (isNavigation) {
    headers['Upgrade-Insecure-Requests'] = '1';
  }

  return headers;
}

// ==================== Original Module (unchanged below) ====================

/**
 * Request Fingerprint Manager
 * Assigns unique IDs to each outbound scraping request for tracking,
 * rate limiting per domain, and debugging.
 *
 * Key capabilities:
 *   - Generate 32-char hex request IDs
 *   - Track request counts per domain (sliding window)
 *   - Validate fingerprints before requests execute
 *   - Record completion status for monitoring
 *   - Auto-cleanup of stale entries
 *   - Timing jitter (±50ms) to avoid timing-based detection
 *   - POST body padding to avoid fixed-size request signatures
 */

// ==================== Types ====================

export interface RequestFingerprint {
  requestId: string;        // 32-char hex ID (16 bytes)
  sessionId?: string;        // from SessionManager
  domain: string;
  timestamp: number;
  userAgent: string;
  proxyUrl?: string;
  engine: string;
  completed?: boolean;
  success?: boolean;
  statusCode?: number;
}

// ==================== Constants ====================

const MAX_AGE_MS = 5 * 60 * 1000;          // 5 minutes
const MAX_CONCURRENT_PER_DOMAIN = 60;         // max concurrent in-flight requests per domain
const FINGERPRINT_EXPIRE_MS = 2 * 60 * 1000; // 2 minutes for cleanup
const CLEANUP_INTERVAL_MS = 30 * 1000;       // cleanup every 30 seconds (shorter than expiry to prevent bloat)
const MAX_TOTAL_FINGERPRINTS = 10000;        // hard cap on stored fingerprints

// ==================== RequestFingerprintManager ====================

class RequestFingerprintManager {
  private recentFingerprints: Map<string, RequestFingerprint> = new Map();  // requestId -> fp
  private domainFpIds: Map<string, Set<string>> = new Map();                   // domain -> active requestIds
  private domainIndex: Map<string, string[]> = new Map();                      // domain -> all fingerprint IDs (including completed)
  private fingerprintToDomain: Map<string, string> = new Map();                // requestId -> domain (reverse lookup)
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Auto-cleanup every 2 minutes
    this.cleanupInterval = setInterval(() => {
      try {
        this.cleanup();
      } catch (err) {
        console.error('[RequestFingerprint] Cleanup error:', err);
      }
    }, CLEANUP_INTERVAL_MS).unref();
  }

  /**
   * Create a new fingerprint for a request.
   * Generates a 32-char (16-byte) hex ID, stores with timestamp, increments domain counter.
   */
  create(options: {
    domain: string;
    engine: string;
    sessionId?: string;
    proxyUrl?: string;
    userAgent?: string;
  }): RequestFingerprint {
    // Generate 32-char (16-byte) hex ID
    const id = this.generateHexId(16);

    const fp: RequestFingerprint = {
      requestId: id,
      sessionId: options.sessionId,
      domain: options.domain,
      timestamp: Date.now(),
      userAgent: options.userAgent || 'unknown',
      proxyUrl: options.proxyUrl,
      engine: options.engine,
    };

    this.recentFingerprints.set(id, fp);
    this.fingerprintToDomain.set(id, options.domain);

    // Hard cap: if we exceed MAX_TOTAL_FINGERPRINTS, trigger immediate cleanup
    if (this.recentFingerprints.size > MAX_TOTAL_FINGERPRINTS) {
      this.cleanup();
    }

    // Track in-flight request per domain
    const ids = this.domainFpIds.get(options.domain) || new Set();
    ids.add(id);
    this.domainFpIds.set(options.domain, ids);

    // Update domain index for O(1) lookups
    const domainIds = this.domainIndex.get(options.domain) || [];
    domainIds.push(id);
    this.domainIndex.set(options.domain, domainIds);

    return fp;
  }

  /**
   * Validate that a fingerprint is still valid:
   *   - Exists
   *   - Not expired (>5 minutes old)
   *   - Domain not exceeding 60 req/min
   */
  validate(requestId: string): { valid: boolean; reason?: string } {
    const fp = this.recentFingerprints.get(requestId);
    if (!fp) {
      return { valid: false, reason: 'Fingerprint not found' };
    }

    const age = Date.now() - fp.timestamp;
    if (age > MAX_AGE_MS) {
      return { valid: false, reason: 'Fingerprint expired (>5 min old)' };
    }

    // Count concurrent in-flight requests for this domain
    const ids = this.domainFpIds.get(fp.domain);
    const recentCount = ids ? ids.size : 0;

    if (recentCount > MAX_CONCURRENT_PER_DOMAIN) {
      return { valid: false, reason: `Domain concurrent limit exceeded (${recentCount}/${MAX_CONCURRENT_PER_DOMAIN})` };
    }

    return { valid: true };
  }

  /**
   * Discard a fingerprint — removes it from all tracking maps.
   * Use this on exception paths to prevent leaked domainFpIds entries.
   */
  discard(requestId: string): void {
    // Use reverse lookup to find domain directly
    const domain = this.fingerprintToDomain.get(requestId);
    if (domain) {
      this.domainFpIds.get(domain)?.delete(requestId);
      // Remove from domainIndex
      const domainIds = this.domainIndex.get(domain);
      if (domainIds) {
        const idx = domainIds.indexOf(requestId);
        if (idx !== -1) domainIds.splice(idx, 1);
        if (domainIds.length === 0) this.domainIndex.delete(domain);
      }
      this.fingerprintToDomain.delete(requestId);
    }
    this.recentFingerprints.delete(requestId);
  }

  /**
   * Record request completion.
   * Marks the fingerprint as completed and decrements domain counter.
   */
  complete(requestId: string, success: boolean, statusCode?: number): void {
    const fp = this.recentFingerprints.get(requestId);
    if (!fp) return;

    fp.completed = true;
    fp.success = success;
    fp.statusCode = statusCode;

    // Remove from domain tracking
    const ids = this.domainFpIds.get(fp.domain);
    if (ids) {
      ids.delete(fp.requestId);
      if (ids.size === 0) {
        this.domainFpIds.delete(fp.domain);
      }
    }
    // Clean up reverse lookup and domain index
    this.fingerprintToDomain.delete(requestId);
    const domainIds = this.domainIndex.get(fp.domain);
    if (domainIds) {
      const idx = domainIds.indexOf(requestId);
      if (idx !== -1) domainIds.splice(idx, 1);
      if (domainIds.length === 0) this.domainIndex.delete(fp.domain);
    }
  }

  /** Get recent fingerprints for a domain (for debugging/monitoring) — O(k) via domain index */
  getDomainFingerprints(domain: string): RequestFingerprint[] {
    const domainIds = this.domainIndex.get(domain);
    if (!domainIds || domainIds.length === 0) return [];
    const results: RequestFingerprint[] = [];
    for (const id of domainIds) {
      const fp = this.recentFingerprints.get(id);
      if (fp) results.push(fp);
    }
    // Sort by timestamp descending
    results.sort((a, b) => b.timestamp - a.timestamp);
    return results;
  }

  /** Get all recent fingerprints, optionally limited */
  getAllRecentFingerprints(limit?: number): RequestFingerprint[] {
    let results = Array.from(this.recentFingerprints.values());
    results.sort((a, b) => b.timestamp - a.timestamp);
    if (limit && limit > 0) {
      results = results.slice(0, limit);
    }
    return results;
  }

  /** Get stats about fingerprints */
  getStats(): {
    totalFingerprints: number;
    domainsTracked: number;
    domainCounts: Record<string, number>;
  } {
    const domainCounts: Record<string, number> = {};

    for (const [domain, ids] of this.domainFpIds.entries()) {
      if (ids.size > 0) {
        domainCounts[domain] = ids.size;
      }
    }

    return {
      totalFingerprints: this.recentFingerprints.size,
      domainsTracked: Object.keys(domainCounts).length,
      domainCounts,
    };
  }

  /** Cleanup old entries (stale fingerprints and expired domain counters) */
  cleanup(): void {
    const now = Date.now();
    const expireCutoff = now - FINGERPRINT_EXPIRE_MS;
    let cleaned = 0;

    // Remove expired fingerprints
    const expiredIds: string[] = [];
    for (const [id, fp] of this.recentFingerprints.entries()) {
      if (fp.timestamp < expireCutoff) {
        expiredIds.push(id);
        this.recentFingerprints.delete(id);
        cleaned++;
      }
    }

    // Clean up reverse lookup and domain index for expired fingerprints
    for (const id of expiredIds) {
      const domain = this.fingerprintToDomain.get(id);
      if (domain) {
        this.fingerprintToDomain.delete(id);
        const domainIds = this.domainIndex.get(domain);
        if (domainIds) {
          const idx = domainIds.indexOf(id);
          if (idx !== -1) domainIds.splice(idx, 1);
          if (domainIds.length === 0) this.domainIndex.delete(domain);
        }
      }
    }

    // Clean up domain tracking entries whose requestIds no longer exist
    for (const [domain, ids] of this.domainFpIds.entries()) {
      // Remove request IDs that no longer exist in recentFingerprints
      const staleIds: string[] = [];
      for (const id of ids) {
        if (!this.recentFingerprints.has(id)) {
          staleIds.push(id);
        }
      }
      for (const staleId of staleIds) {
        ids.delete(staleId);
      }
      if (ids.size === 0) {
        this.domainFpIds.delete(domain);
      }
    }

    if (cleaned > 0 && process.env.DEBUG === 'true') {
      console.log(`[RequestFingerprint] Cleaned ${cleaned} stale fingerprints`);
    }
  }

  /** Stop the cleanup interval (for graceful shutdown) */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  // ==================== Private Helpers ====================

  /** Generate a random hex string of the given byte-length (produces length*2 hex chars). */
  private generateHexId(byteLength: number): string {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }
}

// Singleton export
export const requestFingerprintMgr = new RequestFingerprintManager();

// ==================== Timing Jitter ====================

/**
 * Apply a random timing jitter of ±50ms to avoid timing-based fingerprinting.
 * Some anti-bot systems measure the exact inter-request interval; adding
 * small random delays makes the pattern look more human.
 *
 * Enhanced: Uses a Gaussian-like distribution (Box-Muller approximation)
 * instead of uniform distribution, as human timing naturally follows
 * a bell curve rather than uniform randomness.
 *
 * @returns A promise that resolves after a random delay between -50ms and +50ms.
 *         The delay is applied asynchronously (non-blocking wait).
 */
export async function applyTimingJitter(): Promise<void> {
  // Box-Muller approximation for Gaussian-like jitter
  const u1 = Math.random();
  const u2 = Math.random();
  const gaussian = Math.sqrt(-2 * Math.log(u1 || 0.0001)) * Math.cos(2 * Math.PI * u2);
  // Scale: mean=0, stddev=20ms, clamped to ±50ms
  const jitterMs = Math.round(Math.max(-50, Math.min(50, gaussian * 20)));
  if (jitterMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, jitterMs));
  }
  // Negative jitter = no extra wait (can't go back in time)
}

// ==================== Response Processing Time Evasion ====================

/**
 * Apply a variable post-response processing delay to defeat timing-based
 * bot detection. Some advanced WAFs measure the time between receiving
 * a response and sending the next request — a perfectly consistent or
 * near-zero processing time is a strong bot signal.
 *
 * Simulates human cognitive processing:
 *   - Base delay: 50-200ms (visual scanning/reading page title)
 *   - Content-dependent: longer for pages with more content
 *   - Randomness: ±30% variation to avoid patterns
 *   - Occasional longer pause (10% chance): 300-800ms (distraction)
 *
 * @param contentLength - Length of the received content (chars)
 * @returns A promise that resolves after the simulated processing delay
 */
export async function applyResponseProcessingDelay(contentLength: number): Promise<void> {
  // Base delay: 50-200ms
  const baseDelay = 50 + Math.random() * 150;

  // Content-dependent scaling: longer content → more "reading" time
  // Using logarithmic scaling to avoid excessive delays for very long pages
  const contentFactor = contentLength > 0 ? Math.min(1, Math.log2(contentLength / 500) / 5) : 0;
  const contentDelay = contentFactor * 100; // 0-100ms additional

  // Total with ±30% jitter
  const total = (baseDelay + contentDelay) * (0.7 + Math.random() * 0.6);

  // 10% chance of a longer distraction pause
  const distractionDelay = Math.random() < 0.10 ? (300 + Math.random() * 500) : 0;

  const delayMs = Math.round(total + distractionDelay);
  if (delayMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }
}

// ==================== HTTP/2 Pseudo-Header Order ====================

/**
 * HTTP/2 pseudo-header ordering per browser type.
 *
 * HTTP/2 requires pseudo-headers (:method, :authority, :scheme, :path)
 * to appear before regular headers, but their ORDER within the pseudo-headers
 * is browser-specific and is used as a fingerprinting signal by advanced WAFs.
 *
 * Chrome order:  :method, :authority, :scheme, :path
 * Firefox order: :method, :path, :authority, :scheme
 * Safari order:  :method, :scheme, :authority, :path
 *
 * This function returns the correct pseudo-header order for a given UA.
 *
 * @param ua - User-Agent string
 * @returns Array of pseudo-header names in the correct order for this browser
 */
export function getH2PseudoHeaderOrder(ua: string): string[] {
  if (ua.includes('Firefox/')) {
    return [':method', ':path', ':authority', ':scheme'];
  }
  if (ua.includes('Safari/') && ua.includes('Macintosh') && !ua.includes('Chrome/')) {
    return [':method', ':scheme', ':authority', ':path'];
  }
  // Chrome, Edge, and all Chromium-based browsers
  return [':method', ':authority', ':scheme', ':path'];
}

/**
 * Get HTTP/2 header frame priority/weight for a resource type.
 * Chrome assigns different weights to different resource types in HTTP/2 PRIORITY frames.
 *
 * @param resourceType - The type of resource being requested
 * @returns Priority weight (1-256, higher = more urgent)
 */
export function getH2ResourcePriority(resourceType: 'document' | 'stylesheet' | 'script' | 'image' | 'xhr' | 'font' | 'other'): number {
  const PRIORITY_MAP: Record<string, number> = {
    document: 256,    // Main document: highest priority
    stylesheet: 187,  // CSS: high priority (render-blocking)
    script: 140,      // JS: medium-high (parser-blocking)
    xhr: 256,         // XHR/fetch: high (user-initiated)
    image: 110,       // Images: lower (progressive)
    font: 110,        // Fonts: lower
    other: 110,       // Default
  };
  return PRIORITY_MAP[resourceType] || 110;
}

// ==================== POST Body Padding ====================

/**
 * Pad a POST request body with invisible whitespace/comments to randomize
 * the request size.  Some anti-bot systems fingerprint requests by their
 * exact byte size; padding defeats this.
 *
 * Strategy:
 *   - For URL-encoded bodies (application/x-www-form-urlencoded): append
 *     a comment-like suffix (`&_=padding_...`) that most servers ignore.
 *   - For JSON bodies: add a `_p` key with a random-length whitespace string.
 *   - For other content types: append whitespace bytes (safe for text-based bodies).
 *
 * @param body       - The original request body string.
 * @param contentType - The Content-Type header value.
 * @returns The padded body string, or the original body if padding is not applicable.
 */
export function padPostBody(body: string, contentType?: string): string {
  if (!body || body.length === 0) return body;

  // Generate 1–32 bytes of random padding
  const padLen = 1 + Math.floor(Math.random() * 32);
  const padding = ' '.repeat(padLen);

  const ct = (contentType || '').toLowerCase();

  if (ct.includes('application/x-www-form-urlencoded')) {
    // Append a dummy parameter that servers will ignore
    // Using a key starting with underscore to avoid conflicts
    const dummyParam = `&_=${encodeURIComponent(padding)}`;
    return body + dummyParam;
  }

  if (ct.includes('application/json')) {
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        // Add a padding key — most APIs ignore unknown keys
        parsed['_p'] = padding;
        return JSON.stringify(parsed);
      }
    } catch {
      // Not valid JSON, fall through to whitespace append
    }
  }

  // Default: append whitespace (safe for text-based bodies)
  return body + padding;
}
