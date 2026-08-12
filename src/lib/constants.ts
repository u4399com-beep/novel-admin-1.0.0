// Shared UI constants used across multiple components

/** Chinese reading speed: characters per minute. Used by both admin stats and public display. */
export const READING_SPEED_CHARS_PER_MIN = 300;

export const NOVEL_STATUS_MAP: Record<string, { label: string; className: string; colorClass: string; dotClass: string }> = {
  ongoing: {
    label: '连载中',
    className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
    colorClass: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
    dotClass: 'bg-blue-400 shadow-[0_0_6px_rgba(96,165,250,0.6)]',
  },
  completed: {
    label: '已完结',
    className: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
    colorClass: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
    dotClass: 'bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.6)]',
  },
  hiatus: {
    label: '暂停中',
    className: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
    colorClass: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
    dotClass: 'bg-gray-400',
  },
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
