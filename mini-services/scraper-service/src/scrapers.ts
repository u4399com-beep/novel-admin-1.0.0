/**
 * High-level Scraping Functions
 * list / book / chapters / content - using pluggable engines
 */

import * as cheerio from "cheerio";
import type {
  Selector, Pagination, AntiCrawl, EngineType,
  ScrapeListRequest, ScrapeBookRequest, ScrapeChaptersRequest, ScrapeContentRequest,
  ChapterLink,
} from "./types";
import { getEngine, selectEngine } from "./engines";
import { parseSelector, parseSelectorMulti, extractLinksFromList } from "./selectors";
import { cleanHtmlRaw } from "./cleaning";
import { resolveUrl, randomDelay, isSafeSavePath, getRandomUA, followRedirects, chapterDedupKey } from "./utils";
import { isSafeUrl } from "./ssrf";

// ==================== Pagination Helpers ====================

/**
 * Find the next page URL from pagination config.
 * Shared across all paginated scraping operations.
 */
function findNextPageUrl(
  $: cheerio.CheerioAPI,
  pagination: Pagination,
  pageNum: number,
  currentPageUrl: string
): string {
  let nextUrl = "";
  if (pagination.type === "next") {
    nextUrl = $(pagination.selector).attr("href") || "";
  } else if (pagination.type === "page") {
    const nextPage = pageNum + 2;
    const nextEl = $(`${pagination.selector}:contains("${nextPage}")`);
    if (nextEl.length > 0) {
      nextUrl = nextEl.attr("href") || "";
    } else {
      const nextTextEl = $(pagination.selector).filter(
        (i, el) => {
          const text = $(el).text().trim();
          return text.includes("下一页") || text.includes("next") || text === ">";
        }
      );
      nextUrl = nextTextEl.attr("href") || "";
    }
  }
  return nextUrl ? resolveUrl(currentPageUrl, nextUrl) : "";
}

// ==================== Shared Paginated Fetch Loop ====================

/**
 * Shared pagination loop that eliminates the triplicated page-fetching
 * logic in handleScrapeList, handleScrapeChapters, and handleScrapeContent.
 *
 * Handles: visited-page loop detection, max page limit, next-page URL
 * resolution, and anti-crawl delay. The caller provides an `onPage`
 * callback for per-page data extraction; returning `false` stops early.
 */
interface PaginatedFetchOptions {
  startUrl: string;
  pagination: Pagination | undefined;
  antiCrawl: AntiCrawl | undefined;
  engineType: EngineType;
  logPrefix: string;
  /** Maximum pages for content pagination (lower than list/chapter pagination). */
  isContentPagination?: boolean;
  /** Called for each fetched page. Return false to stop paginating. */
  onPage: (html: string, url: string, pageIndex: number) => void | boolean | Promise<void | boolean>;
}

/**
 * Maximum pages for content-level pagination.
 * Content pages (novel chapter text split across pages) rarely exceed 10 pages.
 * This prevents runaway pagination if a site has a bug or selector mis-match.
 */
const MAX_CONTENT_PAGES = 20;

async function paginatedFetch(options: PaginatedFetchOptions): Promise<{ hasNextPage: boolean }> {
  const { startUrl, pagination, antiCrawl, engineType, logPrefix, onPage, isContentPagination } = options;
  const hardMax = isContentPagination ? MAX_CONTENT_PAGES : 100;
  const maxPages = Math.min(pagination?.maxPage || 1, hardMax);
  const engine = getEngine(engineType);
  const visitedPages = new Set<string>();
  let currentUrl = startUrl;
  let hasNextPage = false;

  for (let page = 0; page < maxPages; page++) {
    console.log(`  [${logPrefix}] Page ${page + 1}/${maxPages}: ${currentUrl}`);

    if (visitedPages.has(currentUrl)) {
      console.log(`  [${logPrefix}] Detected page loop at ${currentUrl}, stopping.`);
      break;
    }
    visitedPages.add(currentUrl);

    const { html } = await engine.fetch(currentUrl, { antiCrawl });
    const shouldContinue = await onPage(html, currentUrl, page);
    if (shouldContinue === false) break;

    // Find next page URL
    if (pagination) {
      const $ = cheerio.load(html);
      const nextUrl = findNextPageUrl($, pagination, page, currentUrl);

      if (nextUrl) {
        currentUrl = nextUrl;
        hasNextPage = true;
        // Only delay if there will be another page to fetch
        if (antiCrawl?.delay && page < maxPages - 1) {
          await randomDelay(antiCrawl.delay[0], antiCrawl.delay[1]);
        }
      } else {
        hasNextPage = false;
        console.log(`  [${logPrefix}] No next page found`);
        break;
      }
    } else {
      break;
    }
  }

  return { hasNextPage };
}

// ==================== Scrape List ====================

export async function handleScrapeList(body: ScrapeListRequest) {
  const { url, selector, pagination, antiCrawl, engine: requestedEngine } = body;
  const engineType = selectEngine(requestedEngine, antiCrawl);

  const allUrls: string[] = [];
  const seen = new Set<string>();

  const { hasNextPage } = await paginatedFetch({
    startUrl: url,
    pagination,
    antiCrawl,
    engineType,
    logPrefix: "Pagination",
    onPage: (html, pageUrl, page) => {
      const items = parseSelectorMulti(html, selector);
      let newCount = 0;
      for (const item of items) {
        const resolvedUrl = resolveUrl(pageUrl, item);
        if (resolvedUrl && !seen.has(resolvedUrl)) {
          seen.add(resolvedUrl);
          allUrls.push(resolvedUrl);
          newCount++;
        }
      }
      console.log(`  [Pagination] Found ${items.length} items, ${newCount} new`);
      if (newCount === 0 && page > 0) {
        console.log(`  [Pagination] No new items found, stopping`);
        return false;
      }
    },
  });

  return { urls: allUrls, hasNextPage, engine: engineType };
}

// ==================== Scrape Book Info ====================

export async function handleScrapeBook(body: ScrapeBookRequest) {
  const { url, selectors, antiCrawl, engine: requestedEngine } = body;
  const engineType = selectEngine(requestedEngine, antiCrawl);
  const engine = getEngine(engineType);

  const { html } = await engine.fetch(url, { antiCrawl });

  const title = parseSelector(html, selectors.title);
  const author = selectors.author ? parseSelector(html, selectors.author) : "佚名";
  const category = selectors.category ? parseSelector(html, selectors.category) : "";
  const keywords = selectors.keywords ? parseSelector(html, selectors.keywords) : "";
  const description = selectors.description ? parseSelector(html, selectors.description) : "";
  let coverUrl = selectors.cover ? parseSelector(html, selectors.cover) : "";
  const status = selectors.status ? parseSelector(html, selectors.status) : "";

  if (coverUrl) {
    coverUrl = resolveUrl(url, coverUrl);
  }

  return { title, author, category, keywords, description, coverUrl, status, engine: engineType };
}

// ==================== Scrape Chapter Directory ====================

export async function handleScrapeChapters(body: ScrapeChaptersRequest) {
  const { url, selectors, pagination, antiCrawl, enableShuffle, engine: requestedEngine } = body;
  const engineType = selectEngine(requestedEngine, antiCrawl);

  const allChapters: ChapterLink[] = [];
  const seenUrls = new Set<string>();
  // Title-based dedup with normalization to catch variations like "第01章" vs "第1章"
  const seenTitleKeys = new Set<string>();
  let titleDupCount = 0;

  const { hasNextPage } = await paginatedFetch({
    startUrl: url,
    pagination,
    antiCrawl,
    engineType,
    logPrefix: "Chapters",
    onPage: (html, currentUrl) => {
      const links = extractLinksFromList(html, selectors.list, selectors.link, selectors.title, currentUrl);
      let newCount = 0;
      for (const link of links) {
        if (!link.url) continue;

        // URL-based dedup (primary)
        if (seenUrls.has(link.url)) continue;

        // Title-based dedup with normalization (catches same chapter with different URLs
        // or numbered variations like 第01章 vs 第1章)
        const titleKey = chapterDedupKey(link.title);
        if (titleKey && seenTitleKeys.has(titleKey)) {
          titleDupCount++;
          continue;
        }

        seenUrls.add(link.url);
        if (titleKey) seenTitleKeys.add(titleKey);

        allChapters.push({
          title: link.title || `第${allChapters.length + 1}章`,
          url: link.url,
          sortOrder: allChapters.length + 1,
        });
        newCount++;
      }
      console.log(`  [Chapters] Found ${links.length} chapters, ${newCount} new`);
    },
  });

  if (titleDupCount > 0) {
    console.log(`  [Chapters] Title dedup: removed ${titleDupCount} duplicate chapter titles`);
  }

  // Shuffle if enabled
  if (enableShuffle) {
    for (let i = allChapters.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [allChapters[i], allChapters[j]] = [allChapters[j], allChapters[i]];
    }
    allChapters.forEach((ch, idx) => {
      ch.sortOrder = idx + 1;
    });
  }

  return { chapters: allChapters, hasNextPage, engine: engineType, titleDedupCount };
}

// ==================== Scrape Content ====================

export async function handleScrapeContent(body: ScrapeContentRequest) {
  const { url, selectors, pagination, antiCrawl, engine: requestedEngine, cleanConfig } = body;
  const engineType = selectEngine(requestedEngine, antiCrawl);

  const contentParts: string[] = [];
  let title = "";
  let pageCount = 0;

  await paginatedFetch({
    startUrl: url,
    pagination,
    antiCrawl,
    engineType,
    logPrefix: "Content",
    isContentPagination: true,
    onPage: (html, _pageUrl, page) => {
      pageCount++;
      // Apply HTML-level cleaning first (removes ad elements via CSS selectors)
      let processedHtml = html;
      if (cleanConfig) {
        processedHtml = cleanHtmlRaw(html, cleanConfig);
      }
      // Extract title from first page only
      if (page === 0 && selectors.title) {
        title = parseSelector(processedHtml, selectors.title);
      }
      const content = parseSelector(processedHtml, selectors.content);
      if (content) contentParts.push(content);
    },
  });

  // Log pagination info for debugging
  if (pageCount > 1) {
    console.log(`  [Content] Merged ${pageCount} pages (${contentParts.reduce((sum, p) => sum + p.length, 0)} chars)`);
  }

  const fullContent = contentParts.join("\n\n");
  return {
    title,
    content: fullContent,
    wordCount: fullContent.length,
    engine: engineType,
    pagesFetched: pageCount,
  };
}

// ==================== Download Cover ====================

export async function handleDownloadCover(url: string, savePath: string): Promise<{
  success: boolean;
  path: string;
  size: number;
}> {
  if (!isSafeUrl(url)) {
    throw new Error("Invalid or blocked target URL");
  }

  if (!isSafeSavePath(savePath)) {
    throw new Error("Invalid save path");
  }

  console.log(`  [Cover] Downloading from ${url} to ${savePath}`);

  // Use shared redirect-following utility with SSRF validation on each hop
  const { response } = await followRedirects(url, {
    maxRedirects: 5,
    makeRequest: (fetchUrl) =>
      fetch(fetchUrl, {
        headers: {
          "User-Agent": getRandomUA(),
          Referer: new URL(fetchUrl).origin,
        },
        signal: AbortSignal.timeout(30000),
        redirect: "manual",
      }),
  });

  if (!response.ok) {
    throw new Error(`Failed to download cover: HTTP ${response.status}`);
  }

  // Check response size before reading into memory
  const contentLength = parseInt(response.headers.get("content-length") || "0", 10);
  const MAX_COVER_SIZE = 20 * 1024 * 1024; // 20MB
  if (contentLength > MAX_COVER_SIZE) {
    throw new Error(`Cover image too large: Content-Length ${contentLength} bytes (max ${MAX_COVER_SIZE})`);
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_COVER_SIZE) {
    throw new Error(`Cover image too large: ${arrayBuffer.byteLength} bytes (max ${MAX_COVER_SIZE})`);
  }
  const buffer = Buffer.from(arrayBuffer);

  // Use sharp to convert to WebP
  const sharpModule = await import("sharp");
  const webpBuffer = await sharpModule.default(buffer)
    .webp({ quality: 80 })
    .toBuffer();

  // Bun.write automatically creates parent directories if they don't exist
  await Bun.write(savePath, webpBuffer);

  console.log(`  [Cover] Saved to ${savePath} (${webpBuffer.length} bytes)`);

  return {
    success: true,
    path: savePath,
    size: webpBuffer.length,
  };
}
