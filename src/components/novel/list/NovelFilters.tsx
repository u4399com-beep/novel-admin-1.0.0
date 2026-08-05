'use client';

import { Search, X, LayoutGrid, List } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { Category } from '@/types';

interface NovelFiltersProps {
  searchInput: string;
  onSearchInputChange: (value: string) => void;
  onSearchClear: () => void;
  statusFilter: string;
  onStatusFilterChange: (value: string) => void;
  categoryFilter: string;
  onCategoryFilterChange: (value: string) => void;
  categories: Category[];
  viewMode: 'grid' | 'list';
  onViewModeChange: (mode: 'grid' | 'list') => void;
  total: number;
  loading: boolean;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
}

export function NovelFilters({
  searchInput,
  onSearchInputChange,
  onSearchClear,
  statusFilter,
  onStatusFilterChange,
  categoryFilter,
  onCategoryFilterChange,
  categories,
  viewMode,
  onViewModeChange,
  total,
  loading,
  searchInputRef,
}: NovelFiltersProps) {
  return (
    <>
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">小说列表</h2>
          {!loading && (
            <span className="text-xs text-muted-foreground">共 {total.toLocaleString()} 本</span>
          )}
        </div>

        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchInputRef}
            placeholder="搜索小说标题或作者..."
            value={searchInput}
            onChange={(e) => onSearchInputChange(e.target.value)}
            className="pl-9 pr-8 focus-ring-bright"
          />
          {searchInput && (
            <Button variant="ghost" size="icon" className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6" onClick={onSearchClear} aria-label="清除搜索">
              <X className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <Select value={statusFilter} onValueChange={onStatusFilterChange}>
          <SelectTrigger className="w-32">
            <SelectValue placeholder="状态筛选" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="ongoing">连载中</SelectItem>
            <SelectItem value="completed">已完结</SelectItem>
            <SelectItem value="hiatus">暂停</SelectItem>
          </SelectContent>
        </Select>

        <Select value={categoryFilter} onValueChange={onCategoryFilterChange}>
          <SelectTrigger className="w-32">
            <SelectValue placeholder="分类筛选" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部分类</SelectItem>
            {categories.map((cat) => (
              <SelectItem key={cat.id} value={cat.id}>
                {cat.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* View mode toggle */}
        <div className="flex items-center gap-1 rounded-lg border bg-muted p-0.5">
          <Button variant={viewMode === 'grid' ? 'secondary' : 'ghost'} size="icon" className="h-7 w-7" onClick={() => onViewModeChange('grid')} aria-label="网格视图">
            <LayoutGrid className="h-3.5 w-3.5" />
          </Button>
          <Button variant={viewMode === 'list' ? 'secondary' : 'ghost'} size="icon" className="h-7 w-7" onClick={() => onViewModeChange('list')} aria-label="列表视图">
            <List className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </>
  );
}
