'use strict';
/* ================================================================
   tests/delivery.taskno.test.js —— 交付计划「任务单号」taskNo（2026-10-20.154）
   ================================================================
   需求（用户已确认，方案 A）：
     · 交付计划**单据级**新增字段「任务单号」taskNo（一张交付计划一个，**不是明细行级**）
     · **文本**型、**非必填**（可留空）、**可编辑**（保存后仍可改）
     · **老单不补**：升级前已有的交付计划**不做任何回填**，读取为空即渲染空
     · 进 **Excel 导出列** + **覆盖导入模板**（靠持久化 fields.delivery 承接）
     · **字段级操作日志**：改了记「字段=任务单号 旧值→新值」，未改不产生噪音

   本文件钉死的口径：
     §A defaultFields 定义（type/required/locked + 位置紧跟「首次交付日」）
     §B 幂等迁移 migrateDeliveryFieldsTaskNo（老库补齐 + 位置 + 二次零变更零日志）
     §C TBL_SCHEMAS.delivery 前 8 项列序（taskNo 在 firstDate 之后）
     §D 列表渲染（有值 → 出现 RW-001；老单无键 → 空单元格且不抛错）
     §E 编辑弹窗渲染（id="dl_taskNo" 存在 · 非 readonly · 非必填）
     §F saveDelivery 源码显式取 dl_taskNo
     §G 字段级日志（改则留痕 / 未改不噪音）
     §H **老单不补守卫**：源码扫描证明全工程无任何迁移会写 deliveries[*].taskNo
     §I 合计行逐列同构（文本列自动生成空 td，与 schema 键序一致）

   ⚠️ 断言基线**不使用 HEAD**（HEAD 会随提交漂移、使守卫退化为恒真）。
      本文件的「改前/改后」判别力靠 §H 的**结构不变量**（无赋值点 / key:'taskNo' 恰 4 处）
      与 §B/§C 的行为断言实现，不依赖任何 git 修订号。

   运行：node --test tests/delivery.taskno.test.js
        （**不要用 node -e**，见 tests/README 与 tests/harness/sandbox.js 的 realm 说明）
   ================================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createApp, ROOT } = require('./harness/sandbox');

const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/** 【.135】排空微任务：logOp 落盘推迟到一个微任务（同段合并），断言落盘次数前必须先排空 */
function drain() { return new Promise(function (r) { setImmediate(r); }); }

/** 跨 realm 值转成本 realm 纯值（vm 返回的对象原型属于 vm realm） */
function plain(v) { return JSON.parse(JSON.stringify(v)); }

/** 剔除注释后的正文（静态守卫用；避免注释里的说明文字造成误判） */
function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** 花括号配平抽取源码函数体（与 tests/delivery.planno.test.js 同款） */
function extractFn(src, name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\(', 'g');
  const m = re.exec(src);
  if (!m) throw new Error('未在源码中找到函数: ' + name);
  let p = m.index + m[0].length;
  let d = 1;
  for (; p < src.length; p++) {
    if (src[p] === '(') d++;
    else if (src[p] === ')') { d--; if (d === 0) break; }
  }
  const i = src.indexOf('{', p);
  let j = i;
  d = 0;
  for (; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (d === 0) break; }
  }
  return src.slice(m.index, j + 1);
}

const INDEX_CODE = stripComments(INDEX_SRC);

/** 只装载、不挂记录器（纯逻辑断言） */
function app0(seed) {
  const opts = { installRecorder: false };
  if (seed) opts.seed = seed;
  return createApp(opts);
}
/** 装载 + 记录器（断言写盘次数） */
function appR(seed) {
  const opts = {};
  if (seed) opts.seed = seed;
  return createApp(opts);
}

/** 造一条交付计划记录（默认**不带** taskNo = 模拟老单） */
function dl(orderId, createdAt, items, extra) {
  return Object.assign({
    orderId: orderId,
    customer: '客户-' + orderId,
    createdAt: createdAt,
    items: items || [{ productId: 'P1', productName: '一型', planQty: 5, lineNotes: '' }],
  }, extra || {});
}

/** doSaveDelivery 的渲染/弹窗副作用打桩 */
function noSideEffects(app) {
  app.setGlobals({ closeModal: function () { }, renderContent: function () { } });
}

/** 弹窗探针：拦截 document.getElementById，回收 showModal 写入的 innerHTML */
function installModalProbe(app) {
  const nodes = {};
  const get = function (id) {
    if (!nodes[id]) {
      nodes[id] = {
        id: id, innerHTML: '', textContent: '', value: '', style: {}, __wheelBound: false,
        classList: { add: function () { }, remove: function () { }, contains: function () { return false; } },
        addEventListener: function () { },
        querySelectorAll: function () { return []; },
        querySelector: function () { return null; },
      };
    }
    return nodes[id];
  };
  app.sandbox.document = Object.assign({}, app.sandbox.document, {
    getElementById: get,
    querySelectorAll: function () { return []; },
  });
  return nodes;
}

const ADMIN = { username: 'qa', name: 'QA严过关', role: 'admin', perms: {} };

/* ================================================================
   §A defaultFields.delivery 字段定义
   ================================================================ */

test('A1 defaultFields.delivery 含 taskNo：type=text / required=false / locked=false，且紧跟「首次交付日」', () => {
  const app = app0({});
  const defs = plain(app.getGlobal('defaultFields')).delivery;
  const i = defs.findIndex(function (f) { return f.key === 'taskNo'; });
  assert.ok(i >= 0, 'defaultFields.delivery 必须含 taskNo');
  assert.equal(defs[i].label, '任务单号');
  assert.equal(defs[i].type, 'text', '必须是文本列（非 number → 合计行不会求和）');
  assert.equal(defs[i].required, false, '非必填（导入模板该列表头不得标红）');
  assert.equal(defs[i].locked, false, '可删除/可改（非系统锁定字段）');
  /* 位置：紧跟「首次交付日」（列表第 8 个单据级列，与 TBL_SCHEMAS 同序） */
  const iFirst = defs.findIndex(function (f) { return f.key === 'firstDate'; });
  assert.ok(iFirst >= 0, 'defaultFields.delivery 必须含 firstDate');
  assert.equal(i, iFirst + 1, 'taskNo 必须紧跟 firstDate（列序与列表/导出模板一致）');
  app.dispose();
});

test('A2 HARD_FIELDS.delivery 含 taskNo（字段级日志对比清单）', () => {
  const app = app0({});
  const hf = plain(app.getGlobal('HARD_FIELDS')).delivery;
  const hit = hf.filter(function (f) { return f.key === 'taskNo'; });
  assert.equal(hit.length, 1, 'HARD_FIELDS.delivery 必须恰 1 条 taskNo');
  assert.equal(hit[0].label, '任务单号', '日志里显示的字段名必须是「任务单号」');
  app.dispose();
});

/* ================================================================
   §B 幂等迁移 migrateDeliveryFieldsTaskNo —— 持久化 fields 老库补齐
   （与 .134 planNo / .132 calledQty 同型：只改 defaultFields 不动线上持久化配置
     → 导出列 / 导入模板会静默缺列）
   ================================================================ */

test('B1 老库 fields.delivery 缺 taskNo → 插入到 firstDate 之后（不是末尾），并落盘 fields + 记迁移日志', async () => {
  const app = appR({
    fields: {
        delivery: [
          { key: 'planNo', label: '交付计划编号', type: 'text', required: true, locked: true },
          { key: 'orderId', label: '订单编号', type: 'text', required: true, locked: true },
          { key: 'firstDate', label: '首次交付日', type: 'date', required: false, locked: false },
          { key: 'notes', label: '备注', type: 'text', required: false, locked: false },
        ],
      },
  });
  app.run('migrateDeliveryFieldsTaskNo()');
  await drain();
  const f = plain(app.getGlobal('fields')).delivery;
  assert.deepEqual(f.map(function (x) { return x.key; }),
    ['planNo', 'orderId', 'firstDate', 'taskNo', 'notes'],
    'taskNo 必须紧跟 firstDate（不是 push 到末尾）');
  assert.deepEqual(f[3], { key: 'taskNo', label: '任务单号', type: 'text', required: false, locked: false },
    '补齐的定义必须与 defaultFields 完全一致');
  assert.equal(app.recorder.countOf('fields'), 1, '有变化 → 恰一次落盘 fields');
  assert.equal(app.recorder.countOf('logs'), 1, '有变化 → 恰一条迁移日志');
  const logs = plain(app.getGlobal('logs'));
  assert.match(String(logs[0].detail), /任务单号/, '迁移日志必须点名「任务单号」');
  app.dispose();
});

test('B2 幂等：第二次调用 → 一字不动、零写盘、零日志', async () => {
  const app = appR({
    fields: {
        delivery: [
          { key: 'firstDate', label: '首次交付日', type: 'date', required: false, locked: false },
          { key: 'notes', label: '备注', type: 'text', required: false, locked: false },
        ],
      },
  });
  app.run('migrateDeliveryFieldsTaskNo()');
  await drain();
  const after1 = plain(app.getGlobal('fields'));
  assert.deepEqual(after1.delivery.map(function (x) { return x.key; }), ['firstDate', 'taskNo', 'notes'],
    '第一次调用后补齐到 firstDate 之后');
  const logs1 = plain(app.getGlobal('logs')).length;
  const writes1 = app.recorder.writeCount();

  /* 第二次：完全幂等 */
  app.run('migrateDeliveryFieldsTaskNo()');
  await drain();
  assert.deepEqual(plain(app.getGlobal('fields')), after1, '第二次调用不得改动 fields');
  assert.equal(app.recorder.writeCount(), writes1, '第二次调用不得新增任何写盘');
  assert.equal(plain(app.getGlobal('logs')).length, logs1, '第二次调用不得新增日志');
  app.dispose();
});

test('B3 已存在但定义漂移（改名/数字型/必填/锁定）+ 位置被挪 → 逐项纠正并移回 firstDate 之后', async () => {
  const app = appR({
    fields: {
        delivery: [
          { key: 'taskNo', label: '任务号', type: 'number', required: true, locked: true },   /* 漂移 + 位置错 */
          { key: 'firstDate', label: '首次交付日', type: 'date', required: false, locked: false },
          { key: 'notes', label: '备注', type: 'text', required: false, locked: false },
        ],
      },
  });
  app.run('migrateDeliveryFieldsTaskNo()');
  await drain();
  const f = plain(app.getGlobal('fields')).delivery;
  assert.deepEqual(f.map(function (x) { return x.key; }), ['firstDate', 'taskNo', 'notes'], '必须移回 firstDate 之后');
  assert.equal(f[1].label, '任务单号');
  assert.equal(f[1].type, 'text');
  assert.equal(f[1].required, false);
  assert.equal(f[1].locked, false);
  app.dispose();
});

test('B4 firstDate 不存在 → taskNo 补到末尾（不抛错）；fields.delivery 非法 → 直接返回零写入', async () => {
  const app = appR({
    fields: {
        delivery: [
          { key: 'orderId', label: '订单编号', type: 'text', required: true, locked: true },
          { key: 'notes', label: '备注', type: 'text', required: false, locked: false },
        ],
      },
  });
  app.run('migrateDeliveryFieldsTaskNo()');
  await drain();
  assert.deepEqual(plain(app.getGlobal('fields')).delivery.map(function (x) { return x.key; }),
    ['orderId', 'notes', 'taskNo'], '缺 firstDate → 补到末尾');
  app.dispose();

  /* 非法形态：fields 无 delivery 数组 / delivery 非数组 */
  const bad = appR({ fields: { delivery: 'oops' } });
  bad.run('migrateDeliveryFieldsTaskNo()');
  await drain();
  assert.equal(bad.recorder.writeCount(), 0, 'fields.delivery 非数组 → 零写入、不抛错');
  bad.dispose();

  const noDl = appR({ fields: {} });
  noDl.run('migrateDeliveryFieldsTaskNo()');
  await drain();
  assert.equal(noDl.recorder.writeCount(), 0, 'fields 无 delivery → 零写入、不抛错');
  noDl.dispose();
});

test('B5 迁移只动 fields，**不动 deliveries 存量数据**（老单不补）', async () => {
  const app = appR({
    fields: { delivery: [{ key: 'firstDate', label: '首次交付日', type: 'date', required: false, locked: false }] },
      /* 老单：刻意没有 taskNo */
      deliveries: [dl('KCDD-1', '2026-08-23'), dl('KCDD-2', '2026-08-24')],
  });
  app.run('migrateDeliveryFieldsTaskNo()');
  await drain();
  const ds = plain(app.getGlobal('deliveries'));
  ds.forEach(function (d, i) {
    assert.equal(Object.prototype.hasOwnProperty.call(d, 'taskNo'), false,
      '第 ' + (i + 1) + ' 条老单不得被写入 taskNo（用户明确要求老单不补）');
  });
  assert.equal(app.recorder.countOf('deliveries'), 0, '迁移绝不落盘 deliveries');
  app.dispose();
});

/* ================================================================
   §C TBL_SCHEMAS.delivery 前 8 项列序
   ================================================================ */

test('C1 TBL_SCHEMAS.delivery 前 8 项 = [planNo, createdAt, orderId, customer, ppStatus, finalDate, firstDate, taskNo]', () => {
  const app = app0({ deliveries: [dl('KCDD-1', '2026-08-23')] });
  app.run('renderDelivery()');
  const keys = plain(app.run('TBL_SCHEMAS.delivery.map(function(c){return c.key})'));
  assert.deepEqual(keys.slice(0, 8),
    ['planNo', 'createdAt', 'orderId', 'customer', 'ppStatus', 'finalDate', 'firstDate', 'taskNo']);
  assert.equal(plain(app.run('TBL_SCHEMAS.delivery[7].label')), '任务单号');
  assert.equal(plain(app.run('TBL_SCHEMAS.delivery[7].type')), 'text', '文本列（合计行不会求和）');
  /* 取值来源必须是单据头 r.d.taskNo（不是行级 r.it） */
  assert.equal(plain(app.run('/r\\.d\\.taskNo/.test(String(TBL_SCHEMAS.delivery[7].get))')), true,
    'taskNo 必须取单据头 r.d.taskNo');
  app.dispose();
});

test('C2 源码 HEAD_COLS=8（由 7 升级，三处一致性守卫同步）', () => {
  const body = extractFn(INDEX_SRC, 'renderDelivery');
  const m = body.match(/const HEAD_COLS\s*=\s*(\d+)\s*;/);
  assert.ok(m, 'renderDelivery 内应有 const HEAD_COLS=<n>;');
  assert.equal(Number(m[1]), 8, 'HEAD_COLS 必须为 8（.154 由 7 → 8）');
});

/* ================================================================
   §D 列表渲染
   ================================================================ */

/** 取交付计划列表 body 区的全部行 HTML */
function bodyRowsOf(html) {
  const parts = String(html).split('<div class="table-wrap">');
  assert.equal(parts.length, 2, '交付计划列表应为双表结构（sticky 表头 + 表体）');
  return {
    head: parts[0],
    rows: [...parts[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(function (m) { return m[1]; }),
  };
}
/** 取某行某 key 的单元格内容（不存在 → null） */
function cellOf(row, k) {
  const m = row.match(new RegExp('<td[^>]*data-key="' + k + '"[^>]*>([\\s\\S]*?)</td>'));
  return m ? m[1] : null;
}

test('D1 有 taskNo 的记录 → 出现 data-key="taskNo" 且值正确（单据级 rowspan 合并）', () => {
  const app = app0({
    deliveries: [
      dl('KCDD-1', '2026-08-23', [
        { productId: 'P1', productName: '一型', planQty: 5, lineNotes: 'a' },
        { productId: 'P2', productName: '二型', planQty: 7, lineNotes: 'b' },
      ], { taskNo: 'RW-001' }),
    ],
  });
  const html = String(app.run('renderDelivery()'));
  const r = bodyRowsOf(html);
  /* 表头必须有 taskNo 列（紧接 firstDate 之后） */
  const thKeys = [...r.head.matchAll(/<th[^>]*data-key="([^"]+)"/g)].map(function (m) { return m[1]; });
  const iFirst = thKeys.indexOf('firstDate');
  assert.ok(iFirst >= 0, '表头必须含 firstDate');
  assert.equal(thKeys[iFirst + 1], 'taskNo', '表头 taskNo 必须紧跟 firstDate');

  const dataRows = r.rows.slice(0, -1);
  assert.equal(dataRows.length, 2, '1 张计划 2 个明细行 → 2 个数据行');
  assert.equal(cellOf(dataRows[0], 'taskNo'), 'RW-001', '组首行 taskNo 单元格必须渲染 RW-001');
  assert.match(dataRows[0], /<td data-key="taskNo" rowspan="2">/, '单据级列必须 rowspan=2');
  assert.equal(cellOf(dataRows[1], 'taskNo'), null, '续行不得重复输出 taskNo（已被 rowspan 合并）');
  app.dispose();
});

test('D2 老记录（无 taskNo 键）→ 该单元格为空字符串，且渲染不抛错', () => {
  const app = app0({ deliveries: [dl('KCDD-1', '2026-08-23')] });
  let html = '';
  assert.doesNotThrow(function () { html = String(app.run('renderDelivery()')); }, '老数据渲染不得抛错');
  const r = bodyRowsOf(html);
  const dataRows = r.rows.slice(0, -1);
  assert.equal(dataRows.length, 1);
  assert.equal(cellOf(dataRows[0], 'taskNo'), '', '老单 taskNo 单元格必须是空字符串（不显示 undefined/null）');
  assert.doesNotMatch(String(html), /undefined/, '渲染结果不得出现 undefined 字样');
  app.dispose();
});

test('D3 taskNo 为 null / undefined / 空串 / 带特殊字符 → 均安全（转义生效）', () => {
  const app = app0({
    deliveries: [
      dl('KCDD-1', '2026-08-23', null, { taskNo: null }),
      dl('KCDD-2', '2026-08-24', null, { taskNo: '' }),
      dl('KCDD-3', '2026-08-25', null, { taskNo: '<b>&"x"' }),
    ],
  });
  const html = String(app.run('renderDelivery()'));
  const dataRows = bodyRowsOf(html).rows.slice(0, -1);
  assert.equal(dataRows.length, 3);
  const vals = dataRows.map(function (row) { return cellOf(row, 'taskNo'); });
  assert.equal(vals.filter(function (v) { return v === ''; }).length, 2, 'null / 空串 → 空单元格');
  assert.equal(vals.filter(function (v) { return v === '&lt;b&gt;&amp;&quot;x&quot;'; }).length, 1,
    '特殊字符必须被 esc 转义（不注入 HTML）');
  app.dispose();
});

/* ================================================================
   §E 编辑弹窗渲染
   ================================================================ */

test('E1 deliveryModal 渲染含 id="dl_taskNo"，非 readonly、非必填，编辑态回填原值', () => {
  const app = app0({
    currentUser: ADMIN,
    deliveries: [dl('KCDD-1', '2026-08-23', null, { planNo: 'JFJH-20260823-00001', taskNo: 'RW-2026-0007' })],
  });
  const nodes = installModalProbe(app);
  app.setGlobals({ closeModal: function () { }, recalcDeliveryTotals: function () { } });
  app.run('deliveryModal(0)');
  const html = String(nodes.modal.innerHTML);
  const inputM = html.match(/<input[^>]*id="dl_taskNo"[^>]*>/);
  assert.ok(inputM, '弹窗必须含 id="dl_taskNo" 的输入框');
  assert.doesNotMatch(inputM[0], /readonly/, '任务单号必须可编辑（不得 readonly）');
  assert.doesNotMatch(inputM[0], /disabled/, '任务单号必须可编辑（不得 disabled）');
  assert.match(inputM[0], /value="RW-2026-0007"/, '编辑态必须回填原任务单号');
  /* 非必填：标签不得带 * 星号（与「订单编号 *」「客户名称 *」区分） */
  assert.match(html, /<label>任务单号<\/label>/, '标签必须是纯「任务单号」，不带 * 必填标记');
  app.dispose();
});

test('E2 老单（无 taskNo）打开弹窗 → value 为空串，不显示 undefined', () => {
  const app = app0({
    currentUser: ADMIN,
    deliveries: [dl('KCDD-1', '2026-08-23', null, { planNo: 'JFJH-20260823-00001' })],
  });
  const nodes = installModalProbe(app);
  app.setGlobals({ closeModal: function () { }, recalcDeliveryTotals: function () { } });
  app.run('deliveryModal(0)');
  const html = String(nodes.modal.innerHTML);
  const inputM = html.match(/<input[^>]*id="dl_taskNo"[^>]*>/);
  assert.ok(inputM, '弹窗必须含 id="dl_taskNo"');
  assert.match(inputM[0], /value=""/, '老单必须回填空串');
  assert.doesNotMatch(inputM[0], /undefined|null/, '不得把 undefined/null 写进 value');
  app.dispose();
});

/* ================================================================
   §F saveDelivery 源码显式取值（该函数逐字段显式取值，不遍历 fields）
   ================================================================ */

test('F1 saveDelivery 源码显式取 dl_taskNo，且无「系统生成 / 保留旧值」特殊逻辑', () => {
  const body = extractFn(INDEX_SRC, 'saveDelivery');
  assert.match(body, /taskNo\s*:\s*\(?\s*document\.getElementById\('dl_taskNo'\)/,
    'saveDelivery 必须显式取 #dl_taskNo 的值');
  assert.match(body, /taskNo\s*:[\s\S]{0,90}\|\|\s*''/, '取值必须兜底空串（非必填）');
  /* taskNo 不得走 planNo 那种「系统生成 / 保留旧值」分支 */
  const taskLine = body.split('\n').filter(function (l) { return /taskNo\s*:/.test(l); });
  assert.equal(taskLine.length, 1, 'taskNo 赋值点应恰 1 处');
  assert.doesNotMatch(taskLine[0], /deliveries\s*\[/, 'taskNo 不得从存量记录保留旧值（用户口径：普通赋值，空就存空串）');
  assert.doesNotMatch(taskLine[0], /next[A-Z]/, 'taskNo 不得由系统生成');
});

test('F2 doSaveDelivery 不对 taskNo 做任何特殊处理（普通字段，走 logFieldDiffs）', () => {
  const body = extractFn(INDEX_SRC, 'doSaveDelivery');
  assert.equal(body.indexOf('taskNo'), -1,
    'doSaveDelivery 内不得出现 taskNo（无系统生成 / 无保留旧值 / 无回填）');
});

/* ================================================================
   §G 字段级操作日志
   ================================================================ */

test('G1 编辑改了 taskNo → 产生 field==="任务单号" 的编辑日志（旧值→新值）', async () => {
  const app = appR({
    deliveries: [dl('KCDD-1', '2026-08-23', null, { planNo: 'JFJH-20260823-00001', taskNo: 'RW-001' })],
  });
  noSideEffects(app);
  app.setGlobal('__d', {
    orderId: 'KCDD-1', customer: '客户-KCDD-1', createdAt: '2026-08-23',
    items: [{ productId: 'P1', productName: '一型', planQty: 5, lineNotes: '' }],
    taskNo: 'RW-002',
  });
  app.run('doSaveDelivery(__d,0)');
  await drain();
  const logs = plain(app.getGlobal('logs'));
  const hit = logs.filter(function (l) { return l.field === '任务单号'; });
  assert.equal(hit.length, 1, '改 taskNo 必须恰 1 条字段级日志');
  assert.match(String(hit[0].detail), /RW-001/, '日志必须含旧值 RW-001');
  assert.match(String(hit[0].detail), /RW-002/, '日志必须含新值 RW-002');
  app.dispose();
});

test('G2 编辑未改 taskNo → 不产生「任务单号」噪音日志', async () => {
  const app = appR({
    deliveries: [dl('KCDD-1', '2026-08-23', null, { planNo: 'JFJH-20260823-00001', taskNo: 'RW-001' })],
  });
  noSideEffects(app);
  app.setGlobal('__d', {
    orderId: 'KCDD-1', customer: '客户改名', createdAt: '2026-08-23',
    items: [{ productId: 'P1', productName: '一型', planQty: 5, lineNotes: '' }],
    taskNo: 'RW-001',
  });
  app.run('doSaveDelivery(__d,0)');
  await drain();
  const logs = plain(app.getGlobal('logs'));
  assert.equal(logs.filter(function (l) { return l.field === '任务单号'; }).length, 0,
    'taskNo 未变 → 不得产生字段级日志');
  assert.equal(logs.filter(function (l) { return l.field === '客户'; }).length, 1,
    '其它字段照常留痕（证明日志机制本身在工作）');
  app.dispose();
});

test('G3 老单首次填 taskNo（空 → 有值）→ 日志旧值显示「空」', async () => {
  const app = appR({
    deliveries: [dl('KCDD-1', '2026-08-23', null, { planNo: 'JFJH-20260823-00001' })],
  });
  noSideEffects(app);
  app.setGlobal('__d', {
    orderId: 'KCDD-1', customer: '客户-KCDD-1', createdAt: '2026-08-23',
    items: [{ productId: 'P1', productName: '一型', planQty: 5, lineNotes: '' }],
    taskNo: 'RW-100',
  });
  app.run('doSaveDelivery(__d,0)');
  await drain();
  const logs = plain(app.getGlobal('logs'));
  const hit = logs.filter(function (l) { return l.field === '任务单号'; });
  assert.equal(hit.length, 1, '老单补填必须留痕');
  assert.match(String(hit[0].detail), /空/, '旧值必须显示为「空」');
  assert.match(String(hit[0].detail), /RW-100/);
  app.dispose();
});

/* ================================================================
   §H 老单不补守卫（源码扫描）
   ----------------------------------------------------------------
   判据（结构不变量，不依赖 git 修订号）：
     ① 全工程无任何对 *.taskNo 的赋值（只有读取/渲染/表单取值）；
     ② 无 obj['taskNo']= 形式的动态赋值；
     ③ key:'taskNo' 恰 4 处 = HARD_FIELDS / defaultFields / 迁移 DEF / TBL_SCHEMAS；
     ④ 迁移函数体内不出现 deliveries（绝不回填）。
   ================================================================ */

test('H1 全工程不存在 *.taskNo = 赋值（无任何回填点）', () => {
  assert.equal((INDEX_CODE.match(/\.taskNo\s*=[^=]/g) || []).length, 0,
    '不得存在对 *.taskNo 的赋值 —— 存在即意味着有回填/写入侧逻辑');
  assert.equal((INDEX_CODE.match(/\[\s*['"]taskNo['"]\s*\]\s*=/g) || []).length, 0,
    "不得存在 obj['taskNo'] = 形式动态赋值");
});

test('H2 key:\'taskNo\' 恰 4 处（HARD_FIELDS / defaultFields / 迁移 DEF / TBL_SCHEMAS），无第 5 处藏匿实现', () => {
  const hits = INDEX_CODE.match(/key\s*:\s*'taskNo'/g) || [];
  assert.equal(hits.length, 4, "key:'taskNo' 必须恰 4 处，实际 " + hits.length);
});

test('H3 迁移函数体内不出现 deliveries（只动字段配置，绝不回填存量数据）', () => {
  const body = stripComments(extractFn(INDEX_SRC, 'migrateDeliveryFieldsTaskNo'));
  assert.equal(body.indexOf('deliveries'), -1, 'migrateDeliveryFieldsTaskNo 内不得出现 deliveries');
  assert.equal((body.match(/\.taskNo\s*=[^=]/g) || []).length, 0, '迁移内不得对 taskNo 赋值');
  /* 且它只 save('fields', …) */
  assert.match(body, /save\('fields'\s*,/, "迁移唯一的落盘对象必须是 fields");
  assert.doesNotMatch(body, /save\('deliveries'/, "迁移绝不得落盘 deliveries");
});

test('H4 全工程不存在任何「回填 taskNo」的迁移：migrate* 函数名里无 taskNo 之外的自定义回填实现', () => {
  /* 捕获所有 migrate / fix / _apply 前缀的函数定义名，逐个检查其函数体是否触碰 taskNo */
  const names = [...INDEX_CODE.matchAll(/function\s+((?:migrate|fix|_apply)[A-Za-z0-9_]*)\s*\(/g)]
    .map(function (m) { return m[1]; });
  assert.ok(names.length > 10, '应能捕获到项目既有的迁移/订正函数（实际 ' + names.length + '）');
  const offenders = [];
  names.forEach(function (n) {
    if (n === 'migrateDeliveryFieldsTaskNo') return;   /* 唯一允许触碰 taskNo 的迁移（只动 fields 配置） */
    const body = stripComments(extractFn(INDEX_SRC, n));
    if (body.indexOf('taskNo') >= 0) offenders.push(n);
  });
  assert.deepEqual(offenders, [], '除 migrateDeliveryFieldsTaskNo 外，不得有迁移函数触碰 taskNo');
  /* 反向自证：守卫确实覆盖到了真正的迁移函数集合（防「捕获不到 → 恒真」） */
  assert.ok(names.indexOf('migrateDeliveryFieldsTaskNo') >= 0, '捕获集合必须含本次迁移（防恒真）');
  assert.ok(names.indexOf('migrateDeliveryPlanNo') >= 0, '捕获集合必须含既有迁移（防恒真）');
});

/* ================================================================
   §I 合计行逐列同构（taskNo 是文本列 → 自动输出空 td，与 schema 键序一致）
   ================================================================ */

test('I1 sumRowHtml 输出 td 的 data-key 序列 == TBL_SCHEMAS.delivery 键序列；taskNo 格为空', () => {
  const app = app0({
    deliveries: [
      dl('KCDD-1', '2026-08-23', null, { taskNo: 'RW-001' }),
      dl('KCDD-2', '2026-08-24', null, { taskNo: 'RW-002' }),
    ],
  });
  const html = String(app.run('renderDelivery()'));
  const rows = bodyRowsOf(html).rows;
  const sumRow = rows[rows.length - 1];
  const sumKeys = [...sumRow.matchAll(/data-key="([^"]+)"/g)].map(function (m) { return m[1]; });
  const schemaKeys = plain(app.run('TBL_SCHEMAS.delivery.map(function(c){return c.key})'));
  assert.deepEqual(sumKeys, schemaKeys, '合计行必须与 schema 逐列同构（文本列也要出空 td）');
  assert.equal(cellOf(sumRow, 'taskNo'), '', '文本列在合计行必须是空单元格（不求和、不显示合计文字）');
  app.dispose();
});

test('I2 任务单号不参与任何求和：sums 只对 type==="number" 建键', () => {
  const body = stripComments(extractFn(INDEX_SRC, 'sumRowHtml'));
  assert.match(body, /c\.type\s*===\s*'number'/, '合计逻辑必须仍只对 number 列求和');
  const app = app0({ deliveries: [dl('KCDD-1', '2026-08-23', null, { taskNo: 'RW-001' })] });
  app.run('renderDelivery()');
  assert.equal(plain(app.run('TBL_SCHEMAS.delivery[7].type')), 'text', 'taskNo 必须不是 number 类型');
  app.dispose();
});

/* ================================================================
   §J 导出 / 导入模板 / 接线（只读断言，证明 js/import.js 无需改动）
   ================================================================ */

test('J1 导出与导入模板靠持久化 fields.delivery 承接 → 迁移后自动带上「任务单号」列', async () => {
  const app = appR({
    fields: { delivery: [{ key: 'firstDate', label: '首次交付日', type: 'date', required: false, locked: false }] },
  });
  app.run('migrateDeliveryFieldsTaskNo()');
  await drain();
  const labels = plain(app.getGlobal('fields')).delivery.map(function (f) { return f.label; });
  assert.ok(labels.indexOf('任务单号') >= 0, '持久化 fields.delivery 必须含「任务单号」→ 导出列 / 导入模板自动生效');
  app.dispose();
});

test('J2 js/import.js 无需改动：表头按 fields[formKey] 的 label→key 映射，新增字段零改动即生效', () => {
  const IMPORT_SRC = fs.readFileSync(path.join(ROOT, 'js', 'import.js'), 'utf8');
  const IMPORT_CODE = stripComments(IMPORT_SRC);
  assert.equal((IMPORT_CODE.match(/taskNo/g) || []).length, 0,
    'js/import.js 不得出现 taskNo 硬编码（新增字段本应靠 fields 映射自动生效）');
  assert.ok(IMPORT_CODE.indexOf('labelToKey2[f.label]=f.key') >= 0, '导入必须仍按 fields 的 label→key 映射');
});

test('J3 initApp 已接线迁移，且位于 fields 加载之后（否则读到空配置）', () => {
  const iLoad = INDEX_SRC.indexOf("fields=await DB.get('fields'");
  const iCall = INDEX_SRC.indexOf('migrateDeliveryFieldsTaskNo();');
  assert.ok(iLoad > 0, 'initApp 必须有 fields 加载点');
  assert.ok(iCall > 0, 'initApp 必须调用 migrateDeliveryFieldsTaskNo()');
  assert.ok(iCall > iLoad, '迁移必须在 fields 加载之后调用');
  /* 与同族的 planNoField 迁移相邻（便于后人识别同型事故） */
  const iSibling = INDEX_SRC.indexOf('migrateDeliveryPlanNoField();');
  assert.ok(Math.abs(iCall - iSibling) < 400, '应与 migrateDeliveryPlanNoField() 相邻接线（同型事故同处登记）');
});

test('J4 server/ 无需改动：BIZ_KEYS 整条 JSON 存取，无字段白名单', () => {
  const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');
  assert.equal((SERVER_SRC.match(/taskNo/g) || []).length, 0, 'server.js 不得出现 taskNo（整表存取，无需白名单）');
  assert.ok(SERVER_SRC.indexOf('BIZ_KEYS') > 0, 'server.js 应仍用 BIZ_KEYS 整表存取');
});
