/**
 * Rate Calibration System
 *
 * Automatically profiles and calibrates optimal rate/concurrency settings
 * for each scrape rule based on domain anti-crawl difficulty.
 *
 * Tier Classification:
 *   Tier 1 - EASY:    No anti-crawl, old CMS, small personal sites
 *   Tier 2 - MEDIUM:  Basic rate limiting (429 on excess)
 *   Tier 3 - HARD:    Cloudflare/PerimeterX/CAPTCHA
 *   Tier 4 - API:     API-based sources
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import { logger } from './logger';

// ==================== Types ====================

export type Tier = 1 | 2 | 3 | 4;

export interface DomainProfile {
  domain: string;
  tier: Tier;
  tierLabel: string;
  hasCloudflare: boolean;
  hasWAF: boolean;
  hasCookieAntiCrawl: boolean;
  engineType: string;
  stealthEnabled: boolean;
  responseTimeBaseline: number | null;
  recommendedRPM: number;
  recommendedConcurrency: number;
  recommendedMinDelay: number;
  recommendedMaxDelay: number;
}

export interface CalibrationResult {
  ruleName: string;
  ruleFile: string;
  domain: string;
  tier: Tier;
  tierLabel: string;
  previousThreadCount: number;
  previousMinDelay: number;
  previousMaxDelay: number;
  optimalRPM: number;
  optimalConcurrency: number;
  optimalMinDelay: number;
  optimalMaxDelay: number;
  antiCrawlConfig: Record<string, unknown>;
  probeResults: {
    profiled: boolean;
    probeTimestamp: string;
    detectedAntiCrawl: string[];
  };
}

export interface CalibrationReport {
  timestamp: string;
  totalRules: number;
  tierBreakdown: Record<string, number>;
  results: CalibrationResult[];
}

// ==================== Tier Configuration Presets ====================

const TIER_CONFIGS: Record<Tier, {
  label: string;
  rpm: number;
  concurrency: number;
  minDelay: number;
  maxDelay: number;
  antiCrawlConfig: Record<string, unknown>;
}> = {
  1: {
    label: 'EASY (no anti-crawl)',
    rpm: 30,
    concurrency: 4,
    minDelay: 1000,
    maxDelay: 2000,
    antiCrawlConfig: {
      stealthMode: 'basic',
      rotateUA: true,
      delayJitter: 0.3,
    },
  },
  2: {
    label: 'MEDIUM (basic rate limiting)',
    rpm: 20,
    concurrency: 2,
    minDelay: 2000,
    maxDelay: 4000,
    antiCrawlConfig: {
      stealthMode: 'moderate',
      rotateUA: true,
      delayJitter: 0.4,
      respect429: true,
    },
  },
  3: {
    label: 'HARD (Cloudflare/CAPTCHA)',
    rpm: 8,
    concurrency: 1,
    minDelay: 4000,
    maxDelay: 8000,
    antiCrawlConfig: {
      stealthMode: 'full',
      rotateUA: true,
      rotateProxy: true,
      delayJitter: 0.5,
      respect429: true,
      captchaAutoUpgrade: true,
    },
  },
  4: {
    label: 'API (special handling)',
    rpm: 15,
    concurrency: 3,
    minDelay: 1000,
    maxDelay: 2000,
    antiCrawlConfig: {
      stealthMode: 'basic',
      rotateUA: false,
      delayJitter: 0.2,
    },
  },
};

// ==================== Domain Classification ====================

// Known domain -> tier mapping based on manual analysis
const DOMAIN_TIER_MAP: Record<string, Tier> = {
  // Tier 1 - EASY: cheerio, old CMS, no anti-crawl
  'ptwxz.com': 1,
  'biqugse.com': 1,
  'ibiquwx.com': 1,
  'hetushu.com': 1,
  'biquwx.com': 1,
  'laobiao.cc': 1,
  '8kana.com': 1,
  'shucong.com': 1,
  'piaotia.com': 1,
  'ibiquges.com': 1,
  'xiaoshuodaquan.com': 1,
  'zhongwenzw.com': 1,
  'uukanshu.com': 1,
  'xbiqubao.com': 1,
  '101kks.com': 1,
  'aijjxs.com': 1,
  '80ge.info': 1,
  'shudugu.org': 1,
  'guichuideng.info': 1,

  // Tier 2 - MEDIUM: basic rate limits, JS render, engineFallback
  'biqu5200.com': 2,
  'biquge5200.com': 2,
  'duokanbiqu.com': 2,
  'bqg713.com': 2,
  'deqixs.cc': 2,
  'gegedangbook.com': 2,
  'wanbenshenzhan.com': 2,
  'm.jhssd.com': 2,
  'm.jhsssd.com': 2,
  'cn.ttkan.co': 2,
  '123duw.com': 2,
  'xinjianpan.com': 2,

  // Tier 3 - HARD: Cloudflare, WAF, CAPTCHA
  '69shuba.com': 3,
  'dongliuxiaoshuo.com': 3,
  'daweixs.com': 3,
  'dafengdagengren.com': 3,
  'yybsw.com': 3,
  'libahao2.com': 3,
  'book4.cc': 3,

  // Tier 4 - API
  'api-bc.wtzw.com': 4,
  'fq.taijiwang.top': 4,
};

// ==================== DomainProfiler ====================

export class DomainProfiler {
  /**
   * Profile a domain to determine its anti-crawl tier and characteristics.
   * Uses a combination of:
   *  1. Known domain tier mapping (pre-classified)
   *  2. Rule metadata signals (engine type, stealth, cloudflareBypass, etc.)
   *  3. URL pattern heuristics (api- prefix, etc.)
   */
  profile(domain: string, listUrl: string, ruleData: Record<string, unknown>): DomainProfile {
    // Normalize domain
    const normalizedDomain = domain.replace(/^www\./, '').toLowerCase();

    // Detect signals from rule data
    const engine = (ruleData.engine as string) || 'cheerio';
    const meta = ruleData.meta as Record<string, unknown> | undefined;
    const antiCrawl = ruleData.antiCrawlConfig as Record<string, unknown> | undefined;
    const stealthEnabled = (meta?.stealthEnabled as boolean) || false;
    const hasCloudflareBypass = !!(antiCrawl?.cloudflareBypass);
    const hasCookieHandling = !!(antiCrawl?.cookieHandling);
    const hasWAF = !!(meta?.wafType) || !!(meta?.regionBlocked);
    const isApiEngine = engine === 'api' || engine === 'cheerio-api';
    const isApiUrl = listUrl.includes('/api/') || normalizedDomain.startsWith('api-') || normalizedDomain.includes('.wtzw.com') || normalizedDomain.includes('taijiwang.top');

    // Determine tier
    let tier: Tier;

    // Check explicit mapping first
    const mappedTier = DOMAIN_TIER_MAP[normalizedDomain];
    if (mappedTier !== undefined) {
      tier = mappedTier;
    } else if (isApiEngine || isApiUrl) {
      tier = 4;
    } else if (hasCloudflareBypass || hasWAF || (stealthEnabled && engine === 'playwright')) {
      tier = 3;
    } else if (engine === 'playwright' || hasCookieHandling) {
      tier = 2;
    } else {
      tier = 1;
    }

    const config = TIER_CONFIGS[tier];

    return {
      domain: normalizedDomain,
      tier,
      tierLabel: config.label,
      hasCloudflare: hasCloudflareBypass,
      hasWAF,
      hasCookieAntiCrawl: hasCookieHandling,
      engineType: engine,
      stealthEnabled,
      responseTimeBaseline: null, // Would be populated by actual probing
      recommendedRPM: config.rpm,
      recommendedConcurrency: config.concurrency,
      recommendedMinDelay: config.minDelay,
      recommendedMaxDelay: config.maxDelay,
    };
  }

  /**
   * Probe a domain with actual HTTP requests to detect anti-crawl features.
   * Sends 3 lightweight HEAD/GET requests and checks headers.
   */
  async probeDomain(domain: string, listUrl: string): Promise<{
    responseTimeMs: number;
    hasCloudflare: boolean;
    hasRateLimit: boolean;
    hasCaptcha: boolean;
    serverTech: string[];
    statusCode: number;
  }> {
    const signals = {
      responseTimeMs: 0,
      hasCloudflare: false,
      hasRateLimit: false,
      hasCaptcha: false,
      serverTech: [] as string[],
      statusCode: 0,
    };

    try {
      const start = Date.now();
      const response = await fetch(listUrl, {
        method: 'HEAD',
        signal: AbortSignal.timeout(10000),
        redirect: 'follow',
      });
      signals.responseTimeMs = Date.now() - start;
      signals.statusCode = response.status;

      // Check Cloudflare headers
      const cfRay = response.headers.get('cf-ray');
      const cfCache = response.headers.get('cf-cache-status');
      const server = response.headers.get('server') || '';
      signals.hasCloudflare = !!(cfRay || cfCache || server.toLowerCase().includes('cloudflare'));

      // Check rate limit headers
      const rateLimitRemaining = response.headers.get('x-ratelimit-remaining');
      const retryAfter = response.headers.get('retry-after');
      signals.hasRateLimit = !!(rateLimitRemaining || retryAfter);

      // Detect server technology
      const poweredBy = response.headers.get('x-powered-by');
      if (server) signals.serverTech.push(server);
      if (poweredBy) signals.serverTech.push(poweredBy);

      // Detect CAPTCHA signals (403 with CF typically means challenge)
      signals.hasCaptcha = response.status === 403 && signals.hasCloudflare;

    } catch (err) {
      // Network error - domain may be down or blocking
      signals.statusCode = 0;
    }

    return signals;
  }
}

// ==================== RateCalibrator ====================

export class RateCalibrator {
  private profiler: DomainProfiler;
  private rulesDir: string;

  constructor(rulesDir?: string) {
    this.profiler = new DomainProfiler();
    this.rulesDir = rulesDir || resolve(import.meta.dir, 'scrape-rules');
  }

  /**
   * Calibrate a single rule file.
   * Profiles the domain and returns recommended settings.
   */
  async calibrateRule(rulePath: string): Promise<CalibrationResult> {
    const ruleData = JSON.parse(readFileSync(rulePath, 'utf-8')) as Record<string, unknown>;
    const domain = (ruleData.meta as Record<string, unknown>)?.domain as string || '';
    const listUrl = ruleData.listUrl as string || '';
    const ruleName = ruleData.name as string || '';

    // Profile the domain
    const profile = this.profiler.profile(domain, listUrl, ruleData);

    // Attempt live probing
    const detectedAntiCrawl: string[] = [];
    let probed = false;
    try {
      const probe = await this.profiler.probeDomain(domain, listUrl);
      probed = true;
      if (probe.hasCloudflare) detectedAntiCrawl.push('Cloudflare');
      if (probe.hasRateLimit) detectedAntiCrawl.push('Rate-Limit');
      if (probe.hasCaptcha) detectedAntiCrawl.push('CAPTCHA');
      if (probe.statusCode === 403) detectedAntiCrawl.push('HTTP-403');
      if (probe.statusCode === 0) detectedAntiCrawl.push('Unreachable');
    } catch {
      // Probing failed - use static classification
    }

    const tierConfig = TIER_CONFIGS[profile.tier];

    return {
      ruleName,
      ruleFile: rulePath,
      domain,
      tier: profile.tier,
      tierLabel: profile.tierLabel,
      previousThreadCount: ruleData.threadCount as number,
      previousMinDelay: ruleData.minDelay as number,
      previousMaxDelay: ruleData.maxDelay as number,
      optimalRPM: tierConfig.rpm,
      optimalConcurrency: tierConfig.concurrency,
      optimalMinDelay: tierConfig.minDelay,
      optimalMaxDelay: tierConfig.maxDelay,
      antiCrawlConfig: tierConfig.antiCrawlConfig,
      probeResults: {
        profiled: true,
        probeTimestamp: new Date().toISOString(),
        detectedAntiCrawl,
      },
    };
  }

  /**
   * Apply calibrated settings to a rule file (update threadCount, minDelay, maxDelay, antiCrawlConfig).
   */
  applyCalibration(rulePath: string, result: CalibrationResult): void {
    const ruleData = JSON.parse(readFileSync(rulePath, 'utf-8')) as Record<string, unknown>;

    ruleData.threadCount = result.optimalConcurrency;
    ruleData.minDelay = result.optimalMinDelay;
    ruleData.maxDelay = result.optimalMaxDelay;

    // Merge antiCrawlConfig (tier-based) into existing antiCrawlConfig
    const existingAntiCrawl = (ruleData.antiCrawlConfig as Record<string, unknown>) || {};
    ruleData.antiCrawlConfig = {
      ...existingAntiCrawl,
      ...result.antiCrawlConfig,
    };

    // Add tier metadata
    const meta = (ruleData.meta as Record<string, unknown>) || {};
    meta.rateCalibration = {
      tier: result.tier,
      tierLabel: result.tierLabel,
      optimalRPM: result.optimalRPM,
      calibratedAt: result.probeResults.probeTimestamp,
      detectedAntiCrawl: result.probeResults.detectedAntiCrawl,
    };
    ruleData.meta = meta;

    writeFileSync(rulePath, JSON.stringify(ruleData, null, 2) + '\n', 'utf-8');
  }
}

// ==================== Batch Calibration ====================

let lastCalibrationReport: CalibrationReport | null = null;
let calibrationInProgress = false;

/**
 * Calibrate all scrape rules and optionally apply the settings.
 */
export async function batchCalibrate(apply: boolean = false): Promise<CalibrationReport> {
  if (calibrationInProgress) {
    throw new Error('Calibration already in progress');
  }
  calibrationInProgress = true;

  try {
    const rulesDir = resolve(import.meta.dir, 'scrape-rules');
    const calibrator = new RateCalibrator(rulesDir);

    const files = readdirSync(rulesDir)
      .filter(f => f.endsWith('.json') && f !== 'engine-preferences.json' && f !== 'rate-calibration.json')
      .sort();

    const results: CalibrationResult[] = [];

    for (const file of files) {
      const rulePath = join(rulesDir, file);
      try {
        const result = await calibrator.calibrateRule(rulePath);
        if (apply) {
          calibrator.applyCalibration(rulePath, result);
        }
        results.push(result);
      } catch (err) {
        logger.error('RateCalibration', `Failed to calibrate ${file}`, { file, error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Tier breakdown
    const tierBreakdown: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0 };
    for (const r of results) {
      tierBreakdown[String(r.tier)] = (tierBreakdown[String(r.tier)] || 0) + 1;
    }

    const report: CalibrationReport = {
      timestamp: new Date().toISOString(),
      totalRules: results.length,
      tierBreakdown,
      results,
    };

    // Save report
    const reportPath = join(rulesDir, 'rate-calibration.json');
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf-8');

    lastCalibrationReport = report;
    return report;
  } finally {
    calibrationInProgress = false;
  }
}

/**
 * Calibrate a single rule by name.
 */
export async function calibrateSingleRule(ruleName: string, apply: boolean = false): Promise<CalibrationResult | null> {
  const rulesDir = resolve(import.meta.dir, 'scrape-rules');
  const rulePath = join(rulesDir, `${ruleName}.json`);

  if (!existsSync(rulePath)) {
    return null;
  }

  try {
    const calibrator = new RateCalibrator(rulesDir);
    const result = await calibrator.calibrateRule(rulePath);

    if (apply) {
      calibrator.applyCalibration(rulePath, result);
    }

    return result;
  } catch (err) {
    logger.error('RateCalibration', `Failed to calibrate rule ${ruleName}`, { ruleName, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Get the last calibration report.
 */
export function getCalibrationReport(): CalibrationReport | null {
  return lastCalibrationReport;
}

/**
 * Get calibration status.
 */
export function getCalibrationStatus(): {
  inProgress: boolean;
  lastCalibration: string | null;
  rulesCount: number;
} {
  const rulesDir = resolve(import.meta.dir, 'scrape-rules');
  const files = readdirSync(rulesDir).filter(f => f.endsWith('.json') && f !== 'engine-preferences.json' && f !== 'rate-calibration.json');

  return {
    inProgress: calibrationInProgress,
    lastCalibration: lastCalibrationReport?.timestamp || null,
    rulesCount: files.length,
  };
}

/**
 * Load saved calibration report from disk.
 */
export function loadSavedReport(): CalibrationReport | null {
  const reportPath = resolve(import.meta.dir, 'scrape-rules', 'rate-calibration.json');
  if (!existsSync(reportPath)) return null;
  try {
    return JSON.parse(readFileSync(reportPath, 'utf-8')) as CalibrationReport;
  } catch {
    return null;
  }
}
