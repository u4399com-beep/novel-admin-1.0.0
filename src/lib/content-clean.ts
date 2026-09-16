/**
 * 正文噪声清洗器（主应用规范实现，scrape-worker 与 clean-all 端点共用）
 *
 * 存储契约：清洗后的 content 为「无空行、无行首缩进」的纯文本行，
 * 以单个 \n 连接；段落缩进完全交给主题 CSS（text-indent: 2em）呈现。
 *
 * 清洗步骤：
 *   1. \r\n|\r → \n
 *   2. 逐行去行首全角空格(\u3000)/NBSP(\u00A0)/半角空白
 *   3. 行内连续空白折叠为单空格
 *   4. 丢弃空行
 *   5. 噪声行过滤（见 isNoiseLine）
 *   6. 剩余行以单个 \n 连接
 *
 * ⚠ mini-services/scraper-service/src/clean.ts 是本文件的同源实现
 *   （scraper-service 是独立 Bun 进程，跨进程无法共享模块）。
 *   修改 NOISE_PATTERNS / isNoiseLine 规则时必须两边同步！
 */

export interface CleanResult {
  /** 清洗后的正文（无空行、无行首缩进，行间单个 \n） */
  text: string
  /** 被判定为噪声而丢弃的行数（不含空行） */
  removedLines: number
}

/**
 * 噪声行模式集。除 PURE_SYMBOL 外，所有规则仅对短行（≤ SHORT_LINE_MAX 字符）生效，
 * 避免误杀含关键词（如「点击」「收藏」）的正常叙事长句。
 */
export const NOISE_PATTERNS = {
  /** 噪声行规则的行长度上限（字符数） */
  SHORT_LINE_MAX: 30,

  /** 行首缩进/空白：全角空格、NBSP、BOM、半角空白（不含换行符） */
  LEADING_INDENT: /^[ \t\u3000\u00a0\ufeff]+/,

  /** 是否含文字（字母/数字，含 CJK）——不含任何文字的行视为纯符号行 */
  HAS_TEXT: /[\p{L}\p{N}]/u,

  /** URL/域名类：含 www. / http、常见 TLD 后缀，或整行像域名 */
  URL_LINE:
    /www\.|https?:\/\/|\.(?:com|net|cc|org|info|xyz|top|vip)(?![a-z])|^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i,

  /** 站点推广/SEO 水印类（短行含任一关键词即判噪声） */
  SITE_PROMO:
    /笔趣阁|顶点小说|飞卢|起点中文|纵横中文|天才一秒记住|本章未完|点击下一页|继续阅读请|最新章节|手机阅读|无弹窗|全本小说|请记住本书|首发域名|记得收藏|求收藏|求推荐票|求月票|投推荐票|加入书签|书迷交流/,

  /** 导航/UI 残留：整行基本等于这些词（精确匹配，避免误伤叙事） */
  NAV_EXACT:
    /^(?:上一章|上一页|下一章|下一页|上一頁|下一頁|目录|章节目录|章节列表|返回|返回目录|返回书页|返回列表|返回首页|首页|书页|书签|加入书签|加入收藏|收藏本站|收藏本书|推荐票|点击进入|第一页|末页)$/,

  /** JS/CSS 残留：伪协议/函数定义/DOM 访问/花括号成对出现的短行 */
  JS_RESIDUE: /javascript:|function\s*\(|document\.|window\.|\{.*\}/i,
} as const

/**
 * 判断一行（已规范化：trim 后）是否为噪声行。
 * 空字符串返回 false——空行由调用方直接丢弃，不计入噪声统计。
 */
export function isNoiseLine(line: string): boolean {
  const t = line.trim()
  if (!t) return false
  // 纯符号行（仅标点/符号/装饰线，无任何文字）——不含文字不可能是叙事，不限长度
  if (!NOISE_PATTERNS.HAS_TEXT.test(t)) return true
  // 以下规则仅对短行生效，避免误杀含关键词的正常叙事长句
  if (t.length > NOISE_PATTERNS.SHORT_LINE_MAX) return false
  if (NOISE_PATTERNS.URL_LINE.test(t)) return true
  if (NOISE_PATTERNS.SITE_PROMO.test(t)) return true
  if (NOISE_PATTERNS.NAV_EXACT.test(t)) return true
  if (NOISE_PATTERNS.JS_RESIDUE.test(t)) return true
  return false
}

/**
 * 清洗一章正文：
 * - 归一化换行符与空白（\r\n|\r → \n、去行首缩进、行内空白折叠、去空行）
 * - 过滤噪声行（URL/推广/导航/JS 残留/纯符号，详见 NOISE_PATTERNS）
 * - 输出满足存储契约：无空行、无行首缩进，行间单个 \n
 */
export function cleanChapterContent(raw: string): CleanResult {
  if (!raw) return { text: '', removedLines: 0 }
  const normalized = raw.replace(/\r\n?/g, '\n')
  const kept: string[] = []
  let removed = 0
  for (const rawLine of normalized.split('\n')) {
    // 去行首全角空格/NBSP/半角空白 → 行内连续空白折叠为单空格 → 去首尾空白
    const line = rawLine
      .replace(NOISE_PATTERNS.LEADING_INDENT, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!line) continue // 空行直接丢弃（不计入噪声行）
    if (isNoiseLine(line)) {
      removed++
      continue
    }
    kept.push(line)
  }
  return { text: kept.join('\n'), removedLines: removed }
}
