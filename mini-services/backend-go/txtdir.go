/**
 * txtdir.go —— TXT 文件存储模式 helper（Task 32-b）。
 *
 * 目录布局（TXT_ROOT 环境变量可覆盖，测试用 temp 目录；生产 = /home/z/my-project/download/novels）：
 *   {root}/{novelId}/{idx:05d}_{safeTitle}.txt   一章一文件（phase2 采集 txt/both 模式写入）
 *   {root}/{novelId}_{safeBookTitle}.txt          全书合并导出文件（/api/novels/{id}/export-txt）
 *
 * 分章文件内容 = 章节标题 + 空行 + 正文（\n 结尾）；读取方（阅读页/章节 API/导出）
 * 在 DB content 为空时经 readChapterFromTxt 兜底回读。
 */
package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// errTxtNotFound readChapterFromTxt 的「文件不存在」哨兵（调用方仅区分有无，不必细分）
var errTxtNotFound = errors.New("txt 章节文件不存在")

// txtNovelsRoot TXT 文件根目录（TXT_ROOT 覆盖仅用于测试隔离，生产恒为 download/novels）
func txtNovelsRoot() string {
	if p := os.Getenv("TXT_ROOT"); p != "" {
		return p
	}
	return "/home/z/my-project/download/novels"
}

// novelTxtDir 单本书的分章文件目录：{root}/{novelId}/
func novelTxtDir(novelID int) string {
	return filepath.Join(txtNovelsRoot(), strconv.Itoa(novelID))
}

// safeTitle 文件名安全清洗：非法字符 [\/:*?"<>|] 与空白/控制符 → _，截断 80 rune，
// 去首尾的 _ . 空白（Windows 保留尾点/尾空格非法；".." 会变 untitled 防路径语义）。
// 全部替换后分隔符不可能残留 → 拼进路径无目录穿越风险。
func safeTitle(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r < 0x20 || r == 0x7F || r == '/' || r == '\\' || r == ':' || r == '*' ||
			r == '?' || r == '"' || r == '<' || r == '>' || r == '|' || r == ' ' {
			b.WriteByte('_')
			continue
		}
		b.WriteRune(r)
	}
	out := strings.Trim(truncateRunes(b.String(), 80), "_. ")
	if out == "" {
		return "untitled"
	}
	return out
}

// chapterTxtName 分章文件名：{idx:05d}_{safeTitle}.txt（idx 零填充保证字典序=章节序）
func chapterTxtName(idx int, title string) string {
	return fmt.Sprintf("%05d_%s.txt", idx, safeTitle(title))
}

// chapterTxtPath 分章文件完整路径
func chapterTxtPath(novelID, idx int, title string) string {
	return filepath.Join(novelTxtDir(novelID), chapterTxtName(idx, title))
}

// exportTxtPath 全书合并导出文件路径：{root}/{novelId}_{safeBookTitle}.txt（与分章子目录互不干扰）
func exportTxtPath(novelID int, bookTitle string) string {
	return filepath.Join(txtNovelsRoot(), fmt.Sprintf("%d_%s.txt", novelID, safeTitle(bookTitle)))
}

// writeChapterTxt 写分章文件（内容 = 标题 + 空行 + 正文 + \n）。调用方保证目录语义，
// 这里 MkdirAll 幂等建目录（每章一次 stat 级开销可忽略）。
// Task 33-b: 旧版 os.WriteFile 直接截断写目标路径——同章并发写（同名书双任务/重发续传
// 窗口）或并发读（阅读页/导出）会读到截断/交错的半截文件；改为 tmp+rename 原子落盘
// （coversx.go fetchAndStoreCover 同款，tmp 名带纳秒后缀防碰撞，且不落在
// readChapterFromTxt 的 {idx}_*.txt glob 结果内——尾缀 .tmp-n ≠ .txt）。
func writeChapterTxt(novelID, idx int, title, content string) error {
	dir := novelTxtDir(novelID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	body := trimSpaceStr(title) + "\n\n" + content + "\n"
	final := chapterTxtPath(novelID, idx, title)
	tmp := final + ".tmp-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	if err := os.WriteFile(tmp, []byte(body), 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, final); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// chapterTxtMove 章节重排（audit reindex/去重压实）的单章 idx 迁移记录（Task 33-b）。
// 重排只改 idx 不改 title，新旧文件名可由同一 title 推出。
type chapterTxtMove struct {
	ChapterID int64
	OldIdx    int64
	NewIdx    int64
	Title     string
}

// reindexChapterTxtFiles 重排落库后同步分章 txt 文件名（旧 idx → 新 idx，Task 33-b）。
// 根因：分章文件名内嵌 idx，重排/去重后 DB idx 变了而文件名不变，readChapterFromTxt
// 按「新 idx」前缀匹配会读到别的章（串章）或读不到（txt 模式书正文“丢失”）。
// 两段式 rename（旧名 → reidx_{novel}_{chapter}.tmp 唯一暂存名 → 新名）防 swap 场景
// （A:1→2 且 B:2→1）互覆丢内容；无旧文件的行（db 模式/未落盘）跳过。
// 尽力而为语义（与 syncChapterTxt/removeChapterTxt 同口径：错误静默，DB 正文仍在分表/存量列）。
func reindexChapterTxtFiles(novelID int64, moves []chapterTxtMove) {
	if len(moves) == 0 {
		return
	}
	dir := novelTxtDir(int(novelID))
	tmpName := func(chapterID int64) string {
		return filepath.Join(dir, fmt.Sprintf("reidx_%d_%d.tmp", novelID, chapterID))
	}
	// pass 1：旧文件 → 暂存名（全部腾位后再落位，swap 安全）
	for _, mv := range moves {
		oldPath := chapterTxtPath(int(novelID), int(mv.OldIdx), mv.Title)
		if _, err := os.Stat(oldPath); err != nil {
			continue
		}
		_ = os.Rename(oldPath, tmpName(mv.ChapterID))
	}
	// pass 2：暂存名 → 新名；失败回滚暂存名 → 旧名（尽力保留可用文件）
	for _, mv := range moves {
		tmp := tmpName(mv.ChapterID)
		if _, err := os.Stat(tmp); err != nil {
			continue
		}
		if err := os.MkdirAll(dir, 0o755); err == nil {
			if rerr := os.Rename(tmp, chapterTxtPath(int(novelID), int(mv.NewIdx), mv.Title)); rerr == nil {
				continue
			}
		}
		_ = os.Rename(tmp, chapterTxtPath(int(novelID), int(mv.OldIdx), mv.Title))
	}
}

// removeNovelTxtAll 书籍删除后的 TXT 存储清理（Task 33-b）：分章目录整体移除 +
// 根目录全书导出合并文件（{novelId}_*.txt，标题任意）逐一删除。否则删书后
// 磁盘永久遗留孤儿文件，且同 id 复用（重采/自增回绕）会串入旧书正文。幂等。
func removeNovelTxtAll(novelID int64) {
	_ = os.RemoveAll(novelTxtDir(int(novelID)))
	matches, _ := filepath.Glob(filepath.Join(txtNovelsRoot(), strconv.FormatInt(novelID, 10)+"_*.txt"))
	for _, m := range matches {
		_ = os.Remove(m)
	}
}

// readChapterFromTxt 按 idx 回读分章文件正文（统一 helper：阅读页/章节 API/导出共用）。
// 命中多文件（同章旧标题残留）取字典序首个，确定性返回；正文=首个空行之后的全部内容
// （去尾部换行）。文件不存在返回 errTxtNotFound。
func readChapterFromTxt(novelID, idx int) (string, error) {
	matches, err := filepath.Glob(filepath.Join(novelTxtDir(novelID), fmt.Sprintf("%05d", idx)+"_*.txt"))
	if err != nil {
		return "", err
	}
	if len(matches) == 0 {
		return "", errTxtNotFound
	}
	sort.Strings(matches)
	raw, err := os.ReadFile(matches[0])
	if err != nil {
		return "", err
	}
	lines := strings.SplitN(string(raw), "\n", 3)
	if len(lines) < 3 {
		return "", errTxtNotFound // 形态不合规（无空行分隔）视为不可用
	}
	return strings.TrimRight(lines[2], "\n"), nil
}

// removeChapterTxt 删除该章全部分章文件（同 idx 多文件一并清理；章删除/改题残留场景；
// Task 33-b 注：audit 去重删行的文件清理与整书删除见 reindexChapterTxtFiles/removeNovelTxtAll）
func removeChapterTxt(novelID, idx int) {
	matches, _ := filepath.Glob(filepath.Join(novelTxtDir(novelID), fmt.Sprintf("%05d", idx)+"_*.txt"))
	for _, m := range matches {
		_ = os.Remove(m)
	}
}

// syncChapterTxt 编辑保存时的分章文件同步：该章已有 txt 文件（说明该书处于 txt/both 模式）
// 才按最新标题/正文重写（旧文件名含旧标题时顺带清理）；无文件（db 模式）零开销直返。
// Task 35-a: 写新先行——旧版先删全部旧文件再写新文件，writeChapterTxt 失败时旧文件已删、
// 新文件未落盘，txt 模式书该章正文凭空消失；改为先写新文件（tmp+rename 原子），成功后再
// 清理旧题名残留（跳过与新文件同名的目标行），写失败旧文件原样保留（内容旧但不丢）。
func syncChapterTxt(novelID, idx int, title, content string) {
	matches, err := filepath.Glob(filepath.Join(novelTxtDir(novelID), fmt.Sprintf("%05d", idx)+"_*.txt"))
	if err != nil || len(matches) == 0 {
		return
	}
	final := chapterTxtPath(novelID, idx, title)
	_ = writeChapterTxt(novelID, idx, title, content)
	for _, m := range matches {
		if m == final {
			continue // 同名覆盖场景：新文件即目标，不得误删
		}
		_ = os.Remove(m)
	}
}

// exportedTxtItem 已导出合并文件条目（GET /api/export-txt/list 行）
type exportedTxtItem struct {
	novelID int64
	title   string
	size    int64
	mtimeMS int64
	path    string
}

// listExportedTxt 扫描 TXT 根目录顶层 *.txt（只列文件，不进 {novelId}/ 分章子目录），
// novelId 从文件名「{id}_{title}.txt」前缀解析（非该形态的文件 novelId=0 仍列出）。
// 按 novelId 升序、同名按文件名稳定排序。目录不可读返回 nil。
func listExportedTxt() []exportedTxtItem {
	entries, err := os.ReadDir(txtNovelsRoot())
	if err != nil {
		return nil
	}
	out := make([]exportedTxtItem, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".txt") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		stem := strings.TrimSuffix(e.Name(), ".txt")
		var nid int64
		title := stem
		if i := strings.Index(stem, "_"); i >= 0 {
			if v, perr := strconv.ParseInt(stem[:i], 10, 64); perr == nil {
				nid = v
				title = stem[i+1:]
			}
		}
		out = append(out, exportedTxtItem{
			novelID: nid,
			title:   title,
			size:    info.Size(),
			mtimeMS: info.ModTime().UnixMilli(),
			path:    filepath.Join(txtNovelsRoot(), e.Name()),
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].novelID != out[j].novelID {
			return out[i].novelID < out[j].novelID
		}
		return out[i].path < out[j].path
	})
	return out
}
