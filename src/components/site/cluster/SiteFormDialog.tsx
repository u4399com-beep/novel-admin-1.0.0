'use client';

import { useState, useEffect } from 'react';
import {
  Loader2,
  Check,
  X,
  Activity,
} from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api-fetch';
import { tryParseJSON } from './helpers';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { Site, Theme, ThemeGeo } from '@/types';

interface SiteFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingSite: Site | null;
  themes: Theme[];
  onSaved: () => void;
  onUrlTested?: (domain: string, reachable: boolean) => void;
}

export function SiteFormDialog({
  open,
  onOpenChange,
  editingSite,
  themes,
  onSaved,
  onUrlTested,
}: SiteFormDialogProps) {
  const [loading, setLoading] = useState(false);
  const [urlTestState, setUrlTestState] = useState<'idle' | 'testing' | 'reachable' | 'unreachable'>('idle');
  const [form, setForm] = useState({
    domain: '',
    name: '',
    description: '',
    themeId: '',
    enabled: true,
    siteTitle: '',
    siteDescription: '',
    siteKeywords: '',
    geoRegion: 'CN',
    geoPlacename: '中国',
    geoPosition: '39.9042,116.4074',
    novelOffset: 0,
    chapterOffset: 0,
  });

  useEffect(() => {
    if (editingSite) {
      const geo = typeof editingSite.geoConfig === 'string'
        ? (tryParseJSON(editingSite.geoConfig) as ThemeGeo ?? undefined)
        : editingSite.geoConfig;
      setForm({
        domain: editingSite.domain,
        name: editingSite.name,
        description: editingSite.description || '',
        themeId: editingSite.themeId || '',
        enabled: editingSite.enabled,
        siteTitle: editingSite.siteTitle || '',
        siteDescription: editingSite.siteDescription || '',
        siteKeywords: editingSite.siteKeywords || '',
        geoRegion: geo?.region || 'CN',
        geoPlacename: geo?.placename || '中国',
        geoPosition: geo?.position || '39.9042,116.4074',
        novelOffset: editingSite.novelOffset,
        chapterOffset: editingSite.chapterOffset,
      });
    } else {
      setForm((p) => ({ ...p, domain: '', name: '', description: '', themeId: '', enabled: true, novelOffset: 0, chapterOffset: 0 }));
    }
    setUrlTestState('idle');
  }, [editingSite, open]);

  const handleTestUrl = async () => {
    const domain = form.domain.trim();
    if (!domain) {
      toast.error('请先输入域名');
      return;
    }
    setUrlTestState('testing');
    try {
      const fullUrl = domain.startsWith('http') ? domain : `https://${domain}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      await fetch(fullUrl, { mode: 'no-cors', signal: controller.signal });
      clearTimeout(timeout);
      setUrlTestState('reachable');
      toast.success('站点可达');
      onUrlTested?.(domain, true);
    } catch {
      setUrlTestState('unreachable');
      toast.error('站点不可达，请检查域名是否正确');
      onUrlTested?.(domain, false);
    }
  };

  const handleSave = async () => {
    if (!form.domain.trim() || !form.name.trim()) {
      toast.error('请填写域名和站点名称');
      return;
    }
    setLoading(true);
    try {
      const url = editingSite ? `/api/sites/${editingSite.id}` : '/api/sites';
      const method = editingSite ? 'PUT' : 'POST';
      await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          domain: form.domain.trim(),
          name: form.name.trim(),
          description: form.description.trim() || null,
          themeId: form.themeId || null,
          enabled: form.enabled,
          siteTitle: form.siteTitle.trim() || null,
          siteDescription: form.siteDescription.trim() || null,
          siteKeywords: form.siteKeywords.trim() || null,
          geoConfig: {
            region: form.geoRegion,
            placename: form.geoPlacename,
            position: form.geoPosition,
          },
          novelOffset: form.novelOffset,
          chapterOffset: form.chapterOffset,
        }),
      });
      toast.success(editingSite ? '站点已更新' : '站点已创建');
      onOpenChange(false);
      onSaved();
    } catch { /* handled by apiFetch */ } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editingSite ? '编辑站点' : '添加站点'}</DialogTitle>
          <DialogDescription className="sr-only">
            {editingSite ? '修改站点配置信息' : '添加新的站点到站群'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Basic */}
          <div className="space-y-4">
            <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">基本信息</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>域名 *</Label>
                <div className="flex gap-2">
                  <Input
                    value={form.domain}
                    onChange={(e) => { setForm((p) => ({ ...p, domain: e.target.value })); setUrlTestState('idle'); }}
                    placeholder="novel1.example.com"
                    className="flex-1"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0 gap-1.5"
                    disabled={!form.domain.trim() || urlTestState === 'testing'}
                    onClick={handleTestUrl}
                  >
                    {urlTestState === 'testing' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : urlTestState === 'reachable' ? (
                      <Check className="h-3.5 w-3.5 text-chart-emerald" />
                    ) : urlTestState === 'unreachable' ? (
                      <X className="h-3.5 w-3.5 text-destructive" />
                    ) : (
                      <Activity className="h-3.5 w-3.5" />
                    )}
                    {urlTestState === 'testing' ? '测试中' : '测试连接'}
                  </Button>
                </div>
                {urlTestState === 'reachable' && (
                  <p className="text-xs text-chart-emerald">连接成功，站点可达</p>
                )}
                {urlTestState === 'unreachable' && (
                  <p className="text-xs text-destructive">连接失败，请检查域名是否正确</p>
                )}
              </div>
              <div className="space-y-2">
                <Label>站点名称 *</Label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  placeholder="我的小说站"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>站点描述</Label>
              <Textarea
                value={form.description}
                onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
                placeholder="站点简介"
                rows={2}
              />
            </div>
            <div className="space-y-2">
              <Label>选择主题</Label>
              <Select
                value={form.themeId}
                onValueChange={(v) => setForm((p) => ({ ...p, themeId: v }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="请选择主题" />
                </SelectTrigger>
                <SelectContent>
                  {themes.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-3">
              <Switch
                checked={form.enabled}
                onCheckedChange={(v) => setForm((p) => ({ ...p, enabled: v }))}
              />
              <Label>启用站点</Label>
            </div>
          </div>

          {/* SEO */}
          <div className="space-y-4">
            <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">SEO 配置</h4>
            <div className="space-y-2">
              <Label>站点标题 / Title</Label>
              <Input
                value={form.siteTitle}
                onChange={(e) => setForm((p) => ({ ...p, siteTitle: e.target.value }))}
                placeholder="站点SEO标题"
              />
            </div>
            <div className="space-y-2">
              <Label>站点描述 / Description</Label>
              <Textarea
                value={form.siteDescription}
                onChange={(e) => setForm((p) => ({ ...p, siteDescription: e.target.value }))}
                placeholder="站点SEO描述，用于搜索引擎结果展示"
                rows={2}
              />
            </div>
            <div className="space-y-2">
              <Label>站点关键词 / Keywords</Label>
              <Input
                value={form.siteKeywords}
                onChange={(e) => setForm((p) => ({ ...p, siteKeywords: e.target.value }))}
                placeholder="关键词1,关键词2,关键词3"
              />
            </div>
          </div>

          {/* GEO */}
          <div className="space-y-4">
            <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">GEO 配置</h4>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>地区</Label>
                <Input
                  value={form.geoRegion}
                  onChange={(e) => setForm((p) => ({ ...p, geoRegion: e.target.value }))}
                  placeholder="CN"
                />
              </div>
              <div className="space-y-2">
                <Label>地名</Label>
                <Input
                  value={form.geoPlacename}
                  onChange={(e) => setForm((p) => ({ ...p, geoPlacename: e.target.value }))}
                  placeholder="中国"
                />
              </div>
              <div className="space-y-2">
                <Label>坐标</Label>
                <Input
                  value={form.geoPosition}
                  onChange={(e) => setForm((p) => ({ ...p, geoPosition: e.target.value }))}
                  placeholder="39.9042,116.4074"
                />
              </div>
            </div>
          </div>

          {/* ID Offsets */}
          <div className="space-y-4">
            <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">ID 偏移配置</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <TooltipProvider>
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5">
                    <Label>小说ID偏移量</Label>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="text-xs text-muted-foreground cursor-help underline decoration-dotted">?</span>
                      </TooltipTrigger>
                      <TooltipContent side="right" className="max-w-xs">
                        <p className="text-xs">
                          在站群模式下，不同站点的小说ID需要错开以避免冲突。
                          例如站点A偏移0，站点B偏移10000，则站点B的小说ID从10001开始。
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  <Input
                    type="number"
                    value={form.novelOffset}
                    onChange={(e) => setForm((p) => ({ ...p, novelOffset: parseInt(e.target.value) || 0 }))}
                  />
                </div>
              </TooltipProvider>
              <TooltipProvider>
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5">
                    <Label>章节ID偏移量</Label>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="text-xs text-muted-foreground cursor-help underline decoration-dotted">?</span>
                      </TooltipTrigger>
                      <TooltipContent side="right" className="max-w-xs">
                        <p className="text-xs">
                          同小说ID偏移，章节ID也需要在不同站点间错开。
                          确保每个站点的章节ID在全局范围内唯一。
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  <Input
                    type="number"
                    value={form.chapterOffset}
                    onChange={(e) => setForm((p) => ({ ...p, chapterOffset: parseInt(e.target.value) || 0 }))}
                  />
                </div>
              </TooltipProvider>
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleSave} disabled={loading}>
            {loading && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            {editingSite ? '保存修改' : '添加站点'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
