'use client'

import { useQuery } from '@tanstack/react-query'
import type {
  CategoryDto,
  ChapterDetail,
  ChapterListItem,
  HomeData,
  NovelDetail,
  NovelListItem,
  PseoPageData,
  SettingsDto,
} from '@/lib/types'

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`请求失败(${res.status}): ${url}`)
  return res.json() as Promise<T>
}

export const qk = {
  settings: ['settings'] as const,
  home: ['home'] as const,
  categories: ['categories'] as const,
  novels: (params: Record<string, string | number | undefined>) => ['novels', params] as const,
  novel: (id: number) => ['novel', id] as const,
  chapters: (novelId: number) => ['chapters', novelId] as const,
  chapter: (id: number) => ['chapter', id] as const,
  pseo: (keyword: string) => ['pseo', keyword] as const,
}

export function useSettings() {
  return useQuery({
    queryKey: qk.settings,
    queryFn: () => fetchJson<SettingsDto>('/api/settings'),
    staleTime: 30_000,
  })
}

export function useHomeData() {
  return useQuery({
    queryKey: qk.home,
    queryFn: () => fetchJson<HomeData>('/api/home'),
    staleTime: 60_000,
  })
}

export function useCategories() {
  return useQuery({
    queryKey: qk.categories,
    queryFn: () => fetchJson<CategoryDto[]>('/api/categories'),
    staleTime: 60_000,
  })
}

export interface NovelListParams {
  categoryId?: number
  q?: string
  page?: number
  pageSize?: number
  sort?: 'latest' | 'clicks' | 'words' | 'featured'
  status?: 'serial' | 'finished'
  /** false 时不发请求（例如依赖异步加载的 categoryId） */
  enabled?: boolean
}

export function useNovels(params: NovelListParams) {
  const sp = new URLSearchParams()
  if (params.categoryId != null) sp.set('categoryId', String(params.categoryId))
  if (params.q) sp.set('q', params.q)
  if (params.page) sp.set('page', String(params.page))
  if (params.pageSize) sp.set('pageSize', String(params.pageSize))
  if (params.sort) sp.set('sort', params.sort)
  if (params.status) sp.set('status', params.status)
  return useQuery({
    queryKey: qk.novels(params as Record<string, string | number | undefined>),
    queryFn: () =>
      fetchJson<{ list: NovelListItem[]; total: number; page: number; pageSize: number; totalPages: number }>(
        `/api/novels?${sp.toString()}`
      ),
    staleTime: 30_000,
    enabled: params.enabled ?? true,
  })
}

export function useNovel(id: number | null | undefined) {
  return useQuery({
    queryKey: qk.novel(id ?? 0),
    queryFn: () => fetchJson<NovelDetail>(`/api/novels/${id}`),
    enabled: id != null && id > 0,
  })
}

export function useChapters(novelId: number | null | undefined) {
  return useQuery({
    queryKey: qk.chapters(novelId ?? 0),
    queryFn: () => fetchJson<ChapterListItem[]>(`/api/novels/${novelId}/chapters`),
    enabled: novelId != null && novelId > 0,
    staleTime: 5 * 60_000,
  })
}

export function useChapter(id: number | null | undefined) {
  return useQuery({
    queryKey: qk.chapter(id ?? 0),
    queryFn: () => fetchJson<ChapterDetail>(`/api/chapters/${id}`),
    enabled: id != null && id > 0,
    staleTime: 5 * 60_000,
  })
}

export function usePseo(keyword: string | null | undefined) {
  return useQuery({
    queryKey: qk.pseo(keyword ?? ''),
    queryFn: () => fetchJson<PseoPageData>(`/api/pseo/${encodeURIComponent(keyword ?? '')}`),
    enabled: !!keyword,
    staleTime: 60_000,
    retry: false,
  })
}
