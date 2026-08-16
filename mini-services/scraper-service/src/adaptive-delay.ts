/**
 * Adaptive Delay Strategy
 * Per-domain delay management with automatic backoff on errors
 * and gradual recovery on success.
 */

// ==================== Types ====================

export interface DelayConfig {
  baseMin: number;            // default 1000ms
  baseMax: number;            // default 3000ms
  backoffFactor: number;      // default 2.0
  maxBackoff: number;         // default 60000ms (1min)
  errorThreshold: number;     // errors before backoff kicks in (default 3)
  responseTimeThreshold: number; // ms, if response takes longer, increase delay (default 5000)
}

interface DomainState {
  consecutiveErrors: number;
  lastResponseTimes: number[];  // last 10 response times
  currentBackoffLevel: number;  // exponential backoff multiplier
  lastRequestTime: number;      // timestamp
}

export interface DomainStats {
  domain: string;
  currentDelay: number;        // estimated next delay in ms
  backoffLevel: number;        // exponential backoff exponent
  consecutiveErrors: number;
  avgResponseTime: number;     // ms, 0 if no data
  lastRequestTime: number;     // timestamp
  status: 'normal' | 'warning' | 'backoff' | 'critical';
}

const DEFAULT_CONFIG: DelayConfig = {
  baseMin: 1000,
  baseMax: 3000,
  backoffFactor: 2.0,
  maxBackoff: 60000,
  errorThreshold: 3,
  responseTimeThreshold: 5000,
};

const MAX_RESPONSE_HISTORY = 10;

// ==================== AdaptiveDelayManager ====================

class AdaptiveDelayManager {
  private domains = new Map<string, DomainState>();
  private config: DelayConfig;
  private static instance: AdaptiveDelayManager;

  private constructor(config?: Partial<DelayConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  static getInstance(config?: Partial<DelayConfig>): AdaptiveDelayManager {
    if (!AdaptiveDelayManager.instance) {
      AdaptiveDelayManager.instance = new AdaptiveDelayManager(config);
    }
    return AdaptiveDelayManager.instance;
  }

  /**
   * Get the delay for the next request to a given domain.
   * Factors in: base delay, error backoff, slow response penalty, random jitter.
   */
  async getDelay(domain: string): Promise<number> {
    const state = this.getOrCreateDomain(domain);

    // Base delay
    const baseDelay = this.config.baseMin + Math.random() * (this.config.baseMax - this.config.baseMin);

    // Error backoff multiplier
    let backoffMultiplier = 1;
    if (state.consecutiveErrors >= this.config.errorThreshold) {
      const excessErrors = state.consecutiveErrors - this.config.errorThreshold + 1;
      backoffMultiplier = Math.pow(this.config.backoffFactor, excessErrors);
    }

    // Slow response penalty
    let slowPenalty = 1;
    if (state.lastResponseTimes.length >= 3) {
      const avgResponseTime = state.lastResponseTimes.reduce((a, b) => a + b, 0) / state.lastResponseTimes.length;
      if (avgResponseTime > this.config.responseTimeThreshold) {
        slowPenalty = 1.5;
      }
    }

    // Calculate raw delay
    let delay = baseDelay * backoffMultiplier * slowPenalty;

    // Apply jitter ±20%
    const jitter = 0.8 + Math.random() * 0.4;
    delay = delay * jitter;

    // Cap at maxBackoff
    delay = Math.min(delay, this.config.maxBackoff);

    // Minimum 100ms
    delay = Math.max(delay, 100);

    return Math.round(delay);
  }

  /**
   * Record the outcome of a request to a domain.
   * Adjusts backoff levels and response time tracking.
   */
  recordResponse(domain: string, responseTime: number, success: boolean, statusCode?: number): void {
    const state = this.getOrCreateDomain(domain);
    state.lastRequestTime = Date.now();

    // Track response time (rolling window of last 10)
    state.lastResponseTimes.push(responseTime);
    if (state.lastResponseTimes.length > MAX_RESPONSE_HISTORY) {
      state.lastResponseTimes.shift();
    }

    if (success) {
      // On success: reduce consecutive errors gradually
      if (state.consecutiveErrors > 0) {
        // Reduce by 1 (not reset to 0) to allow gradual recovery
        state.consecutiveErrors = Math.max(0, state.consecutiveErrors - 1);
      }
      // If we've been error-free for a while, reduce backoff level
      if (state.consecutiveErrors === 0 && state.currentBackoffLevel > 0) {
        state.currentBackoffLevel = Math.max(0, state.currentBackoffLevel - 1);
      }
    } else {
      // On error: increase consecutive errors
      state.consecutiveErrors++;

      // Special handling for anti-crawl status codes
      const isAntiCrawl = statusCode === 429 || statusCode === 403 || statusCode === 503;
      if (isAntiCrawl) {
        // Aggressive backoff for anti-crawl responses
        state.consecutiveErrors = Math.max(state.consecutiveErrors, this.config.errorThreshold);
        state.currentBackoffLevel = Math.min(
          state.currentBackoffLevel + 2,
          10 // Cap backoff level
        );
      }
    }
  }

  /** Get current delay/backoff state for a specific domain */
  getDomainStats(domain: string): DomainStats {
    const state = this.getOrCreateDomain(domain);
    const avgResponseTime = state.lastResponseTimes.length > 0
      ? Math.round(state.lastResponseTimes.reduce((a, b) => a + b, 0) / state.lastResponseTimes.length)
      : 0;

    // Estimate current delay
    const baseDelay = (this.config.baseMin + this.config.baseMax) / 2;
    let backoffMultiplier = 1;
    if (state.consecutiveErrors >= this.config.errorThreshold) {
      const excessErrors = state.consecutiveErrors - this.config.errorThreshold + 1;
      backoffMultiplier = Math.pow(this.config.backoffFactor, excessErrors);
    }
    let slowPenalty = 1;
    if (state.lastResponseTimes.length >= 3) {
      const avg = state.lastResponseTimes.reduce((a, b) => a + b, 0) / state.lastResponseTimes.length;
      if (avg > this.config.responseTimeThreshold) {
        slowPenalty = 1.5;
      }
    }
    const currentDelay = Math.min(Math.round(baseDelay * backoffMultiplier * slowPenalty), this.config.maxBackoff);

    // Determine status
    let status: DomainStats['status'] = 'normal';
    if (state.consecutiveErrors >= this.config.errorThreshold * 3) {
      status = 'critical';
    } else if (state.consecutiveErrors >= this.config.errorThreshold) {
      status = 'backoff';
    } else if (state.consecutiveErrors > 0 || slowPenalty > 1) {
      status = 'warning';
    }

    return {
      domain,
      currentDelay,
      backoffLevel: state.currentBackoffLevel,
      consecutiveErrors: state.consecutiveErrors,
      avgResponseTime,
      lastRequestTime: state.lastRequestTime,
      status,
    };
  }

  /** Get stats for all tracked domains */
  getAllDomainStats(): DomainStats[] {
    const stats: DomainStats[] = [];
    for (const domain of this.domains.keys()) {
      stats.push(this.getDomainStats(domain));
    }
    // Sort by last request time (most recent first)
    stats.sort((a, b) => b.lastRequestTime - a.lastRequestTime);
    return stats;
  }

  /** Reset backoff to base level for a specific domain */
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
        consecutiveErrors: 0,
        lastResponseTimes: [],
        currentBackoffLevel: 0,
        lastRequestTime: 0,
      };
      this.domains.set(domain, state);
    }
    return state;
  }
}

// Singleton export
export const adaptiveDelay = AdaptiveDelayManager.getInstance();
