'use client';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { PaginationConfig } from './types';

interface PaginationFieldProps {
  label?: string;
  value: PaginationConfig;
  onChange: (val: PaginationConfig) => void;
  errors?: {
    type?: { message?: string };
    selector?: { message?: string };
    maxPage?: { message?: string };
  };
}

export function PaginationField({ label = '分页配置', value, onChange, errors }: PaginationFieldProps) {
  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
      <p className="text-sm font-medium">{label}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">分页类型</Label>
          <Select
            value={value.type}
            onValueChange={(t) => onChange({ ...value, type: t as 'next' | 'page' })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="next">下一页按钮</SelectItem>
              <SelectItem value="page">页码URL模板</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 sm:col-span-1">
          <Label className="text-xs text-muted-foreground">
            {value.type === 'next' ? '下一页选择器' : 'URL模板'}
          </Label>
          <Input
            placeholder={value.type === 'next' ? 'a.next-page' : 'https://.../list/{page}'}
            value={value.selector}
            onChange={(e) => onChange({ ...value, selector: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">最大页数</Label>
          <Input
            type="number"
            min={1}
            max={100}
            value={value.maxPage}
            onChange={(e) => onChange({ ...value, maxPage: parseInt(e.target.value) || 1 })}
          />
        </div>
      </div>
      {errors?.type?.message && <p className="text-xs text-destructive">{errors.type.message}</p>}
      {errors?.selector?.message && <p className="text-xs text-destructive">{errors.selector.message}</p>}
      {errors?.maxPage?.message && <p className="text-xs text-destructive">{errors.maxPage.message}</p>}
    </div>
  );
}