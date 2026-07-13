"use client";

import { Input } from "@/components/ui/input";

export const PRESET_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308',
  '#84cc16', '#22c55e', '#14b8a6', '#06b6d4',
  '#0ea5e9', '#3b82f6', '#6366f1', '#8b5cf6',
  '#a855f7', '#d946ef', '#ec4899', '#f43f5e',
];

export function ColorPicker({ value, onChange }: { value: string; onChange: (val: string) => void }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <div className="relative">
          <input
            type="color"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="h-10 w-10 cursor-pointer rounded-lg border border-input bg-transparent p-0.5 [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded-md [&::-webkit-color-swatch]:border-none"
          />
        </div>
        <Input
          value={value}
          onChange={(e) => {
            const v = e.target.value;
            if (/^#[0-9a-fA-F]{0,6}$/.test(v)) {
              onChange(v);
            }
          }}
          className="w-28 font-mono text-sm"
          placeholder="#000000"
          maxLength={7}
        />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {PRESET_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onChange(c)}
            className={`h-7 w-7 rounded-full border-2 transition-all hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              value.toLowerCase() === c.toLowerCase()
                ? 'border-foreground scale-110 ring-2 ring-ring ring-offset-2 ring-offset-background'
                : 'border-transparent'
            }`}
            style={{ backgroundColor: c }}
            aria-label={`选择颜色 ${c}`}
          />
        ))}
      </div>
    </div>
  );
}