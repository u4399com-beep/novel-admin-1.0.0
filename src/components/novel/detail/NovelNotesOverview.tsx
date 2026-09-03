'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { Star, AlertCircle, ExternalLink } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { ErrorBoundary } from '@/components/ErrorBoundary';

interface NovelNoteEntry {
  chapterId: string;
  chapterIndex: number;
  chapterTitle: string;
  content: string;
  rating: number | null;
  updatedAt: string;
}

interface NovelNotesData {
  notes: NovelNoteEntry[];
}

interface NovelNotesOverviewProps {
  novelId: string;
  sessionId: string;
  onOpenReader: (index: number) => void;
  chapters: Array<{ id: string; sortOrder: number }>;
}

function formatNoteTime(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function StarRating({ rating, size = 'sm' }: { rating: number | null; size?: 'sm' | 'xs' }) {
  const cls = size === 'xs' ? 'h-3 w-3' : 'h-3.5 w-3.5';
  return (
    <span className="inline-flex items-center gap-px">
      {[1, 2, 3, 4, 5].map((s) => (
        <Star
          key={s}
          className={`${cls} ${
            (rating ?? 0) >= s
              ? 'text-amber-400 fill-amber-400'
              : 'text-muted-foreground/20'
          }`}
        />
      ))}
    </span>
  );
}

function NotesSkeleton() {
  return (
    <div className="space-y-3 animate-pulse">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="space-y-2">
          <div className="h-3.5 w-2/5 rounded bg-muted" />
          <div className="h-3 w-4/5 rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

function NotesError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 py-6 text-center">
      <AlertCircle className="h-5 w-5 text-muted-foreground" />
      <p className="text-xs text-muted-foreground">加载笔记失败</p>
      <button
        type="button"
        onClick={onRetry}
        className="text-xs text-primary hover:underline"
      >
        重试
      </button>
    </div>
  );
}

function NovelNotesOverviewInner({ novelId, sessionId, onOpenReader, chapters }: NovelNotesOverviewProps) {
  const [data, setData] = useState<NovelNotesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const handleRetry = useCallback(() => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    setError(false);
    apiFetch<NovelNotesData>(
      `/api/novels/${novelId}/notes?sessionId=${encodeURIComponent(sessionId)}`,
      { silent: true, signal: ac.signal },
    )
      .then((res) => setData(res))
      .catch(() => { if (!ac.signal.aborted) setError(true); })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
  }, [novelId, sessionId]);

  useEffect(() => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    apiFetch<NovelNotesData>(
      `/api/novels/${novelId}/notes?sessionId=${encodeURIComponent(sessionId)}`,
      { silent: true, signal: ac.signal },
    )
      .then((res) => setData(res))
      .catch(() => { if (!ac.signal.aborted) setError(true); })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => abortRef.current?.abort();
  }, [novelId, sessionId]);

  // Compute average rating
  const ratedNotes = data?.notes.filter((n) => n.rating != null) ?? [];
  const avgRating = ratedNotes.length > 0
    ? ratedNotes.reduce((sum, n) => sum + (n.rating ?? 0), 0) / ratedNotes.length
    : null;

  // Find chapter index from chapterId
  const findChapterIdx = useCallback((chapterId: string) => {
    const idx = chapters.findIndex((c) => c.id === chapterId);
    return idx >= 0 ? idx : 0;
  }, [chapters]);

  if (loading) return <NotesSkeleton />;
  if (error) return <NotesError onRetry={handleRetry} />;
  if (!data || data.notes.length === 0) return null;

  return (
    <div>
      {/* Average rating */}
      {avgRating !== null && (
        <div className="flex items-center gap-2 mb-4 pb-3 border-b">
          <span className="text-sm font-medium">平均评分</span>
          <StarRating rating={Math.round(avgRating)} size="sm" />
          <span className="text-sm text-muted-foreground">{avgRating.toFixed(1)}</span>
          <span className="text-xs text-muted-foreground/60">({ratedNotes.length}个评分)</span>
        </div>
      )}

      {/* Notes list */}
      <div className="space-y-3 max-h-96 overflow-y-auto pr-1 custom-scrollbar">
        {data.notes.map((note, idx) => (
          <motion.div
            key={note.chapterId}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: idx * 0.04, duration: 0.25 }}
            className="rounded-lg border border-border/50 p-3 hover:bg-muted/30 transition-colors"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-medium truncate">
                    第{note.chapterIndex}章 {note.chapterTitle}
                  </span>
                </div>
                {note.rating && (
                  <div className="mb-1.5">
                    <StarRating rating={note.rating} size="xs" />
                  </div>
                )}
                {note.content && (
                  <p className="text-xs text-muted-foreground line-clamp-2">
                    {note.content.length > 100
                      ? `${note.content.slice(0, 100)}...`
                      : note.content}
                  </p>
                )}
                <span className="text-[10px] text-muted-foreground/50 mt-1.5 block">
                  {formatNoteTime(note.updatedAt)}
                </span>
              </div>
              <button
                type="button"
                onClick={() => onOpenReader(findChapterIdx(note.chapterId))}
                className="shrink-0 flex items-center gap-1 text-xs text-primary hover:underline"
              >
                查看全部
                <ExternalLink className="h-3 w-3" />
              </button>
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

export function NovelNotesOverview(props: NovelNotesOverviewProps) {
  return (
    <ErrorBoundary name="NovelNotesOverview">
      <NovelNotesOverviewInner {...props} />
    </ErrorBoundary>
  );
}
