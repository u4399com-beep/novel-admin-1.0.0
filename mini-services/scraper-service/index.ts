/**
 * Scraper Service - Novel Management System
 * Port: 3099
 *
 * A standalone Bun mini-service handling all web scraping operations
 * for the Novel Management System.
 */

import * as cheerio from "cheerio";

// ==================== Types ====================

interface Selector {
  type: "css" | "xpath" | "regex";
  value: string;
}

interface Pagination {
  type: "next" | "page";
  selector: string;
  maxPage?: number;
}

interface AntiCrawl {
  useJsRender?: boolean;
  uaRotation?: boolean;
  cookies?: Array<{ name: string; value: string; domain?: string }>;
  delay?: [number, number]; // [minMs, maxMs]
}

interface ScrapeListRequest {
  url: string;
  selector: Selector;
  pagination?: Pagination;
  antiCrawl?: AntiCrawl;
}

interface ScrapeBookRequest {
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
}

interface ScrapeChaptersRequest {
  url: string;
  selectors: {
    list: Selector;
    title: Selector;
    link: Selector;
  };
  pagination?: Pagination;
  antiCrawl?: AntiCrawl;
  enableShuffle?: boolean;
}

interface ScrapeContentRequest {
  url: string;
  selectors: {
    title?: Selector;
    content: Selector;
  };
  pagination?: Pagination;
  antiCrawl?: AntiCrawl;
}

interface CleanRequest {
  html: string;
  config: {
    removeAds?: boolean;
    cleanHtml?: boolean;
    removePatterns?: string[];
    adPatterns?: string[];
  };
}

interface DownloadCoverRequest {
  url: string;
  savePath: string;
}

interface ExecuteTaskRequest {
  taskId: string;
}

// ==================== UA Rotation ====================

const USER_AGENTS: string[] = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:126.0) Gecko/20100101 Firefox/126.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 OPR/110.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 OPR/109.0.0.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
  "Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
];

function getRandomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ==================== Utility Functions ====================

function randomDelay(min: number, max: number): Promise<void> {
  const ms = min + Math.random() * (max - min);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveUrl(base: string, relative: string): string {
  try {
    return new URL(relative, base).href;
  } catch {
    return relative;
  }
}

// ==================== HTTP Fetch with Anti-Crawl ====================

async function fetchPage(
  url: string,
  antiCrawl?: AntiCrawl
): Promise<{ html: string; finalUrl: string }> {
  const headers: Record<string, string> = {
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    Connection: "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Cache-Control": "max-age=0",
  };

  if (antiCrawl?.uaRotation) {
    headers["User-Agent"] = getRandomUA();
  } else {
    headers["User-Agent"] =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
  }

  if (antiCrawl?.cookies && antiCrawl.cookies.length > 0) {
    headers["Cookie"] = antiCrawl.cookies
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }

  if (antiCrawl?.useJsRender) {
    // For basic JS rendering support, add proper headers
    // Full JS rendering would require Playwright integration
    headers["Sec-Fetch-Dest"] = "document";
    headers["Sec-Fetch-Mode"] = "navigate";
  }

  const response = await fetch(url, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText} for ${url}`);
  }

  const html = await response.text();
  const finalUrl = response.url || url;

  return { html, finalUrl };
}

// ==================== Selector Parsing ====================

/**
 * Simple XPath to CSS selector converter for common patterns.
 * Handles: //tag, //tag[@attr], //tag[@attr='val'], /html/body, //text(), //*
 */
function xpathToCss(xpath: string): string {
  let css = xpath;

  // Remove text() selections - we'll handle text extraction separately
  const hasTextSelector = css.includes("text()");

  // /html/body/... → just remove the leading slashes and convert
  css = css.replace(/^\/+/, "");

  // //div → div
  css = css.replace(/^\/+/, "");

  // //tag[@attr='value'] → tag[attr='value']
  css = css.replace(
    /\/(\w+)\[@(\w+)=['"]([^'"]*)['"]\]/g,
    (match, tag, attr, val) => `${tag}[${attr}="${val}"]`
  );

  // //tag[@attr] → tag[attr]
  css = css.replace(
    /\/(\w+)\[@(\w+)\]/g,
    (match, tag, attr) => `${tag}[${attr}]`
  );

  // //tag → tag
  css = css.replace(/\/\//g, " ");

  // // → space
  css = css.replace(/\//g, " ");

  // Remove //*
  css = css.replace(/\s*\*\s*/g, " ");

  // Clean up multiple spaces
  css = css.replace(/\s+/g, " ").trim();

  return { css, hasTextSelector };
}

function parseSelector(html: string, selector: Selector): string {
  if (selector.type === "regex") {
    const regex = new RegExp(selector.value, "gi");
    const match = html.match(regex);
    if (match && match.length > 0) {
      return match[0];
    }
    return "";
  }

  if (selector.type === "xpath") {
    const { css, hasTextSelector } = xpathToCss(selector.value);
    const $ = cheerio.load(html);

    if (hasTextSelector) {
      // For XPath text() selections, get the text content of the parent
      const parentXpath = selector.value.replace(/\/text\(\)/g, "");
      const { css: parentCss } = xpathToCss(parentXpath);
      if (parentCss) {
        return $(parentCss).text().trim();
      }
      return "";
    }

    const el = $(css);
    if (el.length === 0) return "";

    // For href/src attributes, extract the attribute value
    const attrMatch = selector.value.match(/@(\w+)(?:=['"]([^'"]*)['"])?$/);
    if (attrMatch && !el.attr(attrMatch[1])) {
      // If looking for a specific attribute value, try getting all matching elements
      return el.attr("href") || el.attr("src") || el.text().trim();
    }

    return el.attr("href") || el.attr("src") || el.text().trim();
  }

  // CSS selector (default)
  const $ = cheerio.load(html);
  const el = $(selector.value);
  if (el.length === 0) return "";

  // Check if the selector targets an attribute
  if (selector.value.includes("[href]")) {
    return el.attr("href") || "";
  }
  if (selector.value.includes("[src]")) {
    return el.attr("src") || "";
  }
  if (selector.value.endsWith("href")) {
    return el.attr("href") || "";
  }
  if (selector.value.endsWith("src")) {
    return el.attr("src") || "";
  }

  return el.text().trim();
}

function parseSelectorMulti(html: string, selector: Selector): string[] {
  if (selector.type === "regex") {
    const regex = new RegExp(selector.value, "gi");
    return html.match(regex) || [];
  }

  if (selector.type === "xpath") {
    const { css, hasTextSelector } = xpathToCss(selector.value);
    const $ = cheerio.load(html);

    if (hasTextSelector) {
      const parentXpath = selector.value.replace(/\/text\(\)/g, "");
      const { css: parentCss } = xpathToCss(parentXpath);
      if (parentCss) {
        return $(parentCss)
          .map((_, el) => $(el).text().trim())
          .get()
          .filter(Boolean);
      }
      return [];
    }

    const elements = $(css);
    const results: string[] = [];

    elements.each((_, el) => {
      const $el = $(el);
      const href = $el.attr("href");
      const src = $el.attr("src");
      if (href) {
        results.push(href);
      } else if (src) {
        results.push(src);
      } else {
        const text = $el.text().trim();
        if (text) results.push(text);
      }
    });

    return results;
  }

  // CSS selector
  const $ = cheerio.load(html);
  const elements = $(selector.value);
  const results: string[] = [];

  elements.each((_, el) => {
    const $el = $(el);
    const href = $el.attr("href");
    const src = $el.attr("src");
    if (href) {
      results.push(href);
    } else if (src) {
      results.push(src);
    } else {
      const text = $el.text().trim();
      if (text) results.push(text);
    }
  });

  return results;
}

/**
 * Extract links from a list selector: for each item in the list, extract the link.
 * The link selector is relative to each list item.
 */
function extractLinksFromList(
  html: string,
  listSelector: Selector,
  linkSelector: Selector,
  titleSelector: Selector,
  baseUrl: string
): Array<{ title: string; url: string }> {
  const $ = cheerio.load(html);
  const results: Array<{ title: string; url: string }> = [];

  // Get the list container elements
  let listElements: cheerio.Cheerio<cheerio.Element>;

  if (listSelector.type === "xpath") {
    const { css } = xpathToCss(listSelector.value);
    listElements = $(css);
  } else if (listSelector.type === "regex") {
    // Regex for list is unusual; treat the whole document as the list
    listElements = $("body");
  } else {
    listElements = $(listSelector.value);
  }

  listElements.each((_, listEl) => {
    const $listEl = $(listEl);
    let linkValue = "";
    let titleValue = "";

    // Extract link
    if (linkSelector.type === "xpath") {
      const { css } = xpathToCss(linkSelector.value);
      const linkEl = $listEl.find(css);
      if (linkEl.length === 0) {
        // Try finding from document level
        const docLinkEl = $(css);
        linkValue = docLinkEl.attr("href") || "";
      } else {
        linkValue = linkEl.attr("href") || "";
      }
    } else if (linkSelector.type === "regex") {
      const regex = new RegExp(linkSelector.value, "i");
      const match = $listEl.html()?.match(regex);
      linkValue = match?.[1] || match?.[0] || "";
    } else {
      const linkEl = $listEl.find(linkSelector.value);
      if (linkEl.length === 0) {
        const docLinkEl = $(linkSelector.value);
        linkValue = docLinkEl.attr("href") || "";
      } else {
        linkValue = linkEl.attr("href") || "";
      }
    }

    // Extract title
    if (titleSelector.type === "xpath") {
      const { css } = xpathToCss(titleSelector.value);
      const titleEl = $listEl.find(css);
      if (titleEl.length === 0) {
        const docTitleEl = $(css);
        titleValue = docTitleEl.text().trim();
      } else {
        titleValue = titleEl.text().trim();
      }
    } else if (titleSelector.type === "regex") {
      const regex = new RegExp(titleSelector.value, "i");
      const match = $listEl.html()?.match(regex);
      titleValue = match?.[1] || match?.[0] || "";
    } else {
      const titleEl = $listEl.find(titleSelector.value);
      if (titleEl.length === 0) {
        const docTitleEl = $(titleSelector.value);
        titleValue = docTitleEl.text().trim();
      } else {
        titleValue = titleEl.text().trim();
      }
    }

    if (linkValue) {
      results.push({
        title: titleValue,
        url: resolveUrl(baseUrl, linkValue),
      });
    }
  });

  return results;
}

// ==================== Content Cleaning ====================

const DEFAULT_AD_PATTERNS = [
  "推广",
  "广告",
  "下载APP",
  "下载app",
  "关注公众号",
  "关注我们",
  "扫码关注",
  "微信扫码",
  "微信公众号",
  "加入书签",
  "添加书签",
  "收藏本站",
  "本章未完",
  "请记住",
  "手机版阅读",
  "最新章节",
  "百度搜索",
  "本站网址",
  "请牢记",
  "天才一秒记住",
  "记住本站",
  "阅读请到",
  "如果您喜欢",
];

const AD_CSS_SELECTORS = [
  '[class*="ad"]',
  '[class*="Ad"]',
  '[class*="AD"]',
  '[class*="advert"]',
  '[class*="sponsor"]',
  '[class*="promo"]',
  '[class*="banner"]',
  '[class*="popup"]',
  '[class*="modal"]',
  '[class*="recommend"]',
  '[class*="tuijian"]',
  '[class*="guanggao"]',
  '[id*="ad"]',
  '[id*="Ad"]',
  '[id*="AD"]',
  '[id*="advert"]',
  '[id*="sponsor"]',
  '[id*="promo"]',
  '[id*="banner"]',
  '[id*="popup"]',
  '[id*="guanggao"]',
];

function cleanHtml(html: string, config: CleanRequest["config"]): string {
  const $ = cheerio.load(html);

  // Remove script, style, iframe, noscript tags
  $("script, style, iframe, noscript, object, embed, applet").remove();

  // Remove ad elements if removeAds is true
  if (config.removeAds !== false) {
    const allAdSelectors = [...AD_CSS_SELECTORS];
    if (config.adPatterns && config.adPatterns.length > 0) {
      allAdSelectors.push(...config.adPatterns.map((p) => `[class*="${p}"], [id*="${p}"]`));
    }
    $(allAdSelectors.join(", ")).remove();
  }

  // Remove elements matching custom patterns
  if (config.removePatterns && config.removePatterns.length > 0) {
    for (const pattern of config.removePatterns) {
      $(pattern).remove();
    }
  }

  // Get text content
  let text = $.text();

  // Remove ad text patterns
  const allAdPatterns = [...DEFAULT_AD_PATTERNS];
  if (config.adPatterns && config.adPatterns.length > 0) {
    allAdPatterns.push(...config.adPatterns);
  }

  for (const pattern of allAdPatterns) {
    // Remove lines containing ad patterns
    const lines = text.split("\n");
    text = lines
      .filter((line) => !line.includes(pattern))
      .join("\n");
  }

  // Remove custom patterns from text
  if (config.removePatterns && config.removePatterns.length > 0) {
    for (const pattern of config.removePatterns) {
      text = text.replace(new RegExp(pattern, "gi"), "");
    }
  }

  // Normalize whitespace
  text = text
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text;
}

// ==================== Pagination Handler ====================

async function handlePagination(
  startUrl: string,
  selector: Selector,
  pagination: Pagination | undefined,
  antiCrawl?: AntiCrawl,
  extractFn: (html: string, url: string) => string[]
): Promise<{ results: string[]; hasNextPage: boolean }> {
  const allResults: string[] = [];
  const seen = new Set<string>();
  let currentUrl = startUrl;
  let hasNextPage = false;
  const maxPages = pagination?.maxPage || 1;

  for (let page = 0; page < maxPages; page++) {
    console.log(`  [Pagination] Page ${page + 1}/${maxPages}: ${currentUrl}`);

    const { html } = await fetchPage(currentUrl, antiCrawl);
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
        const nextEl = $(pagination.selector);
        nextUrl = nextEl.attr("href") || "";
      } else if (pagination.type === "page") {
        // Find the page link for page+2 (next page)
        const nextPage = page + 2;
        const nextEl = $(`${pagination.selector}:contains("${nextPage}")`);
        if (nextEl.length > 0) {
          nextUrl = nextEl.attr("href") || "";
        } else {
          // Try finding "next" / "下一页" link
          const nextTextEl = $(pagination.selector).filter(
            (i, el) => {
              const text = $(el).text().trim();
              return (
                text.includes("下一页") ||
                text.includes("next") ||
                text === ">"
              );
            }
          );
          nextUrl = nextTextEl.attr("href") || "";
        }
      }

      if (nextUrl) {
        currentUrl = resolveUrl(currentUrl, nextUrl);
        hasNextPage = true;

        // Delay between pages
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

// ==================== API Endpoint Handlers ====================

async function handleScrapeList(body: ScrapeListRequest) {
  const { url, selector, pagination, antiCrawl } = body;

  const { results, hasNextPage } = await handlePagination(
    url,
    selector,
    pagination,
    antiCrawl,
    (html, pageUrl) => {
      const items = parseSelectorMulti(html, selector);
      return items.map((item) => resolveUrl(pageUrl, item));
    }
  );

  return { urls: results, hasNextPage };
}

async function handleScrapeBook(body: ScrapeBookRequest) {
  const { url, selectors, antiCrawl } = body;
  const { html } = await fetchPage(url, antiCrawl);

  const title = parseSelector(html, selectors.title);
  const author = selectors.author
    ? parseSelector(html, selectors.author)
    : "佚名";
  const category = selectors.category
    ? parseSelector(html, selectors.category)
    : "";
  const keywords = selectors.keywords
    ? parseSelector(html, selectors.keywords)
    : "";
  const description = selectors.description
    ? parseSelector(html, selectors.description)
    : "";
  let coverUrl = selectors.cover ? parseSelector(html, selectors.cover) : "";
  const status = selectors.status
    ? parseSelector(html, selectors.status)
    : "";

  // Resolve relative URLs for cover
  if (coverUrl) {
    coverUrl = resolveUrl(url, coverUrl);
  }

  return { title, author, category, keywords, description, coverUrl, status };
}

async function handleScrapeChapters(body: ScrapeChaptersRequest) {
  const { url, selectors, pagination, antiCrawl, enableShuffle } = body;

  const allChapters: Array<{ title: string; url: string; sortOrder: number }> = [];
  const seenUrls = new Set<string>();
  let currentUrl = url;
  let hasNextPage = false;
  const maxPages = pagination?.maxPage || 1;

  for (let page = 0; page < maxPages; page++) {
    console.log(`  [Chapters] Page ${page + 1}/${maxPages}: ${currentUrl}`);

    const { html } = await fetchPage(currentUrl, antiCrawl);
    const links = extractLinksFromList(
      html,
      selectors.list,
      selectors.link,
      selectors.title,
      currentUrl
    );

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

    console.log(
      `  [Chapters] Found ${links.length} chapters, ${newCount} new`
    );

    // Find next page
    if (pagination) {
      const $ = cheerio.load(html);
      let nextUrl = "";

      if (pagination.type === "next") {
        const nextEl = $(pagination.selector);
        nextUrl = nextEl.attr("href") || "";
      } else if (pagination.type === "page") {
        const nextPage = page + 2;
        const nextEl = $(
          `${pagination.selector}:contains("${nextPage}")`
        );
        if (nextEl.length > 0) {
          nextUrl = nextEl.attr("href") || "";
        } else {
          const nextTextEl = $(pagination.selector).filter((i, el) => {
            const text = $(el).text().trim();
            return (
              text.includes("下一页") ||
              text.includes("next") ||
              text === ">"
            );
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
    // Re-assign sort orders after shuffle
    allChapters.forEach((ch, idx) => {
      ch.sortOrder = idx + 1;
    });
  }

  return { chapters: allChapters, hasNextPage };
}

async function handleScrapeContent(body: ScrapeContentRequest) {
  const { url, selectors, pagination, antiCrawl } = body;

  let fullContent = "";
  let title = "";
  let currentUrl = url;
  const maxPages = pagination?.maxPage || 1;

  for (let page = 0; page < maxPages; page++) {
    console.log(
      `  [Content] Page ${page + 1}/${maxPages}: ${currentUrl}`
    );

    const { html } = await fetchPage(currentUrl, antiCrawl);

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
        const nextEl = $(pagination.selector);
        nextUrl = nextEl.attr("href") || "";
      } else if (pagination.type === "page") {
        const nextPage = page + 2;
        const nextEl = $(
          `${pagination.selector}:contains("${nextPage}")`
        );
        if (nextEl.length > 0) {
          nextUrl = nextEl.attr("href") || "";
        } else {
          const nextTextEl = $(pagination.selector).filter((i, el) => {
            const text = $(el).text().trim();
            return (
              text.includes("下一页") ||
              text.includes("next") ||
              text === ">"
            );
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
  };
}

function handleClean(body: CleanRequest) {
  const { html, config } = body;
  const content = cleanHtml(html, config);
  return {
    content,
    wordCount: content.length,
  };
}

async function handleDownloadCover(body: DownloadCoverRequest) {
  const { url, savePath } = body;

  console.log(`  [Cover] Downloading from ${url} to ${savePath}`);

  const response = await fetch(url, {
    headers: {
      "User-Agent": getRandomUA(),
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
  let sharp: typeof import("sharp");
  try {
    sharp = await import("sharp");
  } catch {
    throw new Error("sharp module not available");
  }

  const webpBuffer = await sharp.default(buffer)
    .webp({ quality: 80 })
    .toBuffer();

  // Ensure directory exists
  const dir = savePath.substring(0, savePath.lastIndexOf("/"));
  try {
    await Bun.write(`${dir}/.gitkeep`, "");
  } catch {
    // Directory may already exist, ignore
  }

  // Ensure the full directory path exists
  const pathParts = savePath.split("/");
  for (let i = 2; i < pathParts.length - 1; i++) {
    const partialPath = pathParts.slice(0, i + 1).join("/");
    try {
      await Bun.write(`${partialPath}/.gitkeep`, "");
    } catch {
      // ignore
    }
  }

  await Bun.write(savePath, webpBuffer);

  console.log(`  [Cover] Saved to ${savePath} (${webpBuffer.length} bytes)`);

  return {
    success: true,
    path: savePath,
    size: webpBuffer.length,
  };
}

// ==================== Task Execution Engine ====================

interface ScrapeRule {
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
}

interface ScrapeTask {
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

const API_BASE = process.env.MAIN_APP_URL || "http://localhost:3000";

async function apiCall(
  method: string,
  path: string,
  body?: unknown
): Promise<{ data: unknown; status: number }> {
  const options: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
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

async function updateTaskProgress(
  taskId: string,
  updates: Partial<ScrapeTask>
) {
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

function parseJsonField<T>(field: string | null, fallback: T): T {
  if (!field) return fallback;
  try {
    return JSON.parse(field) as T;
  } catch {
    return fallback;
  }
}

function parseSelectorField(field: string | null): Selector | null {
  if (!field) return null;
  try {
    return JSON.parse(field) as Selector;
  } catch {
    return null;
  }
}

/**
 * Map raw status text to the system status enum
 */
function mapStatus(rawStatus: string): string {
  const lower = rawStatus.trim();
  if (lower.includes("完") || lower.includes("结局") || lower.includes("end") || lower === "completed") {
    return "completed";
  }
  if (lower.includes("断") || lower.includes("暂停") || lower.includes("hiatus")) {
    return "hiatus";
  }
  return "ongoing";
}

/**
 * Execute a full scraping task - the main orchestration function
 */
async function executeTask(taskId: string) {
  console.log(`[Task ${taskId}] Starting task execution`);

  // 1. Fetch task + rule from Next.js API
  const { data: taskData, status } = await apiCall(
    "GET",
    `/api/scrape-tasks/${taskId}`
  );

  if (status !== 200 || !taskData) {
    throw new Error(`Failed to fetch task ${taskId}: HTTP ${status}`);
  }

  const task = taskData as ScrapeTask;
  const rule = task.rule;

  console.log(`[Task ${taskId}] Rule: ${rule.name}, Mode: ${task.mode || rule.scrapeMode}`);

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

  // Merge delay from rule if not in antiCrawl config
  if (!antiCrawlConfig.delay) {
    antiCrawlConfig.delay = [rule.minDelay, rule.maxDelay];
  }

  const threadCount = rule.threadCount || 3;
  const isIncremental = (task.mode || rule.scrapeMode) === "incremental";
  const dedupMode = rule.dedupMode || "url";

  // Update task status to running
  await updateTaskProgress(taskId, {
    status: "running",
    startedAt: new Date().toISOString(),
    currentStep: "正在采集列表页...",
    progress: 0,
  });

  await addTaskLog(taskId, "info", `开始执行采集任务: ${rule.name}`);

  // 2. Scrape list page to get book URLs
  if (!rule.listUrl || !listSelector) {
    throw new Error("列表页URL和选择器不能为空");
  }

  await addTaskLog(taskId, "info", `开始采集列表页: ${rule.listUrl}`);

  const { urls: bookUrls } = await handleScrapeList({
    url: rule.listUrl,
    selector: listSelector,
    pagination: listPagination,
    antiCrawl: antiCrawlConfig,
  });

  console.log(`[Task ${taskId}] Found ${bookUrls.length} book URLs`);

  await addTaskLog(
    taskId,
    "success",
    `列表页采集完成，共发现 ${bookUrls.length} 本书`
  );

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

  // 3. For each book URL, scrape book info and create/update
  const seenTitles = new Set<string>();
  const seenUrls = new Set<string>();
  let newBooksCount = 0;
  let skippedBooksCount = 0;
  let failedItemsCount = 0;
  let totalChaptersCount = 0;
  let newChaptersCount = 0;
  const booksProcessed: Array<{ id: string; title: string; url: string }> = [];

  // Process books with concurrency control
  async function processBook(
    bookUrl: string,
    index: number
  ): Promise<void> {
    try {
      console.log(
        `[Task ${taskId}] Processing book ${index + 1}/${bookUrls.length}: ${bookUrl}`
      );

      // Delay between requests
      if (antiCrawlConfig.delay) {
        await randomDelay(antiCrawlConfig.delay[0], antiCrawlConfig.delay[1]);
      }

      // Scrape book info
      const bookInfo = await handleScrapeBook({
        url: bookUrl,
        selectors: {
          title: parseSelectorField(rule.bookTitleSelector) || {
            type: "css",
            value: "h1",
          },
          author: parseSelectorField(rule.bookAuthorSelector) || undefined,
          category: parseSelectorField(rule.bookCategorySelector) || undefined,
          keywords: parseSelectorField(rule.bookKeywordsSelector) || undefined,
          description:
            parseSelectorField(rule.bookDescriptionSelector) || undefined,
          cover: parseSelectorField(rule.bookCoverSelector) || undefined,
          status: parseSelectorField(rule.bookStatusSelector) || undefined,
        },
        antiCrawl: antiCrawlConfig,
      });

      if (!bookInfo.title) {
        console.log(
          `[Task ${taskId}] Book at ${bookUrl} has no title, skipping`
        );
        skippedBooksCount++;
        await addTaskLog(
          taskId,
          "warn",
          `跳过无标题书籍: ${bookUrl}`,
          bookUrl
        );
        return;
      }

      // Dedup by title and/or URL
      if (dedupMode === "title" || dedupMode === "both") {
        if (seenTitles.has(bookInfo.title)) {
          console.log(
            `[Task ${taskId}] Duplicate title: ${bookInfo.title}, skipping`
          );
          skippedBooksCount++;
          return;
        }
      }
      if (dedupMode === "url" || dedupMode === "both") {
        if (seenUrls.has(bookUrl)) {
          console.log(
            `[Task ${taskId}] Duplicate URL: ${bookUrl}, skipping`
          );
          skippedBooksCount++;
          return;
        }
      }

      seenTitles.add(bookInfo.title);
      seenUrls.add(bookUrl);

      // Check if novel already exists (for incremental mode)
      let novelId = "";
      let isExisting = false;

      if (isIncremental) {
        // Search for existing novel by sourceUrl
        // Use the novels search API
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
            console.log(
              `[Task ${taskId}] Existing novel found: ${bookInfo.title} (${novelId})`
            );
          }
        }
      }

      // Create or update novel
      const novelData: Record<string, unknown> = {
        title: bookInfo.title,
        author: bookInfo.author || "佚名",
        description: bookInfo.description || null,
        coverUrl: bookInfo.coverUrl || null,
        status: mapStatus(bookInfo.status),
        sourceUrl: bookUrl,
        sourceId: rule.id,
      };

      if (bookInfo.category) {
        novelData.categoryName = bookInfo.category;
      }
      if (bookInfo.keywords) {
        novelData.extraKeywords = bookInfo.keywords;
      }

      if (isExisting) {
        // Update existing novel
        await apiCall("PUT", `/api/novels/${novelId}`, novelData);
        await addTaskLog(
          taskId,
          "info",
          `更新小说: ${bookInfo.title}`,
          bookUrl
        );
      } else {
        // Create new novel
        const { data: createdNovel, status: createStatus } = await apiCall(
          "POST",
          "/api/novels",
          novelData
        );
        if (createStatus === 201 && createdNovel) {
          novelId = (createdNovel as { id: string }).id;
          newBooksCount++;
          await addTaskLog(
            taskId,
            "success",
            `新建小说: ${bookInfo.title}`,
            bookUrl
          );
        } else {
          failedItemsCount++;
          await addTaskLog(
            taskId,
            "error",
            `创建小说失败: ${bookInfo.title}`,
            bookUrl,
            `HTTP ${createStatus}`
          );
          return;
        }
      }

      booksProcessed.push({
        id: novelId,
        title: bookInfo.title,
        url: bookUrl,
      });

      // Download cover if available and save path configured
      if (bookInfo.coverUrl && rule.coverSavePath) {
        try {
          const coverFilename = `${novelId}.webp`;
          const savePath = `${rule.coverSavePath}/${coverFilename}`;
          await handleDownloadCover({
            url: bookInfo.coverUrl,
            savePath,
          });
          // Update novel with local cover path
          await apiCall("PUT", `/api/novels/${novelId}`, {
            coverPath: savePath,
          });
        } catch (coverErr) {
          console.error(
            `[Task ${taskId}] Failed to download cover for ${bookInfo.title}:`,
            coverErr
          );
          await addTaskLog(
            taskId,
            "warn",
            `封面下载失败: ${bookInfo.title}`,
            bookInfo.coverUrl,
            String(coverErr)
          );
        }
      }
    } catch (err) {
      failedItemsCount++;
      console.error(
        `[Task ${taskId}] Error processing book ${bookUrl}:`,
        err
      );
      await addTaskLog(
        taskId,
        "error",
        `采集书籍失败: ${bookUrl}`,
        bookUrl,
        String(err)
      );
    }
  }

  // Process books with concurrency
  const bookQueue = [...bookUrls];
  const running = new Set<Promise<void>>();

  async function runNextBook(): Promise<void> {
    if (bookQueue.length === 0) return;
    const url = bookQueue.shift()!;
    const index = bookUrls.length - bookQueue.length - 1;
    await processBook(url, index);
  }

  // Use a simple concurrency pool
  async function processAllBooks(): Promise<void> {
    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(threadCount, bookUrls.length); i++) {
      workers.push(
        (async () => {
          while (bookQueue.length > 0) {
            await runNextBook();

            // Update progress
            const processed = bookUrls.length - bookQueue.length;
            const bookProgress = 5 + (processed / bookUrls.length) * 15; // 5-20%
            await updateTaskProgress(taskId, {
              progress: Math.round(bookProgress),
              currentStep: `正在采集书籍信息 (${processed}/${bookUrls.length})...`,
              newBooks: newBooksCount,
              failedItems: failedItemsCount,
              skippedItems: skippedBooksCount,
            });
          }
        })()
      );
    }
    await Promise.all(workers);
  }

  await processAllBooks();

  console.log(
    `[Task ${taskId}] Books processed: ${booksProcessed.length} (new: ${newBooksCount}, skipped: ${skippedBooksCount}, failed: ${failedItemsCount})`
  );

  await addTaskLog(
    taskId,
    "success",
    `书籍信息采集完成: 新建 ${newBooksCount}, 跳过 ${skippedBooksCount}, 失败 ${failedItemsCount}`
  );

  if (booksProcessed.length === 0) {
    await updateTaskProgress(taskId, {
      status: "completed",
      completedAt: new Date().toISOString(),
      currentStep: "采集完成（无有效书籍）",
      progress: 100,
    });
    return {
      success: true,
      totalBooks: 0,
      newBooks: 0,
      totalChapters: 0,
      newChapters: 0,
    };
  }

  // 4. For each book, scrape chapter directory
  await updateTaskProgress(taskId, {
    currentStep: "正在采集章节目录...",
    progress: 20,
  });

  await addTaskLog(taskId, "info", "开始采集章节目录");

  // Build chapter list selector
  const chapterListSelector = parseSelectorField(rule.chapterListSelector);
  const chapterTitleSelector = parseSelectorField(rule.chapterTitleSelector);
  const chapterLinkSelector = parseSelectorField(rule.chapterLinkSelector);
  const chapterPagination = parseJsonField<Pagination>(
    rule.chapterPagination,
    undefined
  );

  // Process chapters for all books sequentially (respecting concurrency for individual chapter scraping later)
  for (let bookIdx = 0; bookIdx < booksProcessed.length; bookIdx++) {
    const book = booksProcessed[bookIdx];
    const bookProgress =
      20 + (bookIdx / booksProcessed.length) * 30; // 20-50%

    console.log(
      `[Task ${taskId}] Scraping chapters for: ${book.title} (${bookIdx + 1}/${booksProcessed.length})`
    );

    await updateTaskProgress(taskId, {
      currentStep: `正在采集章节目录: ${book.title} (${bookIdx + 1}/${booksProcessed.length})...`,
      progress: Math.round(bookProgress),
    });

    try {
      // Determine chapter list URL
      let chapterListUrl = rule.chapterListUrl
        ? rule.chapterListUrl.replace("{bookUrl}", book.url)
        : book.url;

      if (!chapterListSelector || !chapterTitleSelector || !chapterLinkSelector) {
        console.log(
          `[Task ${taskId}] Missing chapter selectors, skipping chapters for ${book.title}`
        );
        await addTaskLog(
          taskId,
          "warn",
          `缺少章节目录选择器，跳过: ${book.title}`,
          book.url
        );
        continue;
      }

      if (antiCrawlConfig.delay) {
        await randomDelay(antiCrawlConfig.delay[0], antiCrawlConfig.delay[1]);
      }

      // Scrape chapter list
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
      });

      console.log(
        `[Task ${taskId}] Found ${chapters.length} chapters for ${book.title}`
      );

      if (chapters.length === 0) {
        await addTaskLog(
          taskId,
          "warn",
          `未发现章节: ${book.title}`,
          chapterListUrl
        );
        continue;
      }

      await addTaskLog(
        taskId,
        "info",
        `发现 ${chapters.length} 个章节: ${book.title}`,
        chapterListUrl
      );

      // 5. For each chapter, scrape content
      const contentSelector = parseSelectorField(rule.contentSelector);
      const contentTitleSelector = parseSelectorField(rule.contentTitleSelector);
      const contentPagination = parseJsonField<Pagination>(
        rule.contentPagination,
        undefined
      );

      if (!contentSelector) {
        console.log(
          `[Task ${taskId}] Missing content selector, skipping content for ${book.title}`
        );
        await addTaskLog(
          taskId,
          "warn",
          `缺少正文选择器，跳过内容采集: ${book.title}`
        );
        continue;
      }

      // Get existing chapters for incremental mode
      const existingChapters = new Map<string, string>(); // url -> chapterId
      if (isIncremental) {
        try {
          const { data: existingData, status: existingStatus } = await apiCall(
            "GET",
            `/api/novels/${book.id}/chapters`
          );
          if (existingStatus === 200 && Array.isArray(existingData)) {
            for (const ch of existingData as Array<{
              id: string;
              sourceUrl?: string;
              title: string;
            }>) {
              if (ch.sourceUrl) {
                existingChapters.set(ch.sourceUrl, ch.id);
              }
              // Also dedup by title
              existingChapters.set(`title:${ch.title}`, ch.id);
            }
          }
        } catch {
          // Ignore
        }
      }

      // Process chapters with concurrency
      const chapterQueue = [...chapters];

      async function processChapter(): Promise<void> {
        if (chapterQueue.length === 0) return;
        const chapter = chapterQueue.shift()!;

        try {
          // Incremental: skip if chapter already exists
          if (isIncremental) {
            if (existingChapters.has(chapter.url)) {
              skippedBooksCount++;
              return;
            }
            if (existingChapters.has(`title:${chapter.title}`)) {
              skippedBooksCount++;
              return;
            }
          }

          if (antiCrawlConfig.delay) {
            await randomDelay(
              antiCrawlConfig.delay[0],
              antiCrawlConfig.delay[1]
            );
          }

          // Scrape chapter content
          const contentResult = await handleScrapeContent({
            url: chapter.url,
            selectors: {
              title: contentTitleSelector || undefined,
              content: contentSelector,
            },
            pagination: contentPagination,
            antiCrawl: antiCrawlConfig,
          });

          // Clean content
          const cleaned = handleClean({
            html: contentResult.content,
            config: cleanConfig,
          });

          const chapterTitle = contentResult.title || chapter.title;
          const chapterContent = cleaned.content;

          if (!chapterContent.trim()) {
            console.log(
              `[Task ${taskId}] Empty content for chapter: ${chapterTitle}`
            );
            skippedBooksCount++;
            return;
          }

          // Create chapter via API
          const { status: chStatus } = await apiCall(
            "POST",
            `/api/novels/${book.id}/chapters`,
            {
              title: chapterTitle,
              content: chapterContent,
              sortOrder: chapter.sortOrder,
              sourceUrl: chapter.url,
            }
          );

          if (chStatus === 201) {
            newChaptersCount++;
            totalChaptersCount++;
          } else {
            failedItemsCount++;
          }
        } catch (err) {
          failedItemsCount++;
          console.error(
            `[Task ${taskId}] Error scraping chapter ${chapter.url}:`,
            err
          );
        }
      }

      // Process all chapters with concurrency
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
      const chapterProgress =
        50 +
        ((bookIdx + 1) / booksProcessed.length) * 45; // 50-95%
      await updateTaskProgress(taskId, {
        progress: Math.round(chapterProgress),
        totalChapters: totalChaptersCount,
        newChapters: newChaptersCount,
        failedItems: failedItemsCount,
        skippedItems: skippedBooksCount,
        currentStep: `已完成 ${book.title} (${chapters.length} 章)`,
      });

      console.log(
        `[Task ${taskId}] Completed ${book.title}: ${chapters.length} chapters processed`
      );

      await addTaskLog(
        taskId,
        "success",
        `完成采集 ${book.title}: 共 ${chapters.length} 章`,
        book.url
      );
    } catch (err) {
      console.error(
        `[Task ${taskId}] Error processing chapters for ${book.title}:`,
        err
      );
      await addTaskLog(
        taskId,
        "error",
        `章节目录采集失败: ${book.title}`,
        book.url,
        String(err)
      );
      failedItemsCount++;
    }
  }

  // 7. Mark task as completed
  await updateTaskProgress(taskId, {
    status: "completed",
    completedAt: new Date().toISOString(),
    progress: 100,
    currentStep: "采集完成",
    totalBooks: booksProcessed.length,
    newBooks: newBooksCount,
    totalChapters: totalChaptersCount,
    newChapters: newChaptersCount,
    failedItems: failedItemsCount,
    skippedItems: skippedBooksCount,
  });

  await addTaskLog(
    taskId,
    "success",
    `任务完成! 新建小说: ${newBooksCount}, 新建章节: ${newChaptersCount}, 跳过: ${skippedBooksCount}, 失败: ${failedItemsCount}`
  );

  console.log(`[Task ${taskId}] Task completed successfully`);

  return {
    success: true,
    totalBooks: booksProcessed.length,
    newBooks: newBooksCount,
    totalChapters: totalChaptersCount,
    newChapters: newChaptersCount,
    failed: failedItemsCount,
    skipped: skippedBooksCount,
  };
}

// ==================== Server ====================

export function startServer(port: number = 3099) {
  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      // CORS headers
      const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      };

      // Handle CORS preflight
      if (method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      // Health check
      if (path === "/health" && method === "GET") {
        return Response.json({
          status: "ok",
          service: "scraper-service",
          port: 3099,
          timestamp: new Date().toISOString(),
        });
      }

      // Only handle POST requests for endpoints
      if (method !== "POST") {
        return Response.json(
          { error: "Method not allowed. Use POST." },
          { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Parse JSON body
      let body: unknown;
      try {
        const text = await req.text();
        if (text.trim()) {
          body = JSON.parse(text);
        } else {
          body = {};
        }
      } catch {
        return Response.json(
          { error: "Invalid JSON body" },
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const jsonHeaders = {
        "Content-Type": "application/json",
        ...corsHeaders,
      };

      try {
        // Route to handlers
        if (path === "/scrape/list") {
          const result = await handleScrapeList(body as ScrapeListRequest);
          return Response.json(result, { headers: jsonHeaders });
        }

        if (path === "/scrape/book") {
          const result = await handleScrapeBook(body as ScrapeBookRequest);
          return Response.json(result, { headers: jsonHeaders });
        }

        if (path === "/scrape/chapters") {
          const result = await handleScrapeChapters(
            body as ScrapeChaptersRequest
          );
          return Response.json(result, { headers: jsonHeaders });
        }

        if (path === "/scrape/content") {
          const result = await handleScrapeContent(
            body as ScrapeContentRequest
          );
          return Response.json(result, { headers: jsonHeaders });
        }

        if (path === "/clean") {
          const result = handleClean(body as CleanRequest);
          return Response.json(result, { headers: jsonHeaders });
        }

        if (path === "/download-cover") {
          const result = await handleDownloadCover(
            body as DownloadCoverRequest
          );
          return Response.json(result, { headers: jsonHeaders });
        }

        if (path === "/execute-task") {
          const { taskId } = body as ExecuteTaskRequest;
          if (!taskId) {
            return Response.json(
              { error: "taskId is required" },
              { status: 400, headers: jsonHeaders }
            );
          }
          // Run task asynchronously so we can return immediately
          // The task updates its own progress via API calls
          executeTask(taskId).catch((err) => {
            console.error(`[Task ${taskId}] Fatal error:`, err);
            updateTaskProgress(taskId, {
              status: "failed",
              errorMessage: String(err),
              completedAt: new Date().toISOString(),
            }).catch(() => {});
            addTaskLog(taskId, "error", `任务执行失败: ${String(err)}`).catch(
              () => {}
            );
          });
          return Response.json(
            {
              message: "Task execution started",
              taskId,
            },
            { headers: jsonHeaders }
          );
        }

        return Response.json(
          { error: `Unknown endpoint: ${path}` },
          { status: 404, headers: jsonHeaders }
        );
      } catch (err) {
        console.error(`[Server] Error handling ${path}:`, err);
        return Response.json(
          {
            error: "Internal server error",
            message: String(err),
            endpoint: path,
          },
          { status: 500, headers: jsonHeaders }
        );
      }
    },
  });

  console.log(`🚀 Scraper Service running on port ${server.port}`);
  console.log(`   Endpoints:`);
  console.log(`   POST /scrape/list       - Scrape a list page`);
  console.log(`   POST /scrape/book       - Scrape book info`);
  console.log(`   POST /scrape/chapters   - Scrape chapter directory`);
  console.log(`   POST /scrape/content    - Scrape chapter content`);
  console.log(`   POST /clean             - Clean scraped content`);
  console.log(`   POST /download-cover    - Download & convert cover`);
  console.log(`   POST /execute-task      - Execute full scraping task`);
  console.log(`   GET  /health            - Health check`);
}

// Start server if run directly
const PORT = parseInt(process.env.PORT || "3099", 10);
console.log(`[Config] API_BASE: ${API_BASE}`);
console.log(`[Config] PORT: ${PORT}`);
startServer(PORT);

// Graceful shutdown
const shutdown = (signal: string) => {
  console.log(`\n[${new Date().toISOString()}] Received ${signal}, shutting down gracefully...`);
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));