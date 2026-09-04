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
 *   - Warm-up strategy: simulate homepage → category → content navigation
 */

// ==================== Types ====================

interface NavigationEntry {
  url: string;
  timestamp: number;
}

// ==================== Constants ====================

const MAX_HISTORY_PER_DOMAIN = 100;
const MAX_TRACKED_DOMAINS = 500;

// ==================== Warm-up Strategy ====================

/**
 * Warm-up navigation sequence for a URL.
 * Simulates how a real user would navigate to a deep page:
 *   1. Homepage (domain root)
 *   2. Category/list page (one path segment)
 *   3. Target page (full URL)
 *
 * This ensures the referrer chain looks natural:
 *   homepage → category → target
 * instead of:
 *   (no referrer) → target  ← bot-like pattern
 */
export interface WarmUpSequence {
  /** The warm-up URLs to visit before the target (in order) */
  warmUpUrls: string[];
  /** The final target URL */
  targetUrl: string;
}

/**
 * Generate a warm-up sequence for a target URL.
 * Returns 0-2 warm-up URLs that simulate natural navigation.
 *
 * Examples:
 *   https://example.com/book/12345/chapter/6
 *     → warmUp: [https://example.com/, https://example.com/book/12345/]
 *
 *   https://example.com/list/page/3
 *     → warmUp: [https://example.com/, https://example.com/list/]
 *
 *   https://example.com/
 *     → warmUp: [] (already at root, no warm-up needed)
 */
export function generateWarmUpSequence(targetUrl: string): WarmUpSequence {
  try {
    const parsed = new URL(targetUrl);
    const origin = parsed.origin;
    const pathParts = parsed.pathname.split('/').filter(Boolean);

    // Root URL — no warm-up needed
    if (pathParts.length === 0) {
      return { warmUpUrls: [], targetUrl };
    }

    const warmUpUrls: string[] = [];

    // Step 1: Always visit homepage first (30% chance to actually do it)
    // The homepage visit is recorded even if not executed, to build the referrer chain
    warmUpUrls.push(origin + '/');

    // Step 2: Visit parent category page if path has 2+ segments
    // e.g., /book/12345/chapter/6 → visit /book/12345/
    if (pathParts.length >= 2) {
      // Build the parent path from the first 2 segments
      const categoryPath = '/' + pathParts.slice(0, 2).join('/') + '/';
      warmUpUrls.push(origin + categoryPath);
    } else if (pathParts.length === 1) {
      // Single segment: visit the root category
      // e.g., /chapter/6 → visit /
      // Already covered by homepage
    }

    return { warmUpUrls, targetUrl };
  } catch {
    return { warmUpUrls: [], targetUrl };
  }
}

/**
 * Check if a warm-up is recommended for a URL.
 * Returns true if the URL is a "deep" page (2+ path segments)
 * and the domain hasn't been visited recently.
 */
export function shouldWarmUp(targetUrl: string, domainLastVisit: number | undefined): boolean {
  try {
    const parsed = new URL(targetUrl);
    const pathParts = parsed.pathname.split('/').filter(Boolean);

    // Deep page with 2+ path segments
    if (pathParts.length < 2) return false;

    // Domain hasn't been visited in the last 5 minutes
    if (domainLastVisit && Date.now() - domainLastVisit < 5 * 60 * 1000) {
      return false; // Recently visited, no warm-up needed
    }

    return true;
  } catch {
    return false;
  }
}

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
        for (let i = entries.length - 2; i >= 0; i--) {
          if (entries[i].url !== targetUrl) {
            return entries[i].url;
          }
        }
        return undefined;
      }
      return last.url;
    } catch {
      return undefined;
    }
  }

  /**
   * Get the timestamp of the last visit to a domain.
   * Used by shouldWarmUp() to determine if warm-up is needed.
   */
  getLastVisit(domain: string): number | undefined {
    const entries = this.history.get(domain);
    if (!entries || entries.length === 0) return undefined;
    return entries[entries.length - 1].timestamp;
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
