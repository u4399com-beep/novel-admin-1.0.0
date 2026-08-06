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

interface TypographyFieldGroupProps {
  typography: ThemeConfig['typography'];
  onUpdate: (key: string, value: string | number) => void;
}

export function TypographyFieldGroup({ typography, onUpdate }: TypographyFieldGroupProps) {
  return (
    <div>
      <Label className="text-sm font-semibold mb-3 block">排版设置</Label>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">标题字体</Label>
          <Select
            value={typography.headingFont}
            onValueChange={(v) => onUpdate('headingFont', v)}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="sans">无衬线</SelectItem>
              <SelectItem value="serif">衬线</SelectItem>
              <SelectItem value="mono">等宽</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">正文字体</Label>
          <Select
            value={typography.bodyFont}
            onValueChange={(v) => onUpdate('bodyFont', v)}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="sans">无衬线</SelectItem>
              <SelectItem value="serif">衬线</SelectItem>
              <SelectItem value="mono">等宽</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">标题字重</Label>
          <Select
            value={String(typography.headingWeight)}
            onValueChange={(v) => onUpdate('headingWeight', Number(v))}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="700">700 Bold</SelectItem>
              <SelectItem value="800">800 ExtraBold</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">行高</Label>
          <Select
            value={String(typography.lineHeight)}
            onValueChange={(v) => onUpdate('lineHeight', Number(v))}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="1.5">1.5 紧凑</SelectItem>
              <SelectItem value="1.6">1.6 适中</SelectItem>
              <SelectItem value="1.75">1.75 宽松</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}
