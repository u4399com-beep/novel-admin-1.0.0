/**
 * 挑战页/拦截页检测（三层）。
 * （自 strategies.ts 巨石拆分而来，代码逐行原样迁移）
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
 * 挑战页/拦截页检测（三层）：
 * 1) 反爬平台强特征：前 32KB 内命中即判定（真实挑战页可能超过 3KB，旧实现只看 3KB 会漏检）；
 * 2) 极小页（<3KB）含挑战专用关键词：旧启发式的保留（去除误报率极高的裸词 javascript）；
 *    关键词按 latin1 + UTF-8 + GB18030 三种解码分别匹配（中文关键词只有后两者能命中，见下）
 * 3) 极小页（<3KB）为 0 秒 meta-refresh 跳板且正文近空：典型的「请等待/跳转中」反爬跳板。
 */
export function looksLikeChallenge(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0) return false
  const head = Buffer.from(bytes.subarray(0, 32768))
  const scan = head.toString('latin1')
  if (CHALLENGE_PLATFORM_RE.test(scan)) return true
  if (bytes.byteLength >= 3072) return false
  // 中文挑战关键词在 latin1 视图下永远无法命中：latin1 是逐字节映射（字节保真），
  // 但「安全验证」的 UTF-8/GBK 字节序列解出的 Latin 字符串并不包含「安全验证」这四个字符，
  // 旧实现据此误以为 latin1 嗅探可覆盖中文关键词 —— 实际是死代码。按真实编码再解码一次才能命中。
  if (CHALLENGE_KEYWORD_RE.test(head.toString('utf8'))) return true
  if (iconv.encodingExists('gb18030') && CHALLENGE_KEYWORD_RE.test(iconv.decode(head, 'gb18030'))) return true
  if (CHALLENGE_KEYWORD_RE.test(scan)) return true
  if (META_REFRESH_JUMP_RE.test(scan)) {
    const bodyText = scan
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (bodyText.length < 80) return true
  }
  return false
}
