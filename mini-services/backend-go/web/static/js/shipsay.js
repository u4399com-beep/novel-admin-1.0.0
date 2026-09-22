/**
 * shipsay.js —— ShipSay 演示主题私有交互（vanilla JS，零依赖）。
 * 移植自 src/themes/shipsay React 状态交互：
 *  1) 右缘回顶部/回底部箭头（ScrollButtons）
 *  2) 阅读记录浮层（localStorage reader.history，写入方为公共 app.js）
 *  3) 收藏本站（promptFavorite）
 *  4) 分类页：移动端筛选展开（mobileFilter state）+「只看全本」data-status 过滤
 *  5) 书籍页：Tab 切换（info/catalog）+ 最新章节组反转（新→旧）
 *  6) 目录页：最新章节组反转
 *  7) 章节页：阅读偏好（字号/行距/字体/字色/五场景，localStorage ss.reader）+ 夜间 + 极简模式 + 键盘翻章
 */
(function () {
  'use strict';

  function lsGet(k, d) {
    try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ }
  }

  /* ---------- 1) 回顶部/回底部 ---------- */
  var toTop = document.getElementById('ss-totop');
  if (toTop) toTop.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });
  var toBottom = document.getElementById('ss-tobottom');
  if (toBottom) toBottom.addEventListener('click', function () { window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }); });

  /* ---------- 3) 收藏本站 ---------- */
  Array.prototype.forEach.call(document.querySelectorAll('.ss-fav'), function (b) {
    b.addEventListener('click', function () {
      var ok = false;
      try { ok = window.external && window.external.AddFavorite && window.external.AddFavorite(location.href, document.title); } catch (e) { ok = false; }
      if (!ok) window.alert('请按 Ctrl+D（Mac 为 ⌘+D）将本站加入收藏夹。');
    });
  });

  /* ---------- 2) 阅读记录浮层 ---------- */
  var histPanel = document.getElementById('ss-hist-panel');
  function openHist() {
    if (!histPanel) return;
    var list = document.getElementById('ss-hist-list');
    var empty = document.getElementById('ss-hist-empty');
    var h = lsGet('reader.history', {});
    var rows = [];
    for (var k in h) if (Object.prototype.hasOwnProperty.call(h, k)) rows.push(h[k]);
    rows.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    if (list) {
      list.innerHTML = '';
      rows.slice(0, 30).forEach(function (r) {
        var li = document.createElement('li');
        li.className = 'flex h-[41px] items-center justify-between gap-2 border-b border-dotted border-[#E6E6E6]';
        var a = document.createElement('a');
        a.className = 'min-w-0 truncate text-[13px] text-[#1A1A1A]';
        a.href = '/chapter/' + r.chapterId;
        a.textContent = (r.bookTitle ? r.bookTitle + ' · ' : '') + (r.title || '第' + r.chapterIdx + '章');
        var meta = document.createElement('span');
        meta.className = 'shrink-0 text-[12px] text-[#969BA3]';
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
  Array.prototype.forEach.call(document.querySelectorAll('.ss-hist-btn'), function (b) {
    b.addEventListener('click', openHist);
  });
  if (histPanel) {
    Array.prototype.forEach.call(histPanel.querySelectorAll('[data-ss-hist-close]'), function (b) {
      b.addEventListener('click', closeHist);
    });
  }

  /* ---------- 4) 分类页 ---------- */
  var mBtn = document.getElementById('ss-mfilter-btn');
  var mPanel = document.getElementById('ss-mfilter');
  if (mBtn && mPanel) {
    var label = mBtn.querySelector('span');
    mBtn.addEventListener('click', function () {
      var show = mPanel.hasAttribute('hidden');
      if (show) mPanel.removeAttribute('hidden'); else mPanel.setAttribute('hidden', '');
      mBtn.setAttribute('aria-expanded', show ? 'true' : 'false');
      if (label) label.textContent = show ? '收起筛选' : '筛选分类 / 只看全本';
    });
  }
  var catList = document.getElementById('ss-cat-list');
  function bindFinished(boxId) {
    var box = document.getElementById(boxId);
    if (!box || !catList) return;
    box.addEventListener('change', function () {
      var only = box.checked;
      Array.prototype.forEach.call(catList.querySelectorAll('.ss-cat-card'), function (card) {
        var ok = !only || card.getAttribute('data-status') === 'finished';
        card.style.display = ok ? '' : 'none';
      });
      var other = document.getElementById(boxId === 'ss-only-finished' ? 'ss-only-finished-m' : 'ss-only-finished');
      if (other) other.checked = only;
    });
  }
  bindFinished('ss-only-finished');
  bindFinished('ss-only-finished-m');

  /* ---------- 5) 书籍页：Tab + 最新反转 ---------- */
  var tabs = document.getElementById('ss-book-tabs');
  if (tabs) {
    var TAB_ON = 'ss-tab h-[40px] cursor-pointer border-b-2 border-[#BF2C24] px-4 text-[18px] font-medium text-[#BF2C24] transition-colors';
    var TAB_OFF = 'ss-tab h-[40px] cursor-pointer border-b-2 border-transparent px-4 text-[18px] text-[#666] transition-colors hover:text-[#ED4259]';
    tabs.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.ss-tab') : null;
      if (!btn) return;
      Array.prototype.forEach.call(tabs.querySelectorAll('.ss-tab'), function (b) {
        b.className = b === btn ? TAB_ON : TAB_OFF;
      });
      var key = btn.getAttribute('data-tab');
      var info = document.getElementById('ss-tab-info');
      var catalog = document.getElementById('ss-tab-catalog');
      if (info && catalog) {
        if (key === 'catalog') { info.setAttribute('hidden', ''); catalog.removeAttribute('hidden'); }
        else { catalog.setAttribute('hidden', ''); info.removeAttribute('hidden'); }
      }
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll('[data-reverse="1"]'), function (box) {
    var items = Array.prototype.slice.call(box.children);
    items.reverse().forEach(function (el) { box.appendChild(el); });
  });

  /* ---------- 7) 章节页 ---------- */
  var reader = document.getElementById('ss-reader');
  var content = document.getElementById('fb-chapter-content');
  if (reader && content) {
    var SCENES = {
      day:   { page: '#E7E1D4', paper: '#FBF6EC', ink: '#262626', head: '#555' },
      paper: { page: '#e6d9bd', paper: '#f8f0da', ink: '#4a3a24', head: '#4a3a24' },
      green: { page: '#dcead8', paper: '#f0f6ec', ink: '#2f4030', head: '#2f4030' },
      blue:  { page: '#d8e4ee', paper: '#eef4fa', ink: '#2d3c46', head: '#2d3c46' },
      night: { page: '#1B1B1F', paper: '#26262B', ink: '#B9B9BF', head: '#DCDCE0' }
    };
    var FONTS = { '': '', default: '', song: '"Songti SC","SimSun",serif', hei: '"Heiti SC","SimHei","Microsoft YaHei",sans-serif', kai: 'KaiTi,STKaiti,"楷体",serif' };
    var prefs = lsGet('ss.reader', { scene: 'day', size: 18, lh: 1.8, font: 'default', ink: '', minimal: false });
    if (!SCENES[prefs.scene]) prefs.scene = 'day';

    var wrap = document.getElementById('ss-reader-wrap');
    var paper = document.getElementById('ss-paper');
    var head = document.getElementById('ss-ch-head');
    var meta = document.getElementById('ss-ch-meta');

    function apply() {
      var sc = SCENES[prefs.scene];
      reader.style.background = sc.page;
      if (paper) paper.style.background = sc.paper;
      content.style.fontSize = prefs.size + 'px';
      content.style.lineHeight = String(prefs.lh);
      content.style.fontFamily = FONTS[prefs.font] || '';
      content.style.color = prefs.ink || sc.ink;
      if (head) head.style.color = prefs.scene === 'night' ? sc.head : '#555';
      if (meta) meta.style.display = prefs.minimal ? 'none' : '';
      if (wrap) {
        wrap.className = 'mx-auto w-full px-2 pt-4 ' + (prefs.minimal ? 'max-w-[760px]' : 'max-w-[900px]');
      }
      // 清掉公共 app.js 的夜间模式内联样式，避免与本主题场景换肤冲突
      content.style.background = '';
      document.documentElement.style.background = '';
      Array.prototype.forEach.call(reader.querySelectorAll('.ss-scene'), function (b) {
        var on = b.getAttribute('data-scene') === prefs.scene;
        b.className = 'ss-scene h-[26px] w-[18px] cursor-pointer rounded-sm border transition-all ' +
          (on ? 'border-[#ED4259]' : 'border-[#D8D2C2] hover:border-[#ED4259]');
      });
      var lh = document.getElementById('ss-lh');
      var font = document.getElementById('ss-font');
      var ink = document.getElementById('ss-ink');
      if (lh) lh.value = String(prefs.lh);
      if (font) font.value = prefs.font || 'default';
      if (ink) ink.value = prefs.ink || '';
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
      lsSet('ss.reader', prefs);
      apply();
    }
    var dec = document.getElementById('ss-font-dec');
    var inc = document.getElementById('ss-font-inc');
    if (dec) dec.addEventListener('click', function () { stepSize(-1); });
    if (inc) inc.addEventListener('click', function () { stepSize(1); });

    var lhSel = document.getElementById('ss-lh');
    if (lhSel) lhSel.addEventListener('change', function () { prefs.lh = +lhSel.value; lsSet('ss.reader', prefs); apply(); });
    var fontSel = document.getElementById('ss-font');
    if (fontSel) fontSel.addEventListener('change', function () { prefs.font = fontSel.value; lsSet('ss.reader', prefs); apply(); });
    var inkSel = document.getElementById('ss-ink');
    if (inkSel) inkSel.addEventListener('change', function () { prefs.ink = inkSel.value; lsSet('ss.reader', prefs); apply(); });

    reader.addEventListener('click', function (e) {
      var sc = e.target.closest ? e.target.closest('.ss-scene') : null;
      if (sc) { prefs.scene = sc.getAttribute('data-scene'); lsSet('ss.reader', prefs); apply(); }
    });
    var night = document.getElementById('ss-night');
    if (night) night.addEventListener('click', function () {
      prefs.scene = prefs.scene === 'night' ? 'day' : 'night';
      lsSet('ss.reader', prefs);
      apply();
    });
    var minimal = document.getElementById('ss-minimal');
    if (minimal) minimal.addEventListener('click', function () {
      prefs.minimal = !prefs.minimal;
      lsSet('ss.reader', prefs);
      apply();
    });

    document.addEventListener('keydown', function (e) {
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.tagName === 'BUTTON' || t.isContentEditable)) return;
      var prev = content.getAttribute('data-prev-id');
      var next = content.getAttribute('data-next-id');
      var toc = content.getAttribute('data-novel-id');
      if (e.key === 'ArrowLeft' && prev) location.href = '/chapter/' + prev;
      else if (e.key === 'ArrowRight' && next) location.href = '/chapter/' + next;
      else if (e.key === 'Enter' && toc) location.href = '/book/' + toc + '/toc';
    });

    apply();
  }
})();
