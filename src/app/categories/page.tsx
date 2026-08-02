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
} from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { BackToTop } from '@/components/BackToTop';
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
    <Card className="overflow-hidden">
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

  // ── SEO: set document title ──────────────────────────────────────────
  useEffect(() => {
    document.title = '分类浏览 - 小说阁';
  }, []);

  // ── Fetch categories ──────────────────────────────────────────────────
  useEffect(() => {
    const abortController = new AbortController();
    async function load() {
      try {
        setLoading(true);
        setError(null);
        const res = await fetch('/api/public/categories', { signal: abortController.signal });
        if (!res.ok) throw new Error('获取分类失败');
        const data = await res.json();
        setCategories(data);
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          setError(err instanceof Error ? err.message : '未知错误');
        }
      } finally {
        if (!abortController.signal.aborted) setLoading(false);
      }
    }
    load();
    return () => abortController.abort();
  }, []);

  const fetchCategories = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch('/api/public/categories');
      if (!res.ok) throw new Error('获取分类失败');
      const data = await res.json();
      setCategories(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : '未知错误');
    } finally {
      setLoading(false);
    }
  }, []);

  // Note: fetchCategories (without AbortController) is used by the retry button

  // ── Filter categories by search ──────────────────────────────────────
  const filteredCategories = useMemo(() => {
    if (!searchQuery.trim()) return categories;
    const q = searchQuery.trim().toLowerCase();
    return categories.filter((c) => c.name.toLowerCase().includes(q));
  }, [categories, searchQuery]);

  const maxNovels = Math.max(1, ...categories.map((c) => c._count.novels));


  return (
    <div className="min-h-screen bg-background">
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
        <div className="mb-8">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            分类浏览
          </h1>
          <p className="mt-2 text-muted-foreground">
            探索各类小说分类，找到你感兴趣的故事
          </p>
        </div>

        {/* ── Search ──────────────────────────────────────────────────── */}
        <div className="mb-6 max-w-full sm:max-w-md">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="搜索分类..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
        </div>

        {/* ── Loading State ───────────────────────────────────────────── */}
        {loading && (
          <motion.div
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"
            variants={containerVariants}
            initial="hidden"
            animate="show"
          >
            {Array.from({ length: 8 }).map((_, i) => (
              <motion.div
                key={i}
                variants={cardVariants}
                style={{ animationDelay: `${i * 60}ms` }}
              >
                <SkeletonCard />
              </motion.div>
            ))}
          </motion.div>
        )}

        {/* ── Error State ─────────────────────────────────────────────── */}
        {!loading && error && (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed py-20">
            <p className="text-sm text-destructive">{error}</p>
            <button
              className="mt-3 text-sm text-muted-foreground hover:text-foreground"
              onClick={() => fetchCategories()}
            >
              点击重试
            </button>
          </div>
        )}

        {/* ── Empty State (no categories at all) ─────────────────────── */}
        {!loading && !error && categories.length === 0 && (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed py-20">
            <BookOpen className="mb-3 h-12 w-12 text-muted-foreground/50" />
            <p className="text-muted-foreground">暂无分类</p>
            <p className="mt-1 text-sm text-muted-foreground">
              管理员尚未添加任何分类
            </p>
          </div>
        )}

        {/* ── Empty State (search no match) ──────────────────────────── */}
        {!loading && !error && categories.length > 0 && filteredCategories.length === 0 && (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed py-20">
            <Search className="mb-3 h-12 w-12 text-muted-foreground/50" />
            <p className="text-muted-foreground">
              未找到匹配「{searchQuery}」的分类
            </p>
            <button
              className="mt-3 text-sm text-muted-foreground hover:text-foreground"
              onClick={() => setSearchQuery('')}
            >
              清除搜索
            </button>
          </div>
        )}

        {/* ── Category Grid ──────────────────────────────────────────── */}
        {!loading && !error && filteredCategories.length > 0 && (
          <motion.div
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"
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
                      className="group overflow-hidden tap-feedback hover-lift"
                      style={{ borderLeftWidth: '4px', borderLeftColor: category.color }}
                    >
                      {/* Hover color wash */}
                      <div
                        className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"
                        style={{ backgroundColor: `${category.color}08` }}
                      />
                      <CardContent className="p-5 relative">
                        <div className="flex flex-col items-center text-center">
                          {/* Icon */}
                          <div
                            className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl transition-all duration-200"
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

                          {/* Novel count with bar */}
                          <div className="flex items-center gap-2 mb-3">
                            <div className="h-1 flex-1 max-w-[60px] rounded-full bg-muted overflow-hidden">
                              <div
                                className="h-full rounded-full progress-smooth"
                                style={{
                                  width: `${Math.min(100, (category._count.novels / Math.max(1, maxNovels)) * 100)}%`,
                                  backgroundColor: category.color,
                                }}
                              />
                            </div>
                            <span className="text-xs text-muted-foreground">{category._count.novels}</span>
                          </div>

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
