/**
 * Priority Queue for scraper-service task scheduling
 * Tasks are scheduled by priority (lower number = higher priority),
 * with FIFO ordering within the same priority level.
 */

export interface PriorityQueueItem {
  taskId: string;
  priority: number; // 0=critical, 1=high, 2=medium(default), 3=low
  ruleId?: string;
  createdAt: number;
}

export const PRIORITY_LABELS: Record<number, string> = {
  0: '紧急',
  1: '高',
  2: '普通',
  3: '低',
};

export const PRIORITY_COLORS: Record<number, string> = {
  0: 'destructive',
  1: 'chart-amber',
  2: 'sky',
  3: 'muted-foreground',
};

export class TaskPriorityQueue {
  private queue: PriorityQueueItem[] = [];
  private processing: Map<string, PriorityQueueItem> = new Map();
  private maxConcurrent: number;

  constructor(maxConcurrent: number = 3) {
    this.maxConcurrent = maxConcurrent;
  }

  /**
   * Add task to queue with priority (lower number = higher priority).
   * Returns false if task is already queued or processing.
   */
  enqueue(taskId: string, priority: number, ruleId?: string): boolean {
    if (this.isKnown(taskId)) return false;

    // Clamp priority to 0-3
    const clampedPriority = Math.max(0, Math.min(3, Math.floor(priority)));

    const item: PriorityQueueItem = {
      taskId,
      priority: clampedPriority,
      ruleId,
      createdAt: Date.now(),
    };

    // Binary search insertion: O(log n) search + O(n) splice
    this.insertSorted(item);
    return true;
  }

  /**
   * Remove task from queue (cancel). Returns false if not found in queue.
   */
  dequeue(taskId: string): boolean {
    const idx = this.queue.findIndex(item => item.taskId === taskId);
    if (idx === -1) return false;
    this.queue.splice(idx, 1);
    return true;
  }

  /**
   * Get next task to execute (highest priority, FIFO within same priority).
   * Returns null if no items in queue.
   */
  dequeueNext(): PriorityQueueItem | null {
    if (this.queue.length === 0) return null;
    if (!this.hasCapacity()) return null;
    const item = this.queue.shift()!;
    this.processing.set(item.taskId, item);
    return item;
  }

  /**
   * Mark task as started (move from queue to processing).
   * Returns false if task is not in queue.
   */
  startProcessing(taskId: string): boolean {
    const idx = this.queue.findIndex(item => item.taskId === taskId);
    if (idx === -1) return false;
    const [item] = this.queue.splice(idx, 1);
    this.processing.set(item.taskId, item);
    return true;
  }

  /**
   * Mark task as completed/failed (remove from processing).
   * Returns false if task was not being processed.
   */
  completeProcessing(taskId: string): boolean {
    return this.processing.delete(taskId);
  }

  /**
   * Check if we can accept more tasks (processing count < maxConcurrent).
   */
  hasCapacity(): boolean {
    return this.processing.size < this.maxConcurrent;
  }

  /**
   * Get the queue position for a task (0-based). Returns -1 if not in queue.
   */
  getQueuePosition(taskId: string): number {
    return this.queue.findIndex(item => item.taskId === taskId);
  }

  /**
   * Get comprehensive queue stats.
   */
  getStats(): {
    queueSize: number;
    processingCount: number;
    maxConcurrent: number;
    byPriority: Record<string, number>;
    queueItems: Array<{ taskId: string; priority: number; ruleId?: string; createdAt: number; position: number }>;
    processingItems: Array<{ taskId: string; priority: number; ruleId?: string; createdAt: number }>;
  } {
    const byPriority: Record<string, number> = {};
    for (const item of this.queue) {
      const key = String(item.priority);
      byPriority[key] = (byPriority[key] || 0) + 1;
    }

    return {
      queueSize: this.queue.length,
      processingCount: this.processing.size,
      maxConcurrent: this.maxConcurrent,
      byPriority,
      queueItems: this.queue.map((item, idx) => ({
        taskId: item.taskId,
        priority: item.priority,
        ruleId: item.ruleId,
        createdAt: item.createdAt,
        position: idx,
      })),
      processingItems: Array.from(this.processing.values()).map(item => ({
        taskId: item.taskId,
        priority: item.priority,
        ruleId: item.ruleId,
        createdAt: item.createdAt,
      })),
    };
  }

  /**
   * Get all queued items.
   */
  getQueue(): PriorityQueueItem[] {
    return [...this.queue];
  }

  /**
   * Get all processing items.
   */
  getProcessing(): PriorityQueueItem[] {
    return Array.from(this.processing.values());
  }

  /**
   * Reorder a task's priority. Returns false if task not found.
   */
  reprioritize(taskId: string, newPriority: number): boolean {
    const item = this.queue.find(i => i.taskId === taskId);
    if (!item) return false;
    item.priority = Math.max(0, Math.min(3, Math.floor(newPriority)));
    // Remove and re-insert at the correct position
    const idx = this.queue.indexOf(item);
    if (idx !== -1) this.queue.splice(idx, 1);
    this.insertSorted(item);
    return true;
  }

  /**
   * Set max concurrent tasks.
   */
  setMaxConcurrent(n: number): void {
    this.maxConcurrent = Math.max(1, Math.min(20, Math.floor(n)));
  }

  /** Check if a taskId is already known (queued or processing) */
  private isKnown(taskId: string): boolean {
    return this.queue.some(i => i.taskId === taskId) || this.processing.has(taskId);
  }

  /** Insert item at the correct position using binary search: O(log n) search + O(n) splice */
  private insertSorted(item: PriorityQueueItem): void {
    let lo = 0;
    let hi = this.queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const midItem = this.queue[mid];
      if (midItem.priority < item.priority ||
          (midItem.priority === item.priority && midItem.createdAt <= item.createdAt)) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    this.queue.splice(lo, 0, item);
  }
}

/** Singleton instance */
export const priorityQueue = new TaskPriorityQueue();
