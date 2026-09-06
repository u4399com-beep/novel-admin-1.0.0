'use client';

import { useState, useCallback } from 'react';
import { Download, Loader2, FileJson, FileText, FileSpreadsheet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export interface DataExportButtonProps {
  /** Called with the selected format when user clicks an export option */
  onExport: (format: string) => Promise<void>;
  /** Available export formats (default: json, csv, txt) */
  formats?: Array<{ key: string; label: string; icon?: React.ReactNode }>;
  label?: string;
  size?: 'sm' | 'default' | 'lg';
  variant?: 'default' | 'outline' | 'ghost';
}

const DEFAULT_FORMATS = [
  { key: 'json', label: 'JSON', icon: <FileJson className="h-3.5 w-3.5" /> },
  { key: 'csv', label: 'CSV', icon: <FileSpreadsheet className="h-3.5 w-3.5" /> },
  { key: 'txt', label: 'TXT', icon: <FileText className="h-3.5 w-3.5" /> },
];

export function DataExportButton({
  onExport,
  formats = DEFAULT_FORMATS,
  label = '导出数据',
  size = 'sm',
  variant = 'outline',
}: DataExportButtonProps) {
  const [loading, setLoading] = useState(false);
  const [activeFormat, setActiveFormat] = useState<string | null>(null);

  const handleExport = useCallback(async (format: string) => {
    if (loading) return;
    setLoading(true);
    setActiveFormat(format);
    try {
      await onExport(format);
    } finally {
      setLoading(false);
      setActiveFormat(null);
    }
  }, [loading, onExport]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={variant} size={size} disabled={loading} className="gap-1.5">
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 export-spinner" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          {loading ? `导出 ${activeFormat?.toUpperCase()}...` : label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        {formats.map((fmt) => (
          <DropdownMenuItem
            key={fmt.key}
            onClick={() => handleExport(fmt.key)}
            disabled={loading}
            className="gap-2 cursor-pointer"
          >
            {fmt.icon}
            <span>{fmt.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
