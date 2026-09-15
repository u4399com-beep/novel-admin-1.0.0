import type { SeoConfig } from '@/lib/types'

// ==================== SEO 默认 TDK 模板 ====================
// 支持变量：{siteName} {categoryName} {novelTitle} {author} {chapterTitle}
//           {idx} {statusText} {descShort} {query} {keyword} {count} {page}

export const DEFAULT_SEO: SeoConfig = {
  homeTitle: '{siteName} - 免费小说在线阅读_原创小说网站',
  homeDescription:
    '{siteName}是领先的免费原创小说在线阅读网站，提供玄幻、仙侠、都市、历史、科幻等全品类小说，每日更新，畅享极致阅读体验。',
  homeKeywords: '小说,免费小说,在线阅读,{siteName},玄幻小说,都市小说',
  categoryTitle: '{categoryName}小说大全_最新{categoryName}小说排行榜 - {siteName}',
  categoryDescription:
    '{siteName}{categoryName}频道为您提供海量精品{categoryName}小说在线阅读，{categoryName}小说每日更新，尽在{siteName}。',
  bookTitle: '{novelTitle}最新章节列表_{author}小说 - {siteName}',
  bookDescription: '{novelTitle}连载于{siteName}，作者{author}，{statusText}。{descShort}',
  bookKeywords: '{novelTitle},{novelTitle}最新章节,{author},{categoryName}小说',
  tocTitle: '{novelTitle}目录_全部章节列表 - {siteName}',
  tocDescription: '{novelTitle}全部章节目录一览，按顺序阅读《{novelTitle}》最新章节，尽在{siteName}。',
  chapterTitle: '{chapterTitle}_《{novelTitle}》第{idx}章 - {siteName}',
  chapterDescription: '《{novelTitle}》{chapterTitle}在线阅读，作者{author}，精彩章节尽在{siteName}。',
  chapterKeywords: '{novelTitle},{chapterTitle},{author}',
  searchTitle: '“{query}”的搜索结果 - {siteName}',
  searchDescription: '在{siteName}搜索“{query}”找到的相关小说列表。',
  pseoTitle: '{keyword}小说推荐_关于{keyword}的小说 - {siteName}',
  pseoDescription: '{siteName}为您精选与“{keyword}”相关的小说合集，包含 {count} 本热门作品，在线免费阅读。',
  pseoKeywords: '{keyword},{keyword}小说,{keyword}推荐',
  autoFromContent: true,
}

/** 模板变量替换 */
export function renderTpl(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''))
}

/** 自动从正文提取补充关键词（高频 2 字词简化实现，避免引入分词依赖） */
const STOPWORDS = new Set(['的一', '一是', '在有', '和不', '人之', '他的', '她的', '一个', '什么', '自己', '没有', '他们', '我们', '这个', '那个', '已经', '就是', '不是'])

export function autoKeywordsFromText(text: string, max = 6): string[] {
  const freq = new Map<string, number>()
  const clean = text.replace(/[^\u4e00-\u9fa5]+/g, ' ')
  for (const seg of clean.split(/\s+/)) {
    for (let i = 0; i + 2 <= seg.length; i++) {
      const w = seg.slice(i, i + 2)
      freq.set(w, (freq.get(w) ?? 0) + 1)
    }
  }
  return [...freq.entries()]
    .filter(([w, c]) => c >= 3 && !STOPWORDS.has(w))
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([w]) => w)
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

export function statusText(status: string): string {
  return status === 'finished' ? '已完本' : '连载中'
}
