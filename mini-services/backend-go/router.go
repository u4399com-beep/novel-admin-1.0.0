/**
 * backend-go —— novel-admin 业务后端（Golang 版）路由器。
 *
 * 轻量段匹配路由：pattern 形如 "/api/novels/{id}/chapters"，
 * '{x}' 段捕获任意非空段；静态段优先于参数段（与 Next App Router 语义一致）。
 * 各 api_*.go 文件通过 init() 自注册，main.go 无需感知具体路由。
 */
package main

import (
	"crypto/subtle"
	"log"
	"net/http"
	"os"
	"runtime/debug"
	"strings"
)

// routeEntry 单条路由
type routeEntry struct {
	method  string
	segs    []string
	handler func(w http.ResponseWriter, r *http.Request, ps map[string]string)
}

var routes []routeEntry

// register 路由自注册入口（api_*.go 的 init() 调用）
func register(method, pattern string, handler func(w http.ResponseWriter, r *http.Request, ps map[string]string)) {
	routes = append(routes, routeEntry{
		method:  strings.ToUpper(method),
		segs:    splitPath(pattern),
		handler: handler,
	})
}

// ---------- 前缀路由（web.go 页面层：静态资源/封面等无段语义路径） ----------

// prefixRoute 前缀匹配路由：request path 以 prefix 开头即命中（method 需一致）
type prefixRoute struct {
	method  string
	prefix  string
	handler http.HandlerFunc
}

var prefixRoutes []prefixRoute

// registerPrefix 前缀路由自注册（web.go 的 init() 调用）；优先级高于段路由（dispatch 顶部先查）
func registerPrefix(method, prefix string, handler http.HandlerFunc) {
	prefixRoutes = append(prefixRoutes, prefixRoute{
		method:  strings.ToUpper(method),
		prefix:  prefix,
		handler: handler,
	})
}

// matchPrefix 遍历前缀路由表；命中返回 true（已写响应）
func matchPrefix(w http.ResponseWriter, r *http.Request) bool {
	for i := range prefixRoutes {
		pr := &prefixRoutes[i]
		if pr.method == strings.ToUpper(r.Method) && strings.HasPrefix(r.URL.Path, pr.prefix) {
			pr.handler(w, r)
			return true
		}
	}
	return false
}

func splitPath(p string) []string {
	p = strings.Trim(p, "/")
	if p == "" {
		return nil
	}
	return strings.Split(p, "/")
}

// matchRoute 匹配一个请求路径；返回参数表与是否命中
func matchRoute(segs []string, pattern []string) (map[string]string, bool) {
	if len(segs) != len(pattern) {
		return nil, false
	}
	ps := map[string]string{}
	for i, pseg := range pattern {
		if strings.HasPrefix(pseg, "{") && strings.HasSuffix(pseg, "}") {
			if segs[i] == "" {
				return nil, false
			}
			ps[pseg[1:len(pseg)-1]] = segs[i]
			continue
		}
		if pseg != segs[i] {
			return nil, false
		}
	}
	return ps, true
}

// routeHasParam pattern 是否含参数段
func routeHasParam(segs []string) bool {
	for _, s := range segs {
		if strings.HasPrefix(s, "{") {
			return true
		}
	}
	return false
}

// adminToken 管理鉴权令牌（Task 25-b：env ADMIN_TOKEN，默认空=关闭鉴权保持历史行为）。
// 每次读 env（无锁、成本可忽略），令牌在进程生命周期内通常不变。
func adminToken() string {
	return strings.TrimSpace(os.Getenv("ADMIN_TOKEN"))
}

// adminTokenMatch 恒时比较（防时序侧信道）
func adminTokenMatch(a, b string) bool {
	return len(a) > 0 && subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// adminAuthOK Task 25-b 可选管理鉴权：ADMIN_TOKEN 非空时启用，覆盖——
//
//	① GET /admin 管理页（支持 ?token=xxx 登录一次种 HttpOnly cookie，后续请求免参；
//	   admin.js 的同源 fetch 默认携带 cookie，因此无需改动前端即可生效）
//	② /api/* 非 GET/HEAD/OPTIONS 的写操作（POST/PUT/PATCH/DELETE）
//
// 凭据通道：X-Admin-Token 头 / Authorization: Bearer / ?token= / cookie admin_token。
// 未授权：API 返回 401 JSON；页面返回 401 简页。默认令牌为空时完全旁路（兼容现状）。
func adminAuthOK(w http.ResponseWriter, r *http.Request) bool {
	tok := adminToken()
	if tok == "" {
		return true
	}
	path := r.URL.Path
	isAdminPage := path == "/admin"
	m := strings.ToUpper(r.Method)
	isMutatingAPI := strings.HasPrefix(path, "/api/") && m != http.MethodGet && m != http.MethodHead && m != http.MethodOptions
	if !isAdminPage && !isMutatingAPI {
		return true
	}
	if adminTokenMatch(r.Header.Get("X-Admin-Token"), tok) {
		return true
	}
	if adminTokenMatch(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), tok) && strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
		return true
	}
	if adminTokenMatch(r.URL.Query().Get("token"), tok) {
		// 页面登录：种 cookie，后续同源请求（含 admin.js fetch）自动携带
		if isAdminPage {
			http.SetCookie(w, &http.Cookie{
				Name: "admin_token", Value: tok, Path: "/", HttpOnly: true,
				SameSite: http.SameSiteLaxMode, MaxAge: 12 * 3600,
			})
		}
		return true
	}
	if c, err := r.Cookie("admin_token"); err == nil && adminTokenMatch(c.Value, tok) {
		return true
	}
	return false
}

// dispatch 总入口（main.go 挂到 http.Server）
func dispatch(w http.ResponseWriter, r *http.Request) {
	// Task 25-b：统一 panic recover——默认 net/http 的连接级 recover 只会掐断连接
	// （客户端拿到 connection reset，无任何错误响应）；这里兜成 500 响应 + 带栈日志，
	// 且防「已写出部分响应后 panic 时二次 WriteHeader」的异常外溢。
	defer func() {
		if rec := recover(); rec != nil {
			log.Printf("[panic] %s %s: %v\n%s", r.Method, r.URL.Path, rec, debug.Stack())
			defer func() { _ = recover() }()
			writeJSON(w, 500, map[string]string{"error": "服务器内部错误", "detail": "panic recovered"})
		}
	}()
	// 前缀路由优先（静态资源 /static/ /covers/ 等，无段匹配语义）
	if matchPrefix(w, r) {
		return
	}
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "content-type")
		w.WriteHeader(204)
		return
	}
	path := strings.TrimRight(r.URL.Path, "/")
	segs := splitPath(path)
	method := strings.ToUpper(r.Method)

	// Task 25-b：可选管理鉴权（ADMIN_TOKEN 非空时启用；见 adminAuthOK 注释）。
	// 注意放在 OPTIONS 分支之后——浏览器预检请求不携带自定义凭据，拦截预检会破坏 CORS。
	if !adminAuthOK(w, r) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			writeJSON(w, 401, map[string]string{"error": "未授权"})
		} else {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(401)
			_, _ = w.Write([]byte("<!doctype html><meta charset=utf-8><title>401</title>" +
				"<p style='padding:40px;text-align:center;color:#666'>未授权：请以 /admin?token=你的令牌 访问。</p>"))
		}
		return
	}

	// 静态段优先于参数段（与 Next App Router 一致）
	var paramHit *routeEntry
	var paramPS map[string]string
	for i := range routes {
		rt := &routes[i]
		ps, ok := matchRoute(segs, rt.segs)
		if !ok {
			continue
		}
		if !routeHasParam(rt.segs) {
			if rt.method == method {
				rt.handler(w, r, ps)
				return
			}
			continue
		}
		if paramHit == nil && rt.method == method {
			paramHit = rt
			paramPS = ps
		}
	}
	if paramHit != nil {
		paramHit.handler(w, r, paramPS)
		return
	}

	// 405：路径命中但方法不符
	for i := range routes {
		rt := &routes[i]
		if _, ok := matchRoute(segs, rt.segs); ok && rt.method != method {
			writeJSON(w, 405, map[string]string{"error": "方法不允许", "detail": method + " 不支持该路径"})
			return
		}
	}
	writeJSON(w, 404, map[string]string{"error": "Not Found", "detail": path})
}
