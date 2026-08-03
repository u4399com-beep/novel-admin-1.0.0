// Shared UI constants used across multiple components

export const NOVEL_STATUS_MAP: Record<string, { label: string; className: string }> = {
  ongoing: { label: '连载中', className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400' },
  completed: { label: '已完结', className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400' },
  hiatus: { label: '暂停', className: 'bg-slate-100 text-slate-600 dark:bg-slate-800/40 dark:text-slate-400' },
};

export const VALID_NOVEL_STATUSES = Object.keys(NOVEL_STATUS_MAP) as string[];

/** Scraper service URL — used by scrape-tasks, ai-generate, preview */
export const SCRAPER_SERVICE_URL =
  process.env.SCRAPER_SERVICE_URL || 'http://localhost:3099';

/**
 * Build Authorization header for scraper-service.
 * Returns undefined (no header) when token is not configured,
 * avoiding sending an empty "Bearer " string.
 */
export function getScraperServiceHeaders(): HeadersInit {
  const headers: HeadersInit = { 'Content-Type': 'application/json' };
  const token = process.env.SCRAPER_SERVICE_TOKEN;
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}
