/**
 * 分类归并逻辑验证（只读，不写 DB）
 * 覆盖：取证发现的真实源站分类名 + 规范名直通 + 兜底 + LLM 未知类
 * 运行：bun scripts/test-category.ts
 */
import { canonicalCategory } from '../../src/lib/scrape/category'

const CASES = [
  // 取证实测出现过的源站原始分类名
  '玄幻魔法', '玄幻小说', '其他小说', '科幻小说', '都市小说', '言情小说',
  // 规范名直通
  '玄幻奇幻', '武侠仙侠', '轻小说',
  // 常见变体
  '修真闲话', '网游情缘', '推理侦探', '女生频道', '科幻空间', '历史军事', '网游竞技',
  // 空值/噪声
  '', '   ',
  // LLM 兜底触发（无同义词无关键词）
  '精英文学', '青春校园', '美文',
]

async function main(): Promise<void> {
  const t0 = Date.now()
  const results = await Promise.all(CASES.map((c) => canonicalCategory(c)))
  for (let i = 0; i < CASES.length; i++) {
    const src = CASES[i] === '' ? '(空)' : CASES[i]
    console.log(`  ${src.padEnd(8)} → ${results[i]}`)
  }
  console.log(`耗时 ${Date.now() - t0}ms（含 LLM 兜底调用）`)
  // 二次调用验证缓存生效（应几乎为 0ms 增量）
  const t1 = Date.now()
  await Promise.all(CASES.map((c) => canonicalCategory(c)))
  console.log(`二次全量调用（缓存）${Date.now() - t1}ms`)
}

main().catch((e) => {
  console.error('失败:', e)
  process.exitCode = 1
})
