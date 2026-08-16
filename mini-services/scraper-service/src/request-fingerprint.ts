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
const MAX_DOMAIN_RPM = 60;                  // 60 requests per domain per minute
const FINGERPRINT_EXPIRE_MS = 2 * 60 * 1000; // 2 minutes for cleanup
const CLEANUP_INTERVAL_MS = 2 * 60 * 1000;   // cleanup every 2 minutes

// ==================== RequestFingerprintManager ====================

class RequestFingerprintManager {
  private recentFingerprints: Map<string, RequestFingerprint> = new Map();  // requestId -> fp
  private domainFpCount: Map<string, number[]> = new Map();                  // domain -> timestamps
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

    // Increment domain counter
    const timestamps = this.domainFpCount.get(options.domain) || [];
    timestamps.push(fp.timestamp);
    this.domainFpCount.set(options.domain, timestamps);

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

    // Count domain requests in the last minute
    const now = Date.now();
    const minuteAgo = now - 60 * 1000;
    const timestamps = this.domainFpCount.get(fp.domain) || [];
    const recentCount = timestamps.filter(t => t >= minuteAgo).length;

    if (recentCount > MAX_DOMAIN_RPM) {
      return { valid: false, reason: `Domain rate limit exceeded (${recentCount}/${MAX_DOMAIN_RPM} rpm)` };
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

    // Decrement domain counter
    const timestamps = this.domainFpCount.get(fp.domain) || [];
    const idx = timestamps.lastIndexOf(fp.timestamp);
    if (idx !== -1) {
      timestamps.splice(idx, 1);
    }
    if (timestamps.length === 0) {
      this.domainFpCount.delete(fp.domain);
    } else {
      this.domainFpCount.set(fp.domain, timestamps);
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
    const minuteAgo = Date.now() - 60 * 1000;

    for (const [domain, timestamps] of this.domainFpCount.entries()) {
      const recentCount = timestamps.filter(t => t >= minuteAgo).length;
      if (recentCount > 0) {
        domainCounts[domain] = recentCount;
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

    // Clean up old domain counter entries
    const minuteAgo = now - 60 * 1000;
    for (const [domain, timestamps] of this.domainFpCount.entries()) {
      // Remove timestamps older than 2 minutes (they're irrelevant)
      const filtered = timestamps.filter(t => t > (now - 2 * 60 * 1000));
      if (filtered.length === 0) {
        this.domainFpCount.delete(domain);
      } else if (filtered.length < timestamps.length) {
        this.domainFpCount.set(domain, filtered);
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
