/**
 * backend-go —— novel-admin 业务后端（Golang 版）路由器。
 *
 * 轻量段匹配路由：pattern 形如 "/api/novels/{id}/chapters"，
 * '{x}' 段捕获任意非空段；静态段优先于参数段（与 Next App Router 语义一致）。
 * 各 api_*.go 文件通过 init() 自注册，main.go 无需感知具体路由。
 */
package main

import (
	"net/http"
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

// dispatch 总入口（main.go 挂到 http.Server）
func dispatch(w http.ResponseWriter, r *http.Request) {
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
