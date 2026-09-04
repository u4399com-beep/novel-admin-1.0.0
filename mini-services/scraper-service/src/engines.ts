/**
 * Scraping Engines - Pluggable fetch backends
 *
 * Engine System:
 *   cheerio        → Fast HTTP + cheerio parsing (default, no JS rendering)
 *   playwright     → Headless browser with full JS rendering
 *   firecrawl      → External Firecrawl API (self-hosted or cloud)
 *   agentql        → AgentQL API - extract data using natural language queries
 *   cloud-browser  → Browserless / Steel cloud browser API
 *   scrapling      → Python anti-bot browser service
 *   dokobot        → Python anti-bot bypass service (external HTTP)
 *   obscura        → Stealth anti-fingerprint browser (enhanced Playwright)
 *   api            → JSON API engine with signing/decryption support
 */

import type { ScrapingEngine, EngineOptions, FetchResult, EngineType, FirecrawlConfig, AgentQLQuery, AntiCrawl } from "./types";
import { isSafeUrl } from "./ssrf";
import { buildFetchHeaders, retryWithBackoff, followRedirects, getSecFetchHeadersForDomain, getChromeClientHints } from "./utils";
import { getProfileForDomain, getStealthScript, profileLanguagesToAcceptLanguage, getRandomUA } from "./stealth";
import { getAcceptEncoding } from "./http2-decoy";
import { getTLSFingerprintOptions } from "./tls-fingerprint";
import { proxyManager, bunProxyFetchInit } from "./proxy-manager";
import { cookieJar } from "./cookie-jar";
import { rateLimiter } from "./rate-limiter";
import { sessionManager } from "./session-manager";
import { requestFingerprintMgr, applyTimingJitter } from "./request-fingerprint";
import { referrerChain } from "./referrer-chain";
import { detectCaptcha, type CaptchaDetection } from "./captcha-detector";
import { antiCrawlAdvisor } from "./anti-crawl-advisor";
import { browserBehavior } from "./browser-behavior";
import { detectAndDecode } from "./charset-detector";
import { getEngineFallbackChain, recordCaptchaUpgrade, recordLowContentHint } from "./engine-config";

const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_SCROLL_ITERATIONS = parseInt(process.env.SCRAPER_MAX_SCROLL_ITERATIONS || '30', 10);

/**
 * Resource types that are always blocked during browser-based scraping.
 * Moved to module level to avoid creating a new Set on every shouldBlockResource call.
 */
const ALWAYS_BLOCKED_RESOURCES = new Set([
  'image', 'font', 'media', 'stylesheet',
  'websocket',   // bot-detection beacons (e.g., reCAPTCHA, DataDome WS telemetry)
  'manifest',    // web app manifest — unnecessary for scraping
  'eventsource', // Server-Sent Events — bot-detection telemetry
]);

/**
 * Read response body with streaming size limit to prevent OOM.
 * Unlike response.text() which buffers the entire body before returning,
 * this reads chunks and aborts early if the limit is exceeded.
 */
async function readTextWithLimit(response: Response, maxSize: number): Promise<string> {
  // If Content-Length is known and exceeds limit, reject immediately
  const contentLength = parseInt(response.headers.get("content-length") || "0", 10);
  if (contentLength > maxSize) {
    throw new Error(`Response Content-Length ${contentLength} exceeds ${Math.round(maxSize / 1024 / 1024)}MB limit`);
  }

  // Stream-read with size tracking
  const reader = response.body?.getReader();
  if (!reader) {
    // No body (e.g., 204 No Content) — fallback to .text()
    return response.text();
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxSize) {
        reader.cancel();
        throw new Error(`Response body exceeded ${Math.round(maxSize / 1024 / 1024)}MB limit after ${totalBytes} bytes`);
      }
      chunks.push(value);
    }
  } catch (err) {
    reader.cancel().catch(() => {});
    throw err;
  }

  // Combine chunks
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  // Use charset auto-detection to handle GBK/Big5 pages that misdeclare as UTF-8
  const contentType = response.headers.get('content-type');
  return detectAndDecode(combined, contentType);
}

// ==================== Adaptive Rate Limit Wait ====================

const MAX_THROTTLE_RETRIES = 3;

/**
 * Wait for rate limiter with adaptive backoff.
 * - Waits for `waitMs` then retries `rateLimiter.acquire()`
 * - Supports early exit on abort signal
 * - Max 3 wait+retry cycles before giving up
 * - Logs throttle events with domain, wait time, and retry count
 */
async function waitForRateLimit(domain: string, signal?: AbortSignal): Promise<void> {
  for (let retry = 1; retry <= MAX_THROTTLE_RETRIES; retry++) {
    const rateCheck = rateLimiter.acquire(domain);
    if (rateCheck.allowed) return;

    const waitMs = Math.min(rateCheck.waitMs, 2000);
    console.log(
      `[rate-limiter] Throttled: domain=${domain}, waitMs=${waitMs}, retry=${retry}/${MAX_THROTTLE_RETRIES}`
    );

    // Wait with early exit on abort
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason || new Error('Aborted during rate limit wait'));
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason || new Error('Aborted during rate limit wait'));
      };
      let timer: ReturnType<typeof setTimeout>;
      timer = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, waitMs);
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  // After max retries, try one final acquire
  const finalCheck = rateLimiter.acquire(domain);
  if (!finalCheck.allowed) {
    throw new Error(`Rate limit max retries (${MAX_THROTTLE_RETRIES}) exceeded for ${domain} (waitMs=${finalCheck.waitMs})`);
  }
}

// ==================== Circuit Breaker ====================

type CircuitState = "closed" | "open" | "half-open";

interface CircuitBreakerOptions {
  failureThreshold?: number;
  recoveryTimeout?: number;
  halfOpenMaxAttempts?: number;
}

class CircuitBreaker {
  private state: CircuitState = "closed";
  private failureCount = 0;
  private lastFailureTime = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeout: number;
  private readonly halfOpenMaxAttempts: number;
  private _halfOpenInFlight = 0; // Track in-flight requests during half-open

  constructor(name: string, failureThreshold = 3, resetTimeout = 30000, halfOpenMaxAttempts = 1) {
    this.failureThreshold = failureThreshold;
    this.resetTimeout = resetTimeout;
    this.halfOpenMaxAttempts = halfOpenMaxAttempts;
    this._name = name;
  }

  /**
   * Factory that reads thresholds from environment variables.
   *   SCRAPER_CB_FAILURE_THRESHOLD  (default: 5)
   *   SCRAPER_CB_RECOVERY_TIMEOUT_MS (default: 30000)
   *   SCRAPER_CB_HALF_OPEN_MAX       (default: 1)
   */
  static create(name: string, opts?: CircuitBreakerOptions): CircuitBreaker {
    const threshold = opts?.failureThreshold ?? parseInt(process.env.SCRAPER_CB_FAILURE_THRESHOLD || '5', 10);
    const reset = opts?.recoveryTimeout ?? parseInt(process.env.SCRAPER_CB_RECOVERY_TIMEOUT_MS || '30000', 10);
    const halfOpen = opts?.halfOpenMaxAttempts ?? parseInt(process.env.SCRAPER_CB_HALF_OPEN_MAX || '1', 10);
    return new CircuitBreaker(name, threshold, reset, halfOpen);
  }

  private _name: string;

  async acquire(): Promise<void> {
    if (this.state === "open") {
      // Check if enough time has passed to transition to half-open
      if (Date.now() - this.lastFailureTime >= this.resetTimeout) {
        this.state = "half-open";
        this._halfOpenInFlight = 0;
      } else {
        throw new Error(`Service ${this._name} is temporarily unavailable (circuit breaker open)`);
      }
    }

    // In half-open state, only allow a limited number of requests as probes
    if (this.state === "half-open") {
      if (this._halfOpenInFlight >= this.halfOpenMaxAttempts) {
        throw new Error(`Service ${this._name} is in recovery (half-open, ${this._halfOpenInFlight}/${this.halfOpenMaxAttempts} probes in flight)`);
      }
      this._halfOpenInFlight++;
    }
  }

  /**
   * Release a half-open in-flight slot WITHOUT recording success or failure.
   * Used when a request is aborted or hits a non-service error (e.g. doNotRetry)
   * that should not influence the circuit breaker's failure count.
   * Safe to call in any state (no-op when not in half-open).
   */
  release(): void {
    this._halfOpenInFlight = Math.max(0, this._halfOpenInFlight - 1);
  }

  recordSuccess(): void {
    this.failureCount = 0;
    this._halfOpenInFlight = 0;
    this.state = "closed";
  }

  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.failureThreshold) {
      this.state = "open";
      // Reset half-open tracking — all in-flight probes are now invalid
      this._halfOpenInFlight = 0;
    } else {
      // Still below threshold — decrement in-flight for this specific probe
      this._halfOpenInFlight = Math.max(0, this._halfOpenInFlight - 1);
    }
  }

  getState(): { state: CircuitState; failureCount: number; lastFailureTime: number; resetTimeout: number; timeUntilReset: number } {
    return {
      state: this.state,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime,
      resetTimeout: this.resetTimeout,
      timeUntilReset: this.state === 'open'
        ? Math.max(0, this.resetTimeout - (Date.now() - this.lastFailureTime))
        : 0,
    };
  }

  reset(): void {
    this.state = "closed";
    this.failureCount = 0;
    this.lastFailureTime = 0;
    this._halfOpenInFlight = 0;
  }
}

// One circuit breaker per external engine type (configurable via env vars)
const firecrawlBreaker = CircuitBreaker.create("Firecrawl");
const agentqlBreaker = CircuitBreaker.create("AgentQL");
const cloudBrowserBreaker = CircuitBreaker.create("CloudBrowser");
const scraplingBreaker = CircuitBreaker.create("Scrapling");
const dokobotBreaker = CircuitBreaker.create("Dokobot");

// ==================== HTTP Connection Pool (CheerioEngine) ====================

/**
 * Shared undici Agent for CheerioEngine HTTP requests.
 * Provides connection pooling with keep-alive, reducing TCP handshake overhead
 * for high-throughput scraping. Configured with conservative limits to avoid
 * exhausting local ports or triggering server connection limits.
 *
 * - keepAliveTimeout: 30s (reuse connections within 30s of last use)
 * - keepAliveMaxTimeout: 600s (absolute max lifetime per connection)
 * - connections: 20 (max concurrent connections per origin)
 * - pipelining: 1 (no HTTP pipelining, safer for diverse servers)
 */
let _cheerioAgent: import('undici').Agent | null = null;
let _cheerioAgentPromise: Promise<import('undici').Agent> | null = null;

function getCheerioAgent(): Promise<import('undici').Agent> {
  if (_cheerioAgent) return Promise.resolve(_cheerioAgent);
  if (_cheerioAgentPromise) return _cheerioAgentPromise;
  _cheerioAgentPromise = (async () => {
    const { Agent } = await import('undici');
    const agent = new Agent({
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 600_000,
      connections: 20,
      pipelining: 1,
    });
    _cheerioAgent = agent;
    console.log('[CheerioEngine] HTTP connection pool initialized (keepAlive=30s, maxConn=20)');
    return agent;
  })().catch((err) => {
    console.error('[CheerioEngine] Failed to initialize HTTP connection pool:', err);
    _cheerioAgentPromise = null; // Allow retry on next call
    throw err;
  });
  return _cheerioAgentPromise;
}

// ==================== Engine Fallback Chain ====================

/**
 * R50 engine failure fallback chain — internal-only engine strategies.
 * Each sub-array is an ordered fallback chain for a "strategy".
 * The first engine in each chain is the primary; subsequent engines are fallbacks.
 *
 * External engines (firecrawl, agentql, cloud-browser, scrapling) are NOT included —
 * they remain as separate strategies chosen by the user/AI rule config.
 *
 * Used by task-engine.ts when a scrape operation fails and needs to retry
 * with a different internal engine before giving up.
 */
/**
 * Select the best fallback chain strategy for a given primary engine.
 * Returns the chain whose first element matches the primary engine.
 * If no match, returns strategy A (cheerio-first) as the default.
 */
export function getFallbackChainForEngine(primaryEngine: EngineType, domain?: string): EngineType[] {
  // Only internal engines participate in the chain
  const internalEngines = new Set<EngineType>(['cheerio', 'playwright', 'obscura']);
  const chains = getEngineFallbackChain(domain);

  if (!internalEngines.has(primaryEngine)) {
    // External engine — use the first available chain as the default internal chain
    return chains[0];
  }
  for (const chain of chains) {
    if (chain[0] === primaryEngine) return chain;
  }
  // No matching strategy found — build a chain with the primary engine first
  return [primaryEngine, ...chains[0].filter(e => e !== primaryEngine)];
}

/**
 * Default engine fallback chain. Ordered from fastest/cheapest to most capable.
 * Used when a request fails and engineFallback is enabled in antiCrawl config.
 *
 * Logic:
 *   cheerio → playwright → obscura → scrapling → firecrawl → agentql → cloud-browser
 *
 * External engines (firecrawl, agentql, cloud-browser, scrapling) are placed later
 * because they require external services and have higher latency/cost.
 * obscura is before scrapling because it's local (no network hop to external service).
 */
const DEFAULT_FALLBACK_CHAIN: EngineType[] = [
  'cheerio',       // Fast HTTP, no JS
  'playwright',    // Full JS rendering
  'obscura',       // Stealth browser (local, anti-fingerprint)
  'scrapling',     // Python anti-bot service
  'dokobot',       // Python anti-bot bypass service
  'firecrawl',     // External API
  'agentql',       // External API (NL queries)
  'cloud-browser', // Cloud browser API
];

/**
 * Per-domain engine failure tracking for adaptive fallback ordering.
 * If an engine consistently fails for a domain, it gets deprioritized.
 * Bounded to MAX_TRACKED_DOMAINS entries with LRU eviction.
 */
const domainEngineFailures = new Map<string, Map<EngineType, number>>();
const DOMAIN_FAILURE_THRESHOLD = 3; // Deprioritize after 3 consecutive failures
const DOMAIN_FAILURE_WINDOW_MS = 10 * 60 * 1000; // 10-minute sliding window
const domainFailureTimestamps = new Map<string, number>();
const MAX_TRACKED_DOMAINS = 500; // LRU eviction limit

// ==================== Domain Engine Success History ====================

/**
 * Domain-level engine success history for smart engine pre-selection.
 * Remembers which engine last succeeded for a domain within a time window,
 * allowing `selectEngine()` to skip straight to the known-good engine
 * instead of trying and failing through the fallback chain.
 *
 * Bounded LRU with 50 entries, 30-minute TTL per entry.
 */
const DOMAIN_SUCCESS_MAX_ENTRIES = 50;
const DOMAIN_SUCCESS_TTL_MS = 30 * 60 * 1000; // 30 minutes

const _domainLastSuccess: Map<string, { engine: EngineType; timestamp: number }> = new Map();

/**
 * Record that a given engine succeeded for a domain.
 * Called from fetchWithEngineFallback on successful fetch.
 */
function recordDomainEngineSuccess(domain: string, engine: EngineType): void {
  // LRU eviction: if at capacity and domain not already tracked, evict oldest
  if (_domainLastSuccess.size >= DOMAIN_SUCCESS_MAX_ENTRIES && !_domainLastSuccess.has(domain)) {
    const oldestKey = _domainLastSuccess.keys().next().value;
    if (oldestKey !== undefined) {
      _domainLastSuccess.delete(oldestKey);
    }
  }
  _domainLastSuccess.set(domain, { engine, timestamp: Date.now() });
}

/**
 * Look up the most recent successful engine for a domain.
 * Returns the engine type if found within TTL, undefined otherwise.
 * Performs amortized cleanup of expired entries on each access.
 */
function getDomainLastSuccessEngine(domain: string): EngineType | undefined {
  const now = Date.now();
  const entry = _domainLastSuccess.get(domain);
  if (!entry) return undefined;
  if (now - entry.timestamp > DOMAIN_SUCCESS_TTL_MS) {
    _domainLastSuccess.delete(domain);
    return undefined;
  }
  // Amortized cleanup: if map is getting large, sweep expired entries
  if (_domainLastSuccess.size > DOMAIN_SUCCESS_MAX_ENTRIES * 0.8) {
    for (const [key, val] of _domainLastSuccess) {
      if (now - val.timestamp > DOMAIN_SUCCESS_TTL_MS) {
        _domainLastSuccess.delete(key);
      }
    }
  }
  return entry.engine;
}

/**
 * Record a domain-level engine failure for adaptive chain reordering.
 */
function recordEngineFailure(domain: string, engine: EngineType): void {
  // LRU eviction: remove oldest domain if over limit
  if (domainEngineFailures.size >= MAX_TRACKED_DOMAINS && !domainEngineFailures.has(domain)) {
    const oldestKey = domainEngineFailures.keys().next().value;
    if (oldestKey !== undefined) {
      // Capture evicted failures before deleting (needed for timestamp cleanup)
      const evictedFailures = domainEngineFailures.get(oldestKey);
      domainEngineFailures.delete(oldestKey);
      // Also clean up all timestamps for this domain
      const allEngineTypes: EngineType[] = ['cheerio', 'playwright', 'firecrawl', 'agentql', 'cloud-browser', 'scrapling', 'obscura', 'dokobot', 'api'];
      for (const e of allEngineTypes) {
        domainFailureTimestamps.delete(`${oldestKey}:${e}`);
      }
    }
  }
  if (!domainEngineFailures.has(domain)) {
    domainEngineFailures.set(domain, new Map());
  }
  const failures = domainEngineFailures.get(domain)!;
  failures.set(engine, (failures.get(engine) || 0) + 1);
  // True LRU: re-insert domain to update Map insertion order
  domainEngineFailures.delete(domain);
  domainEngineFailures.set(domain, failures);
  const tsKey = `${domain}:${engine}`;
  domainFailureTimestamps.set(tsKey, Date.now());
  // LRU eviction for timestamps map (max 1000 entries)
  if (domainFailureTimestamps.size > 1000) {
    const oldestTsKey = domainFailureTimestamps.keys().next().value;
    if (oldestTsKey !== undefined) {
      domainFailureTimestamps.delete(oldestTsKey);
      // Also clean up corresponding failure count to prevent permanent stale counts
      const [tsDomain, tsEngine] = oldestTsKey.split(':');
      if (tsDomain && tsEngine) {
        const engineMap = domainEngineFailures.get(tsDomain);
        if (engineMap) {
          engineMap.delete(tsEngine);
          if (engineMap.size === 0) domainEngineFailures.delete(tsDomain);
        }
      }
    }
  }
}

/**
 * Record a domain-level engine success (resets failure counter).
 */
function recordEngineSuccess(domain: string, engine: EngineType): void {
  const failures = domainEngineFailures.get(domain);
  if (failures) {
    failures.set(engine, 0);
  }
}

/**
 * Build an adaptive fallback chain for a domain, deprioritizing engines
 * that have recently failed repeatedly.
 */
function getAdaptiveFallbackChain(domain: string, baseChain?: EngineType[]): EngineType[] {
  const chain = baseChain ? [...baseChain] : [...DEFAULT_FALLBACK_CHAIN];
  const failures = domainEngineFailures.get(domain);
  if (!failures) return chain;

  const now = Date.now();
  // Sort: engines with fewer recent failures come first
  chain.sort((a, b) => {
    const aFails = getRecentFailureCount(domain, a, failures, now);
    const bFails = getRecentFailureCount(domain, b, failures, now);
    return aFails - bFails;
  });

  return chain;
}

/**
 * Get failure count for an engine/domain pair.
 * NOTE: This is NOT a true sliding window counter. It returns the cumulative failure count
 * since the last success, but only if the last failure timestamp falls within the
 * DOMAIN_FAILURE_WINDOW_MS window. Once the last failure ages out, the count resets to 0.
 * This means a domain with 50 failures all within the window returns 50, not just the
 * failures in a rolling window.
 */
function getRecentFailureCount(
  domain: string, engine: EngineType,
  allFailures: Map<EngineType, number>, now: number
): number {
  const ts = domainFailureTimestamps.get(`${domain}:${engine}`);
  // If timestamp was independently evicted or last failure is outside the window, return 0
  if (ts === undefined) return 0;
  if (now - ts > DOMAIN_FAILURE_WINDOW_MS) {
    return 0;
  }
  return allFailures.get(engine) || 0;
}

/**
 * Determine if an error is worth falling back to another engine.
 * CAPTCHA errors are handled separately by the CAPTCHA strategy chain,
 * so we only fallback on transport/timeout/empty-content errors.
 */
function isFallbackWorthyError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message;
    // Don't fallback on CAPTCHA — handled by captcha-strategy.ts
    if (msg.includes('CAPTCHA')) return false;
    // Don't fallback on rate limit — increasing delay is better
    if (msg.includes('Rate limit')) return false;
    // Don't fallback on abort — user intentionally cancelled
    if (msg.includes('aborted') || msg.includes('Aborted')) return false;
    // Don't fallback on circuit breaker — already means service is down
    if (msg.includes('circuit breaker')) return false;
    // Fallback on: HTTP errors (403, 503), timeouts, empty content, network errors
    // Note: 429 is NOT fallback-worthy — rate limiter handles it via delay
    if (/HTTP (403|503)/.test(msg)) return true;
    if (msg.includes('timeout') || msg.includes('Timeout') || msg.includes('ETIMEDOUT')) return true;
    if (msg.includes('ECONNREFUSED') || msg.includes('ECONNRESET') || msg.includes('ENOTFOUND')) return true;
    if (msg.includes('Unexpected Content-Type')) return true;
  }
  // Non-Error throws (e.g. string) — fallback conservatively
  return true;
}

// ==================== Smart Retry with Exponential Backoff ====================

/**
 * Anti-crawl response types that should trigger smart retry.
 * Each type maps to specific HTTP status codes or content patterns.
 */
type AntiCrawlResponseType = 'forbidden' | 'rate_limited' | 'service_unavailable' | 'captcha' | 'challenge' | 'block' | 'timeout' | 'unknown';

/**
 * Classify an error/failure into an anti-crawl response type.
 * Used to determine appropriate retry strategy.
 */
function classifyAntiCrawlResponse(err: unknown): AntiCrawlResponseType {
  if (!(err instanceof Error)) return 'unknown';
  const msg = err.message;
  if (msg.includes('CAPTCHA')) return 'captcha';
  if (/HTTP 403/.test(msg)) return 'forbidden';
  if (/HTTP 429/.test(msg)) return 'rate_limited';
  if (/HTTP 503/.test(msg)) return 'service_unavailable';
  if (msg.includes('circuit breaker')) return 'block';
  if (msg.includes('timeout') || msg.includes('ETIMEDOUT')) return 'timeout';
  if (msg.includes('challenge') || msg.includes('CF challenge')) return 'challenge';
  return 'unknown';
}

/** Per-domain cool-down state */
interface CooldownState {
  /** Domain in cool-down mode */
  active: boolean;
  /** Cool-down ends at this timestamp */
  until: number;
  /** Number of consecutive failures that triggered cool-down */
  triggerCount: number;
  /** The anti-crawl response type that triggered cool-down */
  triggerType: AntiCrawlResponseType;
}

/** Per-domain retry tracking */
interface DomainRetryState {
  /** Consecutive failures for this domain */
  consecutiveFails: number;
  /** Timestamp of last failure */
  lastFailAt: number;
  /** Current exponential backoff level */
  backoffLevel: number;
  /** Cool-down state */
  cooldown: CooldownState;
  /** History of recent failure types (for pattern detection) */
  recentFailureTypes: AntiCrawlResponseType[];
}

const domainRetryStates = new Map<string, DomainRetryState>();
const MAX_RETRY_STATES = 200;

/** Smart retry config */
const SMART_RETRY_CONFIG = {
  /** Base delay for exponential backoff (ms) */
  baseDelayMs: 1000,
  /** Maximum backoff delay (ms) */
  maxDelayMs: 120_000,
  /** Jitter range: ±percentage of calculated delay */
  jitterPercent: 0.25,
  /** Failures before entering cool-down mode */
  cooldownThreshold: 5,
  /** Cool-down duration multiplier (multiplied by current backoff) */
  cooldownMultiplier: 3,
  /** Maximum cool-down duration (ms) */
  maxCooldownMs: 300_000, // 5 minutes
  /** Number of consecutive successes to exit cool-down early */
  cooldownRecoverySuccesses: 2,
};

/**
 * Calculate exponential backoff delay with jitter.
 * Formula: base * 2^level + random_jitter
 * The jitter prevents "thundering herd" when multiple scrapers retry simultaneously.
 */
function calculateBackoffDelay(level: number): number {
  const exponentialDelay = SMART_RETRY_CONFIG.baseDelayMs * Math.pow(2, level);
  const cappedDelay = Math.min(exponentialDelay, SMART_RETRY_CONFIG.maxDelayMs);
  // Add ±25% jitter
  const jitterRange = cappedDelay * SMART_RETRY_CONFIG.jitterPercent;
  const jitter = (Math.random() * 2 - 1) * jitterRange;
  return Math.max(100, Math.round(cappedDelay + jitter));
}

/**
 * Get or create retry state for a domain.
 */
function getDomainRetryState(domain: string): DomainRetryState {
  let state = domainRetryStates.get(domain);
  if (!state) {
    // LRU eviction
    if (domainRetryStates.size >= MAX_RETRY_STATES) {
      const oldestKey = domainRetryStates.keys().next().value;
      if (oldestKey !== undefined) domainRetryStates.delete(oldestKey);
    }
    state = {
      consecutiveFails: 0,
      lastFailAt: 0,
      backoffLevel: 0,
      cooldown: { active: false, until: 0, triggerCount: 0, triggerType: 'unknown' },
      recentFailureTypes: [],
    };
    domainRetryStates.set(domain, state);
  }
  return state;
}

/**
 * Record a retry failure for a domain and get the recommended wait time.
 * Returns the delay in ms before the next retry, or -1 if cool-down should be entered.
 */
export function recordSmartRetryFailure(domain: string, err: unknown): { delayMs: number; inCooldown: boolean; cooldownUntil?: number } {
  const state = getDomainRetryState(domain);
  const failType = classifyAntiCrawlResponse(err);

  state.consecutiveFails++;
  state.lastFailAt = Date.now();
  state.backoffLevel = Math.min(state.consecutiveFails - 1, 10); // Cap at 2^10 = 1024x
  state.recentFailureTypes.push(failType);
  if (state.recentFailureTypes.length > 20) state.recentFailureTypes.shift();

  // Check if we should enter cool-down mode
  if (state.consecutiveFails >= SMART_RETRY_CONFIG.cooldownThreshold && !state.cooldown.active) {
    const backoffDelay = calculateBackoffDelay(state.backoffLevel);
    const cooldownDuration = Math.min(
      backoffDelay * SMART_RETRY_CONFIG.cooldownMultiplier,
      SMART_RETRY_CONFIG.maxCooldownMs,
    );
    state.cooldown = {
      active: true,
      until: Date.now() + cooldownDuration,
      triggerCount: state.consecutiveFails,
      triggerType: failType,
    };

    console.warn(
      `[SmartRetry] Domain ${domain} entering cool-down for ${Math.round(cooldownDuration / 1000)}s ` +
      `after ${state.consecutiveFails} failures (last: ${failType})`,
    );

    return { delayMs: cooldownDuration, inCooldown: true, cooldownUntil: state.cooldown.until };
  }

  // If already in cool-down, extend it
  if (state.cooldown.active) {
    const remaining = state.cooldown.until - Date.now();
    if (remaining > 0) {
      return { delayMs: remaining, inCooldown: true, cooldownUntil: state.cooldown.until };
    }
    // Cool-down expired
    state.cooldown.active = false;
  }

  const delayMs = calculateBackoffDelay(state.backoffLevel);
  return { delayMs, inCooldown: false };
}

/**
 * Record a successful request for a domain (resets backoff).
 * Also exits cool-down early if enough consecutive successes.
 */
export function recordSmartRetrySuccess(domain: string): void {
  const state = domainRetryStates.get(domain);
  if (!state) return;

  state.consecutiveFails = 0;
  state.backoffLevel = 0;
  state.recentFailureTypes = [];

  // Exit cool-down on success
  if (state.cooldown.active) {
    state.cooldown.active = false;
    state.cooldown.until = 0;
  }
}

/**
 * Check if a domain is currently in cool-down mode.
 * Returns the remaining cool-down time in ms, or 0 if not in cool-down.
 */
export function isDomainInCooldown(domain: string): number {
  const state = domainRetryStates.get(domain);
  if (!state || !state.cooldown.active) return 0;

  const remaining = state.cooldown.until - Date.now();
  if (remaining <= 0) {
    state.cooldown.active = false;
    return 0;
  }
  return remaining;
}

/**
 * Get smart retry stats for monitoring.
 */
export function getSmartRetryStats(): Record<string, { consecutiveFails: number; backoffLevel: number; inCooldown: boolean; cooldownUntil: number }> {
  const result: Record<string, { consecutiveFails: number; backoffLevel: number; inCooldown: boolean; cooldownUntil: number }> = {};
  for (const [domain, state] of domainRetryStates) {
    if (state.consecutiveFails > 0 || state.cooldown.active) {
      result[domain] = {
        consecutiveFails: state.consecutiveFails,
        backoffLevel: state.backoffLevel,
        inCooldown: state.cooldown.active,
        cooldownUntil: state.cooldown.until,
      };
    }
  }
  return result;
}

/**
 * Wait for cool-down if a domain is currently in cool-down mode.
 * Returns true if we waited, false if no cool-down was active.
 */
export async function waitForCooldownIfActive(domain: string, signal?: AbortSignal): Promise<boolean> {
  const remaining = isDomainInCooldown(domain);
  if (remaining <= 0) return false;

  console.log(`[SmartRetry] Waiting for cool-down: ${domain} (${Math.round(remaining / 1000)}s remaining)`);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, remaining);
    if (signal) {
      if (signal.aborted) { clearTimeout(timer); reject(signal.reason || new Error('Aborted')); return; }
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason || new Error('Aborted')); }, { once: true });
    }
  });
  return true;
}

/**
 * Fetch with automatic engine fallback.
 * Tries the primary engine first; on qualifying failure, tries the next engine
 * in the fallback chain. Returns the first successful result.
 *
 * @param url - Target URL
 * @param options - Engine options (antiCrawl, timeout, etc.)
 * @param primaryEngine - The initially selected engine type
 * @returns FetchResult with effectiveEngine set to the engine that succeeded
 */
export async function fetchWithEngineFallback(
  url: string,
  options: EngineOptions | undefined,
  primaryEngine: EngineType,
): Promise<FetchResult> {
  const antiCrawl = options?.antiCrawl;
  const enabled = antiCrawl?.engineFallback !== false; // default true

  if (!enabled) {
    // Fallback disabled — use primary engine only
    const engine = getEngine(primaryEngine);
    const result = await engine.fetch(url, options);
    return { ...result, effectiveEngine: primaryEngine };
  }

  // Build fallback chain: custom > adaptive > default
  let domain = '';
  try { domain = new URL(url).hostname; } catch { /* invalid URL */ }

  const customChain = antiCrawl?.engineFallbackChain;
  const chain = customChain
    ? getAdaptiveFallbackChain(domain, customChain)
    : getAdaptiveFallbackChain(domain);

  // Ensure primary engine is first (unless custom chain overrides it)
  if (!customChain && chain[0] !== primaryEngine) {
    const idx = chain.indexOf(primaryEngine);
    if (idx > 0) {
      chain.splice(idx, 1);
      chain.unshift(primaryEngine);
    }
  }

  // Limit chain length to prevent excessive fallback attempts
  const maxChainLen = 3;
  if (chain.length > maxChainLen) {
    console.log(`[EngineFallback] Chain truncated from ${chain.length} to ${maxChainLen} engines`);
  }
  const truncatedChain = chain.slice(0, maxChainLen);

  if (truncatedChain.length === 0) {
    throw new Error('No engines available in fallback chain');
  }

  let lastError: unknown;

  for (let i = 0; i < truncatedChain.length; i++) {
    const engineType = truncatedChain[i];
    const engine = getEngine(engineType);

    try {
      const result = await engine.fetch(url, {
        ...options,
        // Reduce retries for fallback attempts (don't waste time retrying a failing engine)
        antiCrawl: {
          ...options?.antiCrawl,
          retries: i === 0 ? options?.antiCrawl?.retries : 0,
        },
      });

      // Record success for adaptive chain
      if (domain) recordEngineSuccess(domain, engineType);

      // Record domain-level success for smart engine pre-selection
      if (domain) recordDomainEngineSuccess(domain, engineType);

      // Log fallback if we didn't use the primary engine
      if (i > 0) {
        console.log(`[EngineFallback] Success with ${engineType} on attempt ${i + 1} for ${url} (primary was ${primaryEngine})`);
      }

      return { ...result, effectiveEngine: engineType };
    } catch (err) {
      lastError = err;
      const errMsg = err instanceof Error ? err.message : String(err);

      // Don't fallback on non-qualifying errors
      if (!isFallbackWorthyError(err)) throw err;

      // Record failure for adaptive chain (only for fallback-worthy errors)
      if (domain) recordEngineFailure(domain, engineType);

      console.warn(`[EngineFallback] ${engineType} failed for ${url}: ${errMsg.slice(0, 120)}${i < truncatedChain.length - 1 ? ' → trying next engine' : ' → no more engines'}`);
    }
  }

  // All engines failed — throw the last error
  throw lastError;
}

// ==================== Engine Registry ====================

const engines: Map<EngineType, ScrapingEngine> = new Map();

export function registerEngine(engine: ScrapingEngine): void {
  engines.set(engine.name, engine);
}

export function getEngine(type: EngineType): ScrapingEngine {
  const engine = engines.get(type);
  if (engine) return engine;
  // Fallback to cheerio (may be null if engines were closed)
  const fallback = engines.get("cheerio");
  if (fallback) {
    if (type !== "cheerio") {
      console.warn(`[Engine] Requested engine "${type}" not registered, falling back to cheerio`);
    }
    return fallback;
  }
  throw new Error(`[Engine] No engines available — requested "${type}" but engine registry is empty (engines may have been closed)`);
}

export function getEngineNames(): EngineType[] {
  return ["cheerio", "playwright", "firecrawl", "agentql", "cloud-browser", "scrapling", "obscura", "dokobot", "api"].filter((t) => engines.has(t));
}

// ==================== 1. Cheerio Engine (Enhanced HTTP) ====================

class CheerioEngine implements ScrapingEngine {
  readonly name: EngineType = "cheerio";

  async fetch(url: string, options?: EngineOptions): Promise<FetchResult> {
    if (!isSafeUrl(url)) {
      throw new Error(`Blocked: target URL is not allowed (${url})`);
    }

    // Pre-select UA: use per-domain profile UA for cross-engine identity consistency,
    // or fall back to stealth pool random UA for rotation mode.
    // This ensures CheerioEngine and Playwright/Obscura send the same UA to the same domain.
    let resolvedUA = options?.userAgent;
    if (!resolvedUA) {
      try {
        const domain = new URL(url).hostname;
        const profile = getProfileForDomain(domain);
        resolvedUA = profile.userAgent;
      } catch {
        resolvedUA = undefined;
      }
    }
    if (!resolvedUA && options?.antiCrawl?.uaRotation) {
      resolvedUA = getRandomUA();
    }
    const headers = buildFetchHeaders(options?.antiCrawl, resolvedUA, url, 'novel');
    const timeout = Math.max(5000, Math.min(options?.timeout ?? 30000, 300000));

    // Inject cookies from the cookie jar
    let targetDomain: string;
    try { targetDomain = new URL(url).hostname; } catch { targetDomain = ''; }
    if (targetDomain) {
      const jarCookieHeader = cookieJar.getCookieHeader(targetDomain, '/');
      if (jarCookieHeader) {
        // Merge with existing Cookie header or set new
        if (headers['Cookie']) {
          headers['Cookie'] = `${jarCookieHeader}; ${headers['Cookie']}`;
        } else {
          headers['Cookie'] = jarCookieHeader;
        }
      }
    }

    // Session-aware cookie injection
    const sessionInfo = sessionManager.getSessionForRequest(targetDomain);
    if (sessionInfo && sessionInfo.cookies) {
      if (headers['Cookie']) {
        headers['Cookie'] = `${sessionInfo.cookies}; ${headers['Cookie']}`;
      } else {
        headers['Cookie'] = sessionInfo.cookies;
      }
    }
    if (sessionInfo && sessionInfo.userAgent && !headers['User-Agent']) {
      headers['User-Agent'] = sessionInfo.userAgent;
    }

    // Proxy support: select best proxy for this domain
    const domainProxy = targetDomain ? proxyManager.getDomainProxyWithRotation(targetDomain) : null;
    const proxy = domainProxy || (options?.proxy ? proxyManager.getProxyWithFallback(targetDomain) : null);
    // Bun 1.3.x ignores the undici `dispatcher` option (verified in Task 6: requests
    // silently went direct) — use Bun's native `proxy` fetch option instead.
    const proxyFetchInit = proxy ? bunProxyFetchInit(proxy.url) : {};

    // Request fingerprint tracking
    const fp = requestFingerprintMgr.create({
      domain: targetDomain,
      engine: 'cheerio',
      sessionId: sessionInfo?.sessionId,
      proxyUrl: proxy?.url,
      userAgent: headers['User-Agent'] || '',
    });

    // Human behavior delay (randomized jitter before fetch)
    if (options?.antiCrawl?.humanBehavior) {
      const jitter = 200 + Math.random() * 300;
      await new Promise(r => setTimeout(r, jitter));
    }

    // Anti-fingerprint timing jitter (±50ms, always applied)
    await applyTimingJitter();

    // Pre-resolve the connection pool agent so it's available synchronously in makeRequest
    const poolAgent = proxy ? undefined : await getCheerioAgent();

    let lastStatusCode = 0;
    const fetchResult = await retryWithBackoff(
      async () => {
        // Per-domain rate limiting (adaptive backoff, max 3 retries, abort-aware)
        if (targetDomain) {
          await waitForRateLimit(targetDomain, options?.signal);
        }

        // Browser behavior: throttle if visiting same domain too frequently
        if (targetDomain) {
          const throttleCheck = browserBehavior.shouldThrottle(targetDomain);
          if (throttleCheck.throttled) {
            await new Promise(r => setTimeout(r, throttleCheck.waitMs));
          }
          browserBehavior.recordRequest(targetDomain);
        }

        const startTime = Date.now();
        let remainingTimeout = timeout;
        let statusCode = 0;
        try {
        const { response, finalUrl } = await followRedirects(url, {
          maxRedirects: 5,
          onRedirect: () => {
            // Deduct elapsed time from remaining timeout on each hop
            const elapsed = Date.now() - startTime;
            remainingTimeout = Math.max(5000, timeout - elapsed); // min 5s per redirect
          },
          onHopResponse: (resp, hopUrl) => {
            // Store Set-Cookie from every hop (including intermediate 3xx)
            // to handle SSO/consent redirects that set session cookies mid-chain
            if (targetDomain) {
              try {
                const hopDomain = new URL(hopUrl).hostname;
                const setCookieHeaders = resp.headers.getSetCookie?.() || [];
                if (setCookieHeaders.length > 0) {
                  cookieJar.store(hopDomain, setCookieHeaders);
                }
              } catch { /* invalid URL, skip */ }
            }
          },
          makeRequest: (fetchUrl) => {
            // Inject jar cookies for each redirect hop.
            // IMPORTANT: Clear the original Cookie header to prevent cross-domain cookie leakage.
            // The original headers contain cookies from the initial domain; on cross-domain
            // redirects, those cookies must NOT be sent to the new domain.
            const reqHeaders = { ...headers };
            delete reqHeaders['Cookie']; // Clear to prevent cross-domain leakage
            try {
              const hopDomain = new URL(fetchUrl).hostname;
              const hopCookieHeader = cookieJar.getCookieHeader(hopDomain, '/');
              if (hopCookieHeader) {
                reqHeaders['Cookie'] = hopCookieHeader;
              }
            } catch { /* invalid URL, skip */ }
            // Merge task-level abort with per-request timeout
            let reqSignal: AbortSignal;
            if (options?.signal?.aborted) {
              reqSignal = options.signal;
            } else if (options?.signal) {
              const combined = AbortSignal.any([options.signal, AbortSignal.timeout(remainingTimeout)]);
              reqSignal = combined;
            } else {
              reqSignal = AbortSignal.timeout(remainingTimeout);
            }
            // Build base fetch options
            const fetchOptions: Record<string, unknown> = {
              headers: reqHeaders,
              redirect: "manual",
              signal: reqSignal,
              // Bun-native proxy option (see proxyFetchInit above) — carries the
              // selected proxy so requests actually traverse it (Task 6 fix).
              ...proxyFetchInit,
              // @ts-expect-error - Bun supports dispatcher option (keep-alive pool when no proxy)
              dispatcher: poolAgent,
            };

            // Apply TLS fingerprint profile for anti-detection
            if (targetDomain) {
              try {
                const tlsFingerprint = getTLSFingerprintOptions(targetDomain, reqHeaders['User-Agent']);
                const tlsOpts: Record<string, unknown> = {
                  ciphers: tlsFingerprint.ciphers,
                  minVersion: tlsFingerprint.minVersion,
                };
                if (tlsFingerprint.sigalgs) {
                  tlsOpts.sigalgs = tlsFingerprint.sigalgs;
                }
                fetchOptions.tls = tlsOpts;
              } catch { /* TLS fingerprint lookup failure is non-critical */ }
            }

            return fetch(fetchUrl, fetchOptions as RequestInit);
          },
        });

        statusCode = response.status;
        lastStatusCode = statusCode;

        if (!response.ok) {
          // CRITICAL: Consume/cancel response body before throwing to prevent
          // undici Agent connection pool leak (unconsumed body pins connection)
          await response.body?.cancel().catch(() => {});
          // NOTE: proxy failure is recorded by onRetry callback below, NOT here,
          // to avoid double-recording on retry attempts.
          throw new Error(`HTTP ${response.status}: ${response.statusText} for ${url}`);
        }

        // Note: cookies from ALL hops (including final) are already stored by onHopResponse

        // Verify Content-Type is text-based
        const contentType = response.headers.get("content-type") || "";
        if (contentType && !contentType.includes("text") && !contentType.includes("html") && !contentType.includes("json") && !contentType.includes("xml")) {
          throw new Error(`Unexpected Content-Type "${contentType}" for ${url} - expected text/html`);
        }

        // Stream-read with size limit (prevents OOM on chunked responses without Content-Length)
        const html = (await readTextWithLimit(response, MAX_RESPONSE_SIZE)).replace(/^\uFEFF/, "");

        // CAPTCHA detection on response content
        if (targetDomain && html) {
          const captchaResult = detectCaptcha(html, finalUrl, statusCode);
          if (captchaResult.detected && captchaResult.confidence > 0.5) {
            console.warn(`[Cheerio] CAPTCHA detected on ${targetDomain}: type=${captchaResult.type}, confidence=${captchaResult.confidence}`);
            try {
              antiCrawlAdvisor.recordDetection(targetDomain, 'captcha', `CAPTCHA ${captchaResult.type}, confidence ${Math.round(captchaResult.confidence * 100)}%`);
            } catch { /* non-critical */ }
            // Record proxy failure on CAPTCHA (doNotRetry prevents retryWithBackoff
            // from calling onRetry, so this is the ONLY recording — no double-count)
            if (proxy) proxyManager.recordFailure(proxy.url, `CAPTCHA ${captchaResult.type} detected`);
            // Record CAPTCHA-triggered engine upgrade for future requests to this domain
            recordCaptchaUpgrade(targetDomain, 'cheerio');
            const captchaErr = new Error(`CAPTCHA detected (${captchaResult.type}, ${Math.round(captchaResult.confidence * 100)}%) on ${targetDomain}`);
            (captchaErr as any).doNotRetry = true;
            throw captchaErr;
          }
        }

        // Content-length hint: flag domain if cheerio returned very little content with 200
        // This suggests the page likely needs JS rendering to load actual content
        if (targetDomain && response.status === 200) {
          recordLowContentHint(targetDomain, html.length);
        }

        // Record proxy success (only on the final successful attempt)
        if (proxy && targetDomain) {
          proxyManager.recordSuccessWithRotation(proxy.url, targetDomain, Date.now() - startTime);
        } else if (proxy) {
          proxyManager.recordSuccess(proxy.url, Date.now() - startTime);
        }

        // Record URL in referrer chain for future requests
        referrerChain.recordVisit(finalUrl);

        // Browser behavior: simulate reading/scroll delay based on content length
        if (targetDomain) {
          await browserBehavior.getPreVisitDelay(url, html.length);
        }

        return { html, finalUrl, statusCode: response.status };
        } catch (err) {
          // NOTE: rateLimiter.recordResult and requestFingerprintMgr.complete
          // are called OUTSIDE retryWithBackoff (below) to avoid double-counting
          // retry attempts as separate requests.
          throw err;
        }
      },
      {
        maxRetries: options?.antiCrawl?.retries ?? 2,
        baseDelay: 1000,
        maxDelay: 15000,
        signal: options?.signal,
        onRetry: proxy ? (_attempt, err) => {
          proxyManager.recordFailure(proxy.url, err instanceof Error ? err.message : String(err));
        } : undefined,
      }
    ).then(result => {
      // Record final success (single record for the logical request)
      if (targetDomain) {
        rateLimiter.recordResult(targetDomain, true, lastStatusCode);
        antiCrawlAdvisor.recordSuccess(targetDomain);
      }
      requestFingerprintMgr.complete(fp.requestId, true, lastStatusCode);
      return result;
    }).catch(err => {
      // Record proxy failure for the final exhausted-retry attempt.
      // onRetry handles intermediate retries, but the last attempt (which breaks
      // out of the retry loop) falls through to here without onRetry being called.
      // Skip for doNotRetry errors (CAPTCHA/size-limit) — they're already
      // recorded by the inline proxy failure recording before the throw.
      const isRetryExhausted = !(err instanceof Error && (err as Record<string, unknown>).doNotRetry);
      if (proxy && isRetryExhausted) {
        proxyManager.recordFailure(proxy.url, err instanceof Error ? err.message : String(err));
      }
      // Record final failure (single record for the logical request)
      if (targetDomain) {
        const errStatus = err instanceof Error ? parseInt(err.message.match(/HTTP (\d+)/)?.[1] || '0', 10) : 0;
        rateLimiter.recordResult(targetDomain, false, errStatus || lastStatusCode || undefined);
        try { antiCrawlAdvisor.recordFailure(targetDomain); } catch { /* non-critical */ }
      }
      requestFingerprintMgr.complete(fp.requestId, false, lastStatusCode);
      throw err;
    });

    return fetchResult;
  }
}

// ==================== 2. Playwright Engine (JS Rendering) ====================

let playwrightBrowser: import("playwright").Browser | null = null;
let playwrightLaunchPromise: Promise<import("playwright").Browser> | null = null;
let _pwLaunchLock: Promise<void> | null = null;

async function getPlaywrightBrowser(): Promise<import("playwright").Browser> {
  if (playwrightBrowser?.isConnected()) return playwrightBrowser;

  if (playwrightLaunchPromise) {
    // Wait for existing launch to complete (using promise, not busy-wait)
    try {
      playwrightBrowser = await playwrightLaunchPromise;
      if (playwrightBrowser?.isConnected()) return playwrightBrowser;
    } catch {
      // Launch failed, clear stale promise before retry
      playwrightLaunchPromise = null;
      // fall through to re-launch
    }
  }

  // Serialize launch to prevent orphaned browsers
  const lock = _pwLaunchLock || (_pwLaunchLock = Promise.resolve());
  playwrightLaunchPromise = lock.then(async () => {
    try {
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({
        headless: true,
        timeout: 30000,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-extensions",
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
          "--no-first-run",
          "--no-default-browser-check",
          // Anti-detection: prevent navigator.webdriver leak via Chrome flag
          "--disable-blink-features=AutomationControlled",
        ],
      });
      console.log("[Playwright] Browser launched successfully");

      // Handle browser close
      browser.on("disconnected", () => {
        console.log("[Playwright] Browser disconnected");
        playwrightBrowser = null;
        playwrightLaunchPromise = null;
      });

      return browser;
    } finally {
      _pwLaunchLock = null;
    }
  });

  playwrightBrowser = await playwrightLaunchPromise;
  return playwrightBrowser!;
}

class PlaywrightEngine implements ScrapingEngine {
  readonly name: EngineType = "playwright";

  async fetch(url: string, options?: EngineOptions): Promise<FetchResult> {
    if (!isSafeUrl(url)) {
      throw new Error(`Blocked: target URL is not allowed (${url})`);
    }

    const timeout = Math.max(5000, Math.min(options?.timeout ?? 45000, 300000));
    const userAgent = options?.userAgent || (options?.antiCrawl?.uaRotation ? getRandomUA() : undefined);
    const cookies = options?.cookies || options?.antiCrawl?.cookies;

    // Get domain for cookie jar integration
    let pwDomain: string;
    try { pwDomain = new URL(url).hostname; } catch { pwDomain = ''; }

    // Track last status code for outer recordResult (avoids double-counting in retries)
    let lastPwStatusCode = 0;

    // Session-aware integration (for fingerprint tracking)
    const sessionInfo = pwDomain ? sessionManager.getSessionForRequest(pwDomain) : null;

    // Build stealth profile for this domain (needed for fingerprint + context)
    const pwProfile = pwDomain ? getProfileForDomain(pwDomain) : getProfileForDomain('default');

    // Request fingerprint tracking (proxy selected per-retry inside loop)
    const fp = requestFingerprintMgr.create({
      domain: pwDomain,
      engine: 'playwright',
      sessionId: sessionInfo?.sessionId,
      proxyUrl: undefined, // proxy selected per-retry inside loop
      userAgent: userAgent || pwProfile.userAgent,
    });

    return retryWithBackoff(
      async () => {
        // Anti-fingerprint timing jitter (±50ms, always applied)
        await applyTimingJitter();

        // Per-domain rate limiting (adaptive backoff, max 3 retries, abort-aware)
        if (pwDomain) {
          await waitForRateLimit(pwDomain, options?.signal);
        }

        // Browser behavior: throttle if visiting same domain too frequently
        if (pwDomain) {
          const throttleCheck = browserBehavior.shouldThrottle(pwDomain);
          if (throttleCheck.throttled) {
            await new Promise(r => setTimeout(r, throttleCheck.waitMs));
          }
          browserBehavior.recordRequest(pwDomain);
        }

        // Select proxy for this domain (with rotation if configured) — inside retry for rotation between retries
        const fpDomainProxy = pwDomain ? proxyManager.getDomainProxyWithRotation(pwDomain) : null;
        const pwProxy = fpDomainProxy || (options?.proxy ? proxyManager.getProxyWithFallback(pwDomain) : null);

        const browser = await getPlaywrightBrowser();

        const pwStartTime = Date.now();

        // Build context options with viewport, locale, timezone matching stealth profile (pwProfile from outer scope)
        const contextOptions: Record<string, unknown> = {
          userAgent: pwProfile.userAgent,
          viewport: {
            width: pwProfile.screenWidth,
            height: pwProfile.screenHeight,
            deviceScaleFactor: pwProfile.pixelRatio,
          },
          locale: pwProfile.languages[0] || 'zh-CN',
          timezoneId: pwProfile.timezone,
          screen: {
            width: pwProfile.screenWidth,
            height: pwProfile.screenHeight,
            colorDepth: pwProfile.colorDepth,
          },
          bypassCSP: true,
          ignoreHTTPSErrors: true,
          serviceWorkers: 'block' as const,
        };
        if (pwProxy) {
          contextOptions.proxy = { server: pwProxy.url };
          if (process.env.DEBUG === 'true') {
            console.log(`[Playwright] Using proxy ${pwProxy.url} for ${pwDomain}`);
          }
        }
        const context = await browser.newContext(contextOptions);

        // Add cookies from jar + user-provided cookies
        const jarCookies = pwDomain ? cookieJar.getPlaywrightCookies(pwDomain) : [];
        const allCookies = [
          ...jarCookies,
          ...(cookies?.length ? cookies.filter((c) => c.name && c.value).map((c) => ({
            name: c.name.replace(/[\r\n\t\x00-\x1f]/g, ""),
            value: c.value.replace(/[\r\n\t\x00-\x1f]/g, ""),
            domain: pwDomain,
            path: "/",
          })) : []),
        ];
        if (allCookies.length > 0) {
          await context.addCookies(allCookies);
        }

        try {
          const page = await context.newPage();

          // Always inject stealth script for anti-fingerprint protection
          await page.addInitScript(getStealthScript(pwProfile));

          // Block resources by type + cross-origin 3rd-party + SSRF protection
          // Uses shouldBlockResource helper for centralized anti-detection resource policy
          await page.route('**/*', async (route) => {
            try {
              const resourceType = route.request().resourceType();
              const routeUrl = route.request().url();

              if (shouldBlockResource(resourceType, routeUrl, pwDomain)) {
                route.abort();
                return;
              }

              // SSRF protection: block non-HTTP/HTTPS navigations and unsafe targets
              // Cover all navigational/sub-document types (iframe/other) in addition to document/xhr/fetch
              if (!routeUrl.startsWith('http://') && !routeUrl.startsWith('https://')) {
                if (['document', 'xhr', 'fetch', 'iframe', 'other'].includes(resourceType)) {
                  route.abort();
                  return;
                }
              }
              if (['document', 'xhr', 'fetch', 'iframe', 'other'].includes(resourceType) && !isSafeUrl(routeUrl)) {
                route.abort();
                return;
              }

              // Behavioral analysis: scan same-domain scripts for bot-detection patterns
              if (ENABLE_SCRIPT_CONTENT_ANALYSIS && resourceType === 'script') {
                try {
                  const resp = await route.fetch();
                  let body;
                  try {
                    body = await resp.text();
                  } catch {
                    // Fetch succeeded but reading body failed — abort (request already made)
                    try { await route.abort(); } catch { /* already handled */ }
                    return;
                  }
                  if (hasBotDetectionBehavioralPatterns(body)) {
                    if (process.env.DEBUG === 'true') {
                      console.log(`[Playwright] Blocked bot-detection script (behavioral): ${routeUrl.slice(0, 120)}`);
                    }
                    await route.abort();
                    return;
                  }
                  await route.fulfill({ response: resp });
                  return;
                } catch {
                  // route.fetch() itself failed — continue with original request
                  await route.continue();
                  return;
                }
              }

              route.continue();
            } catch (routeErr) {
              // If route handling fails (e.g., request cancelled), abort to prevent hang
              try { route.abort(); } catch { /* already handled */ }
            }
          });

          // Set extra headers — use profile UA (not a random/hardcoded one) to ensure
          // HTTP User-Agent matches what the stealth script injects into navigator.userAgent
          const pwHeadersUA = pwProfile.userAgent;
          const enhancedHeaders = buildFetchHeaders(options?.antiCrawl, pwHeadersUA, url, 'novel');
          // Override Accept-Language to match profile.languages (stealth script sets navigator.languages from profile)
          enhancedHeaders['Accept-Language'] = profileLanguagesToAcceptLanguage(pwProfile.languages);
          // Remove User-Agent from extra headers — context-level UA (pwProfile.userAgent) takes precedence;
          // sending a duplicate via setExtraHTTPHeaders can conflict with Playwright's UA management.
          delete enhancedHeaders['User-Agent'];
          const clientHints = getChromeClientHints(pwProfile.userAgent);
          if (clientHints) Object.assign(enhancedHeaders, clientHints);
          await page.setExtraHTTPHeaders(enhancedHeaders);

          // Navigate with timeout
          const response = await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout,
          });

          if (!response) {
            throw new Error(`No response from ${url}`);
          }

          const responseStatus = response.status();

          // Wait for network idle (give JS time to render content)
          await page.waitForLoadState("networkidle", { timeout: 10000 }).catch((err) => {
            // Only swallow timeout errors; re-throw page crashes/navigation errors
            if (!err.message?.includes('Timeout')) throw err;
          });

          // ---- Human behavior simulation or simple scroll fallback ----
          if (options?.antiCrawl?.humanBehavior) {
            try {
              // 1. Simple mouse movement: natural curve from start to end
              const startX = 50 + Math.floor(Math.random() * 300), startY = 100 + Math.floor(Math.random() * 300);
              const endX = 300 + Math.floor(Math.random() * 600), endY = 200 + Math.floor(Math.random() * 400);
              const steps = 12 + Math.floor(Math.random() * 8);
              let curX = startX, curY = startY;
              for (let i = 0; i < steps; i++) {
                const t = i / steps;
                curX = startX + (endX - startX) * t + (Math.random() - 0.5) * 30;
                curY = startY + (endY - startY) * t + (Math.random() - 0.5) * 20;
                await page.mouse.move(curX, curY);
                await new Promise((r) => setTimeout(r, 10 + Math.random() * 30));
              }

              // 2. Random idle micro-movements (hand tremor)
              for (let j = 0; j < 1 + Math.floor(Math.random() * 2); j++) {
                await page.mouse.move(
                  curX + (Math.random() - 0.5) * 10,
                  curY + (Math.random() - 0.5) * 10
                );
                curX += (Math.random() - 0.5) * 10;
                curY += (Math.random() - 0.5) * 10;
                await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
              }

              // 3. Occasional link hover (30% chance)
              if (Math.random() < 0.3) {
                try {
                  const links = await page.$$("a[href]");
                  if (links.length > 0) {
                    const randomLink = links[Math.floor(Math.random() * links.length)];
                    const box = await randomLink.boundingBox();
                    if (box) {
                      const hoverX = box.x + box.width * (0.3 + Math.random() * 0.4);
                      const hoverY = box.y + box.height / 2;
                      const linkSteps = 5 + Math.floor(Math.random() * 5);
                      for (let k = 0; k < linkSteps; k++) {
                        const lt = k / linkSteps;
                        await page.mouse.move(
                          curX + (hoverX - curX) * lt + (Math.random() - 0.5) * 8,
                          curY + (hoverY - curY) * lt + (Math.random() - 0.5) * 8
                        );
                        await new Promise((r) => setTimeout(r, 10 + Math.random() * 25));
                      }
                      curX = hoverX;
                      curY = hoverY;
                      await new Promise((r) => setTimeout(r, 300 + Math.random() * 500));
                    }
                  }
                } catch { /* link hover failure is non-critical */ }
              }

              // 4. Multi-segment scroll with reading pauses
              const pageHeight = await page.evaluate(() => document.body.scrollHeight || document.body.clientHeight || 3000);
              const segments = 3 + Math.floor(Math.random() * 3);
              const scrollStep = Math.floor(pageHeight / segments);
              for (let s = 1; s <= segments; s++) {
                const overshoot = (Math.random() - 0.5) * 40;
                let targetY = scrollStep * s + overshoot;
                if (s === segments) {
                  targetY = pageHeight - 200 + (Math.random() - 0.5) * 100;
                }
                targetY = Math.max(0, targetY);
                await page.evaluate((y) => {
                  window.scrollTo({ top: y, behavior: "smooth" });
                }, targetY);
                await new Promise((r) => setTimeout(r, 300 + Math.random() * 500));
                const readPause = 500 + Math.random() * 1500;
                await new Promise((r) => setTimeout(r, readPause));
                await page.mouse.move(
                  curX + (Math.random() - 0.5) * 12,
                  curY + (Math.random() - 0.5) * 12
                );
                curX += (Math.random() - 0.5) * 12;
                curY += (Math.random() - 0.5) * 12;
              }

              // 5. Random delay before extraction
              await new Promise((r) => setTimeout(r, 200 + Math.random() * 400));
            } catch {
              // Human behavior simulation failure is non-critical
              console.log("[Playwright] Human behavior simulation failed, continuing with extraction");
            }
          } else {
            // Simple scroll-to-bottom fallback
            await page.evaluate(() => {
              window.scrollTo(0, document.body.scrollHeight);
            }).catch(() => {});
            // Brief wait for lazy-load triggers
            await new Promise((resolve) => setTimeout(resolve, 800));
          }

          const html = await page.content();
          if (html.length > MAX_RESPONSE_SIZE) {
            const pwSizeErr = new Error(`Playwright page content too large: ${html.length} bytes (max 10MB)`);
            (pwSizeErr as any).doNotRetry = true;
            throw pwSizeErr;
          }
          const finalUrl = page.url();

          // CAPTCHA detection
          let pwCaptcha: CaptchaDetection | null = null;
          const pwStatus = responseStatus;
          if (pwStatus === 403 || pwStatus === 503 || /(?:<iframe[^>]+src=["'][^"']*(?:captcha|challenge|recaptcha)|captcha|challenge-platform|_cf_chl|turnstile)/i.test(html.slice(0, 8000))) {
            pwCaptcha = detectCaptcha(html, finalUrl, pwStatus);
            if (pwCaptcha.detected && pwCaptcha.confidence > 0.5) {
              console.warn(`[Playwright] CAPTCHA detected on ${pwDomain}: type=${pwCaptcha.type}, confidence=${pwCaptcha.confidence}`);
              try {
                antiCrawlAdvisor.recordDetection(pwDomain, 'captcha', `CAPTCHA ${pwCaptcha.type} detected, confidence ${Math.round(pwCaptcha.confidence * 100)}%`);
              } catch { /* non-critical */ }
              // Mark as doNotRetry — CAPTCHAs are deterministic for same fingerprint/proxy
              // Record CAPTCHA-triggered engine upgrade for future requests to this domain
              recordCaptchaUpgrade(pwDomain, 'playwright');
              const pwCaptchaErr = new Error(`CAPTCHA detected (${pwCaptcha.type}, ${Math.round(pwCaptcha.confidence * 100)}%) on ${pwDomain}`);
              (pwCaptchaErr as any).doNotRetry = true;
              throw pwCaptchaErr;
            }
          }

          // Store cookies back to jar after navigation
          if (pwDomain) {
            try {
              const browserCookies = await context.cookies();
              if (browserCookies.length > 0) {
                // Convert Playwright cookies to set-cookie-like format for jar
                const setCookieHeaders = browserCookies.map(c => {
                  let header = `${c.name}=${c.value}`;
                  if (c.domain) header += `; Domain=${c.domain}`;
                  if (c.path) header += `; Path=${c.path}`;
                  if (c.httpOnly) header += '; HttpOnly';
                  if (c.secure) header += '; Secure';
                  if (c.expires > 0) header += `; Expires=${new Date(c.expires * 1000).toUTCString()}`;
                  return header;
                });
                cookieJar.store(pwDomain, setCookieHeaders);
              }
            } catch { /* ignore cookie extraction errors */ }
          }

          // Record URL in referrer chain for future requests
          referrerChain.recordVisit(finalUrl);

          // Track last status code for outer recordResult
          lastPwStatusCode = responseStatus;

          // Record proxy health for Playwright engine
          if (pwProxy && pwDomain) {
            proxyManager.recordSuccessWithRotation(pwProxy.url, pwDomain, Date.now() - pwStartTime);
          } else if (pwProxy) {
            proxyManager.recordSuccess(pwProxy.url, Date.now() - pwStartTime);
          }

          return {
            html,
            finalUrl,
            statusCode: responseStatus,
            captcha: pwCaptcha?.detected ? pwCaptcha : undefined,
          };
        } catch (err) {
          // Track error status for outer recordResult
          lastPwStatusCode = err instanceof Error ? parseInt(err.message.match(/HTTP (\d+)/)?.[1] || '0', 10) : 0;
          // Record proxy failure for Playwright engine (per-retry, but NOT for CAPTCHA
          // since CAPTCHA is a site-level detection, not a proxy issue)
          const isCaptchaErr = err instanceof Error && err.message.startsWith('CAPTCHA detected');
          if (pwProxy && !isCaptchaErr) {
            proxyManager.recordFailure(pwProxy.url, err instanceof Error ? err.message : String(err));
          }
          // NOTE: rateLimiter.recordResult is called OUTSIDE retryWithBackoff (below)
          // to avoid double-counting retry attempts as separate requests.
          throw err;
        } finally {
          try {
            await context.close();
          } catch {
            // Playwright close() has built-in timeout; swallow errors
          }
        }
      },
      {
        maxRetries: options?.antiCrawl?.retries ?? 2,
        baseDelay: 2000,
        maxDelay: 20000,
        signal: options?.signal,
        // No onRetry callback — proxy failure is recorded per-attempt in the catch block above.
        // Using onRetry would cause double-recording (catch + onRetry) for each failed retry.
        onRetry: undefined,
      }
    ).then(result => {
      // Record final success (single record for the logical request)
      if (pwDomain) {
        rateLimiter.recordResult(pwDomain, true, lastPwStatusCode);
        try { antiCrawlAdvisor.recordSuccess(pwDomain); } catch { /* non-critical */ }
      }
      requestFingerprintMgr.complete(fp.requestId, true, lastPwStatusCode);
      return result;
    }).catch(err => {
      // Record final failure (single record for the logical request)
      if (pwDomain) {
        rateLimiter.recordResult(pwDomain, false, lastPwStatusCode || undefined);
        try { antiCrawlAdvisor.recordFailure(pwDomain); } catch { /* non-critical */ }
      }
      requestFingerprintMgr.complete(fp.requestId, false, lastPwStatusCode);
      throw err;
    });
  }

  async close(): Promise<void> {
    if (playwrightBrowser?.isConnected()) {
      await playwrightBrowser.close().catch(() => {});
      playwrightBrowser = null;
      console.log("[Playwright] Browser closed");
    }
  }
}

// ==================== 3. Firecrawl Engine (External API) ====================

const DEFAULT_FIRECRAWL_CONFIG: FirecrawlConfig = {
  apiUrl: process.env.FIRECRAWL_API_URL || "https://localhost:3002",
  apiKey: process.env.FIRECRAWL_API_KEY || undefined,
  timeout: 60000,
};

function getFirecrawlConfig(): FirecrawlConfig {
  return DEFAULT_FIRECRAWL_CONFIG;
}

class FirecrawlEngine implements ScrapingEngine {
  readonly name: EngineType = "firecrawl";

  async fetch(url: string, options?: EngineOptions): Promise<FetchResult> {
    if (!isSafeUrl(url)) {
      throw new Error(`Blocked: target URL is not allowed (${url})`);
    }

    const config = getFirecrawlConfig();
    if (!config.apiUrl.startsWith('http://') && !config.apiUrl.startsWith('https://')) {
      throw new Error(`Invalid Firecrawl API URL (must start with http:// or https://): ${config.apiUrl}`);
    }
    const timeout = Math.max(5000, Math.min(options?.timeout ?? config.timeout ?? 60000, 300000));

    let fcDomain = '';
    try { fcDomain = new URL(url).hostname; } catch { /* ignore */ }

    return retryWithBackoff(
      async () => {
        await firecrawlBreaker.acquire(); // Check on each retry attempt
        try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (config.apiKey) {
          headers["Authorization"] = `Bearer ${config.apiKey}`;
        }

        const response = await fetch(`${config.apiUrl}/v1/scrape`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            url,
            formats: ["html", "markdown"],
            onlyMainContent: true,
          }),
          signal: options?.signal?.aborted ? options.signal : (options?.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout)),
        });

        if (!response.ok) {
          const errorBody = await response.text().catch(() => "");
          throw new Error(`Firecrawl API error: HTTP ${response.status} - ${errorBody}`);
        }

        let data;
        try {
          data = await response.json();
        } catch {
          throw new Error(`[Firecrawl] Invalid JSON response from Firecrawl API (HTTP ${response.status})`);
        }
        data = data as {
          success?: boolean;
          html?: string;
          markdown?: string;
          error?: string;
        };

        if (data.html && data.html.length > MAX_RESPONSE_SIZE) {
          const fcSizeErr = new Error(`Firecrawl HTML too large: ${data.html.length} bytes`);
          (fcSizeErr as any).doNotRetry = true;
          throw fcSizeErr;
        }

        if (!data.success && data.error) {
          throw new Error(`Firecrawl error: ${data.error}`);
        }

        // Firecrawl returns cleaned HTML (main content only)
        // Reconstruct a full HTML for cheerio to parse
        const html = data.html || `<html><body>${data.markdown || ""}</body></html>`;

        firecrawlBreaker.recordSuccess();

        return {
          html,
          finalUrl: url,
          statusCode: response.status,
        };
        } catch (err) {
          // Don't record circuit breaker failure for user aborts or doNotRetry errors,
          // but MUST release the half-open in-flight slot to prevent counter leak.
          if (err instanceof DOMException && err.name === 'AbortError') {
            firecrawlBreaker.release();
            throw err;
          }
          if (!(err instanceof Error && (err as any).doNotRetry)) {
            firecrawlBreaker.recordFailure();
          } else {
            firecrawlBreaker.release(); // doNotRetry (e.g. size limit) is not a service failure
          }
          throw err;
        }
      },
      {
        maxRetries: 2,
        baseDelay: 3000,
        maxDelay: 30000,
        signal: options?.signal,
      }
    ).then(result => {
      if (fcDomain) rateLimiter.recordResult(fcDomain, true, result.statusCode);
      return result;
    }).catch(err => {
      if (fcDomain) rateLimiter.recordResult(fcDomain, false, undefined);
      throw err;
    });
  }
}

const DEFAULT_AGENTQL_API_URL = "https://api.agentql.com";
const DEFAULT_AGENTQL_QUERY: AgentQLQuery = {
  title: "extract the title of this page",
  author: "extract the author name",
  category: "extract the category or genre",
  description: "extract the description or summary text",
  cover: "extract the URL of the cover image",
  status: "extract the serialization status",
  chapters: "extract the list of chapter titles and their links",
  content: "extract the main text content of this page",
};

function getAgentQLConfig(): { apiUrl: string; apiKey: string | undefined; timeout: number } {
  return {
    apiUrl: process.env.AGENTQL_API_URL || DEFAULT_AGENTQL_API_URL,
    apiKey: process.env.AGENTQL_API_KEY || undefined,
    timeout: 60000,
  };
}

/**
 * Reconstruct HTML from an AgentQL response object.
 * Converts the structured extraction result into a simple HTML document
 * that can be parsed by cheerio downstream.
 */
function reconstructHtmlFromAgentQL(data: Record<string, unknown>): string {
  const bodyParts: string[] = [];

  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue;

    if (typeof value === "string") {
      bodyParts.push(`  <div data-agentql-field="${escapeHtml(key)}">${escapeHtml(value)}</div>`);
    } else if (Array.isArray(value)) {
      // Array of objects (e.g., chapter list)
      for (const item of value) {
        if (typeof item === "string") {
          bodyParts.push(`  <div data-agentql-field="${escapeHtml(key)}">${escapeHtml(item)}</div>`);
        } else if (typeof item === "object" && item !== null) {
          const itemParts: string[] = [];
          for (const [subKey, subValue] of Object.entries(item as Record<string, unknown>)) {
            if (subValue !== null && subValue !== undefined) {
              itemParts.push(`<span data-agentql-field="${escapeHtml(subKey)}">${escapeHtml(String(subValue))}</span>`);
            }
          }
          bodyParts.push(`  <div data-agentql-field="${escapeHtml(key)}" data-agentql-item="true">${itemParts.join(" ")}</div>`);
        }
      }
    } else if (typeof value === "object" && value !== null) {
      // Nested object
      const itemParts: string[] = [];
      for (const [subKey, subValue] of Object.entries(value as Record<string, unknown>)) {
        if (subValue !== null && subValue !== undefined) {
          itemParts.push(`<span data-agentql-field="${escapeHtml(subKey)}">${escapeHtml(String(subValue))}</span>`);
        }
      }
      bodyParts.push(`  <div data-agentql-field="${escapeHtml(key)}">${itemParts.join(" ")}</div>`);
    }
  }

  return `<!DOCTYPE html>\n<html><body>\n${bodyParts.join("\n")}\n</body></html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

class AgentQLEngine implements ScrapingEngine {
  readonly name: EngineType = "agentql";

  async fetch(url: string, options?: EngineOptions): Promise<FetchResult> {
    if (!isSafeUrl(url)) {
      throw new Error(`Blocked: target URL is not allowed (${url})`);
    }

    const config = getAgentQLConfig();
    const timeout = Math.max(5000, Math.min(options?.timeout ?? config.timeout ?? 60000, 300000));

    let aqlDomain = '';
    try { aqlDomain = new URL(url).hostname; } catch { /* ignore */ }

    // Build the natural language query from the AgentQL query fields
    // AgentQL uses a structured query object where each field maps to a NL prompt
    const query = DEFAULT_AGENTQL_QUERY;
    const agentqlQuery: Record<string, string> = {};
    for (const [key, prompt] of Object.entries(query)) {
      if (prompt) {
        agentqlQuery[key] = prompt;
      }
    }

    return retryWithBackoff(
      async () => {
        await agentqlBreaker.acquire(); // Check on each retry attempt
        try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (config.apiKey) {
          headers["Authorization"] = `Bearer ${config.apiKey}`;
          // AgentQL also supports x-api-key header
          headers["x-api-key"] = config.apiKey;
        }

        const response = await fetch(`${config.apiUrl}/v1/extract`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            url,
            query: agentqlQuery,
          }),
          signal: options?.signal?.aborted ? options.signal : (options?.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout)),
        });

        if (!response.ok) {
          const errorBody = await response.text().catch(() => "");
          throw new Error(`AgentQL API error: HTTP ${response.status} - ${errorBody}`);
        }

        let data;
        try {
          data = await response.json();
        } catch {
          throw new Error(`[AgentQL] Invalid JSON response from AgentQL API (HTTP ${response.status})`);
        }
        data = data as {
          data?: Record<string, unknown>;
          error?: string;
        };

        // Check response data size
        const dataJsonSize = JSON.stringify(data.data || {});
        if (dataJsonSize.length > MAX_RESPONSE_SIZE) {
          const sizeError = new Error(`AgentQL response too large`);
          (sizeError as any).doNotRetry = true;
          throw sizeError;
        }

        if (data.error) {
          throw new Error(`AgentQL error: ${data.error}`);
        }

        // Reconstruct HTML from AgentQL structured response
        const extractedData = data.data || {};
        const html = reconstructHtmlFromAgentQL(extractedData);

        agentqlBreaker.recordSuccess();

        return {
          html,
          finalUrl: url,
          statusCode: response.status,
        };
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            agentqlBreaker.release();
            throw err;
          }
          if (!(err instanceof Error && (err as any).doNotRetry)) {
            agentqlBreaker.recordFailure();
          } else {
            agentqlBreaker.release();
          }
          throw err;
        }
      },
      {
        maxRetries: 2,
        baseDelay: 3000,
        maxDelay: 30000,
        signal: options?.signal,
      }
    ).then(result => {
      if (aqlDomain) rateLimiter.recordResult(aqlDomain, true, result.statusCode);
      return result;
    }).catch(err => {
      if (aqlDomain) rateLimiter.recordResult(aqlDomain, false, undefined);
      throw err;
    });
  }
}

// ==================== 5. CloudBrowser Engine (Browserless / Steel) ====================

function getCloudBrowserConfig(): {
  provider: "browserless" | "steel";
  apiUrl: string;
  apiKey: string | undefined;
  timeout: number;
} {
  const provider = (process.env.CLOUD_BROWSER_PROVIDER || "browserless") as "browserless" | "steel";

  let apiUrl: string;
  let apiKey: string | undefined;

  if (provider === "steel") {
    apiUrl = process.env.STEEL_API_URL || "https://api.steel.dev";
    apiKey = process.env.STEEL_API_KEY || undefined;
  } else {
    apiUrl = process.env.BROWSERLESS_API_URL || "https://chrome.browserless.io";
    apiKey = process.env.BROWSERLESS_API_KEY || undefined;
  }

  return {
    provider,
    apiUrl,
    apiKey,
    timeout: 60000,
  };
}

class CloudBrowserEngine implements ScrapingEngine {
  readonly name: EngineType = "cloud-browser";

  async fetch(url: string, options?: EngineOptions): Promise<FetchResult> {
    if (!isSafeUrl(url)) {
      throw new Error(`Blocked: target URL is not allowed (${url})`);
    }

    const config = getCloudBrowserConfig();
    const timeout = Math.max(5000, Math.min(options?.timeout ?? config.timeout ?? 60000, 300000));

    let cbDomain = '';
    try { cbDomain = new URL(url).hostname; } catch { /* ignore */ }

    return retryWithBackoff(
      async () => {
        await cloudBrowserBreaker.acquire(); // Check on each retry attempt
        try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (config.apiKey) {
          if (config.provider === "steel") {
            headers["Authorization"] = `Bearer ${config.apiKey}`;
          } else {
            // Browserless uses token as query param or basic auth
            headers["Authorization"] = `Basic ${Buffer.from(`token:${config.apiKey}`).toString("base64")}`;
          }
        }

        let response: Response;
        let html: string;
        let statusCode: number;

        if (config.provider === "steel") {
          // Steel API: POST /scrape
          response = await fetch(`${config.apiUrl}/scrape`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              url,
              timeout: timeout,
              renderJs: true,
            }),
            signal: options?.signal?.aborted ? options.signal : (options?.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout + 5000)]) : AbortSignal.timeout(timeout + 5000)),
          });

          if (!response.ok) {
            const errorBody = await response.text().catch(() => "");
            throw new Error(`Steel API error: HTTP ${response.status} - ${errorBody}`);
          }

          let data;
          try {
            data = await response.json();
          } catch {
            throw new Error(`[CloudBrowser/Steel] Invalid JSON response from Steel API (HTTP ${response.status})`);
          }
          data = data as {
            html?: string;
            status?: number;
            error?: string;
          };

          if (data.html && data.html.length > MAX_RESPONSE_SIZE) {
            const steelSizeErr = new Error(`Steel API HTML too large: ${data.html.length} bytes`);
            (steelSizeErr as any).doNotRetry = true;
            throw steelSizeErr;
          }

          if (data.error) {
            throw new Error(`Steel error: ${data.error}`);
          }

          html = data.html || "";
          statusCode = data.status || response.status;
        } else {
          // Browserless API: POST /content
          // API key passed via Authorization header (not URL query param) to prevent leakage
          const browserlessHeaders: Record<string, string> = { "Content-Type": "application/json" };
          if (config.apiKey) {
            browserlessHeaders["Authorization"] = `Basic ${Buffer.from(`token:${config.apiKey}`).toString("base64")}`;
          }

          response = await fetch(`${config.apiUrl}/content`, {
            method: "POST",
            headers: browserlessHeaders,
            body: JSON.stringify({
              url,
              waitFor: 3000,
              elements: [{ selector: "body" }],
            }),
            signal: options?.signal?.aborted ? options.signal : (options?.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout + 5000)]) : AbortSignal.timeout(timeout + 5000)),
          });

          if (!response.ok) {
            const errorBody = await response.text().catch(() => "");
            throw new Error(`Browserless API error: HTTP ${response.status} - ${errorBody}`);
          }

          let data;
          try {
            data = await response.json();
          } catch {
            throw new Error(`[CloudBrowser/Browserless] Invalid JSON response from Browserless API (HTTP ${response.status})`);
          }
          data = data as {
            html?: string;
            data?: Array<{ html?: string; results?: Array<{ html?: string }> }>;
            error?: string;
          };

          if (data.html && data.html.length > MAX_RESPONSE_SIZE) {
            const blSizeErr = new Error(`Browserless response too large: ${data.html.length} bytes`);
            (blSizeErr as any).doNotRetry = true;
            throw blSizeErr;
          }

          if (data.error) {
            throw new Error(`Browserless error: ${data.error}`);
          }

          // Browserless /content returns { data: [{ html }] } or { data: [{ results: [{ html }] }] }
          if (data.data && data.data.length > 0) {
            const element = data.data[0];
            html = element?.html || element?.results?.[0]?.html || "";
          } else if (data.html) {
            html = data.html;
          } else {
            html = "";
          }

          // Check size of ACTUAL html (the data.html check above only covers one code path)
          if (html.length > MAX_RESPONSE_SIZE) {
            const blSizeErr2 = new Error(`Browserless response too large: ${html.length} bytes (max 10MB)`);
            (blSizeErr2 as any).doNotRetry = true;
            throw blSizeErr2;
          }

          statusCode = response.status;
        }

        // Wrap in full HTML document if not already
        if (!html.includes("<html") && !html.includes("<HTML")) {
          html = `<!DOCTYPE html>\n<html><body>${html}</body></html>`;
        }

        cloudBrowserBreaker.recordSuccess();

        return {
          html,
          finalUrl: url,
          statusCode,
        };
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            cloudBrowserBreaker.release();
            throw err;
          }
          if (!(err instanceof Error && (err as any).doNotRetry)) {
            cloudBrowserBreaker.recordFailure();
          } else {
            cloudBrowserBreaker.release();
          }
          throw err;
        }
      },
      {
        maxRetries: 2,
        baseDelay: 3000,
        maxDelay: 30000,
        signal: options?.signal,
      }
    ).then(result => {
      if (cbDomain) rateLimiter.recordResult(cbDomain, true, result.statusCode);
      return result;
    }).catch(err => {
      if (cbDomain) rateLimiter.recordResult(cbDomain, false, undefined);
      throw err;
    });
  }
}

// ==================== 6. Scrapling Engine (Python anti-bot) ====================

const SCRAPLING_SERVICE_URL = process.env.SCRAPLING_SERVICE_URL || "http://127.0.0.1:3031";

class ScraplingEngine implements ScrapingEngine {
  readonly name: EngineType = "scrapling";

  async fetch(url: string, options?: EngineOptions): Promise<FetchResult> {
    if (!isSafeUrl(url)) {
      throw new Error(`Blocked: target URL is not allowed (${url})`);
    }

    const timeout = Math.max(10000, Math.min(options?.timeout ?? 30000, 120000));

    let scDomain = '';
    try { scDomain = new URL(url).hostname; } catch { /* ignore */ }

    return retryWithBackoff(
      async () => {
        // Per-domain rate limiting BEFORE circuit breaker acquire so that
        // rate-limit throws don't leak the breaker's _halfOpenInFlight counter.
        await waitForRateLimit(scDomain, options?.signal);

        // Check circuit breaker AFTER rate-limit check (prevents requests when service is down)
        try {
          await scraplingBreaker.acquire();
        } catch (cbErr) {
          // Circuit breaker is open or half-open — re-throw without recording failure
          // (the breaker already manages its own state internally)
          throw cbErr;
        }

        try {
          const response = await fetch(`${SCRAPLING_SERVICE_URL}/fetch`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              url,
              timeout,
              stealth: true,
            }),
            signal: options?.signal?.aborted ? options.signal : (options?.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout + 10000)]) : AbortSignal.timeout(timeout + 10000)),
          });

          if (!response.ok) {
            const errorBody = await response.text().catch(() => "");
            throw new Error(`Scrapling service error: HTTP ${response.status} - ${errorBody}`);
          }

          let data: { html?: string; final_url?: string; status_code?: number; error?: string };
          try {
            data = await response.json();
          } catch {
            throw new Error(`Scrapling service returned invalid JSON`);
          }

          if (data.error) {
            throw new Error(`Scrapling error: ${data.error}`);
          }

          const html = data.html || "";
          if (html.length > MAX_RESPONSE_SIZE) {
            const scSizeErr = new Error(`Scrapling HTML too large: ${html.length} bytes`);
            (scSizeErr as any).doNotRetry = true;
            throw scSizeErr;
          }

          scraplingBreaker.recordSuccess();

          return {
            html,
            finalUrl: data.final_url || url,
            statusCode: data.status_code || 200,
          };
        } catch (scraplingErr) {
          // Don't record aborts or doNotRetry errors as circuit breaker failures.
          // Abort = user cancelled (service is healthy), doNotRetry = content issue (not service fault).
          if (scraplingErr instanceof DOMException && scraplingErr.name === 'AbortError') {
            scraplingBreaker.release();
            throw scraplingErr;
          }
          if (scraplingErr instanceof Error && (scraplingErr as any).doNotRetry) {
            scraplingBreaker.release();
            throw scraplingErr;
          }
          scraplingBreaker.recordFailure();
          throw scraplingErr;
        }
      },
      {
        maxRetries: 2,
        baseDelay: 3000,
        maxDelay: 30000,
        signal: options?.signal,
      }
    ).then(result => {
      if (scDomain) rateLimiter.recordResult(scDomain, true, result.statusCode);
      return result;
    }).catch(err => {
      const errStatus = (err instanceof Error && 'statusCode' in err)
        ? Number((err as any).statusCode) : undefined;
      if (scDomain) rateLimiter.recordResult(scDomain, false, errStatus);
      throw err;
    });
  }
}

// ==================== 6b. Dokobot Engine (Python anti-bot bypass service) ====================

const DOKOBOT_SERVICE_URL = process.env.DOKOBOT_SERVICE_URL || "http://127.0.0.1:3032";

class DokobotEngine implements ScrapingEngine {
  readonly name: EngineType = "dokobot";

  async fetch(url: string, options?: EngineOptions): Promise<FetchResult> {
    if (!isSafeUrl(url)) {
      throw new Error(`Blocked: target URL is not allowed (${url})`);
    }

    const timeout = Math.max(10000, Math.min(options?.timeout ?? 30000, 120000));

    let dkDomain = '';
    try { dkDomain = new URL(url).hostname; } catch { /* ignore */ }

    return retryWithBackoff(
      async () => {
        // Per-domain rate limiting BEFORE circuit breaker acquire so that
        // rate-limit throws don't leak the breaker's _halfOpenInFlight counter.
        await waitForRateLimit(dkDomain, options?.signal);

        // Check circuit breaker AFTER rate-limit check (prevents requests when service is down)
        try {
          await dokobotBreaker.acquire();
        } catch (cbErr) {
          // Circuit breaker is open or half-open — re-throw without recording failure
          // (the breaker already manages its own state internally)
          throw cbErr;
        }

        try {
          const response = await fetch(`${DOKOBOT_SERVICE_URL}/scrape`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              url,
              timeout,
              wait_for: 2000,
            }),
            signal: options?.signal?.aborted ? options.signal : (options?.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout + 10000)]) : AbortSignal.timeout(timeout + 10000)),
          });

          if (!response.ok) {
            const errorBody = await response.text().catch(() => "");
            throw new Error(`Dokobot service error: HTTP ${response.status} - ${errorBody}`);
          }

          let data: { html?: string; final_url?: string; status_code?: number; error?: string };
          try {
            data = await response.json();
          } catch {
            throw new Error(`Dokobot service returned invalid JSON`);
          }

          if (data.error) {
            throw new Error(`Dokobot error: ${data.error}`);
          }

          const html = data.html || "";
          if (html.length > MAX_RESPONSE_SIZE) {
            const dkSizeErr = new Error(`Dokobot HTML too large: ${html.length} bytes`);
            (dkSizeErr as any).doNotRetry = true;
            throw dkSizeErr;
          }

          dokobotBreaker.recordSuccess();

          return {
            html,
            finalUrl: data.final_url || url,
            statusCode: data.status_code || 200,
          };
        } catch (dokobotErr) {
          // Don't record aborts or doNotRetry errors as circuit breaker failures.
          // Abort = user cancelled (service is healthy), doNotRetry = content issue (not service fault).
          if (dokobotErr instanceof DOMException && dokobotErr.name === 'AbortError') {
            dokobotBreaker.release();
            throw dokobotErr;
          }
          if (dokobotErr instanceof Error && (dokobotErr as any).doNotRetry) {
            dokobotBreaker.release();
            throw dokobotErr;
          }
          dokobotBreaker.recordFailure();
          throw dokobotErr;
        }
      },
      {
        maxRetries: 2,
        baseDelay: 3000,
        maxDelay: 30000,
        signal: options?.signal,
      }
    ).then(result => {
      if (dkDomain) rateLimiter.recordResult(dkDomain, true, result.statusCode);
      return result;
    }).catch(err => {
      const errStatus = (err instanceof Error && 'statusCode' in err)
        ? Number((err as any).statusCode) : undefined;
      if (dkDomain) rateLimiter.recordResult(dkDomain, false, errStatus);
      throw err;
    });
  }
}

// ==================== 7. Obscura Engine (Stealth Anti-Fingerprint Browser) ====================

/**
 * Obscura Engine — a stealth headless browser that applies comprehensive
 * anti-fingerprinting injections via Playwright's `page.addInitScript()`.
 *
 * Key differences from PlaywrightEngine:
 *   - Per-domain consistent fingerprint profiles (WebGL, screen, UA, etc.)
 *   - Full stealth injection: navigator, chrome object, WebGL, canvas noise,
 *     AudioContext noise, screen props, WebRTC leak prevention, timezone,
 *     permission API, iframe propagation
 *   - Smart resource blocking (3rd-party tracking, bot-detection beacons)
 *   - Enhanced browser launch args for reduced detectability
 */

/**
 * Pre-computed set of known complex/multi-part TLDs for eTLD+1 root-domain computation.
 * Hoisted to module level to avoid re-creating on every resource request
 * (shouldBlockResource is called for every request in Playwright/Obscura pages).
 */
const COMPLEX_TLDS = new Set(['co.uk','com.cn','com.au','org.cn','net.cn','ac.uk','gov.uk','co.jp','co.kr','co.nz','org.uk','me.uk','co.za','com.br','com.mx','org.au','net.au','co.in','com.tw','org.tw','com.hk','org.hk','co.th','go.th','ac.th','com.sg','com.my','com.ph','com.id','or.id','ac.id','co.il','org.il','co.ck','net.nz','org.nz','co.at','or.at','gen.tr','com.tr','org.tr','net.tr','com.ve','com.uy','com.ar','com.py','com.pe','com.ec','com.cu','com.do','com.gt','com.hn','com.ni','com.pa','com.sv','com.cr','co.ke','ac.ke','go.ke','or.ke','org.za','net.za','co.zw','co.ug','ac.ug','or.ug','co.tz','ac.tz','or.tz','co.rw','co.bw','co.na','co.mz','co.cm','co.cd','co.cg','co.ga','co.ma','co.tn','co.ht','co.vi','co.gg','co.je']);

/**
 * Extract the root domain (eTLD+1) from a hostname.
 * e.g. 'www.example.com' → 'example.com', 'sub.api.example.co.uk' → 'example.co.uk'
 */
function _rootDomain(host: string): string {
  const parts = host.split('.');
  if (parts.length >= 3) {
    const last2 = parts.slice(-2).join('.');
    if (COMPLEX_TLDS.has(last2)) return parts.slice(-3).join('.');
  }
  return parts.length >= 2 ? parts.slice(-2).join('.') : host;
}

/**
 * Obscura resource blocking policy.
 *
 * Strategy:
 *   - Always block: image, font, media, stylesheet, websocket, manifest
 *     (websocket = bot-detection beacons; manifest = unnecessary metadata)
 *   - Block known bot-detection domains (configurable via SCRAPER_BLOCKED_SCRIPT_DOMAINS)
 *   - Block Cloudflare challenge paths (same-origin /cdn-cgi/challenge*, /cdn-cgi/bm/*)
 *   - Block cross-origin: script, xhr, fetch
 *     (prevents 3rd-party tracking pixels and bot-detection scripts while
 *      allowing the target site's own JS to render)
 *   - Allow same-domain: script, xhr, fetch, document, eventsource, other
 *   - Optional behavioral content analysis for same-domain scripts
 *     (SCRAPER_ENABLE_SCRIPT_CONTENT_ANALYSIS=true)
 */

// ---- Bot-Detection Domain Blocking (Task 3-c) ----

/**
 * Default list of known bot-detection service domains.
 * Overridden entirely by SCRAPER_BLOCKED_SCRIPT_DOMAINS env var (comma-separated).
 */
const DEFAULT_BOT_DETECTION_DOMAINS = [
  'fpjs.io',                    // FingerprintJS
  'fingerprintjs.com',          // FingerprintJS
  'recaptcha.net',              // reCAPTCHA
  'google.com',                 // reCAPTCHA (selective — only /recaptcha paths)
  'hcaptcha.com',               // hCaptcha
  'datadome.co',                // DataDome
  'perimeterx.com',             // PerimeterX
  'akamai.com',                 // Akamai Bot Manager
  'imperva.com',                // Imperva
  'cloudflare.com',             // Cloudflare (selective — challenge paths only)
  'arkoselabs.com',             // FunCaptcha (Arkose Labs)
];

/** Parse blocked bot-detection domains from env var or use defaults. Cached to avoid re-parsing on every route interception. */
let _cachedBlockedBotDomains: string[] | null = null;
let _cachedBlockedBotDomainsEnv: string | undefined = undefined;
function getBlockedBotDomains(): string[] {
  const envDomains = process.env.SCRAPER_BLOCKED_SCRIPT_DOMAINS;
  if (envDomains !== _cachedBlockedBotDomainsEnv || _cachedBlockedBotDomains === null) {
    _cachedBlockedBotDomainsEnv = envDomains;
    if (envDomains) {
      _cachedBlockedBotDomains = envDomains.split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
    } else {
      _cachedBlockedBotDomains = DEFAULT_BOT_DETECTION_DOMAINS;
    }
  }
  return _cachedBlockedBotDomains;
}

/**
 * Cloudflare challenge paths to block on same-origin target domains.
 * These paths are injected by Cloudflare's edge on proxied sites.
 */
const BLOCKED_CF_PATHS = ['/cdn-cgi/challenge-platform', '/cdn-cgi/bm'];

/**
 * Check if a request URL matches a known bot-detection domain.
 * Special handling:
 *   - google.com: only blocks /recaptcha paths (allows Google Analytics, Fonts, etc.)
 *   - cloudflare.com: selective — blocks challenge paths, allows cdnjs.cloudflare.com
 */
function isBotDetectionDomainUrl(requestUrl: string): boolean {
  try {
    const parsed = new URL(requestUrl);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    const blockedDomains = getBlockedBotDomains();

    for (const domain of blockedDomains) {
      if (host === domain || host.endsWith('.' + domain)) {
        // google.com — only block /recaptcha paths
        if (domain === 'google.com') {
          return path.startsWith('/recaptcha') || path.includes('/recaptcha/');
        }
        // cloudflare.com — selective: block challenge paths, allow CDN
        if (domain === 'cloudflare.com') {
          if (host === 'cdnjs.cloudflare.com') return false;
          if (host === 'ajax.cloudflare.com') return false;
          return BLOCKED_CF_PATHS.some(p => path.startsWith(p));
        }
        return true;
      }
    }
  } catch { /* invalid URL — don't block */ }
  return false;
}

/**
 * Check if a same-origin URL matches Cloudflare challenge paths.
 * Cloudflare edge injects challenge scripts via /cdn-cgi/ on the target domain itself.
 */
function isCloudflareChallengePath(requestUrl: string): boolean {
  try {
    const path = new URL(requestUrl).pathname.toLowerCase();
    return BLOCKED_CF_PATHS.some(p => path.startsWith(p));
  } catch { return false; }
}

/**
 * Behavioral pattern scoring for bot-detection script content.
 * Scans script source for fingerprinting/bot-detection patterns.
 * Returns true if score >= 3 out of 5 patterns detected.
 *
 * Patterns:
 *   1. navigator.webdriver accessed multiple times
 *   2. Multiple iframe createElement calls (fingerprint sandboxing)
 *   3. RTCPeerConnection usage (IP leak detection)
 *   4. Excessive WebGLRenderingContext parameter access
 *   5. performance.timing delta measurement
 */
function hasBotDetectionBehavioralPatterns(scriptContent: string): boolean {
  let score = 0;
  // 1. navigator.webdriver accessed more than once
  const wdMatches = scriptContent.match(/navigator\.webdriver/g);
  if (wdMatches && wdMatches.length > 1) score++;
  // 2. Multiple iframe createElement calls for fingerprinting
  const iframeMatches = scriptContent.match(/createElement\s*\(\s*['"]iframe['"]\s*\)/g);
  if (iframeMatches && iframeMatches.length > 1) score++;
  // 3. RTCPeerConnection usage for IP leak detection
  if (/RTCPeerConnection|webkitRTCPeerConnection/.test(scriptContent)) score++;
  // 4. Excessive WebGL parameter access
  const webglMatches = scriptContent.match(/WebGLRenderingContext|(?:getParameter|getSupportedExtensions|getExtension)\s*\(/g);
  if (webglMatches && webglMatches.length > 2) score++;
  // 5. performance.timing delta measurement
  if (/performance\.timing/.test(scriptContent) && /navigationStart|loadEventEnd|domComplete/.test(scriptContent)) score++;
  return score >= 3;
}

/** Whether behavioral script content analysis is enabled. */
const ENABLE_SCRIPT_CONTENT_ANALYSIS = process.env.SCRAPER_ENABLE_SCRIPT_CONTENT_ANALYSIS === 'true';

/**
 * NOTE: rootDomain() uses a naive last-2-parts heuristic. This is incorrect for
 * multi-part TLDs (co.uk, com.cn, com.au, etc.) — e.g. siteA.co.uk and siteB.co.uk
 * would both resolve to "co.uk" and be treated as same-origin. This is an acceptable
 * tradeoff because: (1) the isBotDetectionDomainUrl() check catches known 3rd-party
 * bot-detection services regardless of TLD, (2) true cross-domain leaks to random
 * co.uk sites are rare in practice, and (3) a proper Public Suffix List implementation
 * would add significant complexity/dependency.
 */
function shouldBlockResource(resourceType: string, requestUrl: string, targetDomain: string): boolean {
  // Always block these resource types (speed + anti-tracking)
  if (ALWAYS_BLOCKED_RESOURCES.has(resourceType)) return true;

  // Bot-detection domain blocking (explicit list of known services)
  if (['script', 'xhr', 'fetch', 'eventsource'].includes(resourceType)) {
    if (isBotDetectionDomainUrl(requestUrl)) return true;
  }

  // Cloudflare challenge path blocking (same-origin /cdn-cgi/challenge* etc.)
  if (['script', 'xhr', 'fetch'].includes(resourceType)) {
    if (isCloudflareChallengePath(requestUrl)) return true;
  }

  // Cross-origin blocking for script/xhr/fetch: block 3rd-party tracking & bot-detection
  if (['script', 'xhr', 'fetch', 'eventsource'].includes(resourceType)) {
    try {
      const reqHost = new URL(requestUrl).hostname;
      // Compare root domains (eTLD+1) to allow cross-subdomain requests
      // e.g. api.example.com should be allowed when on www.example.com
      if (_rootDomain(reqHost) !== _rootDomain(targetDomain)) {
        return true;
      }
    } catch {
      // Invalid URL — block to be safe
      return true;
    }
  }

  return false;
}

class ObscuraEngine implements ScrapingEngine {
  readonly name: EngineType = "obscura";

  private browser: import("playwright").Browser | null = null;
  private launchPromise: Promise<import("playwright").Browser> | null = null;
  private static _obscuraLaunchLock: Promise<void> | null = null;

  private async getBrowser(): Promise<import("playwright").Browser> {
    if (this.browser?.isConnected()) return this.browser;

    if (this.launchPromise) {
      try {
        this.browser = await this.launchPromise;
        if (this.browser?.isConnected()) return this.browser;
      } catch {
        // Launch failed, clear stale promise before retry
        this.launchPromise = null;
        // fall through to re-launch
      }
    }

    // Serialize launch to prevent orphaned browsers
    const lock = ObscuraEngine._obscuraLaunchLock || (ObscuraEngine._obscuraLaunchLock = Promise.resolve());
    this.launchPromise = lock.then(async () => {
      try {
        const { chromium } = await import("playwright");
        const browser = await chromium.launch({
          headless: true,
          timeout: 30000,
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-extensions",
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "--no-first-run",
            "--no-default-browser-check",
            // Obscura-specific: reduce automation surface area
            "--disable-blink-features=AutomationControlled",
            "--disable-features=IsolateOrigins,site-per-process,VizDisplayCompositor,TranslateUI",
            "--disable-hang-monitor",
            "--disable-prompt-on-repost",
            "--disable-client-side-phishing-detection",
            "--disable-component-update",
            "--disable-default-apps",
            "--disable-domain-reliability",
            "--disable-ipc-flooding-protection",
            "--disable-notifications",
            "--disable-popup-blocking",
            "--disable-print-preview",
            "--disable-reading-mode",
            "--disable-renderer-throttling",
            "--disable-sync",
            "--disable-translate",
            "--metrics-recording-only",
            "--no-pings",
            "--password-store=basic",
            "--use-mock-keychain",
            "--disable-infobars",
          ],
        });
        console.log("[Obscura] Stealth browser launched successfully");

        browser.on("disconnected", () => {
          console.log("[Obscura] Browser disconnected");
          this.browser = null;
          this.launchPromise = null;
        });

        return browser;
      } finally {
        ObscuraEngine._obscuraLaunchLock = null;
      }
    });

    this.browser = await this.launchPromise;
    return this.browser!;
  }

  async fetch(url: string, options?: EngineOptions): Promise<FetchResult> {
    if (!isSafeUrl(url)) {
      throw new Error(`Blocked: target URL is not allowed (${url})`);
    }

    const timeout = Math.max(10000, Math.min(options?.timeout ?? 60000, 300000));
    const cookies = options?.cookies || options?.antiCrawl?.cookies;

    // Extract domain for per-domain fingerprint caching
    let domain: string;
    try { domain = new URL(url).hostname; } catch { throw new Error(`Invalid URL: ${url}`); }

    // Get or create a consistent fingerprint profile for this domain
    const profile = getProfileForDomain(domain);
    const stealthScript = getStealthScript(profile);

    // Track last status code for outer recordResult (avoids double-counting in retries)
    let lastObscuraStatus = 0;

    // Request fingerprint tracking — created OUTSIDE retry loop for stable identity across retries
    const fp = requestFingerprintMgr.create({
      domain,
      engine: 'obscura',
      sessionId: undefined,
      proxyUrl: undefined, // proxy selected per-retry inside loop
      userAgent: profile.userAgent,
    });

    return retryWithBackoff(
      async () => {
        // Anti-fingerprint timing jitter (±50ms, always applied)
        await applyTimingJitter();

        // Browser behavior: throttle if visiting same domain too frequently
        const throttleCheck = browserBehavior.shouldThrottle(domain);
        if (throttleCheck.throttled) {
          await new Promise(r => setTimeout(r, throttleCheck.waitMs));
        }
        browserBehavior.recordRequest(domain);

        // Per-domain rate limiting (adaptive backoff, max 3 retries, abort-aware)
        await waitForRateLimit(domain, options?.signal);

        // Select proxy for this domain (with rotation if configured)
        const domainProxy = domain ? proxyManager.getDomainProxyWithRotation(domain) : null;
        const proxy = domainProxy || (options?.proxy ? proxyManager.getProxyWithFallback(domain) : null);

        const obscuraStartTime = Date.now();

        const browser = await this.getBrowser();

        // Build context options with optional proxy
        const contextOptions: Record<string, unknown> = {
          userAgent: profile.userAgent,
          viewport: {
            width: profile.screenWidth,
            height: profile.screenHeight,
            deviceScaleFactor: profile.pixelRatio,
          },
          locale: profile.languages[0] || 'zh-CN',
          timezoneId: profile.timezone,
          screen: {
            width: profile.screenWidth,
            height: profile.screenHeight,
            colorDepth: profile.colorDepth,
          },
          bypassCSP: true,
          javaScriptEnabled: true,
          ignoreHTTPSErrors: true,
          serviceWorkers: "block",
          extraHTTPHeaders: {
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": profileLanguagesToAcceptLanguage(profile.languages),
            "Accept-Encoding": getAcceptEncoding(domain),
            ...getSecFetchHeadersForDomain(domain),
            "Upgrade-Insecure-Requests": "1",
            // Client Hints — real Chrome/Edge always sends these; correctly skipped for Firefox via getChromeClientHints() returning null
            ...(getChromeClientHints(profile.userAgent) || {}),
          },
        };

        // Add proxy configuration if available
        if (proxy) {
          contextOptions.proxy = { server: proxy.url };
          if (process.env.DEBUG === 'true') {
            console.log(`[Obscura] Using proxy ${proxy.url} for ${domain}`);
          }
        }

        const context = await browser.newContext(contextOptions);

        // Add cookies from jar + user-provided cookies
        const jarCookies = cookieJar.getPlaywrightCookies(domain);
        const obscuraCookies = [
          ...jarCookies,
          ...(cookies?.length ? cookies.filter((c) => c.name && c.value).map((c) => ({
            name: c.name.replace(/[\r\n\t\x00-\x1f]/g, ""),
            value: c.value.replace(/[\r\n\t\x00-\x1f]/g, ""),
            domain,
            path: "/",
          })) : []),
        ];
        if (obscuraCookies.length > 0) {
          await context.addCookies(obscuraCookies);
        }

        try {
          const page = await context.newPage();

          // ---- CRITICAL: Inject stealth script BEFORE any navigation ----
          await page.addInitScript(stealthScript);

          // Block resources by type + cross-origin 3rd-party + SSRF protection
          // Uses shouldBlockResource helper for centralized anti-detection resource policy
          await page.route("**/*", async (route) => {
            try {
              const resourceType = route.request().resourceType();
              const routeUrl = route.request().url();

              if (shouldBlockResource(resourceType, routeUrl, domain)) {
                route.abort();
                return;
              }

              // SSRF protection: block non-HTTP/HTTPS navigations and unsafe targets
              if (!routeUrl.startsWith("http://") && !routeUrl.startsWith("https://")) {
                if (["document", "xhr", "fetch", "iframe", "other"].includes(resourceType)) {
                  route.abort();
                  return;
                }
              }
              if (["document", "xhr", "fetch", "iframe", "other"].includes(resourceType) && !isSafeUrl(routeUrl)) {
                route.abort();
                return;
              }

              // Behavioral analysis: scan same-domain scripts for bot-detection patterns
              if (ENABLE_SCRIPT_CONTENT_ANALYSIS && resourceType === 'script') {
                try {
                  const resp = await route.fetch();
                  let body;
                  try {
                    body = await resp.text();
                  } catch {
                    // Fetch succeeded but reading body failed — abort (request already made)
                    try { await route.abort(); } catch { /* already handled */ }
                    return;
                  }
                  if (hasBotDetectionBehavioralPatterns(body)) {
                    if (process.env.DEBUG === 'true') {
                      console.log(`[Obscura] Blocked bot-detection script (behavioral): ${routeUrl.slice(0, 120)}`);
                    }
                    await route.abort();
                    return;
                  }
                  await route.fulfill({ response: resp });
                  return;
                } catch {
                  // route.fetch() itself failed — abort to prevent double request
                  try { await route.abort(); } catch { /* already handled */ }
                  return;
                }
              }

              route.continue();
            } catch (routeErr) {
              // If route handling fails (e.g., request cancelled), abort to prevent hang
              try { route.abort(); } catch { /* already handled */ }
            }
          });

          // Navigate with stealth
          const response = await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout,
          });

          if (!response) {
            throw new Error(`No response from ${url}`);
          }

          // Wait for network idle (give JS time to render content)
          await page
            .waitForLoadState("networkidle", { timeout: 10000 })
          .catch((err) => {
            // Only swallow timeout errors; re-throw page crashes/navigation errors
            // (consistent with PlaywrightEngine behavior)
            if (!err.message?.includes('Timeout')) throw err;
          });

          // ---- Human behavior simulation or simple scroll fallback ----
          if (options?.antiCrawl?.humanBehavior) {
            try {
              // 1. Human-like mouse movement: natural curve from (100,200) to (500,400)
              const startX = 50 + Math.floor(Math.random() * 300), startY = 100 + Math.floor(Math.random() * 300);
              const endX = 300 + Math.floor(Math.random() * 600), endY = 200 + Math.floor(Math.random() * 400);
              const steps = 15 + Math.floor(Math.random() * 10);
              let currentX = startX, currentY = startY;
              for (let i = 0; i < steps; i++) {
                const t = i / steps;
                currentX = startX + (endX - startX) * t + (Math.random() - 0.5) * 30;
                currentY = startY + (endY - startY) * t + (Math.random() - 0.5) * 20;
                await page.mouse.move(currentX, currentY);
                await new Promise((r) => setTimeout(r, 10 + Math.random() * 30));
              }

              // 2. Random idle micro-movements (hand tremor between actions)
              for (let j = 0; j < 1 + Math.floor(Math.random() * 2); j++) {
                await page.mouse.move(
                  currentX + (Math.random() - 0.5) * 10,
                  currentY + (Math.random() - 0.5) * 10
                );
                currentX += (Math.random() - 0.5) * 10;
                currentY += (Math.random() - 0.5) * 10;
                await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
              }

              // 3. Occasional content interaction (30% chance to hover a link)
              if (Math.random() < 0.3) {
                try {
                  const links = await page.$$("a[href]");
                  if (links.length > 0) {
                    const randomLink = links[Math.floor(Math.random() * links.length)];
                    const box = await randomLink.boundingBox();
                    if (box) {
                      const hoverX = box.x + box.width * (0.3 + Math.random() * 0.4);
                      const hoverY = box.y + box.height / 2;
                      // Move to link in a few small steps
                      const linkSteps = 5 + Math.floor(Math.random() * 5);
                      for (let k = 0; k < linkSteps; k++) {
                        const lt = k / linkSteps;
                        await page.mouse.move(
                          currentX + (hoverX - currentX) * lt + (Math.random() - 0.5) * 8,
                          currentY + (hoverY - currentY) * lt + (Math.random() - 0.5) * 8
                        );
                        await new Promise((r) => setTimeout(r, 10 + Math.random() * 25));
                      }
                      currentX = hoverX;
                      currentY = hoverY;
                      // Pause as if reading link text
                      await new Promise((r) => setTimeout(r, 300 + Math.random() * 500));
                    }
                  }
                } catch { /* link hover failure is non-critical */ }
              }

              // 4. Gradual multi-step page scroll (replaces simple scroll-to-bottom)
              const pageHeight = await page.evaluate(() => document.body.scrollHeight || document.body.clientHeight || 3000);
              const segments = 3 + Math.floor(Math.random() * 3); // 3-5 segments
              const scrollStep = Math.floor(pageHeight / segments);
              for (let s = 1; s <= segments; s++) {
                // Calculate target with slight overshoot then correction
                const overshoot = (Math.random() - 0.5) * 40;
                let targetY = scrollStep * s + overshoot;
                // Final segment targets near the bottom
                if (s === segments) {
                  targetY = pageHeight - 200 + (Math.random() - 0.5) * 100;
                }
                targetY = Math.max(0, targetY);

                await page.evaluate((y) => {
                  window.scrollTo({ top: y, behavior: "smooth" });
                }, targetY);

                // Scroll travel pause
                await new Promise((r) => setTimeout(r, 300 + Math.random() * 500));

                // Simulate reading pause at each stop
                const readPause = 500 + Math.random() * 1500;
                await new Promise((r) => setTimeout(r, readPause));

                // Micro-movements during reading pause
                await page.mouse.move(
                  currentX + (Math.random() - 0.5) * 12,
                  currentY + (Math.random() - 0.5) * 12
                );
                currentX += (Math.random() - 0.5) * 12;
                currentY += (Math.random() - 0.5) * 12;
              }

              // 5. Random delay before extraction (simulates settling to read)
              await new Promise((r) => setTimeout(r, 200 + Math.random() * 400));
            } catch {
              // Human behavior simulation failure is non-critical; fall through to extraction
              console.log("[Obscura] Human behavior simulation failed, continuing with extraction");
            }
          } else {
            // Simple scroll-to-bottom fallback (original behavior)
            await page.evaluate(() => {
              window.scrollTo(0, document.body.scrollHeight);
            }).catch(() => {});

            // Brief wait for any lazy-load triggers
            await new Promise((resolve) => setTimeout(resolve, 800));
          }

          const html = await page.content();
          if (html.length > MAX_RESPONSE_SIZE) {
            const sizeErr = new Error(
              `Obscura page content too large: ${html.length} bytes (max 10MB)`
            );
            (sizeErr as any).doNotRetry = true; // Same page will always be too large, retrying wastes time
            throw sizeErr;
          }
          const finalUrl = page.url();

          // Store cookies back to jar after navigation
          try {
            const browserCookies = await context.cookies();
            if (browserCookies.length > 0) {
              const setCookieHeaders = browserCookies.map(c => {
                let header = `${c.name}=${c.value}`;
                if (c.domain) header += `; Domain=${c.domain}`;
                if (c.path) header += `; Path=${c.path}`;
                if (c.httpOnly) header += '; HttpOnly';
                if (c.secure) header += '; Secure';
                if (c.expires > 0) header += `; Expires=${new Date(c.expires * 1000).toUTCString()}`;
                return header;
              });
              cookieJar.store(domain, setCookieHeaders);
            }
          } catch { /* ignore cookie extraction errors */ }

          if (process.env.DEBUG === 'true') {
            console.log(
              `[Obscura] Fetched ${finalUrl} (${html.length} bytes, status ${response.status()}, profile: ${profile.seed?.slice(0, 12) || 'unknown'}...)`
            );
          }

          // CAPTCHA detection on fetched content
          let captchaDetection: CaptchaDetection | null = null;
          const obscuraStatus = response.status();
          if (obscuraStatus === 403 || obscuraStatus === 503 || /(?:<iframe[^>]+src=["'][^"']*(?:captcha|challenge|recaptcha)|captcha|challenge-platform|_cf_chl|turnstile)/i.test(html.slice(0, 8000))) {
            captchaDetection = detectCaptcha(html, finalUrl, obscuraStatus);
            if (captchaDetection.detected && captchaDetection.confidence > 0.5) {
              console.warn(`[Obscura] CAPTCHA detected on ${domain}: type=${captchaDetection.type}, confidence=${captchaDetection.confidence}`);
              // Notify anti-crawl advisor (fire-and-forget)
              try {
                antiCrawlAdvisor.recordDetection(domain, 'captcha', `CAPTCHA ${captchaDetection.type} detected, confidence ${Math.round(captchaDetection.confidence * 100)}%`);
              } catch { /* non-critical */ }
              // Record as failure for rate limiter (triggers penalty)
              // IMPORTANT: Do NOT record result here - the catch block below handles it.
              // Recording here AND in catch would cause double penalty.
              // Record CAPTCHA-triggered engine upgrade (obscura is highest — no further upgrade, but still recorded)
              recordCaptchaUpgrade(domain, 'obscura');
              const obscuraCaptchaErr = new Error(`CAPTCHA detected (${captchaDetection.type}, ${Math.round(captchaDetection.confidence * 100)}%) on ${domain}`);
              (obscuraCaptchaErr as any).doNotRetry = true;
              throw obscuraCaptchaErr;
            }
          }

          // Record URL in referrer chain for future requests
          referrerChain.recordVisit(finalUrl);

          // Track last status code for outer recordResult
          lastObscuraStatus = obscuraStatus;

          // Record proxy health for Obscura engine
          if (proxy) {
            proxyManager.recordSuccessWithRotation(proxy.url, domain, Date.now() - obscuraStartTime);
          }

          return {
            html,
            finalUrl,
            statusCode: obscuraStatus,
            captcha: captchaDetection?.detected ? captchaDetection : undefined,
          };
        } catch (err) {
          // Track error status for outer recordResult
          if (err instanceof Error && err.message.startsWith('CAPTCHA detected')) {
            lastObscuraStatus = 403;
          } else {
            lastObscuraStatus = err instanceof Error ? parseInt(err.message.match(/HTTP (\d+)/)?.[1] || '0', 10) : 0;
          }
          // Record proxy failure for Obscura engine (per-retry is correct for proxy)
          // Skip for CAPTCHA errors — CAPTCHA is a site-level detection, not a proxy issue
          const isObscuraCaptchaErr = err instanceof Error && err.message.startsWith('CAPTCHA detected');
          if (proxy && !isObscuraCaptchaErr) {
            proxyManager.recordFailure(proxy.url, err instanceof Error ? err.message : String(err));
          }
          // NOTE: rateLimiter.recordResult is called OUTSIDE retryWithBackoff (below)
          // to avoid double-counting retry attempts as separate requests.
          throw err;
        } finally {
          try {
            await context.close();
          } catch {
            // Playwright close() has built-in timeout; swallow errors
          }
        }
      },
      {
        maxRetries: options?.antiCrawl?.retries ?? 2,
        baseDelay: 2000,
        maxDelay: 20000,
        signal: options?.signal,
        // Note: proxy failure recording is handled inside the retry callback's catch block
        // (proxy is selected per-retry, so onRetry cannot reference it from outer scope)
      }
    ).then(result => {
      // Record final success (single record for the logical request)
      rateLimiter.recordResult(domain, true, lastObscuraStatus);
      try { antiCrawlAdvisor.recordSuccess(domain); } catch { /* non-critical */ }
      requestFingerprintMgr.complete(fp.requestId, true, lastObscuraStatus);
      return result;
    }).catch(err => {
      // Record final failure (single record for the logical request)
      rateLimiter.recordResult(domain, false, lastObscuraStatus || undefined);
      try { antiCrawlAdvisor.recordFailure(domain); } catch { /* non-critical */ }
      requestFingerprintMgr.complete(fp.requestId, false, lastObscuraStatus);
      throw err;
    });
  }

  async close(): Promise<void> {
    if (this.browser?.isConnected()) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.launchPromise = null;
      console.log("[Obscura] Stealth browser closed");
    }
  }
}

// ==================== Infinite Scroll Fetch ====================

/**
 * Fetch a page that uses infinite scroll or "load more" button pagination.
 * This requires a browser engine (Playwright or Obscura) because it needs to
 * interact with the page (scroll, click, wait for mutations).
 *
 * Strategy:
 * 1. Load initial page with Playwright (auto-upgrades non-browser engines)
 * 2. Capture initial content length (to detect growth)
 * 3. If loadMoreSelector is set, click the button; otherwise scroll to bottom
 * 4. Wait for new content to appear (poll-based mutation detection)
 * 5. Repeat until no new content or maxCycles reached
 * 6. Return accumulated HTML
 */
export async function fetchWithInfiniteScroll(
  url: string,
  options: EngineOptions | undefined,
  engineType: EngineType,
  pagination: { loadMoreSelector?: string; contentContainerSelector?: string; maxScrollCycles?: number },
): Promise<{ html: string; finalUrl: string; statusCode: number; cyclesCompleted: number; effectiveEngine: EngineType }> {
  const maxCycles = pagination.maxScrollCycles || MAX_SCROLL_ITERATIONS;
  const { loadMoreSelector, contentContainerSelector } = pagination;
  const signal = options?.signal;
  const fetchedUrls = new Set<string>(); // Dedup tracking for requests (R48#31)

  // Common load-more button selectors for auto-detection (when no explicit loadMoreSelector)
  const AUTO_LOAD_MORE_SELECTORS = [
    // English
    'button:has-text("load more")', 'a:has-text("load more")',
    'button:has-text("show more")', 'a:has-text("show more")',
    'button:has-text("next page")', 'a:has-text("next page")',
    // Chinese
    'button:has-text("加载更多")', 'a:has-text("加载更多")',
    'button:has-text("查看更多")', 'a:has-text("查看更多")',
    'button:has-text("下一页")', 'a:has-text("下一页")',
    // Data attributes
    '[data-load-more]', '[data-infinite-scroll]',
    // Common class/id patterns
    '.load-more-btn', '#load-more', '.pagination-next',
    '.load-more', '#loadMore', '.btn-load-more',
    // Novel-specific
    '.chapter-more', '.read-more', '.next-chapter',
  ];
  const autoLoadMoreSelector = AUTO_LOAD_MORE_SELECTORS.join(', ');

  // Determine which browser engine to use
  let browserEngine: EngineType;
  const nonBrowserEngines: EngineType[] = ['cheerio', 'firecrawl', 'agentql', 'scrapling', 'dokobot', 'cloud-browser', 'api'];
  if (nonBrowserEngines.includes(engineType)) {
    // Prefer obscura for anti-fingerprint stealth, fallback to playwright
    browserEngine = engines.has('obscura') ? 'obscura' : 'playwright';
    console.log(`[InfiniteScroll] Auto-upgraded engine: ${engineType} → ${browserEngine} (browser required for infinite scroll)`);
  } else {
    browserEngine = engineType;
  }

  // For truly non-browser-capable situations (no playwright/obscura installed),
  // fall back to single HTTP fetch
  if (!engines.has(browserEngine)) {
    console.warn(`[InfiniteScroll] Browser engine ${browserEngine} not available, falling back to single fetch`);
    const fallbackEngine = getEngine('cheerio');
    const result = await fallbackEngine.fetch(url, options);
    return { ...result, cyclesCompleted: 0, effectiveEngine: 'cheerio' };
  }

  // Extract domain for anti-detection features
  let domain = '';
  try { domain = new URL(url).hostname; } catch { /* invalid URL */ }

  // Use proxy rotation if available, falling back to options.proxy
  const effectiveProxy = domain ? proxyManager.getDomainProxyWithRotation(domain) : null;
  const proxyStr = effectiveProxy?.url || options?.proxy || null;
  const startTime = Date.now();

  let browser: import('playwright').Browser | null = null;
  let context: import('playwright').BrowserContext | null = null;

  try {
    const pw = await import('playwright');
    const launchOptions: import('playwright').LaunchOptions = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        // Anti-detection: prevent navigator.webdriver leak via Chrome flag
        '--disable-blink-features=AutomationControlled',
      ],
    };

    // Apply proxy configuration (Playwright natively supports socks5, no protocol conversion needed)
    if (proxyStr) {
      try {
        const proxyUrl = new URL(proxyStr);
        launchOptions.proxy = {
          server: proxyStr,
          username: proxyUrl.username || undefined,
          password: proxyUrl.password || undefined,
        };
      } catch { /* invalid proxy URL */ }
    }

    // KNOWN LIMITATION: This launches a separate browser instance with weaker stealth than
    // the dedicated Obscura/Playwright engines. Resource blocking uses shouldBlockResource()
    // but doesn't replicate the full engine-level route handling (e.g. script content analysis).
    // TODO: refactor to reuse Obscura or Playwright engine's browser pool for infinite scroll.
    browser = await pw.chromium.launch(launchOptions);
    const profile = domain ? getProfileForDomain(domain) : null;
    context = await browser.newContext({
      userAgent: options?.userAgent || profile?.userAgent || getRandomUA(),
      ignoreHTTPSErrors: true,
      locale: profile ? (profile.languages[0] || undefined) : undefined,
      viewport: profile ? { width: profile.screenWidth || 1920, height: profile.screenHeight || 1080 } : undefined,
      screen: profile ? { width: profile.screenWidth || 1920, height: profile.screenHeight || 1080, colorDepth: profile.colorDepth || 24 } : undefined,
    });

    // Inject stealth script
    if (domain) {
      await context.addInitScript(getStealthScript(profile));
    }

    // Apply cookies from cookie jar + options.cookies
    const jarCookies = domain ? cookieJar.getPlaywrightCookies(domain) : [];
    const allCookies = [
      ...jarCookies,
      ...(options?.cookies?.map(c => ({
        name: c.name.replace(/[\r\n\t\x00-\x1f]/g, ''),
        value: c.value.replace(/[\r\n\t\x00-\x1f]/g, ''),
        domain: c.domain || domain,
        path: '/',
      })) || []),
    ];
    if (allCookies.length) {
      await context.addCookies(allCookies);
    }

    const page = await context.newPage();

    // Track XHR/fetch URLs to detect duplicate requests (R48#31)
    page.on('request', (req) => {
      const reqUrl = req.url();
      if (req.resourceType() === 'xhr' || req.resourceType() === 'fetch') {
        if (fetchedUrls.has(reqUrl)) {
          console.log(`[InfiniteScroll] Duplicate request detected: ${reqUrl.slice(0, 100)}`);
        }
        fetchedUrls.add(reqUrl);
      }
    });

    // Resource blocking for anti-detection + SSRF protection
    await page.route('**/*', async (route) => {
      try {
        const resourceType = route.request().resourceType();
        const routeUrl = route.request().url();
        if (shouldBlockResource(resourceType, routeUrl, domain)) {
          await route.abort();
          return;
        }
        // SSRF protection: block non-HTTP/HTTPS document/xhr/fetch to internal targets
        if (['document', 'xhr', 'fetch'].includes(resourceType)) {
          try {
            const parsed = new URL(routeUrl);
            if (!['http:', 'https:'].includes(parsed.protocol) || !isSafeUrl(routeUrl)) {
              await route.abort();
              return;
            }
          } catch { await route.abort(); return; }
        }
        await route.continue();
      } catch {
        try { await route.abort(); } catch { /* route already handled */ }
      }
    });

    // Check abort before navigation
    if (signal?.aborted) {
      throw new Error('Aborted before navigation');
    }

    // Per-domain rate limiting
    if (domain) await waitForRateLimit(domain, signal);

    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: options?.timeout ?? 30000,
    });

    const statusCode = response?.status() || 0;

    // CAPTCHA detection
    if (domain && statusCode) {
      const pageHtml = await page.content().catch(() => '');
      const captchaResult = detectCaptcha(pageHtml, url, statusCode);
      if (captchaResult.detected && captchaResult.confidence > 0.5) {
        console.warn(`[InfiniteScroll] CAPTCHA detected on ${domain}: type=${captchaResult.type}`);
        if (effectiveProxy) proxyManager.recordFailure(effectiveProxy.url, `CAPTCHA ${captchaResult.type}`);
        throw new Error(`CAPTCHA detected (${captchaResult.type}) on ${domain}`);
      }
    }

    // Capture initial content length BEFORE any scrolling
    const containerSelector = contentContainerSelector || 'body';
    const initialContentLength = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el ? el.innerHTML.length : 0;
    }, containerSelector).catch(() => 0);

    let lastContentLength = initialContentLength;
    let cyclesCompleted = 0;
    let consecutiveNoGrowth = 0; // Track consecutive scrolls with no content growth
    let lastScrollPercent = 0; // Track scroll position percentage
    let stuckCount = 0; // Count consecutive scrolls stuck at same position
    let lastLoggedPercent = 0; // For periodic progress logging (every 25%)

    for (let cycle = 0; cycle < maxCycles; cycle++) {
      // Check abort before each cycle
      if (signal?.aborted) {
        console.log(`[InfiniteScroll] Aborted at cycle ${cycle + 1}`);
        break;
      }

      // Wait for lazy-loading scripts to settle
      await abortableDelay(800 + Math.random() * 400, signal);
      if (signal?.aborted) break;

      // --- Click-based "Load More" button detection ---
      let clickedButton = false;
      if (loadMoreSelector) {
        // Explicit selector from user config
        const btn = page.locator(loadMoreSelector).first();
        const visible = await btn.isVisible().catch(() => false);
        if (visible) {
          await btn.click().catch(() => {});
          clickedButton = true;
          await abortableDelay(1500 + Math.random() * 1000, signal);
        } else {
          console.log(`[InfiniteScroll] Load-more button not visible at cycle ${cycle + 1}, stopping`);
          break;
        }
      } else {
        // Auto-detect load-more button (only when no explicit selector)
        try {
          const autoBtn = page.locator(autoLoadMoreSelector).first();
          const autoBtnVisible = await autoBtn.isVisible().catch(() => false);
          if (autoBtnVisible) {
            console.log(`[InfiniteScroll] Auto-detected load-more button at cycle ${cycle + 1}, clicking`);
            await autoBtn.click().catch(() => {});
            clickedButton = true;
            await abortableDelay(1500 + Math.random() * 1000, signal);
          } else {
            // No button found, fall back to scrolling
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
          }
        } catch {
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
        }
        if (!clickedButton) {
          await abortableDelay(1200 + Math.random() * 800, signal);
        }
      }

      if (signal?.aborted) break;

      // --- Scroll position percentage tracking ---
      const scrollPercent = await page.evaluate(() => {
        const scrollHeight = document.body.scrollHeight || document.documentElement.scrollHeight;
        if (scrollHeight <= 0) return 100;
        return Math.round(((window.scrollY + window.innerHeight) / scrollHeight) * 100);
      }).catch(() => 0);

      // Check if stuck at same scroll position
      if (scrollPercent === lastScrollPercent && scrollPercent < 100) {
        stuckCount++;
        if (stuckCount >= 3) {
          console.log(`[InfiniteScroll] Stuck at ${scrollPercent}% for 3+ scrolls, stopping`);
          break;
        }
      } else {
        stuckCount = 0;
      }
      lastScrollPercent = scrollPercent;

      // Log progress periodically (every 25%)
      if (scrollPercent >= lastLoggedPercent + 25 || scrollPercent === 100) {
        console.log(`[InfiniteScroll] Scroll progress: ${scrollPercent}%`);
        lastLoggedPercent = Math.floor(scrollPercent / 25) * 25;
      }

      // --- Check content growth ---
      const contentLength = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? el.innerHTML.length : 0;
      }, containerSelector).catch(() => 0);

      if (contentLength <= lastContentLength) {
        consecutiveNoGrowth++;
        if (consecutiveNoGrowth >= 2) {
          console.log(`[InfiniteScroll] No new content for ${consecutiveNoGrowth} consecutive cycles (${contentLength} chars), stopping`);
          break;
        }
        console.log(`[InfiniteScroll] No new content at cycle ${cycle + 1} (${contentLength} chars), attempt ${consecutiveNoGrowth}/2`);
      } else {
        consecutiveNoGrowth = 0;
      }

      lastContentLength = contentLength;
      cyclesCompleted++;
      console.log(`[InfiniteScroll] Cycle ${cycle + 1}: content grew to ${contentLength} chars`);
    }

    const html = await page.content();

    // Size check for infinite scroll (can grow well beyond 10MB after multiple scrolls)
    if (html.length > MAX_RESPONSE_SIZE) {
      throw new Error(`InfiniteScroll page content too large: ${html.length} bytes (max 10MB)`);
    }

    const finalUrl = page.url();

    // Record referrer chain + rate limit result
    if (domain) {
      referrerChain.recordVisit(finalUrl);
      rateLimiter.recordResult(domain, true, statusCode);
    }

    // Record proxy success
    if (effectiveProxy && domain) {
      proxyManager.recordSuccessWithRotation(effectiveProxy.url, domain, Date.now() - startTime);
    }

    return { html, finalUrl, statusCode, cyclesCompleted, effectiveEngine: browserEngine };
  } catch (err) {
    if (err instanceof Error && (err.message.includes('Aborted') || err.message.includes('aborted'))) {
      throw err;
    }
    console.warn(`[InfiniteScroll] Browser-based scroll failed: ${err instanceof Error ? err.message : err}`);
    const errStatus = (err instanceof Error && 'statusCode' in err)
      ? Number((err as any).statusCode) : undefined;
    if (domain) rateLimiter.recordResult(domain, false, errStatus);
    // Fall back to a single HTTP fetch
    const fallbackEngine = getEngine('cheerio');
    const result = await fallbackEngine.fetch(url, options);
    return { ...result, cyclesCompleted: 0, effectiveEngine: 'cheerio' };
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

/** Delay that respects abort signal */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise(r => setTimeout(r, ms));
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Aborted')); return; }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => { clearTimeout(timer); reject(new Error('Aborted')); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ==================== 7. API Engine (JSON API with signing/decryption) ====================

/**
 * Simple JSONPath resolver supporting dot notation, array indexing, and wildcards.
 * Handles paths like: data.book, data.books[0].title, data.chapter_lists[*].title
 */
function jsonPath(obj: unknown, path: string): unknown {
  if (!path || !path.trim()) return obj;
  const segments = path.replace(/\[\*/g, '.[*]').split('.').filter(Boolean);
  let current: unknown = obj;
  for (const seg of segments) {
    if (current == null) return undefined;
    const arrMatch = seg.match(/^\[(\d+)\]$/);
    if (arrMatch) {
      const idx = parseInt(arrMatch[1], 10);
      if (!Array.isArray(current)) return undefined;
      current = current[idx];
      continue;
    }
    const wildcardMatch = seg.match(/^\[\*\]$/);
    if (wildcardMatch) {
      if (!Array.isArray(current)) return undefined;
      // Return all elements — caller decides how to handle
      continue;
    }
    // Regular property access
    if (typeof current === 'object' && current !== null) {
      current = (current as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Extract all values matching a path with [*] wildcard into a flat array */
function jsonPathAll(obj: unknown, path: string): unknown[] {
  if (!path.includes('[*]')) {
    const val = jsonPath(obj, path);
    return val != null ? [val] : [];
  }
  const parts = path.split('[*]');
  const baseVal = jsonPath(obj, parts[0].replace(/\.$/, ''));
  if (!Array.isArray(baseVal)) return [];
  const restPath = parts.slice(1).join('[*]').replace(/^\./, '');
  const results: unknown[] = [];
  for (const item of baseVal) {
    if (restPath) {
      results.push(...jsonPathAll(item, restPath));
    } else {
      results.push(item);
    }
  }
  return results;
}

/**
 * Generate MD5 sign for params/headers (七猫-style signing).
 * Format: sorted keys concatenated as "key1=value1key2=value2..." + signKey, then MD5.
 */
function md5Sign(data: Record<string, string>, signKey: string): string {
  const sortedKeys = Object.keys(data).sort();
  const raw = sortedKeys.reduce((acc, k) => acc + k + '=' + data[k], '') + signKey;
  const md5 = new Bun.CryptoHash('md5');
  md5.update(new TextEncoder().encode(raw));
  return md5.digest('hex');
}

/**
 * AES-CBC decrypt with hex-encoded input.
 * If ivFromResponse is true, first ivLength bytes are the IV.
 */
async function aesDecrypt(
  encryptedData: string,
  key: string,
  algorithm: string,
  inputEncoding: 'hex' | 'base64',
  ivFromResponse: boolean,
  ivLength: number,
  explicitIv?: string,
): Promise<string> {
  let rawBytes: Uint8Array;
  if (inputEncoding === 'hex') {
    const hex = encryptedData.replace(/\s/g, '');
    rawBytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < rawBytes.length; i++) {
      rawBytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
  } else {
    rawBytes = Uint8Array.from(atob(encryptedData), c => c.charCodeAt(0));
  }

  let iv: Uint8Array;
  let ciphertext: Uint8Array;
  if (ivFromResponse) {
    iv = rawBytes.slice(0, ivLength);
    ciphertext = rawBytes.slice(ivLength);
  } else {
    iv = explicitIv ? Uint8Array.from(atob(explicitIv), c => c.charCodeAt(0)) : new Uint8Array(16);
    ciphertext = rawBytes;
  }

  // Map algorithm names to Node.js crypto format
  const nodeAlgoMap: Record<string, string> = {
    'aes-128-cbc': 'aes-128-cbc',
    'aes-256-cbc': 'aes-256-cbc',
    'aes-128-ecb': 'aes-128-ecb',
  };
  const nodeAlgo = nodeAlgoMap[algorithm] || algorithm;
  const nodeCrypto = await import('crypto');
  const keyBytes = Buffer.from(key, 'utf8');
  const decipher = nodeAlgo.includes('ecb')
    ? nodeCrypto.createDecipheriv(nodeAlgo, keyBytes, undefined)
    : nodeCrypto.createDecipheriv(nodeAlgo, keyBytes, iv);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

const apiBreaker = CircuitBreaker.create("ApiEngine");

class ApiEngine implements ScrapingEngine {
  readonly name: EngineType = "api";
  private _ruleConfig: Record<string, unknown> | null = null;

  /**
   * Set the API rule config (called from task-engine when processing api-engine rules).
   * Contains: baseUrl, signing, decryption, endpoints, headers, etc.
   */
  setConfig(config: Record<string, unknown>): void {
    this._ruleConfig = config;
  }

  getConfig(): Record<string, unknown> | null {
    return this._ruleConfig;
  }

  async fetch(url: string, options?: EngineOptions): Promise<FetchResult> {
    if (!isSafeUrl(url)) {
      throw new Error(`Blocked: target URL is not allowed (${url})`);
    }

    const timeout = Math.max(5000, Math.min(options?.timeout ?? 30000, 120000));
    const config = this._ruleConfig || {};
    const customHeaders = (config.customHeaders as Record<string, string>) || {};
    const signing = config.signing as Record<string, unknown> | undefined;
    const decryption = config.decryption as Record<string, unknown> | undefined;

    let domain = '';
    try { domain = new URL(url).hostname; } catch { /* ignore */ }

    return retryWithBackoff(
      async () => {
        await waitForRateLimit(domain, options?.signal);

        try {
          await apiBreaker.acquire();
        } catch (cbErr) {
          throw cbErr;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        if (options?.signal) {
          options.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            controller.abort();
          }, { once: true });
        }

        try {
          // Build headers
          const headers: Record<string, string> = { ...customHeaders };
          if (!headers['Content-Type']) {
            headers['Content-Type'] = 'application/json';
          }
          if (!headers['User-Agent']) {
            headers['User-Agent'] = getRandomUA();
          }

          // Apply signing to headers if configured
          if (signing && (signing.signHeaders as boolean)) {
            const signKey = signing.key as string;
            const headerKeys = (signing.headerKeys as string[]) || Object.keys(headers);
            const headersToSign: Record<string, string> = {};
            for (const k of headerKeys) {
              if (headers[k] !== undefined) {
                headersToSign[k] = headers[k];
              }
            }
            headers['sign'] = md5Sign(headersToSign, signKey);
          }

          // Build URL with params and signing
          let fetchUrl = url;
          const params = new URLSearchParams();
          // Parse existing query params from URL
          try {
            const urlObj = new URL(url);
            for (const [k, v] of urlObj.searchParams) {
              params.set(k, v);
            }
            // Strip query params from URL (we'll re-add them signed)
            fetchUrl = urlObj.origin + urlObj.pathname;
          } catch { /* keep url as-is */ }

          // Apply signing to params if configured
          if (signing && (signing.signParams as boolean)) {
            const signKey = signing.key as string;
            const excludeParams = new Set((signing.excludeParams as string[]) || []);
            const paramsObj: Record<string, string> = {};
            for (const [k, v] of params) {
              paramsObj[k] = v;
            }
            const signParams: Record<string, string> = {};
            for (const [k, v] of Object.entries(paramsObj)) {
              if (!excludeParams.has(k)) {
                signParams[k] = v;
              }
            }
            params.set('sign', md5Sign(signParams, signKey));
          }

          const queryString = params.toString();
          if (queryString) fetchUrl += '?' + queryString;

          // Determine which headers to send (exclude 'sign' from URL if it was a header-only thing)
          const fetchHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(headers)) {
            if (k !== 'sign' || (signing && signing.signParams)) {
              fetchHeaders[k] = v;
            }
          }
          // If signing both headers and params, the header sign should only include header keys
          if (signing && (signing.signHeaders as boolean) && !(signing.signParams as boolean)) {
            fetchHeaders['sign'] = headers['sign'];
          }

          const fetchOptions: RequestInit = {
            method: 'GET',
            headers: fetchHeaders,
            signal: controller.signal,
          };

          // Proxy support
          const proxyUrl = options?.proxy || options?.antiCrawl?.proxy;
          if (proxyUrl) {
            const init = bunProxyFetchInit(proxyUrl);
            Object.assign(fetchOptions, init);
          }

          console.log(`[ApiEngine] GET ${fetchUrl}`);
          const response = await fetch(fetchUrl, fetchOptions);
          const text = await readTextWithLimit(response, MAX_RESPONSE_SIZE);

          if (!response.ok) {
            throw new Error(`API returned ${response.status}: ${text.slice(0, 200)}`);
          }

          // Apply decryption if configured
          let resultText = text;
          if (decryption) {
            try {
              // Try to parse as JSON first, then decrypt the content field
              const json = JSON.parse(text);
              const contentField = (decryption.contentField as string) || 'content';
              const encryptedContent = jsonPath(json, `data.${contentField}`) as string;
              if (encryptedContent) {
                const decrypted = await aesDecrypt(
                  encryptedContent,
                  decryption.key as string,
                  (decryption.algorithm as string) || 'aes-256-cbc',
                  (decryption.inputEncoding as 'hex' | 'base64') || 'hex',
                  (decryption.ivFromResponse as boolean) ?? true,
                  (decryption.ivLength as number) || 16,
                  decryption.iv as string | undefined,
                );
                // Replace encrypted content with decrypted
                if (json.data && typeof json.data === 'object') {
                  (json.data as Record<string, unknown>)[contentField] = decrypted;
                }
                resultText = JSON.stringify(json);
              }
            } catch (decErr) {
              console.warn(`[ApiEngine] Decryption failed (returning raw response): ${decErr instanceof Error ? decErr.message : decErr}`);
              // Return raw response if decryption fails
            }
          }

          apiBreaker.recordSuccess();
          return {
            html: resultText,
            finalUrl: fetchUrl,
            statusCode: response.status,
            effectiveEngine: 'api',
          };
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const doNotRetry = options?.signal?.aborted || errMsg.includes('doNotRetry');
          if (doNotRetry) {
            apiBreaker.release();
          } else {
            apiBreaker.recordFailure();
          }
          throw err;
        } finally {
          clearTimeout(timer);
        }
      },
      {
        maxRetries: options?.antiCrawl?.retries ?? 3,
        baseDelay: 1000,
        maxDelay: 10000,
        signal: options?.signal,
      },
    );
  }

  close?(): Promise<void> {
    // No resources to clean up
    return Promise.resolve();
  }
}

// Export jsonPath/jsonPathAll for use by other modules (e.g., task-engine API mode)
export { jsonPath, jsonPathAll, md5Sign, aesDecrypt };

// ==================== Smart Engine Selector ====================

/**
 * Determine the best engine for a given request.
 * Logic:
 *   - If engine explicitly specified, use it
 *   - If antiCrawl.cloudBrowser is true, use cloud-browser
 *   - If antiCrawl.humanBehavior is true, use obscura
 *   - If antiCrawl.proxy && uaRotation, use obscura
 *   - If antiCrawl.useJsRender is true, use playwright
 *   - Domain learning: prefer the engine that last succeeded for this domain (within 30 min)
 *   - Default to cheerio (fastest)
 */
export function selectEngine(
  requestedEngine?: EngineType,
  antiCrawl?: {
    useJsRender?: boolean;
    cloudBrowser?: boolean;
    humanBehavior?: boolean;
    uaRotation?: boolean;
    cookies?: Array<{ name: string; value: string }>;
    proxy?: string;
  },
  domain?: string,
): EngineType {
  const VALID_ENGINES: EngineType[] = ['cheerio', 'playwright', 'firecrawl', 'agentql', 'cloud-browser', 'scrapling', 'obscura', 'dokobot', 'api'];
  if (requestedEngine) {
    if (VALID_ENGINES.includes(requestedEngine)) return requestedEngine;
    console.warn(`[selectEngine] Unknown engine '${requestedEngine}', falling back to auto-selection`);
  }
  if (antiCrawl?.cloudBrowser) return "cloud-browser";
  // If human behavior simulation is requested, must use obscura (has stealth + human sim)
  if (antiCrawl?.humanBehavior) return "obscura";
  // If proxy is set with UA rotation, obscura provides best anti-detection
  if (antiCrawl?.proxy && antiCrawl?.uaRotation) return "obscura";
  // JS rendering requested
  if (antiCrawl?.useJsRender) return "playwright";
  // Domain learning: prefer the engine that recently succeeded for this domain
  if (domain) {
    const learnedEngine = getDomainLastSuccessEngine(domain);
    if (learnedEngine && VALID_ENGINES.includes(learnedEngine)) {
      return learnedEngine;
    }
  }
  // If only UA rotation without JS rendering, cheerio is fine
  return "cheerio";
}

// ==================== Initialize All Engines ====================

export function initEngines(): void {
  // Register engines
  registerEngine(new CheerioEngine());
  registerEngine(new PlaywrightEngine());
  registerEngine(new FirecrawlEngine());
  registerEngine(new AgentQLEngine());
  registerEngine(new CloudBrowserEngine());
  registerEngine(new ScraplingEngine());
  registerEngine(new DokobotEngine());
  registerEngine(new ObscuraEngine());
  registerEngine(new ApiEngine());

  console.log(`[Engines] Available: ${getEngineNames().join(", ")}`);

  // Note: Playwright is lazy-loaded on first use (saves 200-500MB memory)
  // Previous pre-warm behavior removed to reduce idle memory consumption
}

// ==================== Cleanup ====================

export async function closeAllEngines(): Promise<void> {
  // Close Playwright
  if (engines.has("playwright")) {
    const pwEngine = engines.get("playwright");
    if (pwEngine?.close) await pwEngine.close();
  }
  // Close Obscura (has its own separate browser instance)
  if (engines.has("obscura")) {
    const obsEngine = engines.get("obscura");
    if (obsEngine?.close) await obsEngine.close();
  }
  // Close HTTP connection pool
  if (_cheerioAgent) {
    try { _cheerioAgent.close(); } catch { /* already closed */ }
    _cheerioAgent = null;
    _cheerioAgentPromise = null; // Also clear the promise to prevent returning closed agent
    console.log('[Engines] HTTP connection pool closed');
  }
  engines.clear();
  console.log("[Engines] All engines closed");
}