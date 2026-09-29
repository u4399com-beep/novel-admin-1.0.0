/**
 * txtdir_test.go —— Task 33-b 回归锁定（TXT 分章文件存储面）：
 * 1) writeChapterTxt tmp+rename 原子落盘：写入可回读、无 tmp 残留（并发读写不再见半截文件）；
 * 2) reindexChapterTxtFiles 重排变号同步：内容跟随新 idx、swap 场景（A:1→2 且 B:2→1）
 *    不互覆丢内容、无暂存文件残留；
 * 3) removeNovelTxtAll 删书清理：分章目录与全书导出合并文件一并移除，他人文件不受波及。
 * 运行：cd mini-services/backend-go && go test -run TestChapterTxt -run TestRemoveNovelTxt ./...
 */
package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func withTxtRoot(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("TXT_ROOT", dir)
	return dir
}

func txtDirFileCount(t *testing.T, dir string, match string) int {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir %s: %v", dir, err)
	}
	n := 0
	for _, e := range entries {
		if strings.Contains(e.Name(), match) {
			n++
		}
	}
	return n
}

// TestWriteChapterTxtAtomicRoundtrip 写入→回读一致 + 无 tmp 残留 + 文件名零填充有序
func TestWriteChapterTxtAtomicRoundtrip(t *testing.T) {
	root := withTxtRoot(t)
	if err := writeChapterTxt(7, 3, "第三章 试炼", "正文A\n正文B"); err != nil {
		t.Fatalf("writeChapterTxt: %v", err)
	}
	body, err := readChapterFromTxt(7, 3)
	if err != nil {
		t.Fatalf("readChapterFromTxt: %v", err)
	}
	if body != "正文A\n正文B" {
		t.Fatalf("回读内容 = %q, want %q", body, "正文A\n正文B")
	}
	chapterDir := filepath.Join(root, "7")
	if n := txtDirFileCount(t, chapterDir, ".tmp"); n != 0 {
		t.Fatalf("存在 %d 个 tmp 残留文件（原子落盘被破坏）", n)
	}
	// 覆盖写（同 idx 改题）后旧题名文件仍在，回读取字典序首个——与 syncChapterTxt 清理口径一致
	if err := writeChapterTxt(7, 3, "第三章 新题", "新正文"); err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	if _, err := os.Stat(filepath.Join(chapterDir, "00003_第三章_试炼.txt")); err != nil {
		t.Fatalf("覆盖写不应删除旧题名文件: %v", err)
	}
	if body, _ := readChapterFromTxt(7, 3); body != "新正文" {
		t.Fatalf("覆盖写后回读 = %q, want 新正文", body)
	}
}

// TestReindexChapterTxtFilesSwap 重排变号同步：普通换位 + swap 双向交换均不丢内容
func TestReindexChapterTxtFilesSwap(t *testing.T) {
	root := withTxtRoot(t)
	// 普通：A old1→3
	if err := writeChapterTxt(8, 1, "第1章", "bodyA"); err != nil {
		t.Fatalf("write A: %v", err)
	}
	reindexChapterTxtFiles(8, []chapterTxtMove{{ChapterID: 11, OldIdx: 1, NewIdx: 3, Title: "第1章"}})
	if body, err := readChapterFromTxt(8, 3); err != nil || body != "bodyA" {
		t.Fatalf("A 内容应随 idx 迁移到 3，got (%q,%v)", body, err)
	}
	if _, err := readChapterFromTxt(8, 1); err == nil {
		t.Fatal("A 旧位置 1 应已无文件")
	}
	// swap：B old2→1 与 C old1→2（B 文件已在 2、C 新写 1）
	if err := writeChapterTxt(8, 2, "第2章", "bodyB"); err != nil {
		t.Fatalf("write B: %v", err)
	}
	if err := writeChapterTxt(8, 1, "第1章", "bodyC"); err != nil {
		t.Fatalf("write C: %v", err)
	}
	reindexChapterTxtFiles(8, []chapterTxtMove{
		{ChapterID: 12, OldIdx: 2, NewIdx: 1, Title: "第2章"},
		{ChapterID: 13, OldIdx: 1, NewIdx: 2, Title: "第1章"},
	})
	if body, err := readChapterFromTxt(8, 1); err != nil || body != "bodyB" {
		t.Fatalf("swap 后位置 1 应为 B 内容，got (%q,%v)", body, err)
	}
	if body, err := readChapterFromTxt(8, 2); err != nil || body != "bodyC" {
		t.Fatalf("swap 后位置 2 应为 C 内容，got (%q,%v)", body, err)
	}
	if body, err := readChapterFromTxt(8, 3); err != nil || body != "bodyA" {
		t.Fatalf("A 内容不应受 swap 波及，got (%q,%v)", body, err)
	}
	chapterDir := filepath.Join(root, "8")
	if n := txtDirFileCount(t, chapterDir, "reidx_"); n != 0 {
		t.Fatalf("存在 %d 个 reidx 暂存残留", n)
	}
}

// TestReindexChapterTxtFilesNoFile 无文件行（db 模式）零副作用
func TestReindexChapterTxtFilesNoFile(t *testing.T) {
	withTxtRoot(t)
	reindexChapterTxtFiles(15, []chapterTxtMove{{ChapterID: 21, OldIdx: 1, NewIdx: 2, Title: "第1章"}})
	if _, err := os.Stat(novelTxtDir(15)); !os.IsNotExist(err) {
		t.Fatalf("无文件行不应创建目录: %v", err)
	}
}

// TestSyncChapterTxtWriteFailureKeepsOldFiles Task 36-a 回归锁定：写失败（改题场景，
// 目标新题名路径被目录占位使 rename 失败）时旧题名文件必须原样保留——
// 35-a 修复遗留口子（写失败仍执行清理循环）会把「改题+写失败」变回正文凭空消失。
// 注入方式 root 安全：预创建与新题名同名的目录（rename file→dir 必失败）。
func TestSyncChapterTxtWriteFailureKeepsOldFiles(t *testing.T) {
	root := withTxtRoot(t)
	if err := writeChapterTxt(10, 1, "第1章", "旧正文"); err != nil {
		t.Fatalf("write old: %v", err)
	}
	chapterDir := filepath.Join(root, "10")
	// 新题名同路径预置目录 → writeChapterTxt 的 tmp 写成功但 rename 必失败
	blocker := chapterTxtPath(10, 1, "第1章改题")
	if err := os.MkdirAll(blocker, 0o755); err != nil {
		t.Fatalf("mkdir blocker: %v", err)
	}
	syncChapterTxt(10, 1, "第1章改题", "新正文")
	if body, err := readChapterFromTxt(10, 1); err != nil || body != "旧正文" {
		t.Fatalf("写失败后旧题名文件必须保留，got (%q,%v)", body, err)
	}
	entries, rerr := os.ReadDir(chapterDir)
	if rerr != nil {
		t.Fatalf("read dir: %v", rerr)
	}
	for _, e := range entries {
		if strings.Contains(e.Name(), ".tmp") {
			t.Fatalf("写失败不应残留 tmp 文件，发现 %q", e.Name())
		}
		// 占位 blocker 是目录（注入手段本身），文件类只允许旧题名 .txt 保留
		if !e.IsDir() && e.Name() != "00001_第1章.txt" {
			t.Fatalf("写失败后不应新增/删除任何文件，发现 %q", e.Name())
		}
	}
	// 清理占位目录后重试同调用：写成功路径应正常落新文件并清旧题残留
	if err := os.Remove(blocker); err != nil {
		t.Fatalf("remove blocker: %v", err)
	}
	syncChapterTxt(10, 1, "第1章改题", "新正文")
	if body, err := readChapterFromTxt(10, 1); err != nil || body != "新正文" {
		t.Fatalf("写成功后应可回读新正文，got (%q,%v)", body, err)
	}
	if _, err := os.Stat(filepath.Join(chapterDir, "00001_第1章.txt")); !os.IsNotExist(err) {
		t.Fatalf("写成功后旧题名残留应被清理: %v", err)
	}
}

// TestRemoveNovelTxtAll 删书清理：分章目录 + 导出合并文件移除，无关文件保留
func TestRemoveNovelTxtAll(t *testing.T) {
	root := withTxtRoot(t)
	if err := writeChapterTxt(9, 1, "第一章", "x"); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := writeChapterTxt(9, 2, "第二章", "y"); err != nil {
		t.Fatalf("write: %v", err)
	}
	exportPath := exportTxtPath(9, "书名九")
	if err := os.MkdirAll(txtNovelsRoot(), 0o755); err != nil {
		t.Fatalf("mkdir root: %v", err)
	}
	if err := os.WriteFile(exportPath, []byte("book"), 0o644); err != nil {
		t.Fatalf("write export: %v", err)
	}
	// 无关书籍文件不应被波及（9_ 前缀 glob 不命中 88_/99_）
	other := filepath.Join(root, "88_其他书.txt")
	if err := os.WriteFile(other, []byte("keep"), 0o644); err != nil {
		t.Fatalf("write other: %v", err)
	}
	removeNovelTxtAll(9)
	if _, err := os.Stat(novelTxtDir(9)); !os.IsNotExist(err) {
		t.Fatalf("分章目录应被移除: %v", err)
	}
	if _, err := os.Stat(exportPath); !os.IsNotExist(err) {
		t.Fatalf("导出合并文件应被移除: %v", err)
	}
	if _, err := os.Stat(other); err != nil {
		t.Fatalf("无关文件不应被删除: %v", err)
	}
	removeNovelTxtAll(9) // 幂等
}
