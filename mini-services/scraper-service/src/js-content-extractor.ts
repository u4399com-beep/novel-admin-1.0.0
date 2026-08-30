/**
 * JS Content Extractor
 * 
 * Many Chinese novel sites render chapter content via simple JavaScript patterns
 * instead of server-side HTML. This module detects and extracts content from
 * these common JS rendering patterns WITHOUT requiring a full browser engine.
 *
 * Supported patterns:
 *   1. `document.getElementById('xxx').innerHTML = 'content...'`
 *   2. `document.getElementById('xxx').innerText = 'content...'`
 *   3. `document.getElementById('xxx').textContent = 'content...'`
 *   4. `$("#xxx").html("content...")`  (jQuery)
 *   5. `$("#xxx").text("content...")`  (jQuery)
 *   6. `var/let/const content = "..."`  (global variable assignment)
 *   7. `document.write("...")`  (document.write)
 *   8. `element.innerHTML = decodeURIComponent("...")` (encoded content)
 *   9. `innerHTML = JSON.parse('...')` (JSON-encoded content)
 *  10. `String.fromCharCode(code1, code2, ...)` (charCode arrays)
 *  11. `var arr = [code1, code2, ...]` (charCode loop arrays)
 *  12. `window.chapterContent = [...]` (paragraph arrays)
 *  13. `var x = atob('base64...')` (standalone base64)
 *  14. `window.__NUXT__` / `__INITIAL_STATE__` / `__NEXT_DATA__` / `__APP_DATA__` (framework SSR state)
 *  15. `<script type="application/json">` tags (structured data)
 *  16. `window.chapterContent`, `window.novelData`, `window.bookData` (global data objects)
 *  17. Lazy-loaded content via `data-src`, `data-lazy-src`, `data-original` attribute swapping
 *
 * Usage: In CheerioEngine, after getting empty/no content from normal extraction,
 * call `extractJsContent(html)` to try JS pattern extraction.
 */

// ==================== Types ====================

export interface JsExtractResult {
  /** Whether any content was extracted */
  found: boolean;
  /** Extracted text content (may be HTML) */
  content: string;
  /** The pattern that matched (for debugging) */
  pattern: string;
  /** All extracted chunks (if multiple patterns matched) */
  chunks: string[];
  /** Extraction confidence score (0.0 - 1.0) based on source reliability */
  confidence: number;
  /** Total character count of extracted content */
  charCount: number;
}

/**
 * Generic extraction result interface with source classification and confidence.
 * Used by callers that need structured metadata about the extraction source.
 */
export interface ExtractionResult {
  content: string;
  /** Source type that produced the content */
  source: 'dom' | 'js_state' | 'json_ld' | 'meta' | 'lazy_attr';
  /** Confidence score (0.0 - 1.0) based on source reliability */
  confidence: number;
  /** Total character count of extracted content */
  charCount: number;
}

// ==================== Extraction Patterns ====================

/**
 * Regex patterns to find JS-rendered content in HTML source.
 * Each pattern has: name, regex, and group index for the content.
 */
const JS_PATTERNS: Array<{
  name: string;
  regex: RegExp; // Compiled once
  contentGroup: number;
  encoded?: boolean; // content is URL-encoded or HTML-entity encoded
  /** Optional transform to apply to raw match before content filtering (e.g. charCode decode) */
  transform?: (raw: string, fullMatch: string) => string | null;
  /** If true, only search within <script> tag contents (avoids ReDoS on full HTML) */
  scriptOnly?: boolean;
}> = [
  // Pattern 1: getElementById + innerHTML/innerText/textContent
  {
    name: 'getElementById.innerHTML',
    regex: /getElementById\s*\(\s*['"]([\w-]+)['"]\s*\)\s*\.\s*(innerHTML|innerText|textContent)\s*=\s*['"]([^'";]{20,})/g,
    contentGroup: 3,
  },
  // Pattern 2: querySelector + innerHTML
  {
    name: 'querySelector.innerHTML',
    regex: /querySelector\s*\(\s*['"]([.#][\w-]+)['"]\s*\)\s*\.\s*innerHTML\s*=\s*['"]([^'";]{20,})/g,
    contentGroup: 2,
  },
  // Pattern 3: jQuery $("#id").html() / .text()
  {
    name: 'jQuery.html',
    regex: /\$\s*\(\s*['"]([.#][\w-]+)['"]\s*\)\s*\.\s*(html|text)\s*\(\s*['"]([^'";]{20,})/g,
    contentGroup: 3,
  },
  // Pattern 4: document.write()
  {
    name: 'document.write',
    regex: /document\.write\s*\(\s*['"]([^'";]{50,})/g,
    contentGroup: 1,
  },
  // Pattern 5: Variable assignment with string content (common in novel sites)
  // Matches: var content = "..."; or let/const chapterContent = '...';
  {
    name: 'variableAssignment',
    regex: /(?:var|let|const)\s+(?:chapterContent|content|txtContent|nr_title|nr1|chaptertxt|content_1|novelContent|booktxt|bookContent|chapter_content|articleContent|novelcontent|txt|booktxt1|chapterContent2|contentHtml|strContent|readContent|bookContentHtml)\s*=\s*['"]([^'";]{50,})/g,
    contentGroup: 1,
  },
  // Pattern 6: decodeURIComponent pattern
  {
    name: 'decodeURIComponent',
    regex: /(?:innerHTML|textContent|innerText|html|text)\s*=\s*decodeURIComponent\s*\(\s*['"]([^'";]{20,})/g,
    contentGroup: 1,
    encoded: true,
  },
  // Pattern 7: unescape() pattern (older sites)
  {
    name: 'unescape',
    regex: /(?:innerHTML|textContent)\s*=\s*unescape\s*\(\s*['"]([^'";]{20,})/g,
    contentGroup: 1,
    encoded: true,
  },
  // Pattern 8: Base64 encoded content via atob()
  {
    name: 'base64Content',
    regex: /(?:innerHTML|textContent)\s*=\s*atob\s*\(\s*['"]([A-Za-z0-9+/=]{100,})/g,
    contentGroup: 1,
    encoded: true,
  },
  // Pattern 9: JSON.parse() assignment — handles content encoded as JSON strings
  // Matches: innerHTML = JSON.parse('...'), var x = JSON.parse('...')
  {
    name: 'JSON.parse',
    regex: /(?:var\s+\w+\s*=|innerHTML\s*=|textContent\s*=)\s*JSON\.parse\s*\(\s*['"]([\s\S]{50,100000}?)['"]\s*\)/g,
    contentGroup: 1,
    scriptOnly: true,
    transform: (raw: string) => {
      try {
        // Try to parse the JSON string. If it's a string (escaped), it will return a string.
        // If it's an array, join elements.
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'string') return parsed;
        if (Array.isArray(parsed)) return parsed.filter((s: unknown) => typeof s === 'string').join('\n');
        return null;
      } catch {
        return null;
      }
    },
  },
  // Pattern 10: String.fromCharCode() array — direct call with char codes
  // Matches: String.fromCharCode(12345,67890,...) or .fromCharCode(12345,...)
  {
    name: 'String.fromCharCode',
    regex: /(?:String|\.?)fromCharCode\s*\(\s*((?:\d{1,7}\s*,\s*){5,}\d{1,7})\s*\)/g,
    contentGroup: 1,
    transform: (_raw: string, fullMatch: string) => {
      try {
        // Extract the number list from the full match
        const numsMatch = fullMatch.match(/fromCharCode\s*\(\s*([\d,\s]+)\s*\)/);
        if (!numsMatch) return null;
        const codes = numsMatch[1].split(',').map(s => parseInt(s.trim(), 10));
        if (codes.some(isNaN) || codes.length < 5) return null;
        // Chunked approach to avoid call stack overflow on large arrays
        let result = '';
        for (let i = 0; i < codes.length; i += 4096) {
          result += String.fromCodePoint(...codes.slice(i, i + 4096));
        }
        return result;
      } catch {
        return null;
      }
    },
  },
  // Pattern 11: String.fromCharCode loop — var txt="";for(...)txt+=String.fromCharCode(arr[i])
  // Matches the combined pattern of: an array of charCodes + loop building string
  {
    name: 'charCodeLoop',
    regex: /(?:var|let|const)\s+(?:\w+)\s*=\s*\[(\d{1,7}(?:\s*,\s*\d{1,7}){20,})\s*\]/g,
    contentGroup: 1,
    transform: (raw: string) => {
      try {
        const codes = raw.split(',').map(s => parseInt(s.trim(), 10));
        if (codes.some(isNaN) || codes.length < 20) return null;
        // Chunked approach to avoid call stack overflow on large arrays
        let result = '';
        for (let i = 0; i < codes.length; i += 4096) {
          result += String.fromCodePoint(...codes.slice(i, i + 4096));
        }
        return result;
      } catch {
        return null;
      }
    },
  },
  // Pattern 12: window.chapterContent = [...] or window.content = [...] (array of paragraphs)
  // Matches arrays assigned to window/global variables, common in newer novel sites
  {
    name: 'windowArrayContent',
    regex: /(?:window\.)?(?:chapterContent|content|novelContent|bookContent|txtContent|articleContent)\s*=\s*\[([\s\S]{100,200000}?)\]\s*;/g,
    contentGroup: 1,
    scriptOnly: true,
    transform: (raw: string) => {
      try {
        // Parse as JavaScript array literal (handle quoted strings)
        // Match array elements: 'string' or "string" or `string`
        const items: string[] = [];
        const re = /['"]((?:[^'"\\]|\\.)+)['"]/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(raw)) !== null) {
          items.push(m[1]);
          if (items.length > 1000) break; // Safety: limit array size
        }
        if (items.length < 3) return null;
        return items.join('\n');
      } catch {
        return null;
      }
    },
  },
  // Pattern 13: Standalone atob() variable assignment (not directly assigned to innerHTML)
  // Matches: var content = atob('base64...'); or let x = atob('base64...');
  {
    name: 'standaloneAtob',
    regex: /(?:var|let|const)\s+(?:\w+)\s*=\s*atob\s*\(\s*['"]([A-Za-z0-9+/=]{200,})['"]\s*\)/g,
    contentGroup: 1,
    encoded: true,
  },
];

// ==================== Content Filter ====================

/** Minimum content length to consider a match valid (avoid short noise) */
const MIN_CONTENT_LENGTH = 50;

/** Maximum content length to prevent memory issues */
const MAX_CONTENT_LENGTH = 500_000;

/**
 * Filter out extracted content that is likely not novel content.
 * Checks for: too short, all numbers, all punctuation, CSS/JS code.
 * Note: CJK content is very compact (10 Chinese chars is meaningful),
 * so we check CJK count BEFORE applying the length threshold.
 */
function isLikelyNovelContent(text: string): boolean {
  if (text.length > MAX_CONTENT_LENGTH) return false;

  // Check CJK / Latin content FIRST (before length threshold)
  // because URL-decoded Chinese text can be short but meaningful
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const latinWords = (text.match(/[a-zA-Z]{3,}/g) || []).length;

  // For Chinese novel sites, even a small amount of CJK content is valid
  if (cjkCount >= 5) return true;
  if (latinWords > 15) return true;

  // For content with some CJK or Latin (even below thresholds),
  // accept if the text is substantial enough to be meaningful
  if ((cjkCount > 0 || latinWords > 0) && text.length >= MIN_CONTENT_LENGTH) return true;

  // For pure non-CJK/non-Latin content (e.g. numbers, symbols), require length
  if (text.length < MIN_CONTENT_LENGTH) return false;

  // Substantial text with no recognizable words — accept cautiously
  // (could be encoded content, mixed scripts, etc.)
  return text.length >= MIN_CONTENT_LENGTH;
}

// ==================== Decoding ====================

/**
 * Try to decode content that was extracted from an encoded JS source.
 */
function decodeExtractedContent(raw: string, encoded?: boolean): string {
  let text = raw;

  if (encoded) {
    // Try URL decoding
    try {
      text = decodeURIComponent(text);
    } catch {
      // Not valid URL encoding, try as-is
    }

    // Try HTML entity decoding (common in Chinese sites)
    text = text
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  // Also try Base64 (for atob patterns)
  // Note: atob() returns Latin-1 bytes, so for UTF-8 content we must
  // use TextDecoder to properly decode multi-byte CJK characters.
  if (encoded && /^[A-Za-z0-9+/=]+$/.test(raw) && raw.length > 100) {
    try {
      const binary = atob(raw);
      const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
      const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      // If base64 decode produces more CJK content, use it
      const decodedCjk = (decoded.match(/[\u4e00-\u9fff]/g) || []).length;
      const rawCjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
      if (decodedCjk > rawCjk) {
        text = decoded;
      }
    } catch {
      // Not valid base64
    }
  }

  return text;
}

/**
 * Pre-extract <script> tag contents from HTML.
 * Used to limit regex search scope for patterns that use [\s\S] quantifiers,
 * preventing O(n²) ReDoS on non-matching full HTML.
 */
const SCRIPT_TAG_RE = /<script[^>]*>([\s\S]*?)<\/script>/gi;
function extractScriptContents(html: string): string {
  const parts: string[] = [];
  SCRIPT_TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SCRIPT_TAG_RE.exec(html)) !== null) {
    parts.push(m[1]);
  }
  return parts.join('\n');
}

// ==================== Framework State Extraction ====================

/**
 * Known window globals that SSR frameworks inject for hydration.
 * Each entry maps the global variable name to an array of JSON paths
 * (dot-separated) to try when searching for content fields.
 */
const FRAMEWORK_STATE_VARIABLES: Array<{
  globalName: string;
  contentPaths: string[];
}> = [
  {
    globalName: "__NUXT__",
    contentPaths: [
      "data.0.content", "data.0.text", "data.0.body", "data.0.chapterContent",
      "data.0.article", "data.0.html", "data.0.description",
    ],
  },
  {
    globalName: "__INITIAL_STATE__",
    contentPaths: [
      "content", "chapterContent", "text", "body", "article",
      "novel.content", "chapter.content", "book.content",
      "data.content", "data.text", "data.chapterContent",
    ],
  },
  {
    globalName: "__NEXT_DATA__",
    contentPaths: [
      "props.pageProps.content", "props.pageProps.chapterContent",
      "props.pageProps.text", "props.pageProps.body", "props.pageProps.article",
      "props.pageProps.novel.content", "props.pageProps.chapter.content",
      "props.pageProps.book.content", "props.pageProps.html",
    ],
  },
  {
    globalName: "__APP_DATA__",
    contentPaths: [
      "content", "chapterContent", "text", "body", "article",
      "data.content", "data.text", "novel.content", "chapter.content",
    ],
  },
];

/**
 * Recursively resolve a dot-separated path on a JSON object.
 * Returns the value if found, undefined otherwise.
 */
function resolveJsonPath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Try to extract a meaningful string from a resolved JSON value.
 * Handles: string, array of strings, object with content/text fields.
 */
function extractStringFromValue(val: unknown): string | null {
  if (typeof val === "string" && val.length >= MIN_CONTENT_LENGTH) return val;
  if (Array.isArray(val)) {
    // Join string array elements
    const strings = val.filter((v): v is string => typeof v === "string" && v.length > 2);
    if (strings.length >= 2) return strings.join("\n");
  }
  if (typeof val === "object" && val !== null) {
    // Try nested content fields
    const rec = val as Record<string, unknown>;
    for (const key of ["content", "text", "body", "html", "chapterContent"]) {
      const nested = extractStringFromValue(rec[key]);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * Extract content from framework SSR state variables (__NUXT__, __INITIAL_STATE__, etc.).
 * Searches for the global variable assignment in script tags, parses the JSON,
 * and walks known content paths.
 *
 * @param scriptContents - Pre-extracted script tag contents
 * @returns Extracted content string or null
 */
function extractFrameworkStateContent(scriptContents: string): string | null {
  for (const { globalName, contentPaths } of FRAMEWORK_STATE_VARIABLES) {
    // Match: window.__NUXT__ = {...} or __NUXT__ = {...} or var __NUXT__ = {...}
    const escaped = globalName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      `(?:window\\.|var\\s+|let\\s+|const\\s+)?${escaped}\\s*=\\s*([\\s\\S]{10,}?)\\s*(?:;|<\\/script|$)`,
      "i"
    );
    const match = re.exec(scriptContents);
    if (!match) continue;

    let jsonStr = match[1].trim();
    // Remove trailing semicolons or whitespace
    jsonStr = jsonStr.replace(/;\s*$/, "");

    try {
      const parsed = JSON.parse(jsonStr);
      for (const path of contentPaths) {
        const val = resolveJsonPath(parsed, path);
        const content = extractStringFromValue(val);
        if (content && isLikelyNovelContent(content)) return content;
      }
    } catch {
      // Not valid JSON, skip
    }
  }
  return null;
}

// ==================== JSON API Response / Script Tag Extraction ====================

/**
 * Known global variable names that novel sites use to embed content data.
 */
const NOVEL_GLOBAL_VARIABLES = [
  "chapterContent", "novelData", "bookData", "contentData",
  "chapterData", "pageData", "articleData", "postData",
];

/**
 * Extract content from <script type="application/json"> tags and known global
 * variable assignments (window.chapterContent, window.novelData, etc.).
 *
 * @param html - The full HTML source
 * @param scriptContents - Pre-extracted script tag contents
 * @returns Extracted content string or null
 */
function extractJsonApiContent(html: string, scriptContents: string): string | null {
  // Strategy 1: <script type="application/json"> tags
  const jsonScriptRe = /<script[^>]*type\s*=\s*["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let jsonMatch: RegExpExecArray | null;
  while ((jsonMatch = jsonScriptRe.exec(html)) !== null) {
    const rawJson = jsonMatch[1].trim();
    if (rawJson.length < 20) continue;
    try {
      const parsed = JSON.parse(rawJson);
      const content = extractStringFromValue(parsed);
      if (content && isLikelyNovelContent(content)) return content;
      // Also try common nested paths
      for (const key of ["content", "text", "body", "html", "chapterContent", "data"]) {
        const val = resolveJsonPath(parsed, key);
        const nested = extractStringFromValue(val);
        if (nested && isLikelyNovelContent(nested)) return nested;
      }
    } catch {
      // Not valid JSON
    }
  }

  // Strategy 2: window.chapterContent = { ... }, window.novelData = "...", etc.
  for (const varName of NOVEL_GLOBAL_VARIABLES) {
    // Match string assignment: window.chapterContent = "..." or window.chapterContent = '...'
    const stringRe = new RegExp(
      `window\\.${varName}\\s*=\\s*["']([\\s\\S]{50,}?)['"]\\s*;`,
      "i"
    );
    const strMatch = stringRe.exec(scriptContents);
    if (strMatch) {
      const content = strMatch[1];
      if (isLikelyNovelContent(content)) return content;
    }

    // Match JSON object assignment: window.chapterContent = { ... }
    const objRe = new RegExp(
      `window\\.${varName}\\s*=\\s*(\\{[\\s\\S]{20,}?\\})\\s*;`,
      "i"
    );
    const objMatch = objRe.exec(scriptContents);
    if (objMatch) {
      try {
        const parsed = JSON.parse(objMatch[1]);
        const content = extractStringFromValue(parsed);
        if (content && isLikelyNovelContent(content)) return content;
      } catch {
        // Not valid JSON
      }
    }

    // Match array assignment: window.chapterContent = [...] (not already covered by windowArrayContent pattern)
    const arrRe = new RegExp(
      `window\\.${varName}\\s*=\\s*\\[([\\s\\S]{100,}?)\\]\\s*;`,
      "i"
    );
    const arrMatch = arrRe.exec(scriptContents);
    if (arrMatch) {
      try {
        // Parse as array of strings
        const items: string[] = [];
        const itemRe = /["']((?:[^"'\\]|\\.)+)["']/g;
        let m: RegExpExecArray | null;
        while ((m = itemRe.exec(arrMatch[1])) !== null) {
          items.push(m[1]);
          if (items.length > 1000) break;
        }
        if (items.length >= 3) {
          const joined = items.join("\n");
          if (isLikelyNovelContent(joined)) return joined;
        }
      } catch {
        // Skip
      }
    }
  }

  return null;
}

// ==================== Lazy-Loaded Content Swapping ====================

/**
 * Attributes used by lazy-loading libraries to hold the real src URL.
 */
const LAZY_SRC_ATTRIBUTES = [
  "data-src",
  "data-lazy-src",
  "data-original",
  "data-lazy",
  "data-ll-status",
  "data-bg",
  "data-image",
];

/**
 * Swap lazy-loaded image/element attributes so that extraction sees the real URLs.
 * Replaces `data-src`, `data-lazy-src`, `data-original` etc. with `src` in the HTML,
 * but only on elements that have a lazy attribute and either no `src` or an empty/placeholder `src`.
 *
 * @param html - The raw HTML source
 * @returns Modified HTML with lazy attributes swapped to src
 */
export function swapLazyLoadedContent(html: string): string {
  for (const attr of LAZY_SRC_ATTRIBUTES) {
    // Match elements with data-xxx="..." that have no src, empty src, or placeholder src
    // Placeholder patterns: data:image/gif, data:image/png, about:blank, empty string
    const re = new RegExp(
      `(<(?:img|iframe|div|source|video|audio)[\\s\\S]*?)${attr}\\s*=\\s*["']([^"'\\s>]+)["']([\\s\\S]*?>)`,
      "gi"
    );
    html = html.replace(re, (fullMatch, before, lazyUrl, after) => {
      // Only swap if the element doesn't have a real src already
      // Check if there's a src= that's not a data: URL or empty
      const srcMatch = fullMatch.match(/src\s*=\s*["']([^"']*)["']/i);
      const hasRealSrc = srcMatch &&
        srcMatch[1].length > 0 &&
        !srcMatch[1].startsWith("data:") &&
        srcMatch[1] !== "about:blank";

      if (hasRealSrc) return fullMatch; // Already has a real src, don't overwrite

      // Replace the lazy attribute with src inside the tag (both 'has src placeholder' and 'no src' cases)
      return before + `src="${lazyUrl}"` + after;
    });
  }
  return html;
}

/**
 * Confidence scores by extraction source type.
 *   js_state (Vue/React/Next.js SSR): 0.9 — structured framework data, highly reliable
 *   json_ld (JSON-LD / application/json): 0.95 — structured schema data, most reliable
 *   dom (regex patterns on HTML): 0.7 — reliable but may miss JS-rendered content
 *   lazy_attr (lazy-loaded content swap): 0.6 — may miss some images
 *   meta (meta tags): 0.8 — clean but limited (not used in this extractor, defined for reference)
 */
const CONFIDENCE_BY_SOURCE: Record<string, number> = {
  frameworkState: 0.9,
  jsonApiResponse: 0.95,
  lazy_attr: 0.6,
  meta: 0.8,
};
const DEFAULT_PATTERN_CONFIDENCE = 0.7; // DOM-based regex extraction

/**
 * Compute extraction confidence based on which source/pattern produced the content.
 * When multiple sources contribute chunks, returns a weighted average.
 *
 * @param primaryPattern - The first (primary) matched pattern name
 * @param originalHtml - The original HTML (before lazy swap)
 * @param processedHtml - The HTML after lazy attribute swapping
 */
function computeExtractionConfidence(
  primaryPattern: string,
  originalHtml: string,
  processedHtml: string,
): number {
  // Single-source extraction — use the source-specific confidence
  const directConfidence = CONFIDENCE_BY_SOURCE[primaryPattern];
  if (directConfidence !== undefined) {
    return directConfidence;
  }

  // DOM pattern extraction (default for JS_PATTERNS matches)
  let confidence = DEFAULT_PATTERN_CONFIDENCE;

  // If lazy swapping modified the HTML (content likely came from lazy attributes),
  // reduce confidence slightly since lazy-swap may miss some images
  if (originalHtml !== processedHtml) {
    // Weighted average: DOM confidence and lazy_attr confidence
    // Since we can't determine the exact ratio, lean toward DOM (lazy is a preprocessing step)
    confidence = 0.65;
  }

  return confidence;
}

// ==================== Main Extraction =====================

/**
 * Extract content from JavaScript-rendered HTML source.
 * 
 * This function scans the raw HTML for common JS content injection patterns
 * and extracts the embedded content. Useful for novel sites that render
 * chapter text via JavaScript instead of server-side HTML.
 *
 * Enhanced with: framework SSR state extraction, JSON API response detection,
 * and lazy-loaded content attribute swapping.
 *
 * @param html - The raw HTML source (may contain JS-rendered content)
 * @returns Extraction result with content if found
 *
 * @example
 * ```ts
 * const cheerioResult = cheerioExtract(html);
 * if (cheerioResult.text.length < 100) {
 *   // Normal extraction failed, try JS patterns
 *   const jsResult = extractJsContent(html);
 *   if (jsResult.found) {
 *     content = jsResult.content;
 *   }
 * }
 * ```
 */
export function extractJsContent(html: string): JsExtractResult {
  const chunks: string[] = [];
  let matchedPattern = '';

  // 0. Pre-process: swap lazy-loaded content attributes
  const processedHtml = swapLazyLoadedContent(html);

  // Pre-extract script contents once for scriptOnly patterns (ReDoS mitigation)
  const scriptOnlyHtml = extractScriptContents(processedHtml);

  // 0a. Try framework SSR state extraction (Nuxt, Vue, Next.js, custom)
  const frameworkContent = extractFrameworkStateContent(scriptOnlyHtml);
  if (frameworkContent) {
    chunks.push(frameworkContent);
    matchedPattern = 'frameworkState';
  }

  // 0b. Try JSON API response / <script type="application/json"> extraction
  if (chunks.length === 0) {
    const jsonApiContent = extractJsonApiContent(processedHtml, scriptOnlyHtml);
    if (jsonApiContent) {
      chunks.push(jsonApiContent);
      matchedPattern = 'jsonApiResponse';
    }
  }

  // Continue with existing pattern matching
  for (const pattern of JS_PATTERNS) {
    // Reset regex state for global patterns
    pattern.regex.lastIndex = 0;

    // For patterns with [\s\S] quantifiers, search only within <script> tags
    const searchTarget = pattern.scriptOnly ? scriptOnlyHtml : processedHtml;

    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(searchTarget)) !== null) {
      const rawContent = match[pattern.contentGroup];
      if (!rawContent) continue;

      // Safety: prevent infinite loops on zero-length matches
      if (match[0].length === 0) { pattern.regex.lastIndex++; continue; }

      // Apply transform if present (e.g. charCode decode, JSON.parse)
      let decoded: string;
      if (pattern.transform) {
        const transformed = pattern.transform(rawContent, match[0]);
        if (!transformed) continue;
        decoded = transformed;
      } else {
        decoded = decodeExtractedContent(rawContent, pattern.encoded);
      }

      // Filter: must look like novel content
      if (isLikelyNovelContent(decoded)) {
        if (!matchedPattern) matchedPattern = pattern.name;
        chunks.push(decoded);
      }
    }
  }

  if (chunks.length === 0) {
    return { found: false, content: '', pattern: '', chunks: [], confidence: 0, charCount: 0 };
  }

  // Deduplicate chunks (same content may appear in multiple patterns)
  const uniqueChunks = [...new Set(chunks)];

  // Join chunks with paragraph breaks
  const content = uniqueChunks.join('\n\n');

  // Compute extraction confidence based on source type
  const confidence = computeExtractionConfidence(matchedPattern, html, processedHtml);

  return {
    found: true,
    content,
    pattern: matchedPattern,
    chunks: uniqueChunks,
    confidence,
    charCount: content.length,
  };
}

/**
 * Quick check if the HTML likely contains JS-rendered content.
 * Fast heuristic: checks for common JS content injection keywords.
 * 
 * @param html - Raw HTML source
 * @returns true if JS content injection patterns are likely present
 */

/**
 * Pre-compiled quick-check regex patterns.
 * Avoids creating new RegExp objects on every call.
 */
const QUICK_CHECK_PATTERNS = [
  /getElementById/,
  /(?:chapterContent|novelContent|content|bookContent|articleContent)\s*=\s*['"\x60<]/i,
  /textContent\s*=/,
  /document\.write/,
  /decodeURIComponent/,
  /\$\('#/,
  /atob\(/,
  /JSON\.parse/,
  /fromCharCode/,
  // Framework SSR state variables
  /__NUXT__/,
  /__INITIAL_STATE__/,
  /__NEXT_DATA__/,
  /__APP_DATA__/,
  // JSON API patterns
  /type\s*=\s*["']application\/json["']/i,
  /window\.(?:chapterContent|novelData|bookData|contentData)\s*=/i,
  // Lazy-load attributes
  /data-(?:src|lazy-src|original)\s*=/,
];

export function hasJsContentPatterns(html: string): boolean {
  for (const re of QUICK_CHECK_PATTERNS) {
    if (re.test(html)) {
      return true;
    }
  }
  return false;
}

/**
 * Get debug info about detected JS content patterns.
 * Useful for logging and troubleshooting.
 *
 * @param html - Raw HTML source
 * @returns Array of detected pattern names and match counts
 */
export function debugJsPatterns(html: string): Array<{ pattern: string; matches: number }> {
  const results: Array<{ pattern: string; matches: number }> = [];

  for (const pattern of JS_PATTERNS) {
    pattern.regex.lastIndex = 0;
    let count = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(html)) !== null) {
      count++;
      // Safety: prevent infinite loops on zero-length matches
      if (match[0].length === 0) pattern.regex.lastIndex++;
    }
    if (count > 0) {
      results.push({ pattern: pattern.name, matches: count });
    }
  }

  return results;
}

// ==================== API Endpoint Content Extraction ====================

/**
 * Scan HTML for API endpoint patterns used to load chapter/content data.
 * Detects fetch(), axios, jQuery AJAX, and URL constructor calls that
 * point to chapter/content/text/book/novel API paths.
 *
 * @param html - The raw HTML source
 * @param pageUrl - The page URL for resolving relative paths
 * @returns Array of detected API URLs with method info
 */
export function extractApiContentUrls(html: string, pageUrl: string): Array<{url: string, method: string, variable: string}> {
  const results: Array<{url: string, method: string, variable: string}> = [];

  // Pattern 1: fetch('/api/chapter/...') or fetch('/chapter/...')
  const fetchPattern = /(?:fetch|axios\.get|axios\.post|\$\.get|\$\.ajax)\s*\(\s*['"]((?:\/api\/)?(?:chapter|content|text|book|novel)[\/\w-]*)['"/]/gi;
  // Pattern 2: URL constructor with chapter/content path
  const urlPattern = /new\s+URL\s*\(\s*['"]((?:\/api\/)?(?:chapter|content|text|book|novel)[\/\w-]*)['"]/gi;

  let match;
  while ((match = fetchPattern.exec(html)) !== null) {
    const url = match[1].startsWith('/') ? match[1] : '/' + match[1];
    try {
      const fullUrl = new URL(url, pageUrl).href;
      results.push({ url: fullUrl, method: 'fetch', variable: match[0].slice(0, 30) });
    } catch { /* ignore */ }
  }
  while ((match = urlPattern.exec(html)) !== null) {
    const url = match[1].startsWith('/') ? match[1] : '/' + match[1];
    try {
      const fullUrl = new URL(url, pageUrl).href;
      results.push({ url: fullUrl, method: 'url', variable: '' });
    } catch { /* ignore */ }
  }
  return results;
}

/**
 * Extract the JSON field path that likely contains chapter content
 * from the response handler in JavaScript code.
 * Looks for patterns like: data.content, data.text, result.chapterContent
 *
 * @param html - The raw HTML source containing JS response handlers
 * @returns The detected field path string (e.g. 'data.content'), or null
 */
export function extractContentFieldPath(html: string): string | null {
  // Look for patterns like: data.content, data.text, result.chapterContent, res.data.text
  const fieldPatterns = [
    /(?:data|result|res|response)\.(?:chapter)?(?:content|text|html|body|article)\b/gi,
    /(?:data|result)\.items\[\d+\]\.(?:content|text)/gi,
  ];
  for (const pattern of fieldPatterns) {
    const match = pattern.exec(html);
    if (match) return match[0];
  }
  return null;
}
