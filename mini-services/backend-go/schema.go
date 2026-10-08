/**
 * schema.go —— 纯 Go 全量建表引导（Task 39，P1 架构缺口修复）。
 *
 * 背景：本库表结构历史上由 Prisma `db push` 建立（Next.js 时代遗产），backend-go 只对
 * ChapterContent/SiteSite 两表做运行时幂等建表。历史 7 次沙箱回收只清数据不清文件
 * （「表结构在、数据全空」），该缺口从未暴露；Task 39 第 8 次回收整库文件被删，全新建库
 * 后仅 2 张 Go 侧表存在，seed 播种与全部业务 SQL 因「no such table」瘫痪（实证：
 * [seed] 播种失败: no such table: ScrapeRule）。Task 38 已移除 Prisma——纯 Go 栈必须
 * 自持完整 schema，本文件即权威 DDL（与 git 历史 prisma/schema.prisma 逐表逐列镜像）。
 *
 * 语义：
 *   - 全部 CREATE TABLE/INDEX IF NOT EXISTS：重复启动/存量库零影响（生产库表已存在时
 *     本函数等价于空操作；只有全新库文件才实际建表）
 *   - 列类型/默认值/唯一约束/索引与 Prisma 历史产物一致，唯一刻意偏差：时间戳列声明为
 *     INTEGER NOT NULL DEFAULT 0 而非 DATETIME DEFAULT CURRENT_TIMESTAMP——生产实际存储
 *     形态是 Go nowMillis() 的 epoch 毫秒整数（Prisma 时代同为整数存储）；modernc 驱动对
 *     DATETIME 声明列会把字符串值自动转 time.Time（Scan 进 any 命不到 string 分支，
 *     normalizeMillis 解析路径失效），INTEGER 声明根除该歧义，且缺省 0 永不产生 TEXT 行
 *     （Task 33-b 归一化的病灶源头）
 *   - 外键镜像 Prisma：Chapter.novelId → Novel ON DELETE CASCADE；
 *     ScrapeTask.ruleId → ScrapeRule ON DELETE SET NULL（DSN foreign_keys(1) 生效）
 *   - 时序契约：getDB() once 回调内**同步**执行，先于 startSeedIfEmpty() 的异步播种——
 *     保证 seed 运行时表必然存在（本次事故的直接根因即 seed 先于建表）
 */
package main

import "database/sql"

// baseSchemaDDL 8 张基础业务表的建表+索引 DDL（顺序敏感：被引用表先建）。
// ChapterContent/SiteSite 两表由 db.go 既有 DDL 管理，不在此重复。
const baseSchemaDDL = `
CREATE TABLE IF NOT EXISTS "Category" (
        "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        "name" TEXT NOT NULL,
        "sort" INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS "Category_name_key" ON "Category" ("name");

CREATE TABLE IF NOT EXISTS "Novel" (
        "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        "title" TEXT NOT NULL,
        "author" TEXT NOT NULL,
        "description" TEXT NOT NULL DEFAULT '',
        "cover" TEXT NOT NULL DEFAULT 'g1',
        -- Task 50: 源站封面 URL（封面下载失败/未触发时留存，补抓通道数据源；''=未提取到）
        "coverSrc" TEXT NOT NULL DEFAULT '',
        "categoryId" INTEGER NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'serial',
        "isFeatured" BOOLEAN NOT NULL DEFAULT false,
        "isHot" BOOLEAN NOT NULL DEFAULT false,
        "wordCount" INTEGER NOT NULL DEFAULT 0,
        "clicks" INTEGER NOT NULL DEFAULT 0,
        "createdAt" INTEGER NOT NULL DEFAULT 0,
        "updatedAt" INTEGER NOT NULL DEFAULT 0,
        CONSTRAINT "Novel_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "Novel_updatedAt_id_idx" ON "Novel" ("updatedAt" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "Novel_categoryId_updatedAt_id_idx" ON "Novel" ("categoryId", "updatedAt" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "Novel_clicks_id_idx" ON "Novel" ("clicks" DESC, "id" DESC);
CREATE UNIQUE INDEX IF NOT EXISTS "Novel_title_author_key" ON "Novel" ("title", "author");
-- R102-b 索引优化：上述三个复合索引取代旧单列索引（categoryId/updatedAt/clicks）——
-- 「ORDER BY updatedAt DESC, id DESC」（最新/书库默认序）、「WHERE categoryId=? ORDER BY
-- updatedAt DESC, id DESC」（分类页/分类榜）、「ORDER BY clicks DESC, id DESC」（热门/完本榜）
-- 全部变为索引序直出（零 Sort 成本）；旧单列索引被复合最左前缀覆盖，删除省写放大。
-- 低基数谓词（isHot/isFeatured/status）无需额外部分索引：全量复合索引在十万书级下
-- 索引序扫描已足够快，且少两份索引写放大（简化胜于微优化）。
DROP INDEX IF EXISTS "Novel_updatedAt_idx";
DROP INDEX IF EXISTS "Novel_categoryId_idx";
DROP INDEX IF EXISTS "Novel_clicks_idx";

CREATE TABLE IF NOT EXISTS "Chapter" (
        "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        "novelId" INTEGER NOT NULL,
        "idx" INTEGER NOT NULL,
        "title" TEXT NOT NULL,
        -- Task 45-b: 分卷列（''=无卷/未分组；入库链路 storex.go detectVolume 识别「第X卷+分隔符」
        -- 前缀后落库，存量库由 db.go ensureColumn + backfillChapterVolume 幂等补齐）。
        -- 仅加列不动既有镜像契约：其余列/约束/索引与 Prisma 历史产物逐列一致
        "volume" TEXT NOT NULL DEFAULT '',
        "content" TEXT NOT NULL DEFAULT '',
        "wordCount" INTEGER NOT NULL DEFAULT 0,
        "createdAt" INTEGER NOT NULL DEFAULT 0,
        CONSTRAINT "Chapter_novelId_fkey" FOREIGN KEY ("novelId") REFERENCES "Novel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "Chapter_novelId_idx_key" ON "Chapter" ("novelId", "idx");
-- R102-b 索引优化：单列 Chapter_novelId_idx 被 UNIQUE(novelId,idx) 最左前缀完全覆盖
--（TOC/上一章/下一章全部走复合索引），删除纯冗余的写放大
DROP INDEX IF EXISTS "Chapter_novelId_idx";

CREATE TABLE IF NOT EXISTS "SiteSetting" (
        "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        "siteName" TEXT NOT NULL DEFAULT '青阅文学',
        "activeTheme" TEXT NOT NULL DEFAULT 'aijjxs',
        "notice" TEXT NOT NULL DEFAULT '本站所有小说仅供学习演示使用，请支持正版。',
        "seoConfig" TEXT NOT NULL DEFAULT '{}',
        "footerConfig" TEXT NOT NULL DEFAULT '{}',
        "homeConfig" TEXT NOT NULL DEFAULT '{}',
        -- R97: 全局代理池（规则无自有 proxy 时兜底出口，逗号分隔；含凭证形如 socks5h://user:pass@host:port）
        "proxyPool" TEXT NOT NULL DEFAULT '',
        -- R97: TXT/封面自定义存储目录（绝对路径；空=默认 {repoRoot}/download/novels 与 {repoRoot}/public/covers）
        "txtDir" TEXT NOT NULL DEFAULT '',
        "coversDir" TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS "PseoKeyword" (
        "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        "keyword" TEXT NOT NULL,
        "source" TEXT NOT NULL DEFAULT 'manual',
        "status" TEXT NOT NULL DEFAULT 'pending',
        "pageData" TEXT,
        "createdAt" INTEGER NOT NULL DEFAULT 0,
        "updatedAt" INTEGER NOT NULL DEFAULT 0,
        -- Task 40: 书籍页「相关标签」鲁棒取词两列（存量库由 db.go ensureColumn + 一次性回填补齐）
        -- kwNorm = keyword 归一形（全半角折叠+去空白+小写）：全角？书名 vs 半角?下拉词等标点/宽度/
        -- 空白形态差异导致 LIKE '%完整书名%' 全量漏配（书 293 实证），归一形匹配根除此类病灶
        -- seed = 血缘：该词由哪个种子（书名）富集产出，书籍页按血缘直取「本书的 pseo 下拉词」
        "kwNorm" TEXT NOT NULL DEFAULT '',
        "seed" TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS "PseoKeyword_keyword_key" ON "PseoKeyword" ("keyword");
CREATE INDEX IF NOT EXISTS "PseoKeyword_seed_idx" ON "PseoKeyword" ("seed");

CREATE TABLE IF NOT EXISTS "ScrapeRule" (
        "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        "name" TEXT NOT NULL,
        "siteUrl" TEXT NOT NULL,
        "enabled" BOOLEAN NOT NULL DEFAULT true,
        "charset" TEXT NOT NULL DEFAULT 'utf-8',
        "proxy" TEXT NOT NULL DEFAULT '',
        "insecureTLS" BOOLEAN NOT NULL DEFAULT false,
        -- Task 53: 规则级静态 cookie 底座（用户人工过验后的会话凭证 "k=v; k2=v2"；引擎每次抓取前种入 host 会话桶）
        "cookies" TEXT NOT NULL DEFAULT '',
        "listRule" TEXT NOT NULL DEFAULT '{}',
        "bookRule" TEXT NOT NULL DEFAULT '{}',
        "chapterRule" TEXT NOT NULL DEFAULT '{}',
        "notes" TEXT NOT NULL DEFAULT '',
        "createdAt" INTEGER NOT NULL DEFAULT 0,
        "updatedAt" INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS "ScrapeRule_name_key" ON "ScrapeRule" ("name");

CREATE TABLE IF NOT EXISTS "ScrapeTask" (
        "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        "ruleId" INTEGER,
        "mode" TEXT NOT NULL DEFAULT 'single',
        "storageMode" TEXT NOT NULL DEFAULT 'db',
        "targetUrl" TEXT NOT NULL,
        "pages" INTEGER NOT NULL DEFAULT 1,
        "status" TEXT NOT NULL DEFAULT 'pending',
        "total" INTEGER NOT NULL DEFAULT 0,
        "done" INTEGER NOT NULL DEFAULT 0,
        "chaptersDone" INTEGER NOT NULL DEFAULT 0,
        "chaptersTotal" INTEGER NOT NULL DEFAULT 0,
        "created" INTEGER NOT NULL DEFAULT 0,
        "updated" INTEGER NOT NULL DEFAULT 0,
        "chapters" INTEGER NOT NULL DEFAULT 0,
        "message" TEXT NOT NULL DEFAULT '',
        "log" TEXT NOT NULL DEFAULT '',
        "createdAt" INTEGER NOT NULL DEFAULT 0,
        "updatedAt" INTEGER NOT NULL DEFAULT 0,
        CONSTRAINT "ScrapeTask_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "ScrapeRule" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "ScrapeTask_status_idx" ON "ScrapeTask" ("status");

-- E19（61-R4）: 规则健康巡检结果表 —— 每条启用规则一条（ruleId 主键），由
-- rulehealth.go 巡检循环写入；删除规则不级联（巡检 upsert 以 INSERT ON CONFLICT
-- 自愈，孤儿行无消费方且定期被下一次全量 pass 覆盖语义无关）。
CREATE TABLE IF NOT EXISTS "RuleHealth" (
        "ruleId" INTEGER NOT NULL PRIMARY KEY,
        "lastCheckAt" INTEGER NOT NULL DEFAULT 0,
        "lastOK" BOOLEAN NOT NULL DEFAULT false,
        "lastLatencyMs" INTEGER NOT NULL DEFAULT 0,
        "okStreak" INTEGER NOT NULL DEFAULT 0,
        "failStreak" INTEGER NOT NULL DEFAULT 0,
        "lastNote" TEXT NOT NULL DEFAULT '',
        "updatedAt" INTEGER NOT NULL DEFAULT 0
);

-- R102-b 分表：ScrapeTaskLog —— 任务运行日志垂直拆表（ChapterContent/Task 32-b 同构）。
-- 背景：任务日志（≤100 行 × 500 字/行，长跑任务 ~50KB）在 ScrapeTask 行内高频重写
--（worker 每 书批次 Flush 一次），SQLite 行存储下大 TEXT 把任务行挤进溢出页，
-- 任务列表/详情查询与主行小字段更新全部受累；拆表后主表回归全小字段紧凑行。
-- 主键设计：taskId 单列主键（1:1 与 ScrapeTask.id），级联 ON DELETE CASCADE 随任务
-- 删除自动清理（含 cleanupFinishedTasks 历史清理）。主表 log 旧列保留（存量行迁移
-- 保险，读路径 readTaskLog 空值回退），新写入一律走 writeTaskLog（主表列不再增长）。
CREATE TABLE IF NOT EXISTS "ScrapeTaskLog" (
        "taskId" INTEGER NOT NULL PRIMARY KEY,
        "log" TEXT NOT NULL DEFAULT '',
        FOREIGN KEY ("taskId") REFERENCES "ScrapeTask" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- R103: 全局代理出口池 —— miniproxypool.go 收割循环写入（自动搜代理 + 连通性测试 +
-- 筛选沉淀 + 规则补种）。proxy 唯一；ms=最近探测时延；failStreak 连败达阈值判死；
-- 死口保留 7 天供低频复活探测，过期由治理清理。
CREATE TABLE IF NOT EXISTS "ProxyExit" (
        "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        "proxy" TEXT NOT NULL,
        "ms" INTEGER NOT NULL DEFAULT 0,
        "okN" INTEGER NOT NULL DEFAULT 0,
        "failN" INTEGER NOT NULL DEFAULT 0,
        "failStreak" INTEGER NOT NULL DEFAULT 0,
        "dead" INTEGER NOT NULL DEFAULT 0,
        "source" TEXT NOT NULL DEFAULT '',
        "lastOkAt" INTEGER NOT NULL DEFAULT 0,
        "lastFailAt" INTEGER NOT NULL DEFAULT 0,
        "lastProbeAt" INTEGER NOT NULL DEFAULT 0,
        "createdAt" INTEGER NOT NULL DEFAULT 0,
        "updatedAt" INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS "ProxyExit_proxy_key" ON "ProxyExit" ("proxy");
CREATE INDEX IF NOT EXISTS "ProxyExit_dead_ms_idx" ON "ProxyExit" ("dead", "ms");
`

// ensureBaseSchema 全量基础 schema 幂等引导（全新库建表，存量库空操作）。
// ⚠ 必须在 getDB once 回调内用传入的局部 *sql.DB 调用（Task 30 P1 死锁教训：
// 严禁 once 外经 exec/query 助手再入 getDB）。
func ensureBaseSchema(db *sql.DB) error {
        _, err := db.Exec(baseSchemaDDL)
        return err
}
