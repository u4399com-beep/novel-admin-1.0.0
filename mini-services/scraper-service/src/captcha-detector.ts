/**
 * CAPTCHA Detection Module
 *
 * Heuristic-based CAPTCHA detection from HTML content and HTTP response metadata.
 * Supports: reCAPTCHA v2/v3, hCaptcha, GeeTest, Cloudflare Challenge, custom image CAPTCHA.
 */

// ==================== Types ====================

export interface CaptchaDetection {
  detected: boolean;
  type: 'recaptcha_v2' | 'recaptcha_v3' | 'hcaptcha' | 'geetest' | 'cloudflare' | 'custom' | 'unknown';
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
  // reCAPTCHA v2 — patterns that are v2-specific (not matching v3 render= URLs)
  {
    type: 'recaptcha_v2',
    patterns: [
      /google\.com\/recaptcha(?!\/api\.js\?render)/i,
      /g-recaptcha/i,
      /grecaptcha\.render/i,
      /g-recaptcha-response/i,
      /class=.*g-recaptcha/i,
      /data-sitekey(?!.*render)/i,
    ],
    baseConfidence: 0.7,
    perMatchBoost: 0.1,
    maxConfidence: 0.95,
  },
  // reCAPTCHA v3 — higher base confidence since render= is a strong v3 signal
  {
    type: 'recaptcha_v3',
    patterns: [
      /recaptcha\/api\.js/i,
      /grecaptcha\.enterprise/i,
      /recaptchaV3/i,
      /grecaptcha\.execute/i,
      /\?render=/i,
    ],
    baseConfidence: 0.65,
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
      /cf\-turnstile/i,
      /challenges\.cloudflare\.com/i,
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
      /class=.*captcha/i,
      /id=.*captcha/i,
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

  // 1. Check HTTP status + Cloudflare headers heuristic
  // 403 with Cloudflare signals is a strong indicator
  if (statusCode === 403) {
    // Check for Cloudflare indicators in HTML (since we don't have raw headers here)
    if (/cf-ray/i.test(html) || /cf-mitigated/i.test(html) || /cloudflare/i.test(html)) {
      evidence.push('HTTP 403 + Cloudflare 响应头');
      if (!bestMatch || bestMatch.confidence < 0.85) {
        bestMatch = { type: 'cloudflare', confidence: 0.85 };
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
    for (const pattern of rule.patterns) {
      if (pattern.test(html)) {
        matchCount++;
        evidence.push(`${rule.type}: 匹配 ${pattern.source}`);
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

  // 4. Deduplicate evidence (keep first occurrence of each type prefix)
  const seen = new Set<string>();
  const dedupedEvidence = evidence.filter(e => {
    const prefix = e.split(':')[0];
    if (seen.has(prefix)) return false;
    seen.add(prefix);
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
  custom: '验证码',
  unknown: '验证码',
};
