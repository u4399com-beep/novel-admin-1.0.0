'use server';

import { withAuth } from '@/lib/api-auth';
import { SCRAPER_SERVICE_URL, getScraperServiceHeaders } from '@/lib/constants';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-utils';

const SCRAPER_TIMEOUT = 5000;

// POST /api/admin/scraper/cookies/clear
// Body: { domain?: string } — if domain is provided, clear only that domain's cookies
export const POST = withAuth(async function POST(request: Request) {
  try {
    let body: { domain?: string } | null = null;
    try {
      body = await request.json();
    } catch {
      body = null;
    }

    const domain = body?.domain;
    const url = domain
      ? `${SCRAPER_SERVICE_URL}/cookie-clear?domain=${encodeURIComponent(domain)}&XTransformPort=3099`
      : `${SCRAPER_SERVICE_URL}/cookie-clear?XTransformPort=3099`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SCRAPER_TIMEOUT);

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: getScraperServiceHeaders(),
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      return apiError('无法连接采集服务', 503);
    }
    clearTimeout(timer);

    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return apiError('清除Cookie失败', 500);
  }
});
