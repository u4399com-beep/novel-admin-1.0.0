'use client';

import { ArrowLeft, User, BookOpen, FileText, Type, Clock, Pencil, Trash2, Download, Loader2 } from 'lucide-react';
import { safeFormatDate } from '@/lib/format';
import { format } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { NOVEL_STATUS_MAP } from '@/lib/constants';
import type { Novel } from '@/types';

export interface NovelHeaderProps {
  novel: Novel;
  chapterCount: number;
  totalWords: number;
  exporting: boolean;
  onBack: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onExport: () => void;
}

export function NovelHeader({
  novel,
  chapterCount,
  totalWords,
  exporting,
  onBack,
  onEdit,
  onDelete,
  onExport,
}: NovelHeaderProps) {
  const statusInfo = NOVEL_STATUS_MAP[novel.status] || NOVEL_STATUS_MAP.ongoing;

  return (
    <div className="p-6 pb-0">
      {/* Back button */}
      <Button
        variant="ghost"
        size="sm"
        className="mb-4 -ml-2 text-muted-foreground"
        onClick={onBack}
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
                  <Button variant="outline" size="sm" disabled={exporting} onClick={onExport}>
                    {exporting ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                    {exporting ? '导出中...' : '导出'}
                  </Button>
                  <Button variant="outline" size="sm" onClick={onEdit}>
                    <Pencil className="size-3.5" />
                    编辑小说
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={onDelete}
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
  );
}
