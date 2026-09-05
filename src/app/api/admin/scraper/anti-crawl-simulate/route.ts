import { withAuth } from '@/lib/api-auth';
import { SCRAPER_SERVICE_URL, getScraperServiceHeaders } from '@/lib/constants';
import { NextResponse } from 'next/server';
import { apiError, safeJson } from '@/lib/api-utils';
import { isSafeUrl } from '@/lib/sanitize';
import { safeHostname } from '@/lib/utils';

const SCRAPER_TIMEOUT = 8000;

/** Mock fallback when scraper-service is not reachable */
function mockSimulateResult(targetUrl?: string) {
  const domain = safeHostname(targetUrl || 'https://example.com');
  return {
    targetUrl: targetUrl || '',
    domain,
    selectedEngine: 'cheerio',
    checks: [
      { name: 'UA轮换', passed: false, detail: '建议启用UA轮换避免指纹固定' },
      { name: '代理配置', passed: false, detail: '未配置代理，建议对高防护站点启用' },
      { name: '人类行为模拟', passed: false, detail: '建议对JS渲染站点启用' },
      { name: 'CAPTCHA策略', passed: false, detail: '当前策略: delay-backoff' },
      { name: '引擎选择', passed: true, detail: '推荐引擎: cheerio，当前: cheerio' },
      { name: 'Cookie/Session', passed: false, detail: '暂无会话，首次请求时自动创建' },
      { name: '速率限制', passed: true, detail: '状态: normal，最大RPM: 30' },
      { name: '隐身模块', passed: true, detail: '域名指纹: 未配置(首次使用时生成)' },
    ],
    score: 15,
    grade: 'D',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'text/html,application/xhtml+xml',
    },
    recommendations: ['scraper-service 不可达，使用模拟数据'],
    serviceReachable: false,
  };
}

// POST /api/admin/scraper/anti-crawl-simulate
export const POST = withAuth(async function POST(request: Request) {
  let body: { targetUrl?: string; engine?: string; antiCrawlConfig?: Record<string, unknown> };
  try {
    body = await safeJson<{ targetUrl?: string; engine?: string; antiCrawlConfig?: Record<string, unknown> }>(request);
  } catch {
    return apiError('请求数据格式错误', 400);
  }

  try {
    if (!body.targetUrl || typeof body.targetUrl !== 'string') {
      return NextResponse.json({ error: 'targetUrl is required' }, { status: 400 });
    }

    // SSRF validation on targetUrl
    if (!isSafeUrl(body.targetUrl)) {
      return apiError('目标URL不允许访问内网或私有地址', 400);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SCRAPER_TIMEOUT);

    let res: Response;
    try {
      res = await fetch(`${SCRAPER_SERVICE_URL}/anti-crawl/simulate?XTransformPort=3099`, {
        method: 'POST',
        headers: getScraperServiceHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      return NextResponse.json(mockSimulateResult(body.targetUrl));
    }
    clearTimeout(timer);

    if (!res.ok) {
      return NextResponse.json(mockSimulateResult(body.targetUrl));
    }

    const data = await res.json();
    return NextResponse.json({ ...data, serviceReachable: true });
  } catch (error) {
    console.error('Anti-crawl simulate error:', error);
    return apiError('仿真测试失败', 500);
  }
});
