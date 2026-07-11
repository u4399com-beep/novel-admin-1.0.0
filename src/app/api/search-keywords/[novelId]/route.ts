import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";

// GET /api/search-keywords/[novelId] - Get search keywords for a novel
export const GET = withAuth(async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ novelId: string }> }
) {
  try {
    const { novelId } = await params;

    const keywords = await db.searchKeyword.findMany({
      where: { novelId },
      orderBy: { createdAt: "desc" },
      take: 500,
    });

    return NextResponse.json(keywords);
  } catch (error) {
    console.error("Get search keywords error:", error);
    return NextResponse.json(
      { error: "获取搜索关键词失败" },
      { status: 500 }
    );
  }
});

// Generate smart keyword suggestions based on novel info
function generateKeywords(
  title: string,
  author: string,
  categoryName: string | null,
  existingTags: string[]
): { keyword: string; source: string }[] {
  const keywords: { keyword: string; source: string }[] = [];

  // Common suffixes for search keywords
  const suffixes = [
    "全文免费阅读",
    "无弹窗",
    "最新章节",
    "笔趣阁",
    " TXT下载",
    "全文阅读",
    "无弹窗全文",
    "大结局",
    "最新更新",
    "章节目录",
  ];

  // Author-based keywords
  const authorSuffixes = [
    "作品集",
    "全部小说",
    "新书",
  ];

  // Generate title-based keywords
  for (const suffix of suffixes) {
    keywords.push({
      keyword: `${title}${suffix}`,
      source: "百度",
    });
  }

  // Generate author-based keywords
  for (const suffix of authorSuffixes) {
    keywords.push({
      keyword: `${author}${suffix}`,
      source: "搜狗",
    });
  }

  // Generate category-based keywords
  if (categoryName) {
    keywords.push({
      keyword: `${categoryName}小说推荐`,
      source: "必应",
    });
    keywords.push({
      keyword: `${categoryName}小说排行榜`,
      source: "必应",
    });
    keywords.push({
      keyword: `热门${categoryName}小说`,
      source: "360搜索",
    });
  }

  // Generate tag-based keywords
  for (const tag of existingTags.slice(0, 3)) {
    keywords.push({
      keyword: `${tag}小说推荐`,
      source: "神马搜索",
    });
  }

  // Add some specific search patterns
  keywords.push({
    keyword: `${title}${author}`,
    source: "百度",
  });
  keywords.push({
    keyword: `${title}在线阅读`,
    source: "搜狗",
  });
  keywords.push({
    keyword: `${title}txt`,
    source: "360搜索",
  });

  return keywords;
}

// POST /api/search-keywords/[novelId] - Trigger keyword extraction for a novel
export const POST = withAuth(async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ novelId: string }> }
) {
  try {
    const { novelId } = await params;

    // Fetch novel with category and tags
    const novel = await db.novel.findUnique({
      where: { id: novelId },
      include: {
        category: true,
        tags: { include: { tag: true } },
      },
    });

    if (!novel) {
      return NextResponse.json({ error: "小说不存在" }, { status: 404 });
    }

    const existingTags = novel.tags.map((nt) => nt.tag.name);
    const categoryName = novel.category?.name || null;

    // Generate keywords
    const generatedKeywords = generateKeywords(
      novel.title,
      novel.author,
      categoryName,
      existingTags
    );

    // Delete old keywords for this novel
    await db.searchKeyword.deleteMany({ where: { novelId } });

    // Create new keywords (skip duplicates by using a Set)
    const seen = new Set<string>();
    const toCreate: { novelId: string; keyword: string; source: string }[] = [];

    for (const kw of generatedKeywords) {
      const key = `${kw.keyword}|${kw.source}`;
      if (!seen.has(key)) {
        seen.add(key);
        toCreate.push({
          novelId,
          keyword: kw.keyword,
          source: kw.source,
        });
      }
    }

    const created = await db.searchKeyword.createMany({
      data: toCreate,
    });

    // Fetch all created keywords
    const allKeywords = await db.searchKeyword.findMany({
      where: { novelId },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({
      keywords: allKeywords,
      count: created.count,
    });
  } catch (error) {
    console.error("Extract search keywords error:", error);
    return NextResponse.json(
      { error: "提取搜索关键词失败" },
      { status: 500 }
    );
  }
});