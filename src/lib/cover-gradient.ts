// ─── Cover placeholder gradient colors (shared across 3 consumers) ─────────

const COVER_GRADIENTS = [
  'from-rose-500/80 to-orange-500/80',
  'from-emerald-500/80 to-teal-500/80',
  'from-violet-500/80 to-purple-500/80',
  'from-amber-500/80 to-yellow-500/80',
  'from-cyan-500/80 to-sky-500/80',
  'from-fuchsia-500/80 to-pink-500/80',
  'from-lime-500/80 to-green-500/80',
  'from-red-500/80 to-rose-500/80',
] as const;

/** Deterministic gradient based on title string hash */
export function getCoverGradient(title: string): string {
  let hash = 0;
  for (let i = 0; i < title.length; i++) {
    hash = title.charCodeAt(i) + ((hash << 5) - hash);
  }
  return COVER_GRADIENTS[Math.abs(hash) % COVER_GRADIENTS.length];
}

/** Genre color palette for stats page distribution bars */
export const GENRE_COLORS = [
  '#8b5cf6', // violet
  '#06b6d4', // cyan
  '#f97316', // orange
  '#10b981', // emerald
  '#ec4899', // pink
  '#eab308', // yellow
  '#3b82f6', // blue
  '#ef4444', // red
  '#14b8a6', // teal
  '#a855f7', // purple
  '#f43f5e', // rose
  '#22c55e', // green
] as const;

/** Deterministic genre color based on genre name hash */
export function getGenreColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return GENRE_COLORS[Math.abs(hash) % GENRE_COLORS.length];
}
