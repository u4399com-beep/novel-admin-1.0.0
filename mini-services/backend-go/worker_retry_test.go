/**
 * worker_retry_test.go —— P3-1（R108 提速·失败章轮内回收重试轮，关关「回收重采」）回归锁定：
 *
 * 1) TestPhase2FillRetryPassRecovers：主循环部分失败（前 2 次引擎调用失败）→ 回收队列
 *    在冷却后重试并全部补采成功；out.RetriedFilled 记账正确；任务日志含 [retry-pass] 行。
 * 2) TestPhase2FillRetryPassDisabled：SCRAPE_RETRY_PASSES=0 → 无回收（引擎调用数=主循环数）。
 * 3) TestPhase2FillRetryPassBreakerSkips：主循环连败熔断 → 回收轮被跳过（不烧额外请求）。
 * 复用 recover_test.go 的 TestMain 临时库与 worker_bookparallel_test.go 的种书/种章 harness。
 */
package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// conditionalStubServer 前 failN 次调用返回整链失败，其后返回固定正文（计数跨主循环/回收轮共享）
func conditionalStubServer(t *testing.T, calls *atomic.Int64, failN int64) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		if n <= failN {
			_, _ = w.Write([]byte(`{"ok":false,"error":"stub 瞬态失败（模拟挑战窗口/空壳）","warnings":[]}`))
			return
		}
		_, _ = w.Write([]byte(`{"ok":true,"data":{"title":"第1章 桩","content":"这是桩正文内容，长度足够通过空壳判定。"},"warnings":[],"elapsedMs":5}`))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func retryFillMap(t *testing.T, taskID int64, novelID int, n int, titlePrefix string) map[int]fillPlan {
	t.Helper()
	seedNovelForFill(t, int(novelID))
	plan := fillPlan{Referer: "https://r.example/book/1"}
	for i := 1; i <= n; i++ {
		title := titlePrefix + itoa(i)
		plan.Rows = append(plan.Rows, refPair{Title: title, URL: "https://r.example/ch" + itoa(i) + ".html"})
		seedChapterSkeleton(t, int(taskID)*1000+i, int(novelID), i, title)
	}
	return map[int]fillPlan{int(novelID): plan}
}

func TestPhase2FillRetryPassRecovers(t *testing.T) {
	var calls atomic.Int64
	srv := conditionalStubServer(t, &calls, 2) // 前 2 次失败（主循环），其后成功（回收轮）
	t.Setenv("BACKEND_ENGINE_URL", srv.URL)
	seedRunningTaskForTest(t, 990_970, "https://r.example/book/1")

	orig := retryCooldownBase
	retryCooldownBase = 10 * time.Millisecond
	defer func() { retryCooldownBase = orig }()

	fillMap := retryFillMap(t, 990_970, 971, 3, "第1章 R")
	run := NewRun(990_970)
	out := phase2Fill(run, LoadedRule{}, fillMap, "db", func(int) bool { return true })

	if out.Filled != 3 {
		t.Fatalf("主循环 1 成 + 回收轮 2 成应共 3 章，got filled=%d retried=%d", out.Filled, out.RetriedFilled)
	}
	if out.RetriedFilled != 2 {
		t.Fatalf("回收轮应补采 2 章，got RetriedFilled=%d", out.RetriedFilled)
	}
	if calls.Load() != 5 {
		t.Fatalf("引擎应被调 5 次（主循环 3 + 回收轮 2），got %d", calls.Load())
	}
	logText := run.LogText()
	if !strings.Contains(logText, "[retry-pass]") {
		t.Fatalf("任务日志应含 [retry-pass] 行，got: %s", logText)
	}
	if !strings.Contains(logText, "第 1/2 轮回收完成：成功 2 / 仍失败 0") {
		t.Fatalf("回收轮结果行不符，got: %s", logText)
	}
}

func TestPhase2FillRetryPassDisabled(t *testing.T) {
	var calls atomic.Int64
	srv := conditionalStubServer(t, &calls, 1<<30) // 恒失败
	t.Setenv("BACKEND_ENGINE_URL", srv.URL)
	t.Setenv("SCRAPE_RETRY_PASSES", "0")
	seedRunningTaskForTest(t, 990_971, "https://r.example/book/1")

	fillMap := retryFillMap(t, 990_971, 972, 2, "第1章 D")
	run := NewRun(990_971)
	out := phase2Fill(run, LoadedRule{}, fillMap, "db", func(int) bool { return true })

	if out.Filled != 0 || out.Failed != 2 {
		t.Fatalf("禁用回收应维持原语义（0 成 2 败），got filled=%d failed=%d", out.Filled, out.Failed)
	}
	if calls.Load() != 2 {
		t.Fatalf("禁用回收不应有额外引擎调用（主循环 2 次），got %d", calls.Load())
	}
	if strings.Contains(run.LogText(), "[retry-pass]") {
		t.Fatalf("禁用回收不应出现 [retry-pass] 日志，got: %s", run.LogText())
	}
}

func TestPhase2FillRetryPassBreakerSkips(t *testing.T) {
	var calls atomic.Int64
	srv := conditionalStubServer(t, &calls, 1<<30) // 恒失败 → 主循环连败熔断
	t.Setenv("BACKEND_ENGINE_URL", srv.URL)
	seedRunningTaskForTest(t, 990_972, "https://r.example/book/1")

	origBreaker := PHASE2_FAIL_BREAKER
	PHASE2_FAIL_BREAKER = 2
	defer func() { PHASE2_FAIL_BREAKER = origBreaker }()

	fillMap := retryFillMap(t, 990_972, 973, 4, "第1章 B")
	run := NewRun(990_972)
	out := phase2Fill(run, LoadedRule{}, fillMap, "db", func(int) bool { return true })

	if !out.FailBreaker {
		t.Fatalf("恒失败场景应触发连败熔断")
	}
	if calls.Load() > 4 {
		t.Fatalf("熔断后不应进入回收轮（引擎调用应 ≤ 主循环 4 次），got %d", calls.Load())
	}
	if strings.Contains(run.LogText(), "轮回收：") {
		t.Fatalf("熔断后不应开始回收轮，got: %s", run.LogText())
	}
}
