/**
 * DNS-over-HTTPS (DoH) Simulation
 *
 * Some anti-bot systems detect direct (non-DoH) DNS queries or attempt to
 * correlate DNS resolution with HTTP requests. This module simulates DoH
 * behavior by maintaining a small DNS cache and generating synthetic
 * X-Forwarded-For headers from the same /24 subnet as cached DNS results.
 *
 * This makes each request appear to come from a different IP within the
 * same subnet, mimicking the behavior of a DoH resolver that may route
 * through different exit nodes.
 */

const MAX_CACHE_SIZE = 100;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface DnsCacheEntry {
  ips: string[];
  createdAt: number;
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
 * Resolve (simulate) a domain to a set of IPs.
 * Returns cached IPs if available and not expired, otherwise generates new ones.
 */
function resolveDomain(domain: string): string[] {
  const now = Date.now();
  const cached = dnsCache.get(domain);

  if (cached && (now - cached.createdAt) < CACHE_TTL_MS) {
    return cached.ips;
  }

  // Generate 2-4 IPs for this domain (simulating DNS round-robin)
  const count = 2 + Math.floor(Math.random() * 3);
  const ips: string[] = [];
  for (let i = 0; i < count; i++) {
    ips.push(generateRandomIp());
  }

  // Evict if cache is full
  if (dnsCache.size >= MAX_CACHE_SIZE && !dnsCache.has(domain)) {
    // Evict oldest entry
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

  dnsCache.set(domain, { ips, createdAt: now });
  return ips;
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
 * Clear the DNS cache (for testing).
 */
export function clearDohCache(): void {
  dnsCache.clear();
  xffCache.clear();
}
