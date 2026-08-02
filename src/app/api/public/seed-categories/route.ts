import { db } from "@/lib/db";
import { NextResponse } from "next/server";

/**
 * Seed default categories into the database.
 * Public endpoint — used for initial setup before login.
 * Uses upsert so it's idempotent and safe to call multiple times.
 */
const CATEGORIES_23QB = [
  {
    name: "言情小说",
    slug: "yanqing",
    description: "以爱情为主线，描写男女之间的感情故事，包括现代言情、古代言情等",
    color: "#ec4899",
    icon: "💕",
    sortOrder: 1,
  },
  {
    name: "都市小说",
    slug: "dushi",
    description: "以现代都市为背景，描写都市生活中的爱情、职场、商战等故事",
    color: "#3b82f6",
    icon: "🏙️",
    sortOrder: 2,
  },
  {
    name: "耽美百合",
    slug: "danmei",
    description: "男性之间的爱情故事（耽美/BL）与女性之间的爱情故事（百合/GL）",
    color: "#a855f7",
    icon: "🌈",
    sortOrder: 3,
  },
  {
    name: "穿越转生",
    slug: "chuanyue",
    description: "主角穿越到异世界、古代或重生到过去/未来，展开全新人生的故事",
    color: "#f59e0b",
    icon: "🔄",
    sortOrder: 4,
  },
  {
    name: "青春校园",
    slug: "qingchun",
    description: "以校园生活为背景，描写青春期的友情、爱情和成长故事",
    color: "#10b981",
    icon: "🎓",
    sortOrder: 5,
  },
  {
    name: "玄幻魔法",
    slug: "xuanhuan",
    description: "以玄幻世界为背景，包含魔法、斗气、修炼等奇幻元素的小说",
    color: "#6366f1",
    icon: "✨",
    sortOrder: 6,
  },
  {
    name: "修真武侠",
    slug: "xiuzhen",
    description: "以修炼、武侠为核心，包含仙侠、武侠、江湖等传统东方元素",
    color: "#ef4444",
    icon: "⚔️",
    sortOrder: 7,
  },
  {
    name: "历史军事",
    slug: "lishi",
    description: "以历史事件或军事战争为背景，融合真实历史与虚构情节的小说",
    color: "#78716c",
    icon: "📜",
    sortOrder: 8,
  },
  {
    name: "游戏竞技",
    slug: "youxi",
    description: "以游戏世界或电子竞技为背景，描写虚拟世界中的冒险和竞技故事",
    color: "#06b6d4",
    icon: "🎮",
    sortOrder: 9,
  },
  {
    name: "科幻空间",
    slug: "kehuan",
    description: "以科学技术为基础，包含星际探索、末世生存、未来科技等元素",
    color: "#0ea5e9",
    icon: "🚀",
    sortOrder: 10,
  },
  {
    name: "悬疑惊悚",
    slug: "xuanyi",
    description: "以悬疑、推理、恐怖为核心，包含侦探破案、灵异事件等紧张刺激的情节",
    color: "#475569",
    icon: "🔍",
    sortOrder: 11,
  },
  {
    name: "同人小说",
    slug: "tongren",
    description: "基于已有动漫、小说、影视作品角色和世界观创作的衍生小说",
    color: "#d946ef",
    icon: "📝",
    sortOrder: 12,
  },
  {
    name: "官场职场",
    slug: "guanchang",
    description: "以官场或职场为背景，描写权力斗争、商战谋略和职场生存的小说",
    color: "#b45309",
    icon: "💼",
    sortOrder: 13,
  },
];

export async function POST() {
  try {
    // Use upsert for each category — idempotent, safe to call repeatedly.
    // Unlike deleteMany+createMany, this preserves existing data and
    // won't fail due to foreign key constraints.
    let createdCount = 0;
    let updatedCount = 0;

    for (const cat of CATEGORIES_23QB) {
      const result = await db.category.upsert({
        where: { slug: cat.slug },
        update: {
          name: cat.name,
          description: cat.description,
          color: cat.color,
          icon: cat.icon,
          sortOrder: cat.sortOrder,
        },
        create: cat,
      });
      // If updatedAt equals createdAt, it was just created
      if (result.createdAt.getTime() === result.updatedAt.getTime()) {
        createdCount++;
      } else {
        updatedCount++;
      }
    }

    // Fetch all categories to return
    const categories = await db.category.findMany({
      orderBy: { sortOrder: "asc" },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        color: true,
        icon: true,
        sortOrder: true,
        _count: { select: { novels: true } },
      },
    });

    return NextResponse.json({
      message: `成功导入分类：新建 ${createdCount} 个，更新 ${updatedCount} 个`,
      categories,
    });
  } catch (error) {
    console.error("Seed categories error:", error);
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: "导入分类失败", detail: msg },
      { status: 500 }
    );
  }
}
