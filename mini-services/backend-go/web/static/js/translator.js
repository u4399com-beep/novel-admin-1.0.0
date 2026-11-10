/**
 * translator.js —— 阅读页翻译控件（R137）
 *
 * 注入方式：backend renderPage 对 chapter 页 </body> 前统一注入（12 主题零模板改动）。
 * 仅 /chapter/{id} 页生效，其余路径静默退出。
 *
 * 主题无关设计：
 *   - 正文容器探测链（候选选择器 → p 元素最多的容器兜底）——不依赖任何主题特定结构；
 *   - 只做两种 DOM 操作：往 body 追加悬浮工具条 + 对正文 <p> 赋值 textContent；
 *     不改写/移动主题既有节点，译文经 textContent 赋值（浏览器转义，XSS 免疫）。
 *
 * 目标语种：zh-Hant（OpenCC 本地词典转换，秒级）/ en（LLM 文学翻译，6 段/批串行，
 * 进度实时显示）。失败段保留原文（后端契约：失败段 results 空串，不编造）。
 * 分批统一 ≤96 段/请求（R137 实测长章 109+ 段；繁体虽快也分批——兼容保守上游部署）。
 *
 * 缓存：localStorage 按 {chId}:{target} 持久缓存（>1.5MB 单条放弃写入防配额溢出）；
 * 二次切换零网络请求。
 *
 * API：POST /api/translate {target, items, chapterId} → {ok, results[], failedCount}
 */
(function () {
  'use strict';

  var m = location.pathname.match(/^\/chapter\/(\d+)/);
  if (!m) return;
  var chId = m[1];

  // ---------- 正文容器探测（主题无关） ----------
  var CANDIDATES = [
    '#fb-chapter-content', '.read-content', '.chapter-content', '#content',
    '.content', '.txt-content', '.book-content', 'article', '.article-content'
  ];

  function findContentEl() {
    for (var i = 0; i < CANDIDATES.length; i++) {
      try {
        var el = document.querySelector(CANDIDATES[i]);
        if (el && el.querySelector('p')) return el;
      } catch (e) { /* 选择器异常跳过 */ }
    }
    // 兜底：p 元素最多的容器（全部候选失配时）
    var best = null, bestN = 0;
    var all = document.querySelectorAll('div, article, section, main');
    for (var j = 0; j < all.length; j++) {
      var n = all[j].querySelectorAll('p').length;
      if (n > bestN) { bestN = n; best = all[j]; }
    }
    return best;
  }

  var container = findContentEl();
  if (!container) return; // 空章/非正文页静默退出

  var paras = Array.prototype.slice.call(container.querySelectorAll('p')).filter(function (p) {
    return (p.textContent || '').trim().length >= 2;
  });
  if (paras.length === 0) return; // 占位空章（采集中）无翻译面

  var origTexts = paras.map(function (p) { return p.textContent; });

  // ---------- 状态 ----------
  var current = null;      // 当前生效语种（null = 原文）
  var inflight = false;    // 翻译进行中（防并发切换）
  var toastTimer = null;

  // ---------- 工具条 UI ----------
  var style = document.createElement('style');
  style.textContent =
    '#tr-bar{position:fixed;right:16px;bottom:76px;z-index:99999;display:flex;gap:6px;' +
    'align-items:center;padding:8px 10px;background:rgba(24,24,27,.92);border-radius:12px;' +
    'box-shadow:0 4px 16px rgba(0,0,0,.25);font-size:13px;font-family:system-ui,sans-serif;' +
    'max-width:calc(100vw - 32px);flex-wrap:wrap}' +
    '#tr-bar button{border:1px solid rgba(255,255,255,.25);background:transparent;color:#e4e4e7;' +
    'padding:6px 12px;border-radius:8px;cursor:pointer;font-size:13px;min-height:32px;line-height:1.2}' +
    '#tr-bar button:hover{background:rgba(255,255,255,.12)}' +
    '#tr-bar button.tr-on{background:#e4e4e7;color:#18181b;font-weight:600;border-color:#e4e4e7}' +
    '#tr-bar button:disabled{opacity:.45;cursor:wait}' +
    '#tr-bar .tr-msg{color:#a1a1aa;font-size:12px;max-width:180px;overflow:hidden;' +
    'text-overflow:ellipsis;white-space:nowrap}';
  document.head.appendChild(style);

  var bar = document.createElement('div');
  bar.id = 'tr-bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', '章节翻译');

  var btnOrig = document.createElement('button');
  btnOrig.type = 'button'; btnOrig.textContent = '原文'; btnOrig.className = 'tr-on';
  var btnHant = document.createElement('button');
  btnHant.type = 'button'; btnHant.textContent = '繁體';
  var btnEn = document.createElement('button');
  btnEn.type = 'button'; btnEn.textContent = 'English';
  var msg = document.createElement('span');
  msg.className = 'tr-msg';
  bar.appendChild(btnOrig); bar.appendChild(btnHant); bar.appendChild(btnEn); bar.appendChild(msg);
  document.body.appendChild(bar);

  function setMsg(text, sticky) {
    // sticky：进度类消息保持到下一次更新（批耗时 > toast 生命周期会被清空，R137 实测
    // 「翻译中 n/m 段」8s 即消失，读者无从得知是否在翻译）；终态消息（完成/失败）才自动清
    msg.textContent = text || '';
    if (toastTimer) clearTimeout(toastTimer);
    if (text && !sticky) {
      toastTimer = setTimeout(function () { msg.textContent = ''; }, 8000);
    }
  }
  function setActive(name) {
    [btnOrig, btnHant, btnEn].forEach(function (b) { b.classList.remove('tr-on'); });
    (name === 'zh-Hant' ? btnHant : name === 'en' ? btnEn : btnOrig).classList.add('tr-on');
  }
  function setBusy(busy) {
    [btnOrig, btnHant, btnEn].forEach(function (b) { b.disabled = busy; });
  }

  // ---------- 缓存 ----------
  function cacheKeyOf(target) { return 'tr:v1:' + chId + ':' + target; }
  function cacheRead(target) {
    try {
      var raw = localStorage.getItem(cacheKeyOf(target));
      if (!raw) return null;
      var obj = JSON.parse(raw);
      // 前缀对齐（R137 实测：正文 re-collect 后段落数漂移 1 段 → 严格相等校验失败
      // → 全章重翻成本放大）。缓存段数 ≤ 当前段数即命中：逐索引渲染，多出段落保留原文。
      if (obj && Array.isArray(obj.r) && obj.r.length > 0 && obj.r.length <= origTexts.length) return obj.r;
      return null;
    } catch (e) { return null; }
  }
  function cacheWrite(target, arr) {
    try {
      var raw = JSON.stringify({ v: 1, t: target, r: arr });
      if (raw.length > 1500000) return; // 1.5MB 上限：超长章不缓存（防配额溢出）
      localStorage.setItem(cacheKeyOf(target), raw);
    } catch (e) { /* quota 溢出静默 */ }
  }

  // ---------- 渲染 ----------
  function renderTranslated(arr) {
    // 前缀对齐渲染：min(arr.length, paras.length)；译文空段保留原文（不编造）
    var n = Math.min(arr.length, paras.length);
    for (var i = 0; i < n; i++) {
      if (arr[i] && arr[i].trim()) {
        paras[i].textContent = arr[i];
      }
    }
  }
  function renderOriginal() {
    for (var i = 0; i < paras.length; i++) {
      paras[i].textContent = origTexts[i];
    }
  }

  // ---------- 上游调用 ----------
  function requestTranslate(target, items) {
    return fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: target, items: items, chapterId: Number(chId) })
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (d) {
      if (!d || !d.ok) throw new Error((d && d.error) || 'translate failed');
      return d.results;
    });
  }

  function translateTo(target, label) {
    if (current === target || inflight) return;
    if (current === null && target !== null) {
      // 首次进翻译态：保存当前 DOM（原文即 origTexts，无需另存）
    }
    if (target === null) {
      current = null; setActive('orig'); renderOriginal(); setMsg('');
      return;
    }
    inflight = true; setBusy(true); setMsg('加载中…');
    var hit = cacheRead(target);
    if (hit) {
      renderTranslated(hit);
      // ⚠ inflight 必须复位（R137 E2E 实测：命中分支漏复位 → 后续所有切换被守卫永久拦截）
      current = target; setActive(target); inflight = false; setBusy(false); setMsg('已从缓存恢复');
      return;
    }
    var results = new Array(origTexts.length);
    var idx = 0;
    var BATCH = target === 'en' ? 6 : 96; // en 小批走 LLM 质量+进度；繁体 96/批秒级近实时
    var doneCount = 0;

    function next() {
      if (idx >= origTexts.length) return Promise.resolve();
      var start = idx, end = Math.min(idx + BATCH, origTexts.length);
      idx = end;
      var slice = origTexts.slice(start, end);
      return requestTranslate(target, slice).then(function (r) {
        for (var k = 0; k < slice.length; k++) {
          results[start + k] = (r && r[k]) || '';
          // 渐进渲染：每批完成即时上屏（R137 实测全文等批完对长章体验差）
          if (results[start + k]) paras[start + k].textContent = results[start + k];
        }
        doneCount = end;
        setMsg(label + ' ' + doneCount + '/' + origTexts.length + ' 段…', true); // 进度持久
        return next();
      });
    }

    next().then(function () {
      cacheWrite(target, results);
      renderTranslated(results);
      // ⚠ inflight 必须复位（R137 E2E 实测：miss 完成回调漏复位 → 后续切换被守卫永久拦截，
      //   与缓存命中分支同款缺陷；两处均已修复）
      current = target; setActive(target); inflight = false; setBusy(false);
      var failed = results.filter(function (v, i) { return !v && origTexts[i].trim(); }).length;
      setMsg(failed > 0 ? '完成（' + failed + ' 段未成功，保留原文）' : '完成');
    }).catch(function (e) {
      inflight = false; setBusy(false); setMsg('翻译失败：' + (e && e.message ? e.message : '请稍后再试'));
    });
  }

  // ---------- 事件 ----------
  btnOrig.addEventListener('click', function () { translateTo(null); });
  btnHant.addEventListener('click', function () { translateTo('zh-Hant', '繁體'); });
  btnEn.addEventListener('click', function () { translateTo('en', 'English'); });

  // 调试探针（window.__trState 暴露内部守卫状态；排障用，生产无害）
  window.__trState = function () {
    return { current: current, inflight: inflight, paras: paras.length, orig: origTexts.length };
  };
})();
