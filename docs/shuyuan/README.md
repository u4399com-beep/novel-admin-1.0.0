# 书源（阅读 App Legado 格式）—— R140

本目录存放「阅读」（Legado/开源阅读）App 兼容的书源 JSON。格式基线：yckceo #8097（九霄中文网），
全部端点与响应结构均经 R140 轮实测验证。

## 文件清单

| 文件 | 目标站 | 状态 |
| --- | --- | --- |
| `jiuxiaozw.json` | https://jiuxiaozw.com | 四端点实测验证（搜索/详情/目录/正文），附加正文蜜罐行清洗 |
| `qingyue.json` | 本项目自建站（青阅文学） | 映射既有公开只读 API，零后端改动 |

## 使用方法（阅读 App）

1. 将 JSON 文件放到手机可访问位置（或托管到任意 HTTP 静态服务）。
2. 阅读 App → 我的 → 书源管理 → 右上角菜单 → 本地导入 / 网络导入。
3. `qingyue.json` 导入后需把 `bookSourceUrl` 改成实际部署域名（其余规则均为相对路径，无需改动）。

## 青阅文学源 ↔ 后端 API 对应关系

| 书源环节 | 端点 | 响应要点 |
| --- | --- | --- |
| searchUrl | `GET /api/novels?q={key}&page={page}&pageSize=20` | `{list[],total,...}`，q 匹配书名/作者/简介 |
| ruleSearch.bookList | `$.list[*]` | 每项含 id/title/author/cover/categoryName/status/wordCount/lastChapterTitle/updatedAt |
| bookUrl | `/api/novels/{id}` | 详情含 firstChapterId/lastChapterId/tags/chapters[12] |
| tocUrl | `/api/novels/{id}/chapters` | 一次性返回全量章节数组（免翻页） |
| chapterUrl | `/api/chapters/{id}` | `{content,...}`，`\n` 分段 |
| exploreUrl | `?sort=clicks|words|featured|latest&status=serial|finished` | 部署无关参数，全站可用 |

## 维护备注

- jiuxiaozw.com 限流约 3 req/s：`concurrentRate: 3/1000` 勿调高；其 `/book/*` HTML 页面对无浏览器指纹的请求
  响应极慢（R140 观测超时），书源全部走 JSON API 不受影响。
- jiuxiaozw.com 的 `/api/chapters/{id}` 正文附带一行程序抓取提示语（站内页面无此行），
  jiuxiaozw.json 的 `ruleContent.content` 已用 `##(?m)^\s*章节被程序抓取转载[^\n]*$##` 清洗。
- 分类发现（按 categoryId）各部署 id 不同：先访问 `GET /api/categories` 取 id，再手工拼进 exploreUrl。
