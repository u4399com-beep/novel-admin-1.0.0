// Shared UI constants used across multiple components

export const NOVEL_STATUS_MAP: Record<string, { label: string; className: string }> = {
  ongoing: { label: '连载中', className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400' },
  completed: { label: '已完结', className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400' },
  hiatus: { label: '暂停', className: 'bg-slate-100 text-slate-600 dark:bg-slate-800/40 dark:text-slate-400' },
};

export const VALID_NOVEL_STATUSES = Object.keys(NOVEL_STATUS_MAP) as string[];