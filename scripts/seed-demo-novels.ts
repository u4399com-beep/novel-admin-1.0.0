/**
 * seed-demo-novels.ts
 * Populates the database with 65+ demo novels (5 per category × 13 categories)
 * Each novel gets 3-10 chapters with placeholder content.
 * Idempotent: checks by sourceUrl before creating duplicates.
 */

import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

// ──────────────────────── Helpers ──────────────────────────────────────────────

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const PLACEHOLDER_CONTENT = `
清晨的第一缕阳光透过窗棂洒落在青石铺就的小径上，空气中弥漫着泥土与花草的清新气息。远处传来几声悠长的钟声，打破了山间寺庙的宁静。一位身着青衫的年轻人正沿着蜿蜒的山路拾级而上，他的目光坚毅而深邃，仿佛在寻找着什么。

路旁的古松苍翠挺拔，枝叶间偶尔传来几声清脆的鸟鸣。山间的雾气还未完全散去，如同一层薄纱笼罩着整座山峰。年轻人停下脚步，深深地吸了一口气，感受着这里灵气的充沛。他知道，这里将是他修行路上的重要一站。

溪水从山涧中潺潺流下，清澈见底的溪水中偶尔可以看到几条银色的小鱼在石头间穿梭。年轻人蹲下身来，捧起一捧溪水洗了洗脸，冰凉的溪水让他精神一振。站起身来，他继续沿着山路向上攀登，每一步都走得沉稳而有力。

山谷中隐约可见几座古朴的亭台楼阁，飞檐翘角，雕梁画栋，在云雾中若隐若现，宛如仙境一般。一阵微风吹过，带来远处隐约的诵经声，声音悠远绵长，令人心神宁静。年轻人加快了脚步，心中充满了期待。
`;

interface ChapterSeed {
  title: string;
  wordCount: number;
}

interface NovelSeed {
  title: string;
  author: string;
  description: string;
  categorySlug: string;
  wordCount: number;
  status: 'ongoing' | 'completed';
  clickCount: number;
  favoriteCount: number;
  chapters: ChapterSeed[];
}

// ──────────────────────── Novel data per category ─────────────────────────────

function makeChapters(prefix: string, count: number): ChapterSeed[] {
  const names = [
    '初入江湖', '风云初动', '暗流涌动', '一剑破空', '绝地反击',
    '迷雾重重', '真相大白', '巅峰对决', '涅槃重生', '终章',
    '缘起', '命运之轮', '星陨之夜', '万剑归宗', '天地浩劫',
    '破茧', '沧海横流', '大浪淘沙', '长风破浪', '归途',
  ];
  const chapters: ChapterSeed[] = [];
  for (let i = 0; i < count; i++) {
    chapters.push({
      title: `第${i + 1}章 ${names[i % names.length]}`,
      wordCount: rand(2000, 5000),
    });
  }
  return chapters;
}

const novels: NovelSeed[] = [
  // ── 言情小说 (yanqing) ──
  {
    title: '庆余年', author: '猫腻', categorySlug: 'yanqing',
    description: '积善之家，必有余庆，留余庆，留余庆，忽遇恩人；幸娘亲，幸娘亲，积得阴功。一个从现代社会穿越到古代的少年范闲的故事，权谋与爱情交织的宏大叙事。',
    wordCount: rand(300, 500) * 10000, status: 'completed', clickCount: rand(10000, 50000), favoriteCount: rand(1000, 5000),
    chapters: makeChapters('庆余年', 8),
  },
  {
    title: '锦衣之下', author: '蓝色狮', categorySlug: 'yanqing',
    description: '天生六亲缘浅的锦衣卫陆绎，与天赋异禀的六扇门小捕快袁今夏，两人因一桩桩案件相识相知，在朝堂与江湖间谱写一段深情爱恋。',
    wordCount: rand(80, 120) * 10000, status: 'completed', clickCount: rand(5000, 30000), favoriteCount: rand(500, 3000),
    chapters: makeChapters('锦衣之下', 6),
  },
  {
    title: '星汉灿烂', author: '关心则乱', categorySlug: 'yanqing',
    description: '一个被遗落在乡间的少女程少商，在乱世中凭借智慧与坚韧成长，与少年将军凌不疑从相遇到相知，书写一段波澜壮阔的乱世情缘。',
    wordCount: rand(100, 150) * 10000, status: 'completed', clickCount: rand(8000, 40000), favoriteCount: rand(800, 4000),
    chapters: makeChapters('星汉灿烂', 7),
  },
  {
    title: '知否知否应是绿肥红瘦', author: '关心则乱', categorySlug: 'yanqing',
    description: '穿越到古代名门世家庶女明兰身上的现代女性，在礼教森严的古代社会中，凭借聪慧与隐忍步步为营，最终收获美满人生与真挚爱情。',
    wordCount: rand(150, 200) * 10000, status: 'completed', clickCount: rand(15000, 50000), favoriteCount: rand(2000, 5000),
    chapters: makeChapters('知否', 9),
  },
  {
    title: '梦华录', author: '关汉卿（原著改编）', categorySlug: 'yanqing',
    description: '茶坊掌柜赵盼儿与好姐妹宋引章、孙三娘在东京汴梁城开创事业，三位女性在困境中相互扶持，在商场与情场中展现古代女性独立自强的风采。',
    wordCount: rand(40, 80) * 10000, status: 'ongoing', clickCount: rand(5000, 25000), favoriteCount: rand(300, 2000),
    chapters: makeChapters('梦华录', 5),
  },

  // ── 都市小说 (dushi) ──
  {
    title: '大奉打更人', author: '卖报小郎君', categorySlug: 'dushi',
    description: '大奉王朝，一个警校毕业的年轻人许七安穿越到了这个似是而非的古代世界，从一个小小的打更人做起，一步步揭开重重迷雾，守护一方百姓。',
    wordCount: rand(350, 450) * 10000, status: 'completed', clickCount: rand(20000, 50000), favoriteCount: rand(2000, 5000),
    chapters: makeChapters('大奉打更人', 8),
  },
  {
    title: '我师兄实在太稳健了', author: '言归正传', categorySlug: 'dushi',
    description: '李长寿重生到了一个仙侠世界，成了一个不起眼的小人物。他最大的特点就是稳健，凡事都要三思而后行，绝不冒任何风险，却总能在关键时刻化解危机。',
    wordCount: rand(400, 550) * 10000, status: 'completed', clickCount: rand(15000, 45000), favoriteCount: rand(1500, 4000),
    chapters: makeChapters('我师兄', 7),
  },
  {
    title: '赘婿', author: '愤怒的香蕉', categorySlug: 'dushi',
    description: '现代金融巨头穿越到古代成为一个小小的赘婿宁毅，凭借超越时代的知识和胆识，在商海和战场上纵横捭阖，改写命运。',
    wordCount: rand(200, 350) * 10000, status: 'ongoing', clickCount: rand(10000, 40000), favoriteCount: rand(1000, 3500),
    chapters: makeChapters('赘婿', 6),
  },
  {
    title: '万族之劫', author: '老鹰吃小鸡', categorySlug: 'dushi',
    description: '人族与万族共存的世界中，来自地球的年轻人方运意外获得了万界之门的能力，在人族存亡之际挺身而出，带领人族对抗万族入侵。',
    wordCount: rand(500, 650) * 10000, status: 'completed', clickCount: rand(12000, 48000), favoriteCount: rand(1200, 4500),
    chapters: makeChapters('万族之劫', 9),
  },
  {
    title: '全球高武', author: '老鹰吃小鸡', categorySlug: 'dushi',
    description: '武道重现世间，方平从一个普通的高中生开始，在武道修炼的道路上一路狂奔，最终成为全球最顶尖的武者，守护人类文明。',
    wordCount: rand(300, 400) * 10000, status: 'completed', clickCount: rand(8000, 35000), favoriteCount: rand(800, 3000),
    chapters: makeChapters('全球高武', 7),
  },

  // ── 耽美百合 (danmei) ──
  {
    title: '魔道祖师', author: '墨香铜臭', categorySlug: 'danmei',
    description: '夷陵老祖魏无羡与蓝忘机的传奇故事。前世被万人唾骂的修真天才，重生归来后与云深不知处的蓝忘机携手查明前世真相，一段跨越生死的深情。',
    wordCount: rand(100, 150) * 10000, status: 'completed', clickCount: rand(25000, 50000), favoriteCount: rand(3000, 5000),
    chapters: makeChapters('魔道祖师', 8),
  },
  {
    title: '天官赐福', author: '墨香铜臭', categorySlug: 'danmei',
    description: '八百年前的太子殿下谢怜三度飞升，成为天界笑柄。而那个曾为他战死的小花妖，如今已成为令三界闻风丧胆的绝境鬼王花城。一段跨越八百年的深情守候。',
    wordCount: rand(80, 120) * 10000, status: 'completed', clickCount: rand(20000, 50000), favoriteCount: rand(2500, 5000),
    chapters: makeChapters('天官赐福', 7),
  },
  {
    title: '撒野', author: '巫哲', categorySlug: 'danmei',
    description: '蒋丞被寄养家庭退养后来到陌生的钢厂，遇到了放荡不羁的顾飞。两个少年在灰暗的生活中成为彼此的光，在命运的夹缝中拼命生长。',
    wordCount: rand(60, 80) * 10000, status: 'completed', clickCount: rand(15000, 45000), favoriteCount: rand(2000, 4500),
    chapters: makeChapters('撒野', 6),
  },
  {
    title: '破云', author: '淮上', categorySlug: 'danmei',
    description: '刑侦副支队长严峫与神秘卧底江停，在一桩桩惊心动魄的案件中联手追凶。当黑暗的真相逐渐浮出水面，两人之间的信任与感情也在生死考验中不断加深。',
    wordCount: rand(70, 100) * 10000, status: 'completed', clickCount: rand(12000, 40000), favoriteCount: rand(1500, 4000),
    chapters: makeChapters('破云', 7),
  },
  {
    title: '默读', author: 'priest', categorySlug: 'danmei',
    description: '刑警队长骆闻舟与费渡携手调查一系列看似无关却暗藏联系的案件。在层层迷雾中，费渡隐藏的过去逐渐揭开，而两人之间的感情也在危险中悄然升温。',
    wordCount: rand(80, 110) * 10000, status: 'completed', clickCount: rand(10000, 38000), favoriteCount: rand(1200, 3800),
    chapters: makeChapters('默读', 6),
  },

  // ── 穿越转生 (chuanyue) ──
  {
    title: '斗破苍穹', author: '天蚕土豆', categorySlug: 'chuanyue',
    description: '天才少年萧炎在创造了家族空前绝后的修炼纪录后突然成了废人，种种打击接踵而至。就在他即将绝望的时候，一缕灵魂从他手上的戒指里浮现，一段传奇从此开始。',
    wordCount: rand(400, 530) * 10000, status: 'completed', clickCount: rand(30000, 50000), favoriteCount: rand(3000, 5000),
    chapters: makeChapters('斗破苍穹', 10),
  },
  {
    title: '武动乾坤', author: '天蚕土豆', categorySlug: 'chuanyue',
    description: '修炼一途，乃窃阴阳，夺造化，转涅槃，握生死，掌轮回。少年林动从大炎王朝一个小小的家族中走出，踏上了强者之路。',
    wordCount: rand(380, 480) * 10000, status: 'completed', clickCount: rand(20000, 50000), favoriteCount: rand(2000, 5000),
    chapters: makeChapters('武动乾坤', 8),
  },
  {
    title: '大主宰', author: '天蚕土豆', categorySlug: 'chuanyue',
    description: '大千世界，位面交汇，万族林立，群雄荟萃，一位位来自下位面的天之至尊，在这无尽世界，演绎着令人向往的传奇，追求着那主宰之路。',
    wordCount: rand(450, 550) * 10000, status: 'completed', clickCount: rand(15000, 45000), favoriteCount: rand(1500, 4500),
    chapters: makeChapters('大主宰', 7),
  },
  {
    title: '元尊', author: '天蚕土豆', categorySlug: 'chuanyue',
    description: '天地为炉，万物为铜，阴阳为炭，造化为工。少年周元身负家仇族恨，从苍茫大地中崛起，一步步走向那至高无上的主宰之位。',
    wordCount: rand(500, 600) * 10000, status: 'completed', clickCount: rand(12000, 40000), favoriteCount: rand(1200, 4000),
    chapters: makeChapters('元尊', 8),
  },
  {
    title: '逆天邪神', author: '火星引力', categorySlug: 'chuanyue',
    description: '少年云澈，身怀神凰血脉，拥有逆天的天赋和命运。在修真大陆上，他历经磨难，终成一代邪神，逆天改命，掌控天下。',
    wordCount: rand(600, 750) * 10000, status: 'ongoing', clickCount: rand(10000, 38000), favoriteCount: rand(1000, 3500),
    chapters: makeChapters('逆天邪神', 9),
  },

  // ── 青春校园 (qingchun) ──
  {
    title: '最好的我们', author: '八月长安', categorySlug: 'qingchun',
    description: '普通学生耿耿和学霸余淮的故事。因非典时期相识，因分班而同窗，在最好的年纪遇见最好的人，却未必能走到最后。这是属于每个人的青春记忆。',
    wordCount: rand(20, 35) * 10000, status: 'completed', clickCount: rand(8000, 30000), favoriteCount: rand(800, 3000),
    chapters: makeChapters('最好的我们', 6),
  },
  {
    title: '你好旧时光', author: '八月长安', categorySlug: 'qingchun',
    description: '余周周从小就是一个充满想象力的女孩，在成长的道路上，她经历了家庭的变故、友情的考验和爱情的萌芽，最终在旧时光里找到了属于自己的幸福。',
    wordCount: rand(25, 40) * 10000, status: 'completed', clickCount: rand(6000, 28000), favoriteCount: rand(600, 2500),
    chapters: makeChapters('你好旧时光', 5),
  },
  {
    title: '暗恋橘生淮南', author: '八月长安', categorySlug: 'qingchun',
    description: '洛枳暗恋盛淮南，从高中到大学，长达十年的暗恋故事。她把他写进日记，写进考卷，写进每一个不为人知的角落，却始终不敢说出口。',
    wordCount: rand(20, 30) * 10000, status: 'completed', clickCount: rand(7000, 32000), favoriteCount: rand(700, 2800),
    chapters: makeChapters('暗恋橘生淮南', 5),
  },
  {
    title: '时光与你都很甜', author: '千禧蛋挞', categorySlug: 'qingchun',
    description: '校园里最纯粹的美好时光，青春期的青涩悸动，那些年我们一起走过的日子。一群高中生在校园里经历的友情、爱情与成长的故事。',
    wordCount: rand(30, 50) * 10000, status: 'ongoing', clickCount: rand(4000, 20000), favoriteCount: rand(400, 2000),
    chapters: makeChapters('时光与你都很甜', 4),
  },
  {
    title: '我曾那样喜欢你', author: '明前雨后', categorySlug: 'qingchun',
    description: '苏念从初中起就暗恋同班的陆嘉许，这份感情一直延续到高中和大学。在成长的过程中，她学会了如何面对自己的内心，也学会了勇敢地追求自己的幸福。',
    wordCount: rand(25, 40) * 10000, status: 'completed', clickCount: rand(5000, 22000), favoriteCount: rand(500, 2200),
    chapters: makeChapters('我曾那样喜欢你', 5),
  },

  // ── 玄幻魔法 (xuanhuan) ──
  {
    title: '完美世界', author: '辰东', categorySlug: 'xuanhuan',
    description: '一粒尘可填海，一根草斩尽日月星辰，弹指间翻天覆地。群雄并起，万族林立，诸圣争霸，乱天动地。问苍茫大地，谁主沉浮？一个少年从大荒中走出，一切从这里开始。',
    wordCount: rand(500, 600) * 10000, status: 'completed', clickCount: rand(25000, 50000), favoriteCount: rand(2500, 5000),
    chapters: makeChapters('完美世界', 9),
  },
  {
    title: '遮天', author: '辰东', categorySlug: 'xuanhuan',
    description: '冰冷与黑暗并存的宇宙深处，九具庞大的龙尸拉着一口青铜古棺，究竟是回到了远古，还是来到了星空的彼岸？一个浩大的仙侠世界，光怪陆离，神秘无尽。',
    wordCount: rand(500, 580) * 10000, status: 'completed', clickCount: rand(22000, 48000), favoriteCount: rand(2200, 4800),
    chapters: makeChapters('遮天', 8),
  },
  {
    title: '诡秘之主', author: '爱潜水的乌贼', categorySlug: 'xuanhuan',
    description: '蒸汽与机械的浪潮中，谁能触及非凡？在光与影的交织里，谁又是那执掌命运的操偶师？周明瑞穿越到维多利亚时代风格的异世界，成为了一名非凡者。',
    wordCount: rand(350, 450) * 10000, status: 'completed', clickCount: rand(28000, 50000), favoriteCount: rand(3000, 5000),
    chapters: makeChapters('诡秘之主', 10),
  },
  {
    title: '牧神记', author: '宅猪', categorySlug: 'xuanhuan',
    description: '大墟的天空总是黑的，大墟里的人从来不以真面目示人。残老村司药秦牧被村长送入西荒，从此踏入了一个波澜壮阔的修炼世界。',
    wordCount: rand(400, 520) * 10000, status: 'completed', clickCount: rand(15000, 40000), favoriteCount: rand(1500, 4000),
    chapters: makeChapters('牧神记', 7),
  },
  {
    title: '一念永恒', author: '耳根', categorySlug: 'xuanhuan',
    description: '一念成沧海，一念化桑田。一念斩千魔，一念诛万仙。唯我念……永恒。这是一个关于少年白小纯在修真世界中成长的故事。',
    wordCount: rand(380, 470) * 10000, status: 'completed', clickCount: rand(18000, 45000), favoriteCount: rand(1800, 4500),
    chapters: makeChapters('一念永恒', 8),
  },

  // ── 修真武侠 (xiuzhen) ──
  {
    title: '凡人修仙传', author: '忘语', categorySlug: 'xiuzhen',
    description: '一个普通山村小子的修仙之路。韩立出身贫寒，机缘巧合之下踏入修仙界，凭借过人的心性和运气，一步步从一个凡人成长为一代修仙大能。',
    wordCount: rand(700, 850) * 10000, status: 'completed', clickCount: rand(30000, 50000), favoriteCount: rand(3000, 5000),
    chapters: makeChapters('凡人修仙传', 10),
  },
  {
    title: '仙逆', author: '耳根', categorySlug: 'xiuzhen',
    description: '顺为凡，逆则仙，只在心中一念间。一个资质平庸的少年王林，在残酷的修仙世界中艰难前行，最终以逆天之姿踏上仙途巅峰。',
    wordCount: rand(400, 500) * 10000, status: 'completed', clickCount: rand(22000, 48000), favoriteCount: rand(2200, 4800),
    chapters: makeChapters('仙逆', 8),
  },
  {
    title: '求魔', author: '耳根', categorySlug: 'xiuzhen',
    description: '魔前一叩三千年，回首凡尘不做仙。苏铭在命运的漩涡中挣扎求存，为了守护心中所爱，不惜入魔，踏上了一条与众不同的修真之路。',
    wordCount: rand(350, 450) * 10000, status: 'completed', clickCount: rand(15000, 42000), favoriteCount: rand(1500, 4200),
    chapters: makeChapters('求魔', 7),
  },
  {
    title: '剑来', author: '烽火戏诸侯', categorySlug: 'xiuzhen',
    description: '大千世界，无奇不有。一个出身卑微的少年陈平安，带着一把剑，从骊珠洞天走出，踏遍天下，行万里路，只为心中那个简单的道理。',
    wordCount: rand(600, 800) * 10000, status: 'ongoing', clickCount: rand(25000, 50000), favoriteCount: rand(2500, 5000),
    chapters: makeChapters('剑来', 9),
  },
  {
    title: '雪中悍刀行', author: '烽火戏诸侯', categorySlug: 'xiuzhen',
    description: '北凉世子徐凤年初入江湖，一路上结识了各路英雄豪杰。在庙堂与江湖之间，他用一腔热血和一把刀，书写了一段属于北凉的传奇。',
    wordCount: rand(450, 550) * 10000, status: 'completed', clickCount: rand(20000, 48000), favoriteCount: rand(2000, 4800),
    chapters: makeChapters('雪中悍刀行', 8),
  },

  // ── 历史军事 (lishi) ──
  {
    title: '诛仙', author: '萧鼎', categorySlug: 'lishi',
    description: '天地不仁，以万物为刍狗。少年张小凡在一次偶然的机会中得到了天书，从此踏入了一个波澜壮阔的修仙世界，经历了友情、爱情的考验，最终走上了自己的道路。',
    wordCount: rand(150, 200) * 10000, status: 'completed', clickCount: rand(25000, 50000), favoriteCount: rand(2500, 5000),
    chapters: makeChapters('诛仙', 8),
  },
  {
    title: '大秦帝国', author: '孙皓晖', categorySlug: 'lishi',
    description: '全景式展现大秦帝国从崛起一统六国到覆灭的全过程，以恢弘的笔触描绘了那个波澜壮阔的时代，塑造了秦始皇、李斯、蒙恬等一系列鲜活的历史人物。',
    wordCount: rand(500, 600) * 10000, status: 'completed', clickCount: rand(12000, 35000), favoriteCount: rand(1200, 3500),
    chapters: makeChapters('大秦帝国', 7),
  },
  {
    title: '覆手为云', author: '更俗', categorySlug: 'lishi',
    description: '回到北宋末年的现代人，面对靖康之变的即将到来，他如何力挽狂澜，改写历史。在金兵南下的乱世中，凭借超越时代的智慧保家卫国。',
    wordCount: rand(200, 300) * 10000, status: 'completed', clickCount: rand(8000, 28000), favoriteCount: rand(800, 2800),
    chapters: makeChapters('覆手为云', 6),
  },
  {
    title: '铁血残明', author: '柯山梦', categorySlug: 'lishi',
    description: '明朝末年，天下大乱。一个小小的百户武官在这乱世中，凭借铁血手段和远超时代的眼光，从江南到辽东，一步步建立起自己的势力，试图挽救这个即将倾覆的王朝。',
    wordCount: rand(300, 400) * 10000, status: 'ongoing', clickCount: rand(6000, 25000), favoriteCount: rand(600, 2500),
    chapters: makeChapters('铁血残明', 5),
  },
  {
    title: '庆余年（历史版）', author: '猫腻', categorySlug: 'lishi',
    description: '以庆国为背景，讲述了穿越者范闲在古代世界的传奇经历。从一个小小的私生子，到权倾天下的风云人物，范闲的成长历程充满了权谋与智慧。',
    wordCount: rand(300, 450) * 10000, status: 'completed', clickCount: rand(10000, 35000), favoriteCount: rand(1000, 3500),
    chapters: makeChapters('庆余年历史版', 7),
  },

  // ── 游戏竞技 (youxi) ──
  {
    title: '全职高手', author: '蝴蝶蓝', categorySlug: 'youxi',
    description: '网游荣耀中被俱乐部驱逐的顶级操作手叶修，在沉寂了一年之后，于网吧中重新出发。他凭着对荣耀的热爱和十年积累的经验，带领一支草根战队重返巅峰。',
    wordCount: rand(500, 580) * 10000, status: 'completed', clickCount: rand(28000, 50000), favoriteCount: rand(2800, 5000),
    chapters: makeChapters('全职高手', 9),
  },
  {
    title: '王者时刻', author: '蝴蝶蓝', categorySlug: 'youxi',
    description: '在移动电竞蓬勃发展的时代，一群年轻人为梦想而战。从网吧赛到全国总决赛，他们用热血和汗水书写着属于自己的电竞传奇。',
    wordCount: rand(150, 200) * 10000, status: 'completed', clickCount: rand(8000, 30000), favoriteCount: rand(800, 3000),
    chapters: makeChapters('王者时刻', 6),
  },
  {
    title: '从零开始', author: '雷云风暴', categorySlug: 'youxi',
    description: '主角雷震在虚拟网游中从零开始，凭借着机智与运气，以及一群志同道合的伙伴，在游戏中创造了一个又一个的奇迹，最终成为游戏中的顶级玩家。',
    wordCount: rand(800, 1000) * 10000, status: 'completed', clickCount: rand(10000, 35000), favoriteCount: rand(1000, 3500),
    chapters: makeChapters('从零开始', 8),
  },
  {
    title: '网游之近战法师', author: '蝴蝶蓝', categorySlug: 'youxi',
    description: '谁说法师只能远距离施法？顾飞在网游中选择了法师职业，却偏偏用近战的方式战斗。一个不按常理出牌的玩家，在游戏世界中掀起了一场风暴。',
    wordCount: rand(200, 280) * 10000, status: 'completed', clickCount: rand(6000, 25000), favoriteCount: rand(600, 2500),
    chapters: makeChapters('网游之近战法师', 5),
  },
  {
    title: '超神机械师', author: '齐佩甲', categorySlug: 'youxi',
    description: '韩萧穿越到了一个星际游戏世界中，成为了一名NPC。他利用自己的游戏知识和机械天赋，在星海中纵横驰骋，成为令无数玩家敬畏的传奇NPC。',
    wordCount: rand(500, 650) * 10000, status: 'completed', clickCount: rand(12000, 38000), favoriteCount: rand(1200, 3800),
    chapters: makeChapters('超神机械师', 7),
  },

  // ── 科幻空间 (kehuan) ──
  {
    title: '三体', author: '刘慈欣', categorySlug: 'kehuan',
    description: '文化大革命如火如荼地进行时，军方探寻外星文明的绝密计划"红岸工程"取得了突破性进展。半个世纪后，叶文洁在按下发射键的那一刻，彻底改变了人类的命运。',
    wordCount: rand(80, 100) * 10000, status: 'completed', clickCount: rand(30000, 50000), favoriteCount: rand(3000, 5000),
    chapters: makeChapters('三体', 8),
  },
  {
    title: '银河帝国', author: '艾萨克·阿西莫夫', categorySlug: 'kehuan',
    description: '数学家哈里·谢顿开创了"心理史学"，预言银河帝国即将灭亡，一切看似无力回天。然而他制定了"谢顿计划"，试图将三万年的黑暗时代缩短为一千年。',
    wordCount: rand(200, 300) * 10000, status: 'completed', clickCount: rand(15000, 40000), favoriteCount: rand(1500, 4000),
    chapters: makeChapters('银河帝国', 7),
  },
  {
    title: '深空彼岸', author: '辰东', categorySlug: 'kehuan',
    description: '浩瀚宇宙，无尽星空。在科技高度发达的未来，人类踏上了探索深空的旅程。一个少年从地球走出，在星际间书写属于自己的传奇。',
    wordCount: rand(300, 400) * 10000, status: 'ongoing', clickCount: rand(10000, 35000), favoriteCount: rand(1000, 3500),
    chapters: makeChapters('深空彼岸', 6),
  },
  {
    title: '星域四万年', author: '卧牛真人', categorySlug: 'kehuan',
    description: '四万年后的人类文明已经扩展到星域级别。一个出身低微的少年，凭借超凡的意志和机缘，在星际大时代中崛起，最终成为改变星域命运的关键人物。',
    wordCount: rand(400, 500) * 10000, status: 'completed', clickCount: rand(8000, 30000), favoriteCount: rand(800, 3000),
    chapters: makeChapters('星域四万年', 7),
  },
  {
    title: '修真四万年', author: '卧牛真人', categorySlug: 'kehuan',
    description: '未来世界，人类文明高度发达，但修真之路从未断绝。当一个来自地球的少年踏入了这个科技与修真并存的新世界，一段传奇由此展开。',
    wordCount: rand(500, 600) * 10000, status: 'completed', clickCount: rand(12000, 38000), favoriteCount: rand(1200, 3800),
    chapters: makeChapters('修真四万年', 8),
  },

  // ── 悬疑惊悚 (xuanyi) ──
  {
    title: '心理罪', author: '雷米', categorySlug: 'xuanyi',
    description: '犯罪心理天才方木，协助警方破获一桩桩离奇命案。每一个案件背后都隐藏着人性的深渊，而方木用自己的方式照亮了黑暗中的真相。',
    wordCount: rand(80, 120) * 10000, status: 'completed', clickCount: rand(20000, 45000), favoriteCount: rand(2000, 4500),
    chapters: makeChapters('心理罪', 8),
  },
  {
    title: '暗黑者', author: '周浩晖', categorySlug: 'xuanyi',
    description: '一个神秘的连环杀手"暗黑者"在城市中肆意作案，警方成立专案组全力追查。在追凶的过程中，探员们发现每一个受害者都不是无辜的。',
    wordCount: rand(60, 90) * 10000, status: 'completed', clickCount: rand(15000, 40000), favoriteCount: rand(1500, 4000),
    chapters: makeChapters('暗黑者', 7),
  },
  {
    title: '法医秦明', author: '秦明', categorySlug: 'xuanyi',
    description: '资深法医秦明以真实的法医工作为背景，讲述了一个个扣人心弦的案件。通过精密的法医技术，让尸体"说话"，揭开层层迷雾。',
    wordCount: rand(100, 150) * 10000, status: 'completed', clickCount: rand(18000, 45000), favoriteCount: rand(1800, 4500),
    chapters: makeChapters('法医秦明', 8),
  },
  {
    title: '十日游戏', author: '紫金陈', categorySlug: 'xuanyi',
    description: '一场精心策划的绑架游戏，十天之内必须找出真相。当游戏与现实交织，参与者们发现每个人都藏着不可告人的秘密。',
    wordCount: rand(30, 50) * 10000, status: 'completed', clickCount: rand(10000, 35000), favoriteCount: rand(1000, 3500),
    chapters: makeChapters('十日游戏', 5),
  },
  {
    title: '隐秘的角落', author: '紫金陈', categorySlug: 'xuanyi',
    description: '三个孩子在景区游玩时，无意间拍摄到了一场谋杀案。他们本想报警，却一步步被卷入更深的漩涡。善良与邪恶的边界在哪里？',
    wordCount: rand(25, 40) * 10000, status: 'completed', clickCount: rand(22000, 48000), favoriteCount: rand(2200, 4800),
    chapters: makeChapters('隐秘的角落', 6),
  },

  // ── 同人小说 (tongren) ──
  {
    title: '同人：天龙八部之重生', author: '网络作家', categorySlug: 'tongren',
    description: '基于金庸经典《天龙八部》的同人创作。主角意外重生到天龙世界，以全新的视角重新经历那段波澜壮阔的江湖岁月。',
    wordCount: rand(50, 80) * 10000, status: 'ongoing', clickCount: rand(5000, 20000), favoriteCount: rand(500, 2000),
    chapters: makeChapters('天龙八部同人', 5),
  },
  {
    title: '同人：火影之最强', author: '网络作家', categorySlug: 'tongren',
    description: '穿越到火影忍者世界，成为木叶村的一名普通忍者。凭借着对剧情的了解和不懈的努力，一步步成为忍界最强之人。',
    wordCount: rand(80, 120) * 10000, status: 'ongoing', clickCount: rand(6000, 22000), favoriteCount: rand(600, 2200),
    chapters: makeChapters('火影同人', 6),
  },
  {
    title: '同人：海贼之冒险', author: '网络作家', categorySlug: 'tongren',
    description: '在大海贼时代，一个年轻人踏上了寻找传说中的One Piece的旅程。在伟大航路上，他将遇到各种伙伴和敌人。',
    wordCount: rand(60, 100) * 10000, status: 'ongoing', clickCount: rand(4000, 18000), favoriteCount: rand(400, 1800),
    chapters: makeChapters('海贼同人', 5),
  },
  {
    title: '同人：西游之逆天', author: '网络作家', categorySlug: 'tongren',
    description: '假如西游记中的妖怪们不再甘心做炮灰？一只小妖获得了逆天改命的机会，在西行路上书写属于自己的传奇。',
    wordCount: rand(70, 100) * 10000, status: 'ongoing', clickCount: rand(5000, 20000), favoriteCount: rand(500, 2000),
    chapters: makeChapters('西游同人', 6),
  },
  {
    title: '同人：三国之重生', author: '网络作家', categorySlug: 'tongren',
    description: '重生到三国乱世，面对群雄逐鹿的天下大势。一个现代人凭借对历史的了解，在这乱世中寻找自己的立足之地。',
    wordCount: rand(100, 150) * 10000, status: 'ongoing', clickCount: rand(7000, 25000), favoriteCount: rand(700, 2500),
    chapters: makeChapters('三国同人', 7),
  },

  // ── 官场职场 (guanchang) ──
  {
    title: '侯卫东官场笔记', author: '小桥老树', categorySlug: 'guanchang',
    description: '讲述一个普通大学毕业生侯卫东，从基层乡镇干部做起，在官场中摸爬滚打，一步步成长的故事。真实展现了基层官场的生态与潜规则。',
    wordCount: rand(200, 300) * 10000, status: 'completed', clickCount: rand(15000, 40000), favoriteCount: rand(1500, 4000),
    chapters: makeChapters('侯卫东', 8),
  },
  {
    title: '官场之风流人生', author: '更俗', categorySlug: 'guanchang',
    description: '一个年轻人在官场中步步为营，凭借过人的智慧和手腕，在复杂的权力斗争中游刃有余。在事业与情感之间，他该如何抉择？',
    wordCount: rand(150, 250) * 10000, status: 'completed', clickCount: rand(10000, 35000), favoriteCount: rand(1000, 3500),
    chapters: makeChapters('官场风流', 7),
  },
  {
    title: '重生之官路商途', author: '更俗', categorySlug: 'guanchang',
    description: '重生回到1990年代的年轻人，利用对未来的了解，在官场和商界双线发展。每一步棋都精准到位，最终成为左右时代格局的风云人物。',
    wordCount: rand(300, 400) * 10000, status: 'completed', clickCount: rand(12000, 38000), favoriteCount: rand(1200, 3800),
    chapters: makeChapters('官路商途', 8),
  },
  {
    title: '官道无疆', author: '瑞根', categorySlug: 'guanchang',
    description: '从最基层的村干部到掌握一方的封疆大吏，一个普通人如何在官场上披荆斩棘。在权力与责任之间，他坚守着自己的底线与理想。',
    wordCount: rand(250, 350) * 10000, status: 'completed', clickCount: rand(8000, 30000), favoriteCount: rand(800, 3000),
    chapters: makeChapters('官道无疆', 7),
  },
  {
    title: '平步青云', author: '瑞根', categorySlug: 'guanchang',
    description: '年轻人意外获得了一次改变命运的机会，从一名普通科员开始，在官场上平步青云。然而越往上走，他发现官场的真相远比想象中复杂。',
    wordCount: rand(200, 280) * 10000, status: 'ongoing', clickCount: rand(6000, 25000), favoriteCount: rand(600, 2500),
    chapters: makeChapters('平步青云', 6),
  },
];

// ──────────────────────── Main ─────────────────────────────────────────────────

async function main() {
  console.log('Seeding demo novels...');

  // Build category slug → id map
  const categories = await db.category.findMany({ select: { id: true, slug: true } });
  const slugToId = new Map(categories.map(c => [c.slug, c.id]));
  console.log(`Found ${categories.length} categories`);

  let created = 0;
  let skipped = 0;

  for (const novel of novels) {
    const categoryId = slugToId.get(novel.categorySlug);
    if (!categoryId) {
      console.warn(`  [SKIP] No category for slug "${novel.categorySlug}"`);
      skipped++;
      continue;
    }

    const sourceUrl = `https://www.101kks.com/book/${Buffer.from(novel.title).toString('hex').slice(0, 12)}`;

    // Idempotency: check by sourceUrl
    const existing = await db.novel.findFirst({ where: { sourceUrl } });
    if (existing) {
      skipped++;
      continue;
    }

    const createdNovel = await db.novel.create({
      data: {
        title: novel.title,
        author: novel.author,
        description: novel.description,
        categoryId,
        wordCount: novel.wordCount,
        status: novel.status,
        clickCount: novel.clickCount,
        favoriteCount: novel.favoriteCount,
        sourceUrl,
        sourceId: '101kks',
      },
    });

    // Create chapters
    if (novel.chapters.length > 0) {
      await db.chapter.createMany({
        data: novel.chapters.map((ch, i) => ({
          title: ch.title,
          novelId: createdNovel.id,
          sortOrder: i + 1,
          wordCount: ch.wordCount,
          content: PLACEHOLDER_CONTENT,
        })),
      });
    }

    created++;
    console.log(`  [OK] ${novel.title} (${novel.categorySlug}) - ${novel.chapters.length} chapters`);
  }

  console.log(`\nDone! Created: ${created}, Skipped: ${skipped}`);

  // Summary
  const totalNovels = await db.novel.count();
  const totalChapters = await db.chapter.count();
  console.log(`Total in DB: ${totalNovels} novels, ${totalChapters} chapters`);

  await db.$disconnect();
}

main().catch(err => {
  console.error('Seed error:', err);
  process.exit(1);
});
