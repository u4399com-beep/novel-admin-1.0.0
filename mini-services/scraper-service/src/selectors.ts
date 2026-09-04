/**
 * Selector Engine - CSS / XPath / Regex parsing
 * Enhanced with better XPath support, attribute detection,
 * and novel-site fallback selector system.
 */

import * as cheerio from "cheerio";
import { getCachedCheerio } from "./cheerio-cache";
import type { Selector } from "./types";
import { safeRegexMatch } from "./regex-safety";
import { resolveUrl } from "./utils";

// ==================== Novel-Site Fallback Selectors ====================

/**
 * Common CSS selectors for chapter content extraction on Chinese novel sites.
 * Ordered from most common to least common. Used as fallbacks when primary selector fails.
 */
export const NOVEL_CONTENT_SELECTORS: string[] = [
  '#content',
  '#chaptercontent',
  '#booktxt',
  '#contentbox',
  '#htmlContent',
  '#TextContent',
  '.readcontent',
  '.chapter-content',
  '#chapter-content',
  '#nr1',
  '#nr_title',
  '.novelcontent',
  '#novelcontent',
  '.bookcontent',
  '#bookcontent',
  '#chaptertxt',
  '.chapter_content',
  '#chapter_content',
  '#articlecontent',
  '.article-content',
  '#txtContent',
  '.txt-content',
  '.contentbox',
  '.booktxt',
  '.read-content',
  '#read-content',
  'div.content',
  // Extended fallback selectors for less common Chinese novel site patterns
  '#text-content',
  '.text-content',
  '#txt_content',
  '.txt_content',
  '#cont-text',
  '.cont-text',
  '.chapter-txt',
  '#chapter-txt',
  '.readbox',
  '#readbox',
  '.read_box',
  '#read_box',
  '.text-read',
  '#text-read',
  '#BookText',
  '.BookText',
  '.book-text',
  '#book-text',
  'div.read',
  'div.txt',
  'div.text',
  'article .text',
  'article .txt',
  '.entry-content',
  '#entry-content',
  '.post-content',
  '#post-content',
  '.story-content',
  '#story-content',
  '.fiction-content',
  '#fiction-content',
];

/**
 * Korean novel site content selectors.
 * Common CSS selectors used on Korean novel/web novel platforms.
 */
export const KO_NOVEL_CONTENT_SELECTORS = [
  '.txt-content', '#novel_content', '.section-content', '#articleContent',
  '.novel-content', '.view-content', '.content-wrap', '.entry-content',
  '#content', '.content', 'article .content'
];

/**
 * Japanese novel site content selectors.
 * Common CSS selectors used on Japanese novel platforms (Syosetu, Kakuyomu, etc.).
 */
export const JA_NOVEL_CONTENT_SELECTORS = [
  '.novel-body', '#main-text', '.p-novel__text', '#novel_honbun',
  '.novel-content', '.entry-content', '.content-body', '.story',
  '#content', '.content', 'article'
];

/**
 * Korean novel site title selectors.
 */
export const KO_NOVEL_TITLE_SELECTORS = [
  '.tit_area .tit', '.novel-title', '.section-title', '#novel_title',
  '.view-title', 'h1.title', 'h1'
];

/**
 * Japanese novel site title selectors.
 */
export const JA_NOVEL_TITLE_SELECTORS = [
  '.p-novel__title', '.novel-title', '.widget__title', '#novel_title',
  '.entry-title', 'h1.title', 'h1'
];

/**
 * Common CSS selectors for book/chapter title extraction on novel sites.
 * Ordered from most specific (chapter title) to more general (book title).
 */
export const NOVEL_TITLE_SELECTORS: string[] = [
  'h1.chapter-title',
  '.chapter-title',
  'h2.chapter-title',
  '#chapter-title',
  'h1.bookTitle',
  '.bookTitle',
  '#bookname',
  '.book-name',
  '#book_title',
  'h1',
  'h2',
  '.title',
  '#title',
  '.chapter-name',
  '#chapter-name',
  'h1.title',
  'h2.title',
];

/**
 * Common CSS selectors for chapter list item extraction on novel sites.
 * Each selector targets the container element of a single chapter entry.
 */
export const NOVEL_LIST_SELECTORS: string[] = [
  '.chapter-list li',
  '#chapter-list li',
  '.chapter-list a',
  '#chapterList li',
  '#chapterList a',
  '.chapterlist li',
  '#chapterlist li',
  '.listmain dd',
  '#list dd',
  '.booklist li',
  '#booklist li',
  '.mulu li',
  '#mulu li',
  '.directory li',
  '#directory li',
  '.catalog li',
  '#catalog li',
  '.volumes dd',
  '.volume-list li',
];

/**
 * Try extracting text content using a list of CSS selectors in order.
 * Returns the first non-empty result.
 *
 * @param $ - Cheerio loaded document
 * @param selectors - Array of CSS selector strings to try in order
 * @param extractAttr - Optional attribute name to extract (e.g. 'href'). Default: text content.
 * @returns First non-empty extracted string, or empty string if none matched.
 */
export function extractWithFallbacks(
  $: cheerio.CheerioAPI,
  selectors: string[],
  extractAttr?: string
): string {
  for (const sel of selectors) {
    try {
      const el = $(sel);
      if (el.length === 0) continue;

      // Skip excluded tags
      if (!extractAttr && el[0] && isExcludedTag(el[0])) continue;

      if (extractAttr) {
        const val = el.attr(extractAttr);
        if (val && val.trim()) return val.trim();
      } else {
        const text = el.text().trim();
        if (text) return text;
      }
    } catch {
      // Invalid selector — skip
    }
  }
  return '';
}

/**
 * Parse a selector with fallback CSS selectors.
 * Tries the primary selector first; if it returns empty, tries each
 * fallback selector in order until a non-empty result is found.
 *
 * Only CSS fallback selectors are supported (not XPath/regex fallbacks).
 *
 * @param html - Raw HTML string
 * @param primarySelector - The primary Selector to try first
 * @param fallbackSelectors - Array of CSS selector strings to try as fallbacks
 * @returns First non-empty extracted string
 *
 * @example
 * ```ts
 * const title = parseSelectorWithFallbacks(html,
 *   { type: 'css', value: 'h1.my-title' },
 *   NOVEL_TITLE_SELECTORS
 * );
 * ```
 */
export function parseSelectorWithFallbacks(
  html: string,
  primarySelector: Selector,
  fallbackSelectors: string[]
): string {
  // Try primary selector first
  const primaryResult = parseSelector(html, primarySelector);
  if (primaryResult) return primaryResult;

  // If primary is regex, don't try CSS fallbacks — regex implies a specific extraction
  // intent that generic CSS selectors can't fulfill.
  if (primarySelector.type === 'regex') return '';

  // Fallback: try each CSS selector in order
  const $ = getCachedCheerio(html);
  const extractAttr = primarySelector.extract;

  for (const sel of fallbackSelectors) {
    try {
      const el = $(sel);
      if (el.length === 0) continue;

      // Skip excluded tags unless we're extracting an attribute
      if (!extractAttr && el[0] && isExcludedTag(el[0])) continue;

      if (extractAttr) {
        const val = el.attr(extractAttr);
        if (val && val.trim()) return val.trim();
      } else {
        const text = el.text().trim();
        if (text) return text;
      }
    } catch {
      // Invalid CSS selector — skip
    }
  }

  // Final fallback: try Korean and Japanese novel site selectors
  const i18nFallbacks = [
    ...KO_NOVEL_CONTENT_SELECTORS,
    ...JA_NOVEL_CONTENT_SELECTORS,
  ];
  for (const sel of i18nFallbacks) {
    try {
      const el = $(sel);
      if (el.length === 0) continue;

      // Skip excluded tags unless we're extracting an attribute
      if (!extractAttr && el[0] && isExcludedTag(el[0])) continue;

      if (extractAttr) {
        const val = el.attr(extractAttr);
        if (val && val.trim()) return val.trim();
      } else {
        const text = el.text().trim();
        if (text) return text;
      }
    } catch {
      // Invalid CSS selector — skip
    }
  }

  return '';
}

// Tags whose text content should never be extracted (noise / security)
const EXCLUDED_TAGS = new Set(['script', 'style', 'noscript', 'template']);

function isExcludedTag(el: cheerio.Element): boolean {
  // cheerio uses specific type values: 'script' for <script>, 'style' for <style>,
  // 'tag' for regular elements. Check tagName regardless of type.
  const tagName = (el as cheerio.Element & { name: string }).name;
  return !!tagName && EXCLUDED_TAGS.has(tagName);
}

// ==================== XPath to CSS Converter ====================

interface XPathResult {
  css: string;
  hasTextSelector: boolean;
  attrName: string | null;
}

/**
 * Convert common XPath patterns to CSS selectors.
 * Handles: //tag, //tag[@attr], //tag[@attr='val'], /html/body, //text(), //*, @attr
 */
function xpathToCss(xpath: string): XPathResult {
  let css = xpath;
  const hasTextSelector = css.includes("text()");

  // Extract attribute name if present: /@attr at the end
  let attrName: string | null = null;
  const attrMatch = css.match(/\/@(\w+)$/);
  if (attrMatch) {
    attrName = attrMatch[1];
    css = css.replace(/\/@(\w+)$/, "");
  }
  // NOTE: XPath existence predicates like [@attr] (no value) are NOT attribute
  // extraction — they mean "element has this attribute". The correct attribute
  // extraction syntax is /@attr (handled above). Do NOT treat [@attr] as extraction.


  // Remove text() selections
  css = css.replace(/\/text\(\)/g, "");

  // /html/body/... → remove leading slashes
  css = css.replace(/^\/+/, "");

  // Convert following-sibling::tag → ~ tag (general sibling combinator)
  css = css.replace(/following-sibling::(\w+)/g, "~ $1");

  // //tag[@attr='value'] → tag[attr='value']
  css = css.replace(
    /\/(\w+)\[@(\w+)=['"]([^'"]*)['"]\]/g,
    (_m, tag: string, attr: string, val: string) => `${tag}[${attr}="${val}"]`
  );

  // //tag[@attr] → tag[attr]
  css = css.replace(
    /\/(\w+)\[@(\w+)\]/g,
    (_m, tag: string, attr: string) => `${tag}[${attr}]`
  );

  // // → descendant combinator
  css = css.replace(/\/\//g, " ");

  // Remaining / → space
  css = css.replace(/\//g, " ");

  // Remove //*
  css = css.replace(/\s*\*\s*/g, " ");

  // Clean up
  css = css.replace(/\s+/g, " ").trim();

  return { css, hasTextSelector, attrName };
}

// ==================== Single Element Selector ====================

export function parseSelector(html: string, selector: Selector): string {
  if (selector.type === "regex") {
    const match = safeRegexMatch(html, selector.value, "gi");
    return match?.[0] || "";
  }

  if (selector.type === "xpath") {
    const { css, hasTextSelector, attrName } = xpathToCss(selector.value);
    const $ = getCachedCheerio(html);

    if (hasTextSelector) {
      const parentXpath = selector.value.replace(/\/text\(\)/g, "");
      const { css: parentCss } = xpathToCss(parentXpath);
      if (parentCss) {
        return $(parentCss).text().trim();
      }
      return "";
    }

    const el = $(css);
    if (el.length === 0) return "";

    // Explicit extract attribute takes priority
    if (selector.extract) {
      return el.attr(selector.extract) || "";
    }
    if (attrName) {
      return el.attr(attrName) || "";
    }

    // Skip extracting text from script/style/noscript/template tags
    if (isExcludedTag(el[0]!)) return "";

    const text = el.text().trim();
    if (text) return text;
    // Only fall back to href/src if the XPath explicitly selected an attribute-less element
    // and no extract attr was requested — avoids returning URLs when text was expected
    return "";
  }

  // CSS selector (default)
  const $ = getCachedCheerio(html);
  const el = $(selector.value);
  if (el.length === 0) return "";

  // Explicit extract attribute takes priority (e.g. extract: "content" for meta tags)
  if (selector.extract) {
    return el.attr(selector.extract) || "";
  }

  // Auto-detect attribute extraction (use precise match to avoid false positives like '[data-href]')
  if (/\[href\](?![\w-])/.test(selector.value) || /(?:^|[\s>+~,])href$/.test(selector.value)) {
    return el.attr("href") || "";
  }
  if (/\[src\](?![\w-])/.test(selector.value) || /(?:^|[\s>+~,])src$/.test(selector.value)) {
    return el.attr("src") || "";
  }
  // Auto-detect meta[property=...] or meta[name=...] selectors
  if (/^meta\b/i.test(selector.value)) {
    const content = el.attr("content");
    if (content) return content;
  }

  // Skip extracting text from script/style/noscript/template tags
  if (isExcludedTag(el[0]!)) return "";

  return el.text().trim();
}

// ==================== Single Element Selector (HTML-preserving) ====================

/**
 * Extract content preserving HTML structure (paragraphs, line breaks).
 * Unlike parseSelector() which returns plain text, this returns HTML
 * that preserves <p>, <br>, <div> structure for paragraph formatting.
 *
 * For CSS selectors: returns el.html() (inner HTML) instead of el.text().
 * For XPath: returns innerHTML of matched elements.
 * For regex: same as parseSelector (regex returns plain text anyway).
 */
export function parseSelectorHtml(html: string, selector: Selector): string {
  if (selector.type === "regex") {
    // Regex can't return HTML structure — fall back to plain text
    const match = safeRegexMatch(html, selector.value, "gi");
    return match?.[0] || "";
  }

  if (selector.type === "xpath") {
    const { css, hasTextSelector, attrName } = xpathToCss(selector.value);
    const $ = getCachedCheerio(html);

    // Text selectors can't preserve HTML
    if (hasTextSelector) {
      const parentXpath = selector.value.replace(/\/text\(\)/g, "");
      const { css: parentCss } = xpathToCss(parentXpath);
      if (parentCss) {
        return $(parentCss).html() || "";
      }
      return "";
    }

    const el = $(css);
    if (el.length === 0) return "";

    // If extracting an attribute, that's not HTML
    if (selector.extract) {
      return el.attr(selector.extract) || "";
    }
    if (attrName) {
      return el.attr(attrName) || "";
    }

    // Skip excluded tags
    if (isExcludedTag(el[0]!)) return "";

    // Return inner HTML preserving structure
    return el.html() || "";
  }

  // CSS selector (default) — return inner HTML
  const $ = getCachedCheerio(html);
  const el = $(selector.value);
  if (el.length === 0) return "";

  // If extracting an attribute, that's not HTML
  if (selector.extract) {
    return el.attr(selector.extract) || "";
  }

  // Auto-detect attribute extraction (same logic as parseSelector)
  if ( /\[href\](?![\w-])/.test(selector.value) || /(?:^|[\s>+~,])href$/.test(selector.value)) {
    return el.attr("href") || "";
  }
  if (/\[src\](?![\w-])/.test(selector.value) || /(?:^|[\s>+~,])src$/.test(selector.value)) {
    return el.attr("src") || "";
  }
  if (/^meta\b/i.test(selector.value) && el.attr('content')) {
    return el.attr('content') || '';
  }

  // Skip excluded tags
  if (isExcludedTag(el[0]!)) return "";

  // Return inner HTML preserving paragraph structure
  return el.html() || "";
}

// ==================== Multi Element Selector ====================

export function parseSelectorMulti(html: string, selector: Selector): string[] {
  if (selector.type === "regex") {
    return safeRegexMatch(html, selector.value, "gi") || [];
  }

  if (selector.type === "xpath") {
    const { css, hasTextSelector, attrName } = xpathToCss(selector.value);
    const $ = getCachedCheerio(html);

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
    const extractAttr = selector.extract;

    elements.each((_, el) => {
      const $el = $(el);
      if (extractAttr) {
        // User explicitly requested a specific attribute (e.g. "content" for meta)
        const val = $el.attr(extractAttr);
        if (val) results.push(val);
      } else if (attrName) {
        const val = $el.attr(attrName);
        if (val) results.push(val);
      } else {
        const href = $el.attr("href");
        const src = $el.attr("src");
        if (href) {
          results.push(href);
        } else if (src) {
          results.push(src);
        } else {
          // Skip text extraction from excluded tags
          if (!isExcludedTag(el)) {
            const text = $el.text().trim();
            if (text) results.push(text);
          }
        }
      }
    });

    return results;
  }

  // CSS selector
  const $ = getCachedCheerio(html);
  const elements = $(selector.value);
  const results: string[] = [];
  const extractAttr = selector.extract;

  elements.each((_, el) => {
    const $el = $(el);
    if (extractAttr) {
      // User explicitly requested a specific attribute (e.g. "content" for meta)
      const val = $el.attr(extractAttr);
      if (val) results.push(val);
    } else {
      const href = $el.attr("href");
      const src = $el.attr("src");
      if (href) {
        results.push(href);
      } else if (src) {
        results.push(src);
      } else {
        // Skip text extraction from excluded tags
        if (!isExcludedTag(el)) {
          const text = $el.text().trim();
          if (text) results.push(text);
        }
      }
    }
  });

  return results;
}

// ==================== Extract Links from List ====================

export function extractLinksFromList(
  html: string,
  listSelector: Selector,
  linkSelector: Selector,
  titleSelector: Selector,
  baseUrl: string
): Array<{ title: string; url: string }> {
  const $ = getCachedCheerio(html);
  const results: Array<{ title: string; url: string }> = [];
  const seenUrls = new Set<string>();

  let listElements: cheerio.Cheerio<cheerio.Element>;

  if (listSelector.type === "xpath") {
    const { css } = xpathToCss(listSelector.value);
    listElements = $(css);
  } else if (listSelector.type === "regex") {
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
      const { css, attrName } = xpathToCss(linkSelector.value);
      const linkEl = $listEl.find(css);
      if (linkEl.length === 0) return;
      linkValue = attrName ? (linkEl.attr(attrName) || "") : (linkEl.attr("href") || "");
    } else if (linkSelector.type === "regex") {
      const match = safeRegexMatch($listEl.html() || "", linkSelector.value, "i");
      linkValue = match?.[1] || match?.[0] || "";
    } else {
      const linkEl = $listEl.find(linkSelector.value);
      if (linkEl.length === 0) return;
      linkValue = linkEl.attr("href") || "";
    }

    // Extract title
    if (titleSelector.type === "xpath") {
      const { css } = xpathToCss(titleSelector.value);
      const titleEl = $listEl.find(css);
      if (titleEl.length === 0) return;
      titleValue = titleEl.text().trim();
    } else if (titleSelector.type === "regex") {
      const match = safeRegexMatch($listEl.html() || "", titleSelector.value, "i");
      titleValue = match?.[1] || match?.[0] || "";
    } else {
      const titleEl = $listEl.find(titleSelector.value);
      if (titleEl.length === 0) return;
      titleValue = titleEl.text().trim();
    }

    const trimmedLink = linkValue.trim().toLowerCase();
    const isDangerous = trimmedLink.startsWith('javascript:') ||
      trimmedLink.startsWith('data:') ||
      trimmedLink.startsWith('blob:') ||
      trimmedLink.startsWith('vbscript:');
    const resolvedUrl = resolveUrl(baseUrl, linkValue);
    if (linkValue && !isDangerous && !seenUrls.has(resolvedUrl)) {
      seenUrls.add(resolvedUrl);
      results.push({
        title: titleValue,
        url: resolvedUrl,
      });
    }
  });

  return results;
}

// ==================== OG/JSON-LD Metadata Fallback ====================

/**
 * Extract book metadata from Open Graph tags, JSON-LD structured data,
 * and standard HTML meta tags as a fallback when primary selectors fail.
 *
 * Priority order: OG tags > JSON-LD > standard meta tags.
 *
 * @param html - Raw HTML string
 * @returns Partial metadata object with any fields found
 */
export function extractMetadataFallback(html: string): Partial<{
  title: string;
  author: string;
  description: string;
  cover: string;
  keywords: string;
  category: string;
  status: string;
}> {
  const $ = getCachedCheerio(html);
  const result: Record<string, string> = {};

  // Try Open Graph tags first
  const ogTitle = $('meta[property="og:title"]').attr('content');
  const ogDesc = $('meta[property="og:description"]').attr('content');
  const ogImage = $('meta[property="og:image"]').attr('content');
  const ogAuthor = $('meta[property="og:novel:author"]').attr('content') || $('meta[property="article:author"]').attr('content');
  const ogCategory = $('meta[property="og:novel:category"]').attr('content') || $('meta[property="article:section"]').attr('content');
  const ogStatus = $('meta[property="og:novel:status"]').attr('content');

  // Standard meta tags
  const metaAuthor = $('meta[name="author"]').attr('content');
  const metaDesc = $('meta[name="description"]').attr('content');
  const metaKeywords = $('meta[name="keywords"]').attr('content');

    // JSON-LD: collect ALL matching blocks and merge (later blocks override earlier fields)
  let jsonLdData: Record<string, unknown> | null = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).text());
      if (data['@type'] === 'Book' || data['@type'] === 'Article' || data['@type'] === 'CreativeWork') {
        if (!jsonLdData) {
          jsonLdData = data;
        } else {
          // Merge: later blocks fill in missing fields from earlier blocks
          Object.assign(jsonLdData, data);
        }
      }
    } catch { /* ignore */ }
  });

  // Build result with priority: OG > JSON-LD > standard meta
  if (ogTitle) result.title = ogTitle;
  else if (jsonLdData?.name) result.title = String(jsonLdData.name);
  else {
    const titleTag = $('title').first().text().trim();
    if (titleTag) result.title = titleTag;
  }

  if (ogAuthor) result.author = ogAuthor;
  else if (jsonLdData?.author) {
    if (typeof jsonLdData.author === 'string') {
      result.author = jsonLdData.author;
    } else {
      // Person object, array of Person objects, or array of strings
      const authors = Array.isArray(jsonLdData.author) ? jsonLdData.author : [jsonLdData.author];
      const names = authors.map((a: any) => typeof a === 'string' ? a : (a?.name || '')).filter(Boolean);
      if (names.length > 0) result.author = names.join(', ');
    }
  }
  else if (metaAuthor) result.author = metaAuthor;

  if (ogDesc) result.description = ogDesc;
  else if (jsonLdData?.description) result.description = String(jsonLdData.description);
  else if (metaDesc) result.description = metaDesc;

  if (ogImage) result.cover = ogImage;
  else if (jsonLdData?.image) {
    const img = jsonLdData.image;
    // JSON-LD image can be a string, an array of strings, or an ImageObject with .url
    if (typeof img === 'string') {
      result.cover = img;
    } else if (Array.isArray(img)) {
      const first = img[0];
      result.cover = typeof first === 'string' ? first : (first && typeof first === 'object' && 'url' in first) ? String(first.url) : '';
    } else if (img && typeof img === 'object' && 'url' in img) {
      result.cover = String(img.url);
    }
  }

  if (ogCategory) result.category = ogCategory;
  if (metaKeywords) result.keywords = metaKeywords;
  if (ogStatus) result.status = ogStatus;

  return result;
}

// ==================== Structured Data Primary Extraction ====================

/**
 * Extract structured data from a page as a PRIMARY source before CSS selectors.
 *
 * Many modern sites include rich structured data (JSON-LD, OpenGraph, microdata)
 * that provides cleaner, more reliable content than CSS selectors which can break
 * when site layouts change. This function extracts structured data first, then
 * falls back to CSS selectors for any missing fields.
 *
 * @param html - Raw HTML string
 * @returns Extracted content from structured data sources
 */
export function extractStructuredDataContent(html: string): {
  title: string;
  content: string;
  author: string;
  description: string;
  datePublished: string;
  dateModified: string;
  wordCount: number;
  source: 'jsonld' | 'microdata' | 'og' | 'none';
} {
  const $ = getCachedCheerio(html);
  const result: {
    title: string;
    content: string;
    author: string;
    description: string;
    datePublished: string;
    dateModified: string;
    wordCount: number;
    source: 'jsonld' | 'microdata' | 'og' | 'none';
  } = {
    title: '',
    content: '',
    author: '',
    description: '',
    datePublished: '',
    dateModified: '',
    wordCount: 0,
    source: 'none',
  };

  // 1. Try JSON-LD first (most structured, highest quality)
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).text());
      const types = Array.isArray(data['@type']) ? data['@type'] : [data['@type']];

      // Check for article/book types
      if (types.some((t: string) => ['Article', 'BlogPosting', 'NewsArticle', 'Book', 'Chapter', 'CreativeWork', 'WebPage'].includes(t))) {
        if (!result.title && data.name) {
          result.title = String(data.name);
          result.source = 'jsonld';
        }
        if (!result.content && data.articleBody) {
          result.content = String(data.articleBody);
          result.source = 'jsonld';
        }
        if (!result.content && data.text) {
          result.content = String(data.text);
          result.source = 'jsonld';
        }
        if (!result.author) {
          if (typeof data.author === 'string') {
            result.author = data.author;
          } else if (data.author?.name) {
            result.author = String(data.author.name);
          } else if (Array.isArray(data.author)) {
            result.author = data.author.map((a: any) => typeof a === 'string' ? a : (a?.name || '')).filter(Boolean).join(', ');
          }
        }
        if (!result.description && data.description) {
          result.description = String(data.description);
        }
        if (!result.datePublished && data.datePublished) {
          result.datePublished = String(data.datePublished);
        }
        if (!result.dateModified && data.dateModified) {
          result.dateModified = String(data.dateModified);
        }
        if (data.wordCount && typeof data.wordCount === 'number') {
          result.wordCount = data.wordCount;
        }
      }
    } catch { /* ignore invalid JSON-LD */ }
  });

  // 2. Try Microdata (itemscope/itemprop) if JSON-LD didn't provide content
  if (!result.content) {
    const articleEl = $('[itemtype*="Article"], [itemtype*="Book"], [itemtype*="CreativeWork"]').first();
    if (articleEl.length > 0) {
      if (!result.title) {
        const microTitle = articleEl.find('[itemprop="name"]').first().text().trim();
        if (microTitle) { result.title = microTitle; result.source = 'microdata'; }
      }
      if (!result.content) {
        const microBody = articleEl.find('[itemprop="articleBody"]').first().text().trim();
        if (microBody) { result.content = microBody; result.source = 'microdata'; }
      }
      if (!result.author) {
        const microAuthor = articleEl.find('[itemprop="author"]').first().text().trim();
        if (microAuthor) { result.author = microAuthor; }
      }
      if (!result.description) {
        const microDesc = articleEl.find('[itemprop="description"]').first().text().trim();
        if (microDesc) { result.description = microDesc; }
      }
    }
  }

  // 3. Try OpenGraph as fallback
  if (!result.title) {
    const ogTitle = $('meta[property="og:title"]').attr('content');
    if (ogTitle) { result.title = ogTitle; result.source = 'og'; }
  }
  if (!result.description) {
    const ogDesc = $('meta[property="og:description"]').attr('content');
    if (ogDesc) { result.description = ogDesc; result.source = 'og'; }
  }

  // Calculate word count if not provided by structured data
  if (result.wordCount === 0 && result.content) {
    // CJK characters count as 1 word each; Latin words split by space
    const cjkChars = (result.content.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g) || []).length;
    const latinWords = result.content.replace(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g, ' ')
      .split(/\s+/).filter(w => w.length > 0).length;
    result.wordCount = cjkChars + latinWords;
  }

  return result;
}

// ==================== Content Zone Detection ====================

/**
 * Detect the main content zone of an HTML page using text density analysis.
 *
 * Algorithm:
 *   1. Walk all block-level elements (div, section, article, main, etc.)
 *   2. For each, compute text density = (direct text length) / (total descendant HTML length)
 *   3. Score each element: text_density * text_length (favor both density AND volume)
 *   4. Return the highest-scoring element's CSS selector
 *
 * This is useful as a fallback when no known content selector matches.
 *
 * @param html - Raw HTML string
 * @returns The best content zone selector, or empty string if no good zone found
 */
export function detectContentZone(html: string): string {
  const $ = getCachedCheerio(html);

  // Block-level containers to analyze
  const containers = 'div, section, article, main, aside, td, li';
  let bestScore = 0;
  let bestSelector = '';

  // Track by element to avoid duplicates
  const scored = new Map<cheerio.Element, { score: number; selector: string }>();

  $(containers).each((index, el) => {
    const $el = $(el);
    const htmlStr = $el.html() || '';
    const textStr = $el.text().trim();

    // Skip tiny elements
    if (textStr.length < 200) return;
    // Skip nav/header/footer containers (likely not content)
    const tag = (el as cheerio.Element & { name: string }).name;
    const id = $el.attr('id') || '';
    const cls = $el.attr('class') || '';
    if (/nav|header|footer|sidebar|menu|comment|ad-/i.test(id + ' ' + cls)) return;
    if (tag === 'aside') return; // aside is rarely main content

    // Text density: ratio of text to HTML (higher = more text, less markup)
    const textDensity = htmlStr.length > 0 ? textStr.length / htmlStr.length : 0;

    // Link density: ratio of link text to total text (lower = less navigation)
    let linkTextLen = 0;
    $el.find('a').each((_, a) => { linkTextLen += $(a).text().trim().length; });
    const linkDensity = textStr.length > 0 ? linkTextLen / textStr.length : 0;

    // Paragraph density: number of <p> tags relative to text length
    const pCount = $el.find('p').length;
    const pDensity = textStr.length > 0 ? pCount / (textStr.length / 500) : 0;

    // Combined score:
    //   - Text density: 0-1, higher is better
    //   - Link penalty: links reduce score (navigation-heavy = not content)
    //   - Size bonus: longer text gets a logarithmic bonus
    //   - Paragraph bonus: presence of <p> tags indicates content structure
    const sizeBonus = Math.log2(Math.max(1, textStr.length)) / 10;
    const linkPenalty = Math.max(0, 1 - linkDensity * 2);
    const pBonus = Math.min(1, pDensity * 0.3);
    const score = textDensity * textStr.length * linkPenalty * (1 + sizeBonus) * (1 + pBonus);

    // Build a CSS selector for this element
    let selector = tag;
    if (id) {
      selector = '#' + id;
    } else if (cls) {
      // Use the first class that doesn't look generic
      const firstClass = cls.split(/\s+/).find(c =>
        c.length > 2 && !/^(row|col|container|wrapper|flex|grid|item|box)$/i.test(c)
      );
      if (firstClass) selector = tag + '.' + firstClass;
    }

    scored.set(el, { score, selector });
  });

  // Find the best scoring element
  for (const [, entry] of scored) {
    if (entry.score > bestScore) {
      bestScore = entry.score;
      bestSelector = entry.selector;
    }
  }

  // Only return if score is above a minimum threshold
  // (below this, the detection is too unreliable)
  if (bestScore > 100) {
    return bestSelector;
  }
  return '';
}

/**
 * Detect chapter boundaries in paginated content.
 * Some novel sites split a single chapter across multiple pages with
 * "下一页" (next page) links. This function detects such patterns.
 *
 * @param html - Raw HTML string
 * @returns Info about the detected chapter boundary, or null if not paginated
 */
export function detectChapterBoundary(html: string): {
  isPaginated: boolean;
  nextPageUrl: string;
  currentPage: number;
  totalPages: number;
} | null {
  const $ = getCachedCheerio(html);

  // Common pagination patterns for Chinese novel sites
  const nextPatterns = [
    'a:contains("下一页")',
    'a:contains("下页")',
    'a:contains("下一部分")',
    'a:contains("Next")',
    '.next a',
    '#next a',
    'a.next',
    'a[rel="next"]',
    '.pagination .next a',
    '.pager .next a',
  ];

  for (const pattern of nextPatterns) {
    try {
      const nextLink = $(pattern).first();
      const href = nextLink.attr('href');
      if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
        // Try to detect current page from pagination
        let currentPage = 1;
        let totalPages = 1;

        // Check for page indicators like "1/3" or "第1页/共3页"
        const pageText = $.text();
        const pageMatch = pageText.match(/(?:第?(\d+)\s*[\/|]\s*共?(\d+)\s*页|(\d+)\s*[\/|]\s*(\d+))/);
        if (pageMatch) {
          currentPage = parseInt(pageMatch[1] || pageMatch[3] || '1', 10);
          totalPages = parseInt(pageMatch[2] || pageMatch[4] || '1', 10);
        }

        return {
          isPaginated: true,
          nextPageUrl: href,
          currentPage,
          totalPages,
        };
      }
    } catch {
      // Invalid selector, skip
    }
  }

  return null;
}

