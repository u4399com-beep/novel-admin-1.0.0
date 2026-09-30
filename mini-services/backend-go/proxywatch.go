/**
 * proxywatch.go —— E18 出口池自愈（Task 59-R12）+ E25 多源延迟感知升级（Task 62-R29）。
 *
 * 用户指令「规则都需要突破，要求都能够稳定长期进行获取」：黑洞站（huangjinwu/xinjianpan）
 * 依赖规则代理池出口，而免费公共代理天然会腐化（Task 58 的出口池在 DB 重建后丢失、
 * 活池也会逐日失效）——池子全灭时 E17「换代理即逃生」也无代理可换，采集断链只能人工重建
 * （R1 已实证一次）。本组件让出口池自愈：
 *
 *   周期（10min）：对每条「enabled 且 proxy 非空」的规则——
 *     1. 并发探测池内每个出口对 rule.siteUrl 的可达性（任何 HTTP 状态=可达，含 403 WAF；
 *        超时/连接失败=死口），并记录响应时延（E25）
 *     2. 有死口 → 拉取免费代理候选（E25：5 路候选源并行，单源失败不致命；超时 15s，
 *        全源失败静默跳过本轮）
 *     3. 并发实测候选（上限 120 个、并发 24），按时延升序取与死口等量的可达者补位
 *        （E25：快口优先——先到先得改为最快先得；候选按规则 id 轮转偏移，避免全部
 *        规则换血后收致同一批口）
 *     4. UPDATE ScrapeRule 仅写 proxy 列（活口保留+新口替换死口；引擎每次抓取现查规则，
 *        Task 58-b 三线索测试锁定无缓存路径 → 换血立即生效）
 *   E25 温和升级（死口=0 时）：池内最慢活口响应超过 proxySlowExitMs 且候选存在
 *     显著更快（< proxyFastCandidateMs）者，每轮至多置换一口——免费口「活着但 10s+」
 *     是代理站吞吐主瓶颈（R27 实测 lastMs 10-33s），渐进换快口不引入池抖动。
 *
 * 治理：
 *   - 单 goroutine 串行遍历规则（单飞，无并发写规则面）；探测并发 24 上限
 *   - 候选去重（池内活口/新批内不重复）；探测 UA=chrome 桌面画像（与抓取语义一致）
 *   - PROXYWATCH_OFF=1 环境变量可停用（部署机自建稳定出口时无需本组件）
 *   - 全程 best-effort：任何失败仅落日志，绝不影响采集主流程
 */
package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	proxyWatchInterval  = 10 * time.Minute
	proxyProbeTimeout   = 8 * time.Second
	proxyProbeParallel  = 24
	proxyCandidateLimit = 120
	// E25 温和升级阈值：活口响应超过 slow 阈值视为「劣化口」，候选低于 fast 阈值才值得置换
	//（置换必须显著更快才有收益，否则徒增池抖动）；每轮至多置换一口
	proxySlowExitMs      = 6000
	proxyFastCandidateMs = 2500
	proxyUpgradeBatchCap = 80
)

// proxySourceURLs E25：候选源多路化（原单源 proxyscrape，R28 审查发现单点依赖——源
// 不可达时整轮无补位，且单源批量小、时延无分选）。前 4 路为纯文本 host:port 行，
// geonode 为 JSON API（带元数据，按 protocols 过滤后取 ip+port）。任一源失败仅少一批
// 候选，不致命（best-effort 与组件总口径一致）。
var proxySourceURLs = []string{
	"https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=8000&country=all&ssl=yes",
	"https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
	"https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
	"https://api.openproxylist.xyz/http.txt",
	"https://proxylist.geonode.com/api/proxy-list?protocols=http%2Chttps&limit=100&page=1&sort_by=responseTime&sort_type=asc",
}

// proxyProbe 单出口探测结果（仅存活者入列）：ms=首个响应字节前耗时（连接+TLS+首响应头）
type proxyProbe struct {
	proxy string
	ms    int64
}

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
// 只有超时/连接失败/重定向环=死口。E25：返回 (可达, 时延ms)——时延为连接+TLS+首响应
// 头耗时，供池内快口分选与温和升级置换（不改变可达性判定口径）。
func probeProxyViaProxy(proxy, targetURL string) (bool, int64) {
	u, err := url.Parse(proxy)
	if err != nil {
		return false, 0
	}
	req, err := http.NewRequest("GET", targetURL, nil)
	if err != nil {
		return false, 0
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
	t0 := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		return false, 0
	}
	defer resp.Body.Close()
	_, _ = io.CopyN(io.Discard, resp.Body, 4096)
	return true, time.Since(t0).Milliseconds()
}

// proxyProbeAll 并发探测：返回存活出口集合（E25：带时延，保池内原有相对顺序——
// 由调用方按需排序，探测层不重排）
func proxyProbeAll(proxies []string, targetURL string) []proxyProbe {
	out := make([]proxyProbe, 0, len(proxies))
	var mu sync.Mutex
	sem := make(chan struct{}, proxyProbeParallel)
	var wg sync.WaitGroup
	for _, p := range proxies {
		wg.Add(1)
		go func(p string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			if ok, ms := probeProxyViaProxy(p, targetURL); ok {
				mu.Lock()
				out = append(out, proxyProbe{proxy: p, ms: ms})
				mu.Unlock()
			}
		}(p)
	}
	wg.Wait()
	return out
}

// proxyProbesSortByMs 按时延升序（快口优先；稳定排序保持同时延的相对序）
func proxyProbesSortByMs(probes []proxyProbe) {
	sort.SliceStable(probes, func(i, j int) bool { return probes[i].ms < probes[j].ms })
}

// rotateBy E25：候选按 offset 轮转（规则 id 偏移），避免多条规则同时换血时全部探到
// 同一批候选头部的同质化（先到先得语义下尤其明显）
func rotateBy(list []string, offset int) []string {
	n := len(list)
	if n == 0 || offset == 0 {
		return list
	}
	k := offset % n
	if k < 0 {
		k += n
	}
	return append(list[k:], list[:k]...)
}

// fetchProxyCandidates 拉取免费代理候选（E25：proxySourceURLs 全源并行，文本行源逐行
// isHostPort 校验，geonode 走 JSON；跨源去重后 scheme 归一 http://）。单源失败静默跳过
// （best-effort）；全源失败返回 nil（调用方跳过本轮）。总量上限 400（探测批量 120 的
// 充分供给，轮转偏移后仍有足量分选余地）。
func fetchProxyCandidates() []string {
	type result struct {
		lines []string
	}
	results := make(chan result, len(proxySourceURLs))
	var wg sync.WaitGroup
	for _, src := range proxySourceURLs {
		wg.Add(1)
		go func(src string) {
			defer wg.Done()
			results <- result{lines: fetchProxySourceLines(src)}
		}(src)
	}
	go func() { wg.Wait(); close(results) }()
	seen := map[string]bool{}
	out := make([]string, 0, 128)
	for r := range results {
		for _, line := range r.lines {
			if seen[line] {
				continue
			}
			seen[line] = true
			out = append(out, "http://"+line)
			if len(out) >= 400 {
				return out
			}
		}
	}
	return out
}

// fetchProxySourceLines 单源拉取与行解析：文本源逐行校验；geonode JSON 源取
// data[].ip+data[].port。任何形态异常（非 2xx/超时/解析败）返回 nil。
func fetchProxySourceLines(src string) []string {
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Get(src)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	buf := make([]byte, 0, 64*1024)
	tmp := make([]byte, 4096)
	for {
		n, err := resp.Body.Read(tmp)
		buf = append(buf, tmp[:n]...)
		if n == 0 || err != nil || len(buf) > 4*1024*1024 {
			break
		}
	}
	body := string(buf)
	out := make([]string, 0, 64)
	if strings.Contains(src, "proxylist.geonode.com") {
		// geonode JSON：{"data":[{"ip":"..","port":"..","protocols":["http",..]},..]}
		var parsed struct {
			Data []struct {
				IP        string   `json:"ip"`
				Port      any      `json:"port"` // 数字或字符串形态均有，走 any 归一
				Protocols []string `json:"protocols"`
			} `json:"data"`
		}
		if json.Unmarshal([]byte(body), &parsed) != nil {
			return nil
		}
		for _, d := range parsed.Data {
			port := fmt.Sprintf("%v", d.Port)
			hp := d.IP + ":" + port
			if d.IP == "" || !isHostPort(hp) {
				continue
			}
			httpOK := false
			for _, pr := range d.Protocols {
				if pr == "http" || pr == "https" {
					httpOK = true
					break
				}
			}
			if !httpOK && len(d.Protocols) > 0 {
				continue
			}
			out = append(out, hp)
		}
		return out
	}
	for _, line := range strings.Split(body, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || !strings.Contains(line, ":") || !isHostPort(line) {
			continue
		}
		out = append(out, line)
		if len(out) >= 400 {
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

// refreshRuleProxyPool 单规则出口池自愈一轮。返回是否发生池变更。
// E25 语义：死口替换（快口优先+规则轮转）为主路径；死口=0 时走温和升级（最慢劣化口
// 置换为显著更快候选，每轮至多一口）。
func refreshRuleProxyPool(ruleID int64, name, siteURL, pool string) bool {
	proxies := splitNonEmpty(pool, ",")
	if len(proxies) == 0 {
		return false
	}
	aliveProbes := proxyProbeAll(proxies, siteURL)
	aliveN := len(aliveProbes)
	deadN := len(proxies) - aliveN
	if deadN == 0 {
		return upgradeRuleProxyPool(ruleID, name, siteURL, aliveProbes)
	}
	log.Printf("[proxy-watch] 规则 #%d《%s》出口池 %d/%d 死口，拉取候选补位", ruleID, truncateRunes(name, 20), deadN, len(proxies))

	candidates := fetchProxyCandidates()
	if len(candidates) == 0 {
		log.Printf("[proxy-watch] 规则 #%d 候选源不可用，本轮跳过（保留活口池）", ruleID)
		// 活口仍在：至少把死口剔除，防引擎在死口上空烧预算
		if aliveN > 0 {
			updateRuleProxyField(ruleID, strings.Join(probeProxies(aliveProbes), ","))
		}
		return aliveN > 0
	}

	seen := map[string]bool{}
	for _, pr := range aliveProbes {
		seen[pr.proxy] = true
	}
	// E25：候选轮转偏移（规则 id）→ 探测批量截断 → 探测 → 快口优先补位
	candidates = rotateBy(candidates, int(ruleID))
	if len(candidates) > proxyCandidateLimit {
		candidates = candidates[:proxyCandidateLimit]
	}
	fresh := proxyProbeAll(candidates, siteURL)
	proxyProbesSortByMs(fresh) // 快口优先（E25：先到先得→最快先得）
	added := make([]string, 0, deadN)
	for _, pr := range fresh {
		if seen[pr.proxy] {
			continue
		}
		seen[pr.proxy] = true
		added = append(added, pr.proxy)
		if len(added) >= deadN {
			break
		}
	}
	aliveList := probeProxies(aliveProbes)
	if len(added) == 0 {
		log.Printf("[proxy-watch] 规则 #%d 候选均不可达，仅剔除死口（剩 %d 活口）", ruleID, aliveN)
		if aliveN > 0 {
			updateRuleProxyField(ruleID, strings.Join(aliveList, ","))
		}
		return aliveN > 0
	}
	merged := append(append([]string{}, aliveList...), added...)
	updateRuleProxyField(ruleID, strings.Join(merged, ","))
	log.Printf("[proxy-watch] 规则 #%d《%s》出口池换血：剔除 %d 死口，补位 %d 新口，池共 %d 口",
		ruleID, truncateRunes(name, 20), deadN, len(added), len(merged))
	return true
}

// upgradeRuleProxyPool E25 温和升级：死口=0 且池内最慢活口超过 proxySlowExitMs 时，
// 探测候选（轮转偏移+批量截断），存在 < proxyFastCandidateMs 的池外快口则置换掉最慢
// 一口（每轮至多一口，渐进无抖动）。无合格快口/无候选返回 false（池不变）。
func upgradeRuleProxyPool(ruleID int64, name, siteURL string, aliveProbes []proxyProbe) bool {
	if len(aliveProbes) == 0 {
		return false
	}
	slowest := aliveProbes[0]
	for _, pr := range aliveProbes[1:] {
		if pr.ms > slowest.ms {
			slowest = pr
		}
	}
	if slowest.ms <= proxySlowExitMs {
		return false // 池内无劣化口，无需升级
	}
	candidates := fetchProxyCandidates()
	if len(candidates) == 0 {
		return false
	}
	candidates = rotateBy(candidates, int(ruleID)+7) // +7 与补位路径错开候选窗
	if len(candidates) > proxyUpgradeBatchCap {
		candidates = candidates[:proxyUpgradeBatchCap]
	}
	seen := map[string]bool{}
	for _, pr := range aliveProbes {
		seen[pr.proxy] = true
	}
	fresh := proxyProbeAll(candidates, siteURL)
	proxyProbesSortByMs(fresh)
	for _, pr := range fresh {
		if seen[pr.proxy] || pr.ms >= proxyFastCandidateMs {
			continue
		}
		merged := make([]string, 0, len(aliveProbes))
		for _, ap := range aliveProbes {
			if ap.proxy != slowest.proxy {
				merged = append(merged, ap.proxy)
			}
		}
		merged = append(merged, pr.proxy)
		updateRuleProxyField(ruleID, strings.Join(merged, ","))
		log.Printf("[proxy-watch] 规则 #%d《%s》温和升级：劣化口 %dms 置换为 %dms 快口，池共 %d 口",
			ruleID, truncateRunes(name, 20), slowest.ms, pr.ms, len(merged))
		return true
	}
	return false
}

// probeProbes 探测结果抽取出口列表（保序）
func probeProxies(probes []proxyProbe) []string {
	out := make([]string, 0, len(probes))
	for _, pr := range probes {
		out = append(out, pr.proxy)
	}
	return out
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
