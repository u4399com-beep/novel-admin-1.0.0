/**
 * adminauth_test.go —— 管理面写保护单测（R135 P0）。
 *
 * 锁定契约：
 *  1. ADMIN_TOKEN 空 = 全放行（自用模式零破坏——GET 与写方法均通过）
 *  2. 启用态：GET 放行 / 写方法无令牌 401 / 错令牌 401
 *  3. 启用态：正确令牌经 X-Admin-Token 头或 ?token= 参数均放行
 *  4. HEAD 放行（dispatch 顶部已转 GET，监控探针语义）
 *  5. 恒时比较（长/短令牌不 panic；错误令牌耗时稳定面由 subtle 保证，此处验证功能等价）
 */
package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func setAdminToken(t *testing.T, tok string) {
	t.Helper()
	old, _ := adminTokenAtomic.Load().(string)
	adminTokenAtomic.Store(tok)
	t.Cleanup(func() { adminTokenAtomic.Store(old) })
}

func doReq(method, path, tokenHeader string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	if tokenHeader != "" {
		req.Header.Set("X-Admin-Token", tokenHeader)
	}
	rec := httptest.NewRecorder()
	blocked := adminWriteBlocked(rec, req)
	if !blocked {
		rec.WriteHeader(200)
	}
	return rec
}

func TestAdminAuthDisabledAllPassR135(t *testing.T) {
	setAdminToken(t, "")
	for _, m := range []string{http.MethodGet, http.MethodPost, http.MethodDelete} {
		if rec := doReq(m, "/api/scrape-tasks", ""); rec.Code != 200 {
			t.Fatalf("关闭态 %s 应放行，got %d", m, rec.Code)
		}
	}
}

func TestAdminAuthWriteBlockedWithoutTokenR135(t *testing.T) {
	setAdminToken(t, "secret-token-1")
	if rec := doReq(http.MethodGet, "/api/home", ""); rec.Code != 200 {
		t.Fatalf("启用态 GET 应放行，got %d", rec.Code)
	}
	if rec := doReq(http.MethodHead, "/api/home", ""); rec.Code != 200 {
		t.Fatalf("启用态 HEAD（探针）应放行，got %d", rec.Code)
	}
	for _, m := range []string{http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete} {
		if rec := doReq(m, "/api/scrape-tasks", ""); rec.Code != 401 {
			t.Fatalf("启用态 %s 无令牌应 401，got %d", m, rec.Code)
		}
	}
}

func TestAdminAuthHeaderAndQueryR135(t *testing.T) {
	setAdminToken(t, "secret-token-1")
	if rec := doReq(http.MethodPost, "/api/scrape-tasks", "secret-token-1"); rec.Code != 200 {
		t.Fatalf("正确头令牌应放行，got %d", rec.Code)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/scrape-tasks?token=secret-token-1", nil)
	rec := httptest.NewRecorder()
	if adminWriteBlocked(rec, req) {
		t.Fatalf("正确 query 令牌应放行")
	}
	req = httptest.NewRequest(http.MethodPost, "/api/scrape-tasks?token=wrong", nil)
	rec = httptest.NewRecorder()
	if !adminWriteBlocked(rec, req) {
		t.Fatalf("错误 query 令牌应拦截")
	}
	if rec := doReq(http.MethodPost, "/api/scrape-tasks", "secret-token-1-longer"); rec.Code != 401 {
		t.Fatalf("不同长度错误令牌应 401，got %d", rec.Code)
	}
}

func TestAdminAuthQueryTokenReadR135(t *testing.T) {
	setAdminToken(t, "tkn")
	req := httptest.NewRequest(http.MethodPost, "/api/settings?token=tkn", nil)
	rec := httptest.NewRecorder()
	if adminWriteBlocked(rec, req) {
		t.Fatalf("query 令牌放行失败")
	}
}
