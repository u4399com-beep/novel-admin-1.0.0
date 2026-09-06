/**
 * Scraper Service - Novel Management System
 * Port: 3099
 *
 * A standalone Bun mini-service handling all web scraping operations.
 * Architecture: Pluggable engine system (Cheerio / Playwright / Firecrawl / AgentQL / CloudBrowser)
 *   + Request Queue (PostgreSQL persistence) + Auto-retry + Multi-engine support
 */

// Load .env from service directory, falling back to project root
import { readFileSync } from 'fs';
import { resolve } from 'path';
try {
  const envPaths = [
    resolve(import.meta.dir, '.env'),
    resolve(import.meta.dir, '../../.env'),
  ];
  for (const p of envPaths) {
    try {
      const content = readFileSync(p, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx < 1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        // Strip surrounding quotes
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!(key in process.env)) {
          process.env[key] = val;
        }
      }
      console.log(`[Env] Loaded ${p}`); // Logger not yet imported at this point
    } catch {}
  }
} catch {}

// Global error handlers for process resilience
process.on('unhandledRejection', (reason) => {
  // Logger may not be initialized yet; use console.error for fatal errors
  console.error('[Fatal] Unhandled promise rejection:', reason);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('[Fatal] Uncaught exception:', err);
  process.exit(1);
});

import { initEngines, closeAllEngines, getEngineNames, getEngine, selectEngine } from "./src/engines";
import { buildFetchHeaders } from "./src/utils";
import { getProfileForDomain } from "./src/stealth";
import { handleScrapeList } from "./src/scrapers";
import { handleScrapeBook } from "./src/scrapers";
import { handleScrapeChapters } from "./src/scrapers";
import { handleScrapeContent } from "./src/scrapers";
import { handleClean } from "./src/cleaning";
import { handleDownloadCover } from "./src/scrapers";
import { handleGenerateRule, handlePreviewPage } from "./src/ai-rule-generator";
import { executeTask, recoverStaleTasks, detectStuckTasks, progressThrottleCleanupTimer, retryFailedChapters, resortChapters } from "./src/task-engine";
import { getQueueStats, cleanupQueue, requeueFailed, clearTaskQueue } from "./src/queue";
import { proxyManager } from "./src/proxy-manager";
import { getCaptchaStrategies } from "./src/captcha-strategy";
import { adaptiveDelay } from "./src/adaptive-delay";
import { cookieJar } from "./src/cookie-jar";
import { cookieStore } from "./src/cookie-store";
import { rateLimiter } from "./src/rate-limiter";
import type { ProxyBatchTestResult } from "./src/proxy-manager";
import { isSafeUrl } from "./src/ssrf";
import { priorityQueue } from "./src/priority-queue";
import { qualityScorer } from "./src/quality-scorer";
import { antiCrawlAdvisor } from "./src/anti-crawl-advisor";
import { PRIORITY_MAP, REVERSE_PRIORITY_MAP } from "./src/types";
import type { TaskPriority, ScrapeResult, EngineType, AntiCrawl } from "./src/types";
import { sessionManager } from "./src/session-manager";
import { requestFingerprintMgr } from "./src/request-fingerprint";
import { timingSafeEqual } from "node:crypto";
import { logger } from "./src/logger";
const log = logger.child('Server');
import { rateOptimizer } from "./src/rate-optimizer";
import { smartRetry } from "./src/smart-retry";
import { requestQueue } from "./src/request-queue";
import { progressTracker } from "./src/progress-tracker";
import { domainHealth } from "./src/domain-health";
import { concurrencyOptimizer } from "./src/concurrency-optimizer";
import { antiDetectionCoordinator } from "./src/anti-detection-coordinator";
import { batchCalibrate, calibrateSingleRule, getCalibrationStatus, getCalibrationReport, loadSavedReport } from "./src/rate-calibration";
import { getCaptchaPreDetection, getCaptchaPreDetectionStats, resetCaptchaPreDetection } from "./src/captcha-detector";
import { crawlScheduler } from "./src/crawl-scheduler";
import { pipelineMetrics } from "./src/pipeline-metrics";
import { adaptiveEngineSelector } from "./src/adaptive-engine";
import { contentDeduplicator } from "./src/content-dedup";
import { scrapingSessionMgr, getOrCreateSession, rotateSession, getSessionStats } from "./src/scraping-session";
import { detectPageType, isCaptchaPage, isBlockedPage } from "./src/page-type-detector";
import { evasionStrategies } from "./src/evasion-strategies";
import { resultCache } from "./src/result-cache";
import { crossDomainCoordinator } from "./src/cross-domain-coordinator";
import type {
  ScrapeListRequest, ScrapeBookRequest, ScrapeChaptersRequest,
  ScrapeContentRequest, CleanRequest, DownloadCoverRequest, ExecuteTaskRequest,
} from "./src/types";

// ==================== Start ====================

const SERVICE_TOKEN = process.env.SCRAPER_SERVICE_TOKEN || "";
const MAX_BODY_SIZE = 5 * 1024 * 1024; // 5MB max request body
const SCRAPER_RATE_LIMIT = 60; // requests per minute
const MAX_SCRAPER_RATE_ENTRIES = 10000;
const MAX_CONCURRENT_TASKS = 3; // global concurrent task limit
const MAX_JSON_DEPTH = 20;
const MAX_JSON_KEYS = 200;
const ALLOWED_ORIGINS = [process.env.ALLOWED_ORIGIN || "http://localhost:3000"];
let activeTaskCount = 0;
const scraperRateStore = new Map<string, { count: number; resetAt: number }>();

// Track active tasks for graceful shutdown
const activeTasks = new Set<string>();

let lastScraperRateCleanup = 0;
function lazyScraperRateCleanup(): void {
  const now = Date.now();
  if (now - lastScraperRateCleanup < 10_000) return;
  if (scraperRateStore.size < MAX_SCRAPER_RATE_ENTRIES * 0.8) return;
  lastScraperRateCleanup = now;
  for (const [ip, entry] of scraperRateStore) {
    if (now > entry.resetAt) scraperRateStore.delete(ip);
  }
}

function authenticateRequest(req: Request): boolean {
  // Health check doesn't need auth
  const url = new URL(req.url);
  if (url.pathname === "/health") return true;

  // Check Authorization header using timing-safe comparison
  const auth = req.headers.get("authorization");
  if (SERVICE_TOKEN && auth) {
    const expected = `Bearer ${SERVICE_TOKEN}`;
    const aBuf = Buffer.from(auth, "utf-8");
    const bBuf = Buffer.from(expected, "utf-8");
    try {
      if (aBuf.length === bBuf.length) {
        if (timingSafeEqual(aBuf, bBuf)) return true;
      } else {
        // Dummy comparison to maintain constant time on length mismatch
        timingSafeEqual(aBuf, aBuf);
      }
    } catch {}
  }

  // Reject if no token configured (force security)
  if (!SERVICE_TOKEN) {
    log.warn("SCRAPER_SERVICE_TOKEN not set - all non-health requests rejected");
    return false;
  }

  return false;
}

function checkScraperRateLimit(ip: string): boolean {
  const now = Date.now();
  lazyScraperRateCleanup();

  let entry = scraperRateStore.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 60000 };
    scraperRateStore.set(ip, entry);
  }
  entry.count++;
  return entry.count <= SCRAPER_RATE_LIMIT;
}

function validateDepth(value: unknown, depth: number): void {
  if (depth > MAX_JSON_DEPTH) throw new Error("JSON nested too deep");
  if (value !== null && typeof value === "object") {
    if (Array.isArray(value)) value.forEach((item) => validateDepth(item, depth + 1));
    else {
      const keys = Object.keys(value as Record<string, unknown>);
      if (keys.length > MAX_JSON_KEYS) throw new Error("JSON too many keys");
      for (const k of keys) validateDepth((value as Record<string, unknown>)[k], depth + 1);
    }
  }
}

// ==================== Anti-Crawl Simulation Types & Logic ====================

interface SimCheck {
  name: string;
  passed: boolean;
  detail: string;
}

interface SimulateRequest {
  targetUrl?: string;
  url?: string;         // alias
  engine?: string;
  antiCrawlConfig?: Record<string, unknown>;
}

interface SimulateResult {
  targetUrl: string;
  domain: string;
  selectedEngine: string;
  checks: SimCheck[];
  score: number;
  grade: string;
  headers: Record<string, string>;
  recommendations: string[];
}

function generateRecommendations(checks: SimCheck[], domain: string, engine: string): string[] {
  const recs: string[] = [];
  for (const c of checks) {
    if (c.passed) continue;
    if (c.name === 'UA轮换') recs.push(`启用 UA 轮换避免固定指纹被识别，建议在采集规则中开启 uaRotation 选项`);
    if (c.name === '代理配置') recs.push(`为 ${domain} 绑定代理 IP，避免本机 IP 被目标站封禁`);
    if (c.name === '人类行为模拟') recs.push(`启用人类行为模拟（鼠标移动/滚动），降低 JS 渲染站点（如 ${engine === 'playwright' ? 'playwright' : 'obscura'}）的检测风险`);
    if (c.name === 'CAPTCHA策略') recs.push(`配置更积极的 CAPTCHA 策略（如 cloudflare 或 geetest），而非仅使用退避重试`);
  }
  if (recs.length === 0) {
    recs.push('当前配置良好，无需额外调整');
  }
  return recs;
}

async function simulateAntiCrawl(body: SimulateRequest): Promise<SimulateResult> {
  const effectiveUrl = body.targetUrl || body.url || '';
  const { engine, antiCrawlConfig } = body;
  let domain: string;
  try {
    domain = new URL(effectiveUrl).hostname;
  } catch {
    return {
      targetUrl: effectiveUrl,
      domain: 'invalid',
      selectedEngine: 'cheerio',
      checks: [{ name: 'URL格式', passed: false, detail: '提供的URL格式无效' }],
      score: 0,
      grade: 'D',
      headers: {},
      recommendations: ['请提供有效的URL地址'],
    };
  }

  // 1. Evaluate engine selection
  const ac = antiCrawlConfig || {};
  const selectedEngine = selectEngine(
    (engine as import('./src/types').EngineType | undefined) || undefined,
    {
      useJsRender: !!ac.useJsRender,
      cloudBrowser: !!ac.cloudBrowser,
      humanBehavior: !!ac.humanBehavior,
      uaRotation: !!ac.uaRotation,
      cookies: Array.isArray(ac.cookies) ? ac.cookies as Array<{name:string;value:string}> : undefined,
      proxy: typeof ac.proxy === 'string' ? ac.proxy : undefined,
    }
  );

  // 2. Build request headers
  const headers = buildFetchHeaders(
    ac as Partial<import('./src/types').AntiCrawl>,
    undefined,
    effectiveUrl,
    'novel'
  );

  // 3. Check fingerprint profile
  const profile = getProfileForDomain(domain);

  // 4. Check proxy availability
  const domainProxy = proxyManager.getDomainProxy(domain);
  const poolProxy = proxyManager.getProxy(domain);
  const hasProxy = !!(domainProxy || poolProxy);

  // 5. Check session
  const session = sessionManager.getSessionForRequest(domain);

  // 6. Check rate limiter state
  const rateState = rateLimiter.getDomainState(domain);

  // 7. Check adaptive delay
  const delayState = adaptiveDelay.getDomainStats(domain);

  // 8. Check CAPTCHA strategy
  const strategies = getCaptchaStrategies();
  void strategies; // used for available strategy inventory
  void delayState; // used for adaptive backoff state check

  // 9. Score the configuration
  let score = 0;
  const checks: SimCheck[] = [];

  // Check: UA rotation
  const hasUaRotation = !!(antiCrawlConfig?.uaRotation || antiCrawlConfig?.cookies);
  checks.push({ name: 'UA轮换', passed: hasUaRotation, detail: hasUaRotation ? '已启用User-Agent轮换' : '建议启用UA轮换避免指纹固定' });
  if (hasUaRotation) score += 15;

  // Check: Proxy
  checks.push({ name: '代理配置', passed: hasProxy, detail: hasProxy ? `已绑定代理 ${domainProxy?.url || poolProxy?.url}` : '未配置代理，建议对高防护站点启用' });
  if (hasProxy) score += 20;

  // Check: Human behavior
  const hasHumanBehavior = !!antiCrawlConfig?.humanBehavior;
  checks.push({ name: '人类行为模拟', passed: hasHumanBehavior, detail: hasHumanBehavior ? '已启用鼠标移动/滚动模拟' : '建议对JS渲染站点启用' });
  if (hasHumanBehavior) score += 15;

  // Check: CAPTCHA strategy
  const captchaStrategy = (antiCrawlConfig?.captchaStrategy as string) || 'auto';
  checks.push({ name: 'CAPTCHA策略', passed: captchaStrategy !== 'delay-backoff', detail: `当前策略: ${captchaStrategy}` });
  if (['cloudflare', 'geetest', 'auto'].includes(captchaStrategy)) score += 15;

  // Check: Engine match
  checks.push({ name: '引擎选择', passed: true, detail: `推荐引擎: ${selectedEngine}，当前: ${engine || 'cheerio'}` });
  score += 10;

  // Check: Cookies
  checks.push({ name: 'Cookie/Session', passed: !!session, detail: session ? `活跃会话: ${session.sessionId.slice(0, 16)}...` : '暂无会话，首次请求时自动创建' });
  if (session) score += 10;

  // Check: Rate limiter
  checks.push({ name: '速率限制', passed: rateState.status === 'normal', detail: `状态: ${rateState.status}，最大RPM: ${rateState.maxRPM}` });
  if (rateState.status === 'normal') score += 10;

  // Check: Stealth modules
  checks.push({ name: '隐身模块', passed: true, detail: `域名指纹: ${profile ? '已配置' : '未配置(首次使用时生成)'}` });
  score += 5;

  return {
    targetUrl: effectiveUrl,
    domain,
    selectedEngine,
    checks,
    score: Math.min(score, 100),
    grade: score >= 80 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : 'D',
    headers: Object.fromEntries(Object.entries(headers).slice(0, 8)),
    recommendations: generateRecommendations(checks, domain, selectedEngine),
  };
}

// ==================== Task Launch + Priority Queue Drain ====================
//
// Bug fix (Task 6): priorityQueue.dequeueNext() was never called — tasks that
// exceeded MAX_CONCURRENT_TASKS were enqueued via /execute-task (429 "queued")
// but never picked up when slots freed, stranding them in the in-memory
// priority queue until service restart. scheduleQueuedTasks() now drains the
// queue whenever a running task finishes.

function launchTask(taskId: string): void {
  // Move queue→processing if the task was 429-queued (no-op otherwise)
  priorityQueue.startProcessing(taskId);
  activeTasks.add(taskId);
  activeTaskCount++;
  executeTask(taskId).catch((err) => {
    log.error(`Task ${taskId} fatal error`, { error: err instanceof Error ? err.message : String(err) });
    // Sanitize error message before sending to API
    const safeMessage = String(err instanceof Error ? err.message : err)
      .slice(0, 200)
      .replace(/https?:\/\/[^\n ]+/g, '[URL]')
      .replace(/at .+/g, '[stack]');
    fetch(`${process.env.MAIN_APP_URL || "http://localhost:3000"}/api/scrape-tasks/${taskId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.SCRAPER_SERVICE_TOKEN || ""}`,
      },
      body: JSON.stringify({
        status: "failed",
        errorMessage: safeMessage,
        completedAt: new Date().toISOString(),
      }),
    }).catch(() => {});
  }).finally(() => {
    activeTasks.delete(taskId);
    activeTaskCount--;
    priorityQueue.completeProcessing(taskId);
    // Slot freed — start the next queued task(s) if any
    scheduleQueuedTasks();
  });
}

function scheduleQueuedTasks(): void {
  // Guard against pathological loops; activeTaskCount is the authoritative
  // concurrency gate (priorityQueue.processing only tracks 429-queued tasks)
  let guard = 0;
  while (activeTaskCount < MAX_CONCURRENT_TASKS && guard++ < 100) {
    const next = priorityQueue.dequeueNext();
    if (!next) break;
    log.info(`Launching queued task ${next.taskId} (priority=${next.priority})`);
    launchTask(next.taskId);
  }
}

export function startServer(port: number = 3099) {
  // Warn if no service token configured
  if (!SERVICE_TOKEN) {
    log.warn("SCRAPER_SERVICE_TOKEN not configured! Service will reject all authenticated requests.");
    log.warn("Set SCRAPER_SERVICE_TOKEN environment variable to enable API access.");
  }

  // Initialize all engines
  initEngines();

  // Wire RateOptimizer into CrawlScheduler for adaptive mode
  crawlScheduler.setAdaptiveRateProvider((domain: string) => rateOptimizer.getOptimalRate(domain));
  // Enable adaptive mode by default in production
  if (process.env.ADAPTIVE_RATE_MODE !== 'false') {
    crawlScheduler.setAdaptiveMode(true);
    log.info('Adaptive rate mode: enabled (RateOptimizer → CrawlScheduler)');
  }

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      // CORS - restrict to frontend origin only
      const requestOrigin = req.headers.get("origin") || "";
      const corsHeaders: Record<string, string> = {};
      if (ALLOWED_ORIGINS.includes(requestOrigin)) {
        corsHeaders["Access-Control-Allow-Origin"] = requestOrigin;
        corsHeaders["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS";
        corsHeaders["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
        corsHeaders["Access-Control-Max-Age"] = "86400";
      }

      if (method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      // Health check
      if (path === "/health" && method === "GET") {
        return Response.json({
          status: "ok",
          timestamp: new Date().toISOString(),
        });
      }

      // Authentication check for all non-health, non-OPTIONS requests
      if (!authenticateRequest(req)) {
        return Response.json(
          { error: "Unauthorized. Provide valid Bearer token." },
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Queue management endpoints (auth required)
      if (path === "/queue/stats" && method === "GET") {
        const taskId = url.searchParams.get("taskId") || undefined;
        const stats = await getQueueStats(taskId);
        return Response.json(stats, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Proxy pool stats (auth required)
      if (path === "/proxy-stats" && method === "GET") {
        const stats = proxyManager.getPoolStats();
        return Response.json(stats, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Adaptive delay stats (auth required)
      if (path === "/delay-stats" && method === "GET") {
        const domainStats = adaptiveDelay.getAllDomainStats();
        return Response.json({ domains: domainStats, totalDomains: domainStats.length }, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Cookie jar stats (auth required)
      if (path === "/cookie-stats" && method === "GET") {
        const includeData = url.searchParams.get("includeData") === "true";
        const stats = cookieJar.getStats();
        const totalCookies = stats.reduce((sum, s) => sum + s.count, 0);
        const result: Record<string, unknown> = {
          domains: stats,
          totalDomains: stats.length,
          totalCookies,
          serviceReachable: true,
        };
        if (includeData) {
          result.exportData = cookieJar.export();
        }
        return Response.json(result, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Cookie jar clear (auth required)
      if (path === "/cookie-clear" && method === "POST") {
        const domain = url.searchParams.get("domain");
        if (domain) {
          cookieJar.clear(domain);
        } else {
          cookieJar.clearAll();
        }
        return Response.json({ cleared: true, domain: domain || 'all' }, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ==================== New GET Endpoints (before rate limit) ====================

      // Pipeline metrics endpoint
      if (path === "/pipeline-metrics" && method === "GET") {
        const domain = url.searchParams.get("domain") || undefined;
        const allDomains = url.searchParams.get("all") === "true";
        const health = pipelineMetrics.getHealth();
        const result: Record<string, unknown> = {
          health,
          global: pipelineMetrics.getMetrics(),
        };
        if (domain) {
          result.domain = pipelineMetrics.getMetrics(domain);
        }
        if (allDomains) {
          result.domains = pipelineMetrics.getAllDomainMetrics();
        }
        // Include dedup and adaptive engine stats
        result.contentDedup = contentDeduplicator.getStats();
        result.adaptiveEngine = {
          profiles: adaptiveEngineSelector.getAllProfiles().size,
        };
        return Response.json(result, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Fingerprint / stealth health report
      if (path === "/fingerprint-health" && method === "GET") {
        const proxyStats = proxyManager.getPoolStats();
        const cookieStats = cookieJar.getStats();
        const totalCookies = cookieStats.reduce((sum, s) => sum + s.count, 0);
        return Response.json({
          stealthModules: [
            "navigator", "webgl", "canvas", "audioContext", "webrtc", "screen",
            "permissions", "iframe", "connection", "battery", "mediaDevices",
            "speechSynthesis", "clientRects", "fontDetection", "console",
            "performanceTiming", "mouseEvents", "touchSupport", "plugins",
          ],
          engineCapabilities: {
            cheerio: { jsRender: false, stealth: false, proxy: true, cookies: true, captchaDetect: true },
            playwright: { jsRender: true, stealth: false, proxy: false, cookies: true, captchaDetect: false },
            obscura: { jsRender: true, stealth: true, proxy: true, cookies: true, captchaDetect: true },
            firecrawl: { jsRender: true, stealth: true, proxy: false, cookies: false, captchaDetect: false },
            agentql: { jsRender: true, stealth: true, proxy: false, cookies: false, captchaDetect: false },
            'cloud-browser': { jsRender: true, stealth: true, proxy: false, cookies: false, captchaDetect: false },
            scrapling: { jsRender: true, stealth: true, proxy: false, cookies: false, captchaDetect: false },
          },
          proxyPool: { total: proxyStats.totalProxies, active: proxyStats.activeProxies },
          cookieJar: { domains: cookieStats.length, totalCookies },
        }, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Rate limit stats (auth required)
      if (path === "/rate-limit-stats" && method === "GET") {
        const states = rateLimiter.getAllDomainStates();
        return Response.json({ domains: states, totalDomains: states.length }, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Cookie persistence stats (auth required)
      if (path === "/cookie-persist/stats" && method === "GET") {
        const stats = cookieStore.getAllStats();
        const totalCookies = stats.reduce((sum, s) => sum + s.count, 0);
        return Response.json({
          persisted: true,
          totalCookies,
          domains: stats,
          totalDomains: stats.length,
        }, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Detailed proxy stats
      if (path === "/proxy/detailed-stats" && method === "GET") {
        const detailed = proxyManager.getDetailedStats();
        return Response.json(detailed, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Domain-proxy bindings
      if (path === "/proxy/domain-bindings" && method === "GET") {
        const bindings = proxyManager.getDomainProxyBindings();
        return Response.json(bindings, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ==================== Session Manager Endpoints ====================

      if (path === "/session-stats" && method === "GET") {
        const stats = sessionManager.getStats();
        return Response.json(stats, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (path === "/sessions" && method === "GET") {
        const sessions = sessionManager.getAllSessions();
        return Response.json({ sessions }, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ==================== Request Fingerprint Endpoints ====================

      if (path === "/fingerprint-recent" && method === "GET") {
        const domain = url.searchParams.get("domain") || undefined;
        const limit = parseInt(url.searchParams.get("limit") || "20", 10);
        if (domain) {
          const fps = requestFingerprintMgr.getDomainFingerprints(domain).slice(0, limit);
          return Response.json({ fingerprints: fps }, {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const fps = requestFingerprintMgr.getAllRecentFingerprints(limit);
        return Response.json({ fingerprints: fps }, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (path === "/fingerprint-stats" && method === "GET") {
        const stats = requestFingerprintMgr.getStats();
        return Response.json(stats, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ==================== Rate Optimizer Endpoints ====================

      if (path === "/rate-optimizer/stats" && method === "GET") {
        const stats = rateOptimizer.getStats();
        return Response.json(stats, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (path === "/rate-optimizer/reset" && method === "POST") {
        rateOptimizer.reset();
        return Response.json({ reset: true }, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ==================== Smart Retry Endpoints ====================

      if (path === "/retry-stats" && method === "GET") {
        const stats = smartRetry.getStats();
        return Response.json(stats, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (path.startsWith("/retry-stats/") && method === "GET") {
        const domain = decodeURIComponent(path.slice("/retry-stats/".length));
        const stats = smartRetry.getStats();
        const domainData = stats.domains[domain];
        if (!domainData) {
          return Response.json({ error: "Domain not found" }, { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        return Response.json({ domain, ...domainData, recentAttempts: smartRetry.getRecentAttempts(domain), successfulRecoveries: smartRetry.getSuccessfulRecoveries(domain) }, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (path.startsWith("/retry-stats/") && method === "POST") {
        const domain = decodeURIComponent(path.slice("/retry-stats/".length));
        const body = await req.json().catch(() => ({})) as Record<string, unknown>;
        if (body.action === 'resume') {
          smartRetry.resumeDomain(domain);
          return Response.json({ resumed: true, domain }, { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        } else if (body.action === 'pause') {
          smartRetry.pauseDomain(domain, body.reason as string | undefined);
          return Response.json({ paused: true, domain }, { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        return Response.json({ error: "Invalid action. Use 'resume' or 'pause'." }, { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // ==================== Request Queue Endpoints ====================

      if (path === "/request-queue/stats" && method === "GET") {
        const metrics = requestQueue.getMetrics();
        return Response.json(metrics, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ==================== Progress Tracker Endpoints ====================

      if (path === "/progress" && method === "GET") {
        const taskIds = progressTracker.getActiveTaskIds();
        const snapshots = taskIds.map(id => progressTracker.getSnapshot(id)).filter(Boolean);
        return Response.json({ tasks: snapshots }, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (path.startsWith("/progress/") && method === "GET") {
        const taskId = path.slice("/progress/".length);
        const snapshot = progressTracker.getSnapshot(taskId);
        if (!snapshot) {
          return Response.json({ error: "Task not found" }, { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        return Response.json(snapshot, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ==================== Domain Health Endpoints ====================

      if (path === "/domain-health" && method === "GET") {
        const summary = domainHealth.getSummary();
        return Response.json(summary, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (path.startsWith("/domain-health/") && method === "GET") {
        const domain = decodeURIComponent(path.slice("/domain-health/".length));
        const health = domainHealth.computeHealth(domain);
        return Response.json(health, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (path.startsWith("/domain-health/") && method === "POST") {
        const domain = decodeURIComponent(path.slice("/domain-health/".length));
        const body = await req.json().catch(() => ({})) as Record<string, unknown>;
        if (body.action === 'resume') {
          domainHealth.resumeDomain(domain);
          return Response.json({ resumed: true, domain }, { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        } else if (body.action === 'pause') {
          domainHealth.pauseDomain(domain, body.reason as string | undefined);
          return Response.json({ paused: true, domain }, { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        return Response.json({ error: "Invalid action. Use 'resume' or 'pause'." }, { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // ==================== Concurrency Optimizer Endpoints ====================

      if (path === "/concurrency-optimizer/stats" && method === "GET") {
        const stats = concurrencyOptimizer.getStats();
        return Response.json(stats, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ==================== Anti-Detection Coordinator Endpoints ====================

      if (path === "/anti-detection/stats" && method === "GET") {
        const stats = antiDetectionCoordinator.getStats();
        return Response.json(stats, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ==================== CAPTCHA Pre-Detection Endpoints ====================

      if (path === "/captcha-pre-detection/stats" && method === "GET") {
        const stats = getCaptchaPreDetectionStats();
        return Response.json(stats, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (path === "/captcha-pre-detection/check" && method === "GET") {
        const domain = url.searchParams.get("domain");
        if (!domain) {
          return Response.json({ error: 'domain query parameter is required' }, { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        const preDetection = getCaptchaPreDetection(decodeURIComponent(domain));
        return Response.json({ domain, ...preDetection }, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (path === "/captcha-pre-detection/reset" && method === "POST") {
        resetCaptchaPreDetection();
        return Response.json({ reset: true }, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ==================== Crawl Scheduler Adaptive Mode ====================

      if (path === "/crawl-scheduler/adaptive" && method === "GET") {
        const budgetStats = crawlScheduler.getBudgetStats();
        return Response.json({ budgets: budgetStats }, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (path === "/queue/requeue" && method === "POST") {
        const taskId = url.searchParams.get("taskId") || undefined;
        const count = await requeueFailed(taskId);
        return Response.json({ requeued: count }, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (path === "/queue/cleanup" && method === "POST") {
        const count = await cleanupQueue();
        return Response.json({ cleaned: count }, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (path === "/queue/clear" && method === "DELETE") {
        const taskId = url.searchParams.get("taskId");
        if (!taskId) {
          return Response.json({ error: "taskId is required" }, {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        await clearTaskQueue(taskId);
        return Response.json({ cleared: true }, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

        // ==================== Priority Queue Stats (GET, before POST-only gate) ====================

        if (path === "/priority-queue/stats" && method === "GET") {
          const stats = priorityQueue.getStats();
          return Response.json(stats, {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // ==================== Quality Stats (GET, before POST-only gate) ====================

        if (path === "/quality/recent" && method === "GET") {
          const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") || "10", 10) || 10));
          const reports = qualityScorer.getRecentReports(limit);
          return Response.json({ reports }, {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        if (path === "/quality/stats" && method === "GET") {
          const stats = qualityScorer.getAggregateStats();
          return Response.json(stats, {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // PUT /priority-queue/concurrency (before POST-only gate, needs body)
        if (path === "/priority-queue/concurrency" && method === "PUT") {
          let pqBody: unknown;
          try { pqBody = await req.json(); } catch {
            return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
          const { maxConcurrent } = pqBody as { maxConcurrent?: number };
          if (typeof maxConcurrent !== 'number' || maxConcurrent < 1 || maxConcurrent > 20) {
            return Response.json({ error: 'maxConcurrent must be 1-20' }, { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
          priorityQueue.setMaxConcurrent(maxConcurrent);
          return Response.json({ maxConcurrent }, {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

      // GET /anti-crawl/domain-signals (before POST-only gate, needs GET method)
      if (path === "/anti-crawl/domain-signals" && method === "GET") {
        const domain = url.searchParams.get("domain");
        if (!domain) {
          return Response.json({ error: 'domain query parameter is required' }, { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        const signals = antiCrawlAdvisor.getDomainSignals(decodeURIComponent(domain));
        return Response.json({ domain, signals }, { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // GET /rate-calibration/status — current calibration status
      if (path === "/rate-calibration/status" && method === "GET") {
        const status = getCalibrationStatus();
        return Response.json(status, { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // GET /rate-calibration/results — last calibration results
      if (path === "/rate-calibration/results" && method === "GET") {
        const report = getCalibrationReport() || loadSavedReport();
        if (!report) {
          return Response.json({ error: 'No calibration results available. Run calibration first.' }, { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        return Response.json(report, { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // POST /rate-calibration/start — start calibration for all rules
      if (path === "/rate-calibration/start" && method === "POST") {
        try {
          const body = await req.json().catch(() => ({})) as { apply?: boolean };
          const apply = body.apply !== false; // default true
          const report = await batchCalibrate(apply);
          return Response.json({ success: true, applied: apply, report }, { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return Response.json({ error: msg }, { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      }

      // POST /rate-calibration/start/:ruleName — calibrate single rule
      if (path.startsWith("/rate-calibration/start/") && method === "POST") {
        const ruleName = path.replace("/rate-calibration/start/", "");
        if (!ruleName) {
          return Response.json({ error: 'ruleName is required' }, { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        try {
          const body = await req.json().catch(() => ({})) as { apply?: boolean };
          const apply = body.apply !== false;
          const result = await calibrateSingleRule(ruleName, apply);
          if (!result) {
            return Response.json({ error: `Rule "${ruleName}" not found` }, { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
          return Response.json({ success: true, applied: apply, result }, { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return Response.json({ error: msg }, { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      }

      // ==================== Scraping Session Endpoints ====================

      // GET /scraping-sessions — list active sessions
      if (path === "/scraping-sessions" && method === "GET") {
        const domain = url.searchParams.get("domain") || undefined;
        const sessions = scrapingSessionMgr.getActiveSessions(domain);
        const stats = getSessionStats();
        return Response.json({ sessions, stats }, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // POST /scraping-sessions/:domain/rotate — rotate session for domain
      if (path.startsWith("/scraping-sessions/") && path.endsWith("/rotate") && method === "POST") {
        const domainPart = path.slice("/scraping-sessions/".length, -"/rotate".length);
        if (!domainPart) {
          return Response.json({ error: 'Domain is required' }, { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        const domain = decodeURIComponent(domainPart);
        let body: any;
        try { body = await req.json().catch(() => ({})); } catch { body = {}; }
        const newSession = rotateSession(domain, body.reason);
        return Response.json({ rotated: true, domain, newSessionId: newSession.id }, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /page-type-detect — detect page type from URL
      if (path === "/page-type-detect" && method === "GET") {
        const targetUrl = url.searchParams.get("url");
        if (!targetUrl) {
          return Response.json({ error: 'url query parameter is required' }, { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        // Fetch the URL first (using cheerio engine), then detect
        try {
          const engine = getEngine('cheerio');
          const fetchResult = await engine.fetch(targetUrl, { antiCrawl: {} });
          const result = detectPageType(fetchResult.html, targetUrl, fetchResult.statusCode);
          return Response.json(result, {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (err) {
          return Response.json({ error: `Failed to fetch URL: ${err instanceof Error ? err.message : String(err)}` }, { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      }

      // GET /evasion-strategies — list available strategies
      if (path === "/evasion-strategies" && method === "GET") {
        const strategies = evasionStrategies.listStrategies();
        const wafs = evasionStrategies.waf.getDetectedWAFs();
        const cfStats = evasionStrategies.cloudflare.getStats();
        const rlBuckets = evasionStrategies.rateLimit.getTokenBucketStats();
        return Response.json({ strategies, detectedWAFs: wafs, cloudflareAttempts: cfStats, rateLimitBuckets: rlBuckets }, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /result-cache/stats — cache statistics
      if (path === "/result-cache/stats" && method === "GET") {
        const stats = resultCache.getStats();
        return Response.json(stats, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // POST /result-cache/clear — clear cache
      if (path === "/result-cache/clear" && method === "POST") {
        const domain = url.searchParams.get("domain");
        let cleared: number;
        if (domain) {
          cleared = resultCache.clearByDomain(domain);
        } else {
          cleared = resultCache.clear();
        }
        return Response.json({ cleared, domain: domain || 'all' }, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /cross-domain/stats — cross-domain coordination statistics
      if (path === "/cross-domain/stats" && method === "GET") {
        const stats = crossDomainCoordinator.getStats();
        return Response.json(stats, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // POST /cross-domain/register — register a domain for coordination
      if (path === "/cross-domain/register" && method === "POST") {
        let regBody: any;
        try { regBody = await req.json().catch(() => ({})); } catch { regBody = {}; }
        const domain = regBody.domain;
        if (!domain || typeof domain !== 'string') {
          return Response.json({ error: 'domain is required' }, { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        crossDomainCoordinator.registerDomain(domain, {
          maxConcurrency: regBody.maxConcurrency,
          targetRPM: regBody.targetRPM,
          relatedDomains: regBody.relatedDomains,
        });
        return Response.json({ registered: true, domain }, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Rate limiting (per client IP)
      // Only use x-real-ip (set by Caddy, not spoofable)
      const clientIp = req.headers.get('x-real-ip') || 'unknown';
      if (!checkScraperRateLimit(clientIp)) {
        return Response.json(
          { error: "Rate limit exceeded. Try again later." },
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json", "Retry-After": "60" } }
        );
      }

      // POST-only for scraping endpoints
      if (method !== "POST") {
        return Response.json(
          { error: "Method not allowed. Use POST." },
          { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Parse JSON body with size limit
      let body: unknown;
      try {
        const contentLength = parseInt(req.headers.get("content-length") || "0", 10);
        if (contentLength > MAX_BODY_SIZE) {
          return Response.json(
            { error: `Request body too large. Max ${MAX_BODY_SIZE / 1024 / 1024}MB.` },
            { status: 413, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        const text = await req.text();
        if (text.length > MAX_BODY_SIZE) {
          return Response.json(
            { error: `Request body too large. Max ${MAX_BODY_SIZE / 1024 / 1024}MB.` },
            { status: 413, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return Response.json(
            { error: "Invalid JSON body" },
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        // Depth and key count validation (mirror Next.js safeJson)
        try { validateDepth(parsed, 0); } catch {
          return Response.json(
            { error: "JSON validation failed" },
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        body = parsed;
      } catch {
        return Response.json(
          { error: "Invalid JSON body" },
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const jsonHeaders = { "Content-Type": "application/json", ...corsHeaders };

      try {
        // Route to handlers
        if (path === "/scrape/list") {
          if (!body || typeof body !== 'object' || typeof (body as Record<string, unknown>).url !== 'string') {
            return Response.json({ error: 'url is required and must be a string' }, { status: 400, headers: jsonHeaders });
          }
          if (!(body as Record<string, unknown>).selector || typeof (body as Record<string, unknown>).selector !== 'object') {
            return Response.json({ error: 'selector is required and must be an object (e.g. {"type":"css","value":"a"})' }, { status: 400, headers: jsonHeaders });
          }
          const result = await handleScrapeList(body as ScrapeListRequest);
          return Response.json(result, { headers: jsonHeaders });
        }

        if (path === "/scrape/book") {
          if (!body || typeof body !== 'object' || typeof (body as Record<string, unknown>).url !== 'string') {
            return Response.json({ error: 'url is required and must be a string' }, { status: 400, headers: jsonHeaders });
          }
          const result = await handleScrapeBook(body as ScrapeBookRequest);
          return Response.json(result, { headers: jsonHeaders });
        }

        if (path === "/scrape/chapters") {
          const result = await handleScrapeChapters(body as ScrapeChaptersRequest);
          return Response.json(result, { headers: jsonHeaders });
        }

        if (path === "/scrape/content") {
          const result = await handleScrapeContent(body as ScrapeContentRequest);
          return Response.json(result, { headers: jsonHeaders });
        }

        if (path === "/clean") {
          const result = handleClean(body as CleanRequest);
          return Response.json(result, { headers: jsonHeaders });
        }

        if (path === "/download-cover") {
          const { url: coverUrl, savePath } = body as DownloadCoverRequest;
          if (!coverUrl || !savePath) {
            return Response.json({ error: "url and savePath are required" }, { status: 400, headers: jsonHeaders });
          }
          const result = await handleDownloadCover(coverUrl, savePath);
          return Response.json(result, { headers: jsonHeaders });
        }

        // ==================== Priority Queue Endpoints (POST, after body parsing) ====================

        // POST /priority-queue/reorder — Reprioritize a task
        if (path === "/priority-queue/reorder") {
          const { taskId: qTaskId, priority: newPriority } = body as { taskId?: string; priority?: number };
          if (!qTaskId || typeof qTaskId !== 'string') {
            return Response.json({ error: 'taskId is required' }, { status: 400, headers: jsonHeaders });
          }
          if (typeof newPriority !== 'number' || newPriority < 0 || newPriority > 3) {
            return Response.json({ error: 'priority must be 0-3' }, { status: 400, headers: jsonHeaders });
          }
          const ok = priorityQueue.reprioritize(qTaskId, newPriority);
          return Response.json({ reordered: ok }, { headers: jsonHeaders });
        }

        // POST /priority-queue/cancel — Remove task from queue
        if (path === "/priority-queue/cancel") {
          const { taskId: qTaskId } = body as { taskId?: string };
          if (!qTaskId || typeof qTaskId !== 'string') {
            return Response.json({ error: 'taskId is required' }, { status: 400, headers: jsonHeaders });
          }
          const cancelled = priorityQueue.dequeue(qTaskId);
          return Response.json({ cancelled }, { headers: jsonHeaders });
        }

        // ==================== Quality Manual Score (POST, after body parsing) ====================

        // POST /quality/score — Manually trigger quality scoring for a task
        if (path === "/quality/score") {
          const { taskId: qTaskId, result: scrapeResult } = body as { taskId?: string; result?: ScrapeResult };
          if (!qTaskId || typeof qTaskId !== 'string') {
            return Response.json({ error: 'taskId is required' }, { status: 400, headers: jsonHeaders });
          }
          if (!scrapeResult || typeof scrapeResult !== 'object') {
            return Response.json({ error: 'result is required' }, { status: 400, headers: jsonHeaders });
          }
          const report = qualityScorer.score(qTaskId, scrapeResult);
          return Response.json(report, { headers: jsonHeaders });
        }

        // ==================== Task Execution (with Priority Queue) ====================

        if (path === "/execute-task") {
          if (!body || typeof body !== 'object' || typeof (body as Record<string, unknown>).taskId !== 'string') {
            return Response.json({ error: 'taskId is required and must be a string' }, { status: 400, headers: jsonHeaders });
          }
          const { taskId } = body as ExecuteTaskRequest;

          // Parse priority from request body (default: medium=2)
          const rawPriority = (body as Record<string, unknown>).priority;
          let numericPriority = 2; // default medium
          if (typeof rawPriority === 'number') {
            numericPriority = Math.max(0, Math.min(3, Math.floor(rawPriority)));
          } else if (typeof rawPriority === 'string' && rawPriority in PRIORITY_MAP) {
            numericPriority = PRIORITY_MAP[rawPriority as TaskPriority];
          }

          // Prevent duplicate task execution (same taskId)
          if (activeTasks.has(taskId)) {
            return Response.json(
              { error: "该任务已在执行中，请勿重复提交" },
              { status: 409, headers: jsonHeaders }
            );
          }

          // Hard cap on concurrent tasks
          if (activeTaskCount >= MAX_CONCURRENT_TASKS) {
            const ruleId = (body as Record<string, unknown>).ruleId as string | undefined;
            const enqueued = priorityQueue.enqueue(taskId, numericPriority, ruleId);
            if (enqueued) {
              const stats = priorityQueue.getStats();
              return Response.json(
                {
                  error: "并发任务数已达上限，已加入优先级队列",
                  queued: true,
                  queuePosition: stats.queueSize,
                  priority: numericPriority,
                  priorityLabel: REVERSE_PRIORITY_MAP[numericPriority],
                },
                { status: 429, headers: jsonHeaders }
              );
            }
            return Response.json(
              { error: "并发任务数已达上限且队列已满，请稍后重试" },
              { status: 503, headers: jsonHeaders }
            );
          }

          // Check priority queue capacity
          if (!priorityQueue.hasCapacity()) {
            // Try to enqueue the task
            const ruleId = (body as Record<string, unknown>).ruleId as string | undefined;
            const enqueued = priorityQueue.enqueue(taskId, numericPriority, ruleId);
            if (enqueued) {
              const stats = priorityQueue.getStats();
              return Response.json(
                {
                  error: "服务器繁忙，任务已加入优先级队列",
                  queued: true,
                  queuePosition: stats.queueSize,
                  priority: numericPriority,
                  priorityLabel: REVERSE_PRIORITY_MAP[numericPriority],
                },
                { status: 429, headers: jsonHeaders }
              );
            }
            // Already in queue
            const position = priorityQueue.getQueuePosition(taskId);
            return Response.json(
              {
                error: "该任务已在队列中",
                queued: true,
                queuePosition: position >= 0 ? position : priorityQueue.getStats().queueSize,
              },
              { status: 409, headers: jsonHeaders }
            );
          }

          // Launch the task (priority-queue aware; drained via scheduleQueuedTasks)
          launchTask(taskId);
          return Response.json(
            { message: "Task execution started", taskId },
            { headers: jsonHeaders }
          );
        }

        if (path === "/ai/generate-rule") {
          const { url, siteType } = body as { url: string; siteType?: string };
          if (!url) {
            return Response.json({ error: "url is required" }, { status: 400, headers: jsonHeaders });
          }
          if (!isSafeUrl(url)) {
            return Response.json({ error: "URL is not allowed (SSRF protection)" }, { status: 400, headers: jsonHeaders });
          }
          const result = await handleGenerateRule(url, siteType);
          return Response.json(result, { headers: jsonHeaders });
        }

        if (path === "/ai/preview-page") {
          const { url } = body as { url: string };
          if (!url) {
            return Response.json({ error: "url is required" }, { status: 400, headers: jsonHeaders });
          }
          if (!isSafeUrl(url)) {
            return Response.json({ error: "URL is not allowed (SSRF protection)" }, { status: 400, headers: jsonHeaders });
          }
          const result = await handlePreviewPage(url);
          return Response.json(result, { headers: jsonHeaders });
        }

        // ==================== Test Rule (End-to-End Single Fetch) ====================

        if (path === "/test-rule") {
          const { url, engine: reqEngine, antiCrawlConfig, listSelector } = body as {
            url?: string;
            engine?: string;
            antiCrawlConfig?: Record<string, unknown>;
            listSelector?: { type: string; value: string };
          };

          if (!url || typeof url !== 'string') {
            return Response.json({ error: 'url is required' }, { status: 400, headers: jsonHeaders });
          }

          // Parse domain from URL
          let domain: string;
          let parsedUrl: URL;
          try {
            parsedUrl = new URL(url);
            domain = parsedUrl.hostname;
          } catch {
            return Response.json({ error: 'Invalid URL' }, { status: 400, headers: jsonHeaders });
          }
          if (!isSafeUrl(url)) {
            return Response.json({ error: 'URL is not allowed (SSRF protection)' }, { status: 400, headers: jsonHeaders });
          }

          // Select engine based on config
          const ac = antiCrawlConfig || {};
          const engineType = selectEngine(
            reqEngine as EngineType | undefined,
            {
              useJsRender: !!ac.useJsRender,
              cloudBrowser: !!ac.cloudBrowser,
              humanBehavior: !!ac.humanBehavior,
              uaRotation: !!ac.uaRotation,
              cookies: Array.isArray(ac.cookies) ? ac.cookies as Array<{ name: string; value: string }> : undefined,
              proxy: typeof ac.proxy === 'string' ? ac.proxy : undefined,
            }
          );

          // Build headers for reporting
          const fetchHeaders = buildFetchHeaders(ac as Partial<AntiCrawl>, undefined, url, 'novel');

          const engine = getEngine(engineType);
          const startTime = Date.now();

          let html = '';
          let statusCode = 0;
          let finalUrl = url;
          let success = false;
          let fetchError: string | undefined;

          try {
            const result = await engine.fetch(url, { antiCrawl: ac as Partial<AntiCrawl> });
            html = result.html || '';
            statusCode = result.statusCode;
            finalUrl = result.finalUrl || url;
            success = statusCode >= 200 && statusCode < 400 && html.length > 0;
          } catch (err: unknown) {
            const errMsg = String((err instanceof Error ? err.message : err) || 'Unknown error');
            fetchError = errMsg.slice(0, 300);
            const statusMatch = errMsg.match(/HTTP (\d+)/);
            if (statusMatch) statusCode = parseInt(statusMatch[1], 10);
            success = false;
          }

          const responseTime = Date.now() - startTime;

          // Record response in adaptive delay (engine may not do this)
          adaptiveDelay.recordResponse(domain, responseTime, success, statusCode);

          // Get post-fetch states for reporting
          const rateLimitState = rateLimiter.getDomainState(domain);
          const delayState = adaptiveDelay.getDomainStats(domain);

          // Get anti-crawl advisor signals
          const advisorReport = antiCrawlAdvisor.analyze(domain, ac);

          // Simple list extraction using regex (cheerio not imported per requirements)
          let extractedCount: number | undefined;
          let items: string[] | undefined;

          if (listSelector && success && html) {
            try {
              const selectorValue = String(listSelector.value || '');
              // Extract tag name from simple CSS selectors like 'div.class', '#id', 'a[href]'
              const tagMatch = selectorValue.match(/^([a-zA-Z][a-zA-Z0-9]*)/);
              if (tagMatch) {
                const tag = tagMatch[1].toLowerCase();
                // Count opening tags
                const openTagRegex = new RegExp(`<${tag}[\\s>/]`, 'gi');
                const tagMatches = html.match(openTagRegex);
                extractedCount = tagMatches ? tagMatches.length : 0;

                // For anchor tags, extract hrefs
                if (tag === 'a') {
                  const hrefRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
                  let hrefMatch: RegExpExecArray | null;
                  items = [];
                  while ((hrefMatch = hrefRegex.exec(html)) !== null) {
                    if (hrefMatch[1] && !hrefMatch[1].startsWith('javascript:')) {
                      items.push(hrefMatch[1]);
                    }
                  }
                  extractedCount = items.length;
                }

                // Cap items for response size
                if (items && items.length > 50) {
                  items = items.slice(0, 50);
                }
              }
            } catch {
              // Extraction failed, skip it
            }
          }

          return Response.json({
            success,
            url,
            finalUrl,
            statusCode,
            engine: engineType,
            responseTime,
            htmlLength: html.length,
            extractedCount,
            items: items && items.length > 0 ? items : undefined,
            headers: fetchHeaders,
            rateLimitState,
            delayState,
            signals: advisorReport.signals,
            ...(fetchError ? { error: fetchError } : {}),
          }, { headers: jsonHeaders });
        }

        // ==================== Proxy Management Endpoints ====================

        // POST /proxy/add — Add a single proxy to the pool
        if (path === "/proxy/add") {
          const { url: proxyUrl } = body as { url?: string };
          if (!proxyUrl || typeof proxyUrl !== 'string') {
            return Response.json({ error: "url is required" }, { status: 400, headers: jsonHeaders });
          }
          const added = proxyManager.addProxy(proxyUrl);
          const poolStats = proxyManager.getPoolStats();
          return Response.json({ added, url: proxyUrl, poolSize: poolStats.totalProxies }, { headers: jsonHeaders });
        }

        // POST /proxy/remove — Remove a proxy from the pool
        if (path === "/proxy/remove") {
          const { url: proxyUrl } = body as { url?: string };
          if (!proxyUrl || typeof proxyUrl !== 'string') {
            return Response.json({ error: "url is required" }, { status: 400, headers: jsonHeaders });
          }
          const removed = proxyManager.removeProxy(proxyUrl);
          const poolStats = proxyManager.getPoolStats();
          return Response.json({ removed, poolSize: poolStats.totalProxies }, { headers: jsonHeaders });
        }

        // POST /proxy/reset — Reset a proxy's health/consecutive-fails
        if (path === "/proxy/reset") {
          const { url: proxyUrl } = body as { url?: string };
          if (!proxyUrl || typeof proxyUrl !== 'string') {
            return Response.json({ error: "url is required" }, { status: 400, headers: jsonHeaders });
          }
          const reset = proxyManager.resetProxy(proxyUrl);
          return Response.json({ reset }, { headers: jsonHeaders });
        }

        // POST /proxy/check — Health check a specific proxy
        if (path === "/proxy/check") {
          const { url: proxyUrl } = body as { url?: string };
          if (!proxyUrl || typeof proxyUrl !== 'string') {
            return Response.json({ error: "url is required" }, { status: 400, headers: jsonHeaders });
          }
          const result = await proxyManager.checkHealth(proxyUrl);
          return Response.json(result, { headers: jsonHeaders });
        }

        // POST /proxy/import — Import proxies (array of URLs or JSON blob)
        if (path === "/proxy/import") {
          const payload = body as { proxies?: string[]; json?: string };
          let imported: number;
          if (Array.isArray(payload.proxies)) {
            imported = proxyManager.addProxies(payload.proxies);
          } else if (typeof payload.json === 'string') {
            imported = proxyManager.importProxies(payload.json);
          } else {
            return Response.json(
              { error: "Provide 'proxies' (string[]) or 'json' (string)" },
              { status: 400, headers: jsonHeaders }
            );
          }
          return Response.json({ imported }, { headers: jsonHeaders });
        }

        // POST /proxy/export — Export proxies in specified format
        if (path === "/proxy/export") {
          const { format } = (body as { format?: 'url' | 'json' }) || {};
          const fmt = format === 'url' ? 'url' : 'json';
          const data = proxyManager.exportAsText(fmt);
          const poolStats = proxyManager.getPoolStats();
          return Response.json({ data, count: poolStats.totalProxies }, { headers: jsonHeaders });
        }

        // POST /proxy/bind-domain — Bind a proxy to a domain (or unbind with null)
        if (path === "/proxy/bind-domain") {
          const { domain, proxyUrl } = body as { domain?: string; proxyUrl?: string | null };
          if (!domain || typeof domain !== 'string') {
            return Response.json({ error: "domain is required" }, { status: 400, headers: jsonHeaders });
          }
          proxyManager.setDomainProxy(domain, proxyUrl ?? null);
          return Response.json({ bound: true }, { headers: jsonHeaders });
        }

        // POST /proxy/test — Test a single proxy connection
        if (path === "/proxy/test") {
          const { url: proxyUrl, testUrl } = body as { url?: string; testUrl?: string };
          if (!proxyUrl || typeof proxyUrl !== 'string') {
            return Response.json({ error: "url is required" }, { status: 400, headers: jsonHeaders });
          }
          const validatedTestUrl = testUrl && typeof testUrl === 'string'
            ? (isSafeUrl(testUrl) ? testUrl : undefined)
            : undefined;
          proxyManager.addProxy(proxyUrl);
          const result = await proxyManager.verifyProxy(proxyUrl, { testUrl: validatedTestUrl });
          const parsed = proxyManager.getProxy(proxyUrl);
          const adapted: Record<string, unknown> = {
            url: proxyUrl,
            protocol: parsed?.protocol || 'http',
            host: parsed?.host || '',
            port: parsed?.port || 0,
            reachable: result.working,
            responseTime: result.responseTime,
            statusCode: result.statusCode,
            error: result.error,
            testTimestamp: Date.now(),
          };
          return Response.json(adapted, { headers: jsonHeaders });
        }

        // POST /proxy/test-all — Test all active proxies in parallel
        if (path === "/proxy/test-all") {
          const activeUrls = proxyManager.getActiveProxyUrls();
          if (activeUrls.length === 0) {
            return Response.json({ results: [], message: "No active proxies to test" }, { headers: jsonHeaders });
          }
          const results: ProxyBatchTestResult[] = await proxyManager.testProxyBatch(activeUrls);
          return Response.json({ results }, { headers: jsonHeaders });
        }

        // ==================== Anti-Crawl Simulation ====================

        if (path === "/anti-crawl/simulate" && method === "POST") {
          const result = await simulateAntiCrawl(body as SimulateRequest);
          return Response.json(result, { headers: jsonHeaders });
        }

        // POST /anti-crawl/advise — Anti-crawl strategy advisor
        if (path === "/anti-crawl/advise") {
          const { domain, currentConfig } = body as { domain?: string; currentConfig?: Record<string, unknown> };
          if (!domain || typeof domain !== 'string') {
            return Response.json({ error: 'domain is required' }, { status: 400, headers: jsonHeaders });
          }
          const report = antiCrawlAdvisor.analyze(domain, currentConfig);
          return Response.json(report, { headers: jsonHeaders });
        }

        // ==================== Session Management Endpoints ====================

        // POST /session/block — Block a session
        if (path === "/session/block") {
          const { sessionId, reason } = body as { sessionId?: string; reason?: string };
          if (!sessionId || typeof sessionId !== 'string') {
            return Response.json({ error: "sessionId is required" }, { status: 400, headers: jsonHeaders });
          }
          sessionManager.blockSession(sessionId, reason);
          return Response.json({ blocked: true, sessionId }, { headers: jsonHeaders });
        }

        // POST /session/cleanup — Force session cleanup
        if (path === "/session/cleanup") {
          const cleaned = sessionManager.cleanup();
          return Response.json({ cleaned }, { headers: jsonHeaders });
        }

        // ==================== Rate Limit Management Endpoints ====================

        // POST /rate-limit/set — Set per-domain rate limit
        if (path === "/rate-limit/set") {
          const { domain, maxRPM } = body as { domain?: string; maxRPM?: number };
          if (!domain || typeof domain !== 'string') {
            return Response.json({ error: "domain is required" }, { status: 400, headers: jsonHeaders });
          }
          if (typeof maxRPM !== 'number' || maxRPM < 1) {
            return Response.json({ error: "maxRPM must be a positive number" }, { status: 400, headers: jsonHeaders });
          }
          rateLimiter.setDomainLimit(domain, maxRPM);
          const state = rateLimiter.getDomainState(domain);
          return Response.json({ set: true, domain, state }, { headers: jsonHeaders });
        }

        // POST /rate-limit/reset — Reset domain rate limit state
        if (path === "/rate-limit/reset") {
          const { domain } = body as { domain?: string };
          if (!domain || typeof domain !== 'string') {
            return Response.json({ error: "domain is required" }, { status: 400, headers: jsonHeaders });
          }
          rateLimiter.resetDomain(domain);
          return Response.json({ reset: true, domain }, { headers: jsonHeaders });
        }

        return Response.json(
          { error: `Unknown endpoint: ${path}` },
          { status: 404, headers: jsonHeaders }
        );
      } catch (err) {
        log.error(`Error handling ${path}`, { error: err instanceof Error ? err.message : String(err) });
        // Never leak internal error details to clients
        return Response.json(
          { error: "Internal server error" },
          { status: 500, headers: jsonHeaders }
        );
      }
    },
  });

  log.info(`Scraper Service v3.0 running on port ${server.port}`);
  if (process.env.DEBUG === "true") {
    log.debug(`Engines: ${getEngineNames().join(", ")}`);
    log.debug(`Captcha Strategies: ${getCaptchaStrategies().map(s => s.name).join(", ")}`);
    log.debug('Endpoints: /scrape/list, /scrape/book, /scrape/chapters, /scrape/content, /clean, /download-cover, /execute-task, /health, /queue/*, /ai/*, /test-rule, /fingerprint-health, /proxy/*, /session*, /fingerprint*, /rate-limit*, /anti-crawl/*, /priority-queue/*, /quality/*, /cookie-persist/*, /retry-stats*, /request-queue/*, /progress*, /domain-health*');
  }

  return server;
}

// ==================== Start ====================

const PORT = parseInt(process.env.PORT || "3099", 10) || 3099;
log.info(`PORT: ${PORT}, Auth: ${SERVICE_TOKEN ? "enabled" : "DISABLED"}`);
// Only log sensitive service URLs in debug mode
if (process.env.DEBUG === "true") {
  log.debug(`API_BASE: ${process.env.MAIN_APP_URL || "http://localhost:3000"}`);
  log.debug(`Firecrawl: ${process.env.FIRECRAWL_API_URL || "not configured"}`);
  log.debug(`AgentQL: ${process.env.AGENTQL_API_URL || "not configured"}`);
  log.debug(`CloudBrowser: ${process.env.CLOUD_BROWSER_PROVIDER || "browserless"}`);
}

// Recover any stale tasks from previous crashes before starting server
let recovered = 0;
try {
  recovered = await recoverStaleTasks();
} catch (err) {
  log.error('recoverStaleTasks failed (non-blocking)', { error: err instanceof Error ? err.message : String(err) });
}
if (recovered > 0) {
  log.info(`Recovered ${recovered} stale tasks`);
}

// Auto-load proxy pool from config file
try {
  const proxyConfigPath = resolve(import.meta.dir, 'proxy-config.json');
  const proxyConfigRaw = readFileSync(proxyConfigPath, 'utf-8');
  const proxyConfig = JSON.parse(proxyConfigRaw);
  if (proxyConfig.enabled && proxyConfig.autoImportOnStart && Array.isArray(proxyConfig.proxies) && proxyConfig.proxies.length > 0) {
    const added = proxyManager.addProxies(proxyConfig.proxies);
    log.info(`Imported ${added} proxies from proxy-config.json`);
  }
} catch (err) {
  // Non-blocking: proxy config is optional
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
    log.warn('Failed to load proxy-config.json (non-blocking)', { error: (err as Error).message });
  }
}

startServer(PORT);

// ─── Startup Validation ──────────────────────────────────────────
// Verify critical dependencies-configuration before accepting requests
{
  const startupIssues: string[] = [];
  if (!SERVICE_TOKEN || SERVICE_TOKEN.length < 16) {
    startupIssues.push('SCRAPER_SERVICE_TOKEN is missing or too short (<16 chars)');
  }
  const mainAppUrl = process.env.MAIN_APP_URL || 'http://localhost:3000';
  try {
    const url = new URL(mainAppUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
      startupIssues.push(`MAIN_APP_URL has invalid protocol: ${url.protocol}`);
    }
  } catch {
    startupIssues.push(`MAIN_APP_URL is not a valid URL: ${mainAppUrl}`);
  }
  if (startupIssues.length > 0) {
    log.warn(`Startup validation warnings: ${startupIssues.join('; ')}`);
  } else {
    log.info('Startup validation passed — all critical config OK');
  }
}

// Periodic stuck-task detection (every 2 minutes)
const STUCK_DETECT_INTERVAL_MS = 2 * 60 * 1000;
const stuckDetectInterval = setInterval(async () => {
  try {
    const count = await detectStuckTasks();
    if (count > 0) {
      log.info(`Detected and failed ${count} stuck tasks`);
    }
  } catch (err) {
    log.error('Stuck detection periodic check error', { error: err instanceof Error ? err.message : String(err) });
  }
}, STUCK_DETECT_INTERVAL_MS).unref();

// ==================== Graceful Shutdown ====================

let isShuttingDown = false;

const shutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log.info(`Received ${signal}, shutting down gracefully...`);

  // Stop accepting new tasks (mark as shutting down)
  // Wait for active tasks to complete (with a 30s hard deadline)
  const deadline = Date.now() + 30000;

  await Promise.race([
    new Promise<void>((resolve) => setTimeout(resolve, 30000)),
    (async () => {
      // Wait for all active tasks to finish
      while (activeTasks.size > 0 && Date.now() < deadline) {
        log.info(`Waiting for ${activeTasks.size} active tasks to complete...`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }),
  ]);

  // Save all checkpoints / persist state
  try {
    // Persist rate optimizer state
    if (typeof rateOptimizer?.persist === 'function') rateOptimizer.persist();
  } catch {}
  try {
    // Persist bypass registry
    const { bypassRegistry } = await import("./src/bypass-registry");
    bypassRegistry.persist();
  } catch {}
  try {
    // Flush and destroy logger
    const { logger } = await import("./src/logger");
    logger.flush();
    logger.destroy();
  } catch {}

  // Close all browser instances
  await closeAllEngines().catch(() => {});
  requestFingerprintMgr.destroy();
  sessionManager.destroy();
  
  // Cleanup: destroy all singleton modules that have destroy/cleanup methods
  try { if (typeof adaptiveDelay?.destroy === 'function') adaptiveDelay.destroy(); } catch {}
  try { if (typeof cookieJar?.destroy === 'function') cookieJar.destroy(); } catch {}
  try { if (typeof rateLimiter?.destroy === 'function') rateLimiter.destroy(); } catch {}
  try { if (typeof smartRetry?.destroy === 'function') smartRetry.destroy(); } catch {}
  try { if (typeof requestQueue?.destroy === 'function') requestQueue.destroy(); } catch {}
  try { if (typeof domainHealth?.destroy === 'function') domainHealth.destroy(); } catch {}
  try { if (typeof pipelineMetrics?.destroy === 'function') pipelineMetrics.destroy(); } catch {}
  try { if (typeof crawlScheduler?.destroy === 'function') crawlScheduler.destroy(); } catch {}
  try { if (typeof contentDeduplicator?.destroy === 'function') contentDeduplicator.destroy(); } catch {}
  try { if (typeof resultCache?.destroy === 'function') resultCache.destroy(); } catch {}
  clearInterval(terminateTimer); // Clear force-terminate timer regardless
  clearInterval(stuckDetectInterval); // Clear stuck-detection interval
  clearInterval(progressThrottleCleanupTimer); // Clear progress throttle cleanup
  log.info(`Active tasks: ${activeTasks.size}, Engines closed. State persisted. Exiting.`);

  process.exit(0);
};

// Terminate unfinished tasks if any
const terminateTimer = setInterval(() => {
  if (activeTasks.size > 0 && isShuttingDown) {
    // Tasks still running after deadline - force terminate
    log.warn(`Force terminating ${activeTasks.size} active tasks`);
    for (const taskId of activeTasks) {
      fetch(`${process.env.MAIN_APP_URL || "http://localhost:3000"}/api/scrape-tasks/${taskId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.SCRAPER_SERVICE_TOKEN || ""}`,
        },
        body: JSON.stringify({
          status: "failed",
          errorMessage: "服务正在关闭",
          completedAt: new Date().toISOString(),
        }),
      }).catch(() => {});
    }
    clearInterval(terminateTimer);
  }
}, 3000).unref();

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));