/**
 * Smart Retry Strategy
 *
 * Tracks per-domain retry history and applies escalating recovery actions:
 *   Attempt 1: Retry with same engine + increased delay
 *   Attempt 2: Try next engine in fallback chain
 *   Attempt 3: Try different proxy + obscura engine
 *   Attempt 4: Pause domain for 10 minutes ("needs manual intervention")
 *
 * Never retries more than 4 times total. Records all attempts for debugging.
 * Persists retry history to bypass-registry.json.
 */

import type { EngineType } from './types';
import { getFallbackChainForEngine } from './engines';
import { logger } from './logger';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const log = logger.child('SmartRetry');

// ==================== Types ====================

export interface RetryAttempt {
  attemptNumber: number;
  timestamp: number;
  url: string;
  error: string;
  engineUsed: EngineType;
  proxyUsed?: string;
  recoveryAction: RecoveryAction;
  /** Delay applied before this attempt (ms) */
  delayMs: number;
  /** Whether this attempt succeeded */
  succeeded?: boolean;
}

export type RecoveryAction =
  | 'same-engine-increased-delay'
  | 'next-fallback-engine'
  | 'proxy-rotate-obscura'
  | 'pause-domain';

export interface DomainRetryState {
  domain: string;
  /** Current consecutive failure count */
  consecutiveFailures: number;
  /** Total retry attempts for this domain */
  totalAttempts: number;
  /** Total successful recoveries */
  totalRecoveries: number;
  /** Most recent retry attempts (rolling window) */
  recentAttempts: RetryAttempt[];
  /** Domain pause state */
  isPaused: boolean;
  /** Pause expires at (timestamp ms) */
  pauseExpiresAt: number;
  /** What errors have occurred (for pattern analysis) */
  errorHistory: Array<{ error: string; timestamp: number }>;
  /** What recovery actions have worked */
  successfulRecoveries: Array<{ action: RecoveryAction; timestamp: number }>;
  /** Current delay multiplier (increases with failures) */
  delayMultiplier: number;
}

export interface RetryDecision {
  shouldRetry: boolean;
  recoveryAction: RecoveryAction;
  engine: EngineType;
  delayMs: number;
  proxyOverride?: string;
  pauseDomain?: boolean;
  pauseDurationMs?: number;
  reason: string;
}

export interface SmartRetryStats {
  domains: Record<string, {
    consecutiveFailures: number;
    totalAttempts: number;
    totalRecoveries: number;
    isPaused: boolean;
    pauseExpiresAt: number;
    delayMultiplier: number;
  }>;
  totalDomains: number;
}

// ==================== Constants ====================

const MAX_RETRIES = 4;
const DOMAIN_PAUSE_MS = 10 * 60 * 1000; // 10 minutes
const BASE_DELAY_MS = 2000;
const DELAY_MULTIPLIER_STEP = 2; // Double delay on each failure
const MAX_DELAY_MULTIPLIER = 16;
const RECENT_ATTEMPTS_WINDOW = 20;
const MAX_ERROR_HISTORY = 50;
const MAX_DOMAINS = 500;
const PERSIST_INTERVAL_MS = 60_000;
const MAX_RECENT_ATTEMPTS = 10;

// ==================== Persistence ====================

const PERSIST_DIR = resolve(import.meta.dir ?? '.', '..');
const PERSIST_FILE = resolve(PERSIST_DIR, 'retry-history.json');

interface PersistedRetryData {
  domains: Record<string, {
    consecutiveFailures: number;
    totalAttempts: number;
    totalRecoveries: number;
    isPaused: boolean;
    pauseExpiresAt: number;
    delayMultiplier: number;
  }>;
  version: number;
}

function loadPersistedData(): PersistedRetryData | null {
  try {
    if (existsSync(PERSIST_FILE)) {
      const raw = readFileSync(PERSIST_FILE, 'utf-8');
      const data = JSON.parse(raw);
      if (data && data.version === 1 && data.domains) {
        return data as PersistedRetryData;
      }
    }
  } catch {
    // Start fresh
  }
  return null;
}

function persistData(states: Map<string, DomainRetryState>): void {
  try {
    const domains: PersistedRetryData['domains'] = {};
    for (const [domain, state] of states) {
      domains[domain] = {
        consecutiveFailures: state.consecutiveFailures,
        totalAttempts: state.totalAttempts,
        totalRecoveries: state.totalRecoveries,
        isPaused: state.isPaused,
        pauseExpiresAt: state.pauseExpiresAt,
        delayMultiplier: state.delayMultiplier,
      };
    }
    writeFileSync(PERSIST_FILE, JSON.stringify({ domains, version: 1 }, null, 2));
  } catch {
    // Non-blocking
  }
}

// ==================== SmartRetryStrategy ====================

class SmartRetryStrategy {
  private domains = new Map<string, DomainRetryState>();
  private persistTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Load persisted state
    const persisted = loadPersistedData();
    if (persisted) {
      const now = Date.now();
      for (const [domain, data] of Object.entries(persisted.domains)) {
        // Clear expired pauses on load
        const isStillPaused = data.isPaused && data.pauseExpiresAt > now;
        this.domains.set(domain, {
          domain,
          consecutiveFailures: data.consecutiveFailures,
          totalAttempts: data.totalAttempts,
          totalRecoveries: data.totalRecoveries,
          recentAttempts: [],
          isPaused: isStillPaused,
          pauseExpiresAt: isStillPaused ? data.pauseExpiresAt : 0,
          errorHistory: [],
          successfulRecoveries: [],
          delayMultiplier: data.delayMultiplier,
        });
      }
      log.info(`Loaded ${Object.keys(persisted.domains).length} domain retry states`);
    }

    // Periodic persistence
    this.persistTimer = setInterval(() => {
      try { persistData(this.domains); } catch {}
    }, PERSIST_INTERVAL_MS).unref();
  }

  /**
   * Determine the retry strategy for a failed request.
   * Returns a RetryDecision describing what to do next.
   */
  decideRetry(
    domain: string,
    url: string,
    error: string,
    currentEngine: EngineType,
    currentProxy?: string,
  ): RetryDecision {
    const state = this.getOrCreate(domain);
    const attemptNumber = state.consecutiveFailures + 1;

    // Check if domain is currently paused
    if (state.isPaused) {
      const now = Date.now();
      if (now < state.pauseExpiresAt) {
        return {
          shouldRetry: false,
          recoveryAction: 'pause-domain',
          engine: currentEngine,
          delayMs: 0,
          reason: `Domain paused until ${new Date(state.pauseExpiresAt).toISOString()} (${Math.round((state.pauseExpiresAt - now) / 1000)}s remaining)`,
        };
      }
      // Pause expired, auto-resume
      state.isPaused = false;
      state.pauseExpiresAt = 0;
      log.info(`Domain ${domain} auto-resumed after pause expired`);
    }

    // Never exceed max retries
    if (attemptNumber > MAX_RETRIES) {
      return {
        shouldRetry: false,
        recoveryAction: 'pause-domain',
        engine: currentEngine,
        delayMs: 0,
        reason: `Max retries (${MAX_RETRIES}) exceeded for domain ${domain}`,
      };
    }

    // Record the error
    state.errorHistory.push({ error: error.slice(0, 200), timestamp: Date.now() });
    if (state.errorHistory.length > MAX_ERROR_HISTORY) {
      state.errorHistory.shift();
    }

    // Strategy based on attempt number
    switch (attemptNumber) {
      case 1: {
        // Attempt 1: Same engine + increased delay
        const delayMs = BASE_DELAY_MS * state.delayMultiplier;
        return {
          shouldRetry: true,
          recoveryAction: 'same-engine-increased-delay',
          engine: currentEngine,
          delayMs,
          reason: `Attempt 1/4: Retry with ${currentEngine} + ${delayMs}ms delay (x${state.delayMultiplier})`,
        };
      }

      case 2: {
        // Attempt 2: Next engine in fallback chain
        const fallbackChain = getFallbackChainForEngine(currentEngine);
        const nextEngine = fallbackChain.length > 1
          ? (fallbackChain[1] as EngineType)
          : 'playwright' as EngineType;

        const delayMs = BASE_DELAY_MS * state.delayMultiplier;
        return {
          shouldRetry: true,
          recoveryAction: 'next-fallback-engine',
          engine: nextEngine,
          delayMs,
          reason: `Attempt 2/4: Switch engine ${currentEngine} → ${nextEngine} + ${delayMs}ms delay`,
        };
      }

      case 3: {
        // Attempt 3: Different proxy + obscura engine
        const delayMs = BASE_DELAY_MS * state.delayMultiplier;
        return {
          shouldRetry: true,
          recoveryAction: 'proxy-rotate-obscura',
          engine: 'obscura' as EngineType,
          delayMs,
          proxyOverride: 'rotate', // Signal to proxy manager to pick a different proxy
          reason: `Attempt 3/4: Proxy rotate + obscura engine + ${delayMs}ms delay`,
        };
      }

      case 4: {
        // Attempt 4: Pause domain for 10 minutes
        return {
          shouldRetry: false,
          recoveryAction: 'pause-domain',
          engine: currentEngine,
          delayMs: 0,
          pauseDomain: true,
          pauseDurationMs: DOMAIN_PAUSE_MS,
          reason: `Attempt 4/4: Domain ${domain} paused for ${DOMAIN_PAUSE_MS / 1000 / 60} minutes — needs manual intervention`,
        };
      }

      default: {
        return {
          shouldRetry: false,
          recoveryAction: 'pause-domain',
          engine: currentEngine,
          delayMs: 0,
          reason: `Exceeded max retries (${MAX_RETRIES})`,
        };
      }
    }
  }

  /**
   * Record that a retry attempt was made.
   */
  recordAttempt(
    domain: string,
    attempt: Omit<RetryAttempt, 'attemptNumber'>,
  ): void {
    const state = this.getOrCreate(domain);
    const attemptRecord: RetryAttempt = {
      ...attempt,
      attemptNumber: state.consecutiveFailures + 1,
    };

    state.recentAttempts.push(attemptRecord);
    if (state.recentAttempts.length > RECENT_ATTEMPTS_WINDOW) {
      state.recentAttempts.shift();
    }
    state.totalAttempts++;
  }

  /**
   * Record a failure — increments consecutive failure count and escalates delay.
   */
  recordFailure(domain: string, url: string, error: string, engine: EngineType, proxy?: string): void {
    const state = this.getOrCreate(domain);
    state.consecutiveFailures++;

    // Escalate delay multiplier
    state.delayMultiplier = Math.min(
      state.delayMultiplier * DELAY_MULTIPLIER_STEP,
      MAX_DELAY_MULTIPLIER,
    );

    // Record attempt
    this.recordAttempt(domain, {
      timestamp: Date.now(),
      url,
      error: error.slice(0, 200),
      engineUsed: engine,
      proxyUsed: proxy,
      recoveryAction: this.actionForAttempt(state.consecutiveFailures),
      delayMs: BASE_DELAY_MS * state.delayMultiplier,
    });

    // If this was the 4th failure, pause the domain
    if (state.consecutiveFailures >= MAX_RETRIES) {
      state.isPaused = true;
      state.pauseExpiresAt = Date.now() + DOMAIN_PAUSE_MS;
      log.warn(`Domain ${domain} paused for ${DOMAIN_PAUSE_MS / 1000 / 60} minutes after ${state.consecutiveFailures} consecutive failures — needs manual intervention`);
    }

    log.info(`Domain ${domain}: failure ${state.consecutiveFailures}/${MAX_RETRIES}, delay x${state.delayMultiplier}`);
  }

  /**
   * Record a success — resets consecutive failures and records the recovery.
   */
  recordSuccess(domain: string): void {
    const state = this.getOrCreate(domain);
    const hadFailures = state.consecutiveFailures > 0;

    if (hadFailures) {
      // Record what recovery action worked
      const lastAttempt = state.recentAttempts[state.recentAttempts.length - 1];
      if (lastAttempt) {
        state.successfulRecoveries.push({
          action: lastAttempt.recoveryAction,
          timestamp: Date.now(),
        });
        state.totalRecoveries++;
        log.info(`Domain ${domain}: recovered using ${lastAttempt.recoveryAction}`);
      }

      // Mark last attempt as succeeded
      if (lastAttempt) {
        lastAttempt.succeeded = true;
      }
    }

    state.consecutiveFailures = 0;
    state.delayMultiplier = 1; // Reset delay
    state.isPaused = false;
    state.pauseExpiresAt = 0;
  }

  /**
   * Manually pause a domain.
   */
  pauseDomain(domain: string, durationMs?: number): void {
    const state = this.getOrCreate(domain);
    const dur = durationMs ?? DOMAIN_PAUSE_MS;
    state.isPaused = true;
    state.pauseExpiresAt = Date.now() + dur;
    log.info(`Domain ${domain} manually paused for ${dur / 1000}s`);
  }

  /**
   * Manually resume a domain.
   */
  resumeDomain(domain: string): void {
    const state = this.getOrCreate(domain);
    state.isPaused = false;
    state.pauseExpiresAt = 0;
    state.consecutiveFailures = 0;
    state.delayMultiplier = 1;
    log.info(`Domain ${domain} manually resumed`);
  }

  /**
   * Check if a domain is currently paused.
   */
  isDomainPaused(domain: string): boolean {
    const state = this.domains.get(domain);
    if (!state) return false;
    if (state.isPaused && Date.now() >= state.pauseExpiresAt) {
      state.isPaused = false;
      state.pauseExpiresAt = 0;
      return false;
    }
    return state.isPaused;
  }

  /**
   * Get the current delay multiplier for a domain.
   */
  getDelayMultiplier(domain: string): number {
    const state = this.domains.get(domain);
    return state?.delayMultiplier ?? 1;
  }

  /**
   * Get the current consecutive failure count for a domain.
   */
  getConsecutiveFailures(domain: string): number {
    const state = this.domains.get(domain);
    return state?.consecutiveFailures ?? 0;
  }

  /**
   * Get recent retry attempts for a domain (for debugging).
   */
  getRecentAttempts(domain: string): RetryAttempt[] {
    const state = this.domains.get(domain);
    if (!state) return [];
    // Return last N attempts
    return state.recentAttempts.slice(-MAX_RECENT_ATTEMPTS);
  }

  /**
   * Get what recovery actions have historically worked for a domain.
   */
  getSuccessfulRecoveries(domain: string): Array<{ action: RecoveryAction; timestamp: number }> {
    const state = this.domains.get(domain);
    return state?.successfulRecoveries ?? [];
  }

  /**
   * Get comprehensive stats.
   */
  getStats(): SmartRetryStats {
    const domains: SmartRetryStats['domains'] = {};
    for (const [domain, state] of this.domains) {
      domains[domain] = {
        consecutiveFailures: state.consecutiveFailures,
        totalAttempts: state.totalAttempts,
        totalRecoveries: state.totalRecoveries,
        isPaused: state.isPaused && Date.now() < state.pauseExpiresAt,
        pauseExpiresAt: state.pauseExpiresAt,
        delayMultiplier: state.delayMultiplier,
      };
    }
    return { domains, totalDomains: this.domains.size };
  }

  /** Stop and persist */
  destroy(): void {
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }
    persistData(this.domains);
  }

  // ==================== Private ====================

  private getOrCreate(domain: string): DomainRetryState {
    let state = this.domains.get(domain);
    if (!state) {
      // LRU eviction
      if (this.domains.size >= MAX_DOMAINS) {
        const firstKey = this.domains.keys().next().value;
        if (firstKey) this.domains.delete(firstKey);
      }
      state = {
        domain,
        consecutiveFailures: 0,
        totalAttempts: 0,
        totalRecoveries: 0,
        recentAttempts: [],
        isPaused: false,
        pauseExpiresAt: 0,
        errorHistory: [],
        successfulRecoveries: [],
        delayMultiplier: 1,
      };
      this.domains.set(domain, state);
    }
    return state;
  }

  private actionForAttempt(attemptNumber: number): RecoveryAction {
    switch (attemptNumber) {
      case 1: return 'same-engine-increased-delay';
      case 2: return 'next-fallback-engine';
      case 3: return 'proxy-rotate-obscura';
      default: return 'pause-domain';
    }
  }
}

// Singleton
export const smartRetry = new SmartRetryStrategy();
