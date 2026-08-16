'use server';

import { withAuth } from '@/lib/api-auth';
import { SCRAPER_SERVICE_URL, getScraperServiceHeaders } from '@/lib/constants';
import { NextResponse } from 'next/server';

const TIMEOUT_MS = 5000;

/** Mock fallback when scraper-service is not reachable */
function mockStats() {
  return {
    avgScore: 0,
    totalReports: 0,
    gradeDistribution: { A: 0, B: 0, C: 0, D: 0, F: 0 },
    recentReports: [],
    serviceReachable: false,
  };
}

// GET /api/admin/scraper/quality-stats
export const GET = withAuth(async function GET() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${SCRAPER_SERVICE_URL}/quality/stats?XTransformPort=3099`, {
      headers: getScraperServiceHeaders(),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      return NextResponse.json(mockStats());
    }

    const data = await res.json();
    return NextResponse.json({
      ...data,
      serviceReachable: true,
    });
  } catch {
    clearTimeout(timer);
    return NextResponse.json(mockStats());
  }
});
