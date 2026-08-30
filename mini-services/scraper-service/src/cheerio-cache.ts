/**
 * LRU cache for cheerio.load() results.
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
 */

import * as cheerio from 'cheerio';

const MAX_CACHE_SIZE = 50;
const cache = new Map<string, cheerio.CheerioAPI>();

/**
 * Get a cached cheerio.CheerioAPI for the given HTML, or create one if not cached.
 * Uses Bun.hash() of the full HTML for the cache key to eliminate collision risk.
 */
export function getCachedCheerio(html: string): cheerio.CheerioAPI {
  const key = String(Bun.hash(html));
  let cached = cache.get(key);
  if (cached) {
    // Move to end (most recently used)
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  cached = cheerio.load(html);
  if (cache.size >= MAX_CACHE_SIZE) {
    // Delete oldest entry (first key)
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(key, cached);
  return cached;
}

/** Clear the entire cheerio cache */
export function clearCheerioCache(): void {
  cache.clear();
}
