'use server';

import { withAuth } from '@/lib/api-auth';
import { SCRAPER_SERVICE_URL, getScraperServiceHeaders } from '@/lib/constants';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-utils';

const SCRAPER_TIMEOUT = 5000;

/** Mock fallback when scraper-service is not reachable */
function mockQueueStats() {
  return {
    queueSize: 0,
    processingCount: 0,
    maxConcurrent: 3,
    byPriority: {},
    queueItems: [],
    processingItems: [],
    serviceReachable: false,
  };
}

// GET /api/admin/scraper/priority-queue — Proxy to /priority-queue/stats
export const GET = withAuth(async function GET() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCRAPER_TIMEOUT);

  try {
    const res = await fetch(`${SCRAPER_SERVICE_URL}/priority-queue/stats?XTransformPort=3099`, {
      headers: getScraperServiceHeaders(),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      return NextResponse.json(mockQueueStats());
    }

    const data = await res.json();
    return NextResponse.json({
      ...data,
      serviceReachable: true,
    });
  } catch {
    clearTimeout(timer);
    return NextResponse.json(mockQueueStats());
  }
});

// PUT /api/admin/scraper/priority-queue — Set max concurrency
// Body: { maxConcurrent: number }
export const PUT = withAuth(async function PUT(request: Request) {
  let body: { maxConcurrent?: number };
  try {
    body = await request.json();
  } catch {
    return apiError('请求体格式错误', 400);
  }

  const { maxConcurrent } = body;
  if (typeof maxConcurrent !== 'number' || maxConcurrent < 1 || maxConcurrent > 20) {
    return apiError('maxConcurrent 必须为 1-20 的整数', 400);
  }

  const url = `${SCRAPER_SERVICE_URL}/priority-queue/concurrency?XTransformPort=3099`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SCRAPER_TIMEOUT);

    const res = await fetch(url, {
      method: 'PUT',
      headers: getScraperServiceHeaders(),
      body: JSON.stringify({ maxConcurrent }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return apiError('采集服务不可达', 503);
  }
});

// POST /api/admin/scraper/priority-queue — Action router (reorder/cancel)
// Body: { action: 'reorder' | 'cancel', taskId: string, priority?: number }
export const POST = withAuth(async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return apiError('请求体格式错误', 400);
  }

  const { action, ...payload } = body;
  const validActions = ['reorder', 'cancel'];

  if (!action || typeof action !== 'string' || !validActions.includes(action)) {
    return apiError(`无效的操作类型，可选值: ${validActions.join(', ')}`, 400);
  }

  const scraperPath = action === 'reorder'
    ? '/priority-queue/reorder'
    : '/priority-queue/cancel';

  const url = `${SCRAPER_SERVICE_URL}${scraperPath}?XTransformPort=3099`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SCRAPER_TIMEOUT);

    const res = await fetch(url, {
      method: 'POST',
      headers: getScraperServiceHeaders(),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return apiError('采集服务不可达', 503);
  }
});
