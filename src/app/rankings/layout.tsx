import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '排行榜 - 小说阁',
  description: '热门小说排行榜，发现最受欢迎的小说，周点击榜、月点击榜、总收藏榜',
};

export default function RankingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
