'use client';

import { useMemo } from 'react';
import { Eye } from 'lucide-react';

interface SelectorPreviewProps {
  html: string;
  pageTitle: string;
  url: string;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
}

export function SelectorPreview({
  html,
  pageTitle,
  url,
  iframeRef,
}: SelectorPreviewProps) {
  const iframeSrcdoc = useMemo(() => {
    if (!html) return '';
    const style = `
      <style>
        * { transition: outline 0.15s ease; }
        [data-highlighted] { outline: 2px solid #3b82f6 !important; outline-offset: 2px; background: rgba(59,130,246,0.08) !important; }
      </style>
    `;
    return html.replace('<head>', `<head>${style}`).replace('<HEAD>', `<HEAD>${style}`);
  }, [html]);

  return (
    <div className="h-full rounded-lg border overflow-hidden">
      <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-1.5">
        <div className="flex gap-1">
          <div className="h-2 w-2 rounded-full bg-red-400/60" />
          <div className="h-2 w-2 rounded-full bg-yellow-400/60" />
          <div className="h-2 w-2 rounded-full bg-green-400/60" />
        </div>
        <span className="text-xs text-muted-foreground truncate flex-1">
          {pageTitle || url}
        </span>
      </div>
      <div className="h-[350px] bg-white">
        <iframe
          ref={iframeRef}
          srcDoc={iframeSrcdoc}
          className="w-full h-full border-0"
          sandbox=""
          title="页面预览"
        />
      </div>
    </div>
  );
}
