'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { BookOpen, AlertCircle } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { ErrorBoundary } from '@/components/ErrorBoundary';

interface TimelineEntry {
  chapterIndex: number;
  chapterTitle: string;
  readAt: string;
  duration: number | null;
}

interface TimelineData {
  timeline: TimelineEntry[];
  totalRead: number;
}

const INITIAL_SHOW = 5;

function formatDetailedTime(dateStr: string): string {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '—';
  const now = Date.now();
  const diff = now - date.getTime();
  if (diff < 0) return '刚刚';
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}小时前`;
  }
  const days = Math.floor(hours / 24);
  if (days === 1) {
    const h = String(date.getHours()).padStart(2, '0');
    const m = String(date.getMinutes()).padStart(2, '0');
    return `昨天 ${h}:${m}`;
  }
  if (days < 7) return `${days}天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}个月前`;
  return date.toLocaleDateString('zh-CN');
}

function TimelineSkeleton() {
  return (
    <div className="space-y-3 animate-pulse">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="flex gap-3 pl-6">
          <div className="flex-1 space-y-1.5">
            <div className="h-3.5 w-3/5 rounded bg-muted" />
            <div className="h-3 w-1/3 rounded bg-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}

function TimelineError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 py-6 text-center">
      <AlertCircle className="h-5 w-5 text-muted-foreground" />
      <p className="text-xs text-muted-foreground">加载失败</p>
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

function TimelineEmpty() {
  return (
    <div className="flex flex-col items-center gap-2 py-8 text-center">
      <BookOpen className="h-8 w-8 text-muted-foreground/50" />
      <p className="text-sm text-muted-foreground">还没有阅读记录</p>
    </div>
  );
}

interface ReadingTimelineInnerProps {
  novelId: string;
  sessionId: string;
}

function ReadingTimelineInner({ novelId, sessionId }: ReadingTimelineInnerProps) {
  const [data, setData] = useState<TimelineData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const handleRetry = useCallback(() => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    setError(false);

    apiFetch<TimelineData>(
      `/api/novels/${novelId}/reading-timeline?sessionId=${encodeURIComponent(sessionId)}`,
      { silent: true, signal: ac.signal }
    )
      .then((res) => {
        setData(res);
      })
      .catch(() => {
        if (!ac.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
  }, [novelId, sessionId]);

  useEffect(() => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    apiFetch<TimelineData>(
      `/api/novels/${novelId}/reading-timeline?sessionId=${encodeURIComponent(sessionId)}`,
      { silent: true, signal: ac.signal }
    )
      .then((res) => {
        setData(res);
      })
      .catch(() => {
        if (!ac.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });

    return () => abortRef.current?.abort();
  }, [novelId, sessionId]);

  if (loading) return <TimelineSkeleton />;
  if (error) return <TimelineError onRetry={handleRetry} />;
  if (!data || data.timeline.length === 0) return <TimelineEmpty />;

  const visibleEntries = expanded ? data.timeline : data.timeline.slice(0, INITIAL_SHOW);
  const hasMore = data.timeline.length > INITIAL_SHOW;

  return (
    <div>
      <div className="relative border-l-2 border-border pl-6">
        <AnimatePresence mode="popLayout">
          {visibleEntries.map((entry, idx) => (
            <motion.div
              key={entry.readAt}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 8 }}
              transition={{ delay: idx * 0.05, duration: 0.25 }}
              className="relative py-2"
            >
              {/* Dot on the timeline line */}
              <span className="absolute -left-[calc(0.625rem+1px+0.5rem)] top-3 h-2.5 w-2.5 rounded-full bg-primary" />

              <div className="space-y-0.5">
                <p className="text-sm font-medium leading-snug">
                  第{entry.chapterIndex}章 {entry.chapterTitle}
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatDetailedTime(entry.readAt)}
                </p>
                {entry.duration != null && entry.duration > 0 && (
                  <div className="mt-1 flex items-center gap-2">
                    <div
                      className="h-1 rounded-full bg-primary/30"
                      style={{ width: `${Math.min(entry.duration / 2, 100)}px` }}
                    />
                    <span className="text-[10px] text-muted-foreground">
                      {Math.floor(entry.duration / 60)}分钟
                    </span>
                  </div>
                )}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {hasMore && !expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-2 pl-6 text-xs text-primary hover:underline"
        >
          查看更多
        </button>
      )}
    </div>
  );
}

interface ReadingTimelineProps {
  novelId: string;
  sessionId: string;
}

export function ReadingTimeline({ novelId, sessionId }: ReadingTimelineProps) {
  return (
    <ErrorBoundary name="ReadingTimeline">
      <ReadingTimelineInner novelId={novelId} sessionId={sessionId} />
    </ErrorBoundary>
  );
}
