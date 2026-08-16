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

  // === 反爬配置 (R30新增) ===
  /** 预设的反爬配置，应用到创建的规则中 */
  antiCrawlConfig?: string;
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
    // 反爬：基础站点，仅需UA轮换
    antiCrawlConfig: JSON.stringify({
      uaRotation: true, proxy: false, humanBehavior: false,
      dnt: true, captchaStrategy: 'auto', enableCaptchaRetry: true, maxCaptchaRetries: 2,
    }),
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
    // 反爬：JS渲染+签名验证，需要Playwright+人类行为模拟
    antiCrawlConfig: JSON.stringify({
      uaRotation: true, proxy: false, humanBehavior: true,
      dnt: true, captchaStrategy: 'auto', enableCaptchaRetry: true, maxCaptchaRetries: 3,
      acceptLanguage: '', referer: '',
    }),
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
    // 反爬：百度系反爬严格，需要完整反指纹+代理
    antiCrawlConfig: JSON.stringify({
      uaRotation: true, proxy: true, humanBehavior: true,
      dnt: true, captchaStrategy: 'cloudflare', enableCaptchaRetry: true, maxCaptchaRetries: 5,
      acceptLanguage: '', referer: '',
    }),
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
    // 反爬：阅文最高级别反爬，需Obscura+人类行为+代理+CAPTCHA策略
    antiCrawlConfig: JSON.stringify({
      uaRotation: true, proxy: true, humanBehavior: true,
      dnt: true, captchaStrategy: 'cloudflare', enableCaptchaRetry: true, maxCaptchaRetries: 5,
      acceptLanguage: '', referer: '',
    }),
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
    // 反爬：通用模板，使用基础反爬配置
    antiCrawlConfig: JSON.stringify({
      uaRotation: true, proxy: false, humanBehavior: false,
      dnt: false, captchaStrategy: 'auto', enableCaptchaRetry: true, maxCaptchaRetries: 2,
    }),
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
    // 反爬：通用XPath模板，使用基础配置
    antiCrawlConfig: JSON.stringify({
      uaRotation: true, proxy: false, humanBehavior: false,
      dnt: false, captchaStrategy: 'auto', enableCaptchaRetry: true, maxCaptchaRetries: 2,
    }),
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

  // ==================== 11. 123读书网 (123dua) ====================
  {
    id: '123dua',
    name: '123读书网',
    description: '123dua.com 笔趣阁系结构，首页按分类展示小说列表，详情页含章节目录和简介',
    siteUrl: 'https://www.123dua.com',
    engine: 'cheerio',
    difficulty: 'easy',
    tags: ['123读书网', '笔趣阁系', '小说', '免费'],

    listUrl: 'https://www.123dua.com/dudu-32/',
    listSelector: css('dl.B.B1'),

    bookTitleSelector: css('#info h1'),
    bookAuthorSelector: css('#info p:first-of-type'),
    bookCategorySelector: css('#info p:nth-child(3) span:first-of-type'),
    bookKeywordsSelector: css(''),
    bookDescriptionSelector: css('#intro .e'),
    bookCoverSelector: css('#sidebar img'),
    bookStatusSelector: css('#info p:nth-child(3) span:nth-of-type(2)'),

    chapterListUrl: '{bookUrl}',
    chapterListSelector: css('.box_con dl dd a'),
    chapterTitleSelector: css('.box_con dl dd a'),
    chapterLinkSelector: css('.box_con dl dd a'),

    contentSelector: css('#content'),

    scrapeMode: 'incremental',
    dedupMode: 'both',
  },

  // ==================== 12. 不了全看 (blqukan) ====================
  {
    id: 'blqukan',
    name: '不了全看',
    description: 'blqukan.cc 笔趣阁系站点，有地域访问限制，结构为标准笔趣阁布局',
    siteUrl: 'https://www.blqukan.cc',
    engine: 'cheerio',
    difficulty: 'easy',
    tags: ['不了全看', '笔趣阁系', '小说', '地域限制'],

    listUrl: 'https://www.blqukan.cc/sort/1/',
    listSelector: css('.novelslist2 li'),

    bookTitleSelector: css('#info h1'),
    bookAuthorSelector: css('#info p:first-of-type'),
    bookCategorySelector: css('.con_top a:nth-child(2)'),
    bookKeywordsSelector: css(''),
    bookDescriptionSelector: css('#intro'),
    bookCoverSelector: css('#sidebar img'),
    bookStatusSelector: css('#info p:nth-child(2)'),

    chapterListUrl: '{bookUrl}',
    chapterListSelector: css('#list dl dd a'),
    chapterTitleSelector: css('#list dl dd a'),
    chapterLinkSelector: css('#list dl dd a'),

    contentSelector: css('#content'),

    scrapeMode: 'incremental',
    dedupMode: 'both',
  },

  // ==================== 13. 精品小说网 (jpxs123) ====================
  {
    id: 'jpxs123',
    name: '精品小说网',
    description: 'jpxs123.top 精校小说全本站，列表页展示封面+简介卡片，详情页含完整章节目录',
    siteUrl: 'https://jpxs123.top',
    engine: 'cheerio',
    difficulty: 'easy',
    tags: ['精品小说网', '精校小说', '全本', '免费'],

    listUrl: 'https://jpxs123.top/news_last/',
    listSelector: css('.books .bk'),

    bookTitleSelector: css('.book_info h1'),
    bookAuthorSelector: css('.date span'),
    bookCategorySelector: css('.readTop a:nth-child(2)'),
    bookKeywordsSelector: css(''),
    bookDescriptionSelector: css('.infos p'),
    bookCoverSelector: css('.book_info .pic img'),
    bookStatusSelector: css(''),

    chapterListUrl: '{bookUrl}',
    chapterListSelector: css('.book_list li a'),
    chapterTitleSelector: css('.book_list li a'),
    chapterLinkSelector: css('.book_list li a'),

    contentSelector: css('.read_chapterDetail'),

    scrapeMode: 'incremental',
    dedupMode: 'both',
  },

  // ==================== 14. 奇书网 (xqishuta) ====================
  {
    id: 'xqishuta',
    name: '奇书网',
    description: 'xqishuta.org TXT电子书下载站，支持在线阅读，列表页和详情页分离，章节目录在阅读页',
    siteUrl: 'http://www.xqishuta.org',
    engine: 'cheerio',
    difficulty: 'medium',
    tags: ['奇书网', 'TXT下载', '在线阅读', '电子书'],

    listUrl: 'http://www.xqishuta.org/s/new/',
    listSelector: css('.list ul li'),

    bookTitleSelector: css('.detail h1'),
    bookAuthorSelector: css('.detail_info li:nth-child(6)'),
    bookCategorySelector: css('.position a:nth-child(2)'),
    bookKeywordsSelector: css(''),
    bookDescriptionSelector: css('.showInfo p'),
    bookCoverSelector: css('.detail_pic img'),
    bookStatusSelector: css('.detail_info li:nth-child(5)'),

    chapterListUrl: '{chapterReadUrl}',
    chapterListSelector: css('.pc_list ul li a'),
    chapterTitleSelector: css('.pc_list ul li a'),
    chapterLinkSelector: css('.pc_list ul li a'),

    contentSelector: css('#content1'),

    scrapeMode: 'incremental',
    dedupMode: 'both',
  },

  // ==================== 15. 101看书 (101kks) ====================
  {
    id: '101kks',
    name: '101看书',
    description: '101kks.com 繁体中文小说站，JIEQI CMS系统，卡片式列表布局，支持繁简切换',
    siteUrl: 'https://101kks.com',
    engine: 'cheerio',
    difficulty: 'medium',
    tags: ['101看书', '繁体中文', 'JIEQI CMS', '小说'],

    listUrl: 'https://101kks.com/novels/newhot_0_0_1.html',
    listSelector: css('#article_list_content li'),

    bookTitleSelector: css('.booknav2 h1 a'),
    bookAuthorSelector: css('.booknav2 p:first-of-type'),
    bookCategorySelector: css('.bread a:nth-child(2)'),
    bookKeywordsSelector: css('.tagul li a'),
    bookDescriptionSelector: css('.navtxt p'),
    bookCoverSelector: css('.bookimg2 img'),
    bookStatusSelector: css('.booknav2 p:nth-child(3)'),

    chapterListUrl: '{bookUrl}/index.html',
    chapterListSelector: css('.qustime li a'),
    chapterTitleSelector: css('.qustime li a'),
    chapterLinkSelector: css('.qustime li a'),

    contentSelector: css('#txtcontent'),

    scrapeMode: 'incremental',
    dedupMode: 'both',
  },

  // ==================== 16. 精华书阁 (jhsssd) ====================
  {
    id: 'jhsssd',
    name: '精华书阁',
    description: 'jhsssd.com 精华书阁小说站，列表页展示分类/书名/作者/状态/最新章节，详情页为标准笔趣阁系布局，正文在#nr_content中',
    siteUrl: 'https://www.jhsssd.com',
    engine: 'cheerio',
    difficulty: 'easy',
    tags: ['精华书阁', '小说', '免费', '笔趣阁系'],

    listUrl: 'https://www.jhsssd.com/Ranking_lastupdate/',
    listSelector: css('.list_ul li'),

    bookTitleSelector: css('#info h1'),
    bookAuthorSelector: css('#info .small span:first-of-type'),
    bookCategorySelector: css('#info .small span:nth-child(2)'),
    bookKeywordsSelector: css(''),
    bookDescriptionSelector: css('#intro p'),
    bookCoverSelector: css('#sidebar img'),
    bookStatusSelector: css('#info .small span:nth-child(3)'),

    chapterListUrl: '{bookUrl}',
    chapterListSelector: css('#list dl dd a'),
    chapterTitleSelector: css('#list dl dd a'),
    chapterLinkSelector: css('#list dl dd a'),

    contentSelector: css('#nr_content'),

    scrapeMode: 'incremental',
    dedupMode: 'both',
  },

  // ==================== 17. 完本神站 (wbsz) ====================
  {
    id: 'wbsz',
    name: '完本神站',
    description: 'wanbenshenzhan.com 完本神站，表格布局列表页含分类/书名/章节/状态/字数/作者，详情页含完整书籍信息和章节目录',
    siteUrl: 'https://www.wanbenshenzhan.com',
    engine: 'cheerio',
    difficulty: 'easy',
    tags: ['完本神站', '万本神站', '小说', '免费', '表格布局'],

    listUrl: 'https://www.wanbenshenzhan.com/all/0_lastupdate_0_0_1.html',
    listSelector: css('.data-table tbody tr'),

    bookTitleSelector: css('.book-info-detail h1'),
    bookAuthorSelector: css('.book-meta span:first-of-type'),
    bookCategorySelector: css('.book-meta span:nth-child(2)'),
    bookKeywordsSelector: css(''),
    bookDescriptionSelector: css('.book-intro p'),
    bookCoverSelector: css('.book-cover-large img'),
    bookStatusSelector: css('.book-meta .status-badge'),

    chapterListUrl: '{bookUrl}',
    chapterListSelector: css('#chapter-list .chapter-col a'),
    chapterTitleSelector: css('#chapter-list .chapter-col a'),
    chapterLinkSelector: css('#chapter-list .chapter-col a'),

    contentSelector: css('.chapter-content'),

    scrapeMode: 'incremental',
    dedupMode: 'both',
  },

  // ==================== 18. 爱QQ小说 (aiqqx) ====================
  {
    id: 'aiqqx',
    name: '爱QQ小说',
    description: 'aiqqx.com 爱QQ小说，站点受Cloudflare保护需Playwright引擎渲染，基于通用笔趣阁系布局推测选择器',
    siteUrl: 'https://www.aiqqx.com',
    engine: 'playwright',
    difficulty: 'hard',
    tags: ['爱QQ小说', 'Cloudflare', 'JS渲染', '反爬'],

    listUrl: 'https://www.aiqqx.com/',
    // 使用多备选选择器兼容不同可能的布局
    listSelector: css('.novelslist2 li, .novellist li, .list_main li'),

    bookTitleSelector: css('#info h1, .book-info h1, h1.book-title'),
    bookAuthorSelector: css('#info p:first-of-type, .book-info .author, p.author'),
    bookCategorySelector: css('.con_top a:nth-child(2), .book-info .category, p.category'),
    bookKeywordsSelector: css(''),
    bookDescriptionSelector: css('#intro, .book-intro, .intro'),
    bookCoverSelector: css('#sidebar img, .book-cover img, .cover img'),
    bookStatusSelector: css('#info p:nth-child(2), .book-info .status'),

    chapterListUrl: '{bookUrl}',
    chapterListSelector: css('#list dl dd a, .chapter-list a, .listmain dd a'),
    chapterTitleSelector: css('#list dl dd a, .chapter-list a, .listmain dd a'),
    chapterLinkSelector: css('#list dl dd a, .chapter-list a, .listmain dd a'),

    contentSelector: css('#content, .content, .read-content, .chapter-content'),

    scrapeMode: 'incremental',
    dedupMode: 'both',
    // 反爬：Cloudflare保护站点，自动检测并升级引擎
    antiCrawlConfig: JSON.stringify({
      uaRotation: true, proxy: true, humanBehavior: true,
      dnt: true, captchaStrategy: 'cloudflare', enableCaptchaRetry: true, maxCaptchaRetries: 4,
      acceptLanguage: '', referer: '',
    }),
  },

  // ==================== 19. 速读谷 (sudugu) ====================
  {
    id: 'sudugu',
    name: '速读谷',
    description: 'sudugu.org 速读谷小说站，首页卡片式布局展示小说封面/标题/作者/最新章节，详情页含简介和目录列表，正文在.con中',
    siteUrl: 'https://www.sudugu.org',
    engine: 'cheerio',
    difficulty: 'easy',
    tags: ['速读谷', '小说', '免费', '卡片布局'],

    listUrl: 'https://www.sudugu.org/',
    listSelector: css('.container > .item'),

    bookTitleSelector: css('.itemtxt h1 a, .itemtxt h3 a'),
    bookAuthorSelector: css('.itemtxt p a'),
    bookCategorySelector: css('.itemtxt p span:nth-child(2)'),
    bookKeywordsSelector: css(''),
    bookDescriptionSelector: css('.des.bb p'),
    bookCoverSelector: css('.item > a > img'),
    bookStatusSelector: css('.itemtxt p span:first-child'),

    chapterListUrl: '{bookUrl}#dir',
    chapterListSelector: css('#list.dir ul li a'),
    chapterTitleSelector: css('#list.dir ul li a'),
    chapterLinkSelector: css('#list.dir ul li a'),

    contentSelector: css('.con'),

    scrapeMode: 'incremental',
    dedupMode: 'both',
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
