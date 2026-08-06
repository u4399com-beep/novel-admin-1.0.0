'use client';

import { useEffect } from 'react';

/**
 * Manages the Fullscreen API for the reader dialog.
 * Returns nothing — the hook directly calls requestFullscreen/exitFullscreen
 * and syncs the `readerFullscreen` state when the user exits via browser UI.
 */
export function useReaderFullscreen(readerOpen: boolean, readerFullscreen: boolean, setReaderFullscreen: (v: boolean) => void) {
  // Toggle fullscreen when readerFullscreen changes
  useEffect(() => {
    if (!readerOpen) return;
    if (readerFullscreen) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      if (document.fullscreenElement) {
        document.exitFullscreen?.().catch(() => {});
      }
    }
  }, [readerFullscreen, readerOpen]);

  // Sync state when user exits fullscreen via browser UI (e.g. pressing Esc)
  useEffect(() => {
    function handleFullscreenChange() {
      if (!document.fullscreenElement && readerFullscreen) {
        setReaderFullscreen(false);
      }
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      if (document.fullscreenElement) document.exitFullscreen?.();
    };
  }, [readerFullscreen, setReaderFullscreen]);
}
