'use client';

import { useState, useEffect, useMemo } from 'react';
import { apiFetch, FetchError } from '@/lib/api-fetch';
import { NovelGrid } from '@/components/home/NovelGrid';
import type { NovelCardData } from '@/components/home/shared-types';
import type { LayoutTheme } from '@/lib/use-layout-theme';

type Novel = NovelCardData;

interface NovelGridLoaderProps {
  layoutTheme: LayoutTheme;
  activeCategorySlug: string;
  activeStatus: string;
  activeWordCount: string;
  activeSort: string;
  debouncedSearch: string;
  page: number;
  refreshKey: number;
  search: string;
  hasActiveFilter: boolean;
  filterSummary: string;
  onPageChange: (page: number) => void;
  onRetry: () => void;
  onLoginClick: () => void;
}

export function NovelGridLoader({
  layoutTheme,
  activeCategorySlug,
  activeStatus,
  activeWordCount,
  activeSort,
  debouncedSearch,
  page,
  refreshKey,
  search,
  hasActiveFilter,
  filterSummary,
  onPageChange,
  onRetry,
  onLoginClick,
}: NovelGridLoaderProps) {
  const [novels, setNovels] = useState<Novel[]>([]);
  const [totalPages, setTotalPages] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(false);
      try {
        const params = new URLSearchParams({ page: String(page), pageSize: '15' });
        if (activeCategorySlug) params.set('categorySlug', activeCategorySlug);
        if (activeStatus) params.set('status', activeStatus);
        if (activeWordCount && activeWordCount !== 'all') params.set('wordCount', activeWordCount);
        if (activeSort) params.set('sort', activeSort);
        if (debouncedSearch) params.set('search', debouncedSearch);
        const data = await apiFetch<{ novels?: Novel[]; totalPages?: number; total?: number }>(
          `/api/public/novels?${params}`,
          { silent: true }
        );
        if (!cancelled) {
          setNovels(data.novels || []);
          setTotalPages(data.totalPages || 0);
          setTotal(data.total || 0);
        }
      } catch (err) {
        if (!cancelled && !(err instanceof FetchError && err.status === 0)) {
          setError(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [page, activeCategorySlug, activeStatus, activeWordCount, activeSort, debouncedSearch, refreshKey]);

  const animKey = useMemo(() =>
    `${activeCategorySlug}-${activeStatus}-${activeWordCount}-${activeSort}-${search}-${page}-${layoutTheme}`,
    [activeCategorySlug, activeStatus, activeWordCount, activeSort, search, page, layoutTheme]
  );

  return (
    <NovelGrid
      novels={novels}
      loading={loading}
      novelsError={error}
      page={page}
      totalPages={totalPages}
      total={total}
      hasActiveFilter={hasActiveFilter}
      filterSummary={filterSummary}
      layoutTheme={layoutTheme}
      animKey={animKey}
      search={search}
      onPageChange={onPageChange}
      onRetry={onRetry}
      onLoginClick={onLoginClick}
    />
  );
}
