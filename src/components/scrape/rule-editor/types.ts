import type { UseFormReturn } from 'react-hook-form';
import type { FormValues } from '../parts/schema';

export interface FormAccess {
  form: UseFormReturn<FormValues>;
  setSelector: (field: keyof FormValues, val: { type: 'css' | 'xpath' | 'regex'; value: string }) => void;
  setPagination: (field: keyof FormValues, val: { type: 'next' | 'page'; selector: string; maxPage: number }) => void;
}
