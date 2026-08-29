/**
 * Smart Proxy Manager
 * Comprehensive proxy pool with health tracking, adaptive selection,
 * automatic cooling/disabling of bad proxies, real proxy agent support,
 * domain-specific binding, import/export, and auto-rotate on failure.
 */

import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { isSafeUrl } from './ssrf';

// ==================== Helpers ====================

/** Redact user:password from proxy URL for safe display/logging. */
function redactProxyCredentials(url: string): string {
  return url.replace(/\/\/[^:]+:[^@]+@/, '//***:***@');
}

/** Normalize a domain: lowercase, strip trailing dot, strip www prefix. */
function normalizeDomain(d: string): string {
  return d.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
}

// ==================== Types ====================

export interface ProxyLatencyStats {
  avgResponseTime: number;  // rolling average
  sampleCount: number;
  lastUsedAt: number;
  domainLatency: Map<string, number>; // per-domain avg
}

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
  latencyStats: ProxyLatencyStats; // per-proxy + per-domain latency tracking
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
  /** Breakdown of proxies by protocol */
  protocolBreakdown: Record<string, number>;
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

/** Result of a thorough end-to-end proxy verification (HTTP through-proxy test) */
export interface ProxyVerifyResult {
  working: boolean;
  responseTime: number;       // ms, 0 if failed before getting a response
  statusCode?: number;        // HTTP status from the verify URL
  externalIp?: string;        // The IP reported by the verify endpoint
  ipMatch?: boolean;          // true if externalIp matches the proxy's host IP
  error?: string;
}

/** Summary report from verifyAllProxies() */
export interface ProxyVerifyReport {
  totalTested: number;
  working: number;
  failed: number;
  skipped: number;
  avgResponseTime: number;
  results: Array<{
    proxyUrl: string;          // redacted
    host: string;
    protocol: ProxyEntry['protocol'];
    result: ProxyVerifyResult;
  }>;
}

/** Options for testProxyBatch() */
export interface ProxyBatchTestOptions {
  /** URL to fetch through each proxy for testing (default: verifyUrl) */
  testUrl?: string;
  /** Per-proxy timeout in ms (default: 15000 for HTTP, 20000 for SOCKS) */
  timeoutMs?: number;
  /** Max concurrent test requests (default: 5) */
  maxConcurrent?: number;
  /** Whether to auto-add proxies not yet in the pool (default: true) */
  autoAdd?: boolean;
}

/** Per-proxy result from testProxyBatch() */
export interface ProxyBatchTestResult {
  url: string;
  protocol: ProxyEntry['protocol'];
  host: string;
  port: number;
  reachable: boolean;
  responseTime: number;       // ms, 0 if unreachable
  statusCode?: number;
  externalIp?: string;
  ipMatch?: boolean;
  error?: string;
  testTimestamp: number;
}

// ==================== Proxy Parser ====================

function parseProxyUrl(rawUrl: string): { protocol: ProxyEntry['protocol']; host: string; port: number; cleanUrl: string } | null {
  try {
    let urlStr = rawUrl.trim();
    let protocol: ProxyEntry['protocol'] = 'http';

    // Detect protocol (including h-variants for remote DNS resolution)
    if (urlStr.startsWith('socks5h://')) {
      protocol = 'socks5'; // socks5h is SOCKS5 with remote DNS
      urlStr = urlStr.replace('socks5h://', 'http://');
    } else if (urlStr.startsWith('socks5://')) {
      protocol = 'socks5';
      urlStr = urlStr.replace('socks5://', 'http://');
    } else if (urlStr.startsWith('socks4h://')) {
      protocol = 'socks4'; // socks4h is SOCKS4 with remote DNS
      urlStr = urlStr.replace('socks4h://', 'http://');
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
    let port = parseInt(parsed.port, 10);

    // Apply protocol default port when none specified (e.g. "http://proxy.host" → port 80)
    if (isNaN(port)) {
      const defaultPorts: Record<string, number> = { http: 80, https: 443, socks4: 1080, socks5: 1080 };
      port = defaultPorts[protocol] || 80;
    }

    if (!host || port < 1 || port > 65535) {
      return null;
    }

    // Rebuild clean URL without credentials for display
    // IPv6 hosts must be bracketed (e.g. http://[::1]:8080)
    const displayHost = host.includes(':') ? `[${host}]` : host;
    const cleanUrl = `${protocol}://${displayHost}:${port}`;

    return { protocol, host, port, cleanUrl };
  } catch {
    return null;
  }
}

// ==================== Proxy Dispatcher Cache ====================

/**
 * Cache of undici Dispatcher instances keyed by original proxy URL.
 * Shared across the ProxyManager singleton and the module-level getProxyDispatcher().
 * LRU eviction: max 200 entries (delete-and-reinsert for LRU order).
 */
const dispatcherCache = new Map<string, Dispatcher>();
const MAX_DISPATCHER_CACHE = 200;

/**
 * Get or create a cached undici Dispatcher (ProxyAgent/SocksProxyAgent) for a proxy URL.
 * Supports http, https, socks4, socks5 proxies.
 * Handles proxy authentication via user:pass in the URL.
 *
 * @param proxyUrl - The full proxy URL (e.g. "http://user:pass@host:port", "socks5://host:port", "socks4://host:port")
 * @returns An undici Dispatcher, or null if the URL is invalid or creation failed
 */
export function getProxyDispatcher(proxyUrl: string): Dispatcher | null {
  if (dispatcherCache.has(proxyUrl)) {
    // LRU: move to end (most recently used)
    const cached = dispatcherCache.get(proxyUrl)!;
    dispatcherCache.delete(proxyUrl);
    dispatcherCache.set(proxyUrl, cached);
    return cached;
  }

  try {
    let urlStr = proxyUrl.trim();
    let protocol: ProxyEntry['protocol'] = 'http';

    // Detect protocol (including h-variants for remote DNS resolution)
    if (urlStr.startsWith('socks5h://')) {
      protocol = 'socks5'; // socks5h is SOCKS5 with remote DNS
    } else if (urlStr.startsWith('socks5://')) {
      protocol = 'socks5';
    } else if (urlStr.startsWith('socks4h://')) {
      protocol = 'socks4'; // socks4h is SOCKS4 with remote DNS
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

    if (protocol === 'socks5' || protocol === 'socks4') {
      // socks-proxy-agent supports all variants: socks4://, socks4h://, socks5://, socks5h://
      // Pass the original URL as-is so the agent handles protocol-specific behavior (e.g. remote DNS for h-variants)
      // Note: SOCKS4 does NOT support username/password authentication.
      try {
        if (protocol === 'socks4') {
          const parsedUrl = new URL(urlStr.replace(/^socks4h?:\/\//, 'http://'));
          if (parsedUrl.username || parsedUrl.password) {
            console.warn('[ProxyManager] SOCKS4 does not support authentication; credentials in URL will be ignored');
          }
        }
        const agent = new SocksProxyAgent(proxyUrl.trim());
        // LRU eviction if at capacity
        if (dispatcherCache.size >= MAX_DISPATCHER_CACHE) {
          const oldestKey = dispatcherCache.keys().next().value;
          if (oldestKey !== undefined) {
            const old = dispatcherCache.get(oldestKey);
            try { (old as any)?.close?.(); } catch { /* */ }
            dispatcherCache.delete(oldestKey);
          }
        }
        dispatcherCache.set(proxyUrl, agent as unknown as Dispatcher);
        return agent as unknown as Dispatcher;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (process.env.DEBUG === 'true') {
          console.log(`[ProxyManager] Failed to create SOCKS agent for ${redactProxyCredentials(proxyUrl)}: ${errMsg}`);
        }
        return null;
      }
    } else {
      // http / https — use ProxyAgent with the full URI (supports user:pass auth)
      dispatcher = new ProxyAgent(urlStr);
    }

    // LRU eviction if at capacity
    if (dispatcherCache.size >= MAX_DISPATCHER_CACHE) {
      const oldestKey = dispatcherCache.keys().next().value;
      if (oldestKey !== undefined) {
        const old = dispatcherCache.get(oldestKey);
        try { (old as any)?.close?.(); } catch { /* */ }
        dispatcherCache.delete(oldestKey);
      }
    }
    dispatcherCache.set(proxyUrl, dispatcher);
    return dispatcher;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (process.env.DEBUG === 'true') {
      console.log(`[ProxyManager] Failed to create dispatcher for ${redactProxyCredentials(proxyUrl)}: ${errMsg}`);
    }
    return null;
  }
}

/** Invalidate a cached dispatcher (e.g. after removing a proxy) */
export function invalidateDispatcher(proxyUrl: string): void {
  const d = dispatcherCache.get(proxyUrl);
  if (d) {
    try { (d as any).close?.(); } catch { /* already closed */ }
  }
  dispatcherCache.delete(proxyUrl);
}

/** Clear the entire dispatcher cache */
export function clearDispatcherCache(): void {
  for (const [url, d] of dispatcherCache) {
    try { (d as any).close?.(); } catch { /* */ }
  }
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
  /** Per-domain rotation tracking: how many successful requests since last rotation */
  private domainRotationCount = new Map<string, number>();
  /** Per-domain current rotation index into the top-N proxy list */
  private domainRotationIndex = new Map<string, number>();
  /** Configurable: rotate proxy after this many successful requests (default 20) */
  private rotationInterval: number;
  /** Configurable: number of top proxies to rotate between (default 3) */
  private rotationTopN: number;
  private static instance: ProxyManager;
  /** Timer handle for periodic proxy verification */
  private verificationTimer: ReturnType<typeof setInterval> | null = null;
  /** Configurable verify URL (env SCRAPER_PROXY_VERIFY_URL) */
  private readonly verifyUrl: string;
  /** Per-domain failure tracking: domain -> Map<proxyCleanUrl, timestamp> for 5-min window */
  private domainFailures = new Map<string, Map<string, number>>();
  /** In-flight verification deduplication: proxyCleanUrl -> pending Promise */
  private pendingVerifications = new Map<string, Promise<ProxyVerifyResult>>();

  private constructor(rotationInterval?: number, rotationTopN?: number) {
    this.rotationInterval = rotationInterval || 20;
    this.rotationTopN = rotationTopN || 3;
    this.verifyUrl = process.env.SCRAPER_PROXY_VERIFY_URL || 'https://httpbin.org/ip';
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
      latencyStats: {
        avgResponseTime: 0,
        sampleCount: 0,
        lastUsedAt: 0,
        domainLatency: new Map(),
      },
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

    // Look up the entry to get the original URL (with credentials)
    // so we invalidate the correct dispatcher cache key
    const entry = this.pool.get(parsed.cleanUrl);
    if (entry) {
      invalidateDispatcher(entry.url);
    }

    return this.pool.delete(parsed.cleanUrl);
  }

  /** Get all non-disabled proxy entries (for bulk operations like test-all) */
  getActiveProxyUrls(): string[] {
    return Array.from(this.pool.values())
      .filter(entry => !entry.disabled)
      .map(entry => entry.url);
  }

  /**
   * Get the best available proxy for a given domain.
   * Uses latency-aware scheduling: sorts by domain-specific latency (or overall latency),
   * applies 10-20% jitter to avoid thundering herd, prefers proxies with recent success
   * for the same domain, and avoids proxies that failed for the domain in the last 5 minutes.
   */
  getProxy(domain?: string): ProxyEntry | null {
    const now = Date.now();
    const normalisedDomain = domain ? normalizeDomain(domain) : undefined;
    const FIVE_MINUTES = 5 * 60 * 1000;

    // Get domain failure map for the 5-min exclusion window
    const domainFailMap = normalisedDomain ? this.domainFailures.get(normalisedDomain) : undefined;

    const candidates: ProxyEntry[] = [];
    const failedCandidates: ProxyEntry[] = [];

    for (const entry of this.pool.values()) {
      // Skip disabled proxies
      if (entry.disabled) continue;

      // Skip proxies in cooling period
      if (entry.coolingUntil && now < entry.coolingUntil) continue;

      // Skip proxies blocked for this domain
      if (normalisedDomain && entry.blockedDomains.has(normalisedDomain)) continue;

      // Skip proxies that failed for this domain in the last 5 minutes
      const entryCleanUrl = parseProxyUrl(entry.url)?.cleanUrl ?? entry.url;
      if (domainFailMap) {
        const failTs = domainFailMap.get(entryCleanUrl);
        if (failTs && (now - failTs) < FIVE_MINUTES) {
          failedCandidates.push(entry);
          continue;
        }
      }

      candidates.push(entry);
    }

    // If no candidates without domain failures, try the failed ones (better than nothing)
    const pool = candidates.length > 0 ? candidates : failedCandidates;
    if (pool.length === 0) return null;

    // If only one candidate, use it
    if (pool.length === 1) {
      const candidate = pool[0];
      candidate.lastUsed = now;
      candidate.latencyStats.lastUsedAt = now;
      this.lastUsedUrl = candidate.url;
      return candidate;
    }

    // Sort by latency for the target domain (lowest first)
    // Use domain-specific latency if available, otherwise fall back to overall latency
    pool.sort((a, b) => {
      const aLat = normalisedDomain
        ? (a.latencyStats.domainLatency.get(normalisedDomain) ?? a.latencyStats.avgResponseTime)
        : a.latencyStats.avgResponseTime;
      const bLat = normalisedDomain
        ? (b.latencyStats.domainLatency.get(normalisedDomain) ?? b.latencyStats.avgResponseTime)
        : b.latencyStats.avgResponseTime;
      // Proxies with no latency data (0) are deprioritized slightly (treat as 5000ms)
      const aEffective = aLat > 0 ? aLat : 5000;
      const bEffective = bLat > 0 ? bLat : 5000;
      return aEffective - bEffective;
    });

    // Exclude the last used proxy if possible
    let selectable = pool.filter((c) => c.url !== this.lastUsedUrl);
    if (selectable.length === 0) selectable = pool;

    // Apply 10-20% jitter to selection to avoid thundering herd
    // Pick from the top candidates with jittered priority
    const topCount = Math.max(1, Math.ceil(selectable.length * 0.3)); // top 30%
    const topCandidates = selectable.slice(0, topCount);

    // Weighted selection within top candidates, with 10-20% jitter on effective latency
    const weights = topCandidates.map((entry) => {
      const baseLat = normalisedDomain
        ? (entry.latencyStats.domainLatency.get(normalisedDomain) ?? entry.latencyStats.avgResponseTime)
        : entry.latencyStats.avgResponseTime;
      const effectiveLat = baseLat > 0 ? baseLat : 5000;
      // Apply 10-20% random jitter
      const jitter = 1 + (0.10 + Math.random() * 0.10); // 1.10 to 1.20
      const jitteredLat = effectiveLat * jitter;
      const healthWeight = Math.max(1, entry.healthScore);
      const speedWeight = 1 / (1 + jitteredLat / 1000);
      return healthWeight * speedWeight;
    });

    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    let random = Math.random() * totalWeight;

    let selected: ProxyEntry = topCandidates[0];
    for (let i = 0; i < topCandidates.length; i++) {
      random -= weights[i];
      if (random <= 0) {
        selected = topCandidates[i];
        break;
      }
    }

    selected.lastUsed = now;
    selected.latencyStats.lastUsedAt = now;
    this.lastUsedUrl = selected.url;
    return selected;
  }

  /**
   * Get the proxy with the lowest latency.
   * If a domain is provided, uses domain-specific latency; otherwise uses overall latency.
   * Skips disabled, cooling, and domain-blocked proxies.
   *
   * @param domain - Optional target domain for domain-specific latency lookup
   * @returns The fastest ProxyEntry, or null if no proxies available
   */
  getFastestProxy(domain?: string): ProxyEntry | null {
    const now = Date.now();
    const normalisedDomain = domain ? normalizeDomain(domain) : undefined;
    const FIVE_MINUTES = 5 * 60 * 1000;

    const domainFailMap = normalisedDomain ? this.domainFailures.get(normalisedDomain) : undefined;

    let best: ProxyEntry | null = null;
    let bestLat = Infinity;

    for (const entry of this.pool.values()) {
      if (entry.disabled) continue;
      if (entry.coolingUntil && now < entry.coolingUntil) continue;
      if (normalisedDomain && entry.blockedDomains.has(normalisedDomain)) continue;

      // Skip proxies that failed for this domain in the last 5 minutes
      const entryCleanUrl = parseProxyUrl(entry.url)?.cleanUrl ?? entry.url;
      if (domainFailMap) {
        const failTs = domainFailMap.get(entryCleanUrl);
        if (failTs && (now - failTs) < FIVE_MINUTES) continue;
      }

      const lat = normalisedDomain
        ? (entry.latencyStats.domainLatency.get(normalisedDomain) ?? entry.latencyStats.avgResponseTime)
        : entry.latencyStats.avgResponseTime;

      if (lat > 0 && lat < bestLat) {
        bestLat = lat;
        best = entry;
      }
    }

    // If no proxy has latency data, return the first active proxy
    if (!best) {
      for (const entry of this.pool.values()) {
        if (entry.disabled) continue;
        if (entry.coolingUntil && now < entry.coolingUntil) continue;
        if (normalisedDomain && entry.blockedDomains.has(normalisedDomain)) continue;
        best = entry;
        break;
      }
    }

    if (best) {
      best.lastUsed = now;
      best.latencyStats.lastUsedAt = now;
      this.lastUsedUrl = best.url;
    }

    return best;
  }

  /** Record a successful request through a proxy */
  recordSuccess(proxyUrl: string, responseTime: number, domain?: string): void {
    const parsed = parseProxyUrl(proxyUrl);
    if (!parsed) return;

    const entry = this.pool.get(parsed.cleanUrl);
    if (!entry) return;

    entry.successCount++;
    entry.consecutiveFails = 0;
    entry.lastUsed = Date.now();

    // Clear recent failures for this proxy (and optionally domain) on success
    this.recentFailures = this.recentFailures.filter(
      (f) => f.proxyUrl !== parsed.cleanUrl || (domain && f.domain && f.domain !== normalizeDomain(domain))
    );

    // Update rolling average response time (legacy field)
    if (entry.avgResponseTime === 0) {
      entry.avgResponseTime = responseTime;
    } else {
      // Exponential moving average (α = 0.3)
      entry.avgResponseTime = Math.round(
        entry.avgResponseTime * 0.7 + responseTime * 0.3
      );
    }

    // Update latencyStats: rolling average response time
    const stats = entry.latencyStats;
    if (stats.sampleCount === 0) {
      stats.avgResponseTime = responseTime;
    } else {
      stats.avgResponseTime = Math.round(
        stats.avgResponseTime * 0.7 + responseTime * 0.3
      );
    }
    stats.sampleCount++;
    stats.lastUsedAt = Date.now();

    // Update domain-specific latency
    if (domain) {
      const normalisedDomain = normalizeDomain(domain);
      const existingDomainLat = stats.domainLatency.get(normalisedDomain);
      if (existingDomainLat === undefined) {
        stats.domainLatency.set(normalisedDomain, responseTime);
      } else {
        stats.domainLatency.set(normalisedDomain,
          Math.round(existingDomainLat * 0.7 + responseTime * 0.3)
        );
      }

      // Clear domain failure for this proxy on success
      const domainFailMap = this.domainFailures.get(normalisedDomain);
      if (domainFailMap) {
        domainFailMap.delete(parsed.cleanUrl);
        if (domainFailMap.size === 0) {
          this.domainFailures.delete(normalisedDomain);
        }
      }
    }

    // Increase health score (cap at 100)
    const scoreGain = Math.min(5, Math.max(1, Math.floor(10 - responseTime / 1000)));
    entry.healthScore = Math.min(100, entry.healthScore + scoreGain);
  }

  /** Record a failed request through a proxy */
  recordFailure(proxyUrl: string, error?: string, domain?: string): void {
    const parsed = parseProxyUrl(proxyUrl);
    if (!parsed) return;

    const entry = this.pool.get(parsed.cleanUrl);
    if (!entry) return;

    entry.failCount++;
    entry.consecutiveFails++;
    entry.lastUsed = Date.now();

    // If error indicates 403, add domain to blocked list
    let extractedDomain: string | undefined;
    if (error) {
      const httpMatch = error.match(/HTTP (\d+)/);
      if (httpMatch) {
        const status = parseInt(httpMatch[1], 10);
        if (status === 403) {
          // Extract domain from error context if available
          const urlMatch = error.match(/for (https?:\/\/[^/\s]+)/);
          if (urlMatch) {
            try {
              extractedDomain = new URL(urlMatch[1]).hostname;
              extractedDomain = normalizeDomain(extractedDomain);
              entry.blockedDomains.add(extractedDomain);
            } catch { /* ignore parse errors */ }
          }
        }
      }
    }

    // Track domain-specific failure for latency-aware scheduling (5-min window)
    const failDomain = domain ? normalizeDomain(domain) : extractedDomain;
    if (failDomain) {
      let domainFailMap = this.domainFailures.get(failDomain);
      if (!domainFailMap) {
        domainFailMap = new Map();
        this.domainFailures.set(failDomain, domainFailMap);
      }
      domainFailMap.set(parsed.cleanUrl, Date.now());
    }

    // Track recent failure for auto-rotate (include domain when available)
    this.addRecentFailure(parsed.cleanUrl, error, extractedDomain);

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
        protocolBreakdown: {},
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
      .map((e) => {
        const parsed = parseProxyUrl(e.url);
        return {
          url: parsed?.cleanUrl ?? e.url,
          host: e.host,
          healthScore: e.healthScore,
          successCount: e.successCount,
          failCount: e.failCount,
          avgResponseTime: e.avgResponseTime,
        };
      })

    // Protocol breakdown
    const protocolBreakdown: Record<string, number> = {};
    for (const entry of entries) {
      protocolBreakdown[entry.protocol] = (protocolBreakdown[entry.protocol] || 0) + 1;
    }

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
      protocolBreakdown,
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
    const testUrl = this.verifyUrl; // Use configurable verify URL (env SCRAPER_PROXY_VERIFY_URL)

    // --- Primary: test THROUGH the proxy using an undici dispatcher ---
    const dispatcher = getProxyDispatcher(entry.url);
    if (dispatcher) {
      try {
        const controller = new AbortController();
        // SOCKS proxies need extra time for the handshake + potential remote DNS resolution
        const healthTimeoutMs = (entry.protocol === 'socks4' || entry.protocol === 'socks5') ? 20000 : 15000;
        const timeout = setTimeout(() => controller.abort(), healthTimeoutMs);

        const res = await undiciFetch(testUrl, {
          dispatcher,
          signal: controller.signal,
          redirect: 'manual',
        } as Parameters<typeof undiciFetch>[1]);
        clearTimeout(timeout);

        const responseTime = Date.now() - startTime;
        entry.lastCheck = Date.now();

        // Consume response body to prevent undici connection pool leak (R49#27)
        await res.body?.cancel().catch(() => {});
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
        clearTimeout(timeout);
        // Through-proxy fetch failed; fall through to secondary check below
        const errMsg = err instanceof Error ? err.message : String(err);
        if (process.env.DEBUG === 'true') {
          console.log(`[ProxyManager] Through-proxy check failed for ${parsed.cleanUrl}: ${errMsg} — falling back to direct check`);
        }
        // Don't record failure yet; let the secondary check determine the outcome
      }
    }

    // --- Secondary fallback: test direct connectivity to the proxy host ---
    const secondaryStart = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      // IPv6 hosts must be bracketed in the URL
      const healthHost = entry.host.includes(':') ? `[${entry.host}]` : entry.host;
      const res = await fetch(`${entry.protocol === 'https' ? 'https' : 'http'}://${healthHost}:${entry.port}`, {
        signal: controller.signal,
        redirect: 'manual',
      });
      clearTimeout(timeout);

      const responseTime = Date.now() - secondaryStart;
      entry.lastCheck = Date.now();

      // Any response means the proxy host is reachable (even auth errors mean it's alive)
      // Consume body to prevent undici connection pool leak (R49#27)
      res.body?.cancel().catch(() => {});
      // but we couldn't route traffic through it — record as degraded (not a full success)
      entry.consecutiveFails = 0; // Reset fails since host is alive
      return { healthy: false, responseTime, error: 'Host reachable but through-proxy test failed' };
    } catch (err) {
      const responseTime = Date.now() - secondaryStart;
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
    this.domainRotationCount.clear();
    this.domainRotationIndex.clear();
    this.domainFailures.clear();
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
    entry.latencyStats = {
      avgResponseTime: 0,
      sampleCount: 0,
      lastUsedAt: 0,
      domainLatency: new Map(),
    };

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
      entry.latencyStats = {
        avgResponseTime: 0,
        sampleCount: 0,
        lastUsedAt: 0,
        domainLatency: new Map(),
      };
    }
    this.domainFailures.clear();
    clearDispatcherCache();
  }

  // ==================== Import / Export ====================

  /** Export all proxy entries as JSON (with real credentials for backup/restore roundtrip). */
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

  /** Export all proxy entries as JSON with redacted credentials (for user-facing display). */
  exportProxiesPublic(): string {
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
      const safeUrl = redactProxyCredentials(entry.url);
      entries.push({
        url: safeUrl,
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

    // Simple URL list (without credentials)
    const urls: string[] = [];
    for (const entry of this.pool.values()) {
      const parsed = parseProxyUrl(entry.url);
      urls.push(parsed?.cleanUrl ?? entry.url);
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
    const normalisedDomain = normalizeDomain(domain);

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
    const normalisedDomain = normalizeDomain(domain);
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

    // Skip if this proxy failed for this domain in the last 5 minutes
    const FIVE_MINUTES = 5 * 60 * 1000;
    const domainFailMap = this.domainFailures.get(normalisedDomain);
    if (domainFailMap) {
      const failTs = domainFailMap.get(cleanUrl);
      if (failTs && (now - failTs) < FIVE_MINUTES) {
        return null; // Temporarily skip this binding
      }
    }

    return entry;
  }

  // ==================== Domain Proxy Rotation ====================

  /**
   * Get a proxy for a domain with automatic rotation among the top N proxies.
   *
   * Unlike `getDomainProxy()` which always returns the same proxy, this method
   * rotates between the top N lowest-latency proxies every M successful requests.
   * This makes the scraper appear to come from different IPs over time.
   *
   * Rotation logic:
   * - Sorts all active (non-disabled, non-cooling) proxies by domain-specific latency
   *   (lowest first), using healthScore as tiebreaker
   * - Takes the top N proxies
   * - Tracks `rotationCount` per domain
   * - After every `rotationInterval` (default 20) successful requests, advances to
   *   the next proxy in the top-N list (round-robin)
   * - Falls back to pool selection if fewer than 2 proxies available
   *
   * @param domain       - Target domain for rotation tracking
   * @returns A ProxyEntry, or null if no proxies available
   */
  getDomainProxyWithRotation(domain: string): ProxyEntry | null {
    const normalisedDomain = normalizeDomain(domain);
    const now = Date.now();
    const FIVE_MINUTES = 5 * 60 * 1000;

    // Collect active candidates, excluding domain-failed proxies
    // Sort by domain-specific latency (lowest first), then by healthScore as tiebreaker
    const domainFailMap = this.domainFailures.get(normalisedDomain);
    const candidates = Array.from(this.pool.values())
      .filter(entry => {
        if (entry.disabled) return false;
        if (entry.coolingUntil && now < entry.coolingUntil) return false;
        if (entry.blockedDomains.has(normalisedDomain)) return false;
        // Skip proxies that failed for this domain in the last 5 minutes
        const entryCleanUrl = parseProxyUrl(entry.url)?.cleanUrl ?? entry.url;
        if (domainFailMap) {
          const failTs = domainFailMap.get(entryCleanUrl);
          if (failTs && (now - failTs) < FIVE_MINUTES) return false;
        }
        return true;
      })
      .sort((a, b) => {
        // Primary sort: domain-specific latency (lowest first)
        const aLat = a.latencyStats.domainLatency.get(normalisedDomain) ?? a.latencyStats.avgResponseTime;
        const bLat = b.latencyStats.domainLatency.get(normalisedDomain) ?? b.latencyStats.avgResponseTime;
        const aEffective = aLat > 0 ? aLat : 5000;
        const bEffective = bLat > 0 ? bLat : 5000;
        if (aEffective !== bEffective) return aEffective - bEffective;
        // Tiebreaker: healthScore descending
        return b.healthScore - a.healthScore;
      });

    // Need at least 2 proxies for rotation to make sense
    if (candidates.length < 2) {
      // Fall back to regular domain proxy or pool selection
      const boundProxy = this.getDomainProxy(normalisedDomain);
      if (boundProxy) return boundProxy;
      return this.getProxy(normalisedDomain);
    }

    // Take top N proxies (by latency now, not just health)
    const topN = candidates.slice(0, this.rotationTopN);

    // Get or initialize rotation index for this domain
    const currentIndex = this.domainRotationIndex.get(normalisedDomain) || 0;

    // Select current proxy in the rotation
    let selectedProxy = topN[currentIndex % topN.length];

    // Avoid reusing the global lastUsedUrl (cross-domain proxy reuse detection)
    // If the rotation landed on it, try the next proxy in the topN list
    if (selectedProxy.url === this.lastUsedUrl && topN.length > 1) {
      selectedProxy = topN[(currentIndex + 1) % topN.length];
    }

    selectedProxy.lastUsed = now;
    selectedProxy.latencyStats.lastUsedAt = now;
    this.lastUsedUrl = selectedProxy.url;

    return selectedProxy;
  }

  /**
   * Record a successful request and advance domain proxy rotation if needed.
   * Call this instead of (or in addition to) `recordSuccess()` when using rotation.
   *
   * @param proxyUrl - The proxy URL that was used
   * @param domain   - The target domain
   * @param responseTime - Response time in ms
   */
  recordSuccessWithRotation(proxyUrl: string, domain: string, responseTime: number): void {
    // Record the success normally
    this.recordSuccess(proxyUrl, responseTime, domain);

    const normalisedDomain = normalizeDomain(domain);
    const currentCount = (this.domainRotationCount.get(normalisedDomain) || 0) + 1;
    this.domainRotationCount.set(normalisedDomain, currentCount);

    // Evict stale rotation entries (keep last 500 domains to prevent unbounded growth)
    if (this.domainRotationCount.size > 500) {
      let oldestKey = '';
      let oldestVal = Infinity;
      for (const [k, v] of this.domainRotationCount) {
        if (v < oldestVal) {
          oldestVal = v;
          oldestKey = k;
        }
      }
      if (oldestKey) {
        this.domainRotationCount.delete(oldestKey);
        this.domainRotationIndex.delete(oldestKey);
      }
    }

    // Check if we should rotate
    if (currentCount >= this.rotationInterval) {
      // Reset count and advance index
      this.domainRotationCount.set(normalisedDomain, 0);
      const currentIndex = this.domainRotationIndex.get(normalisedDomain) || 0;
      this.domainRotationIndex.set(normalisedDomain, currentIndex + 1);
    }
  }

  /**
   * Get the current rotation state for a domain (for monitoring/debugging).
   */
  getDomainRotationState(domain: string): { rotationCount: number; rotationIndex: number; interval: number; topN: number } {
    const normalisedDomain = normalizeDomain(domain);
    return {
      rotationCount: this.domainRotationCount.get(normalisedDomain) || 0,
      rotationIndex: this.domainRotationIndex.get(normalisedDomain) || 0,
      interval: this.rotationInterval,
      topN: this.rotationTopN,
    };
  }

  /**
   * Configure proxy rotation parameters.
   *
   * @param interval - Number of successful requests before rotating to next proxy (default 20)
   * @param topN     - Number of top proxies to rotate between (default 3)
   */
  setRotationConfig(interval: number, topN?: number): void {
    if (interval > 0) this.rotationInterval = interval;
    if (topN !== undefined && topN > 0) this.rotationTopN = topN;
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
  private addRecentFailure(proxyCleanUrl: string, error?: string, domain?: string): void {
    const now = Date.now();
    const FIVE_MINUTES = 5 * 60 * 1000;

    this.recentFailures.push({
      proxyUrl: proxyCleanUrl,
      domain,
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
      if (domain && entry.blockedDomains.has(normalizeDomain(domain))) continue;
      // Check exclusion against both original URL and clean URL (for authenticated proxies)
      const parsed = parseProxyUrl(entry.url);
      const entryCleanUrl = parsed?.cleanUrl ?? entry.url;
      if (excludeSet.has(entry.url) || excludeSet.has(entryCleanUrl)) continue;

      if (this.hasRecentFailures(entryCleanUrl)) {
        candidatesWithRecentFails.push(entry);
      } else {
        candidates.push(entry);
      }
    }

    // Prefer candidates without recent failures
    if (candidates.length > 0) {
      return this.selectFromCandidates(candidates, domain);
    }

    // Fallback: use candidates with recent failures (better than nothing)
    if (candidatesWithRecentFails.length > 0) {
      return this.selectFromCandidates(candidatesWithRecentFails, domain);
    }

    return null;
  }

  /** Internal weighted selection from a candidate list using latency-aware scheduling. */
  private selectFromCandidates(candidates: ProxyEntry[], domain?: string): ProxyEntry {
    const now = Date.now();
    const normalisedDomain = domain ? normalizeDomain(domain) : undefined;

    // Exclude last used proxy
    const selectable = candidates.filter((c) => c.url !== this.lastUsedUrl);
    const pool = selectable.length > 0 ? selectable : candidates;

    // Sort by domain-specific latency (lowest first)
    pool.sort((a, b) => {
      const aLat = normalisedDomain
        ? (a.latencyStats.domainLatency.get(normalisedDomain) ?? a.latencyStats.avgResponseTime)
        : a.latencyStats.avgResponseTime;
      const bLat = normalisedDomain
        ? (b.latencyStats.domainLatency.get(normalisedDomain) ?? b.latencyStats.avgResponseTime)
        : b.latencyStats.avgResponseTime;
      const aEffective = aLat > 0 ? aLat : 5000;
      const bEffective = bLat > 0 ? bLat : 5000;
      return aEffective - bEffective;
    });

    // Weighted selection from top 30% with jitter
    const topCount = Math.max(1, Math.ceil(pool.length * 0.3));
    const topCandidates = pool.slice(0, topCount);

    const weights = topCandidates.map((entry) => {
      const baseLat = normalisedDomain
        ? (entry.latencyStats.domainLatency.get(normalisedDomain) ?? entry.latencyStats.avgResponseTime)
        : entry.latencyStats.avgResponseTime;
      const effectiveLat = baseLat > 0 ? baseLat : 5000;
      const jitter = 1 + (0.10 + Math.random() * 0.10);
      const jitteredLat = effectiveLat * jitter;
      const healthWeight = Math.max(1, entry.healthScore);
      const speedWeight = 1 / (1 + jitteredLat / 1000);
      return healthWeight * speedWeight;
    });

    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    let random = Math.random() * totalWeight;

    let selected: ProxyEntry = topCandidates[0];
    for (let i = 0; i < topCandidates.length; i++) {
      random -= weights[i];
      if (random <= 0) {
        selected = topCandidates[i];
        break;
      }
    }

    selected.lastUsed = now;
    selected.latencyStats.lastUsedAt = now;
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

      // Redact credentials from URL to prevent exposure via API
      const safeUrl = redactProxyCredentials(entry.url);

      return {
        url: safeUrl,
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
        proxyUrl: redactProxyCredentials(f.proxyUrl),
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

  // ==================== End-to-End Proxy Verification ====================

  /**
   * Thoroughly verify a single proxy by making a real HTTP request THROUGH it.
   * Unlike checkHealth() which has a direct-connect fallback, this method:
   *   - Parses the response body to extract the external IP
   *   - Compares it against the proxy's host IP for IP-match detection
   *   - Uses configurable timeouts (15s for HTTP/HTTPS, 20s for SOCKS)
   *   - Updates the proxy's health score based on results
   *
   * @param proxyUrl - The proxy URL to verify
   * @returns ProxyVerifyResult with working status, timing, and IP info
   */
  async verifyProxy(proxyUrl: string, overrides?: { testUrl?: string; timeoutMs?: number }): Promise<ProxyVerifyResult> {
    const parsed = parseProxyUrl(proxyUrl);
    if (!parsed) {
      return { working: false, responseTime: 0, error: 'Invalid proxy URL' };
    }

    const effectiveTestUrl = overrides?.testUrl || this.verifyUrl;
    if (!isSafeUrl(effectiveTestUrl)) {
      return { working: false, responseTime: 0, error: 'Verify URL failed SSRF validation' };
    }

    // Deduplicate concurrent verifications for the same proxy (default options only)
    const dedupeKey = overrides ? undefined : parsed.cleanUrl;
    if (dedupeKey) {
      const pending = this.pendingVerifications.get(dedupeKey);
      if (pending) return pending;
    }

    const verifyPromise = this._doVerifyProxy(parsed, effectiveTestUrl, overrides?.timeoutMs);
    if (dedupeKey) {
      this.pendingVerifications.set(dedupeKey, verifyPromise);
      verifyPromise.finally(() => this.pendingVerifications.delete(dedupeKey));
    }
    return verifyPromise;
  }

  /** Internal verification logic — called by verifyProxy after dedup check */
  private async _doVerifyProxy(
    parsed: ReturnType<typeof parseProxyUrl> & NonNullable<ReturnType<typeof parseProxyUrl>>,
    testUrl: string,
    timeoutMsOverride?: number,
  ): Promise<ProxyVerifyResult> {
    const entry = this.pool.get(parsed.cleanUrl);
    if (!entry) {
      return { working: false, responseTime: 0, error: 'Proxy not in pool' };
    }

    const dispatcher = getProxyDispatcher(entry.url);
    if (!dispatcher) {
      return { working: false, responseTime: 0, error: 'Failed to create proxy dispatcher' };
    }

    const startTime = Date.now();
    const isSocks = entry.protocol === 'socks4' || entry.protocol === 'socks5';
    const timeoutMs = timeoutMsOverride || (isSocks ? 20000 : 15000);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await undiciFetch(testUrl, {
        dispatcher,
        signal: controller.signal,
        redirect: 'manual',
      } as Parameters<typeof undiciFetch>[1]);

      clearTimeout(timeout);
      const responseTime = Date.now() - startTime;

      // Read response body to extract IP
      let bodyText = '';
      try {
        bodyText = await res.text();
      } catch {
        // body read failed — cancel body to prevent connection pool leak
        await res.body?.cancel().catch(() => {});
      }

      entry.lastCheck = Date.now();

      if (!res.ok) {
        this.recordFailure(entry.url, `Verify returned HTTP ${res.status}`);
        return {
          working: false,
          responseTime,
          statusCode: res.status,
          error: `HTTP ${res.status}`,
        };
      }

      // Try to parse external IP from response (supports httpbin.org /json format)
      let externalIp: string | undefined;
      try {
        const json = JSON.parse(bodyText);
        // httpbin.org/ip returns { "origin": "1.2.3.4" }
        if (json.origin && typeof json.origin === 'string') {
          externalIp = json.origin.split(',')[0].trim(); // may contain multiple IPs
        }
      } catch {
        // Not JSON or not the expected format — that's OK
      }

      // Check if the external IP matches the proxy's host IP
      let ipMatch: boolean | undefined;
      if (externalIp) {
        const proxyIp = parsed.host;
        // Compare: strip brackets from IPv6, handle both forms
        const cleanProxyIp = proxyIp.replace(/^\[|\]$/g, '');
        ipMatch = externalIp === cleanProxyIp;
      }

      // Success — update health
      this.recordSuccess(entry.url, responseTime);

      return {
        working: true,
        responseTime,
        statusCode: res.status,
        externalIp,
        ipMatch,
      };
    } catch (err) {
      clearTimeout(timeout);
      const responseTime = Date.now() - startTime;
      const errMsg = err instanceof Error ? err.message : String(err);

      entry.lastCheck = Date.now();
      this.recordFailure(entry.url, errMsg);

      return {
        working: false,
        responseTime,
        error: errMsg,
      };
    }
  }

  /**
   * Batch-test a list of proxy URLs with concurrency control.
   * This is the unified entry point for proxy testing, replacing the
   * standalone proxy-conn-test.ts module.
   *
   * Proxies not yet in the pool are auto-added (unless autoAdd is false).
   * Each proxy is tested with a real HTTP request through it.
   * Health scores are updated based on results.
   *
   * @param urls - Array of proxy URLs to test
   * @param options - Optional test configuration
   * @returns Array of detailed per-proxy results
   */
  async testProxyBatch(
    urls: string[],
    options?: ProxyBatchTestOptions,
  ): Promise<ProxyBatchTestResult[]> {
    const {
      maxConcurrent = 5,
      autoAdd = true,
      testUrl,
      timeoutMs,
    } = options ?? {};

    const results: ProxyBatchTestResult[] = [];

    // Process in concurrency-limited batches
    for (let i = 0; i < urls.length; i += maxConcurrent) {
      const batch = urls.slice(i, i + maxConcurrent);
      const batchResults = await Promise.allSettled(
        batch.map(async (url) => {
          const timestamp = Date.now();
          const parsed = parseProxyUrl(url);

          if (!parsed) {
            return {
              url,
              protocol: 'http' as const,
              host: '',
              port: 0,
              reachable: false,
              responseTime: 0,
              error: `Invalid proxy URL: ${url}`,
              testTimestamp: timestamp,
            } satisfies ProxyBatchTestResult;
          }

          // Auto-add to pool if not present
          if (autoAdd && !this.pool.has(parsed.cleanUrl)) {
            this.addProxy(url);
          }

          // Use verifyProxy if the proxy is in the pool (it updates health scores)
          const entry = this.pool.get(parsed.cleanUrl);
          if (entry) {
            const verifyResult = await this.verifyProxy(url, { testUrl, timeoutMs });
            return {
              url,
              protocol: entry.protocol,
              host: entry.host,
              port: entry.port,
              reachable: verifyResult.working,
              responseTime: verifyResult.responseTime,
              statusCode: verifyResult.statusCode,
              externalIp: verifyResult.externalIp,
              ipMatch: verifyResult.ipMatch,
              error: verifyResult.error,
              testTimestamp: timestamp,
            } satisfies ProxyBatchTestResult;
          }

          // Should not reach here if autoAdd is true, but handle gracefully
          return {
            url,
            protocol: parsed.protocol,
            host: parsed.host,
            port: parsed.port,
            reachable: false,
            responseTime: 0,
            error: 'Proxy not in pool and autoAdd is disabled',
            testTimestamp: timestamp,
          } satisfies ProxyBatchTestResult;
        }),
      );

      for (let j = 0; j < batchResults.length; j++) {
        const r = batchResults[j];
        if (r.status === 'fulfilled') {
          results.push(r.value);
        } else {
          // Unexpected rejection — wrap in a failure result
          const proxyUrl = batch[j];
          const parsed = parseProxyUrl(proxyUrl);
          results.push({
            url: proxyUrl,
            protocol: parsed?.protocol ?? 'http',
            host: parsed?.host ?? '',
            port: parsed?.port ?? 0,
            reachable: false,
            responseTime: 0,
            error: r.reason instanceof Error ? r.reason.message : 'Unknown error',
            testTimestamp: Date.now(),
          } satisfies ProxyBatchTestResult);
        }
      }
    }

    return results;
  }

  /**
   * Verify all proxies in the pool end-to-end.
   * Tests each proxy with a real HTTP request through it.
   * Updates health scores based on results.
   *
   * @returns ProxyVerifyReport with per-proxy results and summary
   */
  async verifyAllProxies(): Promise<ProxyVerifyReport> {
    const entries = Array.from(this.pool.values());
    const report: ProxyVerifyReport = {
      totalTested: 0,
      working: 0,
      failed: 0,
      skipped: 0,
      avgResponseTime: 0,
      results: [],
    };

    let totalResponseTime = 0;

    // Run verifications sequentially to avoid overwhelming the verify endpoint
    for (const entry of entries) {
      if (entry.disabled) {
        report.skipped++;
        continue;
      }

      const result = await this.verifyProxy(entry.url);
      report.totalTested++;

      if (result.working) {
        report.working++;
      } else {
        report.failed++;
      }

      totalResponseTime += result.responseTime;

      report.results.push({
        proxyUrl: redactProxyCredentials(entry.url),
        host: entry.host,
        protocol: entry.protocol,
        result,
      });
    }

    report.avgResponseTime = report.totalTested > 0
      ? Math.round(totalResponseTime / report.totalTested)
      : 0;

    return report;
  }

  // ==================== Periodic Auto-Verification ====================

  /**
   * Start periodic end-to-end proxy verification.
   * Only verifies proxies that haven't been tested in the last interval period.
   * Use stopProxyVerification() to stop.
   *
   * @param intervalMs - Interval in ms (default: SCRAPER_PROXY_VERIFY_INTERVAL_MS env or 300000 = 5min)
   */
  startProxyVerification(intervalMs?: number): void {
    if (this.verificationTimer) {
      // Already running — update interval if different
      this.stopProxyVerification();
    }

    const interval = intervalMs || parseInt(process.env.SCRAPER_PROXY_VERIFY_INTERVAL_MS || '300000', 10);

    const runVerification = async () => {
      try {
        const now = Date.now();
        const candidates: ProxyEntry[] = [];

        for (const entry of this.pool.values()) {
          if (entry.disabled) continue;
          // Only verify proxies not tested in the last interval
          if (entry.lastCheck === 0 || (now - entry.lastCheck) >= interval) {
            candidates.push(entry);
          }
        }

        if (candidates.length === 0) {
          if (process.env.DEBUG === 'true') {
            console.log('[ProxyManager] Periodic verification: all proxies already tested recently, skipping');
          }
          return;
        }

        if (process.env.DEBUG === 'true') {
          console.log(`[ProxyManager] Periodic verification: testing ${candidates.length} proxies`);
        }

        for (const entry of candidates) {
          await this.verifyProxy(entry.url);
        }

        if (process.env.DEBUG === 'true') {
          console.log('[ProxyManager] Periodic verification: complete');
        }
      } catch (err) {
        console.warn('[ProxyManager] Periodic verification error:', err instanceof Error ? err.message : String(err));
      }
    };

    // Run immediately on start, then periodically
    runVerification().catch(() => {});
    this.verificationTimer = setInterval(runVerification, interval);

    if (process.env.DEBUG === 'true' || process.env.DEBUG === '1') {
      console.log(`[ProxyManager] Periodic verification started (interval: ${interval}ms)`);
    }
  }

  /**
   * Stop the periodic proxy verification timer.
   */
  stopProxyVerification(): void {
    if (this.verificationTimer) {
      clearInterval(this.verificationTimer);
      this.verificationTimer = null;
    }
  }
}

// Singleton export
export const proxyManager = ProxyManager.getInstance();
