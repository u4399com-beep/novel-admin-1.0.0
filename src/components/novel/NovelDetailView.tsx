'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
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
  Loader2,
  Save,
  X,
  Type,
  Clock,
  CheckCircle2,
} from 'lucide-react';
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
import type { Novel, Chapter } from '@/types';

// ─── Status map ───────────────────────────────────────────────────────────────
const statusMap: Record<string, { label: string; className: string }> = {
  ongoing: { label: '连载中', className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400' },
  completed: { label: '已完结', className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400' },
  hiatus: { label: '暂停', className: 'bg-slate-100 text-slate-600 dark:bg-slate-800/40 dark:text-slate-400' },
};

// ─── Sortable row ─────────────────────────────────────────────────────────────
function SortableChapterRow({
  chapter,
  index,
  onEdit,
  onDelete,
  onSelect,
  isSelected,
}: {
  chapter: Chapter;
  index: number;
  onEdit: (ch: Chapter) => void;
  onDelete: (ch: Chapter) => void;
  onSelect: (ch: Chapter) => void;
  isSelected: boolean;
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
      } group cursor-pointer`}
      onClick={() => onSelect(chapter)}
    >
      <TableCell className="w-10">
        <button
          className="cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground p-0.5"
          {...attributes}
          {...listeners}
          onClick={(e) => e.stopPropagation()}
        >
          <GripVertical className="size-4" />
        </button>
      </TableCell>
      <TableCell className="w-16 text-center text-muted-foreground font-mono text-sm">
        {index + 1}
      </TableCell>
      <TableCell
        className="font-medium max-w-[240px] truncate cursor-pointer hover:text-primary transition-colors"
        onClick={() => onSelect(chapter)}
      >
        {chapter.title}
      </TableCell>
      <TableCell className="w-24 text-muted-foreground tabular-nums text-sm">
        {(chapter.wordCount ?? 0).toLocaleString()}
      </TableCell>
      <TableCell className="w-40 text-muted-foreground text-sm">
        {format(new Date(chapter.updatedAt), 'yyyy-MM-dd HH:mm', { locale: zhCN })}
      </TableCell>
      <TableCell className="w-24 text-right">
        <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
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
  onSaved: () => void;
}) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialLoadRef = useRef(false);

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
    const loadChapter = async () => {
      try {
        const res = await fetch(`/api/chapters/${chapter.id}`);
        if (res.ok) {
          const data = await res.json();
          setTitle(data.title);
          setContent(data.content || '');
          initialLoadRef.current = true;
        }
      } catch {
        toast.error('加载章节内容失败');
      }
    };

    loadChapter();
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
        const res = await fetch(`/api/chapters/${chapter.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: newTitle,
            content: newContent,
            wordCount,
          }),
        });

        if (!res.ok) throw new Error('保存失败');

        setSaveStatus('saved');
        setTimeout(() => setSaveStatus('idle'), 2000);
        onSaved();
      } catch {
        toast.error('自动保存失败');
        setSaveStatus('idle');
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [chapter, onSaved],
  );

  // Auto-save on content change
  useEffect(() => {
    if (!chapter || !initialLoadRef.current) return;

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
            onChange={(e) => setTitle(e.target.value)}
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
              <span className="tabular-nums">{wordCount.toLocaleString()} 字</span>
            )}
          </div>
          <Separator orientation="vertical" className="h-4" />
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
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
          onChange={(e) => setContent(e.target.value)}
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

// ─── Main component ───────────────────────────────────────────────────────────
export default function NovelDetailView() {
  const {
    selectedNovelId,
    selectNovel,
    setCurrentView,
    setEditingNovel,
    setNovelFormOpen,
    setChapterFormOpen,
    setEditingChapter,
    triggerRefreshChapters,
    triggerRefreshNovels,
    triggerRefreshDashboard,
    refreshChapters,
    refreshNovels,
  } = useAppStore();

  const [novel, setNovel] = useState<Novel | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [loadingNovel, setLoadingNovel] = useState(true);
  const [loadingChapters, setLoadingChapters] = useState(true);
  const [deleteNovelOpen, setDeleteNovelOpen] = useState(false);
  const [deleteChapterOpen, setDeleteChapterOpen] = useState(false);
  const [deletingChapter, setDeletingChapter] = useState<Chapter | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [selectedChapter, setSelectedChapter] = useState<Chapter | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

  // Fetch novel details
  const fetchNovel = useCallback(async () => {
    if (!selectedNovelId) return;
    setLoadingNovel(true);
    try {
      const res = await fetch(`/api/novels/${selectedNovelId}`);
      if (res.ok) {
        const data = await res.json();
        setNovel(data);
      } else {
        toast.error('小说不存在或已被删除');
        setCurrentView('novels');
      }
    } catch {
      toast.error('获取小说详情失败');
    } finally {
      setLoadingNovel(false);
    }
  }, [selectedNovelId, setCurrentView]);

  // Fetch chapters
  const fetchChapters = useCallback(async () => {
    if (!selectedNovelId) return;
    setLoadingChapters(true);
    try {
      const res = await fetch(`/api/novels/${selectedNovelId}/chapters`);
      if (res.ok) {
        const data = await res.json();
        setChapters(data);
      }
    } catch {
      toast.error('获取章节列表失败');
    } finally {
      setLoadingChapters(false);
    }
  }, [selectedNovelId]);

  useEffect(() => {
    fetchNovel();
  }, [fetchNovel, refreshNovels]);

  useEffect(() => {
    fetchChapters();
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

  const handleDeleteNovel = async () => {
    if (!novel) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/novels/${novel.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || '删除失败');
      }
      toast.success('小说已删除');
      triggerRefreshNovels();
      triggerRefreshDashboard();
      setCurrentView('novels');
      selectNovel(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除小说失败');
    } finally {
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

  const handleDeleteChapterClick = (ch: Chapter) => {
    setDeletingChapter(ch);
    setDeleteChapterOpen(true);
  };

  const handleDeleteChapter = async () => {
    if (!deletingChapter) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/chapters/${deletingChapter.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || '删除失败');
      }
      toast.success('章节已删除');
      if (selectedChapter?.id === deletingChapter.id) {
        setSelectedChapter(null);
      }
      triggerRefreshChapters();
      triggerRefreshNovels();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除章节失败');
    } finally {
      setDeleting(false);
      setDeleteChapterOpen(false);
      setDeletingChapter(null);
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = chapters.findIndex((c) => c.id === active.id);
    const newIndex = chapters.findIndex((c) => c.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(chapters, oldIndex, newIndex);
    setChapters(reordered);

    // Update sort orders
    try {
      await Promise.all(
        reordered.map((ch, idx) =>
          fetch(`/api/chapters/${ch.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sortOrder: idx + 1 }),
          }),
        ),
      );
    } catch {
      toast.error('排序更新失败');
      fetchChapters();
    }
  };

  const handleMoveChapter = async (chapterId: string, direction: 'up' | 'down') => {
    const idx = chapters.findIndex((c) => c.id === chapterId);
    if (idx === -1) return;
    if (direction === 'up' && idx === 0) return;
    if (direction === 'down' && idx === chapters.length - 1) return;

    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    const reordered = arrayMove(chapters, idx, swapIdx);
    setChapters(reordered);

    try {
      await Promise.all(
        reordered.map((ch, i) =>
          fetch(`/api/chapters/${ch.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sortOrder: i + 1 }),
          }),
        ),
      );
    } catch {
      toast.error('排序更新失败');
      fetchChapters();
    }
  };

  const handleChapterSaved = () => {
    triggerRefreshChapters();
    fetchNovel(); // refresh novel stats (word count)
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

  if (!novel) return null;

  const statusInfo = statusMap[novel.status] || statusMap.ongoing;
  const totalWords = chapters.reduce((sum, ch) => sum + (ch.wordCount ?? 0), 0);
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
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            <div className="flex flex-col sm:flex-row gap-6 p-6">
              {/* Cover */}
              <div className="shrink-0">
                {novel.coverUrl ? (
                  <img
                    src={novel.coverUrl}
                    alt={novel.title}
                    className="w-36 h-48 sm:w-40 sm:h-52 object-cover rounded-lg shadow-md"
                  />
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
                  {novel.tags.map(({ tag }) => (
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
                    创建: {format(new Date(novel.createdAt), 'yyyy-MM-dd HH:mm', { locale: zhCN })}
                  </div>
                  <div className="flex items-center gap-1">
                    更新: {format(new Date(novel.updatedAt), 'yyyy-MM-dd HH:mm', { locale: zhCN })}
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ─── Chapters section with resizable panels ───────────────────── */}
      <div className="flex-1 overflow-hidden p-6 pt-4">
        <ResizablePanelGroup direction="horizontal" className="h-full rounded-lg border">
          {/* Left panel: Chapter list */}
          <ResizablePanel defaultSize={selectedChapter ? 45 : 100} minSize={30}>
            <div className="flex flex-col h-full">
              {/* Chapter list header */}
              <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/30">
                <h2 className="text-base font-semibold flex items-center gap-2">
                  章节列表
                  {chapters.length > 0 && (
                    <Badge variant="secondary" className="text-xs">
                      {chapters.length}
                    </Badge>
                  )}
                </h2>
                <Button size="sm" onClick={handleNewChapter}>
                  <Plus className="size-4" />
                  新建章节
                </Button>
              </div>

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
                ) : (
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleDragEnd}
                  >
                    <SortableContext
                      items={chapters.map((c) => c.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      <Table>
                        <TableHeader>
                          <TableRow className="hover:bg-transparent">
                            <TableHead className="w-10" />
                            <TableHead className="w-16 text-center">序号</TableHead>
                            <TableHead>标题</TableHead>
                            <TableHead className="w-24">字数</TableHead>
                            <TableHead className="w-40">更新时间</TableHead>
                            <TableHead className="w-24 text-right">操作</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {chapters.map((chapter, index) => (
                            <SortableChapterRow
                              key={chapter.id}
                              chapter={chapter}
                              index={index}
                              onEdit={handleEditChapter}
                              onDelete={handleDeleteChapterClick}
                              onSelect={setSelectedChapter}
                              isSelected={selectedChapter?.id === chapter.id}
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
                    disabled={chapters[0]?.id === selectedChapter.id}
                  >
                    <ChevronUp className="size-3.5" />
                    上移
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => handleMoveChapter(selectedChapter.id, 'down')}
                    disabled={chapters[chapters.length - 1]?.id === selectedChapter.id}
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
                <ChapterEditorPanel
                  key={selectedChapter.id}
                  chapter={selectedChapter}
                  onClose={() => setSelectedChapter(null)}
                  onSaved={handleChapterSaved}
                />
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </div>

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
              onClick={handleDeleteNovel}
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
              onClick={handleDeleteChapter}
              disabled={deleting}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {deleting && <Loader2 className="size-4 animate-spin" />}
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}