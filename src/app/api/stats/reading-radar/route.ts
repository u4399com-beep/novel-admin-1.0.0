import { NextRequest, NextResponse } from 'next/server';
import { withPublicRateLimit } from '@/lib/api-auth';
import { db } from '@/lib/db';
import { sanitizeField, apiError } from '@/lib/api-utils';

const MAX_SESSION_ID_LENGTH = 100;

/**
 * GET /api/stats/reading-radar?sessionId=xxx
 * Returns a 5-dimension radar of reading ability/behavior.
 */
export const GET = withPublicRateLimit({ capacity: 60, refillRate: 2 }, async function GET(request: NextRequest) {
  try {
    const sessionId = sanitizeField(new URL(request.url).searchParams.get('sessionId') || '', MAX_SESSION_ID_LENGTH);
    if (!sessionId || sessionId.length < 20) {
      return NextResponse.json({
        radar: { consistency: 0, volume: 0, speed: 0, diversity: 0, completion: 0 },
        summary: '暂无阅读数据',
      });
    }

    // 1. Fetch all reading progress for this session with novel info
    const progressItems = await db.readingProgress.findMany({
      where: { sessionId },
      select: {
        chapterIndex: true,
        lastReadAt: true,
        novel: {
          select: {
            id: true,
            categoryId: true,
            category: { select: { id: true, name: true } },
            _count: { select: { chapters: true } },
          },
        },
      },
    });

    if (progressItems.length === 0) {
      return NextResponse.json({
        radar: { consistency: 0, volume: 0, speed: 0, diversity: 0, completion: 0 },
        summary: '暂无阅读数据',
      });
    }

    // --- Consistency: streak / days since first read ---
    const dates = progressItems.map((p) => p.lastReadAt);
    const dateSet = new Set<string>();
    const timestamps = dates.map((d) => d.getTime()).sort((a, b) => a - b);
    for (const d of dates) {
      dateSet.add(d.toISOString().slice(0, 10));
    }

    // Calculate streak ending today or yesterday
    const todayStr = new Date().toISOString().slice(0, 10);
    const yesterdayDate = new Date();
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterdayStr = yesterdayDate.toISOString().slice(0, 10);

    let streak = 0;
    if (dateSet.has(todayStr) || dateSet.has(yesterdayStr)) {
      const start = dateSet.has(todayStr) ? new Date() : yesterdayDate;
      const checkDate = new Date(start);
      while (dateSet.has(checkDate.toISOString().slice(0, 10))) {
        streak++;
        checkDate.setDate(checkDate.getDate() - 1);
      }
    }

    const firstDate = new Date(timestamps[0]);
    const daysSinceFirst = Math.max(1, Math.ceil((Date.now() - firstDate.getTime()) / (1000 * 60 * 60 * 24)));
    const consistency = Math.min(100, Math.round((streak / daysSinceFirst) * 100));

    // --- Volume: total words read (from readingDaily) ---
    const totalWordsRow = await db.readingDaily.aggregate({ _sum: { words: true } });
    const totalWords = Number(totalWordsRow._sum?.words || 0);
    // 100k words = full score
    const volume = Math.min(100, Math.round((totalWords / 100_000) * 100));

    // --- Speed: avg words per active reading day ---
    const activeDays = await db.readingDaily.count({ where: { words: { gt: 0 } } });
    const avgWordsPerDay = activeDays > 0 ? Math.round(totalWords / activeDays) : 0;
    // 5000 words/day = full score
    const speed = Math.min(100, Math.round((avgWordsPerDay / 5000) * 100));

    // --- Diversity: number of different categories read ---
    const categorySet = new Set<string>();
    for (const item of progressItems) {
      if (item.novel.categoryId) {
        categorySet.add(item.novel.categoryId);
      }
    }
    // 8 categories = full score
    const diversity = Math.min(100, Math.round((categorySet.size / 8) * 100));

    // --- Completion: completed books / total books ---
    let completedBooks = 0;
    const totalBooks = progressItems.length;
    for (const item of progressItems) {
      const chapters = item.novel._count.chapters;
      const currentChapter = item.chapterIndex + 1;
      if (chapters > 0 && currentChapter >= chapters * 0.95) {
        completedBooks++;
      }
    }
    const completion = totalBooks > 0 ? Math.min(100, Math.round((completedBooks / totalBooks) * 100)) : 0;

    // --- Summary based on highest dimension ---
    const dims = [
      { key: 'consistency', value: consistency, label: '坚持不懈型' },
      { key: 'volume', value: volume, label: '博览群书型' },
      { key: 'speed', value: speed, label: '一目十行型' },
      { key: 'diversity', value: diversity, label: '涉猎广泛型' },
      { key: 'completion', value: completion, label: '有始有终型' },
    ];
    dims.sort((a, b) => b.value - a.value);
    const summary = dims[0].value > 0 ? dims[0].label : '暂无阅读数据';

    return NextResponse.json({
      radar: { consistency, volume, speed, diversity, completion },
      summary,
    });
  } catch (error) {
    console.error('Reading radar stats error:', error);
    return apiError('获取阅读能力雷达失败', 500);
  }
});
