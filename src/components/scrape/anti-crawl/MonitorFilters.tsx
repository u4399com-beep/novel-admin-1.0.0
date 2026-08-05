'use client';

import React from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EVENT_META } from './EventList';

// ─── Props ────────────────────────────────────────────────────────────────────

interface MonitorFiltersProps {
  value: string;
  onChange: (value: string) => void;
}

// ─── MonitorFilters Component ────────────────────────────────────────────────

export function MonitorFilters({ value, onChange }: MonitorFiltersProps) {
  return (
    <div className="flex items-center gap-2">
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-[140px] h-8 text-xs" aria-label="筛选事件类型">
          <SelectValue placeholder="事件类型" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部事件</SelectItem>
          {Object.entries(EVENT_META).map(([key, meta]) => (
            <SelectItem key={key} value={key}>{meta.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
