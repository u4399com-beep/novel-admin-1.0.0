'use client';

import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, Loader2, StickyNote } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch } from '@/lib/api-fetch';

interface Note {
  id: string;
  content: string;
  position: number;
  createdAt: string;
  chapterId: string;
}

interface NotesPanelProps {
  chapterId: string;
  visible: boolean;
  className?: string;
}

function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function NotesPanel({ chapterId, visible, className = '' }: NotesPanelProps) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(false);
  const [newNoteContent, setNewNoteContent] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const fetchNotes = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<Note[]>(`/api/chapters/${chapterId}/notes`);
      setNotes(data);
    } catch {
      // Silent fail for notes
    } finally {
      setLoading(false);
    }
  }, [chapterId]);

  useEffect(() => {
    if (visible && chapterId) {
      fetchNotes();
    }
  }, [visible, chapterId, fetchNotes]);

  const handleAddNote = async () => {
    if (!newNoteContent.trim()) return;
    setSubmitting(true);
    try {
      await apiFetch(`/api/chapters/${chapterId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: newNoteContent.trim(), position: 0 }),
      });
      setNewNoteContent('');
      setShowForm(false);
      fetchNotes();
    } catch {
      // Silent fail
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteNote = async (noteId: string) => {
    try {
      await apiFetch(`/api/chapters/${chapterId}/notes?noteId=${noteId}`, { method: 'DELETE' });
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
    } catch {
      // Silent fail
    }
  };

  if (!visible) return null;

  return (
    <div className={`w-72 shrink-0 border-l bg-card overflow-y-auto fade-in-up ${className}`}>
      <div className="p-4 notes-panel">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <StickyNote className="h-4 w-4 text-amber-500" />
            <h3 className="text-sm font-semibold">阅读笔记</h3>
            {notes.length > 0 && (
              <span className="text-xs text-muted-foreground">({notes.length})</span>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-amber-600 hover:text-amber-700 hover:bg-amber-500/10"
            onClick={() => setShowForm((p) => !p)}
            aria-label="添加笔记"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>

        {showForm && (
          <div className="mb-4 space-y-2">
            <Textarea
              placeholder="写下你的想法..."
              value={newNoteContent}
              onChange={(e) => setNewNoteContent(e.target.value)}
              className="min-h-[80px] text-sm"
              autoFocus
            />
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="text-xs h-7"
                onClick={() => { setShowForm(false); setNewNoteContent(''); }}
              >
                取消
              </Button>
              <Button
                size="sm"
                className="text-xs h-7 bg-amber-500 hover:bg-amber-600 text-white"
                onClick={handleAddNote}
                disabled={submitting || !newNoteContent.trim()}
              >
                {submitting && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
                保存
              </Button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : notes.length === 0 && !showForm ? (
          <div className="text-center py-8">
            <StickyNote className="h-8 w-8 mx-auto text-muted-foreground/30 mb-2" />
            <p className="text-xs text-muted-foreground">暂无笔记</p>
            <p className="text-[10px] text-muted-foreground/60 mt-1">点击 + 添加第一条笔记</p>
          </div>
        ) : (
          <div className="space-y-2">
            {notes.map((note) => (
              <div key={note.id} className="note-item rounded-md border border-border/50 p-3 group relative">
                <p className="text-sm text-foreground/90 whitespace-pre-wrap break-words line-clamp-4">
                  {note.content}
                </p>
                <div className="flex items-center justify-between mt-2">
                  <span className="note-timestamp">
                    {formatTime(note.createdAt)}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={() => handleDeleteNote(note.id)}
                    aria-label="删除笔记"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
