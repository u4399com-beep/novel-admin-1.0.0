'use client'

/**
 * x2552 搜索字段模式 —— 源站 x2552.com 实测还原：
 * 头部搜索表单含双按钮（so_book/so_author），分别以
 * searchtype=articlename（搜书名）/ searchtype=author（搜作者）提交。
 * 本地 /api/novels 的 q 为 title/author/description 联合模糊，故字段检索
 * 在主题内做二次本地过滤（title/author → 拉取后仅保留对应字段命中）。
 */

import { create } from 'zustand'

export type SearchField = 'all' | 'title' | 'author'

interface SearchFieldState {
  field: SearchField
  setField: (f: SearchField) => void
}

export const useSearchField = create<SearchFieldState>((set) => ({
  field: 'all',
  setField: (field) => set({ field }),
}))
