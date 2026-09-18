'use client'

import type { ComponentType, ReactNode } from 'react'

/** SPA 内部路由视图 —— 所有主题共用同一套视图契约 */
export type ThemeView =
  | { name: 'home' }
  | { name: 'category'; categoryId?: number; page?: number }
  | { name: 'book'; novelId: number }
  | { name: 'toc'; novelId: number }
  | { name: 'chapter'; chapterId: number }
  | { name: 'search'; query: string }
  | { name: 'pseo'; keyword: string }

export interface ViewProps {
  /** 视图跳转（主题内所有链接点击都应调用它，不要用 <a href>） */
  navigate: (view: ThemeView) => void
  siteName: string
  notice?: string
}

export interface ThemeLayoutProps extends ViewProps {
  /** 当前视图（Layout 据此决定页头/页脚形态，例如正文页可收起导航） */
  view: ThemeView
  children: ReactNode
}

/**
 * 主题模块契约：每套主题实现 6 个视图 + 1 个可选全局 Layout。
 * Layout 负责页头/导航/页脚等全站框架；视图组件只渲染内容区。
 */
export interface ThemeModule {
  id: string
  name: string
  /** 仿写来源站点域名（展示用） */
  source: string
  description: string
  /** 预览主色（用于主题选择卡片） */
  swatch: [string, string]
  Layout: ComponentType<ThemeLayoutProps>
  Home: ComponentType<ViewProps>
  Category: ComponentType<ViewProps & { categoryId?: number; page?: number }>
  Book: ComponentType<ViewProps & { novelId: number }>
  Toc: ComponentType<ViewProps & { novelId: number }>
  Chapter: ComponentType<ViewProps & { chapterId: number }>
  Search: ComponentType<ViewProps & { query: string }>
}
