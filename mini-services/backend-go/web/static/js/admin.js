/**
 * admin.js —— 管理后台交互逻辑（vanilla JS / ES6，零依赖）。
 *
 * 服务端渲染初始数据（web/templates/admin/admin.html），本文件负责：
 * 1. 顶部 tab 切换（原生 display 切换）
 * 2. fetch 封装 api()：502 后端不可达提示 + 非 2xx 读 JSON error/detail → toast
 * 3. 轻量 toast（右下角）
 * 4. 七个 tab 的全部交互：总览健康探测 / 规则 CRUD / 任务生命周期（状态机控件 +
 *    行展开日志与编辑 + 10s 可见轮询）/ 书籍搜索分页删除 / 分类 CRUD+智能归并 /
 *    PSEO 搜索生成删除 / 站点设置（基础+页脚 JSON+SEO JSON+homeConfig 区块编辑器）
 *
 * XSS：所有动态拼 HTML 的用户数据必须过 escapeHtml()；静态部分由 html/template 转义。
 * 契约对照：api_scrape_rules.go / api_scrape_tasks.go / api_novels.go / api_categories.go /
 *           api_categories_merge.go / api_pseo.go / api_settings.go / api_health.go
 */
(function () {
  'use strict';

  /* ==================== 工具 ==================== */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** fetch 封装：502 → 后端不可达；非 2xx → 读 JSON error/detail 抛错；成功返回解析后的 JSON */
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
    el.textContent = msg; // textContent 防二次注入
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

  function fmtWords(n) {
    var v = Number(n) || 0;
    if (v >= 10000) {
      var w = (v / 10000).toFixed(1).replace(/\.0$/, '');
      return w + '万字';
    }
    return v + '字';
  }

  function fmtIso(s) { // ISO 字符串（pseo 列表 updatedAt）→ 日期部分
    if (!s || typeof s !== 'string') return '—';
    return s.slice(0, 10);
  }

  function busyKey(act, id) { return act + ':' + id; }

  /* ==================== 状态常量（与模板 admBadge 定义保持一致） ==================== */

  var STATUS_CLS = {
    pending: 'adm-badge-neutral', running: 'adm-badge-run', paused: 'adm-badge-warn',
    success: 'adm-badge-ok', partial: 'adm-badge-partial', failed: 'adm-badge-bad', canceled: 'adm-badge-gray'
  };
  var STATUS_LABEL = {
    pending: '待执行', running: '执行中', paused: '已暂停', success: '成功',
    partial: '部分成功', failed: '失败', canceled: '已取消'
  };
  /** 可编辑状态：除执行中外全部可改参数（终态改完可重启重采） */
  var EDITABLE = ['pending', 'paused', 'failed', 'partial', 'canceled', 'success'];
  /** 可停止/取消状态 */
  var CANCELABLE = ['pending', 'running', 'paused'];
  /** 可重启状态：终态 → 进度清零重新入队 */
  var RESTARTABLE = ['failed', 'partial', 'canceled', 'success'];

  function inArr(arr, v) { return arr.indexOf(v) !== -1; }

  function badgeHtml(status) {
    var cls = STATUS_CLS[status] || 'adm-badge-neutral';
    var label = STATUS_LABEL[status] || status;
    return '<span class="adm-badge ' + cls + '">' + escapeHtml(label) + '</span>';
  }

  /* ==================== Tab 切换 ==================== */

  var currentTab = 'overview';
  var settingsLoaded = false;

  function switchTab(name) {
    currentTab = name;
    $all('.adm-tab').forEach(function (b) {
      b.classList.toggle('adm-tab-on', b.dataset.tab === name);
    });
    $all('.adm-panel').forEach(function (p) {
      p.classList.toggle('hidden', p.id !== 'tab-' + name);
    });
    if (name === 'settings' && !settingsLoaded) loadSettingsData();
  }

  function initTabs() {
    $('#adm-tabs').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-tab]');
      if (btn) switchTab(btn.dataset.tab);
    });
  }

  /* ==================== 总览：健康探测 ==================== */

  async function checkHealth() {
    var pill = $('#adm-health');
    var detail = $('#adm-health-detail');
    try {
      var h = await api('GET', '/api/health');
      var dot = function (ok) { return ok ? '✅' : '❌'; };
      if (pill) {
        pill.textContent = h.ok && h.dbOk ? '后端正常 · DB 正常' : (h.ok ? '后端正常 · DB 异常' : '后端异常');
        pill.style.background = h.ok && h.dbOk ? '#065f46' : '#991b1b';
      }
      if (detail) {
        detail.innerHTML =
          '<span>' + dot(h.ok) + ' 后端服务 <b>' + escapeHtml(h.service || 'backend-go') + '</b>：ok=' + escapeHtml(h.ok) + '</span>' +
          '<span>' + dot(h.dbOk) + ' 数据库：dbOk=' + escapeHtml(h.dbOk) + '</span>' +
          '<span class="text-neutral-400">' + escapeHtml(h.db || '') + '</span>';
      }
    } catch (e) {
      if (pill) { pill.textContent = '后端不可达'; pill.style.background = '#991b1b'; }
      if (detail) detail.innerHTML = '<span class="text-red-600">❌ ' + escapeHtml(e.message) + '</span>';
    }
  }

  /* ==================== 采集规则 ==================== */

  var rulesCache = [];

  function ruleName(ruleId) {
    if (ruleId === null || ruleId === undefined || ruleId === '') return '';
    var id = Number(ruleId);
    for (var i = 0; i < rulesCache.length; i++) {
      if (Number(rulesCache[i].id) === id) return rulesCache[i].name || ('规则#' + id);
    }
    return '规则#' + id;
  }

  function renderRules(rows) {
    var tbody = $('#adm-rules-tbody');
    if (!tbody) return;
    $('#adm-rule-count').textContent = rows.length;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="adm-empty">暂无规则，点击「新建规则」创建</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(function (r) {
      return '<tr>' +
        '<td class="tabular-nums text-neutral-500">' + escapeHtml(r.id) + '</td>' +
        '<td class="font-medium">' + escapeHtml(r.name) + '</td>' +
        '<td class="adm-cell-url" title="' + escapeHtml(r.siteUrl) + '">' + escapeHtml(r.siteUrl) + '</td>' +
        '<td>' + (r.enabled ? '<span class="text-emerald-600">✓</span>' : '<span class="text-neutral-400">✗</span>') + '</td>' +
        '<td>' + escapeHtml(r.charset) + '</td>' +
        '<td class="adm-cell-url">' + (r.proxy ? escapeHtml(r.proxy) : '<span class="text-neutral-300">—</span>') + '</td>' +
        '<td>' + (r.insecureTLS ? '<span class="text-amber-600">✓</span>' : '<span class="text-neutral-300">—</span>') + '</td>' +
        '<td class="adm-cell-note" title="' + escapeHtml(r.notes) + '">' + escapeHtml(r.notes) + '</td>' +
        '<td class="whitespace-nowrap text-right">' +
          '<button type="button" class="adm-btn-xs" data-act="rule-edit" data-id="' + escapeHtml(r.id) + '">编辑</button> ' +
          '<button type="button" class="adm-btn-xs adm-danger" data-act="rule-del" data-id="' + escapeHtml(r.id) + '" data-name="' + escapeHtml(r.name) + '">删除</button>' +
        '</td></tr>';
    }).join('');
  }

  async function refreshRules(silent) {
    try {
      rulesCache = await api('GET', '/api/scrape-rules') || [];
      renderRules(rulesCache);
      rebuildRuleSelects();
    } catch (e) { if (!silent) handleErr(e); }
  }

  function rebuildRuleSelects() {
    var sel = $('#adm-new-rule');
    if (sel) {
      var cur = sel.value;
      sel.innerHTML = '<option value="">不使用规则</option>' + rulesCache.map(function (r) {
        return '<option value="' + escapeHtml(r.id) + '">' + escapeHtml(r.name) + '</option>';
      }).join('');
      sel.value = cur;
      if (sel.value !== cur) sel.value = '';
    }
  }

  function showRuleForm(initial) {
    var card = $('#adm-rule-form-card');
    $('#adm-rule-form-title').textContent = initial ? ('编辑采集规则 #' + initial.id) : '新建采集规则';
    $('#adm-rule-id').value = initial ? initial.id : '';
    $('#adm-rule-name').value = initial ? (initial.name || '') : '';
    $('#adm-rule-url').value = initial ? (initial.siteUrl || '') : '';
    $('#adm-rule-charset').value = initial ? (initial.charset || 'utf-8') : 'utf-8';
    $('#adm-rule-proxy').value = initial ? (initial.proxy || '') : '';
    $('#adm-rule-enabled').checked = initial ? initial.enabled !== false : true;
    $('#adm-rule-insecure').checked = initial ? initial.insecureTLS === true : false;
    $('#adm-rule-notes').value = initial ? (initial.notes || '') : '';
    $('#adm-rule-list').value = initial ? JSON.stringify(initial.listRule || {}, null, 2) : '{}';
    $('#adm-rule-book').value = initial ? JSON.stringify(initial.bookRule || {}, null, 2) : '{}';
    $('#adm-rule-chapter').value = initial ? JSON.stringify(initial.chapterRule || {}, null, 2) : '{}';
    card.classList.remove('hidden');
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function hideRuleForm() { $('#adm-rule-form-card').classList.add('hidden'); }

  async function saveRuleForm() {
    var idVal = $('#adm-rule-id').value;
    var name = $('#adm-rule-name').value.trim();
    var siteUrl = $('#adm-rule-url').value.trim();
    if (!name) return toast('规则名称必填', 'err');
    if (!siteUrl) return toast('站点 URL 必填', 'err');
    try { var u = new URL(siteUrl); if (u.protocol !== 'http:' && u.protocol !== 'https:') throw 0; }
    catch (e) { return toast('站点 URL 格式不正确（仅支持 http/https）', 'err'); }
    var proxy = $('#adm-rule-proxy').value.trim();

    function parseRule(taId) {
      var raw = $('#' + taId).value.trim();
      if (!raw) return {};
      var v = JSON.parse(raw); // 语法错误向上抛
      if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error(taId + ' 的内容必须是 JSON 对象');
      return v;
    }
    var listRule, bookRule, chapterRule;
    try {
      listRule = parseRule('adm-rule-list');
      bookRule = parseRule('adm-rule-book');
      chapterRule = parseRule('adm-rule-chapter');
    } catch (e) {
      return toast('规则 JSON 无效：' + (e && e.message ? e.message : '请检查语法'), 'err');
    }

    var body = {
      name: name, siteUrl: siteUrl, enabled: $('#adm-rule-enabled').checked,
      charset: $('#adm-rule-charset').value, proxy: proxy,
      insecureTLS: $('#adm-rule-insecure').checked, notes: $('#adm-rule-notes').value,
      listRule: listRule, bookRule: bookRule, chapterRule: chapterRule
    };
    if (idVal) body.id = Number(idVal); // PUT 传完整对象含 id
    try {
      await api(idVal ? 'PUT' : 'POST', '/api/scrape-rules', body);
      toast(idVal ? '规则已保存' : '规则已创建', 'ok');
      hideRuleForm();
      refreshRules();
    } catch (e) { handleErr(e); }
  }

  /* ==================== 采集任务 ==================== */

  var TASK_PAGE_SIZE = 20;
  var tasksPage = 1;
  var tasksTotalPages = 1;
  var tasksTotal = 0;
  var busy = {}; // 防重复提交：{ "act:id": true }

  function taskRowHtml(t) {
    var ruleIdAttr = (t.ruleId === null || t.ruleId === undefined) ? '' : String(t.ruleId);
    var st = t.status;
    var btns = '<button type="button" class="adm-btn-xs" data-act="task-log" data-id="' + t.id + '" title="查看日志">日志</button>';
    if (st === 'running') {
      btns += '<button type="button" class="adm-btn-xs" disabled title="执行中不可编辑，请先暂停">编辑</button>';
      btns += '<button type="button" class="adm-btn-xs" data-act="task-pause" data-id="' + t.id + '" title="暂停（进度保留）">暂停</button>';
    } else if (inArr(EDITABLE, st)) {
      btns += '<button type="button" class="adm-btn-xs" data-act="task-edit" data-id="' + t.id + '" title="编辑参数（终态改完可重启重采）">编辑</button>';
    }
    if (st === 'paused') {
      btns += '<button type="button" class="adm-btn-xs" data-act="task-resume" data-id="' + t.id + '" title="恢复（重新入队续采）">恢复</button>';
    }
    if (inArr(CANCELABLE, st)) {
      btns += '<button type="button" class="adm-btn-xs adm-warn" data-act="task-cancel" data-id="' + t.id + '" title="停止/取消任务">停止</button>';
    }
    if (inArr(RESTARTABLE, st)) {
      btns += '<button type="button" class="adm-btn-xs adm-ok" data-act="task-restart" data-id="' + t.id + '" title="重启（进度清零重新入队）">重启</button>';
    }
    btns += '<button type="button" class="adm-btn-xs adm-danger" data-act="task-del" data-id="' + t.id + '" title="删除任务">删除</button>';

    var name = t.ruleId ? escapeHtml(ruleName(t.ruleId)) : '<span class="text-neutral-400">无规则</span>';
    return '<tr data-task-id="' + t.id + '" data-mode="' + escapeHtml(t.mode) + '" data-url="' + escapeHtml(t.targetUrl) + '" data-pages="' + escapeHtml(t.pages) + '" data-rule-id="' + escapeHtml(ruleIdAttr) + '">' +
      '<td class="tabular-nums text-neutral-500">' + t.id + '</td>' +
      '<td>' + (t.mode === 'list' ? '<span class="adm-badge adm-badge-neutral">范围</span>' : '<span class="adm-badge adm-badge-outline">单本</span>') + '</td>' +
      '<td>' + name + '</td>' +
      '<td class="adm-cell-url"><span title="' + escapeHtml(t.targetUrl) + '">' + escapeHtml(t.targetUrl) + '</span>' +
        (t.message ? '<span class="block truncate text-[11px] text-neutral-400" title="' + escapeHtml(t.message) + '">' + escapeHtml(t.message) + '</span>' : '') + '</td>' +
      '<td>' + badgeHtml(st) + '</td>' +
      '<td class="whitespace-nowrap tabular-nums">' + t.done + '/' + t.total + '</td>' +
      '<td class="whitespace-nowrap text-[11px] text-neutral-500">新建 ' + fmtTs(t.created) + ' · 章节 <span class="tabular-nums">' + t.chapters + '</span></td>' +
      '<td class="whitespace-nowrap text-[11px] text-neutral-400">' + fmtTs(t.updatedAt) + '</td>' +
      '<td class="whitespace-nowrap text-right">' + btns + '</td></tr>';
  }

  function renderOverviewTasks(rows) {
    var tbody = $('#adm-overview-tbody');
    if (!tbody) return;
    if (!rows.length) { tbody.innerHTML = '<tr><td colspan="7" class="adm-empty">暂无任务</td></tr>'; return; }
    tbody.innerHTML = rows.slice(0, 10).map(function (t) {
      var name = t.ruleId ? escapeHtml(ruleName(t.ruleId)) : '<span class="text-neutral-400">无规则</span>';
      return '<tr><td class="tabular-nums text-neutral-500">' + t.id + '</td><td>' + name + '</td>' +
        '<td>' + escapeHtml(t.mode) + '</td><td>' + badgeHtml(t.status) + '</td>' +
        '<td class="tabular-nums">' + t.done + '/' + t.total + '</td>' +
        '<td class="tabular-nums">' + t.chapters + '</td>' +
        '<td class="whitespace-nowrap text-neutral-400">' + fmtTs(t.updatedAt) + '</td></tr>';
    }).join('');
  }

  function renderTasksPage(res) {
    var list = (res && res.list) || [];
    tasksTotal = (res && res.total) || 0;
    tasksPage = (res && res.page) || tasksPage;
    tasksTotalPages = Math.max(1, Math.ceil(tasksTotal / TASK_PAGE_SIZE));
    if (tasksPage > tasksTotalPages) tasksPage = tasksTotalPages;
    var el = $('#adm-task-total'); if (el) el.textContent = tasksTotal;
    var pg = $('#adm-task-page'); if (pg) pg.textContent = tasksPage + ' / ' + tasksTotalPages;
    var tbody = $('#adm-tasks-tbody');
    tbody.innerHTML = list.length
      ? list.map(taskRowHtml).join('')
      : '<tr><td colspan="9" class="adm-empty">暂无任务，请在上方创建</td></tr>';
    renderOverviewTasks(list);
  }

  async function refreshTasks(silent) {
    try {
      var res = await api('GET', '/api/scrape-tasks?page=' + tasksPage + '&pageSize=' + TASK_PAGE_SIZE);
      renderTasksPage(res);
    } catch (e) { if (!silent) handleErr(e); }
  }

  /** 行展开容器：同一时刻只保留一个展开行 */
  function toggleExpansion(tr, key, colspan, html) {
    var tbody = tr.parentElement;
    var existing = tbody.querySelector('tr.adm-expand-row[data-key="' + key + '"]');
    $all('tr.adm-expand-row', tbody).forEach(function (r) { r.remove(); });
    if (existing) return null; // 再点一次 = 收起
    var er = document.createElement('tr');
    er.className = 'adm-expand-row';
    er.dataset.key = key;
    er.innerHTML = '<td colspan="' + colspan + '">' + html + '</td>';
    tr.after(er);
    return er;
  }

  var logTimer = null;

  function showTaskLog(id, tr) {
    var er = toggleExpansion(tr, 'log-' + id, 9, '<pre class="adm-log">日志加载中…</pre>');
    if (!er) return;
    var pre = er.querySelector('pre');
    var load = async function () {
      try {
        var d = await api('GET', '/api/scrape-tasks/' + id);
        var t = (d && d.task) || {};
        pre.textContent = t.log ? t.log : '暂无日志';
        pre.scrollTop = pre.scrollHeight;
        // 执行中任务自动跟随刷新，结束后停止
        if (logTimer) { clearInterval(logTimer); logTimer = null; }
        if (t.status === 'pending' || t.status === 'running') {
          logTimer = setInterval(function () {
            if (!document.body.contains(pre) || document.hidden) return;
            load();
          }, 3000);
        }
      } catch (e) { pre.textContent = '日志加载失败：' + e.message; }
    };
    load();
  }

  function showTaskEdit(id, tr) {
    var er = toggleExpansion(tr, 'edit-' + id, 9,
      '<div class="grid gap-2 md:grid-cols-[auto_1fr_auto_auto_auto] md:items-end" data-edit="' + id + '">' +
      '<label class="adm-field">模式<select class="adm-input adm-edit-mode"><option value="single">单本</option><option value="list">范围</option></select></label>' +
      '<label class="adm-field">目标 URL<input class="adm-input adm-edit-url" placeholder="https://…"></label>' +
      '<label class="adm-field">采集规则<select class="adm-input adm-edit-rule"><option value="">不使用规则</option></select></label>' +
      '<label class="adm-field adm-edit-pages-wrap hidden">页数（1-999）<input type="number" min="1" max="999" class="adm-input adm-edit-pages" value="1"></label>' +
      '<span class="flex gap-1.5"><button type="button" class="adm-btn adm-btn-primary" data-act="task-edit-save" data-id="' + id + '">保存</button>' +
      '<button type="button" class="adm-btn" data-act="task-edit-cancel">取消</button></span></div>');
    if (!er) return;
    er.querySelector('.adm-edit-rule').innerHTML = '<option value="">不使用规则</option>' + rulesCache.map(function (r) {
      return '<option value="' + escapeHtml(r.id) + '">' + escapeHtml(r.name) + '</option>';
    }).join('');
    // 回填：行内 data-* 数据（任务列表行由模板/JS 渲染时写入）
    var mode = tr.dataset.mode || 'single';
    var url = tr.dataset.url || '';
    var pages = tr.dataset.pages || '1';
    var rid = tr.dataset.ruleId || '';
    er.querySelector('.adm-edit-mode').value = mode;
    er.querySelector('.adm-edit-url').value = url;
    er.querySelector('.adm-edit-pages').value = pages;
    er.querySelector('.adm-edit-rule').value = rid;
    er.querySelector('.adm-edit-pages-wrap').classList.toggle('hidden', mode !== 'list');
    var modeSel = er.querySelector('.adm-edit-mode');
    modeSel.addEventListener('change', function () {
      er.querySelector('.adm-edit-pages-wrap').classList.toggle('hidden', modeSel.value !== 'list');
    });
  }

  async function saveTaskEdit(id, btn) {
    var box = btn.closest('[data-edit]');
    var mode = box.querySelector('.adm-edit-mode').value;
    var url = box.querySelector('.adm-edit-url').value.trim();
    if (!url) return toast('请输入目标 URL', 'err');
    var body = { mode: mode, targetUrl: url };
    var rid = box.querySelector('.adm-edit-rule').value;
    body.ruleId = rid ? Number(rid) : null; // null = 不使用规则（后端清空 ruleId）
    if (mode === 'list') {
      var p = Math.floor(Number(box.querySelector('.adm-edit-pages').value) || 0);
      if (p < 1 || p > 999) return toast('列表页数需为 1-999 的整数', 'err');
      body.pages = p;
    }
    try {
      await api('PUT', '/api/scrape-tasks/' + id, body); // PUT 传 mode/targetUrl/pages/ruleId
      toast('任务 #' + id + ' 已更新', 'ok');
      refreshTasks();
    } catch (e) { handleErr(e); }
  }

  async function taskAction(act, id, okMsg) {
    var key = busyKey(act, id);
    if (busy[key]) return;
    busy[key] = true;
    try {
      await api('PATCH', '/api/scrape-tasks/' + id, { action: act });
      if (okMsg) toast(okMsg, 'ok');
      refreshTasks();
    } catch (e) { handleErr(e); }
    finally { delete busy[key]; }
  }

  function initTasks() {
    var modeSel = $('#adm-new-mode');
    modeSel.addEventListener('change', function () {
      $('#adm-new-pages-wrap').classList.toggle('hidden', modeSel.value !== 'list');
    });
    $('#adm-new-submit').addEventListener('click', async function () {
      var url = $('#adm-new-url').value.trim();
      if (!url) return toast('请输入目标 URL', 'err');
      var mode = modeSel.value;
      var pages = 1;
      if (mode === 'list') {
        pages = Math.floor(Number($('#adm-new-pages').value) || 0);
        if (pages < 1 || pages > 999) return toast('列表页数需为 1-999 的整数', 'err');
      }
      var body = { mode: mode, targetUrl: url, pages: pages };
      var rid = $('#adm-new-rule').value;
      if (rid) body.ruleId = Number(rid);
      try {
        await api('POST', '/api/scrape-tasks', body);
        toast('采集任务已创建，等待 runner 领取执行', 'ok');
        $('#adm-new-url').value = '';
        tasksPage = 1;
        refreshTasks();
      } catch (e) { handleErr(e); }
    });
    $('#adm-task-prev').addEventListener('click', function () { if (tasksPage > 1) { tasksPage--; refreshTasks(); } });
    $('#adm-task-next').addEventListener('click', function () { if (tasksPage < tasksTotalPages) { tasksPage++; refreshTasks(); } });
    $('#adm-task-refresh').addEventListener('click', function () { refreshTasks(); });

    // 自动轮询：10s，仅页面可见时（避免后台标签页空转）
    setInterval(function () {
      if (document.hidden) return;
      refreshTasks(true);
    }, 10000);
  }

  /* ==================== 书籍管理 ==================== */

  var novelsQ = '';
  var novelsPage = 1;
  var novelsTotalPages = 1;

  function novelRowHtml(n) {
    return '<tr>' +
      '<td class="tabular-nums text-neutral-500">' + escapeHtml(n.id) + '</td>' +
      '<td class="font-medium"><a class="hover:underline" href="/book/' + escapeHtml(n.id) + '" target="_blank" rel="noopener">' + escapeHtml(n.title) + '</a></td>' +
      '<td>' + escapeHtml(n.author) + '</td>' +
      '<td>' + escapeHtml(n.categoryName || '—') + '</td>' +
      '<td class="whitespace-nowrap tabular-nums">' + escapeHtml(fmtWords(n.wordCount)) + '</td>' +
      '<td class="tabular-nums">' + escapeHtml(n.chapterCount) + '</td>' +
      '<td class="whitespace-nowrap text-neutral-400">' + fmtTs(n.updatedAt) + '</td>' +
      '<td class="text-right"><button type="button" class="adm-btn-xs adm-danger" data-act="novel-del" data-id="' + escapeHtml(n.id) + '" data-title="' + escapeHtml(n.title) + '">删除</button></td></tr>';
  }

  async function refreshNovels() {
    try {
      var q = encodeURIComponent(novelsQ);
      var res = await api('GET', '/api/novels?q=' + q + '&page=' + novelsPage + '&pageSize=20');
      var list = (res && res.list) || [];
      novelsTotalPages = (res && res.totalPages) || 1;
      $('#adm-novel-page').textContent = (res && res.page || novelsPage) + ' / ' + novelsTotalPages;
      $('#adm-novels-tbody').innerHTML = list.length
        ? list.map(novelRowHtml).join('')
        : '<tr><td colspan="8" class="adm-empty">' + (novelsQ ? '没有匹配「' + escapeHtml(novelsQ) + '」的书籍' : '暂无书籍') + '</td></tr>';
    } catch (e) { handleErr(e); }
  }

  function initNovels() {
    $('#adm-novel-search').addEventListener('click', function () {
      novelsQ = $('#adm-novel-q').value.trim();
      novelsPage = 1;
      refreshNovels();
    });
    $('#adm-novel-q').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') $('#adm-novel-search').click();
    });
    $('#adm-novel-prev').addEventListener('click', function () { if (novelsPage > 1) { novelsPage--; refreshNovels(); } });
    $('#adm-novel-next').addEventListener('click', function () { if (novelsPage < novelsTotalPages) { novelsPage++; refreshNovels(); } });
  }

  /* ==================== 分类管理 ==================== */

  function catRowHtml(c) {
    return '<tr>' +
      '<td class="tabular-nums text-neutral-500">' + escapeHtml(c.id) + '</td>' +
      '<td class="font-medium">' + escapeHtml(c.name) + '</td>' +
      '<td class="tabular-nums">' + escapeHtml(c.sort) + '</td>' +
      '<td class="tabular-nums">' + escapeHtml(c.novelCount) + '</td>' +
      '<td class="whitespace-nowrap text-right">' +
        '<button type="button" class="adm-btn-xs" data-act="cat-edit" data-id="' + escapeHtml(c.id) + '">改名/排序</button> ' +
        '<button type="button" class="adm-btn-xs adm-danger" data-act="cat-del" data-id="' + escapeHtml(c.id) + '" data-name="' + escapeHtml(c.name) + '">删除</button>' +
      '</td></tr>';
  }

  async function refreshCats() {
    try {
      var rows = await api('GET', '/api/categories');
      categoriesCache = rows || [];
      $('#adm-cats-tbody').innerHTML = categoriesCache.length
        ? categoriesCache.map(catRowHtml).join('')
        : '<tr><td colspan="5" class="adm-empty">暂无分类</td></tr>';
    } catch (e) { handleErr(e); }
  }

  function showCatEdit(id, tr) {
    var c = null;
    for (var i = 0; i < categoriesCache.length; i++) {
      if (Number(categoriesCache[i].id) === Number(id)) { c = categoriesCache[i]; break; }
    }
    if (!c) return;
    var er = toggleExpansion(tr, 'catedit-' + id, 5,
      '<div class="flex flex-wrap items-end gap-2" data-catedit="' + id + '">' +
      '<label class="adm-field">分类名称<input class="adm-input adm-cat-name" value="' + escapeHtml(c.name) + '"></label>' +
      '<label class="adm-field">排序（小的靠前）<input type="number" class="adm-input adm-cat-sort w-24" value="' + escapeHtml(c.sort) + '"></label>' +
      '<button type="button" class="adm-btn adm-btn-primary" data-act="cat-save" data-id="' + id + '">保存</button>' +
      '<button type="button" class="adm-btn" data-act="cat-edit-cancel">取消</button>' +
      '</div>');
    if (er) er.querySelector('.adm-cat-name').focus();
  }

  async function saveCatEdit(id, btn) {
    var box = btn.closest('[data-catedit]');
    var name = box.querySelector('.adm-cat-name').value.trim();
    var sortV = Math.floor(Number(box.querySelector('.adm-cat-sort').value) || 0);
    if (!name) return toast('分类名不能为空', 'err');
    try {
      await api('PUT', '/api/categories/' + id, { name: name, sort: sortV });
      toast('分类已保存', 'ok');
      refreshCats();
    } catch (e) { handleErr(e); }
  }

  async function loadMergeSuggestions() {
    var card = $('#adm-cat-merge-card');
    var list = $('#adm-cat-merge-list');
    try {
      var rows = await api('GET', '/api/categories/merge');
      card.classList.remove('hidden');
      if (!rows.length) {
        list.innerHTML = '<p class="text-[11px] text-neutral-400">当前分类全部为规范名，暂无归并建议。</p>';
        return;
      }
      list.innerHTML = rows.map(function (s, i) {
        var target = s.targetId ? ('「' + escapeHtml(s.target) + '」(id=' + s.targetId + ')') : ('「' + escapeHtml(s.target) + '」(将自动创建)');
        return '<div class="adm-merge-item">' +
          '<span class="font-medium">「' + escapeHtml(s.source) + '」</span>' +
          '<span class="text-neutral-400">' + escapeHtml(s.bookCount) + ' 本</span>' +
          '<span>→</span><span>' + target + '</span>' +
          '<span class="flex-1 text-[11px] text-neutral-400">' + escapeHtml(s.reason || '') + '</span>' +
          '<button type="button" class="adm-btn-xs adm-ok" data-act="cat-merge" data-idx="' + i + '">一键合并</button>' +
          '</div>';
      }).join('');
      mergeCache = rows;
    } catch (e) {
      card.classList.remove('hidden');
      list.innerHTML = '<p class="text-[11px] text-red-600">' + escapeHtml(e.message) + '</p>';
    }
  }

  var mergeCache = [];

  /* ==================== PSEO ==================== */

  function pseoRowHtml(r) {
    var badge;
    if (r.status === 'generated') badge = '<span class="adm-badge adm-badge-ok">已生成</span>';
    else if (r.status === 'pending') badge = '<span class="adm-badge adm-badge-warn">待生成</span>';
    else if (r.status === 'error') badge = '<span class="adm-badge adm-badge-bad">失败</span>';
    else badge = '<span class="adm-badge adm-badge-neutral">' + escapeHtml(r.status) + '</span>';
    var when = r.updatedAt ? fmtIso(r.updatedAt) : fmtTs(r.createdAt);
    return '<tr>' +
      '<td class="tabular-nums text-neutral-500">' + escapeHtml(r.id) + '</td>' +
      '<td class="font-medium"><a class="hover:underline" href="/pseo/' + encodeURIComponent(r.keyword || '') + '" target="_blank" rel="noopener">' + escapeHtml(r.keyword) + '</a></td>' +
      '<td>' + escapeHtml(r.source) + '</td>' +
      '<td>' + badge + '</td>' +
      '<td class="whitespace-nowrap text-neutral-400">' + when + '</td>' +
      '<td class="text-right"><button type="button" class="adm-btn-xs adm-danger" data-act="pseo-del" data-id="' + escapeHtml(r.id) + '" data-kw="' + escapeHtml(r.keyword) + '">删除</button></td></tr>';
  }

  async function refreshPseo() {
    try {
      var rows = await api('GET', '/api/pseo');
      $('#adm-pseo-tbody').innerHTML = (rows && rows.length)
        ? rows.map(pseoRowHtml).join('')
        : '<tr><td colspan="6" class="adm-empty">暂无关键词</td></tr>';
    } catch (e) { handleErr(e); }
  }

  /* ==================== 站点设置 ==================== */

  var categoriesCache = [];
  var homeBlocks = [];

  async function loadSettingsData() {
    settingsLoaded = true;
    try {
      var results = await Promise.all([api('GET', '/api/settings'), api('GET', '/api/categories')]);
      var s = results[0] || {};
      categoriesCache = results[1] || [];
      $('#adm-set-name').value = s.siteName || '';
      $('#adm-set-notice').value = s.notice || '';
      if (s.activeTheme) $('#adm-set-theme').value = s.activeTheme;
      $('#adm-set-footer').value = JSON.stringify(s.footer || {}, null, 2);
      $('#adm-set-seo').value = JSON.stringify(s.seo || {}, null, 2);
      homeBlocks = (s.home && s.home.blocks) || [];
      renderHomeBlocks();
    } catch (e) {
      settingsLoaded = false;
      handleErr(e);
    }
  }

  function homeSourceOptions(selected) {
    var opts = [
      ['latest', '最新更新 latest'], ['hot', '热门点击 hot'], ['featured', '特色推荐 featured']
    ];
    categoriesCache.forEach(function (c) {
      opts.push(['cat:' + c.id, '分类：' + c.name]);
    });
    return opts.map(function (o) {
      return '<option value="' + escapeHtml(o[0]) + '"' + (o[0] === selected ? ' selected' : '') + '>' + escapeHtml(o[1]) + '</option>';
    }).join('');
  }

  function renderHomeBlocks() {
    var box = $('#adm-home-blocks');
    if (!homeBlocks.length) {
      box.innerHTML = '<p class="text-[11px] text-neutral-400">暂无区块，前台首页保持主题默认布局。点击「添加区块」自定义图文推荐。</p>';
      return;
    }
    box.innerHTML = homeBlocks.map(function (b, i) {
      return '<div class="adm-home-row" data-id="' + escapeHtml(b.id || '') + '">' +
        '<span class="adm-home-idx">' + (i + 1) + '</span>' +
        '<input class="adm-input adm-home-title" placeholder="区块标题（≤30 字）" value="' + escapeHtml(b.title || '') + '">' +
        '<select class="adm-input adm-home-source">' + homeSourceOptions(b.source || 'latest') + '</select>' +
        '<input type="number" min="4" max="24" class="adm-input adm-home-count" value="' + escapeHtml(b.count || 8) + '" title="数量 4-24">' +
        '<button type="button" class="adm-btn-xs" data-act="home-up" data-idx="' + i + '"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
        '<button type="button" class="adm-btn-xs" data-act="home-down" data-idx="' + i + '"' + (i === homeBlocks.length - 1 ? ' disabled' : '') + '>↓</button>' +
        '<button type="button" class="adm-btn-xs adm-danger" data-act="home-del" data-idx="' + i + '">删除</button>' +
        '</div>';
    }).join('');
  }

  function readHomeBlocksFromDom() {
    var rows = $all('#adm-home-blocks .adm-home-row');
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var title = r.querySelector('.adm-home-title').value.trim();
      var source = r.querySelector('.adm-home-source').value;
      var count = Math.floor(Number(r.querySelector('.adm-home-count').value) || 0);
      if (!title) return { err: '第 ' + (i + 1) + ' 块标题不能为空' };
      if (count < 4 || count > 24) return { err: '第 ' + (i + 1) + ' 块数量需为 4-24 的整数' };
      var prev = homeBlocks[i];
      var id = (prev && prev.id) ? prev.id : ('blk' + Date.now().toString(36) + i);
      out.push({ id: id, title: title, source: source, count: count });
    }
    return { blocks: out };
  }

  function parseJsonTextarea(taId) {
    var raw = $('#' + taId).value.trim();
    if (!raw) return {};
    var v = JSON.parse(raw);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('内容必须是 JSON 对象');
    return v;
  }

  function initSettings() {
    $('#adm-set-basic-save').addEventListener('click', async function () {
      var siteName = $('#adm-set-name').value.trim();
      if (!siteName) return toast('站点名称不能为空（全站页头/TDK 根变量）', 'err');
      try {
        await api('PATCH', '/api/settings', {
          siteName: siteName,
          notice: $('#adm-set-notice').value,
          activeTheme: $('#adm-set-theme').value
        });
        toast('基础设置已保存（主题切换后刷新前台生效）', 'ok');
      } catch (e) { handleErr(e); }
    });

    $('#adm-set-footer-save').addEventListener('click', async function () {
      var obj;
      try { obj = parseJsonTextarea('adm-set-footer'); }
      catch (e) { return toast('footerConfig JSON 无效：' + e.message, 'err'); }
      try {
        await api('PATCH', '/api/settings', { footer: obj });
        toast('页脚配置已保存', 'ok');
      } catch (e) { handleErr(e); }
    });

    $('#adm-set-seo-save').addEventListener('click', async function () {
      var obj;
      try { obj = parseJsonTextarea('adm-set-seo'); }
      catch (e) { return toast('seoConfig JSON 无效：' + e.message, 'err'); }
      try {
        await api('PATCH', '/api/settings', { seo: obj });
        toast('SEO 配置已保存', 'ok');
      } catch (e) { handleErr(e); }
    });

    $('#adm-set-home-save').addEventListener('click', async function () {
      var parsed = readHomeBlocksFromDom();
      if (parsed.err) return toast(parsed.err, 'err');
      try {
        await api('PATCH', '/api/settings', { home: { blocks: parsed.blocks } });
        homeBlocks = parsed.blocks;
        renderHomeBlocks();
        toast('首页图文区块已保存（共 ' + parsed.blocks.length + ' 块）', 'ok');
      } catch (e) { handleErr(e); }
    });

    $('#adm-home-add').addEventListener('click', function () {
      if (!settingsLoaded) { loadSettingsData(); return toast('配置加载中，请稍候再添加', 'err'); }
      if (homeBlocks.length >= 8) return toast('最多 8 个区块', 'err');
      homeBlocks.push({ title: '', source: 'latest', count: 8 });
      renderHomeBlocks();
    });

    // 区块行内按钮（上移/下移/删除）+ JSON 格式化按钮走统一委托
    $('#adm-home-blocks').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      var i = Number(btn.dataset.idx);
      var act = btn.dataset.act;
      if (act === 'home-up' && i > 0) {
        var tmp = homeBlocks[i - 1]; homeBlocks[i - 1] = homeBlocks[i]; homeBlocks[i] = tmp;
        homeBlocks = readBackHomeRows(); // 保留未保存的输入内容
        renderHomeBlocks();
      } else if (act === 'home-down' && i < homeBlocks.length - 1) {
        var t2 = homeBlocks[i + 1]; homeBlocks[i + 1] = homeBlocks[i]; homeBlocks[i] = t2;
        homeBlocks = readBackHomeRows();
        renderHomeBlocks();
      } else if (act === 'home-del') {
        homeBlocks = readBackHomeRows();
        homeBlocks.splice(i, 1);
        renderHomeBlocks();
      }
    });
  }

  /** 上移/下移/删除前把 DOM 当前输入读回内存，避免丢用户未保存的编辑 */
  function readBackHomeRows() {
    var rows = $all('#adm-home-blocks .adm-home-row');
    var out = [];
    rows.forEach(function (r) {
      out.push({
        id: r.dataset.id || '',
        title: r.querySelector('.adm-home-title').value,
        source: r.querySelector('.adm-home-source').value,
        count: Number(r.querySelector('.adm-home-count').value) || 8
      });
    });
    // 行 DOM 未带 id 时回落 homeBlocks 对应位
    for (var i = 0; i < out.length; i++) {
      if (!out[i].id && homeBlocks[i]) out[i].id = homeBlocks[i].id;
    }
    return out;
  }

  /* ==================== 统一事件委托（data-act） ==================== */

  function initActions() {
    document.addEventListener('click', async function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn || btn.disabled) return;
      var act = btn.dataset.act;
      var id = btn.dataset.id;

      // ---- 规则 ----
      if (act === 'rule-edit') {
        try {
          var rows = rulesCache.length ? rulesCache : (await api('GET', '/api/scrape-rules'));
          rulesCache = rows;
          var hit = null;
          for (var i = 0; i < rows.length; i++) { if (Number(rows[i].id) === Number(id)) { hit = rows[i]; break; } }
          if (!hit) return toast('规则不存在或已被删除', 'err');
          showRuleForm(hit);
        } catch (err) { handleErr(err); }
      } else if (act === 'rule-del') {
        if (!window.confirm('确认删除采集规则「' + btn.dataset.name + '」？该操作不可恢复。')) return;
        try {
          await api('DELETE', '/api/scrape-rules?id=' + encodeURIComponent(id));
          toast('规则已删除', 'ok');
          refreshRules();
        } catch (err) { handleErr(err); }
      } else if (act === 'rule-fmt') {
        formatJsonTextarea(btn.dataset.target);

      // ---- 任务 ----
      } else if (act === 'task-log') {
        showTaskLog(id, btn.closest('tr'));
      } else if (act === 'task-edit') {
        showTaskEdit(id, btn.closest('tr'));
      } else if (act === 'task-edit-save') {
        saveTaskEdit(id, btn);
      } else if (act === 'task-edit-cancel') {
        var tr = btn.closest('tr.adm-expand-row');
        if (tr) tr.remove();
      } else if (act === 'task-pause') {
        taskAction('pause', id, '已发送暂停指令（任务 #' + id + '），执行中任务会在数秒内安全停手');
      } else if (act === 'task-resume') {
        taskAction('resume', id, '任务 #' + id + ' 已恢复，等待 runner 领取继续采集');
      } else if (act === 'task-cancel') {
        if (!window.confirm('确认停止/取消任务 #' + id + '？')) return;
        taskAction('cancel', id, '已发送取消指令（任务 #' + id + '）');
      } else if (act === 'task-restart') {
        taskAction('restart', id, '任务 #' + id + ' 已重启，进度清零等待 runner 领取重新采集');
      } else if (act === 'task-del') {
        if (!window.confirm('确认删除任务 #' + id + '？日志将一并删除。')) return;
        try {
          await api('DELETE', '/api/scrape-tasks/' + id);
          toast('任务已删除', 'ok');
          refreshTasks();
        } catch (err) { handleErr(err); }

      // ---- 书籍 ----
      } else if (act === 'novel-del') {
        if (!window.confirm('确认删除书籍「' + btn.dataset.title + '」？其章节将一并删除，不可恢复。')) return;
        try {
          await api('DELETE', '/api/novels/' + id);
          toast('书籍已删除', 'ok');
          refreshNovels();
        } catch (err) { handleErr(err); }

      // ---- 分类 ----
      } else if (act === 'cat-edit') {
        showCatEdit(id, btn.closest('tr'));
      } else if (act === 'cat-save') {
        saveCatEdit(id, btn);
      } else if (act === 'cat-edit-cancel') {
        var cer = btn.closest('tr.adm-expand-row');
        if (cer) cer.remove();
      } else if (act === 'cat-del') {
        if (!window.confirm('确认删除分类「' + btn.dataset.name + '」？分类下有书籍时后端会拒绝。')) return;
        try {
          await api('DELETE', '/api/categories/' + id);
          toast('分类已删除', 'ok');
          refreshCats();
        } catch (err) { handleErr(err); } // 有书时后端报错 → 如实 toast
      } else if (act === 'cat-merge') {
        var sug = mergeCache[Number(btn.dataset.idx)];
        if (!sug) return;
        if (!window.confirm('确认把「' + sug.source + '」（' + sug.bookCount + ' 本）合并到「' + sug.target + '」？源分类将被删除。')) return;
        var body = { fromId: sug.sourceId };
        if (sug.targetId) body.toId = sug.targetId; else body.toName = sug.target;
        try {
          await api('POST', '/api/categories/merge', body);
          toast('已合并「' + sug.source + '」→「' + sug.target + '」', 'ok');
          refreshCats();
          loadMergeSuggestions();
        } catch (err) { handleErr(err); }

      // ---- PSEO ----
      } else if (act === 'pseo-del') {
        if (!window.confirm('确认删除关键词「' + btn.dataset.kw + '」？对应聚合页将失效。')) return;
        try {
          await api('DELETE', '/api/pseo?id=' + encodeURIComponent(id));
          toast('关键词已删除', 'ok');
          refreshPseo();
        } catch (err) { handleErr(err); }

      // ---- 设置 ----
      } else if (act === 'json-fmt') {
        formatJsonTextarea(btn.dataset.target);
      }
    });
  }

  function formatJsonTextarea(taId) {
    var ta = $('#' + taId);
    if (!ta) return;
    try {
      var v = JSON.parse(ta.value.trim() || '{}');
      ta.value = JSON.stringify(v, null, 2);
      toast('JSON 已格式化', 'ok');
    } catch (e) {
      toast('JSON 无法解析：' + e.message, 'err');
    }
  }

  /* ==================== 启动 ==================== */

  function init() {
    initTabs();
    initTasks();
    initNovels();
    initSettings();
    initActions();

    checkHealth();
    setInterval(checkHealth, 30000);

    refreshRules(true); // 规则名映射 + 新建任务下拉（失败静默，SSR 数据仍在）
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
