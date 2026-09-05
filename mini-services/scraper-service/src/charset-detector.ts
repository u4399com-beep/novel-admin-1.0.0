/**
 * Character Set Detection & Auto-Decoding
 *
 * Many Chinese novel sites serve content in GBK/GB2312/Big5 but incorrectly declare
 * UTF-8 in Content-Type or <meta charset>. This module:
 *   1. Detects actual encoding from byte patterns (BOM, frequency analysis)
 *   2. Falls back to Content-Type / meta charset declaration
 *   3. Re-decodes content if declared encoding doesn't match detected encoding
 *
 * Usage in CheerioEngine: detectAndDecode(buffer, contentType) before cheerio.load()
 */

// ==================== Types ====================

export interface CharsetDetectResult {
  /** Detected or declared charset (normalized to lowercase) */
  charset: string;
  /** Whether auto-correction was applied (detected ≠ declared) */
  corrected: boolean;
  /** Confidence: 'high' (BOM/binary pattern), 'medium' (heuristic), 'low' (declared only) */
  confidence: 'high' | 'medium' | 'low';
  /** Original declared charset (if any) */
  declaredCharset?: string;
}

// ==================== BOM Detection ====================

// Ordered BOM list — longer BOMs MUST be checked first to avoid
// UTF-32LE (FF FE 00 00) being misdetected as UTF-16LE (FF FE).
const BOM_LIST: Array<{ bytes: number[]; charset: string }> = [
  { bytes: [0x00, 0x00, 0xFE, 0xFF], charset: 'utf-32be' },
  { bytes: [0xFF, 0xFE, 0x00, 0x00], charset: 'utf-32le' },
  { bytes: [0xEF, 0xBB, 0xBF], charset: 'utf-8' },
  { bytes: [0xFE, 0xFF], charset: 'utf-16be' },
  { bytes: [0xFF, 0xFE], charset: 'utf-16le' },
];

// ==================== Charset Aliases ====================

const CHARSET_ALIASES: Record<string, string> = {
  'gb2312': 'gbk',
  'gb2312-80': 'gbk',
  'gbk2312': 'gbk',
  'x-gbk': 'gbk',
  'cn-gb': 'gbk',
  'cs.gb2312': 'gbk',
  'euc-cn': 'gbk',
  'big5-hkscs': 'big5',
  'cn-big5': 'big5',
  'csbig5': 'big5',
  'x-x-big5': 'big5',
  'shift_jis': 'shift-jis',
  'shift-jis': 'shift-jis',
  'sjis': 'shift-jis',
  'csshiftjis': 'shift-jis',
  'euc-jp': 'euc-jp',
  'euc_jp': 'euc-jp',
};

// ==================== CJK Charset Family Constants ====================

const GBK_FAMILY = new Set(['gbk', 'gb18030', 'gb2312']);
const BIG5_FAMILY = new Set(['big5', 'big5-hkscs']);

// ==================== GBK Frequency Analysis ====================

/**
 * Check if raw bytes look like GBK by examining byte distribution.
 * GBK uses lead bytes 0x81-0xFE with trail bytes 0x40-0xFE (excluding 0x7F).
 * If >30% of non-ASCII bytes form valid GBK pairs, likely GBK.
 */
function looksLikeGBK(bytes: Uint8Array): boolean {
  let gbkPairs = 0;
  let nonAscii = 0;
  let i = 0;

  while (i < bytes.length) {
    const b = bytes[i];
    if (b <= 0x7F) {
      i++;
      continue;
    }
    nonAscii++;
    // Check GBK lead byte (0x81-0xFE) + trail byte (0x40-0xFE, not 0x7F)
    if (b >= 0x81 && b <= 0xFE && i + 1 < bytes.length) {
      const trail = bytes[i + 1];
      if ((trail >= 0x40 && trail <= 0x7E) || (trail >= 0x80 && trail <= 0xFE)) {
        gbkPairs++;
        i += 2;
        continue;
      }
    }
    i++;
  }

  // If significant non-ASCII content exists and >30% forms valid GBK pairs
  return nonAscii > 10 && gbkPairs / nonAscii > 0.3;
}

/**
 * Check if raw bytes look like Big5 (Traditional Chinese).
 * Big5 lead bytes: 0xA1-0xF9, trail bytes: 0x40-0x7E, 0xA1-0xFE.
 */
function looksLikeBig5(bytes: Uint8Array): boolean {
  let big5Pairs = 0;
  let nonAscii = 0;
  let i = 0;

  while (i < bytes.length) {
    const b = bytes[i];
    if (b <= 0x7F) {
      i++;
      continue;
    }
    nonAscii++;
    if (b >= 0xA1 && b <= 0xF9 && i + 1 < bytes.length) {
      const trail = bytes[i + 1];
      if ((trail >= 0x40 && trail <= 0x7E) || (trail >= 0xA1 && trail <= 0xFE)) {
        big5Pairs++;
        i += 2;
        continue;
      }
    }
    i++;
  }

  return nonAscii > 10 && big5Pairs / nonAscii > 0.3;
}

// ==================== Declared Charset Extraction ====================

/**
 * Extract charset from Content-Type header.
 * Handles: charset=utf-8, charset="utf-8", encoding=utf8
 */
export function extractCharsetFromContentType(contentType: string | null | undefined): string | null {
  if (!contentType) return null;
  const match = contentType.match(/charset[=\s"']+([\w\-]+)/i);
  return match ? normalizeCharset(match[1]) : null;
}

/**
 * Extract charset from HTML <meta> tags.
 * Handles: <meta charset="utf-8">, <meta http-equiv="Content-Type" content="...charset=gbk">
 */
export function extractCharsetFromHtml(html: string): string | null {
  // <meta charset="..."> or <meta charset='...'>
  const charsetMatch = html.match(/<meta[^>]+charset[=\s"']+([\w\-]+)/i);
  if (charsetMatch) return normalizeCharset(charsetMatch[1]);

  // <meta http-equiv="Content-Type" content="...charset=...">
  // Two-pass approach to handle any attribute order and single quotes:
  // Pass 1: find http-equiv=Content-Type meta tag, then extract charset from it
  const httpEquivMeta = html.match(/<meta[^>]+http-equiv[=\s"']+Content-Type["']?[^>]*>/i);
  if (httpEquivMeta) {
    const contentMatch = httpEquivMeta[0].match(/charset[=\s"']+([\w\-]+)/i);
    if (contentMatch) return normalizeCharset(contentMatch[1]);
  }

  return null;
}

// ==================== Normalization ====================

function normalizeCharset(raw: string): string {
  const lower = raw.trim().toLowerCase();
  return CHARSET_ALIASES[lower] || lower;
}

// ==================== Main Detection ====================

/**
 * Detect the actual character encoding of raw HTTP response bytes.
 *
 * Priority:
 * 1. BOM (highest confidence)
 * 2. Byte frequency analysis (GBK/Big5 detection)
 * 3. Declared charset from contentType or HTML meta
 *
 * @param buffer - Raw response bytes
 * @param contentType - Value of Content-Type header
 * @returns Detection result with charset, confidence, and correction flag
 */
export function detectCharset(buffer: Uint8Array | Buffer, contentType?: string | null): CharsetDetectResult {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  // Step 1: BOM detection (ordered — longer BOMs first)
  for (const { bytes: bomBytes, charset } of BOM_LIST) {
    if (bytes.length >= bomBytes.length) {
      let match = true;
      for (let i = 0; i < bomBytes.length; i++) {
        if (bytes[i] !== bomBytes[i]) {
          match = false;
          break;
        }
      }
      if (match) {
        const declared = extractCharsetFromContentType(contentType);
        return {
          charset,
          corrected: declared ? declared !== charset : false,
          confidence: 'high',
          declaredCharset: declared || undefined,
        };
      }
    }
  }

  // Step 2: Declared charset from Content-Type header
  const declaredFromHeader = extractCharsetFromContentType(contentType);

  // Step 3: Try to get HTML meta charset (decode as ASCII-safe for this check)
  let declaredFromHtml: string | null = null;
  try {
    // Decode first 4KB as ASCII to find meta charset
    const preview = new TextDecoder('ascii', { fatal: false }).decode(bytes.slice(0, 4096));
    declaredFromHtml = extractCharsetFromHtml(preview);
  } catch {
    // Ignore decoding errors for preview
  }

  const declaredCharset = declaredFromHeader || declaredFromHtml;

  // Step 3.5: Strict UTF-8 validation — authoritative when it passes.
  // UTF-8 CJK sequences (lead 0xE4-0xE9 + trail 0x80-0xBF) are a subset of the
  // "valid GBK pairs" accepted by looksLikeGBK (trail ⊂ 0x80-0xFE), so the legacy
  // frequency heuristic misclassified every Chinese UTF-8 page as GBK ("corrected:
  // utf-8 → gbk") and produced mojibake. Real GBK/Big5 text almost never passes a
  // strict UTF-8 validation because GBK trail bytes 0x40-0x7E break the sequences.
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (declaredCharset && GBK_FAMILY.has(declaredCharset)) {
      // Bytes are valid UTF-8 but declared as GBK — trust the bytes (misdeclared site).
      return { charset: 'utf-8', corrected: true, confidence: 'high', declaredCharset };
    }
    return { charset: 'utf-8', corrected: false, confidence: 'high', declaredCharset: declaredCharset || undefined };
  } catch {
    // Not valid UTF-8 — continue to GBK/Big5 byte-frequency analysis (Step 4).
  }

  // Step 4: Byte frequency analysis for CJK encodings
  // Only analyze if there's significant non-ASCII content (use counter instead of filter to avoid large temp array)
  let nonAsciiCount = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] > 0x7F) {
      nonAsciiCount++;
      if (nonAsciiCount > 20) break;
    }
  }
  const hasSignificantNonAscii = nonAsciiCount > 20;

  if (hasSignificantNonAscii) {
    const ANALYSIS_LIMIT = 256 * 1024;
    const analysisBytes = bytes.length > ANALYSIS_LIMIT ? bytes.slice(0, ANALYSIS_LIMIT) : bytes;
    const gbkLikely = looksLikeGBK(analysisBytes);
    const big5Likely = looksLikeBig5(analysisBytes);

    // Discriminate GBK vs Big5: if all high lead bytes fall in Big5's range
    // (0xA1-0xF9) with no GBK-only leads (0x81-0xA0, 0xFA-0xFE), prefer Big5
    let gbkOnlyLeads = 0;
    let totalHighLeads = 0;
    for (let i = 0; i < analysisBytes.length; i++) {
      const b = analysisBytes[i];
      if (b >= 0x81 && b <= 0xFE) {
        totalHighLeads++;
        if ((b >= 0x81 && b <= 0xA0) || (b >= 0xFA && b <= 0xFE)) {
          gbkOnlyLeads++;
        }
      }
    }
    const isBig5Preferred = totalHighLeads > 0 && gbkOnlyLeads === 0;

    // CJK charset family sets (module-level constants)
    // Use GBK_FAMILY and BIG5_FAMILY declared at module level

    // Check GBK first (more common for Simplified Chinese novels)
    if (gbkLikely && !isBig5Preferred) {
      // If declared charset is already a CJK encoding, respect it (e.g. gb18030 superset of GBK)
      if (declaredCharset && GBK_FAMILY.has(declaredCharset)) {
        return {
          charset: declaredCharset,
          corrected: false,
          confidence: 'medium',
          declaredCharset,
        };
      }
      if (declaredCharset && (declaredCharset === 'utf-8' || declaredCharset === 'iso-8859-1')) {
        // Declared as UTF-8 but bytes look like GBK — common misconfiguration
        return {
          charset: 'gbk',
          corrected: true,
          confidence: 'medium',
          declaredCharset,
        };
      }
      return {
        charset: 'gbk',
        corrected: !!(declaredCharset && !GBK_FAMILY.has(declaredCharset)),
        confidence: 'medium',
        declaredCharset: declaredCharset || undefined,
      };
    }

    // Check Big5 (Traditional Chinese) — also reached when GBK matched but Big5 is preferred
    if (big5Likely || (gbkLikely && isBig5Preferred)) {
      // If declared charset is already a Big5 variant, respect it
      if (declaredCharset && BIG5_FAMILY.has(declaredCharset)) {
        return {
          charset: declaredCharset,
          corrected: false,
          confidence: 'medium',
          declaredCharset,
        };
      }
      if (declaredCharset && (declaredCharset === 'utf-8' || declaredCharset === 'iso-8859-1')) {
        return {
          charset: 'big5',
          corrected: true,
          confidence: 'medium',
          declaredCharset,
        };
      }
      return {
        charset: 'big5',
        corrected: !!(declaredCharset && !BIG5_FAMILY.has(declaredCharset)),
        confidence: 'medium',
        declaredCharset: declaredCharset || undefined,
      };
    }
  }

  // Step 5: Fall back to declared charset or UTF-8
  return {
    charset: declaredCharset || 'utf-8',
    corrected: false,
    confidence: declaredCharset ? 'low' : 'low',
    declaredCharset: declaredCharset || undefined,
  };
}

/**
 * Decode raw bytes using the detected charset.
 * For UTF-8, uses standard TextDecoder. For GBK/Big5, uses TextDecoder
 * with the appropriate encoding label (supported by Bun's ICU).
 *
 * @param buffer - Raw response bytes
 * @param detection - Charset detection result
 * @returns Decoded string
 */
export function decodeWithCharset(buffer: Uint8Array | Buffer, detection: CharsetDetectResult): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  try {
    return new TextDecoder(detection.charset, { fatal: false }).decode(bytes);
  } catch {
    // Fallback to UTF-8 with replacement
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

/**
 * Convenience function: detect charset and decode in one step.
 *
 * @param buffer - Raw response bytes
 * @param contentType - Content-Type header value
 * @returns Decoded string
 */
export function detectAndDecode(buffer: Uint8Array | Buffer, contentType?: string | null): string {
  const detection = detectCharset(buffer, contentType);
  if (detection.corrected && process.env.DEBUG === 'true') {
    log.info(` Auto-corrected encoding: ${detection.declaredCharset} → ${detection.charset} (confidence: ${detection.confidence})`);
  }
  return decodeWithCharset(buffer, detection);
}
