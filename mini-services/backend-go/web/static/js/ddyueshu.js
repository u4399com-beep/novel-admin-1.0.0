/**
 * ddyueshu.js —— 顶点小说主题私有交互（vanilla JS，零依赖）。
 * 移植自 src/themes/ddyueshu React 状态交互：
 *  1) 欢迎条：设为首页提示 / 收藏本站 / 登录注册演示消息
 *  2) 阅读记录浮层（localStorage reader.history，写入方为公共 app.js）
 *  3) 目录页：最新章节组反转（新→旧）
 *  4) 章节页：书签（dd-marks-{novelId}）+ 阅读设置条（字号/行距/字体/字色/场景/恢复默认，localStorage dd.reader）
 */
(function () {
  'use strict';

  function lsGet(k, d) {
    try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ }
  }

  /* ---------- 1) 欢迎条 ---------- */
  Array.prototype.forEach.call(document.querySelectorAll('.dd-fav'), function (b) {
    b.addEventListener('click', function () {
      var ok = false;
      try { ok = window.external && window.external.AddFavorite && window.external.AddFavorite(location.href, document.title); } catch (e) { ok = false; }
      if (!ok) window.alert('请按 Ctrl+D（Mac 为 ⌘+D）将本站加入收藏夹；在浏览器设置中可将本站设为主页。');
    });
  });
  var loginBtn = document.getElementById('dd-login-btn');
  var regBtn = document.getElementById('dd-reg-btn');
  var loginMsg = document.getElementById('dd-login-msg');
  function showMsg(t) {
    if (loginMsg) { loginMsg.textContent = t; loginMsg.classList.remove('hidden'); }
  }
  if (loginBtn) loginBtn.addEventListener('click', function () { showMsg('演示站点未开放登录'); });
  if (regBtn) regBtn.addEventListener('click', function () { showMsg('演示站点未开放注册'); });

  /* ---------- 2) 阅读记录浮层 ---------- */
  var histPanel = document.getElementById('dd-hist-panel');
  function openHist() {
    if (!histPanel) return;
    var list = document.getElementById('dd-hist-list');
    var empty = document.getElementById('dd-hist-empty');
    var h = lsGet('reader.history', {});
    var rows = [];
    for (var k in h) if (Object.prototype.hasOwnProperty.call(h, k)) rows.push(h[k]);
    rows.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    if (list) {
      list.innerHTML = '';
      rows.slice(0, 30).forEach(function (r) {
        var li = document.createElement('li');
        li.className = 'dd-hist-item';
        var a = document.createElement('a');
        a.className = 'dd-hist-title dd-link';
        a.href = '/chapter/' + r.chapterId;
        a.textContent = (r.bookTitle ? r.bookTitle + ' · ' : '') + (r.title || '第' + r.chapterIdx + '章');
        var meta = document.createElement('span');
        meta.className = 'dd-hist-meta';
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
  Array.prototype.forEach.call(document.querySelectorAll('.dd-hist-btn'), function (b) {
    b.addEventListener('click', openHist);
  });
  if (histPanel) {
    Array.prototype.forEach.call(histPanel.querySelectorAll('[data-dd-hist-close]'), function (b) {
      b.addEventListener('click', closeHist);
    });
  }

  /* ---------- 3) 目录页：最新章节组反转 ---------- */
  var latest = document.getElementById('dd-toc-latest');
  if (latest && latest.getAttribute('data-reverse')) {
    var items = Array.prototype.slice.call(latest.children);
    items.reverse().forEach(function (el) { latest.appendChild(el); });
  }

  /* ---------- 4) 章节页 ---------- */
  var reader = document.getElementById('dd-reader');
  var content = document.getElementById('fb-chapter-content');
  if (reader && content) {
    var SCENES = {
      day:   { page: '',        paper: '#f7f3e6', ink: '#444444' },
      paper: { page: '#e6d9bd', paper: '#f8f0da', ink: '#4a3a24' },
      green: { page: '#dcead8', paper: '#f0f6ec', ink: '#2f4030' },
      blue:  { page: '#d8e4ee', paper: '#eef4fa', ink: '#2d3c46' },
      night: { page: '#1e2024', paper: '#26262b', ink: '#c0c0c6' }
    };
    var FONTS = {
      '': '', default: '',
      song: '"Songti SC","SimSun",serif',
      hei: '"Heiti SC","SimHei","Microsoft YaHei",sans-serif',
      kai: 'KaiTi,STKaiti,"楷体",serif'
    };
    var prefs = lsGet('dd.reader', { scene: 'day', size: 20, lh: 1.8, font: 'default', ink: '' });
    if (!SCENES[prefs.scene]) prefs.scene = 'day';

    var SET_IDLE = 'dd-set-btn h-[20px] min-w-[24px] cursor-pointer border border-[#c8d4e1] px-1.5 text-[11px] leading-[18px] text-[#667788] transition-colors hover:border-[#459df5] hover:text-[#1a6fb0]';
    var SET_ON = 'dd-set-btn h-[20px] min-w-[24px] cursor-pointer border border-[#459df5] bg-[#e3f1fb] px-1.5 text-[11px] leading-[18px] text-[#1a6fb0]';

    function apply() {
      var sc = SCENES[prefs.scene];
      reader.style.background = sc.page || '';
      var paper = document.getElementById('dd-paper');
      if (paper) paper.style.background = sc.paper;
      content.style.fontSize = prefs.size + 'px';
      content.style.lineHeight = String(prefs.lh);
      content.style.fontFamily = FONTS[prefs.font] || '';
      content.style.color = prefs.ink || sc.ink;
      // 清掉公共 app.js 的夜间模式内联样式，避免与本主题场景换肤冲突
      content.style.background = '';
      document.documentElement.style.background = '';
      var sizeEl = document.getElementById('dd-font-size');
      if (sizeEl) sizeEl.textContent = prefs.size + 'px';
      Array.prototype.forEach.call(reader.querySelectorAll('.dd-lh'), function (b) {
        var on = +b.getAttribute('data-lh') === +prefs.lh;
        b.className = on ? SET_ON : SET_IDLE;
      });
      Array.prototype.forEach.call(reader.querySelectorAll('.dd-scene'), function (b) {
        var on = b.getAttribute('data-scene') === prefs.scene;
        b.className = 'dd-scene h-4 w-4 cursor-pointer rounded-full border transition-all ' +
          (on ? 'scale-110 border-[#459df5]' : 'border-black/25');
      });
      var fontSel = document.getElementById('dd-font');
      var inkSel = document.getElementById('dd-ink');
      if (fontSel) fontSel.value = prefs.font || 'default';
      if (inkSel) inkSel.value = prefs.ink || '';
    }

    function stepSize(dir) {
      var steps = [14, 16, 18, 20, 22, 24, 26, 28];
      var i = 0, best = 1e9;
      for (var k = 0; k < steps.length; k++) {
        var d = Math.abs(steps[k] - prefs.size);
        if (d < best) { best = d; i = k; }
      }
      i = Math.min(steps.length - 1, Math.max(0, i + dir));
      prefs.size = steps[i];
      lsSet('dd.reader', prefs);
      apply();
    }
    var dec = document.getElementById('dd-font-dec');
    var inc = document.getElementById('dd-font-inc');
    if (dec) dec.addEventListener('click', function () { stepSize(-1); });
    if (inc) inc.addEventListener('click', function () { stepSize(1); });

    reader.addEventListener('click', function (e) {
      var lh = e.target.closest ? e.target.closest('.dd-lh') : null;
      if (lh) { prefs.lh = +lh.getAttribute('data-lh'); lsSet('dd.reader', prefs); apply(); return; }
      var sc = e.target.closest ? e.target.closest('.dd-scene') : null;
      if (sc) { prefs.scene = sc.getAttribute('data-scene'); lsSet('dd.reader', prefs); apply(); }
    });
    var fontSel = document.getElementById('dd-font');
    if (fontSel) fontSel.addEventListener('change', function () { prefs.font = fontSel.value; lsSet('dd.reader', prefs); apply(); });
    var inkSel = document.getElementById('dd-ink');
    if (inkSel) inkSel.addEventListener('change', function () { prefs.ink = inkSel.value; lsSet('dd.reader', prefs); apply(); });
    var reset = document.getElementById('dd-reset');
    if (reset) reset.addEventListener('click', function () {
      prefs = { scene: 'day', size: 20, lh: 1.8, font: 'default', ink: '' };
      lsSet('dd.reader', prefs);
      apply();
    });

    /* 书签（按书分组存储，与 React 版 getMarks/toggleMark 同 key 规则） */
    Array.prototype.forEach.call(document.querySelectorAll('.dd-mark-btn'), function (btn) {
      var nv = btn.getAttribute('data-novel-id');
      var ch = btn.getAttribute('data-chapter-id');
      var render = function (on) {
        btn.className = on ? 'dd-mark-btn dd-hottext cursor-pointer' : 'dd-mark-btn dd-greenlink';
        btn.textContent = on ? '已在书签' : '加入书签';
      };
      var marks = lsGet('dd-marks-' + nv, []);
      render(marks.indexOf(String(ch)) !== -1 || marks.indexOf(Number(ch)) !== -1);
      btn.addEventListener('click', function () {
        var arr = lsGet('dd-marks-' + nv, []);
        var both = [String(ch), Number(ch)];
        var has = arr.indexOf(String(ch)) !== -1 || arr.indexOf(Number(ch)) !== -1;
        arr = arr.filter(function (x) { return both.indexOf(x) === -1; });
        if (!has) arr.push(String(ch));
        lsSet('dd-marks-' + nv, arr.slice(-199));
        render(!has);
      });
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
