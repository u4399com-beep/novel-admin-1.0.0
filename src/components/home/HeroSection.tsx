'use client';

import { SearchBar } from './hero/SearchBar';
import { FilterChips } from './hero/FilterChips';
import type { Category } from '@/types';

export type { Category } from '@/types';
export interface HeroSectionProps {
  search: string;
  onSearch: (term: string) => void;
  categories: Category[];
  loadingCategories: boolean;
  loadingNovels: boolean;
  activeCategorySlug: string;
  activeStatus: string;
  activeWordCount: string;
  activeSort: string;
  onCategoryChange: (slug: string) => void;
  onStatusChange: (status: string) => void;
  onWordCountChange: (wc: string) => void;
  onSortChange: (sort: string) => void;
  hasActiveFilter: boolean;
  resetAllFilters: () => void;
  total: number;
  filterSummary: string;
}

export function HeroSection({
  search,
  onSearch,
  categories,
  loadingCategories,
  loadingNovels,
  activeCategorySlug,
  activeStatus,
  activeWordCount,
  activeSort,
  onCategoryChange,
  onStatusChange,
  onWordCountChange,
  onSortChange,
  hasActiveFilter,
  resetAllFilters,
  total,
  filterSummary,
}: HeroSectionProps) {
  return (
    <>
      <SearchBar search={search} onSearch={onSearch} />
      <FilterChips
        categories={categories}
        loadingCategories={loadingCategories}
        loadingNovels={loadingNovels}
        activeCategorySlug={activeCategorySlug}
        activeStatus={activeStatus}
        activeWordCount={activeWordCount}
        activeSort={activeSort}
        onCategoryChange={onCategoryChange}
        onStatusChange={onStatusChange}
        onWordCountChange={onWordCountChange}
        onSortChange={onSortChange}
        hasActiveFilter={hasActiveFilter}
        resetAllFilters={resetAllFilters}
        total={total}
        filterSummary={filterSummary}
      />
    </>
  );
}
