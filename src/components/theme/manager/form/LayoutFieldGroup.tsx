'use client';

import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { ThemeConfig } from '@/types';

interface LayoutFieldGroupProps {
  layout: ThemeConfig['layout'];
  onUpdate: (key: string, value: string | number) => void;
}

export function LayoutFieldGroup({ layout, onUpdate }: LayoutFieldGroupProps) {
  return (
    <div>
      <Label className="text-sm font-semibold mb-3 block">布局设置</Label>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">卡片样式</Label>
          <Select value={layout.cardStyle} onValueChange={(v) => onUpdate('cardStyle', v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="rounded">圆角</SelectItem>
              <SelectItem value="flat">扁平</SelectItem>
              <SelectItem value="elevated">悬浮</SelectItem>
              <SelectItem value="bordered">边框</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">头部样式</Label>
          <Select value={layout.headerStyle} onValueChange={(v) => onUpdate('headerStyle', v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="fixed">固定</SelectItem>
              <SelectItem value="static">静态</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">网格列数</Label>
          <Select value={String(layout.gridColumns)} onValueChange={(v) => onUpdate('gridColumns', Number(v))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="3">3 列</SelectItem>
              <SelectItem value="4">4 列</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}
