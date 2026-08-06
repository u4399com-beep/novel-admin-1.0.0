'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

export function SelectorCard({ label, selector, editable = false }: {
  label: string;
  selector: { type: string; value: string } | undefined;
  editable?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');

  const startEditing = () => {
    setEditValue(selector?.value || '');
    setEditing(true);
  };

  const stopEditing = () => setEditing(false);

  const displayValue = editing ? editValue : (selector?.value || '');

  return (
    <div className="flex items-center gap-3 rounded-lg border bg-muted/20 px-3 py-2">
      <span className="text-xs font-medium text-muted-foreground w-24 shrink-0">
        {label}
      </span>
      {editing ? (
        <Input
          className="flex-1 h-7 text-xs font-mono"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={stopEditing}
          onKeyDown={(e) => e.key === 'Enter' && stopEditing()}
          autoFocus
        />
      ) : (
        <code
          className={`flex-1 text-xs font-mono truncate cursor-pointer hover:text-primary transition-colors ${
            displayValue ? 'text-foreground/70' : 'text-muted-foreground italic'
          }`}
          onClick={() => editable && startEditing()}
          title={editable ? '点击编辑' : undefined}
        >
          {displayValue || '(未设置)'}
        </code>
      )}
      {selector?.type && (
        <Badge variant="outline" className="shrink-0 text-[10px] h-5 px-1.5">
          {selector.type}
        </Badge>
      )}
    </div>
  );
}
