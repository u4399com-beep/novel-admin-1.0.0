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
func writeChapterTxt(novelID, idx int, title, content string) error {
	dir := novelTxtDir(novelID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	body := trimSpaceStr(title) + "\n\n" + content + "\n"
	return os.WriteFile(chapterTxtPath(novelID, idx, title), []byte(body), 0o644)
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

// removeChapterTxt 删除该章全部分章文件（同 idx 多文件一并清理；章删除/改题残留场景）
func removeChapterTxt(novelID, idx int) {
	matches, _ := filepath.Glob(filepath.Join(novelTxtDir(novelID), fmt.Sprintf("%05d", idx)+"_*.txt"))
	for _, m := range matches {
		_ = os.Remove(m)
	}
}

// syncChapterTxt 编辑保存时的分章文件同步：该章已有 txt 文件（说明该书处于 txt/both 模式）
// 才按最新标题/正文重写（旧文件名含旧标题时顺带清理）；无文件（db 模式）零开销直返。
func syncChapterTxt(novelID, idx int, title, content string) {
	matches, err := filepath.Glob(filepath.Join(novelTxtDir(novelID), fmt.Sprintf("%05d", idx)+"_*.txt"))
	if err != nil || len(matches) == 0 {
		return
	}
	for _, m := range matches {
		_ = os.Remove(m)
	}
	_ = writeChapterTxt(novelID, idx, title, content)
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
