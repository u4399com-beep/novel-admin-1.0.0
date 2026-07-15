import type { ThemeConfig } from '@/types';

export const PREBUILT_THEMES: (Omit<ThemeConfig, 'seo' | 'geo'> & {
  name: string;
  identifier: string;
  description: string;
  seo: ThemeConfig['seo'];
  geo: ThemeConfig['geo'];
})[] = [
  // ═══════════════════ 原有 5 套 ═══════════════════
  {
    name: '极简白',
    identifier: 'minimal-white',
    description: '干净纯粹的白色主题，细线条边框，大量留白，无彩色搭配，专注阅读体验',
    colors: { primary: '#334155', secondary: '#64748b', accent: '#0f172a', background: '#ffffff', foreground: '#0f172a', card: '#ffffff', cardForeground: '#1e293b', muted: '#f1f5f9', mutedForeground: '#94a3b8', border: '#e2e8f0', ring: '#334155' },
    layout: { maxWidth: '1200px', sidebarPosition: 'left', cardStyle: 'flat', headerStyle: 'static', gridColumns: 4 },
    typography: { headingFont: 'sans', bodyFont: 'sans', headingWeight: 700, lineHeight: 1.75 },
    seo: { defaultTitle: '极简小说', titleTemplate: '{title} - {siteName}', defaultDescription: '简洁干净的在线小说阅读平台，沉浸式阅读体验', defaultKeywords: '小说,在线阅读,极简' },
    geo: { region: 'CN', placename: '中国', position: '39.9042,116.4074' },
  },
  {
    name: '墨绿夜',
    identifier: 'dark-emerald',
    description: '深邃暗色背景搭配翡翠绿点缀，自然静谧的夜间阅读氛围',
    colors: { primary: '#10b981', secondary: '#059669', accent: '#34d399', background: '#0f1a15', foreground: '#e2e8e0', card: '#152420', cardForeground: '#d1ddd8', muted: '#1a2e26', mutedForeground: '#6b8f80', border: '#1e3a2f', ring: '#10b981' },
    layout: { maxWidth: '1200px', sidebarPosition: 'left', cardStyle: 'bordered', headerStyle: 'fixed', gridColumns: 3 },
    typography: { headingFont: 'sans', bodyFont: 'sans', headingWeight: 800, lineHeight: 1.75 },
    seo: { defaultTitle: '墨绿小说', titleTemplate: '{title} - {siteName}', defaultDescription: '深色护眼在线小说阅读，翡翠绿主题，夜间最佳选择', defaultKeywords: '小说,暗色主题,护眼,夜间阅读' },
    geo: { region: 'CN', placename: '中国', position: '39.9042,116.4074' },
  },
  {
    name: '暖橘阳',
    identifier: 'warm-sunset',
    description: '温暖色调的日落主题，橘色主调配合奶油色背景，柔和圆润的视觉体验',
    colors: { primary: '#f97316', secondary: '#fb923c', accent: '#ea580c', background: '#fffbf5', foreground: '#1c1917', card: '#fff7ed', cardForeground: '#292524', muted: '#fff1e0', mutedForeground: '#a8a29e', border: '#fed7aa', ring: '#f97316' },
    layout: { maxWidth: '1200px', sidebarPosition: 'left', cardStyle: 'rounded', headerStyle: 'static', gridColumns: 3 },
    typography: { headingFont: 'sans', bodyFont: 'sans', headingWeight: 700, lineHeight: 1.6 },
    seo: { defaultTitle: '暖橘小说', titleTemplate: '{title} - {siteName}', defaultDescription: '温暖舒适的在线小说阅读平台，橙色暖调设计', defaultKeywords: '小说,暖色,阅读,舒适' },
    geo: { region: 'CN', placename: '中国', position: '39.9042,116.4074' },
  },
  {
    name: '赛博蓝',
    identifier: 'cyber-neon',
    description: '科技感十足的赛博朋克风格，霓虹蓝与粉色双色调，发光边框效果',
    colors: { primary: '#06b6d4', secondary: '#ec4899', accent: '#8b5cf6', background: '#0a0a1a', foreground: '#e0e7ff', card: '#111133', cardForeground: '#c7d2fe', muted: '#1a1a3e', mutedForeground: '#7c7c9a', border: '#2a2a5e', ring: '#06b6d4' },
    layout: { maxWidth: '1200px', sidebarPosition: 'left', cardStyle: 'elevated', headerStyle: 'fixed', gridColumns: 3 },
    typography: { headingFont: 'mono', bodyFont: 'sans', headingWeight: 800, lineHeight: 1.5 },
    seo: { defaultTitle: '赛博小说', titleTemplate: '{title} | {siteName}', defaultDescription: '赛博朋克风格在线小说平台，科技感阅读体验', defaultKeywords: '小说,赛博朋克,科技,霓虹' },
    geo: { region: 'CN', placename: '中国', position: '39.9042,116.4074' },
  },
  {
    name: '古典红',
    identifier: 'classic-red',
    description: '中国古典美学风格，红色与金色搭配，羊皮纸质感背景，传统装饰边框',
    colors: { primary: '#dc2626', secondary: '#ca8a04', accent: '#b91c1c', background: '#fdf6e3', foreground: '#1c1917', card: '#fef3c7', cardForeground: '#292524', muted: '#fef9ee', mutedForeground: '#92773a', border: '#d4a853', ring: '#dc2626' },
    layout: { maxWidth: '1100px', sidebarPosition: 'left', cardStyle: 'bordered', headerStyle: 'static', gridColumns: 3 },
    typography: { headingFont: 'serif', bodyFont: 'serif', headingWeight: 700, lineHeight: 1.75 },
    seo: { defaultTitle: '古典小说阁', titleTemplate: '{title} - {siteName}', defaultDescription: '中国古典风格在线小说平台，传承文学之美', defaultKeywords: '小说,古典,传统文学,阅读' },
    geo: { region: 'CN', placename: '中国', position: '39.9042,116.4074' },
  },

  // ═══════════════════ 新增 8 套 — 完全不同风格 ═══════════════════

  // 1. 极光紫 — 深紫暗色，右侧边栏，悬浮卡片，宽屏
  {
    name: '极光紫',
    identifier: 'aurora-purple',
    description: '深紫渐变暗色主题，右侧边栏布局，悬浮卡片配大间距，适合内容丰富的站点',
    colors: { primary: '#a78bfa', secondary: '#7c3aed', accent: '#c4b5fd', background: '#0c0a1d', foreground: '#ede9fe', card: '#1a1635', cardForeground: '#ddd6fe', muted: '#150f2e', mutedForeground: '#7c6faa', border: '#2d2555', ring: '#a78bfa' },
    layout: { maxWidth: '1400px', sidebarPosition: 'right', cardStyle: 'elevated', headerStyle: 'fixed', gridColumns: 3 },
    typography: { headingFont: 'sans', bodyFont: 'sans', headingWeight: 800, lineHeight: 1.6 },
    seo: { defaultTitle: '极光阅读', titleTemplate: '{title} | 极光阅读', defaultDescription: '沉浸式暗色小说阅读平台，极光紫主题，宽屏大间距设计，SEO优化结构化数据', defaultKeywords: '小说,暗色主题,紫色,宽屏阅读,在线小说,章节阅读' },
    geo: { region: 'CN', placename: '中国', position: '39.9042,116.4074' },
  },

  // 2. 清风竹 — 竹青自然，全衬线，窄宽度，古典线装书感
  {
    name: '清风竹',
    identifier: 'bamboo-breeze',
    description: '竹青色淡雅自然主题，全衬线字体，窄宽度居中布局，像一本翻开的线装书',
    colors: { primary: '#4d7c5c', secondary: '#6b9e7a', accent: '#2d5a3e', background: '#f7f9f5', foreground: '#1a2e1f', card: '#eef3eb', cardForeground: '#2a4030', muted: '#e5ede2', mutedForeground: '#7a9b84', border: '#c5d9c8', ring: '#4d7c5c' },
    layout: { maxWidth: '960px', sidebarPosition: 'left', cardStyle: 'bordered', headerStyle: 'static', gridColumns: 3 },
    typography: { headingFont: 'serif', bodyFont: 'serif', headingWeight: 700, lineHeight: 1.75 },
    seo: { defaultTitle: '清风竹阅读', titleTemplate: '{title} - 清风竹', defaultDescription: '淡雅自然的小说阅读平台，竹青色主题，全衬线排版，语义化HTML结构利于搜索引擎收录', defaultKeywords: '小说,自然,竹青,衬线字体,阅读,文学作品' },
    geo: { region: 'CN', placename: '中国', position: '39.9042,116.4074' },
  },

  // 3. 星空墨 — 纯黑极简，4列密排，等宽标题，极客科技风
  {
    name: '星空墨',
    identifier: 'starry-ink',
    description: '深邃星空纯黑底色，极简扁平无边框，4列密排网格，等宽字体标题，科技极客风',
    colors: { primary: '#e2e8f0', secondary: '#94a3b8', accent: '#38bdf8', background: '#050810', foreground: '#cbd5e1', card: '#0a0f1a', cardForeground: '#e2e8f0', muted: '#0d1320', mutedForeground: '#475569', border: '#1e293b', ring: '#38bdf8' },
    layout: { maxWidth: '1400px', sidebarPosition: 'left', cardStyle: 'flat', headerStyle: 'fixed', gridColumns: 4 },
    typography: { headingFont: 'mono', bodyFont: 'sans', headingWeight: 800, lineHeight: 1.5 },
    seo: { defaultTitle: '星空阅读', titleTemplate: '{title} | 星空阅读', defaultDescription: '极简深色小说平台，星空墨主题，密排信息流设计，高效SEO元标签管理', defaultKeywords: '小说,深色,极简,科技,密排,在线阅读' },
    geo: { region: 'CN', placename: '中国', position: '39.9042,116.4074' },
  },

  // 4. 樱花粉 — 浅粉柔和，大圆角，温馨少女感
  {
    name: '樱花粉',
    identifier: 'sakura-pink',
    description: '柔和樱花粉色系，大圆角卡片配轻盈阴影，温馨浪漫的少女风阅读体验',
    colors: { primary: '#ec4899', secondary: '#f472b6', accent: '#db2777', background: '#fef7f9', foreground: '#1c1917', card: '#ffffff', cardForeground: '#292524', muted: '#fdf2f8', mutedForeground: '#be90a8', border: '#fbcfe8', ring: '#ec4899' },
    layout: { maxWidth: '1200px', sidebarPosition: 'left', cardStyle: 'rounded', headerStyle: 'static', gridColumns: 3 },
    typography: { headingFont: 'sans', bodyFont: 'sans', headingWeight: 700, lineHeight: 1.6 },
    seo: { defaultTitle: '樱花阅读', titleTemplate: '{title} - 樱花阅读', defaultDescription: '温馨浪漫的粉色小说阅读平台，樱花主题，Open Graph社交分享优化', defaultKeywords: '小说,粉色,樱花,浪漫,阅读,言情' },
    geo: { region: 'CN', placename: '中国', position: '39.9042,116.4074' },
  },

  // 5. 翡翠湖 — 深青水色，悬浮卡片，右侧栏，清爽
  {
    name: '翡翠湖',
    identifier: 'emerald-lake',
    description: '深青湖水色调，悬浮卡片配精致阴影，右侧边栏布局，清爽宁静的阅读空间',
    colors: { primary: '#0d9488', secondary: '#14b8a6', accent: '#2dd4bf', background: '#f0fdfa', foreground: '#042f2e', card: '#ffffff', cardForeground: '#134e4a', muted: '#ccfbf1', mutedForeground: '#5eead4', border: '#99f6e4', ring: '#0d9488' },
    layout: { maxWidth: '1200px', sidebarPosition: 'right', cardStyle: 'elevated', headerStyle: 'static', gridColumns: 3 },
    typography: { headingFont: 'sans', bodyFont: 'sans', headingWeight: 700, lineHeight: 1.75 },
    seo: { defaultTitle: '翡翠湖阅读', titleTemplate: '{title} - 翡翠湖', defaultDescription: '清新水色调小说阅读平台，翡翠湖主题，右侧边栏清爽布局，Schema.org结构化标记', defaultKeywords: '小说,青色,清爽,湖绿,阅读,网络小说' },
    geo: { region: 'CN', placename: '中国', position: '39.9042,116.4074' },
  },

  // 6. 烈焰金 — 深炭底配金色，衬线标题，边框卡片，奢华
  {
    name: '烈焰金',
    identifier: 'flame-gold',
    description: '深炭色底配金色/琥珀色点缀，衬线标题字体，边框卡片，奢华典雅的高端阅读感',
    colors: { primary: '#d97706', secondary: '#f59e0b', accent: '#b45309', background: '#1c1917', foreground: '#fef3c7', card: '#292524', cardForeground: '#fde68a', muted: '#1f1b18', mutedForeground: '#92854a', border: '#57534e', ring: '#d97706' },
    layout: { maxWidth: '1100px', sidebarPosition: 'left', cardStyle: 'bordered', headerStyle: 'fixed', gridColumns: 3 },
    typography: { headingFont: 'serif', bodyFont: 'sans', headingWeight: 800, lineHeight: 1.6 },
    seo: { defaultTitle: '烈焰书阁', titleTemplate: '{title} | 烈焰书阁', defaultDescription: '高端奢华暗色小说阅读平台，金色烈焰主题，衬线标题典雅设计，完整meta标签体系', defaultKeywords: '小说,金色,奢华,暗色,高端阅读,精品小说' },
    geo: { region: 'CN', placename: '中国', position: '39.9042,116.4074' },
  },

  // 7. 冰川灰 — 冷灰银白，极简扁平，4列，北欧极简
  {
    name: '冰川灰',
    identifier: 'glacier-silver',
    description: '冷调灰银色系，极简扁平无边框，4列网格，干净利落的北欧极简设计语言',
    colors: { primary: '#475569', secondary: '#64748b', accent: '#0f172a', background: '#f8fafc', foreground: '#0f172a', card: '#ffffff', cardForeground: '#1e293b', muted: '#f1f5f9', mutedForeground: '#94a3b8', border: '#e2e8f0', ring: '#475569' },
    layout: { maxWidth: '1400px', sidebarPosition: 'left', cardStyle: 'flat', headerStyle: 'static', gridColumns: 4 },
    typography: { headingFont: 'sans', bodyFont: 'sans', headingWeight: 700, lineHeight: 1.5 },
    seo: { defaultTitle: '冰川阅读', titleTemplate: '{title} - 冰川阅读', defaultDescription: '极简北欧风小说阅读平台，冰川灰主题，干净利落的扁平设计，高性能SEO友好架构', defaultKeywords: '小说,北欧,极简,灰色,扁平设计,阅读网站' },
    geo: { region: 'CN', placename: '中国', position: '39.9042,116.4074' },
  },

  // 8. 暮色棕 — 暖棕奶油，全衬线，窄宽度，咖啡馆阅读
  {
    name: '暮色棕',
    identifier: 'twilight-brown',
    description: '暖棕色调配奶油白背景，大圆角舒适卡片，窄宽度布局，像午后咖啡馆的惬意阅读',
    colors: { primary: '#92400e', secondary: '#a16207', accent: '#78350f', background: '#faf8f5', foreground: '#292524', card: '#ffffff', cardForeground: '#1c1917', muted: '#f5f0e8', mutedForeground: '#a8977a', border: '#e7dfcf', ring: '#92400e' },
    layout: { maxWidth: '960px', sidebarPosition: 'left', cardStyle: 'rounded', headerStyle: 'static', gridColumns: 3 },
    typography: { headingFont: 'serif', bodyFont: 'serif', headingWeight: 700, lineHeight: 1.75 },
    seo: { defaultTitle: '暮色书屋', titleTemplate: '{title} - 暮色书屋', defaultDescription: '温暖复古小说阅读平台，暮色棕主题，咖啡馆般惬意的阅读时光，面包屑导航优化', defaultKeywords: '小说,复古,棕色,咖啡馆,舒适阅读,文学' },
    geo: { region: 'CN', placename: '中国', position: '39.9042,116.4074' },
  },
];