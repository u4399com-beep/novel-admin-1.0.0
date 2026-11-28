/**
 * webi18n_langip_test.go —— R160 语种判定链与渲染管线回归锁定：
 *   1. webLangNormalize：zh-HK 归并 zh-Hant；白名单外拒绝
 *   2. webLangCountry：国家码映射（TW/HK/MO→zh-Hant、CN/SG/MY→zh-CN、JP→ja、KR→ko）
 *   3. isPrivateOrLoopbackIP：私网/回环/畸形 IP 不出网；公网放行
 *   4. webLangFromAcceptHeader：q 值降序 + 泛中文/地区中文分派
 *   5. tmplT/tmplTf：字典命中、miss 回落原文、{0} 占位符替换
 *   6. i18nTexts：zh-CN 直通零查询；zh-Hant 缓存命中直出（预插 TranslationCache，
 *      不触上游）；en 未命中原文（绝不同步调 LLM）
 *   7. webLangOfRequest：?lang= 参数优先 > cookie > Accept-Language 兜底（私网 IP
 *      不出网查 geo；无 cookie/param 时回落 AL）
 *   8. i18nMilestoneLabels：字典词条与动态「N浏览」形态双路
 * 复用 recover_test.go 的 TestMain 临时库（绝不触碰生产 db/custom.db）。
 */
package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWebLangNormalize(t *testing.T) {
	if got := webLangNormalize("zh-HK"); got != "zh-Hant" {
		t.Fatalf("zh-HK 应归并 zh-Hant，got %q", got)
	}
	for _, l := range []string{"zh-CN", "zh-Hant", "en", "ja", "ko"} {
		if webLangNormalize(l) != l {
			t.Fatalf("白名单语种 %s 不应被改写", l)
		}
	}
	if webLangNormalize("fr") != "" || webLangNormalize("") != "" || webLangNormalize("../etc") != "" {
		t.Fatalf("白名单外语种应返回空串")
	}
}

func TestWebLangCountryMapping(t *testing.T) {
	cases := map[string]string{"TW": "zh-Hant", "HK": "zh-Hant", "MO": "zh-Hant", "CN": "zh-CN", "SG": "zh-CN", "MY": "zh-CN", "JP": "ja", "KR": "ko", "KP": "ko"}
	for cc, want := range cases {
		if got := webLangCountry[cc]; got != want {
			t.Fatalf("country %s want %s got %s", cc, want, got)
		}
	}
	if webLangCountry["US"] != "" {
		t.Fatalf("未登记国家应空（ipGeoQuery 兜底 en），got %q", webLangCountry["US"])
	}
}

func TestIsPrivateOrLoopbackIP(t *testing.T) {
	priv := []string{"127.0.0.1", "::1", "192.168.1.5", "10.0.0.9", "172.16.3.4", "169.254.1.2", "", "not-an-ip", "0.0.0.0"}
	for _, ip := range priv {
		if !isPrivateOrLoopbackIP(ip) {
			t.Fatalf("%q 应判私网/无效（不出网查询）", ip)
		}
	}
	for _, ip := range []string{"8.8.8.8", "210.61.0.1", "1.32.239.255"} {
		if isPrivateOrLoopbackIP(ip) {
			t.Fatalf("%q 是公网地址，不应判私网", ip)
		}
	}
}

func TestWebLangFromAcceptHeader(t *testing.T) {
	cases := []struct {
		hdr, want string
	}{
		{"zh-CN,zh;q=0.9,en;q=0.8", "zh-CN"},
		{"zh-TW,zh;q=0.9", "zh-Hant"},
		{"zh-HK,zh;q=0.9", "zh-Hant"},
		{"ja-JP,ja;q=0.9,en;q=0.5", "ja"},
		{"ko-KR,ko;q=0.9", "ko"},
		{"en-US,en;q=0.9", "en"},
		{"fr-FR,fr;q=0.9,en;q=0.5", "en"},
		{"fr-FR,fr;q=0.9", ""},
		{"", ""},
	}
	for _, c := range cases {
		if got := webLangFromAcceptHeader(c.hdr); got != c.want {
			t.Fatalf("Accept-Language %q want %q got %q", c.hdr, c.want, got)
		}
	}
}

func TestTmplTAndTmplTf(t *testing.T) {
	if tmplT("zh-CN", "首页") != "首页" {
		t.Fatalf("zh-CN 应直返原文")
	}
	if tmplT("en", "首页") != "Home" {
		t.Fatalf("en 字典未命中首页: %q", tmplT("en", "首页"))
	}
	if tmplT("ja", "阅读设置") != "読書設定" {
		t.Fatalf("ja 字典未命中阅读设置: %q", tmplT("ja", "阅读设置"))
	}
	if tmplT("ko", "加入书架") != "서재에 추가" {
		t.Fatalf("ko 字典未命中加入书架: %q", tmplT("ko", "加入书架"))
	}
	if tmplT("zh-Hant", "搜索书名、作者") != "搜尋書名、作者" {
		t.Fatalf("zh-Hant 字典未命中搜索占位词: %q", tmplT("zh-Hant", "搜索书名、作者"))
	}
	if got := tmplT("en", "完全不在字典里的词组xyz"); got != "完全不在字典里的词组xyz" {
		t.Fatalf("字典 miss 应回落原文，got %q", got)
	}
	if got := tmplTf("en", "全部{0}本 →", int64(10)); got != "All 10 →" {
		t.Fatalf("Tf en: %q", got)
	}
	if got := tmplTf("zh-Hant", "共{0}章", 712); got != "共712章" {
		t.Fatalf("Tf zh-Hant: %q", got)
	}
	if got := tmplTf("en", "“{0}” 共{1}本", "剑", 3); got != "\"剑\" - 3 books" {
		t.Fatalf("Tf 双占位: %q", got)
	}
}

func TestI18nTextsZhCNDirect(t *testing.T) {
	in := []string{"玄幻", ""}
	out := i18nTexts("zh-CN", 0, in)
	if len(out) != 2 || out[0] != "玄幻" || out[1] != "" {
		t.Fatalf("zh-CN 应原样直通: %v", out)
	}
}

func TestI18nTextsZhHantCacheHit(t *testing.T) {
	mustInitTranslationCacheTable(t)
	db, err := getDB()
	if err != nil {
		t.Fatalf("db: %v", err)
	}
	// 预插缓存（translatewarm 预热形态）：仅插一段，另一段未命中（无上游依赖——
	// 上游不可达时 zh-Hant 同步补译失败静默回落原文，恰好锁定降级契约）
	src, trans := "妖女，快住口！", "妖女，快住口！（繁）"
	key := translateCacheKey(src, "zh-Hant")
	if _, err := db.Exec(`INSERT OR REPLACE INTO "TranslationCache" ("key","target","content","novelId","createdAt") VALUES (?,?,?,0,?)`,
		key, "zh-Hant", trans, nowMillis()); err != nil {
		t.Fatalf("seed cache: %v", err)
	}
	out := i18nTexts("zh-Hant", 0, []string{src, "未命中的一段"})
	if out[0] != trans {
		t.Fatalf("缓存命中段应替换: %q", out[0])
	}
	if out[1] != "未命中的一段" {
		t.Fatalf("未命中段应保留原文（上游不可达优雅降级）: %q", out[1])
	}
}

func TestI18nTextsEnNoSyncUpstream(t *testing.T) {
	mustInitTranslationCacheTable(t)
	// R190 契约：en 未命中 → 同步补译完整性闸（i18nSyncFillMisses 预算内补译后展示）；
	// 上游不可用（503）→ 预算内零译文 → 原文兜底（翻译栈故障绝不拖垮渲染）
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(503)
	}))
	defer up.Close()
	oldURL := translateServiceBaseURL
	translateServiceBaseURL = up.URL
	defer func() { translateServiceBaseURL = oldURL }()
	out := i18nTexts("en", 0, []string{"一本无人问津的书"})
	if len(out) != 1 || out[0] != "一本无人问津的书" {
		t.Fatalf("en 未命中+上游不可用应原文兜底: %v", out)
	}
}

func TestWebLangOfRequestOverrideChain(t *testing.T) {
	// ?lang= 参数最高优先（私网 IP 下 cookie/geo 均不可用，param 直接生效）
	req := httptest.NewRequest("GET", "/?lang=zh-Hant", nil)
	if got := webLangOfRequest(req, nil); got != "zh-Hant" {
		t.Fatalf("?lang=zh-Hant want zh-Hant got %q", got)
	}
	// cookie 次优先
	req2 := httptest.NewRequest("GET", "/", nil)
	req2.AddCookie(&http.Cookie{Name: webLangCookie, Value: "ja"})
	if got := webLangOfRequest(req2, nil); got != "ja" {
		t.Fatalf("cookie jxzw-lang=ja want ja got %q", got)
	}
	// param 覆盖 cookie
	req3 := httptest.NewRequest("GET", "/?lang=en", nil)
	req3.AddCookie(&http.Cookie{Name: webLangCookie, Value: "ja"})
	if got := webLangOfRequest(req3, nil); got != "en" {
		t.Fatalf("param 应覆盖 cookie: %q", got)
	}
	// 白名单外 param 静默忽略 → 私网+无 cookie → Accept-Language 兜底
	req4 := httptest.NewRequest("GET", "/?lang=xx", nil)
	req4.Header.Set("Accept-Language", "zh-TW,zh;q=0.9")
	if got := webLangOfRequest(req4, nil); got != "zh-Hant" {
		t.Fatalf("非法 param 应回落 AL: %q", got)
	}
	// zh-HK 参数归并 zh-Hant
	req5 := httptest.NewRequest("GET", "/?lang=zh-HK", nil)
	if got := webLangOfRequest(req5, nil); got != "zh-Hant" {
		t.Fatalf("zh-HK 应归并 zh-Hant: %q", got)
	}
	// 全部来源缺失 → 默认 zh-CN
	req6 := httptest.NewRequest("GET", "/", nil)
	if got := webLangOfRequest(req6, nil); got != "zh-CN" {
		t.Fatalf("默认应 zh-CN: %q", got)
	}
}

func TestI18nMilestoneLabels(t *testing.T) {
	ms := map[string]any{"label": "百万浏览", "nextLabel": "856浏览"}
	i18nMilestoneLabels("en", ms)
	if ms["label"] != "1M views" {
		t.Fatalf("en 字典词条: %q", ms["label"])
	}
	if ms["nextLabel"] != "views 856" {
		t.Fatalf("en 动态形态 Tf 组装: %q", ms["nextLabel"])
	}
	ms2 := map[string]any{"label": "一万浏览"}
	i18nMilestoneLabels("zh-Hant", ms2)
	if ms2["label"] != "一萬瀏覽" {
		t.Fatalf("zh-Hant 里程碑: %q", ms2["label"])
	}
}

func TestWebLangAttrOf(t *testing.T) {
	if webLangAttrOf("zh-Hant") != "zh-Hant" || webLangAttrOf("en") != "en" || webLangAttrOf("bogus") != "zh-CN" {
		t.Fatalf("LangAttr 映射异常")
	}
}
