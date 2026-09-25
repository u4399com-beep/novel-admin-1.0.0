/**
 * web_footer.go —— 前台页脚扩展区块（Task 32-a）：友情链接 + 站群内链轮。
 *
 * 友情链接（footerConfig.friendLinks）：
 *   - 数据形态 [{name,url}]（≤30 条），写入侧清洗在 api_settings.go sanitizeFooterConfig；
 *   - 本文件 gatherFooterFriendLinks 做读取侧防御性复检（历史行/手改库），模板直接
 *     {{range .FriendLinks}} 渲染（各主题 _shared.html 用主题类名排版）；
 *   - renderFriendLinksBlock 为 Go 侧独立渲染器（返回完整 HTML 块），供非模板上下文
 *     （测试/未来后台预览）复用：有友链才渲染，标题「友情链接」，target="_blank"，
 *     rel 不加 nofollow（安全起见带 noopener noreferrer，与既有 footerLinks 一致）。
 *
 * 站群内链轮（.FleetLinks）：
 *   - 语义：站群内每个站点页脚自动互链组内其他 enabled 站点（A→B→C→A 式全互联），
 *     提升站群 SEO 内链覆盖；
 *   - gatherFleetLinks(currentHost)：查询 SiteSite enabled=1 全部站点（id 升序），
 *     排除当前请求 Host（当前站自己永不出现）；默认站点（无 Host/未命中）展示全部
 *     enabled 站点；排除后 ≥1 条才有区块（模板 {{if .FleetLinks}} 判空）；
 *   - 性能：页脚每页渲染都会取用 → 60s 内存缓存（sync.Mutex + 过期时间戳），
 *     站点表是低频写小表（api_sites.go 上限 500 行）；查询故障返回旧缓存/nil，
 *     fail-open（前台永不因链轮层故障 500）。
 */
package main

import (
	"database/sql"
	"html"
	"strings"
	"sync"
	"time"
)

// friendLinks 清洗/渲染上限（footerLinks 复用 api_settings.go 既有常量；友链独立一组）
const (
	footerFriendLinkCount = 30
	footerFriendNameMax   = 20
	footerFriendURLMax    = 300
)

// fleetCacheTTL 站群链轮内存缓存有效期（站点表低频写小表，60s 足够新鲜）
const fleetCacheTTL = 60 * time.Second

// gatherFooterFriendLinks footerConfig.friendLinks → 模板友链数据（[{name,url}]）。
// 写入侧 sanitizeFooterConfig 已白名单清洗；此处对历史行/手改库防御性复检：
// name/url 非空 + url 必须 http(s):// 绝对地址（友链语义=站外互链，与页脚 links
// 允许站内相对路径不同），超限截断，异常项静默跳过（绝不抛错阻塞渲染）。
// 兼容两种形态：JSON 反序列化产物 []any(map[string]any)（DB 读取路径）与
// sanitize 直产 []map[string]string（进程内直传路径）。
func gatherFooterFriendLinks(footerConfig map[string]any) []map[string]string {
	out := []map[string]string{}
	add := func(name, u string) {
		name = truncateRunes(strings.TrimSpace(name), footerFriendNameMax)
		u = truncateRunes(strings.TrimSpace(u), footerFriendURLMax)
		if name == "" || !hrefAbsRe.MatchString(u) {
			return
		}
		out = append(out, map[string]string{"name": name, "url": u})
	}
	switch raw := footerConfig["friendLinks"].(type) {
	case []any:
		for _, item := range raw {
			if len(out) >= footerFriendLinkCount {
				break
			}
			m, ok := item.(map[string]any)
			if !ok {
				continue
			}
			name, _ := m["name"].(string)
			u, _ := m["url"].(string)
			add(name, u)
		}
	case []map[string]string:
		for _, m := range raw {
			if len(out) >= footerFriendLinkCount {
				break
			}
			add(m["name"], m["url"])
		}
	}
	return out
}

// renderFriendLinksBlock Go 侧独立渲染「友情链接」区块（有友链才渲染，零 DOM 痕迹）。
// 前台 10 主题 _shared.html 走 {{range .FriendLinks}} 主题类名渲染；本函数为非模板
// 上下文（Go 测试/未来复用）提供同一数据源的规范化 HTML 输出。
func renderFriendLinksBlock(footerConfig map[string]any) string {
	links := gatherFooterFriendLinks(footerConfig)
	if len(links) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString(`<div class="footer-friend-links"><span class="footer-friend-links-title">友情链接</span>`)
	for _, l := range links {
		b.WriteString(` <a href="` + html.EscapeString(l["url"]) + `" target="_blank" rel="noopener noreferrer">` + html.EscapeString(l["name"]) + `</a>`)
	}
	b.WriteString(`</div>`)
	return b.String()
}

// ---------- 站群内链轮（60s 内存缓存） ----------

var (
	fleetLinksMu     sync.Mutex
	fleetLinksCache  []map[string]string // 全量 enabled 站点 [{host,siteName,url}]（排除自站按请求在 gatherFleetLinks 做，缓存全站共享）
	fleetLinksExpiry time.Time
)

// gatherFleetLinks 站群内链轮数据：全部 enabled 站点（id 升序）排除当前 Host。
// currentHost 为空（默认站点/无 Host）→ 展示全部 enabled 站点。
func gatherFleetLinks(currentHost string) []map[string]string {
	sites := fleetSitesCached()
	out := []map[string]string{}
	for _, s := range sites {
		if currentHost != "" && s["host"] == currentHost {
			continue // 当前站自己永不出现
		}
		out = append(out, s)
	}
	return out
}

// fleetSitesCached 带缓存的 SiteSite enabled 全量查询（60s TTL；查询故障回旧缓存/nil）。
func fleetSitesCached() []map[string]string {
	fleetLinksMu.Lock()
	defer fleetLinksMu.Unlock()
	now := time.Now()
	if fleetLinksCache != nil && now.Before(fleetLinksExpiry) {
		return fleetLinksCache
	}
	sites := []map[string]string{}
	err := queryList(`SELECT "host","siteName" FROM "SiteSite" WHERE "enabled" = 1 ORDER BY "id" ASC`, func(rows *sql.Rows) error {
		var host, siteName string
		if err := rows.Scan(&host, &siteName); err == nil && host != "" {
			sites = append(sites, map[string]string{"host": host, "siteName": siteName, "url": "http://" + host + "/"})
		}
		return nil
	})
	if err != nil {
		// 查询故障：不缓存失败结果（下个请求自动重试），暂回旧缓存（如有）
		return fleetLinksCache
	}
	fleetLinksCache = sites
	fleetLinksExpiry = now.Add(fleetCacheTTL)
	return sites
}
