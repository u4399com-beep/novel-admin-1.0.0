/**
 * translate-service —— novel-admin 翻译侧车（R137）
 *
 * 定位：backend-go /api/translate 的上游执行器，与 stealth-service 同层的独立进程。
 * 能力矩阵（按 target 分发）：
 *   - zh-Hant（繁体中文）：OpenCC s2twp（简→台湾正体含词组习惯）——纯本地词典转换，
 *     秒级零成本，一次转换终身缓存。
 *   - en（英文）：z-ai-web-dev-sdk LLM 文学翻译——段落编号批量（8 段/批），批间并发
 *     上限 2，解析失败段单段降级重试；SDK 不可用时 llm=false 明确报错（不编造）。
 *   - 其余语种预留：targets 表驱动，后续加语种只需注册（prompt + 校验），API 不变。
 *
 * 缓存分层（性能契约）：
 *   - 本服务：进程内 LRU（容量 2000）——热章重读零计算；
 *   - backend-go：SQLite TranslationCache 持久缓存（跨会话/跨重启）——LLM 结果
 *     只生成一次，重复阅读直读库。侧车重启丢失 LRU 不影响正确性。
 *
 * 端口：3032 固定（仅 backend-go 内网代理访问，不经网关暴露前端）。
 *
 * API：
 *   GET  /api/health → {"ok":true,"service":"translate-service","opencc":bool,"llm":bool}
 *   POST /api/translate {"target":"zh-Hant"|"en","items":["段1","段2",...],
 *                        "context":{"novelTitle":"...","chapterTitle":"..."}} 可选
 *                    → {"ok":true,"results":[...],"cached":n,"translated":n,"failed":[idx]}
 *
 * 防滥用约束：items ≤ 96 段 / 单段 ≤ 10000 字 / 总量 ≤ 120000 字；LLM 批超时 120s。
 */

import OpenCC from 'opencc-js';

const PORT = 3032;
const LRU_MAX = 2000;
const LLM_BATCH = 8;           // 英文翻译每批段数（过多易截断/漏段）
const LLM_CONCURRENCY = 2;     // 批间并发上限（SDK 限流保护）
const LLM_BATCH_TIMEOUT_MS = 120_000;
const MAX_ITEMS = 300; // R137 实测长章 109+ 段常态；成本主闸是 MAX_TOTAL_CHARS
const MAX_ITEM_CHARS = 10_000;
const MAX_TOTAL_CHARS = 120_000;

/** 支持的目标语种注册表：转换器/prompt 表驱动，加语种只动这里（API 契约不变） */
const TARGETS: Record<string, { label: string; engine: 'opencc' | 'llm'; conv?: string; lang?: string }> = {
  'zh-Hant': { label: '繁體中文（台灣正體）', engine: 'opencc', conv: 's2twp' },
  'en': { label: 'English', engine: 'llm', lang: 'English' },
};

// ==================== OpenCC（懒加载，失败不阻塞服务起） ====================
let openccConv: ReturnType<typeof OpenCC.Converter> | null = null;
try {
  openccConv = OpenCC.Converter({ from: 'cn', to: 'twp' });
  console.log('[translate] opencc s2twp ready');
} catch (e) {
  console.log('[translate] opencc init FAIL:', e);
}

// ==================== LLM（懒加载；SDK 缺失/失败 → llm=false 明确报错） ====================
let zai: Awaited<ReturnType<(typeof import('z-ai-web-dev-sdk'))['default']['create']>> | null = null;
let llmTried = false;
async function getLLM() {
  if (llmTried) return zai;
  llmTried = true;
  try {
    const mod = await import('z-ai-web-dev-sdk');
    zai = await mod.default.create();
    console.log('[translate] LLM (z-ai-web-dev-sdk) ready');
  } catch (e) {
    zai = null;
    console.log('[translate] LLM init FAIL:', e instanceof Error ? e.message : e);
  }
  return zai;
}

// ==================== 进程内 LRU 缓存 ====================
const cache = new Map<string, string>(); // Map 插入序 = LRU 访问序（get 时重新插入）
function cacheKey(target: string, text: string) {
  return target + '\x00' + text;
}
function cacheGet(k: string): string | undefined {
  const v = cache.get(k);
  if (v !== undefined) {
    cache.delete(k);
    cache.set(k, v); // 触底续命
  }
  return v;
}
function cacheSet(k: string, v: string) {
  if (cache.has(k)) cache.delete(k);
  cache.set(k, v);
  if (cache.size > LRU_MAX) {
    cache.delete(cache.keys().next().value as string);
  }
}

// ==================== LLM 批量翻译 ====================

const SYSTEM_PROMPT =
  'You are a professional literary translator for Chinese web novels. ' +
  'Translate each numbered Chinese passage into {LANG} natural, fluent prose. ' +
  'Preserve meaning, tone and narrative style; transliterate character names in pinyin; ' +
  'keep quotation marks and paragraph structure. ' +
  'Output ONLY the numbered translations in the exact same format: "[n] translated text" on separate lines. ' +
  'Never merge, split, omit, reorder or add passages. Never add commentary.';

/** 按行号标记切分 LLM 输出；未匹配段返回 undefined（由调用方降级重试） */
function parseNumbered(out: string, n: number): string[] {
  const results = new Array<string>(n).fill('');
  const found = new Array<boolean>(n).fill(false);
  // 允许 [1]、[ 1 ]、1. 三种行头形态（LLM 输出形态容错）
  const re = /^\s*[\[（(]?\s*(\d{1,3})\s*[\]）)]?\s*[.:、]?\s*/;
  const lines = out.split(/\r?\n/);
  let cur = -1;
  for (const line of lines) {
    const m = line.match(re);
    if (m) {
      const idx = parseInt(m[1], 10) - 1;
      if (idx >= 0 && idx < n) {
        cur = idx;
        results[idx] = line.slice(m[0].length);
        found[idx] = true;
        continue;
      }
    }
    if (cur >= 0 && line.trim()) {
      results[cur] += '\n' + line; // 段内续行拼接
    }
  }
  return results.map((v, i) => (found[i] && v.trim() ? v.trim() : ''));
}

function chatOnce(system: string, user: string): Promise<string> {
  // zai.chat.completions.create 包装：429 限流退避重试（2s/6s/15s）+ 超时 + 消息契约
  //（system 走 assistant role）。429 是共享上游配额的常态瞬态——退避重试从「段失败
  // 保留原文」升级为「延迟后成功」，其余错误立即抛出（上游调用方已有单段降级层）。
  const DELAYS = [0, 2000, 6000, 15000, 30000, 60000];
  let lastErr: Error | null = null;
  const attempt = async (): Promise<string> => {
    const client = await getLLM();
    if (!client) throw new Error('LLM unavailable (z-ai-web-dev-sdk not installed)');
    const completion = (await Promise.race([
      client.chat.completions.create({
        messages: [
          { role: 'assistant', content: system },
          { role: 'user', content: user },
        ],
        thinking: { type: 'disabled' },
      }),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('LLM batch timeout')), LLM_BATCH_TIMEOUT_MS),
      ),
    ])) as { choices?: Array<{ message?: { content?: string } }> };
    const content = completion?.choices?.[0]?.message?.content ?? '';
    if (!content.trim()) throw new Error('LLM empty response');
    return content;
  };
  return (async () => {
    for (let i = 0; i < DELAYS.length; i++) {
      if (DELAYS[i] > 0) await new Promise((r) => setTimeout(r, DELAYS[i]));
      try {
        return await attempt();
      } catch (e) {
        lastErr = e instanceof Error ? e : new Error(String(e));
        if (!/429|rate.?limit|too many/i.test(lastErr.message)) throw lastErr; // 非限流瞬态不重试
        console.log(`[translate] LLM 429 rate-limited, retry ${i + 1}/${DELAYS.length - 1} after ${DELAYS[Math.min(i + 1, DELAYS.length - 1)]}ms`);
      }
    }
    throw lastErr ?? new Error('LLM retries exhausted');
  })();
}

/** 简单并发闸：批任务池，最多 LLM_CONCURRENCY 个在飞 */
async function runPool<T>(tasks: Array<() => Promise<T>>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(LLM_CONCURRENCY, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const i = cursor++;
      try {
        await tasks[i]();
      } catch (e) {
        console.log('[translate] batch task error:', e instanceof Error ? e.message : e);
      }
    }
  });
  await Promise.all(workers);
}

/** 英文（LLM）翻译主流程：分批 → 编号解析 → 失败段单段降级重试 → 汇总 */
async function translateLLM(
  items: string[],
  lang: string,
  context?: { novelTitle?: string; chapterTitle?: string },
): Promise<{ results: string[]; failed: number[] }> {
  const n = items.length;
  const results = new Array<string>(n).fill('');
  const failed: number[] = [];

  const system = SYSTEM_PROMPT.replace('{LANG}', lang);
  const ctxHint =
    context?.novelTitle || context?.chapterTitle
      ? `\n（作品背景：${context.novelTitle ?? ''} ${context.chapterTitle ?? ''}）`
      : '';

  // 批拆分
  const batches: Array<{ start: number; texts: string[] }> = [];
  for (let i = 0; i < n; i += LLM_BATCH) {
    batches.push({ start: i, texts: items.slice(i, i + LLM_BATCH) });
  }

  const tasks = batches.map(({ start, texts }) => async () => {
    const numbered = texts.map((t, i) => `[${i + 1}] ${t}`).join('\n');
    let out = '';
    try {
      out = await chatOnce(system, numbered + ctxHint);
    } catch (e) {
      console.log(`[translate] batch@${start} FAIL:`, e instanceof Error ? e.message : e);
    }
    const parsed = parseNumbered(out, texts.length);
    // 降级：批解析失败/漏段的段 → 单段重试一次
    for (let i = 0; i < texts.length; i++) {
      const gi = start + i;
      if (parsed[i]) {
        results[gi] = parsed[i];
        continue;
      }
      try {
        const one = await chatOnce(system, `[1] ${texts[i]}`);
        const oneParsed = parseNumbered(one, 1);
        results[gi] = oneParsed[0] || '';
      } catch (e) {
        console.log(`[translate] item@${gi} single FAIL:`, e instanceof Error ? e.message : e);
      }
      if (!results[gi]) failed.push(gi);
    }
  });
  await runPool(tasks);
  return { results, failed };
}

// ==================== HTTP 服务 ====================

function json(w: Parameters<Bun.Responder[0]>[0], code: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status: code,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

let stats = { reqTotal: 0, llmCalls: 0, cacheHits: 0 };

Bun.serve({
  port: PORT,
  idleTimeout: 255, // Bun 秒制上限：LLM 长批期间 keep-alive 不被掐
  async fetch(req) {
    const url = new URL(req.url);
    stats.reqTotal++;

    if (url.pathname === '/api/health') {
      return json(null, 200, {
        ok: true,
        service: 'translate-service',
        opencc: openccConv != null,
        llm: llmTried ? zai != null : true, // 未尝试前视为可用（懒加载预热在首次翻译时进行）
        targets: Object.keys(TARGETS),
        cacheSize: cache.size,
        stats,
        time: new Date().toISOString(),
      });
    }

    if (url.pathname === '/api/translate' && req.method === 'POST') {
      let body: { target?: string; items?: unknown; context?: { novelTitle?: string; chapterTitle?: string } };
      try {
        body = await req.json();
      } catch {
        return json(null, 400, { ok: false, error: 'invalid JSON body' });
      }
      const target = body.target ?? '';
      const conf = TARGETS[target];
      if (!conf) {
        return json(null, 400, { ok: false, error: `unsupported target: ${target} (supported: ${Object.keys(TARGETS).join(',')})` });
      }
      const items = body.items;
      if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) {
        return json(null, 400, { ok: false, error: `items must be a non-empty array (max ${MAX_ITEMS})` });
      }
      const texts: string[] = [];
      let total = 0;
      for (const it of items) {
        if (typeof it !== 'string') {
          return json(null, 400, { ok: false, error: 'items must all be strings' });
        }
        if (it.length > MAX_ITEM_CHARS) {
          return json(null, 400, { ok: false, error: `item too long (max ${MAX_ITEM_CHARS} chars)` });
        }
        total += it.length;
        texts.push(it);
      }
      if (total > MAX_TOTAL_CHARS) {
        return json(null, 400, { ok: false, error: `total too long (max ${MAX_TOTAL_CHARS} chars)` });
      }

      // 1) 缓存命中分流
      const results = new Array<string>(texts.length).fill('');
      const missIdx: number[] = [];
      let cached = 0;
      for (let i = 0; i < texts.length; i++) {
        const t = texts[i];
        if (t.trim().length < 2) {
          results[i] = t; // 空段/极短段直通（翻译无意义）
          continue;
        }
        const hit = cacheGet(cacheKey(target, t));
        if (hit !== undefined) {
          results[i] = hit;
          cached++;
          stats.cacheHits++;
        } else {
          missIdx.push(i);
        }
      }

      // 2) 未命中段按引擎分发
      if (missIdx.length > 0) {
        try {
          if (conf.engine === 'opencc') {
            if (!openccConv) throw new Error('opencc not initialized');
            for (const i of missIdx) {
              const out = openccConv(texts[i]) || texts[i];
              results[i] = out;
              cacheSet(cacheKey(target, texts[i]), out);
            }
          } else {
            const client = await getLLM();
            if (!client) {
              return json(null, 503, { ok: false, error: 'LLM backend unavailable: z-ai-web-dev-sdk not installed in this deployment' });
            }
            const { results: translated, failed } = await translateLLM(
              missIdx.map((i) => texts[i]),
              conf.lang ?? 'English',
              body.context,
            );
            stats.llmCalls += Math.ceil(missIdx.length / LLM_BATCH);
            for (let k = 0; k < missIdx.length; k++) {
              const gi = missIdx[k];
              if (translated[k]) {
                results[gi] = translated[k];
                cacheSet(cacheKey(target, texts[gi]), translated[k]);
              } else {
                results[gi] = ''; // 失败段留空：前端保留原文（不编造）
              }
            }
          }
        } catch (e) {
          return json(null, 502, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      }

      return json(null, 200, {
        ok: true,
        target,
        results,
        cached,
        translated: missIdx.length,
        failedCount: results.filter((r, i) => r === '' && texts[i].trim().length >= 2).length,
      });
    }

    return json(null, 404, { ok: false, error: 'not found (see /api/health)' });
  },
});

console.log(`[translate] listening on :${PORT} targets=${Object.keys(TARGETS).join(',')}`);
