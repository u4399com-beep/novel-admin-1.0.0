'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Plus, Trash2, Loader2, StickyNote, Star, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { apiFetch, FetchError } from '@/lib/api-fetch';
import { getSessionId } from '@/lib/reading-session';

interface Note {
  id: string;
  content: string;
  position: number;
  createdAt: string;
  chapterId: string;
}

interface ChapterNoteData {
  content: string;
  rating: number | null;
  updatedAt: string;
}

interface NotesPanelProps {
  chapterId: string;
  visible: boolean;
  className?: string;
  /** Current reading scroll position (character offset or percentage) for note context */
  readingPosition?: number;
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

export function NotesPanel({ chapterId, visible, className = '', readingPosition = 0 }: NotesPanelProps) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(false);
  const [newNoteContent, setNewNoteContent] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // ── Per-chapter note (with rating) state ──
  const [chapterNote, setChapterNote] = useState<ChapterNoteData | null>(null);
  const [noteText, setNoteText] = useState('');
  const [noteRating, setNoteRating] = useState<number | null>(null);
  const [hoveredStar, setHoveredStar] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [noteLoaded, setNoteLoaded] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchNotes = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const data = await apiFetch<Note[]>(`/api/chapters/${chapterId}/notes`, { signal });
      setNotes(data);
    } catch {
      // Silent fail for notes
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [chapterId]);

  // Fetch per-chapter note
  const fetchChapterNote = useCallback(async (signal?: AbortSignal) => {
    const sid = getSessionId();
    if (!sid) {
      setNoteLoaded(true);
      return;
    }
    try {
      const data = await apiFetch<ChapterNoteData>(
        `/api/chapters/${chapterId}/note?sessionId=${encodeURIComponent(sid)}`,
        { signal, silent: true },
      );
      setChapterNote(data);
      setNoteText(data.content || '');
      setNoteRating(data.rating);
    } catch (err) {
      if (err instanceof FetchError && err.status === 404) {
        setChapterNote(null);
        setNoteText('');
        setNoteRating(null);
      }
    } finally {
      if (!signal?.aborted) setNoteLoaded(true);
    }
  }, [chapterId]);

  // Save per-chapter note
  const saveChapterNote = useCallback(async (content: string, rating: number | null) => {
    const sid = getSessionId();
    if (!sid) return;
    setSaving(true);
    try {
      const data = await apiFetch<ChapterNoteData>(`/api/chapters/${chapterId}/note`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sid, content, rating }),
        silent: true,
      });
      setChapterNote(data);
    } catch {
      // Silent fail
    } finally {
      setSaving(false);
    }
  }, [chapterId]);

  // Debounced auto-save on blur
  const handleNoteBlur = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (noteText !== (chapterNote?.content || '')) {
        saveChapterNote(noteText, noteRating);
      }
    }, 500);
  }, [noteText, noteRating, chapterNote?.content, saveChapterNote]);

  // Handle rating click
  const handleRatingClick = useCallback((star: number) => {
    const newRating = noteRating === star ? null : star;
    setNoteRating(newRating);
    saveChapterNote(noteText, newRating);
  }, [noteRating, noteText, saveChapterNote]);

  // Handle clear note
  const handleClearNote = useCallback(async () => {
    setShowClearConfirm(false);
    setNoteText('');
    setNoteRating(null);
    await saveChapterNote('', null);
  }, [saveChapterNote]);

  // Handle explicit save
  const handleSave = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    saveChapterNote(noteText, noteRating);
  }, [noteText, noteRating, saveChapterNote]);

  useEffect(() => {
    if (visible && chapterId) {
      setNoteLoaded(false);
      const ac = new AbortController();
      fetchNotes(ac.signal);
      fetchChapterNote(ac.signal);
      return () => ac.abort();
    }
  }, [visible, chapterId, fetchNotes, fetchChapterNote]);

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handleAddNote = async () => {
    if (!newNoteContent.trim()) return;
    setSubmitting(true);
    try {
      await apiFetch(`/api/chapters/${chapterId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: newNoteContent.trim(), position: readingPosition }),
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

  const displayStars = hoveredStar ?? noteRating;
  const hasUnsavedChanges = noteText !== (chapterNote?.content || '') || noteRating !== (chapterNote?.rating ?? null);

  return (
    <div className={`w-72 shrink-0 border-l bg-card overflow-y-auto fade-in-up ${className}`}>
      <div className="p-4 notes-panel">
        {/* ── Per-chapter note editor ── */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <StickyNote className="h-4 w-4 text-amber-500" />
              <h3 className="text-sm font-semibold">章节笔记</h3>
            </div>
            <div className="flex items-center gap-1">
              {saving && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
              {hasUnsavedChanges && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-amber-600 hover:text-amber-700 hover:bg-amber-500/10"
                  onClick={handleSave}
                  disabled={saving}
                  aria-label="保存笔记"
                >
                  <Save className="h-3 w-3" />
                </Button>
              )}
            </div>
          </div>

          {/* Star rating */}
          <div className="flex items-center gap-1 mb-3">
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                key={star}
                className="p-0.5 transition-transform hover:scale-110"
                onMouseEnter={() => setHoveredStar(star)}
                onMouseLeave={() => setHoveredStar(null)}
                onClick={() => handleRatingClick(star)}
                aria-label={`评${star}星`}
              >
                <Star
                  className={`h-5 w-5 transition-colors ${
                    (displayStars ?? 0) >= star
                      ? 'text-amber-400 fill-amber-400'
                      : 'text-muted-foreground/30'
                  }`}
                />
              </button>
            ))}
            {noteRating && (
              <span className="text-xs text-muted-foreground ml-1">{noteRating}分</span>
            )}
          </div>

          {/* Note textarea */}
          {!noteLoaded ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <Textarea
              placeholder="写下你对这章的感想..."
              value={noteText}
              onChange={(e) => {
                const val = e.target.value;
                if (val.length <= 2000) setNoteText(val);
              }}
              onBlur={handleNoteBlur}
              className="min-h-[100px] text-sm resize-none"
            />
          )}
          {noteText && (
            <div className="flex items-center justify-between mt-2">
              <span className="text-[10px] text-muted-foreground">
                {noteText.length}/2000
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs h-6 text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                onClick={() => setShowClearConfirm(true)}
              >
                清除笔记
              </Button>
            </div>
          )}

          {/* Clear confirmation */}
          {showClearConfirm && (
            <div className="mt-2 p-2.5 rounded-md border border-destructive/30 bg-destructive/5">
              <p className="text-xs text-destructive mb-2">确定要清除这条笔记吗？</p>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs h-6"
                  onClick={() => setShowClearConfirm(false)}
                >
                  取消
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  className="text-xs h-6"
                  onClick={handleClearNote}
                >
                  确定清除
                </Button>
              </div>
            </div>
          )}

          {chapterNote?.updatedAt && noteLoaded && (chapterNote.content || chapterNote.rating) && (
            <p className="text-[10px] text-muted-foreground/60 mt-1.5">
              {formatTime(chapterNote.updatedAt)} 保存
            </p>
          )}
        </div>

        <Separator className="mb-4" />

        {/* ── Inline reading notes (original feature) ── */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">段落笔记</h3>
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
            <p className="text-xs text-muted-foreground">暂无段落笔记</p>
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
