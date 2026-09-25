/**
 * pilishuwu.js —— 飞速小说主题私有交互（vanilla JS，零依赖）。
 * 对应 React 版 useState/useEffect 的最小移植：
 * 1) 欢迎条日期客户端填充 + 设为首页/收藏本站
 * 2) 阅读记录弹层（localStorage reader.history，与 app.js 写入端共用）
 * 3) 首页排行榜三标签切换（点击/更新/完本）
 * 4) 书架（localStorage pls-shelf）/ 投推荐票
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

  /* Task 36-b: 阅读记录含采集来的书名/章题（不可信输入），拼 HTML 前必须转义 */
  function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------- 欢迎条日期（React 版为 effect 客户端填充） ---------- */
  var dateEl = document.getElementById('pls-date');
  if (dateEl) {
    try {
      dateEl.textContent = new Date().toLocaleDateString('zh-CN', {
        year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
      });
    } catch (e) { /* ignore */ }
  }

  /* ---------- 设为首页 / 收藏本站 ---------- */
  var hp = document.querySelector('[data-pls-homepage]');
  if (hp) hp.addEventListener('click', function () {
    alert('请在浏览器菜单中选择「设为主页 / 主页设置」，将本站地址设为浏览器主页。');
  });
  document.querySelectorAll('[data-pls-favorite]').forEach(function (el) {
    el.addEventListener('click', function () {
      alert('按 Ctrl+D（Mac 为 Cmd+D）即可收藏本站。');
    });
  });

  /* ---------- 阅读记录弹层 ---------- */
  var histMask = document.getElementById('pls-history-mask');
  var histPanel = document.getElementById('pls-history-panel');
  var histList = document.getElementById('pls-history-list');
  function closeHistory() {
    if (histMask) histMask.classList.add('hidden');
    if (histPanel) histPanel.classList.add('hidden');
  }
  function openHistory() {
    if (!histPanel || !histList) return;
    var h = lsGet('reader.history', {});
    var rows = [];
    for (var bid in h) {
      if (Object.prototype.hasOwnProperty.call(h, bid)) rows.push(h[bid]);
    }
    rows.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    if (rows.length === 0) {
      histList.innerHTML = '<p class="py-6 text-center text-xs text-[#999]">暂无阅读记录，打开任意章节后自动记录</p>';
    } else {
      histList.innerHTML = rows.slice(0, 20).map(function (r) {
        var t = escapeHtml(r.bookTitle || '未知书名') + ' · ' + escapeHtml(r.title || '');
        return '<a class="flex items-center justify-between gap-2 border-b border-dotted border-[#DCE9F5] py-[5px] text-[#3366BB] hover:text-[#FF6600]" href="/chapter/' + encodeURIComponent(r.chapterId) + '">' +
          '<span class="min-w-0 flex-1 truncate">' + t + '</span></a>';
      }).join('');
    }
    histMask && histMask.classList.remove('hidden');
    histPanel.classList.remove('hidden');
  }
  document.querySelectorAll('[data-pls-history]').forEach(function (el) {
    el.addEventListener('click', openHistory);
  });
  document.querySelectorAll('[data-pls-history-close]').forEach(function (el) {
    el.addEventListener('click', closeHistory);
  });

  /* ---------- 首页排行榜三标签 ---------- */
  var TAB_ON = 'flex-1 cursor-pointer py-1 text-center transition-colors bg-[#3B76A8] font-bold text-white';
  var TAB_OFF = 'flex-1 cursor-pointer py-1 text-center transition-colors bg-[#F7FBFF] text-[#3366BB] hover:bg-[#EAF3FB]';
  var tabsBox = document.querySelector('[data-pls-tabs]');
  if (tabsBox) {
    var tabs = tabsBox.querySelectorAll('[data-pls-tab]');
    tabs.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var key = btn.getAttribute('data-pls-tab');
        tabs.forEach(function (b) {
          b.className = b === btn ? TAB_ON : TAB_OFF;
        });
        document.querySelectorAll('[data-pls-rank-panel]').forEach(function (p) {
          if (p.getAttribute('data-pls-rank-panel') === key) p.classList.remove('hidden');
          else p.classList.add('hidden');
        });
      });
    });
  }

  /* ---------- 书架 / 投推荐票 ---------- */
  var SHELF_ON = 'cursor-pointer border px-4 py-1.5 text-sm transition-colors border-[#3B76A8] bg-[#EAF3FB] text-[#2F5E8C]';
  var SHELF_OFF = 'cursor-pointer border px-4 py-1.5 text-sm transition-colors border-[#BFD8EA] text-[#3366BB] hover:border-[#FF6600] hover:text-[#FF6600]';
  var shelfBtn = document.querySelector('[data-pls-shelf]');
  if (shelfBtn) {
    var nid = shelfBtn.getAttribute('data-novel-id');
    var load = function () {
      var arr = lsGet('pls-shelf', []);
      return Object.prototype.toString.call(arr) === '[object Array]' ? arr : [];
    };
    var sync = function () {
      var on = load().indexOf(String(nid)) >= 0;
      shelfBtn.className = on ? SHELF_ON : SHELF_OFF;
      shelfBtn.textContent = on ? '已在书架 ✓' : '加入书架';
    };
    sync();
    shelfBtn.addEventListener('click', function () {
      var arr = load();
      var i = arr.indexOf(String(nid));
      if (i >= 0) arr.splice(i, 1); else arr.push(String(nid));
      lsSet('pls-shelf', arr);
      sync();
    });
  }
  var voteBtn = document.querySelector('[data-pls-vote]');
  if (voteBtn) voteBtn.addEventListener('click', function () {
    voteBtn.textContent = '已投推荐票 +1';
  });

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
  var resetBtn = document.querySelector('[data-pls-reset-prefs]');
  if (resetBtn) resetBtn.addEventListener('click', function () {
    try { localStorage.removeItem('reader.fontScale'); localStorage.removeItem('reader.night'); } catch (e) { /* ignore */ }
    window.location.reload();
  });

  /* ---------- 页脚回到顶部 ---------- */
  var toTop = document.querySelector('[data-pls-totop]');
  if (toTop) toTop.addEventListener('click', function () {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
})();
