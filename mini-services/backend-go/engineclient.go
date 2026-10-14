/**
 * backend-go —— scraper-go（127.0.0.1:3030）HTTP 客户端封装。
 *
 * TS 源：src/lib/scrape/engine-client.ts（逐行移植）
 * 只依赖引擎的 HTTP 契约（/api/test、/api/chapter 的请求/响应结构），不依赖其内部实现：
 * - 响应 { ok, data, warnings, strategy, attempts[] } 或 { error, detail }（含 502 结构化失败）
 * - ok=false 或 HTTP 非 2xx → 失败；成功但缺 data 对象 → 失败（防 2xx 空 JSON 透传）
 * - 60s 超时（≥ 引擎策略链 55s 预算，与 /api/scrape 代理 60s 对齐）
 *
 * 移植差异：
 * - TS EngineResult 可辨识联合 → Go 泛型 struct{ OK bool; ... }（错误经 Error 字段）
 * - AbortSignal.timeout 超时 → http.Client.Timeout；超时错误识别为「引擎请求超时(60s)」，
 *   其余网络错误为「采集引擎不可达(3030)」（与 TS timedOut 分支文案一致）
 * - fetchChapterPaged 同章分页拼接（MAX_CHAPTER_PAGES=4）与 isSameChapterPagination
 *   的路径前缀续写判断逐行移植——这是长章节缺半 bug 的修复点：
 *   仅接受 base_2.html / base/2.html 形态（前缀后首字符必须是 _ / / 之一，? # 分支保留但
 *   实际不可达——JS pathname 亦不含 ?/#，忠实保留原样）；前缀允许省略 .html 后缀的差异
 *   （xinjianpan vl7.html → vl7_2.html、ggd66 y.html → y_2.html）
 */
package main

import (
        "bytes"
        "context"
        "encoding/json"
        "errors"
        "fmt"
        "net"
        "net/http"
        "net/url"
        "os"
        "regexp"
        "strconv"
        "strings"
        "time"
"sync/atomic"
)

// SCRAPER_BASE 引擎地址（Task 26-d 起可经环境变量覆盖，修复旧版三处硬编码：
// 测试实例/多引擎部署下必然打到生产 3030，且测试 runner 的互监护会误杀生产引擎）。
//   - BACKEND_ENGINE_URL：完整 base（如 http://127.0.0.1:3131），优先级最高
//   - BACKEND_ENGINE_PORT：仅端口（如 3131）
//   - 缺省 http://127.0.0.1:3030（生产默认，与历史行为一致）
func engineBaseURL() string {
        if u := strings.TrimSpace(os.Getenv("BACKEND_ENGINE_URL")); u != "" {
                if p, err := url.Parse(u); err == nil && (p.Scheme == "http" || p.Scheme == "https") && p.Host != "" {
                        return strings.TrimRight(u, "/")
                }
        }
        if p := strings.TrimSpace(os.Getenv("BACKEND_ENGINE_PORT")); p != "" {
                if n, err := strconv.Atoi(p); err == nil && n > 0 && n < 65536 {
                        return fmt.Sprintf("http://127.0.0.1:%d", n)
                }
        }
        return "http://127.0.0.1:3030"
}

// isDefaultEngineURL 引擎地址是否为生产默认（runner 互监护仅对默认地址执行
// pkill+拉起——自定义引擎进程的拉起方式未知，杀掉后无法正确重拉）
func isDefaultEngineURL() bool { return engineBaseURL() == "http://127.0.0.1:3030" }

// ENGINE_TIMEOUT_MS 引擎策略链整体预算 55s，超时须 ≥ 预算否则慢站点会被提前切断
const ENGINE_TIMEOUT_MS = 60_000

// MAX_CHAPTER_PAGES 同章分页拼接上限（同一章最多翻 4 次内页，即 5 个分页）
const MAX_CHAPTER_PAGES = 4

var engineHTTPClient = &http.Client{Timeout: ENGINE_TIMEOUT_MS * time.Millisecond}

// engineResult 引擎调用结果（TS EngineResult<T> 联合类型 → struct + OK 标志）
type engineResult[T any] struct {
        OK       bool
        Data     T
        Error    string
        Warnings []string
        Strategy string
        Attempts *int // 引擎响应缺 attempts 时为 nil
        // SoftBlock 引擎 softBlock 档案存在标记（Task 46-b 接线）：引擎 handlers 对「HTTP 200
        // 但规则提取结果全空/正文为空」的成功响应附 softBlock 对象（Task 32-d 专为 backend
        // 消费而加，旧版从未解析）——该形态下 ok=true 且提取为空，仅看 Error 会误判为
        // 「规则失效/选择器不命中」failed 终态；凭此标记可归入软拦截（isSoftBlockErrText 同族），
        // 列表/书页阶段撞限流空壳窗口时任务转 paused 可自动恢复而非烧成终态
        SoftBlock bool
        // ElapsedMs 引擎侧总耗时（handler 入口到响应出口，含域槽位排队等待）。R99 饱和
        // 感知车道控制的数据源：引擎响应顶层 elapsedMs；失败路径/旧引擎为 0（调用方必须
        // 判 >0 才可信）。R114 起饱和观测改用 ServiceElapsedMs(ElapsedMs, QueueMs) 服务耗时
        // 口径（见 QueueMs 注），本字段保留原始值不变形
        ElapsedMs int64
        // QueueMs R114: 引擎侧整链域槽排队等待（链层预等待+获胜策略内部排队求和，引擎
        // 响应顶层 queueMs）。车道自身造成的排队是流水线化正常形态（域槽按礼貌间隔放行，
        // 吞吐与车道数无关），非站点拥堵信号——车道饱和 EWMA 必须剔除，否则 12 车道纯
        // 排队把 EWMA 顶过 3.5s 阈值、车道永久锁死低位（R112 实证）。旧引擎/未埋点为
        // 0：ServiceElapsedMs 回退旧口径（总耗时），向后兼容
        QueueMs int64
}

// engineIsTimeout 判定是否客户端超时（对齐 TS /timeout|abort/i || name==='TimeoutError'）
func engineIsTimeout(err error) bool {
        if err == nil {
                return false
        }
        if errors.Is(err, context.DeadlineExceeded) {
                return true
        }
        var ne net.Error
        return errors.As(err, &ne) && ne.Timeout()
}

// rawJSONString JSON 字段 → 字符串（字符串原样；其他类型转文本；缺失/空 → ""）
func rawJSONString(r json.RawMessage) string {
        if len(r) == 0 {
                return ""
        }
        var s string
        if err := json.Unmarshal(r, &s); err == nil {
                return s
        }
        return string(r)
}

// callEngine 调用引擎；网络异常/超时/非 2xx 一律返回结构化失败，绝不 panic。
// 成功时带回响应顶层 strategy（命中策略名）与 attempts（策略链尝试次数）供可观测性记录。
// return 路径可达性（对齐 TS 12-g2 核对）：①响应非合法 JSON → 失败；②!HTTP 2xx 或引擎
// ok:false → 失败；③成功但缺 data 对象 → 失败；④正常成功。
func callEngine[T any](path string, body map[string]any) engineResult[T] {
        jb, err := json.Marshal(body)
        if err != nil {
                return engineResult[T]{OK: false, Error: "引擎请求体序列化失败", Warnings: []string{}}
        }
        req, err := http.NewRequest("POST", engineBaseURL()+path, bytes.NewReader(jb))
        if err != nil {
                return engineResult[T]{OK: false, Error: "采集引擎不可达(3030)", Warnings: []string{}}
        }
        req.Header.Set("Content-Type", "application/json")
        res, err := engineHTTPClient.Do(req)
        if err != nil {
                if engineIsTimeout(err) {
                        return engineResult[T]{OK: false, Error: fmt.Sprintf("引擎请求超时(%ds)", ENGINE_TIMEOUT_MS/1000), Warnings: []string{}}
                }
                return engineResult[T]{OK: false, Error: "采集引擎不可达(3030)", Warnings: []string{}}
        }
        defer res.Body.Close()
        rb, _ := readAllLimited(res.Body, 8<<20)

        var env struct {
                OK        *bool           `json:"ok"`
                Error     json.RawMessage `json:"error"`
                Detail    json.RawMessage `json:"detail"`
                Warnings  []any           `json:"warnings"`
                Strategy  json.RawMessage `json:"strategy"`
                Attempts  []any           `json:"attempts"`
                Data      json.RawMessage `json:"data"`
                SoftBlock json.RawMessage `json:"softBlock"` // Task 32-d: 200 空壳档案（对象存在即视为命中）
                ElapsedMs json.RawMessage `json:"elapsedMs"` // R99: 引擎侧总耗时（含域槽排队，饱和感知信号）
                QueueMs   json.RawMessage `json:"queueMs"`   // R114: 整链域槽排队等待（服务耗时=总耗时−排队）
        }
        if err := json.Unmarshal(rb, &env); err != nil {
                return engineResult[T]{OK: false, Error: fmt.Sprintf("引擎响应解析失败(HTTP %d)", res.StatusCode), Warnings: []string{}}
        }
        warnings := []string{}
        for _, w := range env.Warnings {
                warnings = append(warnings, fmt.Sprintf("%v", w))
        }

        if res.StatusCode < 200 || res.StatusCode >= 300 || (env.OK != nil && !*env.OK) {
                base := rawJSONString(env.Error)
                if base == "" {
                        base = fmt.Sprintf("HTTP %d", res.StatusCode)
                }
                detail := rawJSONString(env.Detail)
                if detail != "" {
                        detail = truncateRunes(detail, 200)
                }
                if detail != "" {
                        base = base + "（" + detail + "）"
                }
                return engineResult[T]{OK: false, Error: base, Warnings: warnings}
        }

        elapsedMs := parseElapsedMs(string(env.ElapsedMs))
        queueMs := parseElapsedMs(string(env.QueueMs)) // R114: 缺失/非法回 0 → ServiceElapsedMs 回退旧口径

        // 成功响应必须携带 data 对象（引擎 handlers 成功路径恒有）
        trimmed := strings.TrimSpace(string(env.Data))
        if trimmed == "" || trimmed == "null" || trimmed[0] != '{' {
                return engineResult[T]{OK: false, Error: fmt.Sprintf("引擎响应缺少 data 字段(HTTP %d)", res.StatusCode), Warnings: warnings}
        }
        var data T
        if err := json.Unmarshal(env.Data, &data); err != nil {
                return engineResult[T]{OK: false, Error: fmt.Sprintf("引擎响应 data 解析失败(HTTP %d)", res.StatusCode), Warnings: warnings}
        }
        // Task 49-b: softBlock 显式 null 防御——RawMessage 对 `"softBlock": null` 也有 4 字节，
        // 旧版 len>0 判定会把 null 误当档案命中（空提取被归入软拦截 → paused 自动恢复空转
        // 烧预算，真实规则失效被掩盖）。引擎现行实现只在命中时附对象（非 null），此处为契约
        // 纵深防御
        softBlockPresent := len(env.SoftBlock) > 0 &&
                !bytes.Equal(bytes.TrimSpace(env.SoftBlock), []byte("null"))
        out := engineResult[T]{OK: true, Data: data, Warnings: warnings, Strategy: rawJSONString(env.Strategy), SoftBlock: softBlockPresent, ElapsedMs: elapsedMs, QueueMs: queueMs}
        if env.Attempts != nil {
                n := len(env.Attempts)
                out.Attempts = &n
        }
        return out
}

// engineRuleBody 组装引擎请求体（charset/proxy/insecureTLS/cookies/referer 可选字段按存在性展开）
func engineRuleBody(u string, ruleVal any, rule LoadedRule, referer string) map[string]any {
        body := map[string]any{"url": u, "rule": ruleVal}
        if rule.Charset != "" {
                body["charset"] = rule.Charset
        }
        if rule.Proxy != "" {
                body["proxy"] = rule.Proxy
        }
        if rule.InsecureTLS {
                body["insecureTLS"] = true
        }
        // R119: 规则级策略分层下限透传（引擎链层过滤 tier < minTier 的策略；0=默认不发）
        if rule.MinTier > 0 {
                body["minTier"] = rule.MinTier
        }
        // Task 53: 规则级静态 cookie 底座——Trim 后非空才下发（与 loadRule 装载端 TrimSpace、
        // 引擎 strField TrimSpace+4096 rune 钳制同口径；条件自含不依赖调用方预裁剪，空白值
        // 绝不发空/纯空白键，引擎侧缺省=无注入）
        if c := strings.TrimSpace(rule.Cookies); c != "" {
                body["cookies"] = c
        }
        if referer != "" {
                body["referer"] = referer
        }
        return body
}

// engineRuleBodyWait 引擎请求体 + waitSelector（R120 遗留①）：JS 慢渲染站的「关键
// 选择器」透传——fetch-cloak 策略转给侧车 /cloak 由子进程 wait_for_selector 等待
// 渲染完成（超时不失败），未命中按策略失败让链继续复核。选择器由各调用点取「该页
// 主提取选择器」（列表 itemSelector/书页 titleSelector/目录 chapterLinkSelector/
// 正文 contentSelector）：选择器出现 ≈ 提取必然非空，天然对齐 softBlock 语义。
func engineRuleBodyWait(u string, ruleVal any, rule LoadedRule, referer, waitSelector string) map[string]any {
        body := engineRuleBody(u, ruleVal, rule, referer)
        if ws := cssSafeWaitSelector(waitSelector); ws != "" {
                body["waitSelector"] = ws
        }
        return body
}

// cssSafeWaitSelector R120: DSL 选择器过滤（与 scraper-go util.go 同语义双实现——
// 两服务独立构建无共享包）：:contains()/aref/ownText 等 pickText 专有语法对侧车
// Playwright wait_for_selector 非法，不透传（该页不等待，行为与旧版一致）。
func cssSafeWaitSelector(s string) string {
        sel := strings.TrimSpace(s)
        if sel == "" || len(sel) > 256 {
                return ""
        }
        low := strings.ToLower(sel)
        for _, tok := range []string{":contains(", "aref", "owntext", "text(", "@style", "attr("} {
                if strings.Contains(low, tok) {
                        return ""
                }
        }
        return sel
}

// bookPageResult fetchBookPage 结果
type bookPageResult struct {
        OK   bool
        Book BookData
        Err  string
        // R86：引擎响应 warnings 透出（原版丢弃）——小目录护栏需从中识别
        // chapterListApi 限速 shed 警告（目录被截断的精确证据）
        Warnings []string
}

// fetchBookPage 抓取并提取一个书页（每次调用成功命中后记一行策略日志；quiet 抑制日志）。
// referer 可选（""=不传）：列表页场景把站点首页/上一页作为来路传入。
func fetchBookPage(run *Run, u string, rule LoadedRule, referer string, quiet bool) bookPageResult {
        res := callEngine[struct {
                Book *BookData `json:"book"`
        // R120: 书页关键选择器 = titleSelector（书页多为服务端渲染，选择器已在则零等待）
        }]("/api/test", engineRuleBodyWait(u, map[string]any{"bookRule": rule.BookRule}, rule, referer, rule.BookRule["titleSelector"]))
        if !res.OK {
                return bookPageResult{OK: false, Err: res.Error}
        }
        if len(res.Warnings) > 0 && !quiet {
                run.LogWarnings(res.Warnings)
        }
        if res.Strategy != "" && !quiet {
                n := "?"
                if res.Attempts != nil {
                        n = itoa(*res.Attempts)
                }
                run.Log(fmt.Sprintf("书页命中策略 %s（尝试 %s 次）", res.Strategy, n))
        }
        if res.Data.Book == nil || res.Data.Book.Title == "" {
                // Task 46-b: 200 空壳误判修正——引擎 ok=true 但附 softBlock 档案时，
                // 提取为空是「限流软拦截/挑战竞态」而非「规则失效」；旧文案不含任何软拦截
                // 字样 → isTransientScrapeErr 不命中 → 单本任务书目全败时被烧成 failed 终态
                //（自动恢复永不接手）。改用软拦截文案让 Phase 1 全败路径转 paused 可自动恢复
                if res.SoftBlock {
                        return bookPageResult{OK: false, Err: softBlockEmptyErrText}
                }
                return bookPageResult{OK: false, Err: "未提取到书籍标题（规则与内置回退均未命中）"}
        }
        return bookPageResult{OK: true, Book: *res.Data.Book, Warnings: res.Warnings}
}

// 小目录护栏常量（R86 目录截断修复）：
//   - tocShedSmallToc：书页内嵌章节数低于该值时视为「目录可能被限速截断」（ixdzs8 实测内嵌 8 章；
//     正常书页全量目录均远超此值，误触发代价仅为多 1-2 次书页抓取）
//   - tocShedRetries：退避重抓次数上限
//   - tocShedBackoffMS：重抓退避（让域槽队列先消耗掉积压的书页/接口请求）
const (
        tocShedSmallToc  = 50
        tocShedRetries   = 2
        tocShedBackoffMS = 3_000
)

// fetchBookPageWithTocRetry 书页抓取 + 小目录护栏（R86）：
// 配置了 chapterListApi 的站点（ixdzs8 系），书页内嵌仅「最新几章」，完整目录靠同源 JSON
// 接口——引擎域限速排队超预算 shed 该接口时（结构化警告），本次书页的目录是截断的，
// 旧实现照单全收 → 86 本书只入库 8 章。护栏：内嵌章节数低于阈值且出现 shed 警告时，
// 退避后重抓书页（此时域槽队列已消耗，JSON 目录大概率排上）。重试仍 shed 则按旧语义
// 入库（骨架按标题增量 upsert，后续重采/重扫可继续补全）。未配置 chapterListApi 的
// 规则零开销（一次类型断言 + 一次 TrimSpace）。
func fetchBookPageWithTocRetry(run *Run, u string, rule LoadedRule, referer string) bookPageResult {
        page := fetchBookPage(run, u, rule, referer, false)
        if !page.OK || strings.TrimSpace(rule.BookRule["chapterListApi"]) == "" {
                return page
        }
        for attempt := 1; attempt <= tocShedRetries && tocShedTruncated(page); attempt++ {
                run.Log(fmt.Sprintf("目录疑似被限速截断（仅 %d 章），重试书页 %d/%d：%s",
                        bookChapterCount(page.Book), attempt, tocShedRetries, truncateRunes(u, 90)))
                time.Sleep(tocShedBackoffMS * time.Millisecond)
                if stopState(run.TaskID) != "" {
                        break // 取消/暂停：停止重试，保留当前结果
                }
                retry := fetchBookPage(run, u, rule, referer, false)
                if !retry.OK {
                        break // 重抓失败：保留首次成功结果（旧语义）
                }
                page = retry
        }
        return page
}

// tocShedTruncated 判定本次书页结果是否为「JSON 目录被限速丢弃的小目录」
func tocShedTruncated(page bookPageResult) bool {
        if bookChapterCount(page.Book) >= tocShedSmallToc {
                return false
        }
        for _, w := range page.Warnings {
                if strings.Contains(w, "chapterListApi") && strings.Contains(w, "超预算") {
                        return true
                }
        }
        return false
}

// bookChapterCount nil 安全取书页内嵌章节数
func bookChapterCount(b BookData) int {
        if b.ChapterCount == nil {
                return 0
        }
        return *b.ChapterCount
}

// softBlockEmptyErrText 200 空壳响应的统一失败文案（Task 46-b）。
// 契约：必须命中 isSoftBlockErrText（含「空壳/软拦截/挑战」任一字样），使列表/书页
// 阶段的空壳形态进入 isTransientScrapeErr → paused 可自动恢复，而非 failed 终态。
// 注意改文案时勿丢失这些字样。
const softBlockEmptyErrText = "HTTP 200 空壳响应（引擎 softBlock 档案：疑似限流软拦截/挑战竞态页，非规则失效）"

// fetchListPage 抓取并提取一个列表页；失败时记录日志并返回空数组（翻页场景失败可跳过）
// Task 33: 返回值追加错误文本——调用方（runList）需区分「选择器失效/空页」与「引擎主机
// 熔断/软拦截冷却中」：后者是瞬态，任务应转 paused（自动恢复资格）而非 failed 终态。
// Task 46-b: 引擎 ok=true 但附 softBlock 档案（200 空壳）时返回软拦截文案——旧版返回
// 空错误串，首页空壳在 runList 被误判「列表页未提取到书籍条目」failed 终态。
func fetchListPage(run *Run, u string, rule LoadedRule, referer string) ([]ListItem, string) {
        res := callEngine[struct {
                List *struct {
                        Items []ListItem `json:"items"`
                } `json:"list"`
        // R120: 列表页关键选择器 = itemSelector（JS 渲染列表站 cloak 等条目渲染完再取页）
        }]("/api/test", engineRuleBodyWait(u, map[string]any{"listRule": rule.ListRule}, rule, referer, rule.ListRule["itemSelector"]))
        if !res.OK {
                run.Log(fmt.Sprintf("列表页抓取失败(%s): %s", truncateRunes(u, 100), res.Error))
                return nil, res.Error
        }
        if len(res.Warnings) > 0 {
                run.LogWarnings(res.Warnings)
        }
        items := []ListItem{}
        if res.Data.List != nil {
                for _, it := range res.Data.List.Items {
                        if it.URL != "" { // TS filter(!!it.url)
                                items = append(items, it)
                        }
                }
        }
        if len(items) == 0 && res.SoftBlock { // Task 46-b: 200 空壳 → 软拦截文案（见函数注释）
                return nil, softBlockEmptyErrText
        }
        return items, ""
}

// fetchTocPage 抓取一个目录页并提取章节链接与下级分页链接（配合 bookRule.
// chapterLinkSelector / chapterListPaginationSelector）。失败记录日志返回 ok=false
// （调用方回退书页章节链接）。R82：目录分页站（biquge2023 系）书页只内嵌第一页
// 章节，全量目录按 list-N.html 分页承载，且分页页章节锚 href=javascript:; 混淆
// （引擎侧 effectiveAnchorHref 反混淆）——分页链接经 chapterListPaginationSelector
// 以 BookData.TocPages 透出。
func fetchTocPage(run *Run, u string, rule LoadedRule, referer string, quiet bool) ([]ChapterRef, []string, bool) {
        bookRule := RuleMap{}
        // chapterTitleSelector 一并透传：ownText 关键字（legado 书源语义）在目录页同样生效，
        // 否则分页目录站的章名会混入锚内站方标记（书海阁 <i class="red"> [免费]</i> 实测）
        for _, key := range []string{"chapterLinkSelector", "chapterTitleSelector", "excludeSelector", "chapterListPaginationSelector"} {
                if v := rule.BookRule[key]; v != "" {
                        bookRule[key] = v
                }
        }
        res := callEngine[struct {
                Book *BookData `json:"book"`
        // R120: 目录页关键选择器 = chapterLinkSelector（JS 渲染目录站 cloak 等章锚渲染完）
        }]("/api/test", engineRuleBodyWait(u, map[string]any{"bookRule": bookRule}, rule, referer, bookRule["chapterLinkSelector"]))
        if !res.OK {
                if !quiet {
                        run.Log(fmt.Sprintf("目录页抓取失败(%s): %s", truncateRunes(u, 100), res.Error))
                }
                return nil, nil, false
        }
        if len(res.Warnings) > 0 && !quiet {
                run.LogWarnings(res.Warnings)
        }
        if res.Data.Book == nil {
                return nil, nil, false
        }
        return res.Data.Book.Chapters, res.Data.Book.TocPages, true
}

// MAX_TOC_PAGES_PER_BOOK 单本书目录分页跟随上限（分页目录站 100 章/页实测，
// 9993 章顶格书 ≈100 页；120 留冗余，防御分页环/异常无限页集）
const MAX_TOC_PAGES_PER_BOOK = 120

// stripURLHash 去锚点变体（列表页跳转 #frag 与正页同址）
func stripURLHash(u string) string {
        if idx := strings.Index(u, "#"); idx >= 0 {
                return u[:idx]
        }
        return u
}

// mergeTocRefs 按 URL 去重合并目录页章节引用（同 URL 首现者胜、保持首现顺序——
// 同章可能同时出现在书页内嵌块与分页页/多页重复，标题以首次提取为准）。
// R82 抽为纯函数便于回归锁定。
func mergeTocRefs(dst []ChapterRef, add []ChapterRef) []ChapterRef {
        seen := make(map[string]bool, len(dst)+len(add))
        for _, r := range dst {
                seen[stripURLHash(r.URL)] = true
        }
        for _, r := range add {
                if r.URL == "" {
                        continue
                }
                key := stripURLHash(r.URL)
                if seen[key] {
                        continue
                }
                seen[key] = true
                dst = append(dst, r)
        }
        return dst
}

// tocWalkerRetryBackoffMS walker 退化整轮重试退避（R86）
const tocWalkerRetryBackoffMS = 5_000

// walkerDegenerate walker 是否颗粒无收（种子全败=0 页，或抓到的页全被限流软拦截=0 条）。
// 「跑了页也有条数但没赢过内嵌」不算退化（可能是小书全重复），不重试。
func walkerDegenerate(pagesWalked int, refs []ChapterRef) bool {
        return pagesWalked == 0 || len(refs) == 0
}

// pageWarnedTocPagination 书页 warnings 是否报告了目录分页锚（引擎
// chapterListPaginationSelector 命中时附「发现目录分页 N 页」结构化警告）
func pageWarnedTocPagination(warnings []string) bool {
        for _, w := range warnings {
                if strings.Contains(w, "chapterListPaginationSelector") && strings.Contains(w, "发现目录分页") {
                        return true
                }
        }
        return false
}

// sleepMs 毫秒睡眠（测试/重试退避共用）
func sleepMs(ms int64) { time.Sleep(time.Duration(ms) * time.Millisecond) }

// fetchFullToc 目录 walker：从种子页（catalogURL / 书页命中的分页链接）出发逐页
// 抓取合并章节引用，直到无新分页或触及页数/章数上限。返回合并后的引用与实际
// 抓取页数（0=种子全部失败，调用方保持旧回退语义）。
// R82 二轮修复：种子不得预先入 visited——旧写法把全部种子先标记 visited，而循环
// 出队时「已 visited 且非首个」即跳过，导致第二个及以后的种子页（list-2…list-N，
// 往往是唯一含新章的页）被静默跳过，walker 永远只抓到第一页（实测全为重复章，
// 合并数恰等于书页内嵌数，REPLACE 永不触发）。改为：书页自身（referer）预标记
// 防回链；种子出队去重后逐个记账再抓；分页链接仅在未访问时入队。
func fetchFullToc(run *Run, seeds []string, rule LoadedRule, referer string, quiet bool) ([]ChapterRef, int) {
        visited := map[string]bool{}
        if referer != "" {
                visited[stripURLHash(referer)] = true // 书页自身（分页页常回链书页）
        }
        queue := make([]string, 0, len(seeds))
        for _, s := range seeds {
                s = stripURLHash(s)
                if s == "" || visited[s] {
                        continue
                }
                visited[s] = true
                queue = append(queue, s)
        }
        refs := []ChapterRef{}
        pages := 0
        for len(queue) > 0 && pages < MAX_TOC_PAGES_PER_BOOK && len(refs) <= MAX_CHAPTERS_PER_BOOK {
                u := queue[0]
                queue = queue[1:]
                pageRefs, tocPages, ok := fetchTocPage(run, u, rule, referer, quiet)
                if !ok {
                        continue
                }
                pages++
                refs = mergeTocRefs(refs, pageRefs)
                for _, p := range tocPages {
                        p = stripURLHash(p)
                        if p == "" || visited[p] {
                                continue
                        }
                        visited[p] = true
                        queue = append(queue, p)
                }
        }
        return refs, pages
}

// fetchChapter 抓取并提取一个章节（warnings 由调用方按存储成败决定是否记录）
func fetchChapter(u string, rule LoadedRule, referer string) engineResult[ChapterData] {
        // R120: 正文页关键选择器 = contentSelector（JS 渲染正文站 cloak 等正文区渲染完）
        return callEngine[ChapterData]("/api/chapter", engineRuleBodyWait(u, rule.ChapterRule, rule, referer, rule.ChapterRule["contentSelector"]))
}

var (
        // htmlSuffixRE \.[sx]?html?$（.html/.htm/.shtml/.xhtml 等，忽略大小写）
        htmlSuffixRE = regexp.MustCompile(`(?i)\.[sx]?html?$`)
        // pageParamRE (?:^|[&?])page=\d+（?page=2 形态的 page 参数递增语义）
        pageParamRE = regexp.MustCompile(`(?:^|[&?])page=\d+`)
)

// isSameChapterPagination 判断 nextUrl 是否是「当前章节的下一分页」而非下一章：
// 仅接受路径前缀续写形态（base_2.html / base/2.html / base?page=2），前缀后第一个字符
// 必须是 _ / / ? # 之一，防止 /book/1/ 误匹配 /book/12/ 这类数字续写。
// 逐行移植自 engine-client.ts（Task 3 第二轮：huangjinwu/ggd66 长章节缺半修复点）。
func isSameChapterPagination(base, next string) bool {
        // JS new URL() 对非法/相对 URL 抛异常 → catch 返回 false；Go 以 IsAbs 等价判定
        b, err := url.Parse(base)
        if err != nil || !b.IsAbs() {
                return false
        }
        n, err := url.Parse(next)
        if err != nil || !n.IsAbs() {
                return false
        }
        // 同章分页必在同主机同路径空间（跨域/换路径视为另一页）
        if b.Host != n.Host {
                return false
        }
        np := n.EscapedPath()
        // 前缀匹配（允许 base 省略 .html 后缀的差异；前缀后第一个字符必须是 _ / ? #，
        // 防 /book/1/ 误匹配 /book/12/）
        prefixes := []string{strings.TrimRight(b.EscapedPath(), "/")}
        if htmlSuffixRE.MatchString(prefixes[0]) {
                prefixes = append(prefixes, htmlSuffixRE.ReplaceAllString(prefixes[0], ""))
        }
        for _, bp := range prefixes {
                // Task 27-c（重新应用 25-a 修复⑧①，合并时丢失）：base 为站点根（如 https://x.com）
                // 时 TrimRight 得空前缀使 HasPrefix 恒真 → 同主机任意路径（/2.html）被误判为
                // 同章分页，正文串章；空前缀跳过
                if bp == "" {
                        continue
                }
                // Task 27-c（重新应用 25-a 修复⑧②，合并时丢失）：EscapedPath 恒不含 '?'，
                // 下方 sep=='?' 分支实际不可达（Go 与 JS pathname 同病）；「路径完全相等 +
                // ?page=N」形态的同章分页（/reader.php?cid=1 → /reader.php?cid=1&page=2）
                // 需显式判定，否则长章节分页从未被拼接（缺半）。pageParamRE 限定 page 参数
                // 递增语义，?cid= 等非 page 参数不受影响
                if np == bp && pageParamRE.MatchString(n.RawQuery) {
                        return true
                }
                if !strings.HasPrefix(np, bp) || len(np) == len(bp) {
                        continue
                }
                sep := np[len(bp)]
                if sep != '_' && sep != '/' && sep != '?' && sep != '#' {
                        continue
                }
                if sep == '?' {
                        // ?page=2 形态：要求 page 参数递增语义存在（JS 检测 n.search；Go 用 RawQuery 等价）
                        return pageParamRE.MatchString(n.RawQuery)
                }
                return true
        }
        return false
}

// chapterFetchImpl 章节抓取实现缝（R99）：worker 经此变量调用 fetchChapterPaged，
// 单测可换注入假实现验证「排队饱和快速失败救援重试」与饱和感知车道控制。
var chapterFetchImpl = fetchChapterPaged

// queueShedBackoff 排队饱和救援重试前的泄压等待（测试可缩短）
var queueShedBackoff = 2 * time.Second

// fetchChapterRescued R99: 排队饱和救援包装——非 shed 错误原样透传（不重试）；
// shed 错误（未发网络请求、源站无辜）歇 queueShedBackoff 让域槽队列泄压后重试一次，
// 成功则计数 rescued（供任务日志观测救援效果）。
func fetchChapterRescued(u string, rule LoadedRule, referer string, rescued *atomic.Int64) engineResult[ChapterData] {
        res := chapterFetchImpl(u, rule, referer)
        if !res.OK && isQueueShedErr(res.Error) {
                time.Sleep(queueShedBackoff)
                if res2 := chapterFetchImpl(u, rule, referer); res2.OK {
                        res = res2
                        rescued.Add(1)
                }
        }
        return res
}

// parseElapsedMs R99: 引擎响应顶层 elapsedMs 解析（非正整数/缺失/非法一律 0=不可信）。
func parseElapsedMs(raw string) int64 {
        trimmed := strings.TrimSpace(raw)
        if trimmed == "" {
                return 0
        }
        n, err := strconv.ParseInt(trimmed, 10, 64)
        if err != nil || n <= 0 {
                return 0
        }
        return n
}

// ewmaNext R99: 引擎耗时 EWMA 递推（α=1/4；ms<=0 不可信（失败路径/旧引擎/测试假实现）
// 原样返回 cur 防拖低均值；cur<=0 视为无历史直接采纳）。
func ewmaNext(cur, ms int64) int64 {
        if ms <= 0 {
                return cur
        }
        if cur <= 0 {
                return ms
        }
        return cur + (ms-cur)/4
}

// laneBumpFrozen R99: 饱和感知回升冻结判定（EWMA 超阈即冻结，见 laneQueueFreezeEWMA）。
func laneBumpFrozen(ewma int64) bool { return ewma > laneQueueFreezeEWMA }

// ServiceElapsedMs R114: 车道饱和 EWMA 的采样口径——服务耗时=引擎总耗时−域槽排队。
// R112 实证旧口径（总耗时含排队）的缺陷：N 车道对礼貌限速域槽（~1 req/1.35s）纯
// 过订阅时，末位车道排队 N×1.35s 起，EWMA 被「车道自排队」顶过 3.5s 阈值 → 回升
// 永久冻结（车道锁死 4），而域槽吞吐与车道数无关（流水线化），排队深但 budget 闸未
// shed = 供需健康。排队由引擎逐层埋点求和（链层+策略内部，queueMs）；未埋点路径
// （旧引擎/失败路径）queue=0 → 原样返回 total，向后兼容 R99 行为。queue>total
// （跨进程时钟毛刺）钳 0——ewmaNext 对 ms<=0 视为不可信样本跳过。
func ServiceElapsedMs(totalMs, queueMs int64) int64 {
        if queueMs <= 0 || totalMs <= 0 {
                return totalMs
        }
        svc := totalMs - queueMs
        if svc < 0 {
                return 0
        }
        return svc
}

// chapterServiceSample R115（R114 遗留②落地）：车道饱和 EWMA 的采样门——失败章不采样。
//
// 背景：EWMA 采样点原本对成功/失败章一视同仁。但失败链的 ElapsedMs 是「策略链探索
// 烧穿」的时长（挑战站每章 8 策略 × 重试 × 退避可达 10-55s），其中服务耗时部分同样
// 巨大——它度量的是「本机对抗挑战的成本」，不是站点的稳态服务速度。挑战站每章多策略
// 探索时 EWMA 被持续顶过 3.5s 阈值 → bumpLaneOnSuccess 恒走冻结分支 → 连捷计数恒清零
// → 车道回升永久冻结（与 R112「排队锁死」同构的口径病，只是这次被污染的样本是失败链）。
//
// 语义：仅成功章采样（ok=false 返回 0，ewmaNext 对 ms<=0 拒收天然跳过）。安全边界：
// 站点真变慢时成功章服务耗时同样上升 → 冻结照旧触发（正常路径语义保留）；失败风暴
// （限流/挑战/封禁）由 shrinkLanes 逐章降档 + PHASE2_FAIL_BREAKER 熔断兜底，不依赖 EWMA。
func chapterServiceSample(ok bool, elapsedMs, queueMs int64) int64 {
        if !ok {
                return 0
        }
        return ServiceElapsedMs(elapsedMs, queueMs)
}

// fetchChapterPaged 抓取整章（含同章分页拼接）：首版 fetchChapter 后，若引擎返回的
// nextUrl 是当前章节的下一分页，继续抓取并把正文按段落合并，直至无分页/达上限。
// 任何一页失败都保留已抓到的部分（partial 内容优于整体失败）。
func fetchChapterPaged(u string, rule LoadedRule, referer string) engineResult[ChapterData] {
        first := fetchChapter(u, rule, referer)
        if !first.OK {
                return first
        }
        // R99: 各分页引擎耗时的最大值作为本章饱和信号（任一页排长队都说明域槽饱和）
        maxElapsed := first.ElapsedMs
        data := first.Data
        warnings := append([]string(nil), first.Warnings...)
        strategy := first.Strategy
        attempts := first.Attempts
        visited := map[string]bool{u: true}
        mergedChars := 0 // Task 27-c: 已合并正文 rune 计（内存护栏用）
        next := data.NextURL
        for page := 2; next != "" && page <= MAX_CHAPTER_PAGES+1; page++ {
                if !isSameChapterPagination(u, next) {
                        break
                }
                if visited[next] { // 引擎 nextUrl 环路防御
                        break
                }
                // Task 27-c（重新应用 25-a 修复⑧③，合并时丢失）：分页合并内存护栏——
                // 已合并内容达 MAX_CONTENT_CHARS×4（同 fetchChapterPaged 上限 5 页 × 单页上限
                // 的量级）即停，防异常大页 × 多分页 × 12 车道瞬时内存尖峰
                if mergedChars >= MAX_CONTENT_CHARS*4 {
                        break
                }
                visited[next] = true
                sub := fetchChapter(next, rule, referer)
                if !sub.OK || strings.TrimSpace(sub.Data.Content) == "" {
                        break
                }
                // 合并正文：分页边界按段落直接续接（各页正文已由引擎清洗过）
                mergedChars += runeLen(sub.Data.Content)
                data.Content = data.Content + "\n" + sub.Data.Content
                data.Paragraphs = append(append([]string(nil), data.Paragraphs...), sub.Data.Paragraphs...)
                data.WordCount += sub.Data.WordCount
                data.NextURL = sub.Data.NextURL
                warnings = append(warnings, sub.Warnings...)
                strategy = sub.Strategy
                attempts = sub.Attempts
                next = sub.Data.NextURL
        }
        // warnings 去重保序（[...new Set(warnings)] 语义）
        seen := map[string]bool{}
        uniq := make([]string, 0, len(warnings))
        for _, w := range warnings {
                if !seen[w] {
                        seen[w] = true
                        uniq = append(uniq, w)
                }
        }
        return engineResult[ChapterData]{OK: true, Data: data, Warnings: uniq, Strategy: strategy, Attempts: attempts, ElapsedMs: maxElapsed}
}
