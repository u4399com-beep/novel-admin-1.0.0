'use client'

/**
 * 简繁 DOM 翻译引擎（配合 TradProvider 使用）。
 *
 * 机制取舍（详见 worklog Task 2）：
 * - 不包装/改写 React 渲染树，而是对 document.body 的文本节点做「原地翻译」：
 *   1) 开启：TreeWalker 遍历全部文本节点 → 逐节点 s2t/t2s，原文存入 WeakMap（node → 原文）；
 *   2) React 后续 re-render 把节点写回原文时，由 MutationObserver 捕获并重新翻译（rAF 合帧）；
 *   3) 关闭：按 WeakMap 还原原文。React 在同一次 commit 中重写的节点（内容为最新原文）按
 *      「conv(原文) 不匹配则跳过」规则保留 React 的最新输出，不会回写陈旧内容。
 * - 无死循环：仅当 conv(当前文本) !== 当前文本 时才写 DOM，OpenCC 单向转换幂等，
 *   写入触发的 mutation 在下一轮 pass 全部提前返回。
 * - 不翻译 SCRIPT/STYLE/CODE/PRE/TEXTAREA 等节点的文本；属性（placeholder/title）不处理。
 */
import { getConverter, peekConverter, type TradScript } from '@/lib/s2t'

export type TradMode = 'origin' | 'trad' | 'simp'

const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'CODE',
  'PRE',
  'TEXTAREA',
  'KBD',
  'SAMP',
  'VAR',
])

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const WALK_CAP = 8000

let active: TradMode = 'origin'
let observer: MutationObserver | null = null
let rafId = 0
let applySeq = 0

/** 待处理的脏节点（本轮 rAF 合并去重） */
const dirty = new Set<Node>()
/** 原文缓存：仅记录被引擎改写过的文本节点 */
const originals = new WeakMap<Text, string>()

function isCJKText(s: string): boolean {
  return CJK_RE.test(s)
}

function targetOf(mode: TradMode): TradScript | null {
  if (mode === 'trad') return 't'
  if (mode === 'simp') return 's'
  return null
}

/** 深度优先收集文本节点（先收集后处理，避免遍历中改动树结构） */
function forEachTextNode(root: Node, fn: (t: Text) => void): void {
  if (root.nodeType === Node.TEXT_NODE) {
    fn(root as Text)
    return
  }
  if (root.nodeType !== Node.ELEMENT_NODE) return
  const el = root as Element
  if (SKIP_TAGS.has(el.tagName)) return

  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(n: Node): number {
      const p = n.parentElement
      if (p && SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  const nodes: Text[] = []
  let cur: Node | null = walker.nextNode()
  while (cur && nodes.length < WALK_CAP) {
    nodes.push(cur as Text)
    cur = walker.nextNode()
  }
  for (const t of nodes) fn(t)
}

/** 处理单个文本节点（active 模式下） */
function processText(node: Text, conv: (s: string) => string): void {
  const cur = node.nodeValue
  if (!cur || !isCJKText(cur)) return

  const known = originals.get(node)
  if (known !== undefined) {
    // 当前值 = 已转换形态 → 无需处理
    if (cur === conv(known)) return
    // 当前值 = React 重写的全新原文 → 更新缓存的原文
    if (cur !== known) originals.set(node, cur)
  }

  const converted = conv(cur)
  if (converted === cur) return
  originals.set(node, cur)
  node.nodeValue = converted
}

function restoreAll(leaving: TradMode): void {
  const script = targetOf(leaving)
  const conv = script ? peekConverter(script) : null
  forEachTextNode(document.body, (node) => {
    const known = originals.get(node)
    if (known === undefined) return
    originals.delete(node)
    const cur = node.nodeValue ?? ''
    if (cur === known) return
    // 仅当当前值确实是「原文的转换结果」时才回写原文；
    // 其余情况（React 在同一次 commit 写入的最新原文）保留 React 输出。
    if (conv && cur === conv(known)) node.nodeValue = known
  })
}

function runPass(): void {
  rafId = 0
  const script = targetOf(active)
  if (!script) {
    dirty.clear()
    return
  }
  const conv = peekConverter(script)
  if (!conv) {
    dirty.clear()
    return
  }
  const items = Array.from(dirty)
  dirty.clear()
  for (const n of items) forEachTextNode(n, (t) => processText(t, conv))
}

function onMutations(muts: MutationRecord[]): void {
  let added = false
  for (const m of muts) {
    if (m.type === 'characterData') {
      dirty.add(m.target)
      added = true
    } else if (m.type === 'childList') {
      for (const n of m.addedNodes) {
        dirty.add(n)
        added = true
      }
    }
  }
  if (added && rafId === 0) rafId = requestAnimationFrame(runPass)
}

/**
 * 应用目标语言模式（幂等）：
 * - origin：还原原文并停止观察
 * - trad / simp：还原旧状态 → 等待字典加载 → 全量翻译 + 安装 MutationObserver
 * 用 applySeq 防止快速连续切换时的异步竞态。
 */
export async function applyTradMode(mode: TradMode): Promise<void> {
  if (typeof document === 'undefined') return
  const seq = ++applySeq

  if (observer) {
    observer.disconnect()
    observer = null
  }
  if (rafId) {
    cancelAnimationFrame(rafId)
    rafId = 0
  }
  dirty.clear()

  const leaving = active
  active = 'origin'
  if (leaving !== 'origin') restoreAll(leaving)
  active = mode

  const script = targetOf(mode)
  if (!script) return

  const conv = await getConverter(script)
  if (seq !== applySeq || active !== mode) return // 期间用户又切换了模式

  forEachTextNode(document.body, (t) => processText(t, conv))

  observer = new MutationObserver(onMutations)
  observer.observe(document.body, { subtree: true, childList: true, characterData: true })
}
