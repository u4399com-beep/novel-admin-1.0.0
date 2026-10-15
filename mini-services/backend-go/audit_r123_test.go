/**
 * audit_r123_test.go —— R123 翻页路径瞬态错误透传的回归锁定：
 *
 * R104 三条翻页路径（{page} 占位符 / pageFrom>1 跳首页 / 首页后逐页跟随）此前把
 * fetchListPage 的 per-page 错误串丢弃（pageItems, _ :=），全页失败时空错误串返回
 * 让 runList 的 isTransientScrapeErr 把「同域启动风暴撞熔断窗口」误判为规则失效
 * failed 终态（Task 33 瞬态保护被旁路，恢复成本全由人工 PATCH restart 承担）。
 * R123 修复：捕获首个非空页错误，全 items 空时透传。本文件锁定：
 *
 * 1) TestPlaceholderRangeTransientErrPropagates   占位符路径：stub 引擎全页返回
 *    主机熔断 502 形态 → collectListItems 错误串命中 isTransientScrapeErr（paused
 *    可自动恢复资格）；错误串非空且含「熔断」词面（isRateLimitErrText 契约）。
 *
 * 2) TestPageFromSkipFirstTransientErrPropagates  pageFrom>1 跳首页路径：同形态
 *    stub → 错误透传同样命中瞬态判定。
 *
 * 3) TestPlaceholderPartialHitKeepsEmptyErr      部分成功场景零影响：首页命中后
 *    续页失败 → items 非空 → 返回空错误串（不误伤正常采集语义）。
 *
 * stub 引擎经 BACKEND_ENGINE_URL 注入（engineBaseURL 每次调用现读，可注入）；
 * 复用 recover_test.go 的 TestMain 临时库（绝不触碰生产 db/custom.db）。
 */
package main

import (
        "net/http"
        "net/http/httptest"
        "strings"
        "testing"
        "time"
)

// insertRunningTaskAt 测试库登记指定 id 的 running 任务行——stopState 对不存在任务
// 返回 "canceled"（记录删除视为取消，防孤儿语义），占位符/翻页循环首轮即 break，
// 测试必须先落库才能驱动循环体。显式 id 以便 TaskRecord 与库行对齐。
func insertRunningTaskAt(t *testing.T, id int) {
        t.Helper()
        gdb, err := getDB()
        if err != nil {
                t.Fatalf("open temp db: %v", err)
        }
        now := time.Now().Format(time.RFC3339)
        if _, err := gdb.Exec(`INSERT INTO ScrapeTask (id, status, targetUrl, message, log, createdAt, updatedAt) VALUES (?, 'running', 'https://stub.example/x', '', ?, ?, ?)`,
                id, now, now, now); err != nil {
                t.Fatalf("测试任务落库失败: %v", err)
        }
}

// stubEngineCircuitOpen 模拟引擎主机熔断窗口内的结构化 502 信封（audit57a 契约形态：
// error「目标主机熔断中」——backend isRateLimitErrText 以「熔断」词面归入瞬态）
func stubEngineCircuitOpen() *httptest.Server {
        return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                w.Header().Set("Content-Type", "application/json")
                w.WriteHeader(http.StatusBadGateway)
                _, _ = w.Write([]byte(`{"ok":false,"error":"目标主机熔断中","detail":"熔断阈值触发（3 次连败），剩余冷却 27s"}`))
        }))
}

// stubEngineFirstPageHit 第一页正常提取、其余页同响应（部分成功场景：items 非空）
func stubEngineFirstPageHit() *httptest.Server {
        return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                w.Header().Set("Content-Type", "application/json")
                // 所有页都返回同一页条目（部分成功语义只需 items 非空；去重在 mergeListItems）
                _, _ = w.Write([]byte(`{"ok":true,"data":{"list":{"items":[{"title":"测书籍甲","url":"https://src.example/xiaoshuo/1.html","author":"作者甲"}]}},"warnings":[]}`))
        }))
}

func TestPlaceholderRangeTransientErrPropagates(t *testing.T) {
        srv := stubEngineCircuitOpen()
        defer srv.Close()
        t.Setenv("BACKEND_ENGINE_URL", srv.URL)

        insertRunningTaskAt(t, 990_201) // stopState 门需要库行（不存在=canceled）
        ruleID := 31
        task := TaskRecord{
                ID:        990_201,
                Mode:      "list",
                TargetURL: "https://www.iqxsw.com/sort/2/%7Bpage%7D/", // 编码形占位符（R104 识别形态之一）
                PageFrom:  1,
                PageTo:    3, // 小区间避免测试拖慢；stub 引擎无真实网络
                RuleID:    &ruleID,
        }
        run := NewRun(task.ID)
        items, errText, _ := collectListItems(run, task, LoadedRule{})
        if len(items) != 0 {
                t.Fatalf("熔断 stub 下应 0 条，got %d", len(items))
        }
        if errText == "" {
                t.Fatal("R123 修复前此路径返回空错误串（瞬态熔断被误判 failed 终态）；修复后必须透传页错误")
        }
        if !isTransientScrapeErr(errText) {
                t.Fatalf("占位符路径错误串应命中瞬态判定（paused 可自动恢复），got %q", errText)
        }
        if !strings.Contains(errText, "熔断") {
                t.Fatalf("错误串应含「熔断」词面（isRateLimitErrText 契约），got %q", errText)
        }
}

func TestPageFromSkipFirstTransientErrPropagates(t *testing.T) {
        srv := stubEngineCircuitOpen()
        defer srv.Close()
        t.Setenv("BACKEND_ENGINE_URL", srv.URL)

        insertRunningTaskAt(t, 990_202) // stopState 门需要库行（不存在=canceled）
        ruleID := 31
        task := TaskRecord{
                ID:        990_202,
                Mode:      "list",
                TargetURL: "https://www.iqxsw.com/sort/1/1/", // 无占位符；pageFrom>1 走变体路径
                PageFrom:  2,
                PageTo:    3,
                RuleID:    &ruleID,
        }
        run := NewRun(task.ID)
        items, errText, _ := collectListItems(run, task, LoadedRule{})
        if len(items) != 0 {
                t.Fatalf("熔断 stub 下应 0 条，got %d", len(items))
        }
        if errText == "" {
                t.Fatal("R123 修复前 pageFrom>1 跳首页路径返回空错误串；修复后必须透传页错误")
        }
        if !isTransientScrapeErr(errText) {
                t.Fatalf("pageFrom>1 路径错误串应命中瞬态判定，got %q", errText)
        }
}

func TestPlaceholderPartialHitKeepsEmptyErr(t *testing.T) {
        srv := stubEngineFirstPageHit()
        defer srv.Close()
        t.Setenv("BACKEND_ENGINE_URL", srv.URL)

        insertRunningTaskAt(t, 990_203) // stopState 门需要库行（不存在=canceled）
        ruleID := 31
        task := TaskRecord{
                ID:        990_203,
                Mode:      "list",
                TargetURL: "https://www.iqxsw.com/sort/2/%7Bpage%7D/",
                PageFrom:  1,
                PageTo:    3,
                RuleID:    &ruleID,
        }
        run := NewRun(task.ID)
        items, errText, _ := collectListItems(run, task, LoadedRule{})
        if len(items) == 0 {
                t.Fatal("命中 stub 下应提取到条目")
        }
        // 部分成功语义零影响：items 非空 → 空错误串（不因续页失败误标瞬态终态）
        if errText != "" {
                t.Fatalf("部分成功场景应保持空错误串（正常采集语义），got %q", errText)
        }
        // 合并去重：stub 每页同一条目 → 3 页合并后应仅 1 条
        if len(items) != 1 {
                t.Fatalf("重复条目应被 mergeListItems 去重（3 页同一条→1 条），got %d", len(items))
        }
}
