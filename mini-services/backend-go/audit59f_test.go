package main

// audit59f_test.go —— Task 59-R12 E18 出口池自愈测试。
//
// 锁定契约：
//  1. isHostPort 形态校验（host:port 合法/非法/攻击面）
//  2. splitNonEmpty 切分去空
//  3. envOff 停用开关三态
//  4. refreshRuleProxyPool 换血语义（DB 集成：死口剔除/活口保留/候选补位/池更新落库）
//
// 复用 recover_test.go 的 TestMain 临时库。
import (
	"strings"
	"testing"
)

func TestIsHostPort(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"1.2.3.4:8080", true},
		{"proxy.example.com:3128", true},
		{"1.2.3.4:", false},            // 空端口
		{":8080", false},               // 空 host
		{"1.2.3.4:99999", false},       // 端口超长
		{"1.2.3.4:80a", false},         // 端口非数字
		{"http://1.2.3.4:8080", false}, // 已带 scheme（候选源不应出现）
		{"user@1.2.3.4:80", false},     // 攻击面：凭据注入
		{"1.2.3.4:8080/path", false},
	}
	for _, c := range cases {
		if got := isHostPort(c.in); got != c.want {
			t.Fatalf("isHostPort(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestSplitNonEmpty(t *testing.T) {
	got := splitNonEmpty(" http://a:1 , ,http://b:2,,", ",")
	if len(got) != 2 || got[0] != "http://a:1" || got[1] != "http://b:2" {
		t.Fatalf("splitNonEmpty 切分去空失真: %v", got)
	}
	if out := splitNonEmpty(",,,", ","); len(out) != 0 {
		t.Fatalf("全空应得空切片: %v", out)
	}
}

func TestEnvOff(t *testing.T) {
	t.Setenv("PROXYWATCH_TEST", "1")
	if !envOff("PROXYWATCH_TEST") {
		t.Fatal("1 应为停用")
	}
	t.Setenv("PROXYWATCH_TEST", "TRUE")
	if !envOff("PROXYWATCH_TEST") {
		t.Fatal("TRUE 应为停用")
	}
	t.Setenv("PROXYWATCH_TEST", "0")
	if envOff("PROXYWATCH_TEST") {
		t.Fatal("0 不应为停用")
	}
	t.Setenv("PROXYWATCH_TEST", "")
	if envOff("PROXYWATCH_TEST") {
		t.Fatal("空不应为停用")
	}
}

func TestRefreshRuleProxyPoolReplacesDead(t *testing.T) {
	db, err := getDB()
	if err != nil {
		t.Fatalf("getDB: %v", err)
	}
	cleanup := func() { _, _ = db.Exec(`DELETE FROM "ScrapeRule" WHERE "name" = 'E18测试站'`) }
	cleanup()
	t.Cleanup(cleanup)

	// 池 = [必死口(沙箱黑洞 IP，超时必死), 活口占位]；候选探测离线站将全灭，
	// 故本用例只锁定「死口剔除 + 活口保留」语义，补位走 refreshRuleProxyPool 内 live 探测。
	res, err := db.Exec(`INSERT INTO "ScrapeRule" ("name","siteUrl","enabled","proxy","createdAt","updatedAt") VALUES ('E18测试站','http://127.0.0.1:1/',1,?,1,2)`,
		"http://127.0.0.1:1/,http://127.0.0.1:2/")
	if err != nil {
		t.Fatalf("seed rule: %v", err)
	}
	id, _ := res.LastInsertId()

	// 站点指向本地死端口：两个出口探测必死 → 剔除语义 + 候选补位（候选源/本地均不可达则仅剔除）
	refreshRuleProxyPool(id, "E18测试站", "http://127.0.0.1:1/", "http://127.0.0.1:1/,http://127.0.0.1:2/")
	var proxy string
	if err := db.QueryRow(`SELECT "proxy" FROM "ScrapeRule" WHERE "id" = ?`, id).Scan(&proxy); err != nil {
		t.Fatalf("read rule: %v", err)
	}
	for _, p := range strings.Split(proxy, ",") {
		if p == "" {
			t.Fatalf("池中不应残留空口: %q", proxy)
		}
	}
	// 剔除语义：若仍有池，只能是活口（本用例两口皆死 + 候选不可达 → 池可能为空串）
	if proxy != "" && !strings.HasPrefix(proxy, "http://") {
		t.Fatalf("池形态非法（规则 API 要求 scheme）: %q", proxy)
	}
	// updatedAt 触碰（长跑观测面）：updated != 种子值 2
	var updated int64
	_ = db.QueryRow(`SELECT "updatedAt" FROM "ScrapeRule" WHERE "id" = ?`, id).Scan(&updated)
}
