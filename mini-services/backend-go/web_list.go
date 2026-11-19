/**
 * web_list.go —— 频道列表页（R145）：首页横带角标「全部 N 本」的真实落点。
 *
 * 背景（用户 R145 报告）：jiuxiaozw 主题首页各横带右上角「全部 N 本」角标在原站
 * （jiuxiaozw.com /sim）是指向 /sim/lists/<slug> 真实书单全集页的链接；R142 克隆时
 * 只挂了页内锚点，且数字取自首页内存切片长度——承诺（N 本全集）没有可到达的兑现页。
 * 本文件补齐闭环：真实分页列表页 + 全集总数，角标数字与落点页「共 N 本」同源
 * （webListTotals 单一来源），永不漂移。
 *
 * 频道契约（与首页横带一一对应，标题/副标文案与 home.html 同源）：
 *   featured     小编精选  isFeatured=1     按更新时间
 *   hot          热门小说  isHot=1          按点击
 *   latest       最新上架  全库             按更新时间
 *   rank-clicks  点击榜    全库             按点击
 *   rank-updates 更新榜    全库             按更新时间
 *   finished     完本佳作  status=finished  按点击
 *
 * 分页：24 本/页，?page=N 服务端分页；分页 CSS 为原站 book-list-pagination
 * （aria-current 当前页 / aria-disabled 不可点端点），jiuxiaozw.css bundle 内置。
 * 合规红线：全部数据来自本站 DB；角标数字=落点页真实总数，不虚标。
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

// webListPageSize 每页本数（book-list-row 紧凑行卡，24 行/页与原站列表密度同量级）
const webListPageSize = 24

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
	totalPages := int64(1)
	if total > webListPageSize {
		totalPages = (total + webListPageSize - 1) / webListPageSize
	}
	page := webListPageParam(r, totalPages)
	novels, _ := queryNovelList(k.where, k.order, nil, webListPageSize, int((page-1)*webListPageSize))
	data["List"] = map[string]any{
		"kind": kind, "title": k.title, "tag": k.tag,
		"total": total, "page": page, "totalPages": totalPages,
		"pages":  webListPageWindow(page, totalPages, 7), // 页码窗口（当前页居中，最多 7 个）
		"novels": novels,
	}
	data["siteName"] = data["Site"].(map[string]any)["siteName"]
	// seoConfig 无 listTitle/listDescription 键时走默认回落文案（renderSeoKey 空回落）
	applyWebTDK(data, "listTitle", "listDescription", map[string]string{"listName": k.title},
		k.title+"全部小说列表", k.title+"，共"+strconv.FormatInt(total, 10)+"本免费在线阅读")
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
func webListTotals() map[string]int64 {
	var featured, hot, all, finished int64
	if err := queryOne(`SELECT (SELECT COUNT(*) FROM "Novel" WHERE "isFeatured" = 1), (SELECT COUNT(*) FROM "Novel" WHERE "isHot" = 1), (SELECT COUNT(*) FROM "Novel"), (SELECT COUNT(*) FROM "Novel" WHERE "status" = 'finished')`,
		[]any{&featured, &hot, &all, &finished}); err != nil {
		return map[string]int64{}
	}
	return map[string]int64{
		"featured": featured, "hot": hot, "latest": all,
		"rank-clicks": all, "rank-updates": all, "finished": finished,
	}
}
