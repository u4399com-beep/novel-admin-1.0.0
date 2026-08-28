/**
 * DNS-over-HTTPS (DoH) — Real Resolution with Simulation Fallback
 *
 * Attempts real DoH resolution via AliDNS → Cloudflare → Google.
 * Falls back to simulation when DoH is unavailable (network error, timeout).
 *
 * When real DoH succeeds, the resolved IPs are stored in the simulation cache
 * so getForwardedFor() can derive XFF IPs from the same /24 subnets.
 * When real DoH fails, the existing random-IP simulation is used.
 *
 * This module is the single import point for all DoH-related functionality.
 * Existing code importing from here gets real DoH transparently.
 */

import { resolveDoH, clearDoHCache as clearRealDoHCache } from './doh-resolver';

const MAX_CACHE_SIZE = 100;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface DnsCacheEntry {
  ips: string[];
  createdAt: number;
  real: boolean; // true if IPs came from real DoH resolution
}

const dnsCache = new Map<string, DnsCacheEntry>();

/**
 * Generate a random public IP address for DNS simulation.
 * Uses common public IP ranges (cloud/datacenter) that are plausible
 * for DoH resolver exit nodes. Private IPs (RFC1918) would be
 * immediately flagged by anti-bot systems as fake.
 */
function generateRandomIp(): string {
  // Public IP ranges commonly used by DoH providers and CDNs
  // These are realistic exit node IP ranges, not RFC1918 private IPs
  const ranges = [
    // Cloudflare DoH ranges (sample prefixes)
    () => `104.${16 + randByte() % 8}.${randByte()}.${randByte()}`,
    () => `172.${64 + randByte() % 8}.${randByte()}.${randByte()}`,
    () => `104.${randByte() % 4}.${randByte()}.${randByte()}`,
    // Google DoH ranges
    () => `8.${randByte() % 16}.${randByte()}.${randByte()}`,
    () => `8.${128 + randByte() % 64}.${randByte()}.${randByte()}`,
    // Common CDN/datacenter ranges
    () => `${140 + randByte() % 20}.${randByte()}.${randByte()}.${randByte()}`,
    () => `185.${randByte() % 64}.${randByte()}.${randByte()}`,
    () => `45.${randByte() % 16}.${randByte()}.${randByte()}`,
  ];
  return ranges[Math.floor(Math.random() * ranges.length)]();
}

function randByte(): number {
  return Math.floor(Math.random() * 256);
}

/**
 * Resolve a domain to a set of IPs.
 * Tries real DoH first (fire-and-forget to populate cache),
 * returns cached/simulated IPs synchronously for immediate use.
 *
 * When real DoH results arrive, they replace the simulated IPs in cache.
 */
function resolveDomain(domain: string): string[] {
  const now = Date.now();
  const cached = dnsCache.get(domain);

  if (cached && (now - cached.createdAt) < CACHE_TTL_MS) {
    // Cache hit — if these are simulated IPs and real DoH hasn't been tried yet,
    // kick off a background DoH query to replace them for next call
    if (!cached.real) {
      tryRealDoH(domain).catch(() => {}); // fire-and-forget
    }
    return cached.ips;
  }

  // No cache or expired — try real DoH in background, return simulated IPs now
  tryRealDoH(domain).catch(() => {});

  // Generate 2-4 IPs for this domain (simulating DNS round-robin)
  const count = 2 + Math.floor(Math.random() * 3);
  const ips: string[] = [];
  for (let i = 0; i < count; i++) {
    ips.push(generateRandomIp());
  }

  // Evict if cache is full
  if (dnsCache.size >= MAX_CACHE_SIZE && !dnsCache.has(domain)) {
    let oldestKey = '';
    let oldestTime = Infinity;
    for (const [key, entry] of dnsCache) {
      if (entry.createdAt < oldestTime) {
        oldestTime = entry.createdAt;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      dnsCache.delete(oldestKey);
    }
  }

  dnsCache.set(domain, { ips, createdAt: now, real: false });
  return ips;
}

/**
 * Attempt real DoH resolution and update the simulation cache with real IPs.
 * This runs asynchronously — callers get simulated IPs immediately via resolveDomain().
 */
async function tryRealDoH(domain: string): Promise<void> {
  try {
    const realIps = await resolveDoH(domain, 'A');
    if (realIps.length > 0) {
      // Replace simulated IPs with real resolved IPs in the cache
      const now = Date.now();
      dnsCache.set(domain, { ips: realIps, createdAt: now, real: true });
    }
  } catch {
    // Real DoH failed — simulation cache remains in place
  }
}

/**
 * Get a fake X-Forwarded-For IP for the given domain.
 *
 * Returns a session-consistent IP from the same /24 subnet as one of the
 * simulated DNS results for that domain. The same IP is returned for
 * the same domain within the cache TTL (5 min), simulating DoH session
 * affinity — real DoH resolvers maintain connection-level IP consistency.
 *
 * @param domain - The target domain
 * @returns A fake IP string, or null if domain is empty
 */

// Per-domain XFF cache for session affinity (same IP within TTL window)
const xffCache = new Map<string, { ip: string; createdAt: number }>();
const XFF_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — matches DNS cache TTL
const MAX_XFF_CACHE_SIZE = 200;

export function getForwardedFor(domain: string): string | null {
  if (!domain) return null;

  try {
    // Return cached XFF for session affinity
    const now = Date.now();
    const cachedXff = xffCache.get(domain);
    if (cachedXff && (now - cachedXff.createdAt) < XFF_CACHE_TTL_MS) {
      return cachedXff.ip;
    }

    const ips = resolveDomain(domain);
    if (ips.length === 0) return null;

    // Pick a random cached IP
    const baseIp = ips[Math.floor(Math.random() * ips.length)];
    const parts = baseIp.split('.');
    if (parts.length !== 4) return null;

    // Generate a random IP in the same /24 subnet (keep first 3 octets)
    parts[3] = String(randByte());
    const xff = parts.join('.');

    // Cache for session affinity (with eviction to prevent unbounded growth)
    if (xffCache.size >= MAX_XFF_CACHE_SIZE) {
      // Evict oldest entry
      let oldestKey = '';
      let oldestTime = Infinity;
      for (const [k, v] of xffCache) {
        if (v.createdAt < oldestTime) { oldestTime = v.createdAt; oldestKey = k; }
      }
      if (oldestKey) xffCache.delete(oldestKey);
    }
    xffCache.set(domain, { ip: xff, createdAt: now });
    return xff;
  } catch {
    return null;
  }
}

/**
 * Get the current cache size (for inspection/debugging).
 */
export function getDohCacheSize(): number {
  return dnsCache.size + xffCache.size;
}

/**
 * Clear all DNS caches — both simulation and real DoH.
 */
export function clearDohCache(): void {
  dnsCache.clear();
  xffCache.clear();
  clearRealDoHCache();
}
