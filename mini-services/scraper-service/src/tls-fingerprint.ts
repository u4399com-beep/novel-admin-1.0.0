/**
 * TLS Fingerprint (JA3) Approximation via Bun TLS Options
 *
 * While we can't fully control the JA3 hash (BoringSSL handles the actual handshake),
 * we CAN approximate it by controlling the cipher suite order, signature algorithms,
 * and TLS version — all of which are major components of JA3.
 *
 * JA3 is built from: TLSVersion, Ciphers, Extensions, EllipticCurves, EllipticCurvePointFormats
 *
 * Chrome 120 JA3 reference: 769,47-53-5-10-49161-49162-49171-49172-50327-50328,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24-25,0
 *
 * This module provides:
 *   1. Per-browser TLS options (ciphers, sigalgs, minVersion)
 *   2. TLS_CIPHER_VARIANTS pool for randomization across profiles
 *   3. Integration helper for undici Agent construction
 */

// ==================== Types ====================

/** TLS configuration options compatible with Bun's/BoringSSL's TLS client */
export interface TLSFingerprintOptions {
  /** Colon-separated cipher suite list (OpenSSL format, BoringSSL compatible) */
  ciphers: string;
  /** Minimum TLS version */
  minVersion: 'TLSv1.2' | 'TLSv1.3';
  /** Colon-separated signature algorithm list (BoringSSL format) */
  sigalgs?: string;
  /** ALPN protocol list (comma-separated, default 'h2, http/1.1') */
  alpn?: string;
}

/** A cipher variant representing a realistic browser TLS configuration */
export interface TLSCipherVariant {
  name: string;
  browser: 'Chrome' | 'Firefox' | 'Safari' | 'Edge';
  options: TLSFingerprintOptions;
  /** Reference JA3 hash for verification (informational only) */
  ja3Ref?: string;
}

// ==================== Cipher Variant Pool ====================

/**
 * Realistic TLS cipher variants that approximate different browser JA3 fingerprints.
 * Each variant has a different cipher order, which is the primary JA3 differentiator.
 *
 * The cipher strings use OpenSSL naming convention (BoringSSL compatible).
 * Order matters: the first cipher is the most preferred.
 *
 * Chrome variants have 8 ciphers (3 TLS 1.3 + 4 TLS 1.2 + fallback).
 * Firefox variants have 7 ciphers (3 TLS 1.3 + 3 TLS 1.2 + fallback).
 */
export const TLS_CIPHER_VARIANTS: TLSCipherVariant[] = [
  // ---- Chrome Variants ----
  {
    name: 'Chrome 131+ Windows',
    browser: 'Chrome',
    options: {
      ciphers: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384',
      minVersion: 'TLSv1.2',
      sigalgs: 'ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:ecdsa_secp521r1_sha512',
    },
    ja3Ref: '771,4865-4866-4867-49195-49199-49200-52393,0-5-10-11-13-16-23-43-45-51-65281,29-23-24-25,0',
  },
  {
    name: 'Chrome 131+ macOS (CHACHA20 preferred)',
    browser: 'Chrome',
    options: {
      ciphers: 'TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384',
      minVersion: 'TLSv1.2',
      sigalgs: 'ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:ecdsa_secp521r1_sha512',
    },
    ja3Ref: '771,4867-4865-4866-49195-49199-49200-52393,0-5-10-11-13-16-23-43-45-51-65281,29-23-24-25,0',
  },
  {
    name: 'Chrome 128-130 Linux',
    browser: 'Chrome',
    options: {
      ciphers: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384',
      minVersion: 'TLSv1.2',
      sigalgs: 'ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:ecdsa_secp521r1_sha512',
    },
    ja3Ref: '771,4865-4866-4867-49199-49195-49200-52392,0-5-10-11-13-16-23-43-45-51-65281,29-23-24-25,0',
  },
  {
    name: 'Chrome 120-127 (older)',
    browser: 'Chrome',
    options: {
      ciphers: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-RSA-AES128-SHA256:ECDHE-RSA-AES128-SHA',
      minVersion: 'TLSv1.2',
      sigalgs: 'ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:ecdsa_secp521r1_sha512',
    },
    ja3Ref: '771,4865-4866-4867-49195-49199-49200-52393-49199-49195,0-5-10-11-13-16-23-43-45-51-65281,29-23-24-25,0',
  },

  // ---- Firefox Variants ----
  {
    name: 'Firefox 128-134',
    browser: 'Firefox',
    options: {
      ciphers: 'TLS_AES_128_GCM_SHA256:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_256_GCM_SHA384:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384',
      minVersion: 'TLSv1.2',
      sigalgs: 'ecdsa_secp256r1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha256:rsa_pss_pss_sha256:rsa_pkcs1_sha256:ecdsa_secp521r1_sha512:rsa_pss_rsae_sha512',
    },
    ja3Ref: '771,4865-4867-4866-49195-49199,0-5-10-11-13-23-43-45-51-65281,29-23-24,0',
  },
  {
    name: 'Firefox 120-127',
    browser: 'Firefox',
    options: {
      ciphers: 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256',
      minVersion: 'TLSv1.2',
      sigalgs: 'ecdsa_secp256r1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha256:rsa_pss_pss_sha256:rsa_pkcs1_sha256:ecdsa_secp521r1_sha512:rsa_pss_rsae_sha512',
    },
    ja3Ref: '771,4866-4867-4865-49199-49200,0-5-10-11-13-23-43-45-51-65281,29-23-24,0',
  },

  // ---- Safari Variants ----
  {
    name: 'Safari 18.x macOS',
    browser: 'Safari',
    options: {
      ciphers: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-RSA-AES128-GCM-SHA256',
      minVersion: 'TLSv1.2',
    },
    ja3Ref: '771,4865-4866-4867-49199-49195,0-5-10-11-13-16-18-23-27-43-45-51-65281,29-23-24,0',
  },
  {
    name: 'Safari 17.x macOS',
    browser: 'Safari',
    options: {
      ciphers: 'TLS_AES_256_GCM_SHA384:TLS_AES_128_GCM_SHA256:TLS_CHACHA20_POLY1305_SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-RSA-AES128-GCM-SHA256',
      minVersion: 'TLSv1.2',
    },
    ja3Ref: '771,4866-4865-4867-49199-49195,0-5-10-11-13-16-18-23-27-43-45-51-65281,29-23-24,0',
  },

  // ---- Edge Variants ----
  {
    name: 'Edge 130+ Windows',
    browser: 'Edge',
    options: {
      ciphers: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384',
      minVersion: 'TLSv1.2',
      sigalgs: 'ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:ecdsa_secp521r1_sha512',
    },
    ja3Ref: '771,4865-4866-4867-49195-49199-49200-52393,0-5-10-11-13-16-23-43-45-51-65281,29-23-24-25,0',
  },
  {
    name: 'Edge 128-129 macOS',
    browser: 'Edge',
    options: {
      ciphers: 'TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384',
      minVersion: 'TLSv1.2',
      sigalgs: 'ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:ecdsa_secp521r1_sha512',
    },
    ja3Ref: '771,4867-4865-4866-49195-49199-49200-52393,0-5-10-11-13-16-23-43-45-51-65281,29-23-24-25,0',
  },
];

// ==================== Cache ====================

const domainTlsOptionsCache = new Map<string, TLSFingerprintOptions>();
const MAX_TLS_OPTIONS_CACHE = 500;
const TLS_OPTIONS_CACHE_TTL_MS = 20 * 60 * 1000; // 20 minutes

interface TLSOptionsCacheEntry {
  options: TLSFingerprintOptions;
  variantName: string;
  createdAt: number;
}

// ==================== Domain Hash ====================

function domainHash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// ==================== Browser Detection ====================

/**
 * Detect browser family from a User-Agent string.
 */
function detectBrowserFromUA(ua: string): 'Chrome' | 'Firefox' | 'Safari' | 'Edge' {
  if (ua.includes('Edg/')) return 'Edge';
  if (ua.includes('OPR/') || ua.includes('Opera')) return 'Chrome';
  if (ua.includes('Firefox/')) return 'Firefox';
  if (ua.includes('Chrome/')) return 'Chrome';
  if (ua.includes('Safari/') && ua.includes('Macintosh')) return 'Safari';
  return 'Chrome';
}

// ==================== Main API ====================

/**
 * Get TLS fingerprint options for a domain, matched to the UA's browser type.
 *
 * Selects from TLS_CIPHER_VARIANTS based on:
 *   1. Browser family (Chrome/Firefox/Safari/Edge) derived from the UA
 *   2. Domain hash for deterministic variant selection within a browser family
 *
 * The returned options can be passed to undici Agent's `connect` option:
 * ```ts
 * const tlsOpts = getTLSFingerprintOptions(domain, ua);
 * new Agent({ connect: { ...tlsOpts } });
 * ```
 *
 * @param domain - Target domain for consistent selection
 * @param ua - User-Agent string to determine browser family
 * @returns TLS options object with ciphers, minVersion, sigalgs
 */
export function getTLSFingerprintOptions(domain: string, ua?: string): TLSFingerprintOptions {
  const now = Date.now();
  const cached = domainTlsOptionsCache.get(domain);

  if (cached && (now - cached.createdAt) < TLS_OPTIONS_CACHE_TTL_MS) {
    return cached.options;
  }

  const browser = ua ? detectBrowserFromUA(ua) : 'Chrome';
  const h = domainHash(domain);

  // Filter variants by browser family
  const candidates = TLS_CIPHER_VARIANTS.filter(v => v.browser === browser);
  const pool = candidates.length > 0 ? candidates : TLS_CIPHER_VARIANTS.filter(v => v.browser === 'Chrome');

  // Deterministic selection
  const selected = pool[h % pool.length]!;

  // Evict oldest if cache is full
  if (domainTlsOptionsCache.size >= MAX_TLS_OPTIONS_CACHE && !domainTlsOptionsCache.has(domain)) {
    let oldestKey = '';
    let oldestTime = Infinity;
    for (const [key, entry] of domainTlsOptionsCache) {
      if (entry.createdAt < oldestTime) {
        oldestTime = entry.createdAt;
        oldestKey = key;
      }
    }
    if (oldestKey) domainTlsOptionsCache.delete(oldestKey);
  }

  domainTlsOptionsCache.set(domain, { options: selected.options, variantName: selected.name, createdAt: now });
  return selected.options;
}

/**
 * Get the name of the TLS variant selected for a domain (for debugging/logging).
 */
export function getTLSVariantName(domain: string): string {
  const cached = domainTlsOptionsCache.get(domain);
  return cached?.variantName || 'unknown';
}

/**
 * Clear the TLS options cache. If domain specified, only clear that domain.
 */
export function clearTLSOptionsCache(domain?: string): void {
  if (domain) {
    domainTlsOptionsCache.delete(domain);
  } else {
    domainTlsOptionsCache.clear();
  }
}
