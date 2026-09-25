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

// dispatch 总入口（main.go 挂到 http.Server）
func dispatch(w http.ResponseWriter, r *http.Request) {
        // Task 37 教训回退：Task 36 曾将跨源请求一律 403（Origin vs Host 同源校验），
        // 但沙箱预览链路的中间层会改写 Host（Origin=外部预览域名 vs Host=localhost），
        // 合法同源用户全部被误伤——「站点设置所有功能保存 403」。回退原因：
        // ① 本 API 无 Cookie/无登录凭证，CSRF 无可劫持面，跨源请求能做的事与匿名直连
        //   完全一样，Origin 校验没有实际安全增益；
        // ② 预览链路 Host 形态不可控，任何基于 Host 的严格校验都会再次误伤。
        // 安全边界维持「网关/内网隔离」这一部署拓扑事实，不在应用层复刻。
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
