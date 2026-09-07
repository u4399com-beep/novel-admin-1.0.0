/**
 * Request Queue with Priority and Domain Isolation
 *
 * A priority-based request queue that:
 *   - Orders requests by: priority (0-3) → domain → age
 *   - Ensures domain isolation: no two requests to same domain processed simultaneously
 *   - Respects per-domain rate limits from RateOptimizer
 *   - Has a global concurrency cap (default: 20)
 *   - Supports pausing/resuming per domain
 *   - Metrics: queue length, wait time, processing time
 */

import type { EngineType } from './types';
import { rateOptimizer } from './rate-optimizer';
import { logger } from './logger';

const log = logger.child('RequestQueue');

// ==================== Types ====================

export interface QueuedRequest {
  id: string;
  url: string;
  domain: string;
  /** Priority: 0 (critical) → 3 (low) */
  priority: number;
  /** Timestamp when request was enqueued */
  enqueuedAt: number;
  /** Engine to use for this request */
  engine: EngineType;
  /** Task ID that owns this request */
  taskId: string;
  /** Chapter or item index for progress tracking */
  index?: number;
  /** Custom metadata */
  metadata?: Record<string, unknown>;
}

export interface RequestQueueMetrics {
  totalQueued: number;
  totalProcessing: number;
  totalCompleted: number;
  totalFailed: number;
  avgWaitTimeMs: number;
  avgProcessingTimeMs: number;
  perDomain: Record<string, {
    queued: number;
    processing: number;
    completed: number;
    failed: number;
    avgProcessingTimeMs: number;
    isPaused: boolean;
  }>;
  globalConcurrency: number;
  maxConcurrency: number;
}

export interface ProcessingSlot {
  requestId: string;
  domain: string;
  startedAt: number;
}

// ==================== Constants ====================

const DEFAULT_MAX_CONCURRENCY = 20;
const MAX_QUEUE_SIZE = 10000;
const MAX_DOMAINS_TRACKED = 500;
const METRICS_WINDOW = 100; // Track last N items for averaging

// ==================== Domain-aware Priority Request Queue ====================

class DomainIsolatedRequestQueue {
  /** Pending requests, sorted by priority then age */
  private queue: QueuedRequest[] = [];
  /** Currently processing requests: domain → ProcessingSlot[] */
  private processing = new Map<string, ProcessingSlot[]>();
  /** Domains currently paused */
  private pausedDomains = new Set<string>();
  /** Domain pause reasons */
  private pauseReasons = new Map<string, string>();
  /** Completed request timings for metrics */
  private completedTimings: Array<{ waitMs: number; processMs: number }> = [];
  /** Map of requestId → { domain, enqueuedAt } for wait-time calculation */
  private requestMeta = new Map<string, { domain: string; enqueuedAt: number }>();
  /** Failed request count per domain */
  private failedCounts = new Map<string, number>();
  /** Total completed per domain */
  private completedCounts = new Map<string, number>();
  /** Request ID counter */
  private nextId = 0;
  /** Max global concurrency */
  private maxConcurrency: number;
  /** Event listeners for queue changes */
  private listeners: Array<(event: string, data: unknown) => void> = [];

  constructor(maxConcurrency: number = DEFAULT_MAX_CONCURRENCY) {
    this.maxConcurrency = maxConcurrency;
  }

  /**
   * Enqueue a request. Returns the request ID.
   */
  enqueue(request: Omit<QueuedRequest, 'id' | 'enqueuedAt'>): string {
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      // Evict lowest priority, oldest request
      this.queue.pop();
      log.warn('Queue full, evicted lowest priority request');
    }

    const id = `rq-${++this.nextId}`;
    const fullRequest: QueuedRequest = {
      ...request,
      id,
      enqueuedAt: Date.now(),
    };

    // Insert in sorted order: priority ascending (0 first), then by enqueuedAt (FIFO within priority)
    let insertIdx = this.queue.length;
    for (let i = 0; i < this.queue.length; i++) {
      if (fullRequest.priority < this.queue[i].priority ||
          (fullRequest.priority === this.queue[i].priority && fullRequest.enqueuedAt < this.queue[i].enqueuedAt)) {
        insertIdx = i;
        break;
      }
    }
    this.queue.splice(insertIdx, 0, fullRequest);

    // Store metadata for wait-time calculation in complete()
    this.requestMeta.set(id, { domain: request.domain, enqueuedAt: fullRequest.enqueuedAt });

    this.emit('enqueued', { requestId: id, domain: request.domain, priority: request.priority });
    return id;
  }

  /**
   * Dequeue the next request that can be processed.
   * Respects domain isolation and per-domain rate limits.
   * Returns null if no request can be started.
   */
  dequeue(): QueuedRequest | null {
    const now = Date.now();
    const globalProcessingCount = this.getTotalProcessing();

    if (globalProcessingCount >= this.maxConcurrency) {
      return null; // Global concurrency cap reached
    }

    // Find the highest-priority request that can be processed
    for (let i = 0; i < this.queue.length; i++) {
      const request = this.queue[i];
      const domain = request.domain;

      // Skip if domain is paused
      if (this.pausedDomains.has(domain)) {
        continue;
      }

      // Domain isolation: check if domain already has a request processing
      const domainSlots = this.processing.get(domain);
      if (domainSlots && domainSlots.length > 0) {
        // Per-domain rate limit check within domain isolation
        const domainDelay = rateOptimizer.getRequestDelay(domain);
        const lastSlot = domainSlots[domainSlots.length - 1];
        const elapsed = now - lastSlot.startedAt;
        if (elapsed < domainDelay) {
          continue; // Rate limit not yet satisfied
        }
        // Allow concurrent processing for same domain after rate delay
        // But limit to 1 concurrent per domain by default
        continue;
      }

      // This request can be processed — remove from queue
      this.queue.splice(i, 1);

      // Mark as processing
      if (!this.processing.has(domain)) {
        this.processing.set(domain, []);
      }
      this.processing.get(domain)!.push({
        requestId: request.id,
        domain,
        startedAt: now,
      });

      this.emit('started', { requestId: request.id, domain, priority: request.priority, waitMs: now - request.enqueuedAt });
      return request;
    }

    return null; // No request can be started (all blocked by domain isolation or rate limits)
  }

  /**
   * Mark a request as completed.
   */
  complete(requestId: string, domain: string, success: boolean): void {
    const now = Date.now();
    const slots = this.processing.get(domain);
    if (slots) {
      const slotIdx = slots.findIndex(s => s.requestId === requestId);
      if (slotIdx >= 0) {
        const slot = slots[slotIdx];
        const processMs = now - slot.startedAt;

        // Compute wait time from enqueuedAt
        const meta = this.requestMeta.get(requestId);
        const waitMs = meta ? (slot.startedAt - meta.enqueuedAt) : 0;
        this.requestMeta.delete(requestId);

        slots.splice(slotIdx, 1);
        if (slots.length === 0) {
          this.processing.delete(domain);
        }

        this.completedTimings.push({ waitMs, processMs });
        if (this.completedTimings.length > METRICS_WINDOW) {
          this.completedTimings.shift();
        }
      }
    }

    if (success) {
      const count = this.completedCounts.get(domain) || 0;
      this.completedCounts.set(domain, count + 1);
      this.emit('completed', { requestId, domain });
    } else {
      const count = this.failedCounts.get(domain) || 0;
      this.failedCounts.set(domain, count + 1);
      this.emit('failed', { requestId, domain });
    }

    // Prune domain tracking maps if over limit
    if (this.completedCounts.size > MAX_DOMAINS_TRACKED || this.failedCounts.size > MAX_DOMAINS_TRACKED) {
      this.pruneDomainCounts();
    }
  }

  /**
   * Pause processing for a specific domain.
   */
  pauseDomain(domain: string, reason?: string): void {
    this.pausedDomains.add(domain);
    this.pauseReasons.set(domain, reason || 'manual');
    log.info(`Domain ${domain} paused: ${reason || 'manual'}`);
    this.emit('domain-paused', { domain, reason });
  }

  /**
   * Resume processing for a specific domain.
   */
  resumeDomain(domain: string): void {
    this.pausedDomains.delete(domain);
    this.pauseReasons.delete(domain);
    log.info(`Domain ${domain} resumed`);
    this.emit('domain-resumed', { domain });
  }

  /**
   * Check if a domain is paused.
   */
  isDomainPaused(domain: string): boolean {
    return this.pausedDomains.has(domain);
  }

  /**
   * Get pause reason for a domain.
   */
  getPauseReason(domain: string): string | undefined {
    return this.pauseReasons.get(domain);
  }

  /**
   * Remove all requests for a specific task.
   */
  clearTaskRequests(taskId: string): number {
    const before = this.queue.length;
    this.queue = this.queue.filter(r => r.taskId !== taskId);
    return before - this.queue.length;
  }

  /**
   * Prune domain tracking maps for inactive domains.
   */
  private pruneDomainCounts(): void {
    const activeDomains = new Set<string>();
    for (const r of this.queue) activeDomains.add(r.domain);
    for (const d of this.processing.keys()) activeDomains.add(d);

    for (const domain of this.completedCounts.keys()) {
      if (!activeDomains.has(domain)) this.completedCounts.delete(domain);
    }
    for (const domain of this.failedCounts.keys()) {
      if (!activeDomains.has(domain)) this.failedCounts.delete(domain);
    }
  }

  /**
   * Get total number of requests currently processing.
   */
  private getTotalProcessing(): number {
    let total = 0;
    for (const slots of this.processing.values()) {
      total += slots.length;
    }
    return total;
  }

  /**
   * Get queue length.
   */
  get length(): number {
    return this.queue.length;
  }

  /**
   * Get all queued requests (for inspection).
   */
  getQueuedRequests(): QueuedRequest[] {
    return [...this.queue];
  }

  /**
   * Get processing slots for all domains.
   */
  getProcessingSlots(): Map<string, ProcessingSlot[]> {
    return new Map(this.processing);
  }

  /**
   * Get comprehensive metrics.
   */
  getMetrics(): RequestQueueMetrics {
    const now = Date.now();
    const perDomain: RequestQueueMetrics['perDomain'] = {};

    // Collect all domains
    const allDomains = new Set<string>();
    for (const r of this.queue) allDomains.add(r.domain);
    for (const d of this.processing.keys()) allDomains.add(d);

    for (const domain of allDomains) {
      const queued = this.queue.filter(r => r.domain === domain).length;
      const processing = this.processing.get(domain)?.length ?? 0;
      perDomain[domain] = {
        queued,
        processing,
        completed: this.completedCounts.get(domain) ?? 0,
        failed: this.failedCounts.get(domain) ?? 0,
        avgProcessingTimeMs: 0, // Computed below
        isPaused: this.pausedDomains.has(domain),
      };
    }

    // Compute average timings
    const avgWaitMs = this.completedTimings.length > 0
      ? Math.round(this.completedTimings.reduce((s, t) => s + t.waitMs, 0) / this.completedTimings.length)
      : 0;
    const avgProcessMs = this.completedTimings.length > 0
      ? Math.round(this.completedTimings.reduce((s, t) => s + t.processMs, 0) / this.completedTimings.length)
      : 0;

    // Per-domain avg processing time (simplified: use global average)
    for (const domain of Object.keys(perDomain)) {
      perDomain[domain].avgProcessingTimeMs = avgProcessMs;
    }

    return {
      totalQueued: this.queue.length,
      totalProcessing: this.getTotalProcessing(),
      totalCompleted: this.completedTimings.length,
      totalFailed: Array.from(this.failedCounts.values()).reduce((s, c) => s + c, 0),
      avgWaitTimeMs: avgWaitMs,
      avgProcessingTimeMs: avgProcessMs,
      perDomain,
      globalConcurrency: this.getTotalProcessing(),
      maxConcurrency: this.maxConcurrency,
    };
  }

  /**
   * Set max concurrency.
   */
  setMaxConcurrency(max: number): void {
    this.maxConcurrency = Math.max(1, max);
  }

  /**
   * Add event listener.
   */
  on(listener: (event: string, data: unknown) => void): void {
    this.listeners.push(listener);
  }

  /**
   * Remove event listener.
   */
  off(listener: (event: string, data: unknown) => void): void {
    const idx = this.listeners.indexOf(listener);
    if (idx >= 0) this.listeners.splice(idx, 1);
  }

  private emit(event: string, data: unknown): void {
    for (const listener of this.listeners) {
      try { listener(event, data); } catch {}
    }
  }
}

// Singleton
export const requestQueue = new DomainIsolatedRequestQueue();
