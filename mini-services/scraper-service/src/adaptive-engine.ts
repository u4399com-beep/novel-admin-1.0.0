/**
 * Adaptive Engine Selection
 *
 * Tracks per-domain engine performance (success rate, response time, CAPTCHA rate)
 * and selects the best engine for each request.
 *
 * Selection logic:
 *   1. If domain has recent CAPTCHA → use obscura (stealthiest)
 *   2. If domain needs JS rendering → use playwright
 *   3. If domain is simple HTML → use cheerio (fastest)
 *   4. If current engine has <80% success rate → try next in fallback chain
 *
 * Learned preferences are persisted to engine-preferences.json.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import type { EngineType } from './types';
import { isLowContentDomain, recordLowContentHint } from './engine-config';
import { logger } from './logger';

const log = logger.child('AdaptiveEngine');

// ==================== Types ====================

interface EnginePerformanceStats {
  /** Total requests attempted with this engine */
  totalRequests: number;
  /** Successful requests */
  successes: number;
  /** Requests that triggered CAPTCHA */
  captchaCount: number;
  /** Rolling sum of response times (ms) */
  totalResponseTime: number;
  /** Last timestamp this engine was used */
  lastUsedAt: number;
  /** Timestamps of CAPTCHA detections (for rate calculation) */
  captchaTimestamps: number[];
}

interface DomainEngineProfile {
  /** Per-engine performance stats */
  engines: Record<string, EnginePerformanceStats>;
  /** Currently preferred engine for this domain */
  preferredEngine?: EngineType;
  /** Engines to avoid for this domain */
  avoidEngines: Set<string>;
  /** Whether domain needs JS rendering */
  needsJsRendering: boolean;
  /** Last updated timestamp */
  updatedAt: number;
}

// ==================== Constants ====================

const SUCCESS_RATE_THRESHOLD = 0.80; // <80% success → try fallback
const CAPTCHA_RATE_THRESHOLD = 0.10; // >10% CAPTCHA rate → upgrade
const CAPTCHA_WINDOW_MS = 60 * 60 * 1000; // 1-hour window for CAPTCHA rate
const MAX_DOMAINS = 500;
const PERSIST_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const STATS_DECAY_MS = 30 * 60 * 1000; // 30-minute decay for old stats

/** Engine ordering by stealth capability (lowest → highest) */
const ENGINE_STEALTH_ORDER: EngineType[] = ['cheerio', 'playwright', 'obscura'];

/** Fallback chain: each engine falls back to the next if failing */
const ENGINE_FALLBACK: Record<string, EngineType | undefined> = {
  cheerio: 'playwright',
  playwright: 'obscura',
  obscura: undefined, // highest internal engine
};

// ==================== AdaptiveEngineSelector ====================

export class AdaptiveEngineSelector {
  private domainProfiles: Map<string, DomainEngineProfile> = new Map();
  private persistPath: string;
  private persistTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.persistPath = resolve(import.meta.dir, 'scrape-rules/engine-preferences.json');
    this.loadPersistedPreferences();
    this.persistTimer = setInterval(() => this.persistPreferences(), PERSIST_INTERVAL_MS).unref();
  }

  /**
   * Select the best engine for a domain + URL based on performance history.
   *
   * @param domain - Target domain
   * @param url - Target URL (for context)
   * @param antiCrawlConfig - Anti-crawl configuration (may specify engine hints)
   * @param currentEngine - Currently selected engine (will be returned if performing well)
   * @returns The recommended engine type
   */
  selectEngine(
    domain: string,
    url: string,
    antiCrawlConfig?: Record<string, unknown>,
    currentEngine?: EngineType,
  ): EngineType {
    const normalized = domain.toLowerCase().replace(/^www\./, '');
    const profile = this.domainProfiles.get(normalized);
    const now = Date.now();

    // 1. If domain has a cached preferred engine and it's recent, use it
    if (profile?.preferredEngine && (now - profile.updatedAt) < STATS_DECAY_MS) {
      const pref = profile.preferredEngine;
      // But check if the preferred engine is still performing well
      const stats = profile.engines[pref];
      if (stats && stats.totalRequests > 5) {
        const successRate = stats.successes / stats.totalRequests;
        if (successRate >= SUCCESS_RATE_THRESHOLD) {
          return pref;
        }
        // Preferred engine degraded — clear it and re-evaluate
        log.info(`Preferred engine ${pref} degraded for ${normalized} (success: ${(successRate * 100).toFixed(1)}%), re-evaluating`, undefined, normalized);
        profile.preferredEngine = undefined;
      } else if (stats && stats.totalRequests <= 5) {
        // Not enough data — trust the preference
        return pref;
      }
    }

    // 2. If domain has recent CAPTCHA → use obscura (stealthiest)
    if (profile) {
      const recentCaptcha = this.getRecentCaptchaRate(normalized);
      if (recentCaptcha.rate > CAPTCHA_RATE_THRESHOLD) {
        log.info(`Domain ${normalized} has high CAPTCHA rate (${(recentCaptcha.rate * 100).toFixed(1)}%), selecting obscura`, undefined, normalized);
        if (profile) profile.preferredEngine = 'obscura';
        return 'obscura';
      }
    }

    // 3. If domain needs JS rendering → use playwright
    if (isLowContentDomain(normalized) || (profile?.needsJsRendering)) {
      log.debug(`Domain ${normalized} needs JS rendering, selecting playwright`, undefined, normalized);
      if (profile) profile.preferredEngine = 'playwright';
      return 'playwright';
    }

    // 4. If current engine has <80% success rate → try next in fallback chain
    if (currentEngine && profile) {
      const stats = profile.engines[currentEngine];
      if (stats && stats.totalRequests >= 5) {
        const successRate = stats.successes / stats.totalRequests;
        if (successRate < SUCCESS_RATE_THRESHOLD) {
          const fallback = ENGINE_FALLBACK[currentEngine];
          if (fallback) {
            log.info(`Engine ${currentEngine} has low success rate (${(successRate * 100).toFixed(1)}%) for ${normalized}, falling back to ${fallback}`, undefined, normalized);
            return fallback;
          }
        }
        // Current engine is performing well — stick with it
        return currentEngine;
      }
    }

    // 5. Default: find the best performing engine for this domain
    if (profile) {
      const bestEngine = this.findBestPerformingEngine(profile);
      if (bestEngine) {
        profile.preferredEngine = bestEngine;
        return bestEngine;
      }
    }

    // 6. No profile or no good data — return current engine or cheerio
    return currentEngine || 'cheerio';
  }

  /**
   * Record the result of using an engine for a domain.
   * This feeds the performance tracking system.
   *
   * @param domain - Target domain
   * @param engine - Engine that was used
   * @param success - Whether the request succeeded
   * @param responseTime - Response time in ms
   * @param hadCaptcha - Whether CAPTCHA was detected
   */
  recordEngineResult(
    domain: string,
    engine: string,
    success: boolean,
    responseTime: number,
    hadCaptcha: boolean = false,
  ): void {
    const normalized = domain.toLowerCase().replace(/^www\./, '');
    const now = Date.now();

    let profile = this.domainProfiles.get(normalized);
    if (!profile) {
      // Evict if at capacity
      if (this.domainProfiles.size >= MAX_DOMAINS) {
        this.evictOldest();
      }
      profile = {
        engines: {},
        avoidEngines: new Set(),
        needsJsRendering: false,
        updatedAt: now,
      };
      this.domainProfiles.set(normalized, profile);
    }

    let stats = profile.engines[engine];
    if (!stats) {
      stats = {
        totalRequests: 0,
        successes: 0,
        captchaCount: 0,
        totalResponseTime: 0,
        lastUsedAt: 0,
        captchaTimestamps: [],
      };
      profile.engines[engine] = stats;
    }

    stats.totalRequests++;
    if (success) stats.successes++;
    if (hadCaptcha) {
      stats.captchaCount++;
      stats.captchaTimestamps.push(now);
      // Clean old timestamps
      const windowStart = now - CAPTCHA_WINDOW_MS;
      stats.captchaTimestamps = stats.captchaTimestamps.filter(t => t >= windowStart);
    }
    stats.totalResponseTime += responseTime;
    stats.lastUsedAt = now;
    profile.updatedAt = now;

    // Auto-detect JS rendering need: if cheerio returns very low success rate
    if (engine === 'cheerio' && stats.totalRequests >= 5) {
      const successRate = stats.successes / stats.totalRequests;
      if (successRate < 0.5 && !profile.needsJsRendering) {
        profile.needsJsRendering = true;
        recordLowContentHint(normalized, 100); // Flag as low-content
        log.info(`Domain ${normalized} auto-detected as needing JS rendering (cheerio success: ${(successRate * 100).toFixed(1)}%)`, undefined, normalized);
      }
    }

    // Update preferred engine based on performance
    this.updatePreferredEngine(normalized, profile);
  }

  /**
   * Get the recent CAPTCHA rate for a domain across all engines.
   */
  getRecentCaptchaRate(domain: string): { rate: number; count: number; windowMs: number } {
    const normalized = domain.toLowerCase().replace(/^www\./, '');
    const profile = this.domainProfiles.get(normalized);
    if (!profile) return { rate: 0, count: 0, windowMs: CAPTCHA_WINDOW_MS };

    const now = Date.now();
    const windowStart = now - CAPTCHA_WINDOW_MS;
    let totalCaptchas = 0;
    let totalRequests = 0;

    for (const stats of Object.values(profile.engines)) {
      totalRequests += stats.totalRequests;
      totalCaptchas += stats.captchaTimestamps.filter(t => t >= windowStart).length;
    }

    return {
      rate: totalRequests > 0 ? totalCaptchas / totalRequests : 0,
      count: totalCaptchas,
      windowMs: CAPTCHA_WINDOW_MS,
    };
  }

  /**
   * Get performance stats for a domain (for monitoring).
   */
  getDomainStats(domain: string): Record<string, {
    successRate: number;
    avgResponseTime: number;
    captchaRate: number;
    totalRequests: number;
  }> | null {
    const normalized = domain.toLowerCase().replace(/^www\./, '');
    const profile = this.domainProfiles.get(normalized);
    if (!profile) return null;

    const result: Record<string, {
      successRate: number;
      avgResponseTime: number;
      captchaRate: number;
      totalRequests: number;
    }> = {};

    for (const [engine, stats] of Object.entries(profile.engines)) {
      result[engine] = {
        successRate: stats.totalRequests > 0 ? stats.successes / stats.totalRequests : 0,
        avgResponseTime: stats.totalRequests > 0 ? Math.round(stats.totalResponseTime / stats.totalRequests) : 0,
        captchaRate: stats.totalRequests > 0 ? stats.captchaCount / stats.totalRequests : 0,
        totalRequests: stats.totalRequests,
      };
    }

    return result;
  }

  /**
   * Get all domain profiles (for monitoring/debugging).
   */
  getAllProfiles(): Map<string, DomainEngineProfile> {
    return this.domainProfiles;
  }

  /** Stop periodic persistence and save final state */
  destroy(): void {
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }
    this.persistPreferences();
  }

  // ---- Private helpers ----

  private findBestPerformingEngine(profile: DomainEngineProfile): EngineType | null {
    let bestEngine: EngineType | null = null;
    let bestScore = -Infinity;

    for (const engine of ENGINE_STEALTH_ORDER) {
      if (profile.avoidEngines.has(engine)) continue;

      const stats = profile.engines[engine];
      if (!stats || stats.totalRequests < 3) continue;

      const successRate = stats.successes / stats.totalRequests;
      const avgResponseTime = stats.totalResponseTime / stats.totalRequests;
      const captchaRate = stats.captchaCount / stats.totalRequests;

      // Score: higher success rate and lower response time are better
      // CAPTCHA rate is heavily penalized
      const score = (successRate * 60) - (captchaRate * 40) - (avgResponseTime / 1000 * 2);

      if (score > bestScore) {
        bestScore = score;
        bestEngine = engine;
      }
    }

    return bestEngine;
  }

  private updatePreferredEngine(domain: string, profile: DomainEngineProfile): void {
    const best = this.findBestPerformingEngine(profile);
    if (best && best !== profile.preferredEngine) {
      log.debug(`Updating preferred engine for ${domain}: ${profile.preferredEngine || 'none'} → ${best}`, undefined, domain);
      profile.preferredEngine = best;
    }
  }

  private evictOldest(): void {
    let oldestKey = '';
    let oldestTime = Infinity;
    for (const [key, profile] of this.domainProfiles) {
      if (profile.updatedAt < oldestTime) {
        oldestTime = profile.updatedAt;
        oldestKey = key;
      }
    }
    if (oldestKey) this.domainProfiles.delete(oldestKey);
  }

  // ---- Persistence ----

  private persistPreferences(): void {
    try {
      const data: Record<string, {
        preferred?: string;
        avoid?: string[];
        needsJs?: boolean;
        engines?: Record<string, { successRate: number; avgResponseTime: number; captchaRate: number; totalRequests: number }>;
      }> = {};

      for (const [domain, profile] of this.domainProfiles) {
        const entry: typeof data[string] = {
          preferred: profile.preferredEngine,
          avoid: Array.from(profile.avoidEngines),
          needsJs: profile.needsJsRendering,
        };

        // Include engine stats summary
        const engines: Record<string, { successRate: number; avgResponseTime: number; captchaRate: number; totalRequests: number }> = {};
        for (const [engine, stats] of Object.entries(profile.engines)) {
          engines[engine] = {
            successRate: stats.totalRequests > 0 ? stats.successes / stats.totalRequests : 0,
            avgResponseTime: stats.totalRequests > 0 ? Math.round(stats.totalResponseTime / stats.totalRequests) : 0,
            captchaRate: stats.totalRequests > 0 ? stats.captchaCount / stats.totalRequests : 0,
            totalRequests: stats.totalRequests,
          };
        }
        entry.engines = engines;
        data[domain] = entry;
      }

      // Merge with existing file (don't overwrite other keys)
      let existing: Record<string, unknown> = {};
      try {
        if (existsSync(this.persistPath)) {
          existing = JSON.parse(readFileSync(this.persistPath, 'utf-8'));
        }
      } catch { /* ignore */ }

      const merged = { ...existing, ...data };
      writeFileSync(this.persistPath, JSON.stringify(merged, null, 2));
    } catch (err) {
      log.error(`Failed to persist engine preferences: ${err instanceof Error ? err.message : err}`);
    }
  }

  private loadPersistedPreferences(): void {
    try {
      if (!existsSync(this.persistPath)) return;
      const data = JSON.parse(readFileSync(this.persistPath, 'utf-8'));
      if (!data || typeof data !== 'object') return;

      const now = Date.now();

      for (const [domain, entry] of Object.entries(data) as [string, any][]) {
        if (this.domainProfiles.size >= MAX_DOMAINS) break;
        if (!entry || typeof entry !== 'object') continue;

        // Only load domains with preference data
        if (!entry.preferred && !entry.needsJs) continue;

        // Validate preferred engine type
        const validEngines = new Set(['cheerio', 'playwright', 'firecrawl', 'agentql', 'cloud-browser', 'scrapling', 'obscura', 'dokobot', 'api']);
        if (entry.preferred && !validEngines.has(entry.preferred)) {
          continue; // Skip entries with invalid engine types
        }

        const profile: DomainEngineProfile = {
          engines: {},
          preferredEngine: entry.preferred as EngineType | undefined,
          avoidEngines: new Set(Array.isArray(entry.avoid) ? entry.avoid : []),
          needsJsRendering: !!entry.needsJs,
          updatedAt: now,
        };

        // Restore engine stats if available
        if (entry.engines && typeof entry.engines === 'object') {
          for (const [engine, stats] of Object.entries(entry.engines) as [string, any][]) {
            if (!stats || typeof stats !== 'object') continue;
            // Validate engine stats to prevent corrupted data
            const totalReqs = Math.max(0, Math.floor(Number(stats.totalRequests) || 0));
            const successRate = Math.max(0, Math.min(1, Number(stats.successRate) || 0));
            const captchaRate = Math.max(0, Math.min(1, Number(stats.captchaRate) || 0));
            const avgRespTime = Math.max(0, Number(stats.avgResponseTime) || 0);
            profile.engines[engine] = {
              totalRequests: totalReqs,
              successes: Math.round(successRate * totalReqs),
              captchaCount: Math.round(captchaRate * totalReqs),
              totalResponseTime: avgRespTime * totalReqs,
              lastUsedAt: now,
              captchaTimestamps: [],
            };
          }
        }

        this.domainProfiles.set(domain, profile);
      }

      log.info(`Loaded ${this.domainProfiles.size} domain engine preferences from disk`);
    } catch (err) {
      log.error(`Failed to load engine preferences: ${err instanceof Error ? err.message : err}`);
    }
  }
}

// Singleton
export const adaptiveEngineSelector = new AdaptiveEngineSelector();
