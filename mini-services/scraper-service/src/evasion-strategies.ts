/**
 * Anti-Crawl Evasion Strategies
 *
 * A collection of specific evasion techniques for common anti-crawl systems:
 *
 *   - CloudflareEvasion: CF JS challenge, Turnstile, managed challenge
 *   - GenericWAFEvasion: Akamai, Imperva, F5, Sucuri detection + header ordering
 *   - RateLimitEvasion: X-RateLimit-* header parsing, token bucket mirroring
 *   - ContentProtectionEvasion: JS-rendered, obfuscated, lazy-loaded content
 */

import { logger } from './logger';
const log = logger.child('EvasionStrategies');

import { detectCfChallengeType } from './page-type-detector';

// ==================== Types ====================

export interface EvasionResult {
  strategy: string;
  action: 'retry' | 'wait_and_retry' | 'change_fingerprint' | 'use_js_engine' | 'manual_solve' | 'abort';
  waitMs?: number;
  engine?: string;
  reason: string;
  metadata?: Record<string, unknown>;
}

export interface EvasionStrategyInfo {
  name: string;
  description: string;
  type: 'cloudflare' | 'waf' | 'rate_limit' | 'content_protection';
  capabilities: string[];
}

// ==================== CloudflareEvasion ====================

export class CloudflareEvasion {
  /** Track CF challenge attempts per domain */
  private challengeAttempts: Map<string, number> = new Map();
  private readonly MAX_CHALLENGE_ATTEMPTS = 3;
  private readonly JS_CHALLENGE_TIMEOUT = 15_000; // 15s for JS challenge
  private readonly MANAGED_RETRY_DELAY = 5_000;   // 5s before retrying managed

  /**
   * Detect and handle Cloudflare challenge.
   * @param html - Response HTML
   * @param domain - Target domain
   * @param statusCode - HTTP status code
   * @returns Evasion result with action to take
   */
  detectAndEvade(html: string, domain: string, statusCode: number): EvasionResult {
    const challengeType = detectCfChallengeType(html);
    const attempts = this.challengeAttempts.get(domain) || 0;

    // Not a CF challenge
    if (challengeType === 'none' && statusCode !== 503) {
      return {
        strategy: 'cloudflare',
        action: 'retry',
        reason: 'No CF challenge detected',
      };
    }

    // Check if we've exceeded max attempts
    if (attempts >= this.MAX_CHALLENGE_ATTEMPTS) {
      log.info(`CF evasion: max attempts (${this.MAX_CHALLENGE_ATTEMPTS}) reached for ${domain}`);
      return {
        strategy: 'cloudflare',
        action: 'abort',
        reason: `Exceeded max CF challenge attempts (${this.MAX_CHALLENGE_ATTEMPTS})`,
        metadata: { challengeType, attempts },
      };
    }

    this.challengeAttempts.set(domain, attempts + 1);

    switch (challengeType) {
      case 'js_challenge':
        log.info(`CF JS challenge detected for ${domain}, attempt ${attempts + 1}`);
        return {
          strategy: 'cloudflare',
          action: 'use_js_engine',
          engine: 'obscura',
          waitMs: this.JS_CHALLENGE_TIMEOUT,
          reason: 'CF JS challenge — use stealth browser engine with extended timeout',
          metadata: { challengeType, attempt: attempts + 1 },
        };

      case 'turnstile':
        // Extract sitekey for logging
        const sitekeyMatch = html.match(/sitekey\s*=\s*["']([^"']+)["']/);
        const sitekey = sitekeyMatch ? sitekeyMatch[1] : 'unknown';
        log.info(`CF Turnstile detected for ${domain}, sitekey: ${sitekey}`);
        return {
          strategy: 'cloudflare',
          action: 'manual_solve',
          reason: `CF Turnstile CAPTCHA — sitekey: ${sitekey}. Requires manual solving or CAPTCHA service.`,
          metadata: { challengeType: 'turnstile', sitekey, attempt: attempts + 1 },
        };

      case 'managed':
        log.info(`CF managed challenge detected for ${domain}, attempt ${attempts + 1}`);
        return {
          strategy: 'cloudflare',
          action: 'change_fingerprint',
          waitMs: this.MANAGED_RETRY_DELAY + Math.random() * 3000,
          reason: 'CF managed challenge — retry with different fingerprint after delay',
          metadata: { challengeType, attempt: attempts + 1 },
        };

      default:
        // 503 with CF headers but no recognized challenge type
        if (statusCode === 503) {
          return {
            strategy: 'cloudflare',
            action: 'wait_and_retry',
            waitMs: 3000 + Math.random() * 5000,
            reason: 'CF 503 response — wait and retry',
            metadata: { statusCode, attempt: attempts + 1 },
          };
        }
        return {
          strategy: 'cloudflare',
          action: 'retry',
          reason: 'Unrecognized CF response pattern',
        };
    }
  }

  /** Reset attempts for a domain (e.g., after successful request) */
  resetAttempts(domain: string): void {
    this.challengeAttempts.delete(domain);
  }

  getStats(): Record<string, number> {
    return Object.fromEntries(this.challengeAttempts);
  }
}

// ==================== GenericWAFEvasion ====================

export type WAFType = 'akamai' | 'imperva' | 'f5' | 'sucuri' | 'cloudflare' | 'unknown';

/** WAF-specific header ordering.
 * Different WAFs check for different header order patterns.
 * Chrome's actual order is used as the baseline.
 */
const HEADER_ORDERS: Record<string, string[]> = {
  chrome: [
    'Host', 'Connection', 'Cache-Control', 'Sec-Ch-Ua', 'Sec-Ch-Ua-Mobile',
    'Sec-Ch-Ua-Platform', 'Upgrade-Insecure-Requests', 'User-Agent', 'Accept',
    'Sec-Fetch-Site', 'Sec-Fetch-Mode', 'Sec-Fetch-User', 'Sec-Fetch-Dest',
    'Accept-Encoding', 'Accept-Language', 'Cookie',
  ],
  // Akamai checks for specific header order and presence
  akamai: [
    'Host', 'User-Agent', 'Accept', 'Accept-Language', 'Accept-Encoding',
    'Connection', 'Cookie', 'Upgrade-Insecure-Requests', 'Sec-Fetch-Site',
    'Sec-Fetch-Mode', 'Sec-Fetch-User', 'Sec-Fetch-Dest',
  ],
};

/** WAF detection patterns */
const WAF_DETECTORS: Array<{ type: WAFType; patterns: RegExp[] }> = [
  {
    type: 'akamai',
    patterns: [
      /X-Akamai/i,
      /Akamai-BOT/i,
      /x-akamai-request-id/i,
      /<title>Access Denied.*Akamai/i,
    ],
  },
  {
    type: 'imperva',
    patterns: [
      /X-Iinfo/i,
      /Incapsula/i,
      /X-CDN.*Incapsula/i,
      /<title>.*Incapsula/i,
      /_incap_ses/i,
    ],
  },
  {
    type: 'f5',
    patterns: [
      /X-WA-Info/i,
      /F5-BigIP/i,
      /BigIP/i,
      /TS[a-z]{4,}/i,  // F5 cookie pattern
    ],
  },
  {
    type: 'sucuri',
    patterns: [
      /X-Sucuri/i,
      /Sucuri-Cloudproxy/i,
      /<title>.*Sucuri/i,
    ],
  },
  {
    type: 'cloudflare',
    patterns: [
      /cf-ray/i,
      /server.*cloudflare/i,
      /__cfduid/i,
    ],
  },
];

export class GenericWAFEvasion {
  /** Detected WAF type per domain */
  private detectedWafs: Map<string, WAFType> = new Map();

  /**
   * Detect WAF type from response headers and HTML.
   */
  detectWAF(responseHeaders: Record<string, string>, html: string, domain: string): WAFType {
    // Check cached detection
    const cached = this.detectedWafs.get(domain);
    if (cached && cached !== 'unknown') return cached;

    // Check response headers
    const headerStr = Object.keys(responseHeaders).join(' ');
    const htmlStr = html.slice(0, 5000); // Only check first 5K of HTML

    for (const detector of WAF_DETECTORS) {
      for (const pattern of detector.patterns) {
        if (pattern.test(headerStr) || pattern.test(htmlStr)) {
          this.detectedWafs.set(domain, detector.type);
          log.info(`Detected WAF ${detector.type} for ${domain}`);
          return detector.type;
        }
      }
    }

    this.detectedWafs.set(domain, 'unknown');
    return 'unknown';
  }

  /**
   * Get WAF-specific header ordering and values.
   * Returns headers in the correct order for the detected WAF.
   */
  getWAFHeaders(wafType: WAFType, url: string, userAgent: string): {
    headers: Record<string, string>;
    order: string[];
  } {
    const order = HEADER_ORDERS[wafType] || HEADER_ORDERS.chrome;

    const headers: Record<string, string> = {
      'User-Agent': userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'max-age=0',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
    };

    // WAF-specific adjustments
    if (wafType === 'akamai') {
      // Akamai checks for consistent Akamai-specific headers
      headers['Akamai-BM-Telemetry'] = '1';
    }

    return { headers, order };
  }

  /**
   * Get randomized request timing to avoid pattern detection.
   * Different WAFs have different timing sensitivity.
   */
  getRequestTiming(wafType: WAFType): { minMs: number; maxMs: number; jitterMs: number } {
    switch (wafType) {
      case 'akamai':
        // Akamai is sensitive to precise timing patterns
        return { minMs: 2000, maxMs: 8000, jitterMs: 1500 };
      case 'imperva':
        // Imperva detects rapid-fire requests
        return { minMs: 3000, maxMs: 10000, jitterMs: 2000 };
      case 'f5':
        return { minMs: 1500, maxMs: 6000, jitterMs: 1000 };
      default:
        return { minMs: 1000, maxMs: 5000, jitterMs: 800 };
    }
  }

  getDetectedWAFs(): Record<string, WAFType> {
    return Object.fromEntries(this.detectedWafs);
  }
}

// ==================== RateLimitEvasion ====================

export interface RateLimitInfo {
  limit: number | null;        // Requests per window
  remaining: number | null;    // Remaining requests
  resetAt: number | null;      // Unix timestamp when limit resets
  retryAfter: number | null;   // Seconds to wait before retrying
}

export class RateLimitEvasion {
  /** Token bucket per domain: mirrors server's rate limit */
  private tokenBuckets: Map<string, {
    tokens: number;
    maxTokens: number;
    refillRate: number;  // tokens per second
    lastRefill: number;
  }> = new Map();

  /**
   * Parse rate limit headers from response.
   * Supports standard X-RateLimit-* and Retry-After headers.
   */
  parseRateLimitHeaders(responseHeaders: Record<string, string>): RateLimitInfo {
    const result: RateLimitInfo = {
      limit: null,
      remaining: null,
      resetAt: null,
      retryAfter: null,
    };

    // X-RateLimit-Limit
    const limitStr = responseHeaders['x-ratelimit-limit'] || responseHeaders['x-rate-limit-limit'];
    if (limitStr) result.limit = parseInt(limitStr, 10);

    // X-RateLimit-Remaining
    const remainingStr = responseHeaders['x-ratelimit-remaining'] || responseHeaders['x-rate-limit-remaining'];
    if (remainingStr) result.remaining = parseInt(remainingStr, 10);

    // X-RateLimit-Reset (Unix timestamp)
    const resetStr = responseHeaders['x-ratelimit-reset'] || responseHeaders['x-rate-limit-reset'];
    if (resetStr) {
      const parsed = parseInt(resetStr, 10);
      // Could be Unix timestamp or seconds-from-now
      if (parsed > 1e10) {
        // Millisecond timestamp
        result.resetAt = Math.floor(parsed / 1000);
      } else if (parsed > 1e7) {
        // Second timestamp
        result.resetAt = parsed;
      } else {
        // Seconds from now
        result.resetAt = Math.floor(Date.now() / 1000) + parsed;
      }
    }

    // Retry-After
    const retryStr = responseHeaders['retry-after'];
    if (retryStr) {
      const parsed = parseInt(retryStr, 10);
      if (!isNaN(parsed)) {
        // Could be seconds or HTTP-date
        if (parsed < 1e6) {
          // Seconds
          result.retryAfter = parsed;
        } else {
          // HTTP-date — calculate seconds until then
          const date = new Date(retryStr);
          if (!isNaN(date.getTime())) {
            result.retryAfter = Math.max(0, Math.ceil((date.getTime() - Date.now()) / 1000));
          }
        }
      } else {
        // HTTP-date format
        const date = new Date(retryStr);
        if (!isNaN(date.getTime())) {
          result.retryAfter = Math.max(0, Math.ceil((date.getTime() - Date.now()) / 1000));
        }
      }
    }

    return result;
  }

  /**
   * Calculate exact wait time from rate limit info.
   * Returns milliseconds to wait before next request.
   */
  calculateWaitTime(rateLimitInfo: RateLimitInfo): number {
    // Priority 1: Retry-After header (most authoritative)
    if (rateLimitInfo.retryAfter !== null && rateLimitInfo.retryAfter > 0) {
      // Add small jitter (±10%) to avoid synchronized retries
      const jitter = rateLimitInfo.retryAfter * 0.1 * (Math.random() * 2 - 1);
      return Math.max(100, (rateLimitInfo.retryAfter + jitter) * 1000);
    }

    // Priority 2: Reset time
    if (rateLimitInfo.resetAt !== null) {
      const nowSec = Math.floor(Date.now() / 1000);
      const waitSec = rateLimitInfo.resetAt - nowSec;
      if (waitSec > 0) {
        const jitter = waitSec * 0.1 * (Math.random() * 2 - 1);
        return Math.max(100, (waitSec + jitter) * 1000);
      }
    }

    // Priority 3: Token bucket running low
    if (rateLimitInfo.remaining !== null && rateLimitInfo.remaining <= 1 && rateLimitInfo.limit !== null) {
      // Estimate 1 token per (window/limit) seconds
      // Use 60s as default window
      const estimatedWait = 60 / (rateLimitInfo.limit || 10);
      return Math.max(100, estimatedWait * 1000);
    }

    // No rate limit info — no wait needed
    return 0;
  }

  /**
   * Update the token bucket for a domain based on rate limit headers.
   * The bucket mirrors the server's rate limit for local throttling.
   */
  updateTokenBucket(domain: string, rateLimitInfo: RateLimitInfo): void {
    if (rateLimitInfo.limit === null) return;

    const existing = this.tokenBuckets.get(domain);
    const maxTokens = rateLimitInfo.limit;
    const refillRate = maxTokens / 60; // Assume 60s window

    if (!existing || existing.maxTokens !== maxTokens) {
      // Create new bucket
      this.tokenBuckets.set(domain, {
        tokens: rateLimitInfo.remaining ?? maxTokens,
        maxTokens,
        refillRate,
        lastRefill: Date.now(),
      });
    } else {
      // Update existing bucket with server's remaining count
      existing.maxTokens = maxTokens;
      existing.refillRate = refillRate;
      if (rateLimitInfo.remaining !== null) {
        existing.tokens = Math.min(rateLimitInfo.remaining, maxTokens);
      }
      existing.lastRefill = Date.now();
    }
  }

  /**
   * Try to consume a token from the domain's bucket.
   * Returns true if a token was available, false if rate limited.
   */
  tryConsume(domain: string): { allowed: boolean; waitMs: number } {
    const bucket = this.tokenBuckets.get(domain);
    if (!bucket) return { allowed: true, waitMs: 0 }; // No bucket = no local rate limit

    // Refill tokens based on elapsed time
    const now = Date.now();
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(bucket.maxTokens, bucket.tokens + elapsed * bucket.refillRate);
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, waitMs: 0 };
    }

    // Calculate wait time until next token
    const waitMs = Math.ceil((1 - bucket.tokens) / bucket.refillRate * 1000);
    return { allowed: false, waitMs };
  }

  getTokenBucketStats(): Record<string, { tokens: number; maxTokens: number; refillRate: number }> {
    const result: Record<string, { tokens: number; maxTokens: number; refillRate: number }> = {};
    for (const [domain, bucket] of this.tokenBuckets) {
      result[domain] = {
        tokens: Math.round(bucket.tokens * 100) / 100,
        maxTokens: bucket.maxTokens,
        refillRate: Math.round(bucket.refillRate * 100) / 100,
      };
    }
    return result;
  }
}

// ==================== ContentProtectionEvasion ====================

export class ContentProtectionEvasion {
  /**
   * Detect JavaScript-rendered content.
   * These pages return minimal HTML with JS that renders the actual content.
   */
  detectJsRenderedContent(html: string): {
    isJsRendered: boolean;
    confidence: number;
    evidence: string[];
  } {
    const evidence: string[] = [];
    let score = 0;

    // Very little visible text
    const textLen = html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().length;
    if (textLen < 100) {
      score += 0.3;
      evidence.push(`Very little visible text: ${textLen} chars`);
    }

    // Has React/Vue/Angular bootstrap
    if (/<div[^>]*id\s*=\s*["']root["']/i.test(html) ||
      /<div[^>]*id\s*=\s*["']app["']/i.test(html) ||
      /__NEXT_DATA__/i.test(html) ||
      /__NUXT__/i.test(html)) {
      score += 0.4;
      evidence.push('SPA framework root element detected');
    }

    // Has inline bundle scripts
    const scriptCount = (html.match(/<script/gi) || []).length;
    if (scriptCount > 3) {
      score += 0.2;
      evidence.push(`${scriptCount} script tags found`);
    }

    // Has window.__INITIAL_STATE__ or similar
    if (/window\.__[A-Z_]+__/i.test(html)) {
      score += 0.3;
      evidence.push('Hydration state object found');
    }

    return {
      isJsRendered: score >= 0.4,
      confidence: Math.min(score, 1),
      evidence,
    };
  }

  /**
   * Detect encoded/obfuscated content.
   * Some sites encode content in base64, hex, or custom encoding.
   */
  detectEncodedContent(html: string): {
    isEncoded: boolean;
    encodingType: string;
    confidence: number;
  } {
    // Base64 content in data attributes
    if (/data\s*=\s*["'][A-Za-z0-9+/=]{100,}["']/i.test(html)) {
      return { isEncoded: true, encodingType: 'base64_data_attr', confidence: 0.7 };
    }

    // Hex-encoded content in JavaScript
    if (/\\x[0-9a-f]{2}/i.test(html) && (html.match(/\\x[0-9a-f]{2}/gi) || []).length > 20) {
      return { isEncoded: true, encodingType: 'hex_escape', confidence: 0.6 };
    }

    // Unicode escape sequences
    if (/\\u[0-9a-f]{4}/i.test(html) && (html.match(/\\u[0-9a-f]{4}/gi) || []).length > 20) {
      return { isEncoded: true, encodingType: 'unicode_escape', confidence: 0.5 };
    }

    // Custom decode function
    if (/decode|unpack|uncompress/i.test(html) && /function\s*\(/i.test(html)) {
      return { isEncoded: true, encodingType: 'custom_decode', confidence: 0.4 };
    }

    return { isEncoded: false, encodingType: 'none', confidence: 0 };
  }

  /**
   * Detect lazy-loaded content that needs scrolling.
   * Returns selectors that likely trigger lazy loading.
   */
  detectLazyLoadedContent(html: string): {
    hasLazyContent: boolean;
    selectors: string[];
    confidence: number;
  } {
    const selectors: string[] = [];
    let score = 0;

    // Lazy load images
    if (/data-src\s*=/i.test(html) || /data-original\s*=/i.test(html) ||
      /loading\s*=\s*["']lazy["']/i.test(html)) {
      score += 0.3;
      selectors.push('img[data-src]', 'img[data-original]', 'img[loading="lazy"]');
    }

    // Infinite scroll container
    if (/<div[^>]*(id|class)\s*=\s*["'][^"']*(scroll|load-more|infinite|pagination)["']/i.test(html)) {
      score += 0.4;
      selectors.push('.infinite-scroll', '.load-more', '.pagination');
    }

    // IntersectionObserver (JS-based lazy loading)
    if (/IntersectionObserver/i.test(html)) {
      score += 0.3;
      selectors.push('[data-observer]');
    }

    // "Load more" button
    if (/加载更多|查看更多|load.more|show.more/i.test(html)) {
      score += 0.3;
      selectors.push('button:has(.load-more)', 'a:has(.load-more)');
    }

    return {
      hasLazyContent: score >= 0.3,
      selectors,
      confidence: Math.min(score, 1),
    };
  }

  /**
   * Get recommended engine for content-protected page.
   */
  getRecommendedEngine(html: string): {
    engine: string;
    reason: string;
    needsScroll: boolean;
  } {
    const jsRendered = this.detectJsRenderedContent(html);
    const lazyLoaded = this.detectLazyLoadedContent(html);
    const encoded = this.detectEncodedContent(html);

    if (jsRendered.isJsRendered) {
      return {
        engine: 'obscura',
        reason: `JS-rendered content (confidence: ${(jsRendered.confidence * 100).toFixed(0)}%) — needs stealth browser`,
        needsScroll: lazyLoaded.hasLazyContent,
      };
    }

    if (lazyLoaded.hasLazyContent) {
      return {
        engine: 'playwright',
        reason: `Lazy-loaded content detected — needs browser with scrolling`,
        needsScroll: true,
      };
    }

    if (encoded.isEncoded) {
      return {
        engine: 'cheerio',
        reason: `Encoded content (${encoded.encodingType}) — extract and decode client-side`,
        needsScroll: false,
      };
    }

    return {
      engine: 'cheerio',
      reason: 'No content protection detected — static parser sufficient',
      needsScroll: false,
    };
  }
}

// ==================== Unified Evasion Strategy Selector ====================

export class EvasionStrategySelector {
  readonly cloudflare = new CloudflareEvasion();
  readonly waf = new GenericWAFEvasion();
  readonly rateLimit = new RateLimitEvasion();
  readonly contentProtection = new ContentProtectionEvasion();

  /**
   * Analyze a response and determine the best evasion strategy.
   * This is the main entry point for the scraping pipeline.
   */
  analyze(options: {
    html: string;
    url: string;
    domain: string;
    statusCode: number;
    responseHeaders?: Record<string, string>;
  }): EvasionResult {
    const { html, url, domain, statusCode, responseHeaders = {} } = options;

    // Priority 1: Cloudflare challenge
    if (statusCode === 503 || /cf-challenge|cloudflare/i.test(html)) {
      return this.cloudflare.detectAndEvade(html, domain, statusCode);
    }

    // Priority 2: Rate limiting (429 or rate limit headers)
    if (statusCode === 429) {
      const rateInfo = this.rateLimit.parseRateLimitHeaders(responseHeaders);
      const waitMs = this.rateLimit.calculateWaitTime(rateInfo);
      this.rateLimit.updateTokenBucket(domain, rateInfo);
      return {
        strategy: 'rate_limit',
        action: 'wait_and_retry',
        waitMs: waitMs || (5000 + Math.random() * 10000),
        reason: `HTTP 429 — wait ${(waitMs / 1000).toFixed(1)}s before retry`,
        metadata: { rateInfo },
      };
    }

    // Priority 3: WAF detection
    const wafType = this.waf.detectWAF(responseHeaders, html, domain);
    if (wafType !== 'unknown' && (statusCode === 403 || statusCode === 401)) {
      const timing = this.waf.getRequestTiming(wafType);
      return {
        strategy: 'waf',
        action: 'change_fingerprint',
        waitMs: timing.minMs + Math.random() * (timing.maxMs - timing.minMs),
        reason: `WAF ${wafType} detected with HTTP ${statusCode} — retry with new fingerprint`,
        metadata: { wafType },
      };
    }

    // Priority 4: Content protection
    const cpResult = this.contentProtection.detectJsRenderedContent(html);
    if (cpResult.isJsRendered) {
      return {
        strategy: 'content_protection',
        action: 'use_js_engine',
        engine: 'obscura',
        reason: `JS-rendered content detected — use browser engine`,
        metadata: { confidence: cpResult.confidence, evidence: cpResult.evidence },
      };
    }

    // No evasion needed
    return {
      strategy: 'none',
      action: 'retry',
      reason: 'No anti-crawl evasion needed',
    };
  }

  /**
   * List all available strategies.
   */
  listStrategies(): EvasionStrategyInfo[] {
    return [
      {
        name: 'cloudflare',
        description: 'Cloudflare challenge evasion (JS challenge, Turnstile, managed)',
        type: 'cloudflare',
        capabilities: ['js_challenge', 'turnstile_detect', 'managed_challenge', 'fingerprint_rotation'],
      },
      {
        name: 'waf',
        description: 'Generic WAF evasion (Akamai, Imperva, F5, Sucuri)',
        type: 'waf',
        capabilities: ['waf_detection', 'header_ordering', 'timing_randomization'],
      },
      {
        name: 'rate_limit',
        description: 'Rate limit evasion (X-RateLimit-*, Retry-After, token bucket)',
        type: 'rate_limit',
        capabilities: ['header_parsing', 'token_bucket', 'precise_wait', 'jitter'],
      },
      {
        name: 'content_protection',
        description: 'Content protection evasion (JS-rendered, encoded, lazy-loaded)',
        type: 'content_protection',
        capabilities: ['js_render_detect', 'encoding_detect', 'lazy_load_detect', 'engine_recommendation'],
      },
    ];
  }
}

// ==================== Singleton ====================

export const evasionStrategies = new EvasionStrategySelector();
