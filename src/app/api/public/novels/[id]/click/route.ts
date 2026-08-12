import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { withPublicRateLimit, getClientIp } from '@/lib/api-auth';
import { isPrismaError, apiError } from "@/lib/api-utils";

/** In-memory dedup: IP+novelId → timestamp. TTL 5min. Prevents click spam. */
const clickDedup = new Map<string, number>();
const CLICK_TTL = 5 * 60 * 1000;
const CLICK_MAX_SIZE = 5000;
const MAX_CLICK_COUNT = 1_000_000;

/** Periodic cleanup every 60s to prevent unbounded growth. */
function cleanupClickDedup() {
  const now = Date.now();
  for (const [k, v] of clickDedup) {
    if (now - v > CLICK_TTL) clickDedup.delete(k);
  }
}
setInterval(cleanupClickDedup, 60 * 1000).unref();

function isClickDeduplicated(ip: string, novelId: string): boolean {
  const key = `${ip}:${novelId}`;
  const ts = clickDedup.get(key);
  if (ts && Date.now() - ts < CLICK_TTL) return true;
  clickDedup.set(key, Date.now());
  if (clickDedup.size > CLICK_MAX_SIZE) {
    cleanupClickDedup();
  }
  return false;
}

/**
 * Increment novel click count (no auth required).
 * Rate limited: 10 burst, 0.2/sec (5/min) per IP.
 * Dedup: same IP+novelId only counted once per 5 minutes.
 * Uses transaction to prevent race condition between dedup check and increment.
 * POST /api/public/novels/[id]/click
 */
export const POST = withPublicRateLimit({ capacity: 10, refillRate: 0.2 }, async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;

  // Dedup check — use shared getClientIp for consistent IP extraction
  const ip = getClientIp(request);
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
    // Use transaction: atomically check existence + increment + upper-bound cap
    const result = await db.$transaction(async (tx) => {
      const novel = await tx.novel.findUnique({
        where: { id },
        select: { id: true, clickCount: true },
      });
      if (!novel) throw new Error('NOT_FOUND');
      if (novel.clickCount >= MAX_CLICK_COUNT) {
        return novel.clickCount;
      }

      const updated = await tx.novel.update({
        where: { id },
        data: { clickCount: { increment: 1 } },
        select: { clickCount: true },
      });
      return updated.clickCount;
    }, { timeout: 5000 });

    return NextResponse.json({ clickCount: result });
  } catch (error) {
    if (error instanceof Error && error.message === 'NOT_FOUND') {
      return apiError('小说不存在', 404);
    }
    console.error('Click tracking error:', error);
    return apiError('操作失败', 500);
  }
});
