import { apiFetch } from '@/lib/api-fetch';

const HEATMAP_KEY = 'reading-heatmap';

function todayLocal(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Record a reading activity entry for the daily heatmap (localStorage). */
export function recordReadingActivity() {
  try {
    const today = todayLocal();
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
