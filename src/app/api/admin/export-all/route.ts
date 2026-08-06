import { db } from '@/lib/db';
import { withAuth } from '@/lib/api-auth';
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from "@/lib/api-utils"

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
      return apiError('仅支持 json 格式', 400);
    }

    // Pre-check: estimate total data size to prevent OOM
    const novelCount = await db.novel.count();
    const totalChapters = await db.chapter.count();
    // Rough estimate: ~5KB avg per chapter content; reject if >100MB
    if (totalChapters > 20000) {
      return NextResponse.json({
        error: `数据量过大（${novelCount}本小说，${totalChapters}个章节），请分批导出或使用单本导出`,
      }, { status: 413 });
    }

    // Fetch novels with chapters content, then other data in parallel
    const novels = await db.novel.findMany({
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
    });
    const [categories, tags, sites, scrapeRules, siteSettings] = await Promise.all([
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
    return apiError('导出数据失败', 500);
  }
});
