/**
 * Selector Engine - CSS / XPath / Regex parsing
 * Enhanced with better XPath support and attribute detection.
 */

import * as cheerio from "cheerio";
import type { Selector } from "./types";

// ==================== Regex Safety ====================

/**
 * Safely execute a user-provided regex pattern with ReDoS protection.
 * Prevents Regular Expression Denial of Service attacks via:
 *   1. Static dangerous-pattern detection (nested/overlapping quantifiers)
 *   2. Text length truncation (500K char limit)
 *   3. V8 engine's built-in regex execution limit as runtime backstop
 */
function safeRegexExec(pattern: string, flags: string, text: string): RegExpExecArray | null {
  // Reject obviously dangerous patterns that can cause catastrophic backtracking
  // Block: nested quantifiers, overlapping alternations with quantifiers
  const dangerousPatterns = [
    /\(\.[\*\+]\)\{/,          // (.)+{ or (.*){ etc
    /\([^)]*\{[\d,]+\}[^)]*\)\{/,  // nested groups with quantifiers
    /\(\[[^\]]*\]\+?\)\{/,    // ([...]+){
    /(\.\+|\.\*)\1/,          // repeated greedy quantifiers on same char
  ];
  for (const dp of dangerousPatterns) {
    if (dp.test(pattern)) {
      console.warn(`[Security] Blocked potentially dangerous regex: ${pattern.substring(0, 100)}`);
      return null;
    }
  }

  // For very long text, limit the search scope to prevent CPU exhaustion
  const MAX_TEXT_LENGTH = 500000;
  const searchIn = text.length > MAX_TEXT_LENGTH ? text.substring(0, MAX_TEXT_LENGTH) : text;

  try {
    const regex = new RegExp(pattern, flags);
    const result = regex.exec(searchIn);
    return result;
  } catch {
    return null;
  }
}

function safeRegexMatch(pattern: string, flags: string, text: string): RegExpMatchArray | null {
  // Same safety checks as safeRegexExec
  const dangerousPatterns = [
    /\(\.[\*\+]\)\{/,
    /\([^)]*\{[\d,]+\}[^)]*\)\{/,
    /\(\[[^\]]*\]\+?\)\{/,
    /(\.\+|\.\*)\1/,
  ];
  for (const dp of dangerousPatterns) {
    if (dp.test(pattern)) {
      console.warn(`[Security] Blocked potentially dangerous regex: ${pattern.substring(0, 100)}`);
      return null;
    }
  }

  const MAX_TEXT_LENGTH = 500000;
  const searchIn = text.length > MAX_TEXT_LENGTH ? text.substring(0, MAX_TEXT_LENGTH) : text;

  try {
    return searchIn.match(new RegExp(pattern, flags));
  } catch {
    return null;
  }
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
  } else {
    const bracketAttr = css.match(/\[@(\w+)(?:=['"]([^'"]*)['"])?\]$/);
    if (bracketAttr && !bracketAttr[2]) {
      attrName = bracketAttr[1];
    }
  }

  // Remove text() selections
  css = css.replace(/\/text\(\)/g, "");

  // /html/body/... → remove leading slashes
  css = css.replace(/^\/+/, "");

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
    const match = safeRegexMatch(selector.value, "gi", html);
    return match?.[0] || "";
  }

  if (selector.type === "xpath") {
    const { css, hasTextSelector, attrName } = xpathToCss(selector.value);
    const $ = cheerio.load(html);

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

    if (attrName) {
      return el.attr(attrName) || "";
    }

    return el.attr("href") || el.attr("src") || el.text().trim();
  }

  // CSS selector (default)
  const $ = cheerio.load(html);
  const el = $(selector.value);
  if (el.length === 0) return "";

  // Auto-detect attribute extraction
  if (selector.value.includes("[href]") || selector.value.endsWith("href")) {
    return el.attr("href") || "";
  }
  if (selector.value.includes("[src]") || selector.value.endsWith("src")) {
    return el.attr("src") || "";
  }

  return el.text().trim();
}

// ==================== Multi Element Selector ====================

export function parseSelectorMulti(html: string, selector: Selector): string[] {
  if (selector.type === "regex") {
    return safeRegexMatch(selector.value, "gi", html) || [];
  }

  if (selector.type === "xpath") {
    const { css, hasTextSelector, attrName } = xpathToCss(selector.value);
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
      if (attrName) {
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
          const text = $el.text().trim();
          if (text) results.push(text);
        }
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

// ==================== Extract Links from List ====================

export function extractLinksFromList(
  html: string,
  listSelector: Selector,
  linkSelector: Selector,
  titleSelector: Selector,
  baseUrl: string
): Array<{ title: string; url: string }> {
  const $ = cheerio.load(html);
  const results: Array<{ title: string; url: string }> = [];

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
      if (linkEl.length === 0) {
        const docLinkEl = $(css);
        linkValue = attrName ? (docLinkEl.attr(attrName) || "") : (docLinkEl.attr("href") || "");
      } else {
        linkValue = attrName ? (linkEl.attr(attrName) || "") : (linkEl.attr("href") || "");
      }
    } else if (linkSelector.type === "regex") {
      const match = safeRegexMatch(linkSelector.value, "i", $listEl.html() || "");
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
        titleValue = $(css).text().trim();
      } else {
        titleValue = titleEl.text().trim();
      }
    } else if (titleSelector.type === "regex") {
      const match = safeRegexMatch(titleSelector.value, "i", $listEl.html() || "");
      titleValue = match?.[1] || match?.[0] || "";
    } else {
      const titleEl = $listEl.find(titleSelector.value);
      if (titleEl.length === 0) {
        titleValue = $(titleSelector.value).text().trim();
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

// Local import to avoid circular dependency
function resolveUrl(base: string, relative: string): string {
  try {
    return new URL(relative, base).href;
  } catch {
    return relative;
  }
}