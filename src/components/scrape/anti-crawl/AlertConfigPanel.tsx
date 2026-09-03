'use client';

import { useState, useEffect } from 'react';
import { Settings2, Loader2, RotateCcw, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { apiFetch } from '@/lib/api-fetch';
import { toast } from 'sonner';

// ─── Types ───────────────────────────────────────────────────────────────────

interface AlertConfig {
  thresholds: {
    captchaPerHour: number;
    blockRate: number;
    consecutiveFails: number;
    proxyFailRate: number;
  };
  enabled: boolean;
}

const DEFAULTS: AlertConfig = {
  thresholds: {
    captchaPerHour: 10,
    blockRate: 30,
    consecutiveFails: 5,
    proxyFailRate: 50,
  },
  enabled: true,
};

// ─── AlertConfigPanel Component ──────────────────────────────────────────────

export function AlertConfigPanel() {
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<AlertConfig>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch<AlertConfig>('/api/admin/anti-crawl/alert-config', { silent: true })
      .then((data) => {
        if (!cancelled) setConfig(data);
      })
      .catch(() => {
        // use defaults
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await apiFetch<AlertConfig>('/api/admin/anti-crawl/alert-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      toast.success('告警配置已保存');
    } catch {
      toast.error('保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setConfig(DEFAULTS);
  };

  const updateThreshold = (key: keyof AlertConfig['thresholds'], value: string) => {
    const num = Number(value);
    if (value === '' || isNaN(num)) return;
    setConfig((prev) => ({
      ...prev,
      thresholds: { ...prev.thresholds, [key]: num },
    }));
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-2 w-full rounded-xl border bg-card p-4 hover:bg-muted/50 transition-colors text-left"
        >
          <Settings2 className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium">告警阈值配置</span>
          {!open && config.enabled && (
            <span className="ml-auto text-[10px] text-chart-emerald bg-chart-emerald/10 px-1.5 py-0.5 rounded">
              已启用
            </span>
          )}
          {!open && !config.enabled && (
            <span className="ml-auto text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              已禁用
            </span>
          )}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="rounded-xl border bg-card p-5 mt-1 space-y-5">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              {/* Enable Toggle */}
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">启用告警</Label>
                <Switch
                  checked={config.enabled}
                  onCheckedChange={(checked) => setConfig((prev) => ({ ...prev, enabled: checked }))}
                />
              </div>

              {/* Threshold Fields */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="captchaPerHour" className="text-xs text-muted-foreground">
                    每小时验证码阈值
                  </Label>
                  <Input
                    id="captchaPerHour"
                    type="number"
                    min={1}
                    value={config.thresholds.captchaPerHour}
                    onChange={(e) => updateThreshold('captchaPerHour', e.target.value)}
                    className="h-8 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="blockRate" className="text-xs text-muted-foreground">
                    封锁率阈值%
                  </Label>
                  <Input
                    id="blockRate"
                    type="number"
                    min={1}
                    max={100}
                    value={config.thresholds.blockRate}
                    onChange={(e) => updateThreshold('blockRate', e.target.value)}
                    className="h-8 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="consecutiveFails" className="text-xs text-muted-foreground">
                    连续失败阈值
                  </Label>
                  <Input
                    id="consecutiveFails"
                    type="number"
                    min={1}
                    value={config.thresholds.consecutiveFails}
                    onChange={(e) => updateThreshold('consecutiveFails', e.target.value)}
                    className="h-8 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="proxyFailRate" className="text-xs text-muted-foreground">
                    代理失败率阈值%
                  </Label>
                  <Input
                    id="proxyFailRate"
                    type="number"
                    min={1}
                    max={100}
                    value={config.thresholds.proxyFailRate}
                    onChange={(e) => updateThreshold('proxyFailRate', e.target.value)}
                    className="h-8 text-sm"
                  />
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 justify-end">
                <Button variant="ghost" size="sm" onClick={handleReset} className="h-8 text-xs gap-1.5">
                  <RotateCcw className="h-3.5 w-3.5" />
                  恢复默认
                </Button>
                <Button size="sm" onClick={handleSave} disabled={saving} className="h-8 text-xs gap-1.5">
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  保存配置
                </Button>
              </div>
            </>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
