/**
 * Request Queue with PostgreSQL Persistence (Production)
 * Enables resume-capable crawling with deduplication.
 * Uses FOR UPDATE SKIP LOCKED for safe concurrent dequeuing.
 *
 * All functions are async (unlike the SQLite version which is sync).
 * Callers already use `await`, so both versions are drop-in compatible.
 */

import postgres from 'postgres';
import { generateId } from "./utils";
import type { QueueItem } from "./types";

const DATABASE_URL = process.env.QUEUE_DB_URL || process.env.DATABASE_URL || "";

let sql: postgres.Sql | null = null;

async function getSql(): Promise<postgres.Sql> {
  if (sql) return sql;

  if (!DATABASE_URL) {
    throw new Error("[Queue] DATABASE_URL or QUEUE_DB_URL must be set for PostgreSQL queue");
  }

  sql = postgres(DATABASE_URL, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  // Create table and indexes
  await sql`
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
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_queue_status ON request_queue(status)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_queue_url ON request_queue(url)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_queue_task_id ON request_queue(task_id)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_task_url ON request_queue(task_id, url, status)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_queue_status_updated ON request_queue(status, updated_at)`;

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
 * Deduplicates by URL + task_id.
 */
export async function addToQueue(options: AddToQueueOptions): Promise<string> {
  const db = await getSql();
  const id = generateId();
  const taskId = options.taskId || "__default__";

  const result = await db`
    INSERT INTO request_queue (id, url, method, payload, retries, max_retries, status, created_at, updated_at, task_id, metadata)
    VALUES (${id}, ${options.url}, ${options.method || "GET"}, ${options.payload ? JSON.stringify(options.payload) : null}, 0, ${options.maxRetries || 3}, 'pending', NOW(), NOW(), ${taskId}, ${options.metadata ? JSON.stringify(options.metadata) : null})
    ON CONFLICT (task_id, url, status) WHERE status != 'failed' DO NOTHING
    RETURNING id
  `;

  if (result.length > 0) return id;

  // Find existing ID if deduplicated
  const existing = await db`
    SELECT id FROM request_queue WHERE url = ${options.url} AND task_id = ${taskId} AND status != 'failed' LIMIT 1
  `;
  return existing[0]?.id || id;
}

/**
 * Add multiple URLs to the queue (batched).
 */
export async function addManyToQueue(items: AddToQueueOptions[]): Promise<string[]> {
  const db = await getSql();
  const ids: string[] = [];

  for (const item of items) {
    const id = await addToQueue(item);
    ids.push(id);
  }

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
 * Uses FOR UPDATE SKIP LOCKED for safe concurrent access.
 */
export async function dequeue(taskId?: string): Promise<DequeueResult | null> {
  const db = await getSql();

  let row: any;
  if (taskId) {
    const rows = await db`
      UPDATE request_queue
      SET status = 'in_progress', updated_at = NOW()
      WHERE id = (
        SELECT id FROM request_queue
        WHERE status = 'pending' AND task_id = ${taskId}
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, url, method, payload, metadata
    `;
    row = rows[0];
  } else {
    const rows = await db`
      UPDATE request_queue
      SET status = 'in_progress', updated_at = NOW()
      WHERE id = (
        SELECT id FROM request_queue
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, url, method, payload, metadata
    `;
    row = rows[0];
  }

  if (!row) return null;

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
 * Uses CTE with FOR UPDATE SKIP LOCKED for efficiency.
 */
export async function dequeueBatch(taskId?: string, limit: number = 10): Promise<DequeueResult[]> {
  const db = await getSql();

  let rows: any[];
  if (taskId) {
    rows = await db`
      WITH locked AS (
        SELECT id FROM request_queue
        WHERE status = 'pending' AND task_id = ${taskId}
        ORDER BY created_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE request_queue SET status = 'in_progress', updated_at = NOW()
      FROM locked WHERE request_queue.id = locked.id
      RETURNING request_queue.id, request_queue.url, request_queue.method, request_queue.payload, request_queue.metadata
    `;
  } else {
    rows = await db`
      WITH locked AS (
        SELECT id FROM request_queue
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE request_queue SET status = 'in_progress', updated_at = NOW()
      FROM locked WHERE request_queue.id = locked.id
      RETURNING request_queue.id, request_queue.url, request_queue.method, request_queue.payload, request_queue.metadata
    `;
  }

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
  const db = await getSql();
  await db`
    UPDATE request_queue SET status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE id = ${id}
  `;
}

export async function markFailed(id: string, error: string): Promise<void> {
  const db = await getSql();

  const [row] = await db`SELECT retries, max_retries FROM request_queue WHERE id = ${id}`;
  if (!row) return;

  if (row.retries < row.max_retries) {
    await db`
      UPDATE request_queue SET status = 'pending', retries = retries + 1, error = ${error}, updated_at = NOW() WHERE id = ${id}
    `;
  } else {
    await db`
      UPDATE request_queue SET status = 'failed', error = ${error}, updated_at = NOW(), completed_at = NOW() WHERE id = ${id}
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
  const db = await getSql();

  let where = "";
  const params: any[] = [];
  if (taskId) {
    where = " WHERE task_id = $1";
    params.push(taskId);
  }

  // Use tagged template for simplicity
  let row: any;
  if (taskId) {
    [row] = await db`
      SELECT
        COUNT(*)::int as total,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0)::int as pending,
        COALESCE(SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END), 0)::int as "inProgress",
        COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0)::int as completed,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0)::int as failed
      FROM request_queue WHERE task_id = ${taskId}
    `;
  } else {
    [row] = await db`
      SELECT
        COUNT(*)::int as total,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0)::int as pending,
        COALESCE(SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END), 0)::int as "inProgress",
        COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0)::int as completed,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0)::int as failed
      FROM request_queue
    `;
  }

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
export async function requeueFailed(taskId?: string): Promise<number> {
  const db = await getSql();

  if (taskId) {
    await db`
      UPDATE request_queue SET status = 'pending', retries = 0, error = NULL, updated_at = NOW()
      WHERE status = 'failed' AND task_id = ${taskId}
    `;
  } else {
    await db`
      UPDATE request_queue SET status = 'pending', retries = 0, error = NULL, updated_at = NOW()
      WHERE status = 'failed'
    `;
  }

  return 0; // postgres doesn't return changes count easily, return 0 as safe default
}

/**
 * Clear completed/failed items older than a given number of hours.
 */
export async function cleanupQueue(olderThanHours: number = 24): Promise<number> {
  const db = await getSql();
  const cutoff = new Date(Date.now() - olderThanHours * 3600000);

  await db`
    DELETE FROM request_queue WHERE status IN ('completed', 'failed') AND updated_at < ${cutoff.toISOString()}
  `;

  return 0;
}

/**
 * Clear all queue items for a specific task.
 */
export async function clearTaskQueue(taskId: string): Promise<void> {
  const db = await getSql();
  await db`DELETE FROM request_queue WHERE task_id = ${taskId}`;
}

/**
 * Check if a URL has already been queued/completed for a task.
 */
export async function isUrlProcessed(url: string, taskId?: string): Promise<boolean> {
  const db = await getSql();

  let rows: any[];
  if (taskId) {
    rows = await db`
      SELECT id FROM request_queue WHERE url = ${url} AND task_id = ${taskId} AND status IN ('completed', 'in_progress') LIMIT 1
    `;
  } else {
    rows = await db`
      SELECT id FROM request_queue WHERE url = ${url} AND status IN ('completed', 'in_progress') LIMIT 1
    `;
  }

  return rows.length > 0;
}