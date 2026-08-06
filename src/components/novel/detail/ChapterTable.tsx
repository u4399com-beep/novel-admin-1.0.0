'use client';

import React from 'react';
import { BookOpen, Pencil, Trash2, GripVertical, ChevronUp, ChevronDown } from 'lucide-react';
import { safeFormatDate } from '@/lib/format';
import { format } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import {
  DndContext,
  closestCenter,
  type SensorDescriptor,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import type { Chapter } from '@/types';
import type { ContentFilter } from './ChapterActions';
import { EmptyState } from './EmptyState';

// ─── Sortable row ─────────────────────────────────────────────────────────────
const SortableChapterRow = React.memo(function SortableChapterRow({
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
      } ${isChecked ? 'bg-primary/5' : ''} group cursor-pointer list-item-compact`}
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
      <TableCell className="w-24 text-muted-foreground tabular-nums text-sm font-mono">
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
});

// ─── Chapter table ──────────────────────────────────────────────────────────
export interface ChapterTableProps {
  chapters: Chapter[];
  filteredChapters: Chapter[];
  loading: boolean;
  chapterSearch: string;
  contentFilter: ContentFilter;
  batchMode: boolean;
  selectedChapter: Chapter | null;
  checkedIds: Set<string>;
  isAllChecked: boolean;
  isSomeChecked: boolean;
  sensors: SensorDescriptor<any>[];
  onDragEnd: (event: DragEndEvent) => void;
  onEdit: (ch: Chapter) => void;
  onDelete: (ch: Chapter) => void;
  onRead: (ch: Chapter) => void;
  onSelect: (ch: Chapter) => void;
  onToggleCheckAll: () => void;
  onToggleCheck: (id: string, checked: boolean) => void;
  onMoveChapter: (id: string, direction: 'up' | 'down') => void;
  reordering: boolean;
  onClearFilters: () => void;
}

export function ChapterTable({
  chapters,
  filteredChapters,
  loading,
  chapterSearch,
  contentFilter,
  batchMode,
  selectedChapter,
  checkedIds,
  isAllChecked,
  isSomeChecked,
  sensors,
  onDragEnd,
  onEdit,
  onDelete,
  onRead,
  onSelect,
  onToggleCheckAll,
  onToggleCheck,
  onMoveChapter,
  reordering,
  onClearFilters,
}: ChapterTableProps) {
  const dndDisabled = batchMode || !!chapterSearch || contentFilter !== 'all';

  return (
    <>
      <ScrollArea className="flex-1">
        {loading ? (
          <div className="p-4 space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : chapters.length === 0 ? (
          <EmptyState type="no-chapters" />
        ) : filteredChapters.length === 0 ? (
          <EmptyState type="no-results" onClearFilters={onClearFilters} />
        ) : (
          <DndContext
            sensors={dndDisabled ? [] : sensors}
            collisionDetection={closestCenter}
            onDragEnd={dndDisabled ? undefined : onDragEnd}
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
                          onCheckedChange={onToggleCheckAll}
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
                      onEdit={onEdit}
                      onDelete={onDelete}
                      onRead={onRead}
                      onSelect={onSelect}
                      isSelected={selectedChapter?.id === chapter.id}
                      isChecked={checkedIds.has(chapter.id)}
                      onCheckChange={(checked) => onToggleCheck(chapter.id, checked)}
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
            onClick={() => onMoveChapter(selectedChapter.id, 'up')}
            disabled={chapters[0]?.id === selectedChapter.id || reordering}
          >
            <ChevronUp className="size-3.5" />
            上移
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => onMoveChapter(selectedChapter.id, 'down')}
            disabled={chapters[chapters.length - 1]?.id === selectedChapter.id || reordering}
          >
            <ChevronDown className="size-3.5" />
            下移
          </Button>
        </div>
      )}
    </>
  );
}
