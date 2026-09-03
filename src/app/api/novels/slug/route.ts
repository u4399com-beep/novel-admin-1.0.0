import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { withAuth, withPublicRateLimit } from '@/lib/api-auth';
import { safeJson, apiError, sanitizeField, safeJsonStringify } from '@/lib/api-utils';
import {
  generateSlugForNovel,
  type SlugType,
} from '@/lib/slug-generator';

// ═══════════════════════════════════════════════════════════════════
// GET /api/novels/slug?slug=xxx  (public)
// ═══════════════════════════════════════════════════════════════════
// Looks up a slug and returns the novel's cuid for routing.

export const GET = withPublicRateLimit(async function GET(request: NextRequest) {
  try {
    const slug = request.nextUrl.searchParams.get('slug');
    if (!slug) {
      return apiError('缺少 slug 参数', 400);
    }
    if (slug.length > 200) {
      return apiError('slug 过长', 400);
    }

    const mapping = await db.novelSlug.findUnique({
      where: { slug },
      select: { novelId: true, isActive: true, type: true, slug: true },
    });

    if (!mapping || !mapping.isActive) {
      return apiError('未找到对应小说', 404);
    }

    return NextResponse.json({ novelId: mapping.novelId, type: mapping.type, slug: mapping.slug });
  } catch (error) {
    console.error('Slug lookup error:', error);
    return apiError('查询失败', 500);
  }
});

// ═══════════════════════════════════════════════════════════════════
// POST /api/novels/slug  (admin) — generate a slug for a novel
// ═══════════════════════════════════════════════════════════════════
// Body: { novelId, type, length?, customSlug? }

export const POST = withAuth(async function POST(request: NextRequest) {
  try {
    const body = await safeJson<{ novelId?: string; type?: string; length?: number; customSlug?: string }>(request);

    const novelId = sanitizeField(body?.novelId, 100);
    if (!novelId) {
      return apiError('缺少 novelId', 400);
    }

    const validTypes: SlugType[] = ['id', 'pinyin', 'random'];
    const type = body?.type as SlugType | undefined;
    if (!type || !validTypes.includes(type)) {
      return apiError('type 必须为 id、pinyin 或 random', 400);
    }

    // Validate length for random type
    let length = body?.length;
    if (type === 'random') {
      length = length ?? 8;
      if (!Number.isInteger(length) || length < 4 || length > 32) {
        return apiError('random 类型 length 必须为 4-32 之间的整数', 400);
      }
    }

    // If customSlug is provided, use it directly (for 'id' type override)
    let customSlug: string | undefined;
    if (body?.customSlug) {
      customSlug = sanitizeField(body.customSlug, 200);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]$/.test(customSlug) && !/^[a-zA-Z0-9]$/.test(customSlug)) {
        return apiError('customSlug 格式无效（仅允许字母、数字、连字符）', 400);
      }
    }

    // Fetch the novel
    const novel = await db.novel.findUnique({
      where: { id: novelId },
      select: { id: true, title: true },
    });
    if (!novel) {
      return apiError('小说不存在', 404);
    }

    // Generate slug
    let slug: string;
    if (customSlug) {
      slug = customSlug;
    } else {
      const result = generateSlugForNovel(novel, type, length);
      slug = result.slug;
    }

    // Deactivate old slugs of the same type for this novel
    await db.novelSlug.updateMany({
      where: { novelId, type, isActive: true },
      data: { isActive: false },
    });

    // Check if slug already exists (another novel might have it)
    const existing = await db.novelSlug.findUnique({
      where: { slug },
    });
    if (existing && existing.novelId !== novelId) {
      // Slug collision — for random type, regenerate up to 5 times
      if (type === 'random' && !customSlug) {
        for (let attempt = 0; attempt < 5; attempt++) {
          const retry = generateSlugForNovel(novel, 'random', length);
          const retryExisting = await db.novelSlug.findUnique({ where: { slug: retry.slug } });
          if (!retryExisting) {
            slug = retry.slug;
            break;
          }
        }
      }
      // Final collision check
      const finalCheck = await db.novelSlug.findUnique({ where: { slug } });
      if (finalCheck && finalCheck.novelId !== novelId) {
        return apiError('slug 冲突，请重试或使用 customSlug', 409);
      }
    }

    // Create or reactivate the slug
    const slugRecord = await db.novelSlug.upsert({
      where: { slug },
      update: { novelId, type, isActive: true },
      create: { novelId, slug, type, isActive: true },
    });

    return NextResponse.json({
      id: slugRecord.id,
      slug: slugRecord.slug,
      type: slugRecord.type,
      novelId: slugRecord.novelId,
      isActive: slugRecord.isActive,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('格式无效')) {
      return apiError(error.message, 400);
    }
    console.error('Slug create error:', error);
    return apiError('创建 slug 失败', 500);
  }
});

// ═══════════════════════════════════════════════════════════════════
// DELETE /api/novels/slug?novelId=xxx&type=yyy  (admin)
// ═══════════════════════════════════════════════════════════════════
// Deactivates the slug (soft delete).

export const DELETE = withAuth(async function DELETE(request: NextRequest) {
  try {
    const novelId = request.nextUrl.searchParams.get('novelId');
    const type = request.nextUrl.searchParams.get('type');

    if (!novelId) {
      return apiError('缺少 novelId 参数', 400);
    }
    if (!type) {
      return apiError('缺少 type 参数', 400);
    }

    const validTypes: SlugType[] = ['id', 'pinyin', 'random'];
    if (!validTypes.includes(type as SlugType)) {
      return apiError('type 必须为 id、pinyin 或 random', 400);
    }

    const result = await db.novelSlug.updateMany({
      where: { novelId, type, isActive: true },
      data: { isActive: false },
    });

    return NextResponse.json({ deactivated: result.count });
  } catch (error) {
    console.error('Slug delete error:', error);
    return apiError('停用 slug 失败', 500);
  }
});

// ═══════════════════════════════════════════════════════════════════
// PUT /api/novels/slug  (admin) — set global pseudo-static mode
// ═══════════════════════════════════════════════════════════════════
// Body: { mode: "id" | "pinyin" | "random", randomLength?: number }
// Also generates slugs for all existing novels that don't have one of this type.

export const PUT = withAuth(async function PUT(request: NextRequest) {
  try {
    const body = await safeJson<{ mode?: string; randomLength?: number }>(request);

    const mode = body?.mode as SlugType | undefined;
    const validModes: SlugType[] = ['id', 'pinyin', 'random'];
    if (!mode || !validModes.includes(mode)) {
      return apiError('mode 必须为 id、pinyin 或 random', 400);
    }

    let randomLength = body?.randomLength ?? 8;
    if (!Number.isInteger(randomLength) || randomLength < 4 || randomLength > 32) {
      return apiError('randomLength 必须为 4-32 之间的整数', 400);
    }

    // Save the setting
    const settingValue = safeJsonStringify(
      { mode, randomLength },
      'pseudoStaticMode',
      1000
    );
    await db.siteSetting.upsert({
      where: { key: 'pseudoStaticMode' },
      update: { value: settingValue! },
      create: { key: 'pseudoStaticMode', value: settingValue! },
    });

    // Find all novels that don't have an active slug of this type
    const novelsWithoutSlug = await db.$queryRaw<Array<{ id: string; title: string }>>`
      SELECT n.id, n.title
      FROM Novel n
      WHERE NOT EXISTS (
        SELECT 1 FROM NovelSlug ns
        WHERE ns.novelId = n.id AND ns.type = ${mode} AND ns.isActive = 1
      )
      ORDER BY n.createdAt ASC
    `;

    // Generate slugs in batch (limit 200 at a time to avoid timeouts)
    const batchSize = 200;
    let generated = 0;

    for (let i = 0; i < novelsWithoutSlug.length; i += batchSize) {
      const batch = novelsWithoutSlug.slice(i, i + batchSize);

      const createData = batch.map((novel) => {
        const result = generateSlugForNovel(novel, mode, randomLength);
        return {
          novelId: novel.id,
          slug: result.slug,
          type: mode,
          isActive: true,
        };
      });

      try {
        // NOTE: skipDuplicates is not supported on SQLite (typed `never` by Prisma);
        // collisions fall through to the sequential path below via the catch block.
        await db.novelSlug.createMany({
          data: createData,
        });
        generated += createData.length;
      } catch (error) {
        // If batch fails due to unique constraint, try one by one
        console.warn('Batch slug creation had collisions, falling back to sequential:');
        for (const novel of batch) {
          try {
            const result = generateSlugForNovel(novel, mode, randomLength);
            await db.novelSlug.create({
              data: {
                novelId: novel.id,
                slug: result.slug,
                type: mode,
                isActive: true,
              },
            });
            generated++;
          } catch {
            // Skip individual failures (e.g. unique constraint)
          }
        }
      }
    }

    return NextResponse.json({
      success: true,
      mode,
      randomLength,
      generated,
      totalNovels: novelsWithoutSlug.length,
    });
  } catch (error) {
    console.error('Slug settings update error:', error);
    return apiError('更新伪静态设置失败', 500);
  }
});
