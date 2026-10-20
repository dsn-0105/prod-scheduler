'use strict';
/* ================================================================
   tests/qa.delivery-taskno.independent.test.js
   QA 独立回归 —— 交付计划「任务单号」taskNo（build 2026-10-20.154）
   ================================================================
   本文件由 QA（严过关）**独立**编写：不复制、不依赖 tests/delivery.taskno.test.js（工程师自测）。
   铁律：不采信工程师自述——所有结论由本文件自行构造数据、自行驱动生产代码得出。

   与工程师自测的角度**刻意错开**（避免两条测试同时漏掉同一盲区）：
     T1 端到端列对位：一条带 taskNo + 一条老单（无该键）→ 两条数据行 td 数相同，
        taskNo 单元格 DOM 索引 === 表头 data-key="taskNo" 索引（真正的列对位，不看 schema 数组）
     T2 三处一致性**动态**校验：HEAD_COLS（源码）== 实际 rowspan 格数 == 前导「非行级列」个数
        —— 不写死 8，改动列数时本用例仍会说真话
     T3 保存往返：弹窗 DOM → saveDelivery → doSaveDelivery 落库 → 重开弹窗回填 → 清空后存空串
     T4 老单三形态（缺键 / undefined / null）渲染、弹窗、保存全兼容
     T5 日志噪音：老单未填 taskNo 保存 → 零「任务单号」日志；填入 → 恰 1 条且旧值显示「空」
     T6 列布局交互：自定义 order（taskNo 拖到数字列之间、_planQty 提到首位）→ td 顺序跟随表头，
        且**值不串列**（文本列搬到数字列位置后，本批计划的值不得跑到别的 key 上）
     T7 老库 fields 全链迁移（按 initApp 同序跑 4 个迁移）→ taskNo 紧跟 firstDate、只写 fields、二次零写盘
     T8 导出 / 模板 / 导入 **实跑**（exportForm / downloadTemplate / importXLSX），验证零改 import.js 即生效
     T9 边界与注入：超长文本 + `<script>` / 引号 → 渲染必须转义，不得注入

   ⚠️ 断言基线**不使用 HEAD**（提交后基线与自身对消、守卫退化为恒真）。
   ⚠️ 不得用 `node -e` 驱动（见 tests/harness/sandbox.js 顶部 realm 说明）。

   运行：node --test tests/qa.delivery-taskno.independent.test.js
   ================================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createApp, ROOT } = require('./harness/sandbox');

const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const ADMIN = { username: 'qa', name: 'QA严过关', role: 'admin', perms: {} };

/* ---------------- 通用 ---------------- */

/** logOp 落盘推迟到微任务（同段合并）⇒ 断言写集前先排空 */
function drain() { return new Promise(function (r) { setImmediate(r); }); }
/** 去 realm：vm 返回对象原型属 vm realm，deepEqual 会假失败 */
function plain(v) { return JSON.parse(JSON.stringify(v)); }

function app0(seed) {
  const o = { installRecorder: false };
  if (seed) o.seed = seed;
  return createApp(o);
}
function appR(seed) {
  const o = {};
  if (seed) o.seed = seed;
  return createApp(o);
}

/** 一条交付计划（默认**不带** taskNo = 模拟老单） */
function dl(orderId, createdAt, items, extra) {
  return Object.assign({
    orderId: orderId,
    customer: '客户-' + orderId,
    createdAt: createdAt,
    items: items || [{ productId: 'P1', productName: '一型', spec: 'S1', model: 'M1', planQty: 5, lineNotes: '' }],
  }, extra || {});
}

/* ---------------- HTML → 假行（只解析本文件需要的属性） ---------------- */

function unesc(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

/** 解析一段表格 HTML → [{cells:[{key,text,rowspan}]}]（text 已去标签，未反转义） */
function parseRows(html) {
  const rows = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const cells = [];
    const cellRe = /<(td|th)([^>]*)>([\s\S]*?)<\/\1>/g;
    let c;
    while ((c = cellRe.exec(m[1])) !== null) {
      const attrs = c[2] || '';
      const km = attrs.match(/data-key="([^"]+)"/);
      const rm = attrs.match(/rowspan="(\d+)"/);
      cells.push({
        key: km ? km[1] : null,
        text: String(c[3] || '').replace(/<[^>]*>/g, '').trim(),
        rowspan: rm ? Number(rm[1]) : 1,
      });
    }
    rows.push({ cells: cells });
  }
  return rows;
}

/** 渲染交付计划列表 → {head:{html,rows}, body:{html,rows}} */
function renderProbe(app) {
  const html = String(app.run('renderDelivery()'));
  const parts = html.split('<div class="table-wrap">');
  assert.equal(parts.length, 2, '交付计划列表应为双表结构（sticky 表头 + 表体）');
  const headHtml = parts[0].slice(parts[0].indexOf('<table class="head-tbl">'));
  const bodyHtml = parts[1];
  return {
    html: html,
    headHtml: headHtml,
    bodyHtml: bodyHtml,
    headRows: parseRows(headHtml),
    bodyRows: parseRows(bodyHtml),
  };
}

function keysOf(row) { return row.cells.map(function (c) { return c.key; }); }
function cellOf(row, key) {
  const c = row.cells.find(function (x) { return x.key === key; });
  return c ? c.text : undefined;
}

/* ---------------- 弹窗 / 表单 DOM 探针 ---------------- */

/**
 * 安装一个「表单 + 弹窗」两用 document 桩：
 *   - getElementById(id) 按需造节点（value/innerHTML 可写）
 *   - querySelectorAll('#dlItemsTbl tbody tr') 返回明细行桩
 * @returns {{nodes:Object, setItemRow:Function, modalHtml:Function}}
 */
function installFormDom(app, opts) {
  const o = opts || {};
  const nodes = {};
  function node(id) {
    if (!nodes[id]) {
      nodes[id] = {
        id: id, value: '', innerHTML: '', textContent: '', style: {}, __wheelBound: false,
        classList: { add: function () {}, remove: function () {}, contains: function () { return false; } },
        addEventListener: function () {},
        querySelectorAll: function () { return []; },
        querySelector: function () { return null; },
      };
    }
    return nodes[id];
  }
  let itemRows = o.itemRows || [];
  app.sandbox.document = Object.assign({}, app.sandbox.document, {
    getElementById: node,
    createElement: function () { return { style: {}, getContext: null, click: function () {} }; },
    querySelectorAll: function (sel) {
      return sel === '#dlItemsTbl tbody tr' ? itemRows : [];
    },
  });
  return {
    nodes: nodes,
    /** 取（并按需造出）一个节点，与生产代码 getElementById 命中同一对象 */
    getById: node,
    setItemRows: function (rows) { itemRows = rows; },
    /** 弹窗 HTML（showModal 写进 #modal.innerHTML） */
    modalHtml: function () { return String(node('modal').innerHTML || ''); },
  };
}

/** 构造一行明细（供 saveDelivery 遍历 .di_field） */
function itemRow(values) {
  const fields = ['productId', 'productName', 'spec', 'model', 'planQty', 'lineNotes'].map(function (k) {
    return { dataset: { key: k }, value: values[k] == null ? '' : String(values[k]) };
  });
  return {
    querySelectorAll: function (sel) { return sel === '.di_field' ? fields : []; },
    querySelector: function (sel) {
      const m = /data-key="([^"]+)"/.exec(sel || '');
      if (!m) return null;
      return fields.find(function (f) { return f.dataset.key === m[1]; }) || null;
    },
  };
}

/** 给 saveDelivery 的 6 个单据头输入框赋值 */
function fillHeader(dom, v) {
  const map = {
    dl_orderId: v.orderId, dl_customer: v.customer, dl_finalDate: v.finalDate,
    dl_firstDate: v.firstDate, dl_taskNo: v.taskNo, dl_notes: v.notes,
  };
  Object.keys(map).forEach(function (k) {
    dom.getById(k).value = map[k] == null ? '' : String(map[k]);
  });
}

/* ================================================================
   T1 端到端列对位（一条带值 + 一条老单）
   ================================================================ */

test('T1 两条计划（一带 taskNo、一老单无该键）→ 数据行 td 数相同，taskNo 单元格索引 === 表头索引', () => {
  const app = app0({
    deliveries: [
      dl('KCDD-NEW', '2026-08-23', null, { taskNo: 'TASK-A-01' }),
      dl('KCDD-OLD', '2026-08-24'), /* 老单：无 taskNo 键 */
    ],
  });
  const p = renderProbe(app);

  /* 表头：data-key 序列（跳过无 key 的选择列 th） */
  const thKeys = p.headRows[0].cells.map(function (c) { return c.key; }).filter(Boolean);
  const thTaskIdx = thKeys.indexOf('taskNo');
  assert.ok(thTaskIdx >= 0, '表头必须存在 data-key="taskNo"');
  /* 可视列索引（0-based）= 选择列占 1 格 + 在 data-key 序列中的位置 */
  const visualIdx = thTaskIdx + 1;
  assert.equal(p.headRows[0].cells[visualIdx].key, 'taskNo',
    '表头 DOM 第 ' + visualIdx + ' 格必须就是 taskNo（选择列占第 0 格）');

  /* 数据行：2 条记录各 1 个明细行 + 1 行合计 */
  const dataRows = p.bodyRows.slice(0, p.bodyRows.length - 1);
  assert.equal(dataRows.length, 2, '2 条交付计划 = 2 个数据行');
  assert.equal(dataRows[0].cells.length, dataRows[1].cells.length,
    '两条数据行的 td 数必须相同（否则 rowspan/列集合不一致）');
  /* 列对位：每一行的第 visualIdx 格都必须是 taskNo */
  dataRows.forEach(function (row, i) {
    assert.equal(row.cells[visualIdx].key, 'taskNo',
      '第 ' + i + ' 行第 ' + visualIdx + ' 格必须是 taskNo（与表头逐格对齐）');
    assert.equal(row.cells.length, thKeys.length + 1, '数据行 td 数 = 1(选择) + 表头业务列数');
  });

  /* 值：带值行取到 TASK-A-01；老单行为空串（不显示 undefined/null） */
  const byOrder = {};
  dataRows.forEach(function (row) { byOrder[cellOf(row, 'orderId')] = row; });
  assert.equal(cellOf(byOrder['KCDD-NEW'], 'taskNo'), 'TASK-A-01');
  assert.equal(cellOf(byOrder['KCDD-OLD'], 'taskNo'), '');
  assert.doesNotMatch(p.bodyHtml, /undefined/, '渲染结果不得出现 undefined 字样');
  app.dispose();
});

/* ================================================================
   T2 三处一致性（动态口径，不写死 8）
   ================================================================ */

test('T2 HEAD_COLS（源码）== 每条记录实际 rowspan 格数 == 前导「非行级列」个数（动态校验）', () => {
  const app = app0({ deliveries: [dl('KCDD-1', '2026-08-23'), dl('KCDD-2', '2026-08-24')] });

  /* ① 源码 HEAD_COLS */
  const body = INDEX_SRC.slice(INDEX_SRC.indexOf('function renderDelivery()'));
  const m = body.match(/const HEAD_COLS\s*=\s*(\d+)\s*;/);
  assert.ok(m, 'renderDelivery 内应有 const HEAD_COLS=<n>;');
  const headCols = Number(m[1]);

  /* ② 实际渲染出的「单据级」td 数（带 rowspan 属性的 td） */
  const html = String(app.run('renderDelivery()'));
  const headTds = (html.match(/<td data-key="[^"]+" rowspan=/g) || []);
  assert.equal(headTds.length % headCols, 0,
    '单据级 td 总数 ' + headTds.length + ' 必须是 HEAD_COLS(' + headCols + ') 的整数倍');
  assert.equal(headTds.length / headCols, 2, '2 条记录 → 2 组单据级 td');

  /* ③ schema 前导「非行级列」个数（get 里不出现 r.it 的最长前缀） */
  const prefix = plain(app.run(
    '(function(){var s=TBL_SCHEMAS.delivery,n=0;' +
    'for(var i=0;i<s.length;i++){if(/r\\.it/.test(String(s[i].get)))break;n++;}return n;})()'
  ));
  assert.equal(prefix, headCols,
    '前导非行级列个数(' + prefix + ') 必须 === HEAD_COLS(' + headCols + ') —— 三者失配即 rowspan 错位');
  /* 且 taskNo 必须落在这段前缀内（否则它不会被 rowspan 合并 = 变成行级列） */
  const tIdx = plain(app.run('TBL_SCHEMAS.delivery.findIndex(function(c){return c.key==="taskNo"})'));
  assert.ok(tIdx >= 0 && tIdx < headCols, 'taskNo 必须位于单据级前缀内（实际 index=' + tIdx + '）');
  assert.equal(plain(app.run('TBL_SCHEMAS.delivery[?].type'.replace('?', tIdx))), 'text',
    'taskNo 必须是文本列（合计行不求和）');
  assert.equal(plain(app.run('String(TBL_SCHEMAS.delivery[?].get)'.replace('?', tIdx))).indexOf('r.d.taskNo') >= 0, true,
    'taskNo 必须读单据头 r.d.taskNo（不是 r.it.taskNo）');
  app.dispose();
});

/* ================================================================
   T3 保存往返（DOM → saveDelivery → doSaveDelivery → 重开弹窗 → 清空）
   ================================================================ */

test('T3 保存往返：落库 → 弹窗回填 → 清空后保存必须存空串（不得保留旧值）', async () => {
  const app = appR({
    currentUser: ADMIN,
    deliveries: [dl('KCDD-1', '2026-08-23', null, { planNo: 'JFJH-20260823-00001', notes: '' })],
  });
  app.setGlobals({ closeModal: function () {}, renderContent: function () {} });
  const dom = installFormDom(app, { itemRows: [itemRow({ productId: 'P1', productName: '一型', planQty: 5 })] });

  /* ① 第一次保存：填 TASK-1 */
  fillHeader(dom, { orderId: 'KCDD-1', customer: '甲', finalDate: '', firstDate: '', taskNo: 'TASK-1', notes: '' });
  app.run('saveDelivery(0)');
  await drain();
  let got = plain(app.getGlobal('deliveries'));
  assert.equal(got.length, 1, '编辑不得新增记录');
  assert.equal(got[0].taskNo, 'TASK-1', '任务单号必须真的落库');
  assert.equal(got[0].planNo, 'JFJH-20260823-00001', '其余字段（编号）必须原样保全');
  assert.equal(app.recorder.countOf('deliveries'), 1, '编辑应恰一次落盘 deliveries');

  /* ② 重开弹窗：必须回填 TASK-1 */
  app.run('deliveryModal(0)');
  const html = dom.modalHtml();
  const inputM = html.match(/<input[^>]*id="dl_taskNo"[^>]*>/);
  assert.ok(inputM, '弹窗必须含 id="dl_taskNo" 的 input');
  assert.match(inputM[0], /value="TASK-1"/, '编辑态必须回填原任务单号');
  assert.doesNotMatch(inputM[0], /readonly|disabled/, '任务单号必须可编辑（非 readonly / 非 disabled）');
  assert.match(html, /<label>任务单号<\/label>/, '标签必须是无 * 标记的「任务单号」（非必填）');

  /* ③ 清空后保存 → 存空串（口径：空串就是空串，允许清空） */
  fillHeader(dom, { orderId: 'KCDD-1', customer: '甲', finalDate: '', firstDate: '', taskNo: '', notes: '' });
  app.run('saveDelivery(0)');
  await drain();
  got = plain(app.getGlobal('deliveries'));
  assert.equal(got.length, 1, '清空保存不得新增记录');
  assert.equal(got[0].taskNo, '', '清空保存必须存空串（不得保留旧值 TASK-1）');
  assert.equal(Object.prototype.hasOwnProperty.call(got[0], 'taskNo'), true, '空串也要显式落库该键');
  app.dispose();
});

/* ================================================================
   T4 老单三形态兼容
   ================================================================ */

test('T4 老单三形态（缺键 / undefined / null）→ 渲染空、弹窗空、保存后正常', async () => {
  const legacy = [
    dl('KCDD-NOKEY', '2026-08-23'),
    Object.assign(dl('KCDD-UNDEF', '2026-08-24'), { taskNo: undefined }),
    Object.assign(dl('KCDD-NULL', '2026-08-25'), { taskNo: null }),
  ];
  const app = appR({ currentUser: ADMIN, deliveries: legacy });
  app.setGlobals({ closeModal: function () {}, renderContent: function () {} });

  /* ① 渲染：三种形态都渲染空串，且不抛错 */
  let p;
  assert.doesNotThrow(function () { p = renderProbe(app); }, '老数据渲染不得抛错');
  const dataRows = p.bodyRows.slice(0, p.bodyRows.length - 1);
  assert.equal(dataRows.length, 3, '3 条老单 = 3 个数据行');
  dataRows.forEach(function (row, i) {
    assert.equal(cellOf(row, 'taskNo'), '', '第 ' + i + ' 条老单的 taskNo 单元格必须是空串');
  });
  assert.doesNotMatch(p.bodyHtml, /undefined|null/, '渲染结果不得出现 undefined / null 字样');

  /* ② 弹窗：三种形态 value 均为空串 */
  const dom = installFormDom(app, { itemRows: [itemRow({ productId: 'P1', productName: '一型', planQty: 5 })] });
  for (let i = 0; i < 3; i++) {
    app.run('deliveryModal(' + i + ')');
    const inputM = dom.modalHtml().match(/<input[^>]*id="dl_taskNo"[^>]*>/);
    assert.ok(inputM, '弹窗必须含 dl_taskNo');
    assert.match(inputM[0], /value=""/, '第 ' + i + ' 条老单打开弹窗必须回填空串');
    assert.doesNotMatch(inputM[0], /undefined|null/, '第 ' + i + ' 条老单不得把 undefined/null 写进 value');
  }

  /* ③ 三种形态都能正常保存（no-throw + 落库） */
  for (let i = 0; i < 3; i++) {
    fillHeader(dom, { orderId: legacy[i].orderId, customer: legacy[i].customer, finalDate: '', firstDate: '', taskNo: '', notes: '' });
    assert.doesNotThrow(function () { app.run('saveDelivery(' + i + ')'); }, '第 ' + i + ' 条老单保存不得抛错');
  }
  await drain();
  const got = plain(app.getGlobal('deliveries'));
  assert.equal(got.length, 3, '保存老单不得新增/丢失记录');
  got.forEach(function (d, i) {
    assert.equal(d.taskNo, '', '第 ' + i + ' 条老单保存后 taskNo 应为空串');
  });
  app.dispose();
});

/* ================================================================
   T5 字段级日志噪音
   ================================================================ */

test('T5 老单未填 taskNo 保存 → 零「任务单号」日志；填入 → 恰 1 条且旧值显示「空」', async () => {
  const app = appR({
    currentUser: ADMIN,
    deliveries: [dl('KCDD-1', '2026-08-23', null, { planNo: 'JFJH-20260823-00001', notes: '' })],
  });
  app.setGlobals({ closeModal: function () {}, renderContent: function () {} });
  const dom = installFormDom(app, { itemRows: [itemRow({ productId: 'P1', productName: '一型', planQty: 5 })] });

  const taskLogs = function () {
    return plain(app.getGlobal('logs')).filter(function (l) { return l.field === '任务单号'; });
  };

  /* ① 老单未填（空 → 空）：不得产生「任务单号」噪音日志 */
  fillHeader(dom, { orderId: 'KCDD-1', customer: '甲', finalDate: '', firstDate: '', taskNo: '', notes: '' });
  app.run('saveDelivery(0)');
  await drain();
  assert.equal(taskLogs().length, 0, '未改 taskNo 不得产生「任务单号」日志（噪音）');

  /* ② 填入 TASK-100：恰 1 条，旧值「空」→ 新值 */
  fillHeader(dom, { orderId: 'KCDD-1', customer: '甲', finalDate: '', firstDate: '', taskNo: 'TASK-100', notes: '' });
  app.run('saveDelivery(0)');
  await drain();
  let hit = taskLogs();
  assert.equal(hit.length, 1, '填入 taskNo 必须留痕且仅 1 条');
  assert.equal(hit[0].action, '编辑');
  assert.match(String(hit[0].detail), /空/, '旧值必须显示为「空」');
  assert.match(String(hit[0].detail), /TASK-100/, '详情必须含新值');

  /* ③ 再保存一次（值不变）：仍只有 1 条（不重复记） */
  fillHeader(dom, { orderId: 'KCDD-1', customer: '甲', finalDate: '', firstDate: '', taskNo: 'TASK-100', notes: '' });
  app.run('saveDelivery(0)');
  await drain();
  hit = taskLogs();
  assert.equal(hit.length, 1, '值未变不得重复记日志');
  assert.equal(plain(app.getGlobal('deliveries'))[0].taskNo, 'TASK-100');
  app.dispose();
});

/* ================================================================
   T6 列布局交互：自定义 order 后不串列
   ================================================================ */

/** 把渲染出的表格挂成假节点，供 applyTableLayout 真实重排 */
function installTableProbe(app, p) {
  function mkCell(c) {
    return {
      key: c.key,
      text: c.text,
      rowspan: c.rowspan,
      colspan: 1,
      style: {},
      offsetWidth: 0,
      classList: { add: function () {}, remove: function () {}, contains: function () { return false; } },
      querySelector: function () { return null; },
      getAttribute: function (k) {
        if (k === 'data-key') return this.key;
        if (k === 'data-m') return 'delivery';
        if (k === 'rowspan') return String(this.rowspan);
        if (k === 'colspan') return '1';
        return null;
      },
    };
  }
  function mkRow(row, cells) {
    return {
      cells: cells,
      appendChild: function (n) {
        const i = this.cells.indexOf(n);
        if (i >= 0) this.cells.splice(i, 1);
        this.cells.push(n);
        return n;
      },
      replaceChild: function (n, old) {
        const i = this.cells.indexOf(old);
        if (i >= 0) this.cells[i] = n;
        return old;
      },
    };
  }
  const headRows = p.headRows.map(function (r) { return mkRow(r, r.cells.map(mkCell)); });
  const bodyRows = p.bodyRows.map(function (r) { return mkRow(r, r.cells.map(mkCell)); });
  const headTable = { tHead: { rows: [headRows[0]] }, rows: headRows, style: {}, closest: function () { return null; } };
  const headBox = {
    classList: { contains: function (c) { return c === 'sticky-head'; } },
    querySelector: function (s) { return s === 'table.head-tbl' ? headTable : null; },
  };
  const wrap = { previousElementSibling: headBox, classList: { contains: function (c) { return c === 'table-wrap'; } } };
  const bodyTable = { tHead: null, rows: bodyRows, style: {}, closest: function () { return wrap; } };
  app.sandbox.document = Object.assign({}, app.sandbox.document, {
    querySelectorAll: function (sel) { return sel === '#content table' ? [headTable, bodyTable] : []; },
    createElement: function () { return { style: {}, getContext: null, click: function () {} }; },
  });
  return { headRows: headRows, bodyRows: bodyRows };
}

test('T6 自定义列序（taskNo 拖到数字列之间、_planQty 提到首位）→ td 顺序跟随且值不串列', () => {
  const app = app0({
    deliveries: [dl('KCDD-1', '2026-08-23', null, { planNo: 'JFJH-20260823-00001', taskNo: 'TASK-9' })],
    tblLayout: {
      delivery: {
        /* 关键：把文本列 taskNo 塞进数字列中间；把数字列 _planQty 提到最前 */
        order: ['_planQty', 'planNo', 'createdAt', 'orderId', 'customer', 'ppStatus', 'finalDate', 'firstDate',
          'taskNo', 'productId', 'productName', 'spec', 'model', '_ppPlanned', 'lineNotes'],
        widths: {},
      },
    },
  });
  const p = renderProbe(app);
  const probe = installTableProbe(app, p);
  app.run('applyTableLayout()');

  const order = ['_planQty', 'planNo', 'createdAt', 'orderId', 'customer', 'ppStatus', 'finalDate', 'firstDate',
    'taskNo', 'productId', 'productName', 'spec', 'model', '_ppPlanned', 'lineNotes'];

  /* ① 表头与数据行都按自定义 order 排（选择列固定第 0 格） */
  [probe.headRows[0], probe.bodyRows[0]].forEach(function (row, ri) {
    const ks = row.cells.map(function (c) { return c.key; });
    assert.equal(ks[0], null, '第 ' + ri + ' 行第 0 格必须是选择列（无 data-key）');
    assert.deepEqual(ks.slice(1), order, '第 ' + ri + ' 行的列序必须完全跟随自定义 order');
  });

  /* ② 值不串列：每个 key 的单元格文本必须仍是它自己的值 */
  const expected = {
    _planQty: '5', planNo: 'JFJH-20260823-00001', createdAt: '2026-08-23', orderId: 'KCDD-1',
    customer: '客户-KCDD-1', ppStatus: '未下推', finalDate: '', firstDate: '', taskNo: 'TASK-9',
    productId: 'P1', productName: '一型', spec: 'S1', model: 'M1', _ppPlanned: '0', lineNotes: '',
  };
  const dataRow = probe.bodyRows[0];
  Object.keys(expected).forEach(function (k) {
    const cell = dataRow.cells.find(function (c) { return c.key === k; });
    assert.ok(cell, '重排后必须仍能定位列 ' + k);
    assert.equal(cell.text, expected[k], '列 ' + k + ' 的值不得被串改（实际 ' + JSON.stringify(cell.text) + '）');
  });
  /* ③ 合计行同样跟随列序，且文本列 taskNo 为空（不求和、不显示「合计」） */
  const sumRow = probe.bodyRows[probe.bodyRows.length - 1];
  assert.deepEqual(sumRow.cells.map(function (c) { return c.key; }).slice(1), order, '合计行也必须跟随列序');
  assert.equal(sumRow.cells.find(function (c) { return c.key === 'taskNo'; }).text, '',
    'taskNo 在合计行必须为空（文本列不求和）');
  assert.equal(sumRow.cells.find(function (c) { return c.key === '_planQty'; }).text, '5', '数字列合计仍正常');
  app.dispose();
});

/* ================================================================
   T7 老库 fields 全链迁移（initApp 同序）
   ================================================================ */

test('T7 老库 fields 全链迁移（4 个迁移按 initApp 同序）→ taskNo 紧跟 firstDate，只写 fields，二次零写盘', async () => {
  const app = appR({
    currentUser: ADMIN,
    fields: {
      delivery: [
        { key: 'planNo', label: '交付计划编号', type: 'text', required: true, locked: true },
        { key: 'orderId', label: '订单编号', type: 'text', required: true, locked: true },
        { key: 'customer', label: '客户名称', type: 'text', required: true, locked: true },
        { key: 'planQty', label: '本批计划', type: 'number', required: true, locked: false },
        { key: 'finalDate', label: '最终交付期', type: 'date', required: false, locked: true },
        { key: 'firstDate', label: '首次交付日', type: 'date', required: false, locked: false },
        /* 老库还留着 .149 已废弃的三列，且缺 taskNo */
        { key: 'orderTotal', label: '订单总量', type: 'number', required: false, locked: false },
        { key: 'delivered', label: '已交付', type: 'number', required: false, locked: false },
        { key: 'undelivered', label: '未交付', type: 'number', required: false, locked: false },
        { key: 'notes', label: '备注', type: 'text', required: false, locked: false },
      ],
    },
    deliveries: [{ orderId: 'KCDD-1', customer: '甲', createdAt: '2026-08-23', items: [] }],
  });

  /* initApp 的同序（.154 相关四步） */
  app.run('migrateDeliveryFields();migrateDeliveryPlanNoField();migrateDeliveryFieldsTaskNo();migrateDeliveryDropHeadTotals();');
  await drain();

  const keys = plain(app.getGlobal('fields')).delivery.map(function (f) { return f.key; });
  assert.equal(keys[0], 'planNo', 'planNo 必须仍在首列');
  const iF = keys.indexOf('firstDate');
  const iT = keys.indexOf('taskNo');
  assert.ok(iF >= 0 && iT === iF + 1, 'taskNo 必须紧跟 firstDate（实际 keys=' + JSON.stringify(keys) + '）');
  ['orderTotal', 'delivered', 'undelivered'].forEach(function (k) {
    assert.equal(keys.indexOf(k), -1, '废弃列 ' + k + ' 必须已清理');
  });

  /* 只写 fields，绝不碰 deliveries；且 deliveries 数据一字未动（老单不补） */
  assert.equal(app.recorder.countOf('deliveries'), 0, '迁移绝不落盘 deliveries');
  assert.deepEqual(plain(app.getGlobal('deliveries')), [
    { orderId: 'KCDD-1', customer: '甲', createdAt: '2026-08-23', items: [] },
  ], '存量 deliveries 必须一字未动（老单不补）');
  const saveKeys = plain(app.recorder.of('save').map(function (c) { return c.key; }));
  saveKeys.forEach(function (k) {
    assert.ok(k === 'fields' || k === 'logs',
      '迁移不得落盘除 fields/logs 以外的表（实际 ' + JSON.stringify(saveKeys) + '）');
  });
  assert.ok(saveKeys.indexOf('fields') >= 0, '迁移必须有 fields 落盘');

  /* 幂等：再跑一次 → 零写盘、零日志、fields 不变 */
  const before = plain(app.getGlobal('fields'));
  const writes = app.recorder.writeCount();
  const logLen = plain(app.getGlobal('logs')).length;
  app.run('migrateDeliveryFieldsTaskNo();');
  await drain();
  assert.deepEqual(plain(app.getGlobal('fields')), before, '第二次调用不得改动 fields');
  assert.equal(app.recorder.writeCount(), writes, '第二次调用不得新增任何写盘');
  assert.equal(plain(app.getGlobal('logs')).length, logLen, '第二次调用不得新增日志');
  app.dispose();
});

/* ================================================================
   T8 导出 / 模板 / 导入 实跑
   ================================================================ */

function installXlsxProbe(app) {
  const captured = [];
  app.sandbox.XLSX.build = function (sheets) { captured.push(plain(sheets)); return [1, 2, 3]; };
  app.sandbox.Blob = function (parts) { this.parts = parts; };
  app.sandbox.URL = { createObjectURL: function () { return 'blob:x'; }, revokeObjectURL: function () {} };
  return captured;
}

test('T8-1 exportForm / downloadTemplate 实跑：自动带「任务单号」列（位置紧随首次交付日、非必填不标红）', () => {
  const app = app0({
    currentUser: ADMIN,
    deliveries: [dl('KCDD-1', '2026-08-23', null, {
      planNo: 'JFJH-20260823-00001', taskNo: 'TASK-777', finalDate: '2026-08-30', firstDate: '2026-08-23', planQty: 5,
    })],
  });
  const cap = installXlsxProbe(app);

  app.run('exportForm("delivery")');
  assert.equal(cap.length, 1, 'XLSX.build 应被调用一次');
  const sheet = cap[0][0];
  assert.equal(sheet.name, '交付计划');
  const iT = sheet.headers.indexOf('任务单号');
  assert.ok(iT >= 0, '导出表头必须含「任务单号」（实际 ' + JSON.stringify(sheet.headers) + '）');
  assert.equal(sheet.headers[iT - 1], '首次交付日', '「任务单号」必须紧跟「首次交付日」列');
  assert.equal(sheet.rows[0][iT], 'TASK-777', '导出数据行必须取到 taskNo 值');
  assert.equal(sheet.rows[0].length, sheet.headers.length, '数据行列数必须与表头一致');

  app.run('downloadTemplate("delivery")');
  assert.equal(cap.length, 2, 'downloadTemplate 应再调用一次 XLSX.build');
  const tpl = cap[1][0];
  assert.equal(tpl.rows.length, 0, '模板无数据行');
  const head = tpl.headers.find(function (h) { return h.t === '任务单号'; });
  assert.ok(head, '导入模板表头必须含「任务单号」');
  assert.equal(head.red, false, '非必填 → 模板表头不得标红');
  app.dispose();
});

test('T8-2 importXLSX 实跑：覆盖导入把「任务单号」写进记录（js/import.js 零改动即生效）', async () => {
  const app = appR({ currentUser: ADMIN, deliveries: [] });
  app.setGlobals({ renderAll: function () {}, renderContent: function () {} });
  app.sandbox.XLSX.parse = function () {
    return [{
      name: '交付计划',
      headers: ['交付计划编号', '订单编号', '客户名称', '任务单号', '本批计划'],
      rows: [
        ['JFJH-20260823-00001', 'KCDD-1', '甲', 'RW-777', 5],
        ['JFJH-20260823-00002', 'KCDD-2', '乙', '', 3],
      ],
    }];
  };
  function FR() {
    this.result = new ArrayBuffer(8);
    this.onload = null;
    this.readAsArrayBuffer = function () { if (this.onload) this.onload(); };
  }
  app.sandbox.FileReader = FR;
  app.sandbox.Blob = function (parts) { this.parts = parts; };
  app.sandbox.URL = { createObjectURL: function () { return 'blob:x'; }, revokeObjectURL: function () {} };

  app.setGlobal('importFormKey', 'delivery');
  app.run('importXLSX({target:{files:[{}],value:""}})');
  await new Promise(function (r) { setImmediate(r); });
  await new Promise(function (r) { setImmediate(r); });
  await drain();

  const got = plain(app.getGlobal('deliveries'));
  assert.equal(got.length, 2, '两行都必须导入');
  assert.equal(got[0].taskNo, 'RW-777', '任务单号必须从 Excel 写进记录');
  assert.equal(got[1].taskNo, '', '空单元格导入为空串（不影响非必填口径）');
  assert.equal(got[0].planNo, 'JFJH-20260823-00001', '已有编号必须原样保留（不被重编号）');
  app.dispose();
});

/* ================================================================
   T9 边界与注入
   ================================================================ */

test('T9 超长文本 + `<script>`/引号 输入 → 渲染必须转义、不得注入', () => {
  const long = 'L'.repeat(512);
  const evil = '<script>alert("x")</script>';
  const app = app0({
    currentUser: ADMIN, /* 打开编辑弹窗需表单写权限，否则 deliveryModal 直接 return */
    deliveries: [
      dl('KCDD-LONG', '2026-08-23', null, { taskNo: long }),
      dl('KCDD-EVIL', '2026-08-24', null, { taskNo: evil }),
      dl('KCDD-QUOTE', '2026-08-25', null, { taskNo: 'a"b\'c&d' }),
    ],
  });
  const p = renderProbe(app);

  /* ① 不得出现原样 <script> 标签（否则可注入执行） */
  assert.equal(p.html.indexOf('<script>alert'), -1, '渲染结果不得含原样 <script> 注入串');
  assert.ok(p.html.indexOf('&lt;script&gt;') >= 0, '注入串必须被转义为 &lt;script&gt;');
  /* ② 双引号必须转义（属性/文本皆然）；单引号在双引号包裹的属性内是安全的，故不作要求 */
  assert.ok(p.html.indexOf('a&quot;b') >= 0, '双引号必须转义为 &quot;');
  assert.ok(p.html.indexOf('c&amp;d') >= 0, '& 必须转义为 &amp;');

  /* ③ 单元格文本层：反转义后必须与输入逐字相等（内容无损、只是被转义） */
  const dataRows = p.bodyRows.slice(0, p.bodyRows.length - 1);
  const byOrder = {};
  dataRows.forEach(function (r) { byOrder[cellOf(r, 'orderId')] = r; });
  assert.equal(unesc(cellOf(byOrder['KCDD-LONG'], 'taskNo')).length, 512, '超长文本必须完整保留（512 字符）');
  assert.equal(unesc(cellOf(byOrder['KCDD-EVIL'], 'taskNo')), evil, '转义后反转义必须还原原文');
  assert.equal(unesc(cellOf(byOrder['KCDD-QUOTE'], 'taskNo')), 'a"b\'c&d', '引号/& 内容必须无损');

  /* ④ 弹窗 value 属性同样必须转义（不得截断属性造成注入） */
  const dom = installFormDom(app, { itemRows: [itemRow({ productId: 'P1', productName: '一型', planQty: 5 })] });
  app.run('deliveryModal(1)');
  const html = dom.modalHtml();
  assert.equal(html.indexOf('<script>alert'), -1, '弹窗不得含原样注入串');
  const inputM = html.match(/<input[^>]*id="dl_taskNo"[^>]*>/);
  assert.ok(inputM, '弹窗必须含 dl_taskNo');
  assert.ok(inputM[0].indexOf('&lt;script&gt;') >= 0, '弹窗 value 必须转义注入串');
  app.dispose();
});
