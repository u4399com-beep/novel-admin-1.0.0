/**
 * jiuxiaozw 主题交互层（R142）——复刻 jiuxiaozw.com 客户端行为的最小子集：
 * 日/夜切换(.dark + :root.dark 令牌)、桌面 dn-category 下拉、rl-hero 三张轮换、
 * 移动 mh-carousel 无缝循环、reader 分页阅读器（columns+translateX，与原站同机制）+
 * 触屏/鼠标四向滑动翻页（上下左右，reader-page-preview 影子层跟手 + data-moving=X/Y 影子特效）+
 * 设置面板（字号/行距/纸色，localStorage 持久）+ 相对时间/分享复制/书架演示位/锚点接驾。
 * 零依赖 vanilla；页面级渐进：JS 失效时 reader 保持 data-reader-ready="false" 滚动兜底。
 */
(function () {
  'use strict';
  var root = document.documentElement;
  var doc = document;
  function $(sel, ctx) { return (ctx || doc).querySelector(sel); }
  function $all(sel, ctx) { return Array.prototype.slice.call((ctx || doc).querySelectorAll(sel)); }

  /* ---------- 日/夜切换：html.dark 驱动 :root.dark 令牌 ---------- */
  var dark = false;
  try { dark = localStorage.getItem('jxzw-theme') === 'dark'; } catch (e) {}
  function applyDark() {
    root.classList.toggle('dark', dark);
    $all('.site-theme-toggle').forEach(function (b) { b.setAttribute('aria-pressed', dark ? 'true' : 'false'); });
  }
  applyDark();
  doc.addEventListener('click', function (ev) {
    var b = ev.target.closest ? ev.target.closest('.site-theme-toggle') : null;
    if (!b) return;
    dark = !dark;
    try { localStorage.setItem('jxzw-theme', dark ? 'dark' : 'light'); } catch (e) {}
    applyDark();
  });

  /* ---------- 桌面分类下拉 ---------- */
  var catBtn = $('.dn-categories .dn-minor');
  var catMenu = $('#dn-category-menu');
  if (catBtn && catMenu) {
    catBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var open = catMenu.hasAttribute('hidden');
      if (open) { catMenu.removeAttribute('hidden'); } else { catMenu.setAttribute('hidden', ''); }
      catBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    doc.addEventListener('click', function (ev) {
      if (!catMenu.hasAttribute('hidden') && !ev.target.closest('.dn-categories')) {
        catMenu.setAttribute('hidden', '');
        catBtn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  /* ---------- 桌面 rl-hero 轮换（3 张，缩略按钮 aria-pressed） ---------- */
  var heroes = $all('.rl-hero-main');
  var thumbs = $all('[data-hero-btn]');
  if (heroes.length > 1) {
    var hi = 0, hTimer = null;
    function showHero(i) {
      hi = (i + heroes.length) % heroes.length;
      heroes.forEach(function (el, k) { el.classList.toggle('jxzw-hidden', k !== hi); });
      thumbs.forEach(function (b, k) { b.setAttribute('aria-pressed', k === hi ? 'true' : 'false'); });
    }
    function heroPlay() { hTimer = setInterval(function () { showHero(hi + 1); }, 6000); }
    function heroStop() { if (hTimer) { clearInterval(hTimer); hTimer = null; } }
    thumbs.forEach(function (b, k) { b.addEventListener('click', function () { showHero(k); heroStop(); heroPlay(); }); });
    var heroBox = $('.rl-hero');
    if (heroBox) { heroBox.addEventListener('mouseenter', heroStop); heroBox.addEventListener('mouseleave', heroPlay); }
    doc.addEventListener('visibilitychange', function () { doc.hidden ? heroStop() : heroPlay(); });
    heroPlay();
  }

  /* ---------- 移动轮播：scroll-snap + 克隆首尾无缝循环（原站同机制） ---------- */
  var track = $('.mh-banner-track');
  if (track && track.children.length > 1) {
    var slides = Array.prototype.slice.call(track.children);
    var last = slides[slides.length - 1].cloneNode(true);
    var first = slides[0].cloneNode(true);
    last.setAttribute('data-banner-clone', 'true'); last.setAttribute('aria-hidden', 'true'); last.setAttribute('tabindex', '-1');
    first.setAttribute('data-banner-clone', 'true'); first.setAttribute('aria-hidden', 'true'); last.setAttribute('tabindex', '-1');
    track.insertBefore(last, track.firstChild);
    track.appendChild(first);
    track.setAttribute('data-banner-ready', 'true');
    var idx = 1, cTimer = null;
    function slideW() { return track.clientWidth || 1; }
    function slideTo(i, instant) {
      idx = i;
      track.scrollTo({ left: i * slideW(), behavior: instant ? 'auto' : 'smooth' });
      slides.forEach(function (el, k) {
        var real = idx - 1 === k;
        el.setAttribute('aria-hidden', real ? 'false' : 'true');
        el.setAttribute('tabindex', real ? '0' : '-1');
      });
    }
    var sTimer = null;
    track.addEventListener('scroll', function () {
      if (sTimer) clearTimeout(sTimer);
      sTimer = setTimeout(function () {
        var i = Math.round(track.scrollLeft / slideW());
        if (i === 0) { idx = slides.length; track.scrollTo({ left: idx * slideW(), behavior: 'auto' }); }
        else if (i === slides.length + 1) { idx = 1; track.scrollTo({ left: slideW(), behavior: 'auto' }); }
        else { idx = i; }
        slides.forEach(function (el, k) {
          var real = idx - 1 === k;
          el.setAttribute('aria-hidden', real ? 'false' : 'true');
          el.setAttribute('tabindex', real ? '0' : '-1');
        });
      }, 90);
    }, { passive: true });
    function carouselPlay() { cTimer = setInterval(function () { slideTo(idx + 1); }, 6000); }
    function carouselStop() { if (cTimer) { clearInterval(cTimer); cTimer = null; } }
    var box = track.closest('.mh-carousel');
    if (box) { box.addEventListener('mouseenter', carouselStop); box.addEventListener('mouseleave', carouselPlay); }
    doc.addEventListener('visibilitychange', function () { doc.hidden ? carouselStop() : carouselPlay(); });
    slideTo(1, true);
    carouselPlay();
  }

  /* ---------- 锚点接驾：双轨同名 data-anchor（桌面/移动其一 display:none 时定位另一轨） ---------- */
  function anchorJump(name) {
    if (!name) return false;
    var els = $all('[data-anchor="' + name + '"]');
    for (var i = 0; i < els.length; i++) {
      if (els[i].offsetParent !== null) {
        var y = els[i].getBoundingClientRect().top + window.pageYOffset - 70;
        window.scrollTo({ top: y, behavior: 'smooth' });
        return true;
      }
    }
    return false;
  }
  window.addEventListener('hashchange', function () { anchorJump(location.hash.replace(/^#/, '')); });
  if (location.hash) { setTimeout(function () { anchorJump(location.hash.replace(/^#/, '')); }, 60); }
  doc.addEventListener('click', function (ev) {
    var a = ev.target.closest ? ev.target.closest('a[href*="#jxzw-"]') : null;
    if (!a) return;
    var m = (a.getAttribute('href') || '').match(/#(jxzw-[a-z-]+)$/);
    if (!m || a.pathname !== location.pathname) return;
    ev.preventDefault();
    history.replaceState(null, '', '#' + m[1]);
    anchorJump(m[1].replace('jxzw-', ''));
  });

  /* ---------- 相对时间 ---------- */
  $all('[data-rel-ts]').forEach(function (el) {
    var t = new Date(el.getAttribute('data-rel-ts'));
    if (isNaN(t.getTime())) return;
    var diff = Date.now() - t.getTime();
    var txt;
    if (diff < 60e3) txt = '刚刚更新';
    else if (diff < 3600e3) txt = Math.floor(diff / 60e3) + '分钟前更新';
    else if (diff < 86400e3) txt = Math.floor(diff / 3600e3) + '小时前更新';
    else if (diff < 30 * 86400e3) txt = Math.floor(diff / 86400e3) + '天前更新';
    else txt = Math.floor(diff / (30 * 86400e3)) + '个月前更新';
    el.textContent = txt;
  });

  /* ---------- 分享复制 ---------- */
  doc.addEventListener('click', function (ev) {
    var b = ev.target.closest ? ev.target.closest('[data-share-link]') : null;
    if (!b) return;
    var st = b.parentElement && b.parentElement.querySelector('[data-share-status]');
    function done() {
      if (!st) return;
      st.textContent = '链接已复制';
      st.setAttribute('data-visible', 'true');
      setTimeout(function () { st.setAttribute('data-visible', 'false'); }, 1800);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(location.href).then(done, done);
    } else { done(); }
  });

  /* ---------- 书架演示位（客户端 localStorage，无服务端面） ---------- */
  function shelfMap() { try { return JSON.parse(localStorage.getItem('jxzw-shelf') || '{}'); } catch (e) { return {}; } }
  function paintShelf() {
    var m = shelfMap();
    $all('[data-shelf-book]').forEach(function (a) {
      var id = a.getAttribute('data-shelf-book');
      var on = !!m[id];
      a.setAttribute('data-shelved', on ? 'true' : 'false');
      var lab = a.querySelector('span');
      if (lab) lab.textContent = on ? '已在书架' : '加入书架';
    });
  }
  paintShelf();
  doc.addEventListener('click', function (ev) {
    var a = ev.target.closest ? ev.target.closest('[data-shelf-book]') : null;
    if (!a) return;
    ev.preventDefault();
    var m = shelfMap();
    var id = a.getAttribute('data-shelf-book');
    if (m[id]) { delete m[id]; } else { m[id] = { t: a.getAttribute('data-shelf-title') || '', ts: Date.now() }; }
    try { localStorage.setItem('jxzw-shelf', JSON.stringify(m)); } catch (e) {}
    paintShelf();
  });

  /* ---------- 简介展开 ---------- */
  doc.addEventListener('click', function (ev) {
    var b = ev.target.closest ? ev.target.closest('[data-desc-toggle]') : null;
    if (!b) return;
    var d = $('#' + b.getAttribute('data-desc-toggle'));
    if (!d) return;
    var open = d.classList.toggle('jxzw-desc-open');
    d.style.webkitLineClamp = open ? 'unset' : '';
    b.setAttribute('aria-expanded', open ? 'true' : 'false');
    b.textContent = open ? '收起' : '展开';
  });

  /* =====================================================================
     阅读器：分页（columns + translateX，机制与原站一致）+ 设置面板
     ===================================================================== */
  var pagesRoot = $('.reader-pages-root');
  if (pagesRoot) {
    var frame = $('.reader-frame', pagesRoot);
    var pageWindow = $('.reader-page-window', pagesRoot);
    var textWindow = $('.reader-text-window', pagesRoot);
    var cols = $('.reader-columns', pagesRoot);
    var pageEl = $('[data-reader-page]');
    var pctEl = $('[data-reader-pct]');
    var tapL = $('.jxzw-tap-left', pagesRoot);
    var tapR = $('.jxzw-tap-right', pagesRoot);
    var tapC = $('.jxzw-tap-center', pagesRoot);

    /* ---------- R151 断点续读（原站同款 key 语义）：章内 reader-page:<chapterId> +
       书级 reader-progress:v1:guest:<bookId>，reload/hydrate 后自动恢复到上次位置。
       horizontal 存页码 cur/pages + 渲染参数（font/lh 一致才直跳；不一致按 fraction 换算）；
       scroll 存滚动比例 fraction。章级 key 带 LRU 上限防 localStorage 膨胀。 */
    var chapterId = String(pagesRoot.getAttribute('data-chapter-id') || '');
    var bookIdR = String(pagesRoot.getAttribute('data-book-id') || '');
    var chapterIdx = parseInt(pagesRoot.getAttribute('data-chapter-idx') || '0', 10) || 0;
    var chapterTitle = '';
    var h1El = cols ? cols.querySelector('h1') : null;
    if (h1El) chapterTitle = (h1El.textContent || '').trim();
    var PAGE_KEY_PREFIX = 'reader-page:';
    var BOOK_KEY_PREFIX = 'reader-progress:v1:guest:';
    var PAGE_KEY_CAP = 40;
    var saveTimer = null;
    function readPagePos() {
      try { return JSON.parse(localStorage.getItem(PAGE_KEY_PREFIX + chapterId) || 'null'); } catch (e) { return null; }
    }
    function prunePageKeys() {
      try {
        var keys = [];
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf(PAGE_KEY_PREFIX) === 0) {
            var at = 0;
            try { at = JSON.parse(localStorage.getItem(k)).at || 0; } catch (e) {}
            keys.push([k, at]);
          }
        }
        if (keys.length <= PAGE_KEY_CAP) return;
        keys.sort(function (a, b) { return a[1] - b[1]; });
        while (keys.length > PAGE_KEY_CAP) { localStorage.removeItem(keys.shift()[0]); }
      } catch (e) {}
    }
    function writePagePos(pos) {
      if (!chapterId) return;
      try {
        pos.at = Date.now();
        localStorage.setItem(PAGE_KEY_PREFIX + chapterId, JSON.stringify(pos));
        prunePageKeys();
      } catch (e) {}
    }
    function writeBookProgress(local) {
      if (!bookIdR) return;
      try { localStorage.setItem(BOOK_KEY_PREFIX + bookIdR, JSON.stringify({ account: 'guest', local: local, at: Date.now() })); } catch (e) {}
    }
    function savePos() {
      if (!chapterId) return;
      if (readerMode === 'horizontal') {
        var frac = total > 0 ? cur / total : 0;
        writePagePos({ cur: cur, pages: total, fraction: frac, font: st.font, lh: st.lh });
        writeBookProgress({ chapterId: chapterId, chapterNumber: chapterIdx, chapterTitle: chapterTitle, cur: cur, pages: total, fraction: frac });
      } else {
        var max = textWindow.scrollHeight - textWindow.clientHeight;
        var f = max > 0 ? textWindow.scrollTop / max : 0;
        writePagePos({ fraction: f });
        writeBookProgress({ chapterId: chapterId, chapterNumber: chapterIdx, chapterTitle: chapterTitle, fraction: f });
      }
    }
    function savePosThrottled() {
      if (saveTimer) return;
      saveTimer = setTimeout(function () { saveTimer = null; savePos(); }, 900);
    }
    window.addEventListener('pagehide', function () {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; savePos(); }
    });
    var restored = false;
    function restorePos() {
      if (restored || !chapterId) return;
      restored = true;
      var pos = readPagePos();
      if (!pos) return;
      if (readerMode === 'horizontal') {
        var target = -1;
        if (pos.cur >= 0 && pos.cur < total && pos.font === st.font && pos.lh === st.lh) target = pos.cur;
        else if (pos.fraction > 0 && pos.fraction < 1) target = Math.min(total - 1, Math.round(pos.fraction * total));
        if (target > 0) { cur = target; render(); }
      } else {
        if (pos.fraction > 0 && pos.fraction < 1) {
          var max = textWindow.scrollHeight - textWindow.clientHeight;
          if (max > 0) textWindow.scrollTop = pos.fraction * max;
        }
      }
    }

    /* ---------- R148 阅读页模式决策：后台 readerMode 设置（data-reader-mode-setting 透传） ----------
       page=全端分页；scroll=全端全文；auto=跟随设备：PC（hover+fine 主指针）全文滚动、触屏分页。
       JS 权威决策一次定终身（服务端 data-mode 初值只作 no-JS 兜底；窗口拖拽跨阈值不做
       运行时切换，保分页状态机简单）。原站 data-mode=scroll 同款钩子（text-window 即滚动容器、
       columns 原生流式）在 CSS 内已具备，零额外几何适配。 */
    var modeSetting = pagesRoot.getAttribute('data-reader-mode-setting') || 'auto';
    function decideReaderMode() {
      if (modeSetting === 'page') return 'horizontal';
      if (modeSetting === 'scroll') return 'scroll';
      try {
        /* PC 判定：hover+fine 主指针（真桌面）或宽视口 ≥1024（桌面窗口/headless 无指针
           媒体特征、平板横屏）。≥1024 的触屏设备走滚动模式同样自然（pan-y 原生滚动）；
           手机窄屏两条件皆 false → 分页 + 四向手势 */
        var pc = false;
        if (window.matchMedia) {
          pc = window.matchMedia('(hover: hover) and (pointer: fine)').matches
            || window.matchMedia('(min-width: 1024px)').matches;
        }
        return pc ? 'scroll' : 'horizontal';
      } catch (e) { return 'horizontal'; }
    }
    var readerMode = decideReaderMode();
    pagesRoot.setAttribute('data-mode', readerMode);

    var st = { font: 22, lh: 1.4, paper: 'sepia' };
    try { var saved = JSON.parse(localStorage.getItem('jxzw-reader') || 'null'); if (saved) st = saved; } catch (e) {}
    var PAPERS = {
      sepia: { paper: '#dbc49e', ink: '#382b19', panel: '#faf3e5', texture: true },
      white: { paper: '#ffffff', ink: '#262626', panel: '#f5f5f4', texture: false },
      green: { paper: '#e2efe0', ink: '#2c3a2e', panel: '#eef5ec', texture: false },
      dark: { paper: '#1a1a1a', ink: '#a0a0a0', panel: '#252525', texture: false }
    };
    function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
    function saveSt() { try { localStorage.setItem('jxzw-reader', JSON.stringify(st)); } catch (e) {} }
    function applyPaper() {
      var p = PAPERS[st.paper] || PAPERS.sepia;
      pagesRoot.style.setProperty('--reader-paper', p.paper);
      pagesRoot.style.setProperty('--reader-ink', p.ink);
      pagesRoot.style.setProperty('--reader-panel', p.panel);
      frame.setAttribute('data-paper', p.texture ? 'true' : 'false');
      var rail = $('.reader-rail');
      if (rail) {
        rail.style.backgroundColor = p.paper;
        rail.style.borderColor = p.panel;
        rail.style.color = p.ink;
        var hrs = rail.querySelectorAll('hr');
        for (var i = 0; i < hrs.length; i++) hrs[i].style.borderColor = p.panel;
      }
      pagesRoot.setAttribute('data-dark', st.paper === 'dark' ? 'true' : 'false');
      $all('[data-paper-dot],.jxzw-paper-dot').forEach(function (d) { d.setAttribute('aria-pressed', d.getAttribute('data-paper') === st.paper ? 'true' : 'false'); });
    }
    var total = 1, cur = 0, colGap = 48;
    /* R148: 滚动模式进度（text-window 即滚动容器，百分比 = scrollTop 比例） */
    function updateScrollProgress() {
      if (!textWindow) return;
      var max = textWindow.scrollHeight - textWindow.clientHeight;
      var p = max > 0 ? textWindow.scrollTop / max : 0;
      if (pageEl) pageEl.textContent = '全文';
      if (pctEl) pctEl.textContent = Math.round(p * 100) + '%';
      pagesRoot.setAttribute('data-reading-position', String(Math.round(p * 100)));
    }
    function measure() {
      if (!cols || !textWindow) return;
      var w = textWindow.clientWidth;
      if (w <= 0) return;
      cols.style.fontFamily = '"PingFang SC","Noto Sans CJK SC","Noto Sans SC","Microsoft YaHei",sans-serif';
      cols.style.fontSize = st.font + 'px';
      cols.style.lineHeight = String(st.lh);
      pagesRoot.style.setProperty('--reader-paragraph-gap', '0.72em');
      if (readerMode !== 'horizontal') {
        /* 滚动模式：columns 原生流式（CSS [data-mode=scroll] 已接管），清分页内联样式后仅维护进度 */
        cols.style.columnWidth = '';
        cols.style.columnGap = '';
        cols.style.transform = '';
        if (pageEl) pageEl.textContent = '全文';
        updateScrollProgress();
        restorePos();
        return;
      }
      cols.style.columnWidth = w + 'px';
      cols.style.columnGap = colGap + 'px';
      var full = cols.scrollWidth;
      total = Math.max(1, Math.round((full + colGap) / (w + colGap)));
      if (cur >= total) cur = total - 1;
      render();
      restorePos();
    }
    function render() {
      var w = textWindow.clientWidth || 1;
      cols.style.transform = 'translateX(-' + (cur * (w + colGap)) + 'px)';
      if (pageEl) pageEl.textContent = (cur + 1) + '/' + total;
      if (pctEl) pctEl.textContent = Math.round(((cur + 1) / total) * 100) + '%';
      pagesRoot.setAttribute('data-reading-position', String(cur));
      savePosThrottled();
    }
    function goPage(d) {
      if (anim) return;
      var n = cur + d;
      if (n < 0 || n >= total) { navChapter(d < 0 ? 'prev' : 'next'); return; }
      /* 翻页特效：热区/键盘翻页同样带 240ms 贝塞尔平移过渡 */
      anim = true;
      cols.style.transition = 'transform 240ms cubic-bezier(.22,.61,.36,1)';
      cur = n;
      render();
      setTimeout(function () {
        anim = false;
        cols.style.transition = 'none';
        render();
        requestAnimationFrame(function () { cols.style.transition = ''; });
      }, 270);
    }
    function navChapter(dir) {
      var b = $('[data-nav="' + dir + '"]', pagesRoot);
      if (b && !b.hasAttribute('disabled') && b.getAttribute('href')) location.href = b.getAttribute('href');
    }
    pagesRoot.setAttribute('data-reader-ready', 'true');
    applyPaper();
    if (readerMode === 'scroll') {
      /* 滚动模式：顶栏常开（PC 无中央热区可呼出，隐藏态将无入口）；进度跟 scroll 被动维护 */
      var bar = $('[data-reader-toolbar]');
      if (bar) bar.setAttribute('data-open', 'true');
      var menuAcc = $('.reader-menu-access');
      if (menuAcc) menuAcc.setAttribute('aria-expanded', 'true');
      textWindow.addEventListener('scroll', function () {
        if (rAF) cancelAnimationFrame(rAF);
        rAF = requestAnimationFrame(updateScrollProgress);
        savePosThrottled();
      }, { passive: true });
    }
    /* 上一轮设置回放 */
    cols.style.fontSize = st.font + 'px';
    cols.style.lineHeight = String(st.lh);
    if ($('[data-font-val]')) $('[data-font-val]').textContent = st.font + 'px';
    $all('[data-lh]').forEach(function (b) { b.setAttribute('aria-pressed', parseFloat(b.getAttribute('data-lh')) === st.lh ? 'true' : 'false'); });

    var rAF = null;
    function remeasure() {
      if (rAF) cancelAnimationFrame(rAF);
      rAF = requestAnimationFrame(measure);
    }
    window.addEventListener('resize', remeasure);
    window.addEventListener('load', remeasure);
    if (doc.fonts && doc.fonts.ready) doc.fonts.ready.then(remeasure);
    setTimeout(measure, 30);
    setTimeout(measure, 400);

    if (readerMode === 'horizontal') {
      if (tapL) tapL.addEventListener('click', function () { goPage(-1); });
      if (tapR) tapR.addEventListener('click', function () { goPage(1); });
    }
    if (pageWindow) {
      pageWindow.addEventListener('keydown', function (ev) {
        if (readerMode === 'scroll') {
          /* 滚动模式：左右键 = 章导航（与右侧栏同语义），上下键交浏览器原生滚动 */
          if (ev.key === 'ArrowLeft') { ev.preventDefault(); navChapter('prev'); }
          if (ev.key === 'ArrowRight') { ev.preventDefault(); navChapter('next'); }
          return;
        }
        if (ev.key === 'ArrowLeft') { ev.preventDefault(); goPage(-1); }
        if (ev.key === 'ArrowRight') { ev.preventDefault(); goPage(1); }
      });
    }
    doc.addEventListener('keydown', function (ev) {
      if (ev.target && (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA')) return;
      if (ev.ctrlKey && ev.key === 'ArrowLeft') { ev.preventDefault(); navChapter('prev'); }
      if (ev.ctrlKey && ev.key === 'ArrowRight') { ev.preventDefault(); navChapter('next'); }
      if (!ev.ctrlKey && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
        var active = doc.activeElement;
        if (active && pageWindow && (active === pageWindow || pageWindow.contains(active))) {
          ev.preventDefault();
          if (readerMode === 'scroll') navChapter(ev.key === 'ArrowLeft' ? 'prev' : 'next');
          else goPage(ev.key === 'ArrowLeft' ? -1 : 1);
        }
      }
    });

    /* ---------- 四向滑动翻页：上/左滑 = 下一页，下/右滑 = 上一页（跟手 + 影子层 + data-moving=X/Y 影子特效 + 边界橡皮筋，
       原站同机制；触摸指针靠浏览器隐式捕获不 setPointerCapture 以免重定向点击破坏热区；鼠标拖拽在成手后显式捕获） ---------- */
    var surface = $('.reader-page-surface', pagesRoot);
    var preview = $('[data-reader-preview]', pagesRoot);
    if (readerMode === 'horizontal' && surface && preview && 'PointerEvent' in window) {
      var drag = null, anim = false, suppressClick = false;
      function dragStride() { return (textWindow.clientWidth || 1) + colGap; }
      function dragWinH() { return pageWindow.clientHeight || 1; }
      function dragWinW() { return pageWindow.clientWidth || 1; }
      function fillPreview(target) {
        /* 影子层复制同几何文本窗 + 目标页列偏移，分页断点与主层严格一致 */
        var tw = textWindow.cloneNode(false);
        var cc = cols.cloneNode(true);
        cc.style.transform = 'translateX(-' + (target * dragStride()) + 'px)';
        tw.appendChild(cc);
        preview.innerHTML = '';
        preview.style.display = 'flex';
        preview.style.flexDirection = 'column';
        preview.appendChild(tw);
        preview.removeAttribute('hidden');
      }
      function clearPreview() {
        preview.innerHTML = '';
        preview.style.display = '';
        preview.style.flexDirection = '';
        preview.style.transform = '';
        preview.style.zIndex = '';
        preview.removeAttribute('data-moving');
        preview.setAttribute('hidden', '');
      }
      function dragCleanup() {
        surface.style.transition = 'none';
        surface.style.transform = '';
        preview.style.transition = 'none';
        surface.removeAttribute('data-moving');
        pageWindow.removeAttribute('data-turning');
        pagesRoot.style.userSelect = '';
        clearPreview();
        requestAnimationFrame(function () {
          surface.style.transition = '';
          preview.style.transition = '';
        });
      }
      function flickVel(samples, ax) {
        if (samples.length < 2) return 0;
        var a = samples[samples.length - 1], b = samples[0];
        if (a.t <= b.t) return 0;
        return (ax === 'x' ? a.x - b.x : a.y - b.y) / (a.t - b.t);
      }
      pageWindow.addEventListener('click', function (ev) {
        if (suppressClick) { ev.stopPropagation(); ev.preventDefault(); suppressClick = false; }
      }, true);
      pageWindow.addEventListener('pointerdown', function (ev) {
        if (anim || drag || ev.button !== 0) return;
        suppressClick = false;
        drag = { id: ev.pointerId, type: ev.pointerType, x0: ev.clientX, y0: ev.clientY, decided: false, axis: '', mode: null, samples: [{ x: ev.clientX, y: ev.clientY, t: ev.timeStamp }] };
      });
      pageWindow.addEventListener('pointermove', function (ev) {
        if (!drag || ev.pointerId !== drag.id) return;
        var dx = ev.clientX - drag.x0, dy = ev.clientY - drag.y0;
        if (!drag.decided) {
          if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return;
          drag.decided = true;
          suppressClick = true;
          drag.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
          if (drag.type === 'mouse') { try { pageWindow.setPointerCapture(drag.id); } catch (e) {} }
          pageWindow.setAttribute('data-turning', '');
          pagesRoot.style.userSelect = 'none';
          cols.style.transition = 'none';
          try { var sel = window.getSelection(); if (sel) sel.removeAllRanges(); } catch (e) {}
        }
        var ax = drag.axis;
        var d = ax === 'x' ? dx : dy;
        drag.samples.push({ x: ev.clientX, y: ev.clientY, t: ev.timeStamp });
        if (drag.samples.length > 6) drag.samples.shift();
        var goingNext = d < 0; /* 上滑/左滑 = 下一页 */
        var atEdge = goingNext ? cur >= total - 1 : cur <= 0;
        if (atEdge) {
          /* 章内边界：橡皮筋阻尼，不出影子层 */
          if (drag.mode !== 'edge') {
            clearPreview();
            surface.removeAttribute('data-moving');
            drag.mode = 'edge';
          }
          surface.style.transform = ax === 'x' ? 'translateX(' + (d * 0.3) + 'px)' : 'translateY(' + (d * 0.3) + 'px)';
          return;
        }
        var target = goingNext ? cur + 1 : cur - 1;
        if (drag.mode !== target) { fillPreview(target); drag.mode = target; }
        if (goingNext) {
          /* 离场页在上层，影子投向 incoming 页 */
          surface.setAttribute('data-moving', ax === 'x' ? 'X' : 'Y');
          preview.removeAttribute('data-moving');
          preview.style.zIndex = '';
        } else {
          preview.setAttribute('data-moving', ax === 'x' ? 'X' : 'Y');
          surface.removeAttribute('data-moving');
          preview.style.zIndex = '2';
        }
        surface.style.transform = ax === 'x' ? 'translateX(' + dx + 'px)' : 'translateY(' + dy + 'px)';
        var W = ax === 'x' ? dragWinW() : dragWinH();
        preview.style.transform = goingNext
          ? (ax === 'x' ? 'translateX(' + (W + dx) + 'px)' : 'translateY(' + (W + dy) + 'px)')
          : (ax === 'x' ? 'translateX(' + (dx - W) + 'px)' : 'translateY(' + (dy - W) + 'px)');
      });
      function endDrag(ev, forceCancel) {
        if (!drag || ev.pointerId !== drag.id) return;
        var dg = drag;
        drag = null;
        if (dg.type === 'mouse') { try { pageWindow.releasePointerCapture(dg.id); } catch (e) {} }
        if (!dg.decided) return;
        /* 抑制随抬手派生的 click；400ms 后自愈，避免悬挂标记吞掉下一次真实点击 */
        setTimeout(function () { if (!drag) suppressClick = false; }, 400);
        var ax = dg.axis;
        var dc = ax === 'x' ? ev.clientX - dg.x0 : ev.clientY - dg.y0;
        var goingNext = dc < 0;
        var dist = Math.abs(dc);
        var W = ax === 'x' ? dragWinW() : dragWinH();
        var outT = ax === 'x' ? 'translateX(' : 'translateY(';
        function snapBack(ms) {
          anim = true;
          var t = 'transform ' + (ms || 220) + 'ms cubic-bezier(.22,.61,.36,1)';
          surface.style.transition = t;
          preview.style.transition = t;
          surface.style.transform = outT + '0px)';
          preview.style.transform = goingNext ? outT + W + 'px)' : outT + '-' + W + 'px)';
          setTimeout(function () { anim = false; dragCleanup(); }, (ms || 220) + 30);
        }
        if (forceCancel) { snapBack(200); return; }
        var vel = flickVel(dg.samples, ax);
        var fling = goingNext ? vel <= -0.5 : vel >= 0.5;
        if (goingNext ? cur >= total - 1 : cur <= 0) {
          /* 边界强甩 → 下一/上一章（与点击热区同语义，navChapter 自带 disabled 兜底）；否则弹回 */
          if ((fling && dist >= 48) || dist >= W * 0.5) {
            anim = true;
            navChapter(goingNext ? 'next' : 'prev');
            setTimeout(dragCleanup, 90);
          } else { snapBack(220); }
          return;
        }
        if (dist >= W * 0.22 || fling) {
          /* 翻页特效：离场页滑出 + incoming 页滑入，260ms 贝塞尔收尾 */
          anim = true;
          var target = goingNext ? cur + 1 : cur - 1;
          var t = 'transform 260ms cubic-bezier(.22,.61,.36,1)';
          surface.style.transition = t;
          preview.style.transition = t;
          if (goingNext) {
            surface.style.transform = outT + '-' + W + 'px)';
            preview.style.transform = outT + '0px)';
          } else {
            preview.style.transform = outT + '0px)';
            surface.style.transform = outT + W + 'px)';
          }
          setTimeout(function () {
            anim = false;
            cur = target;
            cols.style.transition = 'none';
            render();
            dragCleanup();
          }, 290);
        } else { snapBack(220); }
      }
      pageWindow.addEventListener('pointerup', function (ev) { endDrag(ev, false); });
      pageWindow.addEventListener('pointercancel', function (ev) { endDrag(ev, true); });
    }

    /* 顶栏开合：中央热区 / 阅读菜单按钮 */
    function toggleToolbar(open) {
      var bar = $('[data-reader-toolbar]');
      var btn = $('.reader-menu-access');
      if (!bar) return;
      var isOpen = open === undefined ? bar.getAttribute('data-open') !== 'true' : open;
      bar.setAttribute('data-open', isOpen ? 'true' : 'false');
      bar.removeAttribute('inert');
      if (btn) btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    }
    if (tapC) tapC.addEventListener('click', function () { toggleToolbar(); });
    var menuBtn = $('.reader-menu-access');
    if (menuBtn) menuBtn.addEventListener('click', function () { toggleToolbar(); });

    /* 上一章/下一章（rail 按钮为 <a> 形态时直接跳转） */
    $all('[data-nav]').forEach(function (b) {
      b.addEventListener('click', function (ev) {
        if (b.tagName === 'BUTTON' && !b.hasAttribute('disabled')) {
          var href = b.getAttribute('data-href');
          if (href) location.href = href;
        }
      });
    });

    /* ---------- 设置面板 ---------- */
    var panel = $('.jxzw-reader-panel');
    function togglePanel(open) {
      if (!panel) return;
      var isOpen = open === undefined ? panel.getAttribute('data-open') !== 'true' : open;
      panel.setAttribute('data-open', isOpen ? 'true' : 'false');
      var sb = $('[data-reader-settings]');
      if (sb) sb.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    }
    var setBtn = $('[data-reader-settings]');
    if (setBtn) setBtn.addEventListener('click', function (ev) { ev.stopPropagation(); togglePanel(); });
    doc.addEventListener('click', function (ev) {
      if (panel && panel.getAttribute('data-open') === 'true' && !ev.target.closest('.jxzw-reader-panel') && !ev.target.closest('[data-reader-settings]')) {
        togglePanel(false);
      }
    });
    $all('[data-font-step]').forEach(function (b) {
      b.addEventListener('click', function () {
        st.font = clamp(st.font + parseInt(b.getAttribute('data-font-step'), 10) * 2, 14, 32);
        if ($('[data-font-val]')) $('[data-font-val]').textContent = st.font + 'px';
        saveSt(); measure();
      });
    });
    $all('[data-lh]').forEach(function (b) {
      b.addEventListener('click', function () {
        st.lh = parseFloat(b.getAttribute('data-lh'));
        $all('[data-lh]').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
        saveSt(); measure();
      });
    });
    $all('[data-paper]').forEach(function (b) {
      b.addEventListener('click', function () {
        st.paper = b.getAttribute('data-paper');
        applyPaper(); saveSt();
      });
    });

  }

  /* ---------- R151 书页断点续读：reader-progress 书级进度 → CTA「开始/立即阅读」升级为
     「继续阅读」并直指上次读到的章节（原站同语义：阅读页写入书级进度，书页 hydrate 消费） ---------- */
  var continueCta = $('[data-continue-cta]');
  if (continueCta) {
    var bookIdC = String(continueCta.getAttribute('data-book-id') || '');
    if (bookIdC) {
      var prog = null;
      try { prog = JSON.parse(localStorage.getItem('reader-progress:v1:guest:' + bookIdC) || 'null'); } catch (e) {}
      var local = prog && prog.local;
      if (local && local.chapterId) {
        continueCta.setAttribute('href', '/chapter/' + local.chapterId);
        var spanEl = continueCta.querySelector('span');
        if (spanEl) {
          var chTitle = String(local.chapterTitle || '');
          var chNum = parseInt(local.chapterNumber || '0', 10) || 0;
          spanEl.textContent = '继续阅读';
          var tip = chTitle || (chNum > 0 ? '第' + chNum + '章' : '');
          if (tip) {
            continueCta.setAttribute('title', '上次读到：' + tip);
            continueCta.setAttribute('aria-label', '继续阅读，上次读到：' + tip);
          }
        }
      }
    }
  }
})();
