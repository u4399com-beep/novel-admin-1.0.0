import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { safeJson } from '@/lib/api-utils';
import { isSafeUrl } from '@/lib/sanitize';

const SCRAPER_SERVICE_URL =
  process.env.SCRAPER_SERVICE_URL || 'http://localhost:3099';

// POST /api/scrape-rules/ai-generate
// Body: { url: string, siteType?: string }
// Proxies to scraper-service /ai/generate-rule?XTransformPort=3099
export const POST = withAuth(async function POST(request: NextRequest) {
  try {
    let body;
    try {
      body = await safeJson(request);
    } catch {
      return NextResponse.json({ error: '请求数据格式错误' }, { status: 400 });
    }

    const { url, siteType } = body;

    if (!url || typeof url !== 'string') {
      return NextResponse.json({ error: '缺少必需的 url 参数' }, { status: 400 });
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

    if (url.length > 2048) {
      return NextResponse.json({ error: 'URL 过长' }, { status: 400 });
    }

    // SSRF protection - check for private/internal IPs
    if (!isSafeUrl(url)) {
      return NextResponse.json({ error: 'URL 不允许访问内网或私有地址' }, { status: 400 });
    }

    // Validate siteType if provided
    const validSiteTypes = ['novel', 'manga', 'literature'];
    const safeSiteType = validSiteTypes.includes(siteType) ? siteType : undefined;

    // Proxy to scraper-service
    const targetUrl = new URL('/ai/generate-rule', SCRAPER_SERVICE_URL);
    targetUrl.searchParams.set('XTransformPort', '3099');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120_000); // 2min timeout for AI generation

    try {
      const response = await fetch(targetUrl.toString(), {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url,
          siteType: safeSiteType,
        }),
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        console.error(
          `[ai-generate] Scraper service returned ${response.status}: ${errorText}`,
        );
        return NextResponse.json(
          {
            error: `AI 规则生成服务返回错误 (${response.status})`,
          },
          { status: 502 },
        );
      }

      const data = await response.json();

      return NextResponse.json(data);
    } catch (fetchError: unknown) {
      clearTimeout(timeoutId);

      if (fetchError instanceof DOMException && fetchError.name === 'AbortError') {
        return NextResponse.json(
          { error: 'AI 规则生成超时，请稍后重试或简化请求' },
          { status: 504 },
        );
      }

      throw fetchError;
    }
  } catch (error) {
    console.error('[ai-generate] Error:', error);
    return NextResponse.json(
      { error: 'AI 规则生成失败' },
      { status: 500 },
    );
  }
});
