/**
 * Content Cleaning Module
 * Removes ads, normalizes whitespace, cleans HTML for novel content.
 */

import * as cheerio from "cheerio";
import type { CleanRequest } from "./types";
import { safeRegexReplace } from "./regex-safety";

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

/** Escape special characters for safe embedding in CSS attribute selectors */
function escapeCssString(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\]/g, "\\]")
    .replace(/\[/g, "\\[")
    .replace(/\(/g, "\\(");
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
export function cleanHtml(html: string, config: CleanRequest["config"]): string {
  const $ = cheerio.load(html);

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

  // Remove ad elements if removeAds is true (default)
  if (config.removeAds !== false) {
    const allAdSelectors = [...AD_CSS_SELECTORS];
    if (adPatterns.length > 0) {
      allAdSelectors.push(...adPatterns.map((p) => `[class*="${escapeCssString(p)}"], [id*="${escapeCssString(p)}"]`).filter(s => !s.includes(",") && !s.includes("{") && !s.includes("}")) );
    }
    $(allAdSelectors.join(", ")).remove();
  }

  // Note: removePatterns serve dual purpose:
  // 1. As CSS selectors for element removal (first pass)
  // 2. As regex patterns for text matching (second pass)
  // Patterns that are valid regex but not valid CSS will silently skip the CSS pass.
  const removePatterns = normalizePatterns(config.removePatterns);
  if (removePatterns.length > 0) {
    for (const pattern of removePatterns) {
      try {
        $(pattern).remove();
      } catch (err) {
        // Pattern is not a valid CSS selector — will be used as regex in text pass
        console.warn(`[Cleaning] Pattern "${pattern}" is not a valid CSS selector, skipping CSS removal`);
      }
    }
  }

  // Get text content
  let text = $.text();

  // Remove ad text patterns (line-by-line filtering)
  const allAdPatterns = [...DEFAULT_AD_PATTERNS];
  if (adPatterns.length > 0) {
    allAdPatterns.push(...adPatterns);
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

  // Remove custom text/regex patterns (second pass — used as regex for text matching)
  if (removePatterns.length > 0) {
    for (const pattern of removePatterns) {
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
 * Clean plain text content (no HTML parsing).
 * Used when content has already been extracted from HTML.
 */
export function cleanText(text: string, config: CleanRequest["config"]): string {
  const adPatterns = normalizePatterns(config.adPatterns);
  const allAdPatterns = [...DEFAULT_AD_PATTERNS];
  if (adPatterns.length > 0) {
    allAdPatterns.push(...adPatterns);
  }

  // Remove ad text patterns (line-by-line filtering)
  for (const pattern of allAdPatterns) {
    const lines = text.split("\n");
    text = lines
      .filter((line) => {
        if (!line.includes(pattern)) return true;
        const stripped = line.replace(new RegExp(escapeRegExp(pattern), "gi"), "").trim();
        return stripped.length >= 10;
      })
      .join("\n");
  }

  // Remove custom text/regex patterns
  const removePatterns = normalizePatterns(config.removePatterns);
  if (removePatterns.length > 0) {
    for (const pattern of removePatterns) {
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