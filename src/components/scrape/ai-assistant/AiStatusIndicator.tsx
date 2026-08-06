'use client';

import { Check, Loader2 } from 'lucide-react';
import type { Step } from './types';

export function StepIndicator({ currentStep }: { currentStep: Step }) {
  const steps: { key: Step; label: string }[] = [
    { key: 'input', label: '输入信息' },
    { key: 'analyzing', label: 'AI 分析中' },
    { key: 'result', label: '查看结果' },
  ];

  const currentIndex = steps.findIndex((s) => s.key === currentStep);

  return (
    <div className="flex items-center gap-1">
      {steps.map((step, i) => (
        <div key={step.key} className="flex items-center gap-1">
          {i > 0 && (
            <div
              className={`h-px w-6 transition-colors ${
                i <= currentIndex ? 'bg-primary' : 'bg-border'
              }`}
            />
          )}
          <div
            className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
              i === currentIndex
                ? 'bg-primary text-primary-foreground'
                : i < currentIndex
                  ? 'bg-primary/15 text-primary'
                  : 'bg-muted text-muted-foreground'
            }`}
          >
            {i < currentIndex ? (
              <Check className="h-3 w-3" />
            ) : i === currentIndex && step.key === 'analyzing' ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <span className="text-[10px] font-bold">{i + 1}</span>
            )}
            {step.label}
          </div>
        </div>
      ))}
    </div>
  );
}
