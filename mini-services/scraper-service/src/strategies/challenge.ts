/**
 * 挑战页/拦截页检测（Task 23-a 起为四层）。
 * （自 strategies.ts 巨石拆分而来；23-a 新增第 4 层「近空正文 JS 跳板/需 JS 壳」覆盖 HTTP 200 伪装）
 */
import iconv from 'iconv-lite'

/**
 * 已知反爬/拦截平台强特征（任意体积都判定）：
 * Cloudflare（Just a moment / cf-browser-verification / cf_chl_* / challenge-platform /
 * Checking your browser / Attention Required）、DDoS-Guard、Incapsula、Sucuri、AWS WAF。
 * 这些字符串只会出现在拦截页，不会出现在正常章节页，误报风险极低。
 */
const CHALLENGE_PLATFORM_RE =
  /just a moment|cf-browser-verification|cf_chl_|challenge-platform|cdn-cgi\/challenge|checking your browser|attention required|ddos-guard|_Incapsula_Resource|incap_ses_|sucuri_cloudproxy|awswaf|aws waf/i
/** 极小页启发式关键词（挑战专用词，不含裸词 javascript —— 带 script 标签的合法小页面会误报，实测验证） */
const CHALLENGE_KEYWORD_RE = /verify|challenge|captcha|安全验证|人机验证|请完成验证/i
/** 0 秒 meta refresh 跳板（章节页常见的广告跳转/反爬跳板） */
const META_REFRESH_JUMP_RE = /<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]+content\s*=\s*["']?\s*0(\.0+)?\s*;/i

/**
 * 近空正文 + JS 跳转脚本：HTTP 200 伪装的反爬跳板（script 里 window.location /
 * location.replace/assign/href 跳到验证页）。仅当可见正文近空（<80 字符）时判定，
 * 有真实内容的页面永不命中，误报风险极低；对 fetch 系策略而言这类页本就无内容，
 * 标记为挑战后落到 browser 策略由真实浏览器跟进跳转。
 */
const JS_REDIRECT_SHELL_RE =
  /window\.location(\.\w+)?\s*=|location\.(?:replace|assign)\s*\(|location\.href\s*=/i
/** 近空正文 + 「需要启用 JavaScript」壳（SPA/JS 渲染站的 fetch 视角空壳，200 状态伪装正常）。
 *  所有分支都必须带 JS 语境（防「请打开摄像头」这类无关短句误伤） */
const JS_REQUIRED_SHELL_RE =
  /enable.{0,20}javascript|javascript.{0,20}(?:is\s+)?(?:required|disabled|not\s+supported|needs?)|(?:请开启|请打开|请启用|启用|开启).{0,6}(?:javascript|js\b|脚本)|浏览器不支持.{0,10}javascript|不支持.{0,6}javascript/i

/** 剥 script/style 与全部标签/实体后的可见正文（近空判定用） */
function visibleBodyText(scan: string): string {
  return scan
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 挑战页/拦截页检测（四层）：
 * 1) 反爬平台强特征：前 32KB 内命中即判定（真实挑战页可能超过 3KB，旧实现只看 3KB 会漏检）；
 * 2) 近空正文（<80 可见字符）+ JS 跳转脚本 / 「需启用 JS」壳：任意体积，覆盖 200 状态伪装的
 *    JS 跳板与 SPA 空壳（fetch 系策略拿到的 HTML 本就无正文，标记后落 browser 渲染跟进）；
 * 3) 极小页（<3KB）含挑战专用关键词：旧启发式的保留（去除误报率极高的裸词 javascript）；
 *    关键词按 latin1 + UTF-8 + GB18030 三种解码分别匹配（中文关键词只有后两者能命中，见下）
 * 4) 极小页（<3KB）为 0 秒 meta-refresh 跳板且正文近空：典型的「请等待/跳转中」反爬跳板。
 */
export function looksLikeChallenge(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0) return false
  const head = Buffer.from(bytes.subarray(0, 32768))
  const scan = head.toString('latin1')
  if (CHALLENGE_PLATFORM_RE.test(scan)) return true
  // 壳/跳板判定需在多种解码视图上进行：JS 跳板特征是 ASCII（latin1 即可命中），
  // 中文「请开启 JavaScript」等短语在 latin1 视图下是字节乱码永远无法命中，
  // 必须按真实编码（utf8/gb18030）再各判一次（与下方关键词层同理）
  const variants: string[] = [scan, head.toString('utf8')]
  if (iconv.encodingExists('gb18030')) variants.push(iconv.decode(head, 'gb18030'))
  for (const text of variants) {
    // 近空可见正文才启用壳/跳板判定（<80 字符）：有真实内容的页面绝不误伤
    const bodyText = visibleBodyText(text)
    if (bodyText.length >= 80) continue
    if (JS_REDIRECT_SHELL_RE.test(text)) return true
    if (JS_REQUIRED_SHELL_RE.test(text)) return true
  }
  if (bytes.byteLength >= 3072) return false
  // 中文挑战关键词在 latin1 视图下永远无法命中：latin1 是逐字节映射（字节保真），
  // 但「安全验证」的 UTF-8/GBK 字节序列解出的 Latin 字符串并不包含「安全验证」这四个字符，
  // 旧实现据此误以为 latin1 嗅探可覆盖中文关键词 —— 实际是死代码。按真实编码再解码一次才能命中。
  if (CHALLENGE_KEYWORD_RE.test(head.toString('utf8'))) return true
  if (iconv.encodingExists('gb18030') && CHALLENGE_KEYWORD_RE.test(iconv.decode(head, 'gb18030'))) return true
  if (CHALLENGE_KEYWORD_RE.test(scan)) return true
  const bodyTextLatin1 = visibleBodyText(scan)
  if (META_REFRESH_JUMP_RE.test(scan) && bodyTextLatin1.length < 80) return true
  return false
}
