import { db } from '@/lib/db';
import { NextResponse } from 'next/server';
import { withPublicRateLimit } from '@/lib/api-auth';
import { isPrismaError } from '@/lib/api-utils';

/** In-memory dedup: IP+novelId → timestamp. TTL 24h. Prevents count manipulation. */
const favoriteDedup = new Map<string, number>();
const FAVORITE_TTL = 24 * 60 * 60 * 1000;
function isFavoriteDeduplicated(ip: string, novelId: string): boolean {
  const key = `${ip}:${novelId}`;
  const ts = favoriteDedup.get(key);
  if (ts && Date.now() - ts < FAVORITE_TTL) return true;
  favoriteDedup.set(key, Date.now());
  // Lazy cleanup: remove expired entries when map grows
  if (favoriteDedup.size > 5000) {
    const now = Date.now();
    for (const [k, v] of favoriteDedup) {
      if (now - v > FAVORITE_TTL) favoriteDedup.delete(k);
    }
  }
  return false;
}

/**
 * Toggle novel favorite (no auth required).
 * Rate limited: 10 burst, 0.2/sec (5/min) per IP.
 * Dedup: same IP+novelId can only add once per 24h.
 * POST /api/public/novels/[id]/favorite?action=toggle|add|remove
 */
export const POST = withPublicRateLimit({ capacity: 10, refillRate: 0.2 }, async (
  request,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || 'toggle';

  // Validate action whitelist (prevent arbitrary values from triggering increment)
  if (!['add', 'remove', 'toggle'].includes(action)) {
    return NextResponse.json({ error: '无效的 action，允许值: add, remove, toggle' }, { status: 400 });
  }

  try {
    // For add/toggle: check dedup to prevent count manipulation
    if (action !== 'remove') {
      const ip = request.headers.get('x-real-ip') || request.headers.get('x-forwarded-for')?.split(',').pop()?.trim() || 'unknown';
      if (isFavoriteDeduplicated(ip, id)) {
        const current = await db.novel.findUnique({
          where: { id },
          select: { favoriteCount: true },
        });
        return NextResponse.json({ favoriteCount: current?.favoriteCount ?? 0, deduplicated: true });
      }
    }

    // For remove: atomic MAX(0, count-1) via raw SQL to prevent race condition
    if (action === 'remove') {
      // Use parameterized raw SQL for atomic floor-clamped decrement
      const result = await db.$executeRaw`
        UPDATE "Novel" SET "favoriteCount" = MAX(0, "favoriteCount" - 1) WHERE id = ${id} AND "favoriteCount" > 0
      `;
      if (result === 0) {
        // Either novel doesn't exist or count was already 0
        const current = await db.novel.findUnique({
          where: { id },
          select: { favoriteCount: true },
        });
        if (!current) {
          return NextResponse.json({ error: '小说不存在' }, { status: 404 });
        }
        return NextResponse.json({ favoriteCount: current.favoriteCount });
      }
      const updated = await db.novel.findUnique({
        where: { id },
        select: { favoriteCount: true },
      });
      return NextResponse.json({ favoriteCount: updated?.favoriteCount ?? 0 });
    }

    // For add/toggle: atomic increment
    const updated = await db.novel.update({
      where: { id },
      data: { favoriteCount: { increment: 1 } },
      select: { favoriteCount: true },
    });
    return NextResponse.json({ favoriteCount: updated.favoriteCount });
  } catch (error) {
    // Only return 404 for record-not-found; re-throw everything else as 500
    if (isPrismaError(error, 'P2025')) {
      return NextResponse.json({ error: '小说不存在' }, { status: 404 });
    }
    console.error('Favorite API error:', error);
    return NextResponse.json({ error: '操作失败' }, { status: 500 });
  }
});
