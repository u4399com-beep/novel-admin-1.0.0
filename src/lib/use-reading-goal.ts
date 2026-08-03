'use client';

import { useState, useCallback, useEffect, useRef } from 'react';

// ─── Reading Goal (client-side, localStorage) ──────────────────────

export interface ReadingGoal {
  /** Target number of chapters per day */
  dailyChapters: number;
  /** Target reading minutes per day */
  dailyMinutes: number;
  /** Whether the goal is enabled */
  enabled: boolean;
}

const GOAL_STORAGE_KEY = 'novel-reading-goal';
const PROGRESS_KEY = 'novel-reading-goal-progress';

const DEFAULT_GOAL: ReadingGoal = {
  dailyChapters: 10,
  dailyMinutes: 30,
  enabled: false,
};

function loadGoal(): ReadingGoal {
  if (typeof window === 'undefined') return DEFAULT_GOAL;
  try {
    const saved = localStorage.getItem(GOAL_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      return { ...DEFAULT_GOAL, ...parsed };
    }
  } catch { /* ignore */ }
  return DEFAULT_GOAL;
}

function saveGoal(goal: ReadingGoal) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(GOAL_STORAGE_KEY, JSON.stringify(goal));
  } catch { /* ignore */ }
}

/** Get today's date string in local timezone */
function todayKey(): string {
  return new Date().toLocaleString('sv-SE').slice(0, 10);
}

interface DayProgress {
  date: string;
  chaptersRead: number;
  minutesRead: number;
}

function loadTodayProgress(): DayProgress {
  const today = todayKey();
  if (typeof window === 'undefined') return { date: today, chaptersRead: 0, minutesRead: 0 };
  try {
    const saved = localStorage.getItem(PROGRESS_KEY);
    if (saved) {
      const all: DayProgress[] = JSON.parse(saved);
      const todayEntry = all.find((d) => d.date === today);
      if (todayEntry) return todayEntry;
    }
  } catch { /* ignore */ }
  return { date: today, chaptersRead: 0, minutesRead: 0 };
}

function saveTodayProgress(progress: DayProgress) {
  if (typeof window === 'undefined') return;
  try {
    const saved = localStorage.getItem(PROGRESS_KEY);
    let all: DayProgress[] = saved ? JSON.parse(saved) : [];
    // Keep only last 30 days
    all = all.filter((d) => d.date > new Date(Date.now() - 30 * 86400000).toLocaleString('sv-SE').slice(0, 10));
    const idx = all.findIndex((d) => d.date === progress.date);
    if (idx >= 0) all[idx] = progress;
    else all.push(progress);
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(all));
  } catch { /* ignore */ }
}

export function useReadingGoal() {
  const [goal, setGoalState] = useState<ReadingGoal>(DEFAULT_GOAL);
  const [todayProgress, setTodayProgress] = useState<DayProgress>({ date: todayKey(), chaptersRead: 0, minutesRead: 0 });
  const sessionStartRef = useRef<number>(Date.now());

  // Load from localStorage after mount (avoid hydration mismatch)
  useEffect(() => {
    setGoalState(loadGoal());
    setTodayProgress(loadTodayProgress());
    sessionStartRef.current = Date.now();
  }, []);

  const setGoal = useCallback((partial: Partial<ReadingGoal>) => {
    setGoalState((prev) => {
      const next = { ...prev, ...partial };
      saveGoal(next);
      return next;
    });
  }, []);

  const recordChapterRead = useCallback(() => {
    setTodayProgress((prev) => {
      const next = {
        ...prev,
        date: todayKey(),
        chaptersRead: prev.chaptersRead + 1,
      };
      saveTodayProgress(next);
      return next;
    });
  }, []);

  /** Call on unmount or visibility change to record minutes */
  const recordSessionMinutes = useCallback(() => {
    const elapsed = Math.round((Date.now() - sessionStartRef.current) / 60000);
    if (elapsed < 1) return;
    sessionStartRef.current = Date.now();
    setTodayProgress((prev) => {
      const next = {
        ...prev,
        date: todayKey(),
        minutesRead: prev.minutesRead + elapsed,
      };
      saveTodayProgress(next);
      return next;
    });
  }, []);

  // Track reading minutes via visibility change
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        recordSessionMinutes();
      } else {
        sessionStartRef.current = Date.now();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      recordSessionMinutes(); // Save on unmount
    };
  }, [recordSessionMinutes]);

  const chapterPercent = goal.dailyChapters > 0
    ? Math.min(100, Math.round((todayProgress.chaptersRead / goal.dailyChapters) * 100))
    : 0;

  const minutesPercent = goal.dailyMinutes > 0
    ? Math.min(100, Math.round((todayProgress.minutesRead / goal.dailyMinutes) * 100))
    : 0;

  const goalCompleted = !goal.enabled || chapterPercent >= 100;

  return {
    goal,
    setGoal,
    todayProgress,
    chapterPercent,
    minutesPercent,
    goalCompleted,
    recordChapterRead,
  };
}
