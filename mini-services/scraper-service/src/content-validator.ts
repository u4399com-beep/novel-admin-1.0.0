/**
 * Content Quality Validation
 *
 * Validates scraped content quality by checking for:
 *   - Garbled text and encoding errors
 *   - Chapter completeness (expected vs actual length)
 *   - Content health score based on Chinese character ratio, line count, etc.
 */

// ==================== Types ====================

export interface ContentValidationResult {
  /** Overall health score (0-100) */
  healthScore: number;
  /** Grade: A (>=80), B (>=60), C (>=40), D (>=20), F (<20) */
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  /** Whether content passes minimum quality threshold */
  isAcceptable: boolean;
  /** Individual check results */
  checks: ContentCheck[];
  /** Detected encoding issues */
  encodingIssues: string[];
  /** Recommended retry with different encoding */
  recommendRetryWithEncoding?: string;
}

export interface ContentCheck {
  name: string;
  passed: boolean;
  score: number; // 0-100
  message: string;
}

// ==================== Constants ====================

/** Minimum acceptable content length in characters */
const MIN_CONTENT_LENGTH = 100;
/** Minimum Chinese character ratio for novel content (0-1) */
const MIN_CHINESE_RATIO = 0.3;
/** Maximum ratio of garbled characters (0-1) */
const MAX_GARBLED_RATIO = 0.05;
/** Minimum line count for a chapter */
const MIN_LINE_COUNT = 3;
/** Maximum ratio of very short lines (< 5 chars) for novel content */
const MAX_SHORT_LINE_RATIO = 0.5;
/** Characters that indicate garbled text (replacement chars, mojibake) */
const GARBLED_PATTERNS = [
  /\uFFFD/g,            // Unicode replacement character
  /[\x00-\x08\x0B\x0C\x0E-\x1F]/g, // Control characters (except \t \n \r)
  /Ã©/g,                // UTF-8 mojibake for é
  /Ã¶/g,                // UTF-8 mojibake for ö
  /Ã¼/g,                // UTF-8 mojibake for ü
  /Ã„/g,                // UTF-8 mojibake for Ä
  /Ã–/g,                // UTF-8 mojibake for Ö
  /Ãœ/g,                // UTF-8 mojibake for Ü
  /ÃŸ/g,                // UTF-8 mojibake for ß
  /ï¿½/g,               // UTF-8 BOM mojibake
  /鐢/g,                 // GBK misread as UTF-8 (common Chinese mojibake)
  /鍦/g,                 // GBK misread as UTF-8
  /棰/g,                 // GBK misread as UTF-8
  /锟/g,                 // GBK misread as UTF-8 (锟斤拷 is classic)
  /斤拷/g,               // 锟斤拷 pattern
];

// ==================== Garbled Text Detection ====================

/**
 * Detect garbled text and encoding errors in content.
 * Returns the ratio of garbled characters and list of issues.
 */
function detectGarbledText(content: string): { garbledRatio: number; issues: string[] } {
  if (content.length === 0) return { garbledRatio: 0, issues: ['Empty content'] };

  let totalGarbled = 0;
  const issues: string[] = [];

  for (const pattern of GARBLED_PATTERNS) {
    const matches = content.match(pattern);
    if (matches && matches.length > 0) {
      totalGarbled += matches.length;
      issues.push(`Mojibake pattern: ${matches[0].slice(0, 10)} (${matches.length} occurrences)`);
    }
  }

  // Check for high ratio of non-printable characters outside of normal CJK range
  let suspiciousChars = 0;
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    // CJK Unified Ideographs: 0x4E00-0x9FFF
    // CJK Extension A: 0x3400-0x4DBF
    // CJK Compatibility: 0xF900-0xFAFF
    // ASCII printable: 0x20-0x7E
    // Common CJK punctuation: 0x3000-0x303F
    // Fullwidth forms: 0xFF00-0xFFEF
    const isNormal = (
      (code >= 0x20 && code <= 0x7E) ||  // ASCII
      (code >= 0x4E00 && code <= 0x9FFF) || // CJK
      (code >= 0x3400 && code <= 0x4DBF) || // CJK Ext A
      (code >= 0xF900 && code <= 0xFAFF) || // CJK Compat
      (code >= 0x3000 && code <= 0x303F) || // CJK Punctuation
      (code >= 0xFF00 && code <= 0xFFEF) || // Fullwidth
      code === 0x0A || code === 0x0D || code === 0x09 // Newlines, tab
    );
    if (!isNormal) {
      suspiciousChars++;
    }
  }

  const suspiciousRatio = suspiciousChars / content.length;
  if (suspiciousRatio > 0.1) {
    issues.push(`High ratio of suspicious characters: ${(suspiciousRatio * 100).toFixed(1)}%`);
    totalGarbled += suspiciousChars;
  }

  const garbledRatio = totalGarbled / content.length;
  return { garbledRatio, issues };
}

// ==================== Chinese Character Analysis ====================

/**
 * Analyze the Chinese character composition of content.
 * Returns the ratio of Chinese characters and other statistics.
 */
function analyzeChineseContent(content: string): {
  chineseRatio: number;
  lineCount: number;
  shortLineRatio: number;
  avgLineLength: number;
  paragraphCount: number;
} {
  // Count Chinese characters
  let chineseCount = 0;
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF)) {
      chineseCount++;
    }
  }
  const chineseRatio = content.length > 0 ? chineseCount / content.length : 0;

  // Line analysis
  const lines = content.split(/\n/).filter(l => l.trim().length > 0);
  const lineCount = lines.length;
  const shortLines = lines.filter(l => l.trim().length < 5).length;
  const shortLineRatio = lineCount > 0 ? shortLines / lineCount : 0;
  const totalLength = lines.reduce((sum, l) => sum + l.length, 0);
  const avgLineLength = lineCount > 0 ? totalLength / lineCount : 0;

  // Paragraph count (separated by blank lines)
  const paragraphs = content.split(/\n\s*\n/).filter(p => p.trim().length > 0);
  const paragraphCount = paragraphs.length;

  return { chineseRatio, lineCount, shortLineRatio, avgLineLength, paragraphCount };
}

// ==================== Chapter Completeness ====================

/**
 * Check chapter completeness by comparing content length against expected range.
 * A typical Chinese novel chapter is 2000-8000 characters.
 */
function checkChapterCompleteness(
  content: string,
  expectedMinLength?: number,
  expectedMaxLength?: number,
): ContentCheck {
  const charCount = content.length;
  const minLen = expectedMinLength ?? 500;
  const maxLen = expectedMaxLength ?? 50000;

  if (charCount < minLen) {
    return {
      name: '章节完整性',
      passed: false,
      score: Math.round((charCount / minLen) * 50),
      message: `内容过短: ${charCount} 字 < 最低 ${minLen} 字`,
    };
  }

  if (charCount > maxLen) {
    return {
      name: '章节完整性',
      passed: true,
      score: 70,
      message: `内容异常长: ${charCount} 字 > 最大 ${maxLen} 字（可能包含多章）`,
    };
  }

  // Score based on how well the length fits typical chapter range
  const typicalMin = 2000;
  const typicalMax = 8000;
  if (charCount >= typicalMin && charCount <= typicalMax) {
    return {
      name: '章节完整性',
      passed: true,
      score: 100,
      message: `章节长度正常: ${charCount} 字`,
    };
  }

  if (charCount >= minLen && charCount < typicalMin) {
    const ratio = charCount / typicalMin;
    return {
      name: '章节完整性',
      passed: true,
      score: Math.round(60 + ratio * 40),
      message: `章节偏短: ${charCount} 字 < 典型 ${typicalMin} 字`,
    };
  }

  // charCount > typicalMax
  return {
    name: '章节完整性',
    passed: true,
    score: 80,
    message: `章节偏长: ${charCount} 字 > 典型 ${typicalMax} 字`,
  };
}

// ==================== Main Validation Function ====================

/**
 * Validate the quality of scraped content.
 *
 * Checks:
 *   1. Garbled text / encoding error detection
 *   2. Chinese character ratio
 *   3. Content length (minimum threshold)
 *   4. Line structure (line count, short line ratio)
 *   5. Chapter completeness (length vs expected)
 *
 * @param content - The scraped text content to validate
 * @param expectedMinLength - Expected minimum chapter length
 * @param expectedMaxLength - Expected maximum chapter length
 * @returns Validation result with health score and recommendations
 */
export function validateContentQuality(
  content: string,
  expectedMinLength?: number,
  expectedMaxLength?: number,
): ContentValidationResult {
  const checks: ContentCheck[] = [];
  const encodingIssues: string[] = [];

  // 1. Garbled text detection (weight: 30pts)
  const { garbledRatio, issues } = detectGarbledText(content);
  encodingIssues.push(...issues);

  if (garbledRatio <= MAX_GARBLED_RATIO) {
    checks.push({
      name: '编码质量',
      passed: true,
      score: 30,
      message: `乱码比例 ${(garbledRatio * 100).toFixed(2)}% ≤ 阈值 ${(MAX_GARBLED_RATIO * 100)}%`,
    });
  } else {
    checks.push({
      name: '编码质量',
      passed: false,
      score: Math.round(Math.max(0, 30 * (1 - garbledRatio / 0.1))),
      message: `乱码比例 ${(garbledRatio * 100).toFixed(2)}% > 阈值 ${(MAX_GARBLED_RATIO * 100)}%`,
    });
  }

  // 2. Chinese character ratio (weight: 25pts)
  const { chineseRatio, lineCount, shortLineRatio, avgLineLength, paragraphCount } = analyzeChineseContent(content);

  if (chineseRatio >= MIN_CHINESE_RATIO) {
    checks.push({
      name: '中文含量',
      passed: true,
      score: 25,
      message: `中文字符占比 ${(chineseRatio * 100).toFixed(1)}%`,
    });
  } else {
    checks.push({
      name: '中文含量',
      passed: false,
      score: Math.round(25 * chineseRatio / MIN_CHINESE_RATIO),
      message: `中文字符占比 ${(chineseRatio * 100).toFixed(1)}% < 最低 ${(MIN_CHINESE_RATIO * 100)}%`,
    });
  }

  // 3. Content length (weight: 20pts)
  if (content.length >= MIN_CONTENT_LENGTH) {
    checks.push({
      name: '内容长度',
      passed: true,
      score: 20,
      message: `内容长度 ${content.length} 字符`,
    });
  } else {
    checks.push({
      name: '内容长度',
      passed: false,
      score: Math.round(20 * content.length / MIN_CONTENT_LENGTH),
      message: `内容过短 ${content.length} < ${MIN_CONTENT_LENGTH} 字符`,
    });
  }

  // 4. Line structure (weight: 15pts)
  if (lineCount >= MIN_LINE_COUNT) {
    let lineScore = 10; // Base score for having enough lines
    // Bonus for reasonable line structure
    if (shortLineRatio <= MAX_SHORT_LINE_RATIO) {
      lineScore += 5;
    } else {
      lineScore -= 3;
    }
    checks.push({
      name: '行结构',
      passed: lineScore >= 8,
      score: Math.max(0, Math.min(15, lineScore)),
      message: `${lineCount} 行, 平均 ${Math.round(avgLineLength)} 字/行, ${paragraphCount} 段`,
    });
  } else {
    checks.push({
      name: '行结构',
      passed: false,
      score: 0,
      message: `行数不足: ${lineCount} < ${MIN_LINE_COUNT}`,
    });
  }

  // 5. Chapter completeness (weight: 10pts)
  checks.push(checkChapterCompleteness(content, expectedMinLength, expectedMaxLength));

  // Calculate overall health score
  const healthScore = checks.reduce((sum, c) => sum + c.score, 0);

  // Determine grade
  let grade: ContentValidationResult['grade'];
  if (healthScore >= 80) grade = 'A';
  else if (healthScore >= 60) grade = 'B';
  else if (healthScore >= 40) grade = 'C';
  else if (healthScore >= 20) grade = 'D';
  else grade = 'F';

  // Determine acceptability (score >= 40 and no critical encoding issues)
  const isAcceptable = healthScore >= 40 && garbledRatio < 0.1;

  // Recommend encoding retry if garbled text detected
  let recommendRetryWithEncoding: string | undefined;
  if (garbledRatio > 0.01) {
    // If content has typical GBK→UTF-8 mojibake, recommend GBK
    if (/锟|斤拷|鐢|鍦|棰/.test(content)) {
      recommendRetryWithEncoding = 'gbk';
    } else if (/Ｆｕｌｌ/.test(content)) {
      recommendRetryWithEncoding = 'big5';
    }
  }

  return {
    healthScore,
    grade,
    isAcceptable,
    checks,
    encodingIssues,
    recommendRetryWithEncoding,
  };
}

/**
 * Quick check if content appears to be garbled/corrupted.
 * Fast version for use in scraping pipelines without full validation.
 */
export function isContentGarbled(content: string): boolean {
  if (content.length < 50) return true;

  const { garbledRatio } = detectGarbledText(content);
  if (garbledRatio > 0.1) return true;

  const { chineseRatio } = analyzeChineseContent(content);
  // For Chinese novel content, if less than 10% Chinese chars, likely garbled
  if (chineseRatio < 0.1) return true;

  return false;
}
