/**
 * transbulk.go —— 存量翻译落库 worker（R183 重建；R177 形态随第 40 次沙箱重置丢失，
 * 按 R173 LibreTranslate-only 终局语义重建）。
 *
 * 背景：R173 后 en/ja/ko 主引擎 = LibreTranslate（本地零边际成本），原「LLM 成本闸」
 * 前提消失——存量补翻只剩 :5000 ctranslate2 CPU 推理吞吐约束（en 单跳一章 ~1100 字
 * 15-40s；ja/ko 双跳 45s+）。transbulk 与 translatewarm 双车道分工：
 *   translatewarm —— OpenCC 语种（zh-Hant/zh-HK）秒级快车道（2s/6 章轮询）。
 *   transbulk     —— libre 语种（en/ja/ko）慢车道：独立消费循环互不抢行。
 *
 * 三条产线：
 *   ① 书籍信息直翻（启动即跑 + 6h/轮）：Novel.title/description 全五语种预热落
 *     TranslationCache（段少量小不走队列；OpenCC 秒级 + libre 批翻；缓存 key 幂等）
 *     ——「所有在库的书籍信息都要开始进行翻译」直接兑现面。
 *   ② 存量正文入队（启动即跑 + 30min/轮兜底）：ChapterContent 全量 × libre 语种
 *     INSERT OR IGNORE 入队 TranslationQueue（UNIQUE(chapterId,target) 幂等；
 *     新正文同步入队由 translateEnqueueChapter 钩子覆盖，本扫描为重启/漏钩兜底）。
 *   ③ libre 消费循环（1s/轮，批 2 章）：按 :5000 已装语言动态过滤（模型未落地语种
 *     暂跳不烧重试，install-models.sh 装齐重启 :5000 后 60s 内自动放开）；
 *     复用 translateWarmChapter 三级回落正文读+批翻状态机。
 *
 * env：TRANSLATEBULK_OFF=1 停用；TRANSLATEBULK_TARGETS 覆盖 libre 语种清单。
 */
package main

import (
        "database/sql"
        "encoding/json"
        "io"
        "log"
        "net/http"
        "os"
        "strings"
        "sync"
        "time"
)

// translateLibreBaseURL LibreTranslate 引擎直连（:5000 侧车；语言面探测专用，
// 业务翻译统一走 :3032 translate-service 门面）
const translateLibreBaseURL = "http://127.0.0.1:5000"

// translateBulkTargets libre 语种清单（env TRANSLATEBULK_TARGETS 覆盖，逗号分隔；
// 默认 en,ja,ko——R173 终局：libre 本地零边际成本，唯一约束是 :5000 CPU 推理吞吐）。
// OpenCC 语种（zh-Hant/zh-HK）归 warm 快车道，此处强制排除。
var translateBulkTargets = sync.OnceValue(func() []string {
        raw := strings.TrimSpace(os.Getenv("TRANSLATEBULK_TARGETS"))
        if raw == "" {
                raw = "en,ja,ko"
        }
        out := []string{}
        for _, t := range strings.Split(raw, ",") {
                t = strings.TrimSpace(t)
                if t == "" || !translateTargets[t] {
                        continue
                }
                if t == "zh-Hant" || t == "zh-HK" {
                        continue
                }
                out = append(out, t)
        }
        return out
})

// translateBatchParas 段批翻共用核心（translateWarmChapter/transbulk/title-warm 三消费方）：
// 缓存覆盖检查 → 未命中段 translateUpstream（≤40 段/批，R190）→ 回写 TranslationCache。
// 返回实际 upstream 段数（缓存全命中为 0）；上游失败返回 error（调用方走状态机重试）。
func translateBatchParas(paras []string, target string, novelID int64) (int, error) {
        // R190：批 12（原 280）——libre 语种长批在 :5000 是巨调用头部阻塞（argos 每模型
        // 全局锁串行，280 段批 ≈7min 独占，渲染补译片全部排队超时空手而归）。12 段/批
        // en ≈18s ja/ko ≈36s——头阻塞时长 ≤ 补译预算量级（flight 激活时当前调用结束后
        // 批间让路即生效，部分进度已落库不丢），渲染补译片等待一个在途调用后必获推理窗。
        const batchSize = 12
        missTotal := 0
        for start := 0; start < len(paras); start += batchSize {
                if syncFillActive.Load() > 0 {
                        return missTotal, nil
                }
                end := start + batchSize
                if end > len(paras) {
                        end = len(paras)
                }
                batch := paras[start:end]
                keys := make([]string, len(batch))
                for i, p := range batch {
                        keys[i] = translateCacheKey(p, target)
                }
                hits := translateCacheGet(keys)
                missTexts := []string{}
                for i, p := range batch {
                        if _, ok := hits[keys[i]]; !ok {
                                missTexts = append(missTexts, p)
                        }
                }
                if len(missTexts) > 0 {
                        upResults, err := translateUpstream(target, missTexts, nil)
                        if err != nil {
                                return missTotal, err
                        }
                        // 回写：失败段空串由 translateCachePut 内部跳过不落缓存，契约一致
                        keysMiss := make([]string, len(missTexts))
                        missIdxAll := make([]int, len(missTexts))
                        for i, p := range missTexts {
                                keysMiss[i] = translateCacheKey(p, target)
                                missIdxAll[i] = i
                        }
                        translateCachePut(missTexts, keysMiss, upResults, missIdxAll, novelID)
                }
                missTotal += len(missTexts)
        }
        return missTotal, nil
}

// ---------- 产线 ①：书籍信息直翻 ----------

// translateAppendParas 段构造：trim、<2 rune 跳过、>9000 rune 硬切防上游单段上限
// （:3032 校验单段 ≤10000 字，超限整批 400——书简介异常长文防御性切分）
func translateAppendParas(paras []string, s string) []string {
        for _, p := range strings.Split(s, "\n") {
                p = strings.TrimSpace(p)
                rs := []rune(p)
                for len(rs) >= 2 {
                        end := len(rs)
                        if end > 9000 {
                                end = 9000
                        }
                        paras = append(paras, string(rs[:end]))
                        rs = rs[end:]
                }
        }
        return paras
}

// translateBulkBooksOnce 书籍信息全语种预热（Novel.title/description → TranslationCache）。
// 幂等：缓存 key 命中零 upstream；失败返回 false（主循环 2min 后重试，不干等 6h）。
func translateBulkBooksOnce() bool {
        type bookRow struct {
                id    int64
                title string
                desc  string
        }
        books := []bookRow{}
        err := queryList(
                `SELECT "id","title",COALESCE("description",'') FROM "Novel" ORDER BY "id" ASC`,
                func(rs *sql.Rows) error {
                        var b bookRow
                        if err := rs.Scan(&b.id, &b.title, &b.desc); err == nil {
                                books = append(books, b)
                        }
                        return nil
                })
        if err != nil {
                log.Printf("[translate-bulk] 书信息扫描 FAIL: %v", err)
                return false
        }
        targets := append(append([]string{}, translateWarmTargets()...), translateBulkTargets()...)
        upCalled := 0
        for _, t := range targets {
                for _, bk := range books {
                        paras := translateAppendParas(nil, bk.title)
                        paras = translateAppendParas(paras, bk.desc)
                        if len(paras) == 0 {
                                continue
                        }
                        n, err := translateBatchParas(paras, t, bk.id)
                        if err != nil {
                                log.Printf("[translate-bulk] 书信息 target=%s novelId=%d FAIL: %v", t, bk.id, firstLineErr(err))
                                return false
                        }
                        upCalled += n
                }
        }
        log.Printf("[translate-bulk] 书信息预热完成 books=%d targets=%v upstreamSegs=%d", len(books), targets, upCalled)
        return true
}

// ---------- 产线 ②：存量正文入队 ----------

// translateBulkEnqueueScan 存量正文 × libre 语种全量入队（INSERT OR IGNORE 幂等；
// done/failed 行不重置）。分批 50 行×多语种拼 INSERT（SQLite 变量数上限防御）。
func translateBulkEnqueueScan() {
        targets := translateBulkTargets()
        if len(targets) == 0 {
                return
        }
        rows := []struct{ novelID, chID int64 }{}
        err := queryList(
                `SELECT c."novelId", cc."chapterId" FROM "ChapterContent" cc
                 JOIN "Chapter" c ON c."id" = cc."chapterId"`,
                func(rs *sql.Rows) error {
                        var r struct{ novelID, chID int64 }
                        if err := rs.Scan(&r.novelID, &r.chID); err == nil {
                                rows = append(rows, r)
                        }
                        return nil
                })
        if err != nil {
                log.Printf("[translate-bulk] 存量正文扫描 FAIL: %v", err)
                return
        }
        if len(rows) == 0 {
                return
        }
        now := nowMillis()
        const batchRows = 50
        enqueued := int64(0)
        for start := 0; start < len(rows); start += batchRows {
                end := start + batchRows
                if end > len(rows) {
                        end = len(rows)
                }
                var sb strings.Builder
                sb.WriteString(`INSERT OR IGNORE INTO "TranslationQueue" ("novelId","chapterId","target","state","attempts","updatedAt") VALUES `)
                args := []any{}
                for _, r := range rows[start:end] {
                        for _, t := range targets {
                                sb.WriteString("(?,?,?,'pending',0,?),")
                                args = append(args, r.novelID, r.chID, t, now)
                        }
                }
                res, err := execRetry(strings.TrimSuffix(sb.String(), ","), args...)
                if err != nil {
                        log.Printf("[translate-bulk] 存量入队批 FAIL: %v", firstLineErr(err))
                        return
                }
                if res != nil {
                        n, _ := res.RowsAffected()
                        enqueued += n
                }
        }
        log.Printf("[translate-bulk] 存量正文入队 chapters=%d targets=%v newRows=%d", len(rows), targets, enqueued)
}

// ---------- 产线 ③：libre 消费循环 ----------

var translateBulkLangsMu sync.Mutex
var translateBulkLangs = map[string]bool{}
var translateBulkLangsAt int64

// translateBulkLangReady :5000 已装语言面探测（60s 缓存）。zh/en 双跳底座必须就位；
// ja/ko 还需自身在列。模型未落地语种返回 false——消费循环暂跳该语种（不拉行不烧重试），
// install-models.sh 装齐 + :5000 重启扩宽后 60s 内自动放开。
func translateBulkLangReady(target string) bool {
        translateBulkLangsMu.Lock()
        defer translateBulkLangsMu.Unlock()
        now := nowMillis()
        if now-translateBulkLangsAt > 60*1000 {
                langs := map[string]bool{}
                client := &http.Client{Timeout: 8 * time.Second}
                if resp, err := client.Get(translateLibreBaseURL + "/languages"); err == nil {
                        raw, rerr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
                        _ = resp.Body.Close()
                        if rerr == nil {
                                var arr []struct {
                                        Code string `json:"code"`
                                }
                                if json.Unmarshal(raw, &arr) == nil {
                                        for _, l := range arr {
                                                // 语言码归一化（R183 实证坑：argos en_zh 模型注册为 zh-Hans，
                                                // LibreTranslate /languages 返回 zh-Hans 而非 zh——前缀归一）
                                                code := l.Code
                                                if strings.HasPrefix(code, "zh") {
                                                        code = "zh"
                                                }
                                                langs[code] = true
                                        }
                                }
                        }
                }
                translateBulkLangs = langs
                translateBulkLangsAt = now
        }
        // en = zh→en 单跳；ja/ko = zh→en→target 双跳——底座 zh+en 恒必需
        if !translateBulkLangs["zh"] || !translateBulkLangs["en"] {
                return false
        }
        if target != "en" && !translateBulkLangs[target] {
                return false
        }
        return true
}

// translateBulkOnce libre 消费一轮：就绪语种拉 pending 批（LIMIT 2 防长占 :5000），
// 逐章复用 translateWarmChapter（语种无关状态机）。
func translateBulkOnce() {
        // R190 渲染优先级反转：补译 flight 在飞时本轮暂停（整章长调用会让 :5000 队列
        // 吞没补译片，渲染等满预算却拿不到译文）
        if syncFillActive.Load() > 0 {
                return
        }
        ready := []string{}
        for _, t := range translateBulkTargets() {
                if translateBulkLangReady(t) {
                        ready = append(ready, t)
                }
        }
        if len(ready) == 0 {
                return
        }
        ph := strings.TrimSuffix(strings.Repeat("?,", len(ready)), ",")
        args := []any{nowMillis()}
        for _, t := range ready {
                args = append(args, t)
        }
        type qRow struct {
                id, novelID, chID int64
                target            string
        }
        rows := []qRow{}
        err := queryList(
                `SELECT "id","novelId","chapterId","target" FROM "TranslationQueue"
                 WHERE "state"='pending' AND "updatedAt" <= ? AND "target" IN (`+ph+`)
                 ORDER BY "id" ASC LIMIT 2`,
                func(rs *sql.Rows) error {
                        var r qRow
                        if err := rs.Scan(&r.id, &r.novelID, &r.chID, &r.target); err == nil {
                                rows = append(rows, r)
                        }
                        return nil
                }, args...)
        if err != nil || len(rows) == 0 {
                return
        }
        for _, r := range rows {
                translateWarmChapter(r.id, r.novelID, r.chID, r.target)
        }
}

// startTranslateBulkLoop 主循环（main.go 注册；TRANSLATEBULK_OFF=1 停用）：
// 启动即书信息预热 + 存量入队各一轮，随后 1s 消费轮询，6h/30min 周期重扫。
func startTranslateBulkLoop() {
        if os.Getenv("TRANSLATEBULK_OFF") == "1" {
                log.Println("[translate-bulk] TRANSLATEBULK_OFF=1，停用")
                return
        }
        targets := translateBulkTargets()
        if len(targets) == 0 {
                log.Println("[translate-bulk] 无 libre 语种（TRANSLATEBULK_TARGETS 配置为空/全被拒），停用")
                return
        }
        log.Printf("[translate-bulk] 启动 targets=%v（书信息 6h/轮 + 存量入队 30min/轮 + libre 消费 1s/轮）", targets)
        // 周期维护 goroutine（R183 实证修正：书信息全轮数小时，若与消费循环串行会饿死
        // libre 队列消化——拆独立 goroutine 并行，:5000 CPU 排队天然互让）
        go func() {
                var lastBooks, lastScan int64
                for {
                        now := nowMillis()
                        if now-lastBooks >= 6*3600*1000 {
                                if translateBulkBooksOnce() {
                                        lastBooks = nowMillis()
                                } else {
                                        // 失败（如 :3032 重启窗口）：2min 后重试，不干等下一周期
                                        lastBooks = nowMillis() - 6*3600*1000 + 2*60*1000
                                }
                        }
                        if now-lastScan >= 30*60*1000 {
                                translateBulkEnqueueScan()
                                lastScan = nowMillis()
                        }
                        time.Sleep(5 * time.Second)
                }
        }()
        // libre 消费循环：1s/轮（批 2 章）
        for {
                translateBulkOnce()
                time.Sleep(time.Second)
        }
}
