'use server';

import { withAuth } from '@/lib/api-auth';
import { SCRAPER_SERVICE_URL, getScraperServiceHeaders } from '@/lib/constants';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-utils';

const SCRAPER_TIMEOUT = 5000;

interface CookieDomainStat {
  domain: string;
  count: number;
  lastActivity: number;
}

interface CookieStatsResponse {
  domains: CookieDomainStat[];
  totalDomains: number;
  totalCookies: number;
  serviceReachable: boolean;
}

/** Mock data returned when scraper-service is not reachable */
function mockCookieStats(): CookieStatsResponse {
  return {
    domains: [],
    totalDomains: 0,
    totalCookies: 0,
    serviceReachable: false,
  };
}

// GET /api/admin/scraper/cookies
export const GET = withAuth(async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const includeData = searchParams.get('includeData') === 'true';
    const url = includeData
      ? `${SCRAPER_SERVICE_URL}/cookie-stats?includeData=true&XTransformPort=3099`
      : `${SCRAPER_SERVICE_URL}/cookie-stats?XTransformPort=3099`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SCRAPER_TIMEOUT);

    let res: Response;
    try {
      res = await fetch(url, {
        headers: getScraperServiceHeaders(),
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      return NextResponse.json(mockCookieStats());
    }
    clearTimeout(timer);

    if (!res.ok) {
      return NextResponse.json(mockCookieStats());
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json(mockCookieStats());
  }
});
