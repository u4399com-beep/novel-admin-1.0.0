import { db } from '@/lib/db';
import { withAuth } from '@/lib/api-auth';
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-utils';

/**
 * Export all system data as JSON (admin only).
 * GET /api/admin/export-all?format=json
 *
 * Uses streaming approach: fetches novels without chapter content first,
 * then adds chapter content per-novel in batches to limit memory.
 * Falls back to full-load for small datasets.
 */
export const GET = withAuth(async function GET(request: NextRequest) {
  try {
    const format = new URL(request.url).searchParams.get('format') || 'json';
    if (format !== 'json') {
      return apiError('仅支持 json 格式', 400);
    }

    // Pre-check: estimate data size
    const novelCount = await db.novel.count();
    const totalChapters = await db.chapter.count();

    // For small datasets (< 5000 chapters), use the fast single-query path
    if (totalChapters <= 5000) {
      return exportSmallDataset(novelCount, totalChapters);
    }

    // For large datasets: fetch novels without content, then stream per-novel
    return exportLargeDataset(novelCount, totalChapters);
  } catch (error) {
    console.error('Export all data error:', error);
    return apiError('导出数据失败', 500);
  }
});

async function exportSmallDataset(novelCount: number, totalChapters: number) {
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

  const novelsExport = novels.map(({ tags, ...rest }) => ({
    ...rest,
    tags: tags.map((t) => t.tag),
  }));

  const exportData = {
    version: 1,
    exportedAt: new Date().toISOString(),
    counts: {
      novels: novels.length,
      chapters: totalChapters,
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
}

async function exportLargeDataset(novelCount: number, totalChapters: number) {
  // Hard limit: reject extremely large exports
  if (totalChapters > 50000) {
    return apiError(
      `数据量过大（${novelCount}本小说，${totalChapters}个章节），请分批导出或使用单本导出`,
      413
    );
  }

  // Fetch novels without chapter content (metadata only)
  const novelsWithoutContent = await db.novel.findMany({
    include: {
      category: { select: { id: true, name: true, slug: true, color: true, icon: true } },
      tags: { include: { tag: { select: { id: true, name: true, color: true } } } },
      _count: { select: { chapters: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  // Fetch metadata tables in parallel
  const [categories, tags, sites, scrapeRules, siteSettings] = await Promise.all([
    db.category.findMany({ orderBy: { name: 'asc' } }),
    db.tag.findMany({ orderBy: { name: 'asc' } }),
    db.site.findMany({ orderBy: { name: 'asc' } }),
    db.scrapeRule.findMany({ orderBy: { createdAt: 'desc' } }),
    db.siteSetting.findMany(),
  ]);

  // Process novels in batches of 20 to limit memory usage
  const BATCH_SIZE = 20;
  const novelsExport: unknown[] = [];

  for (let i = 0; i < novelsWithoutContent.length; i += BATCH_SIZE) {
    const batch = novelsWithoutContent.slice(i, i + BATCH_SIZE);
    const batchIds = batch.map(n => n.id);

    // Fetch only chapter content for this batch
    const chapters = await db.chapter.findMany({
      where: { novelId: { in: batchIds } },
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true, title: true, content: true, sortOrder: true,
        wordCount: true, sourceUrl: true, createdAt: true, updatedAt: true,
        novelId: true,
      },
    });

    // Group chapters by novelId
    const chaptersByNovel = new Map<string, typeof chapters>();
    for (const ch of chapters) {
      const list = chaptersByNovel.get(ch.novelId) || [];
      list.push(ch);
      chaptersByNovel.set(ch.novelId, list);
    }

    // Merge chapter content into novel data
    for (const novel of batch) {
      const { _count, tags, ...novelData } = novel;
      const novelChapters = chaptersByNovel.get(novel.id) || [];
      novelsExport.push({
        ...novelData,
        tags: tags.map(t => t.tag),
        chapters: novelChapters,
      });
    }
  }

  const exportData = {
    version: 1,
    exportedAt: new Date().toISOString(),
    counts: {
      novels: novelsExport.length,
      chapters: totalChapters,
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
}