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

  /** 行首缩进/空白：全角空格、NBSP、BOM、零宽字符（U+200B-200D）、半角空白（不含换行符） */
  LEADING_INDENT: /^[ \t\u3000\u00a0\ufeff\u200b\u200c\u200d]+/,

  /** 是否含文字（字母/数字，含 CJK）——不含任何文字的行视为纯符号行 */
  HAS_TEXT: /[\p{L}\p{N}]/u,

  /** URL/域名类：含 www. / http、常见 TLD 后缀，或整行像域名 */
  URL_LINE:
    /www\.|https?:\/\/|\.(?:com|net|cc|org|info|xyz|top|vip)(?![a-z])|^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i,

  /** 站点推广/SEO 水印类（短行含任一关键词即判噪声） */
  SITE_PROMO:
    /笔趣阁|顶点小说|飞卢|起点中文|纵横中文|天才一?秒?记住|一秒记住|本章未完|点击下一页|继续阅读请|最新章节|手机阅读|无弹窗|全本小说|请记住本书|首发域名|记得收藏|请收藏本站|收藏网址|求收藏|求推荐票|求月票|投推荐票|加入书签|书迷交流|站内搜索|快速找到你想要的|TXT电子书|电子书下载|全本TXT|TXT全集|TXT下载|最快更新|第一时间更新|本站网址|备用域名|备用网址|看书神器|阅读神器|免费阅读网|小说网址|提供无错|精校版|无错版/,

  /** 导航/UI 残留：整行基本等于这些词（精确匹配，避免误伤叙事） */
  NAV_EXACT:
    /^(?:上一章|上一页|下一章|下一页|上一頁|下一頁|目录|章节目录|章节列表|返回|返回目录|返回书页|返回列表|返回首页|返回书架|回到书架|返回顶部|回顶部|去底部|首页|书页|书签|加入书签|加入收藏|加入书架|放到书架|收藏本站|收藏本书|收藏|推荐票|点击进入|点击收藏|第一页|末页|搜索|搜索全站|正文|封面|书评|打卡|签到|赞|踩|分享)$/,

  /** 页码残留行：纯 1-4 位数字（分页标记），章正文中不可能单独成段 */
  PAGE_NUMBER: /^[0-9]{1,4}$/,

  /** 「本章未完」类断章提示：CMS 分页尾部样板（「本章未完/未完待续」为元信息，不会出现在叙事中） */
  TAIL_HINT:
    /本章未完|未完待续|本章完|请点击下一[页章頁]继续阅读|转载请注明(?:来源|出处)|章节错误.{0,6}点此举报|手机用户请(?:浏览|阅读|访问)|关注公众号|微信公众号|(?:天才|一秒)记住本站最新网址|章节内容(?:错误|缺失)|看不到(?:结尾|结局)/,

  /** TAIL_HINT 的行长度上限（断章提示句常超 SHORT_LINE_MAX，单独放宽） */
  TAIL_LINE_MAX: 80,

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
  if (t.length > NOISE_PATTERNS.SHORT_LINE_MAX) {
    // 断章提示例外：句式固定且属元信息，放宽到 TAIL_LINE_MAX（不在此列的长句照旧放行）
    if (t.length > NOISE_PATTERNS.TAIL_LINE_MAX) return false
    return NOISE_PATTERNS.TAIL_HINT.test(t)
  }
  if (NOISE_PATTERNS.URL_LINE.test(t)) return true
  if (NOISE_PATTERNS.SITE_PROMO.test(t)) return true
  if (NOISE_PATTERNS.NAV_EXACT.test(t)) return true
  if (NOISE_PATTERNS.PAGE_NUMBER.test(t)) return true
  // 断章/水印提示同样适用于短行（「（本章完）」「章节错误(点此举报)」常在 30 字内）
  if (NOISE_PATTERNS.TAIL_HINT.test(t)) return true
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
