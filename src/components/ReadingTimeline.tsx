'use client';

import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { BookOpen, ChevronDown, ChevronRight, Clock, AlertCircle } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { ErrorBoundary } from '@/components/ErrorBoundary';

// ─── Types ────────────────────────────────────────────────────
interface TimelineEntry {
  novelId: string;
  novelTitle: string;
  coverUrl: string | null;
  chapterIndex: number;
  chapterTitle: string;
  readAt: string;
  duration: number | null;
}

interface DayGroup {
  date: string;          // YYYY-MM-DD
  label: string;         // e.g. "今天", "昨天", "2025-03-05"
  entries: TimelineEntry[];
  totalDuration: number;
}

// ─── Group entries by day ─────────────────────────────────────
function groupByDay(entries: TimelineEntry[]): DayGroup[] {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const yesterdayDate = new Date(now);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterdayStr = yesterdayDate.toISOString().slice(0, 10);

  const groups = new Map<string, TimelineEntry[]>();
  for (const entry of entries) {
    const dateKey = entry.readAt.slice(0, 10);
    if (!groups.has(dateKey)) groups.set(dateKey, []);
    groups.get(dateKey)!.push(entry);
  }

  const dayGroups: DayGroup[] = [];
  for (const [date, items] of groups) {
    let label = date;
    if (date === todayStr) label = '今天';
    else if (date === yesterdayStr) label = '昨天';
    dayGroups.push({
      date,
      label,
      entries: items.sort((a, b) => b.readAt.localeCompare(a.readAt)),
      totalDuration: items.reduce((sum, e) => sum + (e.duration ?? 0), 0),
    });
  }

  return dayGroups.sort((a, b) => b.date.localeCompare(a.date));
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}秒`;
  const min = Math.floor(seconds / 60);
  if (min < 60) return `${min}分钟`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}小时${m > 0 ? `${m}分` : ''}`;
}

// ─── Skeleton / Error / Empty ─────────────────────────────────
function TimelineSkeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="space-y-2">
          <div className="h-4 w-24 rounded bg-muted" />
          <div className="pl-6 space-y-2">
            <div className="flex gap-3">
              <div className="h-8 w-6 rounded bg-muted" />
              <div className="flex-1 space-y-1">
                <div className="h-3 w-3/5 rounded bg-muted" />
                <div className="h-2.5 w-1/3 rounded bg-muted" />
              </div>
            </div>
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
      <p className="text-xs text-muted-foreground">加载阅读历史失败</p>
      <button type="button" onClick={onRetry} className="text-xs text-primary hover:underline cursor-pointer">重试</button>
    </div>
  );
}

function TimelineEmpty() {
  return (
    <div className="flex flex-col items-center gap-2 py-8 text-center">
      <BookOpen className="h-8 w-8 text-muted-foreground/50" />
      <p className="text-sm text-muted-foreground">暂无阅读历史</p>
    </div>
  );
}

// ─── Day Group Component ──────────────────────────────────────
function DayGroupItem({ group, defaultExpanded = false }: { group: DayGroup; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div className="space-y-1">
      {/* Day header */}
      <button
        className="flex items-center gap-2 w-full py-1.5 text-sm font-medium text-foreground hover:text-primary transition-colors cursor-pointer"
        onClick={() => setExpanded((p) => !p)}
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <span>{group.label}</span>
        <span className="text-[11px] font-normal text-muted-foreground">
          {group.entries.length} 条记录
        </span>
        {group.totalDuration > 0 && (
          <span className="ml-auto text-[11px] font-normal text-muted-foreground flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {formatDuration(group.totalDuration)}
          </span>
        )}
      </button>

      {/* Entries */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="relative border-l-2 border-border/60 pl-5 ml-1.5 space-y-2">
              {group.entries.map((entry, i) => (
                <motion.div
                  key={`${entry.readAt}-${i}`}
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.04, duration: 0.2 }}
                  className="relative py-1.5"
                >
                  {/* Timeline dot */}
                  <span className="absolute -left-[calc(0.625rem+1px+0.375rem)] top-3.5 h-2 w-2 rounded-full bg-primary/70" />

                  <div className="flex items-start gap-3">
                    {/* Novel cover thumbnail */}
                    {entry.coverUrl ? (
                      <img
                        src={entry.coverUrl}
                        alt={entry.novelTitle}
                        className="h-10 w-7 rounded-sm object-cover shrink-0 shadow-sm"
                        loading="lazy"
                      />
                    ) : (
                      <div className="h-10 w-7 rounded-sm bg-muted shrink-0 flex items-center justify-center">
                        <BookOpen className="h-3 w-3 text-muted-foreground/50" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0 space-y-0.5">
                      <p className="text-sm font-medium leading-snug truncate">
                        第{entry.chapterIndex}章 {entry.chapterTitle}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">
                        {entry.novelTitle}
                      </p>
                      <div className="flex items-center gap-2 text-[10px] text-muted-foreground/70">
                        <span>{new Date(entry.readAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
                        {entry.duration != null && entry.duration > 0 && (
                          <>
                            <span>·</span>
                            <span className="flex items-center gap-0.5">
                              <Clock className="h-2.5 w-2.5" />
                              {formatDuration(entry.duration)}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Inner Component (fetches data) ──────────────────────────
interface ReadingHistoryTimelineInnerProps {
  sessionId: string;
  novelId?: string; // optional: filter to single novel
  maxDays?: number;
}

function ReadingHistoryTimelineInner({ sessionId, novelId, maxDays = 7 }: ReadingHistoryTimelineInnerProps) {
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const fetchTimeline = useCallback(() => {
    setLoading(true);
    setError(false);
    const params = new URLSearchParams({ sessionId });
    if (novelId) params.set('novelId', novelId);

    apiFetch<{ timeline: TimelineEntry[] }>(`/api/public/reading-history?${params}`, { silent: true })
      .then((res) => setEntries(res.timeline ?? []))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [sessionId, novelId]);

  useEffect(() => { queueMicrotask(fetchTimeline); }, [fetchTimeline]);

  if (loading) return <TimelineSkeleton />;
  if (error) return <TimelineError onRetry={fetchTimeline} />;
  if (entries.length === 0) return <TimelineEmpty />;

  const dayGroups = groupByDay(entries).slice(0, maxDays);

  return (
    <div className="space-y-3">
      {dayGroups.map((group, i) => (
        <DayGroupItem
          key={group.date}
          group={group}
          defaultExpanded={i === 0}
        />
      ))}
      {dayGroups.length === 0 && <TimelineEmpty />}
    </div>
  );
}

// ─── Exported Component ───────────────────────────────────────
export interface ReadingHistoryTimelineProps {
  sessionId: string;
  novelId?: string;
  maxDays?: number;
}

export function ReadingHistoryTimeline({ sessionId, novelId, maxDays }: ReadingHistoryTimelineProps) {
  return (
    <ErrorBoundary name="ReadingHistoryTimeline">
      <ReadingHistoryTimelineInner sessionId={sessionId} novelId={novelId} maxDays={maxDays} />
    </ErrorBoundary>
  );
}
