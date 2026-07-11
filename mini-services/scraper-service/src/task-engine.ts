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
  parseJsonField, parseSelectorField as _parseSelectorField,
  mapNovelStatus, randomDelay, retryWithBackoff, getRandomUA, isSafeSavePath,
} from "./utils";
import { getEngine, selectEngine } from "./engines";
import { parseSelector } from "./selectors";
import { handleClean } from "./cleaning";
import { handleScrapeList, handleScrapeBook, handleScrapeChapters, handleScrapeContent, handleDownloadCover } from "./scrapers";
import { addToQueue, isUrlProcessed, markCompleted, markFailed, getQueueStats, clearTaskQueue } from "./queue";

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
    this.running--;
    if (this.queue.length > 0) { this.running++; this.queue.shift()!(); }
  }
}

const dbWriteSemaphore = new Semaphore(3);

// ==================== API Client ====================

const API_BASE = process.env.MAIN_APP_URL || "http://localhost:3000";

async function apiCall(
  method: string,
  path: string,
  body?: unknown
): Promise<{ data: unknown; status: number }> {
  const options: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.SCRAPER_SERVICE_TOKEN || ""}`,
    },
    signal: AbortSignal.timeout(30000),
  };
  if (body) {
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

async function updateTaskProgress(taskId: string, updates: Partial<ScrapeTask>) {
  const now = Date.now();
  const lastUpdate = progressThrottle.get(taskId) || 0;

  // Always allow status changes immediately
  if (!updates.status && now - lastUpdate < PROGRESS_THROTTLE_MS) {
    return; // Skip throttled non-critical update
  }

  progressThrottle.set(taskId, now);
  try {
    await apiCall("PUT", `/api/scrape-tasks/${taskId}`, updates);
  } catch (err) {
    console.error(`[Task] Failed to update task progress:`, err);
  }
}

async function addTaskLog(
  taskId: string,
  level: string,
  message: string,
  url?: string,
  detail?: string
) {
  try {
    await apiCall("POST", `/api/scrape-tasks/${taskId}/logs`, {
      level,
      message,
      url: url || null,
      detail: detail || null,
    });
  } catch (err) {
    console.error(`[Task] Failed to add log:`, err);
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
  if (rule.engine && ["cheerio", "playwright", "firecrawl", "agentql", "cloud-browser"].includes(rule.engine)) {
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

  // 1. Fetch task + rule from Next.js API
  const { data: taskData, status } = await apiCall("GET", `/api/scrape-tasks/${taskId}`);

  if (status !== 200 || !taskData) {
    throw new Error(`Failed to fetch task ${taskId}: HTTP ${status}`);
  }

  const task = taskData as ScrapeTask;
  const rule = task.rule;

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

  if (!antiCrawlConfig.delay) {
    antiCrawlConfig.delay = [rule.minDelay, rule.maxDelay];
  }

  // Determine engine
  const engineType = determineEngine(rule, antiCrawlConfig);
  console.log(`[Task ${taskId}] Engine: ${engineType}, Rule: ${rule.name}, Mode: ${task.mode || rule.scrapeMode}`);

  // Clear any previous queue data for this task
  clearTaskQueue(taskId);

  const threadCount = rule.threadCount || 3;
  const isIncremental = (task.mode || rule.scrapeMode) === "incremental";
  const dedupMode = rule.dedupMode || "url";

  // Update task status
  await updateTaskProgress(taskId, {
    status: "running",
    startedAt: new Date().toISOString(),
    currentStep: "正在采集列表页...",
    progress: 0,
  });

  await addTaskLog(taskId, "info", `开始执行采集任务: ${rule.name} [引擎: ${engineType}]`);

  // Overall task timeout (1 hour max)
  const TASK_TIMEOUT_MS = 60 * 60 * 1000;
  const taskTimeoutId = setTimeout(() => {
    console.error(`[Task ${taskId}] Overall timeout (${TASK_TIMEOUT_MS / 1000}s) exceeded, aborting`);
    // Will be caught by the Promise.race below
  }, TASK_TIMEOUT_MS);
  const taskTimeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`任务执行超时（${TASK_TIMEOUT_MS / 1000 / 60}分钟）`)), TASK_TIMEOUT_MS);
  });

  try {
    await Promise.race([
      executeTaskBody(taskId, task, rule),
      taskTimeoutPromise,
    ]);
  } finally {
    clearTimeout(taskTimeoutId);
  }
}

async function executeTaskBody(
  taskId: string,
  task: ScrapeTask,
  rule: ScrapeRule
): Promise<void> {

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
  });

  const bookUrls = listResult.urls;
  console.log(`[Task ${taskId}] Found ${bookUrls.length} book URLs`);

  await addTaskLog(taskId, "success", `列表页采集完成，共发现 ${bookUrls.length} 本书 [引擎: ${listResult.engine}]`);

  // Add all book URLs to the queue for resume capability
  for (const bookUrl of bookUrls) {
    addToQueue({ url: bookUrl, taskId, metadata: { type: "book", taskId } });
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
    return { success: true, totalBooks: 0, totalChapters: 0 };
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
  let totalChaptersCount = new AtomicCounter();
  let newChaptersCount = new AtomicCounter();
  let skippedChaptersCount = new AtomicCounter();
  const booksProcessed: Array<{ id: string; title: string; url: string }> = [];

  async function processBook(bookUrl: string, index: number): Promise<void> {
    try {
      console.log(`[Task ${taskId}] Processing book ${index + 1}/${bookUrls.length}: ${bookUrl}`);

      if (antiCrawlConfig.delay) {
        await randomDelay(antiCrawlConfig.delay[0], antiCrawlConfig.delay[1]);
      }

      // Scrape book info using selected engine
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
        engine: engineType,
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
          `/api/novels?pageSize=100&search=${encodeURIComponent(bookInfo.title)}`
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

      if (isExisting) {
        await apiCall("PUT", `/api/novels/${novelId}`, novelData);
        await addTaskLog(taskId, "info", `更新小说: ${bookInfo.title}`, bookUrl);
      } else {
        const { data: createdNovel, status: createStatus } = await apiCall("POST", "/api/novels", novelData);
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

      booksProcessed.push({ id: novelId, title: bookInfo.title, url: bookUrl });

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
            await apiCall("PUT", `/api/novels/${novelId}`, { coverPath: savePath });
          }
        } catch (coverErr) {
          console.error(`[Task ${taskId}] Cover download failed for ${bookInfo.title}:`, coverErr);
          await addTaskLog(taskId, "warn", `封面下载失败: ${bookInfo.title}`, bookInfo.coverUrl, String(coverErr));
        }
      }
    } catch (err) {
      failedItemsCount.increment();
      console.error(`[Task ${taskId}] Error processing book ${bookUrl}:`, err);
      await addTaskLog(taskId, "error", `采集书籍失败: ${bookUrl}`, bookUrl, String(err));
    }
  }

  // Process books with concurrency pool
  const bookQueue = [...bookUrls];

  async function processAllBooks(): Promise<void> {
    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(threadCount, bookUrls.length); i++) {
      workers.push(
        (async () => {
          while (bookQueue.length > 0) {
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
    return { success: true, totalBooks: 0, newBooks: 0, totalChapters: 0, newChapters: 0 };
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
        await randomDelay(antiCrawlConfig.delay[0], antiCrawlConfig.delay[1]);
      }

      // Scrape chapter list using selected engine
      const { chapters } = await handleScrapeChapters({
        url: chapterListUrl,
        selectors: {
          list: chapterListSelector,
          title: chapterTitleSelector,
          link: chapterLinkSelector,
        },
        pagination: chapterPagination,
        antiCrawl: antiCrawlConfig,
        enableShuffle: rule.enableShuffle,
        engine: engineType,
      });

      console.log(`[Task ${taskId}] Found ${chapters.length} chapters for ${book.title}`);

      if (chapters.length === 0) {
        await addTaskLog(taskId, "warn", `未发现章节: ${book.title}`, chapterListUrl);
        continue;
      }

      await addTaskLog(taskId, "info", `发现 ${chapters.length} 个章节: ${book.title}`, chapterListUrl);

      // Add chapter URLs to queue
      for (const ch of chapters) {
        addToQueue({
          url: ch.url,
          taskId,
          metadata: { type: "chapter", bookId: book.id, title: ch.title, sortOrder: ch.sortOrder, taskId },
        });
      }

      // 5. Scrape chapter content
      const contentSelector = parseSelectorField(rule.contentSelector);
      const contentTitleSelector = parseSelectorField(rule.contentTitleSelector);
      const contentPagination = parseJsonField<Pagination>(rule.contentPagination, undefined);

      if (!contentSelector) {
        await addTaskLog(taskId, "warn", `缺少正文选择器，跳过内容采集: ${book.title}`);
        continue;
      }

      // Get existing chapters for incremental mode
      const existingChapters = new Map<string, string>();
      if (isIncremental) {
        try {
          const { data: existingData, status: existingStatus } = await apiCall(
            "GET",
            `/api/novels/${book.id}/chapters`
          );
          if (existingStatus === 200 && Array.isArray(existingData)) {
            for (const ch of existingData as Array<{ id: string; sourceUrl?: string; title: string }>) {
              if (ch.sourceUrl) existingChapters.set(ch.sourceUrl, ch.id);
              existingChapters.set(`title:${ch.title}`, ch.id);
            }
          }
        } catch { /* ignore */ }
      }

      // Process chapters with concurrency
      const chapterQueue = [...chapters];

      async function processChapter(): Promise<void> {
        if (chapterQueue.length === 0) return;
        const chapter = chapterQueue.shift()!;

        try {
          if (isIncremental) {
            if (existingChapters.has(chapter.url) || existingChapters.has(`title:${chapter.title}`)) {
              skippedChaptersCount.increment();
              return;
            }
          }

          if (antiCrawlConfig.delay) {
            await randomDelay(antiCrawlConfig.delay[0], antiCrawlConfig.delay[1]);
          }

          // Scrape chapter content using selected engine
          const contentResult = await handleScrapeContent({
            url: chapter.url,
            selectors: {
              title: contentTitleSelector || undefined,
              content: contentSelector,
            },
            pagination: contentPagination,
            antiCrawl: antiCrawlConfig,
            engine: engineType,
          });

          // Clean content
          const cleaned = handleClean({
            html: contentResult.content,
            config: cleanConfig,
          });

          const chapterTitle = contentResult.title || chapter.title;
          const chapterContent = cleaned.content;

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
              }
            );
            chStatus = result.status;
          } finally {
            dbWriteSemaphore.release();
          }

          if (chStatus === 201) {
            newChaptersCount.increment();
            totalChaptersCount.increment();
          } else {
            failedItemsCount.increment();
          }
        } catch (err) {
          failedItemsCount.increment();
          console.error(`[Task ${taskId}] Error scraping chapter ${chapter.url}:`, err);
        }
      }

      const chapterWorkers: Promise<void>[] = [];
      for (let w = 0; w < Math.min(threadCount, chapters.length); w++) {
        chapterWorkers.push(
          (async () => {
            while (chapterQueue.length > 0) {
              await processChapter();
            }
          })()
        );
      }

      await Promise.all(chapterWorkers);

      // Update progress
      const chapterProgress = 50 + ((bookIdx + 1) / booksProcessed.length) * 45;
      await updateTaskProgress(taskId, {
        progress: Math.round(chapterProgress),
        totalChapters: totalChaptersCount.value,
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
  const queueStats = getQueueStats(taskId);

  await updateTaskProgress(taskId, {
    status: "completed",
    completedAt: new Date().toISOString(),
    progress: 100,
    currentStep: "采集完成",
    totalBooks: booksProcessed.length,
    newBooks: newBooksCount.value,
    totalChapters: totalChaptersCount.value,
    newChapters: newChaptersCount.value,
    failedItems: failedItemsCount.value,
    skippedItems: skippedBooksCount.value + skippedChaptersCount.value,
  });

  await addTaskLog(
    taskId,
    "success",
    `任务完成! [引擎:${engineType}] 新建小说: ${newBooksCount.value}, 新建章节: ${newChaptersCount.value}, 跳过: ${skippedBooksCount.value + skippedChaptersCount.value}, 失败: ${failedItemsCount.value}`
  );

  console.log(`[Task ${taskId}] Task completed. Queue stats: ${JSON.stringify(queueStats)}`);

  return {
    success: true,
    totalBooks: booksProcessed.length,
    newBooks: newBooksCount.value,
    totalChapters: totalChaptersCount.value,
    newChapters: newChaptersCount.value,
    failed: failedItemsCount.value,
    skipped: skippedBooksCount.value + skippedChaptersCount.value,
    engine: engineType,
    queueStats,
  };
}