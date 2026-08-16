'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api-fetch';
import { Globe } from 'lucide-react';

interface ScrapeRuleOption {
  id: string;
  name: string;
  listUrl: string | null;
  engine: string;
}

interface RuleSelectorProps {
  selectedRuleId: string | null;
  onSelect: (ruleId: string, domain: string) => void;
  className?: string;
}

function extractDomain(url: string | null): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.hostname;
  } catch {
    return '';
  }
}

export function RuleSelector({ selectedRuleId, onSelect, className }: RuleSelectorProps) {
  const [rules, setRules] = useState<ScrapeRuleOption[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchRules = useCallback(async () => {
    try {
      setLoading(true);
      // Fetch all rules (pageSize=200 to get them all)
      const data = await apiFetch<{ rules: ScrapeRuleOption[] }>('/api/scrape-rules?pageSize=200', {
        silent: true,
        timeout: 8000,
      });
      setRules(data.rules || []);
    } catch {
      setRules([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRules();
  }, [fetchRules]);

  const handleValueChange = useCallback((value: string) => {
    const rule = rules.find((r) => r.id === value);
    if (rule) {
      const domain = extractDomain(rule.listUrl);
      onSelect(rule.id, domain);
    }
  }, [rules, onSelect]);

  if (loading) {
    return (
      <div className={`flex items-center gap-2 ${className ?? ''}`}>
      <Skeleton className="h-8 w-[220px]" />
      </div>
    );
  }

  if (rules.length === 0) {
    return null;
  }

  return (
    <Select value={selectedRuleId ?? ''} onValueChange={handleValueChange}>
      <SelectTrigger className={`h-8 text-xs w-[260px] ${className ?? ''}`}>
        <SelectValue placeholder="选择采集规则..." />
      </SelectTrigger>
      <SelectContent className="max-h-60">
        {rules.map((rule) => {
          const domain = extractDomain(rule.listUrl);
          return (
            <SelectItem key={rule.id} value={rule.id} className="text-xs">
              <div className="flex items-center gap-2 min-w-0">
                <span className="truncate font-medium">{rule.name}</span>
                {domain && (
                  <Badge variant="secondary" className="text-[9px] px-1.5 py-0 font-mono shrink-0 gap-0.5">
                    <Globe className="h-2.5 w-2.5" />
                    {domain}
                  </Badge>
                )}
              </div>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
