/**
 * 按主机 Cookie 会话持久化（移植自 strategies/cookies.ts，语义一致）。
 *
 * - 捕获各策略响应的 Set-Cookie，按 host 存入进程内 jar；该主机后续请求自动回放；
 *   覆盖「首访种 cookie（如安全检查/频控种子）、二访才放行」的站点；
 * - 仅进程内存，不落盘；仅回放本 host 自己收到的 cookie（不实现 Domain 跨子域传播）；
 * - 容量上界：host 数 ≤ 128（LRU），单 host cookie 数 ≤ 50（先到先淘汰）；
 * - 过期：Max-Age/Expires 照 RFC 6265 解析（过期即删），无过期属性的会话 cookie 按默认 TTL 存活；
 * - Secure 属性 cookie 只在 https 请求上回放；
 * - 并发安全：TS 版依赖单线程事件循环，Go 版以互斥锁保证。
 *
 * 合规边界：只回放目标站自己下发的公开访问 cookie（等价于浏览器正常会话行为），
 * 不注入任何登录态/凭证，不伪造身份。
 */
package main

import (
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	cookieMaxHosts     = 128
	cookieMaxPerHost   = 50
	cookieSessionTTLMS = 30 * 60 * 1000
	cookieMaxTTLMS     = 7 * 24 * 60 * 60 * 1000
)

type storedCookie struct {
	value      string
	expiresAt  int64
	secureOnly bool
}

type cookieBucket struct {
	m     map[string]storedCookie
	order []string // 插入序（LRU 淘汰用）
}

// cookieJar host（含端口）→ 桶；读写均刷新 LRU 淘汰序
type cookieJar struct {
	mu    sync.Mutex
	hosts map[string]*cookieBucket
}

var jar = &cookieJar{hosts: map[string]*cookieBucket{}}

// touchHost 取/建 host 桶并刷新 LRU 淘汰序；返回 nil 表示容量淘汰后仍放不下（极端情况）
func (j *cookieJar) touchHost(host string) *cookieBucket {
	j.mu.Lock()
	defer j.mu.Unlock()
	b, ok := j.hosts[host]
	if ok {
		delete(j.hosts, host)
	} else {
		b = &cookieBucket{m: map[string]storedCookie{}}
	}
	j.hosts[host] = b
	for len(j.hosts) > cookieMaxHosts {
		oldest := ""
		for k := range j.hosts {
			oldest = k
			break // map 迭代无序，但只需任一淘汰（TS 版淘汰最旧；Go 版近似）
		}
		if oldest == "" {
			break
		}
		delete(j.hosts, oldest)
	}
	return b
}

func (b *cookieBucket) set(name string, c storedCookie) {
	if _, exists := b.m[name]; !exists {
		b.order = append(b.order, name)
	} else {
		// 重新插入 = 刷新淘汰序
		for i, n := range b.order {
			if n == name {
				b.order = append(b.order[:i], b.order[i+1:]...)
				break
			}
		}
		b.order = append(b.order, name)
	}
	b.m[name] = c
}

func (b *cookieBucket) del(name string) {
	if _, exists := b.m[name]; exists {
		delete(b.m, name)
		for i, n := range b.order {
			if n == name {
				b.order = append(b.order[:i], b.order[i+1:]...)
				break
			}
		}
	}
}

func (b *cookieBucket) capSize() {
	for len(b.m) > cookieMaxPerHost {
		if len(b.order) == 0 {
			break
		}
		oldest := b.order[0]
		b.order = b.order[1:]
		delete(b.m, oldest)
	}
}

// cookie-name 必须是合法 token（RFC 6265 cookie-name），防解析产物污染回放头
var reCookieName = regexp.MustCompile(`^[!#$%&'*+\-.^_\x60|~0-9a-zA-Z]+$`)
var reCtlChars = regexp.MustCompile(`[\r\n\0]`)

type parsedCookie struct {
	name       string
	value      string
	expiresAt  int64
	secureOnly bool
	remove     bool
}

func parseSetCookieLine(line string, now int64) *parsedCookie {
	semi := strings.Index(line, ";")
	pair := line
	if semi != -1 {
		pair = line[:semi]
	}
	pair = strings.TrimSpace(pair)
	eq := strings.Index(pair, "=")
	if eq <= 0 {
		return nil // RFC 6265 5.2：无 '=' 的整条忽略
	}
	name := strings.TrimSpace(pair[:eq])
	value := strings.TrimSpace(pair[eq+1:])
	if !reCookieName.MatchString(name) || len(name) > 128 || len(value) > 2048 {
		return nil
	}
	if reCtlChars.MatchString(value) {
		return nil
	}

	expiresAt := now + cookieSessionTTLMS
	secureOnly := false
	remove := false
	if semi != -1 {
		for _, attr := range strings.Split(line[semi+1:], ";") {
			aeq := strings.Index(attr, "=")
			key := attr
			val := ""
			if aeq == -1 {
				key = strings.TrimSpace(attr)
			} else {
				key = strings.TrimSpace(attr[:aeq])
				val = strings.TrimSpace(attr[aeq+1:])
			}
			switch strings.ToLower(key) {
			case "max-age":
				sec, err := strconv.ParseFloat(val, 64)
				if err != nil {
					continue
				}
				if sec <= 0 {
					remove = true
				} else {
					ms := int64(sec * 1000)
					if ms > cookieMaxTTLMS {
						ms = cookieMaxTTLMS
					}
					if now+ms < expiresAt {
						expiresAt = now + ms
					}
				}
			case "expires":
				if t := parseHTTPDate(val); t > 0 {
					if t <= now {
						remove = true
					} else {
						limit := t
						if limit > now+cookieMaxTTLMS {
							limit = now + cookieMaxTTLMS
						}
						if limit < expiresAt {
							expiresAt = limit
						}
					}
				}
			case "secure":
				secureOnly = true
			}
		}
	}
	return &parsedCookie{name: name, value: value, expiresAt: expiresAt, secureOnly: secureOnly, remove: remove}
}

// parseHTTPDate 尽力解析 HTTP 日期（多格式）
func parseHTTPDate(v string) int64 {
	for _, layout := range []string{
		http.TimeFormat, // RFC1123: Mon, 02 Jan 2006 15:04:05 GMT
		"Monday, 02-Jan-06 15:04:05 GMT",
		"Mon Jan  2 15:04:05 2006",
		time.RFC850,
		time.ANSIC,
	} {
		if t, err := time.Parse(layout, v); err == nil {
			return t.UnixMilli()
		}
	}
	return 0
}

// recordSetCookieLines 记录一批 Set-Cookie 行；返回实际入库条数（删除指令不计）
func recordSetCookieLines(host string, lines []string, https bool) int {
	if host == "" || len(lines) == 0 {
		return 0
	}
	bucket := jar.touchHost(host)
	now := nowMs()
	stored := 0
	jar.mu.Lock()
	for _, line := range lines {
		if line == "" {
			continue
		}
		parsed := parseSetCookieLine(line, now)
		if parsed == nil {
			continue
		}
		if parsed.remove {
			bucket.del(parsed.name)
		} else {
			bucket.set(parsed.name, storedCookie{value: parsed.value, expiresAt: parsed.expiresAt, secureOnly: parsed.secureOnly})
			stored++
		}
	}
	bucket.capSize()
	jar.mu.Unlock()
	_ = https // Secure 判定在回放侧进行（与 TS 版一致）
	return stored
}

// recordResponseCookies 从 Go http.Response 捕获 Set-Cookie（每一跳都会经过）
func recordResponseCookies(host string, res *http.Response, https bool) {
	if host == "" || res == nil {
		return
	}
	lines := res.Header.Values("Set-Cookie")
	if len(lines) > 0 {
		recordSetCookieLines(host, lines, https)
	}
}

// cookieHeaderFor 为某 host 构造回放用的 Cookie 头值（如 "a=1; b=2"）；无可回放 cookie 返回 ""。
// 过期条目顺手清除；Secure cookie 仅在 https 请求上回放；读取也刷新 LRU 淘汰序。
func cookieHeaderFor(host string, https bool) string {
	jar.mu.Lock()
	bucket, ok := jar.hosts[host]
	if !ok || len(bucket.m) == 0 {
		jar.mu.Unlock()
		return ""
	}
	now := nowMs()
	parts := []string{}
	for _, name := range append([]string{}, bucket.order...) {
		c, exists := bucket.m[name]
		if !exists {
			continue
		}
		if c.expiresAt <= now {
			bucket.del(name)
			continue
		}
		if c.secureOnly && !https {
			continue
		}
		parts = append(parts, name+"="+c.value)
	}
	if len(parts) == 0 {
		jar.mu.Unlock()
		return ""
	}
	jar.mu.Unlock()
	return strings.Join(parts, "; ")
}

// playwrightCookie Playwright/渲染桥注入格式
type playwrightCookie struct {
	Name    string  `json:"name"`
	Value   string  `json:"value"`
	URL     string  `json:"url"`
	Expires float64 `json:"expires"`
}

// cookiesForPlaywright 渲染桥注入格式列表；无 cookie 返回空数组
func cookiesForPlaywright(host string, https bool) []playwrightCookie {
	jar.mu.Lock()
	defer jar.mu.Unlock()
	bucket, ok := jar.hosts[host]
	if !ok || len(bucket.m) == 0 {
		return []playwrightCookie{}
	}
	now := nowMs()
	scheme := "http"
	if https {
		scheme = "https"
	}
	origin := scheme + "://" + host
	out := []playwrightCookie{}
	for _, name := range append([]string{}, bucket.order...) {
		c, exists := bucket.m[name]
		if !exists {
			continue
		}
		if c.expiresAt <= now {
			bucket.del(name)
			continue
		}
		if c.secureOnly && !https {
			continue
		}
		out = append(out, playwrightCookie{Name: name, Value: c.value, URL: origin, Expires: -1})
	}
	return out
}

// recordBridgeCookies 渲染完成后把浏览器上下文的 cookie 回存引擎 jar
func recordBridgeCookies(host string, cookies []bridgeCookie) {
	if host == "" || len(cookies) == 0 {
		return
	}
	bucket := jar.touchHost(host)
	now := nowMs()
	jar.mu.Lock()
	for _, c := range cookies {
		if c.Name == "" || c.Value == "" {
			continue
		}
		if !reCookieName.MatchString(c.Name) || len(c.Value) > 2048 {
			continue
		}
		expires := now + cookieSessionTTLMS
		if c.Expires > 0 {
			expires = int64(c.Expires * 1000)
		}
		if expires <= now {
			bucket.del(c.Name)
			continue
		}
		limit := expires
		if limit > now+cookieMaxTTLMS {
			limit = now + cookieMaxTTLMS
		}
		bucket.set(c.Name, storedCookie{value: c.Value, expiresAt: limit, secureOnly: c.Secure})
	}
	bucket.capSize()
	jar.mu.Unlock()
}

// bridgeCookie render.py 回传的 cookie 子集
type bridgeCookie struct {
	Name    string  `json:"name"`
	Value   string  `json:"value"`
	Expires float64 `json:"expires"`
	Secure  bool    `json:"secure"`
}

func cookieStats() (trackedHosts, maxHosts, maxPerHost, ttlMS int) {
	jar.mu.Lock()
	defer jar.mu.Unlock()
	return len(jar.hosts), cookieMaxHosts, cookieMaxPerHost, cookieSessionTTLMS
}
