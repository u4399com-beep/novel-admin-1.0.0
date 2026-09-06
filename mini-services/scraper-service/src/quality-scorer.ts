/**
 * Data Quality Scoring System for scraper tasks
 * Evaluates 9 dimensions of scraping quality, producing a 0-100 score with A-F grade.
 * Reports are stored in memory (bounded ring buffer) for recent-query API.
 *
 * Dimensions (100pts total):
 *   1. Success Rate       (12pts)  - newBooks/totalBooks ratio
 *   2. Content Coverage   (12pts)  - newChapters/totalChapters ratio
 *   3. Failure Rate       (12pts)  - failedItems/total ratio
 *   4. Content Quality    (16pts)  - avg word count, empty chapter rate, anomaly detection
 *   5. Completeness       (12pts)  - books-to-chapters ratio
 *   6. Efficiency         ( 8pts)  - items per minute
 *   7. Engine Match       ( 8pts)  - known engine used
 *   8. Content Freshness  (10pts)  - date references in content (NEW)
 *   9. Structural Complete(10pts)  - title, author, description, chapters, cover (NEW)
 */

import type { QualityCheck, QualityReport, ScrapeResult } from './types';

/** Max reports kept in memory */
const MAX_REPORTS = 200;

export class QualityScorer {
  private reports: QualityReport[] = [];

  /**
   * Calculate quality score based on task result.
   * @param taskId - The task identifier
   * @param result - Scraping result statistics
   * @param chapters - Optional array of chapter info for content quality check
   */
  score(
    taskId: string,
    result: ScrapeResult,
    chapters?: Array<{ title: string; wordCount: number }>,
  ): QualityReport {
    const checks: QualityCheck[] = [];

    // 1. Success Rate (12pts): newBooks / (totalBooks - failedItems) > 90%
    checks.push(this.checkSuccessRate(result));

    // 2. Content Coverage (12pts): newChapters / totalChapters > 85%
    checks.push(this.checkContentCoverage(result));

    // 3. Failure Rate (12pts): failedItems < 5% of total items
    checks.push(this.checkFailureRate(result));

    // 4. Content Quality (16pts): avg wordCount > 500, < 50% empty chapters
    checks.push(this.checkContentQuality(result, chapters));

    // 5. Completeness (12pts): ratio of new books with chapters
    checks.push(this.checkCompleteness(result));

    // 6. Efficiency (8pts): duration vs items (items/minute)
    checks.push(this.checkEfficiency(result));

    // 7. Engine Match (8pts): was a reasonable engine used
    checks.push(this.checkEngineMatch(result));

    // 8. Content Freshness (10pts): date references in content indicate recency
    checks.push(this.checkContentFreshness(result));

    // 9. Structural Completeness (10pts): title, author, description, chapters, cover
    checks.push(this.checkStructuralCompleteness(result));

    const overallScore = checks.reduce((sum, c) => sum + c.score, 0);
    const grade = this.toGrade(overallScore);
    const summary = this.generateSummary(checks, overallScore, grade);

    const report: QualityReport = {
      taskId,
      overallScore,
      grade,
      checks,
      summary,
      timestamp: new Date().toISOString(),
    };

    // Store in ring buffer
    this.reports.push(report);
    if (this.reports.length > MAX_REPORTS) {
      this.reports.shift();
    }

    return report;
  }

  /** Get recent quality reports */
  getRecentReports(limit: number = 10): QualityReport[] {
    return this.reports.slice(-limit).reverse();
  }

  /** Get aggregate quality stats */
  getAggregateStats(limit: number = 20): {
    avgScore: number;
    totalReports: number;
    gradeDistribution: Record<string, number>;
    recentReports: QualityReport[];
  } {
    const total = this.reports.length;
    if (total === 0) {
      return {
        avgScore: 0,
        totalReports: 0,
        gradeDistribution: { A: 0, B: 0, C: 0, D: 0, F: 0 },
        recentReports: [],
      };
    }

    const gradeDistribution: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 };
    let scoreSum = 0;
    for (const r of this.reports) {
      scoreSum += r.overallScore;
      gradeDistribution[r.grade] = (gradeDistribution[r.grade] || 0) + 1;
    }

    return {
      avgScore: Math.round(scoreSum / total * 10) / 10,
      totalReports: total,
      gradeDistribution,
      recentReports: this.reports.slice(-limit).reverse(),
    };
  }

  /** Find a report by taskId */
  getReportByTask(taskId: string): QualityReport | undefined {
    // Most recent first
    for (let i = this.reports.length - 1; i >= 0; i--) {
      if (this.reports[i].taskId === taskId) return this.reports[i];
    }
    return undefined;
  }

  // ==================== Individual Checks ====================

  /** 1. Success Rate (12pts): newBooks / totalBooks > 90%
   * Note: totalBooks only counts successfully processed books (failed books are excluded).
   * So the rate measures "what fraction of processed books are new?" which is a meaningful
   * quality metric. We do NOT subtract failedItems here because failedItems includes
   * chapter-level failures that have nothing to do with book success rate. */
  private checkSuccessRate(result: ScrapeResult): QualityCheck {
    if (result.totalBooks <= 0) {
      // No books processed at all
      return { name: '成功率', passed: false, score: 0, message: '无有效书籍数据' };
    }

    const rate = Math.min(result.newBooks, result.totalBooks) / result.totalBooks;
    let score: number;
    let passed: boolean;

    if (rate >= 0.9) {
      score = 12;
      passed = true;
    } else if (rate >= 0.7) {
      score = 9;
      passed = true;
    } else if (rate >= 0.5) {
      score = 6;
      passed = false;
    } else {
      score = Math.round(rate * 12); // 0-12
      passed = false;
    }

    return {
      name: '成功率',
      passed,
      score,
      message: `新增率 ${(rate * 100).toFixed(1)}%（${result.newBooks}/${result.totalBooks}）`,
    };
  }

  /** 2. Content Coverage (12pts): newChapters / totalChapters > 85% */
  private checkContentCoverage(result: ScrapeResult): QualityCheck {
    if (result.totalChapters === 0) {
      if (result.failedItems > 0 && result.totalBooks > 0) {
        return { name: '内容覆盖率', passed: false, score: 2, message: '所有章节采集失败' };
      }
      return { name: '内容覆盖率', passed: true, score: 10, message: '无章节数据（可能为列表模式）' };
    }

    const rate = result.newChapters / result.totalChapters;
    let score: number;
    let passed: boolean;

    if (rate >= 0.85) {
      score = 12;
      passed = true;
    } else if (rate >= 0.6) {
      score = 8;
      passed = true;
    } else if (rate >= 0.3) {
      score = 5;
      passed = false;
    } else {
      score = Math.round(rate * 16); // 0-16, capped at 12 below
      passed = false;
    }

    score = Math.min(12, score);

    return {
      name: '内容覆盖率',
      passed,
      score,
      message: `章节新增率 ${(rate * 100).toFixed(1)}%（${result.newChapters}/${result.totalChapters}）`,
    };
  }

  /** 3. Failure Rate (12pts): failedItems < 5% of total */
  private checkFailureRate(result: ScrapeResult): QualityCheck {
    const total = result.totalBooks + result.totalChapters + result.failedItems;
    if (total === 0) {
      return { name: '失败率', passed: true, score: 12, message: '无数据项，不适用' };
    }

    const failRate = result.failedItems / total;
    let score: number;
    let passed: boolean;

    if (failRate <= 0.05) {
      score = 12;
      passed = true;
    } else if (failRate <= 0.1) {
      score = 9;
      passed = true;
    } else if (failRate <= 0.2) {
      score = 6;
      passed = false;
    } else {
      score = Math.max(0, Math.round((1 - failRate) * 12));
      passed = false;
    }

    return {
      name: '失败率',
      passed,
      score,
      message: `失败 ${result.failedItems} 项（${(failRate * 100).toFixed(1)}%）`,
    };
  }

  /** 4. Content Quality (16pts): avg wordCount > 500, < 50% empty chapters, detect anomalies */
  private checkContentQuality(
    result: ScrapeResult,
    chapters?: Array<{ title: string; wordCount: number }>,
  ): QualityCheck {
    if (!chapters || chapters.length === 0) {
      // Without chapter detail, give a neutral score based on newChapters > 0
      const hasChapters = result.newChapters > 0;
      return {
        name: '内容质量',
        passed: hasChapters,
        score: hasChapters ? 10 : 5,
        message: hasChapters ? '有新增章节（未提供详细字数数据）' : '无新增章节内容',
      };
    }

    let score = 0;
    const totalWordCount = chapters.reduce((sum, c) => sum + c.wordCount, 0);
    const avgWordCount = chapters.length > 0 ? totalWordCount / chapters.length : 0;
    const emptyChapters = chapters.filter(c => c.wordCount < 50).length;
    const emptyRate = emptyChapters / chapters.length;

    // Anomaly detection: chapters with suspiciously identical word counts
    // (e.g., all chapters exactly 0 or all exactly the same placeholder length)
    const wordCountSet = new Set(chapters.map(c => c.wordCount));
    const uniformWordCount = wordCountSet.size === 1 && chapters.length > 10;
    // Anomaly: all chapters are very short (< 100 chars)
    const allVeryShort = chapters.length > 0 && chapters.every(c => c.wordCount < 100);

    // Avg word count check (8pts)
    if (avgWordCount >= 500) {
      score += 8;
    } else if (avgWordCount >= 200) {
      score += 6;
    } else if (avgWordCount >= 50) {
      score += 3;
    }
    // else 0

    // Empty chapter rate check (8pts)
    if (emptyRate <= 0.05) {
      score += 8;
    } else if (emptyRate <= 0.2) {
      score += 6;
    } else if (emptyRate <= 0.5) {
      score += 3;
    }
    // else 0

    // Penalty for anomalies
    if (uniformWordCount) {
      score = Math.max(0, score - 3); // All chapters same length = likely placeholder
    }
    if (allVeryShort) {
      score = Math.max(0, score - 2); // All chapters suspiciously short
    }

    // Build detailed message
    const parts: string[] = [];
    parts.push(`平均 ${Math.round(avgWordCount)} 字/章`);
    parts.push(`空章节 ${emptyChapters}/${chapters.length}（${(emptyRate * 100).toFixed(1)}%）`);
    if (uniformWordCount) parts.push('⚠ 字数完全一致');
    if (allVeryShort) parts.push('⚠ 所有章节过短');

    const passed = score >= 10;
    return {
      name: '内容质量',
      passed,
      score,
      message: parts.join('，'),
    };
  }

  /** 5. Completeness (12pts): newBooks > 0 and newChapters/newBooks ratio reasonable */
  private checkCompleteness(result: ScrapeResult): QualityCheck {
    if (result.newBooks === 0 && result.totalBooks === 0) {
      return { name: '完整性', passed: false, score: 0, message: '未采集到任何书籍' };
    }

    if (result.newBooks > 0 && result.totalChapters === 0) {
      // Books found but no chapters — likely a list-only mode
      return {
        name: '完整性',
        passed: true,
        score: 8,
        message: `新增 ${result.newBooks} 本书（列表模式，未采集章节）`,
      };
    }

    if (result.newBooks > 0 && result.newChapters > 0) {
      const chaptersPerBook = result.newChapters / result.newBooks;
      if (chaptersPerBook >= 5) {
        return { name: '完整性', passed: true, score: 12, message: `平均每书 ${chaptersPerBook.toFixed(1)} 章` };
      }
      if (chaptersPerBook >= 1) {
        return { name: '完整性', passed: true, score: 9, message: `平均每书 ${chaptersPerBook.toFixed(1)} 章` };
      }
      return { name: '完整性', passed: false, score: 5, message: `平均每书仅 ${chaptersPerBook.toFixed(1)} 章` };
    }

    // Some books, some chapters but 0 new of one
    if (result.newBooks === 0 && result.newChapters > 0) {
      return { name: '完整性', passed: true, score: 8, message: `增量模式：新增 ${result.newChapters} 章` };
    }

    return { name: '完整性', passed: false, score: 3, message: '数据不完整' };
  }

  /** 6. Efficiency (8pts): items processed per minute */
  private checkEfficiency(result: ScrapeResult): QualityCheck {
    if (!result.duration || result.duration < 1000) {
      return { name: '效率', passed: true, score: 7, message: '执行时间过短，不评估' };
    }

    const totalItems = result.newBooks + result.newChapters;
    if (totalItems === 0) {
      return { name: '效率', passed: false, score: 0, message: '无有效产出项' };
    }

    const itemsPerMinute = (totalItems / result.duration) * 60000;
    let score: number;
    let passed: boolean;

    if (itemsPerMinute >= 30) {
      score = 8;
      passed = true;
    } else if (itemsPerMinute >= 10) {
      score = 7;
      passed = true;
    } else if (itemsPerMinute >= 3) {
      score = 4;
      passed = true;
    } else {
      score = 2;
      passed = false;
    }

    const durationSec = (result.duration / 1000).toFixed(0);
    return {
      name: '效率',
      passed,
      score,
      message: `${itemsPerMinute.toFixed(1)} 项/分钟（${durationSec}秒完成 ${totalItems} 项）`,
    };
  }

  /** 7. Engine Match (8pts): was a reasonable engine used */
  private checkEngineMatch(result: ScrapeResult): QualityCheck {
    // Basic heuristic: cheerio is fine for most static sites
    // Playwright/obscura are preferred for JS-heavy sites
    // External engines are fine if they work
    const engine = result.engine || 'cheerio';
    const knownEngines = ['cheerio', 'playwright', 'firecrawl', 'agentql', 'cloud-browser', 'scrapling', 'obscura'];

    if (knownEngines.includes(engine)) {
      return { name: '引擎匹配', passed: true, score: 8, message: `使用 ${engine} 引擎` };
    }

    // Unknown engine but task succeeded — give partial credit
    if (result.newBooks > 0 || result.newChapters > 0) {
      return { name: '引擎匹配', passed: true, score: 6, message: `使用自定义引擎 ${engine}，有产出` };
    }

    return { name: '引擎匹配', passed: false, score: 3, message: `未知引擎 ${engine}，无产出` };
  }

  // ==================== New Scoring Dimensions ====================

  /**
   * 8. Content Freshness (10pts)
   * Checks if scraped content contains date references and scores based on recency.
   * Uses result.contentSample (optional chapter text) to detect date patterns.
   */
  private checkContentFreshness(result: ScrapeResult): QualityCheck {
    const content = result.contentSample;
    if (!content || content.length < 20) {
      // No content sample available — give neutral score
      return { name: '内容时效', passed: true, score: 5, message: '无内容样本，不评估' };
    }

    const now = Date.now();
    const DAY_MS = 86_400_000;

    // Date patterns to detect in content (Chinese and Western formats)
    const datePatterns = [
      // YYYY年MM月DD日 or YYYY年MM月
      /((?:20|19)\d{2})\s*年\s*(\d{1,2})\s*月/g,
      // YYYY-MM-DD or YYYY/MM/DD or YYYY.MM.DD
      /((?:20|19)\d{2})[\-\/\.](\d{1,2})[\-\/\.](\d{1,2})/g,
      // Mon YYYY (Jan 2025, February 2025, etc.)
      /(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+((?:20|19)\d{2})/gi,
      // YYYY-MM or YYYY/MM
      /((?:20|19)\d{2})[\-\/](\d{1,2})(?![\-\/\d])/g,
    ];

    let mostRecentDate: Date | null = null;

    for (const pattern of datePatterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        try {
          let year: number;
          let month: number;
          let day = 1;

          // Determine which capture groups contain year/month/day
          // Pattern 1: (year)年(month)月
          if (match[0].includes('年')) {
            year = parseInt(match[1], 10);
            month = parseInt(match[2], 10) - 1; // JS months are 0-based
          }
          // Pattern 3: Mon YYYY (month name, year in match[1])
          else if (/[A-Za-z]/.test(match[0]) && match[1] && match[1].length === 4) {
            year = parseInt(match[1], 10);
            const matchText = match[0].toLowerCase();
            const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
            const monthIdx = monthNames.findIndex(m => matchText.startsWith(m));
            month = monthIdx >= 0 ? monthIdx : 0;
          }
          // Patterns 2 & 4: YYYY-MM-DD or YYYY-MM
          else {
            year = parseInt(match[1], 10);
            month = parseInt(match[2], 10) - 1;
            if (match[3]) day = parseInt(match[3], 10);
          }

          if (year >= 2020 && year <= 2099 && month >= 0 && month <= 11 && day >= 1 && day <= 31) {
            const date = new Date(year, month, day);
            if (!mostRecentDate || date > mostRecentDate) {
              mostRecentDate = date;
            }
          }
        } catch {
          // Skip unparseable matches
        }
      }
    }

    if (!mostRecentDate) {
      return { name: '内容时效', passed: true, score: 5, message: '未检测到日期信息' };
    }

    const ageMs = now - mostRecentDate.getTime();
    const ageDays = ageMs / DAY_MS;

    let score: number;
    let passed: boolean;

    if (ageDays <= 30) {
      // Within last 30 days → 8-10 (proportional)
      score = 8 + Math.round((1 - ageDays / 30) * 2);
      passed = true;
    } else if (ageDays <= 90) {
      // Within last 90 days → 5-7
      score = 5 + Math.round((1 - (ageDays - 30) / 60) * 2);
      passed = true;
    } else if (ageDays <= 365) {
      // Within last year → 3-4
      score = 3 + Math.round((1 - (ageDays - 90) / 275) * 1);
      passed = false;
    } else {
      // Older than 1 year → 0-2
      score = Math.max(0, 2 - Math.round(Math.min(ageDays - 365, 365) / 365 * 2));
      passed = false;
    }

    // Clamp to the 10-point dimension max — future-dated content (ageDays < 0, e.g.
    // "2026年最新网址" ads or pre-dated posts) would otherwise inflate the score far above 10
    score = Math.max(0, Math.min(10, score));

    const dateStr = mostRecentDate.toISOString().slice(0, 10);
    const ageStr = ageDays < 1 ? '今天' : ageDays < 30 ? `${Math.round(ageDays)}天前` : ageDays < 365 ? `${Math.round(ageDays / 30)}个月前` : `${(ageDays / 365).toFixed(1)}年前`;
    return {
      name: '内容时效',
      passed,
      score,
      message: `最近日期 ${dateStr}（${ageStr}）`,
    };
  }

  /**
   * 9. Structural Completeness (10pts)
   * Checks if the extracted content has all expected book metadata fields.
   * Each field present: title (2pts), author (2pts), description (2pts), chapters (2pts), cover (2pts).
   */
  private checkStructuralCompleteness(result: ScrapeResult): QualityCheck {
    let score = 0;
    const missing: string[] = [];

    // Title check (2pts)
    if (result.bookMeta?.title) {
      score += 2;
    } else {
      missing.push('标题');
    }

    // Author check (2pts)
    if (result.bookMeta?.author) {
      score += 2;
    } else {
      missing.push('作者');
    }

    // Description check (2pts)
    if (result.bookMeta?.description) {
      score += 2;
    } else {
      missing.push('简介');
    }

    // Chapters check (2pts)
    if (result.totalChapters > 0 || result.newChapters > 0) {
      score += 2;
    } else {
      missing.push('章节');
    }

    // Cover check (2pts)
    if (result.bookMeta?.coverUrl) {
      score += 2;
    } else {
      missing.push('封面');
    }

    // If no bookMeta was provided at all, give neutral score
    if (!result.bookMeta && result.totalChapters === 0 && result.newChapters === 0) {
      return { name: '结构完整', passed: true, score: 5, message: '无元数据，不评估' };
    }

    const passed = score >= 8;
    const message = missing.length === 0
      ? '所有字段完整（标题、作者、简介、章节、封面）'
      : `缺失：${missing.join('、')}（${score}/10）`;

    return { name: '结构完整', passed, score, message };
  }

  // ==================== Helpers ====================

  private toGrade(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
    if (score >= 85) return 'A';
    if (score >= 70) return 'B';
    if (score >= 50) return 'C';
    if (score >= 30) return 'D';
    return 'F';
  }

  private generateSummary(checks: QualityCheck[], score: number, grade: string): string {
    const failed = checks.filter(c => !c.passed);
    if (failed.length === 0) {
      return `所有检查通过，数据质量优秀 (${grade})`;
    }
    const names = failed.map(c => c.name).join('、');
    if (score >= 70) {
      return `${names} 需关注，整体质量良好 (${grade})`;
    }
    if (score >= 50) {
      return `${names} 未达标，建议检查采集规则 (${grade})`;
    }
    return `${names} 严重不足，采集质量较差 (${grade})`;
  }
}

/** Singleton instance */
export const qualityScorer = new QualityScorer();

// ==================== Round 2: Multi-Language Content Detection ====================

/**
 * Detect the language of content text.
 * Supports Chinese (CN/TW), Japanese, Korean, and English.
 * Uses Unicode range detection and character frequency analysis.
 */
export function detectContentLanguage(text: string): {
  primary: 'zh-CN' | 'zh-TW' | 'ja' | 'ko' | 'en' | 'unknown';
  confidence: number;
  distribution: Record<string, number>;
} {
  if (!text || text.length < 10) {
    return { primary: 'unknown', confidence: 0, distribution: {} };
  }

  const sample = text.slice(0, 5000); // Sample first 5000 chars for performance
  const distribution: Record<string, number> = { 'zh-CN': 0, 'zh-TW': 0, 'ja': 0, 'ko': 0, 'en': 0, 'other': 0 };

  for (const ch of sample) {
    const code = ch.codePointAt(0)!;

    // Simplified Chinese (CJK Unified Ideographs — most common in CN)
    // Traditional Chinese uses same range but different frequency
    if (code >= 0x4E00 && code <= 0x9FFF) {
      // Use heuristic: certain characters are more common in traditional Chinese
      const tradChars = '國說學會對開於這裡個們來過時沒說請讓點書與氣還錢車長東';
      if (tradChars.includes(ch)) {
        distribution['zh-TW']++;
      } else {
        distribution['zh-CN']++;
      }
    }
    // Japanese Hiragana & Katakana
    else if ((code >= 0x3040 && code <= 0x309F) || (code >= 0x30A0 && code <= 0x30FF)) {
      distribution['ja']++;
    }
    // Korean Hangul
    else if (code >= 0xAC00 && code <= 0xD7AF) {
      distribution['ko']++;
    }
    // English/Latin
    else if ((code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A)) {
      distribution['en']++;
    }
    else {
      distribution['other']++;
    }
  }

  // Find dominant language
  const total = Object.values(distribution).reduce((a, b) => a + b, 0);
  if (total === 0) return { primary: 'unknown', confidence: 0, distribution };

  // Normalize distribution
  const normalized: Record<string, number> = {};
  for (const [lang, count] of Object.entries(distribution)) {
    normalized[lang] = count / total;
  }

  // Find primary (excluding 'other')
  let maxLang = 'en';
  let maxCount = 0;
  for (const [lang, count] of Object.entries(distribution)) {
    if (lang === 'other') continue;
    if (count > maxCount) {
      maxCount = count;
      maxLang = lang;
    }
  }

  const confidence = maxCount / total;

  return {
    primary: maxLang as 'zh-CN' | 'zh-TW' | 'ja' | 'ko' | 'en' | 'unknown',
    confidence,
    distribution: normalized,
  };
}

// ==================== Round 2: Anti-Crawl Decoy Content Detection ====================

/**
 * Detect anti-crawl decoy content — content served to bots that looks real
 * but is actually fake/garbled. Signs include:
 *   - Short repeated phrases (same sentence 5+ times)
 *   - Garbled/encoded text (high ratio of non-standard characters)
 *   - Lorem ipsum or placeholder text
 *   - Unusually uniform content (all paragraphs same length)
 *   - No meaningful sentence structure
 */
export function detectDecoyContent(text: string): {
  isDecoy: boolean;
  confidence: number;
  reasons: string[];
} {
  if (!text || text.length < 100) {
    return { isDecoy: false, confidence: 0, reasons: [] };
  }

  const reasons: string[] = [];
  let score = 0;

  // 1. Check for repeated phrases (same 20+ char sequence appearing 3+ times)
  const phrases = text.match(/[\u4e00-\u9fff\w\s,，。.]{20,}/g) || [];
  const phraseCounts = new Map<string, number>();
  for (const phrase of phrases) {
    const key = phrase.slice(0, 30);
    phraseCounts.set(key, (phraseCounts.get(key) || 0) + 1);
  }
  const repeatedPhrases = [...phraseCounts.entries()].filter(([, count]) => count >= 3);
  if (repeatedPhrases.length > 2) {
    reasons.push(`${repeatedPhrases.length} phrases repeated 3+ times`);
    score += 0.3;
  }

  // 2. Check for placeholder text
  const placeholderPatterns = /lorem ipsum|测试内容|placeholder|sample text|这是一段测试|暂无内容|正在更新/i;
  if (placeholderPatterns.test(text)) {
    reasons.push('Placeholder text detected');
    score += 0.4;
  }

  // 3. Check for garbled text (high ratio of non-standard characters)
  let nonStandardCount = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code > 0x9FFF && code < 0xF900) nonStandardCount++; // CJK Extension areas
    if (code >= 0xFDD0 && code <= 0xFDEF) nonStandardCount++; // Non-characters
  }
  const garbledRatio = nonStandardCount / text.length;
  if (garbledRatio > 0.1) {
    reasons.push(`High garbled text ratio: ${(garbledRatio * 100).toFixed(1)}%`);
    score += 0.3;
  }

  // 4. Check for uniform paragraph lengths (all same length = suspicious)
  const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 20);
  if (paragraphs.length >= 5) {
    const lengths = paragraphs.map(p => p.trim().length);
    const avgLen = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const variance = lengths.reduce((sum, l) => sum + Math.pow(l - avgLen, 2), 0) / lengths.length;
    const coeffOfVariation = Math.sqrt(variance) / avgLen;
    if (coeffOfVariation < 0.05) {
      reasons.push(`Suspiciously uniform paragraph lengths (CV: ${coeffOfVariation.toFixed(3)})`);
      score += 0.2;
    }
  }

  // 5. Check for very short content (decoy pages are often short)
  if (text.length < 200) {
    reasons.push('Content too short (< 200 chars)');
    score += 0.3;
  }

  return {
    isDecoy: score >= 0.4,
    confidence: Math.min(score, 1),
    reasons,
  };
}

// ==================== Round 2: Chapter Structural Validation ====================

/**
 * Validate that chapter content has proper structure.
 * Checks for: title present, has paragraphs, no HTML tags in text,
 * reasonable word count range, no binary/garbled content.
 */
export function validateChapterStructure(chapter: {
  title?: string;
  content?: string;
  wordCount?: number;
}): {
  valid: boolean;
  issues: string[];
  quality: 'good' | 'acceptable' | 'poor' | 'invalid';
} {
  const issues: string[] = [];

  // 1. Title must be present and non-empty
  if (!chapter.title || chapter.title.trim().length === 0) {
    issues.push('Missing chapter title');
  }

  // 2. Content must be present
  if (!chapter.content || chapter.content.trim().length === 0) {
    issues.push('Empty chapter content');
  } else {
    // 3. No HTML tags in text content (should have been cleaned)
    const htmlTagCount = (chapter.content.match(/<[^>]+>/g) || []).length;
    if (htmlTagCount > 3) {
      issues.push(`5+ HTML tags in content (${htmlTagCount} found) — cleaning may have failed`);
    }

    // 4. Must have paragraph breaks (single monolithic block is suspicious)
    const paragraphs = chapter.content.split(/\n\s*\n/).filter(p => p.trim().length > 0);
    if (paragraphs.length <= 1 && chapter.content.length > 500) {
      issues.push('No paragraph breaks in long content — possible extraction error');
    }

    // 5. Word count should match content length roughly
    if (chapter.wordCount !== undefined) {
      const actualLength = chapter.content.length;
      const ratio = chapter.wordCount / actualLength;
      if (ratio > 3 || ratio < 0.1) {
        issues.push(`Word count (${chapter.wordCount}) inconsistent with content length (${actualLength})`);
      }
    }

    // 6. Check for binary content (high ratio of non-printable characters)
    let nonPrintable = 0;
    for (const ch of chapter.content) {
      const code = ch.codePointAt(0)!;
      if (code < 0x20 && code !== 0x0A && code !== 0x0D && code !== 0x09) {
        nonPrintable++;
      }
    }
    if (nonPrintable / chapter.content.length > 0.01) {
      issues.push('Binary/non-printable content detected');
    }
  }

  const quality = issues.length === 0 ? 'good' : issues.length <= 1 ? 'acceptable' : issues.length <= 3 ? 'poor' : 'invalid';

  return {
    valid: issues.length <= 1,
    issues,
    quality,
  };
}

// ==================== Round 2: Content Freshness Comparison ====================

/**
 * Compare current content with a previous version to score freshness.
 * Uses text similarity (Jaccard on words) and structural comparison.
 */
export function compareContentFreshness(
  current: string,
  previous?: string,
): {
  isNew: boolean;
  similarity: number;
  addedChars: number;
  removedChars: number;
  freshnessScore: number;
} {
  if (!previous) {
    // No previous version — assume fresh
    return { isNew: true, similarity: 0, addedChars: current.length, removedChars: 0, freshnessScore: 100 };
  }

  if (current === previous) {
    // Identical — not fresh at all
    return { isNew: false, similarity: 1, addedChars: 0, removedChars: 0, freshnessScore: 0 };
  }

  // Jaccard similarity on word-level
  const toWords = (text: string) => new Set(text.slice(0, 10000).split(/[\s,，。.!?！？\n]+/).filter(w => w.length > 1));
  const currentWords = toWords(current);
  const previousWords = toWords(previous);

  const intersection = new Set([...currentWords].filter(w => previousWords.has(w)));
  const union = new Set([...currentWords, ...previousWords]);

  const similarity = union.size > 0 ? intersection.size / union.size : 0;

  // Character-level diff (approximation)
  const addedChars = Math.max(0, current.length - previous.length);
  const removedChars = Math.max(0, previous.length - current.length);

  // Freshness score: 100 = completely new, 0 = identical
  const freshnessScore = Math.round((1 - similarity) * 100);

  return {
    isNew: similarity < 0.95, // Less than 95% similar = considered new
    similarity,
    addedChars,
    removedChars,
    freshnessScore,
  };
}
