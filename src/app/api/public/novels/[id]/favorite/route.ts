import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { withPublicRateLimit, getClientIp } from '@/lib/api-auth';
import { isPrismaError, apiError } from "@/lib/api-utils";

/** In-memory dedup: IP+novelId → timestamp. TTL 24h. Prevents count manipulation. */
const favoriteDedup = new Map<string, number>();
const FAVORITE_TTL = 24 * 60 * 60 * 1000;
const FAVORITE_MAX_SIZE = 5000;
const MAX_FAVORITE_COUNT = 100_000;

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
 * Public favorite toggle (no auth required).
 * Rate limited: 10 burst, 0.2/sec (5/min) per IP.
 * Dedup: same IP+novelId can only add once per 24h.
 * POST /api/public/novels/[id]/favorite?action=toggle|add
 *
 * Note: 'remove' action is NOT supported in the public endpoint to prevent
 * unauthenticated count manipulation (an attacker could drain any novel's count).
 * Use the authenticated /api/novels/[id]/favorite endpoint for remove.
 */
export const POST = withPublicRateLimit({ capacity: 10, refillRate: 0.2 }, async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || 'toggle';

  if (!['add', 'toggle'].includes(action)) {
    return apiError('公共接口仅支持 add/toggle 操作，remove 请使用认证接口', 400);
  }

  // Use shared getClientIp for consistent IP extraction
  const ip = getClientIp(request);

  try {
    // Check dedup to prevent count manipulation (same IP can only add once per 24h)
    if (isFavoriteDeduplicated(ip, id)) {
      const current = await db.novel.findUnique({
        where: { id },
        select: { favoriteCount: true },
      });
      return NextResponse.json({ favoriteCount: current?.favoriteCount ?? 0, deduplicated: true });
    }

    // Atomic increment with existence check and upper-bound cap in transaction
    const result = await db.$transaction(async (tx) => {
      const novel = await tx.novel.findUnique({
        where: { id },
        select: { id: true, favoriteCount: true },
      });
      if (!novel) throw new Error('NOT_FOUND');
      if (novel.favoriteCount >= MAX_FAVORITE_COUNT) {
        return novel.favoriteCount;
      }

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
