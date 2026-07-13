'use client';

import { Separator } from '@/components/ui/separator';
import { SelectorField } from './SelectorField';
import { PaginationField } from './PaginationField';
import type { EditorFormAccess } from './types';

export function ChapterContentTab({ form, setSelector, setPagination }: EditorFormAccess) {
  const { watch, formState: { errors } } = form;

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <p className="text-sm text-muted-foreground">
        配置从章节内容页提取正文内容的规则
      </p>

      <SelectorField
        label="内容页标题选择器（可选）"
        value={watch('contentTitleSelector')}
        onChange={(v) => setSelector('contentTitleSelector', v)}
        errors={errors.contentTitleSelector as { type?: { message?: string }; value?: { message?: string } }}
      />
      <p className="text-xs text-muted-foreground -mt-2">不填则使用目录页提取的标题</p>

      <SelectorField
        label="正文选择器"
        required
        value={watch('contentSelector')}
        onChange={(v) => setSelector('contentSelector', v)}
        errors={errors.contentSelector as { type?: { message?: string }; value?: { message?: string } }}
      />

      <Separator />

      <PaginationField
        label="内容分页配置（长内容跨页拆分）"
        value={watch('contentPagination')}
        onChange={(v) => setPagination('contentPagination', v)}
        errors={errors.contentPagination as { type?: { message?: string }; selector?: { message?: string }; maxPage?: { message?: string } }}
      />
    </div>
  );
}