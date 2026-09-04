'use client';

import { BookOpen, User, FileText, Clock, ArrowRight } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { safeFormatDate } from '@/lib/format';
import { NOVEL_STATUS_MAP } from '@/lib/constants';
import type { Novel, NovelStatus } from '@/types';

// ─── Types ────────────────────────────────────────────────────────────────
interface RecentNovelsProps {
  recentNovels: Novel[];
  loading: boolean;
  onViewNovel: (novel: Novel) => void;
}

// ─── Component ────────────────────────────────────────────────────────────
export function RecentNovels({ recentNovels, loading, onViewNovel }: RecentNovelsProps) {
  return (
    <Card className="card-subtle card-glass hover-scale">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <BookOpen className="h-5 w-5 text-muted-foreground" />
          最近更新
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-10 w-10 rounded-lg" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-20" />
                </div>
              </div>
            ))}
          </div>
        ) : !recentNovels.length ? (
          <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
            暂无小说
          </div>
        ) : (
          <div className="max-h-[280px] space-y-1 overflow-y-auto pr-1 scrollbar-custom stagger-in">
            {recentNovels.map((novel) => {
              const statusInfo = NOVEL_STATUS_MAP[novel.status as NovelStatus] ?? NOVEL_STATUS_MAP.ongoing;
              return (
                <div
                  key={novel.id}
                  className="group flex items-center gap-3 rounded-lg px-3 py-2.5 list-hover-highlight"
                >
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-slate-100 to-slate-200 dark:from-slate-800 dark:to-slate-700">
                    <BookOpen className="h-5 w-5 text-slate-500 dark:text-slate-400" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{novel.title}</p>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <User className="h-3 w-3" />
                        {novel.author}
                      </span>
                      <span className="flex items-center gap-1">
                        <FileText className="h-3 w-3" />
                        {novel._count?.chapters ?? 0} 章
                      </span>
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {safeFormatDate(novel.updatedAt, (d) => formatDistanceToNow(d, {
                          addSuffix: true,
                          locale: zhCN,
                        }))}
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant="secondary" className={`${statusInfo.className} badge-glow`}>
                      {statusInfo.label}
                    </Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="opacity-0 transition-opacity group-hover:opacity-100"
                      onClick={() => onViewNovel(novel)}
                    >
                      查看详情
                      <ArrowRight className="ml-1 h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
