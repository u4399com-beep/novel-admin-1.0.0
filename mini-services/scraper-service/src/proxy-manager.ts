/**
 * Smart Proxy Manager
 * Comprehensive proxy pool with health tracking, adaptive selection,
 * and automatic cooling/disabling of bad proxies.
 */

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

// ==================== ProxyManager ====================

class ProxyManager {
  private pool = new Map<string, ProxyEntry>();
  private lastUsedUrl: string | null = null;
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

  /** Async health check for a single proxy */
  async checkHealth(proxyUrl: string): Promise<{ healthy: boolean; responseTime?: number; error?: string }> {
    const parsed = parseProxyUrl(proxyUrl);
    if (!parsed) return { healthy: false, error: 'Invalid proxy URL' };

    const entry = this.pool.get(parsed.cleanUrl);
    if (!entry) return { healthy: false, error: 'Proxy not in pool' };

    const startTime = Date.now();
    const testUrl = 'http://httpbin.org/ip'; // Known reliable endpoint

    try {
      // TODO: When http-proxy-agent / socks-proxy-agent packages are available,
      // replace this direct fetch with an agent-based fetch:
      //   const agent = createProxyAgent(entry);
      //   const res = await fetch(testUrl, { agent, signal: AbortSignal.timeout(10000) });
      // For now, just test connectivity to the proxy host itself.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      // Test: try to connect to the proxy host
      const res = await fetch(`${entry.protocol === 'https' ? 'https' : 'http'}://${entry.host}:${entry.port}`, {
        signal: controller.signal,
        redirect: 'manual',
      });
      clearTimeout(timeout);

      const responseTime = Date.now() - startTime;
      entry.lastCheck = Date.now();

      // Any response means the proxy is reachable (even auth errors mean it's alive)
      this.recordSuccess(proxyUrl, responseTime);
      return { healthy: true, responseTime };
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
}

// Singleton export
export const proxyManager = ProxyManager.getInstance();
