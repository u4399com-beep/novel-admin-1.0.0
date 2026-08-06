import { getCoverGradient } from '@/lib/cover-gradient';
import { formatWordCount } from '@/lib/format';
import { NOVEL_STATUS_MAP } from '@/lib/constants';

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

const DEFAULT_STATUS = NOVEL_STATUS_MAP.hiatus!;

export function getStatusInfo(status: string) {
  const entry = NOVEL_STATUS_MAP[status] ?? DEFAULT_STATUS;
  return { label: entry.label, colorClass: entry.colorClass, dotClass: entry.dotClass };
}

export { getCoverGradient, formatWordCount };
