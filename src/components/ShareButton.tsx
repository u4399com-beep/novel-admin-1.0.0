'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { Share2, MessageCircle, Twitter, Link2, Check, QrCode, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

export interface ShareButtonProps {
  url?: string;
  title?: string;
  description?: string;
  /** Show share count */
  showCount?: boolean;
}

// ─── Simple QR code generator (4x4 block-based) ──────────────
// This is a minimal visual QR placeholder. For production, use a proper QR lib.
function SimpleQRCode({ text }: { text: string }) {
  // Generate a deterministic pattern from the URL hash for visual representation
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const size = 128;
    canvas.width = size;
    canvas.height = size;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000000';

    // Simple hash-based pattern for visual representation
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    const grid = 21;
    const cellSize = size / grid;
    // Position markers (3 corners)
    const drawMarker = (x: number, y: number) => {
      for (let dy = 0; dy < 7; dy++) {
        for (let dx = 0; dx < 7; dx++) {
          const isBorder = dy === 0 || dy === 6 || dx === 0 || dx === 6;
          const isInner = dy >= 2 && dy <= 4 && dx >= 2 && dx <= 4;
          if (isBorder || isInner) {
            ctx.fillRect((x + dx) * cellSize, (y + dy) * cellSize, cellSize, cellSize);
          }
        }
      }
    };
    drawMarker(0, 0);
    drawMarker(grid - 7, 0);
    drawMarker(0, grid - 7);
    // Fill data area with hash-derived pattern
    for (let y = 0; y < grid; y++) {
      for (let x = 0; x < grid; x++) {
        // Skip marker areas
        if ((x < 8 && y < 8) || (x > grid - 9 && y < 8) || (x < 8 && y > grid - 9)) continue;
        const bit = ((hash * (x + 1) * (y + 1) + x * 31 + y * 17) >>> 0) & 1;
        if (bit) {
          ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
        }
      }
    }
  }, [text]);

  return <canvas ref={canvasRef} className="w-32 h-32 rounded-lg" />;
}

const SHARE_CHANNELS = [
  { key: 'wechat', label: '微信', icon: MessageCircle, color: 'text-green-500' },
  { key: 'weibo', label: '微博', icon: Twitter, color: 'text-red-500' },
  { key: 'twitter', label: 'Twitter', icon: Twitter, color: 'text-sky-500' },
] as const;

export function ShareButton({ url, title, description, showCount = true }: ShareButtonProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showQR, setShowQR] = useState(false);
  const [shareCount, setShareCount] = useState(0);

  const shareUrl = url ?? (typeof window !== 'undefined' ? window.location.href : '');
  const shareTitle = title ?? document?.title ?? '';

  // Fetch share count on mount
  useEffect(() => {
    if (!showCount || !shareUrl) return;
    // Best-effort: just show a local count from localStorage
    try {
      const counts = JSON.parse(localStorage.getItem('share-counts') || '{}');
      const count = counts[shareUrl] ?? 0;
      queueMicrotask(() => setShareCount(count));
    } catch { /* ignore */ }
  }, [showCount, shareUrl]);

  const recordShare = useCallback((channel: string) => {
    try {
      const counts = JSON.parse(localStorage.getItem('share-counts') || '{}');
      counts[shareUrl] = (counts[shareUrl] ?? 0) + 1;
      localStorage.setItem('share-counts', JSON.stringify(counts));
      setShareCount(counts[shareUrl]);
    } catch { /* ignore */ }
    toast.success(`已分享到${channel}`);
  }, [shareUrl]);

  const handleCopyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      recordShare('剪贴板');
    } catch {
      toast.error('复制失败');
    }
  }, [shareUrl, recordShare]);

  const handleShare = useCallback((channel: string) => {
    const encodedUrl = encodeURIComponent(shareUrl);
    const encodedTitle = encodeURIComponent(shareTitle);
    switch (channel) {
      case 'wechat':
        setShowQR(true);
        recordShare('微信');
        break;
      case 'weibo':
        window.open(`https://service.weibo.com/share/share.php?url=${encodedUrl}&title=${encodedTitle}`, '_blank', 'noopener,noreferrer,width=600,height=400');
        recordShare('微博');
        break;
      case 'twitter':
        window.open(`https://twitter.com/intent/tweet?url=${encodedUrl}&text=${encodedTitle}`, '_blank', 'noopener,noreferrer,width=600,height=400');
        recordShare('Twitter');
        break;
    }
  }, [shareUrl, shareTitle, recordShare]);

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="sm"
        className="gap-1.5 text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((p) => !p)}
        aria-label="分享"
      >
        <Share2 className="h-4 w-4" />
        分享
        {showCount && shareCount > 0 && (
          <span className="text-[10px] text-muted-foreground/60 tabular-nums">{shareCount}</span>
        )}
      </Button>

      {open && (
        <div className="absolute top-full right-0 mt-2 z-50 w-64 glass rounded-xl p-4 shadow-xl share-panel-enter">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium">分享到</span>
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => { setOpen(false); setShowQR(false); }} aria-label="关闭">
              <X className="h-3 w-3" />
            </Button>
          </div>

          {showQR ? (
            <div className="flex flex-col items-center gap-3 py-2">
              <span className="text-xs text-muted-foreground">微信扫一扫分享</span>
              <div className="qr-code-container">
                <SimpleQRCode text={shareUrl} />
              </div>
              <Button variant="outline" size="sm" className="text-xs" onClick={() => setShowQR(false)}>
                返回
              </Button>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2 mb-3">
                {SHARE_CHANNELS.map((ch) => {
                  const Icon = ch.icon;
                  return (
                    <button
                      key={ch.key}
                      onClick={() => handleShare(ch.key)}
                      className="flex flex-col items-center gap-1.5 py-2.5 rounded-lg hover:bg-accent transition-colors cursor-pointer"
                    >
                      <Icon className={`h-5 w-5 ${ch.color}`} />
                      <span className="text-[11px] text-muted-foreground">{ch.label}</span>
                    </button>
                  );
                })}
              </div>
              <div className="border-t border-border/50 pt-3">
                <button
                  onClick={handleCopyLink}
                  className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md hover:bg-accent transition-colors text-sm text-muted-foreground cursor-pointer"
                >
                  {copied ? <Check className="h-4 w-4 text-green-500" /> : <Link2 className="h-4 w-4" />}
                  {copied ? '已复制' : '复制链接'}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
