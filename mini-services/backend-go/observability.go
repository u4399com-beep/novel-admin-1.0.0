/**
 * observability.go —— R135 可观测三件套（运营就绪评估 P1 整改，见 docs/operations-readiness.md §F/§P1）：
 *
 * 1. 告警 webhook（fireAlert）：三类核心事件推送——
 *      service_restart 服务重启（main.go boot 完成后触发一次）
 *      rule_unhealthy  规则巡检健康→不健康跃迁（rulehealth.go 巡检轮结束汇总）
 *      tasks_paused    任务批量暂停（≥阈值条停摆 ≥5min 未恢复，60s 检测）
 *      probe_down      页面拨测连续失败（probeAlertAfterFails 次）
 *    配置：SiteSetting.alertWebhookURL（http/https，POST JSON）。空=全链静默零成本。
 *    韧性：异步 goroutine 发送（5s 超时）不阻塞调用方；成功送达才记冷却，失败下轮重试；
 *    同 kind 10min 冷却去抖（事件风暴保护，force 通道供手动测试绕过）。
 *    payload：{service, kind, summary, detail, host, ts}——钉钉/飞书/企微自定义机器人
 *    或任意自建接收端均可消费（通用 JSON，不做单一平台格式适配）。
 *
 * 2. stats 快照落表（StatsSnapshot）：10min 一行核心计数（书/章/正文/任务态/规则健康/
 *    引擎吞吐），30 天保留；GET /api/stats-history 出正序时间线（画图友好）。
 *    评估报告 F 维度缺口「统计只存在内存，重启即失忆，无历史趋势可回放」的根修。
 *
 * 3. 页面拨测（ProbeLog）：5min 一轮对页面级端点发真实 HTTP 探测——
 *      内建：/（首页 SSR）、/api/health、/book/{maxID}（动态取最新书）
 *      自定义：SiteSetting.probeTargets 逗号分隔追加（公网部署时填自己的域名，
 *      获得「外部视角」拨测面；仅接受 http/https 绝对地址）
 *    每目标落一行（ok/httpStatus/latencyMs/error），7 天保留；同目标连败
 *    probeAlertAfterFails 次 → probe_down 告警（恢复自动清零）。
 *    GET /api/probe-log 查询；POST /api/alert/test 手动验证 webhook 通路。
 *
 * 调度：startObservabilityLoop 单 goroutine 60s tick 分频（probe 5min/stats 10min/
 * paused 检测 60s），单轮 panic 不致命；OBS_OFF=1 整链停用。
 * boot 门闩：全部 DB 读取走 loadSettingColumn/queryOne（dbReady 门闩内建，boot 中零窗口）。
 */
package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ==================== 配置读取（SiteSetting 两列，10s TTL 缓存） ====================

var (
	alertWebhookCache scraperSettingsCache
	probeTargetsCache scraperSettingsCache
)

// alertWebhookURL 告警 webhook 地址（空=未配置，全链静默）。
func alertWebhookURL() string {
	return alertWebhookCache.get(func() string { return loadSettingColumn("alertWebhookURL") })
}

// probeTargetsSetting 自定义拨测目标串（逗号分隔；空=仅内建三目标）。
func probeTargetsSetting() string {
	return probeTargetsCache.get(func() string { return loadSettingColumn("probeTargets") })
}

// ==================== 告警 webhook ====================

// alertCooldown 同 kind 事件冷却窗（风暴保护：规则批量退化/引擎抖动会瞬时产生大量事件）
const alertCooldown = 10 * time.Minute

var (
	alertMu       sync.Mutex
	alertLastSent = map[string]time.Time{}
)

// fireAlert 异步推送告警（去抖；webhook 未配置时零成本直返）。
func fireAlert(kind, summary, detail string) { fireAlertInternal(kind, summary, detail, false) }

// fireAlertForce 手动测试通道（绕过冷却，验证 webhook 通路可达性）。
func fireAlertForce(kind, summary, detail string) { fireAlertInternal(kind, summary, detail, true) }

func fireAlertInternal(kind, summary, detail string, force bool) {
	url := strings.TrimSpace(alertWebhookURL())
	if url == "" {
		return
	}
	if !force {
		alertMu.Lock()
		if t, ok := alertLastSent[kind]; ok && time.Since(t) < alertCooldown {
			alertMu.Unlock()
			return
		}
		alertMu.Unlock()
	}
	go func() {
		payload, _ := json.Marshal(map[string]any{
			"service": "backend-go",
			"kind":    kind,
			"summary": summary,
			"detail":  truncateRunes(detail, 2000),
			"host":    hostnameSafe(),
			"ts":      time.Now().Format("2006-01-02T15:04:05Z07:00"),
		})
		req, err := http.NewRequest("POST", url, bytes.NewReader(payload))
		if err != nil {
			log.Printf("[alert] %s 构造请求失败: %v", kind, err)
			return
		}
		req.Header.Set("Content-Type", "application/json")
		client := &http.Client{Timeout: 5 * time.Second}
		res, err := client.Do(req)
		if err != nil {
			log.Printf("[alert] %s webhook 发送失败（冷却不记录，下轮重试）: %v", kind, err)
			return
		}
		defer func() { _ = res.Body.Close() }()
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 4<<10))
		if res.StatusCode < 200 || res.StatusCode >= 300 {
			log.Printf("[alert] %s webhook 非 2xx: %d（下轮重试）", kind, res.StatusCode)
			return
		}
		// 成功送达才记冷却：失败事件不吞，下一检测周期重试
		alertMu.Lock()
		alertLastSent[kind] = time.Now()
		alertMu.Unlock()
		log.Printf("[alert] %s 已推送（%s）", kind, summary)
	}()
}

func hostnameSafe() string {
	h, err := os.Hostname()
	if err != nil {
		return ""
	}
	return h
}

// ==================== stats 快照落表 ====================

// statsSnapshotOnce 采样一行核心计数并落表（含 30 天保留清理）。
// 单条 COUNT 走全表扫描在百万章级 <100ms，10min 周期下成本可忽略。
func statsSnapshotOnce() {
	now := nowMillis()
	var novels, chapters, contents, running, paused, rulesTotal, rulesHealthy int64
	// 各计数独立容错：单表异常（如表未建）不影响其余字段采样
	_ = queryOne(`SELECT COUNT(*) FROM "Novel"`, []any{&novels})
	_ = queryOne(`SELECT COUNT(*) FROM "Chapter"`, []any{&chapters})
	_ = queryOne(`SELECT COUNT(*) FROM "ChapterContent"`, []any{&contents})
	_ = queryOne(`SELECT COUNT(*) FROM "ScrapeTask" WHERE "status" = 'running'`, []any{&running})
	_ = queryOne(`SELECT COUNT(*) FROM "ScrapeTask" WHERE "status" = 'paused'`, []any{&paused})
	_ = queryOne(`SELECT COUNT(*) FROM "ScrapeRule" WHERE "enabled" = 1`, []any{&rulesTotal})
	_ = queryOne(`SELECT COUNT(*) FROM "RuleHealth" WHERE "lastOK" = 1`, []any{&rulesHealthy})
	eng := fetchEngineStatsSnapshot()
	engOK, _ := eng["ok"].(bool)
	engTotalOK, _ := eng["totalOK"].(int64)
	engTotalFail, _ := eng["totalFail"].(int64)
	if _, err := exec(`INSERT INTO "StatsSnapshot"
                ("takenAt","novels","chapters","contents","tasksRunning","tasksPaused","rulesTotal","rulesHealthy","engineOK","engineTotalOK","engineTotalFail")
                VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
		now, novels, chapters, contents, running, paused, rulesTotal, rulesHealthy, engOK, engTotalOK, engTotalFail); err != nil {
		log.Printf("[obs] stats 快照落表失败: %v", err)
		return
	}
	// 保留 30 天（10min 周期 ≈ 4320 行）
	_, _ = exec(`DELETE FROM "StatsSnapshot" WHERE "takenAt" < ?`, now-int64(30*24*time.Hour)/int64(time.Millisecond))
}

// limitParam limit 查询参数解析（默认 def、上限 max；非数字/越界回默认，最小 1）。
func limitParam(r *http.Request, def, max int) int {
	raw := strings.TrimSpace(r.URL.Query().Get("limit"))
	if raw == "" {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 {
		return def
	}
	if n > max {
		return max
	}
	return n
}

// handleStatsHistory GET /api/stats-history?limit=144 —— 快照时间线（正序，画图友好）。
// limit 默认 144（24h @10min）、上限 1440（30 天全量）。
func handleStatsHistory(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	limit := limitParam(r, 144, 1440)
	rows := []map[string]any{}
	err := queryList(`SELECT "id","takenAt","novels","chapters","contents","tasksRunning","tasksPaused",
                "rulesTotal","rulesHealthy","engineOK","engineTotalOK","engineTotalFail"
                FROM "StatsSnapshot" ORDER BY "takenAt" DESC, "id" DESC LIMIT ?`, func(rs *sql.Rows) error {
		var id, takenAt, novels, chapters, contents, running, paused, rulesTotal, rulesHealthy, engTotalOK, engTotalFail int64
		var engOK bool
		if err := rs.Scan(&id, &takenAt, &novels, &chapters, &contents, &running, &paused, &rulesTotal, &rulesHealthy, &engOK, &engTotalOK, &engTotalFail); err != nil {
			return err
		}
		rows = append(rows, map[string]any{
			"id": id, "takenAt": takenAt, "novels": novels, "chapters": chapters, "contents": contents,
			"tasksRunning": running, "tasksPaused": paused, "rulesTotal": rulesTotal, "rulesHealthy": rulesHealthy,
			"engineOK": engOK, "engineTotalOK": engTotalOK, "engineTotalFail": engTotalFail,
		})
		return nil
	}, limit)
	if err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	// DESC 取最近 N 条 → 反转为正序时间线
	for i, j := 0, len(rows)-1; i < j; i, j = i+1, j-1 {
		rows[i], rows[j] = rows[j], rows[i]
	}
	writeJSON(w, 200, map[string]any{"ok": true, "total": len(rows), "items": rows})
}

// ==================== 页面拨测 ====================

const (
	probeTimeout         = 10 * time.Second
	probeAlertAfterFails = 3                                               // 同目标连续失败 N 次 → probe_down 告警
	probeRetentionMs     = int64(7*24*time.Hour) / int64(time.Millisecond) // 7 天保留
)

type probeTarget struct {
	name string
	url  string
}

// probeTargetsList 内建三目标 + 自定义 probeTargets。
func probeTargetsList() []probeTarget {
	base := "http://127.0.0.1:" + strconv.Itoa(parsePort())
	targets := []probeTarget{
		{name: "home", url: base + "/"},
		{name: "health", url: base + "/api/health"},
	}
	var maxID int64
	if err := queryOne(`SELECT COALESCE(MAX("id"),0) FROM "Novel"`, []any{&maxID}); err == nil && maxID > 0 {
		targets = append(targets, probeTarget{name: "book", url: fmt.Sprintf("%s/book/%d", base, maxID)})
	}
	for i, raw := range splitNonEmpty(probeTargetsSetting(), ",") {
		u := strings.TrimSpace(raw)
		if strings.HasPrefix(u, "http://") || strings.HasPrefix(u, "https://") {
			targets = append(targets, probeTarget{name: fmt.Sprintf("custom%d", i+1), url: u})
		}
	}
	return targets
}

var (
	probeFailMu     sync.Mutex
	probeFailStreak = map[string]int{}
)

// probeRunOnce 一轮拨测：逐目标真实 HTTP GET，落 ProbeLog + 连败告警 + 7 天保留。
func probeRunOnce() {
	client := &http.Client{Timeout: probeTimeout}
	now := nowMillis()
	for _, tg := range probeTargetsList() {
		ok, status, latency, errMsg := probeOneURL(client, tg.url)
		if _, err := exec(`INSERT INTO "ProbeLog" ("takenAt","target","ok","httpStatus","latencyMs","error")
                        VALUES (?,?,?,?,?,?)`, now, tg.url, ok, status, latency, truncateRunes(errMsg, 300)); err != nil {
			log.Printf("[obs] 拨测结果落库失败（%s）: %v", tg.url, err)
		}
		probeFailMu.Lock()
		if ok {
			delete(probeFailStreak, tg.url)
		} else {
			probeFailStreak[tg.url]++
		}
		streak := probeFailStreak[tg.url]
		probeFailMu.Unlock()
		if !ok && streak == probeAlertAfterFails {
			// 恰达阈值时告警一次；之后每轮仍失败由 fireAlert 10min 冷却去抖
			go fireAlert("probe_down", fmt.Sprintf("页面拨测连续 %d 次失败: %s", streak, tg.url), errMsg)
		}
	}
	_, _ = exec(`DELETE FROM "ProbeLog" WHERE "takenAt" < ?`, nowMillis()-probeRetentionMs)
}

// probeOneURL 单目标探测：2xx=ok；其余状态/超时/错误=失败（与 fetchEngineStatsSnapshot 2xx 闸同口径）。
func probeOneURL(client *http.Client, url string) (ok bool, status int, latencyMs int64, errMsg string) {
	start := time.Now()
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return false, 0, 0, "构造请求失败: " + err.Error()
	}
	req.Header.Set("User-Agent", "novel-admin-probe/1.0")
	res, err := client.Do(req)
	latency := time.Since(start).Milliseconds()
	if err != nil {
		return false, 0, latency, err.Error()
	}
	defer func() { _ = res.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 4<<10))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return false, res.StatusCode, latency, fmt.Sprintf("HTTP %d", res.StatusCode)
	}
	return true, res.StatusCode, latency, ""
}

// handleProbeLog GET /api/probe-log?limit=100 —— 最近拨测记录（逆序）。
func handleProbeLog(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	limit := limitParam(r, 100, 1000)
	rows := []map[string]any{}
	err := queryList(`SELECT "id","takenAt","target","ok","httpStatus","latencyMs","error"
                FROM "ProbeLog" ORDER BY "takenAt" DESC, "id" DESC LIMIT ?`, func(rs *sql.Rows) error {
		var id, takenAt, status, latency int64
		var ok bool
		var target, errMsg string
		if err := rs.Scan(&id, &takenAt, &target, &ok, &status, &latency, &errMsg); err != nil {
			return err
		}
		rows = append(rows, map[string]any{
			"id": id, "takenAt": takenAt, "target": target, "ok": ok,
			"httpStatus": status, "latencyMs": latency, "error": errMsg,
		})
		return nil
	}, limit)
	if err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "total": len(rows), "items": rows})
}

// ==================== 任务批量暂停检测 ====================

// 批量 paused 判定：≥阈值条任务 status=paused 且停摆 ≥5min（静默窗，排除 autoResume
// 60s 复活的瞬态——R134 实证热替换重启 19 paused→100s 内 16 复活，瞬态不告警）
// 且 ≤30min（更老的是历史遗留，非新发生事件）。
const (
	pausedWindowMs    = int64(5*time.Minute) / int64(time.Millisecond)  // 300_000ms
	pausedMaxAgeMs    = int64(30*time.Minute) / int64(time.Millisecond) // 1_800_000ms
	pausedBatchThresh = 5
)

// checkPausedBatch 批量暂停检测（60s 一轮；命中经 tasks_paused 10min 冷却去抖）。
func checkPausedBatch() {
	now := nowMillis()
	var n int64
	if err := queryOne(`SELECT COUNT(*) FROM "ScrapeTask"
                WHERE "status" = 'paused' AND "updatedAt" <= ? AND "updatedAt" > ?`,
		[]any{&n}, now-pausedWindowMs, now-pausedMaxAgeMs); err != nil {
		return
	}
	if n >= pausedBatchThresh {
		go fireAlert("tasks_paused", fmt.Sprintf("%d 个任务疑似批量暂停（停摆 ≥5min 未恢复）", n), "")
	}
}

// ==================== 手动测试通道 ====================

// handleAlertTest POST /api/alert/test —— 手动验证 webhook 通路（绕过冷却）。
// body: { "summary"?: string, "detail"?: string }
func handleAlertTest(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	url := strings.TrimSpace(alertWebhookURL())
	if url == "" {
		writeJSON(w, 400, map[string]string{"error": "alertWebhookURL 未配置（PATCH /api/settings 设置后重试）"})
		return
	}
	summary, detail := "测试告警", "来自 /api/alert/test 的手动验证"
	if v, ok := readBodyValue(r); ok {
		body := bodyMap(v)
		if s := strings.TrimSpace(bodyString(body["summary"])); s != "" {
			summary = s
		}
		if s := strings.TrimSpace(bodyString(body["detail"])); s != "" {
			detail = s
		}
	}
	fireAlertForce("manual_test", summary, detail)
	writeJSON(w, 200, map[string]any{"ok": true, "message": "测试告警已异步发送（成功/失败见 backend 日志 [alert] 行）"})
}

// ==================== 调度循环 ====================

const (
	obsTickInterval = 60 * time.Second
	probeEveryTicks = 5  // 5min
	statsEveryTicks = 10 // 10min
)

// startObservabilityLoop 可观测循环入口（main.go 在 api/all 模式 go 起；OBS_OFF=1 停用）。
func startObservabilityLoop() {
	if envOff("OBS_OFF") {
		log.Println("[observability] OBS_OFF=1，可观测循环停用")
		return
	}
	log.Printf("[observability] 可观测循环启动（拨测 %dm/stats 快照 %dm/批量paused检测 %v）",
		probeEveryTicks, statsEveryTicks, obsTickInterval)
	time.Sleep(20 * time.Second) // 避开 boot 风暴与重启告警时窗
	func() {
		defer func() { _ = recover() }()
		probeRunOnce()      // 首轮立即：重启后尽快有拨测数据
		statsSnapshotOnce() // 首轮立即
	}()
	tick := 0
	t := time.NewTicker(obsTickInterval)
	defer t.Stop()
	for range t.C {
		func() {
			defer func() { _ = recover() }() // 单轮异常不致命（对齐 rulehealth 防御口径）
			tick++
			checkPausedBatch()
			if tick%probeEveryTicks == 0 {
				probeRunOnce()
			}
			if tick%statsEveryTicks == 0 {
				statsSnapshotOnce()
			}
		}()
	}
}

// ==================== 路由注册 ====================

func init() {
	register("GET", "/api/stats-history", handleStatsHistory)
	register("GET", "/api/probe-log", handleProbeLog)
	register("POST", "/api/alert/test", handleAlertTest)
}
