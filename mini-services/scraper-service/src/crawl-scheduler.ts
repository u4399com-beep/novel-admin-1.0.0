/**
 * Smart Crawl Scheduling
 *
 * Implements domain-aware rate limiting, crawl priority ordering,
 * and crawl budgets per domain to prevent over-scraping.
 */

// ==================== Types ====================

export type CrawlPriority = 'critical' | 'high' | 'normal' | 'low' | 'background';

export interface CrawlJob {
  /** Unique job identifier */
  id: string;
  /** Target URL */
  url: string;
  /** Domain hostname */
  domain: string;
  /** Priority level */
  priority: CrawlPriority;
  /** Job type for priority inference */
  type: 'new_chapter' | 'full_book' | 'category_list' | 'search' | 'update_check';
  /** Creation timestamp */
  createdAt: number;
  /** Estimated content size (for budget tracking) */
  estimatedSize?: number;
  /** Rule ID this job belongs to */
  ruleId?: string;
}

export interface DomainCrawlBudget {
  /** Maximum requests allowed per hour */
  maxRequestsPerHour: number;
  /** Maximum bytes allowed per hour */
  maxBytesPerHour: number;
  /** Current request count in the hour window */
  currentRequestCount: number;
  /** Current byte count in the hour window */
  currentByteCount: number;
  /** Window start timestamp */
  windowStart: number;
  /** Minimum delay between requests (ms) */
  minDelayMs: number;
}

export interface CrawlScheduleConfig {
  /** Default max requests per domain per hour */
  defaultMaxRequestsPerHour: number;
  /** Default max bytes per domain per hour */
  defaultMaxBytesPerHour: number;
  /** Default minimum delay between requests (ms) */
  defaultMinDelayMs: number;
  /** Maximum concurrent jobs per domain */
  maxConcurrentPerDomain: number;
  /** Maximum total concurrent jobs */
  maxTotalConcurrent: number;
}

// ==================== Priority Ordering ====================

const PRIORITY_WEIGHT: Record<CrawlPriority, number> = {
  critical: 100,
  high: 75,
  normal: 50,
  low: 25,
  background: 10,
};

const TYPE_PRIORITY: Record<CrawlJob['type'], CrawlPriority> = {
  new_chapter: 'high',
  full_book: 'normal',
  category_list: 'low',
  search: 'critical',
  update_check: 'background',
};

/**
 * Infer crawl priority from job type.
 */
export function inferPriority(type: CrawlJob['type']): CrawlPriority {
  return TYPE_PRIORITY[type];
}

/**
 * Compare two crawl jobs for priority ordering.
 * Higher priority comes first. Within same priority, earlier creation comes first.
 */
export function compareCrawlPriority(a: CrawlJob, b: CrawlJob): number {
  const weightDiff = PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority];
  if (weightDiff !== 0) return weightDiff;
  // Earlier jobs have higher priority (FIFO within same priority)
  return a.createdAt - b.createdAt;
}

// ==================== Domain Crawl Budget ====================

const DEFAULT_CONFIG: CrawlScheduleConfig = {
  defaultMaxRequestsPerHour: 200,
  defaultMaxBytesPerHour: 100 * 1024 * 1024, // 100MB
  defaultMinDelayMs: 1000,
  maxConcurrentPerDomain: 3,
  maxTotalConcurrent: 20,
};

/** Per-domain budget overrides (e.g., for aggressive or conservative sites) */
const domainBudgetOverrides = new Map<string, Partial<DomainCrawlBudget>>();
const MAX_OVERRIDES = 200;

class CrawlScheduler {
  private budgets = new Map<string, DomainCrawlBudget>();
  private lastRequestTime = new Map<string, number>();
  private config: CrawlScheduleConfig;
  private inFlightCount = new Map<string, number>(); // domain -> count
  private totalInFlight = 0;

  constructor(config?: Partial<CrawlScheduleConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Set a domain-specific budget override.
   */
  setDomainBudget(domain: string, override: Partial<DomainCrawlBudget>): void {
    const normalized = domain.toLowerCase().replace(/^www\./, '');
    if (domainBudgetOverrides.size >= MAX_OVERRIDES && !domainBudgetOverrides.has(normalized)) {
      const first = domainBudgetOverrides.keys().next().value;
      if (first !== undefined) domainBudgetOverrides.delete(first);
    }
    domainBudgetOverrides.set(normalized, override);
  }

  /**
   * Get or create the crawl budget for a domain.
   */
  private getBudget(domain: string): DomainCrawlBudget {
    let budget = this.budgets.get(domain);
    const now = Date.now();

    if (budget) {
      // Reset window if hour has passed
      if (now - budget.windowStart >= 3600_000) {
        budget.currentRequestCount = 0;
        budget.currentByteCount = 0;
        budget.windowStart = now;
      }
      return budget;
    }

    // Create new budget with defaults + overrides
    const override = domainBudgetOverrides.get(domain);
    budget = {
      maxRequestsPerHour: override?.maxRequestsPerHour ?? this.config.defaultMaxRequestsPerHour,
      maxBytesPerHour: override?.maxBytesPerHour ?? this.config.defaultMaxBytesPerHour,
      currentRequestCount: 0,
      currentByteCount: 0,
      windowStart: now,
      minDelayMs: override?.minDelayMs ?? this.config.defaultMinDelayMs,
    };
    this.budgets.set(domain, budget);
    return budget;
  }

  /**
   * Check if a crawl job can be scheduled now.
   * Returns { allowed: true } or { allowed: false, waitGreason, waitMs }.
   */
  canSchedule(job: CrawlJob): { allowed: true } | { allowed: false; reason: string; waitMs: number } {
    // 1. Check total concurrent limit
    if (this.totalInFlight >= this.config.maxTotalConcurrent) {
      return { allowed: false, reason: 'Total concurrent limit reached', waitMs: 1000 };
    }

    // 2. Check per-domain concurrent limit
    const domainInFlight = this.inFlightCount.get(job.domain) || 0;
    if (domainInFlight >= this.config.maxConcurrentPerDomain) {
      return { allowed: false, reason: `Domain concurrent limit (${domainInFlight}/${this.config.maxConcurrentPerDomain})`, waitMs: 2000 };
    }

    // 3. Check domain crawl budget
    const budget = this.getBudget(job.domain);
    if (budget.currentRequestCount >= budget.maxRequestsPerHour) {
      const waitMs = Math.max(0, budget.windowStart + 3600_000 - Date.now());
      return { allowed: false, reason: `Domain request budget exhausted (${budget.currentRequestCount}/${budget.maxRequestsPerHour}/hr)`, waitMs: waitMs || 60000 };
    }

    // 4. Check minimum delay between requests
    const lastTime = this.lastRequestTime.get(job.domain);
    if (lastTime) {
      const elapsed = Date.now() - lastTime;
      if (elapsed < budget.minDelayMs) {
        return { allowed: false, reason: 'Min delay not met', waitMs: budget.minDelayMs - elapsed };
      }
    }

    return { allowed: true };
  }

  /**
   * Mark a job as started (increments in-flight counts).
   */
  markStarted(job: CrawlJob): void {
    const count = this.inFlightCount.get(job.domain) || 0;
    this.inFlightCount.set(job.domain, count + 1);
    this.totalInFlight++;

    // Update budget
    const budget = this.getBudget(job.domain);
    budget.currentRequestCount++;
    this.lastRequestTime.set(job.domain, Date.now());
  }

  /**
   * Mark a job as completed (decrements in-flight counts, updates budget).
   */
  markCompleted(job: CrawlJob, bytesDownloaded: number): void {
    const count = this.inFlightCount.get(job.domain) || 0;
    this.inFlightCount.set(job.domain, Math.max(0, count - 1));
    this.totalInFlight = Math.max(0, this.totalInFlight - 1);

    // Update byte budget
    const budget = this.getBudget(job.domain);
    budget.currentByteCount += bytesDownloaded;
  }

  /**
   * Sort a list of crawl jobs by priority.
   */
  sortJobs<T extends CrawlJob>(jobs: T[]): T[] {
    return [...jobs].sort(compareCrawlPriority);
  }

  /**
   * Get the next allowed jobs up to the given limit.
   * Only returns jobs that can be scheduled now.
   */
  getNextAllowedJobs<T extends CrawlJob>(jobs: T[], limit: number): T[] {
    const sorted = this.sortJobs(jobs);
    const result: T[] = [];

    for (const job of sorted) {
      if (result.length >= limit) break;
      const check = this.canSchedule(job);
      if (check.allowed) {
        result.push(job);
      }
    }

    return result;
  }

  /**
   * Get crawl budget stats for monitoring.
   */
  getBudgetStats(): Record<string, { requestCount: number; maxRequests: number; byteCount: number; maxBytes: number; budgetRemaining: number }> {
    const result: Record<string, { requestCount: number; maxRequests: number; byteCount: number; maxBytes: number; budgetRemaining: number }> = {};
    for (const [domain, budget] of this.budgets) {
      const remaining = Math.max(0, budget.maxRequestsPerHour - budget.currentRequestCount);
      result[domain] = {
        requestCount: budget.currentRequestCount,
        maxRequests: budget.maxRequestsPerHour,
        byteCount: budget.currentByteCount,
        maxBytes: budget.maxBytesPerHour,
        budgetRemaining: remaining,
      };
    }
    return result;
  }

  /**
   * Reset all budgets and in-flight tracking.
   */
  reset(): void {
    this.budgets.clear();
    this.lastRequestTime.clear();
    this.inFlightCount.clear();
    this.totalInFlight = 0;
  }
}

// Singleton export
export const crawlScheduler = new CrawlScheduler();
