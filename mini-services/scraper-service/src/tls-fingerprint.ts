/**
 * TLS Fingerprint (JA3/JA4) Approximation via Bun TLS Options
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
 *   4. JA3/JA4 fingerprint rotation with realistic browser profiles
 *   5. TLS session resumption simulation
 *   6. Per-domain TLS profile persistence
 */

import { logger } from './logger';
const log = logger.child('TlsFingerprint');

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

// ==================== JA3/JA4 Fingerprint Rotation ====================

/**
 * JA3/JA4 fingerprint rotation with realistic browser profiles.
 *
 * Rotates the TLS fingerprint on a schedule that mimics how real users
 * might switch browsers or have their TLS stack update. This defeats
 * TLS fingerprint correlation across many requests.
 *
 * Rotation schedule:
 *   - Every 10-30 requests within a session (configurable)
 *   - When the current profile has been used for > 30 minutes
 *   - On detection of TLS fingerprint blocking (optional)
 *
 * Browser profile selection is weighted by real-world market share:
 *   - Chrome: 65%, Firefox: 15%, Safari: 10%, Edge: 5%, Other: 5%
 */

/** Browser market share weights for realistic rotation */
const BROWSER_MARKET_SHARE: Record<string, number> = {
  Chrome: 0.65,
  Firefox: 0.15,
  Safari: 0.10,
  Edge: 0.05,
  Brave: 0.03,
  Opera: 0.01,
  Samsung: 0.01,
};

/**
 * Select a TLS variant weighted by browser market share.
 * This produces a more realistic distribution than uniform random.
 */
export function selectVariantByMarketShare(): TLSCipherVariant {
  // Weighted random selection
  const roll = Math.random();
  let cumulative = 0;
  let selectedBrowser = 'Chrome';
  for (const [browser, share] of Object.entries(BROWSER_MARKET_SHARE)) {
    cumulative += share;
    if (roll < cumulative) {
      selectedBrowser = browser;
      break;
    }
  }

  const candidates = TLS_CIPHER_VARIANTS.filter(v => v.browser === selectedBrowser);
  const pool = candidates.length > 0 ? candidates : TLS_CIPHER_VARIANTS.filter(v => v.browser === 'Chrome');
  return pool[Math.floor(Math.random() * pool.length)]!;
}

/**
 * Compute JA3 fingerprint hash from TLS options (approximate).
 * Used for tracking which JA3 fingerprints have been used.
 */
export function computeApproximateJA3(options: TLSFingerprintOptions): string {
  // Simplified JA3 approximation: hash the cipher order + sigalgs + version
  const components = [
    options.minVersion === 'TLSv1.3' ? '772' : '771',
    options.ciphers,
    options.sigalgs || '',
  ].join('|');
  // Simple hash (djb2)
  let hash = 5381;
  for (let i = 0; i < components.length; i++) {
    hash = ((hash << 5) + hash + components.charCodeAt(i)) & 0xFFFFFFFF;
  }
  return hash.toString(16).padStart(8, '0');
}

// ==================== TLS Session Resumption Simulation ====================

/**
 * TLS session resumption simulation.
 *
 * Real browsers reuse TLS sessions (session IDs or session tickets) across
 * requests to the same host. This module simulates that behavior by tracking
 * "virtual session" state per domain, including:
 *   - Session ID / ticket generation
 *   - Session age (real sessions age out after ~2 hours)
 *   - Session reuse count (real browsers reuse ~10-50 times)
 *
 * This makes the TLS connection pattern look more like a real browser
 * that maintains persistent connections with session resumption.
 */

export interface TLSSessionState {
  /** Domain this session is for */
  domain: string;
  /** Virtual session ID (hex) */
  sessionId: string;
  /** When the session was established */
  establishedAt: number;
  /** How many times this session has been "resumed" */
  resumeCount: number;
  /** Maximum resumes before rotation (10-50, mimics real browsers) */
  maxResumes: number;
  /** Whether the session is still valid */
  isValid: boolean;
}

const MAX_SESSION_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours (typical session ticket lifetime)
const tlsSessionCache = new Map<string, TLSSessionState>();
const MAX_TLS_SESSIONS = 500;

/**
 * Get or create a TLS session state for a domain.
 * Simulates TLS session resumption by tracking virtual session state.
 *
 * @param domain - Target domain
 * @returns TLS session state (for header hinting / connection reuse tracking)
 */
export function getTLSSessionState(domain: string): TLSSessionState {
  const now = Date.now();
  let session = tlsSessionCache.get(domain);

  // Check if session is expired or exceeded max resumes
  if (session && (
    (now - session.establishedAt) > MAX_SESSION_AGE_MS ||
    session.resumeCount >= session.maxResumes ||
    !session.isValid
  )) {
    tlsSessionCache.delete(domain);
    session = undefined;
  }

  if (!session) {
    // LRU eviction
    if (tlsSessionCache.size >= MAX_TLS_SESSIONS) {
      const oldest = tlsSessionCache.keys().next().value;
    if (oldest) tlsSessionCache.delete(oldest);
    }

    // Generate virtual session ID (16 bytes hex)
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const sid = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

    session = {
      domain,
      sessionId: sid,
      establishedAt: now,
      resumeCount: 0,
      maxResumes: 10 + Math.floor(Math.random() * 40), // 10-50
      isValid: true,
    };
    tlsSessionCache.set(domain, session);
  }

  session.resumeCount++;
  return session;
}

/**
 * Invalidate a TLS session for a domain (e.g., after connection reset).
 */
export function invalidateTLSSession(domain: string): void {
  const session = tlsSessionCache.get(domain);
  if (session) session.isValid = false;
}

/**
 * Get stats about TLS session cache.
 */
export function getTLSSessionStats(): { activeSessions: number; totalDomains: number } {
  return {
    activeSessions: Array.from(tlsSessionCache.values()).filter(s => s.isValid).length,
    totalDomains: tlsSessionCache.size,
  };
}

// ==================== Per-Domain TLS Profile Persistence ====================

/**
 * Per-domain TLS profile persistence.
 *
 * Ensures that once a TLS profile is selected for a domain, it remains
 * consistent across the scraping session. This is important because:
 *   1. Real browsers maintain TLS session state per host
 *   2. Switching TLS fingerprints mid-session is a detection signal
 *   3. Some WAFs track TLS fingerprint changes per source IP
 *
 * The profile is persisted for the duration of the scraping session
 * (configurable TTL, default 30 minutes), then rotated naturally.
 */

export interface DomainTLSProfile {
  domain: string;
  variant: TLSCipherVariant;
  ja3Hash: string;
  ja4Fingerprint: string;
  sessionState: TLSSessionState;
  assignedAt: number;
  requestCount: number;
}

const domainProfileCache = new Map<string, DomainTLSProfile>();
const MAX_DOMAIN_PROFILES = 500;
const DOMAIN_PROFILE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Get or assign a persistent TLS profile for a domain.
 * The profile remains stable for the TTL duration, then rotates.
 *
 * @param domain - Target domain
 * @param ua - User-Agent string for browser matching
 * @returns Persistent TLS profile for the domain
 */
export function getDomainTLSProfile(domain: string, ua?: string): DomainTLSProfile {
  const now = Date.now();
  let profile = domainProfileCache.get(domain);

  // Check TTL expiry
  if (profile && (now - profile.assignedAt) > DOMAIN_PROFILE_TTL_MS) {
    domainProfileCache.delete(domain);
    profile = undefined;
  }

  if (!profile) {
    // LRU eviction
    if (domainProfileCache.size >= MAX_DOMAIN_PROFILES && !domainProfileCache.has(domain)) {
      let oldestKey = '';
      let oldestTime = Infinity;
      for (const [key, p] of domainProfileCache) {
        if (p.assignedAt < oldestTime) {
          oldestTime = p.assignedAt;
          oldestKey = key;
        }
      }
      if (oldestKey) domainProfileCache.delete(oldestKey);
    }

    // Select variant: prefer market-share weighted, fallback to UA-matched
    const browser = ua ? detectBrowserFromUA(ua) : undefined;
    let variant: TLSCipherVariant;

    if (browser) {
      // UA-matched selection (deterministic for consistency)
      const h = domainHash(domain);
      const candidates = TLS_CIPHER_VARIANTS.filter(v => v.browser === browser);
      const pool = candidates.length > 0 ? candidates : TLS_CIPHER_VARIANTS.filter(v => v.browser === 'Chrome');
      variant = pool[h % pool.length]!;
    } else {
      // Market-share weighted selection
      variant = selectVariantByMarketShare();
    }

    const options = variant.options;
    const ja3Hash = computeApproximateJA3(options);
    const ja4Fingerprint = computeApproximateJA4(options);
    const sessionState = getTLSSessionState(domain);

    profile = {
      domain,
      variant,
      ja3Hash,
      ja4Fingerprint,
      sessionState,
      assignedAt: now,
      requestCount: 0,
    };
    domainProfileCache.set(domain, profile);
  }

  profile.requestCount++;
  return profile;
}

/**
 * Force rotation of a domain's TLS profile (e.g., after fingerprint detection).
 */
export function rotateDomainTLSProfile(domain: string): void {
  domainProfileCache.delete(domain);
  invalidateTLSSession(domain);
}

/**
 * Get stats about domain TLS profiles.
 */
export function getDomainTLSProfileStats(): { totalProfiles: number; profileDetails: Array<{ domain: string; variant: string; ja3: string; requests: number; age: number }> } {
  const now = Date.now();
  const profileDetails = Array.from(domainProfileCache.values()).map(p => ({
    domain: p.domain,
    variant: p.variant.name,
    ja3: p.ja3Hash,
    requests: p.requestCount,
    age: Math.round((now - p.assignedAt) / 1000),
  }));
  return { totalProfiles: domainProfileCache.size, profileDetails };
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
      log.info(` Session ${sessionId.slice(0, 8)}: rotated to ${newVariant.name} after ${state.requestCount} requests`);
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
