/**
 * Intelligent Page Type Detection
 *
 * Detects what type of page we've received, even when it's not what we expected.
 * Critical for: detecting when anti-crawl redirects to a CAPTCHA page
 * disguised as 200 OK.
 *
 * Page types:
 *   - novel_list: list of novels with pagination
 *   - novel_detail: single novel info page
 *   - chapter_list: list of chapters
 *   - chapter_content: chapter text content
 *   - captcha: CAPTCHA/challenge page
 *   - login: login wall
 *   - error: server error page
 *   - redirect: redirect page (JS or meta)
 *   - blocked: access denied/rate limited
 *   - unknown: can't determine
 *
 * Detection uses HTML structure analysis:
 *   - Heading patterns (h1, h2, title)
 *   - Form detection (login forms, captcha forms)
 *   - Content patterns (text density, link density)
 *   - URL pattern hints
 *   - Status code signals
 */

import { logger } from './logger';
const log = logger.child('PageTypeDetector');

// ==================== Types ====================

export type PageType =
  | 'novel_list'
  | 'novel_detail'
  | 'chapter_list'
  | 'chapter_content'
  | 'captcha'
  | 'login'
  | 'error'
  | 'redirect'
  | 'blocked'
  | 'unknown';

export interface PageTypeResult {
  type: PageType;
  confidence: number;    // 0-1
  evidence: string[];    // Why we think this is the type
  alternatives: Array<{ type: PageType; confidence: number }>;
}

// ==================== Detection Patterns ====================

/** CAPTCHA indicators */
const CAPTCHA_PATTERNS = [
  // Cloudflare
  /cf-browser-verification/i,
  /cf-challenge-running/i,
  /challenge-platform/i,
  /cloudflare.*challenge/i,
  /Just a moment/i,
  /Checking your browser/i,
  /Please Wait.*Cloudflare/i,
  // Turnstile
  /cf-turnstile/i,
  /turnstile/i,
  // reCAPTCHA
  /recaptcha/i,
  /g-recaptcha/i,
  /google.*recaptcha/i,
  // hCaptcha
  /hcaptcha/i,
  /h-captcha/i,
  // Geetest
  /geetest/i,
  /gt_captcha/i,
  // Generic
  /captcha/i,
  /验证码/i,
  /请输入验证码/i,
  /安全验证/i,
  /人机验证/i,
  /robot.*check/i,
  /are.*you.*human/i,
  /prove.*you.*human/i,
  /anti-bot/i,
  /bot.detect/i,
  // Challenge iframe
  /challenge-form/i,
  /challenge-runner/i,
];

/** Login wall indicators */
const LOGIN_PATTERNS = [
  /login/i,
  /signin/i,
  /sign-in/i,
  /log-in/i,
  /请登录/i,
  /请先登录/i,
  /需要登录/i,
  /登录后查看/i,
  /登录后继续/i,
  /会员登录/i,
  /VIP.*登录/i,
  /register.*or.*login/i,
  /password.*required/i,
  /账号.*密码/i,
  /username.*password/i,
];

/** Blocked / access denied indicators */
const BLOCKED_PATTERNS = [
  /access.denied/i,
  /forbidden/i,
  /blocked/i,
  /rate.limit/i,
  /too.many.request/i,
  /请求过于频繁/i,
  /访问被拒绝/i,
  /已被封禁/i,
  /IP.*blocked/i,
  /暂时无法访问/i,
  /服务不可用/i,
  /服务暂时不可用/i,
  /您的访问频率过高/i,
];

/** Error page indicators */
const ERROR_PATTERNS = [
  /404/i,
  /500/i,
  /502/i,
  /503/i,
  /internal.server.error/i,
  /page.not.found/i,
  /服务器错误/i,
  /页面未找到/i,
  /找不到页面/i,
  /bad.gateway/i,
  /service.unavailable/i,
  /gateway.timeout/i,
  /服务器开小差/i,
];

/** Redirect indicators */
const REDIRECT_PATTERNS = [
  /meta.*http-equiv.*refresh/i,
  /window\.location/i,
  /document\.location/i,
  /location\.replace/i,
  /location\.href/i,
  /setTimeout.*location/i,
  /正在跳转/i,
  /正在转向/i,
  /即将跳转/i,
  /redirecting/i,
];

/** Novel list indicators */
const NOVEL_LIST_PATTERNS = [
  /小说列表/i,
  /书库/i,
  /小说大全/i,
  /排行榜/i,
  /热门小说/i,
  /推荐小说/i,
  /最近更新/i,
  /novel.*list/i,
  /book.*list/i,
  // URL patterns
];

/** Novel detail indicators */
const NOVEL_DETAIL_PATTERNS = [
  /小说详情/i,
  /小说信息/i,
  /书籍详情/i,
  /作品信息/i,
  /作者：/i,
  /最新章节/i,
  /章节目录/i,
  /novel.*detail/i,
  /book.*info/i,
];

/** Chapter list indicators */
const CHAPTER_LIST_PATTERNS = [
  /章节列表/i,
  /章节目录/i,
  /目录/i,
  /章节/i,
  /chapter.*list/i,
  /table.*of.*contents/i,
];

/** Chapter content indicators */
const CHAPTER_CONTENT_PATTERNS = [
  /上一章/i,
  /下一章/i,
  /上一页/i,
  /下一页/i,
  /chapter.*content/i,
];

// ==================== Structural Heuristics ====================

/**
 * Count text content length (stripping HTML tags).
 */
function extractTextLength(html: string): number {
  // Quick strip: remove tags and whitespace
  const stripped = html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  return stripped.length;
}

/**
 * Count links in the HTML.
 */
function countLinks(html: string): number {
  const matches = html.match(/<a\s[^>]*href\s*=/gi);
  return matches ? matches.length : 0;
}

/**
 * Check if the HTML contains a form with password field (login form).
 */
function hasLoginForm(html: string): boolean {
  return /<form[\s\S]*?<input[^>]*type\s*=\s*["']?password/i.test(html) ||
    /<input[^>]*type\s*=\s*["']?password/i.test(html);
}

/**
 * Check if HTML has a CAPTCHA form/widget.
 */
function hasCaptchaWidget(html: string): boolean {
  // Look for CAPTCHA div/iframe/script
  return /<div[^>]*(id|class)\s*=\s*["'][^"']*(captcha|recaptcha|hcaptcha|turnstile|geetest)["']/i.test(html) ||
    /<iframe[^>]*src\s*=\s*["'][^"']*(recaptcha|hcaptcha|captcha)["']/i.test(html) ||
    /<script[^>]*src\s*=\s*["'][^"']*(recaptcha|hcaptcha|captcha|turnstile)["']/i.test(html);
}

/**
 * Check if HTML is mostly a redirect (little visible content, redirect script).
 */
function isMostlyRedirect(html: string): boolean {
  const textLen = extractTextLength(html);
  // If the page has < 200 chars of visible text AND contains a redirect script
  return textLen < 200 && REDIRECT_PATTERNS.some(p => p.test(html));
}

/**
 * Check if HTML is mostly empty (JS-rendered content).
 */
function isMostlyEmpty(html: string): boolean {
  const textLen = extractTextLength(html);
  // If < 100 chars of visible text but has script tags
  const hasScripts = /<script/i.test(html);
  return textLen < 100 && hasScripts;
}

/**
 * Detect Cloudflare challenge type from HTML.
 */
export function detectCfChallengeType(html: string): 'js_challenge' | 'turnstile' | 'managed' | 'none' {
  if (/<div[^>]*class\s*=\s*["'][^"']*cf-turnstile["']/i.test(html) ||
    /turnstile/i.test(html)) {
    return 'turnstile';
  }
  if (/challenge-platform/i.test(html) || /managed_challenge/i.test(html)) {
    return 'managed';
  }
  if (/cf-browser-verification/i.test(html) || /cf-challenge-running/i.test(html)) {
    return 'js_challenge';
  }
  return 'none';
}

// ==================== Main Detection Function ====================

/**
 * Detect the type of page from HTML content, URL, and status code.
 *
 * Priority order (most critical to detect first):
 *   1. CAPTCHA — must detect immediately to avoid wasting resources
 *   2. Blocked — access denied, need to back off
 *   3. Login — need to handle auth
 *   4. Error — server error, retry
 *   5. Redirect — follow or handle
 *   6. Content types — chapter_content, chapter_list, novel_detail, novel_list
 *   7. Unknown — can't determine
 */
export function detectPageType(html: string, url: string, statusCode: number): PageTypeResult {
  const evidence: string[] = [];
  const scores: Map<PageType, number> = new Map();
  const alternatives: Array<{ type: PageType; confidence: number }> = [];

  // Initialize all types
  const allTypes: PageType[] = ['novel_list', 'novel_detail', 'chapter_list', 'chapter_content', 'captcha', 'login', 'error', 'redirect', 'blocked', 'unknown'];
  for (const t of allTypes) scores.set(t, 0);

  // ---- Status code signals ----
  if (statusCode === 403 || statusCode === 429) {
    scores.set('blocked', scores.get('blocked')! + 0.9);
    evidence.push(`HTTP ${statusCode}`);
  }
  if (statusCode >= 500) {
    scores.set('error', scores.get('error')! + 0.7);
    evidence.push(`HTTP ${statusCode} server error`);
  }
  if (statusCode === 401) {
    scores.set('login', scores.get('login')! + 0.8);
    evidence.push('HTTP 401 Unauthorized');
  }
  if (statusCode === 302 || statusCode === 301 || statusCode === 307 || statusCode === 308) {
    scores.set('redirect', scores.get('redirect')! + 0.8);
    evidence.push(`HTTP ${statusCode} redirect`);
  }

  // ---- CAPTCHA detection (highest priority) ----
  let captchaScore = 0;
  for (const pattern of CAPTCHA_PATTERNS) {
    if (pattern.test(html)) {
      captchaScore += 0.3;
      evidence.push(`CAPTCHA pattern: ${pattern.source.slice(0, 30)}`);
    }
  }
  if (hasCaptchaWidget(html)) {
    captchaScore += 0.5;
    evidence.push('CAPTCHA widget found in HTML');
  }
  // Cloudflare-specific: short page with "Just a moment"
  const textLen = extractTextLength(html);
  if (textLen < 500 && /Just a moment|Checking your browser/i.test(html)) {
    captchaScore += 0.6;
    evidence.push('Short page with CF challenge text');
  }
  scores.set('captcha', Math.min(captchaScore, 1));

  // ---- Login detection ----
  let loginScore = 0;
  if (hasLoginForm(html)) {
    loginScore += 0.4;
    evidence.push('Login form with password field found');
  }
  for (const pattern of LOGIN_PATTERNS) {
    if (pattern.test(html)) {
      loginScore += 0.2;
      evidence.push(`Login pattern: ${pattern.source.slice(0, 30)}`);
    }
  }
  scores.set('login', Math.min(loginScore, 1));

  // ---- Blocked detection ----
  let blockedScore = scores.get('blocked')!; // Start with status code score
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(html)) {
      blockedScore += 0.3;
      evidence.push(`Blocked pattern: ${pattern.source.slice(0, 30)}`);
    }
  }
  scores.set('blocked', Math.min(blockedScore, 1));

  // ---- Error detection ----
  let errorScore = scores.get('error')!;
  // Check title for error indicators
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    const title = titleMatch[1]!.trim();
    for (const pattern of ERROR_PATTERNS) {
      if (pattern.test(title)) {
        errorScore += 0.4;
        evidence.push(`Error in title: ${title.slice(0, 50)}`);
        break;
      }
    }
  }
  for (const pattern of ERROR_PATTERNS) {
    if (pattern.test(html)) {
      errorScore += 0.15;
    }
  }
  scores.set('error', Math.min(errorScore, 1));

  // ---- Redirect detection ----
  let redirectScore = scores.get('redirect')!;
  if (isMostlyRedirect(html)) {
    redirectScore += 0.6;
    evidence.push('Page is mostly a redirect script');
  }
  for (const pattern of REDIRECT_PATTERNS) {
    if (pattern.test(html)) {
      redirectScore += 0.2;
    }
  }
  // Meta refresh
  if (/meta[^>]*http-equiv\s*=\s*["']?refresh/i.test(html)) {
    redirectScore += 0.5;
    evidence.push('Meta refresh redirect detected');
  }
  scores.set('redirect', Math.min(redirectScore, 1));

  // ---- Content type detection (only if no strong anti-crawl signals) ----
  const maxAntiCrawl = Math.max(
    scores.get('captcha')!, scores.get('blocked')!,
    scores.get('login')!, scores.get('error')!,
  );

  if (maxAntiCrawl < 0.5) {
    // Only attempt content detection if anti-crawl signals are weak

    // Novel list: many links + list-like patterns
    const linkCount = countLinks(html);
    let novelListScore = 0;
    if (linkCount > 20) novelListScore += 0.2;
    if (linkCount > 50) novelListScore += 0.2;
    for (const pattern of NOVEL_LIST_PATTERNS) {
      if (pattern.test(html)) novelListScore += 0.25;
    }
    // URL hint: /list, /rank, /top
    try {
      const pathname = new URL(url).pathname.toLowerCase();
      if (/\/(list|rank|top|sort|category|cate|class|tag)/.test(pathname)) novelListScore += 0.3;
    } catch {}
    scores.set('novel_list', Math.min(novelListScore, 1));

    // Novel detail: single item info page
    let novelDetailScore = 0;
    for (const pattern of NOVEL_DETAIL_PATTERNS) {
      if (pattern.test(html)) novelDetailScore += 0.25;
    }
    // Has cover image + info section
    if (/<img[^>]*class\s*=\s*["'][^"']*(cover|poster|book-img)["']/i.test(html)) {
      novelDetailScore += 0.2;
    }
    // URL hint: /book/123, /novel/456
    try {
      const pathname = new URL(url).pathname.toLowerCase();
      if (/\/(book|novel|info|detail|xs)\/\d+/.test(pathname)) novelDetailScore += 0.3;
    } catch {}
    scores.set('novel_detail', Math.min(novelDetailScore, 1));

    // Chapter list: list of chapter links
    let chapterListScore = 0;
    for (const pattern of CHAPTER_LIST_PATTERNS) {
      if (pattern.test(html)) chapterListScore += 0.3;
    }
    // Many links with chapter-like URLs
    if (linkCount > 10 && /<a[^>]*href\s*=\s*["'][^"']*chapter[^"']*["']/gi.test(html)) {
      chapterListScore += 0.3;
    }
    // URL hint: /chapters, /toc, /mulu
    try {
      const pathname = new URL(url).pathname.toLowerCase();
      if (/\/(chapters|chapter|toc|mulu|catalog|dir)/.test(pathname)) chapterListScore += 0.3;
    } catch {}
    scores.set('chapter_list', Math.min(chapterListScore, 1));

    // Chapter content: actual text content
    let chapterContentScore = 0;
    for (const pattern of CHAPTER_CONTENT_PATTERNS) {
      if (pattern.test(html)) chapterContentScore += 0.25;
    }
    // Large text content (>5000 chars of visible text)
    if (textLen > 5000) chapterContentScore += 0.3;
    if (textLen > 10000) chapterContentScore += 0.2;
    // Content div with lots of text
    if (/<div[^>]*(id|class)\s*=\s*["'][^"']*(content|chapter|text|article|read)["']/i.test(html)) {
      chapterContentScore += 0.2;
    }
    // URL hint: /chapter/123, /read/456
    try {
      const pathname = new URL(url).pathname.toLowerCase();
      if (/\/(chapter|read|content|txt|view)\/\d+/.test(pathname)) chapterContentScore += 0.3;
    } catch {}
    scores.set('chapter_content', Math.min(chapterContentScore, 1));
  }

  // ---- Determine winner ----
  let bestType: PageType = 'unknown';
  let bestScore = 0;

  for (const [type, score] of scores) {
    if (type === 'unknown') continue; // Unknown is fallback
    if (score > bestScore) {
      bestScore = score;
      bestType = type;
    }
    if (score > 0.1) {
      alternatives.push({ type, confidence: Math.min(score, 1) });
    }
  }

  // Sort alternatives by confidence descending
  alternatives.sort((a, b) => b.confidence - a.confidence);

  // If no strong signal, mark as unknown
  if (bestScore < 0.2) {
    bestType = 'unknown';
    bestScore = 0;
  }

  // Handle empty/JS-rendered pages
  if (bestType === 'unknown' && isMostlyEmpty(html)) {
    evidence.push('Page is mostly empty with JS scripts — likely JS-rendered');
    // Could be a JS-rendered content page or a challenge
    if (/<script[^>]*src\s*=\s*["'][^"']*challenge/i.test(html)) {
      bestType = 'captcha';
      bestScore = 0.4;
      evidence.push('Challenge script detected in mostly-empty page');
    }
  }

  if (process.env.DEBUG === 'true') {
    log.info(`Page type: ${bestType} (${(bestScore * 100).toFixed(0)}%) for ${url.slice(0, 60)}`);
  }

  return {
    type: bestType,
    confidence: bestScore,
    evidence,
    alternatives: alternatives.filter(a => a.type !== bestType).slice(0, 5),
  };
}

/**
 * Quick check: is this page a CAPTCHA/challenge disguised as 200 OK?
 * Fast path that only checks the most critical patterns.
 */
export function isCaptchaPage(html: string): boolean {
  // Fast regex check for the most common CAPTCHA signals
  return /cf-challenge-running|Just a moment|Checking your browser|captcha|验证码|人机验证|recaptcha|hcaptcha|turnstile/i.test(html);
}

/**
 * Quick check: is this page a blocked/access denied page?
 */
export function isBlockedPage(html: string, statusCode: number): boolean {
  if (statusCode === 403 || statusCode === 429) return true;
  return /access.denied|forbidden|请求过于频繁|访问被拒绝|已被封禁/i.test(html);
}
