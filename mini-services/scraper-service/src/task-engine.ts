/**
 * Task Execution Engine
 * Orchestrates full scraping tasks: list → book info → chapters → content
 * Enhanced with: request queue, engine selection, proxy support, better retry
 */

import type {
  ScrapeRule, ScrapeTask, Selector, Pagination, AntiCrawl,
  EngineType, CleanRequest,
} from "./types";
import {
  parseJsonField,
  mapNovelStatus, randomDelay, isSafeSavePath,
  chapterDedupKey,
} from "./utils";
import { selectEngine, getFallbackChainForEngine } from "./engines";
import { handleClean } from "./cleaning";
import { handleScrapeList, handleScrapeBook, handleScrapeChapters, handleScrapeContent, handleDownloadCover } from "./scrapers";
import { addManyToQueue, getQueueStats, clearTaskQueue } from "./queue";
import { adaptiveDelay } from "./adaptive-delay";
import { detectCaptcha, CAPTCHA_TYPE_LABELS } from "./captcha-detector";
import type { CaptchaDetection } from "./captcha-detector";
import { autoHandleCaptcha } from "./captcha-strategy";
import { qualityScorer } from "./quality-scorer";

// ==================== WebSocket Log Streaming ====================

const LOG_STREAM_URL = process.env.LOG_STREAM_URL || "http://localhost:3004";

/** Best-effort log streaming to WebSocket service (non-blocking, no await) */
function streamLogToWS(taskId: string, level: string, message: string, url?: string, detail?: string) {
  try {
    fetch(`${LOG_STREAM_URL}/push-log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId, level, message: message.slice(0, 500), url: url?.slice(0, 2048), detail: detail?.slice(0, 1000), timestamp: new Date().toISOString() }),
      signal: AbortSignal.timeout(2000), // 2s timeout, don't block
    }).catch(() => {}); // Silent - log streaming is best-effort
  } catch {
    // Silently ignore - log streaming is best-effort
  }
}

/** Best-effort progress streaming to WebSocket service (non-blocking, no await) */
function streamProgressToWS(taskId: string, updates: Record<string, unknown>) {
  try {
    fetch(`${LOG_STREAM_URL}/push-progress`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId, updates }),
      signal: AbortSignal.timeout(2000),
    }).catch(() => {});
  } catch {
    // Silently ignore - log streaming is best-effort
  }
}

// ==================== Atomic Counter ====================

class AtomicCounter {
  private _value = 0;
  increment(): number { return ++this._value; }
  get value(): number { return this._value; }
}

class Semaphore {
  private queue: (() => void)[] = [];
  private running = 0;
  constructor(private max: number) {}
  async acquire(): Promise<void> {
    if (this.running < this.max) { this.running++; return; }
    return new Promise<void>(resolve => this.queue.push(resolve));
  }
  release(): void {
    if (this.running <= 0) return; // Guard against double-release
    this.running--;
    if (this.queue.length > 0) { this.running++; this.queue.shift()!(); }
  }
}

const dbWriteSemaphore = new Semaphore(3);

/** Per-domain lock to prevent concurrent engine downgrade from multiple workers */
const _engineUpgradeLock = new Set<string>();

/** Per-domain engine type override — avoids shared variable race in concurrent workers */
const _domainEngineTypes = new Map<string, EngineType>();
/** Reference count per domain: only clean up override when no tasks reference it */
const _domainEngineRefCount = new Map<string, number>();

/** Get effective engine type for a URL, respecting per-domain overrides */
function getEffectiveEngine(url: string, baseEngine: EngineType): EngineType {
  try {
    const domain = new URL(url).hostname;
    return _domainEngineTypes.get(domain) || baseEngine;
  } catch {
    return baseEngine;
  }
}

/** Per-domain pause promise to prevent double CAPTCHA pause from concurrent workers */
const _captchaPausePromises = new Map<string, Promise<void>>();

/** Maximum number of engine retry attempts across the fallback chain */
const MAX_ENGINE_RETRIES = 3;

/** Extract domain from a URL string for adaptive delay tracking */
function extractDomain(url: string): string {
  try { return new URL(url).hostname; } catch { return 'unknown'; }
}

/** Get delay: adaptive if available, fallback to randomDelay */
async function getAdaptiveOrRandomDelay(url: string, min?: number, max?: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  let ms: number;
  if (min !== undefined && max !== undefined && min > 0) {
    const domain = extractDomain(url);
    const delay = await adaptiveDelay.getDelay(domain);
    ms = Math.min(Math.max(delay, min), max);
  } else {
    const safeMin = Math.max(0, min || 0);
    const safeMax = Math.max(safeMin, max || 0);
    ms = safeMin + Math.random() * (safeMax - safeMin);
  }

  if (ms <= 0) return;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Record response outcome for adaptive delay tracking */
function recordAdaptiveResponse(url: string, elapsed: number, success: boolean, statusCode?: number): void {
  const domain = extractDomain(url);
  adaptiveDelay.recordResponse(domain, elapsed, success, statusCode);
}

// ==================== API Client ====================

const API_BASE = process.env.MAIN_APP_URL || "http://localhost:3000";

async function apiCall(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal
): Promise<{ data: unknown; status: number }> {
  const options: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.SCRAPER_SERVICE_TOKEN || ""}`,
    },
    // Combine task-level abort with per-request timeout (30s)
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000),
  };
  if (body && method !== "GET" && method !== "HEAD") {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${API_BASE}${path}`, options);
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  return { data, status: response.status };
}

// Throttled progress updates - max once per 3 seconds
const progressThrottle = new Map<string, number>();
const PROGRESS_THROTTLE_MS = 3000;

// Periodic cleanup of progress throttle entries older than 5 minutes
export const progressThrottleCleanupTimer = setInterval(() => {
  const now = Date.now();
  const STALE_THRESHOLD = 5 * 60 * 1000;
  for (const [taskId, timestamp] of progressThrottle.entries()) {
    if (now - timestamp > STALE_THRESHOLD) {
      progressThrottle.delete(taskId);
    }
  }
}, 60 * 1000).unref(); // Every minute — .unref() allows clean process exit

/** Clear the progress throttle cleanup timer (call on shutdown) */
export function cleanupProgressThrottleTimer(): void {
  clearInterval(progressThrottleCleanupTimer);
}

async function updateTaskProgress(taskId: string, updates: Partial<ScrapeTask>) {
  const now = Date.now();
  const lastUpdate = progressThrottle.get(taskId) || 0;

  // Always allow status changes and heartbeat updates immediately
  if (!updates.status && !updates.lastHeartbeatAt && now - lastUpdate < PROGRESS_THROTTLE_MS) {
    return; // Skip throttled non-critical update
  }

  // Clean up throttle entry for terminal states to prevent memory leak
  if (updates.status && ['completed', 'failed', 'cancelled'].includes(updates.status)) {
    progressThrottle.delete(taskId);
  } else {
    progressThrottle.set(taskId, now);
  }
  try {
    await apiCall("PUT", `/api/scrape-tasks/${taskId}`, updates);
  } catch (err) {
    console.error(`[Task] Failed to update task progress:`, err);
  }

  // Stream progress to WebSocket service (best-effort)
  streamProgressToWS(taskId, updates as Record<string, unknown>);
}

async function addTaskLog(
  taskId: string,
  level: string,
  message: string,
  url?: string,
  detail?: string
) {
  // Truncate to prevent oversized payloads
  const truncatedMsg = message.length > 500 ? message.slice(0, 500) + "..." : message;
  const truncatedDetail = detail && detail.length > 1000 ? detail.slice(0, 1000) + "..." : (detail || undefined);

  // Buffer logs and flush every LOG_FLUSH_INTERVAL_MS to prevent API thundering herd
  if (!logBuffer.has(taskId)) logBuffer.set(taskId, []);
  const buffer = logBuffer.get(taskId)!;
  buffer.push({ level, message: truncatedMsg, url: url || undefined, detail: truncatedDetail });
  _totalBufferEntries++;

  // Prevent unbounded log buffer growth across all tasks
  while (_totalBufferEntries > 1000) {
    // Remove oldest entries from the oldest non-active task
    let trimmed = false;
    for (const [key, entries] of logBuffer.entries()) {
      if (entries.length > 10) {
        const removed = entries.length - 10;
        entries.splice(0, removed);
        _totalBufferEntries -= removed;
        trimmed = true;
      }
    }
    if (!trimmed) break;
  }

  // If buffer exceeds 50 items, flush immediately to prevent memory buildup
  if (buffer.length >= 50) {
    const logs = buffer.splice(0);
    _totalBufferEntries -= logs.length;
    try {
      await apiCall("POST", `/api/scrape-tasks/${taskId}/logs/batch`, { logs });
    } catch (err) {
      console.error(`[Task] Failed to flush ${logs.length} logs:`, err);
      // Put logs back at the front of the buffer for retry (same as periodic flusher)
      buffer.unshift(...logs);
      _totalBufferEntries += logs.length;
    }
  }

  // Stream log to WebSocket service (best-effort)
  streamLogToWS(taskId, level, truncatedMsg, url, truncatedDetail);
}

// Log buffer for batched API calls
const logBuffer = new Map<string, Array<{ level: string; message: string; url?: string; detail?: string }>>();
let _totalBufferEntries = 0; // running counter to avoid O(n) scan on every log add
const LOG_FLUSH_INTERVAL_MS = 5000;
let logFlushTimer: ReturnType<typeof setInterval> | null = null;

function ensureLogFlusher() {
  if (logFlushTimer) return;
  logFlushTimer = setInterval(async () => {
    // Collect batches atomically before any async work
    const batches: Array<{ taskId: string; batch: Array<{ level: string; message: string; url?: string; detail?: string }> }> = [];
    for (const [taskId, logs] of logBuffer) {
      if (logs.length === 0) continue;
      const batch = logs.splice(0); // Remove all entries atomically
      _totalBufferEntries -= batch.length;
      batches.push({ taskId, batch });
    }
    // Send batches (non-blocking, retry on failure by putting back)
    for (const { taskId, batch } of batches) {
      try {
        await apiCall("POST", `/api/scrape-tasks/${taskId}/logs/batch`, { logs: batch });
      } catch (err) {
        console.error(`[Task] Failed to flush ${batch.length} logs for ${taskId}:`, err);
        // Put logs back at the front of the buffer for retry
        const taskLogs = logBuffer.get(taskId);
        if (taskLogs) {
          taskLogs.unshift(...batch);
        } else {
          logBuffer.set(taskId, batch);
        }
        _totalBufferEntries += batch.length;
      }
    }
    // Auto-clear interval when no pending logs remain
    if (logBuffer.size === 0 && logFlushTimer) {
      clearInterval(logFlushTimer);
      logFlushTimer = null;
    }
  }, LOG_FLUSH_INTERVAL_MS);
}

// Flush remaining logs for a task (call before task completes)
// Uses splice(0) to atomically drain (same as periodic flusher) to prevent
// race conditions where periodic flusher sends same logs concurrently.
async function flushTaskLogs(taskId: string) {
  const logs = logBuffer.get(taskId);
  if (!logs || logs.length === 0) return;
  // Atomically drain the buffer before the async call
  const batch = logs.splice(0);
  _totalBufferEntries -= batch.length;
  // Clear entry immediately to prevent periodic flusher from picking up stale data
  logBuffer.delete(taskId);
  try {
    await apiCall("POST", `/api/scrape-tasks/${taskId}/logs/batch`, { logs: batch });
  } catch (err) {
    console.error(`[Task] Failed to final-flush logs for ${taskId}:`, err);
    // Re-insert for periodic retry
    const existing = logBuffer.get(taskId);
    if (existing) {
      existing.unshift(...batch);
    } else {
      logBuffer.set(taskId, batch);
    }
    _totalBufferEntries += batch.length;
  }
}

// ==================== Helpers ====================

function parseSelectorField(field: string | null): Selector | null {
  if (!field) return null;
  try {
    return JSON.parse(field) as Selector;
  } catch {
    return null;
  }
}

function determineEngine(rule: ScrapeRule, antiCrawlConfig: AntiCrawl): EngineType {
  // Priority: rule.engine > cloudBrowser > useJsRender > default cheerio
  if (rule.engine && ["cheerio", "playwright", "firecrawl", "agentql", "cloud-browser", "scrapling", "obscura"].includes(rule.engine)) {
    return rule.engine as EngineType;
  }
  return selectEngine(undefined, antiCrawlConfig);
}

// ==================== Task Execution ====================

/**
 * Execute a full scraping task - main orchestration function.
 */
export async function executeTask(taskId: string) {
  console.log(`[Task ${taskId}] Starting task execution`);

  // AbortController for task cancellation (timeout/cancel/shutdown)
  const abortController = new AbortController();

  // 1. Fetch task + rule from Next.js API
  const { data: taskData, status } = await apiCall("GET", `/api/scrape-tasks/${taskId}`);

  if (status !== 200 || !taskData) {
    throw new Error(`Failed to fetch task ${taskId}: HTTP ${status}`);
  }

  const task = taskData as ScrapeTask;
  const rule = task.rule;

  if (!rule) {
    throw new Error(`Task ${taskId} has no associated scrape rule`);
  }

  // Parse rule configurations
  const listSelector = parseSelectorField(rule.listSelector);
  const listPagination = parseJsonField<Pagination>(rule.listPagination, undefined);
  const antiCrawlConfig = parseJsonField<AntiCrawl>(rule.antiCrawlConfig, {
    uaRotation: true,
    delay: [rule.minDelay, rule.maxDelay],
  });
  const cleanConfig = parseJsonField<CleanRequest["config"]>(rule.cleanConfig, {
    removeAds: true,
    cleanHtml: true,
  });

  // Enable T2S conversion if rule has t2sConversion config
  if ((rule as Record<string, unknown>).t2sConversion) {
    const t2sCfg = (rule as Record<string, unknown>).t2sConversion as Record<string, unknown> | null;
    if (t2sCfg && t2sCfg.enabled !== false) {
      cleanConfig.t2sConversion = true;
    }
  }

  if (!antiCrawlConfig.delay) {
    antiCrawlConfig.delay = [rule.minDelay, rule.maxDelay];
  }

  // Determine engine
  const engineType = determineEngine(rule, antiCrawlConfig);
  console.log(`[Task ${taskId}] Engine: ${engineType}, Rule: ${rule.name}, Mode: ${task.mode || rule.scrapeMode}`);

  // Clear any previous queue data for this task
  await clearTaskQueue(taskId);

  const threadCount = Math.max(1, Math.min(rule.threadCount || 3, 10));
  const isIncremental = (task.mode || rule.scrapeMode) === "incremental";
  const dedupMode = rule.dedupMode || "url";

  // Update task status
  await updateTaskProgress(taskId, {
    status: "running",
    startedAt: new Date().toISOString(),
    currentStep: "正在采集列表页...",
    progress: 0,
  });

  // Heartbeat: update lastHeartbeatAt every 30 seconds to detect stale tasks
  const heartbeatInterval = setInterval(() => {
    updateTaskProgress(taskId, { lastHeartbeatAt: new Date().toISOString() }).catch(() => {});
  }, 30000);

  await addTaskLog(taskId, "info", `开始执行采集任务: ${rule.name} [引擎: ${engineType}]`);
  ensureLogFlusher();

  // Overall task timeout (1 hour max)
  const TASK_TIMEOUT_MS = 60 * 60 * 1000;
  let taskTimeoutId: ReturnType<typeof setTimeout>;
  const taskTimeoutPromise = new Promise<never>((_, reject) => {
    taskTimeoutId = setTimeout(() => {
      // Abort all in-progress engine fetch calls to prevent zombie workers
      abortController.abort();
      reject(new Error(`任务执行超时（${TASK_TIMEOUT_MS / 1000 / 60}分钟）`));
    }, TASK_TIMEOUT_MS);
  });

  const taskCtx: TaskContext = { listSelector, listPagination, antiCrawlConfig, cleanConfig, engineType, threadCount, isIncremental, dedupMode, abortSignal: abortController.signal };
  const taskStartTime = Date.now();

  try {
    const taskResult: TaskResult = await Promise.race([
      executeTaskBody(taskId, task, rule, abortController, taskCtx),
      taskTimeoutPromise,
    ]);

    // Quality scoring after successful completion
    try {
      const duration = Date.now() - taskStartTime;
      const chapters = taskResult.chapterWordCounts?.map((wc, i) => ({
        title: `ch_${i + 1}`,
        wordCount: wc,
      }));
      const qualityReport = qualityScorer.score(taskId, {
        totalBooks: taskResult.totalBooks,
        newBooks: taskResult.newBooks,
        totalChapters: taskResult.totalChapters,
        newChapters: taskResult.newChapters,
        failedItems: taskResult.failed,
        skippedItems: taskResult.skipped,
        engine: taskResult.engine,
        duration,
      }, chapters);
      await addTaskLog(taskId, "info", `数据质量评分: ${qualityReport.overallScore}/100 (${qualityReport.grade}) - ${qualityReport.summary}`);
    } catch {
      // Quality scoring is best-effort, don't fail the task
    }

    return taskResult;
  } catch (err) {
    // Mark task as failed in DB so UI doesn't show it as stuck "running"
    try {
      await apiCall("PUT", `/api/scrape-tasks/${taskId}`, {
        status: "failed",
        errorMessage: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
        completedAt: new Date().toISOString(),
      });
    } catch { /* best-effort */ }
    throw err;
  } finally {
    clearInterval(heartbeatInterval);
    clearTimeout(taskTimeoutId);
    // Flush logs (flushTaskLogs now atomically drains + deletes the entry)
    await flushTaskLogs(taskId).catch(() => {});
    progressThrottle.delete(taskId);
  }
}

interface TaskContext {
  listSelector: ReturnType<typeof parseSelectorField>;
  listPagination: Pagination | undefined;
  antiCrawlConfig: AntiCrawl;
  cleanConfig: CleanRequest["config"];
  engineType: EngineType;
  threadCount: number;
  isIncremental: boolean;
  dedupMode: string;
  abortSignal: AbortSignal;
}

interface TaskResult {
  success: boolean;
  totalBooks: number;
  newBooks: number;
  totalChapters: number;
  newChapters: number;
  failed: number;
  skipped: number;
  engine: string;
  queueStats?: unknown;
  /** Per-chapter word counts for quality scoring */
  chapterWordCounts?: number[];
}

async function executeTaskBody(
  taskId: string,
  task: ScrapeTask,
  rule: ScrapeRule,
  abortController: AbortController,
  ctx: TaskContext
): Promise<TaskResult> {
  let { listSelector, listPagination, antiCrawlConfig, cleanConfig, engineType, threadCount, isIncremental, dedupMode, abortSignal } = ctx;

  // Track domains this task touches for selective cleanup (avoids wiping concurrent tasks' overrides)
  // Declared before try so the finally block can safely iterate even if an error occurs early
  const _touchedDomains = new Set<string>();
  // Helper: register a domain engine override with reference counting
  function touchDomainEngine(domain: string) {
    if (_touchedDomains.has(domain)) return; // Already tracked — avoid ref count leak
    _touchedDomains.add(domain);
    _domainEngineRefCount.set(domain, (_domainEngineRefCount.get(domain) || 0) + 1);
  }

  try {

  // 2. Scrape list page
  if (!rule.listUrl || !listSelector) {
    throw new Error("列表页URL和选择器不能为空");
  }

  await addTaskLog(taskId, "info", `开始采集列表页: ${rule.listUrl}`);

  const listResult = await handleScrapeList({
    url: rule.listUrl,
    selector: listSelector,
    pagination: listPagination,
    antiCrawl: antiCrawlConfig,
    engine: engineType,
    signal: abortSignal,
  });

  const bookUrls = listResult.urls;
  console.log(`[Task ${taskId}] Found ${bookUrls.length} book URLs`);

  await addTaskLog(taskId, "success", `列表页采集完成，共发现 ${bookUrls.length} 本书 [引擎: ${listResult.engine}]`);

  // Add all book URLs to the queue for resume capability (batched)
  if (bookUrls.length > 0) {
    await addManyToQueue(bookUrls.map(bookUrl => ({ url: bookUrl, taskId, metadata: { type: "book", taskId } })));
  }

  if (bookUrls.length === 0) {
    await updateTaskProgress(taskId, {
      status: "completed",
      completedAt: new Date().toISOString(),
      currentStep: "采集完成（未发现书籍）",
      progress: 100,
      totalBooks: 0,
      totalChapters: 0,
    });
    await addTaskLog(taskId, "warn", "未发现任何书籍URL");
    return { success: true, totalBooks: 0, newBooks: 0, totalChapters: 0, newChapters: 0, failed: 0, skipped: 0, engine: engineType };
  }

  await updateTaskProgress(taskId, {
    totalBooks: bookUrls.length,
    currentStep: `正在采集书籍信息 (0/${bookUrls.length})...`,
    progress: 5,
  });

  // 3. Process each book
  const seenTitles = new Set<string>();
  const seenUrls = new Set<string>();

  let newBooksCount = new AtomicCounter();
  let skippedBooksCount = new AtomicCounter();
  let failedItemsCount = new AtomicCounter();
  let processedChaptersCount = new AtomicCounter();
  let newChaptersCount = new AtomicCounter();
  let skippedChaptersCount = new AtomicCounter();
  const chapterWordCounts: number[] = []; // Track word counts for quality scoring
  const booksProcessed: Array<{ id: string; title: string; url: string }> = [];

  // Book-level CAPTCHA detection: detect captcha from book scrape errors and trigger engine upgrade
  const bookCaptchaCounts = new Map<string, number>();
  const BOOK_CAPTCHA_THRESHOLD = 2;
  const BOOK_CAPTCHA_PAUSE_MS = 60000;

  async function processBook(bookUrl: string, index: number): Promise<void> {
    try {
      console.log(`[Task ${taskId}] Processing book ${index + 1}/${bookUrls.length}: ${bookUrl}`);

      if (antiCrawlConfig.delay) {
        await getAdaptiveOrRandomDelay(bookUrl, antiCrawlConfig.delay[0], antiCrawlConfig.delay[1], abortSignal);
      }

      // Scrape book info using selected engine
      const bookStartTime = Date.now();
      const bookInfo = await handleScrapeBook({
        url: bookUrl,
        selectors: {
          title: parseSelectorField(rule.bookTitleSelector) || { type: "css", value: "h1" },
          author: parseSelectorField(rule.bookAuthorSelector) || undefined,
          category: parseSelectorField(rule.bookCategorySelector) || undefined,
          keywords: parseSelectorField(rule.bookKeywordsSelector) || undefined,
          description: parseSelectorField(rule.bookDescriptionSelector) || undefined,
          cover: parseSelectorField(rule.bookCoverSelector) || undefined,
          status: parseSelectorField(rule.bookStatusSelector) || undefined,
        },
        antiCrawl: antiCrawlConfig,
        engine: getEffectiveEngine(bookUrl, engineType),
        signal: abortSignal,
      });

      if (!bookInfo.title) {
        console.log(`[Task ${taskId}] Book at ${bookUrl} has no title, skipping`);
        skippedBooksCount.increment();
        await addTaskLog(taskId, "warn", `跳过无标题书籍: ${bookUrl}`, bookUrl);
        // No queue item to mark failed since we don't have a queue ID for the book URL
        return;
      }

      // Dedup
      if (dedupMode === "title" || dedupMode === "both") {
        if (seenTitles.has(bookInfo.title)) {
          skippedBooksCount.increment();
          return;
        }
      }
      if (dedupMode === "url" || dedupMode === "both") {
        if (seenUrls.has(bookUrl)) {
          skippedBooksCount.increment();
          return;
        }
      }

      seenTitles.add(bookInfo.title);
      seenUrls.add(bookUrl);

      // Check if novel already exists (incremental mode)
      let novelId = "";
      let isExisting = false;

      if (isIncremental) {
        const { data: searchResult, status: searchStatus } = await apiCall(
          "GET",
          `/api/novels?pageSize=100&search=${encodeURIComponent(bookInfo.title)}`,
          undefined,
          abortController.signal
        );

        if (searchStatus === 200 && searchResult) {
          const searchNovels = (searchResult as { novels?: Array<{ id: string; sourceUrl?: string; title: string }> }).novels || [];
          const existing = searchNovels.find(
            (n) => n.sourceUrl === bookUrl || n.title === bookInfo.title
          );
          if (existing) {
            novelId = existing.id;
            isExisting = true;
          }
        }
      }

      // Create or update novel
      const novelData: Record<string, unknown> = {
        title: bookInfo.title,
        author: bookInfo.author || "佚名",
        description: bookInfo.description || null,
        coverUrl: bookInfo.coverUrl || null,
        status: mapNovelStatus(bookInfo.status),
        sourceUrl: bookUrl,
        sourceId: rule.id,
      };

      if (bookInfo.category) novelData.categoryName = bookInfo.category;
      if (bookInfo.keywords) novelData.extraKeywords = bookInfo.keywords;

      await dbWriteSemaphore.acquire();
      try {
        if (isExisting) {
          const putResult = await apiCall("PUT", `/api/novels/${novelId}`, novelData, abortController.signal);
          if (putResult.status && putResult.status >= 400) {
            console.warn(`  [Book] Failed to update novel ${novelId}: ${putResult.status}`);
          }
          await addTaskLog(taskId, "info", `更新小说: ${bookInfo.title}`, bookUrl);
        } else {
          const { data: createdNovel, status: createStatus } = await apiCall("POST", "/api/novels", novelData, abortController.signal);
          if (createStatus === 201 && createdNovel) {
            novelId = (createdNovel as { id: string }).id;
            newBooksCount.increment();
            await addTaskLog(taskId, "success", `新建小说: ${bookInfo.title}`, bookUrl);
          } else {
            failedItemsCount.increment();
            await addTaskLog(taskId, "error", `创建小说失败: ${bookInfo.title}`, bookUrl, `HTTP ${createStatus}`);
            return;
          }
        }
      } finally {
        dbWriteSemaphore.release();
      }

      booksProcessed.push({ id: novelId, title: bookInfo.title, url: bookUrl });

      // Record adaptive response for book scrape
      recordAdaptiveResponse(bookUrl, Date.now() - bookStartTime, true);

      // Download cover
      if (bookInfo.coverUrl && rule.coverSavePath) {
        try {
          const coverFilename = `${novelId}.webp`;
          const savePath = `${rule.coverSavePath}/${coverFilename}`;
          if (!isSafeSavePath(savePath)) {
            console.error(`[Task ${taskId}] Invalid cover save path: ${savePath}`);
            await addTaskLog(taskId, "warn", `封面保存路径无效: ${savePath}`, bookInfo.coverUrl);
          } else {
            await handleDownloadCover(bookInfo.coverUrl, savePath);
            await apiCall("PUT", `/api/novels/${novelId}`, { coverPath: savePath }, abortController.signal);
          }
        } catch (coverErr) {
          console.error(`[Task ${taskId}] Cover download failed for ${bookInfo.title}:`, coverErr);
          await addTaskLog(taskId, "warn", `封面下载失败: ${bookInfo.title}`, bookInfo.coverUrl, String(coverErr));
        }
      }
    } catch (err) {
      // Detect CAPTCHA errors from handleScrapeBook and trigger engine upgrade
      const errMsg = err instanceof Error ? err.message : String(err);
      const isCaptcha = errMsg.includes('CAPTCHA');

      if (isCaptcha) {
        skippedBooksCount.increment();
        const bkDomain = extractDomain(bookUrl);
        const prevCount = bookCaptchaCounts.get(bkDomain) || 0;
        const newCount = prevCount + 1;
        bookCaptchaCounts.set(bkDomain, newCount);

        await addTaskLog(taskId, "warn", `CAPTCHA detected on book page: ${bookUrl}`, bookUrl, errMsg.slice(0, 500));

        // Pause and attempt engine upgrade when consecutive CAPTCHAs exceed threshold
        if (newCount >= BOOK_CAPTCHA_THRESHOLD) {
          await addTaskLog(taskId, "warn", `验证码频繁(${bkDomain}), 暂停${BOOK_CAPTCHA_PAUSE_MS / 1000}秒`);
          await updateTaskProgress(taskId, {
            currentStep: `⚠️ 验证码频繁，暂停${BOOK_CAPTCHA_PAUSE_MS / 1000}秒...`,
          });

          // Auto-engine upgrade: consult CAPTCHA strategy advisor
          try {
            const detection: CaptchaDetection = {
              detected: true,
              type: 'unknown',
              confidence: 0.8,
              evidence: ['book-page-captcha'],
            };
            const _currentBookEngine = getEffectiveEngine(bookUrl, engineType);
            const strategyResult = await autoHandleCaptcha(detection, {
              url: bookUrl,
              domain: bkDomain,
              currentEngine: _currentBookEngine,
              retryCount: newCount,
              maxRetries: 5,
              antiCrawlConfig: antiCrawlConfig as Record<string, unknown>,
            });

            if (strategyResult.nextEngine && strategyResult.nextEngine !== _currentBookEngine) {
              await addTaskLog(taskId, "info",
                `升级引擎: ${_currentBookEngine} → ${strategyResult.nextEngine} (${strategyResult.message})`,
                bookUrl,
                `书籍页连续遇到${newCount}次验证码，已自动切换到${strategyResult.nextEngine}引擎`
              );
              if (!_engineUpgradeLock.has(bkDomain)) {
                _engineUpgradeLock.add(bkDomain);
                _domainEngineTypes.set(bkDomain, strategyResult.nextEngine);
                touchDomainEngine(bkDomain);
                ctx.engineType = strategyResult.nextEngine;
                engineType = strategyResult.nextEngine; // keep local in sync
                setTimeout(() => _engineUpgradeLock.delete(bkDomain), 5000);
              }
            }

            if (strategyResult.delayMs && strategyResult.delayMs >= BOOK_CAPTCHA_PAUSE_MS) {
              await new Promise<void>((resolve, reject) => {
                const t = setTimeout(resolve, strategyResult.delayMs!);
                abortSignal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
              });
            } else {
              await new Promise<void>((resolve, reject) => {
                const t = setTimeout(resolve, BOOK_CAPTCHA_PAUSE_MS);
                abortSignal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
              });
            }
          } catch {
            await new Promise<void>((resolve, reject) => {
              const t = setTimeout(resolve, BOOK_CAPTCHA_PAUSE_MS);
              abortSignal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
            });
          }

          bookCaptchaCounts.set(bkDomain, 0);
        }
      } else {
        failedItemsCount.increment();
      }

      recordAdaptiveResponse(bookUrl, 0, false);
      console.error(`[Task ${taskId}] Error processing book ${bookUrl}:`, errMsg);
      if (!isCaptcha) {
        await addTaskLog(taskId, "error", `采集书籍失败: ${bookUrl}`, bookUrl, errMsg.slice(0, 500));
      }
    }
  }

  // Process books with concurrency pool
  // TODO(M-14): This worker pool pattern (shared queue + N async workers) is duplicated
  // for chapter processing below. Consider extracting a reusable `createWorkerPool<T>` utility.
  const bookQueue = [...bookUrls];

  async function processAllBooks(): Promise<void> {
    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(threadCount, bookUrls.length); i++) {
      workers.push(
        (async () => {
          while (bookQueue.length > 0) {
            if (abortController.signal.aborted) break;
            const url = bookQueue.shift()!;
            const index = bookUrls.length - bookQueue.length - 1;
            await processBook(url, index);

            const processed = bookUrls.length - bookQueue.length;
            const bookProgress = 5 + (processed / bookUrls.length) * 15;
            await updateTaskProgress(taskId, {
              progress: Math.round(bookProgress),
              currentStep: `正在采集书籍信息 (${processed}/${bookUrls.length})...`,
              newBooks: newBooksCount.value,
              failedItems: failedItemsCount.value,
              skippedItems: skippedBooksCount.value + skippedChaptersCount.value,
            });
          }
        })()
      );
    }
    await Promise.all(workers);
  }

  await processAllBooks();

  console.log(`[Task ${taskId}] Books processed: ${booksProcessed.length} (new: ${newBooksCount.value}, skipped: ${skippedBooksCount.value}, failed: ${failedItemsCount.value})`);
  await addTaskLog(taskId, "success", `书籍信息采集完成: 新建 ${newBooksCount.value}, 跳过 ${skippedBooksCount.value}, 失败 ${failedItemsCount.value}`);

  if (booksProcessed.length === 0) {
    await updateTaskProgress(taskId, {
      status: "completed",
      completedAt: new Date().toISOString(),
      currentStep: "采集完成（无有效书籍）",
      progress: 100,
    });
    return { success: true, totalBooks: 0, newBooks: 0, totalChapters: 0, newChapters: 0, failed: 0, skipped: skippedBooksCount.value, engine: engineType };
  }

  // 4. Scrape chapters for each book
  await updateTaskProgress(taskId, {
    currentStep: "正在采集章节目录...",
    progress: 20,
  });

  await addTaskLog(taskId, "info", "开始采集章节目录");

  const chapterListSelector = parseSelectorField(rule.chapterListSelector);
  const chapterTitleSelector = parseSelectorField(rule.chapterTitleSelector);
  const chapterLinkSelector = parseSelectorField(rule.chapterLinkSelector);
  const chapterPagination = parseJsonField<Pagination>(rule.chapterPagination, undefined);

  for (let bookIdx = 0; bookIdx < booksProcessed.length; bookIdx++) {
    const book = booksProcessed[bookIdx];
    const bookProgress = 20 + (bookIdx / booksProcessed.length) * 30;

    console.log(`[Task ${taskId}] Scraping chapters for: ${book.title} (${bookIdx + 1}/${booksProcessed.length})`);

    await updateTaskProgress(taskId, {
      currentStep: `正在采集章节目录: ${book.title} (${bookIdx + 1}/${booksProcessed.length})...`,
      progress: Math.round(bookProgress),
    });

    try {
      let chapterListUrl = rule.chapterListUrl
        ? rule.chapterListUrl.replace("{bookUrl}", book.url)
        : book.url;

      if (!chapterListSelector || !chapterTitleSelector || !chapterLinkSelector) {
        await addTaskLog(taskId, "warn", `缺少章节目录选择器，跳过: ${book.title}`, book.url);
        continue;
      }

      if (antiCrawlConfig.delay) {
        await getAdaptiveOrRandomDelay(chapterListUrl, antiCrawlConfig.delay[0], antiCrawlConfig.delay[1], abortSignal);
      }

      // Scrape chapter list using selected engine
      const chapterListStartTime = Date.now();
      const { chapters, titleDupCount } = await handleScrapeChapters({
        url: chapterListUrl,
        selectors: {
          list: chapterListSelector,
          title: chapterTitleSelector,
          link: chapterLinkSelector,
        },
        pagination: chapterPagination,
        antiCrawl: antiCrawlConfig,
        enableShuffle: rule.enableShuffle,
        engine: getEffectiveEngine(chapterListUrl, engineType),
        signal: abortSignal,
      });

      // Record adaptive response for chapter list scrape
      recordAdaptiveResponse(chapterListUrl, Date.now() - chapterListStartTime, true);

      console.log(`[Task ${taskId}] Found ${chapters.length} chapters for ${book.title}${titleDupCount ? ` (${titleDupCount} title dups removed)` : ""}`);

      if (chapters.length === 0) {
        await addTaskLog(taskId, "warn", `未发现章节: ${book.title}`, chapterListUrl);
        continue;
      }

      if (titleDupCount > 0) {
        await addTaskLog(taskId, "info", `章节标题去重: ${book.title}，移除 ${titleDupCount} 个重复标题`, chapterListUrl);
      }

      await addTaskLog(taskId, "info", `发现 ${chapters.length} 个章节: ${book.title}`, chapterListUrl);

      // Add chapter URLs to queue (batched)
      await addManyToQueue(chapters.map(ch => ({
        url: ch.url,
        taskId,
        metadata: { type: "chapter", bookId: book.id, title: ch.title, sortOrder: ch.sortOrder, taskId },
      })));


      // 5. Scrape chapter content
      const contentSelector = parseSelectorField(rule.contentSelector);
      const contentTitleSelector = parseSelectorField(rule.contentTitleSelector);
      const contentPagination = parseJsonField<Pagination>(rule.contentPagination, undefined);

      if (!contentSelector) {
        await addTaskLog(taskId, "warn", `缺少正文选择器，跳过内容采集: ${book.title}`);
        continue;
      }

      // Get existing chapters for incremental mode
      // Keys: sourceUrl → chapterId, title:normalizedKey → chapterId
      const existingChapters = new Map<string, string>();
      if (isIncremental) {
        try {
          const { data: existingData, status: existingStatus } = await apiCall(
            "GET",
            `/api/novels/${book.id}/chapters`,
            undefined,
            abortController.signal
          );
          if (existingStatus === 200 && existingData) {
            const chapterList = (existingData as { chapters?: Array<{ id: string; sourceUrl?: string; title: string }> }).chapters || [];
            for (const ch of chapterList) {
              if (ch.sourceUrl) existingChapters.set(ch.sourceUrl, ch.id);
              // Use normalized title key for dedup to catch variations like 第01章 vs 第1章
              existingChapters.set(`title:${chapterDedupKey(ch.title)}`, ch.id);
            }
          }
        } catch (err) {
          console.warn(`[Task ${taskId}] Failed to fetch existing chapters for ${book.id}, incremental dedup disabled:`, err instanceof Error ? err.message : String(err));
        }
      }

      // Process chapters with concurrency
      const chapterQueue = [...chapters];

      // CAPTCHA consecutive detection per domain
      const consecutiveCaptchaCounts = new Map<string, number>();
      const CONSECUTIVE_CAPTCHA_THRESHOLD = 3;
      const CAPTCHA_PAUSE_MS = 60000;

      // Collect failed chapters for post-loop retry recovery
      const failedChapters: FailedChapterInfo[] = [];

      async function processChapter(): Promise<void> {
        if (chapterQueue.length === 0) return;
        const chapter = chapterQueue.shift()!;

        let contentStartTime = 0;

        try {
          // Dedup check BEFORE eager mark (check → eager mark → delay → fetch)
          if (isIncremental && (existingChapters.has(chapter.url) || existingChapters.has(`title:${chapterDedupKey(chapter.title)}`))) {
            skippedChaptersCount.increment();
            return;
          }

          // Eagerly mark before any await to prevent TOCTOU race
          if (isIncremental) {
            existingChapters.set(chapter.url, 'pending');
            const titleKey = `title:${chapterDedupKey(chapter.title)}`;
            if (!existingChapters.has(titleKey)) existingChapters.set(titleKey, 'pending');
          }

          if (antiCrawlConfig.delay) {
            await getAdaptiveOrRandomDelay(chapter.url, antiCrawlConfig.delay[0], antiCrawlConfig.delay[1], abortSignal);
          }

          // Scrape chapter content with engine fallback chain retry
          contentStartTime = Date.now();
          const _chapterEngine = getEffectiveEngine(chapter.url, engineType);
          const _chapterDomain = (() => { try { return new URL(chapter.url).hostname; } catch { return undefined; } })();
          const fallbackChain = getFallbackChainForEngine(_chapterEngine, _chapterDomain);
          const enginesToTry = fallbackChain.slice(0, MAX_ENGINE_RETRIES);

          let contentResult: Awaited<ReturnType<typeof handleScrapeContent>>;
          let contentEngineUsed: EngineType = _chapterEngine;
          let chainSuccess = false;
          const chainFailures: Array<{ engine: EngineType; reason: string }> = [];

          for (const tryEngine of enginesToTry) {
            contentEngineUsed = tryEngine;
            try {
              contentResult = await handleScrapeContent({
                url: chapter.url,
                selectors: {
                  title: contentTitleSelector || undefined,
                  content: contentSelector,
                },
                pagination: contentPagination,
                antiCrawl: antiCrawlConfig,
                engine: tryEngine,
                cleanConfig,
                signal: abortSignal,
              });
              chainSuccess = true;
              // Log fallback if we used a different engine
              if (tryEngine !== _chapterEngine) {
                console.log(`[EngineChain] Chapter fallback success: ${_chapterEngine} → ${tryEngine} for ${chapter.url}`);
              }
              break;
            } catch (contentErr) {
              const errReason = contentErr instanceof Error ? contentErr.message : String(contentErr);
              chainFailures.push({ engine: tryEngine, reason: errReason.slice(0, 120) });
              // CAPTCHA errors should not trigger engine fallback — stop immediately
              if (errReason.includes('CAPTCHA')) {
                (contentErr as Error & { doNotRetry?: boolean }).doNotRetry = true;
                console.warn(`[EngineChain] CAPTCHA detected from ${tryEngine} for ${chapter.url} — stopping chain`);
                throw contentErr;
              }
              // Stop chain on doNotRetry errors
              if (contentErr instanceof Error && (contentErr as Record<string, unknown>).doNotRetry) {
                console.warn(`[EngineChain] Engine ${tryEngine} returned doNotRetry for ${chapter.url}: ${errReason.slice(0, 120)} — stopping chain`);
                throw contentErr;
              }
              console.warn(`[EngineChain] Engine ${tryEngine} failed for ${chapter.url}: ${errReason.slice(0, 120)}`);
              // Continue to next engine in chain
            }
          }

          if (!chainSuccess) {
            const summary = chainFailures.map(f => `${f.engine}(${f.reason.slice(0, 50)})`).join(', ');
            throw new Error(`所有引擎均失败 [${summary}]`);
          }

          // CAPTCHA detection: skip chapter if detected
          const captchaResult = ('captchaDetected' in contentResult) ? (contentResult as { captchaDetected?: CaptchaDetection }).captchaDetected : undefined;
          if (captchaResult) {
            const chDomain = extractDomain(chapter.url);
            const prevCount = consecutiveCaptchaCounts.get(chDomain) || 0;
            const newCount = prevCount + 1;
            consecutiveCaptchaCounts.set(chDomain, newCount);

            await addTaskLog(
              taskId, "warn",
              `CAPTCHA detected: ${CAPTCHA_TYPE_LABELS[captchaResult.type]} on ${chapter.url} (confidence: ${Math.round(captchaResult.confidence * 100)}%)`,
              chapter.url,
              `type=${captchaResult.type}, evidence=${captchaResult.evidence.slice(0, 3).join('; ')}`
            );
            await updateTaskProgress(taskId, {
              currentStep: `⚠️ 检测到验证码(${CAPTCHA_TYPE_LABELS[captchaResult.type]})，已跳过该页面`,
            });

            // Pause if consecutive CAPTCHAs exceed threshold
            if (newCount >= CONSECUTIVE_CAPTCHA_THRESHOLD) {
              // If another worker is already handling the pause for this domain, wait and return
              if (_captchaPausePromises.has(chDomain)) {
                skippedChaptersCount.increment();
                await _captchaPausePromises.get(chDomain);
                return;
              }
              const pausePromise = new Promise<void>((resolve, reject) => {
                const timer = setTimeout(resolve, CAPTCHA_PAUSE_MS);
                abortSignal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
              });
              _captchaPausePromises.set(chDomain, pausePromise);
              try {
              await addTaskLog(taskId, "warn", `验证码频繁(${chDomain}), 暂停${CAPTCHA_PAUSE_MS / 1000}秒`);
              await updateTaskProgress(taskId, {
                currentStep: `⚠️ 验证码频繁，暂停${CAPTCHA_PAUSE_MS / 1000}秒...`,
              });

              // Auto-engine upgrade: consult CAPTCHA strategy advisor
              try {
                const _currentChEngine = getEffectiveEngine(chapter.url, engineType);
                const strategyResult = await autoHandleCaptcha(captchaResult, {
                  url: chapter.url,
                  domain: chDomain,
                  currentEngine: _currentChEngine,
                  retryCount: newCount,
                });

                if (strategyResult.nextEngine && strategyResult.nextEngine !== _currentChEngine) {
                  await addTaskLog(taskId, "info",
                    `升级引擎: ${_currentChEngine} → ${strategyResult.nextEngine} (${strategyResult.message})`,
                    chapter.url,
                    `当前引擎连续遇到${newCount}次验证码，已自动切换到${strategyResult.nextEngine}引擎`
                  );
                  if (!_engineUpgradeLock.has(chDomain)) {
                    _engineUpgradeLock.add(chDomain);
                    _domainEngineTypes.set(chDomain, strategyResult.nextEngine);
                    touchDomainEngine(chDomain);
                    ctx.engineType = strategyResult.nextEngine;
                    engineType = strategyResult.nextEngine; // keep local in sync
                    setTimeout(() => _engineUpgradeLock.delete(chDomain), 5000);
                  }
                }
                // Wait the shared pause (may already be partially elapsed)
                await pausePromise;
                // If strategy recommends even longer, wait the difference
                if (strategyResult.delayMs && strategyResult.delayMs > CAPTCHA_PAUSE_MS) {
                  await new Promise<void>((resolve, reject) => {
                    const t = setTimeout(resolve, strategyResult.delayMs! - CAPTCHA_PAUSE_MS);
                    abortSignal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
                  });
                }
              } catch {
                await pausePromise;
              }
              } finally {
                _captchaPausePromises.delete(chDomain);
              }

              consecutiveCaptchaCounts.set(chDomain, 0);
            }

            skippedChaptersCount.increment();
            return;
          } else {
            // Decay consecutive counter on success (don't reset to 0 immediately — prevents rapid re-trigger)
            const chDomain = extractDomain(chapter.url);
            const prevCount = consecutiveCaptchaCounts.get(chDomain) || 0;
            consecutiveCaptchaCounts.set(chDomain, Math.max(0, prevCount - 1));
          }

          // Content is already cleaned by handleScrapeContent. Only normalize whitespace.
          const chapterContent = contentResult.content
            .replace(/\t/g, ' ')
            .replace(/ {3,}/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
          const chapterTitle = contentResult.title || chapter.title;
          const chapterWordCount = chapterContent.replace(/\s+/g, '').length;
          chapterWordCounts.push(chapterWordCount);

          // Log multi-page content merges for visibility
          const pagesFetched = ('pagesFetched' in contentResult) ? (contentResult as { pagesFetched?: number }).pagesFetched : 0;
          if (pagesFetched && pagesFetched > 1) {
            await addTaskLog(
              taskId, "info",
              `内容分页合并: ${chapterTitle} (${pagesFetched}页, ${chapterContent.length}字)`,
              chapter.url
            );
          }

          if (!chapterContent.trim()) {
            console.log(`[Task ${taskId}] Empty content for chapter: ${chapterTitle}`);
            skippedChaptersCount.increment();
            return;
          }

          // Create chapter via API
          let chStatus: number;
          await dbWriteSemaphore.acquire();
          try {
            const result = await apiCall(
              "POST",
              `/api/novels/${book.id}/chapters`,
              {
                title: chapterTitle,
                content: chapterContent,
                sortOrder: chapter.sortOrder,
                sourceUrl: chapter.url,
              },
              abortController.signal
            );
            chStatus = result.status;
          } finally {
            dbWriteSemaphore.release();
          }

          // Record adaptive response for content scrape
          recordAdaptiveResponse(chapter.url, Date.now() - contentStartTime, chStatus === 201, chStatus);

          if (chStatus === 201) {
            newChaptersCount.increment();
            // Update existingChapters map to prevent duplicates within same task
            if (isIncremental) {
              existingChapters.set(chapter.url, "new");
              existingChapters.set(`title:${chapterDedupKey(chapterTitle)}`, "new");
              const originalTitleKey = `title:${chapterDedupKey(chapter.title)}`;
              if (originalTitleKey !== `title:${chapterDedupKey(chapterTitle)}`) {
                existingChapters.set(originalTitleKey, "new");
              }
            }
          } else if (chStatus === 200 || chStatus === 409) {
            // Already exists (409) or updated (200) — count as skipped, not failed
            skippedChaptersCount.increment();
          } else {
            failedItemsCount.increment();
          }
          processedChaptersCount.increment();
        } catch (err) {
          failedItemsCount.increment();
          recordAdaptiveResponse(chapter.url, contentStartTime ? Date.now() - contentStartTime : 0, false);
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`[Task ${taskId}] Error scraping chapter ${chapter.url}:`, errMsg);
          await addTaskLog(taskId, "error", `章节采集失败: ${chapter.title || chapter.url}`, chapter.url, errMsg.slice(0, 500));
          // Collect for post-loop retry (exclude CAPTCHA doNotRetry errors)
          if (!(err instanceof Error && (err as Record<string, unknown>).doNotRetry)) {
            failedChapters.push({ url: chapter.url, title: chapter.title, sortOrder: chapter.sortOrder, bookId: book.id });
          }
        }
      }

      const chapterWorkers: Promise<void>[] = [];
      for (let w = 0; w < Math.min(threadCount, chapters.length); w++) {
        chapterWorkers.push(
          (async () => {
            while (chapterQueue.length > 0) {
              if (abortController.signal.aborted) break;
              await processChapter();
            }
          })()
        );
      }

      await Promise.all(chapterWorkers);

      // --- Failed chapter recovery phase ---
      if (failedChapters.length > 0 && !abortController.signal.aborted) {
        console.log(`[Task ${taskId}] Retrying ${failedChapters.length} failed chapters for ${book.title}...`);
        streamLogToWS(taskId, "info", `Retrying ${failedChapters.length} failed chapters...`);

        try {
          const retryResult = await retryFailedChapters(taskId, failedChapters, {
            engineType,
            antiCrawlConfig,
            contentSelector,
            contentTitleSelector,
            contentPagination,
            cleanConfig,
            abortSignal: abortController.signal,
          });

          if (retryResult.recovered > 0) {
            // Adjust counters: recovered chapters count as newly created
            for (let r = 0; r < retryResult.recovered; r++) newChaptersCount.increment();
            for (let r = 0; r < retryResult.retried; r++) processedChaptersCount.increment();

            // Re-sort chapters to fix any sortOrder gaps from recovered chapters
            const reordered = await resortChapters(book.id, abortController.signal);
            if (reordered) {
              await addTaskLog(taskId, "info", `章节顺序已修复: ${book.title}`);
            }

            streamLogToWS(taskId, "success",
              `恢复 ${retryResult.recovered}/${retryResult.retried} 章节 (${book.title})`
            );
          }
        } catch (retryErr) {
          console.error(`[Task ${taskId}] Failed chapter recovery error for ${book.title}:`, retryErr);
          // Recovery is best-effort, don't fail the main task
        }
      }

      // Update progress
      const chapterProgress = 50 + ((bookIdx + 1) / booksProcessed.length) * 45;
      await updateTaskProgress(taskId, {
        progress: Math.round(chapterProgress),
        totalChapters: processedChaptersCount.value,
        newChapters: newChaptersCount.value,
        failedItems: failedItemsCount.value,
        skippedItems: skippedBooksCount.value + skippedChaptersCount.value,
        currentStep: `已完成 ${book.title} (${chapters.length} 章)`,
      });

      console.log(`[Task ${taskId}] Completed ${book.title}: ${chapters.length} chapters`);
      await addTaskLog(taskId, "success", `完成采集 ${book.title}: 共 ${chapters.length} 章`, book.url);
    } catch (err) {
      console.error(`[Task ${taskId}] Error processing chapters for ${book.title}:`, err);
      await addTaskLog(taskId, "error", `章节目录采集失败: ${book.title}`, book.url, String(err));
      failedItemsCount.increment();
    }
  }

  // 6. Finalize task
  // Wrap in try-catch so task always gets marked completed even if queue stats fail
  let queueStats;
  try {
    queueStats = await getQueueStats(taskId);
  } catch {
    queueStats = undefined;
  }

  try {
    await updateTaskProgress(taskId, {
      status: "completed",
      completedAt: new Date().toISOString(),
      progress: 100,
      currentStep: "采集完成",
      totalBooks: booksProcessed.length,
      newBooks: newBooksCount.value,
      totalChapters: processedChaptersCount.value,
      newChapters: newChaptersCount.value,
      failedItems: failedItemsCount.value,
      skippedItems: skippedBooksCount.value + skippedChaptersCount.value,
    });
  } catch (err) {
    console.error(`[Task ${taskId}] Failed to mark task as completed (will be recovered by stuck detection):`, err);
  }

  // Final task log (non-critical — must not affect task success status)
  try {
    await addTaskLog(
      taskId,
      "success",
      `任务完成! [引擎:${engineType}] 新建小说: ${newBooksCount.value}, 新建章节: ${newChaptersCount.value}, 跳过: ${skippedBooksCount.value + skippedChaptersCount.value}, 失败: ${failedItemsCount.value}`
    );
  } catch (err) {
    console.error(`[Task ${taskId}] Failed to write final task log (non-critical):`, err);
  }

  console.log(`[Task ${taskId}] Task completed. Queue stats: ${JSON.stringify(queueStats)}`);

  return {
    success: true,
    totalBooks: booksProcessed.length,
    newBooks: newBooksCount.value,
    totalChapters: processedChaptersCount.value,
    newChapters: newChaptersCount.value,
    failed: failedItemsCount.value,
    skipped: skippedBooksCount.value + skippedChaptersCount.value,
    engine: engineType,
    queueStats,
    chapterWordCounts: chapterWordCounts.length > 0 ? chapterWordCounts : undefined,
  };
  } finally {
    // Cleanup per-domain engine overrides (only when no other tasks reference them)
    // Always runs, even if the task throws early (e.g., list page fetch fails)
    for (const d of _touchedDomains) {
      const remaining = (_domainEngineRefCount.get(d) || 1) - 1;
      if (remaining <= 0) {
        _domainEngineTypes.delete(d);
        _domainEngineRefCount.delete(d);
      } else {
        _domainEngineRefCount.set(d, remaining);
      }
    }
  }
}

// ==================== Failed Chapter Recovery ====================

/** Info needed to retry a failed chapter scrape */
interface FailedChapterInfo {
  url: string;
  title: string;
  sortOrder: number;
  bookId: string;
}

/** Summary result of retrying failed chapters */
interface RetryFailedChaptersResult {
  retried: number;
  recovered: number;
  stillFailed: number;
}

/**
 * Retry chapters that failed during the main scraping phase.
 * Processes failed chapters in sortOrder, using the same engine and anti-crawl config
 * as the original task. Each chapter gets one additional retry attempt.
 *
 * @param taskId - The scraping task ID (for logging and progress)
 * @param failedChapters - List of failed chapters with URL, title, sortOrder, and bookId
 * @param options - Scraping configuration (engine, anti-crawl, selectors, etc.)
 * @returns Summary with retried/recovered/stillFailed counts
 */
export async function retryFailedChapters(
  taskId: string,
  failedChapters: FailedChapterInfo[],
  options: {
    engineType: EngineType;
    antiCrawlConfig: AntiCrawl;
    contentSelector: ReturnType<typeof parseSelectorField>;
    contentTitleSelector: ReturnType<typeof parseSelectorField>;
    contentPagination: Pagination | undefined;
    cleanConfig: CleanRequest["config"];
    abortSignal: AbortSignal;
  }
): Promise<RetryFailedChaptersResult> {
  if (failedChapters.length === 0) {
    return { retried: 0, recovered: 0, stillFailed: 0 };
  }

  // Sort by sortOrder to process in chapter order
  const sorted = [...failedChapters].sort((a, b) => a.sortOrder - b.sortOrder);

  let recovered = 0;
  let stillFailed = 0;
  const retried = sorted.length;

  await addTaskLog(taskId, "info", `开始重试 ${retried} 个失败章节...`);
  await updateTaskProgress(taskId, {
    currentStep: `正在重试失败章节 (0/${retried})...`,
  });

  for (let i = 0; i < sorted.length; i++) {
    const ch = sorted[i];

    // Check for abort before each retry
    if (options.abortSignal.aborted) {
      stillFailed += (sorted.length - i);
      await addTaskLog(taskId, "warn", `任务已取消，终止剩余 ${sorted.length - i} 个章节重试`);
      break;
    }

    try {
      // Delay between retries (same anti-crawl config as original)
      if (options.antiCrawlConfig.delay) {
        await getAdaptiveOrRandomDelay(
          ch.url,
          options.antiCrawlConfig.delay[0],
          options.antiCrawlConfig.delay[1],
          options.abortSignal
        );
      }

      // Use the same engine fallback chain pattern as the main scrape
      const _retryEngine = getEffectiveEngine(ch.url, options.engineType);
      const _retryDomain = (() => { try { return new URL(ch.url).hostname; } catch { return undefined; } })();
      const fallbackChain = getFallbackChainForEngine(_retryEngine, _retryDomain);
      const enginesToTry = fallbackChain.slice(0, MAX_ENGINE_RETRIES);

      let contentResult: Awaited<ReturnType<typeof handleScrapeContent>>;
      let retrySuccess = false;

      for (const tryEngine of enginesToTry) {
        try {
          contentResult = await handleScrapeContent({
            url: ch.url,
            selectors: {
              title: options.contentTitleSelector || undefined,
              content: options.contentSelector!,
            },
            pagination: options.contentPagination,
            antiCrawl: options.antiCrawlConfig,
            engine: tryEngine,
            cleanConfig: options.cleanConfig,
            signal: options.abortSignal,
          });
          retrySuccess = true;
          break;
        } catch (contentErr) {
          const errReason = contentErr instanceof Error ? contentErr.message : String(contentErr);
          const isDoNotRetry = contentErr instanceof Error && (contentErr as Record<string, unknown>).doNotRetry;
          const isCaptcha = errReason.includes('CAPTCHA');
          if (isDoNotRetry || isCaptcha) {
            streamLogToWS(taskId, 'warn', `Chapter retry skipped (doNotRetry/CAPTCHA): ${ch.title}`, ch.url);
            break; // Stop trying other engines for this chapter
          }
          // Continue to next engine in chain
        }
      }

      if (!retrySuccess) {
        stillFailed++;
        streamLogToWS(taskId, "error", `章节重试失败: ${ch.title || ch.url}`, ch.url);
        continue;
      }

      // Normalize content (same as main processChapter)
      const chapterContent = contentResult.content
        .replace(/\t/g, ' ')
        .replace(/ {3,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      const chapterTitle = contentResult.title || ch.title;

      if (!chapterContent.trim()) {
        stillFailed++;
        streamLogToWS(taskId, "warn", `章节重试内容为空: ${chapterTitle}`, ch.url);
        continue;
      }

      // Save recovered chapter via API
      await dbWriteSemaphore.acquire();
      try {
        const result = await apiCall(
          "POST",
          `/api/novels/${ch.bookId}/chapters`,
          {
            title: chapterTitle,
            content: chapterContent,
            sortOrder: ch.sortOrder,
            sourceUrl: ch.url,
          },
          options.abortSignal
        );

        if (result.status === 201) {
          recovered++;
          streamLogToWS(taskId, "success", `章节恢复成功: ${chapterTitle}`, ch.url);
        } else {
          stillFailed++;
          streamLogToWS(taskId, "warn", `章节重试保存失败(HTTP ${result.status}): ${chapterTitle}`, ch.url);
        }
      } finally {
        dbWriteSemaphore.release();
      }
    } catch (err) {
      stillFailed++;
      const errMsg = err instanceof Error ? err.message : String(err);
      streamLogToWS(taskId, "error", `章节重试异常: ${ch.title || ch.url}`, ch.url, errMsg.slice(0, 500));
    }

    // Progress update every 5 chapters or on last
    if ((i + 1) % 5 === 0 || i === sorted.length - 1) {
      await updateTaskProgress(taskId, {
        currentStep: `正在重试失败章节 (${i + 1}/${retried})...`,
      });
    }
  }

  await addTaskLog(
    taskId,
    recovered > 0 ? "success" : "warn",
    `失败章节重试完成: 重试 ${retried}, 恢复 ${recovered}, 仍失败 ${stillFailed}`
  );

  return { retried, recovered, stillFailed };
}

/**
 * Re-number chapter sortOrder values sequentially starting from 1.
 * Fixes gaps caused by chapters that were originally skipped but later recovered
 * with their original sortOrder values.
 *
 * @param novelId - The novel whose chapters should be re-ordered
 * @param abortSignal - Optional abort signal for task cancellation
 * @returns true if chapters were re-ordered, false if no gaps were found
 */
export async function resortChapters(
  novelId: string,
  abortSignal?: AbortSignal
): Promise<boolean> {
  try {
    // Fetch all chapters ordered by sortOrder (max 5000 per the API limit)
    const { data, status } = await apiCall(
      "GET",
      `/api/novels/${novelId}/chapters?pageSize=5000`,
      undefined,
      abortSignal
    );

    if (status !== 200 || !data) return false;

    const chapters = (data as { chapters?: Array<{ id: string; sortOrder: number }> }).chapters || [];
    if (chapters.length === 0) return false;

    // Check for gaps in sortOrder
    let hasGaps = false;
    for (let i = 0; i < chapters.length; i++) {
      if (chapters[i].sortOrder !== i + 1) {
        hasGaps = true;
        break;
      }
    }

    if (!hasGaps) return false;

    // Build batch reorder payload
    const orders = chapters.map((ch, idx) => ({
      id: ch.id,
      sortOrder: idx + 1,
    }));

    // Use the batch reorder endpoint (max 5000 per request)
    const { status: patchStatus } = await apiCall(
      "PATCH",
      `/api/novels/${novelId}/chapters`,
      { action: "reorder", orders },
      abortSignal
    );

    if (patchStatus === 200 || patchStatus === 204) {
      console.log(`[ResortChapters] Re-ordered ${chapters.length} chapters for novel ${novelId}`);
      return true;
    }

    console.warn(`[ResortChapters] Failed to reorder chapters for novel ${novelId}: HTTP ${patchStatus}`);
    return false;
  } catch (err) {
    console.error(`[ResortChapters] Error reordering chapters for novel ${novelId}:`, err);
    return false;
  }
}

/**
 * Detect tasks that are "running" but haven't sent a heartbeat recently.
 * A task is considered stuck if its lastHeartbeatAt is older than HEARTBEAT_TIMEOUT_MS,
 * or if it has no heartbeat but has been running longer than FALLBACK_STALE_THRESHOLD_MS.
 * @returns number of tasks marked as failed
 */
export async function detectStuckTasks(): Promise<number> {
  try {
    const { data, status } = await apiCall("GET", "/api/scrape-tasks?status=running");
    if (status !== 200 || !Array.isArray(data)) return 0;

    const tasks = data as Array<{ id: string; startedAt?: string; lastHeartbeatAt?: string | null }>;
    const now = Date.now();
    const HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
    const FALLBACK_STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours (for tasks without heartbeat)
    let detected = 0;

    for (const task of tasks) {
      let isStuck = false;
      let reason = "";

      if (task.lastHeartbeatAt) {
        // Heartbeat-based detection: more precise
        const lastHb = new Date(task.lastHeartbeatAt).getTime();
        if (now - lastHb > HEARTBEAT_TIMEOUT_MS) {
          isStuck = true;
          reason = "\u4efb\u52a1\u8d85\u65f6: \u5fc3\u8df3\u8d85\u65f6";
        }
      } else if (task.startedAt) {
        // Fallback for tasks that don't have heartbeat (e.g., crashed before first heartbeat)
        const started = new Date(task.startedAt).getTime();
        if (now - started > FALLBACK_STALE_THRESHOLD_MS) {
          isStuck = true;
          reason = "\u4efb\u52a1\u6062\u590d: \u8fd0\u884c\u8d85\u8fc72\u5c0f\u65f6\u4e14\u65e0\u5fc3\u8df3";
        }
      }

      if (isStuck) {
        await apiCall("PUT", `/api/scrape-tasks/${task.id}`, {
          status: "failed",
          errorMessage: reason,
          completedAt: new Date().toISOString(),
        });
        detected++;
        console.log(`[StuckDetection] Marked task ${task.id} as failed: ${reason}`);
      }
    }

    return detected;
  } catch (err) {
    console.error("[StuckDetection] Failed to check stuck tasks:", err);
    return 0;
  }
}

/**
 * On startup, mark any tasks that have been "running" for too long as "failed".
 * This handles the case where the scraper-service crashed mid-task.
 * Delegates to detectStuckTasks() which uses heartbeat-based detection.
 */
export async function recoverStaleTasks(): Promise<number> {
  return detectStuckTasks();
}