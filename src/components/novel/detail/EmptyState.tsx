'use client';

import { FileText, Search, PlusCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface EmptyStateProps {
  type: 'no-chapters' | 'no-results';
  onClearFilters?: () => void;
}

export function EmptyState({ type, onClearFilters }: EmptyStateProps) {
  if (type === 'no-chapters') {
    return (
      <div className="flex flex-col items-center justify-center py-16 animate-fade-in">
        {/* SVG illustration: open book with pages */}
        <svg width="64" height="64" viewBox="0 0 64 64" fill="none" className="text-muted-foreground/25 mb-4">
          <path d="M8 12 Q8 8 12 8 L28 8 Q32 8 32 12 L32 52 Q32 48 28 48 L12 48 Q8 48 8 52 Z" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <path d="M56 12 Q56 8 52 8 L36 8 Q32 8 32 12 L32 52 Q32 48 36 48 L52 48 Q56 48 56 52 Z" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <line x1="32" y1="12" x2="32" y2="48" stroke="currentColor" strokeWidth="1.5" />
          {/* Animated sparkle */}
          <circle cx="50" cy="10" r="2" fill="currentColor" className="status-dot-pulse" opacity="0.5" />
        </svg>
        <p className="text-sm font-medium text-foreground">暂无章节</p>
        <p className="text-xs text-muted-foreground mt-1">点击"新建章节"开始创作，或使用采集规则自动获取</p>
        <Button variant="outline" size="sm" className="mt-3 gap-1.5">
          <PlusCircle className="h-3.5 w-3.5" />
          新建章节
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center py-12 animate-fade-in">
      <svg width="48" height="48" viewBox="0 0 48 48" fill="none" className="text-muted-foreground/25 mb-3">
        <circle cx="20" cy="20" r="12" stroke="currentColor" strokeWidth="2" fill="none" />
        <line x1="28.5" y1="28.5" x2="40" y2="40" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        <line x1="14" y1="20" x2="26" y2="20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.5" />
      </svg>
      <p className="text-sm font-medium text-foreground">未找到匹配的章节</p>
      {onClearFilters && (
        <Button
          variant="link"
          size="sm"
          className="mt-2 gap-1.5"
          onClick={onClearFilters}
        >
          清除筛选条件
        </Button>
      )}
    </div>
  );
}
