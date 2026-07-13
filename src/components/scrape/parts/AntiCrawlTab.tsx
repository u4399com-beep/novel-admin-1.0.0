'use client';

import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import type { EditorFormAccess } from './types';

export function AntiCrawlTab({ form }: EditorFormAccess) {
  const { setValue, watch } = form;
  const antiCrawl = watch('antiCrawlConfig');

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-4 py-3">
        <div>
          <Label className="text-sm font-medium">启用JS渲染</Label>
          <p className="text-xs text-muted-foreground">使用无头浏览器渲染页面（速度较慢）</p>
        </div>
        <Switch
          checked={antiCrawl.useJsRender}
          onCheckedChange={(v) =>
            setValue('antiCrawlConfig', { ...antiCrawl, useJsRender: v }, { shouldDirty: true })
          }
        />
      </div>

      <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-4 py-3">
        <div>
          <Label className="text-sm font-medium">UA轮换</Label>
          <p className="text-xs text-muted-foreground">每次请求使用不同的User-Agent</p>
        </div>
        <Switch
          checked={antiCrawl.uaRotation}
          onCheckedChange={(v) =>
            setValue('antiCrawlConfig', { ...antiCrawl, uaRotation: v }, { shouldDirty: true })
          }
        />
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-medium">自定义Cookies</Label>
        <Textarea
          placeholder={'key1=value1\nkey2=value2'}
          rows={4}
          value={antiCrawl.cookies}
          onChange={(e) =>
            setValue('antiCrawlConfig', { ...antiCrawl, cookies: e.target.value }, { shouldDirty: true })
          }
          className="font-mono text-sm"
        />
        <p className="text-xs text-muted-foreground">每行一个Cookie，格式：key=value</p>
      </div>

      <Separator />

      <div className="space-y-2">
        <Label className="text-sm font-medium">请求延迟范围</Label>
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <Label className="text-xs text-muted-foreground">最小延迟</Label>
            <div className="flex items-center gap-1">
              <Input
                type="number"
                min={0}
                value={antiCrawl.minDelay}
                onChange={(e) =>
                  setValue(
                    'antiCrawlConfig',
                    { ...antiCrawl, minDelay: parseInt(e.target.value) || 0 },
                    { shouldDirty: true }
                  )
                }
              />
              <span className="text-sm text-muted-foreground shrink-0">ms</span>
            </div>
          </div>
          <span className="mt-5 text-muted-foreground">-</span>
          <div className="flex-1">
            <Label className="text-xs text-muted-foreground">最大延迟</Label>
            <div className="flex items-center gap-1">
              <Input
                type="number"
                min={0}
                value={antiCrawl.maxDelay}
                onChange={(e) =>
                  setValue(
                    'antiCrawlConfig',
                    { ...antiCrawl, maxDelay: parseInt(e.target.value) || 0 },
                    { shouldDirty: true })
                }
              />
              <span className="text-sm text-muted-foreground shrink-0">ms</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}