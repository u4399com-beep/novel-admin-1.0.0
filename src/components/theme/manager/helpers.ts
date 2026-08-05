'use client';

import type { ThemeConfig } from '@/types';

export function tryParseJSON(str: string): unknown {
  try { return JSON.parse(str); } catch { return undefined; }
}

export function defaultThemeConfig(): ThemeConfig {
  return {
    colors: { primary: '#334155', secondary: '#64748b', accent: '#0f172a', background: '#ffffff', foreground: '#0f172a', card: '#ffffff', cardForeground: '#1e293b', muted: '#f1f5f9', mutedForeground: '#94a3b8', border: '#e2e8f0', ring: '#334155' },
    layout: { maxWidth: '1200px', sidebarPosition: 'left', cardStyle: 'rounded', headerStyle: 'static', gridColumns: 3 },
    typography: { headingFont: 'sans', bodyFont: 'sans', headingWeight: 700, lineHeight: 1.6 },
    seo: { defaultTitle: '', titleTemplate: '{title} - {siteName}', defaultDescription: '', defaultKeywords: '' },
    geo: { region: 'CN', placename: '中国', position: '39.9042,116.4074' },
  };
}
