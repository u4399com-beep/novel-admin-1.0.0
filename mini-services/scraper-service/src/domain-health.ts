/**
 * Domain Health Monitoring
 *
 * Monitors per-domain health score (0-100) based on:
 *   - Success rate (weight: 0.3)
 *   - Response time trend (weight: 0.2)
 *   - CAPTCHA rate (weight: 0.2)
 *   - Rate limit hit rate (weight: 0.15)
 *   - Content quality (weight: 0.15)
 *
 * Health states: healthy (>70) → degraded (40-70) → critical (<40)
 * When health drops to critical: auto-pause domain, switch to stealth mode, notify via log
 * When health recovers: auto-resume with conservative rate
 *
 * API: GET /domain-health (all domains), GET /domain-health/:domain
 */

import { logger } from './logger';
import { rateOptimizer } from './rate-optimizer';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const log = logger.child('DomainHealth');

// ==================== Types ====================

export type HealthState = 'healthy' | 'degraded' | 'critical';

export interface DomainHealthScore {
  domain: string;
  /** Overall health score 0-100 */
  score: number;
  /** Health state derived from score */
  state: HealthState;
  /** Component scores */
  components: {
    successRate: { score: number; weight: number; value: number };
    responseTime: { score: number; weight: number; value: number };
    captchaRate: { score: number; weight: number; value: number };
    rateLimitHitRate: { score: number; weight: number; value: number };
    contentQuality: { score: number; weight: number; value: number };
  };
  /** Whether domain is auto-paused */
  isPaused: boolean;
  /** When the domain was paused (timestamp) */
  pausedAt?: number;
  /** Reason for pausing */
  pauseReason?: string;
  /** Last time health was computed */
  computedAt: number;
  /** Trend: positive = improving, negative = declining */
  trend: number;
}

export interface DomainHealthData {
  /** Rolling window of response records */
  recentResponses: Array<{
    timestamp: number;
    success: boolean;
    responseTimeMs: number;
    wasCaptcha: boolean;
    wasRateLimited: boolean;
    contentQualityScore: number; // 0-100
  }>;
  /** Health score history for trend computation */
  scoreHistory: Array<{ timestamp: number; score: number }>;
  /** Whether domain is auto-paused */
  isPaused: boolean;
  pausedAt?: number;
  pauseReason?: string;
  /** First time this domain was seen */
  firstSeenAt: number;
}

export interface DomainHealthSummary {
  domains: Record<string, {
    score: number;
    state: HealthState;
    isPaused: boolean;
    trend: number;
  }>;
  totalDomains: number;
  healthyCount: number;
  degradedCount: number;
  criticalCount: number;
  pausedCount: number;
}

// ==================== Constants ====================

const RESPONSE_WINDOW_SIZE = 100;
const SCORE_HISTORY_SIZE = 20;
const MAX_DOMAINS = 500;
const HEALTHY_THRESHOLD = 70;
const DEGRADED_THRESHOLD = 40;
const AUTO_RESUME_THRESHOLD = 60; // Auto-resume when score reaches this
const PERSIST_INTERVAL_MS = 60_000;
const AUTO_PAUSE_COOLDOWN_MS = 5 * 60 * 1000; // Don't re-pause within 5 min

// Weights for health components
const WEIGHT_SUCCESS_RATE = 0.3;
const WEIGHT_RESPONSE_TIME = 0.2;
const WEIGHT_CAPTCHA_RATE = 0.2;
const WEIGHT_RATE_LIMIT = 0.15;
const WEIGHT_CONTENT_QUALITY = 0.15;

// ==================== Persistence ====================

const PERSIST_DIR = resolve(import.meta.dir ?? '.', '..');
const PERSIST_FILE = resolve(PERSIST_DIR, 'domain-health-state.json');

interface PersistedHealthData {
  domains: Record<string, {
    isPaused: boolean;
    pausedAt?: number;
    pauseReason?: string;
  }>;
  version: number;
}

function loadPersistedData(): PersistedHealthData | null {
  try {
    if (existsSync(PERSIST_FILE)) {
      const raw = readFileSync(PERSIST_FILE, 'utf-8');
      const data = JSON.parse(raw);
      if (data && data.version === 1 && data.domains) {
        return data as PersistedHealthData;
      }
    }
  } catch {}
  return null;
}

function persistData(domains: Map<string, DomainHealthData>): void {
  try {
    const domainData: PersistedHealthData['domains'] = {};
    for (const [domain, data] of domains) {
      if (data.isPaused) {
        domainData[domain] = {
          isPaused: true,
          pausedAt: data.pausedAt,
          pauseReason: data.pauseReason,
        };
      }
    }
    writeFileSync(PERSIST_FILE, JSON.stringify({ domains: domainData, version: 1 }, null, 2));
  } catch {}
}

// ==================== Domain Health Monitor ====================

class DomainHealthMonitor {
  private domains = new Map<string, DomainHealthData>();
  private persistTimer: ReturnType<typeof setInterval> | null = null;
  private eventListeners: Array<(domain: string, health: DomainHealthScore) => void> = [];

  constructor() {
    // Load paused domains from persistence
    const persisted = loadPersistedData();
    if (persisted) {
      for (const [domain, data] of Object.entries(persisted.domains)) {
        if (data.isPaused) {
          this.domains.set(domain, {
            recentResponses: [],
            scoreHistory: [],
            isPaused: true,
            pausedAt: data.pausedAt,
            pauseReason: data.pauseReason,
            firstSeenAt: Date.now(),
          });
        }
      }
    }

    // Periodic persistence
    this.persistTimer = setInterval(() => {
      try { persistData(this.domains); } catch {}
    }, PERSIST_INTERVAL_MS).unref();
  }

  /**
   * Record a response outcome for a domain.
   */
  recordResponse(
    domain: string,
    success: boolean,
    responseTimeMs: number,
    wasCaptcha: boolean,
    wasRateLimited: boolean,
    contentQualityScore: number = 100,
  ): void {
    const data = this.getOrCreate(domain);
    const now = Date.now();

    data.recentResponses.push({
      timestamp: now,
      success,
      responseTimeMs,
      wasCaptcha,
      wasRateLimited,
      contentQualityScore,
    });

    // Maintain window size
    if (data.recentResponses.length > RESPONSE_WINDOW_SIZE) {
      data.recentResponses.shift();
    }

    // Recompute health and check for auto-pause/resume
    const health = this.computeHealth(domain);

    // Record score history
    data.scoreHistory.push({ timestamp: now, score: health.score });
    if (data.scoreHistory.length > SCORE_HISTORY_SIZE) {
      data.scoreHistory.shift();
    }

    // Auto-pause on critical health
    if (health.state === 'critical' && !data.isPaused) {
      // Cooldown check
      const lastPause = data.pausedAt || 0;
      if (now - lastPause > AUTO_PAUSE_COOLDOWN_MS) {
        data.isPaused = true;
        data.pausedAt = now;
        data.pauseReason = `Health critical (${health.score.toFixed(0)})`;
        log.warn(`Domain ${domain} auto-paused: health=${health.score.toFixed(0)} (${health.state})`);
        // Also tell rate optimizer to back off
        try {
          rateOptimizer.setRate(domain, 2); // Minimum RPM
        } catch {}
      }
    }

    // Auto-resume when health recovers
    if (data.isPaused && health.score >= AUTO_RESUME_THRESHOLD) {
      data.isPaused = false;
      data.pausedAt = undefined;
      data.pauseReason = undefined;
      log.info(`Domain ${domain} auto-resumed: health=${health.score.toFixed(0)}`);
      // Set conservative rate
      try {
        rateOptimizer.setRate(domain, 5); // Conservative RPM
      } catch {}
    }

    // Emit event
    for (const listener of this.eventListeners) {
      try { listener(domain, health); } catch {}
    }
  }

  /**
   * Compute health score for a domain.
   */
  computeHealth(domain: string): DomainHealthScore {
    const data = this.getOrCreate(domain);
    const responses = data.recentResponses;

    if (responses.length === 0) {
      return {
        domain,
        score: 100,
        state: 'healthy',
        components: {
          successRate: { score: 100, weight: WEIGHT_SUCCESS_RATE, value: 1 },
          responseTime: { score: 100, weight: WEIGHT_RESPONSE_TIME, value: 0 },
          captchaRate: { score: 100, weight: WEIGHT_CAPTCHA_RATE, value: 0 },
          rateLimitHitRate: { score: 100, weight: WEIGHT_RATE_LIMIT, value: 0 },
          contentQuality: { score: 100, weight: WEIGHT_CONTENT_QUALITY, value: 100 },
        },
        isPaused: data.isPaused,
        pausedAt: data.pausedAt,
        pauseReason: data.pauseReason,
        computedAt: Date.now(),
        trend: 0,
      };
    }

    // 1. Success rate (0-100)
    const successCount = responses.filter(r => r.success).length;
    const successRate = successCount / responses.length;
    const successScore = successRate * 100;

    // 2. Response time trend (0-100, penalize slow responses)
    const avgResponseTime = responses.reduce((s, r) => s + r.responseTimeMs, 0) / responses.length;
    // < 500ms → 100, 500-2000ms → 80-100, 2000-5000ms → 50-80, >5000ms → 0-50
    let responseTimeScore: number;
    if (avgResponseTime < 500) responseTimeScore = 100;
    else if (avgResponseTime < 2000) responseTimeScore = 80 + 20 * (2000 - avgResponseTime) / 1500;
    else if (avgResponseTime < 5000) responseTimeScore = 50 + 30 * (5000 - avgResponseTime) / 3000;
    else if (avgResponseTime < 10000) responseTimeScore = 50 * (10000 - avgResponseTime) / 5000;
    else responseTimeScore = 0; // >=10s: worst score

    // 3. CAPTCHA rate (0-100, penalize CAPTCHAs)
    const captchaCount = responses.filter(r => r.wasCaptcha).length;
    const captchaRate = captchaCount / responses.length;
    const captchaScore = (1 - captchaRate) * 100;

    // 4. Rate limit hit rate (0-100, penalize rate limits)
    const rateLimitedCount = responses.filter(r => r.wasRateLimited).length;
    const rateLimitRate = rateLimitedCount / responses.length;
    const rateLimitScore = (1 - rateLimitRate) * 100;

    // 5. Content quality (0-100, average of content quality scores)
    const avgContentQuality = responses.reduce((s, r) => s + r.contentQualityScore, 0) / responses.length;

    // Weighted overall score
    const overallScore =
      successScore * WEIGHT_SUCCESS_RATE +
      responseTimeScore * WEIGHT_RESPONSE_TIME +
      captchaScore * WEIGHT_CAPTCHA_RATE +
      rateLimitScore * WEIGHT_RATE_LIMIT +
      avgContentQuality * WEIGHT_CONTENT_QUALITY;

    const score = Math.round(Math.max(0, Math.min(100, overallScore)));

    // Determine state
    let state: HealthState;
    if (score > HEALTHY_THRESHOLD) state = 'healthy';
    else if (score > DEGRADED_THRESHOLD) state = 'degraded';
    else state = 'critical';

    // Compute trend
    let trend = 0;
    if (data.scoreHistory.length >= 2) {
      const recent = data.scoreHistory.slice(-5);
      const older = data.scoreHistory.slice(-10, -5);
      if (older.length > 0) {
        const recentAvg = recent.reduce((s, h) => s + h.score, 0) / recent.length;
        const olderAvg = older.reduce((s, h) => s + h.score, 0) / older.length;
        trend = recentAvg - olderAvg;
      }
    }

    return {
      domain,
      score,
      state,
      components: {
        successRate: { score: Math.round(successScore), weight: WEIGHT_SUCCESS_RATE, value: successRate },
        responseTime: { score: Math.round(responseTimeScore), weight: WEIGHT_RESPONSE_TIME, value: avgResponseTime },
        captchaRate: { score: Math.round(captchaScore), weight: WEIGHT_CAPTCHA_RATE, value: captchaRate },
        rateLimitHitRate: { score: Math.round(rateLimitScore), weight: WEIGHT_RATE_LIMIT, value: rateLimitRate },
        contentQuality: { score: Math.round(avgContentQuality), weight: WEIGHT_CONTENT_QUALITY, value: avgContentQuality },
      },
      isPaused: data.isPaused,
      pausedAt: data.pausedAt,
      pauseReason: data.pauseReason,
      computedAt: Date.now(),
      trend: Math.round(trend * 10) / 10,
    };
  }

  /**
   * Check if a domain is currently paused.
   */
  isDomainPaused(domain: string): boolean {
    const data = this.domains.get(domain);
    return data?.isPaused ?? false;
  }

  /**
   * Manually pause a domain.
   */
  pauseDomain(domain: string, reason?: string): void {
    const data = this.getOrCreate(domain);
    data.isPaused = true;
    data.pausedAt = Date.now();
    data.pauseReason = reason || 'manual';
    log.info(`Domain ${domain} manually paused: ${reason || 'manual'}`);
  }

  /**
   * Manually resume a domain.
   */
  resumeDomain(domain: string): void {
    const data = this.domains.get(domain);
    if (!data) return;
    data.isPaused = false;
    data.pausedAt = undefined;
    data.pauseReason = undefined;
    log.info(`Domain ${domain} manually resumed`);
  }

  /**
   * Get health summary for all domains.
   */
  getSummary(): DomainHealthSummary {
    const domains: DomainHealthSummary['domains'] = {};
    let healthyCount = 0;
    let degradedCount = 0;
    let criticalCount = 0;
    let pausedCount = 0;

    for (const [domain] of this.domains) {
      const health = this.computeHealth(domain);
      domains[domain] = {
        score: health.score,
        state: health.state,
        isPaused: health.isPaused,
        trend: health.trend,
      };
      if (health.state === 'healthy') healthyCount++;
      else if (health.state === 'degraded') degradedCount++;
      else criticalCount++;
      if (health.isPaused) pausedCount++;
    }

    return {
      domains,
      totalDomains: this.domains.size,
      healthyCount,
      degradedCount,
      criticalCount,
      pausedCount,
    };
  }

  /**
   * Add a health change event listener.
   */
  onHealthChange(listener: (domain: string, health: DomainHealthScore) => void): void {
    this.eventListeners.push(listener);
  }

  /**
   * Remove a health change event listener.
   */
  offHealthChange(listener: (domain: string, health: DomainHealthScore) => void): void {
    const idx = this.eventListeners.indexOf(listener);
    if (idx >= 0) this.eventListeners.splice(idx, 1);
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

  private getOrCreate(domain: string): DomainHealthData {
    let data = this.domains.get(domain);
    if (!data) {
      if (this.domains.size >= MAX_DOMAINS) {
        const firstKey = this.domains.keys().next().value;
        if (firstKey) this.domains.delete(firstKey);
      }
      data = {
        recentResponses: [],
        scoreHistory: [],
        isPaused: false,
        firstSeenAt: Date.now(),
      };
      this.domains.set(domain, data);
    }
    return data;
  }
}

// Singleton
export const domainHealth = new DomainHealthMonitor();
