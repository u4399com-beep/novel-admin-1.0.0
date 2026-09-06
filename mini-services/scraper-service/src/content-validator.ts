/**
 * Content Quality Validation
 *
 * Validates scraped content quality by checking for:
 *   - Garbled text and encoding errors
 *   - Chapter completeness (expected vs actual length)
 *   - Content health score based on Chinese character ratio, line count, etc.
 *   - Encoding detection (GBK/UTF-8)
 *   - Truncation detection (mid-sentence cutoff)
 *   - Anti-crawl content detection (CAPTCHA/error pages disguised as 200 OK)
 *   - Language detection (Chinese vs English error messages)
 *   - Duplicate content detection (same content served for different chapters)
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
  /** Detailed validation flags */
  flags: ValidationFlags;
  /** Detected content type (what this content actually is) */
  detectedContentType?: 'novel' | 'captcha' | 'error_page' | 'redirect' | 'login' | 'unknown';
}

export interface ValidationFlags {
  /** Content appears to be truncated mid-sentence */
  isTruncated: boolean;
  /** Content is actually a CAPTCHA/challenge page */
  isCaptchaPage: boolean;
  /** Content is an error page (404, 500, etc.) disguised as 200 OK */
  isErrorPage: boolean;
  /** Content is a redirect/interstitial page */
  isRedirectPage: boolean;
  /** Content is a login page */
  isLoginPage: boolean;
  /** Content is not Chinese (e.g. English error messages) */
  isNotChinese: boolean;
  /** Content matches another chapter (duplicate/wrong content) */
  isDuplicateContent: boolean;
  /** Encoding mismatch detected */
  encodingMismatch: boolean;
  /** Detected actual encoding */
  detectedEncoding?: 'utf-8' | 'gbk' | 'gb2312' | 'big5' | 'unknown';
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

  // ==================== Enhanced Validation Checks ====================

  const flags: ValidationFlags = {
    isTruncated: false,
    isCaptchaPage: false,
    isErrorPage: false,
    isRedirectPage: false,
    isLoginPage: false,
    isNotChinese: false,
    isDuplicateContent: false,
    encodingMismatch: false,
    detectedEncoding: 'utf-8',
  };

  let detectedContentType: ContentValidationResult['detectedContentType'] = 'novel';

  // 6. Truncation detection (content cut off mid-sentence)
  const lastChars = content.trim().slice(-50);
  const endsWithPunctuation = /[。！？」「”』）》】]/.test(lastChars);
  const endsMidSentence = !endsWithPunctuation && content.length > 500 &&
    /[^。！？」\n]$/.test(content.trim());
  if (endsMidSentence) {
    flags.isTruncated = true;
    checks.push({
      name: '截断检测',
      passed: false,
      score: 0,
      message: '内容可能在句中被截断（末尾无中文标点）',
    });
  } else {
    checks.push({
      name: '截断检测',
      passed: true,
      score: 5,
      message: '内容末尾有正常结束标点',
    });
  }

  // 7. Anti-crawl content detection (CAPTCHA/error pages as 200 OK)
  const lowerContent = content.toLowerCase();
  const captchaKeywords = ['captcha', '验证码', '请输入验证码', 'cloudflare', 'cf-challenge',
    'turnstile', '请完成验证', '人机验证', 'slider', '滑块验证'];
  const errorKeywords = ['not found', '404', '页面不存在', '服务器错误', 'internal error',
    'access denied', '拒绝访问', 'forbidden', '页面已删除', '页面找不到'];
  const redirectKeywords = ['正在跳转', 'redirecting', '请稍候', 'loading...',
    '如果页面没有自动跳转', '点击这里继续'];
  const loginKeywords = ['请登录', '登录后继续', 'login', 'sign in', '请先登录',
    '需要登录才能查看'];

  const captchaScore = captchaKeywords.filter(kw => lowerContent.includes(kw)).length;
  const errorScore = errorKeywords.filter(kw => lowerContent.includes(kw)).length;
  const redirectScore = redirectKeywords.filter(kw => lowerContent.includes(kw)).length;
  const loginScore = loginKeywords.filter(kw => lowerContent.includes(kw)).length;

  if (captchaScore >= 2 && chineseRatio < 0.2) {
    flags.isCaptchaPage = true;
    detectedContentType = 'captcha';
    checks.push({ name: '反爬检测', passed: false, score: 0, message: `检测到CAPTCHA/验证页面 (${captchaScore}个关键词)` });
  } else if (errorScore >= 2 && chineseRatio < 0.2) {
    flags.isErrorPage = true;
    detectedContentType = 'error_page';
    checks.push({ name: '反爬检测', passed: false, score: 0, message: `检测到错误页面 (${errorScore}个关键词)` });
  } else if (redirectScore >= 2 && content.length < 1000) {
    flags.isRedirectPage = true;
    detectedContentType = 'redirect';
    checks.push({ name: '反爬检测', passed: false, score: 0, message: `检测到跳转页面 (${redirectScore}个关键词)` });
  } else if (loginScore >= 2 && chineseRatio < 0.2) {
    flags.isLoginPage = true;
    detectedContentType = 'login';
    checks.push({ name: '反爬检测', passed: false, score: 0, message: `检测到登录页面 (${loginScore}个关键词)` });
  } else {
    checks.push({ name: '反爬检测', passed: true, score: 5, message: '未检测到反爬伪装页面' });
  }

  // 8. Language detection (is content actually Chinese?)
  if (chineseRatio < 0.1 && content.length > 200) {
    flags.isNotChinese = true;
    // Check if it's English error message
    const englishRatio = (content.match(/[a-zA-Z]/g) || []).length / content.length;
    if (englishRatio > 0.3) {
      checks.push({
        name: '语言检测',
        passed: false,
        score: 0,
        message: `内容为英文错误消息 (中文${(chineseRatio*100).toFixed(0)}%, 英文${(englishRatio*100).toFixed(0)}%)`,
      });
    } else {
      checks.push({
        name: '语言检测',
        passed: false,
        score: 2,
        message: `中文字符占比过低: ${(chineseRatio*100).toFixed(1)}%`,
      });
    }
  } else {
    checks.push({ name: '语言检测', passed: true, score: 5, message: `中文占比 ${(chineseRatio*100).toFixed(1)}%` });
  }

  // 9. Encoding detection
  if (/锟|斤拷|鐢|鍦|棰/.test(content)) {
    flags.encodingMismatch = true;
    flags.detectedEncoding = 'gbk';
  } else if (/Ｆｕｌｌ/.test(content)) {
    flags.encodingMismatch = true;
    flags.detectedEncoding = 'big5';
  }

  // Determine acceptability (score >= 40 and no critical encoding issues and not anti-crawl page)
  const hasAntiCrawlFlag = flags.isCaptchaPage || flags.isErrorPage || flags.isRedirectPage || flags.isLoginPage;
  const isAcceptable = healthScore >= 40 && garbledRatio < 0.1 && !hasAntiCrawlFlag;

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
    flags,
    detectedContentType,
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

// ==================== Duplicate Content Detection ====================

/** Simple content fingerprint for duplicate detection using first/last N chars + length */
export interface ContentFingerprint {
  first100: string;
  last100: string;
  length: number;
}

/** In-memory store for content fingerprints per task (for duplicate detection) */
const contentFingerprints = new Map<string, Map<string, ContentFingerprint>>();

/**
 * Generate a content fingerprint for duplicate detection.
 */
export function fingerprintContent(content: string): ContentFingerprint {
  return {
    first100: content.slice(0, 100),
    last100: content.slice(-100),
    length: content.length,
  };
}

/**
 * Check if content is a duplicate of another chapter in the same task.
 * Returns the chapter URL that has the same content, or undefined if unique.
 */
export function checkDuplicateContent(
  taskId: string,
  chapterUrl: string,
  content: string,
): string | undefined {
  if (!contentFingerprints.has(taskId)) {
    contentFingerprints.set(taskId, new Map());
  }
  const taskFingerprints = contentFingerprints.get(taskId)!;

  const fp = fingerprintContent(content);

  // Check against existing fingerprints
  for (const [existingUrl, existingFp] of taskFingerprints) {
    // Same length ±5% and matching first/last 100 chars = very likely duplicate
    const lengthRatio = fp.length / existingFp.length;
    if (lengthRatio > 0.95 && lengthRatio < 1.05 &&
        fp.first100 === existingFp.first100 &&
        fp.last100 === existingFp.last100) {
      return existingUrl;
    }
    // Same first 100 chars but different length could be partial duplicate
    if (fp.first100 === existingFp.first100 && fp.length > 500 && existingFp.length > 500) {
      // If first 100 chars match for long content, it's suspicious
      if (fp.last100 === existingFp.last100) {
        return existingUrl;
      }
    }
  }

  // Store this fingerprint
  taskFingerprints.set(chapterUrl, fp);
  return undefined;
}

/**
 * Clear content fingerprints for a task (call when task completes).
 */
export function clearContentFingerprints(taskId: string): void {
  contentFingerprints.delete(taskId);
}

/**
 * Quick anti-crawl content detection.
 * Fast check if a 200 OK response is actually a CAPTCHA, error, or redirect page.
 */
export function isAntiCrawlContent(content: string): boolean {
  if (content.length < 50) return true; // Suspiciously short

  const lower = content.toLowerCase();
  const quickKeywords = ['captcha', '验证码', 'cloudflare', 'cf-challenge',
    'turnstile', '请完成验证', '人机验证', 'access denied', 'forbidden'];

  // If 2+ anti-crawl keywords found AND low Chinese ratio, it's likely a trap page
  const matchCount = quickKeywords.filter(kw => lower.includes(kw)).length;
  if (matchCount >= 2) {
    const chineseCount = (content.match(/[\u4E00-\u9FFF]/g) || []).length;
    const chineseRatio = chineseCount / content.length;
    if (chineseRatio < 0.2) return true;
  }

  return false;
}
