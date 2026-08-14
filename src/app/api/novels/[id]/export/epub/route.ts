import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { apiError } from '@/lib/api-utils';
import JSZip from 'jszip';

// EPUB 3.0 uses XHTML content
const MAX_EXPORT_CHAPTERS = 5000;
const MAX_EXPORT_CHARS = 20_000_000;

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function textToHtmlParagraphs(text: string): string {
  if (!text) return '<p>（无内容）</p>';
  // Split by double newlines or single newlines
  const lines = text.split(/\n+/);
  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return '';
      return `<p>${escapeHtml(trimmed)}</p>`;
    })
    .filter(Boolean)
    .join('\n    ');
}

function generateUUID(): string {
  // Simple UUID v4-like for EPUB identifiers
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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
        category: { select: { name: true } },
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

  if (!novel) return apiError('小说不存在', 404);
  if (novel.chapters.length === 0) return apiError('该小说暂无章节', 422);

  const chapterCount = novel.chapters.length;
  if (chapterCount > MAX_EXPORT_CHAPTERS) {
    return apiError(
      `章节数量(${chapterCount})超过导出上限(${MAX_EXPORT_CHAPTERS})，请分批导出`,
      400
    );
  }

  // Enforce total content size limit to prevent OOM
  const totalChars = novel.chapters.reduce((s, ch) => s + (ch.content?.length ?? 0), 0);
  if (totalChars > MAX_EXPORT_CHARS) {
    return apiError(
      `小说总字数(${totalChars.toLocaleString()})过大，超过导出上限(${(MAX_EXPORT_CHARS / 10000).toFixed(0)}万字)`,
      400
    );
  }

  const bookId = generateUUID();
  const safeTitle = novel.title.replace(/[\\/:*?"<>|]/g, '_');
  const author = novel.author || '未知';
  const dateNow = new Date().toISOString().split('T')[0];

  try {
    const zip = new JSZip();

    // ── mimetype (must be first, uncompressed) ──
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

    // ── META-INF/container.xml ──
    zip.file(
      'META-INF/container.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
    );

    // ── OEBPS/content.opf (package document) ──
    const manifestItems = [
      `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
      `<item id="css" href="style.css" media-type="text/css"/>`,
    ];
    const spineItems = [`<itemref idref="nav"/>`];

    for (let i = 0; i < chapterCount; i++) {
      const chId = `ch${i + 1}`;
      manifestItems.push(
        `<item id="${chId}" href="chapter_${i + 1}.xhtml" media-type="application/xhtml+xml"/>`
      );
      spineItems.push(`<itemref idref="${chId}"/>`);
    }

    const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="BookId">urn:uuid:${bookId}</dc:identifier>
    <dc:title>${escapeXml(novel.title)}</dc:title>
    <dc:language>zh-CN</dc:language>
    <dc:creator>${escapeXml(author)}</dc:creator>
    <dc:date>${dateNow}</dc:date>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.[0-9]+Z$/, 'Z')}</meta>
  </metadata>
  <manifest>
    ${manifestItems.join('\n    ')}
  </manifest>
  <spine>
    ${spineItems.join('\n    ')}
  </spine>
</package>`;
    zip.file('OEBPS/content.opf', contentOpf);

    // ── OEBPS/style.css ──
    zip.file(
      'OEBPS/style.css',
      `/* Novel Reader EPUB Styles */
body {
  font-family: "Noto Serif SC", "Source Han Serif SC", "SimSun", serif;
  line-height: 1.8;
  margin: 1em;
  font-size: 1.1em;
  color: #1a1a1a;
}

h1 {
  font-size: 1.4em;
  text-align: center;
  margin-bottom: 1.5em;
  page-break-before: always;
  color: #333;
}

h1:first-of-type {
  page-break-before: avoid;
}

p {
  text-indent: 2em;
  margin: 0.3em 0;
}

nav ol {
  list-style: none;
  padding: 0;
}

nav ol li a {
  text-decoration: none;
  color: #333;
  display: block;
  padding: 0.3em 0;
  border-bottom: 1px solid #eee;
}

nav h1 {
  text-align: left;
  margin-bottom: 1em;
  page-break-before: avoid;
}
`
    );

    // ── OEBPS/nav.xhtml (Table of Contents) ──
    const tocItems = novel.chapters
      .map(
        (ch, i) =>
          `      <li><a href="chapter_${i + 1}.xhtml">${escapeHtml(ch.title)}</a></li>`
      )
      .join('\n');

    zip.file(
      'OEBPS/nav.xhtml',
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>目录 - ${escapeXml(novel.title)}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>目录</h1>
    <ol>
${tocItems}
    </ol>
  </nav>
</body>
</html>`
    );

    // ── OEBPS/chapter_N.xhtml ──
    for (let i = 0; i < chapterCount; i++) {
      const ch = novel.chapters[i];
      const content = textToHtmlParagraphs(ch.content || '');
      const chapterHtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>${escapeXml(ch.title)} - ${escapeXml(novel.title)}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
  <h1>${escapeHtml(ch.title)}</h1>
  ${content}
</body>
</html>`;
      zip.file(`OEBPS/chapter_${i + 1}.xhtml`, chapterHtml);
    }

    // ── Generate ZIP buffer ──
    const buffer = await zip.generateAsync({
      type: 'arraybuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    return new NextResponse(buffer, {
      headers: {
        'Content-Type': 'application/epub+zip',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${safeTitle}.epub`)}`,
        'Content-Length': String(buffer.byteLength),
      },
    });
  } catch (error) {
    console.error('EPUB generation error:', error);
    return apiError('EPUB 生成失败');
  }
});
