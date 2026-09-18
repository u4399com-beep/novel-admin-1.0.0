'use client'

import { useSyncExternalStore } from 'react'

/**
 * 全站共享「阅读设置」（所有主题的章节阅读页共用同一份偏好）：
 * 字号 / 行距 / 字体 / 背景场景，localStorage 持久化、跨主题跨会话一致。
 *
 * 实现说明：模块级极小外部 store + useSyncExternalStore。
 * - 服务端返回默认值（主题视图只在客户端挂载，正常不会用到 server snapshot）
 * - 客户端在模块加载时同步读一次 localStorage，首帧即拿到用户偏好（无闪烁）
 */

/** 背景场景语义键（各主题自行映射为自己的配色） */
export type ReaderScene = 'day' | 'paper' | 'green' | 'blue' | 'night'
export type ReaderFont = 'default' | 'song' | 'hei' | 'kai'

export interface ReaderPrefs {
  /** 正文字号 px（14–28） */
  fontSize: number
  /** 正文行高（1.4–2.6） */
  lineHeight: number
  /** 字体族 */
  font: ReaderFont
  /** 背景场景 */
  scene: ReaderScene
  /** 正文字色（'' = 跟随背景；其余为 #RRGGBB） */
  ink: string
}

export const READER_FONT = { min: 14, max: 28, step: 2, default: 18 } as const
/** 行距快捷档（滑杆主题可用区间内任意值） */
export const READER_LINE_HEIGHTS = [1.5, 1.8, 2.0, 2.2] as const
/** 字号快捷档（A- / A / A+ 按此档位步进） */
export const READER_FONT_STEPS = [14, 16, 18, 20, 22, 24, 26, 28] as const

export const READER_FONTS: { key: ReaderFont; label: string; stack: string }[] = [
  { key: 'default', label: '默认', stack: '' },
  { key: 'song', label: '宋体', stack: '"Songti SC","SimSun",serif' },
  { key: 'hei', label: '黑体', stack: '"Heiti SC","SimHei","Microsoft YaHei",sans-serif' },
  { key: 'kai', label: '楷体', stack: 'KaiTi,STKaiti,"楷体",serif' },
]

export const READER_SCENES: { key: ReaderScene; label: string }[] = [
  { key: 'day', label: '日间' },
  { key: 'paper', label: '羊皮纸' },
  { key: 'green', label: '护眼' },
  { key: 'blue', label: '淡蓝' },
  { key: 'night', label: '夜间' },
]

/** 字色预设（v='' = 跟随背景场景色；各主题按自身美学渲染控件） */
export const READER_INKS: { k: string; v: string }[] = [
  { k: '跟随背景', v: '' },
  { k: '深棕', v: '#5b4636' },
  { k: '墨绿', v: '#234d3f' },
  { k: '藏蓝', v: '#2c3e5d' },
  { k: '炭黑', v: '#262626' },
]

/** 场景配色：主题按此结构提供自己的色板 */
export interface ReaderSceneColors {
  /** 页面/外围底色 */
  page: string
  /** 正文纸面底色 */
  paper: string
  /** 默认正文文字色（用户未自选字色时生效） */
  ink: string
  /** 次要文字色（元信息/页脚提示） */
  muted: string
  /** 分隔线颜色 */
  line: string
}

export const READER_DEFAULTS: ReaderPrefs = {
  fontSize: READER_FONT.default,
  lineHeight: 1.8,
  font: 'default',
  scene: 'day',
  ink: '',
}

const LS_KEY = 'reader-prefs-v1'
/** 旧版 aijjxs 主题独立键：迁移后清除 */
const LEGACY_AJ_KEY = 'aj-reader-setting'

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n * 10) / 10))
}

function sanitize(raw: unknown): ReaderPrefs {
  const p = (raw ?? {}) as Partial<ReaderPrefs>
  const font = READER_FONTS.some((f) => f.key === p.font) ? (p.font as ReaderFont) : READER_DEFAULTS.font
  const scene = READER_SCENES.some((s) => s.key === p.scene) ? (p.scene as ReaderScene) : READER_DEFAULTS.scene
  const ink = typeof p.ink === 'string' && (/^#[0-9a-fA-F]{6}$/.test(p.ink) || p.ink === '') ? p.ink : ''
  return {
    fontSize: clampNum(p.fontSize, READER_FONT.min, READER_FONT.max, READER_DEFAULTS.fontSize),
    lineHeight: clampNum(p.lineHeight, 1.4, 2.6, READER_DEFAULTS.lineHeight),
    font,
    scene,
    ink,
  }
}

/* ---------- 外部 store ---------- */

let prefs: ReaderPrefs = READER_DEFAULTS
let ready = false
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((l) => l())
}

function persist() {
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(prefs))
  } catch {
    /* 隐私模式等场景忽略持久化失败 */
  }
}

/** 从旧版 aijjxs 独立设置迁移（一次性） */
function migrateLegacyAj() {
  try {
    const raw = window.localStorage.getItem(LEGACY_AJ_KEY)
    if (!raw) return
    const old = JSON.parse(raw) as { size?: number; bg?: number; font?: number; ink?: number }
    const AJ_SIZES = [19, 21, 23, 25, 28]
    const AJ_BGS: ReaderScene[] = ['day', 'paper', 'green', 'blue', 'paper', 'night']
    const AJ_FONTS: ReaderFont[] = ['default', 'song', 'hei', 'kai', 'hei']
    const AJ_INKS = ['', '#5b4636', '#234d3f', '#2c3e5d', '#262626']
    prefs = sanitize({
      fontSize: AJ_SIZES[old.size ?? 2] ?? READER_DEFAULTS.fontSize,
      scene: AJ_BGS[old.bg ?? 0] ?? READER_DEFAULTS.scene,
      font: AJ_FONTS[old.font ?? 0] ?? READER_DEFAULTS.font,
      ink: AJ_INKS[old.ink ?? 0] ?? '',
      lineHeight: READER_DEFAULTS.lineHeight,
    })
    persist()
  } catch {
    /* 迁移失败静默降级为默认 */
  } finally {
    try {
      window.localStorage.removeItem(LEGACY_AJ_KEY)
    } catch {
      /* 忽略 */
    }
  }
}

if (typeof window !== 'undefined') {
  try {
    const raw = window.localStorage.getItem(LS_KEY)
    if (raw) {
      prefs = sanitize(JSON.parse(raw))
    } else {
      migrateLegacyAj()
    }
  } catch {
    prefs = READER_DEFAULTS
  }
  ready = true
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

function getSnapshot() {
  return prefs
}

function getServerSnapshot() {
  return READER_DEFAULTS
}

/** 部分更新偏好并持久化 */
export function setReaderPrefs(patch: Partial<ReaderPrefs>) {
  const next = sanitize({ ...prefs, ...patch })
  if (
    next.fontSize === prefs.fontSize &&
    next.lineHeight === prefs.lineHeight &&
    next.font === prefs.font &&
    next.scene === prefs.scene &&
    next.ink === prefs.ink
  ) {
    return
  }
  prefs = next
  if (ready) persist()
  emit()
}

/** 恢复默认偏好 */
export function resetReaderPrefs() {
  setReaderPrefs(READER_DEFAULTS)
}

/** 按档位步进字号（A- / A+） */
export function stepFontSize(current: number, dir: -1 | 1): number {
  const steps = READER_FONT_STEPS
  const idx = steps.findIndex((s) => s >= current)
  const at = idx === -1 ? steps.length - 1 : current > steps[idx] ? idx + 1 : idx
  const next = Math.min(steps.length - 1, Math.max(0, at + dir))
  return steps[next]
}

/** 字号/行距/字体/背景 共享偏好 hook：[prefs, setPrefs, reset] */
export function useReaderPrefs(): [
  ReaderPrefs,
  (patch: Partial<ReaderPrefs>) => void,
  () => void,
] {
  const p = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  return [p, setReaderPrefs, resetReaderPrefs]
}

/** 解析字体栈（'' 返回 undefined，便于继承主题默认字体） */
export function readerFontStack(key: ReaderFont): string | undefined {
  return READER_FONTS.find((f) => f.key === key)?.stack || undefined
}

/** 正文字色：用户自选优先，否则跟随场景 */
export function readerInk(prefs: ReaderPrefs, colors: ReaderSceneColors): string {
  return prefs.ink || colors.ink
}
