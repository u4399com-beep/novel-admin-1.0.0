'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { motion, AnimatePresence } from 'framer-motion';
import {
  BookOpen, Search, Sun, Moon, Shield,
  ChevronLeft, ChevronRight, Sparkles, TrendingUp,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

// ─── Types ───────────────────────────────────────────────────────────

interface Category {
  id: string;
  name: string;
  description: string | null;
  color: string;
  _count: { novels: number };
}

interface Novel {
  id: string;
  title: string;
  author: string;
  description: string | null;
  coverUrl: string | null;
  coverPath: string | null;
  status: string;
  wordCount: number;
  category: { id: string; name: string; color: string } | null;
  _count: { chapters: number };
  createdAt: string;
  updatedAt: string;
}

const STATUS_MAP: Record<string, { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }> = {
  ongoing: { label: '连载中', variant: 'default' },
  completed: { label: '已完结', variant: 'secondary' },
  hiatus: { label: '暂停中', variant: 'outline' },
};

function formatWordCount(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万字`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}千字`;
  return `${n}字`;
}

// ─── Cover placeholder gradient colors ────────────────────────────────
const COVER_GRADIENTS = [
  'from-rose-500/80 to-orange-500/80',
  'from-emerald-500/80 to-teal-500/80',
  'from-violet-500/80 to-purple-500/80',
  'from-amber-500/80 to-yellow-500/80',
  'from-cyan-500/80 to-sky-500/80',
  'from-fuchsia-500/80 to-pink-500/80',
  'from-lime-500/80 to-green-500/80',
  'from-red-500/80 to-rose-500/80',
];

function getGradient(title: string): string {
  let hash = 0;
  for (let i = 0; i < title.length; i++) hash = title.charCodeAt(i) + ((hash << 5) - hash);
  return COVER_GRADIENTS[Math.abs(hash) % COVER_GRADIENTS.length];
}

// ─── Skeleton Grid ───────────────────────────────────────────────────

function NovelCardSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="aspect-[3/4] w-full rounded-xl" />
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 sm:gap-6">
      {Array.from({ length: 10 }).map((_, i) => (
        <NovelCardSkeleton key={i} />
      ))}
    </div>
  );
}

// ─── Novel Card ──────────────────────────────────────────────────────

function NovelCard({ novel, index }: { novel: Novel; index: number }) {
  const statusInfo = STATUS_MAP[novel.status] || STATUS_MAP.ongoing;
  const gradient = getGradient(novel.title);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.3, delay: index * 0.04 }}
      className="group cursor-pointer"
    >
      {/* Cover */}
      <div className="relative aspect-[3/4] w-full overflow-hidden rounded-xl shadow-md group-hover:shadow-xl transition-all duration-300 group-hover:-translate-y-1">
        {novel.coverUrl ? (
          <img
            src={novel.coverUrl}
            alt={novel.title}
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
            loading="lazy"
          />
        ) : (
          <div className={`h-full w-full bg-gradient-to-br ${gradient} flex items-center justify-center`}>
            <span className="text-4xl font-bold text-white/90 select-none">
              {novel.title.charAt(0)}
            </span>
          </div>
        )}
        {/* Status badge overlay */}
        <div className="absolute top-2 left-2">
          <Badge variant={statusInfo.variant} className="text-[10px] px-1.5 py-0">
            {statusInfo.label}
          </Badge>
        </div>
        {/* Chapter count overlay */}
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-3 pt-8">
          <p className="text-[11px] text-white/80 flex items-center gap-1">
            <BookOpen className="h-3 w-3" />
            {novel._count.chapters} 章 · {formatWordCount(novel.wordCount)}
          </p>
        </div>
      </div>

      {/* Info */}
      <div className="mt-3 space-y-1.5 px-0.5">
        <h3 className="text-sm font-semibold leading-snug line-clamp-1 group-hover:text-primary transition-colors">
          {novel.title}
        </h3>
        <p className="text-xs text-muted-foreground line-clamp-1">{novel.author}</p>
        {novel.category && (
          <span
            className="inline-block text-[10px] px-1.5 py-0.5 rounded-full"
            style={{
              backgroundColor: `${novel.category.color}18`,
              color: novel.category.color,
            }}
          >
            {novel.category.name}
          </span>
        )}
      </div>
    </motion.div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────

export default function HomePage() {
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  // Data state
  const [novels, setNovels] = useState<Novel[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [totalPages, setTotalPages] = useState(0);
  const [total, setTotal] = useState(0);

  // Filter state
  const [page, setPage] = useState(1);
  const [activeCategory, setActiveCategory] = useState('');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');

  // Loading state
  const [loadingNovels, setLoadingNovels] = useState(true);
  const [loadingCategories, setLoadingCategories] = useState(true);

  // ─── Fetch categories ────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoadingCategories(true);
      try {
        const res = await fetch('/api/public/categories');
        if (!cancelled && res.ok) {
          const data = await res.json();
          setCategories(data);
        }
      } catch { /* ignore */ }
      if (!cancelled) setLoadingCategories(false);
    }
    load();
    return () => { cancelled = true; };
  }, []);

  // ─── Fetch novels ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoadingNovels(true);
      try {
        const params = new URLSearchParams({ page: String(page), pageSize: '15' });
        if (activeCategory) params.set('categoryId', activeCategory);
        if (search) params.set('search', search);
        const res = await fetch(`/api/public/novels?${params}`);
        if (!cancelled && res.ok) {
          const data = await res.json();
          setNovels(data.novels || []);
          setTotalPages(data.totalPages || 0);
          setTotal(data.total || 0);
        }
      } catch { /* ignore */ }
      if (!cancelled) setLoadingNovels(false);
    }
    load();
    return () => { cancelled = true; };
  }, [page, activeCategory, search]);

  // ─── Handlers ────────────────────────────────────────────────────
  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setSearch(searchInput.trim());
    setPage(1);
  };

  const handleCategoryClick = (catId: string) => {
    setActiveCategory(catId === activeCategory ? '' : catId);
    setPage(1);
  };

  // ─── Pagination range ────────────────────────────────────────────
  const getPageNumbers = () => {
    const pages: (number | string)[] = [];
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
    <div className="min-h-screen flex flex-col">
      {/* ─── Header ──────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 border-b bg-background/80 backdrop-blur-lg">
        <div className="max-w-7xl mx-auto flex items-center justify-between h-14 px-4 sm:px-6">
          {/* Logo */}
          <div className="flex items-center gap-2.5">
            <div className="h-8 w-8 rounded-lg bg-primary flex items-center justify-center">
              <BookOpen className="h-4.5 w-4.5 text-primary-foreground" />
            </div>
            <span className="text-lg font-bold tracking-tight">小说阁</span>
          </div>

          {/* Nav links - desktop */}
          <nav className="hidden sm:flex items-center gap-6 text-sm">
            <button
              onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              首页
            </button>
            <button
              onClick={() => document.getElementById('categories-section')?.scrollIntoView({ behavior: 'smooth' })}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              分类
            </button>
            <button
              onClick={() => document.getElementById('novels-section')?.scrollIntoView({ behavior: 'smooth' })}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              排行榜
            </button>
          </nav>

          {/* Right actions */}
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label="切换主题"
              className="h-8 w-8"
              >
                <Sun className="h-4 w-4 scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
                <Moon className="absolute h-4 w-4 scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
              </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.push('/login')}
              className="gap-1.5 text-muted-foreground hover:text-foreground h-8"
            >
              <Shield className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">管理后台</span>
            </Button>
          </div>
        </div>
      </header>

      {/* ─── Hero Section ────────────────────────────────────────── */}
      <section className="relative overflow-hidden border-b">
        {/* Decorative elements */}
        <div className="absolute top-10 -left-20 w-72 h-72 bg-primary/5 rounded-full blur-3xl" />
        <div className="absolute bottom-0 -right-20 w-80 h-80 bg-primary/5 rounded-full blur-3xl" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-gradient-radial from-primary/3 to-transparent rounded-full" />

        <div className="relative max-w-3xl mx-auto text-center px-4 py-16 sm:py-24">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-primary/10 text-primary text-xs font-medium mb-6">
              <Sparkles className="h-3 w-3" />
              海量好书，等你探索
            </div>
            <h1 className="text-3xl sm:text-4xl md:text-5xl font-bold tracking-tight mb-4">
              发现你的{' '}
              <span className="text-primary">下一本好书</span>
            </h1>
            <p className="text-base sm:text-lg text-muted-foreground mb-8 max-w-lg mx-auto">
              沉浸式小说阅读体验，精选优质内容，随时随地畅享阅读
            </p>
          </motion.div>

          {/* Search bar */}
          <motion.form
            onSubmit={handleSearch}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.2 }}
            className="relative max-w-xl mx-auto"
          >
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              type="text"
              placeholder="搜索小说名、作者..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="h-12 pl-11 pr-24 text-base rounded-xl border-border/60 bg-background/60 backdrop-blur-sm"
            />
            <Button
              type="submit"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 h-9 px-4 rounded-lg"
            >
              搜索
            </Button>
          </motion.form>
        </div>
      </section>

      {/* ─── Categories Section ──────────────────────────────────── */}
      <section id="categories-section" className="border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-5">
          <div className="flex items-center gap-3 overflow-x-auto pb-1 scrollbar-none">
            {!loadingCategories ? (
              <>
                <button
                  onClick={() => handleCategoryClick('')}
                  className={`shrink-0 px-4 py-1.5 rounded-full text-sm font-medium transition-all duration-200 ${
                    activeCategory === ''
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground'
                  }`}
                >
                  全部
                </button>
                {categories.map((cat) => (
                  <button
                    key={cat.id}
                    onClick={() => handleCategoryClick(cat.id)}
                    className={`shrink-0 px-4 py-1.5 rounded-full text-sm font-medium transition-all duration-200 ${
                      activeCategory === cat.id
                        ? 'text-white shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                    style={
                      activeCategory === cat.id
                        ? { backgroundColor: cat.color }
                        : { backgroundColor: `${cat.color}15` }
                    }
                  >
                    {cat.name}
                    <span className="ml-1.5 text-xs opacity-70">{cat._count.novels}</span>
                  </button>
                ))}
              </>
            ) : (
              Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="shrink-0 h-8 w-20 rounded-full" />
              ))
            )}
          </div>
        </div>
      </section>

      {/* ─── Novels Section ──────────────────────────────────────── */}
      <section id="novels-section" className="flex-1">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
          {/* Section header */}
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold">
                {search ? `搜索: ${search}` : activeCategory ? categories.find(c => c.id === activeCategory)?.name || '小说' : '全部小说'}
              </h2>
              <span className="text-sm text-muted-foreground">
                共 {total} 本
              </span>
            </div>
          </div>

          {/* Novel grid */}
          {loadingNovels ? (
            <SkeletonGrid />
          ) : novels.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="h-16 w-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
                <BookOpen className="h-8 w-8 text-muted-foreground" />
              </div>
              <h3 className="text-base font-medium mb-1">暂无小说</h3>
              <p className="text-sm text-muted-foreground">试试其他关键词或分类</p>
            </div>
          ) : (
            <AnimatePresence mode="wait">
              <motion.div
                key={`${activeCategory}-${search}-${page}`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 sm:gap-6"
              >
                {novels.map((novel, i) => (
                  <NovelCard key={novel.id} novel={novel} index={i} />
                ))}
              </motion.div>
            </AnimatePresence>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-1.5 mt-10">
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              {getPageNumbers().map((p, i) =>
                typeof p === 'string' ? (
                  <span key={`dots-${i}`} className="px-1 text-muted-foreground">
                    ...
                  </span>
                ) : (
                  <Button
                    key={p}
                    variant={p === page ? 'default' : 'outline'}
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => setPage(p)}
                  >
                    {p}
                  </Button>
                ),
              )}
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      </section>

      {/* ─── Footer ──────────────────────────────────────────────── */}
      <footer className="mt-auto border-t bg-background/80 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
              <BookOpen className="h-4 w-4" />
              <span className="font-medium">小说阁</span>
              <span className="text-muted-foreground/40">·</span>
              <span className="text-xs">沉浸式小说阅读体验</span>
            </div>
            <p className="text-xs text-muted-foreground/60">基于 Next.js 16 构建</p>
          </div>
        </div>
      </footer>
    </div>
  );
}