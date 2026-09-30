package main

// audit59e_test.go —— Task 59-R10 回归锁定：R6 seoTplCore 收敛引入的
// 「nil vars 时 siteName 注入丢失」回归（home 标题变「 - 免费小说…」）。
//
// 契约：
//  1. applyWebTDK/applyWebKeywords 传 nil vars 时，siteName 仍注入模板（回传语义）
//  2. SSR /：<title> 必含站点名前缀（webCommon 默认站 + homeTitle 模板）
//  3. 非 nil vars：调用方 map 获得 siteName（引用语义，与 TS 版一致）
//
// 复用 recover_test.go 的 TestMain 临时库。
import (
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func TestApplyWebTDKNilVarsInjectsSiteName(t *testing.T) {
	data := map[string]any{
		"Site": map[string]any{"siteName": "测试站名"},
	}
	applyWebTDK(data, "homeTitle", "homeDescription", nil, "回退标题", "回退描述")
	pt, _ := data["pageTitle"].(string)
	if !strings.Contains(pt, "测试站名") {
		t.Fatalf("nil vars 时 siteName 注入丢失: %q", pt)
	}
	pd, _ := data["pageDescription"].(string)
	if pd == "" {
		t.Fatal("pageDescription 不应为空")
	}
}

func TestApplyWebKeywordsNilVarsInjectsSiteName(t *testing.T) {
	data := map[string]any{
		"Site": map[string]any{"siteName": "测试站名"},
	}
	// 默认 homeKeywords 模板含 {siteName}：注入后渲染不得丢失站名
	applyWebKeywords(data, "homeKeywords", nil, "")
	pk, _ := data["pageKeywords"].(string)
	if !strings.Contains(pk, "测试站名") {
		t.Fatalf("nil vars 时 siteName 注入丢失: %q", pk)
	}
}

func TestApplyWebTDKNonNilVarsReference(t *testing.T) {
	vars := map[string]string{"keyword": "K"}
	data := map[string]any{"Site": map[string]any{"siteName": "测试站名"}}
	applyWebTDK(data, "bookTitle", "bookDescription", vars, "fb", "fb")
	if vars["siteName"] != "测试站名" {
		t.Fatalf("非 nil vars 引用语义被破坏: %q", vars["siteName"])
	}
}

func TestSSRHomeTitleContainsSiteName(t *testing.T) {
	req := httptest.NewRequest("GET", "https://web.example.com/", nil)
	rec := httptest.NewRecorder()
	handleWebHome(rec, req)
	if rec.Code != 200 {
		t.Fatalf("home status = %d", rec.Code)
	}
	body := rec.Body.String()
	i := strings.Index(body, "<title>")
	j := strings.Index(body, "</title>")
	if i < 0 || j < 0 || j <= i {
		t.Fatalf("home 缺少 <title>")
	}
	title := body[i+len("<title>") : j]
	// 实体转码可能作用于 title 文本：比对前先剥数字/十六进制实体还原近似形态
	if !strings.Contains(title, "青阅文学") && !strings.Contains(htmlUnescapeApprox(title), "青阅文学") {
		t.Fatalf("home <title> 丢失站名前缀（R6 回归）: %q", title)
	}
}

// htmlUnescapeApprox 测试用近似实体还原（&#N; / &#xH; 数字实体 + 常见命名实体）
func htmlUnescapeApprox(s string) string {
	r := strings.NewReplacer(
		"&amp;", "&", "&lt;", "<", "&gt;", ">", "&quot;", "\"", "&#39;", "'",
	)
	s = r.Replace(s)
	for {
		i := strings.Index(s, "&#")
		if i < 0 {
			break
		}
		j := strings.Index(s[i:], ";")
		if j < 0 {
			break
		}
		tok := s[i+2 : i+j]
		var n int64
		var err error
		if strings.HasPrefix(tok, "x") || strings.HasPrefix(tok, "X") {
			n, err = strconv.ParseInt(tok[1:], 16, 32)
		} else {
			n, err = strconv.ParseInt(tok, 10, 32)
		}
		if err != nil || n <= 0 || n > 0x10FFFF {
			break
		}
		s = s[:i] + string(rune(n)) + s[i+j+1:]
	}
	return s
}
