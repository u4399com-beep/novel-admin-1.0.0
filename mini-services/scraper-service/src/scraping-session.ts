/**
 * Scraping Session Management with Cookie Jar Integration
 *
 * Manages complete scraping sessions for a domain, providing:
 *   - Consistent browser fingerprint for the entire session
 *   - Cookie jar integration (persisted to SQLite) — cookies from previous
 *     visits are sent in new requests
 *   - Navigation history tracking for realistic referrer chains
 *   - Warm-up sequence: homepage → category page → target page
 *   - Session rotation: after N requests or M minutes, rotate to a new session
 *   - Session sharing: concurrent tasks on same domain share the same session
 *   - Bounded: max 500 concurrent sessions, LRU eviction
 */

import { logger } from './logger';
const log = logger.child('ScrapingSession');

import { cookieJar } from './cookie-jar';
import { getProfileForDomain, type FingerprintProfile } from './stealth';
import { referrerChain, generateWarmUpSequence } from './referrer-chain';
import type { SessionData, SessionFingerprint } from './types';
import Database from 'bun:sqlite';
import { resolve } from 'path';

// ==================== Types ====================

export interface ScrapingSession {
  id: string;
  domain: string;
  fingerprint: FingerprintProfile;
  userAgent: string;
  /** Cookie header string built from cookie jar */
  cookieHeader: string;
  /** Navigation history for this session (URLs visited in order) */
  navigationHistory: string[];
  /** Session creation timestamp */
  createdAt: number;
  /** Last activity timestamp */
  lastActivityAt: number;
  /** Total requests made in this session */
  requestCount: number;
  /** Whether warm-up sequence has been completed */
  warmedUp: boolean;
  /** Whether this session is blocked (captcha/403) */
  blocked: boolean;
  blockedReason?: string;
  /** Referrer for next request (derived from navigation history) */
  currentReferrer?: string;
}

export interface SessionRotationConfig {
  /** Rotate after this many requests (default: 30) */
  maxRequests: number;
  /** Rotate after this many minutes (default: 10) */
  maxMinutes: number;
  /** Maximum concurrent sessions per domain (default: 2) */
  maxPerDomain: number;
  /** Maximum total sessions across all domains (default: 500) */
  maxTotal: number;
}

export interface SessionStats {
  totalSessions: number;
  activeSessions: number;
  blockedSessions: number;
  domainsTracked: number;
  totalRequests: number;
  sessionsByDomain: Record<string, number>;
}

// ==================== Constants ====================

const DEFAULT_ROTATION_CONFIG: SessionRotationConfig = {
  maxRequests: 30,
  maxMinutes: 10,
  maxPerDomain: 2,
  maxTotal: 500,
};

const SESSION_DB_PATH = resolve(import.meta.dir, '../../../db/scraping-sessions.db');

// ==================== SQLite Persistence ====================

class SessionPersistence {
  private db: Database;

  constructor(dbPath?: string) {
    this.db = new Database(dbPath || SESSION_DB_PATH, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scraping_sessions (
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        user_agent TEXT NOT NULL,
        request_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        warmed_up INTEGER NOT NULL DEFAULT 0,
        blocked INTEGER NOT NULL DEFAULT 0,
        blocked_reason TEXT,
        navigation_history TEXT NOT NULL DEFAULT '[]',
        fingerprint TEXT NOT NULL DEFAULT '{}',
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ss_domain ON scraping_sessions(domain);
      CREATE INDEX IF NOT EXISTS idx_ss_expires ON scraping_sessions(expires_at);
    `);
  }

  save(session: ScrapingSession): void {
    const expiresAt = session.createdAt + DEFAULT_ROTATION_CONFIG.maxMinutes * 60 * 1000;
    const stmt = this.db.prepare(`
      INSERT INTO scraping_sessions (id, domain, user_agent, request_count, created_at, last_activity_at, warmed_up, blocked, blocked_reason, navigation_history, fingerprint, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        request_count = excluded.request_count,
        last_activity_at = excluded.last_activity_at,
        warmed_up = excluded.warmed_up,
        blocked = excluded.blocked,
        blocked_reason = excluded.blocked_reason,
        navigation_history = excluded.navigation_history,
        expires_at = excluded.expires_at
    `);
    try {
      stmt.run(
        session.id,
        session.domain,
        session.userAgent,
        session.requestCount,
        session.createdAt,
        session.lastActivityAt,
        session.warmedUp ? 1 : 0,
        session.blocked ? 1 : 0,
        session.blockedReason || null,
        JSON.stringify(session.navigationHistory.slice(-20)), // Keep last 20
        JSON.stringify({
          seed: session.fingerprint.seed,
          screenWidth: session.fingerprint.screenWidth,
          screenHeight: session.fingerprint.screenHeight,
          timezone: session.fingerprint.timezone,
        }),
        expiresAt,
      );
    } catch {
      // Persistence failure is non-fatal
    }
  }

  delete(sessionId: string): void {
    try {
      this.db.prepare('DELETE FROM scraping_sessions WHERE id = ?').run(sessionId);
    } catch {}
  }

  deleteByDomain(domain: string): number {
    try {
      const result = this.db.prepare('DELETE FROM scraping_sessions WHERE domain = ?').run(domain);
      return result.changes;
    } catch { return 0; }
  }

  deleteExpired(): number {
    try {
      const now = Date.now();
      const result = this.db.prepare('DELETE FROM scraping_sessions WHERE expires_at < ?').run(now);
      return result.changes;
    } catch { return 0; }
  }

  getActiveSessions(domain: string): Array<{ id: string; requestCount: number; createdAt: number }> {
    try {
      const rows = this.db.prepare(
        'SELECT id, request_count, created_at FROM scraping_sessions WHERE domain = ? AND blocked = 0 AND expires_at > ?'
      ).all(domain, Date.now()) as Array<{ id: string; user_agent: string; cookies: string; proxy: string | null; fingerprint: string | null; request_count: number; max_usage: number; created_at: string; last_used_at: string; blocked: number }>;  
      return rows.map(r => ({ id: r.id, requestCount: r.request_count, createdAt: r.created_at }));
    } catch { return []; }
  }

  getStats(): { totalSessions: number; totalRequests: number } {
    try {
      const row = this.db.prepare(
        'SELECT COUNT(*) as total, SUM(request_count) as total_reqs FROM scraping_sessions WHERE expires_at > ?'
      ).get(Date.now()) as { id: string; user_agent: string; cookies: string; proxy: string | null; fingerprint: string | null; request_count: number; max_usage: number; created_at: string; last_used_at: string; blocked: number } | undefined;  
      return { totalSessions: row?.total || 0, totalRequests: row?.total_reqs || 0 };
    } catch { return { totalSessions: 0, totalRequests: 0 }; }
  }

  close(): void {
    try { this.db.close(); } catch {}
  }
}

// ==================== ScrapingSessionManager ====================

class ScrapingSessionManager {
  private sessions: Map<string, ScrapingSession> = new Map();  // sessionId -> session
  private domainIndex: Map<string, Set<string>> = new Map();    // domain -> sessionIds
  private config: SessionRotationConfig;
  private persistence: SessionPersistence;
  private sessionCounter = 0;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config?: Partial<SessionRotationConfig>) {
    this.config = { ...DEFAULT_ROTATION_CONFIG, ...config };
    this.persistence = new SessionPersistence();

    // Cleanup expired sessions every 2 minutes
    this.cleanupInterval = setInterval(() => {
      try { this.cleanup(); } catch {}
    }, 2 * 60 * 1000).unref();
  }

  /**
   * Get or create a scraping session for a domain.
   * If an active, non-blocked session exists that hasn't exceeded rotation
   * limits, reuse it. Otherwise create a new one.
   *
   * Session sharing: concurrent tasks on same domain share the same session
   * until rotation triggers.
   */
  getOrCreateSession(domain: string): ScrapingSession {
    const normalized = domain.toLowerCase().replace(/^www\./, '');

    // Try to find a reusable session for this domain
    const sessionIds = this.domainIndex.get(normalized);
    if (sessionIds) {
      for (const sid of sessionIds) {
        const session = this.sessions.get(sid);
        if (!session || session.blocked) continue;

        // Check rotation limits
        const ageMinutes = (Date.now() - session.createdAt) / 60_000;
        if (session.requestCount >= this.config.maxRequests) continue;
        if (ageMinutes >= this.config.maxMinutes) continue;

        // Reusable — refresh cookie header from jar (may have new cookies)
        session.cookieHeader = cookieJar.getCookieHeader(normalized, '/');
        session.lastActivityAt = Date.now();
        return session;
      }
    }

    // Need a new session — enforce limits
    this.evictIfNeeded(normalized);

    // Create new session
    const sessionId = `scrapesess_${normalized}_${Date.now()}_${++this.sessionCounter}`;
    let fingerprint: FingerprintProfile;
    try {
      fingerprint = getProfileForDomain(normalized);
    } catch {
      fingerprint = this.defaultFingerprint();
    }

    const cookieHeader = cookieJar.getCookieHeader(normalized, '/');

    const session: ScrapingSession = {
      id: sessionId,
      domain: normalized,
      fingerprint,
      userAgent: fingerprint.userAgent,
      cookieHeader,
      navigationHistory: [],
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      requestCount: 0,
      warmedUp: false,
      blocked: false,
    };

    this.sessions.set(sessionId, session);

    // Add to domain index
    let domainSet = this.domainIndex.get(normalized);
    if (!domainSet) {
      domainSet = new Set();
      this.domainIndex.set(normalized, domainSet);
    }
    domainSet.add(sessionId);

    // Persist
    this.persistence.save(session);

    log.info(`Created new scraping session ${sessionId.slice(0, 30)}... for ${normalized}`);
    return session;
  }

  /**
   * Rotate session for a domain: block the old sessions and create a new one.
   * Called when rotation limits are exceeded or when a block is detected.
   */
  rotateSession(domain: string, reason?: string): ScrapingSession {
    const normalized = domain.toLowerCase().replace(/^www\./, '');
    const sessionIds = this.domainIndex.get(normalized);

    // Block all existing sessions for this domain
    if (sessionIds) {
      for (const sid of sessionIds) {
        const session = this.sessions.get(sid);
        if (session && !session.blocked) {
          session.blocked = true;
          session.blockedReason = reason || 'Session rotation';
          this.persistence.save(session);
        }
      }
    }

    log.info(`Rotating session for ${normalized}: ${reason || 'manual rotation'}`);
    return this.getOrCreateSession(normalized);
  }

  /**
   * Record a request in the session and update navigation history.
   * Returns the session (possibly rotated if limits exceeded).
   */
  recordRequest(sessionId: string, url: string, statusCode?: number): ScrapingSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    session.requestCount++;
    session.lastActivityAt = Date.now();

    // Record in navigation history
    session.navigationHistory.push(url);
    if (session.navigationHistory.length > 50) {
      session.navigationHistory = session.navigationHistory.slice(-50);
    }

    // Also record in global referrer chain
    referrerChain.recordVisit(url);

    // Update current referrer from navigation history
    if (session.navigationHistory.length >= 2) {
      session.currentReferrer = session.navigationHistory[session.navigationHistory.length - 2];
    }

    // Refresh cookies from jar
    session.cookieHeader = cookieJar.getCookieHeader(session.domain, '/');

    // Check if rotation is needed
    const ageMinutes = (Date.now() - session.createdAt) / 60_000;
    if (session.requestCount >= this.config.maxRequests || ageMinutes >= this.config.maxMinutes) {
      // Mark for rotation — next getOrCreateSession will create new
      session.blocked = true;
      session.blockedReason = `Rotation: ${session.requestCount} requests or ${ageMinutes.toFixed(1)} min`;
      this.persistence.save(session);
      return session;
    }

    // Record block/captcha events
    if (statusCode === 403 || statusCode === 429) {
      session.blocked = true;
      session.blockedReason = `HTTP ${statusCode}`;
      this.persistence.save(session);
      return session;
    }

    this.persistence.save(session);
    return session;
  }

  /**
   * Execute warm-up sequence for a session's domain.
   * Records homepage → category visits in navigation history
   * to build a realistic referrer chain.
   * Returns the warm-up URLs that should be visited (the caller
   * may optionally fetch them, or just record them in history).
   */
  warmUpSession(sessionId: string, targetUrl: string): string[] {
    const session = this.sessions.get(sessionId);
    if (!session || session.warmedUp) return [];

    const sequence = generateWarmUpSequence(targetUrl);

    // Record warm-up URLs in navigation history (even without fetching,
    // this creates realistic referrer chains)
    for (const url of sequence.warmUpUrls) {
      session.navigationHistory.push(url);
      referrerChain.recordVisit(url);
    }

    session.warmedUp = true;
    if (session.navigationHistory.length > 0) {
      session.currentReferrer = session.navigationHistory[session.navigationHistory.length - 1];
    }

    this.persistence.save(session);
    log.info(`Warmed up session ${sessionId.slice(0, 30)}... with ${sequence.warmUpUrls.length} URLs`);
    return sequence.warmUpUrls;
  }

  /**
   * Get session statistics across all domains.
   */
  getSessionStats(): SessionStats {
    let activeSessions = 0;
    let blockedSessions = 0;
    let totalRequests = 0;
    const sessionsByDomain: Record<string, number> = {};

    for (const session of this.sessions.values()) {
      if (session.blocked) {
        blockedSessions++;
      } else {
        activeSessions++;
      }
      totalRequests += session.requestCount;
      sessionsByDomain[session.domain] = (sessionsByDomain[session.domain] || 0) + 1;
    }

    return {
      totalSessions: this.sessions.size,
      activeSessions,
      blockedSessions,
      domainsTracked: this.domainIndex.size,
      totalRequests,
      sessionsByDomain,
    };
  }

  /**
   * Get all active (non-blocked) sessions, optionally filtered by domain.
   */
  getActiveSessions(domain?: string): ScrapingSession[] {
    const result: ScrapingSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.blocked) continue;
      if (domain && session.domain !== domain.toLowerCase().replace(/^www\./, '')) continue;
      result.push(session);
    }
    return result;
  }

  /**
   * Block a session (e.g., after CAPTCHA detection).
   */
  blockSession(sessionId: string, reason: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.blocked = true;
    session.blockedReason = reason;
    this.persistence.save(session);
  }

  /** Get a specific session by ID */
  getSession(sessionId: string): ScrapingSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get the referrer for the next request in a session.
   */
  getReferrer(sessionId: string): string | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    // First try the session's own navigation history
    if (session.currentReferrer) return session.currentReferrer;

    // Fall back to global referrer chain
    const lastUrl = session.navigationHistory[session.navigationHistory.length - 1];
    if (lastUrl) {
      return referrerChain.getReferer(lastUrl);
    }

    return undefined;
  }

  // ==================== Private Helpers ====================

  private evictIfNeeded(domain: string): void {
    // Enforce per-domain limit
    const domainSet = this.domainIndex.get(domain);
    if (domainSet && domainSet.size >= this.config.maxPerDomain) {
      // Remove oldest/blocked sessions first
      for (const sid of domainSet) {
        const session = this.sessions.get(sid);
        if (session && (session.blocked || session.requestCount >= this.config.maxRequests)) {
          this.removeSession(sid);
          break;
        }
      }
      // If still at limit, remove the oldest
      if (domainSet.size >= this.config.maxPerDomain) {
        let oldestId: string | null = null;
        let oldestTime = Infinity;
        for (const sid of domainSet) {
          const session = this.sessions.get(sid);
          if (session && session.createdAt < oldestTime) {
            oldestTime = session.createdAt;
            oldestId = sid;
          }
        }
        if (oldestId) this.removeSession(oldestId);
      }
    }

    // Enforce total session limit
    if (this.sessions.size >= this.config.maxTotal) {
      // Find and remove the least recently active session
      let lraId: string | null = null;
      let lraTime = Infinity;
      for (const [sid, session] of this.sessions) {
        if (session.lastActivityAt < lraTime) {
          lraTime = session.lastActivityAt;
          lraId = sid;
        }
      }
      if (lraId) this.removeSession(lraId);
    }
  }

  private removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      const domainSet = this.domainIndex.get(session.domain);
      if (domainSet) {
        domainSet.delete(sessionId);
        if (domainSet.size === 0) this.domainIndex.delete(session.domain);
      }
    }
    this.sessions.delete(sessionId);
    this.persistence.delete(sessionId);
  }

  private cleanup(): number {
    let cleaned = 0;
    const now = Date.now();
    const maxAge = this.config.maxMinutes * 60 * 1000;

    for (const [sid, session] of this.sessions) {
      const age = now - session.lastActivityAt;
      const isExpired = age > maxAge * 2; // Double the rotation time
      const isOldBlocked = session.blocked && age > 30 * 60 * 1000; // 30 min for blocked

      if (isExpired || isOldBlocked) {
        this.removeSession(sid);
        cleaned++;
      }
    }

    // Also clean up persistence
    this.persistence.deleteExpired();

    return cleaned;
  }

  private defaultFingerprint(): FingerprintProfile {
    return {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      screenWidth: 1920, screenHeight: 1080, colorDepth: 24, pixelDepth: 24,
      pixelRatio: 1, timezone: 'Asia/Shanghai', languages: ['zh-CN', 'en-US'],
      platform: 'Win32', hardwareConcurrency: 8, deviceMemory: 8,
      webglVendor: '', webglRenderer: '', timezoneOffset: -480,
      seed: 'fallback', audioNoiseSeed: 0, availWidth: 1920, availHeight: 1040,
      maxTouchPoints: 0, navigatorVendor: 'Google Inc.',
    };
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    // Save all active sessions before shutdown
    for (const session of this.sessions.values()) {
      this.persistence.save(session);
    }
    this.persistence.close();
  }
}

// ==================== Singleton + Exports ====================

export const scrapingSessionMgr = new ScrapingSessionManager();

export function getOrCreateSession(domain: string): ScrapingSession {
  return scrapingSessionMgr.getOrCreateSession(domain);
}

export function rotateSession(domain: string, reason?: string): ScrapingSession {
  return scrapingSessionMgr.rotateSession(domain, reason);
}

export function getSessionStats(): SessionStats {
  return scrapingSessionMgr.getSessionStats();
}
