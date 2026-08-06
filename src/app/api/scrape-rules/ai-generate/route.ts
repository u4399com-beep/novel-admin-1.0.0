import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { safeJson, apiError } from "@/lib/api-utils";
import { isSafeUrl } from '@/lib/sanitize';

import { SCRAPER_SERVICE_URL, getScraperServiceHeaders } from '@/lib/constants';

// POST /api/scrape-rules/ai-generate
// Body: { url: string, siteType?: string }
// Proxies to scraper-service /ai/generate-rule
export const POST = withAuth(async function POST(request: NextRequest) {
  try {
    let body;
    try {
      body = await safeJson(request);
    } catch {
      return apiError('请求数据格式错误', 400);
    }

    const { url, siteType } = body;

    if (!url || typeof url !== 'string') {
      return apiError('缺少必需的 url 参数', 400);
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

    if (url.length > 2048) {
      return apiError('URL 过长', 400);
    }

    // SSRF protection - check for private/internal IPs
    if (!isSafeUrl(url)) {
      return apiError('URL 不允许访问内网或私有地址', 400);
    }

    // Validate siteType if provided
    const validSiteTypes = ['novel', 'manga', 'literature'];
    if (siteType !== undefined && siteType !== null && !validSiteTypes.includes(siteType)) {
      return apiError(`无效的站点类型: ${siteType}，可选值: ${validSiteTypes.join(', ')}`, 400);
    }

    // Proxy to scraper-service
    const targetUrl = new URL('/ai/generate-rule', SCRAPER_SERVICE_URL);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120_000); // 2min timeout for AI generation

    try {
      const response = await fetch(targetUrl.toString(), {
        method: 'POST',
        signal: controller.signal,
        headers: getScraperServiceHeaders(),
        body: JSON.stringify({
          url,
          siteType: siteType || undefined,
        }),
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        console.error(
          `[ai-generate] Scraper service returned ${response.status}: ${errorText}`,
        );
                return apiError('AI 规则生成服务返回错误 (${response.status})', 502);;
      }

      const data = await response.json();

      if (!data || typeof data !== 'object') {
        return apiError('采集服务返回了无效数据', 502);
      }
      return NextResponse.json({
        success: data.success ?? false,
        rule: data.rule ?? null,
        error: data.error ?? null,
      });
    } catch (fetchError: unknown) {
      clearTimeout(timeoutId);

      if (fetchError instanceof DOMException && fetchError.name === 'AbortError') {
                return apiError('AI 规则生成超时，请稍后重试或简化请求', 504);;
      }

      throw fetchError;
    }
  } catch (error) {
    console.error('[ai-generate] Error:', error);
        return apiError('AI 规则生成失败', 500);;
  }
});
