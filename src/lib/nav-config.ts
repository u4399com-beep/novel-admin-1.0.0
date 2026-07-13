import { LayoutDashboard, BookOpen, FolderTree, Tags, Bug, Download, Palette, Globe } from "lucide-react";
import type { ViewType } from "@/types";

export interface NavItem {
  key: ViewType;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

export const NAV_ITEMS: NavItem[] = [
  { key: "dashboard", label: "仪表盘", icon: LayoutDashboard },
  { key: "novels", label: "小说管理", icon: BookOpen },
  { key: "categories", label: "分类管理", icon: FolderTree },
  { key: "tags", label: "标签管理", icon: Tags },
  { key: "scrape", label: "采集管理", icon: Bug },
  { key: "download", label: "下载中心", icon: Download },
  { key: "themes", label: "主题管理", icon: Palette },
  { key: "sites", label: "站群管理", icon: Globe },
];