/**
 * 23qb.js —— 铅笔小说主题私有交互（vanilla JS，零依赖）。
 * 对应 React 版 useState/useEffect 的最小移植：
 * 1) 固定顶栏滚动换肤（首页悬浮透明 → 毛玻璃）
 * 2) 「全部分类」下拉（点击外部关闭）+ 移动端抽屉
 * 3) 阅读记录弹层（localStorage reader.history，与 app.js 写入端共用）
 * 4) 书架（23qb.shelf）/ 推荐票 / 章节书签（23qb.bookmarks）
 * 5) 阅读页键盘 ←/→ 翻章、恢复默认阅读偏好
 */
(function () {
  'use strict';

  function lsGet(k, d) {
    try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ }
  }

  /* ---------- 顶栏滚动换肤 ---------- */
  var SOLID = 'bg-[#eaedf1]/95 shadow-[0_2px_12px_rgba(149,157,165,.18)] backdrop-blur-[10px]';
  var CLEAR = 'bg-transparent';
  var header = document.querySelector('[data-qb-header]');
  if (header && header.getAttribute('data-qb-home') === '1') {
    var sync = function () {
      if (window.scrollY > 20) {
        header.classList.remove(CLEAR); header.classList.add(SOLID);
      } else {
        header.classList.add(CLEAR); header.classList.remove(SOLID);
      }
    };
    sync();
    window.addEventListener('scroll', sync, { passive: true });
  }

  /* ---------- 全部分类下拉 ---------- */
  var allBtn = document.querySelector('[data-qb-allcat]');
  var allPanel = document.getElementById('qb-allcat-panel');
  var allBox = document.getElementById('qb-allcat-box');
  if (allBtn && allPanel) {
    var closeAll = function () { allPanel.classList.add('hidden'); allBtn.setAttribute('aria-expanded', 'false'); };
    allBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var hidden = allPanel.classList.toggle('hidden');
      allBtn.setAttribute('aria-expanded', hidden ? 'false' : 'true');
    });
    document.addEventListener('mousedown', function (e) {
      if (allBox && !allBox.contains(e.target)) closeAll();
    });
    allPanel.addEventListener('click', function (e) {
      if (e.target && e.target.tagName === 'A') closeAll();
    });
  }

  /* ---------- 移动端抽屉 ---------- */
  var drawer = document.getElementById('qb-drawer');
  var openBtn = document.querySelector('[data-qb-drawer-open]');
  if (drawer && openBtn) {
    openBtn.addEventListener('click', function () { drawer.classList.remove('hidden'); });
    drawer.querySelectorAll('[data-qb-drawer-close]').forEach(function (el) {
      el.addEventListener('click', function () { drawer.classList.add('hidden'); });
    });
  }

  /* ---------- 收藏本站 ---------- */
  document.querySelectorAll('[data-qb-favorite]').forEach(function (el) {
    el.addEventListener('click', function () {
      alert('按 Ctrl+D（Mac 为 Cmd+D）即可收藏本站。');
    });
  });

  /* ---------- 阅读记录弹层 ---------- */
  var histMask = document.getElementById('qb-history-mask');
  var histPanel = document.getElementById('qb-history-panel');
  var histList = document.getElementById('qb-history-list');
  function closeHistory() {
    histMask && histMask.classList.add('hidden');
    histPanel && histPanel.classList.add('hidden');
  }
  document.querySelectorAll('[data-qb-history]').forEach(function (el) {
    el.addEventListener('click', function () {
      if (!histPanel || !histList) return;
      var h = lsGet('reader.history', {});
      var rows = [];
      for (var bid in h) {
        if (Object.prototype.hasOwnProperty.call(h, bid)) rows.push(h[bid]);
      }
      rows.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
      if (rows.length === 0) {
        histList.innerHTML = '<p class="py-6 text-center text-sm text-black/40">暂无阅读记录，打开任意章节后自动记录</p>';
      } else {
        histList.innerHTML = rows.slice(0, 20).map(function (r) {
          var t = (r.bookTitle || '未知书名') + ' · ' + (r.title || '');
          return '<a class="flex h-10 w-full cursor-pointer items-center gap-2 rounded-[10px] px-3 text-left text-sm text-[#282828] transition-colors hover:bg-white hover:text-[#ff2a14]" href="/chapter/' + encodeURIComponent(r.chapterId) + '">' +
            '<span class="flex-1 truncate">' + t + '</span></a>';
        }).join('');
      }
      histMask && histMask.classList.remove('hidden');
      histPanel.classList.remove('hidden');
    });
  });
  document.querySelectorAll('[data-qb-history-close]').forEach(function (el) {
    el.addEventListener('click', closeHistory);
  });

  /* ---------- 书架 / 推荐票 ---------- */
  var SHELF_ON = 'inline-flex h-10 cursor-pointer items-center justify-center gap-1.5 rounded-[50px] border border-[#ff2a14] bg-white px-6 text-sm font-medium text-[#ff2a14] transition-all';
  var SHELF_OFF = 'inline-flex h-10 cursor-pointer items-center justify-center gap-1.5 rounded-[50px] border border-black/15 bg-white px-6 text-sm font-medium text-[#282828] transition-all hover:border-[#ff2a14] hover:text-[#ff2a14]';
  var shelfBtn = document.querySelector('[data-qb-shelf]');
  if (shelfBtn) {
    var nid = shelfBtn.getAttribute('data-novel-id');
    var load = function () {
      var arr = lsGet('23qb.shelf', []);
      return Object.prototype.toString.call(arr) === '[object Array]' ? arr : [];
    };
    var sync = function () {
      var on = load().indexOf(String(nid)) >= 0;
      shelfBtn.className = on ? SHELF_ON : SHELF_OFF;
      shelfBtn.innerHTML = on ? '已在书架' : '收藏';
    };
    sync();
    shelfBtn.addEventListener('click', function () {
      var arr = load();
      var i = arr.indexOf(String(nid));
      if (i >= 0) arr.splice(i, 1); else arr.push(String(nid));
      lsSet('23qb.shelf', arr);
      sync();
    });
  }
  var voteBtn = document.querySelector('[data-qb-vote]');
  if (voteBtn) voteBtn.addEventListener('click', function () {
    voteBtn.textContent = '已推荐 · 感谢支持';
  });

  /* ---------- 章节书签 ---------- */
  var bmBtn = document.getElementById('qb-bookmark');
  if (bmBtn) {
    bmBtn.addEventListener('click', function () {
      var rec = {
        chapterId: bmBtn.getAttribute('data-chapter-id'),
        title: bmBtn.getAttribute('data-chapter-title') || '',
      };
      var all = lsGet('23qb.bookmarks', {});
      all[String(bmBtn.getAttribute('data-novel-id'))] = rec;
      lsSet('23qb.bookmarks', all);
      bmBtn.textContent = '已存书签';
      window.setTimeout(function () { bmBtn.textContent = '书签'; }, 1600);
    });
  }

  /* ---------- 阅读页：键盘 ←/→ 翻章 + 恢复默认 ---------- */
  var content = document.getElementById('fb-chapter-content');
  if (content) {
    document.addEventListener('keydown', function (e) {
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.tagName === 'BUTTON' || t.isContentEditable)) return;
      if (e.key === 'ArrowLeft' && content.getAttribute('data-prev-url')) {
        window.location.href = content.getAttribute('data-prev-url');
      } else if (e.key === 'ArrowRight' && content.getAttribute('data-next-url')) {
        window.location.href = content.getAttribute('data-next-url');
      }
    });
  }
  var resetBtn = document.querySelector('[data-qb-reset-prefs]');
  if (resetBtn) resetBtn.addEventListener('click', function () {
    try { localStorage.removeItem('reader.fontScale'); localStorage.removeItem('reader.night'); } catch (e) { /* ignore */ }
    window.location.reload();
  });
})();
