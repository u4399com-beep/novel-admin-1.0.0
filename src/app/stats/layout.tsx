import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '阅读统计 - 小说阁',
  description: '查看您的阅读统计、阅读目标、阅读习惯分析',
};

export default function StatsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
