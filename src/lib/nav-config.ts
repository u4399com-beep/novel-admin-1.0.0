import { LayoutDashboard, BookOpen, FolderTree, Tags, Palette, Globe, Code, Activity, Settings } from "lucide-react";
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
  { key: "themes", label: "主题管理", description: "配置站点主题和样式", icon: Palette },
  { key: "sites", label: "站点集群", description: "管理多个发布站点", icon: Globe },
  { key: "scrape", label: "采集规则", description: "管理采集规则配置", icon: Code },
  { key: "download", label: "采集任务", description: "管理采集任务和下载", icon: Activity },
  { key: "settings", label: "系统设置", description: "配置系统参数和偏好", icon: Settings },
];
