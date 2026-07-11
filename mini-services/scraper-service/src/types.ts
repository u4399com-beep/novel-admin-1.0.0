/**
 * Types for the Scraper Service
 * Central type definitions for the entire scraping system.
 */

// ==================== Selector Types ====================

export type SelectorType = "css" | "xpath" | "regex";

export interface Selector {
  type: SelectorType;
  value: string;
}

export interface Pagination {
  type: "next" | "page";
  selector: string;
  maxPage?: number;
}

// ==================== Anti-Crawl Types ====================

export interface AntiCrawl {
  useJsRender?: boolean;
  uaRotation?: boolean;
  cookies?: Array<{ name: string; value: string; domain?: string }>;
  delay?: [number, number]; // [minMs, maxMs]
  proxy?: string;
  retries?: number;
}

// ==================== Engine Types ====================

export type EngineType = "cheerio" | "playwright" | "firecrawl";

export interface FetchResult {
  html: string;
  finalUrl: string;
  statusCode: number;
}

export interface EngineOptions {
  antiCrawl?: AntiCrawl;
  timeout?: number;
  proxy?: string;
  cookies?: Array<{ name: string; value: string; domain?: string }>;
  userAgent?: string;
}

export interface ScrapingEngine {
  readonly name: EngineType;
  fetch(url: string, options?: EngineOptions): Promise<FetchResult>;
  close?(): Promise<void>;
}

// ==================== Scrape Request Types ====================

export interface ScrapeListRequest {
  url: string;
  selector: Selector;
  pagination?: Pagination;
  antiCrawl?: AntiCrawl;
  engine?: EngineType;
}

export interface ScrapeBookRequest {
  url: string;
  selectors: {
    title: Selector;
    author?: Selector;
    category?: Selector;
    keywords?: Selector;
    description?: Selector;
    cover?: Selector;
    status?: Selector;
  };
  antiCrawl?: AntiCrawl;
  engine?: EngineType;
}

export interface ScrapeChaptersRequest {
  url: string;
  selectors: {
    list: Selector;
    title: Selector;
    link: Selector;
  };
  pagination?: Pagination;
  antiCrawl?: AntiCrawl;
  enableShuffle?: boolean;
  engine?: EngineType;
}

export interface ScrapeContentRequest {
  url: string;
  selectors: {
    title?: Selector;
    content: Selector;
  };
  pagination?: Pagination;
  antiCrawl?: AntiCrawl;
  engine?: EngineType;
}

export interface CleanRequest {
  html: string;
  config: {
    removeAds?: boolean;
    cleanHtml?: boolean;
    removePatterns?: string[];
    adPatterns?: string[];
  };
}

export interface DownloadCoverRequest {
  url: string;
  savePath: string;
}

export interface ExecuteTaskRequest {
  taskId: string;
}

// ==================== Chapter & Link Types ====================

export interface ChapterLink {
  title: string;
  url: string;
  sortOrder: number;
}

// ==================== Queue Types ====================

export interface QueueItem {
  id: string;
  url: string;
  method: string;
  payload: string | null;
  retries: number;
  maxRetries: number;
  status: "pending" | "in_progress" | "completed" | "failed";
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  metadata: string | null; // JSON string for extra data
}

// ==================== Proxy Types ====================

export interface ProxyConfig {
  urls: string[];
  rotationStrategy: "round-robin" | "random" | "least-used";
}

// ==================== Session Types ====================

export interface SessionData {
  id: string;
  userAgent: string;
  cookies: Array<{ name: string; value: string; domain?: string }>;
  usageCount: number;
  maxUsage: number;
  createdAt: string;
  lastUsedAt: string;
  blocked: boolean;
}

// ==================== Scrape Rule & Task (DB Model Types) ====================

export interface ScrapeRule {
  id: string;
  name: string;
  listUrl: string | null;
  listSelector: string | null;
  listPagination: string | null;
  bookTitleSelector: string | null;
  bookAuthorSelector: string | null;
  bookCategorySelector: string | null;
  bookKeywordsSelector: string | null;
  bookDescriptionSelector: string | null;
  bookCoverSelector: string | null;
  bookStatusSelector: string | null;
  chapterListUrl: string | null;
  chapterListSelector: string | null;
  chapterTitleSelector: string | null;
  chapterLinkSelector: string | null;
  chapterPagination: string | null;
  contentTitleSelector: string | null;
  contentSelector: string | null;
  contentPagination: string | null;
  antiCrawlConfig: string | null;
  storageMode: string;
  filePath: string | null;
  coverSavePath: string | null;
  scrapeMode: string;
  threadCount: number;
  minDelay: number;
  maxDelay: number;
  enableShuffle: boolean;
  dedupMode: string;
  cleanConfig: string | null;
  // New fields for engine
  engine?: string;
  proxyConfig?: string | null;
}

export interface ScrapeTask {
  id: string;
  ruleId: string;
  status: string;
  mode: string;
  totalBooks: number;
  totalChapters: number;
  newBooks: number;
  newChapters: number;
  failedItems: number;
  skippedItems: number;
  progress: number;
  currentStep: string | null;
  errorMessage: string | null;
  rule: ScrapeRule;
}

// ==================== Firecrawl Config ====================

export interface FirecrawlConfig {
  apiUrl: string;   // e.g. "http://localhost:3002" or "https://api.firecrawl.dev"
  apiKey?: string;  // For cloud API
  timeout?: number;
}