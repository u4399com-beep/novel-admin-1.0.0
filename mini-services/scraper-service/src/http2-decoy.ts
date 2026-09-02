/**
 * HTTP/2 Pseudo-Header & Connection Fingerprint Diversifier
 *
 * While we can't control the actual HTTP/2 SETTINGS frame at the application layer
 * (that's handled by Bun's TLS library), we CAN diversify other connection-level
 * signals that anti-bot systems use for fingerprinting:
 *
 *   1. Connection header variation (keep-alive timing, max requests)
 *   2. Priority/dependency hints in HTTP/2
 *   3. Accept-Encoding preference order variation
 *   4. Connection pool reuse patterns
 *   5. HTTP/2 SETTINGS frame fingerprint (per-browser-type)
 *   6. WINDOW_UPDATE frame simulation
 *   7. PRIORITY/HEADERS frame order simulation
 *   8. Connection preface timing
 *   9. Stream dependency tree
 *
 * This module provides per-domain consistent connection behavior to avoid
 * detection via connection-level fingerprinting.
 */

import { domainHash } from './utils';

// ==================== Types ====================

/** HTTP/2 SETTINGS parameter IDs (RFC 7540 §6.5.2) */
export const H2_SETTINGS_ID = {
  HEADER_TABLE_SIZE: 0x1,          // 1
  ENABLE_PUSH: 0x2,                // 2
  MAX_CONCURRENT_STREAMS: 0x3,     // 3
  INITIAL_WINDOW_SIZE: 0x4,        // 4
  MAX_FRAME_SIZE: 0x5,             // 5
  MAX_HEADER_LIST_SIZE: 0x6,       // 6
} as const;

/** A single HTTP/2 SETTINGS parameter */
export interface H2Setting {
  id: number;
  value: number;
}

/** Simulated HTTP/2 PRIORITY frame for a stream */
export interface H2PriorityFrame {
  streamId: number;
  dependsOn: number;
  weight: number;  // 1-256
  exclusive: boolean;
}

/** Simulated HTTP/2 frame in the connection preamble sequence */
export interface H2PreambleFrame {
  type: 'SETTINGS' | 'WINDOW_UPDATE' | 'PRIORITY' | 'HEADERS' | 'SETTINGS_ACK';
  /** Delay in ms from the previous frame (for timing simulation) */
  delayMs: number;
  /** Stream ID (0 for connection-level frames) */
  streamId?: number;
  /** For SETTINGS frames: the parameter list */
  settings?: H2Setting[];
  /** For WINDOW_UPDATE: increment value */
  windowIncrement?: number;
  /** For PRIORITY frames */
  priority?: H2PriorityFrame;
}

/** Chrome's stream priority dependency tree node */
export interface H2StreamDependency {
  streamId: number;
  dependsOn: number;
  weight: number;
  exclusive: boolean;
}

/** HTTP/2 SETTINGS fingerprint for a specific browser type */
export interface H2SettingsFingerprint {
  browser: string;
  label: string;
  settings: H2Setting[];
  windowUpdateIncrement: number;
  priorityTree: H2StreamDependency[];
  /** Connection preface timing: delay between SETTINGS sent and SETTINGS_ACK received */
  settingsAckDelayMs: number;
}

export interface ConnectionProfile {
  /** Accept-Encoding preference order */
  acceptEncoding: string;
  /** Connection header value */
  connectionHeader: string;
  /** HTTP/2 SETTINGS fingerprint matching the UA's browser type */
  h2Settings: H2SettingsFingerprint;
  /** Priority urgency (0 = highest) */
  priorityUrgency: number;
}

// ==================== HTTP/2 Browser SETTINGS Profiles ====================

/**
 * Realistic HTTP/2 SETTINGS frame parameters per browser.
 *
 * Chrome actual H2 SETTINGS:
 *   HEADER_TABLE_SIZE=65536, ENABLE_PUSH=0, MAX_CONCURRENT_STREAMS=1000,
 *   INITIAL_WINDOW_SIZE=6291456, MAX_FRAME_SIZE=16384, MAX_HEADER_LIST_SIZE=262144
 *
 * Firefox differs:
 *   HEADER_TABLE_SIZE=65536, ENABLE_PUSH=0, MAX_CONCURRENT_STREAMS=100,
 *   INITIAL_WINDOW_SIZE=131072, MAX_FRAME_SIZE=16384, MAX_HEADER_LIST_SIZE=262144
 *
 * Safari differs:
 *   HEADER_TABLE_SIZE=4096, ENABLE_PUSH=1, MAX_CONCURRENT_STREAMS=100,
 *   INITIAL_WINDOW_SIZE=65535, MAX_FRAME_SIZE=16384, MAX_HEADER_LIST_SIZE=65536
 */
const H2_SETTINGS_PROFILES: H2SettingsFingerprint[] = [
  {
    browser: 'Chrome',
    label: 'Chrome 120-133',
    settings: [
      { id: H2_SETTINGS_ID.HEADER_TABLE_SIZE, value: 65536 },
      { id: H2_SETTINGS_ID.ENABLE_PUSH, value: 0 },
      { id: H2_SETTINGS_ID.MAX_CONCURRENT_STREAMS, value: 1000 },
      { id: H2_SETTINGS_ID.INITIAL_WINDOW_SIZE, value: 6291456 },
      { id: H2_SETTINGS_ID.MAX_FRAME_SIZE, value: 16384 },
      { id: H2_SETTINGS_ID.MAX_HEADER_LIST_SIZE, value: 262144 },
    ],
    windowUpdateIncrement: 15663105,
    priorityTree: [],  // Filled by getChromePriorityTree()
    settingsAckDelayMs: 5,
  },
  {
    browser: 'Chrome',
    label: 'Chrome 110-119',
    settings: [
      { id: H2_SETTINGS_ID.HEADER_TABLE_SIZE, value: 65536 },
      { id: H2_SETTINGS_ID.ENABLE_PUSH, value: 0 },
      { id: H2_SETTINGS_ID.MAX_CONCURRENT_STREAMS, value: 1000 },
      { id: H2_SETTINGS_ID.INITIAL_WINDOW_SIZE, value: 6291456 },
      { id: H2_SETTINGS_ID.MAX_FRAME_SIZE, value: 16384 },
      { id: H2_SETTINGS_ID.MAX_HEADER_LIST_SIZE, value: 262144 },
    ],
    windowUpdateIncrement: 15663105,
    priorityTree: [],
    settingsAckDelayMs: 6,
  },
  {
    browser: 'Firefox',
    label: 'Firefox 120-134',
    settings: [
      { id: H2_SETTINGS_ID.HEADER_TABLE_SIZE, value: 65536 },
      { id: H2_SETTINGS_ID.ENABLE_PUSH, value: 0 },
      { id: H2_SETTINGS_ID.MAX_CONCURRENT_STREAMS, value: 100 },
      { id: H2_SETTINGS_ID.INITIAL_WINDOW_SIZE, value: 131072 },
      { id: H2_SETTINGS_ID.MAX_FRAME_SIZE, value: 16384 },
      { id: H2_SETTINGS_ID.MAX_HEADER_LIST_SIZE, value: 262144 },
    ],
    windowUpdateIncrement: 0, // Firefox does NOT send a connection-level WINDOW_UPDATE on init
    priorityTree: [],
    settingsAckDelayMs: 8,
  },
  {
    browser: 'Safari',
    label: 'Safari 17-18',
    settings: [
      { id: H2_SETTINGS_ID.HEADER_TABLE_SIZE, value: 4096 },
      { id: H2_SETTINGS_ID.ENABLE_PUSH, value: 1 },
      { id: H2_SETTINGS_ID.MAX_CONCURRENT_STREAMS, value: 100 },
      { id: H2_SETTINGS_ID.INITIAL_WINDOW_SIZE, value: 65535 },
      { id: H2_SETTINGS_ID.MAX_FRAME_SIZE, value: 16384 },
      { id: H2_SETTINGS_ID.MAX_HEADER_LIST_SIZE, value: 65536 },
    ],
    windowUpdateIncrement: 0,
    priorityTree: [],
    settingsAckDelayMs: 10,
  },
  {
    browser: 'Edge',
    label: 'Edge 130+',
    settings: [
      { id: H2_SETTINGS_ID.HEADER_TABLE_SIZE, value: 65536 },
      { id: H2_SETTINGS_ID.ENABLE_PUSH, value: 0 },
      { id: H2_SETTINGS_ID.MAX_CONCURRENT_STREAMS, value: 1000 },
      { id: H2_SETTINGS_ID.INITIAL_WINDOW_SIZE, value: 6291456 },
      { id: H2_SETTINGS_ID.MAX_FRAME_SIZE, value: 16384 },
      { id: H2_SETTINGS_ID.MAX_HEADER_LIST_SIZE, value: 262144 },
    ],
    windowUpdateIncrement: 15663105,
    priorityTree: [],
    settingsAckDelayMs: 5,
  },
];

// ==================== Chrome Priority Tree ====================

/**
 * Chrome's HTTP/2 stream priority tree.
 *
 * Chrome builds a priority tree like this:
 *   Stream 0 (root)
 *   ├── Stream 1 (main navigation, weight=256, depends on 0)
 *   │   ├── Stream 3 (CSS, weight=187, depends on 1)
 *   │   └── Stream 5 (JS, weight=140, depends on 1)
 *   │       └── Stream 7 (async JS, weight=110, depends on 5)
 *   ├── Stream 11 (images, weight=110, depends on 0)
 *   └── Stream 13 (XHR/fetch, weight=256, depends on 0)
 *
 * This tree is used by Chrome to prioritize critical resources.
 * Advanced WAFs may observe the priority/dependency pattern.
 */
const CHROME_PRIORITY_TREE: H2StreamDependency[] = [
  { streamId: 1,  dependsOn: 0,  weight: 256, exclusive: false },
  { streamId: 3,  dependsOn: 1,  weight: 187, exclusive: false },
  { streamId: 5,  dependsOn: 1,  weight: 140, exclusive: false },
  { streamId: 7,  dependsOn: 5,  weight: 110, exclusive: false },
  { streamId: 11, dependsOn: 0,  weight: 110, exclusive: false },
  { streamId: 13, dependsOn: 0,  weight: 256, exclusive: false },
];

/**
 * Returns Chrome's HTTP/2 stream priority dependency tree.
 * This is the static tree structure Chrome uses for resource prioritization.
 *
 * @returns Array of stream dependency descriptors ordered by Chrome's initialization sequence
 */
export function getChromePriorityTree(): H2StreamDependency[] {
  return CHROME_PRIORITY_TREE;
}

// ==================== H2 Preamble Frame Sequence ====================

/**
 * Generates the simulated HTTP/2 connection preamble frame sequence
 * that matches a specific browser's behavior.
 *
 * Chrome's connection initialization order:
 *   1. Client preface string ("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n")
 *   2. SETTINGS frame (6 parameters)
 *   3. ~5ms delay (RTT simulation)
 *   4. Receive server SETTINGS
 *   5. SETTINGS_ACK (acknowledge server settings)
 *   6. PRIORITY frame for stream 3 (depends on 0, weight=187)
 *   7. PRIORITY frame for stream 5 (depends on 0, weight=140)
 *   8. WINDOW_UPDATE (increment=15663105) on connection (stream 0)
 *   9. HEADERS frame for stream 1 (the actual request)
 *
 * Firefox's connection initialization:
 *   1. Client preface
 *   2. SETTINGS frame (6 parameters)
 *   3. ~8ms delay
 *   4. SETTINGS_ACK
 *   5. HEADERS frame for stream 1 (Firefox sends PRIORITY frames inline with HEADERS, not separately)
 *
 * @param fingerprint - The H2 settings fingerprint to generate the preamble for
 * @returns Ordered list of frames with timing delays
 */
export function getH2PreambleSequence(fingerprint: H2SettingsFingerprint): H2PreambleFrame[] {
  const frames: H2PreambleFrame[] = [];

  // 1. Client SETTINGS frame
  frames.push({
    type: 'SETTINGS',
    delayMs: 0,
    settings: fingerprint.settings,
  });

  // 2. Delay before SETTINGS_ACK (simulating RTT to receive server SETTINGS)
  frames.push({
    type: 'SETTINGS_ACK',
    delayMs: fingerprint.settingsAckDelayMs,
  });

  if (fingerprint.browser === 'Chrome' || fingerprint.browser === 'Edge') {
    // Chrome/Edge: PRIORITY frames for stream 3 and 5 first, then WINDOW_UPDATE, then HEADERS
    const tree = getChromePriorityTree();

    // PRIORITY for stream 3 (CSS priority)
    frames.push({
      type: 'PRIORITY',
      delayMs: 1,
      streamId: 3,
      priority: tree.find(n => n.streamId === 3),
    });

    // PRIORITY for stream 5 (JS priority)
    frames.push({
      type: 'PRIORITY',
      delayMs: 0,
      streamId: 5,
      priority: tree.find(n => n.streamId === 5),
    });

    // WINDOW_UPDATE on connection level (stream 0)
    if (fingerprint.windowUpdateIncrement > 0) {
      frames.push({
        type: 'WINDOW_UPDATE',
        delayMs: 0,
        streamId: 0,
        windowIncrement: fingerprint.windowUpdateIncrement,
      });
    }
  } else if (fingerprint.browser === 'Firefox') {
    // Firefox: No separate PRIORITY frames, no WINDOW_UPDATE on init
    // Just goes straight to HEADERS after SETTINGS_ACK
  }

  // HEADERS frame for the main request (stream 1)
  frames.push({
    type: 'HEADERS',
    delayMs: fingerprint.browser === 'Safari' ? 2 : 1,
    streamId: 1,
  });

  return frames;
}

/**
 * Get the total simulated preamble duration in ms.
 * Useful for timing analysis and logging.
 */
export function getPreambleDurationMs(fingerprint: H2SettingsFingerprint): number {
  const frames = getH2PreambleSequence(fingerprint);
  return frames.reduce((sum, f) => sum + f.delayMs, 0);
}

// ==================== Accept-Encoding Pools ====================

/** Legacy / older server stacks (Chinese novel sites, .cn, .com.cn) */
const LEGACY_ENCODING_POOL: readonly string[] = [
  'gzip, deflate',
  'gzip',
  'deflate, gzip',
];

/** Modern sites (CDN-backed, major platforms) */
const MODERN_ENCODING_POOL: readonly string[] = [
  'gzip, deflate, br',       // Classic Chrome (< v70)
  'br, gzip, deflate',       // Modern Chrome (v70+)
  'gzip, br, deflate',       // Chrome variant
  'gzip, deflate, br, zstd', // Chrome 116+ with zstd
  'br, gzip, deflate, zstd', // Chrome 116+ with zstd (alt order)
];

// ==================== Domain Cache ====================

const domainConnProfileCache = new Map<string, ConnectionProfile>();
const MAX_CACHE_SIZE = 200;
const CACHE_TTL_MS = 20 * 60 * 1000; // 20 minutes

interface CacheEntry {
  profile: ConnectionProfile;
  createdAt: number;
}

// ==================== Domain Classification ====================

/** Chinese / legacy TLDs that tend to have older server stacks */
const LEGACY_TLDS = ['.cn', '.com.cn', '.net.cn', '.org.cn', '.gov.cn', '.ac.cn'].sort((a, b) => b.length - a.length);

/**
 * Classify a domain for encoding pool selection.
 * - Chinese / legacy TLDs → LEGACY_ENCODING_POOL (older server stacks)
 * - Otherwise → MODERN_ENCODING_POOL (CDN-backed modern sites)
 */
function classifyDomain(domain: string): 'legacy' | 'modern' {
  const lower = domain.toLowerCase();
  for (const tld of LEGACY_TLDS) {
    if (lower.endsWith(tld)) return 'legacy';
  }
  return 'modern';
}

// ==================== Browser Detection from UA ====================

/**
 * Detect browser family from a User-Agent string for H2 profile selection.
 */
export function detectBrowserForH2(ua: string): 'Chrome' | 'Firefox' | 'Safari' | 'Edge' {
  if (ua.includes('Edg/')) return 'Edge';
  if (ua.includes('OPR/') || ua.includes('Opera')) return 'Chrome'; // Opera uses Chromium engine
  if (ua.includes('Firefox/')) return 'Firefox';
  if (ua.includes('Chrome/')) return 'Chrome';
  if (ua.includes('Safari/') && ua.includes('Macintosh')) return 'Safari';
  return 'Chrome'; // Default fallback
}

/**
 * Get an H2 settings fingerprint for a given browser type and seed.
 * Deterministically selects from available profiles for that browser.
 */
export function getH2SettingsFingerprint(browser: 'Chrome' | 'Firefox' | 'Safari' | 'Edge', seed: number): H2SettingsFingerprint {
  const candidates = H2_SETTINGS_PROFILES.filter(p => p.browser === browser);
  const pool = candidates.length > 0 ? candidates : H2_SETTINGS_PROFILES.filter(p => p.browser === 'Chrome');
  const selected = pool[seed % pool.length]!;

  // Attach the priority tree for Chrome/Edge
  if (selected.browser === 'Chrome' || selected.browser === 'Edge') {
    return { ...selected, priorityTree: getChromePriorityTree() };
  }
  return { ...selected };
}

// ==================== Main API ====================

/**
 * Get a per-domain consistent connection profile.
 * Same domain always gets the same profile (until cache eviction).
 *
 * The H2 SETTINGS fingerprint now matches the UA's browser type, providing
 * consistent HTTP/2-level fingerprinting that aligns with the HTTP headers.
 *
 * @param domain - Target domain
 * @param ua - Optional User-Agent string to determine browser type for H2 settings
 * @returns Connection profile with diversified settings and H2 fingerprint
 */
export function getConnectionProfile(domain: string, ua?: string): ConnectionProfile {
  const now = Date.now();
  const cached = domainConnProfileCache.get(domain);

  if (cached && (now - cached.createdAt) < CACHE_TTL_MS) {
    return cached.profile;
  }

  // Evict oldest if cache is full (skip if refreshing an existing entry — set() will overwrite it)
  if (domainConnProfileCache.size >= MAX_CACHE_SIZE && !domainConnProfileCache.has(domain)) {
    let oldestKey = '';
    let oldestTime = Infinity;
    for (const [key, entry] of domainConnProfileCache) {
      if (entry.createdAt < oldestTime) {
        oldestTime = entry.createdAt;
        oldestKey = key;
      }
    }
    if (oldestKey) domainConnProfileCache.delete(oldestKey);
  }

  const h = domainHash(domain);
  const domainClass = classifyDomain(domain);
  const pool = domainClass === 'legacy' ? LEGACY_ENCODING_POOL : MODERN_ENCODING_POOL;

  // Detect browser type from UA for H2 settings matching
  const browser = ua ? detectBrowserForH2(ua) : 'Chrome';
  const h2Settings = getH2SettingsFingerprint(browser, h);

  const profile: ConnectionProfile = {
    acceptEncoding: pool[h % pool.length],
    connectionHeader: h % 3 === 0 ? 'keep-alive' : '',
    h2Settings,
    priorityUrgency: h % 256,
  };

  domainConnProfileCache.set(domain, { profile, createdAt: now });
  return profile;
}

/**
 * Get the Accept-Encoding header value for a domain.
 * Diversified per-domain to avoid fingerprinting via encoding preference.
 * Uses domain classification to pick realistic encoding for the target site type.
 */
export function getAcceptEncoding(domain: string): string {
  return getConnectionProfile(domain).acceptEncoding;
}

// ==================== WINDOW_UPDATE Frame Generator ====================

/** HTTP/2 default initial window size (RFC 7540 §6.9.2) */
const H2_DEFAULT_INITIAL_WINDOW_SIZE = 65535;

/** Common Chrome WINDOW_UPDATE increment (connection-level, stream 0) */
const CHROME_WINDOW_UPDATE_INCREMENT = 15663105;

/** Maximum jitter applied to WINDOW_UPDATE increment per domain (±1000) */
const WINDOW_UPDATE_JITTER = 1000;

/**
 * Generate a realistic WINDOW_UPDATE frame for the connection preamble sequence.
 *
 * Chrome sends a connection-level WINDOW_UPDATE (stream 0) after SETTINGS_ACK
 * with an increment of ~15663105. This function adds per-domain jitter (±1000)
 * to avoid all connections having the exact same increment value, which is a
 * fingerprinting signal.
 *
 * The initial window size (65535) is the HTTP/2 default per RFC 7540 §6.9.2.
 * The increment represents the additional window the client is granting to
 * the server (Chrome's value is: 2^31 - 1 - 65535 = 15663105 — i.e., maximum
 * connection-level flow control window minus the default).
 *
 * @param domain - Target domain for deterministic per-domain jitter
 * @returns An H2PreambleFrame of type WINDOW_UPDATE to insert after SETTINGS_ACK
 */
export function generateWindowUpdateFrame(domain: string): H2PreambleFrame {
  const h = domainHash(domain);

  // Per-domain deterministic jitter: ±1000 from the Chrome base value
  const jitter = (h % (2 * WINDOW_UPDATE_JITTER + 1)) - WINDOW_UPDATE_JITTER;
  const increment = CHROME_WINDOW_UPDATE_INCREMENT + jitter;

  return {
    type: 'WINDOW_UPDATE',
    delayMs: 0,
    streamId: 0, // Connection-level
    windowIncrement: increment,
  };
}

/**
 * Get the initial HTTP/2 window size for documentation/logging.
 */
export function getH2DefaultWindowSize(): number {
  return H2_DEFAULT_INITIAL_WINDOW_SIZE;
}
