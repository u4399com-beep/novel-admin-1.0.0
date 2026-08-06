import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { isSafeUrl } from '@/lib/sanitize';
import { safeJson, apiError } from "@/lib/api-utils";

import { SCRAPER_SERVICE_URL, getScraperServiceHeaders } from '@/lib/constants';

// POST /api/scrape-rules/preview  { url: "https://example.com" }
// Proxies to scraper-service /ai/preview-page
export const POST = withAuth(async function POST(request: NextRequest) {
  try {
    let body;
    try {
      body = await safeJson(request);
    } catch {
      return apiError('请求数据格式错误', 400);
    }
    const url = body.url;

    if (!url) {
      return apiError('缺少 URL 参数', 400);
    }

    // Basic URL validation
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return apiError('无效的 URL 格式', 400);
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return apiError('仅支持 http/https 协议', 400);
    }

    // Limit URL length
    if (url.length > 2048) {
      return apiError('URL 过长', 400);
    }

    // SSRF protection - check for private/internal IPs
    if (!isSafeUrl(url)) {
      return apiError('URL 不允许访问内网或私有地址', 400);
    }

    // Proxy to scraper-service via POST with JSON body and Authorization header
    const targetUrl = new URL('/ai/preview-page', SCRAPER_SERVICE_URL);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000); // 30s timeout

    try {
      const response = await fetch(targetUrl.toString(), {
        method: 'POST',
        signal: controller.signal,
        headers: getScraperServiceHeaders(),
        body: JSON.stringify({ url }),
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        console.error(
          `[preview] Scraper service returned ${response.status}`,
        );
                return apiError('采集服务返回错误 (${response.status})', 502);;
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
                return apiError('请求采集服务超时，请稍后重试', 504);;
      }

      throw fetchError;
    }
  } catch (error) {
    console.error('[preview] Error:', error);
        return apiError('获取页面预览失败', 500);;
  }
});