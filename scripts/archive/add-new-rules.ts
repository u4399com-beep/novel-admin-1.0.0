/**
 * 新增 4 站采集规则（用户指令：在站点首页「最近更新/最新入库」模块基础上编写规则）：
 *   1. 5165.org        大悟读书网（WordPress 结构，首页板块即书列表，全站直连）
 *   2. 23uswx.la       顶点小说（杰奇结构，#newscontent .l 最新更新小说模块，直连）
 *   3. 38.34.172.127   夜伴书屋（裸 IP 自签证书，insecureTLS；仅首页可达，书页/分类页源站 403 → 草稿停用）
 *   4. ixdzs8.com      爱下电子书（现代自建 CMS，章节页 JS token 挑战 + JSON 目录接口 chapterListApi）
 *
 * 幂等：按 name upsert（存在即更新规则内容，任务关联不受影响）。
 */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

const IXDZS_CLIST_API = JSON.stringify({
  url: '/novel/clist/',
  method: 'POST',
  body: 'bid={bookId}',
  bookIdSelector: '#bid@value',
  listPath: 'data',
  titleField: 'title',
  orderField: 'ordernum',
  skipField: 'ctype',
  skipValue: '1',
  urlTemplate: '/read/{bookId}/p{order}.html',
})

const RULES = [
  {
    name: '大悟读书网(5165)',
    siteUrl: 'https://5165.org/',
    enabled: true,
    charset: 'utf-8',
    proxy: '',
    insecureTLS: false,
    listRule: {
      itemSelector: '.entry-content ul li',
      // 置顶推荐项标题在 p.text-muted.text-centered>a，其余板块在首个 a 内（备选语义逐个尝试）
      titleSelector: 'p a, a',
      linkSelector: 'a',
      authorSelector: 'span.text-muted',
    },
    bookRule: {
      titleSelector: 'h1.page-title',
      authorSelector: '#category-description-author',
      descriptionSelector: '#category-description-text',
      coverSelector: '#category-description-image img@src',
      chapterLinkSelector: 'a[rel="contents"]',
    },
    chapterRule: { titleSelector: 'h1', contentSelector: '.entry-content' },
    notes:
      '2026-09 实测（首页最近更新模块）：WordPress 结构，首页=置顶推荐+热门小说+13 个分类板块（li>a+span.text-muted），' +
      '列表项图片卡标题走 p a 备选；书页 #category-description-* 三件套+全量目录 a[rel=contents]（151 章实测，单页无分页）；' +
      '章节正文 .entry-content。首页为静态 front page（/page/2/ 404），无翻页模板。',
  },
  {
    name: '顶点小说(23uswx)',
    siteUrl: 'http://www.23uswx.la/',
    enabled: true,
    charset: 'utf-8',
    proxy: '',
    insecureTLS: false,
    listRule: {
      itemSelector: '#newscontent .l ul li',
      titleSelector: '.s2 a',
      linkSelector: '.s2 a',
      authorSelector: '.s4',
      categorySelector: '.s1',
    },
    bookRule: {
      titleSelector: 'h1',
      authorSelector: 'meta[property="og:novel:author"]@content',
      descriptionSelector: '#intro',
      coverSelector: '#fmimg img@src',
      chapterLinkSelector: '#list dl dd a',
    },
    chapterRule: { titleSelector: 'h1', contentSelector: '#content' },
    notes:
      '2026-09 实测（首页最新更新小说模块）：杰奇结构（与顶点系模板同源），#newscontent .l 五段式列表' +
      '（s1 分类/s2 书链/s3 最新章/s4 作者/s5 时间）；书页 og:novel:* meta 齐全+#intro+#fmimg+#list dl dd 全目录；' +
      '章节页 h1+#content，正文头部「最新网址：www.…」广告行由 clean.ts URL_LINE 短行规则清除；' +
      '书 URL 形如 /145_145762/。响应强制 gzip，直连即可。',
  },
  {
    name: '夜伴书屋(38.34.172.127)',
    siteUrl: 'https://38.34.172.127/',
    enabled: false,
    charset: 'utf-8',
    proxy: '',
    insecureTLS: true,
    listRule: {
      itemSelector: '.panel .col-md-12.item',
      titleSelector: 'a.float-left',
      linkSelector: 'a.float-left',
      authorSelector: 'span.dark.float-right',
    },
    bookRule: {
      titleSelector: 'h1',
      authorSelector: 'meta[property="og:novel:author"]@content',
      descriptionSelector: '#intro',
      coverSelector: 'meta[property="og:image"]@content',
      chapterLinkSelector: '#list dl dd a',
    },
    chapterRule: { titleSelector: 'h1', contentSelector: '#content' },
    notes:
      '2026-09 探测结论（草稿停用）：站点以裸 IP 提供服务，证书 CN 与 IP 不匹配 → insecureTLS=true 由引擎旁路。' +
      '首页(/index.html)「最新入库」模块可正常采集（列表规则实测可用）；但 /book/{id} 书页与 /list/*.html 分类页在源站' +
      '一律 403（curl/真实浏览器/bun fetch 复测一致，http:80 为宝塔空主机头），规范域名 www.ybswo.com 全站在 Cloudflare ' +
      '挑战之后（引擎 browser 策略亦未通过）。书页/章节选择器按帝国 CMS 惯例预置，待站点恢复后启用规则即可运行。',
  },
  {
    name: '爱下电子书(ixdzs8)',
    siteUrl: 'https://ixdzs8.com/',
    enabled: true,
    charset: 'utf-8',
    proxy: '',
    insecureTLS: false,
    listRule: {
      // 首页最近更新模块为 ul.u-line li，专页 /new/ 为 ul.u-list li.burl（备选语义：逐页命中其一）
      itemSelector: 'ul.u-line li, ul.u-list li.burl',
      titleSelector: '.l-name h3.bname a, h3.bname a',
      linkSelector: '.l-name a, h3.bname a',
      authorSelector: '.l-author .bauthor a, .bauthor a',
      categorySelector: '.l-sort a',
    },
    bookRule: {
      titleSelector: 'h1',
      authorSelector: 'meta[property="og:novel:author"]@content',
      descriptionSelector: '.pintro',
      coverSelector: 'meta[property="og:image"]@content',
      statusSelector: 'meta[property="og:novel:status"]@content',
      chapterLinkSelector: 'ul.u-chapter.cfirst li a',
      chapterListApi: IXDZS_CLIST_API,
    },
    chapterRule: {
      titleSelector: 'h1',
      contentSelector: '.page-content section, .page-content',
    },
    notes:
      '2026-09 实测（首页最近更新模块 panel>h2>a[href=/new/]>ul.u-line）：书链 /read/{id}/；' +
      '书页 og:novel:* meta 齐全+.pintro 简介+隐藏全目录（.clist ul.u-chapter 由 POST /novel/clist/ JSON 填充）→ ' +
      'chapterListApi 配置同源 JSON 目录接口（985 章实测），书页内嵌最新 10 章作回退；' +
      '章节页有轻量 JS token 挑战（let token=… + location.href 拼接 ?challenge= 回跳升级会话 cookie），' +
      '引擎 fetch 层已内置 JS token 重定向求解器自动跟随；正文 .page-content section。' +
      '完整更新页 /new/ 分页为 /new/?page={k}，可作为范围采集目标（分页模板见下）。',
    // listRule.paginationTemplate 单独写入（RuleMap 平铺字符串）
    listRuleExtra: { paginationTemplate: 'https://ixdzs8.com/new/?page={k}' },
  },
]

async function main() {
  for (const r of RULES) {
    const { listRuleExtra, ...base } = r as typeof r & { listRuleExtra?: Record<string, string> }
    const data = {
      name: base.name,
      siteUrl: base.siteUrl,
      enabled: base.enabled,
      charset: base.charset,
      proxy: base.proxy,
      insecureTLS: base.insecureTLS,
      listRule: JSON.stringify({ ...base.listRule, ...(listRuleExtra ?? {}) }),
      bookRule: JSON.stringify(base.bookRule),
      chapterRule: JSON.stringify(base.chapterRule),
      notes: base.notes,
    }
    const existing = await db.scrapeRule.findUnique({ where: { name: data.name } })
    if (existing) {
      await db.scrapeRule.update({ where: { name: data.name }, data })
      console.log(`updated: ${data.name} (id=${existing.id})`)
    } else {
      const created = await db.scrapeRule.create({ data })
      console.log(`created: ${data.name} (id=${created.id})`)
    }
  }
  console.log('done')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
