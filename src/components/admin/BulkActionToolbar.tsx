'use client';

import { useState, useCallback } from 'react';
import { CheckSquare, Square, Trash2, Download, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface BulkActionToolbarProps {
  /** Total number of selectable items */
  totalItems: number;
  /** Currently selected item IDs */
  selectedIds: Set<string>;
  /** Callback when selection changes */
  onSelectionChange: (ids: Set<string>) => void;
  /** Bulk delete handler */
  onBulkDelete?: (ids: string[]) => void;
  /** Bulk export handler */
  onBulkExport?: (ids: string[]) => void;
  /** Bulk refresh/retry handler */
  onBulkRefresh?: (ids: string[]) => void;
  /** Available actions */
  actions?: ('delete' | 'export' | 'refresh')[];
}

export function BulkActionToolbar({
  totalItems,
  selectedIds,
  onSelectionChange,
  onBulkDelete,
  onBulkExport,
  onBulkRefresh,
  actions = ['delete', 'export', 'refresh'],
}: BulkActionToolbarProps) {
  const [visible, setVisible] = useState(false);
  const count = selectedIds.size;

  const selectAll = useCallback(() => {
    // Caller should provide all IDs; here we just signal intent
    setVisible(true);
  }, []);

  const clearSelection = useCallback(() => {
    onSelectionChange(new Set());
    setVisible(false);
  }, [onSelectionChange]);

  const toggleSelectAll = useCallback(() => {
    if (count === totalItems && count > 0) {
      clearSelection();
    } else {
      selectAll();
    }
  }, [count, totalItems, clearSelection, selectAll]);

  if (count === 0 && !visible) {
    return (
      <div className="flex items-center gap-2 py-1">
        <button
          onClick={toggleSelectAll}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          aria-label="全选"
        >
          <Square className="h-3.5 w-3.5" />
          全选
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 py-2 px-3 rounded-lg bg-primary/5 border border-primary/10 bulk-toolbar-enter">
      <button
        onClick={toggleSelectAll}
        className="flex items-center gap-1.5 text-xs text-primary"
        aria-label={count === totalItems ? '取消全选' : '全选'}
      >
        <CheckSquare className="h-3.5 w-3.5" />
        {count === totalItems ? '取消全选' : '全选'}
      </button>

      <span className="text-xs text-muted-foreground tabular-nums">
        已选 {count} 项
      </span>

      <div className="flex-1" />

      <div className="flex items-center gap-1">
        {actions.includes('refresh') && onBulkRefresh && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs gap-1"
            onClick={() => onBulkRefresh([...selectedIds])}
          >
            <RefreshCw className="h-3 w-3" />
            刷新
          </Button>
        )}
        {actions.includes('export') && onBulkExport && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs gap-1"
            onClick={() => onBulkExport([...selectedIds])}
          >
            <Download className="h-3 w-3" />
            导出
          </Button>
        )}
        {actions.includes('delete') && onBulkDelete && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs gap-1 text-destructive hover:text-destructive"
            onClick={() => onBulkDelete([...selectedIds])}
          >
            <Trash2 className="h-3 w-3" />
            删除
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={clearSelection}
          aria-label="取消选择"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
