'use client'

/**
 * 阅读记录写入器（无 UI）：
 * - 在 chapter 视图挂载（由 SiteToolsProvider 依据 view 自动渲染）
 * - 复用 useChapter 的 react-query 缓存（与主题章节视图共享同一条请求），不额外发请求
 * - useEffect 惰性写入（数据就绪后），避免 SSR/水合期访问 localStorage
 * - author 从 novel 详情的查询缓存中尽力补全（用户先看过书页时可用），缺省为空字符串
 */
import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useChapter } from '@/hooks/use-novel-data'
import { qk } from '@/hooks/use-novel-data'
import { addHistory } from '@/lib/reading-history'
import type { NovelDetail } from '@/lib/types'

export function ReadingHistoryRecorder({ chapterId }: { chapterId: number }) {
  const queryClient = useQueryClient()
  const { data } = useChapter(chapterId)

  useEffect(() => {
    if (!data) return
    const novel = queryClient.getQueryData<NovelDetail>(qk.novel(data.novelId))
    addHistory({
      novelId: data.novelId,
      title: data.novelTitle,
      author: novel?.author ?? '',
      chapterId: data.id,
      chapterTitle: data.title,
      ts: Date.now(),
    })
  }, [data, queryClient])

  return null
}
