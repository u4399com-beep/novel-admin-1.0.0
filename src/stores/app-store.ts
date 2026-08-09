import { create } from "zustand";
import type { ViewType, Novel, Chapter, Category, Tag } from "@/types";

interface AppState {
  // Navigation
  currentView: ViewType;
  setCurrentView: (view: ViewType) => void;

  // Selected novel for detail view
  selectedNovelId: string | null;
  selectNovel: (novel: Novel | null) => void;

  // Selected chapter for editing
  selectedChapterId: string | null;
  setSelectedChapterId: (id: string | null) => void;

  // Novel form dialog
  novelFormOpen: boolean;
  setNovelFormOpen: (open: boolean) => void;
  editingNovel: Novel | null;
  setEditingNovel: (novel: Novel | null) => void;

  // Chapter form dialog
  chapterFormOpen: boolean;
  setChapterFormOpen: (open: boolean) => void;
  editingChapter: Chapter | null;
  setEditingChapter: (chapter: Chapter | null) => void;

  // Refresh triggers
  refreshVersions: Record<string, number>;
  triggerRefresh: (key: string) => void;

  // Categories and tags for forms
  categories: Category[];
  setCategories: (cats: Category[]) => void;
  tags: Tag[];
  setTags: (t: Tag[]) => void;

  // Command palette
  commandPaletteOpen: boolean;
  setCommandPaletteOpen: (open: boolean) => void;

}

export const useAppStore = create<AppState>((set) => ({
  // Navigation
  currentView: "dashboard",
  setCurrentView: (view) =>
    set({ currentView: view, selectedNovelId: null, selectedChapterId: null }),

  selectedNovelId: null,
  selectNovel: (novel) => set({ selectedNovelId: novel?.id ?? null, selectedChapterId: null }),

  selectedChapterId: null,
  setSelectedChapterId: (id) => set({ selectedChapterId: id }),

  // Novel form
  novelFormOpen: false,
  setNovelFormOpen: (open) => set({ novelFormOpen: open, ...(open && { editingNovel: null }) }),
  editingNovel: null,
  setEditingNovel: (novel) => set({ editingNovel: novel, novelFormOpen: novel !== null }),

  // Chapter form
  chapterFormOpen: false,
  setChapterFormOpen: (open) => set({ chapterFormOpen: open, editingChapter: null }),
  editingChapter: null,
  setEditingChapter: (chapter) => set({ editingChapter: chapter, chapterFormOpen: chapter !== null }),

  // Refresh triggers
  refreshVersions: {},
  triggerRefresh: (key) =>
    set((s) => ({
      refreshVersions: { ...s.refreshVersions, [key]: (s.refreshVersions[key] ?? 0) + 1 },
    })),

  // Categories and tags
  categories: [],
  setCategories: (cats) => set({ categories: cats }),
  tags: [],
  setTags: (t) => set({ tags: t }),

  // Command palette
  commandPaletteOpen: false,
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
}));