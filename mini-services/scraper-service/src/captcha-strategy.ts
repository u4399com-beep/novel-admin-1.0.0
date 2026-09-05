/**
 * CAPTCHA Auto-Handling Strategy Module
 *
 * Provides pluggable strategies for automatically responding to CAPTCHA detections.
 * Strategies are evaluated in order; the first applicable one is executed.
 * They may suggest engine upgrades, delays, or external service usage.
 *
 * Enhanced with CaptchaRecoveryManager for domain-level CAPTCHA recovery:
 *   - Pauses requests to CAPTCHA-blocked domains for 30-120s
 *   - Switches to stealthier engine for N requests
 *   - Auto-downgrades after successful recovery
 *   - Tracks CAPTCHA frequency per domain — permanent engine upgrade if >3/hour
 */

import type { CaptchaDetection } from './captcha-detector';
import { logger } from './logger';

const log = logger.child('CaptchaStrategy');

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

// ==================== CaptchaRecoveryManager ====================

interface DomainRecoveryState {
  /** Timestamp when domain was paused until */
  pausedUntil: number;
  /** Engine to use during recovery */
  recoveryEngine: string;
  /** Original engine before recovery */
  originalEngine: string;
  /** Number of successful requests on recovery engine */
  recoverySuccessCount: number;
  /** Number of requests needed on recovery engine before downgrading */
  recoveryTargetCount: number;
  /** Whether this domain has been permanently upgraded */
  permanentlyUpgraded: boolean;
  /** CAPTCHA timestamps for frequency tracking */
  captchaTimestamps: number[];
  /** Whether currently in recovery mode */
  inRecovery: boolean;
}

const RECOVERY_SUCCESS_TARGET = 5; // N successful requests before downgrade
const CAPTCHA_FREQUENCY_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const CAPTCHA_FREQUENCY_THRESHOLD = 3; // >3 per hour triggers permanent upgrade
const PAUSE_MIN_MS = 30_000; // 30s
const PAUSE_MAX_MS = 120_000; // 120s
const MAX_TRACKED_DOMAINS = 500;

export class CaptchaRecoveryManager {
  private domainStates: Map<string, DomainRecoveryState> = new Map();

  /**
   * Record a CAPTCHA detection for a domain and initiate recovery.
   * Returns the recommended pause duration and engine switch.
   */
  handleCaptchaDetected(domain: string, currentEngine: string): {
    pauseDurationMs: number;
    recoveryEngine: string;
    permanentUpgrade: boolean;
  } {
    const now = Date.now();
    let state = this.domainStates.get(domain);

    if (!state) {
      // Evict if at capacity
      if (this.domainStates.size >= MAX_TRACKED_DOMAINS) {
        this.evictOldest();
      }
      state = {
        pausedUntil: 0,
        recoveryEngine: 'obscura',
        originalEngine: currentEngine,
        recoverySuccessCount: 0,
        recoveryTargetCount: RECOVERY_SUCCESS_TARGET,
        permanentlyUpgraded: false,
        captchaTimestamps: [],
        inRecovery: false,
      };
      this.domainStates.set(domain, state);
    }

    // Record CAPTCHA timestamp
    state.captchaTimestamps.push(now);
    // Clean old timestamps outside the window
    const windowStart = now - CAPTCHA_FREQUENCY_WINDOW_MS;
    state.captchaTimestamps = state.captchaTimestamps.filter(t => t >= windowStart);

    // Check frequency — permanent upgrade if >3/hour
    const frequency = state.captchaTimestamps.length;
    if (frequency > CAPTCHA_FREQUENCY_THRESHOLD && !state.permanentlyUpgraded) {
      state.permanentlyUpgraded = true;
      state.recoveryEngine = this.getStealthiestEngine(currentEngine);
      state.originalEngine = currentEngine;
      log.warn(`Domain ${domain} exceeded CAPTCHA frequency threshold (${frequency}/hour), permanently upgrading to ${state.recoveryEngine}`, undefined, domain);
    }

    // Pause all requests for 30-120s
    const pauseDurationMs = PAUSE_MIN_MS + Math.floor(Math.random() * (PAUSE_MAX_MS - PAUSE_MIN_MS));
    state.pausedUntil = now + pauseDurationMs;

    // Enter recovery mode
    if (!state.permanentlyUpgraded) {
      state.inRecovery = true;
      state.recoveryEngine = this.getStealthierEngine(currentEngine);
      state.originalEngine = currentEngine;
      state.recoverySuccessCount = 0;
      state.recoveryTargetCount = RECOVERY_SUCCESS_TARGET;
    }

    log.info(`CAPTCHA recovery initiated for ${domain}: pause ${pauseDurationMs}ms, engine → ${state.recoveryEngine}`, {
      pauseMs: pauseDurationMs,
      recoveryEngine: state.recoveryEngine,
      permanent: state.permanentlyUpgraded,
    }, domain);

    return {
      pauseDurationMs,
      recoveryEngine: state.recoveryEngine,
      permanentUpgrade: state.permanentlyUpgraded,
    };
  }

  /**
   * Record a successful request for a domain in recovery mode.
   * May trigger auto-downgrade back to original engine.
   */
  recordSuccess(domain: string): {
    downgraded: boolean;
    newEngine?: string;
  } {
    const state = this.domainStates.get(domain);
    if (!state || !state.inRecovery || state.permanentlyUpgraded) {
      return { downgraded: false };
    }

    state.recoverySuccessCount++;

    if (state.recoverySuccessCount >= state.recoveryTargetCount) {
      // Enough successful requests — try downgrading
      state.inRecovery = false;
      const downgradedEngine = state.originalEngine;
      log.info(`CAPTCHA recovery complete for ${domain}: downgrading back to ${downgradedEngine} after ${state.recoverySuccessCount} successful requests`, undefined, domain);
      return { downgraded: true, newEngine: downgradedEngine };
    }

    log.debug(`CAPTCHA recovery progress for ${domain}: ${state.recoverySuccessCount}/${state.recoveryTargetCount} successful requests`, undefined, domain);
    return { downgraded: false };
  }

  /**
   * Check if a domain is currently paused due to CAPTCHA recovery.
   * Returns the remaining pause time in ms, or 0 if not paused.
   */
  isDomainPaused(domain: string): number {
    const state = this.domainStates.get(domain);
    if (!state) return 0;
    const remaining = state.pausedUntil - Date.now();
    return remaining > 0 ? remaining : 0;
  }

  /**
   * Get the recovery engine for a domain (if in recovery mode).
   */
  getRecoveryEngine(domain: string): string | undefined {
    const state = this.domainStates.get(domain);
    if (!state) return undefined;
    if (state.permanentlyUpgraded || state.inRecovery) {
      return state.recoveryEngine;
    }
    return undefined;
  }

  /**
   * Get recovery status for a domain (for monitoring).
   */
  getRecoveryStatus(domain: string): {
    inRecovery: boolean;
    permanentlyUpgraded: boolean;
    pausedMs: number;
    recoveryEngine: string;
    originalEngine: string;
    recoveryProgress: string;
    captchaFrequency: number;
  } {
    const state = this.domainStates.get(domain);
    if (!state) {
      return {
        inRecovery: false,
        permanentlyUpgraded: false,
        pausedMs: 0,
        recoveryEngine: '',
        originalEngine: '',
        recoveryProgress: '',
        captchaFrequency: 0,
      };
    }

    const now = Date.now();
    const windowStart = now - CAPTCHA_FREQUENCY_WINDOW_MS;
    const recentCaptchas = state.captchaTimestamps.filter(t => t >= windowStart).length;

    return {
      inRecovery: state.inRecovery,
      permanentlyUpgraded: state.permanentlyUpgraded,
      pausedMs: Math.max(0, state.pausedUntil - now),
      recoveryEngine: state.recoveryEngine,
      originalEngine: state.originalEngine,
      recoveryProgress: state.inRecovery
        ? `${state.recoverySuccessCount}/${state.recoveryTargetCount}`
        : 'idle',
      captchaFrequency: recentCaptchas,
    };
  }

  /**
   * Get all domain recovery states (for monitoring).
   */
  getAllRecoveryStates(): Map<string, DomainRecoveryState> {
    return this.domainStates;
  }

  // ---- Private helpers ----

  private getStealthierEngine(current: string): string {
    const upgradePath: Record<string, string> = {
      cheerio: 'playwright',
      playwright: 'obscura',
      firecrawl: 'obscura',
      agentql: 'obscura',
    };
    return upgradePath[current] || 'obscura';
  }

  private getStealthiestEngine(current: string): string {
    // For permanent upgrade, go to the most capable engine
    if (current === 'cloud-browser' || current === 'scrapling') return current;
    return 'obscura';
  }

  private evictOldest(): void {
    let oldestKey = '';
    let oldestTime = Infinity;
    for (const [key, state] of this.domainStates.entries()) {
      const lastActivity = state.captchaTimestamps.length > 0
        ? state.captchaTimestamps[state.captchaTimestamps.length - 1]
        : 0;
      if (lastActivity < oldestTime) {
        oldestTime = lastActivity;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      this.domainStates.delete(oldestKey);
    }
  }
}

// Singleton
export const captchaRecoveryManager = new CaptchaRecoveryManager();

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
    if (!context?.currentEngine) return false;
    if (EngineUpgradeStrategy.EXTERNAL_ENGINES.has(context.currentEngine)) return false;
    if (!EngineUpgradeStrategy.UPGRADE_PATH[context.currentEngine]) return false;
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
        log.warn(
          `GeeTest persists on ${context.currentEngine} for ${context.domain} (retry ${context.retryCount + 1}/3, confidence: ${_detection.confidence}).`,
          undefined,
          context.domain
        );
        return {
          resolved: false,
          action: 'delay-retry',
          delayMs: delay,
          message: `GeeTest persists on ${context.currentEngine} (retry ${context.retryCount + 1}/3): waiting ${delay / 1000}s`,
        };
      }
      // Max retries exceeded on stealth engines
      // Escalate to cloud-browser (if not already on it) before giving up
      if (context.currentEngine !== 'cloud-browser') {
        return {
          resolved: false,
          action: 'switch-engine',
          nextEngine: 'cloud-browser',
          delayMs: 5000,
          message: `GeeTest still blocking after 3+ retries on ${context.currentEngine} for ${context.domain}: escalating to cloud-browser`,
        };
      }
      // Already on cloud-browser and still failing — give up
      return {
        resolved: false,
        action: 'none',
        message: `GeeTest still blocking after 3+ retries on cloud-browser for ${context.domain}. Manual intervention required for GeeTest slider/click challenges.`,
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
 * Enhanced: Also integrates with CaptchaRecoveryManager for domain-level recovery.
 *
 * @param detection - The CAPTCHA detection result
 * @param context - Current scraping context (URL, engine, retry info)
 * @returns The strategy execution result
 */
export async function autoHandleCaptcha(
  detection: CaptchaDetection,
  context: StrategyContext
): Promise<StrategyResult> {
  // First, let CaptchaRecoveryManager handle domain-level recovery
  const recovery = captchaRecoveryManager.handleCaptchaDetected(context.domain, context.currentEngine);

  // If the recovery manager recommends a permanent upgrade, respect that
  if (recovery.permanentUpgrade) {
    return {
      resolved: false,
      action: 'switch-engine',
      nextEngine: recovery.recoveryEngine,
      delayMs: recovery.pauseDurationMs,
      message: `CAPTCHA frequency exceeded threshold for ${context.domain}: permanently upgrading to ${recovery.recoveryEngine}`,
    };
  }

  // Otherwise, use the strategy system
  for (const strategy of STRATEGIES) {
    if (strategy.canHandle(detection, context)) {
      log.debug(`Applying strategy '${strategy.name}' for ${detection.type} on ${context.domain}`, undefined, context.domain);
      try {
        const result = await strategy.execute(detection, context);
        // Add recovery pause to the delay
        if (recovery.pauseDurationMs > 0) {
          result.delayMs = (result.delayMs || 0) + recovery.pauseDurationMs;
        }
        return result;
      } catch (err) {
        log.error(`Strategy '${strategy.name}' threw an error, continuing to next strategy: ${err instanceof Error ? err.message : err}`, undefined, context.domain);
        continue;
      }
    }
  }

  // Fallback (should not reach here since DelayBackoffStrategy handles all)
  return {
    resolved: false,
    action: 'none',
    message: 'No applicable CAPTCHA handling strategy found',
  };
}
