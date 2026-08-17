import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { safeJson, apiError } from '@/lib/api-utils';
import { isSafeUrl } from '@/lib/sanitize';
import { SCRAPER_SERVICE_URL, getScraperServiceHeaders } from '@/lib/constants';

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

interface AdvisorRecommendation {
  id: string;
  title: string;
  description: string;
  priority: 'high' | 'medium' | 'low';
  category: string;
  applied: boolean;
}

interface AdvisorReport {
  domain: string;
  threatLevel: 'low' | 'medium' | 'high';
  recommendations: AdvisorRecommendation[];
  suggestedEngine?: string;
}

interface AntiCrawlConfig {
  useJsRender?: boolean;
  uaRotation?: boolean;
  minDelay?: number;
  maxDelay?: number;
  useProxy?: boolean;
  useCookies?: boolean;
  useSession?: boolean;
  useStealth?: boolean;
  [key: string]: unknown;
}

interface GeneratedRule {
  name: string;
  description: string;
  engine: string;
  listUrl: string;
  listSelector: { type: string; value: string };
  listPagination: { type: string; selector: string; maxPage: number };
  bookTitleSelector: { type: string; value: string };
  bookAuthorSelector: { type: string; value: string };
  bookDescriptionSelector: { type: string; value: string };
  bookCoverSelector: { type: string; value: string };
  bookStatusSelector: { type: string; value: string };
  chapterListSelector: { type: string; value: string };
  chapterTitleSelector: { type: string; value: string };
  chapterLinkSelector: { type: string; value: string };
  contentSelector: { type: string; value: string };
  contentTitleSelector: { type: string; value: string };
  antiCrawlConfig: AntiCrawlConfig;
  agentqlQueries?: Record<string, string>;
  confidence: number;
  notes: string[];
}

// ═══════════════════════════════════════════════════════════════════
// Engine hierarchy (lower index = less powerful)
// ═══════════════════════════════════════════════════════════════════

const ENGINE_HIERARCHY: Record<string, number> = {
  cheerio: 0,
  playwright: 1,
  puppeteer: 1,
  browser: 2,
};

function isEngineHigher(current: string, suggested: string): boolean {
  const currentLevel = ENGINE_HIERARCHY[current] ?? 0;
  const suggestedLevel = ENGINE_HIERARCHY[suggested] ?? 0;
  return suggestedLevel > currentLevel;
}

// ═══════════════════════════════════════════════════════════════════
// Mock advisor fallback when scraper-service is unavailable
// ═══════════════════════════════════════════════════════════════════

function getMockAdvisorReport(domain: string): AdvisorReport {
  return {
    domain,
    threatLevel: 'low',
    recommendations: [
      {
        id: 'mock-1',
        title: '基础请求延迟',
        description: '建议设置最小 1000ms 请求延迟以避免触发频率限制',
        priority: 'medium',
        category: '延迟策略',
        applied: false,
      },
      {
        id: 'mock-2',
        title: 'User-Agent 轮换',
        description: '建议启用 UA 轮换以降低被识别为机器人的风险',
        priority: 'medium',
        category: '伪装策略',
        applied: false,
      },
    ],
  };
}

// ═══════════════════════════════════════════════════════════════════
// Fetch with timeout helper
// ═══════════════════════════════════════════════════════════════════

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return response;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Call anti-crawl advisor
// ═══════════════════════════════════════════════════════════════════

async function callAdvisor(
  domain: string,
): Promise<AdvisorReport | null> {
  try {
    const targetUrl = new URL('/anti-crawl/advise?XTransformPort=3099', SCRAPER_SERVICE_URL);
    const response = await fetchWithTimeout(
      targetUrl.toString(),
      {
        method: 'POST',
        headers: getScraperServiceHeaders(),
        body: JSON.stringify({ domain }),
      },
      30_000,
    );

    if (!response.ok) {
      console.warn(
        `[ai-generate-smart] Advisor returned ${response.status}, using mock fallback`,
      );
      return null;
    }

    const data = await response.json();
    if (!data || typeof data !== 'object') return null;
    return data as AdvisorReport;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      console.warn('[ai-generate-smart] Advisor request timed out, using mock');
    } else {
      console.warn('[ai-generate-smart] Advisor unavailable, using mock:', err);
    }
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Call AI generate-rule
// ═══════════════════════════════════════════════════════════════════

async function callAiGenerate(
  url: string,
  siteType?: string,
): Promise<GeneratedRule> {
  const targetUrl = new URL('/ai/generate-rule?XTransformPort=3099', SCRAPER_SERVICE_URL);
  const response = await fetchWithTimeout(
    targetUrl.toString(),
    {
      method: 'POST',
      headers: getScraperServiceHeaders(),
      body: JSON.stringify({ url, siteType: siteType || undefined }),
    },
    120_000,
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    console.error(
      `[ai-generate-smart] AI generate returned ${response.status}: ${errorText}`,
    );
    throw new Error(`AI 规则生成服务返回错误 (${response.status})`);
  }

  const data = await response.json();
  if (!data || !data.rule || typeof data !== 'object') {
    throw new Error('采集服务返回了无效数据');
  }
  return data.rule as GeneratedRule;
}

// ═══════════════════════════════════════════════════════════════════
// Merge advisor recommendations into rule
// ═══════════════════════════════════════════════════════════════════

function mergeAdvisorIntoRule(
  rule: GeneratedRule,
  advisor: AdvisorReport,
): { rule: GeneratedRule; appliedRecommendations: string[] } {
  const applied: string[] = [];

  // 1. Engine upgrade
  if (
    advisor.suggestedEngine &&
    isEngineHigher(rule.engine, advisor.suggestedEngine)
  ) {
    const oldEngine = rule.engine;
    rule.engine = advisor.suggestedEngine;
    applied.push(`引擎升级: ${oldEngine} → ${advisor.suggestedEngine}`);

    // Also enable JS render if upgrading to browser engine
    if (
      rule.antiCrawlConfig &&
      !rule.antiCrawlConfig.useJsRender
    ) {
      rule.antiCrawlConfig.useJsRender = true;
      applied.push('启用 JS 渲染（浏览器引擎需要）');
    }
  }

  // 2. Process recommendations
  for (const rec of advisor.recommendations) {
    const lowerCategory = rec.category.toLowerCase();
    const lowerTitle = rec.title.toLowerCase();

    if (!rule.antiCrawlConfig) {
      rule.antiCrawlConfig = {};
    }

    // Proxy recommendation
    if (
      (lowerCategory.includes('代理') || lowerTitle.includes('代理') || lowerTitle.includes('proxy')) &&
      !rule.antiCrawlConfig.useProxy
    ) {
      rule.antiCrawlConfig.useProxy = true;
      rec.applied = true;
      applied.push(`启用代理: ${rec.title}`);
      continue;
    }

    // Cookie recommendation
    if (
      (lowerCategory.includes('cookie') || lowerTitle.includes('cookie') || lowerCategory.includes('持久化')) &&
      !rule.antiCrawlConfig.useCookies
    ) {
      rule.antiCrawlConfig.useCookies = true;
      rec.applied = true;
      applied.push(`启用 Cookie 持久化: ${rec.title}`);
      continue;
    }

    // Session recommendation
    if (
      (lowerCategory.includes('会话') || lowerTitle.includes('会话') || lowerTitle.includes('session')) &&
      !rule.antiCrawlConfig.useSession
    ) {
      rule.antiCrawlConfig.useSession = true;
      rec.applied = true;
      applied.push(`启用会话管理: ${rec.title}`);
      continue;
    }

    // Stealth recommendation
    if (
      (lowerCategory.includes('隐身') || lowerCategory.includes('stealth') || lowerTitle.includes('隐身') || lowerTitle.includes('stealth')) &&
      !rule.antiCrawlConfig.useStealth
    ) {
      rule.antiCrawlConfig.useStealth = true;
      rec.applied = true;
      applied.push(`启用隐身模式: ${rec.title}`);
      continue;
    }

    // UA rotation
    if (
      (lowerCategory.includes('伪装') || lowerTitle.includes('user-agent') || lowerTitle.includes('ua') || lowerTitle.includes('轮换')) &&
      !rule.antiCrawlConfig.uaRotation
    ) {
      rule.antiCrawlConfig.uaRotation = true;
      rec.applied = true;
      applied.push(`启用 UA 轮换: ${rec.title}`);
      continue;
    }

    // Delay recommendations - increase minDelay if suggested
    if (lowerCategory.includes('延迟') || lowerTitle.includes('延迟') || lowerTitle.includes('delay')) {
      const currentMin = rule.antiCrawlConfig.minDelay ?? 500;
      if (currentMin < 1000) {
        rule.antiCrawlConfig.minDelay = 1000;
        applied.push(`增加最小延迟: ${currentMin}ms → 1000ms`);
      }
      const currentMax = rule.antiCrawlConfig.maxDelay ?? 1500;
      if (currentMax < 2000) {
        rule.antiCrawlConfig.maxDelay = 2000;
        applied.push(`增加最大延迟: ${currentMax}ms → 2000ms`);
      }
      rec.applied = true;
      continue;
    }

    // JS render
    if (
      (lowerCategory.includes('渲染') || lowerTitle.includes('js') || lowerTitle.includes('渲染')) &&
      !rule.antiCrawlConfig.useJsRender
    ) {
      rule.antiCrawlConfig.useJsRender = true;
      rec.applied = true;
      applied.push(`启用 JS 渲染: ${rec.title}`);
      continue;
    }

    // Mark as not applied (informational)
    rec.applied = false;
  }

  return { rule, appliedRecommendations: applied };
}

// ═══════════════════════════════════════════════════════════════════
// POST /api/scrape-rules/ai-generate-smart
// ═══════════════════════════════════════════════════════════════════

export const POST = withAuth(async function POST(request: NextRequest) {
  try {
    // 1. Parse and validate request body
    let body;
    try {
      body = await safeJson(request);
    } catch {
      return apiError('请求数据格式错误', 400);
    }

    const { url, siteType } = body;

    if (!url || typeof url !== 'string') {
      return apiError('缺少必需的 url 参数', 400);
    }

    // Basic URL validation
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return apiError('无效的 URL 格式', 400);
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return apiError('仅支持 http/https 协议', 400);
    }

    if (url.length > 2048) {
      return apiError('URL 过长', 400);
    }

    // SSRF protection
    if (!isSafeUrl(url)) {
      return apiError('URL 不允许访问内网或私有地址', 400);
    }

    // Validate siteType if provided
    const validSiteTypes = ['novel', 'manga', 'literature'];
    if (
      siteType !== undefined &&
      siteType !== null &&
      !validSiteTypes.includes(siteType)
    ) {
      return apiError(
        `无效的站点类型: ${siteType}，可选值: ${validSiteTypes.join(', ')}`,
        400,
      );
    }

    // 2. Extract domain
    const domain = parsedUrl.hostname;

    // 3. Call anti-crawl advisor (with mock fallback)
    const advisorReport = (await callAdvisor(domain)) ?? getMockAdvisorReport(domain);

    // 4. Call AI generate-rule
    let baseRule: GeneratedRule;
    try {
      baseRule = await callAiGenerate(url, siteType);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'AI 规则生成失败';
      return apiError(message, 502);
    }

    // 5. Merge advisor recommendations
    const { rule: enhancedRule, appliedRecommendations } = mergeAdvisorIntoRule(
      baseRule,
      advisorReport,
    );

    // 6. Return enhanced rule with advisor report
    return NextResponse.json({
      success: true,
      rule: enhancedRule,
      advisorReport,
      appliedRecommendations,
    });
  } catch (error) {
    console.error('[ai-generate-smart] Error:', error);
    return apiError('智能规则生成失败', 500);
  }
});
