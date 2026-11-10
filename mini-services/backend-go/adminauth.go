/**
 * adminauth.go —— 管理面写保护（R135 P0 运营整改，operations-readiness §E 第一件）。
 *
 * 背景：全部管理 API（规则/任务/设置/工具）历史零认证，公网部署即任意访客可
 * 增删规则、启停任务、改站点配置。本文件在 dispatch 总入口单点拦截写方法，
 * 公开读 API（页面/搜索/详情）不受影响。
 *
 * 语义：
 *   - ADMIN_TOKEN env 缺省空 = 关闭（自用/内网模式，行为与历史完全一致——
 *     零破坏；沙箱与已有部署不受影响）
 *   - 启用后：所有非 GET/HEAD/OPTIONS 方法（写面）要求请求携带
 *     X-Admin-Token 头（或 ?token= 查询参数，curl 便捷）且与 ADMIN_TOKEN 匹配；
 *     不匹配/缺失 → 401 JSON
 *   - OPTIONS 预检在 dispatch 更早处已放行，不经过本校验（浏览器 CORS 预检
 *     不携带自定义头，属正常链路）
 *   - HEAD 在 dispatch 顶部被改写为 GET 语义，天然放行（监控探针不受影响）
 *   - token 比较用 subtle.ConstantTimeCompare 防时序侧信道
 *
 * 部署：deploy-cn.sh 生成随机 token 写入 env（公网部署默认安全）；
 * 自用模式不设该 env 即维持历史行为。轮换：换 env 值重启 backend。
 */
package main

import (
	"crypto/subtle"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
)

// adminTokenAtomic 启动时解析一次（atomic 存储；运行期不热更——轮换需重启，与文档一致）
var adminTokenAtomic atomic.Value // string

// initAdminToken 启动时读取 ADMIN_TOKEN（main.go 调用）
func initAdminToken() {
	adminTokenAtomic.Store(strings.TrimSpace(os.Getenv("ADMIN_TOKEN")))
}

// adminTokenEnabled 是否启用写保护（token 非空）
func adminTokenEnabled() bool {
	tok, _ := adminTokenAtomic.Load().(string)
	return tok != ""
}

// adminRequestAuthorized 校验请求是否携带合法管理令牌。
// 接受 X-Admin-Token 头或 ?token= 查询参数（二者其一命中即可）。
// 未启用（token 空）恒真——自用模式行为与历史一致。
func adminRequestAuthorized(r *http.Request) bool {
	tok, _ := adminTokenAtomic.Load().(string)
	if tok == "" {
		return true
	}
	got := strings.TrimSpace(r.Header.Get("X-Admin-Token"))
	if got == "" {
		got = strings.TrimSpace(r.URL.Query().Get("token"))
	}
	if got == "" {
		return false
	}
	// ConstantTimeCompare：长度不同立即不等（长度本身不是秘密），
	// 相同长度下恒时比较防逐字节时序枚举
	return subtle.ConstantTimeCompare([]byte(got), []byte(tok)) == 1
}

// adminWriteBlocked dispatch 总入口调用：写方法（非 GET/HEAD/OPTIONS）在启用态
// 校验令牌，未授权直接写 401 并返回 true（调用方直接 return）。
// deny-by-default：管理 API 与未来新增写接口默认安全；公开读接口全为 GET 不受影响。
// R137 豁免：/api/translate —— 读者侧翻译功能（前台无 token，绕行不可得）。豁免前提
// 是该接口自身闭环防滥用面：请求体/段数/字数上限 + per-IP 滑窗限流 + 上游仅内网可达
// + 只写 TranslationCache（无业务数据变更面），见 api_translate.go 头注释。
var adminWriteExempt = map[string]bool{
	"/api/translate": true,
}

func adminWriteBlocked(w http.ResponseWriter, r *http.Request) bool {
	if !adminTokenEnabled() {
		return false
	}
	switch r.Method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return false
	}
	if adminWriteExempt[strings.TrimRight(r.URL.Path, "/")] {
		return false
	}
	if adminRequestAuthorized(r) {
		return false
	}
	writeJSON(w, 401, map[string]string{"error": "未授权", "detail": "写操作需要管理令牌（X-Admin-Token 头或 ?token= 参数）"})
	return true
}
