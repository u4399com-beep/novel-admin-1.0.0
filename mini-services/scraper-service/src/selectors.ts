/**
 * Selector Engine - CSS / XPath / Regex parsing
 * Enhanced with better XPath support and attribute detection.
 */

import * as cheerio from "cheerio";
import type { Selector } from "./types";
import { safeRegexMatch } from "./regex-safety";
import { resolveUrl } from "./utils";

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

    // Explicit extract attribute takes priority
    if (selector.extract) {
      return el.attr(selector.extract) || "";
    }
    if (attrName) {
      return el.attr(attrName) || "";
    }

    // Skip extracting text from script/style/noscript/template tags
    if (isExcludedTag(el[0]!)) return "";

    return el.attr("href") || el.attr("src") || el.text().trim();
  }

  // CSS selector (default)
  const $ = cheerio.load(html);
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
  if (selector.value.includes("meta")) {
    const content = el.attr("content");
    if (content) return content;
  }

  // Skip extracting text from script/style/noscript/template tags
  if (isExcludedTag(el[0]!)) return "";

  return el.text().trim();
}

// ==================== Multi Element Selector ====================

export function parseSelectorMulti(html: string, selector: Selector): string[] {
  if (selector.type === "regex") {
    return safeRegexMatch(html, selector.value, "gi") || [];
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
      // Skip text extraction from excluded tags
      if (!isExcludedTag(el)) {
        const text = $el.text().trim();
        if (text) results.push(text);
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
      const match = safeRegexMatch($listEl.html() || "", linkSelector.value, "i");
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
      const match = safeRegexMatch($listEl.html() || "", titleSelector.value, "i");
      titleValue = match?.[1] || match?.[0] || "";
    } else {
      const titleEl = $listEl.find(titleSelector.value);
      if (titleEl.length === 0) {
        titleValue = $(titleSelector.value).text().trim();
      } else {
        titleValue = titleEl.text().trim();
      }
    }

    const trimmedLink = linkValue.trim().toLowerCase();
    const isDangerous = trimmedLink.startsWith('javascript:') ||
      trimmedLink.startsWith('data:') ||
      trimmedLink.startsWith('blob:') ||
      trimmedLink.startsWith('vbscript:');
    if (linkValue && !isDangerous) {
      results.push({
        title: titleValue,
        url: resolveUrl(baseUrl, linkValue),
      });
    }
  });

  return results;
}

