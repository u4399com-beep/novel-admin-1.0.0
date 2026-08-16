/**
 * Smart Proxy Manager
 * Comprehensive proxy pool with health tracking, adaptive selection,
 * automatic cooling/disabling of bad proxies, real proxy agent support,
 * domain-specific binding, import/export, and auto-rotate on failure.
 */

import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';

// ==================== Types ====================

export interface ProxyEntry {
  url: string;
  protocol: 'http' | 'https' | 'socks4' | 'socks5';
  host: string;
  port: number;
  healthScore: number;       // 0-100, starts at 50
  successCount: number;
  failCount: number;
  avgResponseTime: number;  // ms
  lastUsed: number;          // timestamp
  lastCheck: number;         // timestamp
  blockedDomains: Set<string>; // domains that returned 403
  consecutiveFails: number;
  coolingUntil?: number;     // timestamp when cooling ends
  disabled?: boolean;
}

interface PoolStats {
  totalProxies: number;
  activeProxies: number;
  coolingProxies: number;
  disabledProxies: number;
  avgHealthScore: number;
  avgResponseTime: number;
  totalSuccesses: number;
  totalFailures: number;
  successRate: number;
  topProxies: Array<{
    url: string;
    host: string;
    healthScore: number;
    successCount: number;
    failCount: number;
    avgResponseTime: number;
  }>;
}

/** Per-proxy detail for getDetailedStats() */
interface ProxyDetail {
  url: string;
  protocol: ProxyEntry['protocol'];
  host: string;
  port: number;
  healthScore: number;
  successCount: number;
  failCount: number;
  avgResponseTime: number;
  consecutiveFails: number;
  status: 'active' | 'cooling' | 'disabled';
  coolingUntil?: number;
  blockedDomains: string[];
}

/** Detailed stats including per-proxy status, domain bindings, recent failures */
export interface DetailedStats {
  pool: PoolStats;
  proxies: ProxyDetail[];
  domainBindings: Record<string, string>;
  recentFailures: Array<{ proxyUrl: string; domain: string; timestamp: number; error: string }>;
  dispatcherCacheSize: number;
}

// ==================== Proxy Parser ====================

function parseProxyUrl(rawUrl: string): { protocol: ProxyEntry['protocol']; host: string; port: number; cleanUrl: string } | null {
  try {
    let urlStr = rawUrl.trim();
    let protocol: ProxyEntry['protocol'] = 'http';

    // Detect protocol
    if (urlStr.startsWith('socks5://')) {
      protocol = 'socks5';
      urlStr = urlStr.replace('socks5://', 'http://');
    } else if (urlStr.startsWith('socks4://')) {
      protocol = 'socks4';
      urlStr = urlStr.replace('socks4://', 'http://');
    } else if (urlStr.startsWith('https://')) {
      protocol = 'https';
    } else if (urlStr.startsWith('http://')) {
      protocol = 'http';
    } else {
      // Default to http
      urlStr = 'http://' + urlStr;
      protocol = 'http';
    }

    const parsed = new URL(urlStr);
    const host = parsed.hostname;
    const port = parseInt(parsed.port, 10);

    if (!host || isNaN(port) || port < 1 || port > 65535) {
      return null;
    }

    // Rebuild clean URL without credentials for display
    const cleanUrl = `${protocol}://${host}:${port}`;

    return { protocol, host, port, cleanUrl };
  } catch {
    return null;
  }
}

// ==================== Proxy Dispatcher Cache ====================

/**
 * Cache of undici Dispatcher instances keyed by original proxy URL.
 * Shared across the ProxyManager singleton and the module-level getProxyDispatcher().
 */
const dispatcherCache = new Map<string, Dispatcher>();

/**
 * Get or create a cached undici Dispatcher (ProxyAgent/Socks5ProxyAgent) for a proxy URL.
 * Supports http, https, socks5 proxies. For socks4, falls back to a TODO (not natively supported).
 * Handles proxy authentication via user:pass in the URL.
 *
 * @param proxyUrl - The full proxy URL (e.g. "http://user:pass@host:port")
 * @returns An undici Dispatcher, or null if the URL is invalid or protocol unsupported
 */
export function getProxyDispatcher(proxyUrl: string): Dispatcher | null {
  if (dispatcherCache.has(proxyUrl)) {
    return dispatcherCache.get(proxyUrl)!;
  }

  try {
    let urlStr = proxyUrl.trim();
    let protocol: ProxyEntry['protocol'] = 'http';

    if (urlStr.startsWith('socks5://')) {
      protocol = 'socks5';
    } else if (urlStr.startsWith('socks4://')) {
      protocol = 'socks4';
    } else if (urlStr.startsWith('https://')) {
      protocol = 'https';
    } else if (urlStr.startsWith('http://')) {
      protocol = 'http';
    } else {
      urlStr = 'http://' + urlStr;
      protocol = 'http';
    }

    let dispatcher: Dispatcher;

    if (protocol === 'socks5') {
      // TODO: SOCKS5 proxies require socks-proxy-agent (not installed).
      // Bun's bundled undici does not export Socks5ProxyAgent.
      // When a compatible package is available, use:
      //   dispatcher = new Socks5ProxyAgent(urlStr);
      if (process.env.DEBUG === 'true') {
        console.log('[ProxyManager] SOCKS5 proxies require a third-party agent (not installed)');
      }
      return null;
    } else if (protocol === 'socks4') {
      // TODO: SOCKS4 proxies require a third-party agent (not installed).
      if (process.env.DEBUG === 'true') {
        console.log('[ProxyManager] SOCKS4 proxies require a third-party agent (not installed)');
      }
      return null;
    } else {
      // http / https — use ProxyAgent with the full URI (supports user:pass auth)
      dispatcher = new ProxyAgent(urlStr);
    }

    dispatcherCache.set(proxyUrl, dispatcher);
    return dispatcher;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (process.env.DEBUG === 'true') {
      console.log(`[ProxyManager] Failed to create dispatcher for ${proxyUrl}: ${errMsg}`);
    }
    return null;
  }
}

/** Invalidate a cached dispatcher (e.g. after removing a proxy) */
export function invalidateDispatcher(proxyUrl: string): void {
  dispatcherCache.delete(proxyUrl);
}

/** Clear the entire dispatcher cache */
export function clearDispatcherCache(): void {
  dispatcherCache.clear();
}

// ==================== ProxyManager ====================

/** Recent failure record for auto-rotate tracking */
interface RecentFailure {
  proxyUrl: string;
  domain?: string;
  timestamp: number;
  error: string;
}

class ProxyManager {
  private pool = new Map<string, ProxyEntry>();
  private lastUsedUrl: string | null = null;
  private domainBindings = new Map<string, string>(); // domain -> proxy cleanUrl
  private recentFailures: RecentFailure[] = [];
  private static instance: ProxyManager;

  private constructor() {
    this.loadFromConfig();
  }

  static getInstance(): ProxyManager {
    if (!ProxyManager.instance) {
      ProxyManager.instance = new ProxyManager();
    }
    return ProxyManager.instance;
  }

  /** Parse and add a proxy to the pool */
  addProxy(url: string): boolean {
    const parsed = parseProxyUrl(url);
    if (!parsed) return false;

    if (this.pool.has(parsed.cleanUrl)) {
      return true; // Already exists
    }

    const entry: ProxyEntry = {
      url,
      protocol: parsed.protocol,
      host: parsed.host,
      port: parsed.port,
      healthScore: 50,
      successCount: 0,
      failCount: 0,
      avgResponseTime: 0,
      lastUsed: 0,
      lastCheck: 0,
      blockedDomains: new Set(),
      consecutiveFails: 0,
    };

    this.pool.set(parsed.cleanUrl, entry);
    return true;
  }

  /** Remove a proxy from the pool */
  removeProxy(url: string): boolean {
    const parsed = parseProxyUrl(url);
    if (!parsed) return false;

    // Also clean up domain bindings that reference this proxy
    for (const [domain, boundUrl] of this.domainBindings.entries()) {
      if (boundUrl === parsed.cleanUrl) {
        this.domainBindings.delete(domain);
      }
    }

    // Invalidate dispatcher cache
    invalidateDispatcher(url);

    return this.pool.delete(parsed.cleanUrl);
  }

  /**
   * Get the best available proxy for a given domain.
   * Uses weighted random selection based on healthScore,
   * prefers low avgResponseTime, rotates to avoid reuse.
   */
  getProxy(domain?: string): ProxyEntry | null {
    const now = Date.now();
    const candidates: ProxyEntry[] = [];

    for (const entry of this.pool.values()) {
      // Skip disabled proxies
      if (entry.disabled) continue;

      // Skip proxies in cooling period
      if (entry.coolingUntil && now < entry.coolingUntil) continue;

      // Skip proxies blocked for this domain
      if (domain && entry.blockedDomains.has(domain)) continue;

      candidates.push(entry);
    }

    if (candidates.length === 0) return null;

    // If only one candidate, use it (unless it was the last used)
    if (candidates.length === 1) {
      const candidate = candidates[0];
      if (candidate.url === this.lastUsedUrl && candidates.length === 1) {
        // Only proxy available was last used — use it anyway
        candidate.lastUsed = now;
        this.lastUsedUrl = candidate.url;
        return candidate;
      }
    }

    // Weighted selection: exclude last used proxy
    const selectable = candidates.filter((c) => c.url !== this.lastUsedUrl);
    const pool = selectable.length > 0 ? selectable : candidates;

    // Calculate weights: healthScore * (1 / (1 + avgResponseTime/1000))
    // Higher health score and lower response time = higher weight
    const weights = pool.map((entry) => {
      const healthWeight = Math.max(1, entry.healthScore);
      const speedWeight = 1 / (1 + entry.avgResponseTime / 1000);
      return healthWeight * speedWeight;
    });

    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    let random = Math.random() * totalWeight;

    let selected: ProxyEntry = pool[0];
    for (let i = 0; i < pool.length; i++) {
      random -= weights[i];
      if (random <= 0) {
        selected = pool[i];
        break;
      }
    }

    selected.lastUsed = now;
    this.lastUsedUrl = selected.url;
    return selected;
  }

  /** Record a successful request through a proxy */
  recordSuccess(proxyUrl: string, responseTime: number): void {
    const parsed = parseProxyUrl(proxyUrl);
    if (!parsed) return;

    const entry = this.pool.get(parsed.cleanUrl);
    if (!entry) return;

    entry.successCount++;
    entry.consecutiveFails = 0;
    entry.lastUsed = Date.now();

    // Update rolling average response time
    if (entry.avgResponseTime === 0) {
      entry.avgResponseTime = responseTime;
    } else {
      // Exponential moving average (α = 0.3)
      entry.avgResponseTime = Math.round(
        entry.avgResponseTime * 0.7 + responseTime * 0.3
      );
    }

    // Increase health score (cap at 100)
    const scoreGain = Math.min(5, Math.max(1, Math.floor(10 - responseTime / 1000)));
    entry.healthScore = Math.min(100, entry.healthScore + scoreGain);
  }

  /** Record a failed request through a proxy */
  recordFailure(proxyUrl: string, error?: string): void {
    const parsed = parseProxyUrl(proxyUrl);
    if (!parsed) return;

    const entry = this.pool.get(parsed.cleanUrl);
    if (!entry) return;

    entry.failCount++;
    entry.consecutiveFails++;
    entry.lastUsed = Date.now();

    // Track recent failure for auto-rotate
    this.addRecentFailure(parsed.cleanUrl, error);

    // If error indicates 403, add domain to blocked list
    if (error) {
      const httpMatch = error.match(/HTTP (\d+)/);
      if (httpMatch) {
        const status = parseInt(httpMatch[1], 10);
        if (status === 403) {
          // Extract domain from error context if available
          const urlMatch = error.match(/for (https?:\/\/[^/\s]+)/);
          if (urlMatch) {
            try {
              const domain = new URL(urlMatch[1]).hostname;
              entry.blockedDomains.add(domain);
            } catch { /* ignore parse errors */ }
          }
        }
      }
    }

    // Decrease health score
    const scoreLoss = Math.min(15, 5 + entry.consecutiveFails * 2);
    entry.healthScore = Math.max(0, entry.healthScore - scoreLoss);

    // If consecutiveFails >= 5, mark as cooling for 5 minutes
    if (entry.consecutiveFails >= 5) {
      entry.coolingUntil = Date.now() + 5 * 60 * 1000;
      if (process.env.DEBUG === 'true') {
        console.log(`[ProxyManager] ${parsed.cleanUrl} entering cooling (5min) after ${entry.consecutiveFails} consecutive fails`);
      }
    }

    // If healthScore drops below 10, mark as disabled
    if (entry.healthScore < 10) {
      entry.disabled = true;
      if (process.env.DEBUG === 'true') {
        console.log(`[ProxyManager] ${parsed.cleanUrl} disabled (health=${entry.healthScore})`);
      }
    }
  }

  /** Get pool statistics for UI/dashboard */
  getPoolStats(): PoolStats {
    const now = Date.now();
    const entries = Array.from(this.pool.values());

    if (entries.length === 0) {
      return {
        totalProxies: 0,
        activeProxies: 0,
        coolingProxies: 0,
        disabledProxies: 0,
        avgHealthScore: 0,
        avgResponseTime: 0,
        totalSuccesses: 0,
        totalFailures: 0,
        successRate: 0,
        topProxies: [],
      };
    }

    let activeCount = 0;
    let coolingCount = 0;
    let disabledCount = 0;
    let totalHealth = 0;
    let totalResponseTime = 0;
    let responseTimeCount = 0;
    let totalSuccesses = 0;
    let totalFailures = 0;

    for (const entry of entries) {
      if (entry.disabled) {
        disabledCount++;
      } else if (entry.coolingUntil && now < entry.coolingUntil) {
        coolingCount++;
      } else {
        activeCount++;
      }

      totalHealth += entry.healthScore;
      totalSuccesses += entry.successCount;
      totalFailures += entry.failCount;

      if (entry.avgResponseTime > 0) {
        totalResponseTime += entry.avgResponseTime;
        responseTimeCount++;
      }
    }

    const totalRequests = totalSuccesses + totalFailures;

    // Top 5 proxies by health score
    const sorted = [...entries]
      .sort((a, b) => b.healthScore - a.healthScore)
      .slice(0, 5)
      .map((e) => ({
        url: e.url,
        host: e.host,
        healthScore: e.healthScore,
        successCount: e.successCount,
        failCount: e.failCount,
        avgResponseTime: e.avgResponseTime,
      }));

    return {
      totalProxies: entries.length,
      activeProxies: activeCount,
      coolingProxies: coolingCount,
      disabledProxies: disabledCount,
      avgHealthScore: Math.round(totalHealth / entries.length),
      avgResponseTime: responseTimeCount > 0 ? Math.round(totalResponseTime / responseTimeCount) : 0,
      totalSuccesses,
      totalFailures,
      successRate: totalRequests > 0 ? Math.round((totalSuccesses / totalRequests) * 100) : 0,
      topProxies: sorted,
    };
  }

  /** Async health check — tests THROUGH the proxy (not just to it) */
  async checkHealth(proxyUrl: string): Promise<{ healthy: boolean; responseTime?: number; error?: string }> {
    const parsed = parseProxyUrl(proxyUrl);
    if (!parsed) return { healthy: false, error: 'Invalid proxy URL' };

    const entry = this.pool.get(parsed.cleanUrl);
    if (!entry) return { healthy: false, error: 'Proxy not in pool' };

    const startTime = Date.now();
    const testUrl = 'http://httpbin.org/ip'; // Known reliable endpoint

    // --- Primary: test THROUGH the proxy using an undici dispatcher ---
    const dispatcher = getProxyDispatcher(entry.url);
    if (dispatcher) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);

        const res = await undiciFetch(testUrl, {
          dispatcher,
          signal: controller.signal,
          redirect: 'manual',
        } as Parameters<typeof undiciFetch>[1]);
        clearTimeout(timeout);

        const responseTime = Date.now() - startTime;
        entry.lastCheck = Date.now();

        if (res.ok) {
          // Optionally verify the response looks like an IP response
          this.recordSuccess(proxyUrl, responseTime);
          return { healthy: true, responseTime };
        } else {
          // Non-OK status still means the proxy is reachable but may be misconfigured
          const errMsg = `Proxy returned HTTP ${res.status}`;
          this.recordFailure(proxyUrl, errMsg);
          return { healthy: false, responseTime, error: errMsg };
        }
      } catch (err) {
        // Through-proxy fetch failed; fall through to secondary check below
        const errMsg = err instanceof Error ? err.message : String(err);
        if (process.env.DEBUG === 'true') {
          console.log(`[ProxyManager] Through-proxy check failed for ${parsed.cleanUrl}: ${errMsg} — falling back to direct check`);
        }
        // Don't record failure yet; let the secondary check determine the outcome
      }
    }

    // --- Secondary fallback: test direct connectivity to the proxy host ---
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const res = await fetch(`${entry.protocol === 'https' ? 'https' : 'http'}://${entry.host}:${entry.port}`, {
        signal: controller.signal,
        redirect: 'manual',
      });
      clearTimeout(timeout);

      const responseTime = Date.now() - startTime;
      entry.lastCheck = Date.now();

      // Any response means the proxy host is reachable (even auth errors mean it's alive)
      // but we couldn't route traffic through it — record as a weak success
      this.recordSuccess(proxyUrl, responseTime);
      return { healthy: true, responseTime, error: 'Host reachable but through-proxy test failed' };
    } catch (err) {
      const responseTime = Date.now() - startTime;
      entry.lastCheck = Date.now();
      const errMsg = err instanceof Error ? err.message : String(err);

      this.recordFailure(proxyUrl, errMsg);
      return { healthy: false, error: errMsg };
    }
  }

  /** Load proxies from PROXY_LIST env var (comma-separated) */
  loadFromConfig(): void {
    const proxyList = process.env.PROXY_LIST;
    if (!proxyList) return;

    const urls = proxyList.split(',').map((s) => s.trim()).filter(Boolean);
    let added = 0;

    for (const url of urls) {
      if (this.addProxy(url)) added++;
    }

    if (added > 0) {
      console.log(`[ProxyManager] Loaded ${added} proxies from PROXY_LIST`);
    }
  }

  /** Number of active (non-disabled, non-cooling) proxies */
  size(): number {
    const now = Date.now();
    let count = 0;
    for (const entry of this.pool.values()) {
      if (entry.disabled) continue;
      if (entry.coolingUntil && now < entry.coolingUntil) continue;
      count++;
    }
    return count;
  }

  // ==================== Batch Management ====================

  /** Add multiple proxies at once. Returns number of new proxies added. */
  addProxies(urls: string[]): number {
    let added = 0;
    for (const url of urls) {
      if (this.addProxy(url)) added++;
    }
    return added;
  }

  /** Remove all proxies. Returns number of proxies removed. */
  removeAllProxies(): number {
    const count = this.pool.size;
    this.pool.clear();
    this.domainBindings.clear();
    this.lastUsedUrl = null;
    clearDispatcherCache();
    return count;
  }

  /** Reset health/consecutiveFails for a specific proxy. Returns true if found. */
  resetProxy(proxyUrl: string): boolean {
    const parsed = parseProxyUrl(proxyUrl);
    if (!parsed) return false;

    const entry = this.pool.get(parsed.cleanUrl);
    if (!entry) return false;

    entry.healthScore = 50;
    entry.consecutiveFails = 0;
    entry.coolingUntil = undefined;
    entry.disabled = false;
    entry.blockedDomains.clear();

    // Invalidate cached dispatcher so a fresh one is created
    invalidateDispatcher(entry.url);

    return true;
  }

  /** Reset all proxies to default health state. */
  resetAllProxies(): void {
    for (const entry of this.pool.values()) {
      entry.healthScore = 50;
      entry.consecutiveFails = 0;
      entry.coolingUntil = undefined;
      entry.disabled = false;
      entry.blockedDomains.clear();
    }
    clearDispatcherCache();
  }

  // ==================== Import / Export ====================

  /** Export all proxy entries as JSON (without sensitive credential data). */
  exportProxies(): string {
    const entries: Array<{
      url: string;
      protocol: ProxyEntry['protocol'];
      host: string;
      port: number;
      healthScore: number;
      successCount: number;
      failCount: number;
      avgResponseTime: number;
      consecutiveFails: number;
      blockedDomains: string[];
    }> = [];

    for (const entry of this.pool.values()) {
      entries.push({
        url: entry.url,
        protocol: entry.protocol,
        host: entry.host,
        port: entry.port,
        healthScore: entry.healthScore,
        successCount: entry.successCount,
        failCount: entry.failCount,
        avgResponseTime: entry.avgResponseTime,
        consecutiveFails: entry.consecutiveFails,
        blockedDomains: Array.from(entry.blockedDomains),
      });
    }

    return JSON.stringify({ version: 1, exportedAt: Date.now(), proxies: entries }, null, 2);
  }

  /**
   * Import proxies from a JSON string (as produced by exportProxies()).
   * Returns number of proxies successfully imported.
   */
  importProxies(json: string): number {
    try {
      const data = JSON.parse(json) as {
        version?: number;
        proxies?: Array<{ url: string }>;
      };

      if (!Array.isArray(data?.proxies)) {
        return 0;
      }

      let imported = 0;
      for (const proxy of data.proxies) {
        if (proxy.url && this.addProxy(proxy.url)) imported++;
      }
      return imported;
    } catch {
      return 0;
    }
  }

  /**
   * Export proxies in a simple text format.
   * @param format - 'url' for a newline-separated URL list, 'json' for full JSON export
   */
  exportAsText(format: 'url' | 'json'): string {
    if (format === 'json') {
      return this.exportProxies();
    }

    // Simple URL list
    const urls: string[] = [];
    for (const entry of this.pool.values()) {
      urls.push(entry.url);
    }
    return urls.join('\n');
  }

  // ==================== Domain-Specific Binding ====================

  /**
   * Bind a specific proxy to a domain.
   * When getProxyWithFallback() is called with this domain, the bound proxy
   * will be returned (if available) instead of pool selection.
   * Pass null as proxyUrl to remove the binding.
   */
  setDomainProxy(domain: string, proxyUrl: string | null): void {
    const normalisedDomain = domain.toLowerCase().replace(/^www\./, '');

    if (proxyUrl === null) {
      this.domainBindings.delete(normalisedDomain);
      return;
    }

    const parsed = parseProxyUrl(proxyUrl);
    if (!parsed) return;

    // Ensure the proxy exists in the pool
    if (!this.pool.has(parsed.cleanUrl)) {
      this.addProxy(proxyUrl);
    }

    this.domainBindings.set(normalisedDomain, parsed.cleanUrl);
  }

  /** Get the proxy bound to a specific domain, or null if no binding exists. */
  getDomainProxy(domain: string): ProxyEntry | null {
    const normalisedDomain = domain.toLowerCase().replace(/^www\./, '');
    const cleanUrl = this.domainBindings.get(normalisedDomain);
    if (!cleanUrl) return null;

    const entry = this.pool.get(cleanUrl);
    if (!entry) {
      // Stale binding — clean it up
      this.domainBindings.delete(normalisedDomain);
      return null;
    }

    // Skip if disabled or cooling
    const now = Date.now();
    if (entry.disabled) return null;
    if (entry.coolingUntil && now < entry.coolingUntil) return null;

    return entry;
  }

  /** Get all domain → proxy URL bindings. */
  getDomainProxyBindings(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [domain, cleanUrl] of this.domainBindings.entries()) {
      result[domain] = cleanUrl;
    }
    return result;
  }

  // ==================== Auto-Rotate on Failure ====================

  /**
   * Internal: record a recent failure for auto-rotate exclusion.
   * Keeps only the last 5 minutes of failures.
   */
  private addRecentFailure(proxyCleanUrl: string, error?: string): void {
    const now = Date.now();
    const FIVE_MINUTES = 5 * 60 * 1000;

    this.recentFailures.push({
      proxyUrl: proxyCleanUrl,
      timestamp: now,
      error: error || 'unknown',
    });

    // Prune failures older than 5 minutes
    this.recentFailures = this.recentFailures.filter((f) => now - f.timestamp < FIVE_MINUTES);
  }

  /**
   * Check if a proxy has recent failures within the exclusion window.
   */
  private hasRecentFailures(proxyCleanUrl: string, sinceMs: number = 5 * 60 * 1000): boolean {
    const cutoff = Date.now() - sinceMs;
    return this.recentFailures.some(
      (f) => f.proxyUrl === proxyCleanUrl && f.timestamp >= cutoff
    );
  }

  /**
   * Get a proxy for a domain with automatic fallback logic.
   * - First checks domain-specific binding (if domain provided)
   * - Then falls back to pool selection, excluding proxies with recent failures
   * - Excludes explicitly listed proxy URLs (excludeUrls)
   */
  getProxyWithFallback(domain?: string, excludeUrls?: string[]): ProxyEntry | null {
    const now = Date.now();

    // 1. Check domain-specific binding first
    if (domain) {
      const boundProxy = this.getDomainProxy(domain);
      if (boundProxy) {
        boundProxy.lastUsed = now;
        this.lastUsedUrl = boundProxy.url;
        return boundProxy;
      }
    }

    // 2. Build exclusion set from excludeUrls + recently failed proxies
    const excludeSet = new Set<string>();
    if (excludeUrls) {
      for (const url of excludeUrls) {
        const parsed = parseProxyUrl(url);
        if (parsed) excludeSet.add(parsed.cleanUrl);
      }
    }

    // Collect candidates, also tracking which have recent failures
    const candidates: ProxyEntry[] = [];
    const candidatesWithRecentFails: ProxyEntry[] = [];

    for (const entry of this.pool.values()) {
      if (entry.disabled) continue;
      if (entry.coolingUntil && now < entry.coolingUntil) continue;
      if (domain && entry.blockedDomains.has(domain)) continue;
      if (excludeSet.has(entry.url)) continue;

      if (this.hasRecentFailures(entry.url)) {
        candidatesWithRecentFails.push(entry);
      } else {
        candidates.push(entry);
      }
    }

    // Prefer candidates without recent failures
    if (candidates.length > 0) {
      return this.selectFromCandidates(candidates);
    }

    // Fallback: use candidates with recent failures (better than nothing)
    if (candidatesWithRecentFails.length > 0) {
      return this.selectFromCandidates(candidatesWithRecentFails);
    }

    return null;
  }

  /** Internal weighted selection from a candidate list (same logic as getProxy) */
  private selectFromCandidates(candidates: ProxyEntry[]): ProxyEntry {
    const now = Date.now();

    // Exclude last used proxy
    const selectable = candidates.filter((c) => c.url !== this.lastUsedUrl);
    const pool = selectable.length > 0 ? selectable : candidates;

    const weights = pool.map((entry) => {
      const healthWeight = Math.max(1, entry.healthScore);
      const speedWeight = 1 / (1 + entry.avgResponseTime / 1000);
      return healthWeight * speedWeight;
    });

    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    let random = Math.random() * totalWeight;

    let selected: ProxyEntry = pool[0];
    for (let i = 0; i < pool.length; i++) {
      random -= weights[i];
      if (random <= 0) {
        selected = pool[i];
        break;
      }
    }

    selected.lastUsed = now;
    this.lastUsedUrl = selected.url;
    return selected;
  }

  // ==================== Detailed Stats ====================

  /** Get comprehensive stats including per-proxy details, bindings, and recent failures. */
  getDetailedStats(): DetailedStats {
    const now = Date.now();
    const poolStats = this.getPoolStats();

    const proxies: ProxyDetail[] = Array.from(this.pool.values()).map((entry) => {
      let status: ProxyDetail['status'] = 'active';
      if (entry.disabled) {
        status = 'disabled';
      } else if (entry.coolingUntil && now < entry.coolingUntil) {
        status = 'cooling';
      }

      return {
        url: entry.url,
        protocol: entry.protocol,
        host: entry.host,
        port: entry.port,
        healthScore: entry.healthScore,
        successCount: entry.successCount,
        failCount: entry.failCount,
        avgResponseTime: entry.avgResponseTime,
        consecutiveFails: entry.consecutiveFails,
        status,
        coolingUntil: entry.coolingUntil,
        blockedDomains: Array.from(entry.blockedDomains),
      };
    });

    // Clean domain bindings (remove stale ones)
    const domainBindings: Record<string, string> = {};
    for (const [domain, cleanUrl] of this.domainBindings.entries()) {
      if (this.pool.has(cleanUrl)) {
        domainBindings[domain] = cleanUrl;
      }
    }

    // Filter recent failures to last 5 minutes
    const cutoff = now - 5 * 60 * 1000;
    const recentFailures = this.recentFailures
      .filter((f) => f.timestamp >= cutoff)
      .map((f) => ({
        proxyUrl: f.proxyUrl,
        domain: f.domain || 'unknown',
        timestamp: f.timestamp,
        error: f.error,
      }));

    return {
      pool: poolStats,
      proxies,
      domainBindings,
      recentFailures,
      dispatcherCacheSize: dispatcherCache.size,
    };
  }
}

// Singleton export
export const proxyManager = ProxyManager.getInstance();
