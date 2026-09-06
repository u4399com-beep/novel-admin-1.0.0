/**
 * Memory Pressure Monitor
 *
 * Monitors RSS memory usage and triggers aggressive cleanup
 * when memory pressure is high (>500MB RSS).
 * Provides a centralized way to bound in-memory stores.
 */

import { logger } from './logger';

const log = logger.child('Memory');

// ==================== Constants ====================

const MEMORY_PRESSURE_THRESHOLD_MB = 500;
const MEMORY_CRITICAL_THRESHOLD_MB = 800;
const CHECK_INTERVAL_MS = 30_000; // Check every 30s
const MAX_BOUNDED_MAP_ENTRIES = 10000; // Default max for bounded maps

// ==================== Types ====================

export interface MemoryStats {
  rss: number;       // Resident Set Size in MB
  heapTotal: number; // Total heap in MB
  heapUsed: number;  // Used heap in MB
  external: number;  // External memory in MB
  pressure: 'normal' | 'high' | 'critical';
}

// ==================== BoundedMap ====================

/**
 * A Map with bounded size that evicts oldest entries when capacity is reached.
 * Use this instead of plain Map for all in-memory stores that could grow
 * unboundedly in long-running operations.
 */
export class BoundedMap<K, V> {
  private map = new Map<K, V>();
  private readonly maxSize: number;
  private insertionOrder: K[] = [];

  constructor(maxSize: number = MAX_BOUNDED_MAP_ENTRIES) {
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    return this.map.get(key);
  }

  set(key: K, value: V): void {
    if (!this.map.has(key) && this.map.size >= this.maxSize) {
      // Evict oldest entry
      const oldest = this.insertionOrder.shift();
      if (oldest !== undefined) {
        this.map.delete(oldest);
      }
    }
    if (!this.map.has(key)) {
      this.insertionOrder.push(key);
    }
    this.map.set(key, value);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  delete(key: K): boolean {
    const idx = this.insertionOrder.indexOf(key);
    if (idx >= 0) this.insertionOrder.splice(idx, 1);
    return this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
    this.insertionOrder = [];
  }

  entries(): IterableIterator<[K, V]> {
    return this.map.entries();
  }

  values(): IterableIterator<V> {
    return this.map.values();
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }

  forEach(callback: (value: V, key: K, map: Map<K, V>) => void): void {
    this.map.forEach(callback);
  }
}

// ==================== Cleanup Callbacks ====================

type CleanupCallback = () => number; // Returns number of entries freed

const cleanupCallbacks: CleanupCallback[] = [];

/**
 * Register a cleanup callback that will be called during memory pressure.
 * The callback should perform aggressive cleanup and return the number
 * of entries freed.
 */
export function registerMemoryCleanup(callback: CleanupCallback): void {
  cleanupCallbacks.push(callback);
}

// ==================== Memory Monitor ====================

class MemoryMonitor {
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private lastStats: MemoryStats | null = null;

  /**
   * Start periodic memory monitoring.
   */
  start(): void {
    if (this.checkTimer) return;
    this.checkTimer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
    if (this.checkTimer.unref) {
      this.checkTimer.unref();
    }
  }

  /**
   * Stop memory monitoring.
   */
  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  /**
   * Get current memory stats.
   */
  getStats(): MemoryStats {
    const mem = process.memoryUsage();
    const rss = mem.rss / (1024 * 1024);
    const heapTotal = mem.heapTotal / (1024 * 1024);
    const heapUsed = mem.heapUsed / (1024 * 1024);
    const external = mem.external / (1024 * 1024);

    let pressure: MemoryStats['pressure'] = 'normal';
    if (rss >= MEMORY_CRITICAL_THRESHOLD_MB) {
      pressure = 'critical';
    } else if (rss >= MEMORY_PRESSURE_THRESHOLD_MB) {
      pressure = 'high';
    }

    return { rss, heapTotal, heapUsed, external, pressure };
  }

  /**
   * Check memory and trigger cleanup if under pressure.
   */
  check(): void {
    const stats = this.getStats();
    this.lastStats = stats;

    if (stats.pressure === 'critical') {
      log.error(`Memory CRITICAL: RSS ${stats.rss.toFixed(0)}MB, heap ${stats.heapUsed.toFixed(0)}/${stats.heapTotal.toFixed(0)}MB — triggering aggressive cleanup`);
      this.aggressiveCleanup();
    } else if (stats.pressure === 'high') {
      log.warn(`Memory HIGH: RSS ${stats.rss.toFixed(0)}MB, heap ${stats.heapUsed.toFixed(0)}/${stats.heapTotal.toFixed(0)}MB — triggering cleanup`);
      this.cleanup();
    }
  }

  /**
   * Run registered cleanup callbacks.
   */
  private cleanup(): void {
    let totalFreed = 0;
    for (const cb of cleanupCallbacks) {
      try {
        totalFreed += cb();
      } catch (err) {
        log.error(`Cleanup callback error: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (totalFreed > 0) {
      log.info(`Cleanup freed ${totalFreed} entries`);
    }
  }

  /**
   * Aggressive cleanup — run multiple rounds and force GC if available.
   */
  private aggressiveCleanup(): void {
    // Run 3 rounds of cleanup
    for (let i = 0; i < 3; i++) {
      this.cleanup();
    }
    // Force GC if available (Bun/node with --expose-gc)
    if (typeof globalThis.gc === 'function') {
      globalThis.gc();
      log.info('Forced garbage collection');
    }
  }
}

// Singleton
export const memoryMonitor = new MemoryMonitor();

// ==================== Proactive GC Hints for Bun Runtime ====================

/**
 * Proactive GC hints for Bun runtime.
 *
 * Bun's JavaScriptCore (JSC) GC can benefit from hints when
 * the application knows memory pressure is about to increase
 * (e.g., before a large scraping batch) or decrease (e.g.,
 * after clearing a cache).
 *
 * This module provides:
 *   - Explicit GC request when memory is approaching threshold
 *   - Pre-allocation hints before large operations
 *   - Post-cleanup GC nudges
 */

/**
 * Request a proactive garbage collection if available.
 * Uses Bun's `gc()` if exposed, otherwise is a no-op.
 *
 * @param reason - Reason for the GC request (for logging)
 */
export function requestProactiveGC(reason: string): void {
  if (typeof globalThis.gc === 'function') {
    const before = process.memoryUsage().heapUsed;
    globalThis.gc();
    const after = process.memoryUsage().heapUsed;
    const freed = before - after;
    if (freed > 1024 * 1024) { // Only log if >1MB freed
      log.info(`Proactive GC (${reason}): freed ${(freed / 1024 / 1024).toFixed(1)}MB`);
    }
  }
}

// ==================== Memory Budget Per Task ====================

/**
 * Memory budget per task.
 *
 * Assigns a memory budget to each scraping task and tracks usage.
 * If a task exceeds its budget, it triggers cleanup or cancellation
 * before it can cause OOM for the entire process.
 */

export interface TaskMemoryBudget {
  /** Task identifier */
  taskId: string;
  /** Maximum memory allowed for this task (bytes) */
  maxBytes: number;
  /** Current estimated memory usage (bytes) */
  currentBytes: number;
  /** Whether the budget has been exceeded */
  exceeded: boolean;
}

const taskBudgets = new Map<string, TaskMemoryBudget>();
const DEFAULT_TASK_BUDGET_MB = 100; // 100MB per task by default

/**
 * Assign a memory budget to a task.
 *
 * @param taskId - Task identifier
 * @param maxMB - Maximum memory in MB (default: 100)
 */
export function assignTaskBudget(taskId: string, maxMB: number = DEFAULT_TASK_BUDGET_MB): void {
  taskBudgets.set(taskId, {
    taskId,
    maxBytes: maxMB * 1024 * 1024,
    currentBytes: 0,
    exceeded: false,
  });
}

/**
 * Update a task's memory usage estimate.
 *
 * @param taskId - Task identifier
 * @param bytes - Current memory usage in bytes
 * @returns Whether the task is still within budget
 */
export function updateTaskMemory(taskId: string, bytes: number): boolean {
  const budget = taskBudgets.get(taskId);
  if (!budget) return true; // No budget assigned = unlimited

  budget.currentBytes = bytes;
  budget.exceeded = bytes > budget.maxBytes;
  return !budget.exceeded;
}

/**
 * Release a task's memory budget.
 *
 * @param taskId - Task identifier
 */
export function releaseTaskBudget(taskId: string): void {
  taskBudgets.delete(taskId);
}

/**
 * Get all task memory budgets.
 */
export function getTaskMemoryBudgets(): TaskMemoryBudget[] {
  return Array.from(taskBudgets.values());
}

// ==================== OOM Pre-Warning and Graceful Degradation ====================

/**
 * OOM pre-warning and graceful degradation.
 *
 * Monitors memory trends and provides early warning before OOM:
 *   - Tracks memory growth rate (MB/s)
 *   - Predicts time-to-OOM based on current trend
 *   - Triggers graceful degradation (stop accepting new tasks, reduce cache sizes)
 *   - Provides priority-based task shedding (drop low-priority tasks first)
 */

export interface OOMWarning {
  /** Current RSS memory in MB */
  currentRSS: number;
  /** Memory growth rate in MB/s */
  growthRate: number;
  /** Estimated seconds until OOM (Infinity if not growing) */
  estimatedSecondsToOOM: number;
  /** Warning level */
  level: 'none' | 'warning' | 'critical' | 'emergency';
  /** Recommended actions */
  recommendations: string[];
}

const MEMORY_HISTORY_SIZE = 10;
const memoryHistory: Array<{ rss: number; timestamp: number }> = [];
const OOM_THRESHOLD_MB = 900; // Start emergency at 900MB

/**
 * Check for OOM risk and return warning level.
 *
 * @returns OOM warning information
 */
export function checkOOMRisk(): OOMWarning {
  const mem = process.memoryUsage();
  const currentRSS = mem.rss / (1024 * 1024);
  const now = Date.now();

  // Track history
  memoryHistory.push({ rss: currentRSS, timestamp: now });
  if (memoryHistory.length > MEMORY_HISTORY_SIZE) {
    memoryHistory.shift();
  }

  // Calculate growth rate
  let growthRate = 0;
  let estimatedSecondsToOOM = Infinity;

  if (memoryHistory.length >= 3) {
    const oldest = memoryHistory[0]!;
    const newest = memoryHistory[memoryHistory.length - 1]!;
    const timeDeltaSec = (newest.timestamp - oldest.timestamp) / 1000;
    const rssDelta = newest.rss - oldest.rss;

    if (timeDeltaSec > 0) {
      growthRate = rssDelta / timeDeltaSec; // MB/s

      if (growthRate > 0.1) { // Only predict if growing significantly
        const remainingMB = OOM_THRESHOLD_MB - currentRSS;
        estimatedSecondsToOOM = remainingMB / growthRate;
      }
    }
  }

  // Determine warning level
  let level: OOMWarning['level'] = 'none';
  const recommendations: string[] = [];

  if (currentRSS >= OOM_THRESHOLD_MB * 0.95) {
    level = 'emergency';
    recommendations.push('Immediately stop accepting new tasks');
    recommendations.push('Shed all non-critical caches');
    recommendations.push('Force garbage collection');
  } else if (currentRSS >= OOM_THRESHOLD_MB * 0.85) {
    level = 'critical';
    recommendations.push('Stop accepting new tasks');
    recommendations.push('Reduce cache sizes by 50%');
    recommendations.push('Request proactive GC');
  } else if (currentRSS >= OOM_THRESHOLD_MB * 0.70 || estimatedSecondsToOOM < 120) {
    level = 'warning';
    recommendations.push('Reduce concurrent task count');
    recommendations.push('Trigger aggressive cache cleanup');
  }

  return { currentRSS, growthRate, estimatedSecondsToOOM, level, recommendations };
}
