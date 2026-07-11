import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { isSafeUrl } from '@/lib/sanitize';
import { safeJson } from '@/lib/api-utils';

const SCRAPER_SERVICE_URL =
  process.env.SCRAPER_SERVICE_URL || 'http://localhost:3099';

// POST /api/scrape-rules/preview  { url: "https://example.com" }
// Proxies to scraper-service /ai/preview-page
export const POST = withAuth(async function POST(request: NextRequest) {
  try {
    let body;
    try {
      body = await safeJson(request);
    } catch {
      return NextResponse.json({ error: '请求数据格式错误' }, { status: 400 });
    }
    const url = body.url;

    if (!url) {
      return NextResponse.json({ error: '缺少 URL 参数' }, { status: 400 });
    }

    // Basic URL validation
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return NextResponse.json({ error: '无效的 URL 格式' }, { status: 400 });
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return NextResponse.json({ error: '仅支持 http/https 协议' }, { status: 400 });
    }

    // Limit URL length
    if (url.length > 2048) {
      return NextResponse.json({ error: 'URL 过长' }, { status: 400 });
    }

    // SSRF protection - check for private/internal IPs
    if (!isSafeUrl(url)) {
      return NextResponse.json({ error: 'URL 不允许访问内网或私有地址' }, { status: 400 });
    }

    // Proxy to scraper-service via POST with JSON body and Authorization header
    const targetUrl = new URL('/ai/preview-page', SCRAPER_SERVICE_URL);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000); // 30s timeout

    try {
      const response = await fetch(targetUrl.toString(), {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.SCRAPER_SERVICE_TOKEN || ''}`,
        },
        body: JSON.stringify({ url }),
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        console.error(
          `[preview] Scraper service returned ${response.status}`,
        );
        return NextResponse.json(
          {
            error: `采集服务返回错误 (${response.status})`,
          },
          { status: 502 },
        );
      }

      const data = await response.json();

      return NextResponse.json({
        url,
        html: data.html || data.content || '',
        title: data.title || parsedUrl.hostname,
        statusCode: data.statusCode || 200,
      });
    } catch (fetchError: unknown) {
      clearTimeout(timeoutId);

      if (fetchError instanceof DOMException && fetchError.name === 'AbortError') {
        return NextResponse.json(
          { error: '请求采集服务超时，请稍后重试' },
          { status: 504 },
        );
      }

      throw fetchError;
    }
  } catch (error) {
    console.error('[preview] Error:', error);
    return NextResponse.json(
      { error: '获取页面预览失败' },
      { status: 500 },
    );
  }
});