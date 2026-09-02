/**
 * High-level Scraping Functions
 * list / book / chapters / content - using pluggable engines
 */

import * as cheerio from "cheerio";
import { getCachedCheerio } from "./cheerio-cache";
import type {
  Selector, Pagination, AntiCrawl, EngineType,
  ScrapeListRequest, ScrapeBookRequest, ScrapeChaptersRequest, ScrapeContentRequest,
  ChapterLink,
} from "./types";
import { getEngine, selectEngine, fetchWithEngineFallback, fetchWithInfiniteScroll } from "./engines";
import { parseSelector, parseSelectorMulti, parseSelectorHtml, extractLinksFromList, extractMetadataFallback } from "./selectors";
import { cleanHtmlRaw, cleanHtmlPreserveParagraphs, cleanText } from "./cleaning";
import { convertIfTraditional } from "./t2s-converter";
import { extractJsContent, hasJsContentPatterns } from "./js-content-extractor";
import { resolveUrl, randomDelay, isSafeSavePath, getRandomUA, followRedirects, chapterDedupKey, buildFetchHeaders } from "./utils";
import { isSafeUrl } from "./ssrf";
import { detectCaptcha, CAPTCHA_TYPE_LABELS } from "./captcha-detector";
import type { CaptchaDetection } from "./captcha-detector";
import { rateLimiter } from "./rate-limiter";
import { referrerChain } from "./referrer-chain";
import { cookieJar } from "./cookie-jar";
import { requestFingerprintMgr, applyTimingJitter } from "./request-fingerprint";
import { antiCrawlAdvisor } from "./anti-crawl-advisor";
import { browserBehavior } from "./browser-behavior";
import { proxyManager, getProxyDispatcher } from "./proxy-manager";

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
  if (!pagination.selector) return "";
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
          return text.includes("下一页") || text.toLowerCase().includes("next") || text === ">";
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
  /** Task-level abort signal for cancellation. */
  signal?: AbortSignal;
  /** Called for each fetched page. Return false to stop paginating. */
  onPage: (html: string, url: string, pageIndex: number) => void | boolean | Promise<void | boolean>;
  /** Called when CAPTCHA is detected. Return true to skip this page. */
  onCaptcha?: (detection: CaptchaDetection, url: string) => boolean | Promise<boolean>;
  /** Enable engine fallback on fetch failure (default: true). */
  useEngineFallback?: boolean;
}

/**
 * Maximum pages for content-level pagination.
 * Content pages (novel chapter text split across pages) rarely exceed 10 pages.
 * This prevents runaway pagination if a site has a bug or selector mis-match.
 */
const MAX_CONTENT_PAGES = 20;

async function paginatedFetch(options: PaginatedFetchOptions): Promise<{ hasNextPage: boolean; effectiveEngine?: EngineType }> {
  const { startUrl, pagination, antiCrawl, engineType, logPrefix, onPage, isContentPagination, onCaptcha, signal, useEngineFallback } = options;
  const hardMax = isContentPagination ? MAX_CONTENT_PAGES : 100;
  const maxPages = Math.min(pagination?.maxPage ?? hardMax, hardMax);
  // Start with the primary engine; may switch to fallback engine after first success
  let currentEngineType = engineType;
  let engine = getEngine(engineType);
  const visitedPages = new Set<string>();
  let currentUrl = startUrl;
  let hasNextPage = false;
  let effectiveEngine: EngineType | undefined;
  const fallbackEnabled = useEngineFallback !== false && antiCrawl?.engineFallback !== false;

  for (let page = 0; page < maxPages; page++) {
    // Check task-level abort before each page
    if (signal?.aborted) {
      throw new Error('Request aborted during pagination');
    }

    console.log(`  [${logPrefix}] Page ${page + 1}/${maxPages}: ${currentUrl}`);

    if (visitedPages.has(currentUrl)) {
      console.log(`  [${logPrefix}] Detected page loop at ${currentUrl}, stopping.`);
      break;
    }
    visitedPages.add(currentUrl);

    let html = '';
    let statusCode = 0;
    try {
      // First page: try engine fallback if enabled and primary fails
      // Subsequent pages: use the engine that succeeded (currentEngineType)
      let result;
      if (fallbackEnabled && page === 0 && !effectiveEngine) {
        result = await fetchWithEngineFallback(currentUrl, { antiCrawl, signal }, currentEngineType);
        if (result.effectiveEngine && result.effectiveEngine !== currentEngineType) {
          console.log(`  [${logPrefix}] Engine switched: ${currentEngineType} → ${result.effectiveEngine}`);
          currentEngineType = result.effectiveEngine;
          engine = getEngine(currentEngineType);
        }
        effectiveEngine = result.effectiveEngine || currentEngineType;
      } else {
        result = await engine.fetch(currentUrl, { antiCrawl, signal });
      }
      html = result.html;
      statusCode = result.statusCode;
    } catch (err) {
      console.warn(`  [${logPrefix}] Page ${page + 1} fetch failed: ${err instanceof Error ? err.message : err}`);
      // Can't find next-page URL without HTML — stop pagination but return what was collected
      break;
    }

    // CAPTCHA detection
    if (onCaptcha) {
      const detection = detectCaptcha(html, currentUrl, statusCode);
      if (detection.detected && detection.confidence > 0.5) {
        console.warn(`[CAPTCHA] ${CAPTCHA_TYPE_LABELS[detection.type]} detected on ${currentUrl} (confidence: ${Math.round(detection.confidence * 100)}%)`);
        const shouldSkip = await onCaptcha(detection, currentUrl);
        if (shouldSkip) {
          console.log(`  [${logPrefix}] Skipping page due to CAPTCHA`);
          break;
        }
      }
    }

    const shouldContinue = await onPage(html, currentUrl, page);
    if (shouldContinue === false) {
      hasNextPage = false;
      break;
    }

    // Find next page URL
    if (pagination) {
      const $ = getCachedCheerio(html);
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

  return { hasNextPage, effectiveEngine: effectiveEngine || engineType };
}

// ==================== Scrape List ====================

export async function handleScrapeList(body: ScrapeListRequest) {
  const { url, selector, pagination, antiCrawl, engine: requestedEngine, signal } = body;
  let domain = '';
  try { domain = new URL(url).hostname; } catch { /* ignore */ }
  const engineType = selectEngine(requestedEngine, antiCrawl, domain);

  const allUrls: string[] = [];
  const seen = new Set<string>();

  // Handle infinite-scroll pagination separately (requires browser engine)
  if (pagination?.type === 'infinite-scroll') {
    console.log(`  [List/InfiniteScroll] Starting infinite scroll fetch: ${url}`);
    const scrollResult = await fetchWithInfiniteScroll(url, { antiCrawl, signal }, engineType, {
      loadMoreSelector: pagination.loadMoreSelector,
      contentContainerSelector: pagination.contentContainerSelector,
      maxScrollCycles: pagination.maxScrollCycles,
    });

    // CAPTCHA detection on infinite-scroll results
    const scrollCaptcha = detectCaptcha(scrollResult.html, url, scrollResult.statusCode);
    if (scrollCaptcha.detected && scrollCaptcha.confidence > 0.5) {
      console.warn(`[CAPTCHA] ${CAPTCHA_TYPE_LABELS[scrollCaptcha.type]} detected on infinite-scroll page ${url}`);
      return { urls: [], hasNextPage: false, engine: scrollResult.effectiveEngine };
    }

    const items = parseSelectorMulti(scrollResult.html, selector);
    for (const item of items) {
      const resolvedUrl = resolveUrl(url, item);
      // Filter out non-HTTP URLs (javascript:, mailto:, tel:, data:, empty, etc.)
      // extractLinksFromList does this filtering for chapters; list scraping must do the same.
      if (resolvedUrl && (resolvedUrl.startsWith('http://') || resolvedUrl.startsWith('https://')) && !seen.has(resolvedUrl)) {
        seen.add(resolvedUrl);
        allUrls.push(resolvedUrl);
      }
    }
    console.log(`  [List/InfiniteScroll] Completed ${scrollResult.cyclesCompleted} cycles, found ${allUrls.length} items`);
    return { urls: allUrls, hasNextPage: false, engine: scrollResult.effectiveEngine };
  }

  const { hasNextPage, effectiveEngine: listEffectiveEngine } = await paginatedFetch({
    startUrl: url,
    pagination,
    antiCrawl,
    engineType,
    logPrefix: "Pagination",
    signal,
    onCaptcha: (detection, pageUrl) => {
      console.warn(`[CAPTCHA] ${CAPTCHA_TYPE_LABELS[detection.type]} detected on list page ${pageUrl} (confidence: ${Math.round(detection.confidence * 100)}%), skipping page`);
      return true; // skip this page
    },
    onPage: (html, pageUrl, page) => {
      const items = parseSelectorMulti(html, selector);
      let newCount = 0;
      for (const item of items) {
        const resolvedUrl = resolveUrl(pageUrl, item);
        // Filter out non-HTTP URLs (javascript:, mailto:, tel:, data:, empty, etc.)
        if (resolvedUrl && (resolvedUrl.startsWith('http://') || resolvedUrl.startsWith('https://')) && !seen.has(resolvedUrl)) {
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

  return { urls: allUrls, hasNextPage, engine: listEffectiveEngine || engineType };
}

// ==================== Scrape Book Info ====================

export async function handleScrapeBook(body: ScrapeBookRequest) {
  const { url, selectors, antiCrawl, engine: requestedEngine, signal } = body;
  let domain = '';
  try { domain = new URL(url).hostname; } catch { /* ignore */ }
  const engineType = selectEngine(requestedEngine, antiCrawl, domain);
  const fallbackEnabled = antiCrawl?.engineFallback !== false;

  let html: string;
  let statusCode: number;
  let effectiveEngine = engineType;

  if (fallbackEnabled) {
    const result = await fetchWithEngineFallback(url, { antiCrawl, signal }, engineType);
    html = result.html;
    statusCode = result.statusCode;
    effectiveEngine = result.effectiveEngine || engineType;
  } else {
    const engine = getEngine(engineType);
    const result = await engine.fetch(url, { antiCrawl, signal });
    html = result.html;
    statusCode = result.statusCode;
  }

  // CAPTCHA detection for book info page
  const captchaDetection = detectCaptcha(html, url, statusCode);
  if (captchaDetection.detected && captchaDetection.confidence > 0.5) {
    console.warn(`[CAPTCHA] ${CAPTCHA_TYPE_LABELS[captchaDetection.type]} detected on book page ${url} (confidence: ${Math.round(captchaDetection.confidence * 100)}%)`);
    throw new Error(`CAPTCHA detected (${CAPTCHA_TYPE_LABELS[captchaDetection.type]}), skipping book info fetch`);
  }

  const title = parseSelector(html, selectors.title);
  const author = selectors.author ? parseSelector(html, selectors.author) : "佚名";
  const category = selectors.category ? parseSelector(html, selectors.category) : "";
  const keywords = selectors.keywords ? parseSelector(html, selectors.keywords) : "";
  const description = selectors.description ? parseSelector(html, selectors.description) : "";
  let coverUrl = selectors.cover ? parseSelector(html, selectors.cover) : "";
  if (coverUrl) coverUrl = resolveUrl(url, coverUrl);
  const status = selectors.status ? parseSelector(html, selectors.status) : "";

  // OG/JSON-LD metadata fallback for fields that returned empty
  const fallback = extractMetadataFallback(html);
  const finalTitle = title || fallback.title || '';
  const finalAuthor = author || fallback.author || '';
  const finalDescription = description || fallback.description || '';
  const finalKeywords = keywords || fallback.keywords || '';
  const finalCategory = category || fallback.category || '';
  const finalStatus = status || fallback.status || '';

  let finalCoverUrl = coverUrl;
  if (!finalCoverUrl && fallback.cover) {
    finalCoverUrl = resolveUrl(url, fallback.cover);
  }

  return { title: finalTitle, author: finalAuthor, category: finalCategory, keywords: finalKeywords, description: finalDescription, coverUrl: finalCoverUrl, status: finalStatus, engine: effectiveEngine };
}

// ==================== Scrape Chapter Directory ====================

export async function handleScrapeChapters(body: ScrapeChaptersRequest) {
  const { url, selectors, pagination, antiCrawl, enableShuffle, engine: requestedEngine, signal } = body;
  let domain = '';
  try { domain = new URL(url).hostname; } catch { /* ignore */ }
  const engineType = selectEngine(requestedEngine, antiCrawl, domain);

  const allChapters: ChapterLink[] = [];
  const seenUrls = new Set<string>();
  // Title-based dedup with normalization to catch variations like "第01章" vs "第1章"
  const seenTitleKeys = new Set<string>();
  let titleDupCount = 0;

  const { hasNextPage, effectiveEngine: chaptersEffectiveEngine } = await paginatedFetch({
    startUrl: url,
    pagination,
    antiCrawl,
    engineType,
    logPrefix: "Chapters",
    signal,
    onCaptcha: (detection, pageUrl) => {
      console.warn(`[CAPTCHA] ${CAPTCHA_TYPE_LABELS[detection.type]} detected on chapter page ${pageUrl} (confidence: ${Math.round(detection.confidence * 100)}%), skipping page`);
      return true; // skip this page
    },
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

  return { chapters: allChapters, hasNextPage, engine: chaptersEffectiveEngine || engineType, titleDupCount };
}

// ==================== Scrape Content ====================

export async function handleScrapeContent(body: ScrapeContentRequest) {
  const { url, selectors, pagination, antiCrawl, engine: requestedEngine, cleanConfig, signal } = body;
  let domain = '';
  try { domain = new URL(url).hostname; } catch { /* ignore */ }
  const engineType = selectEngine(requestedEngine, antiCrawl, domain);

  const contentParts: string[] = [];
  let title = "";
  let pageCount = 0;
  let captchaDetected: CaptchaDetection | null = null;
  let contentEffectiveEngine: EngineType | undefined;

  const { hasNextPage, effectiveEngine: contentPgEngine } = await paginatedFetch({
    startUrl: url,
    pagination,
    antiCrawl,
    engineType,
    logPrefix: "Content",
    isContentPagination: true,
    signal,
    onCaptcha: (detection) => {
      captchaDetected = detection;
      return true; // skip this page
    },
    onPage: (html, _pageUrl, page) => {
      pageCount++;
      // Extract title from first page only (title doesn't need paragraph preservation)
      if (page === 0 && selectors.title) {
        let processedHtml = html;
        if (cleanConfig) {
          processedHtml = cleanHtmlRaw(html, cleanConfig);
        }
        title = parseSelector(processedHtml, selectors.title);
      }

      // Extract content with paragraph preservation for CSS selectors
      let content = '';
      if (selectors.content.type === 'css' && cleanConfig) {
        // Paragraph-preserving path: get inner HTML, then clean with paragraph awareness
        const innerHtml = parseSelectorHtml(html, selectors.content);
        if (!innerHtml || !innerHtml.trim()) {
          // Fallback: clean HTML first, then extract with text-based selector
          const processedHtml = cleanHtmlRaw(html, cleanConfig);
          content = parseSelector(processedHtml, selectors.content);
        } else {
          content = cleanHtmlPreserveParagraphs(innerHtml, cleanConfig);
        }
      } else {
        // Fallback for non-CSS selectors or no cleanConfig: original path
        let processedHtml = html;
        if (cleanConfig) {
          processedHtml = cleanHtmlRaw(html, cleanConfig);
        }
        content = parseSelector(processedHtml, selectors.content);
      }

      if (content && content.length > 30) {
        contentParts.push(content);
      } else if (hasJsContentPatterns(html)) {
        // Normal extraction failed or very short — try JS content patterns
        // This handles novel sites that render chapter text via JavaScript
        const jsResult = extractJsContent(html);
        if (jsResult.found && jsResult.content.length > 30) {
          console.log(`  [Content] JS content extracted via ${jsResult.pattern} (${jsResult.content.length} chars)`);
          const cleaned = cleanConfig
            ? cleanText(jsResult.content, cleanConfig)
            : jsResult.content.trim();
          if (cleaned) contentParts.push(cleaned);
        } else {
          // JS extraction also failed — preserve original short content if any
          if (content) contentParts.push(content);
        }
      } else {
        // No JS patterns found — preserve original short content if any
        if (content) contentParts.push(content);
      }
    },
  });

  // Log pagination info for debugging
  if (pageCount > 1) {
    console.log(`  [Content] Merged ${pageCount} pages (${contentParts.reduce((sum, p) => sum + p.length, 0)} chars)`);
  }

  let fullContent = contentParts.join("\n\n");

  // Traditional → Simplified Chinese conversion (if configured)
  if (cleanConfig?.t2sConversion && fullContent) {
    const t2sResult = convertIfTraditional(fullContent);
    if (t2sResult.converted) {
      fullContent = t2sResult.text;
      console.log(`  [T2S] Traditional Chinese detected and converted to Simplified`);
    }
  }

  // Strip HTML tags before counting words for consistency with chapter creation API
  const textOnly = fullContent.replace(/<[^>]*>/g, '').replace(/\s+/g, '');
  return {
    title,
    content: fullContent,
    wordCount: textOnly.length,
    engine: contentPgEngine || engineType,
    pagesFetched: pageCount,
    captchaDetected: captchaDetected || undefined,
  };
}

// ==================== Download Cover ====================

export async function handleDownloadCover(url: string, savePath: string, signal?: AbortSignal): Promise<{
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

  // Extract domain for anti-crawl stack integration
  let domain = '';
  try { domain = new URL(url).hostname; } catch { /* ignore */ }

  console.log(`  [Cover] Downloading from ${url} to ${savePath}`);

  // 1. Rate limiting
  if (domain) {
    const rateCheck = rateLimiter.acquire(domain);
    if (!rateCheck.allowed && rateCheck.waitMs > 0) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, rateCheck.waitMs);
        const onAbort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
  }

  // 2. Browser behavior throttle check
  if (domain) {
    const throttleCheck = browserBehavior.shouldThrottle(domain);
    if (throttleCheck.throttled) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, throttleCheck.waitMs);
        const onAbort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    browserBehavior.recordRequest(domain);
  }

  // 3. Timing jitter
  await applyTimingJitter();

  // 4. Build headers using the shared anti-crawl header builder
  const headers = buildFetchHeaders(undefined, undefined, url, undefined);
  // Override Accept for image requests (buildFetchHeaders sets HTML Accept)
  headers["Accept"] = "image/webp,image/apng,image/*,*/*;q=0.8";

  // 5. Cookie jar integration (some sites require session cookies for images)
  if (domain) {
    const jarCookieHeader = cookieJar.getCookieHeader(domain, new URL(url).pathname);
    if (jarCookieHeader) {
      if (headers["Cookie"]) {
        headers["Cookie"] = `${jarCookieHeader}; ${headers["Cookie"]}`;
      } else {
        headers["Cookie"] = jarCookieHeader;
      }
    }
  }

  // 6. Request fingerprint tracking
  const fp = requestFingerprintMgr.create({
    domain: domain || 'unknown',
    engine: 'cover-fetch',
    userAgent: headers["User-Agent"] || '',
  });

  // 7. Optional proxy support
  const proxy = domain ? proxyManager.getProxy(domain) : null;
  const dispatcher = proxy ? getProxyDispatcher(proxy.url) : null;

  let success = false;
  let statusCode = 0;
  const coverStartTime = Date.now();

  try {
    // Use shared redirect-following utility with SSRF validation on each hop
    const { response, finalUrl } = await followRedirects(url, {
      maxRedirects: 5,
      onHopResponse: (resp, hopUrl) => {
        // Store Set-Cookie from redirect hops
        if (domain) {
          try {
            const hopDomain = new URL(hopUrl).hostname;
            const setCookieHeaders = resp.headers.getSetCookie?.() || [];
            if (setCookieHeaders.length > 0) {
              cookieJar.store(hopDomain, setCookieHeaders);
            }
          } catch { /* ignore */ }
        }
      },
      makeRequest: (fetchUrl) =>
        fetch(fetchUrl, {
          headers,
          signal: signal
            ? (signal.aborted ? signal : AbortSignal.any([signal, AbortSignal.timeout(30000)]))
            : AbortSignal.timeout(30000),
          redirect: "manual",
          // @ts-expect-error - Bun supports dispatcher option for proxy
          dispatcher: dispatcher || undefined,
        }),
    });

    statusCode = response.status;

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Failed to download cover: HTTP ${response.status}`);
    }

    // Check response size before reading into memory
    const contentLength = parseInt(response.headers.get("content-length") || "0", 10);
    const MAX_COVER_SIZE = 5 * 1024 * 1024; // 5MB (novel covers are typically < 500KB)
    if (contentLength > MAX_COVER_SIZE) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Cover image too large: Content-Length ${contentLength} bytes (max ${MAX_COVER_SIZE})`);
    }

    // Stream the body with a size limit to prevent OOM on chunked encoding
    if (!response.body) throw new Error('No response body');
    const chunks: Uint8Array[] = [];
    let totalSize = 0;
    for await (const chunk of response.body) {
      totalSize += chunk.length;
      if (totalSize > MAX_COVER_SIZE) {
        chunks.length = 0;
        throw new Error(`Cover image too large (streamed): exceeded ${MAX_COVER_SIZE} bytes`);
      }
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    // Use sharp to convert to WebP
    const sharpModule = await import("sharp");
    const webpBuffer = await sharpModule.default(buffer)
      .webp({ quality: 80 })
      .toBuffer();

    // Bun.write automatically creates parent directories if they don't exist
    await Bun.write(savePath, webpBuffer);

    console.log(`  [Cover] Saved to ${savePath} (${webpBuffer.length} bytes)`);

    // Record success across all anti-crawl systems
    success = true;
    if (domain) {
      rateLimiter.recordResult(domain, true, statusCode);
      referrerChain.recordVisit(finalUrl);
      antiCrawlAdvisor.recordSuccess(domain);
    }
    if (proxy) {
      proxyManager.recordSuccess(proxy.url, Date.now() - coverStartTime);
    }
    requestFingerprintMgr.complete(fp.requestId, true, statusCode);

    return {
      success: true,
      path: savePath,
      size: webpBuffer.length,
    };
  } catch (err) {
    // Record failure across all anti-crawl systems
    if (domain) {
      rateLimiter.recordResult(domain, false, statusCode || undefined);
      antiCrawlAdvisor.recordFailure(domain);
    }
    if (proxy) {
      proxyManager.recordFailure(proxy.url, err instanceof Error ? err.message : String(err));
    }
    requestFingerprintMgr.complete(fp.requestId, false, statusCode || undefined);
    throw err;
  }
}
