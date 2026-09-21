/**
 * backend-go —— 采集 worker 共享类型。
 *
 * TS 源：src/lib/scrape/types.ts（TaskRecord/BookData/ListItem/ChapterData/LoadedRule/ChapterRef）
 *
 * 移植差异（诚实标注）：
 * - TS 可空字段（url/cover/nextUrl/catalogUrl: string|null）→ Go 零值 ""（normalizeRefs/
 *   cover 正则/分页判断均以空串为「无」判据，语义等价）
 * - BookData.chapterCount 引擎可能缺省 → *int（shapeBook 时回填 len(chapters)，对齐
 *   TS typeof !== 'number' 分支）
 * - ChapterRef.url 在 TS 侧为 string|null，引擎 JSON null → Go ""
 * - 引擎 JSON 字段名与 TS 完全一致：title/author/description/cover/status/category/
 *   chapterCount/chapters[].title/.url/catalogUrl/nextUrl/paragraphs/wordCount
 */
package main

// RuleMap 规则映射（与 TS Record<string, string> 同义）
type RuleMap = map[string]string

// LoadedRule 运行时清洗后的规则对象
type LoadedRule struct {
	Name        string // 规则名（仅日志展示）
	Charset     string // 目标站字符集（""=auto）
	Proxy       string // 站点级出口代理（""=直连）
	InsecureTLS bool   // 跳过目标站 TLS 证书校验（自签/裸 IP 站点）
	ListRule    RuleMap
	BookRule    RuleMap
	ChapterRule RuleMap
}

// ChapterRef 书页/目录页提取出的章节链接
type ChapterRef struct {
	Title string `json:"title"`
	URL   string `json:"url"`
}

// BookData 引擎 /api/test（bookRule）返回的书籍数据
type BookData struct {
	Title        string       `json:"title"`
	Author       string       `json:"author"`
	Description  string       `json:"description"`
	Cover        string       `json:"cover"`
	Status       string       `json:"status"`
	Category     string       `json:"category"`
	ChapterCount *int         `json:"chapterCount"`
	Chapters     []ChapterRef `json:"chapters"`
	CatalogURL   string       `json:"catalogUrl"`
}

// ListItem 列表页条目
type ListItem struct {
	Title    string `json:"title"`
	URL      string `json:"url"`
	Author   string `json:"author"`
	Category string `json:"category"`
}

// ChapterData 引擎 /api/chapter 返回的章节数据
type ChapterData struct {
	Title      string   `json:"title"`
	Content    string   `json:"content"`
	Paragraphs []string `json:"paragraphs"`
	WordCount  int      `json:"wordCount"`
	NextURL    string   `json:"nextUrl"`
}

// TaskRecord 任务记录的业务字段子集（ScrapeTask 行）
type TaskRecord struct {
	ID        int
	Mode      string // single | list
	TargetURL string
	Pages     int
	RuleID    *int // null = 未使用规则
}

// TaskFlushFields Run.Flush 可写回的任务进度字段（全部为 ScrapeTask 标量列；
// 指针 nil = 不写该列，对齐 TS TaskFlushFields 可选字段语义）
type TaskFlushFields struct {
	Done          *int
	Total         *int
	ChaptersDone  *int
	ChaptersTotal *int
	Created       *int
	Updated       *int
	Chapters      *int
}

// ptrInt 取整型指针（构造 TaskFlushFields 用）
func ptrInt(v int) *int { return &v }

// refPair 归一化后的章节行（title→URL；Phase 1/2 间传递）
type refPair struct {
	Title string
	URL   string
}

// fillPlan Phase 2 单书填充计划：书页 referer + 待填充行
type fillPlan struct {
	Referer string
	Rows    []refPair
}
