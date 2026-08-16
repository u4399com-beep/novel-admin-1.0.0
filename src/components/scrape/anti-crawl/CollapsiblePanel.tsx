'use client';

import React, { type ReactNode } from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// ─── CSS Keyframes (injected once) ─────────────────────────────────────────

const STYLE_ID = 'collapsible-panel-animations';

if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    @keyframes cp-fade-in {
      from { opacity: 0; transform: translateY(-4px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .cp-fade-in {
      animation: cp-fade-in 0.25s ease-out;
    }
    @keyframes cp-grade-pulse-green {
      0%, 100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.3); }
      50%      { box-shadow: 0 0 0 4px rgba(16, 185, 129, 0); }
    }
    @keyframes cp-grade-pulse-red {
      0%, 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.3); }
      50%      { box-shadow: 0 0 0 4px rgba(239, 68, 68, 0); }
    }
    .cp-grade-pulse-green { animation: cp-grade-pulse-green 2s ease-in-out infinite; }
    .cp-grade-pulse-red   { animation: cp-grade-pulse-red 2s ease-in-out infinite; }
    @keyframes cp-dot-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50%      { opacity: 0.5; transform: scale(1.8); }
    }
    .cp-dot-pulse { animation: cp-dot-pulse 2s ease-in-out infinite; }
    @keyframes cp-ring-draw {
      from { stroke-dashoffset: var(--ring-circumference); }
      to   { stroke-dashoffset: var(--ring-target-offset); }
    }
    .cp-ring-animate {
      animation: cp-ring-draw 0.8s ease-out forwards;
    }
    @keyframes cp-signal-slide-in {
      from { opacity: 0; transform: translateX(-10px); }
      to   { opacity: 1; transform: translateX(0); }
    }
    @keyframes cp-rec-fade-in {
      from { opacity: 0; transform: translateY(6px); }
      to   { opacity: 1; transform: translateY(0); }
    }
  `;
  document.head.appendChild(style);
}

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
