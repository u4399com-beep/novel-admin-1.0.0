/**
 * Cross-Domain Coordination
 *
 * When scraping multiple domains simultaneously:
 *   - Prevents too many simultaneous connections across all domains
 *   - Shares proxy pools efficiently (don't waste good proxies on easy domains)
 *   - Coordinates rate limits: if one domain triggers a block, slow down related domains
 *   - Balances resources: give more concurrency to domains with better success rates
 *   - Global rate limit: never exceed N total RPM across all domains (default: 200)
 */

import { logger } from './logger';
const log = logger.child('CrossDomainCoord');

// ==================== Types ====================

export interface DomainState {
  domain: string;
  /** Active concurrent connections */
  activeConnections: number;
  /** Maximum concurrent connections allowed */
  maxConcurrency: number;
  /** Success rate (0-1) over recent window */
  successRate: number;
  /** Requests per minute (actual, measured) */
  currentRPM: number;
  /** Target RPM for this domain */
  targetRPM: number;
  /** Whether this domain is currently blocked/throttled */
  isBlocked: boolean;
  /** Block reason */
  blockReason?: string;
  /** Total successful requests */
  totalSuccess: number;
  /** Total failed requests */
  totalFail: number;
  /** Last request timestamp */
  lastRequestAt: number;
  /** Proxy assignment priority (higher = needs better proxy) */
  proxyPriority: number;
  /** Related domains (share same WAF/infrastructure) */
  relatedDomains: string[];
  /** Timestamp when block was detected */
  blockedAt?: number;
}

export interface CoordinationStats {
  totalDomains: number;
  totalActiveConnections: number;
  globalRPM: number;
  globalRPMTarget: number;
  blockedDomains: number;
  domainStates: DomainState[];
  proxyUtilization: Record<string, number>;
}

// ==================== Constants ====================

const DEFAULT_GLOBAL_RPM_LIMIT = 200;
const DEFAULT_MAX_CONCURRENT = 50;
const SUCCESS_WINDOW_MS = 5 * 60 * 1000; // 5-minute rolling window
const BLOCK_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes block cooldown
const MAX_TRACKED_DOMAINS = 1000;

// ==================== Request Tracker ====================

interface RequestEvent {
  timestamp: number;
  success: boolean;
  domain: string;
}

// ==================== CrossDomainCoordinator ====================

class CrossDomainCoordinator {
  private domainStates: Map<string, DomainState> = new Map();
  private recentRequests: RequestEvent[] = [];
  private globalRPMLimit: number;
  private maxConcurrent: number;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  // RPM tracking
  private rpmWindowMs = 60_000; // 1 minute window
  private globalRequestTimestamps: number[] = [];

  constructor(options?: {
    globalRPMLimit?: number;
    maxConcurrent?: number;
  }) {
    this.globalRPMLimit = options?.globalRPMLimit || DEFAULT_GLOBAL_RPM_LIMIT;
    this.maxConcurrent = options?.maxConcurrent || DEFAULT_MAX_CONCURRENT;

    // Cleanup every 30 seconds
    this.cleanupInterval = setInterval(() => {
      try { this.cleanup(); } catch {}
    }, 30_000).unref();
  }

  /**
   * Register a domain for coordination.
   * Sets initial concurrency and RPM targets.
   */
  registerDomain(domain: string, options?: {
    maxConcurrency?: number;
    targetRPM?: number;
    relatedDomains?: string[];
  }): void {
    const normalized = domain.toLowerCase().replace(/^www\./, '');
    if (this.domainStates.has(normalized)) return;

    // Enforce max tracked domains
    if (this.domainStates.size >= MAX_TRACKED_DOMAINS) {
      // Remove least recently used
      let lruDomain: string | null = null;
      let lruTime = Infinity;
      for (const [d, state] of this.domainStates) {
        if (state.lastRequestAt < lruTime) {
          lruTime = state.lastRequestAt;
          lruDomain = d;
        }
      }
      if (lruDomain) this.domainStates.delete(lruDomain);
    }

    const defaultConcurrency = options?.maxConcurrency || 5;
    const defaultRPM = options?.targetRPM || Math.floor(this.globalRPMLimit / 10);

    this.domainStates.set(normalized, {
      domain: normalized,
      activeConnections: 0,
      maxConcurrency: defaultConcurrency,
      successRate: 1.0,
      currentRPM: 0,
      targetRPM: defaultRPM,
      isBlocked: false,
      totalSuccess: 0,
      totalFail: 0,
      lastRequestAt: 0,
      proxyPriority: 1, // Neutral priority
      relatedDomains: options?.relatedDomains || [],
    });
  }

  /**
   * Acquire a connection slot for a domain.
   * Returns true if the request is allowed, false if it should be queued.
   *
   * Checks:
   *   1. Domain concurrency limit
   *   2. Domain RPM limit
   *   3. Global RPM limit
   *   4. Domain not blocked
   */
  acquireConnection(domain: string): {
    allowed: boolean;
    reason?: string;
    waitMs?: number;
  } {
    const normalized = domain.toLowerCase().replace(/^www\./, '');

    // Auto-register if not tracked
    if (!this.domainStates.has(normalized)) {
      this.registerDomain(normalized);
    }

    const state = this.domainStates.get(normalized)!;

    // Check if blocked
    if (state.isBlocked) {
      const elapsed = Date.now() - (state.blockedAt || 0);
      if (elapsed < BLOCK_COOLDOWN_MS) {
        const waitMs = BLOCK_COOLDOWN_MS - elapsed;
        return { allowed: false, reason: `Domain blocked: ${state.blockReason}`, waitMs };
      }
      // Cooldown expired — unblock
      state.isBlocked = false;
      state.blockReason = undefined;
      state.blockedAt = undefined;
    }

    // Check domain concurrency
    if (state.activeConnections >= state.maxConcurrency) {
      return {
        allowed: false,
        reason: `Domain concurrency limit: ${state.activeConnections}/${state.maxConcurrency}`,
        waitMs: 1000,
      };
    }

    // Check global concurrency
    const totalActive = this.getTotalActiveConnections();
    if (totalActive >= this.maxConcurrent) {
      return {
        allowed: false,
        reason: `Global concurrency limit: ${totalActive}/${this.maxConcurrent}`,
        waitMs: 2000,
      };
    }

    // Check domain RPM
    const domainRPM = this.getDomainRPM(normalized);
    if (domainRPM >= state.targetRPM) {
      return {
        allowed: false,
        reason: `Domain RPM limit: ${domainRPM}/${state.targetRPM}`,
        waitMs: Math.ceil(60_000 / state.targetRPM),
      };
    }

    // Check global RPM
    const globalRPM = this.getGlobalRPM();
    if (globalRPM >= this.globalRPMLimit) {
      return {
        allowed: false,
        reason: `Global RPM limit: ${globalRPM}/${this.globalRPMLimit}`,
        waitMs: Math.ceil(60_000 / this.globalRPMLimit),
      };
    }

    // Allowed — increment counters
    state.activeConnections++;
    state.lastRequestAt = Date.now();

    return { allowed: true };
  }

  /**
   * Release a connection slot after a request completes.
   * Records success/failure for adaptive coordination.
   */
  releaseConnection(domain: string, success: boolean, statusCode?: number): void {
    const normalized = domain.toLowerCase().replace(/^www\./, '');
    const state = this.domainStates.get(normalized);

    if (state) {
      state.activeConnections = Math.max(0, state.activeConnections - 1);

      if (success) {
        state.totalSuccess++;
      } else {
        state.totalFail++;
      }

      // Record the event
      this.recentRequests.push({
        timestamp: Date.now(),
        success,
        domain: normalized,
      });

      // Update success rate
      this.updateSuccessRate(normalized);

      // Check for block signals
      if (!success && (statusCode === 403 || statusCode === 429)) {
        this.markDomainBlocked(normalized, `HTTP ${statusCode}`);
      }
    }

    // Record global request timestamp for RPM tracking
    this.globalRequestTimestamps.push(Date.now());
  }

  /**
   * Mark a domain as blocked (e.g., after 403/429).
   * Also slows down related domains that share the same WAF/infrastructure.
   */
  markDomainBlocked(domain: string, reason: string): void {
    const normalized = domain.toLowerCase().replace(/^www\./, '');
    const state = this.domainStates.get(normalized);
    if (!state) return;

    state.isBlocked = true;
    state.blockReason = reason;
    state.blockedAt = Date.now();

    log.info(`Domain ${normalized} blocked: ${reason}`);

    // Slow down related domains
    for (const relatedDomain of state.relatedDomains) {
      const related = this.domainStates.get(relatedDomain);
      if (related && !related.isBlocked) {
        // Reduce RPM target by 50% for related domains
        const oldTarget = related.targetRPM;
        related.targetRPM = Math.max(1, Math.floor(related.targetRPM * 0.5));
        log.info(`Slowed related domain ${relatedDomain}: ${oldTarget} → ${related.targetRPM} RPM`);
      }
    }
  }

  /**
   * Get proxy priority for a domain.
   * Higher priority = needs better proxy (more blocked/slower domains).
   * Used by proxy pool to assign the best proxies where they're needed most.
   */
  getProxyPriority(domain: string): number {
    const normalized = domain.toLowerCase().replace(/^www\./, '');
    const state = this.domainStates.get(normalized);
    if (!state) return 1;

    // Priority based on:
    //   - Low success rate → higher priority (needs better proxy)
    //   - Recent blocks → higher priority
    //   - High target RPM → higher priority (more important domain)
    let priority = 1;

    // Success rate factor (lower success = higher priority)
    if (state.successRate < 0.5) priority += 3;
    else if (state.successRate < 0.8) priority += 1;

    // Block factor
    if (state.isBlocked) priority += 5;
    if (state.totalFail > state.totalSuccess) priority += 2;

    // RPM importance factor
    if (state.targetRPM > 20) priority += 1;

    return Math.min(priority, 10); // Cap at 10
  }

  /**
   * Dynamically adjust concurrency limits based on success rates.
   * Domains with better success rates get more concurrency.
   * Called periodically by the cleanup interval.
   */
  rebalanceResources(): void {
    const states = Array.from(this.domainStates.values())
      .filter(s => !s.isBlocked && s.totalSuccess + s.totalFail > 10);

    if (states.length === 0) return;

    // Calculate weighted allocation based on success rates
    const totalSuccessWeight = states.reduce((sum, s) => sum + s.successRate, 0);

    for (const state of states) {
      // Proportional share of max concurrent, weighted by success rate
      const share = state.successRate / totalSuccessWeight;
      const allocatedConcurrency = Math.max(1, Math.round(share * this.maxConcurrent));

      // Gradual adjustment: move 10% toward target each rebalance
      const current = state.maxConcurrency;
      const target = Math.min(allocatedConcurrency, 20); // Cap at 20 per domain
      state.maxConcurrency = Math.round(current + 0.1 * (target - current));

      // Also adjust RPM target based on success rate
      if (state.successRate > 0.9) {
        // High success: can try slightly faster
        state.targetRPM = Math.min(
          Math.ceil(state.targetRPM * 1.05),
          Math.floor(this.globalRPMLimit / states.length * 2),
        );
      } else if (state.successRate < 0.7) {
        // Low success: slow down
        state.targetRPM = Math.max(1, Math.floor(state.targetRPM * 0.9));
      }
    }
  }

  /**
   * Get coordination statistics.
   */
  getStats(): CoordinationStats {
    const domainStates = Array.from(this.domainStates.values());
    const totalActive = this.getTotalActiveConnections();
    const globalRPM = this.getGlobalRPM();

    // Proxy utilization by domain
    const proxyUtilization: Record<string, number> = {};
    for (const state of domainStates) {
      if (state.activeConnections > 0) {
        proxyUtilization[state.domain] = state.activeConnections;
      }
    }

    return {
      totalDomains: domainStates.length,
      totalActiveConnections: totalActive,
      globalRPM,
      globalRPMTarget: this.globalRPMLimit,
      blockedDomains: domainStates.filter(d => d.isBlocked).length,
      domainStates: domainStates.sort((a, b) => b.activeConnections - a.activeConnections),
      proxyUtilization,
    };
  }

  /**
   * Set the global RPM limit.
   */
  setGlobalRPMLimit(limit: number): void {
    this.globalRPMLimit = Math.max(10, limit);
  }

  /**
   * Set related domains for coordination.
   * When one domain gets blocked, related domains slow down.
   */
  setRelatedDomains(domain: string, relatedDomains: string[]): void {
    const normalized = domain.toLowerCase().replace(/^www\./, '');
    const state = this.domainStates.get(normalized);
    if (state) {
      state.relatedDomains = relatedDomains.map(d => d.toLowerCase().replace(/^www\./, ''));
    }
  }

  // ==================== Private Helpers ====================

  private updateSuccessRate(domain: string): void {
    const now = Date.now();
    const windowStart = now - SUCCESS_WINDOW_MS;

    // Count recent events for this domain
    const recent = this.recentRequests.filter(
      e => e.domain === domain && e.timestamp >= windowStart,
    );
    if (recent.length === 0) return;

    const successes = recent.filter(e => e.success).length;
    const state = this.domainStates.get(domain);
    if (state) {
      state.successRate = successes / recent.length;
      state.currentRPM = this.getDomainRPM(domain);
    }
  }

  private getDomainRPM(domain: string): number {
    const now = Date.now();
    const windowStart = now - this.rpmWindowMs;
    return this.recentRequests.filter(
      e => e.domain === domain && e.timestamp >= windowStart,
    ).length;
  }

  private getGlobalRPM(): number {
    const now = Date.now();
    const windowStart = now - this.rpmWindowMs;
    return this.globalRequestTimestamps.filter(t => t >= windowStart).length;
  }

  private getTotalActiveConnections(): number {
    let total = 0;
    for (const state of this.domainStates.values()) {
      total += state.activeConnections;
    }
    return total;
  }

  private cleanup(): void {
    const now = Date.now();

    // Trim old request events (older than 2x success window)
    const cutoff = now - SUCCESS_WINDOW_MS * 2;
    while (this.recentRequests.length > 0 && this.recentRequests[0].timestamp < cutoff) {
      this.recentRequests.shift();
    }

    // Trim global request timestamps
    const rpmCutoff = now - this.rpmWindowMs * 2;
    while (this.globalRequestTimestamps.length > 0 && this.globalRequestTimestamps[0] < rpmCutoff) {
      this.globalRequestTimestamps.shift();
    }

    // Unblock domains past cooldown
    for (const state of this.domainStates.values()) {
      if (state.isBlocked && state.blockedAt && now - state.blockedAt > BLOCK_COOLDOWN_MS) {
        state.isBlocked = false;
        state.blockReason = undefined;
        state.blockedAt = undefined;
      }
    }

    // Rebalance resources periodically
    this.rebalanceResources();
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  // ==================== Domain Relationship Graph ====================

  /**
   * Domain relationship graph for WAF/infrastructure correlation.
   *
   * Related domains often share:
   *   - Same WAF provider (Cloudflare, PerimeterX)
   *   - Same hosting provider
   *   - Same CDN (static assets on cdn.example.com)
   *   - Same parent company
   *
   * When one domain gets blocked, related domains should slow down
   * because they likely share the same anti-bot backend.
   */

  /**
   * Auto-detect domain relationships based on naming patterns.
   * e.g., "cdn.example.com" is related to "www.example.com"
   *       "static.shop.cn" is related to "shop.cn"
   */
  autoDetectRelationships(): void {
    const domains = Array.from(this.domainStates.keys());

    for (const domain of domains) {
      const related: string[] = [];

      // Extract base domain (e.g., "example.com" from "cdn.example.com")
      const parts = domain.split('.');
      if (parts.length >= 2) {
        const baseDomain = parts.slice(-2).join('.');
        // Find all domains sharing the same base
        for (const other of domains) {
          if (other !== domain && (other === baseDomain || other.endsWith('.' + baseDomain))) {
            related.push(other);
          }
        }
      }

      if (related.length > 0) {
        const state = this.domainStates.get(domain);
        if (state) {
          // Merge auto-detected with manually set
          const combined = new Set([...state.relatedDomains, ...related]);
          state.relatedDomains = Array.from(combined);
        }
      }
    }
  }

  /**
   * Get all domain relationships as a graph.
   */
  getRelationshipGraph(): Array<{ domain: string; related: string[] }> {
    return Array.from(this.domainStates.values()).map(s => ({
      domain: s.domain,
      related: s.relatedDomains,
    }));
  }

  // ==================== Shared Session Management ====================

  /**
   * Shared session management across related domains.
   *
   * When domains share infrastructure, maintaining consistent
   * session identifiers (cookies, tokens) across them prevents
   * session fragmentation that anti-bot systems can detect.
   */

  private sharedSessions = new Map<string, Set<string>>(); // sessionGroup -> domains

  /**
   * Define a shared session group for related domains.
   * Domains in the same group share session coordination.
   */
  defineSharedSessionGroup(groupName: string, domains: string[]): void {
    this.sharedSessions.set(groupName, new Set(domains.map(d => d.toLowerCase().replace(/^www\./, ''))));
  }

  /**
   * Get the session group for a domain.
   */
  getSessionGroup(domain: string): string | undefined {
    const normalized = domain.toLowerCase().replace(/^www\./, '');
    for (const [group, domains] of this.sharedSessions) {
      if (domains.has(normalized)) return group;
    }
    return undefined;
  }

  /**
   * Check if two domains share a session group.
   */
  areDomainsRelated(domain1: string, domain2: string): boolean {
    const group1 = this.getSessionGroup(domain1);
    const group2 = this.getSessionGroup(domain2);
    return !!group1 && group1 === group2;
  }
}

// ==================== Singleton ====================

export const crossDomainCoordinator = new CrossDomainCoordinator();
