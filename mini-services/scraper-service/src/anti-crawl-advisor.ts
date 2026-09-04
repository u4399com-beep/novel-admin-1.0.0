/**
 * Anti-Crawl Strategy Auto-Recommendation Engine
 *
 * Analyzes detected patterns from rate-limiter, adaptive-delay, captcha-detector,
 * and proxy-manager to generate actionable anti-crawl configuration recommendations.
 */

import { rateLimiter, type DomainRateState } from './rate-limiter';
import { adaptiveDelay, type DomainStats as DelayDomainStats } from './adaptive-delay';
import { proxyManager } from './proxy-manager';
import { sessionManager } from './session-manager';

// ==================== Types ====================

export interface DetectionSignal {
  type: 'captcha' | 'block' | 'rate_limit' | 'redirect' | 'empty_content' | 'slow_response' | 'fingerprint_detect' | 'js_challenge' | 'honeypot' | 'css_trap' | 'ddos_guard' | 'perimeterx' | 'rate_limit_header' | 'retry_after';
  domain: string;
  count: number;
  lastSeen: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  details?: string;
}

export interface Recommendation {
  id: string;
  category: 'engine' | 'proxy' | 'delay' | 'stealth' | 'captcha' | 'rate_limit' | 'cookie' | 'session';
  priority: number;
  title: string;
  description: string;
  configKey: string;
  currentValue: unknown;
  recommendedValue: unknown;
  reasoning: string;
  estimatedImpact: 'high' | 'medium' | 'low';
}

export interface AdvisorReport {
  domain: string;
  threatLevel: 'minimal' | 'low' | 'medium' | 'high' | 'critical';
  signals: DetectionSignal[];
  recommendations: Recommendation[];
  currentConfig: Record<string, unknown>;
  score: number;
  potentialScore: number;
}

// ==================== Known Hard Sites ====================

const KNOWN_HARD_SITES = new Set([
  'qidian.com',
  'zongheng.com',
  '17k.com',
  'jjwxc.net',
  'sfacg.com',
  'book.qidian.com',
  'www.qidian.com',
]);

// ==================== Internal State Tracking ====================

/** In-memory tracking of per-domain detection events */
interface DomainDetectionHistory {
  captchaCount: number;
  blockCount: number;      // 403
  rateLimitCount: number;  // 429
  redirectCount: number;
  emptyContentCount: number;
  slowResponseCount: number;
  fingerprintDetectCount: number;
  jsChallengeCount: number;
  honeypotCount: number;         // honeypot links detected
  cssTrapCount: number;          // CSS traps detected
  ddosGuardCount: number;        // DDoS-Guard detections
  perimeterxCount: number;       // PerimeterX detections
  rateLimitHeaderCount: number;  // X-RateLimit-* headers
  retryAfterCount: number;       // Retry-After headers
  captchaTimestamps: number[];
  blockTimestamps: number[];
  rateLimitTimestamps: number[];
  cloudflareDetected: boolean;
  ddosGuardDetected: boolean;
  perimeterxDetected: boolean;
  totalRequests: number;
  successRequests: number;
  lastActivity: number;
  /** Rolling bot confidence score (0-100) from signal detector */
  botConfidenceScore: number;
}

const TEN_MINUTES = 10 * 60 * 1000;
const THIRTY_MINUTES = 30 * 60 * 1000;
const MAX_DOMAINS = 200; // Maximum domains tracked to prevent unbounded memory growth

// ==================== AntiCrawlAdvisor ====================

class AntiCrawlAdvisor {
  private domainHistory = new Map<string, DomainDetectionHistory>();
  private static instance: AntiCrawlAdvisor;

  private constructor() {}

  static getInstance(): AntiCrawlAdvisor {
    if (!AntiCrawlAdvisor.instance) {
      AntiCrawlAdvisor.instance = new AntiCrawlAdvisor();
    }
    return AntiCrawlAdvisor.instance;
  }

  /**
   * Record a detection event for a domain (called by engines on response).
   * Note: totalRequests is NOT incremented here — only in recordSuccess() and recordFailure()
   * to avoid double-counting when a request triggers detection and also succeeds/fails.
   */
  recordDetection(
    domain: string,
    type: DetectionSignal['type'],
    details: string,
    severity?: DetectionSignal['severity'],
  ): void {
    // Evict oldest domain if at capacity
    if (this.domainHistory.size >= MAX_DOMAINS && !this.domainHistory.has(domain)) {
      let oldestDomain = '';
      let oldestTime = Infinity;
      for (const [d, h] of this.domainHistory.entries()) {
        if (h.lastActivity < oldestTime) {
          oldestTime = h.lastActivity;
          oldestDomain = d;
        }
      }
      if (oldestDomain) {
        this.domainHistory.delete(oldestDomain);
      }
    }

    const h = this.getOrCreateHistory(domain);
    h.lastActivity = Date.now();

    const now = Date.now();
    const ROLLING_WINDOW = THIRTY_MINUTES;
    const pruneTimestamps = (arr: number[]) => {
      let cutoff = arr.length; // Default: clear all if everything is stale
      for (let i = 0; i < arr.length; i++) {
        if (now - arr[i] <= ROLLING_WINDOW) { cutoff = i; break; }
      }
      if (cutoff > 0) arr.splice(0, cutoff);
    };

    switch (type) {
      case 'captcha':
        h.captchaCount++;
        pruneTimestamps(h.captchaTimestamps);
        h.captchaTimestamps.push(now);
        if (details?.includes('cloudflare') || details?.includes('Cloudflare')) {
          h.cloudflareDetected = true;
        }
        break;
      case 'block':
        h.blockCount++;
        pruneTimestamps(h.blockTimestamps);
        h.blockTimestamps.push(now);
        break;
      case 'rate_limit':
        h.rateLimitCount++;
        pruneTimestamps(h.rateLimitTimestamps);
        h.rateLimitTimestamps.push(now);
        break;
      case 'redirect':
        h.redirectCount++;
        break;
      case 'empty_content':
        h.emptyContentCount++;
        break;
      case 'slow_response':
        h.slowResponseCount++;
        break;
      case 'fingerprint_detect':
        h.fingerprintDetectCount++;
        break;
      case 'js_challenge':
        h.jsChallengeCount++;
        h.cloudflareDetected = true;
        break;
      case 'honeypot':
        h.honeypotCount++;
        break;
      case 'css_trap':
        h.cssTrapCount++;
        break;
      case 'ddos_guard':
        h.ddosGuardCount++;
        h.ddosGuardDetected = true;
        break;
      case 'perimeterx':
        h.perimeterxCount++;
        h.perimeterxDetected = true;
        break;
      case 'rate_limit_header':
        h.rateLimitHeaderCount++;
        break;
      case 'retry_after':
        h.retryAfterCount++;
        break;
    }
  }

  /** Record a successful request (used for success rate calculation) */
  recordSuccess(domain: string): void {
    const h = this.getOrCreateHistory(domain);
    h.successRequests++;
    h.lastActivity = Date.now();
    h.totalRequests++;
  }

  /** Record a failed request (used for success rate calculation) */
  recordFailure(domain: string): void {
    const h = this.getOrCreateHistory(domain);
    h.totalRequests++;
    h.lastActivity = Date.now();
  }

  /**
   * Analyze a domain and generate a full advisor report.
   */
  analyze(domain: string, currentAntiCrawl?: Record<string, unknown>): AdvisorReport {
    const config = currentAntiCrawl || {};
    const signals = this.gatherSignals(domain);
    const currentScore = this.scoreConfig(config);
    const recommendations = this.generateRecommendations(signals, config, domain);
    const potentialScore = Math.min(100, currentScore + this.estimateScoreBoost(recommendations));
    const threatLevel = this.computeThreatLevel(signals, recommendations);

    return {
      domain,
      threatLevel,
      signals,
      recommendations,
      currentConfig: config,
      score: currentScore,
      potentialScore,
    };
  }

  /** Get raw detection signals for a domain */
  getDomainSignals(domain: string): DetectionSignal[] {
    return this.gatherSignals(domain);
  }

  // ==================== Signal Gathering ====================

  private gatherSignals(domain: string): DetectionSignal[] {
    const signals: DetectionSignal[] = [];
    const now = Date.now();
    const history = this.domainHistory.get(domain);

    // Time-based decay: decay proportional to elapsed time (30min half-life)
    // This prevents frequent polling from abnormally fast decay
    if (history) {
      const elapsed = (now - history.lastActivity) / THIRTY_MINUTES;
      const factor = Math.pow(0.9, elapsed);
      history.emptyContentCount = Math.round(history.emptyContentCount * factor);
      history.fingerprintDetectCount = Math.round(history.fingerprintDetectCount * factor);
      history.jsChallengeCount = Math.round(history.jsChallengeCount * factor);
      history.slowResponseCount = Math.round(history.slowResponseCount * factor);
    }

    // Safely gather external module state with fallback defaults
    let rateState: DomainRateState;
    try {
      rateState = rateLimiter.getDomainState(domain);
    } catch {
      rateState = { domain, status: 'normal', currentRPM: 0, maxRPM: 60, burstRemaining: 0, penaltyActive: false, penaltyUntil: 0, lastRequestTime: 0, estimatedWaitMs: 0 };
    }

    let delayState: DelayDomainStats;
    try {
      delayState = adaptiveDelay.getDomainStats(domain);
    } catch {
      delayState = { domain, currentDelay: 0, backoffLevel: 0, consecutiveErrors: 0, avgResponseTime: 0, lastRequestTime: 0, status: 'normal' };
    }

    // 1. Captcha signals from history
    if (history) {
      const recentCaptchas = history.captchaTimestamps.filter(t => now - t < TEN_MINUTES).length;
      if (recentCaptchas > 0) {
        signals.push({
          type: 'captcha',
          domain,
          count: recentCaptchas,
          lastSeen: history.captchaTimestamps[history.captchaTimestamps.length - 1] || now,
          severity: recentCaptchas > 5 ? 'critical' : recentCaptchas > 3 ? 'high' : recentCaptchas > 1 ? 'medium' : 'low',
          details: history.cloudflareDetected ? '检测到 Cloudflare 验证' : undefined,
        });
      }

      // 2. Block signals (403)
      const recentBlocks = history.blockTimestamps.filter(t => now - t < TEN_MINUTES).length;
      if (recentBlocks > 0) {
        signals.push({
          type: 'block',
          domain,
          count: recentBlocks,
          lastSeen: history.blockTimestamps[history.blockTimestamps.length - 1] || now,
          severity: recentBlocks > 5 ? 'critical' : recentBlocks > 3 ? 'high' : 'medium',
          details: `403 Forbidden ${recentBlocks} 次`,
        });
      }

      // 3. Rate limit signals (429)
      const recentRateLimits = history.rateLimitTimestamps.filter(t => now - t < TEN_MINUTES).length;
      if (recentRateLimits > 0) {
        signals.push({
          type: 'rate_limit',
          domain,
          count: recentRateLimits,
          lastSeen: history.rateLimitTimestamps[history.rateLimitTimestamps.length - 1] || now,
          severity: recentRateLimits > 10 ? 'critical' : recentRateLimits > 5 ? 'high' : 'medium',
          details: `429 Too Many Requests ${recentRateLimits} 次`,
        });
      }

      // 4. Empty content signals
      if (history.emptyContentCount > 0) {
        const emptyRate = history.totalRequests > 0
          ? history.emptyContentCount / history.totalRequests
          : 0;
        if (emptyRate > 0.1) {
          signals.push({
            type: 'empty_content',
            domain,
            count: history.emptyContentCount,
            lastSeen: now,
            severity: emptyRate > 0.5 ? 'critical' : emptyRate > 0.3 ? 'high' : 'medium',
            details: `空内容率 ${Math.round(emptyRate * 100)}%`,
          });
        }
      }

      // 5. JS challenge signals
      if (history.jsChallengeCount > 0) {
        signals.push({
          type: 'js_challenge',
          domain,
          count: history.jsChallengeCount,
          lastSeen: now,
          severity: 'high',
          details: `JS 挑战检测 ${history.jsChallengeCount} 次`,
        });
      }

      // 6. Fingerprint detection
      if (history.fingerprintDetectCount > 0) {
        signals.push({
          type: 'fingerprint_detect',
          domain,
          count: history.fingerprintDetectCount,
          lastSeen: now,
          severity: history.fingerprintDetectCount > 3 ? 'high' : 'medium',
          details: `浏览器指纹检测 ${history.fingerprintDetectCount} 次`,
        });
      }

      // 6a. Honeypot link detection
      if (history.honeypotCount > 0) {
        signals.push({
          type: 'honeypot',
          domain,
          count: history.honeypotCount,
          lastSeen: now,
          severity: history.honeypotCount > 5 ? 'high' : 'medium',
          details: `Honeypot 链接检测 ${history.honeypotCount} 次`,
        });
      }

      // 6b. CSS trap detection
      if (history.cssTrapCount > 0) {
        signals.push({
          type: 'css_trap',
          domain,
          count: history.cssTrapCount,
          lastSeen: now,
          severity: 'medium',
          details: `CSS 陷阱检测 ${history.cssTrapCount} 次`,
        });
      }

      // 6c. DDoS-Guard detection
      if (history.ddosGuardDetected) {
        signals.push({
          type: 'ddos_guard',
          domain,
          count: history.ddosGuardCount,
          lastSeen: now,
          severity: 'high',
          details: `DDoS-Guard 检测 ${history.ddosGuardCount} 次`,
        });
      }

      // 6d. PerimeterX detection
      if (history.perimeterxDetected) {
        signals.push({
          type: 'perimeterx',
          domain,
          count: history.perimeterxCount,
          lastSeen: now,
          severity: 'high',
          details: `PerimeterX 检测 ${history.perimeterxCount} 次`,
        });
      }

      // 6e. Rate limit header detection
      if (history.rateLimitHeaderCount > 0) {
        signals.push({
          type: 'rate_limit_header',
          domain,
          count: history.rateLimitHeaderCount,
          lastSeen: now,
          severity: history.rateLimitHeaderCount > 5 ? 'high' : 'low',
          details: `X-RateLimit 头检测 ${history.rateLimitHeaderCount} 次`,
        });
      }

      // 6f. Retry-After header detection
      if (history.retryAfterCount > 0) {
        signals.push({
          type: 'retry_after',
          domain,
          count: history.retryAfterCount,
          lastSeen: now,
          severity: 'medium',
          details: `Retry-After 头检测 ${history.retryAfterCount} 次`,
        });
      }
    }

    // 7. Rate limiter state signals
    if (rateState.penaltyActive) {
      signals.push({
        type: 'rate_limit',
        domain,
        count: rateState.currentRPM,
        lastSeen: now,
        severity: 'high',
        details: `速率惩罚中，RPM 降至 ${rateState.maxRPM}`,
      });
    } else if (rateState.status === 'throttled') {
      signals.push({
        type: 'rate_limit',
        domain,
        count: rateState.currentRPM,
        lastSeen: now,
        severity: 'medium',
        details: `已限流，当前 ${rateState.currentRPM}/${rateState.maxRPM} RPM`,
      });
    }

    // 8. Slow response signals from adaptive delay
    // Only flag if there are also errors (avoid false positives from legitimately large pages)
    if (delayState.avgResponseTime > 5000 && delayState.consecutiveErrors > 0) {
      signals.push({
        type: 'slow_response',
        domain,
        count: 1,
        lastSeen: delayState.lastRequestTime || now,
        severity: delayState.avgResponseTime > 10000 ? 'high' : 'medium',
        details: `平均响应时间 ${delayState.avgResponseTime}ms`,
      });
    }

    // 9. Consecutive errors → block signal
    if (delayState.consecutiveErrors >= 5) {
      signals.push({
        type: 'block',
        domain,
        count: delayState.consecutiveErrors,
        lastSeen: delayState.lastRequestTime || now,
        severity: delayState.consecutiveErrors >= 10 ? 'critical' : 'high',
        details: `连续错误 ${delayState.consecutiveErrors} 次`,
      });
    }

    // 10. Proxy-related: could check if domain has proxies (reserved for future use)

    // Sort signals by severity
    const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    signals.sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3));

    return signals;
  }

  // ==================== Config Scoring ====================

  private scoreConfig(config: Record<string, unknown>): number {
    let score = 0;

    // Engine selection (up to 25)
    const engine = config.engine as string | undefined;
    if (engine === 'obscura') score += 25;
    else if (engine === 'playwright') score += 20;
    else if (engine === 'firecrawl') score += 15;
    else score += 5; // cheerio baseline

    // Proxy (up to 20)
    if (config.useProxy || config.proxy) score += 20;
    else if (config.proxyRotation) score += 10;

    // UA rotation (up to 10)
    if (config.uaRotation) score += 10;

    // Human behavior (up to 10)
    if (config.humanBehavior) score += 10;

    // Captcha strategy (up to 15)
    const captchaStrategy = config.captchaStrategy as string | undefined;
    if (['cloudflare', 'geetest', 'auto'].includes(captchaStrategy || '')) score += 15;
    else if (captchaStrategy) score += 8;

    // Cookie management (up to 10)
    if (config.cookies || config.useCookies) score += 10;
    else if (config.sessionManagement) score += 5;

    // Session management (up to 10)
    if (config.sessionManagement || config.useSession) score += 10;

    // Adaptive delay (up to 5)
    if (config.adaptiveDelay) score += 5;

    // Custom delay (up to 5)
    if (config.delay && typeof config.delay === 'number' && config.delay >= 2000) score += 5;
    else if (config.delay) score += 2;

    return Math.min(score, 100);
  }

  // ==================== Recommendation Generation ====================

  private generateRecommendations(
    signals: DetectionSignal[],
    config: Record<string, unknown>,
    domain: string,
  ): Recommendation[] {
    const recs: Recommendation[] = [];
    const recId = (idx: number) => `rec-${Date.now()}-${idx}`;
    let idx = 0;

    const getSignal = (type: DetectionSignal['type']): DetectionSignal | undefined =>
      signals.find(s => s.type === type);

    const getEngine = (): string => (config.engine as string) || 'cheerio';

    // ── Rule 1: High captcha rate → Obscura + auto captcha ──
    const captchaSignal = getSignal('captcha');
    if (captchaSignal && captchaSignal.count > 3) {
      recs.push({
        id: recId(idx++),
        category: 'engine',
        priority: 90,
        title: '升级到 Obscura 隐身引擎',
        description: `检测到 ${captchaSignal.count} 次 CAPTCHA，Obscura 引擎具备更强的反检测能力`,
        configKey: 'engine',
        currentValue: getEngine(),
        recommendedValue: 'obscura',
        reasoning: `Rule 1: 10分钟内 CAPTCHA ${captchaSignal.count} 次 > 3，需升级引擎`,
        estimatedImpact: 'high',
      });
      recs.push({
        id: recId(idx++),
        category: 'captcha',
        priority: 85,
        title: '启用自动 CAPTCHA 策略',
        description: '自动识别验证码类型并选择最优处理策略',
        configKey: 'captchaStrategy',
        currentValue: config.captchaStrategy || 'delay-backoff',
        recommendedValue: 'auto',
        reasoning: 'Rule 1: 高 CAPTCHA 频率需要自动处理策略',
        estimatedImpact: 'high',
      });
    }

    // ── Rule 2: Frequent 429 → lower rate + proxy ──
    const rateLimitSignal = getSignal('rate_limit');
    if (rateLimitSignal && rateLimitSignal.count > 5) {
      recs.push({
        id: recId(idx++),
        category: 'delay',
        priority: 80,
        title: '增加请求间隔',
        description: `${rateLimitSignal.count} 次 429 响应，建议提高基础延迟`,
        configKey: 'delay',
        currentValue: config.delay || '1000-3000ms',
        recommendedValue: 5000,
        reasoning: `Rule 2: 429 达到 ${rateLimitSignal.count} 次，请求过于频繁`,
        estimatedImpact: 'high',
      });
      if (!config.useProxy && !config.proxy) {
        recs.push({
          id: recId(idx++),
          category: 'proxy',
          priority: 75,
          title: '启用代理 IP',
          description: '使用代理池分散请求来源，降低单 IP 触发速率限制的风险',
          configKey: 'useProxy',
          currentValue: false,
          recommendedValue: true,
          reasoning: 'Rule 2: 频繁 429 表明 IP 已被限流，需要代理轮换',
          estimatedImpact: 'high',
        });
      }
    }

    // ── Rule 3: 403 blocks → engine upgrade + UA rotation ──
    const blockSignal = getSignal('block');
    if (blockSignal && blockSignal.count > 3) {
      const currentEngine = getEngine();
      let upgradeTarget: string | null = null;
      if (currentEngine === 'cheerio') upgradeTarget = 'playwright';
      else if (currentEngine === 'playwright') upgradeTarget = 'obscura';

      if (upgradeTarget) {
        recs.push({
          id: recId(idx++),
          category: 'engine',
          priority: 88,
          title: `升级引擎到 ${upgradeTarget}`,
          description: `${blockSignal.count} 次 403 拦截，当前 ${currentEngine} 引擎防护不足`,
          configKey: 'engine',
          currentValue: currentEngine,
          recommendedValue: upgradeTarget,
          reasoning: `Rule 3: 403 达到 ${blockSignal.count} 次，${currentEngine} → ${upgradeTarget}`,
          estimatedImpact: 'high',
        });
      }

      if (!config.uaRotation) {
        recs.push({
          id: recId(idx++),
          category: 'stealth',
          priority: 70,
          title: '启用 UA 轮换',
          description: '403 拦截可能因固定 UA 被识别，启用轮换降低指纹一致性',
          configKey: 'uaRotation',
          currentValue: false,
          recommendedValue: true,
          reasoning: 'Rule 3: 403 高频 + 固定 UA = 指纹识别',
          estimatedImpact: 'medium',
        });
      }
    }

    // ── Rule 4: Slow responses → increase delay ──
    const slowSignal = getSignal('slow_response');
    if (slowSignal) {
      recs.push({
        id: recId(idx++),
        category: 'delay',
        priority: 55,
        title: '增加自适应延迟',
        description: `平均响应 ${slowSignal.details}，服务器可能在做请求限流`,
        configKey: 'adaptiveDelay',
        currentValue: config.adaptiveDelay || false,
        recommendedValue: true,
        reasoning: `Rule 4: 响应时间异常偏长，增加延迟可降低被检测概率`,
        estimatedImpact: 'medium',
      });
    }

    // ── Rule 5: Empty content rate > 30% → upgrade to playwright ──
    const emptySignal = getSignal('empty_content');
    if (emptySignal && emptySignal.severity !== 'low') {
      const currentEngine = getEngine();
      if (currentEngine === 'cheerio') {
        recs.push({
          id: recId(idx++),
          category: 'engine',
          priority: 82,
          title: '升级到 Playwright 引擎',
          description: `空内容率较高（${emptySignal.details}），可能需要 JS 渲染`,
          configKey: 'engine',
          currentValue: 'cheerio',
          recommendedValue: 'playwright',
          reasoning: 'Rule 5: Cheerio 无法执行 JS，空内容表明目标需要动态渲染',
          estimatedImpact: 'high',
        });
      }
    }

    // ── Rule 6: Consecutive errors > 5 → proxy + session ──
    if (signals.some(s => s.type === 'block' && s.count > 5)) {
      if (!config.proxyRotation) {
        recs.push({
          id: recId(idx++),
          category: 'proxy',
          priority: 85,
          title: '启用代理轮换',
          description: '连续错误表明当前 IP 已被封禁，需要轮换出口 IP',
          configKey: 'proxyRotation',
          currentValue: false,
          recommendedValue: true,
          reasoning: 'Rule 6: 连续错误 > 5，IP 被封风险极高',
          estimatedImpact: 'high',
        });
      }
      if (!config.sessionManagement && !config.useSession) {
        recs.push({
          id: recId(idx++),
          category: 'session',
          priority: 78,
          title: '启用会话管理',
          description: '通过会话复用和自动回收降低被检测风险',
          configKey: 'sessionManagement',
          currentValue: false,
          recommendedValue: true,
          reasoning: 'Rule 6: 高失败率需要会话隔离和自动恢复',
          estimatedImpact: 'medium',
        });
      }
    }

    // ── Rule 7: Cloudflare headers → CF strategy + obscura ──
    const history = this.domainHistory.get(domain);
    if (history?.cloudflareDetected) {
      recs.push({
        id: recId(idx++),
        category: 'captcha',
        priority: 92,
        title: '切换到 Cloudflare 专用策略',
        description: '检测到 Cloudflare 防护，使用专用绕过策略',
        configKey: 'captchaStrategy',
        currentValue: config.captchaStrategy || 'delay-backoff',
        recommendedValue: 'cloudflare',
        reasoning: 'Rule 7: Cloudflare 检测到，需专用策略配合隐身引擎',
        estimatedImpact: 'high',
      });
      if (getEngine() !== 'obscura') {
        recs.push({
          id: recId(idx++),
          category: 'engine',
          priority: 91,
          title: 'Cloudflare 站点必须使用 Obscura 引擎',
          description: 'Obscura 是目前唯一能可靠绕过 Cloudflare 5秒盾的引擎',
          configKey: 'engine',
          currentValue: getEngine(),
          recommendedValue: 'obscura',
          reasoning: 'Rule 7: Cloudflare + 非 Obscura = 无法通过 JS Challenge',
          estimatedImpact: 'high',
        });
      }
    }

    // ── Rule 8: Known hard sites → full anti-crawl config ──
    const isHardSite = KNOWN_HARD_SITES.has(domain) ||
      Array.from(KNOWN_HARD_SITES).some(h => domain.endsWith('.' + h));
    if (isHardSite) {
      const missingFeatures: string[] = [];
      const featureRecs: Array<{ configKey: string; currentValue: unknown; recommendedValue: unknown; category: string }> = [];
      if (getEngine() !== 'obscura') {
        missingFeatures.push('Obscura引擎');
        featureRecs.push({ configKey: 'engine', currentValue: getEngine(), recommendedValue: 'obscura', category: 'engine' });
      }
      if (!config.useProxy) {
        missingFeatures.push('代理IP');
        featureRecs.push({ configKey: 'proxy', currentValue: false, recommendedValue: true, category: 'proxy' });
      }
      if (!config.uaRotation) {
        missingFeatures.push('UA轮换');
        featureRecs.push({ configKey: 'uaRotation', currentValue: false, recommendedValue: true, category: 'stealth' });
      }
      if (!config.humanBehavior) {
        missingFeatures.push('人类行为模拟');
        featureRecs.push({ configKey: 'humanBehavior', currentValue: false, recommendedValue: true, category: 'stealth' });
      }
      if (!config.sessionManagement) {
        missingFeatures.push('会话管理');
        featureRecs.push({ configKey: 'sessionManagement', currentValue: false, recommendedValue: true, category: 'session' });
      }

      // Generate per-feature recommendations instead of a single "engine" rec
      for (const fr of featureRecs) {
        recs.push({
          id: recId(idx++),
          category: fr.category,
          priority: 65,
          title: `${domain} 为已知高防护站点 — 缺少${fr.configKey === 'engine' ? 'Obscura引擎' : fr.configKey}`,
          description: `建议启用${fr.configKey}，当前缺少: ${missingFeatures.join('、')}`,
          configKey: fr.configKey,
          currentValue: fr.currentValue,
          recommendedValue: fr.recommendedValue,
          reasoning: `Rule 8: ${domain} 在已知高防护站点列表中`,
          estimatedImpact: 'high',
        });
      }
    }

    // ── Rule 9: High success rate > 95% with no signals → reduce overhead ──
    if (signals.length === 0 && history && history.totalRequests > 10) {
      const successRate = history.successRequests / history.totalRequests;
      if (successRate > 0.95) {
        const overheadFeatures: string[] = [];
        if (getEngine() === 'obscura') overheadFeatures.push('降级引擎到 cheerio');
        if (config.useProxy && !config.proxyRotation) overheadFeatures.push('可移除固定代理');
        if (config.humanBehavior) overheadFeatures.push('可关闭人类行为模拟');

        if (overheadFeatures.length > 0) {
          recs.push({
            id: recId(idx++),
            category: 'engine',
            priority: 15,
            title: '当前站点防护较低，可减少开销',
            description: `成功率 ${Math.round(successRate * 100)}%，建议: ${overheadFeatures.join('、')}`,
            configKey: 'engine',
            currentValue: getEngine(),
            recommendedValue: 'cheerio',
            reasoning: `Rule 9: 成功率 > 95% 且无检测信号，可简化配置`,
            estimatedImpact: 'low',
          });
        }
      }
    }

    // ── Rule 10: Cheerio but JS rendering needed ──
    const jsChallenge = getSignal('js_challenge');
    if ((jsChallenge || emptySignal) && getEngine() === 'cheerio') {
      if (!recs.some(r => r.configKey === 'engine' && r.recommendedValue === 'playwright')) {
        recs.push({
          id: recId(idx++),
          category: 'engine',
          priority: 80,
          title: '目标站点需要 JS 渲染',
          description: 'Cheerio 无法执行 JavaScript，内容可能需要动态加载',
          configKey: 'engine',
          currentValue: 'cheerio',
          recommendedValue: 'playwright',
          reasoning: 'Rule 10: JS Challenge/空内容 + Cheerio = 内容不可达',
          estimatedImpact: 'high',
        });
      }
    }

    // ── Rule 11: No cookie management but domain may need login ──
    if (!config.useCookies && !config.cookies) {
      const domainSessions = sessionManager.getDomainSessions(domain);
      if (domainSessions.length > 0 && domainSessions.some(s => s.cookies.length > 2)) {
        recs.push({
          id: recId(idx++),
          category: 'cookie',
          priority: 45,
          title: '建议启用 Cookie 管理',
          description: `该域名已有 ${domainSessions.length} 个活跃会话含 Cookie，启用持久化可跨任务复用`,
          configKey: 'useCookies',
          currentValue: false,
          recommendedValue: true,
          reasoning: 'Rule 11: 域名已有登录态 Cookie，应启用管理以复用',
          estimatedImpact: 'medium',
        });
      }
    }

    // ── Rule 12: No session management but multi-page ──
    if (!config.sessionManagement && !config.useSession) {
      if (history && history.totalRequests > 20) {
        recs.push({
          id: recId(idx++),
          category: 'session',
          priority: 40,
          title: '建议启用会话管理',
          description: `已对 ${domain} 发起 ${history.totalRequests} 次请求，会话管理可保持指纹一致性`,
          configKey: 'sessionManagement',
          currentValue: false,
          recommendedValue: true,
          reasoning: 'Rule 12: 大量请求但无会话管理，每次请求可能暴露不同指纹',
          estimatedImpact: 'medium',
        });
      }
    }

    // ── Rule 13: DDoS-Guard detected → Obscura + delay ──
    if (history?.ddosGuardDetected) {
      if (getEngine() !== 'obscura') {
        recs.push({
          id: recId(idx++),
          category: 'engine',
          priority: 90,
          title: 'DDoS-Guard 检测 — 需 Obscura 引擎',
          description: 'DDoS-Guard 需要完整的浏览器环境来通过 JS 挑战',
          configKey: 'engine',
          currentValue: getEngine(),
          recommendedValue: 'obscura',
          reasoning: 'Rule 13: DDoS-Guard + 非 Obscura = 无法通过挑战',
          estimatedImpact: 'high',
        });
      }
      if (!config.adaptiveDelay) {
        recs.push({
          id: recId(idx++),
          category: 'delay',
          priority: 75,
          title: '启用自适应延迟（DDoS-Guard）',
          description: 'DDoS-Guard 对请求频率敏感，增加延迟降低触发概率',
          configKey: 'adaptiveDelay',
          currentValue: false,
          recommendedValue: true,
          reasoning: 'Rule 13: DDoS-Guard + 频繁请求会触发更严格的验证',
          estimatedImpact: 'medium',
        });
      }
    }

    // ── Rule 14: PerimeterX detected → Obscura + proxy rotation ──
    if (history?.perimeterxDetected) {
      if (getEngine() !== 'obscura') {
        recs.push({
          id: recId(idx++),
          category: 'engine',
          priority: 91,
          title: 'PerimeterX 检测 — 需 Obscura 引擎',
          description: 'PerimeterX (HUMAN Security) 需要完整浏览器指纹',
          configKey: 'engine',
          currentValue: getEngine(),
          recommendedValue: 'obscura',
          reasoning: 'Rule 14: PerimeterX + 非 Obscura = 被识别为 bot',
          estimatedImpact: 'high',
        });
      }
      if (!config.proxyRotation) {
        recs.push({
          id: recId(idx++),
          category: 'proxy',
          priority: 80,
          title: '启用代理轮换（PerimeterX）',
          description: 'PerimeterX 追踪 IP 行为模式，代理轮换分散请求',
          configKey: 'proxyRotation',
          currentValue: false,
          recommendedValue: true,
          reasoning: 'Rule 14: PerimeterX 可跨请求关联 IP + 指纹，需代理轮换',
          estimatedImpact: 'high',
        });
      }
    }

    // Sort by priority (highest first)
    recs.sort((a, b) => b.priority - a.priority);

    return recs;
  }

  // ==================== Helpers ====================

  private estimateScoreBoost(recommendations: Recommendation[]): number {
    let boost = 0;
    for (const rec of recommendations) {
      if (rec.estimatedImpact === 'high') boost += 15;
      else if (rec.estimatedImpact === 'medium') boost += 8;
      else boost += 3;
    }
    return Math.min(boost, 100);
  }

  private computeThreatLevel(
    signals: DetectionSignal[],
    recommendations: Recommendation[],
  ): AdvisorReport['threatLevel'] {
    const criticalSignals = signals.filter(s => s.severity === 'critical').length;
    const highSignals = signals.filter(s => s.severity === 'high').length;
    const highPriorityRecs = recommendations.filter(r => r.priority >= 80).length;

    if (criticalSignals > 0 || highPriorityRecs >= 3) return 'critical';
    if (highSignals > 2 || highPriorityRecs >= 2) return 'high';
    if (signals.length > 0 || highPriorityRecs >= 1) return 'medium';
    if (recommendations.length > 0) return 'low';
    return 'minimal';
  }

  private getOrCreateHistory(domain: string): DomainDetectionHistory {
    let h = this.domainHistory.get(domain);
    if (!h) {
      h = {
        captchaCount: 0,
        blockCount: 0,
        rateLimitCount: 0,
        redirectCount: 0,
        emptyContentCount: 0,
        slowResponseCount: 0,
        fingerprintDetectCount: 0,
        jsChallengeCount: 0,
        honeypotCount: 0,
        cssTrapCount: 0,
        ddosGuardCount: 0,
        perimeterxCount: 0,
        rateLimitHeaderCount: 0,
        retryAfterCount: 0,
        captchaTimestamps: [],
        blockTimestamps: [],
        rateLimitTimestamps: [],
        cloudflareDetected: false,
        ddosGuardDetected: false,
        perimeterxDetected: false,
        totalRequests: 0,
        successRequests: 0,
        lastActivity: 0,
        botConfidenceScore: 0,
      };
      this.domainHistory.set(domain, h);
    }
    return h;
  }

  /** Cleanup old history entries (called periodically) */
  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [domain, h] of this.domainHistory.entries()) {
      const inactive = now - h.lastActivity > THIRTY_MINUTES;
      // Also clean up domains that haven't been used recently, even if they had requests
      if ((inactive && h.totalRequests === 0) || now - h.lastActivity > 24 * 60 * 60 * 1000) {
        this.domainHistory.delete(domain);
        cleaned++;
        continue;
      }
      // Trim old timestamps
      const cutoff = now - THIRTY_MINUTES;
      h.captchaTimestamps = h.captchaTimestamps.filter(t => t > cutoff);
      h.blockTimestamps = h.blockTimestamps.filter(t => t > cutoff);
      h.rateLimitTimestamps = h.rateLimitTimestamps.filter(t => t > cutoff);
    }
    return cleaned;
  }
}

// Singleton export
export const antiCrawlAdvisor = AntiCrawlAdvisor.getInstance();

// Periodic cleanup every 30 minutes (unbounded growth prevention)
setInterval(() => {
  try {
    const cleaned = antiCrawlAdvisor.cleanup();
    if (cleaned > 0 && process.env.DEBUG === 'true') {
      console.log(`[AntiCrawlAdvisor] Cleaned up ${cleaned} inactive domains`);
    }
  } catch (err) {
    console.error('[AntiCrawlAdvisor] Periodic cleanup error:', err);
  }
}, 30 * 60 * 1000).unref();
