import { create } from "zustand";
import type { ViewType, Novel, Chapter, Category, Tag, DashboardStats, Theme, Site } from "@/types";

interface AppState {
  // Navigation
  currentView: ViewType;
  setCurrentView: (view: ViewType) => void;

  // Selected novel for detail view
  selectedNovelId: string | null;
  setSelectedNovelId: (id: string | null) => void;
  selectedNovel: Novel | null;
  setSelectedNovel: (novel: Novel | null) => void;

  // Selected chapter for editing
  selectedChapterId: string | null;
  setSelectedChapterId: (id: string | null) => void;

  // Sidebar
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;

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
  refreshNovels: number;
  triggerRefreshNovels: () => void;
  refreshChapters: number;
  triggerRefreshChapters: () => void;
  refreshCategories: number;
  triggerRefreshCategories: () => void;
  refreshTags: number;
  triggerRefreshTags: () => void;
  refreshDashboard: number;
  triggerRefreshDashboard: () => void;

  // Categories and tags for forms
  categories: Category[];
  setCategories: (cats: Category[]) => void;
  tags: Tag[];
  setTags: (t: Tag[]) => void;

  // Dashboard
  dashboardStats: DashboardStats | null;
  setDashboardStats: (stats: DashboardStats) => void;

  // Theme form dialog
  themeFormOpen: boolean;
  setThemeFormOpen: (open: boolean) => void;
  editingTheme: Theme | null;
  setEditingTheme: (theme: Theme | null) => void;

  // Site form dialog
  siteFormOpen: boolean;
  setSiteFormOpen: (open: boolean) => void;
  editingSite: Site | null;
  setEditingSite: (site: Site | null) => void;

  // Command palette
  commandPaletteOpen: boolean;
  setCommandPaletteOpen: (open: boolean) => void;

  // More refresh triggers
  refreshThemes: number;
  triggerRefreshThemes: () => void;
  refreshSites: number;
  triggerRefreshSites: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  // Navigation
  currentView: "dashboard",
  setCurrentView: (view) =>
    set({ currentView: view, selectedNovelId: null, selectedNovel: null, selectedChapterId: null }),

  selectedNovelId: null,
  setSelectedNovelId: (id) => set({ selectedNovelId: id, selectedChapterId: null }),
  selectedNovel: null,
  setSelectedNovel: (novel) => set({ selectedNovel: novel }),

  selectedChapterId: null,
  setSelectedChapterId: (id) => set({ selectedChapterId: id }),

  // Sidebar
  sidebarOpen: true,
  setSidebarOpen: (open) => set({ sidebarOpen: open }),

  // Novel form
  novelFormOpen: false,
  setNovelFormOpen: (open) => set({ novelFormOpen: open, editingNovel: open ? undefined : null }),
  editingNovel: null,
  setEditingNovel: (novel) => set({ editingNovel: novel, novelFormOpen: novel !== null }),

  // Chapter form
  chapterFormOpen: false,
  setChapterFormOpen: (open) => set({ chapterFormOpen: open, editingChapter: undefined }),
  editingChapter: null,
  setEditingChapter: (chapter) => set({ editingChapter: chapter, chapterFormOpen: chapter !== null }),

  // Refresh triggers
  refreshNovels: 0,
  triggerRefreshNovels: () => set((s) => ({ refreshNovels: s.refreshNovels + 1 })),
  refreshChapters: 0,
  triggerRefreshChapters: () => set((s) => ({ refreshChapters: s.refreshChapters + 1 })),
  refreshCategories: 0,
  triggerRefreshCategories: () => set((s) => ({ refreshCategories: s.refreshCategories + 1 })),
  refreshTags: 0,
  triggerRefreshTags: () => set((s) => ({ refreshTags: s.refreshTags + 1 })),
  refreshDashboard: 0,
  triggerRefreshDashboard: () => set((s) => ({ refreshDashboard: s.refreshDashboard + 1 })),

  // Categories and tags
  categories: [],
  setCategories: (cats) => set({ categories: cats }),
  tags: [],
  setTags: (t) => set({ tags: t }),

  // Dashboard
  dashboardStats: null,
  setDashboardStats: (stats) => set({ dashboardStats: stats }),

  // Theme form
  themeFormOpen: false,
  setThemeFormOpen: (open) => set({ themeFormOpen: open, editingTheme: open ? undefined : null }),
  editingTheme: null,
  setEditingTheme: (theme) => set({ editingTheme: theme, themeFormOpen: theme !== null }),

  // Site form
  siteFormOpen: false,
  setSiteFormOpen: (open) => set({ siteFormOpen: open, editingSite: open ? undefined : null }),
  editingSite: null,
  setEditingSite: (site) => set({ editingSite: site, siteFormOpen: site !== null }),

  // Command palette
  commandPaletteOpen: false,
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),

  // More refresh triggers
  refreshThemes: 0,
  triggerRefreshThemes: () => set((s) => ({ refreshThemes: s.refreshThemes + 1 })),
  refreshSites: 0,
  triggerRefreshSites: () => set((s) => ({ refreshSites: s.refreshSites + 1 })),
}));