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
