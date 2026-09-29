/**
 * proxywatch.go —— E18 出口池自愈（Task 59-R12）。
 *
 * 用户指令「规则都需要突破，要求都能够稳定长期进行获取」：黑洞站（huangjinwu/xinjianpan）
 * 依赖规则代理池出口，而免费公共代理天然会腐化（Task 58 的出口池在 DB 重建后丢失、
 * 活池也会逐日失效）——池子全灭时 E17「换代理即逃生」也无代理可换，采集断链只能人工重建
 * （R1 已实证一次）。本组件让出口池自愈：
 *
 *   周期（10min）：对每条「enabled 且 proxy 非空」的规则——
 *     1. 并发探测池内每个出口对 rule.siteUrl 的可达性（任何 HTTP 状态=可达，含 403 WAF；
 *        超时/连接失败=死口）
 *     2. 有死口 → 拉取免费代理候选（proxyscrape，超时 20s，失败静默跳过本轮）
 *     3. 并发实测候选（上限 40 个、并发 16），取与死口等量的可达者补位（先到先得）
 *     4. UPDATE ScrapeRule 仅写 proxy 列（活口保留+新口替换死口；引擎每次抓取现查规则，
 *        Task 58-b 三线索测试锁定无缓存路径 → 换血立即生效）
 *
 * 治理：
 *   - 单 goroutine 串行遍历规则（单飞，无并发写规则面）；探测并发 16 上限
 *   - 候选去重（池内活口/新批内不重复）；探测 UA=chrome 桌面画像（与抓取语义一致）
 *   - PROXYWATCH_OFF=1 环境变量可停用（部署机自建稳定出口时无需本组件）
 *   - 全程 best-effort：任何失败仅落日志，绝不影响采集主流程
 */
package main

import (
	"database/sql"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	proxyWatchInterval  = 10 * time.Minute
	proxyProbeTimeout   = 8 * time.Second
	proxyProbeParallel  = 16
	proxyCandidateLimit = 40
	proxySourceURL      = "https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=8000&country=all&ssl=yes"
)

// proxyWatchHTTPClient 探测专用客户端（与抓取链隔离，超时显式）
var proxyWatchHTTPClient = &http.Client{
	Timeout: proxyProbeTimeout,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 3 {
			return fmt.Errorf("too many redirects")
		}
		return nil
	},
}

// probeProxyViaProxy 单出口可达性探测：经 proxy 访问 targetURL，任何 HTTP 状态（含
// 403/503 等 WAF 响应）均视为「出口可达」——WAF 拦截是站点行为，出口链路是通的；
// 只有超时/连接失败/重定向环=死口。返回 (可达, 状态码或错误短描)。
func probeProxyViaProxy(proxy, targetURL string) bool {
	u, err := url.Parse(proxy)
	if err != nil {
		return false
	}
	req, err := http.NewRequest("GET", targetURL, nil)
	if err != nil {
		return false
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "text/html,application/xhtml+xml,*/*;q=0.8")
	transport := &http.Transport{
		Proxy: http.ProxyURL(u),
	}
	client := &http.Client{
		Timeout:       proxyProbeTimeout,
		Transport:     transport,
		CheckRedirect: proxyWatchHTTPClient.CheckRedirect,
	}
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	_, _ = io.CopyN(io.Discard, resp.Body, 4096)
	return true
}

// proxyProbeAll 并发探测：返回可达出口集合（保序）
func proxyProbeAll(proxies []string, targetURL string) []string {
	out := make([]string, 0, len(proxies))
	var mu sync.Mutex
	sem := make(chan struct{}, proxyProbeParallel)
	var wg sync.WaitGroup
	for _, p := range proxies {
		wg.Add(1)
		go func(p string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			if probeProxyViaProxy(p, targetURL) {
				mu.Lock()
				out = append(out, p)
				mu.Unlock()
			}
		}(p)
	}
	wg.Wait()
	return out
}

// fetchProxyCandidates 拉取免费代理候选（纯文本 host:port 行，带 scheme 归一）
func fetchProxyCandidates() []string {
	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Get(proxySourceURL)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	buf := make([]byte, 0, 64*1024)
	tmp := make([]byte, 4096)
	for {
		n, err := resp.Body.Read(tmp)
		buf = append(buf, tmp[:n]...)
		if n == 0 || err != nil || len(buf) > 512*1024 {
			break
		}
	}
	out := make([]string, 0, 64)
	for _, line := range strings.Split(string(buf), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || !strings.Contains(line, ":") || !isHostPort(line) {
			continue
		}
		out = append(out, "http://"+line)
		if len(out) >= 200 {
			break
		}
	}
	return out
}

// isHostPort host:port 形态粗校验（1-3 段域名或 IPv4 + 端口 1-65535）
func isHostPort(s string) bool {
	i := strings.LastIndex(s, ":")
	if i <= 0 || i == len(s)-1 {
		return false
	}
	port := s[i+1:]
	if len(port) > 5 {
		return false
	}
	n := 0
	for _, c := range port {
		if c < '0' || c > '9' {
			return false
		}
		n = n*10 + int(c-'0')
	}
	if n < 1 || n > 65535 {
		return false
	}
	host := s[:i]
	return host != "" && !strings.ContainsAny(host, " \t/@")
}

// refreshRuleProxyPool 单规则出口池自愈一轮。返回是否发生换血。
func refreshRuleProxyPool(ruleID int64, name, siteURL, pool string) bool {
	proxies := splitNonEmpty(pool, ",")
	if len(proxies) == 0 {
		return false
	}
	alive := proxyProbeAll(proxies, siteURL)
	deadN := len(proxies) - len(alive)
	if deadN == 0 {
		return false
	}
	log.Printf("[proxy-watch] 规则 #%d《%s》出口池 %d/%d 死口，拉取候选补位", ruleID, truncateRunes(name, 20), deadN, len(proxies))

	candidates := fetchProxyCandidates()
	if len(candidates) == 0 {
		log.Printf("[proxy-watch] 规则 #%d 候选源不可用，本轮跳过（保留活口池）", ruleID)
		// 活口仍在：至少把死口剔除，防引擎在死口上空烧预算
		if len(alive) > 0 {
			updateRuleProxyField(ruleID, strings.Join(alive, ","))
		}
		return len(alive) > 0
	}

	seen := map[string]bool{}
	for _, p := range alive {
		seen[p] = true
	}
	// 候选截断 + 探测
	if len(candidates) > proxyCandidateLimit {
		candidates = candidates[:proxyCandidateLimit]
	}
	fresh := proxyProbeAll(candidates, siteURL)
	added := make([]string, 0, deadN)
	for _, p := range fresh {
		if seen[p] {
			continue
		}
		seen[p] = true
		added = append(added, p)
		if len(added) >= deadN {
			break
		}
	}
	if len(added) == 0 {
		log.Printf("[proxy-watch] 规则 #%d 候选均不可达，仅剔除死口（剩 %d 活口）", ruleID, len(alive))
		if len(alive) > 0 {
			updateRuleProxyField(ruleID, strings.Join(alive, ","))
		}
		return len(alive) > 0
	}
	merged := append(append([]string{}, alive...), added...)
	updateRuleProxyField(ruleID, strings.Join(merged, ","))
	log.Printf("[proxy-watch] 规则 #%d《%s》出口池换血：剔除 %d 死口，补位 %d 新口，池共 %d 口",
		ruleID, truncateRunes(name, 20), deadN, len(added), len(merged))
	return true
}

// updateRuleProxyField 仅写 proxy 列（不动其余字段；引擎无缓存路径，即时生效）
func updateRuleProxyField(ruleID int64, proxy string) {
	_, _ = execRetry(`UPDATE "ScrapeRule" SET "proxy" = ?, "updatedAt" = ? WHERE "id" = ?`,
		proxy, nowMillis(), ruleID)
}

// startProxyWatch 自愈循环（BACKEND_MODE=all 的 runner 侧 go 调用；PROXYWATCH_OFF=1 停用）
func startProxyWatch() {
	if envOff("PROXYWATCH_OFF") {
		log.Printf("[proxy-watch] PROXYWATCH_OFF=1，出口池自愈停用")
		return
	}
	go func() {
		// 启动先等一个周期再首跑（服务刚起时采集热路径优先）
		time.Sleep(proxyWatchInterval)
		for {
			proxyWatchOnce()
			time.Sleep(proxyWatchInterval)
		}
	}()
}

// proxyWatchOnce 单轮：遍历 enabled 且带代理池的规则逐条自愈
func proxyWatchOnce() {
	type row struct {
		id      int64
		name    string
		siteURL string
		proxy   string
	}
	rows := make([]row, 0, 8)
	if err := queryList(`SELECT "id","name","siteUrl","proxy" FROM "ScrapeRule" WHERE "enabled" = 1 AND "proxy" != '' ORDER BY "id" ASC`,
		func(rs *sql.Rows) error {
			var r row
			if err := rs.Scan(&r.id, &r.name, &r.siteURL, &r.proxy); err != nil {
				return err
			}
			rows = append(rows, r)
			return nil
		}); err != nil {
		return
	}
	for _, r := range rows {
		target := r.siteURL
		if target == "" {
			continue
		}
		refreshRuleProxyPool(r.id, r.name, target, r.proxy)
	}
}

// envOff 环境变量停用开关（"1"/"true"/"yes" 大小写不敏感）
func envOff(key string) bool {
	v := strings.ToLower(os.Getenv(key))
	return v == "1" || v == "true" || v == "yes"
}

// splitNonEmpty 逗号切分去空
func splitNonEmpty(s, sep string) []string {
	out := make([]string, 0, 8)
	for _, p := range strings.Split(s, sep) {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}
