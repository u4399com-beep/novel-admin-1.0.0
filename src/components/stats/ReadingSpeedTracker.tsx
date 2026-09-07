'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Zap, Timer } from 'lucide-react';
import { getSessionId } from '@/lib/reading-session';

// ─── Constants ───────────────────────────────────────────────────────
const WPM_STORAGE_KEY = 'novel-reading-wpm';
const SESSION_START_KEY = 'novel-reading-session-start';

interface WpmRecord {
  timestamp: number;
  wordsRead: number;
  durationMs: number;
  wpm: number;
  novelId: string;
  chapterTitle: string;
}

// ─── Helpers ────────────────────────────────────────────────────────
function getWpmHistory(): WpmRecord[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(WPM_STORAGE_KEY) || '[]');
  } catch { return []; }
}

function saveWpmRecord(record: WpmRecord) {
  if (typeof window === 'undefined') return;
  try {
    const history = getWpmHistory();
    history.push(record);
    // Keep last 100 records
    localStorage.setItem(WPM_STORAGE_KEY, JSON.stringify(history.slice(-100)));
  } catch { /* ignore */ }
}

function getAverageWpm(): number {
  const history = getWpmHistory();
  if (history.length === 0) return 0;
  const recent = history.slice(-20); // Average of last 20 sessions
  return Math.round(recent.reduce((sum, r) => sum + r.wpm, 0) / recent.length);
}

// ─── Hook ───────────────────────────────────────────────────────────
export function useReadingSpeed(novelId: string) {
  const [currentWpm, setCurrentWpm] = useState(0);
  const [avgWpm, setAvgWpm] = useState(0);
  const [wordsRead, setWordsRead] = useState(0);
  const sessionStartRef = useRef<number>(Date.now());

  useEffect(() => {
    setAvgWpm(getAverageWpm());
    sessionStartRef.current = Date.now();
  }, []);

  const recordWords = useCallback((wordCount: number) => {
    setWordsRead((prev) => {
      const newTotal = prev + wordCount;
      const elapsedMs = Date.now() - sessionStartRef.current;
      if (elapsedMs > 1000) { // At least 1 second
        const elapsedMin = elapsedMs / 60000;
        const wpm = Math.round(newTotal / elapsedMin);
        setCurrentWpm(wpm);
      }
      return newTotal;
    });
  }, []);

  const endSession = useCallback((chapterTitle: string) => {
    const elapsedMs = Date.now() - sessionStartRef.current;
    if (wordsRead > 0 && elapsedMs > 5000) { // At least 5 seconds
      const elapsedMin = elapsedMs / 60000;
      const wpm = Math.round(wordsRead / elapsedMin);
      saveWpmRecord({
        timestamp: Date.now(),
        wordsRead,
        durationMs: elapsedMs,
        wpm,
        novelId,
        chapterTitle,
      });
      setAvgWpm(getAverageWpm());
    }
  }, [wordsRead, novelId]);

  return { currentWpm, avgWpm, wordsRead, recordWords, endSession };
}

// ─── Display Component ──────────────────────────────────────────────
export function ReadingSpeedDisplay({ wpm, avgWpm }: { wpm: number; avgWpm: number }) {
  if (wpm === 0 && avgWpm === 0) return null;

  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <div className="flex items-center gap-1">
        <Zap className="h-3 w-3 text-amber-500" />
        <span className="wpm-display font-medium">{wpm > 0 ? wpm : '—'}</span>
        <span className="text-muted-foreground/50">字/分</span>
      </div>
      {avgWpm > 0 && (
        <div className="flex items-center gap-1">
          <Timer className="h-3 w-3 text-muted-foreground/50" />
          <span className="wpm-display">{avgWpm}</span>
          <span className="text-muted-foreground/50">平均</span>
        </div>
      )}
    </div>
  );
}
