/**
 * Seed demo data directly into the database (SQLite)
 * Usage: cd /home/z/my-project && bun run scripts/seed-demo-data.ts
 */
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

const CATEGORIES = [
  { name: '玄幻奇幻', slug: 'xuanhuan-qihuan', color: '#8b5cf6', icon: 'Sparkles' },
  { name: '武侠仙侠', slug: 'wuxia-xianxia', color: '#06b6d4', icon: 'Swords' },
  { name: '现代都市', slug: 'dushi', color: '#f59e0b', icon: 'Building2' },
  { name: '历史军事', slug: 'lishi-junshi', color: '#ef4444', icon: 'Shield' },
  { name: '科幻小说', slug: 'kehuan', color: '#3b82f6', icon: 'Rocket' },
  { name: '游戏竞技', slug: 'youxi-jingji', color: '#10b981', icon: 'Gamepad2' },
  { name: '恐怖灵异', slug: 'kongbu-lingyi', color: '#6b7280', icon: 'Ghost' },
  { name: '言情小说', slug: 'yanqing', color: '#ec4899', icon: 'Heart' },
  { name: '动漫同人', slug: 'dongman-tongren', color: '#f97316', icon: 'Palette' },
  { name: '其他类型', slug: 'qita', color: '#64748b', icon: 'Folder' },
];

interface NovelDef {
  title: string;
  author: string;
  categorySlug: string;
  status: 'ongoing' | 'completed' | 'hiatus';
  wordCount: number;
  desc: string;
  sourceUrl?: string;
}

const NOVELS: NovelDef[] = [
  // 玄幻奇幻 (5本)
  { title: '星辰变', author: '我吃西红柿', categorySlug: 'xuanhuan-qihuan', status: 'completed', wordCount: 3440000, desc: '一个资质平庸的少年，偶然获得了一颗神秘的流星泪。从此，他的命运发生了翻天覆地的变化。从凡人界到仙界，再到神界，他一路披荆斩棘，最终成就无上大道。', sourceUrl: 'https://101kks.com/book/12345/' },
  { title: '斗破苍穹', author: '天蚕土豆', categorySlug: 'xuanhuan-qihuan', status: 'completed', wordCount: 5300000, desc: '这里是属于斗气的世界，没有花俏艳丽的魔法，有的，仅仅是繁衍到巅峰的斗气！萧炎，一个天赋异禀却突然跌落谷底的少年，在药老的教导下，一步步走向巅峰。', sourceUrl: 'https://101kks.com/book/23456/' },
  { title: '完美世界', author: '辰东', categorySlug: 'xuanhuan-qihuan', status: 'completed', wordCount: 5080000, desc: '一粒尘可填海，一根草斩尽日月星辰，弹指间翻天覆地。群雄并起，万族林立，诸圣争霸，乱天动地。问苍茫大地，谁主沉浮？', sourceUrl: 'https://101kks.com/book/34567/' },
  { title: '遮天', author: '辰东', categorySlug: 'xuanhuan-qihuan', status: 'completed', wordCount: 5650000, desc: '冰冷与黑暗并存的宇宙深处，九具庞大的龙尸拉着一口青铜古棺，穿过太空。一个少年从地球走出，踏上了追寻永恒的道路。' },
  { title: '诡秘之主', author: '爱潜水的乌贼', categorySlug: 'xuanhuan-qihuan', status: 'completed', wordCount: 3870000, desc: '蒸汽与机械的浪潮中，谁能触及非凡？历史和真实的迷雾里，又是谁在低语？一个穿越到异世界的灵魂，在神秘的灰雾之上，开始了他的非凡之路。' },

  // 武侠仙侠 (5本)
  { title: '凡人修仙传', author: '忘语', categorySlug: 'wuxia-xianxia', status: 'completed', wordCount: 7450000, desc: '一个普通山村少年韩立，偶然之下进入当地江湖小门派，成了一名记名弟子。凭借自身努力和合理的运用各种机缘，历经千辛万苦，终成仙道。' },
  { title: '仙逆', author: '耳根', categorySlug: 'wuxia-xianxia', status: 'completed', wordCount: 4360000, desc: '顺为凡，逆则仙，只在心中一念间。一个资质平庸的少年王林，在残酷的修真世界中艰难前行，最终逆天改命，成就无上仙道。' },
  { title: '一念永恒', author: '耳根', categorySlug: 'wuxia-xianxia', status: 'completed', wordCount: 4230000, desc: '一念成沧海，一念化桑田。一念斩千魔，一念诛万仙。唯我念……永恒。' },
  { title: '求魔', author: '耳根', categorySlug: 'wuxia-xianxia', status: 'completed', wordCount: 3860000, desc: '魔前一叩三千年，回首凡尘不做仙。苏铭的修仙之路，是一条充满坎坷与执着的逆天之路。' },
  { title: '诛仙', author: '萧鼎', categorySlug: 'wuxia-xianxia', status: 'completed', wordCount: 1500000, desc: '天地不仁，以万物为刍狗。张小凡从一个平凡的少年，成长为能够左右天地的大人物。' },

  // 现代都市 (5本)
  { title: '超级兵王', author: '步千帆', categorySlug: 'dushi', status: 'completed', wordCount: 8920000, desc: '他是雇佣兵世界的王者，他是令各国元首头疼的兵王！回到都市，纵横花都。' },
  { title: '最强弃少', author: '鹅是老五', categorySlug: 'dushi', status: 'completed', wordCount: 7310000, desc: '叶默，一个被家族抛弃的弃少，偶得上古传承，从此纵横都市，傲视天下。' },
  { title: '都市极品医神', author: '风会笑', categorySlug: 'dushi', status: 'ongoing', wordCount: 12500000, desc: '五年前，他被陷害入狱，妻子惨死。五年后，他王者归来，医武双绝！' },
  { title: '神级龙卫', author: '花幽山月', categorySlug: 'dushi', status: 'ongoing', wordCount: 10500000, desc: '神秘少年沈浪下山入世，身怀绝世武功，际遇不断。' },
  { title: '我的绝色总裁未婚妻', author: '枯雪', categorySlug: 'dushi', status: 'completed', wordCount: 6280000, desc: '一代兵王回归都市，本想低调生活，却因为一纸婚约卷入了豪门争斗。' },

  // 历史军事 (5本)
  { title: '庆余年', author: '猫腻', categorySlug: 'lishi-junshi', status: 'completed', wordCount: 3800000, desc: '积善之家，必有余庆。庆国二十年，范闲的传奇故事就此展开。' },
  { title: '赘婿', author: '愤怒的香蕉', categorySlug: 'lishi-junshi', status: 'ongoing', wordCount: 5420000, desc: '武朝末年，岁月峥嵘，天下纷乱。一个穿越者成为赘婿后的传奇故事。' },
  { title: '雪中悍刀行', author: '烽火戏诸侯', categorySlug: 'lishi-junshi', status: 'completed', wordCount: 4580000, desc: '北凉世子徐凤年提刀上路，一路向北。江湖之中，庙堂之上，谁才是真正的执棋人？' },
  { title: '琅琊榜', author: '海宴', categorySlug: 'lishi-junshi', status: 'completed', wordCount: 1520000, desc: '麒麟才子梅长苏，以病弱之躯，运筹帷幄，步步为营，为赤焰军洗雪沉冤。' },
  { title: '大明王朝1566', author: '刘和平', categorySlug: 'lishi-junshi', status: 'completed', wordCount: 780000, desc: '嘉靖年间，皇帝与群臣的博弈。展现了大明王朝最辉煌也最黑暗的时代。' },

  // 科幻小说 (5本)
  { title: '三体', author: '刘慈欣', categorySlug: 'kehuan', status: 'completed', wordCount: 880000, desc: '文化大革命如火如荼进行的同时，军方探寻外星文明的绝秘计划「红岸工程」取得了突破性进展。半个世纪后，叶文洁引发的宇宙级生存危机震撼来袭。' },
  { title: '球状闪电', author: '刘慈欣', categorySlug: 'kehuan', status: 'completed', wordCount: 310000, desc: '一个少年的命运被一道球状闪电彻底改变。在他的执着探索下，一个由球状闪电引发的宏大世界逐渐展开。' },
  { title: '深空彼岸', author: '辰东', categorySlug: 'kehuan', status: 'ongoing', wordCount: 3200000, desc: '浩瀚星空，无尽彼岸。一个少年从破败中崛起，踏上了通往星空深处的征途。' },
  { title: '吞噬星空', author: '我吃西红柿', categorySlug: 'kehuan', status: 'completed', wordCount: 4280000, desc: '地球经历大变迁后，一名普通青年罗峰踏上了修炼之路，在宇宙中不断成长。' },
  { title: '修真四万年', author: '卧牛真人', categorySlug: 'kehuan', status: 'completed', wordCount: 8520000, desc: '四万年前，当人类终于撕开了宇宙的黑暗面纱时，发现宇宙深处的妖兽文明早已屹立万年。' },

  // 游戏竞技 (3本)
  { title: '全职高手', author: '蝴蝶蓝', categorySlug: 'youxi-jingji', status: 'completed', wordCount: 5300000, desc: '网游荣耀中被誉为教科书级别的顶尖高手叶修，遭到俱乐部的驱逐。离开之后，他在网吧重新开始，一步步重返巅峰。' },
  { title: '网游之近战法师', author: '蝴蝶蓝', categorySlug: 'youxi-jingji', status: 'completed', wordCount: 2340000, desc: '一个近战法师的故事。顾飞，一个拥有超强反应速度和身手的玩家，在游戏世界中创造了一段传奇。' },
  { title: '绝对交易', author: '偶米粉', categorySlug: 'youxi-jingji', status: 'ongoing', wordCount: 1850000, desc: '在虚拟游戏世界中，一个以交易为生的玩家的成长故事。' },

  // 恐怖灵异 (3本)
  { title: '神秘复苏', author: '佛前献花', categorySlug: 'kongbu-lingyi', status: 'ongoing', wordCount: 3460000, desc: '三年前，一场诡异事件改变了一切。三年后，杨间再次回到了这座熟悉而又陌生的城市。' },
  { title: '我有一座恐怖屋', author: '我会修空调', categorySlug: 'kongbu-lingyi', status: 'completed', wordCount: 3120000, desc: '这是一间恐怖屋，更是一座连接阴阳两界的桥梁。陈歌继承了父母留下的鬼屋，却渐渐发现了隐藏在鬼屋背后的惊天秘密。' },
  { title: '深夜书屋', author: '纯洁滴小龙', categorySlug: 'kongbu-lingyi', status: 'completed', wordCount: 2180000, desc: '一家只在深夜营业的书屋，一个能看见鬼魂的老板。周泽在书屋中见证了无数离奇的故事。' },

  // 言情小说 (4本)
  { title: '何以笙箫默', author: '顾漫', categorySlug: 'yanqing', status: 'completed', wordCount: 160000, desc: '年少相恋，却因误会分离。七年后重逢，何以琛和赵默笙的爱情故事再次展开。' },
  { title: '微微一笑很倾城', author: '顾漫', categorySlug: 'yanqing', status: 'completed', wordCount: 210000, desc: '从网游中相识相知到现实中相恋，贝微微和肖奈的甜蜜爱情故事。' },
  { title: '你是我的荣耀', author: '顾漫', categorySlug: 'yanqing', status: 'completed', wordCount: 280000, desc: '一个是当红女明星，一个是航天设计师。十年前的同学情谊，十年后的重新相遇。' },
  { title: '知否知否应是绿肥红瘦', author: '关心则乱', categorySlug: 'yanqing', status: 'completed', wordCount: 1350000, desc: '穿越成为庶女明兰，在古代大家族中艰难生存，最终收获幸福。' },

  // 动漫同人 (2本)
  { title: '火影之最强老师', author: '林邪', categorySlug: 'dongman-tongren', status: 'completed', wordCount: 1870000, desc: '穿越到火影世界，成为木叶的一名老师。带着现代知识和对剧情的了解，改变了忍界的命运。' },
  { title: '海贼之天赋系统', author: '且听夏风吟', categorySlug: 'dongman-tongren', status: 'ongoing', wordCount: 2450000, desc: '带着天赋系统穿越到海贼王世界。看主角如何在伟大航路上书写属于自己的传说。' },

  // 其他类型 (3本)
  { title: '明朝那些事儿', author: '当年明月', categorySlug: 'qita', status: 'completed', wordCount: 1680000, desc: '以史料为基础，以年代和具体人物为主线，对明朝十七帝和其他王公权贵和小人物的命运进行全景展示。' },
  { title: '盗墓笔记', author: '南派三叔', categorySlug: 'qita', status: 'completed', wordCount: 2860000, desc: '五十年前，一群长沙土夫子挖到一部战国帛书，残篇中记载了一座奇特的战国古墓的位置。由此引出了一段惊心动魄的冒险之旅。' },
  { title: '鬼吹灯', author: '天下霸唱', categorySlug: 'qita', status: 'completed', wordCount: 2500000, desc: '胡八一、王胖子和Shirley杨三人组成的探险小队，在中国各地古墓中经历了一系列惊险刺激的冒险故事。' },
];

// Generate chapter titles for a novel
function generateChapters(novelTitle: string, author: string, count: number): Array<{ title: string; content: string; wordCount: number }> {
  const chapters: Array<{ title: string; content: string; wordCount: number }> = [];
  const chapterNames = [
    '初入江湖', '神秘来客', '暗流涌动', '危机四伏', '绝处逢生',
    '柳暗花明', '风云再起', '惊天秘闻', '生死一线', '破茧成蝶',
    '化险为夷', '深不可测', '惊天一战', '尘埃落定', '新的征程',
    '密室之谜', '天降奇遇', '阴谋初现', '力挽狂澜', '意外收获',
    '独闯龙潭', '峰回路转', '真相大白', '暗夜追击', '水落石出',
    '再起波澜', '强敌现身', '以一敌百', '险中求胜', '苦尽甘来',
    '再入绝境', '故人重逢', '恩怨情仇', '大战在即', '背水一战',
    '绝世宝物', '巧得机缘', '修为精进', '实力大增', '名震天下',
    '风云变幻', '暗藏杀机', '高手过招', '险象环生', '化敌为友',
    '新的威胁', '步步为营', '精心布局', '出其不意', '一鸣惊人',
    '离奇失踪', '千里追查', '深入虎穴', '与虎谋皮', '绝世神功',
  ];

  for (let i = 0; i < count; i++) {
    const chapterNum = i + 1;
    const nameIdx = i % chapterNames.length;
    const title = `第${chapterNum}章 ${chapterNames[nameIdx]}`;
    // Generate realistic-looking content (3-5 paragraphs)
    const paragraphs = 3 + Math.floor(Math.random() * 3);
    const content = Array.from({ length: paragraphs }, () => {
      const len = 80 + Math.floor(Math.random() * 120);
      // Generate pseudo-random Chinese text
      const chars = '天地人和风雷雨电山川河流日月星辰金木水火土东南西北春夏秋冬龙凤虎鹤剑道法术灵力真气经脉丹药法宝妖兽仙人凡人鬼神冥界';
      let text = '';
      for (let j = 0; j < len; j++) {
        text += chars[Math.floor(Math.random() * chars.length)];
      }
      // Add some punctuation
      text = text.split('').map((c, idx) => {
        if (idx > 0 && idx % (8 + Math.floor(Math.random() * 12)) === 0) {
          return ['，', '。', '！', '？', '；', '——', '、'][Math.floor(Math.random() * 7)] + c;
        }
        return c;
      }).join('');
      return text + '。';
    }).join('\n\n');

    chapters.push({
      title,
      content,
      wordCount: content.replace(/\s/g, '').length,
    });
  }
  return chapters;
}

async function main() {
  console.log('🌱 Seeding demo data...');

  // 1. Create categories
  const categoryMap = new Map<string, string>();
  for (const cat of CATEGORIES) {
    const existing = await db.category.findFirst({ where: { OR: [{ slug: cat.slug }, { name: cat.name }] } });
    if (existing) {
      categoryMap.set(cat.slug, existing.id);
      console.log(`  ✅ Category exists: ${cat.name}`);
    } else {
      const created = await db.category.create({
        data: { ...cat, sortOrder: CATEGORIES.indexOf(cat) },
      });
      categoryMap.set(cat.slug, created.id);
      console.log(`  ✅ Created category: ${cat.name}`);
    }
  }

  // 2. Create novels with chapters
  let totalNovels = 0;
  let totalChapters = 0;

  for (const novelDef of NOVELS) {
    const categoryId = categoryMap.get(novelDef.categorySlug);
    if (!categoryId) continue;

    // Check if novel already exists (by title)
    const existing = await db.novel.findFirst({ where: { title: novelDef.title } });
    if (existing) {
      console.log(`  ⏭️  Novel exists: ${novelDef.title}`);
      continue;
    }

    // Generate 20-50 chapters
    const chapterCount = 20 + Math.floor(Math.random() * 31);
    const chapters = generateChapters(novelDef.title, novelDef.author, chapterCount);

    await db.novel.create({
      data: {
        title: novelDef.title,
        author: novelDef.author,
        description: novelDef.desc,
        status: novelDef.status,
        wordCount: novelDef.wordCount,
        categoryId,
        sourceUrl: novelDef.sourceUrl || null,
        sourceId: 'cmtfor4e60000n76g232bg1v1',
        clickCount: Math.floor(Math.random() * 50000),
        favoriteCount: Math.floor(Math.random() * 2000),
        chapters: {
          create: chapters.map((ch, idx) => ({
            title: ch.title,
            content: ch.content,
            wordCount: ch.wordCount,
            sortOrder: idx + 1,
          })),
        },
      },
    });

    totalNovels++;
    totalChapters += chapterCount;
    console.log(`  📖 Created: ${novelDef.title} (${chapterCount} chapters) by ${novelDef.author}`);
  }

  console.log(`\n✅ Seeding complete: ${totalNovels} novels, ${totalChapters} chapters`);
}

main()
  .catch((e) => { console.error('Seeding failed:', e); process.exit(1); })
  .finally(() => db.$disconnect());
