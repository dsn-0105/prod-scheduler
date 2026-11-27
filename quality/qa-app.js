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
  /* 【build .167】列布局本地存储键。质量系统的本地键一律 `wb_cb_qa_` 前缀（三条硬约束之三）；
     `_v1` 是**形状版本**，与"生产 tblLayout v2"是两套独立演进的东西（见下方 normalizeLayout 注释）。 */
  var LAYOUT_KEY = 'wb_cb_qa_tblLayout_v1';
  /* 本系统的表格模块名：生产按 data-m 区分多个模块，质量只有「异常台账」一张表 ⇒ 固定一个名字。
     用常量而非字面量散落各处，是为了将来真出现第二张表时有唯一改动点。 */
  var TBL_M = 'qaLog';
  var PAGE_SIZES = [10, 100, 1000];
  var RETRY_DELAY_MS = 3000;                       /* 503 后 3 秒自动重试一次 */

  /* 【build .166】漏斗图标 —— 与生产系统 index.html 的 FILT_SVG **逐字节一致**（含行内 12×12 尺寸）。
     用户要求「漏斗大小跟订单管理一样、可视化风格统一」⇒ 尺寸与 path 都不许自创：
     生产侧是 `style="width:12px;height:12px"` 行内写死（不靠 CSS 类），本文件照抄同一形态，
     由 tests/qa.ledger-filter-sort.independent.test.js §D1 与生产源码直接对拍。
     注意：这里是**同构改写**而非共享代码 —— 质量系统禁止加载生产脚本（设计 §9.3）。 */
  var FILT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px"><path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/></svg>';

  /* 系统清单：与生产侧、管理员后台各自维护**同构副本**（PRD P0-2 明文，不做跨文件共享）。
     【build .164】新增第三项「管理员后台」(/admin/)：三处副本的 key 与 url 必须全一致，
     由 tests/qa.systems-switch.test.js 钉死。 */
  var SYSTEMS = [
    { key: 'qa', name: '质量系统', url: '/quality/', icon: 'shield' },
    { key: 'prod', name: '生产排单系统', url: '/', icon: 'house' },
    { key: 'admin', name: '管理员后台', url: '/admin/', icon: 'gear' }
  ];

  /* 导航：新增质量表单 = 数组加一项 + renderTab 加一个渲染分支 */
  var QA_NAV = [
    { key: 'qaLog', name: '异常台账', title: '异常台账', icon: 'list' }
  ];

  /* ============================================================
     异常台账列定义 —— **全工程唯一一份**（表头 / 表体 / CSV 导出 /
     编辑后行内更新 / 新增编辑表单 五处消费者全部由本数组派生）
     ------------------------------------------------------------
     【build .165】为什么必须单源：加字段之前这五处各写一份硬编码，
       `applyRowUpdate` 更用 `tds[1]`/`tds[2]` 取单元格 —— 多一列就静默
       只刷新前两格、新字段保存后不显示（不报错，只让用户以为没存上）。
     新增字段的**唯一**正确做法 = 在下面加一条，然后同步 PRD §6.1。
     ------------------------------------------------------------
     key          落库键。后端 qa-store.collectExtras 刻意透传未知顶层标量键，
                  故加字段**不需要改后端**；但 key 必须与需求逐字一致（改 key = 历史数据丢字段）
     label        表头与 CSV 列名
     type         'date' | 'text' | 'num' | 'long'
                  · num  表格右对齐
                  · long 表格截断 + 悬浮看全文（多行文本不撑爆行高）
     sortable     【build .166】9 列全部 true（用户要求"所有字段都能排序"）：
                  排序比较器在 qa-core.sortRecords（类型感知，空值恒沉底），本文件**不许**自造比较逻辑
     filterType   筛选模式档：'text'（8 模式）| 'num'（6 模式：生产 4 + 为空/不为空）| 'date'（8 快捷）
                  缺省从 type 推导（long→text、num→num、date→date），故多数列不用写
     inTable      是否占列表列
     formKind     表单控件：'date' | 'readonly' | 'text' | 'number' | 'textarea'
     formRow      表单分行序号（同号并排，行内 flex:1 等分）
     required     表单必填标记（仅日期；其余留空可存）
     hint         仅编号用：hint 提示条（新增/编辑文案不同，由 openAddModal 覆写）
     ============================================================ */
  var QA_COLUMNS = [
    /* ① 既有两列（PRD 原始需求，不可删改顺序与 key） */
    { key: 'date', label: '日期', type: 'date', sortable: true, inTable: true, formKind: 'date', formRow: 1, required: true },
    { key: 'no', label: '编号', type: 'text', sortable: true, inTable: true, formKind: 'readonly', formRow: 1,
      hint: '系统自动生成，不可修改' },
    /* ② 【build .165】用户新增 7 字段：产品名称、规格型号、总数量、检测数量、异常数量、异常描述、原因分析。
          产品名称/规格型号 = 自由文本（质量系统禁止读生产全局，不联动产品主数据，由录入人填写）。 */
    { key: 'productName', label: '产品名称', type: 'text', sortable: true, inTable: true, formKind: 'text', formRow: 2 },
    { key: 'specModel', label: '规格型号', type: 'text', sortable: true, inTable: true, formKind: 'text', formRow: 2 },
    { key: 'totalQty', label: '总数量', type: 'num', sortable: true, inTable: true, formKind: 'number', formRow: 3 },
    { key: 'inspectedQty', label: '检测数量', type: 'num', sortable: true, inTable: true, formKind: 'number', formRow: 3 },
    { key: 'defectQty', label: '异常数量', type: 'num', sortable: true, inTable: true, formKind: 'number', formRow: 3 },
    { key: 'defectDesc', label: '异常描述', type: 'long', sortable: true, inTable: true, formKind: 'textarea', formRow: 4 },
    { key: 'causeAnalysis', label: '原因分析', type: 'long', sortable: true, inTable: true, formKind: 'textarea', formRow: 5 }
  ];

  /** 列表列（inTable）—— 表头、表体、CSV 的同一份输入 */
  function tableCols() {
    return QA_COLUMNS.filter(function (c) { return c.inTable; });
  }

  /** 表单字段（有 formKind 的都上表单，顺序即 QA_COLUMNS 顺序） */
  function formCols() {
    return QA_COLUMNS.filter(function (c) { return !!c.formKind; });
  }

  /** 按 key 取列定义（排序白名单由此派生，不再手写 key 比较） */
  function colOf(key) {
    for (var i = 0; i < QA_COLUMNS.length; i++) {
      if (QA_COLUMNS[i].key === key) return QA_COLUMNS[i];
    }
    return null;
  }

  /**
   * 单元格纯文本 —— 表格 td / CSV / 行内更新**共用**的取值函数。
   * 刻意不返回 HTML：这里一旦包含标签，CSV 就会把标签导出到 Excel 里。
   * @param {object} col 列定义
   * @param {object} rec 记录
   * @returns {string} 缺字段/null 一律空串（语义 = 未填，与 0 区分）
   */
  function cellText(col, rec) {
    var v = rec ? rec[col.key] : '';
    return (v === undefined || v === null) ? '' : String(v);
  }

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
    /* 【build .166】列筛选条件：key → {mode, val, from, to}。Q3A：**仅内存**，刷新即清
       （与生产 tblState[m].filters 同口径；落 localStorage 会让"昨天筛过的东西"明天悄悄生效） */
    filters: {},
    filtKey: '',
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
      /* 【build .164】齿轮：管理员后台图标（与生产 index.html、admin-app.js 的 gear 同形） */
      gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
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
    return CORE.sortRecords(filteredRecords(), state.sortKey, state.sortDir, sortTypes());
  }

  /** 列 key → 排序/筛选类型映射（每次从列定义派生，不缓存：加列后缓存必失效） */
  function sortTypes() {
    var t = {};
    QA_COLUMNS.forEach(function (c) {
      t[c.key] = c.type === 'num' ? 'num' : (c.type === 'date' ? 'date' : 'text');
    });
    return t;
  }

  /** 筛选后的记录（未排序）—— 判定全在 qa-core.applyFilters，本文件不写任何匹配逻辑 */
  function filteredRecords() {
    return CORE.applyFilters(state.records, QA_COLUMNS, state.filters);
  }

  /** 当前是否有生效筛选 */
  function hasFilter() {
    return Object.keys(state.filters).some(function (k) { return CORE.filtActive(state.filters[k]); });
  }

  /**
   * 【build .166 · Q4A】把「已被筛掉、当前看不见的行」从选中集合里剔除。
   * 不剔的后果：用户先全选 100 条 → 再加筛选只剩 3 条 → 点「导出选中」，
   * 导出的是 100 条（含 97 条肉眼不可见的行）。这是最容易让人"以为系统坏了"的一类 bug。
   * 只由**筛选变化**触发；排序不改变可见集合，故排序不剔。
   * @returns {number} 清掉的条数（供调用方决定是否提示）
   */
  function pruneSelToVisible() {
    var alive = {};
    filteredRecords().forEach(function (r) { if (r && r.id) alive[r.id] = true; });
    var n = 0;
    Object.keys(state.sel).forEach(function (id) {
      if (!alive[id]) { delete state.sel[id]; n++; }
    });
    return n;
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
    h += filterBarHtml();
    h += tableHtml();
    h += '</div>';
    el.innerHTML = h;
    updateSelUI();
    /* 【build .167】双表结构就位后的四件同步（顺序不可颠倒，照抄生产 renderContent L2177-2180）：
       ① applyTableLayout —— 先按已存布局重排/设宽（表头 th 的 width 是列宽的唯一来源）；
       ② syncHeadBody —— 再把这些宽度写进表体 colgroup（必须在①之后，否则同步的是旧宽度）；
       ③ fixStickyHeadTop —— 吸附位置随操作栏/筛选条高度自适应；
       ④ syncBottomScrollbar —— 表体横向溢出时启用页面底部固定滚动条。 */
    applyTableLayout();
    syncHeadBody();
    fixStickyHeadTop();
    syncBottomScrollbar();
  }

  /** 只读提示条：不可关闭；有 qa 权限时不渲染（PRD 7.3）
      文案与 server/qa-server.js 的 WRITE_FORBIDDEN_TEXT 逐字同源（PRD 7.3），
      【build .164】指路前缀补「管理员后台 →」：员工管理已迁到 /admin/，不在生产系统菜单里。 */
  function readonlyBarHtml() {
    return '<div class="readonly-bar"><span style="font-weight:700">ⓘ</span>'
      + '<span>当前为只读访问（未获「质量管理」编辑权限），如需登记异常请联系管理员在「管理员后台 → 员工管理 → 表单写权限」中授权。</span></div>';
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
    /* 【build .167】重置列布局：只清本机的列序/列宽（写 localStorage），不影响任何业务数据。
       与「导出选中」同级（纯视图操作），只读用户也可用 —— 他们同样可能把列拖乱了。 */
    h += '<button class="btn btn-sm" onclick="QA_APP.resetLayout()" title="恢复默认列顺序与列宽">重置列布局</button>';
    h += pagerHtml();
    h += '</div>';
    return h;
  }

  function pagerHtml() {
    var shown = filteredRecords().length;
    var total = state.records.length;
    var size = state.pageSize;
    var pages = shown === 0 ? 1 : Math.ceil(shown / size);
    var pg = state.page > pages ? pages : state.page;
    if (pg < 1) pg = 1;
    /* 【build .166】有筛选时改口径为「筛选后 X / 全部 Y」——只写「共 3 条」会让用户以为数据丢了 */
    var countTxt = hasFilter()
      ? ('筛选后 ' + shown + ' / 全部 ' + total + ' 条')
      : ('共 ' + total + ' 条明细');
    var h = '<span class="tbl-pager">';
    h += '<span>' + countTxt + ' · 第 '
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

  /**
   * 可排序表头（【build .166】改为「排序图标 + 漏斗」双图标，结构与生产 thCol 同构）。
   * 漏斗尺寸/样式由 FILT_SVG 行内 12×12 + `.filt-ico` 类共同决定，**与订单管理列表逐像素一致**。
   * 【build .167】补 `data-col="<key>"`：表头的**列身份**统一走 data-col（与表体 cellHtml 的
   * `data-col` 同一套标识）。**严禁**在本系统引入 `data-key` —— 生产用 data-key、质量用 data-col，
   * 两套并存必然在双表结构（表头表 / 表体表）里错位；`qa.ledger-fields §B2` 已把 data-col 钉死。
   * @param {object} col 列定义
   * @returns {string}
   */
  function sortTh(col) {
    var key = col.key;
    var on = state.sortKey === key;
    var arrow = on ? (state.sortDir === 'asc' ? '▲' : '▼') : '⇅';
    var fact = CORE.filtActive(state.filters[key]);
    return '<th class="th-sort' + (col.type === 'num' ? ' col-num' : '') + '"'
      + ' data-col="' + esc(key) + '"'
      + ' onclick="QA_APP.sortBy(\'' + key + '\')">'
      + '<span class="th-flex"><span class="th-label">' + esc(col.label) + '</span>'
      + '<span class="sort-ico' + (on ? ' on' : '') + '">' + arrow + '</span>'
      + '<span class="filt-ico' + (fact ? ' on' : '') + '" title="筛选"'
      + ' onclick="event.stopPropagation();QA_APP.openFilter(this,\'' + key + '\')">' + FILT_SVG + '</span>'
      + '</span>'
      /* 【build .167】右缘调宽手柄（照抄生产 thCol 的 `<span class="th-rs">`）：
         绝对定位在 th 右缘 7px 内，mousedown 时由统一委托识别并转入 startColResize。
         `th.th-sort{position:relative}` 是它的定位基准，缺了会跑到页面右上角。 */
      + '<span class="th-rs" title="拖动调整列宽"></span>'
      + '</th>';
  }

  /** 表头类名：数量列与表体同样右对齐（否则"总数量"标题居左、数字居右，视觉上像错列） */
  function thClassOf(col) {
    return col.type === 'num' ? ' class="col-num"' : '';
  }

  /**
   * 表格 HTML（【build .167】升级为生产同构的**双表结构**）。
   * ------------------------------------------------------------
   * 为什么双表（照抄生产 index.html 订单列表的做法，设计见生产 L4724-4729 注释）：
   *   · 表头独立成表放进 `.sticky-head`（div sticky）随页面滚动吸附，**不用** `thead{position:sticky}` ——
   *     那在 `table-layout:fixed` + 大表格下会踩 Chrome 渲染 bug；
   *   · 表体表独立承载 tbody，两表**各带一份 colgroup**，列宽由 `syncHeadBody()` 把表头 th 的
   *     实测宽度写回表体 colgroup，从而滚动时列严格对齐。
   * 列数口径：`colN = 1（勾选列 sel-col）+ tableCols().length`。两表必须**同列数**，
   * 否则表头与表体在 fixed 布局下会整体错位（不是"差一点"，是逐列偏移）。
   * ⚠ 表头渲染循环必须留在本函数内，且保持「三元分支里调用 sortTh(cols[c])」这一写法 ——
   *   `qa.ledger-fields §B5` 的变异锚点就锚在这个串上（命中必须恰 1 次）。
   * @returns {string}
   */
  function tableHtml() {
    var pg = CORE.paginate(orderedRecords(), state.page, state.pageSize);
    state.page = pg.page;                    /* 夹紧后的页码回写，保证分页器与表体一致 */
    var rows = pg.rows;
    /* 【build .166】两种空要分开：真的没数据 vs 被筛没了。后者必须给「清除筛选」入口，
       否则用户看到"暂无异常记录"会以为台账被清空了（Q4/PRD 均要求可见性）
       【build .167】空态**不**渲染 `.sticky-head`（没有表体可对齐，空挂一条吸附表头会露出无落点的表头带） */
    if (!rows.length) return hasFilter() ? noMatchHtml() : emptyHtml();
    var cols = tableCols();
    /* 两表各带一份 colgroup（内容一致；宽度稍后由 syncHeadBody 写入表体那份） */
    var colN = cols.length + 1;
    var colg = '<colgroup>';
    for (var g = 0; g < colN; g++) colg += '<col>';
    colg += '</colgroup>';

    /* ---- 表头表（sticky） ---- */
    var h = '<div class="sticky-head"><div class="head-scroll"><table class="head-tbl">' + colg
      + '<thead><tr><th class="sel-col"></th>';
    /* 表头：可排序列走 sortTh（排序+漏斗），其余普通 th —— 白名单来自 QA_COLUMNS.sortable */
    for (var c = 0; c < cols.length; c++) {
      h += cols[c].sortable
        ? sortTh(cols[c])
        : '<th' + thClassOf(cols[c]) + ' data-col="' + esc(cols[c].key) + '">' + esc(cols[c].label) + '</th>';
    }
    h += '</tr></thead></table></div></div>';

    /* ---- 表体表 ---- */
    h += '<div class="table-wrap"><table class="body-tbl">' + colg + '<tbody>';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var id = esc(r.id);
      var cls = (state.sel[r.id] ? ' row-sel' : '') + (state.flashId === r.id ? ' row-flash' : '');
      h += '<tr data-id="' + id + '"' + (cls ? ' class="' + cls.trim() + '"' : '')
        + ' onclick="QA_APP.toggleRow(\'' + id + '\')">';
      h += '<td class="sel-col"><input type="checkbox"' + (state.sel[r.id] ? ' checked' : '')
        + ' onclick="event.stopPropagation();QA_APP.toggleRow(\'' + id + '\')"></td>';
      /* 表体：每格带 data-col，供 applyRowUpdate 精确定位（**不再按 td 下标**） */
      for (var j = 0; j < cols.length; j++) {
        h += cellHtml(cols[j], r);
      }
      h += '</tr>';
    }
    h += '</tbody></table></div>';
    return h;
  }

  /**
   * 单个单元格 HTML。所有值必须过 esc()（外部录入的文本一律不可信）。
   * long 列额外带 title=全文（3A：表格截断、悬浮看全文，避免多行文本把行高撑得参差不齐）。
   * @param {object} col 列定义
   * @param {object} rec 记录
   * @returns {string}
   */
  function cellHtml(col, rec) {
    var text = cellText(col, rec);
    var attr = ' data-col="' + esc(col.key) + '"';
    if (col.type === 'long') {
      return '<td class="col-clip"' + attr + ' title="' + esc(text) + '">' + esc(text) + '</td>';
    }
    if (col.type === 'num') {
      return '<td class="col-num"' + attr + '>' + esc(text) + '</td>';
    }
    return '<td' + attr + '>' + esc(text) + '</td>';
  }

  function emptyHtml() {
    var h = '<div class="table-wrap"><div class="empty">' + ico('list') + '<div>暂无异常记录</div>';
    if (state.canWrite) {
      h += '<button class="btn btn-sm btn-primary" onclick="QA_APP.openAddModal()">' + ico('plus') + '新增</button>';
    }
    h += '</div></div>';
    return h;
  }

  /* ============================================================
     【build .167】表格骨架 · 表头/表体/底部条 的同步（照抄生产语义，不共享代码）
     ------------------------------------------------------------
     设计 §9.3 / PRD 5.3 明文「代码共享——明确禁止」：质量系统不加载生产脚本，
     故四个函数是**同构改写**（逐行照抄 + 改选择器），每个函数头都标了来源行号。
     选择器一律收敛在 `#content` 内（与生产一致）：本页只有主区一个 content，
     这样不会误抓弹窗/侧栏里可能出现的表格。
     模块级状态：底部滚动条要"记住"上一批可滚动的表体与最大可滚距，
     故用 __bsWraps/__bsRange/__bsWrap 三个闭包变量（与生产同名同义）。
     ============================================================ */
  var __bsWraps = [];      /* 当前参与底部条联动的表体容器 */
  var __bsRange = 0;       /* 其中最大的可滚动距离（底部条的滚动范围基准） */
  var __bsWrap = null;     /* 最近一次被用户操作的容器（用于回写底部条位置） */

  /**
   * 底部固定横向滚动条（来源：生产 index.html `syncBottomScrollbar`）。
   * 表体已用 `scrollbar-width:none` 隐藏自身横条 ⇒ 由页面底部这一条统一驱动，
   * 多表并存时按"最大可滚距"等比映射（保证一一对应，不出现拖动跳变）。
   * @returns {undefined}
   */
  function syncBottomScrollbar() {
    var sb = document.getElementById('bottomScrollbar');
    var inner = document.getElementById('bottomScrollbarInner');
    if (!sb || !inner) return;
    var wraps = Array.prototype.slice.call(document.querySelectorAll('#content .table-wrap'));
    var targets = [];
    for (var i = 0; i < wraps.length; i++) {
      var w = wraps[i];
      if (w.offsetParent === null) continue;              /* 隐藏（如折叠区块）跳过 */
      if (w.scrollWidth > w.clientWidth + 2) targets.push(w);
    }
    if (!targets.length) {
      sb.style.display = 'none'; __bsWraps = []; __bsRange = 0; __bsWrap = null; return;
    }
    var range = 0;
    targets.forEach(function (t) { var r = t.scrollWidth - t.clientWidth; if (r > range) range = r; });
    __bsWraps = targets; __bsRange = range;
    sb.style.display = 'block';
    /* 可滚动范围 = 各表最大可滚距（inner 铺成「视口宽 + 最大可滚距」） */
    inner.style.width = (sb.clientWidth + range) + 'px';
    /* 首次绑定底部条拖动事件（只绑一次） */
    if (!sb._barBound) {
      sb._barBound = true;
      sb.addEventListener('scroll', function () {
        if (sb._sync) return;
        sb._sync = true;
        var R = __bsRange || 1;
        __bsWraps.forEach(function (t) {
          var tr = t.scrollWidth - t.clientWidth;
          if (tr > 0) t.scrollLeft = Math.round((sb.scrollLeft / R) * tr);
        });
        sb._sync = false;
      });
    }
    /* 用最近操作的（或第一个）表格位置来定位底部滚动条 */
    var active = (__bsWrap && targets.indexOf(__bsWrap) >= 0) ? __bsWrap : targets[0];
    __bsWrap = active;
    if (sb._sync) return;
    sb._sync = true;
    var ar = active.scrollWidth - active.clientWidth;
    sb.scrollLeft = ar > 0 ? (active.scrollLeft / ar) * range : 0;
    sb._sync = false;
  }

  /**
   * 统一恢复表格横向/纵向滚动位置（来源：生产 index.html `restoreTableScroll`）。
   * 双 rAF + 150ms 兜底：布局完全稳定后再精确设回，避免浏览器提前钳制 scrollLeft 跳最前。
   * 程序设回会触发 scroll 事件，从而自动联动表头与底部条。
   * @param {Array<{el:object,left:(number|null),top:(number|null)}>} records 待恢复的滚动记录
   * @returns {undefined}
   */
  function restoreTableScroll(records) {
    if (!records || !records.length) return;
    var apply = function () {
      records.forEach(function (rec) {
        if (!rec.el) return;
        if (rec.left != null) rec.el.scrollLeft = rec.left;
        if (rec.top != null) rec.el.scrollTop = rec.top;
      });
      syncBottomScrollbar();
    };
    requestAnimationFrame(function () {
      apply();
      requestAnimationFrame(function () {
        apply();
        setTimeout(apply, 150);      /* 兜底：字体/图片/悬停态等延迟 reflow 后再校正一次 */
      });
    });
  }

  /**
   * 吸附位置计算（来源：生产 index.html `fixStickyHeadTop`）。
   * `.sticky-head` 的 top = 顶栏(58 / 768px 下 48) + 操作栏高度与上下 margin；
   * 若操作栏与表头之间还有筛选条 `.tbl-fbar`，则把筛选条也设为 sticky 并接在同一条吸附带上，
   * 避免"筛选条夹在中间把表头顶下去"或"两者叠在同一个 top 互相遮挡"。
   * @returns {undefined}
   */
  function fixStickyHeadTop() {
    var base = window.innerWidth <= 768 ? 48 : 58;
    document.querySelectorAll('#content .sticky-head').forEach(function (hd) {
      var bb = hd.previousElementSibling;
      while (bb && !bb.classList.contains('bulk-bar')) bb = bb.previousElementSibling;
      var top = base;
      if (bb) {
        var mT = parseFloat(getComputedStyle(bb).marginTop) || 0;
        var mB = parseFloat(getComputedStyle(bb).marginBottom) || 0;
        /* sticky top 是 margin box 顶 ⇒ 顶栏 + 操作栏上下 margin + 高度，正好贴住操作栏边框盒底 */
        top += mT + bb.offsetHeight + mB;
        var fbar = bb.nextElementSibling;
        while (fbar && fbar !== hd && !fbar.classList.contains('tbl-fbar')) fbar = fbar.nextElementSibling;
        if (fbar && fbar !== hd && fbar.classList.contains('tbl-fbar')) {
          fbar.style.position = 'sticky';
          fbar.style.margin = '0';       /* 去上下 margin，贴住操作栏与表头 */
          fbar.style.top = top + 'px';
          fbar.style.zIndex = 30;
          var fT = parseFloat(getComputedStyle(fbar).marginTop) || 0;
          var fB = parseFloat(getComputedStyle(fbar).marginBottom) || 0;
          top += fT + fbar.offsetHeight + fB;
        }
      }
      hd.style.top = top + 'px';
    });
  }

  /**
   * 表头/表体列宽同步（来源：生产 index.html `syncHeadBody`）。
   * 把表头表 th 的**实测宽度**写进表体表的 colgroup，并令表体表总宽 = 表头表总宽；
   * `table-layout:fixed` 下两表列宽因此逐列一致，横向滚动时表头/表体严格对齐。
   * ⚠ 必须在表头表已插入 DOM 且完成布局后调用（renderMain 的 el.innerHTML 之后）。
   * @returns {undefined}
   */
  function syncHeadBody() {
    document.querySelectorAll('#content .sticky-head').forEach(function (hd) {
      var ht = hd.querySelector('table.head-tbl');
      var bw = hd.nextElementSibling;
      if (!bw || !bw.classList.contains('table-wrap')) return;
      var bt = bw.querySelector('table.body-tbl');
      if (!ht || !bt) return;
      var hc = ht.tHead && ht.tHead.rows[0] ? Array.prototype.slice.call(ht.tHead.rows[0].cells) : [];
      var cg = bt.querySelector('colgroup');
      if (!cg || !hc.length) return;
      var cols = cg.querySelectorAll('col');
      var total = 0;
      hc.forEach(function (th, idx) {
        var w = th.offsetWidth || 0;
        if (cols[idx]) cols[idx].style.width = w + 'px';
        total += w;
      });
      if (total > 0) bt.style.width = total + 'px';
    });
  }

  /**
   * 注册表格滚动的 capture 委托 + 窗口尺寸变化联动（来源：生产 index.html 的
   * `document.addEventListener('scroll', fn, true)` 与 `window resize` 两段）。
   * 为什么 capture：元素自身的 scroll **不冒泡**，只能在捕获阶段截到。
   * 只注册一次（由 init() 调用），不随 renderMain 重复绑定。
   * @returns {undefined}
   */
  function bindTableScrollFollow() {
    document.addEventListener('scroll', function (e) {
      var t = e.target;
      if (!t || !t.classList || !t.classList.contains('table-wrap')) return;
      /* 表体横向滚动 → 表头容器跟随（双表结构列对齐） */
      var hd = t.previousElementSibling;
      if (hd && hd.classList.contains('sticky-head')) {
        var hs = hd.querySelector('.head-scroll');
        if (hs && hs.scrollLeft !== t.scrollLeft) hs.scrollLeft = t.scrollLeft;
      }
      var sb = document.getElementById('bottomScrollbar');
      if (sb && sb.style.display === 'block' && __bsWraps && __bsWraps.indexOf(t) >= 0) {
        __bsWrap = t;
        if (sb._sync) return;
        sb._sync = true;
        var wr = t.scrollWidth - t.clientWidth;
        sb.scrollLeft = (__bsRange > 0 && wr > 0) ? (t.scrollLeft / wr) * __bsRange : 0;
        sb._sync = false;
      }
    }, true);
    window.addEventListener('resize', function () {
      syncBottomScrollbar(); syncHeadBody(); fixStickyHeadTop();
    });
  }

  /* ============================================================
     【build .167】列布局引擎：拖宽 + 拖序 + 本地持久化
     ------------------------------------------------------------
     语义全部照抄生产 index.html 的列布局引擎（各函数头标了来源行号），四处**必要**差异：
       1. 模块名固定 `TBL_M = 'qaLog'`（生产按 `data-m` 区分多模块，质量只有一张表）；
       2. 列身份用 **`data-col`**（生产用 `data-key`）—— 本系统列身份契约见 sortTh 注释；
       3. **只落 localStorage**（`wb_cb_qa_tblLayout_v1`）：qa-server 没有 /api/layout 端点，
          不做服务端分片（登记为 D13，将来升服务端时形状已预留 `def` 层，见 normalizeLayout）；
       4. 单行模型 ⇒ 省掉生产"无 data-key 物理索引"兼容分支（质量每行每列都带 data-col）。
     铁律：本区块**不读生产任何全局**（不碰 products/orders/tblLayout），也不碰服务端。
     ============================================================ */
  var tblLayout = {};   /* {qaLog:{order:[key…],widths:{key:px}}} —— 内存态，恒为本机这份 */

  /** 合法「布局映射」判定（来源：生产 isLayoutMap L1713；与 server 端同口径）：
      对象且**非数组**；空对象 `{}` 合法（＝尚无已存布局） */
  function isLayoutMap(v) { return !!(v && typeof v === 'object' && !Array.isArray(v)); }

  /**
   * 布局归一（宽进严出，来源：生产 isLayoutMap L1713 + normLayoutServer L1719 的净化纪律）。
   * 存储形状：`{v:1, def:{qaLog:{order:[…],widths:{…}}}}`（与生产 v2 的 `def` 层同构，只是没有 `u` 分片）。
   * 归一规则（**任何畸形输入都不得抛错、不得白屏**）：
   *   · 非对象 / 数组 / null ⇒ `{}`；
   *   · 无 `def` 层（老形状/手工塞的）⇒ 把自身当 def 读，兼容历史；
   *   · `order` 里非字符串 / 空串 / **未知列 key**（colOf 查不到）/ 重复项 ⇒ 逐项剔除；
   *   · `widths[k]` 非有限正数（字符串 '120px'、NaN、负数、0）⇒ 剔除该键；
   *   · 某模块剔除后既无 order 也无 widths ⇒ **整块丢弃**（等价"该系统尚无自定义布局"）；
   *   · 全程**新建对象**返回（深拷贝语义）⇒ 调用方拿去改不会污染任何"基准"。
   * @param {*} v 原始存储内容（localStorage 解析结果或任意畸形值）
   * @returns {Object} 归一后的布局映射
   */
  function normalizeLayout(v) {
    var out = {};
    if (!isLayoutMap(v)) return out;
    var src = isLayoutMap(v.def) ? v.def : v;      /* 兼容无 def 层的扁平形状 */
    Object.keys(src).forEach(function (m) {
      var per = src[m];
      if (!isLayoutMap(per)) return;               /* 该模块非对象 ⇒ 丢弃该模块 */
      var order = [];
      if (Array.isArray(per.order)) {
        var seen = {};
        per.order.forEach(function (k) {
          if (typeof k !== 'string' || !k) return;  /* 非字符串/空串剔除 */
          if (!colOf(k)) return;                    /* 未知列 key 剔除（列已删或手改过存储） */
          if (seen[k]) return;                      /* 重复项剔除：同一列只能有一个名次 */
          seen[k] = 1; order.push(k);
        });
      }
      var widths = {};
      if (isLayoutMap(per.widths)) {
        Object.keys(per.widths).forEach(function (k) {
          if (!colOf(k)) return;                    /* 未知列宽度无意义 */
          var w = per.widths[k];
          if (typeof w !== 'number' || !isFinite(w) || w <= 0) return;   /* 非数字/NaN/0/负数剔除 */
          widths[k] = Math.round(w);
        });
      }
      if (!order.length && !Object.keys(widths).length) return;          /* 空壳模块丢弃 */
      out[m] = { order: order, widths: widths };
    });
    return out;
  }

  /** 取（必要时创建）某模块的布局槽（来源：生产 layoutOf L1742，同构） */
  function layoutOf(m) {
    if (!tblLayout[m]) tblLayout[m] = { order: null, widths: {} };
    return tblLayout[m];
  }

  /** 读本地布局（解析失败/隐私模式禁用 localStorage ⇒ 视同"无自定义布局"，绝不白屏） */
  function loadLayout() {
    try {
      var raw = localStorage.getItem(LAYOUT_KEY);
      tblLayout = raw ? normalizeLayout(JSON.parse(raw)) : {};
    } catch (e) {
      tblLayout = {};
    }
    return tblLayout;
  }

  /**
   * 落盘（来源：生产 saveLayoutLocal L1772 的落盘纪律；差异＝键名与形状，见下）。
   * 写出形状 `{v:1, def:{…}}` —— **刻意**与生产 v2 的 def 层同构：
   * 将来 qa-server 有了 layout 端点，形状只需升级成 `{v:2,def,u:{username:…}}`，
   * 读取侧加一句"u[当前用户] 优先"即可，**零迁移**（老数据落在 def 层，正好是"我的默认"）。
   * 写失败（配额满/隐私模式）静默——布局是体验增强，不该弹错打断登记。
   * @returns {undefined}
   */
  function saveLayoutLocal() {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify({ v: 1, def: tblLayout }));
    } catch (e) { /* 静默：见上 */ }
  }

  /** 重置列布局（来源：生产 resetTableLayout L1959 语义的本地版）：清空自定义 ⇒ 回 schema 顺序 */
  function resetLayout() {
    tblLayout = {};
    saveLayoutLocal();
    renderMain();
  }

  /**
   * 按已存布局重排 + 设宽（来源：生产 applyTableLayout L1780-1858）。
   * 与生产的差异（均为必要差异，逐条对应）：
   *   · 列身份用 `data-col` 而非 `data-key`（本系统列身份契约）；因此**不存在**"无 key 物理索引兼容分支"；
   *   · 只处理一张表（台账双表：表头表 + 表体表），不遍历 `#content table`；
   *   · 保留「**跳过含 colspan 的行**」守卫 —— 台账现在是单行模型用不到，
   *     但将来加小计行/展开行时，靠下标重排会把合并行拆坏，故守卫必须提前在。
   * @returns {undefined}
   */
  function applyTableLayout() {
    var hd = document.querySelector('#content .sticky-head');
    if (!hd) return;
    var ht = hd.querySelector('table.head-tbl');
    if (!ht || !ht.tHead || !ht.tHead.rows.length) return;
    var bw = hd.nextElementSibling;
    var bt = (bw && bw.classList.contains('table-wrap')) ? bw.querySelector('table.body-tbl') : null;
    var lo = layoutOf(TBL_M);
    var headCells = Array.prototype.slice.call(ht.tHead.rows[0].cells);
    /* 可重排的列槽位 = 带 data-col 的 th（勾选列没有 ⇒ 永远钉在首位） */
    var slots = [];
    headCells.forEach(function (th, i) { if (th.getAttribute('data-col')) slots.push(i); });
    if (slots.length < 2) return;
    var curKeys = slots.map(function (i) { return headCells[i].getAttribute('data-col'); });
    /* 目标顺序 = 已存顺序（过滤掉已不存在的列）+ 新增列按当前顺序追加（来源：生产 L1805-1806） */
    var order = (lo.order || []).filter(function (k) { return curKeys.indexOf(k) >= 0; });
    curKeys.forEach(function (k) { if (order.indexOf(k) < 0) order.push(k); });

    /* 重排：表头表 + 表体表**都**按 data-col 匹配整行重排（绝不按下标移动单元格） */
    var tables = bt ? [ht, bt] : [ht];
    tables.forEach(function (tbl) {
      Array.prototype.slice.call(tbl.rows).forEach(function (row) {
        if (row.cells.length < 2) return;
        var cells = Array.prototype.slice.call(row.cells);
        /* 守卫：含 colspan 的合并行整行跳过（按下标重排会把它拆坏） */
        for (var ci = 0; ci < cells.length; ci++) {
          if ((cells[ci].getAttribute('colspan') || '') !== '') return;
        }
        var keyed = cells.filter(function (c) { return c.getAttribute && c.getAttribute('data-col'); });
        if (keyed.length < 2) return;
        var rowKeys = keyed.map(function (c) { return c.getAttribute('data-col'); });
        var target = order.filter(function (k) { return rowKeys.indexOf(k) >= 0; });
        rowKeys.forEach(function (k) { if (target.indexOf(k) < 0) target.push(k); });
        var same = target.length === rowKeys.length && target.every(function (k, i) { return k === rowKeys[i]; });
        if (same) return;
        /* 按目标顺序 appendChild：非 key 单元格（勾选列）不动，key 单元格整体重排（来源：生产 L1820-1823） */
        target.forEach(function (k) { row.appendChild(keyed[rowKeys.indexOf(k)]); });
      });
    });

    /* 列宽：先量 auto 布局下的内容宽度（作为"没拖过的列"的默认值，必须在切 fixed 之前读） */
    var curW = headCells.map(function (th) { return th.offsetWidth || 0; });
    ht.style.tableLayout = 'fixed';
    if (bt) bt.style.tableLayout = 'fixed';
    headCells.forEach(function (th, i) {
      var k = th.getAttribute('data-col');
      var cur = curW[i] || 0;
      if (k) {
        var saved = (lo.widths && lo.widths[k]) ? lo.widths[k] : null;
        var w = saved != null ? Math.max(minThWidth(th), saved) : Math.max(minThWidth(th), cur || 120);
        th.style.width = w + 'px';
      } else {
        th.style.width = Math.max(36, cur) + 'px';   /* 勾选列：按内容宽，保底 36px（来源：生产 L1853） */
      }
    });
  }

  /**
   * 拖序结果计算（来源：生产 startColDrag 的 up 回调 L1904-1911）。
   * 生产把这段计算写在事件回调里；此处**提成纯函数**，语义逐行相同（取出 → 找落点 → 插入），
   * 好处是能在无 DOM 的回归测试里**真执行**这段顺序算法（否则只能靠正则"看代码"）。
   * @param {Array<string>} curOrder 当前表头顺序（含被拖列）
   * @param {string} dragKey 被拖列的 key
   * @param {{key:string,before:boolean}} marker 落点列与左右
   * @returns {Array<string>} 新顺序（长度与 curOrder 相同）
   */
  function reorderKeys(curOrder, dragKey, marker) {
    var out = curOrder.slice();
    var idx = out.indexOf(dragKey);
    if (idx >= 0) out.splice(idx, 1);
    var ti = out.indexOf(marker.key);
    if (ti < 0) ti = out.length;
    out.splice(marker.before ? ti : ti + 1, 0, dragKey);
    return out;
  }

  /* ---- 拖拽调序（来源：生产 startColDrag L1872-1929） ---- */
  var colDrag = null;
  function startColDrag(e, th) {
    /* 漏斗图标的点击**绝不**启动拖拽（生产把这条排除写在委托里 L1866；此处收进本函数，
       让"任何调用路径都不会从漏斗开始拖列"成为单点保证，也便于静态守卫直接钉住本函数）。 */
    if (e.target && e.target.closest && e.target.closest('.filt-ico')) return;
    colDrag = { th: th, key: th.getAttribute('data-col'), x: e.clientX, moved: false, targets: [], marker: null };
    var move = function (ev) {
      if (!colDrag) return;
      if (!colDrag.moved && Math.abs(ev.clientX - colDrag.x) < 6) return;   /* 6px 死区，防误触 */
      if (!colDrag.moved) {
        colDrag.moved = true;
        document.body.classList.add('col-dragging');
        th.classList.add('th-dragging');
        colDrag.targets = Array.prototype.slice.call(document.querySelectorAll('#content th.th-sort[data-col]'));
      }
      /* 清除旧落点指示 */
      colDrag.targets.forEach(function (t) { t.classList.remove('th-drop-before', 'th-drop-after'); });
      var el = document.elementFromPoint(ev.clientX, ev.clientY);
      var t = (el && el.closest) ? el.closest('#content th.th-sort[data-col]') : null;
      if (t && t !== th) {
        var r = t.getBoundingClientRect();
        var before = (ev.clientX - r.left) < r.width / 2;
        t.classList.add(before ? 'th-drop-before' : 'th-drop-after');
        colDrag.marker = { key: t.getAttribute('data-col'), before: before };
      } else colDrag.marker = null;
    };
    var up = function () {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      if (colDrag && colDrag.moved && colDrag.marker) {
        /* 记录布局应用前的横向滚动位置（调序后列宽/总宽变化，需在布局稳定后设回） */
        var scPos = [];
        document.querySelectorAll('#content .table-wrap,#content .head-scroll').forEach(function (sc) {
          if (sc.scrollLeft > 0) scPos.push({ el: sc, left: sc.scrollLeft });
        });
        var curOrder = Array.prototype.slice.call(document.querySelectorAll('#content thead th.th-sort[data-col]'))
          .map(function (t) { return t.getAttribute('data-col'); });
        layoutOf(TBL_M).order = reorderKeys(curOrder, colDrag.key, colDrag.marker);
        saveLayoutLocal();
        applyTableLayout();
        syncHeadBody();          /* 调序后同步表体列宽 */
        restoreTableScroll(scPos);
      }
      if (colDrag) {
        colDrag.targets.forEach(function (t) { t.classList.remove('th-drop-before', 'th-drop-after'); });
        th.classList.remove('th-dragging');
      }
      /* 拖过的标记：供 sortBy 的 350ms 抑制使用（否则拖完紧跟的 click 会顺手改排序） */
      if (colDrag && colDrag.moved) window.__colDragTS = Date.now();
      document.body.classList.remove('col-dragging');
      colDrag = null;
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  /**
   * 表头可拖至的最小宽度（来源：生产 minThWidth L1933-1949）。
   * = 字段名第一个字的宽度 + “..”(省略号) + 排序符号 + 筛选符号 + 左右 padding + 余量。
   * 常量逐项来源：19 = 筛选图标 12 + 左距 5 + padding 2；20 = th 左右 padding；4 = 余量；
   * sortW += 3 = .sort-ico 的左间距；`sortW<6 ⇒ 9` 是"字体量不出 ⇅ 时按 9px 兜底"。
   * ⚠ 与生产的唯一差异：**删掉 locked 分支**（质量系统没有锁定字段，多留的 18px 只会让列更宽）。
   * @param {object} th 表头单元格
   * @returns {number} 最小宽度（px）
   */
  function minThWidth(th) {
    try {
      var lb = th.querySelector('.th-label');
      var label = lb ? (lb.textContent || '').trim() : '';
      var cs = getComputedStyle(th);
      var ctx = document.createElement('canvas').getContext('2d');
      ctx.font = cs.fontSize + ' ' + cs.fontFamily;
      var firstW = label ? ctx.measureText(label.charAt(0)).width : 0;
      var dotsW = ctx.measureText('..').width;
      ctx.font = '9px ' + cs.fontFamily;                   /* 排序符号字号 9px（与 .sort-ico 一致） */
      var sortW = ctx.measureText('⇅').width;              /* 最宽排序符号 */
      if (sortW < 6) sortW = 9;
      sortW += 3;                                          /* .sort-ico 左间距 */
      return Math.ceil(firstW + dotsW + sortW + 19 + 20 + 4);
    } catch (e) {
      return 60;                                           /* 量不出就兜底 60px（生产同款） */
    }
  }

  /* ---- 拖拽调宽（来源：生产 startColResize L1950-1996） ---- */
  function startColResize(e, th) {
    e.preventDefault();
    e.stopPropagation();
    var key = th.getAttribute('data-col');
    var tbl = th.closest('table');
    /* 预取表体表 col / 总宽：拖动中**实时**同步列宽，松开时不再跳变
       （fixed 布局下表宽=列宽总和，须同步总宽，否则表体被压缩） */
    var _btCols = null, _btTbl = null, _btTotal = 0, _idx = -1;
    var hd2 = tbl.closest('.sticky-head');
    if (hd2) {
      var _bw = hd2.nextElementSibling;
      if (_bw && _bw.classList.contains('table-wrap')) {
        _btTbl = _bw.querySelector('table.body-tbl');
        var _cg = _btTbl ? _btTbl.querySelector('colgroup') : null;
        if (_cg) _btCols = _cg.querySelectorAll('col');
        var _ths = Array.prototype.slice.call(tbl.tHead.rows[0].cells);
        _idx = _ths.indexOf(th);
        _btTotal = _btTbl ? (parseFloat(_btTbl.style.width) || 0) : 0;
      }
    }
    var startX = e.clientX, startW = th.offsetWidth;
    var minW = minThWidth(th);
    document.body.classList.add('col-resizing');
    var move = function (ev) {
      var w = Math.max(minW, startW + ev.clientX - startX);
      th.style.width = w + 'px';
      /* fixed 布局下表宽=各列宽之和，自动随列宽变化 */
      if (_btCols && _idx >= 0 && _btCols[_idx]) {
        _btCols[_idx].style.width = w + 'px';
        if (_btTbl && _btTotal > 0) _btTbl.style.width = (_btTotal + (w - startW)) + 'px';
      }
    };
    var up = function () {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('col-resizing');
      window.__colDragTS = Date.now();          /* 同拖序：抑制紧随的 click 触发排序 */
      var scPos = [];
      document.querySelectorAll('#content .table-wrap,#content .head-scroll').forEach(function (sc) {
        if (sc.scrollLeft > 0) scPos.push({ el: sc, left: sc.scrollLeft });
      });
      layoutOf(TBL_M).widths[key] = Math.round(th.getBoundingClientRect().width);
      saveLayoutLocal();
      if (tbl && tbl.style.tableLayout === 'fixed') syncHeadBody();
      restoreTableScroll(scPos);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  /**
   * 统一鼠标交互入口（来源：生产 L1861-1868）。
   * 右缘 `.th-rs` 手柄 = 调宽；其余（含列名/排序图标） = 拖拽调序；
   * 漏斗图标的排除收在 startColDrag 内（见那里的注释）。
   * 只认 `#content th.th-sort[data-col]`：勾选列表头没有 data-col，天然不参与。
   * @returns {undefined}
   */
  function bindColInteractions() {
    document.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      var th = e.target.closest ? e.target.closest('#content th.th-sort[data-col]') : null;
      if (!th || !th.getAttribute('data-col')) return;
      if (e.target.classList && e.target.classList.contains('th-rs')) { startColResize(e, th); return; }
      startColDrag(e, th);
    });
  }

  /* ---------- 排序 / 分页 ---------- */
  /**
   * 排序（【build .166 · Q1A】三态循环，与生产 toggleSort 同口径）：
   *   其他列 → 升序 → 降序 → **取消（回默认：日期倒序）**
   * 初始方向是**升序**（生产 `s.sort={key,dir:1}` 同为 1=升），连点两次即降序，第三次取消。
   * @param {string} key 列 key
   * @returns {undefined}
   */
  function sortBy(key) {
    /* 【build .167】拖拽抑制（照抄生产 toggleSort L1383）：拖完列/调完宽会紧跟一次 click，
       若不拦就会"拖一下顺手把排序也改了"。350ms 是生产的既有经验值。 */
    if (Date.now() - (window.__colDragTS || 0) < 350) return;
    var col = colOf(key);
    if (!col || !col.sortable) return;
    if (state.sortKey !== key) { state.sortKey = key; state.sortDir = 'asc'; }
    else if (state.sortDir === 'asc') { state.sortDir = 'desc'; }
    else { state.sortKey = 'date'; state.sortDir = 'desc'; }   /* 取消 → 回默认视图 */
    state.page = 1;                       /* 排序后回第 1 页（生产同款） */
    renderMain();                         /* 排序不改变可见集合 ⇒ **不**清选中（Q4A 只管筛选） */
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

  /* ============================================================
     筛选（【build .166】仿生产订单管理列表 · 同构改写，不共享代码）
     ------------------------------------------------------------
     分工铁律（与生产 filterBar/thCol/applyFilt 同一套思路）：
       · **判定**全在 qa-core（matchFilter / applyFilters / filtActive / modeNeedsVal）；
         本区块只负责「收集 f」「拼 DOM」「写 state」，**一行匹配逻辑都不许写在这里**
       · 漏斗点亮判据 = CORE.filtActive(同一份)，禁止在 sortTh 里另写一套
         （生产 .161 就栽在「筛选条放行」与「漏斗点亮」各写一份，出现"筛了但图标不亮"）
       · 模式清单来自 CORE.filtModesOf(type)，本文件不写模式字面量
     ============================================================ */

  /** 当前打开的面板对应的列 key（fpModeChange 需要知道列类型） */
  var filtPop = null;

  /** 关闭筛选浮层（幂等） */
  function closeFilt() {
    if (filtPop && filtPop.parentNode) filtPop.parentNode.removeChild(filtPop);
    filtPop = null;
    state.filtKey = '';
  }

  /**
   * 筛选状态条：有生效筛选时出现在工具栏与表格之间。
   * @returns {string} 无筛选时返回空串（不占位）
   */
  function filterBarHtml() {
    var keys = Object.keys(state.filters).filter(function (k) {
      return CORE.filtActive(state.filters[k]);
    });
    if (!keys.length) return '';
    var chips = keys.map(function (k) {
      var col = colOf(k);
      if (!col) return '';
      var f = state.filters[k];
      var txt;
      if (f.mode === 'range') txt = col.label + ' ' + f.from + '~' + f.to;
      else if (!CORE.modeNeedsVal(f.mode)) txt = col.label + ' ' + (CORE.FILT_MODE_NAME[f.mode] || '');
      else txt = col.label + ' ' + (CORE.FILT_MODE_NAME[f.mode] || '') + f.val;
      return '<span class="fchip">' + esc(txt)
        + ' <b title="移除该筛选" onclick="QA_APP.clearFilt(\'' + esc(k) + '\')">×</b></span>';
    }).join('');
    return '<div class="tbl-fbar">' + chips
      + '<button class="btn btn-sm" onclick="QA_APP.clearAllFilt()">清除全部</button></div>';
  }

  /** 筛选无匹配时的空状态（必须给「清除筛选」出口，否则用户以为台账被清空了） */
  function noMatchHtml() {
    return '<div class="table-wrap"><div class="empty">' + ico('list')
      + '<div>当前筛选条件下没有匹配的记录</div>'
      + '<button class="btn btn-sm" style="margin-top:10px" onclick="QA_APP.clearAllFilt()">清除全部筛选</button>'
      + '</div></div>';
  }

  /**
   * 打开某列的筛选浮层。
   * 交互与生产 openFilter 一致：点漏斗弹出、点外部/取消关闭、确定/清除生效。
   * @param {Element} el 漏斗元素（用于定位）
   * @param {string} key 列 key
   * @returns {undefined}
   */
  function openFilter(el, key) {
    closeFilt();
    var col = colOf(key);
    if (!col) return;
    state.filtKey = key;
    var f = state.filters[key] || null;
    var modes = CORE.filtModesOf(col.type);
    var curMode = (f && f.mode) ? f.mode : modes[0][0];
    if (modes.every(function (x) { return x[0] !== curMode; })) curMode = modes[0][0];

    var inner = '<select id="qa_fp_mode" onchange="QA_APP.fpModeChange()">'
      + modes.map(function (x) {
        return '<option value="' + x[0] + '"' + (curMode === x[0] ? ' selected' : '') + '>'
          + esc(x[1]) + '</option>';
      }).join('')
      + '</select>';

    /* 输入控件按列类型生成（不在运行时改 input.type —— 部分浏览器改 type 会丢当前值） */
    var vType = col.type === 'num' ? 'number' : (col.type === 'date' ? 'date' : 'text');
    var vPh = col.type === 'num' ? '输入数值' : (col.type === 'date' ? '' : '输入关键字');
    inner += '<input type="' + vType + '" id="qa_fp_val" placeholder="' + vPh + '"'
      + ' value="' + esc(f && f.val != null ? f.val : '') + '"'
      + ' onkeydown="if(event.key===\'Enter\'){event.preventDefault();QA_APP.applyFilt(\'' + esc(key) + '\');}">';
    if (col.type === 'date') {
      inner += '<span id="qa_fp_drange" style="display:none;align-items:center;gap:4px">'
        + '<input type="date" id="qa_fp_from" value="' + esc(f && f.from ? f.from : '') + '" style="width:auto">'
        + '<span style="color:var(--muted)">~</span>'
        + '<input type="date" id="qa_fp_to" value="' + esc(f && f.to ? f.to : '') + '" style="width:auto">'
        + '</span>';
    }

    var pop = document.createElement('div');
    pop.className = 'filt-pop';
    pop.innerHTML = '<div class="fp-title">筛选：' + esc(col.label) + '</div>' + inner
      + '<div class="fp-btns">'
      + '<button class="btn btn-sm" onclick="QA_APP.closeFilt()">取消</button>'
      + '<button class="btn btn-sm" onclick="QA_APP.clearFilt(\'' + esc(key) + '\')">清除</button>'
      + '<button class="btn btn-sm btn-primary" onclick="QA_APP.applyFilt(\'' + esc(key) + '\')">确定</button>'
      + '</div>';
    document.body.appendChild(pop);
    pop.addEventListener('click', function (e) { e.stopPropagation(); });

    var r = el.getBoundingClientRect();
    var left = r.left;
    if (left + 240 > window.innerWidth - 8) left = window.innerWidth - 248;
    if (left < 8) left = 8;
    pop.style.left = left + 'px';
    pop.style.top = (r.bottom + 6 + window.scrollY) + 'px';
    filtPop = pop;
    fpModeChange();                        /* 按当前模式初始化输入区显隐（二次打开要回显） */
    var inp = $('qa_fp_val');
    if (inp && inp.style.display !== 'none') { try { inp.focus(); } catch (e) { /* 无焦点权限时忽略 */ } }
  }

  /** 模式切换：需要值的模式显示输入框；日期「从…到…」显示双日期并隐藏单值框 */
  function fpModeChange() {
    var col = colOf(state.filtKey);
    var mEl = $('qa_fp_mode'), vEl = $('qa_fp_val'), rEl = $('qa_fp_drange');
    if (!col || !mEl) return;
    var mode = mEl.value;
    var isRange = (col.type === 'date' && mode === 'range');
    if (rEl) rEl.style.display = isRange ? 'inline-flex' : 'none';
    if (vEl) vEl.style.display = (CORE.modeNeedsVal(mode) && !isRange) ? '' : 'none';
  }

  /**
   * 应用当前面板的筛选。
   * 空值语义：需要值的模式但输入框是空 ⇒ **视为清除该列筛选**（不 alert、不写入无效筛选）。
   * 理由：写一条"无效筛选"进 state 会让漏斗图标与 chips 出现却不生效，
   * 用户会反复点「确定」怀疑系统坏了。要清就干脆清掉。
   * @param {string} key 列 key
   * @returns {undefined}
   */
  function applyFilt(key) {
    var col = colOf(key);
    if (!col) { closeFilt(); return; }
    var mEl = $('qa_fp_mode');
    var mode = mEl ? mEl.value : (CORE.filtModesOf(col.type)[0][0]);
    var f = { mode: mode, val: '' };
    if (col.type === 'date' && mode === 'range') {
      var fromEl = $('qa_fp_from'), toEl = $('qa_fp_to');
      f.from = fromEl ? String(fromEl.value || '') : '';
      f.to = toEl ? String(toEl.value || '') : '';
      if (!f.from || !f.to) { alert('请选择「从…到…」的起止日期'); return; }
    } else if (CORE.modeNeedsVal(mode)) {
      var vEl = $('qa_fp_val');
      f.val = vEl ? String(vEl.value || '').trim() : '';
      if (f.val === '') {                   /* 空输入 ⇒ 等同清除本列筛选 */
        delete state.filters[key];
        afterFiltChange();
        return;
      }
    }
    state.filters[key] = f;
    afterFiltChange();
  }

  /**
   * 筛选变化后的统一收尾（【build .166】唯一入口，禁止各调用方自己拼这三步）。
   * 顺序有意义：先关浮层（否则重绘后浮层挂在旧坐标上）→ 清隐藏行勾选（Q4A）→ 回第 1 页 → 重绘。
   * @returns {undefined}
   */
  function afterFiltChange() {
    closeFilt();
    pruneSelToVisible();                   /* Q4A：被筛掉的行不得继续处于选中态 */
    state.page = 1;                        /* 筛选变化回第 1 页（生产同款） */
    renderMain();
  }

  /** 清除单列筛选 */
  function clearFilt(key) {
    delete state.filters[key];
    afterFiltChange();
  }

  /** 清除全部筛选 */
  function clearAllFilt() {
    state.filters = {};
    afterFiltChange();
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
   * @param {boolean=} wide 是否用加宽外壳（台账 9 个字段，420px 装不下三列数量并排）
   */
  function openModalShell(title, bodyHtml, okText, okHandler, wide) {
    var m = $('modal');
    var bg = $('modalBg');
    if (!m || !bg) return;
    var handler = okHandler || 'QA_APP.saveModal()';
    m.className = 'modal' + (wide ? ' modal-wide' : '');
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

  /**
   * 台账表单（新增 / 编辑共用）。字段清单、控件类型、分行**全部**来自 QA_COLUMNS ——
   * 加字段只改列定义，本函数一个字都不用动（这是 PRD §二「加字段成本近乎为零」的落地形态）。
   * @param {object|null} rec 编辑时的原记录；null = 新增
   * @param {string} noHint 编号提示文案（新增态="正在申请"，编辑态="自动生成不可修改"）
   * @returns {string}
   */
  function recordFormHtml(rec, noHint) {
    var cols = formCols();
    var rows = {};
    var order = [];
    cols.forEach(function (c) {
      if (!rows[c.formRow]) { rows[c.formRow] = []; order.push(c.formRow); }
      rows[c.formRow].push(c);
    });
    order.sort(function (a, b) { return a - b; });
    var h = '';
    order.forEach(function (rn) {
      h += '<div class="form-row">';
      rows[rn].forEach(function (c) {
        h += '<div>' + formFieldHtml(c, rec, c.key === 'no' ? noHint : '') + '</div>';
      });
      h += '</div>';
    });
    /* 【build .165】数量关系提示位（5A：只提示不拦截，见 checkQtyHint） */
    h += '<div class="hint hint-warn" id="qa_qty_hint"></div>';
    return h;
  }

  /**
   * 单个表单控件。
   * @param {object} col 列定义
   * @param {object|null} rec 原记录（回填值来源）
   * @param {string} hintText 覆盖列定义里的默认 hint 文案（空则用 col.hint）
   * @returns {string}
   */
  function formFieldHtml(col, rec, hintText) {
    var v = cellText(col, rec);
    var id = 'qa_f_' + col.key;
    var label = '<label>' + esc(col.label) + (col.required ? ' *' : '') + '</label>';
    var ctrl;
    if (col.formKind === 'readonly') {
      ctrl = '<input id="' + id + '" value="' + esc(v) + '" readonly>';
    } else if (col.formKind === 'date') {
      ctrl = '<input type="date" id="' + id + '" value="' + esc(v) + '">';
    } else if (col.formKind === 'number') {
      /* 1A：数量按 number 落库；min/step 只是浏览器提示，真正的格式校验在 collectFormBody */
      ctrl = '<input type="number" min="0" step="1" id="' + id + '" value="' + esc(v) + '"'
        + ' oninput="QA_APP.checkQtyHint()" onchange="QA_APP.checkQtyHint()">';
    } else if (col.formKind === 'textarea') {
      /* 长文本用 textarea：内容放标签体内而不是 value 属性（属性里的换行会被浏览器吃掉） */
      ctrl = '<textarea rows="3" id="' + id + '">' + esc(v) + '</textarea>';
    } else {
      ctrl = '<input id="' + id + '" value="' + esc(v) + '">';
    }
    var hint = '';
    if (col.hint !== undefined) {
      hint = '<div class="hint" id="' + id + '_hint">' + esc(hintText || col.hint) + '</div>';
    }
    return label + ctrl + hint;
  }

  /** 表单里某字段的当前数值（空/非法 ⇒ null，用于提示计算，不参与落库） */
  function numOf(key) {
    var el = $('qa_f_' + key);
    if (!el) return null;
    var raw = String(el.value === undefined || el.value === null ? '' : el.value).trim();
    if (raw === '') return null;
    var n = Number(raw);
    return isFinite(n) ? n : null;
  }

  /**
   * 【build .165 · 5A】数量关系**只提示不拦截**。
   * 「异常数量 > 检测数量」「检测数量 > 总数量」在现实里是**可能真实发生**的
   * （超检、复检、抽样口径不同），硬拦会让用户被迫填假数字 —— 那比数据可疑更糟。
   * @returns {undefined}
   */
  function checkQtyHint() {
    var el = $('qa_qty_hint');
    if (!el) return;
    var t = numOf('totalQty');
    var i = numOf('inspectedQty');
    var d = numOf('defectQty');
    var msgs = [];
    if (d !== null && i !== null && d > i) msgs.push('异常数量大于检测数量');
    if (i !== null && t !== null && i > t) msgs.push('检测数量大于总数量');
    el.textContent = msgs.length ? ('⚠ ' + msgs.join('；') + '，请确认无误后保存（不阻止保存）') : '';
  }

  /**
   * 表单 → 请求体。
   * 空值语义（1A 决策：**未填 ≠ 0**）：
   *   · 新增：空值不落键 ⇒ 数据文件里根本没有该键，列表显示空白
   *   · 编辑：空值发 null ⇒ 显式清空。**必须发**，否则 qa-store.applyUpdate 的
   *     `Object.assign({}, rec, extras)` 会把旧值原样留下，用户清空后保存看起来"没生效"
   * @param {object|null} rec 编辑时的原记录（null = 新增）
   * @returns {{body: object}|{error: string}}
   */
  function collectFormBody(rec) {
    var body = {};
    var err = '';
    formCols().forEach(function (c) {
      if (c.formKind === 'readonly') return;      /* 编号由服务端权威，绝不进 body（服务端会 400） */
      var el = $('qa_f_' + c.key);
      if (!el) return;
      var raw = String(el.value === undefined || el.value === null ? '' : el.value).trim();
      if (c.formKind === 'number') {
        if (raw === '') { if (rec) body[c.key] = null; return; }
        var n = Number(raw);
        if (!isFinite(n) || n < 0 || Math.floor(n) !== n) {
          if (!err) err = '「' + c.label + '」必须是非负整数';
          return;
        }
        body[c.key] = n;
        return;
      }
      if (raw === '') { if (rec) body[c.key] = null; return; }
      body[c.key] = raw;
    });
    return err ? { error: err } : { body: body };
  }

  function openAddModal() {
    if (!state.canWrite) return;
    state.modalMode = 'add';
    state.modalId = '';
    state.modalNo = '';
    state.modalNoLoading = true;
    openModalShell('新增异常记录',
      recordFormHtml({ date: CORE.todayStr() }, '正在向服务端申请编号…'), '保存', 'QA_APP.saveModal()', true);
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
      recordFormHtml(rec, '系统自动生成，不可修改'), '保存', 'QA_APP.saveModal()', true);
    checkQtyHint();
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
    var rec = state.modalMode === 'edit' ? findRec(state.modalId) : null;
    var got = collectFormBody(rec);
    if (got.error) { alert(got.error); return; }
    var body = got.body;
    body.date = date;                       /* 日期已单独校验，以校验后的值为准 */
    if (state.modalMode === 'add') await submitAdd(body);
    else if (state.modalMode === 'edit') await submitEdit(body);
  }

  async function submitAdd(body) {
    if (state.modalNoLoading) { alert('编号申请中，请稍候…'); return; }
    if (state.busy) return;
    state.busy = true;
    setSaveBtnEnabled(false);
    var payload = Object.assign({}, body);
    if (state.modalNo) payload.no = state.modalNo;
    try {
      var j;
      try {
        j = await apiQa('/exceptions', { method: 'POST', body: JSON.stringify(payload) });
      } catch (e) {
        /* 409：编号被别人抢先占用 ⇒ 用服务端 suggest **静默重提交一次**，用户无感（PRD P0-10） */
        if (e.status === 409 && e.json && e.json.suggest) {
          payload.no = e.json.suggest;
          j = await apiQa('/exceptions', { method: 'POST', body: JSON.stringify(payload) });
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

  async function submitEdit(body) {
    if (state.busy) return;
    state.busy = true;
    setSaveBtnEnabled(false);
    try {
      var j = await apiQa('/exceptions/' + encodeURIComponent(state.modalId), {
        method: 'PUT',
        body: JSON.stringify(body)
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

  /**
   * 用服务端返回的权威记录替换本地副本，并只重绘那一行的单元格。
   * 【build .165】定位方式从「td 下标」改为 `td[data-col]`：
   * 旧写法 `tds[1]/tds[2]` 在台账从 2 列扩到 9 列后**只会刷新日期与编号**，
   * 新字段保存后界面纹丝不动 —— 用户会以为没保存，实际已落库（静默不一致）。
   * @param {object} rec 服务端返回的权威记录
   * @returns {undefined}
   */
  function applyRowUpdate(rec) {
    for (var i = 0; i < state.records.length; i++) {
      if (state.records[i].id === rec.id) { state.records[i] = rec; break; }
    }
    var tr = document.querySelector('#content .table-wrap tbody tr[data-id="' + rec.id + '"]');
    if (!tr) { renderMain(); return; }
    var cols = tableCols();
    for (var j = 0; j < cols.length; j++) {
      var td = tr.querySelector('td[data-col="' + cols[j].key + '"]');
      if (!td) continue;
      var text = cellText(cols[j], rec);
      td.textContent = text;
      if (cols[j].type === 'long') td.setAttribute('title', text);
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
    /* 列名与取值同源于 QA_COLUMNS + cellText：与界面永远一致，不会出现"界面有、导出没有" */
    var cols = tableCols().map(function (c) {
      return {
        key: c.key,
        label: c.label,
        get: function (rec) { return cellText(c, rec); }
      };
    });
    var csv = CORE.buildCsv(sorted, cols);
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
        if (filtPop) closeFilt();                   /* 【build .166】ESC 关筛选浮层 */
        var mb = $('modalBg');
        if (mb && mb.classList.contains('show')) closeModal();
      }
    });
    /* 【build .166】筛选浮层点外部关闭：mousedown 与 mouseup **都在面板外**才关。
       与生产 index.html 同款双判定 —— 若只判 click，「在面板里按下、拖到面板外松开」
       会误关（用户正在选日期区间时手一抖，面板就没了）。capture 先于面板内 stopPropagation。 */
    var __qaFiltFromOutside = false;
    document.addEventListener('mousedown', function (e) {
      __qaFiltFromOutside = !!(filtPop && !filtPop.contains(e.target));
    }, true);
    document.addEventListener('mouseup', function (e) {
      if (filtPop && __qaFiltFromOutside && !filtPop.contains(e.target)) closeFilt();
      __qaFiltFromOutside = false;
    }, true);
    renderSysMenu();
    renderNav();
    /* 【build .167】表格骨架与列布局的初始化（顺序：先读布局，再注册交互，最后渲染）
       · loadLayout：把本地布局读进内存（畸形数据在 normalizeLayout 里已被净化，读失败视同无布局）；
       · bindTableScrollFollow：scroll capture 委托 + resize，只注册一次（不随 renderMain 重复绑定）；
       · bindColInteractions：表头 mousedown 统一委托（调宽/调序），同样只注册一次。 */
    loadLayout();
    bindTableScrollFollow();
    bindColInteractions();
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
    /* 【build .167】列布局（拖宽/拖序的落盘与重置；拖拽本身由表头委托驱动，无需导出） */
    resetLayout: resetLayout,
    /* 【build .166】列筛选 */
    openFilter: openFilter,
    closeFilt: closeFilt,
    fpModeChange: fpModeChange,
    applyFilt: applyFilt,
    clearFilt: clearFilt,
    clearAllFilt: clearAllFilt,
    /* 增改 */
    openAddModal: openAddModal,
    openEditModal: openEditModal,
    saveModal: saveModal,
    closeModal: closeModal,
    checkQtyHint: checkQtyHint,
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
