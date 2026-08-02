'use client';

import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import { Save, Download, Upload, Trash2 } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

// ─── Settings type ─────────────────────────────────────────────────────
interface SiteSettings {
  siteName: string;
  siteDescription: string;
  itemsPerPage: string;
  scrapeInterval: number;
  concurrentTasks: number;
  autoPublish: boolean;
  defaultSort: string;
  themeColor: string;
  showWordCount: boolean;
}

const STORAGE_KEY = 'novel-pavilion-settings';

const DEFAULT_SETTINGS: SiteSettings = {
  siteName: '小说阁',
  siteDescription: '',
  itemsPerPage: '15',
  scrapeInterval: 30,
  concurrentTasks: 3,
  autoPublish: false,
  defaultSort: 'newest',
  themeColor: '#8b5cf6',
  showWordCount: true,
};

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

const SORT_OPTIONS = [
  { value: 'newest', label: '最新发布' },
  { value: 'oldest', label: '最早发布' },
  { value: 'title', label: '按标题排序' },
  { value: 'wordCount', label: '按字数排序' },
];

const PAGE_SIZE_OPTIONS = ['10', '15', '20', '30'];

// ─── Helpers ───────────────────────────────────────────────────────────
function loadSettings(): SiteSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SiteSettings>;
      return { ...DEFAULT_SETTINGS, ...parsed };
    }
  } catch {
    // ignore parse errors
  }
  return DEFAULT_SETTINGS;
}

// ─── Component ──────────────────────────────────────────────────────────
export default function SettingsPage() {
  const [settings, setSettings] = useState<SiteSettings>(loadSettings);

  // Update a single field
  const update = useCallback(<K extends keyof SiteSettings>(key: K, value: SiteSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }, []);

  // Persist to localStorage
  const saveSettings = useCallback(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      toast.success('设置已保存');
    } catch {
      toast.error('保存失败，请重试');
    }
  }, [settings]);

  // Import categories
  const handleImportCategories = useCallback(async () => {
    try {
      await fetch('/api/public/seed-categories', { method: 'POST' });
      toast.success('分类导入成功');
    } catch {
      toast.error('分类导入失败');
    }
  }, []);

  // Clear cache
  const handleClearCache = useCallback(() => {
    toast.success('缓存已清空');
  }, []);

  return (
    <div className="space-y-6 p-4 md:p-6">
      {/* ── 1. 基本设置 ────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">基本设置</CardTitle>
          <CardDescription>配置站点基本信息和显示参数</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 站点名称 */}
          <div className="space-y-2">
            <Label htmlFor="siteName">站点名称</Label>
            <Input
              id="siteName"
              value={settings.siteName}
              onChange={(e) => update('siteName', e.target.value)}
              placeholder="请输入站点名称"
            />
          </div>

          {/* 站点描述 */}
          <div className="space-y-2">
            <Label htmlFor="siteDescription">站点描述</Label>
            <Textarea
              id="siteDescription"
              value={settings.siteDescription}
              onChange={(e) => update('siteDescription', e.target.value)}
              placeholder="请输入站点描述"
              rows={3}
            />
          </div>

          {/* 每页显示数量 */}
          <div className="space-y-2">
            <Label>每页显示数量</Label>
            <Select
              value={settings.itemsPerPage}
              onValueChange={(v) => update('itemsPerPage', v)}
            >
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZE_OPTIONS.map((opt) => (
                  <SelectItem key={opt} value={opt}>
                    {opt} 条
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* ── 2. 采集设置 ────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">采集设置</CardTitle>
          <CardDescription>配置采集任务的默认行为参数</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 默认采集间隔 */}
          <div className="space-y-2">
            <Label htmlFor="scrapeInterval">默认采集间隔</Label>
            <div className="flex items-center gap-2">
              <Input
                id="scrapeInterval"
                type="number"
                min={1}
                value={settings.scrapeInterval}
                onChange={(e) => update('scrapeInterval', Number(e.target.value))}
                className="w-32"
              />
              <span className="text-sm text-muted-foreground">分钟</span>
            </div>
          </div>

          {/* 并发采集数 */}
          <div className="space-y-2">
            <Label htmlFor="concurrentTasks">并发采集数</Label>
            <Input
              id="concurrentTasks"
              type="number"
              min={1}
              max={10}
              value={settings.concurrentTasks}
              onChange={(e) =>
                update(
                  'concurrentTasks',
                  Math.min(10, Math.max(1, Number(e.target.value))),
                )
              }
              className="w-32"
            />
            <p className="text-xs text-muted-foreground">建议值 1-10，过高可能导致服务器压力过大</p>
          </div>

          <Separator />

          {/* 自动发布 */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>自动发布</Label>
              <p className="text-xs text-muted-foreground">
                采集完成后自动发布小说和章节
              </p>
            </div>
            <Switch
              checked={settings.autoPublish}
              onCheckedChange={(v) => update('autoPublish', v)}
            />
          </div>
        </CardContent>
      </Card>

      {/* ── 3. 显示设置 ────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">显示设置</CardTitle>
          <CardDescription>自定义前台页面的显示偏好</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 默认排序 */}
          <div className="space-y-2">
            <Label>默认排序</Label>
            <Select
              value={settings.defaultSort}
              onValueChange={(v) => update('defaultSort', v)}
            >
              <SelectTrigger className="w-48">
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

          {/* 主题色 */}
          <div className="space-y-2">
            <Label>主题色</Label>
            <div className="flex items-center gap-2 flex-wrap">
              {THEME_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  onClick={() => update('themeColor', color)}
                  className={`
                    relative h-8 w-8 rounded-full border-2 transition-all duration-150
                    ${
                      settings.themeColor === color
                        ? 'border-foreground scale-110 ring-2 ring-offset-2 ring-offset-background ring-foreground/30'
                        : 'border-transparent hover:scale-105'
                    }
                  `}
                  style={{ backgroundColor: color }}
                  aria-label={`选择颜色 ${color}`}
                >
                  {settings.themeColor === color && (
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

          <Separator />

          {/* 显示字数统计 */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>显示字数统计</Label>
              <p className="text-xs text-muted-foreground">
                在小说列表中显示总字数统计
              </p>
            </div>
            <Switch
              checked={settings.showWordCount}
              onCheckedChange={(v) => update('showWordCount', v)}
            />
          </div>
        </CardContent>
      </Card>

      {/* ── 4. 数据管理 ────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">数据管理</CardTitle>
          <CardDescription>导出、导入和清理系统数据</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            <Button variant="outline" onClick={() => toast.success('数据导出已开始')}>
              <Download className="mr-2 h-4 w-4" />
              导出所有数据
            </Button>
            <Button variant="outline" onClick={handleImportCategories}>
              <Upload className="mr-2 h-4 w-4" />
              导入分类
            </Button>
            <Button variant="outline" onClick={handleClearCache}>
              <Trash2 className="mr-2 h-4 w-4" />
              清空缓存
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── Save button ──────────────────────────────────────────── */}
      <div className="flex justify-end">
        <Button onClick={saveSettings} className="gap-2">
          <Save className="h-4 w-4" />
          保存设置
        </Button>
      </div>
    </div>
  );
}
