'use strict';
/* ================================================================
   tests/parts.158.test.js
   —— 零部件数据 + 零部件台账（用户 2026-10-31 需求，build .158）
   ================================================================
   需求（用户原话 + 已确认口径）：
     R1 菜单新增「零部件数据」列表，界面/操作键仿产品主数据（全选/编辑/复制/删除/新增/导出选中/入库）
     R2 字段 11 列：编码/名称/规格/型号/单位/最大库存量/最小库存量/库存/已占用/结余/结余进度
     R3 「编码、名称、单位」必填；编码唯一，且**不得与产品主数据编码重复**（用户确认"不能"）
     R4 结余 = 库存 − 已占用；库存/已占用/结余/结余进度**不可编辑**
     R5 结余进度分母 = **最大库存量**（数据来源：最大库存量 / 最小库存量 / 结余）
     R6 「入库」：勾选明细行 → 填数量 → 累加库存；**本期「已占用」恒 0**（预留字段）
     R7 用户第 1 条选择「**要**记录入库流水」→ 另起「零部件台账」只读页（仿调拨台账）
   ----------------------------------------------------------------
   覆盖结构：
     §A 公式单源           partBalanceOf 全工程唯一 / partBalPctOf 分母=最大库存量 / 4 档配色
     §B 编码唯一           内部重复拒 / 跨表（与产品）重复拒 / 编辑自身不误判 / 库存已占用原样保留
     §C 入库               正常累加 + 台账 4 字段 + 一次 tx / 非法整批拒（库存不变）/ 全空提示 / 失败不清勾选
     §D 拖拽顺序键         uiDefaults.order.parts 与 product 互不污染 / 引擎按 data-pdform 取表单
     §E 静态守卫           NAV / renderContent / 权限注册 / XLSX_SHEETS 不受影响 / 台账 12 列 + colspan 同步
     §F 文档与台账口径     guide.js 两个小节 + 文首；台账类型映射 PARTLOG_TYPE_LABEL
   ================================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createApp, ROOT } = require('./harness/sandbox');
const build = require('./harness/build');

const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const GUIDE_SRC = fs.readFileSync(path.join(ROOT, 'js', 'guide.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');
const JS_FILES = ['logs.js', 'import.js', 'transfer.js', 'guide.js', 'prodplan-core.js'];

const ADMIN = { username: 'pmc', name: 'PMC小张', role: 'admin', perms: {} };

/* 【build .164】需要读生产后端的权限元数据 PERM_META（index.html 里的 PERM_FORMS 已随
   「员工管理」迁到管理员后台而删除）。照 tests/server.canwrite.test.js 的做法：先把数据/
   用户文件路径指向仓库内临时目录，再 require —— 不读不写真实的 server/data.json · users.json。 */
const SRV_TMP = fs.mkdtempSync(path.join(ROOT, '.p1tmp-'));
process.env.PROD_DATA_FILE = path.join(SRV_TMP, 'data.json');
process.env.PROD_USERS_FILE = path.join(SRV_TMP, 'users.json');
fs.writeFileSync(process.env.PROD_USERS_FILE, JSON.stringify([
  { username: 'admin', name: '管理员', role: 'admin', status: 'active', salt: 's0', hash: 'h0', perms: {} }
]));
const srv = require(path.join(ROOT, 'server', 'server.js'));
test.after(function () { fs.rmSync(SRV_TMP, { recursive: true, force: true }); });

/* ---------------- 源码工具 ---------------- */
function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}
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
function countOf(src, needle) {
  let n = 0;
  let i = 0;
  for (;;) {
    const k = src.indexOf(needle, i);
    if (k < 0) return n;
    n++;
    i = k + needle.length;
  }
}

/* ---------------- 沙箱装配 ---------------- */
function fixtureParts() {
  return [
    { id: 'LJ-001', name: '螺钉', spec: 'M4×10', model: 'GB/T845', unit: '个', stockMax: 1000, stockMin: 100, stock: 200, used: 0 },
    { id: 'LJ-002', name: '外壳', spec: '白色', model: 'CW-A', unit: '个', stockMax: 0, stockMin: 0, stock: 0, used: 0 }
  ];
}

/* 让 getElementById 返回可读写的假元素（仅用于测 form 读取与弹窗 HTML 组装）。
   el 按 id 记忆（同一 id 多次取到同一对象），value 走 getter 直连 inputs → 测试可随时改输入。 */
function stubDom(app, values) {
  const inputs = Object.assign({}, values || {});
  const cache = {};
  app.sandbox.document.getElementById = function (id) {
    if (cache[id]) return cache[id];
    const el = {
      id: id,
      innerHTML: '',
      style: {},
      dataset: {},
      classList: { add: function () {}, remove: function () {}, contains: function () { return false; }, toggle: function () {} },
      setAttribute: function () {}, getAttribute: function () { return null; },
      appendChild: function () {}, remove: function () {},
      querySelector: function () { return null; }, querySelectorAll: function () { return []; },
      addEventListener: function () {}, closest: function () { return null; }
    };
    Object.defineProperty(el, 'value', {
      get: function () { return inputs[id] !== undefined ? String(inputs[id]) : ''; },
      set: function (v) { inputs[id] = v; },
      configurable: true
    });
    cache[id] = el;
    return el;
  };
  return { inputs: inputs, els: cache };
}

function mkApp(seed) {
  const counters = { renderContent: 0 };
  const app = createApp({ installRecorder: true });
  app.counters = counters;
  app.setGlobals(Object.assign(
    {
      currentUser: ADMIN,
      products: [{ id: 'P1', name: '甲产品', spec: '', model: '', unit: '台', stock: 5, status: '启用' }],
      parts: fixtureParts(),
      partLogs: [],
      orders: [],
      deliveries: [],
      productionPlans: [],
      productionReports: [],
      processTemplates: [],
      transfers: [],
      logs: [],
      fields: { product: [], order: [] },
      fieldsAudit: 'audited',
      fieldsDraft: null,
      meta: { seq: 1, seeded: true },
      tblLayout: {},
      uiDefaults: { order: {} },
      selRows: {},
      renderContent: function () { counters.renderContent++; },
      renderAll: function () {}
    },
    seed || {}
  ));
  return app;
}
function J(app, expr) { return JSON.parse(app.run('JSON.stringify(' + expr + ')')); }

/* ================================================================
   §A 公式单源
   ================================================================ */

test('A1 结余公式全工程唯一：stock 减 used 的减法只允许出现在 partBalanceOf 内部', function () {
  /* 口径：`num(x.stock) - num(x.used)` 这类形态必须**恰好 1 处**（唯一公式点）。
     任何地方再写一份（哪怕结果相同）都会在口径演进时先漂移——.139 的「已计划未交付/结余」
     就是这么爆的，故这里用源码断言钉死。 */
  const re = /num\([^()]*\.stock\)\s*-\s*num\([^()]*\.used\)/g;
  const hits = [];
  const scan = function (name, src) {
    const code = stripComments(src);
    const m = code.match(re) || [];
    m.forEach(function (x) { hits.push({ file: name, text: x }); });
  };
  scan('index.html', INDEX_SRC);
  JS_FILES.forEach(function (f) { scan('js/' + f, fs.readFileSync(path.join(ROOT, 'js', f), 'utf8')); });
  assert.equal(hits.length, 1, '减法形态必须恰 1 处，实际: ' + JSON.stringify(hits));

  const fn = stripComments(extractFn(INDEX_SRC, 'partBalanceOf'));
  assert.ok(/num\(p&&p\.stock\)-num\(p&&p\.used\)/.test(fn), '唯一那处必须落在 partBalanceOf 内');
  assert.ok(hits[0].file === 'index.html', '唯一实现应在 index.html');
});

test('A2 partBalanceOf 语义：数字/字符串/空值一律按 num() 口径，缺字段不炸', function () {
  const app = mkApp();
  assert.equal(app.run('partBalanceOf({stock:10,used:3})'), 7);
  assert.equal(app.run('partBalanceOf({stock:"10",used:"3"})'), 7, '字符串数字应被 num() 规范化');
  assert.equal(app.run('partBalanceOf({stock:10})'), 10, 'used 缺省 → 0');
  assert.equal(app.run('partBalanceOf({})'), 0);
  assert.equal(app.run('partBalanceOf(null)'), 0, 'null 不得抛错');
  assert.equal(app.run('partBalanceOf({stock:0,used:5})'), -5, '负结余必须算出来（不钳制）');
  app.dispose();
});

test('A3 partBalPctOf：分母 = 最大库存量；0/空 → 0；可 >100%；负结余为负百分比', function () {
  const app = mkApp();
  assert.equal(app.run('partBalPctOf({stock:150,used:0,stockMax:200})'), 75, '150/200');
  assert.equal(app.run('partBalPctOf({stock:300,used:0,stockMax:200})'), 150, '可 >100%');
  assert.equal(app.run('partBalPctOf({stock:5,used:0,stockMax:0})'), 0, '最大库存量 0 → 0（不除零）');
  assert.equal(app.run('partBalPctOf({stock:5,used:0,stockMax:""})'), 0, '最大库存量空 → 0');
  assert.equal(app.run('partBalPctOf({stock:5,used:0})'), 0, '最大库存量缺省 → 0');
  assert.equal(app.run('partBalPctOf({stock:10,used:60,stockMax:100})'), -50, '负结余 → 负百分比（供进度条取绝对值绘制）');
  app.dispose();
});

test('A4 结余 4 档配色复用 invStockLevel；进度条 DOM 结构照抄库存管理页', function () {
  const app = mkApp();
  /* 结余作为「数量」传入 invStockLevel（红 <0 / 黄 <最小 / 绿 正常 / 灰 >最大） */
  assert.equal(app.run("invStockLevel(-1,100,1000)"), 'red');
  assert.equal(app.run("invStockLevel(50,100,1000)"), 'amber');
  assert.equal(app.run("invStockLevel(200,100,1000)"), 'green');
  assert.equal(app.run("invStockLevel(2000,100,1000)"), 'gray');
  app.dispose();

  const rp = stripComments(extractFn(INDEX_SRC, 'renderParts'));
  assert.match(rp, /invStockLevel\(v,p\.stockMin,p\.stockMax\)/, '结余列按 4 档判定');
  assert.match(rp, /class="progress-wrap"/, '进度条容器');
  assert.match(rp, /class="progress-bar" style="width:'\+Math\.abs\(v\)\+'%/, '宽度取绝对值（负结余也画得出来）');
  assert.match(rp, /font-size:11px/, '11px 百分比文字（与库存管理页同款）');
});

/* ================================================================
   §B 编码唯一（内部 + 跨表）
   ================================================================ */

test('B1 必填校验：编码/名称/单位 缺一即拒，且不落库', function () {
  const app = mkApp();
  stubDom(app, { pj_id: '', pj_name: '甲', pj_unit: '个' });
  return app.run('savePart(-1)').then(function () {
    assert.ok(app.alerts.some(function (a) { return a.indexOf('编码') >= 0; }), '应提示编码必填');
    assert.equal(app.run('parts.length'), 2, '数据不得变化');
    app.dispose();
  });
});

test('B2 零部件内部编码重复 → 拒绝（新增）', function () {
  const app = mkApp();
  stubDom(app, { pj_id: 'LJ-001', pj_name: '重复件', pj_unit: '个' });
  return app.run('savePart(-1)').then(function () {
    assert.ok(app.alerts.some(function (a) { return a.indexOf('已存在') >= 0; }), '应提示编码已存在');
    assert.equal(app.run('parts.length'), 2);
    assert.equal(app.recorder.txCount(), 0, '被拒时不得发起事务');
    app.dispose();
  });
});

test('B3 与产品主数据编码重复 → 拒绝（用户确认"不能"撞名）', function () {
  const app = mkApp();
  stubDom(app, { pj_id: 'P1', pj_name: '撞名件', pj_unit: '个' });
  return app.run('savePart(-1)').then(function () {
    assert.ok(app.alerts.some(function (a) { return a.indexOf('已被产品主数据使用') >= 0; }), '必须是跨表查重的专用文案');
    assert.ok(app.alerts.some(function (a) { return a.indexOf('不能与产品编码重复') >= 0; }));
    assert.equal(app.run('parts.length'), 2, '数据不得变化');
    assert.equal(app.recorder.txCount(), 0);
    app.dispose();
  });
});

test('B4 编辑自身不误判重复；库存/已占用原样保留（不可手工改）', function () {
  const app = mkApp();
  app.setGlobals({ selRows: {} });
  stubDom(app, { pj_id: 'LJ-001', pj_name: '螺钉改名', pj_spec: 'M5', pj_model: 'X', pj_unit: '个', pj_stockMax: '2000', pj_stockMin: '50', pj_stock: '9999', pj_used: '8888' });
  return app.run('savePart(0)').then(function () {
    assert.equal(app.alerts.length, 0, '编辑自身不应被判重复: ' + JSON.stringify(app.alerts));
    const p = J(app, 'parts[0]');
    assert.equal(p.name, '螺钉改名');
    assert.equal(p.stockMax, 2000);
    assert.equal(p.stock, 200, '库存不得被弹窗输入覆盖（只由入库驱动）');
    assert.equal(p.used, 0, '已占用不得被手工改（本期恒 0 的预留字段）');
    assert.equal(app.recorder.txCount(), 1, '保存 = 一次事务');
    /* 跨 realm 数组原型不同，deepStrictEqual 会误报 → 统一用 JSON 比较 */
    assert.equal(JSON.stringify(app.recorder.lastTx().keys), '["parts","logs"]', '事务只含 parts + logs');
    app.dispose();
  });
});

/* ================================================================
   §C 入库
   ================================================================ */

test('C1 入库正常：累加库存 + 台账 4 字段 + 一次 tx（parts/partLogs/logs）', function () {
  const app = mkApp();
  stubDom(app, { pi_qty_0: '100', pi_qty_1: '5' });
  app.setGlobal('__piIdxs', [0, 1]);
  return app.run('doPartIn()').then(function () {
    const parts = J(app, 'parts');
    assert.equal(parts[0].stock, 300, '200 + 100');
    assert.equal(parts[1].stock, 5, '0 + 5');
    const logs = J(app, 'partLogs');
    assert.equal(logs.length, 2, '每个入库零件一条流水');
    const l0 = logs.find(function (x) { return x.partId === 'LJ-001'; });
    assert.equal(l0.type, 'in', '类型 in');
    assert.equal(l0.qty, 100);
    assert.equal(l0.stockBefore, 200, '入库前库存快照');
    assert.equal(l0.stockAfter, 300, '入库后库存快照');
    assert.equal(l0.user, 'PMC小张', '操作人取当前登录用户（与调拨台账同源：姓名优先）');
    assert.match(l0.id, /^PTH-\d{8}-\d{5}$/, '编号 PTH-YYYYMMDD-XXXXX');
    assert.equal(l0.unit, '个');
    /* 同批两条不得重号 */
    assert.notEqual(logs[0].id, logs[1].id, '同批编号必须互不相同');
    assert.equal(app.recorder.txCount(), 1, '一次原子提交');
    assert.equal(JSON.stringify(app.recorder.lastTx().keys), '["parts","partLogs","logs"]', '一次 tx 覆盖 parts + partLogs + logs');
    assert.equal(app.run("selSet('parts').size"), 0, '成功后清空勾选');
    assert.equal(app.counters.renderContent, 1, '成功后重绘一次');
    app.dispose();
  });
});

test('C2 非法数量整批拒绝：库存/台账一字不改、不发事务（禁止部分提交）', function () {
  const app = mkApp();
  stubDom(app, { pi_qty_0: '100', pi_qty_1: '-3' });
  app.setGlobal('__piIdxs', [0, 1]);
  return app.run('doPartIn()').then(function () {
    assert.ok(app.alerts.some(function (a) { return a.indexOf('不能为负数') >= 0; }), '应提示负数非法');
    const parts = J(app, 'parts');
    assert.equal(parts[0].stock, 200, '合法行也不得被写入（整批拒绝）');
    assert.equal(parts[1].stock, 0);
    assert.equal(J(app, 'partLogs').length, 0, '不得产生半条流水');
    assert.equal(app.recorder.txCount(), 0, '不得发起事务');
    app.dispose();
  });
});

test('C3 全部留空/填 0 → 提示「请至少填写一个」，不改数据', function () {
  const app = mkApp();
  stubDom(app, { pi_qty_0: '', pi_qty_1: '0' });
  app.setGlobal('__piIdxs', [0, 1]);
  return app.run('doPartIn()').then(function () {
    assert.ok(app.alerts.some(function (a) { return a.indexOf('请至少填写一个入库数量') >= 0; }));
    assert.equal(J(app, 'parts')[0].stock, 200);
    assert.equal(app.recorder.txCount(), 0);
    app.dispose();
  });
});

test('C4 事务失败：不清勾选、不渲染成成功态（由 DB.tx 约定回灌服务器真值）', function () {
  const app = mkApp();
  app.setGlobal('selRows', { parts: new Set(['0']) });
  stubDom(app, { pi_qty_0: '50' });
  app.setGlobal('__piIdxs', [0]);
  app.recorder.failNext('tx', 'boom');
  return app.run('doPartIn()').then(function () {
    assert.equal(app.recorder.txCount(), 1, '确实尝试了事务');
    assert.equal(app.run("selSet('parts').size"), 1, '失败不得清勾选（用户可原样重试）');
    assert.equal(app.counters.renderContent, 0, '失败不得渲染成成功态');
    app.dispose();
  });
});

test('C13 提交重入锁：同一 tick 连续两次 doPartIn 只发 1 次事务、库存与台账只累加一次', function () {
  /* 缺陷背景（QA 实测）：确认按钮双击 → 同一 tick 发两次 /api/tx；第二次被服务端乐观锁 409 拦下，
     库存不会翻倍（安全），但会弹出「数据已被他人修改」这条**误导性**提示——实际是用户自己点了两下。
     修复=模块级 `__piBusy` 锁：第二次进入即 return。 */
  const app = mkApp();
  const dom = stubDom(app, { pi_qty_0: '100' });
  app.setGlobal('__piIdxs', [0]);
  const p1 = app.run('doPartIn()');
  const p2 = app.run('doPartIn()');   /* 第一次的 await 还未返回 */
  return Promise.all([p1, p2]).then(function () {
    assert.equal(app.recorder.txCount(), 1, '双击只允许 1 次 /api/tx');
    assert.equal(J(app, 'parts')[0].stock, 300, '库存只累加一次（200 + 100）');
    assert.equal(J(app, 'partLogs').length, 1, '台账只增 1 条流水');
    assert.equal(app.counters.renderContent, 1, '只重绘一次');
    assert.equal(app.alerts.length, 0, '第二次被前端锁静默忽略，不得有任何提示: ' + JSON.stringify(app.alerts));
    assert.equal(app.run('__piBusy'), false, '结束后必须是解锁态');
    /* DOM 层（体验层）：确认按钮必须恢复可点、文案还原「入库中…」以外的原文 */
    const b = dom.els['pi_confirm'];
    assert.equal(b.disabled, false, '结束时确认按钮必须恢复可点');
    assert.notEqual(b.innerHTML, '入库中…', '结束时按钮文案必须还原');
    app.dispose();
  });
});

test('C14 反向守卫：事务失败后 finally 已解锁 → 再次调用能正常提交（按钮不会被锁死）', function () {
  /* 这条比 C13 更重要的原因：锁若漏释放，入库按钮会**永久卡死**（比原缺陷更糟）。
     故专门验证「失败 → 解锁 → 可重试」。 */
  const app = mkApp();
  const dom = stubDom(app, { pi_qty_0: '50' });
  app.setGlobal('selRows', { parts: new Set(['0']) });
  app.setGlobal('__piIdxs', [0]);
  app.recorder.failNext('tx', 'boom');
  return app.run('doPartIn()').then(function () {
    assert.equal(app.recorder.txCount(), 1, '第一次确实尝试了提交');
    assert.equal(app.run('__piBusy'), false, '失败路径必须解锁（finally 覆盖出口⑥）');
    assert.equal(dom.els['pi_confirm'].disabled, false, '失败路径也必须把确认按钮恢复可点');
    assert.notEqual(dom.els['pi_confirm'].innerHTML, '入库中…', '失败路径也必须还原按钮文案');
    assert.equal(app.run("selSet('parts').size"), 1, '失败不清勾选');
    assert.equal(app.counters.renderContent, 0, '失败不渲染成成功态');
    /* 生产 DB.tx 失败会 rehydrate 回服务器真值（recorder 不模拟这一步）→ 这里手动回灌再重试 */
    app.setGlobal('parts', fixtureParts());
    app.setGlobal('partLogs', []);
    return app.run('doPartIn()');
  }).then(function () {
    assert.equal(app.recorder.txCount(), 2, '第二次点击必须能真正提交（证明锁已释放、按钮没卡死）');
    assert.equal(J(app, 'parts')[0].stock, 250, '重试只加一次（200 + 50），不翻倍');
    assert.equal(J(app, 'partLogs').length, 1, '重试后台账仍只有 1 条');
    assert.equal(app.run('__piBusy'), false, '第二次结束后同样是解锁态');
    assert.equal(dom.els['pi_confirm'].disabled, false, '第二次结束后按钮同样可点');
    app.dispose();
  });
});

test('C15 六条早退路径逐条都必须解锁（行为式；锁只能在 finally 释放，漏一条按钮就永久卡死）', function () {
  const caseRun = function (opts) {
    const app = mkApp();
    const dom = stubDom(app, opts.qty != null ? { pi_qty_0: opts.qty } : {});
    app.setGlobal('__piIdxs', opts.idxs);
    if (opts.noPerm) app.setGlobal('currentUser', { username: 'u', name: '员工', role: 'staff', perms: {} });
    if (opts.failTx) app.recorder.failNext('tx', 'boom');
    return app.run('doPartIn()').then(function () {
      const btn = dom.els['pi_confirm'];
      const out = { busy: app.run('__piBusy'), stock: app.run('parts[0].stock'), tx: app.recorder.txCount(),
        disabled: btn ? btn.disabled : false, label: btn ? btn.innerHTML : '' };
      app.dispose();
      return out;
    });
  };
  /* 每条路径统一断言：锁已释放 + 确认按钮已恢复可点 + 文案不是「入库中…」 */
  const check = function (r, label) {
    assert.equal(r.busy, false, '[' + label + '] __piBusy 必须已释放（否则入库按钮永久卡死）');
    assert.equal(r.disabled, false, '[' + label + '] 确认按钮必须恢复可点');
    assert.notEqual(r.label, '入库中…', '[' + label + '] 按钮文案必须还原');
  };
  return caseRun({ idxs: null }).then(function (r) {
    check(r, '①无进行中批次');
    return caseRun({ idxs: [0], qty: '10', noPerm: true });
  }).then(function (r) {
    check(r, '②无写权限');
    assert.equal(r.stock, 200, '②无权限不得动库存');
    assert.equal(r.tx, 0, '②无权限不得发事务');
    return caseRun({ idxs: [0], qty: 'abc' });
  }).then(function (r) {
    check(r, '③非数字');
    assert.equal(r.stock, 200, '③非数字不得动库存');
    return caseRun({ idxs: [0], qty: '-5' });
  }).then(function (r) {
    check(r, '④负数');
    assert.equal(r.stock, 200, '④负数不得动库存');
    return caseRun({ idxs: [0], qty: '' });
  }).then(function (r) {
    check(r, '⑤全部留空');
    assert.equal(r.stock, 200, '⑤留空不得动库存');
    return caseRun({ idxs: [0], qty: '10', failTx: true });
  }).then(function (r) {
    check(r, '⑥事务失败');
    assert.equal(r.tx, 1, '⑥确实尝试过提交');
    /* 静态兜底：解锁必须写在 finally 里，且 doPartIn 内只有这一处解锁点 */
    const body = stripComments(extractFn(INDEX_SRC, 'doPartIn'));
    assert.match(body, /\}\s*finally\s*\{[\s\S]*__piBusy\s*=\s*false/, '解锁在 finally 内（放宽空格，避免格式化后假失败）');
    assert.equal((body.match(/__piBusy=false/g) || []).length, 1, '__piBusy 复位点应恰 1 处（集中在 finally）');
    assert.match(body, /if\(__piBusy\)return;/, '进入即判锁');
    assert.ok(stripComments(extractFn(INDEX_SRC, 'openPartIn')).indexOf('__piBusy') < 0,
      '锁只拦提交，openPartIn 不得被判锁挡住（否再上次残留会让人打不开弹窗）');
  });
});

test('C16 收尾按「批次归属」：提交在途期间新开的弹窗不得被上一条提交关掉（P2）', async function () {
  /* 缺陷（QA 实测 P2）：提交在途时用户再点「入库」打开新弹窗；第一条提交成功后
     无条件 closeModal()+clearSel()+__piIdxs=null → 新弹窗被关、批次被清，用户刚填的数量静默丢失。
     修法：doPartIn 开头记 myIdx=__piIdxs，收尾只在 `__piIdxs===myIdx` 时才关窗/清勾选。
     本用例按 lead 的口径覆盖四项：①新弹窗未被关闭（showModal/closeModal 计数）②批次仍是新批次
     ③用户在新弹窗里填的值仍可读到 ④库存只加一次。 */
  const app = mkApp();
  const dom = stubDom(app, { pi_qty_0: '100' });
  let showN = 0, closeN = 0;
  app.setGlobal('showModal', function () { showN++; });
  app.setGlobal('closeModal', function () { closeN++; });
  app.setGlobal('selRows', { parts: new Set(['0']) });
  app.setGlobal('__piIdxs', [0]);
  const firstIdx = app.getGlobal('__piIdxs');
  const inflight = app.run('doPartIn()');       /* 不 await：模拟提交在途 */
  app.run('openPartIn()');                      /* 打开新弹窗（openPartIn 是同步函数，无返回值） */
  /* openPartIn 每次都用 `const idxs=[...s].map(...).filter(...)` **重新赋一个新数组**，
     故引用比较 `===` 天然区分两批（若将来改成原地复用同一数组，本断言会立刻变红提示改批次序号） */
  const reopenedIdx = app.getGlobal('__piIdxs');
  assert.ok(reopenedIdx && reopenedIdx !== firstIdx, '前置：重新打开后应是新批次（新数组引用）');
  assert.equal(showN, 1, '前置：新弹窗确实被打开过一次');
  dom.inputs['pi_qty_0'] = '7';                 /* 用户在新弹窗里重新填的数量 */
  await inflight;
  assert.equal(closeN, 0, '第一条提交收尾不得关闭（新开的）弹窗');
  assert.equal(app.getGlobal('__piIdxs'), reopenedIdx, '第一条提交收尾不得清掉新弹窗的批次（否则输入丢失）');
  assert.equal(app.run("selSet('parts').size"), 1, '不得清空新弹窗对应的勾选');
  assert.equal(dom.els['pi_qty_0'].value, '7', '用户在新弹窗里填的数量必须仍可读到');
  assert.equal(app.recorder.txCount(), 1, '在途那条只提交 1 次');
  assert.equal(J(app, 'parts')[0].stock, 300, '库存只加一次（200 + 100，第二窗的 7 未提交）');
  assert.equal(J(app, 'partLogs').length, 1, '台账只增 1 条');
  assert.equal(app.counters.renderContent, 1, '列表仍需刷新（库存已落库，与是否关窗无关）');
  /* 静态兜底：归属比对必须在源码里，且确实用了快照变量 */
  const body = stripComments(extractFn(INDEX_SRC, 'doPartIn'));
  assert.match(body, /const myIdx=__piIdxs;/, '必须有批次归属快照');
  assert.match(body, /if\(__piIdxs===myIdx\)\{[\s\S]*?__piIdxs=null;/, '收尾必须按归属比对后再置空');
  assert.match(body, /if\(__piIdxs===myIdx\)\{[\s\S]*?clearSel\('parts'\);[\s\S]*?\}\s*renderContent\(\);/, 'renderContent 必须在归属条件之外（无条件刷新）');
  app.dispose();
});

/* ================================================================
   §D 拖拽顺序键：parts 与 product 互不污染
   ================================================================ */
test('D1 名单键分表存放：saveUiDefaults({parts}) 只写 order.parts，product 原样', function () {
  const app = mkApp({ uiDefaults: { order: { product: ['P0', 'P1'] } } });
  return app.run("saveUiDefaults({parts:['LJ-002','LJ-001']})").then(function () {
    const v = J(app, 'uiDefaults');
    assert.deepEqual(v.order.parts, ['LJ-002', 'LJ-001'], '零部件名单写入 order.parts');
    assert.deepEqual(v.order.product, ['P0', 'P1'], '产品名单不得被覆盖');
    assert.deepEqual(J(app, 'partsOrderOf()'), ['LJ-002', 'LJ-001']);
    assert.deepEqual(J(app, 'prodOrderOf()'), ['P0', 'P1']);
    app.dispose();
  });
});

test('D2 两表排序互不影响：partsSortedByOrder 只吃 parts 名单，productsSortedByOrder 只吃 product 名单', function () {
  const app = mkApp({ uiDefaults: { order: { parts: ['LJ-002', 'LJ-001'] } } });
  assert.deepEqual(J(app, 'partsSortedByOrder().map(function(p){return p.id;})'), ['LJ-002', 'LJ-001']);
  assert.deepEqual(J(app, 'productsSortedByOrder().map(function(p){return p.id;})'), ['P1'], '产品仍按录入顺序（无 product 名单）');
  assert.deepEqual(J(app, 'parts.map(function(p){return p.id;})'), ['LJ-001', 'LJ-002'], 'parts 本体顺序不得被原地排序');
  app.dispose();
});

test('D3 排序实现单源：两表共用 sortedByOrderOf，不得各写一份排序逻辑', function () {
  const partsFn = stripComments(extractFn(INDEX_SRC, 'partsSortedByOrder'));
  const prodFn = stripComments(extractFn(INDEX_SRC, 'productsSortedByOrder'));
  assert.match(prodFn, /sortedByOrderOf\(products,prodOrderOf\(\)\)/, '产品侧走共用实现');
  assert.match(partsFn, /sortedByOrderOf\(parts,partsOrderOf\(\)\)/, '零部件侧走共用实现');
  assert.ok(!/localeCompare|\.sort\(/.test(partsFn), '薄封装内不得有第二份排序逻辑');
});

test('D4 拖拽引擎按 data-pdform 取表单；行上必须挂 data-pdform + data-pid', function () {
  const down = stripComments(extractFn(INDEX_SRC, 'prodDragDown'));
  assert.match(down, /const form=\(tr\.dataset\.pdform\|\|'product'\)/, '从 data-pdform 读模块键，缺省 product（既有调用零改动）');
  assert.match(down, /form:form/, '表单键进拖拽状态');
  const fin = stripComments(extractFn(INDEX_SRC, 'prodDragFinish'));
  assert.match(fin, /const form=st\.form\|\|'product'/, '收尾按 st.form 决定写哪个名单');
  assert.match(fin, /const patch=\{\};\s*patch\[form\]=ids;/, '名单按表单键分开写（不得固定 product）');
  assert.match(fin, /const meta=pdMeta\(form\)/, '日志目标/补齐顺序都由表单元数据给出');
  const rp = stripComments(extractFn(INDEX_SRC, 'renderParts'));
  assert.match(rp, /data-pdform="parts"/, '零部件行必须带 data-pdform="parts"');
  assert.match(rp, /data-pid="'\+esc\(String\(p\.id==null\?'':p\.id\)\)\+'"/, '零部件行必须带 data-pid');
  assert.match(rp, /onpointerdown="prodDragDown\(event\)"/, '零部件行走同一个拖拽入口');
});

test('D5 筛选态判定 / 每页条数恢复都按表单生效（缺省回落 product）', function () {
  const app = mkApp();
  app.setGlobals({ tblPage: {}, _pdLastForm: 'parts' });
  app.run("tState('parts').filters={name:{mode:'contains',val:'螺钉'}}");
  assert.equal(app.run('prodFilterActive()'), true, '缺省取最近一次拖拽表单 → 命中零部件筛选');
  assert.equal(app.run("prodFilterActive('product')"), false, '显式传 product 时不得把零部件筛选算进来');
  app.run("prodRestorePageSize(10)");
  assert.equal(app.run("pageSizeOf('parts')"), 10, '每页条数恢复到拖拽的那张表');
  app.dispose();
});

/* ================================================================
   §E 静态守卫
   ================================================================ */

test('E1 NAV：零部件数据紧跟产品主数据、零部件台账紧跟调拨台账', function () {
  const nav = INDEX_SRC.slice(INDEX_SRC.indexOf('const NAV=['), INDEX_SRC.indexOf('];', INDEX_SRC.indexOf('const NAV=[')));
  const idx = function (id) { return nav.indexOf("{id:'" + id + "'"); };
  assert.ok(idx('parts') > 0, 'NAV 必须含 parts');
  assert.ok(idx('partLogs') > 0, 'NAV 必须含 partLogs');
  assert.ok(idx('parts') > idx('product') && idx('parts') < idx('order'), '零部件数据应在产品主数据之后、订单管理之前');
  /* 【build .164 读取目标变更】原断言 `idx('partLogs') < idx('users')`（零部件台账在员工管理之前）。
     「员工管理」已在 .164 整体迁至管理员后台 ⇒ NAV 里不再有 users 项，旧判据必然假失败。
     判定意图（零部件台账紧跟调拨台账、且不是被随手插在中间）改为**更强**的两条：
       ① 台账仍在调拨台账之后；② 台账是 NAV 的最后一项（原来只是「在 users 之前」，
          若有人往台账后面再塞一项，旧判据看不出来，新判据能看出来）。 */
  assert.ok(idx('partLogs') > idx('transfers'), '零部件台账应在调拨台账之后');
  assert.strictEqual(idx('users'), -1, '「员工管理」已迁至管理员后台，NAV 不得再有 users 项');
  assert.strictEqual(nav.slice(idx('partLogs')).indexOf("{id:'"), 0,
    '零部件台账必须是 NAV 最后一项（其后不得再插入菜单项）');
  assert.ok(nav.indexOf("label:'零部件数据'") >= 0 && nav.indexOf("label:'零部件台账'") >= 0, '菜单文案');
});

test('E2 renderContent 已接两个新页签', function () {
  assert.match(INDEX_SRC, /case 'parts':c\.innerHTML=renderParts\(\);break;/, 'case parts');
  assert.match(INDEX_SRC, /case 'partLogs':c\.innerHTML=renderPartLogs\(\);break;/, 'case partLogs');
});

test('E3 权限注册：formToKey / FORM_ACTS / PERM_META.forms / PAGED_FORMS', function () {
  const ftk = stripComments(extractFn(INDEX_SRC, 'formToKey'));
  assert.match(ftk, /parts:'parts'/, 'formToKey 映射 parts');
  assert.match(ftk, /partLogs:'parts'/, '台账页归到同一权限点');
  assert.match(stripComments(INDEX_SRC), /parts:\{partIn:'入库'\}/, 'FORM_ACTS 注册入库动作键');
  /* 【build .164 读取目标变更】原断言 `assert.match(INDEX_SRC, /PERM_FORMS=\{[^}]*parts:'零部件数据'/)`：
     PERM_FORMS 已随「员工管理」迁出 index.html，权威副本改为生产后端 PERM_META.forms。
     判定意图不变（「零部件数据」这个权限点必须被注册、显示名一字不差），且改为断言**运行时值**
     而非源码正则片段 —— 比原来更严。 */
  assert.strictEqual(srv.PERM_META.forms.parts, '零部件数据', 'PERM_META.forms 注册零部件数据权限点');
  assert.match(INDEX_SRC, /PAGED_FORMS=\{[^}]*parts:1,partLogs:1\}/, '两页都启用分页');
});

test('E4 全量导出不受影响：XLSX_SHEETS 不含零部件；零部件走独立导出', function () {
  const start = INDEX_SRC.indexOf('var XLSX_SHEETS=[');
  const block = INDEX_SRC.slice(start, INDEX_SRC.indexOf('];', start));
  assert.ok(block.indexOf('parts') < 0, 'XLSX_SHEETS 不得加入零部件（避免影响全量导出与既有用例）');
  assert.match(stripComments(extractFn(INDEX_SRC, 'bulkExport')), /if\(m==='parts'\)\{[\s\S]*exportParts\(rows\)/, '导出选中走独立分支');
  assert.match(stripComments(extractFn(INDEX_SRC, 'exportParts')), /XLSX\.build\(/, '独立导出仍用同一个 XLSX 引擎');
  const cols = INDEX_SRC.slice(INDEX_SRC.indexOf('const PARTS_EXPORT_COLS=['), INDEX_SRC.indexOf('];', INDEX_SRC.indexOf('const PARTS_EXPORT_COLS=[')));
  assert.equal((cols.match(/\{key:/g) || []).length, 11, '导出列 = 11 列');
});

test('E5 批量栏：新增 / 入库 按钮只对零部件出现，且入库受动作键门控', function () {
  const bb = stripComments(extractFn(INDEX_SRC, 'bulkBar'));
  assert.match(bb, /if\(m==='parts'\)btns\.push\('<button class="btn btn-sm" onclick="partModal\(\)">新增<\/button>'\)/, '新增按钮');
  assert.match(bb, /if\(m==='parts'&&canAct\('parts\.partIn'\)\)btns\.push\('<button class="btn btn-sm btn-primary" onclick="openPartIn\(\)"/, '入库按钮（动作键门控）');
});

test('E6 台账页：12 列、只读（无勾选列/无操作列）、空态 colspan 与列数同源', function () {
  const rl = stripComments(extractFn(INDEX_SRC, 'renderPartLogs'));
  const schemaStart = rl.indexOf('TBL_SCHEMAS.partLogs=[');
  const schemaEnd = rl.indexOf('];', schemaStart);
  const schema = rl.slice(schemaStart, schemaEnd);
  assert.equal((schema.match(/\{key:/g) || []).length, 12, '台账 12 列');
  assert.ok(rl.indexOf('sel-col') < 0, '只读页不得有勾选列');
  assert.ok(rl.indexOf("th style=\"width:80px\">操作") < 0, '只读页不得有操作列');
  assert.match(rl, /colspan="'\+TBL_SCHEMAS\.partLogs\.length\+'"/, '空态 colspan 取 schema 长度（防调拨台账那类漏改）');
  assert.match(stripComments(INDEX_SRC), /const PARTLOG_TYPE_LABEL=\{in:'入库'\}/, '类型映射（仿 TR_TYPE_LABEL）');
});

test('E7 服务端：DEFAULT_DATA 注册两表 + canWrite 分支归到 parts 权限点', function () {
  assert.match(SERVER_SRC, /parts: \[\],\s*\n\s*partLogs: \[\]/, 'DEFAULT_DATA 必须同时注册两表（漏登记线上 400）');
  const fn = stripComments(extractFn(SERVER_SRC, 'canWrite'));
  const seg = fn.slice(fn.indexOf("case 'parts':"));
  assert.ok(seg.length > 0, 'canWrite 必须有 parts 分支');
  assert.match(seg.slice(0, 120), /case 'partLogs':\s*return p\.parts === true;/, '两表共用 parts 权限点');
});

test('E8 版本水印：.158 恰 1 处，且注释里不得写出完整版本号', function () {
  assert.equal((INDEX_SRC.match(build.buildMarkRe(build.BUILD)) || []).length, 1, '权威水印恰 1 处');
  assert.equal((INDEX_SRC.match(build.buildAnyRe(build.BUILD)) || []).length, 1,
    '全文「build <完整版本号>」必须恰 1 处 —— 注释里只许写【build .158】');
});

/* ================================================================
   §F 文档口径
   ================================================================ */

test('F1 guide.js：文首版本行 + 两个新小节 + 六项口径都讲到了', function () {
  /* 文首版本行随每次版本推进。.159 起改为**从单一来源 build.BUILD 推导**，不再手写字面量，
     但 QA .159 评审指出的两处约束**必须一并钉住**（否则「免手改」会把校验力一起免掉）：
       1) **日期也必须钉**：只取 `.NNN` 段时，把文首写成 `更新：2026-11-15（build .159）`
          （日期错、号对）仍会通过 —— 故同时取日期段 DATE 拼出整行；
       2) **位置也必须钉**：`GUIDE_SRC.indexOf(...)` 在正文任意位置命中都算，故限定在文首
          前 800 字符（`HEAD`）内找，并额外断言 `更新：` 全篇恰 1 处（防在别处再写一条版本行）。
     两个约束都由 BUILD 推出 → 仍然免逐版手改，同时保留判别力。 */
  const BV = String(build.BUILD).split('.');
  const DATE = BV[0], NO = BV[1];
  const HEAD = GUIDE_SRC.slice(0, 800);
  assert.ok(HEAD.indexOf('更新：' + DATE + '（build .' + NO + '）') >= 0,
    '文首（前 800 字符内）必须是「更新：' + DATE + '（build .' + NO + '）」——日期与位置都要对');
  assert.equal(countOf(GUIDE_SRC, '更新：'), 1, '版本行「更新：」全篇恰 1 处（不得在正文另写一条）');
  assert.equal(countOf(GUIDE_SRC, '### 零部件数据（.158）'), 1, '零部件数据小节恰 1 处');
  assert.equal(countOf(GUIDE_SRC, '### 零部件台账（.158）'), 1, '零部件台账小节恰 1 处');
  assert.ok(GUIDE_SRC.indexOf('相互独立') >= 0, '口径：不与产品库存联动');
  assert.ok(GUIDE_SRC.indexOf('结余 = 库存 减 已占用') >= 0, '口径：结余公式');
  assert.ok(GUIDE_SRC.indexOf('结余进度 = 结余 ÷ 最大库存量') >= 0, '口径：进度分母=最大库存量');
  assert.ok(GUIDE_SRC.indexOf('不得与产品主数据重复') >= 0, '口径：编码不得与产品编码重复');
  assert.ok(GUIDE_SRC.indexOf('整批校验') >= 0, '口径：入库整批校验');
  assert.ok(GUIDE_SRC.indexOf('仅管理员可调') >= 0, '口径：拖拽排序仅管理员');
  assert.ok(GUIDE_SRC.indexOf('本版不提供冲销') >= 0, '台账红冲未做的遗留已写明');
});

test('F2 guide.js 运行时可见：GUIDE_MD 含两个新小节', function () {
  const app = createApp({ installRecorder: false });
  const md = app.run('GUIDE_MD');
  assert.equal(typeof md, 'string');
  assert.ok(md.indexOf('### 零部件数据（.158）') >= 0);
  assert.ok(md.indexOf('### 零部件台账（.158）') >= 0);
  assert.ok(md.indexOf('PTH-YYYYMMDD-XXXXX') >= 0, '台账编号规则必须写进使用说明');
  app.dispose();
});

/* ================================================================
   §G 渲染冒烟（纯字符串构建，可在沙箱内直接调用）
   ================================================================ */

test('G1 renderParts() 可渲染：11 列表头 + 勾选列 + 数据行 + 合计行 + 批量栏操作键', function () {
  const app = mkApp();
  const html = app.run('renderParts()');
  assert.equal(typeof html, 'string');
  assert.ok(html.indexOf('零部件数据') >= 0, '标题');
  ['编码', '名称', '规格', '型号', '单位', '最大库存量', '最小库存量', '库存', '已占用', '结余', '结余进度'].forEach(function (l) {
    assert.ok(html.indexOf('>' + l) >= 0 || html.indexOf(l) >= 0, '缺少列：' + l);
  });
  assert.ok(html.indexOf('class="sel-col"') >= 0, '勾选列');
  assert.ok(html.indexOf('data-pdform="parts"') >= 0, '行上 data-pdform');
  assert.ok(html.indexOf('type="checkbox"') >= 0, '行勾选框');
  assert.ok(html.indexOf('onclick="partModal()"') >= 0, '批量栏「新增」');
  assert.ok(html.indexOf('onclick="openPartIn()"') >= 0, '批量栏「入库」');
  assert.ok(html.indexOf('全选') >= 0 && html.indexOf('导出选中') >= 0, '全选 / 导出选中');
  assert.ok(html.indexOf('progress-bar') >= 0, '结余进度条');
  assert.ok(html.indexOf('合计') >= 0, '底部合计行');
  app.dispose();
});

test('G2 renderPartLogs() 可渲染：12 列 + 空态 colspan 与列数一致', function () {
  const app = mkApp();
  const empty = app.run('renderPartLogs()');
  assert.ok(empty.indexOf('暂无入库流水') >= 0);
  assert.ok(empty.indexOf('colspan="12"') >= 0, '空态列数必须与 12 列一致');

  app.setGlobals({ partLogs: [{ id: 'PTH-20261031-00001', ts: '2026-10-31 16:20:00', type: 'in', partId: 'LJ-001', partName: '螺钉', spec: 'M4', model: 'GB', unit: '个', qty: 100, stockBefore: 200, stockAfter: 300, remark: '', user: 'PMC小张' }] });
  const html = app.run('renderPartLogs()');
  assert.ok(html.indexOf('PTH-20261031-00001') < 0, '台账页不显示内部编号（列定义不含 id）');
  assert.ok(html.indexOf('入库') >= 0, '类型映射为「入库」');
  assert.ok(html.indexOf('LJ-001') >= 0 && html.indexOf('螺钉') >= 0, '零件信息');
  assert.ok(html.indexOf('PMC小张') >= 0, '操作人');
  app.dispose();
});

test('G3 partModal：只读四项禁编辑 + 新增/复制从 0 起算 + 必填标记', function () {
  const app = mkApp();
  const dom = stubDom(app, {});
  /* 复制场景：prefill 带着源零件的库存 500/占用 30，但新记录必须从 0 起算 */
  app.run('partModal(-1,{id:"LJ-001_copy",name:"螺钉副本",unit:"个",stock:500,used:30,stockMax:100,stockMin:10})');
  const html = dom.els['modal'].innerHTML;
  assert.ok(html.indexOf('新增零部件') >= 0, '复制走「新增」标题（否则用户会以为在改源零件）');
  assert.ok(html.indexOf('savePart(-1)') >= 0, '保存走新增分支');
  assert.ok(html.indexOf('value="0" disabled') >= 0, '库存/已占用显示 0 且禁编辑');
  assert.ok((html.match(/disabled/g) || []).length >= 4, '只读四项（库存/已占用/结余/结余进度）都 disabled');
  assert.ok(html.indexOf('结余进度') >= 0, '只读区含结余进度');
  ['编码', '名称', '单位'].forEach(function (l) {
    assert.ok(html.indexOf(l + ' *') >= 0, '必填标记：' + l);
  });
  assert.ok(html.indexOf('不能与产品主数据编码重复') >= 0, '编码栏提示跨表唯一');

  /* 编辑场景：库存/已占用展示源值（复用同一个 DOM 桩，同一 id 取到同一假元素） */
  app.run('partModal(0)');
  const html2 = dom.els['modal'].innerHTML;
  assert.ok(html2.indexOf('编辑零部件') >= 0, '编辑标题');
  assert.ok(html2.indexOf('savePart(0)') >= 0);
  app.dispose();
});
