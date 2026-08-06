import { useState, useEffect, useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import {
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';

import { apiFetch } from '@/lib/api-fetch';
import type { Chapter, Novel } from '@/types';
import type { ContentFilter } from '@/components/novel/detail';

// ─── Public interface ─────────────────────────────────────────────────────────

export interface UseNovelChaptersProps {
  selectedNovelId: string | null;
  onRefresh: (key: string) => void;
  setChapterFormOpen: (open: boolean) => void;
  setEditingChapter: (chapter: Chapter | null) => void;
  onUpdateNovel: (novel: Novel) => void;
}

export interface UseNovelChaptersReturn {
  // State
  chapters: Chapter[];
  loadingChapters: boolean;
  chapterSearch: string;
  contentFilter: ContentFilter;
  batchMode: boolean;
  checkedIds: Set<string>;
  batchDeleteOpen: boolean;
  batchDeleting: boolean;
  deleteChapterOpen: boolean;
  deletingChapter: Chapter | null;
  chapterDeleting: boolean;
  selectedChapter: Chapter | null;
  readingChapter: Chapter | null;
  readerOpen: boolean;
  readerSession: number;
  reordering: boolean;
  contentProgress: { withContent: number; pct: number } | null;
  filteredChapters: Chapter[];
  isAllChecked: boolean;
  isSomeChecked: boolean;
  sensors: ReturnType<typeof useSensors>;

  // Setters needed by the component
  setChapterSearch: (v: string) => void;
  setContentFilter: (v: ContentFilter) => void;
  setSelectedChapter: (ch: Chapter | null) => void;
  setReaderOpen: (v: boolean) => void;
  setBatchMode: (v: boolean) => void;
  setBatchDeleteOpen: (v: boolean) => void;
  setDeleteChapterOpen: (v: boolean) => void;
  setCheckedIds: (v: Set<string>) => void;

  // Callbacks
  fetchChapters: (signal?: AbortSignal) => Promise<void>;
  toggleCheckAll: () => void;
  toggleCheck: (id: string, checked: boolean) => void;
  handleBatchDelete: () => Promise<void>;
  handleDragEnd: (event: DragEndEvent) => Promise<void>;
  handleMoveChapter: (chapterId: string, direction: 'up' | 'down') => Promise<void>;
  handleNewChapter: () => void;
  handleEditChapter: (ch: Chapter) => void;
  handleReadChapter: (ch: Chapter) => void;
  handleReaderNavigate: (ch: Chapter) => void;
  handleDeleteChapterClick: (ch: Chapter) => void;
  handleDeleteChapter: () => Promise<void>;
  handleChapterSaved: (updatedChapter?: { id?: string; wordCount?: number; title?: string }) => void;
  refreshNovelStats: () => Promise<void>;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useNovelChapters({
  selectedNovelId,
  onRefresh,
  setChapterFormOpen,
  setEditingChapter,
  onUpdateNovel,
}: UseNovelChaptersProps): UseNovelChaptersReturn {
  // ── Core state ───────────────────────────────────────────────────────────
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [loadingChapters, setLoadingChapters] = useState(true);
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

  // ── Delete single chapter state ─────────────────────────────────────────
  const [deleteChapterOpen, setDeleteChapterOpen] = useState(false);
  const [deletingChapter, setDeletingChapter] = useState<Chapter | null>(null);
  const [deleting, setDeleting] = useState(false);

  // ── Reorder state ───────────────────────────────────────────────────────
  const [reordering, setReordering] = useState(false);

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

  // ── Content progress memo ─────────────────────────────────────────────
  const contentProgress = useMemo(() => {
    if (chapters.length === 0) return null;
    const withContent = chapters.filter(c => (c.wordCount ?? 0) > 0).length;
    const pct = Math.round((withContent / chapters.length) * 100);
    return { withContent, pct };
  }, [chapters]);

  // ── DnD sensors ─────────────────────────────────────────────────────────
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

  // ── Fetch chapters ───────────────────────────────────────────────────────
  const fetchChapters = useCallback(async (signal?: AbortSignal) => {
    if (!selectedNovelId) return;
    setLoadingChapters(true);
    try {
      const data = await apiFetch<{ chapters?: Chapter[]; total?: number }>(
        `/api/novels/${selectedNovelId}/chapters?pageSize=10000`,
        { signal },
      );
      if (!signal?.aborted) setChapters(data.chapters || []);
    } catch { /* handled by apiFetch */ } finally {
      if (!signal?.aborted) setLoadingChapters(false);
    }
  }, [selectedNovelId]);

  // ── Check callbacks ──────────────────────────────────────────────────────
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

  // ── Batch delete handler ────────────────────────────────────────────────
  const handleBatchDelete = useCallback(async () => {
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
      onRefresh('chapters');
      onRefresh('novels');
    } catch {
      toast.error('批量删除失败');
    } finally {
      setBatchDeleting(false);
      setBatchDeleteOpen(false);
    }
  }, [checkedIds, selectedChapter, onRefresh]);

  // ── Drag & drop reorder ──────────────────────────────────────────────────
  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id || !selectedNovelId) return;

    const oldIndex = chapters.findIndex((c) => c.id === active.id);
    const newIndex = chapters.findIndex((c) => c.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(chapters, oldIndex, newIndex);
    setChapters(reordered);
    setReordering(true);

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
      onRefresh('chapters');
    } finally {
      setReordering(false);
    }
  }, [selectedNovelId, chapters, onRefresh]);

  // ── Move chapter up/down ─────────────────────────────────────────────────
  const handleMoveChapter = useCallback(async (chapterId: string, direction: 'up' | 'down') => {
    if (!selectedNovelId) return;
    const idx = chapters.findIndex((c) => c.id === chapterId);
    if (idx === -1) return;
    if (direction === 'up' && idx === 0) return;
    if (direction === 'down' && idx === chapters.length - 1) return;

    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    const reordered = arrayMove(chapters, idx, swapIdx);
    setChapters(reordered);
    setReordering(true);

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
      onRefresh('chapters');
    } finally {
      setReordering(false);
    }
  }, [selectedNovelId, chapters, onRefresh]);

  // ── Chapter CRUD handlers ───────────────────────────────────────────────
  const handleNewChapter = useCallback(() => {
    setEditingChapter(null);
    setChapterFormOpen(true);
  }, [setEditingChapter, setChapterFormOpen]);

  const handleEditChapter = useCallback((ch: Chapter) => {
    setEditingChapter(ch);
    setChapterFormOpen(true);
  }, [setEditingChapter, setChapterFormOpen]);

  const handleReadChapter = useCallback((ch: Chapter) => {
    setReadingChapter(ch);
    setReaderSession((s) => s + 1);
    setReaderOpen(true);
  }, []);

  const handleReaderNavigate = useCallback((ch: Chapter) => {
    setReadingChapter(ch);
  }, []);

  const handleDeleteChapterClick = useCallback((ch: Chapter) => {
    setDeletingChapter(ch);
    setDeleteChapterOpen(true);
  }, []);

  const handleDeleteChapter = useCallback(async () => {
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
      onRefresh('chapters');
      onRefresh('novels');
    } catch { /* handled by apiFetch */ } finally {
      setDeleting(false);
      setDeleteChapterOpen(false);
      setDeletingChapter(null);
    }
  }, [deletingChapter, selectedChapter, onRefresh]);

  // ── Silent novel stats refresh ──────────────────────────────────────────
  const refreshNovelStats = useCallback(async () => {
    if (!selectedNovelId) return;
    try {
      const data = await apiFetch<Novel>(`/api/novels/${selectedNovelId}`);
      onUpdateNovel(data);
    } catch {
      // Silent fail — don't navigate away or show loading
    }
  }, [selectedNovelId, onUpdateNovel]);

  // ── Optimistic update on chapter save ────────────────────────────────────
  const handleChapterSaved = useCallback((updatedChapter?: { id?: string; wordCount?: number; title?: string }) => {
    if (updatedChapter?.id && updatedChapter.wordCount !== undefined) {
      setChapters((prev) =>
        prev.map((ch) =>
          ch.id === updatedChapter.id
            ? { ...ch, wordCount: updatedChapter.wordCount ?? ch.wordCount, title: updatedChapter.title ?? ch.title }
            : ch
        ),
      );
    }
    refreshNovelStats();
  }, [refreshNovelStats]);

  // ── Effects ─────────────────────────────────────────────────────────────

  // Exit batch mode when filter changes
  useEffect(() => {
    queueMicrotask(() => setCheckedIds(new Set()));
  }, [chapterSearch, contentFilter]);

  return {
    // State
    chapters,
    loadingChapters,
    chapterSearch,
    contentFilter,
    batchMode,
    checkedIds,
    batchDeleteOpen,
    batchDeleting,
    deleteChapterOpen,
    deletingChapter,
    chapterDeleting: deleting,
    selectedChapter,
    readingChapter,
    readerOpen,
    readerSession,
    reordering,
    contentProgress,
    filteredChapters,
    isAllChecked,
    isSomeChecked,
    sensors,

    // Setters
    setChapterSearch,
    setContentFilter,
    setSelectedChapter,
    setReaderOpen,
    setBatchMode,
    setBatchDeleteOpen,
    setDeleteChapterOpen,
    setCheckedIds,

    // Callbacks
    fetchChapters,
    toggleCheckAll,
    toggleCheck,
    handleBatchDelete,
    handleDragEnd,
    handleMoveChapter,
    handleNewChapter,
    handleEditChapter,
    handleReadChapter,
    handleReaderNavigate,
    handleDeleteChapterClick,
    handleDeleteChapter,
    handleChapterSaved,
    refreshNovelStats,
  };
}
