/**
 * Session Manager - Cross-Task Session Reuse
 *
 * Manages browser-like sessions for scraping tasks, enabling:
 *   - Session reuse across multiple requests to the same domain
 *   - Fingerprint consistency (same UA + cookies per session)
 *   - Automatic session recycling after max usage
 *   - Session blocking after CAPTCHA or 403 errors
 *   - Per-domain session pools (up to 3 concurrent sessions per domain)
 */

import { logger } from './logger';
const log = logger.child('SessionManager');

import type { SessionData, SessionFingerprint } from './types';
import { cookieJar } from './cookie-jar';
import { getProfileForDomain, type FingerprintProfile } from './stealth';

// ==================== Internal Session Record ====================

interface InternalSession extends SessionData {
  /** ISO timestamp of creation */
  createdAt: string;
  /** ISO timestamp of last use */
  lastUsedAt: string;
  /** Whether this session is blocked (e.g., after CAPTCHA) */
  blocked: boolean;
  /** Reason for blocking */
  blockedReason?: string;
  /** Task IDs that used this session */
  taskIds: string[];
}

// ==================== SessionManager ====================

interface SessionHealth {
  /** Number of successful requests in this session */
  successCount: number;
  /** Number of failed/detected requests in this session */
  failCount: number;
  /** Number of CAPTCHA detections in this session */
  captchaCount: number;
  /** Number of 403/429 responses in this session */
  blockCount: number;
  /** Success rate (0-1), computed on demand */
  successRate: number;
  /** Last health check timestamp */
  lastHealthCheck: number;
}

class SessionManager {
  private sessions: Map<string, InternalSession> = new Map();       // sessionId -> session
  private domainSessions: Map<string, string[]> = new Map();       // domain -> sessionIds
  private maxSessionsPerDomain: number = 3;
  private maxSessionAge: number = 24 * 60 * 60 * 1000;            // 24 hours
  private maxSessionUsage: number = 50;                              // recycle after 50 uses
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private sessionCounter: number = 0; // Monotonic counter for unique session IDs

  // Session health tracking
  private sessionHealth: Map<string, SessionHealth> = new Map();
  // Session rotation: rotate after N requests even if not blocked
  private sessionRotationAfter: number = 30;
  // Warm-up tracking: domains that have been warmed up
  private warmedUpDomains: Set<string> = new Set();

  constructor() {
    // Auto-cleanup every 30 minutes
    this.cleanupInterval = setInterval(() => {
      try {
        const cleaned = this.cleanup();
        if (cleaned > 0) {
          log.info(` Cleaned up ${cleaned} expired/stale sessions`);
        }
      } catch (err) {
        console.error('[SessionManager] Cleanup error:', err);
      }
    }, 30 * 60 * 1000).unref();
  }

  /**
   * Create or get an existing non-blocked session for a domain.
   * If a usable session exists, returns the one with lowest usageCount.
   * Otherwise creates a new session.
   */
  acquireSession(domain: string, taskId?: string): SessionData {
    const normalizedDomain = domain.toLowerCase().replace(/^www\./, '');
    // Try to find an existing non-blocked session for this domain
    const sessionIds = this.domainSessions.get(normalizedDomain) || [];
    let bestSession: InternalSession | null = null;
    let bestUsage = Infinity;

    for (const sid of sessionIds) {
      const session = this.sessions.get(sid);
      if (!session) continue;
      if (session.blocked) continue;
      if (session.usageCount >= this.maxSessionUsage) continue;

      // Check session age
      const age = Date.now() - new Date(session.createdAt).getTime();
      if (age > this.maxSessionAge) continue;

      if (session.usageCount < bestUsage) {
        bestUsage = session.usageCount;
        bestSession = session;
      }
    }

    if (bestSession) {
      // Reuse existing session
      bestSession.usageCount++;
      bestSession.requestCount++;
      bestSession.lastUsedAt = new Date().toISOString();
      if (taskId && !bestSession.taskIds.includes(taskId)) {
        bestSession.taskIds.push(taskId);
        // Cap taskIds to last 20 entries to prevent unbounded growth
        if (bestSession.taskIds.length > 20) {
          bestSession.taskIds = bestSession.taskIds.slice(-20);
        }
      }
      return this.toPublicSession(bestSession);
    }

    // Enforce max sessions per domain: clean up stale/blocked sessions first
    const domainList = this.domainSessions.get(normalizedDomain) || [];
    if (domainList.length >= this.maxSessionsPerDomain) {
      // Try to evict a blocked or overused session to make room
      let evicted = false;
      for (let i = domainList.length - 1; i >= 0; i--) {
        const s = this.sessions.get(domainList[i]!);
        if (!s || s.blocked || s.usageCount >= this.maxSessionUsage) {
          if (s) this.sessions.delete(s.id);
          domainList.splice(i, 1);
          evicted = true;
          break;
        }
      }
      if (!evicted) {
        // All sessions are active and under limit — recycle the oldest one
        const oldestSid = domainList[0];
        if (oldestSid) {
          this.sessions.delete(oldestSid);
          domainList.shift();
        }
      }
    }

    // Create a new session (use monotonic counter to prevent same-millisecond collision)
    const sessionId = `sess_${normalizedDomain}_${Date.now()}_${++this.sessionCounter}`;
    let fingerprint: FingerprintProfile;
    let cookieHeader = '';
    try {
      fingerprint = getProfileForDomain(normalizedDomain);
    } catch {
      // Fallback: use a default profile if stealth module fails
      fingerprint = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36', screenWidth: 1920, screenHeight: 1080, colorDepth: 24, pixelDepth: 24, pixelRatio: 1, timezone: 'Asia/Shanghai', languages: ['zh-CN', 'en-US'], platform: 'Win32', hardwareConcurrency: 8, deviceMemory: 8, webglVendor: '', webglRenderer: '', timezoneOffset: -480, seed: 'fallback', audioNoiseSeed: 0, availWidth: 1920, availHeight: 1040, maxTouchPoints: 0, navigatorVendor: 'Google Inc.' };
    }
    try {
      cookieHeader = cookieJar.getCookieHeader(normalizedDomain, '/');
    } catch {
      // Cookie jar failure is non-fatal; proceed with empty cookies
      cookieHeader = '';
    }

    const sessionFingerprint: SessionFingerprint = {
      screenWidth: fingerprint.screenWidth ?? 1920,
      screenHeight: fingerprint.screenHeight ?? 1080,
      colorDepth: fingerprint.colorDepth ?? 24,
      pixelRatio: fingerprint.pixelRatio ?? 1,
      platform: fingerprint.platform ?? 'Win32',
      deviceMemory: fingerprint.deviceMemory ?? 8,
      hardwareConcurrency: fingerprint.hardwareConcurrency ?? 8,
      timezone: fingerprint.timezone ?? 'Asia/Shanghai',
      languages: fingerprint.languages ?? ['zh-CN', 'en-US'],
    };

    const session: InternalSession = {
      id: sessionId,
      userAgent: fingerprint.userAgent,
      cookies: cookieHeader ? this.parseCookieString(cookieHeader) : [],
      fingerprint: sessionFingerprint,
      usageCount: 1,
      requestCount: 1,
      maxUsage: this.maxSessionUsage,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      blocked: false,
      taskIds: taskId ? [taskId] : [],
    };

    this.sessions.set(sessionId, session);

    // Register in domain index
    const dl = this.domainSessions.get(normalizedDomain) || [];
    dl.push(sessionId);
    this.domainSessions.set(normalizedDomain, dl);

    if (process.env.DEBUG === 'true') {
      log.info(` Created new session ${sessionId} for ${normalizedDomain}`);
    }

    return this.toPublicSession(session);
  }

  /**
   * Release a session back to the pool (increment usageCount, update lastUsedAt).
   * Called when a request completes using this session.
   */
  releaseSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.lastUsedAt = new Date().toISOString();
  }

  /** Get session by ID */
  getSession(sessionId: string): SessionData | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    return this.toPublicSession(session);
  }

  /**
   * Record a health event for a session (success, failure, captcha, block).
   * This tracks session "health" to enable intelligent rotation decisions.
   */
  recordHealthEvent(sessionId: string, event: 'success' | 'fail' | 'captcha' | 'block'): void {
    let health = this.sessionHealth.get(sessionId);
    if (!health) {
      health = { successCount: 0, failCount: 0, captchaCount: 0, blockCount: 0, successRate: 1, lastHealthCheck: Date.now() };
      this.sessionHealth.set(sessionId, health);
    }
    switch (event) {
      case 'success': health.successCount++; break;
      case 'fail': health.failCount++; break;
      case 'captcha': health.captchaCount++; break;
      case 'block': health.blockCount++; break;
    }
    const total = health.successCount + health.failCount + health.captchaCount + health.blockCount;
    health.successRate = total > 0 ? health.successCount / total : 1;
    health.lastHealthCheck = Date.now();
  }

  /**
   * Get health stats for a session.
   */
  getSessionHealth(sessionId: string): SessionHealth | undefined {
    return this.sessionHealth.get(sessionId);
  }

  /**
   * Check if a session should be rotated based on health and usage.
   * Rotation triggers when:
   *   - Session success rate drops below 50%
   *   - Session has been blocked or captcha'd 3+ times
   *   - Session has exceeded rotation usage limit
   */
  shouldRotateSession(sessionId: string): { rotate: boolean; reason?: string } {
    const session = this.sessions.get(sessionId);
    if (!session) return { rotate: false };

    const health = this.sessionHealth.get(sessionId);
    if (health) {
      if (health.successRate < 0.5 && (health.failCount + health.blockCount) >= 3) {
        return { rotate: true, reason: `Low success rate: ${(health.successRate * 100).toFixed(1)}%` };
      }
      if (health.captchaCount >= 3) {
        return { rotate: true, reason: `Too many CAPTCHAs: ${health.captchaCount}` };
      }
      if (health.blockCount >= 3) {
        return { rotate: true, reason: `Too many blocks: ${health.blockCount}` };
      }
    }

    if (session.usageCount >= this.sessionRotationAfter) {
      return { rotate: true, reason: `Usage limit: ${session.usageCount}/${this.sessionRotationAfter}` };
    }

    return { rotate: false };
  }

  /**
   * Force-rotate a session for a domain: block the old session and create a new one.
   * Returns the new session data.
   */
  rotateSession(domain: string, reason?: string): SessionData {
    const normalizedDomain = domain.toLowerCase().replace(/^www\./, '');
    const sessionIds = this.domainSessions.get(normalizedDomain) || [];
    // Block all existing sessions for this domain
    for (const sid of sessionIds) {
      this.blockSession(sid, reason || 'Session rotation');
    }
    // Create a fresh session
    return this.acquireSession(normalizedDomain);
  }

  /**
   * Mark a domain as warmed up (homepage/category pages visited).
   */
  markDomainWarmedUp(domain: string): void {
    const normalized = domain.toLowerCase().replace(/^www\./, '');
    if (this.warmedUpDomains.size < 500) {
      this.warmedUpDomains.add(normalized);
    }
  }

  /**
   * Check if a domain has already been warmed up.
   */
  isDomainWarmedUp(domain: string): boolean {
    const normalized = domain.toLowerCase().replace(/^www\./, '');
    return this.warmedUpDomains.has(normalized);
  }

  /** Get all sessions for a domain */
  getDomainSessions(domain: string): SessionData[] {
    const normalizedDomain = domain.toLowerCase().replace(/^www\./, '');
    const sessionIds = this.domainSessions.get(normalizedDomain) || [];
    return sessionIds
      .map(sid => this.sessions.get(sid))
      .filter((s): s is InternalSession => !!s)
      .map(s => this.toPublicSession(s));
  }

  /**
   * Block a session (e.g., after CAPTCHA or 403).
   * Blocked sessions are skipped in acquireSession().
   */
  blockSession(sessionId: string, reason?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.blocked = true;
    session.blockedReason = reason || 'Blocked by session manager';

    if (process.env.DEBUG === 'true') {
      log.info(` Blocked session ${sessionId}: ${session.blockedReason}`);
    }
  }

  /**
   * Get or create a session with fingerprint consistency.
   * This is the main method engines call. Returns sessionId, userAgent,
   * and a cookie header string ready to use in a request.
   */
  getSessionForRequest(domain: string): { sessionId: string; userAgent: string; cookies: string } | null {
    const normalizedDomain = domain.toLowerCase().replace(/^www\./, '');
    const session = this.acquireSession(normalizedDomain);

    // Build cookie header string from session cookies
    const cookieStr = session.cookies
      .map(c => `${c.name}=${c.value}`)
      .join('; ');

    // Also merge any fresh cookies from the cookie jar (deduplicated by name)
    let freshCookies = '';
    try {
      freshCookies = cookieJar.getCookieHeader(normalizedDomain, '/');
    } catch {
      // Cookie jar failure is non-fatal; proceed with session cookies only
    }
    let mergedCookies = cookieStr;
    if (freshCookies) {
      const cookieMap = new Map<string, string>();
      // Fresh cookies take precedence — add them first
      for (const part of freshCookies.split(';')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          cookieMap.set(trimmed.slice(0, eqIdx).trim(), trimmed.slice(eqIdx + 1));
        }
      }
      // Then add session cookies (only if name not already present)
      for (const c of session.cookies) {
        if (!cookieMap.has(c.name)) {
          cookieMap.set(c.name, c.value);
        }
      }
      mergedCookies = Array.from(cookieMap.entries())
        .map(([name, value]) => `${name}=${value}`)
        .join('; ');
    }

    return {
      sessionId: session.id,
      userAgent: session.userAgent,
      cookies: mergedCookies,
    };
  }

  /**
   * Cleanup expired/blocked/overused sessions.
   * Returns count of cleaned sessions.
   */
  cleanup(): number {
    let cleaned = 0;
    const now = Date.now();

    for (const [sessionId, session] of this.sessions.entries()) {
      const age = now - new Date(session.createdAt).getTime();
      const isExpired = age > this.maxSessionAge;
      const isOverused = session.usageCount >= this.maxSessionUsage;
      const isStaleBlocked = session.blocked && (now - new Date(session.lastUsedAt).getTime() > 30 * 60 * 1000);

      if (isExpired || isOverused || isStaleBlocked) {
        this.sessions.delete(sessionId);
        this.sessionHealth.delete(sessionId);

        // Remove from domain index
        for (const [domain, sids] of this.domainSessions.entries()) {
          const idx = sids.indexOf(sessionId);
          if (idx !== -1) {
            sids.splice(idx, 1);
            if (sids.length === 0) {
              this.domainSessions.delete(domain);
            }
            break; // Each sessionId belongs to at most one domain (R49#31)
          }
        }

        cleaned++;
      }
    }

    // Clean up stale warm-up tracking (domains not accessed in 1 hour)
    // This is lightweight since it's just a Set
    if (this.warmedUpDomains.size > 200) {
      // Periodically trim to avoid unbounded growth
      // Keep only domains that still have active sessions
      const activeDomains = new Set(this.domainSessions.keys());
      for (const d of this.warmedUpDomains) {
        if (!activeDomains.has(d)) {
          this.warmedUpDomains.delete(d);
        }
      }
    }

    return cleaned;
  }

  /** Get session manager statistics */
  getStats(): {
    totalSessions: number;
    activeSessions: number;
    blockedSessions: number;
    staleBlockedSessions: number;
    domainsTracked: number;
  } {
    let blocked = 0;
    let active = 0;
    let staleBlocked = 0;
    const now = Date.now();

    for (const session of this.sessions.values()) {
      if (session.blocked) {
        blocked++;
        if (now - new Date(session.lastUsedAt).getTime() > 30 * 60 * 1000) {
          staleBlocked++;
        }
      } else {
        active++;
      }
    }

    return {
      totalSessions: this.sessions.size,
      activeSessions: active,
      blockedSessions: blocked,
      staleBlockedSessions: staleBlocked,
      domainsTracked: this.domainSessions.size,
    };
  }

  /** Get all sessions (for API) */
  getAllSessions(): SessionData[] {
    return Array.from(this.sessions.values()).map(s => this.toPublicSession(s));
  }

  // ==================== Private Helpers ====================

  private toPublicSession(session: InternalSession): SessionData {
    return {
      id: session.id,
      userAgent: session.userAgent,
      cookies: session.cookies,
      fingerprint: session.fingerprint,
      proxy: session.proxy,
      usageCount: session.usageCount,
      requestCount: session.requestCount,
      maxUsage: session.maxUsage,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      blocked: session.blocked,
    };
  }

  /** Parse "name=value; name2=value2" into cookie objects */
  private parseCookieString(cookieStr: string): Array<{ name: string; value: string; domain?: string }> {
    if (!cookieStr) return [];
    return cookieStr.split(';').map(part => {
      const trimmed = part.trim();
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx <= 0) return { name: trimmed, value: '' };
      return {
        name: trimmed.substring(0, eqIdx).trim(),
        value: trimmed.substring(eqIdx + 1).trim(),
      };
    }).filter(c => c.name);
  }

  /** Stop the cleanup interval (for graceful shutdown) */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

// Singleton export
export const sessionManager = new SessionManager();
