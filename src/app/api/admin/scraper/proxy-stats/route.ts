
import { withAuth } from '@/lib/api-auth';
import { SCRAPER_SERVICE_URL, getScraperServiceHeaders } from '@/lib/constants';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-utils';

const SCRAPER_TIMEOUT = 5000;

/** Mock data returned when scraper-service is not reachable */
function mockProxyStats() {
  return {
    totalProxies: 0,
    activeProxies: 0,
    coolingProxies: 0,
    disabledProxies: 0,
    avgHealthScore: 0,
    avgResponseTime: 0,
    totalSuccesses: 0,
    totalFailures: 0,
    successRate: 0,
    topProxies: [],
    serviceReachable: false,
  };
}

// GET /api/admin/scraper/proxy-stats
export const GET = withAuth(async function GET() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SCRAPER_TIMEOUT);

    let res: Response;
    try {
      res = await fetch(`${SCRAPER_SERVICE_URL}/proxy-stats?XTransformPort=3099`, {
        headers: getScraperServiceHeaders(),
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      return NextResponse.json(mockProxyStats());
    }
    clearTimeout(timer);

    if (!res.ok) {
      return NextResponse.json(mockProxyStats());
    }

    const data = await res.json();
    return NextResponse.json({ ...data, serviceReachable: true });
  } catch (error) {
    console.error('Proxy stats error:', error);
    return apiError('获取代理池统计失败', 500);
  }
});
