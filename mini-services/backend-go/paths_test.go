/**
 * paths_test.go —— 部署路径自适应解析的回归测试（R90 国内一键部署配套）。
 *
 * 覆盖面：
 * - inferRepoRootFromExe：标准布局命中 / 无 mini-services 结构拒绝 / 文件系统根保护
 * - inferWebRootFromExe：bin 同级 web/ 命中 / 缺失拒绝
 * - repoRoot()/resolveWebRoot()：沙箱内确定性返回（与旧硬编码等价语义）
 * - dbPath()/txtNovelsRoot()：env 覆盖优先（回归旧测试契约）
 *
 * mock 布局用 t.TempDir() 搭建，不依赖真实部署路径。
 */
package main

import (
	"os"
	"path/filepath"
	"testing"
)

// mockRepoLayout 搭建标准生产布局：{root}/mini-services/backend-go/{backend-go.bin,web}
func mockRepoLayout(t *testing.T, withWeb bool) (root, exe string) {
	t.Helper()
	root = t.TempDir()
	dir := filepath.Join(root, "mini-services", "backend-go")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir mock layout: %v", err)
	}
	exe = filepath.Join(dir, "backend-go.bin")
	if err := os.WriteFile(exe, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatalf("write mock bin: %v", err)
	}
	if withWeb {
		webDir := filepath.Join(dir, "web")
		if err := os.MkdirAll(webDir, 0o755); err != nil {
			t.Fatalf("mkdir mock web: %v", err)
		}
	}
	return root, exe
}

func TestInferRepoRootFromExe_StandardLayout(t *testing.T) {
	root, exe := mockRepoLayout(t, true)
	if got := inferRepoRootFromExe(exe); got != root {
		t.Fatalf("inferRepoRootFromExe(%s) = %q, want %q", exe, got, root)
	}
}

func TestInferRepoRootFromExe_NoMiniServicesStructure(t *testing.T) {
	// exe 在任意目录，上级无 mini-services/ → 拒绝（go test 二进制形态）
	dir := t.TempDir()
	exe := filepath.Join(dir, "backend-go.test")
	if err := os.WriteFile(exe, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := inferRepoRootFromExe(exe); got != "" {
		t.Fatalf("inferRepoRootFromExe(%s) = %q, want empty", exe, got)
	}
}

func TestInferRepoRootFromExe_FilesystemRootGuard(t *testing.T) {
	// 目录深度不足 3 级 → 必须返回空（不越界、不误判）
	if got := inferRepoRootFromExe("/backend-go.bin"); got != "" {
		t.Fatalf("shallow path should be rejected, got %q", got)
	}
	if got := inferRepoRootFromExe(""); got != "" {
		t.Fatalf("empty exe should be rejected, got %q", got)
	}
}

func TestInferWebRootFromExe(t *testing.T) {
	_, exe := mockRepoLayout(t, true)
	want := filepath.Join(filepath.Dir(exe), "web")
	if got := inferWebRootFromExe(exe); got != want {
		t.Fatalf("inferWebRootFromExe = %q, want %q", got, want)
	}

	// 无 web/ 子目录 → 拒绝
	_, exe2 := mockRepoLayout(t, false)
	if got := inferWebRootFromExe(exe2); got != "" {
		t.Fatalf("missing web/ should be rejected, got %q", got)
	}
	if got := inferWebRootFromExe(""); got != "" {
		t.Fatalf("empty exe should be rejected, got %q", got)
	}
}

// TestRepoRootAndWebRoot_SandboxSemantics 沙箱/测试环境下全局解析函数必须确定性
// 返回可用值（repoRoot 恒非空；resolveWebRoot 恒非空且 templatesRoot 存在——
// web 渲染测试依赖该兜底值读取真实模板目录）。
func TestRepoRootAndWebRoot_SandboxSemantics(t *testing.T) {
	if repoRoot() == "" {
		t.Fatal("repoRoot() must never be empty")
	}
	if webRoot == "" {
		t.Fatal("webRoot (package var) must never be empty")
	}
	if st, err := os.Stat(templatesRoot); err != nil || !st.IsDir() {
		t.Fatalf("templatesRoot %q must be an existing dir in sandbox: %v", templatesRoot, err)
	}
}

// TestDBPathEnvOverride dbPath 的 env 优先契约（旧测试依赖形态回归）。
func TestDBPathEnvOverride(t *testing.T) {
	t.Setenv("DB_PATH", "/tmp/paths-test-custom.db")
	if got := dbPath(); got != "/tmp/paths-test-custom.db" {
		t.Fatalf("dbPath with env = %q, want override", got)
	}
}

// TestTxtNovelsRootEnvOverride txtNovelsRoot 的 env 优先契约（旧测试依赖形态回归）。
func TestTxtNovelsRootEnvOverride(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TXT_ROOT", dir)
	if got := txtNovelsRoot(); got != dir {
		t.Fatalf("txtNovelsRoot with env = %q, want override %q", got, dir)
	}
}
