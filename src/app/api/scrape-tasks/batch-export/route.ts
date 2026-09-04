import { db } from '@/lib/db';
import { apiError, safeJson } from '@/lib/api-utils';
import { withAuth } from '@/lib/api-auth';
import { NextRequest, NextResponse } from 'next/server';

// POST /api/scrape-tasks/batch-export
// Body: { taskIds: string[], format: 'csv' | 'json' }
export const POST = withAuth(async function POST(request: NextRequest) {
  try {
    let body: { taskIds?: unknown; format?: unknown };
    try {
      body = await safeJson(request);
    } catch {
      return apiError('请求数据格式错误', 400);
    }

    const { taskIds, format: rawFormat } = body;
    const format = rawFormat === 'csv' ? 'csv' : 'json';

    // Validate taskIds
    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      return apiError('taskIds 必须为非空数组', 400);
    }

    if (taskIds.length > 20) {
      return apiError('单次最多导出20条任务', 400);
    }

    const validIds = taskIds.filter(
      (id): id is string => typeof id === 'string' && id.trim().length > 0
    );

    if (validIds.length === 0) {
      return apiError('未提供有效的任务ID', 400);
    }

    // Fetch all tasks
    const tasks = await db.scrapeTask.findMany({
      where: { id: { in: validIds } },
      include: {
        rule: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (tasks.length === 0) {
      return apiError('未找到有效的采集任务', 404);
    }

    // Collect all novels across all tasks
    // For each task, find novels linked to its rule within the task's time window
    const allNovelData: Array<{
      taskId: string;
      taskRuleName: string;
      taskStatus: string;
      title: string;
      author: string;
      categoryName: string;
      status: string;
      sourceUrl: string;
      chapterCount: number;
      latestChapter: string;
      wordCount: number;
      createdAt: Date;
    }> = [];

    for (const task of tasks) {
      const timeStart = task.startedAt || task.createdAt;
      const timeEnd = task.completedAt || new Date();

      const novels = await db.novel.findMany({
        where: {
          sourceId: task.ruleId,
          createdAt: { gte: timeStart, lte: timeEnd },
        },
        include: {
          category: { select: { name: true } },
          _count: { select: { chapters: true } },
        },
        orderBy: { createdAt: 'desc' },
      });

      // Find latest chapter titles for these novels
      const novelIds = novels.map((n) => n.id);
      let latestChapters: Record<string, string> = {};
      if (novelIds.length > 0) {
        const latestChapterRows = await db.chapter.findMany({
          where: { novelId: { in: novelIds } },
          orderBy: [{ novelId: 'asc' }, { sortOrder: 'desc' }],
          select: { novelId: true, title: true },
          distinct: ['novelId'],
        });
        for (const ch of latestChapterRows) {
          if (!latestChapters[ch.novelId]) {
            latestChapters[ch.novelId] = ch.title;
          }
        }
      }

      for (const n of novels) {
        allNovelData.push({
          taskId: task.id,
          taskRuleName: task.rule.name,
          taskStatus: task.status,
          title: n.title,
          author: n.author,
          categoryName: n.category?.name ?? '',
          status: n.status,
          sourceUrl: n.sourceUrl ?? '',
          chapterCount: n._count.chapters,
          latestChapter: latestChapters[n.id] ?? '',
          wordCount: n.wordCount,
          createdAt: n.createdAt,
        });
      }
    }

    if (format === 'json') {
      const jsonData = {
        tasks: tasks.map((task) => {
          const taskNovels = allNovelData.filter((n) => n.taskId === task.id);
          return {
            task: {
              id: task.id,
              ruleName: task.rule.name,
              status: task.status,
              mode: task.mode,
              totalBooks: task.totalBooks,
              totalChapters: task.totalChapters,
              newBooks: task.newBooks,
              newChapters: task.newChapters,
              failedItems: task.failedItems,
              skippedItems: task.skippedItems,
              progress: task.progress,
              startedAt: task.startedAt?.toISOString() ?? null,
              completedAt: task.completedAt?.toISOString() ?? null,
              createdAt: task.createdAt.toISOString(),
            },
            novels: taskNovels.map((n) => ({
              书名: n.title,
              作者: n.author,
              分类: n.categoryName,
              状态: n.status === 'completed' ? '完结' : n.status === 'ongoing' ? '连载中' : n.status === 'hiatus' ? '暂停' : n.status,
              来源URL: n.sourceUrl,
              章节数: n.chapterCount,
              最新章节: n.latestChapter,
              总字数: n.wordCount,
              采集时间: n.createdAt.toISOString(),
            })),
          };
        }),
      };

      const filename = `batch-export-${Date.now()}.json`;
      return new NextResponse(JSON.stringify(jsonData, null, 2), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      });
    }

    // CSV format with additional 任务ID column
    const BOM = '\uFEFF';
    const header = '任务ID,书名,作者,分类,状态,来源URL,章节数,最新章节,总字数,采集时间';

    const csvRows = allNovelData.map((n) => {
      const statusLabel = n.status === 'completed' ? '完结' : n.status === 'ongoing' ? '连载中' : n.status === 'hiatus' ? '暂停' : n.status;
      return [
        csvEscape(n.taskId),
        csvEscape(n.title),
        csvEscape(n.author),
        csvEscape(n.categoryName),
        csvEscape(statusLabel),
        csvEscape(n.sourceUrl),
        String(n.chapterCount),
        csvEscape(n.latestChapter),
        String(n.wordCount),
        csvEscape(n.createdAt.toISOString()),
      ].join(',');
    });

    const csv = BOM + header + '\n' + csvRows.join('\n');
    const filename = `batch-export-${Date.now()}.csv`;

    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    console.error('Batch export scrape tasks error:', error);
    return apiError('批量导出采集任务数据失败', 500);
  }
});

/** Escape a CSV field: wrap in quotes if it contains comma, quote, or newline */
function csvEscape(value: string): string {
  if (!value) return '';
  if (/[",\n\r]/.test(value)) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}
