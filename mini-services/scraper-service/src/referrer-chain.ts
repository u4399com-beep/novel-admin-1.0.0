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
 *   - Cross-domain referrer support (e.g. Google search → target site)
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
  /** Evict oldest domain if at capacity */
  private evictIfNeeded(): void {
    while (this.history.size >= MAX_TRACKED_DOMAINS) {
      const firstKey = this.history.keys().next().value;
      if (firstKey) {
        this.history.delete(firstKey);
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
   * Record a cross-domain referrer transition.
   * For example, when coming from a search engine to a target site.
   *
   * @param fromUrl - The source URL (e.g. a search results page).
   * @param toUrl   - The target URL we are navigating to.
   */
  recordCrossDomainTransition(fromUrl: string, toUrl: string): void {
    if (!fromUrl || !toUrl) return;
    try {
      const fromDomain = new URL(fromUrl).hostname;
      const toDomain = new URL(toUrl).hostname;
      if (fromDomain === toDomain) return; // Not cross-domain
      // Record the fromUrl in the target domain's history first so that
      // getReferer(toUrl) can return fromUrl as a cross-domain referrer
      // (e.g. Google search result → novel site first page).
      const toEntries = this.history.get(toDomain);
      if (!toEntries || toEntries.length === 0) {
        this.evictIfNeeded();
        this.history.set(toDomain, [{ url: fromUrl, timestamp: Date.now() }]);
      }
      // Then record the actual navigation to toUrl
      this.recordVisit(toUrl);
    } catch {
      // Invalid URL, silently ignore
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

  /**
   * Get the navigation history for a domain (for debugging/monitoring).
   */
  getHistory(domain: string): NavigationEntry[] {
    return this.history.get(domain) ? [...this.history.get(domain)!] : [];
  }

  /**
   * Get stats about the referrer chain.
   */
  getStats(): { domainsTracked: number; totalEntries: number; domainCounts: Record<string, number> } {
    const domainCounts: Record<string, number> = {};
    let totalEntries = 0;
    for (const [domain, entries] of this.history.entries()) {
      if (entries.length > 0) {
        domainCounts[domain] = entries.length;
        totalEntries += entries.length;
      }
    }
    return {
      domainsTracked: this.history.size,
      totalEntries,
      domainCounts,
    };
  }
}

// Singleton export
export const referrerChain = new ReferrerChain();
