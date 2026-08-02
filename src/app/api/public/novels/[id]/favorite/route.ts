import { db } from '@/lib/db';
import { NextResponse } from 'next/server';
import { withPublicRateLimit } from '@/lib/api-auth';

/**
 * Toggle novel favorite (no auth required).
 * Rate limited: 10 burst, 0.2/sec (5/min) per IP.
 * Uses localStorage-based tracking on client; this endpoint
 * increments/decrements the server-side favoriteCount.
 * POST /api/public/novels/[id]/favorite?action=toggle|add|remove
 */
export const POST = withPublicRateLimit({ capacity: 10, refillRate: 0.2 }, async (
  request,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || 'toggle';

  // For remove: prevent favoriteCount going negative
  if (action === 'remove') {
    const current = await db.novel.findUnique({
      where: { id },
      select: { favoriteCount: true },
    });
    if (!current) {
      return NextResponse.json({ error: '小说不存在' }, { status: 404 });
    }
    if (current.favoriteCount <= 0) {
      return NextResponse.json({ favoriteCount: 0 });
    }
    const updated = await db.novel.update({
      where: { id },
      data: { favoriteCount: { decrement: 1 } },
      select: { favoriteCount: true },
    });
    return NextResponse.json({ favoriteCount: updated.favoriteCount });
  }

  // For add/toggle: atomic increment
  try {
    const updated = await db.novel.update({
      where: { id },
      data: { favoriteCount: { increment: 1 } },
      select: { favoriteCount: true },
    });
    return NextResponse.json({ favoriteCount: updated.favoriteCount });
  } catch {
    return NextResponse.json({ error: '小说不存在' }, { status: 404 });
  }
});
