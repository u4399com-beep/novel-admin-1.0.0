/**
 * Cookie Jar - Persistent cookie management across requests
 *
 * Provides domain-scoped cookie storage with:
 *   - Store/retrieve cookies per domain
 *   - Cookie header construction for outgoing requests
 *   - Playwright-compatible cookie format
 *   - Export/import for backup
 *   - Automatic expired cookie cleanup
 */

// ==================== Types ====================

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  expires: number; // Unix timestamp, 0 = session
  createdAt: number;
}

// ==================== CookieJar ====================

class CookieJar {
  private cookies: Map<string, StoredCookie[]> = new Map(); // domain -> cookies
  private lastActivity: Map<string, number> = new Map(); // domain -> last access timestamp

  /** Parse a Set-Cookie header value into a StoredCookie */
  private parseSetCookie(header: string, domain: string): StoredCookie | null {
    const parts = header.split(';').map(s => s.trim());
    if (parts.length === 0) return null;

    const nv = parts[0];
    const eqIdx = nv.indexOf('=');
    if (eqIdx <= 0) return null;

    const name = nv.substring(0, eqIdx).trim();
    const value = nv.substring(eqIdx + 1).trim();
    if (!name) return null;

    // Strip control characters to prevent header injection
    const safeName = name.replace(/[\r\n\t\x00-\x1f]/g, '');
    const safeValue = value.replace(/[\r\n\t\x00-\x1f]/g, '');
    if (!safeName) return null;

    let cookieDomain = domain;
    let cookiePath = '/';
    let httpOnly = false;
    let secure = false;
    let expires = 0; // 0 = session cookie

    for (let i = 1; i < parts.length; i++) {
      const attr = parts[i].toLowerCase();
      if (attr.startsWith('domain=')) {
        const raw = parts[i].substring(7).trim().replace(/^\./, '');
        if (raw) cookieDomain = raw;
      } else if (attr.startsWith('path=')) {
        const raw = parts[i].substring(5).trim();
        if (raw) cookiePath = raw;
      } else if (attr === 'httponly') {
        httpOnly = true;
      } else if (attr === 'secure') {
        secure = true;
      } else if (attr.startsWith('expires=')) {
        const dateStr = parts[i].substring(8).trim();
        const parsed = Date.parse(dateStr);
        if (!isNaN(parsed)) expires = Math.floor(parsed / 1000);
      } else if (attr.startsWith('max-age=')) {
        const maxAge = parseInt(parts[i].substring(8).trim(), 10);
        if (!isNaN(maxAge) && maxAge > 0) {
          expires = Math.floor(Date.now() / 1000) + maxAge;
        } else if (!isNaN(maxAge) && maxAge <= 0) {
          // Max-Age=0 or negative means delete
          return null;
        }
      }
    }

    return {
      name: safeName,
      value: safeValue,
      domain: cookieDomain,
      path: cookiePath,
      httpOnly,
      secure,
      expires,
      createdAt: Math.floor(Date.now() / 1000),
    };
  }

  /** Check if a cookie matches the given domain and path */
  private isCookieMatch(cookie: StoredCookie, domain: string, path: string): boolean {
    // Domain matching: cookie domain must be a suffix of the request domain
    // e.g., cookie for ".example.com" matches "www.example.com"
    const cookieDomain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
    const requestDomain = domain.toLowerCase();
    const cdLower = cookieDomain.toLowerCase();

    if (requestDomain !== cdLower && !requestDomain.endsWith('.' + cdLower)) {
      return false;
    }

    // Path matching: cookie path must be a prefix of the request path
    const cookiePath = cookie.path || '/';
    if (path !== cookiePath && !path.startsWith(cookiePath.endsWith('/') ? cookiePath : cookiePath + '/')) {
      // Special case: if cookie path is exactly '/', it matches everything
      if (cookiePath !== '/') return false;
    }

    // Check expiration
    if (cookie.expires > 0 && cookie.expires < Math.floor(Date.now() / 1000)) {
      return false;
    }

    return true;
  }

  /** Store cookies from set-cookie headers for a domain */
  store(domain: string, setCookieHeaders: string[]): void {
    if (!setCookieHeaders.length) return;

    if (!this.cookies.has(domain)) {
      this.cookies.set(domain, []);
    }
    const list = this.cookies.get(domain)!;

    for (const header of setCookieHeaders) {
      const cookie = this.parseSetCookie(header, domain);
      if (!cookie) {
        // Could be a deletion cookie (Max-Age=0) - remove existing
        const eqIdx = header.indexOf('=');
        if (eqIdx > 0) {
          const delName = header.substring(0, eqIdx).trim().replace(/[\r\n\t\x00-\x1f]/g, '');
          const idx = list.findIndex(c => c.name === delName && c.domain === domain);
          if (idx >= 0) list.splice(idx, 1);
        }
        continue;
      }

      // Update existing cookie with same name+domain+path, or add new
      const existingIdx = list.findIndex(
        c => c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path
      );
      if (existingIdx >= 0) {
        list[existingIdx] = cookie;
      } else {
        list.push(cookie);
      }
    }

    this.lastActivity.set(domain, Date.now());
  }

  /** Get cookies for a domain and path (for sending with request) */
  get(domain: string, path: string = '/'): Array<{ name: string; value: string }> {
    const allCookies = this.getAllCookies();
    const matched = allCookies.filter(c => this.isCookieMatch(c, domain, path));
    this.lastActivity.set(domain, Date.now());
    return matched.map(c => ({ name: c.name, value: c.value }));
  }

  /** Get cookies in Playwright format for a domain */
  getPlaywrightCookies(domain: string): Array<{ name: string; value: string; domain: string; path: string }> {
    const allCookies = this.getAllCookies();
    const matched = allCookies.filter(c => this.isCookieMatch(c, domain, '/'));
    this.lastActivity.set(domain, Date.now());
    return matched.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain.startsWith('.') ? c.domain : '.' + c.domain,
      path: c.path,
    }));
  }

  /** Get cookies as a Cookie header string */
  getCookieHeader(domain: string, path: string = '/'): string {
    const matched = this.get(domain, path);
    return matched
      .filter(c => c.name && c.value)
      .map(c => `${c.name}=${c.value}`)
      .join('; ');
  }

  /** Clear cookies for a specific domain */
  clear(domain: string): void {
    this.cookies.delete(domain);
    this.lastActivity.delete(domain);
  }

  /** Clear all cookies */
  clearAll(): void {
    this.cookies.clear();
    this.lastActivity.clear();
  }

  /** Get all stored cookie counts per domain */
  getStats(): Array<{ domain: string; count: number; lastActivity: number }> {
    const result: Array<{ domain: string; count: number; lastActivity: number }> = [];
    for (const [domain, list] of this.cookies) {
      // Filter out expired cookies for accurate count
      const now = Math.floor(Date.now() / 1000);
      const validCookies = list.filter(c => c.expires === 0 || c.expires > now);
      if (validCookies.length > 0) {
        result.push({
          domain,
          count: validCookies.length,
          lastActivity: this.lastActivity.get(domain) || 0,
        });
      }
    }
    return result.sort((a, b) => b.lastActivity - a.lastActivity);
  }

  /** Export all cookies as JSON string */
  export(): string {
    const allCookies = this.getAllCookies();
    return JSON.stringify(allCookies);
  }

  /** Import cookies from JSON string */
  import(json: string): number {
    try {
      const parsed = JSON.parse(json);
      if (!Array.isArray(parsed)) return 0;

      let imported = 0;
      for (const item of parsed) {
        if (!item || typeof item !== 'object') continue;
        const cookie = item as StoredCookie;
        if (!cookie.name || !cookie.domain) continue;

        if (!this.cookies.has(cookie.domain)) {
          this.cookies.set(cookie.domain, []);
        }
        this.cookies.get(cookie.domain)!.push(cookie);
        imported++;
      }
      return imported;
    } catch {
      return 0;
    }
  }

  /** Cleanup expired cookies. Returns count of removed cookies. */
  cleanup(): number {
    const now = Math.floor(Date.now() / 1000);
    let removed = 0;

    for (const [domain, list] of this.cookies) {
      const before = list.length;
      const filtered = list.filter(c => c.expires === 0 || c.expires > now);
      this.cookies.set(domain, filtered);
      removed += before - filtered.length;

      if (filtered.length === 0) {
        this.cookies.delete(domain);
        this.lastActivity.delete(domain);
      }
    }

    return removed;
  }

  /** Get all cookies across all domains (for export/playwright) */
  private getAllCookies(): StoredCookie[] {
    const all: StoredCookie[] = [];
    for (const list of this.cookies.values()) {
      all.push(...list);
    }
    return all;
  }
}

// ==================== Singleton ====================

export const cookieJar = new CookieJar();

// Periodic cleanup every 5 minutes
setInterval(() => {
  const removed = cookieJar.cleanup();
  if (removed > 0) {
    if (process.env.DEBUG === 'true') {
      console.log(`[CookieJar] Cleaned up ${removed} expired cookies`);
    }
  }
}, 5 * 60 * 1000);
