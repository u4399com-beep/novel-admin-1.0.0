'use client';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { EditorFormAccess } from './types';

export function StorageTab({ form }: EditorFormAccess) {
  const { register, setValue, watch } = form;
  const storageMode = watch('storageMode');

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="space-y-2">
        <Label className="text-sm font-medium">存储模式</Label>
        <Select
          value={storageMode}
          onValueChange={(v) => setValue('storageMode', v as 'database' | 'file', { shouldDirty: true })}
        >
          <SelectTrigger className="w-full sm:w-[240px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="database">数据库存储</SelectItem>
            <SelectItem value="file">文件存储</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          数据库存储适合小中型站点，文件存储适合大规模采集
        </p>
      </div>

      {storageMode === 'file' && (
        <div className="space-y-2">
          <Label className="text-sm font-medium">文件存储路径</Label>
          <Input
            placeholder="./data/novels"
            {...register('filePath')}
          />
          <p className="text-xs text-muted-foreground">小说内容文件保存目录</p>
        </div>
      )}

      <Separator />

      <div className="space-y-2">
        <Label className="text-sm font-medium">封面保存路径</Label>
        <Input
          placeholder="./data/covers"
          {...register('coverSavePath')}
        />
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="text-xs">封面格式: WebP</Badge>
          <span className="text-xs text-muted-foreground">封面图将自动转换为WebP格式保存</span>
        </div>
      </div>
    </div>
  );
}