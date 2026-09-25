/**
 * admin-fleet.js —— 站群管理 tab 交互逻辑（Task 30-a「站群模式」，vanilla JS / 零依赖）。
 *
 * 独立文件（不碰 admin.js）：admin.html 仅插入式追加本脚本引用与 tab-sites 面板。
 * 职责：
 *   1. 站点列表加载/渲染（GET /api/sites，懒加载：首次切到本页签时拉取）
 *   2. 新建站点（POST /api/sites，host 前端预校验与后端正则同款）
 *   3. 编辑弹层（host/siteName/主题/公告/启用 + SEO/页脚/首页区块 JSON 高级形态 → PUT /api/sites/{id}）
 *   4. 删除站点（DELETE /api/sites/{id}，confirm 确认）
 *
 * XSS：所有动态拼 HTML 的用户数据必须过 escapeHtml()；静态部分由 html/template 转义。
 * 契约对照：api_sites.go（清洗复用 api_settings.go：sanitizeSeoConfig/sanitizeFooterConfig/sanitizeHomeConfig）。
 * data-act 全部带 fleet- 前缀且委托在 #adm-sites-tbody 局部——不与 admin.js 的全局委托冲突。
 */
(function () {
  'use strict';

  /* ==================== 工具（与 admin.js 同款，独立 IIFE 无法复用其私有函数） ==================== */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  async function api(method, url, body) {
    var opt = { method: method, headers: {} };
    if (body !== undefined && body !== null) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    var res;
    try {
      res = await fetch(url, opt);
    } catch (e) {
      throw new Error('网络请求失败（' + (e && e.message ? e.message : '未知错误') + '）');
    }
    if (res.status === 502) throw new Error('后端服务不可达（502），请确认 backend-go 是否在运行');
    var data = null;
    var text = await res.text();
    if (text) { try { data = JSON.parse(text); } catch (e) { /* 非 JSON 响应体 */ } }
    if (!res.ok) {
      var msg = data && (data.error || data.detail || data.message);
      throw new Error(msg || ('请求失败（HTTP ' + res.status + '）'));
    }
    return data;
  }

  function toast(msg, type) {
    var wrap = $('#adm-toast-wrap');
    if (!wrap) return;
    var el = document.createElement('div');
    el.className = 'adm-toast' + (type === 'ok' ? ' adm-toast-ok' : type === 'err' ? ' adm-toast-err' : '');
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(function () { el.remove(); }, type === 'err' ? 4200 : 3000);
  }

  function handleErr(e) { toast((e && e.message) ? e.message : '操作失败', 'err'); }

  function fmtTs(ms) {
    var n = Number(ms);
    if (!n || n <= 0) return '—';
    var d = new Date(n);
    function p(x) { return (x < 10 ? '0' : '') + x; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // 与 api_sites.go siteHostRe 同款：纯域名（≥两段），协议/路径/端口/通配符/下划线一律拒绝
  var HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

  function validHost(raw) {
    return HOST_RE.test(String(raw || '').trim().toLowerCase());
  }

  /** JSON 文本域 → 对象（空串 = {}；数组/标量拒绝，与后端白名单对象形态对齐） */
  function parseJsonTextarea(id) {
    var ta = $('#' + id);
    if (!ta) return {};
    var raw = ta.value.trim();
    if (!raw) return {};
    var v = JSON.parse(raw);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('内容必须是 JSON 对象');
    return v;
  }

  function formatJsonTextarea(id) {
    var ta = $('#' + id);
    if (!ta) return;
    try {
      var v = JSON.parse(ta.value.trim() || '{}');
      ta.value = JSON.stringify(v, null, 2);
      toast('JSON 已格式化', 'ok');
    } catch (e) {
      toast('JSON 无法解析：' + e.message, 'err');
    }
  }

  /* ==================== 站点列表 ==================== */

  var fleetLoaded = false;
  var sitesCache = [];

  function siteRowHtml(s) {
    return '<tr>' +
      '<td class="tabular-nums text-neutral-500">' + escapeHtml(s.id) + '</td>' +
      '<td class="adm-mono" title="' + escapeHtml(s.host) + '">' + escapeHtml(s.host) + '</td>' +
      '<td class="font-medium">' + escapeHtml(s.siteName) + '</td>' +
      '<td>' + escapeHtml(s.activeTheme) + '</td>' +
      '<td>' + (s.enabled ? '<span class="text-emerald-600">✓ 启用</span>' : '<span class="text-neutral-400">✗ 停用</span>') + '</td>' +
      '<td class="whitespace-nowrap text-[11px] text-neutral-400">' + escapeHtml(fmtTs(s.updatedAt)) + '</td>' +
      '<td class="whitespace-nowrap text-right">' +
        '<button type="button" class="adm-btn-xs" data-act="fleet-edit" data-id="' + escapeHtml(s.id) + '">编辑</button> ' +
        '<button type="button" class="adm-btn-xs adm-danger" data-act="fleet-del" data-id="' + escapeHtml(s.id) + '" data-host="' + escapeHtml(s.host) + '">删除</button>' +
      '</td></tr>';
  }

  function renderSites(rows) {
    var tbody = $('#adm-sites-tbody');
    if (!tbody) return;
    var count = $('#adm-site-count');
    if (count) count.textContent = rows.length;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="adm-empty">暂无站点档案——全部访问均走默认站点。在下方「新建站点」添加第一个站群站点。</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(siteRowHtml).join('');
  }

  async function loadSites(force) {
    if (fleetLoaded && !force) return;
    try {
      sitesCache = await api('GET', '/api/sites') || [];
      fleetLoaded = true;
      renderSites(sitesCache);
    } catch (e) { handleErr(e); }
  }

  /* ==================== 新建站点 ==================== */

  async function createSite() {
    var hostEl = $('#adm-site-host');
    var nameEl = $('#adm-site-name');
    var themeEl = $('#adm-site-theme');
    var noticeEl = $('#adm-site-notice');
    if (!hostEl || !nameEl) return;
    var host = hostEl.value.trim().toLowerCase();
    if (!validHost(host)) return toast('host 格式无效：纯域名（如 novel.example.com），不带协议/路径/端口', 'err');
    var siteName = nameEl.value.trim();
    if (!siteName) return toast('站点名称不能为空（≤50 字）', 'err');
    var body = { host: host, siteName: siteName };
    if (themeEl && themeEl.value) body.activeTheme = themeEl.value;
    if (noticeEl && noticeEl.value.trim()) body.notice = noticeEl.value;
    try {
      await api('POST', '/api/sites', body);
      toast('站点已创建：' + host + '（前台按 Host 命中后生效）', 'ok');
      hostEl.value = ''; nameEl.value = ''; if (noticeEl) noticeEl.value = '';
      loadSites(true);
    } catch (e) { handleErr(e); }
  }

  /* ==================== 编辑弹层 ==================== */

  var modalEl = null;

  function closeModal() {
    if (modalEl) { modalEl.remove(); modalEl = null; }
  }

  function themeOptions(selected) {
    // 主题下拉复用面板内服务端渲染的白名单（{{range .Themes}}），JS 不硬编码清单
    var sel = $('#adm-site-theme');
    if (!sel) return '<option value="' + escapeHtml(selected) + '">' + escapeHtml(selected) + '</option>';
    var opts = '';
    $all('option', sel).forEach(function (o) {
      opts += '<option value="' + escapeHtml(o.value) + '"' + (o.value === selected ? ' selected' : '') + '>' + escapeHtml(o.textContent) + '</option>';
    });
    return opts;
  }

  function jsonField(label, id, rows, value) {
    return '<div class="adm-field">' +
      '<div class="flex items-center justify-between"><span>' + escapeHtml(label) + '</span>' +
      '<button type="button" class="adm-btn-xs" data-act="fleet-fmt" data-target="' + id + '">格式化 JSON</button></div>' +
      '<textarea id="' + id + '" class="adm-input adm-mono mt-1" rows="' + rows + '">' + escapeHtml(JSON.stringify(value || {}, null, 2)) + '</textarea>' +
      '</div>';
  }

  function openSiteModal(site) {
    closeModal();
    modalEl = document.createElement('div');
    modalEl.className = 'fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4';
    modalEl.innerHTML =
      '<div class="adm-card my-8 w-full max-w-2xl !mb-0">' +
        '<div class="flex items-center justify-between"><h2 class="adm-h2 !mb-0">编辑站点 #' + escapeHtml(site.id) + '</h2>' +
        '<button type="button" class="adm-btn-xs" data-act="fleet-close">关闭 ✕</button></div>' +
        '<p class="mb-3 text-[11px] text-neutral-400">host 改名即时生效（需 DNS/反代配合）；SEO/页脚/首页区块为 JSON 高级形态，保存时后端按「站点设置」同款白名单清洗。</p>' +
        '<div class="grid gap-x-4 gap-y-2 sm:grid-cols-2">' +
          '<label class="adm-field">Host *<input id="adm-site-e-host" class="adm-input adm-mono" value="' + escapeHtml(site.host) + '"></label>' +
          '<label class="adm-field">站点名称 *（≤50 字）<input id="adm-site-e-name" class="adm-input" value="' + escapeHtml(site.siteName) + '"></label>' +
          '<label class="adm-field">主题<select id="adm-site-e-theme" class="adm-input">' + themeOptions(site.activeTheme) + '</select></label>' +
          '<div class="flex items-center gap-4 pt-1">' +
            '<label class="flex items-center gap-1.5"><input type="checkbox" id="adm-site-e-enabled"' + (site.enabled ? ' checked' : '') + '> 启用（停用立即回落默认站点）</label>' +
          '</div>' +
        '</div>' +
        '<label class="adm-field mt-2 block">站点公告<textarea id="adm-site-e-notice" class="adm-input" rows="2">' + escapeHtml(site.notice || '') + '</textarea></label>' +
        jsonField('SEO 配置 seoConfig（TDK/keywords 模板，变量 {siteName} 等）', 'adm-site-e-seo', 8, site.seo) +
        jsonField('页脚配置 footerConfig（text/extra/links）', 'adm-site-e-footer', 5, site.footer) +
        jsonField('首页区块 homeConfig（blocks）', 'adm-site-e-home', 5, site.home) +
        '<div class="mt-3 flex justify-end gap-2">' +
          '<button type="button" class="adm-btn" data-act="fleet-close">取消</button>' +
          '<button type="button" class="adm-btn adm-btn-primary" data-act="fleet-save" data-id="' + escapeHtml(site.id) + '">保存站点</button>' +
        '</div>' +
      '</div>';
    modalEl.addEventListener('click', function (e) {
      if (e.target === modalEl) closeModal(); // 点遮罩关闭
    });
    document.body.appendChild(modalEl);
  }

  async function saveSite(id) {
    var host = $('#adm-site-e-host').value.trim().toLowerCase();
    if (!validHost(host)) return toast('host 格式无效：纯域名（如 novel.example.com），不带协议/路径/端口', 'err');
    var siteName = $('#adm-site-e-name').value.trim();
    if (!siteName) return toast('站点名称不能为空（≤50 字）', 'err');
    var body;
    try {
      body = {
        host: host,
        siteName: siteName,
        activeTheme: $('#adm-site-e-theme').value,
        notice: $('#adm-site-e-notice').value,
        enabled: $('#adm-site-e-enabled').checked,
        seo: parseJsonTextarea('adm-site-e-seo'),
        footer: parseJsonTextarea('adm-site-e-footer'),
        home: parseJsonTextarea('adm-site-e-home')
      };
    } catch (e) {
      return toast('JSON 无效：' + e.message, 'err');
    }
    var btn = modalEl && modalEl.querySelector('[data-act="fleet-save"]');
    if (btn) btn.disabled = true;
    try {
      await api('PUT', '/api/sites/' + encodeURIComponent(id), body);
      toast('站点 #' + id + ' 已保存（前台按 Host 命中后生效）', 'ok');
      closeModal();
      loadSites(true);
    } catch (e) {
      if (btn) btn.disabled = false;
      handleErr(e);
    }
  }

  /* ==================== 事件挂接 ==================== */

  function init() {
    var tabs = $('#adm-tabs');
    if (tabs) {
      // 站群 tab 懒加载（admin.js 负责显隐切换，这里只负责拉数据）
      tabs.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-tab]');
        if (btn && btn.dataset.tab === 'sites') loadSites(false);
      });
    }
    var refresh = $('#adm-site-refresh');
    if (refresh) refresh.addEventListener('click', function () { loadSites(true); });
    var create = $('#adm-site-create');
    if (create) create.addEventListener('click', createSite);

    // 行内操作 + 弹层操作（局部委托，fleet- 前缀不与 admin.js 全局委托冲突）
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act^="fleet-"]');
      if (!btn || btn.disabled) return;
      var act = btn.dataset.act;
      var id = btn.dataset.id;
      if (act === 'fleet-edit') {
        var hit = null;
        for (var i = 0; i < sitesCache.length; i++) {
          if (Number(sitesCache[i].id) === Number(id)) { hit = sitesCache[i]; break; }
        }
        if (!hit) { loadSites(true); return toast('站点不存在或已删除，列表已刷新', 'err'); }
        openSiteModal(hit);
      } else if (act === 'fleet-del') {
        if (!window.confirm('确认删除站点「' + btn.dataset.host + '」？该 Host 将立即回落默认站点。')) return;
        api('DELETE', '/api/sites/' + encodeURIComponent(id))
          .then(function () { toast('站点已删除', 'ok'); loadSites(true); })
          .catch(handleErr);
      } else if (act === 'fleet-fmt') {
        formatJsonTextarea(btn.dataset.target);
      } else if (act === 'fleet-close') {
        closeModal();
      } else if (act === 'fleet-save') {
        saveSite(id);
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeModal();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
