/**
 * cheerio 规则提取器：把 ListRule / BookRule / ChapterRule 应用到已解码的 HTML 上。
 *
 * 约定：
 * - 所有选择器字符串支持逗号分隔的"备选"，从左到右取第一个非空结果；
 *   （CSS 原生逗号是并集语义，这里按备选语义逐个尝试，且能容忍单个选择器非法）
 * - 选择器支持 `sel@attr` 后缀取属性（如 `meta[property="og:image"]@content`），纯加法扩展，
 *   不影响主站传来的普通 CSS 选择器；
 * - 规则缺失时使用内置启发式候选，并在 warnings 中明确标注；
 * - 匹配语义：优先在 scope 内查找（find），scope 自身命中选择器时同样采纳（is）；
 * - 正文清洗：去 script/style/广告链接/站点水印行、段落规范化、去重连续重复行；
 * - 链接一律 new URL(href, base) 补全为绝对地址，并按 URL+标题去重。
 */
import * as cheerio from 'cheerio'
import type { Cheerio, CheerioAPI } from 'cheerio'
import type { BookRule, ChapterRule, ListRule } from './types'

type Scope = Cheerio<any>

const MAX_LIST_ITEMS = 500
const MAX_CHAPTER_REFS = 800
const MAX_DESCRIPTION_CHARS = 2000
const MAX_TITLE_CHARS = 200

// ==================== 选择器工具 ====================

/** 逗号拆分备选选择器（跳过括号/属性选择器内部的逗号） */
export function splitAlternatives(sel: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of sel) {
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/** 解析 `sel@attr` 语法 */
function parseSel(raw: string): { selector: string; attr: string | null } {
  const m = /@([a-zA-Z][\w:-]*)$/.exec(raw)
  if (m && m.index !== undefined) {
    return { selector: raw.slice(0, m.index).trim(), attr: m[1] }
  }
  return { selector: raw.trim(), attr: null }
}

/** 单行文本规范化 */
function collapse(s: string): string {
  return s.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
}

/** 在 scope 内按备选顺序取第一个非空文本/属性（find 优先，scope 自身命中亦采纳） */
function pickText(scope: Scope, rawSelectors: string[]): string {
  for (const raw of rawSelectors) {
    const { selector, attr } = parseSel(raw)
    if (!selector) continue
    let val = ''
    try {
      const el = scope.find(selector).first()
      if (el.length) {
        val = attr ? (el.attr(attr) ?? '') : el.text()
      } else if (scope.length && scope.is(selector)) {
        // scope 自身命中选择器（如 scope 是 <a> 而 selector 为 a@title）
        val = attr ? (scope.attr(attr) ?? '') : scope.text()
      }
    } catch {
      continue // 非法选择器直接跳过
    }
    const t = collapse(val)
    if (t) return t
  }
  return ''
}

function firstMatch(scope: Scope, rawSelectors: string[]): Scope | null {
  for (const raw of rawSelectors) {
    const { selector } = parseSel(raw)
    if (!selector) continue
    try {
      const el = scope.find(selector).first()
      if (el.length) return el
      if (scope.length && scope.is(selector)) return scope
    } catch {
      continue
    }
  }
  return null
}

export function toAbs(href: string | undefined | null, base: string): string | null {
  if (!href) return null
  const h = href.trim()
  if (!h || /^javascript:/i.test(h) || h === '#') return null
  try {
    const u = new URL(h, base)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.toString()
  } catch {
    return null
  }
}

/** 按备选顺序取第一个可解析为绝对 URL 的链接（支持 @attr，默认取 href） */
function pickHref(scope: Scope, rawSelectors: string[], base: string): string | null {
  for (const raw of rawSelectors) {
    const { selector, attr } = parseSel(raw)
    if (!selector) continue
    try {
      const el = scope.find(selector).first()
      let node: Scope | null = el.length ? el : null
      if (!node && scope.length && scope.is(selector)) node = scope
      if (!node) continue
      const href = attr ? (node.attr(attr) ?? '') : (node.attr('href') ?? '')
      const abs = toAbs(href, base)
      if (abs) return abs
    } catch {
      continue
    }
  }
  return null
}

// ==================== 正文清洗 ====================

const NOISE_SELECTOR =
  'script,style,noscript,iframe,svg,template,ins,object,embed,form,button,input,select,textarea,link,meta,video,audio'

/** class/id 白名单级广告/导航标记（整词匹配，避免误伤 egg/class 这类普通词） */
const AD_TOKEN_RE =
  /^(ad|ads|adv|adsid|adsbygoogle|advert|advertisement|banner|gg|gg2|ggx|ggxx|ggtop|baidu-?ad|google-?ads?|推广|广告|promotion|promo|popup|mask|modal|download-?app|app-?guide|copyright|recommend|related|comment|comments|rating|score|share|sidebar|side-?nav|crumb|breadcrumb|footer-?nav|header-?nav|toc|catalog|bookshelf|notice|tip|tips|announce)$/i

/** 纯导航/运营链接文本 */
const AD_LINK_TEXT_RE =
  /^(加入书架|加入收藏|收藏本书|收藏|书架|推荐本书|求收藏|求月票|求推荐票?|求订阅|上一页|上一章|返回目录|返回书页|返回列表|目录|章节目录|书签|举报|分享|点击举报|继续阅读|阅读全部章节|查看全部章节|下载本书|下载txt|手机阅读|手机版|app阅读|展开全部|收起|点击下一页|广告|关闭广告|登录|注册|充值|打赏)$/i

/** 站点水印/SEO 垃圾行（整行匹配才剔除，且限短行） */
const WATERMARK_LINE_RE =
  /本书来自|首发(?:网址|域名|时间)|天才一?秒?记(?:住|得)|请记住本书|记住本站|最新章节|章节错误|点此举报|求收藏|求推荐票?|求月票|无弹窗|手机(?:版|用户)?(?:阅读|访问|看)|app下载|下载app|笔趣阁|顶点小说|吾爱文学|(?:www|wap|m|mip)\.[a-z0-9-]{2,}\.(?:com|net|cc|org|la|info|xyz|top|vip|site|icu|club)|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/i

interface CleanedContent {
  paragraphs: string[]
  text: string
}

/** 清洗单个正文容器并收割段落 */
function cleanContainer(el: Scope, $: CheerioAPI): CleanedContent {
  const clone = el.clone()
  clone.find(NOISE_SELECTOR).remove()
  // 隐藏元素（display:none / hidden 属性）多为广告占位
  clone.find('[hidden],[style*="display:none"],[style*="display: none"],[style*="display:inherit"][class*="ad"]').remove()

  // 1) class/id 命中广告 token 的元素块
  clone.find('[class],[id]').each((_i, node) => {
    const $n = $(node)
    const tokens = `${$n.attr('class') ?? ''} ${$n.attr('id') ?? ''}`.trim().split(/\s+/)
    if (tokens.some((t) => t && AD_TOKEN_RE.test(t))) $n.remove()
  })

  // 2) 广告/导航/空锚点链接
  clone.find('a').each((_i, node) => {
    const $a = $(node)
    const txt = collapse($a.text())
    const href = $a.attr('href') ?? ''
    if (AD_LINK_TEXT_RE.test(txt) || /^javascript:/i.test(href) || href === '#') $a.remove()
  })

  // 3) 短小的水印文本节点
  clone.find('div,p,span,font,center,strong,em,b').each((_i, node) => {
    const $n = $(node)
    if ($n.children().length === 0) {
      const t = collapse($n.text())
      if (t && t.length <= 80 && WATERMARK_LINE_RE.test(t)) $n.remove()
    }
  })

  // 4) 段落收割：<br> 与块级元素边界 → \n
  clone.find('br').replaceWith('\n')
  clone.find('p,div,dd,li,section,article,h1,h2,h3,h4').after('\n')
  const raw = clone.text()

  const paragraphs: string[] = []
  for (const line0 of raw.split('\n')) {
    const line = line0.replace(/\u3000/g, ' ').replace(/\s+/g, ' ').trim()
    if (!line) continue
    if (!/[\p{L}\p{N}]/u.test(line)) continue // 纯符号/装饰线
    if (line.length <= 100 && WATERMARK_LINE_RE.test(line)) continue
    if (paragraphs.length > 0 && paragraphs[paragraphs.length - 1] === line) continue // 连续重复
    paragraphs.push(line)
  }
  return { paragraphs, text: paragraphs.join('\n') }
}

// ==================== List 提取 ====================

export interface ListItem {
  title: string
  url: string | null
  author: string
  category: string
}

export interface ListData {
  type: 'list'
  count: number
  itemSelector: string
  items: ListItem[]
}

const DEFAULT_ITEM_SELECTORS = [
  '.novel-item',
  '.book-item',
  '.bookbox',
  '.item',
  '.lirow',
  'ul.list li',
  '.book-list li',
  '.grid li',
  'table tr',
  'li',
]

export function extractList(
  $: CheerioAPI,
  rule: ListRule,
  baseUrl: string,
  warnings: string[],
): ListData {
  const root = $.root() as unknown as Scope
  let itemSel = ''
  let itemEls: Scope | null = null

  if (rule.itemSelector) {
    for (const sel of splitAlternatives(rule.itemSelector)) {
      try {
        const found = root.find(sel)
        if (found.length > 0) {
          itemSel = sel
          itemEls = found
          break
        }
      } catch {
        continue
      }
    }
    if (!itemSel) warnings.push(`itemSelector 在页面中无命中: "${rule.itemSelector}"`)
  } else {
    for (const sel of DEFAULT_ITEM_SELECTORS) {
      try {
        const found = root.find(sel)
        if (found.length >= 3) {
          itemSel = sel
          itemEls = found
          break
        }
      } catch {
        continue
      }
    }
    if (itemSel) warnings.push(`未提供 itemSelector，使用内置候选 "${itemSel}"（建议在规则中显式配置）`)
  }

  const items: ListItem[] = []
  const seen = new Set<string>()

  if (itemEls) {
    itemEls.slice(0, MAX_LIST_ITEMS).each((_i, node) => {
      const it = $(node) as Scope
      const linkEl = firstMatch(it, rule.linkSelector ? splitAlternatives(rule.linkSelector) : ['a[href]'])
      let title = rule.titleSelector ? pickText(it, splitAlternatives(rule.titleSelector)) : ''
      if (!title && linkEl) title = collapse(linkEl.text())
      if (!title && !rule.titleSelector) {
        const anyA = it.find('a').first()
        if (anyA.length) title = collapse(anyA.text())
      }
      const url = linkEl ? toAbs(linkEl.attr('href'), baseUrl) : null
      const author = rule.authorSelector ? pickText(it, splitAlternatives(rule.authorSelector)) : ''
      const category = rule.categorySelector ? pickText(it, splitAlternatives(rule.categorySelector)) : ''
      if (!title && !url) return
      const key = `${title}|${url ?? ''}`
      if (seen.has(key)) return
      seen.add(key)
      items.push({ title, url, author, category })
    })
  }

  return { type: 'list', count: items.length, itemSelector: itemSel, items }
}

// ==================== Book 提取 ====================

export interface BookChapterRef {
  title: string
  url: string | null
}

export interface BookData {
  type: 'book'
  title: string
  author: string
  description: string
  cover: string | null
  status: string
  category: string
  chapterCount: number
  chapters: BookChapterRef[]
}

/** 杰奇 CMS 等老牌小说站普遍输出 og:novel:* meta，是高价值的默认回退 */
const BOOK_FIELD_FALLBACKS: Record<string, string[]> = {
  title: ['meta[property="og:novel:book_name"]@content', 'h1', '#title', '.book-title', '.bookTitle', 'title'],
  author: [
    'meta[property="og:novel:author"]@content',
    '#author',
    '.author',
    '.book-author',
    '#info p:nth-of-type(1)',
    'span:contains(作者：)',
    'p:contains(作者：)',
  ],
  description: [
    'meta[property="og:novel:description"]@content',
    'meta[name="description"]@content',
    '#intro',
    '.intro',
    '.book-desc',
    '.description',
    '#content dd',
    '.bookintro',
  ],
  cover: [
    'meta[property="og:image"]@content',
    '#fmimg img@src',
    '.book-img img@src',
    '.cover img@src',
    '.book-cover img@src',
    'img.cover@src',
  ],
  status: ['meta[property="og:novel:status"]@content', '#status', '.book-status', '.status', '.book-state'],
  category: ['meta[property="og:novel:category"]@content', '#category', '.book-category', '.category', '.book-cat'],
}

const CHAPTER_TEXT_RE = /^第\s*[0-9〇零一二两三四五六七八九十百千万]+\s*[章节卷回（(]/
const CHAPTER_URL_RE = /\/\d+[_\d]*\.html?$/i

/** 判断一个链接是否"章节样式"（标题正则或 /123.html 型 URL） */
function chapterLike($: CheerioAPI, a: any): boolean {
  const t = collapse($(a).text())
  if (!t || t.length > 60) return false
  return CHAPTER_TEXT_RE.test(t) || CHAPTER_URL_RE.test($(a).attr('href') ?? '')
}

function extractChapterRefs(
  $: CheerioAPI,
  rule: BookRule,
  baseUrl: string,
  warnings: string[],
): BookChapterRef[] {
  const root = $.root() as unknown as Scope
  let linkEls: Scope | null = null
  let usedRule = false

  if (rule.chapterLinkSelector) {
    for (const sel of splitAlternatives(rule.chapterLinkSelector)) {
      try {
        const found = root.find(sel)
        if (found.length > 0) {
          linkEls = found
          usedRule = true
          break
        }
      } catch {
        continue
      }
    }
    if (!linkEls) warnings.push(`chapterLinkSelector 在页面中无命中: "${rule.chapterLinkSelector}"`)
  }

  if (!linkEls) {
    // 启发式：在常见目录容器中挑选"章节样式链接"最多者；全局兜底按标题正则筛
    const CONTAINER_SELECTORS = ['#list', '.listmain', '#chapterList', '.chapter-list', '#chapters', '.catalog', '.book-list', 'dl']
    let best: Scope | null = null
    let bestCount = 0
    let bestSel = ''
    for (const sel of CONTAINER_SELECTORS) {
      try {
        const container = root.find(sel).first()
        if (!container.length) continue
        const n = container
          .find('a[href]')
          .toArray()
          .filter((a) => chapterLike($, a)).length
        if (n > bestCount) {
          bestCount = n
          best = container
          bestSel = sel
        }
      } catch {
        continue
      }
    }
    if (best && bestCount > 0) {
      // 启发式路径只保留"章节样式"链接，避免容器内导航/推荐链接混入
      const filtered = best.find('a[href]').toArray().filter((a) => chapterLike($, a))
      linkEls = $(filtered) as unknown as Scope
      warnings.push(`章节链接由内置启发式获得（容器 "${bestSel}"，命中 ${bestCount} 条章节样式链接），建议在规则中显式配置 chapterLinkSelector`)
    } else {
      try {
        const global = root
          .find('a[href]')
          .toArray()
          .filter((a) => {
            const t = collapse($(a).text())
            return t.length > 0 && t.length <= 60 && CHAPTER_TEXT_RE.test(t)
          })
        if (global.length > 0) {
          linkEls = $(global) as unknown as Scope
          warnings.push('章节链接由全局"第N章"标题正则启发式获得')
        }
      } catch {
        /* ignore */
      }
    }
  }

  const refs: BookChapterRef[] = []
  const seen = new Set<string>()
  const selfUrl = toAbs(baseUrl, baseUrl)
  if (linkEls) {
    linkEls.slice(0, MAX_CHAPTER_REFS).each((_i, node) => {
      const a = $(node)
      // 修复：配置了 chapterTitleSelector 时，应在链接元素内按规则提取标题（支持 @attr 与自匹配），而非直接置空
      let title = ''
      if (usedRule && rule.chapterTitleSelector) {
        title = pickText(a, splitAlternatives(rule.chapterTitleSelector))
      }
      if (!title) title = collapse(a.text())
      const url = toAbs(a.attr('href'), baseUrl)
      if (!title && !url) return
      if (title && title.length > 80) return // 明显不是章节链接
      if (url && url === selfUrl) return // 跳过指向当前页的自链接
      const key = (url ?? title).split('#')[0] // 去重忽略锚点，避免同章多锚点重复
      if (seen.has(key)) return
      seen.add(key)
      refs.push({ title, url })
    })
  }

  // 最后兜底：杰奇 meta 最新章
  if (refs.length === 0) {
    const url = pickHref(root, ['meta[property="og:novel:latest_chapter_url"]@content'], baseUrl)
    if (url) {
      const title = pickText(root, ['meta[property="og:novel:latest_chapter_name"]@content'])
      refs.push({ title, url })
      warnings.push('未找到章节列表，回退 og:novel:latest_chapter_* meta（仅最新一章）')
    }
  }
  return refs
}

export function extractBook(
  $: CheerioAPI,
  rule: BookRule,
  baseUrl: string,
  warnings: string[],
): BookData {
  const root = $.root() as unknown as Scope

  const field = (name: keyof BookRule, fallbacks: string[]): string => {
    const ruleSels = rule[name] && typeof rule[name] === 'string' ? splitAlternatives(rule[name] as string) : []
    return pickText(root, [...ruleSels, ...fallbacks])
  }

  const title = field('titleSelector', BOOK_FIELD_FALLBACKS.title).slice(0, MAX_TITLE_CHARS)
  const author = field('authorSelector', BOOK_FIELD_FALLBACKS.author).slice(0, MAX_TITLE_CHARS)
  const description = field('descriptionSelector', BOOK_FIELD_FALLBACKS.description).slice(0, MAX_DESCRIPTION_CHARS)
  const status = field('statusSelector', BOOK_FIELD_FALLBACKS.status).slice(0, 50)
  const category = field('categorySelector', BOOK_FIELD_FALLBACKS.category).slice(0, 50)

  const coverSels = [
    ...(rule.coverSelector ? splitAlternatives(rule.coverSelector) : []),
    ...BOOK_FIELD_FALLBACKS.cover,
  ]
  const cover = pickHref(root, coverSels, baseUrl)

  const chapters = extractChapterRefs($, rule, baseUrl, warnings)

  if (!title) warnings.push('书籍标题未提取到（规则与内置回退均未命中）')

  return {
    type: 'book',
    title,
    author,
    description,
    cover,
    status,
    category,
    chapterCount: chapters.length,
    chapters,
  }
}

// ==================== Chapter 提取 ====================

export interface ChapterData {
  type: 'chapter'
  title: string
  content: string
  paragraphs: string[]
  wordCount: number
  nextUrl: string | null
}

const DEFAULT_CONTENT_SELECTORS = [
  '#contenttxt',
  '#content',
  '#booktxt',
  '#htmlContent',
  '#chaptercontent',
  '#txtContent',
  '#txtcontent',
  '#nr1',
  '#nr',
  '#conts',
  '#contents',
  '.showtxt',
  '.read-content',
  '.readcontent',
  '#BookText',
  '#book_text',
  '.txtnav',
  'article',
  '.article-content',
  '.content',
  '#txt',
  '#text',
]

const DEFAULT_CHAPTER_TITLE_SELECTORS = ['h1', '.bookname h1', '#nr_title', '.read-title', '.title', 'h2']

const HEURISTIC_NEXT_SELECTORS = [
  'a[rel="next"]',
  'a:contains(下一页)',
  'a:contains(下一章)',
  'a:contains(下一頁)',
  'a:contains(下页)',
]

export function extractChapter(
  $: CheerioAPI,
  rule: ChapterRule,
  baseUrl: string,
  warnings: string[],
): ChapterData {
  const root = $.root() as unknown as Scope

  // ---- 标题 ----
  const titleSels = [
    ...(rule.titleSelector ? splitAlternatives(rule.titleSelector) : []),
    ...DEFAULT_CHAPTER_TITLE_SELECTORS,
  ]
  let title = pickText(root, titleSels).slice(0, MAX_TITLE_CHARS)
  if (!title) {
    const t = collapse($('title').first().text()).slice(0, MAX_TITLE_CHARS)
    if (t) {
      title = t
      warnings.push('章节标题未命中规则选择器，回退 <title> 标签（可能含站名后缀，建议显式配置 titleSelector）')
    }
  }

  // ---- 正文 ----
  const contentSels = rule.contentSelector ? splitAlternatives(rule.contentSelector) : DEFAULT_CONTENT_SELECTORS
  if (!rule.contentSelector) warnings.push('未提供 contentSelector，使用内置候选选择器匹配正文（结果仅供参考）')

  let best: CleanedContent | null = null
  let bestLen = -1
  for (const raw of contentSels) {
    const { selector } = parseSel(raw)
    if (!selector) continue
    let el: Scope | null = null
    try {
      const found = root.find(selector).first()
      if (found.length) el = found
    } catch {
      continue
    }
    if (!el) continue
    const cleaned = cleanContainer(el, $)
    if (cleaned.text.length > bestLen) {
      bestLen = cleaned.text.length
      best = cleaned
    }
    // 规则选择器按备选顺序取第一个"足够长"的命中（>=80 字），避免被小预览框截胡
    if (rule.contentSelector && cleaned.text.length >= 80) break
  }

  if (!best || bestLen <= 0) {
    warnings.push('正文提取为空：所有选择器（含内置候选）均未命中或内容为空')
    best = { paragraphs: [], text: '' }
  }

  // ---- 下一页 ----
  let nextUrl: string | null = null
  if (rule.nextSelector) {
    nextUrl = pickHref(root, splitAlternatives(rule.nextSelector), baseUrl)
    if (!nextUrl) warnings.push(`nextSelector 无命中: "${rule.nextSelector}"`)
  }
  if (!nextUrl) {
    nextUrl = pickHref(root, HEURISTIC_NEXT_SELECTORS, baseUrl)
    if (nextUrl && nextUrl === toAbs(baseUrl, baseUrl)) nextUrl = null // 启发式命中自链接视为无下一页
    if (nextUrl) warnings.push('nextUrl 由启发式匹配（"下一页/下一章"链接）获得')
  }

  const wordCount = best.text.replace(/\s/g, '').length
  return {
    type: 'chapter',
    title,
    content: best.text,
    paragraphs: best.paragraphs,
    wordCount,
    nextUrl,
  }
}
