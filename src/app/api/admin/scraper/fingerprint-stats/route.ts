'use server';

import { withAuth } from '@/lib/api-auth';
import { SCRAPER_SERVICE_URL, getScraperServiceHeaders } from '@/lib/constants';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-utils';

const SCRAPER_TIMEOUT = 5000;

/** Mock data returned when scraper-service is not reachable */
function mockFingerprintData() {
  return {
    recent: [],
    stats: { total: 0, domains: [] },
    serviceReachable: false,
  };
}

// GET /api/admin/scraper/fingerprint-stats
export const GET = withAuth(async function GET() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SCRAPER_TIMEOUT);

    let recentRes: Response;
    let statsRes: Response;
    try {
      [recentRes, statsRes] = await Promise.all([
        fetch(`${SCRAPER_SERVICE_URL}/fingerprint-recent?limit=50&XTransformPort=3099`, {
          headers: getScraperServiceHeaders(),
          signal: controller.signal,
        }),
        fetch(`${SCRAPER_SERVICE_URL}/fingerprint-stats?XTransformPort=3099`, {
          headers: getScraperServiceHeaders(),
          signal: controller.signal,
        }),
      ]);
    } catch {
      clearTimeout(timer);
      return NextResponse.json(mockFingerprintData());
    }
    clearTimeout(timer);

    if (!recentRes.ok || !statsRes.ok) {
      return NextResponse.json(mockFingerprintData());
    }

    const [recent, stats] = await Promise.all([
      recentRes.json(),
      statsRes.json(),
    ]);

    return NextResponse.json({
      recent,
      stats,
      serviceReachable: true,
    });
  } catch (error) {
    console.error('Fingerprint stats error:', error);
    return apiError('获取指纹统计失败', 500);
  }
});
