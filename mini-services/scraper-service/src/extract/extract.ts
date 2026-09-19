/**
 * cheerio 规则提取器：把 ListRule / BookRule / ChapterRule 应用到已解码的 HTML 上。
 *
 * 约定：
 * - 规则缺失时使用内置启发式候选，并在 warnings 中明确标注；
 * - 正文清洗：容器级去 script/style/广告链接/站点水印行（content.ts）、
 *   行级噪声统一清洗走 clean.ts（与主应用 src/lib/content-clean.ts 同源实现，改规则需两边同步），
 *   噪声行占比过高时向 warnings 提示 contentSelector 可能命中了导航/广告容器；
 * - 链接按 URL+标题去重（去重忽略锚点）。
 * （自 extract.ts 巨石拆分而来，代码逐行原样迁移）
 */
import type { CheerioAPI } from 'cheerio'
import { cleanChapterText } from '../clean'
import type { BookRule, ChapterRule, ListRule } from '../types'
import { cleanContainer } from './content'
import type { CleanedContent } from './content'
import { collapse, firstMatch, parseSel, pickHref, pickText, splitAlternatives, toAbs } from './selectors'
import type { Scope } from './selectors'

const MAX_LIST_ITEMS = 500
const MAX_CHAPTER_REFS = 800
const MAX_DESCRIPTION_CHARS = 2000
const MAX_TITLE_CHARS = 200

/**
 * 站标/全站样板文本：出现在标题候选中即视为命中站标而非真实标题。
 * 典型：aijjxs（帝国 CMS）全站每页 h1.logo = 「站内搜索快速找到你想要的TXT电子书」。
 */
const BOILERPLATE_TITLE_RE =
  /站内搜索|快速找到你想要的|TXT电子书|TXT下载|全本TXT|电子书免费下载|电子书下载地址/

/** 标题选择器逐个尝试，跳过命中站标样板的候选（pickText 是取首个非空，无法表达跳过语义） */
function pickTitle(scope: Scope, selectors: string[]): string {
  for (const raw of selectors) {
    const t = pickText(scope, [raw])
    if (t && !BOILERPLATE_TITLE_RE.test(t)) return t
  }
  return ''
}

/** 清理书籍标题：剥《》书名号，<title> 兜底时拆「书名txt下载_作者_分类_站名」取首段并去下载站后缀 */
function cleanBookTitle(t: string): string {
  let s = t.trim()
  if (!s) return ''
  if (/txt下载|全本txt|电子书下载/i.test(s)) {
    // 仅当存在下载站样板词时才按分隔符拆段，避免误伤含「_/-」的正常书名
    const seg = s.split(/[_|｜]/)[0]?.trim() ?? ''
    if (seg) s = seg
    s = s.replace(/txt下载|全本txt|电子书下载|最新章节/gi, '').trim()
  }
  // Task 3（本地实测）新增：剥离杰奇系 h1 常见的样板后缀（如「葬神棺全文阅读」「XX最新章节列表」）。
  // 仅剥「整词后缀」且剥后仍非空才生效；这些词组由 SEO 模板拼接，正常书名不会以它们结尾。
  const stripped = s.replace(
    /(?:\s*(?:最新章节(?:列表)?|全文阅读|全本阅读|免费阅读|无弹窗(?:广告)?(?:全文|免费)?阅读|无广告阅读|笔趣阁|顶点小说|无错小说|txt下载|全本txt))+$/gi,
    '',
  ).trim()
  if (stripped && stripped.length >= 2) s = stripped
  // 新模板 h1 内嵌作者行（如 trxsw：h1.f21h 文本 = 「书名作者:某某」）→ 剥「作者:某某」尾巴
  const noAuthor = s.replace(/作者[:：][^《》]{1,30}$/i, '').trim()
  if (noAuthor && noAuthor.length >= 2) s = noAuthor
  const m = /^《(.+?)》$/.exec(s)
  if (m) s = m[1]
  return s
}

/** 简介清洗：剥模板前缀「关于《书名》：/关于书名：」（书页 intro 常以书名回显开头）与首尾空白 */
function cleanDescription(t: string): string {
  return t.replace(/^关于[《〈]?.{1,40}?[》〉]?[:：]\s*/u, '').trim()
}

/** 分类/状态字段清洗：剥「小说分类：/分类：/类型：/频道：」等标签前缀（老模板把标签与值放同一文本节点） */
function stripFieldLabel(t: string): string {
  return t.replace(/^(?:小说)?(?:分类|类型|频道|状态)[:：]\s*/, '').trim()
}

/** 作者字段清理：剥「作者：/作 者：/书籍作者：」等标签前缀（老模板把标签与值放在同一文本节点） */
function stripAuthorLabel(t: string): string {
  return t.replace(/^(?:书籍)?作\s*者\s*[:：]?\s*|^(?:author|writer)\s*[:：]?\s*/i, '').trim()
}

/** 规则级排除：提取前从 DOM 移除命中节点（站标/搜索框等全站样板容器），多备用逗号分隔。
 *  注意：extractBook 与 extractChapter 各自的入口只调一次；extractChapterRefs 不再重复调用
 *  （Task 24-a 修复：旧实现 extractBook 先移除后，extractChapterRefs 内再调必然 0 命中，
 *  导致每次带 excludeSelector 的书页提取都多一条误导性的「无命中」警告） */
function removeExcluded(root: Scope, excludeSel: string | undefined, warnings: string[]): void {
  if (!excludeSel) return
  let removed = 0
  for (const sel of splitAlternatives(excludeSel)) {
    try {
      const hit = root.find(sel)
      if (hit.length) {
        removed += hit.length
        hit.remove()
      }
    } catch {
      warnings.push(`excludeSelector 含非法选择器已跳过: "${sel}"`)
    }
  }
  if (!removed) warnings.push(`excludeSelector 无命中: "${excludeSel}"`)
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
      const linkSels = rule.linkSelector ? splitAlternatives(rule.linkSelector) : ['a[href]']
      const linkEl = firstMatch(it, linkSels)
      let title = rule.titleSelector ? pickText(it, splitAlternatives(rule.titleSelector)) : ''
      if (!title && linkEl) title = collapse(linkEl.text())
      if (!title && !rule.titleSelector) {
        const anyA = it.find('a').first()
        if (anyA.length) title = collapse(anyA.text())
      }
      // 链接统一走 pickHref：支持 linkSelector 的 @attr 后缀（如 a@data-url）与备选语义；
      // 旧实现只读 href 属性，@attr 配置被静默忽略
      const url = pickHref(it, linkSels, baseUrl)
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
  /** rule.catalogLinkSelector 命中的完整目录页绝对地址（未配置/未命中时为 null） */
  catalogUrl: string | null
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
  // chapterLinkSelector=none：显式跳过章节列表提取（元数据站/下载站，避免启发式把
  // 「/txt/123.html」式的其他书籍链接误判为章节链接造成串书）
  if (rule.chapterLinkSelector && rule.chapterLinkSelector.trim().toLowerCase() === 'none') {
    warnings.push('chapterLinkSelector=none：按配置跳过章节列表提取（元数据/下载站）')
    return []
  }
  const root = $.root() as unknown as Scope
  // 排除节点已由 extractBook 入口的 removeExcluded 统一处理（此处不重复调用，避免虚假「无命中」警告）
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
  /** 去锚点后的 URL，用于识别「同一页面的锚点变体」（如 #top 回顶链接）指向当前页 */
  const stripHash = (u: string): string => u.split('#')[0]
  const selfUrlNoHash = selfUrl ? stripHash(selfUrl) : ''
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
      // 无 URL 的引用无法被采集（下游 worker 也会过滤），直接跳过，避免混入「纯文本伪章节」
      if (!url) return
      if (title && title.length > 80) return // 明显不是章节链接
      if (stripHash(url) === selfUrlNoHash) return // 跳过指向当前页的自链接（含锚点变体）
      const key = stripHash(url) // 去重忽略锚点，避免同章多锚点重复
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
  removeExcluded(root, rule.excludeSelector, warnings)

  const field = (name: keyof BookRule, fallbacks: string[]): string => {
    const ruleSels = rule[name] && typeof rule[name] === 'string' ? splitAlternatives(rule[name] as string) : []
    return pickText(root, [...ruleSels, ...fallbacks])
  }

  const titleSels = [
    ...(rule.titleSelector ? splitAlternatives(rule.titleSelector) : []),
    ...BOOK_FIELD_FALLBACKS.title,
  ]
  const title = cleanBookTitle(pickTitle(root, titleSels).slice(0, MAX_TITLE_CHARS))
  const author = stripAuthorLabel(field('authorSelector', BOOK_FIELD_FALLBACKS.author).slice(0, MAX_TITLE_CHARS))
  const description = cleanDescription(field('descriptionSelector', BOOK_FIELD_FALLBACKS.description).slice(0, MAX_DESCRIPTION_CHARS))
  const status = stripFieldLabel(field('statusSelector', BOOK_FIELD_FALLBACKS.status).slice(0, 50))
  const category = stripFieldLabel(field('categorySelector', BOOK_FIELD_FALLBACKS.category).slice(0, 50))

  const coverSels = [
    ...(rule.coverSelector ? splitAlternatives(rule.coverSelector) : []),
    ...BOOK_FIELD_FALLBACKS.cover,
  ]
  const cover = pickHref(root, coverSels, baseUrl)

  const chapters = extractChapterRefs($, rule, baseUrl, warnings)

  // 目录页链接（可选）：书页仅含最新几章时指向完整目录页，供 worker 二次抓取
  const catalogUrl = rule.catalogLinkSelector
    ? pickHref(root, splitAlternatives(rule.catalogLinkSelector), baseUrl)
    : null

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
    catalogUrl,
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

/** 上一页/上一章链接文本：部分站点把上一章锚点误标 rel="next"（实测 huangjinwu.org），
 *  启发式若不校验文本会把 prev 当 next 返回，导致分页/下一章判定倒退 */
const PREV_LINK_TEXT_RE = /上一[页章頁]|前一[页章頁]|^prev$/i

/**
 * 内联脚本翻页变量兜底：部分站点把翻页地址藏进脚本变量、可见锚点是 javascript:;
 * （实测 xinjianpan：const next_page = "/txt/xx/yy_2.html"）。从 <script> 文本中
 * 按「next_page/next_url 类变量名 = '字面量'」提取第一个可解析为绝对 URL 的值。
 * 只认显式变量赋值/对象字面量，不扫描任意字符串（避免把广告/统计脚本里的 URL 误当翻页）。
 */
const NEXT_PAGE_VAR_RE =
  /(?:var|const|let)\s+(?:next_?page|next_?url|nextChapterUrl|nextChapter)\s*=\s*["']([^"']+)["']|["']?(?:next_?page|next_?url)["']?\s*:\s*["']([^"']+)["']/gi

function nextUrlFromScripts($: CheerioAPI, baseUrl: string): string | null {
  const texts: string[] = []
  $('script').each((_i, el) => {
    const t = $(el).text()
    if (t && t.length < 20_000) texts.push(t)
  })
  for (const text of texts) {
    NEXT_PAGE_VAR_RE.lastIndex = 0
    for (let m = NEXT_PAGE_VAR_RE.exec(text); m; m = NEXT_PAGE_VAR_RE.exec(text)) {
      const abs = toAbs(m[1] || m[2], baseUrl)
      if (abs) return abs
    }
  }
  return null
}

export function extractChapter(
  $: CheerioAPI,
  rule: ChapterRule,
  baseUrl: string,
  warnings: string[],
): ChapterData {
  const root = $.root() as unknown as Scope
  removeExcluded(root, rule.excludeSelector, warnings)

  // ---- 标题 ----
  const titleSels = [
    ...(rule.titleSelector ? splitAlternatives(rule.titleSelector) : []),
    ...DEFAULT_CHAPTER_TITLE_SELECTORS,
  ]
  let title = pickTitle(root, titleSels).slice(0, MAX_TITLE_CHARS)
  if (title) {
    // Task 3（本地实测）：剥离 CMS 分页样式后缀（如「第1章 合欢宗(第1/2页)」「（3/5）」）。
    // 分页信息属元数据，翻页由 nextSelector/worker 负责，不应留在入库标题里。
    const dePaged = title.replace(/\s*[（(]\s*第?\s*\d+\s*\/\s*\d+\s*[页頁]?\s*[)）]\s*$/g, '').trim()
    if (dePaged && dePaged.length >= 2) title = dePaged
  }
  if (!title) {
    const t = collapse($('title').first().text()).slice(0, MAX_TITLE_CHARS)
    // <title> 兜底同样要过站标样板过滤：pickTitle 把命中的候选全部跳过后才走到这里，
    // 若 <title> 本身就是站标（如「站内搜索 - 站名」），不加过滤会把刚排除的样板重新引入
    if (t && !BOILERPLATE_TITLE_RE.test(t)) {
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

  // ---- 行级噪声统一清洗（clean.ts 与主应用 src/lib/content-clean.ts 同源）----
  if (best.text) {
    const stats = cleanChapterText(best.text)
    if (stats.removed > 0 && stats.total >= 10 && stats.removed / stats.total > 0.5) {
      warnings.push(
        `清洗移除了 ${stats.removed}/${stats.total} 行，请检查 contentSelector 是否命中了导航/广告容器`,
      )
    }
    best = { paragraphs: stats.text ? stats.text.split('\n') : [], text: stats.text }
  }

  // ---- 下一页 ----
  let nextUrl: string | null = null
  if (rule.nextSelector) {
    nextUrl = pickHref(root, splitAlternatives(rule.nextSelector), baseUrl)
    if (!nextUrl) warnings.push(`nextSelector 无命中: "${rule.nextSelector}"`)
  }
  if (!nextUrl) {
    // 启发式逐个候选尝试：跳过文本呈「上一页/上一章」的锚点（站点误标 rel="next" 场景）
    for (const raw of HEURISTIC_NEXT_SELECTORS) {
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
      if (PREV_LINK_TEXT_RE.test(collapse(el.text()))) continue
      const abs = toAbs(el.attr('href'), baseUrl)
      if (abs) {
        nextUrl = abs
        break
      }
    }
    if (nextUrl && nextUrl === toAbs(baseUrl, baseUrl)) nextUrl = null // 启发式命中自链接视为无下一页
    if (nextUrl) warnings.push('nextUrl 由启发式匹配（"下一页/下一章"链接）获得')
  }
  if (!nextUrl) {
    // 锚点启发式全部落空：尝试内联脚本翻页变量（锚点为 javascript:; 的站点）
    nextUrl = nextUrlFromScripts($, baseUrl)
    if (nextUrl && nextUrl === toAbs(baseUrl, baseUrl)) nextUrl = null
    if (nextUrl) warnings.push('nextUrl 由内联脚本翻页变量兜底获得（可见锚点为 JS 跳转）')
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
