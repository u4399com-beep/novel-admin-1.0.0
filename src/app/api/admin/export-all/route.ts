import { db } from '@/lib/db';
import { withAuth } from '@/lib/api-auth';
import { NextRequest, NextResponse } from 'next/server';

/**
 * Export all system data as JSON (admin only).
 * GET /api/admin/export-all?format=json
 *
 * Exports: novels (with chapters, category, tags), categories, tags, sites, scrape rules,
 * reading progress, site settings.
 */
export const GET = withAuth(async function GET(request: NextRequest) {
  try {
    const format = new URL(request.url).searchParams.get('format') || 'json';
    if (format !== 'json') {
      return NextResponse.json({ error: '仅支持 json 格式' }, { status: 400 });
    }

    // Parallel fetch all data
    const [
      novels,
      categories,
      tags,
      sites,
      scrapeRules,
      siteSettings,
    ] = await Promise.all([
      // Novels with chapters (content included for full backup)
      db.novel.findMany({
        include: {
          category: { select: { id: true, name: true, slug: true, color: true, icon: true } },
          tags: { include: { tag: { select: { id: true, name: true, color: true } } } },
          chapters: {
            orderBy: { sortOrder: 'asc' },
            select: {
              id: true, title: true, content: true, sortOrder: true,
              wordCount: true, sourceUrl: true, createdAt: true, updatedAt: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      db.category.findMany({ orderBy: { name: 'asc' } }),
      db.tag.findMany({ orderBy: { name: 'asc' } }),
      db.site.findMany({ orderBy: { name: 'asc' } }),
      db.scrapeRule.findMany({ orderBy: { createdAt: 'desc' } }),
      db.siteSetting.findMany(),
    ]);

    // Transform novels: flatten tags
    const novelsExport = novels.map(({ tags, ...rest }) => ({
      ...rest,
      tags: tags.map((t) => t.tag),
    }));

    const exportData = {
      version: 1,
      exportedAt: new Date().toISOString(),
      counts: {
        novels: novels.length,
        chapters: novels.reduce((sum, n) => sum + n.chapters.length, 0),
        categories: categories.length,
        tags: tags.length,
        sites: sites.length,
        scrapeRules: scrapeRules.length,
        siteSettings: siteSettings.length,
      },
      data: {
        novels: novelsExport,
        categories,
        tags,
        sites,
        scrapeRules,
        siteSettings,
      },
    };

    return new NextResponse(JSON.stringify(exportData, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="novel-export-${new Date().toISOString().slice(0, 10)}.json"`,
      },
    });
  } catch (error) {
    console.error('Export all data error:', error);
    return NextResponse.json({ error: '导出数据失败' }, { status: 500 });
  }
});
