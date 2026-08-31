import { db } from '@/lib/db';
import { NextRequest } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { apiSuccess, apiError } from '@/lib/api-utils';

// ═══════════════════════════════════════════════════════════════════
// Seed data definitions
// ═══════════════════════════════════════════════════════════════════

const MANUAL_LINKS = [
  { title: '笔趣阁', url: 'https://www.biquge.com.cn/', description: '热门小说在线阅读', sortOrder: 1 },
  { title: '番茄小说', url: 'https://fanqienovel.com/', description: '免费精品小说平台', sortOrder: 2 },
  { title: '起点中文网', url: 'https://www.qidian.com/', description: '原创文学平台', sortOrder: 3 },
  { title: '纵横中文网', url: 'https://www.zongheng.com/', description: '热门小说阅读', sortOrder: 4 },
  { title: '17K小说', url: 'https://www.17k.com/', description: '网络文学平台', sortOrder: 5 },
  { title: '晋江文学城', url: 'https://www.jjwxc.net/', description: '原创言情文学', sortOrder: 6 },
  { title: '潇湘书院', url: 'https://www.xxsy.net/', description: '言情小说基地', sortOrder: 7 },
  { title: '书旗小说', url: 'https://www.shuqi.com/', description: '免费小说阅读', sortOrder: 8 },
  { title: '飞卢小说', url: 'https://www.faloo.com/', description: '原创同人小说', sortOrder: 9 },
  { title: '看书网', url: 'https://www.kanshu.com/', description: '海量小说在线读', sortOrder: 10 },
];

const SITE_HOME_LINKS = [
  { title: '看书吧', url: 'https://site-a.example.com/', description: '站群站点A', sortOrder: 1 },
  { title: '小说屋', url: 'https://site-b.example.com/', description: '站群站点B', sortOrder: 2 },
  { title: '书荒网', url: 'https://site-c.example.com/', description: '站群站点C', sortOrder: 3 },
  { title: '免费小说', url: 'https://site-d.example.com/', description: '站群站点D', sortOrder: 4 },
  { title: '读好书', url: 'https://site-e.example.com/', description: '站群站点E', sortOrder: 5 },
  { title: '万卷书', url: 'https://site-f.example.com/', description: '站群站点F', sortOrder: 6 },
  { title: '墨香阁', url: 'https://site-g.example.com/', description: '站群站点G', sortOrder: 7 },
  { title: '天书阁', url: 'https://site-h.example.com/', description: '站群站点H', sortOrder: 8 },
  { title: '阅文斋', url: 'https://site-i.example.com/', description: '站群站点I', sortOrder: 9 },
  { title: '聚书阁', url: 'https://site-j.example.com/', description: '站群站点J', sortOrder: 10 },
  { title: '藏书楼', url: 'https://site-k.example.com/', description: '站群站点K', sortOrder: 11 },
  { title: '品书网', url: 'https://site-l.example.com/', description: '站群站点L', sortOrder: 12 },
  { title: '书香阁', url: 'https://site-m.example.com/', description: '站群站点M', sortOrder: 13 },
  { title: '畅读书', url: 'https://site-n.example.com/', description: '站群站点N', sortOrder: 14 },
  { title: '爱小说', url: 'https://site-o.example.com/', description: '站群站点O', sortOrder: 15 },
];

// ═══════════════════════════════════════════════════════════════════
// Seed function (can also be called internally)
// ═══════════════════════════════════════════════════════════════════

export async function seedFriendlyLinks() {
  const existingCount = await db.friendlyLink.count();
  if (existingCount > 0) {
    return { existing: existingCount, created: 0 };
  }

  await db.$transaction([
    ...MANUAL_LINKS.map((link) =>
      db.friendlyLink.create({
        data: {
          title: link.title,
          url: link.url,
          description: link.description,
          linkType: 'manual',
          sortOrder: link.sortOrder,
          enabled: true,
          nofollow: false,
        },
      })
    ),
    ...SITE_HOME_LINKS.map((link) =>
      db.friendlyLink.create({
        data: {
          title: link.title,
          url: link.url,
          description: link.description,
          linkType: 'site_home',
          sortOrder: link.sortOrder,
          enabled: true,
          nofollow: true,
        },
      })
    ),
  ]);

  return { existing: 0, created: MANUAL_LINKS.length + SITE_HOME_LINKS.length };
}

// ═══════════════════════════════════════════════════════════════════
// API Route
// ═══════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/seed-links
 *
 * Seeds friendly links data (idempotent — skips if data already exists).
 */
export const GET = withAuth(async function GET(_request: NextRequest) {
  try {
    const result = await seedFriendlyLinks();
    return apiSuccess({
      message: result.created > 0
        ? `成功插入 ${result.created} 条友情链接`
        : `已有 ${result.existing} 条友情链接，跳过插入`,
      ...result,
    });
  } catch (error) {
    console.error('Seed friendly links error:', error);
    return apiError('友情链接种子数据插入失败');
  }
});
