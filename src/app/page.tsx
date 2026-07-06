'use client';

import { Plus, BookOpen } from 'lucide-react';
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

export default function Home() {
  const {
    currentView,
    setEditingNovel,
    setNovelFormOpen,
  } = useAppStore();

  const viewInfo = VIEW_TITLES[currentView] || VIEW_TITLES.dashboard;

  const handleCreateNovel = () => {
    setEditingNovel(null);
    setNovelFormOpen(true);
  };

  return (
    <div className="flex min-h-screen">
      {/* Desktop Sidebar */}
      <AppSidebar />

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Top Header Bar */}
        <header className="sticky top-0 z-30 flex items-center justify-between border-b bg-white/80 backdrop-blur-md px-4 sm:px-6 h-14">
          <div className="flex items-center gap-3">
            {/* Mobile menu */}
            <MobileSidebar />

            {/* Page title */}
            <div className="flex flex-col">
              <h2 className="text-sm font-semibold leading-none">{viewInfo.title}</h2>
              <p className="text-[11px] text-muted-foreground mt-0.5 hidden sm:block">
                {viewInfo.description}
              </p>
            </div>
          </div>

          {/* Actions */}
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
        </header>

        {/* Content Area */}
        <div className="flex-1">
          {currentView === 'dashboard' && <DashboardView />}
          {currentView === 'novels' && <NovelListView />}
          {currentView === 'novel-detail' && <NovelDetailView />}
          {currentView === 'categories' && <CategoryManagerView />}
          {currentView === 'tags' && <TagManagerView />}
          {currentView === 'scrape' && <ScrapeManagerView />}
          {currentView === 'download' && <DownloadManagerView />}
          {currentView === 'themes' && <ThemeManagerView />}
          {currentView === 'sites' && <SiteClusterView />}
        </div>

        {/* Footer */}
        <footer className="border-t bg-white px-4 py-3 text-center text-xs text-muted-foreground">
          小说管理系统 · 基于 Next.js 构建
        </footer>
      </main>

      {/* Dialogs */}
      <NovelFormDialog />
      <ChapterFormDialog />
    </div>
  );
}