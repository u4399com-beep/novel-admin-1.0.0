'use client';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ThemePreviewCard } from '@/components/theme/ThemePreviewCard';
import type { ThemeConfig } from '@/types';

interface ThemePreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  themeConfig: ThemeConfig;
  themeName: string;
}

export function ThemePreviewDialog({
  open,
  onOpenChange,
  themeConfig,
  themeName,
}: ThemePreviewDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>主题预览 — {themeName}</DialogTitle>
          <DialogDescription className="sr-only">预览主题 {themeName} 的显示效果</DialogDescription>
        </DialogHeader>
        <ThemePreviewCard config={themeConfig} name={themeName} />
      </DialogContent>
    </Dialog>
  );
}
