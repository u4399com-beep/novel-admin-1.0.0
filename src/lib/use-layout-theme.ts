'use client';

import { useState, useEffect, useCallback } from 'react';

export type LayoutTheme = 'grid' | 'magazine' | 'list';

const LAYOUT_THEME_KEY = 'novel-layout-theme';

const LAYOUT_META: Record<LayoutTheme, { label: string; icon: string; description: string }> = {
  grid: { label: '卡片网格', icon: '⊞', description: '经典卡片布局，封面优先' },
  magazine: { label: '杂志风格', icon: '⊡', description: '精选大图 + 双栏排列' },
  list: { label: '列表模式', icon: '☰', description: '紧凑列表，信息密度高' },
};

export { LAYOUT_META };

export function useLayoutTheme() {
  const [theme, setThemeState] = useState<LayoutTheme>(() => {
    if (typeof window === 'undefined') return 'grid';
    try {
      const stored = localStorage.getItem(LAYOUT_THEME_KEY);
      if (stored && stored in LAYOUT_META) return stored as LayoutTheme;
    } catch { /* ignore */ }
    return 'grid';
  });

  const setTheme = useCallback((t: LayoutTheme) => {
    setThemeState(t);
    try {
      localStorage.setItem(LAYOUT_THEME_KEY, t);
    } catch { /* ignore */ }
  }, []);

  // Cross-tab sync
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === LAYOUT_THEME_KEY && e.newValue && e.newValue in LAYOUT_META) {
        setThemeState(e.newValue as LayoutTheme);
      }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  return { theme, setTheme, meta: LAYOUT_META[theme] };
}
