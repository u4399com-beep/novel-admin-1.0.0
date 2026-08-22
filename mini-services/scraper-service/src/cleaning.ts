/**
 * Content Cleaning Module
 * Removes ads, normalizes whitespace, cleans HTML for novel content.
 * Enhanced with: regex caching, paragraph dedup, more watermark patterns,
 * content pagination artifacts, and smarter remnant detection.
 */

import * as cheerio from "cheerio";
import type { CleanRequest } from "./types";
import { safeRegexReplace } from "./regex-safety";

// ==================== Default Ad Patterns ====================

const DEFAULT_AD_PATTERNS = [
  // General ads
  "推广", "广告", "下载APP", "下载app",
  // Social / follow prompts
  "关注公众号", "关注我们", "扫码关注", "微信扫码", "微信公众号",
  // Watermarks / site branding
  "永久网址", "最新网址", "记住网址", "本站最新", "本站永久",
  "首发域名", "记住本站域名", "请牢记", "请收藏",
  "本站网址", "无弹窗小说", "无弹窗阅读",
  "最快更新", "最新章节请", "最快更新速度",
  "章节末尾", "本章未完", "请记住",
  // Download prompts
  "TXT下载", "下载地址", "下载本", "全本下载", "txt下载",
  "手机下载", "APP下载", "下载app",
  // Bookmark prompts
  "加入书签", "添加书签", "收藏本页", "收藏本站",
  // Navigation remnants
  "返回目录", "上一页", "下一页", "章节列表",
  // Online reading prompts
  "在线听书", "手机版阅读", "手机用户请",
  "如果您喜欢", "阅读请到",
  // Common novel site watermarks
  "笔趣阁", "biquge", "BIQUGE",
  "天才一秒记住", "一秒记住",
  // Site recommendations
  "推荐本书", "本章说", "本章评论",
  // Donation/promotion
  "打赏", "投推荐票", "月票",
  // Original patterns preserved
  "最新章节", "百度搜索", "记住本站",
  "本章最新章节", "请访问", "天才一秒",
  // Standalone short ad fragments (catched individually)
  "无弹窗",
  // Additional patterns for broader coverage
  "请到", "请看", "请浏览", "继续阅读",
  "温馨提示", "热点推荐", "热门推荐",
  "用户上传", "本章由", "更多章节",
  "报错", "举报", "加入书架",
  "追书", "追更", "书友",
  "顶点小说", "小说XYZ", "小说大全",
  "全文阅读", "免费阅读", "在线阅读",
];

const AD_CSS_SELECTORS = [
  '[class*="ad"]', '[class*="Ad"]', '[class*="AD"]',
  '[class*="advert"]', '[class*="sponsor"]', '[class*="promo"]',
  '[class*="banner"]', '[class*="popup"]', '[class*="modal"]',
  '[class*="recommend"]', '[class*="tuijian"]', '[class*="guanggao"]',
  '[id*="ad"]', '[id*="Ad"]', '[id*="AD"]',
  '[id*="advert"]', '[id*="sponsor"]', '[id*="promo"]',
  '[id*="banner"]', '[id*="popup"]', '[id*="guanggao"]',
  '[class*="share"]', '[class*="social"]',
  '[id*="share"]', '[id*="social"]',
  // Additional common ad containers
  '[class*="fixed-ad"]', '[class*="float-ad"]',
  '[class*="google-ad"]', '[class*="taboola"]',
  '[class*="outbrain"]', '[class*="cookie"]',
  '[class*="newsletter"]', '[class*="subscribe"]',
];

/** Escape special regex characters */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Escape special characters for safe embedding in CSS attribute selectors.
 * Handles: backslash, double-quote, brackets, and attribute-selector-breaking chars. */
function escapeCssString(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'")
    .replace(/\]/g, "\\]")
    .replace(/\[/g, "\\[")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

/**
 * Normalize patterns to string[] — supports both string (newline-separated) and array inputs.
 * This handles the case where the frontend sends patterns as a newline-separated string
 * or the database stores them as a JSON array.
 */
function normalizePatterns(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((p): p is string => typeof p === 'string');
  if (typeof value === 'string') return value.split('\n').map(s => s.trim()).filter(Boolean);
  return [];
}

/**
 * Clean HTML content: remove ads, scripts, normalize whitespace.
 */
const WATERMARK_PATTERNS = [
  // URL watermarks like 【www.example.com】
  /[\[\u3010【]www\.[\w.-]+\.[\w]{2,}[\]\u3011】]/gi,
  // Site watermarks like --本章未完，点击下一页继续阅读--
  /[-—]{2,}.*?(下一页|继续阅读|未完待续).*?[-—]{2,}/gi,
  // Floating ad text like (www.xxx.com) or (www.xxx.anything)
  /[\uff08(]\s*(?:https?:\/\/)?www\.[\w.-]+[\w\/][\uff09)]/gi,
  // "最新章节请访问xxx" type
  /最新章节请访问[^\n]{3,80}/gi,
  // "手机用户请浏览xxx阅读" type
  /手机用户请浏览[^\n]{3,80}(?:阅读|体验)/gi,
  // Bare URL lines (www.xxx.anything or https://xxx)
  /^\s*(?:https?:\/\/)?www\.[\w.-]+\.\w{2,}\s*$/gm,
  // Chapter-end boilerplate: 本章完 / 本章结束
  /^\s*本章[完结束]\s*$/gm,
  // "xxx.com 最新章节" pattern (site URL + ad text on same line)
  /www\.[\w.-]+\.\w{2,}[^\n]{0,30}(?:最新|更新|章节|阅读|小说|无弹窗)/gi,
  // "笔趣阁 xxx 最新更新" type
  /笔趣阁[^\n]{0,50}(?:更新|最新|最快)/gi,
  // "天才一秒记住xxx" full line
  /天才一秒记住[^\n]{3,80}/gi,
  // "无弹窗小说 xxx" type
  /无弹窗小说[^\n]{0,50}/gi,
  // "最快更新速度" full line
  /最快更新速度[^\n]{0,50}/gi,
  // "推荐本书给好友" full line
  /^\s*推荐本书[^\n]*$/gm,
  // "打赏作者" full line
  /^\s*打赏[^\n]*$/gm,
  // "投推荐票" full line
  /^\s*投推荐票[^\n]*$/gm,
  // "扫码关注" full line
  /^\s*扫码关注[^\n]*$/gm,
  // "微信" ad lines (short lines mentioning wechat)
  /^\s*微信[^\n]{0,20}$/gm,
  // Single-word or very short non-content lines (likely remnants)
  /^\s*[，,。.！!？?、；;：:]+\s*$/gm,
  // ==================== NEW: Additional watermark patterns ====================
  // IP address watermarks: 【23.225.66.244】
  /[\[\u3010【](?:\d{1,3}\.){3}\d{1,3}[\]\u3011】]/g,
  // "http(s)://domain.xxx" standalone URL lines
  /^\s*https?:\/\/[^\s]+\s*$/gm,
  // Content page divider: "---分页符---" or "=======" etc
  /^\s*[-=]{5,}\s*$/gm,
  // "第X页/共Y页" page indicators
  /^\s*第\d+页\s*\/\s*共\d+页\s*$/gm,
  // "page X of Y" English page indicators
  /^\s*page\s+\d+\s+of\s+\d+\s*$/gim,
  // "本章未完，点击下一页" single line variant
  /^\s*本章未完[^\n]*$/gm,
  // "XXX手机版" or "XXX手机端" branding lines
  /^\s*[^\n]{2,20}手机(?:版|端)\s*$/gm,
  // Copyright / legal boilerplate
  /(?:copyright|版权所有|所有权利保留|all rights reserved)/gi,
  // "更新时间" or "update time" lines (usually metadata)
  /^\s*(?:更新时间|最后更新|update\s*time)[:：]?\s*[^\n]{0,50}$/gim,
  // "本章来源于xxx" type source attribution
  /本章来源于[^\n]{3,60}/gi,
  // "首发于xxx" / "首发网站xxx"
  /首发(?:于|网站|域名)[^\n]{3,60}/gi,
  // "请记住xxx" / "记住xxx" standalone reminder lines
   /^\s*请记住[^\n]{0,50}$/gm,
  // "XXX小说" branding lines (very short, likely ads)
   /^\s*[\w.]+小说[^\n]{0,10}$/gm,
  // "XXX阅读" branding lines
  /^\s*[\w.]+阅读[^\n]{0,10}$/gm,
  // Image alt-text only lines (e.g. "[图片]" or empty img artifacts)
  /^\s*\[?图片\]?\s*$/gm,
  /^\s*\[?img\]?\s*$/gim,
  // "本章正在手打中" type status lines (use [^\n] to prevent cross-line matching)
  /^\s*本章正在[^\n]{0,30}$/gm,
  // "手机端阅读" short branding lines
  /^\s*手机端[^\n]{0,20}$/gm,
  // "XXX阅读网" generic site branding
  /^[\w.]+阅读网[^\n]{0,20}$/gm,
  // "最新章节地址xxx" full line
  /最新章节地址[^\n]{0,60}/gi,
  // "请牢记xxx" standalone reminder lines
  /^\s*请牢记[^\n]{0,50}$/gm,
  // "首发于" standalone lines
  /^\s*首发于[^\n]{0,40}$/gm,
  // Single character repeated 3+ times (e.g. "......", "---", "===")
  /^\s*(.)\1{2,}\s*$/gm,
  // "正在手打中" / "手打全文" type lines
  /^\s*正在手打[^\n]{0,20}$/gm,
  /^\s*手机端.*?阅读[^\n]{0,20}$/gm,
  // "最新网址xxx" / "最新地址xxx" site URL announcements
   /(?:最新网址|最新地址|记住网址|记住本站)[^\n]{0,60}/gi,
  // Empty or near-empty paragraph markers (single char or very short)
  /^\s*[。.！!？?~～…—-]{1,3}\s*$/gm,
];

/**
 * Apply watermark regex patterns to text.
 * Uses pre-compiled regexes for better performance (avoids re-compilation per call).
 */
const COMPILED_WATERMARK = WATERMARK_PATTERNS.map(
  (p) => new RegExp(p.source, p.flags)
);

function applyWatermarkPatterns(text: string): string {
  for (const regex of COMPILED_WATERMARK) {
    text = text.replace(regex, "");
  }
  return text;
}

/**
 * Shared HTML-level cleaning logic (remove scripts, styles, ads, CSS-selector-based removal).
 * Used by both cleanHtml (returns text) and cleanHtmlRaw (returns HTML).
 */
function applyHtmlLevelCleaning($: cheerio.CheerioAPI, config: CleanRequest["config"]): void {
  // Remove script, style, iframe, noscript tags
  $("script, style, iframe, noscript, object, embed, applet").remove();

  // Strip event handler attributes from remaining elements
  $("*").each((_, el) => {
    const attribs = Object.keys(el.attribs);
    for (const attr of attribs) {
      if (attr.startsWith("on")) {
        delete el.attribs[attr];
      }
      // Sanitize href/src to remove javascript: URIs
      if ((attr === "href" || attr === "src") && typeof el.attribs[attr] === "string") {
        if (el.attribs[attr].trim().toLowerCase().startsWith("javascript:")) {
          delete el.attribs[attr];
        }
      }
    }
  });

  const adPatterns = normalizePatterns(config.adPatterns);
  const removeSelectors = normalizePatterns(config.removeSelectors);
  const removePatterns = normalizePatterns(config.removePatterns);

  // Remove ad elements if removeAds is true (default)
  if (config.removeAds !== false) {
    const allAdSelectors = [...AD_CSS_SELECTORS];
    if (adPatterns.length > 0) {
      allAdSelectors.push(
        ...adPatterns
          .filter((p) => !p.includes(",") && !p.includes("{") && !p.includes("}"))
          .flatMap((p) => [
            `[class*="${escapeCssString(p)}"]`,
            `[id*="${escapeCssString(p)}"]`,
          ])
      );
    }
    $(allAdSelectors.join(", ")).remove();
  }

  // Remove user-specified CSS selectors (explicit, guaranteed to be selectors)
  if (removeSelectors.length > 0) {
    for (const selector of removeSelectors) {
      try {
        $(selector).remove();
      } catch {
        // Invalid CSS selector — skip
      }
    }
  }

  // Note: removePatterns serve dual purpose:
  // 1. As CSS selectors for element removal (first pass)
  // 2. As regex patterns for text matching (second pass)
  // Patterns that are valid regex but not valid CSS will silently skip the CSS pass.
  // For clarity, use removeSelectors for pure CSS selectors.
  if (removePatterns.length > 0) {
    for (const pattern of removePatterns) {
      try {
        $(pattern).remove();
      } catch {
        // Pattern is not a valid CSS selector — will be used as regex in text pass
      }
    }
  }
}

// ==================== Regex Cache for filterAdLines ====================

/**
 * LRU-style cache for compiled ad pattern regexes.
 * Prevents re-compiling the same regex for every line of every chapter.
 * Key: pattern string, Value: { regex, lowerPattern }
 */
const adRegexCache = new Map<string, { regex: RegExp; lowerPattern: string }>();
const AD_REGEX_CACHE_MAX = 200;

function getAdRegex(pattern: string): { regex: RegExp; lowerPattern: string } {
  const cached = adRegexCache.get(pattern);
  if (cached) return cached;

  const escaped = escapeRegExp(pattern);
  const regex = new RegExp(escaped, "gi");
  const lowerPattern = pattern.toLowerCase();
  const entry = { regex, lowerPattern };

  // Evict oldest entries if cache is full
  if (adRegexCache.size >= AD_REGEX_CACHE_MAX) {
    const firstKey = adRegexCache.keys().next().value;
    if (firstKey !== undefined) adRegexCache.delete(firstKey);
  }

  adRegexCache.set(pattern, entry);
  return entry;
}

/**
 * Clean HTML content: remove ads, normalize whitespace, cleans HTML for novel content.
 */
export function cleanHtml(html: string, config: CleanRequest["config"]): string {
  const $ = cheerio.load(html);

  applyHtmlLevelCleaning($, config);

  // Get text content
  let text = $.text();

  // Build combined ad pattern list
  const adPatterns = normalizePatterns(config.adPatterns);
  const allAdPatterns = [...DEFAULT_AD_PATTERNS];
  if (adPatterns.length > 0) {
    allAdPatterns.push(...adPatterns);
  }
  const removePatterns = normalizePatterns(config.removePatterns);

  // Step 1: Apply watermark regex patterns first (removes URLs, full-line ads)
  text = applyWatermarkPatterns(text);

  // Step 2: Remove custom text/regex patterns
  if (removePatterns.length > 0) {
    for (const pattern of removePatterns) {
      text = safeRegexReplace(text, pattern, "", "gi");
    }
  }

  // Step 3: Aggressive line-by-line ad filtering
  text = filterAdLines(text, allAdPatterns);

  // Step 4: Remove short remnant lines (punctuation-only, single chars, etc.)
  text = removeRemnantLines(text);

  // Step 5: Remove consecutive duplicate paragraphs (common with multi-page merge)
  text = deduplicateParagraphs(text);

  // Step 6: Normalize whitespace
  text = normalizeWhitespace(text);

  return text;
}

/**
 * Clean HTML and return the cleaned HTML string (not extracted text).
 * Used when we need to clean HTML first, then extract text via selectors.
 */
export function cleanHtmlRaw(html: string, config: CleanRequest["config"]): string {
  const $ = cheerio.load(html);

  applyHtmlLevelCleaning($, config);

  // Return cleaned HTML instead of extracted text
  return $.html() || "";
}

/**
 * Clean plain text content (no HTML parsing).
 * Used when content has already been extracted from HTML.
 */
export function cleanText(text: string, config: CleanRequest["config"]): string {
  const adPatterns = normalizePatterns(config.adPatterns);
  const allAdPatterns = [...DEFAULT_AD_PATTERNS];
  if (adPatterns.length > 0) {
    allAdPatterns.push(...adPatterns);
  }
  const removePatterns = normalizePatterns(config.removePatterns);

  // Step 1: Apply watermark regex patterns first
  text = applyWatermarkPatterns(text);

  // Step 2: Remove custom text/regex patterns
  if (removePatterns.length > 0) {
    for (const pattern of removePatterns) {
      text = safeRegexReplace(text, pattern, "", "gi");
    }
  }

  // Step 3: Aggressive line-by-line ad filtering
  text = filterAdLines(text, allAdPatterns);

  // Step 4: Remove short remnant lines
  text = removeRemnantLines(text);

  // Step 5: Remove consecutive duplicate paragraphs (important for multi-page content)
  text = deduplicateParagraphs(text);

  // Step 6: Normalize whitespace
  text = normalizeWhitespace(text);

  return text;
}

// ==================== Helper Functions ====================

/**
 * Aggressively filter ad lines.
 * For each line, ALL ad patterns are checked at once (not one-by-one).
 * After removing all matches, if the remaining text is < 20 chars, drop the line.
 * This prevents cases where removing one ad pattern leaves other ad text.
 *
 * Performance: Uses a regex cache to avoid re-compiling patterns per line.
 */
function filterAdLines(text: string, patterns: string[]): string {
  if (patterns.length === 0) return text;

  // Pre-compile all patterns
  const compiled = patterns.map(getAdRegex);

  const lines = text.split("\n");
  return lines
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true; // Keep empty lines (will be collapsed later)

      // Check if any pattern matches
      let hasMatch = false;
      let remaining = trimmed;
      const lowerRemaining = trimmed.toLowerCase();

      for (const { regex, lowerPattern } of compiled) {
        if (lowerRemaining.includes(lowerPattern)) {
          hasMatch = true;
          // Remove the matched portion
          remaining = remaining.replace(regex, "").trim();
        }
      }

      if (!hasMatch) return true; // No ad pattern found, keep the line

      // After removing ALL ad patterns, check if significant content remains
      // Lines with < 20 remaining chars are likely ad-only lines
      if (remaining.length < 20) return false;

      // Additional check: if the remaining text is mostly punctuation/spaces
      const contentChars = remaining.replace(/[\s，,。.！!？?、；;：:\-—_\[\]【】()（）\d]/g, "");
      if (contentChars.length < 10) return false;

      return true;
    })
    .join("\n");
}

/**
 * Remove consecutive duplicate paragraphs.
 * When content is merged from multiple pages, the last paragraph of page N
 * often duplicates the first paragraph of page N+1.
 * Also handles near-duplicates (differ only in trailing punctuation).
 */
function deduplicateParagraphs(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let lastNormalized = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      result.push(line);
      continue;
    }

    // Normalize for comparison: strip trailing punctuation, collapse whitespace
    const normalized = trimmed
      .replace(/[，,。.！!？?、；;：:]+$/, "")
      .replace(/\s+/g, " ")
      .trim();

    if (normalized && normalized === lastNormalized) {
      // Skip this line — it's a duplicate of the previous paragraph
      continue;
    }

    // Check near-duplicate: if the current line starts with the end of the previous line
    // (common when pages split mid-paragraph)
    // Use longer overlap threshold (25 chars) and require the overlap to be a significant
    // portion of the shorter line (>30%) to avoid false merges on common phrases.
    if (lastNormalized.length > 20 && normalized.length > 20) {
      const overlapLen = Math.min(lastNormalized.length, normalized.length);
      const checkLen = Math.min(25, overlapLen);
      const shorterLen = Math.min(lastNormalized.length, normalized.length);
      if (
        checkLen >= 15 &&
        checkLen / shorterLen > 0.3 &&
        lastNormalized.slice(-checkLen) === normalized.slice(0, checkLen)
      ) {
        // This is a continuation — merge with previous line instead of dedup
        // Remove the last result entry and append this line
        const prev = result.pop() || "";
        result.push(prev + trimmed);
        lastNormalized = (prev + trimmed)
          .replace(/[，,。.！!？?、；;：:]+$/, "")
          .replace(/\s+/g, " ")
          .trim();
        continue;
      }
    }

    result.push(line);
    lastNormalized = normalized;
  }

  return result.join("\n");
}

/**
 * Remove short remnant lines that are likely ad/punctuation artifacts.
 * Keeps lines that have meaningful Chinese content (>= 4 Chinese characters).
 */
function removeRemnantLines(text: string): string {
  const lines = text.split("\n");
  return lines
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;

      // Count Chinese characters (incl. CJK Unified Ideographs, Extension A, Compatibility Ideographs)
      const chineseChars = (trimmed.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;

      // Short lines (< 5 chars) with no Chinese content are remnant
      if (trimmed.length < 5 && chineseChars === 0) return false;

      // Lines that are only punctuation + whitespace
      if (chineseChars === 0 && trimmed.length < 8) return false;

      // Lines that are only digits (page numbers, IDs, etc.)
      if (/^\d+$/.test(trimmed) && trimmed.length < 10) return false;

      return true;
    })
    .join("\n");
}

/**
 * Normalize whitespace: collapse spaces, trim lines, collapse newlines.
 */
function normalizeWhitespace(text: string): string {
  // Strip zero-width characters (common anti-scraping / steganography artifacts)
  // U+200B ZWSP, U+200C ZWNJ, U+200D ZWJ, U+FEFF BOM/ZWNBSP,
  // U+00AD soft hyphen, U+2060 word joiner, U+2061-2064 invisible math,
  // U+180E Mongolian vowel separator, U+034F combining grapheme joiner
  // U+200E LRM (Left-to-Right Mark), U+200F RLM (Right-to-Left Mark)
  // U+2028 Line Separator, U+2029 Paragraph Separator
  // U+2066-2069 Isolate controls (Bidi)
  text = text.replace(/[\u200B\u200C\u200D\u200E\u200F\u2028\u2029\uFEFF\u00AD\u2060\u2061\u2062\u2063\u2064\u2066\u2067\u2068\u2069\u180E\u034F]/g, '');
  // Strip general Cc control characters (U+0000-U+001F) except TAB(0x09), LF(0x0A), CR(0x0D)
  // Also strip Cf format characters (U+200B-F already above, but catch remaining like U+FFF9-FFFB)
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  text = text.replace(/[\uFFF9\uFFFA\uFFFB]/g, '');
  // Normalize CJK ideographic space (U+3000) to regular space
  text = text.replace(/\u3000/g, ' ');
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")  // Standalone CR (old Mac line endings)
    .replace(/\t+/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Handle a clean request.
 */
export function handleClean(body: CleanRequest) {
  const { html, config } = body;
  const content = cleanHtml(html, config);
  return {
    content,
    wordCount: content.length,
  };
}