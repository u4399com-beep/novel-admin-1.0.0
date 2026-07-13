'use client';

import { SelectorField } from './SelectorField';
import type { EditorFormAccess } from './types';

export function BookInfoTab({ form, setSelector }: EditorFormAccess) {
  const { watch, formState: { errors } } = form;

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <p className="text-sm text-muted-foreground">
        配置从书籍详情页提取各字段信息的规则
      </p>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SelectorField
          label="书名"
          required
          value={watch('bookTitleSelector')}
          onChange={(v) => setSelector('bookTitleSelector', v)}
          errors={errors.bookTitleSelector as { type?: { message?: string }; value?: { message?: string } }}
        />
        <SelectorField
          label="作者"
          value={watch('bookAuthorSelector')}
          onChange={(v) => setSelector('bookAuthorSelector', v)}
          errors={errors.bookAuthorSelector as { type?: { message?: string }; value?: { message?: string } }}
        />
        <SelectorField
          label="分类"
          value={watch('bookCategorySelector')}
          onChange={(v) => setSelector('bookCategorySelector', v)}
          errors={errors.bookCategorySelector as { type?: { message?: string }; value?: { message?: string } }}
        />
        <SelectorField
          label="关键词"
          value={watch('bookKeywordsSelector')}
          onChange={(v) => setSelector('bookKeywordsSelector', v)}
          errors={errors.bookKeywordsSelector as { type?: { message?: string }; value?: { message?: string } }}
        />
        <SelectorField
          label="简介"
          value={watch('bookDescriptionSelector')}
          onChange={(v) => setSelector('bookDescriptionSelector', v)}
          errors={errors.bookDescriptionSelector as { type?: { message?: string }; value?: { message?: string } }}
        />
        <SelectorField
          label="封面图"
          value={watch('bookCoverSelector')}
          onChange={(v) => setSelector('bookCoverSelector', v)}
          errors={errors.bookCoverSelector as { type?: { message?: string }; value?: { message?: string } }}
        />
      </div>

      <SelectorField
        label="状态"
        value={watch('bookStatusSelector')}
        onChange={(v) => setSelector('bookStatusSelector', v)}
        errors={errors.bookStatusSelector as { type?: { message?: string }; value?: { message?: string } }}
      />
    </div>
  );
}