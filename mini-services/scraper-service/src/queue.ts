/**
 * Request Queue with SQLite Persistence
 * Enables resume-capable crawling with deduplication.
 * Uses a dedicated task_id column (not LIKE on JSON) for performance and safety.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { generateId } from "./utils";
import type { QueueItem } from "./types";

const DB_PATH = process.env.QUEUE_DB_PATH || "/app/data/scraper-queue.db";

let db: Database | null = null;

function getDB(): Database {
  if (db) return db;

  // Ensure parent directory exists
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  db = new Database(DB_PATH, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS request_queue (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT 'GET',
      payload TEXT,
      retries INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      task_id TEXT NOT NULL DEFAULT '__default__',
      metadata TEXT
    )
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_queue_status ON request_queue(status)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_queue_url ON request_queue(url)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_queue_task_id ON request_queue(task_id)");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_task_url ON request_queue(task_id, url, status)");

  return db;
}

// ==================== Queue Operations ====================

export interface AddToQueueOptions {
  url: string;
  method?: string;
  payload?: unknown;
  maxRetries?: number;
  metadata?: Record<string, unknown>;
  taskId?: string;
}

/**
 * Add a URL to the queue. Returns the queue item ID.
 * Deduplicates by URL + task_id (exact match, no LIKE injection risk).
 */
export function addToQueue(options: AddToQueueOptions): string {
  const database = getDB();
  const id = generateId();
  const now = new Date().toISOString();
  const taskId = options.taskId || "__default__";

  // Use INSERT OR IGNORE for atomic dedup
  try {
    database.query(`
      INSERT OR IGNORE INTO request_queue (id, url, method, payload, retries, max_retries, status, created_at, updated_at, task_id, metadata)
      VALUES (?, ?, ?, ?, 0, ?, 'pending', ?, ?, ?, ?)
    `).run(
      id,
      options.url,
      options.method || "GET",
      options.payload ? JSON.stringify(options.payload) : null,
      options.maxRetries || 3,
      now,
      now,
      taskId,
      options.metadata ? JSON.stringify(options.metadata) : null,
    );
  } catch {
    // Unique constraint violation → URL already queued for this task
    // Find existing ID
    const existing = database.query(
      "SELECT id FROM request_queue WHERE url = ? AND task_id = ? AND status != 'failed' LIMIT 1"
    ).get(options.url, taskId) as { id: string } | undefined;
    if (existing) return existing.id;
  }

  return id;
}

/**
 * Add multiple URLs to the queue (batched in a transaction).
 */
export function addManyToQueue(items: AddToQueueOptions[]): string[] {
  const database = getDB();
  const ids: string[] = [];

  const insert = database.transaction(() => {
    for (const item of items) {
      ids.push(addToQueue(item));
    }
  });

  insert();
  return ids;
}

// ==================== Fetch from Queue ====================

export interface DequeueResult {
  id: string;
  url: string;
  method: string;
  payload: unknown;
  metadata: Record<string, unknown> | null;
}

/**
 * Get the next pending item from the queue for a given task.
 * Uses exact task_id match (no LIKE) for performance and security.
 */
export function dequeue(taskId?: string): DequeueResult | null {
  const database = getDB();
  const now = new Date().toISOString();

  const row = database.query(`
    SELECT id, url, method, payload, metadata
    FROM request_queue
    WHERE status = 'pending' ${taskId ? 'AND task_id = ?' : ''}
    ORDER BY created_at ASC
    LIMIT 1
  `).get(...(taskId ? [taskId] : [])) as {
    id: string;
    url: string;
    method: string;
    payload: string | null;
    metadata: string | null;
  } | undefined;

  if (!row) return null;

  // Mark as in_progress
  database.query(`
    UPDATE request_queue SET status = 'in_progress', updated_at = ? WHERE id = ?
  `).run(now, row.id);

  return {
    id: row.id,
    url: row.url,
    method: row.method,
    payload: row.payload ? JSON.parse(row.payload) : null,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  };
}

/**
 * Get multiple pending items from the queue (batch dequeue).
 */
export function dequeueBatch(taskId?: string, limit: number = 10): DequeueResult[] {
  const results: DequeueResult[] = [];
  for (let i = 0; i < limit; i++) {
    const item = dequeue(taskId);
    if (!item) break;
    results.push(item);
  }
  return results;
}

// ==================== Update Queue Item ====================

export function markCompleted(id: string): void {
  const database = getDB();
  const now = new Date().toISOString();
  database.query(`
    UPDATE request_queue SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?
  `).run(now, now, id);
}

export function markFailed(id: string, error: string): void {
  const database = getDB();
  const now = new Date().toISOString();

  const row = database.query(
    "SELECT retries, max_retries FROM request_queue WHERE id = ?"
  ).get(id) as { retries: number; max_retries: number } | undefined;

  if (!row) return;

  if (row.retries < row.max_retries) {
    database.query(`
      UPDATE request_queue
      SET status = 'pending', retries = retries + 1, error = ?, updated_at = ?
      WHERE id = ?
    `).run(error, now, id);
  } else {
    database.query(`
      UPDATE request_queue
      SET status = 'failed', error = ?, updated_at = ?, completed_at = ?
      WHERE id = ?
    `).run(error, now, now, id);
  }
}

// ==================== Queue Stats ====================

export interface QueueStats {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
}

export function getQueueStats(taskId?: string): QueueStats {
  const database = getDB();

  const row = database.query(`
    SELECT
      COUNT(*) as total,
      COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) as pending,
      COALESCE(SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END), 0) as inProgress,
      COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) as completed,
      COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed
    FROM request_queue
    ${taskId ? 'WHERE task_id = ?' : ''}
  `).get(...(taskId ? [taskId] : [])) as QueueStats;

  return row;
}

/**
 * Requeue failed items (reset to pending for retry).
 */
export function requeueFailed(taskId?: string): number {
  const database = getDB();
  const now = new Date().toISOString();

  const result = database.query(`
    UPDATE request_queue
    SET status = 'pending', retries = 0, error = NULL, updated_at = ?
    WHERE status = 'failed' ${taskId ? 'AND task_id = ?' : ''}
  `).run(...(taskId ? [now, taskId] : [now]));

  return result.changes;
}

/**
 * Clear completed/failed items older than a given number of hours.
 */
export function cleanupQueue(olderThanHours: number = 24): number {
  const database = getDB();
  const cutoff = new Date(Date.now() - olderThanHours * 3600000).toISOString();

  const result = database.query(`
    DELETE FROM request_queue
    WHERE status IN ('completed', 'failed')
    AND updated_at < ?
  `).run(cutoff);

  return result.changes;
}

/**
 * Clear all queue items for a specific task (exact match).
 */
export function clearTaskQueue(taskId: string): void {
  const database = getDB();
  database.query("DELETE FROM request_queue WHERE task_id = ?").run(taskId);
}

/**
 * Check if a URL has already been queued/completed for a task.
 */
export function isUrlProcessed(url: string, taskId?: string): boolean {
  const database = getDB();

  const row = database.query(`
    SELECT id FROM request_queue
    WHERE url = ? ${taskId ? 'AND task_id = ?' : ''} AND status IN ('completed', 'in_progress')
    LIMIT 1
  `).get(...(taskId ? [url, taskId] : [url]));

  return !!row;
}