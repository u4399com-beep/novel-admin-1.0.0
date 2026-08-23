/**
 * Referrer Chain Simulation
 *
 * Maintains a per-domain navigation history (LRU, max 100 entries) so that
 * subsequent requests to the same domain carry a realistic Referer header
 * derived from the previously visited URL.  This defeats simple server-side
 * checks that require the Referer to be a page the user could have
 * actually clicked from (e.g. list → detail, TOC → chapter).
 *
 * Features:
 *   - Per-domain LRU navigation history (max 100 entries)
 *   - Automatic Referer resolution based on the last visited URL
 *   - Thread-safe (single-threaded Node.js, but Map operations are atomic)
 */

// ==================== Types ====================

interface NavigationEntry {
  url: string;
  timestamp: number;
}

// ==================== Constants ====================

const MAX_HISTORY_PER_DOMAIN = 100;
const MAX_TRACKED_DOMAINS = 500;

// ==================== ReferrerChain ====================

class ReferrerChain {
  /** domain → array of NavigationEntry (most-recent last) */
  private history: Map<string, NavigationEntry[]> = new Map();

  // ---- Public API ----

  /**
   * Record a successful navigation to `url`.
   * The entry is appended to the navigation history for the URL's domain.
   */
  /** Evict least-recently-used domain if at capacity */
  private evictIfNeeded(): void {
    while (this.history.size >= MAX_TRACKED_DOMAINS) {
      // Find the domain with the oldest lastRequestTime (true LRU, not FIFO)
      let lruKey = '';
      let lruTime = Infinity;
      for (const [key, entries] of this.history.entries()) {
        const lastTime = entries.length > 0 ? entries[entries.length - 1].timestamp : 0;
        if (lastTime < lruTime) { lruTime = lastTime; lruKey = key; }
      }
      if (lruKey) {
        this.history.delete(lruKey);
      } else break;
    }
  }

  recordVisit(url: string): void {
    if (!url) return;
    try {
      const parsed = new URL(url);
      const domain = parsed.hostname;
      let entries = this.history.get(domain);
      if (!entries) {
        this.evictIfNeeded();
        entries = [];
        this.history.set(domain, entries);
      }
      // Append to end (most recent)
      entries.push({ url, timestamp: Date.now() });
      // Evict oldest if over limit
      if (entries.length > MAX_HISTORY_PER_DOMAIN) {
        entries.shift();
      }
    } catch {
      // Invalid URL, silently ignore
    }
  }

  /**
   * Get the Referer that should be sent when requesting `targetUrl`.
   *
   * Strategy:
   *   1. Same-domain: use the last visited URL for that domain.
   *   2. Cross-domain (no prior visit): return undefined (let the caller
   *      fall back to spoofed referer or no referer).
   *
   * @param targetUrl - The URL we are about to request.
   * @returns The Referer URL string, or undefined if no suitable referrer exists.
   */
  getReferer(targetUrl: string): string | undefined {
    if (!targetUrl) return undefined;
    try {
      const parsed = new URL(targetUrl);
      const domain = parsed.hostname;
      const entries = this.history.get(domain);
      if (!entries || entries.length === 0) return undefined;
      // Return the most recently visited URL for this domain
      const last = entries[entries.length - 1];
      // Don't refer to self (exact same URL)
      if (last.url === targetUrl) {
        // Fall back to second-to-last if available
        if (entries.length >= 2) {
          return entries[entries.length - 2].url;
        }
        return undefined;
      }
      return last.url;
    } catch {
      return undefined;
    }
  }

  /**
   * Clear navigation history. If `domain` is provided, only clears that domain.
   */
  clearHistory(domain?: string): void {
    if (domain) {
      this.history.delete(domain);
    } else {
      this.history.clear();
    }
  }
}

// Singleton export
export const referrerChain = new ReferrerChain();
