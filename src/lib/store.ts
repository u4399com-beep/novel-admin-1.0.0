'use client'

import { create } from 'zustand'
import type { ThemeView } from '@/themes/types'

interface AppState {
  view: ThemeView
  history: ThemeView[]
  /** 搜索框草稿（供 Layout 顶栏共享） */
  searchDraft: string
  navigate: (view: ThemeView) => void
  goBack: () => void
  setSearchDraft: (s: string) => void
}

function sameView(a: ThemeView, b: ThemeView): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export const useAppStore = create<AppState>((set, get) => ({
  view: { name: 'home' },
  history: [],
  searchDraft: '',
  navigate: (view) => {
    const { view: current, history } = get()
    if (sameView(current, view)) return
    set({ view, history: [...history.slice(-19), current], searchDraft: view.name === 'search' ? get().searchDraft : '' })
    if (typeof window !== 'undefined') window.scrollTo({ top: 0 })
  },
  goBack: () => {
    const { history } = get()
    if (history.length === 0) {
      set({ view: { name: 'home' } })
      return
    }
    const prev = history[history.length - 1]
    set({ view: prev, history: history.slice(0, -1) })
  },
  setSearchDraft: (s) => set({ searchDraft: s }),
}))
