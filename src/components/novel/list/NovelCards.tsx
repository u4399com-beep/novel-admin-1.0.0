'use client';

import { BookOpen, User, FileText, BookMarked, } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { safeFormatDate } from '@/lib/format';
import { hexToRgba } from '@/lib/color-utils';
import { NOVEL_STATUS_MAP } from '@/lib/constants';
import type { Novel, NovelStatus } from '@/types';

const gradients = [
  'from-rose-100 to-orange-100 dark:from-rose-900/30 dark:to-orange-900/30',
  'from-emerald-100 to-teal-100 dark:from-emerald-900/30 dark:to-teal-900/30',
  'from-violet-100 to-purple-100 dark:from-violet-900/30 dark:to-purple-900/30',
  'from-amber-100 to-yellow-100 dark:from-amber-900/30 dark:to-yellow-900/30',
  'from-sky-100 to-cyan-100 dark:from-sky-900/30 dark:to-cyan-900/30',
  'from-pink-100 to-fuchsia-100 dark:from-pink-900/30 dark:to-fuchsia-900/30',
];

interface NovelCardsProps {
  novels: Novel[];
  viewMode: 'grid' | 'list';
  selectedIds: Set<string>;
  allSelected: boolean;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  onViewNovel: (novel: Novel) => void;
}

export function NovelCards({
  novels,
  viewMode,
  selectedIds,
  allSelected,
  onToggleSelect,
  onToggleSelectAll,
  onViewNovel,
}: NovelCardsProps) {
  if (viewMode === 'list') {
    return <NovelListView novels={novels} selectedIds={selectedIds} allSelected={allSelected} onToggleSelect={onToggleSelect} onToggleSelectAll={onToggleSelectAll} onViewNovel={onViewNovel} />;
  }

  return <NovelGridView novels={novels} selectedIds={selectedIds} allSelected={allSelected} onToggleSelect={onToggleSelect} onToggleSelectAll={onToggleSelectAll} onViewNovel={onViewNovel} />;
}

function NovelGridView({ novels, selectedIds, allSelected, onToggleSelect, onToggleSelectAll, onViewNovel }: NovelCardsProps) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      <div className="col-span-full flex items-center gap-2 px-1">
        <Checkbox checked={allSelected} onCheckedChange={onToggleSelectAll} aria-label="全选" />
        <span className="text-xs text-muted-foreground">全选</span>
      </div>
      {novels.map((novel, idx) => {
        const statusInfo = NOVEL_STATUS_MAP[novel.status as NovelStatus] ?? NOVEL_STATUS_MAP.ongoing;
        const gradient = gradients[idx % gradients.length];
        return (
          <Card
            key={novel.id}
            role="article"
            tabIndex={0}
            className="group cursor-pointer overflow-hidden transition-shadow hover:shadow-md relative card-interactive"
            onClick={() => onViewNovel(novel)}
            onKeyDown={(e) => { if (e.key === 'Enter') onViewNovel(novel); }}
          >
            <div className="absolute left-2 top-2 z-10">
              <Checkbox
                checked={selectedIds.has(novel.id)}
                onCheckedChange={() => onToggleSelect(novel.id)}
                onClick={(e) => e.stopPropagation()}
                aria-label={`选择 ${novel.title}`}
                className="bg-background/80 backdrop-blur-sm border-foreground/20"
              />
            </div>
            <div className={`relative h-40 w-full bg-gradient-to-br ${gradient}`}>
              {novel.coverUrl ? (
                <img src={novel.coverUrl} alt={novel.title} className="h-full w-full object-cover" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
              ) : (
                <div className="flex h-full w-full items-center justify-center">
                  <BookOpen className="h-12 w-12 text-muted-foreground/40" />
                </div>
              )}
              <Badge variant="secondary" className={`absolute right-2 top-2 ${statusInfo.className} status-${novel.status}`}>
                {statusInfo.label}
              </Badge>
            </div>
            <CardContent className="space-y-2.5 p-4">
              <h3 className="truncate text-sm font-semibold">{novel.title}</h3>
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <User className="h-3 w-3" />
                {novel.author}
              </p>
              <div className="flex flex-wrap items-center gap-1.5">
                {novel.category && (
                  <Badge variant="outline" className="text-xs" style={{ borderColor: novel.category.color, color: novel.category.color }}>
                    {novel.category.name}
                  </Badge>
                )}
                {(novel.tags ?? []).slice(0, 3).map(({ tag }) => (
                  <Badge key={tag.id} variant="secondary" className="text-xs tag-pill-glow" style={{ backgroundColor: hexToRgba(tag.color, 0.09), color: tag.color }}>
                    {tag.name}
                  </Badge>
                ))}
              </div>
              <div className="flex items-center justify-between border-t pt-2.5 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <FileText className="h-3 w-3" />
                  {novel._count?.chapters ?? 0} 章
                </span>
                <span>
                  {safeFormatDate(novel.updatedAt, (d) => formatDistanceToNow(d, { addSuffix: true, locale: zhCN }))}
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="w-full opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                onClick={(e) => { e.stopPropagation(); onViewNovel(novel); }}
              >
                <BookMarked className="mr-1.5 h-3.5 w-3.5" />
                查看
              </Button>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function NovelListView({ novels, selectedIds, allSelected, onToggleSelect, onToggleSelectAll, onViewNovel }: NovelCardsProps) {
  return (
    <div className="divide-y rounded-lg border">
      <div className="flex items-center gap-3 px-3 py-2 bg-muted/30">
        <Checkbox checked={allSelected} onCheckedChange={onToggleSelectAll} aria-label="全选" />
        <span className="text-xs text-muted-foreground">全选</span>
      </div>
      {novels.map((novel, idx) => {
        const statusInfo = NOVEL_STATUS_MAP[novel.status as NovelStatus] ?? NOVEL_STATUS_MAP.ongoing;
        const gradient = gradients[idx % gradients.length];
        return (
          <div
            key={novel.id}
            role="article"
            tabIndex={0}
            className={`flex items-center gap-3 py-2 px-3 transition-colors hover:bg-muted/50 cursor-pointer ${selectedIds.has(novel.id) ? 'bg-primary/5' : ''}`}
            onClick={() => onViewNovel(novel)}
            onKeyDown={(e) => { if (e.key === 'Enter') onViewNovel(novel); }}
          >
            <Checkbox
              checked={selectedIds.has(novel.id)}
              onCheckedChange={() => onToggleSelect(novel.id)}
              onClick={(e) => e.stopPropagation()}
              aria-label={`选择 ${novel.title}`}
            />
            <div className={`h-10 w-8 flex-shrink-0 overflow-hidden rounded bg-gradient-to-br ${gradient}`}>
              {novel.coverUrl ? (
                <img src={novel.coverUrl} alt={novel.title} className="h-full w-full object-cover" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
              ) : (
                <div className="flex h-full w-full items-center justify-center">
                  <BookOpen className="h-4 w-4 text-muted-foreground/40" />
                </div>
              )}
            </div>
            <span className="min-w-0 flex-1 text-fade-end text-sm font-medium">{novel.title}</span>
            <span className="hidden min-w-0 flex-1 text-fade-end text-xs text-muted-foreground sm:block">{novel.author}</span>
            <Badge variant="secondary" className={`text-xs flex-shrink-0 ${statusInfo.className} status-${novel.status}`}>
              {statusInfo.label}
            </Badge>
            <span className="hidden flex-shrink-0 text-xs text-muted-foreground md:flex md:items-center md:gap-1">
              <FileText className="h-3 w-3" />
              {novel._count?.chapters ?? 0} 章
            </span>
            <span className="hidden flex-shrink-0 text-xs text-muted-foreground lg:block">
              {safeFormatDate(novel.updatedAt, (d) => formatDistanceToNow(d, { addSuffix: true, locale: zhCN }))}
            </span>
            <Button variant="ghost" size="sm" className="flex-shrink-0 text-xs" onClick={(e) => { e.stopPropagation(); onViewNovel(novel); }}>
              查看
            </Button>
          </div>
        );
      })}
    </div>
  );
}
