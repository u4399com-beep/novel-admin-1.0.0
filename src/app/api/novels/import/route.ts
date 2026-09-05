import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { sanitizeField, apiError, countWords, validateJsonStructure } from "@/lib/api-utils";
import { invalidateCache } from '@/lib/cache';
import { VALID_NOVEL_STATUSES } from '@/lib/constants';

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
      return apiError('请选择要导入的文件', 400);
    }

    // Validate file extension whitelist
    const fileName = file.name.toLowerCase();
    if (!/\.(txt|json)$/.test(fileName)) {
      return apiError('仅支持 .txt 和 .json 格式的文件', 400);
    }

    // Validate format parameter
    const VALID_FORMATS = ['auto', 'json', 'txt'];
    if (format && !VALID_FORMATS.includes(format)) {
      return apiError('无效的 format 参数，允许值: auto, json, txt', 400);
    }

    if (file.size > MAX_FILE_SIZE) {
      return apiError(`文件大小超过限制(最大${MAX_FILE_SIZE / 1024 / 1024}MB)`, 400);
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
        return apiError('无法解码文件内容，请确保文件为UTF-8或GBK编码', 400);
      }
    }

    // Determine format
    const isJson = format === 'json' || (format === 'auto' && (file.name.endsWith('.json') || text.trimStart().startsWith('{')));

    let novelTitle = '';
    let novelAuthor = '佚名';
    let novelDescription: string | undefined;
    let chapters: ImportChapter[] = [];

    if (isJson) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return apiError('JSON格式错误，请检查文件内容', 400);
      }
      // Validate depth and key count to prevent stack overflow from deeply nested JSON
      try {
        validateJsonStructure(parsed, 0, 10, 1000);
      } catch (e) {
        return apiError(e instanceof Error ? e.message : 'JSON结构无效', 400);
      }
      const json = parsed as ImportJson;
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
      // Sanitize TXT chapter content (same limits as JSON path)
      chapters = parseTxtChapters(text).map((ch, i) => ({
        title: sanitizeField(ch.title || `第${i + 1}章`, 200),
        content: ch.content ? sanitizeField(ch.content, 500000) : '',
      }));
    }

    if (!novelTitle) {
      return apiError('无法提取小说标题，请使用JSON格式或在文件名中指定', 400);
    }

    if (chapters.length === 0) {
      return apiError('未找到任何章节内容', 400);
    }

    if (chapters.length > 10000) {
      return apiError(`章节数量(${chapters.length})超过限制(最多10000章)`, 400);
    }

    // Limit total content size to prevent OOM / transaction timeout
    // 50MB raw file → after sanitization, cap total at 25M chars (~50MB UTF-16)
    const MAX_TOTAL_CONTENT_CHARS = 25_000_000;
    const totalContentChars = chapters.reduce((sum, ch) => sum + ch.content.length, 0);
    if (totalContentChars > MAX_TOTAL_CONTENT_CHARS) {
      return apiError(`总内容过大(${Math.round(totalContentChars / 1_000_000)}MB)，超过限制(最大25MB)`, 400);
    }

    // Validate categoryId if provided
    if (categoryId) {
      const cat = await db.category.findUnique({ where: { id: categoryId }, select: { id: true } });
      if (!cat) {
        return apiError('指定分类不存在', 400);
      }
    }

    // Validate status
    const finalStatus = VALID_NOVEL_STATUSES.includes(status) ? status : 'ongoing';

    // Create novel + chapters in transaction
    const novel = await db.$transaction(async (tx) => {
      const totalWords = chapters.reduce((sum, ch) => sum + countWords(ch.content), 0);

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
              wordCount: countWords(ch.content),
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
      return apiError('JSON格式错误，请检查文件内容', 400);
    }
    console.error('Import novel error:', error);
    return apiError('导入失败', 500);
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
