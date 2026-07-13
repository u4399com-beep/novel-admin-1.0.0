'use client';

import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import type { EditorFormAccess } from './types';

export function BasicInfoTab({ form }: EditorFormAccess) {
  const { register, setValue, watch, formState: { errors } } = form;
  const enabled = watch('enabled');

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="space-y-2">
        <Label htmlFor="name" className="text-sm font-medium">
          规则名称 <span className="text-destructive">*</span>
        </Label>
        <Input
          id="name"
          placeholder="如：笔趣阁采集规则"
          {...register('name')}
        />
        {errors.name && (
          <p className="text-xs text-destructive">{errors.name.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="description" className="text-sm font-medium">描述</Label>
        <Textarea
          id="description"
          placeholder="简要描述该规则适用范围..."
          rows={3}
          {...register('description')}
        />
      </div>

      <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-4 py-3">
        <div>
          <Label className="text-sm font-medium">启用状态</Label>
          <p className="text-xs text-muted-foreground">关闭后该规则不会被执行</p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(v) => setValue('enabled', v, { shouldDirty: true })}
        />
      </div>
    </div>
  );
}