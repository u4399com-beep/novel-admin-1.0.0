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
import { resolveUrl, randomDelay, isSafeSavePath, getRandomUA } from "./utils";
import { isSafeUrl } from "./ssrf";

// ==================== Pagination Helper ====================

/**
 * Find the next page URL from pagination config.
 * Extracted as a shared function to avoid triplication across handlePagination,
 * handleScrapeChapters, and handleScrapeContent.
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

// ==================== Pagination Handler ====================

async function handlePagination(
  startUrl: string,
  pagination: Pagination | undefined,
  antiCrawl: AntiCrawl | undefined,
  engineType: EngineType,
  extractFn: (html: string, url: string) => string[]
): Promise<{ results: string[]; hasNextPage: boolean }> {
  const allResults: string[] = [];
  const seen = new Set<string>();
  let currentUrl = startUrl;
  let hasNextPage = false;
  const maxPages = Math.min(pagination?.maxPage || 1, 100);
  const engine = getEngine(engineType);
  const visitedPages = new Set<string>();

  for (let page = 0; page < maxPages; page++) {
    console.log(`  [Pagination] Page ${page + 1}/${maxPages}: ${currentUrl}`);

    if (visitedPages.has(currentUrl)) {
      console.log(`  [Pagination] Detected page loop at ${currentUrl}, stopping.`);
      break;
    }
    visitedPages.add(currentUrl);

    const { html } = await engine.fetch(currentUrl, { antiCrawl });
    const results = extractFn(html, currentUrl);

    let newCount = 0;
    for (const r of results) {
      if (r && !seen.has(r)) {
        seen.add(r);
        allResults.push(r);
        newCount++;
      }
    }

    console.log(`  [Pagination] Found ${results.length} items, ${newCount} new`);

    if (newCount === 0 && page > 0) {
      console.log(`  [Pagination] No new items found, stopping`);
      break;
    }

    // Find next page URL
    if (pagination) {
      const $ = cheerio.load(html);
      const nextUrl = findNextPageUrl($, pagination, page, currentUrl);

      if (nextUrl) {
        currentUrl = nextUrl;
        hasNextPage = true;
        if (antiCrawl?.delay) {
          await randomDelay(antiCrawl.delay[0], antiCrawl.delay[1]);
        }
      } else {
        hasNextPage = false;
        console.log(`  [Pagination] No next page found`);
        break;
      }
    } else {
      break;
    }
  }

  return { results: allResults, hasNextPage };
}

// ==================== Scrape List ====================

export async function handleScrapeList(body: ScrapeListRequest) {
  const { url, selector, pagination, antiCrawl, engine: requestedEngine } = body;
  const engineType = selectEngine(requestedEngine, antiCrawl);

  const { results, hasNextPage } = await handlePagination(
    url,
    pagination,
    antiCrawl,
    engineType,
    (html, pageUrl) => {
      const items = parseSelectorMulti(html, selector);
      return items.map((item) => resolveUrl(pageUrl, item));
    }
  );

  return { urls: results, hasNextPage, engine: engineType };
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
  const engine = getEngine(engineType);

  const allChapters: ChapterLink[] = [];
  const seenUrls = new Set<string>();
  let currentUrl = url;
  let hasNextPage = false;
  const maxPages = Math.min(pagination?.maxPage || 1, 100);
  const visitedPages = new Set<string>();

  for (let page = 0; page < maxPages; page++) {
    console.log(`  [Chapters] Page ${page + 1}/${maxPages}: ${currentUrl}`);

    if (visitedPages.has(currentUrl)) {
      console.log(`  [Chapters] Detected page loop at ${currentUrl}, stopping.`);
      break;
    }
    visitedPages.add(currentUrl);

    const { html } = await engine.fetch(currentUrl, { antiCrawl });
    const links = extractLinksFromList(html, selectors.list, selectors.link, selectors.title, currentUrl);

    let newCount = 0;
    for (const link of links) {
      if (link.url && !seenUrls.has(link.url)) {
        seenUrls.add(link.url);
        allChapters.push({
          title: link.title || `第${allChapters.length + 1}章`,
          url: link.url,
          sortOrder: allChapters.length + 1,
        });
        newCount++;
      }
    }

    console.log(`  [Chapters] Found ${links.length} chapters, ${newCount} new`);

    // Find next page
    if (pagination) {
      const $ = cheerio.load(html);
      const nextUrl = findNextPageUrl($, pagination, page, currentUrl);

      if (nextUrl) {
        currentUrl = nextUrl;
        hasNextPage = true;
        if (antiCrawl?.delay) {
          await randomDelay(antiCrawl.delay[0], antiCrawl.delay[1]);
        }
      } else {
        hasNextPage = false;
        break;
      }
    } else {
      break;
    }
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

  return { chapters: allChapters, hasNextPage, engine: engineType };
}

// ==================== Scrape Content ====================

export async function handleScrapeContent(body: ScrapeContentRequest) {
  const { url, selectors, pagination, antiCrawl, engine: requestedEngine } = body;
  const engineType = selectEngine(requestedEngine, antiCrawl);
  const engine = getEngine(engineType);

  const contentParts: string[] = [];
  let title = "";
  let currentUrl = url;
  const maxPages = Math.min(pagination?.maxPage || 1, 100);
  const visitedPages = new Set<string>();

  for (let page = 0; page < maxPages; page++) {
    console.log(`  [Content] Page ${page + 1}/${maxPages}: ${currentUrl}`);

    if (visitedPages.has(currentUrl)) {
      console.log(`  [Content] Detected page loop at ${currentUrl}, stopping.`);
      break;
    }
    visitedPages.add(currentUrl);

    const { html } = await engine.fetch(currentUrl, { antiCrawl });

    // Extract title from first page only
    if (page === 0 && selectors.title) {
      title = parseSelector(html, selectors.title);
    }

    const content = parseSelector(html, selectors.content);
    if (content) contentParts.push(content);

    // Find next page for content
    if (pagination && page < maxPages - 1) {
      const $ = cheerio.load(html);
      const nextUrl = findNextPageUrl($, pagination, page, currentUrl);

      if (nextUrl) {
        currentUrl = nextUrl;
        if (antiCrawl?.delay) {
          await randomDelay(antiCrawl.delay[0], antiCrawl.delay[1]);
        }
      } else {
        break;
      }
    }
  }

  const fullContent = contentParts.join("\n\n");
  return {
    title,
    content: fullContent,
    wordCount: fullContent.length,
    engine: engineType,
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

  // Manual redirect following with SSRF validation on each hop
  let currentUrl = url;
  let response: Response | null = null;
  const MAX_REDIRECTS = 5;

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    response = await fetch(currentUrl, {
      headers: {
        "User-Agent": getRandomUA(),
        Referer: new URL(currentUrl).origin,
      },
      signal: AbortSignal.timeout(30000),
      redirect: "manual",
    });

    if (response.status >= 300 && response.status < 400 && i < MAX_REDIRECTS) {
      const location = response.headers.get("location");
      if (!location) break;
      try {
        const redirectUrl = new URL(location, currentUrl).href;
        if (!isSafeUrl(redirectUrl)) {
          throw new Error(`Blocked: redirect to internal/blocked URL (${redirectUrl})`);
        }
        currentUrl = redirectUrl;
        continue;
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Blocked:")) throw err;
        break;
      }
    }
    break;
  }

  if (!response || !response.ok) {
    throw new Error(`Failed to download cover: HTTP ${response?.status || 'no response'}`);
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