/**
 * web_list.go —— 频道列表页（R145）：首页横带角标「全部 N 本」的真实落点。
 *
 * 背景（用户 R155 报告）：jiuxiaozw 主题首页各横带右上角「全部 N 本」角标数字与
 * 落点页展示数量要求统一为 10 本——模块角标 = min(真实全集总数, webModuleShowCount)，
 * 落点页同样只列 webModuleShowCount 本（页码自然归一为 1，分页栏隐藏）。诚实原则
 * 保留：频道不足 10 本时显示真实数（不虚标）；单一来源（webListTotals 钳制后）
 * 角标与落点页「共 N 本」永不漂移（R145 同款承诺）。
 *
 * 频道契约（与首页横带一一对应，标题/副标文案与 home.html 同源）：
 *   featured     小编精选  isFeatured=1     按更新时间
 *   hot          热门小说  isHot=1          按点击
 *   latest       最新上架  全库             按更新时间
 *   rank-clicks  点击榜    全库             按点击
 *   rank-updates 更新榜    全库             按更新时间
 *   finished     完本佳作  status=finished  按点击
 *
 * 分页：webModuleShowCount 本/页（R155：用户指定模块展示上限 10 本，全集总数同步钳制，
 * 总页数恒 1，分页栏由模板 totalPages>1 条件自动隐藏）；分页 CSS 为原站
 * book-list-pagination（aria-current 当前页 / aria-disabled 不可点端点），
 * jiuxiaozw.css bundle 内置——未来上调 webModuleShowCount 即恢复多页形态，模板零改动。
 * 合规红线：全部数据来自本站 DB；角标数字=落点页真实总数钳制值，不虚标。
 */
package main

import (
	"net/http"
	"strconv"
)

// webListKind 频道定义：标题/副标/查询形态（where/order 与首页横带数据面同口径）
type webListKind struct {
	title string
	tag   string
	where string
	order string
}

// webListKinds kind → 频道（路由白名单；未命中 → web404）
var webListKinds = map[string]webListKind{
	"featured":     {title: "小编精选", tag: "编辑们正在追的作者与故事。", where: ` WHERE n."isFeatured" = 1`, order: ` ORDER BY n."updatedAt" DESC, n."id" DESC`},
	"hot":          {title: "热门小说", tag: "全书库点击最高的作品，人气之选。", where: ` WHERE n."isHot" = 1`, order: ` ORDER BY n."clicks" DESC, n."id" DESC`},
	"latest":       {title: "最新上架", tag: "新鲜出炉，抢先开读。", where: "", order: ` ORDER BY n."updatedAt" DESC, n."id" DESC`},
	"rank-clicks":  {title: "点击榜", tag: "用真实点击数说话的榜单。", where: "", order: ` ORDER BY n."clicks" DESC, n."id" DESC`},
	"rank-updates": {title: "更新榜", tag: "追更上头，最近动作最快的书。", where: "", order: ` ORDER BY n."updatedAt" DESC, n."id" DESC`},
	"finished":     {title: "完本佳作", tag: "一口气看到大结局的安心之选。", where: ` WHERE n."status" = 'finished'`, order: ` ORDER BY n."clicks" DESC, n."id" DESC`},
}

// webModuleShowCount 首页模块角标与落点页统一展示上限（R155：用户指定 10 本）。
// 双消费方：①webListTotals 对真实全集总数钳制（角标与落点页「共 N 本」同源）
// ②handleWebList 查询 LIMIT（落点页只列同上限本数）。
const webModuleShowCount = 10

// webListPageSize 每页本数（= 展示上限：总数已钳制到同一值，总页数恒 1；
// 未来上调 webModuleShowCount 时本值随之，多页形态自动恢复）
const webListPageSize = webModuleShowCount

// handleWebList GET /list/{kind} —— 频道全集分页列表页（首页角标落点）。
func handleWebList(w http.ResponseWriter, r *http.Request, ps map[string]string) {
	kind := ps["kind"]
	k, ok := webListKinds[kind]
	if !ok {
		web404(w, r, "频道不存在")
		return
	}
	data := webCommon(r)
	var total int64
	_ = queryOne(`SELECT COUNT(*)`+novelListFrom+k.where, []any{&total})
	// R155：展示上限钳制（与 webListTotals 角标口径一致）——落点页只兑现
	// min(真实全集, webModuleShowCount) 本，页码随钳后总数自然归一
	if total > webModuleShowCount {
		total = webModuleShowCount
	}
	totalPages := int64(1)
	if total > webListPageSize {
		totalPages = (total + webListPageSize - 1) / webListPageSize
	}
	page := webListPageParam(r, totalPages)
	// R160: 频道名/副标语种化（页面数据面消费；TDK 保持原文简体——SEO 定位不动）
	lang := webLangOfRequest(r, w)
	listTitle, listTag := tmplT(lang, k.title), tmplT(lang, k.tag)
	novels, _ := queryNovelList(k.where, k.order, nil, webListPageSize, int((page-1)*webListPageSize))
	// R160: 频道列表书名/简介语种化
	i18nNovelMaps(lang, novels, "title", "description")
	data["List"] = map[string]any{
		"kind": kind, "title": listTitle, "tag": listTag,
		"total": total, "page": page, "totalPages": totalPages,
		"pages":  webListPageWindow(page, totalPages, 7), // 页码窗口（当前页居中，最多 7 个）
		"novels": novels,
	}
	data["siteName"] = data["Site"].(map[string]any)["siteName"]
	// seoConfig 无 listTitle/listDescription 键时走默认回落文案（renderSeoKey 空回落）
	// R165: title 走 Tf 字典形态（「{0}全部小说列表」四语种词条）——此前整段拼串进显式管线
	// 只能靠 LLM 预热，实测缓存回填半吊子译文（「Latest上架 all novels list」）；Tf 直查
	// 零上游且译文质量手写可控。description 保持原文简体（SEO 语义面，R164 设计内豁免）。
	applyWebTDK(data, lang, "listTitle", "listDescription", map[string]string{"listName": k.title},
		tmplTf(lang, "{0}全部小说列表", tmplT(lang, k.title)), k.title+"，共"+strconv.FormatInt(total, 10)+"本免费在线阅读")
	renderPage(w, r, "list", data)
}

// webListPageParam ?page= 解析与钳制（1..totalPages；非法/越界安全回落，绝不越界查询）
func webListPageParam(r *http.Request, totalPages int64) int64 {
	p, err := strconv.ParseInt(r.URL.Query().Get("page"), 10, 64)
	if err != nil || p < 1 {
		return 1
	}
	if p > totalPages {
		return totalPages
	}
	return p
}

// webListPageWindow 页码窗口（总页数 ≤ maxN 全量；否则以当前页为中心的连续窗口）
func webListPageWindow(page, totalPages int64, maxN int) []int64 {
	if totalPages <= int64(maxN) {
		out := make([]int64, 0, totalPages)
		for i := int64(1); i <= totalPages; i++ {
			out = append(out, i)
		}
		return out
	}
	half := int64(maxN / 2)
	lo := page - half
	if lo < 1 {
		lo = 1
	}
	hi := lo + int64(maxN) - 1
	if hi > totalPages {
		hi = totalPages
		lo = hi - int64(maxN) + 1
	}
	out := make([]int64, 0, maxN)
	for i := lo; i <= hi; i++ {
		out = append(out, i)
	}
	return out
}

// webListTotals 六频道全集总数（一条 SQL 出 4 基数；latest/rank-clicks/rank-updates
// 同为全库总数）。首页角标与落点页「共 N 本」共用本函数——双侧数字同源永不漂移。
// R155：按 webModuleShowCount 钳制展示上限（用户指定模块角标/列表页统一 10 本；
// 频道不足 10 本时回落真实数，不虚标）。
func webListTotals() map[string]int64 {
	var featured, hot, all, finished int64
	if err := queryOne(`SELECT (SELECT COUNT(*) FROM "Novel" WHERE "isFeatured" = 1), (SELECT COUNT(*) FROM "Novel" WHERE "isHot" = 1), (SELECT COUNT(*) FROM "Novel"), (SELECT COUNT(*) FROM "Novel" WHERE "status" = 'finished')`,
		[]any{&featured, &hot, &all, &finished}); err != nil {
		return map[string]int64{}
	}
	clamp := func(v int64) int64 {
		if v > webModuleShowCount {
			return webModuleShowCount
		}
		return v
	}
	return map[string]int64{
		"featured": clamp(featured), "hot": clamp(hot), "latest": clamp(all),
		"rank-clicks": clamp(all), "rank-updates": clamp(all), "finished": clamp(finished),
	}
}
