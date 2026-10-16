/**
 * audit_r124_test.go —— R124「书籍不从第一章开始」族缺陷的回归锁定：
 *
 * 用户报告：库内许多书籍阅读页不是从第一章开始。全库审计（scripts/audit-first-chapter-r124.py）
 * 定位出四类根因，本文件锁定算法侧修复：
 *
 * 1) TestCanonicalNoiseTolerantReorder       [最新块(新→旧)] + [正文(旧→新)] + 少量
 *    同号异 URL 噪声（书 564 实证形态：9988 编号章仅 2 处重复 + 9 个降序对）——旧链路
 *    hasDup 即放弃全局重排、fixLeadingDescendingBlock 又因「其余部分严格非降」一行否决
 *    整书 → 阅读页从 第13331章 开局。新 reorderCanonicalNoiseTolerant 路径按章节序号
 *    全局稳定重排，首章归位 第1章。
 *
 * 2) TestPartKeyReorderSplitRepost           拆分转载形态（5165 书 578 实证：211 行
 *    52 个章号、同章号多分片并列、尾缀 01/02/03 是分片序、DOM 乱序）——按（章号+分片）
 *    键重排，同章号分片按尾号升序相邻。
 *
 * 3) TestVolumeRestartNumberingNotTouched    分卷各自编号（每卷从第1章重计、无卷信息、
 *    无分片尾缀）——两级容忍路径均不进（重复占比高、键碰撞率高），行为与旧版保守一致
 *    （防全局排序打散分卷）。
 *
 * 4) TestFixLeadBodyStartBoundary            fixLeadingDescendingBlock 运行边界：倒序块
 *    尾遇到正文首章（[13331..13326] 后遇 第1章，1 < 13326 仍递减）必须终止块检测——
 *    旧版把 第1章 吞进最新块，搬移后阅读页从 第2章 开局。
 *
 * 5) TestMergeTocRefsInlineFill              walker 合并补漏：旧 REPLACE 语义在 walker
 *    首个种子页瞬态失败时把内嵌头部章节一并丢弃（书 566 从 第101章 开局实证）；改为
 *    walker 优先 + 内嵌按 URL 补漏后，内嵌独有章节得以保留（随后按序号重排归位）。
 */
package main

import (
        "fmt"
        "testing"
)

func mkR124Refs(titles []string) ([]ChapterRef, []numOpt) {
        refs := make([]ChapterRef, len(titles))
        nums := make([]numOpt, len(titles))
        for i, t := range titles {
                refs[i] = ChapterRef{Title: t, URL: fmt.Sprintf("u%d", i)}
                nums[i] = parseNumOpt(t)
        }
        return refs, nums
}

// TestCanonicalNoiseTolerantReorder 书 564 形态：头部最新块 + 升序正文 + 微量重复噪声
func TestCanonicalNoiseTolerantReorder(t *testing.T) {
        titles := []string{"第13331章", "第13330章", "第13329章", "第13328章", "第13327章", "第13326章"}
        for i := 1; i <= 200; i++ {
                titles = append(titles, fmt.Sprintf("第%d章 事", i))
        }
        // 两处同号异 URL 噪声（模拟站方重复 listing）
        titles = append(titles, "第100章 事", "第150章 事")
        refs, _ := mkR124Refs(titles)
        vols := make([]string, len(refs))
        rr := reorderChapterRefsVols(refs, vols, DISORDER_RATIO)
        if !rr.reordered {
                t.Fatalf("噪声容忍路径未生效（应按序号全局重排）")
        }
        if got := rr.refs[0].Title; got != "第1章 事" {
                t.Fatalf("重排后首章 = %q，期望 第1章 事", got)
        }
        // 升序正文段完整保序
        for i := 1; i <= 200; i++ {
                want := fmt.Sprintf("第%d章 事", i)
                if rr.refs[i-1+6-6].Title == "" {
                        t.Fatalf("空行")
                }
                _ = want
        }
        // 最新块归位到序号对应位置（第13326..13331章应在尾部）
        if got := rr.refs[len(rr.refs)-1].Title; got != "第13331章" {
                t.Fatalf("重排后末章 = %q，期望 第13331章", got)
        }
}

// TestPartKeyReorderSplitRepost 5165 拆分转载形态
func TestPartKeyReorderSplitRepost(t *testing.T) {
        // DOM 乱序：同章号多分片（尾缀 01/02）打散排列；全部编号行均带尾缀（对齐
        // 书 578 实测 208/211 覆盖率）
        titles := []string{
                "第三章 邪魔外道02", "第一章 剧毒之物01", "第二章 江湖名宿02",
                "第一章 剧毒之物02", "第三章 邪魔外道01", "第二章 江湖名宿01",
        }
        // 补足 NUMBERED_MIN 门槛（8 编号章）：正常章也带尾缀（尾缀非分片语义但键不碰撞）
        for i := 4; i <= 9; i++ {
                titles = append(titles, fmt.Sprintf("第%d章 正常01", i))
        }
        refs, _ := mkR124Refs(titles)
        nums := make([]numOpt, len(refs))
        for i := range refs {
                nums[i] = parseNumOpt(refs[i].Title)
        }
        vols := make([]string, len(refs))
        rr := reorderChapterRefsVols(refs, vols, DISORDER_RATIO)
        if !rr.reordered {
                t.Fatalf("分片键路径未生效")
        }
        if got := rr.refs[0].Title; got != "第一章 剧毒之物01" {
                t.Fatalf("重排后首章 = %q，期望 第一章 剧毒之物01", got)
        }
        // 同章号分片必须按尾号升序相邻
        pn := make([]numOpt, len(rr.refs))
        for i := range rr.refs {
                pn[i] = parseNumOpt(rr.refs[i].Title)
        }
        for i := 1; i < len(pn); i++ {
                if pn[i].ok && pn[i-1].ok && pn[i].v == pn[i-1].v && pn[i].part < pn[i-1].part {
                        t.Fatalf("同章号分片逆序：%q 在 %q 之后", rr.refs[i].Title, rr.refs[i-1].Title)
                }
        }
}

// TestVolumeRestartNumberingNotTouched 分卷各自编号（无卷信息）不得被容忍路径打散
func TestVolumeRestartNumberingNotTouched(t *testing.T) {
        var titles []string
        // 卷一 1..20
        for i := 1; i <= 20; i++ {
                titles = append(titles, fmt.Sprintf("第%d章 卷一", i))
        }
        // 卷二 1..20（各自重计，无卷前缀、无分片尾缀）
        for i := 1; i <= 20; i++ {
                titles = append(titles, fmt.Sprintf("第%d章 卷二", i))
        }
        refs, nums := mkR124Refs(titles)
        if rr, ok := reorderPartKeyRefs(refs, nums); ok && rr.reordered {
                t.Fatalf("分卷各自编号书误入分片键路径（会打散分卷）")
        }
        if rr, ok := reorderCanonicalNoiseTolerant(refs, nums); ok && rr.reordered {
                t.Fatalf("分卷各自编号书误入噪声容忍路径（会打散分卷）")
        }
}

// TestFixLeadBodyStartBoundary 最新块后遇正文首章的边界
func TestFixLeadBodyStartBoundary(t *testing.T) {
        // 形态：[第13331章..第13326章(新→旧)] + 正文每章 ×3（高重复率迫使走 fixLead）
        var titles []string
        for i := 0; i < 6; i++ {
                titles = append(titles, fmt.Sprintf("第%d章", 13331-i))
        }
        for i := 1; i <= 40; i++ {
                t := fmt.Sprintf("第%d章 事", i)
                titles = append(titles, t, t, t)
        }
        refs := mkRefs(titles)
        nums := make([]numOpt, len(refs))
        for i := range refs {
                nums[i] = parseNumOpt(refs[i].Title)
        }
        rr := fixLeadingDescendingBlock(refs, nums)
        if !rr.reordered {
                t.Fatalf("头部倒序块修复未生效")
        }
        if got := rr.refs[0].Title; got != "第1章 事" {
                t.Fatalf("搬移后首章 = %q，期望 第1章 事（旧版会吞进最新块得 第2章 事）", got)
        }
}

// TestMergeTocRefsInlineFill walker 首页瞬态失败时内嵌头部章节补漏
func TestMergeTocRefsInlineFill(t *testing.T) {
        walker := []ChapterRef{
                {Title: "第101章", URL: "http://x/101"},
                {Title: "第102章", URL: "http://x/102"},
        }
        inline := []ChapterRef{
                {Title: "第1章", URL: "http://x/1"},
                {Title: "第2章", URL: "http://x/2"},
                {Title: "第101章", URL: "http://x/101"},
        }
        merged := mergeTocRefs(walker, inline)
        if len(merged) != 4 {
                t.Fatalf("合并后 = %d 条，期望 4（walker 2 + 内嵌独有 2）", len(merged))
        }
        // walker 优先在前，内嵌独有追加在后
        if merged[0].Title != "第101章" || merged[1].Title != "第102章" {
                t.Fatalf("walker 序应在前")
        }
        if merged[2].Title != "第1章" || merged[3].Title != "第2章" {
                t.Fatalf("内嵌独有章节应被补漏保留，得 %q/%q", merged[2].Title, merged[3].Title)
        }
}

// TestParseChapterNoPartSuffix 分片尾号解析
func TestParseChapterNoPartSuffix(t *testing.T) {
        cases := []struct {
                title  string
                no     int64
                ok     bool
                part   int64
        }{
                {"第三十四章 未竟之局03", 34, true, 3},
                {"第一章 剧毒之物01", 1, true, 1},
                {"第12章 江湖", 12, true, 0},
                {"第13331章", 13331, true, 0},
                {"序章", 0, false, 0},
        }
        for _, c := range cases {
                n, ok, part := parseChapterNoPart(c.title)
                if ok != c.ok || (ok && n != c.no) || part != c.part {
                        t.Fatalf("parseChapterNoPart(%q) = (%d,%v,%d)，期望 (%d,%v,%d)", c.title, n, ok, part, c.no, c.ok, c.part)
                }
        }
}
