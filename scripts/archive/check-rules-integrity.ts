/**
 * 精确断言可疑选择器键的真实字节（Task 12-c，只读）
 * 防 IM 网关 [h 显示吞字假象：只输出布尔与长度，不回显原始字符串。
 */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()
const rows = await db.scrapeRule.findMany({ orderBy: { id: 'asc' } })
const byId = new Map(rows.map((r) => [r.id, r]))

const expect = (id: number, group: 'listRule' | 'bookRule' | 'chapterRule', key: string, want: string): void => {
  const r = byId.get(id)
  if (!r) return console.log(`id=${id} MISSING`)
  const obj = JSON.parse(r[group] || '{}') as Record<string, string>
  const v = obj[key]
  console.log(
    `id=${id} ${group}.${key}: exists=${v !== undefined} eqExpect=${v === want} len=${v?.length ?? 0} expectLen=${want.length} startsWithA=${v?.startsWith('a[')}`,
  )
}

expect(10, 'bookRule', 'catalogLinkSelector', 'a[href^="/read/"]')
expect(12, 'bookRule', 'statusSelector', '.novel-info-header a.tag-link[href="javascript:;"]')
expect(12, 'bookRule', 'catalogLinkSelector', 'a[href$="/catalog"]')
expect(15, 'bookRule', 'authorSelector', '.bookdes a[href*="/author/"]')
expect(20, 'bookRule', 'chapterLinkSelector', 'a[href*="/chapter/"]')
expect(16, 'bookRule', 'chapterLinkSelector', '#allchapter li a')
expect(17, 'bookRule', 'coverSelector', 'img[src*="files/article/image"]@src, meta[property="og:image"]@content')
await db.$disconnect()
