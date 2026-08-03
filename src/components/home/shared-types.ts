import { getCoverGradient } from '@/lib/cover-gradient';
import { formatWordCount } from '@/lib/format';

export interface NovelCardData {
  id: string;
  title: string;
  author: string;
  description: string | null;
  coverUrl: string | null;
  coverPath: string | null;
  status: string;
  wordCount: number;
  category: { id: string; name: string; slug: string; color: string; icon: string | null } | null;
  tags: { tag: { id: string; name: string; color: string } }[];
  _count: { chapters: number };
  createdAt: string;
  updatedAt: string;
}

export function getStatusInfo(status: string) {
  if (status === 'ongoing') return { label: '连载中', colorClass: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300', dotClass: 'bg-blue-400 shadow-[0_0_6px_rgba(96,165,250,0.6)]' };
  if (status === 'completed') return { label: '已完结', colorClass: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300', dotClass: 'bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.6)]' };
  return { label: '暂停中', colorClass: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400', dotClass: 'bg-gray-400' };
}

export { getCoverGradient, formatWordCount };
