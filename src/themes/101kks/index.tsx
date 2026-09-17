'use client'

// ==================== 101kks / 101看書 主题入口 ====================
// 蓝白扁平工具风：宝蓝单一主色 + 浅灰底 3px 小圆角轻投影卡片
// 规格来源：/home/z/site-analysis/specs/101kks.md（布局/配色事实，原创实现）

import type { ThemeModule } from '../types'
import { KksLayout } from './Layout'
import { BookView, CategoryView, ChapterView, HomeView, SearchView, TocView } from './views'

const theme: ThemeModule = {
  id: '101kks',
  name: '101看書',
  source: '101kks.com',
  description: '蓝白工具风：窄栏搜索门户首页 + 66/32 详情两列 + 三栏目录 + 独立沉浸式阅读器（设置面板/夜间）',
  swatch: ['#1f6cb2', '#e8f4ff'],
  Layout: KksLayout,
  Home: HomeView,
  Category: CategoryView,
  Book: BookView,
  Toc: TocView,
  Chapter: ChapterView,
  Search: SearchView,
}

export default theme
