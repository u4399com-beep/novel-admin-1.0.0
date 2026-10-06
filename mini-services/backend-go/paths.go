/**
 * paths.go —— 部署路径自适应解析（任意路径 git clone 一键部署的地基）。
 *
 * 背景：沙箱期多处硬编码 /home/z/my-project（db/txtdir/coversx/web/runner），
 * 项目 clone 到其他路径（如国内服务器 /opt/novel-admin）时全部失联。
 * 本文件提供统一解析链：环境变量 > 可执行文件位置推断 > 沙箱默认兜底。
 *
 * 推断原理：生产布局固定为
 *   {repo}/mini-services/backend-go/backend-go.bin   ← os.Executable()
 *   {repo}/mini-services/scraper-go/scraper-go.bin
 * 故 repo 根 = executable 上 2 级。校验条件：该目录下存在 mini-services/ 子目录
 * （真实 repo 恒真；go test 临时二进制在 /tmp 恒假 → 自动回退沙箱默认，
 * 测试路径行为与旧版完全一致，零回归）。
 *
 * 解析链优先级（以 DB 为例，其余同构）：
 *   1. DB_PATH env（显式覆盖，测试隔离用）
 *   2. {repoRoot}/db/custom.db（可执行文件位置推断 —— 任意部署路径自适应）
 *   3. 沙箱默认（repoRoot() 推断失败时的兜底值）
 * 沙箱内 2 与 3 推出同一路径，行为完全等价。
 */
package main

import (
	"os"
	"path/filepath"
	"sync"
)

// sandboxProjectRoot 历史沙箱布局的项目根（兜底默认值）。
const sandboxProjectRoot = "/home/z/my-project"

var (
	repoRootOnce sync.Once
	repoRootPath string
)

// inferRepoRootFromExe 从可执行文件路径推断项目根（上 2 级且存在 mini-services/
// 子目录结构）。布局不符返回 ""（调用方回退兜底）。抽成纯函数便于单测覆盖。
func inferRepoRootFromExe(exe string) string {
	if exe == "" {
		return ""
	}
	dir := filepath.Dir(exe)
	// bin 目录 → backend-go → mini-services → repo 根（2 次 parent）
	for i := 0; i < 2; i++ {
		parent := filepath.Dir(dir)
		if parent == dir {
			return "" // 已到文件系统根，布局不符
		}
		dir = parent
	}
	if st, err := os.Stat(filepath.Join(dir, "mini-services")); err == nil && st.IsDir() {
		return dir
	}
	return ""
}

// repoRoot 项目根（进程内缓存）：可执行文件位置推断，失败回退沙箱默认。
func repoRoot() string {
	repoRootOnce.Do(func() {
		repoRootPath = sandboxProjectRoot
		exe, err := os.Executable()
		if err != nil {
			return
		}
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			exe = resolved
		}
		if r := inferRepoRootFromExe(exe); r != "" {
			repoRootPath = r
		}
	})
	return repoRootPath
}

// inferWebRootFromExe 从可执行文件路径推断 web 资源根（backend-go.bin 与 web/
// 同级，即 {binDir}/web 存在才采用）。不符返回 ""。纯函数便于单测。
func inferWebRootFromExe(exe string) string {
	if exe == "" {
		return ""
	}
	cand := filepath.Join(filepath.Dir(exe), "web")
	if st, err := os.Stat(cand); err == nil && st.IsDir() {
		return cand
	}
	return ""
}

// resolveWebRoot web 资源根解析链：WEB_ROOT env > 可执行文件同级 web > 沙箱默认
// （go test 时临时二进制同级无 web/，走沙箱默认 = 旧 const 值，测试零回归）。
func resolveWebRoot() string {
	if p := os.Getenv("WEB_ROOT"); p != "" {
		return p
	}
	if exe, err := os.Executable(); err == nil {
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			exe = resolved
		}
		if w := inferWebRootFromExe(exe); w != "" {
			return w
		}
	}
	return filepath.Join(sandboxProjectRoot, "mini-services", "backend-go", "web")
}
