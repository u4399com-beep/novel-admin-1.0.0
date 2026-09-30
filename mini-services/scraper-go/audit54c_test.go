/**
 * Task 54（E14·反反爬会话级指纹粘性）测试：
 * got 车道画像/Accept-Language 按 host+时间窗哈希粘性——
 * 1) 同 host 同窗多次构造结果逐字节恒等（会话一致性：真实浏览器会话内 UA 恒定）；
 * 2) stickyHashIndex 确定性、有界、盐位去相关；
 * 3) 时间窗轮换后画像可变（长期分布多样性）——直接以固定 window 断言确定性哈希面。
 * 运行：cd mini-services/scraper-go && go test -race ./... -count=1
 */
package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"golang.org/x/text/encoding/simplifiedchinese"
)

// 同 host 同窗粘性：连续多次 headerGeneratorHeaders 产出完全一致（UA 与 Accept-Language
// 均不跳变）。旧实现每请求独立随机——该测试在旧实现下必红（240 轮内几乎必然出现 ≥2 组）。
func TestHeaderGeneratorHeadersStickyPerHost(t *testing.T) {
	first := headerGeneratorHeaders("https://sticky54.example.com/book/1")
	for i := 0; i < 50; i++ {
		h := headerGeneratorHeaders("https://sticky54.example.com/book/1")
		if h["user-agent"] != first["user-agent"] {
			t.Fatalf("第 %d 轮 UA 跳变（会话级指纹粘性被破坏）: %q -> %q", i, first["user-agent"], h["user-agent"])
		}
		if h["accept-language"] != first["accept-language"] {
			t.Fatalf("第 %d 轮 Accept-Language 跳变: %q -> %q", i, first["accept-language"], h["accept-language"])
		}
	}
	// 同窗内路径差异不应影响粘性（同 host 不同路径同画像）
	h2 := headerGeneratorHeaders("https://sticky54.example.com/book/999.html")
	if h2["user-agent"] != first["user-agent"] {
		t.Fatalf("同 host 不同路径 UA 不一致: %q vs %q", first["user-agent"], h2["user-agent"])
	}
}

// stickyHashIndex 契约：确定性（同输入恒同输出）、有界 [0,n)、盐位去相关（'p' 与 'l'
// 独立成族）、窗口轮换覆盖三画像（固定 window 范围内 chrome/edge/firefox 全可达——
// 固定输入的确定性计算，非随机断言，过一次即恒过）。
func TestStickyHashIndexContract(t *testing.T) {
	// 确定性
	for i := 0; i < 30; i++ {
		if got := stickyHashIndex('p', "host54.example.com", 777, 3); got != stickyHashIndex('p', "host54.example.com", 777, 3) {
			t.Fatal("stickyHashIndex 非确定性")
		}
	}
	// 有界 + 盐位/窗口/主机变化的取值全部落在 [0,n)
	sawP := map[int]bool{}
	sawL := map[int]bool{}
	for w := int64(0); w < 300; w++ {
		p := stickyHashIndex('p', "win54.example.com", w, 3)
		if p < 0 || p >= 3 {
			t.Fatalf("下标越界: %d", p)
		}
		sawP[p] = true
		sawL[stickyHashIndex('l', "win54.example.com", w, 3)] = true
		for _, host := range []string{"a.example.com", "b.example.com", "c.example.com"} {
			idx := stickyHashIndex('p', host, w, 3)
			if idx < 0 || idx >= 3 {
				t.Fatalf("下标越界: host=%s window=%d idx=%d", host, w, idx)
			}
		}
	}
	if len(sawP) != 3 {
		t.Fatalf("300 窗口内画像桶未全覆盖（长期多样性缺失）: %v", sawP)
	}
	if len(sawL) != 3 {
		t.Fatalf("300 窗口内 Accept-Language 桶未全覆盖: %v", sawL)
	}
	// 盐位去相关：'p' 与 'l' 在足够样本下不应恒等（同桶率应远低于 1）
	same := 0
	for w := int64(0); w < 300; w++ {
		if stickyHashIndex('p', "salt54.example.com", w, 3) == stickyHashIndex('l', "salt54.example.com", w, 3) {
			same++
		}
	}
	if same == 300 {
		t.Fatalf("两盐位哈希完全同桶（去相关失效）: %d/300", same)
	}
}

// 画像族一致性：粘性选中的画像仍保持既有头族约束（Chrome/Edge 带客户端提示、
// Firefox 不带；Accept-Encoding 声明 E8 口径），防 E14 粘性化时误伤画像构造。
func TestStickyGotProfileFamilyInvariants(t *testing.T) {
	hosts := []string{"fam-chrome54.example.com", "fam-edge54.example.com", "fam-ff54.example.com"}
	sawFamilies := map[string]bool{}
	for _, host := range hosts {
		h := headerGeneratorHeaders("https://" + host + "/book/1")
		ua := h["user-agent"]
		_, hasCH := h["sec-ch-ua"]
		switch {
		case strings.Contains(ua, "Edg/"):
			sawFamilies["edge"] = true
			if !hasCH {
				t.Fatalf("Edge 画像应带客户端提示: host=%s", host)
			}
		case strings.Contains(ua, "Firefox/"):
			sawFamilies["firefox"] = true
			if hasCH {
				t.Fatalf("Firefox 画像不应带客户端提示: host=%s", host)
			}
		case strings.Contains(ua, "Chrome/"):
			sawFamilies["chrome"] = true
			if !hasCH {
				t.Fatalf("Chrome 画像应带客户端提示: host=%s", host)
			}
		default:
			t.Fatalf("未知画像 UA: %q", ua)
		}
		if h["accept-encoding"] != "gzip, deflate" {
			t.Fatalf("E8 accept-encoding 口径被 E14 破坏: %q", h["accept-encoding"])
		}
	}
	if len(sawFamilies) < 2 {
		t.Fatalf("三样本主机至少应覆盖两个画像族（哈希分布异常）: %v", sawFamilies)
	}
}

// ---- Task 54（E15·cf-mitigated 响应头挑战探测）----

// 头值矩阵：challenge/block 命中（大小写/空白容差）；未知值/空值不误报。
func TestHeaderSaysChallenge(t *testing.T) {
	yes := [][]string{
		{"challenge"}, {"CHALLENGE"}, {"Challenge "}, {" block"}, {"challenge", "other"},
		{"BLOCK"}, {"", "challenge"},
	}
	for _, vals := range yes {
		if !headerSaysChallenge(vals) {
			t.Fatalf("headerSaysChallenge(%q)=false, want true", vals)
		}
	}
	no := [][]string{nil, {}, {""}, {"normal"}, {"verified"}, {"challenges-solved"}, {"0"}}
	for _, vals := range no {
		if headerSaysChallenge(vals) {
			t.Fatalf("headerSaysChallenge(%q)=true, want false", vals)
		}
	}
}

// assess 短路：正常体 + 头自报挑战 → challenge-page（warning 提及 cf-mitigated）；
// 同体无头自报 → ok。反向：挑战体 + 无头自报仍由体判定兜底。
func TestAssessServerChallengeHeader(t *testing.T) {
	normal := []byte("<html><body>第一千零一章 突破</body></html>")
	a := assess(200, normal, "text/html", true)
	if a.ok || a.note != "challenge-page" || !a.blocked {
		t.Fatalf("头自报挑战应短路判 challenge-page: %+v", a)
	}
	if !strings.Contains(a.warning, "cf-mitigated") {
		t.Fatalf("warning 应提及 cf-mitigated: %q", a.warning)
	}
	b := assess(200, normal, "text/html", false)
	if !b.ok {
		t.Fatalf("同体无自报应 ok: %+v", b)
	}
	// 挑战体 + 无头自报：体判定兜底（四层不变）
	if c := assess(200, []byte("cf_chl_abc"), "text/html", false); c.ok || c.note != "challenge-page" {
		t.Fatalf("体判定兜底失效: %+v", c)
	}
}

// 端到端（got 车道）：200 + 完全正常的正文 + Cf-Mitigated: challenge → got 判失败
// note=challenge-page（旧实现仅凭体判定会把它当成功入库——挑战壳伪装正常页的收口面）。
func TestGotLaneWireCFMitigatedHeader(t *testing.T) {
	savedPrivate := allowPrivate
	allowPrivate = true
	defer func() { allowPrivate = savedPrivate }()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cf-Mitigated", "challenge")
		_, _ = w.Write([]byte("<html><body>第一千零二章 伪装成正常页的挑战壳</body></html>"))
	}))
	defer srv.Close()

	res := gotStrategyRun(srv.URL+"/b/2.html", 8_000, &strategyRunCtx{insecureTLS: true})
	if res.ok {
		t.Fatalf("WAF 自报挑战不得判成功: %+v", res)
	}
	found := false
	for _, sa := range res.subAttempts {
		if sa.Note == "challenge-page" {
			found = true
		}
	}
	if !found {
		t.Fatalf("子尝试应含 challenge-page note: %+v", res.subAttempts)
	}
}

// 端到端（fetch 车道）：fetchWithRedirectGuard 透出 serverChallenge → assess 短路。
func TestFetchLaneWireCFMitigatedHeader(t *testing.T) {
	savedPrivate := allowPrivate
	allowPrivate = true
	defer func() { allowPrivate = savedPrivate }()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("cf-mitigated", "challenge") // 小写变体
		_, _ = w.Write([]byte("<html><body>正常正文形态</body></html>"))
	}))
	defer srv.Close()

	raw := fetchWithRedirectGuard(srv.URL+"/b/3.html", map[string]string{"user-agent": "test"}, 8_000, &[]string{}, "", true, nil)
	if !raw.serverChallenge {
		t.Fatalf("rawResponse.serverChallenge 应为 true（小写头名大小写不敏感）")
	}
	a := assess(raw.status, raw.bytes, raw.contentType, raw.serverChallenge)
	if a.ok || a.note != "challenge-page" {
		t.Fatalf("assess 应短路判挑战: %+v", a)
	}
}

// ---- Task 54（E16·challengeFeatureSummary GB18030 视图，54-a 留档③落地）----

// GBK 编码的挑战页：字节视图（旧实现唯一视图）下中文挑战词是 GBK 字节序列，
// UTF-8 词面正则漏匹配 → softBlock 档案漏 captcha-title/challenge-keyword 特征。
// E16 后按 GB18030 解码视图补标（仅档案层，判定零参与）。UTF-8 页行为不变（去重）。
func TestChallengeFeatureSummaryGBKView(t *testing.T) {
	enc := simplifiedchinese.GBK.NewEncoder()
	gbkBody, err := enc.Bytes([]byte("<html><head><title>安全验证</title></head><body>请完成验证后继续访问</body></html>"))
	if err != nil {
		t.Fatalf("GBK 编码失败: %v", err)
	}
	hits := challengeFeatureSummary(gbkBody)
	has := func(label string) bool {
		for _, h := range hits {
			if h == label {
				return true
			}
		}
		return false
	}
	if !has("captcha-title") {
		t.Fatalf("GBK 页应经 GB18030 视图标注 captcha-title: %v", hits)
	}
	if !has("challenge-keyword") {
		t.Fatalf("GBK 页应标注 challenge-keyword: %v", hits)
	}
	// UTF-8 同语义页：标注不重复（seen 去重），且依旧命中
	utf8Hits := challengeFeatureSummary([]byte("<html><head><title>安全验证</title></head><body>请完成验证后继续访问</body></html>"))
	count := 0
	for _, h := range utf8Hits {
		if h == "captcha-title" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("UTF-8 页 captcha-title 应恰一次（去重）: %v", utf8Hits)
	}
	// 纯 ASCII 正常页：零新增特征（无误杀面扩大）
	if h := challengeFeatureSummary([]byte("<html><body>plain novel chapter content here</body></html>")); len(h) != 0 {
		t.Fatalf("正常页不应有特征: %v", h)
	}
}
