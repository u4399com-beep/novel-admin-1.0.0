
import { withAuth } from '@/lib/api-auth';
import { SCRAPER_SERVICE_URL, getScraperServiceHeaders } from '@/lib/constants';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-utils';

const SCRAPER_TIMEOUT = 8000;

// GET /api/admin/anti-crawl/domain-signals?domain=example.com
export const GET = withAuth(async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const domain = searchParams.get('domain');

    if (!domain) {
      return apiError('domain 查询参数为必填项', 400);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SCRAPER_TIMEOUT);

    let res: Response;
    try {
      const encodedDomain = encodeURIComponent(domain);
      res = await fetch(
        `${SCRAPER_SERVICE_URL}/anti-crawl/domain-signals?domain=${encodedDomain}&XTransformPort=3099`,
        {
          headers: getScraperServiceHeaders(),
          signal: controller.signal,
        }
      );
    } catch {
      clearTimeout(timer);
      return NextResponse.json({ domain, signals: [], serviceReachable: false });
    }
    clearTimeout(timer);

    if (!res.ok) {
      let errorMsg = '获取域名信号失败';
      try {
        const body = await res.json();
        errorMsg = body.error || errorMsg;
      } catch { /* ignore parse error */ }
      return NextResponse.json({ domain, signals: [], error: errorMsg, serviceReachable: false });
    }

    const data = await res.json();
    return NextResponse.json({ ...data, serviceReachable: true });
  } catch (error) {
    console.error('Domain signals error:', error);
    return apiError('获取域名信号失败', 500);
  }
});
