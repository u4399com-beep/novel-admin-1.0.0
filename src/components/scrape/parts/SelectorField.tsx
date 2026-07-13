'use client';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { SelectorRule } from './types';

interface SelectorFieldProps {
  label: string;
  required?: boolean;
  value: SelectorRule;
  onChange: (val: SelectorRule) => void;
  errors?: { type?: { message?: string }; value?: { message?: string } };
}

export function SelectorField({ label, required, value, onChange, errors }: SelectorFieldProps) {
  return (
    <div className="space-y-2">
      <Label className="text-sm font-medium">
        {label}
        {required && <span className="text-destructive ml-1">*</span>}
      </Label>
      <div className="flex gap-2">
        <Select
          value={value.type}
          onValueChange={(t) => onChange({ ...value, type: t as 'css' | 'xpath' | 'regex' })}
        >
          <SelectTrigger className="w-[120px] shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="css">CSS选择器</SelectItem>
            <SelectItem value="xpath">XPath</SelectItem>
            <SelectItem value="regex">正则表达式</SelectItem>
          </SelectContent>
        </Select>
        <Input
          className="flex-1"
          placeholder={value.type === 'css' ? '.class-name' : value.type === 'xpath' ? '//div[@class="x"]' : '正则表达式'}
          value={value.value}
          onChange={(e) => onChange({ ...value, value: e.target.value })}
        />
      </div>
      {errors?.type?.message && (
        <p className="text-xs text-destructive">{errors.type.message}</p>
      )}
      {errors?.value?.message && (
        <p className="text-xs text-destructive">{errors.value.message}</p>
      )}
    </div>
  );
}