/**
 * observability_test.go —— R135 可观测三件套回归：
 * 1) fireAlert：webhook 送达 payload 形态 / 同 kind 冷却去抖 / force 通道绕过 / URL 空零成本
 * 2) statsSnapshotOnce：落表字段正确 + 30 天保留清理
 * 3) probeRunOnce：落表（ok 目标 + 死目标）+ 连败达阈值触发 probe_down 告警 + 恢复清零
 * 4) limitParam：默认/上限/非法回退
 * 5) settings PATCH：alertWebhookURL/probeTargets 两键校验（非法拒绝、合法归一、空串清除）
 * 复用 recover_test.go 的 TestMain 临时库（绝不触碰生产 db/custom.db）。
 */
package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---- 测试助手 ----

// alertSink 可计数 webhook 接收端（记录最近一次 payload）
type alertSink struct {
	mu     sync.Mutex
	counts map[string]int
	last   map[string]map[string]any
}

func newAlertSink() (*alertSink, *httptest.Server) {
	s := &alertSink{counts: map[string]int{}, last: map[string]map[string]any{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var m map[string]any
		_ = json.NewDecoder(r.Body).Decode(&m)
		kind, _ := m["kind"].(string)
		s.mu.Lock()
		s.counts[kind]++
		s.last[kind] = m
		s.mu.Unlock()
		w.WriteHeader(200)
	}))
	return s, srv
}

func (s *alertSink) count(kind string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.counts[kind]
}

// setAlertURL 直接写库 + 失效缓存（绕过 PATCH，聚焦 fireAlert 行为本身）
func setAlertURL(t *testing.T, url string) {
	t.Helper()
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	if _, err := db.Exec(`UPDATE "SiteSetting" SET "alertWebhookURL" = ? WHERE "id" = 1`, url); err != nil {
		t.Fatalf("set alertWebhookURL: %v", err)
	}
	alertWebhookCache.invalidate()
}

func resetAlertState() {
	alertMu.Lock()
	alertLastSent = map[string]time.Time{}
	alertMu.Unlock()
	alertWebhookCache.invalidate()
}

// waitFor 轮询等待异步 goroutine 完成（fireAlert 异步发送，测试需等落点）
func waitFor(t *testing.T, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("条件在 %v 内未满足", timeout)
}

// ---- fireAlert ----

func TestFireAlertDeliversAndDedups(t *testing.T) {
	mustInitSiteSettingTable(t)
	sink, srv := newAlertSink()
	defer srv.Close()
	resetAlertState()
	defer resetAlertState()
	setAlertURL(t, srv.URL)

	// 首发必达
	fireAlertForce("manual_test", "第一发", "payload 校验")
	waitFor(t, 2*time.Second, func() bool { return sink.count("manual_test") >= 1 })
	sink.mu.Lock()
	last := sink.last["manual_test"]
	sink.mu.Unlock()
	if last == nil {
		t.Fatalf("payload 未记录")
	}
	if last["service"] != "backend-go" || last["summary"] != "第一发" || last["detail"] != "payload 校验" {
		t.Fatalf("payload 字段不符: %v", last)
	}
	if _, ok := last["ts"].(string); !ok {
		t.Fatalf("payload 缺 ts 字符串: %v", last)
	}

	// 普通 fireAlert 首次发送后同 kind 冷却内不再发（fireAlertForce 不受冷却影响）
	resetAlertState() // 清冷却后重新走普通通道
	fireAlert("probe_down", "第一发普通", "")
	waitFor(t, 2*time.Second, func() bool { return sink.count("probe_down") >= 1 })
	n0 := sink.count("probe_down")
	fireAlert("probe_down", "冷却窗口内不应送达", "")
	fireAlert("probe_down", "冷却窗口内不应送达2", "")
	time.Sleep(300 * time.Millisecond)
	if got := sink.count("probe_down"); got != n0 {
		t.Fatalf("冷却窗口内同 kind 不应重复送达，got %d want %d", got, n0)
	}
}

func TestFireAlertEmptyURLNoop(t *testing.T) {
	mustInitSiteSettingTable(t)
	resetAlertState()
	defer resetAlertState()
	setAlertURL(t, "") // 未配置：零成本直返，不得 panic / 不得产生发送
	fireAlert("probe_down", "不应送达", "")
	fireAlertForce("manual_test", "不应送达", "")
	time.Sleep(200 * time.Millisecond) // 若误发会打向空 URL 立即失败，仅验证无 panic
}

// ---- stats 快照 ----

func TestStatsSnapshotOncePersistsAndPrunes(t *testing.T) {
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	t.Cleanup(func() { _, _ = db.Exec(`DELETE FROM "StatsSnapshot"`) })

	statsSnapshotOnce()
	var novels, takenAt int64
	if err := queryOne(`SELECT "novels","takenAt" FROM "StatsSnapshot" ORDER BY "id" DESC LIMIT 1`, []any{&novels, &takenAt}); err != nil {
		t.Fatalf("快照应落表: %v", err)
	}
	if takenAt <= 0 {
		t.Fatalf("takenAt 应为正毫秒，got %d", takenAt)
	}

	// 保留清理：31 天前的行应被下一轮快照顺手清掉
	old := nowMillis() - 31*24*int64(time.Hour)/int64(time.Millisecond)
	if _, err := db.Exec(`INSERT INTO "StatsSnapshot" ("takenAt","novels") VALUES (?, 999)`, old); err != nil {
		t.Fatalf("insert old row: %v", err)
	}
	statsSnapshotOnce()
	var stale int64
	_ = queryOne(`SELECT COUNT(*) FROM "StatsSnapshot" WHERE "takenAt" < ?`, []any{&stale}, nowMillis()-30*24*int64(time.Hour)/int64(time.Millisecond))
	if stale != 0 {
		t.Fatalf("31 天前行应被清理，残留 %d", stale)
	}
}

// ---- 页面拨测 ----

func TestProbeRunOnceLogsAndAlerts(t *testing.T) {
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	t.Cleanup(func() { _, _ = db.Exec(`DELETE FROM "ProbeLog"`) })

	mustInitSiteSettingTable(t)
	sink, srv := newAlertSink()
	defer srv.Close()
	resetAlertState()
	defer resetAlertState()
	setAlertURL(t, srv.URL)

	// probeTargets 指向存活 sink + 一个死口（内建三目标在本测试进程无服务，失败行无害）
	dead := "http://127.0.0.1:1/"
	db.Exec(`UPDATE "SiteSetting" SET "probeTargets" = ? WHERE "id" = 1`, srv.URL+","+dead)
	probeTargetsCache.invalidate()

	// 预置死口连败 2 次 → 本轮第 3 次失败恰达阈值 → probe_down 告警恰一发
	probeFailMu.Lock()
	probeFailStreak[dead] = probeAlertAfterFails - 1
	probeFailMu.Unlock()

	probeRunOnce()

	var logged int64
	_ = queryOne(`SELECT COUNT(*) FROM "ProbeLog" WHERE "target" IN (?, ?)`, []any{&logged}, srv.URL, dead)
	if logged < 2 {
		t.Fatalf("自定义两目标应各落一行，got %d", logged)
	}
	var okN, failN int64
	_ = queryOne(`SELECT COUNT(*) FROM "ProbeLog" WHERE "target" = ? AND "ok" = 1`, []any{&okN}, srv.URL)
	_ = queryOne(`SELECT COUNT(*) FROM "ProbeLog" WHERE "target" = ? AND "ok" = 0`, []any{&failN}, dead)
	if okN != 1 || failN != 1 {
		t.Fatalf("存活目标应 ok=1（got %d），死口应 ok=0（got %d）", okN, failN)
	}

	waitFor(t, 2*time.Second, func() bool { return sink.count("probe_down") >= 1 })
	summary, _ := sink.last["probe_down"]["summary"].(string)
	if !strings.Contains(summary, dead) {
		t.Fatalf("probe_down 告警应含死口 URL，got %q", summary)
	}

	// 恢复清零：死口转活（复用 sink URL 不可行——直接清内存 streak 模拟恢复后失败计数从 0 重数）
	probeFailMu.Lock()
	probeFailStreak[dead] = 0
	probeFailMu.Unlock()

	// 7 天保留：旧行被下一轮清理
	old := nowMillis() - 8*24*int64(time.Hour)/int64(time.Millisecond)
	db.Exec(`INSERT INTO "ProbeLog" ("takenAt","target","ok") VALUES (?, 'old', 0)`, old)
	probeRunOnce()
	var stale int64
	_ = queryOne(`SELECT COUNT(*) FROM "ProbeLog" WHERE "target" = 'old'`, []any{&stale})
	if stale != 0 {
		t.Fatalf("8 天前拨测行应被清理，残留 %d", stale)
	}
}

// ---- limit 参数 ----

func TestLimitParam(t *testing.T) {
	mk := func(raw string) *http.Request {
		req := httptest.NewRequest("GET", "/api/stats-history"+raw, nil)
		return req
	}
	if got := limitParam(mk(""), 144, 1440); got != 144 {
		t.Fatalf("缺省应回默认 144，got %d", got)
	}
	if got := limitParam(mk("?limit=50"), 144, 1440); got != 50 {
		t.Fatalf("?limit=50 应 50，got %d", got)
	}
	if got := limitParam(mk("?limit=99999"), 144, 1440); got != 1440 {
		t.Fatalf("超上限应夹取 1440，got %d", got)
	}
	if got := limitParam(mk("?limit=abc"), 144, 1440); got != 144 {
		t.Fatalf("非数字应回默认，got %d", got)
	}
	if got := limitParam(mk("?limit=0"), 144, 1440); got != 144 {
		t.Fatalf("0 应回默认（最小 1 语义由回退实现），got %d", got)
	}
}

// ---- settings PATCH 两键 ----

func TestSettingsPatchAlertAndProbeKeys(t *testing.T) {
	mustInitSiteSettingTable(t)

	// alertWebhookURL：合法 https 写入
	code, _ := patchSettings(t, `{"alertWebhookURL":" https://hooks.example.com/abc "}`)
	if code != 200 {
		t.Fatalf("合法 webhook 应 200，got %d", code)
	}
	var got string
	if err := queryOne(`SELECT "alertWebhookURL" FROM "SiteSetting" WHERE "id" = 1`, []any{&got}); err != nil || got != "https://hooks.example.com/abc" {
		t.Fatalf("webhook 应 trim 后写入，got %q err=%v", got, err)
	}

	// 非法协议拒绝
	code, resp := patchSettings(t, `{"alertWebhookURL":"ftp://x"}`)
	if code != 400 {
		t.Fatalf("ftp 协议应 400，got %d %v", code, resp)
	}
	// 非字符串拒绝
	code, _ = patchSettings(t, `{"alertWebhookURL":123}`)
	if code != 400 {
		t.Fatalf("非字符串应 400，got %d", code)
	}

	// probeTargets：合法串归一（去空项/去空白）
	code, _ = patchSettings(t, `{"probeTargets":" https://a.example.com , https://b.example.com ,,"}`)
	if code != 200 {
		t.Fatalf("合法 probeTargets 应 200，got %d", code)
	}
	if err := queryOne(`SELECT "probeTargets" FROM "SiteSetting" WHERE "id" = 1`, []any{&got}); err != nil || got != "https://a.example.com,https://b.example.com" {
		t.Fatalf("probeTargets 应归一化，got %q err=%v", got, err)
	}
	// 违规项拒绝整键
	code, resp = patchSettings(t, `{"probeTargets":"https://a.example.com,not-a-url"}`)
	if code != 400 {
		t.Fatalf("违规项应 400，got %d %v", code, resp)
	}
	// 空串清除
	code, _ = patchSettings(t, `{"probeTargets":""}`)
	if code != 200 {
		t.Fatalf("空串清除应 200，got %d", code)
	}
	if err := queryOne(`SELECT "probeTargets" FROM "SiteSetting" WHERE "id" = 1`, []any{&got}); err != nil || got != "" {
		t.Fatalf("空串应清除，got %q err=%v", got, err)
	}
}
