import { db } from "@/lib/db";
import { NextRequest } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { handlePrismaError, apiError, apiSuccess, getAuthUserId } from "@/lib/api-utils";

// GET /api/novels/[id]/favorite - Check if current user has favorited this novel
export const GET = withAuth(async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const userId = await getAuthUserId(request);
    if (!userId) {
      return apiError("无法获取用户信息", 401);
    }

    const novel = await db.novel.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!novel) {
      return apiError("小说不存在", 404);
    }

    const favorite = await db.favorite.findUnique({
      where: { userId_novelId: { userId, novelId: id } },
      select: { id: true, createdAt: true },
    });

    return apiSuccess({
      isFavorited: !!favorite,
      ...(favorite ? { favoritedAt: favorite.createdAt.toISOString() } : {}),
    });
  } catch (error: unknown) {
    console.error("Check favorite error:", error);
    const { message, status } = handlePrismaError(error);
    return apiError(message, status);
  }
});

// POST /api/novels/[id]/favorite - Toggle favorite (add if not exists, remove if exists)
export const POST = withAuth(async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const userId = await getAuthUserId(request);
    if (!userId) {
      return apiError("无法获取用户信息", 401);
    }

    const novel = await db.novel.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!novel) {
      return apiError("小说不存在", 404);
    }

    // Check if already favorited
    const existing = await db.favorite.findUnique({
      where: { userId_novelId: { userId, novelId: id } },
    });

    if (existing) {
      // Remove favorite + atomic floor-clamped decrement in transaction
      await db.$transaction([
        db.favorite.delete({ where: { id: existing.id } }),
        db.$executeRaw`UPDATE "Novel" SET "favoriteCount" = MAX(0, "favoriteCount" - 1) WHERE id = ${id}`,
      ]);

      const updated = await db.novel.findUnique({
        where: { id },
        select: { favoriteCount: true },
      });

      return apiSuccess({
        isFavorited: false,
        favoriteCount: Math.max(0, updated?.favoriteCount ?? 0),
      });
    } else {
      // Add favorite: use transaction for atomic create + increment
      // with unique constraint catch for TOCTOU protection
      try {
        const [, updatedNovel] = await db.$transaction([
          db.favorite.create({
            data: { userId, novelId: id },
          }),
          db.novel.update({
            where: { id },
            data: { favoriteCount: { increment: 1 } },
            select: { favoriteCount: true },
          }),
        ]);

        return apiSuccess({
          isFavorited: true,
          favoriteCount: updatedNovel.favoriteCount,
        });
      } catch (error: unknown) {
        // P2002 = unique constraint violation → already favorited, fetch current count
        if (handlePrismaError(error).status === 409) {
          const existing = await db.novel.findUnique({
            where: { id },
            select: { favoriteCount: true },
          });
          return apiSuccess({
            isFavorited: true,
            favoriteCount: existing?.favoriteCount ?? 0,
          });
        }
        throw error;
      }
    }
  } catch (error: unknown) {
    console.error("Toggle favorite error:", error);
    const { message, status } = handlePrismaError(error);
    return apiError(message, status);
  }
});
