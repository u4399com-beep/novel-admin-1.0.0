/**
 * worker_autorecovery_test.go —— Task 46-b 自动恢复链路专项审计的回归锁定：
 *
 * 1) TestAutoResumeMatcherCoversFinalizeMessages：五处限流类 paused 终态文案必须被
 *    runner.go autoResumePausedTasks 的词表匹配（SQL LIKE '%限流%软拦截%'）命中——
 *    文案与词表是隐式契约，任一方单方面改动都会让「自动恢复重新入队」静默失效
 *    （Task 46-b 文案校准后的防回归锁）。同时校验非限流类 paused 文案不入表（纯手动）。
 *
 * 2) TestSoftBlockEmptyErrTextHitsTransientClassifier：softBlockEmptyErrText（引擎
 *    200 空壳档案的统一失败文案）必须命中 isTransientScrapeErr——这是「空壳不再被
 *    误判 failed 终态」的关键链路（Task 46-b：引擎 ok=true + softBlock 时旧版返回
 *    空错误串/规则失效文案，列表/书页阶段直接 failed，自动恢复永不接手）。
 *
 * 复用 recover_test.go 的 TestMain 临时库（绝不触碰生产 db/custom.db）。
 */
package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// likeAutoResume 按 autoResumePausedTasks 同口径匹配：'限流' 与 '软拦截' 依序出现。
// 与 SQL LIKE 的通配语义等价（无 % _ 字面量，无需转义）。
func likeAutoResume(msg string) bool {
	i := strings.Index(msg, "限流")
	if i < 0 {
		return false
	}
	return strings.Contains(msg[i:], "软拦截")
}

func TestAutoResumeMatcherCoversFinalizeMessages(t *testing.T) {
	listMsg := "列表页抓取失败（源站限流/空壳软拦截或引擎主机熔断冷却中，按错误形态判为瞬态而非确认封禁）：任务已自动暂停，冷却后自动恢复重新入队（每任务至多 4 次，多次未果请人工检查源站；已采进度保留）"
	bookMsg := "书目抓取失败（源站限流/空壳软拦截或引擎主机熔断冷却中，按错误形态判为瞬态而非确认封禁）：任务已自动暂停，冷却后自动恢复重新入队（每任务至多 4 次，多次未果请人工检查源站；已采进度保留）"
	singleMsg := "书页抓取失败（源站限流/空壳软拦截或引擎主机熔断冷却中，按错误形态判为瞬态而非确认封禁）：任务已自动暂停，冷却后自动恢复重新入队（每任务至多 4 次，多次未果请人工检查源站；已采进度保留）"
	phase2Msg := "正文连续失败 60 章（源站限流/空壳软拦截：429/503 或 200 空壳，判为瞬态非确认封禁），已自动暂停防烧穿（成功 3 章，进度保留；自动恢复每任务至多 4 次，多次未果请人工检查源站；引擎 AIMD+车道降档已自动放缓节奏）"

	for _, c := range []struct {
		name string
		msg  string
	}{
		{"runList Phase0", listMsg},
		{"runList Phase1", bookMsg},
		{"runSingle Phase1", singleMsg},
		{"runList/runSingle Phase2", phase2Msg},
	} {
		if !likeAutoResume(c.msg) {
			t.Errorf("%s: 终态文案未被 autoResumePausedTasks 词表命中（'%%限流%%软拦截%%'），自动恢复链路断裂：%q", c.name, c.msg)
		}
	}

	// 非限流类 paused 文案必须不入表（维持「纯手动恢复」口径）
	for _, c := range []struct {
		name string
		msg  string
	}{
		{"手动暂停", "已手动暂停（进度保留，可恢复继续采集）"},
		{"服务重启", "服务重启，任务自动暂停（可恢复继续采集）"},
		{"孤儿回收", "孤儿运行态自动回收（已无执行中 worker），可恢复继续采集"},
		{"参数读取失败", "任务参数读取失败（存储瞬时异常或损坏行），任务已自动暂停，排查任务配置后可恢复继续采集"},
		{"疑似封禁熔断", "正文连续失败 60 章（疑似源站封禁或站点不可达），已自动暂停防烧穿（成功 3 章，进度保留，可恢复继续采集）"},
	} {
		if likeAutoResume(c.msg) {
			t.Errorf("%s: 非限流类文案不应进自动恢复词表：%q", c.name, c.msg)
		}
	}
}

func TestSoftBlockEmptyErrTextHitsTransientClassifier(t *testing.T) {
	if !isSoftBlockErrText(softBlockEmptyErrText) {
		t.Errorf("softBlockEmptyErrText 未命中 isSoftBlockErrText：%q", softBlockEmptyErrText)
	}
	if !isTransientScrapeErr(softBlockEmptyErrText) {
		t.Errorf("softBlockEmptyErrText 未命中 isTransientScrapeErr，200 空壳将退回 failed 终态：%q", softBlockEmptyErrText)
	}
	// 旧文案（修复前书页空壳形态）：不得命中瞬态——锁定「旧版为什么烧成 failed」的事实基线
	if isTransientScrapeErr("未提取到书籍标题（规则与内置回退均未命中）") {
		t.Error("旧「未提取到书籍标题」文案不应命中瞬态（如命中说明词表被误扩）")
	}
}

// TestSoftBlockShellNotMisjudgedFailed 端到端锁定（Task 46-b 修复 d）：
// 引擎返回 ok=true + softBlock 档案（200 空壳）时——
//
//	fetchListPage  返回软拦截错误文案（而非空串）→ runList 首页空壳走 paused 分支；
//	fetchBookPage  返回软拦截错误文案（而非「未提取到书籍标题」）→ Phase1 全败走 paused。
//
// stub 引擎经 BACKEND_ENGINE_URL 注入（engineBaseURL 每次调用现读，可注入）。
func TestSoftBlockShellNotMisjudgedFailed(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 引擎 handleTest 200 空壳形态：ok=true、list 空、附 softBlock 对象与空壳 warning
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"data":{"list":{"items":[]}},"warnings":["HTTP 200 但规则提取结果全空：疑似限流空壳/挑战竞态页"],"softBlock":{"status":200,"title":"欢迎光临","htmlLength":19000}}`))
	}))
	defer srv.Close()
	t.Setenv("BACKEND_ENGINE_URL", srv.URL)

	run := NewRun(990_100)
	items, errText := fetchListPage(run, "https://shell.example/list.html", LoadedRule{}, "")
	if len(items) != 0 {
		t.Fatalf("空壳列表页应返回 0 条，got %d", len(items))
	}
	if !isTransientScrapeErr(errText) {
		t.Fatalf("空壳列表页错误文案应命中瞬态判定（否则 failed 终态），got %q", errText)
	}

	book := fetchBookPage(run, "https://shell.example/book/1.html", LoadedRule{}, "", true)
	if book.OK {
		t.Fatal("空壳书页应失败（无书名）")
	}
	if !isTransientScrapeErr(book.Err) {
		t.Fatalf("空壳书页错误文案应命中瞬态判定（否则 Phase1 全败 failed 终态），got %q", book.Err)
	}

	// 对照组：无 softBlock 档案的普通空提取 → 维持原语义（非瞬态，规则失效类）
	srv2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"data":{"list":{"items":[]}},"warnings":[]}`))
	}))
	defer srv2.Close()
	t.Setenv("BACKEND_ENGINE_URL", srv2.URL)

	_, errText2 := fetchListPage(run, "https://plain.example/list.html", LoadedRule{}, "")
	// 无 softBlock 时保持旧契约：空错误串（选择器失效/真空页，不计瞬态）
	if errText2 != "" || isTransientScrapeErr(errText2) {
		t.Fatalf("无 softBlock 的空提取应保持空错误串且不命中瞬态（原「规则失效」语义），got %q", errText2)
	}
}
