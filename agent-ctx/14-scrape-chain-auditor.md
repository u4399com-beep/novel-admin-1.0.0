# Task 14 — scrape-chain-auditor

日期：2026-09-16
范围：采集链路（scrape-worker / scrape-tasks API / scrape-rules API / scrape 代理）+ 后台控制台（AdminConsole/panels/page/ScrapeCenter）+ schema/globals.css 逐行审查修复

## 修复清单（8 处）

| # | 文件 | 问题 | 修法 |
|---|------|------|------|
| 1 | api/scrape-rules/route.ts | **PUT 双读 body 流**：PUT 先 json() 判 seed，handleSave(req) 内部再 json() → 第二次必失败，前端所有经 PUT 的规则保存/启停恒 400 | handleSave 改为接收已解析 body；POST/PUT 各解析一次 |
| 2 | api/scrape-rules/route.ts | 更新不存在 id → P2025 → 500 且带 Prisma detail | catch 判 code==='P2025' → 404 |
| 3 | lib/scrape-worker.ts | isCanceled 把 DB 瞬时错误当作已取消（fail-closed），会误停任务并覆写 canceled | catch 返回 undefined → fail-open；null（记录不存在）仍视为取消 |
| 4 | lib/scrape-worker.ts | 章节入库撞 [novelId,idx] 唯一约束后 idx 不递增 → 后续章节连锁失败 | isUniqueConflict(P2002) → idx+1 顺延重试一次 |
| 5 | lib/scrape-worker.ts | 书籍 upsert title/author 未 trim；空白标题绕过校验入库 | trim→slice；trim 后空按失败返回 |
| 6 | lib/scrape-worker.ts | ENGINE_TIMEOUT_MS=30s < 引擎 55s 策略链预算，慢站点被提前切断 | 对齐 60s（与 /api/scrape 代理一致） |
| 7 | api/scrape-tasks/[id]/route.ts | PATCH cancel 无条件 update 可覆盖 worker 刚写入的终态 | 条件 updateMany(status in pending/running)，count=0 回查后 400/404；DELETE running → 409 拒绝 |
| 8 | components/admin/ScrapeCenter.tsx | ① LogDialog 用打开时 status 快照轮询，终态后不停；② 任务列表末页删空卡死 | ① refetchInterval 回调读最新状态；② 空态加「返回第一页」 |

另：prisma ScrapeTask 加 `@@index([status])`（db:push 已同步）。

## 验证

- `bunx tsc --noEmit` 0 错误；`bun run lint` 0 错误
- POST single(ruleId=6, books.toscrape) → 终态 failed，updated=1（查重命中既有书 #42），日志无异常（章节"正文为空"为演示站无正文的环境性结果）
- 非法输入 7 连测全 400：notaurl / mode xxx / ruleId 99999 / ftp: / pages 99 / 非法 JSON / 缺 name
- PUT ghost id → 404；PUT 创建 → 201；seed 幂 → 200 added:0
- DELETE running → 409；cancel → 200 → worker 下一检查点停止 → 8s 后状态保持 canceled（未被 failed 覆写）→ 再 cancel 400
- ?status=failed&pageSize=2 过滤生效；page=abc&pageSize=-5 安全回退
- 测试数据已清理（tasks=0，rules=[1,2,3,4,6]）

## 遗留风险

1. list 模式 done/total 单位混用（total=书数，done 含章节数，瞬时 >100%，UI 钳制）
2. Novel 无 title+author 唯一约束，并发采集同一新书可重复建书（加约束需迁移+存量去重）
3. PUT seed 非事务，部分失败可重入（幂等）
4. worker fire-and-forget：dev 单实例安全（pending→running 条件更新为唯一启动入口，热重载后二次触发也会 count=0 退出）；生产 serverless 平台需改 waitUntil/队列
