'use client'

/**
 * 阅读记录面板（受控组件，全主题共享中性样式）：
 * - open/onClose 由主题 Layout 控制；navigate 由主题契约传入
 * - 条目自带全部元数据（书名/章节/时间），点击直接跳章节视图，不再发请求
 * - 移动端为底部抽屉，桌面端居中小窗；max-h + 内部滚动 + 细滚动条
 * - accent 为主题主色（仅用于标题与高亮点缀），缺省用中性色
 */
import { useEffect } from 'react'
import { BookOpen, History, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { clearHistory, relativeTime, useHistory } from '@/lib/reading-history'
import type { ThemeView } from '@/themes/types'

export interface HistoryPanelProps {
  open: boolean
  onClose: () => void
  navigate: (view: ThemeView) => void
  /** 主题主色（hex / CSS 颜色），用于标题与「继续阅读」点缀 */
  accent?: string
}

/** Tailwind 任意变体实现的细滚动条（避免改全局 CSS） */
const SCROLLBAR_CLS =
  '[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-neutral-300 [&::-webkit-scrollbar-track]:bg-transparent hover:[&::-webkit-scrollbar-thumb]:bg-neutral-400'

export function HistoryPanel({ open, onClose, navigate, accent }: HistoryPanelProps) {
  const entries = useHistory()

  // Esc 关闭 + 打开时锁定背景滚动
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  if (!open) return null

  const goChapter = (chapterId: number) => {
    navigate({ name: 'chapter', chapterId })
    onClose()
  }
  const goBook = (novelId: number) => {
    navigate({ name: 'book', novelId })
    onClose()
  }
  const handleClear = () => {
    if (entries.length === 0) return
    if (!window.confirm('确定清空全部阅读记录？')) return
    clearHistory()
    toast.success('已清空阅读记录')
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/40 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="阅读记录"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[78vh] w-full flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:max-h-[70vh] sm:max-w-[460px] sm:rounded-2xl"
      >
        {/* 头部 */}
        <div className="flex flex-none items-center gap-2 border-b border-neutral-100 px-4 py-3">
          <History className="h-4.5 w-4.5 text-neutral-400" style={accent ? { color: accent } : undefined} />
          <h2 className="text-[15px] font-semibold text-neutral-900" style={accent ? { color: accent } : undefined}>
            阅读记录
          </h2>
          {entries.length > 0 && <span className="text-xs text-neutral-400">{entries.length} 条</span>}
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={handleClear}
              disabled={entries.length === 0}
              title="清空阅读记录"
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-neutral-400"
            >
              <Trash2 className="h-4 w-4" />
              <span className="sr-only">清空阅读记录</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              title="关闭"
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700"
            >
              <X className="h-4 w-4" />
              <span className="sr-only">关闭面板</span>
            </button>
          </div>
        </div>

        {/* 列表 */}
        {entries.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
            <History className="h-10 w-10 text-neutral-200" />
            <p className="text-sm font-medium text-neutral-500">暂无阅读记录</p>
            <p className="text-xs text-neutral-400">打开任意章节后，这里会自动记录最近读过的书</p>
          </div>
        ) : (
          <ul className={`max-h-[52vh] overflow-y-auto sm:max-h-[50vh] ${SCROLLBAR_CLS}`}>
            {entries.map((e) => (
              <li
                key={e.novelId}
                className="group flex cursor-pointer items-center gap-3 border-b border-neutral-50 px-4 py-3 transition-colors last:border-b-0 hover:bg-neutral-50"
                onClick={() => goChapter(e.chapterId)}
                role="button"
                tabIndex={0}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault()
                    goChapter(e.chapterId)
                  }
                }}
              >
                <div className="min-w-0 flex-1">
                  <p
                    className="truncate text-sm font-medium text-neutral-900 transition-colors group-hover:text-[var(--hist-accent,#111)]"
                    style={accent ? ({ '--hist-accent': accent } as React.CSSProperties) : undefined}
                  >
                    {e.title}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-neutral-500">
                    {e.chapterTitle}
                    <span className="mx-1.5 text-neutral-300">·</span>
                    {relativeTime(e.ts)}
                  </p>
                </div>
                <button
                  type="button"
                  title="查看书籍详情"
                  aria-label={`查看《${e.title}》详情`}
                  onClick={(ev) => {
                    ev.stopPropagation()
                    goBook(e.novelId)
                  }}
                  className="flex h-8 w-8 flex-none cursor-pointer items-center justify-center rounded-lg text-neutral-300 transition-colors hover:bg-neutral-100 hover:text-neutral-600"
                >
                  <BookOpen className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* 底部提示 */}
        {entries.length > 0 && (
          <div className="flex flex-none items-center border-t border-neutral-100 px-4 py-2 text-[11px] text-neutral-400">
            <span>点击条目继续阅读该章节 · 最多保留 50 条</span>
          </div>
        )}
      </div>
    </div>
  )
}
