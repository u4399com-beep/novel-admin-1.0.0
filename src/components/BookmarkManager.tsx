'use client';

import { useMemo } from 'react';
import { BookmarkCheck, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';

// ─── Types ───────────────────────────────────────────────────────────

interface BookmarkEntry {
  chapterIndex: number;
  chapterTitle: string;
  timestamp: number;
  scrollPercent: number;
}

interface BookmarkManagerProps {
  bookmarks: BookmarkEntry[];
  chapters: { id: string; title: string; sortOrder: number }[];
  onJump: (index: number) => void;
  onRemove: (chapterIndex: number) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function formatTime(ts: number): string {
  const d = new Date(ts);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hour = String(d.getHours()).padStart(2, '0');
  const minute = String(d.getMinutes()).padStart(2, '0');
  return `${month}-${day} ${hour}:${minute}`;
}

// ─── Main Component ─────────────────────────────────────────────────

export function BookmarkManager({
  bookmarks,
  chapters,
  onJump,
  onRemove,
  open,
  onOpenChange,
}: BookmarkManagerProps) {
  // Sort bookmarks by timestamp descending (most recent first)
  const sorted = useMemo(
    () => [...bookmarks].sort((a, b) => b.timestamp - a.timestamp),
    [bookmarks]
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookmarkCheck className="h-4.5 w-4.5 text-amber-500" />
            书签管理
            {bookmarks.length > 0 && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                {bookmarks.length}
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        {sorted.length === 0 ? (
          <div className="py-12 text-center">
            <BookmarkCheck className="mx-auto h-10 w-10 text-muted-foreground/30" />
            <p className="mt-3 text-sm text-muted-foreground">暂无书签</p>
            <p className="mt-1 text-xs text-muted-foreground/60">
              在阅读器中点击书签按钮添加
            </p>
          </div>
        ) : (
          <ScrollArea className="max-h-96">
            <div className="space-y-1 pr-3">
              {sorted.map((bm) => {
                const chapter = chapters[bm.chapterIndex];
                const sortOrder = chapter?.sortOrder ?? bm.chapterIndex + 1;
                const title = chapter?.title ?? bm.chapterTitle;

                return (
                  <div
                    key={bm.chapterIndex}
                    className="group flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-muted/80"
                  >
                    {/* Jump area */}
                    <button
                      className="flex-1 flex items-center gap-3 min-w-0 text-left"
                      onClick={() => {
                        onJump(bm.chapterIndex);
                        onOpenChange(false);
                      }}
                    >
                      {/* Order number */}
                      <span className="text-xs text-muted-foreground tabular-nums shrink-0 w-6 text-right">
                        {sortOrder}.
                      </span>

                      {/* Chapter title */}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm truncate group-hover:text-primary transition-colors">
                          {title}
                        </p>
                        <p className="text-[10px] text-muted-foreground/50 mt-0.5">
                          {formatTime(bm.timestamp)}
                          {bm.scrollPercent > 0 && (
                            <span className="ml-2">
                              进度 {Math.round(bm.scrollPercent)}%
                            </span>
                          )}
                        </p>
                      </div>

                      {/* Bookmark icon */}
                      <BookmarkCheck className="h-3.5 w-3.5 shrink-0 text-amber-500/60" />
                    </button>

                    {/* Remove button */}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemove(bm.chapterIndex);
                      }}
                      aria-label="取消书签"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}
