'use client';

import React, { type ReactNode } from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CollapsiblePanelProps {
  icon: LucideIcon;
  title: string;
  /** Right-side badges / extra header content */
  badges?: ReactNode;
  /** Show loading spinner in header */
  loading?: boolean;
  /** Default expanded state */
  defaultExpanded?: boolean;
  /** Controlled expanded state */
  expanded?: boolean;
  /** Callback when expanded state changes */
  onExpandedChange?: (expanded: boolean) => void;
  /** Panel content (shown when expanded) */
  children: ReactNode;
  /** Optional extra className for the wrapper */
  className?: string;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function CollapsiblePanel({
  icon: Icon,
  title,
  badges,
  loading = false,
  defaultExpanded = false,
  expanded: controlledExpanded,
  onExpandedChange,
  children,
  className = '',
}: CollapsiblePanelProps) {
  // Support both controlled and uncontrolled modes
  const [internalExpanded, setInternalExpanded] = React.useState(defaultExpanded);
  const isExpanded = controlledExpanded !== undefined ? controlledExpanded : internalExpanded;

  const handleToggle = () => {
    const next = !isExpanded;
    if (controlledExpanded === undefined) {
      setInternalExpanded(next);
    }
    onExpandedChange?.(next);
  };

  return (
    <div className={`rounded-lg border bg-background/50 overflow-hidden ${className}`}>
      {/* Header */}
      <button
        onClick={handleToggle}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors text-left"
      >
        <div className="flex items-center gap-2.5">
          <Icon className="h-4 w-4 text-primary" />
          <span className="text-xs font-medium">{title}</span>
          {badges}
        </div>
        <div className="flex items-center gap-1.5">
          {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
          <ChevronDown
            className="h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 ease-out"
            style={{ transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
          />
        </div>
      </button>

      {/* Content - CSS grid-template-rows transition */}
      <div
        style={{
          display: 'grid',
          gridTemplateRows: isExpanded ? '1fr' : '0fr',
          transition: 'grid-template-rows 0.25s ease-out',
        }}
      >
        <div className="overflow-hidden">
          <div className={`border-t px-4 py-3 space-y-3 ${isExpanded ? 'cp-fade-in' : ''}`}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
