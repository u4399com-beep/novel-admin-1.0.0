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
};

// ---- Helpers ----

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickArray<T>(arr: readonly T[]): T[] {
  return [...arr];
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
  const uaList = UA_TEMPLATES[platform] || UA_TEMPLATES["Win32"]!;
  const userAgent = dPick(uaList, 5);

  const deviceMemory = dPick(DEVICE_MEMORY_OPTIONS, 6);
  const hardwareConcurrency = dPick(HARDWARE_CONCURRENCY_OPTIONS, 7);
  const colorDepth = dPick(COLOR_DEPTHS, 8);
  const pixelRatio = dPick(PIXEL_RATIOS, 9);

  // Asia/Shanghai is UTC+8 = -480 minutes, with ±30min random jitter
  const baseOffset = -480;
  const jitter = ((Math.abs(hash * 13) % 61) - 30); // -30 to +30
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
  const uaList = UA_TEMPLATES[platform] || UA_TEMPLATES["Win32"]!;
  const userAgent = pick(uaList);

  const baseOffset = -480;
  const jitter = Math.floor(Math.random() * 61) - 30;

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

// ==================== Stealth Injection Script ====================

/**
 * Generate a comprehensive JavaScript stealth injection script for `page.addInitScript()`.
 *
 * This script overrides ALL major browser fingerprinting vectors:
 * 1. Navigator properties (webdriver, plugins, languages, hardware, etc.)
 * 2. Chrome runtime object
 * 3. WebGL vendor/renderer
 * 4. Canvas fingerprint noise
 * 5. AudioContext fingerprint noise
 * 6. Screen/window properties
 * 7. WebRTC leak prevention
 * 8. Permission API consistency
 * 9. IFrame contentWindow overrides
 * 10. Date/timezone consistency
 * 11. Automation property removal
 * 12. MouseEvent / KeyboardEvent consistency
 * 13. Connection/Network Information API
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
