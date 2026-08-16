'use server';

import { withAuth } from '@/lib/api-auth';
import { SCRAPER_SERVICE_URL, getScraperServiceHeaders } from '@/lib/constants';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-utils';

const SCRAPER_TIMEOUT = 15000;

/** Map of action → { method, scraper path } */
const ACTION_MAP: Record<
  string,
  { method: 'POST' | 'GET'; path: string }
> = {
  add:             { method: 'POST', path: '/proxy/add' },
  remove:          { method: 'POST', path: '/proxy/remove' },
  reset:           { method: 'POST', path: '/proxy/reset' },
  check:           { method: 'POST', path: '/proxy/check' },
  'import':        { method: 'POST', path: '/proxy/import' },
  export:          { method: 'POST', path: '/proxy/export' },
  'bind-domain':   { method: 'POST', path: '/proxy/bind-domain' },
  'domain-bindings': { method: 'GET',  path: '/proxy/domain-bindings' },
  'detailed-stats':  { method: 'GET',  path: '/proxy/detailed-stats' },
};

const VALID_ACTIONS = Object.keys(ACTION_MAP);

// POST /api/admin/scraper/proxy-manage
// Body: { action: string, ...payload }
export const POST = withAuth(async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return apiError('请求体格式错误', 400);
  }

  const { action, ...payload } = body;

  if (!action || typeof action !== 'string' || !VALID_ACTIONS.includes(action)) {
    return apiError(`无效的操作类型，可选值: ${VALID_ACTIONS.join(', ')}`, 400);
  }

  const route = ACTION_MAP[action as string];
  const url = `${SCRAPER_SERVICE_URL}${route.path}?XTransformPort=3099`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SCRAPER_TIMEOUT);

    let res: Response;
    try {
      const fetchOptions: RequestInit = {
        method: route.method,
        headers: getScraperServiceHeaders(),
        signal: controller.signal,
      };

      if (route.method === 'POST') {
        fetchOptions.body = JSON.stringify(payload);
      }

      res = await fetch(url, fetchOptions);
    } catch {
      clearTimeout(timer);
      return apiError('代理服务不可达', 503);
    }
    clearTimeout(timer);

    const contentType = res.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      const data = await res.json();
      return NextResponse.json(data, { status: res.status });
    }

    // Non-JSON response (e.g. export)
    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: {
        'Content-Type': contentType || 'application/octet-stream',
      },
    });
  } catch (error) {
    console.error(`Proxy manage [${action}] error:`, error);
    return apiError(`代理管理操作 [${action}] 失败`, 500);
  }
});
