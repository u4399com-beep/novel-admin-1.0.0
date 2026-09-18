'use client'

/**
 * 主题站点工具统一入口（各主题 Layout 用它包裹根节点）：
 * - 挂载 TradProvider（简繁切换全局状态 + DOM 翻译引擎）
 * - chapter 视图自动挂载阅读记录写入器（复用章节查询缓存，不额外发请求）
 */
import type { ReactNode } from 'react'
import type { ThemeView } from '@/themes/types'
import { TradProvider } from './TradProvider'
import { ReadingHistoryRecorder } from './ReadingHistoryRecorder'

export function SiteToolsProvider({ view, children }: { view?: ThemeView; children: ReactNode }) {
  return (
    <TradProvider>
      {view?.name === 'chapter' ? <ReadingHistoryRecorder chapterId={view.chapterId} /> : null}
      {children}
    </TradProvider>
  )
}
