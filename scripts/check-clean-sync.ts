/**
 * 清洗器双实现同步校验（12-d C5，12-g 落地）
 *
 * 背景：scraper-service 是独立 Bun 进程，跨进程无法共享模块，正文/字段清洗规则
 * 存在同源双实现，历史上靠「改规则必须两边同步」的人工约定防漂移。本脚本把
 * 同步校验自动化：
 *   - content-clean：src/lib/content-clean.ts ↔ mini-services/scraper-service/src/clean.ts
 *     （NOISE_PATTERNS 深度比对 + isNoiseLine 行为探针）
 *   - text-clean：src/lib/text-clean.ts ↔ mini-services/scraper-service/src/text-clean.ts
 *     （decodeHtmlEntities / cleanTextField / cleanDescriptionField 行为探针）
 *
 * 用法：bun scripts/check-clean-sync.ts
 * 退出码：0 = 全部同步；1 = 存在漂移（改任一侧后必须同步另一侧再跑）。
 *
 * 实现注记：引擎模块以「运行时计算的动态 import」加载（非静态 import），
 * 避免把 mini-services 拖进主项目 tsc 程序（tsconfig 已 exclude，静态引用会穿透）。
 */

interface EngineClean {
  NOISE_PATTERNS: Record<string, unknown>
  isNoiseLine: (line: string) => boolean
}
interface EngineTextClean {
  decodeHtmlEntities: (s: string, maxRounds?: number) => string
  cleanTextField: (s: string) => string
  cleanDescriptionField: (s: string, maxChars?: number) => string
}

// ---- 规则对象归一化比对（RegExp 取 source+flags，键排序，兼容两侧注释/顺序差异） ----
function normalize(v: unknown): unknown {
  if (v instanceof RegExp) return { __re: v.source, flags: v.flags }
  if (Array.isArray(v)) return v.map(normalize)
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      o[k] = normalize((v as Record<string, unknown>)[k])
    }
    return o
  }
  return v
}
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b))
}
function diffKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].filter((k) => !deepEqual(a[k], b[k]))
}

// ---- isNoiseLine 行为探针（覆盖全部规则族 + 叙事反例；两端判定必须逐行一致） ----
const PROBE_LINES = [
  // 叙事（必须判 false）
  '少年抬头望去，山巅之上隐约有一座古观。',
  '他忽觉丹田一热，气机竟自行运转起来。',
  '她把信纸折成三折，塞回信封，起身推门而去。',
  '1<2 是显然的（数字形态尖括号不受标签规则影响）。',
  '这一章的线索埋得很深，直到最后才揭开。',
  // 纯符号/无文字
  '————————————————',
  '******',
  // URL/域名
  'www.example.com',
  'https://www.example.com/book/123.html',
  '记住本书首发域名 www.xxxx.com',
  // 站点推广/SEO 水印（短行）
  '天才一秒记住本站地址',
  '求收藏，求推荐票！',
  '本书最新章节请移步官网',
  // 导航/UI 精确匹配
  '上一章',
  '下一页',
  '返回书页',
  '加入书签',
  // 页码残留
  '123',
  '1',
  // 断章提示（短行 + 长句两形态）
  '（本章完）',
  '本章未完，点击下一页继续阅读',
  '手机用户请浏览阅读，更优质的阅读体验。', // TAIL_HINT，长度 >30 ≤80
  // JS/CSS 残留
  'javascript:void(0)',
  'function init() {',
  'document.getElementById("x")',
  // HTML 标签残留（含无闭合 > 的残缺形态）
  '<ins class="sec-last" data-c="1">',
  '</p>',
  '<canvas width="300">',
  // 实体预解码后暴露的标签碎片（双重转义）
  '&amp;lt;ins class=&quot;a&quot;&amp;gt;',
  // 短行边界之外（>30 字符的非断章长句必须放行）
  '他数了数口袋里的铜板，一共只有十七枚，连半袋最便宜的糙米都买不起，不由得苦笑一声。',
]

// ---- text-clean 行为探针（实体解码/字段清洗/简介样板；两端输出必须逐条一致） ----
const TEXT_FIELD_PROBES: [string, string][] = [
  ['书名&#091；#093;测试', '实体上下文补全'],
  ['&amp;lt;tag&amp;gt;多重转义', '多重转义解码'],
  ['字面\\n转义还原', '字面转义序列'],
  ['残缺标签<ins class="a"数据', '残缺标签剥除'],
  ['a<b 数学式字母形态', '标签正则行为对照（保持现状即可，两端一致为准）'],
  ['零宽\u200b字符\uFEFF清除', '隐形字符'],
  ['　全角\u00a0空格折叠', '空白折叠'],
]
const DESC_PROBES: [string, string][] = [
  ['少年自微末中崛起。 《X》是X精心创作的一部网络小说，不代表本站观点。', '尾部样板剥除'],
  ['书名 无弹窗广告全文阅读及书名 TXT下载,最新章节列表', 'SEO 伪简介置空'],
  ['第一段叙事。\n第二段叙事。', '多段保留'],
]

async function main(): Promise<number> {
  const appClean = await import('../src/lib/content-clean')
  const appText = await import('../src/lib/text-clean')
  // 运行时计算的 specifier：不让 tsc 静态解析引擎模块（见文件头注记）
  const engBase = '../mini-services/scraper-service/src'
  const engClean = (await import(`${engBase}/clean.ts`)) as unknown as EngineClean
  const engText = (await import(`${engBase}/text-clean.ts`)) as unknown as EngineTextClean

  let failed = 0
  const fail = (msg: string): void => {
    failed++
    console.error(`✗ ${msg}`)
  }

  // 1. NOISE_PATTERNS 深度比对
  const drift = diffKeys(appClean.NOISE_PATTERNS as Record<string, unknown>, engClean.NOISE_PATTERNS)
  if (drift.length === 0) console.log('✓ NOISE_PATTERNS 规则对象两侧一致')
  else fail(`NOISE_PATTERNS 漂移键: ${drift.join(', ')}`)

  // 2. isNoiseLine 行为探针
  let lineMismatches = 0
  for (const line of PROBE_LINES) {
    const a = appClean.isNoiseLine(line)
    const b = engClean.isNoiseLine(line)
    if (a !== b) {
      lineMismatches++
      fail(`isNoiseLine 判定不一致: ${JSON.stringify(line.slice(0, 40))} 主站=${a} 引擎=${b}`)
    }
  }
  if (lineMismatches === 0) console.log(`✓ isNoiseLine 行为探针 ${PROBE_LINES.length}/${PROBE_LINES.length} 一致`)

  // 3. text-clean 行为探针
  let fieldMismatches = 0
  const cmp = (label: string, input: string, a: string, b: string): void => {
    if (a !== b) {
      fieldMismatches++
      fail(`${label} 输出不一致 (${input.slice(0, 24)}…): 主站=${JSON.stringify(a.slice(0, 40))} 引擎=${JSON.stringify(b.slice(0, 40))}`)
    }
  }
  for (const [input] of TEXT_FIELD_PROBES) {
    cmp('decodeHtmlEntities', input, appText.decodeHtmlEntities(input), engText.decodeHtmlEntities(input))
    cmp('cleanTextField', input, appText.cleanTextField(input), engText.cleanTextField(input))
  }
  for (const [input] of DESC_PROBES) {
    cmp('cleanDescriptionField', input, appText.cleanDescriptionField(input), engText.cleanDescriptionField(input))
  }
  if (fieldMismatches === 0) {
    console.log(`✓ text-clean 行为探针一致（实体/字段 ${(TEXT_FIELD_PROBES.length * 3)} 条 + 简介 ${DESC_PROBES.length} 条）`)
  }

  if (failed === 0) {
    console.log('同步校验通过：content-clean ↔ engine clean.ts、text-clean ×2 无漂移')
    return 0
  }
  console.error(`同步校验失败：${failed} 处漂移——修改任一侧规则后必须同步另一侧！`)
  return 1
}

process.exitCode = await main()

export {} // 确保本文件被识别为模块（顶层 await 需要）
