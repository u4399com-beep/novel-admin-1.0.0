import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { safeJson, apiError, apiSuccess } from '@/lib/api-utils';

/**
 * POST /api/scrape-rules/clean-preview
 *
 * Accepts { html: string, config: CleanConfig } and returns cleaned text.
 * Used by the rule editor to preview cleaning results in real-time.
 * All processing is done server-side (no dependency on scraper-service).
 */
export const POST = withAuth(async function POST(request: NextRequest) {
  try {
    let body: { html?: string; config?: Record<string, unknown> };
    try {
      body = await safeJson(request);
    } catch {
      return apiError('请求数据格式错误', 400);
    }

    const { html, config } = body;

    if (!html || typeof html !== 'string') {
      return apiError('缺少 html 参数', 400);
    }

    // Limit input size to prevent abuse (max 50KB for preview)
    if (html.length > 50_000) {
      return apiError('HTML 内容过大，预览最大 50KB', 400);
    }

    // Server-side cleaning logic (mirrors scraper-service/cleaning.ts)
    const result = cleanHtmlServer(html, cleanConfig);

    return apiSuccess({
      cleaned: result,
      originalLength: html.length,
      cleanedLength: result.length,
      reductionPercent: html.length > 0
        ? Math.round((1 - result.length / extractText(html).length) * 100)
        : 0,
    });
  } catch (error) {
    console.error('[clean-preview] Error:', error);
    return apiError('内容清洗预览失败', 500);
  }
});

// ==================== Server-side Cleaning Logic ====================
// A lightweight version of the scraper-service cleaning module.
// We can't import from scraper-service (separate Bun project),
// so we duplicate the core logic here.

// Default ad patterns (same as scraper-service/cleaning.ts)
const DEFAULT_AD_PATTERNS = [
  '推广', '广告', '下载APP', '下载app',
  '关注公众号', '关注我们', '扫码关注', '微信扫码', '微信公众号',
  '永久网址', '最新网址', '记住网址', '本站最新', '本站永久',
  '首发域名', '记住本站域名', '请牢记', '请收藏',
  '本站网址', '无弹窗小说', '无弹窗阅读',
  '最快更新', '最新章节请', '最快更新速度',
  '章节末尾', '本章未完', '请记住',
  'TXT下载', '下载地址', '下载本', '全本下载', 'txt下载',
  '手机下载', 'APP下载', '下载app',
  '加入书签', '添加书签', '收藏本页', '收藏本站',
  '返回目录', '上一页', '下一页', '章节列表',
  '在线听书', '手机版阅读', '手机用户请',
  '如果您喜欢', '阅读请到',
  '笔趣阁', 'biquge', 'BIQUGE',
  '天才一秒记住', '一秒记住',
  '推荐本书', '本章说', '本章评论',
  '打赏', '投推荐票', '月票',
  '最新章节', '百度搜索', '记住本站',
  '本章最新章节', '请访问', '天才一秒',
  '请到', '请看', '请浏览', '继续阅读',
  '温馨提示', '热点推荐', '热门推荐',
  '用户上传', '本章由', '更多章节',
  '报错', '举报', '加入书架',
  '追书', '追更', '书友',
  '顶点小说', '小说XYZ', '小说大全',
  '全文阅读', '免费阅读', '在线阅读',
];

const AD_CSS_SELECTORS = [
  '[class*="ad"]', '[class*="Ad"]', '[class*="AD"]',
  '[class*="advert"]', '[class*="sponsor"]', '[class*="promo"]',
  '[class*="banner"]', '[class*="popup"]', '[class*="modal"]',
  '[class*="recommend"]', '[class*="tuijian"]', '[class*="guanggao"]',
  '[id*="ad"]', '[id*="Ad"]', '[id*="AD"]',
  '[id*="advert"]', '[id*="sponsor"]', '[id*="promo"]',
  '[id*="banner"]', '[id*="popup"]', '[id*="guanggao"]',
  '[class*="share"]', '[class*="social"]',
  '[id*="share"]', '[id*="social"]',
  '[class*="fixed-ad"]', '[class*="float-ad"]',
  '[class*="google-ad"]', '[class*="taboola"]',
  '[class*="outbrain"]', '[class*="cookie"]',
  '[class*="newsletter"]', '[class*="subscribe"]',
];

const WATERMARK_PATTERNS = [
  /[\[\u3010【]www\.[\w.-]+\.[\w]{2,}[\]\u3011】]/gi,
  /[-—]{2,}.*?(下一页|继续阅读|未完待续).*?[-—]{2,}/gi,
  /[\uff08(]\s*(?:https?:\/\/)?www\.[\w.-]+[\w\/][\uff09)]/gi,
  /最新章节请访问[^\n]{3,80}/gi,
  /手机用户请浏览[^\n]{3,80}(?:阅读|体验)/gi,
  /^\s*(?:https?:\/\/)?www\.[\w.-]+\.\w{2,}\s*$/gm,
  /^\s*本章[完结束]\s*$/gm,
  /www\.[\w.-]+\.\w{2,}[^\n]{0,30}(?:最新|更新|章节|阅读|小说|无弹窗)/gi,
  /笔趣阁[^\n]{0,50}(?:更新|最新|最快)/gi,
  /天才一秒记住[^\n]{3,80}/gi,
  /无弹窗小说[^\n]{0,50}/gi,
  /最快更新速度[^\n]{0,50}/gi,
  /^\s*推荐本书[^\n]*$/gm,
  /^\s*打赏[^\n]*$/gm,
  /^\s*投推荐票[^\n]*$/gm,
  /^\s*扫码关注[^\n]*$/gm,
  /^\s*微信[^\n]{0,20}$/gm,
  /^\s*[，,。.！!？?、；;：:]+\s*$/gm,
  /[\[\u3010【](?:\d{1,3}\.){3}\d{1,3}[\]\u3011】]/g,
  /^\s*https?:\/\/[^\s]+\s*$/gm,
  /^\s*[-=]{5,}\s*$/gm,
  /^\s*第\d+页\s*\/\s*共\d+页\s*$/gm,
  /^\s*page\s+\d+\s+of\s+\d+\s*$/gim,
  /^\s*本章未完[^\n]*$/gm,
  /^\s*[^\n]{2,20}手机(?:版|端)\s*$/gm,
  /(?:copyright|版权所有|所有权利保留|all rights reserved)/gi,
  /^\s*(?:更新时间|最后更新|update\s*time)[:：]?\s*[^\n]{0,50}$/gim,
  /本章来源于[^\n]{3,60}/gi,
  /首发(?:于|网站|域名)[^\n]{3,60}/gi,
  /^\s*请记住[^\n]{0,50}$/gm,
  /^\s*[\w.]+小说[^\n]{0,10}$/gm,
  /(?:最新网址|最新地址|记住网址|记住本站)[^\n]{0,60}/gi,
  /^\s*[。.！!？?~～…—-]{1,3}\s*$/gm,
];

function escapeCssString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\]/g, '\\]')
    .replace(/\[/g, '\\[')
    .replace(/\(/g, '\\(');
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePatterns(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((p): p is string => typeof p === 'string');
  if (typeof value === 'string') return value.split('\n').map(s => s.trim()).filter(Boolean);
  return [];
}

function extractText(html: string): string {
  // Quick text extraction without full cheerio parsing
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function applyWatermarkPatterns(text: string): string {
  for (const pattern of WATERMARK_PATTERNS) {
    text = text.replace(new RegExp(pattern.source, pattern.flags), '');
  }
  return text;
}

function filterAdLines(text: string, patterns: string[]): string {
  if (patterns.length === 0) return text;

  const lines = text.split('\n');
  return lines
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;

      let remaining = trimmed;
      const lowerRemaining = trimmed.toLowerCase();

      for (const pattern of patterns) {
        const lowerPattern = pattern.toLowerCase();
        if (lowerRemaining.includes(lowerPattern)) {
          const escaped = escapeRegExp(pattern);
          remaining = remaining.replace(new RegExp(escaped, 'gi'), '').trim();
        }
      }

      if (remaining.length < 20) return false;
      const contentChars = remaining.replace(/[\s，,。.！!？?、；;：:\-—_\[\]【】()（）\d]/g, '');
      if (contentChars.length < 10) return false;
      return true;
    })
    .join('\n');
}

function removeRemnantLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      const chineseChars = (trimmed.match(/[\u4e00-\u9fff]/g) || []).length;
      if (trimmed.length < 5 && chineseChars === 0) return false;
      if (chineseChars === 0 && trimmed.length < 8) return false;
      if (/^\d+$/.test(trimmed) && trimmed.length < 10) return false;
      return true;
    })
    .join('\n');
}

function deduplicateParagraphs(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let lastNormalized = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { result.push(line); continue; }

    const normalized = trimmed
      .replace(/[，,。.！!？?、；;：:]+$/, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (normalized && normalized === lastNormalized) continue;

    if (lastNormalized.length > 20 && normalized.length > 20) {
      const overlapLen = Math.min(lastNormalized.length, normalized.length);
      const checkLen = Math.min(25, overlapLen);
      const shorterLen = Math.min(lastNormalized.length, normalized.length);
      if (checkLen >= 15 && checkLen / shorterLen > 0.3 && lastNormalized.slice(-checkLen) === normalized.slice(0, checkLen)) {
        const prev = result.pop() || '';
        result.push(prev + trimmed);
        lastNormalized = (prev + trimmed).replace(/[，,。.！!？?、；;：:]+$/, '').replace(/\s+/g, ' ').trim();
        continue;
      }
    }

    result.push(line);
    lastNormalized = normalized;
  }
  return result.join('\n');
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Validate a regex pattern for safety (detect ReDoS-vulnerable patterns).
 * Rejects patterns with nested quantifiers or excessive backtracking potential.
 */
function isSafeRegexPattern(pattern: string): boolean {
  // Reject patterns that are too long
  if (pattern.length > 200) return false;
  // Detect nested quantifiers: (a+)+, (a*)*, (a{2,})+ etc.
  if (/(\([^)]*[+*][^)]*\)[+*{]|\[[^\]]*[+*][^\]]*\][+*{])/.test(pattern)) return false;
  // Detect overlapping alternations with quantifiers: (a|b)+, (a|b)*
  if (/\([^)]*\|.\)[+*]/.test(pattern)) return false;
  return true;
}

function cleanHtmlServer(html: string, config: Record<string, unknown>): string {
  const adPatterns = normalizePatterns(config.adPatterns);
  const removeSelectors = normalizePatterns(config.removeSelectors);
  const removePatterns = normalizePatterns(config.removePatterns);
  const allAdPatterns = [...DEFAULT_AD_PATTERNS];
  if (adPatterns.length > 0) allAdPatterns.push(...adPatterns);

  // Step 1: Simple HTML-level cleaning (strip tags)
  let text = extractText(html);

  // Step 2: Apply watermark regex patterns
  text = applyWatermarkPatterns(text);

  // Step 3: Remove custom text/regex patterns (with ReDoS protection)
  if (removePatterns.length > 0) {
    for (const pattern of removePatterns) {
      if (!isSafeRegexPattern(pattern)) continue; // Skip potentially dangerous patterns
      try {
        text = text.replace(new RegExp(pattern, 'gi'), '');
      } catch { /* invalid regex, skip */ }
    }
  }

  // Step 4: Filter ad lines
  text = filterAdLines(text, allAdPatterns);

  // Step 5: Remove remnant lines
  text = removeRemnantLines(text);

  // Step 6: Deduplicate paragraphs
  text = deduplicateParagraphs(text);

  // Step 7: Normalize whitespace
  text = normalizeWhitespace(text);

  return text;
}
