import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { safeJson } from '@/lib/api-utils';
import { invalidateCache } from '@/lib/cache';

// GET /api/admin/settings - Get all settings as key-value object
export const GET = withAuth(async function GET() {
  try {
    const rows = await db.siteSetting.findMany({
      select: { key: true, value: true },
    });

    // Convert to plain object
    const settings: Record<string, string> = {};
    for (const row of rows) {
      settings[row.key] = row.value;
    }

    return NextResponse.json(settings);
  } catch (error) {
    console.error('Get settings error:', error);
    return NextResponse.json({ error: '获取设置失败' }, { status: 500 });
  }
});

// PUT /api/admin/settings - Batch upsert settings
// Body: { siteName: '...', itemsPerPage: '15', ... }
export const PUT = withAuth(async function PUT(request: NextRequest) {
  try {
    let body: Record<string, unknown>;
    try {
      body = await safeJson(request);
    } catch {
      return NextResponse.json({ error: '请求数据格式错误' }, { status: 400 });
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: '请求数据格式错误' }, { status: 400 });
    }

    // Allowed setting keys for security
    const ALLOWED_KEYS = new Set([
      'siteName', 'siteDescription', 'itemsPerPage', 'scrapeInterval',
      'concurrentTasks', 'autoPublish', 'defaultSort', 'themeColor', 'showWordCount',
    ]);

    const entries = Object.entries(body).filter(
      ([key]) => ALLOWED_KEYS.has(key)
    );

    if (entries.length === 0) {
      return NextResponse.json({ error: '没有有效的设置项' }, { status: 400 });
    }

    // Upsert each setting in a transaction
    await db.$transaction(
      entries.map(([key, value]) =>
        db.siteSetting.upsert({
          where: { key },
          update: { value: String(value) },
          create: { key, value: String(value) },
        })
      )
    );

    // Invalidate caches that may depend on settings
    invalidateCache('dashboard:stats');
    invalidateCache('categories:list');

    const result: Record<string, string> = {};
    for (const [key, value] of entries) {
      result[key] = String(value);
    }

    return NextResponse.json({ success: true, updated: result });
  } catch (error) {
    console.error('Save settings error:', error);
    return NextResponse.json({ error: '保存设置失败' }, { status: 500 });
  }
});
