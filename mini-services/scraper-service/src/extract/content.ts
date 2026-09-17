/**
 * 正文容器级清洗：去 script/style/广告链接/站点水印行、段落规范化、去重连续重复行。
 *
 * 与 clean.ts 的分工：本文件是「容器级」清洗（DOM 结构层，引擎侧保留能力），
 * clean.ts 是「行级」噪声统一清洗（与主应用 src/lib/content-clean.ts 同源实现，
 * 修改行级规则必须两边同步——见 clean.ts 文件头互注）。
 * （自 extract.ts 巨石拆分而来，代码逐行原样迁移）
 */
import type { CheerioAPI } from 'cheerio'
import { collapse } from './selectors'
import type { Scope } from './selectors'

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

export interface CleanedContent {
  paragraphs: string[]
  text: string
}

/** 清洗单个正文容器并收割段落 */
export function cleanContainer(el: Scope, $: CheerioAPI): CleanedContent {
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
