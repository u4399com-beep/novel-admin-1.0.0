/**
 * Engine Fallback Chain Configuration
 *
 * Allows configuring the engine fallback strategy via:
 *   1. A JSON config file (./engine-config.json relative to cwd)
 *   2. Per-domain overrides via setDomainEngineOverride()
 *   3. Default hardcoded chain as fallback
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
 *   2. Otherwise, return the full set of chains from config file or defaults
 *
 * @param domain - Optional domain for per-domain chain selection
 * @returns The full chain array (global) or a single chain (domain-specific)
 */
export function getEngineFallbackChain(domain?: string): EngineType[][] {
  const globalChains = resolveGlobalChains();

  if (domain) {
    const normalized = domain.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
    const overrideIndex = domainOverrides.get(normalized);
    if (overrideIndex !== undefined && overrideIndex >= 0 && overrideIndex < globalChains.length) {
      return [globalChains[overrideIndex]];
    }
  }

  return globalChains;
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
