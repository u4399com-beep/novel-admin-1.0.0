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

// baseSchemaDDL 7 张基础业务表的建表+索引 DDL（顺序敏感：被引用表先建）。
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
CREATE INDEX IF NOT EXISTS "Novel_categoryId_idx" ON "Novel" ("categoryId");
CREATE INDEX IF NOT EXISTS "Novel_updatedAt_idx" ON "Novel" ("updatedAt");
CREATE INDEX IF NOT EXISTS "Novel_clicks_idx" ON "Novel" ("clicks");
CREATE UNIQUE INDEX IF NOT EXISTS "Novel_title_author_key" ON "Novel" ("title", "author");

CREATE TABLE IF NOT EXISTS "Chapter" (
        "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        "novelId" INTEGER NOT NULL,
        "idx" INTEGER NOT NULL,
        "title" TEXT NOT NULL,
        "content" TEXT NOT NULL DEFAULT '',
        "wordCount" INTEGER NOT NULL DEFAULT 0,
        "createdAt" INTEGER NOT NULL DEFAULT 0,
        CONSTRAINT "Chapter_novelId_fkey" FOREIGN KEY ("novelId") REFERENCES "Novel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "Chapter_novelId_idx_key" ON "Chapter" ("novelId", "idx");
CREATE INDEX IF NOT EXISTS "Chapter_novelId_idx" ON "Chapter" ("novelId");

CREATE TABLE IF NOT EXISTS "SiteSetting" (
        "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        "siteName" TEXT NOT NULL DEFAULT '青阅文学',
        "activeTheme" TEXT NOT NULL DEFAULT 'aijjxs',
        "notice" TEXT NOT NULL DEFAULT '本站所有小说仅供学习演示使用，请支持正版。',
        "seoConfig" TEXT NOT NULL DEFAULT '{}',
        "footerConfig" TEXT NOT NULL DEFAULT '{}',
        "homeConfig" TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS "PseoKeyword" (
        "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        "keyword" TEXT NOT NULL,
        "source" TEXT NOT NULL DEFAULT 'manual',
        "status" TEXT NOT NULL DEFAULT 'pending',
        "pageData" TEXT,
        "createdAt" INTEGER NOT NULL DEFAULT 0,
        "updatedAt" INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS "PseoKeyword_keyword_key" ON "PseoKeyword" ("keyword");

CREATE TABLE IF NOT EXISTS "ScrapeRule" (
        "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        "name" TEXT NOT NULL,
        "siteUrl" TEXT NOT NULL,
        "enabled" BOOLEAN NOT NULL DEFAULT true,
        "charset" TEXT NOT NULL DEFAULT 'utf-8',
        "proxy" TEXT NOT NULL DEFAULT '',
        "insecureTLS" BOOLEAN NOT NULL DEFAULT false,
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
`

// ensureBaseSchema 全量基础 schema 幂等引导（全新库建表，存量库空操作）。
// ⚠ 必须在 getDB once 回调内用传入的局部 *sql.DB 调用（Task 30 P1 死锁教训：
// 严禁 once 外经 exec/query 助手再入 getDB）。
func ensureBaseSchema(db *sql.DB) error {
	_, err := db.Exec(baseSchemaDDL)
	return err
}
