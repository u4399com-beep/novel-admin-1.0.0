/**
 * ggd66.js —— 谷谷小说主题私有交互（vanilla JS，零依赖）。
 * 对应 React 版 useState/useEffect 的最小移植：
 * 1) 阅读记录弹层（localStorage reader.history，与 app.js 写入端共用）
 * 2) 收藏本站
 * 3) 章节书签（localStorage ggd66-marks-{novelId}）
 * 4) 阅读页键盘：Enter 返回书目 / ← 上一章 / → 下一章；恢复默认阅读偏好
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
  document.querySelectorAll('[data-gg-favorite]').forEach(function (el) {
    el.addEventListener('click', function () {
      alert('按 Ctrl+D（Mac 为 Cmd+D）即可收藏本站。');
    });
  });

  /* ---------- 阅读记录弹层 ---------- */
  var histMask = document.getElementById('gg-history-mask');
  var histPanel = document.getElementById('gg-history-panel');
  var histList = document.getElementById('gg-history-list');
  function closeHistory() {
    histMask && histMask.classList.add('hidden');
    histPanel && histPanel.classList.add('hidden');
  }
  document.querySelectorAll('[data-gg-history]').forEach(function (el) {
    el.addEventListener('click', function () {
      if (!histPanel || !histList) return;
      var h = lsGet('reader.history', {});
      var rows = [];
      for (var bid in h) {
        if (Object.prototype.hasOwnProperty.call(h, bid)) rows.push(h[bid]);
      }
      rows.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
      if (rows.length === 0) {
        histList.innerHTML = '<p class="py-6 text-center text-[13px] text-[#999]">暂无阅读记录，打开任意章节后自动记录</p>';
      } else {
        histList.innerHTML = rows.slice(0, 20).map(function (r) {
          var t = (r.bookTitle || '未知书名') + ' · ' + (r.title || '');
          return '<a class="flex h-[28px] items-center border-b border-dashed border-[#ccc] text-[#00886d] hover:text-[#f50]" href="/chapter/' + encodeURIComponent(r.chapterId) + '">' +
            '<span class="min-w-0 flex-1 truncate">' + t + '</span></a>';
        }).join('');
      }
      histMask && histMask.classList.remove('hidden');
      histPanel.classList.remove('hidden');
    });
  });
  document.querySelectorAll('[data-gg-history-close]').forEach(function (el) {
    el.addEventListener('click', closeHistory);
  });

  /* ---------- 章节书签（按书分组持久化） ---------- */
  var markBtn = document.querySelector('[data-gg-mark]');
  if (markBtn) {
    var nid = markBtn.getAttribute('data-novel-id');
    var cid = markBtn.getAttribute('data-chapter-id');
    var key = 'ggd66-marks-' + nid;
    var load = function () {
      var arr = lsGet(key, []);
      return Object.prototype.toString.call(arr) === '[object Array]' ? arr : [];
    };
    var sync = function () {
      var on = load().indexOf(String(cid)) >= 0;
      markBtn.textContent = on ? '已加入书签 ✓' : '加入书签';
    };
    sync();
    markBtn.addEventListener('click', function () {
      var arr = load();
      var i = arr.indexOf(String(cid));
      if (i >= 0) arr.splice(i, 1); else { arr.push(String(cid)); arr = arr.slice(-200); }
      lsSet(key, arr);
      sync();
    });
  }

  /* ---------- 阅读页：键盘 Enter/←/→ + 恢复默认 ---------- */
  var content = document.getElementById('fb-chapter-content');
  if (content) {
    document.addEventListener('keydown', function (e) {
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.tagName === 'BUTTON' || t.isContentEditable)) return;
      if (e.key === 'Enter') {
        window.location.href = '/book/' + encodeURIComponent(content.getAttribute('data-novel-id')) + '/toc';
      } else if (e.key === 'ArrowLeft' && content.getAttribute('data-prev-url')) {
        window.location.href = content.getAttribute('data-prev-url');
      } else if (e.key === 'ArrowRight' && content.getAttribute('data-next-url')) {
        window.location.href = content.getAttribute('data-next-url');
      }
    });
  }
  var resetBtn = document.querySelector('[data-gg-reset-prefs]');
  if (resetBtn) resetBtn.addEventListener('click', function () {
    try { localStorage.removeItem('reader.fontScale'); localStorage.removeItem('reader.night'); } catch (e) { /* ignore */ }
    window.location.reload();
  });
})();
