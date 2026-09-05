/**
 * Production Rate Optimizer — Self-tuning rate controller
 *
 * Dynamically finds the optimal request rate per domain:
 *   - Starts conservatively (10 RPM) and gradually increases
 *   - Uses exponential probing (multiply rate by 1.2 each cycle)
 *   - Detects pushback: 429, 403, CAPTCHA signals
 *   - When blocked, backs off to 70% of last successful rate
 *   - Converges on a stable "sweet spot" per domain
 *   - Persists learned rates to JSON file for restart survival
 *
 * Exports: getOptimalRate(), recordResponse(), getStats(), reset()
 */

import { logger } from './logger';
const log = logger.child('RateOptimizer');

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// ==================== Types ====================

export interface DomainRateState {
  /** Current target requests-per-minute */
  currentRPM: number;
  /** Last known good RPM (before most recent block) */
  lastGoodRPM: number;
  /** Peak RPM ever achieved without blocks */
  peakRPM: number;
  /** Rolling window of recent response records */
  recentResponses: ResponseRecord[];
  /** Number of consecutive successes (resets on any error) */
  consecutiveSuccesses: number;
  /** Number of consecutive blocks (resets on any success) */
  consecutiveBlocks: number;
  /** Current probe phase: 'probing' (increasing), 'stable', 'backoff' */
  phase: 'probing' | 'stable' | 'backoff';
  /** Timestamp of last rate change */
  lastRateChangeAt: number;
  /** Total requests recorded (all-time) */
  totalRequests: number;
  /** Total blocks recorded (all-time) */
  totalBlocks: number;
  /** Average response time (ms) over recent window */
  avgResponseTime: number;
  /** When this domain was first seen */
  firstSeenAt: number;
}

export interface ResponseRecord {
  timestamp: number;
  statusCode: number;
  responseTime: number;
  wasBlock: boolean; // 429, 403, or CAPTCHA
}

export interface RateOptimizerStats {
  domains: Record<string, {
    currentRPM: number;
    peakRPM: number;
    phase: string;
    consecutiveSuccesses: number;
    consecutiveBlocks: number;
    avgResponseTime: number;
    totalRequests: number;
    totalBlocks: number;
    blockRate: number;
  }>;
  totalDomains: number;
  persistencePath: string;
}

// ==================== Constants ====================

const INITIAL_RPM = 10;
const PROBE_MULTIPLIER = 1.2;
const BACKOFF_FACTOR = 0.7;
const MIN_RPM = 2;
const MAX_RPM = 300;
const RESPONSE_WINDOW_SIZE = 50;
const STABLE_SUCCESS_THRESHOLD = 20; // successes before next probe
const BLOCK_SIGNAL_CODES = new Set([429, 403, 503]);
const PERSIST_INTERVAL_MS = 60_000; // persist every 1 minute
const MAX_DOMAINS = 500;

// ==================== Persistence ====================

const PERSIST_DIR = resolve(import.meta.dir ?? '.', '..');
const PERSIST_FILE = resolve(PERSIST_DIR, 'rate-optimizer-state.json');

interface PersistedState {
  domainRates: Record<string, { currentRPM: number; lastGoodRPM: number; peakRPM: number }>;
  version: number;
}

function loadPersistedState(): PersistedState | null {
  try {
    if (existsSync(PERSIST_FILE)) {
      const raw = readFileSync(PERSIST_FILE, 'utf-8');
      const data = JSON.parse(raw);
      if (data && data.version === 1 && data.domainRates) {
        return data as PersistedState;
      }
    }
  } catch {
    // Non-blocking: start fresh
  }
  return null;
}

function persistState(states: Map<string, DomainRateState>): void {
  try {
    const domainRates: Record<string, { currentRPM: number; lastGoodRPM: number; peakRPM: number }> = {};
    for (const [domain, state] of states) {
      domainRates[domain] = {
        currentRPM: Math.round(state.currentRPM * 100) / 100,
        lastGoodRPM: Math.round(state.lastGoodRPM * 100) / 100,
        peakRPM: Math.round(state.peakRPM * 100) / 100,
      };
    }
    writeFileSync(PERSIST_FILE, JSON.stringify({ domainRates, version: 1 }, null, 2));
  } catch (err) {
    // Non-blocking: persistence failure shouldn't affect operation
    if (process.env.DEBUG === 'true') {
      console.error('[RateOptimizer] Persist failed:', err);
    }
  }
}

// ==================== RateOptimizer ====================

class RateOptimizer {
  private domains = new Map<string, DomainRateState>();
  private persistTimer: ReturnType<typeof setInterval> | null = null;
  private initialized = false;

  constructor() {
    // Load persisted state
    const persisted = loadPersistedState();
    if (persisted) {
      for (const [domain, rates] of Object.entries(persisted.domainRates)) {
        this.domains.set(domain, this.createState(rates.currentRPM, rates.lastGoodRPM, rates.peakRPM));
      }
      log.info(` Loaded ${Object.keys(persisted.domainRates).length} domain rates from ${PERSIST_FILE}`);
    }

    // Periodic persistence
    this.persistTimer = setInterval(() => {
      try { persistState(this.domains); } catch {}
    }, PERSIST_INTERVAL_MS).unref();

    this.initialized = true;
  }

  /**
   * Get the optimal request rate (RPM) for a domain.
   * This is the rate the scheduler should aim for.
   */
  getOptimalRate(domain: string): number {
    const state = this.getOrCreate(domain);
    return state.currentRPM;
  }

  /**
   * Record a response for a domain. This is called after every request
   * to feed the optimizer real-world data.
   *
   * @param domain - Target domain
   * @param statusCode - HTTP status code
   * @param responseTime - Response time in ms
   * @param isCaptcha - Whether a CAPTCHA was detected in the response
   */
  recordResponse(domain: string, statusCode: number, responseTime: number, isCaptcha?: boolean): void {
    const state = this.getOrCreate(domain);
    const now = Date.now();

    const wasBlock = BLOCK_SIGNAL_CODES.has(statusCode) || !!isCaptcha;

    // Add to rolling window
    const record: ResponseRecord = { timestamp: now, statusCode, responseTime, wasBlock };
    state.recentResponses.push(record);
    if (state.recentResponses.length > RESPONSE_WINDOW_SIZE) {
      state.recentResponses.shift();
    }

    state.totalRequests++;

    // Compute avg response time
    const times = state.recentResponses.map(r => r.responseTime);
    state.avgResponseTime = times.length > 0
      ? Math.round(times.reduce((a, b) => a + b, 0) / times.length)
      : 0;

    if (wasBlock) {
      // ===== BLOCK DETECTED =====
      state.consecutiveSuccesses = 0;
      state.consecutiveBlocks++;
      state.totalBlocks++;

      // Back off to 70% of last good rate (or current if no last good)
      const baseRPM = state.lastGoodRPM > 0 ? state.lastGoodRPM : state.currentRPM;
      const newRPM = Math.max(MIN_RPM, baseRPM * BACKOFF_FACTOR);

      state.currentRPM = Math.round(newRPM * 100) / 100;
      state.phase = 'backoff';
      state.lastRateChangeAt = now;

      if (process.env.DEBUG === 'true') {
        log.info(` ${domain}: BLOCK (${statusCode}), backoff → ${state.currentRPM.toFixed(1)} RPM`);
      }
    } else {
      // ===== SUCCESS =====
      state.consecutiveBlocks = 0;
      state.consecutiveSuccesses++;

      // Track last good rate
      state.lastGoodRPM = state.currentRPM;

      // Track peak
      if (state.currentRPM > state.peakRPM) {
        state.peakRPM = state.currentRPM;
      }

      // Probing: increase rate if enough consecutive successes
      if (state.phase === 'probing' && state.consecutiveSuccesses >= STABLE_SUCCESS_THRESHOLD) {
        const newRPM = Math.min(MAX_RPM, state.currentRPM * PROBE_MULTIPLIER);
        state.currentRPM = Math.round(newRPM * 100) / 100;
        state.consecutiveSuccesses = 0; // Reset for next probe cycle
        state.lastRateChangeAt = now;

        if (process.env.DEBUG === 'true') {
          log.info(` ${domain}: Probe success, increase → ${state.currentRPM.toFixed(1)} RPM`);
        }
      }

      // If in backoff and we've had enough successes, resume probing
      if (state.phase === 'backoff' && state.consecutiveSuccesses >= 10) {
        state.phase = 'probing';
        state.lastRateChangeAt = now;

        if (process.env.DEBUG === 'true') {
          log.info(` ${domain}: Resumed probing at ${state.currentRPM.toFixed(1)} RPM`);
        }
      }

      // If stable and sustained success, start probing again
      if (state.phase === 'stable' && state.consecutiveSuccesses >= STABLE_SUCCESS_THRESHOLD * 2) {
        state.phase = 'probing';
        state.consecutiveSuccesses = 0;
        state.lastRateChangeAt = now;
      }
    }
  }

  /**
   * Get the delay (ms) between requests for a domain, derived from the optimal RPM.
   */
  getRequestDelay(domain: string): number {
    const rpm = this.getOptimalRate(domain);
    if (rpm <= 0) return 60000; // Safety: 1 min if rate is 0
    const delayMs = (60_000 / rpm);
    // Add ±15% jitter
    const jitter = 0.85 + Math.random() * 0.30;
    return Math.round(delayMs * jitter);
  }

  /**
   * Get comprehensive stats for all domains.
   */
  getStats(): RateOptimizerStats {
    const domains: RateOptimizerStats['domains'] = {};
    for (const [domain, state] of this.domains) {
      const blockRate = state.totalRequests > 0
        ? Math.round((state.totalBlocks / state.totalRequests) * 10000) / 100
        : 0;
      domains[domain] = {
        currentRPM: Math.round(state.currentRPM * 100) / 100,
        peakRPM: Math.round(state.peakRPM * 100) / 100,
        phase: state.phase,
        consecutiveSuccesses: state.consecutiveSuccesses,
        consecutiveBlocks: state.consecutiveBlocks,
        avgResponseTime: state.avgResponseTime,
        totalRequests: state.totalRequests,
        totalBlocks: state.totalBlocks,
        blockRate,
      };
    }
    return {
      domains,
      totalDomains: this.domains.size,
      persistencePath: PERSIST_FILE,
    };
  }

  /**
   * Reset learned rates for a specific domain or all domains.
   */
  reset(domain?: string): void {
    if (domain) {
      this.domains.delete(domain);
    } else {
      this.domains.clear();
    }
    // Persist the reset state
    persistState(this.domains);
  }

  /**
   * Get the delay between requests for the next probe cycle.
   * In probing mode, we send a burst of STABLE_SUCCESS_THRESHOLD requests
   * at the current rate, then increase.
   */
  getProbeProgress(domain: string): { successesNeeded: number; currentPhase: string } {
    const state = this.getOrCreate(domain);
    return {
      successesNeeded: Math.max(0, STABLE_SUCCESS_THRESHOLD - state.consecutiveSuccesses),
      currentPhase: state.phase,
    };
  }

  /**
   * Force set a rate for a domain (manual override).
   */
  setRate(domain: string, rpm: number): void {
    const state = this.getOrCreate(domain);
    state.currentRPM = Math.max(MIN_RPM, Math.min(MAX_RPM, rpm));
    state.lastGoodRPM = state.currentRPM;
    state.phase = 'stable';
    state.lastRateChangeAt = Date.now();
  }

  /** Stop periodic persistence */
  destroy(): void {
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }
    // Final persist
    persistState(this.domains);
  }

  // ==================== Private ====================

  private getOrCreate(domain: string): DomainRateState {
    let state = this.domains.get(domain);
    if (!state) {
      // LRU eviction
      if (this.domains.size >= MAX_DOMAINS) {
        const firstKey = this.domains.keys().next().value;
        if (firstKey) this.domains.delete(firstKey);
      }
      state = this.createState(INITIAL_RPM, INITIAL_RPM, INITIAL_RPM);
      this.domains.set(domain, state);
    }
    return state;
  }

  private createState(currentRPM: number, lastGoodRPM: number, peakRPM: number): DomainRateState {
    return {
      currentRPM,
      lastGoodRPM,
      peakRPM,
      recentResponses: [],
      consecutiveSuccesses: 0,
      consecutiveBlocks: 0,
      phase: 'probing',
      lastRateChangeAt: Date.now(),
      totalRequests: 0,
      totalBlocks: 0,
      avgResponseTime: 0,
      firstSeenAt: Date.now(),
    };
  }
}

// Singleton
export const rateOptimizer = new RateOptimizer();
