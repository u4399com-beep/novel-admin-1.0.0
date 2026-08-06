'use client';

import type { ThemeConfig } from '@/types';

export function tryParseJSON(str: string): unknown {
  try { return JSON.parse(str); } catch { return undefined; }
}

export function formatRelativeTime(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '—';
  const now = Date.now();
  const diff = now - date.getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}个月前`;
  const years = Math.floor(months / 12);
  return `${years}年前`;
}

export type SiteHealthStatus = 'active' | 'error' | 'unknown';

export function defaultThemeConfig(): ThemeConfig {
  return {
    colors: { primary: '#334155', secondary: '#64748b', accent: '#0f172a', background: '#ffffff', foreground: '#0f172a', card: '#ffffff', cardForeground: '#1e293b', muted: '#f1f5f9', mutedForeground: '#94a3b8', border: '#e2e8f0', ring: '#334155' },
    layout: { maxWidth: '1200px', sidebarPosition: 'left', cardStyle: 'rounded', headerStyle: 'static', gridColumns: 3 },
    typography: { headingFont: 'sans', bodyFont: 'sans', headingWeight: 700, lineHeight: 1.6 },
    seo: { defaultTitle: '', titleTemplate: '{title} - {siteName}', defaultDescription: '', defaultKeywords: '' },
    geo: { region: 'CN', placename: '中国', position: '39.9042,116.4074' },
  };
}
