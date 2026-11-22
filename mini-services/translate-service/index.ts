/**
 * translate-service —— novel-admin 翻译侧车（R137）
 *
 * 定位：backend-go /api/translate 的上游执行器，与 stealth-service 同层的独立进程。
 * 能力矩阵（按 target 分发，R138 扩至 4 语种）：
 *   - zh-Hant（繁体中文·台湾正体）：OpenCC s2twp——纯本地词典转换，
 *     秒级零成本，一次转换终身缓存。
 *   - zh-HK（繁体中文·香港）：OpenCC s2hk——同上零成本词典转换（R138）。
 *   - en（英文）：z-ai-web-dev-sdk LLM 文学翻译——段落编号批量（8 段/批），批间并发
 *     上限 2，解析失败段单段降级重试；SDK 不可用时 llm=false 明确报错（不编造）。
 *   - ja（日文，R138）：同 LLM 通道，人名保留汉字（prompt namesHint 按语种注入）。
 *   - libre（R168）：LibreTranslate 兜底引擎（127.0.0.1:5000 内网，Argos/ctranslate2 CPU
 *     推理，无 torch）——LLM 失败段（429/枯竭/超时）自动垫底，保证全站翻译永不空白。
 *     libre 结果不写 LRU（防半吊子译文固化挡住 LLM 后续升级）。
 *   - 其余语种预留：targets 表驱动，后续加语种只需注册（prompt + 校验），API 不变。
 *
 * 引擎选择（R168，POST body 新增可选 engine 字段）：
 *   - engine 缺省/"auto"：LLM 先行（文学质量首选）→ 失败段 libre 垫底；
 *   - engine="llm"：纯 LLM，失败段留空（旧行为，回退开关）；
 *   - engine="libre"：全批 libre（预热工作器 429 熔断期使用，0.6s/段无限量快速垫底）。
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
/** R138：截止期驱动重试——backend 上游超时 150s，侧车必须在 ~130s 内给出答复
 *  （429 风暴实测：读者批翻連续 upstream FAIL「context deadline exceeded」→ 整批丢，
 *  旧重试链最坏 113s sleep + 5×120s attempt 远超 150s）。剩余时间不足一次最小尝试
 *  时立即放弃，失败段留空由前端保留原文——优雅降级而非挂死。 */
const LLM_DEADLINE_MS = 130_000;
const LLM_MIN_ATTEMPT_MS = 8_000;
const MAX_ITEMS = 300; // R137 实测长章 109+ 段常态；成本主闸是 MAX_TOTAL_CHARS
const MAX_ITEM_CHARS = 10_000;
const MAX_TOTAL_CHARS = 120_000;

/** R168：LibreTranslate 兜底引擎配置（127.0.0.1:5000 内网，LibreTranslate 标准协议）。
 *  LT_URL 可指向任何自部署实例（含远程 GPU 服务器）；探针熔断 3 连败 → 5min 冷却。 */
const LT_URL = (globalThis as Record<string, unknown>).process
  ? ((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.LT_URL || 'http://127.0.0.1:5000')
  : 'http://127.0.0.1:5000';
const LT_BATCH_TIMEOUT_MS = 90_000;  // pivot 两跳较慢（zh→ja 实测 ~6s/段），批量上限 90s
const LT_COOLDOWN_MS = 5 * 60_000;   // 熔断冷却：3 连败后 5min 内不再尝试
const LT_MAX_FAILS = 3;
/** libre 支持的目标语种映射（zh-Hant/zh-HK 不走 libre：OpenCC 词典转换质量更高零成本） */
const LT_TARGETS: Record<string, string> = { 'en': 'en', 'ja': 'ja', 'ko': 'ko' };
const LT_SOURCE = 'zh-Hans'; // 站内内容源固定简中

/** libre 熔断状态（进程内）：probing/lastProbe 支撑冷却期低频后台探针 */
const libreState = { fails: 0, downUntil: 0, probing: false, lastProbe: 0 };

/** 支持的目标语种注册表：转换器/prompt 表驱动，加语种只动这里（API 契约不变，R138 扩展） */
const TARGETS: Record<string, { label: string; engine: 'opencc' | 'llm'; conv?: string; lang?: string; namesHint?: string }> = {
  'zh-Hant': { label: '繁體中文（台灣正體）', engine: 'opencc', conv: 's2twp' },
  'zh-HK': { label: '繁體中文（香港）', engine: 'opencc', conv: 's2hk' },
  'en': { label: 'English', engine: 'llm', lang: 'English', namesHint: 'transliterate character names in pinyin' },
  'ja': { label: '日本語', engine: 'llm', lang: 'Japanese', namesHint: 'keep character names in kanji (Chinese characters), do not transliterate them' },
  // R139：韩文（LLM 通道一行注册）——人名约定：汉字名取 Sino-Korean 音读或保留拼音，
  // 全篇保持同一约定（避免同一名角两种转写混用）。
  'ko': { label: '한국어', engine: 'llm', lang: 'Korean', namesHint: 'render character names consistently using the Sino-Korean (hanja) reading, or keep Chinese pinyin — pick ONE convention and apply it throughout the whole passage' },
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

// ==================== LibreTranslate 客户端（R168 兜底引擎） ====================

/** libre 健康判定：熔断冷却期内视为不可用（探针惰性，失败计数即探针）。
 *  R168 补强：冷却期内低频后台探针（60s 一次，异步不阻塞读者请求）——探活成功
 *  立即解除熔断，LT 恢复延迟从 5min 固定冷却缩短到 ≤60s（实删场景：LT 被沙箱
 *  清杀后重启，translate-service 无需人工干预自动重新接上）。 */
function libreAvailable(): boolean {
  if (Date.now() < libreState.downUntil) {
    const now = Date.now();
    if (!libreState.probing && now - libreState.lastProbe > 60_000) {
      libreState.probing = true;
      libreState.lastProbe = now;
      fetch(LT_URL + '/languages', { signal: AbortSignal.timeout(5000) })
        .then((r) => {
          libreState.probing = false;
          if (r.ok) {
            console.log('[translate] libre probe OK → 解除熔断');
            libreMarkOk();
          }
        })
        .catch(() => {
          libreState.probing = false;
        });
    }
    return false;
  }
  return true;
}

function libreMarkFail() {
  libreState.fails++;
  if (libreState.fails >= LT_MAX_FAILS) {
    libreState.downUntil = Date.now() + LT_COOLDOWN_MS;
    console.log(`[translate] libre DOWN（${LT_MAX_FAILS} 连败）→ 冷却 5min`);
  }
}

function libreMarkOk() {
  if (libreState.fails > 0 || libreState.downUntil > 0) {
    console.log('[translate] libre recovered');
  }
  libreState.fails = 0;
  libreState.downUntil = 0;
}

/** LibreTranslate 批量翻译（q 数组单次调用，标准协议）。
 *  失败/超时/不可用 → 返回 null（调用方保持留空语义，绝不编造）。
 *  libre 结果调用方不落 LRU（防半吊子固化挡住 LLM 升级，R168）。 */
async function translateLibre(items: string[], target: string): Promise<string[] | null> {
  const ltTarget = LT_TARGETS[target];
  if (!ltTarget || !libreAvailable()) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LT_BATCH_TIMEOUT_MS);
  try {
    const resp = await fetch(LT_URL + '/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: items, source: LT_SOURCE, target: ltTarget, format: 'text' }),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      libreMarkFail();
      console.log(`[translate] libre HTTP ${resp.status} (${LT_URL})`);
      return null;
    }
    const data = (await resp.json()) as { translatedText?: string | string[] };
    const out = data?.translatedText;
    const arr = Array.isArray(out) ? out : typeof out === 'string' ? [out] : [];
    if (arr.length !== items.length) {
      libreMarkFail();
      console.log(`[translate] libre length mismatch: want ${items.length} got ${arr.length}`);
      return null;
    }
    libreMarkOk();
    return arr.map((s) => (typeof s === 'string' && s.trim() ? s : ''));
  } catch (e) {
    libreMarkFail();
    console.log('[translate] libre FAIL:', e instanceof Error ? e.message : e);
    return null;
  } finally {
    clearTimeout(timer);
  }
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
  'Preserve meaning, tone and narrative style; {NAMES}; ' +
  'keep quotation marks and paragraph structure. ' +
  'Output ONLY the numbered translations in the exact same format: "[n] translated text" on separate lines. ' +
  'Never merge, split, omit, reorder or add passages. Never add commentary.';

/** 人名处理指令按语种注入（R138）：拼音转写只适用拉丁字母语种，日文保留汉字 */
const NAMES_DEFAULT = 'transliterate character names in pinyin';

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

function chatOnce(system: string, user: string, deadline?: number): Promise<string> {
  // zai.chat.completions.create 包装：429 限流退避重试（2s/6s/15s/30s/60s）+ 超时 + 消息契约
  //（system 走 assistant role）。429 是共享上游配额的常态瞬态——退避重试从「段失败
  // 保留原文」升级为「延迟后成功」，其余错误立即抛出（上游调用方已有单段降级层）。
  // R138：重试链受 deadline 约束（translateLLM 级传入），剩余时间不足以完成一次
  // 最小尝试时立即停止重试——保证调用方（backend 150s 窗口）总能拿到响应。
  const DELAYS = [0, 2000, 6000, 15000, 30000, 60000];
  let lastErr: Error | null = null;
  const attempt = async (): Promise<string> => {
    const client = await getLLM();
    if (!client) throw new Error('LLM unavailable (z-ai-web-dev-sdk not installed)');
    const remain = deadline ? deadline - Date.now() : LLM_BATCH_TIMEOUT_MS;
    const timeout = Math.max(1_000, Math.min(LLM_BATCH_TIMEOUT_MS, remain - 1_000));
    const completion = (await Promise.race([
      client.chat.completions.create({
        messages: [
          { role: 'assistant', content: system },
          { role: 'user', content: user },
        ],
        thinking: { type: 'disabled' },
      }),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('LLM batch timeout')), timeout),
      ),
    ])) as { choices?: Array<{ message?: { content?: string } }> };
    const content = completion?.choices?.[0]?.message?.content ?? '';
    if (!content.trim()) throw new Error('LLM empty response');
    return content;
  };
  return (async () => {
    for (let i = 0; i < DELAYS.length; i++) {
      if (DELAYS[i] > 0) {
        if (deadline && Date.now() + DELAYS[i] + LLM_MIN_ATTEMPT_MS > deadline) {
          throw lastErr ?? new Error('LLM deadline exceeded before retry');
        }
        await new Promise((r) => setTimeout(r, DELAYS[i]));
      }
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

/** 英文（LLM）翻译主流程：分批 → 编号解析 → 失败段单段降级重试 → 汇总。
 *  R138：全流程受单一 deadline 约束（批尝试+单段降级共享），保证总响应时间
 *  ≤ LLM_DEADLINE_MS——backend 150s 窗口内必答。 */
async function translateLLM(
  items: string[],
  lang: string,
  namesHint?: string,
  context?: { novelTitle?: string; chapterTitle?: string },
  deadlineMs?: number,
): Promise<{ results: string[]; failed: number[] }> {
  const n = items.length;
  const results = new Array<string>(n).fill('');
  const failed: number[] = [];
  // R169：deadlineMs 钳制（8s..LLM_DEADLINE_MS）——调用方窗口小于 LLM 死线时收窄，
  // 保证「LLM 让位 + libre 垫底 + 响应返回」全链在客户端超时前完成（修复枯竭期
  // 预热器 120s 超时阵亡、服务端垫底结果无人接收的死锁）。
  const dl = Math.max(8_000, Math.min(LLM_DEADLINE_MS, deadlineMs ?? LLM_DEADLINE_MS));
  const deadline = Date.now() + dl;

  const system = SYSTEM_PROMPT
    .replace('{LANG}', lang)
    .replace('{NAMES}', namesHint || NAMES_DEFAULT);
  // R138 缺陷修复：作品背景原拼在 user 消息尾，LLM 会把它当正文回显进译文（ja 实测
  // 「…打ち破った。（作品背景：凡人修仙伝…）」）。改入 system 并明令禁止输出。
  const ctxHint =
    context?.novelTitle || context?.chapterTitle
      ? ` Context for reference only: the passages are from the novel "${context.novelTitle ?? ''}"${context.chapterTitle ? `, chapter "${context.chapterTitle}"` : ''}. Never include, mention or translate this metadata in your output.`
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
      out = await chatOnce(system + ctxHint, numbered, deadline);
    } catch (e) {
      console.log(`[translate] batch@${start} FAIL:`, e instanceof Error ? e.message : e);
      // R138：截止期已尽 → 本批全部段直接判失败，跳过单段降级（同样会超时）
      if (Date.now() >= deadline) {
        for (let i = 0; i < texts.length; i++) failed.push(start + i);
        return;
      }
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
        const one = await chatOnce(system + ctxHint, `[1] ${texts[i]}`, deadline);
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

let stats = { reqTotal: 0, llmCalls: 0, cacheHits: 0, libreCalls: 0, libreFallbacks: 0 };

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
        libre: libreAvailable(), // R168：libre 垗底引擎健康态（熔断冷却期为 false）
        libreUrl: LT_URL,
        engine: 'auto=llm-first+libre-fallback, libre, llm (POST body.engine)',
        targets: Object.keys(TARGETS),
        cacheSize: cache.size,
        stats,
        time: new Date().toISOString(),
      });
    }

    if (url.pathname === '/api/translate' && req.method === 'POST') {
      let body: { target?: string; items?: unknown; engine?: string; deadlineMs?: number; context?: { novelTitle?: string; chapterTitle?: string } };
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
      // R168：引擎选择（auto|llm|libre，缺省 auto=LLM 先行+libre 垗底）
      const engine = body.engine === 'libre' || body.engine === 'llm' ? body.engine : 'auto';
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
            // R168：engine=libre 全批 libre（预热工作器熔断期快速垗底；不落缓存防半吊子固化）
            if (engine === 'libre' && LT_TARGETS[target]) {
              const libreOut = await translateLibre(missIdx.map((i) => texts[i]), target);
              stats.libreCalls++;
              if (libreOut === null) {
                return json(null, 503, {
                  ok: false,
                  error: `libre engine unavailable (probe down or LibreTranslate not reachable at ${LT_URL})`,
                });
              }
              for (let k = 0; k < missIdx.length; k++) {
                results[missIdx[k]] = libreOut[k] || ''; // 失败段留空：前端保留原文
              }
            } else {
              const client = await getLLM();
              if (!client) {
                // R168 auto 模式：SDK 缺失时不再硬 503——libre 兜底（翻译永不空白）
                if (engine === 'auto' && LT_TARGETS[target] && libreAvailable()) {
                  const libreOut = await translateLibre(missIdx.map((i) => texts[i]), target);
                  stats.libreFallbacks++;
                  if (libreOut === null) {
                    return json(null, 503, { ok: false, error: 'LLM unavailable and libre fallback failed (LibreTranslate at ' + LT_URL + ')' });
                  }
                  for (let k = 0; k < missIdx.length; k++) {
                    results[missIdx[k]] = libreOut[k] || '';
                  }
                } else {
                  return json(null, 503, { ok: false, error: 'LLM backend unavailable: z-ai-web-dev-sdk not installed in this deployment' });
                }
              } else {
                const { results: translated, failed } = await translateLLM(
                  missIdx.map((i) => texts[i]),
                  conf.lang ?? 'English',
                  conf.namesHint,
                  body.context,
                  body.deadlineMs,
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
                // R168 auto 模式：LLM 失败段 libre 垗底（不落缓存，LLM 恢复后自然升级）
                if (engine === 'auto' && LT_TARGETS[target]) {
                  const failedIdx = missIdx.filter((gi) => results[gi] === '');
                  if (failedIdx.length > 0 && libreAvailable()) {
                    const libreOut = await translateLibre(failedIdx.map((i) => texts[i]), target);
                    stats.libreFallbacks++;
                    if (libreOut) {
                      for (let k = 0; k < failedIdx.length; k++) {
                        if (libreOut[k]) results[failedIdx[k]] = libreOut[k];
                      }
                    }
                  }
                }
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
