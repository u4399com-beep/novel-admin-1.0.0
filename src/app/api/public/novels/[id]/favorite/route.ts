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

    const novel = await db.novel.findUnique({
      where: { id },
      select: { id: true, favoriteCount: true },
    });

    if (!novel) {
      return NextResponse.json({ error: '小说不存在' }, { status: 404 });
    }

    let newCount = novel.favoriteCount;
    if (action === 'add') {
      newCount += 1;
    } else if (action === 'remove') {
      newCount = Math.max(0, newCount - 1);
    } else {
      // toggle: client decides, but we just increment for simplicity
      newCount += 1;
    }

    await db.novel.update({
      where: { id },
      data: { favoriteCount: newCount },
    });

    return NextResponse.json({ favoriteCount: newCount });
  } catch (error) {
    console.error('Favorite API error:', error);
    return NextResponse.json(
      { error: '操作失败' },
      { status: 500 },
    );
  }
}
