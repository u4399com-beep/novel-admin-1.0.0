/**
 * audit51b_test.go —— Task 51-b 深审回归锁定（封面多出口回退的对抗性复审产物）：
 * ① 修复①语义修正：候选出口的确定性失败（拦截页 200 text-html/伪造 404）不再放弃
 *    整条回退链——「坏出口排在好出口前面」时旧版回退机制被单点瓦解；主出口确定性
 *    失败仍零回退（audit51_test.go TestFetchCoverWithFallbackNoRetryOnDeterministic 已锁，
 *    直连/主出口是对目标的真实观察，语义不变）；
 * ② 修复①附带：全部候选失败且存在确定性原因时优先透出该原因（比传输层首因更可定位）；
 * ③ maxCoverFallbackCandidates 候选上限：病态超长代理池截断，第 13 个候选不尝试；
 * ④ 修复②：同 id 并发下载 tmp 绝对唯一（os.CreateTemp 以 O_EXCL 强化 Task 27-c 纳秒
 *    时间戳方案）+ 成功后零遗留 .tmp（defer Remove 兜底清理失败路径的不变量）；
 * ⑤ regDomainApprox 边界向量（IP 字面量/单段/多段/尾点 FQDN）表驱动锁定。
 * 复用 recover_test.go 的 TestMain 临时库（本文件零 DB 行，无需 id 段夹具）；落盘 id
 * 954xx 段（避让 audit51_test 的 953xx），t.Cleanup 删除产物；remoteURL 用 203.0.113.99
 * （TEST-NET-3 文档段，IP 字面量不触 DNS），真实出口走伪代理 httptest——零外网依赖。
 */
package main

import (
	"image"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestCoverFallbackContinuesAfterCandidateDeterministic 修复①端到端：primary 503（网络类）
// → 候选[拦截页 200 text/html, 合法 JPEG]。旧版在候选 0 处即放弃（「非图像响应」被判
// 确定性失败→整链终止），好出口永不尝试；修正后继续尝试并成功落盘。
func TestCoverFallbackContinuesAfterCandidateDeterministic(t *testing.T) {
	bad503, _ := fakeProxyServer(t, http.StatusServiceUnavailable, "text/plain", []byte("no"))
	defer bad503.Close()
	block, blockHits := fakeProxyServer(t, http.StatusOK, "text/html", []byte("<html>blocked</html>"))
	defer block.Close()
	good, goodHits := fakeProxyServer(t, http.StatusOK, "image/jpeg", tinyJPEGBytes(t))
	defer good.Close()

	var calls atomic.Int64
	withCoverFallbackProxies(t, &calls, []string{block.URL, good.URL})

	stored, reason := fetchCoverWithFallback(95401, "http://203.0.113.99/cover.jpg", bad503.URL, time.Time{})
	if stored != "/covers/95401.jpg" {
		t.Fatalf("候选出口确定性失败后应继续尝试好出口，got %q（reason=%q）", stored, reason)
	}
	t.Cleanup(func() { removeCoverArtifact(t, 95401) })
	if blockHits.Load() != 1 || goodHits.Load() != 1 {
		t.Fatalf("拦截页与好出口应各命中 1 次，got block=%d good=%d", blockHits.Load(), goodHits.Load())
	}
}

// TestCoverFallbackExhaustedPrefersDeterministicReason 全候选失败：存在确定性原因时
// 优先透出（比传输层首因更能定位真因），且后续候选确实被尝试（404 出口命中数=1
// ——旧版在候选 0 即终止，该出口命中数恒 0）。
func TestCoverFallbackExhaustedPrefersDeterministicReason(t *testing.T) {
	bad503, _ := fakeProxyServer(t, http.StatusServiceUnavailable, "text/plain", []byte("no"))
	defer bad503.Close()
	block, _ := fakeProxyServer(t, http.StatusOK, "text/html", []byte("<html>blocked</html>"))
	defer block.Close()
	notFound, nfHits := fakeProxyServer(t, http.StatusNotFound, "image/jpeg", []byte("gone"))
	defer notFound.Close()

	var calls atomic.Int64
	withCoverFallbackProxies(t, &calls, []string{block.URL, notFound.URL})

	stored, reason := fetchCoverWithFallback(95402, "http://203.0.113.99/cover.jpg", bad503.URL, time.Time{})
	if stored != "" {
		t.Fatalf("全候选失败应返回空路径，got %q", stored)
	}
	if reason != "非图像响应: text/html" {
		t.Fatalf("应优先透出首个确定性原因，got %q", reason)
	}
	if nfHits.Load() != 1 {
		t.Fatalf("确定性失败后的候选应继续被尝试，404 出口命中 %d", nfHits.Load())
	}
}

// TestCoverFallbackCandidateCap 候选上限：12 个死代理（环回拒连，传输层失败）+ 第 13 个
// 好代理——好出口零命中（截断保序只丢最末优先级），失败原因保留「代理回退×N 亦失败」
// 计数（全部传输层失败、无确定性原因 → 透出首因+后缀）。
func TestCoverFallbackCandidateCap(t *testing.T) {
	bad503, _ := fakeProxyServer(t, http.StatusServiceUnavailable, "text/plain", []byte("no"))
	defer bad503.Close()
	good, goodHits := fakeProxyServer(t, http.StatusOK, "image/jpeg", tinyJPEGBytes(t))
	defer good.Close()

	cands := make([]string, 0, maxCoverFallbackCandidates+1)
	for i := 0; i < maxCoverFallbackCandidates; i++ {
		cands = append(cands, "http://127.0.0.1:1") // 环回拒连：快速传输层失败
	}
	cands = append(cands, good.URL)

	var calls atomic.Int64
	withCoverFallbackProxies(t, &calls, cands)

	stored, reason := fetchCoverWithFallback(95403, "http://203.0.113.99/cover.jpg", bad503.URL, time.Time{})
	if stored != "" {
		t.Fatalf("候选超限截断后应失败，got %q", stored)
	}
	if goodHits.Load() != 0 {
		t.Fatalf("超限候选（第 13 个）不得被尝试，好出口命中 %d", goodHits.Load())
	}
	if !strings.HasSuffix(reason, "（代理回退×"+itoa(maxCoverFallbackCandidates)+" 亦失败）") {
		t.Fatalf("失败原因应含尝试计数后缀，got %q", reason)
	}
}

// TestFetchAndStoreCoverConcurrentSameNovelTmpSafety 修复②：同 id 并发下载（采集多车道
// 各自触发同一本书的封面下载是真实形态）——8 goroutine 同时 fetchAndStoreCover 同一书：
// 全部成功、终态文件可解码（若并发交错写坏目标则解码必失败）、零遗留 .tmp。
func TestFetchAndStoreCoverConcurrentSameNovelTmpSafety(t *testing.T) {
	srv, _ := fakeProxyServer(t, http.StatusOK, "image/jpeg", tinyJPEGBytes(t))
	defer srv.Close()

	const novelID = 95404
	const lanes = 8
	errs := make([]string, lanes)
	var wg sync.WaitGroup
	for k := 0; k < lanes; k++ {
		wg.Add(1)
		go func(k int) {
			defer wg.Done()
			stored, reason := fetchAndStoreCover(novelID, "http://203.0.113.99/cover.jpg", srv.URL)
			if stored == "" {
				errs[k] = reason
			}
		}(k)
	}
	wg.Wait()
	for k, e := range errs {
		if e != "" {
			t.Fatalf("并发下载 lane %d 失败: %s", k, e)
		}
	}
	t.Cleanup(func() { removeCoverArtifact(t, novelID) })

	// 终态文件必须是合法 JPEG
	f, err := os.Open(filepath.Join(coversDir(), itoa(novelID)+".jpg"))
	if err != nil {
		t.Fatalf("open final cover: %v", err)
	}
	defer f.Close()
	cfg, format, err := image.DecodeConfig(f)
	if err != nil || format != "jpeg" || cfg.Width <= 0 {
		t.Fatalf("终态封面应为合法 JPEG，got format=%q err=%v", format, err)
	}

	// 零遗留 .tmp（本 id 相关）：defer Remove 兜底清理的不变量（rename 成功后 ENOENT 无害）
	entries, err := os.ReadDir(coversDir())
	if err != nil {
		t.Fatalf("readdir covers: %v", err)
	}
	for _, e := range entries {
		if strings.Contains(e.Name(), "-"+itoa(novelID)+"-") && strings.HasSuffix(e.Name(), ".tmp") {
			t.Fatalf("遗留 tmp 未清理: %s", e.Name())
		}
	}
}

// TestRegDomainApproxEdges 边界向量：IP 字面量/单段 host 原样返回（不做截两段），
// 多段取末两段，尾点 FQDN 末段为空串（srcURL 与规则 siteURL 双侧同函数一致，仅用于
// 排序优先级、不用于安全判定——宽松匹配为注释锁定的尽力而为语义）。
func TestRegDomainApproxEdges(t *testing.T) {
	cases := []struct{ in, want string }{
		{"1.2.3.4", "1.2.3.4"}, // v4 字面量
		{"::1", "::1"},         // v6 字面量
		{"img.huangjinwu.org", "huangjinwu.org"},
		{"huangjinwu.org", "huangjinwu.org"},
		{"www.example.com.cn", "com.cn"}, // 多段公共后缀：宽松匹配（尽力而为）
		{"example.com.", "com."},         // 尾点 FQDN：末段空串
		{"myhost", "myhost"},             // 单段 host
	}
	for _, c := range cases {
		if got := regDomainApprox(c.in); got != c.want {
			t.Errorf("regDomainApprox(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
