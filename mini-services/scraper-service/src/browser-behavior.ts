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
// Reading time = chars / chars-per-second * 1000ms + random jitter.
// Variable reading speed: shorter pages read faster, longer pages slower (logarithmic scaling)
// to avoid the "every page takes exactly the same time" detection pattern.
const CHARS_PER_SECOND_FAST = 400;  // List pages, short content
const CHARS_PER_SECOND_SLOW = 200;  // Long chapters, detailed articles
const MIN_READ_DELAY_MS = 200;           // even short pages get some delay
const MAX_READ_DELAY_MS = 6_000;         // cap at 6 seconds regardless of length
const CONTENT_LENGTH_THRESHOLD = 5000;   // chars: below = fast, above = slow (with interpolation)

// ==================== BrowserBehavior ====================

class BrowserBehavior {
  /** domain → visit record */
  private domainVisits: Map<string, DomainVisitRecord> = new Map();
  /** global request counter for human-break simulation */
  private globalRequestCount = 0;
  /** tracks request count at last break to prevent clustering */
  private lastBreakAt = 0;
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
   * Uses variable reading speed: shorter content is read faster (list pages),
   * longer content is read slower (chapter pages). The speed interpolates
   * logarithmically between CHARS_PER_SECOND_FAST and CHARS_PER_SECOND_SLOW
   * based on content length, avoiding the "every page takes exactly the same time"
   * detection pattern.
   *
   * @param url       - The URL (used for domain tracking).
   * @param htmlLength - Length of the HTML content in bytes.
   * @returns A promise that resolves after the simulated delay.
   */
  async getPreVisitDelay(url: string, htmlLength: number): Promise<void> {
    // Variable reading speed based on content length
    // Short pages (lists): 400 chars/sec, Long pages (chapters): 200 chars/sec
    // Interpolate logarithmically to avoid step-function detection
    const lengthFactor = htmlLength <= CONTENT_LENGTH_THRESHOLD
      ? 0  // Fast for short content
      : Math.min(1, Math.log2(htmlLength / CONTENT_LENGTH_THRESHOLD) / 3); // 0-1, log scale
    const charsPerSecond = CHARS_PER_SECOND_FAST + (CHARS_PER_SECOND_SLOW - CHARS_PER_SECOND_FAST) * lengthFactor;

    // Base delay: proportional to content length
    const readTimeMs = (htmlLength / charsPerSecond) * 1000;

    // Add ±25% jitter to avoid exact timing fingerprints (slightly wider than before)
    const jitterFactor = 0.75 + Math.random() * 0.5;
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
    const sinceLastBreak = this.globalRequestCount - this.lastBreakAt;
    if (sinceLastBreak >= this.breakThreshold) {
      const delay = BREAK_DELAY_MIN_MS + Math.random() * (BREAK_DELAY_MAX_MS - BREAK_DELAY_MIN_MS);
      log.info(` Human break pause: ${Math.round(delay)}ms after ${this.globalRequestCount} requests (${url})`);
      await new Promise<void>((resolve) => setTimeout(resolve, Math.round(delay)));
      // Re-randomize threshold for next break
      this.breakThreshold = BREAK_EVERY_MIN + Math.floor(Math.random() * (BREAK_EVERY_MAX - BREAK_EVERY_MIN + 1));
      this.lastBreakAt = this.globalRequestCount;
    }
  }

  /**
   * Reset all state (useful for testing or new scraping sessions).
   */
  reset(): void {
    this.domainVisits.clear();
    this.globalRequestCount = 0;
    this.lastBreakAt = 0;
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
      // Break triggers when globalRequestCount - lastBreakAt >= breakThreshold,
      // so next break is expected at lastBreakAt + breakThreshold.
      // If <= globalRequestCount, the break is overdue (will trigger on next call).
      nextBreakAt = this.lastBreakAt + this.breakThreshold;
    }
    return {
      domainsTracked: this.domainVisits.size,
      globalRequestCount: this.globalRequestCount,
      domainsRootsVisited: this.domainRootsVisited.size,
      nextBreakAt,
    };
  }
}

// ==================== Timing Fingerprint Resistance ====================

/** A point in a mouse movement path */
export interface MouseMovementPoint {
  x: number;
  y: number;
  /** Timestamp offset in ms from the start of the movement */
  t: number;
}

/** Punctuation characters that trigger a typing pause */
const PUNCTUATION_SET = new Set([',', ';', ':', '-', '–']);
/** Sentence-ending characters that trigger a longer pause */
const SENTENCE_END_SET = new Set(['.', '!', '?', '。', '！', '？']);

/**
 * Generate a realistic delay (ms) for typing a single character.
 *
 * Real human typing patterns:
 *   - Base delay: 50-150ms per character (varies by character difficulty)
 *   - Pause after punctuation (comma, semicolon): 200-500ms
 *   - Pause after sentence end (period, exclamation): 400-800ms
 *   - Occasional longer pause (backspace simulation): 300-600ms with 10% probability
 *
 * @param char - The character being typed (used to determine pause category)
 * @returns Delay in milliseconds
 */
export function generateRealisticTypingDelay(char: string): number {
  // 10% chance of a backspace-simulation pause (regardless of character)
  if (Math.random() < 0.10) {
    return 300 + Math.random() * 300; // 300-600ms
  }

  if (SENTENCE_END_SET.has(char)) {
    return 400 + Math.random() * 400; // 400-800ms
  }

  if (PUNCTUATION_SET.has(char)) {
    return 200 + Math.random() * 300; // 200-500ms
  }

  // Normal character: 50-150ms base delay
  return 50 + Math.random() * 100;
}

/**
 * Generate a realistic mouse movement path using cubic Bezier interpolation.
 *
 * Simulates human mouse movement with:
 *   - Bezier curve interpolation (not a straight line)
 *   - Variable speed (slower at start/end, faster in middle — ease-in-out)
 *   - Subtle random jitter (±2px)
 *   - Occasional overshoot + correction (20% probability)
 *   - Micro-pause near the target (simulates homing behavior)
 *
 * The returned array of {x, y, t} points can be used to drive Playwright/Obscura
 * mouse.move() calls with realistic timing.
 *
 * @param startX - Starting X coordinate
 * @param startY - Starting Y coordinate
 * @param endX   - Ending X coordinate
 * @param endY   - Ending Y coordinate
 * @returns Array of {x, y, t} points representing the mouse path
 */
export function generateMouseMovementPath(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): MouseMovementPoint[] {
  const dx = endX - startX;
  const dy = endY - startY;
  const distance = Math.sqrt(dx * dx + dy * dy);

  // Determine number of steps based on distance (min 5, max 50, ~12px per step)
  const numSteps = Math.max(5, Math.min(50, Math.round(distance / 12)));

  // Bezier control points: offset perpendicular to the line for a natural curve
  // The offset direction and magnitude are randomized
  const perpX = -dy / (distance || 1);
  const perpY = dx / (distance || 1);
  const curvature = (Math.random() - 0.5) * 0.3 * distance;

  // Occasional overshoot: 20% chance to overshoot the target by 5-15px then correct
  const shouldOvershoot = Math.random() < 0.2;
  const overshootDist = shouldOvershoot ? (5 + Math.random() * 10) : 0;

  const cp1x = startX + dx * 0.3 + perpX * curvature;
  const cp1y = startY + dy * 0.3 + perpY * curvature;
  const cp2x = startX + dx * 0.7 - perpX * curvature * 0.5;
  const cp2y = startY + dy * 0.7 - perpY * curvature * 0.5;

  const points: MouseMovementPoint[] = [];
  let cumulativeTime = 0;

  // Base duration: ~3-6ms per pixel of distance, capped between 100-800ms
  const baseDuration = Math.max(100, Math.min(800, distance * 4));

  for (let i = 0; i <= numSteps; i++) {
    const t = i / numSteps;
    const t2 = t * t;
    const t3 = t2 * t;
    const mt = 1 - t;
    const mt2 = mt * mt;
    const mt3 = mt2 * mt;

    // Cubic Bezier interpolation
    let x = mt3 * startX + 3 * mt2 * t * cp1x + 3 * mt * t2 * cp2x + t3 * endX;
    let y = mt3 * startY + 3 * mt2 * t * cp1y + 3 * mt * t2 * cp2y + t3 * endY;

    // Add subtle jitter (±2px), less at endpoints
    const jitterScale = t > 0.05 && t < 0.95 ? 1.0 : 0.3;
    x += (Math.random() - 0.5) * 4 * jitterScale;
    y += (Math.random() - 0.5) * 4 * jitterScale;

    // Ease-in-out timing: slower at start/end, faster in middle
    // Using smoothstep: 3t² - 2t³
    const easedT = t2 * 3 - t3 * 2;
    let timeDelta: number;
    if (i === 0) {
      timeDelta = 0;
    } else {
      const prevT = (i - 1) / numSteps;
      const prevEased = 3 * prevT * prevT - 2 * prevT * prevT * prevT;
      timeDelta = (easedT - prevEased) * baseDuration;
    }
    cumulativeTime += Math.max(0, timeDelta);

    points.push({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, t: Math.round(cumulativeTime) });
  }

  // Ensure the last point exactly matches the target (correct for any Bezier drift)
  const last = points[points.length - 1];
  if (last) {
    last.x = endX;
    last.y = endY;
  }

  // Add overshoot + correction if applicable
  if (shouldOvershoot && overshootDist > 0) {
    // Overshoot point: go past the target
    const overshootX = endX + (dx / (distance || 1)) * overshootDist;
    const overshootY = endY + (dy / (distance || 1)) * overshootDist;
    const lastTime = points[points.length - 1]?.t || 0;
    points.push({ x: Math.round(overshootX * 10) / 10, y: Math.round(overshootY * 10) / 10, t: lastTime + 30 + Math.round(Math.random() * 20) });
    // Correction: move back to target
    points.push({ x: endX, y: endY, t: lastTime + 80 + Math.round(Math.random() * 40) });
  }

  return points;
}

// ==================== Resource Loading Order Simulation ====================

/**
 * Resource loading order simulation.
 *
 * Real browsers load resources in a specific order:
 *   1. HTML document (first)
 *   2. CSS stylesheets (render-blocking)
 *   3. JavaScript (parser-blocking or async)
 *   4. Images (progressive)
 *   5. Fonts (after CSS)
 *
 * Anti-bot systems can detect when all resources are requested
 * simultaneously or in an unusual order. This module provides
 * inter-resource delays that simulate natural loading order.
 */

export interface ResourceLoadDelay {
  /** Resource type */
  type: 'css' | 'js' | 'image' | 'font' | 'other';
  /** Simulated delay before requesting this resource type (ms) */
  delayMs: number;
  /** Reason for the delay */
  reason: string;
}

/**
 * Get realistic inter-resource delays for a page load.
 * These delays should be applied between sequential resource requests.
 *
 * @returns Array of resource load delays in natural order
 */
export function getResourceLoadOrder(): ResourceLoadDelay[] {
  return [
    { type: 'css', delayMs: 50 + Math.round(Math.random() * 100), reason: 'CSS is render-blocking, loaded right after HTML' },
    { type: 'js', delayMs: 150 + Math.round(Math.random() * 300), reason: 'JS loaded after CSS (parser-blocking)' },
    { type: 'font', delayMs: 200 + Math.round(Math.random() * 200), reason: 'Fonts triggered by CSS @font-face' },
    { type: 'image', delayMs: 300 + Math.round(Math.random() * 500), reason: 'Images loaded progressively after above resources' },
    { type: 'other', delayMs: 100 + Math.round(Math.random() * 200), reason: 'Other resources loaded last' },
  ];
}

/**
 * Get the delay before requesting a specific resource type.
 *
 * @param resourceType - Type of resource being requested
 * @param isFirstResource - Whether this is the first resource of this type
 * @returns Delay in milliseconds
 */
export function getResourceDelay(resourceType: 'css' | 'js' | 'image' | 'font' | 'other', isFirstResource: boolean = true): number {
  const order = getResourceLoadOrder();
  const entry = order.find(r => r.type === resourceType) || order.find(r => r.type === 'other')!;

  if (!isFirstResource) {
    // Subsequent resources of same type have shorter delays
    return Math.round(entry.delayMs * (0.2 + Math.random() * 0.3));
  }
  return entry.delayMs;
}

// Singleton export
export const browserBehavior = new BrowserBehavior();

// ==================== Cookie Consent Auto-Acceptance ====================

/**
 * CSS selectors for common cookie consent/GDPR banner elements.
 * Used by Playwright-based engines to auto-accept cookie consent,
 * preventing banners from blocking content extraction.
 */
export const COOKIE_CONSENT_SELECTORS: string[] = [
  // Common consent button patterns
  'button[id*="accept"]',
  'button[class*="accept"]',
  'button[class*="agree"]',
  'button[class*="consent"]',
  'button[class*="allow"]',
  'a[class*="accept"]',
  'a[id*="accept"]',
  '.cookie-accept',
  '.cookie-consent-accept',
  '#cookie-accept',
  '#accept-cookies',
  // GDPR/CCPA specific
  '[class*="gdpr"] button',
  '[class*="ccpa"] button',
  '#onetrust-accept-btn-handler',
  '.otCenterRounded .accept-btn',
  // Chinese site consent patterns
  'a:contains("同意")',
  'button:contains("同意")',
  'a:contains("接受")',
  'button:contains("接受")',
  'a:contains("确定")',
  'button:contains("确定")',
  'a:contains("我知道了")',
  'button:contains("我知道了")',
  // English patterns
  'button:contains("Accept")',
  'button:contains("Accept All")',
  'button:contains("I Agree")',
  'button:contains("OK")',
  'button:contains("Got it")',
  'a:contains("Accept")',
];

/**
 * Generate a "human reading pattern" scroll sequence with natural pauses.
 * Unlike the basic generateScrollSequence(), this produces a more realistic
 * pattern that includes:
 *   - Initial pause at the top (reading the title/hero area)
 *   - Variable scroll speeds (fast for known-layout pages, slow for text-heavy pages)
 *   - Micro-scroll-backs (re-reading a paragraph)
 *   - Longer pauses at section boundaries
 *   - Gradual slowdown near the bottom (losing interest)
 *
 * @param pageHeight - Total scrollable page height in pixels
 * @param isTextHeavy - Whether the page is text-heavy (novel chapter) vs list/grid
 * @returns Array of scroll steps with delays
 */
export function generateHumanReadingScroll(pageHeight: number, isTextHeavy: boolean = false): ScrollStep[] {
  if (pageHeight <= 0) return [{ y: 0, delayMs: 0 }];

  const steps: ScrollStep[] = [];

  // 1. Initial pause at top — reading the title/header area
  steps.push({
    y: 0,
    delayMs: isTextHeavy ? (800 + Math.round(Math.random() * 1200)) : (300 + Math.round(Math.random() * 500)),
  });

  // 2. First scroll — past the hero/header to the content
  const firstScroll = isTextHeavy ? 200 : 400;
  steps.push({
    y: firstScroll,
    delayMs: isTextHeavy ? (1000 + Math.round(Math.random() * 1500)) : (400 + Math.round(Math.random() * 600)),
  });

  let currentY = firstScroll;
  const targetY = Math.round(pageHeight * (isTextHeavy ? (0.85 + Math.random() * 0.1) : (0.6 + Math.random() * 0.25)));

  // 3. Main reading scroll — variable step size based on content type
  while (currentY < targetY) {
    // Text-heavy: small steps (reading line by line), List: large steps (scanning)
    const baseStep = isTextHeavy ? (80 + Math.round(Math.random() * 120)) : (200 + Math.round(Math.random() * 300));

    // Gradual slowdown near the bottom (losing interest)
    const progressRatio = currentY / targetY;
    const slowdownFactor = progressRatio > 0.7 ? (1.5 - progressRatio) : 1.0;

    const stepSize = Math.round(baseStep * slowdownFactor);

    // 15% chance of micro-scroll-back (re-reading)
    if (Math.random() < 0.15 && currentY > 100) {
      const backAmount = isTextHeavy ? (30 + Math.round(Math.random() * 50)) : (50 + Math.round(Math.random() * 100));
      currentY = Math.max(0, currentY - backAmount);
      steps.push({ y: currentY, delayMs: 200 + Math.round(Math.random() * 400) });
      // Then scroll forward past the previous position
      currentY = Math.min(targetY, currentY + stepSize + backAmount);
    } else {
      currentY = Math.min(targetY, currentY + stepSize);
    }

    // Reading delay at each position
    const baseDelay = isTextHeavy ? (500 + Math.round(Math.random() * 1000)) : (200 + Math.round(Math.random() * 400));
    // Longer pause at section boundaries (every ~1000px)
    const sectionPause = currentY % 1000 < stepSize ? (300 + Math.round(Math.random() * 500)) : 0;

    steps.push({ y: currentY, delayMs: baseDelay + sectionPause });
  }

  return steps;
}

// ==================== Scroll Simulation ====================

/**
 * Generate a sequence of scroll positions simulating a human reading a page.
 * Used with Playwright page.evaluate() to simulate scroll-before-click behavior.
 *
 * The scroll pattern:
 *   - Starts at top (0)
 *   - Scrolls down in variable steps (100-400px per step)
 *   - Pauses at each step (200-600ms) to simulate reading
 *   - Occasionally scrolls back up slightly (10% chance, 50-150px)
 *   - Total scroll distance is proportional to page height
 *
 * @param pageHeight - Total scrollable page height in pixels
 * @param maxSteps   - Maximum scroll steps (default: 10)
 * @returns Array of { y, delayMs } scroll positions with delays
 */
export interface ScrollStep {
  y: number;
  delayMs: number;
}

export function generateScrollSequence(pageHeight: number, maxSteps: number = 10): ScrollStep[] {
  if (pageHeight <= 0) return [{ y: 0, delayMs: 0 }];

  const steps: ScrollStep[] = [{ y: 0, delayMs: 100 + Math.round(Math.random() * 200) }];
  let currentY = 0;

  // Determine total scroll coverage (60-90% of page height - humans rarely scroll to very bottom)
  const coverage = 0.6 + Math.random() * 0.3;
  const targetY = Math.round(pageHeight * coverage);

  const actualSteps = Math.min(maxSteps, Math.max(3, Math.round(targetY / 250)));

  for (let i = 0; i < actualSteps && currentY < targetY; i++) {
    // Variable scroll step: 100-400px
    const stepSize = 100 + Math.round(Math.random() * 300);

    // 10% chance to scroll back up slightly (re-reading)
    if (Math.random() < 0.1 && currentY > 50) {
      const backAmount = 50 + Math.round(Math.random() * 100);
      currentY = Math.max(0, currentY - backAmount);
      steps.push({ y: currentY, delayMs: 150 + Math.round(Math.random() * 200) });
    }

    currentY = Math.min(targetY, currentY + stepSize);
    // Reading delay at each scroll position: 200-600ms
    steps.push({ y: currentY, delayMs: 200 + Math.round(Math.random() * 400) });
  }

  return steps;
}

// ==================== Request Order Randomization ====================

/**
 * Shuffle an array of URLs or chapter indices using Fisher-Yates algorithm.
 * Instead of always scraping chapter 1, 2, 3... in order, randomize the
 * order to avoid sequential access patterns that are detectable.
 *
 * @param items - Array of items to shuffle
 * @returns New array with items in randomized order
 */
export function shuffleRequestOrder<T>(items: T[]): T[] {
  if (items.length <= 1) return [...items];

  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Generate a "natural" chapter reading order that isn't purely sequential.
 * Simulates how a human might jump between chapters (e.g., read 1, then 3,
 * then back to 2, then 5, etc.) while still covering all chapters.
 *
 * Strategy: Start with first chapter, then add small random jumps (±1-3),
 * filling in gaps at the end. This creates a pattern that looks like
 * "skip-reading" rather than systematic sequential scraping.
 *
 * @param totalChapters - Total number of chapters
 * @param startFrom    - Chapter to start from (default: 1)
 * @returns Array of chapter numbers in "natural" reading order
 */
export function generateNaturalReadingOrder(totalChapters: number, startFrom: number = 1): number[] {
  if (totalChapters <= 2) return Array.from({ length: totalChapters }, (_, i) => startFrom + i);

  const visited = new Set<number>();
  const order: number[] = [];
  let current = startFrom;

  // Always start with the first chapter
  visited.add(current);
  order.push(current);

  for (let i = 1; i < totalChapters; i++) {
    // 70% chance: advance forward with small random skip (1-3 chapters)
    // 20% chance: go back to a skipped chapter
    // 10% chance: jump forward by a larger amount (4-6)
    const r = Math.random();
    let next: number;

    if (r < 0.7) {
      // Forward with small skip
      const skip = 1 + Math.floor(Math.random() * 3);
      next = current + skip;
    } else if (r < 0.9) {
      // Back to a skipped chapter (if any)
      const skipped = Array.from({ length: totalChapters }, (_, i) => startFrom + i)
        .filter(n => !visited.has(n));
      if (skipped.length > 0) {
        next = skipped[Math.floor(Math.random() * skipped.length)];
      } else {
        next = current + 1;
      }
    } else {
      // Larger forward jump
      next = current + 4 + Math.floor(Math.random() * 3);
    }

    // Clamp to valid range
    next = Math.max(startFrom, Math.min(startFrom + totalChapters - 1, next));

    // If already visited, find nearest unvisited
    if (visited.has(next)) {
      for (let offset = 1; offset <= totalChapters; offset++) {
        const candidates = [next + offset, next - offset].filter(
          n => n >= startFrom && n < startFrom + totalChapters && !visited.has(n)
        );
        if (candidates.length > 0) {
          next = candidates[Math.floor(Math.random() * candidates.length)];
          break;
        }
      }
    }

    if (!visited.has(next)) {
      visited.add(next);
      order.push(next);
    }
    current = next;
  }

  // Fill any remaining unvisited chapters
  for (let i = startFrom; i < startFrom + totalChapters; i++) {
    if (!visited.has(i)) {
      order.push(i);
    }
  }

  return order;
}

