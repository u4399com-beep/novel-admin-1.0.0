/**
 * Scraping Progress Tracker with Real-time Updates
 *
 * Tracks detailed progress for each task:
 *   - URLs queued/processing/completed/failed
 *   - Per-step timing (list parse, book fetch, chapter fetch, content fetch, save)
 *   - Current throughput (items/second)
 *   - Estimated time remaining based on current rate
 *   - Per-domain progress
 * Emits progress events via the log-stream WebSocket.
 * Stores snapshots for task resumption after crash.
 * API endpoint: GET /progress/:taskId
 */

import { logger } from './logger';
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { resolve } from 'path';

const log = logger.child('ProgressTracker');

// ==================== Types ====================

export type ProgressStep =
  | 'list_parse'
  | 'book_fetch'
  | 'chapter_fetch'
  | 'content_fetch'
  | 'save'
  | 'idle';

export interface StepTiming {
  step: ProgressStep;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  itemsProcessed: number;
}

export interface DomainProgress {
  domain: string;
  urlsQueued: number;
  urlsCompleted: number;
  urlsFailed: number;
  avgResponseTimeMs: number;
  lastActivityAt: number;
}

export interface TaskProgressSnapshot {
  taskId: string;
  /** Timestamp of this snapshot */
  timestamp: number;
  /** Overall progress 0-100 */
  progress: number;
  /** Current step being executed */
  currentStep: ProgressStep;
  /** URLs count breakdown */
  urls: {
    queued: number;
    processing: number;
    completed: number;
    failed: number;
  };
  /** Per-step timing records */
  stepTimings: StepTiming[];
  /** Current throughput (items/second) */
  throughput: number;
  /** Estimated time remaining in ms */
  estimatedTimeRemainingMs: number;
  /** Per-domain progress */
  domainProgress: Record<string, DomainProgress>;
  /** Task start time */
  startedAt: number;
  /** Total elapsed time ms */
  elapsedMs: number;
}

export interface TaskProgressState {
  taskId: string;
  startedAt: number;
  currentStep: ProgressStep;
  progress: number;
  urls: {
    queued: number;
    processing: number;
    completed: number;
    failed: number;
  };
  stepTimings: StepTiming[];
  domainProgress: Map<string, DomainProgress>;
  /** Throughput tracking: items completed with timestamps */
  completionEvents: Array<{ timestamp: number; count: number }>;
  /** Currently active step timing (in progress) */
  activeStep?: StepTiming;
}

// ==================== Constants ====================

const THROUGHPUT_WINDOW_MS = 60_000; // 1 minute rolling window
const MAX_COMPLETION_EVENTS = 1000;
const MAX_STEP_TIMINGS = 100;
const SNAPSHOT_INTERVAL_MS = 30_000; // Snapshot every 30 seconds
const SNAPSHOT_DIR = resolve(import.meta.dir ?? '.', '..', 'progress-snapshots');
const MAX_DOMAINS = 200;

// ==================== Progress Tracker ====================

class ProgressTracker {
  private tasks = new Map<string, TaskProgressState>();
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private eventListeners: Array<(taskId: string, snapshot: TaskProgressSnapshot) => void> = [];

  constructor() {
    // Ensure snapshot directory exists
    try { mkdirSync(SNAPSHOT_DIR, { recursive: true }); } catch {}

    // Periodic snapshots
    this.snapshotTimer = setInterval(() => {
      this.saveAllSnapshots();
    }, SNAPSHOT_INTERVAL_MS).unref();
  }

  /**
   * Initialize progress tracking for a task.
   */
  initTask(taskId: string): void {
    this.tasks.set(taskId, {
      taskId,
      startedAt: Date.now(),
      currentStep: 'idle',
      progress: 0,
      urls: { queued: 0, processing: 0, completed: 0, failed: 0 },
      stepTimings: [],
      domainProgress: new Map(),
      completionEvents: [],
    });
  }

  /**
   * Start a step for a task.
   */
  startStep(taskId: string, step: ProgressStep): void {
    const state = this.tasks.get(taskId);
    if (!state) return;

    // Close any active step
    if (state.activeStep) {
      this.endStep(taskId);
    }

    state.currentStep = step;
    state.activeStep = {
      step,
      startedAt: Date.now(),
      itemsProcessed: 0,
    };
  }

  /**
   * End the current step for a task.
   */
  endStep(taskId: string): void {
    const state = this.tasks.get(taskId);
    if (!state || !state.activeStep) return;

    const now = Date.now();
    state.activeStep.completedAt = now;
    state.activeStep.durationMs = now - state.activeStep.startedAt;
    state.stepTimings.push(state.activeStep);
    if (state.stepTimings.length > MAX_STEP_TIMINGS) {
      state.stepTimings.shift();
    }
    state.activeStep = undefined;
    state.currentStep = 'idle';
  }

  /**
   * Update progress for a task.
   */
  updateProgress(taskId: string, progress: number): void {
    const state = this.tasks.get(taskId);
    if (!state) return;
    state.progress = Math.max(0, Math.min(100, progress));
    this.emitProgress(taskId);
  }

  /**
   * Record URL counts.
   */
  updateUrlCounts(taskId: string, updates: Partial<{
    queued: number;
    processing: number;
    completed: number;
    failed: number;
  }>): void {
    const state = this.tasks.get(taskId);
    if (!state) return;

    if (updates.queued !== undefined) state.urls.queued = updates.queued;
    if (updates.processing !== undefined) state.urls.processing = updates.processing;
    if (updates.completed !== undefined) state.urls.completed = updates.completed;
    if (updates.failed !== undefined) state.urls.failed = updates.failed;

    // Record completion event for throughput calculation
    if (updates.completed !== undefined && updates.completed > state.urls.completed) {
      const delta = updates.completed - state.urls.completed;
      state.completionEvents.push({ timestamp: Date.now(), count: delta });
      if (state.completionEvents.length > MAX_COMPLETION_EVENTS) {
        state.completionEvents.shift();
      }
    }

    this.emitProgress(taskId);
  }

  /**
   * Record a URL completion/processing for a domain.
   */
  recordDomainActivity(
    taskId: string,
    domain: string,
    type: 'completed' | 'failed' | 'processing',
    responseTimeMs?: number,
  ): void {
    const state = this.tasks.get(taskId);
    if (!state) return;

    let dp = state.domainProgress.get(domain);
    if (!dp) {
      if (state.domainProgress.size >= MAX_DOMAINS) {
        // Evict oldest domain
        const firstKey = state.domainProgress.keys().next().value;
        if (firstKey) state.domainProgress.delete(firstKey);
      }
      dp = {
        domain,
        urlsQueued: 0,
        urlsCompleted: 0,
        urlsFailed: 0,
        avgResponseTimeMs: 0,
        lastActivityAt: Date.now(),
      };
      state.domainProgress.set(domain, dp);
    }

    dp.lastActivityAt = Date.now();
    if (type === 'completed') {
      dp.urlsCompleted++;
      if (responseTimeMs !== undefined) {
        // Running average
        dp.avgResponseTimeMs = Math.round(
          (dp.avgResponseTimeMs * (dp.urlsCompleted - 1) + responseTimeMs) / dp.urlsCompleted
        );
      }
    } else if (type === 'failed') {
      dp.urlsFailed++;
    }
  }

  /**
   * Get current throughput (items/second) for a task.
   */
  getThroughput(taskId: string): number {
    const state = this.tasks.get(taskId);
    if (!state) return 0;

    const now = Date.now();
    const windowStart = now - THROUGHPUT_WINDOW_MS;

    // Sum completions in the window
    const recentEvents = state.completionEvents.filter(e => e.timestamp >= windowStart);
    const totalCompleted = recentEvents.reduce((sum, e) => sum + e.count, 0);

    // Calculate rate
    const windowMs = Math.min(now - state.startedAt, THROUGHPUT_WINDOW_MS);
    if (windowMs <= 0) return 0;

    return totalCompleted / (windowMs / 1000);
  }

  /**
   * Get estimated time remaining (ms) for a task.
   */
  getEstimatedTimeRemaining(taskId: string): number {
    const state = this.tasks.get(taskId);
    if (!state) return 0;

    const throughput = this.getThroughput(taskId);
    if (throughput <= 0) return Infinity;

    const remaining = state.urls.queued + state.urls.processing;
    if (remaining <= 0) return 0;

    return Math.round(remaining / throughput * 1000);
  }

  /**
   * Get a full progress snapshot for a task.
   */
  getSnapshot(taskId: string): TaskProgressSnapshot | null {
    const state = this.tasks.get(taskId);
    if (!state) return null;

    const now = Date.now();
    const throughput = this.getThroughput(taskId);
    const etr = this.getEstimatedTimeRemaining(taskId);

    // Convert domain progress map to record
    const domainProgress: Record<string, DomainProgress> = {};
    for (const [domain, dp] of state.domainProgress) {
      domainProgress[domain] = dp;
    }

    return {
      taskId: state.taskId,
      timestamp: now,
      progress: state.progress,
      currentStep: state.currentStep,
      urls: { ...state.urls },
      stepTimings: [...state.stepTimings],
      throughput: Math.round(throughput * 100) / 100,
      estimatedTimeRemainingMs: etr,
      domainProgress,
      startedAt: state.startedAt,
      elapsedMs: now - state.startedAt,
    };
  }

  /**
   * Remove tracking for a task (call when task completes/fails).
   */
  removeTask(taskId: string): void {
    this.tasks.delete(taskId);
    // Delete snapshot file
    try {
      const path = resolve(SNAPSHOT_DIR, `${taskId}.json`);
      if (existsSync(path)) {
        unlinkSync(path);
      }
    } catch {}
  }

  /**
   * Add a progress event listener (for WebSocket streaming).
   */
  onProgress(listener: (taskId: string, snapshot: TaskProgressSnapshot) => void): void {
    this.eventListeners.push(listener);
  }

  /**
   * Save a snapshot to disk (for crash recovery).
   */
  saveSnapshot(taskId: string): void {
    const snapshot = this.getSnapshot(taskId);
    if (!snapshot) return;

    try {
      const path = resolve(SNAPSHOT_DIR, `${taskId}.json`);
      writeFileSync(path, JSON.stringify(snapshot, null, 2));
    } catch {
      // Non-blocking
    }
  }

  /**
   * Load a snapshot from disk (for task resumption).
   */
  loadSnapshot(taskId: string): TaskProgressSnapshot | null {
    try {
      const path = resolve(SNAPSHOT_DIR, `${taskId}.json`);
      if (!existsSync(path)) return null;
      const raw = readFileSync(path, 'utf-8');
      return JSON.parse(raw) as TaskProgressSnapshot;
    } catch {
      return null;
    }
  }

  /**
   * Get all active task IDs.
   */
  getActiveTaskIds(): string[] {
    return Array.from(this.tasks.keys());
  }

  /** Stop and save all */
  destroy(): void {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    this.saveAllSnapshots();
  }

  // ==================== Private ====================

  private emitProgress(taskId: string): void {
    const snapshot = this.getSnapshot(taskId);
    if (!snapshot) return;

    for (const listener of this.eventListeners) {
      try { listener(taskId, snapshot); } catch {}
    }
  }

  private saveAllSnapshots(): void {
    for (const taskId of this.tasks.keys()) {
      this.saveSnapshot(taskId);
    }
  }
}

// Singleton
export const progressTracker = new ProgressTracker();
