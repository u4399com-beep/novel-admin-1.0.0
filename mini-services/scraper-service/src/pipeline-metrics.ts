/**
 * Scraping Pipeline Metrics
 *
 * Tracks key performance indicators for the scraping pipeline:
 *   - Requests per minute (RPM)
 *   - Success rate
 *   - Average response time
 *   - CAPTCHA rate
 *   - Proxy rotation rate
 *
 * Uses a rolling 5-minute window for rate calculations.
 * Provides per-domain and global metrics.
 */

import { logger } from './logger';

const log = logger.child('PipelineMetrics');

// ==================== Types ====================

interface MetricEvent {
  timestamp: number;
  domain: string;
  success: boolean;
  responseTime: number;
  hadCaptcha: boolean;
  proxyRotated: boolean;
  engine: string;
  statusCode: number;
}

interface DomainMetrics {
  domain: string;
  requestsPerMinute: number;
  successRate: number;
  avgResponseTime: number;
  captchaRate: number;
  proxyRotationRate: number;
  totalRequests: number;
  totalSuccesses: number;
  totalCaptchas: number;
  totalProxyRotations: number;
}

interface GlobalMetrics {
  requestsPerMinute: number;
  successRate: number;
  avgResponseTime: number;
  captchaRate: number;
  proxyRotationRate: number;
  totalRequests: number;
  totalSuccesses: number;
  totalCaptchas: number;
  totalProxyRotations: number;
  activeDomains: number;
  uptimeMs: number;
}

type HealthStatus = 'healthy' | 'degraded' | 'critical';

interface HealthAssessment {
  status: HealthStatus;
  successRate: number;
  captchaRate: number;
  avgResponseTime: number;
  issues: string[];
}

// ==================== Constants ====================

const ROLLING_WINDOW_MS = 5 * 60 * 1000; // 5-minute rolling window
const MAX_EVENTS = 50_000; // Bound on stored events
const MAX_DOMAINS = 500;

// ==================== PipelineMetrics ====================

class PipelineMetrics {
  private events: MetricEvent[] = [];
  private domainEventCounts: Map<string, number> = new Map();
  private startTime: number = Date.now();
  private lastCleanup: number = Date.now();

  /**
   * Record a scraping request event.
   */
  recordEvent(event: Omit<MetricEvent, 'timestamp'>): void {
    const fullEvent: MetricEvent = {
      ...event,
      timestamp: Date.now(),
    };

    this.events.push(fullEvent);

    // Track domain count
    const count = this.domainEventCounts.get(event.domain) || 0;
    this.domainEventCounts.set(event.domain, count + 1);

    // Periodic cleanup (every 30 seconds)
    if (Date.now() - this.lastCleanup > 30_000) {
      this.cleanup();
    }
  }

  /**
   * Get metrics for a specific domain.
   */
  getMetrics(domain?: string): DomainMetrics | GlobalMetrics {
    this.cleanup();

    if (domain) {
      return this.computeDomainMetrics(domain);
    }
    return this.computeGlobalMetrics();
  }

  /**
   * Get metrics for all active domains.
   */
  getAllDomainMetrics(): DomainMetrics[] {
    this.cleanup();

    const domains = new Set<string>();
    const cutoff = Date.now() - ROLLING_WINDOW_MS;

    for (const event of this.events) {
      if (event.timestamp >= cutoff) {
        domains.add(event.domain);
      }
    }

    return Array.from(domains)
      .map(d => this.computeDomainMetrics(d))
      .sort((a, b) => b.totalRequests - a.totalRequests);
  }

  /**
   * Get overall health assessment.
   */
  getHealth(): HealthAssessment {
    const global = this.computeGlobalMetrics();
    const issues: string[] = [];

    let status: HealthStatus = 'healthy';

    // If no requests yet, report healthy
    if (global.totalRequests === 0) {
      return {
        status: 'healthy',
        successRate: 0,
        captchaRate: 0,
        avgResponseTime: 0,
        issues: ['No requests recorded yet'],
      };
    }

    // Check success rate
    if (global.successRate < 0.5) {
      status = 'critical';
      issues.push(`Success rate critically low: ${(global.successRate * 100).toFixed(1)}%`);
    } else if (global.successRate < 0.8) {
      status = 'degraded';
      issues.push(`Success rate degraded: ${(global.successRate * 100).toFixed(1)}%`);
    }

    // Check CAPTCHA rate
    if (global.captchaRate > 0.3) {
      status = status === 'critical' ? status : 'critical';
      issues.push(`CAPTCHA rate critically high: ${(global.captchaRate * 100).toFixed(1)}%`);
    } else if (global.captchaRate > 0.1) {
      status = status === 'critical' ? status : 'degraded';
      issues.push(`CAPTCHA rate elevated: ${(global.captchaRate * 100).toFixed(1)}%`);
    }

    // Check response time
    if (global.avgResponseTime > 10000) {
      status = status === 'critical' ? status : 'degraded';
      issues.push(`Average response time high: ${Math.round(global.avgResponseTime)}ms`);
    }

    if (issues.length === 0) {
      issues.push('All metrics within normal range');
    }

    return {
      status,
      successRate: global.successRate,
      captchaRate: global.captchaRate,
      avgResponseTime: global.avgResponseTime,
      issues,
    };
  }

  // ---- Private helpers ----

  private computeDomainMetrics(domain: string): DomainMetrics {
    const cutoff = Date.now() - ROLLING_WINDOW_MS;
    const windowEvents = this.events.filter(
      e => e.domain === domain && e.timestamp >= cutoff
    );

    return this.computeMetricsFromEvents(windowEvents, domain);
  }

  private computeGlobalMetrics(): GlobalMetrics {
    const cutoff = Date.now() - ROLLING_WINDOW_MS;
    const windowEvents = this.events.filter(e => e.timestamp >= cutoff);

    const base = this.computeMetricsFromEvents(windowEvents);

    return {
      ...base,
      activeDomains: this.domainEventCounts.size,
      uptimeMs: Date.now() - this.startTime,
    };
  }

  private computeMetricsFromEvents(
    events: MetricEvent[],
    domain?: string,
  ): DomainMetrics | GlobalMetrics {
    const total = events.length;
    if (total === 0) {
      return {
        domain: domain || '*',
        requestsPerMinute: 0,
        successRate: 0,
        avgResponseTime: 0,
        captchaRate: 0,
        proxyRotationRate: 0,
        totalRequests: 0,
        totalSuccesses: 0,
        totalCaptchas: 0,
        totalProxyRotations: 0,
      };
    }

    const successes = events.filter(e => e.success).length;
    const captchas = events.filter(e => e.hadCaptcha).length;
    const proxyRotations = events.filter(e => e.proxyRotated).length;
    const totalResponseTime = events.reduce((sum, e) => sum + e.responseTime, 0);

    // Compute RPM from actual time span
    const timeSpan = events.length > 1
      ? events[events.length - 1].timestamp - events[0].timestamp
      : 60_000; // Single event: assume 1-minute span for meaningful RPM
    const timeSpanMinutes = Math.max(timeSpan / 60_000, 0.001); // Minimum 1ms to avoid division by zero
    const requestsPerMinute = total / timeSpanMinutes;

    const base = {
      requestsPerMinute: Math.round(requestsPerMinute * 10) / 10,
      successRate: successes / total,
      avgResponseTime: Math.round(totalResponseTime / total),
      captchaRate: captchas / total,
      proxyRotationRate: proxyRotations / total,
      totalRequests: total,
      totalSuccesses: successes,
      totalCaptchas: captchas,
      totalProxyRotations: proxyRotations,
    };

    if (domain) {
      return { domain, ...base };
    }
    return { domain: '*' as string, ...base };
  }

  private cleanup(): void {
    this.lastCleanup = Date.now();
    const cutoff = Date.now() - ROLLING_WINDOW_MS;

    // Remove events outside the rolling window
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(-MAX_EVENTS);
    }

    // Remove events older than the window (but keep at least 100 for stats)
    if (this.events.length > 100) {
      const firstInWindow = this.events.findIndex(e => e.timestamp >= cutoff);
      if (firstInWindow > 0) {
        this.events = this.events.slice(firstInWindow);
      }
    }

    // Prune domain counts for inactive domains
    if (this.domainEventCounts.size > MAX_DOMAINS) {
      const activeDomains = new Set<string>();
      for (const event of this.events) {
        activeDomains.add(event.domain);
      }
      for (const domain of this.domainEventCounts.keys()) {
        if (!activeDomains.has(domain)) {
          this.domainEventCounts.delete(domain);
        }
      }
    }
  }
}

// Singleton
export const pipelineMetrics = new PipelineMetrics();
