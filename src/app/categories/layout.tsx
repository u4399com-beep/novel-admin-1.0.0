import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '分类浏览 - 小说阁',
  description: '按分类浏览小说，言情小说、都市小说、玄幻魔法、修真武侠等多种分类',
};

export default function CategoriesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
