/**
 * CAPTCHA Auto-Handling Strategy Module
 *
 * Provides pluggable strategies for automatically responding to CAPTCHA detections.
 * Strategies are evaluated in order; the first applicable one is executed.
 * They may suggest engine upgrades, delays, or external service usage.
 */

import type { CaptchaDetection } from './captcha-detector';

// ==================== Types ====================

export interface StrategyContext {
  url: string;
  domain: string;
  currentEngine: string;
  retryCount: number;
  /** @deprecated Use per-strategy retry limits; field kept for backward compat */
  maxRetries: number;
  antiCrawlConfig?: Record<string, unknown>;
}

export interface StrategyResult {
  resolved: boolean;
  action: string;
  nextEngine?: string;
  delayMs?: number;
  message: string;
}

export interface CaptchaStrategy {
  name: string;
  description: string;
  /** Check if this strategy applies to the given detection and context */
  canHandle(detection: CaptchaDetection, context?: StrategyContext): boolean;
  /** Execute the strategy, returns true if resolved */
  execute(detection: CaptchaDetection, context: StrategyContext): Promise<StrategyResult>;
}

// ==================== Strategy: Cloudflare ====================

class CloudflareStrategy implements CaptchaStrategy {
  readonly name = 'cloudflare';
  readonly description = 'Handle Cloudflare challenges by upgrading to stealth/external browsers';

  canHandle(detection: CaptchaDetection): boolean {
    return detection.type === 'cloudflare';
  }

  /** Engines that are already at max stealth tier — no engine switching from these */
  private static readonly STEALTH_ENGINES = new Set(['obscura', 'cloud-browser', 'scrapling']);

  async execute(_detection: CaptchaDetection, context: StrategyContext): Promise<StrategyResult> {
    // Already on a stealth/external engine — just delay-retry
    if (CloudflareStrategy.STEALTH_ENGINES.has(context.currentEngine)) {
      if (context.retryCount < 3) {
        const delay = 8000 + Math.floor(Math.random() * 12000); // 8-20s
        return {
          resolved: false,
          action: 'delay-retry',
          delayMs: delay,
          message: `Cloudflare persists on ${context.currentEngine} (retry ${context.retryCount + 1}/3): waiting ${delay / 1000}s`,
        };
      }
      // Already on cloud-browser and still failing — give up
      if (context.currentEngine === 'cloud-browser') {
        return {
          resolved: false,
          action: 'none',
          message: `Cloudflare still blocking after 3+ retries on cloud-browser for ${context.domain}. Manual intervention required.`,
        };
      }
      // Escalate to cloud-browser from other stealth engines
      return {
        resolved: false,
        action: 'switch-engine',
        nextEngine: 'cloud-browser',
        delayMs: 5000,
        message: `Cloudflare still blocking after 3+ retries on ${context.currentEngine}: escalating to cloud-browser`,
      };
    }

    // First attempt: switch to obscura (stealth browser)
    return {
      resolved: false,
      action: 'switch-engine',
      nextEngine: 'obscura',
      delayMs: 3000,
      message: 'Cloudflare detected: switching to obscura stealth engine',
    };
  }
}

// ==================== Strategy: Engine Upgrade ====================

class EngineUpgradeStrategy implements CaptchaStrategy {
  readonly name = 'engine-upgrade';
  readonly description = 'Automatically upgrade engine tier when CAPTCHA is detected';

  /** Upgrade path: cheerio → playwright → obscura */
  private static readonly UPGRADE_PATH: Record<string, string> = {
    cheerio: 'playwright',
    playwright: 'obscura',
  };

  /** Engines that are already external / max tier — no auto-upgrade */
  private static readonly EXTERNAL_ENGINES = new Set([
    'firecrawl', 'agentql', 'cloud-browser', 'scrapling', 'obscura',
  ]);

  canHandle(_detection: CaptchaDetection, context?: StrategyContext): boolean {
    // Only handle if current engine has a valid upgrade path
    // This allows DelayBackoffStrategy (which provides escalating delays)
    // to handle external/stealth engines that can't be upgraded further.
    if (context?.currentEngine && EngineUpgradeStrategy.EXTERNAL_ENGINES.has(context.currentEngine)) {
      return false; // No upgrade path — let DelayBackoffStrategy handle with backoff
    }
    return true;
  }

  async execute(_detection: CaptchaDetection, context: StrategyContext): Promise<StrategyResult> {
    // External engines: should not reach here (canHandle returns false), but guard anyway
    if (EngineUpgradeStrategy.EXTERNAL_ENGINES.has(context.currentEngine)) {
      return {
        resolved: false,
        action: 'none',
        message: `Current engine '${context.currentEngine}' is external/stealth tier, no auto-upgrade available`,
      };
    }

    const nextEngine = EngineUpgradeStrategy.UPGRADE_PATH[context.currentEngine];
    if (!nextEngine) {
      return {
        resolved: false,
        action: 'none',
        message: `No upgrade path for engine '${context.currentEngine}'`,
      };
    }

    return {
      resolved: false,
      action: 'switch-engine',
      nextEngine,
      delayMs: 2000,
      message: `CAPTCHA detected: upgrading engine '${context.currentEngine}' → '${nextEngine}'`,
    };
  }
}

// ==================== Strategy: Delay Backoff ====================

class DelayBackoffStrategy implements CaptchaStrategy {
  readonly name = 'delay-backoff';
  readonly description = 'Exponential backoff delay with engine switch suggestion after repeated failures';

  canHandle(_detection: CaptchaDetection): boolean {
    return true; // Applies to any CAPTCHA
  }

  async execute(_detection: CaptchaDetection, context: StrategyContext): Promise<StrategyResult> {
    // Calculate delay: 5s * 2^retry, capped at 120s
    const rawDelay = 5000 * Math.pow(2, context.retryCount);
    const delayMs = Math.min(120_000, rawDelay);

    const result: StrategyResult = {
      resolved: false,
      action: 'delay-retry',
      delayMs,
      message: `Backoff delay: ${delayMs / 1000}s (retry ${context.retryCount + 1})`,
    };

    // Suggest engine switch if same engine failed 3+ times
    if (context.retryCount >= 3) {
      result.message += ` — same engine failed ${context.retryCount + 1} times, consider switching engine`;
    }

    return result;
  }
}

// ==================== Strategy: GeeTest ====================

class GeetestStrategy implements CaptchaStrategy {
  readonly name = 'geetest';
  readonly description = 'Handle GeeTest CAPTCHA with stealth engine and longer delays';

  canHandle(detection: CaptchaDetection): boolean {
    return detection.type === 'geetest';
  }

  /** Engines that are already at max stealth tier */
  private static readonly STEALTH_ENGINES = new Set(['obscura', 'cloud-browser', 'scrapling']);

  async execute(_detection: CaptchaDetection, context: StrategyContext): Promise<StrategyResult> {
    // Already on a stealth/external engine
    if (GeetestStrategy.STEALTH_ENGINES.has(context.currentEngine)) {
      // Cap retries to prevent infinite delay-retry loops
      if (context.retryCount < 3) {
        const delay = 10000 + Math.floor(Math.random() * 20000); // 10-30s
        console.warn(
          `[CaptchaStrategy] GeeTest persists on ${context.currentEngine} for ${context.domain} (retry ${context.retryCount + 1}/3, confidence: ${_detection.confidence}).`
        );
        return {
          resolved: false,
          action: 'delay-retry',
          delayMs: delay,
          message: `GeeTest persists on ${context.currentEngine} (retry ${context.retryCount + 1}/3): waiting ${delay / 1000}s`,
        };
      }
      // Max retries exceeded on stealth engines — give up
      return {
        resolved: false,
        action: 'none',
        message: `GeeTest still blocking after 3+ retries on ${context.currentEngine} for ${context.domain}. Manual intervention required for GeeTest slider/click challenges.`,
      };
    }

    // Suggest obscura engine (best anti-detection)
    return {
      resolved: false,
      action: 'switch-engine',
      nextEngine: 'obscura',
      delayMs: 5000,
      message: 'GeeTest detected: switching to obscura stealth engine (best anti-detection)',
    };
  }
}

// ==================== Strategy Registry ====================

/** Ordered list of strategies — evaluated in sequence, first match wins */
const STRATEGIES: CaptchaStrategy[] = [
  new CloudflareStrategy(),
  new GeetestStrategy(),
  new EngineUpgradeStrategy(),
  new DelayBackoffStrategy(),
];

/** Get all registered CAPTCHA handling strategies */
export function getCaptchaStrategies(): CaptchaStrategy[] {
  return STRATEGIES;
}

/**
 * Automatically handle a CAPTCHA detection by finding the best matching strategy.
 * Iterates through all strategies in order; the first one whose `canHandle()` returns
 * true will be executed and its result returned.
 *
 * @param detection - The CAPTCHA detection result
 * @param context - Current scraping context (URL, engine, retry info)
 * @returns The strategy execution result
 */
export async function autoHandleCaptcha(
  detection: CaptchaDetection,
  context: StrategyContext
): Promise<StrategyResult> {
  for (const strategy of STRATEGIES) {
    if (strategy.canHandle(detection, context)) {
      if (process.env.DEBUG === 'true') {
        console.log(`[CaptchaStrategy] Applying strategy '${strategy.name}' for ${detection.type} on ${context.domain}`);
      }
      return strategy.execute(detection, context);
    }
  }

  // Fallback (should not reach here since DelayBackoffStrategy handles all)
  return {
    resolved: false,
    action: 'none',
    message: 'No applicable CAPTCHA handling strategy found',
  };
}
