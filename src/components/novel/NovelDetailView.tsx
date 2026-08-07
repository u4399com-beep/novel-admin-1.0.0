'use client';

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { BookX, ChevronLeft } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@/components/ui/resizable';
import { useAppStore } from '@/stores/app-store';
import { apiFetch } from '@/lib/api-fetch';
import type { Novel } from '@/types';

import {
  NovelHeader,
  StatsBar,
  ChapterActions,
  ChapterTable,
  ChapterEditorPanel,
  ChapterReaderDialog,
  SimilarNovels,
} from './detail';
import { useNovelChapters } from '@/hooks/useNovelChapters';

// ─── Main component ───────────────────────────────────────────────────────────
export default function NovelDetailView() {
  const selectedNovelId = useAppStore((s) => s.selectedNovelId);
  const selectNovel = useAppStore((s) => s.selectNovel);
  const setCurrentView = useAppStore((s) => s.setCurrentView);
  const setEditingNovel = useAppStore((s) => s.setEditingNovel);
  const setNovelFormOpen = useAppStore((s) => s.setNovelFormOpen);
  const setChapterFormOpen = useAppStore((s) => s.setChapterFormOpen);
  const setEditingChapter = useAppStore((s) => s.setEditingChapter);
  const triggerRefresh = useAppStore((s) => s.triggerRefresh);
  const refreshNovels = useAppStore((s) => s.refreshVersions['novels'] ?? 0);
  const refreshChapters = useAppStore((s) => s.refreshVersions['chapters'] ?? 0);

  // ── Novel-level state ────────────────────────────────────────────────────
  const [novel, setNovel] = useState<Novel | null>(null);
  const [loadingNovel, setLoadingNovel] = useState(true);
  const [deleteNovelOpen, setDeleteNovelOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);

  // ── Chapter hook (destructured for clean JSX) ────────────────────────────
  const ch = useNovelChapters({
    selectedNovelId,
    onRefresh: triggerRefresh,
    setChapterFormOpen,
    setEditingChapter,
    onUpdateNovel: setNovel,
  });

  // Fetch novel details
  const fetchNovel = useCallback(async (signal?: AbortSignal) => {
    if (!selectedNovelId) return;
    setLoadingNovel(true);
    try {
      const data = await apiFetch<Novel>(`/api/novels/${selectedNovelId}`, { signal });
      if (!signal?.aborted) setNovel(data);
    } catch {
      if (!signal?.aborted) setCurrentView('novels');
    } finally {
      if (!signal?.aborted) setLoadingNovel(false);
    }
  }, [selectedNovelId, setCurrentView]);

  useEffect(() => {
    const ac = new AbortController();
    fetchNovel(ac.signal);
    return () => ac.abort();
  }, [fetchNovel, refreshNovels]);

  useEffect(() => {
    const ac = new AbortController();
    ch.fetchChapters(ac.signal);
    return () => ac.abort();
  }, [ch.fetchChapters, refreshChapters]);

  // ── Memoized chapter callbacks (before early returns to satisfy hook rules) ──
  const handleToggleBatchMode = useCallback(() => { ch.setBatchMode(!ch.batchMode); ch.setCheckedIds(new Set()); }, [ch.batchMode, ch.setBatchMode, ch.setCheckedIds]);
  const handleClearSearch = useCallback(() => ch.setChapterSearch(''), [ch.setChapterSearch]);
  const handleClearFilters = useCallback(() => { ch.setChapterSearch(''); ch.setContentFilter('all'); }, [ch.setChapterSearch, ch.setContentFilter]);

  // ── Novel handlers ───────────────────────────────────────────────────────
  const handleBack = () => { selectNovel(null); setCurrentView('novels'); };
  const handleEditNovel = () => { if (!novel) return; setEditingNovel(novel); setNovelFormOpen(true); };

  const handleExport = async () => {
    if (!novel || exporting) return;
    setExporting(true);
    try {
      const res = await fetch(`/api/novels/${novel.id}/export?format=json`, { credentials: 'include', signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error('导出失败');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${novel.title.replace(/[\\/:*?"<>|]/g, '_')}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success('导出成功');
    } catch {
      toast.error('导出失败，请重试');
    } finally {
      setExporting(false);
    }
  };

  const handleDeleteNovel = async () => {
    if (!novel) return;
    setDeleting(true);
    try {
      await apiFetch(`/api/novels/${novel.id}`, { method: 'DELETE' });
      toast.success('小说已删除');
      triggerRefresh('novels');
      triggerRefresh('dashboard');
      setCurrentView('novels');
      selectNovel(null);
    } catch { /* handled by apiFetch */ } finally {
      setDeleting(false);
      setDeleteNovelOpen(false);
    }
  };

  // ── Loading / empty states ──────────────────────────────────────────────
  if (loadingNovel) {
    return (
      <div className="flex-1 p-6 space-y-6">
        <div className="flex items-center gap-4">
          <Skeleton className="size-9" /> <Skeleton className="h-8 w-48" />
        </div>
        <div className="flex gap-6">
          <Skeleton className="size-40 rounded-lg shrink-0" />
          <div className="flex-1 space-y-3">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-16 w-full" />
          </div>
        </div>
      </div>
    );
  }

  if (!novel) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-3">
          <BookX className="h-12 w-12 text-muted-foreground mx-auto" />
          <p className="text-muted-foreground">小说未找到或加载失败</p>
          <Button variant="outline" onClick={() => setCurrentView('novels')}>返回列表</Button>
        </div>
      </div>
    );
  }

  const totalWords = novel.wordCount ?? ch.chapters.reduce((sum, c) => sum + (c.wordCount ?? 0), 0);
  const chapterCount = novel._count?.chapters ?? ch.chapters.length;

  return (
    <div className="flex-1 flex flex-col overflow-hidden fade-in-up">
      <NovelHeader
        novel={novel} chapterCount={chapterCount} totalWords={totalWords} exporting={exporting}
        onBack={handleBack} onEdit={handleEditNovel} onDelete={() => setDeleteNovelOpen(true)} onExport={handleExport}
      />

      <div className="flex-1 min-h-0 overflow-hidden p-4 sm:p-6 pt-3 sm:pt-4">
        <ResizablePanelGroup direction="horizontal" className={`h-full rounded-lg border ${ch.selectedChapter ? 'hidden lg:flex' : 'flex'}`}>
          <ResizablePanel defaultSize={ch.selectedChapter ? 45 : 100} minSize={30}>
            <div className="flex flex-col h-full">
              <StatsBar contentProgress={ch.contentProgress} totalChapters={ch.chapters.length} />
              <ChapterActions
                chaptersLength={ch.chapters.length} filteredChaptersLength={ch.filteredChapters.length}
                batchMode={ch.batchMode} chapterSearch={ch.chapterSearch} contentFilter={ch.contentFilter}
                checkedIdsCount={ch.checkedIds.size}
                onToggleBatchMode={handleToggleBatchMode}
                onNewChapter={ch.handleNewChapter} onSearchChange={ch.setChapterSearch}
                onClearSearch={handleClearSearch} onContentFilterChange={ch.setContentFilter}
                onBatchDelete={() => ch.setBatchDeleteOpen(true)}
              />
              <ChapterTable
                chapters={ch.chapters} filteredChapters={ch.filteredChapters} loading={ch.loadingChapters}
                chapterSearch={ch.chapterSearch} contentFilter={ch.contentFilter} batchMode={ch.batchMode}
                selectedChapter={ch.selectedChapter} checkedIds={ch.checkedIds}
                isAllChecked={ch.isAllChecked} isSomeChecked={ch.isSomeChecked} sensors={ch.sensors}
                onDragEnd={ch.handleDragEnd} onEdit={ch.handleEditChapter} onDelete={ch.handleDeleteChapterClick}
                onRead={ch.handleReadChapter} onSelect={ch.setSelectedChapter}
                onToggleCheckAll={ch.toggleCheckAll} onToggleCheck={ch.toggleCheck}
                onMoveChapter={ch.handleMoveChapter} reordering={ch.reordering}
                onClearFilters={handleClearFilters}
              />
            </div>
          </ResizablePanel>

          {ch.selectedChapter && (
            <>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize={55} minSize={30}>
                <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/30 shrink-0 lg:hidden">
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => ch.setSelectedChapter(null)} aria-label="返回列表">
                    <ChevronLeft className="size-3.5 mr-1" /> 返回列表
                  </Button>
                  <span className="text-sm font-medium truncate">{ch.selectedChapter.title}</span>
                </div>
                <div className="flex-1 min-h-0">
                  <ChapterEditorPanel
                    key={ch.selectedChapter.id} chapter={ch.selectedChapter}
                    onClose={() => ch.setSelectedChapter(null)} onSaved={ch.handleChapterSaved}
                  />
                </div>
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </div>

      <ChapterReaderDialog
        key={`${ch.readingChapter?.id ?? 'none'}-${ch.readerSession}`}
        open={ch.readerOpen} onOpenChange={ch.setReaderOpen}
        chapter={ch.readingChapter} chapters={ch.chapters} onNavigate={ch.handleReaderNavigate}
      />

      <ConfirmDeleteDialog
        open={deleteNovelOpen} onOpenChange={setDeleteNovelOpen}
        title="确认删除小说" description={`确定要删除「${novel.title}」吗？此操作将同时删除所有关联的章节，且不可撤销。`}
        confirmText="确认删除" loading={deleting} onConfirm={handleDeleteNovel}
      />
      <ConfirmDeleteDialog
        open={ch.deleteChapterOpen} onOpenChange={ch.setDeleteChapterOpen}
        title="确认删除章节" description={`确定要删除「${ch.deletingChapter?.title}」吗？此操作不可撤销。`}
        confirmText="确认删除" loading={ch.chapterDeleting} onConfirm={ch.handleDeleteChapter}
      />
      <ConfirmDeleteDialog
        open={ch.batchDeleteOpen} onOpenChange={ch.setBatchDeleteOpen}
        title="批量删除章节" description={`确定要删除选中的 ${ch.checkedIds.size} 个章节吗？此操作不可撤销。`}
        confirmText={`确认删除 ${ch.checkedIds.size} 项`} loading={ch.batchDeleting} onConfirm={ch.handleBatchDelete}
      />

      <div className="px-4 sm:px-6 pb-6">
        <SimilarNovels categoryId={novel.categoryId} currentNovelId={novel.id} novelTitle={novel.title} />
      </div>
    </div>
  );
}
