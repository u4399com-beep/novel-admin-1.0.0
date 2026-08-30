'use client';

import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import type { ViewType } from '@/types';
import { useState, useEffect, useSyncExternalStore, useCallback } from 'react';
import { useSession, signOut } from 'next-auth/react';
import { Upload, BookOpen, Search, Sun, Moon, LogOut, Plus } from 'lucide-react';
import { useTheme } from 'next-themes';
import { AnimatePresence, motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAppStore } from '@/stores/app-store';
import { NAV_ITEMS } from '@/lib/nav-config';
import { apiFetch } from '@/lib/api-fetch';
import { AdminViewSkeletons } from '@/components/admin/AdminViewSkeletons';
import { AdminDesktopSidebar } from '@/components/admin/AdminDesktopSidebar';
import { NovelImportDialog } from '@/components/novel/NovelImportDialog';
import { MobileSidebar } from '@/components/novel/AppSidebar';
import { DashboardView } from '@/components/novel/DashboardView';
import NovelFormDialog from '@/components/novel/NovelFormDialog';
import { ChapterFormDialog } from '@/components/novel/ChapterFormDialog';
import CommandPalette from '@/components/novel/CommandPalette';
import KeyboardShortcutsDialog from '@/components/KeyboardShortcutsDialog';

// View key mapping
const VIEW_KEY_MAP: Record<string, string> = {};
NAV_ITEMS.forEach((item, idx) => {
  VIEW_KEY_MAP[String(idx + 1)] = item.key;
});

const NovelListView = dynamic(() => import('@/components/novel/NovelListView'), { ssr: false, loading: () => <AdminViewSkeletons view="novels" /> });
const NovelDetailView = dynamic(() => import('@/components/novel/NovelDetailView'), { ssr: false, loading: () => <AdminViewSkeletons view="novels" /> });
const CategoryManagerView = dynamic(() => import('@/components/novel/CategoryManagerView'), { ssr: false, loading: () => <AdminViewSkeletons view="categories" /> });
const TagManagerView = dynamic(() => import('@/components/novel/TagManagerView'), { ssr: false, loading: () => <AdminViewSkeletons view="tags" /> });
const ScrapeManagerView = dynamic(() => import('@/components/scrape/ScrapeRuleEditor'), { ssr: false, loading: () => <AdminViewSkeletons view="scrape" /> });
const DownloadManagerView = dynamic(() => import('@/components/download/DownloadManagerView'), { ssr: false, loading: () => <AdminViewSkeletons view="scrape" /> });
const ThemeManagerView = dynamic(() => import('@/components/theme/ThemeManagerView'), { ssr: false, loading: () => <AdminViewSkeletons view="themes" /> });
const SiteClusterView = dynamic(() => import('@/components/site/SiteClusterView'), { ssr: false, loading: () => <AdminViewSkeletons view="sites" /> });
const FriendlyLinksView = dynamic(() => import('@/components/admin/FriendlyLinksManager'), { ssr: false, loading: () => <AdminViewSkeletons view="sites" /> });
const SettingsPage = dynamic(() => import('@/app/admin/settings/page'), { ssr: false, loading: () => <AdminViewSkeletons view="settings" /> });

const VIEW_TITLES: Record<string, { title: string; description: string }> = {
  dashboard: { title: '仪表盘', description: '系统概览与数据统计' },
  novels: { title: '小说管理', description: '管理所有小说作品' },
  'novel-detail': { title: '小说详情', description: '查看小说详情与章节管理' },
  categories: { title: '分类管理', description: '管理小说分类' },
  tags: { title: '标签管理', description: '管理小说标签' },
  themes: { title: '主题管理', description: '管理站点外观主题与配色' },
  sites: { title: '站点集群', description: '管理多站点集群配置' },
  'friendly-links': { title: '友情链接', description: '管理友情链接和站群链轮' },
  scrape: { title: '采集规则', description: '管理采集规则配置' },
  download: { title: '采集任务', description: '管理采集任务和下载' },
  settings: { title: '系统设置', description: '配置系统参数和偏好' },
};

const viewVariants = { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -8 } };
const noopSubscribe = () => () => {};

export default function AdminPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const currentView = useAppStore((s) => s.currentView);
  const setCurrentView = useAppStore((s) => s.setCurrentView);
  const setEditingNovel = useAppStore((s) => s.setEditingNovel);
  const setNovelFormOpen = useAppStore((s) => s.setNovelFormOpen);
  const setCommandPaletteOpen = useAppStore((s) => s.setCommandPaletteOpen);

  const viewInfo = VIEW_TITLES[currentView] || VIEW_TITLES.dashboard;

  // ─── Sidebar collapse state ──────────────────────────────────────────────
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const toggleSidebar = useCallback(() => setSidebarCollapsed((prev) => !prev), []);

  // ─── Time display ──────────────────────────────────────────────────────
  const [time, setTime] = useState('');
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [categories, setCategories] = useState<Array<{ id: string; name: string; color: string }>>([]);

  const handleCreateNovel = useCallback(() => {
    setEditingNovel(null);
    setNovelFormOpen(true);
  }, [setEditingNovel, setNovelFormOpen]);

  const handleImportOpen = useCallback(async () => {
    try {
      const data = await apiFetch<Array<{ id: string; name: string; color: string }>>('/api/categories');
      setCategories(data);
    } catch { /* handled */ }
    setImportOpen(true);
  }, [setCategories, setImportOpen]);
  const isMac = useSyncExternalStore(
    noopSubscribe,
    () => navigator.platform?.includes('Mac') ?? false,
    () => false,
  );
  useEffect(() => {
    const update = () => {
      const now = new Date();
      setTime(`${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`);
    };
    update();
    const id = setInterval(update, 60_000);
    return () => clearInterval(id);
  }, []);

  // ─── Keyboard shortcuts listener ──────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const isInputFocused = tag && ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag);
      if ((e.metaKey || e.ctrlKey) && !isInputFocused) {
        const viewKey = VIEW_KEY_MAP[e.key];
        if (viewKey) { e.preventDefault(); setCurrentView(viewKey as ViewType); return; }
      }
      if (e.key === '?' && !isInputFocused) { e.preventDefault(); setShortcutsOpen(prev => !prev); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [setCurrentView]);

  // ─── Dark mode toggle ─────────────────────────────────────────────────
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const toggleTheme = useCallback(() => setTheme(theme === 'dark' ? 'light' : 'dark'), [theme, setTheme]);

  // ─── Auth guard ──────────────────────────────────────────────
  useEffect(() => {
    if (status !== 'loading' && !session) { router.push('/login'); }
  }, [session, status, router]);

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 text-primary animate-pulse flex items-center justify-center">
            <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/></svg>
          </div>
          <p className="text-sm text-muted-foreground">加载管理后台...</p>
        </div>
      </div>
    );
  }

  const renderView = () => {
    switch (currentView) {
      case 'dashboard': return <DashboardView />;
      case 'novels': return <NovelListView />;
      case 'novel-detail': return <NovelDetailView />;
      case 'categories': return <CategoryManagerView />;
      case 'tags': return <TagManagerView />;
      case 'scrape': return <ScrapeManagerView />;
      case 'download': return <DownloadManagerView />;
      case 'themes': return <ThemeManagerView />;
      case 'sites': return <SiteClusterView />;
      case 'friendly-links': return <FriendlyLinksView />;
      case 'settings': return <SettingsPage />;
      default: return <DashboardView />;
    }
  };

  const userName = session?.user?.name || '管理员';
  const userInitial = userName.charAt(0).toUpperCase();

  return (
    <div className="flex min-h-screen">
      {/* ─── Desktop Sidebar ──────────────────────────────────────────────── */}
      <AdminDesktopSidebar
        collapsed={sidebarCollapsed}
        currentView={currentView}
        isMac={isMac}
        onToggleCollapse={toggleSidebar}
        onViewChange={setCurrentView}
      />

      {/* ─── Main Content ────────────────────────────────────────────────── */}
      <main className="flex-1 flex flex-col min-w-0 bg-background">
        {/* ─── Top Header Bar ───────────────────────────────────────────── */}
        <header className="sticky top-0 z-30 flex items-center justify-between border-b bg-background/80 backdrop-blur-md px-4 sm:px-6 h-14">
          <div className="flex items-center gap-3">
            <MobileSidebar />
            <div className="relative hidden sm:block">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input type="text" placeholder="搜索..." aria-label="搜索小说" className="h-8 w-48 lg:w-56 pl-8 text-sm bg-muted/50 border-transparent focus:border-border focus:bg-background" onFocus={() => setCommandPaletteOpen(true)} readOnly />
              <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-4 select-none items-center rounded border bg-muted px-1 font-mono text-[9px] font-medium text-muted-foreground">
                {isMac ? '⌘K' : '^K'}
              </kbd>
            </div>
            <Button variant="ghost" size="icon" className="sm:hidden h-8 w-8" onClick={() => setCommandPaletteOpen(true)} aria-label="搜索">
              <Search className="h-4 w-4" />
            </Button>
            <div className="flex flex-col">
              <h2 className="text-sm font-semibold leading-none">{viewInfo.title}</h2>
              <p className="text-[11px] text-muted-foreground mt-0.5 hidden md:block">{viewInfo.description}</p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2">
            {currentView === 'novels' && (
              <>
                <Button onClick={handleCreateNovel} size="sm" className="gap-1.5"><Plus className="h-4 w-4" /><span className="hidden sm:inline">新建小说</span></Button>
                <Button onClick={handleImportOpen} size="sm" variant="outline" className="gap-1.5"><Upload className="h-4 w-4" /><span className="hidden sm:inline">导入</span></Button>
              </>
            )}
            {currentView === 'dashboard' && (
              <Button onClick={handleCreateNovel} size="sm" variant="outline" className="gap-1.5"><BookOpen className="h-4 w-4" /><span className="hidden sm:inline">快速创建</span></Button>
            )}
            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={() => setShortcutsOpen(prev => !prev)} aria-label="键盘快捷键" title="键盘快捷键">
              <span className="text-sm font-medium">?</span>
            </Button>
            <span className="hidden lg:inline text-xs text-muted-foreground font-mono tabular-nums">{time}</span>
            <Button variant="ghost" size="icon" onClick={toggleTheme} aria-label="切换主题" className="relative" disabled={!mounted} tabIndex={mounted ? 0 : -1} aria-disabled={!mounted}>
              <Sun className="h-4 w-4 scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
              <Moon className="absolute h-4 w-4 scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="h-8 w-8 rounded-full p-0 relative" aria-label="用户菜单">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{userInitial}</div>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuLabel className="font-normal">
                  <div className="flex flex-col gap-1"><p className="text-sm font-medium">{userName}</p><p className="text-xs text-muted-foreground">管理员</p></div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => signOut({ callbackUrl: '/login' })} className="text-destructive focus:text-destructive cursor-pointer"><LogOut className="h-4 w-4" />退出登录</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {/* ─── Content Area with transition ──────────────────────────────── */}
        <div className="flex-1 relative min-h-0">
          <AnimatePresence mode="wait">
            <motion.div key={currentView} variants={viewVariants} initial="initial" animate="animate" exit="exit" transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] as const }} className="h-full">
              {renderView()}
            </motion.div>
          </AnimatePresence>
        </div>

        {/* ─── Footer ────────────────────────────────────────────────────── */}
        <footer className="mt-auto border-t border-border/50 bg-background/80 backdrop-blur-sm px-4 sm:px-6 py-3">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-muted-foreground/70">
            <div className="flex flex-col sm:flex-row items-center gap-0.5 sm:gap-1.5">
              <span className="font-medium text-muted-foreground">小说阁</span>
              <span className="hidden sm:inline text-muted-foreground/40">·</span>
              <span className="hidden sm:inline">管理后台</span>
              <span className="sm:hidden text-muted-foreground/40">v1.0.0</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-[10px] font-medium text-primary">{userInitial}</div>
              <span>{userName}</span>
            </div>
          </div>
        </footer>
      </main>

      {/* Dialogs */}
      <NovelFormDialog />
      <NovelImportDialog open={importOpen} onOpenChange={setImportOpen} categories={categories} onImportSuccess={() => {
        const store = useAppStore.getState();
        store.triggerRefresh('novels');
        store.triggerRefresh('dashboard');
      }} />
      <ChapterFormDialog />
      <CommandPalette />
      <KeyboardShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  );
}