/**
 * introx.go —— 简介噪声清洗 + 「相关小说」长尾词 pSEO 转换（用户指令 2026-09：
 * 「还是出现类似这种，注意清洗噪声功能，这种可以洗掉或者转换。内容简介中如果发现
 * 『相关小说』类似长尾词的存在，直接加到pSEO中」）。
 *
 * 全库实证噪声家族（书 35/37/41/46/57/61/67/83/87/98/112/132/134/150/158/164）：
 *  1. 尾部「相关小说：A、B、C…」下拉词块 —— 洗掉 + 转换进 PseoKeyword（source='intro',
 *     seed=书名，pending → generatePendingPages 自动消化为聚合页 → 书籍页血缘直取上榜）
 *  2. 「&#091；轻松军旅&#093；」全角分号实体解码失败（用户贴文「[]」实证）→ 归一为
 *     ASCII 分号后解码 →「[轻松军旅]」（洗不掉的转为可读形）
 *  3. 「<br />」HTML 标签残留 → 转换为换行；其余标签剥除
 *  4. 「�」U+FFFD 解码残损前缀（「【」残臂实证）→ 剥除；行首「已完结】」残臂一并剥
 *  5. 「------------------」分隔线后的作者推广块 → 从分隔线截断
 *  6. 「【书友群：QQ号】」推广尾 → 截断（含截断后尾部孤立开括号剥除）
 *  7. 整条 SEO 元信息样板（「XX免费在线阅读，作者：…，字数：…万字，章节：N章。」）
 *     → 全清空（元信息与 DB 字段完全重复，无叙事价值）
 *
 * 双侧分工：scraper-go 引擎侧 cleanDescription 只做基础修复（实体归一/FFFD/标签，
 * Task 41 同步增强）——「相关小说」尾块与分隔线等**不在引擎侧截断**，完整送达
 * 编排侧由本文件清洗+提取（引擎先截断则长尾词丢失，转换无从谈起）。
 *
 * 接线点：upsertBook（采集入库前第二道）+ db.go getDB once 存量回填（幂等）。
 * 幂等契约：clean(clean(x)) == clean(x)——所有截断/转换一次性移除噪声材料，二次
 * 清洗零命中；回填以此收敛（清洗后行不再满足锚点条件，零写放大）。
 */
package main

import (
	"database/sql"
	"html"
	"log"
	"regexp"
	"strings"
)

// 简介提取词约束（PseoKeyword 词池质量闸门）
const (
	introWordMinRunes = 2
	introWordMaxRunes = 30
	introWordsPerBook = 15 // 单书提取上限（防劣质简介灌爆词池）
)

var (
	// introEntityFixRE 全角分号实体归一：「&#091；」「&#x1F600；」→ ASCII 分号。
	// 源站模板/编辑器把实体收尾写成全角「；」（书 67 实证），任何实体解码器都不认，
	// 归一后交 html.UnescapeString 解码
	introEntityFixRE = regexp.MustCompile(`&#([xX]?)([0-9a-fA-F]+)[；﹔]`)
	// introFFFDRE 解码残损字符（书 61 实证「�已完结】」）
	introFFFDRE = regexp.MustCompile(`\x{FFFD}+`)
	// introBrRE 换行语义标签 → 换行（书 46 实证）
	introBrRE = regexp.MustCompile(`(?i)<br\s*/?>`)
	// introTagRE 其余 HTML 标签剥除（含 </p>，换行语义已由 BrRE 先行转换）
	introTagRE = regexp.MustCompile(`(?i)</?[a-z][^>]{0,80}>`)
	// introMetaTplRE 整条 SEO 元信息样板（书 150/164 实证）。锚定首尾全串匹配才清空：
	// 「免费在线阅读，作者：…，分类：…，状态：…，字数：…，章节：N章。」固定键序，
	// 正常叙事简介不可能整体命中（局部出现时仅因未全串命中而保守保留）
	introMetaTplRE = regexp.MustCompile(`(?s)^.{1,100}免费在线阅读，作者：.{1,40}，分类：.{1,40}，状态：.{1,20}，字数：.{1,40}，章节：.{1,20}章。?$`)
	// introSepCutRE 视觉分隔线截断（书 37/41 实证「------------------ 八宝饭，Lv.5」）：
	// 4+ 连续 -/_/* 为分隔线，其后整块（作者名号/推广）截断。中文破折号「——」（em dash）
	// 不参与——正文破折号是常规标点，误截风险高
	introSepCutRE = regexp.MustCompile(`(?s)[-_*]{4,}.*$`)
	// introSepLineRE 整行分隔线/装饰线（纯符号行，无文字直接去行）
	introSepLineRE = regexp.MustCompile(`^[-=*·—~×\s]{4,}$`)
	// introPromoCutRE 书友群/读者群推广截断（书 57 实证「【书友群：790924091欢迎…」）
	introPromoCutRE = regexp.MustCompile(`(?s)(?:书友群|QQ群|qq群|交流群|粉丝群|微信群|群号)\s*[：:【(（\[].*$`)
	// introTailOpenBracketRE 截断后尾部孤立开括号剥除（promo 锚点在「【」内时残留）
	introTailOpenBracketRE = regexp.MustCompile(`\s*[【（\[]$`)
	// introRelatedRE 「相关小说」族尾部锚点：必带冒号（叙事文本正常使用「类似小说」等词
	// 不带冒号不会误伤）。锚点起至文末整块 = 下拉词清单 → 截断 + 提取
	introRelatedRE = regexp.MustCompile(`(?s)(?:【?\s*(?:相关|类似|同类|相似)(?:小说|作品|推荐|阅读)\s*】?|延伸阅读|热门推荐|猜你喜欢)\s*[：:]\s*(.*)$`)
	// introStatusPrefixRE 行首状态标签残臂（书 61 实证 FFFD 剥后「已完结】 十七岁…」）
	introStatusPrefixRE = regexp.MustCompile(`^(?:【?\s*(?:已完结|完本|全文完|精彩完本)\s*】)\s*`)
	// introWordSplitRE 长尾词条目分隔：顿号/逗号/分号/句号/换行。条目**内部空格保留**
	//（下拉词原形「凡人修仙传 灵婴」是一个词，按空白切会剁碎成无意义短词）
	introWordSplitRE = regexp.MustCompile(`[、，,；;。\n]+`)
	// introWordJunkRE 条目垃圾形态：URL/域名碎片、纯数字/空白串
	introWordJunkRE = regexp.MustCompile(`(?i)(?:www\.|https?://|\.[a-z]{2,6}\b)|(?:^[0-9\s]+$)`)
	// introPromoItemRE 清单内的推广项（相关块之后还可能再拼书友群尾，混入条目流）
	introPromoItemRE = regexp.MustCompile(`书友群|QQ群|qq群|交流群|粉丝群|微信群|群号`)
	// introHasTextRE 条目必须含文字
	introHasTextRE = regexp.MustCompile(`[\p{L}\p{N}]`)
	// introWordTrimCut 条目首尾装饰字符（书名号/引号/括号/省略号/标点/空白）——
	// **仅用于提取词的首尾修剪**，绝不作用于正文行（正文句尾 ！。—— 是合法标点）
	introWordTrimCut = "【】《》〈〉\"'“”‘’()（）[]<>…·—~-!！?？:：.。,，、;； \t\u00a0\u3000"
)

// cleanNovelIntro 简介清洗：返回（清洗后文本，提取出的长尾词）。
// 输出契约：无空行、无行首尾空白，行间单个 \n（与正文清洗存储契约同构；
// 前台 whitespace-pre-line / 原样渲染均可接受）。
// 幂等：对已清洗文本二次调用返回原文本 + 空词表。
func cleanNovelIntro(desc string) (string, []string) {
	if strings.TrimSpace(desc) == "" {
		return "", nil
	}
	words := []string{}

	// 1) 整条元信息样板 → 全清空（先于实体解码：样板无实体，锚点最稳）
	if introMetaTplRE.MatchString(strings.TrimSpace(desc)) {
		return "", nil
	}

	// 2) 实体归一 + 解码（×2 兜底双重转义，Task 31-c ixdzs8 实证）+ FFFD + 标签
	s := introEntityFixRE.ReplaceAllString(desc, `&#${1}${2};`)
	s = html.UnescapeString(html.UnescapeString(s))
	s = introFFFDRE.ReplaceAllString(s, "")
	s = introBrRE.ReplaceAllString(s, "\n")
	s = introTagRE.ReplaceAllString(s, "")

	// 3) 「相关小说」族尾块：截断 + 提取长尾词（用户指令「直接加到pSEO中」）。
	//    必须先于 promo/sep 截断——若推广尾拼在相关块之后，先截 promo 会连带吃掉词表
	if m := introRelatedRE.FindStringSubmatch(s); m != nil {
		words = extractIntroWords(m[1])
		s = s[:len(s)-len(m[0])]
	}

	// 4) 分隔线 / 推广尾截断（此时相关块已摘除，两截断作用于剩余正文尾）
	s = introSepCutRE.ReplaceAllString(s, "")
	s = introPromoCutRE.ReplaceAllString(s, "")
	s = introTailOpenBracketRE.ReplaceAllString(s, "")

	// 5) 行归一：剥行首尾空白、去纯分隔线行与空行、状态残臂剥除。
	//    ⚠ 仅 TrimSpace，不做装饰字符 Trim——正文句尾 ！。—— 是合法标点
	lines := strings.Split(s, "\n")
	kept := make([]string, 0, len(lines))
	for _, ln := range lines {
		ln = introStatusPrefixRE.ReplaceAllString(strings.TrimSpace(ln), "")
		ln = strings.TrimSpace(ln)
		if ln == "" || introSepLineRE.MatchString(ln) {
			continue
		}
		kept = append(kept, ln)
	}
	return strings.Join(kept, "\n"), words
}

// extractIntroWords 从「相关小说：」清单尾块提取长尾词条目（顿号/逗号/分号/换行分隔）。
// 质量闸门：2..30 rune、含文字、非 URL/纯数字/推广形态、kwNormalize 归一去重、上限
// introWordsPerBook。条目内部空格保留（下拉词原形「凡人修仙传 灵婴」是一个词）；
// 条目不过 sanitizeKeyword（危险字符已由清洗器剥除，kwStripRe 语义保留给引擎下拉词路径）。
func extractIntroWords(tail string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, item := range introWordSplitRE.Split(tail, -1) {
		w := strings.Trim(strings.TrimSpace(item), introWordTrimCut)
		w = strings.Join(strings.Fields(w), " ")
		rl := runeLen(w)
		if rl < introWordMinRunes || rl > introWordMaxRunes {
			continue
		}
		if !introHasTextRE.MatchString(w) || introWordJunkRE.MatchString(w) || introPromoItemRE.MatchString(w) {
			continue
		}
		key := kwNormalize(w)
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, w)
		if len(out) >= introWordsPerBook {
			break
		}
	}
	return out
}

// insertIntroKeywords 简介提取词入库（best-effort，采集热路径零网络调用）：
// source='intro'、seed=书名（书籍页血缘直取通道）、pending → generatePendingPages
// 自动生成聚合页。失败仅记日志，绝不影响入库主流程。
func insertIntroKeywords(title string, words []string) int {
	if len(words) == 0 {
		return 0
	}
	entries := make([]kwEntry, 0, len(words))
	for _, w := range words {
		kw := sanitizeKeyword(w)
		if kw == "" {
			continue
		}
		entries = append(entries, kwEntry{Word: kw, Engine: "intro"})
	}
	if len(entries) == 0 {
		return 0
	}
	added, err := insertKeywords(entries, introWordsPerBook, title)
	if err != nil {
		log.Printf("[backend-go-intro] 《%s》简介长尾词入库失败: %v", truncateRunes(title, 30), err)
		return 0
	}
	return added
}

// backfillNovelIntroClean 存量简介清洗回填（getDB once 回调内调用，幂等）：
// 全量扫描非空简介 → cleanNovelIntro → 有变化才 UPDATE；提取词以 INSERT OR IGNORE
// 直插 PseoKeyword（source='intro'、seed=书名、pending）。
// ⚠ once 回调内严禁经 getDB 的共享 exec/query 路径——Task 30 P1 递归自锁教训，
// 全程用传入的局部 db 句柄；唯一约束 PseoKeyword_keyword_key 兜底并发/重复。
// 清洗幂等保证二次启动零写放大：已清洗行 cleanNovelIntro 原样返回不触发 UPDATE。
func backfillNovelIntroClean(db *sql.DB) error {
	rows, err := db.Query(`SELECT "id","title","description" FROM "Novel" WHERE "description" != ''`)
	if err != nil {
		return err
	}
	type introFix struct {
		id    int64
		title string
		desc  string
		words []string
	}
	fixes := make([]introFix, 0, 8)
	for rows.Next() {
		var id int64
		var title, desc string
		if err := rows.Scan(&id, &title, &desc); err != nil {
			rows.Close()
			return err
		}
		cleaned, words := cleanNovelIntro(desc)
		if cleaned == desc {
			continue // 无噪声（或幂等已清洗），零写放大
		}
		fixes = append(fixes, introFix{id: id, title: title, desc: cleaned, words: words})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	changed, kwAdded := 0, 0
	for _, f := range fixes {
		if _, err := db.Exec(`UPDATE "Novel" SET "description" = ?, "updatedAt" = ? WHERE "id" = ?`,
			f.desc, nowMillis(), f.id); err != nil {
			return err
		}
		changed++
		for _, w := range f.words {
			kw := sanitizeKeyword(w)
			if kw == "" {
				continue
			}
			res, err := db.Exec(
				`INSERT OR IGNORE INTO "PseoKeyword" ("keyword","source","status","createdAt","updatedAt","kwNorm","seed") VALUES (?,'intro','pending',?,?,?,?)`,
				kw, nowMillis(), nowMillis(), kwNormalize(kw), truncateRunes(f.title, 100))
			_ = res
			if err != nil && !isUniqueConflict(err) {
				return err
			}
			if err == nil {
				kwAdded++
			}
		}
	}
	if changed > 0 {
		log.Printf("[db] 简介噪声清洗回填：%d 行修正，pSEO 提取 +%d 词", changed, kwAdded)
	}
	return nil
}
