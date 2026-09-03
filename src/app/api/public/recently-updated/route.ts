import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { withPublicRateLimit } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/public/recently-updated?limit=6
 * Returns novels that have been recently updated (have chapters with content),
 * ordered by the most recently updated chapter's createdAt desc.
 */
export const GET = withPublicRateLimit({ capacity: 60, refillRate: 2 }, async (request: NextRequest) => {
  try {
    const { searchParams } = new URL(request.url);
    const rawLimit = parseInt(searchParams.get('limit') || '6', 10);
    const limit = Math.min(Math.max(1, isNaN(rawLimit) ? 6 : rawLimit), 20);

    // Find novels that have at least one chapter with content,
    // ordered by the most recently created/updated chapter.
    // We need to get the latest chapter per novel, then sort novels by that.
    // Approach: query chapters with content, group by novelId, get max updatedAt per novel.
    // Then fetch the novel details in that order.

    // Step 1: Get the latest chapter (with content) per novel, ordered by chapter.updatedAt desc
    const latestChapters = await db.chapter.findMany({
      where: {
        content: { not: null },
      },
      select: {
        novelId: true,
        title: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 500, // Fetch enough to cover limit after dedup
    });

    // Step 2: Deduplicate by novelId, keeping the first (most recent) entry
    const seen = new Set<string>();
    const uniqueChapters: Array<{ novelId: string; title: string; updatedAt: Date }> = [];
    for (const ch of latestChapters) {
      if (!seen.has(ch.novelId)) {
        seen.add(ch.novelId);
        uniqueChapters.push(ch);
        if (uniqueChapters.length >= limit) break;
      }
    }

    if (uniqueChapters.length === 0) {
      return NextResponse.json({ novels: [] });
    }

    // Step 3: Fetch novel details for these IDs, preserving the order
    const novelIds = uniqueChapters.map((ch) => ch.novelId);

    const novels = await db.novel.findMany({
      where: { id: { in: novelIds } },
      select: {
        id: true,
        title: true,
        author: true,
        coverUrl: true,
        category: { select: { name: true } },
        _count: { select: { chapters: true } },
        updatedAt: true,
      },
    });

    // Step 4: Build response in the same order as uniqueChapters
    const novelMap = new Map(novels.map((n) => [n.id, n]));
    const result = uniqueChapters
      .map((ch) => {
        const novel = novelMap.get(ch.novelId);
        if (!novel) return null;
        // Count chapters with content
        return {
          id: novel.id,
          title: novel.title,
          author: novel.author,
          coverUrl: novel.coverUrl,
          category: novel.category?.name ?? null,
          totalChapters: novel._count.chapters,
          lastChapterTitle: ch.title,
          updatedAt: novel.updatedAt.toISOString(),
        };
      })
      .filter(Boolean);

    return NextResponse.json(
      { novels: result },
      { headers: { 'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=300' } },
    );
  } catch (error) {
    console.error('Recently updated API error:', error);
    return NextResponse.json({ novels: [] });
  }
});
