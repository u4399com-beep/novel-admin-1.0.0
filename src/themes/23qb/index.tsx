'use client'

// ==================== 23qb / 铅笔小说 主题入口 ====================
// 杂志式白色大圆角卡片流：浅灰底 + 红橙渐变强调 + 毛玻璃头部
// 规格来源：/home/z/site-analysis/specs/23qb.md（布局/配色事实，原创实现）

import type { ThemeModule } from '../types'
import { QBLayout } from './Layout'
import { BookView, CategoryView, ChapterView, HomeView, SearchView, TocView } from './views'

const theme: ThemeModule = {
  id: '23qb',
  name: '铅笔小说',
  source: '23qb.net',
  description: '杂志式白卡流：浅灰底 + 18px 大圆角 + 红橙渐变强调，搜索 Hero + 封面榜 + 分类文字榜单',
  swatch: ['#ff2a14', '#ff9800'],
  Layout: QBLayout,
  Home: HomeView,
  Category: CategoryView,
  Book: BookView,
  Toc: TocView,
  Chapter: ChapterView,
  Search: SearchView,
}

export default theme
