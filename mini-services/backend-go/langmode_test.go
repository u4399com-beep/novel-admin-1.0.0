/**
 * langmode_test.go —— R163 站群/默认站点语种模式（langMode）回归锁定：
 *   1. webLangModeNorm：auto/off/force:* 白名单原样；非法/空白值拒绝（空串返回）
 *   2. langModeFromBody：默认站点（allowInherit=false）空串忽略不写；站群站点
 *      （allowInherit=true）空串合法=跟随默认站点（写入 ''）；非法值一律不动
 *   3. webLangOfRequest off 模式：判定链整体旁路恒 zh-CN（?lang=/cookie 亦不覆盖）
 *   4. webLangOfRequest force 模式：强制语种（?lang=/cookie 均不覆盖——「强制」
 *      单一诚实语义；五种 force 值映射全量）
 *   5. SiteSite.langMode 站群站点：'' 继承默认站点（resolveSite 解析）；独立值覆盖生效
 * 测试结束恢复 SiteSetting.langMode='auto' 并清理 SiteSite 测试行（不影响其余用例）。
 * 复用 recover_test.go 的 TestMain 临时库（绝不触碰生产 db/custom.db）。
 */
package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWebLangModeNorm(t *testing.T) {
	for _, m := range []string{"auto", "off", "force:zh-CN", "force:zh-Hant", "force:en", "force:ja", "force:ko"} {
		if webLangModeNorm(m) != m {
			t.Fatalf("合法模式 %s 不应被改写", m)
		}
	}
	if webLangModeNorm(" force:en ") != "force:en" {
		t.Fatalf("首尾空白应归一")
	}
	for _, m := range []string{"", "on", "force:fr", "force:", "Force:EN", "zH-hant", "bogus"} {
		if webLangModeNorm(m) != "" {
			t.Fatalf("非法模式 %q 应返回空串", m)
		}
	}
}

func TestLangModeFromBody(t *testing.T) {
	// 默认站点（allowInherit=false）：空串/非法值=键不动
	if v, ok := langModeFromBody(map[string]any{"langMode": ""}, false); ok || v != "" {
		t.Fatalf("默认站点空串应忽略不写: (%q,%v)", v, ok)
	}
	if v, ok := langModeFromBody(map[string]any{"langMode": "force:fr"}, false); ok || v != "" {
		t.Fatalf("非法值应忽略不写: (%q,%v)", v, ok)
	}
	if v, ok := langModeFromBody(map[string]any{"langMode": 42}, false); ok || v != "" {
		t.Fatalf("非字符串应忽略不写: (%q,%v)", v, ok)
	}
	// 合法值写入
	if v, ok := langModeFromBody(map[string]any{"langMode": "force:zh-Hant"}, false); !ok || v != "force:zh-Hant" {
		t.Fatalf("合法模式应写入: (%q,%v)", v, ok)
	}
	// 站群站点（allowInherit=true）：空串合法=跟随默认站点（写入 ''）
	if v, ok := langModeFromBody(map[string]any{"langMode": ""}, true); !ok || v != "" {
		t.Fatalf("站群站点空串=跟随默认站点应写入 '': (%q,%v)", v, ok)
	}
	if _, ok := langModeFromBody(map[string]any{"langMode": "bogus"}, true); ok {
		t.Fatalf("站群站点非法值仍应忽略不写")
	}
	// 键缺失=不动
	if _, ok := langModeFromBody(map[string]any{}, true); ok {
		t.Fatalf("键缺失应不写")
	}
}

// setSiteLangMode 测试辅助：写入默认站点 langMode（测试收尾恢复）
func setSiteLangMode(t *testing.T, m string) {
	t.Helper()
	if err := ensureSettingRow(); err != nil {
		t.Fatalf("ensureSettingRow: %v", err)
	}
	if _, err := exec(`UPDATE "SiteSetting" SET "langMode" = ? WHERE "id" = 1`, m); err != nil {
		t.Fatalf("set langMode: %v", err)
	}
}

func TestWebLangOfRequestOffMode(t *testing.T) {
	setSiteLangMode(t, "off")
	t.Cleanup(func() { setSiteLangMode(t, "auto") })
	// ?lang= 与 cookie 均被旁路（off=恒 zh-CN 单一诚实语义，与 R160 geoLang=0 对齐）
	req := httptest.NewRequest("GET", "/?lang=zh-Hant", nil)
	req.AddCookie(&http.Cookie{Name: webLangCookie, Value: "ja"})
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	if got := webLangOfRequest(req, nil); got != "zh-CN" {
		t.Fatalf("off 模式应恒 zh-CN（param/cookie/AL 全旁路），got %q", got)
	}
}

func TestWebLangOfRequestForcedMode(t *testing.T) {
	cases := map[string]string{
		"force:zh-CN":   "zh-CN",
		"force:zh-Hant": "zh-Hant",
		"force:en":      "en",
		"force:ja":      "ja",
		"force:ko":      "ko",
	}
	for mode, want := range cases {
		setSiteLangMode(t, mode)
		// 强制语义：?lang=/cookie/Accept-Language 全部不覆盖（判定链整体旁路）
		req := httptest.NewRequest("GET", "/?lang=ja", nil)
		req.AddCookie(&http.Cookie{Name: webLangCookie, Value: "en"})
		req.Header.Set("Accept-Language", "ko-KR,ko;q=0.9")
		if got := webLangOfRequest(req, nil); got != want {
			t.Fatalf("%s 强制模式下 ?lang=ja+cookie=en+AL=ko 应恒 %s，got %q", mode, want, got)
		}
	}
	t.Cleanup(func() { setSiteLangMode(t, "auto") })
	// 非法脏值兜底 auto（存储层历史脏数据不锁死全站语种）
	setSiteLangMode(t, "force:fr")
	req2 := httptest.NewRequest("GET", "/?lang=zh-Hant", nil)
	if got := webLangOfRequest(req2, nil); got != "zh-Hant" {
		t.Fatalf("非法 force:fr 应回落 auto 判定链（?lang= 生效），got %q", got)
	}
}

func TestWebLangOfRequestFleetSiteInherit(t *testing.T) {
	setSiteLangMode(t, "force:en")
	t.Cleanup(func() { setSiteLangMode(t, "auto") })
	const host = "fleet-r163.example.com"
	t.Cleanup(func() { _, _ = exec(`DELETE FROM "SiteSite" WHERE "host" = ?`, host) })
	// 站群站点 langMode='' → 继承默认站点 force:en
	if _, err := exec(`INSERT INTO "SiteSite" ("host","siteName","enabled","urlStyle","langMode","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?)`,
		host, "R163 继承测试站", 1, 1, "", nowMillis(), nowMillis()); err != nil {
		t.Fatalf("seed SiteSite: %v", err)
	}
	req := httptest.NewRequest("GET", "http://"+host+"/?lang=ja", nil)
	if got := webLangOfRequest(req, nil); got != "en" {
		t.Fatalf("站群站点 '' 应继承默认站点 force:en（?lang= 不覆盖），got %q", got)
	}
	// 站群站点独立 force:ja → 覆盖默认站点
	if _, err := exec(`UPDATE "SiteSite" SET "langMode" = 'force:ja' WHERE "host" = ?`, host); err != nil {
		t.Fatalf("update SiteSite langMode: %v", err)
	}
	if got := webLangOfRequest(req, nil); got != "ja" {
		t.Fatalf("站群站点独立 force:ja 应覆盖默认站点，got %q", got)
	}
	// 未匹配 Host 的请求不受站群行影响（走默认站点 force:en）
	req2 := httptest.NewRequest("GET", "http://other.example.com/", nil)
	if got := webLangOfRequest(req2, nil); got != "en" {
		t.Fatalf("未匹配 Host 应回落默认站点 force:en，got %q", got)
	}
}
