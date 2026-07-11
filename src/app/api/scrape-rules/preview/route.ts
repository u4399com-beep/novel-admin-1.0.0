import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';

const SCRAPER_SERVICE_URL =
  process.env.SCRAPER_SERVICE_URL || 'http://localhost:3099';

// GET /api/scrape-rules/preview?url=https://example.com
// Proxies to scraper-service /ai/preview-page
export const GET = withAuth(async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const url = searchParams.get('url');

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

    // Proxy to scraper-service
    const targetUrl = new URL('/ai/preview-page', SCRAPER_SERVICE_URL);
    targetUrl.searchParams.set('url', url);
    targetUrl.searchParams.set('XTransformPort', '3099');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000); // 30s timeout

    try {
      const response = await fetch(targetUrl.toString(), {
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
        },
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        console.error(
          `[preview] Scraper service returned ${response.status}: ${errorText}`,
        );
        return NextResponse.json(
          {
            error: `采集服务返回错误 (${response.status})`,
            details: errorText.slice(0, 500),
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
