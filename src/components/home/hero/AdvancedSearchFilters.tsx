'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { SlidersHorizontal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// ─── Types ──────────────────────────────────────────────────────────
export interface AdvancedFilters {
  categorySlug: string;
  status: string;
  wordCountRange: string;
  sortBy: string;
  minChapters: string;
}

const DEFAULT_FILTERS: AdvancedFilters = {
  categorySlug: '',
  status: '',
  wordCountRange: '',
  sortBy: '',
  minChapters: '',
};

// ─── Component ──────────────────────────────────────────────────────
export function AdvancedSearchFilters({
  categories,
  filters,
  onFiltersChange,
  open,
  onToggle,
}: {
  categories: { slug: string; name: string }[];
  filters: AdvancedFilters;
  onFiltersChange: (filters: AdvancedFilters) => void;
  open: boolean;
  onToggle: () => void;
}) {
  const hasActiveFilter = Object.values(filters).some((v) => v !== '');

  const updateFilter = useCallback(<K extends keyof AdvancedFilters>(key: K, value: AdvancedFilters[K]) => {
    onFiltersChange({ ...filters, [key]: value });
  }, [filters, onFiltersChange]);

  const resetFilters = useCallback(() => {
    onFiltersChange(DEFAULT_FILTERS);
  }, [onFiltersChange]);

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="sm"
        onClick={onToggle}
        className="gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <SlidersHorizontal className="h-3.5 w-3.5" />
        高级筛选
        {hasActiveFilter && (
          <span className="h-1.5 w-1.5 rounded-full bg-primary" />
        )}
      </Button>

      {open && (
        <div className="absolute top-full right-0 mt-2 z-50 w-72 rounded-lg border bg-popover shadow-lg search-filter-panel p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">高级筛选</span>
            <button
              onClick={onToggle}
              className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground/50 hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </div>

          {/* Category */}
          <div className="space-y-1.5">
            <Label className="text-xs">分类</Label>
            <Select value={filters.categorySlug} onValueChange={(v) => updateFilter('categorySlug', v)}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="全部分类" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">全部分类</SelectItem>
                {categories.map((cat) => (
                  <SelectItem key={cat.slug} value={cat.slug}>{cat.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Status */}
          <div className="space-y-1.5">
            <Label className="text-xs">状态</Label>
            <Select value={filters.status} onValueChange={(v) => updateFilter('status', v)}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="全部状态" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">全部</SelectItem>
                <SelectItem value="ongoing">连载中</SelectItem>
                <SelectItem value="completed">已完结</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Word count range */}
          <div className="space-y-1.5">
            <Label className="text-xs">字数范围</Label>
            <Select value={filters.wordCountRange} onValueChange={(v) => updateFilter('wordCountRange', v)}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="不限" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">不限</SelectItem>
                <SelectItem value="under_30w">30万字以下</SelectItem>
                <SelectItem value="30w_50w">30-50万字</SelectItem>
                <SelectItem value="50w_100w">50-100万字</SelectItem>
                <SelectItem value="100w_200w">100-200万字</SelectItem>
                <SelectItem value="over_200w">200万字以上</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Min chapters */}
          <div className="space-y-1.5">
            <Label className="text-xs">最少章数</Label>
            <Input
              type="number"
              min={0}
              placeholder="不限"
              value={filters.minChapters}
              onChange={(e) => updateFilter('minChapters', e.target.value)}
              className="h-8 text-xs"
            />
          </div>

          {/* Sort */}
          <div className="space-y-1.5">
            <Label className="text-xs">排序</Label>
            <Select value={filters.sortBy} onValueChange={(v) => updateFilter('sortBy', v)}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="默认" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">默认</SelectItem>
                <SelectItem value="last_update">最近更新</SelectItem>
                <SelectItem value="new_entry">新书入库</SelectItem>
                <SelectItem value="weekly_click">周点击</SelectItem>
                <SelectItem value="monthly_click">月点击</SelectItem>
                <SelectItem value="favorites">收藏数</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Reset */}
          {hasActiveFilter && (
            <Button
              variant="ghost"
              size="sm"
              onClick={resetFilters}
              className="w-full text-xs text-muted-foreground hover:text-foreground"
            >
              重置筛选
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
