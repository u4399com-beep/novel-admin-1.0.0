'use client'

/**
 * 阅读记录（localStorage 持久化，全主题共享）：
 * - key: novel-admin:history，容量上限 50 条
 * - 以 novelId 去重（同一本书只保留最新一条），新记录置顶
 * - 条目自带书名/作者/章节元数据，HistoryPanel 跳转时无需再发请求
 * - 通过 useSyncExternalStore 提供 React 响应式订阅
 */
import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'novel-admin:history'
const MAX_ENTRIES = 50

export interface HistoryEntry {
  novelId: number
  title: string
  /** 详情页缓存缺失时可能为空字符串 */
  author: string
  chapterId: number
  chapterTitle: string
  ts: number
}

const EMPTY: HistoryEntry[] = []
let cache: HistoryEntry[] | null = null
const listeners = new Set<() => void>()

function isEntry(v: unknown): v is HistoryEntry {
  if (typeof v !== 'object' || v === null) return false
  const e = v as Record<string, unknown>
  return (
    typeof e.novelId === 'number' &&
    typeof e.title === 'string' &&
    typeof e.chapterId === 'number' &&
    typeof e.chapterTitle === 'string' &&
    typeof e.ts === 'number'
  )
}

function parse(raw: string | null): HistoryEntry[] {
  if (!raw) return []
  try {
    const v: unknown = JSON.parse(raw)
    if (!Array.isArray(v)) return []
    return v.filter(isEntry)
  } catch {
    return []
  }
}

function readStorage(): HistoryEntry[] {
  if (typeof window === 'undefined') return EMPTY
  return parse(window.localStorage.getItem(STORAGE_KEY))
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function getSnapshot(): HistoryEntry[] {
  if (cache === null) cache = readStorage()
  return cache
}

function commit(next: HistoryEntry[]): void {
  cache = next
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    /* 隐私模式 / 容量不足时忽略持久化失败 */
  }
  listeners.forEach((l) => l())
}

/** React 订阅：读取当前阅读记录（新记录在前） */
export function useHistory(): HistoryEntry[] {
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY)
}

/** 记录一次阅读：同书去重置顶，超出上限裁剪 */
export function addHistory(entry: HistoryEntry): void {
  if (typeof window === 'undefined') return
  const rest = getSnapshot().filter((e) => e.novelId !== entry.novelId)
  commit([entry, ...rest].slice(0, MAX_ENTRIES))
}

/** 删除单本书的记录 */
export function removeHistory(novelId: number): void {
  commit(getSnapshot().filter((e) => e.novelId !== novelId))
}

/** 清空全部记录 */
export function clearHistory(): void {
  commit([])
}

const pad = (n: number) => String(n).padStart(2, '0')

/** 相对时间文案：刚刚 / n 分钟前 / n 小时前 / n 天前 / 日期 */
export function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
