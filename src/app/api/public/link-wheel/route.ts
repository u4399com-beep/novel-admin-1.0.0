import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { withPublicRateLimit } from '@/lib/api-auth';
import { sanitizeField } from '@/lib/api-utils';
import { isValidLinkType } from '@/lib/validation/friendly-links';

interface LinkWheelItem {
  title: string;
  url: string;
  description: string | null;
  nofollow: boolean;
}

/** Fisher-Yates shuffle (in-place) */
function shuffleArray<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * GET /api/public/link-wheel
 *
 * Public endpoint for SEO link wheel — returns randomized friendly links.
 *
 * Query params:
 *   count=10   (max 50)
 *   type=all|manual|site_home|site_novel
 *   novelId=xxx (optional, when type=site_novel, filter to specific novel)
 */
export const GET = withPublicRateLimit({ capacity: 120, refillRate: 2 }, async (request: NextRequest) => {
  try {
    const { searchParams } = new URL(request.url);

    // Parse & validate count
    const rawCount = parseInt(searchParams.get('count') || '10', 10);
    const count = Math.min(50, Math.max(1, Number.isNaN(rawCount) ? 10 : rawCount));

    // Parse & validate type
    const typeParam = sanitizeField(searchParams.get('type'), 20) || 'all';
    const wantManual = typeParam === 'all' || typeParam === 'manual';
    const wantSiteHome = typeParam === 'all' || typeParam === 'site_home';
    const wantSiteNovel = typeParam === 'all' || typeParam === 'site_novel';

    // Optional novelId filter for site_novel
    const novelIdFilter = sanitizeField(searchParams.get('novelId'), 100) || null;

    const links: LinkWheelItem[] = [];

    // ─── 1. Fetch manual friendly links ───────────────────────────
    if (wantManual) {
      const manualLinks = await db.friendlyLink.findMany({
        where: { enabled: true, linkType: 'manual' },
        orderBy: { sortOrder: 'asc' },
      });
      for (const link of manualLinks) {
        links.push({
          title: link.title,
          url: link.url,
          description: link.description,
          nofollow: link.nofollow,
        });
      }
    }

    // ─── 2. Fetch site_home friendly links ────────────────────────
    if (wantSiteHome) {
      const siteHomeLinks = await db.friendlyLink.findMany({
        where: { enabled: true, linkType: 'site_home' },
        include: { site: { select: { domain: true, name: true } } },
        orderBy: { sortOrder: 'asc' },
      });
      for (const link of siteHomeLinks) {
        const domain = link.site?.domain || '';
        if (!domain) continue;
        links.push({
          title: link.title || link.site?.name || domain,
          url: `https://${domain.replace(/^https?:\/\//, '')}`,
          description: link.description,
          nofollow: link.nofollow,
        });
      }
    }

    // ─── 3. Fetch site_novel friendly links ───────────────────────
    if (wantSiteNovel) {
      const novelWhere: Record<string, unknown> = { enabled: true, linkType: 'site_novel' };
      if (novelIdFilter) {
        novelWhere.novelId = novelIdFilter;
      }

      const siteNovelLinks = await db.friendlyLink.findMany({
        where: novelWhere,
        include: {
          site: { select: { domain: true } },
          novel: {
            select: {
              title: true,
              slugs: { where: { isActive: true }, take: 1, select: { slug: true } },
            },
          },
        },
        orderBy: { sortOrder: 'asc' },
      });
      for (const link of siteNovelLinks) {
        const domain = link.site?.domain || '';
        const slug = link.novel?.slugs[0]?.slug;
        if (!domain || !slug) continue;
        links.push({
          title: link.title || link.novel?.title || slug,
          url: `https://${domain.replace(/^https?:\/\//, '')}/novel/${slug}`,
          description: link.description,
          nofollow: link.nofollow,
        });
      }

      // ─── 4. Randomly pick novels from DB for link wheel diversity ─
      // Get all enabled sites for domain construction
      const enabledSites = await db.site.findMany({
        where: { enabled: true },
        select: { id: true, domain: true },
      });

      if (enabledSites.length > 0) {
        // Fetch random novels with slugs, up to `count` extra candidates
        const randomNovels = await db.$queryRaw<Array<{ id: string; title: string; slug: string }>>`
          SELECT n.id, n.title, ns.slug
          FROM Novel n
          INNER JOIN NovelSlug ns ON ns.novelId = n.id AND ns.isActive = 1
          WHERE n.id NOT IN (
            SELECT fl."novelId" FROM FriendlyLink fl
            WHERE fl.linkType = 'site_novel' AND fl.enabled = 1 AND fl."novelId" IS NOT NULL
          )
          ORDER BY RANDOM()
          LIMIT ${count}
        `;

        for (const novel of randomNovels) {
          // Pick a random site for this novel
          const site = enabledSites[Math.floor(Math.random() * enabledSites.length)];
          links.push({
            title: novel.title,
            url: `https://${site.domain}/novel/${novel.slug}`,
            description: null,
            nofollow: true,
          });
        }
      }
    }

    // ─── 5. Shuffle & slice ────────────────────────────────────────
    shuffleArray(links);
    const result = links.slice(0, count);

    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 'public, s-maxage=300',
      },
    });
  } catch (error) {
    console.error('Link wheel error:', error);
    return NextResponse.json({ error: '获取链接轮盘失败' }, { status: 500 });
  }
});
