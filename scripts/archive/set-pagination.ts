/**
 * Task 12-c：11 站分页模板 / 校准记录写入 DB ScrapeRule（一次性校准脚本，保留供复查/重放）。
 *
 * 依据（2026-09-19 逐站实测，引擎 /api/test + curl 经代理，频率 ≤6 req/站、间隔 ≥2s）：
 * - 「下一页」链接取自各站列表第 1 页真实 href（/tmp/probe-*.json 探测产物，已清理）
 * - 第 2 页候选 URL 全部经该站 listRule 提取验证条目数 >0（除 pilishuwu 被 CF 拦截为推断值）
 * - listRule.pagination 为新增键（纯字符串模板：{k}=页码、{url}=当前 URL，多模板 | 分隔，
 *   sanitizeRuleMap 限 300 字符/键；worker 接线点见 src/lib/scrape/pagination.ts 头注释）
 * - notes 追加校准记录（总长限 1000，超长先裁旧）
 * - pilishuwu charset gbk→utf-8（browser 渲染实测 UTF-8 内容被 GBK 强制解码出乱码）
 *
 * 用法：bun scripts/set-pagination.ts            # 写入
 *      bun scripts/set-pagination.ts --verify   # 只读校验（不写库）
 */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()
const VERIFY = process.argv.includes('--verify')

/** id → { pagination, appendNotes }；pagination 空串 = 该站不配模板（首页即列表/无翻页） */
const CALIBRATION: Record<number, { pagination: string; append: string; charset?: string }> = {
  10: {
    pagination: 'index_{k}.html',
    append:
      '【12-c 校准 2026-09-19】分页实测：分类页 /txt/{cat}/ 下一页=index_{k}.html（尾页 index_435）→ pagination=index_{k}.html（相对目录，任意分类通用）；首页无翻页。封面 .pic img@src 书页实测命中（/txt/57404.html → image.jjjjxsw.com jpg）。注意：分类页条目结构与首页不同（ul.lines-books li 不命中 /txt/ 页），用分类页采集前需先适配 itemSelector。',
  },
  11: {
    pagination: '',
    append:
      '【12-c 校准 2026-09-19】首页即列表（#hotcontent）无翻页链接，未配 pagination；分类页 /xuanhuanxiaoshuo/ 无翻页且 itemSelector 不命中（首页选择器不适用于分类页）。封面 #fmimg img@src 历史命中证据充分（4/4 书落盘 webp）。GBK 解码正常。',
  },
  12: {
    pagination: '/book/lastupdate_0_0_0_0_0_0_0_{k}_0.html',
    append:
      '【12-c 校准 2026-09-19】分页实测：lastupdate 列表下一页 href=/book/lastupdate_0_0_0_0_0_0_0_2_0.html → pagination=/book/lastupdate_0_0_0_0_0_0_0_{k}_0.html，第 2 页实测提取 30 条。封面 .novel-cover img@data-src 书页实测命中 jpg（/book/12449/）。',
  },
  13: {
    pagination: '/list/{k}.html',
    append:
      '【12-c 校准 2026-09-19】书库 /list 实测：下一页=/list/2.html（末页 1622），a.book-card 命中 30 条 → pagination=/list/{k}.html。封面 .detail-cover@src 书页命中；无封面书输出 /public/nocover.svg 占位图，引擎已加占位过滤（nocover/nopic/zwt 等不再落库）。',
  },
  14: {
    pagination: '../{k}/',
    append:
      '【12-c 校准 2026-09-19】分页实测：/sort/1/1/ 下一页=/sort/1/2/（数字页码锚点，probe-pagination 实证）。' +
      '模板初稿 {k}/ 经 pagination-selftest 抓出错误：相对段会「追加」到当前目录（生成 /sort/1/1/2/ 404），' +
      '页码在末段需替换而非追加 → 修正为 ../{k}/（标准相对 URL 语义：上一级再拼页码，任意 cid/页通用），' +
      '/sort/1/2/ 实测提取 10 条。封面 .bookcover img@src 书页实测命中 jpg（图床 img.178yhr.com）。',
  },
  15: {
    pagination: '?page={k}',
    append:
      '【12-c 校准 2026-09-19】分页实测：下一页=?page=2 → pagination=?page={k}，第 2 页实测提取 30 条。封面 a.cover img@src 书页实测命中 jpg（/txt/wz2j/）。',
  },
  16: {
    pagination: '/novels/class/0_{k}.html',
    append:
      '【12-c 校准 2026-09-19】代理 http://103.237.102.191:11111 实测可用（curl 200/1.1s，引擎经代理抓取成功；CF Bot Fight Mode 本轮 fetch-ua-rotate 亦可过）。分页实测：/novels/class/0_2.html 提取 10 条 → pagination=/novels/class/0_{k}.html。封面 og:image 书页实测命中 jpg（/book/184.html）。',
  },
  17: {
    pagination: '/list/1_{k}.html',
    append:
      '【12-c 校准 2026-09-19】分页实测：/list/1_2.html 提取 30 条 → pagination=/list/1_{k}.html（分类维度写死 1，其他分类按 /list/{cat}_{page}.html 推导后修改模板）。封面 img[src*=files/article/image] 书页实测命中 jpg。GBK 解码正常。',
  },
  18: {
    pagination: '/lastupdate/{k}/',
    append:
      '【12-c 校准 2026-09-19】3 个美国代理出口 curl 实测全部 200（6.3s/2.7s/2.7s）。分页实测：/lastupdate/ 下一页=/lastupdate/2/ → pagination=/lastupdate/{k}/，第 2 页实测提取 50 条。封面 .box_intro .pic img@src 书页实测命中（img.trxsw.com jpg）。',
  },
  19: {
    pagination: '{k}.html',
    charset: 'utf-8',
    append:
      '【12-c 校准 2026-09-19】charset 修正 gbk→utf-8（browser 渲染实测页面为 UTF-8，GBK 强制解码出乱码）。列表页格式按首页导航 /{cid}/list/1.html 推断 → pagination={k}.html（相对目录）；CF 层本轮仅 browser 策略偶发放行，第 2 页未能实测验证，站点放宽防护后请复核。封面 og:image@content 未实测（草稿规则）。',
  },
  20: {
    pagination: '',
    append:
      '【12-c 校准 2026-09-19】2 个国内代理出口 curl 实测全部 200（0.46s/0.46s）；引擎经代理偶发超时（代理抖动），池内多出口轮换可兜底。首页即列表无翻页链接，未配 pagination。封面 og:image 历史命中证据充分（4/4 书落盘 webp）。',
  },
}

const NOTES_MAX = 1000
let changed = 0
for (const [idStr, cal] of Object.entries(CALIBRATION)) {
  const id = Number(idStr)
  const r = await db.scrapeRule.findUnique({ where: { id } })
  if (!r) {
    console.log(`MISS id=${id}`)
    continue
  }
  const listRule = (JSON.parse(r.listRule || '{}') as Record<string, string>) ?? {}
  const prevPagination = listRule.pagination ?? ''
  const nextPagination = cal.pagination
  // notes：旧文案保留前 700 字，追加本轮校准记录（防超 API 上限 1000）
  const baseNotes = (r.notes || '').replace(/【12-c 校准 2026-09-19】[\s\S]*$/, '').trimEnd().slice(0, 700)
  const nextNotes = (baseNotes ? `${baseNotes}\n` : '') + cal.append
  const nextCharset = cal.charset ?? r.charset

  const paginationSame = prevPagination === nextPagination
  const notesSame = (r.notes || '') === nextNotes
  const charsetSame = r.charset === nextCharset
  console.log(
    `id=${id} ${r.name} :: pagination ${paginationSame ? 'unchanged' : 'UPDATE'} notes ${notesSame ? 'unchanged' : 'UPDATE'} charset ${charsetSame ? 'unchanged' : `UPDATE->${nextCharset}`}`,
  )

  if (!VERIFY && !(paginationSame && notesSame && charsetSame)) {
    if (nextPagination) listRule.pagination = nextPagination
    else delete listRule.pagination
    await db.scrapeRule.update({
      where: { id },
      data: {
        listRule: JSON.stringify(listRule),
        notes: nextNotes.slice(0, NOTES_MAX),
        ...(cal.charset ? { charset: cal.charset } : {}),
      },
    })
    changed++
  }
}
console.log(VERIFY ? `verify-only done` : `updated ${changed} rule(s)`)
await db.$disconnect()
