import { LayoutDashboard, BookOpen, FolderTree, Tags, Bug, Download, Palette, Globe } from "lucide-react";
import type { ViewType } from "@/types";

export interface NavItem {
  key: ViewType;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
}

export const NAV_ITEMS: NavItem[] = [
  { key: "dashboard", label: "仪表盘", description: "查看系统概览和数据统计", icon: LayoutDashboard },
  { key: "novels", label: "小说管理", description: "管理所有小说作品和章节", icon: BookOpen },
  { key: "categories", label: "分类管理", description: "整理小说分类体系", icon: FolderTree },
  { key: "tags", label: "标签管理", description: "管理小说标签和关键词", icon: Tags },
  { key: "scrape", label: "采集管理", description: "管理采集规则与任务", icon: Bug },
  { key: "download", label: "下载中心", description: "导出和下载小说内容", icon: Download },
  { key: "themes", label: "主题管理", description: "配置站点主题和样式", icon: Palette },
  { key: "sites", label: "站群管理", description: "管理多个发布站点", icon: Globe },
];