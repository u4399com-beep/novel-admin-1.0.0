import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { withPublicRateLimit } from '@/lib/api-auth';

/**
 * Public health-check endpoint — NO authentication required.
 *
 * Purpose:
 *   1. Docker healthcheck uses /api/auth/csrf (also public), but
 *      that only proves Next.js is alive, not the database.
 *   2. This endpoint proves the FULL stack works: Next.js + Prisma + DB.
 *   3. Returns minimal info (no table names, env keys, or auth details).
 *
 * Called by:
 *   - curl http://host:port/api/public/health
 *   - deploy.sh --diagnose
 * Rate limited to prevent DoS abuse.
 */
export const GET = withPublicRateLimit({ capacity: 120, refillRate: 4 }, async function GET() {
  // 1. Database connectivity
  const dbStart = Date.now();
  let dbOk = false;
  try {
    await db.$queryRaw`SELECT 1 AS ok`;
    dbOk = true;
  } catch {
    // DB not reachable
  }
  const dbMs = Date.now() - dbStart;

  const allOk = dbOk;

  return NextResponse.json(
    {
      status: allOk ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      checks: {
        database: { ok: dbOk, ms: dbMs },
      },
    },
    { status: allOk ? 200 : 503 },
  );
});
