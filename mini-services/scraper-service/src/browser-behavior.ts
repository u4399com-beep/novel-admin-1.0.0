/**
 * Browser Behavior Simulation
 *
 * Simulates realistic browsing patterns at the navigation level to defeat
 * behavioral analysis systems that detect automated scraping.
 *
 * Features:
 *   - Scroll/reading delay simulation based on content length
 *   - Per-domain visit frequency throttling (max 3 visits per 10s window)
 *   - Periodic human-break pauses (every 5-10 requests, 8-15s delay)
 *   - Entry page simulation (10% chance to visit domain root first)
 */

// ==================== Types ====================

interface DomainVisitRecord {
  timestamps: number[];  // recent visit timestamps
  totalVisits: number;  // total requests in current "session burst"
}

type ThrottleResult =
  | { throttled: false }
  | { throttled: true; waitMs: number };

// ==================== Constants ====================

const MAX_VISITS_PER_10S = 3;
const VISIT_WINDOW_MS = 10_000;          // 10 seconds
const BREAK_EVERY_MIN = 5;               // take a break every 5 requests
const BREAK_EVERY_MAX = 10;              // at most every 10 requests
const BREAK_DELAY_MIN_MS = 8_000;        // 8 seconds
const BREAK_DELAY_MAX_MS = 15_000;       // 15 seconds
const ENTRY_PAGE_CHANCE = 0.10;          // 10% chance

// Bounds to prevent unbounded memory growth in long-running sessions
const MAX_TRACKED_DOMAINS = 500;

// Reading speed: average 200-300 words per minute for Chinese text.
// Chinese characters ~1.5 bytes each. A chapter of 5000 chars ≈ 2000 words.
// Reading time = chars / 300 chars-per-second * 1000ms + random jitter.
const CHARS_PER_SECOND = 300;
const MIN_READ_DELAY_MS = 200;           // even short pages get some delay
const MAX_READ_DELAY_MS = 4_000;         // cap at 4 seconds regardless of length

// ==================== BrowserBehavior ====================

class BrowserBehavior {
  /** domain → visit record */
  private domainVisits: Map<string, DomainVisitRecord> = new Map();
  /** global request counter for human-break simulation */
  private globalRequestCount = 0;
  /** domains already visited (for entry page check) */
  private domainRootsVisited: Set<string> = new Set();

  // ---- Public API ----

  /**
   * Check if a request to `domain` should be throttled due to too-frequent visits.
   *
   * Rules:
   *   - No more than 3 visits to the same domain within a 10-second window.
   *   - If throttled, returns the number of milliseconds to wait.
   *
   * @param domain - The target domain hostname.
   */
  /** Evict oldest domain from tracking maps if at capacity */
  private evictIfNeeded(): void {
    while (this.domainVisits.size >= MAX_TRACKED_DOMAINS) {
      // Delete the first (oldest-inserted) domain
      const firstKey = this.domainVisits.keys().next().value;
      if (firstKey) {
        this.domainVisits.delete(firstKey);
        this.domainRootsVisited.delete(firstKey);
      } else break;
    }
  }

  shouldThrottle(domain: string): ThrottleResult {
    if (!domain) return { throttled: false };

    const now = Date.now();
    let record = this.domainVisits.get(domain);
    if (!record) {
      this.evictIfNeeded();
      record = { timestamps: [], totalVisits: 0 };
      this.domainVisits.set(domain, record);
    }

    // Prune timestamps outside the window
    record.timestamps = record.timestamps.filter(ts => now - ts < VISIT_WINDOW_MS);

    if (record.timestamps.length >= MAX_VISITS_PER_10S) {
      // Wait until the oldest timestamp in the window expires
      const oldest = record.timestamps[0];
      const waitMs = (oldest + VISIT_WINDOW_MS) - now + 100; // +100ms buffer
      return { throttled: true, waitMs: Math.max(waitMs, 500) };
    }

    return { throttled: false };
  }

  /**
   * Record that a request to `domain` is about to be made.
   * Call this AFTER shouldThrottle() passes, before the actual fetch.
   */
  recordRequest(domain: string): void {
    if (!domain) return;
    const record = this.domainVisits.get(domain);
    if (record) {
      record.timestamps.push(Date.now());
      record.totalVisits++;
    }
    this.globalRequestCount++;
  }

  /**
   * Get a realistic pre-extraction delay based on the HTML content length.
   * Simulates the time a human would spend "reading" or scrolling a page
   * before performing the next action.
   *
   * @param url       - The URL (used for domain tracking).
   * @param htmlLength - Length of the HTML content in bytes.
   * @returns A promise that resolves after the simulated delay.
   */
  async getPreVisitDelay(url: string, htmlLength: number): Promise<void> {
    // Base delay: proportional to content length
    // Assume 1 char ≈ 1 byte for HTML (rough but sufficient)
    const readTimeMs = (htmlLength / CHARS_PER_SECOND) * 1000;

    // Add ±20% jitter to avoid exact timing fingerprints
    const jitterFactor = 0.8 + Math.random() * 0.4;
    const delayMs = Math.min(MAX_READ_DELAY_MS, Math.max(MIN_READ_DELAY_MS, readTimeMs * jitterFactor));

    await new Promise<void>((resolve) => setTimeout(resolve, Math.round(delayMs)));

    // After the reading delay, check if we need a human break
    await this.maybeHumanBreak(url);
  }

  /**
   * With a 10% probability, return the domain root URL to visit first.
   * This simulates a user navigating from the homepage to the target page.
   *
   * Only triggers once per domain (first time visiting that domain).
   *
   * @param domain  - The target domain hostname.
   * @param rootUrl - The domain root URL (e.g. "https://example.com/").
   * @returns The root URL to pre-visit, or null if no pre-visit needed.
   */
  maybeVisitEntryPage(domain: string, rootUrl: string): string | null {
    if (!domain || !rootUrl) return null;

    // Already visited this domain's root — don't do it again
    if (this.domainRootsVisited.has(domain)) return null;

    // Capacity guard: prevent unbounded growth
    if (this.domainRootsVisited.size >= MAX_TRACKED_DOMAINS && !this.domainRootsVisited.has(domain)) {
      return null;
    }

    // 10% chance to simulate entry page visit
    if (Math.random() < ENTRY_PAGE_CHANCE) {
      this.domainRootsVisited.add(domain);
      return rootUrl;
    }

    // Mark as visited even if we didn't pre-visit (to avoid re-checking)
    this.domainRootsVisited.add(domain);
    return null;
  }

  // ---- Private Helpers ----

  /**
   * Simulate a human break: pause 8-15 seconds after every 5-10 requests.
   * The break threshold is randomized at startup to avoid predictable patterns.
   */
  private breakThreshold = BREAK_EVERY_MIN + Math.floor(Math.random() * (BREAK_EVERY_MAX - BREAK_EVERY_MIN + 1));

  private async maybeHumanBreak(url: string): Promise<void> {
    if (this.globalRequestCount > 0 && this.globalRequestCount % this.breakThreshold === 0) {
      const delay = BREAK_DELAY_MIN_MS + Math.random() * (BREAK_DELAY_MAX_MS - BREAK_DELAY_MIN_MS);
      console.log(`[BrowserBehavior] Human break pause: ${Math.round(delay)}ms after ${this.globalRequestCount} requests (${url})`);
      await new Promise<void>((resolve) => setTimeout(resolve, Math.round(delay)));
      // Re-randomize threshold for next break
      this.breakThreshold = BREAK_EVERY_MIN + Math.floor(Math.random() * (BREAK_EVERY_MAX - BREAK_EVERY_MIN + 1));
    }
  }

  /**
   * Reset all state (useful for testing or new scraping sessions).
   */
  reset(): void {
    this.domainVisits.clear();
    this.globalRequestCount = 0;
    this.domainRootsVisited.clear();
    this.breakThreshold = BREAK_EVERY_MIN + Math.floor(Math.random() * (BREAK_EVERY_MAX - BREAK_EVERY_MIN + 1));
  }

  /**
   * Get stats about browser behavior simulation.
   */
  getStats(): {
    domainsTracked: number;
    globalRequestCount: number;
    domainsRootsVisited: number;
    nextBreakAt: number;
  } {
    let nextBreakAt: number;
    if (this.globalRequestCount === 0) {
      nextBreakAt = this.breakThreshold;
    } else {
      const remaining = this.breakThreshold - (this.globalRequestCount % this.breakThreshold);
      nextBreakAt = this.globalRequestCount + remaining;
    }
    return {
      domainsTracked: this.domainVisits.size,
      globalRequestCount: this.globalRequestCount,
      domainsRootsVisited: this.domainRootsVisited.size,
      nextBreakAt,
    };
  }
}

// Singleton export
export const browserBehavior = new BrowserBehavior();
