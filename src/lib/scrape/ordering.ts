/**
 * 章节乱序重排（服务端专用，勿在客户端 import）
 *
 * 源站目录常见两类乱序形态：
 *  1. 书页先渲染「最新章节 N 条（新→旧）」再渲染完整目录（旧→新）——引擎按 DOM 顺序去重后
 *     得到 [最新块(乱) + 正文块(有序)]，直接按抓取顺序编 idx 会让整本阅读顺序错乱；
 *  2. 整站目录新→旧倒序输出。
 *
 * 策略：以章节标题中的「第N章/节/回/话」序号为主键做乱序检测与稳定重排：
 * - 无重复序号：位置错乱占比超阈值 → 全局稳定排序（未编号章节锚定在前一编号章节之后）；
 * - 有重复序号（分卷各自重新编号）：无分卷信息可用（Chapter.volume 已随 schema 演进移除），
 *   只做保守的「头部倒序块后移」修复；
 * - 编号章节过少（信号不足）或未见乱序 → 原样返回。
 */
import type { ChapterRef } from './types'

/** 编号章节少于该值不做乱序判定（信号不足，误判代价大于收益） */
const NUMBERED_MIN = 8
/** 位置错乱占比超过该阈值才重排（已有序目录 0%；最新块/整本倒序 ≈100%） */
const DISORDER_RATIO = 0.2

const CN_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
}
const CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 }
const CN_BIG: Record<string, number> = { 万: 10_000, 亿: 100_000_000 }

/** 中文数字解析：支持 零〇一二两三四五六七八九十百千万亿 组合（如 两百零三、一千零一十、三千五百万） */
export function chineseNumeralToInt(s: string): number | null {
  if (!s) return null
  // 纯阿拉伯数字直接转
  if (/^\d{1,9}$/.test(s)) return Number.parseInt(s, 10)
  let total = 0 // 已完成的大节（万/亿以上）
  let section = 0 // 当前万/亿节内累计
  let current = 0 // 当前位累计
  let any = false
  for (const ch of s) {
    if (CN_DIGITS[ch] !== undefined) {
      current = CN_DIGITS[ch]
      any = true
    } else if (CN_UNITS[ch]) {
      const u = CN_UNITS[ch]
      section += (current || 1) * u // 「十」开头（十五）按 1 处理
      current = 0
      any = true
    } else if (CN_BIG[ch]) {
      const b = CN_BIG[ch]
      section = (section + current) * b
      total += section
      section = 0
      current = 0
      any = true
    } else {
      return null // 未知字符（「第X卷」里的非数字内容等）
    }
  }
  if (!any) return null
  return total + section + current
}

const CHAPTER_NO_RE =
  /^第\s*([0-9]{1,7}|[零〇一二两三四五六七八九十百千万]{1,12})\s*[章节回话]/

/**
 * 解析章节标题中的序号：第N章/节/回/话（阿拉伯或中文数字）、
 * 或「123.」「123、」纯数字前缀。解析失败返回 null（序章/番外/未编号等）。
 */
export function parseChapterNo(title: string): number | null {
  const t = (title || '').trim()
  if (!t) return null
  const m = CHAPTER_NO_RE.exec(t)
  if (m) {
    const n = chineseNumeralToInt(m[1])
    return n != null && n >= 0 && n <= 99_999_999 ? n : null
  }
  const pre = /^(\d{1,5})[.、:：]\s*\S/.exec(t)
  if (pre) return Number.parseInt(pre[1], 10)
  return null
}

/** 稳定排序键：编号章节取序号；未编号锚定在前一编号章节之后（0.5 偏移，未编号间保持原序） */
function sortKeys(nums: (number | null)[]): number[] {
  const keys: number[] = []
  let last = 0
  for (const n of nums) {
    if (n != null) {
      last = n
      keys.push(n)
    } else {
      keys.push(last + 0.5)
    }
  }
  return keys
}

/** 位置错乱占比：与升序排序后的序列逐位比较，不同位 / 总数 */
function disorderRatio(nums: number[]): number {
  if (nums.length === 0) return 0
  const sorted = [...nums].sort((a, b) => a - b)
  let mismatch = 0
  for (let i = 0; i < nums.length; i++) {
    if (nums[i] !== sorted[i]) mismatch++
  }
  return mismatch / nums.length
}

export interface ReorderResult {
  refs: ChapterRef[]
  reordered: boolean
  /** 面向任务日志的说明（未重排时为空串） */
  note: string
}

/**
 * 章节引用乱序重排主入口。传入引擎提取（含目录页二次提取后）的完整章节引用列表，
 * 返回阅读顺序修正后的列表与说明。list 永不为 null；异常时原样返回保证采集不中断。
 */
export function reorderChapterRefs(refs: ChapterRef[]): ReorderResult {
  try {
    return reorderImpl(refs)
  } catch {
    return { refs, reordered: false, note: '' }
  }
}

function reorderImpl(refs: ChapterRef[]): ReorderResult {
  if (refs.length < NUMBERED_MIN) return { refs, reordered: false, note: '' }
  const nums = refs.map((r) => parseChapterNo(r.title))
  const numberedIdx: number[] = []
  for (let i = 0; i < nums.length; i++) if (nums[i] != null) numberedIdx.push(i)
  if (numberedIdx.length < NUMBERED_MIN) return { refs, reordered: false, note: '' }

  const numberedVals = numberedIdx.map((i) => nums[i] as number)
  const hasDup = new Set(numberedVals).size !== numberedVals.length

  if (!hasDup) {
    const ratio = disorderRatio(numberedVals)
    if (ratio <= DISORDER_RATIO) return { refs, reordered: false, note: '' }
    const keys = sortKeys(nums)
    const ordered = refs.map((r, i) => ({ r, k: keys[i] }))
    ordered.sort((a, b) => a.k - b.k) // 同键保持原序（Array.prototype.sort 稳定）
    const out = ordered.map((x) => x.r)
    return {
      refs: out,
      reordered: true,
      note: `检测到章节乱序（位置错乱 ${(ratio * 100).toFixed(0)}%），已按章节序号重排`,
    }
  }

  // ---- 重复序号（分卷各自编号场景）：无分卷信息可用，只做保守修复——
  // 「头部倒序块」整体后移（最新章节块形态）
  return fixLeadingDescendingBlock(refs, nums)
}

/** 保守修复（重复序号且无分卷信息可用）：头部严格倒序块（最新章节新→旧）且其余部分有序 → 块移到尾部升序 */
function fixLeadingDescendingBlock(refs: ChapterRef[], nums: (number | null)[]): ReorderResult {
  // 头部倒序块：自首位起连续的编号章节（不夹杂未编号，保守边界）序号严格递减
  let k = 0
  let blockEnd = 0
  let prev: number | null = null
  for (let i = 0; i < nums.length; i++) {
    const n = nums[i]
    if (n == null) break
    if (prev != null && n >= prev) break
    prev = n
    k++
    blockEnd = i + 1
    if (k > 60) break // 最新块通常 ≤ 60 条；超长倒序块按整本倒序处理，不适用本修复
  }
  if (k < 2 || blockEnd >= nums.length) return { refs, reordered: false, note: '' }
  const restVals = nums.slice(k).filter((n): n is number => n != null)
  if (restVals.length < NUMBERED_MIN) return { refs, reordered: false, note: '' }
  // 其余部分必须基本有序（非降）才认定头部块是「最新章节」
  let nonDesc = true
  for (let i = 1; i < restVals.length; i++) {
    if (restVals[i] < restVals[i - 1]) {
      nonDesc = false
      break
    }
  }
  if (!nonDesc) return { refs, reordered: false, note: '' }
  const head = refs.slice(0, k).reverse() // 新→旧 → 旧→新
  const out = [...refs.slice(k), ...head]
  return {
    refs: out,
    reordered: true,
    note: `头部「最新章节」块（${k} 章，新→旧）已移至目录尾部并按更新顺序排列`,
  }
}
