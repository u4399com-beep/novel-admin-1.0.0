/**
 * Request Fingerprint Manager
 * Assigns unique IDs to each outbound scraping request for tracking,
 * rate limiting per domain, and debugging.
 *
 * Key capabilities:
 *   - Generate 8-char hex request IDs
 *   - Track request counts per domain (sliding window)
 *   - Validate fingerprints before requests execute
 *   - Record completion status for monitoring
 *   - Auto-cleanup of stale entries
 *   - Timing jitter (±50ms) to avoid timing-based detection
 *   - POST body padding to avoid fixed-size request signatures
 */

// ==================== Types ====================

export interface RequestFingerprint {
  requestId: string;        // 8-char hex ID
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
const CLEANUP_INTERVAL_MS = 2 * 60 * 1000;   // cleanup every 2 minutes

// ==================== RequestFingerprintManager ====================

class RequestFingerprintManager {
  private recentFingerprints: Map<string, RequestFingerprint> = new Map();  // requestId -> fp
  private domainFpIds: Map<string, Set<string>> = new Map();                   // domain -> active requestIds
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Auto-cleanup every 2 minutes
    this.cleanupInterval = setInterval(() => {
      try {
        this.cleanup();
      } catch (err) {
        console.error('[RequestFingerprint] Cleanup error:', err);
      }
    }, CLEANUP_INTERVAL_MS);
  }

  /**
   * Create a new fingerprint for a request.
   * Generates an 8-char hex ID, stores with timestamp, increments domain counter.
   */
  create(options: {
    domain: string;
    engine: string;
    sessionId?: string;
    proxyUrl?: string;
    userAgent?: string;
  }): RequestFingerprint {
    // Generate 8-char hex ID
    const id = this.generateHexId(8);

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

    // Track in-flight request per domain
    const ids = this.domainFpIds.get(options.domain) || new Set();
    ids.add(id);
    this.domainFpIds.set(options.domain, ids);

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
  }

  /** Get recent fingerprints for a domain (for debugging/monitoring) */
  getDomainFingerprints(domain: string): RequestFingerprint[] {
    const results: RequestFingerprint[] = [];
    for (const fp of this.recentFingerprints.values()) {
      if (fp.domain === domain) {
        results.push(fp);
      }
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
    for (const [id, fp] of this.recentFingerprints.entries()) {
      if (fp.timestamp < expireCutoff) {
        this.recentFingerprints.delete(id);
        cleaned++;
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

  /** Generate a random hex string of the given length */
  private generateHexId(length: number): string {
    const bytes = new Uint8Array(length);
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
 * @returns A promise that resolves after a random delay between -50ms and +50ms.
 *         The delay is applied asynchronously (non-blocking wait).
 */
export async function applyTimingJitter(): Promise<void> {
  const jitterMs = Math.round((Math.random() - 0.5) * 100); // -50 to +50
  if (jitterMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, jitterMs));
  }
  // Negative jitter = no extra wait (can't go back in time)
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
