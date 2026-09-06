'use client';

import { useState, useEffect, useRef, useMemo, useSyncExternalStore } from 'react';
import { ExternalLink, RefreshCw, Link2 } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { apiFetch } from '@/lib/api-fetch';

// ─── Types ────────────────────────────────────────────────────────────────────
interface FriendlyLinkData {
  title: string;
  url: string;
  description: string | null;
  nofollow: boolean;
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────
function FooterLinksSkeleton() {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Skeleton className="h-3.5 w-16" />
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-5 w-16 rounded" />
          ))}
        </div>
      </div>
      <Separator className="opacity-30" />
      <div className="space-y-2">
        <Skeleton className="h-3.5 w-20" />
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-5 w-20 rounded" />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Friendly Link Item ──────────────────────────────────────────────────────
// Hook to get the current origin in an SSR-safe way (avoids set-state-in-effect lint)
function useClientOrigin() {
  const subscribe = useMemo(() => (_onStoreChange: () => void) => {
    // origin never changes at runtime; no-op subscribe
    return () => {};
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => window.location.origin,
    () => '', // server snapshot
  );
}

function FriendlyLinkItem({ link }: { link: FriendlyLinkData }) {
  const origin = useClientOrigin();
  const isExternal = !origin || !link.url.startsWith(origin);

  return (
    <a
      href={link.url}
      target={isExternal ? '_blank' : undefined}
      rel={link.nofollow ? 'nofollow' : undefined}
      className="group/link inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground/70 transition-colors hover:bg-muted/50 hover:text-muted-foreground"
    >
      <span className="truncate max-w-[120px] sm:max-w-none">{link.title}</span>
      {isExternal && (
        <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-0 transition-opacity group-hover/link:opacity-60" />
      )}
    </a>
  );
}

// ─── Link Wheel Item (with animation key for re-render) ──────────────────────
function LinkWheelItem({ link, animKey }: { link: FriendlyLinkData; animKey: number }) {
  const origin = useClientOrigin();
  const isExternal = !origin || !link.url.startsWith(origin);

  return (
    <a
      key={animKey}
      href={link.url}
      target={isExternal ? '_blank' : undefined}
      rel={link.nofollow ? 'nofollow' : undefined}
      className="link-wheel-item group/wheel inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground/60 transition-all hover:bg-muted/50 hover:text-muted-foreground"
    >
      <Link2 className="h-2.5 w-2.5 shrink-0 text-muted-foreground/30 group-hover/wheel:text-muted-foreground/60" />
      <span className="truncate max-w-[100px] sm:max-w-[140px] md:max-w-none">{link.title}</span>
      {isExternal && (
        <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-0 transition-opacity group-hover/wheel:opacity-60" />
      )}
    </a>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export function FriendlyLinksFooter() {
  const [manualLinks, setManualLinks] = useState<FriendlyLinkData[]>([]);
  const [wheelLinks, setWheelLinks] = useState<FriendlyLinkData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [wheelKey, setWheelKey] = useState(0);
  const wheelTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch links on mount — inline async to satisfy react-hooks/set-state-in-effect
  useEffect(() => {
    const ac = new AbortController();
    const { signal } = ac;

    (async () => {
      try {
        const [manualData, wheelData] = await Promise.all([
          apiFetch<FriendlyLinkData[]>('/api/public/link-wheel?count=20&type=manual', { signal, silent: true }),
          apiFetch<FriendlyLinkData[]>('/api/public/link-wheel?count=20&type=site_home,site_novel', { signal, silent: true }),
        ]);
        if (signal.aborted) return;
        setManualLinks(manualData);
        setWheelLinks(wheelData);
        setLoading(false);
      } catch {
        if (signal.aborted) return;
        setError(true);
        setLoading(false);
      }
    })();

    return () => ac.abort();
  }, []);

  // Link wheel rotation: refetch wheel links every 10 seconds
  useEffect(() => {
    if (error || loading) return;
    if (wheelLinks.length === 0) return;

    wheelTimerRef.current = setInterval(async () => {
      try {
        const data = await apiFetch<FriendlyLinkData[]>('/api/public/link-wheel?count=20&type=site_home,site_novel', { silent: true, timeout: 5000 });
        setWheelLinks(data);
        setWheelKey((k) => k + 1);
      } catch {
        // Silently fail rotation - keep existing links
      }
    }, 10000);

    return () => {
      if (wheelTimerRef.current) clearInterval(wheelTimerRef.current);
    };
  }, [error, loading, wheelLinks.length]);

  // Don't render anything on error or if no links at all
  if (error) return null;
  if (loading) return <FooterLinksSkeleton />;
  if (manualLinks.length === 0 && wheelLinks.length === 0) return null;

  return (
    <div className="space-y-3">
      {/* Friendly Links Section */}
      {manualLinks.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground/50 uppercase tracking-wider">
            <span>友情链接</span>
          </div>
          <div className="flex flex-wrap gap-x-1 gap-y-0.5">
            {manualLinks.map((link, i) => (
              <FriendlyLinkItem key={`${link.url}-${i}`} link={link} />
            ))}
          </div>
        </div>
      )}

      {/* Link Wheel Section */}
      {wheelLinks.length > 0 && (
        <>
          {manualLinks.length > 0 && <Separator className="opacity-20" />}
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground/50 uppercase tracking-wider">
              <RefreshCw className="h-3 w-3" />
              <span>站群链轮</span>
            </div>
            <div className="link-wheel-container flex flex-wrap gap-x-1 gap-y-0.5 max-h-16 overflow-hidden relative">
              {wheelLinks.map((link, i) => (
                <LinkWheelItem key={`${wheelKey}-${i}`} link={link} animKey={wheelKey} />
              ))}
              {/* Fade overlay for overflow hint */}
              <div className="link-wheel-fade pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-background/80 to-transparent" />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
