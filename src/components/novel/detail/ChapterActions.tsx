'use client';

import { Plus, Search, X, Check, XCircle, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';

export type ContentFilter = 'all' | 'has-content' | 'no-content';

const CONTENT_FILTER_OPTIONS: { key: ContentFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'has-content', label: '有内容' },
  { key: 'no-content', label: '无内容' },
];

export interface ChapterActionsProps {
  chaptersLength: number;
  filteredChaptersLength: number;
  batchMode: boolean;
  chapterSearch: string;
  contentFilter: ContentFilter;
  checkedIdsCount: number;
  onToggleBatchMode: () => void;
  onNewChapter: () => void;
  onSearchChange: (value: string) => void;
  onClearSearch: () => void;
  onContentFilterChange: (filter: ContentFilter) => void;
  onBatchDelete: () => void;
}

export function ChapterActions({
  chaptersLength,
  filteredChaptersLength,
  batchMode,
  chapterSearch,
  contentFilter,
  checkedIdsCount,
  onToggleBatchMode,
  onNewChapter,
  onSearchChange,
  onClearSearch,
  onContentFilterChange,
  onBatchDelete,
}: ChapterActionsProps) {
  return (
    <>
      {/* Chapter list header */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/30">
        <h2 className="text-base font-semibold flex items-center gap-2">
          章节列表
          {chaptersLength > 0 && (
            <Badge variant="secondary" className="text-xs">
              {filteredChaptersLength === chaptersLength
                ? chaptersLength
                : `${filteredChaptersLength}/${chaptersLength}`}
            </Badge>
          )}
        </h2>
        <div className="flex items-center gap-1.5">
          <Button
            variant={batchMode ? 'default' : 'outline'}
            size="sm"
            aria-label="批量操作"
            className="h-7 text-xs gap-1 hover-scale"
            onClick={onToggleBatchMode}
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
          <Button size="sm" aria-label="新建章节" onClick={onNewChapter} className="hover-scale">
            <Plus className="size-4" />
            新建章节
          </Button>
        </div>
      </div>

      {/* Search & filter bar */}
      {chaptersLength > 0 && (
        <div className="flex items-center gap-2 px-4 py-2 border-b bg-background">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input
              value={chapterSearch}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="搜索章节标题..."
              className="h-8 pl-8 text-sm focus-ring-bright"
            />
            {chapterSearch && (
              <button
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={onClearSearch}
                aria-label="清除搜索"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <div className="flex items-center gap-0.5 rounded-md border bg-background p-0.5" role="tablist" aria-label="内容筛选">
            {CONTENT_FILTER_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                role="tab"
                aria-selected={contentFilter === opt.key}
                onClick={() => onContentFilterChange(opt.key)}
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
      {batchMode && checkedIdsCount > 0 && (
        <div className="flex items-center justify-between px-4 py-2 border-b bg-primary/5">
          <span className="text-sm text-muted-foreground">
            已选择 <strong className="text-foreground">{checkedIdsCount}</strong> 项
          </span>
          <Button
            variant="destructive"
            size="sm"
            className="h-7 text-xs gap-1"
            onClick={onBatchDelete}
          >
            <Trash2 className="size-3" />
            删除选中
          </Button>
        </div>
      )}
    </>
  );
}
