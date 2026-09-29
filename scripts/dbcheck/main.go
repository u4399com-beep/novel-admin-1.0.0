/**
 * dbcheck —— 沙箱重置后 DB 恢复诊断/修复工具（一次性运维工具）。
 *
 * 背景：Task 60 恢复轮发现环境整机回收后 db/custom.db 主库打开报 malformed(11)。
 * 本工具以只读方式跑 PRAGMA integrity_check / quick_check 定位损伤面；
 * dump-tables 模式逐表 COUNT 探明可读范围；recover 模式逐表可读性扫描。
 *
 * 用法：go run ./scripts/dbcheck <dbpath> [integrity|dump-tables|recover]
 */
package main

import (
        "database/sql"
        "fmt"
        "os"
        "strings"

        _ "modernc.org/sqlite"
)

func main() {
        if len(os.Args) < 3 {
                fmt.Println("usage: dbcheck <dbpath> [integrity|dump-tables|recover]")
                os.Exit(2)
        }
        dsn := os.Args[1]
        mode := os.Args[2]

        switch mode {
        case "integrity":
                // 只读 + immutable：绝不触碰源文件
                db, err := sql.Open("sqlite", dsn+"?mode=ro&immutable=1")
                must(err)
                defer db.Close()
                for _, pragma := range []string{"PRAGMA quick_check(50)", "PRAGMA integrity_check(50)"} {
                        fmt.Println("== " + pragma + " ==")
                        rows, err := db.Query(pragma)
                        must(err)
                        n := 0
                        for rows.Next() {
                                var s string
                                must(rows.Scan(&s))
                                fmt.Println(s)
                                n++
                        }
                        must(rows.Err())
                        rows.Close()
                        if n == 0 {
                                fmt.Println("(no rows)")
                        }
                }
        case "dump-tables":
                db, err := sql.Open("sqlite", dsn+"?mode=ro&immutable=1")
                must(err)
                defer db.Close()
                rows, err := db.Query(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
                must(err)
                var tables []string
                for rows.Next() {
                        var s string
                        must(rows.Scan(&s))
                        tables = append(tables, s)
                }
                rows.Close()
                for _, t := range tables {
                        var cnt int64
                        err := db.QueryRow(`SELECT COUNT(*) FROM ` + quoteIdent(t)).Scan(&cnt)
                        if err != nil {
                                fmt.Printf("%-28s ERR %v\n", t, err)
                        } else {
                                fmt.Printf("%-28s %d\n", t, cnt)
                        }
                }
        case "schema":
                // 打印表 DDL（sqlite_master.sql）
                db, err := sql.Open("sqlite", dsn+"?mode=ro&immutable=1")
                must(err)
                defer db.Close()
                rows, err := db.Query(`SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name`)
                must(err)
                for rows.Next() {
                        var name, ddl string
                        must(rows.Scan(&name, &ddl))
                        if len(os.Args) > 3 && os.Args[3] != name {
                                continue
                        }
                        fmt.Printf("--- %s ---\n%s\n", name, ddl)
                }
                must(rows.Err())
        case "sql":
                // 只读执行任意 SQL（限 SELECT/PRAGMA），打印前 N 行
                db, err := sql.Open("sqlite", dsn+"?mode=ro&immutable=1")
                must(err)
                defer db.Close()
                rows, err := db.Query(os.Args[3])
                must(err)
                defer rows.Close()
                cols, err := rows.Columns()
                must(err)
                fmt.Println(strings.Join(cols, " | "))
                vals := make([]any, len(cols))
                ptrs := make([]any, len(cols))
                for i := range vals {
                        ptrs[i] = &vals[i]
                }
                n := 0
                for rows.Next() {
                        must(rows.Scan(ptrs...))
                        parts := make([]string, len(cols))
                        for i, v := range vals {
                                if b, ok := v.([]byte); ok {
                                        parts[i] = string(b)
                                } else {
                                        parts[i] = fmt.Sprintf("%v", v)
                                }
                        }
                        fmt.Println(strings.Join(parts, " | "))
                        n++
                        if n >= 30 {
                                break
                        }
                }
                must(rows.Err())
        case "recover":
                // 逐表全量可读性扫描：报哪张表能整读。
                db, err := sql.Open("sqlite", dsn+"?mode=ro&immutable=1")
                must(err)
                defer db.Close()
                rows, err := db.Query(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
                must(err)
                var tables []string
                for rows.Next() {
                        var s string
                        must(rows.Scan(&s))
                        tables = append(tables, s)
                }
                rows.Close()
                okN, badN := 0, 0
                for _, t := range tables {
                        r2, err := db.Query(`SELECT * FROM ` + quoteIdent(t) + ` LIMIT 1`)
                        if err != nil {
                                fmt.Printf("BAD  %s: %v\n", t, err)
                                badN++
                        } else {
                                r2.Close()
                                okN++
                        }
                }
                fmt.Printf("readable=%d bad=%d\n", okN, badN)
        default:
                fmt.Println("unknown mode:", mode)
                os.Exit(2)
        }
}

func quoteIdent(s string) string {
        return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
}

func must(err error) {
        if err != nil {
                fmt.Fprintln(os.Stderr, "ERR:", err)
                os.Exit(1)
        }
}
