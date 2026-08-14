/**
 * 采集规则模板库
 *
 * 预置了常见中文小说站的采集规则模板，用户可基于模板快速创建规则。
 * 所有选择器均基于各站点常见布局，实际使用时可能需要微调。
 */

export type TemplateDifficulty = 'easy' | 'medium' | 'hard';

export interface ScrapeTemplate {
  /** 模板唯一标识 */
  id: string;
  /** 模板显示名称 */
  name: string;
  /** 模板描述 */
  description: string;
  /** 站点示例URL */
  siteUrl: string;
  /** 采集引擎 */
  engine: 'cheerio' | 'playwright' | 'firecrawl' | 'agentql' | 'cloud-browser';
  /** 难度等级 */
  difficulty: TemplateDifficulty;
  /** 标签（用于搜索过滤） */
  tags: string[];

  // === 选择器字段（JSON序列化后的SelectorRule格式） ===

  /** 列表页URL模板 */
  listUrl: string;
  /** 列表页选择器: {type:'css'|'xpath'|'regex', value:'...'} */
  listSelector: string;
  /** 书名选择器 */
  bookTitleSelector: string;
  /** 作者选择器 */
  bookAuthorSelector: string;
  /** 分类选择器 */
  bookCategorySelector: string;
  /** 关键词选择器 */
  bookKeywordsSelector: string;
  /** 简介选择器 */
  bookDescriptionSelector: string;
  /** 封面图选择器 */
  bookCoverSelector: string;
  /** 状态选择器(连载/完结) */
  bookStatusSelector: string;
  /** 目录页URL模板 */
  chapterListUrl: string;
  /** 目录列表选择器 */
  chapterListSelector: string;
  /** 章节标题选择器 */
  chapterTitleSelector: string;
  /** 章节链接选择器 */
  chapterLinkSelector: string;
  /** 正文选择器 */
  contentSelector: string;

  // === 策略配置 ===
  scrapeMode: 'incremental' | 'full';
  dedupMode: 'url' | 'title' | 'both';
}

/**
 * 选择器辅助: 创建CSS类型的选择器JSON
 */
function css(value: string): string {
  return JSON.stringify({ type: 'css', value });
}

/**
 * 选择器辅助: 创建XPath类型的选择器JSON
 */
function xpath(value: string): string {
  return JSON.stringify({ type: 'xpath', value });
}

export const SCRAPE_TEMPLATES: ScrapeTemplate[] = [
  // ==================== 1. 笔趣阁系列 (biquge) ====================
  {
    id: 'biquge',
    name: '笔趣阁',
    description: '适用于笔趣阁系列站点（新笔趣阁、笔趣阁5200等），最常见的中文小说站布局',
    siteUrl: 'https://www.xbiquge.la',
    engine: 'cheerio',
    difficulty: 'easy',
    tags: ['笔趣阁', '小说', '热门', '免费'],

    // 列表页: 首页分类列表，每个小说项在 .novelslist dl 中
    listUrl: 'https://www.xbiquge.la/{category}/',
    // 每个小说条目
    listSelector: css('.novelslist dl'),

    // 书籍详情页选择器
    // 书名通常在 h1 标签内
    bookTitleSelector: css('#info h1'),
    // 作者在 p 标签中，格式如 "作者：xxx"
    bookAuthorSelector: css('#info p:first-of-type'),
    // 分类在面包屑导航中
    bookCategorySelector: css('.con_top a:nth-child(2)'),
    // 关键词/标签
    bookKeywordsSelector: css('.tag'),
    // 小说简介
    bookDescriptionSelector: css('#intro'),
    // 封面图
    bookCoverSelector: css('#sidebar img'),
    // 连载状态
    bookStatusSelector: css('#info p:nth-child(2)'),

    // 章节目录
    chapterListUrl: '{bookUrl}',
    // 所有章节列表项
    chapterListSelector: css('#list dl dd a'),
    // 章节标题（从链接文本提取）
    chapterTitleSelector: css('#list dl dd a'),
    // 章节链接
    chapterLinkSelector: css('#list dl dd a'),

    // 正文内容
    // #content 是笔趣阁通用的正文容器
    contentSelector: css('#content'),

    scrapeMode: 'incremental',
    dedupMode: 'url',
  },

  // ==================== 2. 顶点小说 (dingdian) ====================
  {
    id: 'dingdian',
    name: '顶点小说',
    description: '适用于顶点小说网，布局规整，CSS选择器清晰',
    siteUrl: 'https://www.x23us.com',
    engine: 'cheerio',
    difficulty: 'easy',
    tags: ['顶点小说', '小说', '热门', '免费'],

    listUrl: 'https://www.x23us.com/class/{classId}_{page}.html',
    // 小说列表项
    listSelector: css('.l .item'),

    // 书籍详情页
    bookTitleSelector: css('.book_info h1'),
    // 作者信息在指定span中
    bookAuthorSelector: css('.book_info .author a'),
    bookCategorySelector: css('.book_info .cate a'),
    bookKeywordsSelector: css('.book_info .tag'),
    bookDescriptionSelector: css('.book_info .intro'),
    bookCoverSelector: css('.book_info img'),
    bookStatusSelector: css('.book_info .status'),

    // 章节目录
    chapterListUrl: '{bookUrl}',
    chapterListSelector: css('.chapter_list li a'),
    chapterTitleSelector: css('.chapter_list li a'),
    chapterLinkSelector: css('.chapter_list li a'),

    // 正文在 #chaptercontent 中
    contentSelector: css('#chaptercontent'),

    scrapeMode: 'incremental',
    dedupMode: 'url',
  },

  // ==================== 3. 小说旗 (xiaoshuqi) ====================
  {
    id: 'xiaoshuqi',
    name: '小说旗',
    description: '适用于小说旗及其镜像站，支持分类浏览和章节采集',
    siteUrl: 'https://www.xiaoshuqi.com',
    engine: 'cheerio',
    difficulty: 'easy',
    tags: ['小说旗', '小说', '免费'],

    listUrl: 'https://www.xiaoshuqi.com/{category}/',
    // 列表页每个小说卡片
    listSelector: css('.list-group-item'),

    // 书籍详情页
    bookTitleSelector: css('.book-title'),
    bookAuthorSelector: css('.book-author'),
    bookCategorySelector: css('.book-category a'),
    bookKeywordsSelector: css('.book-tags span'),
    bookDescriptionSelector: css('.book-intro'),
    bookCoverSelector: css('.book-cover img'),
    bookStatusSelector: css('.book-status'),

    // 章节目录
    chapterListUrl: '{bookUrl}',
    chapterListSelector: css('.chapter-list a'),
    chapterTitleSelector: css('.chapter-list a'),
    chapterLinkSelector: css('.chapter-list a'),

    // 正文
    contentSelector: css('.read-content'),

    scrapeMode: 'incremental',
    dedupMode: 'url',
  },

  // ==================== 4. 番茄小说 (fanqie) ====================
  {
    id: 'fanqie',
    name: '番茄小说',
    description: '字节跳动旗下番茄小说，内容通过JS动态渲染，需要Playwright引擎',
    siteUrl: 'https://fanqienovel.com',
    engine: 'playwright',
    difficulty: 'hard',
    tags: ['番茄小说', '字节跳动', 'JS渲染', '热门'],

    // 列表页（分类页面）
    listUrl: 'https://fanqienovel.com/page/{categoryId}',
    // 小说卡片列表
    listSelector: css('.novel-item'),

    // 书籍详情页
    bookTitleSelector: css('.book-info h1'),
    bookAuthorSelector: css('.book-info .author-name'),
    bookCategorySelector: css('.book-info .category-tag'),
    bookKeywordsSelector: css('.book-info .tag-list span'),
    bookDescriptionSelector: css('.book-info .book-desc'),
    bookCoverSelector: css('.book-info .book-cover img'),
    bookStatusSelector: css('.book-info .book-status'),

    // 章节目录（动态加载）
    chapterListUrl: '{bookUrl}/catalog',
    chapterListSelector: css('.chapter-item a'),
    chapterTitleSelector: css('.chapter-item a'),
    chapterLinkSelector: css('.chapter-item a'),

    // 正文（JS渲染后可见）
    contentSelector: css('.muye-reader-content'),

    scrapeMode: 'incremental',
    dedupMode: 'url',
  },

  // ==================== 5. 纵横中文网 (zongheng) ====================
  {
    id: 'zongheng',
    name: '纵横中文网',
    description: '百度文学旗下纵横中文网，正版小说平台，反爬较严格',
    siteUrl: 'https://www.zongheng.com',
    engine: 'playwright',
    difficulty: 'hard',
    tags: ['纵横', '百度文学', '正版', 'JS渲染'],

    listUrl: 'https://www.zongheng.com/category/{catId}',
    // 分类列表页的小说卡片
    listSelector: css('.book-list .book-item'),

    // 书籍详情页
    bookTitleSelector: css('.book-info .book-name'),
    bookAuthorSelector: css('.book-info .author a'),
    bookCategorySelector: css('.book-info .cat a'),
    bookKeywordsSelector: css('.book-info .tag-list span'),
    bookDescriptionSelector: css('.book-info .book-desc'),
    bookCoverSelector: css('.book-info .book-cover img'),
    bookStatusSelector: css('.book-info .book-status'),

    // 章节目录
    chapterListUrl: '{bookUrl}/chapter',
    chapterListSelector: css('.chapter-list li a'),
    chapterTitleSelector: css('.chapter-list li a'),
    chapterLinkSelector: css('.chapter-list li a'),

    // 正文（可能需要登录）
    contentSelector: css('.reader-content'),

    scrapeMode: 'incremental',
    dedupMode: 'both',
  },

  // ==================== 6. 起点中文网 (qidian) ====================
  {
    id: 'qidian',
    name: '起点中文网',
    description: '阅文集团旗下起点中文网，最大中文原创平台，反爬严格需Playwright',
    siteUrl: 'https://www.qidian.com',
    engine: 'playwright',
    difficulty: 'hard',
    tags: ['起点', '阅文', '正版', '热门', 'JS渲染', '反爬'],

    listUrl: 'https://www.qidian.com/so/{keyword}.html',
    // 搜索结果列表
    listSelector: css('.book-img-text ul li'),

    // 书籍详情页
    bookTitleSelector: css('.book-info h1 em'),
    bookAuthorSelector: css('.book-info .author a'),
    bookCategorySelector: css('.book-info .tag a'),
    bookKeywordsSelector: css('.book-info .tag span'),
    bookDescriptionSelector: css('.book-info .intro'),
    bookCoverSelector: css('.book-info .book-cover img'),
    bookStatusSelector: css('.book-info .book-status'),

    // 章节目录
    chapterListUrl: '{bookUrl}/catalog',
    chapterListSelector: css('.volume-wrap .cf li a'),
    chapterTitleSelector: css('.volume-wrap .cf li a'),
    chapterLinkSelector: css('.volume-wrap .cf li a'),

    // 正文（VIP章节需要付费）
    contentSelector: css('.j_readContent'),

    scrapeMode: 'incremental',
    dedupMode: 'both',
  },

  // ==================== 7. 通用CSS模板 ====================
  {
    id: 'generic-css',
    name: '通用CSS模板',
    description: '适用于大多数使用标准HTML结构的小说站，使用常见CSS类名匹配',
    siteUrl: '',
    engine: 'cheerio',
    difficulty: 'medium',
    tags: ['通用', 'CSS', '自定义', '新手'],

    listUrl: '',
    // 常见列表项结构
    listSelector: css('.novel-list .item, .book-list .item, .list-item'),

    bookTitleSelector: css('h1.book-title, .book-name, .novel-title, h1'),
    bookAuthorSelector: css('.author, .book-author, [class*="author"]'),
    bookCategorySelector: css('.category, .book-category, .cate'),
    bookKeywordsSelector: css('.tags span, .keywords, .tag'),
    bookDescriptionSelector: css('.intro, .description, .book-desc, .summary'),
    bookCoverSelector: css('.cover img, .book-cover img, .novel-cover img'),
    bookStatusSelector: css('.status, .book-status'),

    chapterListUrl: '{bookUrl}',
    chapterListSelector: css('.chapter-list a, .catalog-list a, #chapterlist a, .listmain dd a'),
    chapterTitleSelector: css('.chapter-list a, .catalog-list a, #chapterlist a, .listmain dd a'),
    chapterLinkSelector: css('.chapter-list a, .catalog-list a, #chapterlist a, .listmain dd a'),

    // 常见正文容器选择器
    contentSelector: css('#content, .content, .read-content, .chapter-content, #chaptercontent, .article-content'),

    scrapeMode: 'incremental',
    dedupMode: 'url',
  },

  // ==================== 8. 通用XPath模板 ====================
  {
    id: 'generic-xpath',
    name: '通用XPath模板',
    description: '使用XPath表达式匹配，适用于CSS选择器难以覆盖的复杂DOM结构',
    siteUrl: '',
    engine: 'cheerio',
    difficulty: 'medium',
    tags: ['通用', 'XPath', '高级', '自定义'],

    listUrl: '',
    // 匹配包含小说链接的列表项
    listSelector: xpath('//div[contains(@class,"novel") or contains(@class,"book")]'),

    // XPath通过文本内容匹配，更加灵活
    bookTitleSelector: xpath('//h1 | //*[@class="title" or @class="name"]'),
    bookAuthorSelector: xpath('//*[contains(@class,"author") or contains(text(),"作者")]'),
    bookCategorySelector: xpath('//*[contains(@class,"category") or contains(@class,"cate")]'),
    bookKeywordsSelector: xpath('//*[contains(@class,"tag") or contains(@class,"keyword")]'),
    bookDescriptionSelector: xpath('//*[contains(@class,"intro") or contains(@class,"desc") or contains(@class,"summary")]'),
    bookCoverSelector: xpath('//img[contains(@class,"cover") or contains(@class,"img")]'),
    bookStatusSelector: xpath('//*[contains(@class,"status") or contains(text(),"连载") or contains(text(),"完结")]'),

    chapterListUrl: '{bookUrl}',
    chapterListSelector: xpath('//div[contains(@class,"chapter")]//a | //dd/a | //li/a[contains(@href,"chapter")]'),
    chapterTitleSelector: xpath('//div[contains(@class,"chapter")]//a | //dd/a | //li/a[contains(@href,"chapter")]'),
    chapterLinkSelector: xpath('//div[contains(@class,"chapter")]//a | //dd/a | //li/a[contains(@href,"chapter")]'),

    // 常见正文容器的XPath
    contentSelector: xpath('//*[@id="content"] | //*[@class="content"] | //*[@class="read-content"] | //*[@id="chaptercontent"]'),

    scrapeMode: 'incremental',
    dedupMode: 'url',
  },

  // ==================== 9. 69书吧 (69shu) ====================
  {
    id: '69shu',
    name: '69书吧',
    description: '适用于69书吧及其镜像站点，结构清晰易于采集',
    siteUrl: 'https://www.69shuba.com',
    engine: 'cheerio',
    difficulty: 'easy',
    tags: ['69书吧', '小说', '免费', '热门'],

    listUrl: 'https://www.69shuba.com/{category}/',
    listSelector: css('.box_con .list_item'),

    bookTitleSelector: css('.book_info h1'),
    bookAuthorSelector: css('.book_info .author'),
    bookCategorySelector: css('.book_info .category'),
    bookKeywordsSelector: css('.book_info .keywords'),
    bookDescriptionSelector: css('.book_info .intro'),
    bookCoverSelector: css('.book_info img'),
    bookStatusSelector: css('.book_info .status'),

    chapterListUrl: '{bookUrl}',
    chapterListSelector: css('.mu_cont li a'),
    chapterTitleSelector: css('.mu_cont li a'),
    chapterLinkSelector: css('.mu_cont li a'),

    contentSelector: css('.txtnav'),

    scrapeMode: 'incremental',
    dedupMode: 'url',
  },

  // ==================== 10. 无弹窗小说 (wutan) ====================
  {
    id: 'wutw',
    name: '无弹窗小说',
    description: '适用于无弹窗小说系列站点，页面结构简洁，正文干扰少',
    siteUrl: 'https://www.wutw.in',
    engine: 'cheerio',
    difficulty: 'easy',
    tags: ['无弹窗', '小说', '免费', '简洁'],

    listUrl: 'https://www.wutw.in/{category}/',
    // 列表页每个小说项
    listSelector: css('.novellist li'),

    bookTitleSelector: css('.detail h1'),
    bookAuthorSelector: css('.detail .info span:first-child'),
    bookCategorySelector: css('.detail .info a'),
    bookKeywordsSelector: css('.detail .tag'),
    bookDescriptionSelector: css('.detail .intro'),
    bookCoverSelector: css('.detail .thumb img'),
    bookStatusSelector: css('.detail .info span:last-child'),

    chapterListUrl: '{bookUrl}',
    chapterListSelector: css('.chapter-list li a'),
    chapterTitleSelector: css('.chapter-list li a'),
    chapterLinkSelector: css('.chapter-list li a'),

    // 正文页面，容器ID为content
    contentSelector: css('#htmlContent'),

    scrapeMode: 'incremental',
    dedupMode: 'url',
  },
];

/**
 * 根据ID查找模板
 */
export function getTemplateById(id: string): ScrapeTemplate | undefined {
  return SCRAPE_TEMPLATES.find((t) => t.id === id);
}

/**
 * 根据搜索关键词过滤模板（匹配名称和标签）
 */
export function searchTemplates(keyword: string): ScrapeTemplate[] {
  if (!keyword) return SCRAPE_TEMPLATES;
  const lower = keyword.toLowerCase();
  return SCRAPE_TEMPLATES.filter(
    (t) =>
      t.name.toLowerCase().includes(lower) ||
      t.description.toLowerCase().includes(lower) ||
      t.tags.some((tag) => tag.toLowerCase().includes(lower))
  );
}
