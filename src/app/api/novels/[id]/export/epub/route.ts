import { db } from '@/lib/db';
import { withAuth } from '@/lib/api-auth';
import { NextRequest, NextResponse } from 'next/server';
import { notFound } from 'next/navigation';

export const GET = withAuth(async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const novel = await db.novel.findUnique({
    where: { id },
    include: {
      chapters: {
        orderBy: { sortOrder: 'asc' },
        select: { title: true, content: true, sortOrder: true },
      },
    },
  });

  if (!novel || novel.chapters.length === 0) return notFound();

  // 简化版EPUB：返回包含所有章节的TXT
  // 完整EPUB需要JSZip库，这里先返回合并TXT
  const fullText = novel.chapters
    .map((ch) => `\n${'='.repeat(40)}\n${ch.title}\n${'='.repeat(40)}\n\n${ch.content || ''}`)
    .join('\n');

  const header = `书名：${novel.title}\n作者：${novel.author}\n总字数：${novel.wordCount}\n状态：${novel.status}\n导出时间：${new Date().toLocaleString('zh-CN')}\n${'='.repeat(40)}\n`;

  return new Response(header + fullText, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${novel.title}_全本.txt`)}`,
    },
  });
});
