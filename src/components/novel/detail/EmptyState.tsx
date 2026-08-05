'use client';

import { FileText, Search } from 'lucide-react';

export interface EmptyStateProps {
  type: 'no-chapters' | 'no-results';
  onClearFilters?: () => void;
}

export function EmptyState({ type, onClearFilters }: EmptyStateProps) {
  if (type === 'no-chapters') {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
        <FileText className="size-12 mb-3 opacity-30" />
        <p className="text-sm font-medium">暂无章节</p>
        <p className="text-xs mt-1">点击"新建章节"开始创作</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
      <Search className="size-10 mb-3 opacity-30" />
      <p className="text-sm font-medium">未找到匹配的章节</p>
      {onClearFilters && (
        <button
          className="text-xs mt-2 text-primary hover:underline"
          onClick={onClearFilters}
        >
          清除筛选条件
        </button>
      )}
    </div>
  );
}
