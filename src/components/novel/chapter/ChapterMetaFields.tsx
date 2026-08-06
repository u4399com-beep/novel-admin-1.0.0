'use client';

import { Input } from '@/components/ui/input';
import { FormField, FormItem, FormLabel, FormControl, FormMessage } from '@/components/ui/form';
import type { UseFormReturn } from 'react-hook-form';

interface ChapterFormValues {
  title: string;
  content: string;
}

interface ChapterMetaFieldsProps {
  form: UseFormReturn<ChapterFormValues>;
  titlePlaceholder: string;
}

export function ChapterMetaFields({ form, titlePlaceholder }: ChapterMetaFieldsProps) {
  return (
    <FormField
      control={form.control}
      name="title"
      render={({ field }) => (
        <FormItem>
          <FormLabel>章节标题</FormLabel>
          <FormControl>
            <Input placeholder={titlePlaceholder} {...field} aria-label="章节标题" />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
