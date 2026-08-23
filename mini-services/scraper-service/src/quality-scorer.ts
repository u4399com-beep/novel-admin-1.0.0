/**
 * Data Quality Scoring System for scraper tasks
 * Evaluates 7 dimensions of scraping quality, producing a 0-100 score with A-F grade.
 * Reports are stored in memory (bounded ring buffer) for recent-query API.
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

    // 1. Success Rate (15pts): newBooks / (totalBooks - failedItems) > 90%
    checks.push(this.checkSuccessRate(result));

    // 2. Content Coverage (15pts): newChapters / totalChapters > 85%
    checks.push(this.checkContentCoverage(result));

    // 3. Failure Rate (15pts): failedItems < 5% of total items
    checks.push(this.checkFailureRate(result));

    // 4. Content Quality (20pts): avg wordCount > 500, < 50% empty chapters
    checks.push(this.checkContentQuality(result, chapters));

    // 5. Completeness (15pts): ratio of new books with chapters
    checks.push(this.checkCompleteness(result));

    // 6. Efficiency (10pts): duration vs items (items/minute)
    checks.push(this.checkEfficiency(result));

    // 7. Engine Match (10pts): was a reasonable engine used
    checks.push(this.checkEngineMatch(result));

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
  getAggregateStats(): {
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
      recentReports: this.reports.slice(-20).reverse(),
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

  /** 1. Success Rate (15pts): newBooks / totalBooks > 90%
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
      score = 15;
      passed = true;
    } else if (rate >= 0.7) {
      score = 11;
      passed = true;
    } else if (rate >= 0.5) {
      score = 7;
      passed = false;
    } else {
      score = Math.round(rate * 14); // 0-14
      passed = false;
    }

    return {
      name: '成功率',
      passed,
      score,
      message: `新增率 ${(rate * 100).toFixed(1)}%（${result.newBooks}/${result.totalBooks}）`,
    };
  }

  /** 2. Content Coverage (15pts): newChapters / totalChapters > 85% */
  private checkContentCoverage(result: ScrapeResult): QualityCheck {
    if (result.totalChapters === 0) {
      // May not have chapter data (list-only mode)
      return { name: '内容覆盖率', passed: true, score: 12, message: '无章节数据（可能为列表模式）' };
    }

    const rate = result.newChapters / result.totalChapters;
    let score: number;
    let passed: boolean;

    if (rate >= 0.85) {
      score = 15;
      passed = true;
    } else if (rate >= 0.6) {
      score = 10;
      passed = true;
    } else if (rate >= 0.3) {
      score = 6;
      passed = false;
    } else {
      score = Math.round(rate * 20); // 0-20, capped at 15 below
      passed = false;
    }

    score = Math.min(15, score);

    return {
      name: '内容覆盖率',
      passed,
      score,
      message: `章节新增率 ${(rate * 100).toFixed(1)}%（${result.newChapters}/${result.totalChapters}）`,
    };
  }

  /** 3. Failure Rate (15pts): failedItems < 5% of total */
  private checkFailureRate(result: ScrapeResult): QualityCheck {
    const total = result.totalBooks + result.totalChapters;
    if (total === 0) {
      return { name: '失败率', passed: true, score: 15, message: '无数据项，不适用' };
    }

    const failRate = result.failedItems / total;
    let score: number;
    let passed: boolean;

    if (failRate <= 0.05) {
      score = 15;
      passed = true;
    } else if (failRate <= 0.1) {
      score = 11;
      passed = true;
    } else if (failRate <= 0.2) {
      score = 7;
      passed = false;
    } else {
      score = Math.max(0, Math.round((1 - failRate) * 15));
      passed = false;
    }

    return {
      name: '失败率',
      passed,
      score,
      message: `失败 ${result.failedItems} 项（${(failRate * 100).toFixed(1)}%）`,
    };
  }

  /** 4. Content Quality (20pts): avg wordCount > 500, < 50% empty chapters, detect anomalies */
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
        score: hasChapters ? 12 : 6,
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
    const uniformWordCount = wordCountSet.size === 1 && chapters.length > 3;
    // Anomaly: all chapters are very short (< 100 chars)
    const allVeryShort = chapters.length > 0 && chapters.every(c => c.wordCount < 100);

    // Avg word count check (10pts)
    if (avgWordCount >= 500) {
      score += 10;
    } else if (avgWordCount >= 200) {
      score += 7;
    } else if (avgWordCount >= 50) {
      score += 4;
    }
    // else 0

    // Empty chapter rate check (10pts)
    if (emptyRate <= 0.05) {
      score += 10;
    } else if (emptyRate <= 0.2) {
      score += 7;
    } else if (emptyRate <= 0.5) {
      score += 3;
    }
    // else 0

    // Penalty for anomalies
    if (uniformWordCount) {
      score = Math.max(0, score - 4); // All chapters same length = likely placeholder
    }
    if (allVeryShort) {
      score = Math.max(0, score - 3); // All chapters suspiciously short
    }

    // Build detailed message
    const parts: string[] = [];
    parts.push(`平均 ${Math.round(avgWordCount)} 字/章`);
    parts.push(`空章节 ${emptyChapters}/${chapters.length}（${(emptyRate * 100).toFixed(1)}%）`);
    if (uniformWordCount) parts.push('⚠ 字数完全一致');
    if (allVeryShort) parts.push('⚠ 所有章节过短');

    const passed = score >= 12;
    return {
      name: '内容质量',
      passed,
      score,
      message: parts.join('，'),
    };
  }

  /** 5. Completeness (15pts): newBooks > 0 and newChapters/newBooks ratio reasonable */
  private checkCompleteness(result: ScrapeResult): QualityCheck {
    if (result.newBooks === 0 && result.totalBooks === 0) {
      return { name: '完整性', passed: false, score: 0, message: '未采集到任何书籍' };
    }

    if (result.newBooks > 0 && result.totalChapters === 0) {
      // Books found but no chapters — likely a list-only mode
      return {
        name: '完整性',
        passed: true,
        score: 10,
        message: `新增 ${result.newBooks} 本书（列表模式，未采集章节）`,
      };
    }

    if (result.newBooks > 0 && result.newChapters > 0) {
      const chaptersPerBook = result.newChapters / result.newBooks;
      if (chaptersPerBook >= 5) {
        return { name: '完整性', passed: true, score: 15, message: `平均每书 ${chaptersPerBook.toFixed(1)} 章` };
      }
      if (chaptersPerBook >= 1) {
        return { name: '完整性', passed: true, score: 11, message: `平均每书 ${chaptersPerBook.toFixed(1)} 章` };
      }
      return { name: '完整性', passed: false, score: 6, message: `平均每书仅 ${chaptersPerBook.toFixed(1)} 章` };
    }

    // Some books, some chapters but 0 new of one
    if (result.newBooks === 0 && result.newChapters > 0) {
      return { name: '完整性', passed: true, score: 10, message: `增量模式：新增 ${result.newChapters} 章` };
    }

    return { name: '完整性', passed: false, score: 3, message: '数据不完整' };
  }

  /** 6. Efficiency (10pts): items processed per minute */
  private checkEfficiency(result: ScrapeResult): QualityCheck {
    if (!result.duration || result.duration < 1000) {
      return { name: '效率', passed: true, score: 8, message: '执行时间过短，不评估' };
    }

    const totalItems = result.newBooks + result.newChapters;
    if (totalItems === 0) {
      return { name: '效率', passed: false, score: 0, message: '无有效产出项' };
    }

    const itemsPerMinute = (totalItems / result.duration) * 60000;
    let score: number;
    let passed: boolean;

    if (itemsPerMinute >= 30) {
      score = 10;
      passed = true;
    } else if (itemsPerMinute >= 10) {
      score = 8;
      passed = true;
    } else if (itemsPerMinute >= 3) {
      score = 5;
      passed = true;
    } else {
      score = 3;
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

  /** 7. Engine Match (10pts): was a reasonable engine used */
  private checkEngineMatch(result: ScrapeResult): QualityCheck {
    // Basic heuristic: cheerio is fine for most static sites
    // Playwright/obscura are preferred for JS-heavy sites
    // External engines are fine if they work
    const engine = result.engine || 'cheerio';
    const knownEngines = ['cheerio', 'playwright', 'firecrawl', 'agentql', 'cloud-browser', 'scrapling', 'obscura'];

    if (knownEngines.includes(engine)) {
      return { name: '引擎匹配', passed: true, score: 10, message: `使用 ${engine} 引擎` };
    }

    // Unknown engine but task succeeded — give partial credit
    if (result.newBooks > 0 || result.newChapters > 0) {
      return { name: '引擎匹配', passed: true, score: 7, message: `使用自定义引擎 ${engine}，有产出` };
    }

    return { name: '引擎匹配', passed: false, score: 4, message: `未知引擎 ${engine}，无产出` };
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
