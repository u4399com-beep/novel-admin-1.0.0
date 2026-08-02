import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';

/**
 * Toggle novel favorite (no auth required).
 * Uses localStorage-based tracking on client; this endpoint
 * increments/decrements the server-side favoriteCount.
 * POST /api/public/novels/[id]/favorite?action=toggle|add|remove
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action') || 'toggle';

    // Atomic increment/decrement — no read-then-write race condition
    const increment = (action === 'remove') ? -1 : 1;

    let updated;
    try {
      updated = await db.novel.update({
        where: { id },
        data: { favoriteCount: { increment } },
        select: { favoriteCount: true },
      });
    } catch {
      // RecordNotFound error when novel doesn't exist
      return NextResponse.json({ error: '小说不存在' }, { status: 404 });
    }

    return NextResponse.json({ favoriteCount: updated.favoriteCount });
  } catch (error) {
    console.error('Favorite API error:', error);
    return NextResponse.json(
      { error: '操作失败' },
      { status: 500 },
    );
  }
}
