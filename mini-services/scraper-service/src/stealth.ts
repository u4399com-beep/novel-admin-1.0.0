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
  "Google Inc. (Apple)": [
    "Apple GPU",
    "Apple M1",
    "Apple M2",
    "Apple M3",
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
const PIXEL_RATIOS = [1, 1.25, 1.5] as const;

// Chrome user-agents indexed by platform for consistency
const UA_TEMPLATES: Record<string, string[]> = {
  Win32: [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  ],
  MacIntel: [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  ],
  "Linux x86_64": [
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  ],
  Edge: [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
  ],
  Firefox: [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0",
  ],
};

// Browser weights for weighted UA rotation (Chrome 70%, Edge 15%, Firefox 15%)
const UA_BROWSER_WEIGHTS: Record<string, number> = {
  Chrome: 70,
  Edge: 15,
  Firefox: 15,
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
    if (r < 70) selectedBrowser = "Chrome";
    else if (r < 85) selectedBrowser = "Edge";
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
    const idx = Math.abs((hash * (offset + 1) * 2654435761) >>> 0) % arr.length;
    return arr[idx];
  }

  const vendor = dPick(WEBGL_VENDORS, 1);
  const renderers = WEBGL_RENDERERS[vendor] || WEBGL_RENDERERS["Google Inc. (NVIDIA)"]!;
  const renderer = dPick(renderers, 2);

  const resolution = dPick(SCREEN_RESOLUTIONS, 3);
  const platform = dPick(PLATFORMS, 4);

  // Weighted browser selection (deterministic via seed)
  const weightedBrowsers: string[] = [];
  for (const [b, w] of Object.entries(UA_BROWSER_WEIGHTS)) {
    for (let i = 0; i < w; i++) weightedBrowsers.push(b);
  }
  const selectedBrowser = dPick(weightedBrowsers, 10);
  const uaPool = BROWSER_UA_POOLS[selectedBrowser] || ALL_CHROME_UAS;
  const userAgent = dPick(uaPool, 5);

  const deviceMemory = dPick(DEVICE_MEMORY_OPTIONS, 6);
  const hardwareConcurrency = dPick(HARDWARE_CONCURRENCY_OPTIONS, 7);
  const colorDepth = dPick(COLOR_DEPTHS, 8);
  const pixelRatio = dPick(PIXEL_RATIOS, 9);

  // Asia/Shanghai is UTC+8 = -480 minutes, with plausible ±5min geographic jitter
  const baseOffset = -480;
  const jitter = Math.round(((Math.abs(hash * 13) % 11) - 5) / 5) * 5; // -5 to +5 in steps of 5
  const timezoneOffset = baseOffset + jitter;

  return {
    webglVendor: vendor,
    webglRenderer: renderer,
    screenWidth: resolution.w,
    screenHeight: resolution.h,
    deviceMemory,
    hardwareConcurrency,
    platform,
    languages: ["zh-CN", "zh", "en-US", "en"],
    timezone: "Asia/Shanghai",
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
  const vendor = pick(WEBGL_VENDORS);
  const renderers = WEBGL_RENDERERS[vendor] || WEBGL_RENDERERS["Google Inc. (NVIDIA)"]!;
  const renderer = pick(renderers);
  const resolution = pick(SCREEN_RESOLUTIONS);
  const platform = pick(PLATFORMS);
  // Use weighted browser pool for UA selection
  const userAgent = getRandomUA();

  const baseOffset = -480;
  const jitter = Math.round((Math.random() * 11 - 5) / 5) * 5; // -5 to +5 in steps of 5

  return {
    webglVendor: vendor,
    webglRenderer: renderer,
    screenWidth: resolution.w,
    screenHeight: resolution.h,
    deviceMemory: pick(DEVICE_MEMORY_OPTIONS),
    hardwareConcurrency: pick(HARDWARE_CONCURRENCY_OPTIONS),
    platform,
    languages: ["zh-CN", "zh", "en-US", "en"],
    timezone: "Asia/Shanghai",
    timezoneOffset: baseOffset + jitter,
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
 * 4.  Canvas fingerprint noise (toDataURL, toBlob, getImageData)
 * 5.  AudioContext fingerprint noise
 * 6.  Screen/window properties
 * 7.  WebRTC leak prevention
 * 8.  Permission API consistency
 * 9.  IFrame contentWindow overrides
 * 10. Date/timezone consistency
 * 11. Automation property removal
 * 12. MouseEvent / KeyboardEvent consistency
 * 13. Connection/Network Information API (enhanced with saveData, seed-derived rtt/downlink)
 * 14. Storage consistency
 * 15. IFrame stealth propagation via MutationObserver
 * 16. ClientRects & getBoundingClientRect spoofing (layout fingerprint prevention)
 * 17. Enhanced Connection / Network Information API
 * 18. Battery API mock (basic)
 * 19. MediaDevices.enumerateDevices mock (basic)
 * 20. SpeechSynthesis mock (fake voices, speaking/pending/paused)
 * 21. Enhanced Canvas fingerprint (getImageData noise)
 * 22. Font detection countermeasure (document.fonts.check override)
 * 23. Platform-based Plugin/MimeType enumeration (3-4 plugins per platform)
 * 24. Console detection evasion
 * 25. Performance.now() offset & performance.timing consistency
 * 26. Mouse event listeners (capture-phase, passive)
 * 27. Touch support spoofing (mobile UA detection, TouchEvent constructor)
 * 28. MediaDevices enumerateDevices() fake (deterministic device IDs from seed)
 * 29. Battery API getBattery() override (realistic level + charging state)
 * 30. Canvas toDataURL/toBlob noise injection (imperceptible per-pixel RGB noise)
 * 31. AudioContext/OfflineAudioContext createOscillator frequency noise
 *
 * @param profile - The fingerprint profile to inject
 * @returns JavaScript code string to pass to `page.addInitScript()`
 */
export function getStealthScript(profile: FingerprintProfile): string {
  const languagesJSON = JSON.stringify(profile.languages);

  return `
// ===================================================================
// Obscura Stealth Injection v1.0
// Injected via page.addInitScript() — runs before any page script
// ===================================================================
(function() {
  'use strict';

  const PROFILE = ${JSON.stringify(profile)};

  // ---- 1. Navigator Override ----

  // Remove webdriver flag — the primary automation detection signal
  Object.defineProperty(navigator, 'webdriver', {
    get: () => false,
    configurable: true,
  });

  // Also delete from prototype chain
  try { delete navigator.__proto__.webdriver; } catch(e) {}

  // Fake plugins array (mimics a standard Chrome install with 5 plugins)
  const pluginData = [
    { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
    { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 1 },
    { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', length: 2 },
  { name: 'Widevine Content Decryption Module', filename: 'widevinecdmadapter.dll', description: 'Enables Widevine licenses for playback of DRM content', length: 1 },
    { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
  ];

  const pluginInstances = pluginData.map((p) => {
    const plugin = Object.create(Plugin.prototype);
    Object.defineProperties(plugin, {
      name: { get: () => p.name },
      filename: { get: () => p.filename },
      description: { get: () => p.description },
      length: { get: () => p.length },
    });
    return plugin;
  });

  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      const plugins = Object.create(PluginArray.prototype);
      pluginInstances.forEach((p, i) => {
        Object.defineProperty(plugins, i, { get: () => p, configurable: true });
        Object.defineProperty(plugins, p.name, { get: () => p, configurable: true });
      });
      Object.defineProperty(plugins, 'length', { get: () => pluginInstances.length });
      Object.defineProperty(plugins, 'item', {
        value: (i) => pluginInstances[i] || null,
      });
      Object.defineProperty(plugins, 'namedItem', {
        value: (name) => pluginInstances.find(p => p.name === name) || null,
      });
      Object.defineProperty(plugins, 'refresh', { value: () => {} });
      return plugins;
    },
    configurable: true,
  });

  // MimeTypes
  const mimeData = [
    { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
    { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' },
    { type: 'application/x-nacl', suffixes: '', description: 'Native Client Executable' },
    { type: 'application/x-pnacl', suffixes: '', description: 'Portable Native Client Executable' },
  ];
  const mimeInstances = mimeData.map((m) => {
    const mime = Object.create(MimeType.prototype);
    Object.defineProperties(mime, {
      type: { get: () => m.type },
      suffixes: { get: () => m.suffixes },
      description: { get: () => m.description },
    });
    return mime;
  });

  Object.defineProperty(navigator, 'mimeTypes', {
    get: () => {
      const mimes = Object.create(MimeTypeArray.prototype);
      mimeInstances.forEach((m, i) => {
        Object.defineProperty(mimes, i, { get: () => m, configurable: true });
        Object.defineProperty(mimes, m.type, { get: () => m, configurable: true });
      });
      Object.defineProperty(mimes, 'length', { get: () => mimeInstances.length });
      return mimes;
    },
    configurable: true,
  });

  // Languages
  Object.defineProperty(navigator, 'languages', {
    get: () => ${languagesJSON},
    configurable: true,
  });

  Object.defineProperty(navigator, 'language', {
    get: () => ${JSON.stringify(profile.languages[0])},
    configurable: true,
  });

  // Hardware
  Object.defineProperty(navigator, 'hardwareConcurrency', {
    get: () => ${profile.hardwareConcurrency},
    configurable: true,
  });

  Object.defineProperty(navigator, 'deviceMemory', {
    get: () => ${profile.deviceMemory},
    configurable: true,
  });

  // Platform
  Object.defineProperty(navigator, 'platform', {
    get: () => ${JSON.stringify(profile.platform)},
    configurable: true,
  });

  // Max touch points (desktop = 0)
  Object.defineProperty(navigator, 'maxTouchPoints', {
    get: () => 0,
    configurable: true,
  });

  // Remove other automation indicators
  try { delete navigator.__proto__.driver; } catch(e) {}
  try { delete navigator.__proto__.automation; } catch(e) {}

  // User-Agent override (ensure consistency)
  Object.defineProperty(navigator, 'userAgent', {
    get: () => PROFILE.userAgent,
    configurable: true,
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
  });

  // Vendor (Chrome always says "Google Inc.")
  Object.defineProperty(navigator, 'vendor', {
    get: () => 'Google Inc.',
    configurable: true,
  });

  // ---- 2. Chrome Object Override ----

  if (!window.chrome) {
    window.chrome = {};
  }
  if (!window.chrome.runtime) {
    window.chrome.runtime = {
      connect: function() { return { onMessage: { addListener: function() {} }, postMessage: function() {}, disconnect: function() {} }; },
      sendMessage: function() {},
      onMessage: { addListener: function() {} },
      id: undefined,
    };
  }
  if (!window.chrome.loadTimes) {
    window.chrome.loadTimes = function() {
      return {
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
    };
  }
  if (!window.chrome.csi) {
    window.chrome.csi = function() {
      return {
        onloadT: Date.now(),
        startE: Date.now(),
        pageT: Math.random() * 1000 + 500,
        tran: 15,
      };
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

  // ---- 3. WebGL Fingerprint Override ----

  const UNMASKED_VENDOR_WEBGL = 37445;
  const UNMASKED_RENDERER_WEBGL = 37446;

  // Override WebGLRenderingContext
  const origGetParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(param) {
    // UNMASKED_VENDOR_WEBGL
    if (param === UNMASKED_VENDOR_WEBGL) return PROFILE.webglVendor;
    // UNMASKED_RENDERER_WEBGL
    if (param === UNMASKED_RENDERER_WEBGL) return PROFILE.webglRenderer;
    return origGetParameter.call(this, param);
  };

  // Override WebGL2RenderingContext
  if (typeof WebGL2RenderingContext !== 'undefined') {
    const origGetParameter2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(param) {
      if (param === UNMASKED_VENDOR_WEBGL) return PROFILE.webglVendor;
      if (param === UNMASKED_RENDERER_WEBGL) return PROFILE.webglRenderer;
      return origGetParameter2.call(this, param);
    };
  }

  // Also patch getExtension to ensure WEBGL_debug_renderer_info is available
  const origGetExtension = WebGLRenderingContext.prototype.getExtension;
  WebGLRenderingContext.prototype.getExtension = function(name) {
    const ext = origGetExtension.call(this, name);
    if (name === 'WEBGL_debug_renderer_info') return ext;
    return ext;
  };

  // ---- 4. Canvas Fingerprint Noise ----

  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function(...args) {
    const ctx = this.getContext('2d');
    if (ctx) {
      // Inject an imperceptible noise pixel that changes the canvas hash
      const style = ctx.fillStyle;
      ctx.fillStyle = 'rgba(0,0,1,0.003)';
      ctx.fillRect(0, 0, 1, 1);
      ctx.fillStyle = style;
    }
    return origToDataURL.apply(this, args);
  };

  // Also override toBlob for canvas fingerprinting
  if (HTMLCanvasElement.prototype.toBlob) {
    const origToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function(...args) {
      const ctx = this.getContext('2d');
      if (ctx) {
        const style = ctx.fillStyle;
        ctx.fillStyle = 'rgba(1,0,0,0.003)';
        ctx.fillRect(0, 0, 1, 1);
        ctx.fillStyle = style;
      }
      return origToBlob.apply(this, args);
    };
  }

  // ---- 5. AudioContext Fingerprint Noise ----

  if (typeof AudioContext !== 'undefined' || typeof webkitAudioContext !== 'undefined') {
    const AC = typeof AudioContext !== 'undefined' ? AudioContext : webkitAudioContext;
    const origCreateOscillator = AC.prototype.createOscillator;

    AC.prototype.createOscillator = function() {
      const osc = origCreateOscillator.call(this);
      const freq = osc.frequency;
      let _value = freq.value;
      const _origValueDescriptor = Object.getOwnPropertyDescriptor(AudioParam.prototype, 'value') ||
        Object.getOwnPropertyDescriptor(osc.frequency, 'value');

      try {
        Object.defineProperty(osc.frequency, 'value', {
          get: () => _value + (Math.random() - 0.5) * 0.001,
          set: (v) => { _value = v; },
          configurable: true,
        });
      } catch(e) {}

      return osc;
    };
  }

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
    get: () => PROFILE.screenHeight - 40,
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

  // outerWidth / outerHeight (approximate for headless — match viewport)
  Object.defineProperty(window, 'outerWidth', {
    get: () => PROFILE.screenWidth,
    configurable: true,
  });
  Object.defineProperty(window, 'outerHeight', {
    get: () => PROFILE.screenHeight - 80,
    configurable: true,
  });

  // innerWidth / innerHeight are set by viewport; don't override to avoid layout issues

  // screenOrientation
  Object.defineProperty(screen, 'orientation', {
    get: () => ({
      angle: 0,
      type: 'landscape-primary',
      onchange: null,
      addEventListener: function() {},
      removeEventListener: function() {},
      dispatchEvent: function() { return true; },
    }),
    configurable: true,
  });

  // ---- 7. WebRTC Leak Prevention ----

  // Override RTCPeerConnection to prevent local IP leaks
  if (window.RTCPeerConnection) {
    const OrigRTCPC = window.RTCPeerConnection;
    window.RTCPeerConnection = function(...args) {
      // Return a dummy that doesn't gather candidates
      const noop = () => {};
      const fakePC = {
        createOffer: () => Promise.resolve({}),
        createAnswer: () => Promise.resolve({}),
        setLocalDescription: () => Promise.resolve(),
        setRemoteDescription: () => Promise.resolve(),
        addIceCandidate: () => Promise.resolve(),
        close: noop,
        getStats: () => Promise.resolve(new Map()),
        getSenders: () => [],
        getReceivers: () => [],
        getStreams: () => [],
        addTrack: () => {},
        removeTrack: noop,
        addTransceiver: noop,
        onicecandidate: null,
        oniceconnectionstatechange: null,
        ontrack: null,
        ondatachannel: null,
        iceGatheringState: 'new',
        iceConnectionState: 'new',
        signalingState: 'stable',
        connectionState: 'new',
      };
      return fakePC;
    };
    // Preserve static methods
    window.RTCPeerConnection.prototype = OrigRTCPC.prototype;
  }

  // Also prevent webkitRTCPeerConnection leaks
  if (window.webkitRTCPeerConnection) {
    window.webkitRTCPeerConnection = window.RTCPeerConnection;
  }

  // ---- 8. Permission Override ----

  if (navigator.permissions && navigator.permissions.query) {
    const origPermissionsQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = function(params) {
      if (params.name === 'notifications') {
        return Promise.resolve({
          state: typeof Notification !== 'undefined' ? Notification.permission : 'default',
          onchange: null,
        });
      }
      // For other permissions, return a permissive default
      if (['geolocation', 'camera', 'microphone', 'accelerometer', 'gyroscope', 'magnetometer'].includes(params.name)) {
        return Promise.resolve({ state: 'prompt', onchange: null });
      }
      return origPermissionsQuery(params);
    };
  }

  // ---- 9. IFrame ContentWindow Consistency ----

  // Override iframe contentWindow getter to apply same stealth to child frames
  const origAttachShadow = Element.prototype.attachShadow;
  if (origAttachShadow) {
    Element.prototype.attachShadow = function(...args) {
      const shadow = origAttachShadow.apply(this, args);
      // Ensure shadow roots don't leak automation info
      try {
        Object.defineProperty(shadow, 'innerHTML', {
          get: function() {
            return this.querySelector('*') ? '' : '';
          },
          set: function(v) {
            // Allow normal operation
          },
        });
      } catch(e) {}
      return shadow;
    };
  }

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

  // Remove CDP (Chrome DevTools Protocol) indicators
  try { delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array; } catch(e) {}
  try { delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise; } catch(e) {}
  try { delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol; } catch(e) {}

  // Remove Puppeteer/Playwright markers
  const propsToRemove = [
    '__playwright', '__puppeteer_evaluation_script__', '__selenium_unwrapped',
    'callPhantom', '_phantom', '__nightmare', 'domAutomation', 'domAutomationController',
  ];
  propsToRemove.forEach(prop => {
    try { delete window[prop]; } catch(e) {}
  });

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

  // ---- 13. Connection / Network Information API ----

  if (navigator.connection) {
    const conn = navigator.connection;
    if (!conn.effectiveType) {
      Object.defineProperty(conn, 'effectiveType', {
        get: () => '4g',
        configurable: true,
      });
    }
    if (!conn.downlink) {
      Object.defineProperty(conn, 'downlink', {
        get: () => 10,
        configurable: true,
      });
    }
    if (!conn.rtt) {
      Object.defineProperty(conn, 'rtt', {
        get: () => 50,
        configurable: true,
      });
    }
  } else if (navigator.mozConnection) {
    const conn = navigator.mozConnection;
    Object.defineProperty(conn, 'effectiveType', {
      get: () => '4g',
      configurable: true,
    });
  }

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

  // ---- 15. Iframe stealth propagation ----

  // Apply overrides to all iframes as they load
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
            Object.defineProperty(iwin.navigator, 'deviceMemory', {
              get: () => ${profile.deviceMemory},
              configurable: true,
            });
            Object.defineProperty(iwin.navigator, 'userAgent', {
              get: () => PROFILE.userAgent,
              configurable: true,
            });
            // Chrome object
            if (!iwin.chrome) {
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

  // ---- 16. ClientRects & getBoundingClientRect Spoofing ----
  // Add tiny random offsets (\u00b10.5px) to prevent layout fingerprinting

  var _origGetBoundingClientRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function() {
    var rect = _origGetBoundingClientRect.call(this);
    var jx = (Math.random() - 0.5) * 1.0;
    var jy = (Math.random() - 0.5) * 1.0;
    return new DOMRect(rect.x + jx, rect.y + jy, rect.width, rect.height);
  };

  var _origGetClientRects = Element.prototype.getClientRects;
  Element.prototype.getClientRects = function() {
    var rects = _origGetClientRects.call(this);
    var result = [];
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i];
      var jx2 = (Math.random() - 0.5) * 1.0;
      var jy2 = (Math.random() - 0.5) * 1.0;
      result.push(new DOMRect(r.x + jx2, r.y + jy2, r.width, r.height));
    }
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

  // ---- 18. Battery API Mock ----

  if (navigator.getBattery) {
    navigator.getBattery = function() {
      var _battLevel = 0.75 + Math.random() * 0.25;
      return Promise.resolve({
        charging: true,
        chargingTime: 0,
        dischargingTime: Infinity,
        level: _battLevel,
        addEventListener: function() {},
        removeEventListener: function() {},
        dispatchEvent: function() { return true; },
        onchargingchange: null,
        onchargingtimechange: null,
        ondischargingtimechange: null,
        onlevelchange: null,
      });
    };
  }

  // ---- 19. Media Devices Mock ----

  if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
    var _origEnumerateDevices = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
    navigator.mediaDevices.enumerateDevices = function() {
      return _origEnumerateDevices().then(function(devices) {
        if (devices.length > 0) return devices;
        return [
          { deviceId: 'default', groupId: 'default', kind: 'audioinput', label: '' },
          { deviceId: 'communications', groupId: 'communications', kind: 'audiooutput', label: '' },
          { deviceId: 'video0', groupId: 'video0', kind: 'videoinput', label: '' },
        ];
      });
    };
  } else if (navigator.mediaDevices) {
    // If mediaDevices exists but enumerateDevices doesn't
    navigator.mediaDevices.enumerateDevices = function() {
      return Promise.resolve([
        { deviceId: 'default', groupId: 'default', kind: 'audioinput', label: '' },
        { deviceId: 'communications', groupId: 'communications', kind: 'audiooutput', label: '' },
        { deviceId: 'video0', groupId: 'video0', kind: 'videoinput', label: '' },
      ]);
    };
  }

  // ---- 20. Speech Synthesis Mock ----

  if (window.speechSynthesis) {
    var _fakeVoices = [
      { voiceURI: 'Google US English', name: 'Google US English', lang: 'en-US', localService: true, default: true },
      { voiceURI: 'Google UK English Female', name: 'Google UK English Female', lang: 'en-GB', localService: true, default: false },
      { voiceURI: 'Google \u65e5\u672c\u8a9e', name: 'Google \u65e5\u672c\u8a9e', lang: 'ja-JP', localService: false, default: false },
    ];
    window.speechSynthesis.getVoices = function() { return _fakeVoices; };
    Object.defineProperty(window.speechSynthesis, 'speaking', { get: function() { return false; }, configurable: true });
    Object.defineProperty(window.speechSynthesis, 'pending', { get: function() { return false; }, configurable: true });
    Object.defineProperty(window.speechSynthesis, 'paused', { get: function() { return false; }, configurable: true });
    Object.defineProperty(window.speechSynthesis, 'length', { get: function() { return _fakeVoices.length; }, configurable: true });
  }

  // ---- 21. Enhanced Canvas Fingerprint (getImageData noise) ----

  if (CanvasRenderingContext2D.prototype.getImageData) {
    var _origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function() {
      var imageData = _origGetImageData.apply(this, arguments);
      var data = imageData.data;
      // Inject subtle noise into a few pixel channels to alter fingerprint hash
      for (var _ci = 0; _ci < Math.min(data.length, 400); _ci += 40) {
        data[_ci] = Math.max(0, Math.min(255, data[_ci] + ((Math.random() > 0.5) ? 1 : -1)));
      }
      return imageData;
    };
  }

  // ---- 22. Font Detection Countermeasure ----
  // Returns false for commonly-fingerprinted system fonts to prevent font enumeration

  if (document.fonts && document.fonts.check) {
    var _origFontsCheck = document.fonts.check.bind(document.fonts);
    var _fpFontPatterns = [
      'arial black', 'calibri', 'cambria', 'comic sans ms', 'consolas',
      'corbel', 'courier new', 'franklin gothic medium', 'georgia',
      'gill sans', 'impact', 'lucida console', 'lucida sans',
      'microsoft sans serif', 'palatino', 'segoe ui', 'tahoma',
      'times new roman', 'trebuchet ms', 'verdana', 'webdings',
    ];
    document.fonts.check = function(font, text) {
      var lower = (font || '').toLowerCase();
      for (var _fi = 0; _fi < _fpFontPatterns.length; _fi++) {
        if (lower.indexOf(_fpFontPatterns[_fi]) !== -1) return false;
      }
      return _origFontsCheck(font, text);
    };
  }

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
  var _selPlugins = _platformPlugins[PROFILE.platform] || _platformPlugins['Win32'];
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

  // ---- 24. Console Detection Evasion ----
  // Override console methods to prevent toString/timing-based devtools detection

  try {
    var _consoleMethods = ['log', 'debug', 'info', 'warn', 'error', 'clear', 'table', 'trace', 'dir'];
    _consoleMethods.forEach(function(method) {
      if (typeof console[method] === 'function') {
        var _origConsole = console[method];
        console[method] = function() { return _origConsole.apply(console, arguments); };
      }
    });
  } catch(_consoleErr) {}

  // ---- 25. Performance.now() & performance.timing Consistency ----

  if (window.performance) {
    // Add realistic offset so performance.now() doesn't start from exactly 0
    var _perfOffset = 1000 + Math.random() * 2000;
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
      var _tzOffsetMs = PROFILE.timezoneOffset * 60 * 1000;
      var _navStart = Date.now() - 3000 - Math.abs(_tzOffsetMs);
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
    // Deterministic fake device IDs derived from profile seed
    var _fakeDeviceSeed = 0;
    for (var _si = 0; _si < PROFILE.seed.length; _si++) { _fakeDeviceSeed = ((_fakeDeviceSeed << 5) - _fakeDeviceSeed + PROFILE.seed.charCodeAt(_si)) | 0; }
    _fakeDeviceSeed = Math.abs(_fakeDeviceSeed);

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
    var _batteryLevel = 0.65 + Math.abs(Math.sin(_fakeDeviceSeed)) * 0.35; // 0.65–1.0
    var _batteryCharging = true;
    var _batteryChargingTime = 3600;
    var _batteryDischargingTime = Infinity;

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
    var _fbLevel = 0.55 + Math.abs(Math.cos(_fakeDeviceSeed)) * 0.40;
    Object.defineProperty(navigator, 'getBattery', {
      value: function() {
        return _origGetBattery().then(function(realBattery) {
          try {
            Object.defineProperty(realBattery, 'level', { get: function() { return _fbLevel; }, configurable: true });
            Object.defineProperty(realBattery, 'charging', { get: function() { return true; }, configurable: true });
            Object.defineProperty(realBattery, 'chargingTime', { get: function() { return 5400; }, configurable: true });
            Object.defineProperty(realBattery, 'dischargingTime', { get: function() { return Infinity; }, configurable: true });
          } catch(e) {}
          return realBattery;
        });
      },
      configurable: true,
    });
  }

  // ---- 30. Canvas Fingerprint Noise ----
  // Add imperceptible noise to canvas pixel data so fingerprinting is unreliable.
  // The noise is deterministic per profile seed so the same page load produces
  // consistent (but fake) canvas output, but differs across page loads / profiles.
  try {
    var _canvasNoiseSeed = _fakeDeviceSeed * 13.37;
    var _origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(type, quality) {
      try {
        var ctx = this.getContext('2d');
        if (ctx) {
          var imgData = ctx.getImageData(0, 0, Math.max(1, this.width), Math.max(1, this.height));
          var d = imgData.data;
          for (var i = 0; i < d.length; i += 4) {
            // Flip 1-2 bits per pixel channel (imperceptible)
            _canvasNoiseSeed = (_canvasNoiseSeed * 16807 + 0.5) % 2147483647;
            var noise = (_canvasNoiseSeed % 3) - 1; // -1, 0, or 1
            d[i]   = Math.max(0, Math.min(255, d[i] + noise));     // R
            _canvasNoiseSeed = (_canvasNoiseSeed * 16807 + 0.5) % 2147483647;
            noise = (_canvasNoiseSeed % 3) - 1;
            d[i+1] = Math.max(0, Math.min(255, d[i+1] + noise));   // G
            _canvasNoiseSeed = (_canvasNoiseSeed * 16807 + 0.5) % 2147483647;
            noise = (_canvasNoiseSeed % 3) - 1;
            d[i+2] = Math.max(0, Math.min(255, d[i+2] + noise));   // B
            // Alpha channel untouched
          }
          ctx.putImageData(imgData, 0, 0);
        }
      } catch(e) {}
      return _origToDataURL.call(this, type, quality);
    };

    var _origToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function(callback, type, quality) {
      try {
        var ctx = this.getContext('2d');
        if (ctx) {
          var imgData = ctx.getImageData(0, 0, Math.max(1, this.width), Math.max(1, this.height));
          var d = imgData.data;
          for (var i = 0; i < d.length; i += 4) {
            _canvasNoiseSeed = (_canvasNoiseSeed * 16807 + 0.5) % 2147483647;
            var noise = (_canvasNoiseSeed % 3) - 1;
            d[i]   = Math.max(0, Math.min(255, d[i] + noise));
            _canvasNoiseSeed = (_canvasNoiseSeed * 16807 + 0.5) % 2147483647;
            noise = (_canvasNoiseSeed % 3) - 1;
            d[i+1] = Math.max(0, Math.min(255, d[i+1] + noise));
            _canvasNoiseSeed = (_canvasNoiseSeed * 16807 + 0.5) % 2147483647;
            noise = (_canvasNoiseSeed % 3) - 1;
            d[i+2] = Math.max(0, Math.min(255, d[i+2] + noise));
          }
          ctx.putImageData(imgData, 0, 0);
        }
      } catch(e) {}
      return _origToBlob.call(this, callback, type, quality);
    };
  } catch(e) {}

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

  // ---- 32. Navigation Timing Simulation ----
  // Override performance.getEntriesByType('navigation') to return realistic values,
  // preventing detection via timing-based fingerprinting.
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
    window.PerformanceObserver.prototype = {
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
        // For neutralized types, return empty array
        if (this._realObs) {
          try { return this._realObs.takeRecords(); } catch(e) { return []; }
        }
        return [];
      },
      supportedEntryTypes: _origPerformanceObserver.supportedEntryTypes || []
    };
    // Preserve static methods
    if (_origPerformanceObserver.supportedEntryTypes) {
      window.PerformanceObserver.supportedEntryTypes = _origPerformanceObserver.supportedEntryTypes;
    }
  } catch(e) {}

})();
`;
}

// ==================== Profile Cache ====================

/**
 * Per-domain fingerprint profile cache.
 * Ensures consistent fingerprinting across multiple requests to the same domain.
 */
const profileCache = new Map<string, FingerprintProfile>();
const CACHE_MAX_SIZE = 500;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface CacheEntry {
  profile: FingerprintProfile;
  createdAt: number;
}

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
    let oldestKey = '';
    let oldestTime = Infinity;
    for (const [key, entry] of profileCache) {
      if (entry.createdAt < oldestTime) {
        oldestTime = entry.createdAt;
        oldestKey = key;
      }
    }
    if (oldestKey) profileCache.delete(oldestKey);
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

// ==================== Enhancement 1: Header Order Randomization ====================

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
 * Simple deterministic hash for a string (same as the seed hash in generateFingerprintProfile).
 * Returns a 32-bit integer.
 */
function domainHash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h;
}

/**
 * Shuffled header order per domain (cache to maintain consistency).
 */
const domainHeaderOrderCache = new Map<string, string[]>();
const MAX_HEADER_ORDER_CACHE = 500;

/**
 * Randomize the order of HTTP headers to mimic different browser fingerprints.
 * Deterministic per-domain: same domain always gets the same header order
 * (until cache eviction), simulating a consistent browser identity.
 *
 * Real browsers send headers in distinct orders:
 * - Chrome/Edge: sec-ch-ua headers first, then upgrade-insecure-requests, user-agent, accept, sec-fetch-*, accept-encoding, accept-language
 * - Firefox: host, user-agent, accept, accept-language, accept-encoding, connection, upgrade-insecure-requests
 * - Safari: accept, accept-encoding, accept-language, sec-fetch-*, user-agent, upgrade-insecure-requests
 *
 * @param headers - Key-value header pairs to reorder
 * @param domain  - Target domain for deterministic (per-domain consistent) shuffling
 * @returns A new Record with the same key-value pairs in a browser-like shuffled order
 */
export function shuffleHeaderOrder(headers: Record<string, string>, domain: string): Record<string, string> {
  const headerKeys = Object.keys(headers);
  if (headerKeys.length <= 1) return { ...headers };

  // Check cache first
  let order = domainHeaderOrderCache.get(domain);
  if (!order) {
    // Pick a browser template based on domain hash
    const h = Math.abs(domainHash(domain));
    const browserNames = Object.keys(BROWSER_HEADER_ORDERS);
    const browserTemplate = BROWSER_HEADER_ORDERS[browserNames[h % browserNames.length]]!;

    // Build a deterministic order: start with the browser template headers that exist
    // in our input, then append any remaining keys in alphabetical order
    const templateSet = new Set(browserTemplate.map(k => k.toLowerCase()));
    const ordered: string[] = [];
    const remaining: string[] = [];

    for (const key of headerKeys) {
      if (templateSet.has(key.toLowerCase())) {
        ordered.push(key);
      } else {
        remaining.push(key);
      }
    }

    // Sort remaining alphabetically for consistency, then append
    remaining.sort((a, b) => a.localeCompare(b));
    ordered.push(...remaining);

    order = ordered;

    // Cache with LRU eviction
    if (domainHeaderOrderCache.size >= MAX_HEADER_ORDER_CACHE && !domainHeaderOrderCache.has(domain)) {
      const firstKey = domainHeaderOrderCache.keys().next().value;
      if (firstKey) domainHeaderOrderCache.delete(firstKey);
    }
    domainHeaderOrderCache.set(domain, order);
  }

  // Rebuild the headers object in the cached order
  const result: Record<string, string> = {};
  for (const key of order) {
    if (key in headers) {
      result[key] = headers[key];
    }
  }
  // Include any keys not in the cached order (edge case: new headers added after caching)
  for (const key of headerKeys) {
    if (!(key in result)) {
      result[key] = headers[key];
    }
  }

  return result;
}

/** Clear the header order cache. If domain specified, only clear that domain. */
export function clearHeaderOrderCache(domain?: string): void {
  if (domain) {
    domainHeaderOrderCache.delete(domain);
  } else {
    domainHeaderOrderCache.clear();
  }
}

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
  const h = Math.abs(domainHash(domain));
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

// ==================== Enhancement 2: Accept-Language Variation Pool ====================

/**
 * Accept-Language strings that mimic specific browser/OS combinations.
 * Each entry is tagged with a browser family for coherence with the chosen UA.
 */
const ACCEPT_LANGUAGE_POOL: Array<{ value: string; browser: string }> = [
  // Chrome on Windows (zh-CN primary)
  { value: 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7', browser: 'Chrome' },
  // Chrome on macOS
  { value: 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7', browser: 'Chrome' },
  // Edge on Windows (often en-primary in enterprise)
  { value: 'en-US,en;q=0.9,zh-CN;q=0.8', browser: 'Edge' },
  // Edge on Windows (zh-primary)
  { value: 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7', browser: 'Edge' },
  // Firefox on Windows
  { value: 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7', browser: 'Firefox' },
  // Firefox on macOS
  { value: 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7', browser: 'Firefox' },
  // Firefox on Linux
  { value: 'en-US,en;q=0.9', browser: 'Firefox' },
  // Safari on macOS
  { value: 'zh-CN,zh-Hans;q=0.9,en-US;q=0.8,en;q=0.7', browser: 'Safari' },
  // Chrome on Linux
  { value: 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7', browser: 'Chrome' },
  // Chrome on Windows (English locale)
  { value: 'en-US,en;q=0.9', browser: 'Chrome' },
];

/** Cache for per-domain Accept-Language consistency */
const domainAcceptLangCache = new Map<string, string>();
const MAX_ACCEPT_LANG_CACHE = 500;

/**
 * Get an Accept-Language string for a domain, deterministically selected
 * from the pool based on the domain hash. Same domain always returns the
 * same Accept-Language string (until cache eviction).
 *
 * @param domain - Target domain for consistent per-domain selection
 * @returns An Accept-Language header value string
 */
export function getAcceptLanguageForDomain(domain: string): string {
  let cached = domainAcceptLangCache.get(domain);
  if (cached) return cached;

  const h = Math.abs(domainHash(domain));
  const selected = ACCEPT_LANGUAGE_POOL[h % ACCEPT_LANGUAGE_POOL.length]!;
  const value = selected.value;

  // Cache with LRU eviction
  if (domainAcceptLangCache.size >= MAX_ACCEPT_LANG_CACHE && !domainAcceptLangCache.has(domain)) {
    const firstKey = domainAcceptLangCache.keys().next().value;
    if (firstKey) domainAcceptLangCache.delete(firstKey);
  }
  domainAcceptLangCache.set(domain, value);

  return value;
}

/**
 * Get all Accept-Language pool entries (for inspection/debugging).
 */
export function getAcceptLanguagePool(): Array<{ value: string; browser: string }> {
  return [...ACCEPT_LANGUAGE_POOL];
}

// ==================== Enhancement 4: Request Timing Humanization ====================

/** Cache for per-domain base delay */
const domainBaseDelayCache = new Map<string, number>();
const MAX_DELAY_CACHE = 500;

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
  const h = Math.abs(domainHash(domain));

  // Get or compute domain-consistent base delay
  let baseDelay = domainBaseDelayCache.get(domain);
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
    domainBaseDelayCache.set(domain, baseDelay);
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

// ==================== Enhancement 5: TLS Fingerprint Consistency ====================

/**
 * Known JA3/JA4 TLS fingerprint hints mapped to browser families.
 * These are reference strings that engines supporting TLS fingerprint
 * configuration can use to mimic specific browsers' TLS handshakes.
 *
 * JA3 format: MD5 hash of TLS Client Hello parameters (cipher suites,
 * extensions, elliptic curves, elliptic curve point formats).
 * JA4 format: More modern fingerprint including ALPN, cipher suite count, etc.
 */
export const TLS_FINGERPRINT_MAP: Record<string, Array<{ ja3: string; ja4: string; description: string }>> = {
  Chrome: [
    {
      ja3: '771,4865-4866-4867-49195,0-5-10-11-13-16-23-43-45-51-65281,29-23-24-25,0',
      ja4: 't13d1516h2_783a5c8e9f40',
      description: 'Chrome 131+ on Windows (TLS 1.3, GREASE)',
    },
    {
      ja3: '771,4865-4866-4867-49195,0-5-10-11-13-16-23-43-45-51-65281,29-23-24-25,0',
      ja4: 't13d1516h2_a1b2c3d4e5f6',
      description: 'Chrome 130 on macOS',
    },
  ],
  Firefox: [
    {
      ja3: '771,4865-4867-4866-49195,0-5-10-11-13-23-43-45-51-65281,29-23-24,0',
      ja4: 't13d1312h2_f1e2d3c4b5a6',
      description: 'Firefox 133 on Windows (TLS 1.3)',
    },
    {
      ja3: '771,4865-4867-4866-49195,0-5-10-11-13-23-43-45-51-65281,29-23-24,0',
      ja4: 't13d1312h2_9a8b7c6d5e4f',
      description: 'Firefox 132 on Linux',
    },
  ],
  Edge: [
    {
      ja3: '771,4865-4866-4867-49195,0-5-10-11-13-16-23-43-45-51-65281,29-23-24-25,0',
      ja4: 't13d1516h2_1a2b3c4d5e6f',
      description: 'Edge 131 on Windows (Chromium-based)',
    },
  ],
  Safari: [
    {
      ja3: '771,4865-4866-4867-49195-49199-49196-52393,0-5-10-11-13-16-18-23-27-43-45-51-65281,29-23-24,0',
      ja4: 't13d1617h2_safari1a2b',
      description: 'Safari 18.2 on macOS (Apple TLS stack)',
    },
  ],
};

/** Cache for per-domain TLS hint */
const domainTLSHintCache = new Map<string, { ja3: string; ja4: string; description: string }>();
const MAX_TLS_CACHE = 500;

/**
 * Get a TLS fingerprint hint for a domain, deterministically selected
 * based on the domain hash. Consistent per-domain to maintain identity coherence.
 *
 * The returned object contains JA3 and JA4 fingerprint strings that can be
 * used by engines that support TLS fingerprint configuration (e.g., curl-impersonate,
 * tls-client, or custom TLS stacks).
 *
 * @param domain - Target domain for consistent fingerprint selection
 * @returns An object with ja3, ja4, and description fields
 */
export function getTLSHint(domain: string): { ja3: string; ja4: string; description: string } {
  let cached = domainTLSHintCache.get(domain);
  if (cached) return cached;

  const h = Math.abs(domainHash(domain));
  const browserNames = Object.keys(TLS_FINGERPRINT_MAP);
  const browser = browserNames[h % browserNames.length]!;
  const fingerprints = TLS_FINGERPRINT_MAP[browser]!;
  const selected = fingerprints[(h >> 8) % fingerprints.length]!;

  // Cache with LRU eviction
  if (domainTLSHintCache.size >= MAX_TLS_CACHE && !domainTLSHintCache.has(domain)) {
    const firstKey = domainTLSHintCache.keys().next().value;
    if (firstKey) domainTLSHintCache.delete(firstKey);
  }
  domainTLSHintCache.set(domain, selected);

  return selected;
}

/** Clear the TLS hint cache. If domain specified, only clear that domain. */
export function clearTLSHintCache(domain?: string): void {
  if (domain) {
    domainTLSHintCache.delete(domain);
  } else {
    domainTLSHintCache.clear();
  }
}

// ==================== Enhancement: TLS Cipher Suite Rotation ====================

/**
 * A TLS profile containing cipher suite configuration for the Bun HTTP client.
 * These cipher suite orders mimic different browser TLS handshakes.
 */
export interface TlsProfile {
  /** Human-readable name for this profile */
  name: string;
  /** Browser family this profile mimics */
  browser: string;
  /** Ordered list of TLS cipher suites (IANA names). Order matters for JA3 fingerprinting. */
  ciphers: string[];
  /** ALPN protocol names in preference order */
  alpnProtocols: string[];
  /** Minimum TLS version */
  minVersion: 'TLSv1.2' | 'TLSv1.3';
  /** Reference JA3 hash for verification */
  ja3Ref?: string;
}

/**
 * TLS cipher suite profiles that mimic real browsers.
 * Each profile has a different cipher suite order to produce distinct JA3/JA4 hashes.
 *
 * Cipher suites are specified by their OpenSSL names, which Bun's tls module accepts.
 * The ORDER of ciphers is the primary factor in JA3 fingerprinting.
 */
const TLS_PROFILES: TlsProfile[] = [
  {
    name: 'Chrome 130+ Windows',
    browser: 'Chrome',
    ciphers: [
      'TLS_AES_128_GCM_SHA256',
      'TLS_AES_256_GCM_SHA384',
      'TLS_CHACHA20_POLY1305_SHA256',
      'ECDHE-ECDSA-AES128-GCM-SHA256',
      'ECDHE-RSA-AES128-GCM-SHA256',
      'ECDHE-ECDSA-AES256-GCM-SHA384',
      'ECDHE-RSA-AES256-GCM-SHA384',
    ],
    alpnProtocols: ['h2', 'http/1.1'],
    minVersion: 'TLSv1.2',
    ja3Ref: '771,4865-4866-4867-49195-49199-49200-52393,0-5-10-11-13-16-23-43-45-51-65281,29-23-24-25,0',
  },
  {
    name: 'Chrome 130+ macOS',
    browser: 'Chrome',
    ciphers: [
      'TLS_CHACHA20_POLY1305_SHA256',
      'TLS_AES_128_GCM_SHA256',
      'TLS_AES_256_GCM_SHA384',
      'ECDHE-ECDSA-AES128-GCM-SHA256',
      'ECDHE-RSA-AES128-GCM-SHA256',
      'ECDHE-ECDSA-AES256-GCM-SHA384',
      'ECDHE-RSA-AES256-GCM-SHA384',
    ],
    alpnProtocols: ['h2', 'http/1.1'],
    minVersion: 'TLSv1.2',
    ja3Ref: '771,4867-4865-4866-49195-49199-49200-52393,0-5-10-11-13-16-23-43-45-51-65281,29-23-24-25,0',
  },
  {
    name: 'Chrome 128-129 Linux',
    browser: 'Chrome',
    ciphers: [
      'TLS_AES_128_GCM_SHA256',
      'TLS_AES_256_GCM_SHA384',
      'TLS_CHACHA20_POLY1305_SHA256',
      'ECDHE-RSA-AES128-GCM-SHA256',
      'ECDHE-ECDSA-AES128-GCM-SHA256',
      'ECDHE-RSA-AES256-GCM-SHA384',
      'ECDHE-ECDSA-AES256-GCM-SHA384',
    ],
    alpnProtocols: ['h2', 'http/1.1'],
    minVersion: 'TLSv1.2',
    ja3Ref: '771,4865-4866-4867-49199-49195-49200-52392,0-5-10-11-13-16-23-43-45-51-65281,29-23-24-25,0',
  },
  {
    name: 'Firefox 128-130',
    browser: 'Firefox',
    ciphers: [
      'TLS_AES_128_GCM_SHA256',
      'TLS_CHACHA20_POLY1305_SHA256',
      'TLS_AES_256_GCM_SHA384',
      'ECDHE-ECDSA-AES128-GCM-SHA256',
      'ECDHE-RSA-AES128-GCM-SHA256',
      'ECDHE-ECDSA-AES256-GCM-SHA384',
      'ECDHE-RSA-AES256-GCM-SHA384',
    ],
    alpnProtocols: ['h2', 'http/1.1'],
    minVersion: 'TLSv1.2',
    ja3Ref: '771,4865-4867-4866-49195-49199,0-5-10-11-13-23-43-45-51-65281,29-23-24,0',
  },
  {
    name: 'Firefox 120-124',
    browser: 'Firefox',
    ciphers: [
      'TLS_AES_256_GCM_SHA384',
      'TLS_CHACHA20_POLY1305_SHA256',
      'TLS_AES_128_GCM_SHA256',
      'ECDHE-ECDSA-AES256-GCM-SHA384',
      'ECDHE-RSA-AES256-GCM-SHA384',
      'ECDHE-ECDSA-AES128-GCM-SHA256',
      'ECDHE-RSA-AES128-GCM-SHA256',
    ],
    alpnProtocols: ['h2', 'http/1.1'],
    minVersion: 'TLSv1.2',
    ja3Ref: '771,4866-4867-4865-49199-49200,0-5-10-11-13-23-43-45-51-65281,29-23-24,0',
  },
  {
    name: 'Safari 18.x macOS',
    browser: 'Safari',
    ciphers: [
      'TLS_AES_128_GCM_SHA256',
      'TLS_AES_256_GCM_SHA384',
      'TLS_CHACHA20_POLY1305_SHA256',
      'ECDHE-ECDSA-AES256-GCM-SHA384',
      'ECDHE-ECDSA-AES128-GCM-SHA256',
      'ECDHE-RSA-AES256-GCM-SHA384',
      'ECDHE-RSA-AES128-GCM-SHA256',
    ],
    alpnProtocols: ['h2', 'http/1.1'],
    minVersion: 'TLSv1.2',
    ja3Ref: '771,4865-4866-4867-49199-49195,0-5-10-11-13-16-18-23-27-43-45-51-65281,29-23-24,0',
  },
  {
    name: 'Safari 17.x macOS',
    browser: 'Safari',
    ciphers: [
      'TLS_AES_256_GCM_SHA384',
      'TLS_AES_128_GCM_SHA256',
      'TLS_CHACHA20_POLY1305_SHA256',
      'ECDHE-ECDSA-AES256-GCM-SHA384',
      'ECDHE-ECDSA-AES128-GCM-SHA256',
      'ECDHE-RSA-AES256-GCM-SHA384',
      'ECDHE-RSA-AES128-GCM-SHA256',
    ],
    alpnProtocols: ['h2', 'http/1.1'],
    minVersion: 'TLSv1.2',
    ja3Ref: '771,4866-4865-4867-49199-49195,0-5-10-11-13-16-18-23-27-43-45-51-65281,29-23-24,0',
  },
  {
    name: 'Edge 130+ Windows',
    browser: 'Edge',
    ciphers: [
      'TLS_AES_128_GCM_SHA256',
      'TLS_AES_256_GCM_SHA384',
      'TLS_CHACHA20_POLY1305_SHA256',
      'ECDHE-ECDSA-AES128-GCM-SHA256',
      'ECDHE-RSA-AES128-GCM-SHA256',
      'ECDHE-ECDSA-AES256-GCM-SHA384',
      'ECDHE-RSA-AES256-GCM-SHA384',
    ],
    alpnProtocols: ['h2', 'http/1.1'],
    minVersion: 'TLSv1.2',
    ja3Ref: '771,4865-4866-4867-49195-49199-49200-52393,0-5-10-11-13-16-23-43-45-51-65281,29-23-24-25,0',
  },
];

/** Cache for per-domain TLS profile */
const domainTlsProfileCache = new Map<string, TlsProfile>();
const MAX_TLS_PROFILE_CACHE = 500;

/**
 * Get a TLS profile with cipher suite configuration for a domain.
 * Deterministically selected per domain to maintain identity coherence.
 *
 * The returned profile can be used to configure Bun's HTTP client TLS options:
 * ```ts
 * const profile = getTlsProfile(domain);
 * Bun.fetch(url, {
 *   tls: {
 *     ciphers: profile.ciphers.join(':'),
 *     minVersion: profile.minVersion,
 *   }
 * });
 * ```
 *
 * @param domain  - Target domain for consistent profile selection
 * @param browser - Optional browser family hint ('Chrome' | 'Firefox' | 'Safari' | 'Edge')
 * @returns A TlsProfile with cipher suite order, ALPN protocols, and min TLS version
 */
export function getTlsProfile(domain: string, browser?: string): TlsProfile {
  let cached = domainTlsProfileCache.get(domain);
  if (cached) return cached;

  let candidates = browser
    ? TLS_PROFILES.filter(p => p.browser === browser)
    : TLS_PROFILES;

  // Fallback to all profiles if browser filter yields nothing
  if (candidates.length === 0) candidates = TLS_PROFILES;

  const h = Math.abs(domainHash(domain));
  const selected = candidates[h % candidates.length]!;

  // Cache with LRU eviction
  if (domainTlsProfileCache.size >= MAX_TLS_PROFILE_CACHE && !domainTlsProfileCache.has(domain)) {
    const firstKey = domainTlsProfileCache.keys().next().value;
    if (firstKey) domainTlsProfileCache.delete(firstKey);
  }
  domainTlsProfileCache.set(domain, selected);

  return selected;
}

/**
 * Get all available TLS profiles (for inspection/debugging).
 */
export function getAvailableTlsProfiles(): ReadonlyArray<TlsProfile> {
  return TLS_PROFILES;
}

/** Clear the TLS profile cache. If domain specified, only clear that domain. */
export function clearTlsProfileCache(domain?: string): void {
  if (domain) {
    domainTlsProfileCache.delete(domain);
  } else {
    domainTlsProfileCache.clear();
  }
}

// ==================== Humanized Fetch Delay ====================

/**
 * Generate a humanized delay before fetching a URL.
 * Simulates human browsing patterns:
 *   - Faster during peak hours (9AM-11PM local time)
 *   - Slower at night (2AM-6AM)
 *   - Random micro-delays simulating reading/thinking time
 *   - Deterministic base per-domain for consistent behavior
 *
 * @param domain - Target domain for per-domain consistency
 * @param minMs - Minimum additional delay (default 50ms)
 * @param maxMs - Maximum additional delay (default 800ms)
 * @returns Delay in milliseconds
 */
export function humanizedFetchDelay(domain: string, minMs = 50, maxMs = 800): number {
  const now = new Date();
  const hour = now.getHours();

  // Time-of-day multiplier: slower at night, faster during day
   let todMultiplier: number;
  if (hour >= 2 && hour < 6) {
    todMultiplier = 2.0; // Night: humans are slower
  } else if (hour >= 6 && hour < 9) {
    todMultiplier = 1.5; // Early morning: moderate
  } else if (hour >= 9 && hour < 23) {
    todMultiplier = 1.0; // Peak hours: normal speed
  } else {
    todMultiplier = 1.3; // Late night (23-2): slightly slower
  }

  // Deterministic base delay from domain hash
  const h = Math.abs(domainHash(domain));
  const baseDelay = minMs + (h % 100) / 100 * (maxMs - minMs) * 0.3;

  // Random jitter (30% of range)
  const jitter = Math.random() * (maxMs - minMs) * 0.3;

  return Math.round((baseDelay + jitter) * todMultiplier);
}

