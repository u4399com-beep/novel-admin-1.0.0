package main

/**
 * Task 53 审计测试：规则级静态 cookie 底座（seedRuleCookies + fetchPage 接线）。
 *
 * 背景：kelexs/cunshu 等 GoEdge WAF 站对沙箱出口 IP 全域强制人机验证（curl/JA3/代理 307
 * 验证码、headless 浏览器 403）。合规路径是用户人工过验后把会话 cookie 提供给规则，
 * 引擎每次抓取前种入 host 会话桶（同名覆盖/幂等重种/Set-Cookie 接管）——本文件锁定：
 *   1. 解析与入库语义（k=v 对；非法名/超长/控制字符拒绝）；
 *   2. 同名覆盖语义（人工会话优先于引擎自收）；
 *   3. 幂等重种与 TTL（种子 cookie 带未来过期时间，回放头可见）；
 *   4. 回放联动（seed 后 cookieHeaderFor/cookiesForPlaywright 可见）；
 *   5. 空 host/空 header 零副作用；
 *   6. 并发安全（-race 下多 goroutine 同时 seed 无数据竞争）；
 *   7. GoEdge fixture 挑战判定（强特征任意体积 + 正常页零误杀对照）；
 *   8. Task 53-a 审计修复锁定：Set-Cookie 属性段误粘贴防御 +
 *      fetchPage 接线序（SSRF 后/熔断前种入，n==0 显式告警）。
 */

import (
	"strings"
	"sync"
	"testing"
)

func TestSeedRuleCookiesParsesPairsAndRejectsJunk(t *testing.T) {
	host := "seed-parse.test"
	defer jarRemoveHostForTest(host)

	jar.mu.Lock()
	delete(jar.hosts, host)
	jar.mu.Unlock()

	n := seedRuleCookies(host, "GOEDGE_WAF_CAPTCHA=abc123; __jsluid=xyz; bad; =empty; ok=; Ctl=a\r\nb")
	if n != 3 {
		t.Fatalf("期望 3 条合法 cookie 入库（bad/=empty/Ctl 被拒），实际 %d", n)
	}
	got := cookieHeaderFor(host, true)
	for _, want := range []string{"GOEDGE_WAF_CAPTCHA=abc123", "__jsluid=xyz", "ok="} {
		if !strings.Contains(got, want) {
			t.Fatalf("回放头缺 %q：%q", want, got)
		}
	}
	if strings.Contains(got, "Ctl=") {
		t.Fatalf("控制字符值被拒绝入库但仍回放：%q", got)
	}
}

func TestSeedRuleCookiesOverridesSameName(t *testing.T) {
	host := "seed-override.test"
	defer jarRemoveHostForTest(host)

	jar.mu.Lock()
	delete(jar.hosts, host)
	jar.mu.Unlock()

	// 引擎自收（挑战页种下的无效会话）
	recordSetCookieLines(host, []string{"session=stale-from-challenge"}, true)
	// 人工过验种子覆盖同名
	if n := seedRuleCookies(host, "session=fresh-human"); n != 1 {
		t.Fatalf("期望 1 条，实际 %d", n)
	}
	if got := cookieHeaderFor(host, true); got != "session=fresh-human" {
		t.Fatalf("同名种子应覆盖既有值，实际 %q", got)
	}
	// 站点后续 Set-Cookie 照常接管（浏览器语义）
	recordSetCookieLines(host, []string{"session=rotated-by-site; Max-Age=3600"}, true)
	if got := cookieHeaderFor(host, true); got != "session=rotated-by-site" {
		t.Fatalf("站点 Set-Cookie 应接管种子，实际 %q", got)
	}
}

func TestSeedRuleCookiesIdempotentReseedAfterExpiry(t *testing.T) {
	host := "seed-reseed.test"
	defer jarRemoveHostForTest(host)

	jar.mu.Lock()
	delete(jar.hosts, host)
	jar.mu.Unlock()

	if n := seedRuleCookies(host, "waf=pass"); n != 1 {
		t.Fatalf("首次种入失败 n=%d", n)
	}
	// 模拟到期：把过期时间拨回过去
	jar.mu.Lock()
	bucket := jar.hosts[host]
	c := bucket.m["waf"]
	c.expiresAt = nowMs() - 1
	bucket.m["waf"] = c
	jar.mu.Unlock()
	// cookieHeaderFor 读时顺手清除过期条目
	if got := cookieHeaderFor(host, true); got != "" {
		t.Fatalf("过期条目应被清除，实际 %q", got)
	}
	// 幂等重种（下一轮 fetchPage 的行为）→ 恢复可见
	if n := seedRuleCookies(host, "waf=pass"); n != 1 {
		t.Fatalf("重种失败 n=%d", n)
	}
	if got := cookieHeaderFor(host, true); got != "waf=pass" {
		t.Fatalf("重种后应恢复回放，实际 %q", got)
	}
	// 种子 TTL 应为 6h（> 30min 会话 TTL）
	jar.mu.Lock()
	expiresAt := jar.hosts[host].m["waf"].expiresAt
	jar.mu.Unlock()
	ttl := expiresAt - nowMs()
	if ttl < 5*60*60*1000 || ttl > ruleCookieSeedTTLMS {
		t.Fatalf("种子 TTL 应≈6h，实际 %dms", ttl)
	}
}

func TestSeedRuleCookiesVisibleToPlaywrightBridge(t *testing.T) {
	host := "seed-pw.test"
	defer jarRemoveHostForTest(host)

	jar.mu.Lock()
	delete(jar.hosts, host)
	jar.mu.Unlock()

	seedRuleCookies(host, "human=verified")
	cjs := cookiesForPlaywright(host, true)
	if len(cjs) != 1 || cjs[0].Name != "human" || cjs[0].Value != "verified" {
		t.Fatalf("browser 渲染桥应看到种子 cookie，实际 %+v", cjs)
	}
}

func TestSeedRuleCookiesEmptyArgsNoop(t *testing.T) {
	if n := seedRuleCookies("", "a=b"); n != 0 {
		t.Fatalf("空 host 应零入库，实际 %d", n)
	}
	if n := seedRuleCookies("noop.test", ""); n != 0 {
		t.Fatalf("空 header 应零入库，实际 %d", n)
	}
	jar.mu.Lock()
	_, exists := jar.hosts["noop.test"]
	jar.mu.Unlock()
	if exists {
		t.Fatalf("空参数不应创建 host 桶")
	}
}

func TestSeedRuleCookiesConcurrentSafe(t *testing.T) {
	host := "seed-race.test"
	defer jarRemoveHostForTest(host)

	jar.mu.Lock()
	delete(jar.hosts, host)
	jar.mu.Unlock()

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			seedRuleCookies(host, "k1=v1; k2=v2")
			_ = cookieHeaderFor(host, true)
		}()
	}
	wg.Wait()
	if got := cookieHeaderFor(host, true); !strings.Contains(got, "k1=v1") {
		t.Fatalf("并发种入后回放头异常：%q", got)
	}
}

// goEdgeCaptchaFixture Task 53: GoEdge WAF 人机验证页 fixture（kelexs.com /list-1/ 实测 307 跳转
// 后的 CAPTCHA 页原文骨架，2026-09 抓取；2531 字节，表单 token GOEDGE_WAF_CAPTCHA_ID/CODE +
// 验证码图 + Verify Yourself 文案）。
const goEdgeCaptchaFixture = `<!DOCTYPE html>
<html lang="en-US">
<head>
        <title>Verify Yourself</title>
        <script type="text/javascript">
        var isValidated=!1;window.addEventListener("pageshow",function(){isValidated&&window.location.reload()});
        </script>
</head>
<body><form method="POST" id="captcha-form">
        <input type="hidden" name="GOEDGE_WAF_CAPTCHA_ID" value="6ddb718e3637f3ee"/>
        <div class="ui-image">
                <p id="ui-captcha-image-prompt">loading ...</p>
                <img id="ui-captcha-image" src="/WAF/VERIFY/CAPTCHA?info=VBWI%2F0oCr&amp;GOEDGE_WAF_CAPTCHA_ID=6ddb718e3637f3ee" alt=""/>
        </div>
        <div class="ui-input">
                <p class="ui-prompt">Input verify code above:</p>
                <input type="text" name="GOEDGE_WAF_CAPTCHA_CODE" size="10" maxlength="6" autocomplete="off" class="input" placeholder=""/>
        </div>
        <div class="ui-button">
                <button type="submit" style="line-height:24px;margin-top:10px">Verify Yourself</button>
        </div>
</form>
<address>Request ID: 179051854600941000032</address>

</body>
</html>`

func TestLooksLikeChallengeGoEdgeWAF(t *testing.T) {
	// 强特征 token 任意体积判定：即使未来 GoEdge 页面膨胀超 3KB 也不漏判
	if !looksLikeChallenge([]byte(goEdgeCaptchaFixture)) {
		t.Fatal("GoEdge WAF 验证页应判为挑战页（GOEDGE_WAF_CAPTCHA 强特征）")
	}
	// 膨胀形态：页尾追加大量空白使其超 3KB，强特征仍应命中
	padded := goEdgeCaptchaFixture + strings.Repeat("\n<!-- padding -->", 400)
	if len(padded) < 3072 {
		t.Fatalf("fixture 膨胀后应超 3KB，实际 %d", len(padded))
	}
	if !looksLikeChallenge([]byte(padded)) {
		t.Fatal("超 3KB 的 GoEdge 验证页仍应判为挑战页（强特征不受体积守卫限制）")
	}
	// 对照：正常书页含「GOEDGE」字样但无完整 token 不误杀（token 前缀完整性）
	normal := []byte("<html><h1>第1章 试炼</h1><p>他谈起曾经的往事，GOEDGE 这个词在书中出现过。</p></html><p>" + strings.Repeat("正文内容。", 200) + "</p>")
	if looksLikeChallenge(normal) {
		t.Fatal("含普通文本的正常章节页不应误判")
	}
}

// TestSeedRuleCookiesSkipsSetCookieAttributePairs Task 53-a 修复①：
// 用户误粘贴 Set-Cookie 响应头整行（而非浏览器复制的 Cookie 头）时，属性段
// （Path=/; Max-Age=86400; Domain=…; SameSite=…）不得被当 cookie 种入并回放——
// 否则回放头被垃圾对污染（Cookie: session=abc; Path=/; Max-Age=86400），
// GoEdge 类 WAF 异常检测可识别并再次触发挑战，破坏本特性要维系的会话。
func TestSeedRuleCookiesSkipsSetCookieAttributePairs(t *testing.T) {
	host := "seed-attr.test"
	defer jarRemoveHostForTest(host)

	jar.mu.Lock()
	delete(jar.hosts, host)
	jar.mu.Unlock()

	n := seedRuleCookies(host, "session=abc123; Path=/; Max-Age=86400; Domain=.example.com; SameSite=Lax; Priority=High; HttpOnly; Secure")
	if n != 1 {
		t.Fatalf("仅首个 k=v 对应入库（属性段全跳过），实际 %d", n)
	}
	if got := cookieHeaderFor(host, false); got != "session=abc123" {
		t.Fatalf("回放头不应含属性垃圾对，实际 %q", got)
	}
	// 大小写不敏感：Set-Cookie 属性名大小写形态不一（path/PATH/Path 均有站点在用）
	n2 := seedRuleCookies(host, "session=abc123; PATH=/; max-age=86400")
	if n2 != 1 {
		t.Fatalf("属性名大小写变体应被跳过，实际入库 %d 条", n2)
	}
	if got := cookieHeaderFor(host, false); got != "session=abc123" {
		t.Fatalf("大小写变体属性污染回放头，实际 %q", got)
	}
}

// TestFetchPageSeedsRuleCookiesBeforeCircuitBreaker Task 53-a 修复②+接线序锁定：
// fetchPage 对 opts.ruleCookies 的接线必须落在 SSRF 校验之后（非法目标不种）、
// 熔断检查之前（人工放行语义：配置了 cookie 即明确预期可通，历史连败熔断不阻断重试）。
// 零网络路径：TEST-NET-3 IP 字面量（SSRF 文本层判公网、免 DNS）+ 预热熔断触发早退，
// 早退点在 seedRuleCookies 之后、robots/真实请求之前——jar 可见性 + warnings 生成均可断言。
func TestFetchPageSeedsRuleCookiesBeforeCircuitBreaker(t *testing.T) {
	host := "203.0.113.53" // TEST-NET-3（51-b 同口径：零外网依赖）
	defer jarRemoveHostForTest(host)

	for i := 0; i < 3; i++ {
		noteChainFailure(host, false) // 3 次混合连败 → 熔断（普通阈值）
	}
	if hostCircuitOpenMs(host) <= 0 {
		t.Fatal("预热熔断失败（3 次连败应触发）")
	}

	res := fetchPage("http://"+host+"/", fetchPageOptions{ruleCookies: "wire=ok123"})
	if res.ok || !strings.Contains(res.err, "熔断") {
		t.Fatalf("熔断主机应结构化早退（不进真实策略链），实际 ok=%v err=%q", res.ok, res.err)
	}
	if got := cookieHeaderFor(host, false); got != "wire=ok123" {
		t.Fatalf("规则 cookie 应在熔断检查前种入 host 桶，实际 %q", got)
	}
	sawInject := false
	for _, w := range res.warnings {
		if strings.Contains(w, "[rule-cookies] 已注入 1 条") {
			sawInject = true
		}
	}
	if !sawInject {
		t.Fatalf("种入成功应附 warnings 证据，实际 %v", res.warnings)
	}

	// n==0 分支：头非空但全部被拒（空片段+属性段）→ 显式告警而非静默零注入
	res2 := fetchPage("http://"+host+"/", fetchPageOptions{ruleCookies: ";;;Path=/"})
	if res2.ok || !strings.Contains(res2.err, "熔断") {
		t.Fatalf("第二次调用应同样熔断早退，实际 ok=%v err=%q", res2.ok, res2.err)
	}
	sawZero := false
	for _, w := range res2.warnings {
		if strings.Contains(w, "[rule-cookies] 规则 cookie 头未解析出任何合法条目") {
			sawZero = true
		}
	}
	if !sawZero {
		t.Fatalf("0 条入库应显式告警（静默无效配置=排障黑洞），实际 %v", res2.warnings)
	}
}

// jarRemoveHostForTest 清理测试 host 桶（并发测试隔离用）
func jarRemoveHostForTest(host string) {
	jar.mu.Lock()
	defer jar.mu.Unlock()
	delete(jar.hosts, host)
	for i, n := range jar.order {
		if n == host {
			jar.order = append(jar.order[:i], jar.order[i+1:]...)
			break
		}
	}
}
