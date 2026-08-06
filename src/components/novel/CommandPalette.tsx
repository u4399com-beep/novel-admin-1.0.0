'use client';

import { useEffect, useCallback, useState } from 'react';
import { motion } from 'framer-motion';
import { useRouter } from 'next/navigation';
import {
  LayoutDashboard,
  Plus,
  Settings,
  Clock,
  FolderTree,
  Loader2,
} from 'lucide-react';
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from '@/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { NAV_ITEMS } from '@/lib/nav-config';
import { useAppStore } from '@/stores/app-store';
import { apiFetch } from '@/lib/api-fetch';
import type { ViewType, Category } from '@/types';

// ─── Types ────────────────────────────────────────────────────────────────

interface RecentNovelEntry {
  id: string;
  title: string;
  author: string;
  coverUrl: string | null;
  category: { name: string; color: string } | null;
  viewedAt: number;
}

// ─── Constants ─────────────────────────────────────────────────────────────

const RECENT_KEY = 'novel-recently-viewed';
const MAX_RECENT = 5;

function loadRecentFromStorage(): RecentNovelEntry[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (raw) {
      const list: RecentNovelEntry[] = JSON.parse(raw);
      if (Array.isArray(list) && list.length > 0) return list.slice(0, MAX_RECENT);
    }
  } catch { /* ignore */ }
  return [];
}

// ─── Kbd Component ─────────────────────────────────────────────────────────

function Kbd({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd className={`inline-flex h-5 min-w-[20px] items-center justify-center rounded border bg-muted px-1 font-mono text-[10px] font-medium text-muted-foreground ${className}`}>
      {children}
    </kbd>
  );
}

// ─── Main Component ────────────────────────────────────────────────────────

export default function CommandPalette() {
  const open = useAppStore((s) => s.commandPaletteOpen);
  const setOpen = useAppStore((s) => s.setCommandPaletteOpen);
  const router = useRouter();

  const setCurrentView = useAppStore((s) => s.setCurrentView);
  const setNovelFormOpen = useAppStore((s) => s.setNovelFormOpen);
  const setEditingNovel = useAppStore((s) => s.setEditingNovel);

  // ─── Data state ────────────────────────────────────────────────────────
  const [recentNovels, setRecentNovels] = useState<RecentNovelEntry[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loadingCategories, setLoadingCategories] = useState(false);
  const [mounted, setMounted] = useState(false);

  // ─── Keyboard shortcut to open ─────────────────────────────────────────
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Ctrl/Cmd+K → toggle command palette
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      setOpen(!open);
      return;
    }
    // "/" to open (only when not in an input/textarea)
    if (e.key === '/' && !open) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT' && !(e.target as HTMLElement).isContentEditable) {
        e.preventDefault();
        setOpen(true);
      }
    }
  }, [open, setOpen]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // ─── Load data when opened ──────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;

    // Load recent novels from localStorage
    queueMicrotask(() => setRecentNovels(loadRecentFromStorage()));

    // Fetch categories
    queueMicrotask(() => setLoadingCategories(true));
    apiFetch<Category[]>('/api/categories', { silent: true })
      .then((data) => setCategories(Array.isArray(data) ? data : []))
      .catch(() => setCategories([]))
      .finally(() => setLoadingCategories(false));
  }, [open]);

  // Mark as mounted for SSR safety
  useEffect(() => {
    queueMicrotask(() => setMounted(true));
  }, []);

  // ─── Handlers ──────────────────────────────────────────────────────────
  const handleNavSelect = useCallback(
    (view: ViewType) => {
      setCurrentView(view);
      setOpen(false);
    },
    [setCurrentView, setOpen],
  );

  const handleNewNovel = useCallback(() => {
    setEditingNovel(null);
    setNovelFormOpen(true);
    setOpen(false);
  }, [setEditingNovel, setNovelFormOpen, setOpen]);

  const handleViewDashboard = useCallback(() => {
    setCurrentView('dashboard');
    setOpen(false);
  }, [setCurrentView, setOpen]);

  const handleGoToStats = useCallback(() => {
    router.push('/stats');
    setOpen(false);
  }, [router, setOpen]);

  const handleRecentNovelSelect = useCallback(
    (novelId: string) => {
      router.push(`/novels/${novelId}`);
      setOpen(false);
    },
    [router, setOpen],
  );

  const handleCategorySelect = useCallback(
    (categoryId: string) => {
      setCurrentView('novels');
      setOpen(false);
      // Navigate to categories page filtered by this category
      router.push(`/categories`);
    },
    [setCurrentView, router, setOpen],
  );

  // Don't render until mounted (SSR safety)
  if (!mounted) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="overflow-hidden p-0 gap-0 max-w-lg glass-card"
        showCloseButton={false}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>命令面板</DialogTitle>
          <DialogDescription>快速导航至各功能页面</DialogDescription>
        </DialogHeader>

        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.15, ease: [0.23, 1, 0.32, 1] as const }}
        >
          <Command className="[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group]]:px-2 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-2.5 [&_[cmdk-item]_svg]:h-4 [&_[cmdk-item]_svg]:w-4">
            <CommandInput placeholder="搜索页面、小说或操作..." />

            <CommandList className="max-h-[380px]">
              <CommandEmpty>未找到匹配结果</CommandEmpty>

              {/* ── Recent Novels ─────────────────────────────────────────── */}
              {recentNovels.length > 0 && (
                <>
                  <CommandGroup heading="最近浏览">
                    {recentNovels.map((novel) => (
                      <CommandItem
                        key={`recent-${novel.id}`}
                        onSelect={() => handleRecentNovelSelect(novel.id)}
                        value={`recent-${novel.title}`}
                        className="gap-3"
                      >
                        <Clock className="size-4 text-muted-foreground shrink-0" />
                        <span className="truncate flex-1">{novel.title}</span>
                        {novel.category && (
                          <span
                            className="text-[10px] px-1.5 py-px rounded-sm shrink-0"
                            style={{
                              color: novel.category.color,
                              backgroundColor: `${novel.category.color}15`,
                            }}
                          >
                            {novel.category.name}
                          </span>
                        )}
                        <span className="text-[10px] text-muted-foreground/50 shrink-0">
                          {novel.author}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                  <CommandSeparator />
                </>
              )}

              {/* ── Quick Actions ─────────────────────────────────────────── */}
              <CommandGroup heading="快捷操作">
                <CommandItem onSelect={handleNewNovel}>
                  <Plus className="size-4 text-muted-foreground" />
                  <span>新建小说</span>
                </CommandItem>
                <CommandItem onSelect={handleViewDashboard}>
                  <LayoutDashboard className="size-4 text-muted-foreground" />
                  <span>查看仪表盘</span>
                </CommandItem>
                <CommandItem onSelect={handleGoToStats}>
                  <Settings className="size-4 text-muted-foreground" />
                  <span>数据统计</span>
                  <span className="ml-auto text-xs text-muted-foreground/50">/stats</span>
                </CommandItem>
              </CommandGroup>

              <CommandSeparator />

              {/* ── Category Quick Links ───────────────────────────────────── */}
              {loadingCategories ? (
                <CommandGroup heading="分类">
                  <div className="flex items-center justify-center py-3">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  </div>
                </CommandGroup>
              ) : categories.length > 0 ? (
                <>
                  <CommandGroup heading="分类浏览">
                    {categories.slice(0, 6).map((cat) => (
                      <CommandItem
                        key={`cat-${cat.id}`}
                        onSelect={() => handleCategorySelect(cat.id)}
                        value={`category-${cat.name}`}
                        className="gap-3"
                      >
                        <FolderTree className="size-4 shrink-0" style={{ color: cat.color }} />
                        <span className="flex-1 truncate">{cat.name}</span>
                        {cat._count?.novels !== undefined && (
                          <span className="text-[10px] text-muted-foreground/50 shrink-0">
                            {cat._count.novels} 本
                          </span>
                        )}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                  <CommandSeparator />
                </>
              ) : null}

              {/* ── Page Navigation ───────────────────────────────────────── */}
              <CommandGroup heading="页面导航">
                {NAV_ITEMS.map((item) => (
                  <CommandItem
                    key={item.key}
                    onSelect={() => handleNavSelect(item.key)}
                    value={item.label}
                  >
                    <item.icon className="size-4 text-muted-foreground" />
                    <span>{item.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>

            {/* ── Footer ──────────────────────────────────────────────────── */}
            <div className="border-t px-4 py-2.5 flex items-center justify-between">
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Kbd>ESC</Kbd>
                  <span>关闭</span>
                </span>
                <span className="flex items-center gap-1">
                  <Kbd>↑↓</Kbd>
                  <span>导航</span>
                </span>
                <span className="flex items-center gap-1">
                  <Kbd>↵</Kbd>
                  <span>选择</span>
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground/60">
                <Kbd className="text-[9px]">/</Kbd>
                <span>快速打开</span>
              </div>
            </div>
          </Command>
        </motion.div>
      </DialogContent>
    </Dialog>
  );
}
