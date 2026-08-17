
import { withAuth } from '@/lib/api-auth';
import { SCRAPER_SERVICE_URL, getScraperServiceHeaders } from '@/lib/constants';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-utils';

const SCRAPER_TIMEOUT = 10000;

/** Map of action → scraper service path */
const ACTION_MAP: Record<string, string> = {
  set: '/rate-limit/set',
  reset: '/rate-limit/reset',
};

const VALID_ACTIONS = Object.keys(ACTION_MAP);

// POST /api/admin/scraper/rate-limit-manage
// Body: { action: string, domain: string, maxRPM?: number }
export const POST = withAuth(async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return apiError('请求体格式错误', 400);
  }

  const { action, domain, ...payload } = body;

  if (!action || typeof action !== 'string' || !VALID_ACTIONS.includes(action)) {
    return apiError(`无效的操作类型，可选值: ${VALID_ACTIONS.join(', ')}`, 400);
  }

  if (!domain || typeof domain !== 'string') {
    return apiError('缺少 domain 参数', 400);
  }

  const scraperPath = ACTION_MAP[action as string];
  const url = `${SCRAPER_SERVICE_URL}${scraperPath}?XTransformPort=3099`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SCRAPER_TIMEOUT);

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: getScraperServiceHeaders(),
        body: JSON.stringify({ domain, ...payload }),
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      return apiError('采集服务不可达', 503);
    }
    clearTimeout(timer);

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      return apiError('采集服务返回了无效响应', 502);
    }
    return NextResponse.json(data, { status: res.status });
  } catch (error) {
    console.error(`Rate limit manage [${action}] error:`, error);
    return apiError(`速率限制操作 [${action}] 失败`, 500);
  }
});
