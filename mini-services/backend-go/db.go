/**
 * backend-go —— SQLite 访问层（modernc.org/sqlite 纯 Go 驱动，免 cgo）。
 *
 * 直接读写业务库 db/custom.db（schema 由运行时 DDL 幂等管理 + seed/seed.json 播种）：
 * - WAL + busy_timeout(5s) + foreign_keys(1)：跨进程安全（本服务是唯一业务写入方，
 *   scraper-go 引擎不碰业务库）
 * - Task 32-b 性能设定：cache_size=-32000(32MB)、mmap_size=256MB、temp_store=MEMORY、
 *   wal_autocheckpoint=1000（在 WAL/busy_timeout/foreign_keys/synchronous 基础上补齐，
 *   DSN 级 pragma 对连接池内每条连接生效）
 * - DSN 经 DB_PATH 环境变量可覆盖
 * - helpers：queryOne/queryList/exec/execReturningID + JSON 列读写
 */
package main

import (
	"database/sql"
	"errors"
	"fmt"
	"log"
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
		// Task 32-b: 性能 pragma —— cache_size=-32000（32MB 页缓存）、mmap_size=256MB、
		// temp_store=MEMORY、wal_autocheckpoint=1000（WAL 每 1000 页 checkpoint，
		// 防长跑采集 WAL 无限膨胀）。其余 busy_timeout/WAL/foreign_keys/synchronous 原样保留
		dsn := fmt.Sprintf(
			"file:%s?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_pragma=synchronous(NORMAL)"+
				"&_pragma=cache_size(-32000)&_pragma=mmap_size(268435456)&_pragma=temp_store(MEMORY)&_pragma=wal_autocheckpoint(1000)",
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
		// Task 39: 纯 Go 全量建表引导（必须最先执行）——历史表结构由 Prisma 建库保证，
		// Task 38 移除 Prisma 后全新库文件只有空 schema，seed 播种与业务 SQL 全瘫
		// （第 8 次沙箱回收整库文件被删实证）。同步建表先于 startSeedIfEmpty 的异步播种。
		// 存量库全部 IF NOT EXISTS 空操作，零影响。
		if err := ensureBaseSchema(db); err != nil {
			log.Printf("[db] 基础 schema 建表失败（业务表缺失将不可用）: %v", err)
		}
		// Task 30-a fix(30 main): 站群站点档案表幂等建表 —— 必须在 once 回调内用局部 db 直接建表。
		// 旧版在 once 外调 ensureSiteSiteTable()→exec→getDB→再次 ensureSiteSiteTable，
		// siteSiteOnce.Do 未完成时重入 → sync.Once 递归自锁（panic dump 实证：goroutine 卡
		// doSlow 双栈）；任何首次 getDB 的路径都会死锁（含生产启动）。
		if _, err := db.Exec(siteSiteDDL); err != nil {
			log.Printf("[db] SiteSite 建表失败（站群功能不可用，默认站点不受影响）: %v", err)
		}
		// Task 32-b: Chapter 垂直分表 —— 正文大字段分离到 ChapterContent，
		// TOC/列表等高频查询不再拖 content blob。建表/加列/存量迁移全部在 once
		// 回调内用局部 db 直接 Exec（Task 30 P1 死锁教训：严禁 once 外再调 getDB）
		if _, err := db.Exec(chapterContentDDL); err != nil {
			log.Printf("[db] ChapterContent 建表失败（正文退化存储于 Chapter.content，COALESCE 读路径兼容）: %v", err)
		}
		if err := ensureColumn(db, "ScrapeTask", "storageMode",
			`ALTER TABLE "ScrapeTask" ADD COLUMN "storageMode" TEXT NOT NULL DEFAULT 'db'`); err != nil {
			log.Printf("[db] ScrapeTask.storageMode 加列失败（TXT 存储模式不可用，默认 db 不受影响）: %v", err)
		}
		// Task 40: PseoKeyword 书籍页标签两列（kwNorm 归一形/seed 血缘）——存量库幂等加列
		if err := ensureColumn(db, "PseoKeyword", "kwNorm",
			`ALTER TABLE "PseoKeyword" ADD COLUMN "kwNorm" TEXT NOT NULL DEFAULT ''`); err != nil {
			log.Printf("[db] PseoKeyword.kwNorm 加列失败（书籍页标签归一匹配降级为严格子串）: %v", err)
		}
		if err := ensureColumn(db, "PseoKeyword", "seed",
			`ALTER TABLE "PseoKeyword" ADD COLUMN "seed" TEXT NOT NULL DEFAULT ''`); err != nil {
			log.Printf("[db] PseoKeyword.seed 加列失败（书籍页标签血缘直取降级为归一匹配）: %v", err)
		}
		// Task 40: 存量词一次性归一回填（幂等：只扫 kwNorm='' 行；空池零开销）
		if err := backfillPseoKeywordNorm(db); err != nil {
			log.Printf("[db] PseoKeyword.kwNorm 存量回填失败（书籍页标签归一匹配暂不可用，重启重试）: %v", err)
		}
		// Task 41: 存量简介噪声清洗回填（幂等：cleanNovelIntro 幂等保证已清洗行零写放大；
		// 「相关小说」尾块转换进 PseoKeyword）。失败不阻断启动，下次重启重试
		if err := backfillNovelIntroClean(db); err != nil {
			log.Printf("[db] 简介噪声清洗回填失败（存量简介噪声暂存，重启重试）: %v", err)
		}
		// 存量正文迁移（幂等、分批 500 行防长锁；空库秒级完成，存量 3.5 万章首次启动秒级~十秒级）
		if err := migrateChapterContentSplit(db); err != nil {
			log.Printf("[db] Chapter 存量正文迁移 ChapterContent 失败（存量正文仍可经 COALESCE 读取）: %v", err)
		}
	})
	return gDB, gDBError
}

// chapterContentDDL Chapter 垂直分表（Task 32-b）：正文大字段独立表，chapterId 单列主键。
// 主键设计修正（主线集成审查）：**不用 (novelId,idx) 复合主键**——idx 可变（章节重排序工具
// 会临时改写为负数再重排；并发入库冲突时序号顺延），以 idx 作键正文会错位/成孤儿；
// chapterId（Chapter.id 自增主键）终生不变，级联链 Novel→Chapter→ChapterContent 双跳
// ON DELETE CASCADE 在 SQLite 下逐级触发，章删除/书删除正文自动清理。该表由 Go 侧
// 运行时幂等建表管理（SiteSite 先例），表结构即本文件 DDL 为准。
const chapterContentDDL = `CREATE TABLE IF NOT EXISTS "ChapterContent" (
        "chapterId" INTEGER NOT NULL PRIMARY KEY,
        "content" TEXT NOT NULL DEFAULT '',
        FOREIGN KEY ("chapterId") REFERENCES "Chapter"("id") ON DELETE CASCADE
)`

// ensureColumn 幂等加列助手（Task 32-b）：PRAGMA table_info 检查列不存在则 ALTER TABLE ADD COLUMN。
// 表不存在（0 行返回）时静默跳过——生产库由 ensureBaseSchema（schema.go，Task 39 起）
// 同步建表保证存在；测试环境先 getDB 后建表的场景由测试自行在建表后调用本函数补列。
// ⚠ 必须在 getDB once 回调内用传入的局部 *sql.DB 调用（Task 30 P1 死锁教训）。
func ensureColumn(db *sql.DB, table, column, alterDDL string) error {
	rows, err := db.Query(`PRAGMA table_info("` + table + `")`)
	if err != nil {
		return err
	}
	defer rows.Close()
	seen, exists := 0, false
	for rows.Next() {
		var cid, notNull, pk int
		var name, ctype string
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &ctype, &notNull, &dflt, &pk); err != nil {
			return err
		}
		seen++
		if name == column {
			exists = true
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if seen == 0 || exists { // seen==0 = 表不存在；exists = 列已在
		return nil
	}
	_, err = db.Exec(alterDDL)
	return err
}

// migrateChapterContentSplit 存量正文迁移（Task 32-b 垂直分表，幂等）：
// 把 Chapter.content 非空的行分批（500/批防长锁）INSERT OR IGNORE 进 ChapterContent，
// 随即清空同键 Chapter.content（分表后 ChapterContent 为正文主存储，Chapter.content
// 保留列位作兼容回落）。在 getDB once 回调内同步执行：空库秒级完成；存量库首次启动
// 多花几秒可接受。终止条件=插入与清零双零（上一轮已收敛）；重复调用零操作。
func migrateChapterContentSplit(db *sql.DB) error {
	for i := 0; i < 1_000_000; i++ { // 硬上限防异常死循环（35 万章也只需 ~700 轮）
		res, err := db.Exec(`INSERT OR IGNORE INTO "ChapterContent" ("chapterId","content")
                        SELECT "id","content" FROM "Chapter" WHERE length("content") > 0 ORDER BY "id" LIMIT 500`)
		if err != nil {
			return err
		}
		inserted, _ := res.RowsAffected()
		// 清零条件=该 (novelId,idx) 已有 ChapterContent 行：本轮插入的行即刻清零，
		// 此前已迁移/已由新写路径落分表的遗留行同样收敛（幂等关键）
		res2, err := db.Exec(`UPDATE "Chapter" SET "content" = ''
                        WHERE length("content") > 0 AND EXISTS (
                                SELECT 1 FROM "ChapterContent" cc WHERE cc."chapterId" = "Chapter"."id")`)
		if err != nil {
			return err
		}
		cleared, _ := res2.RowsAffected()
		if inserted == 0 && cleared == 0 {
			return nil
		}
	}
	return fmt.Errorf("迁移循环超出硬上限（异常数据形态）")
}

// siteSiteDDL 站群站点档案表（Task 30-a「站群模式」：一库多站按 Host 分站点渲染）。
//
// 该表不在 Prisma schema 管辖内（db:push 不感知），由 Go 侧运行时幂等建表：
//   - CREATE TABLE IF NOT EXISTS：重复启动/隔离实例安全；
//   - 列风格对齐 SiteSetting（siteName/activeTheme/notice + seoConfig/footerConfig/homeConfig
//     三列 JSON 文本 + enabled 开关），时间戳为毫秒 INTEGER（nowMillis 口径）；
//   - host 唯一（精确匹配键，resolveSite 唯一查询路径），空串/带协议端口由 api_sites.go 写入校验拦截；
//   - 建表失败仅告警不阻断启动（resolveSite 查询失败自动回落 SiteSetting 默认站点，fail-open）。
const siteSiteDDL = `CREATE TABLE IF NOT EXISTS "SiteSite" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "host" TEXT NOT NULL UNIQUE,
        "siteName" TEXT NOT NULL DEFAULT '',
        "activeTheme" TEXT NOT NULL DEFAULT 'aijjxs',
        "notice" TEXT NOT NULL DEFAULT '',
        "seoConfig" TEXT NOT NULL DEFAULT '{}',
        "footerConfig" TEXT NOT NULL DEFAULT '{}',
        "homeConfig" TEXT NOT NULL DEFAULT '{}',
        "enabled" INTEGER NOT NULL DEFAULT 1,
        "createdAt" INTEGER NOT NULL DEFAULT 0,
        "updatedAt" INTEGER NOT NULL DEFAULT 0
)`

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

// ---------- 时间 helpers ----------

// nowMillis 当前时间（Prisma DateTime 兼容：SQLite 存 ms 整数。
// createdAt/updatedAt 由 SQL 默认或显式写入）
func nowMillis() int64 {
	return time.Now().UnixMilli()
}
