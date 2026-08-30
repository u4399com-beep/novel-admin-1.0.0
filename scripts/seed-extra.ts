/**
 * seed-extra.ts - 补充缺失分类的小说
 */
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();

const PLACEHOLDER_CONTENT = `清晨的第一缕阳光透过窗棂洒落在青石铺就的小径上，空气中弥漫着泥土与花草的清新气息。远处传来几声悠长的钟声，打破了山间寺庙的宁静。一位身着青衫的年轻人正沿着蜿蜒的山路拾级而上，他的目光坚毅而深邃，仿佛在寻找着什么。

路旁的古松苍翠挺拔，枝叶间偶尔传来几声清脆的鸟鸣。山间的雾气还未完全散去，如同一层薄纱笼罩着整座山峰。年轻人停下脚步，深深地吸了一口气，感受着这里灵气的充沛。

溪水从山涧中潺潺流下，清澈见底的溪水中偶尔可以看到几条银色的小鱼在石头间穿梭。年轻人蹲下身来，捧起一捧溪水洗了洗脸，冰凉的溪水让他精神一振。`;

function rand(min: number, max: number) { return Math.floor(Math.random() * (max - min + 1)) + min; }

const names = ['初入江湖','风云初动','暗流涌动','一剑破空','绝地反击','迷雾重重','真相大白','巅峰对决','涅槃重生','终章'];

interface Extra {
  title: string; author: string; categorySlug: string; description: string; chapters: number;
  status?: 'ongoing' | 'completed';
}

const extraNovels: Extra[] = [
  { title: '庆余年（历史版）', author: '猫腻', categorySlug: 'lishi', description: '以庆国为背景，讲述了穿越者范闲在古代世界的传奇经历。从一个小小的私生子到权倾天下的风云人物，范闲的成长历程充满了权谋与智慧。', chapters: 7 },
  { title: '同人：火影之最强', author: '网络作家', categorySlug: 'tongren', description: '穿越到火影忍者世界，成为木叶村的一名普通忍者。凭借着对剧情的了解和不懈的努力，一步步成为忍界最强之人。', chapters: 6, status: 'ongoing' },
  { title: '同人：海贼之冒险', author: '网络作家', categorySlug: 'tongren', description: '在大海贼时代，一个年轻人踏上了寻找传说中的One Piece的旅程。在伟大航路上，他将遇到各种伙伴和敌人。', chapters: 5, status: 'ongoing' },
  { title: '同人：西游之逆天', author: '网络作家', categorySlug: 'tongren', description: '假如西游记中的妖怪们不再甘心做炮灰？一只小妖获得了逆天改命的机会，在西行路上书写属于自己的传奇。', chapters: 6, status: 'ongoing' },
  { title: '同人：三国之重生', author: '网络作家', categorySlug: 'tongren', description: '重生到三国乱世，面对群雄逐鹿的天下大势。一个现代人凭借对历史的了解，在这乱世中寻找自己的立足之地。', chapters: 7, status: 'ongoing' },
];

async function main() {
  const categories = await db.category.findMany({ select: { id: true, slug: true } });
  const slugToId = new Map(categories.map(c => [c.slug, c.id]));

  for (const n of extraNovels) {
    const categoryId = slugToId.get(n.categorySlug);
    if (!categoryId) { console.warn('No category:', n.categorySlug); continue; }
    const sourceUrl = `https://www.101kks.com/book/extra${Date.now().toString(36)}${Math.random().toString(36).slice(2,8)}`;
    const novel = await db.novel.create({
      data: {
        title: n.title, author: n.author, description: n.description, categoryId,
        wordCount: rand(80, 500) * 10000,
        status: n.status ?? 'completed',
        clickCount: rand(5000, 40000), favoriteCount: rand(500, 4000),
        sourceUrl, sourceId: '101kks',
      },
    });
    await db.chapter.createMany({
      data: Array.from({ length: n.chapters }, (_, i) => ({
        title: `第${i+1}章 ${names[i % names.length]}`,
        novelId: novel.id, sortOrder: i + 1,
        wordCount: rand(2000, 5000), content: PLACEHOLDER_CONTENT,
      })),
    });
    console.log(`OK: ${n.title} (${n.categorySlug}) - ${n.chapters} chapters`);
  }

  const total = await db.novel.count();
  const chapters = await db.chapter.count();
  console.log(`Total: ${total} novels, ${chapters} chapters`);
  await db.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
