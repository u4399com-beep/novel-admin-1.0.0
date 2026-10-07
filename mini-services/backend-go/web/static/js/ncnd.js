/**
 * ncnd.js —— ncnd 主题交互（vanilla JS，零依赖，配合 app.js 公共阅读器）。
 * 1) 移动端抽屉菜单开合（点面板外/链接点击关闭，aria-expanded 同步）
 * 2) 章节页移动端上下 35% 点按翻页区（data-url 派发；仅触屏设备响应 click）
 */
(function () {
  'use strict';

  /* ---------- 抽屉菜单 ---------- */
  var menuBtn = document.getElementById('nc-menu-btn');
  var oc = document.getElementById('nc-offcanvas');
  if (menuBtn && oc) {
    var setOpen = function (open) {
      oc.hidden = !open;
      oc.classList.toggle('open', open);
      menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      document.body.style.overflow = open ? 'hidden' : '';
    };
    menuBtn.addEventListener('click', function () {
      setOpen(oc.hidden);
    });
    oc.addEventListener('click', function (e) {
      // 点遮罩（面板外）或面板内任意链接 → 关闭
      if (e.target === oc || e.target.closest && e.target.closest('a')) {
        setOpen(false);
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !oc.hidden) setOpen(false);
    });
  }

  /* ---------- 章节点按翻页区（仅触屏） ---------- */
  var zones = document.querySelectorAll('.nc-tapzone[data-url]');
  if (zones.length) {
    var isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    if (isTouch) {
      zones.forEach(function (z) {
        z.addEventListener('click', function () {
          var url = z.getAttribute('data-url');
          if (url) location.href = url;
        });
      });
    }
  }
})();
