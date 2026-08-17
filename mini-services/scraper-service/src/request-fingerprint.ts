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
