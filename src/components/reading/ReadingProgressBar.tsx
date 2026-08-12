'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { apiFetch } from '@/lib/api-fetch';
import type { Novel } from '@/types';

/**
 * ReadingProgressBar — thin progress bar fixed at the very top of the viewport.
 *
 * Reads the current reading progress from localStorage (key: `novel-progress-{novelId}`).
 * Displays a 3px animated line with gradient using the `progress-mini .fill` CSS class.
 * Only visible when there's actual progress (> 0).
 */

const PROGRESS_PREFIX = 'novel-progress-';

function loadNovelIdFromPath(pathname: string): string | null {
  // Match /novels/[id] or /novels/[id]/reader or /novels/[id]/...
  const match = pathname.match(/^\/novels\/([^/]+)/);
  return match ? match[1] : null;
}

function loadProgressFromStorage(novelId: string): number {
  try {
    const raw = localStorage.getItem(`${PROGRESS_PREFIX}${novelId}`);
    if (raw) {
      const chapterIndex = parseInt(raw, 10);
      if (!isNaN(chapterIndex) && chapterIndex >= 0) return chapterIndex;
    }
  } catch {
    // ignore
  }
  return 0;
}

export function ReadingProgressBar() {
  const pathname = usePathname();
  const [progress, setProgress] = useState(0);
  const [totalChapters, setTotalChapters] = useState(0);

  const novelId = loadNovelIdFromPath(pathname);

  // Reset when navigating away from a novel page
  useEffect(() => {
    if (!novelId) {
      queueMicrotask(() => { setProgress(0); setTotalChapters(0); });
    }
  }, [novelId]);

  // Load progress when novelId changes
  useEffect(() => {
    if (!novelId) return;
    const ac = new AbortController();
    const chapterIndex = loadProgressFromStorage(novelId);
    apiFetch<Novel>(`/api/novels/${novelId}`, { signal: ac.signal })
      .then((novel) => {
        if (ac.signal.aborted) return;
        const total = novel._count?.chapters ?? 0;
        setTotalChapters(total);
        if (total > 0) {
          setProgress(Math.min(100, Math.round(((chapterIndex + 1) / total) * 100)));
        } else {
          setProgress(0);
        }
      })
      .catch(() => {
        if (ac.signal.aborted) return;
        setProgress(chapterIndex > 0 ? Math.min(chapterIndex, 100) : 0);
      });
    return () => ac.abort();
  }, [novelId]);

  // Listen for storage changes (e.g., progress updated in another tab or by the reader)
  useEffect(() => {
    if (!novelId) return;

    const handleStorage = (e: StorageEvent) => {
      if (e.key === `${PROGRESS_PREFIX}${novelId}` && e.newValue !== null) {
        const newIdx = parseInt(e.newValue, 10);
        if (!isNaN(newIdx) && newIdx >= 0 && totalChapters > 0) {
          const pct = Math.min(100, Math.round(((newIdx + 1) / totalChapters) * 100));
          setProgress(pct);
        }
      }
    };

    // Poll periodically only when tab is visible to save CPU on mobile
    let interval: ReturnType<typeof setInterval> | null = null;
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        // Immediately sync on tab focus
        const current = loadProgressFromStorage(novelId);
        if (totalChapters > 0) {
          const pct = Math.min(100, Math.round(((current + 1) / totalChapters) * 100));
          setProgress(pct);
        }
        // Start polling
        if (!interval) {
          interval = setInterval(() => {
            const cur = loadProgressFromStorage(novelId);
            if (totalChapters > 0) {
              const p = Math.min(100, Math.round(((cur + 1) / totalChapters) * 100));
              setProgress((prev) => (prev !== p ? p : prev));
            }
          }, 2000);
        }
      } else if (interval) {
        // Pause polling when tab is hidden
        clearInterval(interval);
        interval = null;
      }
    };

    // Initialize polling if tab is visible
    handleVisibility();
    window.addEventListener('storage', handleStorage);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('storage', handleStorage);
      document.removeEventListener('visibilitychange', handleVisibility);
      if (interval) clearInterval(interval);
    };
  }, [novelId, totalChapters]);

  // Don't render if no progress or not on a novel page
  if (progress <= 0 || !novelId) return null;

  return (
    <div
      className="fixed top-0 left-0 right-0 z-50 progress-mini pointer-events-none"
      role="progressbar"
      aria-valuenow={progress}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="阅读进度"
      style={{ height: '3px', borderRadius: 0 }}
    >
      <div
        className="fill"
        style={{
          width: `${progress}%`,
          background: `linear-gradient(90deg, var(--primary), oklch(0.7 0.15 200))`,
          borderRadius: '0 2px 2px 0',
          transition: 'width 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      />
    </div>
  );
}

export default ReadingProgressBar;
