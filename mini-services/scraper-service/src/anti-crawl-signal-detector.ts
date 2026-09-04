/**
 * Anti-Crawl Signal Detector
 *
 * Low-level detection of anti-bot signals from HTTP responses and HTML content.
 * Complements the high-level anti-crawl-advisor by providing granular signal scoring.
 *
 * Detection capabilities:
 *   - Rate limit headers (X-RateLimit-*, Retry-After)
 *   - Honeypot links (hidden links only bots click)
 *   - CSS-based traps (display:none, visibility:hidden content)
 *   - JavaScript challenge detection (CF$cv$params, PerimeterX, DDoS-Guard)
 *   - Cloudflare cf-mitigated header detection
 *   - Turnstile captcha detection
 *   - Bot detection confidence scoring (0-100)
 */

// ==================== Types ====================

export interface ResponseSignalResult {
  /** Overall bot detection confidence score (0-100) */
  botConfidence: number;
  /** Individual signals detected */
  signals: ResponseSignal[];
  /** Whether Retry-After header was present */
  retryAfterMs?: number;
  /** Rate limit info from headers */
  rateLimitInfo?: {
    limit?: number;
    remaining?: number;
    reset?: number; // Unix timestamp
  };
}

export interface ResponseSignal {
  type: ResponseSignalType;
  confidence: number; // 0-1 contribution to botConfidence
  detail: string;
}

export type ResponseSignalType =
  | 'cf_mitigated'
  | 'cf_challenge'
  | 'turnstile'
  | 'perimeterx'
  | 'ddos_guard'
  | 'rate_limit_header'
  | 'retry_after'
  | 'js_challenge_param'
  | 'honeypot_link'
  | 'css_trap'
  | 'suspicious_redirect'
  | 'empty_with_200'
  | 'encoding_mismatch'
  | 'fingerprint_inconsistency';

export interface HtmlSignalResult {
  /** Signals found in HTML content */
  signals: HtmlSignal[];
  /** Count of honeypot links detected */
  honeypotLinkCount: number;
  /** Count of CSS traps detected */
  cssTrapCount: number;
  /** JS challenge indicators found */
  jsChallengeIndicators: string[];
}

export interface HtmlSignal {
  type: 'honeypot_link' | 'css_trap' | 'js_challenge' | 'anti_bot_script';
  detail: string;
  confidence: number;
}

// ==================== Cloudflare Detection ====================

/**
 * Detect Cloudflare mitigation from HTTP headers.
 * The cf-mitigated header is set by CF when a challenge is served.
 * cf-mitigated: challenge (JS challenge), managed (managed challenge), interop (legacy)
 */
export function detectCloudflareHeaders(headers: Record<string, string>): ResponseSignal[] {
  const signals: ResponseSignal[] = [];

  // cf-mitigated header (CF Enterprise feature)
  const cfMitigated = headers['cf-mitigated'] || headers['Cf-Mitigated'];
  if (cfMitigated) {
    const lower = cfMitigated.toLowerCase();
    if (lower === 'challenge') {
      signals.push({
        type: 'cf_challenge',
        confidence: 0.9,
        detail: `cf-mitigated: ${cfMitigated} (JS challenge served)`,
      });
    } else if (lower === 'managed') {
      signals.push({
        type: 'cf_mitigated',
        confidence: 0.7,
        detail: `cf-mitigated: ${cfMitigated} (managed challenge)`,
      });
    } else {
      signals.push({
        type: 'cf_mitigated',
        confidence: 0.5,
        detail: `cf-mitigated: ${cfMitigated}`,
      });
    }
  }

  // cf-ray header presence alone doesn't indicate bot detection,
  // but combined with certain status codes it's significant
  const cfRay = headers['cf-ray'] || headers['Cf-Ray'];
  const cfCache = headers['cf-cache-status'] || headers['Cf-Cache-Status'];
  if (cfRay && cfCache === 'DENY') {
    signals.push({
      type: 'cf_mitigated',
      confidence: 0.6,
      detail: 'cf-cache-status: DENY (CF blocking response)',
    });
  }

  return signals;
}

// ==================== Turnstile Detection ====================

/**
 * Detect Cloudflare Turnstile widget in HTML.
 * Turnstile is CF's invisible CAPTCHA replacement.
 */
export function detectTurnstile(html: string): ResponseSignal[] {
  const signals: ResponseSignal[] = [];
  const indicators: string[] = [];

  // Turnstile widget rendering
  if (/cf-turnstile/.test(html) || /turnstile/.test(html)) indicators.push('cf-turnstile class/id');
  if (/challenges\.cloudflare\.com\/turnstile/.test(html)) indicators.push('turnstile script src');
  if (/data-sitekey.*turnstile/i.test(html)) indicators.push('turnstile data-sitekey');
  if (/turnstile\/v0\/api\.js/.test(html)) indicators.push('turnstile API JS');

  if (indicators.length > 0) {
    signals.push({
      type: 'turnstile',
      confidence: Math.min(0.6 + indicators.length * 0.1, 0.95),
      detail: `Turnstile detected: ${indicators.join(', ')}`,
    });
  }

  return signals;
}

// ==================== PerimeterX Detection ====================

/**
 * Detect PerimeterX (now HUMAN Security) anti-bot.
 * Common indicators: _pxAppId, PX cookies, PerimeterX challenge pages.
 */
export function detectPerimeterX(html: string, headers: Record<string, string>): ResponseSignal[] {
  const signals: ResponseSignal[] = [];
  const indicators: string[] = [];

  // HTML indicators
  if (/_pxAppId/.test(html)) indicators.push('_pxAppId variable');
  if (/PerimeterX/.test(html) || /perimeterx/i.test(html)) indicators.push('PerimeterX string');
  if (/_px3/.test(html) || /_px2/.test(html)) indicators.push('PX cookie JS');
  if (/humansecurity/i.test(html) || /HUMAN Security/i.test(html)) indicators.push('HUMAN Security branding');
  if (/collector\.px-cdn\.net/.test(html)) indicators.push('PX CDN collector');
  if (/hw\.px-cdn\.net/.test(html)) indicators.push('PX HW script');

  // Header indicators
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower.startsWith('x-px-') || lower.includes('perimeterx')) {
      indicators.push(`header ${key}: ${value.slice(0, 50)}`);
    }
  }

  // PX typically returns 403 with its challenge page
  if (indicators.length > 0) {
    signals.push({
      type: 'perimeterx',
      confidence: Math.min(0.6 + indicators.length * 0.1, 0.95),
      detail: `PerimeterX detected: ${indicators.join(', ')}`,
    });
  }

  return signals;
}

// ==================== DDoS-Guard Detection ====================

/**
 * Detect DDoS-Guard protection.
 * Common in Russian/Chinese hosting (e.g., qidian.com uses DDoS-Guard).
 */
export function detectDdosGuard(html: string, headers: Record<string, string>): ResponseSignal[] {
  const signals: ResponseSignal[] = [];
  const indicators: string[] = [];

  // HTML indicators
  if (/ddosguard/i.test(html) || /DDoS-Guard/.test(html)) indicators.push('DDoS-Guard branding');
  if (/ddg_iu_check/.test(html)) indicators.push('ddg_iu_check cookie');
  if (/\/\.well-known\/ddosguard/.test(html)) indicators.push('.well-known/ddosguard path');
  if (/check\.ddos-guard/.test(html)) indicators.push('check.ddos-guard domain');

  // Header indicators
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower.includes('ddos') || lower.includes('ddguard')) {
      indicators.push(`.test(header ${key}: ${value.slice(0, 50)})`);
    }
  }

  // Set-Cookie with __ddg_ prefix
  const setCookie = headers['set-cookie'] || '';
  if (/__ddg_/.test(setCookie)) indicators.push('__ddg_ cookie');

  if (indicators.length > 0) {
    signals.push({
      type: 'ddos_guard',
      confidence: Math.min(0.5 + indicators.length * 0.15, 0.9),
      detail: `DDoS-Guard detected: ${indicators.join(', ')}`,
    });
  }

  return signals;
}

// ==================== Rate Limit Header Detection ====================

/**
 * Detect rate limit headers (X-RateLimit-*, Retry-After) from response.
 * Returns signals and parsed rate limit info.
 */
export function detectRateLimitHeaders(headers: Record<string, string>): {
  signals: ResponseSignal[];
  retryAfterMs?: number;
  rateLimitInfo?: { limit?: number; remaining?: number; reset?: number };
} {
  const signals: ResponseSignal[] = [];
  let retryAfterMs: number | undefined;
  const rateLimitInfo: { limit?: number; remaining?: number; reset?: number } = {};

  // Retry-After header (can be seconds or HTTP date)
  const retryAfter = headers['retry-after'] || headers['Retry-After'];
  if (retryAfter) {
    const asNumber = parseInt(retryAfter, 10);
    if (!isNaN(asNumber) && asNumber > 0) {
      retryAfterMs = asNumber * 1000;
      rateLimitInfo.reset = Math.floor(Date.now() / 1000) + asNumber;
    } else {
      // HTTP date format
      const parsed = Date.parse(retryAfter);
      if (!isNaN(parsed)) {
        retryAfterMs = Math.max(0, parsed - Date.now());
        rateLimitInfo.reset = Math.floor(parsed / 1000);
      }
    }
    if (retryAfterMs !== undefined && retryAfterMs > 0) {
      signals.push({
        type: 'retry_after',
        confidence: Math.min(0.3 + retryAfterMs / 60000, 0.8), // Longer wait = higher confidence
        detail: `Retry-After: ${retryAfter} (${Math.round(retryAfterMs / 1000)}s)`,
      });
    }
  }

  // X-RateLimit-* headers (various conventions)
  const rateLimitPrefixes = ['x-ratelimit-', 'x-rate-limit-', 'ratelimit-'];
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    for (const prefix of rateLimitPrefixes) {
      if (lower.startsWith(prefix)) {
        const suffix = lower.slice(prefix.length);
        const numVal = parseInt(value, 10);
        if (suffix === 'limit' && !isNaN(numVal)) rateLimitInfo.limit = numVal;
        if (suffix === 'remaining' && !isNaN(numVal)) rateLimitInfo.remaining = numVal;
        if (suffix === 'reset' && !isNaN(numVal)) rateLimitInfo.reset = numVal;
      }
    }
  }

  // Signal if remaining is 0 or very low
  if (rateLimitInfo.remaining !== undefined && rateLimitInfo.limit !== undefined) {
    const ratio = rateLimitInfo.remaining / rateLimitInfo.limit;
    if (ratio <= 0) {
      signals.push({
        type: 'rate_limit_header',
        confidence: 0.7,
        detail: `Rate limit exhausted: ${rateLimitInfo.remaining}/${rateLimitInfo.limit}`,
      });
    } else if (ratio < 0.1) {
      signals.push({
        type: 'rate_limit_header',
        confidence: 0.4,
        detail: `Rate limit near: ${rateLimitInfo.remaining}/${rateLimitInfo.limit}`,
      });
    }
  }

  return {
    signals,
    retryAfterMs: retryAfterMs !== undefined && retryAfterMs > 0 ? retryAfterMs : undefined,
    rateLimitInfo: Object.keys(rateLimitInfo).length > 0 ? rateLimitInfo : undefined,
  };
}

// ==================== JS Challenge Detection ====================

/**
 * Detect JavaScript challenge parameters in HTML.
 * These indicate the server is serving a challenge page that requires JS execution.
 */
export function detectJsChallenge(html: string): ResponseSignal[] {
  const signals: ResponseSignal[] = [];
  const indicators: string[] = [];

  // Cloudflare JS challenge params
  if (/__CF\$cv\$params/.test(html)) indicators.push('__CF$cv$params (CF challenge)');
  if (/window\._cf_chl_opt/.test(html)) indicators.push('_cf_chl_opt (CF challenge options)');
  if (/cf-chl-bypass/.test(html)) indicators.push('cf-chl-bypass');
  if (/jschl_vc/.test(html)) indicators.push('jschl_vc (CF legacy challenge)');
  if (/jschl_answer/.test(html)) indicators.push('jschl_answer (CF legacy)');

  // Generic JS challenge patterns
  if (/document\.cookie.*__cf/.test(html)) indicators.push('CF cookie set via JS');
  if (/setTimeout.*location\.reload/.test(html)) indicators.push('setTimeout+reload (challenge loop)');
  if (/eval\(atob/.test(html) && /challenge/i.test(html)) indicators.push('eval(atob) challenge');

  // PerimeterX challenge
  if (/_pxVid/.test(html) || /_px3/.test(html)) indicators.push('PX challenge cookies');

  // DDoS-Guard challenge
  if (/ddg_iu_check/.test(html)) indicators.push('DDoS-Guard challenge cookie');

  if (indicators.length > 0) {
    signals.push({
      type: 'js_challenge_param',
      confidence: Math.min(0.5 + indicators.length * 0.15, 0.95),
      detail: `JS challenge: ${indicators.join(', ')}`,
    });
  }

  return signals;
}

// ==================== Honeypot Link Detection ====================

/**
 * Detect honeypot links in HTML - hidden links that only bots would follow.
 * Real users never see these links (display:none, off-screen, etc.)
 * Following them triggers bot detection.
 */
export function detectHoneypotLinks(html: string): HtmlSignal[] {
  const signals: HtmlSignal[] = [];

  // Links with display:none in inline style
  const hiddenLinkPattern = /<a[^>]+style=["'][^"']*display\s*:\s*none[^"']*["'][^>]*href=["']([^"']+)["']/gi;
  let match;
  while ((match = hiddenLinkPattern.exec(html)) !== null) {
    signals.push({
      type: 'honeypot_link',
      detail: `display:none link: ${match[1].slice(0, 80)}`,
      confidence: 0.7,
    });
  }

  // Links with visibility:hidden
  const hiddenVisPattern = /<a[^>]+style=["'][^"']*visibility\s*:\s*hidden[^"']*["'][^>]*href=["']([^"']+)["']/gi;
  while ((match = hiddenVisPattern.exec(html)) !== null) {
    signals.push({
      type: 'honeypot_link',
      detail: `visibility:hidden link: ${match[1].slice(0, 80)}`,
      confidence: 0.6,
    });
  }

  // Links positioned off-screen (left: -9999px, top: -9999px, etc.)
  const offScreenPattern = /<a[^>]+style=["'][^"']*(-9999|-9998|left\s*:\s*-\d{4})[^"']*["'][^>]*href=["']([^"']+)["']/gi;
  while ((match = offScreenPattern.exec(html)) !== null) {
    signals.push({
      type: 'honeypot_link',
      detail: `off-screen link: ${match[2].slice(0, 80)}`,
      confidence: 0.8, // Off-screen is a stronger indicator
    });
  }

  // Links with font-size: 0 or 1px (invisible text)
  const tinyFontPattern = /<a[^>]+style=["'][^"']*(font-size\s*:\s*(0|1px|0px))[^"']*["'][^>]*href=["']([^"']+)["']/gi;
  while ((match = tinyFontPattern.exec(html)) !== null) {
    signals.push({
      type: 'honeypot_link',
      detail: `zero-font link: ${match[3].slice(0, 80)}`,
      confidence: 0.75,
    });
  }

  // Links with tabindex=-1 and aria-hidden=true (accessibility-hidden)
  const ariaHiddenPattern = /<a[^>]+aria-hidden=["']true["'][^>]*href=["']([^"']+)["']/gi;
  while ((match = ariaHiddenPattern.exec(html)) !== null) {
    signals.push({
      type: 'honeypot_link',
      detail: `aria-hidden link: ${match[1].slice(0, 80)}`,
      confidence: 0.5,
    });
  }

  return signals;
}

// ==================== CSS Trap Detection ====================

/**
 * Detect CSS-based traps that serve different content to bots.
 * These include display:none containers that contain real content
 * (to catch scrapers that strip CSS), or CSS-only visible elements.
 */
export function detectCssTraps(html: string): HtmlSignal[] {
  const signals: HtmlSignal[] = [];

  // Elements with display:none that contain substantial text (trap content)
  // If a display:none container has > 200 chars of text, it might be trap content
  const hiddenDivPattern = /<(?:div|span|p|section)[^>]+style=["'][^"']*display\s*:\s*none[^"']*["'][^>]*>([\s\S]{200,}?)<\/(?:div|span|p|section)>/gi;
  let match;
  while ((match = hiddenDivPattern.exec(html)) !== null) {
    const text = match[1].replace(/<[^>]+>/g, '').trim();
    if (text.length > 100) {
      signals.push({
        type: 'css_trap',
        detail: `display:none container with ${text.length} chars of text (likely trap)`,
        confidence: 0.6,
      });
    }
  }

  // Elements positioned far off-screen (left: -9999em, etc.) with substantial content
  const offScreenContentPattern = /<(?:div|span)[^>]+style=["'][^"']*(-9999|-5000)\s*(px|em|rem)[^"']*["'][^>]*>([\s\S]{100,}?)<\/(?:div|span)>/gi;
  while ((match = offScreenContentPattern.exec(html)) !== null) {
    signals.push({
      type: 'css_trap',
      detail: `off-screen container with substantial content`,
      confidence: 0.5,
    });
  }

  // CSS class-based hiding with .hidden, .visually-hidden (common trap pattern)
  // Only flag if there are many such elements (3+ is suspicious)
  const classHiddenCount = (html.match(/class=["'][^"']*(?:hidden|invisible|visually-hidden|sr-only|u-hide)[^"']*["']/gi) || []).length;
  if (classHiddenCount > 10) {
    signals.push({
      type: 'css_trap',
      detail: `${classHiddenCount} elements with hidden/invisible CSS classes`,
      confidence: 0.3,
    });
  }

  return signals;
}

// ==================== Composite Response Analysis ====================

/**
 * Analyze an HTTP response for all anti-crawl signals.
 *
 * @param statusCode - HTTP status code
 * @param headers - Response headers (lowercase keys preferred)
 * @param html - Response body (first 100KB is sufficient)
 * @returns Composite signal result with bot confidence score
 */
export function analyzeResponse(
  statusCode: number,
  headers: Record<string, string>,
  html: string,
): ResponseSignalResult {
  const allSignals: ResponseSignal[] = [];

  // Normalize headers to lowercase keys for consistent lookup
  const lcHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    lcHeaders[k.toLowerCase()] = v;
  }

  // 1. Cloudflare headers
  allSignals.push(...detectCloudflareHeaders(lcHeaders));

  // 2. Rate limit headers
  const { signals: rlSignals, retryAfterMs, rateLimitInfo } = detectRateLimitHeaders(lcHeaders);
  allSignals.push(...rlSignals);

  // 3. Turnstile in HTML
  allSignals.push(...detectTurnstile(html));

  // 4. PerimeterX
  allSignals.push(...detectPerimeterX(html, lcHeaders));

  // 5. DDoS-Guard
  allSignals.push(...detectDdosGuard(html, lcHeaders));

  // 6. JS challenge params
  allSignals.push(...detectJsChallenge(html));

  // 7. Status code heuristics
  if (statusCode === 403) {
    // 403 without CF headers might still be bot detection
    const hasCf = lcHeaders['cf-ray'] || lcHeaders['server']?.toLowerCase().includes('cloudflare');
    if (hasCf) {
      allSignals.push({ type: 'cf_challenge', confidence: 0.8, detail: 'HTTP 403 from Cloudflare' });
    } else {
      allSignals.push({ type: 'suspicious_redirect', confidence: 0.3, detail: 'HTTP 403 (possible bot block)' });
    }
  } else if (statusCode === 429) {
    allSignals.push({ type: 'rate_limit_header', confidence: 0.6, detail: 'HTTP 429 Too Many Requests' });
  } else if (statusCode === 503) {
    // 503 with challenge content is suspicious
    if (/challenge|captcha|verify/i.test(html)) {
      allSignals.push({ type: 'js_challenge_param', confidence: 0.5, detail: 'HTTP 503 with challenge content' });
    }
  } else if (statusCode === 200) {
    // 200 with very short content and challenge indicators
    if (html.length < 500 && /challenge|captcha|verify|blocked/i.test(html)) {
      allSignals.push({ type: 'empty_with_200', confidence: 0.6, detail: 'HTTP 200 but content looks like challenge page' });
    }
  }

  // 8. Encoding mismatch detection (Content-Type charset vs actual content)
  const contentType = lcHeaders['content-type'] || '';
  const declaredCharset = contentType.match(/charset[=\s"']+([\w\-]+)/i)?.[1]?.toLowerCase();
  if (declaredCharset && html.length > 100) {
    // Check for UTF-8 declared but GBK/Big5 mojibake patterns
    if (declaredCharset === 'utf-8') {
      if (/锟斤拷|鐢|鍦|棰/.test(html)) {
        allSignals.push({ type: 'encoding_mismatch', confidence: 0.5, detail: 'Declared UTF-8 but content shows GBK mojibake (锟斤拷 pattern)' });
      }
    }
  }

  // 9. Fingerprint inconsistency detection
  // Check for User-Agent / sec-ch-ua platform mismatch
  const ua = lcHeaders['user-agent'] || '';
  const secChUaPlatform = lcHeaders['sec-ch-ua-platform'] || '';
  if (ua && secChUaPlatform) {
    const uaHasMac = /Macintosh/.test(ua);
    const uaHasWin = /Windows/.test(ua);
    const uaHasLinux = /Linux/.test(ua);
    const platformIsMac = secChUaPlatform.includes('macOS');
    const platformIsWin = secChUaPlatform.includes('Windows');
    const platformIsLinux = secChUaPlatform.includes('Linux');
    if ((uaHasMac && !platformIsMac) || (uaHasWin && !platformIsWin) || (uaHasLinux && !platformIsLinux)) {
      allSignals.push({ type: 'fingerprint_inconsistency', confidence: 0.9, detail: 'User-Agent platform does not match sec-ch-ua-platform' });
    }
  }

  // Calculate composite bot confidence (0-100)
  // Each signal adds to confidence, with diminishing returns for multiple signals
  let rawConfidence = 0;
  for (const signal of allSignals) {
    // Use harmonic-like addition to prevent > 1.0
    rawConfidence = rawConfidence + signal.confidence * (1 - rawConfidence);
  }
  const botConfidence = Math.round(rawConfidence * 100);

  return {
    botConfidence,
    signals: allSignals,
    retryAfterMs,
    rateLimitInfo,
  };
}


/**
 * Analyze HTML content for honeypot links, CSS traps, and JS challenges.
 *
 * @param html - HTML content to analyze
 * @returns HTML signal detection result
 */
export function analyzeHtmlSignals(html: string): HtmlSignalResult {
  const signals: HtmlSignal[] = [];

  // Honeypot links
  const honeypotSignals = detectHoneypotLinks(html);
  signals.push(...honeypotSignals);

  // CSS traps
  const cssSignals = detectCssTraps(html);
  signals.push(...cssSignals);

  // Anti-bot scripts (inline JS that sets cookies for verification)
  const antiBotScriptPattern = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let scriptMatch;
  while ((scriptMatch = antiBotScriptPattern.exec(html)) !== null) {
    const scriptContent = scriptMatch[1];
    if (/document\.cookie\s*=/.test(scriptContent) && /setTimeout|setInterval/.test(scriptContent)) {
      // Script sets cookie and has timer - likely challenge/verification
      if (/__cf|_px|ddg|challenge|verify/i.test(scriptContent)) {
        signals.push({
          type: 'anti_bot_script',
          detail: 'Inline script sets verification cookie with timer',
          confidence: 0.7,
        });
      }
    }
  }

  // JS challenge indicators
  const jsChallengeIndicators: string[] = [];
  if (/__CF\$cv\$params/.test(html)) jsChallengeIndicators.push('__CF$cv$params');
  if (/window\._cf_chl_opt/.test(html)) jsChallengeIndicators.push('_cf_chl_opt');
  if (/_pxVid/.test(html)) jsChallengeIndicators.push('_pxVid');
  if (/ddg_iu_check/.test(html)) jsChallengeIndicators.push('ddg_iu_check');

  return {
    signals,
    honeypotLinkCount: honeypotSignals.length,
    cssTrapCount: cssSignals.length,
    jsChallengeIndicators,
  };
}

// ==================== Honeypot Link Filter ====================

/** Set of URLs identified as honeypots - never follow these */
const honeypotUrlSet = new Set<string>();
const MAX_HONEYPOT_URLS = 1000;

/**
 * Mark a URL as a honeypot. Future requests to this URL will be blocked.
 */
export function markHoneypot(url: string): void {
  if (honeypotUrlSet.size >= MAX_HONEYPOT_URLS) {
    // Evict oldest entry (first in Set)
    const first = honeypotUrlSet.values().next().value;
    if (first) honeypotUrlSet.delete(first);
  }
  honeypotUrlSet.add(url);
}

/**
 * Check if a URL has been identified as a honeypot.
 */
export function isHoneypot(url: string): boolean {
  return honeypotUrlSet.has(url);
}

/**
 * Get count of known honeypot URLs.
 */
export function getHoneypotCount(): number {
  return honeypotUrlSet.size;
}

// ==================== DataDome Detection ====================

/**
 * Detect DataDome anti-bot protection from response headers and HTML.
 * DataDome is a major bot detection service used by many e-commerce and media sites.
 *
 * Detection signals:
 *   - X-DataDome header (bot decision)
 *   - X-DataDomeBotName header (bot classification)
 *   - DataDome cookie presence
 *   - DataDome JavaScript challenge page
 */
export function detectDataDome(html: string, headers: Record<string, string>): ResponseSignal[] {
  const signals: ResponseSignal[] = [];
  const indicators: string[] = [];

  // Header-based detection
  const ddHeader = headers['x-datadome'] || headers['X-DataDome'];
  if (ddHeader) {
    indicators.push(`X-DataDome: ${ddHeader}`);
    if (ddHeader === 'protected' || ddHeader === 'blocked') {
      signals.push({
        type: 'js_challenge_param',
        confidence: 0.85,
        detail: `DataDome blocked: ${ddHeader}`,
      });
    }
  }

  const ddBotName = headers['x-datadomebotname'] || headers['X-DataDomeBotName'];
  if (ddBotName) {
    indicators.push(`X-DataDomeBotName: ${ddBotName}`);
  }

  // HTML-based detection
  if (/datadome/i.test(html)) indicators.push('DataDome string in HTML');
  if (/DataDomeCAPTCHA/i.test(html)) indicators.push('DataDome CAPTCHA');
  if (/datadome\.co/i.test(html)) indicators.push('datadome.co domain');
  if (/js\.datadome\.co/i.test(html)) indicators.push('datadome.co JS');

  // Cookie-based detection
  const setCookie = headers['set-cookie'] || '';
  if (/datadome/i.test(setCookie)) indicators.push('DataDome cookie');

  if (indicators.length > 0 && signals.length === 0) {
    signals.push({
      type: 'js_challenge_param',
      confidence: Math.min(0.4 + indicators.length * 0.15, 0.9),
      detail: `DataDome detected: ${indicators.join(', ')}`,
    });
  }

  return signals;
}

// ==================== Akamai Bot Manager Detection ====================

/**
 * Detect Akamai Bot Manager from response headers and HTML.
 * Akamai is one of the largest CDN/anti-bot providers.
 *
 * Detection signals:
 *   - X-Akamai-Bot header
 *   - Akamai-specific cookies (_abck)
 *   - Akamai challenge page (Sensai/v3)
 *   - X-Abck-* headers
 */
export function detectAkamaiBotManager(html: string, headers: Record<string, string>): ResponseSignal[] {
  const signals: ResponseSignal[] = [];
  const indicators: string[] = [];

  // Header-based detection
  const akBot = headers['x-akamai-bot'] || headers['X-Akamai-Bot'];
  if (akBot) {
    indicators.push(`X-Akamai-Bot: ${akBot}`);
    if (akBot === 'blocked' || akBot === 'challenge') {
      signals.push({
        type: 'js_challenge_param',
        confidence: 0.8,
        detail: `Akamai Bot Manager: ${akBot}`,
      });
    }
  }

  // Akamai Bot Manager pixel response header
  const akPixel = headers['x-akamai-pixel'] || headers['X-Akamai-Pixel'];
  if (akPixel) indicators.push(`X-Akamai-Pixel: ${akPixel}`);

  // HTML-based detection
  if (/sensai/i.test(html)) indicators.push('Sensai challenge');
  if (/akamai.*bot/i.test(html)) indicators.push('Akamai bot string');
  if (/bm\.akamai/i.test(html)) indicators.push('Akamai BM JS');

  // Cookie-based detection (_abck is Akamai Bot Manager cookie)
  const setCookie = headers['set-cookie'] || '';
  if (/_abck/i.test(setCookie)) indicators.push('_abck cookie');
  if (/ak_bmsc/i.test(setCookie)) indicators.push('ak_bmsc cookie');

  if (indicators.length > 0 && signals.length === 0) {
    signals.push({
      type: 'js_challenge_param',
      confidence: Math.min(0.4 + indicators.length * 0.15, 0.85),
      detail: `Akamai Bot Manager detected: ${indicators.join(', ')}`,
    });
  }

  return signals;
}

// ==================== Imperva / Incapsula Detection ====================

/**
 * Detect Imperva (formerly Incapsula) anti-bot protection.
 */
export function detectImperva(html: string, headers: Record<string, string>): ResponseSignal[] {
  const signals: ResponseSignal[] = [];
  const indicators: string[] = [];

  // Header-based detection
  const xIinfo = headers['x-iinfo'] || headers['X-Iinfo'];
  if (xIinfo) indicators.push(`X-Iinfo: ${xIinfo.slice(0, 50)}`);

  // HTML-based detection
  if (/incapsula/i.test(html)) indicators.push('Incapsula string');
  if (/imperva/i.test(html)) indicators.push('Imperva string');
  if (/___incapsula_frame/i.test(html)) indicators.push('Incapsula frame');
  if (/zjdnflkxwnxbskspf/i.test(html)) indicators.push('Incapsula obfuscated JS');

  // Cookie
  const setCookie = headers['set-cookie'] || '';
  if (/incap_ses/i.test(setCookie) || /visid_incap/i.test(setCookie)) {
    indicators.push('Incapsula session cookie');
  }

  if (indicators.length > 0) {
    signals.push({
      type: 'js_challenge_param',
      confidence: Math.min(0.5 + indicators.length * 0.15, 0.9),
      detail: `Imperva/Incapsula detected: ${indicators.join(', ')}`,
    });
  }

  return signals;
}
