/**
 * Engine Fallback Chain Configuration
 *
 * Allows configuring the engine fallback strategy via:
 *   1. A JSON config file (./engine-config.json relative to cwd)
 *   2. Per-domain overrides via setDomainEngineOverride()
 *   3. Default hardcoded chain as fallback
 *   4. Per-domain engine preference learning (engine-preferences.json)
 *   5. CAPTCHA-triggered permanent engine upgrade (in-memory, 1h TTL)
 *   6. Content-length based engine hint (low-content → skip cheerio)
 */

import { existsSync, statSync, readFileSync } from 'fs';
import { resolve } from 'path';
import type { EngineType } from './types';

// ==================== Types ====================

/** Shape of the JSON config file */
interface EngineConfigFile {
  fallbackChains?: EngineType[][];
}

// ==================== Defaults ====================

/** Default hardcoded fallback chain (kept for reference and fallback) */
export const DEFAULT_ENGINE_FALLBACK_CHAIN: EngineType[][] = [
  // Strategy A: start cheap, escalate to stealth
  ['cheerio', 'playwright', 'obscura'],
  // Strategy B: start with JS rendering, fall back to stealth
  ['playwright', 'obscura', 'cheerio'],
  // Strategy C: start with stealth, fall back to JS then cheap
  ['obscura', 'playwright', 'cheerio'],
];

/** All valid internal engine types that can participate in a fallback chain */
const VALID_CHAIN_ENGINES = new Set<string>(['cheerio', 'playwright', 'obscura']);

/** Internal engine hierarchy for CAPTCHA upgrade path: cheerio → playwright → obscura */
const CAPTCHA_UPGRADE_MAP: Record<string, EngineType> = {
  'cheerio': 'playwright',
  'playwright': 'obscura',
};

/** Content length threshold (chars) below which cheerio result is considered "low content" */
const LOW_CONTENT_THRESHOLD = 500;

// ==================== Config File Cache ====================

interface CachedConfig {
  chains: EngineType[][];
  mtime: number | null;
}

const CONFIG_FILE_PATH = resolve(process.cwd(), 'engine-config.json');
let cachedConfig: CachedConfig | null = null;

// ==================== Validation ====================

/**
 * Validate a single fallback chain array.
 * Returns the validated chain or null if invalid.
 */
function validateChain(chain: unknown[]): EngineType[] | null {
  if (!Array.isArray(chain) || chain.length === 0) return null;

  const seen = new Set<string>();
  const result: EngineType[] = [];

  for (const entry of chain) {
    if (typeof entry !== 'string') return null;
    if (!VALID_CHAIN_ENGINES.has(entry)) return null;
    if (seen.has(entry)) return null; // no duplicates
    seen.add(entry);
    result.push(entry as EngineType);
  }

  // First entry must be a valid engine (already checked above via VALID_CHAIN_ENGINES)
  return result;
}

/**
 * Validate the full config file structure.
 * Returns the validated chains array, or null if the config is invalid.
 */
function validateConfigFile(data: unknown): EngineType[][] | null {
  if (!data || typeof data !== 'object') return null;

  const config = data as EngineConfigFile;
  if (!Array.isArray(config.fallbackChains) || config.fallbackChains.length === 0) {
    return null;
  }

  const validatedChains: EngineType[][] = [];
  for (const chain of config.fallbackChains) {
    const validated = validateChain(chain);
    if (!validated) {
      // If any chain is invalid, reject the entire config
      console.warn(
        `[engine-config] Invalid chain in config file, falling back to defaults:`,
        JSON.stringify(chain)
      );
      return null;
    }
    validatedChains.push(validated);
  }

  return validatedChains;
}

// ==================== Config File Reader ====================

/**
 * Attempt to read and parse the engine config file.
 * Returns null if the file doesn't exist or can't be parsed.
 */
function readConfigFile(): { chains: EngineType[][]; mtime: number | null } | null {
  try {
    if (!existsSync(CONFIG_FILE_PATH)) return null;

    const stat = statSync(CONFIG_FILE_PATH);
    const mtime = stat.mtimeMs;

    // Check cache: re-read only if mtime changed
    if (cachedConfig && cachedConfig.mtime === mtime) {
      return { chains: cachedConfig.chains, mtime };
    }

    const raw = readFileSync(CONFIG_FILE_PATH, 'utf-8');
    const data = JSON.parse(raw);
    const chains = validateConfigFile(data);

    if (!chains) return null;

    cachedConfig = { chains, mtime };
    return { chains, mtime };
  } catch (err) {
    console.warn(
      `[engine-config] Failed to read/parse ${CONFIG_FILE_PATH}:`,
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

// ==================== Domain Overrides ====================

/** Map of normalized domain -> index into the global fallback chain array */
const domainOverrides = new Map<string, number>();

/**
 * Set a domain-specific engine fallback chain override.
 * @param domain     - The domain to override (e.g., 'example.com')
 * @param chainIndex - Index into the global fallback chains array to use for this domain
 */
export function setDomainEngineOverride(domain: string, chainIndex: number): void {
  const normalized = domain.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  domainOverrides.set(normalized, chainIndex);
}

/**
 * Remove a domain-specific engine override.
 * @param domain - The domain to remove the override for
 */
export function removeDomainEngineOverride(domain: string): void {
  const normalized = domain.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  domainOverrides.delete(normalized);
}

/**
 * Get all domain overrides (for debugging/monitoring).
 */
export function getDomainEngineOverrides(): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [domain, idx] of domainOverrides.entries()) {
    result[domain] = idx;
  }
  return result;
}

// ==================== Main API ====================

/**
 * Get the engine fallback chains.
 *
 * Priority:
 *   1. If `domain` is provided and has a domain override, return that specific chain
 *   2. If a domain has per-engine preference learning data, reorder the chain accordingly
 *   3. If a domain has a CAPTCHA-triggered upgrade, reorder to start with upgraded engine
 *   4. If a domain has a low-content hint, skip cheerio (start with playwright)
 *   5. Otherwise, return the full set of chains from config file or defaults
 *
 * @param domain - Optional domain for per-domain chain selection
 * @returns The full chain array (global) or a single chain (domain-specific)
 */
export function getEngineFallbackChain(domain?: string): EngineType[][] {
  const globalChains = resolveGlobalChains();

  if (domain) {
    const normalized = domain.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');

    // 1. Check explicit domain override (index-based selection from global chains)
    const overrideIndex = domainOverrides.get(normalized);
    if (overrideIndex !== undefined && overrideIndex >= 0 && overrideIndex < globalChains.length) {
      let chain = [...globalChains[overrideIndex]];
      chain = applyDomainEnhancements(chain, normalized);
      return [chain];
    }

    // 2. If domain has any enhancements (preferences, CAPTCHA upgrade, low-content hint),
    //    apply them to the first (default) chain and return that single chain
    if (hasDomainEnhancements(normalized)) {
      let chain = [...globalChains[0]];
      chain = applyDomainEnhancements(chain, normalized);
      return [chain];
    }
  }

  return globalChains;
}

/**
 * Check whether a domain has any registered enhancements
 * (preferences, CAPTCHA upgrade, or low-content hint).
 */
function hasDomainEnhancements(normalizedDomain: string): boolean {
  if (getCaptchaUpgradedEngine(normalizedDomain)) return true;
  if (isLowContentDomain(normalizedDomain)) return true;
  const prefs = readEnginePreferences();
  if (prefs && prefs[normalizedDomain]) return true;
  return false;
}

/**
 * Apply all domain-level enhancements to a chain (in priority order):
 *   1. CAPTCHA-triggered upgrade (highest priority)
 *   2. Low-content hint (skip cheerio)
 *   3. Per-domain preference learning (preferred/avoid reordering)
 */
function applyDomainEnhancements(chain: EngineType[], normalizedDomain: string): EngineType[] {
  // 1. CAPTCHA upgrade: move upgraded engine to front
  const captchaEngine = getCaptchaUpgradedEngine(normalizedDomain);
  if (captchaEngine && chain.includes(captchaEngine)) {
    const idx = chain.indexOf(captchaEngine);
    chain.splice(idx, 1);
    chain.unshift(captchaEngine);
  }

  // 2. Low-content hint — deprioritize cheerio for JS-required domains
  if (isLowContentDomain(normalizedDomain)) {
    const idx = chain.indexOf('cheerio');
    if (idx >= 0 && idx < chain.length - 1) { chain.splice(idx, 1); chain.push('cheerio'); }
  }

  // 3. Per-domain preference learning from engine-preferences.json
  const prefs = readEnginePreferences();
  if (prefs) {
    const pref = prefs[normalizedDomain];
    if (pref) {
      chain = applyPreferenceToChain(chain, pref);
    }
  }

  return chain;
}

/**
 * Reorder a chain based on domain preferences.
 * - "preferred" engine is moved to front (if present in chain)
 * - "avoid" engines are moved to end (if present in chain)
 */
function applyPreferenceToChain(chain: EngineType[], pref: { preferred?: string; avoid?: string[] }): EngineType[] {
  const result = [...chain];

  // Move preferred engine to front
  if (pref.preferred && VALID_CHAIN_ENGINES.has(pref.preferred)) {
    const prefEngine = pref.preferred as EngineType;
    const idx = result.indexOf(prefEngine);
    if (idx > 0) {
      result.splice(idx, 1);
      result.unshift(prefEngine);
    }
  }

  // Move avoided engines to end
  if (Array.isArray(pref.avoid) && pref.avoid.length > 0) {
    const validAvoid = pref.avoid.filter((e): e is EngineType => VALID_CHAIN_ENGINES.has(e));
    for (const avoidEngine of validAvoid) {
      const idx = result.indexOf(avoidEngine);
      if (idx >= 0 && idx < result.length - 1) {
        result.splice(idx, 1);
        result.push(avoidEngine);
      }
    }
  }

  return result;
}

/**
 * Resolve the global fallback chains (from config file or defaults).
 * Cached by file mtime.
 */
function resolveGlobalChains(): EngineType[][] {
  const fileResult = readConfigFile();
  if (fileResult) {
    return fileResult.chains;
  }
  return DEFAULT_ENGINE_FALLBACK_CHAIN;
}

// ==================== Per-Domain Engine Preference Learning ====================

/** Shape of the engine-preferences.json file */
interface DomainEnginePreference {
  preferred?: string;
  avoid?: string[];
}

type EnginePreferencesMap = Record<string, DomainEnginePreference>;

/** Path to the engine preferences JSON config */
const ENGINE_PREFS_PATH = resolve(import.meta.dir, 'scrape-rules/engine-preferences.json');

interface CachedPreferences {
  prefs: EnginePreferencesMap;
  mtime: number | null;
}

let cachedPreferences: CachedPreferences | null = null;

/**
 * Read and cache the engine-preferences.json file.
 * Returns null if the file doesn't exist or can't be parsed.
 * Cached by file mtime (same pattern as readConfigFile).
 */
function readEnginePreferences(): EnginePreferencesMap | null {
  try {
    if (!existsSync(ENGINE_PREFS_PATH)) return null;

    const stat = statSync(ENGINE_PREFS_PATH);
    const mtime = stat.mtimeMs;

    // Check cache: re-read only if mtime changed
    if (cachedPreferences && cachedPreferences.mtime === mtime) {
      return cachedPreferences.prefs;
    }

    const raw = readFileSync(ENGINE_PREFS_PATH, 'utf-8');
    const data = JSON.parse(raw) as EnginePreferencesMap;

    // Basic validation: must be a non-null object
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      console.warn(`[engine-config] Invalid engine-preferences.json structure, ignoring`);
      return null;
    }

    cachedPreferences = { prefs: data, mtime };
    return data;
  } catch (err) {
    console.warn(
      `[engine-config] Failed to read/parse ${ENGINE_PREFS_PATH}:`,
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

// ==================== CAPTCHA-Triggered Permanent Engine Upgrade ====================

/**
 * In-memory map of domain -> upgraded engine with 1-hour TTL.
 * When CAPTCHA is detected on an engine, the domain is upgraded to the next
 * engine in the hierarchy (cheerio → playwright → obscura) for all future requests.
 */
const captchaUpgradeMap = new Map<string, { engine: EngineType; timestamp: number }>();
const CAPTCHA_UPGRADE_TTL_MS = 60 * 60 * 1000; // 1 hour
const CAPTCHA_UPGRADE_MAX_ENTRIES = 200;

/**
 * Record a CAPTCHA-triggered engine upgrade for a domain.
 * When called, the domain will be upgraded to the next engine in the
 * CAPTCHA hierarchy for the duration of the TTL.
 *
 * @param domain       - The normalized domain
 * @param failedEngine - The engine that triggered the CAPTCHA
 * @returns The upgraded engine type, or undefined if no upgrade available (e.g., obscura is already highest)
 */
export function recordCaptchaUpgrade(domain: string, failedEngine: EngineType): EngineType | undefined {
  const normalized = domain.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  const upgradedEngine = CAPTCHA_UPGRADE_MAP[failedEngine];

  if (!upgradedEngine) {
    // Already at highest engine (e.g., obscura) — no further upgrade
    return undefined;
  }

  // LRU eviction if at capacity and domain not already tracked
  if (captchaUpgradeMap.size >= CAPTCHA_UPGRADE_MAX_ENTRIES && !captchaUpgradeMap.has(normalized)) {
    const oldestKey = captchaUpgradeMap.keys().next().value;
    if (oldestKey !== undefined) {
      captchaUpgradeMap.delete(oldestKey);
    }
  }

  captchaUpgradeMap.set(normalized, { engine: upgradedEngine, timestamp: Date.now() });
  console.log(`[engine-config] CAPTCHA upgrade: ${normalized} → ${upgradedEngine} (from ${failedEngine})`);
  return upgradedEngine;
}

/**
 * Get the CAPTCHA-upgraded engine for a domain (if within TTL).
 * Returns undefined if no upgrade is active or if the TTL has expired.
 */
function getCaptchaUpgradedEngine(normalizedDomain: string): EngineType | undefined {
  const entry = captchaUpgradeMap.get(normalizedDomain);
  if (!entry) return undefined;

  const now = Date.now();
  if (now - entry.timestamp > CAPTCHA_UPGRADE_TTL_MS) {
    captchaUpgradeMap.delete(normalizedDomain);
    return undefined;
  }

  return entry.engine;
}

/**
 * Get all active CAPTCHA upgrades (for debugging/monitoring).
 */
export function getCaptchaUpgrades(): Record<string, { engine: EngineType; remainingMs: number }> {
  const now = Date.now();
  const result: Record<string, { engine: EngineType; remainingMs: number }> = {};
  for (const [domain, entry] of captchaUpgradeMap.entries()) {
    const remaining = CAPTCHA_UPGRADE_TTL_MS - (now - entry.timestamp);
    if (remaining > 0) {
      result[domain] = { engine: entry.engine, remainingMs: remaining };
    } else {
      captchaUpgradeMap.delete(domain);
    }
  }
  return result;
}

// ==================== Content-Length Based Engine Hint ====================

/**
 * Domains flagged as needing JS rendering due to low content from cheerio.
 * When cheerio returns < LOW_CONTENT_THRESHOLD chars with status 200,
 * the domain is added here so future requests skip cheerio.
 *
 * Uses same 30-minute TTL concept as domain engine success history in engines.ts.
 */
const lowContentDomains = new Map<string, number>(); // domain -> timestamp
const LOW_CONTENT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const LOW_CONTENT_MAX_ENTRIES = 100;

/**
 * Record that a domain returned very low content from cheerio,
 * suggesting it likely needs JS rendering.
 *
 * @param domain - The domain to flag
 * @param contentLength - The actual content length in characters
 */
export function recordLowContentHint(domain: string, contentLength: number): void {
  if (contentLength >= LOW_CONTENT_THRESHOLD) return; // Only flag truly low content

  const normalized = domain.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');

  // LRU eviction if at capacity
  if (lowContentDomains.size >= LOW_CONTENT_MAX_ENTRIES && !lowContentDomains.has(normalized)) {
    const oldestKey = lowContentDomains.keys().next().value;
    if (oldestKey !== undefined) {
      lowContentDomains.delete(oldestKey);
    }
  }

  lowContentDomains.set(normalized, Date.now());
  console.log(`[engine-config] Low-content hint: ${normalized} (${contentLength} chars < ${LOW_CONTENT_THRESHOLD}), will skip cheerio`);
}

/**
 * Check if a domain is flagged as needing JS rendering due to low content.
 * Exported for use in engines.ts integration.
 */
export function isLowContentDomain(domain: string): boolean {
  const normalized = domain.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  const ts = lowContentDomains.get(normalized);
  if (!ts) return false;

  const now = Date.now();
  if (now - ts > LOW_CONTENT_TTL_MS) {
    lowContentDomains.delete(normalized);
    return false;
  }

  return true;
}

/**
 * Get all low-content domain flags (for debugging/monitoring).
 */
export function getLowContentDomains(): Record<string, number> {
  const now = Date.now();
  const result: Record<string, number> = {};
  for (const [domain, ts] of lowContentDomains.entries()) {
    const remaining = LOW_CONTENT_TTL_MS - (now - ts);
    if (remaining > 0) {
      result[domain] = remaining;
    } else {
      lowContentDomains.delete(domain);
    }
  }
  return result;
}
