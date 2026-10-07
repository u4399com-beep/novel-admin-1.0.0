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
        "path/filepath"
        "sync"
        "sync/atomic"
        "time"

        _ "modernc.org/sqlite"
)

var (
        gDB      *sql.DB
        gDBOnce  sync.Once
        gDBError error
)

// dbPath 业务库路径（与主站共用一个文件）：DB_PATH env > {repoRoot}/db/custom.db
// （可执行文件位置推断，任意部署路径自适应）> 沙箱默认（repoRoot 兑底同值）
func dbPath() string {
        if p := os.Getenv("DB_PATH"); p != "" {
                return p
        }
        return filepath.Join(repoRoot(), "db", "custom.db")
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
                // Task 47: 一次性迁移守卫标记表（backfillT2SExisting 存量繁转简回填进度）
                if _, err := db.Exec(appMetaDDL); err != nil {
                        log.Printf("[db] AppMeta 建表失败（t2s 存量回填守卫降级为每次启动重扫，幂等零写放大）: %v", err)
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
                // Task 45-b: Chapter.volume 分卷列（存量库幂等加列，Task 40 kwNorm/seed 先例）
                // Task 60-R18 顺序根修：schema 迁移必须全部先于数据回填——旧快照库实证
                // backfillT2SExisting 先于 volume 加列执行 → UPDATE 命中 no such column，
                // 整条 t2s 存量回填链在 boot 即废（重启重试永远失败）。
                if err := ensureColumn(db, "Chapter", "volume",
                        `ALTER TABLE "Chapter" ADD COLUMN "volume" TEXT NOT NULL DEFAULT ''`); err != nil {
                        log.Printf("[db] Chapter.volume 加列失败（分卷分组渲染降级为平铺，功能不受影响）: %v", err)
                }
                // Task 50: Novel.coverSrc 源站封面 URL（封面补抓通道的数据源；存量库幂等加列）
                if err := ensureColumn(db, "Novel", "coverSrc",
                        `ALTER TABLE "Novel" ADD COLUMN "coverSrc" TEXT NOT NULL DEFAULT ''`); err != nil {
                        log.Printf("[db] Novel.coverSrc 加列失败（封面补抓降级为重采驱动）: %v", err)
                }
                // Task 53: ScrapeRule.cookies 规则级静态 cookie 底座（人工过验会话；存量库幂等加列）
                if err := ensureColumn(db, "ScrapeRule", "cookies",
                        `ALTER TABLE "ScrapeRule" ADD COLUMN "cookies" TEXT NOT NULL DEFAULT ''`); err != nil {
                        log.Printf("[db] ScrapeRule.cookies 加列失败（规则 cookie 底座不可用，采集不受影响）: %v", err)
                }
                // R97: SiteSetting 三列——全局代理池（proxyPool，规则无自有池时兜底出口）+
                // TXT/封面自定义存储目录（txtDir/coversDir，空=默认 repoRoot 相对路径）。
                // 存量库幂等加列（Task 40/45-b 先例）。
                if err := ensureColumn(db, "SiteSetting", "proxyPool",
                        `ALTER TABLE "SiteSetting" ADD COLUMN "proxyPool" TEXT NOT NULL DEFAULT ''`); err != nil {
                        log.Printf("[db] SiteSetting.proxyPool 加列失败（全局代理池设置不可用，按规则级代理运行）: %v", err)
                }
                if err := ensureColumn(db, "SiteSetting", "txtDir",
                        `ALTER TABLE "SiteSetting" ADD COLUMN "txtDir" TEXT NOT NULL DEFAULT ''`); err != nil {
                        log.Printf("[db] SiteSetting.txtDir 加列失败（TXT 自定义目录不可用，按默认路径运行）: %v", err)
                }
                if err := ensureColumn(db, "SiteSetting", "coversDir",
                        `ALTER TABLE "SiteSetting" ADD COLUMN "coversDir" TEXT NOT NULL DEFAULT ''`); err != nil {
                        log.Printf("[db] SiteSetting.coversDir 加列失败（封面自定义目录不可用，按默认路径运行）: %v", err)
                }
                // Task 60-R18: ScrapeRule.insecureTLS 跳过证书校验开关（存量库幂等加列）。
                // 历史缺陷：列缺失时 web_data 的 SELECT 中带引号标识符 "insecureTLS" 被 SQLite
                // DQS 特性当字符串字面量返回（每行值='insecureTLS'）→ /api/scrape-rules Scan
                // bool 失败 500，规则面板全瘫。schema.go:114 仅保证新库；存量库必须幂等加列。
                if err := ensureColumn(db, "ScrapeRule", "insecureTLS",
                        `ALTER TABLE "ScrapeRule" ADD COLUMN "insecureTLS" BOOLEAN NOT NULL DEFAULT false`); err != nil {
                        log.Printf("[db] ScrapeRule.insecureTLS 加列失败（规则 TLS 开关不可用，采集不受影响）: %v", err)
                }
                // Task 60-R22: SiteSetting.homeConfig 首页自定义区块配置（存量库幂等加列）。
                // 同 DQS 缺陷族第二例：列缺失时 seed.go/api_settings.go 的 SELECT "homeConfig"
                // 拿到字符串字面量 → seed 静默跳过默认三区块写入（首页「热门推荐」空），
                // api_settings GET 降级空块。加列后 seed 下次启动自动补写默认块。
                if err := ensureColumn(db, "SiteSetting", "homeConfig",
                        `ALTER TABLE "SiteSetting" ADD COLUMN "homeConfig" TEXT NOT NULL DEFAULT '{}'`); err != nil {
                        log.Printf("[db] SiteSetting.homeConfig 加列失败（首页自定义区块降级空块）: %v", err)
                }
                // ===== 以下为数据回填链（Task 60-R18 起与 schema 迁移严格分层）=====
                // Task 40: 存量词一次性归一回填（幂等：只扫 kwNorm='' 行；空池零开销）
                if err := backfillPseoKeywordNorm(db); err != nil {
                        log.Printf("[db] PseoKeyword.kwNorm 存量回填失败（书籍页标签归一匹配暂不可用，重启重试）: %v", err)
                }
                // Task 47: 存量数据繁转简一次性回填（AppMeta 守卫；分类/书字段/章题/关键词
                // 同步面 + 正文大表后台 goroutine 分批转换；幂等零写放大。置于简介清洗回填
                // 之前——繁体简介先转简，本轮简介清洗同 boot 即可对转换后文本提取长尾词）
                if err := backfillT2SExisting(db); err != nil {
                        log.Printf("[db] t2s 存量回填失败（存量繁体字段暂存，重启重试）: %v", err)
                }
                // Task 41: 存量简介噪声清洗回填（幂等：cleanNovelIntro 幂等保证已清洗行零写放大；
                // 「相关小说」尾块转换进 PseoKeyword）。失败不阻断启动，下次重启重试
                if err := backfillNovelIntroClean(db); err != nil {
                        log.Printf("[db] 简介噪声清洗回填失败（存量简介噪声暂存，重启重试）: %v", err)
                }
                // Task 66-②: 全新库 stale 封面清理（必须先于缺失自愈——先清错位旧文件，
                // 缺失自愈才能看见断裂并重置渐变 token）。时序根修：整机回收后 DB 空库
                // 重建而 covers 运行时产物残留时，旧 {id}.jpg 挂新库同 id 新书（张冠李戴，
                // 第 6 次回收 2946 个残留实证），且「文件存在即健康」自愈判定对错位失明
                purgeStaleCoversOnFreshDB(db)
                // R98: 封面命名归位（/covers/{id}.jpg 契约）——本地形态 cover 与书籍 id
                // 脱钩的存量行改写指针 + 安全 rename（「文件存在即健康」的缺失自愈对指针
                // 脱钩失明）。必须先于 backfillBrokenCoverLocal：归位后目标仍缺失的行由
                // 其重置渐变 token 交补抓通道重建
                normalizeCoverNames(db)
                // Task 60-R20: 本地封面文件缺失自愈（运行时产物 public/covers/ 被环境重置清空
                // 的实证场景）——本地形态 cover 指向的文件不存在时重置渐变 token，渲染层即刻
                // 恢复；重置行自动落入补抓候选面（token+coverSrc≠''），与补抓通道双层闭环
                if err := backfillBrokenCoverLocal(db); err != nil {
                        log.Printf("[db] 本地封面缺失自愈失败（裂图暂存，重启重试）: %v", err)
                }
                // R84: 垃圾 coverSrc 清洗（源站模板 bug：图床域名拼接 None 字面量恒 404，
                // 实证 img22.ixdzs.com/None）——与提取层拒绝（scraper-go reGarbageCoverSrc
                // 同族判定）双层闭环。失败不阻断启动
                sanitizeGarbageCoverSrc(db)
                // Task 45-b: 存量章节「第X卷」前缀回填（幂等：只处理命中行且与入库链路
                // detectVolume 同口径，回填后存量标题与新采集标题归一一致——Phase 2 续传按
                // 标题匹配空骨架，双侧口径必须一致）。失败不阻断启动，重启重试
                if err := backfillChapterVolume(db); err != nil {
                        log.Printf("[db] Chapter.volume 存量回填失败（存量卷前缀标题暂存，重启重试）: %v", err)
                }
                // 存量正文迁移（幂等、分批 500 行防长锁；空库秒级完成，存量 3.5 万章首次启动秒级~十秒级）
                if err := migrateChapterContentSplit(db); err != nil {
                        log.Printf("[db] Chapter 存量正文迁移 ChapterContent 失败（存量正文仍可经 COALESCE 读取）: %v", err)
                }
                // R97：boot 完成门闩——backfillBrokenCoverLocal 等 boot 链步骤会间接调
                // coversDir()→storageCoversDirOverride()→loadSettingColumn→queryOne→getDB，
                // 若在 Once 内直查将递归自锁（Task 30 P1 同款死锁，实测 panic dump 实证）。
                // 设置读取层以 dbReady 判定 boot 是否完成，未完成一律返回空（回落默认路径）。
                dbReady.Store(true)
        })
        return gDB, gDBError
}

// dbReady boot 完成门闩（R97）：scrapesettings.go loadSettingColumn 消费——
// true=getDB once 回调已全部执行完，queryOne 安全；false=boot 进行中，禁止重入 getDB
var dbReady atomic.Bool

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

// appMetaDDL Task 47: 轻量运行时元数据表（一次性迁移守卫标记存储；SiteSite/ChapterContent
// 先例：Go 侧运行时幂等建表管理，schema.go 不重复）。当前仅承载 t2sBackfillV1 标记。
const appMetaDDL = `CREATE TABLE IF NOT EXISTS "AppMeta" (
        "key" TEXT NOT NULL PRIMARY KEY,
        "value" TEXT NOT NULL DEFAULT ''
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

// ==================== Task 47: 存量数据繁转简一次性回填 ====================

// t2sBackfillKey AppMeta 守卫键
const t2sBackfillKey = "t2sBackfillV1"

// t2sBackfillDone 守卫标记读取（表缺失/行缺失均视为未完成）
func t2sBackfillDone(db *sql.DB) bool {
        var v string
        if err := db.QueryRow(`SELECT "value" FROM "AppMeta" WHERE "key" = ?`, t2sBackfillKey).Scan(&v); err != nil {
                return false
        }
        return v == "done"
}

// markT2SBackfillDone 写守卫标记（best-effort；失败=下次启动重扫，幂等零写放大）
func markT2SBackfillDone(db *sql.DB) {
        _, _ = db.Exec(`INSERT OR REPLACE INTO "AppMeta" ("key","value") VALUES (?, 'done')`, t2sBackfillKey)
}

// backfillT2SExisting 存量数据繁转简（Task 47，用户指令「源站繁体字的入库转简体，包括
// 书名、目录名、作者、分类、简介等所有获取到的数据」对存量行的补全）：
//   - 同步面（启动路径，量小）：Category.name / Novel(title,author,description) /
//     Chapter(title+转换后卷前缀归一) / PseoKeyword(keyword,seed+kwNorm 重算)
//   - 异步面（后台 goroutine，正文大表不阻塞启动）：ChapterContent.content keyset 分批扫描
//   - 幂等：t2sField(auto) 输出不再含无歧义繁体字，重扫零写放大；守卫标记在正文扫描
//     完成后落（中断即无标记 → 下次启动重扫，已转换行零写入）
//   - 唯一冲突（转换后 title+author / keyword 与既有行相撞）跳过并留日志，绝不覆盖他人行
//   - TXT 镜像文件不回写（下载面历史文件词面暂存旧形，重采/编辑自愈）
//
// ⚠ getDB once 回调内必须以传入局部 db 句柄直写（Task 30 P1 递归自锁教训，严禁经 getDB）。
func backfillT2SExisting(db *sql.DB) error {
        if t2sBackfillDone(db) {
                return nil
        }
        if err := backfillT2SMeta(db); err != nil {
                return err
        }
        go func() {
                if err := backfillT2SContent(db); err != nil {
                        log.Printf("[db] t2s 正文存量回填失败（不落守卫标记，重启重试）: %v", err)
                        return
                }
                markT2SBackfillDone(db)
                log.Printf("[db] t2s 存量回填完成（正文扫描收尾，守卫标记已落）")
        }()
        return nil
}

// backfillT2SMeta 存量元数据繁转简（分类/书字段/章题/pSEO 关键词；同步启动路径。
// 转换统一走 t2sField("auto") 与采集入库同口径——绝不用 t2sForce 直转，防止「乾坤」
// 类简体词面被 乾→干 误伤）。
// Task 47-a 深审：行级非冲突失败（busy/IO 等）不再只留日志后吞掉——记录首个错误并
// 继续处理其余行（本轮收益最大化），末尾向上返回 → backfillT2SExisting 不启动正文
// goroutine、不落守卫标记 → 下次启动整段重试。否则守卫可在个别行转换失败时照常
// 落位，失败行永久滞留繁体（守卫短路后无重试路径）。
func backfillT2SMeta(db *sql.DB) error {
        var rowErr error
        recordRowErr := func(id int64, table string, err error) {
                log.Printf("[db] t2s 回填 %s#%d 失败: %v", table, id, err)
                if rowErr == nil {
                        rowErr = err
                }
        }
        // ① Category.name（规范类名恒简体，防御历史行/手改行）
        type idName struct {
                id   int64
                name string
        }
        cats := []idName{}
        rows, err := db.Query(`SELECT "id","name" FROM "Category"`)
        if err != nil {
                return err
        }
        for rows.Next() {
                var r idName
                if err := rows.Scan(&r.id, &r.name); err != nil {
                        rows.Close()
                        return err
                }
                cats = append(cats, r)
        }
        // Task 49-b: 迭代错误必须向上返回——旧行静默吞掉 rows.Err()，扫描截断后守卫标记
        // 照常落位，漏扫行永久滞留繁体（守卫短路后无重试路径，与 backfillT2SMeta 头注
        // 「行级失败不落标记」同一契约）
        if err := rows.Err(); err != nil {
                rows.Close()
                return err
        }
        rows.Close()
        for _, r := range cats {
                if s := t2sField("auto", r.name); s != r.name && s != "" {
                        if _, err := db.Exec(`UPDATE "Category" SET "name" = ? WHERE "id" = ?`, s, r.id); err != nil {
                                recordRowErr(r.id, "Category", err)
                        }
                }
        }

        // ② Novel(title,author,description)——title+author 参与唯一键，冲突跳过留日志
        type novelRow struct {
                id     int64
                title  string
                author string
                desc   string
        }
        books := []novelRow{}
        rows, err = db.Query(`SELECT "id","title","author","description" FROM "Novel"`)
        if err != nil {
                return err
        }
        for rows.Next() {
                var r novelRow
                if err := rows.Scan(&r.id, &r.title, &r.author, &r.desc); err != nil {
                        rows.Close()
                        return err
                }
                books = append(books, r)
        }
        if err := rows.Err(); err != nil { // Task 49-b: 迭代错误上返（防扫描截断后守卫误落）
                rows.Close()
                return err
        }
        rows.Close()
        for _, r := range books {
                nt := trimSpaceStr(t2sField("auto", r.title))
                na := t2sField("auto", r.author)
                nd := t2sField("auto", r.desc)
                if nt == r.title && na == r.author && nd == r.desc {
                        continue
                }
                if nt == "" {
                        nt = r.title // 防御：转换产物不得为空（空标题行本不该存在）
                }
                if _, err := db.Exec(`UPDATE "Novel" SET "title" = ?, "author" = ?, "description" = ? WHERE "id" = ?`, nt, na, nd, r.id); err != nil {
                        if isUniqueConflict(err) {
                                log.Printf("[db] t2s 回填 Novel#%d 唯一冲突（转换后 title+author 与既有行相撞）跳过: %q/%q", r.id, truncateRunes(nt, 30), truncateRunes(na, 20))
                                continue
                        }
                        recordRowErr(r.id, "Novel", err)
                }
        }

        // ③ Chapter.title（转换后卷前缀归一：detectVolume 在转换后标题上进行，volume 为空
        // 行补卷名——与入库链路 t2s→detectVolume 顺序同口径，Phase 2 续传双侧词面一致）
        type chapRow struct {
                id     int64
                title  string
                volume string
        }
        chaps := []chapRow{}
        rows, err = db.Query(`SELECT "id","title","volume" FROM "Chapter"`)
        if err != nil {
                return err
        }
        for rows.Next() {
                var r chapRow
                if err := rows.Scan(&r.id, &r.title, &r.volume); err != nil {
                        rows.Close()
                        return err
                }
                chaps = append(chaps, r)
        }
        if err := rows.Err(); err != nil { // Task 49-b: 迭代错误上返（防扫描截断后守卫误落）
                rows.Close()
                return err
        }
        rows.Close()
        for _, r := range chaps {
                nt := trimSpaceStr(t2sField("auto", r.title))
                if nt == r.title || nt == "" {
                        continue
                }
                vol := r.volume
                if v, rest := detectVolume(nt); v != "" {
                        if vol == "" {
                                vol = v
                        }
                        nt = rest
                }
                if _, err := db.Exec(`UPDATE "Chapter" SET "title" = ?, "volume" = ? WHERE "id" = ?`, nt, vol, r.id); err != nil {
                        recordRowErr(r.id, "Chapter", err)
                }
        }

        // ④ PseoKeyword(keyword,seed)——keyword 唯一键冲突跳过；kwNorm 随转换后词面重算
        // （keyword 亦即聚合页 URL 词面，转换后与书籍页 chips/新采集词面保持一致）
        type kwRow struct {
                id      int64
                keyword string
                seed    string
        }
        kws := []kwRow{}
        rows, err = db.Query(`SELECT "id","keyword","seed" FROM "PseoKeyword"`)
        if err != nil {
                return err
        }
        for rows.Next() {
                var r kwRow
                if err := rows.Scan(&r.id, &r.keyword, &r.seed); err != nil {
                        rows.Close()
                        return err
                }
                kws = append(kws, r)
        }
        if err := rows.Err(); err != nil { // Task 49-b: 迭代错误上返（防扫描截断后守卫误落）
                rows.Close()
                return err
        }
        rows.Close()
        for _, r := range kws {
                nk := t2sField("auto", r.keyword)
                ns := t2sField("auto", r.seed)
                if nk == r.keyword && ns == r.seed {
                        continue
                }
                if nk == "" {
                        continue
                }
                if _, err := db.Exec(`UPDATE "PseoKeyword" SET "keyword" = ?, "seed" = ?, "kwNorm" = ? WHERE "id" = ?`, nk, ns, kwNormalize(nk), r.id); err != nil {
                        if isUniqueConflict(err) {
                                log.Printf("[db] t2s 回填 PseoKeyword#%d 唯一冲突跳过: %q→%q", r.id, truncateRunes(r.keyword, 30), truncateRunes(nk, 30))
                                continue
                        }
                        recordRowErr(r.id, "PseoKeyword", err)
                }
        }
        return rowErr
}

// backfillT2SContent 存量正文繁转简（ChapterContent 大表，keyset 分批 500 行防长锁；
// 幂等：转换后行重扫零写入）。由 backfillT2SExisting 后台 goroutine 调用，不阻塞启动。
func backfillT2SContent(db *sql.DB) error {
        const batch = 500
        type cRow struct {
                id      int64
                content string
        }
        var last int64
        scanned, changed := 0, 0
        for i := 0; i < 1_000_000; i++ { // 硬上限防异常死循环（migrateChapterContentSplit 先例）
                rows := []cRow{}
                rs, err := db.Query(`SELECT "chapterId","content" FROM "ChapterContent" WHERE "chapterId" > ? ORDER BY "chapterId" LIMIT ?`, last, batch)
                if err != nil {
                        return err
                }
                for rs.Next() {
                        var r cRow
                        if err := rs.Scan(&r.id, &r.content); err != nil {
                                rs.Close()
                                return err
                        }
                        rows = append(rows, r)
                }
                // Task 49-b: 迭代错误必须上返——旧行静默吞掉 rs.Err()，扫描截断后
                // markT2SBackfillDone 照常落位，漏扫行永久滞留繁体
                if err := rs.Err(); err != nil {
                        rs.Close()
                        return err
                }
                rs.Close()
                if len(rows) == 0 {
                        log.Printf("[db] t2s 正文存量回填扫描完成：共 %d 行，修正 %d 行", scanned, changed)
                        return nil
                }
                for _, r := range rows {
                        last = r.id
                        scanned++
                        nc := t2sField("auto", r.content)
                        if nc == r.content || nc == "" {
                                continue
                        }
                        if _, err := db.Exec(`UPDATE "ChapterContent" SET "content" = ? WHERE "chapterId" = ?`, nc, r.id); err != nil {
                                return err
                        }
                        changed++
                }
        }
        return fmt.Errorf("正文 t2s 回填超出硬上限（异常数据形态）")
}

// backfillChapterVolume 存量章节分卷回填（Task 45-b，幂等）：
// 全扫 title 命中「第X卷+分隔符」前缀模式的行（LIKE '第%卷%' 预滤，命中行极少）→
// volume=卷名、title=剥前缀后的剩余标题，与入库链路 storex.go 的 detectVolume 同口径。
// 归一双侧一致的硬约束：Phase 2 续传按标题精确匹配空骨架（worker fillRows），若存量行
// 保留卷前缀而新采集 refs 已剥前缀，续传必然 miss 并造成重复骨架行。
// 纯卷标题行（剥后为空，detectVolume 契约返回原标题）只记 volume 不动标题；
// 有变化才 UPDATE（幂等零写放大）；只扫 volume=” 行（Task 40 kwNorm 回填先例）——
// 已回填/已由入库链路识别的行不再触碰，构造上杜绝二次剥前缀。
// ⚠ getDB once 回调内必须以传入局部 db 句柄直写（Task 30 P1 递归自锁教训，严禁经 getDB）。
func backfillChapterVolume(db *sql.DB) error {
        type volRow struct {
                id    int64
                title string
        }
        hits := make([]volRow, 0)
        rows, err := db.Query(`SELECT "id", "title" FROM "Chapter" WHERE "volume" = '' AND "title" LIKE '第%卷%'`)
        if err != nil {
                return err
        }
        for rows.Next() {
                var r volRow
                if err := rows.Scan(&r.id, &r.title); err != nil {
                        rows.Close()
                        return err
                }
                hits = append(hits, r)
        }
        err = rows.Err()
        rows.Close()
        if err != nil {
                return err
        }
        for _, r := range hits {
                vol, rest := detectVolume(r.title)
                if vol == "" {
                        continue // 「第X卷」仅作子串出现（如「画卷/卷轴」），非前缀形态
                }
                if _, err := db.Exec(`UPDATE "Chapter" SET "volume" = ?, "title" = ? WHERE "id" = ?`,
                        vol, rest, r.id); err != nil {
                        return err
                }
        }
        return nil
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
