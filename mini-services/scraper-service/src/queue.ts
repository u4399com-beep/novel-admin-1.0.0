/**
 * Request Queue - Audit log for scraping tasks.
 *
 * Items are written for observability and deduplication tracking.
 * Note: Items are NOT consumed for processing — the task engine processes
 * URLs from in-memory arrays. Resume after crash is not supported;
 * crashed tasks are marked as failed on restart via recoverStaleTasks().
 */

import Database from 'bun:sqlite';
import { generateId } from "./utils";

const DB_PATH = process.env.QUEUE_DB_PATH || "queue.db";

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;

  db = new Database(DB_PATH, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");

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

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_queue_status ON request_queue(status)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_queue_url ON request_queue(url)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_queue_task_id ON request_queue(task_id)
  `);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_task_url ON request_queue(task_id, url, status)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_queue_status_updated ON request_queue(status, updated_at)
  `);

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
  const d = getDb();
  const id = generateId();
  const taskId = options.taskId || "__default__";

  try {
    const insert = d.prepare(`
      INSERT OR IGNORE INTO request_queue (id, url, method, payload, retries, max_retries, status, created_at, updated_at, task_id, metadata)
      VALUES ($1, $2, $3, $4, 0, $5, 'pending', datetime('now'), datetime('now'), $6, $7)
    `);
    insert.run(id, options.url, options.method || "GET", options.payload ? JSON.stringify(options.payload) : null, options.maxRetries || 3, taskId, options.metadata ? JSON.stringify(options.metadata) : null);

    if (d.changes > 0) return id;
  } catch {
    // Ignore constraint violation
  }

  // Find existing ID if deduplicated
  const existing = d.prepare(`SELECT id FROM request_queue WHERE url = $1 AND task_id = $2 AND status != 'failed' LIMIT 1`);
  const row = existing.get(options.url, taskId) as { id: string } | undefined;
  return row?.id || id;
}

/**
 * Add multiple URLs to the queue (batched in a transaction).
 */
export function addManyToQueue(items: AddToQueueOptions[]): string[] {
  const d = getDb();
  const ids: string[] = [];

  d.transaction(() => {
    const insert = d.prepare(`
      INSERT OR IGNORE INTO request_queue (id, url, method, payload, retries, max_retries, status, created_at, updated_at, task_id, metadata)
      VALUES ($1, $2, $3, $4, 0, $5, 'pending', datetime('now'), datetime('now'), $6, $7)
    `);
    const findExisting = d.prepare(`SELECT id FROM request_queue WHERE url = $1 AND task_id = $2 AND status != 'failed' LIMIT 1`);

    for (const item of items) {
      const id = generateId();
      const taskId = item.taskId || "__default__";

      insert.run(id, item.url, item.method || "GET", item.payload ? JSON.stringify(item.payload) : null, item.maxRetries || 3, taskId, item.metadata ? JSON.stringify(item.metadata) : null);

      if (d.changes > 0) {
        ids.push(id);
      } else {
        const row = findExisting.get(item.url, taskId) as { id: string } | undefined;
        if (row) ids.push(row.id);
      }
    }
  });

  return ids;
}

// ==================== Update Queue Item ====================

export function markCompleted(id: string): void {
  const d = getDb();
  d.prepare(`UPDATE request_queue SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = $1`).run(id);
}

export function markFailed(id: string, error: string): void {
  const d = getDb();

  const row = d.prepare(`SELECT retries, max_retries FROM request_queue WHERE id = $1`).get(id) as any;
  if (!row) return;

  if (row.retries < row.max_retries) {
    d.prepare(`UPDATE request_queue SET status = 'pending', retries = retries + 1, error = $1, updated_at = datetime('now') WHERE id = $2`).run(error, id);
  } else {
    d.prepare(`UPDATE request_queue SET status = 'failed', error = $1, updated_at = datetime('now'), completed_at = datetime('now') WHERE id = $2`).run(error, id);
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
  const d = getDb();

  let where = "";
  const params: unknown[] = [];
  if (taskId) {
    where = " WHERE task_id = $1";
    params.push(taskId);
  }

  const row = d.prepare(`
    SELECT
      COUNT(*) as total,
      COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) as pending,
      COALESCE(SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END), 0) as "inProgress",
      COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) as completed,
      COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed
    FROM request_queue${where}
  `).get(...params) as any;

  return {
    total: row.total,
    pending: row.pending,
    inProgress: row.inProgress,
    completed: row.completed,
    failed: row.failed,
  };
}

/**
 * Requeue failed items (reset to pending for retry).
 */
export function requeueFailed(taskId?: string): number {
  const d = getDb();

  if (taskId) {
    d.prepare(`UPDATE request_queue SET status = 'pending', retries = 0, error = NULL, updated_at = datetime('now') WHERE status = 'failed' AND task_id = $1`).run(taskId);
  } else {
    d.prepare(`UPDATE request_queue SET status = 'pending', retries = 0, error = NULL, updated_at = datetime('now') WHERE status = 'failed'`).run();
  }

  return d.changes;
}

/**
 * Clear completed/failed items older than a given number of hours.
 */
export function cleanupQueue(olderThanHours: number = 24): number {
  const d = getDb();
  const cutoff = new Date(Date.now() - olderThanHours * 3600000).toISOString().replace('T', ' ').slice(0, 19);

  d.prepare(`DELETE FROM request_queue WHERE status IN ('completed', 'failed') AND updated_at < $1`).run(cutoff);

  return d.changes;
}

/**
 * Clear all queue items for a specific task (exact match).
 */
export function clearTaskQueue(taskId: string): void {
  const d = getDb();
  d.prepare(`DELETE FROM request_queue WHERE task_id = $1`).run(taskId);
}

