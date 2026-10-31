'use strict';
/* ================================================================
   tests/qa.parts-ledger.validate.159.test.js
   —— QA 独立验证：build 2026-10-31.159 两项口径收紧
        ① 「零部件入库数量」强制**正整数**（非法即**整批拒绝**，绝不静默纠正）
        ② 「最大 / 最小库存量」**禁止负数**（保存时硬拦；0 = 合法 = 不设限制）
        ③ 存量数据不动（历史负数 / 历史小数库存不回填、不迁移、不四舍五入）
   ================================================================
   定位（为什么另起一个文件，而不是加进 qa.parts-ledger.independent.test.js）：
     · 那一份是 .158 的**全景资产**（53 条，口径 / 拖拽 / 权限 / 服务端），版本推进时只做版本同步；
     · 本文件只钉 .159 的**两条新硬闸**，且刻意**不复用** tests/parts.159.test.js（工程师自述用例）
       的任何断言写法定式 —— 不采信工程师自述，全部从 PRD 口径重新推行为。
     · 每条硬闸都用「行为级断言 + 变异注入」双保险：§C 把源码改坏，§B 的探针必须变红；
       注入未生效（命中数 ≠ 1）直接抛错，严禁静默通过。

   版本号来源：遵循 `tests/qa.import-nodelivered.test.js` 的既有做法，**不**在本文件再写字面量副本
   （否则每推进一版就多一处要手工同步的锚点），一律引用 `tests/harness/build.js` 单一来源；
   而「harness 的 BUILD 是否手写」由 §D 反向钉住（countOcc === 1 且不得 readFileSync 反推）。

   跑法（显式文件，勿用目录形式 —— 会扫入 _diag/before*）：
     node --test tests/qa.parts-ledger.validate.159.test.js
   ================================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createApp, ROOT } = require('./harness/sandbox');
const build = require('./harness/build');

const BUILD = build.BUILD;   /* '2026-10-31.159' */
const PREV = build.PREV;     /* '2026-10-31.158' */
const BUILD_NO = String(BUILD).split('.')[1];        /* '159' */
const BUILD_DATE = String(BUILD).split('.')[0];      /* '2026-10-31' */

const readRel = function (rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); };
const INDEX_SRC = readRel('index.html');
const GUIDE_SRC = readRel('js/guide.js');
const README_SRC = readRel('README.md');
const BUILD_SRC = readRel('tests/harness/build.js');
const PPSHIFT_SRC = readRel('tests/qa.ppshift-advance.independent.test.js');
const PRODPLAN_QUERY_SRC = readRel('tests/qa.prodplan-query.independent.test.js');
const LAYOUT_INDEP_SRC = readRel('tests/layout.scoped.independent.test.js');
const PARTS159_SRC = readRel('tests/parts.159.test.js');
const PARTS158_SRC = readRel('tests/parts.158.test.js');
const LEDGER_INDEP_SRC = readRel('tests/qa.parts-ledger.independent.test.js');

/* ================================================================
   源码工具
   ================================================================ */

function countOcc(src, needle) {
  let n = 0, i = 0;
  for (;;) {
    const k = src.indexOf(needle, i);
    if (k < 0) return n;
    n++; i = k + needle.length;
  }
}

function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** 按大括号配平取函数源码（只认 `function name(` / `async function name(`） */
function extractFn(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(', 'g');
  const m = re.exec(src);
  if (!m) throw new Error('[qa] 未找到函数: ' + name);
  let p = m.index + m[0].length, d = 1;
  for (; p < src.length; p++) {
    if (src[p] === '(') d++;
    else if (src[p] === ')') { d--; if (d === 0) break; }
  }
  const i = src.indexOf('{', p);
  let j = i; d = 0;
  for (; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (d === 0) break; }
  }
  return src.slice(m.index, j + 1);
}

/* ================================================================
   沙箱装配
   ================================================================ */

const ADMIN = { username: 'qa_admin', name: 'QA严过关', role: 'admin', perms: {} };
/* 只读：无 parts 写权限，且 acts 已配置（不收任何动作） */
const READONLY = { username: 'qa_ro', name: '只读账号', role: 'staff', perms: { acts: {} } };

/** 编号 → 期初库存；索引 0 = LJ-001（10 件），1 = LJ-002（3 件），2 = LJ-003（200 张） */
function partsFixture(overrides) {
  const base = [
    { id: 'LJ-001', name: '螺钉', spec: 'M4×10', model: 'GB/T845', unit: '个', stockMax: 100, stockMin: 5, stock: 10, used: 0 },
    { id: 'LJ-002', name: '外壳', spec: '白色', model: 'CW-A', unit: '个', stockMax: 100, stockMin: 5, stock: 3, used: 0 },
    { id: 'LJ-003', name: '垫片', spec: '', model: '', unit: '张', stockMax: 100, stockMin: 5, stock: 200, used: 0 }
  ];
  Object.keys(overrides || {}).forEach(function (k) {
    const ix = Number(k);
    base[ix] = Object.assign({}, base[ix], overrides[k]);
  });
  return base;
}

/**
 * DOM 桩：getElementById 按 id 记忆返回同一对象，value 由 values 驱动并可随时改写。
 * 只覆盖 getElementById —— 这是「读表单输入」的生产函数在无 DOM 布局环境下的唯一可测入口。
 */
function installDom(app, inputs) {
  const values = Object.assign({}, inputs || {});
  const els = {};
  const make = function (id) {
    const cls = new Set();
    const el = {
      id: id, innerHTML: '', textContent: '', style: {}, dataset: {}, checked: false, disabled: false,
      classList: {
        add: function (c) { cls.add(c); },
        remove: function (c) { cls.delete(c); },
        contains: function (c) { return cls.has(c); },
        toggle: function (c) { if (cls.has(c)) { cls.delete(c); return false; } cls.add(c); return true; }
      },
      setAttribute: function () {}, getAttribute: function () { return null; }, removeAttribute: function () {},
      appendChild: function () {}, remove: function () {},
      querySelector: function () { return null; }, querySelectorAll: function () { return []; },
      addEventListener: function () {}, removeEventListener: function () {},
      closest: function () { return null; }, focus: function () {}, click: function () {},
      getBoundingClientRect: function () { return { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0 }; }
    };
    Object.defineProperty(el, 'value', {
      get: function () { return values[id] !== undefined ? String(values[id]) : ''; },
      set: function (v) { values[id] = v; },
      configurable: true
    });
    return el;
  };
  app.sandbox.document.getElementById = function (id) {
    if (!els[id]) els[id] = make(id);
    return els[id];
  };
  return { values: values, els: els, set: function (id, v) { values[id] = v; } };
}

function mkApp(seed, opts) {
  const app = createApp(Object.assign({ installRecorder: true }, opts || {}));
  app.setGlobals(Object.assign({
    currentUser: ADMIN,
    products: [{ id: 'P1', name: '甲产品', spec: '', model: '', unit: '台', stock: 5, status: '启用' }],
    parts: partsFixture(),
    partLogs: [],
    orders: [], deliveries: [], productionPlans: [], productionReports: [],
    processTemplates: [], transfers: [], logs: [],
    fields: { product: [], order: [] },
    fieldsAudit: 'audited', fieldsDraft: null,
    meta: { seq: 1 },
    tblLayout: {}, uiDefaults: { order: {} }, tblPage: {}, tblState: {},
    selRows: {}, lastRowIds: {},
    renderContent: function () {},
    renderAll: function () {}
  }, seed || {}));
  return app;
}

/** 从沙箱读表达式（跨 realm 安全） */
function J(app, expr) { return JSON.parse(app.run('JSON.stringify(' + expr + ')')); }

function stocks(app) {
  return J(app, 'parts').map(function (p) { return p.stock; });
}

/**
 * 跑一次「开弹窗 → 填数量 → 确认入库」。
 * @returns {{dom:Object}} dom.set(id, v) 可在同一弹窗内改值后重试（复现「被拒后直接改数再提交」）
 */
async function runPartIn(app, qtyByIndex, sel) {
  const inputs = {};
  Object.keys(qtyByIndex).forEach(function (i) { inputs['pi_qty_' + i] = qtyByIndex[i]; });
  const dom = installDom(app, inputs);
  const selIdx = sel || Object.keys(qtyByIndex);
  app.setGlobal('selRows', { parts: new Set(selIdx.map(String)) });
  await app.run('openPartIn()');
  await app.run('doPartIn()');
  return { dom: dom };
}

/** 跑一次「零部件弹窗 → 保存」（idx = -1 为新增） */
async function runSavePart(app, fields, idx) {
  const inputs = {};
  ['id', 'name', 'spec', 'model', 'unit', 'stockMax', 'stockMin'].forEach(function (k) {
    inputs['pj_' + k] = fields[k] === undefined ? '' : fields[k];
  });
  installDom(app, inputs);
  await app.run('savePart(' + (idx === undefined ? -1 : idx) + ')');
}

function alertText(app) { return app.alerts.join('\n'); }
function alertCount(app) { return app.alerts.length; }

/* ================================================================
   §B1 入库整数闸：逐条边界的行为 + 提示文案
   ================================================================ */

/**
 * 整数闸探针（§C 变异注入复用同一段断言 → 证明它会红）。
 * 每条都断言四件事：库存是否变动 / 是否发事务 / 是否弹 alert / alert 是否点名行号与原始输入。
 */
async function probeIntegerGate(indexHtml) {
  const CASES = [
    /* raw,        期望出口,        入库后库存,  alert 必须包含的片段 */
    { raw: '0.5', kind: '⑤非整数', stock: 10, must: ['必须是正整数', '第 1 行', '0.5'] },
    { raw: '2.5', kind: '⑤非整数', stock: 10, must: ['必须是正整数', '第 1 行', '2.5'] },
    { raw: '-0.5', kind: '④负数', stock: 10, must: ['不能为负数', '第 1 行', '-0.5'] },
    { raw: 'abc', kind: '③非数字', stock: 10, must: ['不是有效数字', 'abc'] },
    { raw: '1,000', kind: '③非数字', stock: 10, must: ['不是有效数字', '1,000'] },
    { raw: ' ', kind: '⑥无数量', stock: 10, must: ['请至少填写一个'] },
    { raw: '0', kind: '⑥无数量', stock: 10, must: ['请至少填写一个'] },
    { raw: '1e3', kind: '放行', stock: 1010, must: [] },
    { raw: '10.0', kind: '放行', stock: 20, must: [] }
  ];
  for (const c of CASES) {
    const app = mkApp({}, indexHtml ? { indexHtml: indexHtml } : undefined);
    try {
      await runPartIn(app, { 0: c.raw });
      const label = '[raw=' + JSON.stringify(c.raw) + ' → ' + c.kind + ']';
      assert.equal(app.run('parts[0].stock'), c.stock, label + ' 库存必须是 ' + c.stock);
      if (c.kind === '放行') {
        assert.equal(app.recorder.txCount(), 1, label + ' 合法输入必须恰好提交 1 次事务');
        assert.equal(alertCount(app), 0, label + ' 合法输入不得打扰用户（alert: ' + alertText(app) + '）');
        assert.equal(J(app, 'partLogs').length, 1, label + ' 合法输入必须写 1 条台账');
        assert.equal(J(app, 'partLogs')[0].qty, c.stock - 10, label + ' 台账数量必须是整数增量');
        assert.ok(Number.isInteger(J(app, 'partLogs')[0].qty), label + ' 台账 qty 必须为整数');
      } else {
        assert.equal(app.recorder.txCount(), 0, label + ' 非法输入不得发事务（值没变就不该写盘）');
        assert.equal(J(app, 'partLogs').length, 0, label + ' 非法输入不得写台账');
        assert.equal(alertCount(app), 1, label + ' 必须恰好 1 条提示（实际: ' + alertText(app) + '）');
        c.must.forEach(function (frag) {
          assert.ok(alertText(app).indexOf(frag) >= 0,
            label + ' 提示必须包含「' + frag + '」，实际: ' + alertText(app));
        });
      }
    } finally {
      app.dispose();
    }
  }
}

test('B1a 整数闸边界：0.5 / 2.5 / -0.5 / abc / " " / 0 → 一律拒绝且库存不变、不发事务', async function () {
  await probeIntegerGate(null);
});

test('B1b "1,000"（千分位逗号）→ Number("1,000") 是 NaN → 走「不是有效数字」，不得被当成 1000', async function () {
  const app = mkApp();
  try {
    await runPartIn(app, { 0: '1,000' });
    assert.equal(app.run('parts[0].stock'), 10, '千分位写法不得入库');
    assert.equal(app.recorder.txCount(), 0, '不得发事务');
    assert.ok(alertText(app).indexOf('不是有效数字') >= 0, '必须明确说是「不是有效数字」而非「必须是正整数」：' + alertText(app));
    assert.ok(alertText(app).indexOf('1,000') >= 0, '提示必须原样带出用户输入（否则用户不知道哪一行哪一处错了）');
  } finally {
    app.dispose();
  }
});

test('B1c "10.0"（有小数点但数学上是整数）→ 实际放行，属**当前口径**而非缺陷（已在源码注释中声明）', async function () {
  /* 口径说明：闸门的判据是 `Number.isInteger(Number(raw))`，不是「字符串里有没有小数点」。
     '10.0' → 10 → isInteger 真 → 放行入库 10 件。
     这是**可接受**的：零件按「件」计，10 件与 10.0 件是同一件事，入库 10 件账实相符；
     与 '0.5' / '2.5'（真实小数、会导致半件）有本质区别。
     若产品日后要求「连小数点都不许出现」，须改成字符串形态校验（正则），届时本用例需同步反转。 */
  const app = mkApp();
  try {
    await runPartIn(app, { 0: '10.0' });
    assert.equal(app.run('parts[0].stock'), 20, '10 + 10 = 20（"10.0" 按 10 件入库）');
    assert.equal(app.recorder.txCount(), 1, '放行 → 一次事务');
    assert.equal(alertCount(app), 0, '放行 → 不打扰用户');
    assert.equal(J(app, 'partLogs')[0].qty, 10, '台账数量落成数值 10（不是字符串 "10.0"）');
  } finally {
    app.dispose();
  }
});

test('B1d "1e3"（科学计数）→ Number 后 1000 是整数 → 放行；这是**有意**行为（number 输入框本就允许）', async function () {
  const app = mkApp();
  try {
    await runPartIn(app, { 0: '1e3' });
    assert.equal(app.run('parts[0].stock'), 1010, '10 + 1000 = 1010');
    assert.equal(app.recorder.txCount(), 1, '放行 → 一次事务');
    assert.equal(J(app, 'partLogs')[0].qty, 1000, '台账落 1000 件');
  } finally {
    app.dispose();
  }
});

test('B1e 空格 " " → trim 后等同「留空」，走「请至少填写一个」而非「不是有效数字」（既有语义不变）', async function () {
  /* 说明：doPartIn 先 `String(el.value).trim()`，故单独一个空格 = 空串 = 该行不入库。
     三行全空 → plan 为空 → 出口⑥「请至少填写一个入库数量」。既不发事务也不改库存，符合「留空不报错」的口径。 */
  const app = mkApp();
  try {
    await runPartIn(app, { 0: ' ' });
    assert.deepEqual(stocks(app), [10, 3, 200], '三行库存一字不动');
    assert.equal(app.recorder.txCount(), 0, '不得发事务');
    assert.equal(alertCount(app), 1, '单行留空 → 提示「请至少填写一个」');
    assert.ok(alertText(app).indexOf('请至少填写一个') >= 0, '实际: ' + alertText(app));
    assert.ok(alertText(app).indexOf('不是有效数字') < 0, '空格不得被报成「不是有效数字」（trim 已生效）');
  } finally {
    app.dispose();
  }
});

/* ================================================================
   §B2 整批性（最关键）：一行非法 → 整批拒绝，合法行也不得入库
   ================================================================ */

async function probeWholeBatchRejects(indexHtml) {
  const app = mkApp({ parts: partsFixture(), partLogs: [] }, indexHtml ? { indexHtml: indexHtml } : undefined);
  try {
    /* 三行混合：合法 100 / 小数 0.5 / 合法 50 */
    await runPartIn(app, { 0: '100', 1: '0.5', 2: '50' });
    assert.deepEqual(stocks(app), [10, 3, 200],
      '整批拒绝：三个零件的库存都必须原封不动（合法行 100 / 50 也不得入库）');
    assert.equal(J(app, 'partLogs').length, 0, '整批拒绝：台账必须 0 条（不得留半截流水）');
    assert.equal(app.recorder.txCount(), 0, '整批拒绝：不得发事务（内存与服务器必须一致）');
    assert.equal(alertCount(app), 1, '只提示一次（不要逐行刷屏）：' + alertText(app));
    assert.ok(alertText(app).indexOf('第 2 行') >= 0, '提示必须点出是第 2 行出错：' + alertText(app));
    assert.ok(alertText(app).indexOf('0.5') >= 0, '提示必须带出原始输入 0.5');
    assert.ok(alertText(app).indexOf('所有零件库存均未变动') >= 0, '必须明确告知「所有零件库存均未变动」，否则用户无法判断要不要复查');
  } finally {
    app.dispose();
  }
}

test('B2a 三行混合（100 / 0.5 / 50）→ 整批拒绝，两个合法行库存都没变、台账 0 条、不发 tx', async function () {
  await probeWholeBatchRejects(null);
});

test('B2b 拒绝后状态没被搞坏：同一弹窗内把 0.5 改成合法值 → 立刻能正常提交（不必重开弹窗）', async function () {
  const app = mkApp();
  try {
    const { dom } = await runPartIn(app, { 0: '100', 1: '0.5', 2: '50' });
    assert.deepEqual(stocks(app), [10, 3, 200], '第一次被整批拒绝');
    /* 被拒时**必须**保留批次（不清勾选、不关弹窗），否则用户要重新勾选、重填三行 */
    assert.equal(JSON.stringify(J(app, '__piIdxs')), '[0,1,2]', '被整批拒绝时不得清掉本次批次');
    /* 用户按提示只改第 2 行 */
    dom.set('pi_qty_1', '5');
    await app.run('doPartIn()');
    assert.deepEqual(stocks(app), [110, 8, 250], '修正后三行都正常入库（10+100 / 3+5 / 200+50）');
    assert.equal(app.recorder.txCount(), 1, '只有成功那一次发事务（被拒那次没发）');
    assert.equal(J(app, 'partLogs').length, 3, '台账 3 条');
    assert.equal(alertCount(app), 1, '成功那次不再弹提示');
    /* 成功后才收尾：批次置空（与上面「被拒时保留」形成对照） */
    assert.equal(app.run('__piIdxs'), null, '成功后批次必须置空（弹窗已关）');
  } finally {
    app.dispose();
  }
});

test('B2c 整批性反向：行数越多越要整批 —— 5 行里只有最后一行非法，前 4 行也不得入库', async function () {
  const app = mkApp({
    parts: partsFixture().concat([
      { id: 'LJ-004', name: '弹簧', unit: '个', stockMax: 100, stockMin: 5, stock: 1, used: 0 },
      { id: 'LJ-005', name: '螺母', unit: '个', stockMax: 100, stockMin: 5, stock: 7, used: 0 }
    ])
  });
  try {
    await runPartIn(app, { 0: '10', 1: '20', 2: '30', 3: '40', 4: '1.5' });
    assert.deepEqual(stocks(app), [10, 3, 200, 1, 7], '5 行全部原封不动');
    assert.equal(app.recorder.txCount(), 0, '不得发事务');
    assert.ok(alertText(app).indexOf('第 5 行') >= 0, '提示必须指向第 5 行：' + alertText(app));
  } finally {
    app.dispose();
  }
});

/* ================================================================
   §B3 顺序裁定：-3 报「负数」而非「必须是正整数」
   ================================================================ */

test('B3a "-3" 必须报「不能为负数」（工程师裁定的顺序：负数判断在整数闸之前）', async function () {
  const app = mkApp();
  try {
    await runPartIn(app, { 0: '-3' });
    assert.equal(app.run('parts[0].stock'), 10, '库存不变');
    assert.ok(alertText(app).indexOf('不能为负数') >= 0, '必须报负数：' + alertText(app));
    assert.ok(alertText(app).indexOf('必须是正整数') < 0,
      '不得抢走既有「负数」文案（-3 的最贴近原因是「不能为负数」）：' + alertText(app));
  } finally {
    app.dispose();
  }
});

test('B3b 顺序裁定的代价："-0.5" 先报「负数」，改成 "0.5" 后才报「必须是正整数」（两轮提示，可接受但记录在案）', async function () {
  /* 独立判断：这个顺序**合理**。理由：
       ① -0.5 的两个违规原因里，「负数」是更严重、更不可挽回的那个（负数入库会直接把库存做穿）；
       ② 提示文案本身是**准确**的（-0.5 确实是负数），不存在「指错方向」——用户照提示改正负号即可；
       ③ 唯一代价是「负数 + 小数」的输入要挨两次提示。属可接受的体验折衷，**不建议**为它加复合文案
          （复合文案会让最简单常见的「-3」场景多一句无关噪音）。
     该代价在此显式钉住，防止日后有人「优化顺序」时无感破坏既有文案。 */
  const app = mkApp();
  try {
    const { dom } = await runPartIn(app, { 0: '-0.5' });
    assert.ok(alertText(app).indexOf('不能为负数') >= 0, '第一轮：报负数');
    assert.ok(alertText(app).indexOf('必须是正整数') < 0, '第一轮：不报正整数');
    dom.set('pi_qty_0', '0.5');
    await app.run('doPartIn()');
    assert.ok(alertText(app).indexOf('必须是正整数') >= 0, '第二轮：去掉负号后报正整数');
    assert.equal(app.run('parts[0].stock'), 10, '两轮都不得入库');
    assert.equal(app.recorder.txCount(), 0, '两轮都不得发事务');
  } finally {
    app.dispose();
  }
});

test('B3c 整数闸的位置：必须在「负数判断之后、q===0 跳过之前」（静态守卫 + 反假自检）', function () {
  const fn = stripComments(extractFn(INDEX_SRC, 'doPartIn'));
  const iNeg = fn.indexOf('if(q<0){');
  const iInt = fn.indexOf('if(!Number.isInteger(q)){');
  const iZero = fn.indexOf('if(q===0)continue;');
  const iPush = fn.indexOf('plan.push(');
  assert.ok(iNeg > 0, '必须存在 q<0 判断');
  assert.ok(iInt > 0, '必须存在 Number.isInteger(q) 整数闸');
  assert.ok(iZero > 0 && iPush > 0, '必须存在 q===0 跳过与 plan.push');
  assert.ok(iNeg < iInt, '整数闸必须在负数判断**之后**（否则 -3 会报「必须是正整数」，抢走既有文案）');
  assert.ok(iInt < iZero, '整数闸必须在 q===0 跳过**之前**（否则 0 会被报成「必须是正整数」，破坏「填 0 = 不入库」）');
  assert.ok(iInt < iPush, '整数闸必须在 plan.push **之前**（先全批校验、后统一累加 —— 整批性的实现前提）');
  /* 反假自检：同一套判据必须能把「顺序写反」的合成样本判红，否则上面的「前后关系」只是巧合 */
  const badOrder = 'if(!Number.isInteger(q)){return;} if(q<0){return;} if(q===0)continue; plan.push(1);';
  assert.ok(badOrder.indexOf('if(q<0){') > badOrder.indexOf('if(!Number.isInteger(q)){'),
    '反假自检：整数闸在前的样本必须被判为「顺序错」');
  /* 计数守卫：整数闸只能有 1 处（多处散落必漏） */
  assert.equal(countOcc(fn, 'Number.isInteger(q)'), 1, '整数闸必须恰 1 处');
});

test('B3d 反静默纠正：doPartIn 内不得出现 Math.round / Math.floor / Math.ceil / Math.abs / Math.trunc(q)', function () {
  const fn = stripComments(extractFn(INDEX_SRC, 'doPartIn'));
  ['Math.round(q)', 'Math.floor(q)', 'Math.ceil(q)', 'Math.abs(q)', 'Math.trunc(q)'].forEach(function (bad) {
    assert.equal(countOcc(fn, bad), 0,
      '入库数量**绝不允许**被静默纠正（命中 ' + bad + '）—— 用户会以为 0.5 件已按 1 件入库，账实从此对不上');
  });
  /* 反向自检：本套判据必须能认出合成样本 */
  assert.equal(countOcc('const x=Math.round(q);', 'Math.round(q)'), 1, '反假自检：判据必须能认出 Math.round(q)');
});

/* ================================================================
   §B4 上下限禁负（savePart 硬闸）
   ================================================================ */

const BASE_FIELDS = { id: 'LJ-100', name: '新零件', spec: 'S', model: 'M', unit: '个' };

function withFields(extra) { return Object.assign({}, BASE_FIELDS, extra); }

test('B4a 最大库存量 = -5 → 拒绝保存：数组长度不变、内存值不变、不发事务、提示点名当前值', async function () {
  const app = mkApp();
  try {
    await runSavePart(app, withFields({ stockMax: '-5', stockMin: '5' }));
    assert.equal(app.run('parts.length'), 3, 'parts 长度必须不变（不得半途 push）');
    assert.equal(app.recorder.txCount(), 0, '不得发事务');
    assert.equal(alertCount(app), 1, '恰好 1 条提示：' + alertText(app));
    assert.ok(alertText(app).indexOf('最大库存量不能为负数') >= 0, '实际: ' + alertText(app));
    assert.ok(alertText(app).indexOf('-5') >= 0, '提示必须带出当前值（用户才知道是哪个框错了）');
    assert.ok(alertText(app).indexOf('0 或正整数') >= 0, '提示必须自带**可执行正解**（用户看不到源码注释）');
  } finally {
    app.dispose();
  }
});

test('B4b 最小库存量 = -1 → 拒绝保存（同上）', async function () {
  const app = mkApp();
  try {
    await runSavePart(app, withFields({ stockMax: '100', stockMin: '-1' }));
    assert.equal(app.run('parts.length'), 3, 'parts 长度必须不变');
    assert.equal(app.recorder.txCount(), 0, '不得发事务');
    assert.equal(alertCount(app), 1, '恰好 1 条提示：' + alertText(app));
    assert.ok(alertText(app).indexOf('最小库存量不能为负数') >= 0, '实际: ' + alertText(app));
    assert.ok(alertText(app).indexOf('-1') >= 0, '提示必须带出当前值');
    assert.ok(alertText(app).indexOf('0 或正整数') >= 0, '提示必须自带可执行正解');
  } finally {
    app.dispose();
  }
});

test('B4c 双负（max=-5 / min=-9）→ 只拦第一条（最大在前），提示不叠加、数据不动', async function () {
  const app = mkApp();
  try {
    await runSavePart(app, withFields({ stockMax: '-5', stockMin: '-9' }));
    assert.equal(app.run('parts.length'), 3, 'parts 长度不变');
    assert.equal(app.recorder.txCount(), 0, '不得发事务');
    assert.equal(alertCount(app), 1, '只提示一次（不叠加成两条）：' + alertText(app));
    assert.ok(alertText(app).indexOf('最大库存量不能为负数') >= 0, '最大在前：' + alertText(app));
    assert.ok(alertText(app).indexOf('最小库存量') < 0, '最小那条不得同时弹出');
  } finally {
    app.dispose();
  }
});

test('B4d 0 合法（= 不设限制）→ 保存成功、恰好一次事务、原样落 0（不得被"补默认值"）', async function () {
  const app = mkApp();
  try {
    await runSavePart(app, withFields({ stockMax: '0', stockMin: '0' }));
    assert.equal(app.run('parts.length'), 4, '新增成功 → 长度 4');
    assert.equal(app.recorder.txCount(), 1, '恰好一次事务');
    assert.equal(alertCount(app), 0, '不得打扰用户');
    const created = J(app, 'parts')[3];
    assert.equal(created.stockMax, 0, '最大库存量必须原样落 0（0 = 不设限制，不是 100）');
    assert.equal(created.stockMin, 0, '最小库存量必须原样落 0');
    assert.equal(created.stock, 0, '新建零件库存 0');
    assert.equal(created.used, 0, '新建零件已占用 0');
  } finally {
    app.dispose();
  }
});

test('B4e 空串（未填）→ num("") = 0 → 合法放行；正数（2000 / 50）原样落库', async function () {
  const app = mkApp();
  try {
    await runSavePart(app, withFields({ stockMax: '', stockMin: '' }));
    assert.equal(app.run('parts.length'), 4, '空串必须放行（未填 = 不设限制）');
    assert.equal(J(app, 'parts')[3].stockMax, 0, '空串落 0');
  } finally {
    app.dispose();
  }

  const app2 = mkApp();
  try {
    await runSavePart(app2, withFields({ stockMax: '2000', stockMin: '50' }));
    assert.equal(app2.run('parts.length'), 4, '正数必须放行');
    assert.equal(app2.recorder.txCount(), 1, '一次事务');
    assert.equal(J(app2, 'parts')[3].stockMax, 2000, '正数原样落库');
    assert.equal(J(app2, 'parts')[3].stockMin, 50, '正数原样落库');
  } finally {
    app2.dispose();
  }
});

test('B4f 两条 <0 硬闸都必须在任何数组改动之前（静态守卫 + 反假自检）', function () {
  const fn = stripComments(extractFn(INDEX_SRC, 'savePart'));
  const iMax = fn.indexOf('if(p.stockMax<0){');
  const iMin = fn.indexOf('if(p.stockMin<0){');
  const iAssign = fn.indexOf('parts[idx]=p');
  const iPush = fn.indexOf('parts.push(p)');
  assert.ok(iMax > 0 && iMin > 0, '两条硬闸都必须存在');
  assert.ok(iMax < iMin, '最大在前（提示不叠加的确定性来源）');
  assert.ok(iMax < iAssign, '最大硬闸必须在 parts[idx]=p 之前（否则被拦时内存已被改脏）');
  assert.ok(iMin < iAssign, '最小硬闸必须在 parts[idx]=p 之前');
  assert.ok(iMax < iPush && iMin < iPush, '两条硬闸都必须在 parts.push 之前');
  assert.equal(countOcc(fn, 'if(p.stockMax<0){'), 1, '最大硬闸恰 1 处');
  assert.equal(countOcc(fn, 'if(p.stockMin<0){'), 1, '最小硬闸恰 1 处');
  /* 反静默纠正：savePart 也不得 Math.abs / Math.max(0,…) 偷偷改数 */
  ['Math.abs(', 'Math.max(0,'].forEach(function (bad) {
    assert.equal(countOcc(fn, bad), 0, '不得静默纠正用户输入（命中 ' + bad + '）');
  });
});

/* ================================================================
   §B5 编辑存量负数记录（历史脏数据）
   ================================================================ */

function fixtureWithLegacy() {
  return partsFixture().concat([
    /* 历史脏数据：升级前存成负数的记录（口径：不回填、不迁移） */
    { id: 'LJ-900', name: '历史负数件', spec: '', model: '', unit: '个', stockMax: -5, stockMin: -2, stock: 7, used: 0 }
  ]);
}

test('B5a 编辑存量负数记录（只改名称）→ 被拦，且内存与"服务器"一字不动', async function () {
  const app = mkApp({ parts: fixtureWithLegacy() });
  try {
    const before = J(app, 'parts');
    await runSavePart(app, {
      id: 'LJ-900', name: '改过名字的历史件', spec: '', model: '', unit: '个', stockMax: '-5', stockMin: '-2'
    }, 3);
    const after = J(app, 'parts');
    assert.equal(after.length, 4, '数组长度不变');
    assert.equal(JSON.stringify(after[3]), JSON.stringify(before[3]),
      '被拦时该记录必须**一字不动**（含名称、上下限、库存）');
    assert.equal(app.recorder.txCount(), 0, '不得发事务（服务器端一个字节都没被写）');
    assert.equal(alertCount(app), 1, '恰好 1 条提示：' + alertText(app));
    assert.ok(alertText(app).indexOf('-5') >= 0, '提示带出当前值');
  } finally {
    app.dispose();
  }
});

test('B5b 提示文案自检：必须自带可执行正解，不能让用户以为「系统坏了不让我编辑」', async function () {
  const app = mkApp({ parts: fixtureWithLegacy() });
  try {
    await runSavePart(app, {
      id: 'LJ-900', name: 'x', spec: '', model: '', unit: '个', stockMax: '-5', stockMin: '0'
    }, 3);
    const msg = alertText(app);
    /* 用户看不到版本注释、看不到 PRD —— 提示必须自己说清「怎么改才能过」 */
    assert.ok(/请填写\s*0\s*或正整数/.test(msg), '必须给出正解「请填写 0 或正整数」，实际: ' + msg);
    assert.ok(msg.indexOf('不能为负数') >= 0, '必须说明「为什么被拦」');
    assert.ok(msg.indexOf('-5') >= 0, '必须回显当前值，用户才知道是哪个框');
    /* 反面自检：这些「系统坏了」式的文案不得出现 */
    ['系统错误', '内部错误', '请联系开发', '未知异常', '操作失败'].forEach(function (bad) {
      assert.equal(msg.indexOf(bad), -1, '不得出现让人误以为系统故障的文案：' + bad);
    });
  } finally {
    app.dispose();
  }
});

test('B5c 按提示把负数改成 0 → 同一条记录保存成功（不会把人锁死）', async function () {
  const app = mkApp({ parts: fixtureWithLegacy() });
  try {
    await runSavePart(app, {
      id: 'LJ-900', name: '改过名字的历史件', spec: '', model: '', unit: '个', stockMax: '0', stockMin: '0'
    }, 3);
    assert.equal(app.recorder.txCount(), 1, '改成合法值后必须能提交');
    assert.equal(alertCount(app), 0, '不得再拦');
    const rec = J(app, 'parts')[3];
    assert.equal(rec.name, '改过名字的历史件', '名称更新生效');
    assert.equal(rec.stockMax, 0, '存量负数被用户手工改成 0');
    assert.equal(rec.stockMin, 0, '存量负数被用户手工改成 0');
    assert.equal(rec.stock, 7, '库存必须原样保留（编辑不得重置库存）');
    assert.equal(app.run('parts.length'), 4, '长度不变（是编辑不是新增）');
  } finally {
    app.dispose();
  }
});

/* ================================================================
   §B6 存量小数库存（口径必然结果，不是缺陷）
   ================================================================ */

test('B6 存量 stock=10.5 → 入库 100 → 110.5（口径：只保证增量是整数，存量不收口，不四舍五入）', async function () {
  /* 口径说明（用户明确指示「存量数据不动」）：
       本次只收紧**入库入口**，绝不回填 / 迁移 / 四舍五入历史小数库存。
       故 10.5 + 100 = 110.5 —— 这是**当前口径的正确结果**，不是缺陷。
       若日后产品要求「一次入库顺手把存量规整成整数」，那是**另一个需求**，须用户明示后再做。 */
  const app = mkApp({ parts: partsFixture({ 0: { stock: 10.5 } }) });
  try {
    await runPartIn(app, { 0: '100' });
    assert.equal(app.run('parts[0].stock'), 110.5, '10.5 + 100 = 110.5（存量不收口）');
    assert.equal(app.recorder.txCount(), 1, '一次事务');
    const log = J(app, 'partLogs')[0];
    assert.equal(log.qty, 100, '增量必须是整数 100（新输入被守住）');
    assert.equal(log.stockBefore, 10.5, '台账前库存快照原样 10.5（不得被"美化"成 10 或 11）');
    assert.equal(log.stockAfter, 110.5, '台账后库存快照 110.5');
    /* 账实相符不变量在小数存量下依然成立 */
    assert.equal(log.stockBefore + log.qty, log.stockAfter, '账实相符：前 + 增量 = 后');
  } finally {
    app.dispose();
  }
});

test('B6b 小数存量 + 小数新输入 → 仍整批拦截（新入口严格，不受存量形态影响）', async function () {
  const app = mkApp({ parts: partsFixture({ 0: { stock: 10.5 } }) });
  try {
    await runPartIn(app, { 0: '0.5' });
    assert.equal(app.run('parts[0].stock'), 10.5, '存量小数不得被新输入污染成 11');
    assert.equal(app.recorder.txCount(), 0, '不得发事务');
    assert.ok(alertText(app).indexOf('必须是正整数') >= 0, '仍须报正整数：' + alertText(app));
  } finally {
    app.dispose();
  }
});

test('B6c 存量负数上下限不回填：无人编辑时 parts 原样保留 -5 / -2（不得自动订正）', function () {
  const app = mkApp({ parts: fixtureWithLegacy() });
  try {
    const rec = J(app, 'parts')[3];
    assert.equal(rec.stockMax, -5, '存量负数不得被自动改成 0');
    assert.equal(rec.stockMin, -2, '存量负数不得被自动改成 0');
    assert.equal(app.recorder.txCount(), 0, '装载即订正（迁移）是不可接受的：一次写盘都不该发生');
  } finally {
    app.dispose();
  }
});

/* ================================================================
   §B7 权限与锁不回归
   ================================================================ */

function confirmBtn(app) { return app.sandbox.document.getElementById('pi_confirm'); }

function assertUnlocked(app, ctx) {
  assert.equal(app.run('__piBusy'), false, '[' + ctx + '] __piBusy 必须已释放（否则入库按钮永久卡死）');
  const b = confirmBtn(app);
  assert.equal(b.disabled, false, '[' + ctx + '] 确认按钮必须恢复可点');
  assert.notEqual(b.innerHTML, '入库中…', '[' + ctx + '] 按钮文案必须还原');
}

test('B7a 被整数闸拒绝后：锁已释放、确认按钮可用、可直接重试（不是"卡死"）', async function () {
  const app = mkApp();
  try {
    const { dom } = await runPartIn(app, { 0: '0.5' });
    assertUnlocked(app, '整数闸拒绝后');
    assert.equal(app.run('parts[0].stock'), 10, '库存未变');
    /* 直接重试（不重开弹窗） */
    dom.set('pi_qty_0', '7');
    await app.run('doPartIn()');
    assertUnlocked(app, '重试成功后');
    assert.equal(app.run('parts[0].stock'), 17, '重试成功：10 + 7');
    assert.equal(app.recorder.txCount(), 1, '被拒那次没发事务，成功那次恰好 1 次');
  } finally {
    app.dispose();
  }
});

test('B7b 被上下限闸拒绝后同样不得卡锁：随后正常保存能成功', async function () {
  const app = mkApp();
  try {
    await runSavePart(app, withFields({ stockMax: '-5', stockMin: '5' }));
    assert.equal(app.run('parts.length'), 3, '被拦');
    await runSavePart(app, withFields({ stockMax: '0', stockMin: '5' }));
    assert.equal(app.run('parts.length'), 4, '改对后能保存');
    assert.equal(app.recorder.txCount(), 1, '只有成功那次发事务');
  } finally {
    app.dispose();
  }
});

test('B7c 只读账号：批量栏与列表页都看不到「入库」按钮，且 F12 直调也被函数级守卫拦下', async function () {
  const ro = mkApp({ currentUser: READONLY, lastRowIds: { parts: ['0', '1'] }, selRows: {} });
  try {
    const bar = ro.run("bulkBar('parts')");
    assert.equal(typeof bar, 'string');
    assert.ok(bar.indexOf('openPartIn()') < 0, '只读账号批量栏不得出现「入库」');
    assert.ok(bar.indexOf('partModal(') < 0, '只读账号批量栏不得出现「新增」');
    assert.ok(bar.indexOf('全选') >= 0, '只读账号仍应能全选');

    const html = ro.run('renderParts()');
    assert.ok(html.indexOf('onclick="openPartIn()"') < 0, '只读账号列表页不得渲染「入库」按钮');
    assert.ok(html.indexOf('onclick="partModal()"') < 0, '只读账号列表页不得渲染「新增零部件」');

    /* F12 绕过按钮：直调 openPartIn 必须被函数级守卫拦下，且不得建立批次 */
    ro.setGlobal('selRows', { parts: new Set(['0']) });
    installDom(ro, { pi_qty_0: '5' });
    await ro.run('openPartIn()');
    assert.equal(ro.run('__piIdxs'), null, '无写权限时不得建立入库批次');
    assert.ok(alertText(ro).indexOf('无该表单的编辑权限') >= 0, '必须明确提示权限不足：' + alertText(ro));
    await ro.run('doPartIn()');
    assert.equal(ro.run('parts[0].stock'), 10, '无权限时库存不得变动');
    assert.equal(ro.recorder.txCount(), 0, '无权限时不得发事务');
  } finally {
    ro.dispose();
  }

  /* 对照：管理员全都在 */
  const admin = mkApp({ lastRowIds: { parts: ['0', '1'] }, selRows: {} });
  try {
    const abar = admin.run("bulkBar('parts')");
    assert.ok(abar.indexOf('openPartIn()') >= 0, '管理员必须看到「入库」');
    assert.ok(abar.indexOf('partModal()') >= 0, '管理员必须看到「新增」');
    assert.ok(admin.run('renderParts()').indexOf('onclick="openPartIn()"') >= 0, '管理员列表页必须有「入库」');
  } finally {
    admin.dispose();
  }
});

test('B7d 有写权限但动作键被收掉（parts.partIn=false）：看得到「新增」但看不到「入库」', async function () {
  const writer = {
    username: 'qa_w', name: '写但无入库权', role: 'staff',
    perms: { parts: true, acts: { 'parts.partIn': false } }
  };
  const app = mkApp({ currentUser: writer, lastRowIds: { parts: ['0'] }, selRows: {} });
  try {
    const bar = app.run("bulkBar('parts')");
    assert.ok(bar.indexOf('partModal()') >= 0, '有 parts 写权限 → 「新增」可见');
    assert.ok(bar.indexOf('openPartIn()') < 0, '动作键 parts.partIn=false → 「入库」必须隐藏');
    /* 直调也被拦（按钮隐藏只是体验层） */
    app.setGlobal('selRows', { parts: new Set(['0']) });
    installDom(app, { pi_qty_0: '5' });
    await app.run('openPartIn()');
    assert.equal(app.run('__piIdxs'), null, '动作键不足时不得建立批次');
    assert.ok(alertText(app).indexOf('入库') >= 0, '必须提示缺「入库」按钮权限：' + alertText(app));
  } finally {
    app.dispose();
  }
});

/* ================================================================
   §D 版本水印锚点（本轮真实清单，防「第 10 处」被漏）
   ================================================================ */

test('D1 权威水印与三个产出入水口已推进到本次 BUILD', function () {
  assert.equal((INDEX_SRC.match(build.buildMarkRe(BUILD)) || []).length, 1, 'index.html 权威水印 `>build <BUILD><` 恰 1 处');
  assert.equal((INDEX_SRC.match(build.buildMarkRe(PREV)) || []).length, 0, 'index.html 不得残留上一版水印');
  assert.ok(README_SRC.indexOf('build ' + BUILD) >= 0, 'README.md 当前版本行');
  assert.ok(GUIDE_SRC.indexOf('更新：' + BUILD_DATE + '（build .' + BUILD_NO + '）') >= 0, 'guide.js 文首更新行');
  assert.equal(countOcc(GUIDE_SRC, 'build .' + PREV.split('.')[1]) , 0, 'guide.js 不得残留上一版短版本号');
});

test('D2 harness/build.js 的 BUILD/PREV 必须手写，不得从 index.html 反推', function () {
  assert.equal(countOcc(BUILD_SRC, "const BUILD = '" + BUILD + "';"), 1, 'BUILD 必须在 build.js 手写恰 1 处');
  assert.equal(countOcc(BUILD_SRC, "const PREV = '" + PREV + "';"), 1, 'PREV 必须在 build.js 手写恰 1 处');
  assert.equal(countOcc(BUILD_SRC, 'readFileSync'), 0, 'build.js 不得读 index.html 反推版本（会退化成恒真）');
});

/* ---------------- D3 的两个零件 ----------------
   ① 检测器：全形版本号 `YYYY-MM-DD.NNN`（先 stripComments —— 注释里提历史版本号无害，
      只有**代码里的**字面量才会在下一版变成「必红点」）。
   ② 白名单：**允许持有**字面量的 4 个文件 —— 它们的职责恰恰是反向防「测了个寂寞」，
      每版必须手改（这是「守卫」的正当成本）。 */
const VER_LIT_RE = /20\d\d-\d\d-\d\d\.\d+/g;
function versionsIn(src) { return (stripComments(src) || '').match(VER_LIT_RE) || []; }

const ANCHOR_HOLDERS = [
  'qa.ppshift-advance.independent.test.js',
  'qa.prodplan-query.independent.test.js',
  'layout.scoped.independent.test.js',
  'qa.parts-ledger.independent.test.js'
];

test('D3 版本字面量守卫：4 处已知副本必须已同步，其余 tests/*.test.js 一律**禁止持有**', function () {
  /* 立法本意（.159 QA 复核后按主理人裁决改写）：
       「凡**持有**硬编码副本的文件，副本必须与本版 BUILD/PREV 一致」
     —— 而不是「要求某个文件必须持有副本」。
     两者的区别很关键：`parts.159.test.js` / `parts.158.test.js` 一旦改成从 harness 派生，
     副本就不存在了，此时若还要求它们「必须有字面量」，等于**逼它们保留一个下一版必红点**，
     与「一劳永逸」直接互斥。故本条的形态是：
       ①  4 个已知持有者 —— 必须已同步（缺一处 → 下一版假失败）；
       ②  其余所有 tests/*.test.js —— **不得**出现当前 BUILD 或 PREV 的字面量（命中即红，
           直接把「下一版才红」的隐患提前到「今天提交前就红」）。
     历史/哨兵版本号（如 `2099-01-01.999`、`2026-10-06.135`）不受影响：它们不等于 BUILD/PREV，
     既不会被 ② 命中，也正是「反假自检」需要的固定样本。 */

  /* ---------- ① 4 处已知副本已同步 ---------- */
  assert.ok(PPSHIFT_SRC.indexOf("assert.equal(build.BUILD, '" + BUILD + "'") >= 0, '① qa.ppshift §E2 BUILD 未同步');
  assert.ok(PPSHIFT_SRC.indexOf("assert.equal(build.PREV, '" + PREV + "'") >= 0, '① qa.ppshift §E2 PREV 未同步');
  assert.ok(PRODPLAN_QUERY_SRC.indexOf("assert.equal(build.BUILD, '" + BUILD + "'") >= 0, '② qa.prodplan-query §E2 BUILD 未同步');
  assert.ok(PRODPLAN_QUERY_SRC.indexOf("assert.equal(build.PREV, '" + PREV + "'") >= 0, '② qa.prodplan-query §E2 PREV 未同步');
  assert.ok(PRODPLAN_QUERY_SRC.indexOf(BUILD_DATE + '（build .' + BUILD_NO + '）') >= 0, '② qa.prodplan-query §E4 guide 版本行未同步');
  assert.ok(LAYOUT_INDEP_SRC.indexOf('>build ' + String(BUILD).replace(/\./g, '\\.') + '<') >= 0, '③ layout §C5 水印正则未同步');
  assert.ok(LAYOUT_INDEP_SRC.indexOf("BUILD.BUILD, '" + BUILD + "'") >= 0, '③ layout §C5 BUILD 未同步');
  assert.ok(LAYOUT_INDEP_SRC.indexOf("BUILD.PREV, '" + PREV + "'") >= 0, '③ layout §C5 PREV 未同步');
  assert.ok(LEDGER_INDEP_SRC.indexOf("const BUILD = '" + BUILD + "'") >= 0, '④ qa.parts-ledger BUILD 未同步');
  assert.ok(LEDGER_INDEP_SRC.indexOf("const PREV = '" + PREV + "'") >= 0, '④ qa.parts-ledger PREV 未同步');
  /* 白名单自身也要「真的持有」—— 否则把 BUILD/PREV 换成派生后白名单会变成空转的豁免。
     只要求「两者都出现过」（layout §C5 会镜像多份，故不能比对出现次数）。 */
  ANCHOR_HOLDERS.forEach(function (f) {
    const held = versionsIn(readRel('tests/' + f));
    assert.ok(held.indexOf(BUILD) >= 0, '白名单文件 ' + f + ' 必须真的持有 BUILD 字面量（否则白名单名不副实）');
    assert.ok(held.indexOf(PREV) >= 0, '白名单文件 ' + f + ' 必须真的持有 PREV 字面量');
  });

  /* ---------- ② 其余测试文件禁止持有当前/上一版字面量 ---------- */
  const files = fs.readdirSync(path.join(ROOT, 'tests')).filter(function (f) { return /\.test\.js$/.test(f); });
  assert.ok(files.length >= 30, 'tests/*.test.js 扫描范围异常（实际 ' + files.length + ' 个）');
  const offenders = [];
  files.forEach(function (f) {
    if (ANCHOR_HOLDERS.indexOf(f) >= 0) return;
    const bad = versionsIn(readRel('tests/' + f)).filter(function (v) { return v === BUILD || v === PREV; });
    if (bad.length) offenders.push({ file: f, hits: bad });
  });
  assert.deepEqual(offenders, [],
    '以下测试文件硬编码了本版/上版字面量，请改用 harness.BUILD 动态拼（否则下一版必红）：' +
    JSON.stringify(offenders, null, 1));

  /* ---------- ③ 反假自检：判据必须能红、能白，否则上面的 offenders=[] 只是碰巧 ----------
     注意：这里用**运行期拼接**造样本（['2026-10-31','159'].join('.')），
     源码里因此不出现裸字面量 —— 否则本文件自己会被 ② 抓住（这正是 ② 有效的证明）。 */
  const FIX = [BUILD_DATE, BUILD_NO].join('.');
  assert.equal(FIX, BUILD, '拼接样本必须等于当前 BUILD（自检前置条件）');
  assert.deepEqual(versionsIn("assert.equal(build.BUILD, '" + FIX + "');").filter(function (v) { return v === BUILD; }),
    [BUILD], '反假自检①：检测器必须认出「被重新加回去」的字面量');
  assert.deepEqual(versionsIn('// 注释里的 ' + FIX + ' 无害'), [],
    '反假自检②：注释里的版本号必须被 stripComments 豁免（只有代码才算锚点）');
  assert.deepEqual(versionsIn("build.buildMarkRe('2099-01-01.999')").filter(function (v) { return v === BUILD || v === PREV; }),
    [], '反假自检③：2099-* 哨兵不得被误判为当前/上版锚点');
  /* 本文件自身也必须干净（它不在白名单里 —— 自我约束，不给自己开后门） */
  assert.deepEqual(versionsIn(readRel('tests/qa.parts-ledger.validate.159.test.js'))
    .filter(function (v) { return v === BUILD || v === PREV; }), [],
    '本文件自身不得硬编码版本字面量（它只引用 harness 单一来源）');
});

test('D4 harness/build.js 的「副本清单」注释必须与实际一致（注释是给人看的，错了会误导下一版）', function () {
  /* 本轮真实清单 = 4 处**手改**副本 + 1 条「per-version 用例必须派生」的规则。
     本条钉两件事：① 4 处手改副本必须被点名；② 必须写明 per-version 的派生规则
     （否则下一个人看到 `parts.159.test.js` 里没有字面量，会以为「清单漏了」，又把它抄回去）。 */
  const comments = BUILD_SRC.slice(0, BUILD_SRC.indexOf('const BUILD ='));
  ['qa.ppshift-advance.independent.test.js',
    'qa.prodplan-query.independent.test.js',
    'layout.scoped.independent.test.js',
    'qa.parts-ledger.independent.test.js'].forEach(function (name) {
    assert.ok(comments.indexOf(name) >= 0,
      'build.js 版本推进纪律的副本清单必须点名 ' + name + '（漏了它，按清单同步完仍然会 FAIL）');
  });
  assert.ok(comments.indexOf('parts.') >= 0 && comments.indexOf('派生') >= 0,
    '注释必须写明「parts.<NNN>.test.js 这类 per-version 用例一律派生、不再手抄字面量」的规则');
  /* 反向自检：清单里不得再出现已废弃的「仅 N 处」绝对计数（.148 就是被这个坑到） */
  assert.equal(/另有\s*\d+\s*处硬编码/.test(comments), false,
    '副本总数会随新增文件变化，注释里不要再写「另有 N 处」这种绝对计数（.148 已因此假失败过一次）');
});

/* ================================================================
   §C 变异注入：删掉/改坏硬闸，§B 的探针必须变红（命中数 ≠ 1 直接抛错）
   ================================================================ */

/** 单点替换：命中数必须恰 1，否则抛错（严禁静默通过） */
function applyMutation(src, from, to, label) {
  const n = countOcc(src, from);
  if (n !== 1) throw new Error('[变异注入失败] ' + label + '：目标片段命中 ' + n + ' 处（必须恰 1 处）');
  const i = src.indexOf(from);
  const out = src.slice(0, i) + to + src.slice(i + from.length);
  if (out === src) throw new Error('[变异注入失败] ' + label + '：源码未发生变化');
  return out;
}

/* 变异锚点（逐字取自 index.html，命中数已在用例里二次核对） */
const GATE_INT_FROM = "if(!Number.isInteger(q)){alert('入库数量必须是正整数（第 '+(k+1)+' 行为「'+raw+'」），本次入库未提交（所有零件库存均未变动）。');return;}";
const GATE_MAX_BLOCK = "  if(p.stockMax<0){\n" +
  "    alert('最大库存量不能为负数（当前「'+String(elv('stockMax')).trim()+'」），请填写 0 或正整数。');\n" +
  "    return;\n" +
  "  }\n";
const GATE_MIN_BLOCK = "  if(p.stockMin<0){\n" +
  "    alert('最小库存量不能为负数（当前「'+String(elv('stockMin')).trim()+'」），请填写 0 或正整数。');\n" +
  "    return;\n" +
  "  }\n";

test('C0 变异锚点自检：三个锚点在当前源码里各命中恰 1 处（否则下面的注入会抛错而不是静默通过）', function () {
  assert.equal(countOcc(INDEX_SRC, GATE_INT_FROM), 1, '整数闸锚点必须恰 1 处');
  assert.equal(countOcc(INDEX_SRC, GATE_MAX_BLOCK), 1, '最大库存量硬闸锚点必须恰 1 处');
  assert.equal(countOcc(INDEX_SRC, GATE_MIN_BLOCK), 1, '最小库存量硬闸锚点必须恰 1 处');
  /* 变异基础设施自检：命中 0 处 / 2 处都必须抛错 */
  assert.throws(function () { applyMutation(INDEX_SRC, 'const 不存在的片段=1;', '', 'C0 不存在'); }, /命中 0 处/);
  assert.throws(function () { applyMutation('aa', 'a', 'b', 'C0 多处'); }, /命中 2 处/);
});

test('C1 删掉整数闸（:3042 Number.isInteger 整行）→ B1a 与 B2a 必须红', async function () {
  const mutant = applyMutation(INDEX_SRC, GATE_INT_FROM, 'void 0;', 'C1 删整数闸');
  /* ① 注入生效：0.5 被静默入库（内存 10 → 10.5），且不发事务 → 正是要防的「账实不符」 */
  const probe = mkApp({}, { indexHtml: mutant });
  try {
    await runPartIn(probe, { 0: '0.5' });
    assert.equal(probe.run('parts[0].stock'), 10.5, '变异后 0.5 必须被入库（证明注入生效）');
    assert.equal(probe.recorder.txCount(), 1, '变异后反而会写盘');
  } finally {
    probe.dispose();
  }
  /* ② §B1 探针必须红 */
  await assert.rejects(function () { return probeIntegerGate(mutant); },
    'B1 探针在整数闸被删后必须报红');
  /* ③ §B2 探针必须红 */
  await assert.rejects(function () { return probeWholeBatchRejects(mutant); },
    'B2 探针在整数闸被删后必须报红');
});

test('C2 删掉 stockMax<0 拦截 → B4a 必须红', async function () {
  const mutant = applyMutation(INDEX_SRC, GATE_MAX_BLOCK, '', 'C2 删最大库存量硬闸');
  /* ① 注入生效：负数被接受并落库 */
  const probe = mkApp({}, { indexHtml: mutant });
  try {
    await runSavePart(probe, { id: 'LJ-100', name: '新零件', unit: '个', stockMax: '-5', stockMin: '5' });
    assert.equal(probe.run('parts.length'), 4, '变异后 -5 必须被接受（证明注入生效）');
    assert.equal(J(probe, 'parts')[3].stockMax, -5, '变异后负数原样落库');
  } finally {
    probe.dispose();
  }
  /* ② §B4a 等价探针必须红 */
  await assert.rejects(async function () {
    const a = mkApp({}, { indexHtml: mutant });
    try {
      await runSavePart(a, withFields({ stockMax: '-5', stockMin: '5' }));
      assert.equal(a.run('parts.length'), 3, 'B4a：parts 长度必须不变');
    } finally { a.dispose(); }
  }, /B4a|Expected values|parts 长度/, 'B4a 探针在最大硬闸被删后必须报红');
});

test('C3 删掉 stockMin<0 拦截 → B4b 必须红', async function () {
  const mutant = applyMutation(INDEX_SRC, GATE_MIN_BLOCK, '', 'C3 删最小库存量硬闸');
  /* ① 注入生效 */
  const probe = mkApp({}, { indexHtml: mutant });
  try {
    await runSavePart(probe, { id: 'LJ-101', name: '新零件', unit: '个', stockMax: '100', stockMin: '-1' });
    assert.equal(probe.run('parts.length'), 4, '变异后 -1 必须被接受（证明注入生效）');
    assert.equal(J(probe, 'parts')[3].stockMin, -1, '变异后负数原样落库');
  } finally {
    probe.dispose();
  }
  /* ② §B4b 等价探针必须红（且必须红在「最小」这条，不是被最大硬闸顺带拦住） */
  await assert.rejects(async function () {
    const a = mkApp({}, { indexHtml: mutant });
    try {
      await runSavePart(a, withFields({ stockMax: '100', stockMin: '-1' }));
      assert.equal(a.recorder.txCount(), 0, 'B4b：最小库存量 -1 不得发事务');
    } finally { a.dispose(); }
  }, /B4b|Expected values|不得发事务/, 'B4b 探针在最小硬闸被删后必须报红');
});

test('C4 把整数闸改成 Math.round(q)（静默纠正）→ B1a 必须红（证明「禁静默改数」被守住）', async function () {
  /* 单靠替换闸门无法写 `q=Math.round(q)`（q 是 const），故注入分两步：
       a) const q → let q； b) 闸门 → q=Math.round(q)。两步都走 applyMutation（命中数守卫仍在）。 */
  let mutant = applyMutation(INDEX_SRC, 'const q=Number(raw);', 'let q=Number(raw);', 'C4a const→let');
  mutant = applyMutation(mutant, GATE_INT_FROM, 'q=Math.round(q);', 'C4b 闸门→静默取整');

  /* ① 注入生效：0.5 被**静默**四舍五入成 1 件入库，且一条提示都没有（这正是最危险的形态） */
  const probe = mkApp({}, { indexHtml: mutant });
  try {
    await runPartIn(probe, { 0: '0.5' });
    assert.equal(probe.run('parts[0].stock'), 11, '变异后 0.5 被静默取整成 1 件（10 → 11，证明注入生效）');
    assert.equal(alertCount(probe), 0, '变异后完全静默 —— 用户无从察觉，账实从此对不上');
  } finally {
    probe.dispose();
  }
  /* ② §B1 探针必须红（期望库存 10、期望有提示，两侧都不成立） */
  await assert.rejects(function () { return probeIntegerGate(mutant); },
    'B1 探针在「静默取整」变异下必须报红');
  /* ③ §B2 探针同样必须红（0.5 被吞掉 → 100 与 50 会被部分入库） */
  await assert.rejects(function () { return probeWholeBatchRejects(mutant); },
    'B2 探针在「静默取整」变异下必须报红');
});

/* ================================================================
   §E 注释与体验层在位（不做实现细节的过度绑定，只钉用户可见承诺）
   ================================================================ */

test('E1 体验层：入库输入框 title + 列头写明「正整数·件」；上下限两字段备注写明「不得为负数」', function () {
  const fn = INDEX_SRC;
  assert.ok(fn.indexOf('仅限正整数（件）') >= 0, '入库输入框/列头必须有「仅限正整数（件）」的可见说明');
  assert.ok(fn.indexOf('本次入库数量（正整数·件）') >= 0, '列头必须写明「本次入库数量（正整数·件）」');
  assert.ok(countOcc(fn, '不得为负数（0 = 不设限制）') === 2,
    '最大 / 最小库存量两个字段的备注都必须写明「不得为负数（0 = 不设限制）」（实际 ' +
    countOcc(fn, '不得为负数（0 = 不设限制）') + ' 处）');
});

test('E2 guide.js：两条新口径都在，且用「build .NNN」短形态（正文不写完整版本号）', function () {
  assert.ok(GUIDE_SRC.indexOf('入库数量仅限正整数（件）') >= 0, 'guide 必须有「入库数量仅限正整数（件）」条目');
  assert.ok(GUIDE_SRC.indexOf('最大 / 最小库存量不得为负数') >= 0, 'guide 必须有「最大 / 最小库存量不得为负数」条目');
  assert.ok(GUIDE_SRC.indexOf('不回填、不迁移') >= 0, 'guide 必须写明存量数据不回填/不迁移（用户最关心的点）');
  assert.equal(countOcc(GUIDE_SRC, BUILD), 0, 'guide 正文不得写完整版本号 ' + BUILD + '（只许短形态 build .' + BUILD_NO + '）');
});
