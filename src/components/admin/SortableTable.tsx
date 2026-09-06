'use client';

import React, { useState, useCallback } from 'react';
import { ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react';

export type SortDirection = 'asc' | 'desc' | null;

export interface SortableHeaderProps {
  label: string;
  direction: SortDirection;
  onSort: () => void;
  className?: string;
}

/**
 * A table header cell with sort indicators.
 * Click cycles through: null → asc → desc → null
 */
export function SortableHeader({ label, direction, onSort, className }: SortableHeaderProps) {
  return (
    <button
      onClick={onSort}
      className={`flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors group ${className ?? ''}`}
      aria-label={`Sort by ${label}`}
    >
      <span>{label}</span>
      {direction === 'asc' ? (
        <ArrowUp className="h-3 w-3 text-primary" />
      ) : direction === 'desc' ? (
        <ArrowDown className="h-3 w-3 text-primary" />
      ) : (
        <ArrowUpDown className="h-3 w-3 opacity-0 group-hover:opacity-50 transition-opacity" />
      )}
    </button>
  );
}

/**
 * Hook to manage sort state for multiple columns.
 */
export function useTableSort<T extends string>(defaultKey?: T, defaultDir?: SortDirection) {
  const [sortKey, setSortKey] = useState<T | null>(defaultKey ?? null);
  const [sortDir, setSortDir] = useState<SortDirection>(defaultDir ?? null);

  const cycleSort = useCallback((key: T) => {
    setSortKey((prevKey) => {
      if (prevKey !== key) {
        setSortDir('asc');
        return key;
      }
      setSortDir((prevDir) => {
        if (prevDir === 'asc') return 'desc';
        if (prevDir === 'desc') return null;
        return 'asc';
      });
      return key;
    });
  }, []);

  return { sortKey, sortDir, cycleSort };
}
