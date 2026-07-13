'use client';

import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import type { EditorFormAccess } from './types';

export function CleanTab({ form }: EditorFormAccess) {
  const { setValue, watch } = form;
  const cleanCfg = watch('cleanConfig');

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-4 py-3">
        <div>
          <Label className="text-sm font-medium">移除广告</Label>
          <p className="text-xs text-muted-foreground">自动移除常见广告内容</p>
        </div>
        <Switch
          checked={cleanCfg.removeAds}
          onCheckedChange={(v) =>
            setValue('cleanConfig', { ...cleanCfg, removeAds: v }, { shouldDirty: true })
          }
        />
      </div>

      <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-4 py-3">
        <div>
          <Label className="text-sm font-medium">HTML标签规范化</Label>
          <p className="text-xs text-muted-foreground">清理多余的HTML标签和属性</p>
        </div>
        <Switch
          checked={cleanCfg.cleanHtml}
          onCheckedChange={(v) =>
            setValue('cleanConfig', { ...cleanCfg, cleanHtml: v }, { shouldDirty: true })
          }
        />
      </div>

      <Separator />

      <div className="space-y-2">
        <Label className="text-sm font-medium">自定义移除规则</Label>
        <Textarea
          placeholder={'<div class="ad-.*?">.*?</div>\n<script>.*?</script>'}
          rows={5}
          value={cleanCfg.removePatterns}
          onChange={(e) =>
            setValue('cleanConfig', { ...cleanCfg, removePatterns: e.target.value }, { shouldDirty: true })
          }
          className="font-mono text-sm"
        />
        <p className="text-xs text-muted-foreground">每行一条正则表达式，匹配到的内容将被移除</p>
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-medium">广告匹配规则</Label>
        <Textarea
          placeholder={'推荐.*?小说\n最新章节.*?请访问'}
          rows={5}
          value={cleanCfg.adPatterns}
          onChange={(e) =>
            setValue('cleanConfig', { ...cleanCfg, adPatterns: e.target.value }, { shouldDirty: true })
          }
          className="font-mono text-sm"
        />
        <p className="text-xs text-muted-foreground">每行一条正则表达式，用于识别广告内容</p>
      </div>
    </div>
  );
}