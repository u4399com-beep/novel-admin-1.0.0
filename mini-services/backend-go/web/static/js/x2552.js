/**
 * x2552.js —— 杰奇经典模板主题私有交互（vanilla JS，零依赖）。
 * 移植自 src/themes/x2552 React 状态交互：
 *  1) 阅读记录浮层（localStorage reader.history，写入方为公共 app.js）
 *  2) 目录页：最新章节组反转（新→旧）
 *  3) 章节页：阅读偏好（字号/行距/字体/字色/五场景，localStorage reader-prefs-v1，
 *     与 React 版 use-reader-prefs 同 key 同形状）+ 键盘 ← → 翻章
 *  4) 加入收藏提示（Ctrl+D）
 */
(function () {
  'use strict';

  function lsGet(k, d) {
    try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ }
  }

  /* ---------- 1) 阅读记录浮层 ---------- */
  var histPanel = document.getElementById('x25-hist-panel');
  function openHist() {
    if (!histPanel) return;
    var list = document.getElementById('x25-hist-list');
    var empty = document.getElementById('x25-hist-empty');
    var h = lsGet('reader.history', {});
    var rows = [];
    for (var k in h) if (Object.prototype.hasOwnProperty.call(h, k)) rows.push(h[k]);
    rows.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    if (list) {
      list.innerHTML = '';
      rows.slice(0, 30).forEach(function (r) {
        var li = document.createElement('li');
        li.className = 'flex h-[28px] items-center justify-between gap-2 border-b border-dotted border-[#F2F2F2]';
        var a = document.createElement('a');
        a.className = 'min-w-0 flex-1 truncate text-[#2F468F] hover:text-[#FF6600]';
        a.href = '/chapter/' + r.chapterId;
        a.textContent = (r.bookTitle ? r.bookTitle + ' · ' : '') + (r.title || '第' + r.chapterIdx + '章');
        var meta = document.createElement('span');
        meta.className = 'shrink-0 text-[11px] text-[#999]';
        meta.textContent = r.chapterIdx ? ('第 ' + r.chapterIdx + ' 章') : '';
        li.appendChild(a);
        li.appendChild(meta);
        list.appendChild(li);
      });
    }
    if (empty) empty.style.display = rows.length ? 'none' : '';
    histPanel.removeAttribute('hidden');
  }
  function closeHist() { if (histPanel) histPanel.setAttribute('hidden', ''); }
  Array.prototype.forEach.call(document.querySelectorAll('.x25-hist-btn'), function (b) {
    b.addEventListener('click', openHist);
  });
  if (histPanel) {
    Array.prototype.forEach.call(histPanel.querySelectorAll('[data-x25-hist-close]'), function (b) {
      b.addEventListener('click', closeHist);
    });
  }

  /* ---------- 2) 收藏提示 ---------- */
  Array.prototype.forEach.call(document.querySelectorAll('.x25-fav'), function (b) {
    b.addEventListener('click', function () {
      window.alert('请按 Ctrl+D（Mac 为 ⌘+D）将本站加入收藏夹。');
    });
  });

  /* ---------- 3) 目录页：最新章节组反转 ---------- */
  var latest = document.getElementById('x25-toc-latest');
  if (latest && latest.getAttribute('data-reverse')) {
    var items = Array.prototype.slice.call(latest.children);
    items.reverse().forEach(function (el) { latest.appendChild(el); });
  }

  /* ---------- 4) 章节页：阅读偏好（同 React use-reader-prefs 契约） ---------- */
  var reader = document.getElementById('x25-reader');
  var content = document.getElementById('fb-chapter-content');
  if (reader && content) {
    /* 场景配色：与 Chapter.tsx SCENES 一致（day 页面底色由 body 提供） */
    var SCENES = {
      day:   { page: '',        paper: '#ffffff', ink: '#333333', muted: '#999999', line: '#E4E4E4' },
      paper: { page: '#e6d9bd', paper: '#f8f0da', ink: '#4a3a24', muted: '#a89a80', line: '#d4c5a3' },
      green: { page: '#dcead8', paper: '#f0f6ec', ink: '#2f4030', muted: '#8fa590', line: '#bcd4bc' },
      blue:  { page: '#d8e4ee', paper: '#eef4fa', ink: '#2d3c46', muted: '#8fa2b0', line: '#b8cede' },
      night: { page: '#1e2024', paper: '#26262b', ink: '#c0c0c6', muted: '#8a8a92', line: '#3a3a42' }
    };
    var FONTS = {
      '': '', default: '',
      song: '"Songti SC","SimSun",serif',
      hei: '"Heiti SC","SimHei","Microsoft YaHei",sans-serif',
      kai: 'KaiTi,STKaiti,"楷体",serif'
    };
    var STEPS = [14, 16, 18, 20, 22, 24, 26, 28];
    var LS_KEY = 'reader-prefs-v1';
    var prefs = lsGet(LS_KEY, { fontSize: 18, lineHeight: 1.8, font: 'default', scene: 'day', ink: '' });
    if (!SCENES[prefs.scene]) prefs.scene = 'day';
    if (!FONTS.hasOwnProperty(prefs.font)) prefs.font = 'default';
    if (STEPS.indexOf(+prefs.fontSize) === -1) prefs.fontSize = 18;
    prefs.lineHeight = Math.min(2.6, Math.max(1.4, +prefs.lineHeight || 1.8));

    var RBTN_IDLE = 'x25-rbtn flex h-[20px] min-w-[24px] cursor-pointer items-center justify-center border border-[#CCCCCC] bg-white px-1 text-[11px] text-[#666] transition-colors hover:border-[#FF6600] hover:text-[#FF6600]';
    var RBTN_ON = 'x25-rbtn flex h-[20px] min-w-[24px] cursor-pointer items-center justify-center border border-[#FF6600] bg-white px-1 text-[11px] text-[#666] transition-colors hover:border-[#FF6600] hover:text-[#FF6600]';

    function apply() {
      var sc = SCENES[prefs.scene];
      reader.style.background = sc.page || '';
      var paper = document.getElementById('x25-paper');
      if (paper) {
        paper.style.background = sc.paper;
        paper.style.borderColor = sc.line;
      }
      var h1 = document.getElementById('x25-ch-title');
      if (h1) h1.style.color = prefs.ink || sc.ink;
      var meta = document.getElementById('x25-ch-meta');
      if (meta) meta.style.color = sc.muted;
      content.style.fontSize = prefs.fontSize + 'px';
      content.style.lineHeight = String(prefs.lineHeight);
      content.style.fontFamily = FONTS[prefs.font] || '';
      content.style.color = prefs.ink || sc.ink;
      /* 清掉公共 app.js 的夜间模式内联样式，避免与本主题场景换肤冲突 */
      content.style.background = '';
      document.documentElement.style.background = '';
      var sizeEl = document.getElementById('x25-font-size');
      if (sizeEl) sizeEl.textContent = '当前 ' + prefs.fontSize + 'px';
      Array.prototype.forEach.call(reader.querySelectorAll('.x25-lh'), function (b) {
        b.className = (+b.getAttribute('data-lh') === +prefs.lineHeight) ? RBTN_ON : RBTN_IDLE;
      });
      Array.prototype.forEach.call(reader.querySelectorAll('.x25-scene'), function (b) {
        var on = b.getAttribute('data-scene') === prefs.scene;
        b.className = 'x25-scene h-3.5 w-3.5 cursor-pointer rounded-full border transition-all ' +
          (on ? 'scale-110 border-[#FF6600]' : 'border-black/25');
      });
      var fontSel = document.getElementById('x25-font');
      var inkSel = document.getElementById('x25-ink');
      if (fontSel) fontSel.value = prefs.font || 'default';
      if (inkSel) inkSel.value = prefs.ink || '';
      var nightBtn = document.getElementById('x25-night');
      if (nightBtn) {
        nightBtn.textContent = prefs.scene === 'night' ? '日间' : '夜间';
        nightBtn.className = (prefs.scene === 'night' ? RBTN_ON : RBTN_IDLE) + ' ml-1';
      }
    }

    function stepSize(dir) {
      var i = 0, best = 1e9;
      for (var k = 0; k < STEPS.length; k++) {
        var d = Math.abs(STEPS[k] - prefs.fontSize);
        if (d < best) { best = d; i = k; }
      }
      i = Math.min(STEPS.length - 1, Math.max(0, i + dir));
      prefs.fontSize = STEPS[i];
      lsSet(LS_KEY, prefs);
      apply();
    }
    var dec = document.getElementById('x25-font-dec');
    var inc = document.getElementById('x25-font-inc');
    if (dec) dec.addEventListener('click', function () { stepSize(-1); });
    if (inc) inc.addEventListener('click', function () { stepSize(1); });

    reader.addEventListener('click', function (e) {
      var lh = e.target.closest ? e.target.closest('.x25-lh') : null;
      if (lh) { prefs.lineHeight = +lh.getAttribute('data-lh'); lsSet(LS_KEY, prefs); apply(); return; }
      var sc = e.target.closest ? e.target.closest('.x25-scene') : null;
      if (sc) { prefs.scene = sc.getAttribute('data-scene'); lsSet(LS_KEY, prefs); apply(); }
    });
    var fontSel = document.getElementById('x25-font');
    if (fontSel) fontSel.addEventListener('change', function () { prefs.font = fontSel.value; lsSet(LS_KEY, prefs); apply(); });
    var inkSel = document.getElementById('x25-ink');
    if (inkSel) inkSel.addEventListener('change', function () { prefs.ink = inkSel.value; lsSet(LS_KEY, prefs); apply(); });
    var nightBtn = document.getElementById('x25-night');
    if (nightBtn) nightBtn.addEventListener('click', function () {
      prefs.scene = prefs.scene === 'night' ? 'day' : 'night';
      lsSet(LS_KEY, prefs);
      apply();
    });
    var reset = document.getElementById('x25-reset');
    if (reset) reset.addEventListener('click', function () {
      prefs = { fontSize: 18, lineHeight: 1.8, font: 'default', scene: 'day', ink: '' };
      lsSet(LS_KEY, prefs);
      apply();
    });

    /* 键盘 ← → 翻章 */
    document.addEventListener('keydown', function (e) {
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.tagName === 'BUTTON' || t.isContentEditable)) return;
      var prev = content.getAttribute('data-prev-id');
      var next = content.getAttribute('data-next-id');
      if (e.key === 'ArrowLeft' && prev) location.href = '/chapter/' + prev;
      if (e.key === 'ArrowRight' && next) location.href = '/chapter/' + next;
    });

    apply();
  }
})();
