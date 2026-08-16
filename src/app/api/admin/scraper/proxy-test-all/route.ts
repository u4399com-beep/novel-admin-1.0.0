'use server';

import { withAuth } from '@/lib/api-auth';
import { SCRAPER_SERVICE_URL, getScraperServiceHeaders } from '@/lib/constants';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-utils';

const SCRAPER_TIMEOUT = 5000;

// POST /api/admin/scraper/proxy-test-all
export const POST = withAuth(async function POST() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SCRAPER_TIMEOUT);

    let res: Response;
    try {
      res = await fetch(`${SCRAPER_SERVICE_URL}/proxy/test-all?XTransformPort=3099`, {
        method: 'POST',
        headers: getScraperServiceHeaders(),
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      return NextResponse.json([]);
    }
    clearTimeout(timer);

    if (!res.ok) {
      return NextResponse.json([]);
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Proxy test all error:', error);
    return apiError('代理批量测试失败', 500);
  }
});
