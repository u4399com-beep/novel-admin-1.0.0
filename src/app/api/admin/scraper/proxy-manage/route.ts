import { withAuth } from '@/lib/api-auth';
import { SCRAPER_SERVICE_URL, getScraperServiceHeaders } from '@/lib/constants';
import { NextResponse } from 'next/server';
import { apiError, safeJson } from '@/lib/api-utils';
import { isSafeUrl } from '@/lib/sanitize';

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
    body = await safeJson(request);
  } catch {
    return apiError('请求体格式错误', 400);
  }

  const { action, ...payload } = body;

  if (!action || typeof action !== 'string' || !VALID_ACTIONS.includes(action)) {
    return apiError(`无效的操作类型，可选值: ${VALID_ACTIONS.join(', ')}`, 400);
  }

  // SSRF validation: validate any URL fields in payload for proxy-related actions
  const URL_PAYLOAD_FIELDS = ['url', 'proxyUrl', 'testUrl'];
  for (const field of URL_PAYLOAD_FIELDS) {
    if (payload[field] && typeof payload[field] === 'string' && !isSafeUrl(payload[field] as string)) {
      return apiError(`${field} 不允许访问内网或私有地址`, 400);
    }
  }
  // For 'import' action, validate proxy URLs in array
  if (action === 'import' && Array.isArray(payload.proxies)) {
    for (const p of payload.proxies) {
      if (typeof p === 'string' && p.trim() && !isSafeUrl(p)) {
        return apiError(`代理URL不允许访问内网或私有地址: ${p.slice(0, 100)}`, 400);
      }
    }
  }

  const route = ACTION_MAP[action as string];
  // For GET actions, append payload as query params
  let url = `${SCRAPER_SERVICE_URL}${route.path}?XTransformPort=3099`;
  if (route.method === 'GET' && Object.keys(payload).length > 0) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(payload)) {
      if (v !== undefined && v !== null) params.set(k, String(v));
    }
    url += `&${params.toString()}`;
  }

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
      let data: unknown;
      try {
        data = await res.json();
      } catch {
        return apiError('采集服务返回了无效响应', 502);
      }
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
