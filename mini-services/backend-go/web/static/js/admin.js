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
    // Task 32-b: 存储模式徽章（db 默认不显，txt/both 才标出，与存储面可见性一致）
    var storageBadge = '';
    if (t.storageMode === 'txt') storageBadge = ' <span class="adm-badge adm-badge-outline" title="正文存为一章一 TXT 文件">TXT</span>';
    else if (t.storageMode === 'both') storageBadge = ' <span class="adm-badge adm-badge-neutral" title="数据库+TXT 文件双写">双写</span>';
    return '<tr data-task-id="' + t.id + '" data-mode="' + escapeHtml(t.mode) + '" data-url="' + escapeHtml(t.targetUrl) + '" data-pages="' + escapeHtml(t.pages) + '" data-rule-id="' + escapeHtml(ruleIdAttr) + '">' +
      '<td class="tabular-nums text-neutral-500">' + t.id + '</td>' +
      '<td>' + (t.mode === 'list' ? '<span class="adm-badge adm-badge-neutral">范围</span>' : '<span class="adm-badge adm-badge-outline">单本</span>') + storageBadge + '</td>' +
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
      var storage = $('#adm-new-storage').value; // Task 32-b: 存储模式 db|txt|both
      if (storage && storage !== 'db') body.storageMode = storage;
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
      '<td class="text-right whitespace-nowrap">' +
      '<button type="button" class="adm-btn-xs" data-act="novel-edit" data-id="' + escapeHtml(n.id) + '">编辑</button> ' +
      '<button type="button" class="adm-btn-xs" data-act="novel-chapters" data-id="' + escapeHtml(n.id) + '" data-title="' + escapeHtml(n.title) + '">章节</button> ' +
      '<button type="button" class="adm-btn-xs adm-danger" data-act="novel-del" data-id="' + escapeHtml(n.id) + '" data-title="' + escapeHtml(n.title) + '">删除</button></td></tr>';
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
    // Task 30 主线：书籍编辑/章节管理弹层
    $('#adm-novel-edit-save').addEventListener('click', saveNovelEdit);
    $('#adm-chapter-edit-save').addEventListener('click', function () { saveChapterEdit(this); });
    $('#adm-chapters-q').addEventListener('input', function () {
      chaptersQ = this.value.trim();
      chaptersPage = 1;
      renderChapters();
    });
    $('#adm-chapters-prev').addEventListener('click', function () { if (chaptersPage > 1) { chaptersPage--; renderChapters(); } });
    $('#adm-chapters-next').addEventListener('click', function () {
      var totalPages = Math.max(1, Math.ceil((chaptersQ ? chaptersAll.filter(function (c) { return (c.title || '').indexOf(chaptersQ) >= 0; }) : chaptersAll).length / CHAPTERS_PAGE_SIZE));
      if (chaptersPage < totalPages) { chaptersPage++; renderChapters(); }
    });
    // ESC 关闭最上层弹层
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      ['adm-modal-chapter-edit', 'adm-modal-chapters', 'adm-modal-novel'].some(function (id) {
        var m = $('#' + id);
        if (m && !m.classList.contains('hidden')) { closeModal(id); return true; }
        return false;
      });
    });
  }

  /* ==================== 弹层与书籍/章节编辑（Task 30 主线） ==================== */

  function openModal(id) {
    var m = $('#' + id);
    if (!m) return;
    m.classList.remove('hidden');
    m.classList.add('flex');
  }
  function closeModal(id) {
    var m = $('#' + id);
    if (!m) return;
    m.classList.add('hidden');
    m.classList.remove('flex');
  }

  var novelEditId = 0;

  function fillCategorySelect(sel, selectedId) {
    sel.innerHTML = '<option value="">— 未分类 —</option>' + categoriesCache.map(function (c) {
      return '<option value="' + escapeHtml(c.id) + '"' + (Number(c.id) === Number(selectedId) ? ' selected' : '') + '>' + escapeHtml(c.name) + '</option>';
    }).join('');
  }

  async function openNovelEdit(id) {
    novelEditId = Number(id);
    try {
      var n = await api('GET', '/api/novels/' + id);
      $('#adm-novel-edit-id').textContent = '#' + id;
      $('#adm-novel-f-title').value = n.title || '';
      $('#adm-novel-f-author').value = n.author || '';
      $('#adm-novel-f-desc').value = n.description || '';
      $('#adm-novel-f-status').value = (n.status === 'finished') ? 'finished' : 'serial';
      $('#adm-novel-f-featured').checked = !!n.isFeatured;
      if (!categoriesCache.length) {
        try { categoriesCache = await api('GET', '/api/categories') || []; } catch (e2) { /* 下拉留空 */ }
      }
      fillCategorySelect($('#adm-novel-f-category'), n.categoryId);
      openModal('adm-modal-novel');
    } catch (e) { handleErr(e); }
  }

  async function saveNovelEdit() {
    var title = $('#adm-novel-f-title').value.trim();
    if (!title) return toast('书名不能为空', 'err');
    var body = {
      title: title,
      author: $('#adm-novel-f-author').value.trim(),
      description: $('#adm-novel-f-desc').value,
      status: $('#adm-novel-f-status').value,
      isFeatured: $('#adm-novel-f-featured').checked
    };
    var cid = $('#adm-novel-f-category').value;
    if (cid) body.categoryId = Number(cid);
    try {
      await api('PUT', '/api/novels/' + novelEditId, body);
      toast('书籍已保存', 'ok');
      closeModal('adm-modal-novel');
      refreshNovels();
    } catch (e) { handleErr(e); }
  }

  /* ---- 章节管理（列表/搜索/分页/编辑正文） ---- */

  var chaptersNovelId = 0;
  var chaptersAll = [];
  var chaptersQ = '';
  var chaptersPage = 1;
  var CHAPTERS_PAGE_SIZE = 20;

  async function openChapters(novelId, title) {
    chaptersNovelId = Number(novelId);
    chaptersQ = '';
    chaptersPage = 1;
    $('#adm-chapters-q').value = '';
    $('#adm-chapters-title').textContent = title ? '《' + title + '》' : '';
    $('#adm-chapters-tbody').innerHTML = '<tr><td colspan="4" class="adm-empty">加载中…</td></tr>';
    openModal('adm-modal-chapters');
    try {
      chaptersAll = (await api('GET', '/api/novels/' + novelId + '/chapters')) || [];
      renderChapters();
    } catch (e) {
      handleErr(e);
      $('#adm-chapters-tbody').innerHTML = '<tr><td colspan="4" class="adm-empty">加载失败</td></tr>';
    }
  }

  function renderChapters() {
    var list = chaptersQ ? chaptersAll.filter(function (c) { return (c.title || '').indexOf(chaptersQ) >= 0; }) : chaptersAll;
    var totalPages = Math.max(1, Math.ceil(list.length / CHAPTERS_PAGE_SIZE));
    if (chaptersPage > totalPages) chaptersPage = totalPages;
    var start = (chaptersPage - 1) * CHAPTERS_PAGE_SIZE;
    var pageList = list.slice(start, start + CHAPTERS_PAGE_SIZE);
    $('#adm-chapters-count').textContent = '共 ' + list.length + ' 章' + (chaptersQ ? '（过滤自 ' + chaptersAll.length + ' 章）' : '');
    $('#adm-chapters-page').textContent = chaptersPage + ' / ' + totalPages;
    $('#adm-chapters-tbody').innerHTML = pageList.length ? pageList.map(function (c) {
      return '<tr>' +
        '<td class="tabular-nums text-neutral-500">' + escapeHtml(c.idx) + '</td>' +
        '<td class="max-w-0 truncate font-medium" title="' + escapeHtml(c.title) + '">' + escapeHtml(c.title) + '</td>' +
        '<td class="tabular-nums whitespace-nowrap">' + escapeHtml(fmtWords(c.wordCount)) + '</td>' +
        '<td class="text-right"><button type="button" class="adm-btn-xs" data-act="chapter-edit" data-id="' + escapeHtml(c.id) + '">编辑</button></td></tr>';
    }).join('') : '<tr><td colspan="4" class="adm-empty">无匹配章节</td></tr>';
  }

  async function openChapterEdit(chapterId) {
    try {
      var c = await api('GET', '/api/chapters/' + chapterId);
      $('#adm-chapter-f-title').value = c.title || '';
      $('#adm-chapter-f-content').value = c.content || '';
      $('#adm-chapter-edit-save').dataset.id = chapterId;
      openModal('adm-modal-chapter-edit');
    } catch (e) { handleErr(e); }
  }

  async function saveChapterEdit(btn) {
    var title = $('#adm-chapter-f-title').value.trim();
    if (!title) return toast('章节标题不能为空', 'err');
    try {
      await api('PUT', '/api/chapters/' + btn.dataset.id, { title: title, content: $('#adm-chapter-f-content').value });
      toast('章节已保存（字数已重算）', 'ok');
      closeModal('adm-modal-chapter-edit');
      if (chaptersNovelId) {
        try {
          chaptersAll = (await api('GET', '/api/novels/' + chaptersNovelId + '/chapters')) || [];
          renderChapters();
        } catch (e2) { /* 列表刷新失败不阻断 */ }
      }
    } catch (e) { handleErr(e); }
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
      renderFooterForm(s.footer || {}); // Task 30 主线：表单化（告别 JSON）
      renderSeoForm(s.seo || {});
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

  /* parseJsonTextarea 已删（Task 30 主线）：页脚/SEO 改表单化后无引用 */

  /* ==================== 页脚/SEO 表单化（Task 30 主线：用户无需写 JSON） ==================== */

  // 与后端 seoStringKeys 一致（api_settings.go），新增键需同步
  var SEO_KEYS = ['homeTitle', 'homeDescription', 'homeKeywords',
    'categoryTitle', 'categoryDescription',
    'bookTitle', 'bookDescription', 'bookKeywords',
    'tocTitle', 'tocDescription',
    'chapterTitle', 'chapterDescription', 'chapterKeywords',
    'searchTitle', 'searchDescription',
    'pseoTitle', 'pseoDescription', 'pseoKeywords'];
  var seoLoaded = {};

  function renderFooterForm(f) {
    $('#adm-footer-text').value = f.text || '';
    $('#adm-footer-extra').value = f.extra || '';
    var box = $('#adm-footer-links');
    box.innerHTML = (f.links || []).map(function (l) {
      return footerLinkRowHtml(l.label || '', l.href || '');
    }).join('');
    renderFriendLinks(f.friendLinks || []); // Task 32-a: 友情链接动态行
  }

  function footerLinkRowHtml(label, href) {
    return '<div class="adm-footer-link flex items-center gap-1.5">' +
      '<input class="adm-input adm-fl-label w-32" placeholder="文字" maxlength="20" value="' + escapeHtml(label) + '">' +
      '<input class="adm-input adm-fl-href flex-1" placeholder="https://…" value="' + escapeHtml(href) + '">' +
      '<button type="button" class="adm-btn-xs adm-danger" data-act="footer-link-del">删除</button></div>';
  }

  function readFooterForm() {
    var obj = {
      text: $('#adm-footer-text').value.trim(),
      extra: $('#adm-footer-extra').value.trim(),
      links: []
    };
    var rows = $all('#adm-footer-links .adm-footer-link');
    for (var i = 0; i < rows.length && obj.links.length < 10; i++) { // 后端 footerLinkCount=10
      var row = rows[i];
      var label = row.querySelector('.adm-fl-label').value.trim();
      var href = row.querySelector('.adm-fl-href').value.trim();
      if (label && href) obj.links.push({ label: label, href: href });
    }
    obj.friendLinks = readFriendLinks(); // Task 32-a: 友情链接随页脚表单一并提交
    return obj;
  }

  /* Task 32-a: 友情链接动态行（对照 footerLinkRowHtml 同款交互；上限 30 = 后端 footerFriendLinkCount） */
  function renderFriendLinks(list) {
    var box = $('#adm-footer-friends');
    box.innerHTML = (list || []).map(function (l) {
      return friendLinkRowHtml(l.name || '', l.url || '');
    }).join('');
  }

  function friendLinkRowHtml(name, url) {
    return '<div class="adm-footer-friend flex items-center gap-1.5">' +
      '<input class="adm-input adm-fr-name w-32" placeholder="名称" maxlength="20" value="' + escapeHtml(name) + '">' +
      '<input class="adm-input adm-fr-url flex-1" placeholder="https://…" value="' + escapeHtml(url) + '">' +
      '<button type="button" class="adm-btn-xs adm-danger" data-act="footer-friend-del">删除</button></div>';
  }

  function readFriendLinks() {
    var out = [];
    var rows = $all('#adm-footer-friends .adm-footer-friend');
    for (var i = 0; i < rows.length && out.length < 30; i++) {
      var name = rows[i].querySelector('.adm-fr-name').value.trim();
      var url = rows[i].querySelector('.adm-fr-url').value.trim();
      if (name && url) out.push({ name: name, url: url });
    }
    return out;
  }

  function renderSeoForm(seo) {
    seoLoaded = seo || {};
    SEO_KEYS.forEach(function (k) {
      var el = $('#adm-seo-' + k);
      if (el) el.value = seoLoaded[k] || '';
    });
    $('#adm-seo-auto').checked = seoLoaded.autoFromContent !== false; // 后端默认 true
  }

  function readSeoForm() {
    var obj = {};
    SEO_KEYS.forEach(function (k) {
      var el = $('#adm-seo-' + k);
      if (el) obj[k] = el.value.trim(); // 空串也显式提交：后端 sanitize 落空串，applyWebTDK 空模板自动回落内置默认
    });
    obj.autoFromContent = $('#adm-seo-auto').checked;
    if (seoLoaded && seoLoaded.pseo) obj.pseo = seoLoaded.pseo; // pseo 子对象表单不展示，原样保留防丢
    return obj;
  }

  /* ---- Task 31: TDK 预设 18 套 + 随机刷新组合 ----
   * 18 套风格化 TDK 预设；「随机换一套」每键从 18 套对应候选中独立抽取组合成一套新配置。
   * 变量占位符 {siteName}/{categoryName}/{novelTitle}/{author}/{statusText}/{descShort}
   * /{chapterTitle}/{idx}/{query}/{keyword}/{count} 与后端 renderTpl 语义一致，保存后前台渲染时替换。 */
  var TDK_PRESETS = [
    {
      label: '标准官方',
      homeTitle: '{siteName} - 免费小说在线阅读_原创小说网站',
      homeDescription: '{siteName}是领先的免费原创小说在线阅读网站，提供玄幻、仙侠、都市、历史、科幻等全品类小说，每日更新，畅享极致阅读体验。',
      homeKeywords: '小说,免费小说,在线阅读,{siteName},玄幻小说,都市小说',
      categoryTitle: '{categoryName}小说大全_最新{categoryName}小说排行榜 - {siteName}',
      categoryDescription: '{siteName}{categoryName}频道为您提供海量精品{categoryName}小说在线阅读，{categoryName}小说每日更新，尽在{siteName}。',
      bookTitle: '{novelTitle}最新章节列表_{author}小说 - {siteName}',
      bookDescription: '{novelTitle}连载于{siteName}，作者{author}，{statusText}。{descShort}',
      bookKeywords: '{novelTitle},{novelTitle}最新章节,{author},{categoryName}小说',
      tocTitle: '{novelTitle}目录_全部章节列表 - {siteName}',
      tocDescription: '{novelTitle}全部章节目录一览，按顺序阅读《{novelTitle}》最新章节，尽在{siteName}。',
      chapterTitle: '{chapterTitle}_《{novelTitle}》第{idx}章 - {siteName}',
      chapterDescription: '《{novelTitle}》{chapterTitle}在线阅读，作者{author}，精彩章节尽在{siteName}。',
      chapterKeywords: '{novelTitle},{chapterTitle},{author}',
      searchTitle: '"{query}"的搜索结果 - {siteName}',
      searchDescription: '在{siteName}搜索"{query}"找到的相关小说列表。',
      pseoTitle: '{keyword}小说推荐_关于{keyword}的小说 - {siteName}',
      pseoDescription: '{siteName}为您精选与"{keyword}"相关的小说合集，包含 {count} 本热门作品，在线免费阅读。',
      pseoKeywords: '{keyword},{keyword}小说,{keyword}推荐'
    },
    {
      label: '简洁直达',
      homeTitle: '{siteName}｜免费小说全本阅读',
      homeDescription: '{siteName}提供全品类免费小说在线阅读，玄幻言情都市历史一站直达，无需注册即点即读。',
      homeKeywords: '免费小说,小说全本,{siteName},在线阅读,无广告小说',
      categoryTitle: '{categoryName}小说_免费{categoryName}小说推荐 - {siteName}',
      categoryDescription: '{siteName}精选{categoryName}小说免费在线阅读，热门{categoryName}作品持续更新中。',
      bookTitle: '{novelTitle}_{author}作品全集 - {siteName}',
      bookDescription: '{author}著作《{novelTitle}》{statusText}，{descShort}就在{siteName}免费阅读。',
      bookKeywords: '{novelTitle},{author},{novelTitle}全本阅读',
      tocTitle: '《{novelTitle}》章节目录 - {siteName}',
      tocDescription: '《{novelTitle}》完整章节目录，一键直达任意章节开始阅读。',
      chapterTitle: '{novelTitle} 第{idx}章 {chapterTitle} - {siteName}',
      chapterDescription: '{novelTitle}第{idx}章{chapterTitle}全文在线阅读，更新及时无删减。',
      chapterKeywords: '{novelTitle}第{idx}章,{chapterTitle}',
      searchTitle: '搜索：{query} - {siteName}',
      searchDescription: '{siteName}内"{query}"相关小说搜索结果。',
      pseoTitle: '{keyword}相关小说_小说推荐 - {siteName}',
      pseoDescription: '与"{keyword}"相关的 {count} 本精选小说，{siteName}在线免费读。',
      pseoKeywords: '{keyword},{keyword}小说推荐'
    },
    {
      label: '全品类书城',
      homeTitle: '{siteName} - 海量全品类小说免费阅读平台',
      homeDescription: '{siteName}汇聚玄幻、武侠、都市、历史、科幻、游戏、悬疑、轻小说等全品类海量小说，千万书友的共同选择。',
      homeKeywords: '小说网站,全品类小说,免费书城,{siteName},小说大全',
      categoryTitle: '{categoryName}小说频道_海量{categoryName}作品 - {siteName}',
      categoryDescription: '{siteName}{categoryName}频道收录海量{categoryName}小说，分类精准查找，免费畅读不断更。',
      bookTitle: '《{novelTitle}》小说全文免费阅读_{author} - {siteName}',
      bookDescription: '《{novelTitle}》{statusText}，作者{author}。{descShort}全文在{siteName}免费畅读。',
      bookKeywords: '{novelTitle}全文阅读,{novelTitle},{author}小说',
      tocTitle: '{novelTitle}章节目录大全 - {siteName}',
      tocDescription: '《{novelTitle}》章节目录大全，全部章节按序排列，追更补章两相宜。',
      chapterTitle: '{chapterTitle} - {novelTitle}正文 - {siteName}',
      chapterDescription: '《{novelTitle}》{chapterTitle}正文阅读，文字纯净排版舒适，尽在{siteName}。',
      chapterKeywords: '{novelTitle}正文,{chapterTitle},{author}',
      searchTitle: '"{query}"相关书籍 - {siteName}搜索',
      searchDescription: '在{siteName}书城中查找"{query}"的相关小说作品。',
      pseoTitle: '{keyword}主题小说合集（共{count}本） - {siteName}',
      pseoDescription: '{siteName}整理"{keyword}"主题小说合集 {count} 本，题材相近口味一致，免费在线阅读。',
      pseoKeywords: '{keyword},主题小说,小说合集,{siteName}'
    },
    {
      label: '每日更新',
      homeTitle: '{siteName} - 每日更新的免费小说阅读网',
      homeDescription: '{siteName}每日更新数千章节，玄幻、都市、言情、悬疑热门连载追更不停，最新章节第一时间呈现。',
      homeKeywords: '每日更新小说,最新章节,连载小说,{siteName},追更',
      categoryTitle: '{categoryName}小说每日更新_最新{categoryName}连载 - {siteName}',
      categoryDescription: '{siteName}{categoryName}区每日更新最新{categoryName}小说章节，追更党收藏这一站就够了。',
      bookTitle: '{novelTitle}最新章节（今日更新）_{author} - {siteName}',
      bookDescription: '《{novelTitle}》{statusText}，{author}最新力作，{siteName}同步更新最新章节。{descShort}',
      bookKeywords: '{novelTitle}最新章节,{novelTitle}更新,{author}',
      tocTitle: '{novelTitle}最新章节目录_持续更新 - {siteName}',
      tocDescription: '《{novelTitle}》章节目录持续更新中，{statusText}，收藏页面追更不迷路。',
      chapterTitle: '{novelTitle}第{idx}章 {chapterTitle}（最新） - {siteName}',
      chapterDescription: '《{novelTitle}》最新章节{chapterTitle}已更新，{author}作品同步连载中。',
      chapterKeywords: '{novelTitle}最新,{chapterTitle},{author}连载',
      searchTitle: '{query}的小说_搜索结果 - {siteName}',
      searchDescription: '{siteName}为您找到"{query}"相关小说，全部可免费在线阅读。',
      pseoTitle: '{keyword}小说每日推荐_连载更新 - {siteName}',
      pseoDescription: '"{keyword}"相关小说 {count} 本持续更新，{siteName}每日刷新推荐书单。',
      pseoKeywords: '{keyword},每日更新小说,连载推荐'
    },
    {
      label: '正版免费',
      homeTitle: '{siteName} - 正版体验级免费小说阅读',
      homeDescription: '{siteName}坚持免费阅读理念，全部小说免费开放，界面清爽无打扰，支持正版体验从{siteName}开始。',
      homeKeywords: '免费阅读,正版小说,免费看书,{siteName},免费小说网站',
      categoryTitle: '免费{categoryName}小说_全本免费阅读 - {siteName}',
      categoryDescription: '{siteName}{categoryName}分类全部小说免费阅读，无需付费开通会员，畅快阅读零门槛。',
      bookTitle: '{novelTitle}免费阅读全文_作者{author} - {siteName}',
      bookDescription: '《{novelTitle}》全文免费阅读，作者{author}，{statusText}。{descShort}',
      bookKeywords: '{novelTitle}免费阅读,免费小说,{author}作品',
      tocTitle: '{novelTitle}全本章节免费读 - {siteName}',
      tocDescription: '《{novelTitle}》全部章节免费开放，点击目录任意章节即刻免费阅读。',
      chapterTitle: '免费阅读 {novelTitle} {chapterTitle} - {siteName}',
      chapterDescription: '《{novelTitle}》{chapterTitle}免费在线阅读，全程免费无付费章节。',
      chapterKeywords: '{novelTitle}免费,{chapterTitle},免费章节',
      searchTitle: '免费读"{query}" - {siteName}',
      searchDescription: '"{query}"相关免费小说，{siteName}全部免费开放阅读。',
      pseoTitle: '{keyword}免费小说推荐（{count}本） - {siteName}',
      pseoDescription: '"{keyword}"相关 {count} 本小说全部免费阅读，{siteName}免费书库持续扩充。',
      pseoKeywords: '{keyword},免费小说,免费阅读'
    },
    {
      label: '经典必读',
      homeTitle: '{siteName} - 经典小说必读书库',
      homeDescription: '{siteName}精选历年经典小说必读佳作，经得起时间检验的好故事，资深书友口碑之选。',
      homeKeywords: '经典小说,必读小说,口碑好书,{siteName},经典书库',
      categoryTitle: '经典{categoryName}小说_必读{categoryName}书单 - {siteName}',
      categoryDescription: '{siteName}严选经典{categoryName}小说，本本经过书友检验，入坑不后悔的{categoryName}必读书单。',
      bookTitle: '经典小说《{novelTitle}》_{author}代表作 - {siteName}',
      bookDescription: '《{novelTitle}》{author}代表作，{statusText}，书友口碑之作。{descShort}',
      bookKeywords: '{novelTitle},经典小说,{author}代表作',
      tocTitle: '《{novelTitle}》完整目录_经典重温 - {siteName}',
      tocDescription: '《{novelTitle}》完整章节目录，经典小说重温，每一章都值得细品。',
      chapterTitle: '《{novelTitle}》{chapterTitle}经典章节 - {siteName}',
      chapterDescription: '重温经典《{novelTitle}》{chapterTitle}，{author}笔下的精彩篇章。',
      chapterKeywords: '{novelTitle},{chapterTitle},经典章节',
      searchTitle: '经典小说搜索：{query} - {siteName}',
      searchDescription: '在{siteName}经典书库中查找"{query}"相关作品。',
      pseoTitle: '{keyword}经典小说书单（{count}本必读） - {siteName}',
      pseoDescription: '与"{keyword}"相关的 {count} 本经典小说，本本口碑之作，{siteName}经典书库呈现。',
      pseoKeywords: '{keyword},经典小说,必读书单'
    },
    {
      label: '排行榜向',
      homeTitle: '{siteName} - 热门小说排行榜TOP阅读站',
      homeDescription: '{siteName}实时更新热门小说排行榜，人气爆款一网打尽，看看大家都在追什么书。',
      homeKeywords: '小说排行榜,热门小说,人气小说,{siteName},小说TOP',
      categoryTitle: '{categoryName}小说排行榜_最热{categoryName}推荐 - {siteName}',
      categoryDescription: '{siteName}{categoryName}排行榜，按人气热度排序的{categoryName}小说，跟着榜单读书不踩坑。',
      bookTitle: '上榜小说《{novelTitle}》_{author} - {siteName}',
      bookDescription: '《{novelTitle}》人气上榜作品，{author}所著，{statusText}。{descShort}',
      bookKeywords: '{novelTitle},{novelTitle}排行,热门{categoryName}小说',
      tocTitle: '{novelTitle}章节列表_人气作品 - {siteName}',
      tocDescription: '人气小说《{novelTitle}》章节列表，全站书友正在追的{statusText}作品。',
      chapterTitle: '{novelTitle} {chapterTitle} 人气连载 - {siteName}',
      chapterDescription: '《{novelTitle}》{chapterTitle}，人气作品精彩继续，{author}最新章节。',
      chapterKeywords: '{novelTitle},{chapterTitle},人气小说',
      searchTitle: '"{query}"人气作品搜索 - {siteName}',
      searchDescription: '{siteName}找到"{query}"相关人气小说，按热度排序呈现。',
      pseoTitle: '{keyword}热门小说榜（{count}本） - {siteName}',
      pseoDescription: '"{keyword}"相关热门小说 {count} 本按人气排序，{siteName}榜单实时更新。',
      pseoKeywords: '{keyword},热门榜,人气小说'
    },
    {
      label: '完结好书',
      homeTitle: '{siteName} - 完结小说大全_一次性读到爽',
      homeDescription: '{siteName}海量完结小说一次读个痛快，不用追更不用等更新，完结好书一步到位。',
      homeKeywords: '完结小说,全本小说,完本小说,{siteName},一次读完',
      categoryTitle: '完结{categoryName}小说_全本{categoryName}大全 - {siteName}',
      categoryDescription: '{siteName}完结{categoryName}小说专区，全部{statusText}作品放心入坑，告别追更等待。',
      bookTitle: '《{novelTitle}》全本阅读_{author}完本 - {siteName}',
      bookDescription: '《{novelTitle}》{statusText}，{author}完本作品，入坑即读到大结局。{descShort}',
      bookKeywords: '{novelTitle}全本,{novelTitle}完结,{author}完本',
      tocTitle: '{novelTitle}全本目录_完整章节 - {siteName}',
      tocDescription: '《{novelTitle}》全本章节目录，正文完结一次性读完，无断更烦恼。',
      chapterTitle: '{novelTitle}全本 第{idx}章 {chapterTitle} - {siteName}',
      chapterDescription: '《{novelTitle}》（{statusText}）第{idx}章{chapterTitle}，畅快阅读到大结局。',
      chapterKeywords: '{novelTitle}全本,{chapterTitle},大结局',
      searchTitle: '完结小说"{query}" - {siteName}',
      searchDescription: '"{query}"相关完结小说搜索结果，全本无忧阅读。',
      pseoTitle: '{keyword}完结小说精选（{count}本全本） - {siteName}',
      pseoDescription: '"{keyword}"相关完结小说 {count} 本，本本全本，{siteName}一次读到爽。',
      pseoKeywords: '{keyword},完结小说,全本推荐'
    },
    {
      label: '新书首发',
      homeTitle: '{siteName} - 新书首发_最新上架小说抢先读',
      homeDescription: '{siteName}新书首发专区，最新上架小说抢先阅读，做第一批读到好书的读者。',
      homeKeywords: '新书首发,最新小说,新书上架,{siteName},抢先读',
      categoryTitle: '最新{categoryName}小说_新书首发 - {siteName}',
      categoryDescription: '{siteName}{categoryName}新书区，最新上架{categoryName}小说抢先看，潜力新书别错过。',
      bookTitle: '新书《{novelTitle}》_{author}新作 - {siteName}',
      bookDescription: '《{novelTitle}》{author}最新作品，{statusText}。{descShort}新书首发就在{siteName}。',
      bookKeywords: '{novelTitle},新书,{author}新作',
      tocTitle: '{novelTitle}新章节目录_持续连载 - {siteName}',
      tocDescription: '新书《{novelTitle}》章节目录，{statusText}，从第一章开始追新。',
      chapterTitle: '{novelTitle} 第{idx}章 {chapterTitle} 新书连载 - {siteName}',
      chapterDescription: '新书《{novelTitle}》{chapterTitle}连载中，{author}全新故事开更。',
      chapterKeywords: '{novelTitle},新书连载,{author}',
      searchTitle: '新书搜索"{query}" - {siteName}',
      searchDescription: '"{query}"相关新书上架信息，{siteName}首发专区呈现。',
      pseoTitle: '{keyword}新书推荐（{count}本上新） - {siteName}',
      pseoDescription: '"{keyword}"相关新书 {count} 本已上架，{siteName}新书区抢先阅读。',
      pseoKeywords: '{keyword},新书推荐,上新'
    },
    {
      label: '文艺书香',
      homeTitle: '{siteName}｜一卷在手，书香满屋',
      homeDescription: '{siteName}愿做您的线上书房，网络文学与经典并存，安静阅读，享受文字之美。',
      homeKeywords: '网络文学,在线书房,{siteName},小说阅读,书香',
      categoryTitle: '{categoryName}文集_静品{categoryName}佳作 - {siteName}',
      categoryDescription: '{siteName}{categoryName}文集，静心甄选{categoryName}佳作，一杯茶一本书，慢慢读。',
      bookTitle: '《{novelTitle}》_{author}著 - {siteName}',
      bookDescription: '《{novelTitle}》，{author}著，{statusText}。{descShort}',
      bookKeywords: '{novelTitle},{author},文学作品',
      tocTitle: '《{novelTitle}》卷目_章节一览 - {siteName}',
      tocDescription: '《{novelTitle}》卷目章节一览，按序展卷，渐入佳境。',
      chapterTitle: '《{novelTitle}》· {chapterTitle} - {siteName}',
      chapterDescription: '《{novelTitle}》{chapterTitle}，{author}文字之美，与您共赏。',
      chapterKeywords: '{novelTitle},{chapterTitle},{author}',
      searchTitle: '书海寻径：{query} - {siteName}',
      searchDescription: '于{siteName}书海中为您寻得"{query}"相关作品。',
      pseoTitle: '以"{keyword}"为题的文学书单 - {siteName}',
      pseoDescription: '{siteName}甄选"{keyword}"主题作品 {count} 部，主题阅读，一次看全。',
      pseoKeywords: '{keyword},主题书单,文学'
    },
    {
      label: '轻快活泼',
      homeTitle: '{siteName} - 追文达人都在用的小说站',
      homeDescription: '{siteName}在手，好书不愁！玄幻脑洞、甜宠日常、悬疑反转，总有一款戳中你的爽点！',
      homeKeywords: '好看的小说,小说推荐,追文,{siteName},爽文',
      categoryTitle: '{categoryName}小说哪家强？来{siteName}看看',
      categoryDescription: '{siteName}{categoryName}书友力荐！好看不腻的{categoryName}小说都在这里，快来挑本下饭的！',
      bookTitle: '《{novelTitle}》超好看！{author}出品 - {siteName}',
      bookDescription: '《{novelTitle}》{statusText}！{author}用心之作，{descShort}不看后悔系列！',
      bookKeywords: '{novelTitle}好看吗,{novelTitle},{author}',
      tocTitle: '《{novelTitle}》章节速递 - {siteName}',
      tocDescription: '《{novelTitle}》章节速递，一键追更，精彩不断档！',
      chapterTitle: '{novelTitle}：{chapterTitle} - {siteName}',
      chapterDescription: '《{novelTitle}》{chapterTitle}来啦！{author}又一精彩更新！',
      chapterKeywords: '{novelTitle},{chapterTitle},追更',
      searchTitle: '搜"{query}"找到好书啦 - {siteName}',
      searchDescription: '"{query}"的相关小说都帮你找齐了，挑一本开读吧！',
      pseoTitle: '{keyword}控必看！{count}本高分小说 - {siteName}',
      pseoDescription: '喜欢"{keyword}"的书友看过来，{count} 本同款好文一次收藏！',
      pseoKeywords: '{keyword},{keyword}小说,高分推荐'
    },
    {
      label: '专业书评',
      homeTitle: '{siteName} - 深度小说阅读与评价平台',
      homeDescription: '{siteName}注重阅读质量，从文笔、节奏、世界观多维度收录优质小说，帮读者高效选书。',
      homeKeywords: '小说点评,优质小说,选书,{siteName},深度阅读',
      categoryTitle: '{categoryName}小说精选_按质量收录 - {siteName}',
      categoryDescription: '{siteName}{categoryName}精选区，从设定、文笔、剧情多维度筛选{categoryName}作品，选书不再靠运气。',
      bookTitle: '《{novelTitle}》小说详情_作者{author} - {siteName}',
      bookDescription: '《{novelTitle}》{statusText}，{author}作品。{descShort}阅读前先了解，选书更高效。',
      bookKeywords: '{novelTitle},小说详情,{author}作品',
      tocTitle: '《{novelTitle}》章节索引 - {siteName}',
      tocDescription: '《{novelTitle}》章节索引完整收录，支持按序连续阅读。',
      chapterTitle: '{novelTitle} 第{idx}章：{chapterTitle} - {siteName}',
      chapterDescription: '《{novelTitle}》第{idx}章{chapterTitle}全文，{author}作品连续阅读。',
      chapterKeywords: '{novelTitle} 第{idx}章,{chapterTitle}',
      searchTitle: '"{query}"作品检索 - {siteName}',
      searchDescription: '在{siteName}作品库中检索"{query}"，附作品信息一览。',
      pseoTitle: '{keyword}题材小说分析（{count}部） - {siteName}',
      pseoDescription: '{siteName}收录"{keyword}"题材作品 {count} 部，题材横向对比，按需选读。',
      pseoKeywords: '{keyword},题材小说,作品分析'
    },
    {
      label: '极简白描',
      homeTitle: '{siteName}',
      homeDescription: '{siteName}，在线小说阅读。分类清晰，检索快捷，即点即读。',
      homeKeywords: '{siteName},小说,在线阅读',
      categoryTitle: '{categoryName} - {siteName}',
      categoryDescription: '{siteName}{categoryName}分类小说列表。',
      bookTitle: '{novelTitle} - {author} - {siteName}',
      bookDescription: '《{novelTitle}》，{author}著，{statusText}。{descShort}',
      bookKeywords: '{novelTitle},{author}',
      tocTitle: '{novelTitle} 目录 - {siteName}',
      tocDescription: '《{novelTitle}》章节目录。',
      chapterTitle: '{novelTitle} · {chapterTitle} - {siteName}',
      chapterDescription: '《{novelTitle}》{chapterTitle}正文。',
      chapterKeywords: '{novelTitle},{chapterTitle}',
      searchTitle: '{query} - 搜索 - {siteName}',
      searchDescription: '"{query}"搜索结果。',
      pseoTitle: '{keyword} · 小说合集 - {siteName}',
      pseoDescription: '"{keyword}"相关小说 {count} 本。',
      pseoKeywords: '{keyword},小说'
    },
    {
      label: '清爽无广',
      homeTitle: '{siteName} - 无弹窗清爽小说阅读体验',
      homeDescription: '{siteName}拒绝弹窗骚扰，页面清爽加载快，专心看书不受打扰的纯净阅读站。',
      homeKeywords: '无弹窗小说,清爽阅读,纯净阅读,{siteName},无广告',
      categoryTitle: '{categoryName}小说_清爽阅读版 - {siteName}',
      categoryDescription: '{siteName}{categoryName}分类页无弹窗无浮层，{categoryName}小说安心挑选静心阅读。',
      bookTitle: '《{novelTitle}》纯净阅读页_{author} - {siteName}',
      bookDescription: '《{novelTitle}》{statusText}，{author}作品，{siteName}纯净页面无打扰阅读。{descShort}',
      bookKeywords: '{novelTitle},无弹窗阅读,{author}',
      tocTitle: '{novelTitle}目录页_无打扰追更 - {siteName}',
      tocDescription: '《{novelTitle}》目录页清爽直达，无弹窗干扰，安心追更。',
      chapterTitle: '{novelTitle} {chapterTitle} 纯净版 - {siteName}',
      chapterDescription: '《{novelTitle}》{chapterTitle}纯净阅读页，无弹窗无浮层专心看书。',
      chapterKeywords: '{novelTitle},{chapterTitle},纯净阅读',
      searchTitle: '{query}搜索_清爽版 - {siteName}',
      searchDescription: '"{query}"搜索结果页，无广告干扰快速直达。',
      pseoTitle: '{keyword}小说推荐_纯净阅读（{count}本） - {siteName}',
      pseoDescription: '"{keyword}"相关 {count} 本小说，{siteName}纯净页面无打扰阅读。',
      pseoKeywords: '{keyword},无弹窗小说,清爽阅读'
    },
    {
      label: '移动畅读',
      homeTitle: '{siteName} - 手机小说阅读神器',
      homeDescription: '{siteName}手机端流畅适配，流量省加载快，通勤路上碎片时间畅读海量小说。',
      homeKeywords: '手机小说,移动阅读,手机看书,{siteName},碎片阅读',
      categoryTitle: '手机看{categoryName}小说 - {siteName}',
      categoryDescription: '{siteName}{categoryName}分类手机端完美适配，通勤路上随时刷{categoryName}好书。',
      bookTitle: '手机追《{novelTitle}》_{author} - {siteName}',
      bookDescription: '《{novelTitle}》{statusText}，{author}作品，手机打开{siteName}随时随地追更。{descShort}',
      bookKeywords: '{novelTitle}手机阅读,{novelTitle},{author}',
      tocTitle: '{novelTitle}手机版目录 - {siteName}',
      tocDescription: '《{novelTitle}》手机版章节目录，单手滑动轻松追章。',
      chapterTitle: '{novelTitle} 第{idx}章 {chapterTitle}（手机版） - {siteName}',
      chapterDescription: '《{novelTitle}》{chapterTitle}手机阅读页，字号适中省眼省流量。',
      chapterKeywords: '{novelTitle}手机版,{chapterTitle}',
      searchTitle: '手机搜"{query}" - {siteName}',
      searchDescription: '"{query}"手机端搜索结果，即搜即读。',
      pseoTitle: '{keyword}手机小说推荐（{count}本） - {siteName}',
      pseoDescription: '"{keyword}"相关 {count} 本小说手机畅读，{siteName}移动端优化体验。',
      pseoKeywords: '{keyword},手机小说,移动阅读'
    },
    {
      label: '书友社区',
      homeTitle: '{siteName} - 千万书友的阅读社区',
      homeDescription: '{siteName}千万书友共同挑选，大家读什么、追什么、赞什么一目了然，和书友一起淘好书。',
      homeKeywords: '书友推荐,读者社区,书友交流,{siteName},大家都在读',
      categoryTitle: '书友都在追的{categoryName}小说 - {siteName}',
      categoryDescription: '{siteName}{categoryName}区书友热读中，跟着书友选{categoryName}小说，口碑有保障。',
      bookTitle: '书友热读《{novelTitle}》_{author} - {siteName}',
      bookDescription: '《{novelTitle}》{statusText}，{author}作品，书友口碑热读中。{descShort}',
      bookKeywords: '{novelTitle},书友推荐,{author}',
      tocTitle: '《{novelTitle}》书友共读目录 - {siteName}',
      tocDescription: '《{novelTitle}》章节目录，与书友同追共读，聊书不孤单。',
      chapterTitle: '{novelTitle} {chapterTitle} 书友共读 - {siteName}',
      chapterDescription: '《{novelTitle}》{chapterTitle}，{author}作品书友共读中。',
      chapterKeywords: '{novelTitle},{chapterTitle},书友',
      searchTitle: '书友都在搜"{query}" - {siteName}',
      searchDescription: '"{query}"的书友搜索热度结果，看看大家都在找什么。',
      pseoTitle: '{keyword}书友推荐榜（{count}本） - {siteName}',
      pseoDescription: '"{keyword}"相关书友推荐 {count} 本，真人书友口碑筛选，{siteName}呈现。',
      pseoKeywords: '{keyword},书友推荐,口碑小说'
    },
    {
      label: '编辑精选',
      homeTitle: '{siteName} - 编辑精选小说推荐站',
      homeDescription: '{siteName}编辑团队每日精读筛选，从海量新书中挑出值得读的好作品，把时间花在好故事上。',
      homeKeywords: '编辑推荐,精选小说,好书推荐,{siteName},编辑选书',
      categoryTitle: '编辑精选{categoryName}小说 - {siteName}',
      categoryDescription: '{siteName}编辑精选{categoryName}小说，人工严选弃坑率低，每一本都值得开始。',
      bookTitle: '编辑推荐《{novelTitle}》_{author} - {siteName}',
      bookDescription: '《{novelTitle}》编辑推荐作品，{author}所著，{statusText}。{descShort}',
      bookKeywords: '{novelTitle},编辑推荐,{author}小说',
      tocTitle: '《{novelTitle}》精选章节目录 - {siteName}',
      tocDescription: '编辑推荐《{novelTitle}》章节目录，{statusText}，值得从头读到尾。',
      chapterTitle: '{novelTitle} {chapterTitle} 编辑推荐 - {siteName}',
      chapterDescription: '《{novelTitle}》{chapterTitle}，编辑推荐作品的精彩一章。',
      chapterKeywords: '{novelTitle},{chapterTitle},编辑精选',
      searchTitle: '"{query}"编辑检索结果 - {siteName}',
      searchDescription: '{siteName}编辑库中"{query}"相关作品检索结果。',
      pseoTitle: '{keyword}编辑精选书单（{count}本） - {siteName}',
      pseoDescription: '{siteName}编辑严选"{keyword}"主题 {count} 本佳作，本本经过试读把关。',
      pseoKeywords: '{keyword},编辑精选,严选书单'
    }
  ];

  /** Task 31: 随机换一套——每个键独立从 18 套预设对应候选中抽取（含空候选过滤），组合成一套新 TDK 填入表单 */
  function shuffleSeoForm() {
    if (!TDK_PRESETS.length) return;
    SEO_KEYS.forEach(function (k) {
      var el = $('#adm-seo-' + k);
      if (!el) return;
      var pool = TDK_PRESETS.map(function (p) { return p[k] || ''; }).filter(function (v) { return v; });
      if (pool.length) el.value = pool[Math.floor(Math.random() * pool.length)];
    });
    toast('已从 ' + TDK_PRESETS.length + ' 套预设随机组合一套 TDK（保存后生效）', 'ok');
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
      try {
        await api('PATCH', '/api/settings', { footer: readFooterForm() });
        toast('页脚配置已保存', 'ok');
      } catch (e) { handleErr(e); }
    });

    $('#adm-footer-link-add').addEventListener('click', function () {
      var box = $('#adm-footer-links');
      if (box.children.length >= 10) return toast('页脚链接最多 10 个', 'err');
      box.insertAdjacentHTML('beforeend', footerLinkRowHtml('', ''));
    });

    // Task 32-a: 友情链接添加（上限 30 = 后端 footerFriendLinkCount）
    $('#adm-footer-friend-add').addEventListener('click', function () {
      var box = $('#adm-footer-friends');
      if (box.children.length >= 30) return toast('友情链接最多 30 个', 'err');
      box.insertAdjacentHTML('beforeend', friendLinkRowHtml('', ''));
    });

    $('#adm-set-seo-save').addEventListener('click', async function () {
      try {
        await api('PATCH', '/api/settings', { seo: readSeoForm() });
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
      // Task 31: 弹层关闭按钮双保险——模板只写 data-modal-close（漏 data-act）也能关闭
      var mc = e.target.closest('[data-modal-close]');
      if (mc && !mc.disabled) { closeModal(mc.dataset.modalClose); return; }
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
      } else if (act === 'novel-edit') {
        openNovelEdit(id);
      } else if (act === 'novel-chapters') {
        openChapters(id, btn.dataset.title || '');
      } else if (act === 'chapter-edit') {
        openChapterEdit(id);
      } else if (act === 'modal-close') {
        closeModal(btn.dataset.modalClose);
      } else if (act === 'seo-shuffle') { // Task 31: 18 套 TDK 预设随机组合填表
        shuffleSeoForm();
      } else if (act === 'footer-link-del') {
        var fl = btn.closest('.adm-footer-link');
        if (fl) fl.remove();
      } else if (act === 'footer-friend-del') { // Task 32-a: 友情链接行删除
        var ff = btn.closest('.adm-footer-friend');
        if (ff) ff.remove();
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
