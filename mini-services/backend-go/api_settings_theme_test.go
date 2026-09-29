/**
 * api_settings_theme_test.go —— Task 31-d 回归锁定：
 * settings PATCH activeTheme 主题白名单校验（旧版任意字符串直入库，
 * renderPage→loadPageTemplate 的 filepath.Join 存在模板路径穿越面 + 全站降级风险）。
 * 复用 recover_test.go 的 TestMain 临时库（绝不触碰生产 db/custom.db）。
 */
package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func mustInitSiteSettingTable(t *testing.T) {
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS "SiteSetting" (
                "id" INTEGER PRIMARY KEY,
                "siteName" TEXT NOT NULL DEFAULT '',
                "activeTheme" TEXT NOT NULL DEFAULT '',
                "notice" TEXT NOT NULL DEFAULT '',
                "seoConfig" TEXT NOT NULL DEFAULT '{}',
                "footerConfig" TEXT NOT NULL DEFAULT '{}',
                "homeConfig" TEXT NOT NULL DEFAULT '{}'
        )`); err != nil {
		t.Fatalf("create SiteSetting: %v", err)
	}
	if err := ensureSettingRow(); err != nil {
		t.Fatalf("ensureSettingRow: %v", err)
	}
	t.Cleanup(func() {
		_, _ = db.Exec(`DELETE FROM "SiteSetting"`)
	})
}

func patchSettings(t *testing.T, body string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPatch, "/api/settings", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handleSettingsPatch(rec, req, nil)
	var m map[string]any
	if b := rec.Body.Bytes(); len(b) > 0 {
		_ = json.Unmarshal(b, &m)
	}
	return rec.Code, m
}

func siteActiveTheme(t *testing.T) string {
	t.Helper()
	var theme string
	if err := queryOne(`SELECT "activeTheme" FROM "SiteSetting" WHERE "id" = 1`, []any{&theme}); err != nil {
		t.Fatalf("read activeTheme: %v", err)
	}
	return theme
}

func TestSettingsPatchActiveThemeWhitelist(t *testing.T) {
	mustInitSiteSettingTable(t)

	// 白名单主题 → 正常写入（trim 后）
	code, resp := patchSettings(t, `{"activeTheme":" ggd66 "}`)
	if code != 200 {
		t.Fatalf("白名单主题 PATCH 应 200，got %d（%v）", code, resp)
	}
	if got := siteActiveTheme(t); got != "ggd66" {
		t.Fatalf("白名单主题应写入，got %q", got)
	}

	// 路径穿越形态 → 忽略不写（旧版直入库：templates/../../etc 可达 loadPageTemplate）
	patchSettings(t, `{"activeTheme":"../../etc"}`)
	if got := siteActiveTheme(t); got != "ggd66" {
		t.Fatalf("穿越形态 activeTheme 必须被忽略，got %q（旧版会持久化）", got)
	}

	// 非白名单任意串 → 忽略不写（防全站模板缺失降级 _fallback）
	patchSettings(t, `{"activeTheme":"not-a-theme"}`)
	if got := siteActiveTheme(t); got != "ggd66" {
		t.Fatalf("非白名单主题必须被忽略，got %q", got)
	}

	// 空串/非字符串 → 忽略不写（PATCH 宽松语义保持）
	patchSettings(t, `{"activeTheme":""}`)
	if got := siteActiveTheme(t); got != "ggd66" {
		t.Fatalf("空串 activeTheme 必须被忽略，got %q", got)
	}
	patchSettings(t, `{"activeTheme":123}`)
	if got := siteActiveTheme(t); got != "ggd66" {
		t.Fatalf("非字符串 activeTheme 必须被忽略，got %q", got)
	}

	// 白名单其余主题全部可写（写入面收窄不误伤合法切换）
	for _, th := range themeNames {
		code, _ := patchSettings(t, `{"activeTheme":"`+th+`"}`)
		if code != 200 || siteActiveTheme(t) != th {
			t.Fatalf("白名单主题 %s 应可写入（code=%d）", th, code)
		}
	}
}
