'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { BookOpen, Clock, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api-fetch';
import { formatRelativeTime } from '@/lib/format';

// ─── Types ────────────────────────────────────────────────────────────────
interface ReadingHistoryPanelProps {
  sessionId: string;
}

interface HistoryItem {
  id: string;
  novelId: string;
  novelTitle: string;
  chapterTitle: string | null;
  readAt: string;
}

interface HistoryResponse {
  items: HistoryItem[];
  total: number;
}

// ─── Component ────────────────────────────────────────────────────────────
export function ReadingHistoryPanel({ sessionId }: ReadingHistoryPanelProps) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!sessionId) return;

    const controller = new AbortController();

    apiFetch<HistoryResponse>(`/api/public/reading-history?sessionId=${encodeURIComponent(sessionId)}&limit=10`, {
      signal: controller.signal,
    })
      .then((data) => {
        if (!controller.signal.aborted) {
          queueMicrotask(() => setItems(data.items));
        }
      })
      .catch(() => {
        // Silently fail – history is non-critical
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          queueMicrotask(() => setLoading(false));
        }
      });

    return () => { controller.abort(); };
  }, [sessionId]);

  return (
    <Card className="card-subtle">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <BookOpen className="h-4 w-4 text-muted-foreground" />
          阅读历史
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-8 w-8 rounded-lg" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-28" />
                  <Skeleton className="h-3 w-20" />
                </div>
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-sm text-muted-foreground">
            <Clock className="mb-2 h-8 w-8 opacity-30" />
            <span>暂无阅读记录</span>
          </div>
        ) : (
          <ScrollArea className="max-h-80 overflow-y-auto scrollbar-compact">
            <div className="space-y-0.5">
              {items.map((item) => (
                <Link
                  key={item.id}
                  href={`/novels/${item.novelId}`}
                  className="history-item list-hover-highlight"
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/60">
                    <BookOpen className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{item.novelTitle}</p>
                    {item.chapterTitle && (
                      <p className="truncate text-xs text-muted-foreground">{item.chapterTitle}</p>
                    )}
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatRelativeTime(item.readAt)}
                  </span>
                </Link>
              ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
