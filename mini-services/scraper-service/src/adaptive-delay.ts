/**
 * Adaptive Delay Strategy
 * Per-domain delay management with automatic backoff on errors
 * and gradual recovery on success.
 */

// ==================== Types ====================

export interface DelayConfig {
  baseMin: number;            // default 1000ms
  baseMax: number;            // default 3000ms
  backoffFactor: number;      // default 2.0
  maxBackoff: number;         // default 60000ms (1min)
  errorThreshold: number;     // errors before backoff kicks in (default 3)
  responseTimeThreshold: number; // ms, if response takes longer, increase delay (default 5000)
}

interface DomainState {
  consecutiveErrors: number;
  lastResponseTimes: number[];  // last 10 response times
  currentBackoffLevel: number;  // exponential backoff multiplier
  lastRequestTime: number;      // timestamp
}

export interface DomainStats {
  domain: string;
  currentDelay: number;        // estimated next delay in ms
  backoffLevel: number;        // exponential backoff exponent
  consecutiveErrors: number;
  avgResponseTime: number;     // ms, 0 if no data
  lastRequestTime: number;     // timestamp
  status: 'normal' | 'warning' | 'backoff' | 'critical';
}

const DEFAULT_CONFIG: DelayConfig = {
  baseMin: 1000,
  baseMax: 3000,
  backoffFactor: 2.0,
  maxBackoff: 60000,
  errorThreshold: 3,
  responseTimeThreshold: 5000,
};

const MAX_RESPONSE_HISTORY = 10;
const MAX_DOMAINS = 500;

// ==================== AdaptiveDelayManager ====================

class AdaptiveDelayManager {
  private domains = new Map<string, DomainState>();
  private domainAccessOrder = new Map<string, true>(); // For LRU eviction (insertion-ordered Map)
  private config: DelayConfig;
  private static instance: AdaptiveDelayManager;

  private constructor(config?: Partial<DelayConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  static getInstance(config?: Partial<DelayConfig>): AdaptiveDelayManager {
    if (!AdaptiveDelayManager.instance) {
      AdaptiveDelayManager.instance = new AdaptiveDelayManager(config);
    }
    return AdaptiveDelayManager.instance;
  }

  /**
   * Get the delay for the next request to a given domain.
   * Factors in: base delay, error backoff, slow response penalty, random jitter.
   * @deprecated Use getDelaySync() instead; this async version is kept for backward compatibility.
   */
  getDelay(domain: string): number {
    return this.getDelaySync(domain);
  }

  /**
   * Synchronous version of getDelay.
   */
  getDelaySync(domain: string): number {
    const state = this.getOrCreateDomain(domain);

    // Base delay (guard against misconfigured baseMax < baseMin)
    const range = Math.max(0, this.config.baseMax - this.config.baseMin);
    const baseDelay = this.config.baseMin + Math.random() * range;

    // Error backoff multiplier
    let backoffMultiplier = 1;
    if (state.consecutiveErrors >= this.config.errorThreshold) {
      const excessErrors = state.consecutiveErrors - this.config.errorThreshold + 1;
      backoffMultiplier = Math.pow(this.config.backoffFactor, excessErrors);
    }

    // Anti-crawl backoff level (set by 429/403/503 responses)
    // This provides additional aggressive backoff on top of error-based backoff
    const antiCrawlMultiplier = Math.pow(this.config.backoffFactor, state.currentBackoffLevel);

    // Slow response penalty (require >= 3 samples to avoid false positives)
    let slowPenalty = 1;
    if (state.lastResponseTimes.length >= 3) {
      const avgResponseTime = state.lastResponseTimes.reduce((a, b) => a + b, 0) / state.lastResponseTimes.length;
      if (avgResponseTime > this.config.responseTimeThreshold) {
        slowPenalty = 1.5;
      }
    }

    // Calculate raw delay
    let delay = baseDelay * backoffMultiplier * antiCrawlMultiplier * slowPenalty;

    // Apply jitter ±20%
    const jitter = 0.8 + Math.random() * 0.4;
    delay = delay * jitter;

    // Cap at maxBackoff
    delay = Math.min(delay, this.config.maxBackoff);

    // Minimum 100ms
    delay = Math.max(delay, 100);

    return Math.round(delay);
  }

  /**
   * Record the outcome of a request to a domain.
   * Adjusts backoff levels and response time tracking.
   */
  recordResponse(domain: string, responseTime: number, success: boolean, statusCode?: number): void {
    const state = this.getOrCreateDomain(domain);
    state.lastRequestTime = Date.now();

    // Track response time (rolling window of last 10)
    state.lastResponseTimes.push(responseTime);
    if (state.lastResponseTimes.length > MAX_RESPONSE_HISTORY) {
      state.lastResponseTimes.shift();
    }

    if (success) {
      // On success: reduce consecutive errors gradually
      if (state.consecutiveErrors > 0) {
        // Reduce by 1 (not reset to 0) to allow gradual recovery
        state.consecutiveErrors = Math.max(0, state.consecutiveErrors - 1);
      }
      // If we've been error-free for a while, reduce backoff level
      if (state.consecutiveErrors === 0 && state.currentBackoffLevel > 0) {
        state.currentBackoffLevel = Math.max(0, state.currentBackoffLevel - 1);
      }
    } else {
      // On error: increase consecutive errors
      state.consecutiveErrors++;

      // Special handling for anti-crawl status codes
      const isAntiCrawl = statusCode === 429 || statusCode === 403 || statusCode === 503;
      if (isAntiCrawl) {
        // Aggressive backoff for anti-crawl responses
        state.consecutiveErrors = Math.max(state.consecutiveErrors, this.config.errorThreshold);
        state.currentBackoffLevel = Math.min(
          state.currentBackoffLevel + 2,
          10 // Cap backoff level
        );
      }
    }
  }

  /** Get current delay/backoff state for a specific domain */
  getDomainStats(domain: string): DomainStats {
    const state = this.getOrCreateDomain(domain);
    const avgResponseTime = state.lastResponseTimes.length > 0
      ? Math.round(state.lastResponseTimes.reduce((a, b) => a + b, 0) / state.lastResponseTimes.length)
      : 0;

    // Estimate current delay (includes antiCrawlMultiplier like getDelaySync)
    const baseDelay = (this.config.baseMin + this.config.baseMax) / 2;
    let backoffMultiplier = 1;
    if (state.consecutiveErrors >= this.config.errorThreshold) {
      const excessErrors = state.consecutiveErrors - this.config.errorThreshold + 1;
      backoffMultiplier = Math.pow(this.config.backoffFactor, excessErrors);
    }
    // Include antiCrawlMultiplier (was missing before — stats showed incorrect delay)
    const antiCrawlMultiplier = Math.pow(this.config.backoffFactor, state.currentBackoffLevel);
    let slowPenalty = 1;
    if (state.lastResponseTimes.length >= 3) {
      const avg = state.lastResponseTimes.reduce((a, b) => a + b, 0) / state.lastResponseTimes.length;
      if (avg > this.config.responseTimeThreshold) {
        slowPenalty = 1.5;
      }
    }
    const currentDelay = Math.min(Math.round(baseDelay * backoffMultiplier * antiCrawlMultiplier * slowPenalty), this.config.maxBackoff);

    // Determine status
    let status: DomainStats['status'] = 'normal';
    if (state.consecutiveErrors >= this.config.errorThreshold * 3) {
      status = 'critical';
    } else if (state.consecutiveErrors >= this.config.errorThreshold) {
      status = 'backoff';
    } else if (state.consecutiveErrors > 0 || slowPenalty > 1) {
      status = 'warning';
    }

    return {
      domain,
      currentDelay,
      backoffLevel: state.currentBackoffLevel,
      consecutiveErrors: state.consecutiveErrors,
      avgResponseTime,
      lastRequestTime: state.lastRequestTime,
      status,
    };
  }

  /** Get stats for all tracked domains */
  getAllDomainStats(): DomainStats[] {
    const stats: DomainStats[] = [];
    for (const domain of this.domains.keys()) {
      stats.push(this.getDomainStats(domain));
    }
    // Sort by last request time (most recent first)
    stats.sort((a, b) => b.lastRequestTime - a.lastRequestTime);
    return stats;
  }

  /** Reset backoff to base level for a specific domain */
  resetDomain(domain: string): void {
    this.domains.delete(domain);
    this.domainAccessOrder.delete(domain);
  }

  /** Get number of tracked domains */
  size(): number {
    return this.domains.size;
  }

  private getOrCreateDomain(domain: string): DomainState {
    let state = this.domains.get(domain);
    if (!state) {
      // LRU eviction when at capacity
      if (this.domains.size >= MAX_DOMAINS) {
        const oldest = this.domainAccessOrder.keys().next().value;
        if (oldest) this.domainAccessOrder.delete(oldest);
        if (oldest) this.domains.delete(oldest);
      }
      state = {
        consecutiveErrors: 0,
        lastResponseTimes: [],
        currentBackoffLevel: 0,
        lastRequestTime: 0,
      };
      this.domains.set(domain, state);
    }
    // Update access order for LRU (delete and re-insert moves to end)
    this.domainAccessOrder.delete(domain);
    this.domainAccessOrder.set(domain, true);
    return state;
  }
}

// Singleton export
export const adaptiveDelay = AdaptiveDelayManager.getInstance();

// ==================== Human-Like Browsing Simulation ====================

/**
 * Simulates human-like delays between page navigations.
 * Provides reading time simulation, micro-delays (mouse-move/think),
 * and occasional long pauses that real users exhibit.
 */

interface BrowsingSessionState {
  /** Number of requests made in current session for this domain */
  requestCount: number;
  /** When the next "reading pause" should trigger */
  nextPauseAt: number;
}

const browsingSessions = new Map<string, BrowsingSessionState>();
const MAX_BROWSING_SESSIONS = 200;

/**
 * Detect if a URL likely points to a content/detail page (longer reading time)
 * vs a list/catalog page (shorter reading time).
 *
 * Heuristics:
 * - Content pages: contains chapter/article/post detail patterns, fewer path segments
 * - List pages: contains list/catalog/index/page patterns, or has query params (pagination)
 */
export function isContentPage(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();

    // List/catalog indicators
    if (/\b(list|catalog|index|category|tag|archive|page|sort)\b/.test(path)) return false;
    if (/\d+\.html?$/.test(path) && /\/(\d{1,4})\/?$/.test(path)) return false;
    if (parsed.searchParams.has('page') || parsed.searchParams.has('p')) return false;

    // Content/detail indicators
    if (/\b(chapter|article|post|read|detail|content|book|novel)\b/.test(path)) return true;
    // Numeric path segments (e.g., /book/12345 or /chapter/6789)
    if (/\/(\d{4,})\/?$/.test(path)) return true;
    // Paths with Chinese chapter patterns
    if (/第\d+/.test(path)) return true;

    // Default: assume list page
    return false;
  } catch {
    return false;
  }
}

/**
 * Returns a human-like "think/mouse-move" delay (200-800ms).
 * Simulates the time a human takes to move the mouse, scroll, or decide
 * to click the next link.
 */
export function getMouseMoveDelay(): number {
  return 200 + Math.round(Math.random() * 600);
}

/**
 * Returns a simulated reading time in milliseconds for a page type.
 *
 * Content pages (chapter/article): 2-8 seconds
 * List pages (catalog/index):   0.5-2 seconds
 *
 * The reading time has a Gaussian-like distribution centered around
 * the middle of the range, making it more realistic than uniform random.
 */
export function getReadingTime(url: string): number {
  const isContent = isContentPage(url);

  // Gaussian-like random via Box-Muller (simplified: sum of 2 uniform randoms)
  const u1 = Math.random();
  const u2 = Math.random();
  const gaussian = (u1 + u2) / 2; // Approximate bell curve, range [0, 1], peak at 0.5

  if (isContent) {
    // Content pages: 2000-8000ms, peaked around 4000-5000ms
    return 2000 + Math.round(gaussian * 6000);
  }
  // List pages: 500-2000ms, peaked around 1000-1250ms
  return 500 + Math.round(gaussian * 1500);
}

/**
 * Returns the delay (in ms) before making the next request to a domain.
 * Combines multiple human-like timing behaviors:
 *
 * 1. Base adaptive delay from the existing AdaptiveDelayManager
 * 2. Reading time simulation (longer for content pages)
 * 3. Mouse-move/think micro-delay (200-800ms)
 * 4. Occasional "reading pause" (5-15s) every 5-10 requests
 *
 * @param domain  - Target domain
 * @param url     - Target URL (used to detect content vs list page)
 * @returns Total delay in milliseconds
 */
export function getHumanLikeDelay(domain: string, url?: string): number {
  // Get base adaptive delay
  const baseDelay = adaptiveDelay.getDelaySync(domain);

  // Add mouse-move/think delay
  const mouseDelay = getMouseMoveDelay();

  // Get reading time if URL is provided
  const readingDelay = url ? getReadingTime(url) : 0;

  // Check for occasional pause (every 5-10 requests)
  let pauseDelay = 0;
  const session = getOrCreateBrowsingSession(domain);
  if (session.requestCount >= session.nextPauseAt) {
    // Simulate a longer pause: human stops to read, gets distracted, etc.
    pauseDelay = 5000 + Math.round(Math.random() * 10000); // 5-15 seconds
    // Set next pause 5-10 requests later
    session.nextPauseAt = session.requestCount + 5 + Math.floor(Math.random() * 6);
  }
  session.requestCount++;

  return baseDelay + mouseDelay + readingDelay + pauseDelay;
}

/**
 * Async version of getHumanLikeDelay that actually waits.
 * Useful for inserting delays between sequential requests.
 *
 * @param domain  - Target domain
 * @param url     - Target URL (for content/list detection)
 */
export async function humanLikeDelay(domain: string, url?: string): Promise<void> {
  const delayMs = getHumanLikeDelay(domain, url);
  await new Promise(resolve => setTimeout(resolve, delayMs));
}

/**
 * Reset browsing session state for a domain.
 */
export function resetBrowsingSession(domain?: string): void {
  if (domain) {
    browsingSessions.delete(domain);
  } else {
    browsingSessions.clear();
  }
}

/**
 * Get current browsing session state (for debugging/monitoring).
 */
export function getBrowsingSessionState(domain: string): { requestCount: number; nextPauseAt: number } | null {
  return browsingSessions.get(domain) || null;
}

function getOrCreateBrowsingSession(domain: string): BrowsingSessionState {
  const existing = browsingSessions.get(domain);
  if (existing) {
    browsingSessions.delete(domain);
    browsingSessions.set(domain, existing);
    return existing;
  }
  // LRU eviction
  if (browsingSessions.size >= MAX_BROWSING_SESSIONS) {
    const firstKey = browsingSessions.keys().next().value;
    if (firstKey) browsingSessions.delete(firstKey);
  }
  const session = {
    requestCount: 0,
    // First pause after 5-10 requests
    nextPauseAt: 5 + Math.floor(Math.random() * 6),
  };
  browsingSessions.set(domain, session);
  return session;
}

// ==================== Time-of-Day Based Request Patterns ====================

/**
 * Time-of-day based request pattern simulation.
 *
 * Real users have different browsing patterns depending on time of day:
 *   - Night (0-6am): Very low activity, longer delays
 *   - Morning (6-9am): Increasing activity
 *   - Work hours (9am-6pm): Moderate-high activity
 *   - Evening (6-10pm): Peak activity for personal browsing
 *   - Late night (10pm-12am): Declining activity
 *
 * Scraping at constant rate 24/7 is a strong detection signal.
 * This module adds time-of-day modulation to request delays.
 */

export interface TimeOfDayPattern {
  /** Hour range start (0-23) */
  hourStart: number;
  /** Hour range end (0-23) */
  hourEnd: number;
  /** Activity multiplier (0.1 = very slow, 1.0 = normal, 2.0 = fast) */
  activityMultiplier: number;
  /** Label for this period */
  label: string;
}

const TIME_OF_DAY_PATTERNS: TimeOfDayPattern[] = [
  { hourStart: 0, hourEnd: 6, activityMultiplier: 0.2, label: '深夜' },
  { hourStart: 6, hourEnd: 9, activityMultiplier: 0.6, label: '早晨' },
  { hourStart: 9, hourEnd: 12, activityMultiplier: 0.8, label: '上午' },
  { hourStart: 12, hourEnd: 14, activityMultiplier: 0.7, label: '午休' },
  { hourStart: 14, hourEnd: 18, activityMultiplier: 0.9, label: '下午' },
  { hourStart: 18, hourEnd: 22, activityMultiplier: 1.0, label: '晚间高峰' },
  { hourStart: 22, hourEnd: 24, activityMultiplier: 0.4, label: '深夜' },
];

/**
 * Get the current time-of-day activity multiplier.
 * Returns a multiplier that should be applied to delays:
 *   - Low multiplier (e.g., 0.2 at night) → longer delays (simulate low activity)
 *   - High multiplier (e.g., 1.0 at evening) → normal delays (simulate peak activity)
 *
 * @param hour - Current hour (0-23), defaults to current local hour
 * @returns Activity multiplier (0.1 - 1.0) and period label
 */
export function getTimeOfDayMultiplier(hour?: number): { multiplier: number; label: string } {
  const h = hour ?? new Date().getHours();
  const pattern = TIME_OF_DAY_PATTERNS.find(p => h >= p.hourStart && h < p.hourEnd)
    || TIME_OF_DAY_PATTERNS[0]!;

  // Add ±15% random variation to avoid exact time-pattern detection
  const variation = 0.85 + Math.random() * 0.3;
  return {
    multiplier: Math.max(0.1, pattern.activityMultiplier * variation),
    label: pattern.label,
  };
}

/**
 * Get all time-of-day patterns (for dashboard display).
 */
export function getTimeOfDayPatterns(): TimeOfDayPattern[] {
  return TIME_OF_DAY_PATTERNS;
}

// ==================== Domain-Specific Delay Learning ====================

/**
 * Domain-specific delay learning from past responses.
 *
 * Learns the optimal delay for each domain based on historical response data:
 *   - Domains that frequently return 429/403 need longer delays
 *   - Domains with fast, reliable responses can use shorter delays
 *   - Learning rate adapts: faster learning for new domains, slower for stable ones
 *
 * This creates a per-domain "delay profile" that improves over time.
 */

export interface DomainDelayProfile {
  domain: string;
  /** Learned optimal delay (ms) */
  learnedDelay: number;
  /** Number of samples used for learning */
  sampleCount: number;
  /** Last update timestamp */
  lastUpdated: number;
  /** Historical success rate (0-1) */
  successRate: number;
  /** Historical average response time (ms) */
  avgResponseTime: number;
}

const domainDelayProfiles = new Map<string, DomainDelayProfile>();
const MAX_DELAY_PROFILES = 500;
const DELAY_LEARNING_RATE = 0.15; // How fast to adapt (0-1, higher = faster)
const MIN_LEARNED_DELAY = 500; // Minimum learned delay (ms)
const MAX_LEARNED_DELAY = 30000; // Maximum learned delay (ms)

/**
 * Record a response and update the domain's delay profile.
 *
 * @param domain - Target domain
 * @param responseTime - Response time in ms
 * @param success - Whether the request succeeded
 * @param statusCode - HTTP status code
 */
export function recordDelayLearning(domain: string, responseTime: number, success: boolean, statusCode?: number): void {
  let profile = domainDelayProfiles.get(domain);

  if (!profile) {
    if (domainDelayProfiles.size >= MAX_DELAY_PROFILES) {
      // Evict oldest
      let oldestKey = '';
      let oldestTime = Infinity;
      for (const [key, p] of domainDelayProfiles) {
        if (p.lastUpdated < oldestTime) { oldestTime = p.lastUpdated; oldestKey = key; }
      }
      if (oldestKey) domainDelayProfiles.delete(oldestKey);
    }
    profile = {
      domain,
      learnedDelay: 1500, // Start with default 1.5s
      sampleCount: 0,
      lastUpdated: Date.now(),
      successRate: 1.0,
      avgResponseTime: responseTime,
    };
    domainDelayProfiles.set(domain, profile);
  }

  profile.sampleCount++;
  profile.lastUpdated = Date.now();

  // Update success rate with exponential moving average
  const successValue = success ? 1 : 0;
  const alpha = Math.min(DELAY_LEARNING_RATE, 1 / profile.sampleCount);
  profile.successRate = profile.successRate * (1 - alpha) + successValue * alpha;

  // Update average response time
  profile.avgResponseTime = profile.avgResponseTime * (1 - alpha) + responseTime * alpha;

  // Learn optimal delay:
  // - On success with fast response → decrease delay
  // - On success with slow response → keep delay
  // - On 429/403 → increase delay significantly
  // - On other failure → increase delay moderately
  if (success && statusCode && statusCode < 300) {
    if (responseTime < 1000) {
      // Fast success → can try shorter delay
      profile.learnedDelay *= (1 - alpha * 0.3);
    }
  } else if (statusCode === 429 || statusCode === 403) {
    // Anti-crawl response → significant delay increase
    profile.learnedDelay *= (1 + alpha * 2.0);
  } else if (statusCode === 503) {
    // Service unavailable → moderate increase
    profile.learnedDelay *= (1 + alpha * 1.0);
  } else if (!success) {
    // Other failure → slight increase
    profile.learnedDelay *= (1 + alpha * 0.5);
  }

  // Clamp learned delay
  profile.learnedDelay = Math.max(MIN_LEARNED_DELAY, Math.min(MAX_LEARNED_DELAY, profile.learnedDelay));
}

/**
 * Get the learned delay for a domain.
 * Returns undefined if no learning data is available.
 *
 * @param domain - Target domain
 * @returns Learned delay in ms, or undefined
 */
export function getLearnedDelay(domain: string): number | undefined {
  return domainDelayProfiles.get(domain)?.learnedDelay;
}

/**
 * Get all domain delay profiles (for dashboard).
 */
export function getDomainDelayProfiles(): DomainDelayProfile[] {
  return Array.from(domainDelayProfiles.values())
    .sort((a, b) => b.lastUpdated - a.lastUpdated);
}

// ==================== Enhanced Human-Like Delay ====================

/**
 * Enhanced human-like delay that combines:
 *   1. Base adaptive delay
 *   2. Time-of-day modulation
 *   3. Domain-specific learned delay
 *   4. Reading time simulation
 *   5. Mouse-move/think micro-delay
 *   6. Occasional "reading pause"
 *
 * This produces delays that look natural from multiple analysis angles.
 */
export function getEnhancedHumanLikeDelay(domain: string, url?: string): number {
  // 1. Base delay: use learned delay if available, else adaptive
  const learnedDelay = getLearnedDelay(domain);
  const baseDelay = learnedDelay ?? adaptiveDelay.getDelaySync(domain);

  // 2. Time-of-day modulation: slower at night
  const { multiplier: todMultiplier } = getTimeOfDayMultiplier();
  const timeAdjustedDelay = baseDelay / todMultiplier; // Lower multiplier → longer delay

  // 3. Reading time
  const readingDelay = url ? getReadingTime(url) : 0;

  // 4. Mouse-move/think delay
  const mouseDelay = getMouseMoveDelay();

  // 5. Occasional "reading pause"
  let pauseDelay = 0;
  const session = getOrCreateBrowsingSession(domain);
  if (session.requestCount >= session.nextPauseAt) {
    pauseDelay = 5000 + Math.round(Math.random() * 10000);
    session.nextPauseAt = session.requestCount + 5 + Math.floor(Math.random() * 6);
  }
  session.requestCount++;

  return Math.round(timeAdjustedDelay + readingDelay + mouseDelay + pauseDelay);
}

/**
 * Async version of enhanced human-like delay.
 */
export async function enhancedHumanLikeDelay(domain: string, url?: string): Promise<void> {
  const delayMs = getEnhancedHumanLikeDelay(domain, url);
  await new Promise(resolve => setTimeout(resolve, delayMs));
}

