/**
 * Scraping Result Cache
 *
 * Caches scraping results to avoid re-scraping the same content.
 * Uses SQLite for cross-restart persistence with LRU eviction.
 *
 * Features:
 *   - getCachedResult(url, contentHash) — check if we have a fresh result
 *   - setCachedResult(url, contentHash, data) — store result with TTL
 *   - Cache invalidation: by URL pattern, by age, by content change
 *   - Default TTL: 1 hour for list pages, 24 hours for content pages
 *   - Bounded: max 50,000 cached entries, LRU eviction
 *   - Wire into scrapers.ts: check cache before making HTTP request
 */

import { logger } from './logger';
const log = logger.child('ResultCache');

import Database from 'bun:sqlite';
import { resolve } from 'path';

// ==================== Types ====================

export type CachePageType = 'list' | 'detail' | 'chapter_list' | 'chapter_content' | 'other';

export interface CachedResult {
  url: string;
  contentHash: string;
  data: string;           // JSON-serialized result data
  pageType: CachePageType;
  createdAt: number;
  expiresAt: number;
  lastAccessedAt: number;
  accessCount: number;
  contentLength: number;
}

export interface CacheStats {
  totalEntries: number;
  totalSizeBytes: number;
  hitRate: number;
  hits: number;
  misses: number;
  entriesByType: Record<string, number>;
  oldestEntry: number | null;
  newestEntry: number | null;
}

export interface CacheSetOptions {
  pageType?: CachePageType;
  ttlMs?: number;         // Override default TTL
  contentLength?: number;
}

// ==================== Constants ====================

const CACHE_DB_PATH = resolve(import.meta.dir, '../../../db/result-cache.db');

const DEFAULT_TTLS: Record<CachePageType, number> = {
  list: 1 * 60 * 60 * 1000,           // 1 hour for list pages
  detail: 6 * 60 * 60 * 1000,          // 6 hours for detail pages
  chapter_list: 2 * 60 * 60 * 1000,    // 2 hours for chapter lists
  chapter_content: 24 * 60 * 60 * 1000, // 24 hours for content pages
  other: 2 * 60 * 60 * 1000,           // 2 hours default
};

const MAX_CACHE_ENTRIES = 50_000;
const LRU_EVICT_BATCH = 500; // Evict in batches for efficiency
const MAX_CACHED_DATA_SIZE = 2 * 1024 * 1024; // 2MB max per cached result

// ==================== ResultCache ====================

class ResultCache {
  private db: Database;
  private hits = 0;
  private misses = 0;
  private statsInterval: ReturnType<typeof setInterval> | null = null;

  constructor(dbPath?: string) {
    this.db = new Database(dbPath || CACHE_DB_PATH, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.init();

    // Periodic cleanup: remove expired entries every 10 minutes
    this.statsInterval = setInterval(() => {
      try { this.cleanupExpired(); } catch {}
    }, 10 * 60 * 1000).unref();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS result_cache (
        url TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        data TEXT NOT NULL,
        page_type TEXT NOT NULL DEFAULT 'other',
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0,
        content_length INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (url, content_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_rc_expires ON result_cache(expires_at);
      CREATE INDEX IF NOT EXISTS idx_rc_last_accessed ON result_cache(last_accessed_at);
      CREATE INDEX IF NOT EXISTS idx_rc_page_type ON result_cache(page_type);
    `);
  }

  /**
   * Get a cached result if it exists and is not expired.
   * Returns null if no fresh result is found.
   */
  getCachedResult(url: string, contentHash?: string): CachedResult | null {
    const now = Date.now();

    try {
      let row: any;
      if (contentHash) {
        row = this.db.prepare(
          'SELECT * FROM result_cache WHERE url = ? AND content_hash = ? AND expires_at > ? LIMIT 1'
        ).get(url, contentHash, now);
      } else {
        // Get the most recent result for this URL regardless of hash
        row = this.db.prepare(
          'SELECT * FROM result_cache WHERE url = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1'
        ).get(url, now);
      }

      if (!row) {
        this.misses++;
        return null;
      }

      // Update access stats
      this.db.prepare(
        'UPDATE result_cache SET last_accessed_at = ?, access_count = access_count + 1 WHERE url = ? AND content_hash = ?'
      ).run(now, row.url, row.content_hash);

      this.hits++;

      return {
        url: row.url,
        contentHash: row.content_hash,
        data: row.data,
        pageType: row.page_type,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        lastAccessedAt: now,
        accessCount: row.access_count + 1,
        contentLength: row.content_length,
      };
    } catch (err) {
      log.info(`Cache get error: ${err instanceof Error ? err.message : String(err)}`);
      this.misses++;
      return null;
    }
  }

  /**
   * Store a scraping result in the cache.
   * If the entry already exists (same url + hash), it is updated.
   */
  setCachedResult(
    url: string,
    contentHash: string,
    data: string,
    options?: CacheSetOptions,
  ): boolean {
    const pageType = options?.pageType || 'other';
    const ttlMs = options?.ttlMs || DEFAULT_TTLS[pageType];
    const contentLength = options?.contentLength || data.length;
    const now = Date.now();

    // Skip if data is too large
    if (data.length > MAX_CACHED_DATA_SIZE) {
      if (process.env.DEBUG === 'true') {
        log.info(`Cache set skipped: data too large (${data.length} bytes) for ${url.slice(0, 60)}`);
      }
      return false;
    }

    // Enforce max entries — LRU eviction
    this.enforceMaxEntries();

    try {
      const stmt = this.db.prepare(`
        INSERT INTO result_cache (url, content_hash, data, page_type, created_at, expires_at, last_accessed_at, access_count, content_length)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(url, content_hash) DO UPDATE SET
          data = excluded.data,
          page_type = excluded.page_type,
          created_at = excluded.created_at,
          expires_at = excluded.expires_at,
          last_accessed_at = excluded.last_accessed_at,
          content_length = excluded.content_length
      `);
      stmt.run(url, contentHash, data, pageType, now, now + ttlMs, now, contentLength);
      return true;
    } catch (err) {
      log.info(`Cache set error: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Invalidate cache entries by URL pattern.
   * @param pattern - SQL LIKE pattern (e.g., '%/chapter/%')
   */
  invalidateByPattern(pattern: string): number {
    try {
      const result = this.db.prepare(
        'DELETE FROM result_cache WHERE url LIKE ?'
      ).run(pattern);
      return result.changes;
    } catch { return 0; }
  }

  /**
   * Invalidate cache entries older than a given age.
   * @param maxAgeMs - Maximum age in milliseconds
   */
  invalidateByAge(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    try {
      const result = this.db.prepare(
        'DELETE FROM result_cache WHERE created_at < ?'
      ).run(cutoff);
      return result.changes;
    } catch { return 0; }
  }

  /**
   * Invalidate entries where content has changed (different hash for same URL).
   * This removes all but the most recent hash for each URL.
   */
  invalidateStaleHashes(): number {
    try {
      // Delete entries that are not the most recent for their URL
      const result = this.db.exec(`
        DELETE FROM result_cache
        WHERE rowid NOT IN (
          SELECT MAX(rowid)
          FROM result_cache
          GROUP BY url
        )
      `);
      // bun:sqlite exec returns undefined for non-SELECT
      // Use a count approach instead
      const before = this.getEntryCount();
      this.db.exec(`
        DELETE FROM result_cache
        WHERE (url, content_hash) NOT IN (
          SELECT url, content_hash FROM (
            SELECT url, content_hash, MAX(created_at) as max_created
            FROM result_cache
            GROUP BY url
          )
        )
      `);
      const after = this.getEntryCount();
      return before - after;
    } catch { return 0; }
  }

  /**
   * Clear all cache entries.
   */
  clear(): number {
    try {
      const count = this.getEntryCount();
      this.db.exec('DELETE FROM result_cache');
      return count;
    } catch { return 0; }
  }

  /**
   * Clear cache entries for a specific domain.
   */
  clearByDomain(domain: string): number {
    try {
      const result = this.db.prepare(
        "DELETE FROM result_cache WHERE url LIKE ?"
      ).run(`%://${domain}/%`);
      const result2 = this.db.prepare(
        "DELETE FROM result_cache WHERE url LIKE ?"
      ).run(`%://${domain}%`);
      return result.changes + result2.changes;
    } catch { return 0; }
  }

  /**
   * Get cache statistics.
   */
  getStats(): CacheStats {
    try {
      const totalEntries = this.getEntryCount();

      // Entries by page type
      const typeRows = this.db.prepare(
        'SELECT page_type, COUNT(*) as cnt FROM result_cache GROUP BY page_type'
      ).all() as Array<{ page_type: string; cnt: number }>;  
      const entriesByType: Record<string, number> = {};
      let totalSize = 0;
      for (const row of typeRows) {
        entriesByType[row.page_type] = row.cnt;
      }

      // Total size estimate
      const sizeRow = this.db.prepare(
        'SELECT SUM(content_length) as total_size FROM result_cache'
      ).get() as { total_size: number | null } | undefined;  
      totalSize = sizeRow?.total_size || 0;

      // Age range
      const ageRow = this.db.prepare(
        'SELECT MIN(created_at) as oldest, MAX(created_at) as newest FROM result_cache'
      ).get() as { oldest: string | null; newest: string | null } | undefined;  

      const total = this.hits + this.misses;

      return {
        totalEntries,
        totalSizeBytes: totalSize,
        hitRate: total > 0 ? this.hits / total : 0,
        hits: this.hits,
        misses: this.misses,
        entriesByType,
        oldestEntry: ageRow?.oldest || null,
        newestEntry: ageRow?.newest || null,
      };
    } catch {
      return {
        totalEntries: 0,
        totalSizeBytes: 0,
        hitRate: 0,
        hits: this.hits,
        misses: this.misses,
        entriesByType: {},
        oldestEntry: null,
        newestEntry: null,
      };
    }
  }

  // ==================== Private Helpers ====================

  private getEntryCount(): number {
    try {
      const row = this.db.prepare('SELECT COUNT(*) as cnt FROM result_cache').get() as { cnt: number } | undefined;  
      return row?.cnt || 0;
    } catch { return 0; }
  }

  private enforceMaxEntries(): void {
    const count = this.getEntryCount();
    if (count < MAX_CACHE_ENTRIES) return;

    // LRU eviction: remove the least recently accessed entries
    try {
      this.db.prepare(
        'DELETE FROM result_cache WHERE rowid IN (SELECT rowid FROM result_cache ORDER BY last_accessed_at ASC LIMIT ?)'
      ).run(LRU_EVICT_BATCH);

      if (process.env.DEBUG === 'true') {
        log.info(`LRU eviction: removed ${LRU_EVICT_BATCH} entries (was ${count})`);
      }
    } catch {}
  }

  private cleanupExpired(): number {
    try {
      const now = Date.now();
      const result = this.db.prepare('DELETE FROM result_cache WHERE expires_at < ?').run(now);
      if (result.changes > 0) {
        log.info(`Cleaned up ${result.changes} expired cache entries`);
      }
      return result.changes;
    } catch { return 0; }
  }

  destroy(): void {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
    try { this.db.close(); } catch {}
  }
}

// ==================== Singleton ====================

export const resultCache = new ResultCache();

/**
 * Compute a simple hash for cache key.
 * Uses a fast non-cryptographic hash for content dedup.
 */
export function computeContentHash(content: string): string {
  // FNV-1a hash (fast, good distribution)
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
