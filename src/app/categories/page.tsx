'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import {
  Search,
  ChevronRight,
  Home,
  BookOpen,
  Swords,
  Heart,
  Star,
  Ghost,
  Zap,
  Crown,
  Rocket,
  Globe,
  Sparkles,
  Palette,
  Flame,
  Compass,
  Mountain,
  Trophy,
  Music,
  Shield,
  TreePine,
  CloudSun,
  Skull,
  Scroll,
  Landmark,
  BookMarked,
  PenLine,
} from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { BackToTop } from '@/components/BackToTop';
import { apiFetch, FetchError } from '@/lib/api-fetch';
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';

// ─── Types ─────────────────────────────────────────────────────────────
interface Category {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  color: string;
  icon: string | null;
  sortOrder: number;
  _count: { novels: number };
}

// ─── Icon mapping ───────────────────────────────────────────────────────
const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  BookOpen,
  Swords,
  Heart,
  Star,
  Ghost,
  Zap,
  Crown,
  Rocket,
  Globe,
  Sparkles,
  Palette,
  Flame,
  Compass,
  Mountain,
  Trophy,
  Music,
  Shield,
  TreePine,
  CloudSun,
  Skull,
  Scroll,
  Landmark,
  BookMarked,
  PenLine,
};

function getCategoryIcon(iconName: string | null): React.ComponentType<{ className?: string }> {
  if (iconName && ICON_MAP[iconName]) return ICON_MAP[iconName];
  return BookOpen;
}

// ─── Animation variants ─────────────────────────────────────────────────
const containerVariants = {
  hidden: {},
  show: {
    transition: {
      staggerChildren: 0.06,
    },
  },
};

const cardVariants = {
  hidden: { opacity: 0, y: 20 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.35, ease: 'easeOut' as const },
  },
};

// ─── Skeleton Card ──────────────────────────────────────────────────────
function SkeletonCard() {
  return (
    <Card className="overflow-hidden card-glass">
      <CardContent className="p-5">
        <div className="flex flex-col items-center text-center">
          <Skeleton className="mb-3 h-12 w-12 rounded-xl" />
          <Skeleton className="mb-2 h-5 w-20" />
          <Skeleton className="mb-3 h-5 w-16 rounded-full" />
          <Skeleton className="mb-1 h-3 w-full" />
          <Skeleton className="h-3 w-3/4" />
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Component ──────────────────────────────────────────────────────────
export default function CategoriesPage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');


  // ── Fetch categories ──────────────────────────────────────────────────
  const doFetch = useCallback(async (signal?: AbortSignal) => {
    try {
      setLoading(true);
      setError(null);
      const data = await apiFetch<Category[]>('/api/public/categories', { signal });
      if (signal?.aborted) return;
      setCategories(data);
    } catch (err) {
      if (signal?.aborted) return;
      if (!(err instanceof FetchError && err.status === 0)) {
        setError(err instanceof Error ? err.message : '未知错误');
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    doFetch(ac.signal);
    return () => ac.abort();
  }, [doFetch]);

  // ── Filter categories by search ──────────────────────────────────────
  const filteredCategories = useMemo(() => {
    if (!searchQuery.trim()) return categories;
    const q = searchQuery.trim().toLowerCase();
    return categories.filter((c) => c.name.toLowerCase().includes(q));
  }, [categories, searchQuery]);

  const maxNovels = Math.max(1, ...categories.map((c) => c._count.novels));


  return (
    <div className="min-h-screen bg-background fade-in-up">
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
        {/* ── Breadcrumb ──────────────────────────────────────────────── */}
        <nav aria-label="breadcrumb" className="mb-6">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink asChild>
                  <Link href="/" className="flex items-center gap-1">
                    <Home className="h-3.5 w-3.5" />
                    首页
                  </Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>分类浏览</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </nav>

        {/* ── Page Header ────────────────────────────────────────────── */}
        <motion.div
          className="mb-8"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
        >
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 shadow-lg shadow-emerald-500/25">
              <Compass className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
                分类浏览
              </h1>
              <p className="text-sm text-muted-foreground">
                探索各类小说分类，找到你感兴趣的故事
              </p>
            </div>
          </div>
        </motion.div>

        {/* ── Search ──────────────────────────────────────────────────── */}
        <div className="mb-6 max-w-full sm:max-w-md">
          <div className="relative group">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground transition-colors group-focus-within:text-primary" />
            <Input
              placeholder="搜索分类..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 bg-card/50 border-border/50 focus-visible:border-primary/50 focus-visible:ring-primary/20 transition-all"
              aria-label="搜索分类"
            />
          </div>
        </div>

        {/* ── Loading State ───────────────────────────────────────────── */}
        {loading && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 stagger-children">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i}>
                <SkeletonCard />
              </div>
            ))}
          </div>
        )}

        {/* ── Error State ─────────────────────────────────────────────── */}
        {!loading && error && (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-destructive/30 bg-destructive/5 py-20">
            <div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-destructive/10 mb-4">
              <Flame className="h-7 w-7 text-destructive" />
            </div>
            <p className="text-sm font-medium text-destructive">{error}</p>
            <button
              className="mt-3 text-sm text-muted-foreground hover:text-foreground underline-offset-4 hover:underline transition-colors"
              onClick={() => doFetch()}
            >
              点击重试
            </button>
          </div>
        )}

        {/* ── Empty State (no categories at all) ─────────────────────── */}
        {!loading && !error && categories.length === 0 && (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed bg-muted/30 py-20">
            <div className="flex items-center justify-center w-16 h-16 rounded-2xl bg-muted/50 mb-4">
              <BookOpen className="h-8 w-8 text-muted-foreground/60" />
            </div>
            <p className="font-medium text-muted-foreground">暂无分类</p>
            <p className="mt-1.5 text-sm text-muted-foreground/70">
              管理员尚未添加任何分类
            </p>
          </div>
        )}

        {/* ── Empty State (search no match) ──────────────────────────── */}
        {!loading && !error && categories.length > 0 && filteredCategories.length === 0 && (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed bg-muted/30 py-20">
            <div className="flex items-center justify-center w-16 h-16 rounded-2xl bg-muted/50 mb-4">
              <Search className="h-8 w-8 text-muted-foreground/60" />
            </div>
            <p className="font-medium text-muted-foreground">
              未找到匹配「{searchQuery}」的分类
            </p>
            <button
              className="mt-3 text-sm text-muted-foreground hover:text-foreground underline-offset-4 hover:underline transition-colors"
              onClick={() => setSearchQuery('')}
            >
              清除搜索
            </button>
          </div>
        )}

        {/* ── Category Grid ──────────────────────────────────────────── */}
        {!loading && !error && filteredCategories.length > 0 && (
          <motion.div
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 stagger-children"
            variants={containerVariants}
            initial="hidden"
            animate="show"
            key={searchQuery}
          >
            {filteredCategories.map((category) => {
              const Icon = getCategoryIcon(category.icon);
              return (
                <motion.div key={category.id} variants={cardVariants}>
                  <Link
                    href={`/?categorySlug=${category.slug}`}
                    className="block"
                  >
                    <Card
                      className="group overflow-hidden tap-feedback hover-scale card-glass card-hover-glow"
                      style={{ borderLeftWidth: '4px', borderLeftColor: category.color }}
                    >
                      {/* Hover color wash */}
                      <div
                        className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none rounded-xl"
                        style={{ backgroundColor: `${category.color}08` }}
                      />
                      <CardContent className="p-5 relative">
                        <div className="flex flex-col items-center text-center">
                          {/* Icon */}
                          <div
                            className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl transition-all duration-200 group-hover:scale-110"
                            style={{
                              backgroundColor: `${category.color}15`,
                            }}
                          >
                            <Icon
                              className="h-6 w-6 transition-all duration-200 group-hover:scale-110"
                            />
                          </div>

                          {/* Name */}
                          <h3 className="mb-2 text-sm font-bold group-hover:text-primary transition-colors">{category.name}</h3>

                          {/* Novel count badge */}
                          {category._count.novels > 0 && (
                            <span
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium badge-glow mb-3"
                              style={{
                                backgroundColor: `${category.color}15`,
                                color: category.color,
                                '--glow-hue': '150',
                              } as React.CSSProperties}
                            >
                              <BookOpen className="h-3 w-3" />
                              {category._count.novels} 本小说
                            </span>
                          )}

                          {/* Novel count with bar (shown when no novels) */}
                          {category._count.novels === 0 && (
                            <div className="flex items-center gap-2 mb-3">
                              <div className="h-1 flex-1 max-w-[60px] rounded-full bg-muted overflow-hidden">
                                <div
                                  className="h-full rounded-full progress-smooth"
                                  style={{
                                    width: '0%',
                                    backgroundColor: category.color,
                                  }}
                                />
                              </div>
                              <span className="text-xs text-muted-foreground">0</span>
                            </div>
                          )}

                          {/* Description */}
                          {category.description && (
                            <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                              {category.description}
                            </p>
                          )}

                          {/* Navigate hint */}
                          <ChevronRight className="mt-2 h-4 w-4 text-muted-foreground/0 group-hover:text-muted-foreground transition-all duration-200 group-hover:translate-x-0.5" />
                        </div>
                      </CardContent>
                    </Card>
                  </Link>
                </motion.div>
              );
            })}
          </motion.div>
        )}

        {/* ── Footer hint ─────────────────────────────────────────────── */}
        {!loading && !error && filteredCategories.length > 0 && (
          <div className="mt-8 text-center text-sm text-muted-foreground">
            共 {filteredCategories.length} 个分类
            {searchQuery && (
              <span>
                {' '}
                · 搜索「
                <span className="font-medium text-foreground">{searchQuery}</span>
                {'」的结果'}
              </span>
            )}
          </div>
        )}
      </div>
      <BackToTop />
    </div>
  );
}
