/**
 * 目录污染修复（取证结论 scripts/forensic-continue.ts / forensic-badchapters.ts）：
 *
 * 1. 重命名：6 本书的第一章骨架标题被源站「立即阅读」按钮抢占（URL 去重保留先出现者），
 *    按用户指令「第一章就叫做第一章」统一改为「第一章」。
 *    - 已填充行（147/149）：内容就是第一章正文，改名即修复。
 *    - 空骨架行（152/153/154/158）：改名后若当前任务 Phase 2 按 title 匹配 miss，
 *      该行保持 wordCount=0，重发任务自动续传填充（可续跑机制兜底）。
 * 2. 重排：novel 149/153/158 首行是「最新章节」跳转链接（第N章编号远大于后续），
 *    复用 /api/chapters/audit reindex（按「第N章」编号升序重排+idx 压实）。
 *
 * 用法: bun scripts/fix-toc-pollution.ts [--apply]（默认 dry-run）
 */
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const APPLY = process.argv.includes('--apply')
const API_BASE = process.env.FIX_API_BASE ?? 'http://127.0.0.1:3000'

async function main() {
  // ---- 1. 重命名「立即阅读」→「第一章」 ----
  const bad = await db.chapter.findMany({
    where: { title: '立即阅读' },
    select: { id: true, novelId: true, idx: true, wordCount: true },
    orderBy: { id: 'asc' },
  })
  console.log(`=== 「立即阅读」章节 ${bad.length} 条 → 改名「第一章」 ${APPLY ? '[APPLY]' : '[DRY-RUN]'} ===`)
  for (const b of bad) console.log(`  ch#${b.id} novel=${b.novelId} idx=${b.idx} wordCount=${b.wordCount}`)
  if (APPLY && bad.length > 0) {
    const res = await db.chapter.updateMany({ where: { id: { in: bad.map((b) => b.id) } }, data: { title: '第一章' } })
    console.log(`已更新 ${res.count} 行`)
  }

  // ---- 2. reindex 乱序书（首行「最新章节」跳转链接导致编号回退） ----
  for (const novelId of [149, 153, 158]) {
    const before = await fetch(`${API_BASE}/api/chapters/audit?novelId=${novelId}`)
      .then((r) => r.json())
      .catch(() => null)
    const b = before?.item
    console.log(`\nnovel#${novelId} 修复前: 章节数=${b?.chapters} 乱序=${b?.disordered} 示例=${JSON.stringify(b?.disorderSamples ?? [])}`)
    if (!APPLY) continue
    const res = await fetch(`${API_BASE}/api/chapters/audit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reindex', novelId }),
    }).then((r) => r.json())
    console.log(`reindex 结果: removed=${res.removed} moved=${res.moved} 修复后乱序=${res.audit?.disordered}`)
  }
  console.log(APLY_FLAG())
}

function APLY_FLAG() {
  return APPLY ? '\n=== 已应用 ===' : '\n=== dry-run 结束（加 --apply 生效） ==='
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
