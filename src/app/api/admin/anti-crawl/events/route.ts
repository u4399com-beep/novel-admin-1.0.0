import { db } from '@/lib/db';
import { withAuth } from '@/lib/api-auth';
import { parsePagination, sanitizeField, safeJson } from '@/lib/api-utils';
import { NextRequest, NextResponse } from 'next/server';

const VALID_EVENT_TYPES = [
  'captcha_triggered',
  'proxy_exhausted',
  'font_updated',
  'tls_blocked',
  'rate_limited',
  'behavior_flagged',
];

// GET /api/admin/anti-crawl/events - List anti-crawl events with filtering
export const GET = withAuth(async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const { page, pageSize, skip } = parsePagination(searchParams, {
      defaultPageSize: 20,
      maxPageSize: 100,
    });

    // Build where clause from filters
    const where: Record<string, unknown> = {};

    const eventType = searchParams.get('eventType');
    if (eventType && VALID_EVENT_TYPES.includes(eventType)) {
      where.eventType = eventType;
    }

    const level = searchParams.get('level');
    if (level) {
      const parsed = parseInt(level, 10);
      if (parsed >= 1 && parsed <= 5) {
        where.level = parsed;
      }
    }

    const taskId = searchParams.get('taskId');
    if (taskId) {
      where.taskId = taskId;
    }

    const ruleId = searchParams.get('ruleId');
    if (ruleId) {
      where.ruleId = ruleId;
    }

    const resolved = searchParams.get('resolved');
    if (resolved !== null && resolved !== '') {
      where.resolved = resolved === 'true';
    }

    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');
    if (startDate || endDate) {
      const createdAtFilter: Record<string, Date> = {};
      if (startDate) {
        const d = new Date(startDate);
        if (!isNaN(d.getTime())) {
          createdAtFilter.gte = d;
        }
      }
      if (endDate) {
        const d = new Date(endDate);
        if (!isNaN(d.getTime())) {
          createdAtFilter.lte = d;
        }
      }
      if (Object.keys(createdAtFilter).length > 0) {
        where.createdAt = createdAtFilter;
      }
    }

    const [events, total] = await Promise.all([
      db.antiCrawlEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      db.antiCrawlEvent.count({ where }),
    ]);

    // Get counts by event type (for badges/summary)
    const countsByType = await db.antiCrawlEvent.groupBy({
      by: ['eventType'],
      _count: { eventType: true },
    });

    const typeCountMap: Record<string, number> = {};
    for (const item of countsByType) {
      typeCountMap[item.eventType] = item._count.eventType;
    }

    return NextResponse.json({
      events,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
      countsByType: typeCountMap,
    });
  } catch (error) {
    console.error('List anti-crawl events error:', error);
    return NextResponse.json({ error: '获取反爬事件列表失败' }, { status: 500 });
  }
});

// POST /api/admin/anti-crawl/events - Record a new anti-crawl event
export const POST = withAuth(async function POST(request: NextRequest) {
  try {
    let body;
    try {
      body = await safeJson(request);
    } catch {
      return NextResponse.json({ error: '请求数据格式错误' }, { status: 400 });
    }

    const eventType = sanitizeField(body.eventType, 100);
    if (!eventType || !VALID_EVENT_TYPES.includes(eventType)) {
      return NextResponse.json(
        { error: `eventType 必须是: ${VALID_EVENT_TYPES.join(', ')}` },
        { status: 400 },
      );
    }

    const level = body.level !== undefined ? Math.min(5, Math.max(1, Math.floor(Number(body.level)) || 1)) : 1;

    const record = await db.antiCrawlEvent.create({
      data: {
        eventType,
        level,
        taskId: body.taskId ? sanitizeField(body.taskId, 100) : null,
        ruleId: body.ruleId ? sanitizeField(body.ruleId, 100) : null,
        detail: body.detail ? sanitizeField(body.detail, 5000) : null,
        domain: body.domain ? sanitizeField(body.domain, 500) : null,
        proxyIp: body.proxyIp ? sanitizeField(body.proxyIp, 100) : null,
      },
    });

    // Auto-capture logic: if eventType is 'captcha_triggered' and same domain
    // had 3+ events in the last hour, auto-resolve the previous unresolved ones
    if (eventType === 'captcha_triggered' && record.domain) {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const recentCaptchas = await db.antiCrawlEvent.count({
        where: {
          eventType: 'captcha_triggered',
          domain: record.domain,
          createdAt: { gte: oneHourAgo },
          resolved: false,
        },
      });

      if (recentCaptchas >= 3) {
        await db.antiCrawlEvent.updateMany({
          where: {
            eventType: 'captcha_triggered',
            domain: record.domain,
            resolved: false,
            id: { not: record.id },
          },
          data: {
            resolved: true,
            resolvedAt: new Date(),
          },
        });
      }
    }

    return NextResponse.json(record, { status: 201 });
  } catch (error) {
    console.error('Create anti-crawl event error:', error);
    return NextResponse.json({ error: '记录反爬事件失败' }, { status: 500 });
  }
});
