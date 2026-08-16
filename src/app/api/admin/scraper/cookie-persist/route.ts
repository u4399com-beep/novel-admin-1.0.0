'use server';

import { withAuth } from '@/lib/api-auth';
import { SCRAPER_SERVICE_URL, getScraperServiceHeaders } from '@/lib/constants';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-utils';

const SCRAPER_TIMEOUT = 5000;

/** Mock data returned when scraper-service is not reachable */
function mockCookiePersistStats() {
  return {
    domains: [],
    totalCookies: 0,
    totalDomains: 0,
    serviceReachable: false,
  };
}

// GET /api/admin/scraper/cookie-persist/stats
export const GET = withAuth(async function GET() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SCRAPER_TIMEOUT);

    let res: Response;
    try {
      res = await fetch(`${SCRAPER_SERVICE_URL}/cookie-persist/stats?XTransformPort=3099`, {
        headers: getScraperServiceHeaders(),
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      return NextResponse.json(mockCookiePersistStats());
    }
    clearTimeout(timer);

    if (!res.ok) {
      return NextResponse.json(mockCookiePersistStats());
    }

    const data = await res.json();
    return NextResponse.json({ ...data, serviceReachable: true });
  } catch (error) {
    console.error('Cookie persist stats error:', error);
    return apiError('获取Cookie持久化统计失败', 500);
  }
});
