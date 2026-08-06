import { db } from '@/lib/db';
import { NextResponse } from 'next/server';
import { withPublicRateLimit } from '@/lib/api-auth';
import { isPrismaError, apiError } from "@/lib/api-utils";

/** In-memory dedup: IP+novelId → timestamp. TTL 5min. Prevents click spam. */
const clickDedup = new Map<string, number>();
const CLICK_TTL = 5 * 60 * 1000;
function isClickDeduplicated(ip: string, novelId: string): boolean {
  const key = `${ip}:${novelId}`;
  const ts = clickDedup.get(key);
  if (ts && Date.now() - ts < CLICK_TTL) return true;
  clickDedup.set(key, Date.now());
  // Lazy cleanup
  if (clickDedup.size > 10000) {
    const now = Date.now();
    for (const [k, v] of clickDedup) {
      if (now - v > CLICK_TTL) clickDedup.delete(k);
    }
  }
  return false;
}

/**
 * Increment novel click count (no auth required).
 * Rate limited: 10 burst, 0.2/sec (5/min) per IP.
 * Dedup: same IP+novelId only counted once per 5 minutes.
 * POST /api/public/novels/[id]/click
 */
export const POST = withPublicRateLimit({ capacity: 10, refillRate: 0.2 }, async (
  request,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;

  // Dedup check
  const ip = request.headers.get('x-real-ip') || request.headers.get('x-forwarded-for')?.split(',').pop()?.trim() || 'unknown';
  if (isClickDeduplicated(ip, id)) {
    try {
      const current = await db.novel.findUnique({
        where: { id },
        select: { clickCount: true },
      });
      return NextResponse.json({ clickCount: current?.clickCount ?? 0, deduplicated: true });
    } catch {
      return NextResponse.json({ clickCount: 0, deduplicated: true });
    }
  }

  try {
    try {
      const updated = await db.novel.update({
        where: { id },
        data: { clickCount: { increment: 1 } },
        select: { clickCount: true },
      });
      return NextResponse.json({ clickCount: updated.clickCount });
    } catch (error) {
      if (isPrismaError(error, 'P2025')) {
        return apiError('小说不存在', 404);
      }
      throw error;
    }
  } catch (error) {
    console.error('Click tracking error:', error);
    return apiError('操作失败', 500);
  }
});
