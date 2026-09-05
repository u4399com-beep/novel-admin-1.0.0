/**
 * Anti-Crawl Bypass Registry
 *
 * Tracks which bypass techniques work for which domains.
 * When a new anti-crawl challenge is detected, known bypasses are tried first.
 * Persists to bypass-registry.json for cross-restart survival.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { logger } from './logger';

const log = logger.child('BypassRegistry');

// ==================== Types ====================

export type BypassMethod =
  | 'tls-rotate'
  | 'ua-rotate'
  | 'proxy-rotate'
  | 'engine-upgrade'
  | 'delay-increase'
  | 'cookie-refresh'
  | 'session-rotate';

export type ChallengeType =
  | 'captcha'
  | 'rate-limit'
  | 'ip-block'
  | 'fingerprint-detect'
  | 'js-challenge'
  | 'cloudflare'
  | 'geetest'
  | 'unknown';

export interface BypassEntry {
  domain: string;
  challengeType: ChallengeType;
  bypassMethod: BypassMethod;
  /** Success rate 0-1 */
  successRate: number;
  /** Number of times this bypass was attempted */
  attemptCount: number;
  /** Number of times this bypass succeeded */
  successCount: number;
  /** Timestamp of last use */
  lastUsed: number;
  /** Timestamp of last success */
  lastSuccess?: number;
}

export interface BypassRegistryData {
  entries: BypassEntry[];
  version: number;
  lastSaved: number;
}

// ==================== Constants ====================

const REGISTRY_VERSION = 1;
const MAX_ENTRIES = 5000;
const PERSIST_PATH = resolve(import.meta.dir, 'scrape-rules', 'bypass-registry.json');
const PERSIST_DEBOUNCE_MS = 10_000;

/** Ordered bypass methods to try when a challenge is detected */
const CHALLENGE_BYPASS_ORDER: Record<ChallengeType, BypassMethod[]> = {
  captcha: ['engine-upgrade', 'session-rotate', 'proxy-rotate', 'cookie-refresh', 'delay-increase'],
  'rate-limit': ['delay-increase', 'proxy-rotate', 'session-rotate', 'ua-rotate'],
  'ip-block': ['proxy-rotate', 'delay-increase', 'session-rotate'],
  'fingerprint-detect': ['tls-rotate', 'ua-rotate', 'session-rotate', 'engine-upgrade'],
  'js-challenge': ['engine-upgrade', 'cookie-refresh', 'session-rotate', 'delay-increase'],
  cloudflare: ['engine-upgrade', 'session-rotate', 'cookie-refresh', 'tls-rotate', 'proxy-rotate'],
  geetest: ['engine-upgrade', 'delay-increase', 'session-rotate', 'proxy-rotate'],
  unknown: ['delay-increase', 'proxy-rotate', 'session-rotate', 'ua-rotate', 'engine-upgrade'],
};

// ==================== BypassRegistry ====================

class BypassRegistry {
  private entries: Map<string, BypassEntry> = new Map();
  private dirty = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.load();
  }

  private entryKey(domain: string, challengeType: ChallengeType, bypassMethod: BypassMethod): string {
    return `${domain}::${challengeType}::${bypassMethod}`;
  }

  // ---- Public API ----

  /**
   * Record a bypass attempt (success or failure).
   */
  recordBypass(
    domain: string,
    challengeType: ChallengeType,
    bypassMethod: BypassMethod,
    success: boolean
  ): void {
    const key = this.entryKey(domain, challengeType, bypassMethod);
    const now = Date.now();
    let entry = this.entries.get(key);

    if (!entry) {
      // Evict if at capacity
      if (this.entries.size >= MAX_ENTRIES) {
        this.evictOldest();
      }
      entry = {
        domain,
        challengeType,
        bypassMethod,
        successRate: 0,
        attemptCount: 0,
        successCount: 0,
        lastUsed: now,
      };
      this.entries.set(key, entry);
    }

    entry.attemptCount++;
    entry.lastUsed = now;
    if (success) {
      entry.successCount++;
      entry.lastSuccess = now;
    }
    // Recalculate success rate
    entry.successRate = entry.successCount / entry.attemptCount;

    this.dirty = true;
    this.schedulePersist();

    log.debug(`Recorded bypass ${bypassMethod} for ${domain}/${challengeType}: ${success ? 'SUCCESS' : 'FAIL'}`, {
      successRate: entry.successRate.toFixed(2),
      attempts: entry.attemptCount,
    }, domain);
  }

  /**
   * Get the best bypass method for a domain + challenge type.
   * Considers known success rates first, then falls back to the default order.
   */
  getBestBypass(domain: string, challengeType: ChallengeType): BypassMethod {
    // Find all entries for this domain + challenge type
    const relevantEntries: BypassEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.domain === domain && entry.challengeType === challengeType && entry.attemptCount >= 2) {
        relevantEntries.push(entry);
      }
    }

    // If we have proven bypasses, pick the best one
    if (relevantEntries.length > 0) {
      // Sort by: successRate (desc), then attemptCount (desc, more data = more reliable)
      relevantEntries.sort((a, b) => {
        // Heavily weight success rate, but also consider sample size
        const scoreA = a.successRate * Math.min(1, a.attemptCount / 10);
        const scoreB = b.successRate * Math.min(1, b.attemptCount / 10);
        return scoreB - scoreA;
      });

      // Only use if the best entry has >30% success rate
      if (relevantEntries[0].successRate > 0.3) {
        return relevantEntries[0].bypassMethod;
      }
    }

    // Fall back to default order for this challenge type
    const defaultOrder = CHALLENGE_BYPASS_ORDER[challengeType] || CHALLENGE_BYPASS_ORDER.unknown;

    // Try to find one we haven't tried (or haven't tried recently)
    for (const method of defaultOrder) {
      const key = this.entryKey(domain, challengeType, method);
      const entry = this.entries.get(key);
      if (!entry || entry.successRate > 0.2) {
        return method;
      }
    }

    // Last resort: return first default
    return defaultOrder[0];
  }

  /**
   * Get all bypass entries for a domain.
   */
  getBypassesForDomain(domain: string): BypassEntry[] {
    const results: BypassEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.domain === domain) {
        results.push(entry);
      }
    }
    return results.sort((a, b) => b.successRate - a.successRate);
  }

  /**
   * Get bypass statistics (for monitoring/debugging).
   */
  getStats(): {
    totalEntries: number;
    byChallengeType: Record<string, number>;
    topBypasses: BypassEntry[];
  } {
    const byChallengeType: Record<string, number> = {};
    const allEntries = Array.from(this.entries.values());

    for (const entry of allEntries) {
      byChallengeType[entry.challengeType] = (byChallengeType[entry.challengeType] || 0) + 1;
    }

    // Top 10 most successful bypasses
    const topBypasses = allEntries
      .filter(e => e.attemptCount >= 3)
      .sort((a, b) => b.successRate - a.successRate)
      .slice(0, 10);

    return {
      totalEntries: allEntries.length,
      byChallengeType,
      topBypasses,
    };
  }

  // ---- Persistence ----

  /**
   * Load registry from disk.
   */
  load(): void {
    try {
      if (!existsSync(PERSIST_PATH)) return;
      const raw = readFileSync(PERSIST_PATH, 'utf-8');
      const data: BypassRegistryData = JSON.parse(raw);

      if (data.version !== REGISTRY_VERSION) {
        log.warn('Bypass registry version mismatch, starting fresh');
        return;
      }

      for (const entry of data.entries) {
        const key = this.entryKey(entry.domain, entry.challengeType, entry.bypassMethod);
        this.entries.set(key, entry);
      }

      log.info(`Loaded ${this.entries.size} bypass registry entries`);
    } catch (err) {
      log.warn(`Failed to load bypass registry: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Persist registry to disk (debounced).
   */
  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persist();
      this.persistTimer = null;
    }, PERSIST_DEBOUNCE_MS);
    if (this.persistTimer.unref) {
      this.persistTimer.unref();
    }
  }

  /**
   * Force-persist to disk (for graceful shutdown).
   */
  persist(): void {
    if (!this.dirty) return;
    try {
      const data: BypassRegistryData = {
        entries: Array.from(this.entries.values()),
        version: REGISTRY_VERSION,
        lastSaved: Date.now(),
      };
      writeFileSync(PERSIST_PATH, JSON.stringify(data, null, 2), 'utf-8');
      this.dirty = false;
    } catch (err) {
      log.error(`Failed to persist bypass registry: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ---- Eviction ----

  private evictOldest(): void {
    let oldestKey = '';
    let oldestTime = Infinity;
    for (const [key, entry] of this.entries.entries()) {
      if (entry.lastUsed < oldestTime) {
        oldestTime = entry.lastUsed;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      this.entries.delete(oldestKey);
    }
  }
}

// Singleton
export const bypassRegistry = new BypassRegistry();
