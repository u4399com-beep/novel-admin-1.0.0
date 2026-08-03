import { db } from '@/lib/db';
import { withAuth } from '@/lib/api-auth';
import { safeJson, sanitizeField, safeJsonStringify } from '@/lib/api-utils';
import { NextRequest, NextResponse } from 'next/server';

// POST /api/admin/anti-crawl/proxy-stats - Record proxy pool stats
export const POST = withAuth(async function POST(request: NextRequest) {
  let body;
  try {
    body = await safeJson(request);
  } catch {
    return NextResponse.json({ error: '请求数据格式错误' }, { status: 400 });
  }
  try {

    const totalProxies = Math.max(0, Math.floor(Number(body.totalProxies) || 0));
    const activeProxies = Math.max(0, Math.floor(Number(body.activeProxies) || 0));
    const avgScore = Math.min(10, Math.max(0, Number(body.avgScore) || 0));
    const totalRequests = Math.max(0, Math.floor(Number(body.totalRequests) || 0));
    const successRate = Math.min(100, Math.max(0, Number(body.successRate) || 0));

    // Validate domainsTracked as a JSON array of strings
    let domainsTracked: string | null = null;
    if (body.domainsTracked !== undefined) {
      if (!Array.isArray(body.domainsTracked)) {
        return NextResponse.json(
          { error: 'domainsTracked 必须是字符串数组' },
          { status: 400 },
        );
      }
      // Sanitize each domain and limit length
      const sanitized = body.domainsTracked
        .slice(0, 200)
        .map((d: unknown) => sanitizeField(d, 200))
        .filter(Boolean);
      domainsTracked = safeJsonStringify(sanitized, 'domainsTracked', 10000);
    }

    const record = await db.proxyPoolStats.create({
      data: {
        totalProxies,
        activeProxies,
        avgScore,
        domainsTracked,
        totalRequests,
        successRate,
      },
    });

    return NextResponse.json(record, { status: 201 });
  } catch (error) {
    console.error('Create proxy pool stats error:', error);
    return NextResponse.json(
      { error: '记录代理池统计失败' },
      { status: 500 },
    );
  }
});

// GET /api/admin/anti-crawl/proxy-stats - Get latest proxy pool stats
export const GET = withAuth(async function GET() {
  try {
    const latest = await db.proxyPoolStats.findFirst({
      orderBy: { capturedAt: 'desc' },
    });

    return NextResponse.json({ stats: latest || null });
  } catch (error) {
    console.error('Get proxy pool stats error:', error);
    return NextResponse.json(
      { error: '获取代理池统计失败' },
      { status: 500 },
    );
  }
});
