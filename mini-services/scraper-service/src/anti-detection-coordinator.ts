/**
 * Unified Anti-Detection Coordinator
 *
 * Singleton that orchestrates all anti-detection modules to produce a
 * complete, consistent fingerprint for each request and process each response.
 *
 * Consistency guarantee:
 *   - If we claim to be Chrome 134 on TLS, the UA and Client Hints must also say Chrome 134
 *   - All modules (TLS, HTTP/2, IP, Sec-CH-UA, Referrer) are coordinated
 *
 * Exports:
 *   - generateRequestProfile(domain, url) — before each request
 *   - processResponse(domain, url, response) — after each response
 */

import { getTLSFingerprintOptions, randomizeTLSNegotiationOrder, computeApproximateJA4 } from './tls-fingerprint';
import { getProfileForDomain, type FingerprintProfile } from './stealth';
import { generateSecChUAHeaders, inferSecFetchHeaders, getAcceptLanguage, getConnectionHeader, type FetchSite } from './request-fingerprint';
import { rateOptimizer } from './rate-optimizer';
import { concurrencyOptimizer } from './concurrency-optimizer';
import { adaptiveDelay } from './adaptive-delay';
import { detectCaptcha, type CaptchaDetection } from './captcha-detector';
import { analyzeResponse, type ResponseSignalResult } from './anti-crawl-signal-detector';
import { sessionManager } from './session-manager';
import { proxyManager } from './proxy-manager';
import { buildFetchHeaders } from './utils';

// ==================== Types ====================

export interface RequestProfile {
  /** The consistent fingerprint profile for this request */
  profile: FingerprintProfile;
  /** TLS options matching the profile's browser */
  tlsOptions: ReturnType<typeof getTLSFingerprintOptions>;
  /** JA4 fingerprint for logging/debugging */
  ja4: string;
  /** HTTP headers (UA, Sec-CH-UA, Sec-Fetch-*, Accept-Language, Connection) */
  headers: Record<string, string>;
  /** Session ID for this request */
  sessionId: string;
  /** Proxy URL if applicable */
  proxyUrl: string | null;
  /** Delay before making the request (ms) */
  delayMs: number;
  /** Concurrency level for this domain */
  concurrency: number;
  /** Rate (RPM) for this domain */
  rateRPM: number;
  /** Timestamp when profile was generated */
  generatedAt: number;
}

export interface ResponseProcessingResult {
  /** Whether the request was successful */
  success: boolean;
  /** CAPTCHA detection result */
  captcha: CaptchaDetection;
  /** Anti-crawl signal detection result */
  signals: ResponseSignalResult;
  /** Rate optimizer was updated */
  rateUpdated: boolean;
  /** Adaptive delay was updated */
  delayUpdated: boolean;
  /** Concurrency optimizer was updated */
  concurrencyUpdated: boolean;
  /** Recommended action based on signals */
  recommendedAction: 'continue' | 'slow_down' | 'backoff' | 'switch_engine' | 'switch_proxy';
}

// ==================== Coordinator ====================

class AntiDetectionCoordinator {
  private requestCount = 0;

  /**
   * Generate a complete, consistent request profile for a domain + URL.
   * Call this BEFORE each request to get all the fingerprint components.
   *
   * @param domain - Target domain
   * @param url - Target URL (for Sec-Fetch-* inference)
   * @param options - Optional overrides
   */
  generateRequestProfile(
    domain: string,
    url: string,
    options?: {
      /** Override the browser family */
      browserFamily?: string;
      /** Whether this is a navigation request */
      isNavigation?: boolean;
      /** Fetch site relationship */
      fetchSite?: FetchSite;
      /** TLS randomization level (0-3) */
      tlsRandomizeLevel?: number;
      /** Custom anti-crawl config */
      antiCrawlConfig?: Record<string, unknown>;
    }
  ): RequestProfile {
    this.requestCount++;
    const now = Date.now();

    // 1. Get consistent fingerprint profile (stealth module)
    const profile = getProfileForDomain(domain);

    // 2. Get TLS options matching the profile's browser
    let tlsOptions = getTLSFingerprintOptions(domain, profile.userAgent);

    // 3. Apply TLS negotiation order randomization
    const tlsRandomizeLevel = options?.tlsRandomizeLevel ?? 1;
    tlsOptions = randomizeTLSNegotiationOrder(tlsOptions, tlsRandomizeLevel);

    // 4. Compute JA4 fingerprint
    const ja4 = computeApproximateJA4(tlsOptions);

    // 5. Build consistent HTTP headers
    const headers: Record<string, string> = {};

    // 5a. User-Agent (from profile, consistent with TLS)
    headers['User-Agent'] = profile.userAgent;

    // 5b. Sec-CH-UA headers (matching the UA)
    const chHeaders = generateSecChUAHeaders(profile.userAgent);
    Object.assign(headers, chHeaders);

    // 5c. Sec-Fetch-* headers
    const isNavigation = options?.isNavigation ?? true;
    const fetchSite = options?.fetchSite ?? 'cross-site';
    const fetchHeaders = inferSecFetchHeaders(url, isNavigation, fetchSite);
    Object.assign(headers, fetchHeaders);

    // 5d. Accept-Language (rotated)
    headers['Accept-Language'] = getAcceptLanguage();

    // 5e. Connection header
    headers['Connection'] = getConnectionHeader();

    // 5f. Accept header
    if (isNavigation) {
      headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';
      headers['Upgrade-Insecure-Requests'] = '1';
    } else {
      headers['Accept'] = '*/*';
    }

    // 5g. Build additional fetch headers from anti-crawl config
    if (options?.antiCrawlConfig) {
      // antiCrawlConfig is Record<string, unknown> from options, but buildFetchHeaders expects AntiCrawl
      // This is safe because buildFetchHeaders only reads known AntiCrawl properties
      const acHeaders = buildFetchHeaders(options.antiCrawlConfig as any, undefined, url, 'novel');
      // Merge, but don't overwrite our consistent headers
      for (const [key, value] of Object.entries(acHeaders)) {
        if (!headers[key]) {
          headers[key] = value;
        }
      }
    }

    // 6. Get session
    const session = sessionManager.getSessionForRequest(domain);
    const sessionId = session?.sessionId || `auto-${domain}-${now}`;

    // 7. Get proxy
    const domainProxy = proxyManager.getDomainProxy(domain);
    const poolProxy = proxyManager.getProxy(domain);
    const proxyUrl = domainProxy?.url || poolProxy?.url || null;

    // 8. Get adaptive delay
    const delayMs = rateOptimizer.getRequestDelay(domain);

    // 9. Get concurrency level
    const concurrency = concurrencyOptimizer.getOptimalConcurrency(domain);

    // 10. Get rate
    const rateRPM = rateOptimizer.getOptimalRate(domain);

    return {
      profile,
      tlsOptions,
      ja4,
      headers,
      sessionId,
      proxyUrl,
      delayMs,
      concurrency,
      rateRPM,
      generatedAt: now,
    };
  }

  /**
   * Process a response after each request.
   * Feeds signals to all modules: signal detector, rate optimizer,
   * adaptive delay, and concurrency optimizer.
   *
   * @param domain - Target domain
   * @param url - Target URL
   * @param response - Response data
   */
  processResponse(
    domain: string,
    url: string,
    response: {
      statusCode: number;
      responseTime: number;
      html?: string;
      headers?: Record<string, string>;
      finalUrl?: string;
    }
  ): ResponseProcessingResult {
    const { statusCode, responseTime, html = '', headers: respHeaders = {} } = response;
    const success = statusCode >= 200 && statusCode < 400;

    // 1. CAPTCHA detection
    const captcha = detectCaptcha(html, url, statusCode);

    // 2. Anti-crawl signal detection
    const signals = analyzeResponse(statusCode, respHeaders, html);

    // 3. Determine if this was a block
    const isBlock = statusCode === 429 || statusCode === 403 || statusCode === 503 || captcha.detected;

    // 4. Feed to rate optimizer
    rateOptimizer.recordResponse(domain, statusCode, responseTime, captcha.detected);
    const rateUpdated = true;

    // 5. Feed to adaptive delay
    adaptiveDelay.recordResponse(domain, responseTime, success, statusCode);
    const delayUpdated = true;

    // 6. Feed to concurrency optimizer
    concurrencyOptimizer.recordRequestResult(domain, success, responseTime);
    const concurrencyUpdated = true;

    // 7. Determine recommended action
    let recommendedAction: ResponseProcessingResult['recommendedAction'] = 'continue';

    if (isBlock) {
      if (captcha.detected || signals.botConfidence > 70) {
        recommendedAction = 'switch_engine';
      } else if (statusCode === 429) {
        recommendedAction = 'backoff';
      } else {
        recommendedAction = 'slow_down';
      }
    } else if (signals.botConfidence > 40) {
      recommendedAction = 'slow_down';
    }

    // If approaching CAPTCHA threshold, recommend switching proxy
    if (captcha.detected && recommendedAction !== 'switch_engine') {
      recommendedAction = 'switch_proxy';
    }

    return {
      success,
      captcha,
      signals,
      rateUpdated,
      delayUpdated,
      concurrencyUpdated,
      recommendedAction,
    };
  }

  /**
   * Get coordinator stats (for monitoring/debugging).
   */
  getStats(): {
    totalRequests: number;
    rateOptimizer: ReturnType<typeof rateOptimizer.getStats>;
    concurrencyOptimizer: ReturnType<typeof concurrencyOptimizer.getStats>;
  } {
    return {
      totalRequests: this.requestCount,
      rateOptimizer: rateOptimizer.getStats(),
      concurrencyOptimizer: concurrencyOptimizer.getStats(),
    };
  }
}

// Singleton
export const antiDetectionCoordinator = new AntiDetectionCoordinator();
