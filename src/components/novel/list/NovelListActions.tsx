'use client';

import { BookMarked, ChevronLeft, ChevronRight, Trash2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';

interface NovelListPaginationProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}

export function NovelListPagination({ page, totalPages, onPageChange }: NovelListPaginationProps) {
  const getPageNumbers = () => {
    const pages: (number | '...')[] = [];
    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      pages.push(1);
      if (page > 3) pages.push('...');
      const start = Math.max(2, page - 1);
      const end = Math.min(totalPages - 1, page + 1);
      for (let i = start; i <= end; i++) pages.push(i);
      if (page < totalPages - 2) pages.push('...');
      pages.push(totalPages);
    }
    return pages;
  };

  return (
    <div className="flex items-center justify-center gap-1.5 pt-2">
      <Button variant="outline" size="icon" className="h-8 w-8" disabled={page <= 1} aria-label="上一页" onClick={() => onPageChange(page - 1)}>
        <ChevronLeft className="h-4 w-4" />
      </Button>
      {getPageNumbers().map((p, i) =>
        p === '...' ? (
          <span key={`dots-${i}`} className="px-1 text-sm text-muted-foreground">...</span>
        ) : (
          <Button key={p} variant={page === p ? 'default' : 'outline'} size="icon" className="h-8 w-8" onClick={() => onPageChange(p)} aria-label={`第${p}页`}>
            {p}
          </Button>
        ),
      )}
      <Button variant="outline" size="icon" className="h-8 w-8" disabled={page >= totalPages} aria-label="下一页" onClick={() => onPageChange(page + 1)}>
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}

interface NovelListLoadingSkeletonProps {
  viewMode: 'grid' | 'list';
}

export function NovelListLoadingSkeleton({ viewMode }: NovelListLoadingSkeletonProps) {
  if (viewMode === 'list') {
    return (
      <div className="rounded-lg border">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 py-3 px-3">
            <Skeleton className="h-4 w-4" />
            <Skeleton className="h-10 w-8 rounded" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-5 w-14" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <Card key={i} className="overflow-hidden">
          <Skeleton className="h-40 w-full" />
          <CardContent className="space-y-3 p-4">
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <div className="flex gap-2">
              <Skeleton className="h-5 w-14" />
              <Skeleton className="h-5 w-14" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

interface NovelListEmptyStateProps {
  hasFilter: boolean;
}

export function NovelListEmptyState({ hasFilter }: NovelListEmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed py-20">
      <BookMarked className="h-12 w-12 text-muted-foreground/50" />
      {hasFilter ? (
        <p className="mt-4 text-sm text-muted-foreground">没有找到匹配的小说</p>
      ) : (
        <>
          <p className="mt-4 text-base font-medium text-foreground">还没有小说</p>
          <p className="mt-1 text-sm text-muted-foreground">点击顶部「新建小说」开始添加你的第一部作品</p>
        </>
      )}
    </div>
  );
}

interface NovelBatchActionsProps {
  selectedCount: number;
  deleting: boolean;
  batchDeleteOpen: boolean;
  onBatchDeleteOpen: (open: boolean) => void;
  onBatchDelete: () => void;
  onClearSelection: () => void;
}

export function NovelBatchActions({ selectedCount, deleting, batchDeleteOpen, onBatchDeleteOpen, onBatchDelete, onClearSelection }: NovelBatchActionsProps) {
  return (
    <>
      {selectedCount > 0 && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 flex items-center gap-3 rounded-xl border bg-background/95 px-5 py-3 shadow-2xl backdrop-blur-sm">
          <span className="text-sm font-medium">已选择 {selectedCount} 项</span>
          <Button variant="destructive" size="sm" disabled={deleting} onClick={() => onBatchDeleteOpen(true)}>
            {deleting ? (
              <span className="flex items-center gap-1.5">
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                删除中...
              </span>
            ) : (
              <span className="flex items-center gap-1.5">
                <Trash2 className="h-3.5 w-3.5" />
                批量删除
              </span>
            )}
          </Button>
          <Button variant="outline" size="sm" onClick={onClearSelection}>
            <XCircle className="mr-1.5 h-3.5 w-3.5" />
            取消选择
          </Button>
        </div>
      )}
      <ConfirmDeleteDialog
        open={batchDeleteOpen}
        onOpenChange={onBatchDeleteOpen}
        title="确认批量删除"
        description={`确定要删除选中的 ${selectedCount} 本小说吗？此操作将同时删除所有关联章节，且不可撤销。`}
        loading={deleting}
        onConfirm={onBatchDelete}
      />
    </>
  );
}
