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
    regex: /(?:var\s+\w+\s*=|innerHTML\s*=|textContent\s*=)\s*JSON\.parse\s*\(\s*['"]([\s\S]{50,}?)['"]\s*\)/g,
    contentGroup: 1,
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
        return String.fromCodePoint(...codes);
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
        return String.fromCodePoint(...codes);
      } catch {
        return null;
      }
    },
  },
  // Pattern 12: window.chapterContent = [...] or window.content = [...] (array of paragraphs)
  // Matches arrays assigned to window/global variables, common in newer novel sites
  {
    name: 'windowArrayContent',
    regex: /(?:window\.)?(?:chapterContent|content|novelContent|bookContent|txtContent|articleContent)\s*=\s*\[([\s\S]{100,}?)\]\s*;/g,
    contentGroup: 1,
    transform: (raw: string) => {
      try {
        // Parse as JavaScript array literal (handle quoted strings)
        // Match array elements: 'string' or "string" or `string`
        const items: string[] = [];
        const re = /['"]([^'"]{2,})['"]/g;
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

  // For non-CJK content, require minimum length to avoid noise
  if (text.length < MIN_CONTENT_LENGTH) return false;

  return false;
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

// ==================== Main Extraction ====================

/**
 * Extract content from JavaScript-rendered HTML source.
 * 
 * This function scans the raw HTML for common JS content injection patterns
 * and extracts the embedded content. Useful for novel sites that render
 * chapter text via JavaScript instead of server-side HTML.
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

  for (const pattern of JS_PATTERNS) {
    // Reset regex state for global patterns
    pattern.regex.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(html)) !== null) {
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
    return { found: false, content: '', pattern: '', chunks: [] };
  }

  // Deduplicate chunks (same content may appear in multiple patterns)
  const uniqueChunks = [...new Set(chunks)];

  // Join chunks with paragraph breaks
  const content = uniqueChunks.join('\n\n');

  return {
    found: true,
    content,
    pattern: matchedPattern,
    chunks: uniqueChunks,
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
  /innerHTML\s*=/,
  /textContent\s*=/,
  /document\.write/,
  /decodeURIComponent/,
  /\$\('#/,
  /atob\(/,
  /JSON\.parse/,
  /fromCharCode/,
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
