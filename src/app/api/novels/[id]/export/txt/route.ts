import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { apiError } from '@/lib/api-utils';

// UTF-8 BOM for better Chinese text compatibility in Windows Notepad
const UTF8_BOM = '\uFEFF';

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
    console.error('TXT export DB error:', error);
    return apiError('查询小说失败');
  }

  if (!novel || novel.chapters.length === 0) return apiError('小说不存在或无章节', 404);

  const SEPARATOR = '='.repeat(40);
  const THIN_SEPARATOR = '-'.repeat(40);

  // Build table of contents
  const tocLines = novel.chapters.map(
    (ch, idx) => `${String(idx + 1).padStart(4)}. ${ch.title}`
  );
  const tocSection = [
    `\n${SEPARATOR}\n`,
    '目  录',
    `${SEPARATOR}\n`,
    ...tocLines,
    '\n',
  ].join('\n');

  // Build chapter content with separators
  const chaptersText = novel.chapters
    .map(
      (ch) =>
        `\n${THIN_SEPARATOR}\n${ch.title}\n${THIN_SEPARATOR}\n\n${ch.content || ''}`
    )
    .join('\n');

  // Assemble full document
  const header = [
    '书名：' + novel.title,
    '作者：' + novel.author,
    '总字数：' + String(novel.wordCount),
    '章节数：' + String(novel.chapters.length),
    '状态：' + novel.status,
    '导出时间：' + new Date().toLocaleString('zh-CN'),
    SEPARATOR,
  ].join('\n');

  const fullText = header + tocSection + chaptersText;

  return new NextResponse(UTF8_BOM + fullText, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${novel.title}_全本.txt`)}`,
    },
  });
});
