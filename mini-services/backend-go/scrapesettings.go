/**
 * scrapesettings.go —— R97 采集全局设置：
 *
 * 1. 全局代理池（SiteSetting.proxyPool）：规则「无自有 proxy」时的兜底出口集合（逗号分隔，
 *    支持 http/https/socks5/socks5h/socks4 与 user:pass@host:port 凭证形态，复用规则级
 *    parseProxyField 校验）。注入点在 loadRule 装载端——规则有自有池用自有池，无池且全局
 *    池非空则兜底全局池；全站所有抓取路径（书页/列表页/目录页/章节页/探活）自动生效。
 *    引擎每次抓取现查请求体 proxy（无缓存路径，Task 58-b），故池子改动 ≤10s 内生效。
 *    proxywatch 出口池自愈只管「规则级 proxy」的免费池换血，不动全局池（全局池语义=
 *    用户自管的付费/凭证出口，自动换血会毁掉凭证口）。
 *
 * 2. TXT/封面自定义存储目录（SiteSetting.txtDir/coversDir）：绝对路径，空=默认
 *    （{repoRoot}/download/novels 与 {repoRoot}/public/covers）。读取侧 10s TTL 缓存
 *    （每章写盘都查目录，不能每章一次 SQL；保存端主动失效，改动即时生效无需重启）。
 *    注意：改目录只影响之后的写盘；已落盘文件不迁移（读路径按同一条配置链回读，
 *    改目录后历史 txt 模式书需自行迁移文件或改回）。
 *
 * 3. POST /api/scrape/proxy-pool/test：连通性实测——对全局池（或请求体自带 pool 串）逐口
 *    经代理探测 target（默认 https://www.baidu.com/，任何 HTTP 状态=可达；407=死口），
 *    返回逐口 ok/ms/状态摘要，供 admin 面板「测试连通性」按钮与运维排障。探测实现复用
 *    proxywatch.go 的 probeProxyViaProxy（同口径：407 判死、其余状态可达）。
 */
package main

import (
	"database/sql"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// settingsCacheTTL 设置缓存有效期（全局池/存储目录共用）
const settingsCacheTTL = 10 * time.Second

// scraperSettingsCache 通用 TTL 缓存（单键多槽：proxyPool/txtDir/coversDir 各一槽）
type scraperSettingsCache struct {
	mu      sync.Mutex
	value   string
	expires time.Time
	loaded  bool
}

func (c *scraperSettingsCache) get(load func() string) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.loaded && time.Now().Before(c.expires) {
		return c.value
	}
	v := load()
	c.value = v
	c.expires = time.Now().Add(settingsCacheTTL)
	c.loaded = true
	return v
}

func (c *scraperSettingsCache) invalidate() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.loaded = false
	c.value = ""
	c.expires = time.Time{}
}

var (
	proxyPoolCache  scraperSettingsCache
	txtDirCache     scraperSettingsCache
	coversDirCache  scraperSettingsCache
	settingsInvMu   sync.Mutex
	settingsInvalid = false
)

// invalidateScraperSettings 保存端失效钩子（api_settings.go PATCH 成功后调用）；
// loaded=false 后下次 get 重新查库。另设 10s TTL 兜底防漏钩路径。
func invalidateScraperSettings() {
	proxyPoolCache.invalidate()
	txtDirCache.invalidate()
	coversDirCache.invalidate()
}

// loadSettingColumn 单列读取（SiteSetting id=1 不存在/列缺失/查询失败 → ""）。
// 列缺失场景：ensureColumn 加列失败的旧库——设置不可用，回落默认路径，与加列失败语义一致。
// ⚠ R97 死锁门闩：getDB 的 sync.Once boot 回调内会间接触发本函数（backfillBrokenCoverLocal
// → coversDir → storageCoversDirOverride），boot 未完成时 queryOne→getDB 递归自锁
// （Task 30 P1 同款，panic dump 实证）——故 dbReady=false（boot 进行中）一律返回 ""，
// boot 链回落默认目录，启动完成后设置读取恢复正常。
func loadSettingColumn(column string) string {
	if !dbReady.Load() {
		return ""
	}
	var v sql.NullString
	if err := queryOne(`SELECT "`+column+`" FROM "SiteSetting" WHERE "id" = 1`, []any{&v}); err != nil {
		return ""
	}
	return strings.TrimSpace(v.String)
}

// globalProxyPool 全局代理池（已 TrimSpace；空=未配置）。parseProxyField 校验在保存端，
// 读取端信任库内值（loadRule 下发前仅整体 Trim，引擎侧 parseProxy 逐口容错）。
func globalProxyPool() string {
	return proxyPoolCache.get(func() string { return loadSettingColumn("proxyPool") })
}

// storageTxtDirOverride TXT 目录自定义值（空=未配置，用默认链）
func storageTxtDirOverride() string {
	return txtDirCache.get(func() string { return loadSettingColumn("txtDir") })
}

// storageCoversDirOverride 封面目录自定义值（空=未配置，用默认链）
func storageCoversDirOverride() string {
	return coversDirCache.get(func() string { return loadSettingColumn("coversDir") })
}

// ==================== POST /api/scrape/proxy-pool/test ====================

func init() {
	register("POST", "/api/scrape/proxy-pool/test", handleProxyPoolTest)
}

// proxyTestResult 单口探测结果行（凭证脱敏输出）
type proxyTestResult struct {
	Proxy string `json:"proxy"`
	OK    bool   `json:"ok"`
	Ms    int64  `json:"ms"`
	Error string `json:"error"`
}

// maskProxyCred 输出脱敏：URL 携带 user:pass 时隐去凭证（***@），避免明文回显到浏览器。
// 解析失败原样返回（保存端 parseProxyField 已挡住非法形态）。代理 URL 无 path 语义，
// 输出归一为 scheme://***@host:port（url.User("***") 会被 String() 百分号转义为 %2A，
// 故手工重写 userinfo 段）。
func maskProxyCred(p string) string {
	u, err := url.Parse(p)
	if err != nil || u.User == nil || u.User.String() == "" || u.Host == "" {
		return p
	}
	return u.Scheme + "://***@" + u.Host
}

// proxyPoolTestMax 单次探测口数上限（免费池手填超长串防误触发数百口并发探测）
const proxyPoolTestMax = 60

// proxyPoolTestParallel 探测并发
const proxyPoolTestParallel = 12

// handleProxyPoolTest POST /api/scrape/proxy-pool/test
// body: { "pool"?: "http://...,socks5://u:p@h:p", "target"?: "https://..." }
// pool 缺省用全局池；target 缺省 https://www.baidu.com/（探测语义：经代理拿到任何 HTTP
// 响应=出口可达，407=代理认证死口——与 proxywatch probeProxyViaProxy 同口径）。
func handleProxyPoolTest(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	v, ok := readBodyValue(r)
	if !ok {
		writeJSON(w, 400, map[string]string{"error": "请求体不是合法 JSON"})
		return
	}
	body := bodyMap(v)
	poolStr := strings.TrimSpace(bodyString(body["pool"]))
	if poolStr == "" {
		poolStr = globalProxyPool()
	}
	if poolStr == "" {
		writeJSON(w, 200, map[string]any{"target": "", "results": []proxyTestResult{}, "message": "全局代理池为空，且请求未携带 pool"})
		return
	}
	target := strings.TrimSpace(bodyString(body["target"]))
	if target == "" {
		target = "https://www.baidu.com/"
	}
	// target 形态粗校验（仅 http/https 绝对地址；防 SSRF 把内网地址当探测目标——探测本身
	// 经代理发起，但仍不给任意内网 target 打探结）
	if !strings.HasPrefix(target, "http://") && !strings.HasPrefix(target, "https://") {
		failJSON(w, "参数错误", "target 仅支持 http/https 绝对地址", 400)
		return
	}

	pool := splitNonEmpty(poolStr, ",")
	if len(pool) > proxyPoolTestMax {
		pool = pool[:proxyPoolTestMax]
	}
	results := probeProxyPoolConcurrent(pool, target)

	alive := 0
	for _, rr := range results {
		if rr.OK {
			alive++
		}
	}
	writeJSON(w, 200, map[string]any{
		"target":  target,
		"total":   len(results),
		"alive":   alive,
		"results": results,
	})
}

// bodyString any → 非空 string（非字符串形态返回 ""）
func bodyString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

// probeProxyPoolConcurrent 并发探测代理池（并发 proxyPoolTestParallel，单口超时 8s 复用
// proxywatch 探测常量）。结果按入参顺序返回（探测乱序完成，互斥锁保护按位回填）。
func probeProxyPoolConcurrent(pool []string, target string) []proxyTestResult {
	results := make([]proxyTestResult, len(pool))
	var mu sync.Mutex
	sem := make(chan struct{}, proxyPoolTestParallel)
	var wg sync.WaitGroup
	for i, p := range pool {
		wg.Add(1)
		go func(i int, p string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			ok, ms := probeProxyViaProxy(p, target)
			res := proxyTestResult{Proxy: maskProxyCred(p), OK: ok, Ms: ms}
			if !ok {
				res.Error = "不可达/超时/代理认证拒绝（407）"
			}
			mu.Lock()
			results[i] = res
			mu.Unlock()
		}(i, p)
	}
	wg.Wait()
	return results
}
