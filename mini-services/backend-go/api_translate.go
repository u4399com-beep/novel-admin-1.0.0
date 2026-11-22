/**
 * api_translate.go —— 翻译代理 API（R137，用户清单⑤翻译功能）。
 *
 * 定位：前台读者侧翻译入口。上游 = translate-service 侧车（:3032，与 stealth-service
 * 同层的独立进程）：zh-Hant = OpenCC 本地词典转换（秒级零成本）；en = LLM 文学翻译
 * （分段编号批翻，段失败留空由前端保留原文，绝不编造）。
 *
 * 缓存分层（LLM 翻译成本高，结果必须跨会话复用）：
 *   1. TranslationCache SQLite 持久层（本文件）——key = sha256(text)+"|"+target，
 *      命中零上游调用；随 db 快照进备份体系（恢复演练覆盖）。
 *   2. translate-service 进程内 LRU（热路径二跳）——侧车重启丢失无害。
 *
 * 安全边界（读者侧 POST 豁免 ADMIN_TOKEN 写保护的前提，见 adminauth.go）：
 *   - 请求体 ≤ 4MB / items ≤ 96 段 / 单段 ≤ 10000 字 / 总量 ≤ 120000 字（MaxBytesReader）
 *   - per-IP 滑窗限流 60 req/10min（进程内，公网部署防 LLM 成本滥用）
 *   - 上游仅 127.0.0.1 内网可达，不暴露公网
 *   - 只写 TranslationCache（无业务数据变更面）
 *
 * 惰性清理：回写时 2% 概率触发 90 天前条目删除（无独立 cron，零运维负担）。
 *
 * API：
 *   POST /api/translate        {"target":"zh-Hant"|"en","items":[...],"novelId":0,
 *                               "chapterId":0,"context":{"novelTitle":"","chapterTitle":""}}
 *                             → {"ok":true,"target":...,"results":[...],"cached":n,
 *                                "translated":n,"failedCount":n}
 *   GET  /api/translate/health → 上游 health 透传（llm/opencc 可用性运维排障）
 */
package main

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

// translateServiceBaseURL 上游基址（var：测试用 httptest fake 覆盖）
var translateServiceBaseURL = "http://127.0.0.1:3032"

// 请求规模上限（与上游约束对齐并前置拦截）
// items ≤ 300：长章正文 150+ 段是常态（R137 实测 109 段章节触发旧 96 上限 400）；
// 成本防护主闸是总字数（300×400 字≈120000 上限），段数本身不是成本放大器。
const (
	translateMaxItems      = 300
	translateMaxItemChars  = 10000
	translateMaxTotalChars = 120000
	translateMaxBodyBytes  = int64(4 << 20)
)

// 上游超时：上游 LLM 批超时 120s + 网络/排队余量
const translateUpstreamTimeout = 150 * time.Second

// per-IP 滑窗限流：60 req/10min/IP
const (
	translateRateLimit    = 60
	translateRateWindowMs = int64(10 * 60 * 1000)
	translateRateMaxIPs   = 20000 // map 上限：超限全清（防长驻进程内存爬升）
)

// translateTargets 支持的目标语种白名单（与上游注册表一致；上游为准，此处仅校验）
// R138 扩展：zh-HK（香港繁体 OpenCC）/ ja（日文 LLM，人名保留汉字）；R139：ko（韩文 LLM）
var translateTargets = map[string]bool{"zh-Hant": true, "zh-HK": true, "en": true, "ja": true, "ko": true}

// translateTargetsSupported 错误提示用的语种清单（与白名单同源单点）
func translateTargetsSupported() string {
	ps := make([]string, 0, len(translateTargets))
	for t := range translateTargets {
		ps = append(ps, t)
	}
	sort.Strings(ps)
	return strings.Join(ps, ", ")
}

// ---------- per-IP 滑窗限流 ----------

var translateRateState = struct {
	sync.Mutex
	hits map[string][]int64
}{hits: make(map[string][]int64)}

// translateClientIP 提取客户端 IP（网关转发链 X-Forwarded-For 首段优先）
func translateClientIP(r *http.Request) string {
	if xf := r.Header.Get("X-Forwarded-For"); xf != "" {
		return strings.TrimSpace(strings.Split(xf, ",")[0])
	}
	ip := r.RemoteAddr
	if i := strings.LastIndex(ip, ":"); i > 0 {
		ip = ip[:i]
	}
	return ip
}

// translateRateAllow 滑窗限流判定（60 req/10min/IP；map 超限惰性清理）
func translateRateAllow(ip string) bool {
	now := nowMillis()
	translateRateState.Lock()
	defer translateRateState.Unlock()
	fresh := translateRateState.hits[ip][:0]
	for _, t := range translateRateState.hits[ip] {
		if now-t < translateRateWindowMs {
			fresh = append(fresh, t)
		}
	}
	translateRateState.hits[ip] = fresh
	if len(fresh) >= translateRateLimit {
		return false
	}
	translateRateState.hits[ip] = append(fresh, now)
	if len(translateRateState.hits) > translateRateMaxIPs {
		for k, v := range translateRateState.hits {
			if len(v) == 0 || now-v[len(v)-1] >= translateRateWindowMs {
				delete(translateRateState.hits, k)
			}
		}
	}
	return true
}

// ---------- 缓存 ----------

// translateCacheKey sha256(text)+"|"+target（sha256 全域碰撞免疫；文本全文寻址）
func translateCacheKey(text, target string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:]) + "|" + target
}

// translateCacheKeyLibre libre 垘底缓存键（R168）：前缀隔离防固化——
// LibreTranslate 垘底译文与 LLM 文学译文同 key 会让半吊子译文永久挡住升级
// （缓存命中短路）；双层键让 LLM 落库普通键后读端自动切换优质译文（渐进升级）。
func translateCacheKeyLibre(text, target string) string {
	return "libre|" + translateCacheKey(text, target)
}

// translateCacheGet 批量查缓存（IN 分批 90 段，SQLite 参数上限 999 内安全）
func translateCacheGet(keys []string) map[string]string {
	out := make(map[string]string, len(keys))
	const batch = 90
	for start := 0; start < len(keys); start += batch {
		end := start + batch
		if end > len(keys) {
			end = len(keys)
		}
		ph := strings.TrimRight(strings.Repeat("?,", end-start), ",")
		args := make([]any, end-start)
		for i, k := range keys[start:end] {
			args[i] = k
		}
		var key, content string
		_ = queryList(`SELECT "key","content" FROM "TranslationCache" WHERE "key" IN (`+ph+`)`,
			func(rows *sql.Rows) error {
				if err := rows.Scan(&key, &content); err != nil {
					return err
				}
				out[key] = content
				return nil
			}, args...)
	}
	return out
}

// translateCachePut 回写缓存（execRetry 逐条；中途失败仅损失缓存下次重翻，无害）
func translateCachePut(items []string, keys []string, results []string, missIdx []int, novelID int64) {
	for _, i := range missIdx {
		if results[i] == "" || i >= len(items) {
			continue
		}
		_, _ = execRetry(
			`INSERT OR REPLACE INTO "TranslationCache" ("key","target","content","novelId","createdAt") VALUES (?,?,?,?,?)`,
			keys[i], strings.SplitN(keys[i], "|", 2)[1], results[i], novelID, nowMillis(),
		)
	}
	// 惰性清理：2% 概率触发 90 天前条目删除
	if nowMillis()%50 == 0 {
		_, _ = execRetry(`DELETE FROM "TranslationCache" WHERE "createdAt" < ?`, nowMillis()-90*24*3600*1000)
	}
}

// ---------- 上游调用 ----------

var translateUpstreamClient = &http.Client{Timeout: translateUpstreamTimeout}

// translateUpstream 转发上游 /api/translate，返回 results 数组（失败段为空串）
func translateUpstream(target string, texts []string, ctx map[string]string) ([]string, error) {
	return translateUpstreamEngine(target, texts, ctx, "", 0)
}

// translateUpstreamEngine R168：engine 透传（libre=预热器 429 熔断期垗底模式；
// llm=显式 LLM 专属（R169 预热器主尝试，杜绝服务端 auto 混流）；空=auto 旧行为）。
// deadlineMs>0 时透传 LLM 死线钳制（R169：预热器 60000ms——LLM 让位+响应返回全链
// 压进 120s 客户端窗口）。backend 不感知引擎实现细节，仅转发选择。
func translateUpstreamEngine(target string, texts []string, ctx map[string]string, engine string, deadlineMs int64) ([]string, error) {
	body := map[string]any{"target": target, "items": texts}
	if ctx["novelTitle"] != "" || ctx["chapterTitle"] != "" {
		body["context"] = ctx
	}
	if engine != "" {
		body["engine"] = engine
	}
	if deadlineMs > 0 {
		body["deadlineMs"] = deadlineMs
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequest(http.MethodPost, translateServiceBaseURL+"/api/translate", bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := translateUpstreamClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err = io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return nil, err
	}
	var up struct {
		OK      bool     `json:"ok"`
		Results []string `json:"results"`
		Error   string   `json:"error"`
	}
	if err := json.Unmarshal(raw, &up); err != nil {
		return nil, err
	}
	if !up.OK {
		return nil, &translateUpstreamError{msg: up.Error}
	}
	return up.Results, nil
}

// translateUpstreamError 上游业务错误（非网络层）
type translateUpstreamError struct{ msg string }

func (e *translateUpstreamError) Error() string { return e.msg }

// ---------- Handlers ----------

func handleTranslatePost(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	// 限流（读者侧防滥用第一闸）
	ip := translateClientIP(r)
	if !translateRateAllow(ip) {
		writeJSON(w, 429, map[string]string{"error": "请求过于频繁", "detail": "翻译请求已达限流上限（60 次/10 分钟），请稍后再试"})
		return
	}

	var body struct {
		Target    string   `json:"target"`
		Items     []string `json:"items"`
		NovelId   int64    `json:"novelId"`
		ChapterId int64    `json:"chapterId"`
		Context   struct {
			NovelTitle   string `json:"novelTitle"`
			ChapterTitle string `json:"chapterTitle"`
		} `json:"context"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, translateMaxBodyBytes))
	if err := dec.Decode(&body); err != nil {
		failJSON(w, "请求体无效", err.Error(), 400)
		return
	}
	if !translateTargets[body.Target] {
		failJSON(w, "不支持的目标语种", "supported: "+translateTargetsSupported(), 400)
		return
	}
	if len(body.Items) == 0 || len(body.Items) > translateMaxItems {
		failJSON(w, "items 数量非法", "1-300 段", 400)
		return
	}
	total := 0
	texts := make([]string, len(body.Items))
	for i, t := range body.Items {
		// 显式拒绝而非 strField 截断：静默截断会产生残缺译文（读者无从察觉），翻译场景不可接受
		if len([]rune(t)) > translateMaxItemChars {
			failJSON(w, "单段超长", "第 "+itoa(i+1)+" 段超过 10000 字上限（请分段请求）", 400)
			return
		}
		texts[i] = t
		total += len([]rune(t))
	}
	if total > translateMaxTotalChars {
		failJSON(w, "总量超限", "单次 ≤ 120000 字（请分批请求）", 400)
		return
	}

	// R139：novelId 归属修复——reader JS 契约只发 chapterId（translator.js），旧逻辑
	// 落库 body.NovelId 恒 0 → 「按书清理/导出译文」管线前提不成立（428 行实测全部
	// novelId=0）。单点反查：Chapter 表 id→novelId 一次查询，所有客户端受益；
	// 查不到（占位章/已删章）保持 0（未归属桶，管理页可见可清）。
	novelID := body.NovelId
	if novelID == 0 && body.ChapterId > 0 {
		var nid int64
		if err := queryOne(`SELECT "novelId" FROM "Chapter" WHERE "id" = ?`, []any{&nid}, body.ChapterId); err == nil && nid > 0 {
			novelID = nid
		}
	}

	// 1) 缓存命中分流（短段直通：与上游口径一致，trim <2 字无翻译价值）
	keys := make([]string, len(texts))
	results := make([]string, len(texts))
	missIdx := make([]int, 0, len(texts))
	var needLookup []string
	for i, t := range texts {
		keys[i] = translateCacheKey(t, body.Target)
		if strings.TrimSpace(t) == "" || len([]rune(strings.TrimSpace(t))) < 2 {
			results[i] = t
			continue
		}
		needLookup = append(needLookup, keys[i])
	}
	hits := translateCacheGet(needLookup)
	cached := 0
	libreHits := 0
	for i := range texts {
		if results[i] != "" {
			continue
		}
		if c, ok := hits[keys[i]]; ok {
			results[i] = c
			cached++
		} else {
			missIdx = append(missIdx, i)
		}
	}
	// R168：libre 垫底层二级查询——普通键 miss 后查 libre 键，命中即垫底返回
	//（有译文胜过等待 LLM 30-90s/空白）；不回写普通键（LLM 预热落库后自然升级，
	// 下次访问即读优质译文）。垫底段不计入转发上游的 missIdx。
	if len(missIdx) > 0 {
		libreKeys := make([]string, 0, len(missIdx))
		for _, i := range missIdx {
			libreKeys = append(libreKeys, translateCacheKeyLibre(texts[i], body.Target))
		}
		libreMap := translateCacheGet(libreKeys)
		stillMiss := make([]int, 0, len(missIdx))
		for _, i := range missIdx {
			if c, ok := libreMap[translateCacheKeyLibre(texts[i], body.Target)]; ok && c != "" {
				results[i] = c
				libreHits++
			} else {
				stillMiss = append(stillMiss, i)
			}
		}
		missIdx = stillMiss
	}
	if len(missIdx) == 0 {
		writeJSON(w, 200, map[string]any{"ok": true, "target": body.Target, "results": results,
			"cached": cached, "translated": 0, "failedCount": 0, "libreFallback": libreHits})
		return
	}

	// 2) 未命中段转发上游（仅未命中文本，省流量省成本）
	missTexts := make([]string, len(missIdx))
	for k, i := range missIdx {
		missTexts[k] = texts[i]
	}
	ctx := map[string]string{"novelTitle": body.Context.NovelTitle, "chapterTitle": body.Context.ChapterTitle}
	upResults, err := translateUpstream(body.Target, missTexts, ctx)
	if err != nil {
		log.Printf("[translate] upstream FAIL target=%s n=%d: %v", body.Target, len(missTexts), err)
		failJSON(w, "翻译服务暂不可用", err.Error(), 503)
		return
	}
	failed := 0
	for k, i := range missIdx {
		if k < len(upResults) && upResults[k] != "" {
			results[i] = upResults[k]
		} else {
			results[i] = "" // 上游段失败：留空，前端保留原文（不编造）
			failed++
		}
	}

	// 3) 回写持久缓存（novelId 已反查归属）
	translateCachePut(texts, keys, results, missIdx, novelID)

	writeJSON(w, 200, map[string]any{"ok": true, "target": body.Target, "results": results,
		"cached": cached, "translated": len(missIdx), "failedCount": failed, "libreFallback": libreHits})
}

func handleTranslateHealth(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(translateServiceBaseURL + "/api/health")
	if err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "upstream": false, "error": err.Error()})
		return
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "upstream": false, "error": err.Error()})
		return
	}
	var up map[string]any
	if err := json.Unmarshal(raw, &up); err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "upstream": false, "error": err.Error()})
		return
	}
	up["upstream"] = true
	writeJSON(w, 200, up)
}

func init() {
	register("POST", "/api/translate", handleTranslatePost)
	register("GET", "/api/translate/health", handleTranslateHealth)
	register("GET", "/api/translate/prefetch/status", handleTranslatePrefetchStatus) // R167: 预热工作器观测面
}
