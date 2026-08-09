import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { apiError } from '@/lib/api-utils';

export const GET = withAuth(async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let novel;
  try {
    novel = await db.novel.findUnique({
      where: { id },
      include: {
        chapters: {
          orderBy: { sortOrder: 'asc' },
          select: { title: true, content: true, sortOrder: true },
        },
      },
    });
  } catch (error) {
    console.error('EPUB export DB error:', error);
    return apiError('查询小说失败');
  }

  if (!novel || novel.chapters.length === 0) return apiError('小说不存在或无章节', 404);

  // 简化版EPUB：返回包含所有章节的TXT
  // 完整EPUB需要JSZip库，这里先返回合并TXT
  const fullText = novel.chapters
    .map((ch) => `\n${'='.repeat(40)}\n${ch.title}\n${'='.repeat(40)}\n\n${ch.content || ''}`)
    .join('\n');

  const header = `书名：${novel.title}\n作者：${novel.author}\n总字数：${novel.wordCount}\n状态：${novel.status}\n导出时间：${new Date().toLocaleString('zh-CN')}\n${'='.repeat(40)}\n`;

  return new NextResponse(header + fullText, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${novel.title}_全本.txt`)}`,
    },
  });
});
