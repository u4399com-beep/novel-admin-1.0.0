'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { toast } from 'sonner';
import {
  ArrowLeft,
  User,
  BookOpen,
  FileText,
  Plus,
  Pencil,
  Trash2,
  GripVertical,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Save,
  X,
  Type,
  Clock,
  BookX,
  CheckCircle2,
  Search,
  Filter,
  Check,
  Square,
  XCircle,
  Download,
} from 'lucide-react';
import { safeFormatDate, formatReadingTime } from '@/lib/format';
import { apiFetch } from '@/lib/api-fetch';
import { format } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@/components/ui/resizable';
import { useAppStore } from '@/stores/app-store';
import { NOVEL_STATUS_MAP } from '@/lib/constants';
import type { Novel, Chapter } from '@/types';

// ─── Content filter type ─────────────────────────────────────────────────────
type ContentFilter = 'all' | 'has-content' | 'no-content';

// ─── Sortable row ─────────────────────────────────────────────────────────────
function SortableChapterRow({
  chapter,
  index,
  onEdit,
  onDelete,
  onRead,
  onSelect,
  isSelected,
  isChecked,
  onCheckChange,
  isBatchMode,
}: {
  chapter: Chapter;
  index: number;
  onEdit: (ch: Chapter) => void;
  onDelete: (ch: Chapter) => void;
  onRead: (ch: Chapter) => void;
  onSelect: (ch: Chapter) => void;
  isSelected: boolean;
  isChecked: boolean;
  onCheckChange: (checked: boolean) => void;
  isBatchMode: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: chapter.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <TableRow
      ref={setNodeRef}
      style={style}
      className={`${isDragging ? 'z-50 opacity-50 shadow-lg' : ''} ${
        isSelected ? 'bg-accent/60' : ''
      } ${isChecked ? 'bg-primary/5' : ''} group cursor-pointer`}
      onClick={() => onSelect(chapter)}
    >
      <TableCell className="w-10">
        <div className="flex items-center gap-1">
          {isBatchMode && (
            <Checkbox
              checked={isChecked}
              onCheckedChange={(val) => { onCheckChange(!!val); }}
              onClick={(e) => e.stopPropagation()}
              aria-label={`选择第${index + 1}章`}
              className="data-[state=checked]:bg-primary data-[state=checked]:border-primary"
            />
          )}
          <button
            aria-label="拖拽排序"
            className="drag-handle text-muted-foreground hover:text-foreground p-0.5"
            {...attributes}
            {...listeners}
            onClick={(e) => e.stopPropagation()}
          >
            <GripVertical className="size-4" />
          </button>
        </div>
      </TableCell>
      <TableCell className="w-16 text-center text-muted-foreground font-mono text-sm">
        {index + 1}
      </TableCell>
      <TableCell
        className="font-medium max-w-[240px] truncate cursor-pointer hover:text-primary transition-colors"
        onClick={() => onSelect(chapter)}
      >
        <span className="inline-flex items-center gap-2">
          <span className={`shrink-0 h-1.5 w-1.5 rounded-full ${(chapter.wordCount ?? 0) > 0 ? 'bg-emerald-500' : 'border border-muted-foreground/30'}`} />
          {chapter.title}
        </span>
      </TableCell>
      <TableCell className="w-24 text-muted-foreground tabular-nums text-sm">
        {(chapter.wordCount ?? 0).toLocaleString()}
      </TableCell>
      <TableCell className="w-40 text-muted-foreground text-sm">
        {safeFormatDate(chapter.updatedAt, (d) => format(d, 'yyyy-MM-dd HH:mm', { locale: zhCN }))}
      </TableCell>
      <TableCell className="w-32 text-right">
        <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={(e) => {
              e.stopPropagation();
              onRead(chapter);
            }}
          >
            <BookOpen className="size-3.5" />
            <span className="sr-only">阅读</span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={(e) => {
              e.stopPropagation();
              onEdit(chapter);
            }}
          >
            <Pencil className="size-3.5" />
            <span className="sr-only">编辑</span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-destructive hover:text-destructive"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(chapter);
            }}
          >
            <Trash2 className="size-3.5" />
            <span className="sr-only">删除</span>
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

// ─── Inline chapter editor panel ──────────────────────────────────────────────
function ChapterEditorPanel({
  chapter,
  onClose,
  onSaved,
}: {
  chapter: Chapter | null;
  onClose: () => void;
  onSaved: (updated?: { id?: string; wordCount?: number; title?: string }) => void;
}) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialLoadRef = useRef(false);
  const dirtyRef = useRef(false);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
      if (saveStatusTimerRef.current) clearTimeout(saveStatusTimerRef.current);
    };
  }, []);

  // Load chapter content when selected
  useEffect(() => {
    if (!chapter) {
      setTitle('');
      setContent('');
      setSaveStatus('idle');
      initialLoadRef.current = false;
      return;
    }

    // Fetch full chapter content
    const ac = new AbortController();
    const loadChapter = async () => {
      try {
        const data = await apiFetch<{ title: string; content: string }>(`/api/chapters/${chapter.id}`, { signal: ac.signal });
        setTitle(data.title);
        setContent(data.content || '');
        initialLoadRef.current = true;
        dirtyRef.current = false;
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        /* handled by apiFetch */
      }
    };

    loadChapter();
    return () => ac.abort();
  }, [chapter]);

  // Auto-save debounce
  // NOTE: Uses a ref-based guard instead of a closure `saving` variable
  // to avoid stale closure issues when the user types quickly.
  const savingRef = useRef(false);
  const saveChapter = useCallback(
    async (newTitle: string, newContent: string) => {
      if (!chapter || !initialLoadRef.current) return;
      if (savingRef.current) return;

      savingRef.current = true;
      setSaving(true);
      setSaveStatus('saving');

      try {
        const wordCount = newContent.length;
        await apiFetch(`/api/chapters/${chapter.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: newTitle,
            content: newContent,
            wordCount,
          }),
        });

        setSaveStatus('saved');
        if (saveStatusTimerRef.current) clearTimeout(saveStatusTimerRef.current);
        saveStatusTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2000);
        onSaved({ id: chapter.id, wordCount, title: newTitle });
      } catch {
        setSaveStatus('idle');
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [chapter, onSaved],
  );

  // Mark dirty on user input (not on initial API load)
  const handleTitleChange = useCallback((v: string) => { setTitle(v); dirtyRef.current = true; }, []);
  const handleContentChange = useCallback((v: string) => { setContent(v); dirtyRef.current = true; }, []);

  // Auto-save on content change (only if user has actually edited)
  useEffect(() => {
    if (!chapter || !initialLoadRef.current || !dirtyRef.current) return;

    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
    }

    autoSaveTimerRef.current = setTimeout(() => {
      saveChapter(title, content);
    }, 1500);

    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
      }
    };
  }, [title, content, chapter, saveChapter]);

  const handleManualSave = async () => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
    }
    await saveChapter(title, content);
  };

  if (!chapter) return null;

  const wordCount = content.length;
  const charCount = content.replace(/\s/g, '').length;

  return (
    <div className="flex flex-col h-full">
      {/* Editor header */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/30">
        <div className="flex items-center gap-2 min-w-0">
          <Type className="size-4 text-muted-foreground shrink-0" />
          <Input
            value={title}
            onChange={(e) => handleTitleChange(e.target.value)}
            className="h-8 text-sm font-medium border-0 bg-transparent focus-visible:ring-0 px-1"
            placeholder="章节标题"
          />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* Auto-save indicator */}
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {saveStatus === 'saving' && (
              <>
                <Loader2 className="size-3 animate-spin" />
                <span>保存中...</span>
              </>
            )}
            {saveStatus === 'saved' && (
              <>
                <CheckCircle2 className="size-3 text-emerald-500" />
                <span className="text-emerald-600 dark:text-emerald-400">已保存</span>
              </>
            )}
            {saveStatus === 'idle' && (
              <span className="tabular-nums">{wordCount.toLocaleString()} 字{formatReadingTime(wordCount) && ` · ${formatReadingTime(wordCount)}`}</span>
            )}
          </div>
          <Separator orientation="vertical" className="h-4" />
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="关闭"
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>

      {/* Editor content */}
      <div className="flex-1 overflow-hidden relative">
        <Textarea
          value={content}
          onChange={(e) => handleContentChange(e.target.value)}
          className="absolute inset-0 resize-none rounded-none border-0 shadow-none focus-visible:ring-0 p-4 font-mono text-sm leading-loose min-h-full h-full"
          placeholder="开始编写章节内容..."
        />
      </div>

      {/* Editor footer */}
      <div className="flex items-center justify-between px-4 py-2 border-t bg-muted/30 text-xs text-muted-foreground">
        <div className="flex items-center gap-4">
          <span>字数: {wordCount.toLocaleString()}</span>
          <span>字符 (不含空格): {charCount.toLocaleString()}</span>
        </div>
        <Button
          size="sm"
          onClick={handleManualSave}
          disabled={saving}
          className="h-7 text-xs"
        >
          <Save className="size-3" />
          手动保存
        </Button>
      </div>
    </div>
  );
}

// ─── Chapter reader dialog ──────────────────────────────────────────────────
function ChapterReaderDialog({
  open,
  onOpenChange,
  chapter,
  chapters,
  onNavigate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chapter: Chapter | null;
  chapters: Chapter[];
  onNavigate: (chapter: Chapter) => void;
}) {
  // Component is remounted via key prop on every open / chapter-nav, so
  // initial state is always fresh.
  const hasInlineContent = !!(chapter?.content?.trim());
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(!hasInlineContent);

  const chapterIndex = chapter ? chapters.findIndex((c) => c.id === chapter.id) : -1;
  const prevChapter = chapterIndex > 0 ? chapters[chapterIndex - 1] : null;
  const nextChapter = chapterIndex >= 0 && chapterIndex < chapters.length - 1 ? chapters[chapterIndex + 1] : null;

  // Derive what to display: prefer inline content, fall back to fetched
  const inlineContent = chapter?.content?.trim() || null;
  const displayContent = open ? (inlineContent ?? content) : '';
  const isLoading = open && !inlineContent && loading;
  const wordCount = displayContent.length;

  // Fetch chapter content when it is not already available inline
  useEffect(() => {
    if (!chapter || !open) return;
    if (chapter.content?.trim()) return;

    const ac = new AbortController();
    const loadContent = async () => {
      try {
        const data = await apiFetch<{ title: string; content: string }>(`/api/chapters/${chapter.id}`, { signal: ac.signal });
        setContent(data.content || '');
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        setContent('');
      } finally {
        setLoading(false);
      }
    };

    loadContent();

    return () => ac.abort();
  }, [chapter, open]);

  // Keyboard navigation
  useEffect(() => {
    if (!open || !chapter) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && prevChapter) {
        e.preventDefault();
        onNavigate(prevChapter);
      } else if (e.key === 'ArrowRight' && nextChapter) {
        e.preventDefault();
        onNavigate(nextChapter);
      } else if (e.key === 'Escape') {
        onOpenChange(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, chapter, prevChapter, nextChapter, onNavigate, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col p-0 overflow-hidden">
        {/* Header */}
        <DialogHeader className="px-6 pt-6 pb-0 shrink-0">
          <DialogTitle className="text-lg font-semibold leading-tight">
            {chapter?.title ?? ''}
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {chapter && (
              <span>第 {chapterIndex + 1} / {chapters.length} 章</span>
            )}
          </DialogDescription>
        </DialogHeader>

        {/* Content area */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {isLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-5/6" />
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-4/5" />
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-5 w-5/6" />
            </div>
          ) : displayContent.trim() ? (
            <div
              className="mx-auto max-w-prose text-foreground leading-[1.9] tracking-wide text-[15px]"
              style={{ fontFamily: '"Noto Serif SC", "Source Han Serif SC", "STSong", Georgia, serif' }}
            >
              {displayContent.split('\n').map((paragraph, i) => (
                <p
                  key={i}
                  className={paragraph.trim() === '' ? 'h-4' : 'text-indent-[2em] mb-1'}
                >
                  {paragraph.trim()}
                </p>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <BookX className="size-10 mb-3 opacity-30" />
              <p className="text-sm">该章节暂无内容</p>
            </div>
          )}
        </div>

        {/* Footer with word count and navigation */}
        <div className="shrink-0 border-t px-6 py-3 flex items-center justify-between bg-muted/30">
          <span className="text-xs text-muted-foreground tabular-nums">
            {wordCount.toLocaleString()} 字
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1"
              disabled={!prevChapter}
              onClick={() => prevChapter && onNavigate(prevChapter)}
            >
              <ChevronLeft className="size-3.5" />
              上一章
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1"
              disabled={!nextChapter}
              onClick={() => nextChapter && onNavigate(nextChapter)}
            >
              下一章
              <ChevronRight className="size-3.5" />
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

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

  const statusInfo = NOVEL_STATUS_MAP[novel.status] || NOVEL_STATUS_MAP.ongoing;
  const totalWords = novel.wordCount ?? chapters.reduce((sum, ch) => sum + (ch.wordCount ?? 0), 0);
  const chapterCount = novel._count?.chapters ?? chapters.length;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* ─── Header section ────────────────────────────────────────────── */}
      <div className="p-6 pb-0">
        {/* Back button */}
        <Button
          variant="ghost"
          size="sm"
          className="mb-4 -ml-2 text-muted-foreground"
          onClick={handleBack}
        >
          <ArrowLeft className="size-4" />
          返回小说列表
        </Button>

        {/* Novel info card */}
        <Card className="overflow-hidden card-border-glow">
          <CardContent className="p-0">
            <div className="flex flex-col sm:flex-row gap-6 p-6">
              {/* Cover */}
              <div className="shrink-0">
                {novel.coverUrl ? (
                  <div className="relative w-36 h-48 sm:w-40 sm:h-52">
                    <img
                      src={novel.coverUrl}
                      alt={novel.title}
                      className="object-cover rounded-lg shadow-md w-full h-full"
                      onError={(e) => {
                        const img = e.currentTarget;
                        img.style.display = 'none';
                        const fallback = img.parentElement?.querySelector('[data-cover-fallback]');
                        fallback?.classList.remove('hidden');
                      }}
                    />
                    <div
                      data-cover-fallback
                      className="hidden absolute inset-0 rounded-lg shadow-md bg-gradient-to-br from-violet-500/20 via-fuchsia-500/20 to-rose-500/20 flex items-center justify-center"
                    >
                      <BookOpen className="size-12 text-muted-foreground/50" />
                    </div>
                  </div>
                ) : (
                  <div className="w-36 h-48 sm:w-40 sm:h-52 rounded-lg shadow-md bg-gradient-to-br from-violet-500/20 via-fuchsia-500/20 to-rose-500/20 flex items-center justify-center">
                    <BookOpen className="size-12 text-muted-foreground/50" />
                  </div>
                )}
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                  <div className="min-w-0">
                    <h1 className="text-2xl font-bold tracking-tight truncate">
                      {novel.title}
                    </h1>
                    <div className="flex items-center gap-2 mt-1.5 text-muted-foreground">
                      <User className="size-3.5" />
                      <span className="text-sm">{novel.author || '佚名'}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button variant="outline" size="sm" disabled={exporting} onClick={handleExport}>
                      {exporting ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                      {exporting ? '导出中...' : '导出'}
                    </Button>
                    <Button variant="outline" size="sm" onClick={handleEditNovel}>
                      <Pencil className="size-3.5" />
                      编辑小说
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setDeleteNovelOpen(true)}
                    >
                      <Trash2 className="size-3.5" />
                      删除
                    </Button>
                  </div>
                </div>

                {/* Badges */}
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className={statusInfo.className}>{statusInfo.label}</Badge>
                  {novel.category && (
                    <Badge
                      variant="outline"
                      style={{
                        borderColor: novel.category.color,
                        color: novel.category.color,
                      }}
                    >
                      {novel.category.name}
                    </Badge>
                  )}
                  {(novel.tags ?? []).map(({ tag }) => (
                    <Badge
                      key={tag.id}
                      variant="secondary"
                      className="text-xs"
                    >
                      {tag.name}
                    </Badge>
                  ))}
                </div>

                {/* Description */}
                {novel.description && (
                  <p className="text-sm text-muted-foreground leading-relaxed line-clamp-3">
                    {novel.description}
                  </p>
                )}

                {/* Stats */}
                <div className="flex items-center gap-6 text-sm text-muted-foreground">
                  <div className="flex items-center gap-1.5">
                    <FileText className="size-3.5" />
                    <span>
                      <strong className="text-foreground">{chapterCount}</strong> 章
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Type className="size-3.5" />
                    <span>
                      <strong className="text-foreground">
                        {totalWords.toLocaleString()}
                      </strong>{' '}
                      字
                    </span>
                  </div>
                </div>

                {/* Timestamps */}
                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                  <div className="flex items-center gap-1">
                    <Clock className="size-3" />
                    创建: {safeFormatDate(novel.createdAt, (d) => format(d, 'yyyy-MM-dd HH:mm', { locale: zhCN }))}
                  </div>
                  <div className="flex items-center gap-1">
                    更新: {safeFormatDate(novel.updatedAt, (d) => format(d, 'yyyy-MM-dd HH:mm', { locale: zhCN }))}
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ─── Chapters section with responsive layout ───────────────────── */}
      <div className="flex-1 min-h-0 overflow-hidden p-4 sm:p-6 pt-3 sm:pt-4">
        <ResizablePanelGroup direction="horizontal" className={`h-full rounded-lg border ${selectedChapter ? 'hidden lg:flex' : 'flex'}`}>
          {/* Left panel: Chapter list */}
          <ResizablePanel defaultSize={selectedChapter ? 45 : 100} minSize={30}>
            <div className="flex flex-col h-full">
              {/* Chapter list header */}
              {/* Reading progress bar */}
              {contentProgress && (
                <div className="px-4 pt-3 space-y-1">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>采集进度</span>
                    <span>{contentProgress.withContent}/{chapters.length} 章 ({contentProgress.pct}%)</span>
                  </div>
                  <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400 dark:from-emerald-600 dark:to-emerald-500 rounded-full transition-all duration-500 ease-out"
                      style={{ width: `${contentProgress.pct}%` }}
                    />
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/30">
                <h2 className="text-base font-semibold flex items-center gap-2">
                  章节列表
                  {chapters.length > 0 && (
                    <Badge variant="secondary" className="text-xs">
                      {filteredChapters.length === chapters.length
                        ? chapters.length
                        : `${filteredChapters.length}/${chapters.length}`}
                    </Badge>
                  )}
                </h2>
                <div className="flex items-center gap-1.5">
                  <Button
                    variant={batchMode ? 'default' : 'outline'}
                    size="sm"
                    className="h-7 text-xs gap-1"
                    onClick={() => {
                      setBatchMode(!batchMode);
                      setCheckedIds(new Set());
                    }}
                  >
                    {batchMode ? (
                      <>
                        <XCircle className="size-3" />
                        取消批量
                      </>
                    ) : (
                      <>
                        <Check className="size-3" />
                        批量操作
                      </>
                    )}
                  </Button>
                  <Button size="sm" onClick={handleNewChapter}>
                    <Plus className="size-4" />
                    新建章节
                  </Button>
                </div>
              </div>

              {/* Search & filter bar */}
              {chapters.length > 0 && (
                <div className="flex items-center gap-2 px-4 py-2 border-b bg-background">
                  <div className="relative flex-1">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                    <Input
                      value={chapterSearch}
                      onChange={(e) => setChapterSearch(e.target.value)}
                      placeholder="搜索章节标题..."
                      className="h-8 pl-8 text-sm focus-ring-bright"
                    />
                    {chapterSearch && (
                      <button
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        onClick={() => setChapterSearch('')}
                        aria-label="清除搜索"
                      >
                        <X className="size-3.5" />
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-0.5 rounded-md border bg-background p-0.5" role="tablist" aria-label="内容筛选">
                    {([
                      { key: 'all' as ContentFilter, label: '全部' },
                      { key: 'has-content' as ContentFilter, label: '有内容' },
                      { key: 'no-content' as ContentFilter, label: '无内容' },
                    ]).map((opt) => (
                      <button
                        key={opt.key}
                        role="tab"
                        aria-selected={contentFilter === opt.key}
                        onClick={() => setContentFilter(opt.key)}
                        className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                          contentFilter === opt.key
                            ? 'bg-primary text-primary-foreground shadow-sm'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Batch action bar */}
              {batchMode && checkedIds.size > 0 && (
                <div className="flex items-center justify-between px-4 py-2 border-b bg-primary/5">
                  <span className="text-sm text-muted-foreground">
                    已选择 <strong className="text-foreground">{checkedIds.size}</strong> 项
                  </span>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="h-7 text-xs gap-1"
                    onClick={() => setBatchDeleteOpen(true)}
                  >
                    <Trash2 className="size-3" />
                    删除选中
                  </Button>
                </div>
              )}

              {/* Chapter list content */}
              <ScrollArea className="flex-1">
                {loadingChapters ? (
                  <div className="p-4 space-y-2">
                    {Array.from({ length: 5 }).map((_, i) => (
                      <Skeleton key={i} className="h-12 w-full" />
                    ))}
                  </div>
                ) : chapters.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                    <FileText className="size-12 mb-3 opacity-30" />
                    <p className="text-sm font-medium">暂无章节</p>
                    <p className="text-xs mt-1">点击"新建章节"开始创作</p>
                  </div>
                ) : filteredChapters.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                    <Search className="size-10 mb-3 opacity-30" />
                    <p className="text-sm font-medium">未找到匹配的章节</p>
                    <button
                      className="text-xs mt-2 text-primary hover:underline"
                      onClick={() => { setChapterSearch(''); setContentFilter('all'); }}
                    >
                      清除筛选条件
                    </button>
                  </div>
                ) : (
                  <DndContext
                    sensors={batchMode || chapterSearch || contentFilter !== 'all' ? [] : sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={batchMode || chapterSearch || contentFilter !== 'all' ? undefined : handleDragEnd}
                  >
                    <SortableContext
                      items={filteredChapters.map((c) => c.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      <Table>
                        <TableHeader>
                          <TableRow className="hover:bg-transparent">
                            <TableHead className="w-10">
                              {batchMode && (
                                <Checkbox
                                  checked={isAllChecked ? true : isSomeChecked ? 'indeterminate' : false}
                                  onCheckedChange={toggleCheckAll}
                                  aria-label="全选"
                                  className="data-[state=checked]:bg-primary data-[state=checked]:border-primary"
                                />
                              )}
                            </TableHead>
                            <TableHead className="w-16 text-center">序号</TableHead>
                            <TableHead>标题</TableHead>
                            <TableHead className="w-24">字数</TableHead>
                            <TableHead className="w-40">更新时间</TableHead>
                            <TableHead className="w-32 text-right">操作</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {filteredChapters.map((chapter, index) => (
                            <SortableChapterRow
                              key={chapter.id}
                              chapter={chapter}
                              index={index}
                              onEdit={handleEditChapter}
                              onDelete={handleDeleteChapterClick}
                              onRead={handleReadChapter}
                              onSelect={setSelectedChapter}
                              isSelected={selectedChapter?.id === chapter.id}
                              isChecked={checkedIds.has(chapter.id)}
                              onCheckChange={(checked) => toggleCheck(chapter.id, checked)}
                              isBatchMode={batchMode}
                            />
                          ))}
                        </TableBody>
                      </Table>
                    </SortableContext>
                  </DndContext>
                )}
              </ScrollArea>

              {/* Bottom reorder buttons */}
              {selectedChapter && chapters.length > 1 && (
                <div className="flex items-center justify-center gap-2 px-4 py-2 border-t bg-muted/30">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => handleMoveChapter(selectedChapter.id, 'up')}
                    disabled={chapters[0]?.id === selectedChapter.id || reordering}
                  >
                    <ChevronUp className="size-3.5" />
                    上移
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => handleMoveChapter(selectedChapter.id, 'down')}
                    disabled={chapters[chapters.length - 1]?.id === selectedChapter.id || reordering}
                  >
                    <ChevronDown className="size-3.5" />
                    下移
                  </Button>
                </div>
              )}
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