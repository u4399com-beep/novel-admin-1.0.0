/**
 * aijjxs.js —— 爱尚小说主题私有交互（vanilla JS，零依赖）。
 * 移植自 src/themes/aijjxs React 状态交互：
 *  1) 移动端抽屉菜单（TopBar open state）
 *  2) 阅读记录浮层（HistoryPanel，读 localStorage reader.history，写入方为公共 app.js）
 *  3) 收藏本站 / 回顶部（Footer promptFavorite / scrollTo）
 *  4) 书籍页：加入收藏（aj-favs）/ 简介折叠（FoldText）
 *  5) 分类页：排序/状态客户端筛选（FilterRow，data-* 属性驱动）
 *  6) 目录页：正/倒序切换（asc state）、最新章节反转、已读置灰（aj-read）
 *  7) 章节页：暖纸阅读器偏好（场景/字号/行距/字体/字色，localStorage aj.reader）+ 键盘翻章 + 已读标记
 */
(function () {
  'use strict';

  function lsGet(k, d) {
    try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ }
  }

  /* ---------- 1) 移动端抽屉 ---------- */
  var menuBtn = document.getElementById('aj-menu-btn');
  var drawer = document.getElementById('aj-drawer');
  if (menuBtn && drawer) {
    menuBtn.addEventListener('click', function () {
      var open = drawer.hasAttribute('hidden');
      if (open) drawer.removeAttribute('hidden'); else drawer.setAttribute('hidden', '');
      menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  /* ---------- 2) 阅读记录浮层 ---------- */
  var histPanel = document.getElementById('aj-hist-panel');
  function openHist() {
    if (!histPanel) return;
    var list = document.getElementById('aj-hist-list');
    var empty = document.getElementById('aj-hist-empty');
    var h = lsGet('reader.history', {});
    var rows = [];
    for (var k in h) if (Object.prototype.hasOwnProperty.call(h, k)) rows.push(h[k]);
    rows.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    if (list) {
      list.innerHTML = '';
      rows.slice(0, 30).forEach(function (r) {
        var li = document.createElement('li');
        li.className = 'aj-hist-item';
        var a = document.createElement('a');
        a.className = 'aj-hist-title';
        a.href = '/chapter/' + r.chapterId;
        a.textContent = (r.bookTitle ? r.bookTitle + ' · ' : '') + (r.title || '第' + r.chapterIdx + '章');
        var meta = document.createElement('span');
        meta.className = 'aj-hist-meta';
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
  Array.prototype.forEach.call(document.querySelectorAll('.aj-hist-btn'), function (b) {
    b.addEventListener('click', openHist);
  });
  if (histPanel) {
    Array.prototype.forEach.call(histPanel.querySelectorAll('[data-aj-hist-close]'), function (b) {
      b.addEventListener('click', closeHist);
    });
  }

  /* ---------- 3) 收藏本站 / 回顶部 ---------- */
  Array.prototype.forEach.call(document.querySelectorAll('.aj-fav'), function (b) {
    b.addEventListener('click', function () {
      var ok = false;
      try { ok = window.external && window.external.AddFavorite && window.external.AddFavorite(location.href, document.title); } catch (e) { ok = false; }
      try { if (!ok && window.sidebar && window.sidebar.addPanel) { window.sidebar.addPanel(document.title, location.href, ''); ok = true; } } catch (e) { /* ignore */ }
      if (!ok) window.alert('请按 Ctrl+D（Mac 为 ⌘+D）将本站加入收藏夹。');
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll('.aj-totop'), function (b) {
    b.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });
  });

  /* ---------- 4) 书籍页：收藏按钮 + 简介折叠 ---------- */
  var favBtn = document.getElementById('aj-fav-btn');
  if (favBtn) {
    var FAV_ON = 'mt-1.5 w-full cursor-pointer rounded-[6px] border border-[#b45309] bg-[#b45309] py-1 text-center text-xs text-white transition-colors';
    var FAV_OFF = 'mt-1.5 w-full cursor-pointer rounded-[6px] border border-[#e5dccd] bg-white py-1 text-center text-xs text-[#6b7280] transition-colors hover:border-[#b45309] hover:text-[#b45309]';
    var nid = favBtn.getAttribute('data-novel-id');
    var renderFav = function (on) {
      favBtn.className = on ? FAV_ON : FAV_OFF;
      favBtn.textContent = on ? '已收藏 ♥' : '加入收藏';
    };
    var favs = lsGet('aj-favs', []);
    renderFav(favs.indexOf(String(nid)) !== -1 || favs.indexOf(Number(nid)) !== -1);
    favBtn.addEventListener('click', function () {
      var arr = lsGet('aj-favs', []);
      var both = [String(nid), Number(nid)];
      var has = arr.indexOf(String(nid)) !== -1 || arr.indexOf(Number(nid)) !== -1;
      arr = arr.filter(function (x) { return both.indexOf(x) === -1; });
      if (!has) arr.push(String(nid));
      lsSet('aj-favs', arr.slice(-600));
      renderFav(!has);
    });
  }

  var descBtn = document.getElementById('aj-desc-btn');
  var descP = document.getElementById('aj-desc');
  if (descBtn && descP) {
    var open = false;
    descBtn.addEventListener('click', function () {
      open = !open;
      if (open) descP.classList.remove('line-clamp-4'); else descP.classList.add('line-clamp-4');
      descBtn.textContent = open ? '收起 ↑' : '展开全部 ↓';
    });
  }

  /* ---------- 5) 分类页：排序/状态筛选 ---------- */
  var catList = document.getElementById('aj-cat-list');
  if (catList) {
    var cards = Array.prototype.slice.call(catList.querySelectorAll('article[data-words]'));
    var sortsBox = document.getElementById('aj-cat-sorts');
    var statusBox = document.getElementById('aj-cat-status');
    var curStatus = 'all';

    function setActive(box, btn) {
      if (!box) return;
      var ACT = 'cursor-pointer rounded-full bg-[#0f766e] px-3 py-1.5 text-[13px] text-white shadow-sm';
      var IDLE = 'cursor-pointer rounded-full border border-[#e5dccd] bg-white px-3 py-1.5 text-[13px] text-[#6b7280] transition-colors hover:border-[#0f766e] hover:text-[#0f766e]';
      Array.prototype.forEach.call(box.querySelectorAll('button'), function (b) {
        var on = b === btn;
        b.className = on ? ACT : IDLE;
        if (on) b.setAttribute('data-active', 'true'); else b.removeAttribute('data-active');
      });
    }

    function renderStatus() {
      var shown = 0;
      cards.forEach(function (c) {
        var ok = curStatus === 'all' || c.getAttribute('data-status') === curStatus;
        c.style.display = ok ? '' : 'none';
        if (ok) shown++;
      });
      if (shown === 0) {
        var msg = catList.getAttribute('data-empty') || '该条件下暂无小说';
        var tip = document.getElementById('aj-cat-filter-empty');
        if (!tip) {
          tip = document.createElement('p');
          tip.id = 'aj-cat-filter-empty';
          tip.className = 'py-10 text-center text-[14px] text-[#6b7280]';
          catList.appendChild(tip);
        }
        tip.textContent = msg;
        tip.style.display = '';
      } else {
        var tip2 = document.getElementById('aj-cat-filter-empty');
        if (tip2) tip2.style.display = 'none';
      }
    }

    function sortCards(key) {
      var sorted = cards.slice();
      if (key === 'clicks') sorted.sort(function (a, b) { return (+b.getAttribute('data-clicks') || 0) - (+a.getAttribute('data-clicks') || 0); });
      else if (key === 'words') sorted.sort(function (a, b) { return (+b.getAttribute('data-words') || 0) - (+a.getAttribute('data-words') || 0); });
      else if (key === 'featured') sorted.sort(function (a, b) { return (+b.getAttribute('data-featured') || 0) - (+a.getAttribute('data-featured') || 0) || (+b.getAttribute('data-clicks') || 0) - (+a.getAttribute('data-clicks') || 0); });
      else sorted.reverse(); // latest = 恢复服务端 updatedAt DESC 原序
      sorted.forEach(function (c) { catList.appendChild(c); });
      var tip = document.getElementById('aj-cat-filter-empty');
      if (tip) catList.appendChild(tip);
    }

    if (sortsBox) {
      sortsBox.addEventListener('click', function (e) {
        var btn = e.target.closest('button[data-key]');
        if (!btn) return;
        setActive(sortsBox, btn);
        sortCards(btn.getAttribute('data-key'));
      });
    }
    if (statusBox) {
      statusBox.addEventListener('click', function (e) {
        var btn = e.target.closest('button[data-key]');
        if (!btn) return;
        setActive(statusBox, btn);
        curStatus = btn.getAttribute('data-key');
        renderStatus();
      });
    }
  }

  /* ---------- 6) 目录页：倒序 / 最新反转 / 已读置灰 ---------- */
  var tocList = document.getElementById('aj-toc-list');
  var orderBtn = document.getElementById('aj-toc-order');
  if (tocList) {
    var readSet = lsGet('aj-read', []);
    var READ_CLS = 'text-[#b7ac97]';
    Array.prototype.forEach.call(tocList.querySelectorAll('a[data-chapter-id]'), function (a) {
      var cid = a.getAttribute('data-chapter-id');
      if (readSet.indexOf(cid) !== -1 || readSet.indexOf(Number(cid)) !== -1) a.classList.add(READ_CLS);
    });
    if (orderBtn) {
      var asc = true;
      orderBtn.addEventListener('click', function () {
        asc = !asc;
        orderBtn.textContent = asc ? '倒序排列 ↓' : '正序排列 ↑';
        var items = Array.prototype.slice.call(tocList.querySelectorAll('a'));
        items.reverse().forEach(function (a) { tocList.appendChild(a); });
      });
    }
  }
  var latest = document.getElementById('aj-toc-latest');
  if (latest && latest.getAttribute('data-reverse')) {
    var items = Array.prototype.slice.call(latest.children);
    items.reverse().forEach(function (el) { latest.appendChild(el); });
  }

  /* ---------- 7) 章节页：暖纸阅读器 ---------- */
  var reader = document.getElementById('aj-reader');
  var content = document.getElementById('fb-chapter-content');
  if (reader && content) {
    var SCENES = {
      day:   { page: '#efe6d8', paper: '#fffcf6', ink: '#3d3327' },
      paper: { page: '#e6d9bd', paper: '#f8f0da', ink: '#4a3a24' },
      green: { page: '#e2ecdf', paper: '#f1f6ee', ink: '#2f4030' },
      blue:  { page: '#dfe8f0', paper: '#eef3f8', ink: '#2d3c46' },
      night: { page: '#26251f', paper: '#31302a', ink: '#c9c2b2' }
    };
    var FONTS = {
      '': '',
      default: '',
      song: '"Songti SC","SimSun",serif',
      hei: '"Heiti SC","SimHei","Microsoft YaHei",sans-serif',
      kai: 'KaiTi,STKaiti,"楷体",serif'
    };
    var prefs = lsGet('aj.reader', { scene: 'day', size: 21, lh: 1.8, font: 'default', ink: '' });
    if (!SCENES[prefs.scene]) prefs.scene = 'day';

    function apply() {
      var sc = SCENES[prefs.scene];
      reader.style.setProperty('--r-bg', sc.page);
      reader.style.setProperty('--r-paper', sc.paper);
      reader.style.setProperty('--r-ink', prefs.ink || sc.ink);
      reader.style.fontSize = prefs.size + 'px';
      reader.style.fontFamily = FONTS[prefs.font] || '';
      content.style.lineHeight = String(prefs.lh);
      // 清掉公共 app.js 的夜间模式内联样式，避免与本主题场景色冲突
      content.style.background = '';
      content.style.color = '';
      document.documentElement.style.background = '';
      Array.prototype.forEach.call(reader.querySelectorAll('[data-scene]'), function (b) {
        if (b.getAttribute('data-scene') === prefs.scene) b.setAttribute('data-active', 'true'); else b.removeAttribute('data-active');
      });
      Array.prototype.forEach.call(reader.querySelectorAll('[data-size]'), function (b) {
        if (+b.getAttribute('data-size') === +prefs.size) b.setAttribute('data-active', 'true'); else b.removeAttribute('data-active');
      });
      Array.prototype.forEach.call(reader.querySelectorAll('[data-lh]'), function (b) {
        if (+b.getAttribute('data-lh') === +prefs.lh) b.setAttribute('data-active', 'true'); else b.removeAttribute('data-active');
      });
      var fontSel = document.getElementById('aj-font');
      var inkSel = document.getElementById('aj-ink');
      if (fontSel) fontSel.value = prefs.font || 'default';
      if (inkSel) inkSel.value = prefs.ink || '';
    }

    reader.addEventListener('click', function (e) {
      var sc = e.target.closest('[data-scene]');
      if (sc) { prefs.scene = sc.getAttribute('data-scene'); lsSet('aj.reader', prefs); apply(); return; }
      var sz = e.target.closest('[data-size]');
      if (sz) { prefs.size = +sz.getAttribute('data-size'); lsSet('aj.reader', prefs); apply(); return; }
      var lh = e.target.closest('[data-lh]');
      if (lh) { prefs.lh = +lh.getAttribute('data-lh'); lsSet('aj.reader', prefs); apply(); }
    });
    var fontSel = document.getElementById('aj-font');
    if (fontSel) fontSel.addEventListener('change', function () { prefs.font = fontSel.value; lsSet('aj.reader', prefs); apply(); });
    var inkSel = document.getElementById('aj-ink');
    if (inkSel) inkSel.addEventListener('change', function () { prefs.ink = inkSel.value; lsSet('aj.reader', prefs); apply(); });

    /* 阅读分钟提示（约 X 分钟读完） */
    var wcEl = reader.querySelector('[data-wc]');
    if (wcEl) {
      var wc = +wcEl.getAttribute('data-wc') || 0;
      wcEl.textContent = wc > 0 ? '约 ' + Math.max(1, Math.ceil(wc / 500)) + ' 分钟读完' : '';
    }

    /* 已读标记（目录页置灰用） */
    var chId = content.getAttribute('data-chapter-id');
    if (chId) {
      var arr = lsGet('aj-read', []);
      if (arr.indexOf(String(chId)) === -1 && arr.indexOf(Number(chId)) === -1) {
        arr.push(String(chId));
        lsSet('aj-read', arr.slice(-600));
      }
    }

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
