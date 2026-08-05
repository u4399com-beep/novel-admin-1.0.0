'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import { BookX, Loader2, ChevronLeft } from 'lucide-react';
import {
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@/components/ui/resizable';
import { useAppStore } from '@/stores/app-store';
import { apiFetch } from '@/lib/api-fetch';
import type { Novel, Chapter } from '@/types';

import {
  NovelHeader,
  StatsBar,
  ChapterActions,
  ChapterTable,
  ChapterEditorPanel,
  ChapterReaderDialog,
} from './detail';
import type { ContentFilter } from './detail';

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

  const [novel, setNovel] = useState<Novel | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [loadingNovel, setLoadingNovel] = useState(true);
  const [loadingChapters, setLoadingChapters] = useState(true);
  const [deleteNovelOpen, setDeleteNovelOpen] = useState(false);
  const [deleteChapterOpen, setDeleteChapterOpen] = useState(false);
  const [deletingChapter, setDeletingChapter] = useState<Chapter | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [selectedChapter, setSelectedChapter] = useState<Chapter | null>(null);
  const [readingChapter, setReadingChapter] = useState<Chapter | null>(null);
  const [readerOpen, setReaderOpen] = useState(false);
  const [readerSession, setReaderSession] = useState(0);

  // ── Chapter search & filter state ───────────────────────────────────────
  const [chapterSearch, setChapterSearch] = useState('');
  const [contentFilter, setContentFilter] = useState<ContentFilter>('all');

  // ── Batch selection state ───────────────────────────────────────────────
  const [batchMode, setBatchMode] = useState(false);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [batchDeleting, setBatchDeleting] = useState(false);

  // ── Filtered chapters ───────────────────────────────────────────────────
  const filteredChapters = useMemo(() => {
    let result = chapters;
    if (chapterSearch.trim()) {
      const q = chapterSearch.trim().toLowerCase();
      result = result.filter((ch) => ch.title.toLowerCase().includes(q));
    }
    if (contentFilter === 'has-content') {
      result = result.filter((ch) => (ch.wordCount ?? 0) > 0);
    } else if (contentFilter === 'no-content') {
      result = result.filter((ch) => (ch.wordCount ?? 0) === 0);
    }
    return result;
  }, [chapters, chapterSearch, contentFilter]);

  const isAllChecked = filteredChapters.length > 0 && filteredChapters.every((ch) => checkedIds.has(ch.id));
  const isSomeChecked = filteredChapters.some((ch) => checkedIds.has(ch.id));

  const toggleCheckAll = useCallback(() => {
    if (isAllChecked) {
      setCheckedIds(new Set());
    } else {
      setCheckedIds(new Set(filteredChapters.map((ch) => ch.id)));
    }
  }, [isAllChecked, filteredChapters]);

  const toggleCheck = useCallback((id: string, checked: boolean) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  // ── Content progress memo ─────────────────────────────────────────────
  const contentProgress = useMemo(() => {
    if (chapters.length === 0) return null;
    const withContent = chapters.filter(c => (c.wordCount ?? 0) > 0).length;
    const pct = Math.round((withContent / chapters.length) * 100);
    return { withContent, pct };
  }, [chapters]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

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

  // Fetch chapters
  const fetchChapters = useCallback(async (signal?: AbortSignal) => {
    if (!selectedNovelId) return;
    setLoadingChapters(true);
    try {
      const data = await apiFetch<{ chapters?: Chapter[]; total?: number }>(`/api/novels/${selectedNovelId}/chapters?pageSize=10000`, { signal });
      if (!signal?.aborted) setChapters(data.chapters || []);
    } catch { /* handled by apiFetch */ } finally {
      if (!signal?.aborted) setLoadingChapters(false);
    }
  }, [selectedNovelId]);

  useEffect(() => {
    const ac = new AbortController();
    fetchNovel(ac.signal);
    return () => ac.abort();
  }, [fetchNovel, refreshNovels]);

  useEffect(() => {
    const ac = new AbortController();
    fetchChapters(ac.signal);
    return () => ac.abort();
  }, [fetchChapters, refreshChapters]);

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleBack = () => {
    selectNovel(null);
    setCurrentView('novels');
  };

  const handleEditNovel = () => {
    if (!novel) return;
    setEditingNovel(novel);
    setNovelFormOpen(true);
  };

  const handleExport = async () => {
    if (!novel || exporting) return;
    setExporting(true);
    try {
      // Raw fetch required for blob response — apiFetch would try to parse JSON
      const res = await fetch(`/api/novels/${novel.id}/export?format=json`, { credentials: 'include' });
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

  const handleNewChapter = () => {
    setEditingChapter(null);
    setChapterFormOpen(true);
  };

  const handleEditChapter = (ch: Chapter) => {
    setEditingChapter(ch);
    setChapterFormOpen(true);
  };

  const handleReadChapter = (ch: Chapter) => {
    setReadingChapter(ch);
    setReaderSession((s) => s + 1);
    setReaderOpen(true);
  };

  const handleReaderNavigate = useCallback((ch: Chapter) => {
    setReadingChapter(ch);
  }, []);

  const handleDeleteChapterClick = (ch: Chapter) => {
    setDeletingChapter(ch);
    setDeleteChapterOpen(true);
  };

  const handleDeleteChapter = async () => {
    if (!deletingChapter) return;
    setDeleting(true);
    try {
      await apiFetch(`/api/chapters/${deletingChapter.id}`, {
        method: 'DELETE',
      });
      toast.success('章节已删除');
      if (selectedChapter?.id === deletingChapter.id) {
        setSelectedChapter(null);
      }
      triggerRefresh('chapters');
      triggerRefresh('novels');
    } catch { /* handled by apiFetch */ } finally {
      setDeleting(false);
      setDeleteChapterOpen(false);
      setDeletingChapter(null);
    }
  };

  // ── Batch delete handler ────────────────────────────────────────────────
  const handleBatchDelete = async () => {
    if (checkedIds.size === 0) return;
    setBatchDeleting(true);
    let successCount = 0;
    let failCount = 0;

    try {
      const CHUNK_SIZE = 5;
      const ids = Array.from(checkedIds);
      for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
        const chunk = ids.slice(i, i + CHUNK_SIZE);
        const results = await Promise.allSettled(chunk.map(async (id) => {
          await apiFetch(`/api/chapters/${id}`, { method: 'DELETE' });
          return id;
        }));
        results.forEach((r) => {
          if (r.status === 'fulfilled') successCount++;
          else failCount++;
        });
      }

      if (selectedChapter && checkedIds.has(selectedChapter.id)) {
        setSelectedChapter(null);
      }

      if (failCount === 0) {
        toast.success(`成功删除 ${successCount} 个章节`);
      } else {
        toast.warning(`删除完成：${successCount} 成功，${failCount} 失败`);
      }

      setCheckedIds(new Set());
      setBatchMode(false);
      triggerRefresh('chapters');
      triggerRefresh('novels');
    } catch {
      toast.error('批量删除失败');
    } finally {
      setBatchDeleting(false);
      setBatchDeleteOpen(false);
    }
  };

  // Exit batch mode when filter changes
  useEffect(() => {
    setCheckedIds(new Set());
  }, [chapterSearch, contentFilter]);

  const [reordering, setReordering] = useState(false);

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id || !selectedNovelId) return;

    const oldIndex = chapters.findIndex((c) => c.id === active.id);
    const newIndex = chapters.findIndex((c) => c.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(chapters, oldIndex, newIndex);
    setChapters(reordered);
    setReordering(true);

    // Only send the affected range to minimize payload
    const start = Math.min(oldIndex, newIndex);
    const end = Math.max(oldIndex, newIndex) + 1;
    const affected = reordered.slice(start, end);

    try {
      await apiFetch(`/api/novels/${selectedNovelId}/chapters`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'reorder',
          orders: affected.map((ch, i) => ({ id: ch.id, sortOrder: start + i + 1 })),
        }),
      });
    } catch {
      triggerRefresh('chapters');
    } finally {
      setReordering(false);
    }
  };

  const handleMoveChapter = async (chapterId: string, direction: 'up' | 'down') => {
    if (!selectedNovelId) return;
    const idx = chapters.findIndex((c) => c.id === chapterId);
    if (idx === -1) return;
    if (direction === 'up' && idx === 0) return;
    if (direction === 'down' && idx === chapters.length - 1) return;

    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    const reordered = arrayMove(chapters, idx, swapIdx);
    setChapters(reordered);
    setReordering(true);

    // Use swap action — only 2 SQL UPDATEs instead of N
    try {
      await apiFetch(`/api/novels/${selectedNovelId}/chapters`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'swap',
          id1: chapterId,
          id2: chapters[swapIdx].id,
        }),
      });
    } catch {
      triggerRefresh('chapters');
    } finally {
      setReordering(false);
    }
  };

  // Silent novel stats refresh (no loading state, no navigation on error)
  const refreshNovelStats = useCallback(async () => {
    if (!selectedNovelId) return;
    try {
      const data = await apiFetch<Novel>(`/api/novels/${selectedNovelId}`);
      setNovel(data);
    } catch {
      // Silent fail - don't navigate away or show loading
    }
  }, [selectedNovelId]);

  // Optimistic update on chapter save: update wordCount locally, avoid full 10K-chapter refetch
  const handleChapterSaved = (updatedChapter?: { id?: string; wordCount?: number; title?: string }) => {
    if (updatedChapter?.id && updatedChapter.wordCount !== undefined) {
      setChapters((prev) =>
        prev.map((ch) =>
          ch.id === updatedChapter.id
            ? { ...ch, wordCount: updatedChapter.wordCount ?? ch.wordCount, title: updatedChapter.title ?? ch.title }
            : ch
        )
      );
    }
    refreshNovelStats();
  };

  // ── Loading state ─────────────────────────────────────────────────────────

  if (loadingNovel) {
    return (
      <div className="flex-1 p-6 space-y-6">
        <div className="flex items-center gap-4">
          <Skeleton className="size-9" />
          <Skeleton className="h-8 w-48" />
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
          <Button variant="outline" onClick={() => setCurrentView('novels')}>
            返回列表
          </Button>
        </div>
      </div>
    );
  }

  const totalWords = novel.wordCount ?? chapters.reduce((sum, ch) => sum + (ch.wordCount ?? 0), 0);
  const chapterCount = novel._count?.chapters ?? chapters.length;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* ─── Header section ────────────────────────────────────────────── */}
      <NovelHeader
        novel={novel}
        chapterCount={chapterCount}
        totalWords={totalWords}
        exporting={exporting}
        onBack={handleBack}
        onEdit={handleEditNovel}
        onDelete={() => setDeleteNovelOpen(true)}
        onExport={handleExport}
      />

      {/* ─── Chapters section with responsive layout ───────────────────── */}
      <div className="flex-1 min-h-0 overflow-hidden p-4 sm:p-6 pt-3 sm:pt-4">
        <ResizablePanelGroup direction="horizontal" className={`h-full rounded-lg border ${selectedChapter ? 'hidden lg:flex' : 'flex'}`}>
          {/* Left panel: Chapter list */}
          <ResizablePanel defaultSize={selectedChapter ? 45 : 100} minSize={30}>
            <div className="flex flex-col h-full">
              {/* Reading progress bar */}
              <StatsBar contentProgress={contentProgress} totalChapters={chapters.length} />

              {/* Chapter list header + search + filter + batch actions */}
              <ChapterActions
                chaptersLength={chapters.length}
                filteredChaptersLength={filteredChapters.length}
                batchMode={batchMode}
                chapterSearch={chapterSearch}
                contentFilter={contentFilter}
                checkedIdsCount={checkedIds.size}
                onToggleBatchMode={() => {
                  setBatchMode(!batchMode);
                  setCheckedIds(new Set());
                }}
                onNewChapter={handleNewChapter}
                onSearchChange={setChapterSearch}
                onClearSearch={() => setChapterSearch('')}
                onContentFilterChange={setContentFilter}
                onBatchDelete={() => setBatchDeleteOpen(true)}
              />

              {/* Chapter list content */}
              <ChapterTable
                chapters={chapters}
                filteredChapters={filteredChapters}
                loading={loadingChapters}
                chapterSearch={chapterSearch}
                contentFilter={contentFilter}
                batchMode={batchMode}
                selectedChapter={selectedChapter}
                checkedIds={checkedIds}
                isAllChecked={isAllChecked}
                isSomeChecked={isSomeChecked}
                sensors={sensors}
                onDragEnd={handleDragEnd}
                onEdit={handleEditChapter}
                onDelete={handleDeleteChapterClick}
                onRead={handleReadChapter}
                onSelect={setSelectedChapter}
                onToggleCheckAll={toggleCheckAll}
                onToggleCheck={toggleCheck}
                onMoveChapter={handleMoveChapter}
                reordering={reordering}
                onClearFilters={() => { setChapterSearch(''); setContentFilter('all'); }}
              />
            </div>
          </ResizablePanel>

          {/* Right panel: Chapter editor (shown when a chapter is selected) */}
          {selectedChapter && (
            <>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize={55} minSize={30}>
                {/* Mobile back button shown above editor on small screens */}
                <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/30 shrink-0 lg:hidden">
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setSelectedChapter(null)}>
                    <ChevronLeft className="size-3.5 mr-1" />
                    返回列表
                  </Button>
                  <span className="text-sm font-medium truncate">{selectedChapter.title}</span>
                </div>
                <div className="flex-1 min-h-0">
                  <ChapterEditorPanel
                    key={selectedChapter.id}
                    chapter={selectedChapter}
                    onClose={() => setSelectedChapter(null)}
                    onSaved={handleChapterSaved}
                  />
                </div>
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </div>

      {/* ─── Chapter reader dialog ──────────────────────────────────────── */}
      <ChapterReaderDialog
        key={`${readingChapter?.id ?? 'none'}-${readerSession}`}
        open={readerOpen}
        onOpenChange={setReaderOpen}
        chapter={readingChapter}
        chapters={chapters}
        onNavigate={handleReaderNavigate}
      />

      {/* ─── Delete novel confirmation ─────────────────────────────────── */}
      <AlertDialog open={deleteNovelOpen} onOpenChange={setDeleteNovelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除小说</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除「{novel.title}」吗？此操作将同时删除所有关联的章节，且不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleDeleteNovel(); }}
              disabled={deleting}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {deleting && <Loader2 className="size-4 animate-spin" />}
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ─── Delete chapter confirmation ───────────────────────────────── */}
      <AlertDialog open={deleteChapterOpen} onOpenChange={setDeleteChapterOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除章节</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除「{deletingChapter?.title}」吗？此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleDeleteChapter(); }}
              disabled={deleting}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {deleting && <Loader2 className="size-4 animate-spin" />}
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ─── Batch delete confirmation ─────────────────────────────────── */}
      <AlertDialog open={batchDeleteOpen} onOpenChange={setBatchDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>批量删除章节</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除选中的 <strong>{checkedIds.size}</strong> 个章节吗？此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={batchDeleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleBatchDelete(); }}
              disabled={batchDeleting}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {batchDeleting && <Loader2 className="size-4 animate-spin" />}
              确认删除 {checkedIds.size} 项
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
