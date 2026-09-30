/**
 * audit58b_test.go —— Task 58-b 深审三项主线线索的回归锁定：
 *
 * 1) TestRunTaskReloadsRuleFreshPerRun（规则装载时序）：
 *    resume/restart 的语义是「重新入队 pending → runner 领取 → runTask → loadRule」，
 *    loadRule 每次从 DB 现读（storex.go，无任何进程内缓存）——本测试走真实 runTask 全链
 *    （stub 引擎捕获 /api/test 请求体），两次执行之间 UPDATE 规则 proxy/charset，
 *    断言第二次执行必然携带新值。锁定「规则配置变更 + PATCH resume 必然读到最新规则值」
 *    ——若未来任何人给 loadRule/任务领取加缓存/快照路径，此测试必红。
 *
 * 2) TestScrapeTaskLifecycleActionsMatrix（任务生命周期状态机）：
 *    PATCH action=cancel/pause/resume/restart 全矩阵端到端（经 dispatch 路由）：
 *    - restart 对四种终态（failed/partial/canceled/success）均可用且进度五字段清零
 *      ——partial 任务的「等效重发」走 restart（进度清零 + 骨架续传），条件更新
 *      WHERE status IN ('failed','partial','canceled','success') 不漏分支；
 *    - 非终态（pending/running/paused）restart 拒绝；partial 上 cancel/pause/resume 拒绝
 *      （终态不可取消/暂停，恢复仅限 paused）；未知 action / 坏 body 拒绝。
 *
 * 3) TestRuleProxiesForHostFreshReadsDB（封面回退对规则代理变更的感知）：
 *    ruleProxiesForHost 每次调用现查 ScrapeRule（coversx.go 无缓存）——UPDATE 规则代理后
 *    再查立即拿到新值，coversx 多出口回退（Task 51）对「规则代理变更」即时感知。
 *
 * 复用 recover_test.go 的 TestMain 临时库（绝不触碰生产 db/custom.db）；
 * 规则 id 用 956xx 段（audit50b=951xx/audit51=952xx/audit53b=953xx/audit51b=954xx 之外），
 * 任务 id 用 957xx 段。
 */
package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// ---------- 共享夹具 ----------

// insertAudit58bTask 建一条可指定 status/进度字段的任务行（957xx 段，Cleanup 自清）
func insertAudit58bTask(t *testing.T, id int64, status string, total, done, chaptersDone, chaptersTotal, chapters int64) {
	t.Helper()
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO "ScrapeTask" ("id","mode","targetUrl","ruleId","pages","storageMode","status",
                  "total","done","chaptersDone","chaptersTotal","created","updated","chapters","createdAt","updatedAt")
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0,?,?,?)`,
		id, "list", "https://lifecycle.invalid/list.html", nil, 1, "db", status,
		total, done, chaptersDone, chaptersTotal, chapters, nowMillis(), nowMillis()); err != nil {
		t.Fatalf("insert task %d: %v", id, err)
	}
	t.Cleanup(func() {
		_, _ = db.Exec(`DELETE FROM "ScrapeTask" WHERE "id" = ?`, id)
	})
}

// patchTaskAction 经 dispatch 路由发 PATCH（锁定 action 分发 + handler 全链）
func patchTaskAction(t *testing.T, ts *httptest.Server, id int64, body string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPatch, ts.URL+"/api/scrape-tasks/"+itoa(int(id)), strings.NewReader(body))
	if err != nil {
		t.Fatalf("build PATCH: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("PATCH: %v", err)
	}
	return resp
}

// taskProgressRow 读任务状态与进度五字段
func taskProgressRow(t *testing.T, id int64) (status string, total, done, chaptersDone, chaptersTotal, chapters int64) {
	t.Helper()
	err := queryOne(`SELECT "status","total","done","chaptersDone","chaptersTotal","chapters" FROM "ScrapeTask" WHERE "id" = ?`,
		[]any{&status, &total, &done, &chaptersDone, &chaptersTotal, &chapters}, id)
	if err != nil {
		t.Fatalf("query task %d: %v", id, err)
	}
	return
}

// taskLogOf 读任务日志（断言 restart/resume 的留痕行）
func taskLogOf(t *testing.T, id int64) string {
	t.Helper()
	var logv string
	if err := queryOne(`SELECT "log" FROM "ScrapeTask" WHERE "id" = ?`, []any{&logv}, id); err != nil {
		t.Fatalf("query log: %v", err)
	}
	return logv
}

// ---------- ① 规则装载时序（真实 runTask 全链） ----------

func TestRunTaskReloadsRuleFreshPerRun(t *testing.T) {
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	mustInitRuleFixtures(t) // Cleanup：DELETE ScrapeRule WHERE id >= 95200

	// 规则：proxy/charset 初始值（proxy 走真实 http URL 形态，值仅在引擎请求体内断言）
	if _, err := db.Exec(
		`INSERT INTO "ScrapeRule" ("id","name","siteUrl","charset","proxy","createdAt","updatedAt")
                 VALUES (95601,'58b-fresh-rule','https://fresh.example/','gbk','http://p-first:1',0,0)`); err != nil {
		t.Fatalf("insert rule: %v", err)
	}

	// stub 引擎：捕获 /api/test 请求体（proxy/charset 由 engineRuleBody 从 LoadedRule 展开），
	// 返回无章节的书 → 任务快速走到 success 终态（totalChapters=0 分支，无 Phase 2）
	var mu sync.Mutex
	var bodies []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := readAllLimited(r.Body, 1<<20)
		var m map[string]any
		_ = json.Unmarshal(raw, &m)
		mu.Lock()
		bodies = append(bodies, m)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"data":{"book":{"title":"规则时序都市测试书","author":"某作者","chapterCount":0,"chapters":[]}}}`))
	}))
	defer srv.Close()
	t.Setenv("BACKEND_ENGINE_URL", srv.URL)

	// 任务（95701 段）：single 模式挂规则 95601
	if _, err := db.Exec(
		`INSERT INTO "ScrapeTask" ("id","mode","targetUrl","ruleId","pages","storageMode","status","createdAt","updatedAt")
                 VALUES (95701,'single','https://fresh.example/book/1',95601,1,'db','pending',?,?)`, nowMillis(), nowMillis()); err != nil {
		t.Fatalf("insert task: %v", err)
	}
	t.Cleanup(func() {
		_, _ = db.Exec(`DELETE FROM "ScrapeTask" WHERE "id" = 95701`)
		// 采集产物清理（书行/pseo 种子；Category「其他/都市言情」为系统共享类不删）
		_, _ = db.Exec(`DELETE FROM "Novel" WHERE "title" = '规则时序都市测试书'`)
		_, _ = db.Exec(`DELETE FROM "PseoKeyword" WHERE "keyword" = '规则时序都市测试书' OR "seed" = '规则时序都市测试书'`)
		_, _ = db.Exec(`DELETE FROM "Chapter" WHERE "novelId" NOT IN (SELECT "id" FROM "Novel")`)
	})

	runTask(95701) // 第一次执行（等价创建后 runner 领取）
	if status, _, _, _, _, _ := taskProgressRow(t, 95701); status != "success" {
		t.Fatalf("首次执行应 success（无章节书入库即成功），got %s", status)
	}
	mu.Lock()
	if len(bodies) != 1 {
		t.Fatalf("引擎应被调用 1 次，got %d", len(bodies))
	}
	proxy1, _ := bodies[0]["proxy"].(string)
	charset1, _ := bodies[0]["charset"].(string)
	mu.Unlock()
	if proxy1 != "http://p-first:1" || charset1 != "gbk" {
		t.Fatalf("首次执行应携带初始规则值 proxy=http://p-first:1 charset=gbk，got proxy=%q charset=%q", proxy1, charset1)
	}

	// 模拟主线恢复流程：任务暂停期间给规则配置代理（PATCH 规则），再 PATCH resume 重新入队
	if _, err := db.Exec(`UPDATE "ScrapeRule" SET "proxy" = 'http://p-second:2', "charset" = 'utf-8' WHERE "id" = 95601`); err != nil {
		t.Fatalf("update rule: %v", err)
	}
	if _, err := db.Exec(`UPDATE "ScrapeTask" SET "status" = 'pending' WHERE "id" = 95701`); err != nil {
		t.Fatalf("requeue: %v", err)
	}
	runTask(95701) // 第二次执行（等价 resume/restart 后 runner 领取）
	mu.Lock()
	if len(bodies) != 2 {
		t.Fatalf("引擎应被调用 2 次，got %d", len(bodies))
	}
	proxy2, _ := bodies[1]["proxy"].(string)
	charset2, _ := bodies[1]["charset"].(string)
	mu.Unlock()
	if proxy2 != "http://p-second:2" || charset2 != "utf-8" {
		t.Fatalf("resume/restart 后必须读到最新规则值 proxy=http://p-second:2 charset=utf-8，got proxy=%q charset=%q（陈旧值=任务领取路径存在缓存/快照）", proxy2, charset2)
	}
}

// ---------- ② 生命周期状态机矩阵（PATCH action 全分支） ----------

func TestScrapeTaskLifecycleActionsMatrix(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(dispatch))
	defer ts.Close()

	// ---- restart：四种终态均可用（partial 为主线实测的「等效重发」入口），进度五字段清零 ----
	for i, st := range []string{"failed", "partial", "canceled", "success"} {
		id := int64(95710 + i)
		insertAudit58bTask(t, id, st, 100, 40, 40, 100, 40)
		resp := patchTaskAction(t, ts, id, `{"action":"restart"}`)
		if resp.StatusCode != 200 {
			t.Fatalf("restart(%s) 应 200，got %d", st, resp.StatusCode)
		}
		_ = resp.Body.Close()
		status, total, done, chDone, chTotal, chapters := taskProgressRow(t, id)
		if status != "pending" {
			t.Fatalf("restart(%s) 应转 pending，got %s", st, status)
		}
		if total != 0 || done != 0 || chDone != 0 || chTotal != 0 || chapters != 0 {
			t.Fatalf("restart(%s) 进度五字段应清零，got total=%d done=%d chaptersDone=%d chaptersTotal=%d chapters=%d",
				st, total, done, chDone, chTotal, chapters)
		}
		if logv := taskLogOf(t, id); !strings.Contains(logv, "手动重启") {
			t.Fatalf("restart(%s) 应留痕日志，got %q", st, logv)
		}
		// 幂等竞态面：restart 后任务已是 pending，再次 restart 必须 400（条件更新不覆盖非终态）
		resp2 := patchTaskAction(t, ts, id, `{"action":"restart"}`)
		if resp2.StatusCode != 400 {
			t.Fatalf("pending 状态二次 restart 应 400，got %d", resp2.StatusCode)
		}
		_ = resp2.Body.Close()
	}

	// ---- partial 终态不可 cancel/pause/resume（终态语义闭合：恢复=paused 专属，重发=restart） ----
	id := int64(95720)
	insertAudit58bTask(t, id, "partial", 10, 5, 5, 10, 5)
	for _, action := range []string{"cancel", "pause", "resume"} {
		resp := patchTaskAction(t, ts, id, `{"action":"`+action+`"}`)
		if resp.StatusCode != 400 {
			t.Fatalf("partial 上 %s 应 400，got %d", action, resp.StatusCode)
		}
		_ = resp.Body.Close()
	}
	if status, _, _, _, _, _ := taskProgressRow(t, id); status != "partial" {
		t.Fatalf("partial 任务不得被非法 action 改写状态，got %s", status)
	}

	// ---- paused → resume 可用（pending + 日志留痕）；paused 上 restart 拒绝 ----
	id = int64(95721)
	insertAudit58bTask(t, id, "paused", 10, 5, 5, 10, 5)
	resp := patchTaskAction(t, ts, id, `{"action":"resume"}`)
	if resp.StatusCode != 200 {
		t.Fatalf("resume(paused) 应 200，got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()
	if status, total, done, _, _, _ := taskProgressRow(t, id); status != "pending" || total != 10 || done != 5 {
		t.Fatalf("resume 应保持进度字段不动（续传语义），got status=%s total=%d done=%d", status, total, done)
	}
	if logv := taskLogOf(t, id); !strings.Contains(logv, "手动恢复") {
		t.Fatalf("resume 应留痕日志，got %q", logv)
	}

	// ---- paused 上 restart/cancel：restart 400（非终态），cancel 200（「已暂停任务也能停止」） ----
	id = int64(95722)
	insertAudit58bTask(t, id, "paused", 0, 0, 0, 0, 0)
	resp = patchTaskAction(t, ts, id, `{"action":"restart"}`)
	if resp.StatusCode != 400 {
		t.Fatalf("paused 上 restart 应 400，got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()
	resp = patchTaskAction(t, ts, id, `{"action":"cancel"}`)
	if resp.StatusCode != 200 {
		t.Fatalf("cancel(paused) 应 200（已暂停可停止），got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()
	if status, _, _, _, _, _ := taskProgressRow(t, id); status != "canceled" {
		t.Fatalf("cancel(paused) 应转 canceled，got %s", status)
	}

	// ---- pending → pause 可用（脱离 runner 轮询池）；canceled 上 resume/restart/pause 拒绝 ----
	id = int64(95723)
	insertAudit58bTask(t, id, "pending", 0, 0, 0, 0, 0)
	resp = patchTaskAction(t, ts, id, `{"action":"pause"}`)
	if resp.StatusCode != 200 {
		t.Fatalf("pause(pending) 应 200，got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()
	if status, _, _, _, _, _ := taskProgressRow(t, id); status != "paused" {
		t.Fatalf("pause(pending) 应转 paused，got %s", status)
	}
	if _, err := getDB(); err != nil {
		t.Fatalf("db: %v", err)
	}

	// ---- 契约面：未知 action / 坏 body / 空 body → 400 ----
	for _, body := range []string{`{"action":"nope"}`, `{}`, `not-json`} {
		resp := patchTaskAction(t, ts, 95720, body)
		if resp.StatusCode != 400 {
			t.Fatalf("非法 PATCH body %q 应 400，got %d", body, resp.StatusCode)
		}
		_ = resp.Body.Close()
	}
}

// ---------- ③ 封面回退出口对规则代理变更的即时感知 ----------

func TestRuleProxiesForHostFreshReadsDB(t *testing.T) {
	mustInitRuleFixtures(t)
	insertRule(t, 95611, "https://fresh-proxy.example/", "http://p-before:1")

	src := "https://img.fresh-proxy.example/cover.jpg"
	got1 := ruleProxiesForHost(src)
	if len(got1) != 1 || got1[0] != "http://p-before:1" {
		t.Fatalf("初始候选应恰为 http://p-before:1，got %v", got1)
	}

	// 规则代理变更（主线场景：给规则补配代理）→ 回退候选必须立即感知（coversx 无缓存层）
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	if _, err := db.Exec(`UPDATE "ScrapeRule" SET "proxy" = 'http://p-after:2, http://p-after:3' WHERE "id" = 95611`); err != nil {
		t.Fatalf("update rule proxy: %v", err)
	}
	got2 := ruleProxiesForHost(src)
	want := []string{"http://p-after:2", "http://p-after:3"}
	if len(got2) != len(want) {
		t.Fatalf("变更后候选 = %v, want %v", got2, want)
	}
	for i := range want {
		if got2[i] != want[i] {
			t.Fatalf("变更后候选[%d] = %q, want %q（旧值说明存在陈旧缓存路径）", i, got2[i], want[i])
		}
	}
}
