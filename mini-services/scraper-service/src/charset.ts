/**
 * 字符集检测与解码。
 * 优先级：请求强制指定 > BOM 嗅探 > HTTP Content-Type > HTML meta charset > UTF-8 字节嗅探 > GBK 兜底。
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
  gb2312: 'gbk',
  gb_2312: 'gbk',
  gb231280: 'gbk',
  csgb2312: 'gbk',
  gbk2312: 'gbk',
  cp936: 'gbk',
  ms936: 'gbk',
  cp950: 'big5',
  big5hkscs: 'big5-hkscs',
  iso88591: 'iso-8859-1',
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

  const tryDecode = (enc: string | null, source: string): string | null => {
    if (!enc) return null
    if (!iconv.encodingExists(enc)) {
      warnings.push(`编码 ${enc}（来源: ${source}）不受支持，跳过`)
      return null
    }
    try {
      return iconv.decode(toBuffer(bytes), enc)
    } catch {
      warnings.push(`编码 ${enc}（来源: ${source}）解码失败，跳过`)
      return null
    }
  }

  // 1) 强制指定 2) BOM 3) HTTP 头 4) meta 声明
  const candidates: Array<[string | null, string]> = [
    [forced, '请求强制指定'],
    [bom, 'BOM 嗅探'],
    [header, 'HTTP Content-Type'],
    [meta, 'HTML meta 声明'],
  ]
  for (const [enc, source] of candidates) {
    const text = tryDecode(enc, source)
    if (text !== null && text.length > 0) {
      return { encoding: enc!.toUpperCase(), text, warnings: dedupe(warnings) }
    }
  }

  // 5) 字节嗅探：合法 UTF-8 则用 UTF-8
  if (looksValidUtf8(bytes)) {
    return {
      encoding: 'UTF-8',
      text: toBuffer(bytes).toString('utf8'),
      warnings: dedupe([...warnings, '响应未声明编码，按 UTF-8 字节嗅探解码']),
    }
  }

  // 6) 兜底：GBK（中文小说站最常见的历史编码）
  const gbkText = tryDecode('gbk', 'GBK 兜底')
  if (gbkText !== null && gbkText.length > 0) {
    return {
      encoding: 'GBK',
      text: gbkText,
      warnings: dedupe([...warnings, '未声明编码且非合法 UTF-8，按 GBK 兜底解码（中文站常见情况）']),
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
