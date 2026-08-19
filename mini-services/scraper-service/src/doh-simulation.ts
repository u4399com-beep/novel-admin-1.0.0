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
 * Generate a random private/reserved IP address for DNS simulation.
 * Uses 10.0.0.0/8, 172.16.0.0/12, or 192.168.0.0/16 ranges.
 */
function generateRandomIp(): string {
  const ranges = [
    () => `10.${randByte()}.${randByte()}.${randByte()}`,
    () => `172.${16 + Math.floor(Math.random() * 16)}.${randByte()}.${randByte()}`,
    () => `192.168.${randByte()}.${randByte()}`,
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
 * Returns a random IP from the same /24 subnet as one of the
 * simulated DNS results for that domain. This simulates DoH
 * behavior where requests may appear to come from different IPs
 * in the same subnet.
 *
 * @param domain - The target domain
 * @returns A fake IP string, or null if domain is empty
 */
export function getForwardedFor(domain: string): string | null {
  if (!domain) return null;

  try {
    const ips = resolveDomain(domain);
    if (ips.length === 0) return null;

    // Pick a random cached IP
    const baseIp = ips[Math.floor(Math.random() * ips.length)];
    const parts = baseIp.split('.');
    if (parts.length !== 4) return null;

    // Generate a random IP in the same /24 subnet (keep first 3 octets)
    parts[3] = String(randByte());
    return parts.join('.');
  } catch {
    return null;
  }
}

/**
 * Get the current cache size (for inspection/debugging).
 */
export function getDohCacheSize(): number {
  return dnsCache.size;
}

/**
 * Clear the DNS cache (for testing).
 */
export function clearDohCache(): void {
  dnsCache.clear();
}
