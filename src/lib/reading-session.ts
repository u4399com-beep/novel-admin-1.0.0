/**
 * Generate or retrieve a stable anonymous session ID.
 * Stored in localStorage on the client; used server-side as a lightweight identifier
 * for reading progress, recently viewed, etc.
 */

const STORAGE_KEY = 'novel-session-id';

export function getSessionId(): string {
  try {
    if (typeof window === 'undefined') return '';
    let id = localStorage.getItem(STORAGE_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(STORAGE_KEY, id);
    }
    return id;
  } catch {
    return '';
  }
}

export function getReadingProgressKey(novelId: string): string {
  return `reading-progress-${novelId}`;
}
