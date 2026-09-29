/**
 * huangjinwu.js —— 黄金屋主题私有交互（vanilla JS，零依赖）。
 * 移植自 src/themes/huangjinwu React 状态交互：
 *  1) 移动端抽屉 / 阅读记录浮层 / 收藏提示
 *  2) 书籍页：简介展开/收起 + 最新章节组反转（新→旧）
 *  3) 阅读页：字号/行距滑杆 + 五场景换肤 + 字体/字色（localStorage reader-prefs-v1，
 *     与 React 版 use-reader-prefs 同 key 同形状）+ 键盘 ← → 翻章
 */
(function () {
  'use strict';

  function lsGet(k, d) {
    try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ }
  }

  /* ---------- 1) 抽屉 / 足迹 / 收藏 ---------- */
  var drawer = document.getElementById('hj-drawer');
  var drawerBtn = document.getElementById('hj-drawer-btn');
  function openDrawer() { if (drawer) { drawer.removeAttribute('hidden'); if (drawerBtn) drawerBtn.setAttribute('aria-expanded', 'true'); } }
  function closeDrawer() { if (drawer) { drawer.setAttribute('hidden', ''); if (drawerBtn) drawerBtn.setAttribute('aria-expanded', 'false'); } }
  if (drawerBtn) drawerBtn.addEventListener('click', openDrawer);
  if (drawer) Array.prototype.forEach.call(drawer.querySelectorAll('[data-hj-drawer-close]'), function (b) { b.addEventListener('click', closeDrawer); });

  var histPanel = document.getElementById('hj-hist-panel');
  function openHist() {
    if (!histPanel) return;
    var list = document.getElementById('hj-hist-list');
    var empty = document.getElementById('hj-hist-empty');
    var h = lsGet('reader.history', {});
    var rows = [];
    for (var k in h) if (Object.prototype.hasOwnProperty.call(h, k)) rows.push(h[k]);
    rows.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    if (list) {
      list.innerHTML = '';
      rows.slice(0, 30).forEach(function (r) {
        var li = document.createElement('li');
        li.className = 'flex h-10 items-center justify-between gap-2 border-b border-[#eef2f9]';
        var a = document.createElement('a');
        a.className = 'min-w-0 flex-1 truncate text-[#2563eb] hover:text-[#1d4ed8]';
        a.href = '/chapter/' + r.chapterId;
        a.textContent = (r.bookTitle ? r.bookTitle + ' · ' : '') + (r.title || '第' + r.chapterIdx + '章');
        var meta = document.createElement('span');
        meta.className = 'shrink-0 text-xs text-[#94a3b8]';
        meta.textContent = r.chapterIdx ? ('第 ' + r.chapterIdx + ' 章') : '';
        li.appendChild(a); li.appendChild(meta);
        list.appendChild(li);
      });
    }
    if (empty) empty.style.display = rows.length ? 'none' : '';
    histPanel.removeAttribute('hidden');
  }
  function closeHist() { if (histPanel) histPanel.setAttribute('hidden', ''); }
  Array.prototype.forEach.call(document.querySelectorAll('.hj-hist-btn'), function (b) { b.addEventListener('click', openHist); });
  if (histPanel) Array.prototype.forEach.call(histPanel.querySelectorAll('[data-hj-hist-close]'), function (b) { b.addEventListener('click', closeHist); });

  Array.prototype.forEach.call(document.querySelectorAll('.hj-fav'), function (b) {
    b.addEventListener('click', function () { window.alert('请按 Ctrl+D（Mac 为 ⌘+D）将本站加入收藏夹。'); });
  });

  /* ---------- 2) 书籍页 ---------- */
  var desc = document.getElementById('hj-desc');
  var descBtn = document.getElementById('hj-desc-btn');
  if (desc && descBtn) {
    var expanded = false;
    descBtn.addEventListener('click', function () {
      expanded = !expanded;
      if (expanded) desc.classList.remove('line-clamp-4');
      else desc.classList.add('line-clamp-4');
      descBtn.textContent = expanded ? '收起' : '展开';
    });
  }

  var latest = document.getElementById('hj-latest-pills');
  if (latest && latest.getAttribute('data-reverse')) {
    var items = Array.prototype.slice.call(latest.children);
    items.reverse().forEach(function (el) { latest.appendChild(el); });
  }

  /* ---------- 3) 阅读页 ---------- */
  var head = document.getElementById('hj-reader-head');
  var paper = document.getElementById('hj-paper');
  var content = document.getElementById('fb-chapter-content');
  if (head && paper && content) {
    /* 场景配色：与 views.tsx SCENES 一致（day 页面底色由 body 渐变提供） */
    var SCENES = {
      day:   { page: '',        paper: '#f8fafc', ink: '#1e293b', muted: '#94a3b8', line: '#d8e3f0' },
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
    var LS_KEY = 'reader-prefs-v1';
    var prefs = lsGet(LS_KEY, { fontSize: 18, lineHeight: 1.8, font: 'default', scene: 'day', ink: '' });
    if (!SCENES[prefs.scene]) prefs.scene = 'day';
    if (!FONTS.hasOwnProperty(prefs.font)) prefs.font = 'default';
    prefs.fontSize = Math.min(28, Math.max(14, +prefs.fontSize || 18));
    prefs.lineHeight = Math.min(2.6, Math.max(1.4, +prefs.lineHeight || 1.8));

    function save() { lsSet(LS_KEY, prefs); }

    function apply() {
      var sc = SCENES[prefs.scene];
      head.style.background = sc.paper;
      head.style.borderColor = sc.line;
      paper.style.background = sc.paper;
      paper.style.borderColor = sc.line;
      var book = document.getElementById('hj-reader-book');
      if (book) book.style.color = sc.ink;
      var h1 = document.getElementById('hj-ch-title');
      if (h1) h1.style.color = sc.ink;
      content.style.fontSize = prefs.fontSize + 'px';
      content.style.lineHeight = String(prefs.lineHeight);
      content.style.fontFamily = FONTS[prefs.font] || '';
      content.style.color = prefs.ink || sc.ink;
      /* 段落字色跟随（readerInk 语义） */
      Array.prototype.forEach.call(content.querySelectorAll('p'), function (p) {
        p.style.color = prefs.ink || sc.ink;
      });
      /* 清掉公共 app.js 的夜间模式内联样式，避免与本主题场景换肤冲突 */
      content.style.background = '';
      document.documentElement.style.background = '';
      var fr = document.getElementById('hj-font-range');
      var fv = document.getElementById('hj-font-val');
      if (fr) fr.value = String(prefs.fontSize);
      if (fv) fv.textContent = prefs.fontSize + 'px';
      var lr = document.getElementById('hj-lh-range');
      var lv = document.getElementById('hj-lh-val');
      if (lr) lr.value = String(prefs.lineHeight);
      if (lv) lv.textContent = Number(prefs.lineHeight).toFixed(1);
      Array.prototype.forEach.call(head.querySelectorAll('.hj-scene'), function (b) {
        var on = b.getAttribute('data-scene') === prefs.scene;
        b.className = 'hj-scene h-5 w-5 cursor-pointer rounded-full border transition-all ' +
          (on ? 'scale-110 border-[#2563eb]' : 'border-black/25');
      });
      var fontSel = document.getElementById('hj-font');
      var inkSel = document.getElementById('hj-ink');
      if (fontSel) fontSel.value = prefs.font || 'default';
      if (inkSel) inkSel.value = prefs.ink || '';
    }

    var fr = document.getElementById('hj-font-range');
    if (fr) fr.addEventListener('input', function () { prefs.fontSize = Number(fr.value); save(); apply(); });
    var lr = document.getElementById('hj-lh-range');
    if (lr) lr.addEventListener('input', function () { prefs.lineHeight = Number(lr.value); save(); apply(); });

    head.addEventListener('click', function (e) {
      var sc = e.target.closest ? e.target.closest('.hj-scene') : null;
      if (sc) { prefs.scene = sc.getAttribute('data-scene'); save(); apply(); }
    });
    var fontSel = document.getElementById('hj-font');
    if (fontSel) fontSel.addEventListener('change', function () { prefs.font = fontSel.value; save(); apply(); });
    var inkSel = document.getElementById('hj-ink');
    if (inkSel) inkSel.addEventListener('change', function () { prefs.ink = inkSel.value; save(); apply(); });

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
