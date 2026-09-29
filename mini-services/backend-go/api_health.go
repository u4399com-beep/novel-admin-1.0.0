/**
 * backend-go —— 健康检查（骨架自检路由；业务 handlers 由 Task 18-a 在 api_*.go 中实现）。
 */
package main

import (
	"encoding/json"
	"io"
	"net/http"
	"time"
)

func init() {
	register("GET", "/api/health", handleHealth)
}

// handleHealth GET /api/health —— 进程/DB 存活探测。
// E22（61-R10）附加观测键（纯增量，旧消费方零破坏）：
//   - ruleHealth：E19 巡检汇总 {checked, healthy}（表未建/读败降级零值，不影响 ok/dbOk）
//   - engine：引擎吞吐快照 {ok, totalOK, totalFail}（2s 超时 fail-open，ok=false 不影响本端健康判定）
func handleHealth(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	_, dbErr := getDB()
	resp := map[string]any{
		"ok":      dbErr == nil,
		"service": "backend-go",
		"version": "1.0.0",
		"runtime": "go1.22",
		"db":      dbPath(),
		"dbOk":    dbErr == nil,
		"time":    time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
	}
	// E19 汇总：健康/已巡检规则数（engineHTTPClient 独立短超时见 fetchEngineStatsSnapshot）
	healthMap := ruleHealthByRule()
	checked, healthy := 0, 0
	for _, h := range healthMap {
		checked++
		if okv, _ := h["lastOK"].(bool); okv {
			healthy++
		}
	}
	resp["ruleHealth"] = map[string]any{"checked": checked, "healthy": healthy}
	resp["engine"] = fetchEngineStatsSnapshot()
	writeJSON(w, 200, resp)
}

// engineStatsClient 引擎吞吐探测专用短超时客户端（不能复用 60s 的 engineHTTPClient：
// /api/health 是高频探活面，引擎卡顿时健康端点不得被拖死——2s fail-open 只影响展示）
var engineStatsClient = &http.Client{Timeout: 2 * time.Second}

// fetchEngineStatsSnapshot 引擎 /api/stats 快照（fail-open：任何错误 → ok:false 空壳）
func fetchEngineStatsSnapshot() map[string]any {
	req, err := http.NewRequest("GET", engineBaseURL()+"/api/stats", nil)
	if err != nil {
		return map[string]any{"ok": false}
	}
	res, err := engineStatsClient.Do(req)
	if err != nil {
		return map[string]any{"ok": false}
	}
	defer func() { _ = res.Body.Close() }()
	// 引擎 /api/stats 契约无 ok 字段（statsSnapshot 直出计数 map）——HTTP 200 + 合法
	// JSON 解码成功即视为引擎可达；OK 字段解析恒 false 不可依赖（61-R10 自审修正）。
	// R24 审计修正：补 2xx 闸——注释口径历来是「HTTP 200」，旧实现漏检状态码，
	// 引擎侧非 2xx 且 body 恰为合法 JSON（如 404 {error,detail}）时解码零值误报
	// ok:true/totalOK:0（引擎统计不可达被伪造成「可达零吞吐」）
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return map[string]any{"ok": false}
	}
	var snap struct {
		TotalOK   int64 `json:"totalOK"`
		TotalFail int64 `json:"totalFail"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&snap); err != nil {
		return map[string]any{"ok": false}
	}
	return map[string]any{"ok": true, "totalOK": snap.TotalOK, "totalFail": snap.TotalFail}
}
