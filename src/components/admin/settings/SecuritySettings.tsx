'use client';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const SORT_OPTIONS = [
  { value: 'newest', label: '最新发布' },
  { value: 'oldest', label: '最早发布' },
  { value: 'title', label: '按标题排序' },
  { value: 'wordCount', label: '按字数排序' },
];

const THEME_COLORS = [
  '#8b5cf6',
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#06b6d4',
  '#ec4899',
  '#64748b',
];

interface SecuritySettingsProps {
  defaultSort: string;
  themeColor: string;
  showWordCount: boolean;
  onUpdate: (key: string, value: unknown) => void;
}

export function SecuritySettings({ defaultSort, themeColor, showWordCount, onUpdate }: SecuritySettingsProps) {
  return (
    <Card className="card-border-glow">
      <CardHeader>
        <CardTitle className="text-base settings-section-title">显示设置</CardTitle>
        <CardDescription>自定义前台页面的显示偏好</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="form-group">
          <Label htmlFor="settings-default-sort">默认排序</Label>
          <Select
            value={defaultSort}
            onValueChange={(v) => onUpdate('defaultSort', v)}
          >
            <SelectTrigger id="settings-default-sort" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="form-group">
          <Label>主题色</Label>
          <div className="flex items-center gap-2 flex-wrap">
            {THEME_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => onUpdate('themeColor', color)}
                className={`
                  relative h-8 w-8 rounded-full border-2 transition-all duration-200
                  focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2
                  ${
                    themeColor === color
                      ? 'border-foreground scale-110 ring-2 ring-offset-2 ring-offset-background ring-foreground/30'
                      : 'border-transparent hover:scale-105'
                  }
                `}
                style={{ backgroundColor: color }}
                aria-label={`选择颜色 ${color}`}
              >
                {themeColor === color && (
                  <svg
                    className="absolute inset-0 m-auto h-4 w-4 text-white"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={3}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label>显示字数统计</Label>
            <p className="form-hint mt-0.5">
              在小说列表中显示总字数统计
            </p>
          </div>
          <Switch
            aria-label="显示字数统计"
            checked={showWordCount}
            onCheckedChange={(v) => onUpdate('showWordCount', v)}
          />
        </div>
      </CardContent>
    </Card>
  );
}
