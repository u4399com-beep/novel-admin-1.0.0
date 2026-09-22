/**
 * app.js —— 全 Go 页面公共交互（ vanilla JS，零依赖）。
 * 1) 阅读器字号调节 / 夜间模式（localStorage 持久化）
 * 2) 继续阅读记录：chapter 页写入，book 页显示"继续阅读"按钮
 * 3) 返回顶部
 */
(function () {
  'use strict';

  var LS_FONT = 'reader.fontScale';
  var LS_NIGHT = 'reader.night';
  var LS_HISTORY = 'reader.history'; // {bookId: {chapterId, chapterIdx, title, bookTitle, ts}}

  function lsGet(k, d) {
    try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ }
  }

  /* ---------- 阅读器：字号 ---------- */
  var content = document.getElementById('fb-chapter-content');
  if (content) {
    var scale = parseFloat(lsGet(LS_FONT, '1')) || 1;
    scale = Math.min(1.6, Math.max(0.8, scale));

    function applyScale() {
      content.style.fontSize = (17 * scale) + 'px';
      content.style.lineHeight = '1.9';
    }
    applyScale();

    var dec = document.getElementById('fb-font-dec');
    var inc = document.getElementById('fb-font-inc');
    if (dec) dec.addEventListener('click', function () { scale = Math.max(0.8, scale - 0.1); applyScale(); lsSet(LS_FONT, scale); });
    if (inc) inc.addEventListener('click', function () { scale = Math.min(1.6, scale + 0.1); applyScale(); lsSet(LS_FONT, scale); });

    /* ---------- 夜间模式 ---------- */
    function applyNight(on) {
      if (on) {
        document.documentElement.style.background = '#111';
        content.style.background = '#111';
        content.style.color = '#b8b8b8';
      } else {
        document.documentElement.style.background = '';
        content.style.background = '';
        content.style.color = '';
      }
      var btn = document.getElementById('fb-night');
      if (btn) btn.textContent = on ? '日间模式' : '夜间模式';
    }
    var night = lsGet(LS_NIGHT, false) === true;
    applyNight(night);
    var nightBtn = document.getElementById('fb-night');
    if (nightBtn) nightBtn.addEventListener('click', function () {
      night = !night;
      lsSet(LS_NIGHT, night);
      applyNight(night);
    });

    /* ---------- 继续阅读记录 ---------- */
    var novelId = content.getAttribute('data-novel-id');
    var chapterIdx = content.getAttribute('data-chapter-idx');
    var chapterTitle = content.getAttribute('data-chapter-title');
    if (novelId && chapterIdx) {
      var h = lsGet(LS_HISTORY, {});
      h[String(novelId)] = {
        chapterId: location.pathname.replace('/chapter/', ''),
        chapterIdx: parseInt(chapterIdx, 10) || 0,
        title: chapterTitle || '',
        bookTitle: (document.title || '').split(' ')[0],
        ts: Date.now()
      };
      lsSet(LS_HISTORY, h);
    }
  }

  /* ---------- book 页：继续阅读按钮 ---------- */
  var resumeBox = document.getElementById('fb-resume');
  if (resumeBox) {
    var bid = resumeBox.getAttribute('data-book-id');
    var h2 = lsGet(LS_HISTORY, {});
    var rec = h2[String(bid)];
    if (rec && rec.chapterId) {
      var a = document.createElement('a');
      a.href = '/chapter/' + rec.chapterId;
      a.className = resumeBox.getAttribute('data-btn-class') || 'fb-pager-btn';
      a.textContent = '继续阅读：' + (rec.title || '上次章节');
      resumeBox.appendChild(a);
    }
  }

  /* ---------- 返回顶部 ---------- */
  var toTop = document.getElementById('fb-totop');
  if (!toTop) {
    toTop = document.createElement('button');
    toTop.id = 'fb-totop';
    toTop.textContent = '↑ 顶部';
    toTop.setAttribute('aria-label', '返回顶部');
    toTop.style.cssText = 'position:fixed;right:16px;bottom:20px;padding:8px 14px;border-radius:999px;border:1px solid #d4d4d4;background:#fff;color:#404040;cursor:pointer;display:none;z-index:50;box-shadow:0 2px 8px rgba(0,0,0,.08)';
    document.body.appendChild(toTop);
  }
  window.addEventListener('scroll', function () {
    toTop.style.display = window.scrollY > 400 ? 'block' : 'none';
  }, { passive: true });
  toTop.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });
})();
