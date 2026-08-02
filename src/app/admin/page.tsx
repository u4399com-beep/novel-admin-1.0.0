'use client';

import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import type { ViewType } from '@/types';
import { useState, useEffect, useSyncExternalStore, useCallback } from 'react';
import { useSession, signOut } from 'next-auth/react';
import { Plus, BookOpen, Search, Sun, Moon, LogOut, Shield, User, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useTheme } from 'next-themes';
import { AnimatePresence, motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip';
import { useAppStore } from '@/stores/app-store';
import { NAV_ITEMS } from '@/lib/nav-config';
import { AdminViewSkeletons } from '@/components/admin/AdminViewSkeletons';
import { MobileSidebar } from '@/components/novel/AppSidebar';
import { DashboardView } from '@/components/novel/DashboardView';
import NovelFormDialog from '@/components/novel/NovelFormDialog';
import { ChapterFormDialog } from '@/components/novel/ChapterFormDialog';
import CommandPalette from '@/components/novel/CommandPalette';
import KeyboardShortcutsDialog from '@/components/KeyboardShortcutsDialog';

// View key mapping: Cmd/Ctrl+1 → NAV_ITEMS[0], Cmd/Ctrl+2 → NAV_ITEMS[1], etc.
const VIEW_KEY_MAP: Record<string, string> = {};
NAV_ITEMS.forEach((item, idx) => {
  VIEW_KEY_MAP[String(idx + 1)] = item.key;
});

const NovelListView = dynamic(() => import('@/components/novel/NovelListView'), {
  ssr: false,
  loading: () => <AdminViewSkeletons view="novels" />,
});
const NovelDetailView = dynamic(() => import('@/components/novel/NovelDetailView'), {
  ssr: false,
  loading: () => <AdminViewSkeletons view="novels" />,
});
const CategoryManagerView = dynamic(() => import('@/components/novel/CategoryManagerView'), {
  ssr: false,
  loading: () => <AdminViewSkeletons view="categories" />,
});
const TagManagerView = dynamic(() => import('@/components/novel/TagManagerView'), {
  ssr: false,
  loading: () => <AdminViewSkeletons view="tags" />,
});
const ScrapeManagerView = dynamic(() => import('@/components/scrape/ScrapeRuleEditor'), {
  ssr: false,
  loading: () => <AdminViewSkeletons view="scrape" />,
});
const DownloadManagerView = dynamic(() => import('@/components/download/DownloadManagerView'), {
  ssr: false,
  loading: () => <AdminViewSkeletons view="scrape" />,
});
const ThemeManagerView = dynamic(() => import('@/components/theme/ThemeManagerView'), {
  ssr: false,
  loading: () => <AdminViewSkeletons view="themes" />,
});
const SiteClusterView = dynamic(() => import('@/components/site/SiteClusterView'), {
  ssr: false,
  loading: () => <AdminViewSkeletons view="sites" />,
});
const SettingsPage = dynamic(() => import('@/app/admin/settings/page'), {
  ssr: false,
  loading: () => <AdminViewSkeletons view="settings" />,
});

const VIEW_TITLES: Record<string, { title: string; description: string }> = {
  dashboard: { title: '仪表盘', description: '系统概览与数据统计' },
  novels: { title: '小说管理', description: '管理所有小说作品' },
  'novel-detail': { title: '小说详情', description: '查看小说详情与章节管理' },
  categories: { title: '分类管理', description: '管理小说分类' },
  tags: { title: '标签管理', description: '管理小说标签' },
  themes: { title: '主题管理', description: '管理站点外观主题与配色' },
  sites: { title: '站点集群', description: '管理多站点集群配置' },
  scrape: { title: '采集规则', description: '管理采集规则配置' },
  download: { title: '采集任务', description: '管理采集任务和下载' },
  settings: { title: '系统设置', description: '配置系统参数和偏好' },
};

// View transition animation variants
const viewVariants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
};

// ─── Keyboard shortcut keys ─────────────────────────────────────────────────
const SHORTCUT_KEYS = ['⌘1', '⌘2', '⌘3', '⌘4', '⌘5', '⌘6', '⌘7', '⌘8'] as const;

export default function AdminPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const currentView = useAppStore((s) => s.currentView);
  const setCurrentView = useAppStore((s) => s.setCurrentView);
  const setEditingNovel = useAppStore((s) => s.setEditingNovel);
  const setNovelFormOpen = useAppStore((s) => s.setNovelFormOpen);
  const setCommandPaletteOpen = useAppStore((s) => s.setCommandPaletteOpen);

  const viewInfo = VIEW_TITLES[currentView] || VIEW_TITLES.dashboard;

  const handleCreateNovel = () => {
    setEditingNovel(null);
    setNovelFormOpen(true);
  };

  // ─── Sidebar collapse state ──────────────────────────────────────────────
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const toggleSidebar = useCallback(() => setSidebarCollapsed((prev) => !prev), []);

  // ─── Search state ───────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('');

  // ─── Time display ──────────────────────────────────────────────────────
  const [time, setTime] = useState('');
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const isMac = useSyncExternalStore(
    () => () => {},
    () => navigator.platform?.includes('Mac') ?? false,
    () => false,
  );
  useEffect(() => {
    const update = () => {
      const now = new Date();
      setTime(
        `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      );
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

      // Cmd/Ctrl + 1-8: switch nav view
      if ((e.metaKey || e.ctrlKey) && !isInputFocused) {
        const viewKey = VIEW_KEY_MAP[e.key];
        if (viewKey) {
          e.preventDefault();
          setCurrentView(viewKey as ViewType);
          return;
        }
      }

      // ? key: toggle shortcuts dialog
      if (e.key === '?' && !isInputFocused) {
        e.preventDefault();
        setShortcutsOpen(prev => !prev);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [setCurrentView]);

  // ─── Dark mode toggle ─────────────────────────────────────────────────
  const { theme, setTheme } = useTheme();
  const toggleTheme = () => setTheme(theme === 'dark' ? 'light' : 'dark');

  // ─── Auth loading state ───────────────────────────────────────────────
  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Shield className="h-8 w-8 text-primary animate-pulse" />
          <p className="text-sm text-muted-foreground">加载管理后台...</p>
        </div>
      </div>
    );
  }

  // ─── Auth guard ──────────────────────────────────────────────────────
  if (!session) {
    router.push('/login');
    return null;
  }

  // ─── View renderer ────────────────────────────────────────────────────
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
      case 'settings': return <SettingsPage />;
      default: return <DashboardView />;
    }
  };

  // ─── Sidebar nav items ─────────────────────────────────────────────────
  const sidebarNavItems = (
    <nav className="flex-1 px-3 py-2 space-y-1 overflow-y-auto">
      {NAV_ITEMS.map((item, index) => {
        const isActive = currentView === item.key || (item.key === 'novels' && currentView === 'novel-detail');
        const Icon = item.icon;

        // Insert divider after 4th item (index 3)
        const showDivider = index === 3;

        const navButton = (
          <button
            key={item.key}
            onClick={() => setCurrentView(item.key)}
            className={`
              group relative flex w-full items-center gap-3 rounded-lg px-3 py-2.5
              text-sm font-medium transition-all duration-200
              ${
                isActive
                  ? 'bg-white/10 text-white'
                  : 'text-slate-400 hover:bg-accent/50 hover:text-slate-200'
              }
              ${sidebarCollapsed ? 'justify-center px-0' : ''}
            `}
          >
            {/* Active indicator bar */}
            {isActive && (
              <motion.div
                layoutId="sidebar-active"
                className="absolute left-0 top-1/2 -translate-y-1/2 h-6 w-1 rounded-r-full bg-violet-400"
                transition={{ type: 'spring', stiffness: 350, damping: 30 }}
              />
            )}

            <Icon
              className={`h-4.5 w-4.5 shrink-0 transition-colors ${
                isActive ? 'text-violet-300' : 'text-slate-500 group-hover:text-slate-400'
              }`}
            />

            {!sidebarCollapsed && (
              <span className="flex-1 text-left">{item.label}</span>
            )}

            {/* Keyboard shortcut hint — desktop only, visible on hover */}
            {!sidebarCollapsed && (
              <span className="hidden lg:inline-block text-[10px] font-mono text-slate-600 opacity-0 group-hover:opacity-100 transition-opacity duration-200 shrink-0">
                {SHORTCUT_KEYS[index]}
              </span>
            )}

            {/* Active hover glow */}
            {isActive && (
              <div className="absolute inset-0 rounded-lg bg-gradient-to-r from-violet-500/10 to-transparent pointer-events-none transition-opacity group-hover:from-violet-500/20 group-hover:via-violet-500/5" />
            )}
          </button>
        );

        if (sidebarCollapsed) {
          // In collapsed mode, wrap with tooltip
          return (
            <div key={item.key}>
              {showDivider && (
                <div className="py-2">
                  <Separator className="bg-slate-700/50" />
                </div>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  {navButton}
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8} className="bg-slate-800 text-slate-200 border-slate-700">
                  <p className="text-xs font-medium">{item.label}</p>
                  <p className="text-[10px] text-slate-400 mt-0.5">{item.description}</p>
                </TooltipContent>
              </Tooltip>
            </div>
          );
        }

        return (
          <div key={item.key}>
            {showDivider && (
              <div className="py-2 px-3">
                <Separator className="bg-slate-700/50" />
              </div>
            )}
            {navButton}
          </div>
        );
      })}
    </nav>
  );

  const userName = session?.user?.name || '管理员';
  const userInitial = userName.charAt(0).toUpperCase();

  return (
    <div className="flex min-h-screen">
      {/* ─── Desktop Sidebar ──────────────────────────────────────────────── */}
      <aside
        className={`hidden lg:flex h-screen flex-col border-r border-slate-800 bg-slate-900 shrink-0 sticky top-0 transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] ${
          sidebarCollapsed ? 'w-16' : 'w-64'
        }`}
      >
        {/* Sidebar Header — app brand */}
        <div
          className={`relative overflow-hidden py-6 pb-5 text-left w-full ${sidebarCollapsed ? 'px-3' : 'px-6'}`}
        >
          <div className="absolute inset-0 bg-gradient-to-br from-violet-600/20 via-purple-600/10 to-transparent transition-opacity hover:opacity-80" />
          <div className="relative flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 shadow-lg shadow-violet-500/25 transition-shadow hover:shadow-violet-500/40 shrink-0">
              <BookOpen className="h-5 w-5 text-white" />
            </div>
            {!sidebarCollapsed && (
              <div className="overflow-hidden">
                <h1 className="text-lg font-bold text-white tracking-tight">小说阁</h1>
                <p className="text-[11px] text-slate-400 tracking-wide">NOVEL MANAGEMENT</p>
              </div>
            )}
          </div>
        </div>

        {/* Navigation Items */}
        {sidebarNavItems}

        {/* Sidebar Footer — collapse toggle */}
        <div className="border-t border-slate-700/50 px-3 py-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={toggleSidebar}
                className={`w-full text-slate-400 hover:text-slate-200 hover:bg-white/5 ${sidebarCollapsed ? 'justify-center px-0' : 'justify-start gap-2'}`}
              >
                {sidebarCollapsed ? (
                  <PanelLeftOpen className="h-4 w-4" />
                ) : (
                  <>
                    <PanelLeftClose className="h-4 w-4" />
                    <span className="text-xs">收起菜单</span>
                  </>
                )}
              </Button>
            </TooltipTrigger>
            {sidebarCollapsed && (
              <TooltipContent side="right" sideOffset={8} className="bg-slate-800 text-slate-200 border-slate-700">
                <p className="text-xs">展开菜单</p>
              </TooltipContent>
            )}
          </Tooltip>
        </div>
      </aside>

      {/* ─── Main Content ────────────────────────────────────────────────── */}
      <main className="flex-1 flex flex-col min-w-0 bg-background">
        {/* ─── Top Header Bar ───────────────────────────────────────────── */}
        <header className="sticky top-0 z-30 flex items-center justify-between border-b bg-background/80 backdrop-blur-md px-4 sm:px-6 h-14">
          <div className="flex items-center gap-3">
            {/* Mobile menu */}
            <MobileSidebar />

            {/* Search input */}
            <div className="relative hidden sm:block">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                type="text"
                placeholder="搜索..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-8 w-48 lg:w-56 pl-8 text-sm bg-muted/50 border-transparent focus:border-border focus:bg-background"
                onFocus={() => setCommandPaletteOpen(true)}
                readOnly
              />
              <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-4 select-none items-center rounded border bg-muted px-1 font-mono text-[9px] font-medium text-muted-foreground">
                {isMac ? '⌘K' : '^K'}
              </kbd>
            </div>

            {/* Page title */}
            <div className="flex flex-col">
              <h2 className="text-sm font-semibold leading-none">{viewInfo.title}</h2>
              <p className="text-[11px] text-muted-foreground mt-0.5 hidden md:block">
                {viewInfo.description}
              </p>
            </div>
          </div>

          {/* Right side: actions + utilities */}
          <div className="flex items-center gap-1.5 sm:gap-2">
            {currentView === 'novels' && (
              <Button onClick={handleCreateNovel} size="sm" className="gap-1.5">
                <Plus className="h-4 w-4" />
                <span className="hidden sm:inline">新建小说</span>
              </Button>
            )}

            {currentView === 'dashboard' && (
              <Button onClick={handleCreateNovel} size="sm" variant="outline" className="gap-1.5">
                <BookOpen className="h-4 w-4" />
                <span className="hidden sm:inline">快速创建</span>
              </Button>
            )}

            {/* Shortcuts hint */}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              onClick={() => setShortcutsOpen(prev => !prev)}
              aria-label="键盘快捷键"
              title="键盘快捷键"
            >
              <span className="text-sm font-medium">?</span>
            </Button>

            {/* Time display */}
            <span className="hidden lg:inline text-xs text-muted-foreground font-mono tabular-nums">
              {time}
            </span>

            {/* Dark mode toggle */}
            <Button variant="ghost" size="icon" onClick={toggleTheme} aria-label="切换主题" className="relative">
              <Sun className="h-4 w-4 scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
              <Moon className="absolute h-4 w-4 scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
            </Button>

            {/* User avatar dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  className="h-8 w-8 rounded-full p-0 relative"
                  aria-label="用户菜单"
                >
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                    {userInitial}
                  </div>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuLabel className="font-normal">
                  <div className="flex flex-col gap-1">
                    <p className="text-sm font-medium">{userName}</p>
                    <p className="text-xs text-muted-foreground">管理员</p>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => signOut({ callbackUrl: '/login' })}
                  className="text-destructive focus:text-destructive cursor-pointer"
                >
                  <LogOut className="h-4 w-4" />
                  退出登录
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {/* ─── Content Area with transition ──────────────────────────────── */}
        <div className="flex-1 relative">
          <AnimatePresence mode="wait">
            <motion.div
              key={currentView}
              variants={viewVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
              className="absolute inset-0"
            >
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
              <div className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-[10px] font-medium text-primary">
                {userInitial}
              </div>
              <span>{userName}</span>
            </div>
          </div>
        </footer>
      </main>

      {/* Dialogs */}
      <NovelFormDialog />
      <ChapterFormDialog />
      <CommandPalette />
      <KeyboardShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  );
}