/**
 * Per-Domain Rate Limiter
 *
 * Enforces max N requests/minute to target domains using a
 * sliding window counter with adaptive penalty/recovery.
 */

// ==================== Types ====================

export interface RateLimitConfig {
  defaultMaxRPM: number;     // default 30 requests per minute
  defaultBurst: number;      // default 5 burst allowance
  penaltyMultiplier: number; // default 0.5 (reduce RPM by 50% on anti-crawl detection)
  recoveryRate: number;      // default 1 RPM recovery per minute on success
}

export interface DomainRateState {
  domain: string;
  maxRPM: number;
  currentRPM: number;        // actual requests in current window
  burstRemaining: number;
  penaltyActive: boolean;
  penaltyUntil: number;      // timestamp
  lastRequestTime: number;
  status: 'normal' | 'throttled' | 'penalized' | 'cooldown';
  estimatedWaitMs: number;   // ms until next request is allowed
}

interface DomainState {
  maxRPM: number;
  windowStart: number;       // window start timestamp (ms)
  requestTimestamps: number[];
  burstRemaining: number;
  penaltyActive: boolean;
  penaltyUntil: number;      // timestamp (ms)
  lastRequestTime: number;
  consecutiveSuccesses: number;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  defaultMaxRPM: 30,
  defaultBurst: 5,
  penaltyMultiplier: 0.5,
  recoveryRate: 1,
};

const WINDOW_MS = 60_000; // 1 minute sliding window
const PENALTY_DURATION_MS = 5 * 60_000; // 5 minutes
const MAX_TIMESTAMPS_PER_DOMAIN = 200;

// ==================== DomainRateLimiter ====================

class DomainRateLimiter {
  private domains = new Map<string, DomainState>();
  private config: RateLimitConfig;
  private static instance: DomainRateLimiter;

  private constructor(config?: Partial<RateLimitConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  static getInstance(config?: Partial<RateLimitConfig>): DomainRateLimiter {
    if (!DomainRateLimiter.instance) {
      DomainRateLimiter.instance = new DomainRateLimiter(config);
    }
    return DomainRateLimiter.instance;
  }

  /**
   * Check if a request is allowed for the given domain.
   * Returns { allowed, waitMs }.
   */
  acquire(domain: string, maxRPM?: number): { allowed: boolean; waitMs: number } {
    const state = this.getOrCreateDomain(domain);
    const now = Date.now();

    // Allow manual override
    if (maxRPM !== undefined && maxRPM !== state.maxRPM) {
      state.maxRPM = maxRPM;
    }

    // Check if penalty has expired
    if (state.penaltyActive && now >= state.penaltyUntil) {
      state.penaltyActive = false;
      state.penaltyUntil = 0;
      // Gradual recovery: start at penalized RPM
      // (recovery happens via recordResult on success)
    }

    // Slide the window: remove timestamps older than 1 minute
    const windowStart = now - WINDOW_MS;
    state.requestTimestamps = state.requestTimestamps.filter(t => t > windowStart);
    state.windowStart = windowStart;

    const currentCount = state.requestTimestamps.length;
    const effectiveMaxRPM = state.penaltyActive
      ? Math.max(1, Math.floor(state.maxRPM * this.config.penaltyMultiplier))
      : state.maxRPM;

    if (currentCount >= effectiveMaxRPM) {
      // Calculate wait time until the oldest timestamp exits the window
      const oldestInWindow = state.requestTimestamps[0];
      const waitMs = oldestInWindow + WINDOW_MS - now + 1;
      return { allowed: false, waitMs: Math.max(1, waitMs) };
    }

    // Check burst allowance (only when penalty is not active)
    if (!state.penaltyActive && state.burstRemaining <= 0 && currentCount >= effectiveMaxRPM) {
      const oldestInWindow = state.requestTimestamps[0];
      const waitMs = oldestInWindow + WINDOW_MS - now + 1;
      return { allowed: false, waitMs: Math.max(1, waitMs) };
    }

    // Allowed - record the request timestamp
    state.requestTimestamps.push(now);
    state.lastRequestTime = now;
    if (!state.penaltyActive && state.burstRemaining > 0) {
      // Burst doesn't count against normal RPM until burst is exhausted
      // Actually, burst is extra capacity on top of RPM limit
    }

    // Trim to prevent unbounded growth
    if (state.requestTimestamps.length > MAX_TIMESTAMPS_PER_DOMAIN) {
      state.requestTimestamps = state.requestTimestamps.slice(-MAX_TIMESTAMPS_PER_DOMAIN);
    }

    return { allowed: true, waitMs: 0 };
  }

  /**
   * Record the result of a request for adaptive adjustment.
   * When anti-crawl detected (429/403/503), activate penalty.
   * On success after penalty expires, gradually recover RPM.
   */
  recordResult(domain: string, success: boolean, statusCode?: number): void {
    const state = this.getOrCreateDomain(domain);

    if (!success || (statusCode && (statusCode === 429 || statusCode === 403 || statusCode === 503))) {
      // Anti-crawl detected - activate penalty
      if (statusCode === 429 || statusCode === 403 || statusCode === 503) {
        state.penaltyActive = true;
        state.penaltyUntil = Date.now() + PENALTY_DURATION_MS;
        state.consecutiveSuccesses = 0;
        // Halve the maxRPM
        state.maxRPM = Math.max(1, Math.floor(state.maxRPM * this.config.penaltyMultiplier));
      }
    } else if (success) {
      state.consecutiveSuccesses++;

      // Gradual recovery after penalty expires
      if (!state.penaltyActive) {
        // Can we recover? Only if below the default max
        if (state.maxRPM < this.config.defaultMaxRPM) {
          // +1 RPM per successful request after penalty, capped at defaultMaxRPM
          if (state.consecutiveSuccesses % Math.max(1, Math.floor(60 / Math.max(1, state.maxRPM))) === 0) {
            state.maxRPM = Math.min(state.maxRPM + this.config.recoveryRate, this.config.defaultMaxRPM);
          }
        }
      }

      // Replenish burst gradually (1 per 10 successful requests)
      if (state.burstRemaining < this.config.defaultBurst && state.consecutiveSuccesses % 10 === 0) {
        state.burstRemaining = Math.min(state.burstRemaining + 1, this.config.defaultBurst);
      }
    }
  }

  /** Get current rate limit state for a domain */
  getDomainState(domain: string): DomainRateState {
    const state = this.getOrCreateDomain(domain);
    const now = Date.now();

    // Slide window
    const windowStart = now - WINDOW_MS;
    const currentTimestamps = state.requestTimestamps.filter(t => t > windowStart);
    const currentRPM = currentTimestamps.length;

    // Check penalty
    const penaltyActive = state.penaltyActive && now < state.penaltyUntil;

    // Determine status
    let status: DomainRateState['status'] = 'normal';
    let estimatedWaitMs = 0;

    if (penaltyActive) {
      status = 'penalized';
      estimatedWaitMs = Math.max(0, state.penaltyUntil - now);
    } else if (currentRPM >= state.maxRPM) {
      status = 'throttled';
      const oldestInWindow = currentTimestamps[0];
      if (oldestInWindow) {
        estimatedWaitMs = Math.max(0, oldestInWindow + WINDOW_MS - now + 1);
      }
    } else if (state.consecutiveSuccesses < 3 && state.lastRequestTime > 0) {
      // Just recovered, still in cooldown
      status = 'cooldown';
      estimatedWaitMs = 0;
    }

    return {
      domain,
      maxRPM: state.maxRPM,
      currentRPM,
      burstRemaining: state.burstRemaining,
      penaltyActive,
      penaltyUntil: state.penaltyUntil,
      lastRequestTime: state.lastRequestTime,
      status,
      estimatedWaitMs,
    };
  }

  /** Get all domain rate limit states */
  getAllDomainStates(): DomainRateState[] {
    const states: DomainRateState[] = [];
    for (const domain of this.domains.keys()) {
      states.push(this.getDomainState(domain));
    }
    // Sort by last request time (most recent first)
    states.sort((a, b) => b.lastRequestTime - a.lastRequestTime);
    return states;
  }

  /** Manually override the max RPM for a domain */
  setDomainLimit(domain: string, maxRPM: number): void {
    const state = this.getOrCreateDomain(domain);
    state.maxRPM = Math.max(1, maxRPM);
  }

  /** Reset a domain's rate limit state */
  resetDomain(domain: string): void {
    this.domains.delete(domain);
  }

  /** Get number of tracked domains */
  size(): number {
    return this.domains.size;
  }

  private getOrCreateDomain(domain: string): DomainState {
    let state = this.domains.get(domain);
    if (!state) {
      state = {
        maxRPM: this.config.defaultMaxRPM,
        windowStart: Date.now() - WINDOW_MS,
        requestTimestamps: [],
        burstRemaining: this.config.defaultBurst,
        penaltyActive: false,
        penaltyUntil: 0,
        lastRequestTime: 0,
        consecutiveSuccesses: 0,
      };
      this.domains.set(domain, state);
    }
    return state;
  }
}

// Singleton export
export const rateLimiter = DomainRateLimiter.getInstance();
