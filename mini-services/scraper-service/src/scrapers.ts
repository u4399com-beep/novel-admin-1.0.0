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
import { resolveUrl, randomDelay } from "./utils";
import { addToQueue, isUrlProcessed, markCompleted, markFailed } from "./queue";

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
  const maxPages = pagination?.maxPage || 1;
  const engine = getEngine(engineType);

  for (let page = 0; page < maxPages; page++) {
    console.log(`  [Pagination] Page ${page + 1}/${maxPages}: ${currentUrl}`);

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
      let nextUrl = "";

      if (pagination.type === "next") {
        nextUrl = $(pagination.selector).attr("href") || "";
      } else if (pagination.type === "page") {
        const nextPage = page + 2;
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

      if (nextUrl) {
        currentUrl = resolveUrl(currentUrl, nextUrl);
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
  const maxPages = pagination?.maxPage || 1;

  for (let page = 0; page < maxPages; page++) {
    console.log(`  [Chapters] Page ${page + 1}/${maxPages}: ${currentUrl}`);

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
      let nextUrl = "";

      if (pagination.type === "next") {
        nextUrl = $(pagination.selector).attr("href") || "";
      } else if (pagination.type === "page") {
        const nextPage = page + 2;
        const nextEl = $(`${pagination.selector}:contains("${nextPage}")`);
        if (nextEl.length > 0) {
          nextUrl = nextEl.attr("href") || "";
        } else {
          const nextTextEl = $(pagination.selector).filter((i, el) => {
            const text = $(el).text().trim();
            return text.includes("下一页") || text.includes("next") || text === ">";
          });
          nextUrl = nextTextEl.attr("href") || "";
        }
      }

      if (nextUrl) {
        currentUrl = resolveUrl(currentUrl, nextUrl);
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

  let fullContent = "";
  let title = "";
  let currentUrl = url;
  const maxPages = pagination?.maxPage || 1;

  for (let page = 0; page < maxPages; page++) {
    console.log(`  [Content] Page ${page + 1}/${maxPages}: ${currentUrl}`);

    const { html } = await engine.fetch(currentUrl, { antiCrawl });

    // Extract title from first page only
    if (page === 0 && selectors.title) {
      title = parseSelector(html, selectors.title);
    }

    const content = parseSelector(html, selectors.content);
    fullContent += (fullContent ? "\n\n" : "") + content;

    // Find next page for content
    if (pagination && page < maxPages - 1) {
      const $ = cheerio.load(html);
      let nextUrl = "";

      if (pagination.type === "next") {
        nextUrl = $(pagination.selector).attr("href") || "";
      } else if (pagination.type === "page") {
        const nextPage = page + 2;
        const nextEl = $(`${pagination.selector}:contains("${nextPage}")`);
        if (nextEl.length > 0) {
          nextUrl = nextEl.attr("href") || "";
        } else {
          const nextTextEl = $(pagination.selector).filter((i, el) => {
            const text = $(el).text().trim();
            return text.includes("下一页") || text.includes("next") || text === ">";
          });
          nextUrl = nextTextEl.attr("href") || "";
        }
      }

      if (nextUrl) {
        currentUrl = resolveUrl(currentUrl, nextUrl);
        if (antiCrawl?.delay) {
          await randomDelay(antiCrawl.delay[0], antiCrawl.delay[1]);
        }
      } else {
        break;
      }
    }
  }

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
  const { isSafeTargetUrl, isSafeSavePath, getRandomUA: getUA } = await import("./utils");

  if (!isSafeTargetUrl(url)) {
    throw new Error("Invalid or blocked target URL");
  }

  if (!isSafeSavePath(savePath)) {
    throw new Error("Invalid save path");
  }

  console.log(`  [Cover] Downloading from ${url} to ${savePath}`);

  const response = await fetch(url, {
    headers: {
      "User-Agent": getUA(),
      Referer: new URL(url).origin,
    },
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(`Failed to download cover: HTTP ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
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