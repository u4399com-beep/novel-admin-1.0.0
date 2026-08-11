import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { withPublicRateLimit, getClientIp } from '@/lib/api-auth';
import { isPrismaError, apiError } from "@/lib/api-utils";

/** In-memory dedup: IP+novelId → timestamp. TTL 24h. Prevents count manipulation. */
const favoriteDedup = new Map<string, number>();
const FAVORITE_TTL = 24 * 60 * 60 * 1000;
const FAVORITE_MAX_SIZE = 5000;

/** Periodic cleanup every 60s to prevent unbounded growth. */
function cleanupFavoriteDedup() {
  const now = Date.now();
  for (const [k, v] of favoriteDedup) {
    if (now - v > FAVORITE_TTL) favoriteDedup.delete(k);
  }
}
setInterval(cleanupFavoriteDedup, 60 * 1000).unref();

function isFavoriteDeduplicated(ip: string, novelId: string): boolean {
  const key = `${ip}:${novelId}`;
  const ts = favoriteDedup.get(key);
  if (ts && Date.now() - ts < FAVORITE_TTL) return true;
  favoriteDedup.set(key, Date.now());
  if (favoriteDedup.size > FAVORITE_MAX_SIZE) {
    cleanupFavoriteDedup();
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
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || 'toggle';

  if (!['add', 'remove', 'toggle'].includes(action)) {
    return apiError('无效的 action，允许值: add, remove, toggle', 400);
  }

  // Use shared getClientIp for consistent IP extraction
  const ip = getClientIp(request);

  try {
    // For add/toggle: check dedup to prevent count manipulation
    if (action !== 'remove') {
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
      const result = await db.$executeRaw`
        UPDATE "Novel" SET "favoriteCount" = MAX(0, "favoriteCount" - 1) WHERE id = ${id} AND "favoriteCount" > 0
      `;
      if (result === 0) {
        const current = await db.novel.findUnique({
          where: { id },
          select: { favoriteCount: true },
        });
        if (!current) {
          return apiError('小说不存在', 404);
        }
        return NextResponse.json({ favoriteCount: current.favoriteCount });
      }
      const updated = await db.novel.findUnique({
        where: { id },
        select: { favoriteCount: true },
      });
      return NextResponse.json({ favoriteCount: updated?.favoriteCount ?? 0 });
    }

    // For add/toggle: use transaction for atomic increment with existence check
    const result = await db.$transaction(async (tx) => {
      const novel = await tx.novel.findUnique({
        where: { id },
        select: { id: true, favoriteCount: true },
      });
      if (!novel) throw new Error('NOT_FOUND');

      const updated = await tx.novel.update({
        where: { id },
        data: { favoriteCount: { increment: 1 } },
        select: { favoriteCount: true },
      });
      return updated.favoriteCount;
    }, { timeout: 5000 });

    return NextResponse.json({ favoriteCount: result });
  } catch (error) {
    if (error instanceof Error && error.message === 'NOT_FOUND') {
      return apiError('小说不存在', 404);
    }
    if (isPrismaError(error, 'P2025')) {
      return apiError('小说不存在', 404);
    }
    console.error('Favorite API error:', error);
    return apiError('操作失败', 500);
  }
});
