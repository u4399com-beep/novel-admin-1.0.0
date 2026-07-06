export type NovelStatus = "ongoing" | "completed" | "hiatus";

export interface Category {
  id: string;
  name: string;
  description: string | null;
  color: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  _count?: { novels: number };
}

export interface Tag {
  id: string;
  name: string;
  color: string;
  createdAt: string;
  updatedAt: string;
  _count?: { novels: number };
}

export interface Novel {
  id: string;
  title: string;
  author: string;
  description: string | null;
  coverUrl: string | null;
  status: NovelStatus;
  categoryId: string | null;
  category: Category | null;
  tags: { tag: Tag }[];
  wordCount: number;
  createdAt: string;
  updatedAt: string;
  _count?: { chapters: number };
}

export interface Chapter {
  id: string;
  title: string;
  content: string | null;
  wordCount: number;
  sortOrder: number;
  novelId: string;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardStats {
  totalNovels: number;
  totalChapters: number;
  totalWords: number;
  totalCategories: number;
  recentNovels: Novel[];
  statusDistribution: { status: string; count: number }[];
}

export interface ThemeColors {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  muted: string;
  mutedForeground: string;
  border: string;
  ring: string;
}

export interface ThemeLayout {
  maxWidth: string;
  sidebarPosition: "left" | "right";
  cardStyle: "rounded" | "flat" | "elevated" | "bordered";
  headerStyle: "fixed" | "static";
  gridColumns: 3 | 4;
}

export interface ThemeTypography {
  headingFont: "sans" | "serif" | "mono";
  bodyFont: "sans" | "serif" | "mono";
  headingWeight: 700 | 800;
  lineHeight: 1.5 | 1.6 | 1.75;
}

export interface ThemeSEO {
  defaultTitle: string;
  titleTemplate: string;
  defaultDescription: string;
  defaultKeywords: string;
}

export interface ThemeGeo {
  region: string;
  placename: string;
  position: string;
}

export interface ThemeConfig {
  colors: ThemeColors;
  layout: ThemeLayout;
  typography: ThemeTypography;
  seo: ThemeSEO;
  geo: ThemeGeo;
}

export interface Theme {
  id: string;
  name: string;
  description: string | null;
  identifier: string;
  preview: string | null;
  config: ThemeConfig;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  _count?: { sites: number };
}

export interface Site {
  id: string;
  domain: string;
  name: string;
  description: string | null;
  themeId: string | null;
  theme: Theme | null;
  enabled: boolean;
  siteTitle: string | null;
  siteDescription: string | null;
  siteKeywords: string | null;
  geoConfig: ThemeGeo | null;
  novelOffset: number;
  chapterOffset: number;
  customConfig: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ViewType = "dashboard" | "novels" | "novel-detail" | "categories" | "tags" | "scrape" | "download" | "themes" | "sites";

export interface DownloadConfig {
  id: string;
  name: string;
  enabled: boolean;
  format: string;
  insertConfusion: boolean;
  confusionText: string | null;
  insertAd: boolean;
  adContent: string | null;
  adInterval: number;
  adPosition: string;
  insertSiteInfo: boolean;
  siteInfoContent: string | null;
  fileNamePattern: string;
  createdAt: string;
  updatedAt: string;
}

export interface SearchKeyword {
  id: string;
  novelId: string;
  keyword: string;
  source: string;
  createdAt: string;
}