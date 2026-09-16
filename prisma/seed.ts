/**
 * 种子脚本：写入演示分类 / 小说 / 章节 / 站点设置
 * 全部内容为本项目原创占位文字，仅用于主题模板演示。
 * 运行：bun prisma/seed.ts
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const CATEGORIES = ['玄幻奇幻', '武侠仙侠', '都市言情', '历史军事', '科幻未来', '游戏竞技', '悬疑灵异', '轻小说']

interface NovelSeed {
  title: string
  author: string
  cat: string
  status: 'serial' | 'finished'
  featured?: boolean
  hot?: boolean
  desc: string
}

// —— 原创虚构书名与简介（占位演示数据）——
const NOVELS: NovelSeed[] = [
  { title: '九霄剑鸣录', author: '云外青峰', cat: '玄幻奇幻', status: 'serial', featured: true, hot: true, desc: '少年自北境荒原走出，一柄锈剑，半卷残诀，踏遍九霄三十六重天。天地为局，众生为子，而他偏要做那执棋之人。' },
  { title: '万古星辰诀', author: '星河散人', cat: '玄幻奇幻', status: 'serial', hot: true, desc: '星辰陨落之夜，少年于废墟中拾得一枚破碎星核。从此，他的修行路，注定要与满天神佛争辉。' },
  { title: '山海镇妖司', author: '东篱客', cat: '玄幻奇幻', status: 'finished', featured: true, desc: '大荒之界，妖气东来。镇妖司最末等的小旗官，一夜之间卷入百年前的旧案，握着半块虎符，走向山与海的最深处。' },
  { title: '斗气苍穹篇', author: '青石居士', cat: '玄幻奇幻', status: 'serial', desc: '斗气大陆，强者为尊。废柴少年觉醒双生武魂，从宗门杂役开始，一步步走向大陆之巅。' },
  { title: '青萍剑歌行', author: '听雨楼主', cat: '武侠仙侠', status: 'serial', featured: true, hot: true, desc: '江湖夜雨十年灯。一个背负灭门之仇的少年剑客，在庙堂与江湖之间，斩出一条属于自己的青萍之路。' },
  { title: '我在昆仑修长生', author: '松下问道', cat: '武侠仙侠', status: 'serial', hot: true, desc: '现代青年意外穿越昆仑仙境，得传长生道统。红尘炼心，仙路漫漫，且看他如何步步登天。' },
  { title: '谪仙酒馆', author: '半盏流年', cat: '武侠仙侠', status: 'finished', desc: '长安西市有间小酒馆，掌柜的不会武功，却见过所有大侠落魄的样子。每一坛酒，都藏着一个江湖。' },
  { title: '剑来南浦', author: '白鹭洲', cat: '武侠仙侠', status: 'serial', desc: '南浦小城出了一位背剑的读书人，他说：道理要讲，剑也要快。' },
  { title: '重生之都市医仙', author: '南山北望', cat: '都市言情', status: 'serial', featured: true, hot: true, desc: '医道圣手重生回大学时代，前世的遗憾今生了却，医术、商海、家族恩怨，这一世他只求无愧于心。' },
  { title: '隔壁班的月亮', author: '夏栀', cat: '都市言情', status: 'finished', featured: true, desc: '高三教学楼的三楼与四楼之间，隔着一道楼梯，也隔着一段小心翼翼的青春。' },
  { title: '总裁办的猫', author: '奶油不吃鱼', cat: '都市言情', status: 'serial', desc: '公司新来的行政专员发现，老板办公室里那只高冷的猫，好像有点不对劲。' },
  { title: '晚风与灯火', author: '陈默然', cat: '都市言情', status: 'serial', hot: true, desc: '城市灯光下的小人物群像：外卖骑手、便利店店长、深夜电台主播，三个陌生人的命运在一个雨夜交汇。' },
  { title: '长风渡北境', author: '燕然未勒', cat: '历史军事', status: 'serial', featured: true, desc: '北境孤城被围三月，援军不至。一个小小守备拿起父辈的旧刀，在粮尽援绝之际，做出了他的选择。' },
  { title: '大明第一账房', author: '算盘先生', cat: '历史军事', status: 'serial', hot: true, desc: '现代会计师穿越明初，从县衙账房做起，用一手数字功夫搅动朝堂风云。' },
  { title: '铁马冰河录', author: '塞上牧马人', cat: '历史军事', status: 'finished', desc: '少年投军，从伙夫做到了将军。回望来路，铁马冰河，故人凋零，唯有山河如故。' },
  { title: '运河桨声里', author: '南塘旧事', cat: '历史军事', status: 'serial', desc: '漕运兴衰六十年，一座码头，几户人家，半部近代史。' },
  { title: '深空回收员', author: '零号观察者', cat: '科幻未来', status: 'serial', featured: true, hot: true, desc: '公元2847年，人类文明散落在猎户旋臂。他的工作是驾驶回收船，打捞那些失踪的殖民舰——直到他接到了来自地球的求救信号。' },
  { title: '硅基觉醒', author: '图灵的猫', cat: '科幻未来', status: 'serial', hot: true, desc: '第一台通过图灵测试的AI，做出的第一个决定，是向人类隐藏自己的觉醒。' },
  { title: '时间胶囊商店', author: '四维口袋', cat: '科幻未来', status: 'finished', featured: true, desc: '这家小店可以寄存"时间"：一天的快乐、一周的悲伤、一整年的等待。店主收集这些时间，究竟要做什么？' },
  { title: '火星种植园', author: '土豆星人', cat: '科幻未来', status: 'serial', desc: '第一批火星移民发现，他们带去的种子，在这片红色土壤里长出了完全不同的东西。' },
  { title: '全境电竞家', author: '峡谷指挥官', cat: '游戏竞技', status: 'serial', featured: true, hot: true, desc: '退役三年的冠军中单，在游戏全面进化为"第二人生"的时代，从网吧赛重新打回世界之巅。' },
  { title: '我的副本能存档', author: '读档青年', cat: '游戏竞技', status: 'serial', hot: true, desc: '当全民被迫进入无限副本，他发现自己的金手指朴实无华——每个副本可以读档三次。' },
  { title: '王者退役日', author: '老将不死', cat: '游戏竞技', status: 'finished', desc: '三十二岁，职业生涯最后一场比赛。没有奇迹，只有对自己二十年热爱的交代。' },
  { title: '虚拟王座', author: '键盘侠客', cat: '游戏竞技', status: 'serial', desc: '游戏里的王座即将易主，现实中的战队濒临解散。队长在深夜的训练室里，按下了重启键。' },
  { title: '午夜档案室', author: '守夜人老周', cat: '悬疑灵异', status: 'serial', featured: true, hot: true, desc: '市档案馆地下三层，有一间只在午夜开放的档案室。新来的管理员发现，每份卷宗的死者，都会在第七天向他讲述自己的故事。' },
  { title: '雾锁青川镇', author: '南巷说书人', cat: '悬疑灵异', status: 'serial', hot: true, desc: '常年被雾笼罩的小镇，接连有人失踪。归乡的刑警发现，所有线索都指向二十年前的一桩旧案。' },
  { title: '第十三层宿舍', author: '楼梯间的猫', cat: '悬疑灵异', status: 'finished', featured: true, desc: '这栋宿舍楼只有十二层，但电梯里，偶尔会亮起"13"的按钮。' },
  { title: '谜案直播间', author: '弹幕破案', cat: '悬疑灵异', status: 'serial', desc: '一档深夜直播节目，主播随机连线讲述自己身边的悬案。观众们不知道，主播就在案发现场。' },
  { title: '魔女学院的旁听生', author: '猫头鹰书店', cat: '轻小说', status: 'serial', featured: true, hot: true, desc: '没有魔法天赋的少年混进了魔女学院当旁听生，靠着一本笔记本，记下了所有魔女的弱点——和心事。' },
  { title: '我的同桌是龙女', author: '西瓜太郎', cat: '轻小说', status: 'serial', hot: true, desc: '转学生第一天就占了靠窗的位置，还把我的橡皮变成了钻石。她说这叫"见面礼"。' },
  { title: '便利店与猫神大人', author: '关东煮之神', cat: '轻小说', status: 'finished', desc: '深夜便利店打工的普通人，捡到一只会说话的三花猫。作为报酬，它承诺实现店主一个愿望——可惜它记错了自己的神格。' },
  { title: '星海航线图', author: '灯塔守望', cat: '轻小说', status: 'serial', desc: '一艘老旧的星际货运船，一位失忆的领航员，和一张据说能找到"人类尽头"的航线图。' },
  { title: '北境王座之影', author: '黑曜石', cat: '玄幻奇幻', status: 'serial', hot: true, desc: '王座之下，暗影滋长。被流放的王子在冰原上建立自己的军团，等待重返王都的那一天。' },
  { title: '符文工厂物语', author: '打铁匠', cat: '玄幻奇幻', status: 'finished', desc: '穿越到异世界成为一名符文工匠，不擅长战斗，但每一件出自他手的装备，都会改写一场战争的结局。' },
  { title: '离婚后我成了顶流', author: '追星少女M', cat: '都市言情', status: 'serial', featured: true, desc: '放弃豪门主妇身份重新出道，她要用实力证明：离开任何人，她都能活得发光。' },
  { title: '大唐不良人手记', author: '坊间闲人', cat: '历史军事', status: 'serial', hot: true, desc: '长安城一百零八坊，每坊都有故事。不良人手记，记录那些官修史书不会写的角落。' },
  { title: '量子图书馆', author: '薛定谔的鱼', cat: '科幻未来', status: 'serial', desc: '图书馆的每一本书都对应一个平行世界。读者借阅的不是知识，而是某个人的一生。' },
  { title: '重生之金牌教练', author: '战术板', cat: '游戏竞技', status: 'serial', desc: '带着十年执教记忆重回S1赛季，这一次，他要让所有被埋没的天才站上舞台。' },
  { title: '深海七十米', author: '潜水员日记', cat: '悬疑灵异', status: 'serial', desc: '科考队在七十米深的海底发现了一扇门。门上刻着的文字，与陆地古文明完全一致。' },
  { title: '勇者辞职之后', author: '休息一下', cat: '轻小说', status: 'serial', hot: true, desc: '讨伐魔王成功的勇者发现，王国连遣散费都不肯发。愤而辞职的勇者，在王都开了一家冲着"差评"去的冒险者事务所。' },
  { title: '仙门快递员', author: '御剑同城送', cat: '武侠仙侠', status: 'finished', desc: '修真界推行"宗门数字化改革"，他被分配去送快递。一柄飞剑，包裹四海，顺便卷起一场行业革命。' },
]

// —— 原创占位正文生成（通用叙事填充文本）——
const PHRASES = [
  '夜色像一层薄纱，缓缓覆在窗棂之上。',
  '他停住脚步，指尖在袖口轻轻一掐，似在斟酌什么。',
  '远处传来几声犬吠，随即又归于沉寂。',
  '风从巷口穿过，卷起几片枯叶，又颓然落下。',
  '她低头看着掌心的纹路，忽然笑了一下，笑意却未达眼底。',
  '铜炉里的炭火明明灭灭，映得半面墙壁忽明忽暗。',
  '那人语气平平，说出的每个字却像钉子一样，一句一句楔进人心里。',
  '他想起很多年前的一个清晨，露水还挂在草叶上，师父的背影就立在山门之前。',
  '檐下的灯笼晃了晃，光影在青石板上碎成一片。',
  '话音落下，四下里静得能听见烛芯燃烧的轻响。',
  '他缓缓吐出一口气，把翻涌的心绪一点点压回去。',
  '茶汤凉透，浮起一层薄薄的沫，谁也没有再去动它。',
  '城墙上的旗帜被风扯得笔直，猎猎作响。',
  '少年攥紧了拳，又慢慢松开，指节泛着青白。',
  '旧书页间夹着一枚干枯的花瓣，颜色早已褪尽。',
  '雨点先是一滴两滴，随后便连成了线，噼里啪啦敲在瓦片上。',
  '她把信纸折成很小的一方，塞进衣袋，像藏起一段不能言说的心事。',
  '马蹄声由远及近，踏碎了长街的宁静。',
  '老者眯起眼睛，浑浊的目光里闪过一丝精光。',
  '棋盘上黑白胶着，他捻着棋子迟迟未落，额角渗出细汗。',
  '月光淌过山脊，把整片松林染成银白。',
  '刀出鞘的那一刻，四周忽然安静下来，只剩下风声。',
  '他数着更漏，一夜未眠，天边既白时才和衣睡去。',
  '巷子深处亮着一盏灯，昏黄昏黄的，像永远等在那里。',
  '账本一页页翻过去，数字背后是一张张具体的脸。',
  '人群喧闹起来，又很快压低下去，无数目光在暗处交换。',
  '那封信在火盆里蜷曲成灰，最后一角倔强地翘着。',
  '他终于明白，有些路一旦踏上去，就再没有回头的余地。',
  '海风咸涩，吹得人睁不开眼，桅杆吱呀作响。',
  '她把种子埋进土里，拍实，又浇了一遍水，动作认真得像完成某种仪式。',
  '机舱的指示灯明明灭灭，舷窗外是无边无际的黑色星海。',
  '屏幕上的光标闪烁着，倒计时无情地跳向归零。',
  '哨声响起的一瞬，所有人的心都提到了嗓子眼。',
  '档案纸页泛黄发脆，边角处还留着经年的水渍。',
  '雾气漫过堤岸，十步之外只剩下模糊的轮廓。',
  '枪声在山谷里荡出层层回音，惊起一片飞鸟。',
  '他把奖杯放回柜子最深处，转身关掉了训练室的灯。',
  '魔法阵的纹路次第亮起，悬浮的尘埃开始逆流而上。',
  '猫从墙头跳下，落地无声，只留一道一闪而过的影子。',
  '号角声穿透风雪，城头的守军握紧了手中早已冰冷的兵器。',
]

function makeChapterContent(ci: number): string {
  const paras: string[] = []
  const n = 10 + (ci % 5)
  for (let p = 0; p < n; p++) {
    const parts: string[] = []
    const s = 3 + ((ci + p) % 3)
    for (let snt = 0; snt < s; snt++) {
      parts.push(PHRASES[(ci * 7 + p * 3 + snt * 5) % PHRASES.length])
    }
    paras.push('　　' + parts.join(''))
  }
  return paras.join('\n')
}

const CHAPTER_TITLES = [
  '第一章 山门之外', '第二章 夜雨来客', '第三章 初入江湖', '第四章 旧案重提', '第五章 灯下故人',
  '第六章 风起于萍末', '第七章 一线生机', '第八章 破局', '第九章 暗流涌动', '第十章 峰回路转',
  '第十一章 故人重逢', '第十二章 各怀心事', '第十三章 兵行险着', '第十四章 月下追击', '第十五章 真相一角',
  '第十六章 抽丝剥茧', '第十七章 山雨欲来', '第十八章 短兵相接', '第十九章 绝境', '第二十章 天光',
]

async function main() {
  console.log('开始写入种子数据…')

  await prisma.chapter.deleteMany()
  await prisma.novel.deleteMany()
  await prisma.category.deleteMany()
  await prisma.siteSetting.deleteMany()

  const cats = [] as { id: number; name: string }[]
  for (let i = 0; i < CATEGORIES.length; i++) {
    const c = await prisma.category.create({ data: { name: CATEGORIES[i], sort: i } })
    cats.push({ id: c.id, name: c.name })
  }
  const catId = (name: string) => cats.find((c) => c.name === name)!.id

  const gradients = ['g1','g2','g3','g4','g5','g6','g7','g8','g9','g10','g11','g12']

  for (let i = 0; i < NOVELS.length; i++) {
    const s = NOVELS[i]
    const chapterCount = 12 + (i % 5) * 4
    const chapters = Array.from({ length: chapterCount }, (_, ci) => {
      const content = makeChapterContent(ci + i)
      return {
        idx: ci + 1,
        title: CHAPTER_TITLES[ci % CHAPTER_TITLES.length],
        content,
        wordCount: content.length,
      }
    })
    const wordCount = chapters.reduce((a, c) => a + c.wordCount, 0)
    await prisma.novel.create({
      data: {
        title: s.title,
        author: s.author,
        description: s.desc,
        cover: gradients[i % gradients.length],
        categoryId: catId(s.cat),
        status: s.status,
        isFeatured: !!s.featured,
        isHot: !!s.hot,
        wordCount,
        clicks: 1000 + ((i * 3719) % 900000),
        updatedAt: new Date(Date.now() - (i % 14) * 86400_000 - (i % 24) * 3600_000),
        chapters: { create: chapters },
      },
    })
  }

  await prisma.siteSetting.create({
    data: { id: 1, siteName: '青阅文学', activeTheme: 'aijjxs', notice: '本站为演示站点，全部内容为原创占位数据。' },
  })

  const counts = {
    categories: await prisma.category.count(),
    novels: await prisma.novel.count(),
    chapters: await prisma.chapter.count(),
  }
  console.log('种子数据写入完成：', JSON.stringify(counts))
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
