import { db } from "@/lib/db";
import { NextRequest } from "next/server";
import { parsePagination, apiError, apiSuccess } from "@/lib/api-utils";
import { withAuth } from "@/lib/api-auth";
import { getToken } from "next-auth/jwt";

// GET /api/favorites - List current user's favorite novels (paginated)
export const GET = withAuth(async function GET(request: NextRequest) {
  try {
    const token = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET });
    const userId = token?.id ? String(token.id) : null;
    if (!userId) {
      return apiError("无法获取用户信息", 401);
    }

    const { searchParams } = new URL(request.url);
    const { page, pageSize, skip } = parsePagination(searchParams, { defaultPageSize: 20 });

    const where = { userId };

    const [favorites, total] = await Promise.all([
      db.favorite.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
        select: { novelId: true, createdAt: true },
      }),
      db.favorite.count({ where }),
    ]);

    // Batch-fetch novels with tags in a single query (avoids N+1)
    const novelIds = favorites.map((f) => f.novelId);
    const novels = novelIds.length > 0
      ? await db.novel.findMany({
          where: { id: { in: novelIds } },
          include: {
            category: { select: { id: true, name: true, color: true, slug: true } },
            tags: { include: { tag: { select: { id: true, name: true, color: true } } } },
            _count: { select: { chapters: true } },
          },
        })
      : [];

    const novelMap = new Map(novels.map((n) => [n.id, n]));

    // Preserve the favorite-ordering and attach the novel data
    const result = favorites
      .map((f) => {
        const novel = novelMap.get(f.novelId);
        if (!novel) return null;
        return {
          ...novel,
          isFavorited: true,
          favoritedAt: f.createdAt.toISOString(),
        };
      })
      .filter(Boolean);

    return apiSuccess({
      novels: result,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (error) {
    console.error("List favorites error:", error);
    return apiError("获取收藏列表失败");
  }
});
