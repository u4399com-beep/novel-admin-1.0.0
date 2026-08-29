/**
 * DNS-over-HTTPS (DoH) Resolver
 *
 * Performs real DNS resolution via public DoH providers.
 * Fallback chain: AliDNS (China-friendly) → Cloudflare → Google.
 * Caches results with TTL from the DNS response (default 300s).
 *
 * Exported functions:
 *   - resolveDoH(domain, type?) — resolve a domain via DoH, returns IP strings
 *   - clearDoHCache() — clear the DoH result cache
 */

// ==================== Types ====================

type DnsRecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'NS' | 'TXT' | 'SRV';

interface DohAnswer {
  name: string;
  type: number;
  ttl: number;
  data: string;
}

interface DohResponse {
  Status: number;       // 0 = NOERROR
  TC: boolean;           // Truncated
  RD: boolean;           // Recursion Desired
  RA: boolean;           // Recursion Available
  AD: boolean;           // Authenticated Data
  CD: boolean;           // Checking Disabled
  Question: Array<{ name: string; type: number }>;
  Answer: DohAnswer[];
}

interface DohCacheEntry {
  ips: string[];
  expiresAt: number;     // absolute timestamp when this entry expires
  cachedAt: number;
  ttl: number;
}

// ==================== Provider Config ====================

/** Build a DoH query URL for a given domain and type. */
type DohProviderBuilder = (domain: string, type: string) => string;

interface DohProvider {
  name: string;
  buildUrl: DohProviderBuilder;
}

const DEFAULT_DOH_PROVIDERS: readonly DohProvider[] = [
  // AliDNS — China-friendly, first choice
  {
    name: 'AliDNS',
    buildUrl: (domain: string, type: string) =>
      `https://dns.alidns.com/resolve?name=${encodeURIComponent(domain)}&type=${type}`,
  },
  // Cloudflare — fast global resolver
  {
    name: 'Cloudflare',
    buildUrl: (domain: string, type: string) =>
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${type}`,
  },
  // Google — reliable fallback
  {
    name: 'Google',
    buildUrl: (domain: string, type: string) =>
      `https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=${type}`,
  },
];

/** Parse SCRAPER_DOH_PROVIDERS env var into provider list. Format: "name|url,name|url" */
function parseDoHProvidersFromEnv(): DohProvider[] {
  const envProviders = process.env.SCRAPER_DOH_PROVIDERS;
  if (!envProviders) return [...DEFAULT_DOH_PROVIDERS];

  const providers: DohProvider[] = [];
  for (const entry of envProviders.split(',').map(s => s.trim()).filter(Boolean)) {
    const sepIdx = entry.indexOf('|');
    if (sepIdx === -1) continue;
    const name = entry.slice(0, sepIdx).trim();
    const baseUrl = entry.slice(sepIdx + 1).trim();
    if (!name || !baseUrl) continue;
    providers.push({
      name,
      buildUrl: (domain: string, type: string) =>
        `${baseUrl}?name=${encodeURIComponent(domain)}&type=${type}`,
    });
  }
  return providers.length > 0 ? providers : [...DEFAULT_DOH_PROVIDERS];
}

const DOH_PROVIDERS = parseDoHProvidersFromEnv();

// ==================== Cache ====================

const dohCache = new Map<string, DohCacheEntry>();
const MAX_CACHE_SIZE = 500;
const DEFAULT_TTL_MS = 300_000; // 300s

function getCacheKey(domain: string, type: string): string {
  return `${domain.toLowerCase()}|${type}`;
}

function evictOldest(): void {
  if (dohCache.size < MAX_CACHE_SIZE) return;
  let oldestKey = '';
  let oldestTime = Infinity;
  for (const [key, entry] of dohCache) {
    if (entry.cachedAt < oldestTime) {
      oldestTime = entry.cachedAt;
      oldestKey = key;
    }
  }
  if (oldestKey) {
    dohCache.delete(oldestKey);
  }
}

// ==================== Core Resolver ====================

/**
 * Query a single DoH provider and parse the response.
 * Returns extracted IP addresses and the minimum TTL from the answers.
 */
async function queryProvider(
  domain: string,
  type: string,
  provider: DohProvider,
  timeoutMs: number,
): Promise<{ ips: string[]; ttl: number } | null> {
  const url = provider.buildUrl(domain, type);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/dns-json' },
    });

    if (!res.ok) return null;

    const json = (await res.json()) as DohResponse;

    // DNS Status 0 = NOERROR
    if (json.Status !== 0) return null;

    // Extract data from Answer section
    const ips: string[] = [];
    let minTtl = Infinity;

    // DNS record type numbers we care about
    const targetTypeNums: Record<string, number> = { A: 1, AAAA: 28, CNAME: 5 };
    const targetNum = targetTypeNums[type] ?? 1;

    for (const answer of json.Answer) {
      if (answer.type === targetNum) {
        ips.push(answer.data);
      }
      if (answer.ttl > 0 && answer.ttl < minTtl) {
        minTtl = answer.ttl;
      }
    }

    if (ips.length === 0) return null;

    return {
      ips,
      ttl: minTtl === Infinity ? Math.floor(DEFAULT_TTL_MS / 1000) : minTtl,
    };
  } catch {
    // Network error, timeout, parse error — return null to trigger fallback
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ==================== Public API ====================

/**
 * Resolve a domain using DNS-over-HTTPS with a fallback chain.
 * Tries AliDNS → Cloudflare → Google.
 *
 * @param domain - The domain name to resolve (e.g. "example.com")
 * @param type - DNS record type (default: "A")
 * @returns Array of IP addresses/records, or empty array if all providers fail
 */
export async function resolveDoH(
  domain: string,
  type: DnsRecordType = 'A',
): Promise<string[]> {
  if (!domain || typeof domain !== 'string') return [];

  const key = getCacheKey(domain, type);
  const now = Date.now();

  // Check cache
  const cached = dohCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.ips;
  }

  // Expired entry — remove it
  if (cached) {
    dohCache.delete(key);
  }

  // Try each provider in fallback chain
  const perProviderTimeout = 5000; // 5s per provider

  for (const provider of DOH_PROVIDERS) {
    const result = await queryProvider(domain, type, provider, perProviderTimeout);
    if (result && result.ips.length > 0) {
      // Cache the result with TTL
      evictOldest();
      const ttlMs = Math.max(result.ttl, 60) * 1000; // minimum 60s TTL
      dohCache.set(key, {
        ips: result.ips,
        expiresAt: now + ttlMs,
        cachedAt: now,
        ttl: result.ttl,
      });

      return result.ips;
    }
  }

  // All providers failed
  return [];
}

/**
 * Clear the DoH resolution cache.
 */
export function clearDoHCache(): void {
  dohCache.clear();
}
