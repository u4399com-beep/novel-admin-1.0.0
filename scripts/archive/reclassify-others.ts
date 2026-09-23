/**
 * 存量「其他」分类书籍重分类工具 v2（批量模式）。
 * bun scripts/reclassify-others.ts
 *
 * 每次LLM调用批量分类10本书（编号列表→"序号:分类"输出），
 * 规避单本调用时的 429 限流；失败退避重试；可重复运行（幂等，
 * 已归类的书离开「其他」集合后自动跳过）。
 */
import { PrismaClient } from '@prisma/client'
import ZAI from 'z-ai-web-dev-sdk'

const db = new PrismaClient()
const BATCH = 10

const CANON = ['玄幻奇幻', '武侠仙侠', '都市言情', '历史军事', '科幻未来', '游戏竞技', '悬疑灵异', '轻小说', '其他']
const SYN: Array<[string, string]> = [
  ['玄幻', '玄幻奇幻'], ['奇幻', '玄幻奇幻'], ['魔法', '玄幻奇幻'], ['异世', '玄幻奇幻'], ['魔幻', '玄幻奇幻'],
  ['武侠', '武侠仙侠'], ['仙侠', '武侠仙侠'], ['修真', '武侠仙侠'], ['修仙', '武侠仙侠'], ['江湖', '武侠仙侠'],
  ['都市', '都市言情'], ['言情', '都市言情'], ['总裁', '都市言情'], ['婚恋', '都市言情'], ['现言', '都市言情'],
  ['古言', '都市言情'], ['校园', '都市言情'], ['商战', '都市言情'], ['官场', '都市言情'], ['豪门', '都市言情'], ['情感', '都市言情'],
  ['历史', '历史军事'], ['军事', '历史军事'], ['战争', '历史军事'], ['架空', '历史军事'], ['抗战', '历史军事'],
  ['科幻', '科幻未来'], ['未来', '科幻未来'], ['星际', '科幻未来'], ['机甲', '科幻未来'], ['末世', '科幻未来'], ['末日', '科幻未来'],
  ['游戏', '游戏竞技'], ['网游', '游戏竞技'], ['竞技', '游戏竞技'], ['电竞', '游戏竞技'],
  ['悬疑', '悬疑灵异'], ['灵异', '悬疑灵异'], ['惊悚', '悬疑灵异'], ['推理', '悬疑灵异'], ['侦探', '悬疑灵异'],
  ['恐怖', '悬疑灵异'], ['盗墓', '悬疑灵异'],
  ['轻小说', '轻小说'], ['同人', '轻小说'], ['二次元', '轻小说'],
]

function norm(raw: string): string {
  return (raw || '').replace(/[\s\u3000]+/g, '').replace(/(小说|分类|频道|书库|作品)$/u, '').slice(0, 30)
}

function match(text: string): string | null {
  const cleaned = text.replace(/[「」"'‘’“”\s]/g, '')
  const n = norm(cleaned)
  if (CANON.includes(n)) return n
  let best: string | null = null
  let bs = 0
  for (const [syn, canon] of SYN) {
    if (n.includes(syn) && syn.length > bs) {
      best = canon
      bs = syn.length
    }
  }
  if (best) return best
  for (const c of CANON) if (cleaned.includes(c)) return c
  return null
}

interface BookRow {
  id: number
  title: string
  description: string
}

async function classifyBatch(zai: Awaited<ReturnType<typeof ZAI.create>>, books: BookRow[]): Promise<Map<number, string>> {
  const list = books
    .map((b, i) => {
      const desc = b.description ? `｜简介：${b.description.slice(0, 120)}` : ''
      return `${i + 1}.《${b.title.slice(0, 40)}》${desc}`
    })
    .join('\n')
  const prompt = [
    `以下是 ${books.length} 本网络小说，请为每一本从这些分类中各选一个最合适的：`,
    CANON.join(' / '),
    '输出格式：每行「序号:分类名」，用完整分类名，不要输出任何其他内容。示例：',
    '1:玄幻奇幻',
    '2:都市言情',
    '',
    list,
  ].join('\n')
  const backoffs = [4_000, 8_000, 16_000]
  for (let attempt = 0; ; attempt++) {
    try {
      const completion = await Promise.race([
        zai.chat.completions.create({
          messages: [{ role: 'user', content: prompt }],
          thinking: { type: 'disabled' },
        }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 25_000)),
      ])
      const text = completion.choices[0]?.message?.content ?? ''
      const out = new Map<number, string>()
      for (const line of text.split('\n')) {
        const m = line.match(/^\s*(\d+)\s*[:：.]\s*(.+)$/)
        if (!m) continue
        const idx = Number(m[1])
        const cat = match(m[2])
        if (idx >= 1 && idx <= books.length && cat) out.set(books[idx - 1].id, cat)
      }
      return out
    } catch {
      if (attempt >= backoffs.length) return new Map()
      await new Promise((s) => setTimeout(s, backoffs[attempt]))
    }
  }
}

async function main() {
  const others = await db.category.findUnique({
    where: { name: '其他' },
    include: { novels: { select: { id: true, title: true, description: true }, orderBy: { id: 'asc' } } },
  })
  const books = (others?.novels ?? []).filter((b) => b.title.trim())
  console.log(`[reclassify-v2] start: ${books.length} books, batch=${BATCH}`)
  if (books.length === 0) return
  const zai = await ZAI.create()
  const catIds = new Map<string, number>()
  for (const c of await db.category.findMany()) catIds.set(c.name, c.id)
  let moved = 0
  let kept = 0
  for (let i = 0; i < books.length; i += BATCH) {
    const batch = books.slice(i, i + BATCH)
    const result = await classifyBatch(zai, batch)
    for (const b of batch) {
      const cat = result.get(b.id)
      if (cat && cat !== '其他' && catIds.has(cat)) {
        await db.novel.update({ where: { id: b.id }, data: { categoryId: catIds.get(cat)! } })
        moved++
      } else kept++
    }
    console.log(`[reclassify-v2] ${Math.min(i + BATCH, books.length)}/${books.length} (moved=${moved} kept=${kept})`)
    await new Promise((s) => setTimeout(s, 1_500))
  }
  console.log(`[reclassify-v2] done: moved=${moved} kept=${kept}`)
  const byCat = await db.category.findMany({ include: { _count: { select: { novels: true } } } })
  console.log(byCat.map((c) => `${c.id}:${c.name}:${c._count.novels}`).join(' '))
}

main()
  .finally(() => db.$disconnect())
