import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function seed() {
  // Create categories
  const cats = ['玄幻', '修真', '都市', '历史', '科幻', '悬疑', '游戏', '武侠'];
  for (const name of cats) {
    await prisma.category.upsert({
      where: { slug: name },
      update: {},
      create: { name, slug: name, color: '#3b82f6', sortOrder: cats.indexOf(name) }
    });
  }
  console.log('Categories seeded:', cats.length);

  // Create novels
  const catRecords = await prisma.category.findMany();
  const novels = [
    { title: '斗破苍穹', author: '天蚕土豆', desc: '三十年河东三十年河西，莫欺少年穷！', status: 'completed' },
    { title: '凡人修仙传', author: '忘语', desc: '一个普通山村少年，偶然下进入当地江湖小门派。', status: 'completed' },
    { title: '遮天', author: '辰东', desc: '冰冷与黑暗并存的宇宙深处，九具庞大的龙尸拉着一口青铜巨棺。', status: 'completed' },
    { title: '完美世界', author: '辰东', desc: '一粒尘可填海，一根草斩尽日月星辰。', status: 'completed' },
    { title: '斗罗大陆', author: '唐家三少', desc: '唐门外门弟子唐三，因偷学内门绝学。', status: 'completed' },
    { title: '诡秘之主', author: '爱潜水的乌贼', desc: '蒸汽与机械的浪潮中，谁能触及非凡？', status: 'completed' },
    { title: '一念永恒', author: '耳根', desc: '一念成沧海，一念化桑田。', status: 'ongoing' },
    { title: '牧神记', author: '宅猪', desc: '大墟里，天黑别出门。', status: 'ongoing' },
    { title: '大王饶命', author: '会说话的肘子', desc: '灵气复苏的时代，寂静生活步步远离。', status: 'completed' },
    { title: '雪中悍刀行', author: '烽火戏诸侯', desc: '北凉世子徐凤年，惨淡中崛起。', status: 'completed' },
    { title: '庆余年', author: '猫腻', desc: '积善之家，必有余庆。', status: 'completed' },
    { title: '将夜', author: '猫腻', desc: '一段可歌可泣可笑可爱的荒唐故事。', status: 'completed' },
  ];

  for (let i = 0; i < novels.length; i++) {
    const n = novels[i];
    const cat = catRecords[i % catRecords.length];
    const existing = await prisma.novel.findFirst({ where: { title: n.title } });
    if (existing) { console.log(`Skip existing: ${n.title}`); continue; }
    
    const novel = await prisma.novel.create({
      data: {
        title: n.title,
        author: n.author,
        description: n.desc,
        status: n.status,
        category: { connect: { id: cat.id } },
        wordCount: Math.floor(Math.random() * 3000000) + 500000,
        clickCount: Math.floor(Math.random() * 100000),
        favoriteCount: Math.floor(Math.random() * 10000),
      }
    });

    // Create chapters in batches
    const chCount = 20 + Math.floor(Math.random() * 30);
    const batch = [];
    for (let j = 0; j < chCount; j++) {
      batch.push({
        novelId: novel.id,
        title: `第${j+1}章`,
        content: `这是${n.title}的第${j+1}章内容。\n\n`.repeat(10) + '本章完。',
        wordCount: 2000 + Math.floor(Math.random() * 3000),
        sortOrder: j + 1,
      });
    }
    await prisma.chapter.createMany({ data: batch });
    console.log(`Novel: ${n.title} (${chCount} chapters)`);
  }
  
  const totalNovels = await prisma.novel.count();
  const totalChapters = await prisma.chapter.count();
  console.log(`\nTotal: ${totalNovels} novels, ${totalChapters} chapters`);
  await prisma.$disconnect();
}

seed().catch(e => { console.error(e); process.exit(1); });
