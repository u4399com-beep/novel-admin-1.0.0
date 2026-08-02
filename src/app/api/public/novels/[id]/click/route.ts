import { db } from '@/lib/db';
import { NextResponse } from 'next/server';

/**
 * Increment novel click count (no auth required).
 * POST /api/public/novels/[id]/click
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const novel = await db.novel.findUnique({
      where: { id },
      select: { id: true, clickCount: true },
    });

    if (!novel) {
      return NextResponse.json({ error: '小说不存在' }, { status: 404 });
    }

    await db.novel.update({
      where: { id },
      data: { clickCount: { increment: 1 } },
    });

    return NextResponse.json({
      clickCount: novel.clickCount + 1,
    });
  } catch (error) {
    console.error('Click count API error:', error);
    return NextResponse.json(
      { error: '操作失败' },
      { status: 500 },
    );
  }
}
