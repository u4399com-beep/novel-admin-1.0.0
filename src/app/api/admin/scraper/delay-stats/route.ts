
import { withAuth } from '@/lib/api-auth';
import { SCRAPER_SERVICE_URL, getScraperServiceHeaders } from '@/lib/constants';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-utils';

const SCRAPER_TIMEOUT = 5000;

/** Mock data returned when scraper-service is not reachable */
function mockDelayStats() {
  return {
    domains: [],
    totalDomains: 0,
    serviceReachable: false,
  };
}

// GET /api/admin/scraper/delay-stats
export const GET = withAuth(async function GET() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SCRAPER_TIMEOUT);

    let res: Response;
    try {
      res = await fetch(`${SCRAPER_SERVICE_URL}/delay-stats?XTransformPort=3099`, {
        headers: getScraperServiceHeaders(),
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      return NextResponse.json(mockDelayStats());
    }
    clearTimeout(timer);

    if (!res.ok) {
      return NextResponse.json(mockDelayStats());
    }

    const data = await res.json();
    return NextResponse.json({ ...data, serviceReachable: true });
  } catch (error) {
    console.error('Delay stats error:', error);
    return apiError('获取自适应延迟统计失败', 500);
  }
});
