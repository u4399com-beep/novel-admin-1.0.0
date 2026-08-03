import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { sanitizeField } from '@/lib/api-utils';
import { invalidateCache } from '@/lib/cache';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

interface ImportChapter {
  title: string;
  content: string;
}

interface ImportJson {
  title?: string;
  author?: string;
  description?: string;
  categoryId?: string;
  status?: string;
  chapters?: ImportChapter[];
}

/**
 * POST /api/novels/import
 * Upload a TXT or JSON file to create a novel with chapters.
 * Accepts multipart/form-data with a 'file' field.
 */
export const POST = withAuth({ maxBodySize: MAX_FILE_SIZE }, async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const categoryId = formData.get('categoryId') as string | null;
    const status = (formData.get('status') as string) || 'ongoing';
    const format = (formData.get('format') as string) || 'auto';

    if (!file) {
      return NextResponse.json({ error: '请选择要导入的文件' }, { status: 400 });
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: `文件大小超过限制(最大${MAX_FILE_SIZE / 1024 / 1024}MB)` }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    let text: string;

    try {
      // Try UTF-8 first, fallback to GBK for Chinese novels
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      try {
        text = new TextDecoder('gbk', { fatal: false }).decode(buffer);
      } catch {
        return NextResponse.json({ error: '无法解码文件内容，请确保文件为UTF-8或GBK编码' }, { status: 400 });
      }
    }

    // Determine format
    const isJson = format === 'json' || (format === 'auto' && (file.name.endsWith('.json') || text.trimStart().startsWith('{')));
    const isTxt = !isJson;

    let novelTitle = '';
    let novelAuthor = '佚名';
    let novelDescription: string | undefined;
    let chapters: ImportChapter[] = [];

    if (isJson) {
      const json: ImportJson = JSON.parse(text);
      novelTitle = sanitizeField(json.title || file.name.replace(/\.(json|txt)$/i, ''), 200);
      novelAuthor = sanitizeField(json.author || '佚名', 100);
      novelDescription = json.description ? sanitizeField(json.description, 5000) : undefined;
      chapters = (json.chapters || []).map((ch, i) => ({
        title: sanitizeField(ch.title || `第${i + 1}章`, 200),
        content: ch.content ? sanitizeField(ch.content, 500000) : '',
      }));
    } else {
      // TXT: use filename as title, split by chapter markers
      novelTitle = sanitizeField(file.name.replace(/\.(txt|json)$/i, ''), 200);
      novelDescription = undefined;
      chapters = parseTxtChapters(text);
    }

    if (!novelTitle) {
      return NextResponse.json({ error: '无法提取小说标题，请使用JSON格式或在文件名中指定' }, { status: 400 });
    }

    if (chapters.length === 0) {
      return NextResponse.json({ error: '未找到任何章节内容' }, { status: 400 });
    }

    if (chapters.length > 10000) {
      return NextResponse.json({ error: `章节数量(${chapters.length})超过限制(最多10000章)` }, { status: 400 });
    }

    // Validate categoryId if provided
    if (categoryId) {
      const cat = await db.category.findUnique({ where: { id: categoryId }, select: { id: true } });
      if (!cat) {
        return NextResponse.json({ error: '指定分类不存在' }, { status: 400 });
      }
    }

    // Validate status
    const validStatuses = ['ongoing', 'completed', 'hiatus'];
    const finalStatus = validStatuses.includes(status) ? status : 'ongoing';

    // Create novel + chapters in transaction
    const novel = await db.$transaction(async (tx) => {
      const totalWords = chapters.reduce((sum, ch) => sum + ch.content.length, 0);

      const created = await tx.novel.create({
        data: {
          title: novelTitle,
          author: novelAuthor,
          description: novelDescription,
          status: finalStatus,
          wordCount: totalWords,
          ...(categoryId ? { categoryId } : {}),
          chapters: {
            create: chapters.map((ch, idx) => ({
              title: ch.title,
              content: ch.content,
              wordCount: ch.content.length,
              sortOrder: idx + 1,
            })),
          },
        },
        include: { _count: { select: { chapters: true } } },
      });

      return created;
    }, { timeout: 60000 }); // 60s timeout for large imports

    invalidateCache('dashboard:stats');
    invalidateCache('dashboard:activity');

    return NextResponse.json({
      success: true,
      novel: {
        id: novel.id,
        title: novel.title,
        author: novel.author,
        chapterCount: novel._count.chapters,
        wordCount: novel.wordCount,
      },
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: 'JSON格式错误，请检查文件内容' }, { status: 400 });
    }
    console.error('Import novel error:', error);
    return NextResponse.json({ error: '导入失败' }, { status: 500 });
  }
});

/**
 * Parse TXT content into chapters by detecting common chapter markers.
 * Supports patterns like: 第X章, 第X回, Chapter X, 卷X, etc.
 */
function parseTxtChapters(text: string): ImportChapter[] {
  // Common chapter marker patterns (Chinese + English)
  const chapterPattern = /^(\s*(?:第[零一二三四五六七八九十百千万\d]+[章节回卷集部篇]|Chapter\s+\d+|CHAPTER\s+\d+|卷[零一二三四五六七八九十百千万\d]+|\d+\.|\d+、)\s*.+)/m;

  const lines = text.split('\n');
  const chapterStarts: { index: number; title: string }[] = [];

  // Find all chapter start positions
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(chapterPattern);
    if (match) {
      chapterStarts.push({ index: i, title: match[1].trim() });
    }
  }

  // If no chapter markers found, treat entire file as single chapter
  if (chapterStarts.length === 0) {
    return [{ title: '正文', content: text.trim() }];
  }

  const chapters: ImportChapter[] = [];

  for (let i = 0; i < chapterStarts.length; i++) {
    const startLine = chapterStarts[i].index;
    const endLine = i + 1 < chapterStarts.length ? chapterStarts[i + 1].index : lines.length;

    const content = lines.slice(startLine + 1, endLine).join('\n').trim();
    chapters.push({
      title: chapterStarts[i].title,
      content,
    });
  }

  return chapters;
}
