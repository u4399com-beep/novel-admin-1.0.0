/**
 * Types for the Scraper Service
 * Central type definitions for the entire scraping system.
 */

// ==================== Selector Types ====================

export type SelectorType = "css" | "xpath" | "regex";

export interface Selector {
  type: SelectorType;
  value: string;
  /** Attribute name to extract (e.g. "content" for meta tags, "href" for links). Default: text content */
  extract?: string;
}

export interface Pagination {
  type: "next" | "page" | "infinite-scroll";
  /** CSS selector for next-page link (required for 'next'/'page' types, unused for 'infinite-scroll') */
  selector?: string;
  maxPage?: number;
  /** For infinite-scroll: CSS selector of the "load more" button to click. */
  loadMoreSelector?: string;
  /** For infinite-scroll: max number of scroll+load cycles (default 10). */
  maxScrollCycles?: number;
  /** For infinite-scroll: selector for the content container to watch for new items. */
  contentContainerSelector?: string;
}

// ==================== Anti-Crawl Types ====================

export interface AntiCrawl {
  useJsRender?: boolean;
  uaRotation?: boolean;
  cookies?: Array<{ name: string; value: string; domain?: string }>;
  delay?: [number, number]; // [minMs, maxMs]
  proxy?: string;
  retries?: number;
  cloudBrowser?: boolean;
  /** Override Accept-Language header. If omitted, a random one is generated. */
  acceptLanguage?: string;
  /** Override Referer header. If omitted, one may be spoofed from context. */
  referer?: string;
  /** Add DNT (Do Not Track) header. Randomly chosen if omitted. */
  dnt?: boolean;
  /** Enable human-like request behavior (randomized timing, jitter, etc.). */
  humanBehavior?: boolean;
  /** Enable automatic engine fallback on failure (default: true for new tasks). */
  engineFallback?: boolean;
  /** Custom engine fallback chain (overrides default). Ordered from primary to last-resort. */
  engineFallbackChain?: EngineType[];
}

// ==================== Engine Types ====================

export type EngineType = "cheerio" | "playwright" | "firecrawl" | "agentql" | "cloud-browser" | "scrapling" | "obscura" | "dokobot";

export interface FetchResult {
  html: string;
  finalUrl: string;
  statusCode: number;
  /** The engine that actually produced this result (may differ from requested if fallback was used) */
  effectiveEngine?: EngineType;
  /** CAPTCHA detection result if detected during fetch */
  captcha?: {
    type: string;
    confidence: number;
    evidence: string[];
  };
}

export interface EngineOptions {
  antiCrawl?: AntiCrawl;
  timeout?: number;
  proxy?: string;
  cookies?: Array<{ name: string; value: string; domain?: string }>;
  userAgent?: string;
  /** AbortSignal for task-level cancellation (timeout/shutdown) */
  signal?: AbortSignal;
}

export interface ScrapingEngine {
  readonly name: EngineType;
  fetch(url: string, options?: EngineOptions): Promise<FetchResult>;
  close?(): Promise<void>;
}

// ==================== AgentQL Config ====================

export interface AgentQLConfig {
  apiKey?: string;
  apiUrl?: string; // default: https://api.agentql.com
  timeout?: number;
}

export interface AgentQLQuery {
  title?: string;
  author?: string;
  category?: string;
  description?: string;
  cover?: string;
  status?: string;
  chapters?: string;  // NL query for chapter list
  content?: string;   // NL query for main content
  [key: string]: string | undefined;
}

// ==================== CloudBrowser Config ====================

export interface CloudBrowserConfig {
  provider: "browserless" | "steel";
  apiUrl: string;
  apiKey?: string;
  timeout?: number;
  // Stealth features
  stealthMode?: boolean;
  blockResources?: boolean;
  waitForSelector?: string;
  extraWait?: number;
}

// ==================== Scrape Request Types ====================

export interface ScrapeListRequest {
  url: string;
  selector: Selector;
  pagination?: Pagination;
  antiCrawl?: AntiCrawl;
  engine?: EngineType;
  signal?: AbortSignal;
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
  signal?: AbortSignal;
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
  signal?: AbortSignal;
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
  cleanConfig?: CleanRequest["config"];
  signal?: AbortSignal;
}

export interface CleanRequest {
  html: string;
  config: {
    removeAds?: boolean;
    cleanHtml?: boolean;
    /** CSS selectors to remove from HTML (applied at HTML level before text extraction) */
    removeSelectors?: string[];
    /** Regex patterns that serve dual purpose: CSS selectors (HTML level) + regex (text level) */
    removePatterns?: string[];
    /** Text patterns for ad line detection (applied at text level) */
    adPatterns?: string[];
    /** Traditional → Simplified Chinese conversion */
    t2sConversion?: boolean;
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

/** Lightweight browser fingerprint stored with a session for consistency. */
export interface SessionFingerprint {
  screenWidth: number;
  screenHeight: number;
  colorDepth: number;
  pixelRatio: number;
  platform: string;
  deviceMemory: number;
  hardwareConcurrency: number;
  timezone: string;
  languages: string[];
}

export interface SessionData {
  id: string;
  userAgent: string;
  cookies: Array<{ name: string; value: string; domain?: string }>;
  /** Browser fingerprint data for session consistency across requests */
  fingerprint?: SessionFingerprint;
  /** Proxy URL associated with this session, if any */
  proxy?: string;
  /** Number of times this session has been used */
  requestCount: number;
  /** @deprecated Use requestCount instead. Kept for backward compatibility. */
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
  // AgentQL & CloudBrowser config (JSON strings stored in DB)
  agentqlConfig?: string | null;
  cloudBrowserConfig?: string | null;
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
  lastHeartbeatAt: string | null;
  rule: ScrapeRule;
}

// ==================== Firecrawl Config ====================

export interface FirecrawlConfig {
  apiUrl: string;   // e.g. "http://localhost:3002" or "https://api.firecrawl.dev"
  apiKey?: string;  // For cloud API
  timeout?: number;
}

// ==================== Priority Types ====================

export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';

export const PRIORITY_MAP: Record<TaskPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export const REVERSE_PRIORITY_MAP: Record<number, TaskPriority> = {
  0: 'critical',
  1: 'high',
  2: 'medium',
  3: 'low',
};

// ==================== Quality Scoring Types ====================

export interface QualityCheck {
  name: string;
  passed: boolean;
  score: number;
  message: string;
}

export interface QualityReport {
  taskId: string;
  overallScore: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  checks: QualityCheck[];
  summary: string;
  timestamp: string;
}

export interface ScrapeResult {
  totalBooks: number;
  newBooks: number;
  totalChapters: number;
  newChapters: number;
  failedItems: number;
  skippedItems: number;
  engine: string;
  duration?: number;
  /** Optional content sample for freshness scoring (e.g. first chapter text) */
  contentSample?: string;
  /** Optional book metadata for structural completeness scoring */
  bookMeta?: {
    title?: string;
    author?: string;
    description?: string;
    coverUrl?: string;
  };
}