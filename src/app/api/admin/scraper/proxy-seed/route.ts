import { withAuth } from '@/lib/api-auth';
import { SCRAPER_SERVICE_URL, getScraperServiceHeaders } from '@/lib/constants';
import { NextResponse } from 'next/server';
import { apiError, safeJson } from '@/lib/api-utils';
import { isSafeUrl } from '@/lib/sanitize';

const SCRAPER_TIMEOUT = 60000; // 60s for batch test

/**
 * POST /api/admin/scraper/proxy-seed
 * Seed proxies into the pool, optionally verifying them.
 * Body: { proxies: string[], verify?: boolean }
 */
export const POST = withAuth(async function POST(request: Request) {
  try {
    let body: { proxies?: unknown[]; verify?: boolean };
    try {
      body = await safeJson<{ proxies?: unknown[]; verify?: boolean }>(request);
    } catch {
      return apiError('请求体格式错误', 400);
    }

    const { proxies, verify } = body;

    if (!Array.isArray(proxies) || proxies.length === 0) {
      return apiError('proxies 必须为非空数组', 400);
    }

    // Validate each proxy is a non-empty string with SSRF protection
    const validProxies: string[] = [];
    for (const p of proxies) {
      if (typeof p !== 'string' || p.trim().length === 0) continue;
      if (!isSafeUrl(p)) {
        return apiError(`代理URL不允许访问内网或私有地址: ${p.slice(0, 100)}`, 400);
      }
      validProxies.push(p);
    }
    if (validProxies.length === 0) {
      return apiError('无有效代理URL', 400);
    }
    if (validProxies.length > 100) {
      return apiError('单次最多导入100个代理', 400);
    }

    // Import proxies
    const importRes = await fetch(`${SCRAPER_SERVICE_URL}/proxy/import?XTransformPort=3099`, {
      method: 'POST',
      headers: getScraperServiceHeaders(),
      body: JSON.stringify({ proxies: validProxies }),
      signal: AbortSignal.timeout(15000),
    });

    if (!importRes.ok) {
      return apiError(`代理导入服务返回错误: ${importRes.status}`, 502);
    }
    let importData: Record<string, unknown>;
    try {
      importData = await importRes.json();
    } catch {
      return apiError('代理导入服务返回无效响应', 502);
    }

    let testResults = null;

    // Optionally verify all proxies
    if (verify) {
      try {
        const testRes = await fetch(`${SCRAPER_SERVICE_URL}/proxy/test-all?XTransformPort=3099`, {
          method: 'POST',
          headers: getScraperServiceHeaders(),
          signal: AbortSignal.timeout(SCRAPER_TIMEOUT),
        });
        testResults = await testRes.json();
      } catch {
        // Test failure is non-blocking
        testResults = { error: '代理测试超时或不可达' };
      }
    }

    return NextResponse.json({
      imported: importData.imported ?? validProxies.length,
      poolSize: importData.poolSize,
      testResults,
    });
  } catch (error) {
    console.error('Proxy seed error:', error);
    return apiError('代理种子导入失败', 500);
  }
});
