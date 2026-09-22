/**
 * 通用字段文本清洗器（主应用实现）
 *
 * 适用范围：所有采集获得的「非正文」文本字段——书名、作者、简介、章节标题、
 * 分类、状态、列表条目等；正文清洗仍由 content-clean.ts 的行级规则负责。
 *
 * 典型噪声（实测样本）：
 * - HTML 实体：&#091；#093；（全角分号变体）、&amp;lt;（多重转义）、&amp;…………（残留 &amp;）
 * - 字面转义序列："\n"（反斜杠+n 字符，非真实换行）
 * - 残缺标签碎片：&lt;canvas class=&quot;sec-last&quot; data-c=…（无闭合 >，解码后逃过闭合标签正则）
 * - 站点样板句：简介尾部「《X》是…精心创作…不代表…观点」「实时更新…无弹窗阅读」
 * - SEO 元描述型伪简介：「书名 无弹窗广告全文阅读及书名 TXT下载,最新章节…」（整段非叙事）
 *
 * ⚠ mini-services/scraper-service/src/text-clean.ts 是本文件的同源实现
 *   （scraper-service 是独立 Bun 进程，跨进程无法共享模块）。
 *   修改任何规则时必须两边同步！
 */

import { isNoiseLine } from './content-clean'

/** 命名实体映射（HTML5 中下列实体缺分号同样合法，其余命名实体缺分号不解码以避免误伤） */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  middot: '·',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  times: '×',
  divide: '÷',
  laquo: '«',
  raquo: '»',
  ensp: ' ',
  emsp: ' ',
}

/** 实体形态：&lt; &amp; &#091; &#x1A600;，分号支持半角 ; 与全角 ；，数字/十六进制实体允许缺分号 */
const ENTITY_RE = /&(?:#x([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([a-zA-Z][a-zA-Z0-9]{1,31}))(?:;|；)?/g

/** 码点有效性：0 / 代理区 / 超界无效，解码失败保留原文 */
function codePointToChar(cp: number, original: string): string {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return original
  if (cp >= 0xd800 && cp <= 0xdfff) return original
  return String.fromCodePoint(cp)
}

/** 解码一轮实体 */
function decodeOnce(s: string): string {
  return s.replace(ENTITY_RE, (m, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
    if (hex !== undefined) return codePointToChar(parseInt(hex, 16), m)
    if (dec !== undefined) return codePointToChar(parseInt(dec, 10), m)
    const v = NAMED_ENTITIES[(name ?? '').toLowerCase()]
    return v !== undefined ? v : m
  })
}

/**
 * 全量实体解码：循环解码至稳定（处理 &amp;lt; → &lt; → < 的多重转义），最多 3 轮防恶意嵌套。
 * 未知命名实体保留原文（避免破坏正常文本）。
 *
 * 上下文补全：字符串中存在完整实体时，被截断掉「&」的同型残体（如 &#091;#093; 中的
 * #093;）一并还原——站点实体编码损坏常见形态；无完整实体的字符串中的 #093; 保持原样。
 */
export function decodeHtmlEntities(s: string, maxRounds = 3): string {
  let out = s
  for (let i = 0; i < maxRounds; i++) {
    const next = decodeOnce(out)
    if (next === out) break
    out = next
  }
  if (/&(?:#x?[0-9a-fA-F]+|lt|gt|amp|quot|apos|nbsp)/i.test(s)) {
    out = out.replace(/#(x[0-9a-fA-F]{1,6}|\d{1,7})(?:;|；)/g, (m, hexdec: string) => {
      const cp = hexdec.toLowerCase().startsWith('x') ? parseInt(hexdec.slice(1), 16) : parseInt(hexdec, 10)
      return codePointToChar(cp, m)
    })
  }
  return out
}

/** 控制字符/零宽字符/UTF 段落分隔符（保留 \t\n 之外全部清除） */
const INVISIBLE_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufeff\u200b-\u200d\u2028\u2029]/g

/**
 * 残缺 HTML 标签形态：<ins class="…" data-…（允许无闭合 >）。
 * ⚠ 与注释曾声称的不同（12-d P3-18，注释已按实际行为修正）：「a<b」的字母形态同样会
 * 被剥为「a 」（<b… 被当标签起始）；仅数字形态「1<2」因首字符非 [a-z] 而受保护。
 * 书名/章节名含字母形态数学式的概率极低，按安全侧（激进剥除）实现保持现状；
 * 若未来需要保护 a<b，需引入更复杂的前后文判定（与引擎侧 text-clean 同步修改）。
 */
const TAG_RE = /<\/?[a-z][^>]*>?/gi

/** 字面转义序列：\r\n / \n / \r（反斜杠字符+字母，非真实换行） */
const LITERAL_ESCAPE_RE = /\\r\\n|\\n|\\r/g

/**
 * 单行字段清洗（书名/作者/章节标题/分类/状态等）：
 * 实体解码 → 字面转义还原为空格 → 标签剥除 → 隐形字符清除 → 空白折叠。
 * 只净化不丢内容；空串输入返回空串。
 */
export function cleanTextField(raw: string): string {
  if (!raw) return ''
  let s = decodeHtmlEntities(String(raw))
  s = s.replace(LITERAL_ESCAPE_RE, ' ')
  s = s.replace(TAG_RE, ' ')
  s = s.replace(INVISIBLE_RE, '')
  s = s.replace(/[\u00a0\u3000]/g, ' ')
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * 简介尾部站点样板句（剥除起点之后的全部内容；跨行用 [\s\S] 覆盖）：
 * - 《X》是…精心创作/倾力打造/首发…（含格格党实时更新…无弹窗…观点整尾段）
 * - 书友所发表的…评论，并不代表…观点
 * - XX(站名)实时更新《X》最新章节…
 * - 本站/本书/小说…首发于/来自…
 */
const DESC_TAIL_PATTERNS: RegExp[] = [
  /[。！？!?\s…]*《[^》]{1,50}》(?:是|系)[\s\S]{0,40}(?:精心创作|倾力打造|创作的一部|连载(?:中)?|首发|签约作品)[\s\S]{0,200}$/u,
  /[。！？!?\s…]*[^\n。]{0,30}(?:书友所发表|书友们所发表|网友所发表)[\s\S]{0,200}$/u,
  /[。！？!?\s…]*[^\n。]{0,30}并不代表[\s\S]{0,30}(?:赞同|支持)[\s\S]{0,120}$/u,
  /[。！？!?\s…]*[^\n。]{0,30}实时更新[\s\S]{0,120}$/u,
  /[。！？!?\s…]*(?:本站|本书|小说|小说站)[^\n。]{0,20}(?:首发于|首发地址|均来自|来自网络)[\s\S]{0,120}$/u,
  /[。！？!?\s…]*[^\n。]{0,20}(?:转载请注明|版权属于|版权归原作者)[\s\S]{0,120}$/u,
  // 源站 SEO 关键词串尾巴（实测：相关小说：词A、词B、词C…）
  /[。！？!?\s…]*[^\n。]{0,12}(?:相关小说|相关阅读|延伸阅读|推荐阅读|猜你喜欢)[：:][\s\S]{0,400}$/u,
]

/** SEO 样板词（判定伪简介/识别样板句共用） */
const SEO_WORDS_RE =
  /无弹窗|TXT下载|电子书下载|全本TXT|全文(?:免费)?阅读|免费阅读|最新章节(?:列表)?|首发域名|手机阅读|指尖阅读/i

/**
 * SEO 元描述型伪简介判定（整段非叙事，直接置空）。
 * 判定：按句读切分后，每一句都含 SEO 样板词 → 整段无真实叙事，置空。
 * 实测样本：「书名 无弹窗广告全文阅读及书名 TXT下载,最新章节第X章 … ,书名 作者X」
 * （无句读 → 单句含 SEO 词 → 置空）；真实叙事只要有一句不含样板词即保留。
 */
function looksLikeSeoMeta(text: string): boolean {
  const t = text.replace(/\s+/g, '')
  if (!t) return false
  const segments = text
    .split(/[。！？!?]/)
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0)
  if (segments.length === 0) return false
  return segments.every((seg) => SEO_WORDS_RE.test(seg))
}

/**
 * 简介字段清洗（多段文本）：
 * 实体解码 → 字面转义还原为真实换行 → 标签转为换行边界 → 逐行去缩进/噪声过滤 →
 * 尾部站点样板剥除 → SEO 元描述型置空 → 长度截断。
 * 输出以单个 \n 分段；段落缩进交给展示层。
 */
export function cleanDescriptionField(raw: string, maxChars = 2000): string {
  if (!raw) return ''
  let s = decodeHtmlEntities(String(raw))
  s = s.replace(LITERAL_ESCAPE_RE, '\n')
  s = s.replace(TAG_RE, '\n')
  s = s.replace(INVISIBLE_RE, '')
  // 逐行规范化 + 噪声行过滤（URL/推广/导航等行级噪声与正文共用同一套规则）
  const lines = s
    .split(/\n+/)
    .map((l) => l.replace(/[\u00a0\u3000]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((l) => l && !isNoiseLine(l))
  let text = lines.join('\n')
  // 剥模板前缀「关于《书名》：/关于书名：」（书页 intro 常以书名回显开头）
  text = text.replace(/^关于[《〈]?.{1,40}?[》〉]?[:：]\s*/u, '').trim()
  // 尾部站点样板剥除
  for (const re of DESC_TAIL_PATTERNS) {
    const next = text.replace(re, '').trim()
    if (next !== text) text = next
  }
  // SEO 元描述型伪简介（整段非叙事）→ 置空，宁缺毋滥
  if (looksLikeSeoMeta(text)) return ''
  return text.slice(0, maxChars).trim()
}
