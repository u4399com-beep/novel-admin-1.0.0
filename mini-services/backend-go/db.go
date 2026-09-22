/**
 * backend-go —— SQLite 访问层（modernc.org/sqlite 纯 Go 驱动，免 cgo）。
 *
 * 直接读写主站既有库 db/custom.db（Prisma 建库，表结构见 prisma/schema.prisma）：
 * - WAL + busy_timeout(5s) + foreign_keys(1)：跨进程安全（本服务是唯一业务写入方，
 *   scraper-go 引擎不碰业务库）
 * - DSN 经 DB_PATH 环境变量可覆盖
 * - helpers：queryOne/queryList/exec/execReturningID + JSON 列读写
 */
package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

var (
	gDB      *sql.DB
	gDBOnce  sync.Once
	gDBError error
)

// dbPath 业务库路径（与主站共用一个文件）
func dbPath() string {
	if p := os.Getenv("DB_PATH"); p != "" {
		return p
	}
	return "/home/z/my-project/db/custom.db"
}

// getDB 打开共享连接（惰性；进程内单例）
func getDB() (*sql.DB, error) {
	gDBOnce.Do(func() {
		dsn := fmt.Sprintf(
			"file:%s?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_pragma=synchronous(NORMAL)",
			dbPath(),
		)
		db, err := sql.Open("sqlite", dsn)
		if err != nil {
			gDBError = err
			return
		}
		// WAL 下读写可并发；连接数上限防写锁风暴（SQLite 单写者，写串行由 busy_timeout 兜底）
		db.SetMaxOpenConns(4)
		db.SetMaxIdleConns(4)
		db.SetConnMaxLifetime(0)
		// 探活
		if err := db.Ping(); err != nil {
			gDBError = fmt.Errorf("SQLite 打开失败(%s): %v", dbPath(), err)
			return
		}
		gDB = db
	})
	return gDB, gDBError
}

// isUniqueConflict SQLite unique 冲突（modernc 驱动错误消息含 UNIQUE constraint failed）。
// ⚠ 只认 "unique"：宽泛匹配 "constraint" 会把 FOREIGN KEY constraint failed / CHECK constraint
// failed 误判为唯一冲突，触发错误的并发回读/顺延 idx 语义（如 upsertBook 把分类外键失败
// 报成「并发入库冲突」、骨架入库把外键失败误入逐条顺延路径）。
func isUniqueConflict(err error) bool {
	if err == nil {
		return false
	}
	return containsFoldStr(err.Error(), "unique")
}

// containsFoldStr 大小写不敏感包含
func containsFoldStr(s, sub string) bool {
	return len(s) >= len(sub) && stringsIndexFold(s, sub) >= 0
}

func stringsIndexFold(s, sub string) int {
	n := len(sub)
	if n == 0 {
		return 0
	}
	for i := 0; i+n <= len(s); i++ {
		if equalFoldStr(s[i:i+n], sub) {
			return i
		}
	}
	return -1
}

func equalFoldStr(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := 0; i < len(a); i++ {
		ca, cb := a[i], b[i]
		if 'A' <= ca && ca <= 'Z' {
			ca += 32
		}
		if 'A' <= cb && cb <= 'Z' {
			cb += 32
		}
		if ca != cb {
			return false
		}
	}
	return true
}

// ---------- 查询 helpers ----------

// queryOne 查单行并 scan 到 dest（sql.ErrNoRows 原样返回，调用方用 errors.Is 判断）
func queryOne(query string, dest []any, args ...any) error {
	db, err := getDB()
	if err != nil {
		return err
	}
	return db.QueryRow(query, args...).Scan(dest...)
}

// queryList 查多行；iter 为每行回调（args → Scan 顺序）
func queryList(query string, scan func(rows *sql.Rows) error, args ...any) error {
	db, err := getDB()
	if err != nil {
		return err
	}
	rows, err := db.Query(query, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		if err := scan(rows); err != nil {
			return err
		}
	}
	return rows.Err()
}

// exec 执行写语句
func exec(query string, args ...any) (sql.Result, error) {
	db, err := getDB()
	if err != nil {
		return nil, err
	}
	return db.Exec(query, args...)
}

// execReturningID 执行 INSERT 并返回 last_insert_rowid
func execReturningID(query string, args ...any) (int64, error) {
	res, err := exec(query, args...)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// isNoRows 判断是否「查询无行」
func isNoRows(err error) bool {
	return errors.Is(err, sql.ErrNoRows)
}

// ---------- JSON 列 helpers ----------

// jsonColumn 读取 JSON 文本列 → map（空/损坏一律得空 map，与 safeParseRule 同语义）
func jsonColumn(s sql.NullString) map[string]string {
	out := map[string]string{}
	if !s.Valid || s.String == "" {
		return out
	}
	var raw map[string]any
	if err := json.Unmarshal([]byte(s.String), &raw); err != nil {
		return out
	}
	for k, v := range raw {
		if sv, ok := v.(string); ok && sv != "" {
			out[k] = sv
		}
	}
	return out
}

// marshalJSONColumn map → JSON 文本（空 map 存 "{}"）
func marshalJSONColumn(m map[string]string) string {
	if m == nil {
		m = map[string]string{}
	}
	b, _ := json.Marshal(m)
	return string(b)
}

// nowStr 当前时间（Prisma DateTime 兼容：SQLite 存 ms epoch 数字或 ISO 文本？
// Prisma SQLite 实际存 ms 整数。createdAt/updatedAt 由 SQL 默认或显式写入）
func nowMillis() int64 {
	return time.Now().UnixMilli()
}
