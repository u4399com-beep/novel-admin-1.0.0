/**
 * Content Cleaning Module
 * Removes ads, normalizes whitespace, cleans HTML for novel content.
 */

import * as cheerio from "cheerio";
import type { CleanRequest } from "./types";

// ==================== Default Ad Patterns ====================

const DEFAULT_AD_PATTERNS = [
  "推广", "广告", "下载APP", "下载app",
  "关注公众号", "关注我们", "扫码关注", "微信扫码", "微信公众号",
  "加入书签", "添加书签", "收藏本站",
  "本章未完", "请记住", "手机版阅读",
  "最新章节", "百度搜索", "本站网址", "请牢记",
  "天才一秒记住", "记住本站", "阅读请到", "如果您喜欢",
  "本章最新章节", "请访问", "天才一秒", "记住网址",
  "手机用户请浏览", "最新网址", "笔趣阁",
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
];

/** Escape special regex characters */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Safely create and execute a regex from user-provided pattern.
 * Blocks patterns with catastrophic backtracking potential (ReDoS protection).
 */
function safeRegexReplace(text: string, pattern: string, replacement: string, flags: string): string {
  // Block dangerous patterns with nested quantifiers
  const dangerousPatterns = [
    /\(\.[\*\+]\)\{/,
    /\([^)]*\{[\d,]+\}[^)]*\)\{/,
    /\(\[[^\]]*\]\+?\)\{/,
    /(\.\+|\.\*)\1/,
    /\([^)]*\+[^)]*\)\+/,       // (x+)+
    /\([^)]*\*[^)]*\)\*/,       // (x*)*
    /(\+|\*)\1/,                 // ++ or **
  ];
  for (const dp of dangerousPatterns) {
    if (dp.test(pattern)) {
      console.warn(`[Cleaning] Blocked dangerous regex pattern: ${pattern.substring(0, 100)}`);
      return text;
    }
  }

  // Limit text size for regex operations
  const MAX_TEXT_LENGTH = 500000;
  const searchIn = text.length > MAX_TEXT_LENGTH ? text.substring(0, MAX_TEXT_LENGTH) : text;

  try {
    return searchIn.replace(new RegExp(pattern, flags), replacement);
  } catch {
    return text;
  }
}

/** Escape special characters for safe embedding in CSS attribute selectors */
function escapeCssString(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\]/g, "\\]");
}

/**
 * Clean HTML content: remove ads, scripts, normalize whitespace.
 */
export function cleanHtml(html: string, config: CleanRequest["config"]): string {
  const $ = cheerio.load(html);

  // Remove script, style, iframe, noscript tags
  $("script, style, iframe, noscript, object, embed, applet").remove();

  // Remove ad elements if removeAds is true (default)
  if (config.removeAds !== false) {
    const allAdSelectors = [...AD_CSS_SELECTORS];
    if (config.adPatterns && config.adPatterns.length > 0) {
      allAdSelectors.push(...config.adPatterns.map((p) => `[class*="${escapeCssString(p)}"], [id*="${escapeCssString(p)}"]`));
    }
    $(allAdSelectors.join(", ")).remove();
  }

  // Remove elements matching custom CSS patterns
  if (config.removePatterns && config.removePatterns.length > 0) {
    for (const pattern of config.removePatterns) {
      try {
        $(pattern).remove();
      } catch {
        // Invalid CSS selector, skip
      }
    }
  }

  // Get text content
  let text = $.text();

  // Remove ad text patterns (line-by-line filtering)
  const allAdPatterns = [...DEFAULT_AD_PATTERNS];
  if (config.adPatterns && config.adPatterns.length > 0) {
    allAdPatterns.push(...config.adPatterns);
  }

  for (const pattern of allAdPatterns) {
    const lines = text.split("\n");
    text = lines
      .filter((line) => {
        if (!line.includes(pattern)) return true;
        // Line contains ad pattern — check if it's a standalone ad line
        const stripped = line.replace(new RegExp(escapeRegExp(pattern), "gi"), "").trim();
        return stripped.length >= 10; // Keep lines with significant content
      })
      .join("\n");
  }

  // Remove custom text patterns (with ReDoS protection)
  if (config.removePatterns && config.removePatterns.length > 0) {
    for (const pattern of config.removePatterns) {
      text = safeRegexReplace(text, pattern, "", "gi");
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