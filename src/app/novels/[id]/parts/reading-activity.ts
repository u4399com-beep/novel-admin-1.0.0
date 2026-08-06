import { apiFetch } from '@/lib/api-fetch';

const HEATMAP_KEY = 'reading-heatmap';

/** Record a reading activity entry for the daily heatmap (localStorage). */
export function recordReadingActivity() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const raw = localStorage.getItem(HEATMAP_KEY);
    const data = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    data[today] = (data[today] || 0) + 1;
    localStorage.setItem(HEATMAP_KEY, JSON.stringify(data));
  } catch { /* ignore */ }
}

/** Report reading goal to server (fire-and-forget). */
export function reportReadingGoal(words: number) {
  apiFetch('/api/reading-goals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chaptersRead: 1, words }),
    silent: true,
    timeout: 5000,
  }).catch(() => { /* 静默 */ });
}
