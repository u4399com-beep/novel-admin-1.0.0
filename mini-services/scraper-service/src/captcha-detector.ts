/**
 * CAPTCHA Detection Module
 *
 * Heuristic-based CAPTCHA detection from HTML content and HTTP response metadata.
 * Supports: reCAPTCHA v2/v3, hCaptcha, GeeTest, Cloudflare Challenge, custom image CAPTCHA.
 */

// ==================== Types ====================

export interface CaptchaDetection {
  detected: boolean;
  type: 'recaptcha_v2' | 'recaptcha_v3' | 'hcaptcha' | 'geetest' | 'cloudflare' | 'turnstile' | 'ddos_guard' | 'perimeterx' | 'custom' | 'unknown';
  confidence: number; // 0-1
  evidence: string[];
}

// ==================== Detection Rules ====================

interface DetectionRule {
  type: CaptchaDetection['type'];
  patterns: RegExp[];
  /** Base confidence when matched */
  baseConfidence: number;
  /** Each additional match adds this much confidence */
  perMatchBoost: number;
  maxConfidence: number;
}

const HTML_RULES: DetectionRule[] = [
  // reCAPTCHA v3 — checked FIRST (more specific patterns)
  {
    type: 'recaptcha_v3',
    patterns: [
      /recaptcha\/api\.js/i,
      /grecaptcha\.enterprise/i,
      /recaptchaV3/i,
      /grecaptcha\.execute/i,
      /recaptcha.*\?render=/i,
    ],
    baseConfidence: 0.65,
    perMatchBoost: 0.1,
    maxConfidence: 0.95,
  },
  // reCAPTCHA v2 — patterns that are v2-specific (not matching v3 render= URLs)
  {
    type: 'recaptcha_v2',
    patterns: [
      /google\.com\/recaptcha(?!\/api\.js\?render)/i,
      /g-recaptcha/i,
      /grecaptcha\.render/i,
      /g-recaptcha-response/i,
      /class=[^"'>\s]*g-recaptcha/i,
      /data-sitekey(?!.*render)/i,
    ],
    baseConfidence: 0.7,
    perMatchBoost: 0.1,
    maxConfidence: 0.95,
  },
  // hCaptcha
  {
    type: 'hcaptcha',
    patterns: [
      /hcaptcha\.com/i,
      /h-captcha/i,
      /h-captcha-response/i,
      /hcaptcha\.js/i,
      /data-hcaptcha-sitekey/i,
    ],
    baseConfidence: 0.7,
    perMatchBoost: 0.1,
    maxConfidence: 0.95,
  },
  // GeeTest
  {
    type: 'geetest',
    patterns: [
      /geetest\.com/i,
      /gt\.js/i,
      /geetest_/i,
      /geetest_challenge/i,
      /initGeetest/i,
    ],
    baseConfidence: 0.7,
    perMatchBoost: 0.1,
    maxConfidence: 0.95,
  },
  // Cloudflare Challenge
  {
    type: 'cloudflare',
    patterns: [
      /cf-browser-verification/i,
      /challenge-platform/i,
      /jschl_vc/i,
      /_cf_chl/i,
      /cloudflare.*challenge/i,
      /cf-turnstile/i,
      /challenges\.cloudflare\.com/i,
      /__CF\$cv\$params/i,
      /window\._cf_chl_opt/i,
      /cf-chl-bypass/i,
    ],
    baseConfidence: 0.75,
    perMatchBoost: 0.08,
    maxConfidence: 0.95,
  },
  // Custom image CAPTCHA (Chinese sites common)
  {
    type: 'custom',
    patterns: [
      /验证码/i,
      /captcha/i,
      /img\[src\*=captcha\]/i,
      /class=[^"'>\s]*captcha/i,
      /id=[^"'>\s]*captcha/i,
      /verifyCode/i,
      /checkCode/i,
      /seccode/i,
      /vcode/i,
      /captchaImage/i,
      /yanzheng/i,
    ],
    baseConfidence: 0.5,
    perMatchBoost: 0.12,
    maxConfidence: 0.85,
  },
  // Arkose Labs (FunCaptcha)
  {
    type: 'unknown',
    patterns: [
      /arkoselabs\.com/i,
      /funcaptcha/i,
      /arkose/i,
      /captcha-api\.arkoselabs/i,
    ],
    baseConfidence: 0.7,
    perMatchBoost: 0.1,
    maxConfidence: 0.9,
  },
  // FriendlyCaptcha
  {
    type: 'unknown',
    patterns: [
      /friendlycaptcha/i,
      /frc-captcha/i,
      /friendly-challenge/i,
    ],
    baseConfidence: 0.7,
    perMatchBoost: 0.1,
    maxConfidence: 0.9,
  },
  // DDoS-Guard (common on Chinese/Russian sites)
  {
    type: 'cloudflare',  // DDoS-Guard behaves like CF challenges
    patterns: [
      /ddosguard/i,
      /DDoS-Guard/i,
      /ddg_iu_check/i,
      /__ddg_/i,
      /check\.ddos-guard/i,
    ],
    baseConfidence: 0.65,
    perMatchBoost: 0.1,
    maxConfidence: 0.9,
  },
  // PerimeterX / HUMAN Security
  {
    type: 'unknown',
    patterns: [
      /_pxAppId/i,
      /PerimeterX/i,
      /perimeterx/i,
      /humansecurity/i,
      /collector\.px-cdn\.net/i,
    ],
    baseConfidence: 0.7,
    perMatchBoost: 0.1,
    maxConfidence: 0.9,
  },
];

// ==================== Detection Function ====================

/**
 * Detect CAPTCHA in fetched content.
 *
 * @param html - The HTML response body
 * @param url - The final URL (after redirects)
 * @param statusCode - HTTP status code
 * @returns Detection result with type, confidence, and evidence
 */
export function detectCaptcha(
  html: string,
  url: string,
  statusCode: number
): CaptchaDetection {
  const evidence: string[] = [];
  let bestMatch: { type: CaptchaDetection['type']; confidence: number } | null = null;

  // 1. Check HTTP status + Cloudflare/Anti-bot headers heuristic
  // 403 with Cloudflare or DDoS-Guard signals is a strong indicator
  if (statusCode === 403) {
    // Check for Cloudflare indicators in HTML
    if (/cf-ray/i.test(html) || /cf-mitigated/i.test(html) || /cloudflare/i.test(html)) {
      evidence.push('HTTP 403 + Cloudflare 响应头');
      if (!bestMatch || bestMatch.confidence < 0.85) {
        bestMatch = { type: 'cloudflare', confidence: 0.85 };
      }
    }
    // Check for DDoS-Guard indicators
    if (/ddosguard/i.test(html) || /DDoS-Guard/i.test(html) || /__ddg_/.test(html)) {
      evidence.push('HTTP 403 + DDoS-Guard 响应');
      if (!bestMatch || bestMatch.confidence < 0.8) {
        bestMatch = { type: 'ddos_guard', confidence: 0.8 };
      }
    }
    // Check for PerimeterX indicators
    if (/_pxAppId/.test(html) || /PerimeterX/i.test(html)) {
      evidence.push('HTTP 403 + PerimeterX 响应');
      if (!bestMatch || bestMatch.confidence < 0.8) {
        bestMatch = { type: 'perimeterx', confidence: 0.8 };
      }
    }
  }

  // 2. Check for meta redirect to challenge page
  const metaRedirectMatch = html.match(
    /<meta\s+http-equiv\s*=\s*["']refresh["']\s+content\s*=\s*["']\d+;\s*url=([^"'>]*challenge[^"'>]*)["']/i
  );
  if (metaRedirectMatch) {
    evidence.push(`Meta 重定向到验证页面: ${metaRedirectMatch[1].slice(0, 80)}`);
    if (!bestMatch || bestMatch.confidence < 0.7) {
      bestMatch = { type: 'unknown', confidence: 0.7 };
    }
  }

  // 3. Check HTML content against all detection rules
  for (const rule of HTML_RULES) {
    let matchCount = 0;
    for (let patternIndex = 0; patternIndex < rule.patterns.length; patternIndex++) {
      const pattern = rule.patterns[patternIndex];
      if (pattern.test(html)) {
        matchCount++;
        evidence.push(`${rule.type}:${patternIndex}: 匹配 ${pattern.source}`);
      }
    }

    if (matchCount > 0) {
      const confidence = Math.min(
        rule.baseConfidence + (matchCount - 1) * rule.perMatchBoost,
        rule.maxConfidence
      );
      if (!bestMatch || confidence > bestMatch.confidence) {
        bestMatch = { type: rule.type, confidence };
      }
    }
  }

  // 4. Deduplicate evidence (keep first occurrence of each type:patternIndex prefix)
  const seen = new Set<string>();
  const dedupedEvidence = evidence.filter(e => {
    const colonIdx = e.indexOf(':');
    if (colonIdx < 0) return true;
    const secondColonIdx = e.indexOf(':', colonIdx + 1);
    const dedupKey = secondColonIdx >= 0 ? e.substring(0, secondColonIdx) : e.substring(0, colonIdx);
    if (seen.has(dedupKey)) return false;
    seen.add(dedupKey);
    return true;
  });

  if (bestMatch && bestMatch.confidence > 0.5) {
    return {
      detected: true,
      type: bestMatch.type,
      confidence: Math.round(bestMatch.confidence * 100) / 100,
      evidence: dedupedEvidence,
    };
  }

  return {
    detected: false,
    type: 'unknown',
    confidence: 0,
    evidence: [],
  };
}

// ==================== CAPTCHA Type Label Map ====================

/** Human-readable labels for CAPTCHA types (Chinese) */
export const CAPTCHA_TYPE_LABELS: Record<CaptchaDetection['type'], string> = {
  recaptcha_v2: 'reCAPTCHA v2',
  recaptcha_v3: 'reCAPTCHA v3',
  hcaptcha: 'hCaptcha',
  geetest: 'GeeTest',
  cloudflare: 'Cloudflare',
  turnstile: 'Turnstile',
  ddos_guard: 'DDoS-Guard',
  perimeterx: 'PerimeterX',
  custom: '图片验证码',
  unknown: '未知验证码',
};

/** Short badge labels for CAPTCHA types */
export const CAPTCHA_BADGE_LABELS: Record<CaptchaDetection['type'], string> = {
  recaptcha_v2: 'reCAPTCHA',
  recaptcha_v3: 'reCAPTCHA',
  hcaptcha: 'hCaptcha',
  geetest: 'GeeTest',
  cloudflare: 'CF',
  turnstile: 'Turnstile',
  ddos_guard: 'DDG',
  perimeterx: 'PX',
  custom: '验证码',
  unknown: '验证码',
};

// ==================== Additional CAPTCHA Detection ====================

/**
 * Detect DataDome CAPTCHA from HTML content.
 * DataDome serves its own CAPTCHA when it identifies a request as bot traffic.
 */
export function detectDataDomeCaptcha(html: string): CaptchaDetection {
  const evidence: string[] = [];

  if (/DataDomeCAPTCHA/i.test(html)) {
    evidence.push('DataDomeCAPTCHA element');
  }
  if (/datadome.*captcha/i.test(html)) {
    evidence.push('DataDome captcha string');
  }
  if (/captcha\.datadome\.co/i.test(html)) {
    evidence.push('captcha.datadome.co domain');
  }
  if (/geo\.captcha\.datadome/i.test(html)) {
    evidence.push('geo.captcha.datadome domain');
  }

  if (evidence.length > 0) {
    return {
      detected: true,
      type: 'custom',
      confidence: Math.min(0.7 + evidence.length * 0.1, 0.95),
      evidence,
    };
  }

  return { detected: false, type: 'unknown', confidence: 0, evidence: [] };
}

/**
 * Detect Kasada anti-bot challenge from HTML content.
 * Kasada uses obfuscated JavaScript challenges that are difficult to solve programmatically.
 */
export function detectKasadaChallenge(html: string): CaptchaDetection {
  const evidence: string[] = [];

  if (/kasada/i.test(html)) {
    evidence.push('Kasada string');
  }
  if (/ksd\.io/i.test(html)) {
    evidence.push('ksd.io domain');
  }
  if (/X-KPSDK-/i.test(html)) {
    evidence.push('X-KPSDK header pattern');
  }
  if (/KPSDK/i.test(html)) {
    evidence.push('KPSDK string');
  }
  if (/kpsdk/i.test(html)) {
    evidence.push('kpsdk string');
  }

  if (evidence.length > 0) {
    return {
      detected: true,
      type: 'unknown',
      confidence: Math.min(0.6 + evidence.length * 0.15, 0.9),
      evidence,
    };
  }

  return { detected: false, type: 'unknown', confidence: 0, evidence: [] };
}

// ==================== CAPTCHA Pre-Detection & Avoidance ====================

/**
 * CAPTCHA Pre-Detection: proactively detect when a domain is likely to
 * trigger a CAPTCHA before we even make the request, based on historical data.
 *
 * Features:
 *   - Pre-request heuristic: if a domain has triggered 3+ CAPTCHAs in the last hour,
 *     automatically upgrade the engine for that domain
 *   - CAPTCHA solving time estimation (based on historical data)
 *   - CAPTCHA avoidance: proactively slow down or use different proxy when
 *     approaching a CAPTCHA threshold
 */

interface CaptGchaHistoryEntry {
  timestamp: number;
  type: CaptchaDetection['type'];
  solvingTimeMs?: number;
}

interface DomainCaptchaState {
  /** History of CAPTCHA encounters */
  history: CaptGchaHistoryEntry[];
  /** Total CAPTCHAs encountered (all-time) */
  totalCaptchas: number;
  /** Average solving time (ms) per type */
  avgSolvingTimeByType: Record<string, number>;
  /** Whether engine upgrade was recommended */
  engineUpgradeRecommended: boolean;
}

const domainCaptchaStates = new Map<string, DomainCaptchaState>();
const MAX_DOMAIN_STATES = 200;
const HISTORY_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const CAPTCHA_THRESHOLD_PER_HOUR = 3;

/**
 * Record a CAPTCHA encounter for a domain.
 * Call this when a CAPTCHA is detected in a response.
 *
 * @param domain - Target domain
 * @param type - CAPTCHA type detected
 * @param solvingTimeMs - Time taken to solve the CAPTCHA (if solved), in ms
 */
export function recordCaptchaEncounter(domain: string, type: CaptchaDetection['type'], solvingTimeMs?: number): void {
  let state = domainCaptchaStates.get(domain);
  if (!state) {
    if (domainCaptchaStates.size >= MAX_DOMAIN_STATES) {
      const firstKey = domainCaptchaStates.keys().next().value;
      if (firstKey) domainCaptchaStates.delete(firstKey);
    }
    state = {
      history: [],
      totalCaptchas: 0,
      avgSolvingTimeByType: {},
      engineUpgradeRecommended: false,
    };
    domainCaptchaStates.set(domain, state);
  }

  const entry: CaptGchaHistoryEntry = {
    timestamp: Date.now(),
    type,
    solvingTimeMs,
  };
  state.history.push(entry);
  state.totalCaptchas++;

  // Update average solving time for this type
  if (solvingTimeMs !== undefined) {
    const key = type;
    const existing = state.avgSolvingTimeByType[key] || 0;
    const count = state.history.filter(h => h.type === type && h.solvingTimeMs !== undefined).length;
    state.avgSolvingTimeByType[key] = Math.round((existing * (count - 1) + solvingTimeMs) / count);
  }

  // Check if engine upgrade is recommended
  const recentCount = getRecentCaptchaCount(domain);
  if (recentCount >= CAPTCHA_THRESHOLD_PER_HOUR && !state.engineUpgradeRecommended) {
    state.engineUpgradeRecommended = true;
    console.log(`[CaptchaDetector] ${domain}: ${recentCount} CAPTCHAs in last hour — engine upgrade recommended`);
  }
}

/**
 * Get the number of CAPTCHAs a domain has triggered in the last hour.
 */
export function getRecentCaptchaCount(domain: string): number {
  const state = domainCaptchaStates.get(domain);
  if (!state) return 0;

  const cutoff = Date.now() - HISTORY_WINDOW_MS;
  // Clean old entries
  state.history = state.history.filter(h => h.timestamp >= cutoff);
  return state.history.length;
}

/**
 * Pre-request heuristic: should we upgrade the engine for this domain?
 * Returns the recommended engine upgrade if the domain has triggered
 * 3+ CAPTCHAs in the last hour.
 *
 * @param domain - Target domain
 * @returns Recommended engine, or null if no upgrade needed
 */
export function getCaptchaPreDetection(domain: string): {
  shouldUpgrade: boolean;
  recommendedEngine: string | null;
  recentCaptchaCount: number;
  estimatedSolveTime: number;
  shouldSlowDown: boolean;
  shouldSwitchProxy: boolean;
} {
  const state = domainCaptchaStates.get(domain);
  const recentCount = getRecentCaptchaCount(domain);

  if (!state || recentCount === 0) {
    return {
      shouldUpgrade: false,
      recommendedEngine: null,
      recentCaptchaCount: 0,
      estimatedSolveTime: 0,
      shouldSlowDown: false,
      shouldSwitchProxy: false,
    };
  }

  // Determine if engine upgrade is needed
  const shouldUpgrade = recentCount >= CAPTCHA_THRESHOLD_PER_HOUR;

  // Choose engine based on most common CAPTCHA type
  let recommendedEngine: string | null = null;
  if (shouldUpgrade) {
    // Count by type to find the most common
    const typeCounts: Record<string, number> = {};
    for (const entry of state.history) {
      typeCounts[entry.type] = (typeCounts[entry.type] || 0) + 1;
    }
    const mostCommonType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0]?.[0];

    switch (mostCommonType) {
      case 'cloudflare':
      case 'turnstile':
        recommendedEngine = 'playwright'; // Need JS rendering for Cloudflare
        break;
      case 'geetest':
        recommendedEngine = 'obscura'; // Need stealth for GeeTest
        break;
      case 'recaptcha_v2':
      case 'recaptcha_v3':
        recommendedEngine = 'playwright'; // Need JS for reCAPTCHA
        break;
      default:
        recommendedEngine = 'obscura'; // Default to stealth engine
    }
  }

  // Estimate solving time based on historical data
  const recentEntries = state.history;
  const solveTimes = recentEntries
    .filter(e => e.solvingTimeMs !== undefined)
    .map(e => e.solvingTimeMs!);
  const estimatedSolveTime = solveTimes.length > 0
    ? Math.round(solveTimes.reduce((a, b) => a + b, 0) / solveTimes.length)
    : estimateDefaultSolveTime(state.history[state.history.length - 1]?.type || 'unknown');

  // Determine if we should slow down (approaching threshold)
  const shouldSlowDown = recentCount >= CAPTCHA_THRESHOLD_PER_HOUR - 1;

  // Determine if we should switch proxy (high CAPTCHA rate suggests IP is flagged)
  const shouldSwitchProxy = recentCount >= CAPTCHA_THRESHOLD_PER_HOUR + 2;

  return {
    shouldUpgrade,
    recommendedEngine,
    recentCaptchaCount: recentCount,
    estimatedSolveTime,
    shouldSlowDown,
    shouldSwitchProxy,
  };
}

/**
 * Estimate default CAPTCHA solving time by type (when no historical data available).
 */
function estimateDefaultSolveTime(type: CaptchaDetection['type']): number {
  const defaults: Record<string, number> = {
    recaptcha_v2: 30000,  // 30 seconds (image selection)
    recaptcha_v3: 5000,   // 5 seconds (invisible, usually auto-pass)
    hcaptcha: 25000,      // 25 seconds (similar to reCAPTCHA v2)
    geetest: 15000,       // 15 seconds (slide puzzle)
    cloudflare: 10000,    // 10 seconds (challenge page)
    turnstile: 3000,      // 3 seconds (invisible challenge)
    ddos_guard: 8000,     // 8 seconds (JS challenge)
    perimeterx: 12000,    // 12 seconds (JS challenge)
    custom: 20000,        // 20 seconds (unknown type, conservative)
    unknown: 20000,       // 20 seconds (unknown type, conservative)
  };
  return defaults[type] || 20000;
}

/**
 * Get CAPTCHA pre-detection stats for all domains.
 */
export function getCaptchaPreDetectionStats(): Record<string, {
  totalCaptchas: number;
  recentCaptchaCount: number;
  engineUpgradeRecommended: boolean;
  avgSolvingTimeByType: Record<string, number>;
}> {
  const result: Record<string, {
    totalCaptchas: number;
    recentCaptchaCount: number;
    engineUpgradeRecommended: boolean;
    avgSolvingTimeByType: Record<string, number>;
  }> = {};

  for (const [domain, state] of domainCaptchaStates) {
    result[domain] = {
      totalCaptchas: state.totalCaptchas,
      recentCaptchaCount: getRecentCaptchaCount(domain),
      engineUpgradeRecommended: state.engineUpgradeRecommended,
      avgSolvingTimeByType: { ...state.avgSolvingTimeByType },
    };
  }

  return result;
}

/**
 * Reset CAPTCHA pre-detection state for a domain or all domains.
 */
export function resetCaptchaPreDetection(domain?: string): void {
  if (domain) {
    domainCaptchaStates.delete(domain);
  } else {
    domainCaptchaStates.clear();
  }
}
