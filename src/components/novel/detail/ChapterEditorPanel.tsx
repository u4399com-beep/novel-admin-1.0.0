'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2, Save, X, Type, CheckCircle2 } from 'lucide-react';
import { formatReadingTime } from '@/lib/format';
import { apiFetch } from '@/lib/api-fetch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import type { Chapter } from '@/types';

export interface ChapterEditorPanelProps {
  chapter: Chapter | null;
  onClose: () => void;
  onSaved: (updated?: { id?: string; wordCount?: number; title?: string }) => void;
}

export function ChapterEditorPanel({ chapter, onClose, onSaved }: ChapterEditorPanelProps) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialLoadRef = useRef(false);
  const dirtyRef = useRef(false);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
      if (saveStatusTimerRef.current) clearTimeout(saveStatusTimerRef.current);
    };
  }, []);

  // Load chapter content when selected
  useEffect(() => {
    if (!chapter) {
      setTitle('');
      setContent('');
      setSaveStatus('idle');
      initialLoadRef.current = false;
      return;
    }

    // Fetch full chapter content
    const ac = new AbortController();
    const loadChapter = async () => {
      try {
        const data = await apiFetch<{ title: string; content: string }>(`/api/chapters/${chapter.id}`, { signal: ac.signal });
        setTitle(data.title);
        setContent(data.content || '');
        initialLoadRef.current = true;
        dirtyRef.current = false;
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        /* handled by apiFetch */
      }
    };

    loadChapter();
    return () => ac.abort();
  }, [chapter]);

  // Auto-save debounce
  // NOTE: Uses a ref-based guard instead of a closure `saving` variable
  // to avoid stale closure issues when the user types quickly.
  const savingRef = useRef(false);
  const saveChapter = useCallback(
    async (newTitle: string, newContent: string) => {
      if (!chapter || !initialLoadRef.current) return;
      if (savingRef.current) return;

      savingRef.current = true;
      setSaving(true);
      setSaveStatus('saving');

      try {
        const wordCount = newContent.length;
        await apiFetch(`/api/chapters/${chapter.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: newTitle,
            content: newContent,
            wordCount,
          }),
        });

        setSaveStatus('saved');
        if (saveStatusTimerRef.current) clearTimeout(saveStatusTimerRef.current);
        saveStatusTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2000);
        onSaved({ id: chapter.id, wordCount, title: newTitle });
      } catch {
        setSaveStatus('idle');
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [chapter, onSaved],
  );

  // Mark dirty on user input (not on initial API load)
  const handleTitleChange = useCallback((v: string) => { setTitle(v); dirtyRef.current = true; }, []);
  const handleContentChange = useCallback((v: string) => { setContent(v); dirtyRef.current = true; }, []);

  // Auto-save on content change (only if user has actually edited)
  useEffect(() => {
    if (!chapter || !initialLoadRef.current || !dirtyRef.current) return;

    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
    }

    autoSaveTimerRef.current = setTimeout(() => {
      saveChapter(title, content);
    }, 1500);

    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
      }
    };
  }, [title, content, chapter, saveChapter]);

  const handleManualSave = async () => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
    }
    await saveChapter(title, content);
  };

  if (!chapter) return null;

  const wordCount = content.length;
  const charCount = content.replace(/\s/g, '').length;

  return (
    <div className="flex flex-col h-full">
      {/* Editor header */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/30">
        <div className="flex items-center gap-2 min-w-0">
          <Type className="size-4 text-muted-foreground shrink-0" />
          <Input
            value={title}
            onChange={(e) => handleTitleChange(e.target.value)}
            className="h-8 text-sm font-medium border-0 bg-transparent focus-visible:ring-0 px-1"
            placeholder="章节标题"
          />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* Auto-save indicator */}
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {saveStatus === 'saving' && (
              <>
                <Loader2 className="size-3 animate-spin" />
                <span>保存中...</span>
              </>
            )}
            {saveStatus === 'saved' && (
              <>
                <CheckCircle2 className="size-3 text-emerald-500" />
                <span className="text-emerald-600 dark:text-emerald-400">已保存</span>
              </>
            )}
            {saveStatus === 'idle' && (
              <span className="tabular-nums">{wordCount.toLocaleString()} 字{formatReadingTime(wordCount) && ` · ${formatReadingTime(wordCount)}`}</span>
            )}
          </div>
          <Separator orientation="vertical" className="h-4" />
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="关闭"
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>

      {/* Editor content */}
      <div className="flex-1 overflow-hidden relative">
        <Textarea
          value={content}
          onChange={(e) => handleContentChange(e.target.value)}
          className="absolute inset-0 resize-none rounded-none border-0 shadow-none focus-visible:ring-0 p-4 font-mono text-sm leading-loose min-h-full h-full"
          placeholder="开始编写章节内容..."
        />
      </div>

      {/* Editor footer */}
      <div className="flex items-center justify-between px-4 py-2 border-t bg-muted/30 text-xs text-muted-foreground">
        <div className="flex items-center gap-4">
          <span>字数: {wordCount.toLocaleString()}</span>
          <span>字符 (不含空格): {charCount.toLocaleString()}</span>
        </div>
        <Button
          size="sm"
          onClick={handleManualSave}
          disabled={saving}
          className="h-7 text-xs"
        >
          <Save className="size-3" />
          手动保存
        </Button>
      </div>
    </div>
  );
}
