/**
 * backend-go —— 健康检查（骨架自检路由；业务 handlers 由 Task 18-a 在 api_*.go 中实现）。
 */
package main

import (
	"net/http"
	"time"
)

func init() {
	register("GET", "/api/health", handleHealth)
}

// handleHealth GET /api/health —— 进程/DB 存活探测
func handleHealth(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	_, dbErr := getDB()
	writeJSON(w, 200, map[string]any{
		"ok":       dbErr == nil,
		"service":  "backend-go",
		"version":  "1.0.0",
		"runtime":  "go1.22",
		"db":       dbPath(),
		"dbOk":     dbErr == nil,
		"time":     time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
	})
}
