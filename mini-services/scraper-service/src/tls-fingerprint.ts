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

import { domainHash } from './utils';

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
  browser: 'Chrome' | 'Firefox' | 'Safari' | 'Edge' | 'Samsung' | 'Brave' | 'Opera';
  options: TLSFingerprintOptions;
  /** Reference JA3 hash for verification (informational only) */
  ja3Ref?: string;
  /** Reference JA4 fingerprint for verification (informational only)
   *  JA4 = (protocol, cipher_count, extension_count)_(cipher_ids)_(extension_ids)_(alpn_ids)
   *  e.g., "t13d1511h2_002f,0035,009c,009d_0005,000a,000b,000d,0012,0015,0016,0017,001b,0023,002b,002d,0033,fe0d_02,6868"
   */
  ja4Ref?: string;
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
  // ---- Chrome Variants (131-135) ----
  {
    name: 'Chrome 135 Windows',
    browser: 'Chrome',
    options: {
      ciphers: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384',
      minVersion: 'TLSv1.2',
      sigalgs: 'ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:ecdsa_secp521r1_sha512',
    },
    ja3Ref: '771,4865-4866-4867-49195-49199-49200-52393,0-5-10-11-13-16-23-43-45-51-65281,29-23-24-25,0',
    ja4Ref: 't13d1511h2_002f,0035,009c,009d_0005,000a,000b,000d,0012,0015,0016,0017,001b,0023,002b,002d,0033,fe0d_02,6868',
  },
  {
    name: 'Chrome 134 Windows',
    browser: 'Chrome',
    options: {
      ciphers: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384',
      minVersion: 'TLSv1.2',
      sigalgs: 'ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:ecdsa_secp521r1_sha512',
    },
    ja3Ref: '771,4865-4866-4867-49195-49199-49200-52393,0-5-10-11-13-16-23-43-45-51-65281,29-23-24-25,0',
    ja4Ref: 't13d1511h2_002f,0035,009c,009d_0005,000a,000b,000d,0012,0015,0016,0017,001b,0023,002b,002d,0033,fe0d_02,6868',
  },
  {
    name: 'Chrome 133 Windows',
    browser: 'Chrome',
    options: {
      ciphers: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384',
      minVersion: 'TLSv1.2',
      sigalgs: 'ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:ecdsa_secp521r1_sha512',
    },
    ja3Ref: '771,4865-4866-4867-49195-49199-49200-52393,0-5-10-11-13-16-23-43-45-51-65281,29-23-24-25,0',
  },
  {
    name: 'Chrome 132 Windows',
    browser: 'Chrome',
    options: {
      ciphers: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384',
      minVersion: 'TLSv1.2',
      sigalgs: 'ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:ecdsa_secp521r1_sha512',
    },
    ja3Ref: '771,4865-4866-4867-49195-49199-49200-52393,0-5-10-11-13-16-23-43-45-51-65281,29-23-24-25,0',
  },
  {
    name: 'Chrome 131 Windows',
    browser: 'Chrome',
    options: {
      ciphers: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384',
      minVersion: 'TLSv1.2',
      sigalgs: 'ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:ecdsa_secp521r1_sha512',
    },
    ja3Ref: '771,4865-4866-4867-49195-49199-49200-52393,0-5-10-11-13-16-23-43-45-51-65281,29-23-24-25,0',
  },
  {
    name: 'Chrome 134+ macOS (CHACHA20 preferred)',
    browser: 'Chrome',
    options: {
      ciphers: 'TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384',
      minVersion: 'TLSv1.2',
      sigalgs: 'ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:ecdsa_secp521r1_sha512',
    },
    ja3Ref: '771,4867-4865-4866-49195-49199-49200-52393,0-5-10-11-13-16-23-43-45-51-65281,29-23-24-25,0',
  },
  {
    name: 'Chrome 131-133 Linux',
    browser: 'Chrome',
    options: {
      ciphers: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384',
      minVersion: 'TLSv1.2',
      sigalgs: 'ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:ecdsa_secp521r1_sha512',
    },
    ja3Ref: '771,4865-4866-4867-49199-49195-49200-52392,0-5-10-11-13-16-23-43-45-51-65281,29-23-24-25,0',
  },

  // ---- Firefox Variants (137-140) ----
  {
    name: 'Firefox 140',
    browser: 'Firefox',
    options: {
      ciphers: 'TLS_AES_128_GCM_SHA256:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_256_GCM_SHA384:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384',
      minVersion: 'TLSv1.2',
      sigalgs: 'ecdsa_secp256r1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha256:rsa_pss_pss_sha256:rsa_pkcs1_sha256:ecdsa_secp521r1_sha512:rsa_pss_rsae_sha512',
    },
    ja3Ref: '771,4865-4867-4866-49195-49199,0-5-10-11-13-23-43-45-51-65281,29-23-24,0',
    ja4Ref: 't13d1511h2_002f,0033,009c,009d_0005,000a,000b,000d,0017,002b,002d,0033,fe0d_02,6868',
  },
  {
    name: 'Firefox 139',
    browser: 'Firefox',
    options: {
      ciphers: 'TLS_AES_128_GCM_SHA256:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_256_GCM_SHA384:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384',
      minVersion: 'TLSv1.2',
      sigalgs: 'ecdsa_secp256r1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha256:rsa_pss_pss_sha256:rsa_pkcs1_sha256:ecdsa_secp521r1_sha512:rsa_pss_rsae_sha512',
    },
    ja3Ref: '771,4865-4867-4866-49195-49199,0-5-10-11-13-23-43-45-51-65281,29-23-24,0',
  },
  {
    name: 'Firefox 138',
    browser: 'Firefox',
    options: {
      ciphers: 'TLS_AES_128_GCM_SHA256:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_256_GCM_SHA384:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384',
      minVersion: 'TLSv1.2',
      sigalgs: 'ecdsa_secp256r1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha256:rsa_pss_pss_sha256:rsa_pkcs1_sha256:ecdsa_secp521r1_sha512:rsa_pss_rsae_sha512',
    },
    ja3Ref: '771,4865-4867-4866-49195-49199,0-5-10-11-13-23-43-45-51-65281,29-23-24,0',
  },
  {
    name: 'Firefox 137',
    browser: 'Firefox',
    options: {
      ciphers: 'TLS_AES_128_GCM_SHA256:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_256_GCM_SHA384:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384',
      minVersion: 'TLSv1.2',
      sigalgs: 'ecdsa_secp256r1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha256:rsa_pss_pss_sha256:rsa_pkcs1_sha256:ecdsa_secp521r1_sha512:rsa_pss_rsae_sha512',
    },
    ja3Ref: '771,4865-4867-4866-49195-49199,0-5-10-11-13-23-43-45-51-65281,29-23-24,0',
  },
  {
    name: 'Firefox 135-136',
    browser: 'Firefox',
    options: {
      ciphers: 'TLS_AES_128_GCM_SHA256:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_256_GCM_SHA384:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384',
      minVersion: 'TLSv1.2',
      sigalgs: 'ecdsa_secp256r1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha256:rsa_pss_pss_sha256:rsa_pkcs1_sha256:ecdsa_secp521r1_sha512:rsa_pss_rsae_sha512',
    },
    ja3Ref: '771,4865-4867-4866-49195-49199,0-5-10-11-13-23-43-45-51-65281,29-23-24,0',
  },
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

  // ---- Chrome Older Variants ----
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
    name: 'Edge 135 Windows',
    browser: 'Edge',
    options: {
      ciphers: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384',
      minVersion: 'TLSv1.2',
      sigalgs: 'ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:ecdsa_secp521r1_sha512',
    },
    ja3Ref: '771,4865-4866-4867-49195-49199-49200-52393,0-5-10-11-13-16-23-43-45-51-65281,29-23-24-25,0',
  },
  {
    name: 'Edge 134 Windows',
    browser: 'Edge',
    options: {
      ciphers: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384',
      minVersion: 'TLSv1.2',
      sigalgs: 'ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:ecdsa_secp521r1_sha512',
    },
    ja3Ref: '771,4865-4866-4867-49195-49199-49200-52393,0-5-10-11-13-16-23-43-45-51-65281,29-23-24-25,0',
  },
  {
    name: 'Edge 131-133 macOS (CHACHA20 preferred)',
    browser: 'Edge',
    options: {
      ciphers: 'TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384',
      minVersion: 'TLSv1.2',
      sigalgs: 'ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:ecdsa_secp521r1_sha512',
    },
    ja3Ref: '771,4867-4865-4866-49195-49199-49200-52393,0-5-10-11-13-16-23-43-45-51-65281,29-23-24-25,0',
  },

  // ---- Samsung Internet Variants ----
  {
    name: 'Samsung Internet 23 (Android 14)',
    browser: 'Samsung',
    options: {
      ciphers: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384',
      minVersion: 'TLSv1.2',
      sigalgs: 'ecdsa_secp256r1_sha256:ecdsa_secp384r1_sha384:ecdsa_secp521r1_sha512:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:rsa_pss_rsae_sha384:rsa_pss_rsae_sha512',
      alpn: 'h2, http/1.1',
    },
    ja3Ref: '771,4865-4866-4867-49195-49200-49199-52392,0-5-10-11-13-16-23-43-45-51-65281,29-23-24-25,0',
  },

  // ---- Brave Variants ----
  {
    name: 'Brave 1.70 (Desktop)',
    browser: 'Brave',
    options: {
      // Brave uses Chromium but with slightly different cipher preference:
      // ECDSA ciphers ranked higher than RSA (Brave's privacy-focused defaults)
      ciphers: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384',
      minVersion: 'TLSv1.2',
      sigalgs: 'ecdsa_secp256r1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:rsa_pss_rsae_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:ecdsa_secp521r1_sha512',
    },
    ja3Ref: '771,4865-4866-4867-49195-49200-49199-52392,0-5-10-11-13-16-23-43-45-51-65281,29-23-24-25,0',
  },

  // ---- Opera Variants ----
  {
    name: 'Opera GX (Desktop)',
    browser: 'Opera',
    options: {
      // Opera GX uses Chromium engine but CHACHA20 preferred (ARM-optimized builds)
      ciphers: 'TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384',
      minVersion: 'TLSv1.2',
      sigalgs: 'ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:ecdsa_secp521r1_sha512',
    },
    ja3Ref: '771,4867-4865-4866-49199-49195-49200-52392,0-5-10-11-13-16-23-43-45-51-65281,29-23-24-25,0',
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

// ==================== Browser Detection ====================

/**
 * Detect browser family from a User-Agent string.
 */
function detectBrowserFromUA(ua: string): 'Chrome' | 'Firefox' | 'Safari' | 'Edge' | 'Samsung' | 'Brave' | 'Opera' {
  if (ua.includes('Edg/')) return 'Edge';
  if (ua.includes('Samsung') || ua.includes('SM-')) return 'Samsung';
  if (ua.includes('Brave')) return 'Brave';
  if (ua.includes('OPR/') || ua.includes('Opera')) return 'Opera';
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
 * Get the JA4 fingerprint reference for the TLS variant selected for a domain.
 * Returns undefined if no JA4 reference is available for the selected variant.
 */
export function getTLSJA4Ref(domain: string): string | undefined {
  // Re-derive the variant to get JA4 ref
  const cached = domainTlsOptionsCache.get(domain);
  if (!cached) return undefined;

  // Find the matching variant to get ja4Ref
  const match = TLS_CIPHER_VARIANTS.find(v => v.name === cached.variantName);
  return match?.ja4Ref;
}

/**
 * Compute an approximate JA4 fingerprint string from TLS options.
 *
 * JA4 format: (protocol, cipher_count, extension_count)_(cipher_ids)_(extension_ids)_(alpn_ids)
 *
 * This is a simplified approximation since we can't access the actual TLS handshake
 * from the application layer. It derives the JA4 components from the cipher list
 * and other TLS options we control.
 *
 * @param options - TLS fingerprint options
 * @returns Approximate JA4 fingerprint string
 */
export function computeApproximateJA4(options: TLSFingerprintOptions): string {
  const ciphers = options.ciphers.split(':');
  const cipherCount = ciphers.length;

  // Protocol: t13 (TLS 1.3), t12 (TLS 1.2)
  const protocol = options.minVersion === 'TLSv1.3' ? 't13' : 't12';

  // Direction: 'd' for destination (client-initiated)
  const direction = 'd';

  // ALPN
  const alpnList = (options.alpn || 'h2,http/1.1').split(',').map(s => s.trim());
  const alpnHex = alpnList.map(a => {
    const hex = Buffer.from(a).toString('hex');
    return hex.length.toString(16).padStart(2, '0') + hex;
  }).join(',');

  // Extension count approximation (Chrome typically sends ~15 extensions)
  const extCount = 15;

  // Cipher suite hex IDs (simplified mapping for common ciphers)
  const cipherHexMap: Record<string, string> = {
    'TLS_AES_128_GCM_SHA256': '1301',
    'TLS_AES_256_GCM_SHA384': '1302',
    'TLS_CHACHA20_POLY1305_SHA256': '1303',
    'ECDHE-ECDSA-AES128-GCM-SHA256': 'c02b',
    'ECDHE-RSA-AES128-GCM-SHA256': 'c02f',
    'ECDHE-ECDSA-AES256-GCM-SHA384': 'c02c',
    'ECDHE-RSA-AES256-GCM-SHA384': 'c030',
    'ECDHE-RSA-AES128-SHA256': 'c027',
    'ECDHE-RSA-AES128-SHA': 'c013',
  };
  const cipherHex = ciphers.map(c => cipherHexMap[c] || '????').join(',');

  // Build JA4: t12d1511h2_ciphers_extensions_alpn
  const alpnCode = alpnList.includes('h2') ? 'h2' : 'h1';
  return `${protocol}${direction}${cipherCount}${extCount}${alpnCode}_${cipherHex}_*_${alpnHex}`;
}

// ==================== Per-Session TLS Rotation ====================

/**
 * Per-session TLS rotation: rotate the TLS fingerprint every N requests
 * within a session, not just per-domain. This prevents TLS fingerprint
 * correlation across many requests from the same apparent session.
 */

const sessionTlsState = new Map<string, {
  requestCount: number;
  rotateEvery: number; // rotate every N requests
  currentVariant: TLSCipherVariant;
  createdAt: number;
}>();
const MAX_SESSION_TLS = 500;
const SESSION_TLS_TTL_MS = 20 * 60 * 1000; // 20 minutes

/**
 * Get TLS fingerprint options with per-session rotation.
 * Rotates the TLS variant every `rotateEvery` requests within a session.
 *
 * @param sessionId - Session identifier for rotation tracking
 * @param domain - Target domain
 * @param ua - User-Agent string
 * @param rotateEvery - Rotate every N requests (default: 10)
 * @returns TLS options with rotation applied
 */
export function getSessionTLSFingerprintOptions(
  sessionId: string,
  domain: string,
  ua?: string,
  rotateEvery: number = 10
): TLSFingerprintOptions {
  const now = Date.now();
  const cacheKey = `${sessionId}:${domain}`;
  let state = sessionTlsState.get(cacheKey);

  // Check TTL
  if (state && (now - state.createdAt) > SESSION_TLS_TTL_MS) {
    sessionTlsState.delete(cacheKey);
    state = undefined;
  }

  if (!state) {
    // LRU eviction
    if (sessionTlsState.size >= MAX_SESSION_TLS) {
      const oldest = sessionTlsState.keys().next().value;
      if (oldest) sessionTlsState.delete(oldest);
    }

    // Pick initial variant for this session
    const browser = ua ? detectBrowserFromUA(ua) : 'Chrome';
    const h = domainHash(domain + sessionId);
    const candidates = TLS_CIPHER_VARIANTS.filter(v => v.browser === browser);
    const pool = candidates.length > 0 ? candidates : TLS_CIPHER_VARIANTS.filter(v => v.browser === 'Chrome');
    const variant = pool[h % pool.length]!;

    state = {
      requestCount: 0,
      rotateEvery,
      currentVariant: variant,
      createdAt: now,
    };
    sessionTlsState.set(cacheKey, state);
  }

  state.requestCount++;

  // Rotate if needed
  if (state.requestCount % state.rotateEvery === 0) {
    const browser = ua ? detectBrowserFromUA(ua) : 'Chrome';
    const candidates = TLS_CIPHER_VARIANTS.filter(v => v.browser === browser);
    const pool = candidates.length > 0 ? candidates : TLS_CIPHER_VARIANTS.filter(v => v.browser === 'Chrome');
    // Pick a different variant
    let newVariant: TLSCipherVariant;
    do {
      newVariant = pool[Math.floor(Math.random() * pool.length)]!;
    } while (pool.length > 1 && newVariant === state.currentVariant);
    state.currentVariant = newVariant;

    if (process.env.DEBUG === 'true') {
      console.log(`[TLS] Session ${sessionId.slice(0, 8)}: rotated to ${newVariant.name} after ${state.requestCount} requests`);
    }
  }

  return state.currentVariant.options;
}

// ==================== TLS Version Negotiation Order Randomization ====================

/**
 * TLS version negotiation order variants.
 * Some WAFs fingerprint the order of supported_versions extension.
 * Standard order: TLS 1.3, TLS 1.2
 * Randomized: sometimes present TLS 1.2 first in the extension list
 * (while still negotiating TLS 1.3 if server supports it).
 *
 * This affects the `minVersion` we pass to BoringSSL:
 * - 'TLSv1.2' means we support TLS 1.2+ (normal)
 * - 'TLSv1.3' means we only support TLS 1.3 (strict, rare)
 *
 * We can also randomize the cipher suite order slightly to create
 * subtle variations in the JA3/JA4 fingerprint.
 */

/**
 * Apply TLS version negotiation order randomization to TLS options.
 * Returns a new TLSFingerprintOptions with randomized cipher order.
 *
 * @param options - Base TLS options
 * @param randomizeLevel - 0 (none) to 3 (aggressive)
 * @returns TLS options with randomized order
 */
export function randomizeTLSNegotiationOrder(
  options: TLSFingerprintOptions,
  randomizeLevel: number = 1
): TLSFingerprintOptions {
  if (randomizeLevel === 0) return options;

  const ciphers = options.ciphers.split(':');

  if (randomizeLevel >= 1) {
    // Level 1: Swap the 2nd and 3rd TLS 1.3 ciphers with 50% probability
    // This creates a subtle but valid variation in JA3/JA4
    if (ciphers.length >= 3 && Math.random() < 0.5) {
      const tmp = ciphers[1];
      ciphers[1] = ciphers[2];
      ciphers[2] = tmp;
    }
  }

  if (randomizeLevel >= 2) {
    // Level 2: Also swap TLS 1.2 cipher pairs
    // TLS 1.2 ciphers start after the first 3 (TLS 1.3 ciphers)
    for (let i = 3; i < ciphers.length - 1; i += 2) {
      if (Math.random() < 0.3) {
        const tmp = ciphers[i];
        ciphers[i] = ciphers[i + 1];
        ciphers[i + 1] = tmp;
      }
    }
  }

  if (randomizeLevel >= 3) {
    // Level 3: Full Fisher-Yates shuffle of TLS 1.2 ciphers
    // WARNING: This may break cipher preference and reduce security
    // Only use for maximum fingerprint diversity when security is less critical
    for (let i = ciphers.length - 1; i > 3; i--) {
      const j = 3 + Math.floor(Math.random() * (i - 3 + 1));
      const tmp = ciphers[i];
      ciphers[i] = ciphers[j];
      ciphers[j] = tmp;
    }
  }

  return {
    ...options,
    ciphers: ciphers.join(':'),
  };
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

/**
 * Clear the per-session TLS rotation state.
 * If sessionId specified, only clear that session.
 */
export function clearSessionTLSCache(sessionId?: string): void {
  if (sessionId) {
    for (const key of sessionTlsState.keys()) {
      if (key.startsWith(sessionId + ':')) {
        sessionTlsState.delete(key);
      }
    }
  } else {
    sessionTlsState.clear();
  }
}
