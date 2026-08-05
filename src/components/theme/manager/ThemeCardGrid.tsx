'use client';

import { Eye, Pencil, Trash2, Star } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ThemePreviewCard } from '@/components/theme/ThemePreviewCard';
import type { Theme, ThemeConfig } from '@/types';
import { tryParseJSON, defaultThemeConfig } from './helpers';

interface ThemeItem extends Theme {
  config: string | ThemeConfig;
  _count?: { sites: number };
}

interface ThemeCardGridProps {
  themes: ThemeItem[];
  onPreview: (config: ThemeConfig, name: string) => void;
  onEdit: (theme: Theme) => void;
  onDelete: (id: string) => void;
}

function getThemeConfig(theme: ThemeItem): ThemeConfig {
  return typeof theme.config === 'string'
    ? ((tryParseJSON(theme.config) as ThemeConfig) ?? defaultThemeConfig())
    : theme.config;
}

export function ThemeCardGrid({ themes, onPreview, onEdit, onDelete }: ThemeCardGridProps) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
      <AnimatePresence mode="popLayout">
        {themes.map((theme) => {
          const config = getThemeConfig(theme);
          const siteCount = theme._count?.sites ?? 0;

          return (
            <motion.div
              key={theme.id}
              layout
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.2 }}
            >
              <Card className="overflow-hidden group hover:shadow-lg transition-shadow duration-300">
                <CardContent className="p-0">
                  {/* Preview */}
                  <div className="p-4 pb-3">
                    <ThemePreviewCard config={config} name={theme.name} />
                  </div>

                  {/* Info */}
                  <div className="px-4 pb-2">
                    {/* Color swatch bar */}
                    <div className="flex items-center gap-1.5 mb-3">
                      {[
                        config.colors.primary,
                        config.colors.secondary,
                        config.colors.accent,
                        config.colors.background,
                        config.colors.muted,
                      ].map((color, i) => (
                        <div
                          key={i}
                          className="h-5 flex-1 rounded-sm border"
                          style={{ background: color, borderColor: config.colors.border }}
                          title={color}
                        />
                      ))}
                    </div>

                    <div className="flex items-start justify-between gap-2 mb-1.5">
                      <h4 className="font-semibold text-sm leading-tight">{theme.name}</h4>
                      <Badge variant="secondary" className="text-[10px] shrink-0">
                        {theme.identifier}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-2 mb-2">
                      {theme.description || '暂无描述'}
                    </p>
                    <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Star className="h-3 w-3" />
                        {siteCount} 个站点使用
                      </span>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center border-t divide-x">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="flex-1 h-9 rounded-none text-xs gap-1"
                      onClick={() => onPreview(config, theme.name)}
                    >
                      <Eye className="h-3.5 w-3.5" />
                      预览
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="flex-1 h-9 rounded-none text-xs gap-1"
                      onClick={() => onEdit(theme)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      编辑
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="flex-1 h-9 rounded-none text-xs gap-1 text-destructive hover:text-destructive"
                      onClick={() => onDelete(theme.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      删除
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
