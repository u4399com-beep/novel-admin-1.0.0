/**
 * LRU cache for cheerio.load() results with size-based eviction,
 * cache warming, invalidation on rule changes, and compressed storage.
 *
 * When the same HTML is parsed multiple times across different selector
 * functions (parseSelector, parseSelectorHtml, parseSelectorMulti,
 * extractLinksFromList, extractMetadataFallback), reusing the parsed
 * CheerioAPI object avoids redundant DOM construction.
 *
 * IMPORTANT: Only use getCachedCheerio() when the $ object will be used
 * for READ-ONLY operations (.text(), .attr(), .find(), .html() without args).
 * For write operations (.remove(), .html(newContent), etc.), use direct
 * cheerio.load() to avoid cache pollution.
 *
 * Features:
 *   - LRU eviction with size-based limits (max entries + max total bytes)
 *   - Cache warming for frequently accessed pages
 *   - Cache invalidation on rule changes
 *   - Compressed storage for large documents (using Bun's built-in compression)
 */

import * as cheerio from 'cheerio';

// ==================== Types ====================

interface CacheEntry {
  key: string;
  $: cheerio.CheerioAPI;
  htmlHash: string;
  htmlSize: number;
  compressedData?: Uint8Array;
  isCompressed: boolean;
  lastAccessTime: number;
  accessCount: number;
  /** Rule generation that created this entry (for invalidation) */
  ruleGeneration?: number;
}

// ==================== Constants ====================

const MAX_CACHE_SIZE = 50;
const MAX_CACHE_BYTES = 50 * 1024 * 1024; // 50MB total cache
const COMPRESSION_THRESHOLD = 50_000; // Compress HTML > 50KB
const WARM_ACCESS_THRESHOLD = 3; // Access count to be considered "warm"

// ==================== Cache State ====================

const cache = new Map<string, CacheEntry>();
let totalCacheBytes = 0;
let currentRuleGeneration = 0;

// ==================== Compression ====================

/**
 * Compress HTML string using Bun's built-in zlib.
 * Falls back to storing uncompressed if compression doesn't help.
 */
function compressHtml(html: string): { data: Uint8Array; ratio: number } | null {
  if (html.length < COMPRESSION_THRESHOLD) return null;

  try {
    // Use Bun's built-in compression if available
    if (typeof Bun !== 'undefined' && Bun.deflateSync) {
      const input = new TextEncoder().encode(html);
      const compressed = Bun.deflateSync(input);
      const ratio = compressed.length / input.length;
      // Only use compression if it saves > 30%
      if (ratio < 0.7) {
        return { data: compressed, ratio };
      }
    }
  } catch {
    // Compression failed, store uncompressed
  }

  return null;
}

/**
 * Decompress data back to HTML string.
 */
function decompressHtml(data: Uint8Array): string {
  try {
    if (typeof Bun !== 'undefined' && Bun.inflateSync) {
      const decompressed = Bun.inflateSync(data);
      return new TextDecoder().decode(decompressed);
    }
  } catch {
    // Decompression failed
  }
  return '';
}

// ==================== Main Cache Functions ====================

/**
 * Get a cached cheerio.CheerioAPI for the given HTML, or create one if not cached.
 * Uses Bun.hash() of the full HTML for the cache key to eliminate collision risk.
 */
export function getCachedCheerio(html: string): cheerio.CheerioAPI {
  const key = String(Bun.hash(html));
  let entry = cache.get(key);

  if (entry) {
    // Move to end (most recently used) - Map preserves insertion order
    cache.delete(key);
    cache.set(key, entry);
    entry.lastAccessTime = Date.now();
    entry.accessCount++;

    // If entry was compressed and CheerioAPI was evicted, rebuild it
    if (entry.isCompressed && entry.compressedData) {
      const decompressed = decompressHtml(entry.compressedData);
      if (decompressed) {
        entry.$ = cheerio.load(decompressed);
        entry.isCompressed = false;
        // Keep compressedData for potential re-eviction
      }
    }

    return entry.$;
  }

  // Parse and create entry
  const $ = cheerio.load(html);
  const htmlHash = key;
  const htmlSize = html.length;

  // Try compression for large HTML
  const compressed = compressHtml(html);
  const isCompressed = compressed !== null;

  entry = {
    key,
    $,
    htmlHash,
    htmlSize,
    compressedData: compressed?.data,
    isCompressed,
    lastAccessTime: Date.now(),
    accessCount: 1,
    ruleGeneration: currentRuleGeneration,
  };

  // Evict if necessary
  evictIfNeeded(htmlSize);

  cache.set(key, entry);
  totalCacheBytes += htmlSize;

  return $;
}

/**
 * Evict entries using LRU + size-based policy.
 * Evicts oldest entries first, or entries that exceed size budget.
 */
function evictIfNeeded(incomingSize: number): void {
  // Evict by count
  while (cache.size >= MAX_CACHE_SIZE) {
    evictOldest();
  }

  // Evict by total size
  while (totalCacheBytes + incomingSize > MAX_CACHE_BYTES && cache.size > 0) {
    evictOldest();
  }
}

/**
 * Evict the oldest (least recently used) entry.
 * For entries with compressed data, keep compressed form but drop CheerioAPI.
 */
function evictOldest(): void {
  const firstKey = cache.keys().next().value;
  if (firstKey === undefined) return;

  const entry = cache.get(firstKey);
  if (!entry) return;

  // If entry has compressed data, we can keep it in compressed form
  // (just drop the CheerioAPI object to free memory)
  if (entry.compressedData && entry.accessCount >= WARM_ACCESS_THRESHOLD) {
    // Keep compressed form for warm entries
    entry.isCompressed = true;
    // Note: We can't easily "drop" the $ reference in JS due to GC,
    // but marking as compressed helps on re-access
    totalCacheBytes -= entry.htmlSize;
    totalCacheBytes += entry.compressedData.length;
    // Move to end so it's not immediately evicted again
    cache.delete(firstKey);
    cache.set(firstKey, entry);
    return;
  }

  // Full eviction
  totalCacheBytes -= entry.htmlSize;
  cache.delete(firstKey);
}

// ==================== Cache Warming ====================

/**
 * Warm the cache by pre-loading HTML that is frequently accessed.
 * Call this for URLs/pages that are known to be accessed repeatedly.
 */
export function warmCache(htmlItems: Array<{ html: string; priority?: boolean }>): void {
  for (const { html, priority } of htmlItems) {
    const key = String(Bun.hash(html));
    if (cache.has(key)) continue; // Already cached

    if (priority) {
      // High-priority: always warm, even if eviction needed
      const $ = cheerio.load(html);
      const compressed = compressHtml(html);
      const entry: CacheEntry = {
        key,
        $,
        htmlHash: key,
        htmlSize: html.length,
        compressedData: compressed?.data,
        isCompressed: compressed !== null,
        lastAccessTime: Date.now(),
        accessCount: 1, // Mark as pre-warmed
        ruleGeneration: currentRuleGeneration,
      };
      evictIfNeeded(html.length);
      cache.set(key, entry);
      totalCacheBytes += html.length;
    } else {
      // Normal priority: only warm if cache has room
      if (cache.size < MAX_CACHE_SIZE && totalCacheBytes + html.length <= MAX_CACHE_BYTES) {
        const $ = cheerio.load(html);
        const entry: CacheEntry = {
          key,
          $,
          htmlHash: key,
          htmlSize: html.length,
          isCompressed: false,
          lastAccessTime: Date.now(),
          accessCount: 0,
          ruleGeneration: currentRuleGeneration,
        };
        cache.set(key, entry);
        totalCacheBytes += html.length;
      }
    }
  }
}

// ==================== Cache Invalidation ====================

/**
 * Increment the rule generation counter.
 * Entries from previous generations will be gradually evicted.
 */
export function incrementRuleGeneration(): void {
  currentRuleGeneration++;
}

/**
 * Invalidate cache entries that were created before the current rule generation.
 * Call this after rule changes to ensure stale parsed DOMs are not used.
 */
export function invalidateStaleEntries(): void {
  const keysToDelete: string[] = [];

  for (const [key, entry] of cache) {
    if (entry.ruleGeneration !== undefined && entry.ruleGeneration < currentRuleGeneration) {
      keysToDelete.push(key);
    }
  }

  for (const key of keysToDelete) {
    const entry = cache.get(key);
    if (entry) {
      totalCacheBytes -= entry.htmlSize;
      cache.delete(key);
    }
  }
}

// ==================== Cache Management ====================

/** Clear the entire cheerio cache */
export function clearCheerioCache(): void {
  cache.clear();
  totalCacheBytes = 0;
}

/** Get cache statistics */
export function getCacheStats(): {
  size: number;
  totalBytes: number;
  maxBytes: number;
  maxEntries: number;
  compressedEntries: number;
  warmEntries: number;
  hitRate: number;
} {
  let compressedCount = 0;
  let warmCount = 0;
  let totalAccesses = 0;

  for (const entry of cache.values()) {
    if (entry.isCompressed) compressedCount++;
    if (entry.accessCount >= WARM_ACCESS_THRESHOLD) warmCount++;
    totalAccesses += entry.accessCount;
  }

  return {
    size: cache.size,
    totalBytes: totalCacheBytes,
    maxBytes: MAX_CACHE_BYTES,
    maxEntries: MAX_CACHE_SIZE,
    compressedEntries: compressedCount,
    warmEntries: warmCount,
    hitRate: cache.size > 0 ? (totalAccesses - cache.size) / totalAccesses : 0,
  };
}
