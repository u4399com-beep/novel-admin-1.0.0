/**
 * web_footer_test.go —— Task 32-a 回归锁定：
 * 1) sanitizeFooterConfig friendLinks 友链清洗（[{name,url}]，≤30 条，http(s):// 前缀强制，
 *    空名/病态项丢弃，批内去重）；
 * 2) gatherFooterFriendLinks 读取侧防御复检（历史行/手改库形态）；
 * 3) renderFriendLinksBlock 独立渲染器（空配置零 DOM 痕迹 / 有链含标题与转义输出）；
 * 4) gatherFleetLinks 站群内链轮（SiteSite enabled=1 查询、排除当前 Host、id 升序、
 *    disabled 剔除、默认站无 Host 全量展示、60s 缓存命中不重查）。
 * 复用 recover_test.go 的 TestMain 临时库（SiteSite 表由 getDB once 幂等建表）。
 * 运行：cd mini-services/backend-go && go test -run TestFooter ./...
 */
package main

import (
	"encoding/json"
	"html/template"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// seedFooterFriendConfig 便捷构造 footerConfig（经写入侧 sanitize 全链路）
func footerConfigFromJSON(t *testing.T, raw string) map[string]any {
	t.Helper()
	var v any
	if err := json.Unmarshal([]byte(raw), &v); err != nil {
		t.Fatalf("json unmarshal: %v", err)
	}
	return sanitizeFooterConfig(v)
}

func TestSanitizeFooterConfigFriendLinks(t *testing.T) {
	// 合法项保留；javascript:/相对路径/空名/空 url/非对象项全部丢弃；批内去重
	cfg := footerConfigFromJSON(t, `{
                "friendLinks":[
                        {"name":"站点A","url":"https://a.example.com/"},
                        {"name":"JS 注入","url":"javascript:alert(1)"},
                        {"name":"相对路径","url":"/path/x"},
                        {"name":"","url":"https://b.example.com/"},
                        {"name":"无URL","url":"  "},
                        "not-an-object",
                        {"name":"站点A","url":"https://a.example.com/"},
                        {"name":"http 站","url":"http://c.example.com/"}
                ]
        }`)
	friends, ok := cfg["friendLinks"].([]map[string]string)
	if !ok {
		t.Fatalf("friendLinks 应为 []map[string]string，got %T", cfg["friendLinks"])
	}
	if len(friends) != 2 {
		t.Fatalf("应保留 2 条合法友链，got %d: %v", len(friends), friends)
	}
	if friends[0]["name"] != "站点A" || friends[0]["url"] != "https://a.example.com/" {
		t.Fatalf("第 1 条应为 站点A/https://a.example.com/，got %v", friends[0])
	}
	if friends[1]["url"] != "http://c.example.com/" {
		t.Fatalf("http:// 前缀应放行，got %v", friends[1])
	}

	// 超上限截断（31 条 → 30 条）
	var sb strings.Builder
	sb.WriteString(`{"friendLinks":[`)
	for i := 0; i < 31; i++ {
		if i > 0 {
			sb.WriteString(",")
		}
		sb.WriteString(`{"name":"站` + string(rune('A'+i%26)) + `","url":"https://x` + itoa(i) + `.example.com/"}`)
	}
	sb.WriteString(`]}`)
	cfg = footerConfigFromJSON(t, sb.String())
	friends = cfg["friendLinks"].([]map[string]string)
	if len(friends) != footerFriendLinkCount {
		t.Fatalf("友链应截断到 %d 条，got %d", footerFriendLinkCount, len(friends))
	}

	// 病态形态：数组/标量/缺字段 → friendLinks 键不出现
	cfg = footerConfigFromJSON(t, `{"friendLinks":["a","b"]}`)
	if _, exists := cfg["friendLinks"]; exists {
		t.Fatalf("数组形态 friendLinks 应整组丢弃")
	}
	cfg = footerConfigFromJSON(t, `{"text":"x"}`)
	if _, exists := cfg["friendLinks"]; exists {
		t.Fatalf("未提供 friendLinks 不应产出该键")
	}

	// links 清洗回归：Task 32-a 改动不影响既有 links 语义
	cfg = footerConfigFromJSON(t, `{"links":[{"label":"内页","href":"/about"}],"friendLinks":[{"name":"外站","url":"https://d.example.com/"}]}`)
	if links, ok := cfg["links"].([]map[string]string); !ok || len(links) != 1 || links[0]["href"] != "/about" {
		t.Fatalf("既有 links 清洗语义被破坏: %v", cfg["links"])
	}
}

func TestGatherFooterFriendLinksDefensive(t *testing.T) {
	// 历史行/手改库形态：name/url 为任意 any，读取侧复检 http(s) 前缀 + 非空
	raw := map[string]any{
		"friendLinks": []any{
			map[string]any{"name": "正常站", "url": "https://ok.example.com/"},
			map[string]any{"name": "坏协议", "url": "ftp://bad.example.com/"},
			map[string]any{"name": 123, "url": "https://num.example.com/"}, // name 非字符串 → 丢弃
			map[string]any{"name": "超长截断", "url": "https://t.example.com/" + strings.Repeat("p", 400)},
		},
	}
	out := gatherFooterFriendLinks(raw)
	if len(out) != 2 {
		t.Fatalf("防御复检应保留 2 条，got %d: %v", len(out), out)
	}
	if out[1]["name"] != "超长截断" || len([]rune(out[1]["url"])) > footerFriendURLMax {
		t.Fatalf("url 应截断到 %d rune 内: %v", footerFriendURLMax, out[1])
	}
}

func TestRenderFriendLinksBlock(t *testing.T) {
	if got := renderFriendLinksBlock(map[string]any{}); got != "" {
		t.Fatalf("空配置应零 DOM 痕迹，got %q", got)
	}
	cfg := footerConfigFromJSON(t, `{"friendLinks":[{"name":"<A>&\"站\"","url":"https://q.example.com/?a=1&b=2"}]}`)
	got := renderFriendLinksBlock(cfg)
	if !strings.Contains(got, "友情链接") {
		t.Fatalf("区块应含「友情链接」标题: %s", got)
	}
	if !strings.Contains(got, `target="_blank"`) || !strings.Contains(got, `rel="noopener noreferrer"`) {
		t.Fatalf("链接应带 target=_blank 且无 nofollow: %s", got)
	}
	if strings.Contains(got, "<A>&") {
		t.Fatalf("名称必须经 HTML 转义: %s", got)
	}
	if !strings.Contains(got, `href="https://q.example.com/?a=1&amp;b=2"`) {
		t.Fatalf("url 属性值必须转义: %s", got)
	}
}

// mustInitSiteSiteRows 插入测试站点行（复用 getDB once 建好的 SiteSite 表）
func mustInitSiteSiteRows(t *testing.T, rows []struct {
	host, name string
	enabled    int64
}) {
	t.Helper()
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	t.Cleanup(func() { _, _ = db.Exec(`DELETE FROM "SiteSite"`) })
	for i, r := range rows {
		if _, err := db.Exec(`INSERT INTO "SiteSite" ("host","siteName","activeTheme","notice","seoConfig","footerConfig","homeConfig","enabled","createdAt","updatedAt")
                        VALUES (?,?,?,?,?,?,?,?,?,?)`, r.host, r.name, "aijjxs", "", "{}", "{}", "{}", r.enabled, nowMillis()+int64(i), nowMillis()+int64(i)); err != nil {
			t.Fatalf("insert site %s: %v", r.host, err)
		}
	}
}

func resetFleetCache() {
	fleetLinksMu.Lock()
	fleetLinksCache = nil
	fleetLinksExpiry = time.Time{}
	fleetLinksMu.Unlock()
}

func TestGatherFleetLinks(t *testing.T) {
	resetFleetCache()
	mustInitSiteSiteRows(t, []struct {
		host, name string
		enabled    int64
	}{
		{"a.example.com", "站点A", 1},
		{"b.example.com", "站点B", 1},
		{"c.example.com", "站点C(停用)", 0},
	})

	// 当前站=a：排除自己，id 升序，仅 enabled
	got := gatherFleetLinks("a.example.com")
	if len(got) != 1 || got[0]["host"] != "b.example.com" || got[0]["siteName"] != "站点B" {
		t.Fatalf("排除自站+disabled 后应只剩 站点B，got %v", got)
	}
	if got[0]["url"] != "http://b.example.com/" {
		t.Fatalf("url 应为 http://{host}/，got %q", got[0]["url"])
	}

	// 默认站点（无 host）：展示全部 enabled（2 条）
	got = gatherFleetLinks("")
	if len(got) != 2 || got[0]["host"] != "a.example.com" || got[1]["host"] != "b.example.com" {
		t.Fatalf("默认站应展示全部 enabled 站点（id 升序），got %v", got)
	}

	// 站点不在组内（未命中 Host）→ 与默认站同语义（全量）
	got = gatherFleetLinks("outsider.example.com")
	if len(got) != 2 {
		t.Fatalf("组外 Host 应全量展示，got %v", got)
	}
}

func TestFleetLinksCache(t *testing.T) {
	resetFleetCache()
	mustInitSiteSiteRows(t, []struct {
		host, name string
		enabled    int64
	}{
		{"a.example.com", "站点A", 1},
		{"b.example.com", "站点B", 1},
	})

	if n := len(gatherFleetLinks("")); n != 2 {
		t.Fatalf("初次查询应 2 条，got %d", n)
	}

	// 缓存窗口内新增站点 → 仍读到旧快照（不重查）
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO "SiteSite" ("host","siteName","activeTheme","enabled","createdAt","updatedAt") VALUES ('d.example.com','站点D',1,1,0,0)`); err != nil {
		t.Fatalf("insert site d: %v", err)
	}
	if n := len(gatherFleetLinks("")); n != 2 {
		t.Fatalf("缓存窗口内应仍为 2 条（不重查），got %d", n)
	}

	// 强制过期（时间戳回拨）→ 重查后 3 条
	fleetLinksMu.Lock()
	fleetLinksExpiry = time.Time{}
	fleetLinksMu.Unlock()
	if n := len(gatherFleetLinks("")); n != 3 {
		t.Fatalf("过期后应重查得 3 条，got %d", n)
	}
}

func TestFleetLinksEmptyTable(t *testing.T) {
	resetFleetCache()
	mustInitSiteSiteRows(t, nil) // 清空表
	if got := gatherFleetLinks(""); len(got) != 0 {
		t.Fatalf("空表应返回空列表，got %v", got)
	}
}

// TestSharedFooterBlocksRender 10 主题 _shared.html 页脚区块渲染回归：
// 有友链/链轮数据 → 各主题 layout 渲染出「友情链接/站群导航」区块与链接；
// 无数据 → 区块零 DOM 痕迹（不含标题字样）。（101kks 为繁体語境：友情連結/站群導航）
func TestSharedFooterBlocksRender(t *testing.T) {
	resetFleetCache()
	nav := []map[string]any{{"id": int64(1), "name": "玄幻"}}
	site := map[string]any{"siteName": "测试站", "notice": "", "activeTheme": "aijjxs", "footerText": "", "footerExtra": "", "footerLinks": []map[string]any{}}
	base := map[string]any{
		"Site": site, "Nav": nav, "Path": "/", "Q": "",
		"pageTitle": "测试页", "pageDescription": "", "pageKeywords": "",
	}
	withData := map[string]any{}
	for k, v := range base {
		withData[k] = v
	}
	withData["FriendLinks"] = []map[string]string{{"name": "友链甲", "url": "https://f.example.com/"}}
	withData["FleetLinks"] = []map[string]string{{"host": "b.example.com", "siteName": "站点B", "url": "http://b.example.com/"}}

	for _, theme := range themeNames {
		shared := filepath.Join(templatesRoot, theme, "_shared.html")
		tpl, err := template.New("t").Funcs(webFuncMap()).ParseFiles(shared)
		if err != nil {
			t.Fatalf("%s _shared.html 解析失败: %v", theme, err)
		}
		if _, err := tpl.Parse(`{{define "content"}}STUB{{end}}`); err != nil {
			t.Fatalf("%s stub content 解析失败: %v", theme, err)
		}
		// 有数据 → 区块与链接出现
		var b strings.Builder
		if err := tpl.ExecuteTemplate(&b, "layout", withData); err != nil {
			t.Fatalf("%s layout 渲染失败（有数据）: %v", theme, err)
		}
		out := b.String()
		title := "友情链接"
		fleetTitle := "站群导航"
		if theme == "101kks" {
			title, fleetTitle = "友情連結", "站群導航"
		}
		if !strings.Contains(out, title) || !strings.Contains(out, "友链甲") {
			t.Fatalf("%s 应渲染友情链接区块（%s/友链甲）", theme, title)
		}
		if !strings.Contains(out, fleetTitle) || !strings.Contains(out, "站点B") || !strings.Contains(out, `href="http://b.example.com/"`) {
			t.Fatalf("%s 应渲染站群导航区块（%s/站点B/http://b.example.com/）", theme, fleetTitle)
		}
		// 无数据 → 区块零 DOM 痕迹（以「标题：」带冒号的区块内文案为准——101kks 默认
		// footerExtra 兜底文案本就含「友情連結」字样，不能只查标题）
		b.Reset()
		if err := tpl.ExecuteTemplate(&b, "layout", base); err != nil {
			t.Fatalf("%s layout 渲染失败（无数据）: %v", theme, err)
		}
		if strings.Contains(b.String(), title+"：") || strings.Contains(b.String(), fleetTitle+"：") {
			t.Fatalf("%s 无数据时不应出现友链/链轮区块", theme)
		}
	}
}
