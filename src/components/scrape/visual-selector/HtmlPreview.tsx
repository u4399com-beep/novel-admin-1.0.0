'use client';

import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';

export function HtmlPreview({ html }: { html: string }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const displayHtml = isExpanded ? html : html.slice(0, 5000);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-xs text-muted-foreground">
          HTML 预览（{html.length.toLocaleString()} 字符）
        </Label>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setIsExpanded(!isExpanded)}
          className="h-6 px-2 text-xs"
        >
          {isExpanded ? (
            <>
              <ChevronUp className="h-3 w-3 mr-1" />
              收起
            </>
          ) : (
            <>
              <ChevronDown className="h-3 w-3 mr-1" />
              展开全部
            </>
          )}
        </Button>
      </div>
      <ScrollArea className="h-[400px] w-full rounded-lg border bg-muted/20">
        <pre className="p-3 text-xs leading-relaxed font-mono text-foreground/80 whitespace-pre-wrap break-all">
          {displayHtml}
        </pre>
      </ScrollArea>
      {!isExpanded && html.length > 5000 && (
        <p className="text-xs text-center text-muted-foreground">
          仅显示前 5000 字符，点击展开全部
        </p>
      )}
    </div>
  );
}
