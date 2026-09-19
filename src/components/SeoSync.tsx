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

/** JSON-LD 节点 id 固定复用（防视图切换重复堆积）；data=null 时移除（非 home/book 视图不携带结构化数据） */
function setJsonLd(data: Record<string, unknown> | null) {
  let el = document.head.querySelector<HTMLScriptElement>('script#ld-json')
  if (!data) {
    el?.remove()
    return
  }
  if (!el) {
    el = document.createElement('script')
    el.id = 'ld-json'
    el.type = 'application/ld+json'
    document.head.appendChild(el)
  }
  // textContent 写入本身安全（不解析 HTML）；替换 </ 为 <\/ 双保险防闭合标签逃逸
  el.textContent = JSON.stringify(data).replace(/<\//g, '<\\/')
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
    let ld: Record<string, unknown> | null = null

    switch (view.name) {
      case 'home': {
        const vars = { siteName }
        meta = {
          title: renderTpl(seo.homeTitle, vars),
          description: renderTpl(seo.homeDescription, vars),
          keywords: renderTpl(seo.homeKeywords, vars),
        }
        // WebSite + SearchAction：站点无独立搜索路由（SPA 内部跳转），
        // target 写相对路径 /?query={search_term_string} 供搜索引擎识别站内搜索入口
        ld = {
          '@context': 'https://schema.org',
          '@type': 'WebSite',
          name: siteName,
          url: `${window.location.origin}/`,
          potentialAction: {
            '@type': 'SearchAction',
            target: {
              '@type': 'EntryPoint',
              urlTemplate: '/?query={search_term_string}',
            },
            'query-input': 'required name=search_term_string',
          },
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
        // Book schema（genre=分类名；空简介/分类的字段由 undefined 序列化时自动剔除）
        ld = {
          '@context': 'https://schema.org',
          '@type': 'Book',
          name: novel.title,
          author: { '@type': 'Person', name: novel.author },
          description: novel.description || undefined,
          genre: novel.categoryName || undefined,
          inLanguage: 'zh-CN',
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
        const query = view.query?.trim() ?? ''
        if (!query) {
          // 空关键词的搜索落地页：退回首页 TDK，避免生成 “”的搜索结果 这类畸形标题
          meta = {
            title: renderTpl(seo.homeTitle, { siteName }),
            description: renderTpl(seo.homeDescription, { siteName }),
            keywords: renderTpl(seo.homeKeywords, { siteName }),
          }
        } else {
          const vars = { siteName, query }
          meta = {
            title: renderTpl(seo.searchTitle, vars),
            description: renderTpl(seo.searchDescription, vars),
            keywords: `${query},${siteName}`,
          }
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
      // 特殊字符（< > " 等）由 DOM API（document.title / setAttribute）天然安全写入，无需手工转义；
      // 超长截断：标题 120 / 描述 300 / 关键词 200，防止超长书名/模板把 TDK 撑爆搜索引擎上限
      document.title = truncate(meta.title, 120)
      setMetaTag('name', 'description', truncate(meta.description, 300))
      setMetaTag('name', 'keywords', truncate(meta.keywords, 200))
      setMetaTag('property', 'og:title', truncate(meta.title, 120))
      setMetaTag('property', 'og:description', truncate(meta.description, 300))
      setMetaTag('property', 'og:site_name', siteName)
      setMetaTag('property', 'og:type', 'website')
    }
    // JSON-LD 随视图切换更新/移除（章节/分类/目录/搜索/PSEO 视图无 Book/WebSite 上下文收益，置空移除）
    setJsonLd(ld)
  }, [view, settings, categories, novel, chapter, chapterNovel, pseo])

  return null
}
