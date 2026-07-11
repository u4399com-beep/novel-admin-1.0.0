/**
 * Request Queue with PostgreSQL Persistence
 * Enables resume-capable crawling with deduplication.
 * Uses a dedicated task_id column for performance and safety.
 */

import postgres from "postgres";
import { generateId } from "./utils";
import type { QueueItem } from "./types";

const DATABASE_URL = process.env.QUEUE_DATABASE_URL || process.env.DATABASE_URL || "postgresql://z@localhost:5432/novel_admin";

let sql: postgres.SqlSqlType | null = null;

function getSql(): postgres.SqlSqlType {
  if (sql) return sql;

  sql = postgres(DATABASE_URL, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  // Ensure the queue table exists
  sql`
    CREATE TABLE IF NOT EXISTS request_queue (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT 'GET',
      payload TEXT,
      retries INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      task_id TEXT NOT NULL DEFAULT '__default__',
      metadata TEXT
    )
  `.then(() => {
    // Create indexes (idempotent)
    return sql!`
      CREATE INDEX IF NOT EXISTS idx_queue_status ON request_queue(status);
      CREATE INDEX IF NOT EXISTS idx_queue_url ON request_queue(url);
      CREATE INDEX IF NOT EXISTS idx_queue_task_id ON request_queue(task_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_task_url ON request_queue(task_id, url, status);
      CREATE INDEX IF NOT EXISTS idx_queue_status_updated ON request_queue(status, updated_at);
    `;
  }).catch((err) => {
    console.error("[Queue] Failed to initialize table:", err.message);
  });

  return sql;
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
export async function addToQueue(options: AddToQueueOptions): Promise<string> {
  const s = getSql();
  const id = generateId();
  const taskId = options.taskId || "__default__";

  try {
    const result = await s`
      INSERT INTO request_queue (id, url, method, payload, retries, max_retries, status, created_at, updated_at, task_id, metadata)
      VALUES (${id}, ${options.url}, ${options.method || "GET"}, ${options.payload ? JSON.stringify(options.payload) : null}, 0, ${options.maxRetries || 3}, 'pending', NOW(), NOW(), ${taskId}, ${options.metadata ? JSON.stringify(options.metadata) : null})
      ON CONFLICT DO NOTHING
      RETURNING id
    `;

    if (result.length > 0) return result[0].id;
  } catch {
    // Ignore constraint violation
  }

  // Find existing ID if deduplicated
  const existing = await s`
    SELECT id FROM request_queue WHERE url = ${options.url} AND task_id = ${taskId} AND status != 'failed' LIMIT 1
  `;
  if (existing.length > 0) return existing[0].id;

  return id;
}

/**
 * Add multiple URLs to the queue (batched in a transaction).
 */
export async function addManyToQueue(items: AddToQueueOptions[]): Promise<string[]> {
  const s = getSql();
  const ids: string[] = [];

  await s.begin(async (tx) => {
    for (const item of items) {
      const id = generateId();
      const taskId = item.taskId || "__default__";

      const result = await tx`
        INSERT INTO request_queue (id, url, method, payload, retries, max_retries, status, created_at, updated_at, task_id, metadata)
        VALUES (${id}, ${item.url}, ${item.method || "GET"}, ${item.payload ? JSON.stringify(item.payload) : null}, 0, ${item.maxRetries || 3}, 'pending', NOW(), NOW(), ${taskId}, ${item.metadata ? JSON.stringify(item.metadata) : null})
        ON CONFLICT DO NOTHING
        RETURNING id
      `;

      if (result.length > 0) {
        ids.push(result[0].id);
      } else {
        // Dedup: find existing
        const existing = await tx`
          SELECT id FROM request_queue WHERE url = ${item.url} AND task_id = ${taskId} AND status != 'failed' LIMIT 1
        `;
        if (existing.length > 0) ids.push(existing[0].id);
      }
    }
  });

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
 * Uses FOR UPDATE SKIP LOCKED to prevent concurrent workers from grabbing the same item.
 */
export async function dequeue(taskId?: string): Promise<DequeueResult | null> {
  const s = getSql();

  const rows = await s`
    UPDATE request_queue
    SET status = 'in_progress', updated_at = NOW()
    WHERE id = (
      SELECT id FROM request_queue
      WHERE status = 'pending' ${taskId ? sql`AND task_id = ${taskId}` : sql``}
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, url, method, payload, metadata
  `;

  if (rows.length === 0) return null;

  const row = rows[0];
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
export async function dequeueBatch(taskId?: string, limit: number = 10): Promise<DequeueResult[]> {
  const s = getSql();
  const where = taskId ? s`status = 'pending' AND task_id = ${taskId}` : s`status = 'pending'`;
  const rows = await s`
    WITH next_items AS (
      SELECT id FROM request_queue
      WHERE ${where}
      ORDER BY created_at ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE request_queue
    SET status = 'in_progress', updated_at = NOW()
    FROM next_items
    WHERE request_queue.id = next_items.id
    RETURNING request_queue.id, request_queue.url, request_queue.method, request_queue.payload, request_queue.metadata
  `;
  return rows.map((row: any) => ({
    id: row.id,
    url: row.url,
    method: row.method,
    payload: row.payload ? JSON.parse(row.payload) : null,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  }));
}

// ==================== Update Queue Item ====================

export async function markCompleted(id: string): Promise<void> {
  const s = getSql();
  await s`
    UPDATE request_queue SET status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE id = ${id}
  `;
}

export async function markFailed(id: string, error: string): Promise<void> {
  const s = getSql();

  const rows = await s`
    SELECT retries, max_retries FROM request_queue WHERE id = ${id}
  `;

  if (rows.length === 0) return;

  const { retries, max_retries } = rows[0];

  if (retries < max_retries) {
    await s`
      UPDATE request_queue
      SET status = 'pending', retries = retries + 1, error = ${error}, updated_at = NOW()
      WHERE id = ${id}
    `;
  } else {
    await s`
      UPDATE request_queue
      SET status = 'failed', error = ${error}, updated_at = NOW(), completed_at = NOW()
      WHERE id = ${id}
    `;
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

export async function getQueueStats(taskId?: string): Promise<QueueStats> {
  const s = getSql();

  const rows = taskId
    ? await s`
        SELECT
          COUNT(*)::int as total,
          COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0)::int as pending,
          COALESCE(SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END), 0)::int as "inProgress",
          COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0)::int as completed,
          COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0)::int as failed
        FROM request_queue
        WHERE task_id = ${taskId}
      `
    : await s`
        SELECT
          COUNT(*)::int as total,
          COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0)::int as pending,
          COALESCE(SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END), 0)::int as "inProgress",
          COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0)::int as completed,
          COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0)::int as failed
        FROM request_queue
      `;

  return rows[0] as QueueStats;
}

/**
 * Requeue failed items (reset to pending for retry).
 */
export async function requeueFailed(taskId?: string): Promise<number> {
  const s = getSql();

  const result = taskId
    ? await s`
        UPDATE request_queue
        SET status = 'pending', retries = 0, error = NULL, updated_at = NOW()
        WHERE status = 'failed' AND task_id = ${taskId}
      `
    : await s`
        UPDATE request_queue
        SET status = 'pending', retries = 0, error = NULL, updated_at = NOW()
        WHERE status = 'failed'
      `;

  return result.count;
}

/**
 * Clear completed/failed items older than a given number of hours.
 */
export async function cleanupQueue(olderThanHours: number = 24): Promise<number> {
  const s = getSql();
  const cutoff = new Date(Date.now() - olderThanHours * 3600000).toISOString();

  const result = await s`
    DELETE FROM request_queue
    WHERE status IN ('completed', 'failed')
    AND updated_at < ${cutoff}::timestamptz
  `;

  return result.count;
}

/**
 * Clear all queue items for a specific task (exact match).
 */
export async function clearTaskQueue(taskId: string): Promise<void> {
  const s = getSql();
  await s`DELETE FROM request_queue WHERE task_id = ${taskId}`;
}

/**
 * Check if a URL has already been queued/completed for a task.
 */
export async function isUrlProcessed(url: string, taskId?: string): Promise<boolean> {
  const s = getSql();

  const rows = taskId
    ? await s`
        SELECT id FROM request_queue
        WHERE url = ${url} AND task_id = ${taskId} AND status IN ('completed', 'in_progress')
        LIMIT 1
      `
    : await s`
        SELECT id FROM request_queue
        WHERE url = ${url} AND status IN ('completed', 'in_progress')
        LIMIT 1
      `;

  return rows.length > 0;
}