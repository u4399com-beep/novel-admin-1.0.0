import { db } from '@/lib/db';
import { NextResponse } from 'next/server';
import { withPublicRateLimit } from '@/lib/api-auth';
import { isPrismaError } from '@/lib/api-utils';

/**
 * Increment novel click count (no auth required).
 * Rate limited: 10 burst, 0.2/sec (5/min) per IP.
 * POST /api/public/novels/[id]/click
 */
export const POST = withPublicRateLimit({ capacity: 10, refillRate: 0.2 }, async (
  _request,
  { params }: { params: Promise<{ id: string }> },
) => {
  try {
    const { id } = await params;
    try {
      const updated = await db.novel.update({
        where: { id },
        data: { clickCount: { increment: 1 } },
        select: { clickCount: true },
      });
      return NextResponse.json({ clickCount: updated.clickCount });
    } catch (error) {
      if (isPrismaError(error, 'P2025')) {
        return NextResponse.json({ error: '小说不存在' }, { status: 404 });
      }
      throw error;
    }
  } catch (error) {
    console.error('Click tracking error:', error);
    return NextResponse.json({ error: '操作失败' }, { status: 500 });
  }
});
