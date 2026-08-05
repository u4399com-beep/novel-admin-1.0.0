'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api-fetch';
import { useAppStore } from '@/stores/app-store';

import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

import { NovelFilters, NovelCards, NovelListPagination, NovelListLoadingSkeleton, NovelListEmptyState, NovelBatchActions } from './list';
import type { Novel, Category } from '@/types';

interface PaginatedResponse {
  novels: Novel[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export default function NovelListView() {
  const [novels, setNovels] = useState<Novel[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [categories, setCategories] = useState<Category[]>([]);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const triggerRefresh = useAppStore((s) => s.triggerRefresh);
  const refreshNovels = useAppStore((s) => s.refreshVersions['novels'] ?? 0);
  const selectNovel = useAppStore((s) => s.selectNovel);
  const setCurrentView = useAppStore((s) => s.setCurrentView);

  const pageSize = 12;

  // Fetch categories
  useEffect(() => {
    const controller = new AbortController();
    apiFetch<Category[]>('/api/categories', { signal: controller.signal }).then(setCategories).catch(() => {});
    return () => { controller.abort(); };
  }, []);

  // Fetch novels
  const fetchNovels = useCallback(async (overridePage?: number, signal?: AbortSignal) => {
    const p = overridePage ?? page;
    try {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams({ page: String(p), pageSize: String(pageSize) });
      if (search) params.set('search', search);
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (categoryFilter !== 'all') params.set('categoryId', categoryFilter);

      const data = await apiFetch<PaginatedResponse>(`/api/novels?${params}`, { signal });
      if (signal?.aborted) return;
      setNovels(data.novels);
      setTotal(data.total);
      setTotalPages(data.totalPages);
    } catch (err) {
      if (signal?.aborted) return;
      setNovels([]);
      setError(err instanceof Error ? err.message : '获取小说列表失败');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [page, search, statusFilter, categoryFilter]);

  // Reset page on filter change
  const statusFilterRef = useRef(statusFilter);
  const categoryFilterRef = useRef(categoryFilter);
  useEffect(() => {
    const filterChanged = statusFilterRef.current !== statusFilter || categoryFilterRef.current !== categoryFilter;
    statusFilterRef.current = statusFilter;
    categoryFilterRef.current = categoryFilter;
    if (filterChanged) setPage(1);
  }, [statusFilter, categoryFilter]);

  // Fetch on changes
  useEffect(() => {
    const ac = new AbortController();
    fetchNovels(page, ac.signal);
    return () => ac.abort();
  }, [page, search, fetchNovels, refreshNovels]);

  // Search debounce
  useEffect(() => {
    const timer = setTimeout(() => { setSearch(searchInput); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Keyboard shortcuts
  const novelsRef = useRef(novels);
  novelsRef.current = novels;
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      const isInput = tag === 'INPUT' || tag === 'TEXTAREA';
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'a' && !isInput && novelsRef.current.length > 0) {
        e.preventDefault();
        setSelectedIds(new Set(novelsRef.current.map((n) => n.id)));
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Clear selection on filter change
  useEffect(() => { setSelectedIds(new Set()); }, [page, search, statusFilter, categoryFilter]);

  const allSelected = novels.length > 0 && selectedIds.size === novels.length;

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(novels.map((n) => n.id)));
  };

  const handleBatchDelete = async () => {
    if (selectedIds.size === 0 || deleting) return;
    setDeleting(true);
    try {
      const ids = Array.from(selectedIds);
      const CHUNK_SIZE = 5;
      let failed = 0;
      for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
        const chunk = ids.slice(i, i + CHUNK_SIZE);
        const results = await Promise.allSettled(chunk.map((id) => apiFetch(`/api/novels/${id}`, { method: 'DELETE' })));
        failed += results.filter((r) => r.status === 'rejected').length;
      }
      if (failed > 0) {
        toast.warning(`批量删除: ${failed}/${ids.length} 项失败`);
      } else {
        toast.success(`已删除 ${ids.length} 本小说`);
      }
      setSelectedIds(new Set());
      setBatchDeleteOpen(false);
      triggerRefresh('novels');
    } catch {
      // error handled silently
    } finally {
      setDeleting(false);
    }
  };

  const handleViewNovel = (novel: Novel) => {
    selectNovel(novel);
    setCurrentView('novel-detail');
  };

  const hasFilter = !!(search || statusFilter !== 'all' || categoryFilter !== 'all');

  return (
    <div className="relative space-y-4 p-4 md:p-6">
      <NovelFilters
        searchInput={searchInput}
        onSearchInputChange={setSearchInput}
        onSearchClear={() => { setSearchInput(''); setSearch(''); }}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        categoryFilter={categoryFilter}
        onCategoryFilterChange={setCategoryFilter}
        categories={categories}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        total={total}
        loading={loading}
        searchInputRef={searchInputRef}
      />

      {error && (
        <Card className="border-destructive/50">
          <CardContent className="flex items-center gap-2 p-4 text-sm text-destructive">
            {error}
            <Button variant="outline" size="sm" className="ml-auto" onClick={() => fetchNovels()}>重试</Button>
          </CardContent>
        </Card>
      )}

      {!loading && novels.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {search ? `搜索结果 (${total})` : `共 ${total} 部小说`}
          <kbd className="ml-2 hidden rounded border bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground sm:inline-block">
            Ctrl+K
          </kbd>
        </p>
      )}

      {loading && <NovelListLoadingSkeleton viewMode={viewMode} />}
      {!loading && novels.length === 0 && <NovelListEmptyState hasFilter={hasFilter} />}

      {!loading && novels.length > 0 && (
        <>
          <NovelCards
            novels={novels}
            viewMode={viewMode}
            selectedIds={selectedIds}
            allSelected={allSelected}
            onToggleSelect={toggleSelect}
            onToggleSelectAll={toggleSelectAll}
            onViewNovel={handleViewNovel}
          />
          {totalPages > 1 && (
            <NovelListPagination page={page} totalPages={totalPages} onPageChange={setPage} />
          )}
        </>
      )}

      <NovelBatchActions
        selectedCount={selectedIds.size}
        deleting={deleting}
        batchDeleteOpen={batchDeleteOpen}
        onBatchDeleteOpen={setBatchDeleteOpen}
        onBatchDelete={handleBatchDelete}
        onClearSelection={() => setSelectedIds(new Set())}
      />
    </div>
  );
}
