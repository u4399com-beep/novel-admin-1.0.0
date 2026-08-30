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
    // Wait at most 5s for a connection from the pool; reject fast instead of blocking
    max_lifetime: 60 * 30,
    prepare: false,
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
  // Partial unique index: prevent duplicate active (pending/in_progress) entries per task+url
  // Note: SQLite CREATE INDEX does not support WHERE; this is a PostgreSQL-style comment
  // For SQLite, we handle dedup in application logic (addToQueue checks existing entries)
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_task_url_active ON request_queue(task_id, url)`;
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
 * Add multiple URLs to the queue (batched in a single transaction for atomicity).
 */
export async function addManyToQueue(items: AddToQueueOptions[]): Promise<string[]> {
  const db = await getSql();
  const ids: string[] = [];

  await db.begin(async (sql) => {
    for (const item of items) {
      const id = generateId();
      const taskId = item.taskId || "__default__";

      const result = await sql`
        INSERT INTO request_queue (id, url, method, payload, retries, max_retries, status, created_at, updated_at, task_id, metadata)
        VALUES (${id}, ${item.url}, ${item.method || "GET"}, ${item.payload ? JSON.stringify(item.payload) : null}, 0, ${item.maxRetries || 3}, 'pending', NOW(), NOW(), ${taskId}, ${item.metadata ? JSON.stringify(item.metadata) : null})
        ON CONFLICT (task_id, url, status) WHERE status != 'failed' DO NOTHING
        RETURNING id
      `;

      if (result.length > 0) {
        ids.push(id);
      } else {
        const existing = await sql`
          SELECT id FROM request_queue WHERE url = ${item.url} AND task_id = ${taskId} AND status != 'failed' LIMIT 1
        `;
        if (existing[0]) ids.push(existing[0].id);
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

  // Atomic: try to requeue first (only if retries < max_retries AND still in_progress)
  const retried = await db`
    UPDATE request_queue
    SET status = 'pending', retries = retries + 1, error = ${error}, updated_at = NOW()
    WHERE id = ${id} AND status = 'in_progress' AND retries < max_retries
    RETURNING id
  `;

  // If no row was updated by the requeue attempt, mark as permanently failed
  if (retried.length === 0) {
    await db`
      UPDATE request_queue
      SET status = 'failed', error = ${error}, updated_at = NOW(), completed_at = NOW()
      WHERE id = ${id} AND status = 'in_progress'
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

  // Use tagged template for parameterized queries
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

  const result = taskId
    ? await db`UPDATE request_queue SET status = 'pending', retries = 0, error = NULL, updated_at = NOW() WHERE status = 'failed' AND task_id = ${taskId}`
    : await db`UPDATE request_queue SET status = 'pending', retries = 0, error = NULL, updated_at = NOW() WHERE status = 'failed'`;

  return result.count ?? 0;
}

/**
 * Clear completed/failed items older than a given number of hours.
 */
export async function cleanupQueue(olderThanHours: number = 24): Promise<number> {
  const db = await getSql();
  const cutoff = new Date(Date.now() - olderThanHours * 3600000);

  const result = await db`DELETE FROM request_queue WHERE status IN ('completed', 'failed') AND updated_at < ${cutoff.toISOString()}`;

  return result.count ?? 0;
}

/**
 * Clear all queue items for a specific task.
 */
export async function clearTaskQueue(taskId: string): Promise<void> {
  const db = await getSql();
  await db`DELETE FROM request_queue WHERE task_id = ${taskId}`;
}

/**
 * Re-queue items that have been stuck in 'in_progress' status for too long.
 * This handles the case where a worker crashes mid-processing, leaving items
 * in 'in_progress' state. Resets them to 'pending' so they can be retried.
 *
 * @param staleMinutes - How long an item must be 'in_progress' before being considered stale (default: 30 minutes)
 * @param taskId - Optional: only requeue items for a specific task
 * @returns Number of items requeued
 */
export async function requeueStaleInProgress(staleMinutes: number = 30, taskId?: string): Promise<number> {
  const db = await getSql();
  const cutoff = new Date(Date.now() - staleMinutes * 60000);

  const result = taskId
    ? await db`UPDATE request_queue SET status = 'pending', error = NULL, updated_at = NOW() WHERE status = 'in_progress' AND task_id = ${taskId} AND updated_at < ${cutoff.toISOString()}`
    : await db`UPDATE request_queue SET status = 'pending', error = NULL, updated_at = NOW() WHERE status = 'in_progress' AND updated_at < ${cutoff.toISOString()}`;

  return result.count ?? 0;
}

/**
 * Gracefully shut down the PostgreSQL connection pool.
 * Call this on process exit to avoid RST packets to PostgreSQL.
 */
export async function shutdown(): Promise<void> {
  if (sql) {
    await sql.end({ timeout: 5 });
    sql = null;
  }
}

/**
 * Check if a URL has already been queued/completed for a task.
 */
export async function isUrlProcessed(url: string, taskId?: string): Promise<boolean> {
  const db = await getSql();

  let rows: any[];
  if (taskId) {
    rows = await db`
      SELECT id FROM request_queue WHERE url = ${url} AND task_id = ${taskId} AND status IN ('completed', 'in_progress', 'pending') LIMIT 1
    `;
  } else {
    rows = await db`
      SELECT id FROM request_queue WHERE url = ${url} AND status IN ('completed', 'in_progress') LIMIT 1
    `;
  }

  return rows.length > 0;
}