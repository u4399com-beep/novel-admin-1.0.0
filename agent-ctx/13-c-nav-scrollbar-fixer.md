# Task 13-c — nav-scrollbar-fixer 工作记录

日期：2025-09-16 ｜ 项目：/home/z/my-project（Next.js 16 + Tailwind 4）

## 任务
全站 10 套主题导航条去滚动条 + 溢出行为审查。用户反馈：overflow-x-auto 的导航在 WebKit 下显示系统滚动条，很难看；主题内已有 [scrollbar-width:none] 内联写法仅覆盖 Firefox。

## 关键决策
1. **统一工具类**：`src/app/globals.css` 末尾追加 `@utility no-scrollbar`（Tailwind 4 语法，嵌套 `&::-webkit-scrollbar` 由 Lightning CSS 编译，验证通过）。仅追加，未重写。
2. **迁移策略**：把 4 处 `[scrollbar-width:none]`（aijjxs nav、ddyueshu nav、x2552 nav ×2）替换为 `no-scrollbar` 类——原写法在 Chrome/Safari 无效（::-webkit-scrollbar 无法内联），这正是用户反馈的根因。
3. **补齐缺口**：无任何滚动条隐藏的 4 处横条（shipsay 主导航、x2552 排行榜横条、trxsw 编辑推荐、101kks 分类标签行）直接加 `no-scrollbar`。
4. **溢出收敛**：23qb 桌面导航（min-w-0 flex-1 + shrink-0 子项、无 overflow 处理）在 ~1024–1200px 视口按钮会外溢盖住右侧"全部分类"控件，补 `overflow-x-auto no-scrollbar`。
5. **竖向列表（谨慎范围）**：仅处理 4 个"浮层抽屉"（aijjxs 深色抽屉、23qb/101kks 移动抽屉、huangjinwu 抽屉 aside）——均为临时覆盖层 UI，系统滚动条突兀；正文阅读区、章节内容、侧栏榜单一律未动。

## 修改清单（13 处 no-scrollbar / 9 文件）
| 文件 | 位置 |
|---|---|
| src/app/globals.css | @utility no-scrollbar 追加 |
| aijjxs/index.tsx | 桌面分类导航；≤lg 深色抽屉 |
| ddyueshu/index.tsx | 主导航 40px 横条 |
| shipsay/Layout.tsx | 主导航条内层（max-w-[960px]） |
| x2552/Layout.tsx | 主导航 .m_menu；紧凑顶栏 |
| x2552/Home.tsx | 排行榜封面横条 |
| trxsw/index.tsx | 编辑推荐封面横条 |
| 101kks/views.tsx | 分类标签行；101kks/Layout.tsx 抽屉 |
| 23qb/Layout.tsx | 桌面分类导航（+overflow 收敛）；移动抽屉 |
| huangjinwu/index.tsx | 移动抽屉 aside |

无改动主题：pilishuwu（导航 flex-wrap 换行式）、ggd66（grid/等分导航，无横向溢出）。

## 边界遵守
- 未触碰 src/components/**、src/app/api/**、prisma/**。
- 未改任何主题视觉（颜色/间距/字体）；全部改动为 className 追加/替换。
- AdminConsole.tsx 自带 [&::-webkit-scrollbar]:hidden 保持原样（不在范围）。

## 360px 溢出审查结论
全部主题 documentElement.scrollWidth 不会被导航撑破：横向条均有 max-w/w-full 祖先约束 + overflow 容器；≤lg 隐藏的桌面导航（aijjxs/shipsay/23qb/101kks/x2552 Sidebar）在 360px 不渲染；pilishuwu/ggd66 换行/均分式天然安全；trxsw/x2552 双栏 grid 均用 minmax(0,1fr)。

## 验证
- `bunx tsc --noEmit` → 0 错误；`bun run lint` → 无错误。
- 编译产物：dev CSS chunk 含 `.no-scrollbar{scrollbar-width:none;-ms-overflow-style:none}` + `.no-scrollbar::-webkit-scrollbar{display:none}`。
- 主题客户端 bundle 中 13 处类名字符串全部命中（含主题页 SSR 为客户端渲染、故以 bundle 验证而非 HTML）。
- `PATCH /api/settings {"activeTheme":...}` 10 主题全部 200；dev.log 无新增错误（仅历史 EADDRINUSE 噪音）。
