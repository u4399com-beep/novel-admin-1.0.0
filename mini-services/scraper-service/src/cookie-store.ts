/**
 * Cookie Store - SQLite-based cookie persistence
 *
 * Provides file-based persistence for cookies using Bun's built-in
 * bun:sqlite module. Cookies survive service restarts.
 */

import Database from 'bun:sqlite';
import type { StoredCookie } from './cookie-jar';
import { resolve } from 'path';

const COOKIE_DB_PATH = resolve(import.meta.dir, '../../../db/cookies.db');

class CookieStore {
  private db: Database;

  constructor(dbPath?: string) {
    this.db = new Database(dbPath || COOKIE_DB_PATH, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cookies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        value TEXT NOT NULL,
        domain TEXT NOT NULL,
        path TEXT NOT NULL DEFAULT '/',
        httpOnly INTEGER NOT NULL DEFAULT 0,
        secure INTEGER NOT NULL DEFAULT 0,
        expires INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cookies_domain ON cookies(domain);
    `);
  }

  /**
   * Batch insert or update cookies for a domain.
   * Uses INSERT OR REPLACE keyed on (name, domain, path).
   */
  upsert(cookies: StoredCookie[], domain: string): void {
    if (!cookies.length) return;
    const now = Math.floor(Date.now() / 1000);
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO cookies (name, value, domain, path, httpOnly, secure, expires, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = this.db.transaction(() => {
      for (const c of cookies) {
        stmt.run(
          c.name,
          c.value,
          c.domain,
          c.path,
          c.httpOnly ? 1 : 0,
          c.secure ? 1 : 0,
          c.expires,
          c.createdAt,
          now,
        );
      }
    });
    tx();
  }

  /** Get all cookies for a domain */
  getByDomain(domain: string): StoredCookie[] {
    const rows = this.db.query<{
      name: string;
      value: string;
      domain: string;
      path: string;
      httpOnly: number;
      secure: number;
      expires: number;
      created_at: number;
    }>('SELECT name, value, domain, path, httpOnly, secure, expires, created_at FROM cookies WHERE domain = ?').all(domain);
    return rows.map(r => ({
      name: r.name,
      value: r.value,
      domain: r.domain,
      path: r.path,
      httpOnly: r.httpOnly === 1,
      secure: r.secure === 1,
      expires: r.expires,
      createdAt: r.created_at,
    }));
  }

  /** Delete all cookies for a domain, return count */
  deleteByDomain(domain: string): number {
    const result = this.db.prepare('DELETE FROM cookies WHERE domain = ?').run(domain);
    return result.changes;
  }

  /** Delete expired cookies (where expires > 0 AND expires < now), return count */
  deleteExpired(): number {
    const now = Math.floor(Date.now() / 1000);
    const result = this.db.prepare('DELETE FROM cookies WHERE expires > 0 AND expires < ?').run(now);
    return result.changes;
  }

  /** Get count per domain */
  getAllStats(): Array<{ domain: string; count: number }> {
    const rows = this.db.query<{ domain: string; count: number }>(
      'SELECT domain, COUNT(*) as count FROM cookies GROUP BY domain'
    ).all();
    return rows;
  }

  /** Export all cookies as JSON string */
  exportAll(): string {
    const rows = this.db.query<{
      name: string;
      value: string;
      domain: string;
      path: string;
      httpOnly: number;
      secure: number;
      expires: number;
      created_at: number;
    }>('SELECT name, value, domain, path, httpOnly, secure, expires, created_at FROM cookies').all();
    const cookies: StoredCookie[] = rows.map(r => ({
      name: r.name,
      value: r.value,
      domain: r.domain,
      path: r.path,
      httpOnly: r.httpOnly === 1,
      secure: r.secure === 1,
      expires: r.expires,
      createdAt: r.created_at,
    }));
    return JSON.stringify(cookies);
  }

  /** Clear all cookies */
  clear(): void {
    this.db.exec('DELETE FROM cookies');
  }
}

export const cookieStore = new CookieStore();
