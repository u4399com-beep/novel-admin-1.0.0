/**
 * 字符集检测与解码。
 * 优先级（对齐 WHATWG 编码嗅探，经审查确认）：
 *   请求强制指定 > BOM 嗅探 > HTTP Content-Type > HTML meta charset > UTF-8 字节嗅探 > GB18030 兜底 > latin1 透传。
 * 注：BOM 位于 HTTP 头之前是 WHATWG 标准行为 —— BOM 是文件自身的强证据；
 * 若按"头 → meta → BOM"顺序，服务器误报 charset=gbk 的 UTF-8/UTF-16 页面会先被错误解码成乱码。
 * 中文小说站大量使用 GBK/GB2312/GB18030/BIG5，统一用 iconv-lite 解码。
 */
import iconv from 'iconv-lite'

export interface DecodeResult {
  /** 规范化后的编码名（大写显示用），如 UTF-8 / GBK / GB18030 / BIG5 */
  encoding: string
  text: string
  warnings: string[]
}

export interface DecodeOptions {
  /** 来自请求 body 的强制编码（用户在 ScrapeRuleDto.charset 配置的值） */
  forcedCharset?: string | null
  /** 来自 HTTP 响应 Content-Type 头的 charset */
  headerCharset?: string | null
}

/** 常见别名 → iconv-lite 编码名 */
const ALIAS: Record<string, string> = {
  utf8: 'utf-8',
  'unicode-1-1-utf-8': 'utf-8',
  unicode: 'utf-8',
  'unicode-1-1': 'utf-8',
  utf16: 'utf-16le',
  'utf-16': 'utf-16le',
  unicodefffe: 'utf-16be',
  gb2312: 'gbk',
  gb_2312: 'gbk',
  'gb_2312-80': 'gbk',
  gb231280: 'gbk',
  csgb2312: 'gbk',
  cngb: 'gbk',
  chinese: 'gbk',
  gbk2312: 'gbk',
  'x-gbk': 'gbk',
  // GB18030 是 GBK 的官方超集，iconv-lite 直接支持；显式别名防止被误标准化为 gbk
  gb18030: 'gb18030',
  'gb18030-2000': 'gb18030',
  'gb18030-2005': 'gb18030',
  'gb18030-2022': 'gb18030',
  cp936: 'gbk',
  ms936: 'gbk',
  cp950: 'big5',
  big5hkscs: 'big5-hkscs',
  'big5-hkscs': 'big5-hkscs',
  'x-big5': 'big5',
  iso88591: 'iso-8859-1',
  'iso8859-1': 'iso-8859-1',
  latin1: 'iso-8859-1',
  l1: 'iso-8859-1',
  cp1252: 'windows-1252',
  sjis: 'shift_jis',
  'shift-jis': 'shift_jis',
  shiftjs: 'shift_jis',
  ksc5601: 'euc-kr',
  euckr: 'euc-kr',
}

export function normalizeCharset(raw?: string | null): string | null {
  if (!raw || typeof raw !== 'string') return null
  const s = raw.trim().toLowerCase().replace(/^["']+|["']+$/g, '')
  if (!s) return null
  return ALIAS[s] ?? s
}

/** 从 Content-Type 头提取 charset */
export function charsetFromContentType(contentType?: string | null): string | null {
  if (!contentType) return null
  const m = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType)
  return m ? m[1] : null
}

/** BOM 嗅探 */
function sniffBom(bytes: Uint8Array): string | null {
  if (bytes.length < 3) return null
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8'
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
  return null
}

/** 在前 4KB 内找 <meta charset=...> / <meta http-equiv=content-type content=...charset=...> */
function metaCharset(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes.subarray(0, 4096)).toString('latin1')
  const m = /<meta[^>]+charset\s*=\s*["']?\s*([a-zA-Z0-9._-]+)/i.exec(head)
  return m ? m[1] : null
}

/** UTF-8 严格校验（fatal 模式下抛错即非 UTF-8） */
function looksValidUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/**
 * 替换符守卫：iconv-lite 的非 UTF-8 解码是宽松模式（坏字节 → U+FFFD），永不抛错，
 * 因此"用错误的编码解码"也会得到非空文本（典型：服务器误报 charset 的 GBK 页被按 utf-8 解出满屏 �）。
 * 这里用 U+FFFD 占比判断候选解码是否可信：占比超阈值视为解码失败，继续尝试下一候选。
 */
function replacementRatio(text: string): number {
  if (!text.length) return 0
  let bad = 0
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 0xfffd) bad++
  return bad / text.length
}
const MAX_REPLACEMENT_RATIO = 0.01

/**
 * 主入口：把原始响应字节安全解码为文本。
 * 全程不 throw，失败逐级降级并在 warnings 中说明。
 */
export function decodeHtml(bytes: Uint8Array, opts: DecodeOptions = {}): DecodeResult {
  const warnings: string[] = []
  if (bytes.length === 0) {
    return { encoding: 'UTF-8', text: '', warnings: ['响应体为空'] }
  }

  const forced = normalizeCharset(opts.forcedCharset)
  if (opts.forcedCharset && !forced) warnings.push('强制编码参数无法解析，已忽略')
  const bom = sniffBom(bytes)
  const header = normalizeCharset(opts.headerCharset)
  const meta = normalizeCharset(metaCharset(bytes))
  if (header && meta && header !== meta) {
    warnings.push(`HTTP 头声明 ${header} 与 HTML meta 声明 ${meta} 不一致，优先采用 HTTP 头`)
  }

  const tryDecode = (enc: string | null, source: string, guard: boolean): string | null => {
    if (!enc) return null
    if (!iconv.encodingExists(enc)) {
      warnings.push(`编码 ${enc}（来源: ${source}）不受支持，跳过`)
      return null
    }
    let text: string
    try {
      text = iconv.decode(toBuffer(bytes), enc)
    } catch {
      warnings.push(`编码 ${enc}（来源: ${source}）解码失败，跳过`)
      return null
    }
    if (text.length === 0) return null
    if (guard) {
      const ratio = replacementRatio(text)
      if (ratio > MAX_REPLACEMENT_RATIO) {
        warnings.push(`编码 ${enc}（来源: ${source}）解码后乱码占比 ${(ratio * 100).toFixed(1)}%（疑似编码声明错误），跳过`)
        return null
      }
    }
    return text
  }

  // 1) 强制指定 2) BOM 3) HTTP 头 4) meta 声明
  // guard 仅对"声明可能出错"的头/meta 生效；强制指定与 BOM 是明确意图/强证据，不做占比拦截
  const candidates: Array<[string | null, string, boolean]> = [
    [forced, '请求强制指定', false],
    [bom, 'BOM 嗅探', false],
    [header, 'HTTP Content-Type', true],
    [meta, 'HTML meta 声明', true],
  ]
  for (const [enc, source, guard] of candidates) {
    const text = tryDecode(enc, source, guard)
    if (text !== null) {
      return { encoding: enc!.toUpperCase(), text, warnings: dedupe(warnings) }
    }
  }

  // 5) 字节嗅探：合法 UTF-8 则用 UTF-8
  if (looksValidUtf8(bytes)) {
    return {
      encoding: 'UTF-8',
      text: toBuffer(bytes).toString('utf8'),
      warnings: dedupe([...warnings, '响应未声明（有效）编码，按 UTF-8 字节嗅探解码']),
    }
  }

  // 6) 兜底：GB18030（中文小说站最常见的历史编码）。
  // GB18030 是 GBK 的严格超集：GBK 字节序列解码结果完全一致（实测验证），
  // 且能正确处理 GB18030 四字节字符（GBK 会解出乱码），故用 gb18030 而非 gbk。
  const gbkText = tryDecode('gb18030', 'GB18030 兜底', true)
  if (gbkText !== null) {
    return {
      encoding: 'GB18030',
      text: gbkText,
      warnings: dedupe([...warnings, '未声明编码且非合法 UTF-8，按 GB18030 兜底解码（GB18030 兼容 GBK，中文站常见情况）']),
    }
  }

  // 7) 最终透传：latin1 永不失败
  return {
    encoding: 'ISO-8859-1',
    text: toBuffer(bytes).toString('latin1'),
    warnings: dedupe([...warnings, '所有解码策略失败，已按 latin1 透传（结果可能乱码）']),
  }
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)]
}
