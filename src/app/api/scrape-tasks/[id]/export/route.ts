import { db } from '@/lib/db';
import { apiError } from '@/lib/api-utils';
import { withAuth } from '@/lib/api-auth';
import { NextRequest, NextResponse } from 'next/server';

// GET /api/scrape-tasks/[id]/export?format=csv|json
export const GET = withAuth(async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const format = searchParams.get('format') || 'json';

    if (format !== 'csv' && format !== 'json') {
      return apiError('format 参数只支持 csv 或 json', 400);
    }

    // Fetch the task with rule info
    const task = await db.scrapeTask.findUnique({
      where: { id },
      include: {
        rule: { select: { id: true, name: true } },
      },
    });

    if (!task) {
      return apiError('采集任务不存在', 404);
    }

    // Find novels linked to this task's rule, created within the task's time window
    // The task's ruleId matches Novel.sourceId (采集规则ID)
    // We look for novels created between the task's startedAt (or createdAt) and completedAt (or now)
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

    if (format === 'json') {
      const jsonData = {
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
        novels: novels.map((n) => ({
          书名: n.title,
          作者: n.author,
          分类: n.category?.name ?? '',
          状态: n.status === 'completed' ? '完结' : n.status === 'ongoing' ? '连载中' : n.status === 'hiatus' ? '暂停' : n.status,
          来源URL: n.sourceUrl ?? '',
          章节数: n._count.chapters,
          总字数: n.wordCount,
          采集时间: n.createdAt.toISOString(),
        })),
      };

      const filename = `task-${id}-export.json`;
      return new NextResponse(JSON.stringify(jsonData, null, 2), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      });
    }

    // CSV format
    const BOM = '\uFEFF';
    const header = '书名,作者,分类,状态,来源URL,章节数,最新章节,总字数,采集时间';

    // For each novel, find the latest chapter title
    const novelIds = novels.map((n) => n.id);
    let latestChapters: Record<string, string> = {};
    if (novelIds.length > 0) {
      // Fetch the latest chapter for each novel
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

    const csvRows = novels.map((n) => {
      const statusLabel = n.status === 'completed' ? '完结' : n.status === 'ongoing' ? '连载中' : n.status === 'hiatus' ? '暂停' : n.status;
      const latestChapter = latestChapters[n.id] || '';
      const collectTime = n.createdAt.toISOString();
      return [
        csvEscape(n.title),
        csvEscape(n.author),
        csvEscape(n.category?.name ?? ''),
        csvEscape(statusLabel),
        csvEscape(n.sourceUrl ?? ''),
        String(n._count.chapters),
        csvEscape(latestChapter),
        String(n.wordCount),
        csvEscape(collectTime),
      ].join(',');
    });

    const csv = BOM + header + '\n' + csvRows.join('\n');
    const filename = `task-${id}-export.csv`;

    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    console.error('Export scrape task error:', error);
    return apiError('导出采集任务数据失败', 500);
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
