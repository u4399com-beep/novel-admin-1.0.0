/**
 * Utilities - UA rotation, URL resolution, security, delay, retry, redirect following,
 * request fingerprint randomization, Referer spoofing, Accept-Language randomization
 */

import type { AntiCrawl } from "./types";
import { isSafeUrl } from "./ssrf";
import { randomUUID } from "node:crypto";

// ==================== User-Agent Rotation ====================

const USER_AGENTS: string[] = [
  // ---- Chrome Desktop (Windows) ----
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  // ---- Chrome Desktop (macOS Intel) ----
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  // ---- Chrome Desktop (macOS ARM / Apple Silicon) ----
  "Mozilla/5.0 (Macintosh; ARM Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; ARM Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; ARM Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; ARM Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  // ---- Safari (macOS) ----
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  // ---- Safari (macOS ARM / Apple Silicon) ----
  "Mozilla/5.0 (Macintosh; ARM Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
  "Mozilla/5.0 (Macintosh; ARM Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  // ---- Firefox ----
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:134.0) Gecko/20100101 Firefox/134.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0",
  "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:134.0) Gecko/20100101 Firefox/134.0",
  "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
  "Mozilla/5.0 (X11; Linux x86_64; rv:134.0) Gecko/20100101 Firefox/134.0",
  "Mozilla/5.0 (X11; Fedora; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
  // ---- Edge ----
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 Edg/132.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
  // ---- Linux Desktop ----
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  // ---- Mobile — iPhone ----
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
  // ---- Mobile — iPad ----
  "Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  // ---- Mobile — Android (Pixel) ----
  "Mozilla/5.0 (Linux; Android 14; Pixel 9 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; Pixel 9 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  // ---- Mobile — Samsung Galaxy ----
  "Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  // ---- Mobile — Xiaomi ----
  "Mozilla/5.0 (Linux; Android 14; 2312DRAABG) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; 2304FPN6DC) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  // ---- Mobile — Huawei ----
  "Mozilla/5.0 (Linux; Android 12; NOH-AN00) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 12; ELS-AN00) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
  // ---- Mobile — OnePlus ----
  "Mozilla/5.0 (Linux; Android 14; CPH2449) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  // ---- Opera ----
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 OPR/116.0.0.0",
];

export function getRandomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ==================== Accept-Language Randomization ====================

const ACCEPT_LANGUAGES: string[] = [
  "zh-CN,zh;q=0.9,en;q=0.8",
  "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
  "zh-CN,zh;q=0.9,zh-TW;q=0.8,en;q=0.7",
  "zh-CN,zh;q=0.8,en;q=0.7,zh-TW;q=0.6",
  "zh-TW,zh;q=0.9,en;q=0.8",
  "zh-TW,zh;q=0.9,zh-CN;q=0.8,en;q=0.7",
  "en-US,en;q=0.9",
  "en-US,en;q=0.9,zh-CN;q=0.8",
  "en-GB,en;q=0.9",
  "en-GB,en;q=0.9,zh-CN;q=0.7",
  "ja-JP,ja;q=0.9,en;q=0.8",
  "ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7",
  "ko-KR,ko;q=0.9,en;q=0.8",
  "ko-KR,ko;q=0.9,en-US;q=0.7,zh-CN;q=0.5",
  "zh-CN,zh;q=0.9,en;q=0.8,ja;q=0.7",
  "en-US,en;q=0.9,ja;q=0.8",
  "zh-CN,zh;q=0.9,en;q=0.8,zh-TW;q=0.7,ja;q=0.6",
  "de-DE,de;q=0.9,en;q=0.8",
  "fr-FR,fr;q=0.9,en;q=0.8",
  "es-ES,es;q=0.9,en;q=0.8",
];

/**
 * Returns a realistic Accept-Language header string.
 * Pool includes zh-CN, zh-TW, en-US, en-GB, ja-JP, ko-KR, de-DE, fr-FR, es-ES
 * with appropriate quality values.
 */
export function getRandomAcceptLanguage(): string {
  return ACCEPT_LANGUAGES[Math.floor(Math.random() * ACCEPT_LANGUAGES.length)];
}

// ==================== Referer Spoofing ====================

const SEARCH_ENGINE_REFERERS = [
  "https://www.baidu.com/s?wd=",
  "https://www.google.com/search?q=",
  "https://www.bing.com/search?q=",
  "https://www.sogou.com/web?query=",
  "https://www.baidu.com/s?ie=utf-8&wd=",
  "https://www.google.com.hk/search?q=",
  "https://search.yahoo.com/search?p=",
  "https://www.so.com/s?q=",
];

const NOVEL_SEARCH_QUERIES = [
  "斗破苍穹",
  "凡人修仙传",
  "遮天",
  "完美世界",
  "诡秘之主",
  "盗墓笔记",
  "全职高手",
  "庆余年",
  "赘婿",
  "雪中悍刀行",
  "大奉打更人",
  "天道图书馆",
  "全球高武",
  "牧神记",
  "我的师兄实在太稳健了",
  "万族之劫",
  "剑来",
  "诡秘之主",
  "一世之尊",
  "文学小说免费阅读",
  "起点中文网排行",
  "小说排行榜",
  "最新小说章节更新",
  "在线阅读",
  "免费小说网站",
  "笔趣阁",
  "book novel read online",
  "小说目录",
  "小说章节列表",
  "网络小说推荐",
];

/**
 * Generates a spoofed Referer header for a target URL.
 *
 * @param targetUrl - The URL being requested
 * @param siteType  - Optional site type hint. 'novel' generates fake search engine referers.
 * @returns A spoofed Referer URL, or undefined if spoofing is not applicable.
 */
export function getSpoofedReferer(targetUrl: string, siteType?: string): string | undefined {
  try {
    const target = new URL(targetUrl);

    // For novel sites: generate a fake search engine referer
    if (siteType === "novel" || Math.random() < 0.3) {
      const engine = SEARCH_ENGINE_REFERERS[Math.floor(Math.random() * SEARCH_ENGINE_REFERERS.length)];
      const query = NOVEL_SEARCH_QUERIES[Math.floor(Math.random() * NOVEL_SEARCH_QUERIES.length)];
      // Extract domain name from target to make the query more realistic
      const domain = target.hostname.replace(/^www\./, "");
      // Randomly include the domain in the search query for extra realism
      if (Math.random() < 0.4) {
        return `${engine}${encodeURIComponent(query + " " + domain)}`;
      }
      return `${engine}${encodeURIComponent(query)}`;
    }

    // For chapter-like URLs: generate a referer that looks like the book's table-of-contents page
    const pathParts = target.pathname.split("/").filter(Boolean);
    if (pathParts.length >= 2 && /chapter|第|ch/i.test(pathParts[pathParts.length - 1])) {
      // Remove the last path segment and use the rest as a referer (TOC page)
      const tocPath = "/" + pathParts.slice(0, -1).join("/");
      return `${target.origin}${tocPath}`;
    }

    // For other URLs: randomly return a search engine referer (20% chance)
    if (Math.random() < 0.2) {
      const engine = SEARCH_ENGINE_REFERERS[Math.floor(Math.random() * SEARCH_ENGINE_REFERERS.length)];
      const query = NOVEL_SEARCH_QUERIES[Math.floor(Math.random() * NOVEL_SEARCH_QUERIES.length)];
      return `${engine}${encodeURIComponent(query)}`;
    }

    // Default: no referer (direct navigation)
    return undefined;
  } catch {
    return undefined;
  }
}

// ==================== Sec-Fetch-* Header Randomization ====================

type SecFetchNavType = "navigate" | "reload" | "link";

const SEC_FETCH_COMBOS: Record<SecFetchNavType, Array<Record<string, string>>> = {
  navigate: [
    { "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none", "Sec-Fetch-User": "?1" },
    { "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "cross-site", "Sec-Fetch-User": "?1" },
    { "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "same-origin", "Sec-Fetch-User": "?1" },
  ],
  reload: [
    { "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "same-origin", "Sec-Fetch-User": "?1" },
    { "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "reload", "Sec-Fetch-Site": "same-origin", "Sec-Fetch-User": "?1" },
  ],
  link: [
    { "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "same-origin", "Sec-Fetch-User": "?1" },
    { "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "cross-site", "Sec-Fetch-User": "?1" },
  ],
};

/**
 * Returns randomized Sec-Fetch-* headers for a given navigation type.
 *
 * @param navigationType - One of 'navigate' | 'reload' | 'link' (default: 'navigate')
 * @returns A Record with Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site, and optionally Sec-Fetch-User
 */
export function getRandomSecFetchHeaders(navigationType?: SecFetchNavType): Record<string, string> {
  const type = navigationType || "navigate";
  const combos = SEC_FETCH_COMBOS[type] || SEC_FETCH_COMBOS["navigate"];
  return combos[Math.floor(Math.random() * combos.length)];
}

// ==================== Request Timing Randomization ====================

/**
 * Returns randomized network timing values that simulate realistic request overhead.
 * Can be used for analysis, logging, or injecting into performance metrics.
 *
 * @returns An object with dns (5-50ms), tcp (10-80ms), tls (20-100ms), ttfb (50-500ms)
 */
export function getRandomRequestTiming(): { dns: number; tcp: number; tls: number; ttfb: number } {
  const jitter = (min: number, max: number): number =>
    Math.round(min + Math.random() * (max - min));

  return {
    dns: jitter(5, 50),
    tcp: jitter(10, 80),
    tls: jitter(20, 100),
    ttfb: jitter(50, 500),
  };
}

// ==================== Chrome Client Hints ====================

/** Maps Chrome major version ranges to realistic sec-ch-ua brand strings. */
const CHROME_CLIENT_HINT_VERSIONS: string[] = [
  '"Not A(Brand";v="99", "Google Chrome";v="132", "Chromium";v="132"',
  '"Not A(Brand";v="99", "Google Chrome";v="131", "Chromium";v="131"',
  '"Not A(Brand";v="99", "Google Chrome";v="130", "Chromium";v="130"',
  '"Not A(Brand";v="99", "Google Chrome";v="129", "Chromium";v="129"',
  '"Not A(Brand";v="99", "Google Chrome";v="128", "Chromium";v="128"',
  '"Not A(Brand";v="99", "Google Chrome";v="127", "Chromium";v="127"',
];

const PLATFORM_HINT_MAP: Record<string, string> = {
  "Windows NT 10.0": '"Windows"',
  "Macintosh; Intel Mac OS X": '"macOS"',
  "Macintosh; ARM Mac OS X": '"macOS"',
  "X11; Linux x86_64": '"Linux"',
  "X11; Ubuntu; Linux x86_64": '"Linux"',
  "X11; Fedora; Linux x86_64": '"Linux"',
};

/**
 * Generates Chrome Client Hints headers (sec-ch-ua, sec-ch-ua-mobile, sec-ch-ua-platform)
 * that match the provided User-Agent string.
 *
 * Returns null for non-Chrome UAs.
 *
 * @param ua - User-Agent string to parse. If omitted, a random Chrome UA is selected.
 */
export function getChromeClientHints(ua?: string): { "sec-ch-ua": string; "sec-ch-ua-mobile": string; "sec-ch-ua-platform": string } | null {
  const userAgent = ua || getRandomUA();

  // Detect Chrome UA: must contain "Chrome/" but NOT contain Edge/OPR/Firefox/Safari (standalone)
  if (!userAgent.includes("Chrome/")) return null;
  if (userAgent.includes("Edg/") || userAgent.includes("OPR/") || userAgent.includes("Firefox/")) return null;
  // Safari standalone (no Chrome)
  if (userAgent.includes("Safari/") && !userAgent.includes("Chrome/")) return null;

  // Extract Chrome major version
  const chromeMatch = userAgent.match(/Chrome\/(\d+)/);
  if (!chromeMatch) return null;
  const chromeVersion = parseInt(chromeMatch[1]);

  // Find a matching Client Hints version (clamp to nearest available)
  let hintVersion = CHROME_CLIENT_HINT_VERSIONS[0];
  for (const hint of CHROME_CLIENT_HINT_VERSIONS) {
    const hintVerMatch = hint.match(/v="(\d+)"/);
    if (hintVerMatch && parseInt(hintVerMatch[1]) === chromeVersion) {
      hintVersion = hint;
      break;
    }
  }

  // Determine platform
  let platform = '"Unknown"';
  for (const [osPattern, platValue] of Object.entries(PLATFORM_HINT_MAP)) {
    if (userAgent.includes(osPattern)) {
      platform = platValue;
      break;
    }
  }

  // Determine mobile
  const isMobile = userAgent.includes("Mobile") ? "?1" : "?0";

  return {
    "sec-ch-ua": hintVersion,
    "sec-ch-ua-mobile": isMobile,
    "sec-ch-ua-platform": platform,
  };
}

// ==================== URL Resolution ====================

export function resolveUrl(base: string, relative: string): string {
  try {
    return new URL(relative, base).href;
  } catch {
    return relative;
  }
}

// ==================== Delay ====================

export function randomDelay(min: number, max: number): Promise<void> {
  const safeMin = Math.max(0, min || 0);
  const safeMax = Math.max(safeMin, max || 0);
  const ms = safeMin + Math.random() * (safeMax - safeMin);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ==================== Retry with Exponential Backoff ====================

export interface RetryOptions {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  factor?: number;
  jitter?: boolean;
  retryableStatuses?: number[];
  onRetry?: (attempt: number, error: Error) => void;
}

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 30000,
  factor: 2,
  jitter: true,
  retryableStatuses: [408, 429, 500, 502, 503, 504],
};

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {}
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
  const factor = opts.factor || 2;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt >= opts.maxRetries) break;

      // Check if error is retryable (non-HTTP errors like ECONNREFUSED are retryable)
      const statusMatch = lastError.message.match(/HTTP (\d+)/);
      const status = statusMatch ? parseInt(statusMatch[1]) : 0;
      if (status > 0 && opts.retryableStatuses && !opts.retryableStatuses.includes(status)) {
        throw lastError;
      }

      // Calculate delay with exponential backoff + jitter
      let delay = Math.min(opts.baseDelay * Math.pow(factor, attempt), opts.maxDelay);
      if (opts.jitter) {
        delay = delay * (0.5 + Math.random() * 0.5);
      }

      console.log(`  [Retry] Attempt ${attempt + 1}/${opts.maxRetries} failed: ${lastError.message}. Retrying in ${Math.round(delay)}ms...`);
      opts.onRetry?.(attempt + 1, lastError);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError || new Error("Retry failed");
}

// ==================== Path Traversal Protection ====================

export function isSafeSavePath(savePath: string): boolean {
  if (!savePath.startsWith("/")) return false;
  if (savePath.includes("..")) return false;
  if (!savePath.endsWith(".webp")) return false;
  const normalized = savePath.replace(/\/+/g, "/");
  const allowedPrefix = "/app/public/covers/";
  if (!normalized.startsWith(allowedPrefix)) return false;

  // Validate filename: only allow alphanumeric, hyphens, underscores, and dots
  const filename = normalized.split("/").pop() || "";
  if (!filename || !/^[a-zA-Z0-9_\-]+\.webp$/.test(filename)) {
    return false;
  }

  // Validate total path length
  if (normalized.length > 4096) return false;

  return true;
}

// ==================== Anti-Crawl Helpers ====================

/**
 * Builds HTTP headers with anti-crawl options and request fingerprint randomization.
 *
 * Supports all existing AntiCrawl options plus new fields:
 * - acceptLanguage: override Accept-Language (auto-randomized if not set)
 * - referer: override Referer (spoofed if not set)
 * - dnt: enable DNT header (randomly chosen if not set)
 * - humanBehavior: enables enhanced randomization
 *
 * @param antiCrawl  - Anti-crawl configuration options
 * @param customUA   - Override User-Agent string
 * @param targetUrl  - Target URL (used for Referer spoofing)
 * @param siteType   - Site type hint (e.g. 'novel' for Referer spoofing)
 */
export function buildFetchHeaders(
  antiCrawl?: AntiCrawl,
  customUA?: string,
  targetUrl?: string,
  siteType?: string
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": antiCrawl?.acceptLanguage || getRandomAcceptLanguage(),
    "Accept-Encoding": "gzip, deflate, br",
    Connection: "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Cache-Control": "max-age=0",
  };

  // User-Agent
  if (antiCrawl?.uaRotation || customUA) {
    headers["User-Agent"] = customUA || getRandomUA();
  } else {
    headers["User-Agent"] =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  }

  // Sec-Fetch-* headers (randomized)
  const secFetchHeaders = getRandomSecFetchHeaders("navigate");
  Object.assign(headers, secFetchHeaders);

  // Chrome Client Hints (only for Chrome UAs)
  const clientHints = getChromeClientHints(headers["User-Agent"]);
  if (clientHints) {
    headers["sec-ch-ua"] = clientHints["sec-ch-ua"];
    headers["sec-ch-ua-mobile"] = clientHints["sec-ch-ua-mobile"];
    headers["sec-ch-ua-platform"] = clientHints["sec-ch-ua-platform"];
  }

  // Referer: use explicit override or spoof one
  const referer = antiCrawl?.referer ?? getSpoofedReferer(targetUrl || "", siteType);
  if (referer) {
    headers["Referer"] = referer;
  } else if (targetUrl && !headers["Referer"]) {
    // Spoof Referer: use parent path as referer
    try {
      const parsedUrl = new URL(targetUrl);
      const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
      if (pathParts.length > 1) {
        pathParts.pop(); // remove last segment
        const refererPath = '/' + pathParts.join('/');
        headers['Referer'] = `${parsedUrl.origin}${refererPath}`;
      } else {
        headers['Referer'] = `${parsedUrl.origin}/`;
      }
    } catch { /* ignore */ }
  }

  // DNT (Do Not Track): use explicit override or random
  const dnt = antiCrawl?.dnt ?? (Math.random() < 0.5);
  if (dnt) {
    headers["DNT"] = "1";
  }

  // Cookies
  if (antiCrawl?.cookies && antiCrawl.cookies.length > 0) {
    const sanitizedCookies = antiCrawl.cookies
      .filter((c) => c.name && c.value)
      .map((c) => {
        // Strip control characters (CR, LF, tabs) to prevent header injection
        const safeName = c.name.replace(/[\r\n\t\x00-\x1f]/g, "");
        const safeValue = c.value.replace(/[\r\n\t\x00-\x1f]/g, "");
        return `${safeName}=${safeValue}`;
      })
      .filter((c) => c.includes("=")); // Ensure valid cookie format
    if (sanitizedCookies.length > 0) {
      headers["Cookie"] = sanitizedCookies.join("; ");
    }
  }

  return headers;
}

// ==================== JSON Helpers ====================

export function parseJsonField<T>(field: string | null, fallback: T): T {
  if (!field) return fallback;
  try {
    return JSON.parse(field) as T;
  } catch {
    return fallback;
  }
}

// ==================== Status Mapping ====================

export function mapNovelStatus(rawStatus: string): string {
  const lower = rawStatus.trim();
  if (lower.includes("完") || lower.includes("结局") || lower.includes("end") || lower === "completed") {
    return "completed";
  }
  if (lower.includes("断") || lower.includes("暂停") || lower.includes("hiatus")) {
    return "hiatus";
  }
  return "ongoing";
}

// ==================== Generate ID ====================

export function generateId(): string {
  return randomUUID();
}

// ==================== Chinese Numeral Parser ====================

const DIGIT_MAP: Record<string, number> = {
  '零': 0, '〇': 0, '一': 1, '二': 2, '三': 3, '四': 4,
  '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
  '兩': 2, '两': 2,
};

/**
 * Parse a Chinese numeral string to an integer.
 * Handles: 一(1), 十(10), 十一(11), 二十(20), 二十三(23),
 *          一百(100), 一百零三(103), 一百二十三(123),
 *          一千(1000), 一万(10000), etc.
 * Falls back to 0 for unparseable strings.
 */
export function parseChineseNumeral(str: string): number {
  if (!str || str.length === 0) return 0;

  // Simple single digit
  const single = DIGIT_MAP[str];
  if (single !== undefined) return single;

  // Pure Arabic number string (e.g. "123")
  if (/^[0-9]+$/.test(str)) return parseInt(str) || 0;

  // Parse Chinese numeral using a position-based approach
  let result = 0;
  let current = 0;  // Current accumulated value before a unit (十/百/千/万)
  let prevUnit = 0; // Track the last unit multiplier for proper accumulation

  for (const ch of str) {
    const digit = DIGIT_MAP[ch];
    if (digit !== undefined) {
      current = digit;
    } else if (ch === '十') {
      // 十 = 10. If nothing before it, means 10. Otherwise X*10.
      result += (current || 1) * 10;
      current = 0;
      prevUnit = 10;
    } else if (ch === '百') {
      result += (current || 1) * 100;
      current = 0;
      prevUnit = 100;
    } else if (ch === '千') {
      result += (current || 1) * 1000;
      current = 0;
      prevUnit = 1000;
    } else if (ch === '万') {
      // 万 is a major unit — multiply the accumulated result by 10000
      result = (result + current) * 10000;
      current = 0;
      prevUnit = 10000;
    } else {
      // Unknown char — skip
    }
  }

  result += current;
  return result || 0;
}

// ==================== Chapter Title Normalization ====================

/**
 * Normalize a chapter title for deduplication purposes.
 * Handles common variations:
 * - "第01章 标题" vs "第1章 标题" vs "第 1 章 标题"
 * - "第一章 标题" vs "第1章 标题"
 * - Extra whitespace, full-width/half-width punctuation
 * - Leading/trailing whitespace and punctuation
 *
 * Returns a normalized string suitable for Set-based dedup.
 */
export function normalizeChapterTitle(title: string): string {
  if (!title) return "";

  let normalized = title.trim();

  // Remove common non-content prefixes/suffixes
  normalized = normalized.replace(/^[\[【(（].*?[\]】)）]\s*/g, "");

  // Normalize full-width to half-width for common chars
  normalized = normalized
    .replace(/，/g, ",")
    .replace(/。/g, ".")
    .replace(/！/g, "!")
    .replace(/？/g, "?")
    .replace(/：/g, ":")
    .replace(/；/g, ";");

  // Normalize chapter numbering patterns:
  // "第01章" → "第1章", "第 1 章" → "第1章", "第一章" → "第1章"
  // Chinese numerals: 一二三...百千万
  normalized = normalized.replace(
    /^第\s*([零〇一二三四五六七八九十百千万0-9]+)\s*([章节回卷集篇部话])/,
    (_, numStr, unit) => {
      // Try to parse as Arabic digits first
      if (/^[0-9]+$/.test(numStr)) {
        return `第${String(parseInt(numStr))}${unit}`;
      }
      // Parse Chinese numerals properly
      const num = parseChineseNumeral(numStr);
      return `第${String(num)}${unit}`;
    }
  );

  // Collapse multiple spaces to single space
  normalized = normalized.replace(/\s+/g, " ");

  // Lowercase for case-insensitive comparison
  normalized = normalized.toLowerCase();

  return normalized;
}

/**
 * Compute a similarity-aware dedup key for a chapter title.
 * Strips all punctuation and whitespace to catch near-duplicates like
 * "第1章 标题A" vs "第1章标题A" (missing space).
 */
export function chapterDedupKey(title: string): string {
  const normalized = normalizeChapterTitle(title);
  // Remove ALL whitespace and common punctuation for a more aggressive key
  return normalized.replace(/[\s,\.!?;:：；，。！？、\-—_·~～…]+/g, "");
}

// ==================== Redirect Following ====================

/** Options for the shared redirect-following utility. */
export interface FollowRedirectsOptions {
  /** Maximum number of redirect hops to follow (default: 5). */
  maxRedirects?: number;
  /**
   * Called to make each HTTP request. Receives the URL to fetch.
   * The caller controls headers, timeout, etc. via this callback.
   */
  makeRequest: (url: string) => Promise<Response>;
  /** Optional callback fired after each redirect hop is resolved. */
  onRedirect?: (fromUrl: string, toUrl: string, hop: number) => void;
}

/**
 * Shared redirect-following utility with SSRF validation on each hop.
 * Used by CheerioEngine.fetch and handleDownloadCover to eliminate
 * duplicated manual redirect loops.
 */
export async function followRedirects(
  startUrl: string,
  options: FollowRedirectsOptions
): Promise<{ response: Response; finalUrl: string }> {
  const { maxRedirects = 5, onRedirect, makeRequest } = options;
  let currentUrl = startUrl;
  const visitedUrls = new Set<string>([startUrl]);
  let response: Response | null = null;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    response = await makeRequest(currentUrl);

    if (response.status >= 300 && response.status < 400 && hop < maxRedirects) {
      const location = response.headers.get("location");
      if (!location) break;

      let redirectUrl: string;
      try {
        redirectUrl = new URL(location, currentUrl).href;
      } catch {
        break; // Invalid URL, stop following
      }

      if (!isSafeUrl(redirectUrl)) {
        throw new Error(`Blocked: redirect target URL is not allowed (${redirectUrl})`);
      }

      if (visitedUrls.has(redirectUrl)) {
        throw new Error(`Redirect loop detected: ${redirectUrl}`);
      }
      visitedUrls.add(redirectUrl);

      onRedirect?.(currentUrl, redirectUrl, hop);
      currentUrl = redirectUrl;
    } else {
      break;
    }
  }

  return { response: response!, finalUrl: currentUrl };
}
