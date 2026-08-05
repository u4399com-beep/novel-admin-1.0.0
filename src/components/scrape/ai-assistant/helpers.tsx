import { Shield, Info, AlertTriangle } from 'lucide-react';
import { BookOpen, Palette, Globe } from 'lucide-react';

export function getConfidenceColor(score: number): string {
  if (score >= 80) return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30';
  if (score >= 50) return 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30';
  return 'bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30';
}

export function getConfidenceLabel(score: number): string {
  if (score >= 80) return '高置信度';
  if (score >= 50) return '中等置信度';
  return '低置信度';
}

export function getConfidenceIcon(score: number): React.ReactNode {
  if (score >= 80) return <Shield className="h-3 w-3" />;
  if (score >= 50) return <Info className="h-3 w-3" />;
  return <AlertTriangle className="h-3 w-3" />;
}

export const SITE_TYPES = [
  { value: 'novel', label: '小说站', icon: BookOpen, description: '传统小说连载网站' },
  { value: 'manga', label: '漫画站', icon: Palette, description: '漫画/图片连载网站' },
  { value: 'literature', label: '综合文学站', icon: Globe, description: '综合文学/阅读平台' },
];
