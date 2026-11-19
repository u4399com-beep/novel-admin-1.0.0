/**
 * jiuxiaozw 主题交互层（R142）——复刻 jiuxiaozw.com 客户端行为的最小子集：
 * 日/夜切换(.dark + :root.dark 令牌)、桌面 dn-category 下拉、rl-hero 三张轮换、
 * 移动 mh-carousel 无缝循环、reader 分页阅读器（columns+translateX，与原站同机制）+
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
    function measure() {
      if (!cols || !textWindow) return;
      var w = textWindow.clientWidth;
      if (w <= 0) return;
      cols.style.fontFamily = '"PingFang SC","Noto Sans CJK SC","Noto Sans SC","Microsoft YaHei",sans-serif';
      cols.style.fontSize = st.font + 'px';
      cols.style.lineHeight = String(st.lh);
      pagesRoot.style.setProperty('--reader-paragraph-gap', '0.72em');
      cols.style.columnWidth = w + 'px';
      cols.style.columnGap = colGap + 'px';
      var full = cols.scrollWidth;
      total = Math.max(1, Math.round((full + colGap) / (w + colGap)));
      if (cur >= total) cur = total - 1;
      render();
    }
    function render() {
      var w = textWindow.clientWidth || 1;
      cols.style.transform = 'translateX(-' + (cur * (w + colGap)) + 'px)';
      if (pageEl) pageEl.textContent = (cur + 1) + '/' + total;
      if (pctEl) pctEl.textContent = Math.round(((cur + 1) / total) * 100) + '%';
      pagesRoot.setAttribute('data-reading-position', String(cur));
    }
    function goPage(d) {
      var n = clamp(cur + d, 0, total - 1);
      if (n === cur) {
        if (d < 0) navChapter('prev');
        else navChapter('next');
        return;
      }
      cur = n; render();
    }
    function navChapter(dir) {
      var b = $('[data-nav="' + dir + '"]', pagesRoot);
      if (b && !b.hasAttribute('disabled') && b.getAttribute('href')) location.href = b.getAttribute('href');
    }
    pagesRoot.setAttribute('data-reader-ready', 'true');
    applyPaper();
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

    if (tapL) tapL.addEventListener('click', function () { goPage(-1); });
    if (tapR) tapR.addEventListener('click', function () { goPage(1); });
    if (pageWindow) {
      pageWindow.addEventListener('keydown', function (ev) {
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
          ev.preventDefault(); goPage(ev.key === 'ArrowLeft' ? -1 : 1);
        }
      }
    });
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
})();
