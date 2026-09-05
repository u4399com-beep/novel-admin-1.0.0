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
    this.insertionOrder = this.insertionOrder.filter(k => k !== key);
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
