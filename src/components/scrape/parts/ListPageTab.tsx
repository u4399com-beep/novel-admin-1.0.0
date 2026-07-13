'use client';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { SelectorField } from './SelectorField';
import { PaginationField } from './PaginationField';
import type { EditorFormAccess } from './types';

export function ListPageTab({ form, setSelector, setPagination }: EditorFormAccess) {
  const { register, watch, formState: { errors } } = form;

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="space-y-2">
        <Label className="text-sm font-medium">列表页URL模板</Label>
        <Input
          placeholder="https://example.com/list/{page}"
          {...register('listUrl')}
        />
        <p className="text-xs text-muted-foreground">
          使用 {'{page}'} 作为页码占位符
        </p>
      </div>

      <Separator />

      <div className="space-y-2">
        <Label className="text-sm font-medium">采集方式</Label>
        <p className="text-xs text-muted-foreground">选择提取书籍链接的选择器类型和表达式</p>
        <SelectorField
          label="书籍链接选择器"
          value={watch('listSelector')}
          onChange={(v) => setSelector('listSelector', v)}
          errors={errors.listSelector as { type?: { message?: string }; value?: { message?: string } }}
        />
      </div>

      <Separator />

      <PaginationField
        value={watch('listPagination')}
        onChange={(v) => setPagination('listPagination', v)}
        errors={errors.listPagination as { type?: { message?: string }; selector?: { message?: string }; maxPage?: { message?: string } }}
      />
    </div>
  );
}