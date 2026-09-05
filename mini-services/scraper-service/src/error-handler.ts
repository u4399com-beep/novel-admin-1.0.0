/**
 * Unified Error Handling for Scraper Service
 *
 * Provides a ScrapeError class with structured codes, and a central
 * handleScrapeError() that determines retry strategy, backoff, and
 * engine upgrade recommendations.
 */

import { logger } from './logger';

const log = logger.child('ErrorHandler');

// ==================== Error Codes ====================

export type ScrapeErrorCode =
  | 'RATE_LIMITED'
  | 'CAPTCHA'
  | 'PROXY_ERROR'
  | 'TIMEOUT'
  | 'CONTENT_INVALID'
  | 'NETWORK_ERROR'
  | 'ENGINE_ERROR';

// ==================== ScrapeError ====================

export class ScrapeError extends Error {
  readonly code: ScrapeErrorCode;
  readonly domain: string;
  readonly url: string;
  readonly retryable: boolean;
  readonly fatal: boolean;
  readonly cause?: Error;

  constructor(
    code: ScrapeErrorCode,
    message: string,
    options: {
      domain?: string;
      url?: string;
      retryable?: boolean;
      fatal?: boolean;
      cause?: Error;
    } = {}
  ) {
    super(message);
    this.name = 'ScrapeError';
    this.code = code;
    this.domain = options.domain || '';
    this.url = options.url || '';
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE[code];
    this.fatal = options.fatal ?? false;
    this.cause = options.cause;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      domain: this.domain,
      url: this.url,
      retryable: this.retryable,
      fatal: this.fatal,
    };
  }
}

// ==================== Default Retryability ====================

const DEFAULT_RETRYABLE: Record<ScrapeErrorCode, boolean> = {
  RATE_LIMITED: true,
  CAPTCHA: true,
  PROXY_ERROR: true,
  TIMEOUT: true,
  CONTENT_INVALID: false,
  NETWORK_ERROR: true,
  ENGINE_ERROR: true,
};

// ==================== Error Context ====================

export interface ErrorContext {
  /** Domain being scraped */
  domain: string;
  /** URL being scraped */
  url: string;
  /** Current engine */
  engine: string;
  /** Current retry count */
  retryCount: number;
  /** Max retries allowed */
  maxRetries: number;
  /** Last HTTP status code (if available) */
  statusCode?: number;
  /** Whether a CAPTCHA was detected */
  captchaDetected?: boolean;
}

// ==================== Retry Strategy ====================

export interface RetryStrategy {
  /** Whether to retry */
  shouldRetry: boolean;
  /** Delay before retry (ms) */
  backoffMs: number;
  /** Whether to switch engine before retry */
  switchEngine: boolean;
  /** Recommended next engine */
  nextEngine?: string;
  /** Whether to rotate proxy before retry */
  rotateProxy: boolean;
  /** Human-readable message */
  message: string;
}

// ==================== Engine Upgrade Path ====================

const ENGINE_UPGRADE_PATH: Record<string, string> = {
  cheerio: 'playwright',
  playwright: 'obscura',
  obscura: 'cloud-browser',
};

// ==================== handleScrapeError ====================

/**
 * Central error handler that determines retry strategy for any scraping error.
 *
 * @param error - The error to handle
 * @param context - Current scraping context
 * @returns Retry strategy recommendation
 */
export function handleScrapeError(error: unknown, context: ErrorContext): RetryStrategy {
  // Wrap non-ScrapeError errors
  const scrapeErr = error instanceof ScrapeError
    ? error
    : classifyError(error, context);

  // Log the error
  log.warn(`Scrape error [${scrapeErr.code}]: ${scrapeErr.message}`, {
    code: scrapeErr.code,
    domain: scrapeErr.domain,
    url: scrapeErr.url,
    retryable: scrapeErr.retryable,
    retryCount: context.retryCount,
  }, scrapeErr.domain);

  // Fatal errors — never retry
  if (scrapeErr.fatal) {
    return {
      shouldRetry: false,
      backoffMs: 0,
      switchEngine: false,
      rotateProxy: false,
      message: `Fatal error [${scrapeErr.code}]: ${scrapeErr.message}`,
    };
  }

  // Exceeded max retries
  if (context.retryCount >= context.maxRetries) {
    return {
      shouldRetry: false,
      backoffMs: 0,
      switchEngine: false,
      rotateProxy: false,
      message: `Max retries (${context.maxRetries}) exceeded for [${scrapeErr.code}]: ${scrapeErr.message}`,
    };
  }

  // Determine strategy by code
  switch (scrapeErr.code) {
    case 'RATE_LIMITED': {
      const backoffMs = computeExponentialBackoff(context.retryCount, 2000, 120_000);
      return {
        shouldRetry: true,
        backoffMs,
        switchEngine: false,
        rotateProxy: context.retryCount >= 2,
        message: `Rate limited, backing off ${backoffMs}ms (retry ${context.retryCount + 1}/${context.maxRetries})`,
      };
    }

    case 'CAPTCHA': {
      const nextEngine = ENGINE_UPGRADE_PATH[context.engine];
      const shouldSwitch = !!nextEngine;
      return {
        shouldRetry: true,
        backoffMs: 3000 + Math.floor(Math.random() * 5000),
        switchEngine: shouldSwitch,
        nextEngine: nextEngine || undefined,
        rotateProxy: !shouldSwitch,
        message: shouldSwitch
          ? `CAPTCHA detected, upgrading engine ${context.engine} → ${nextEngine}`
          : `CAPTCHA detected on ${context.engine}, rotating proxy`,
      };
    }

    case 'PROXY_ERROR': {
      return {
        shouldRetry: true,
        backoffMs: 1000,
        switchEngine: false,
        rotateProxy: true,
        message: `Proxy error, rotating proxy (retry ${context.retryCount + 1}/${context.maxRetries})`,
      };
    }

    case 'TIMEOUT': {
      const backoffMs = computeExponentialBackoff(context.retryCount, 3000, 60_000);
      return {
        shouldRetry: true,
        backoffMs,
        switchEngine: context.retryCount >= 2,
        nextEngine: ENGINE_UPGRADE_PATH[context.engine] || undefined,
        rotateProxy: false,
        message: `Timeout, backing off ${backoffMs}ms (retry ${context.retryCount + 1}/${context.maxRetries})`,
      };
    }

    case 'NETWORK_ERROR': {
      const backoffMs = computeExponentialBackoff(context.retryCount, 1000, 30_000);
      return {
        shouldRetry: true,
        backoffMs,
        switchEngine: false,
        rotateProxy: context.retryCount >= 1,
        message: `Network error, backing off ${backoffMs}ms (retry ${context.retryCount + 1}/${context.maxRetries})`,
      };
    }

    case 'ENGINE_ERROR': {
      const nextEngine = ENGINE_UPGRADE_PATH[context.engine];
      return {
        shouldRetry: true,
        backoffMs: 2000,
        switchEngine: !!nextEngine,
        nextEngine: nextEngine || undefined,
        rotateProxy: false,
        message: nextEngine
          ? `Engine error on ${context.engine}, switching to ${nextEngine}`
          : `Engine error on ${context.engine}, retrying`,
      };
    }

    case 'CONTENT_INVALID': {
      // Content issues are usually not retryable with same settings
      return {
        shouldRetry: context.retryCount < 1,
        backoffMs: 2000,
        switchEngine: context.retryCount >= 1,
        nextEngine: ENGINE_UPGRADE_PATH[context.engine] || undefined,
        rotateProxy: false,
        message: `Invalid content, ${context.retryCount < 1 ? 'retrying once' : 'giving up'}`,
      };
    }

    default: {
      return {
        shouldRetry: scrapeErr.retryable,
        backoffMs: 2000,
        switchEngine: false,
        rotateProxy: false,
        message: `Unknown error [${scrapeErr.code}]: ${scrapeErr.message}`,
      };
    }
  }
}

// ==================== classifyError ====================

/**
 * Classify an arbitrary error into a ScrapeError.
 */
function classifyError(error: unknown, context: ErrorContext): ScrapeError {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();

    // Timeout
    if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('abort')) {
      return new ScrapeError('TIMEOUT', error.message, {
        domain: context.domain,
        url: context.url,
        cause: error,
      });
    }

    // CAPTCHA
    if (msg.includes('captcha') || context.captchaDetected) {
      return new ScrapeError('CAPTCHA', error.message, {
        domain: context.domain,
        url: context.url,
        cause: error,
      });
    }

    // Rate limit
    if (msg.includes('rate limit') || msg.includes('429') || context.statusCode === 429) {
      return new ScrapeError('RATE_LIMITED', error.message, {
        domain: context.domain,
        url: context.url,
        cause: error,
      });
    }

    // Proxy
    if (msg.includes('proxy') || msg.includes('socks') || msg.includes('econnrefused')) {
      return new ScrapeError('PROXY_ERROR', error.message, {
        domain: context.domain,
        url: context.url,
        cause: error,
      });
    }

    // Network
    if (
      msg.includes('econnreset') || msg.includes('enotfound') ||
      msg.includes('ehostunreach') || msg.includes('enetunreach') ||
      msg.includes('socket hang up') || msg.includes('fetch failed')
    ) {
      return new ScrapeError('NETWORK_ERROR', error.message, {
        domain: context.domain,
        url: context.url,
        cause: error,
      });
    }

    // Engine-specific
    if (msg.includes('browser') || msg.includes('playwright') || msg.includes('page crashed')) {
      return new ScrapeError('ENGINE_ERROR', error.message, {
        domain: context.domain,
        url: context.url,
        cause: error,
      });
    }

    // Generic
    return new ScrapeError('ENGINE_ERROR', error.message, {
      domain: context.domain,
      url: context.url,
      cause: error,
    });
  }

  // Non-Error throw
  return new ScrapeError('ENGINE_ERROR', String(error), {
    domain: context.domain,
    url: context.url,
  });
}

// ==================== Helpers ====================

/**
 * Compute exponential backoff with jitter.
 * Formula: min(baseMs * 2^retry + random(0, baseMs), maxMs)
 */
function computeExponentialBackoff(retryCount: number, baseMs: number, maxMs: number): number {
  const raw = baseMs * Math.pow(2, retryCount) + Math.floor(Math.random() * baseMs);
  return Math.min(raw, maxMs);
}
