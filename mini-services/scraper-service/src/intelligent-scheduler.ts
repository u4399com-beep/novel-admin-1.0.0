/**
 * Intelligent Crawl Scheduler
 *
 * Advanced scheduling system that goes beyond basic priority ordering.
 * Combines multiple scheduling strategies:
 *
 *   1. Priority-based: new novels first, then updates, then re-crawl
 *   2. Domain-aware: respect per-domain limits globally across all queues
 *   3. Time-window: spread requests across time to avoid burst patterns
 *   4. Adaptive: speed up on easy domains, slow down on hard ones
 *   5. Deadline-aware: prioritize tasks near their freshness deadline
 *   6. Resource-aware: pause scheduling when memory/CPU usage is high
 */

import { logger } from './logger';
const log = logger.child('IntelligentScheduler');

// ==================== Types ====================

export type TaskPriority = 'critical' | 'high' | 'normal' | 'low' | 'background';

export interface ScheduledTask {
  /** Unique task identifier */
  id: string;
  /** Target URL */
  url: string;
  /** Domain hostname */
  domain: string;
  /** Priority level */
  priority: TaskPriority;
  /** Task category */
  category: 'new_novel' | 'new_chapter' | 'update_check' | 'full_crawl' | 're_crawl' | 'search';
  /** Creation timestamp (ms) */
  createdAt: number;
  /** Freshness deadline: task should be completed before this timestamp */
  deadline?: number;
  /** Estimated duration (ms) */
  estimatedDuration?: number;
  /** Rule ID this task belongs to */
  ruleId?: string;
  /** Retry count */
  retryCount: number;
  /** Maximum retries */
  maxRetries: number;
}

export interface DomainScheduleState {
  domain: string;
  /** Current effective requests-per-minute limit */
  effectiveRPM: number;
  /** Last request timestamp */
  lastRequestTime: number;
  /** Request timestamps in current window (for rate tracking) */
  recentRequests: number[];
  /** Consecutive successes (for adaptive speed-up) */
  consecutiveSuccesses: number;
  /** Consecutive failures (for adaptive slow-down) */
  consecutiveFailures: number;
  /** Average response time (ms) */
  avgResponseTime: number;
  /** Whether this domain is considered "easy" (no anti-crawl) */
  isEasy: boolean;
  /** Current backoff multiplier (1.0 = normal, >1 = slowed) */
  backoffMultiplier: number;
}

export interface ResourceState {
  /** Current memory usage in bytes */
  memoryUsageBytes: number;
  /** Maximum memory threshold in bytes */
  memoryThresholdBytes: number;
  /** Current CPU usage (0-1) */
  cpuUsage: number;
  /** Maximum CPU threshold (0-1) */
  cpuThreshold: number;
  /** Whether scheduling is paused due to resource pressure */
  isPaused: boolean;
  /** Reason for pause */
  pauseReason: string | null;
}

export interface SchedulerMetrics {
  /** Total tasks scheduled */
  totalScheduled: number;
  /** Total tasks completed */
  totalCompleted: number;
  /** Total tasks failed */
  totalFailed: number;
  /** Average wait time in queue (ms) */
  avgWaitTime: number;
  /** Current queue depth */
  queueDepth: number;
  /** Number of domains being tracked */
  domainCount: number;
  /** Scheduling efficiency (completed / scheduled) */
  efficiency: number;
}

// ==================== Constants ====================

const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
  critical: 100,
  high: 75,
  normal: 50,
  low: 25,
  background: 10,
};

const CATEGORY_PRIORITY: Record<ScheduledTask['category'], TaskPriority> = {
  new_novel: 'critical',
  new_chapter: 'high',
  search: 'critical',
  update_check: 'normal',
  full_crawl: 'low',
  re_crawl: 'background',
};

const DEFAULT_RPM = 30;
const MIN_RPM = 1;
const MAX_RPM = 120;
const EASY_DOMAIN_RPM_BONUS = 20;
const HARD_DOMAIN_RPM_PENALTY = 10;
const WINDOW_MS = 60_000;
const MAX_DOMAINS = 500;
const MAX_QUEUE_SIZE = 10_000;
const DEADLINE_URGENCY_MS = 5 * 60_000; // 5 minutes before deadline = urgent
const MAX_RESPONSE_TIME_SAMPLES = 50;

// ==================== Resource Monitoring ====================

function getProcessMemoryUsage(): number {
  // Bun / Node.js process.memoryUsage()
  const mem = process.memoryUsage();
  return mem.rss;
}

// ==================== IntelligentScheduler ====================

class IntelligentScheduler {
  /** Task queue sorted by computed priority score */
  private queue: ScheduledTask[] = [];
  /** Per-domain scheduling state */
  private domains = new Map<string, DomainScheduleState>();
  /** Resource monitoring state */
  private resourceState: ResourceState;
  /** Scheduling metrics */
  private metrics: SchedulerMetrics;
  /** Time-window: minimum interval between requests to same domain */
  private minDomainIntervalMs: number;
  /** Maximum global concurrent requests */
  private maxGlobalConcurrent: number;
  /** Current global concurrent count */
  private globalConcurrent = 0;
  /** Per-domain concurrent count */
  private domainConcurrent = new Map<string, number>();
  /** Maximum per-domain concurrent */
  private maxDomainConcurrent: number;
  /** Default memory threshold (256MB) */
  private memoryThreshold: number;
  /** Default CPU threshold */
  private cpuThreshold: number;

  constructor(options?: {
    minDomainIntervalMs?: number;
    maxGlobalConcurrent?: number;
    maxDomainConcurrent?: number;
    memoryThresholdBytes?: number;
    cpuThreshold?: number;
  }) {
    this.minDomainIntervalMs = options?.minDomainIntervalMs ?? 1000;
    this.maxGlobalConcurrent = options?.maxGlobalConcurrent ?? 20;
    this.maxDomainConcurrent = options?.maxDomainConcurrent ?? 3;
    this.memoryThreshold = options?.memoryThresholdBytes ?? 256 * 1024 * 1024;
    this.cpuThreshold = options?.cpuThreshold ?? 0.85;

    this.resourceState = {
      memoryUsageBytes: 0,
      memoryThresholdBytes: this.memoryThreshold,
      cpuUsage: 0,
      cpuThreshold: this.cpuThreshold,
      isPaused: false,
      pauseReason: null,
    };

    this.metrics = {
      totalScheduled: 0,
      totalCompleted: 0,
      totalFailed: 0,
      avgWaitTime: 0,
      queueDepth: 0,
      domainCount: 0,
      efficiency: 0,
    };
  }

  // ── Task Scheduling ──

  /**
   * Add a task to the scheduling queue.
   * Assigns inferred priority from category if not set.
   */
  enqueue(task: ScheduledTask): boolean {
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      log.warn(`Queue full (${MAX_QUEUE_SIZE}), rejecting task ${task.id}`);
      return false;
    }

    // Infer priority from category if not explicitly critical
    if (task.priority === 'normal' && CATEGORY_PRIORITY[task.category] !== 'normal') {
      task.priority = CATEGORY_PRIORITY[task.category];
    }

    this.queue.push(task);
    this.metrics.totalScheduled++;
    this.metrics.queueDepth = this.queue.length;

    // Ensure domain state exists
    this.getOrCreateDomain(task.domain);

    return true;
  }

  /**
   * Add multiple tasks to the queue.
   */
  enqueueBatch(tasks: ScheduledTask[]): number {
    let added = 0;
    for (const task of tasks) {
      if (this.enqueue(task)) added++;
    }
    return added;
  }

  /**
   * Get the next task(s) that can be scheduled now.
   * Applies all scheduling strategies: priority, domain-aware, time-window,
   * adaptive, deadline, resource-aware.
   *
   * @param limit - Maximum number of tasks to return
   * @returns Array of tasks that can be started immediately
   */
  dequeue(limit: number = 1): ScheduledTask[] {
    // 1. Check resource pressure
    this.updateResourceState();
    if (this.resourceState.isPaused) {
      log.info(`Scheduling paused: ${this.resourceState.pauseReason}`);
      return [];
    }

    // 2. Check global concurrent limit
    if (this.globalConcurrent >= this.maxGlobalConcurrent) {
      return [];
    }

    // 3. Sort queue by computed scheduling score
    this.sortQueue();

    // 4. Select tasks that can run now
    const selected: ScheduledTask[] = [];
    const now = Date.now();

    for (const task of this.queue) {
      if (selected.length >= limit) break;
      if (this.globalConcurrent + selected.length >= this.maxGlobalConcurrent) break;

      // Check domain concurrent limit
      const domainConcurrent = this.domainConcurrent.get(task.domain) || 0;
      if (domainConcurrent >= this.maxDomainConcurrent) continue;

      // Check domain time-window (minimum interval)
      const domainState = this.domains.get(task.domain);
      if (domainState) {
        const elapsed = now - domainState.lastRequestTime;
        const minInterval = this.minDomainIntervalMs * domainState.backoffMultiplier;
        if (elapsed < minInterval) continue;

        // Check domain RPM limit
        const windowStart = now - WINDOW_MS;
        const recentCount = domainState.recentRequests.filter(t => t > windowStart).length;
        if (recentCount >= domainState.effectiveRPM) continue;
      }

      selected.push(task);
    }

    // Remove selected tasks from queue
    if (selected.length > 0) {
      const selectedIds = new Set(selected.map(t => t.id));
      this.queue = this.queue.filter(t => !selectedIds.has(t.id));
      this.metrics.queueDepth = this.queue.length;

      // Mark as in-flight
      for (const task of selected) {
        this.globalConcurrent++;
        const dc = this.domainConcurrent.get(task.domain) || 0;
        this.domainConcurrent.set(task.domain, dc + 1);

        const domainState = this.domains.get(task.domain);
        if (domainState) {
          domainState.lastRequestTime = now;
          domainState.recentRequests.push(now);
          // Trim old timestamps
          const windowStart = now - WINDOW_MS * 2;
          domainState.recentRequests = domainState.recentRequests.filter(t => t > windowStart);
        }

        // Track wait time
        const waitTime = now - task.createdAt;
        this.metrics.avgWaitTime = this.metrics.avgWaitTime * 0.95 + waitTime * 0.05;
      }
    }

    return selected;
  }

  /**
   * Report task completion. Adjusts adaptive scheduling.
   */
  reportCompletion(task: ScheduledTask, responseTimeMs: number, success: boolean): void {
    this.globalConcurrent = Math.max(0, this.globalConcurrent - 1);
    const dc = this.domainConcurrent.get(task.domain) || 0;
    this.domainConcurrent.set(task.domain, Math.max(0, dc - 1));

    const domainState = this.domains.get(task.domain);
    if (!domainState) return;

    // Update response time (exponential moving average)
    domainState.avgResponseTime = domainState.avgResponseTime * 0.8 + responseTimeMs * 0.2;

    if (success) {
      this.metrics.totalCompleted++;
      domainState.consecutiveSuccesses++;
      domainState.consecutiveFailures = 0;

      // Adaptive speed-up: if domain has been easy for a while, increase RPM
      if (domainState.consecutiveSuccesses >= 10 && !domainState.isEasy) {
        domainState.isEasy = true;
        domainState.effectiveRPM = Math.min(MAX_RPM, domainState.effectiveRPM + EASY_DOMAIN_RPM_BONUS);
        log.info(`Domain ${task.domain} marked as easy, RPM → ${domainState.effectiveRPM}`);
      } else if (domainState.isEasy && domainState.consecutiveSuccesses % 20 === 0) {
        // Continue speeding up easy domains gradually
        domainState.effectiveRPM = Math.min(MAX_RPM, domainState.effectiveRPM + 2);
      }

      // Reduce backoff on success
      if (domainState.backoffMultiplier > 1.0) {
        domainState.backoffMultiplier = Math.max(1.0, domainState.backoffMultiplier * 0.9);
      }
    } else {
      this.metrics.totalFailed++;
      domainState.consecutiveFailures++;
      domainState.consecutiveSuccesses = 0;

      // Adaptive slow-down: increase backoff, reduce RPM
      domainState.backoffMultiplier = Math.min(10, domainState.backoffMultiplier * 1.5);

      if (domainState.consecutiveFailures >= 3) {
        domainState.isEasy = false;
        domainState.effectiveRPM = Math.max(MIN_RPM, domainState.effectiveRPM - HARD_DOMAIN_RPM_PENALTY);
        log.info(`Domain ${task.domain} marked as hard, RPM → ${domainState.effectiveRPM}, backoff ×${domainState.backoffMultiplier.toFixed(1)}`);
      }
    }

    // Update efficiency metric
    if (this.metrics.totalScheduled > 0) {
      this.metrics.efficiency = this.metrics.totalCompleted / this.metrics.totalScheduled;
    }
  }

  // ── Scheduling Score Computation ──

  /**
   * Compute a scheduling score for a task. Higher score = scheduled sooner.
   * Combines: base priority + deadline urgency + age bonus + retry penalty.
   */
  private computeScheduleScore(task: ScheduledTask): number {
    const now = Date.now();
    let score = PRIORITY_WEIGHT[task.priority];

    // Deadline urgency: tasks near their deadline get a significant boost
    if (task.deadline) {
      const timeUntilDeadline = task.deadline - now;
      if (timeUntilDeadline <= 0) {
        // Overdue! Maximum urgency
        score += 200;
      } else if (timeUntilDeadline <= DEADLINE_URGENCY_MS) {
        // Approaching deadline: boost proportional to urgency
        const urgencyRatio = 1 - (timeUntilDeadline / DEADLINE_URGENCY_MS);
        score += Math.round(urgencyRatio * 100);
      } else if (timeUntilDeadline <= DEADLINE_URGENCY_MS * 3) {
        // Getting close: small boost
        score += 20;
      }
    }

    // Age bonus: tasks that have been waiting longer get a small boost
    // (prevents starvation of low-priority tasks)
    const ageMs = now - task.createdAt;
    const ageMinutes = ageMs / 60_000;
    score += Math.min(30, Math.floor(ageMinutes)); // Max +30 for 30+ min wait

    // Retry penalty: heavily retried tasks get lower priority
    score -= Math.min(50, task.retryCount * 10);

    // Domain backoff: penalize tasks for domains with high backoff
    const domainState = this.domains.get(task.domain);
    if (domainState && domainState.backoffMultiplier > 1.0) {
      score -= Math.min(40, Math.floor((domainState.backoffMultiplier - 1) * 20));
    }

    return score;
  }

  /**
   * Sort the queue by computed scheduling score (highest first).
   */
  private sortQueue(): void {
    // Compute scores and sort (stable sort preserves insertion order for equal scores)
    const scored = this.queue.map(task => ({
      task,
      score: this.computeScheduleScore(task),
    }));
    scored.sort((a, b) => b.score - a.score);
    this.queue = scored.map(s => s.task);
  }

  // ── Resource Monitoring ──

  /**
   * Update resource state and check for pressure.
   */
  private updateResourceState(): void {
    this.resourceState.memoryUsageBytes = getProcessMemoryUsage();
    // CPU estimation: ratio of active domains to max concurrent
    this.resourceState.cpuUsage = Math.min(1, this.globalConcurrent / this.maxGlobalConcurrent);

    const wasPaused = this.resourceState.isPaused;

    // Check memory pressure
    if (this.resourceState.memoryUsageBytes > this.resourceState.memoryThresholdBytes) {
      this.resourceState.isPaused = true;
      this.resourceState.pauseReason = `Memory pressure: ${(this.resourceState.memoryUsageBytes / 1024 / 1024).toFixed(0)}MB > threshold ${(this.resourceState.memoryThresholdBytes / 1024 / 1024).toFixed(0)}MB`;
    }
    // Check CPU pressure
    else if (this.resourceState.cpuUsage > this.resourceState.cpuThreshold) {
      this.resourceState.isPaused = true;
      this.resourceState.pauseReason = `CPU pressure: ${(this.resourceState.cpuUsage * 100).toFixed(0)}% > threshold ${(this.resourceState.cpuThreshold * 100).toFixed(0)}%`;
    }
    // Recover from pause when pressure eases (with hysteresis: recover at 80% of threshold)
    else if (this.resourceState.isPaused) {
      const memOk = this.resourceState.memoryUsageBytes < this.resourceState.memoryThresholdBytes * 0.8;
      const cpuOk = this.resourceState.cpuUsage < this.resourceState.cpuThreshold * 0.8;
      if (memOk && cpuOk) {
        this.resourceState.isPaused = false;
        this.resourceState.pauseReason = null;
        log.info('Resource pressure eased, resuming scheduling');
      }
    }

    if (!wasPaused && this.resourceState.isPaused) {
      log.warn(`Scheduling paused: ${this.resourceState.pauseReason}`);
    }
  }

  // ── Domain State Management ──

  private getOrCreateDomain(domain: string): DomainScheduleState {
    let state = this.domains.get(domain);
    if (!state) {
      // Evict oldest inactive domain if map is full
      if (this.domains.size >= MAX_DOMAINS) {
        let oldestDomain = '';
        let oldestTime = Infinity;
        for (const [d, s] of this.domains) {
          if (s.lastRequestTime < oldestTime && (this.domainConcurrent.get(d) || 0) === 0) {
            oldestTime = s.lastRequestTime;
            oldestDomain = d;
          }
        }
        if (oldestDomain) this.domains.delete(oldestDomain);
      }

      state = {
        domain,
        effectiveRPM: DEFAULT_RPM,
        lastRequestTime: 0,
        recentRequests: [],
        consecutiveSuccesses: 0,
        consecutiveFailures: 0,
        avgResponseTime: 1000,
        isEasy: false,
        backoffMultiplier: 1.0,
      };
      this.domains.set(domain, state);
      this.metrics.domainCount = this.domains.size;
    }
    return state;
  }

  /**
   * Manually set a domain's RPM limit.
   */
  setDomainRPM(domain: string, rpm: number): void {
    const state = this.getOrCreateDomain(domain);
    state.effectiveRPM = Math.max(MIN_RPM, Math.min(MAX_RPM, rpm));
  }

  /**
   * Mark a domain as "easy" (no anti-crawl) for faster scheduling.
   */
  markDomainEasy(domain: string): void {
    const state = this.getOrCreateDomain(domain);
    state.isEasy = true;
    state.effectiveRPM = Math.min(MAX_RPM, state.effectiveRPM + EASY_DOMAIN_RPM_BONUS);
    state.backoffMultiplier = 1.0;
  }

  /**
   * Mark a domain as "hard" (aggressive anti-crawl) for slower scheduling.
   */
  markDomainHard(domain: string): void {
    const state = this.getOrCreateDomain(domain);
    state.isEasy = false;
    state.effectiveRPM = Math.max(MIN_RPM, state.effectiveRPM - HARD_DOMAIN_RPM_PENALTY);
    state.backoffMultiplier = Math.min(10, state.backoffMultiplier * 2);
  }

  // ── Getters ──

  getQueueSize(): number { return this.queue.length; }
  getGlobalConcurrent(): number { return this.globalConcurrent; }
  getResourceState(): ResourceState { return { ...this.resourceState }; }
  getMetrics(): SchedulerMetrics { return { ...this.metrics, queueDepth: this.queue.length, domainCount: this.domains.size }; }

  getDomainState(domain: string): DomainScheduleState | undefined {
    const state = this.domains.get(domain);
    return state ? { ...state, recentRequests: [...state.recentRequests] } : undefined;
  }

  getAllDomainStates(): DomainScheduleState[] {
    return Array.from(this.domains.values()).map(s => ({ ...s, recentRequests: [...s.recentRequests] }));
  }

  /**
   * Get tasks currently in the queue (for monitoring/debugging).
   * Returns a copy, limited to the first `limit` tasks.
   */
  peekQueue(limit: number = 20): ScheduledTask[] {
    return this.queue.slice(0, limit);
  }

  /**
   * Remove a specific task from the queue.
   */
  removeTask(taskId: string): boolean {
    const idx = this.queue.findIndex(t => t.id === taskId);
    if (idx === -1) return false;
    this.queue.splice(idx, 1);
    this.metrics.queueDepth = this.queue.length;
    return true;
  }

  /**
   * Clear all tasks from the queue.
   */
  clearQueue(): void {
    this.queue.length = 0;
    this.metrics.queueDepth = 0;
  }

  /**
   * Reset all scheduler state.
   */
  reset(): void {
    this.queue.length = 0;
    this.domains.clear();
    this.domainConcurrent.clear();
    this.globalConcurrent = 0;
    this.metrics = {
      totalScheduled: 0,
      totalCompleted: 0,
      totalFailed: 0,
      avgWaitTime: 0,
      queueDepth: 0,
      domainCount: 0,
      efficiency: 0,
    };
  }
}

// Singleton export
export const intelligentScheduler = new IntelligentScheduler();
