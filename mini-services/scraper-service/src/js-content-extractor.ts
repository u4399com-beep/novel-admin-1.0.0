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
  // Pattern 8: Base64 encoded content
  {
    name: 'base64Content',
    regex: /(?:innerHTML|textContent)\s*=\s*atob\s*\(\s*['"]([A-Za-z0-9+/=]{100,})/g,
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

      // Decode if needed
      const decoded = decodeExtractedContent(rawContent, pattern.encoded);

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
