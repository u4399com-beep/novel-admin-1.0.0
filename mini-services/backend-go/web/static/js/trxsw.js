/**
 * trxsw.js —— 唐人小说主题私有交互（vanilla JS，零依赖）。
 * 对应 React 版 useState/useEffect 的最小移植：
 * 1) 阅读记录弹层（localStorage reader.history，与 app.js 写入端共用）
 * 2) 书架（localStorage trxsw-shelf）/ 推荐票
 * 3) 阅读页键盘 ←/→ 翻章、恢复默认阅读偏好
 */
(function () {
  'use strict';

  function lsGet(k, d) {
    try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ }
  }

  /* ---------- 收藏本站 ---------- */
  document.querySelectorAll('[data-trx-favorite]').forEach(function (el) {
    el.addEventListener('click', function () {
      alert('按 Ctrl+D（Mac 为 Cmd+D）即可收藏本站。');
    });
  });

  /* ---------- 阅读记录弹层 ---------- */
  var histMask = document.getElementById('trx-history-mask');
  var histPanel = document.getElementById('trx-history-panel');
  var histList = document.getElementById('trx-history-list');
  function closeHistory() {
    histMask && histMask.classList.add('hidden');
    histPanel && histPanel.classList.add('hidden');
  }
  document.querySelectorAll('[data-trx-history]').forEach(function (el) {
    el.addEventListener('click', function () {
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
          var t = (r.bookTitle || '未知书名') + ' · ' + (r.title || '');
          return '<a class="flex items-center justify-between gap-2 border-b border-dotted border-[#a6d3e8] py-[4px] text-[#6f78a7] hover:text-[#FF6600]" href="/chapter/' + encodeURIComponent(r.chapterId) + '">' +
            '<span class="min-w-0 flex-1 truncate">' + t + '</span></a>';
        }).join('');
      }
      histMask && histMask.classList.remove('hidden');
      histPanel.classList.remove('hidden');
    });
  });
  document.querySelectorAll('[data-trx-history-close]').forEach(function (el) {
    el.addEventListener('click', closeHistory);
  });

  /* ---------- 书架 / 推荐票 ---------- */
  var SHELF_ON = 'cursor-pointer border px-4 py-1.5 text-sm transition-colors border-[#FF6600] bg-[#FFF3E8] text-[#E05A00]';
  var SHELF_OFF = 'cursor-pointer border px-4 py-1.5 text-sm transition-colors border-[#FF6600] text-[#FF6600] hover:bg-[#FFF3E8]';
  var shelfBtn = document.querySelector('[data-trx-shelf]');
  if (shelfBtn) {
    var nid = shelfBtn.getAttribute('data-novel-id');
    var load = function () {
      var arr = lsGet('trxsw-shelf', []);
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
      lsSet('trxsw-shelf', arr);
      sync();
    });
  }
  document.querySelectorAll('[data-trx-vote]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      btn.textContent = btn.textContent.indexOf('推荐') >= 0 ? '已推荐 +1' : btn.textContent;
    });
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
  var resetBtn = document.querySelector('[data-trx-reset-prefs]');
  if (resetBtn) resetBtn.addEventListener('click', function () {
    try { localStorage.removeItem('reader.fontScale'); localStorage.removeItem('reader.night'); } catch (e) { /* ignore */ }
    window.location.reload();
  });
})();
