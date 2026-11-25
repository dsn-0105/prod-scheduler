/* ============================================================
   管理员后台 · 页面逻辑  admin/admin-app.js
   ------------------------------------------------------------
   【build 2026-11-25.001】本文件是「管理员后台」**唯一**的浏览器逻辑：
   登录卡片、系统切换、导航、员工表格、新增/编辑员工弹窗、权限三态面板、
   保存 / 删除员工、无权访问态、权限元数据降级。本期导航只有「员工管理」
   （该功能原本长在生产 index.html 里，build .164 整体迁到本目录）。

   三条硬约束（与质量系统同款，写死在这里便于审计）：
     1. 不加载生产前端 / 质量系统的任何脚本、不调用其任何函数
        （表格、工具栏、弹窗、登录卡片、权限面板全部在本目录内自实现，一个都不外借）；
     2. 不读写生产全局（服务端数据缓存、登录用户对象、列布局等一律不碰）；
     3. 与生产**只共享一个 sessionStorage 键** `wb_cb_prod_token`（同源同标签页 ⇒ 免二次登录），
        其余本地键一律 `wb_cb_admin_` 前缀。

   门禁（方案 A：纯静态页 + 复用生产现成接口，**不新建后端进程/数据文件/代理**）：
     · GET /api/me        → 判角色；非 admin 一律渲染「无权访问」，**绝不**再调其它接口
     · GET /api/users     → 员工增删改查（生产后端 `/api/users` 自带 admin 硬闸，非 admin 恒 403）
     · GET /api/perm-meta → 权限元数据（权限点显示名 / 表单键映射 / 动作键文案）**唯一来源**。
       本文件**不得**自建第二份权限清单字面量：左栏复选框、右栏动作、列表「表单写权限」列
       全部由服务端返回的 meta 派生（加权限点＝改服务端一处 + 前端零改动）。
       meta 拉不到（如生产后端尚未部署该端点）时**降级**而不是崩：列表照常显示、
       权限列与新增/编辑按钮禁用、工具栏给「重试」。
   ============================================================ */
(function () {
  'use strict';

  /* ---------- 常量 ---------- */
  var TOKEN_KEY = 'wb_cb_prod_token';   /* 与生产逐字节一致：同源共享，只登录一次 */
  var API_PROD = '/api';                /* 生产接口：登录 / me / users / perm-meta */

  /* 系统清单：与生产 index.html、质量系统 quality/qa-app.js **同构副本**
     （三处 key 与 url 必须一致，由 tests/qa.systems-switch.test.js 钉死） */
  var SYSTEMS = [
    { key: 'prod', name: '生产排单系统', url: '/', icon: 'house' },
    { key: 'qa', name: '质量系统', url: '/quality/', icon: 'shield' },
    { key: 'admin', name: '管理员后台', url: '/admin/', icon: 'gear' }
  ];

  /* 导航：新增后台页面 = 这个数组加一项 + renderContent 加一个分支（本期只有员工管理） */
  var ADMIN_NAV = [
    { key: 'users', name: '员工管理', title: '员工管理', icon: 'users' }
  ];

  /* ---------- 状态（单一 source of truth，全部渲染从它派生） ---------- */
  var state = {
    token: '',
    me: null,             /* /api/me 返回的当前登录用户（role 判定用） */
    users: [],            /* /api/users 返回的员工列表 */
    meta: null,           /* /api/perm-meta 返回的权限元数据；null = 未就绪（降级态） */
    metaError: '',        /* 降级原因（展示在提示条里，便于排障） */
    view: 'boot',         /* boot | login | deny | ready */
    tab: 'users',
    modalMode: '',        /* '' | 'add' | 'edit' */
    modalUser: '',        /* 编辑中的用户名 */
    activePermForm: '',   /* 权限面板右侧当前展示的权限点 */
    loadingUsers: false,
    sysMenuOpen: false,
    busy: false
  };

  /* ---------- 小工具 ---------- */

  /**
   * HTML 转义（所有插入 innerHTML 的外部数据都必须过这里）。
   * @param {*} s
   * @returns {string}
   */
  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /**
   * 内联 SVG 图标（不引任何外部资源）。
   * 必须输出 width/height **presentation 属性**：没有任何尺寸约束的 <svg> 会按容器 100% 撑开
   * （质量页曾因此把卡片标题图标渲染成 956×956px）。CSS 类规则优先级高于该属性，
   * 故 `.btn svg{width:15px}` / `.empty svg{width:40px}` 等既定尺寸不受影响。
   * @param {string} name 图标键
   * @returns {string} 内联 SVG 字符串
   */
  function ico(name) {
    var p = {
      gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
      house: '<path d="M2 20h20M5 20V8l7-5 7 5v12M9 20v-6h6v6"/>',
      shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
      users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
      trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/>',
      lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'
    };
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
      + (p[name] || '') + '</svg>';
  }

  /**
   * 造一个带 status 的错误（接口层统一用它区分 401 / 403 / 其它）。
   * @param {number} status HTTP 状态码（0 = 网络不可达）
   * @param {string=} msg
   * @param {object=} json
   * @returns {Error}
   */
  function mkErr(status, msg, json) {
    var e = new Error(msg || '请求失败');
    e.status = status;
    e.json = json || null;
    return e;
  }

  /**
   * 按 id 取元素。
   * @param {string} id
   * @returns {HTMLElement|null}
   */
  function $(id) { return document.getElementById(id); }

  /* ---------- token（与生产共享同一个键） ---------- */
  function readToken() {
    try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }
  function writeToken(t) {
    try {
      if (t) sessionStorage.setItem(TOKEN_KEY, t);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* 隐私模式下 sessionStorage 可能不可写，忽略 */ }
  }

  /* ---------- 接口层：统一 401 / 403 处理 ---------- */
  /**
   * 调生产接口（本后台**只**用 /api 下四个现成端点）。
   * · 401 ⇒ 清 token + 登录卡片（并抛 status=401，调用方无需再处理）
   * · 403 ⇒ 抛 status=403（本后台的所有 403 都来自管理员硬闸 ⇒ 一律转无权访问态）
   * · 其它非 2xx ⇒ 抛 status=HTTP 码 + 服务端中文消息
   * @param {string} path 以 / 开头的路径（不含 /api 前缀）
   * @param {{method: string=, body: string=, headers: object=}=} opts
   * @returns {Promise<object>} 解析后的 JSON
   */
  async function apiFetch(path, opts) {
    var o = opts || {};
    var headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers || {});
    if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
    var resp;
    try {
      resp = await fetch(API_PROD + path, { method: o.method || 'GET', headers: headers, body: o.body });
    } catch (e) {
      throw mkErr(0, '无法连接服务器，请稍后重试', null);
    }
    var json = null;
    try { json = await resp.json(); } catch (e) { json = null; }
    if (resp.status === 401) {
      onUnauthorized();
      throw mkErr(401, '未登录或登录已过期', json);
    }
    if (!resp.ok) {
      throw mkErr(resp.status, (json && json.error) || ('请求失败（' + resp.status + '）'), json);
    }
    return json || {};
  }

  function apiGet(path) { return apiFetch(path, { method: 'GET' }); }
  function apiPost(path, body) { return apiFetch(path, { method: 'POST', body: JSON.stringify(body || {}) }); }
  function apiPut(path, body) { return apiFetch(path, { method: 'PUT', body: JSON.stringify(body || {}) }); }
  function apiDel(path) { return apiFetch(path, { method: 'DELETE' }); }

  /** 统一 401 出口：清空会话与所有缓存数据，回到登录卡片 */
  function onUnauthorized() {
    state.token = '';
    state.me = null;
    state.users = [];
    state.meta = null;
    state.metaError = '';
    state.view = 'login';
    writeToken('');
    renderMain();
    showLogin('登录已过期，请重新登录');
  }

  /* ---------- 登录卡片（照质量系统 showLogin/doLogin 重写，不引其函数/样式类） ---------- */
  /**
   * 渲染并显示登录卡片。
   * @param {string=} msg 卡片内的红字提示
   */
  function showLogin(msg) {
    var el = $('adminLoginBox');
    if (!el) {
      el = document.createElement('div');
      el.id = 'adminLoginBox';
      el.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:300;display:flex;align-items:center;justify-content:center';
      el.innerHTML = '<div style="background:#fff;border-radius:12px;padding:28px 30px;width:340px;box-shadow:0 20px 60px rgba(0,0,0,.25)">'
        + '<h2 style="font-size:17px;margin-bottom:2px;display:flex;align-items:center;gap:6px">'
        + '<svg viewBox="0 0 24 24" fill="none" stroke="#4f46e5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:18px;height:18px"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'
        + '管理员后台</h2>'
        + '<div style="font-size:12px;color:#94a3b8;margin-bottom:16px">辰微生产排单系统 · 仅管理员账号可用</div>'
        + '<label>用户名</label><input id="adminLoginUser" style="margin-bottom:10px">'
        + '<label>密码</label><input id="adminLoginPwd" type="password" style="margin-bottom:4px">'
        + '<div id="adminLoginErr" style="color:#ef4444;font-size:12px;min-height:18px;margin-top:4px">' + esc(msg || '') + '</div>'
        + '<button class="btn btn-primary" style="width:100%;justify-content:center" onclick="ADMIN_APP.doLogin()">登 录</button>'
        + '</div>';
      document.body.appendChild(el);
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') doLogin();
      });
    } else if (msg) {
      var err = el.querySelector('#adminLoginErr');
      if (err) err.textContent = msg;
    }
    el.style.display = 'flex';
    setTimeout(function () {
      var u = $('adminLoginUser');
      if (u && !u.value) u.focus();
    }, 30);
  }

  function hideLogin() {
    var el = $('adminLoginBox');
    if (el) el.style.display = 'none';
  }

  /** 登录（POST /api/login）：成功写 token → 重新走 boot 的角色判定流程 */
  async function doLogin() {
    var uEl = $('adminLoginUser');
    var pEl = $('adminLoginPwd');
    var errEl = $('adminLoginErr');
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
    /* 沿用生产系统的弱口令提示口径（首句与质量系统逐字一致）；
       差别只在第二句指向：**本后台不提供改密**，需回到生产系统用「改密」修改。 */
    if (j.mustChangePwd) {
      setTimeout(function () {
        alert('当前账号使用的是初始密码或已被重置的密码，存在安全风险。\n本后台不提供改密，请切到「生产排单系统」用右上角「改密」修改为个人密码。');
      }, 300);
    }
  }

  /** 退出：清 token 后**留在本页**（不跳回生产系统），页面转为登录卡片 */
  function logout() {
    if (!confirm('确认退出登录？')) return;
    state.token = '';
    state.me = null;
    state.users = [];
    state.meta = null;
    state.metaError = '';
    state.view = 'login';
    writeToken('');
    renderMain();
    showLogin('');
  }

  /* ---------- 系统切换下拉（结构/行为与生产、质量系统同构） ---------- */
  function renderSysMenu() {
    var el = $('sysMenu');
    if (!el) return;
    el.innerHTML = SYSTEMS.map(function (s) {
      var isCur = s.key === 'admin';   /* 本页固定是管理员后台，故当前项恒为 admin */
      return '<div class="sys-menu-item' + (isCur ? ' cur' : '') + '"'
        + ' onclick="ADMIN_APP.pickSystem(event,\'' + s.key + '\')">'
        + ico(s.icon) + '<span>' + esc(s.name) + '</span>'
        + (isCur ? '<span class="ck">✓</span>' : '')
        + '</div>';
    }).join('');
  }

  /**
   * 展开/收起系统切换面板。
   * @param {Event=} ev
   */
  function toggleSysMenu(ev) {
    if (ev) ev.stopPropagation();   /* 防被 document 的「点外部关闭」立刻吃掉 */
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

  /**
   * 点面板项：当前系统只关面板；其它系统**同标签页**跳转（禁 window.open / target=_blank：
   * sessionStorage 按标签页隔离，开新标签必然丢登录态）。
   * @param {Event=} ev
   * @param {string} key 系统键
   */
  function pickSystem(ev, key) {
    if (ev) ev.stopPropagation();
    closeSysMenu();
    if (key === 'admin') return;
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

  function closeMobileSidebar() {
    var sb = $('sidebar');
    var ov = $('overlay');
    if (sb && sb.classList.contains('open')) {
      sb.classList.remove('open');
      if (ov) ov.classList.remove('show');
    }
  }

  /* ---------- 导航 ---------- */
  /**
   * 当前导航项。
   * @returns {{key: string, name: string, title: string, icon: string}}
   */
  function currentNav() {
    for (var i = 0; i < ADMIN_NAV.length; i++) if (ADMIN_NAV[i].key === state.tab) return ADMIN_NAV[i];
    return ADMIN_NAV[0];
  }

  function renderNav() {
    var el = $('nav');
    if (!el) return;
    if (state.view !== 'ready') { el.innerHTML = ''; return; }   /* 无权访问/未登录：不留任何导航 DOM */
    el.innerHTML = ADMIN_NAV.map(function (n) {
      return '<div class="nav-item' + (n.key === state.tab ? ' active' : '') + '"'
        + ' onclick="ADMIN_APP.switchTab(\'' + n.key + '\')">' + ico(n.icon) + '<span>' + esc(n.name) + '</span></div>';
    }).join('');
  }

  /**
   * 同步页面标题（顶栏 + 移动端）。
   * @param {string} text
   */
  function setTitle(text) {
    var t1 = $('pageTitle');
    var t2 = $('mobileTitle');
    if (t1) t1.textContent = text || '';
    if (t2) t2.textContent = text || '';
  }

  /**
   * 切页签。
   * @param {string} key
   */
  function switchTab(key) {
    state.tab = key;
    renderNav();
    renderContent();
    closeMobileSidebar();
  }

  /* ---------- 数据加载 ---------- */
  /** 拉员工列表（失败时按状态码抛给 reloadAll 统一处理） */
  async function loadUsers() {
    var j = await apiGet('/users');
    state.users = Array.isArray(j.users) ? j.users : [];
  }

  /**
   * 拉权限元数据（GET /api/perm-meta）。
   * 失败处理分三档：
   *   · 401 ⇒ 上抛（登录失效，由 reloadAll 转登录卡片）
   *   · 403 ⇒ 上抛（非管理员，由 reloadAll 转无权访问态）
   *   · 其余（404 = 生产后端尚未部署该端点 / 网络异常 / 返回形状非法）⇒ **降级**：
   *     meta=null，列表照常显示，权限列与新增/编辑禁用，工具栏出「重试」。
   *     （降级路径不抛异常、不白屏 —— 这是本页与生产后端可以独立上线的前提）
   */
  async function loadMeta() {
    state.metaError = '';
    if (!state.token) return;
    try {
      var j = await apiGet('/perm-meta');
      var m = (j && j.meta) || null;
      var okShape = !!(m && m.forms && typeof m.forms === 'object' && m.formKeys && typeof m.formKeys === 'object'
        && m.acts && typeof m.acts === 'object');
      state.meta = okShape ? m : null;
      if (!okShape) state.metaError = '权限元数据结构非法（缺少 forms / formKeys / acts）';
    } catch (e) {
      if (e && (e.status === 401 || e.status === 403)) throw e;
      state.meta = null;
      state.metaError = (e && e.message) || '权限清单加载失败';
    }
  }

  /**
   * 全量刷新：/api/me 判角色 → 管理员才并发拉 users + perm-meta。
   * ★ 非管理员**立即停止**：绝不调用 /api/users 与 /api/perm-meta（页面不得出现任何员工数据）。
   */
  async function reloadAll() {
    if (!state.token) {
      state.view = 'login';
      renderMain();
      showLogin('');
      return;
    }
    state.loadingUsers = true;
    try {
      var me = await apiGet('/me');
      /* ★ 生产 /api/me 返回的是**扁平的 publicUser 对象**（{username,name,role,status,perms,…}），
         不是 {user:…} 包装 —— 质量系统的 /api/qa/me 才是包装形态。这里两种形态都兼容，
         否则会把「已登录的管理员」误判成 null 而直接渲染无权访问页（真机自测已踩过）。 */
      state.me = (me && me.user) ? me.user : ((me && me.username) ? me : null);
      if (!state.me || state.me.role !== 'admin') {
        /* ★ 立即停止：不再调任何管理员接口 */
        state.view = 'deny';
        state.users = [];
        state.meta = null;
        state.metaError = '';
        state.loadingUsers = false;
        renderMain();
        return;
      }
      state.view = 'ready';
      await Promise.all([loadUsers(), loadMeta()]);
    } catch (e) {
      state.loadingUsers = false;
      if (e && e.status === 401) {           /* onUnauthorized 已弹登录卡片 */
        state.view = 'login';
        state.users = [];
        state.meta = null;
        renderMain();
        return;
      }
      if (e && e.status === 403) {           /* 管理员硬闸：一律转无权访问态 */
        state.view = 'deny';
        state.users = [];
        state.meta = null;
        renderMain();
        return;
      }
      renderMain();
      alert((e && e.message) || '加载失败，请稍后重试');
      return;
    }
    state.loadingUsers = false;
    renderMain();
  }

  /** 「重试」按钮入口：只重拉权限元数据（不动列表，避免无谓闪烁） */
  async function retryMeta() {
    if (!state.token) { showLogin(''); return; }
    try {
      await loadMeta();
    } catch (e) {
      if (e && e.status === 401) { state.view = 'login'; renderMain(); return; }
      if (e && e.status === 403) { state.view = 'deny'; renderMain(); return; }
      state.meta = null;
      state.metaError = (e && e.message) || '权限清单加载失败';
    }
    renderMain();
  }

  /* ---------- 无权访问态 ---------- */
  /**
   * 无权访问卡片（非管理员打开 /admin/ 时的**唯一**内容；不自动跳转，给一条明确返回路径）。
   * @returns {string} HTML 字符串
   */
  function denyHtml() {
    var who = state.me && state.me.username ? String(state.me.username) : '';
    var name = state.me && state.me.name ? String(state.me.name) : '';
    return '<div class="deny-card">'
      + '<svg class="deny-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>'
      + '<h2>无权访问</h2>'
      + '<p>当前登录账号：<span class="deny-user">' + esc(who || '（未知）') + (name ? '（' + esc(name) + '）' : '') + '</span></p>'
      + '<p>管理员后台仅限管理员账号使用。如需管理员工账号，请联系管理员。</p>'
      + '<button class="btn btn-primary" onclick="ADMIN_APP.backToProd()">返回生产排单系统</button>'
      + '</div>';
  }

  /** 「返回生产排单系统」（无权访问卡片上的唯一按钮） */
  function backToProd() {
    location.href = '/';
  }

  /* ---------- 员工表格 ---------- */
  /** 降级提示条（meta 未就绪时出现在卡片标题下方） */
  function metaWarnHtml() {
    return '<div class="meta-warn">'
      + '<span>权限清单未就绪（请先部署生产后端 <code>GET /api/perm-meta</code>）。'
      + (state.metaError ? '原因：' + esc(state.metaError) + '。' : '')
      + '「表单写权限」列与「新增 / 编辑」暂不可用，员工列表仍可查看。</span>'
      + '<button class="btn btn-sm" onclick="ADMIN_APP.retryMeta()">重试</button>'
      + '</div>';
  }

  /**
   * 员工表格（6 列：用户名 / 姓名 / 角色 / 状态 / 表单写权限 / 操作）。
   * 「表单写权限」列由 **meta.forms** 派生（不得硬编码权限键清单）；
   * 管理员行不显示「删除」按钮（与原实现一致；服务端亦拒绝删除内置管理员/自己）。
   * @returns {string} HTML 字符串
   */
  function renderUsers() {
    var meta = state.meta;
    var btnAdd = '<button class="btn btn-primary btn-sm" style="margin-left:auto"'
      + (meta ? '' : ' disabled title="权限清单未就绪，暂不可新增"')
      + ' onclick="ADMIN_APP.userModal()">' + ico('plus') + '新增员工</button>';

    var html = '<div class="card"><div class="card-title">' + ico('users')
      + '员工管理 <span class="desc">账号 · 角色 · 按表单写权限（勾选=可编辑，不勾=只读）</span>'
      + btnAdd + '</div>';

    if (!meta) html += metaWarnHtml();

    if (state.loadingUsers && !state.users.length) {
      html += '<div class="empty">加载中…</div></div>';
      return html;
    }
    if (!state.users.length) {
      html += '<div class="empty">' + ico('users') + '<div>暂无员工账号</div></div></div>';
      return html;
    }

    html += '<div class="table-wrap"><table><thead><tr>'
      + '<th>用户名</th><th>姓名</th><th>角色</th><th>状态</th><th>表单写权限</th><th style="width:130px">操作</th>'
      + '</tr></thead><tbody>';

    state.users.forEach(function (u) {
      var permStr;
      if (meta) {
        permStr = Object.keys(meta.forms).filter(function (k) {
          return u.perms && u.perms[k] === true;
        }).map(function (k) { return meta.forms[k]; }).join('、') || '（无，全部只读）';
      } else {
        permStr = '权限清单未就绪（请先部署生产后端）';
      }
      var isAdmin = u.role === 'admin';
      var opsEdit = '<button class="btn btn-sm"' + (meta ? '' : ' disabled title="权限清单未就绪，暂不可编辑"')
        + ' onclick="ADMIN_APP.userModal(\'' + esc(u.username) + '\')">编辑</button>';
      var opsDel = (!isAdmin && meta)
        ? ' <button class="btn btn-sm btn-danger" onclick="ADMIN_APP.delUser(\'' + esc(u.username) + '\')">删除</button>'
        : '';
      html += '<tr>'
        + '<td style="font-weight:600">' + esc(u.username) + '</td>'
        + '<td>' + esc(u.name) + '</td>'
        + '<td>' + (isAdmin ? '<span class="tag tag-red">管理员</span>' : '<span class="tag tag-blue">员工</span>') + '</td>'
        + '<td>' + (u.status === 'active' ? '<span class="tag tag-green">启用</span>' : '<span class="tag tag-gray">停用</span>') + '</td>'
        + '<td style="font-size:12px">' + esc(permStr) + '</td>'
        + '<td>' + opsEdit + opsDel + '</td>'
        + '</tr>';
    });

    html += '</tbody></table></div></div>';
    return html;
  }

  /* ---------- 权限三态面板（与原生产实现逐条等价，数据源改为 meta） ---------- */
  /**
   * 权限键 → 承载动作的表单键（反查）。
   * 口径与原实现一致：遍历的键是**动作键归属表单**（meta.acts 的键），不是全部表单键
   * （meta.formKeys 有 12 项、其中 parts/partLogs 同归 parts 权限点，遍历它会出现歧义）。
   * @param {string} permKey 权限点键（如 products / saleOrders）
   * @returns {string|null} 表单键（如 product）或 null（该权限点无独立业务动作）
   */
  function permFormKeyOf(permKey) {
    if (!state.meta) return null;
    var acts = state.meta.acts || {};
    var formKeys = state.meta.formKeys || {};
    var keys = Object.keys(acts);
    for (var i = 0; i < keys.length; i++) {
      if (formKeys[keys[i]] === permKey) return keys[i];
    }
    return null;
  }

  /**
   * 点表单名：左栏高亮该行、右栏只显示它的动作区。
   * @param {string} k 权限点键
   */
  function setActivePermForm(k) {
    state.activePermForm = k;
    document.querySelectorAll('#modal [id^="permrow_"]').forEach(function (el) {
      el.style.background = (el.id.slice(8) === k) ? '#e8f0fe' : '';
      el.style.outline = (el.id.slice(8) === k) ? '1px solid #bfdbfe' : '';
    });
    document.querySelectorAll('#modal [id^="permActs_"]').forEach(function (el) {
      el.style.display = (el.id.slice(9) === k) ? 'block' : 'none';
    });
  }

  /**
   * 动作勾选变化 → 重算该表单复选框三态（全勾=勾、部分=横杠、全无=空）。
   * @param {string} k 权限点键
   */
  function recomputePermTri(k) {
    if (!state.meta) return;
    var fm = permFormKeyOf(k);
    if (!fm) return;
    var actsDef = (state.meta.acts || {})[fm] || {};
    if (!Object.keys(actsDef).length) return;
    var root = document.querySelector('#modal input[data-perm="' + k + '"]');
    if (!root) return;
    var bs = document.querySelectorAll('#modal input[data-act^="' + fm + '."]');
    var n = 0;
    bs.forEach(function (b) { if (b.checked) n++; });
    root.checked = (n > 0 && n === bs.length);
    root.indeterminate = (n > 0 && n < bs.length);
    if (n > 0 && state.activePermForm !== k) setActivePermForm(k);
  }

  /**
   * 勾选表单复选框=全开其动作；取消=全关（含半选清空）。
   * @param {string} k 权限点键
   * @param {boolean} checked
   */
  function permTriToggle(k, checked) {
    var fm = permFormKeyOf(k);
    if (fm) {
      document.querySelectorAll('#modal input[data-act^="' + fm + '."]').forEach(function (b) { b.checked = checked; });
    }
    var root = document.querySelector('#modal input[data-perm="' + k + '"]');
    if (!root) return;
    root.checked = checked;
    root.indeterminate = false;
    if (checked && state.activePermForm !== k) setActivePermForm(k);
  }

  /** 弹窗渲染完成后：按存量勾选反推各表单三态 + 默认选中第一个表单 */
  function permInitUI() {
    if (!state.meta) return;
    Object.keys(state.meta.forms).forEach(function (k) { recomputePermTri(k); });
    setActivePermForm(Object.keys(state.meta.forms)[0]);
  }

  /**
   * 权限面板左栏（每行：三态复选框 + 权限点显示名 + 「动作▸」角标）。
   * @param {object} p 员工对象（新增时为空壳）
   * @returns {string} HTML
   */
  function permLeftHtml(p) {
    var META = state.meta;
    return Object.keys(META.forms).map(function (k) {
      var fCk = p.perms && p.perms[k] === true;
      var fmKey = permFormKeyOf(k);
      var hasActs = !!fmKey;
      return '<div id="permrow_' + k + '" style="display:flex;align-items:center;gap:5px;padding:4px 7px;border-radius:4px;cursor:pointer;font-size:13px"'
        + ' onclick="ADMIN_APP.setActivePermForm(\'' + k + '\')"'
        + ' title="' + (hasActs ? '点击查看/勾选本表单的业务动作按钮' : '本表单无独立业务动作，勾选即整表单可编辑') + '">'
        + '<input type="checkbox" data-perm="' + k + '" ' + (fCk ? 'checked' : '')
        + ' onclick="event.stopPropagation();ADMIN_APP.permTriToggle(\'' + k + '\',this.checked)" style="flex:none;cursor:pointer">'
        + '<span style="color:var(--text);white-space:nowrap">' + esc(META.forms[k]) + '</span>'
        + (hasActs ? '<span style="margin-left:auto;font-size:10px;color:#9ca3af">动作▸</span>' : '')
        + '</div>';
    }).join('');
  }

  /**
   * 权限面板右栏（每个权限点一个动作区；无动作键的权限点走兜底文案）。
   * data-act 的键形态 = `表单键.动作键`，与线上 perms.acts 的键完全一致。
   * @param {object} p 员工对象（新增时为空壳）
   * @returns {string} HTML
   */
  function permRightHtml(p) {
    var META = state.meta;
    return Object.keys(META.forms).map(function (k) {
      var fmKey = permFormKeyOf(k);
      var acts = fmKey ? Object.keys(META.acts[fmKey]) : [];
      var fCk = p.perms && p.perms[k] === true;
      var actsObj = p.perms && p.perms.acts;
      return '<div id="permActs_' + k + '" style="display:none">'
        + '<div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:2px">' + esc(META.forms[k]) + ' · 业务动作按钮</div>'
        + '<div style="font-size:11px;color:var(--muted);margin-bottom:6px">勾选＝拥有该按钮操作权（保存生效）；按钮可见还需左侧本表单已勾选（横杠=部分也放行）。仅勾「动作」未勾「左侧全选框」时，保存自动视为表单已授权。</div>'
        + (acts.length
          ? '<div style="display:flex;flex-direction:column;gap:2px">' + acts.map(function (a) {
            return '<label style="display:flex;align-items:center;gap:5px;font-size:12px;color:var(--text);cursor:pointer">'
              + '<input type="checkbox" data-act="' + fmKey + '.' + a + '" '
              + (fCk && (!actsObj || actsObj[fmKey + '.' + a] === true) ? 'checked' : '')
              + ' onchange="ADMIN_APP.recomputePermTri(\'' + k + '\')" style="cursor:pointer">'
              + esc(META.acts[fmKey][a]) + '</label>';
          }).join('') + '</div>'
          : '<div style="font-size:12px;color:var(--muted)">该表单无独立业务动作按钮——勾选左侧本表单即拥有其全部写权限（新增/编辑/复制/删除）。</div>')
        + '</div>';
    }).join('');
  }

  /**
   * 新增 / 编辑员工弹窗。
   * @param {string=} username 传用户名=编辑；不传=新增
   */
  function userModal(username) {
    if (!state.meta) {
      alert('权限清单未就绪（生产后端尚未提供 /api/perm-meta），暂不能新增或编辑员工。\n请先部署生产后端，或点击「重试」。');
      return;
    }
    var list = state.users || [];
    var u = username ? list.filter(function (x) { return x.username === username; })[0] : null;
    var p = u || { username: '', name: '', role: 'staff', status: 'active', perms: {} };
    state.modalMode = u ? 'edit' : 'add';
    state.modalUser = u ? u.username : '';

    var body = '<div class="form-row"><div><label>用户名（登录名）</label>'
      + '<input id="uf_user" ' + (u ? 'readonly' : '') + ' value="' + esc(p.username) + '" placeholder="2-20位字母数字下划线"></div>'
      + '<div><label>姓名</label><input id="uf_name" value="' + esc(p.name) + '"></div></div>'
      + '<div class="form-row"><div><label>角色</label>'
      + '<select id="uf_role"><option value="staff" ' + (p.role !== 'admin' ? 'selected' : '') + '>员工</option>'
      + '<option value="admin" ' + (p.role === 'admin' ? 'selected' : '') + '>管理员</option></select></div>'
      + '<div><label>状态</label>'
      + '<select id="uf_status"><option value="active" ' + (p.status !== 'disabled' ? 'selected' : '') + '>启用</option>'
      + '<option value="disabled" ' + (p.status === 'disabled' ? 'selected' : '') + '>停用</option></select></div></div>'
      + '<div class="form-row"><div><label>' + (u ? '重置密码（留空则不修改）' : '初始密码') + '</label>'
      + '<input id="uf_pwd" type="text" value=""></div></div>'
      + '<div><label style="font-weight:600">表单写权限</label>'
      + '<div style="font-size:12px;color:var(--muted);margin:2px 0 6px">左侧勾选表单＝整表单可编辑；<b>点表单名</b>，右侧显示其「业务动作」按钮逐个勾选。动作有空窗/全勾/部分三种：空＝无权限 · 全勾＝全部按钮 · <b>横杠＝部分按钮</b>（仍算有该表单写权限）</div>'
      + '<div style="display:flex;gap:10px;align-items:flex-start">'
      + '<div style="flex:0 0 188px;border:1px solid var(--border);border-radius:6px;padding:3px;max-height:320px;overflow:auto;background:#fff">'
      + permLeftHtml(p)
      + '</div>'
      + '<div style="flex:1;border:1px solid var(--border);border-radius:6px;padding:6px 10px;min-height:140px;background:#fbfcfe;overflow:auto;max-height:320px">'
      + permRightHtml(p)
      + '</div>'
      + '</div></div>';

    openModalShell(u ? '编辑员工' : '新增员工', body,
      '<button class="btn" onclick="ADMIN_APP.closeModal()">取消</button>'
      + '<button class="btn btn-primary" onclick="ADMIN_APP.saveUser(' + (u ? "'" + esc(u.username) + "'" : 'null') + ')">保存</button>');
    permInitUI();
  }

  /**
   * 保存员工：收集三态权限 + 动作 + 基本信息 → POST（新增）/ PUT（编辑）。
   * 保存成功后 **重新拉 /api/me**（reloadAll），而不是只改本地 currentUser.role ——
   * 否则把自己降级成员工后，页面仍会显示管理界面（与原实现的已知缺陷对齐修正）。
   */
  async function saveUser(username) {
    var unameEl = $('uf_user');
    var nameEl = $('uf_name');
    var roleEl = $('uf_role');
    var statusEl = $('uf_status');
    var pwdEl = $('uf_pwd');
    if (!unameEl || !nameEl || !roleEl || !statusEl || !pwdEl) return;
    var uname = unameEl.value.trim();
    var name = nameEl.value.trim();
    var role = roleEl.value;
    var status = statusEl.value;
    var pwd = pwdEl.value;

    var perms = {};
    /* 三态收集——全勾/横杠(部分动作)=表单有写权限（动作按钮可见与落库均需表单写权限）；空框=无权限 */
    document.querySelectorAll('#modal input[data-perm]').forEach(function (c) {
      perms[c.dataset.perm] = (c.checked || c.indeterminate);
    });
    /* 按钮级动作权限收集——勾选的「业务动作」子项写入 perms.acts（未勾=该动作收敛；保存后 canAct 即严格生效） */
    var acts = {};
    document.querySelectorAll('#modal input[data-act]').forEach(function (c) {
      acts[c.dataset.act] = c.checked;
    });
    perms.acts = acts;
    /* .118 存量兼容：编辑历史员工若曾勾「订单管理(orders)」则自动转为销售/库存双开
       （该员工权限面板不再有 orders 项；不缩权限，管理员重存后固化） */
    if (username) {
      var old = (state.users || []).filter(function (x) { return x.username === username; })[0];
      if (old && old.perms && old.perms.orders === true) { perms.saleOrders = true; perms.invOrders = true; }
    }

    var payload = { username: uname || username, name: name || uname || username, role: role, status: status, perms: perms };
    if (pwd) payload.password = pwd;

    if (state.busy) return;
    state.busy = true;
    try {
      if (username) await apiPut('/users', payload);
      else await apiPost('/users', payload);
      closeModal();
      await reloadAll();     /* 真实回读 /api/me：自降级后立即转为无权访问态 */
    } catch (e) {
      if (e && e.status === 401) return;                /* onUnauthorized 已处理 */
      if (e && e.status === 403) { closeModal(); state.view = 'deny'; renderMain(); return; }
      alert((e && e.message) || '保存失败，请检查网络');
    } finally {
      state.busy = false;
    }
  }

  /**
   * 删除员工（DELETE /api/users?username=<enc>）。
   * @param {string} username
   */
  async function delUser(username) {
    if (!confirm('确认删除员工「' + username + '」？此操作不可恢复。')) return;
    if (state.busy) return;
    state.busy = true;
    try {
      await apiDel('/users?username=' + encodeURIComponent(username));
      await reloadAll();
    } catch (e) {
      if (e && e.status === 401) return;
      if (e && e.status === 403) { state.view = 'deny'; renderMain(); return; }
      alert((e && e.message) || '删除失败');
    } finally {
      state.busy = false;
    }
  }

  /* ---------- 弹窗外壳 ---------- */
  /**
   * 打开弹窗。
   * @param {string} title
   * @param {string} bodyHtml
   * @param {string} footHtml
   */
  function openModalShell(title, bodyHtml, footHtml) {
    var bg = $('modalBg');
    var m = $('modal');
    if (!bg || !m) return;
    m.innerHTML = '<div class="modal-head"><h3>' + esc(title) + '</h3>'
      + '<div class="close-x" onclick="ADMIN_APP.closeModal()">✕</div></div>'
      + '<div class="modal-body">' + bodyHtml + '</div>'
      + '<div class="modal-foot">' + footHtml + '</div>';
    /* 弹窗内滚轮不穿透主界面（scroll chaining）：阻断冒泡到 body，弹窗内滚动区正常滚动 */
    if (!bg.__wheelBound) {
      bg.addEventListener('wheel', function (e) { e.stopPropagation(); }, { passive: false });
      bg.__wheelBound = true;
    }
    bg.classList.add('show');
  }

  function closeModal() {
    var bg = $('modalBg');
    var m = $('modal');
    if (bg) bg.classList.remove('show');
    if (m) m.innerHTML = '';
  }

  /* ---------- 渲染总入口 ---------- */
  /** 按 state.view 渲染导航 + 内容区（无权访问/未登录时不渲染任何员工数据 DOM） */
  function renderMain() {
    var nav = $('nav');
    var c = $('content');

    if (state.view === 'deny') {
      if (nav) nav.innerHTML = '';
      setTitle('无权访问');
      if (c) c.innerHTML = denyHtml();
      return;
    }
    if (state.view !== 'ready') {
      if (nav) nav.innerHTML = '';
      setTitle('');
      if (c) c.innerHTML = '';
      return;
    }
    renderNav();
    renderContent();
  }

  /** 渲染当前页签内容（新增后台页面：ADMIN_NAV 加一项 + 这里加一个 case） */
  function renderContent() {
    var c = $('content');
    if (!c) return;
    var nav = currentNav();
    setTitle(nav.title);
    switch (state.tab) {
      case 'users': c.innerHTML = renderUsers(); break;
      default: c.innerHTML = '<div class="empty">未知模块</div>';
    }
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
    /* 点面板外 / ESC 关闭系统切换面板与弹窗 */
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
    boot();
  }

  /** 启动：有 token 走角色判定，无 token 直接登录卡片 */
  async function boot() {
    state.token = readToken();
    if (!state.token) {
      state.view = 'login';
      renderMain();
      showLogin('');
      return;
    }
    await reloadAll();
  }

  /* ---------- 对外接口（HTML 内联 onclick 只依赖这一个对象） ---------- */
  window.ADMIN_APP = {
    sys: SYSTEMS,
    nav: ADMIN_NAV,
    state: state,
    /* 登录 / 会话 */
    doLogin: doLogin,
    logout: logout,
    /* 系统切换 */
    toggleSysMenu: toggleSysMenu,
    closeSysMenu: closeSysMenu,
    pickSystem: pickSystem,
    /* 侧边栏 / 导航 */
    toggleSidebar: toggleSidebar,
    toggleSidebarCollapse: toggleSidebarCollapse,
    switchTab: switchTab,
    /* 员工管理 */
    userModal: userModal,
    saveUser: saveUser,
    delUser: delUser,
    closeModal: closeModal,
    /* 权限三态面板 */
    setActivePermForm: setActivePermForm,
    permTriToggle: permTriToggle,
    recomputePermTri: recomputePermTri,
    /* 降级 / 刷新 */
    retryMeta: retryMeta,
    reloadAll: reloadAll,
    /* 无权访问 */
    backToProd: backToProd,
    /* 供排障与自动化验收使用的只读视图 */
    render: renderMain
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
