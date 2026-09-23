/**
 * 101kks.js —— 101看書主题私有交互（vanilla JS，零依赖）。
 * 移植自 src/themes/101kks React 状态交互：
 *  1) 移动端抽屉 / 阅读足迹浮层 / 收藏提示
 *  2) 书籍页：书架（101kks.shelf）/ 投推荐票计数 / 三选项卡 / 侧栏 热门-完本 切换 / 五星评分
 *  3) 目录页：正序倒序切换 / 最新章节组反转 / 我的书签（101kks.bookmarks）
 *  4) 阅读页：底部设置面板（背景/字体/行距/字色/字号，localStorage reader-prefs-v1，
 *     与 React 版 use-reader-prefs 同 key 同形状；white=day 键映射）+ 夜间 + 书签保存闪示
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
  var drawer = document.getElementById('kks-drawer');
  var drawerBtn = document.getElementById('kks-drawer-btn');
  function openDrawer() { if (drawer) { drawer.removeAttribute('hidden'); if (drawerBtn) drawerBtn.setAttribute('aria-expanded', 'true'); } }
  function closeDrawer() { if (drawer) { drawer.setAttribute('hidden', ''); if (drawerBtn) drawerBtn.setAttribute('aria-expanded', 'false'); } }
  if (drawerBtn) drawerBtn.addEventListener('click', openDrawer);
  if (drawer) Array.prototype.forEach.call(drawer.querySelectorAll('[data-kks-drawer-close]'), function (b) { b.addEventListener('click', closeDrawer); });

  var histPanel = document.getElementById('kks-hist-panel');
  function openHist() {
    if (!histPanel) return;
    var list = document.getElementById('kks-hist-list');
    var empty = document.getElementById('kks-hist-empty');
    var h = lsGet('reader.history', {});
    var rows = [];
    for (var k in h) if (Object.prototype.hasOwnProperty.call(h, k)) rows.push(h[k]);
    rows.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    if (list) {
      list.innerHTML = '';
      rows.slice(0, 30).forEach(function (r) {
        var li = document.createElement('li');
        li.className = 'flex h-10 items-center justify-between gap-2 border-b border-black/5';
        var a = document.createElement('a');
        a.className = 'min-w-0 flex-1 truncate text-[#1f6cb2] hover:text-[#06c]';
        a.href = '/chapter/' + r.chapterId;
        a.textContent = (r.bookTitle ? r.bookTitle + ' · ' : '') + (r.title || '第' + r.chapterIdx + '章');
        var meta = document.createElement('span');
        meta.className = 'shrink-0 text-xs text-[#888]';
        meta.textContent = r.chapterIdx ? ('第 ' + r.chapterIdx + ' 章') : '';
        li.appendChild(a); li.appendChild(meta);
        list.appendChild(li);
      });
    }
    if (empty) empty.style.display = rows.length ? 'none' : '';
    histPanel.removeAttribute('hidden');
  }
  function closeHist() { if (histPanel) histPanel.setAttribute('hidden', ''); }
  Array.prototype.forEach.call(document.querySelectorAll('.kks-hist-btn'), function (b) { b.addEventListener('click', openHist); });
  if (histPanel) Array.prototype.forEach.call(histPanel.querySelectorAll('[data-kks-hist-close]'), function (b) { b.addEventListener('click', closeHist); });

  Array.prototype.forEach.call(document.querySelectorAll('.kks-fav'), function (b) {
    b.addEventListener('click', function () { window.alert('請按 Ctrl+D（Mac 為 ⌘+D）將本站加入收藏夾。'); });
  });

  /* ---------- 2) 书籍页 ---------- */
  var shelfBtn = document.getElementById('kks-shelf-btn');
  if (shelfBtn) {
    var nid = shelfBtn.getAttribute('data-novel-id');
    var label = document.getElementById('kks-shelf-label');
    var renderShelf = function (on) {
      if (label) label.textContent = on ? '已在書架' : '加入書架';
      var svg = shelfBtn.querySelector('svg');
      if (svg) svg.setAttribute('fill', on ? 'currentColor' : 'none');
    };
    var shelf = lsGet('101kks.shelf', []);
    var has = shelf.indexOf(String(nid)) !== -1 || shelf.indexOf(Number(nid)) !== -1;
    renderShelf(has);
    shelfBtn.addEventListener('click', function () {
      var arr = lsGet('101kks.shelf', []);
      var hasNow = arr.indexOf(String(nid)) !== -1 || arr.indexOf(Number(nid)) !== -1;
      arr = arr.filter(function (x) { return x !== String(nid) && x !== Number(nid); });
      if (!hasNow) arr.push(Number(nid));
      lsSet('101kks.shelf', arr);
      renderShelf(!hasNow);
    });
  }

  var voteBtn = document.getElementById('kks-vote-btn');
  if (voteBtn) {
    var votes = 0;
    var voteLabel = document.getElementById('kks-vote-label');
    voteBtn.addEventListener('click', function () {
      votes += 1;
      if (voteLabel) voteLabel.textContent = '已投 ' + votes + ' 票';
    });
  }

  /* 三选项卡 */
  var tabs = document.getElementById('kks-tabs');
  if (tabs) {
    var TAB_IDLE = '-mb-px flex cursor-pointer items-center gap-1.5 border-b-2 border-transparent pb-2 text-sm text-[#888] transition-colors hover:text-[#333]';
    var TAB_ON = '-mb-px flex cursor-pointer items-center gap-1.5 border-b-2 border-[#1f6cb2] pb-2 text-sm font-bold text-[#1f6cb2] transition-colors';
    var panels = { toc: null, intro: null, review: null };
    Array.prototype.forEach.call(document.querySelectorAll('[data-panel]'), function (p) { panels[p.getAttribute('data-panel')] = p; });
    Array.prototype.forEach.call(tabs.querySelectorAll('[data-tab]'), function (t) {
      t.addEventListener('click', function () {
        var key = t.getAttribute('data-tab');
        Array.prototype.forEach.call(tabs.querySelectorAll('[data-tab]'), function (x) {
          var on = x === t;
          x.className = on ? TAB_ON : TAB_IDLE;
          x.setAttribute('data-active', on ? 'true' : 'false');
        });
        for (var k in panels) {
          if (panels[k]) {
            if (k === key) panels[k].removeAttribute('hidden');
            else panels[k].setAttribute('hidden', '');
          }
        }
      });
    });
  }

  /* 侧栏 热门/完本 切换 */
  var sideTabs = document.getElementById('kks-side-tabs');
  if (sideTabs) {
    var SIDE_IDLE = '-mb-px cursor-pointer border-b-2 border-transparent pb-1.5 text-sm text-[#888] transition-colors hover:text-[#333]';
    var SIDE_ON = '-mb-px cursor-pointer border-b-2 border-[#1f6cb2] pb-1.5 text-sm font-bold text-[#1f6cb2] transition-colors';
    Array.prototype.forEach.call(sideTabs.querySelectorAll('[data-sidetab]'), function (t) {
      t.addEventListener('click', function () {
        var key = t.getAttribute('data-sidetab');
        Array.prototype.forEach.call(sideTabs.querySelectorAll('[data-sidetab]'), function (x) {
          var on = x === t;
          x.className = on ? SIDE_ON : SIDE_IDLE;
          x.setAttribute('data-active', on ? 'true' : 'false');
        });
        Array.prototype.forEach.call(document.querySelectorAll('[data-sidepanel]'), function (p) {
          if (p.getAttribute('data-sidepanel') === key) p.removeAttribute('hidden');
          else p.setAttribute('hidden', '');
        });
      });
    });
  }

  /* 五星评分（演示） */
  var rating = document.getElementById('kks-rating');
  if (rating) {
    var starIdle = 'h-5 w-5 text-[#ccc]';
    var starOn = 'h-5 w-5 text-[#f5a623]';
    var setStars = function (n) {
      Array.prototype.forEach.call(rating.querySelectorAll('[data-star]'), function (s) {
        var svg = s.querySelector('svg');
        if (!svg) return;
        var on = Number(s.getAttribute('data-star')) <= n;
        svg.setAttribute('class', on ? 'h-5 w-5 text-[#f5a623]' : 'h-5 w-5 text-[#ccc]');
        svg.setAttribute('fill', on ? '#f5a623' : 'none');
      });
      var lbl = document.getElementById('kks-rating-label');
      if (lbl) lbl.textContent = n > 0 ? n + '.0 分' : '點擊評分';
    };
    Array.prototype.forEach.call(rating.querySelectorAll('[data-star]'), function (s) {
      s.addEventListener('click', function () { setStars(Number(s.getAttribute('data-star'))); });
    });
    setStars(0);
  }

  /* ---------- 3) 目录页 ---------- */
  var latest = document.getElementById('kks-toc-latest');
  if (latest && latest.getAttribute('data-reverse')) {
    var items = Array.prototype.slice.call(latest.children);
    items.reverse().forEach(function (el) { latest.appendChild(el); });
  }

  var orderBtn = document.getElementById('kks-order-btn');
  var tocList = document.getElementById('kks-toc-list');
  if (orderBtn && tocList) {
    var asc = true;
    var orderLabel = document.getElementById('kks-order-label');
    orderBtn.addEventListener('click', function () {
      asc = !asc;
      orderBtn.setAttribute('data-asc', asc ? 'true' : 'false');
      if (orderLabel) orderLabel.textContent = asc ? '正序' : '倒序';
      var kids = Array.prototype.slice.call(tocList.children);
      kids.reverse().forEach(function (el) { tocList.appendChild(el); });
    });
  }

  /* 我的书签 */
  var bmBox = document.getElementById('kks-bookmark');
  if (bmBox) {
    var bmNovel = bmBox.getAttribute('data-novel-id');
    var bm = lsGet('101kks.bookmarks', {});
    var rec = bm[bmNovel] || bm[String(bmNovel)];
    if (rec && rec.chapterId) {
      var link = document.getElementById('kks-bookmark-link');
      var titleEl = document.getElementById('kks-bookmark-title');
      if (titleEl) titleEl.textContent = rec.title || ('第' + rec.chapterId + '章');
      if (link) link.setAttribute('href', '/chapter/' + rec.chapterId);
      bmBox.removeAttribute('hidden');
    }
  }

  /* ---------- 4) 阅读页 ---------- */
  var reader = document.getElementById('kks-reader');
  var content = document.getElementById('fb-chapter-content');
  if (reader && content) {
    var BG = {
      day:   { page: '#f2f3f4', paper: '#ffffff', ink: '#333333', muted: '#888888', line: 'rgba(0,0,0,.12)', pagerBg: '#fafafa', pagerBorder: 'rgba(0,0,0,.1)' },
      paper: { page: '#efe9d9', paper: '#f7f3e8', ink: '#4a3a24', muted: '#a89a80', line: 'rgba(0,0,0,.12)', pagerBg: '#faf6ec', pagerBorder: 'rgba(0,0,0,.1)' },
      green: { page: '#dde8d8', paper: '#e8f0e4', ink: '#2f4030', muted: '#8fa590', line: 'rgba(0,0,0,.12)', pagerBg: '#f0f7ec', pagerBorder: 'rgba(0,0,0,.1)' },
      blue:  { page: '#dce7f3', paper: '#eaf1fa', ink: '#2d3c46', muted: '#8fa2b0', line: 'rgba(0,0,0,.12)', pagerBg: '#f2f7fc', pagerBorder: 'rgba(0,0,0,.1)' },
      night: { page: 'rgb(45,49,52)', paper: 'rgb(32,40,46)', ink: 'rgb(153,153,153)', muted: '#8a9199', line: 'rgba(255,255,255,.12)', pagerBg: '#2a3238', pagerBorder: 'rgba(255,255,255,.12)' }
    };
    var FONTS = {
      '': '', default: '',
      song: '"Songti SC","SimSun",serif',
      hei: '"Heiti SC","SimHei",sans-serif',
      kai: 'KaiTi,STKaiti,"楷体",serif'
    };
    var STEPS = [14, 16, 18, 20, 22, 24, 26, 28];
    var LS_KEY = 'reader-prefs-v1';
    var prefs = lsGet(LS_KEY, { fontSize: 18, lineHeight: 1.8, font: 'default', scene: 'day', ink: '' });
    if (!BG[prefs.scene]) prefs.scene = 'day';
    if (!FONTS.hasOwnProperty(prefs.font)) prefs.font = 'default';
    if (STEPS.indexOf(+prefs.fontSize) === -1) prefs.fontSize = 18;
    prefs.lineHeight = Math.min(2.6, Math.max(1.4, +prefs.lineHeight || 1.8));

    var BTN_IDLE = 'flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-[#4c5356] text-white transition-colors hover:bg-[#2f3538]';
    var BTN_ON = 'flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-[#1f6cb2] text-white transition-colors hover:bg-[#06c]';

    function save() { lsSet(LS_KEY, prefs); }

    function apply() {
      var bg = BG[prefs.scene];
      reader.style.background = bg.page;
      var paper = document.getElementById('kks-paper');
      if (paper) paper.style.background = bg.paper;
      var h1 = document.getElementById('kks-ch-title');
      if (h1) h1.style.color = bg.ink;
      var meta = document.getElementById('kks-ch-meta');
      if (meta) meta.style.color = bg.muted;
      var hint = document.getElementById('kks-ch-hint');
      if (hint) hint.style.color = bg.muted;
      var pager = document.getElementById('kks-pager');
      if (pager) {
        pager.style.borderColor = bg.line;
        pager.style.background = bg.pagerBg;
      }
      content.style.fontSize = prefs.fontSize + 'px';
      content.style.lineHeight = String(prefs.lineHeight);
      content.style.fontFamily = FONTS[prefs.font] || '';
      content.style.color = prefs.ink || bg.ink;
      /* 清掉公共 app.js 的夜间模式内联样式，避免与本主题换肤冲突 */
      content.style.background = '';
      document.documentElement.style.background = '';
      var sizeEl = document.getElementById('kks-font-size');
      if (sizeEl) sizeEl.textContent = prefs.fontSize + 'px';
      var bgLabel = document.getElementById('kks-bg-label');
      if (bgLabel) bgLabel.textContent = prefs.scene === 'night' ? '夜間' : '日間';
      Array.prototype.forEach.call(reader.querySelectorAll('.kks-bg'), function (b) {
        var on = b.getAttribute('data-bg') === prefs.scene;
        b.style.transform = on ? 'scale(1.1)' : '';
        b.style.borderColor = on ? '#e84118' : '';
        if (!on) b.classList.add('border-black/15'); else b.classList.remove('border-black/15');
      });
      Array.prototype.forEach.call(reader.querySelectorAll('.kks-font'), function (b) {
        var on = b.getAttribute('data-font') === (prefs.font || 'default');
        b.className = 'kks-font h-8 cursor-pointer rounded-[3px] px-3 text-sm transition-colors ' +
          (on ? 'bg-[#1f6cb2] text-white' : 'bg-[#f0f2f4] text-[#333] hover:bg-[#e2e6ea]');
      });
      Array.prototype.forEach.call(reader.querySelectorAll('.kks-lh'), function (b) {
        var on = +b.getAttribute('data-lh') === +prefs.lineHeight;
        b.className = 'kks-lh h-8 cursor-pointer rounded-[3px] px-3 text-sm transition-colors ' +
          (on ? 'bg-[#1f6cb2] text-white' : 'bg-[#f0f2f4] text-[#333] hover:bg-[#e2e6ea]');
      });
      Array.prototype.forEach.call(reader.querySelectorAll('.kks-ink'), function (b) {
        var on = (b.getAttribute('data-ink') || '') === (prefs.ink || '');
        b.className = 'kks-ink h-8 cursor-pointer rounded-[3px] px-3 text-sm transition-colors ' +
          (on ? 'bg-[#1f6cb2] text-white' : 'bg-[#f0f2f4] text-[#333] hover:bg-[#e2e6ea]');
      });
      var nightBtn = document.getElementById('kks-night-btn');
      if (nightBtn) nightBtn.className = prefs.scene === 'night' ? BTN_ON : BTN_IDLE;
      var nightBtnM = document.getElementById('kks-night-btn-m');
      if (nightBtnM) nightBtnM.textContent = prefs.scene === 'night' ? '日間' : '夜間';
    }

    function stepSize(dir) {
      var i = 0, best = 1e9;
      for (var k = 0; k < STEPS.length; k++) {
        var d = Math.abs(STEPS[k] - prefs.fontSize);
        if (d < best) { best = d; i = k; }
      }
      i = Math.min(STEPS.length - 1, Math.max(0, i + dir));
      prefs.fontSize = STEPS[i];
      save();
      apply();
    }
    var dec = document.getElementById('kks-font-dec');
    var inc = document.getElementById('kks-font-inc');
    if (dec) dec.addEventListener('click', function () { stepSize(-1); });
    if (inc) inc.addEventListener('click', function () { stepSize(1); });

    reader.addEventListener('click', function (e) {
      var t = e.target;
      var bg = t.closest ? t.closest('.kks-bg') : null;
      if (bg) { prefs.scene = bg.getAttribute('data-bg'); save(); apply(); return; }
      var ft = t.closest ? t.closest('.kks-font') : null;
      if (ft) { prefs.font = ft.getAttribute('data-font'); save(); apply(); return; }
      var lh = t.closest ? t.closest('.kks-lh') : null;
      if (lh) { prefs.lineHeight = +lh.getAttribute('data-lh'); save(); apply(); return; }
      var ik = t.closest ? t.closest('.kks-ink') : null;
      if (ik) { prefs.ink = ik.getAttribute('data-ink') || ''; save(); apply(); }
    });

    /* 设置面板显隐 */
    var panel = document.getElementById('kks-panel');
    function togglePanel() { if (panel) { if (panel.hasAttribute('hidden')) panel.removeAttribute('hidden'); else panel.setAttribute('hidden', ''); } }
    var panelBtn = document.getElementById('kks-panel-btn');
    var panelBtnM = document.getElementById('kks-panel-btn-m');
    var panelClose = document.getElementById('kks-panel-close');
    if (panelBtn) panelBtn.addEventListener('click', togglePanel);
    if (panelBtnM) panelBtnM.addEventListener('click', togglePanel);
    if (panelClose) panelClose.addEventListener('click', function () { panel.setAttribute('hidden', ''); });

    /* 夜间 */
    function toggleNight() { prefs.scene = prefs.scene === 'night' ? 'day' : 'night'; save(); apply(); }
    var nightBtn = document.getElementById('kks-night-btn');
    var nightBtnM = document.getElementById('kks-night-btn-m');
    if (nightBtn) nightBtn.addEventListener('click', toggleNight);
    if (nightBtnM) nightBtnM.addEventListener('click', toggleNight);

    /* 书签保存 + 闪示 */
    function doSave(flash) {
      var novelId = content.getAttribute('data-novel-id');
      var rec = { chapterId: Number(content.getAttribute('data-chapter-id')), title: content.getAttribute('data-chapter-title') || '' };
      var all = lsGet('101kks.bookmarks', {});
      all[novelId] = rec;
      lsSet('101kks.bookmarks', all);
      if (flash) {
        var hint = document.getElementById('kks-ch-hint');
        if (hint) {
          hint.textContent = '✓ 書籤已保存';
          window.setTimeout(function () { hint.textContent = '打開章節時自動記錄閱讀進度'; }, 1500);
        }
        var save2 = document.getElementById('kks-save-btn2');
        if (save2) {
          save2.textContent = '✓ 已收藏';
          window.setTimeout(function () { save2.textContent = '書籤'; }, 1500);
        }
      }
    }
    var saveBtn = document.getElementById('kks-save-btn');
    var saveBtn2 = document.getElementById('kks-save-btn2');
    if (saveBtn) saveBtn.addEventListener('click', function () { doSave(true); });
    if (saveBtn2) saveBtn2.addEventListener('click', function () { doSave(true); });
    doSave(false);

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
