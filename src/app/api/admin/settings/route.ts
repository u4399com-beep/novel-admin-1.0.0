import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { safeJson, sanitizeField, apiError } from "@/lib/api-utils";
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
    return apiError('获取设置失败', 500);
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
      return apiError('请求数据格式错误', 400);
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return apiError('请求数据格式错误', 400);
    }

    // Allowed setting keys and per-key value validation
    const ALLOWED_KEYS = new Set([
      'siteName', 'siteDescription', 'itemsPerPage', 'scrapeInterval',
      'concurrentTasks', 'autoPublish', 'defaultSort', 'themeColor', 'showWordCount',
    ]);

    const INTEGER_KEYS = new Set(['itemsPerPage', 'scrapeInterval', 'concurrentTasks']);
    const BOOLEAN_KEYS = new Set(['autoPublish', 'showWordCount']);
    const STRING_MAX: Record<string, number> = {
      siteName: 100, siteDescription: 500, defaultSort: 50, themeColor: 20,
    };
    const INTEGER_RANGE: Record<string, [number, number]> = {
      itemsPerPage: [1, 100], scrapeInterval: [1, 3600], concurrentTasks: [1, 20],
    };

    const entries: [string, string][] = [];
    const ignoredKeys: string[] = [];
    for (const [key, rawValue] of Object.entries(body)) {
      if (!ALLOWED_KEYS.has(key)) {
        ignoredKeys.push(key);
        continue;
      }
      if (INTEGER_KEYS.has(key)) {
        const n = Number(rawValue);
        const [min, max] = INTEGER_RANGE[key];
        if (!Number.isFinite(n) || n < min || n > max || !Number.isInteger(n)) {
          return apiError(`${key} 必须是 ${min}-${max} 之间的整数`, 400);
        }
        entries.push([key, String(n)]);
      } else if (BOOLEAN_KEYS.has(key)) {
        if (rawValue !== 'true' && rawValue !== 'false' && rawValue !== true && rawValue !== false) {
          return apiError(`${key} 必须是 true 或 false`, 400);
        }
        entries.push([key, String(rawValue)]);
      } else {
        const maxLen = STRING_MAX[key];
        const val = sanitizeField(String(rawValue ?? ''), maxLen);
        if (key === 'themeColor' && val && !/^#[0-9A-Fa-f]{3,8}$/.test(val)) {
          return apiError('themeColor 格式无效，请使用HEX颜色', 400);
        }
        entries.push([key, val]);
      }
    }

    if (entries.length === 0) {
      return apiError('没有有效的设置项', 400);
    }

    // Upsert each setting in a transaction
    await db.$transaction(
      entries.map(([key, value]) =>
        db.siteSetting.upsert({
          where: { key },
          update: { value },
          create: { key, value },
        })
      )
    );

    // Invalidate caches that may depend on settings
    invalidateCache('dashboard:stats');
    invalidateCache('categories:*');
    invalidateCache('public:settings');

    const result: Record<string, string> = {};
    for (const [key, value] of entries) {
      result[key] = String(value);
    }

    return NextResponse.json({ success: true, updated: result, ...(ignoredKeys.length > 0 ? { ignoredKeys } : {}) });
  } catch (error) {
    console.error('Save settings error:', error);
    return apiError('保存设置失败', 500);
  }
});
