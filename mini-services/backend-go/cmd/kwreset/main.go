/**
 * kwreset —— PSEO 书名种子重富集维护工具（Task D：书籍页标签丰富度根治）。
 *
 * 背景：存量书名种子的富集窗口内引擎瞬时故障（连续 3 次全败有界重试后放弃，
 * 见 pseo_book.go enrichRetryMax），血缘下拉词永久缺失——书籍页标签退化为
 * 书名+作者+衍生词兜底，真实搜索下拉词为零。实测引擎恢复后，无需改代码：
 * 把血缘词不足的书名种子重置回 pending，后台富集循环（enrichBatchSize=4，
 * 12s/批）自动重新取词入库（INSERT OR IGNORE 幂等，血缘 seed=书名照常落库）。
 *
 * 判定：source='book' 且 status='generated' 且「generated 血缘词数 < 阈值」。
 * 血缘词 = PseoKeyword 中 seed = 该种子 keyword 且 status='generated' 的行
 * （种子自身行 seed='' 恒不计入）。阈值默认 8（对齐 novelPseoTags 衍生词
 * 兜底线，低于 8 的书页标签以合成词为主、真实词贫瘠）。
 *
 * 用法：
 *   go run ./cmd/kwreset <db-path>            # 预览（dry-run，只打印将重置的种子）
 *   go run ./cmd/kwreset <db-path> -apply     # 实际执行重置
 *   go run ./cmd/kwreset <db-path> -apply -min 8 -limit 2000
 *
 * 安全：幂等（重复执行零重置）；单条 UPDATE 事务；busy_timeout 防与活库写冲突；
 * 只触碰 source='book' 行，词池/intro/手工词绝不波及。
 */
package main

import (
	"database/sql"
	"flag"
	"fmt"
	"os"

	_ "modernc.org/sqlite"
)

func main() {
	apply := flag.Bool("apply", false, "实际执行重置（缺省 dry-run 预览）")
	minLineage := flag.Int("min", 8, "血缘词数低于该值的种子才重置")
	limit := flag.Int("limit", 5000, "单次最多重置的种子数")
	flag.Parse()
	if flag.NArg() < 1 {
		fmt.Fprintln(os.Stderr, "用法: kwreset <db-path> [-apply] [-min 8] [-limit 2000]")
		os.Exit(2)
	}
	db, err := sql.Open("sqlite", flag.Arg(0)+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)")
	if err != nil {
		fmt.Fprintln(os.Stderr, "open:", err)
		os.Exit(1)
	}
	defer db.Close()

	rows, err := db.Query(`
		SELECT p."id", p."keyword",
		       (SELECT COUNT(*) FROM "PseoKeyword" q WHERE q."seed" = p."keyword" AND q."status" = 'generated') AS lineage
		FROM "PseoKeyword" p
		WHERE p."source" = 'book' AND p."status" = 'generated' AND p."keyword" != ''
		GROUP BY p."id"
		HAVING lineage < ?
		ORDER BY p."id" ASC LIMIT ?`, *minLineage, *limit)
	if err != nil {
		fmt.Fprintln(os.Stderr, "query:", err)
		os.Exit(1)
	}
	type row struct {
		id      int64
		keyword string
		lineage int
	}
	targets := []row{}
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.id, &r.keyword, &r.lineage); err != nil {
			rows.Close()
			fmt.Fprintln(os.Stderr, "scan:", err)
			os.Exit(1)
		}
		targets = append(targets, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		fmt.Fprintln(os.Stderr, "rows:", err)
		os.Exit(1)
	}

	fmt.Printf("[kwreset] 血缘词<%d 的 book 种子: %d 个\n", *minLineage, len(targets))
	for i, r := range targets {
		if i < 10 {
			fmt.Printf("  #%d lineage=%d %q\n", r.id, r.lineage, truncate(r.keyword, 36))
		}
	}
	if len(targets) > 10 {
		fmt.Printf("  ...（其余 %d 个略）\n", len(targets)-10)
	}
	if !*apply {
		fmt.Println("[kwreset] dry-run 结束（加 -apply 执行重置）")
		return
	}

	tx, err := db.Begin()
	if err != nil {
		fmt.Fprintln(os.Stderr, "begin:", err)
		os.Exit(1)
	}
	stmt, err := tx.Prepare(`UPDATE "PseoKeyword" SET "status" = 'pending', "updatedAt" = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE "id" = ?`)
	if err != nil {
		fmt.Fprintln(os.Stderr, "prepare:", err)
		os.Exit(1)
	}
	n := 0
	for _, r := range targets {
		if _, err := stmt.Exec(r.id); err != nil {
			fmt.Fprintln(os.Stderr, "exec:", err)
			_ = tx.Rollback()
			os.Exit(1)
		}
		n++
	}
	_ = stmt.Close()
	if err := tx.Commit(); err != nil {
		fmt.Fprintln(os.Stderr, "commit:", err)
		os.Exit(1)
	}
	fmt.Printf("[kwreset] 已重置 %d 个种子为 pending（富集循环将按 4 种子/12s 重新取词）\n", n)
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}
