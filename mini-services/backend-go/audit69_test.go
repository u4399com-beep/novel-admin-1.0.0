/**
 * audit69_test.go —— Task 69 全量封面重取回归（用户指令「根据采集任务日志，重新获取
 * 所有在库书籍的封面图」）。
 *
 * 锁定语义：
 *  1. coverBackfillCandidatesPaged：游标/limit 翻页；token 面（常规补抓）与 force
 *     全量面（含已落盘本地路径书）的候选过滤；coverSrc 空两面均排除；
 *  2. force 批量失败不降级：本地路径书尝试失败后 cover 保持本地路径、coverSrc 留存
 *    （fetchAndStoreCoverOpt 只在成功时 rename 覆盖，失败路径零写）；
 *  3. 常规批量幂等：已落盘书不入 token 面（attempted 不含）。
 *
 * 复用 recover_test.go 的 TestMain 临时库（绝不触碰生产 db/custom.db）；coverSrc 一律
 * 私网地址——SSRF 文本层即拒，零网络依赖、测试恒快（audit50b_test.go 先例）。id 段
 * 96600+ 避让其他测试文件。
 */
package main

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// mustDB69 测试库句柄（recover_test.go TestMain 已指向临时库）
func mustDB69() *sql.DB {
	d, err := getDB()
	if err != nil {
		panic(err)
	}
	return d
}

// mustInitCover69Fixtures 测试分类 + 自清夹具（id 段 96600+）
func mustInitCover69Fixtures(t *testing.T) {
	t.Helper()
	if _, err := mustDB69().Exec(`INSERT OR IGNORE INTO "Category" ("id","name") VALUES (9601,'全量重取测试分类')`); err != nil {
		t.Fatalf("insert category: %v", err)
	}
	t.Cleanup(func() {
		_, _ = mustDB69().Exec(`DELETE FROM "Novel" WHERE "id" >= 96600 AND "id" < 96700`)
		_, _ = mustDB69().Exec(`DELETE FROM "Category" WHERE "id" = 9601`)
	})
}

func insertCover69Novel(t *testing.T, id int64, title, cover, coverSrc string) {
	t.Helper()
	if _, err := mustDB69().Exec(`INSERT INTO "Novel" ("id","title","author","cover","coverSrc","categoryId","status","createdAt","updatedAt")
                        VALUES (?,?,?,?,?,9601,'serial',0,0)`, id, title, "全量重取测试作者", cover, coverSrc); err != nil {
		t.Fatalf("insert novel #%d: %v", id, err)
	}
}

// TestCoverBackfillCandidatesPaged69 游标/limit/两面过滤
func TestCoverBackfillCandidatesPaged69(t *testing.T) {
	mustInitCover69Fixtures(t)
	const src = "http://192.168.1.1/x.jpg" // SSRF 文本层即拒
	insertCover69Novel(t, 96601, "token书", "g5", src)
	insertCover69Novel(t, 96602, "本地路径书", "/covers/96602.jpg", src)
	insertCover69Novel(t, 96603, "无源书", "g6", "")
	insertCover69Novel(t, 96604, "g12书", "g12", src) // g12 漏扫回归锚点
	insertCover69Novel(t, 96605, "本地路径书2", "/covers/96605.jpg", src)

	// token 面：仅 token 形态
	got, more, err := coverBackfillCandidatesPaged(0, true, 0)
	if err != nil {
		t.Fatalf("token 面: %v", err)
	}
	if more {
		t.Fatal("limit=0 不限页时 hasMore 应为 false")
	}
	seen := map[int64]bool{}
	for _, c := range got {
		seen[c.id] = true
	}
	if !seen[96601] || !seen[96604] {
		t.Fatalf("token 面应含 96601/96604，got %v", seen)
	}
	if seen[96602] || seen[96603] || seen[96605] {
		t.Fatalf("token 面不应含本地路径/无源书，got %v", seen)
	}

	// force 面：token + 本地路径全入候选，无源书排除
	got, more, err = coverBackfillCandidatesPaged(0, false, 0)
	if err != nil {
		t.Fatalf("force 面: %v", err)
	}
	seen = map[int64]bool{}
	for _, c := range got {
		seen[c.id] = true
	}
	if !seen[96601] || !seen[96602] || !seen[96604] || !seen[96605] {
		t.Fatalf("force 面应含全部有源书，got %v", seen)
	}
	if seen[96603] {
		t.Fatal("force 面不应含 coverSrc 空书")
	}
	if more {
		t.Fatal("limit=0 不限页时 hasMore 应为 false")
	}

	// 游标 + limit：afterId=96601 limit=1 → 恰为 96602
	got, more, err = coverBackfillCandidatesPaged(96601, false, 1)
	if err != nil {
		t.Fatalf("游标页: %v", err)
	}
	if len(got) != 1 || got[0].id != 96602 {
		t.Fatalf("afterId=96601 limit=1 应只返 96602，got %+v", got)
	}
	if !more {
		t.Fatal("limit=1 截断时 hasMore 应为 true")
	}
}

// TestRunCoverBackfillBatchForceNoDowngradeOnFail force 失败不降级：
// 本地路径书尝试失败（SSRF 拒）→ cover 保持本地路径、coverSrc 留存（成功才会 rename
// 覆盖+UPDATE，失败路径零写）。
func TestRunCoverBackfillBatchForceNoDowngradeOnFail(t *testing.T) {
	mustInitCover69Fixtures(t)
	insertCover69Novel(t, 96611, "失败保留书", "/covers/96611.jpg", "http://192.168.1.1/never.jpg")

	sum, err := runCoverBackfillBatch(true, 96599, 10, "")
	if err != nil {
		t.Fatalf("batch: %v", err)
	}
	tried := false
	for _, f := range sum.Failures {
		if f.ID == 96611 {
			tried = true
		}
	}
	if !tried {
		t.Fatal("force 批应尝试本地路径书（候选面含本地路径）")
	}
	var cover, coverSrc string
	if err := mustDB69().QueryRow(`SELECT "cover","coverSrc" FROM "Novel" WHERE "id" = 96611`).Scan(&cover, &coverSrc); err != nil {
		t.Fatal(err)
	}
	if cover != "/covers/96611.jpg" || coverSrc != "http://192.168.1.1/never.jpg" {
		t.Fatalf("force 失败后 cover/coverSrc = %q/%q, want 原值保留（不降级）", cover, coverSrc)
	}
}

// TestRunCoverBackfillBatchNormalSkipsStored 常规面幂等：已落盘书不入候选。
func TestRunCoverBackfillBatchNormalSkipsStored(t *testing.T) {
	mustInitCover69Fixtures(t)
	insertCover69Novel(t, 96621, "已落盘书", "/covers/96621.jpg", "http://192.168.1.1/x.jpg")
	insertCover69Novel(t, 96622, "缺图书", "g7", "http://192.168.1.1/y.jpg")

	sum, err := runCoverBackfillBatch(false, 96599, 10, "")
	if err != nil {
		t.Fatalf("batch: %v", err)
	}
	for _, f := range sum.Failures {
		if f.ID == 96621 {
			t.Fatal("常规面不应尝试已落盘书")
		}
	}
	tried := false
	for _, f := range sum.Failures {
		if f.ID == 96622 {
			tried = true
		}
	}
	if !tried {
		t.Fatal("常规面应尝试 token 形态缺图书")
	}
	var cover string
	if err := mustDB69().QueryRow(`SELECT "cover" FROM "Novel" WHERE "id" = 96622`).Scan(&cover); err != nil {
		t.Fatal(err)
	}
	if cover != "g7" {
		t.Fatalf("失败后 cover 应保留 g7 token，got %q", cover)
	}
}

// TestIsCertVerifyErr x509 分类锁定（Task 69-b）：证书类失败精准命中，网络类/nil 不误判。
func TestIsCertVerifyErr(t *testing.T) {
	cases := []struct {
		msg  string
		want bool
	}{
		{`Get "https://38.34.172.127/a.jpg": tls: failed to verify certificate: x509: cannot validate certificate for 38.34.172.127 because it doesn't contain any IP SANs`, true},
		{"x509: certificate has expired or is not yet valid", true},
		{"tls: failed to verify certificate: x509: certificate signed by unknown authority", true},
		{"x509: certificate is valid for www.example.com, not request host", true},
		{"dial tcp 1.2.3.4:443: i/o timeout", false},
		{"net/http: TLS handshake timeout", false},
		{"", false},
	}
	for _, c := range cases {
		var err error
		if c.msg != "" {
			err = &noopErr69{msg: c.msg}
		}
		if got := isCertVerifyErr(err); got != c.want {
			t.Fatalf("isCertVerifyErr(%q) = %v, want %v", c.msg, got, c.want)
		}
	}
}

// noopErr69 固定消息 error（errors.New 亦可，独立类型防外部依赖歧义）
type noopErr69 struct{ msg string }

func (e *noopErr69) Error() string { return e.msg }

// TestFetchCoverFallbackOptForcePassthrough force 透传锁定：fetchCoverWithFallbackOpt
// 在 force=true 时对确定性 404 不回退（与 force=false 同确定性语义），失败原因透传。
func TestFetchCoverFallbackOptForcePassthrough(t *testing.T) {
	// 203.0.113.99 TEST-NET：dial 失败为网络类 → force=true 也会走回退（候选=注入空池）
	// → 返回首因。锁定 force 不改变回退语义本身，只改变幂等复用。
	old := coverFallbackProxies
	coverFallbackProxies = func(string) []string { return nil }
	t.Cleanup(func() { coverFallbackProxies = old })

	stored, reason := fetchCoverWithFallbackOpt(96651, "http://203.0.113.99/c.jpg", "", time.Time{}, true)
	if stored != "" {
		t.Fatalf("TEST-NET 直连应失败，got %q", stored)
	}
	if !strings.HasPrefix(reason, "请求失败") {
		t.Fatalf("网络类失败原因应保留「请求失败」前缀（触发回退语义），got %q", reason)
	}
}

// TestPurgeStaleCoversTestIsolation69 Task 69-c 双层防线锁定：
// ① TestMain 必须设置 COVERS_DIR 沙箱且 coversDir() 指向它（文件半边隔离）；
// ② 测试进程（DB_PATH 重定向）调用 purgeStaleCoversOnFreshDB 恒 no-op——空库
//
//	（「全新库」形态）也绝不删除封面文件（DB_PATH 守卫 = 生产护栏）。
//
// 2026-10-01 实证背景：守卫缺失时两次 go test 静默清空真实 public/covers/（1690 张）。
func TestPurgeStaleCoversTestIsolation69(t *testing.T) {
	if os.Getenv("DB_PATH") == "" {
		t.Skip("仅测试进程内有效（DB_PATH 已重定向）")
	}
	if os.Getenv("COVERS_DIR") == "" {
		t.Fatal("TestMain 必须设置 COVERS_DIR 沙箱（Task 69-c 文件半边隔离）")
	}
	if coversDir() != os.Getenv("COVERS_DIR") {
		t.Fatalf("coversDir() 应指向沙箱 %s，got %s", os.Getenv("COVERS_DIR"), coversDir())
	}
	f := filepath.Join(coversDir(), "999999.jpg")
	if err := os.WriteFile(f, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Remove(f) }()
	purgeStaleCoversOnFreshDB(mustDB69()) // 空临时库 = 「全新库」形态，守卫必须拦截
	if _, err := os.Stat(f); err != nil {
		t.Fatal("DB_PATH 守卫失效：purgeStaleCoversOnFreshDB 删除了封面文件")
	}
}
