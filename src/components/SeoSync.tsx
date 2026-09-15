'use client'

import { useEffect } from 'react'
import { useAppStore } from '@/lib/store'
import { useChapter, useNovel, usePseo, useSettings, useCategories } from '@/hooks/use-novel-data'
import { autoKeywordsFromText, renderTpl, statusText, truncate, DEFAULT_SEO } from '@/lib/seo'
import type { SeoConfig } from '@/lib/types'

interface Meta {
  title: string
  description: string
  keywords: string
}

function setMetaTag(attr: 'name' | 'property', key: string, content: string) {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`)
  if (!el) {
    el = document.createElement('meta')
    el.setAttribute(attr, key)
    document.head.appendChild(el)
  }
  el.setAttribute('content', content)
}

/**
 * 自动 SEO/TDK：根据当前视图 + 数据 + SEO 模板配置，
 * 自动写入 document.title 与 description/keywords/OG meta。
 * 主题组件无需关心 SEO。
 */
export function SeoSync() {
  const view = useAppStore((s) => s.view)
  const { data: settings } = useSettings()
  const { data: categories } = useCategories()

  const novelId =
    view.name === 'book' || view.name === 'toc' ? view.novelId : view.name === 'chapter' ? null : null
  const { data: novel } = useNovel(view.name === 'chapter' ? null : novelId)
  const { data: chapter } = useChapter(view.name === 'chapter' ? view.chapterId : null)
  // 章节页还需要书信息（拿作者）
  const { data: chapterNovel } = useNovel(chapter?.novelId ?? null)
  const { data: pseo } = usePseo(view.name === 'pseo' ? view.keyword : null)

  useEffect(() => {
    if (!settings) return
    const seo: SeoConfig = settings.seo ?? DEFAULT_SEO
    const siteName = settings.siteName
    let meta: Meta | null = null

    switch (view.name) {
      case 'home': {
        const vars = { siteName }
        meta = {
          title: renderTpl(seo.homeTitle, vars),
          description: renderTpl(seo.homeDescription, vars),
          keywords: renderTpl(seo.homeKeywords, vars),
        }
        break
      }
      case 'category': {
        const cat = categories?.find((c) => c.id === view.categoryId)
        const categoryName = cat?.name ?? '全部小说'
        const page = view.page ?? 1
        const vars = { siteName, categoryName, page }
        meta = {
          title: renderTpl(seo.categoryTitle, vars),
          description: renderTpl(seo.categoryDescription, vars),
          keywords: `${categoryName}小说,${categoryName}排行榜,${siteName}`,
        }
        break
      }
      case 'book': {
        if (!novel) break
        const vars = {
          siteName,
          novelTitle: novel.title,
          author: novel.author,
          categoryName: novel.categoryName,
          statusText: statusText(novel.status),
          descShort: truncate(novel.description, 60),
        }
        meta = {
          title: renderTpl(seo.bookTitle, vars),
          description: renderTpl(seo.bookDescription, vars),
          keywords: renderTpl(seo.bookKeywords, vars),
        }
        break
      }
      case 'toc': {
        if (!novel) break
        const vars = { siteName, novelTitle: novel.title, author: novel.author }
        meta = {
          title: renderTpl(seo.tocTitle, vars),
          description: renderTpl(seo.tocDescription, vars),
          keywords: `${novel.title},目录,章节列表,${novel.author}`,
        }
        break
      }
      case 'chapter': {
        if (!chapter || !chapterNovel) break
        const auto = seo.autoFromContent ? autoKeywordsFromText(chapter.content, 4) : []
        const vars = {
          siteName,
          novelTitle: chapter.novelTitle,
          chapterTitle: chapter.title,
          idx: chapter.idx,
          author: chapterNovel.author,
        }
        meta = {
          title: renderTpl(seo.chapterTitle, vars),
          description: renderTpl(seo.chapterDescription, vars),
          keywords: [...renderTpl(seo.chapterKeywords, vars).split(','), ...auto].filter(Boolean).join(','),
        }
        break
      }
      case 'search': {
        const vars = { siteName, query: view.query }
        meta = {
          title: renderTpl(seo.searchTitle, vars),
          description: renderTpl(seo.searchDescription, vars),
          keywords: `${view.query},${siteName}`,
        }
        break
      }
      case 'pseo': {
        const data = pseo
        if (data) {
          meta = {
            title: data.generatedTitle,
            description: data.generatedDescription,
            keywords: data.generatedKeywords,
          }
        }
        break
      }
    }

    if (meta) {
      document.title = meta.title
      setMetaTag('name', 'description', meta.description)
      setMetaTag('name', 'keywords', meta.keywords)
      setMetaTag('property', 'og:title', meta.title)
      setMetaTag('property', 'og:description', meta.description)
      setMetaTag('property', 'og:site_name', siteName)
      setMetaTag('property', 'og:type', 'website')
    }
  }, [view, settings, categories, novel, chapter, chapterNovel, pseo])

  return null
}
