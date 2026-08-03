import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

/**
 * Public health-check endpoint — NO authentication required.
 *
 * Purpose:
 *   1. Docker healthcheck uses /api/auth/csrf (also public), but
 *      that only proves Next.js is alive, not the database.
 *   2. This endpoint proves the FULL stack works: Next.js + Prisma + DB.
 *   3. Returns enough detail to diagnose "获取xxx失败" issues
 *      without exposing secrets.
 *
 * Called by:
 *   - curl http://host:port/api/public/health
 *   - deploy.sh --diagnose
 */
export async function GET() {
  const checks: Record<string, { ok: boolean; detail?: string; ms?: number }> = {};

  // 1. Database connectivity + key table existence
  const dbStart = Date.now();
  try {
    // Basic connectivity test
    await db.$queryRaw`SELECT 1 AS ok`;

    // Check key tables via Prisma (works for both SQLite and PostgreSQL)
    const expectedModels = ['Category', 'Novel', 'Chapter', 'ScrapeRule', 'ScrapeTask'];
    // Prisma model names use camelCase for client access (e.g. db.scrapeRule, NOT db.scraperule)
    const modelToProperty: Record<string, string> = {
      Category: 'category',
      Novel: 'novel',
      Chapter: 'chapter',
      ScrapeRule: 'scrapeRule',
      ScrapeTask: 'scrapeTask',
    };
    const missing: string[] = [];
    for (const model of expectedModels) {
      try {
        await (db as any)[modelToProperty[model]].count({ take: 1 });
      } catch {
        missing.push(model);
      }
    }

    if (missing.length > 0) {
      checks.database = {
        ok: false,
        detail: `缺少表: ${missing.join(', ')}`,
        ms: Date.now() - dbStart,
      };
    } else {
      checks.database = { ok: true, ms: Date.now() - dbStart };
    }
  } catch (err) {
    console.error('Health check DB error:', err);
    checks.database = {
      ok: false,
      detail: '数据库连接失败',
      ms: Date.now() - dbStart,
    };
  }

  // 2. Environment sanity check (minimal — no secret details exposed)
  const envChecks: string[] = [];
  if (!process.env.DATABASE_URL) {
    envChecks.push('DATABASE_URL 未配置');
  }
  checks.environment = {
    ok: envChecks.length === 0,
    detail: envChecks.length > 0 ? envChecks.join('; ') : 'ok',
  };

  // 3. Auth config check
  const isHttps = (process.env.NEXTAUTH_URL || '').startsWith('https://');
  checks.auth = {
    ok: !!process.env.NEXTAUTH_URL,
    detail: `cookie策略: ${isHttps ? 'Secure (HTTPS)' : '标准 (HTTP)'}`,
  };

  const allOk = Object.values(checks).every((c) => c.ok);

  return NextResponse.json(
    {
      status: allOk ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      checks,
    },
    { status: allOk ? 200 : 503 },
  );
}
