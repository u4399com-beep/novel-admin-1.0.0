import { db } from "@/lib/db";
import { NextRequest } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { isPrismaError, apiError, apiSuccess } from "@/lib/api-utils";
import { getToken } from "next-auth/jwt";

// Helper to get the authenticated user's ID from the request
async function getUserId(request: NextRequest): Promise<string | null> {
  const token = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET });
  return token?.id ? String(token.id) : null;
}

// GET /api/novels/[id]/favorite - Check if current user has favorited this novel
export const GET = withAuth(async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const userId = await getUserId(request);
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
    if (isPrismaError(error, "P2025")) {
      return apiError("小说不存在", 404);
    }
    return apiError("操作失败", 500);
  }
});

// POST /api/novels/[id]/favorite - Toggle favorite (add if not exists, remove if exists)
export const POST = withAuth(async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const userId = await getUserId(request);
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
        await db.$transaction([
          db.favorite.create({
            data: { userId, novelId: id },
          }),
          db.novel.update({
            where: { id },
            data: { favoriteCount: { increment: 1 } },
            select: { favoriteCount: true },
          }),
        ]);
      } catch (error: unknown) {
        // P2002 = unique constraint violation → already favorited, fetch current count
        if (isPrismaError(error, 'P2002')) {
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

      const updated = await db.novel.findUnique({
        where: { id },
        select: { favoriteCount: true },
      });

      return apiSuccess({
        isFavorited: true,
        favoriteCount: updated?.favoriteCount ?? 0,
      });
    }
  } catch (error: unknown) {
    console.error("Toggle favorite error:", error);
    if (isPrismaError(error, "P2025")) {
      return apiError("小说不存在", 404);
    }
    return apiError("操作失败", 500);
  }
});
