'use client';

import { Label } from '@/components/ui/label';
import type { ThemeConfig } from '@/types';

const COLOR_ENTRIES: [keyof ThemeConfig['colors'], string][] = [
  ['primary', '主色'],
  ['secondary', '次色'],
  ['accent', '强调色'],
  ['background', '背景色'],
  ['foreground', '前景色'],
  ['card', '卡片色'],
  ['cardForeground', '卡片文字'],
  ['muted', '柔和背景'],
  ['mutedForeground', '柔和文字'],
  ['border', '边框色'],
  ['ring', '聚焦色'],
];

interface ColorFieldGroupProps {
  colors: ThemeConfig['colors'];
  onChange: (key: string, value: string) => void;
}

export function ColorFieldGroup({ colors, onChange }: ColorFieldGroupProps) {
  return (
    <div>
      <Label className="text-sm font-semibold mb-3 block">配色方案</Label>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {COLOR_ENTRIES.map(([key, label]) => (
          <div key={key} className="flex items-center gap-2">
            <input
              type="color"
              value={colors[key]}
              onChange={(e) => onChange(key, e.target.value)}
              className="h-8 w-8 cursor-pointer rounded border border-border"
            />
            <div className="flex flex-col min-w-0">
              <span className="text-xs text-muted-foreground">{label}</span>
              <span className="text-[10px] text-muted-foreground/60 font-mono truncate">
                {colors[key]}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
