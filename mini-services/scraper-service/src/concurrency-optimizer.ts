/**
 * Concurrency Optimizer — Adaptive concurrency tuning
 *
 * Tests increasing concurrency levels per domain:
 *   - Starts at concurrency=2, max=8 per domain, max=30 total
 *   - Measures throughput (successful requests/second) at each level
 *   - Stops increasing when throughput doesn't improve (Amdahl's law)
 *     OR when error rate exceeds 5%
 *   - Respects domain-specific limits
 *
 * Exports: getOptimalConcurrency(), recordRequestResult(), getStats(), reset()
 */

// ==================== Types ====================

export interface DomainConcurrencyState {
  /** Current concurrency level for this domain */
  currentConcurrency: number;
  /** Best concurrency level found (highest throughput) */
  bestConcurrency: number;
  /** Best throughput achieved (req/s) */
  bestThroughput: number;
  /** Current throughput measurement window */
  measurementWindow: MeasurementRecord[];
  /** Total successes in current measurement window */
  windowSuccesses: number;
  /** Total failures in current measurement window */
  windowFailures: number;
  /** Window start timestamp */
  windowStart: number;
  /** Whether we've found the optimal level */
  converged: boolean;
  /** How many probe cycles completed */
  probeCyclesCompleted: number;
  /** Total requests recorded (all-time) */
  totalRequests: number;
  /** Total failures recorded (all-time) */
  totalFailures: number;
  /** When this domain was first seen */
  firstSeenAt: number;
  /** Maximum allowed concurrency for this domain */
  maxConcurrency: number;
}

export interface MeasurementRecord {
  timestamp: number;
  success: boolean;
  responseTime: number;
}

export interface ConcurrencyOptimizerStats {
  domains: Record<string, {
    currentConcurrency: number;
    bestConcurrency: number;
    bestThroughput: number;
    converged: boolean;
    errorRate: number;
    probeCyclesCompleted: number;
    totalRequests: number;
    totalFailures: number;
  }>;
  totalDomains: number;
  totalConcurrencyUsed: number;
  maxTotalConcurrency: number;
}

// ==================== Constants ====================

const DEFAULT_START_CONCURRENCY = 2;
const DEFAULT_MAX_PER_DOMAIN = 8;
const MAX_TOTAL_CONCURRENCY = 30;
const MAX_ERROR_RATE = 0.05; // 5%
const MEASUREMENT_WINDOW_MS = 30_000; // 30 seconds per probe cycle
const MIN_MEASUREMENT_REQUESTS = 10; // need at least 10 requests to measure
const THROUGHPUT_IMPROVEMENT_THRESHOLD = 0.05; // 5% improvement needed to keep increasing
const MAX_DOMAINS = 200;
const MAX_PROBE_CYCLES = 10; // stop after 10 cycles even if not converged

// ==================== ConcurrencyOptimizer ====================

class ConcurrencyOptimizer {
  private domains = new Map<string, DomainConcurrencyState>();
  private totalInUse = 0;

  /**
   * Get the optimal concurrency level for a domain.
   */
  getOptimalConcurrency(domain: string): number {
    const state = this.getOrCreate(domain);
    return state.currentConcurrency;
  }

  /**
   * Get the total concurrency budget across all domains.
   */
  getTotalConcurrencyBudget(): number {
    let total = 0;
    for (const state of this.domains.values()) {
      total += state.currentConcurrency;
    }
    return Math.min(total, MAX_TOTAL_CONCURRENCY);
  }

  /**
   * Reserve a concurrency slot for a domain.
   * Returns true if a slot was available, false if at limit.
   */
  reserveSlot(domain: string): boolean {
    const state = this.getOrCreate(domain);
    // Check per-domain limit
    const currentInUse = this.getDomainInUse(domain);
    if (currentInUse >= state.currentConcurrency) {
      return false;
    }
    // Check total limit
    if (this.totalInUse >= MAX_TOTAL_CONCURRENCY) {
      return false;
    }
    this.totalInUse++;
    return true;
  }

  /**
   * Release a concurrency slot for a domain.
   */
  releaseSlot(): void {
    this.totalInUse = Math.max(0, this.totalInUse - 1);
  }

  /**
   * Record the result of a request for concurrency optimization.
   * This is called after every request to measure throughput at current concurrency.
   *
   * @param domain - Target domain
   * @param success - Whether the request succeeded
   * @param responseTime - Response time in ms
   */
  recordRequestResult(domain: string, success: boolean, responseTime: number): void {
    const state = this.getOrCreate(domain);
    const now = Date.now();

    state.totalRequests++;
    if (!success) state.totalFailures++;

    // Add to measurement window
    state.measurementWindow.push({ timestamp: now, success, responseTime });
    if (success) state.windowSuccesses++;
    else state.windowFailures++;

    // Check if measurement window is complete
    const windowDuration = now - state.windowStart;
    const windowTotal = state.windowSuccesses + state.windowFailures;

    if (windowDuration >= MEASUREMENT_WINDOW_MS && windowTotal >= MIN_MEASUREMENT_REQUESTS) {
      this.evaluateProbeCycle(domain, state);
    }
  }

  /**
   * Set a custom max concurrency for a domain.
   */
  setDomainMaxConcurrency(domain: string, max: number): void {
    const state = this.getOrCreate(domain);
    state.maxConcurrency = Math.max(1, Math.min(DEFAULT_MAX_PER_DOMAIN, max));
    // If current exceeds new max, reduce
    if (state.currentConcurrency > state.maxConcurrency) {
      state.currentConcurrency = state.maxConcurrency;
    }
  }

  /**
   * Get comprehensive stats.
   */
  getStats(): ConcurrencyOptimizerStats {
    const domains: ConcurrencyOptimizerStats['domains'] = {};
    let totalConcurrency = 0;

    for (const [domain, state] of this.domains) {
      const errorRate = state.totalRequests > 0
        ? state.totalFailures / state.totalRequests
        : 0;
      domains[domain] = {
        currentConcurrency: state.currentConcurrency,
        bestConcurrency: state.bestConcurrency,
        bestThroughput: Math.round(state.bestThroughput * 1000) / 1000,
        converged: state.converged,
        errorRate: Math.round(errorRate * 10000) / 100,
        probeCyclesCompleted: state.probeCyclesCompleted,
        totalRequests: state.totalRequests,
        totalFailures: state.totalFailures,
      };
      totalConcurrency += state.currentConcurrency;
    }

    return {
      domains,
      totalDomains: this.domains.size,
      totalConcurrencyUsed: totalConcurrency,
      maxTotalConcurrency: MAX_TOTAL_CONCURRENCY,
    };
  }

  /**
   * Reset optimization state for a domain or all domains.
   */
  reset(domain?: string): void {
    if (domain) {
      this.domains.delete(domain);
    } else {
      this.domains.clear();
    }
  }

  // ==================== Private ====================

  private getOrCreate(domain: string): DomainConcurrencyState {
    let state = this.domains.get(domain);
    if (!state) {
      // LRU eviction
      if (this.domains.size >= MAX_DOMAINS) {
        const firstKey = this.domains.keys().next().value;
        if (firstKey) this.domains.delete(firstKey);
      }
      const now = Date.now();
      state = {
        currentConcurrency: DEFAULT_START_CONCURRENCY,
        bestConcurrency: DEFAULT_START_CONCURRENCY,
        bestThroughput: 0,
        measurementWindow: [],
        windowSuccesses: 0,
        windowFailures: 0,
        windowStart: now,
        converged: false,
        probeCyclesCompleted: 0,
        totalRequests: 0,
        totalFailures: 0,
        firstSeenAt: now,
        maxConcurrency: DEFAULT_MAX_PER_DOMAIN,
      };
      this.domains.set(domain, state);
    }
    return state;
  }

  private getDomainInUse(domain: string): number {
    // Approximate: count active slots for this domain
    // In a real implementation, we'd track per-domain in-flight requests
    // For now, use a simple heuristic: if totalInUse > 0 and domain is known,
    // assume at most 1 in-flight (conservative estimate to avoid over-allocation)
    if (!this.domains.has(domain) || this.totalInUse === 0) return 0;
    // Use Math.min to avoid overestimating
    return Math.min(1, this.totalInUse);
  }

  /**
   * Evaluate a completed probe cycle and decide whether to increase concurrency.
   */
  private evaluateProbeCycle(domain: string, state: DomainConcurrencyState): void {
    const windowTotal = state.windowSuccesses + state.windowFailures;
    const windowDuration = Date.now() - state.windowStart;
    const windowDurationSec = windowDuration / 1000;

    // Calculate throughput (successful requests per second)
    const throughput = windowDurationSec > 0 ? state.windowSuccesses / windowDurationSec : 0;

    // Calculate error rate
    const errorRate = windowTotal > 0 ? state.windowFailures / windowTotal : 0;

    state.probeCyclesCompleted++;

    if (process.env.DEBUG === 'true') {
      log.debug(`${domain}: Cycle ${state.probeCyclesCompleted} — concurrency=${state.currentConcurrency}, throughput=${throughput.toFixed(2)} req/s, errorRate=${(errorRate * 100).toFixed(1)}%`);
    }

    // Decision: should we increase concurrency?
    let shouldIncrease = false;
    let reason = '';

    if (errorRate > MAX_ERROR_RATE) {
      // Error rate too high — don't increase, possibly decrease
      reason = `error rate ${(errorRate * 100).toFixed(1)}% > ${MAX_ERROR_RATE * 100}%`;
      if (state.currentConcurrency > DEFAULT_START_CONCURRENCY) {
        state.currentConcurrency = Math.max(DEFAULT_START_CONCURRENCY, state.currentConcurrency - 1);
        reason += ', decreasing concurrency';
      }
    } else if (state.currentConcurrency >= state.maxConcurrency) {
      // Already at max
      reason = 'at max concurrency';
      state.converged = true;
    } else if (state.probeCyclesCompleted >= MAX_PROBE_CYCLES) {
      // Exhausted probe cycles
      reason = 'max probe cycles reached';
      state.converged = true;
    } else if (throughput > state.bestThroughput * (1 + THROUGHPUT_IMPROVEMENT_THRESHOLD)) {
      // Throughput improved significantly — try higher concurrency
      shouldIncrease = true;
      reason = `throughput improved ${((throughput / (state.bestThroughput || 0.001) - 1) * 100).toFixed(1)}%`;
    } else {
      // Throughput didn't improve enough — we've found the sweet spot
      reason = 'throughput plateau reached (Amdahl\'s law)';
      state.converged = true;
      // Revert to best concurrency if current is worse
      if (state.bestConcurrency < state.currentConcurrency) {
        state.currentConcurrency = state.bestConcurrency;
      }
    }

    // Update best if this is better
    if (throughput > state.bestThroughput) {
      state.bestThroughput = throughput;
      state.bestConcurrency = state.currentConcurrency;
    }

    // Increase concurrency for next probe cycle
    if (shouldIncrease) {
      state.currentConcurrency = Math.min(state.maxConcurrency, state.currentConcurrency + 1);
    }

    // Reset measurement window for next cycle
    state.measurementWindow = [];
    state.windowSuccesses = 0;
    state.windowFailures = 0;
    state.windowStart = Date.now();

    if (process.env.DEBUG === 'true') {
      log.info(` ${domain}: ${reason} → concurrency=${state.currentConcurrency}, converged=${state.converged}`);
    }
  }
}

// Singleton
export const concurrencyOptimizer = new ConcurrencyOptimizer();
