import { db } from '@/lib/db';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-utils';
import { withAuth } from '@/lib/api-auth';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ActivityItem {
  id: string;
  type: 'novel_updated' | 'chapter_created' | 'task_created' | 'task_completed' | 'task_failed';
  title: string;
  description: string;
  timestamp: string;
  link?: string;
  meta?: { [key: string]: string | number };
}

// ─── GET ─────────────────────────────────────────────────────────────────────

export const GET = withAuth(async function GET() {
  try {
    const activities: ActivityItem[] = [];

    // 1. Recent novels (updated)
    const recentNovels = await db.novel.findMany({
      orderBy: { updatedAt: 'desc' },
      take: 20,
      select: {
        id: true,
        title: true,
        updatedAt: true,
        status: true,
        wordCount: true,
      },
    });

    for (const novel of recentNovels) {
      const statusLabel: Record<string, string> = {
        ongoing: '连载中',
        completed: '已完结',
        hiatus: '暂停',
      };
      activities.push({
        id: `novel-${novel.id}`,
        type: 'novel_updated',
        title: novel.title,
        description: `状态：${statusLabel[novel.status] ?? novel.status}，共 ${novel.wordCount.toLocaleString()} 字`,
        timestamp: novel.updatedAt.toISOString(),
        link: `/novels/${novel.id}`,
        meta: { wordCount: novel.wordCount, status: novel.status },
      });
    }

    // 2. Recent chapters (created)
    const recentChapters = await db.chapter.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        title: true,
        createdAt: true,
        novelId: true,
        novel: { select: { id: true, title: true } },
        wordCount: true,
      },
    });

    for (const ch of recentChapters) {
      activities.push({
        id: `chapter-${ch.id}`,
        type: 'chapter_created',
        title: ch.title,
        description: `《${ch.novel.title}》· ${ch.wordCount.toLocaleString()} 字`,
        timestamp: ch.createdAt.toISOString(),
        link: `/novels/${ch.novel.id}`,
        meta: { novelId: ch.novel.id, wordCount: ch.wordCount },
      });
    }

    // 3. Recent scrape tasks
    const recentTasks = await db.scrapeTask.findMany({
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        id: true,
        status: true,
        createdAt: true,
        rule: { select: { name: true } },
      },
    });

    for (const task of recentTasks) {
      let type: ActivityItem['type'];
      if (task.status === 'completed') type = 'task_completed';
      else if (task.status === 'failed') type = 'task_failed';
      else type = 'task_created';

      const statusLabel: Record<string, string> = {
        pending: '等待中',
        running: '运行中',
        completed: '已完成',
        failed: '失败',
        cancelled: '已取消',
      };

      activities.push({
        id: `task-${task.id}`,
        type,
        title: task.rule.name,
        description: `采集任务 ${statusLabel[task.status] ?? task.status}`,
        timestamp: task.createdAt.toISOString(),
        meta: { taskId: task.id, status: task.status },
      });
    }

    // Sort by timestamp descending
    activities.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return NextResponse.json({ activities });
  } catch (error) {
    console.error('Get activity error:', error);
    return apiError('获取活动记录失败', 500);
  }
});
