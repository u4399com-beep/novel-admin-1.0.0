/**
 * Content Deduplication with Fingerprinting
 *
 * Prevents re-scraping content that has already been fetched, using:
 *   - Exact hash matching (SHA-256) for identical content
 *   - SimHash for near-duplicate detection (minor edits, whitespace changes)
 *   - Bounded LRU cache (max 10,000 entries)
 *   - SQLite persistence for audit trail
 *
 * Usage:
 *   const dedup = contentDeduplicator;
 *   if (dedup.isDuplicate(url, contentHash)) { skip; }
 *   dedup.recordContent(url, contentHash, { domain, contentLength });
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { logger } from './logger';

const log = logger.child('ContentDedup');

// ==================== SimHash ====================

/**
 * Compute a SimHash fingerprint for near-duplicate detection.
 * Uses token-level hashing with a 64-bit output.
 *
 * SimHash has the property that similar documents produce similar hashes:
 *   - The Hamming distance between two SimHash values correlates with
 *     document dissimilarity
 *   - Typically, Hamming distance <= 3 means near-duplicate
 */
export function computeSimHash(text: string, hashBits: number = 64): bigint {
  // Tokenize: split on whitespace and punctuation, normalize
  const tokens = text
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);

  if (tokens.length === 0) return 0n;

  // Initialize bit vector
  const v = new Int32Array(hashBits);

  for (const token of tokens) {
    // Hash each token
    const hash = tokenHash(token);
    for (let i = 0; i < hashBits; i++) {
      if ((hash >> BigInt(i)) & 1n) {
        v[i]++;
      } else {
        v[i]--;
      }
    }
  }

  // Build SimHash from bit vector
  let fingerprint = 0n;
  for (let i = 0; i < hashBits; i++) {
    if (v[i] > 0) {
      fingerprint |= (1n << BigInt(i));
    }
  }

  return fingerprint;
}

/** Simple deterministic hash for a token string → bigint */
function tokenHash(token: string): bigint {
  let hash = 0n;
  for (let i = 0; i < token.length; i++) {
    hash = ((hash << 5n) - hash + BigInt(token.charCodeAt(i))) & 0xFFFFFFFFFFFFFFFFn;
  }
  return hash;
}

/** Compute Hamming distance between two bigint SimHash values */
export function hammingDistance(a: bigint, b: bigint): number {
  let xor = a ^ b;
  let distance = 0;
  while (xor !== 0n) {
    distance += Number(xor & 1n);
    xor >>= 1n;
  }
  return distance;
}

// ==================== LRU Cache ====================

interface CacheEntry {
  url: string;
  contentHash: string;
  simHash: bigint;
  timestamp: number;
  metadata: ContentMetadata;
}

interface ContentMetadata {
  domain: string;
  contentLength: number;
  wordCount?: number;
  engine?: string;
}

const MAX_CACHE_SIZE = 10_000;
const SIMHASH_THRESHOLD = 3; // Hamming distance <= 3 = near-duplicate

// ==================== ContentDeduplicator ====================

export class ContentDeduplicator {
  /** LRU cache ordered by recency (most recent at end) */
  private cache: Map<string, CacheEntry> = new Map();
  /** Reverse index: content hash → URL for exact match lookup */
  private hashIndex: Map<string, string> = new Map();
  /** SimHash array for near-duplicate search (amortized O(n) but small n) */
  private simHashes: Array<{ url: string; simHash: bigint }> = [];
  /** SQLite-like JSON persistence path */
  private persistPath: string;
  private persistTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.persistPath = resolve(import.meta.dir, 'content-dedup-store.json');
    this.loadPersistedStore();
    // Persist every 5 minutes
    this.persistTimer = setInterval(() => this.persistStore(), 5 * 60_000).unref();
  }

  /**
   * Compute SHA-256 hash for content.
   */
  computeContentHash(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  /**
   * Check if content at a URL is a duplicate (exact or near-duplicate).
   *
   * @param url - The URL being scraped
   * @param contentHash - SHA-256 hash of the content
   * @returns Duplicate info if duplicate found, null otherwise
   */
  isDuplicate(url: string, contentHash: string): {
    type: 'exact' | 'near-duplicate';
    originalUrl: string;
    hammingDistance?: number;
  } | null {
    // 1. Check exact match by content hash
    const existingUrl = this.hashIndex.get(contentHash);
    if (existingUrl && existingUrl !== url) {
      return { type: 'exact', originalUrl: existingUrl };
    }

    // 2. Check if same URL was already scraped with same content
    const cached = this.cache.get(url);
    if (cached && cached.contentHash === contentHash) {
      return { type: 'exact', originalUrl: url };
    }

    // 3. Near-duplicate check via SimHash
    // Compute SimHash for the content (need the actual content - but we only have hash)
    // So we use the cached entry's simHash if available
    if (cached && cached.contentHash !== contentHash) {
      // Content changed at this URL - not a duplicate, it's an update
      return null;
    }

    // Check against all cached SimHashes for near-duplicates
    const cachedEntry = this.cache.get(url);
    if (cachedEntry) {
      const simHash = cachedEntry.simHash;
      for (const entry of this.simHashes) {
        if (entry.url === url) continue;
        const dist = hammingDistance(simHash, entry.simHash);
        if (dist <= SIMHASH_THRESHOLD) {
          return { type: 'near-duplicate', originalUrl: entry.url, hammingDistance: dist };
        }
      }
    }

    return null;
  }

  /**
   * Check if content is duplicate using the full content string.
   * This computes both the exact hash and SimHash for near-duplicate detection.
   */
  isDuplicateContent(url: string, content: string): {
    type: 'exact' | 'near-duplicate';
    originalUrl: string;
    hammingDistance?: number;
    contentHash: string;
  } | null {
    const contentHash = this.computeContentHash(content);
    const simHash = computeSimHash(content);

    // 1. Exact hash match
    const existingUrl = this.hashIndex.get(contentHash);
    if (existingUrl && existingUrl !== url) {
      return { type: 'exact', originalUrl: existingUrl, contentHash };
    }

    // 2. Same URL, same content
    const cached = this.cache.get(url);
    if (cached && cached.contentHash === contentHash) {
      return { type: 'exact', originalUrl: url, contentHash };
    }

    // 3. Near-duplicate via SimHash
    for (const entry of this.simHashes) {
      if (entry.url === url) continue;
      const dist = hammingDistance(simHash, entry.simHash);
      if (dist <= SIMHASH_THRESHOLD) {
        return { type: 'near-duplicate', originalUrl: entry.url, hammingDistance: dist, contentHash };
      }
    }

    return null;
  }

  /**
   * Record that content has been scraped at a URL.
   *
   * @param url - The URL that was scraped
   * @param content - The content (or content hash if content not available)
   * @param metadata - Metadata about the content
   * @param isContentString - If true, `content` is the full content string; if false, it's a hash
   */
  recordContent(
    url: string,
    content: string,
    metadata: ContentMetadata,
    isContentString: boolean = true,
  ): void {
    const contentHash = isContentString
      ? this.computeContentHash(content)
      : content;

    const simHash = isContentString
      ? computeSimHash(content)
      : 0n; // Can't compute SimHash without content

    // Evict oldest entry if at capacity
    if (this.cache.size >= MAX_CACHE_SIZE && !this.cache.has(url)) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        const evicted = this.cache.get(firstKey);
        this.cache.delete(firstKey);
        this.hashIndex.delete(evicted?.contentHash || '');
        // Remove from simHashes array
        const idx = this.simHashes.findIndex(e => e.url === firstKey);
        if (idx >= 0) this.simHashes.splice(idx, 1);
      }
    }

    // Remove old entry for this URL if it exists
    const oldEntry = this.cache.get(url);
    if (oldEntry) {
      this.hashIndex.delete(oldEntry.contentHash);
      const idx = this.simHashes.findIndex(e => e.url === url);
      if (idx >= 0) this.simHashes.splice(idx, 1);
    }

    const entry: CacheEntry = {
      url,
      contentHash,
      simHash,
      timestamp: Date.now(),
      metadata,
    };

    this.cache.set(url, entry);
    this.hashIndex.set(contentHash, url);
    this.simHashes.push({ url, simHash });

    log.debug(`Recorded content fingerprint for ${url} (${contentHash.slice(0, 12)}...)`, {
      hash: contentHash.slice(0, 12),
      length: metadata.contentLength,
    }, metadata.domain);
  }

  /**
   * Get stats about the deduplication cache.
   */
  getStats(): {
    cacheSize: number;
    hashIndexSize: number;
    simHashCount: number;
    hitRate: number;
  } {
    return {
      cacheSize: this.cache.size,
      hashIndexSize: this.hashIndex.size,
      simHashCount: this.simHashes.length,
      hitRate: this.totalChecks > 0 ? this.duplicateHits / this.totalChecks : 0,
    };
  }

  private totalChecks = 0;
  private duplicateHits = 0;

  /**
   * Check and record - combined operation that tracks hit rate.
   * Returns true if duplicate (caller should skip saving).
   */
  checkAndRecord(
    url: string,
    content: string,
    metadata: ContentMetadata,
  ): boolean {
    this.totalChecks++;
    const dup = this.isDuplicateContent(url, content);
    if (dup) {
      this.duplicateHits++;
      log.info(`Duplicate content detected at ${url}: ${dup.type} match with ${dup.originalUrl}`, {
        type: dup.type,
        originalUrl: dup.originalUrl,
        hammingDistance: dup.hammingDistance,
      }, metadata.domain);
      return true;
    }
    this.recordContent(url, content, metadata);
    return false;
  }

  /** Stop periodic persistence and save final state */
  destroy(): void {
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }
    this.persistStore();
  }

  // ---- Persistence ----

  private persistStore(): void {
    try {
      const data: Array<{
        url: string;
        contentHash: string;
        simHash: string;
        timestamp: number;
        metadata: ContentMetadata;
      }> = [];

      for (const [, entry] of this.cache) {
        data.push({
          url: entry.url,
          contentHash: entry.contentHash,
          simHash: entry.simHash.toString(),
          timestamp: entry.timestamp,
          metadata: entry.metadata,
        });
      }

      writeFileSync(this.persistPath, JSON.stringify({ entries: data, version: 1 }, null, 2));
    } catch (err) {
      log.error(`Failed to persist dedup store: ${err instanceof Error ? err.message : err}`);
    }
  }

  private loadPersistedStore(): void {
    try {
      if (!existsSync(this.persistPath)) return;
      const raw = JSON.parse(readFileSync(this.persistPath, 'utf-8'));
      if (!raw?.entries || !Array.isArray(raw.entries)) return;

      const now = Date.now();
      const MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

      for (const entry of raw.entries) {
        if (this.cache.size >= MAX_CACHE_SIZE) break;
        if (!entry.url || !entry.contentHash) continue;
        // Skip entries older than 7 days
        if (now - entry.timestamp > MAX_AGE) continue;

        const simHash = entry.simHash ? BigInt(entry.simHash) : 0n;

        this.cache.set(entry.url, {
          url: entry.url,
          contentHash: entry.contentHash,
          simHash,
          timestamp: entry.timestamp,
          metadata: entry.metadata || { domain: '', contentLength: 0 },
        });
        this.hashIndex.set(entry.contentHash, entry.url);
        this.simHashes.push({ url: entry.url, simHash });
      }

      log.info(`Loaded ${this.cache.size} content dedup entries from disk`);
    } catch (err) {
      log.error(`Failed to load dedup store: ${err instanceof Error ? err.message : err}`);
    }
  }
}

// Singleton
export const contentDeduplicator = new ContentDeduplicator();
