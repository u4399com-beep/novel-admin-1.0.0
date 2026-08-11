import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { apiError } from '@/lib/api-utils';

// UTF-8 BOM for better Chinese text compatibility in Windows Notepad
const UTF8_BOM = '\uFEFF';
// Maximum export size: ~10MB to prevent OOM
const MAX_EXPORT_SIZE = 10 * 1024 * 1024;

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

  if (!novel) return apiError('小说不存在', 404);
  if (novel.chapters.length === 0) return apiError('该小说暂无章节', 422);

  const SEPARATOR = '='.repeat(40);
  const THIN_SEPARATOR = '-'.repeat(40);

  // Null-safe field display
  const author = novel.author || '未知';
  const status = novel.status || '未知';

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

  // Build header with null-safe values
  const header = [
    `书名：${novel.title}`,
    `作者：${author}`,
    `总字数：${String(novel.wordCount)}`,
    `章节数：${String(novel.chapters.length)}`,
    `状态：${status}`,
    `导出时间：${new Date().toLocaleString('zh-CN')}`,
    SEPARATOR,
  ].join('\n');

  // Build chapter content incrementally and check size limit
  const chapterTexts: string[] = [];
  let totalSize = header.length + tocSection.length;

  for (const ch of novel.chapters) {
    const chapterText = `\n${THIN_SEPARATOR}\n${ch.title}\n${THIN_SEPARATOR}\n\n${ch.content || ''}`;
    totalSize += chapterText.length + 1; // +1 for join newline
    if (totalSize > MAX_EXPORT_SIZE) {
      chapterTexts.push('\n[...内容过大，已截断导出...]\n');
      break;
    }
    chapterTexts.push(chapterText);
  }

  const fullText = header + tocSection + chapterTexts.join('\n');

  return new NextResponse(UTF8_BOM + fullText, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${novel.title}_全本.txt`)}`,
    },
  });
});
