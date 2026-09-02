/**
 * Obscura Stealth Engine - Anti-fingerprint browser injection
 *
 * Provides comprehensive browser fingerprint randomization and stealth injection
 * scripts to evade bot detection systems. Designed for use with Playwright-based
 * headless browsers via `page.addInitScript()`.
 *
 * Components:
 *   - FingerprintProfile: random but consistent browser identity
 *   - getStealthScript(): JS injection string that overrides all detectable APIs
 */

import { domainHash } from './utils';

// ==================== Fingerprint Profile ====================

export interface FingerprintProfile {
  /** WebGL vendor string */
  webglVendor: string;
  /** WebGL renderer (GPU) string */
  webglRenderer: string;
  /** Screen width in pixels */
  screenWidth: number;
  /** Screen height in pixels */
  screenHeight: number;
  /** navigator.deviceMemory (GB) */
  deviceMemory: number;
  /** navigator.hardwareConcurrency (CPU cores) */
  hardwareConcurrency: number;
  /** navigator.platform */
  platform: string;
  /** navigator.languages */
  languages: string[];
  /** IANA timezone name */
  timezone: string;
  /** Date.getTimezoneOffset() in minutes (negative = east of UTC) */
  timezoneOffset: number;
  /** screen.colorDepth */
  colorDepth: number;
  /** window.devicePixelRatio */
  pixelRatio: number;
  /** User-Agent string (matched to platform/GPU) */
  userAgent: string;
  /** Deterministic seed for this profile (for caching) */
  seed: string;
}

// ---- Data pools for randomization ----

const WEBGL_VENDORS = [
  "Google Inc. (NVIDIA)",
  "Google Inc. (Intel)",
  "Google Inc. (AMD)",
  "Google Inc. (Apple)",
] as const;

const WEBGL_RENDERERS: Record<string, string[]> = {
  // Win32 renderers (Direct3D11 via ANGLE)
  "Google Inc. (NVIDIA)": [
    "ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  ],
  "Google Inc. (Intel)": [
    "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  ],
  "Google Inc. (AMD)": [
    "ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "ANGLE (AMD, AMD Radeon RX 7600 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  ],
  // macOS renderers (Apple Silicon / Metal)
  "Google Inc. (Apple)": [
    "Apple GPU",
    "Apple M1",
    "Apple M2",
    "Apple M3",
  ],
  // Linux renderers (OpenGL / Mesa — NO Direct3D11)
  "Mesa": [
    "Mesa Intel(R) UHD Graphics 630 (CFL GT2)",
    "Mesa Intel(R) UHD Graphics 770 (ADL-S GT1)",
    "Mesa Intel(R) Iris(R) Xe Graphics (TGL GT2)",
    "Mesa AMD RADV NAVI10 (ACO)",
    "Mesa AMD RADV NAVI21 (ACO)",
    "Mesa NVIDIA GeForce GTX 1660 Ti (NVIDIA LLVM 15.0.7)",
    "Mesa NVIDIA GeForce RTX 3060 (NVIDIA LLVM 15.0.7)",
  ],
};

// Linux ANGLE renderers (Chrome/Edge on Linux use ANGLE with OpenGL backend)
const WEBGL_RENDERERS_LINUX_ANGLE: Record<string, string[]> = {
  "Google Inc. (NVIDIA)": [
    "ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Ti OpenGL ES 3.2 NVIDIA 525.147.05, OpenGL)",
    "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 OpenGL ES 3.2 NVIDIA 535.129.03, OpenGL)",
  ],
  "Google Inc. (Intel)": [
    "ANGLE (Intel, Intel(R) UHD Graphics 630 OpenGL ES 3.2 Mesa 23.2.1, OpenGL)",
  ],
  "Google Inc. (AMD)": [
    "ANGLE (AMD, AMD Radeon RX 580 OpenGL ES 3.2 Mesa 23.2.1, OpenGL)",
  ],
};

const SCREEN_RESOLUTIONS: Array<{ w: number; h: number }> = [
  { w: 1920, h: 1080 },
  { w: 1366, h: 768 },
  { w: 2560, h: 1440 },
  { w: 1536, h: 864 },
  { w: 1440, h: 900 },
  { w: 2560, h: 1080 },
  { w: 1280, h: 720 },
  { w: 1600, h: 900 },
  { w: 1680, h: 1050 },
  { w: 1280, h: 800 },
];

const DEVICE_MEMORY_OPTIONS = [2, 4, 8] as const;
const HARDWARE_CONCURRENCY_OPTIONS = [4, 8, 12, 16] as const;
const PLATFORMS = ["Win32", "MacIntel", "Linux x86_64"] as const;
const COLOR_DEPTHS = [24, 32] as const;
const PIXEL_RATIOS = [1, 1.25, 1.5, 2] as const;

/** Timezone pool — all UTC+8 to keep timezoneOffset exactly -480 */
const TIMEZONE_POOL = ['Asia/Shanghai', 'Asia/Chongqing', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Singapore'] as const;

/** Language variant pool — zh-CN as primary but with slight order variation */
const LANGUAGE_VARIANTS: readonly (readonly string[])[] = [
  ['zh-CN', 'zh', 'en-US', 'en'],
  ['zh-CN', 'zh', 'en'],
  ['zh-CN', 'en-US', 'en', 'zh'],
  ['zh-TW', 'zh', 'en-US', 'en'],
];

// Chrome user-agents indexed by platform for consistency
const UA_TEMPLATES: Record<string, string[]> = {
  Win32: [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  ],
  MacIntel: [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; ARM Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; ARM Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  ],
  "Linux x86_64": [
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  ],
  Edge: [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0",
  ],
  Firefox: [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0",
    "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
    "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
  ],
};

// Browser weights for weighted UA rotation (approximate 2024-2025 desktop share)
// Note: Safari is excluded here because stealth injection only supports Chromium/Firefox profiles.
// Safari UAs are available via utils.ts for CheerioEngine (non-JS) requests.
const UA_BROWSER_WEIGHTS: Record<string, number> = {
  Chrome: 75,
  Edge: 13,
  Firefox: 12,
};

// Pre-computed Chrome UA pool (all platforms combined)
const ALL_CHROME_UAS: string[] = [
  ...UA_TEMPLATES["Win32"],
  ...UA_TEMPLATES["MacIntel"],
  ...UA_TEMPLATES["Linux x86_64"],
];

// Browser-keyed UA pools
const BROWSER_UA_POOLS: Record<string, string[]> = {
  Chrome: ALL_CHROME_UAS,
  Edge: UA_TEMPLATES["Edge"]!,
  Firefox: UA_TEMPLATES["Firefox"]!,
};

/**
 * Pick a random UA from the weighted browser pool.
 * @param browser - Optional specific browser ('Chrome' | 'Edge' | 'Firefox'). If omitted, uses weighted random selection.
 */
export function getRandomUA(browser?: string): string {
  let selectedBrowser = browser;
  if (!selectedBrowser) {
    const r = Math.random() * 100;
    if (r < 75) selectedBrowser = "Chrome";
    else if (r < 88) selectedBrowser = "Edge";
    else selectedBrowser = "Firefox";
  }

  const pool = BROWSER_UA_POOLS[selectedBrowser] || ALL_CHROME_UAS;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ---- Helpers ----

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ==================== Profile Generation ====================

/** Derive navigator.platform from UA string to avoid fingerprint contradictions. */
function derivePlatformFromUA(ua: string): string {
  if (/Edg\\//.test(ua)) {
    if (/Macintosh/.test(ua)) return 'MacIntel';
    if (/Linux/.test(ua)) return 'Linux x86_64';
    return 'Win32';
  }
  if (/Firefox\\//.test(ua)) {
    if (/Macintosh/.test(ua)) return 'MacIntel';
    if (/Linux/.test(ua)) return 'Linux x86_64';
    return 'Win32';
  }
  // Chrome/Chromium
  if (/Macintosh/.test(ua)) return 'MacIntel';
  if (/Linux/.test(ua)) return 'Linux x86_64';
  return 'Win32';
}

/**
 * Generate a deterministic fingerprint profile from a seed string.
 * Same seed always produces the same profile (for per-domain caching).
 */
export function generateFingerprintProfile(seed?: string): FingerprintProfile {
  // Simple seeded random — uses seed for deterministic output, falls back to true random
  const s = seed || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    hash = ((hash << 5) - hash + ch) | 0;
  }

  // Deterministic pick using hash
  function dPick<T>(arr: readonly T[], offset = 0): T {
    const idx = (Math.imul((hash * (offset + 1)) >>> 0, 2654435761) >>> 0) % arr.length;
    return arr[idx];
  }

  const resolution = dPick(SCREEN_RESOLUTIONS, 3);

  // Weighted browser selection (deterministic via seed)
  const weightedBrowsers: string[] = [];
  for (const [b, w] of Object.entries(UA_BROWSER_WEIGHTS)) {
    for (let i = 0; i < w; i++) weightedBrowsers.push(b);
  }
  const selectedBrowser = dPick(weightedBrowsers, 10);
  const uaPool = BROWSER_UA_POOLS[selectedBrowser] || ALL_CHROME_UAS;
  const userAgent = dPick(uaPool, 5);

  // Derive platform from UA to avoid contradictions (Edge UA + Mac platform = detectable)
  const uaPlatform = derivePlatformFromUA(userAgent);
  // Re-derive vendor for UA-consistent platform
  // NOTE: Only Firefox on Linux uses Mesa vendor/renderer.
  // Chrome/Edge on Linux use ANGLE (same as Windows) — Mesa + Chrome is a detection vector.
  const isLinux = uaPlatform === 'Linux x86_64';
  const isFirefoxUA = /Firefox\\//.test(userAgent);
  let vendor: string;
  if (uaPlatform === 'MacIntel') {
    vendor = 'Google Inc. (Apple)';
  } else if (isLinux && isFirefoxUA) {
    vendor = 'Mesa';
  } else {
    const nonAppleVendors = WEBGL_VENDORS.filter(v => v !== 'Google Inc. (Apple)');
    vendor = dPick(nonAppleVendors.length > 0 ? nonAppleVendors : WEBGL_VENDORS, 1);
  }
  const uaRenderers = (isLinux && !isFirefoxUA && WEBGL_RENDERERS_LINUX_ANGLE[vendor])
    ? WEBGL_RENDERERS_LINUX_ANGLE[vendor]!
    : (WEBGL_RENDERERS[vendor] || WEBGL_RENDERERS["Google Inc. (NVIDIA)"]!);
  const renderer = dPick(uaRenderers, 2);

  const deviceMemory = dPick(DEVICE_MEMORY_OPTIONS, 6);
  const hardwareConcurrency = dPick(HARDWARE_CONCURRENCY_OPTIONS, 7);
  const colorDepth = dPick(COLOR_DEPTHS, 8);
  const pixelRatio = dPick(PIXEL_RATIOS, 9);

  // All timezones in TIMEZONE_POOL are UTC+8 = -480 minutes exactly.
  // Jitter must NOT be applied here — a mismatch between timezone name and offset is a detection vector.
  const timezoneOffset = -480;

  return {
    webglVendor: vendor,
    webglRenderer: renderer,
    screenWidth: resolution.w,
    screenHeight: resolution.h,
    deviceMemory,
    hardwareConcurrency,
    platform: uaPlatform,
    languages: [...dPick(LANGUAGE_VARIANTS, 11)],
    timezone: dPick(TIMEZONE_POOL, 12),
    timezoneOffset,
    colorDepth,
    pixelRatio,
    userAgent,
    seed: s,
  };
}

/**
 * Generate a random fingerprint profile (non-deterministic).
 */
export function generateRandomFingerprint(): FingerprintProfile {
  const resolution = pick(SCREEN_RESOLUTIONS);
  // Use weighted browser pool for UA selection
  const userAgent = getRandomUA();

  // Derive platform from UA to avoid contradictions (Edge UA + Mac platform = detectable)
  const uaPlatform = derivePlatformFromUA(userAgent);
  // Re-derive vendor for UA-consistent platform
  // NOTE: Only Firefox on Linux uses Mesa vendor/renderer.
  // Chrome/Edge on Linux use ANGLE (same as Windows) — Mesa + Chrome is a detection vector.
  const isLinux = uaPlatform === 'Linux x86_64';
  const isFirefoxUA = /Firefox\\//.test(userAgent);
  let vendor: string;
  if (uaPlatform === 'MacIntel') {
    vendor = 'Google Inc. (Apple)';
  } else if (isLinux && isFirefoxUA) {
    vendor = 'Mesa';
  } else {
    const nonAppleVendors = WEBGL_VENDORS.filter(v => v !== 'Google Inc. (Apple)');
    vendor = pick(nonAppleVendors.length > 0 ? nonAppleVendors : WEBGL_VENDORS);
  }
  const uaRenderers = (isLinux && !isFirefoxUA && WEBGL_RENDERERS_LINUX_ANGLE[vendor])
    ? WEBGL_RENDERERS_LINUX_ANGLE[vendor]!
    : (WEBGL_RENDERERS[vendor] || WEBGL_RENDERERS["Google Inc. (NVIDIA)"]!);
  const renderer = pick(uaRenderers);

  const timezoneOffset = -480;

  return {
    webglVendor: vendor,
    webglRenderer: renderer,
    screenWidth: resolution.w,
    screenHeight: resolution.h,
    deviceMemory: pick(DEVICE_MEMORY_OPTIONS),
    hardwareConcurrency: pick(HARDWARE_CONCURRENCY_OPTIONS),
    platform: uaPlatform,
    languages: [...pick(LANGUAGE_VARIANTS)],
    timezone: pick(TIMEZONE_POOL),
    timezoneOffset,
    colorDepth: pick(COLOR_DEPTHS),
    pixelRatio: pick(PIXEL_RATIOS),
    userAgent,
    seed: `random-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
}

// ==================== Per-Domain UA Consistency Cache ====================

const domainUACache = new Map<string, string>();
const MAX_DOMAIN_UA_CACHE = 500;

/**
 * Get a consistent UA for a domain. Same domain always returns the same UA
 * (until the cache is cleared or evicted).
 */
export function getConsistentUAForDomain(domain: string): string {
  let ua = domainUACache.get(domain);
  if (!ua) {
    ua = getRandomUA();
    // Evict oldest if at capacity
    if (domainUACache.size >= MAX_DOMAIN_UA_CACHE && !domainUACache.has(domain)) {
      const firstKey = domainUACache.keys().next().value;
      if (firstKey) domainUACache.delete(firstKey);
    }
    domainUACache.set(domain, ua);
  }
  return ua;
}

/**
 * Clear the domain UA cache. If domain is specified, only clears that domain.
 */
export function clearDomainUACache(domain?: string): void {
  if (domain) {
    domainUACache.delete(domain);
  } else {
    domainUACache.clear();
  }
}

// ==================== Stealth Injection Script ====================

/**
 * Generate a comprehensive JavaScript stealth injection script for `page.addInitScript()`.
 *
 * This script overrides ALL major browser fingerprinting vectors:
 * 1.  Navigator properties (webdriver, plugins, languages, hardware, etc.)
 * 2.  Chrome runtime object
 * 3.  WebGL vendor/renderer
 * 4.  Canvas fingerprint noise (toDataURL, toBlob, getImageData, configurable intensity)
 * 6.  Screen/window properties (with seed-varying orientation angle)
 * 7.  WebRTC leak prevention
 * 8.  Permission API consistency
 * 9.  IFrame contentWindow overrides
 * 10. Date/timezone consistency
 * 11. Automation property removal
 * 12. MouseEvent / KeyboardEvent consistency
 * 14. Storage consistency
 * 15. IFrame stealth propagation via MutationObserver
 * 16. ClientRects & getBoundingClientRect spoofing (layout fingerprint prevention)
 * 17. Enhanced Connection / Network Information API
 * 20. Canvas getImageData per-pixel deterministic noise (intensity-scaled)
 * 22. Font detection countermeasure (document.fonts.check override)
 * 23. Platform-based Plugin/MimeType enumeration (3-4 plugins per platform)
 * 24. Console detection evasion
 * 25. Performance.now() offset & micro-jitter (±0.5ms)
 * 26. Mouse event listeners (capture-phase, passive)
 * 27. Touch support spoofing (mobile UA detection, TouchEvent constructor)
 * 28. MediaDevices enumerateDevices() fake (deterministic device IDs from seed)
 * 29. Battery API getBattery() override (realistic level + charging state)
 * 30. Canvas toDataURL/toBlob noise injection (delegates to patched getImageData)
 * 31. AudioContext/OfflineAudioContext createOscillator frequency noise
 * 32. NavigationTiming override (h2 protocol, realistic timing chain)
 * 33. PerformanceObserver neutralization (7 entry types)
 * 34. iframe self/top bypass
 * 35. Notification.permission mock
 * 36. document.hasFocus() — always returns true
 * 38. Permissions.query() — realistic permission states
 * 39. document.visibilityState / hidden — always visible
 * 40. ServiceWorker / SharedWorker existence consistency
 * 41. CSS.supports() consistency override
 * 44. ResizeObserver / IntersectionObserver existence mock
 * 45. getComputedStyle cursor consistency
 * 46. matchMedia prefers-color-scheme / prefers-reduced-motion consistency
 * 47. WebGL Shader Precision (getShaderPrecisionFormat zero-range fix)
 * 48. Navigator Connection API (create fake if missing; Section 17 handles override)
 * 51. speechSynthesis.getVoices() enhanced mock (per-seed voices, async loading)
 * 52. Notification.permission consistency (force 'default')
 * 55. performance.memory realistic values (Chrome-specific)
 * 57. Window frame dimensions (chrome frame) fix (seeded consistency)
 * 58. navigator.connection effectiveType consistency (W3C spec thresholds)
 * 59. SharedArrayBuffer / crossOriginIsolated consistency
 * 60. Font enumeration protection (document.fonts.forEach + check)
 * 61. Gamepad API override (getGamepads consistency)
 * 62. navigator.doNotTrack consistency
 * 99. Fingerprint Consistency Validator (cross-property checks)
 * 100. OffscreenCanvas fingerprint alignment (R55: getImageData/measureText/convertToBlob/transferToImageBitmap)
 * 114. WebGL context instance-level readPixels proxy (chains to Section 30)
 * 115. Notification.permission synchronous verification (safety net)
 *
 * Canvas 2D Context Proxy enhancements (R55):
 *   - fillText/strokeText sub-pixel positioning noise (+/-0.05px)
 *   - measureText full TextMetrics variation (7 properties, font-content-aware)
 *   - createConicGradient addColorStop noise
 *   - Gradient color perturbation scaled by noise intensity
 *   - Cached color parsing canvas (avoids detectable side-effects)
 *   - toDataURL/toBlob WebGL canvas fallback (readPixels noise path)
 *
 * @param profile - The fingerprint profile to inject
 * @returns JavaScript code string to pass to `page.addInitScript()`
 */

const _stealthScriptCache = new Map<string, { script: string; ts: number }>();
const STEALTH_SCRIPT_CACHE_TTL = 30 * 60 * 1000; // 30 min

// Canvas noise intensity: 0.0 = no noise, 1.0 = default (±1 RGB), up to 3.0 = aggressive
const CANVAS_NOISE_INTENSITY = (() => {
  const raw = process.env.SCRAPER_CANVAS_NOISE_INTENSITY;
  if (raw === undefined) return 1.0;
  const parsed = parseFloat(raw);
  if (isNaN(parsed)) return 1.0;
  return Math.max(0.0, Math.min(3.0, parsed));
})();

export function getStealthScript(profile: FingerprintProfile): string {
  const key = profile.seed || 'default';
  const cached = _stealthScriptCache.get(key);
  if (cached && Date.now() - cached.ts < STEALTH_SCRIPT_CACHE_TTL) {
    return cached.script;
  }

  const languagesJSON = JSON.stringify(profile.languages);

  const result = `
// ===================================================================
// Obscura Stealth Injection v1.0
// Injected via page.addInitScript() — runs before any page script
// ===================================================================
(function() {
  'use strict';

  const PROFILE = ${JSON.stringify(profile)};

  // Browser type detection — used throughout the script for conditional behavior
  const _uaString = ${JSON.stringify(profile.userAgent)};
  const _isFirefox = /Firefox\\//.test(_uaString) || /Seamonkey\\//i.test(_uaString);

  // Pre-compute derived seeds used by multiple sections (must be before any section that references them)
  var _fakeDeviceSeed = 0;
  for (var _fds0 = 0; _fds0 < PROFILE.seed.length; _fds0++) { _fakeDeviceSeed = ((_fakeDeviceSeed << 5) - _fakeDeviceSeed + PROFILE.seed.charCodeAt(_fds0)) | 0; }
  _fakeDeviceSeed = Math.abs(_fakeDeviceSeed);
  // Seeded PRNG for deterministic values across all sections (uses _fakeDeviceSeed — no redundant _navSeed)
  function _seededRandom(offset) { var s = (_fakeDeviceSeed + (offset * 1000 | 0)) | 0; s = (s * 1664525 + 1013904223) | 0; return (s >>> 0) / 4294967296; }
  var _canvasNoiseSeed = Math.floor(_fakeDeviceSeed * 13.37) | 0;
  var _canvasNoiseIntensity = ${CANVAS_NOISE_INTENSITY};
  var _canvasInstanceCount = 0; // Per-canvas counter to differentiate noise seeds across multiple canvases

  // ---- 1. Navigator Override ----

  // Remove webdriver flag — the primary automation detection signal
  Object.defineProperty(navigator, 'webdriver', {
    get: () => false,
    configurable: true,
    enumerable: true,
  });

  // Also delete from prototype chain
  try { delete navigator.__proto__.webdriver; } catch(e) {}

  // Also override at the prototype level (catches cross-frame checks)
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true, enumerable: true });
  } catch(_e) {}

  // Override navigator.userAgentData (Chrome 90+ Client Hints API)
  // Must be consistent with HTTP sec-ch-ua headers sent by the scraper.
  // Brands, platform, mobile, arch, bitness, model, fullVersionList all must match.
  try {
    var _isMac = /Macintosh/.test(_uaString);
    var _isLinux = /Linux/.test(_uaString);
    var _isMobile = /Mobile/.test(_uaString);
    var _isEdge = /Edg\\//.test(_uaString) && !/OPR\\//.test(_uaString);
    if (!_isFirefox && navigator.userAgentData) {
      var _uaVer = _uaString.match(/Chrome\/(\d+)/);
      var _chromeMajor = _uaVer ? parseInt(_uaVer[1]) : 131;
      var _uaFullVer = _uaString.match(/Chrome\/([\d.]+)/);
      var _chromeFullVersion = _uaFullVer ? _uaFullVer[1] : _chromeMajor + '.0.0.0';

      // Detect architecture from UA
      var _uadArch = 'x86';
      var _uadBitness = '64';
      if (_isMac) { _uadArch = 'arm'; _uadBitness = '64'; }
      else if (_isLinux && (/aarch64/.test(_uaString) || /arm64/.test(_uaString))) { _uadArch = 'arm'; _uadBitness = '64'; }
      else if (_isLinux && /x86/.test(_uaString)) { _uadArch = 'x86'; _uadBitness = '64'; }
      else if (_isMobile) { _uadArch = 'arm'; _uadBitness = '64'; }

      // Detect model (only for Android mobile)
      var _uadModel = '';
      var _androidModelMatch = _uaString.match(/Android[^;]*;\\s*([^;)\\s]+\\s+Build/);
      if (_androidModelMatch) { _uadModel = _androidModelMatch[1]; }

      // Platform
      var _uadPlatform = 'Windows';
      if (_isMac) _uadPlatform = 'macOS';
      else if (_isLinux && !_isMobile) _uadPlatform = 'Linux';
      else if (_isMobile && /Android/.test(_uaString)) _uadPlatform = 'Android';

      // Brands must match sec-ch-ua header exactly
      var _uaBrands;
      if (_isEdge) {
        _uaBrands = [
          { brand: "Chromium", version: String(_chromeMajor) },
          { brand: "Not A(Brand", version: "99" },
          { brand: "Microsoft Edge", version: String(_chromeMajor) }
        ];
      } else {
        _uaBrands = [
          { brand: "Google Chrome", version: String(_chromeMajor) },
          { brand: "Not A(Brand", version: "99" },
          { brand: "Chromium", version: String(_chromeMajor) }
        ];
      }

      // fullVersionList must match sec-ch-ua-full-version-list header
      var _uaFullVersionList;
      if (_isEdge) {
        _uaFullVersionList = [
          { brand: "Chromium", version: _chromeFullVersion },
          { brand: "Not A(Brand", version: "99.0.0.0" },
          { brand: "Microsoft Edge", version: _chromeFullVersion }
        ];
      } else {
        _uaFullVersionList = [
          { brand: "Not A(Brand", version: "99.0.0.0" },
          { brand: "Google Chrome", version: _chromeFullVersion },
          { brand: "Chromium", version: _chromeFullVersion }
        ];
      }

      var _origUAD = navigator.userAgentData;
      Object.defineProperty(navigator, 'userAgentData', {
        get: function() {
          return {
            brands: _uaBrands,
            mobile: _isMobile,
            platform: _uadPlatform,
            getHighEntropyValues: function(hints) {
              return Promise.resolve({
                brands: _uaBrands,
                mobile: _isMobile,
                platform: _uadPlatform,
                architecture: _uadArch,
                bitness: _uadBitness,
                model: _uadModel,
                platformVersion: _isMobile ? '14.0.0' : (_isLinux ? '6.5.0' : (_isMac ? '14.0.0' : '15.0.0')),
                fullVersionList: _uaFullVersionList,
                uaFullVersion: _chromeFullVersion
              });
            },
            toJSON: function() { return { brands: _uaBrands, mobile: _isMobile, platform: _uadPlatform }; }
          };
        },
        configurable: true
      });
    }
  } catch(_e) {}

  // Languages (plugins/mimeTypes are set in Section 23 with platform-aware enumeration)
  Object.defineProperty(navigator, 'languages', {
    get: () => ${languagesJSON},
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(navigator, 'language', {
    get: () => ${JSON.stringify(profile.languages[0])},
    configurable: true,
    enumerable: true,
  });

  // Hardware
  Object.defineProperty(navigator, 'hardwareConcurrency', {
    get: () => ${profile.hardwareConcurrency},
    configurable: true,
    enumerable: true,
  });

  // deviceMemory — Firefox doesn't implement this API
  if (!_isFirefox) {
    Object.defineProperty(navigator, 'deviceMemory', {
      get: () => ${profile.deviceMemory},
      configurable: true,
      enumerable: true,
    });
  }

  // Platform
  Object.defineProperty(navigator, 'platform', {
    get: () => ${JSON.stringify(profile.platform)},
    configurable: true,
    enumerable: true,
  });

  // Max touch points (desktop = 0)
  Object.defineProperty(navigator, 'maxTouchPoints', {
    get: () => 0,
    configurable: true,
    enumerable: true,
  });

  // pdfViewerEnabled — all modern browsers have built-in PDF viewers
  try {
    Object.defineProperty(navigator, 'pdfViewerEnabled', { get: () => true, configurable: true, enumerable: true });
  } catch(_e) {}

  // Remove other automation indicators
  try { delete navigator.__proto__.driver; } catch(e) {}
  try { delete navigator.__proto__.automation; } catch(e) {}

  // User-Agent override (ensure consistency)
  Object.defineProperty(navigator, 'userAgent', {
    get: () => PROFILE.userAgent,
    configurable: true,
    enumerable: true,
  });

  // AppVersion consistent with platform
  const appVersion = (() => {
    const p = PROFILE.platform;
    if (p === 'Win32') return '5.0 (Windows NT 10.0; Win64; x64)';
    if (p === 'MacIntel') return '5.0 (Macintosh; Intel Mac OS X 10_15_7)';
    return '5.0 (X11; Linux x86_64)';
  })();
  Object.defineProperty(navigator, 'appVersion', {
    get: () => appVersion,
    configurable: true,
    enumerable: true,
  });

  // Vendor — Chrome says "Google Inc.", Firefox returns ""
  Object.defineProperty(navigator, 'vendor', {
    get: () => _isFirefox ? '' : 'Google Inc.',
    configurable: true,
    enumerable: true,
  });

  // ---- 2. Chrome Object Override ----
  // Firefox never has window.chrome — injecting it is a detection vector
  if (!_isFirefox) {
  if (!window.chrome) {
    window.chrome = {};
  }
  if (!window.chrome.runtime) {
    // chrome.event factory — produces objects with addListener/removeListener/hasListeners
    // matching the exact shape of real Chrome's event objects
    function _makeChromeEvent() {
      var _evt = {
        addListener: function() {},
        removeListener: function() {},
        hasListeners: function() { return false; },
      };
      _evt.addListener.toString = function() { return 'function addListener() { [native code] }'; };
      _evt.removeListener.toString = function() { return 'function removeListener() { [native code] }'; };
      _evt.hasListeners.toString = function() { return 'function hasListeners() { [native code] }'; };
      return _evt;
    }

    function _throwInvalidated() { throw new Error('Extension context invalidated.'); }
    _throwInvalidated.toString = function() { return 'function () { [native code] }'; };

    var _runtimeObj = {
      id: undefined,
      onMessage: _makeChromeEvent(),
      onConnect: _makeChromeEvent(),
      onInstalled: _makeChromeEvent(),
      getManifest: _throwInvalidated,
      getURL: function(path) { return 'chrome-extension://invalid/' + (path || ''); },
      connect: _throwInvalidated,
      sendMessage: function() { return Promise.reject(new Error('Extension context invalidated.')); },
      getPlatformInfo: function(cb) {
        var info = { os: _isMac ? 'mac' : (_isLinux ? 'linux' : 'win'), arch: 'x86', nacl_arch: 'x86-64' };
        if (cb) cb(info);
        return Promise.resolve(info);
      },
      requestUpdateCheck: function(cb) {
        var result = { status: 'no_update', version: '1.0.0' };
        if (cb) cb('no_update', '1.0.0');
        return Promise.resolve(result);
      },
      reload: function() {},
    };
    // toString() for all functions to return [native code]
    _runtimeObj.getURL.toString = function() { return 'function getURL() { [native code] }'; };
    _runtimeObj.sendMessage.toString = function() { return 'function sendMessage() { [native code] }'; };
    _runtimeObj.getPlatformInfo.toString = function() { return 'function getPlatformInfo() { [native code] }'; };
    _runtimeObj.requestUpdateCheck.toString = function() { return 'function requestUpdateCheck() { [native code] }'; };
    _runtimeObj.reload.toString = function() { return 'function reload() { [native code] }'; };

    // Make chrome.runtime non-configurable, non-writable on window.chrome
    try { Object.defineProperty(window.chrome, 'runtime', { value: _runtimeObj, configurable: false, writable: false }); } catch(_rte) {}
  }
  if (!window.chrome.loadTimes) {
    var _cachedLoadTimes = null;
    window.chrome.loadTimes = function() {
      if (_cachedLoadTimes) return _cachedLoadTimes;
      _cachedLoadTimes = {
        requestTime: Date.now() / 1000,
        startLoadTime: Date.now() / 1000,
        commitLoadTime: Date.now() / 1000,
        finishDocumentLoadTime: Date.now() / 1000,
        finishLoadTime: Date.now() / 1000,
        firstPaintTime: Date.now() / 1000,
        firstPaintAfterLoadTime: 0,
        navigationType: 'Other',
        wasFetchedViaSpdy: false,
        wasNpnNegotiated: true,
        npnNegotiatedProtocol: 'h2',
        wasAlternateProtocolAvailable: false,
        connectionInfo: 'h2',
      };
      return _cachedLoadTimes;
    };
  }
  if (!window.chrome.csi) {
    var _cachedCsi = null;
    window.chrome.csi = function() {
      if (_cachedCsi) return _cachedCsi;
      _cachedCsi = {
        onloadT: Date.now(),
        startE: Date.now(),
        pageT: Math.floor(_seededRandom(88.3) * 1000) + 500,
        tran: 15,
      };
      return _cachedCsi;
    };
  }
  if (!window.chrome.app) {
    window.chrome.app = {
      isInstalled: false,
      InstallState: { INSTALLED: 'installed', DISABLED: 'disabled', NOT_INSTALLED: 'not_installed' },
      RunningState: { RUNNING: 'running', CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run' },
      getDetails: function() { return null; },
      getIsInstalled: function() { return false; },
    };
  }
  } // end !_isFirefox

  // ---- 3. WebGL Fingerprint Override ----

  const UNMASKED_VENDOR_WEBGL = 37445;
  const UNMASKED_RENDERER_WEBGL = 37446;
  // Standard (masked) WebGL parameters
  const GL_RENDERER = 0x1F01;
  const GL_VENDOR = 0x1F00;
  const GL_SHADING_LANGUAGE_VERSION = 0x8B8C;

  // Derive consistent masked RENDERER/VENDOR/SHADING_LANGUAGE_VERSION from profile
  var _glVendor = _isFirefox ? 'Mozilla' : 'Google Inc.';
  var _glRenderer = _isFirefox ? 'Mozilla' : 'WebKit WebGL';
  // GLSL version: match ANGLE (Chrome) vs native (Firefox) vs Mesa (Linux)
  var _glslVersion = 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)';
  if (_isFirefox) {
    _glslVersion = 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 NVIDIA)';
  } else if (/Mesa/.test(PROFILE.webglRenderer)) {
    _glslVersion = 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Mesa 23.2.1)';
  }
  // Seeded minor variation for GLSL version (e.g. trailing whitespace or version suffix)
  var _glslSeed = Math.floor(_fakeDeviceSeed * 2.71) | 0;
  _glslSeed = (_glslSeed * 16807 + 0.5) % 2147483647;
  var _glslVariants = [
    'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
    'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium) ',
  ];
  if (!_isFirefox && !/Mesa/.test(PROFILE.webglRenderer)) {
    _glslVersion = _glslVariants[_glslSeed % _glslVariants.length];
  }

  // Override WebGLRenderingContext
  const origGetParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(param) {
    // UNMASKED_VENDOR_WEBGL
    if (param === UNMASKED_VENDOR_WEBGL) return PROFILE.webglVendor;
    // UNMASKED_RENDERER_WEBGL
    if (param === UNMASKED_RENDERER_WEBGL) return PROFILE.webglRenderer;
    // RENDERER (masked)
    if (param === GL_RENDERER) return _glRenderer;
    // VENDOR (masked)
    if (param === GL_VENDOR) return _glVendor;
    // SHADING_LANGUAGE_VERSION
    if (param === GL_SHADING_LANGUAGE_VERSION) return _glslVersion;
    return origGetParameter.call(this, param);
  };

  // Override WebGL2RenderingContext
  if (typeof WebGL2RenderingContext !== 'undefined') {
    const origGetParameter2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(param) {
      if (param === UNMASKED_VENDOR_WEBGL) return PROFILE.webglVendor;
      if (param === UNMASKED_RENDERER_WEBGL) return PROFILE.webglRenderer;
      if (param === GL_RENDERER) return _glRenderer;
      if (param === GL_VENDOR) return _glVendor;
      // WebGL2 uses GLSL ES 3.00
      if (param === GL_SHADING_LANGUAGE_VERSION) {
        if (_isFirefox) return 'WebGL GLSL ES 3.0 (OpenGL ES GLSL ES 3.0 NVIDIA)';
        if (/Mesa/.test(PROFILE.webglRenderer)) return 'WebGL GLSL ES 3.0 (OpenGL ES GLSL ES 3.0 Mesa 23.2.1)';
        return 'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 Chromium)';
      }
      return origGetParameter2.call(this, param);
    };
  }

  // Also patch getExtension to ensure WEBGL_debug_renderer_info is available.
  // In headless environments (e.g., CI containers, serverless), the real extension may
  // return null. We mock the constants so getParameter(UNMASKED_VENDOR/RENDERER)
  // still works and returns the profile-controlled strings.
  const origGetExtension = WebGLRenderingContext.prototype.getExtension;
  WebGLRenderingContext.prototype.getExtension = function(name) {
    if (name === 'WEBGL_debug_renderer_info') {
      const ext = origGetExtension.call(this, name);
      if (ext) return ext;
      // Mock the extension for headless environments where it's unavailable.
      // Constants are frozen to prevent detection via mutation test.
      var _mockExt = {};
      Object.defineProperty(_mockExt, 'UNMASKED_VENDOR_WEBGL', { value: 0x9245, writable: false, configurable: false });
      Object.defineProperty(_mockExt, 'UNMASKED_RENDERER_WEBGL', { value: 0x9246, writable: false, configurable: false });
      return _mockExt;
    }
    return origGetExtension.call(this, name);
  };

  // Same patch for WebGL2RenderingContext
  if (typeof WebGL2RenderingContext !== 'undefined') {
    const origGetExtension2 = WebGL2RenderingContext.prototype.getExtension;
    WebGL2RenderingContext.prototype.getExtension = function(name) {
      if (name === 'WEBGL_debug_renderer_info') {
        const ext = origGetExtension2.call(this, name);
        if (ext) return ext;
        var _mockExt2 = {};
        Object.defineProperty(_mockExt2, 'UNMASKED_VENDOR_WEBGL', { value: 0x9245, writable: false, configurable: false });
        Object.defineProperty(_mockExt2, 'UNMASKED_RENDERER_WEBGL', { value: 0x9246, writable: false, configurable: false });
        return _mockExt2;
      }
      return origGetExtension2.call(this, name);
    };
  }

  // WebGL readPixels noise — same deterministic per-pixel approach as canvas getImageData
  // Prevents pixel-exact readback fingerprinting of WebGL canvases
  try {
    var _glReadSeed = Math.floor(_fakeDeviceSeed * 5.77) | 0;
    var _origReadPixels = WebGLRenderingContext.prototype.readPixels;
    WebGLRenderingContext.prototype.readPixels = function(x, y, w, h, format, type, pixels) {
      _origReadPixels.call(this, x, y, w, h, format, type, pixels);
      if (format === 0x1908 && type === 0x1401 && pixels instanceof Uint8Array) { // RGBA, UNSIGNED_BYTE
        var _rS = _glReadSeed;
        for (var i = 0; i < pixels.length; i += 4) {
          _rS = (_rS * 16807 + 0.5) % 2147483647;
          var _rn = Math.round(((_rS % 3) - 1) * _canvasNoiseIntensity);
          pixels[i]   = Math.max(0, Math.min(255, pixels[i] + _rn));
          _rS = (_rS * 16807 + 0.5) % 2147483647;
          _rn = Math.round(((_rS % 3) - 1) * _canvasNoiseIntensity);
          pixels[i+1] = Math.max(0, Math.min(255, pixels[i+1] + _rn));
          _rS = (_rS * 16807 + 0.5) % 2147483647;
          _rn = Math.round(((_rS % 3) - 1) * _canvasNoiseIntensity);
          pixels[i+2] = Math.max(0, Math.min(255, pixels[i+2] + _rn));
        }
      }
    };
    if (typeof WebGL2RenderingContext !== 'undefined') {
      var _origReadPixels2 = WebGL2RenderingContext.prototype.readPixels;
      if (_origReadPixels2 && _origReadPixels2 !== _origReadPixels) {
        WebGL2RenderingContext.prototype.readPixels = function(x, y, w, h, format, type, pixels) {
          _origReadPixels2.call(this, x, y, w, h, format, type, pixels);
          if (format === 0x1908 && type === 0x1401 && pixels instanceof Uint8Array) {
            var _r2S = _glReadSeed + 1;
            for (var i = 0; i < pixels.length; i += 4) {
              _r2S = (_r2S * 16807 + 0.5) % 2147483647;
              var _rn2 = Math.round(((_r2S % 3) - 1) * _canvasNoiseIntensity);
              pixels[i]   = Math.max(0, Math.min(255, pixels[i] + _rn2));
              _r2S = (_r2S * 16807 + 0.5) % 2147483647;
              _rn2 = Math.round(((_r2S % 3) - 1) * _canvasNoiseIntensity);
              pixels[i+1] = Math.max(0, Math.min(255, pixels[i+1] + _rn2));
              _r2S = (_r2S * 16807 + 0.5) % 2147483647;
              _rn2 = Math.round(((_r2S % 3) - 1) * _canvasNoiseIntensity);
              pixels[i+2] = Math.max(0, Math.min(255, pixels[i+2] + _rn2));
            }
          }
        };
      }
    }
  } catch(_e) {}

  // ---- 4. Canvas Fingerprint Noise ----
  // NOTE: Simple single-pixel noise removed here to avoid double-injection fingerprint.
  // Section 30 provides superior per-pixel deterministic noise that covers the entire canvas.
  // Keeping both would create detectable inconsistency (Section 30 noise + Section 4's extra pixel).

  // ---- 5. AudioContext Fingerprint Noise ----
  // NOTE: Simple random noise removed here to avoid double-injection fingerprint.
  // Section 31 provides superior deterministic per-profile noise that is consistent across
  // the same page load (uses seeded PRNG) and covers OfflineAudioContext too.
  // Keeping both would produce detectable dual-frequency-offset artifacts.

  // ---- 6. Screen / Window Properties ----

  Object.defineProperty(screen, 'width', {
    get: () => PROFILE.screenWidth,
    configurable: true,
  });
  Object.defineProperty(screen, 'height', {
    get: () => PROFILE.screenHeight,
    configurable: true,
  });
  Object.defineProperty(screen, 'availWidth', {
    get: () => PROFILE.screenWidth,
    configurable: true,
  });
  Object.defineProperty(screen, 'availHeight', {
    get: () => PROFILE.screenHeight - (_isMac ? 25 : 40),
    configurable: true,
  });
  Object.defineProperty(screen, 'colorDepth', {
    get: () => PROFILE.colorDepth,
    configurable: true,
  });
  Object.defineProperty(screen, 'pixelDepth', {
    get: () => PROFILE.colorDepth,
    configurable: true,
  });

  // devicePixelRatio
  Object.defineProperty(window, 'devicePixelRatio', {
    get: () => PROFILE.pixelRatio,
    configurable: true,
  });

  // outerWidth/outerHeight are set in Section 57 with proper browser chrome simulation

  // innerWidth / innerHeight are set by viewport; don't override to avoid layout issues

  // screenOrientation — vary angle by seed (some users have rotated monitors: 90° or 270°)
  var _orientAngle = (_fakeDeviceSeed % 5 === 0) ? 90 : (_fakeDeviceSeed % 5 === 1) ? 270 : 0;
  Object.defineProperty(screen, 'orientation', {
    get: () => ({
      angle: _orientAngle,
      type: _orientAngle === 0 ? 'portrait-primary'             : _orientAngle === 90 ? 'landscape-primary'             : _orientAngle === 270 ? 'landscape-secondary'             : 'portrait-secondary',
      onchange: null,
      addEventListener: function() {},
      removeEventListener: function() {},
      dispatchEvent: function() { return true; },
    }),
    configurable: true,
  });

  // ---- 6b. DOMRect Consistency ----
  // Ensure DOMRect constructor and prototype match real browser behavior.
  // Fingerprinting scripts check: new DOMRect() === all zeros, prototype property enumeration.
  try {
    if (typeof DOMRect === 'undefined') {
      window.DOMRect = function(x, y, w, h) {
        return { x: x||0, y: y||0, width: w||0, height: h||0,
                 top: (y||0), bottom: (y||0)+(h||0), left: (x||0), right: (x||0)+(w||0) };
      } as any;
    }
    // Ensure new DOMRect() returns all zeros (standard behavior)
    var _testRect = new DOMRect();
    if (_testRect.x !== 0 || _testRect.y !== 0 || _testRect.width !== 0 || _testRect.height !== 0) {
      var _OrigDOMRect = DOMRect;
      window.DOMRect = function(x, y, w, h) {
        return new _OrigDOMRect(x||0, y||0, w||0, h||0);
      } as any;
      window.DOMRect.prototype = _OrigDOMRect.prototype;
    }
  } catch(e) {}

  // ---- 7. WebRTC Leak Prevention ----
  // NOTE: The comprehensive WebRTC override is in Section 101 (sanitizes ICE config,
  // blocks onicecandidate events, preserves real RTCPeerConnection prototype chain).
  // A simpler fake override was previously here but conflicted with Section 101.
  // Section 101 runs later and handles all WebRTC evasion.

  // Also prevent webkitRTCPeerConnection leaks
  if (window.webkitRTCPeerConnection) {
    window.webkitRTCPeerConnection = window.RTCPeerConnection;
  }

  // ---- 8. Permission Override ----

  if (navigator.permissions && navigator.permissions.query) {
    const origPermissionsQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = function(params) {
      if (params.name === 'notifications') {
        // Return 'default' directly rather than Notification.permission (which
        // may still be 'denied' at this point — Section 52 fixes it later).
        // Consistent with Section 38 which also returns 'default' for notifications.
        return Promise.resolve({ state: 'default', onchange: null });
      }
      // For other permissions, return a permissive default
      if (['geolocation', 'camera', 'microphone', 'accelerometer', 'gyroscope', 'magnetometer', 'push', 'midi', 'clipboard-read', 'clipboard-write', 'fullscreen', 'persistent-storage'].includes(params.name)) {
        return Promise.resolve({ state: 'prompt', onchange: null });
      }
      return origPermissionsQuery(params);
    };
  }

  // ---- 9. IFrame ContentWindow Consistency ----
  // attachShadow no-op override REMOVED (R47): the previous override called the original and
  // returned the result — literally a no-op adding function call overhead to every attachShadow.

  // ---- 10. Date / Timezone Consistency ----

  const origGetTimezoneOffset = Date.prototype.getTimezoneOffset;
  Date.prototype.getTimezoneOffset = function() {
    return PROFILE.timezoneOffset;
  };

  // Intl.DateTimeFormat override for timezone consistency
  if (typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
    const origDateTimeFormat = Intl.DateTimeFormat;
    const origResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
    Intl.DateTimeFormat = function(...args) {
      const instance = new (Function.prototype.bind.apply(origDateTimeFormat, [null, ...args]))();
      const origRO = instance.resolvedOptions.bind(instance);
      instance.resolvedOptions = function() {
        const opts = origRO();
        opts.timeZone = PROFILE.timezone;
        return opts;
      };
      return instance;
    };
    Intl.DateTimeFormat.prototype = origDateTimeFormat.prototype;
    Intl.DateTimeFormat.supportedLocalesOf = origDateTimeFormat.supportedLocalesOf;
  }

  // ---- 11. Automation Property Removal ----

  // Remove CDP (Chrome DevTools Protocol) indicators — multiple known hash patterns
  try { delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array; } catch(e) {}
  try { delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise; } catch(e) {}
  try { delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol; } catch(e) {}
  // document-scoped CDP markers (variant hash used by some CDP versions)
  try { delete document["$cdc_asdjflasutopfhvcZLmcfl_"]; } catch(e) {}
  // Scan document for any remaining $cdc_ properties (catch-all)
  for (var _key in document) {
    if (typeof _key === 'string' && _key.indexOf('$cdc_') === 0) {
      try { delete document[_key]; } catch(e) {}
    }
  }
  for (var _wkey in window) {
    if (typeof _wkey === 'string' && _wkey.indexOf('cdc_') === 0) {
      try { delete window[_wkey]; } catch(e) {}
    }
  }

  // Remove Puppeteer/Playwright/Selenium/Phantom automation markers
  // Task 3-c: expanded list with additional CDP and automation framework indicators
  const propsToRemove = [
    // Playwright / Puppeteer
    '__playwright', '__puppeteer_evaluation_script__',
    // Selenium
    '__selenium_unwrapped', '__selenium_evaluate',
    '__webdriver_evaluate', '__driver_evaluate', '__webdriver_unwrapped',
    '__driver_unwrapped', '__webdriver_script_function', '__webdriver_script_func',
    '__fxdriver_evaluate', '__fxdriver_unwrapped',
    '_Selenium_IDE_Recorder', '_selenium', 'calledSelenium',
    // PhantomJS
    'callPhantom', '_phantom', '__phantomas',
    // Nightmare
    '__nightmare',
    // Chrome automation (older CDP-based)
    'domAutomation', 'domAutomationController',
  ];
  propsToRemove.forEach(prop => {
    try { delete window[prop]; } catch(e) {}
  });

  // Document-scoped automation markers (some tools inject here instead of window)
  const docPropsToRemove = [
    '__webdriver_script_fn', '__webdriver_evaluate', '__driver_evaluate',
    '__selenium_evaluate', '__fxdriver_evaluate',
  ];
  docPropsToRemove.forEach(prop => {
    try { delete document[prop]; } catch(e) {}
  });

  // MutationObserver for late-injected automation properties (Task 3-c)
  // Catches scripts that inject automation markers after page load
  try {
    var _allAutoProps = propsToRemove.concat(docPropsToRemove);
    var _autoPropObserver = new MutationObserver(function(mutations) {
      for (var mi = 0; mi < mutations.length; mi++) {
        var added = mutations[mi].addedNodes;
        for (var ni = 0; ni < added.length; ni++) {
          var node = added[ni];
          if (node.nodeType === 1) { // Element node
            for (var pi = 0; pi < _allAutoProps.length; pi++) {
              try { delete node[_allAutoProps[pi]]; } catch(e) {}
              if (node.dataset) {
                try { delete node.dataset[_allAutoProps[pi]]; } catch(e) {}
              }
            }
          }
        }
      }
      // Also re-check window/document for late injections
      for (var wi = 0; wi < _allAutoProps.length; wi++) {
        try { delete window[_allAutoProps[wi]]; } catch(e) {}
        try { delete document[_allAutoProps[wi]]; } catch(e) {}
      }
    });
    _autoPropObserver.observe(document.documentElement || document.body, {
      childList: true, subtree: true, attributes: true,
    });
    // Disconnect on page unload to prevent CPU accumulation
    window.addEventListener('beforeunload', function() { try { _autoPropObserver.disconnect(); } catch(e) {} });
  } catch(e) { /* MutationObserver unavailable */ }

  // Override toString for functions to prevent "function () { [native code] }" detection
  // by checking if the function is truly native
  const nativeToString = Function.prototype.toString;
  Function.prototype.toString = function() {
    if (this === Function.prototype.toString) {
      return 'function toString() { [native code] }';
    }
    return nativeToString.call(this);
  };

  // ---- 12. MouseEvent / KeyboardEvent Consistency ----

  // Ensure MouseEvent has proper isTrusted behavior
  const origMouseEvent = window.MouseEvent;
  if (origMouseEvent) {
    window.MouseEvent = function(type, init) {
      const event = new origMouseEvent(type, init);
      // Don't override isTrusted — let it be false for programmatic events
      return event;
    };
    window.MouseEvent.prototype = origMouseEvent.prototype;
  }

  // [Section 13 removed — completely overridden by Section 17 which unconditionally
  // sets seeded rtt/downlink/effectiveType/saveData/type on the connection object]

  // ---- 14. Storage Consistency ----

  // Ensure localStorage/sessionStorage don't throw in headless
  try {
    localStorage.setItem('_obscura_test', '1');
    localStorage.removeItem('_obscura_test');
  } catch(e) {
    // Storage might be disabled — provide a no-op shim
    const storageShim = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      get length() { return 0; },
      key: () => null,
    };
    Object.defineProperty(window, 'localStorage', {
      get: () => storageShim,
      configurable: true,
    });
    Object.defineProperty(window, 'sessionStorage', {
      get: () => storageShim,
      configurable: true,
    });
  }

  // StorageManager.estimate() mock — real Chrome returns realistic quota values.
  // Headless Chrome sometimes returns quota: 0 or unrealistic values, which is a
  // fingerprinting signal. Advanced anti-bot systems check this API.
  try {
    if (navigator.storage && navigator.storage.estimate) {
      var _origEstimate = navigator.storage.estimate.bind(navigator.storage);
      var _storageQuota = 279172874240 + Math.floor(_seededRandom(7.1) * 204010946560); // ~260-450 GB
      var _storageUsage = Math.floor(_seededRandom(7.3) * 10485760); // 0-10 MB used
      navigator.storage.estimate = function() {
        return Promise.resolve({ quota: _storageQuota, usage: _storageUsage });
      };
    } else if (navigator.storage) {
      // StorageManager exists but estimate() is missing — add it
      var _quotaVal = 279172874240 + Math.floor(_seededRandom(7.7) * 204010946560);
      var _usageVal = Math.floor(_seededRandom(7.9) * 10485760);
      navigator.storage.estimate = function() {
        return Promise.resolve({ quota: _quotaVal, usage: _usageVal });
      };
    }
  } catch(e) {}

  // ---- 15. Iframe stealth propagation ----

  // Apply overrides to all iframes as they load.
  // Detection services create hidden iframes and compare navigator/WebGL/screen
  // fingerprints between the parent and iframe. If they differ, the page is flagged.
  // addInitScript runs in every frame, but the MutationObserver catches dynamically
  // created iframes before their content loads and applies critical instance-level
  // patches that would otherwise only exist on the main frame's navigator/screen.
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.tagName === 'IFRAME' && node.contentWindow) {
          try {
            // Apply key overrides to iframe windows
            const iwin = node.contentWindow;
            Object.defineProperty(iwin.navigator, 'webdriver', {
              get: () => false,
              configurable: true,
            });
            Object.defineProperty(iwin.navigator, 'languages', {
              get: () => ${languagesJSON},
              configurable: true,
            });
            Object.defineProperty(iwin.navigator, 'platform', {
              get: () => ${JSON.stringify(profile.platform)},
              configurable: true,
            });
            Object.defineProperty(iwin.navigator, 'hardwareConcurrency', {
              get: () => ${profile.hardwareConcurrency},
              configurable: true,
            });
            if (!_isFirefox) {
              Object.defineProperty(iwin.navigator, 'deviceMemory', {
                get: () => ${profile.deviceMemory},
                configurable: true,
              });
            }
            Object.defineProperty(iwin.navigator, 'userAgent', {
              get: () => PROFILE.userAgent,
              configurable: true,
            });
            // Plugins/MimeTypes — instance-level override, must match parent frame
            Object.defineProperty(iwin.navigator, 'plugins', {
              get: function() { return navigator.plugins; },
              configurable: true,
            });
            Object.defineProperty(iwin.navigator, 'mimeTypes', {
              get: function() { return navigator.mimeTypes; },
              configurable: true,
            });
            // Screen properties — instance-level override
            Object.defineProperty(iwin.screen, 'width', {
              get: () => PROFILE.screenWidth, configurable: true,
            });
            Object.defineProperty(iwin.screen, 'height', {
              get: () => PROFILE.screenHeight, configurable: true,
            });
            Object.defineProperty(iwin.screen, 'availWidth', {
              get: () => PROFILE.screenWidth, configurable: true,
            });
            Object.defineProperty(iwin.screen, 'availHeight', {
              get: () => PROFILE.screenHeight - (_isMac ? 25 : 40), configurable: true,
            });
            Object.defineProperty(iwin.screen, 'colorDepth', {
              get: () => PROFILE.colorDepth, configurable: true,
            });
            Object.defineProperty(iwin.screen, 'pixelDepth', {
              get: () => PROFILE.colorDepth, configurable: true,
            });
            // Device pixel ratio
            Object.defineProperty(iwin, 'devicePixelRatio', {
              get: () => PROFILE.pixelRatio, configurable: true,
            });
            // Chrome object
            if (!_isFirefox && !iwin.chrome) {
              iwin.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
            }
            // WebRTC
            if (iwin.RTCPeerConnection) {
              const OrigIFrameRTCPC = iwin.RTCPeerConnection;
              iwin.RTCPeerConnection = function(...args) {
                const noop = () => {};
                return {
                  createOffer: () => Promise.resolve({}),
                  createAnswer: () => Promise.resolve({}),
                  setLocalDescription: () => Promise.resolve(),
                  setRemoteDescription: () => Promise.resolve(),
                  close: noop,
                  onicecandidate: null,
                  iceGatheringState: 'new',
                };
              };
            }
            // Notification.permission — must match parent frame
            try {
              if (iwin.Notification) {
                Object.defineProperty(iwin.Notification, 'permission', {
                  get: function() { return 'default'; },
                  configurable: true,
                });
                if (iwin.Notification.requestPermission) {
                  iwin.Notification.requestPermission = function() {
                    return Promise.resolve('default');
                  };
                }
              }
            } catch(_iNotifErr) {}
            // Document visibility/hasFocus — must match parent frame
            try {
              Object.defineProperty(iwin.document, 'visibilityState', {
                get: function() { return 'visible'; }, configurable: true,
              });
              Object.defineProperty(iwin.document, 'hidden', {
                get: function() { return false; }, configurable: true,
              });
              iwin.document.hasFocus = function() { return true; };
            } catch(_iDocErr) {}
            // doNotTrack
            try {
              Object.defineProperty(iwin.navigator, 'doNotTrack', {
                get: function() { return null; }, configurable: true, enumerable: true,
              });
            } catch(_iDntErr) {}
          } catch(e) {
            // Cross-origin iframes will throw — ignore
          }
        }
      }
    }
  });

  observer.observe(document.documentElement || document, {
    childList: true,
    subtree: true,
  });
  // Disconnect on page unload to prevent CPU accumulation
  window.addEventListener('beforeunload', function() { try { observer.disconnect(); } catch(e) {} });

  // ---- 16. ClientRects & getBoundingClientRect Spoofing ----
  // Add tiny random offsets (±0.5px) to prevent layout fingerprinting.
  // Use WeakMap to ensure same element returns same offsets (consistency).

  var _rectCache = new WeakMap();
  var _origGetBoundingClientRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function() {
    if (_rectCache.has(this)) return _rectCache.get(this);
    var rect = _origGetBoundingClientRect.call(this);
    var jx = (_seededRandom(16.1) - 0.5) * 1.0;
    var jy = (_seededRandom(16.2) - 0.5) * 1.0;
    var spoofed = new DOMRect(rect.x + jx, rect.y + jy, rect.width, rect.height);
    _rectCache.set(this, spoofed);
    return spoofed;
  };

  var _rectsCache = new WeakMap();
  var _origGetClientRects = Element.prototype.getClientRects;
  Element.prototype.getClientRects = function() {
    if (_rectsCache.has(this)) return _rectsCache.get(this);
    var rects = _origGetClientRects.call(this);
    var result = [];
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i];
      var jx2 = (_seededRandom(16.3) - 0.5) * 1.0;
      var jy2 = (_seededRandom(16.4) - 0.5) * 1.0;
      result.push(new DOMRect(r.x + jx2, r.y + jy2, r.width, r.height));
    }
    _rectsCache.set(this, result);
    return result;
  };

  // ---- 17. Enhanced Connection / Network Information API ----
  // Derive realistic network values from profile seed for consistency

  var _netSeed = 0;
  for (var _ni = 0; _ni < PROFILE.seed.length; _ni++) {
    _netSeed = ((_netSeed << 5) - _netSeed + PROFILE.seed.charCodeAt(_ni)) | 0;
  }
  var _netRtt = 25 + (Math.abs(_netSeed) % 75);
  var _netDownlink = 5 + (Math.abs(_netSeed >> 4) % 20);
  var _netEffType = '4g';
  if (_netDownlink < 0.5) _netEffType = 'slow-2g';
  else if (_netDownlink < 1.5) _netEffType = '2g';
  else if (_netDownlink < 4) _netEffType = '3g';

  var _conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (_conn) {
    Object.defineProperty(_conn, 'rtt', { get: function() { return _netRtt; }, configurable: true });
    Object.defineProperty(_conn, 'downlink', { get: function() { return _netDownlink; }, configurable: true });
    Object.defineProperty(_conn, 'effectiveType', { get: function() { return _netEffType; }, configurable: true });
    Object.defineProperty(_conn, 'saveData', { get: function() { return false; }, configurable: true });
    if (!_conn.type || typeof _conn.type === 'undefined') {
      Object.defineProperty(_conn, 'type', { get: function() { return 'wifi'; }, configurable: true });
    }
  }

  // [Section 19 removed — completely overridden by Section 28 which uses Object.defineProperty
  // to replace enumerateDevices with seeded fake devices including proper MediaDeviceInfo prototype]

  // ---- 20. AudioContext Fingerprint Noise ----

  if (CanvasRenderingContext2D.prototype.getImageData) {
    var _origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function() {
      var imageData = _origGetImageData.apply(this, arguments);
      var d = imageData.data;
      // Signature verification: ensure data is a Uint8ClampedArray (not regular Uint8Array)
      // Real browsers always return Uint8ClampedArray from getImageData
      if (d && !(d instanceof Uint8ClampedArray)) {
        try {
          var _fixed = new Uint8ClampedArray(d);
          Object.defineProperty(imageData, 'data', { value: _fixed, writable: false, configurable: true });
          d = _fixed;
        } catch(_sigErr) {}
      }
      // Signature verification: ensure width/height match canvas dimensions
      try {
        var _canvas = this.canvas;
        if (_canvas) {
          var _expectedW = arguments[2]; // width parameter
          var _expectedH = arguments[3]; // height parameter
          if (typeof _expectedW === 'number' && imageData.width !== _expectedW) {
            Object.defineProperty(imageData, 'width', { value: _expectedW, writable: false, configurable: true });
          }
          if (typeof _expectedH === 'number' && imageData.height !== _expectedH) {
            Object.defineProperty(imageData, 'height', { value: _expectedH, writable: false, configurable: true });
          }
        }
      } catch(_dimErr) {}
      // Apply the same deterministic per-pixel noise as toDataURL/toBlob (Section 30)
      // so that getImageData and toDataURL return consistent results for the same canvas.
      // Noise is scaled by _canvasNoiseIntensity (env: SCRAPER_CANVAS_NOISE_INTENSITY, default 1.0)
      var _seed = _canvasNoiseSeed + (_canvasInstanceCount * 7919);
      var _intensity = _canvasNoiseIntensity;
      for (var i = 0; i < d.length; i += 4) {
        _seed = (_seed * 16807 + 0.5) % 2147483647;
        var noise = Math.round(((_seed % 3) - 1) * _intensity);
        d[i]   = Math.max(0, Math.min(255, d[i] + noise));
        _seed = (_seed * 16807 + 0.5) % 2147483647;
        noise = Math.round(((_seed % 3) - 1) * _intensity);
        d[i+1] = Math.max(0, Math.min(255, d[i+1] + noise));
        _seed = (_seed * 16807 + 0.5) % 2147483647;
        noise = Math.round(((_seed % 3) - 1) * _intensity);
        d[i+2] = Math.max(0, Math.min(255, d[i+2] + noise));
      }
      return imageData;
    };
  }

  // ---- 22. Font Detection Countermeasure ----

  // ---- 23. Platform-based Plugin / MimeType Enumeration ----
  // Override with realistic 3-4 plugins that vary by OS platform

  var _platformPlugins = {
    'Win32': [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 1 },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', length: 2 },
      { name: 'Widevine Content Decryption Module', filename: 'widevinecdmadapter.dll', description: 'Enables Widevine licenses for playback of DRM content', length: 1 },
    ],
    'MacIntel': [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 1 },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', length: 2 },
    ],
    'Linux x86_64': [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 1 },
      { name: 'Widevine Content Decryption Module', filename: 'libwidevinecdmadapter.so', description: 'Enables Widevine licenses for playback of DRM content', length: 1 },
    ],
  };
  // Firefox has zero plugins (different extension model)
  // Injecting Chrome plugins on Firefox UA is a detection vector
  var _selPlugins = _isFirefox ? [] : (_platformPlugins[PROFILE.platform] || _platformPlugins['Win32']);
  var _platPluginInstances = _selPlugins.map(function(p) {
    var pl = Object.create(Plugin.prototype);
    Object.defineProperties(pl, {
      name: { get: function() { return p.name; } },
      filename: { get: function() { return p.filename; } },
      description: { get: function() { return p.description; } },
      length: { get: function() { return p.length; } },
    });
    return pl;
  });
  Object.defineProperty(navigator, 'plugins', {
    get: function() {
      var plugins = Object.create(PluginArray.prototype);
      _platPluginInstances.forEach(function(p, i) {
        Object.defineProperty(plugins, i, { get: function() { return p; }, configurable: true });
        Object.defineProperty(plugins, p.name, { get: function() { return p; }, configurable: true });
      });
      Object.defineProperty(plugins, 'length', { get: function() { return _platPluginInstances.length; } });
      Object.defineProperty(plugins, 'item', { value: function(i) { return _platPluginInstances[i] || null; } });
      Object.defineProperty(plugins, 'namedItem', { value: function(name) {
        for (var _pi = 0; _pi < _platPluginInstances.length; _pi++) {
          if (_platPluginInstances[_pi].name === name) return _platPluginInstances[_pi];
        }
        return null;
      }});
      Object.defineProperty(plugins, 'refresh', { value: function() {} });
      return plugins;
    },
    configurable: true,
  });

  // Rebuild mimeTypes to match the selected plugins from Section 23
  // Also build per-plugin mime arrays for Plugin[MimeType] indexers (Section 23b)
  var _rebuiltMimes = [];
  var _rebuiltMimeMap = {};
  var _pluginMimeArrays = []; // Parallel to _selPlugins: each entry is array of MimeType objects
  for (var _pmiInit = 0; _pmiInit < _selPlugins.length; _pmiInit++) {
    _pluginMimeArrays.push([]);
  }
  for (var _pmi = 0; _pmi < _selPlugins.length; _pmi++) {
    (function(_pluginIdx) {
      var _p = _selPlugins[_pluginIdx];
      if (_p.name.indexOf('PDF') >= 0) {
        var _mimePdf = Object.create(MimeType.prototype);
        Object.defineProperties(_mimePdf, {
          type: { get: function() { return 'application/pdf'; } },
          suffixes: { get: function() { return 'pdf'; } },
          description: { get: function() { return 'Portable Document Format'; } },
          enabledPlugin: { get: function() { return _platPluginInstances[_pluginIdx]; } },
        });
        _rebuiltMimes.push(_mimePdf);
        _rebuiltMimeMap['application/pdf'] = _rebuiltMimes[_rebuiltMimes.length - 1];
        _pluginMimeArrays[_pluginIdx].push(_mimePdf);
      }
      if (_p.name.indexOf('Chrome PDF Viewer') >= 0) {
        var _mimeGcp = Object.create(MimeType.prototype);
        Object.defineProperties(_mimeGcp, {
          type: { get: function() { return 'application/x-google-chrome-pdf'; } },
          suffixes: { get: function() { return 'pdf'; } },
          description: { get: function() { return 'Portable Document Format'; } },
          enabledPlugin: { get: function() { return _platPluginInstances[_pluginIdx]; } },
        });
        _rebuiltMimes.push(_mimeGcp);
        _rebuiltMimeMap['application/x-google-chrome-pdf'] = _rebuiltMimes[_rebuiltMimes.length - 1];
        _pluginMimeArrays[_pluginIdx].push(_mimeGcp);
      }
      if (_p.name.indexOf('Native Client') >= 0) {
        var _mimeNacl = Object.create(MimeType.prototype);
        Object.defineProperties(_mimeNacl, {
          type: { get: function() { return 'application/x-nacl'; } },
          suffixes: { get: function() { return ''; } },
          description: { get: function() { return 'Native Client Executable'; } },
          enabledPlugin: { get: function() { return _platPluginInstances[_pluginIdx]; } },
        });
        _rebuiltMimes.push(_mimeNacl);
        _rebuiltMimeMap['application/x-nacl'] = _rebuiltMimes[_rebuiltMimes.length - 1];
        _pluginMimeArrays[_pluginIdx].push(_mimeNacl);
        var _mimePnacl = Object.create(MimeType.prototype);
        Object.defineProperties(_mimePnacl, {
          type: { get: function() { return 'application/x-pnacl'; } },
          suffixes: { get: function() { return ''; } },
          description: { get: function() { return 'Portable Native Client Executable'; } },
          enabledPlugin: { get: function() { return _platPluginInstances[_pluginIdx]; } },
        });
        _rebuiltMimes.push(_mimePnacl);
        _rebuiltMimeMap['application/x-pnacl'] = _rebuiltMimes[_rebuiltMimes.length - 1];
        _pluginMimeArrays[_pluginIdx].push(_mimePnacl);
      }
    })(_pmi);
  }
  // Section 23b: Add numeric MimeType indexers to each Plugin
  // Real Chrome: plugins[0][0] returns the first MimeType of that plugin.
  // Detection checks: plugins[0][0].type, plugins[0][0].suffixes, etc.
  // Without this, plugins[0][0] returns undefined — an instant bot detection signal.
  try {
    for (var _idxPi = 0; _idxPi < _platPluginInstances.length; _idxPi++) {
      (function(pIdx) {
        var _pMimes = _pluginMimeArrays[pIdx];
        for (var _idxMi = 0; _idxMi < _pMimes.length; _idxMi++) {
          (function(mIdx, mime) {
            Object.defineProperty(_platPluginInstances[pIdx], String(mIdx), {
              get: function() { return mime; },
              configurable: true
            });
          })(_idxMi, _pMimes[_idxMi]);
        }
      })(_idxPi);
    }
  } catch(_pluginIdxErr) {}
  Object.defineProperty(navigator, 'mimeTypes', {
    get: function() {
      var mimes = Object.create(MimeTypeArray.prototype);
      _rebuiltMimes.forEach(function(m, i) {
        Object.defineProperty(mimes, i, { get: function() { return m; }, configurable: true });
        Object.defineProperty(mimes, m.type, { get: function() { return m; }, configurable: true });
      });
      Object.defineProperty(mimes, 'length', { get: function() { return _rebuiltMimes.length; } });
      Object.defineProperty(mimes, 'item', { value: function(i) { return _rebuiltMimes[i] || null; } });
      Object.defineProperty(mimes, 'namedItem', { value: function(name) { return _rebuiltMimeMap[name] || null; } });
      return mimes;
    },
    configurable: true,
  });

  // ---- 24. Console Detection Evasion ----
  // Override console methods to prevent toString/timing-based devtools detection

  try {
    var _consoleMethods = ['log', 'debug', 'info', 'warn', 'error', 'clear', 'table', 'trace', 'dir'];
    _consoleMethods.forEach(function(method) {
      if (typeof console[method] === 'function') {
        var _origConsole = console[method];
        var _wrapper = function() { return _origConsole.apply(console, arguments); };
        _wrapper.toString = function() { return 'function ' + method + '() { [native code] }'; };
        console[method] = _wrapper;
      }
    });
  } catch(_consoleErr) {}

  // ---- 25. Performance.now() & performance.timing Consistency ----

  if (window.performance) {
    // Add a realistic static offset so performance.now() doesn't start from exactly 0.
    // No jitter is applied here — jitter would break the invariant:
    //   performance.timing.navigationStart + performance.now() ≈ Date.now()
    var _perfOffset = 1000 + Math.floor(_seededRandom(25.1) * 2000);
    var _origPerfNow = performance.now.bind(performance);
    try {
      Object.defineProperty(performance, 'now', {
        value: function() { return _origPerfNow() + _perfOffset; },
        configurable: true,
      });
    } catch(_perfErr) {
      try {
        Performance.prototype.now = function() { return _origPerfNow() + _perfOffset; };
      } catch(_perfErr2) {}
    }

    // Ensure performance.timing.navigationStart is consistent
    if (performance.timing) {
      // Invariant: navigationStart + performance.now() ≈ Date.now()
      // _perfOffset is added to performance.now() above, so subtract it here.
      // This prevents Cloudflare-style timing invariant detection.
      var _navStart = (performance.timeOrigin || Date.now()) - _perfOffset;
      try {
        Object.defineProperty(performance.timing, 'navigationStart', {
          get: function() { return _navStart; },
          configurable: true,
        });
      } catch(_timingErr) {}
    }
  }

  // ---- 26. Mouse Event Listeners ----
  // Attach passive capture-phase listeners to simulate real user activity

  document.addEventListener('mousemove', function() {}, { passive: true, capture: true });
  document.addEventListener('mousedown', function() {}, { passive: true, capture: true });
  document.addEventListener('mouseup', function() {}, { passive: true, capture: true });
  document.addEventListener('mouseover', function() {}, { passive: true, capture: true });
  document.addEventListener('mouseout', function() {}, { passive: true, capture: true });
  document.addEventListener('mouseenter', function() {}, { passive: true, capture: true });

  // ---- 27. Touch Support Spoofing ----
  // For mobile UAs, add touch event properties and constructors

  var _isMobileUA = /Android|iPhone|iPad|iPod|Mobile/i.test(PROFILE.userAgent);
  if (_isMobileUA) {
    Object.defineProperty(navigator, 'maxTouchPoints', { get: function() { return 5; }, configurable: true });
    document.ontouchstart = null;
    document.ontouchend = null;
    document.ontouchmove = null;
    document.ontouchcancel = null;
    // Ensure TouchEvent constructor is available
    if (typeof window.TouchEvent === 'undefined') {
      window.TouchEvent = function(type, init) { return new Event(type, init); };
      window.TouchEvent.prototype = Event.prototype;
    }
    // Add touch event listeners
    document.addEventListener('touchstart', function() {}, { passive: true, capture: true });
    document.addEventListener('touchend', function() {}, { passive: true, capture: true });
    document.addEventListener('touchmove', function() {}, { passive: true, capture: true });
  }

  // ---- 28. MediaDevices enumerateDevices() Fake ----
  // navigator.mediaDevices.enumerateDevices() returns a consistent set of fake devices.
  if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
    var _origEnumerateDevices = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);

    var _fakeDevices = [
      { deviceId: 'audioinput_' + _fakeDeviceSeed, kind: 'audioinput', label: '', groupId: 'grp_' + _fakeDeviceSeed },
      { deviceId: 'videoinput_' + (_fakeDeviceSeed + 1), kind: 'videoinput', label: '', groupId: 'grp_' + _fakeDeviceSeed },
      { deviceId: 'audiooutput_' + (_fakeDeviceSeed + 2), kind: 'audiooutput', label: '', groupId: 'grp_' + (_fakeDeviceSeed + 1) },
    ];

    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', {
      value: function() {
        return Promise.resolve(_fakeDevices.map(function(d) {
          var _dev = Object.create(MediaDeviceInfo.prototype);
          Object.defineProperties(_dev, {
            deviceId: { get: function() { return d.deviceId; } },
            kind:     { get: function() { return d.kind; } },
            label:    { get: function() { return d.label; } },
            groupId:  { get: function() { return d.groupId; } },
            toJSON:   { value: function() { return { deviceId: d.deviceId, kind: d.kind, label: d.label, groupId: d.groupId }; } },
          });
          return _dev;
        }));
      },
      configurable: true,
    });
  }

  // ---- 29. Battery API getBattery() Override ----
  // navigator.getBattery() returns a realistic BatteryManager mock.
  // Overrides both cases: API missing (create mock) and API present (intercept real).
  if (!navigator.getBattery) {
    // Use seeded values for deterministic battery state per profile.
    // Real battery level doesn't change between consecutive API calls.
    var _batteryLevel = 0.55 + Math.abs(Math.sin(_fakeDeviceSeed * 2.37)) * 0.40; // 0.55–0.95
    var _batteryCharging = (_fakeDeviceSeed & 1) === 0;
    var _batteryChargingTime = _batteryCharging ? 3600 + Math.floor(_fakeDeviceSeed * 3000) : Infinity;
    var _batteryDischargingTime = _batteryCharging ? Infinity : 7200 + Math.floor(_fakeDeviceSeed * 10000);

    Object.defineProperty(navigator, 'getBattery', {
      value: function() {
        var battery = {
          charging: _batteryCharging,
          chargingTime: _batteryChargingTime,
          dischargingTime: _batteryDischargingTime,
          level: _batteryLevel,
          onchargingchange: null,
          onchargingtimechange: null,
          ondischargingtimechange: null,
          onlevelchange: null,
          addEventListener: function(type, listener) {
            // Store listeners but never fire events (static battery state)
          },
          removeEventListener: function(type, listener) {},
          dispatchEvent: function() { return false; },
        };
        return Promise.resolve(battery);
      },
      configurable: true,
    });
  } else if (navigator.getBattery) {
    // Override existing getBattery to return fake data
    var _origGetBattery = navigator.getBattery.bind(navigator);
    // Use seeded values for deterministic battery state (same as API-missing path)
    var _fbLevel = 0.55 + Math.abs(Math.sin(_fakeDeviceSeed * 3.14)) * 0.40;
    var _fbCharging = (_fakeDeviceSeed & 1) === 1;
    Object.defineProperty(navigator, 'getBattery', {
      value: function() {
        return _origGetBattery().then(function(realBattery) {
          try {
            Object.defineProperty(realBattery, 'level', { get: function() { return _fbLevel; }, configurable: true });
            Object.defineProperty(realBattery, 'charging', { get: function() { return _fbCharging; }, configurable: true });
            Object.defineProperty(realBattery, 'chargingTime', { get: function() { return _fbCharging ? 3600 + Math.floor(_fakeDeviceSeed * 3000) : Infinity; }, configurable: true });
            Object.defineProperty(realBattery, 'dischargingTime', { get: function() { return _fbCharging ? Infinity : 7200 + Math.floor(_fakeDeviceSeed * 10000); }, configurable: true });
          } catch(e) {}
          return realBattery;
        });
      },
      configurable: true,
    });
  }

  // ---- 30. Canvas Fingerprint Noise ----
  // Noise is applied once in Section 20 (getImageData override) using a deterministic
  // per-pixel LCG seeded by _canvasNoiseSeed. Both getImageData and toDataURL/toBlob
  // now use the SAME noise, preventing detection via cross-method comparison.
  // toDataURL/toBlob use the patched getImageData (which includes noise) and encode
  // from a temporary canvas to avoid accumulating modifications on the original.
  // R55 Enhancement: Added WebGL canvas fallback — when getContext('2d') returns null
  // (WebGL canvas), applies pixel-level noise via manual base64 manipulation of PNG data.
  try {
    // Shared temp canvas for Section 30 encoding (avoids creating new canvas per call)
    var _s30_tmpCanvas = document.createElement('canvas');
    var _s30_tmpCtx = _s30_tmpCanvas.getContext('2d');

    // Helper: apply deterministic noise to raw PNG pixel data
    // PNG pixel data starts after IHDR chunk; scanlines begin at offset 8 (sig) + 4 (len) + 4 (IHDR) + 4 (crc) + 4 (len) + 4 (IDAT) + 4 (crc = 28 bytes typically, but varies)
    // Simpler approach: decode via temp canvas, apply noise via getImageData, re-encode
    function _applyNoiseToDataURL(canvas, origFn, type, quality) {
      var ctx = canvas.getContext('2d');
      if (ctx) {
        var imgData = ctx.getImageData(0, 0, Math.max(1, canvas.width), Math.max(1, canvas.height));
        _s30_tmpCanvas.width = canvas.width;
        _s30_tmpCanvas.height = canvas.height;
        _s30_tmpCtx.putImageData(imgData, 0, 0);
        return origFn.call(_s30_tmpCanvas, type, quality);
      }
      // WebGL canvas fallback: use patched readPixels to get noisy data
      try {
        var w = canvas.width, h = canvas.height;
        if (w === 0 || h === 0) return origFn.call(canvas, type, quality);
        var glCtx = canvas.getContext('webgl') || canvas.getContext('webgl2') || canvas.getContext('experimental-webgl');
        if (glCtx) {
          // readPixels is already patched with deterministic noise (Section 3)
          var px = new Uint8Array(w * h * 4);
          glCtx.readPixels(0, 0, w, h, 0x1908, 0x1401, px);
          // Flip vertically (WebGL reads bottom-up, canvas is top-down)
          var _flipPx = new Uint8Array(px.length);
          for (var row = 0; row < h; row++) {
            var _srcOff = (h - 1 - row) * w * 4;
            var _dstOff = row * w * 4;
            for (var col = 0; col < w * 4; col++) {
              _flipPx[_dstOff + col] = px[_srcOff + col];
            }
          }
          _s30_tmpCanvas.width = w;
          _s30_tmpCanvas.height = h;
          var _imgData2 = _s30_tmpCtx.createImageData(w, h);
          _imgData2.data.set(_flipPx);
          _s30_tmpCtx.putImageData(_imgData2, 0, 0);
          return origFn.call(_s30_tmpCanvas, type, quality);
        }
      } catch(_glErr) {}
      return origFn.call(canvas, type, quality);
    }

    var _origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(type, quality) {
      try {
        return _applyNoiseToDataURL(this, _origToDataURL, type, quality);
      } catch(e) {}
      return _origToDataURL.call(this, type, quality);
    };

    var _origToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function(callback, type, quality) {
      try {
        var _self = this;
        var ctx = _self.getContext('2d');
        if (ctx) {
          var imgData = ctx.getImageData(0, 0, Math.max(1, _self.width), Math.max(1, _self.height));
          _s30_tmpCanvas.width = _self.width;
          _s30_tmpCanvas.height = _self.height;
          _s30_tmpCtx.putImageData(imgData, 0, 0);
          return _origToBlob.call(_s30_tmpCanvas, callback, type, quality);
        }
        // WebGL canvas fallback for toBlob
        var w = _self.width, h = _self.height;
        if (w > 0 && h > 0) {
          var glCtx = _self.getContext('webgl') || _self.getContext('webgl2') || _self.getContext('experimental-webgl');
          if (glCtx) {
            var px = new Uint8Array(w * h * 4);
            glCtx.readPixels(0, 0, w, h, 0x1908, 0x1401, px);
            var _flipPx = new Uint8Array(px.length);
            for (var row = 0; row < h; row++) {
              var _srcOff = (h - 1 - row) * w * 4;
              var _dstOff = row * w * 4;
              for (var col = 0; col < w * 4; col++) {
                _flipPx[_dstOff + col] = px[_srcOff + col];
              }
            }
            _s30_tmpCanvas.width = w;
            _s30_tmpCanvas.height = h;
            var _imgData3 = _s30_tmpCtx.createImageData(w, h);
            _imgData3.data.set(_flipPx);
            _s30_tmpCtx.putImageData(_imgData3, 0, 0);
            return _origToBlob.call(_s30_tmpCanvas, callback, type, quality);
          }
        }
      } catch(e) {}
      return _origToBlob.call(this, callback, type, quality);
    };
  } catch(e) {}

  // ---- Canvas 2D Context Proxy (enhanced fingerprint resistance) ----
  // R55 enhanced: Intercepts fillText, strokeText, measureText (full TextMetrics),
  // isPointInPath, isPointInStroke, getLineDash, quadraticCurveTo, bezierCurveTo,
  // arc, ellipse, createLinearGradient, createRadialGradient, createConicGradient
  // with deterministic micro-variations.
  // Existing getImageData/toDataURL/toBlob patches (Section 20/30) remain in place;
  // the Proxy forwards those calls through to the prototype-patched versions.

  // Helper: parse a CSS color string and perturb r/g/b by ±1 (seeded)
  // R55: Cached temp canvas to avoid creating one per call (detectable side-effect)
  var _colorParseCanvas = null;
  var _colorParseCtx = null;
  function _parseAndPerturbColor(color, seed) {
    // Lazy-init cached canvas for color parsing
    if (!_colorParseCanvas) {
      try {
        _colorParseCanvas = document.createElement('canvas');
        _colorParseCanvas.width = 1;
        _colorParseCanvas.height = 1;
        _colorParseCtx = _colorParseCanvas.getContext('2d');
      } catch(_cpcErr) { return color; }
    }
    if (!_colorParseCtx) return color;
    _colorParseCtx.clearRect(0, 0, 1, 1);
    _colorParseCtx.fillStyle = color;
    var resolved = _colorParseCtx.fillStyle;
    // If the browser couldn't parse it, return as-is
    if (!resolved || resolved.charAt(0) !== '#') return color;
    // Parse hex color (#rrggbb or #rgb)
    var r = 0, g = 0, b = 0, a = 1;
    if (resolved.length === 7) {
      r = parseInt(resolved.slice(1, 3), 16);
      g = parseInt(resolved.slice(3, 5), 16);
      b = parseInt(resolved.slice(5, 7), 16);
    } else if (resolved.length === 4) {
      r = parseInt(resolved[1] + resolved[1], 16);
      g = parseInt(resolved[2] + resolved[2], 16);
      b = parseInt(resolved[3] + resolved[3], 16);
    } else {
      return color;
    }
    // Also try to extract alpha from rgba() if present in original
    var _rgbaMatch = color.match(/rgba?\s*\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)/);
    if (_rgbaMatch) a = parseFloat(_rgbaMatch[1]);
    // Apply perturbation scaled by _canvasNoiseIntensity (R55: intensity-aware)
    var _intScale = _canvasNoiseIntensity > 0 ? Math.min(_canvasNoiseIntensity, 2.0) : 1.0;
    seed = (seed * 16807 + 0.5) % 2147483647;
    var _rNoise = Math.round(((seed % 3) - 1) * _intScale); // scaled by intensity
    seed = (seed * 16807 + 0.5) % 2147483647;
    var _gNoise = Math.round(((seed % 3) - 1) * _intScale);
    seed = (seed * 16807 + 0.5) % 2147483647;
    var _bNoise = Math.round(((seed % 3) - 1) * _intScale);
    r = Math.max(0, Math.min(255, r + _rNoise));
    g = Math.max(0, Math.min(255, g + _gNoise));
    b = Math.max(0, Math.min(255, b + _bNoise));
    // Return in same format as original
    var _rh = r.toString(16).padStart(2, '0');
    var _gh = g.toString(16).padStart(2, '0');
    var _bh = b.toString(16).padStart(2, '0');
    if (a < 1) {
      return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
    }
    return '#' + _rh + _gh + _bh;
  }

  try {
    var _origGetContext = HTMLCanvasElement.prototype.getContext;
    var _ctxProxySeed = Math.floor(_fakeDeviceSeed * 3.14159) | 0;
    HTMLCanvasElement.prototype.getContext = function(type, attrs) {
      var ctx = _origGetContext.call(this, type, attrs);
      if (type === '2d' && ctx) {
        // Increment per-canvas counter for unique noise seeds
        _canvasInstanceCount++;
        // Capture seed snapshot so each canvas context gets consistent noise
        var _2dSeed = _ctxProxySeed;
        return new Proxy(ctx, {
          get: function(target, prop) {
            // R55 Enhanced measureText — vary ALL TextMetrics properties, not just width.
            // Real browsers produce slightly different TextMetrics across platforms due to
            // different font rasterizers (DirectWrite vs CoreText vs FreeType).
            // Anti-bot systems check multiple TextMetrics properties for consistency.
            if (prop === 'measureText') {
              return function() {
                var result = target.measureText.apply(target, arguments);
                try {
                  var _text = arguments[0] || '';
                  // Hash text content + font for deterministic per-text noise
                  var _mHash = _2dSeed;
                  for (var _mi = 0; _mi < _text.length; _mi++) {
                    _mHash = ((_mHash << 5) - _mHash + _text.charCodeAt(_mi)) | 0;
                  }
                  // Also hash the current font for font-specific variation
                  var _curFont = target.font || '10px sans-serif';
                  for (var _fj = 0; _fj < _curFont.length; _fj++) {
                    _mHash = ((_mHash << 3) - _mHash + _curFont.charCodeAt(_fj)) | 0;
                  }
                  _mHash = Math.abs(_mHash);
                  // Generate 7 independent noise values for different TextMetrics properties
                  var _tmS = _mHash;
                  _tmS = (_tmS * 16807 + 0.5) % 2147483647;
                  var _nW = ((_tmS % 21) - 10) * 0.0015;    // width: ±0.015px
                  _tmS = (_tmS * 16807 + 0.5) % 2147483647;
                  var _nABL = ((_tmS % 11) - 5) * 0.001;    // actualBoundingBoxLeft: ±0.005px
                  _tmS = (_tmS * 16807 + 0.5) % 2147483647;
                  var _nABR = ((_tmS % 11) - 5) * 0.001;    // actualBoundingBoxRight: ±0.005px
                  _tmS = (_tmS * 16807 + 0.5) % 2147483647;
                  var _nABA = ((_tmS % 11) - 5) * 0.001;    // actualBoundingBoxAscent: ±0.005px
                  _tmS = (_tmS * 16807 + 0.5) % 2147483647;
                  var _nABD = ((_tmS % 11) - 5) * 0.001;    // actualBoundingBoxDescent: ±0.005px
                  _tmS = (_tmS * 16807 + 0.5) % 2147483647;
                  var _nFBA = ((_tmS % 7) - 3) * 0.0005;     // fontBoundingBoxAscent: ±0.0015px
                  _tmS = (_tmS * 16807 + 0.5) % 2147483647;
                  var _nFBD = ((_tmS % 7) - 3) * 0.0005;     // fontBoundingBoxDescent: ±0.0015px
                  // Apply noise to all available TextMetrics properties
                  var _tmProps = ['width', 'actualBoundingBoxLeft', 'actualBoundingBoxRight',
                    'actualBoundingBoxAscent', 'actualBoundingBoxDescent',
                    'fontBoundingBoxAscent', 'fontBoundingBoxDescent'];
                  var _tmNoises = [_nW, _nABL, _nABR, _nABA, _nABD, _nFBA, _nFBD];
                  for (var _ti = 0; _ti < _tmProps.length; _ti++) {
                    var _pName = _tmProps[_ti];
                    var _origVal = result[_pName];
                    if (typeof _origVal === 'number' && isFinite(_origVal)) {
                      (function(p, orig, noise) {
                        try {
                          Object.defineProperty(result, p, {
                            get: function() { return orig + noise; },
                            configurable: true
                          });
                        } catch(_tdErr) {}
                      })(_pName, _origVal, _tmNoises[_ti]);
                    }
                  }
                } catch(_e) {}
                return result;
              };
            }
            // isPointInPath — add ±0.1px offset to test point (seeded by coordinates)
            if (prop === 'isPointInPath') {
              return function() {
                var args = Array.prototype.slice.call(arguments);
                var xi = 0, yi = 1;
                if (args.length >= 3 && args[0] && typeof args[0].addPath === 'function') { xi = 1; yi = 2; }
                var _cx = (args[xi] || 0) | 0, _cy = (args[yi] || 0) | 0;
                var _pS = (_2dSeed + _cx * 37 + _cy * 53) | 0;
                var _dx = ((_pS % 201) - 100) * 0.001; // ±0.1px
                _pS = (_pS + _cx * 17 + _cy * 31) | 0;
                var _dy = ((_pS % 201) - 100) * 0.001;
                args[xi] = (args[xi] || 0) + _dx;
                args[yi] = (args[yi] || 0) + _dy;
                return target.isPointInPath.apply(target, args);
              };
            }
            // isPointInStroke — add ±0.1px offset to test point (seeded by coordinates)
            if (prop === 'isPointInStroke') {
              return function() {
                var args = Array.prototype.slice.call(arguments);
                var xi = 0, yi = 1;
                if (args.length >= 3 && args[0] && typeof args[0].addPath === 'function') { xi = 1; yi = 2; }
                var _cx = (args[xi] || 0) | 0, _cy = (args[yi] || 0) | 0;
                var _sS = (_2dSeed + _cx * 41 + _cy * 59) | 0;
                var _sdx = ((_sS % 201) - 100) * 0.001;
                _sS = (_sS + _cx * 19 + _cy * 37) | 0;
                var _sdy = ((_sS % 201) - 100) * 0.001;
                args[xi] = (args[xi] || 0) + _sdx;
                args[yi] = (args[yi] || 0) + _sdy;
                return target.isPointInStroke.apply(target, args);
              };
            }
            // getLineDash — slight variations of dash pattern segments
            if (prop === 'getLineDash') {
              return function() {
                var result = target.getLineDash.apply(target, arguments);
                try {
                  var _lS = (_2dSeed * 16807 + 3.5) % 2147483647;
                  for (var i = 0; i < result.length; i++) {
                    _lS = (_lS * 16807 + 0.5) % 2147483647;
                    result[i] = Math.max(0.1, result[i] + ((_lS % 21) - 10) * 0.01);
                  }
                } catch(_e) {}
                return result;
              };
            }
            // R55: fillText/strokeText — add ±0.05px sub-pixel positioning noise.
            // Different GPU/driver combos render text at slightly different sub-pixel
            // positions. Fingerprinting scripts that draw text and then read back via
            // getImageData can detect the absence of this variation.
            if (prop === 'fillText') {
              return function() {
                var args = Array.prototype.slice.call(arguments);
                try {
                  var _ftS = (_2dSeed * 16807 + 3.0) % 2147483647;
                  var _ftX = args.length > 1 ? args[1] : 0;
                  var _ftY = args.length > 2 ? args[2] : 0;
                  _ftS = (_ftS * 16807 + _ftX * 13 + _ftY * 17) % 2147483647;
                  var _ftDx = ((_ftS % 101) - 50) * 0.001; // ±0.05px
                  _ftS = (_ftS * 16807 + 0.5) % 2147483647;
                  var _ftDy = ((_ftS % 101) - 50) * 0.001;
                  if (args.length > 1) args[1] = _ftX + _ftDx;
                  if (args.length > 2) args[2] = _ftY + _ftDy;
                } catch(_e) {}
                return target.fillText.apply(target, args);
              };
            }
            if (prop === 'strokeText') {
              return function() {
                var args = Array.prototype.slice.call(arguments);
                try {
                  var _stS = (_2dSeed * 16807 + 3.2) % 2147483647;
                  var _stX = args.length > 1 ? args[1] : 0;
                  var _stY = args.length > 2 ? args[2] : 0;
                  _stS = (_stS * 16807 + _stX * 19 + _stY * 23) % 2147483647;
                  var _stDx = ((_stS % 101) - 50) * 0.001;
                  _stS = (_stS * 16807 + 0.5) % 2147483647;
                  var _stDy = ((_stS % 101) - 50) * 0.001;
                  if (args.length > 1) args[1] = _stX + _stDx;
                  if (args.length > 2) args[2] = _stY + _stDy;
                } catch(_e) {}
                return target.strokeText.apply(target, args);
              };
            }
            // quadraticCurveTo — tiny control-point offset (affects isPointInPath)
            if (prop === 'quadraticCurveTo') {
              return function(cpx, cpy, x, y) {
                var _qS = (_2dSeed * 16807 + 4.5) % 2147483647;
                var _qdx = ((_qS % 201) - 100) * 0.0001;
                _qS = (_qS * 16807 + 0.5) % 2147483647;
                var _qdy = ((_qS % 201) - 100) * 0.0001;
                return target.quadraticCurveTo(cpx + _qdx, cpy + _qdy, x + _qdx * 0.5, y + _qdy * 0.5);
              };
            }
            // bezierCurveTo — tiny control-point offsets (affects isPointInPath)
            if (prop === 'bezierCurveTo') {
              return function(cp1x, cp1y, cp2x, cp2y, x, y) {
                var _bS = (_2dSeed * 16807 + 5.5) % 2147483647;
                var _bdx = ((_bS % 201) - 100) * 0.0001;
                _bS = (_bS * 16807 + 0.5) % 2147483647;
                var _bdy = ((_bS % 201) - 100) * 0.0001;
                return target.bezierCurveTo(
                  cp1x + _bdx, cp1y + _bdy,
                  cp2x + _bdx * 0.8, cp2y + _bdy * 0.8,
                  x + _bdx * 0.3, y + _bdy * 0.3
                );
              };
            }
            // arc — tiny radius variation (±0.01)
            if (prop === 'arc') {
              return function(x, y, radius, startAngle, endAngle, anticlockwise) {
                var _aS = (_2dSeed * 16807 + 6.5) % 2147483647;
                var _aNoise = ((_aS % 21) - 10) * 0.001; // ±0.01
                return target.arc(x, y, Math.max(0, radius + _aNoise), startAngle, endAngle, anticlockwise);
              };
            }
            // ellipse — tiny radius variation on both radii (±0.01)
            if (prop === 'ellipse') {
              return function(x, y, rx, ry, rotation, startAngle, endAngle, anticlockwise) {
                var _eS = (_2dSeed * 16807 + 7.5) % 2147483647;
                var _eNoiseRx = ((_eS % 21) - 10) * 0.001;
                _eS = (_eS * 16807 + 0.5) % 2147483647;
                var _eNoiseRy = ((_eS % 21) - 10) * 0.001;
                return target.ellipse(
                  x, y,
                  Math.max(0, rx + _eNoiseRx), Math.max(0, ry + _eNoiseRy),
                  rotation, startAngle, endAngle, anticlockwise
                );
              };
            }
            // createLinearGradient — return proxy that adds noise to addColorStop
            if (prop === 'createLinearGradient') {
              return function(x0, y0, x1, y1) {
                var gradient = target.createLinearGradient(x0, y0, x1, y1);
                // Seed based on gradient parameters for deterministic noise
                var _gSeed = (((_2dSeed + (x0 * 37 + y0 * 53 + x1 * 41 + y1 * 59)) | 0) * 16807 + 8.5) % 2147483647;
                var _origAddColorStop = gradient.addColorStop.bind(gradient);
                gradient.addColorStop = function(offset, color) {
                  try {
                    // Parse CSS color and perturb by ±1
                    var _parsed = _parseAndPerturbColor(color, _gSeed);
                    if (_parsed !== color) {
                      _gSeed = (_gSeed * 16807 + 0.5) % 2147483647; // advance seed for next stop
                      return _origAddColorStop(offset, _parsed);
                    }
                  } catch(_gErr) {}
                  return _origAddColorStop(offset, color);
                };
                return gradient;
              };
            }
            // createRadialGradient — return proxy that adds noise to addColorStop
            if (prop === 'createRadialGradient') {
              return function(x0, y0, r0, x1, y1, r1) {
                var gradient = target.createRadialGradient(x0, y0, r0, x1, y1, r1);
                var _rgSeed = (((_2dSeed + (x0 * 43 + y0 * 61 + x1 * 47 + y1 * 67 + r0 * 29 + r1 * 31)) | 0) * 16807 + 9.5) % 2147483647;
                var _origAddColorStop2 = gradient.addColorStop.bind(gradient);
                gradient.addColorStop = function(offset, color) {
                  try {
                    var _parsed2 = _parseAndPerturbColor(color, _rgSeed);
                    if (_parsed2 !== color) {
                      _rgSeed = (_rgSeed * 16807 + 0.5) % 2147483647;
                      return _origAddColorStop2(offset, _parsed2);
                    }
                  } catch(_rgErr) {}
                  return _origAddColorStop2(offset, color);
                };
                return gradient;
              };
            }
            // R55: createConicGradient — return proxy that adds noise to addColorStop
            // Chrome 99+/Edge 99+/Firefox 113+ support this API.
            // Anti-bot systems can detect headless by checking conic gradient rendering.
            if (prop === 'createConicGradient') {
              return function(startAngle, x, y) {
                var gradient = target.createConicGradient(startAngle, x, y);
                var _cgSeed = (((_2dSeed + (startAngle * 100 + x * 41 + y * 59)) | 0) * 16807 + 10.5) % 2147483647;
                var _origAddColorStop3 = gradient.addColorStop.bind(gradient);
                gradient.addColorStop = function(offset, color) {
                  try {
                    var _parsed3 = _parseAndPerturbColor(color, _cgSeed);
                    if (_parsed3 !== color) {
                      _cgSeed = (_cgSeed * 16807 + 0.5) % 2147483647;
                      return _origAddColorStop3(offset, _parsed3);
                    }
                  } catch(_cgErr) {}
                  return _origAddColorStop3(offset, color);
                };
                return gradient;
              };
            }
            // Forward all other property accesses to the real context
            return target[prop];
          }
        });
      }
      return ctx;
    };
  } catch(_e) {}

  // ---- 31. AudioContext Fingerprint Noise ----
  // Override createOscillator to inject slight frequency variation,
  // making audio fingerprinting inconsistent across page loads.
  try {
    var _audioNoiseSeed = _fakeDeviceSeed * 7.91;
    var _origCreateOscillator = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function() {
      var osc = _origCreateOscillator.call(this);
      try {
        var origConnect = osc.connect.bind(osc);
        var origFrequency = osc.frequency;
        if (origFrequency) {
          _audioNoiseSeed = (_audioNoiseSeed * 16807 + 0.5) % 2147483647;
          var freqOffset = ((_audioNoiseSeed % 100) - 50) * 0.0001; // ±0.005 Hz
          var origFreqValue = origFrequency.value;
          Object.defineProperty(origFrequency, 'value', {
            get: function() { return origFreqValue + freqOffset; },
            set: function(v) { origFreqValue = v; },
            configurable: true
          });
        }
      } catch(e) {}
      return osc;
    };

    // Also override OfflineAudioContext (used by some fingerprinting libs)
    if (typeof OfflineAudioContext !== 'undefined') {
      var _origOfflineCreateOsc = OfflineAudioContext.prototype.createOscillator;
      OfflineAudioContext.prototype.createOscillator = function() {
        var osc = _origOfflineCreateOsc.call(this);
        try {
          var origFreq = osc.frequency;
          if (origFreq) {
            _audioNoiseSeed = (_audioNoiseSeed * 16807 + 0.5) % 2147483647;
            var fOff = ((_audioNoiseSeed % 100) - 50) * 0.0001;
            var _origVal = origFreq.value;
            Object.defineProperty(origFreq, 'value', {
              get: function() { return _origVal + fOff; },
              set: function(v) { _origVal = v; },
              configurable: true
            });
          }
        } catch(e) {}
        return osc;
      };
    }
  } catch(e) {}

  // ---- AnalyserNode frequency data noise ----
  // Adds deterministic ±0.001 noise to getFloatFrequencyData and
  // ±1 to getByteFrequencyData outputs, using the same seed as canvas/audio.
  try {
    var _analyserSeed = Math.floor(_fakeDeviceSeed * 9.83) | 0;
    // getFloatFrequencyData — ±0.001 per bin
    var _origGetFloatFreq = AnalyserNode.prototype.getFloatFrequencyData;
    AnalyserNode.prototype.getFloatFrequencyData = function(array) {
      _origGetFloatFreq.call(this, array);
      if (array && array.length) {
        var _aS = _analyserSeed;
        for (var i = 0; i < array.length; i++) {
          _aS = (_aS * 16807 + 0.5) % 2147483647;
          array[i] = array[i] + ((_aS % 2001) - 1000) * 0.000001; // ±0.001
        }
      }
    };
    // getByteFrequencyData — ±1 per bin
    var _origGetByteFreq = AnalyserNode.prototype.getByteFrequencyData;
    AnalyserNode.prototype.getByteFrequencyData = function(array) {
      _origGetByteFreq.call(this, array);
      if (array && array.length) {
        var _bS = _analyserSeed + 7;
        for (var i = 0; i < array.length; i++) {
          _bS = (_bS * 16807 + 0.5) % 2147483647;
          var _bNoise = (_bS % 3) - 1; // -1, 0, or +1
          array[i] = Math.max(0, Math.min(255, array[i] + _bNoise));
        }
      }
    };
    // getByteTimeDomainData — ±1 per sample for waveform fingerprint noise
    var _origGetByteTime = AnalyserNode.prototype.getByteTimeDomainData;
    AnalyserNode.prototype.getByteTimeDomainData = function(array) {
      _origGetByteTime.call(this, array);
      if (array && array.length) {
        var _tS = _analyserSeed + 13;
        for (var i = 0; i < array.length; i++) {
          _tS = (_tS * 16807 + 0.5) % 2147483647;
          var _tNoise = (_tS % 3) - 1;
          array[i] = Math.max(0, Math.min(255, array[i] + _tNoise));
        }
      }
    };
    // getFloatTimeDomainData — ±0.001 per sample
    var _origGetFloatTime = AnalyserNode.prototype.getFloatTimeDomainData;
    if (_origGetFloatTime) {
      AnalyserNode.prototype.getFloatTimeDomainData = function(array) {
        _origGetFloatTime.call(this, array);
        if (array && array.length) {
          var _ftS = _analyserSeed + 19;
          for (var i = 0; i < array.length; i++) {
            _ftS = (_ftS * 16807 + 0.5) % 2147483647;
            array[i] = array[i] + ((_ftS % 2001) - 1000) * 0.000001;
          }
        }
      };
    }
  } catch(_e) {}

  // ---- 32. Navigation Timing Simulation ----
  // Override performance.getEntriesByType('navigation') to return realistic values,
  // preventing detection via timing-based fingerprinting.

  // Seeded PRNG already defined at top of IIFE for early availability.
  var _tzOffsetMs = (PROFILE.timezoneOffset || 0) * 60000;
  var _perfTimingOffset = 3000 + Math.abs(_tzOffsetMs);

  try {
    var _origGetEntriesByType = Performance.prototype.getEntriesByType;
    Performance.prototype.getEntriesByType = function(type) {
      if (type === 'navigation') {
        var navStart = _perfTimingOffset || 0;
        var dcl = 200 + Math.floor(_seededRandom(42) * 600); // 200-800ms
        var load = 500 + Math.floor(_seededRandom(99) * 1500);  // 500-2000ms
        var transferSize = 50 * 1024 + Math.floor(_seededRandom(77) * 450 * 1024); // 50-500KB
        return [{
          name: location.href,
          entryType: 'navigation',
          startTime: 0,
          duration: load,
          initiatorType: 'navigation',
          nextHopProtocol: 'h2',
          domContentLoadedEventEnd: dcl,
          domContentLoadedEventStart: dcl - 5 - Math.floor(_seededRandom(33) * 50),
          loadEventEnd: load,
          loadEventStart: load - 3 - Math.floor(_seededRandom(55) * 30),
          transferSize: transferSize,
          encodedBodySize: Math.floor(transferSize * 0.7),
          decodedBodySize: Math.floor(transferSize * 0.85),
          responseStart: 30 + Math.floor(_seededRandom(11) * 120),
          domainLookupEnd: 5 + Math.floor(_seededRandom(22) * 30),
          domainLookupStart: Math.floor(_seededRandom(22) * 5),
          connectEnd: 40 + Math.floor(_seededRandom(44) * 80),
          connectStart: 10 + Math.floor(_seededRandom(44) * 30),
          secureConnectionStart: 15 + Math.floor(_seededRandom(44) * 25),
          requestStart: 50 + Math.floor(_seededRandom(55) * 100),
          responseEnd: 100 + Math.floor(_seededRandom(66) * 200),
          type: 'navigate',
          redirectCount: 0,
          toJSON: function() { return Object.assign({}, this); }
        }];
      }
      return _origGetEntriesByType.call(this, type);
    };
  } catch(e) {}

  // ---- 33. PerformanceObserver Neutralization ----
  // When code tries to observe 'navigation' or 'resource' types,
  // provide a fake observer that silently swallows callbacks.
  // This prevents detection via PerformanceObserver registration patterns.
  try {
    var _origPerformanceObserver = PerformanceObserver;
    var _neutralizedTypes = ['navigation', 'resource', 'longtask', 'paint', 'largest-contentful-paint', 'layout-shift', 'element'];
    window.PerformanceObserver = function(callback) {
      // Store original callback but wrap it to no-op for neutralized types
      this._callback = callback;
      this._observedTypes = [];
      this._active = false;
    };
    window.PerformanceObserver.prototype = Object.create(_origPerformanceObserver.prototype);
    Object.assign(window.PerformanceObserver.prototype, {
      observe: function(options) {
        if (options && options.type) {
          this._observedTypes.push(options.type);
          // For neutralized types, do NOT call the real observe — the observer
          // simply never fires, which is valid behavior (observer may be
          // created before the events occur).
          if (_neutralizedTypes.indexOf(options.type) !== -1) {
            this._active = false;
            return;
          }
        }
        // For non-neutralized types, pass through to real implementation
        try {
          var realObs = new _origPerformanceObserver(this._callback);
          realObs.observe(options);
          this._realObs = realObs;
          this._active = true;
        } catch(e) {}
      },
      disconnect: function() {
        this._active = false;
        if (this._realObs) {
          try { this._realObs.disconnect(); } catch(e) {}
          this._realObs = null;
        }
      },
      takeRecords: function() {
        // Always return empty array — neutralized observers must never leak timing records,
        // even for non-neutralized types mixed into the same observer instance
        return [];
      },
      supportedEntryTypes: _origPerformanceObserver.supportedEntryTypes || []
    });
    // Preserve static methods
    if (_origPerformanceObserver.supportedEntryTypes) {
      window.PerformanceObserver.supportedEntryTypes = _origPerformanceObserver.supportedEntryTypes;
    }
  } catch(e) {}

  // Section 34: iframe contentWindow detection bypass
  // Some anti-bot systems check: window.self === window.top (should be true in main frame)
  // and document.readyState consistency
  try {
    Object.defineProperty(window, 'self', { get: function() { return window; } });
  } catch(e) {}

  // Section 35: Notification.permission — real browsers return 'default' or 'denied'
  // Never 'granted' in headless. Return 'default' for consistency.
  try {
    if (!window.Notification) {
      window.Notification = function() {};
      window.Notification.permission = 'default';
      window.Notification.requestPermission = function(cb) {
        const p = Promise.resolve('default');
        if (cb) cb('default');
        return p;
      };
    } else if (Notification.permission === undefined) {
      Notification.permission = 'default';
    }
  } catch(e) {}

  // Section 36: document.hasFocus() — headless browsers often report false
  // Real browsers always report true when the page is in the active tab
  try {
    Object.defineProperty(document, 'hasFocus', {
      value: function() { return true; },
      writable: true,
      configurable: true,
    });
  } catch(e) {}

  // outerWidth/outerHeight is handled by Section 57 with seeded consistency.

  // Section 38: Permissions.query() — headless returns unexpected permission states
  // Real Chrome: notifications=default, geolocation=prompt, push=prompt, midi=prompt
  (function() {
    try {
      var _origQuery = Permissions.prototype.query;
      var permissionStates = {
        'notifications': { state: 'default', onchange: null },
        'geolocation': { state: 'prompt', onchange: null },
        'push': { state: 'prompt', onchange: null },
        'midi': { state: 'prompt', onchange: null },
        'camera': { state: 'prompt', onchange: null },
        'microphone': { state: 'prompt', onchange: null },
        'clipboard-read': { state: 'prompt', onchange: null },
        'clipboard-write': { state: 'granted', onchange: null },
        'accelerometer': { state: 'prompt', onchange: null },
        'gyroscope': { state: 'prompt', onchange: null },
        'magnetometer': { state: 'prompt', onchange: null },
        'fullscreen': { state: 'prompt', onchange: null },
        'persistent-storage': { state: 'prompt', onchange: null },
      };
      Permissions.prototype.query = function(desc) {
        var name = desc && desc.name ? desc.name : '';
        var result = permissionStates[name] || { state: 'prompt', onchange: null };
        // Ensure PermissionStatus has event methods (consistent with Section 104)
        if (!result.addEventListener) result.addEventListener = function() {};
        if (!result.removeEventListener) result.removeEventListener = function() {};
        if (typeof result.dispatchEvent !== 'function') result.dispatchEvent = function() { return false; };
        return Promise.resolve(result);
      };
    } catch(e) {}
  })();

  // Section 39: document.visibilityState and document.hidden
  // Headless browsers sometimes report 'hidden' or inconsistent visibility
  try {
    Object.defineProperty(document, 'visibilityState', {
      get: function() { return 'visible'; },
      configurable: true,
    });
    Object.defineProperty(document, 'hidden', {
      get: function() { return false; },
      configurable: true,
    });
  } catch(e) {}

  // Section 40: SharedWorker and ServiceWorker detection consistency
  // Anti-bot checks: does 'serviceWorker' in navigator return true?
  // Does SharedWorker constructor exist?
  try {
    // Ensure ServiceWorkerContainer exists (headless Chrome has it, but check)
    if (!navigator.serviceWorker) {
      navigator.serviceWorker = {
        controller: null,
        ready: Promise.resolve({
          active: null,
          scriptURL: '',
          state: 'redundant',
        }),
        register: function() { return Promise.resolve({ unregister: function() { return Promise.resolve(true); } }); },
        getRegistrations: function() { return Promise.resolve([]); },
        addEventListener: function() {},
        removeEventListener: function() {},
      };
    }
    // Ensure SharedWorker constructor exists
    if (typeof window.SharedWorker === 'undefined') {
      window.SharedWorker = function(port) {
        this.port = {
          start: function() {},
          postMessage: function() {},
          close: function() {},
          addEventListener: function() {},
          removeEventListener: function() {},
          onmessage: null,
        };
      };
    }
  } catch(e) {}

  // Section 41: CSS.supports() consistency — headless Chromium may report different
  // CSS feature support than real Chrome. Override to return consistent results.
  // Some anti-bot systems check: CSS.supports('display: grid') or obscure properties.
  try {
    if (window.CSS && CSS.supports) {
      var _origSupports = CSS.supports.bind(CSS);
      var _blockedSupports = [
        'display: contents',  // May differ in headless
      ];
      CSS.supports = function(prop, val) {
        var query = val !== undefined ? prop + ': ' + val : prop;
        for (var i = 0; i < _blockedSupports.length; i++) {
          if (query === _blockedSupports[i]) return true;
        }
        try { return _origSupports(prop, val); } catch(e) { return false; }
      };
    }
  } catch(e) {}

  // Section 44: ResizeObserver / IntersectionObserver existence + basic mock
  // Some anti-bot systems check if these observers report realistic observations.
  // Headless browsers may have different IntersectionObserver thresholds.
  try {
    if (typeof IntersectionObserver === 'undefined') {
      window.IntersectionObserver = function(callback, options) {
        this.observe = function() {};
        this.unobserve = function() {};
        this.disconnect = function() {};
        this.takeRecords = function() { return []; };
      };
    }
    if (typeof ResizeObserver === 'undefined') {
      window.ResizeObserver = function(callback) {
        this.observe = function() {};
        this.unobserve = function() {};
        this.disconnect = function() {};
      };
    }
  } catch(e) {}

  // Section 45: window.getComputedStyle consistency
  // Some anti-bot systems use getComputedStyle to detect headless by checking
  // computed styles of known elements. Ensure consistent return values.
  try {
    var _origGetComputedStyle = window.getComputedStyle;
    window.getComputedStyle = function(el, pseudoElt) {
      var style = _origGetComputedStyle(el, pseudoElt);
      if (!style) return style;
      // Ensure cursor is never 'none' for headless detection (only 'none' is a headless signal;
      // 'default' is a legitimate cursor value returned by real browsers on non-interactive elements)
      var cursor = style.cursor;
      if (cursor === 'none') {
        try {
          Object.defineProperty(style, 'cursor', {
            get: function() { return 'auto'; },
            configurable: true,
          });
        } catch(e) {}
      }
      return style;
    };
  } catch(e) {}

  // Section 46: matchMedia consistency
  // Headless browsers may report different media query results.
  // Override prefers-color-scheme, prefers-reduced-motion, and other queries.
  // Also handle compound queries containing overridden features (e.g., not (...)).
  try {
    if (window.matchMedia) {
      var _origMatchMedia = window.matchMedia;
      var _prefersDark = _seededRandom(46.1) > 0.7;
      var _prefersReducedMotion = false;
      var _prefersContrastMore = false;
      var _mediaOverrides = {
        'prefers-color-scheme: dark': _prefersDark,
        'prefers-color-scheme: light': !_prefersDark,
        'prefers-reduced-motion: reduce': _prefersReducedMotion,
        'prefers-reduced-motion: no-preference': !_prefersReducedMotion,
        'not (prefers-reduced-motion: reduce)': !_prefersReducedMotion,
        '(prefers-reduced-motion: reduce)': _prefersReducedMotion,
        '(prefers-reduced-motion: no-preference)': !_prefersReducedMotion,
        'prefers-contrast: more': _prefersContrastMore,
        'prefers-contrast: no-preference': !_prefersContrastMore,
        'not (prefers-contrast: more)': !_prefersContrastMore,
        'display-mode: standalone': false,
        'display-mode: browser': true,
        'orientation: portrait': PROFILE.screenWidth < PROFILE.screenHeight,
        'orientation: landscape': PROFILE.screenWidth >= PROFILE.screenHeight,
        '(prefers-color-scheme: dark)': _prefersDark,
        '(prefers-color-scheme: light)': !_prefersDark,
      };
      // Fallback MediaQueryList mock for when _origMatchMedia throws
      function _fakeMQL(query) {
        return {
          matches: false, media: query, onchange: null,
          addEventListener: function(){}, removeEventListener: function(){},
          dispatchEvent: function() { return false; },
        };
      }
      window.matchMedia = function(query) {
        var result;
        try { result = _origMatchMedia(query); } catch(_mme) { return _fakeMQL(query); }
        if (!_mediaOverrides.hasOwnProperty(query)) {
          // Check if query contains overridden features as compound query
          var _qLower = (query || '').toLowerCase();
          if (_qLower.indexOf('prefers-reduced-motion') >= 0) {
            try { Object.defineProperty(result, 'matches', { get: function() { return _prefersReducedMotion; }, configurable: true }); } catch(e) {}
          } else if (_qLower.indexOf('prefers-color-scheme') >= 0) {
            try { Object.defineProperty(result, 'matches', { get: function() { return _prefersDark; }, configurable: true }); } catch(e) {}
          } else if (_qLower.indexOf('prefers-contrast') >= 0) {
            try { Object.defineProperty(result, 'matches', { get: function() { return _prefersContrastMore; }, configurable: true }); } catch(e) {}
          }
          return result;
        }
        try {
          Object.defineProperty(result, 'matches', {
            get: function() { return _mediaOverrides[query]; },
            configurable: true,
          });
        } catch(e) {}
        return result;
      };
    }
  } catch(e) {}

  // Section 47: WebGL Shader Precision
  // Headless browsers may return empty strings or inconsistent values for
  // getShaderPrecisionFormat(). Real Chrome returns specific ranges.
  // IMPORTANT: precisionType varies — 0x8DF0=LOW_FLOAT, 0x8DF1=MEDIUM_FLOAT,
  // 0x8DF2=HIGH_FLOAT, 0x8DF5=LOW_INT, 0x8DF6=MEDIUM_INT, 0x8DF7=HIGH_INT.
  // Real Chrome returns different ranges for float vs int types.
  try {
    var _origGetShaderPrecisionFormat = WebGLRenderingContext.prototype.getShaderPrecisionFormat;
    var _shaderPrecisionSeed = _fakeDeviceSeed * 5.17;
    function _patchPrecisionResult(result, precisionType) {
      if (!result) return result;
      // Only patch if headless returns suspicious zeros
      if (result.rangeMin !== 0 || result.rangeMax !== 0) return result;
      _shaderPrecisionSeed = (_shaderPrecisionSeed * 16807 + 0.5) % 2147483647;
      // Real Chrome: float types use rangeMin=127, rangeMax=127, precision=23
      // int types use rangeMin=31, rangeMax=31, precision=0
      var isInt = (precisionType === 0x8DF5 || precisionType === 0x8DF6 || precisionType === 0x8DF7);
      var intRange = 31; // Real Chrome always returns 31 for int types (R48#36)
      var floatPrecision = 23 + (_shaderPrecisionSeed % 3); // 23-25
      try {
        Object.defineProperties(result, {
          rangeMin: { get: function() { return isInt ? intRange : 127; }, configurable: true },
          rangeMax: { get: function() { return isInt ? intRange : 127; }, configurable: true },
          precision: { get: function() { return isInt ? 0 : floatPrecision; }, configurable: true },
        });
      } catch(e) {}
      return result;
    }
    WebGLRenderingContext.prototype.getShaderPrecisionFormat = function(shaderType, precisionType) {
      var result = _origGetShaderPrecisionFormat.call(this, shaderType, precisionType);
      return _patchPrecisionResult(result, precisionType);
    };
    // Also patch WebGL2 if available
    if (typeof WebGL2RenderingContext !== 'undefined') {
      var _origGetSPF2 = WebGL2RenderingContext.prototype.getShaderPrecisionFormat;
      if (_origGetSPF2 && _origGetSPF2 !== _origGetShaderPrecisionFormat) {
        WebGL2RenderingContext.prototype.getShaderPrecisionFormat = function(shaderType, precisionType) {
          var result = _origGetSPF2.call(this, shaderType, precisionType);
          return _patchPrecisionResult(result, precisionType);
        };
      }
    }
  } catch(e) {}

  // Section 48: Navigator Connection API (Network Information)
  // Headless browsers often have missing navigator.connection.
  // Real browsers provide effectiveType, downlink, rtt, saveData.
  // Note: if connection exists, Section 17 already overrides rtt/downlink/effectiveType/saveData.
  // The else-branch (zero-value fix) was removed as dead code — Section 17 covers it.
  try {
    if (!navigator.connection) {
      // Create a fake connection object if missing entirely.
      // Section 17 won't create it — it only overrides existing props.
      var _connSeed = _fakeDeviceSeed * 3.14;
      _connSeed = (_connSeed * 16807 + 0.5) % 2147483647;
      var _fakeDownlink = 5 + (_connSeed % 15); // 5-20 Mbps
      var _fakeRTT = 20 + ((_connSeed >> 8) % 80); // 20-100ms
      var _fakeEffectiveType = _fakeDownlink >= 10 ? '4g' : _fakeDownlink >= 4 ? '3g' : '2g';
      var _fakeConnObj = {
            effectiveType: _fakeEffectiveType,
            downlink: _fakeDownlink,
            rtt: _fakeRTT,
            saveData: false,
            type: 'wifi',
            onchange: null,
            addEventListener: function() {},
            removeEventListener: function() {},
            dispatchEvent: function() { return false; },
          };
      Object.defineProperty(navigator, 'connection', {
        get: function() {
          return _fakeConnObj;
        },
        configurable: true,
      });
    }
  } catch(e) {}

  // Section 51: speechSynthesis.getVoices() consistency
  // Headless Chromium often returns an empty array for getVoices().
  // Real browsers always have at least a default voice. We seed 3-6 fake voices.
  try {
    if (window.speechSynthesis && window.speechSynthesis.getVoices && !window.speechSynthesis._obscuraPatched) {
      var _origGetVoices = window.speechSynthesis.getVoices.bind(window.speechSynthesis);
      var _voiceSeed = _fakeDeviceSeed * 7.77;
      var _voiceNames, _voiceLangs;
      if (PROFILE.languages && PROFILE.languages[0] && PROFILE.languages[0].indexOf('zh') === 0) {
        _voiceNames = ['Google 普通话', 'Google 粤語', 'Microsoft Huihui Desktop', 'Google US English', 'Google UK English Female', 'Microsoft Zira Desktop'];
        _voiceLangs = ['zh-CN', 'zh-HK', 'zh-CN', 'en-US', 'en-GB', 'en-US'];
      } else {
        _voiceNames = ['Google US English', 'Google UK English Female', 'Microsoft David Desktop', 'Microsoft Zira Desktop', 'Alex', 'Samantha', 'Victoria', 'Karen', 'Daniel', 'Moira'];
        _voiceLangs = ['en-US', 'en-GB', 'en-US', 'en-US', 'en-US', 'en-US', 'en-US', 'en-AU', 'en-GB', 'en-GB'];
      }
      var _numVoices = 3 + Math.floor((_voiceSeed * 100) % 4); // 3-6 voices
      var _fakeVoices = [];
      for (var _vi = 0; _vi < _numVoices; _vi++) {
        var _idx = Math.floor((_voiceSeed * 10 + _vi * 3.14) % _voiceNames.length);
        _fakeVoices.push({
          voiceURI: _voiceNames[_idx],
          name: _voiceNames[_idx],
          lang: _voiceLangs[_idx],
          localService: true,
          default: _vi === 0,
        });
      }
      var _cachedVoices = null;
      window.speechSynthesis.getVoices = function() {
        if (_cachedVoices) return _cachedVoices;
        var real = _origGetVoices();
        if (real && real.length > 0) {
          // Clone real voices to prevent reference-based detection
          _cachedVoices = Array.from(real);
        } else {
          _cachedVoices = _fakeVoices;
        }
        return _cachedVoices;
      };
      window.speechSynthesis._obscuraPatched = true;
    }
  } catch(e) {}

  // Section 52: Notification.permission consistency
  // Headless may return 'denied' or throw. Real browsers return 'default'.
  try {
    if ('Notification' in window) {
      var _realNotifPerm = Notification.permission;
      if (_realNotifPerm === 'denied' || _realNotifPerm === 'granted') {
        // Force to 'default' (not yet asked) to look like a fresh real browser
        try {
          Object.defineProperty(Notification, 'permission', {
            get: function() { return 'default'; },
            configurable: true,
          });
        } catch(e2) {}
      }
      // Also patch requestPermission to not actually show a prompt
      if (Notification.requestPermission) {
        var _origReqPerm = Notification.requestPermission.bind(Notification);
        Notification.requestPermission = function() {
          return Promise.resolve('default');
        };
      }
    }
  } catch(e) {}


  // ==================== Section 55: performance.memory (Chrome-specific) ====================
  // Chrome exposes performance.memory (non-standard). Headless environments may report
  // unrealistic values (e.g., jsHeapSizeLimit of 0 or exactly 4294705152).
  // We ALWAYS override to provide realistic values that vary per profile.
  try {
    if (window.performance && (!_isFirefox)) {
      var _memSeed = Math.abs(_fakeDeviceSeed * 2.71) % 1000;
      var _jsHeapLimit = 2172649472 + Math.floor(_memSeed * 100000); // ~2GB + variation
      var _totalJSHeap = Math.floor(_jsHeapLimit * (0.15 + (_memSeed % 30) / 100)); // 15-45% used
      var _usedJSHeap = Math.floor(_totalJSHeap * (0.5 + (_memSeed % 20) / 100)); // 50-70% of total
      Object.defineProperty(window.performance, 'memory', {
        get: function() {
          return {
            jsHeapSizeLimit: _jsHeapLimit,
            totalJSHeapSize: _totalJSHeap,
            usedJSHeapSize: _usedJSHeap,
          };
        },
        configurable: true,
      });
    }
  } catch(e) {}

  // ==================== Section 57: Window frame dimensions (chrome frame) fix ====================
  // Provides a seeded, consistent outerWidth/outerHeight using _fakeDeviceSeed.
  // outerWidth/outerHeight should be larger than innerWidth/innerHeight by the
  // browser chrome (title bar, tab bar, scrollbar, etc.).
  try {
    var _innerW = window.innerWidth || PROFILE.screenWidth || 1920;
    var _innerH = window.innerHeight || PROFILE.screenHeight || 1080;
    // Chrome frame: ~85px top (tabs+title+address bar) + ~15px bottom (status) on Windows
    // On macOS: ~75px top + ~0px bottom. On Linux: ~80px top + ~15px bottom.
    var _platform = (navigator.platform || '').toLowerCase();
    var _chromeTop, _chromeBottom;
    if (_platform.indexOf('mac') >= 0) {
      _chromeTop = 70 + Math.floor(_fakeDeviceSeed % 10);
      _chromeBottom = 0;
    } else if (_platform.indexOf('linux') >= 0) {
      _chromeTop = 76 + Math.floor(_fakeDeviceSeed % 8);
      _chromeBottom = 12 + Math.floor(_fakeDeviceSeed % 6);
    } else {
      // Windows (default)
      _chromeTop = 80 + Math.floor(_fakeDeviceSeed % 12);
      _chromeBottom = 14 + Math.floor(_fakeDeviceSeed % 6);
    }
    var _targetOuterW = _innerW + 16; // scrollbar width
    var _targetOuterH = _innerH + _chromeTop + _chromeBottom;
    // Only override if the current values look wrong (e.g., outerWidth == innerWidth = headless)
    if (window.outerWidth === window.innerWidth || window.outerHeight === window.innerHeight) {
      Object.defineProperty(window, 'outerWidth', { get: function() { return _targetOuterW; }, configurable: true });
      Object.defineProperty(window, 'outerHeight', { get: function() { return _targetOuterH; }, configurable: true });
    }
  } catch(e) {}

  // ==================== Section 58: navigator.connection consistent download speed ====================
  // Some anti-bot systems check if navigator.connection.downlink is suspiciously
  // high for the reported effectiveType. Ensure consistency with W3C spec thresholds.
  // Note: RTT fix removed (dead) — Section 17 already sets non-zero seeded rtt.
  try {
    if (navigator.connection) {
      var _conn = navigator.connection;
      var _dl = _conn.downlink || 10;
      var _et = _conn.effectiveType || '4g';
      // effectiveType thresholds per W3C Network Information API spec:
      // slow-2g (<0.05 Mbps), 2g (0.05-0.5 Mbps), 3g (0.5-1.5 Mbps), 4g (>=1.5 Mbps)
      var _typeForDownlink = _dl < 0.05 ? 'slow-2g' : _dl < 0.5 ? '2g' : _dl < 1.5 ? '3g' : '4g';
      if (_et !== _typeForDownlink && _dl > 0) {
        Object.defineProperty(_conn, 'effectiveType', { get: function() { return _typeForDownlink; }, configurable: true });
      }
    }
  } catch(e) {}

  // ==================== Section 59: SharedArrayBuffer / Atomics detection ====================
  // SharedArrayBuffer 反检测增强：crossOriginIsolated 一致性、Atomics 完整性、
  // Performance.now 精度一致性、SAB 指纹随机化。
  //
  // 核心原则：SharedArrayBuffer 只有在 crossOriginIsolated=true (COOP/COEP headers)
  // 时才可用。Headless Chromium 通常带 COOP/COEP 运行，因此 SAB + crossOriginIsolated=true
  // 是一致的；而普通用户页面通常两者都不可用。我们保持一致性。
  try {
    (function() {
      var _hasSAB = typeof SharedArrayBuffer !== 'undefined';
      var _realCOI = window.crossOriginIsolated;

      // a) crossOriginIsolated 一致性伪造：当 SAB 可用时必须返回 true
      if (_hasSAB && _realCOI !== true) {
        // SAB 存在但 crossOriginIsolated 不是 true → 不一致，修正
        Object.defineProperty(window, 'crossOriginIsolated', {
          get: function() { return true; },
          configurable: true
        });
      } else if (!_hasSAB && _realCOI === true) {
        // crossOriginIsolated=true 但没有 SAB → 也不一致，隐藏 COI
        Object.defineProperty(window, 'crossOriginIsolated', {
          get: function() { return false; },
          configurable: true
        });
      }
      // 如果两者一致（SAB存在+COI=true 或 SAB不存在+COI=false），保持原样

      // a-2) 伪造 COOP/COEP header 检测：某些站点通过 fetch self 检测 headers
      // 覆盖 PerformanceResourceTiming 的 responseHeader 检测
      try {
        if (_hasSAB && window.PerformanceResourceTiming) {
          var _origGRT = PerformanceResourceTiming.prototype.getResponseHeader;
          if (_origGRT) {
            PerformanceResourceTiming.prototype.getResponseHeader = function(name) {
              var _name = (name || '').toLowerCase();
              // 返回伪造的 COOP/COEP header 以匹配 crossOriginIsolated=true
              if (_name === 'cross-origin-opener-policy') return 'same-origin';
              if (_name === 'cross-origin-embedder-policy') return 'require-corp';
              return _origGRT.call(this, name);
            };
          }
          // getAllResponseHeaders 也需要包含 COOP/COEP
          var _origGARH = PerformanceResourceTiming.prototype.getAllResponseHeaders;
          if (_origGARH) {
            PerformanceResourceTiming.prototype.getAllResponseHeaders = function() {
              var _orig = _origGARH.call(this);
              if (_orig.indexOf('cross-origin-opener-policy') < 0) {
                _orig += 'cross-origin-opener-policy: same-origin\r\n';
              }
              if (_orig.indexOf('cross-origin-embedder-policy') < 0) {
                _orig += 'cross-origin-embedder-policy: require-corp\r\n';
              }
              return _orig;
            };
          }
        }
      } catch(_coopErr) {}

      // a-3) 确保 Worker 构造器接受 SharedArrayBuffer transfer
      // (在主线程中无法完全模拟，但确保 Worker 本身存在且可用)
      try {
        if (typeof Worker !== 'undefined' && !Worker._sabPatched) {
          // Worker 在 headless 中通常可用，不需要额外 patch
          // 但某些检测检查 Worker.prototype，确保它存在
          if (!Worker.prototype) {
            Worker.prototype = {};
          }
          Worker._sabPatched = true;
        }
      } catch(_workerErr) {}

      // b) Atomics 一致性：确保 Atomics 对象完整且行为正确
      try {
        if (typeof Atomics !== 'undefined') {
          // 确保 Atomics 的标准方法都存在
          var _expectedAtomicsMethods = [
            'add', 'and', 'compareExchange', 'exchange', 'isLockFree',
            'load', 'or', 'store', 'sub', 'wait', 'waitAsync', 'notify', 'xor'
          ];
          for (var _ai = 0; _ai < _expectedAtomicsMethods.length; _ai++) {
            var _am = _expectedAtomicsMethods[_ai];
            if (typeof Atomics[_am] !== 'function') {
              // 补全缺失的 Atomics 方法
              Atomics[_am] = function() {
                if (_am === 'wait' || _am === 'waitAsync' || _am === 'notify') {
                  // wait/notify 需要 SharedArrayBuffer，非 SAB 应抛 TypeError
                  if (arguments[0] && !(arguments[0].buffer instanceof SharedArrayBuffer)) {
                    throw new TypeError('Atomics.' + _am + ' requires a SharedArrayBuffer');
                  }
                }
                // 其他方法返回默认值（实际不会被调用到，因为真浏览器都有这些方法）
                return _am === 'isLockFree' ? true : 0;
              };
            }
          }
          // 确保非 SharedArrayBuffer 上调用 wait/notify 抛 TypeError
          var _origAtomicsWait = Atomics.wait;
          var _origAtomicsNotify = Atomics.notify;
          if (_origAtomicsWait) {
            Atomics.wait = function(ta, idx, val, timeout) {
              if (ta && !(ta.buffer instanceof SharedArrayBuffer)) {
                throw new TypeError('Atomics.wait requires a SharedArrayBuffer');
              }
              return _origAtomicsWait.call(Atomics, ta, idx, val, timeout);
            };
          }
          if (_origAtomicsNotify) {
            Atomics.notify = function(ta, idx, count) {
              if (ta && !(ta.buffer instanceof SharedArrayBuffer)) {
                throw new TypeError('Atomics.notify requires a SharedArrayBuffer');
              }
              return _origAtomicsNotify.call(Atomics, ta, idx, count);
            };
          }
          // waitAsync 也需要同样检查
          if (typeof Atomics.waitAsync === 'function') {
            var _origWaitAsync = Atomics.waitAsync;
            Atomics.waitAsync = function(ta, idx, val, timeout) {
              if (ta && !(ta.buffer instanceof SharedArrayBuffer)) {
                throw new TypeError('Atomics.waitAsync requires a SharedArrayBuffer');
              }
              return _origWaitAsync.call(Atomics, ta, idx, val, timeout);
            };
          }
        }
      } catch(_atomicsErr) {}

      // c) Performance.now 精度一致性：crossOriginIsolated=true 时精度更高
      // 某些站点检测：COI=true 时 performance.now() 应该有微秒级精度，而不是被降到 1ms
      try {
        if (window.crossOriginIsolated === true && window.performance) {
          // 检测当前 performance.now 是否被降低精度到 1ms
          var _testNow = performance.now();
          var _testNow2 = performance.now();
          // 如果两次调用之间的差值总是 0 或 1，说明精度被降低了
          // 我们不需要在这里 patch performance.now（Section 25 已经做了），
          // 但需要确保精度不被额外降低。
          // 在 COI=true 时，Chrome 不会降低精度，所以我们确保返回值包含小数部分
          var _origPN = performance.now;
          var _perfNowAlreadyPatched = _origPN.toString().indexOf('Obscura') >= 0 || 
            _origPN.toString().length < 100; // 原生函数 toString 通常很长
          // 不额外 patch，Section 25 的 patch 已经保留了精度（只加了 offset，没有截断小数）
        }
      } catch(_perfCOIErr) {}

      // d) 防止 SharedArrayBuffer 指纹：随机化 buffer 分配
      // 某些检测创建特定大小的 SAB 来探测内存布局和对齐特征
      // 我们不阻止创建，但添加微小的地址随机化使其不可预测
      try {
        if (typeof SharedArrayBuffer !== 'undefined') {
          var _origSAB = SharedArrayBuffer;
          // 使用 IIFE 保护变量作用域
          SharedArrayBuffer = function(length) {
            var buf = new _origSAB(length);
            // 通过创建一个随机大小的临时 SAB 来打乱内存布局
            // 这样连续创建的 SAB 不会有固定的地址间隔
            var _rndSize = 16 + Math.floor(_seededRandom(59.1 + (length | 0)) * 64);
            try { var _dummy = new _origSAB(_rndSize); } catch(_e) {}
            return buf;
          };
          SharedArrayBuffer.prototype = _origSAB.prototype;
          SharedArrayBuffer.prototype.constructor = SharedArrayBuffer;
          // 保留静态属性/方法
          SharedArrayBuffer[Symbol.species] = _origSAB[Symbol.species] || SharedArrayBuffer;
        }
      } catch(_sabFpErr) {}
    })();
  } catch(e) {}

  // ==================== Section 60: Font enumeration protection ====================
  // Anti-bot systems enumerate installed fonts via canvas or document.fonts.
  // We report a seeded subset of common platform-matched fonts to reduce uniqueness.
  try {
    // Build a seeded font availability list based on platform
    var _platformFonts = {
      'Win32': ['Arial', 'Arial Black', 'Calibri', 'Cambria', 'Comic Sans MS', 'Consolas', 'Courier New', 'Georgia', 'Impact', 'Lucida Console', 'Lucida Sans Unicode', 'Microsoft Sans Serif', 'Palatino Linotype', 'Segoe UI', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Webdings'],
      'MacIntel': ['Arial', 'Arial Black', 'Courier New', 'Georgia', 'Helvetica', 'Helvetica Neue', 'Impact', 'Lucida Console', 'Lucida Grande', 'Menlo', 'Monaco', 'Palatino', 'Times New Roman', 'Trebuchet MS', 'Verdana'],
      'Linux x86_64': ['Arial', 'Courier New', 'DejaVu Sans', 'DejaVu Sans Mono', 'DejaVu Serif', 'Liberation Mono', 'Liberation Sans', 'Liberation Serif', 'Times New Roman', 'Ubuntu', 'Verdana'],
    };
    var _fontPool = _platformFonts[PROFILE.platform] || _platformFonts['Win32'];
    // Always-included generic families + seeded selection from pool
    var _genericFamilies = ['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy'];
    var _availableFonts = _genericFamilies.slice();
    var _fontSeed = Math.floor(_fakeDeviceSeed * 11.11) | 0;
    // Select 10-14 fonts from the pool (deterministic per seed)
    var _fontCount = 10 + (_fontSeed % 5);
    var shuffled = _fontPool.slice();
    for (var _fi = shuffled.length - 1; _fi > 0 && _fi >= shuffled.length - _fontCount; _fi--) {
      var _fj = (_seededRandom(_fi * 137) * (_fi + 1)) | 0;
      var _ftmp = shuffled[_fi]; shuffled[_fi] = shuffled[_fj]; shuffled[_fj] = _ftmp;
    }
    var selectedFonts = shuffled.slice(shuffled.length - _fontCount);
    for (var _si = 0; _si < selectedFonts.length; _si++) {
      if (_availableFonts.indexOf(selectedFonts[_si]) < 0) {
        _availableFonts.push(selectedFonts[_si]);
      }
    }
    // Sort for consistency
    _availableFonts.sort();

    if (document.fonts && document.fonts.forEach) {
      var _origForEach = document.fonts.forEach;
      document.fonts.forEach = function(callback, thisArg) {
        var _filtered = [];
        _origForEach.call(this, function(font) {
          if (_availableFonts.indexOf(font.family) >= 0 || font.status === 'loaded') {
            _filtered.push(font);
          }
        });
        _filtered.forEach(function(f, i) { callback.call(thisArg, f, i, _filtered); });
      };
      // Override check() to be consistent with the seeded font list
      var _origCheck = document.fonts.check.bind(document.fonts);
      document.fonts.check = function(font, text) {
        try {
          // Extract all font families from the CSS font string (comma-separated)
          var _families = font.split(',');
          for (var _ci = 0; _ci < _families.length; _ci++) {
            var _fam = _families[_ci].replace(/["']/g, '').trim();
            if (_fam && _genericFamilies.indexOf(_fam) < 0) {
              if (_availableFonts.indexOf(_fam) >= 0) return true;
              // Non-generic family not in our seeded list — return true (optimistic)
              // Real browsers accept any @font-face; returning false here is a detection vector
              return true;
            }
          }
          // Only generic families specified — delegate to real check
          return _origCheck(font, text);
        } catch(_e) {}
        return _origCheck(font, text);
      };
    }
    // document.fonts.ready should resolve immediately (not wait for real font loading)
    // to avoid timing-based detection of font availability
    try {
      if (document.fonts && document.fonts.ready) {
        var _origFontsAPI = document.fonts;
        Object.defineProperty(document.fonts, 'ready', {
          get: function() {
            return Promise.resolve(_origFontsAPI);
          },
          configurable: true
        });
      }
    } catch(_e) {}
  } catch(e) {}

  // ==================== Section 61: Gamepad API override ====================
  // Anti-bot systems check navigator.getGamepads() existence and return value.
  // Real Chrome always has getGamepads as a function returning an array (null entries
  // when no gamepads connected). Headless Chrome may return null or undefined.
  try {
    if (!navigator.getGamepads) {
      navigator.getGamepads = function() { return [null, null, null, null]; };
    }
    // Ensure it returns an array-like with null entries (no gamepads connected)
    var _origGetGamepads = navigator.getGamepads.bind(navigator);
    Object.defineProperty(navigator, 'getGamepads', {
      value: function() {
        var result = _origGetGamepads();
        if (!result || !Array.isArray(result)) {
          return [null, null, null, null];
        }
        return result;
      },
      configurable: true,
    });
    // Also mock the GamepadEvent constructor if missing
    if (typeof window.GamepadEvent === 'undefined' && typeof window.Event !== 'undefined') {
      window.GamepadEvent = function(type, init) {
        var evt = new Event(type, init);
        evt.gamepad = (init && init.gamepad) || null;
        return evt;
      };
      window.GamepadEvent.prototype = Event.prototype;
    }
  } catch(e) {}

  // ---- Section 62: navigator.doNotTrack consistency ----
  // When the stealth-injected page sends DNT: 1 via HTTP headers (set by the caller),
  // navigator.doNotTrack must return '1' to avoid cross-channel mismatch.
  // Default: 'null' (not set) — matches most real browsers where DNT is disabled by default.
  // The caller should NOT set DNT header to avoid this mismatch entirely.
  try {
    Object.defineProperty(navigator, 'doNotTrack', {
      get: function() { return null; },
      configurable: true,
      enumerable: true,
    });
  } catch(e) {}

  // ==================== Section 99: Fingerprint Consistency Validator ====================
  // Runs after all sections are injected. Detects cross-property inconsistencies
   // that advanced WAFs (e.g., Cloudflare Bot Management) may check.
  // Logs warnings via console.warn for debugging — does NOT fix values.
  try {
    (function() {
      var _warnings = [];
      // Check 1: navigator.hardwareConcurrency vs navigator.deviceMemory consistency
      var _hc = navigator.hardwareConcurrency;
      var _dm = navigator.deviceMemory;
      if (typeof _hc === 'number' && typeof _dm === 'number') {
        var _expectedMemMin = Math.max(2, Math.ceil(_hc / 2));
        var _expectedMemMax = _hc * 2;
        if (_dm < _expectedMemMin || _dm > _expectedMemMax) {
          _warnings.push('hardwareConcurrency=' + _hc + ' vs deviceMemory=' + _dm + 'GB (expected ' + _expectedMemMin + '-' + _expectedMemMax + 'GB)');
        }
      }
      // Check 2: navigator.language should match navigator.languages[0]
      if (navigator.language && Array.isArray(navigator.languages) && navigator.languages.length > 0) {
        if (navigator.language !== navigator.languages[0]) {
          _warnings.push('navigator.language="' + navigator.language + '" vs languages[0]="' + navigator.languages[0] + '"');
        }
      }
      // Check 3: screen.colorDepth should be 24 or 32
      var _cd = screen.colorDepth;
      if (_cd !== 24 && _cd !== 32) {
        _warnings.push('screen.colorDepth=' + _cd + ' (expected 24 or 32)');
      }
      // Check 4: timezone offset should match Intl.DateTimeFormat resolved timezone
      try {
        var _tzOffset = new Date().getTimezoneOffset();
        var _resolvedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        // Build a reference offset from the resolved timezone
        var _refDate = new Date();
        var _refOffset = -_refDate.getTimezoneOffset();
        // Cross-check: the profile-injected timezoneOffset should be consistent with Intl
        var _intlDate = new Date(new Date().toLocaleString('en-US', { timeZone: _resolvedTz }));
        var _intlOffset = (_refDate - _intlDate) / 60000;
        if (Math.abs(_tzOffset + _intlOffset) > 1) {
          _warnings.push('getTimezoneOffset()=' + _tzOffset + ' vs Intl resolved timezone "' + _resolvedTz + '" offset=' + (-_intlOffset));
        }
      } catch(_tzErr) {}
      // Log any warnings (non-blocking, debugging only)
      if (_warnings.length > 0) {
        console.warn('[Obscura] Fingerprint consistency warnings:');
        for (var _w = 0; _w < _warnings.length; _w++) {
          console.warn('[Obscura]   ' + _warnings[_w]);
        }
      }
    })();
  } catch(_consistErr) {}

  // ==================== Section 100: OffscreenCanvas Fingerprint Alignment ====================
  // OffscreenCanvas 反检测增强：
  // - transferToImageBitmap 完整性（尺寸校验、close() 方法）
  // - convertToBlob 完整性（type/size、arrayBuffer()/text()）
  // - WebGL Context 指纹对齐（webgl/webgl2 + WEBGL_debug_renderer_info）
  // - 2D Context 指纹对齐（完整 TextMetrics 7 属性、isPointInPath/Stroke）
  try {
    if (typeof OffscreenCanvas !== 'undefined') {
      // Patch getContext on OffscreenCanvas to apply noise + full fingerprint alignment
      var _origOCGetContext = OffscreenCanvas.prototype.getContext;
      OffscreenCanvas.prototype.getContext = function(type, attrs) {
        var ctx = _origOCGetContext.call(this, type, attrs);
        if (type === '2d' && ctx && !ctx._obscuraPatched) {
          ctx._obscuraPatched = true;
          _canvasInstanceCount++;

          // e-1) getImageData 噪声：与主 canvas Section 20 完全一致的确定性噪声
          var _origOCGetImageData = ctx.getImageData.bind(ctx);
          ctx.getImageData = function() {
            var imageData = _origOCGetImageData.apply(ctx, arguments);
            var d = imageData.data;
            // 确保返回的是 Uint8ClampedArray（与主 canvas 签名一致）
            if (d && !(d instanceof Uint8ClampedArray)) {
              try {
                var _fixed = new Uint8ClampedArray(d);
                Object.defineProperty(imageData, 'data', { value: _fixed, writable: false, configurable: true });
                d = _fixed;
              } catch(_sigErr) {}
            }
            var _seed = _canvasNoiseSeed + (_canvasInstanceCount * 7919);
            var _intensity = _canvasNoiseIntensity;
            for (var i = 0; i < d.length; i += 4) {
              _seed = (_seed * 16807 + 0.5) % 2147483647;
              var noise = Math.round(((_seed % 3) - 1) * _intensity);
              d[i]   = Math.max(0, Math.min(255, d[i] + noise));
              _seed = (_seed * 16807 + 0.5) % 2147483647;
              noise = Math.round(((_seed % 3) - 1) * _intensity);
              d[i+1] = Math.max(0, Math.min(255, d[i+1] + noise));
              _seed = (_seed * 16807 + 0.5) % 2147483647;
              noise = Math.round(((_seed % 3) - 1) * _intensity);
              d[i+2] = Math.max(0, Math.min(255, d[i+2] + noise));
            }
            return imageData;
          };

          // e-2) measureText 完整 TextMetrics 对齐：与主 canvas proxy 相同的 7 属性噪声
          var _origOCMeasureText = ctx.measureText.bind(ctx);
          var _ocSeed = _fakeDeviceSeed * 2.71828;
          ctx.measureText = function() {
            var result = _origOCMeasureText.apply(ctx, arguments);
            try {
              var _text = arguments[0] || '';
              var _mHash = _ocSeed;
              for (var _mi = 0; _mi < _text.length; _mi++) {
                _mHash = ((_mHash << 5) - _mHash + _text.charCodeAt(_mi)) | 0;
              }
              // 也 hash 当前字体以保持与主 canvas 一致
              var _curFont = ctx.font || '10px sans-serif';
              for (var _fj = 0; _fj < _curFont.length; _fj++) {
                _mHash = ((_mHash << 3) - _mHash + _curFont.charCodeAt(_fj)) | 0;
              }
              _mHash = Math.abs(_mHash);
              // 生成 7 个独立噪声值，与主 canvas proxy 逻辑完全一致
              var _tmS = _mHash;
              _tmS = (_tmS * 16807 + 0.5) % 2147483647;
              var _nW = ((_tmS % 21) - 10) * 0.0015;
              _tmS = (_tmS * 16807 + 0.5) % 2147483647;
              var _nABL = ((_tmS % 11) - 5) * 0.001;
              _tmS = (_tmS * 16807 + 0.5) % 2147483647;
              var _nABR = ((_tmS % 11) - 5) * 0.001;
              _tmS = (_tmS * 16807 + 0.5) % 2147483647;
              var _nABA = ((_tmS % 11) - 5) * 0.001;
              _tmS = (_tmS * 16807 + 0.5) % 2147483647;
              var _nABD = ((_tmS % 11) - 5) * 0.001;
              _tmS = (_tmS * 16807 + 0.5) % 2147483647;
              var _nFBA = ((_tmS % 7) - 3) * 0.0005;
              _tmS = (_tmS * 16807 + 0.5) % 2147483647;
              var _nFBD = ((_tmS % 7) - 3) * 0.0005;
              var _tmProps = ['width', 'actualBoundingBoxLeft', 'actualBoundingBoxRight',
                'actualBoundingBoxAscent', 'actualBoundingBoxDescent',
                'fontBoundingBoxAscent', 'fontBoundingBoxDescent'];
              var _tmNoises = [_nW, _nABL, _nABR, _nABA, _nABD, _nFBA, _nFBD];
              for (var _ti = 0; _ti < _tmProps.length; _ti++) {
                var _pName = _tmProps[_ti];
                var _origVal = result[_pName];
                if (typeof _origVal === 'number' && isFinite(_origVal)) {
                  (function(p, orig, noise) {
                    try {
                      Object.defineProperty(result, p, {
                        get: function() { return orig + noise; },
                        configurable: true
                      });
                    } catch(_tdErr) {}
                  })(_pName, _origVal, _tmNoises[_ti]);
                }
              }
            } catch(_ocmErr) {}
            return result;
          };

          // e-3) isPointInPath / isPointInStroke 对齐：与主 canvas proxy 相同的 ±0.1px 偏移
          try {
            var _ocIPPSeed = _ocSeed;
            var _origOCIPIP = ctx.isPointInPath.bind(ctx);
            ctx.isPointInPath = function() {
              var args = Array.prototype.slice.call(arguments);
              var xi = 0, yi = 1;
              if (args.length >= 3 && args[0] && typeof args[0].addPath === 'function') { xi = 1; yi = 2; }
              var _cx = (args[xi] || 0) | 0, _cy = (args[yi] || 0) | 0;
              var _pS = (_ocIPPSeed + _cx * 37 + _cy * 53) | 0;
              var _dx = ((_pS % 201) - 100) * 0.001;
              _pS = (_pS + _cx * 17 + _cy * 31) | 0;
              var _dy = ((_pS % 201) - 100) * 0.001;
              args[xi] = (args[xi] || 0) + _dx;
              args[yi] = (args[yi] || 0) + _dy;
              return _origOCIPIP.apply(ctx, args);
            };
            var _origOCIPS = ctx.isPointInStroke.bind(ctx);
            ctx.isPointInStroke = function() {
              var args = Array.prototype.slice.call(arguments);
              var xi = 0, yi = 1;
              if (args.length >= 3 && args[0] && typeof args[0].addPath === 'function') { xi = 1; yi = 2; }
              var _cx = (args[xi] || 0) | 0, _cy = (args[yi] || 0) | 0;
              var _sS = (_ocIPPSeed + _cx * 41 + _cy * 59) | 0;
              var _sdx = ((_sS % 201) - 100) * 0.001;
              _sS = (_sS + _cx * 19 + _cy * 37) | 0;
              var _sdy = ((_sS % 201) - 100) * 0.001;
              args[xi] = (args[xi] || 0) + _sdx;
              args[yi] = (args[yi] || 0) + _sdy;
              return _origOCIPS.apply(ctx, args);
            };
          } catch(_ocPathErr) {}
        }

        // c) WebGL Context 指纹对齐：确保 OffscreenCanvas 上的 WebGL context 返回一致的指纹
        if ((type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') && ctx && !ctx._obscuraGLPatched) {
          ctx._obscuraGLPatched = true;
          // 确保 getParameter 返回与主 canvas 相同的 vendor/renderer
          var _glProto = (type === 'webgl2') ?
            (typeof WebGL2RenderingContext !== 'undefined' ? WebGL2RenderingContext.prototype : null) :
            (typeof WebGLRenderingContext !== 'undefined' ? WebGLRenderingContext.prototype : null);
          // OffscreenCanvas WebGL context 的 getParameter 已在 Section 3 通过原型 patch 覆盖
          // 但某些 headless 环境中 OffscreenCanvas 的 WebGL context 可能有独立的原型链
          // 确保独立的 getParameter 也返回一致值
          if (ctx.getParameter && _glProto && ctx.getParameter !== _glProto.getParameter) {
            var _ocGLGetParam = ctx.getParameter.bind(ctx);
            ctx.getParameter = function(param) {
              if (param === 37445) return PROFILE.webglVendor;    // UNMASKED_VENDOR_WEBGL
              if (param === 37446) return PROFILE.webglRenderer;  // UNMASKED_RENDERER_WEBGL
              if (param === 0x1F01) return _glRenderer;           // GL_RENDERER
              if (param === 0x1F00) return _glVendor;             // GL_VENDOR
              if (param === 0x8B8C) {                             // GL_SHADING_LANGUAGE_VERSION
                if (type === 'webgl2') {
                  if (_isFirefox) return 'WebGL GLSL ES 3.0 (OpenGL ES GLSL ES 3.0 NVIDIA)';
                  if (/Mesa/.test(PROFILE.webglRenderer)) return 'WebGL GLSL ES 3.0 (OpenGL ES GLSL ES 3.0 Mesa 23.2.1)';
                  return 'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 Chromium)';
                }
                return _glslVersion;
              }
              return _ocGLGetParam(param);
            };
          }
          // 确保 WEBGL_debug_renderer_info 扩展在 OffscreenCanvas WebGL 中可用
          if (ctx.getExtension && !ctx._extPatched) {
            ctx._extPatched = true;
            var _ocGLGetExt = ctx.getExtension.bind(ctx);
            ctx.getExtension = function(name) {
              if (name === 'WEBGL_debug_renderer_info') {
                var ext = _ocGLGetExt(name);
                if (ext) return ext;
                // headless 环境可能返回 null，mock 扩展常量
                var _mockOCExt = {};
                Object.defineProperty(_mockOCExt, 'UNMASKED_VENDOR_WEBGL', { value: 0x9245, writable: false, configurable: false });
                Object.defineProperty(_mockOCExt, 'UNMASKED_RENDERER_WEBGL', { value: 0x9246, writable: false, configurable: false });
                return _mockOCExt;
              }
              return _ocGLGetExt(name);
            };
          }
          // 确保 readPixels 也应用噪声（如果 offscreen canvas 有独立的 readPixels）
          if (ctx.readPixels && _glProto && ctx.readPixels !== _glProto.readPixels) {
            var _ocGLReadPx = ctx.readPixels.bind(ctx);
            ctx.readPixels = function(x, y, w, h, format, type, pixels) {
              _ocGLReadPx(x, y, w, h, format, type, pixels);
              if (format === 0x1908 && type === 0x1401 && pixels instanceof Uint8Array) {
                var _rS = _glReadSeed + 2;
                for (var _rpi = 0; _rpi < pixels.length; _rpi += 4) {
                  _rS = (_rS * 16807 + 0.5) % 2147483647;
                  var _rn = Math.round(((_rS % 3) - 1) * _canvasNoiseIntensity);
                  pixels[_rpi]   = Math.max(0, Math.min(255, pixels[_rpi] + _rn));
                  _rS = (_rS * 16807 + 0.5) % 2147483647;
                  _rn = Math.round(((_rS % 3) - 1) * _canvasNoiseIntensity);
                  pixels[_rpi+1] = Math.max(0, Math.min(255, pixels[_rpi+1] + _rn));
                  _rS = (_rS * 16807 + 0.5) % 2147483647;
                  _rn = Math.round(((_rS % 3) - 1) * _canvasNoiseIntensity);
                  pixels[_rpi+2] = Math.max(0, Math.min(255, pixels[_rpi+2] + _rn));
                }
              }
            };
          }
        }

        return ctx;
      };

      // a) transferToImageBitmap 增强：确保 ImageBitmap 尺寸一致 + close() 可用
      var _origOCTransfer = OffscreenCanvas.prototype.transferToImageBitmap;
      if (_origOCTransfer) {
        OffscreenCanvas.prototype.transferToImageBitmap = function() {
          var _self = this;
          var _w = _self.width, _h = _self.height;
          try {
            var ctx = _self.getContext('2d');
            if (ctx && ctx._obscuraPatched) {
              var imgData = ctx.getImageData(0, 0, _w, _h);
              var _tmpOC2 = new OffscreenCanvas(_w, _h);
              var _tmpOCCtx2 = _tmpOC2.getContext('2d');
              if (_tmpOCCtx2) {
                _tmpOCCtx2.putImageData(imgData, 0, 0);
                var bitmap = _origOCTransfer.call(_tmpOC2);
                // a-1) 确保 ImageBitmap 尺寸与 canvas 一致
                if (bitmap) {
                  try {
                    if (bitmap.width !== _w) {
                      Object.defineProperty(bitmap, 'width', { value: _w, configurable: true });
                    }
                    if (bitmap.height !== _h) {
                      Object.defineProperty(bitmap, 'height', { value: _h, configurable: true });
                    }
                  } catch(_ibDimErr) {}
                  // a-2) 确保 close() 方法可用（某些 headless 可能缺失）
                  if (typeof bitmap.close !== 'function') {
                    bitmap.close = function() {};
                  }
                }
                return bitmap;
              }
            }
          } catch(_octErr) {}
          var _origBitmap = _origOCTransfer.call(_self);
          // 对非 2D context 的 bitmap 也确保尺寸和 close()
          if (_origBitmap) {
            try {
              if (_origBitmap.width !== _w) {
                Object.defineProperty(_origBitmap, 'width', { value: _w, configurable: true });
              }
              if (_origBitmap.height !== _h) {
                Object.defineProperty(_origBitmap, 'height', { value: _h, configurable: true });
              }
            } catch(_ibDimErr2) {}
            if (typeof _origBitmap.close !== 'function') {
              _origBitmap.close = function() {};
            }
          }
          return _origBitmap;
        };
      }

      // b) convertToBlob 增强：确保 Blob 有正确的 type/size + arrayBuffer()/text() 可用
      var _origOCConvertToBlob = OffscreenCanvas.prototype.convertToBlob;
      if (_origOCConvertToBlob) {
        OffscreenCanvas.prototype.convertToBlob = function(options) {
          var _self = this;
          try {
            var ctx = _self.getContext('2d');
            if (ctx && ctx._obscuraPatched) {
              var imgData = ctx.getImageData(0, 0, _self.width, _self.height);
              var _tmpOC = new OffscreenCanvas(_self.width, _self.height);
              var _tmpOCCtx = _tmpOC.getContext('2d');
              if (_tmpOCCtx) {
                _tmpOCCtx.putImageData(imgData, 0, 0);
                var _blobPromise = _origOCConvertToBlob.call(_tmpOC, options);
                // b-1) 确保 Blob 的 type 和 size 正确
                return _blobPromise.then(function(blob) {
                  if (blob) {
                    // 确定 MIME type：默认 image/png，支持 image/webp, image/jpeg
                    var _mimeType = 'image/png';
                    if (options && typeof options.type === 'string') {
                      _mimeType = options.type;
                    }
                    // 确保 Blob.type 与请求一致
                    try {
                      if (blob.type !== _mimeType && blob.type.indexOf(_mimeType.split('/')[1]) < 0) {
                        Object.defineProperty(blob, 'type', { value: _mimeType, configurable: true });
                      }
                    } catch(_blobTypeErr) {}
                    // b-2) 确保 Blob.arrayBuffer() 和 Blob.text() 方法可用
                    if (typeof blob.arrayBuffer !== 'function') {
                      blob.arrayBuffer = function() {
                        return new Promise(function(resolve) {
                          var reader = new FileReader();
                          reader.onload = function() { resolve(reader.result); };
                          reader.readAsArrayBuffer(blob);
                        });
                      };
                    }
                    if (typeof blob.text !== 'function') {
                      blob.text = function() {
                        return new Promise(function(resolve) {
                          var reader = new FileReader();
                          reader.onload = function() { resolve(reader.result); };
                          reader.readAsText(blob);
                        });
                      };
                    }
                  }
                  return blob;
                });
              }
            }
          } catch(_ocbErr) {}
          // 非 2D context 的 fallback
          var _fallbackPromise = _origOCConvertToBlob.call(_self, options);
          return _fallbackPromise.then(function(blob) {
            if (blob) {
              if (typeof blob.arrayBuffer !== 'function') {
                blob.arrayBuffer = function() {
                  return new Promise(function(resolve) {
                    var reader = new FileReader();
                    reader.onload = function() { resolve(reader.result); };
                    reader.readAsArrayBuffer(blob);
                  });
                };
              }
              if (typeof blob.text !== 'function') {
                blob.text = function() {
                  return new Promise(function(resolve) {
                    var reader = new FileReader();
                    reader.onload = function() { resolve(reader.result); };
                    reader.readAsText(blob);
                  });
                };
              }
            }
            return blob;
          });
        };
      }
    }
  } catch(_ocErr) {}

  // ==================== Section 101: WebRTC Leak Prevention ====================
  // Anti-bot systems use WebRTC to discover real IP addresses even behind proxies.
  // We override RTCPeerConnection/webkitRTCPeerConnection to block ICE candidate
  // leaks, and enumerateDevices() to return consistent fake devices.
  try {
    (function() {
      var _noop = function() {};
      // Strip STUN/TURN servers from config to prevent IP discovery
      function _sanitizeRTCConfig(config) {
        if (!config || typeof config !== 'object') return config || undefined;
        var clean = {};
        for (var k in config) {
          if (config.hasOwnProperty(k)) {
            clean[k] = k === 'iceServers' ? [] : config[k];
          }
        }
        return clean;
      }
      // Override RTCPeerConnection
      var _OrigRTCPC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
      if (_OrigRTCPC) {
        var _FakeRTCPC = function(config, constraints) {
          var _instance = new _OrigRTCPC(_sanitizeRTCConfig(config), constraints);
          // Block onicecandidate callbacks to prevent real IP leak
          Object.defineProperty(_instance, 'onicecandidate', {
            get: function() { return _noop; },
            set: function() {},
            configurable: true,
          });
          // Block addEventListener for icecandidate events
          var _origAddEL = _instance.addEventListener.bind(_instance);
          _instance.addEventListener = function(type, listener, options) {
            if (type === 'icecandidate' || type === 'icecandidateerror') return;
            return _origAddEL(type, listener, options);
          };
          var _origRemoveEL = _instance.removeEventListener.bind(_instance);
          _instance.removeEventListener = function(type, listener, options) {
            if (type === 'icecandidate' || type === 'icecandidateerror') return;
            return _origRemoveEL(type, listener, options);
          };
          return _instance;
        };
        _FakeRTCPC.prototype = _OrigRTCPC.prototype;
        window.RTCPeerConnection = _FakeRTCPC;
        if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = _FakeRTCPC;
      }
      // Override navigator.mediaDevices.enumerateDevices() — return consistent fake devices
      if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
        // Generate consistent device IDs using the same PRNG seed as canvas
        var _dSeed = Math.floor(_fakeDeviceSeed * 7.77);
        function _fakeDeviceId(type) {
          _dSeed = (_dSeed * 1664525 + 1013904223) | 0;
          var hex = ((_dSeed >>> 0) % 0xFFFFFF).toString(16);
          while (hex.length < 6) hex = '0' + hex;
          return type.substring(0, 3) + hex + type.substring(3, 5);
        }
        var _fakeDevices = [
          { deviceId: _fakeDeviceId('audioinput01'), groupId: _fakeDeviceId('grp0001'), kind: 'audioinput', label: '' },
          { deviceId: _fakeDeviceId('videoinput01'), groupId: _fakeDeviceId('grp0001'), kind: 'videoinput', label: '' },
          { deviceId: _fakeDeviceId('audiooutput1'), groupId: _fakeDeviceId('grp0002'), kind: 'audiooutput', label: '' },
        ];
        navigator.mediaDevices.enumerateDevices = function() {
          return Promise.resolve(_fakeDevices.slice());
        };
      }
    })();
  } catch(_rtcErr) {}

  // ==================== Section 102: Font Fingerprint Normalization ====================
  // Section 60 patches instance-level document.fonts. This section patches
  // FontFaceSet.prototype for iframe/new-instance coverage, and normalizes
  // the available font set to be consistent with the spoofed platform.
  try {
    (function() {
      var _plat = PROFILE.platform || 'Win32';
      // Compact platform-specific font pools (representative subset)
      var _pools = {
        'Win32': ['Arial','Arial Black','Bahnschrift','Calibri','Cambria','Comic Sans MS',
          'Consolas','Courier New','Franklin Gothic Medium','Gabriola','Georgia','Impact',
          'Lucida Console','Lucida Sans Unicode','Malgun Gothic','Microsoft Sans Serif',
          'Palatino Linotype','Segoe UI','Segoe UI Emoji','Segoe UI Symbol','SimHei',
          'SimSun','Tahoma','Times New Roman','Trebuchet MS','Verdana','Webdings',
          'Wingdings','Yu Gothic','MingLiU','MS Gothic'],
        'MacIntel': ['Arial','Arial Black','Arial Narrow','Avenir','Avenir Next','Baskerville',
          'Big Caslon','Cochin','Copperplate','Courier New','Didot','Futura','Georgia',
          'Gill Sans','Helvetica','Helvetica Neue','Hiragino Sans','Hoefler Text',
          'Impact','Lucida Grande','Menlo','Monaco','Optima','Palatino','Papyrus',
          'PingFang SC','PingFang TC','SF Pro','Songti SC','Times New Roman',
          'Trebuchet MS','Verdana','Zapfino'],
        'Linux x86_64': ['Arial','Cantarell','Courier New','DejaVu Sans','DejaVu Sans Mono',
          'DejaVu Serif','Droid Sans','Droid Sans Mono','Droid Serif','FreeMono',
          'FreeSans','FreeSerif','Georgia','Liberation Mono','Liberation Sans',
          'Liberation Serif','Noto Sans','Noto Sans CJK','Noto Serif','Open Sans',
          'PT Sans','PT Serif','Times New Roman','Ubuntu','Ubuntu Mono','Verdana',
          'WenQuanYi Micro Hei'],
      };
      var _pool = _pools[_plat] || _pools['Win32'];
      // Select deterministic subset using canvas PRNG seed
      var _fntSeed = Math.floor(_fakeDeviceSeed * 19.23);
      var _selectedFonts = [];
      for (var _fni = 0; _fni < _pool.length; _fni++) {
        _fntSeed = (_fntSeed * 1664525 + 1013904223) | 0;
        if ((_fntSeed >>> 0) % 3 !== 0) { // ~67% inclusion rate
          _selectedFonts.push(_pool[_fni]);
        }
      }
      _selectedFonts.sort();
      var _genericFams = ['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy'];
      // Patch FontFaceSet.prototype.forEach for iframe/new instance coverage
      if (typeof FontFaceSet !== 'undefined') {
        var _origFFSForEach = FontFaceSet.prototype.forEach;
        FontFaceSet.prototype.forEach = function(callback, thisArg) {
          var _filtered = [];
          _origFFSForEach.call(this, function(font) {
            if (_genericFams.indexOf(font.family) >= 0 ||
                _selectedFonts.indexOf(font.family) >= 0 ||
                font.status === 'loaded') {
              _filtered.push(font);
            }
          });
          for (var _fei = 0; _fei < _filtered.length; _fei++) {
            callback.call(thisArg, _filtered[_fei], _fei, _filtered);
          }
        };
        // Override FontFaceSet.prototype.check() for prototype-level coverage
        if (FontFaceSet.prototype.check) {
          var _origProtoCheck = FontFaceSet.prototype.check;
          FontFaceSet.prototype.check = function(font, text) {
            try {
              var _families = font.split(',');
              for (var _ci = 0; _ci < _families.length; _ci++) {
                var _fam = _families[_ci].replace(/["']/g, '').trim();
                if (_fam && _genericFams.indexOf(_fam) < 0) {
                  // Non-generic: be optimistic — real browsers accept any @font-face
                  return true;
                }
              }
              return _origProtoCheck.call(this, font, text);
            } catch(_fce) {}
            return _origProtoCheck.call(this, font, text);
          };
        }
      }
    })();
  } catch(_fontNormErr) {}

  // ==================== Section 103: Battery API Normalization ====================
  // The Battery API reveals device type (mobile vs desktop) and charging state.
  // We override navigator.getBattery() to return consistent values matching the UA.
  try {
    if (navigator.getBattery) {
      var _isMobileUA = /Android|iPhone|iPad|iPod|Mobile/i.test(PROFILE.userAgent || '');
      var _fakeBattery = {
        charging: !_isMobileUA,     // Desktop: always charging; Mobile: false
        chargingTime: 0,             // 0 = fully charged
        // Mobile: 2-5h discharge; Desktop: Infinity (plugged in)
        dischargingTime: _isMobileUA ? 7200 + Math.floor(_seededRandom(103.1) * 10800) : Infinity,
        // Mobile: 60-100%; Desktop: always 100%
        level: _isMobileUA ? 0.6 + _seededRandom(103.2) * 0.4 : 1.0,
        addEventListener: function() {},
        removeEventListener: function() {},
        dispatchEvent: function() { return false; },
        onchargingchange: null,
        onchargingtimechange: null,
        ondischargingtimechange: null,
        onlevelchange: null,
      };
      navigator.getBattery = function() {
        return Promise.resolve(_fakeBattery);
      };
    }
  } catch(_batErr) {}

  // ==================== Section 104: Permissions API Spoofing ====================
  // Detection scripts query navigator.permissions.query() for notifications, geolocation, etc.
  // Bots often return 'granted' for all permissions, which is suspicious. Real browsers
  // return 'prompt' for most sensitive permissions unless the user explicitly granted them.
  try {
    if (navigator.permissions && navigator.permissions.query) {
      var _origPermQuery = navigator.permissions.query.bind(navigator.permissions);
      var _permMap = {
        'notifications': 'default',  // Fresh browser: not yet asked (matches Section 38)
        'geolocation': 'prompt',
        'camera': 'prompt',
        'microphone': 'prompt',
        'clipboard-read': 'prompt',
        'clipboard-write': 'granted',
        'push': 'prompt',
        'midi': 'prompt',
        'accelerometer': 'prompt',
        'gyroscope': 'prompt',
        'magnetometer': 'prompt',
        'fullscreen': 'prompt',
        'persistent-storage': 'prompt',
        'ambient-light-sensor': 'prompt',
      };
      function _makePermissionStatus(state) {
        return {
          state: state,
          onchange: null,
          addEventListener: function() {},
          removeEventListener: function() {},
          dispatchEvent: function() { return false; },
        };
      }
      navigator.permissions.query = function(desc) {
        var name = (desc && desc.name) || '';
        var state = _permMap[name] || 'prompt';
        return Promise.resolve(_makePermissionStatus(state));
      };
    }
  } catch(_permErr) {}

  // ==================== Section 105: Connection API Normalization ====================
  // navigator.connection (NetworkInformation API) leaks connection details that may be
  // inconsistent with the spoofed UA. We replace it with values matching the platform.
  try {
    var _connMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(PROFILE.userAgent || '');
    var _connDownlink = _connMobile ? 1.5 + _seededRandom(105.1) * 3.5 : 10 + _seededRandom(105.2) * 10;
    _connDownlink = Math.round(_connDownlink * 10) / 10;
    var _connRtt = _connMobile ? 200 + Math.floor(_seededRandom(105.3) * 300) : 20 + Math.floor(_seededRandom(105.4) * 80);
    var _connType = _connMobile ? '3g' : '4g';
    if (_connDownlink >= 10) _connType = '4g';
    else if (_connDownlink >= 0.25) _connType = '3g';
    else if (_connDownlink >= 0.05) _connType = '2g';
    else _connType = 'slow-2g';
    var _fakeConn = {
      effectiveType: _connType,
      rtt: _connRtt,
      downlink: _connDownlink,
      saveData: false,
      type: _connMobile ? 'cellular' : undefined,
      ontypechange: null,
      onchange: null,
      addEventListener: function() {},
      removeEventListener: function() {},
      dispatchEvent: function() { return false; },
    };
    // navigator.connection
    if (navigator.connection !== undefined) {
      Object.defineProperty(navigator, 'connection', { get: function() { return _fakeConn; }, configurable: true });
    }
    // navigator.mozConnection (Firefox)
    if (navigator.mozConnection !== undefined) {
      Object.defineProperty(navigator, 'mozConnection', { get: function() { return _fakeConn; }, configurable: true });
    }
    // navigator.webkitConnection (older Chrome)
    if (navigator.webkitConnection !== undefined) {
      Object.defineProperty(navigator, 'webkitConnection', { get: function() { return _fakeConn; }, configurable: true });
    }
  } catch(_connErr) {}

  // ==================== Section 106: Screen/Viewport Anomaly Prevention ====================
  // Detection scripts check for inconsistencies between screen dimensions,
  // devicePixelRatio, and window inner/outer sizes. We ensure consistency and
  // disable resize/move methods that headless browsers may expose unexpectedly.
  try {
    // Make outerWidth/outerHeight consistent with inner dimensions + realistic chrome
    var _chromeW = 8 + Math.floor(_seededRandom(106.1) * 16);  // scrollbar: 8-24px
    var _chromeH = 80 + Math.floor(_seededRandom(106.2) * 20);   // title bar + tabs + url bar: 80-100px
    Object.defineProperty(window, 'outerWidth', {
      get: function() { return window.innerWidth + _chromeW; }, configurable: true
    });
    Object.defineProperty(window, 'outerHeight', {
      get: function() { return window.innerHeight + _chromeH; }, configurable: true
    });
    // Disable resizeTo / resizeBy / moveTo / moveBy — real browsers restrict these
    // on windows not opened by script, so making them no-ops is consistent.
    window.resizeTo = function() {};
    window.resizeBy = function() {};
    window.moveTo = function() {};
    window.moveBy = function() {};
    // NOTE: Screen dimensions (width/height/availWidth/availHeight) are handled by
    // Section 6 using PROFILE values. We do NOT recompute them from innerWidth*dpr here
    // because: (a) it would conflict with Section 6's profile-consistent values,
    // (b) in non-maximized windows, innerWidth*dpr ≠ screen.width, and
    // (c) Playwright viewport should already match the profile (engines.ts sets it).
  } catch(_scrErr) {}

  // ==================== Section 107: Storage API Quota Spoofing ====================
  // Headless browsers often have different default storage quotas than real browsers.
  // This replaces the simpler estimate() mock (in Section 15) with values that
  // differentiate desktop (100GB) from mobile (25GB) with ±20% seeded variation.
  try {
    if (navigator.storage && navigator.storage.estimate) {
      var _storMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(PROFILE.userAgent || '');
      var _storBaseQuota = _storMobile ? 26843545600 : 107374182400;  // 25GB mobile, 100GB desktop
      var _storBaseUsage = _storMobile ? 2147483648 : 5368709120;     // 2GB mobile, 5GB desktop
      var _storVar = 0.8 + _seededRandom(107.1) * 0.4;  // ±20% variation
      var _storQuota = Math.floor(_storBaseQuota * _storVar);
      var _storUsage = Math.floor(_storBaseUsage * _storVar);
      navigator.storage.estimate = function() {
        return Promise.resolve({ quota: _storQuota, usage: _storUsage });
      };
    }
  } catch(_storQuotaErr) {}

  // ==================== Section 108: Media Capabilities API Spoofing ====================
  // navigator.mediaCapabilities.decodingInfo() reveals codec support which can fingerprint
  // the browser. Headless browsers may report different codec capabilities than real ones.
  // We override to return consistent 'smooth' support for common codecs.
  try {
    if (navigator.mediaCapabilities && navigator.mediaCapabilities.decodingInfo) {
      var _supportedCodecs = ['video/webm', 'video/mp4', 'audio/webm', 'audio/mp4'];
      var _smoothResult = { supported: true, smooth: true, powerEfficient: true };
      var _origDecodingInfo = navigator.mediaCapabilities.decodingInfo.bind(navigator.mediaCapabilities);
      navigator.mediaCapabilities.decodingInfo = function(config) {
        try {
          if (config && config.type === 'media-source' && config.video) {
            var contentType = config.video.contentType || '';
            var baseType = contentType.split(';')[0].trim().toLowerCase();
            if (_supportedCodecs.indexOf(baseType) >= 0) {
              return Promise.resolve(_smoothResult);
            }
          }
          if (config && config.type === 'media-source' && config.audio) {
            var aContentType = config.audio.contentType || '';
            var aBaseType = aContentType.split(';')[0].trim().toLowerCase();
            if (_supportedCodecs.indexOf(aBaseType) >= 0) {
              return Promise.resolve(_smoothResult);
            }
          }
        } catch(_mciInnerErr) {}
        return Promise.resolve({ supported: false, smooth: false, powerEfficient: false });
      };
    }
  } catch(_mciErr) {}

  // ==================== Section 109: Gamepad API Stubbing ====================
  // navigator.getGamepads() and gamepad events can reveal automation when the API
  // is missing or returns unexpected values. Real Chrome without gamepads connected
  // returns [null, null, null, null] (4 null slots), NOT an empty array.
  try {
    if (navigator.getGamepads) {
      navigator.getGamepads = function() {
        return [null, null, null, null];
      };
    }
    // Ensure event listeners for gamepadconnected/gamepaddisconnected are no-ops
    // (prevents detection via undefined checks on the event handler)
    if (window.EventTarget && window.EventTarget.prototype.addEventListener) {
      var _origGpAddEL = window.EventTarget.prototype.addEventListener;
      var _origGpRemoveEL = window.EventTarget.prototype.removeEventListener;
      window.EventTarget.prototype.addEventListener = function(type, listener, options) {
        if (type === 'gamepadconnected' || type === 'gamepaddisconnected') return;
        return _origGpAddEL.call(this, type, listener, options);
      };
      window.EventTarget.prototype.removeEventListener = function(type, listener, options) {
        if (type === 'gamepadconnected' || type === 'gamepaddisconnected') return;
        return _origGpRemoveEL.call(this, type, listener, options);
      };
    }
  } catch(_gpErr) {}

  // ==================== Section 110: WebAssembly Fingerprint Normalization ====================
  // WebAssembly.compile() and instantiate() can be probed to detect headless browsers
  // where the underlying WASM engine exposes different feature support or memory sizes.
  try {
    var _origWasmCompile = (typeof WebAssembly !== 'undefined' && WebAssembly.compile) ? WebAssembly.compile : null;
    var _origWasmInstantiate = (typeof WebAssembly !== 'undefined' && WebAssembly.instantiate) ? WebAssembly.instantiate : null;
    if (_origWasmCompile) {
      WebAssembly.compile = function(bufferSource) {
        return _origWasmCompile.call(WebAssembly, bufferSource).then(function(module) {
          var exports = WebAssembly.Module.exports(module);
          return module;
        });
      };
    }
    if (_origWasmInstantiate) {
      WebAssembly.instantiate = function(bufferSource, importObject) {
        return _origWasmInstantiate.call(WebAssembly, bufferSource, importObject).then(function(result) {
          if (result.instance && result.instance.exports && result.instance.exports.memory) {
            var _normSize = Math.max(1, Math.ceil(_seededRandom(110.1) * 16)) * 65536;
            try { Object.defineProperty(result.instance.exports.memory, 'buffer', { get: function() { return new ArrayBuffer(_normSize); } }); } catch(_wasmBufErr) {}
          }
          return result;
        });
      };
    }
  } catch(_wasmErr) {}

  // ==================== Section 111: Clipboard API Stubbing ====================
  // Clipboard API permission prompts can reveal automation. Stub all clipboard methods
  // to return resolved promises, preventing permission dialogs and clipboard-based bot detection.
  try {
    if (navigator.clipboard) {
      navigator.clipboard.readText = function() { return Promise.resolve(''); };
      navigator.clipboard.writeText = function(_text) { return Promise.resolve(undefined); };
      if (navigator.clipboard.read) navigator.clipboard.read = function() { return Promise.resolve([]); };
      if (navigator.clipboard.write) navigator.clipboard.write = function(_data) { return Promise.resolve(undefined); };
    }
  } catch(_clipErr) {}

  // ==================== Section 112: Source Map & DevTools Detection Evasion ====================
  // Stack trace fingerprinting analyzes Error.stack format to identify automation.
  // Normalize stack traces to match a real Chrome browser, stripping headless/Playwright markers.
  // Uses pre-compiled regex array for efficiency (single-pass over stack string).
  // Also overrides Error.prepareStackTrace (V8-specific) as secondary sanitization layer.
  try {
    var _origErrorStack = Object.getOwnPropertyDescriptor(Error.prototype, 'stack');
    if (_origErrorStack && _origErrorStack.get) {
      var _origStackGetter = _origErrorStack.get;
      // Pre-compiled patterns for automation-related strings in stack traces
      var _stackSanitizer = [
        // Playwright paths and markers
        [/\\s*\\(playwright[\\/\\\\][^)]*\\)/gi, ' (anonymous)'],
        [/\\s*\\(playwright[^)]*\\)/gi, ' (anonymous)'],
        [/__playwright_evaluation_script__\\d+/g, '<anonymous>'],
        [/playwright[\\/\\\\]lib[\\/\\\\][^\\n]*/gi, ''],
        // Puppeteer paths and markers
        [/\\s*\\(puppeteer[\\/\\\\][^)]*\\)/gi, ' (anonymous)'],
        [/\\s*\\(puppeteer[^)]*\\)/gi, ' (anonymous)'],
        [/__puppeteer_evaluation_script__\\d+/g, '<anonymous>'],
        [/puppeteer[\\/\\\\]lib[\\/\\\\][^\\n]*/gi, ''],
        // Selenium / WebDriver markers
        [/__selenium_unwrapped/g, ''],
        [/__webdriver_evaluate/g, ''],
        [/__driver_evaluate/g, ''],
        // Headless / CDP / DevTools markers
        [/\\bheadless\\b[^\\n]*/gi, ''],
        [/\\bCDP[^\\n]*/gi, ''],
        [/chrome-devtools[^\\n]*/gi, ''],
        [/devtools[\\/\\\\][^\\n]*/gi, ''],
        [/\\bchromium\\b[^\\n]*/gi, ''],
        // Node.js paths should never appear in browser stack traces
        [/-\\-experimental[\\-]vm[\\-]modules/g, ''],
        [/node_modules[\\/\\\\][^\\n]*/gi, ''],
        [/scraper-service[\\/\\\\][^\\n]*/gi, ''],
        // Eval normalization
        [/\\s*\\(eval at[^)]*\\)/gi, ' (eval)'],
        [/\\n\\s+at new Promise\\s*<anonymous>/g, '\\n    at new Promise (<anonymous>)'],
      ];
      Object.defineProperty(Error.prototype, 'stack', {
        get: function() {
          var raw = _origStackGetter.call(this);
          if (typeof raw !== 'string') return raw;
          for (var _ssi = 0; _ssi < _stackSanitizer.length; _ssi++) {
            raw = raw.replace(_stackSanitizer[_ssi][0], _stackSanitizer[_ssi][1]);
          }
          return raw;
        },
        configurable: true
      });
    }
    // Secondary: Override Error.prepareStackTrace (V8-specific hook)
    // This catches cases where code accesses the internal stack trace directly
    // (e.g., via Error.captureStackTrace with custom prepareStackTrace).
    try {
      var _origPrepareST = Error.prepareStackTrace;
      Error.prepareStackTrace = function(error, callSites) {
        // Use V8 default formatting then sanitize
        if (_origPrepareST) {
          var formatted = _origPrepareST(error, callSites);
          if (typeof formatted === 'string') {
            for (var _psi = 0; _psi < _stackSanitizer.length; _psi++) {
              formatted = formatted.replace(_stackSanitizer[_psi][0], _stackSanitizer[_psi][1]);
            }
            return formatted;
          }
          return formatted;
        }
        // Manual formatting fallback if no original prepareStackTrace
        var _stResult = error.toString() + '\\n';
        for (var _csi = 0; _csi < callSites.length; _csi++) {
          var _cs = callSites[_csi];
          var _fnName = (_cs.getFunctionName() || _cs.getMethodName() || '<anonymous>');
          var _fileName = _cs.getFileName();
          var _line = _cs.getLineNumber();
          var _col = _cs.getColumnNumber();
          // Sanitize filename to remove automation markers
          if (typeof _fileName === 'string') {
            for (var _fsi = 0; _fsi < _stackSanitizer.length; _fsi++) {
              _fileName = _fileName.replace(_stackSanitizer[_fsi][0], '');
            }
          }
          _stResult += '    at ' + _fnName + ' (' + (_fileName || '<anonymous>') + ':' + (_line || 0) + ':' + (_col || 0) + ')\\n';
        }
        return _stResult;
      };
    } catch(_prepareSTErr) {}
  } catch(_stackErr) {}

  // ==================== Section 113: Function.prototype.toString Comprehensive Masking ====================
  // Anti-bot systems call Function.prototype.toString on overridden prototype methods.
  // If the source doesn't contain '[native code]', the page is flagged as automated.
  // We scan all standard prototypes for non-native functions and mask their toString output.
  try {
    var _tsNativeToString = Function.prototype.toString;
    var _tsMaskedSet = new WeakSet();

    function _tsScanProto(proto) {
      try {
        if (!proto) return;
        var _tsProps = Object.getOwnPropertyNames(proto);
        for (var _tsi = 0; _tsi < _tsProps.length; _tsi++) {
          try {
            var _tsDesc = Object.getOwnPropertyDescriptor(proto, _tsProps[_tsi]);
            if (!_tsDesc) continue;
            var _tsFns = [_tsDesc.get, _tsDesc.set, _tsDesc.value];
            for (var _tsfi = 0; _tsfi < _tsFns.length; _tsfi++) {
              var _tsFn = _tsFns[_tsfi];
              if (typeof _tsFn === 'function' && !_tsMaskedSet.has(_tsFn)) {
                try {
                  var _tsStr = _tsNativeToString.call(_tsFn);
                  if (typeof _tsStr === 'string' && _tsStr.indexOf('[native code]') < 0) {
                    _tsMaskedSet.add(_tsFn);
                  }
                } catch(_tsScanErr) {}
              }
            }
          } catch(_tsPropErr) {}
        }
      } catch(_tsProtoErr) {}
    }

    _tsScanProto(Navigator.prototype);
    _tsScanProto(Screen.prototype);
    _tsScanProto(Document.prototype);
    _tsScanProto(HTMLCanvasElement.prototype);
    _tsScanProto(CanvasRenderingContext2D.prototype);
    _tsScanProto(WebGLRenderingContext.prototype);
    if (typeof WebGL2RenderingContext !== 'undefined') _tsScanProto(WebGL2RenderingContext.prototype);
    _tsScanProto(AudioContext.prototype);
    if (typeof OfflineAudioContext !== 'undefined') _tsScanProto(OfflineAudioContext.prototype);
    _tsScanProto(AnalyserNode.prototype);
    _tsScanProto(Performance.prototype);
    _tsScanProto(PerformanceObserver.prototype);
    if (typeof Permissions !== 'undefined') _tsScanProto(Permissions.prototype);
    if (typeof RTCPeerConnection !== 'undefined') _tsScanProto(RTCPeerConnection.prototype);
    _tsScanProto(Element.prototype);
    if (typeof OffscreenCanvas !== 'undefined') _tsScanProto(OffscreenCanvas.prototype);
    if (typeof FontFaceSet !== 'undefined') _tsScanProto(FontFaceSet.prototype);
    if (typeof PerformanceResourceTiming !== 'undefined') _tsScanProto(PerformanceResourceTiming.prototype);
    if (typeof Error !== 'undefined') _tsScanProto(Error.prototype);
    try { _tsScanProto(navigator); } catch(_tsNavErr) {}
    try { _tsScanProto(window); } catch(_tsWinErr) {}
    try { _tsScanProto(document); } catch(_tsDocErr) {}
    try { _tsScanProto(screen); } catch(_tsScrErr) {}

    Function.prototype.toString = function() {
      if (this === Function.prototype.toString) {
        return 'function toString() { [native code] }';
      }
      if (_tsMaskedSet.has(this)) {
        var _tsName = this.name || '';
        return 'function ' + _tsName + '() { [native code] }';
      }
      return _tsNativeToString.call(this);
    };
  } catch(_toStringMaskErr) {}

  // ==================== Section 114: WebGL Context Instance-Level readPixels Proxy ====================
  // Detection services may save the original WebGLRenderingContext.prototype.readPixels
  // before our script runs and compare it to the patched version. A context-level Proxy
  // intercepts readPixels at the instance level, providing a second layer of noise
  // injection that survives prototype restoration attempts.
  // Chains to the existing getContext (Section 30's 2D proxy) so both proxies coexist.
  try {
    var _prevGetCtx = HTMLCanvasElement.prototype.getContext;
    var _glProxySeed = Math.floor(_fakeDeviceSeed * 17.17) | 0;
    HTMLCanvasElement.prototype.getContext = function(type, attrs) {
      // Delegate to previous handler (Section 30's 2D proxy) first
      var ctx = _prevGetCtx.call(this, type, attrs);
      if ((type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') && ctx && !ctx._obscuraGLProxyPatched) {
        ctx._obscuraGLProxyPatched = true;
        var _glRP = ctx.readPixels.bind(ctx);
        var _glCtxSeed = (_glProxySeed++ + _canvasInstanceCount * 7919) | 0;
        ctx.readPixels = function(x, y, w, h, format, type, pixels) {
          _glRP(x, y, w, h, format, type, pixels);
          if (format === 0x1908 && type === 0x1401 && pixels instanceof Uint8Array) {
            var _rS = _glCtxSeed;
            for (var i = 0; i < pixels.length; i += 4) {
              _rS = (_rS * 16807 + 0.5) % 2147483647;
              var _rn = Math.round(((_rS % 3) - 1) * _canvasNoiseIntensity);
              pixels[i]   = Math.max(0, Math.min(255, pixels[i] + _rn));
              _rS = (_rS * 16807 + 0.5) % 2147483647;
              _rn = Math.round(((_rS % 3) - 1) * _canvasNoiseIntensity);
              pixels[i+1] = Math.max(0, Math.min(255, pixels[i+1] + _rn));
              _rS = (_rS * 16807 + 0.5) % 2147483647;
              _rn = Math.round(((_rS % 3) - 1) * _canvasNoiseIntensity);
              pixels[i+2] = Math.max(0, Math.min(255, pixels[i+2] + _rn));
            }
          }
        };
      }
      return ctx;
    };
  } catch(_glCtxProxyErr) {}

  // ==================== Section 115: Notification.permission Synchronous Verification ====================
  // Verification: Notification.permission MUST return 'default' synchronously (not via Promise).
  // Section 35 and 52 both set this via Object.defineProperty with a getter that returns 'default'.
  // This is consistent with real browser behavior: the property is a synchronous string.
  // requestPermission() is async (returns Promise), but .permission is sync.
  // No additional fix needed — this section exists as documentation and safety net.
  try {
    if ('Notification' in window && Notification.permission !== undefined && Notification.permission !== 'default') {
      Object.defineProperty(Notification, 'permission', {
        get: function() { return 'default'; },
        configurable: true,
      });
    }
  } catch(_notifVerifyErr) {}

})();
`;

  _stealthScriptCache.set(key, { script: result, ts: Date.now() });

  // Proactive eviction when cache grows too large
  if (_stealthScriptCache.size > 400) {
    const now = Date.now();
    for (const [k, entry] of _stealthScriptCache) {
      if (now - entry.ts > STEALTH_SCRIPT_CACHE_TTL) {
        _stealthScriptCache.delete(k);
      }
    }
  }

  return result;
}

// ==================== Profile Cache ====================

/**
 * Per-domain fingerprint profile cache.
 * Ensures consistent fingerprinting across multiple requests to the same domain.
 */
interface CacheEntry {
  profile: FingerprintProfile;
  createdAt: number;
}

const profileCache = new Map<string, CacheEntry>();
const CACHE_MAX_SIZE = 500;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Get or create a cached fingerprint profile for a domain.
 * Same domain always gets the same profile (until TTL expires).
 */
export function getProfileForDomain(domain: string): FingerprintProfile {
  const now = Date.now();
  const cached = profileCache.get(domain);

  if (cached && (now - cached.createdAt) < CACHE_TTL_MS) {
    return cached.profile;
  }

  // Evict oldest entries if cache is full
  if (profileCache.size >= CACHE_MAX_SIZE) {
    // O(1) eviction using Map insertion order (oldest = first key)
    const oldestKey = profileCache.keys().next().value;
    if (oldestKey !== undefined) profileCache.delete(oldestKey);
  }

  const profile = generateFingerprintProfile(domain);
  profileCache.set(domain, { profile, createdAt: now });

  return profile;
}

/**
 * Clear the profile cache (useful for testing or forced rotation).
 */
export function clearProfileCache(): void {
  profileCache.clear();
}

/**
 * Get cache statistics.
 */
export function getProfileCacheStats(): { size: number; maxSize: number; ttlMs: number } {
  return {
    size: profileCache.size,
    maxSize: CACHE_MAX_SIZE,
    ttlMs: CACHE_TTL_MS,
  };
}

/**
 * Convert a profile's navigator.languages array to an Accept-Language header string.
 * Produces a consistent header that matches what the stealth script injects into navigator.languages.
 *
 * Example: ["zh-CN", "zh", "en-US", "en"] → "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7"
 *
 * @param languages - navigator.languages array from the profile
 * @returns Accept-Language header value
 */
export function profileLanguagesToAcceptLanguage(languages: string[]): string {
  if (!languages || languages.length === 0) return 'en-US,en;q=0.9';
  const parts: string[] = [];
  for (let i = 0; i < languages.length; i++) {
    const q = i === 0 ? '' : `;q=${Math.max(0.1, 1.0 - i * 0.1).toFixed(1)}`;
    parts.push(`${languages[i]}${q}`);
  }
  return parts.join(',');
}

// ==================== Enhancement 1b: Header Order Jitter ====================

/**
 * Known distinct header orders observed from real browsers.
 * Different browsers send common headers in different orders —
 * this is a fingerprinting vector that advanced WAFs check.
 */
const BROWSER_HEADER_ORDERS: Record<string, string[]> = {
  Chrome: [
    'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
    'upgrade-insecure-requests', 'user-agent',
    'accept', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-user', 'sec-fetch-dest',
    'accept-encoding', 'accept-language',
  ],
  Edge: [
    'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
    'upgrade-insecure-requests', 'user-agent',
    'accept', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-user', 'sec-fetch-dest',
    'accept-encoding', 'accept-language',
  ],
  Firefox: [
    'host', 'user-agent', 'accept',
    'accept-language', 'accept-encoding',
    'connection', 'upgrade-insecure-requests',
  ],
  Safari: [
    'accept', 'accept-encoding', 'accept-language',
    'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site',
    'user-agent', 'upgrade-insecure-requests',
  ],
};

/**
 * Headers that should always appear at the beginning of the header block.
 * Most WAFs and anti-bot systems expect Host and User-Agent early.
 */
const REQUIRED_FIRST_HEADERS = new Set(['host', 'user-agent']);

/**
 * Shuffles HTTP headers while keeping required headers (Host, User-Agent) first.
 * Introduces per-request jitter so that even for the same domain, consecutive
 * requests have slightly different header ordering — making the traffic pattern
 * less fingerprintable than a perfectly consistent order.
 *
 * Algorithm:
 * 1. Extract Host and User-Agent → always first
 * 2. Pick a browser template order for the remaining headers (per-domain cached)
 * 3. Within the "middle" and "tail" groups of the template, apply Fisher-Yates
 *    shuffle with ~30% swap probability (partial shuffle preserves some browser-like structure)
 * 4. Any headers not in the template are appended in shuffled order
 *
 * @param headers - Key-value header pairs to reorder
 * @param domain  - Target domain for deterministic browser template selection
 * @returns A new Record with keys in a jittered but browser-like order
 */
export function shuffleHeaderOrderWithJitter(headers: Record<string, string>, domain: string): Record<string, string> {
  const headerKeys = Object.keys(headers);
  if (headerKeys.length <= 2) return { ...headers };

  // Step 1: Separate required-first headers
  const requiredKeys: string[] = [];
  const otherKeys: string[] = [];
  for (const key of headerKeys) {
    if (REQUIRED_FIRST_HEADERS.has(key.toLowerCase())) {
      requiredKeys.push(key);
    } else {
      otherKeys.push(key);
    }
  }

  // Step 2: Get browser template for non-required headers
  const h = domainHash(domain);
  const browserNames = Object.keys(BROWSER_HEADER_ORDERS);
  const browserTemplate = BROWSER_HEADER_ORDERS[browserNames[h % browserNames.length]]!;
  const templateSet = new Set(browserTemplate.map(k => k.toLowerCase()));

  // Step 3: Partition other keys into "template-matched" and "extra"
  const templateMatched: string[] = [];
  const extraKeys: string[] = [];
  for (const key of otherKeys) {
    if (templateSet.has(key.toLowerCase())) {
      templateMatched.push(key);
    } else {
      extraKeys.push(key);
    }
  }

  // Step 4: Partial Fisher-Yates shuffle on template-matched headers (~30% swap prob)
  // This introduces per-request jitter while preserving some browser-like structure
  for (let i = templateMatched.length - 1; i > 0; i--) {
    if (Math.random() < 0.3) { // 30% chance of swap at each position
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = templateMatched[i];
      templateMatched[i] = templateMatched[j]!;
      templateMatched[j] = tmp;
    }
  }

  // Step 5: Shuffle extra keys fully (they're non-standard headers)
  for (let i = extraKeys.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = extraKeys[i];
    extraKeys[i] = extraKeys[j]!;
    extraKeys[j] = tmp;
  }

  // Step 6: Build result: required first, then jittered template, then shuffled extras
  const orderedKeys = [...requiredKeys, ...templateMatched, ...extraKeys];
  const result: Record<string, string> = {};
  for (const key of orderedKeys) {
    if (key in headers) {
      result[key] = headers[key];
    }
  }
  // Safety: include any keys not in the ordered list
  for (const key of headerKeys) {
    if (!(key in result)) {
      result[key] = headers[key];
    }
  }

  return result;
}

// ==================== Enhancement 2: Accept-Language from Profile ====================

/**
 * Get an Accept-Language string for a domain, derived from the domain's fingerprint profile.
 * This ensures the HTTP Accept-Language header is always consistent with the
 * navigator.languages injected by the stealth script (both come from the same profile).
 *
 * @param domain - Target domain for consistent per-domain selection
 * @returns An Accept-Language header value string matching profile.languages
 */
export function getAcceptLanguageForDomain(domain: string): string {
  // getProfileForDomain() caches per-domain, so this is efficient
  const profile = getProfileForDomain(domain);
  return profileLanguagesToAcceptLanguage(profile.languages);
}

// ==================== Enhancement 4: Request Timing Humanization ====================

/** Cache for per-domain base delay with TTL (10 minutes) */
const domainBaseDelayCache = new Map<string, { value: number; createdAt: number }>();
const MAX_DELAY_CACHE = 500;
const DELAY_CACHE_TTL_MS = 600000;

/**
 * Returns a humanized fetch delay in milliseconds for a given domain.
 *
 * Timing patterns:
 * - Peak hours (9AM–11PM): faster base (300-800ms), simulating active browsing
 * - Off-peak (11PM–2AM, 6AM–9AM): medium base (500-1200ms)
 * - Dead zone (2AM–6AM): slower base (800-2000ms), simulating sleepy users
 *
 * Per-domain consistency: base delay is deterministic from domain hash.
 * Random jitter (50-200ms) is added each call to simulate human reading time.
 *
 * @param domain - Target domain for consistent base delay
 * @returns Delay in milliseconds (always >= 50)
 */
export function humanizedFetchDelay(domain: string): number {
  const hour = new Date().getHours(); // 0-23
  const h = domainHash(domain);

  // Get or compute domain-consistent base delay (with TTL check)
  const cached = domainBaseDelayCache.get(domain);
  let baseDelay: number | undefined;
  if (cached && (Date.now() - cached.createdAt) < DELAY_CACHE_TTL_MS) {
    baseDelay = cached.value;
  }
  if (baseDelay === undefined) {
    // Deterministic base delay from hash: 0-1 range
    const normalized = (h % 1000) / 1000;

    if (hour >= 9 && hour < 23) {
      // Peak hours: 300-800ms
      baseDelay = 300 + Math.round(normalized * 500);
    } else if (hour >= 6 && hour < 9 || hour >= 23) {
      // Off-peak: 500-1200ms
      baseDelay = 500 + Math.round(normalized * 700);
    } else {
      // Dead zone (2AM-6AM): 800-2000ms
      baseDelay = 800 + Math.round(normalized * 1200);
    }

    // Cache with LRU eviction
    if (domainBaseDelayCache.size >= MAX_DELAY_CACHE && !domainBaseDelayCache.has(domain)) {
      const firstKey = domainBaseDelayCache.keys().next().value;
      if (firstKey) domainBaseDelayCache.delete(firstKey);
    }
    domainBaseDelayCache.set(domain, { value: baseDelay, createdAt: Date.now() });
  }

  // Add random micro-delay (50-200ms) simulating human reading/clicking
  const microDelay = 50 + Math.round(Math.random() * 150);

  return baseDelay + microDelay;
}

/** Clear the domain delay cache. If domain specified, only clear that domain. */
export function clearDelayCache(domain?: string): void {
  if (domain) {
    domainBaseDelayCache.delete(domain);
  } else {
    domainBaseDelayCache.clear();
  }
}

// ==================== DNT / Sec-GPC Header Helper ====================

/**
 * Returns the appropriate privacy header for a fingerprint profile.
 *
 * - Firefox profiles get `Sec-GPC: 1` (Firefox enables Global Privacy Control by default)
 * - Chrome/Safari/Edge profiles get `DNT: 1` (legacy Do-Not-Track)
 *
 * The caller should only set ONE of these headers to avoid cross-channel mismatch
 * with the `navigator.doNotTrack` property patched in the stealth script.
 *
 * @param profile - A FingerprintProfile (used to detect browser family from userAgent)
 * @returns An object like `{ 'DNT': '1' }` or `{ 'Sec-GPC': '1' }`, or null if no header should be set
 */
export function getDntHeader(_profile?: FingerprintProfile): Record<string, string> | null {
  // Stealth script forces navigator.doNotTrack = null (Section 62).
  // Sending DNT/Sec-GPC HTTP header would create a cross-channel mismatch.
  return null;
}

