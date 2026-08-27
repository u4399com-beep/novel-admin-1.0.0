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

import type { SessionData, SessionFingerprint } from './types';
import { cookieJar } from './cookie-jar';
import { getProfileForDomain } from './stealth';

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

class SessionManager {
  private sessions: Map<string, InternalSession> = new Map();       // sessionId -> session
  private domainSessions: Map<string, string[]> = new Map();       // domain -> sessionIds
  private maxSessionsPerDomain: number = 3;
  private maxSessionAge: number = 24 * 60 * 60 * 1000;            // 24 hours
  private maxSessionUsage: number = 50;                              // recycle after 50 uses
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private sessionCounter: number = 0; // Monotonic counter for unique session IDs

  constructor() {
    // Auto-cleanup every 30 minutes
    this.cleanupInterval = setInterval(() => {
      try {
        const cleaned = this.cleanup();
        if (cleaned > 0) {
          console.log(`[SessionManager] Cleaned up ${cleaned} expired/stale sessions`);
        }
      } catch (err) {
        console.error('[SessionManager] Cleanup error:', err);
      }
    }, 30 * 60 * 1000);
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
    let fingerprint;
    let cookieHeader = '';
    try {
      fingerprint = getProfileForDomain(normalizedDomain);
    } catch {
      // Fallback: use a default profile if stealth module fails
      fingerprint = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36', screenWidth: 1920, screenHeight: 1080, colorDepth: 24, pixelRatio: 1, timezone: 'Asia/Shanghai', languages: ['zh-CN', 'en-US'], platform: 'Win32', hardwareConcurrency: 8, deviceMemory: 8 } as any;
    }
    try {
      cookieHeader = cookieJar.getCookieHeader(normalizedDomain, '/');
    } catch {
      // Cookie jar failure is non-fatal; proceed with empty cookies
      cookieHeader = '';
    }

    const sessionFingerprint: SessionFingerprint = {
      screenWidth: (fingerprint as any).screenWidth ?? 1920,
      screenHeight: (fingerprint as any).screenHeight ?? 1080,
      colorDepth: (fingerprint as any).colorDepth ?? 24,
      pixelRatio: (fingerprint as any).pixelRatio ?? 1,
      platform: (fingerprint as any).platform ?? 'Win32',
      deviceMemory: (fingerprint as any).deviceMemory ?? 8,
      hardwareConcurrency: (fingerprint as any).hardwareConcurrency ?? 8,
      timezone: (fingerprint as any).timezone ?? 'Asia/Shanghai',
      languages: (fingerprint as any).languages ?? ['zh-CN', 'en-US'],
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
      console.log(`[SessionManager] Created new session ${sessionId} for ${normalizedDomain}`);
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
      console.log(`[SessionManager] Blocked session ${sessionId}: ${session.blockedReason}`);
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
    const freshCookies = cookieJar.getCookieHeader(normalizedDomain, '/');
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
