'use client'

/**
 * trxsw 搜索字段模式（杰奇站「搜书名 / 搜作者」双按钮的语义还原）：
 * 源站 trxsw.com（杰奇族）与 x2552.com 实测一致 —— 搜书名按 articlename 字段、
 * 搜作者按 author 字段检索。本地 /api/novels 的 q 参数为 title/author/description
 * 联合模糊（不支持字段参数），故按字段检索在主题内做二次本地过滤：
 * - all    → 服务端 q 检索（书名/作者/简介），服务端分页
 * - title  → 服务端 q 检索后仅保留 title 命中，本地分页（pageSize=60 一次拉取）
 * - author → 服务端 q 检索后仅保留 author 命中，本地分页（pageSize=60 一次拉取）
 * 用 zustand 微 store 让 Layout 页头双按钮与 Search 视图共享字段态。
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
