# 采集系统爬虫仓库复用可行性分析报告

## 一、当前采集系统架构概览

### 技术栈
- **运行时**: Bun (TypeScript), 独立 mini-service, 端口 3099
- **HTTP 请求**: 原生 `fetch` (无代理/无JS渲染)
- **HTML 解析**: cheerio (CSS/XPath/Regex 选择器)
- **图片处理**: sharp (封面图 WebP 转换)
- **并发控制**: 手动线程池 (Promise.all + 队列)
- **反爬策略**: UA 轮换(24个)、Cookie 注入、随机延迟
- **安全防护**: SSRF 阻断、路径穿越防护、CORS 白名单

### 核心功能模块
| 模块 | 功能 | 代码行数 |
|------|------|---------|
| 选择器引擎 | CSS/XPath/Regex 三种选择器解析 | ~170行 |
| 列表采集 | 分页+去重 | ~80行 |
| 书籍信息采集 | 7个字段(title/author/category/keywords/description/cover/status) | ~30行 |
| 章节目录采集 | 列表嵌套提取+分页+乱序 | ~100行 |
| 正文内容采集 | 多页合并 | ~70行 |
| 内容清洗 | 广告移除+HTML清理+空白归一化 | ~70行 |
| 封面下载 | SSRF防护+WebP转换 | ~70行 |
| 任务编排引擎 | 增量/全量+并发+进度追踪+日志 | ~600行 |
| HTTP服务 | 7个POST端点+健康检查+CORS | ~130行 |

### 已知能力短板
1. **无 JS 渲染** — `useJsRender` 标志存在但未实现（仅添加了请求头）
2. **无代理池** — 无法轮换出口 IP
3. **无验证码处理** — 遇到 CAPTCHA 直接失败
4. **无智能重试** — 失败无指数退避
5. **XPath 支持简陋** — 简单的字符串替换转换，不支持复杂轴语法
6. **无请求队列持久化** — 任务中断无法断点续爬
7. **无浏览器指纹伪装** — 仅靠 UA 轮换

---

## 二、逐个工具分析

### 🔥 AI 原生组

#### 1. Firecrawl ⭐⭐⭐⭐ (推荐集成)
| 维度 | 评估 |
|------|------|
| **语言** | TypeScript/Node.js ✅ 与当前栈兼容 |
| **核心能力** | 网站转 Markdown/结构化数据、JS 渲染、自动去广告 |
| **部署方式** | 开源自托管 (Docker) 或云 API |
| **复用价值** | **极高** — 可替代内容采集+清洗模块 |

**可复用部分:**
- ✅ `/scrape` 端点 → 替代 `handleScrapeContent` + `handleClean` (JS渲染+自动清洗)
- ✅ `/crawl` 端点 → 替代 `handleScrapeChapters` (自动发现链接)
- ✅ `/map` 端点 → 替代 `handleScrapeList` (站点地图发现)
- ✅ 内置 JS 渲染、反检测、自动分页

**不可复用部分:**
- ❌ 任务编排引擎 (需保留自有的增量/全量/并发/进度追踪)
- ❌ 小说元数据提取 (书名/作者/分类等字段需自定义选择器)
- ❌ 封面下载+WebP 转换
- ❌ 章节乱序等小说站特有逻辑

**集成方案:** 作为 `fetchPage` 的可选后端，当 `useJsRender=true` 或目标站需要 JS 渲染时，自动路由到 Firecrawl API。

---

#### 2. Crawl4AI ⭐⭐⭐
| 维度 | 评估 |
|------|------|
| **语言** | Python ❌ 需独立服务 |
| **核心能力** | LLM 友好输出、隐身模式、标签提取、内容块分割 |
| **部署方式** | 本地运行 (pip install) |
| **复用价值** | **中等** — 适合作为内容提取增强 |

**可复用部分:**
- ✅ 隐身模式 (stealth) → 增强反检测能力
- ✅ 内容块提取 (content block extraction) → 比纯 cheerio 更智能
- ✅ LLM 友好格式 (Markdown/JSON) → 可直接用于清洗后输出

**不可复用部分:**
- ❌ Python 技术栈差异大，需独立部署
- ❌ 无任务编排、无增量/全量逻辑
- ❌ 无小说站特有功能

**集成方案:** 可作为独立 Python 微服务(类似 scraper-service)，通过 HTTP 代理调用。仅在需要高级反检测或 LLM 辅助提取时使用。

---

#### 3. Browser Use ⭐⭐
| 维度 | 评估 |
|------|------|
| **语言** | Python ❌ |
| **核心能力** | AI Agent 控制浏览器（点击、输入、导航） |
| **定位** | 通用浏览器自动化，非结构化数据提取 |
| **复用价值** | **低** — 定位不匹配 |

**不可复用:** Browser Use 是让 AI 像人一样操作浏览器，适合表单填写、工作流自动化。小说采集是结构化的 CSS 选择器提取，不需要"AI 理解页面并操作"。

---

#### 4. Stagehand ⭐⭐
| 维度 | 评估 |
|------|------|
| **语言** | TypeScript ✅ |
| **核心能力** | 自然语言 + 代码混合驱动浏览器自动化 |
| **定位** | Browserbase 的 SDK，用于构建浏览器 Agent |
| **复用价值** | **低** — 过度工程 |

**不可复用:** 与 Browser Use 类似，Stagehand 是为 AI Agent 交互设计的。小说采集不需要"自然语言描述操作"，CSS 选择器已经足够精确和高效。

---

#### 5. Skyvern ⭐⭐
| 维度 | 评估 |
|------|------|
| **语言** | Python (Playwright 扩展) ❌ |
| **核心能力** | AI 视觉理解 + 浏览器自动化，处理复杂工作流 |
| **定价** | 免费5000 credit/月，Pro $149/月 |
| **复用价值** | **低** — 定位为企业工作流自动化 |

**不可复用:** Skyvern 用计算机视觉理解页面，适合自动化注册、表单提交等。对结构化小说页面是杀鸡用牛刀，且成本高。

---

#### 6. ScrapeGraph AI ⭐⭐⭐
| 维度 | 评估 |
|------|------|
| **语言** | Python ❌ |
| **核心能力** | LLM 自动生成 CSS 选择器 + 数据提取管道 |
| **复用价值** | **中等** — 可用于自动生成采集规则 |

**可复用部分:**
- ✅ **智能规则生成** — 用自然语言描述要提取的内容，自动生成选择器
- ✅ 可替代手动配置 ScrapeRule 中的各种 Selector 字段

**不可复用部分:**
- ❌ Python 技术栈，需独立服务
- ❌ 运行时需要 LLM API 调用，增加成本和延迟
- ❌ 不适合大规模生产采集（每次都调 LLM 太贵太慢）

**集成方案:** 可作为"规则助手"功能：用户输入目标站 URL + 自然语言描述，调用 ScrapeGraph AI 自动生成 ScrapeRule 配置，然后保存到数据库供 scraper-service 使用。

---

#### 7. AgentQL ⭐⭐⭐
| 维度 | 评估 |
|------|------|
| **语言** | TypeScript SDK ✅ / 云 API |
| **核心能力** | AI 查询语言提取结构化数据，无需 CSS 选择器 |
| **复用价值** | **中等** — 可替代选择器引擎 |

**可复用部分:**
- ✅ 用 AgentQL 查询替代 CSS/XPath 选择器提取书名、作者等
- ✅ 内置反检测，自动处理 JS 渲染

**不可复用部分:**
- ❌ 每次 API 调用有成本
- ❌ 延迟较高（需要 AI 推理）
- ❌ 大规模采集不经济（500章 × 1次/章 = 500次 AI 调用）

**集成方案:** 适合作为"智能模式"选项。对于已知结构的站点用 cheerio（快+免费），对于未知/复杂站点用 AgentQL（慢+收费但无需写选择器）。

---

### 🛡️ 反检测组

#### 1. Hyperbrowser ⭐⭐⭐
| 维度 | 评估 |
|------|------|
| **类型** | 云端 BaaS (Browser-as-a-Service) |
| **核心能力** | 企业级反检测、旋转住宅代理、浏览器指纹管理 |
| **定价** | 云服务付费 |
| **复用价值** | **中等** — 解决高防站点采集 |

**可复用部分:**
- ✅ 提供无头浏览器实例，解决 JS 渲染 + 反检测
- ✅ 内置代理轮换

**不可复用:**
- ❌ 依赖云服务，无法完全自托管
- ❌ 仅提供浏览器基础设施，不提供采集逻辑

**集成方案:** 当目标站点有强反爬（Cloudflare、Akamai）时，将 `fetchPage` 路由到 Hyperbrowser 的浏览器实例进行渲染提取。

---

#### 2. Crawlee ⭐⭐⭐⭐⭐ (强烈推荐)
| 维度 | 评估 |
|------|------|
| **语言** | TypeScript/Node.js ✅ 完全兼容 |
| **核心能力** | 请求队列、代理轮换、自动重试、浏览器池、会话管理 |
| **GitHub Stars** | 17k+ |
| **复用价值** | **极高** — 可作为底层引擎重构 |

**可复用部分（几乎全部）:**
- ✅ `RequestQueue` → 替代手动队列管理，支持持久化断点续爬
- ✅ `ProxyConfiguration` → 代理轮换，解决无代理池短板
- ✅ `SessionPool` → 会话管理 + 自动轮换
- ✅ `CrawlingContext` → 统一请求/响应处理
- ✅ ` CheerioCrawler` → 比 cheerio 更强大的 HTTP 爬虫
- ✅ `PlaywrightCrawler` → 内置 JS 渲染
- ✅ 自动重试 + 指数退避
- ✅ 速率限制 + 并发控制
- ✅ 请求去重

**不可复用部分:**
- ❌ 小说业务逻辑（书/章/内容的关系、增量模式、乱序等）
- ❌ 与 Next.js API 的集成（创建小说/章节等）
- ❌ 内容清洗规则（中文广告 patterns 等）

**集成方案:** **用 Crawlee 作为底层引擎重写 scraper-service**。这是最推荐的方案：
1. 用 `CheerioCrawler` 替代当前的 `fetchPage` + cheerio
2. 用 `PlaywrightCrawler` 处理需要 JS 渲染的站点
3. 用 `RequestQueue` 实现断点续爬
4. 用 `ProxyConfiguration` 接入代理池
5. 保留现有的任务编排引擎和业务逻辑

---

#### 3. Scrapling ⭐⭐
| 维度 | 评估 |
|------|------|
| **语言** | Python ❌ |
| **核心能力** | 反检测绕过、指纹伪装、验证码处理 |
| **复用价值** | **低** — Python 技术栈不兼容 |

**不可复用:** 与 Crawlee 功能重叠但语言不兼容。如果用 Crawlee (Node.js) 就不需要 Scrapling (Python)。

---

#### 4. Steel ⭐⭐⭐
| 维度 | 评估 |
|------|------|
| **语言** | 开源 REST/WebSocket API (TypeScript SDK) ✅ |
| **核心能力** | 无头浏览器 API、反检测、会话管理、指纹管理 |
| **部署方式** | 自托管 Docker 或云服务 |
| **复用价值** | **中等** — 可作为 JS 渲染后端 |

**可复用部分:**
- ✅ 提供无头浏览器实例 → 解决 JS 渲染
- ✅ 反检测 + 指纹管理 → 增强反爬能力
- ✅ REST API → 容易集成

**不可复用:**
- ❌ 仅提供浏览器 API，不提供采集逻辑
- ❌ 需要额外部署和维护

**集成方案:** 作为 Playwright/Puppeteer 的后端。当需要 JS 渲染时，scraper-service 通过 Steel 的 API 获取渲染后的 HTML。

---

#### 5. Playwright ⭐⭐⭐⭐ (推荐集成)
| 维度 | 评估 |
|------|------|
| **语言** | TypeScript ✅ 完全兼容 |
| **核心能力** | 浏览器自动化、JS 渲染、网络拦截、截图 |
| **复用价值** | **高** — 直接解决 JS 渲染短板 |

**可复用部分:**
- ✅ 替代 `fetchPage` 中的 `useJsRender` 空实现
- ✅ 可拦截网络请求、修改 headers、注入 cookies
- ✅ 可配合 Crawlee 的 `PlaywrightCrawler` 使用

**不可复用:**
- ❌ 本身不是爬虫框架，需要自己编排采集逻辑
- ❌ 资源消耗大（每个浏览器实例 ~100-200MB 内存）

**集成方案:** 当 `antiCrawl.useJsRender = true` 时，使用 Playwright 启动 headless browser 渲染页面，提取 HTML 后交给 cheerio 解析。

---

### 🏭 生产级组

#### 1. Scrapy ⭐⭐⭐⭐
| 维度 | 评估 |
|------|------|
| **语言** | Python ❌ |
| **核心能力** | 最成熟的爬虫框架：中间件、管道、选择器、去重 |
| **GitHub Stars** | 55k+ |
| **复用价值** | **高 — 但需独立部署** |

**可复用部分:**
- ✅ `Item Pipeline` → 对应小说/章节创建流程
- ✅ `Middleware` → 反爬策略（UA轮换、代理、重试）
- ✅ `Selector` → CSS/XPath 支持（比当前更完善）
- ✅ `CrawlSpider` → 自动跟踪链接
- ✅ `StatsCollector` → 统计信息
- ✅ `Telnet/Web Console` → 实时监控

**不可复用:**
- ❌ Python 技术栈，需独立部署
- ❌ 与现有 Next.js/Prisma 生态脱节
- ❌ 无法直接调用 Next.js API（需 HTTP 中转）

**集成方案:** 可以作为独立 Python 微服务替代整个 scraper-service，通过 API 与 Next.js 主应用通信。但考虑到当前栈是 TypeScript，**用 Crawlee (Node.js) 是更优选择**，功能等价且无需跨语言。

---

#### 2. Puppeteer ⭐⭐⭐
| 维度 | 评估 |
|------|------|
| **语言** | TypeScript ✅ |
| **核心能力** | Chrome/Chromium 控制 |
| **复用价值** | **中等** — Playwright 是更好的替代 |

**结论:** Puppeteer 只支持 Chromium，而 Playwright 支持 Chromium + Firefox + WebKit。Playwright API 更现代，已在 Crawlee 中原生支持。**选 Playwright 不选 Puppeteer**。

---

#### 3. Selenium ⭐⭐
| 维度 | 评估 |
|------|------|
| **语言** | 多语言支持 |
| **核心能力** | 跨浏览器自动化 |
| **复用价值** | **低** — 已过时 |

**结论:** Selenium 生态老旧，API 笨重，启动慢。Playwright 在所有维度上都优于 Selenium。**不推荐**。

---

#### 4. Colly ⭐
| 维度 | 评估 |
|------|------|
| **语言** | Go ❌ |
| **核心能力** | 优雅的 Go 爬虫框架 |
| **复用价值** | **极低** — 技术栈完全不兼容 |

**结论:** Go 语言与当前 TypeScript/Bun 栈不兼容。除非重写整个 scraper-service 为 Go 服务，否则无法复用。

---

### 🔧 专业工具组

#### 1. Katana ⭐⭐
| 维度 | 评估 |
|------|------|
| **语言** | Go ❌ |
| **核心能力** | 网络资产发现、端点枚举 |
| **定位** | 安全测试工具 (ProjectDiscovery 生态) |
| **复用价值** | **极低** — 定位不匹配 |

**结论:** Katana 是安全渗透测试工具，用于发现子域名、API 端点等。与小说内容采集毫无关系。

---

#### 2. Browserless ⭐⭐⭐
| 维度 | 评估 |
|------|------|
| **语言** | 云 API (REST + CDP) |
| **核心能力** | 托管无头浏览器 (Puppeteer/Playwright) |
| **Docker 拉取量** | 1.73亿+ |
| **复用价值** | **中等** — 类似 Steel |

**可复用部分:**
- ✅ 提供托管的浏览器实例
- ✅ REST API + 截图/PDF/采集端点
- ✅ 可自托管

**不可复用:**
- ❌ 与 Steel 功能高度重叠
- ❌ 不提供采集逻辑

**集成方案:** 与 Steel 二选一。Browserless 更成熟（1.73亿 Docker 拉取），Steel 更面向 AI Agent。推荐 Browserless 作为生产环境的浏览器后端。

---

#### 3. Maxun ⭐⭐⭐
| 维度 | 评估 |
|------|------|
| **语言** | TypeScript/Node.js ✅ |
| **核心能力** | 无代码采集规则构建器、可视化机器人编辑 |
| **复用价值** | **中等** — 适合作为规则构建 UI |

**可复用部分:**
- ✅ 可视化规则构建器 → 让用户通过点击页面元素创建 ScrapeRule
- ✅ 机器人调度系统
- ✅ 采集模板市场

**不可复用:**
- ❌ 采集引擎与现有系统重叠
- ❌ 无增量/全量模式
- ❌ 无小说站特有功能

**集成方案:** 可集成 Maxun 的可视化规则编辑器到前端，让用户通过可视化操作创建采集规则（替代当前手动填写 JSON 选择器）。

---

#### 4. Heritrix ⭐
| 维度 | 评估 |
|------|------|
| **语言** | Java ❌ |
| **核心能力** | 网络规模存档爬虫 (Internet Archive 官方) |
| **定位** | 全网归档，非结构化数据提取 |
| **复用价值** | **极低** — 完全不匹配 |

**结论:** Heritrix 用于整站/全网归档保存。与小说内容采集（精准提取特定字段）完全不是同一类工具。

---

## 三、总结矩阵

| 工具 | 语言兼容 | 可复用度 | 推荐度 | 集成方式 |
|------|---------|---------|--------|---------|
| **Crawlee** | ✅ TS | ⭐⭐⭐⭐⭐ | 🥇 首选 | **底层引擎重构** |
| **Playwright** | ✅ TS | ⭐⭐⭐⭐ | 🥈 核心 | JS渲染后端 |
| **Firecrawl** | ✅ TS | ⭐⭐⭐⭐ | 🥉 增强 | 自托管Docker API |
| Browserless | ✅ API | ⭐⭐⭐ | 可选 | 浏览器即服务 |
| Steel | ✅ API | ⭐⭐⭐ | 可选 | 同上(二选一) |
| AgentQL | ✅ TS | ⭐⭐⭐ | 场景化 | 智能提取模式 |
| ScrapeGraph AI | ❌ Python | ⭐⭐⭐ | 场景化 | 规则自动生成 |
| Maxun | ✅ TS | ⭐⭐⭐ | 场景化 | 可视化规则构建 |
| Hyperbrowser | ✅ API | ⭐⭐⭐ | 场景化 | 高防站点 |
| Crawl4AI | ❌ Python | ⭐⭐ | 备选 | 独立服务 |
| Puppeteer | ✅ TS | ⭐⭐ | 不选 | 被Playwright替代 |
| Browser Use | ❌ Python | ⭐⭐ | 不匹配 | — |
| Stagehand | ✅ TS | ⭐⭐ | 不匹配 | — |
| Skyvern | ❌ Python | ⭐⭐ | 不匹配 | — |
| Scrapling | ❌ Python | ⭐⭐ | 不匹配 | — |
| Scrapy | ❌ Python | ⭐⭐⭐⭐ | 备选 | 独立微服务 |
| Selenium | 多语言 | ⭐⭐ | 不选 | 被Playwright替代 |
| Colly | ❌ Go | ⭐ | 不兼容 | — |
| Katana | ❌ Go | ⭐ | 不匹配 | — |
| Heritrix | ❌ Java | ⭐ | 不匹配 | — |

---

## 四、推荐架构改造方案

### 阶段一：Crawlee 引擎重构（核心）
```
当前架构:
  fetch() + cheerio → 手动并发 → 手动队列

改造后架构:
  Crawlee (CheerioCrawler / PlaywrightCrawler)
  ├── RequestQueue (断点续爬)
  ├── ProxyConfiguration (代理轮换)
  ├── SessionPool (会话管理)
  ├── AutoscaledPool (自适应并发)
  └── 保留: 任务编排引擎 + 业务逻辑 + 安全防护
```

### 阶段二：Playwright JS 渲染（核心）
```
当 antiCrawl.useJsRender = true 时:
  CheerioCrawler → PlaywrightCrawler
  (自动切换，对上层业务透明)
```

### 阶段三：Firecrawl 集成（增强）
```
新增 engine 字段:
  "cheerio" → 当前 cheerio 解析 (默认，快速)
  "playwright" → Playwright 渲染 (中等速度，支持JS)
  "firecrawl" → Firecrawl API (慢但最强，自动清洗)
```

### 阶段四：AgentQL 智能模式（场景化）
```
新增 scrapeMode:
  "selector" → CSS/XPath 选择器 (默认)
  "ai" → AgentQL 自然语言提取 (未知/复杂站点)
```

### 阶段五：Maxun 可视化规则构建（场景化）
```
在前端集成可视化选择器编辑器:
  用户点击页面元素 → 自动生成 CSS Selector
  替代手动填写 JSON 选择器
```

---

## 五、结论

**能否"全部复用"？答案是不能。**

这20个工具覆盖了完全不同的场景：
- **7个与当前系统完全不兼容**（Go/Java 语言栈不匹配：Colly, Katana, Heritrix）
- **6个定位不匹配**（AI Agent 自动化/浏览器交互，非结构化提取：Browser Use, Stagehand, Skyvern, Selenium, Puppeteer被替代, Scrapling）
- **7个有部分复用价值**，但需要按需集成

**最推荐的组合是：Crawlee + Playwright + Firecrawl**
- Crawlee: 重写底层引擎，解决所有架构短板
- Playwright: 解决 JS 渲染
- Firecrawl: 作为高级采集引擎的备选

这个组合全部 TypeScript 兼容，可以完全自托管，功能互补，是当前系统的最优升级路径。
