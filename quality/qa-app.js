/* ============================================================
   质量系统 · 页面逻辑  quality/qa-app.js
   ------------------------------------------------------------
   【build .163】本文件是质量系统**唯一**的浏览器逻辑：登录卡片、系统切换、
   导航、表格、全选/选中、排序分页、新增/编辑弹窗、导出选中 CSV、只读提示条。

   三条硬约束（设计 §9.3 / PRD 5.3「代码共享——明确禁止」）：
     1. 不加载生产前端的任何脚本、不调用生产页面里的任何函数
        （表格渲染、工具栏、分页、弹窗、登录卡片全部在本目录内自实现，一个都不外借）；
     2. 不读写生产全局（服务端数据缓存、登录用户对象、列布局等一律不碰）；
     3. 与生产**只共享一个 sessionStorage 键** `wb_cb_prod_token`（同源同标签页 ⇒ 免二次登录），
        其余本地键一律 `wb_cb_qa_` 前缀。

   权限口径：写权限的唯一判定来自服务端 `GET /api/qa/me` 的 `canWrite` 布尔
   （服务端 canWrite(user) 是唯一实现）。本文件**绝不**自己判 role/perms。
   ============================================================ */
(function () {
  'use strict';

  /* ---------- 常量 ---------- */
  var CORE = window.QA_CORE;                       /* T01 冻结的共享内核（编号/排序/分页/CSV） */
  var TOKEN_KEY = 'wb_cb_prod_token';              /* 与生产逐字节一致：同源共享，只登录一次 */
  var API_PROD = '/api';                           /* 生产接口：仅用登录 / 改密两个端点 */
  var API_QA = '/api/qa';                          /* 质量系统接口 */
  var PAGE_SIZE_KEY = 'wb_cb_qa_pageSize_qaLog';   /* PRD 5.3 指定的分页键 */
  var PAGE_SIZES = [10, 100, 1000];
  var RETRY_DELAY_MS = 3000;                       /* 503 后 3 秒自动重试一次 */

  /* 系统清单：与生产侧各自维护**同构副本**（PRD P0-2 明文，不做跨文件共享） */
  var SYSTEMS = [
    { key: 'qa', name: '质量系统', url: '/quality/', icon: 'shield' },
    { key: 'prod', name: '生产排单系统', url: '/', icon: 'house' }
  ];

  /* 导航：新增质量表单 = 数组加一项 + renderTab 加一个渲染分支 */
  var QA_NAV = [
    { key: 'qaLog', name: '异常台账', title: '异常台账', icon: 'list' }
  ];

  /* ---------- 状态（单一 source of truth，全部渲染从它派生） ---------- */
  var state = {
    token: '',
    me: null,
    canWrite: false,
    canDel: false,
    records: [],
    rev: 0,
    version: '',
    sel: {},
    page: 1,
    pageSize: 100,
    sortKey: 'date',
    sortDir: 'desc',
    tab: 'qaLog',
    flashId: '',
    modalMode: '',
    modalId: '',
    modalNo: '',
    modalNoLoading: false,
    sysMenuOpen: false,
    retryTimer: null,
    busy: false
  };

  /* ---------- 小工具 ---------- */

  /** HTML 转义（所有插入 innerHTML 的外部数据都必须过这里） */
  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /**
   * 内联 SVG 图标（不引任何外部资源）。
   *
   * 【P0-1 修复】必须输出 width/height **presentation 属性**（18×18）：
   * 没有任何尺寸约束的 <svg> 会按容器 100% 撑开 —— 质量页曾因此把 `.card-title` 的图标
   * 渲染成 956×956px，卡片高度被顶到 1841px、工具栏被推出首屏（QA 真浏览器实测）。
   * 用 presentation attribute 而不是写死 style，是因为 CSS 类规则（如 `.btn svg{width:15px}`、
   * `.empty svg{width:40px}`）优先级高于它 ⇒ 各处既定尺寸完全不受影响；
   * 而任何**漏加 CSS 约束**的新容器都不会再爆（生产页靠行内 style 兜底，本页靠这里兜底）。
   */
  function ico(name) {
    var p = {
      shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
      house: '<path d="M2 20h20M5 20V8l7-5 7 5v12M9 20v-6h6v6"/>',
      list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
      download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>'
    };
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
      + (p[name] || '') + '</svg>';
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** 文件名时间戳：YYYYMMDD_HHMM */
  function stamp() {
    var d = new Date();
    return String(d.getFullYear()) + pad2(d.getMonth() + 1) + pad2(d.getDate())
      + '_' + pad2(d.getHours()) + pad2(d.getMinutes());
  }

  function mkErr(status, msg, json) {
    var e = new Error(msg || '请求失败');
    e.status = status;
    e.json = json || null;
    return e;
  }

  function $(id) { return document.getElementById(id); }

  /* ---------- token / 分页偏好（同一套键，与生产共享登录态） ---------- */
  function readToken() {
    try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }
  function writeToken(t) {
    try {
      if (t) sessionStorage.setItem(TOKEN_KEY, t);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* 隐私模式下 sessionStorage 可能不可写，忽略 */ }
  }
  function readPageSize() {
    try {
      var v = parseInt(localStorage.getItem(PAGE_SIZE_KEY), 10);
      return PAGE_SIZES.indexOf(v) >= 0 ? v : CORE.DEFAULT_PAGE_SIZE;
    } catch (e) { return CORE.DEFAULT_PAGE_SIZE; }
  }
  function writePageSize(v) {
    try { localStorage.setItem(PAGE_SIZE_KEY, String(v)); } catch (e) { /* 忽略 */ }
  }

  /* ---------- 顶部提示条（503 等非阻塞提示，可关闭） ---------- */
  function showNotice(msg, withRetry) {
    var el = $('qaNotice');
    if (!el) return;
    el.innerHTML = '<span>' + esc(msg) + '</span>'
      + (withRetry ? '<button class="btn btn-sm" onclick="QA_APP.retryNow()">重试</button>' : '')
      + '<button class="btn btn-sm" onclick="QA_APP.hideNotice()">关闭</button>';
    el.classList.add('show');
  }
  function hideNotice() {
    var el = $('qaNotice');
    if (el) { el.classList.remove('show'); el.innerHTML = ''; }
  }

  /* ---------- 接口层：统一 401 / 503 处理 ---------- */
  /**
   * 调质量系统接口。
   * · 401 ⇒ 清 token + 登录卡片（并抛 status=401，调用方无需再处理）
   * · 503 ⇒ 抛 status=503（鉴权服务不可用，fail-closed）
   * · 其它非 2xx ⇒ 抛 status=HTTP 码 + 服务端中文消息
   * @param {string} path 以 / 开头的质量系统路径
   * @param {{method: string=, body: string=, headers: object=}=} opts
   * @returns {Promise<object>} 解析后的 JSON
   */
  async function apiQa(path, opts) {
    var o = opts || {};
    var headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers || {});
    if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
    var resp;
    try {
      resp = await fetch(API_QA + path, { method: o.method || 'GET', headers: headers, body: o.body });
    } catch (e) {
      throw mkErr(0, '无法连接服务器，请稍后重试', null);
    }
    var json = null;
    try { json = await resp.json(); } catch (e) { json = null; }
    if (resp.status === 401) {
      onUnauthorized();
      throw mkErr(401, '未登录或登录已过期', json);
    }
    if (resp.status === 503) {
      throw mkErr(503, '鉴权服务暂不可用，请稍后重试', json);
    }
    if (!resp.ok) {
      throw mkErr(resp.status, (json && json.error) || ('请求失败（' + resp.status + '）'), json);
    }
    return json || {};
  }

  /** 统一的错误出口：401 已在 apiQa 内处理；503 提示 + 自动重试一次；其余 alert */
  function handleApiError(e) {
    if (!e) return;
    if (e.status === 401) return;
    if (e.status === 503) {
      showNotice('鉴权服务暂不可用，' + (RETRY_DELAY_MS / 1000) + ' 秒后自动重试…', true);
      scheduleRetry();
      return;
    }
    alert(e.message || '操作失败');
  }

  function scheduleRetry() {
    if (state.retryTimer) return;                       /* 只重试一次，不形成重试风暴 */
    state.retryTimer = setTimeout(function () {
      state.retryTimer = null;
      reloadAll();
    }, RETRY_DELAY_MS);
  }

  function onUnauthorized() {
    state.token = '';
    state.me = null;
    state.canWrite = false;
    state.canDel = false;
    state.records = [];
    state.sel = {};
    writeToken('');
    renderMain();
    showLogin('登录已过期，请重新登录');
  }

  /* ---------- 登录卡片（照生产内联样式重写，不引其函数/样式类） ---------- */
  function showLogin(msg) {
    var el = $('qaLoginBox');
    if (!el) {
      el = document.createElement('div');
      el.id = 'qaLoginBox';
      el.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:300;display:flex;align-items:center;justify-content:center';
      el.innerHTML = '<div style="background:#fff;border-radius:12px;padding:28px 30px;width:340px;box-shadow:0 20px 60px rgba(0,0,0,.25)">'
        + '<h2 style="font-size:17px;margin-bottom:2px;display:flex;align-items:center;gap:6px">'
        + '<svg viewBox="0 0 24 24" fill="none" stroke="#4f46e5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:18px;height:18px"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>'
        + '质量系统</h2>'
        + '<div style="font-size:12px;color:#94a3b8;margin-bottom:16px">多员工在线版 · 请登录</div>'
        + '<label>用户名</label><input id="qaLoginUser" style="margin-bottom:10px">'
        + '<label>密码</label><input id="qaLoginPwd" type="password" style="margin-bottom:4px">'
        + '<div id="qaLoginErr" style="color:#ef4444;font-size:12px;min-height:18px;margin-top:4px">' + esc(msg || '') + '</div>'
        + '<button class="btn btn-primary" style="width:100%;justify-content:center" onclick="QA_APP.doLogin()">登 录</button>'
        + '</div>';
      document.body.appendChild(el);
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') doLogin();
      });
    } else if (msg) {
      var err = el.querySelector('#qaLoginErr');
      if (err) err.textContent = msg;
    }
    el.style.display = 'flex';
    setTimeout(function () {
      var u = $('qaLoginUser');
      if (u && !u.value) u.focus();
    }, 30);
  }

  function hideLogin() {
    var el = $('qaLoginBox');
    if (el) el.style.display = 'none';
  }

  async function doLogin() {
    var uEl = $('qaLoginUser');
    var pEl = $('qaLoginPwd');
    var errEl = $('qaLoginErr');
    var u = uEl ? String(uEl.value || '').trim() : '';
    var p = pEl ? String(pEl.value || '') : '';
    if (errEl) errEl.textContent = '';
    if (!u || !p) {
      if (errEl) errEl.textContent = '请输入用户名和密码';
      return;
    }
    var resp;
    try {
      resp = await fetch(API_PROD + '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: p })
      });
    } catch (e) {
      if (errEl) errEl.textContent = '无法连接服务器';
      return;
    }
    var j = null;
    try { j = await resp.json(); } catch (e) { j = null; }
    if (!resp.ok) {
      if (errEl) errEl.textContent = (j && j.error) || '登录失败';
      return;
    }
    state.token = j.token || '';
    writeToken(state.token);
    hideLogin();
    await reloadAll();
    /* 沿用生产系统的弱口令提示口径（初始/被重置密码登录后提示改密） */
    if (j.mustChangePwd) {
      setTimeout(function () {
        alert('当前账号使用的是初始密码或已被重置的密码，存在安全风险。\n请尽快通过右上角「改密」修改为个人密码。');
      }, 300);
    }
  }

  function logout() {
    if (!confirm('确认退出登录？')) return;
    state.token = '';
    state.me = null;
    state.canWrite = false;
    state.canDel = false;
    state.records = [];
    state.sel = {};
    writeToken('');
    renderMain();
    showLogin('');            /* 退出后停留在质量系统，不跳回生产系统（PRD 5.2） */
  }

  /* ---------- 改密（复用生产 POST /api/change-pwd） ---------- */
  function pwdModal() {
    openModalShell('修改密码',
      '<div class="form-row"><div><label>原密码</label><input id="cp_old" type="password"></div></div>'
      + '<div class="form-row"><div><label>新密码</label><input id="cp_new" type="password"></div></div>'
      + '<div class="form-row"><div><label>确认新密码</label><input id="cp_new2" type="password"></div></div>',
      '保存', 'QA_APP.savePwd()');
  }

  async function savePwd() {
    var o = $('cp_old') ? $('cp_old').value : '';
    var n1 = $('cp_new') ? $('cp_new').value : '';
    var n2 = $('cp_new2') ? $('cp_new2').value : '';
    if (!o || !n1) { alert('请填写完整'); return; }
    if (n1.length < 6) { alert('新密码至少6位'); return; }
    if (n1 !== n2) { alert('两次新密码不一致'); return; }
    try {
      var r = await fetch(API_PROD + '/change-pwd', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
        body: JSON.stringify({ old: o, new: n1 })
      });
      var j = null;
      try { j = await r.json(); } catch (e) { j = null; }
      if (!r.ok) { alert((j && j.error) || '修改失败'); return; }
      if (state.me) delete state.me.mustChangePwd;
      alert('密码已修改');
      closeModal();
    } catch (e) {
      alert('修改失败');
    }
  }

  /* ---------- 系统切换下拉 ---------- */
  function renderSysMenu() {
    var el = $('sysMenu');
    if (!el) return;
    el.innerHTML = SYSTEMS.map(function (s) {
      var isCur = s.key === 'qa';          /* 本页固定是质量系统，故当前项恒为 qa */
      return '<div class="sys-menu-item' + (isCur ? ' cur' : '') + '"'
        + ' onclick="QA_APP.pickSystem(event,\'' + s.key + '\')">'
        + ico(s.icon) + '<span>' + esc(s.name) + '</span>'
        + (isCur ? '<span class="ck">✓</span>' : '')
        + '</div>';
    }).join('');
  }

  function toggleSysMenu(ev) {
    if (ev) ev.stopPropagation();
    var el = $('sysMenu');
    if (!el) return;
    state.sysMenuOpen = !state.sysMenuOpen;
    if (state.sysMenuOpen) el.classList.add('show');
    else el.classList.remove('show');
  }

  function closeSysMenu() {
    state.sysMenuOpen = false;
    var el = $('sysMenu');
    if (el) el.classList.remove('show');
  }

  /** 点面板项：当前系统只关面板；生产系统同标签页跳转（sessionStorage 同源共享 ⇒ 免登录） */
  function pickSystem(ev, key) {
    if (ev) ev.stopPropagation();
    closeSysMenu();
    if (key === 'qa') return;
    var target = null;
    for (var i = 0; i < SYSTEMS.length; i++) if (SYSTEMS[i].key === key) target = SYSTEMS[i];
    if (!target) return;
    location.href = target.url;
  }

  /* ---------- 侧边栏 ---------- */
  function toggleSidebarCollapse() {
    var sb = $('sidebar');
    if (sb) sb.classList.toggle('collapsed');
  }

  function toggleSidebar() {
    var sb = $('sidebar');
    var ov = $('overlay');
    if (!sb) return;
    var open = sb.classList.toggle('open');
    if (ov) ov.classList.toggle('show', open);
  }

  /* ---------- 导航 ---------- */
  function currentNav() {
    for (var i = 0; i < QA_NAV.length; i++) if (QA_NAV[i].key === state.tab) return QA_NAV[i];
    return QA_NAV[0];
  }

  function renderNav() {
    var el = $('nav');
    if (!el) return;
    el.innerHTML = QA_NAV.map(function (n) {
      return '<div class="nav-item' + (n.key === state.tab ? ' active' : '') + '"'
        + ' onclick="QA_APP.switchTab(\'' + n.key + '\')">' + ico(n.icon) + '<span>' + esc(n.name) + '</span></div>';
    }).join('');
  }

  function switchTab(key) {
    state.tab = key;
    state.page = 1;
    clearSel();
    renderNav();
    renderMain();
    var sb = $('sidebar');
    var ov = $('overlay');
    if (sb && sb.classList.contains('open')) {
      sb.classList.remove('open');
      if (ov) ov.classList.remove('show');
    }
  }

  /* ---------- 数据加载 ---------- */
  async function refreshMe() {
    var j = await apiQa('/me');
    state.me = j.user || null;
    state.canWrite = j.canWrite === true;      /* 权限唯一来源：服务端派生值，前端不自己判 */
    state.canDel = j.canDel === true;
  }

  async function loadList() {
    var j = await apiQa('/exceptions');
    state.records = Array.isArray(j.records) ? j.records : [];
    state.rev = j.rev || 0;
    state.version = j.version || '';
    pruneSel();
  }

  async function reloadAll() {
    if (!state.token) { renderMain(); return; }
    try {
      await refreshMe();
      await loadList();
      hideNotice();
    } catch (e) {
      handleApiError(e);
    }
    renderMain();
  }

  /* ---------- 选中态 ---------- */
  function selIds() {
    return Object.keys(state.sel).filter(function (id) { return !!state.sel[id]; });
  }
  function selCount() { return selIds().length; }

  function clearSel() {
    state.sel = {};
  }

  /** 选中集合里剔除已不存在的记录（他人删除后本地残留会导致「已选 1 项」但找不到行） */
  function pruneSel() {
    var alive = {};
    state.records.forEach(function (r) { if (r && r.id) alive[r.id] = true; });
    Object.keys(state.sel).forEach(function (id) {
      if (!alive[id]) delete state.sel[id];
    });
  }

  function findRec(id) {
    for (var i = 0; i < state.records.length; i++) if (state.records[i].id === id) return state.records[i];
    return null;
  }

  function orderedRecords() {
    return CORE.sortRecords(state.records, state.sortKey, state.sortDir);
  }

  function currentPageIds() {
    var pg = CORE.paginate(orderedRecords(), state.page, state.pageSize);
    return pg.rows.map(function (r) { return r.id; });
  }

  function toggleRow(id) {
    if (!id) return;
    if (state.sel[id]) delete state.sel[id];
    else state.sel[id] = true;
    updateSelUI();
  }

  /** 全选 = 选中**当前页全部行**；再点一次清空当前页选中（语义与生产一致） */
  function toggleSelAll() {
    var ids = currentPageIds();
    var allOn = ids.length > 0 && ids.every(function (id) { return !!state.sel[id]; });
    ids.forEach(function (id) {
      if (allOn) delete state.sel[id];
      else state.sel[id] = true;
    });
    updateSelUI();
  }

  /**
   * 局部刷新复选框与计数 —— **不重建表格 DOM**（避免焦点丢失/滚动跳动）。
   * 同时维护全选框的 checked / indeterminate 两态。
   */
  function updateSelUI() {
    var n = selCount();
    var cnt = $('selCount');
    if (cnt) cnt.textContent = '已选 ' + n + ' 项';
    var btn = $('exportBtn');
    if (btn) {
      if (n > 0) { btn.removeAttribute('disabled'); btn.title = '导出选中 ' + n + ' 条为 CSV'; }
      else { btn.setAttribute('disabled', 'disabled'); btn.title = '请先勾选要导出的记录'; }
    }
    var rows = document.querySelectorAll('#content .table-wrap tbody tr[data-id]');
    for (var i = 0; i < rows.length; i++) {
      var id = rows[i].getAttribute('data-id');
      var on = !!state.sel[id];
      if (on) rows[i].classList.add('row-sel');
      else rows[i].classList.remove('row-sel');
      var cb = rows[i].querySelector('input[type=checkbox]');
      if (cb) cb.checked = on;
    }
    var all = $('ckAll');
    if (all) {
      var ids = currentPageIds();
      var onPage = ids.filter(function (id) { return !!state.sel[id]; }).length;
      all.checked = ids.length > 0 && onPage === ids.length;
      all.indeterminate = onPage > 0 && onPage < ids.length;
    }
  }

  /* ---------- 渲染：主区 ---------- */
  function renderMain() {
    var el = $('content');
    if (!el) return;
    var nav = currentNav();
    var t1 = $('pageTitle');
    var t2 = $('mobileTitle');
    if (t1) t1.textContent = nav.title;
    if (t2) t2.textContent = nav.title;
    if (!state.token || !state.me) { el.innerHTML = ''; return; }

    var h = '';
    if (!state.canWrite) h += readonlyBarHtml();
    h += '<div class="card">';
    h += '<div class="card-title">' + ico('list') + '异常台账'
      + '<span class="desc">异常记录 · 质量问题登记与追溯</span></div>';
    h += toolbarHtml();
    h += tableHtml();
    h += '</div>';
    el.innerHTML = h;
    updateSelUI();
  }

  /** 只读提示条：不可关闭；有 qa 权限时不渲染（PRD 7.3） */
  function readonlyBarHtml() {
    return '<div class="readonly-bar"><span style="font-weight:700">ⓘ</span>'
      + '<span>当前为只读访问（未获「质量管理」编辑权限），如需登记异常请联系管理员在「员工管理 → 表单写权限」中授权。</span></div>';
  }

  function toolbarHtml() {
    var n = selCount();
    var h = '<div class="bulk-bar">';
    h += '<label class="ck-all"><input type="checkbox" id="ckAll" onclick="QA_APP.toggleSelAll()">全选</label>';
    /* 只读用户：新增/编辑**完全不渲染**（与生产系统对表单级只读的既有做法一致，PRD 7.3） */
    if (state.canWrite) {
      h += '<button class="btn btn-sm btn-primary" onclick="QA_APP.openAddModal()">' + ico('plus') + '新增</button>';
      h += '<button class="btn btn-sm" onclick="QA_APP.openEditModal()">' + ico('edit') + '编辑</button>';
    }
    /* 导出选中：读操作，**只读用户也可用**（这是全选在当前阶段唯一有意义的落点） */
    h += '<button class="btn btn-sm" id="exportBtn" onclick="QA_APP.exportSelected()"'
      + (n > 0 ? '' : ' disabled') + ' title="' + (n > 0 ? '导出选中 ' + n + ' 条为 CSV' : '请先勾选要导出的记录') + '">'
      + ico('download') + '导出选中</button>';
    h += '<span class="sel-count" id="selCount">已选 ' + n + ' 项</span>';
    h += pagerHtml();
    h += '</div>';
    return h;
  }

  function pagerHtml() {
    var total = state.records.length;
    var size = state.pageSize;
    var pages = total === 0 ? 1 : Math.ceil(total / size);
    var pg = state.page > pages ? pages : state.page;
    if (pg < 1) pg = 1;
    var h = '<span class="tbl-pager">';
    h += '<span>共 ' + total + ' 条明细 · 第 '
      + '<input type="text" value="' + pg + '" onkeydown="if(event.key===\'Enter\')QA_APP.jumpPage(this.value)"'
      + ' onchange="QA_APP.jumpPage(this.value)"> 页 / 共 ' + pages + ' 页</span>';
    h += '<button class="btn btn-sm"' + (pg <= 1 ? ' disabled' : '') + ' onclick="QA_APP.goPage(1)" title="第一页">|◀</button>';
    h += '<button class="btn btn-sm"' + (pg <= 1 ? ' disabled' : '') + ' onclick="QA_APP.goPage(' + (pg - 1) + ')" title="上一页">◀</button>';
    h += '<button class="btn btn-sm"' + (pg >= pages ? ' disabled' : '') + ' onclick="QA_APP.goPage(' + (pg + 1) + ')" title="下一页">▶</button>';
    h += '<button class="btn btn-sm"' + (pg >= pages ? ' disabled' : '') + ' onclick="QA_APP.goPage(' + pages + ')" title="最后一页">▶|</button>';
    h += '<select onchange="QA_APP.changePageSize(this.value)">';
    for (var i = 0; i < PAGE_SIZES.length; i++) {
      h += '<option value="' + PAGE_SIZES[i] + '"' + (PAGE_SIZES[i] === size ? ' selected' : '') + '>' + PAGE_SIZES[i] + '条/页</option>';
    }
    h += '</select></span>';
    return h;
  }

  function sortTh(key, label) {
    var on = state.sortKey === key;
    var arrow = on ? (state.sortDir === 'asc' ? '▲' : '▼') : '⇅';
    return '<th class="th-sort" onclick="QA_APP.sortBy(\'' + key + '\')">' + esc(label)
      + '<span class="sort-ico' + (on ? ' on' : '') + '">' + arrow + '</span></th>';
  }

  function tableHtml() {
    var pg = CORE.paginate(orderedRecords(), state.page, state.pageSize);
    state.page = pg.page;                    /* 夹紧后的页码回写，保证分页器与表体一致 */
    var rows = pg.rows;
    if (!rows.length) return emptyHtml();
    var h = '<div class="table-wrap"><table><thead><tr>'
      + '<th class="sel-col"></th>'
      + sortTh('date', '日期')
      + sortTh('no', '编号')
      + '</tr></thead><tbody>';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var id = esc(r.id);
      var cls = (state.sel[r.id] ? ' row-sel' : '') + (state.flashId === r.id ? ' row-flash' : '');
      h += '<tr data-id="' + id + '"' + (cls ? ' class="' + cls.trim() + '"' : '')
        + ' onclick="QA_APP.toggleRow(\'' + id + '\')">';
      h += '<td class="sel-col"><input type="checkbox"' + (state.sel[r.id] ? ' checked' : '')
        + ' onclick="event.stopPropagation();QA_APP.toggleRow(\'' + id + '\')"></td>';
      h += '<td>' + esc(r.date) + '</td>';
      h += '<td>' + esc(r.no) + '</td>';
      h += '</tr>';
    }
    h += '</tbody></table></div>';
    return h;
  }

  function emptyHtml() {
    var h = '<div class="table-wrap"><div class="empty">' + ico('list') + '<div>暂无异常记录</div>';
    if (state.canWrite) {
      h += '<button class="btn btn-sm btn-primary" onclick="QA_APP.openAddModal()">' + ico('plus') + '新增</button>';
    }
    h += '</div></div>';
    return h;
  }

  /* ---------- 排序 / 分页 ---------- */
  function sortBy(key) {
    if (key !== 'date' && key !== 'no') return;
    if (state.sortKey === key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    else { state.sortKey = key; state.sortDir = 'desc'; }
    state.page = 1;                       /* 排序后回第 1 页 */
    renderMain();
  }

  function goPage(p) {
    state.page = Number(p) || 1;
    renderMain();
  }

  function jumpPage(v) {
    var n = parseInt(String(v), 10);
    if (!isFinite(n)) { renderMain(); return; }
    goPage(n);
  }

  function changePageSize(v) {
    var n = parseInt(String(v), 10);
    if (PAGE_SIZES.indexOf(n) < 0) return;
    state.pageSize = n;
    writePageSize(n);
    state.page = 1;
    renderMain();
  }

  /* ---------- 弹窗 ---------- */
  /**
   * 弹窗外壳。
   * @param {string} title 标题
   * @param {string} bodyHtml 弹窗体 HTML
   * @param {string} okText 主按钮文案
   * @param {string=} okHandler 主按钮点击调用的 QA_APP 方法调用串
   *        （异常台账弹窗与改密弹窗共用外壳，但提交函数不同 —— 必须由调用方指定，
   *          否则改密会误触台账的日期校验）
   */
  function openModalShell(title, bodyHtml, okText, okHandler) {
    var m = $('modal');
    var bg = $('modalBg');
    if (!m || !bg) return;
    var handler = okHandler || 'QA_APP.saveModal()';
    m.innerHTML = '<div class="modal-head"><h3>' + esc(title) + '</h3>'
      + '<div class="close-x" onclick="QA_APP.closeModal()">'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px;height:18px"><path d="M18 6L6 18M6 6l12 12"/></svg>'
      + '</div></div>'
      + '<div class="modal-body">' + bodyHtml + '</div>'
      + '<div class="modal-foot"><button class="btn" onclick="QA_APP.closeModal()">取消</button>'
      + '<button class="btn btn-primary" id="qaSaveBtn" onclick="' + handler + '">' + esc(okText || '保存') + '</button></div>';
    bg.classList.add('show');
  }

  function closeModal() {
    var bg = $('modalBg');
    if (bg) bg.classList.remove('show');
    state.modalMode = '';
    state.modalId = '';
    state.modalNo = '';
    state.modalNoLoading = false;
  }

  function recordFormHtml(date, no, noHint) {
    return '<div class="form-row"><div><label>日期 *</label>'
      + '<input type="date" id="qa_f_date" value="' + esc(date) + '"></div></div>'
      + '<div class="form-row"><div><label>编号</label>'
      + '<input id="qa_f_no" value="' + esc(no) + '" readonly>'
      + '<div class="hint" id="qa_f_no_hint">' + esc(noHint) + '</div></div></div>';
  }

  function openAddModal() {
    if (!state.canWrite) return;
    state.modalMode = 'add';
    state.modalId = '';
    state.modalNo = '';
    state.modalNoLoading = true;
    openModalShell('新增异常记录',
      recordFormHtml(CORE.todayStr(), '', '正在向服务端申请编号…'), '保存');
    setSaveBtnEnabled(false);
    /* 打开弹窗即预生成编号并只读展示（让用户保存前就看到号，PRD 5.5） */
    apiQa('/next-no').then(function (j) {
      state.modalNo = (j && j.no) || '';
      state.modalNoLoading = false;
      var el = $('qa_f_no');
      if (el) el.value = state.modalNo;
      var hint = $('qa_f_no_hint');
      if (hint) hint.textContent = '系统自动生成，不可修改';
      setSaveBtnEnabled(true);
    }).catch(function (e) {
      state.modalNoLoading = false;
      var hint = $('qa_f_no_hint');
      if (hint) hint.textContent = '编号将由服务端在保存时生成';
      setSaveBtnEnabled(true);
      if (e && e.status !== 401 && e.status !== 403) handleApiError(e);
    });
  }

  function openEditModal() {
    if (!state.canWrite) return;
    var ids = selIds();
    if (ids.length === 0) {
      alert('请先在左侧勾选要编辑的记录');       /* 文案与生产逐字节一致 */
      return;
    }
    if (ids.length > 1) {
      alert('「编辑」仅支持选中单条记录，当前已选 ' + ids.length + ' 条。请只勾选一条再操作。');
      return;
    }
    var rec = findRec(ids[0]);
    if (!rec) { alert('记录不存在，请刷新后重试'); return; }
    state.modalMode = 'edit';
    state.modalId = rec.id;
    state.modalNo = rec.no;
    state.modalNoLoading = false;
    openModalShell('编辑异常记录',
      recordFormHtml(rec.date, rec.no, '系统自动生成，不可修改'), '保存');
    setSaveBtnEnabled(true);
  }

  function setSaveBtnEnabled(on) {
    var b = $('qaSaveBtn');
    if (!b) return;
    if (on) b.removeAttribute('disabled');
    else b.setAttribute('disabled', 'disabled');
  }

  async function saveModal() {
    var dateEl = $('qa_f_date');
    var date = dateEl ? String(dateEl.value || '').trim() : '';
    if (!date || !CORE.isValidDate(date)) {
      alert('请填写正确的日期（YYYY-MM-DD）');
      if (dateEl) dateEl.focus();
      return;
    }
    if (state.modalMode === 'add') await submitAdd(date);
    else if (state.modalMode === 'edit') await submitEdit(date);
  }

  async function submitAdd(date) {
    if (state.modalNoLoading) { alert('编号申请中，请稍候…'); return; }
    if (state.busy) return;
    state.busy = true;
    setSaveBtnEnabled(false);
    var body = { date: date };
    if (state.modalNo) body.no = state.modalNo;
    try {
      var j;
      try {
        j = await apiQa('/exceptions', { method: 'POST', body: JSON.stringify(body) });
      } catch (e) {
        /* 409：编号被别人抢先占用 ⇒ 用服务端 suggest **静默重提交一次**，用户无感（PRD P0-10） */
        if (e.status === 409 && e.json && e.json.suggest) {
          body.no = e.json.suggest;
          j = await apiQa('/exceptions', { method: 'POST', body: JSON.stringify(body) });
        } else {
          throw e;
        }
      }
      closeModal();
      clearSel();
      state.page = 1;                       /* 保存后回到第 1 页 */
      var newId = (j && j.record && j.record.id) || '';
      await loadList();
      state.flashId = newId;                /* 新行高亮 1.5s */
      renderMain();
      setTimeout(function () { state.flashId = ''; }, 1600);
    } catch (e) {
      /* 500（落盘失败）等：**不关闭弹窗**，保住用户已填内容 */
      handleApiError(e);
      setSaveBtnEnabled(true);
    } finally {
      state.busy = false;
    }
  }

  async function submitEdit(date) {
    if (state.busy) return;
    state.busy = true;
    setSaveBtnEnabled(false);
    try {
      var j = await apiQa('/exceptions/' + encodeURIComponent(state.modalId), {
        method: 'PUT',
        body: JSON.stringify({ date: date })
      });
      var rec = (j && j.record) || null;
      closeModal();
      clearSel();
      /* 就地更新该行（不整表重绘 ⇒ 保住滚动位置，设计 §4.4） */
      if (rec) applyRowUpdate(rec);
      updateSelUI();
    } catch (e) {
      handleApiError(e);
      setSaveBtnEnabled(true);
    } finally {
      state.busy = false;
    }
  }

  /** 用服务端返回的权威记录替换本地副本，并只重绘那一行的两个单元格 */
  function applyRowUpdate(rec) {
    for (var i = 0; i < state.records.length; i++) {
      if (state.records[i].id === rec.id) { state.records[i] = rec; break; }
    }
    var tr = document.querySelector('#content .table-wrap tbody tr[data-id="' + rec.id + '"]');
    if (!tr) { renderMain(); return; }
    var tds = tr.querySelectorAll('td');
    if (tds.length >= 3) {
      tds[1].textContent = rec.date;
      tds[2].textContent = rec.no;
    }
    tr.classList.add('row-flash');
    setTimeout(function () { tr.classList.remove('row-flash'); }, 1600);
  }

  /* ---------- 导出选中（CSV / UTF-8 BOM，Excel 双击直开） ---------- */
  function exportSelected() {
    var rows = state.records.filter(function (r) { return !!state.sel[r.id]; });
    if (!rows.length) {
      alert('请先勾选要导出的记录');
      return;
    }
    var sorted = CORE.sortRecords(rows, state.sortKey, state.sortDir);
    var csv = CORE.buildCsv(sorted, [{ key: 'date', label: '日期' }, { key: 'no', label: '编号' }]);
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = '异常台账_' + stamp() + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  /* ---------- 初始化 ---------- */
  function init() {
    /* 点遮罩关闭弹窗 */
    var bg = $('modalBg');
    if (bg) {
      bg.addEventListener('click', function (e) {
        if (e.target === bg) closeModal();
      });
    }
    /* 点面板外 / ESC 关闭系统切换面板 */
    document.addEventListener('click', function () {
      if (state.sysMenuOpen) closeSysMenu();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (state.sysMenuOpen) closeSysMenu();
        var mb = $('modalBg');
        if (mb && mb.classList.contains('show')) closeModal();
      }
    });
    renderSysMenu();
    renderNav();
    boot();
  }

  async function boot() {
    state.token = readToken();
    state.pageSize = readPageSize();
    if (!state.token) {
      showLogin('');
      renderMain();
      return;
    }
    await reloadAll();
    /* 注：/api/qa/me 只返回 {username,name,role,perms}（服务端白名单刻意剔除 mustChangePwd），
       故「待改密」提示只在登录响应里判断，恢复登录态时不重复打扰用户。 */
  }

  /* ---------- 对外接口（HTML 内联 onclick 只依赖这一个对象） ---------- */
  window.QA_APP = {
    sys: SYSTEMS,
    nav: QA_NAV,
    state: state,
    /* 登录 / 会话 */
    doLogin: doLogin,
    logout: logout,
    pwdModal: pwdModal,
    savePwd: savePwd,
    /* 系统切换 */
    toggleSysMenu: toggleSysMenu,
    closeSysMenu: closeSysMenu,
    pickSystem: pickSystem,
    /* 侧边栏 / 导航 */
    toggleSidebar: toggleSidebar,
    toggleSidebarCollapse: toggleSidebarCollapse,
    switchTab: switchTab,
    /* 表格交互 */
    toggleRow: toggleRow,
    toggleSelAll: toggleSelAll,
    sortBy: sortBy,
    goPage: goPage,
    jumpPage: jumpPage,
    changePageSize: changePageSize,
    /* 增改 */
    openAddModal: openAddModal,
    openEditModal: openEditModal,
    saveModal: saveModal,
    closeModal: closeModal,
    /* 导出 / 提示 */
    exportSelected: exportSelected,
    retryNow: function () { hideNotice(); reloadAll(); },
    hideNotice: hideNotice,
    /* 供排障与自动化验收使用的只读视图 */
    render: renderMain
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
