'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Search,
  BookOpen,
  User,
  ChevronLeft,
  ChevronRight,
  FileText,
  BookMarked,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { safeFormatDate } from '@/lib/format';

import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAppStore } from '@/stores/app-store';
import { NOVEL_STATUS_MAP } from '@/lib/constants';
import type { Novel, Category, NovelStatus } from '@/types';

// ─── Gradient palette for cover placeholders ──────────────────────────────────
const gradients = [
  'from-rose-100 to-orange-100 dark:from-rose-900/30 dark:to-orange-900/30',
  'from-emerald-100 to-teal-100 dark:from-emerald-900/30 dark:to-teal-900/30',
  'from-violet-100 to-purple-100 dark:from-violet-900/30 dark:to-purple-900/30',
  'from-amber-100 to-yellow-100 dark:from-amber-900/30 dark:to-yellow-900/30',
  'from-sky-100 to-cyan-100 dark:from-sky-900/30 dark:to-cyan-900/30',
  'from-pink-100 to-fuchsia-100 dark:from-pink-900/30 dark:to-fuchsia-900/30',
];

interface PaginatedResponse {
  novels: Novel[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// ─── Component ────────────────────────────────────────────────────────────────
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

  const refreshNovels = useAppStore((s) => s.refreshVersions['novels'] ?? 0);
  const selectNovel = useAppStore((s) => s.selectNovel);
  const setCurrentView = useAppStore((s) => s.setCurrentView);

  const pageSize = 12;

  // Fetch categories for filter
  useEffect(() => {
    fetch('/api/categories')
      .then((r) => { if (!r.ok) throw new Error(r.statusText || '获取分类列表失败'); return r.json(); })
      .then((data: Category[]) => setCategories(data))
      .catch((err) => {
        console.error('获取分类列表失败:', err);
      });
  }, []);

  // Fetch novels
  const fetchNovels = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
      });
      if (search) params.set('search', search);
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (categoryFilter !== 'all') params.set('categoryId', categoryFilter);

      const res = await fetch(`/api/novels?${params}`);
      if (!res.ok) throw new Error('获取小说列表失败');
      const data: PaginatedResponse = await res.json();
      setNovels(data.novels);
      setTotal(data.total);
      setTotalPages(data.totalPages);
    } catch (err) {
      setNovels([]);
      setError(err instanceof Error ? err.message : '获取小说列表失败');
    } finally {
      setLoading(false);
    }
  }, [page, search, statusFilter, categoryFilter]);

  useEffect(() => {
    fetchNovels();
  }, [fetchNovels, refreshNovels]);

  // Search debounce
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Reset page when filters change
  useEffect(() => {
    setPage(1);
  }, [statusFilter, categoryFilter]);

  const handleViewNovel = (novel: Novel) => {
    selectNovel(novel);
    setCurrentView('novel-detail');
  };

  // ─── Pagination page numbers ─────────────────────────────────────────────
  const getPageNumbers = () => {
    const pages: (number | '...')[] = [];
    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      pages.push(1);
      if (page > 3) pages.push('...');
      const start = Math.max(2, page - 1);
      const end = Math.min(totalPages - 1, page + 1);
      for (let i = start; i <= end; i++) pages.push(i);
      if (page < totalPages - 2) pages.push('...');
      pages.push(totalPages);
    }
    return pages;
  };

  return (
    <div className="space-y-4 p-4 md:p-6">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">小说列表</h2>
          {!loading && (
            <Badge variant="secondary" className="text-xs">
              共 {total.toLocaleString()} 本
            </Badge>
          )}
        </div>

        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="搜索小说标题或作者..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      {/* ── Filters ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-32">
            <SelectValue placeholder="状态筛选" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="ongoing">连载中</SelectItem>
            <SelectItem value="completed">已完结</SelectItem>
            <SelectItem value="hiatus">暂停</SelectItem>
          </SelectContent>
        </Select>

        <Select value={categoryFilter} onValueChange={setCategoryFilter}>
          <SelectTrigger className="w-32">
            <SelectValue placeholder="分类筛选" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部分类</SelectItem>
            {categories.map((cat) => (
              <SelectItem key={cat.id} value={cat.id}>
                {cat.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* ── Loading Skeleton ─────────────────────────────────────────────── */}
      {loading && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Card key={i} className="overflow-hidden">
              <Skeleton className="h-40 w-full" />
              <CardContent className="space-y-3 p-4">
                <Skeleton className="h-5 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
                <div className="flex gap-2">
                  <Skeleton className="h-5 w-14" />
                  <Skeleton className="h-5 w-14" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* ── Empty State ─────────────────────────────────────────────────── */}
      {!loading && novels.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed py-20">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
            <BookOpen className="h-8 w-8 text-muted-foreground" />
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            {search || statusFilter !== 'all' || categoryFilter !== 'all'
              ? '没有找到匹配的小说'
              : '还没有小说，去创建第一本吧'}
          </p>
        </div>
      )}

      {/* ── Novel Grid ──────────────────────────────────────────────────── */}
      {!loading && novels.length > 0 && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {novels.map((novel, idx) => {
              const statusInfo = NOVEL_STATUS_MAP[novel.status as NovelStatus] ?? NOVEL_STATUS_MAP.ongoing;
              const gradient = gradients[idx % gradients.length];
              return (
                <Card
                  key={novel.id}
                  className="group cursor-pointer overflow-hidden transition-shadow hover:shadow-md"
                  onClick={() => handleViewNovel(novel)}
                >
                  {/* Cover */}
                  <div className={`relative h-40 w-full bg-gradient-to-br ${gradient}`}>
                    {novel.coverUrl ? (
                      <img
                        src={novel.coverUrl}
                        alt={novel.title}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center">
                        <BookOpen className="h-12 w-12 text-muted-foreground/40" />
                      </div>
                    )}
                    {/* Status badge on cover */}
                    <Badge
                      variant="secondary"
                      className={`absolute right-2 top-2 ${statusInfo.className}`}
                    >
                      {statusInfo.label}
                    </Badge>
                  </div>

                  <CardContent className="space-y-2.5 p-4">
                    {/* Title */}
                    <h3 className="truncate text-sm font-semibold">{novel.title}</h3>

                    {/* Author */}
                    <p className="flex items-center gap-1 text-xs text-muted-foreground">
                      <User className="h-3 w-3" />
                      {novel.author}
                    </p>

                    {/* Category + Tags */}
                    <div className="flex flex-wrap items-center gap-1.5">
                      {novel.category && (
                        <Badge
                          variant="outline"
                          className="text-xs"
                          style={{
                            borderColor: novel.category.color,
                            color: novel.category.color,
                          }}
                        >
                          {novel.category.name}
                        </Badge>
                      )}
                      {(novel.tags ?? []).slice(0, 3).map(({ tag }) => (
                        <Badge
                          key={tag.id}
                          variant="secondary"
                          className="text-xs"
                          style={{
                            backgroundColor: tag.color + '18',
                            color: tag.color,
                          }}
                        >
                          {tag.name}
                        </Badge>
                      ))}
                    </div>

                    {/* Footer */}
                    <div className="flex items-center justify-between border-t pt-2.5 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <FileText className="h-3 w-3" />
                        {novel._count?.chapters ?? 0} 章
                      </span>
                      <span>
                        {safeFormatDate(novel.updatedAt, (d) => formatDistanceToNow(d, {
                          addSuffix: true,
                          locale: zhCN,
                        }))}
                      </span>
                    </div>

                    {/* View Button */}
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full opacity-0 transition-opacity group-hover:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleViewNovel(novel);
                      }}
                    >
                      <BookMarked className="mr-1.5 h-3.5 w-3.5" />
                      查看
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/* ── Pagination ───────────────────────────────────────────────── */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-1.5 pt-2">
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                disabled={page <= 1}
                aria-label="上一页"
                onClick={() => setPage((p) => p - 1)}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>

              {getPageNumbers().map((p, i) =>
                p === '...' ? (
                  <span key={`dots-${i}`} className="px-1 text-sm text-muted-foreground">
                    ...
                  </span>
                ) : (
                  <Button
                    key={p}
                    variant={page === p ? 'default' : 'outline'}
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => setPage(p)}
                  >
                    {p}
                  </Button>
                )
              )}

              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                disabled={page >= totalPages}
                aria-label="下一页"
                onClick={() => setPage((p) => p + 1)}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}