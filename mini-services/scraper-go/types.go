/**
 * Go 版采集引擎（scraper-go）—— novel-admin scraper-service 的 Golang 移植。
 *
 * 移植自：/home/z/my-project/mini-services/scraper-service（Bun + TypeScript，~4700 行）
 * 移植原则：
 * - 对外 API 契约（路由/字段名/错误结构/CORS/状态码）与 TS 版完全一致，主站 engine-client.ts 零改动；
 * - 策略名与策略链顺序保持一致（fetch-browser → fetch-ua-rotate → fetch-mobile → fetch-spider →
 *   curl-impersonate → got-scraping → browser），策略亲和/主机健康度/Cookie 会话语义一致；
 * - 合规红线（不可移除）：仅公开内容、robots.txt warn-only、默认限速 ≥1.2s/域名、
 *   SSRF 逐跳校验、不含验证码破解/账号伪装/登录态伪造；
 * - 已知运行时差异（行为等价性说明，见各文件头注）：
 *   1) Go net/http 按字典序发送请求头，无法实现 TS 版的「非核心头序随机抖动」（humanizeHeaderOrder
 *      在 Go 版退化为仅保证 UA 优先的固定序，UA 本身仍按进程随机版本派生）；
 *   2) got-scraping 策略以 Go 原生 HTTP/2 + 随机真实浏览器头等价实现（不依赖 npm header-generator）；
 *   3) browser 策略统一走 Python Playwright 桥接（scripts/render.py 子进程，独立浏览器进程天然无泄漏），
 *      不实现 TS 版的 Node 共享 Chromium 会话池；
 *   4) socks4 出口代理不支持（Go 传输层限制），http/https/socks5(h) 均支持。
 *
 * 文件结构（package main 单包多文件，移植自 TS 多模块）：
 *   types.go      DTO（与主站 src/lib/types.ts 子集一致）
 *   util.go       JSON 响应/请求体上限/参数清洗
 *   ssrf.go       SSRF 防护（IPv4 全文本形态/IPv6/主机名文本层 + DNS 尽力校验）
 *   ratelimit.go  域名限速/robots.txt/重试退避/Retry-After
 *   charsetx.go   字符集检测与解码（BOM/头/meta/嗅探/GB18030 兜底）
 *   cleanx.go     行级正文噪声清洗（与主应用 src/lib/content-clean.ts 同源规则的 Go 版）
 *   cookies.go    按主机 Cookie 会话持久化
 *   affinity.go   按主机策略亲和缓存
 *   hosthealth.go 按主机健康度记忆（限流退避 + 连败熔断）
 *   challenge.go  挑战页/拦截页四层检测
 *   httpguard.go  流式限量读体/统一响应评估/逐跳 SSRF 守卫 fetch
 *   profiles.go   请求头画像（UA 派生 + 浏览器/爬虫画像）
 *   strategies.go 策略接口 + fetch 系策略 + got-scraping Go 等价实现
 *   curlimp.go    curl-impersonate 策略（TLS/JA3 指纹级伪装，多二进制轮换）
 *   browser.go    browser 策略（Python Playwright 桥接渲染）
 *   chain.go      策略链编排（预算/退避/亲和/健康度/挑战检测）
 *   selectors.go  goquery 选择器工具（备选/@attr/文本与链接提取）
 *   extract.go    List/Book/Chapter 规则提取器
 *   jsontoc.go    JSON 目录接口（chapterListApi）
 *   handlers.go   /api/strategies、/api/test、/api/chapter 业务处理
 *   main.go       HTTP 服务/路由/CORS/心跳/runner 心跳观测（不拉起 runner）
 */
package main

// ==================== DTO（字段名与主站/TS 版完全一致） ====================

// ListRule 列表页规则
type ListRule struct {
	ItemSelector     string `json:"itemSelector,omitempty"`
	TitleSelector    string `json:"titleSelector,omitempty"`
	LinkSelector     string `json:"linkSelector,omitempty"`
	AuthorSelector   string `json:"authorSelector,omitempty"`
	CategorySelector string `json:"categorySelector,omitempty"`
}

// BookRule 书页规则
type BookRule struct {
	TitleSelector        string `json:"titleSelector,omitempty"`
	AuthorSelector       string `json:"authorSelector,omitempty"`
	DescriptionSelector  string `json:"descriptionSelector,omitempty"`
	CoverSelector        string `json:"coverSelector,omitempty"`
	StatusSelector       string `json:"statusSelector,omitempty"`
	CategorySelector     string `json:"categorySelector,omitempty"`
	ChapterLinkSelector  string `json:"chapterLinkSelector,omitempty"`
	ChapterTitleSelector string `json:"chapterTitleSelector,omitempty"`
	// CatalogLinkSelector 目录页链接选择器：书页仅含最新几章时指向完整目录页
	CatalogLinkSelector string `json:"catalogLinkSelector,omitempty"`
	// ExcludeSelector 排除选择器：提取前先从 DOM 移除命中节点，多备用逗号分隔
	ExcludeSelector string `json:"excludeSelector,omitempty"`
	// ChapterListApi JSON 目录接口配置（JSON 字符串）
	ChapterListApi string `json:"chapterListApi,omitempty"`
}

// ChapterRule 章节页规则
type ChapterRule struct {
	TitleSelector   string `json:"titleSelector,omitempty"`
	ContentSelector string `json:"contentSelector,omitempty"`
	NextSelector    string `json:"nextSelector,omitempty"`
	ExcludeSelector string `json:"excludeSelector,omitempty"`
}

// AttemptSummary 一次网络尝试明细
type AttemptSummary struct {
	Strategy string `json:"strategy"`
	Profile  string `json:"profile,omitempty"`
	OK       bool   `json:"ok"`
	Status   int    `json:"status"`
	Ms       int64  `json:"ms"`
	Note     string `json:"note,omitempty"`
	Blocked  bool   `json:"blocked,omitempty"`
	Bytes    int    `json:"bytes,omitempty"`
}

// SubAttempt 策略内部一次子尝试
type SubAttempt struct {
	Profile string `json:"profile"`
	OK      bool   `json:"ok"`
	Status  int    `json:"status"`
	Ms      int64  `json:"ms"`
	Blocked bool   `json:"blocked"`
	Bytes   int    `json:"bytes"`
	Note    string `json:"note,omitempty"`
}

// RobotsSummary robots 检查摘要
type RobotsSummary struct {
	Checked      bool     `json:"checked"`
	Disallowed   bool     `json:"disallowed"`
	CrawlDelayMs *float64 `json:"crawlDelayMs"`
}

// StrategyInfo 策略信息
type StrategyInfo struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Available   bool   `json:"available"`
}

// ==================== 提取结果 DTO ====================

// ListItem 列表条目
type ListItem struct {
	Title    string  `json:"title"`
	Url      *string `json:"url"`
	Author   string  `json:"author"`
	Category string  `json:"category"`
}

// ListData 列表提取结果
type ListData struct {
	Type         string     `json:"type"`
	Count        int        `json:"count"`
	ItemSelector string     `json:"itemSelector"`
	Items        []ListItem `json:"items"`
}

// BookChapterRef 章节引用
type BookChapterRef struct {
	Title string  `json:"title"`
	Url   *string `json:"url"`
}

// BookData 书页提取结果
type BookData struct {
	Type         string           `json:"type"`
	Title        string           `json:"title"`
	Author       string           `json:"author"`
	Description  string           `json:"description"`
	Cover        *string          `json:"cover"`
	Status       string           `json:"status"`
	Category     string           `json:"category"`
	ChapterCount int              `json:"chapterCount"`
	Chapters     []BookChapterRef `json:"chapters"`
	CatalogUrl   *string          `json:"catalogUrl"`
}

// ChapterData 章节提取结果
type ChapterData struct {
	Type       string   `json:"type"`
	Title      string   `json:"title"`
	Content    string   `json:"content"`
	Paragraphs []string `json:"paragraphs"`
	WordCount  int      `json:"wordCount"`
	NextUrl    *string  `json:"nextUrl"`
}

// strPtr / intPtr 小工具：TS 的 null 语义
func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func fPtr(f float64) *float64 { return &f }

// intToStr 调试用（未使用时编译器会剔除）
