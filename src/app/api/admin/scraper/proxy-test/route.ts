
import { withAuth } from '@/lib/api-auth';
import { SCRAPER_SERVICE_URL, getScraperServiceHeaders } from '@/lib/constants';
import { NextResponse } from 'next/server';
import { apiError, safeJson } from '@/lib/api-utils';
import { isSafeUrl } from '@/lib/sanitize';

const SCRAPER_TIMEOUT = 5000;

/** Mock data returned when scraper-service is not reachable */
function mockProxyTest() {
  return {
    reachable: false,
    error: 'Service unavailable',
  };
}

// POST /api/admin/scraper/proxy-test
export const POST = withAuth(async function POST(request: Request) {
  try {
    let body: { url?: string; testUrl?: string };
    try {
      body = await safeJson(request);
    } catch {
      return apiError('请求体格式错误', 400);
    }

    if (!body.url || typeof body.url !== 'string') {
      return apiError('缺少 url 参数', 400);
    }

    // SSRF validation on proxy URL
    if (!isSafeUrl(body.url)) {
      return apiError('代理URL不允许访问内网或私有地址', 400);
    }

    // SSRF validation on testUrl if provided
    if (body.testUrl && typeof body.testUrl === 'string' && !isSafeUrl(body.testUrl)) {
      return apiError('测试URL不允许访问内网或私有地址', 400);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SCRAPER_TIMEOUT);

    let res: Response;
    try {
      res = await fetch(`${SCRAPER_SERVICE_URL}/proxy/test?XTransformPort=3099`, {
        method: 'POST',
        headers: getScraperServiceHeaders(),
        body: JSON.stringify({ url: body.url, testUrl: body.testUrl }),
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      return NextResponse.json(mockProxyTest());
    }
    clearTimeout(timer);

    if (!res.ok) {
      return NextResponse.json(mockProxyTest());
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Proxy test error:', error);
    return apiError('代理测试失败', 500);
  }
});
