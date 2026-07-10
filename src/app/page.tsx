'use client';

import { useState, useEffect } from 'react';
import { useSession, signOut } from 'next-auth/react';
import { Plus, BookOpen, Search, Sun, Moon, LogOut } from 'lucide-react';
import { useTheme } from 'next-themes';
import { AnimatePresence, motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/stores/app-store';
import AppSidebar, { MobileSidebar } from '@/components/novel/AppSidebar';
import { DashboardView } from '@/components/novel/DashboardView';
import { NovelListView } from '@/components/novel/NovelListView';
import NovelDetailView from '@/components/novel/NovelDetailView';
import NovelFormDialog from '@/components/novel/NovelFormDialog';
import { ChapterFormDialog } from '@/components/novel/ChapterFormDialog';
import { CategoryManagerView } from '@/components/novel/CategoryManagerView';
import TagManagerView from '@/components/novel/TagManagerView';
import { DownloadManagerView } from '@/components/download/DownloadManagerView';
import { ThemeManagerView } from '@/components/theme/ThemeManagerView';
import { SiteClusterView } from '@/components/site/SiteClusterView';
import ScrapeManagerView from '@/components/scrape/ScrapeRuleEditor';
import CommandPalette from '@/components/novel/CommandPalette';

const VIEW_TITLES: Record<string, { title: string; description: string }> = {
  dashboard: { title: '仪表盘', description: '系统概览与数据统计' },
  novels: { title: '小说管理', description: '管理所有小说作品' },
  'novel-detail': { title: '小说详情', description: '查看小说详情与章节管理' },
  categories: { title: '分类管理', description: '管理小说分类' },
  tags: { title: '标签管理', description: '管理小说标签' },
  scrape: { title: '采集管理', description: '采集规则与任务管理' },
  download: { title: '下载中心', description: '下载配置与搜索引擎关键词' },
  themes: { title: '主题管理', description: '管理站点外观主题与配色' },
  sites: { title: '站群管理', description: '管理多站点集群配置' },
};

// View transition animation variants
const viewVariants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
};

export default function Home() {
  const { data: session, status } = useSession();
  const {
    currentView,
    setEditingNovel,
    setNovelFormOpen,
    setCommandPaletteOpen,
  } = useAppStore();

  const viewInfo = VIEW_TITLES[currentView] || VIEW_TITLES.dashboard;

  const handleCreateNovel = () => {
    setEditingNovel(null);
    setNovelFormOpen(true);
  };

  // ─── Time display ──────────────────────────────────────────────────────
  const [time, setTime] = useState('');
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

  // ─── Dark mode toggle ─────────────────────────────────────────────────
  const { theme, setTheme } = useTheme();
  const toggleTheme = () => setTheme(theme === 'dark' ? 'light' : 'dark');

  // ─── Auth loading state ───────────────────────────────────────────────
  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <BookOpen className="h-8 w-8 text-primary animate-pulse" />
          <p className="text-sm text-muted-foreground">加载中...</p>
        </div>
      </div>
    );
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
      default: return <DashboardView />;
    }
  };

  return (
    <div className="flex min-h-screen">
      {/* Desktop Sidebar */}
      <AppSidebar />

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 bg-background">
        {/* Top Header Bar */}
        <header className="sticky top-0 z-30 flex items-center justify-between border-b bg-background/80 backdrop-blur-md px-4 sm:px-6 h-14">
          <div className="flex items-center gap-3">
            {/* Mobile menu */}
            <MobileSidebar />

            {/* Search trigger */}
            <Button
              variant="outline"
              size="sm"
              className="hidden sm:flex gap-2 text-muted-foreground hover:text-foreground"
              onClick={() => setCommandPaletteOpen(true)}
            >
              <Search className="h-3.5 w-3.5" />
              搜索...
              <kbd className="pointer-events-none ml-2 inline-flex h-5 select-none items-center gap-0.5 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
                ⌘K
              </kbd>
            </Button>

            {/* Page title */}
            <div className="flex flex-col">
              <h2 className="text-sm font-semibold leading-none">{viewInfo.title}</h2>
              <p className="text-[11px] text-muted-foreground mt-0.5 hidden sm:block">
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

            {/* Time display */}
            <span className="hidden sm:inline text-xs text-muted-foreground font-mono tabular-nums">
              {time}
            </span>

            {/* Dark mode toggle */}
            <Button variant="ghost" size="icon" onClick={toggleTheme} aria-label="切换主题" className="relative">
              <Sun className="h-4 w-4 scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
              <Moon className="absolute h-4 w-4 scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
            </Button>

            {/* Logout button */}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => signOut({ callbackUrl: '/login' })}
              aria-label="退出登录"
              title="退出登录"
              className="text-muted-foreground hover:text-destructive"
            >
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </header>

        {/* Content Area with transition */}
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

        {/* Footer */}
        <footer className="mt-auto border-t bg-background px-4 py-3 text-center text-xs text-muted-foreground">
          小说管理系统 v1.0.0 · 基于 Next.js 16 构建
          {session?.user?.name && (
            <span className="ml-2">· 当前用户: {session.user.name}</span>
          )}
        </footer>
      </main>

      {/* Dialogs */}
      <NovelFormDialog />
      <ChapterFormDialog />
      <CommandPalette />
    </div>
  );
}