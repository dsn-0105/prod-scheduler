'use strict';
/* ================================================================
   tests/qa.parts-ledger.independent.test.js
   —— QA 独立验证：零部件数据 + 零部件台账（build 2026-10-31.158 起，随版本推进同步至 .160）
   ================================================================
   定位：**独立复验**，不是 tests/parts.158.test.js 的复读机。
     · 不采信工程师自述，不复用他的断言写法定式；
     · 断言角度偏「行为级 + 账实相符 + 单源」而非「源码里出现了某个字面量」；
     · 每条源码守卫都自带**反假守卫自检**（合成样本必须被同一套匹配器判红）；
     · §G 用**变异注入**证明本文件的断言真的能红，注入未生效即报错而不是静默通过。
   绝不修改产品代码（index.html / js/*.js / server/*.js）；变异只在内存字符串/临时副本上做。

   跑法（显式列表，勿用 tests/*.test.js 通配，会扫入 _diag/）：
     node --test tests/qa.parts-ledger.independent.test.js
   ================================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp, ROOT } = require('./harness/sandbox');

/* ---------------- 权威版本号（本文件手写，不从 index.html 反推） ----------------
   【build .159 同步说明】本文件的 BUILD/PREV 是**独立的字面量副本**（防「测了个寂寞」），
   每推进一版必须手工前移这两行 —— 下面的 §F1~§F6 再用它们去反查 index.html / build.js /
   guide.js / README / 其它测试文件的同步状态。故这里是**唯一**需要手改的地方，其余一律派生：
     · BUILD_NO   = BUILD 的 `.NNN` 段（guide.js 与注释里只许用「build .NNN」短形态）；
     · BUILD_DATE = BUILD 的日期段（guide.js 文首「更新：YYYY-MM-DD（build .NNN）」）。
   刻意**不**把 `.159` / `2026-10-31` 分散写死在断言里 —— .148 就因清单/计数不同步假失败过一次。 */
const BUILD = '2026-11-14.160';
const PREV = '2026-10-31.159';
const BUILD_NO = String(BUILD).split('.')[1];       /* '160' */
const BUILD_DATE = String(BUILD).split('.')[0];     /* '2026-11-14' */
const PREV_NO = String(PREV).split('.')[1];         /* '159' */

const readRel = function (rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); };
const INDEX_SRC = readRel('index.html');
const GUIDE_SRC = readRel('js/guide.js');
const SERVER_SRC = readRel('server/server.js');
const README_SRC = readRel('README.md');
const BUILD_HARNESS_SRC = readRel('tests/harness/build.js');
const PPSHIFT_SRC = readRel('tests/qa.ppshift-advance.independent.test.js');
const PRODPLAN_QUERY_SRC = readRel('tests/qa.prodplan-query.independent.test.js');
const LAYOUT_INDEP_SRC = readRel('tests/layout.scoped.independent.test.js');
const DRAG156_SRC = readRel('tests/product-order-drag.156.test.js');

const JS_MODULES = ['guide.js', 'logs.js', 'import.js', 'prodplan-core.js', 'transfer.js'];
const ALL_JS_SRC = JS_MODULES.map(function (f) { return { file: 'js/' + f, src: readRel('js/' + f) }; });

/* ================================================================
   源码工具（自带反假守卫能力）
   ================================================================ */

/** 去注释（行/块）。用于「不得有第二份实现」类扫描，避免注释里的示例文本误命中。 */
function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}
/** 去全部空白（含换行）。让「空格/换行/p&&p 之类写法差异」不再影响匹配。 */
function wsFree(src) { return String(src).replace(/\s+/g, ''); }

/** 出现次数（字面量，非正则） */
function countOcc(src, needle) {
  let n = 0, i = 0;
  for (;;) {
    const k = src.indexOf(needle, i);
    if (k < 0) return n;
    n++; i = k + needle.length;
  }
}

/** 取函数源码（按大括号配平；支持 function/async function/箭头赋值） */
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

/** 取 test('标题前缀 ...) 的整块源码（含函数体），用于评审别人的测试有没有被削弱 */
function extractTestBlock(src, titlePrefix) {
  const start = src.indexOf("test('" + titlePrefix);
  if (start < 0) throw new Error('[qa] 未找到用例: ' + titlePrefix);
  const next = src.indexOf("\ntest('", start + 1);
  return src.slice(start, next < 0 ? src.length : next);
}

/* ================================================================
   沙箱装配
   ================================================================ */

const ADMIN = { username: 'qa_admin', name: 'QA严过关', role: 'admin', perms: {} };
const READONLY = { username: 'qa_ro', name: '只读账号', role: 'staff', perms: {} };

function partsFixture() {
  return [
    /* 结余 10 / 最小 5 → 绿 */
    { id: 'LJ-001', name: '螺钉', spec: 'M4×10', model: 'GB/T845', unit: '个', stockMax: 100, stockMin: 5, stock: 10, used: 0 },
    /* 结余 3 / 最小 5 → 黄 */
    { id: 'LJ-002', name: '外壳', spec: '白色', model: 'CW-A', unit: '个', stockMax: 100, stockMin: 5, stock: 3, used: 0 },
    /* 结余 200 / 最大 100 → 灰 */
    { id: 'LJ-003', name: '垫片', spec: '', model: '', unit: '张', stockMax: 100, stockMin: 5, stock: 200, used: 0 },
    /* 结余 -4（库存 1 − 已占用 5）→ 红 */
    { id: 'LJ-004', name: '弹簧', spec: '', model: '', unit: '个', stockMax: 100, stockMin: 5, stock: 1, used: 5 }
  ];
}

/**
 * 装 DOM 桩：getElementById 按 id 记忆返回同一对象（value 由 inputs 驱动、classList 有真实状态）。
 * 这是本文件唯一覆盖 harness 默认桩（恒返回 null）的地方——测的是「读表单输入」的生产函数。
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
  return { values: values, els: els };
}

function mkApp(seed, opts) {
  const counters = { renderContent: 0, renderAll: 0 };
  const app = createApp(Object.assign({ installRecorder: true }, opts || {}));
  app.counters = counters;
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
    renderContent: function () { counters.renderContent++; },
    renderAll: function () { counters.renderAll++; }
  }, seed || {}));
  return app;
}

/** 从沙箱读表达式（跨 realm 安全：走 JSON） */
function J(app, expr) { return JSON.parse(app.run('JSON.stringify(' + expr + ')')); }
function idList(app, expr) { return J(app, expr).map(function (x) { return x.id; }); }

/* ================================================================
   §A 口径正确性（行为级）
   ================================================================ */

test('A1 partBalanceOf 行为：正常 / used 缺省 / 字符串 / 脏值 / 负结余不钳制', function () {
  const app = mkApp();
  assert.equal(app.run('partBalanceOf({stock:10,used:3})'), 7, '正常相减');
  assert.equal(app.run('partBalanceOf({stock:10,used:0})'), 10, 'used=0（本期恒 0）');
  assert.equal(app.run('partBalanceOf({stock:10})'), 10, 'used 缺省按 0');
  assert.equal(app.run('partBalanceOf({stock:"10",used:"3"})'), 7, '字符串数字必须数值化（num 口径）');
  assert.equal(app.run('partBalanceOf({stock:"12.5",used:"2.5"})'), 10, '小数同样数值化');
  assert.equal(app.run('partBalanceOf({stock:undefined,used:undefined})'), 0, 'undefined → 0，不得 NaN');
  assert.equal(app.run('partBalanceOf({stock:"",used:""})'), 0, '空串 → 0');
  assert.equal(app.run('partBalanceOf({stock:"abc",used:1})'), -1, '非数字按 0（num 既有口径）');
  assert.equal(app.run('partBalanceOf({stock:1,used:5})'), -4, '负结余必须保留（供红色档位判定）');
  assert.equal(app.run('partBalanceOf(null)'), 0, 'null 不得抛错');
  assert.equal(app.run('partBalanceOf()'), 0, '无参不得抛错');
  assert.ok(!Number.isNaN(app.run('partBalanceOf(undefined)')), 'undefined 不得产出 NaN');
  app.dispose();
});

/* —— 结余公式单源：两套独立匹配式，都要求「全工程恰 1 处」 —— */
const BAL_RE_NESTED = /num\((?:[^()]|\([^()]*\))*\.stock\)-num\((?:[^()]|\([^()]*\))*\.used\)/g;
const BAL_RE_PLAIN = /\.stock\)-num\(/g;

function scanBalanceForms() {
  const files = [{ file: 'index.html', src: INDEX_SRC }].concat(ALL_JS_SRC);
  const nested = [], plain = [];
  files.forEach(function (f) {
    const code = wsFree(stripComments(f.src));
    const a = code.match(BAL_RE_NESTED) || [];
    const b = code.match(BAL_RE_PLAIN) || [];
    a.forEach(function (x) { nested.push({ file: f.file, text: x }); });
    b.forEach(function (x) { plain.push({ file: f.file, at: code.indexOf(x) }); });
  });
  return { nested: nested, plain: plain };
}

/** A2 的源码守卫本体（抽成函数 → §G 变异注入可复用同一段断言，证明它会红） */
function assertBalanceSingleSource() {
  const hit = scanBalanceForms();
  assert.equal(hit.nested.length, 1,
    '「num(…stock) − num(…used)」形态必须恰 1 处（唯一公式点），实际: ' + JSON.stringify(hit.nested));
  assert.equal(hit.plain.length, 1,
    '交叉校验（.stock) − num( 形态）也必须恰 1 处，实际 ' + hit.plain.length + ' 处');
  assert.equal(hit.nested[0].file, 'index.html', '唯一实现必须在 index.html');
  const fn = stripComments(extractFn(INDEX_SRC, 'partBalanceOf'));
  assert.ok(wsFree(fn).indexOf('returnnum(p&&p.stock)-num(p&&p.used);') >= 0,
    '唯一那处减法必须就在 partBalanceOf 里（别处复用不得重算）');
}

test('A2 结余公式全工程唯一 + 匹配器反假守卫自检', function () {
  /* ① 反假守卫自检：同一套匹配器必须能认出各种**写法变异**，否则「恰 1 处」只是字面量巧合。
        这是本轮被点名要求的点：正则必须扛住空格 / p&& / 括号包一层。 */
  const samples = [
    'num(p&&p.stock)-num(p&&p.used)',
    'num(p.stock) - num(p.used)',
    'num(p && p.stock)   -   num(p && p.used)',
    'num((p||{}).stock) - num((p||{}).used)',
    'num(a.stock)-num(b.used)',
    'num(x.stock)\n  -\n  num(x.used)'
  ];
  samples.forEach(function (s) {
    const code = wsFree(s);
    assert.equal((code.match(BAL_RE_NESTED) || []).length, 1, '匹配器漏认写法: ' + s);
  });
  /* 反向自检：加法/其它字段不得被误判成结余公式（否则「恰 1 处」会被误报成 2 处） */
  ['num(p.stock)+num(p.used)', 'num(p.stock)-num(p.orderQty)', 'num(p.stockMax)-num(p.stock)'].forEach(function (s) {
    assert.equal((wsFree(s).match(BAL_RE_NESTED) || []).length, 0, '匹配器误认: ' + s);
  });

  /* ② 真源码：全工程恰 1 处 */
  assertBalanceSingleSource();
});

test('A3 partBalPctOf：分母=最大库存量；0/空/缺省 → 0；不截断（>100% 保留）；负结余为负', function () {
  const app = mkApp();
  assert.equal(app.run('partBalPctOf({stock:5,used:0,stockMax:0})'), 0, '最大库存量 0 → 0（不除零）');
  assert.equal(app.run('partBalPctOf({stock:5,used:0,stockMax:""})'), 0, '最大库存量空串 → 0');
  assert.equal(app.run('partBalPctOf({stock:5,used:0,stockMax:undefined})'), 0, '最大库存量 undefined → 0');
  assert.equal(app.run('partBalPctOf({stock:5,used:0})'), 0, '最大库存量缺省 → 0');
  assert.equal(app.run('partBalPctOf({stock:150,used:0,stockMax:100})'), 150,
    '结余 150 / 最大 100 → 150%（**不截断到 100**，与库存管理页 >100% 口径一致）');
  assert.equal(app.run('partBalPctOf({stock:10,used:40,stockMax:100})'), -30, '结余 -30 → -30%');
  assert.equal(app.run('partBalPctOf({stock:1,used:0,stockMax:3})'), 33, '四舍五入 33');
  assert.equal(app.run('partBalPctOf({stock:2,used:0,stockMax:3})'), 67, '四舍五入 67');
  /* 分母必须是「最大库存量」——用最小库存量做分母会得出不同答案，这里反向钉死 */
  assert.notEqual(app.run('partBalPctOf({stock:150,used:0,stockMax:100,stockMin:1})'),
    app.run('partBalPctOf({stock:150,used:0,stockMax:1,stockMin:1})'), '分母口径必须只认最大库存量');
  app.dispose();
});

test('A4 结余 4 档配色复用 invStockLevel（红/黄/绿/灰 各判一次）且零件页无第二份档位判定', function () {
  const app = mkApp();
  /* 4 档语义（共享函数）先钉死，避免「零件页自己写了一套」时也碰巧对 */
  assert.equal(app.run('invStockLevel(-1,5,100)'), 'red', '红：结余 < 0');
  assert.equal(app.run('invStockLevel(3,5,100)'), 'amber', '黄：0 ≤ 结余 < 最小库存量');
  assert.equal(app.run('invStockLevel(10,5,100)'), 'green', '绿：正常区间');
  assert.equal(app.run('invStockLevel(200,5,100)'), 'gray', '灰：结余 > 最大库存量');

  /* 行为级：渲染 4 条覆盖 4 档的零件，进度条背景色必须出现 4 种 */
  const html = app.run('renderParts()');
  const BAR = {
    red: 'background:var(--red)', amber: 'background:var(--amber)',
    green: 'background:var(--green)', gray: 'background:#9ca3af'
  };
  Object.keys(BAR).forEach(function (lv) {
    assert.ok(html.indexOf(BAR[lv]) >= 0, '渲染结果缺少「' + lv + '」档进度条配色（复用 _lvCls 同色值）');
  });
  /* 4 条数据行各一种配色 → 每种恰 1 次（多了说明配色与行数对不上） */
  assert.equal(countOcc(html, BAR.red), 1, '红档恰 1 行');
  assert.equal(countOcc(html, BAR.amber), 1, '黄档恰 1 行');
  assert.equal(countOcc(html, BAR.gray), 1, '灰档恰 1 行');
  assert.equal(countOcc(html, BAR.green), 1, '绿档恰 1 行');

  /* 单源守卫：全工程只有一份「档位判定」实现，且零件页只调用不复刻 */
  const plain = stripComments(INDEX_SRC);
  assert.equal((plain.match(/function\s+invStockLevel\s*\(/g) || []).length, 1, '档位判定只许有一个实现');
  assert.equal((plain.match(/return\s*'red'/g) || []).length, 1, "「'red'」只许由 invStockLevel 产出一次");
  assert.equal((plain.match(/return\s*'amber'/g) || []).length, 1, "「'amber'」只许由 invStockLevel 产出一次");
  assert.equal((plain.match(/return\s*'gray'/g) || []).length, 1, "「'gray'」只许由 invStockLevel 产出一次");
  assert.equal((plain.match(/return\s*'green'/g) || []).length, 1, "「'green'」只许由 invStockLevel 产出一次");
  const rp = stripComments(extractFn(INDEX_SRC, 'renderParts'));
  assert.equal(countOcc(rp, 'invStockLevel('), 2, '零件页两处（结余列 + 进度条）都复用 invStockLevel');
  /* 反假守卫：零件页若自己写 `bal<0?` 之类判定，这里必须报红 */
  assert.ok(!/lv\s*=\s*[^;?]*\?[^;]*'red'/.test(rp), '零件页不得自行产出档位（必须来自 invStockLevel）');
  app.dispose();
});

/* ================================================================
   §B 编码唯一（内部 / 跨表 / 编辑自身 / 编辑保留库存 / 大小写空格）
   ================================================================ */

test('B1 新增时零部件内部编码重复 → 拒绝且 parts 长度不变、不发起事务', async function () {
  const app = mkApp();
  installDom(app, { pj_id: 'LJ-001', pj_name: '重复螺钉', pj_unit: '个', pj_stockMax: '10', pj_stockMin: '1' });
  await app.run('savePart(-1)');
  assert.ok(app.alerts.some(function (a) { return a.indexOf('已存在') >= 0; }), '必须提示编码已存在: ' + JSON.stringify(app.alerts));
  assert.equal(app.run('parts.length'), 4, 'parts 长度不得变化（4 → 4）');
  assert.equal(app.recorder.txCount(), 0, '被拒时不得发起事务');
  app.dispose();
});

/** B2 的行为探针（§G2 变异注入复用：删掉跨表查重后本函数必须抛错） */
async function probeCrossTableDupRejected(app) {
  installDom(app, { pj_id: 'P1', pj_name: '撞名零部件', pj_unit: '个', pj_stockMax: '10', pj_stockMin: '1' });
  await app.run('savePart(-1)');
  assert.ok(app.alerts.some(function (a) { return a.indexOf('已被产品主数据使用') >= 0; }),
    '必须给出跨表查重的专用文案，实际: ' + JSON.stringify(app.alerts));
  assert.equal(app.run('parts.length'), 4, 'parts 长度不得变化（4 → 4）');
  assert.equal(app.run("parts.some(function(p){return p.id==='P1';})"), false, '撞名的零部件不得入库');
  assert.equal(app.recorder.txCount(), 0, '被拒时不得发起事务');
}

test('B2 与产品主数据编码重复 → 拒绝（用户确认"不能"撞名）', async function () {
  const app = mkApp();
  try { await probeCrossTableDupRejected(app); } finally { app.dispose(); }
});

test('B3 编辑自身（idx 相同）改其它字段 → 不得误判为重复', async function () {
  const app = mkApp();
  installDom(app, {
    pj_id: 'LJ-001', pj_name: '螺钉·改', pj_spec: 'M5×12', pj_model: 'GB/T845-2',
    pj_unit: '个', pj_stockMax: '500', pj_stockMin: '20'
  });
  await app.run('savePart(0)');
  assert.equal(app.alerts.length, 0, '编辑自身不得弹任何告警: ' + JSON.stringify(app.alerts));
  const p = J(app, 'parts[0]');
  assert.equal(p.id, 'LJ-001', '编码保持不变');
  assert.equal(p.name, '螺钉·改', '其它字段已保存');
  assert.equal(p.stockMax, 500);
  assert.equal(p.stockMin, 20);
  assert.equal(app.recorder.txCount(), 1, '保存 = 一次事务');
  assert.equal(JSON.stringify(app.recorder.lastTx().keys), '["parts","logs"]', '事务只含 parts + logs');
  app.dispose();
});

test('B4 编辑时 stock / used 必须保留原值（不得被表单重置成 0）——先入库 50 再改名', async function () {
  /* 这条最容易漏：savePart 里 `stock:0,used:0` 的初值若无 isEdit 分支回填，
     一次「只改名字」的编辑就会把真实库存抹成 0，且台账流水与库存立刻对不上账。 */
  const app = mkApp({ parts: [
    { id: 'LJ-900', name: '待改名', spec: '', model: '', unit: '个', stockMax: 500, stockMin: 10, stock: 0, used: 0 }
  ], partLogs: [], selRows: {} });
  /* ① 真实走一次入库：0 + 50 → 50 */
  installDom(app, { pi_qty_0: '50' });
  app.setGlobal('selRows', { parts: new Set(['0']) });
  await app.run('openPartIn()');
  await app.run('doPartIn()');
  assert.equal(J(app, 'parts[0]').stock, 50, '前置：入库后库存应为 50');
  const logsAfterIn = J(app, 'partLogs').length;

  /* ② 只改名称/规格，且故意把表单里可能出现的 stock/used 输入塞成脏值 */
  installDom(app, { pj_id: 'LJ-900', pj_name: '改名后', pj_unit: '个', pj_stockMax: '500', pj_stockMin: '10', pj_stock: '0', pj_used: '999' });
  await app.run('savePart(0)');
  const p = J(app, 'parts[0]');
  assert.equal(p.name, '改名后', '名称已更新');
  assert.equal(p.stock, 50, '库存必须保持 50（只由入库驱动，编辑不得重置/覆盖）');
  assert.equal(p.used, 0, '已占用必须保持 0（本期预留字段，不得被表单改成 999）');
  assert.equal(J(app, 'partLogs').length, logsAfterIn, '编辑不得动台账流水');
  /* 账实相符：台账 qty 合计仍等于库存 */
  const sum = J(app, 'partLogs').reduce(function (s, x) { return s + x.qty; }, 0);
  assert.equal(sum, p.stock, '台账流水合计必须等于库存（账实相符）');
  app.dispose();
});

test('B5 前后空格按 trim 后判重；大小写未做折叠（按实现契约断言，结论见报告）', async function () {
  /* 实现：`String(elv('id')).trim()`，比对时两侧也都 trim ⇒ ' LJ-001 ' 必被判重。 */
  const app = mkApp();
  installDom(app, { pj_id: ' LJ-001 ', pj_name: '带空格', pj_unit: '个' });
  await app.run('savePart(-1)');
  assert.ok(app.alerts.some(function (a) { return a.indexOf('已存在') >= 0; }),
    '首尾空格 trim 后与既有编码相同 → 必须拒绝: ' + JSON.stringify(app.alerts));
  assert.equal(app.run('parts.length'), 4, 'parts 长度不变');

  /* 大小写：实现未做 toLowerCase 折叠 ⇒ 'lj-001' 会被接受。这里按**当前契约**断言，
     并在报告中登记为「口径歧义（建议 P2 明确）」——不是把它当成正确行为来背书。 */
  app.alerts.length = 0;
  installDom(app, { pj_id: 'lj-001', pj_name: '小写编码', pj_unit: '个', pj_stockMax: '1', pj_stockMin: '0' });
  await app.run('savePart(-1)');
  assert.equal(app.alerts.length, 0, '当前实现不做大小写折叠 → 不判重（若日后收紧，本断言应同步改）');
  assert.equal(app.run('parts.length'), 5, '小写编码被接受（与既有实现一致）');
  assert.equal(J(app, 'parts[4]').id, 'lj-001', '存的是 trim 后的原样值');
  app.dispose();
});

test('B6 编辑时改成**另一个已存在零件**的编码 → 必须拒绝', async function () {
  /* 工程师只测了「编辑自身不误判」，没测「编辑成别人的编码」——这是查重排除项最容易漏的一侧。 */
  const app = mkApp();
  installDom(app, { pj_id: 'LJ-002', pj_name: '螺钉', pj_unit: '个', pj_stockMax: '100', pj_stockMin: '5' });
  await app.run('savePart(0)');
  assert.ok(app.alerts.some(function (a) { return a.indexOf('已存在') >= 0; }), '占用他人编码必须拒绝');
  assert.equal(J(app, 'parts[0]').id, 'LJ-001', '被拒后原编码不得变化');
  assert.equal(J(app, 'parts[0]').name, '螺钉', '被拒后其它字段也不得被写');
  assert.equal(app.run('parts.length'), 4, '不得新增行');
  assert.equal(app.recorder.txCount(), 0, '不得发起事务');
  app.dispose();
});

test('B7 编辑时把零件编码改成**产品编码** → 跨表查重同样生效', async function () {
  const app = mkApp();
  installDom(app, { pj_id: 'P1', pj_name: '螺钉', pj_unit: '个', pj_stockMax: '100', pj_stockMin: '5' });
  await app.run('savePart(0)');
  assert.ok(app.alerts.some(function (a) { return a.indexOf('已被产品主数据使用') >= 0; }),
    '编辑路径也必须走跨表查重: ' + JSON.stringify(app.alerts));
  assert.equal(J(app, 'parts[0]').id, 'LJ-001', '编码不得被改成产品编码');
  assert.equal(app.recorder.txCount(), 0);
  app.dispose();
});

/* ================================================================
   §C 入库（重点）
   ================================================================ */

/** 走真实 UI 链路：勾选 → openPartIn() → 填数量 → doPartIn()（不经 __piIdxs 后门） */
async function runPartIn(app, qtyByIndex, sel) {
  const inputs = {};
  Object.keys(qtyByIndex).forEach(function (i) { inputs['pi_qty_' + i] = qtyByIndex[i]; });
  installDom(app, inputs);
  app.setGlobal('selRows', { parts: new Set((sel || Object.keys(qtyByIndex)).map(String)) });
  await app.run('openPartIn()');
  await app.run('doPartIn()');
}

test('C1 入库正常：库存累加 + 台账逐字段正确 + 一次原子事务', async function () {
  const app = mkApp();
  /* LJ-001 stock 10 → +100 = 110 */
  await runPartIn(app, { 0: '100', 1: '5' });
  const parts = J(app, 'parts');
  assert.equal(parts[0].stock, 110, '10 + 100');
  assert.equal(parts[1].stock, 8, '3 + 5');

  const logs = J(app, 'partLogs');
  assert.equal(logs.length, 2, '每个入库零件一条流水');
  const l0 = logs.filter(function (x) { return x.partId === 'LJ-001'; })[0];
  assert.ok(l0, '缺少 LJ-001 的流水');
  assert.equal(l0.qty, 100, 'qty');
  assert.equal(l0.stockBefore, 10, 'stockBefore 快照');
  assert.equal(l0.stockAfter, 110, 'stockAfter 快照');
  assert.equal(l0.type, 'in', "type 必须为 'in'");
  assert.ok(l0.user && String(l0.user).length > 0, '操作用户不得为空');
  assert.equal(l0.user, 'QA严过关', '操作人取当前登录用户（姓名优先，与调拨台账同源）');
  assert.match(String(l0.id), /^PTH-\d{8}-\d{5}$/, '编号必须匹配 PTH-YYYYMMDD-\\d{5}，实际: ' + l0.id);
  assert.equal(l0.stockAfter - l0.stockBefore, l0.qty, '不变式：stockAfter − stockBefore = qty');
  assert.equal(l0.partName, '螺钉', '流水带零件名称');
  assert.equal(l0.unit, '个', '流水带单位');

  assert.equal(app.recorder.txCount(), 1, '一次业务动作 = 一次事务');
  assert.equal(JSON.stringify(app.recorder.lastTx().keys), '["parts","partLogs","logs"]',
    '一次 tx 覆盖 parts + partLogs + logs');
  assert.equal(app.run("selSet('parts').size"), 0, '成功后清空勾选');
  assert.equal(app.counters.renderContent, 1, '成功后重绘一次');
  app.dispose();
});

test('C2 同批多行入库：台账逐行一条、编号不重号且当日递增', async function () {
  const app = mkApp();
  await runPartIn(app, { 0: '1', 1: '2', 3: '3' });
  const logs = J(app, 'partLogs');
  assert.equal(logs.length, 3, '3 行 = 3 条流水（逐行一条）');
  const ids = logs.map(function (x) { return x.id; });
  assert.equal(new Set(ids).size, 3, '编号不得重号: ' + JSON.stringify(ids));
  const today = app.run('todayStr().replace(/-/g,"")');
  const suffixes = ids.map(function (x) { return String(x).slice(-5); }).sort();
  assert.equal(JSON.stringify(suffixes), '["00001","00002","00003"]',
    '当日序号从 00001 起连续（前缀 ' + today + '），实际: ' + JSON.stringify(ids));
  ids.forEach(function (x) { assert.ok(String(x).indexOf('PTH-' + today + '-') === 0, '日期段必须是当天: ' + x); });
  /* 已占用为预留字段：入库不得污染 */
  assert.equal(J(app, 'parts').every(function (p) { return p.used === 0 || p.id === 'LJ-004'; }), true,
    '入库只动 stock，不得动 used（LJ-004 的 used 是夹具里预留的 5）');
  app.dispose();
});

/** C3 的行为探针（§G3 变异注入复用：部分提交时本函数必须抛错） */
async function probeIllegalQtyRejectsWholeBatch(app) {
  const before = J(app, 'parts').map(function (p) { return p.stock; });
  const logsBefore = J(app, 'partLogs').length;
  await runPartIn(app, { 0: '100', 1: '-3' });
  assert.ok(app.alerts.some(function (a) { return a.indexOf('不能为负数') >= 0; }),
    '必须提示负数非法: ' + JSON.stringify(app.alerts));
  const after = J(app, 'parts').map(function (p) { return p.stock; });
  assert.equal(JSON.stringify(after), JSON.stringify(before),
    '整批拒绝：**合法行也不得被写入**（禁止部分提交），before=' + JSON.stringify(before) + ' after=' + JSON.stringify(after));
  assert.equal(J(app, 'partLogs').length, logsBefore, '不得产生半条流水');
  assert.equal(app.recorder.txCount(), 0, '不得发起事务');
}

test('C3 负数 / 非数字 / Infinity → 整批拒绝，库存一字不动、台账不变', async function () {
  const app = mkApp();
  try { await probeIllegalQtyRejectsWholeBatch(app); } finally { app.dispose(); }
});

test('C3b 非数字与 Infinity 单独成批同样整批拒绝', async function () {
  const cases = ['abc', '1e999', '--1', '1,000', 'NaN'];
  for (const raw of cases) {
    const app = mkApp();
    const before = J(app, 'parts').map(function (p) { return p.stock; });
    await runPartIn(app, { 0: '100', 1: raw });
    const after = J(app, 'parts').map(function (p) { return p.stock; });
    assert.equal(JSON.stringify(after), JSON.stringify(before),
      '非法值「' + raw + '」必须整批拒绝，不得部分提交');
    assert.equal(app.run('partLogs.length'), 0, '非法值「' + raw + '」不得写流水');
    assert.equal(app.recorder.txCount(), 0, '非法值「' + raw + '」不得发起事务');
    assert.ok(app.alerts.length > 0, '非法值「' + raw + '」必须有提示');
    app.dispose();
  }
});

test('C4 全留空 / 全填 0 → 提示「请至少填写一个」，不写库、不发事务', async function () {
  const app = mkApp();
  await runPartIn(app, { 0: '', 1: '0' });
  assert.ok(app.alerts.some(function (a) { return a.indexOf('请至少填写一个') >= 0; }),
    '必须提示至少填写一个: ' + JSON.stringify(app.alerts));
  assert.equal(J(app, 'parts')[0].stock, 10, '库存不变');
  assert.equal(app.run('partLogs.length'), 0, '不写流水');
  assert.equal(app.recorder.txCount(), 0, '不发事务');
  app.dispose();
});

test('C5 写库失败（DB.tx → false）→ 弹窗不关、勾选不清、不渲染成功态', async function () {
  const app = mkApp();
  installDom(app, { pi_qty_0: '100' });
  app.setGlobal('selRows', { parts: new Set(['0']) });
  await app.run('openPartIn()');
  /* openPartIn 必须真的把弹窗打开——否则下面「不关闭」的断言会退化成恒真 */
  assert.equal(app.sandbox.document.getElementById('modalBg').classList.contains('show'), true,
    '前置：入库弹窗应处于打开态');
  const modalHtml = app.sandbox.document.getElementById('modal').innerHTML;
  assert.ok(modalHtml.indexOf('零部件入库') >= 0, '前置：弹窗标题正确');

  app.recorder.failNext('tx', 'boom');
  await app.run('doPartIn()');

  assert.equal(app.recorder.txCount(), 1, '确实尝试了一次事务');
  assert.equal(app.sandbox.document.getElementById('modalBg').classList.contains('show'), true,
    '事务失败不得关闭弹窗（用户应可原样重试）');
  assert.equal(app.run("selSet('parts').size"), 1, '失败不得清空勾选');
  assert.equal(app.counters.renderContent, 0, '失败不得渲染成成功态');
  assert.ok(!app.alerts.some(function (a) { return a.indexOf('成功') >= 0; }), '失败不得提示成功');
  app.dispose();
});

test('C6 入库后 used 恒为 0（不得被入库逻辑污染）', async function () {
  const app = mkApp({ parts: [
    { id: 'LJ-900', name: '零占用件', spec: '', model: '', unit: '个', stockMax: 100, stockMin: 0, stock: 0, used: 0 }
  ], partLogs: [], selRows: {} });
  await runPartIn(app, { 0: '77' });
  const p = J(app, 'parts[0]');
  assert.equal(p.stock, 77, '库存已累加');
  assert.equal(p.used, 0, '已占用必须仍为 0');
  assert.equal(Number(p.used), 0, '即使被写成 "0"/null 也必须数值化为 0（界面显示 0）');
  assert.equal(app.run('partBalanceOf(parts[0])'), 77, '结余 = 库存 − 0');
  app.dispose();
});

test('C7 不变式：同一零件多次入库后，Σ台账 qty === 当前库存 − 期初库存（账实相符）', async function () {
  const app = mkApp({ parts: [
    { id: 'LJ-901', name: '对账件', spec: '', model: '', unit: '个', stockMax: 1000, stockMin: 0, stock: 0, used: 0 }
  ], partLogs: [], selRows: {} });
  const rounds = [10, 25, 7.5];   /* 含小数：无论策略是否允许小数，账实必须相符 */
  for (const q of rounds) {
    await runPartIn(app, { 0: String(q) });
    app.recorder.reset();          /* 只关心账，不关心事务次数 */
  }
  const p = J(app, 'parts[0]');
  const sum = J(app, 'partLogs')
    .filter(function (x) { return x.partId === 'LJ-901'; })
    .reduce(function (s, x) { return s + x.qty; }, 0);
  assert.equal(Math.round(sum * 100) / 100, Math.round((p.stock - 0) * 100) / 100,
    '台账 qty 合计必须等于库存增量（否则流水不可用于追溯）');
  J(app, 'partLogs').forEach(function (x) {
    assert.equal(Math.round((x.stockAfter - x.stockBefore) * 100) / 100, Math.round(x.qty * 100) / 100,
      '每条流水自身也必须满足 stockAfter − stockBefore = qty: ' + JSON.stringify(x));
  });
  app.dispose();
});

test('C8 openPartIn 未勾选时拒绝、无写权限时拒绝（不弹入库弹窗）', async function () {
  const app = mkApp({ selRows: {} });
  installDom(app, {});
  await app.run('openPartIn()');
  assert.ok(app.alerts.some(function (a) { return a.indexOf('请先勾选') >= 0; }),
    '未勾选应提示先勾选: ' + JSON.stringify(app.alerts));
  assert.equal(app.sandbox.document.getElementById('modalBg').classList.contains('show'), false,
    '未勾选不得打开入库弹窗');
  app.dispose();

  const ro = mkApp({ currentUser: READONLY, selRows: { parts: new Set(['0']) } });
  installDom(ro, {});
  await ro.run('openPartIn()');
  assert.ok(ro.alerts.some(function (a) { return a.indexOf('无该表单的编辑权限') >= 0; }),
    '只读账号应被写权限守卫拦下: ' + JSON.stringify(ro.alerts));
  ro.dispose();
});

test('C9 删除零件后台账流水仍可查（台账只增不改，追溯不断链）', async function () {
  const app = mkApp();
  await runPartIn(app, { 0: '40' });
  assert.equal(app.run('partLogs.length'), 1, '前置：已有 1 条流水');
  const logId = J(app, 'partLogs')[0].id;

  app.recorder.reset();
  await app.run('delPart(0)');   /* 删掉 LJ-001 */
  assert.equal(app.run("parts.some(function(p){return p.id==='LJ-001';})"), false, '零件已删除');
  assert.equal(app.run('partLogs.length'), 1, '台账流水**不得**随零件删除而消失');
  assert.equal(J(app, 'partLogs')[0].id, logId, '流水原样保留');
  assert.equal(JSON.stringify(app.recorder.lastTx().keys), '["parts","logs"]',
    '删除零件只写 parts + logs（不得把 partLogs 一起重写/清空）');
  const html = app.run('renderPartLogs()');
  assert.ok(html.indexOf('LJ-001') >= 0, '台账页仍能查到已删零件的流水（追溯）');
  app.dispose();
});

test('C10 批量删除多选不串位（倒序删）且不动台账', async function () {
  const app = mkApp();
  await runPartIn(app, { 0: '5', 2: '5' });
  const logsBefore = J(app, 'partLogs').length;
  app.recorder.reset();
  app.setGlobal('selRows', { parts: new Set(['0', '2']) });   /* LJ-001 与 LJ-003 */
  await app.run("bulkDelete('parts')");
  const ids = idList(app, 'parts');
  assert.equal(JSON.stringify(ids), '["LJ-002","LJ-004"]', '只删被勾选的两行，不得串位: ' + JSON.stringify(ids));
  assert.equal(J(app, 'partLogs').length, logsBefore, '批量删除不得动台账');
  app.dispose();
});

/* ---- 真实 DB.tx（不打 recorder）+ 迷你假服务端：验证「失败/重试/双击」下的账实相符 ---- */
function mkFakeServerApp(initialParts, opts) {
  const state = {
    truth: {
      parts: JSON.parse(JSON.stringify(initialParts)),
      partLogs: [], logs: [], products: []
    },
    revs: { parts: 0, partLogs: 0, logs: 0 },
    forced: [],           /* 依次强制返回的状态码 */
    txBodies: [],
    txGate: null          /* 设成 Promise 即可把 /api/tx 挂在途中（稳定的「提交在途」窗口） */
  };
  const app = createApp(Object.assign({ installRecorder: false, quietConsole: true }, opts || {}));
  app.fakeServer = state;
  app.counters = { renderContent: 0, renderAll: 0 };   /* 用于证「第二次点击什么都没做」 */
  app.setGlobals({
    authToken: 'tok',
    currentUser: ADMIN,
    parts: JSON.parse(JSON.stringify(state.truth.parts)), partLogs: [], logs: [], products: [],
    orders: [], deliveries: [], productionPlans: [], productionReports: [], processTemplates: [], transfers: [],
    fields: { product: [], order: [] }, meta: { seq: 1 }, tblLayout: {}, uiDefaults: { order: {} },
    tblPage: {}, tblState: {}, selRows: {}, lastRowIds: {},
    serverData: JSON.parse(JSON.stringify(state.truth)), serverRevs: Object.assign({}, state.revs),
    renderContent: function () { app.counters.renderContent++; },
    renderAll: function () { app.counters.renderAll++; }
  });
  app.setFetch(async function (url, opts) {
    if (String(url).indexOf('/data') >= 0) {
      return { status: 200, ok: true, json: async () => ({ data: JSON.parse(JSON.stringify(state.truth)), revs: Object.assign({}, state.revs) }) };
    }
    const body = JSON.parse((opts && opts.body) || '{}');
    state.txBodies.push(body);
    /* 可控闸门：测试可用 state.txGate 把事务「挂在途中」，从而**稳定**复现「提交在途」窗口
       （不依赖微任务时序，避免在慢机器上偶发通过/偶发红） */
    if (state.txGate) await state.txGate;
    if (state.forced.length) {
      const code = state.forced.shift();
      return { status: code, ok: false, json: async () => ({ error: 'forced-' + code }) };
    }
    /* 乐观锁：任一 op 的 expectedRev 与当前 rev 不符 → 409，整批不写 */
    const stale = (body.ops || []).some(function (o) { return Number(o.expectedRev || 0) !== Number(state.revs[o.key] || 0); });
    if (stale) return { status: 409, ok: false, json: async () => ({ error: 'rev mismatch' }) };
    (body.ops || []).forEach(function (o) {
      state.truth[o.key] = JSON.parse(JSON.stringify(o.value));
      state.revs[o.key] = Number(state.revs[o.key] || 0) + 1;
    });
    return { status: 200, ok: true, json: async () => ({ revs: Object.assign({}, state.revs) }) };
  });
  installDom(app, { pi_qty_0: '100' });
  return app;
}

test('C11 真实 DB.tx：入库写库失败 → 内存/台账回灌服务器真值；重试只累加一次（不翻倍）', async function () {
  const app = mkFakeServerApp([{ id: 'X1', name: '件', spec: '', model: '', unit: '个', stockMax: 100, stockMin: 0, stock: 10, used: 0 }]);
  app.fakeServer.forced.push(500);              /* 第一次事务 500 */
  app.setGlobal('selRows', { parts: new Set(['0']) });
  await app.run('openPartIn()');
  await app.run('doPartIn()');
  assert.equal(app.run('parts[0].stock'), 10, '失败后内存必须回灌为服务器真值 10（不得停在乐观值 110）');
  assert.equal(app.run('partLogs.length'), 0, '失败后台账不得留下乐观流水');
  assert.equal(app.run('parts[0].stock'), app.fakeServer.truth.parts[0].stock, '内存 === 服务器真值');
  assert.equal(app.run('__piBusy'), false, '失败路径必须解锁（__piBusy=false），否则按钮永久卡死');

  /* 用户按提示重试（弹窗未关、输入仍在）：只应加一次 */
  await app.run('doPartIn()');
  assert.equal(app.run('parts[0].stock'), 110, '重试后必须是 10 + 100 = 110（**不得** 110 + 100）');
  assert.equal(app.run('partLogs.length'), 1, '重试后只应有 1 条流水');
  assert.equal(app.fakeServer.truth.parts[0].stock, 110, '服务端真值也是 110');
  assert.equal(J(app, 'partLogs')[0].stockBefore, 10, '流水 stockBefore 必须是真值 10');
  assert.equal(app.run('__piBusy'), false, '重试成功后同样是解锁态');
  assert.equal(app.sandbox.document.getElementById('pi_confirm').disabled, false, '重试成功后确认按钮恢复可点');
  app.dispose();
});

/** C12 的行为探针（§G5 变异注入复用：删掉重入锁后本函数必须抛错） */
async function probeConcurrentSubmitLocked(app) {
  /* 【.158 修复后契约】原用例钉的是**修复前**的现象：双击发 2 次 /api/tx，第二次被乐观锁 409 拦下，
     用户看到「数据已被他人修改」（其实是自己点了两下）。加提交重入锁后应为：只发 1 次事务、
     不出现该误导提示。**库存不翻倍**这条核心保证不变（两种实现都成立），故一并保留。
     ⚠ 强度要求（QA 裁决时加固）：不能只用「不含某串文案」的否定断言 ——
       无关提示（如「请至少填写一个」）会让它偶然成立；故这里显式断言 **alerts 长度必须为 0**
       （第二次调用必须完全静默），并逐字段核对台账快照取自**首次**真值（stockBefore=10 而非 110）。 */
  app.setGlobal('selRows', { parts: new Set(['0']) });
  await app.run('openPartIn()');
  /* 同一 tick 内两次点击（第一次 await 未返回） */
  const p1 = app.run('doPartIn()');
  const p2 = app.run('doPartIn()');
  await Promise.all([p1, p2]);

  /* ① 事务次数恰好 1（第二次连请求都不该发） */
  assert.equal(app.fakeServer.txBodies.length, 1, '提交重入锁：同一 tick 两次点击只发 1 次 /api/tx（修复前为 2 次）');
  assert.equal(app.fakeServer.txBodies[0].ops.length, 3, '那 1 次事务必须仍是 parts + partLogs + logs 三表原子提交');
  assert.deepEqual(app.fakeServer.txBodies[0].ops.map(function (o) { return o.key; }), ['parts', 'partLogs', 'logs'],
    '提交的表与顺序不得变（parts/partLogs/logs）');
  assert.equal(app.fakeServer.txBodies[0].ops[0].value[0].stock, 110,
    '提交给服务端的库存必须只加一次（110），不得是 210');

  /* ② 库存 / 台账：客户端与服务端各自只加一次、只 1 条 */
  assert.equal(app.fakeServer.truth.parts[0].stock, 110, '服务端库存只累加一次（10 + 100）');
  assert.equal(app.run('parts[0].stock'), 110, '客户端库存也是 110，不得停在 210');
  assert.equal(app.run('partLogs.length'), 1, '客户端台账只应 1 条（第二次不得再 unshift）');
  assert.equal(app.fakeServer.truth.partLogs.length, 1, '服务端台账只应有 1 条');
  assert.equal(J(app, 'partLogs')[0].qty, 100, '台账数量 = 一次入库量');
  assert.equal(J(app, 'partLogs')[0].stockBefore, 10, '台账 stockBefore 必须取**首次**真值 10（若取到 110，说明加锁前已重复累加）');
  assert.equal(J(app, 'partLogs')[0].stockAfter, 110, '台账 stockAfter = 110');
  assert.equal(app.fakeServer.truth.partLogs[0].stockBefore, 10, '服务端台账 stockBefore 同样是 10');
  assert.equal(app.run('partLogs.reduce(function(s,x){return s+x.qty;},0)'), 100, '台账 qty 合计 = 100（不得翻倍成 200）');

  /* ③ 第二次调用「什么都没做」：无任何提示、无重绘、勾选只清一次 */
  assert.equal(app.alerts.length, 0, '两次点击全程不得有任何 alert（第二次必须静默忽略）: ' + JSON.stringify(app.alerts));
  assert.ok(!app.alerts.some(function (a) { return a.indexOf('已被他人修改') >= 0; }), '不得弹误导性乐观锁提示');
  assert.equal(app.counters.renderContent, 1, '只重绘一次（第二次点击不得再走成功收尾）');
  assert.equal(app.run("selSet('parts').size"), 0, '成功后勾选被清空（且只清一次）');
  assert.equal(app.run('__piIdxs'), null, '成功后批次下标已置空');
  assert.equal(app.run('__piBusy'), false, '结束后必须是解锁态');
}

test('C12 真实 DB.tx：双击「确认入库」只提交 1 次（提交重入锁）→ 库存不翻倍、全程无 alert', async function () {
  const app = mkFakeServerApp([{ id: 'X1', name: '件', spec: '', model: '', unit: '个', stockMax: 100, stockMin: 0, stock: 10, used: 0 }]);
  try { await probeConcurrentSubmitLocked(app); } finally { app.dispose(); }
});

/* ---- 锁的边界（P2 未修）：提交在途时再次「入库」→ 第一条提交的收尾会关掉新弹窗并清空批次 ---- */
/* C13b 的行为探针（§G7 变异注入复用） */
async function probeReopenDuringFlight(app, dom) {
  /* 闸门：把批次 A 的事务挂在途中，保证下面「在途期间」的一切操作都在真实窗口里发生 */
  let release = null;
  app.fakeServer.txGate = new Promise(function (r) { release = r; });

  /* 批次 A：勾 X1，填 5，点确认（不 await → 提交在途） */
  app.setGlobal('selRows', { parts: new Set(['0']) });
  await app.run('openPartIn()');
  dom.values['pi_qty_0'] = '5';
  const inflight = app.run('doPartIn()');
  assert.equal(app.run('__piBusy'), true, '前置：批次 A 提交确实在途（__piBusy=true）');

  /* 用户以为没反应，改为勾 X2 再点「入库」→ 打开新弹窗（批次 B），并填 7 */
  app.setGlobal('selRows', { parts: new Set(['1']) });
  await app.run('openPartIn()');
  dom.values['pi_qty_1'] = '7';
  const openWhileBusy = app.sandbox.document.getElementById('modalBg').classList.contains('show');
  const idxsOfB = JSON.stringify(app.run('__piIdxs'));

  release();                        /* 放行批次 A 的事务 */
  app.fakeServer.txGate = null;
  await inflight;                   /* 批次 A 提交完成 */

  /* ① openPartIn 不被锁拦：提交进行中照样能打开弹窗（C 组第 2 条） */
  assert.equal(openWhileBusy, true, '提交进行中「入库」按钮必须仍能打开弹窗（锁只拦提交，不拦打开）');
  /* ② 新弹窗不得被上一条提交的收尾关掉 */
  assert.equal(app.sandbox.document.getElementById('modalBg').classList.contains('show'), true,
    '提交收尾不得关闭「不是自己那个」的新弹窗');
  /* ③ 新批次下标不得被置空，用户已填数量必须还在 */
  assert.equal(JSON.stringify(app.run('__piIdxs')), idxsOfB, '新批次下标必须原样保留（不得被第一条提交置 null）');
  assert.equal(dom.values['pi_qty_1'], '7', '用户在新弹窗里填的数量必须还在');
  /* ④ 批次 A 只入库一次，批次 B 一点都没提交 */
  assert.equal(app.run('parts[0].stock'), 15, '批次 A 已入库（10 + 5）');
  assert.equal(app.run('parts[1].stock'), 3, '批次 B 尚未提交，库存不得变动');
  assert.equal(app.fakeServer.txBodies.length, 1, '只有批次 A 的那一次事务');
  assert.equal(app.run('partLogs.length'), 1, '台账只应有批次 A 的 1 条');
  assert.equal(app.alerts.length, 0, '全程不得有任何 alert: ' + JSON.stringify(app.alerts));

  /* ⑤ 批次 B 仍可正常提交（新弹窗完好、批次未丢） */
  await app.run('doPartIn()');
  assert.equal(app.run('parts[1].stock'), 10, '批次 B 提交后 X2 = 3 + 7');
  assert.equal(app.run('partLogs.length'), 2, '台账新增 1 条（共 2 条）');
  assert.equal(app.run('__piBusy'), false, '结束后必须是解锁态');
}

const TWO_PARTS = function () {
  return [
    { id: 'X1', name: '件', spec: '', model: '', unit: '个', stockMax: 100, stockMin: 0, stock: 10, used: 0 },
    { id: 'X2', name: '件2', spec: '', model: '', unit: '个', stockMax: 100, stockMin: 0, stock: 3, used: 0 }
  ];
};

test('C13c 残留窗口自愈：在途期间开新窗后「立刻」点确认被锁静默忽略，再点一次即成功', async function () {
  /* 工程师 P2 采用方案②（批次归属守卫）后留下的窄窗口：在途期间开新窗 + 立刻点确认
     → 该次点击被 __piBusy 静默忽略（不报错、不关窗、不丢输入），用户再点一次就成功。 */
  const app = mkFakeServerApp(TWO_PARTS());
  const dom = installDom(app, {});
  let release = null;
  app.fakeServer.txGate = new Promise(function (r) { release = r; });

  /* 批次 A：勾 X1 填 5，点确认（挂在途中） */
  app.setGlobal('selRows', { parts: new Set(['0']) });
  await app.run('openPartIn()');
  dom.values['pi_qty_0'] = '5';
  const inflightA = app.run('doPartIn()');

  /* 批次 B：勾 X2 开新窗填 7，并**立刻**点确认（此时 A 仍在途） */
  app.setGlobal('selRows', { parts: new Set(['1']) });
  await app.run('openPartIn()');
  dom.values['pi_qty_1'] = '7';
  const ignored = app.run('doPartIn()');       /* 应被 __piBusy 静默忽略 */
  await ignored;                               /* 立即 resolve（什么都没做） */

  /* 被忽略的这次点击：不得发事务、不得提示、不得关窗、不得动输入 */
  assert.equal(app.run('__piBusy'), true, '前置：批次 A 仍在途');
  assert.equal(app.fakeServer.txBodies.length, 1, '第二次点击必须被静默忽略（只有批次 A 那 1 次事务）');
  assert.equal(app.alerts.length, 0, '静默忽略：不得有任何 alert: ' + JSON.stringify(app.alerts));
  assert.equal(app.sandbox.document.getElementById('modalBg').classList.contains('show'), true, '弹窗必须还在');
  assert.equal(dom.values['pi_qty_1'], '7', '用户填的数量必须还在');
  assert.equal(JSON.stringify(app.run('__piIdxs')), '[1]', '批次仍是 B');
  assert.equal(app.run('parts[1].stock'), 3, 'B 尚未提交');

  /* 放行 A：A 只提交自己的那一次，且不得收尾掉 B 的弹窗/批次 */
  release();
  app.fakeServer.txGate = null;
  await inflightA;
  assert.equal(app.run('parts[0].stock'), 15, 'A 已入库（10 + 5）');
  assert.equal(app.run('partLogs.length'), 1, '台账只有 A 的 1 条');
  assert.equal(app.sandbox.document.getElementById('modalBg').classList.contains('show'), true, 'A 收尾不得关闭 B 的弹窗');
  assert.equal(JSON.stringify(app.run('__piIdxs')), '[1]', 'A 收尾不得置空 B 的批次');
  assert.equal(app.run('__piBusy'), false, 'A 完成后锁已释放');
  assert.equal(confirmBtn(app).disabled, false, 'A 完成后确认按钮恢复可点');
  assert.equal(dom.values['pi_qty_1'], '7', '用户填的数量仍在（自愈前提）');

  /* 用户再点一次 → 成功（自愈闭环） */
  await app.run('doPartIn()');
  assert.equal(app.run('parts[1].stock'), 10, '第二次真点：X2 = 3 + 7');
  assert.equal(app.fakeServer.txBodies.length, 2, '共 2 次事务（A + B）');
  assert.equal(app.run('partLogs.length'), 2, '台账 2 条');
  assert.equal(app.alerts.length, 0, '全程无任何 alert');
  assert.equal(app.run('__piBusy'), false, '结束后解锁');
  app.dispose();
});

test('C13b [P2·.158 已修] 提交在途时再开入库弹窗：新弹窗与新批次都不得被上一条提交收尾掉',
  /* 修复方式（工程师 .158 同轮内修）：doPartIn 开头记 `const myIdx=__piIdxs` 作批次归属快照，
     成功收尾改为 `if(__piIdxs===myIdx){__piIdxs=null;closeModal();clearSel('parts');}` + 无条件 renderContent()。
     ⇒ 提交在途期间新开的弹窗不会被上一条提交关掉，用户填的数量不丢（本用例由 todo 转为正式断言）。 */
  async function () {
    const app = mkFakeServerApp(TWO_PARTS());
    const dom = installDom(app, {});
    try { await probeReopenDuringFlight(app, dom); } finally { app.dispose(); }
  });

/* ---- 锁生命周期：任何出口都必须解锁 + 还原按钮（否则按钮永久卡死，比原缺陷更糟） ---- */
function confirmBtn(app) { return app.sandbox.document.getElementById('pi_confirm'); }
function lockSnapshot(app) {
  const b = confirmBtn(app);
  return { busy: app.run('__piBusy'), disabled: b.disabled, label: b.innerHTML };
}
/* 已跑过的解锁探针（C13 用它把「早退条数」与「逐条测到」绑成同一件事） */
const UNLOCK_PROBES = [];
function assertUnlocked(app, ctx) {
  UNLOCK_PROBES.push(ctx);
  const s = lockSnapshot(app);
  assert.equal(s.busy, false, '[' + ctx + '] __piBusy 必须已释放（否则入库按钮永久卡死）');
  assert.equal(s.disabled, false, '[' + ctx + '] 确认按钮必须恢复可点');
  assert.notEqual(s.label, '入库中…', '[' + ctx + '] 按钮文案必须还原');
}

test('C13 提交重入锁生命周期：7 条早退 + 成功 + 2 类异常，10 条路径全部解锁且按钮还原', async function () {
  UNLOCK_PROBES.length = 0;   /* 本条自成一个对账单元（§G6 也会调 assertUnlocked，不能串味） */

  /* ① 无进行中批次 */
  let app = mkApp({ selRows: {} });
  installDom(app, {});
  await app.run('openPartIn()');          /* 被「请先勾选」拦下 → __piIdxs 保持 null */
  app.setGlobal('__piIdxs', null);
  await app.run('doPartIn()');
  assertUnlocked(app, '出口①无批次');
  app.dispose();

  /* ② 无写权限（先用管理员打开弹窗拿到批次，再降级账号） */
  app = mkApp({ selRows: { parts: new Set(['0']) } });
  installDom(app, { pi_qty_0: '5' });
  await app.run('openPartIn()');
  app.setGlobal('currentUser', READONLY);
  await app.run('doPartIn()');
  assertUnlocked(app, '出口②无权限');
  assert.equal(app.run('parts[0].stock'), 10, '无权限时不得改库存');
  app.dispose();

  /* ③ 非数字 ④ 负数 ⑤ 非整数（.159 新增） ⑥ 无数量（填 0 / 全留空）
     注意 ⑤ 与 ⑥ 的先后：`0.5` 撞 ⑤（正整数闸），`0` 过闸后走 continue、plan 为空 → 撞 ⑥。 */
  for (const [raw, label] of [
    ['abc', '出口③非数字'],
    ['-1', '出口④负数'],
    ['0.5', '出口⑤非整数（.159 新增整数闸）'],
    ['0', '出口⑥无数量']
  ]) {
    app = mkApp({ selRows: { parts: new Set(['0']) } });
    installDom(app, { pi_qty_0: raw });
    await app.run('openPartIn()');
    await app.run('doPartIn()');
    assertUnlocked(app, label);
    assert.equal(app.run('parts[0].stock'), 10, '[' + label + '] 库存不得变化');
    app.dispose();
  }

  /* ⑦ 事务失败 */
  /* ⑥ 事务失败 */
  app = mkApp({ selRows: { parts: new Set(['0']) } });
  installDom(app, { pi_qty_0: '5' });
  await app.run('openPartIn()');
  app.recorder.failNext('tx', 'boom');
  await app.run('doPartIn()');
  assertUnlocked(app, '出口⑦事务失败');
  /* 失败后可原样重试：说明锁没卡死（第二次能真的提交） */
  await app.run('doPartIn()');
  assert.equal(app.recorder.txCount(), 2, '失败后应能再次提交（锁已释放）');
  app.dispose();

  /* 成功路径 */
  app = mkApp({ selRows: { parts: new Set(['0']) } });
  installDom(app, { pi_qty_0: '5' });
  await app.run('openPartIn()');
  await app.run('doPartIn()');
  assertUnlocked(app, '成功路径');
  assert.equal(app.run('parts[0].stock'), 15, '成功路径库存 10 + 5');
  app.dispose();

  /* 抛异常（DB.tx 直接 throw，模拟未预料的运行时错误） */
  app = mkApp({ selRows: { parts: new Set(['0']) } });
  installDom(app, { pi_qty_0: '5' });
  await app.run('openPartIn()');
  app.run('DB.tx=function(){throw new Error("boom")}');
  await assert.rejects(app.run('doPartIn()'), /boom/, '异常必须向上抛（不得被 finally 吞掉）');
  assertUnlocked(app, '抛异常');
  app.dispose();

  /* ⑦ 成功收尾阶段抛异常：入库已提交，但 renderContent() 抛错（渲染层炸了也不能锁死按钮） */
  app = mkApp({ selRows: { parts: new Set(['0']) } });
  installDom(app, { pi_qty_0: '5' });
  await app.run('openPartIn()');
  app.run('renderContent=function(){throw new Error("render boom")}');
  await assert.rejects(app.run('doPartIn()'), /render boom/, '渲染异常必须向上抛（不得被 finally 吞掉）');
  assertUnlocked(app, '成功收尾 renderContent 抛异常');
  assert.equal(app.run('parts[0].stock'), 15, '入库本身已提交（10 + 5），不得因渲染失败而回退内存');
  assert.equal(app.recorder.txCount(), 1, '事务也只发一次');
  app.dispose();

  /* 静态兜底：解锁点必须唯一，且写在 finally 里；openPartIn 不得碰锁 */
  const fn = stripComments(extractFn(INDEX_SRC, 'doPartIn'));
  assert.equal(countOcc(fn, '__piBusy=false'), 1, '解锁点必须恰 1 处（多条出口各写一遍必漏）');
  assert.ok(/finally\s*\{[^}]*__piBusy=false/.test(fn), '唯一解锁点必须在 finally 内');
  assert.equal(countOcc(fn, '__piBusy=true'), 1, '占锁点必须恰 1 处');
  assert.ok(/if\s*\(\s*__piBusy\s*\)\s*return\s*;/.test(fn), '必须有重入判断（进入即拦）');
  /* 顺序守卫：重入判断必须在「占锁」之前 —— 否则该 return 会带着已置位的锁退出，永久卡死 */
  assert.ok(fn.indexOf('if(__piBusy)return;') < fn.indexOf('__piBusy=true'),
    '重入判断必须写在占锁之前（若占锁在前，该 return 会漏解锁 → 按钮永久卡死）');
  /* 早退条数核对 —— **计数规则**（.159 复核重写，务必先说清「数什么」，否则下一个人只会跟着改数字）：
       统计范围 = `stripComments(doPartIn)` 里 `try{` 与 `}finally` 之间的 `return;`。
       ① 先全部数出 = 8 处（.159）；
       ② 减去 **plan.forEach 回调内**的防御性 `if(!p)return;`（1 处，与锁无关）；
       ③ 「占锁前的重入 return」`if(__piBusy)return;` **本来就在 try 之外**，天然不计入；
       ⇒ 会影响锁的函数级早退 = 8 − 1 = **7 条**：
          ①无批次 ②无权限 ③非数字 ④负数 ⑤非整数（.159 新增） ⑥无数量 ⑦事务失败。
       关键纪律：**改这个数字必须同时补一条逐条用例**（下面的 UNLOCK_PROBES 对账就是为此）——
       只把 6 改成 7 而不新增「出口⑤」的解锁探针，等于把「7 条都测到」偷偷降级成「数对了但有一条没测」。 */
  const tryBlock = fn.slice(fn.indexOf('try{'), fn.indexOf('}finally'));
  const allReturns = countOcc(tryBlock, 'return;');
  const callbackReturns = countOcc(tryBlock, 'if(!p)return;');
  assert.equal(callbackReturns, 1, 'forEach 回调里的防御性 return 应恰 1 处（用于下面的对账）');
  assert.equal(allReturns - callbackReturns, 7,
    'try 内「函数级早退」必须恰 7 条（若新增出口，须**同时**更新本断言、下面 7 条探针、与 C15 的逐条用例）；实际 ' +
    (allReturns - callbackReturns));
  /* 逐条对账：计数与「真的逐条跑过」必须是同一件事，不能只改数字 */
  const exitProbes = UNLOCK_PROBES.filter(function (c) { return /^出口/.test(c); });
  assert.equal(exitProbes.length, 7, '实际跑过的早退探针必须也是 7 条，实际: ' + JSON.stringify(exitProbes));
  ['①', '②', '③', '④', '⑤', '⑥', '⑦'].forEach(function (mark) {
    assert.ok(exitProbes.some(function (c) { return c.indexOf(mark) === 2; }),
      '出口' + mark + ' 必须有独立的解锁探针（不能拿数字凑数）；实际: ' + JSON.stringify(exitProbes));
  });
  assert.equal(countOcc(stripComments(extractFn(INDEX_SRC, 'openPartIn')), '__piBusy'), 0,
    'openPartIn 不得被上一次的残留锁挡住（打开弹窗不应受提交态影响）');
});

/* ================================================================
   §D 拖拽排序参数化不污染产品（回归风险）
   ================================================================ */

test('D1 order.parts 与 order.product 双向互不污染', async function () {
  const app = mkApp({ uiDefaults: { order: { product: ['P1', 'P0'] } } });
  await app.run("saveUiDefaults({parts:['LJ-004','LJ-001']})");
  let v = J(app, 'uiDefaults');
  assert.equal(JSON.stringify(v.order.parts), '["LJ-004","LJ-001"]', '零部件名单写入 order.parts');
  assert.equal(JSON.stringify(v.order.product), '["P1","P0"]', '写 parts 不得覆盖 product');
  assert.equal(JSON.stringify(J(app, 'prodOrderOf()')), '["P1","P0"]', 'prodOrderOf 仍只读 product');
  assert.equal(JSON.stringify(J(app, 'partsOrderOf()')), '["LJ-004","LJ-001"]', 'partsOrderOf 只读 parts');

  /* 反向：再写 product，parts 不得被冲掉 */
  await app.run("saveUiDefaults({product:['P0','P1']})");
  v = J(app, 'uiDefaults');
  assert.equal(JSON.stringify(v.order.product), '["P0","P1"]', '产品名单已更新');
  assert.equal(JSON.stringify(v.order.parts), '["LJ-004","LJ-001"]', '写 product 不得覆盖 parts');

  /* 恢复录入顺序（传 null）也只清自己那一份 */
  await app.run("saveUiDefaults({parts:null})");
  v = J(app, 'uiDefaults');
  assert.equal(v.order.parts, undefined, 'parts 名单已删除');
  assert.equal(JSON.stringify(v.order.product), '["P0","P1"]', '清 parts 不得连带清掉 product');
  app.dispose();
});

test('D2 排序实现单源：两表都是同一实现的薄封装，不存在第二份排序逻辑', function () {
  const plain = stripComments(INDEX_SRC);
  assert.equal((plain.match(/function\s+sortedByOrderOf\s*\(/g) || []).length, 1, '排序核心函数恰 1 个');
  assert.equal((plain.match(/function\s+\w*SortedByOrder\s*\(/g) || []).length, 2,
    '只许 productsSortedByOrder / partsSortedByOrder 两个薄封装');

  const prodFn = wsFree(stripComments(extractFn(INDEX_SRC, 'productsSortedByOrder')));
  const partsFn = wsFree(stripComments(extractFn(INDEX_SRC, 'partsSortedByOrder')));
  assert.match(prodFn, /^functionproductsSortedByOrder\(\)\{returnsortedByOrderOf\(products,prodOrderOf\(\)\);\}$/,
    '产品侧必须只是薄封装: ' + prodFn);
  assert.match(partsFn, /^functionpartsSortedByOrder\(\)\{returnsortedByOrderOf\(parts,partsOrderOf\(\)\);\}$/,
    '零部件侧必须只是薄封装: ' + partsFn);
  assert.ok(!/\.sort\(|localeCompare/.test(partsFn), '零件侧封装内不得再写一份排序');

  /* 拖拽引擎必须经表单元数据指向这两个实现（不得在引擎里 if(form) 各写一套） */
  assert.ok(plain.indexOf('sorted:productsSortedByOrder') >= 0, 'PD_FORMS.product.sorted 指向产品实现');
  assert.ok(plain.indexOf('sorted:partsSortedByOrder') >= 0, 'PD_FORMS.parts.sorted 指向零件实现');
  assert.equal(countOcc(plain, 'sortedByOrderOf('), 3,
    'sortedByOrderOf 只许「1 处定义 + 2 个薄封装调用」（新增第三张表时须显式更新本断言）');
});

test('D3 缺省回落：不传 form 时行为等同 product（参数化不得把既有产品拖拽搞坏）', function () {
  const app = mkApp({ uiDefaults: { order: { product: ['P1'] } } });
  app.setGlobal('_pdLastForm', 'product');
  /* 缺省 = product：在 product 表上做筛选 → 无参判定必须为 true */
  app.run("tState('product').filters={name:{mode:'contains',val:'甲'}}");
  assert.equal(app.run('prodFilterActive()'), true, '无参缺省必须取 product');
  assert.equal(app.run("prodFilterActive('product')"), true, '显式 product 与缺省一致');
  assert.equal(app.run("prodFilterActive('parts')"), false, '零件表未筛选，不得被产品筛选串味');

  /* 每页条数恢复：无参时写回 product */
  app.setGlobal('tblPage', {});
  const partsSizeBefore = app.run("pageSizeOf('parts')");
  app.run('prodRestorePageSize(37)');
  assert.equal(app.run("pageSizeOf('product')"), 37, '无参恢复必须落到 product');
  assert.equal(app.run("pageSizeOf('parts')"), partsSizeBefore, '不得把 parts 的每页条数改掉');

  /* 全部显示判定：无参 = product 行数 */
  assert.equal(app.run('prodAllShown()'), app.run('prodAllShown("product")'), '无参必须等同 product');
  /* 源码兜底：缺省字面量必须是 product（不是 parts），保证既有调用点零改动 */
  const src = stripComments(INDEX_SRC);
  assert.ok(src.indexOf("_pdLastForm||'product'") >= 0, '缺省回落值必须是 product');
  assert.ok(!/_pdLastForm\|\|'parts'/.test(src), '缺省回落不得写成 parts');
  assert.ok(/var _pdLastForm='product';/.test(src), '_pdLastForm 初值必须是 product');
  app.dispose();
});

test('D4 产品拖拽落库路径回归（不复用工程师改过的 F2/F7 用例）', async function () {
  /* 直接驱动 prodDragFinish（拖拽收尾的真实落库函数）：
     st.form 缺省（模拟 .156 产品行没有 data-pdform 的历史形态）→ 必须写 order.product。 */
  const app = mkApp({ uiDefaults: { order: {} } });
  installDom(app, {});
  const tbody = {
    querySelectorAll: function () {
      return [{ dataset: { pid: 'P1' } }];   /* DOM 里只有 P1（其余走「补齐」） */
    }
  };
  const st = { form: undefined, pid: 'P1', tr: { classList: { remove: function () {} } }, tbody: tbody, dirty: true, restoreSize: 0 };
  app.setGlobal('__qaSt', st);
  await app.run('prodDragFinish(__qaSt)');

  const sets = app.recorder.of('set').filter(function (c) { return c.key === 'uiDefaults'; });
  assert.equal(sets.length, 1, '收尾必须恰写一次 uiDefaults');
  const val = sets[0].value;
  assert.ok(Array.isArray(val.order.product), '缺省 form ⇒ 必须写 order.product，实际 keys=' + JSON.stringify(Object.keys(val.order)));
  assert.equal(JSON.stringify(val.order.product), '["P1"]', '产品名单 = DOM 行序（+ 补齐）');
  assert.equal(val.order.parts, undefined, '**不得**顺手写入 order.parts（污染零部件名单）');
  assert.ok(J(app, 'logs').some(function (l) { return l.target === '产品主数据'; }) ||
    app.recorder.of('save').some(function (c) { return c.key === 'logs'; }),
    '保存顺序必须写操作日志（.155「排序无效」正是靠日志命中与否定性的）');
  app.dispose();
});

test('D4b 零部件拖拽落库只写 order.parts，产品名单原样', async function () {
  const app = mkApp({ uiDefaults: { order: { product: ['P1'] } } });
  installDom(app, {});
  const tbody = { querySelectorAll: function () { return [{ dataset: { pid: 'LJ-002' } }, { dataset: { pid: 'LJ-001' } }]; } };
  app.setGlobal('__qaSt2', { form: 'parts', pid: 'LJ-002', tr: { classList: { remove: function () {} } }, tbody: tbody, dirty: true, restoreSize: 0 });
  await app.run('prodDragFinish(__qaSt2)');

  const sets = app.recorder.of('set').filter(function (c) { return c.key === 'uiDefaults'; });
  assert.equal(sets.length, 1);
  const val = sets[0].value;
  assert.equal(JSON.stringify(val.order.parts), '["LJ-002","LJ-001","LJ-003","LJ-004"]',
    '零件名单 = DOM 行序 + 按当前生效顺序补齐（不得丢行）');
  assert.equal(JSON.stringify(val.order.product), '["P1"]', '零件拖拽不得改动产品名单');
  app.dispose();
});

test('D4c 拖拽不写盘（未移动 dirty=false）→ 不动任何名单', async function () {
  const app = mkApp({ uiDefaults: { order: { product: ['P1'] } } });
  installDom(app, {});
  app.setGlobal('__qaSt3', { form: 'product', pid: 'P1', tr: { classList: { remove: function () {} } }, tbody: { querySelectorAll: function () { return []; } }, dirty: false, restoreSize: 0 });
  await app.run('prodDragFinish(__qaSt3)');
  assert.equal(app.recorder.of('set').length, 0, '只按了一下没移动 → 不得写 uiDefaults');
  app.dispose();
});

test('D5 工程师对 product-order-drag.156 的改动评审：F2/F7 守的事实一条都没少', function () {
  /* 项目铁律：测试资产需与产品代码同等评审。「参数化必然导致」的改写可以接受，
     但**被守的事实**（不是字面量）不许少一条。这里逐条核对。 */
  const f2 = stripComments(extractTestBlock(DRAG156_SRC, 'F2 '));
  const f7 = stripComments(extractTestBlock(DRAG156_SRC, 'F7 '));

  /* F2 原始守的 4 件事 */
  assert.ok(f2.indexOf('prodAllShown') >= 0, 'F2 仍在守「必须先判全部显示」');
  assert.ok(f2.indexOf('size:1000') >= 0, 'F2 仍在守「自动切 1000 条/页」');
  assert.ok(f2.indexOf('restoreSize') >= 0, 'F2 仍在守「记住原每页条数」');
  assert.ok(f2.indexOf('prodRestorePageSize') >= 0, 'F2 仍在守「结束后恢复」');
  /* F7 原始守的 4 件事（注意原用例里的正则是转义过的 `tr\[data-pid\]`） */
  assert.ok(f7.indexOf('tr\\[data-pid\\]') >= 0, 'F7 仍在守「读 tbody 实际行序」');
  assert.ok(f7.indexOf('.sorted()') >= 0 || f7.indexOf('SortedByOrder') >= 0, 'F7 仍在守「补齐用当前生效顺序」');
  assert.ok(f7.indexOf('saveUiDefaults') >= 0, 'F7 仍在守「名单落库」');
  assert.ok(f7.indexOf('logOp') >= 0, 'F7 仍在守「必须写操作日志」');
  /* 断言条数不得少于改造前（F2 原 5 条、F7 原 5 条；现在反而更多） */
  assert.ok((f2.match(/assert\./g) || []).length >= 5, 'F2 断言条数不得减少，实际 ' + (f2.match(/assert\./g) || []).length);
  assert.ok((f7.match(/assert\./g) || []).length >= 5, 'F7 断言条数不得减少，实际 ' + (f7.match(/assert\./g) || []).length);
  /* 参数化后的新守卫必须在位（否则「产品仍然写 product 键」就没人守了） */
  assert.ok(f2.indexOf("'product'") >= 0, 'F2 必须显式守「缺省回落 product」');
  assert.ok(f7.indexOf('patch[form]') >= 0 || f7.indexOf('patch\\[form\\]') >= 0, 'F7 必须守「名单按表单键分开存」');
});

/* ================================================================
   §E 权限与安全
   ================================================================ */

/* 服务端：用临时目录隔离 data/users，避免碰仓库里的真实文件 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qa158-'));
process.env.PROD_DATA_FILE = path.join(TMP, 'data.json');
process.env.PROD_USERS_FILE = path.join(TMP, 'users.json');
fs.writeFileSync(process.env.PROD_USERS_FILE, JSON.stringify([
  { username: 'admin', name: '管理员', role: 'admin', status: 'active', salt: 's', hash: 'h', perms: {} }
]));
const srv = require(path.join(ROOT, 'server', 'server.js'));
test.after(function () { fs.rmSync(TMP, { recursive: true, force: true }); });

function U(perms, role) { return { username: 'u', name: 'u', role: role || 'staff', status: 'active', perms: perms || {} }; }

test('E1 服务端 canWrite：parts / partLogs 只听 p.parts（admin 恒放行、显式 false 拒绝、未登录拒绝）', function () {
  /* admin 恒放行 */
  assert.equal(srv.canWrite(U({}, 'admin'), 'parts'), true, 'admin 恒放行 parts');
  assert.equal(srv.canWrite(U({}, 'admin'), 'partLogs'), true, 'admin 恒放行 partLogs');
  /* 授权 */
  assert.equal(srv.canWrite(U({ parts: true }), 'parts'), true, 'p.parts===true 放行 parts');
  assert.equal(srv.canWrite(U({ parts: true }), 'partLogs'), true, 'p.parts===true 放行 partLogs（同权限点）');
  /* 拒绝 */
  assert.equal(srv.canWrite(U({}), 'parts'), false, '无权限 → 拒绝');
  assert.equal(srv.canWrite(U({}), 'partLogs'), false, '无权限 → 拒绝');
  assert.equal(srv.canWrite(U({ parts: false }), 'parts'), false, '**显式 false 必须拒绝**（不得因键存在而放行）');
  assert.equal(srv.canWrite(U({ parts: false }), 'partLogs'), false, '显式 false 同拒 partLogs');
  assert.equal(srv.canWrite(U({ parts: 'true' }), 'parts'), false, '非布尔真值不得放行（严格 === true）');
  assert.equal(srv.canWrite(U({ parts: 1 }), 'parts'), false, '数字 1 不得放行');
  assert.equal(srv.canWrite(U({ parts: true }), 'uiDefaults'), false, 'parts 权限不得外溢到 uiDefaults');
  assert.equal(srv.canWrite(null, 'parts'), false, '未登录 false');
  assert.equal(srv.canWrite(undefined, 'partLogs'), false, '未登录 false');
  /* 反向：别的权限点不得授予 parts */
  assert.equal(srv.canWrite(U({ products: true, invOrders: true, dailyPlans: true }), 'parts'), false,
    '产品/订单/排产权限不得隐含零件写权');
  assert.equal(srv.canWrite(U({ parts: true }), 'products', { data: { products: [] }, value: [{ id: 'X' }] }), false,
    '零件权限不得外溢到产品主数据');
  /* DEFAULT_DATA 必须登记两表（漏登记 = 线上 400「未知数据表」） */
  assert.ok(srv.DEFAULT_DATA && srv.DEFAULT_DATA.parts !== undefined, 'DEFAULT_DATA.parts 必须注册');
  assert.ok(srv.DEFAULT_DATA && srv.DEFAULT_DATA.partLogs !== undefined, 'DEFAULT_DATA.partLogs 必须注册');
  assert.ok(Array.isArray(srv.DEFAULT_DATA.parts) && Array.isArray(srv.DEFAULT_DATA.partLogs), '两表初值必须是数组');
});

test('E2 前端权限映射：formToKey / PERM_FORMS / FORM_ACTS / canAct', function () {
  const app = mkApp();
  assert.equal(app.run("formToKey('parts')"), 'parts', "formToKey('parts') === 'parts'");
  assert.equal(app.run("formToKey('partLogs')"), 'parts', "formToKey('partLogs') === 'parts'（台账归同一权限点）");
  assert.equal(app.run("PERM_FORMS['parts']"), '零部件数据', 'PERM_FORMS.parts 存在且文案正确');
  assert.equal(app.run("FORM_ACTS['parts'] && FORM_ACTS['parts'].partIn"), '入库', 'FORM_ACTS.parts.partIn 存在');
  /* 写权限映射 */
  app.setGlobal('currentUser', { username: 'x', role: 'staff', perms: { parts: true } });
  assert.equal(app.run("canWriteForm('parts')"), true, 'perms.parts=true → 可写');
  assert.equal(app.run("canWriteForm('partLogs')"), true, 'perms.parts=true → 台账同权');
  app.setGlobal('currentUser', { username: 'x', role: 'staff', perms: { parts: false } });
  assert.equal(app.run("canWriteForm('parts')"), false, '显式 false → 不可写');
  /* canAct：acts 未配置 → 宽松放行；显式 false → 拒绝 */
  app.setGlobal('currentUser', { username: 'x', role: 'staff', perms: { parts: true } });
  assert.equal(app.run("canAct('parts.partIn')"), true, 'perms.acts 未配置 → 放行（宽松期口径）');
  app.setGlobal('currentUser', { username: 'x', role: 'staff', perms: { parts: true, acts: { 'parts.partIn': false } } });
  assert.equal(app.run("canAct('parts.partIn')"), false, '显式 acts 为 false → 拒绝');
  app.setGlobal('currentUser', { username: 'x', role: 'staff', perms: { parts: true, acts: { 'parts.partIn': true } } });
  assert.equal(app.run("canAct('parts.partIn')"), true, '显式 true → 放行');
  app.setGlobal('currentUser', null);
  assert.equal(app.run("canAct('parts.partIn')"), false, '未登录 → false');
  app.dispose();
});

test('E3 只读账号：批量栏无「新增/入库/编辑/复制/删除」，但「全选/导出选中」仍在', function () {
  const ro = mkApp({ currentUser: READONLY, lastRowIds: { parts: ['0', '1'] }, selRows: {} });
  const bar = ro.run("bulkBar('parts')");
  assert.equal(typeof bar, 'string');
  assert.ok(bar.indexOf('全选') >= 0, '只读账号仍应能「全选」');
  assert.ok(bar.indexOf('导出选中') >= 0, '只读账号仍应能「导出选中」');
  ['partModal(', 'openPartIn()', 'bulkSingle', 'bulkDelete'].forEach(function (needle) {
    assert.ok(bar.indexOf(needle) < 0, '只读账号批量栏不得出现写操作（命中 ' + needle + '）');
  });
  /* 页面标题栏的「新增零部件」按钮同样必须隐藏 */
  const html = ro.run('renderParts()');
  assert.ok(html.indexOf('onclick="partModal()"') < 0, '只读账号不得看到「新增零部件」按钮');
  assert.ok(html.indexOf('onclick="openPartIn()"') < 0, '只读账号不得看到「入库」按钮');
  assert.ok(html.indexOf('全选') >= 0 && html.indexOf('导出选中') >= 0, '只读视图仍保留全选 / 导出选中');
  ro.dispose();

  /* 对照：管理员全都在 */
  const admin = mkApp({ lastRowIds: { parts: ['0', '1'] }, selRows: {} });
  const abar = admin.run("bulkBar('parts')");
  ['partModal()', 'openPartIn()', 'bulkSingle', 'bulkDelete', '全选', '导出选中'].forEach(function (needle) {
    assert.ok(abar.indexOf(needle) >= 0, '管理员批量栏缺少: ' + needle);
  });
  assert.ok(admin.run('renderParts()').indexOf('onclick="partModal()"') >= 0, '管理员应看到「新增零部件」');
  admin.dispose();
});

test('E4 只读账号：delPart / openPartIn / doPartIn 均有函数级守卫（F12 绕过按钮也拦得住）', async function () {
  const app = mkApp({ currentUser: READONLY, selRows: { parts: new Set(['0']) } });
  installDom(app, { pi_qty_0: '999' });
  await app.run('openPartIn()');
  await app.run('doPartIn()');
  await app.run('delPart(0)');
  assert.equal(app.run('parts.length'), 4, '只读账号不得删除零件');
  assert.equal(J(app, 'parts')[0].stock, 10, '只读账号不得入库');
  assert.equal(app.run('partLogs.length'), 0, '只读账号不得写台账');
  assert.equal(app.recorder.txCount(), 0, '只读账号不得发起任何事务');
  /* openPartIn 与 delPart 各弹一次；doPartIn 因「没有进行中的入库批次」（__piIdxs 空）静默早退，
     不会再打扰用户一次 —— 这属于合理的交互，不要求它重复提示。 */
  assert.equal(app.alerts.filter(function (a) { return a.indexOf('无该表单的编辑权限') >= 0; }).length, 2,
    'openPartIn / delPart 两个入口应各给一次权限提示: ' + JSON.stringify(app.alerts));
  app.dispose();
});

test('E4b [KNOWN GAP] savePart 无函数级写权限守卫（与 saveProduct 同款的既有缺口）', async function () {
  /* 事实：partModal() 有 ensureWrite，但 savePart() 自身没有 —— 与产品侧 productModal/saveProduct
     完全同款（.158 沿用了既有形态，非本轮新引入的回归）。服务端 canWrite 是硬闸，故不会真落库，
     但 F12 直调 savePart 会在**内存**里留下一条幽灵行（DB.tx 403 失败后内存不回滚，见 tests/README §7.1）。 */
  assert.equal(/ensureWrite\(/.test(stripComments(extractFn(INDEX_SRC, 'savePart'))), false,
    '【现状登记】若工程师已补上 ensureWrite，本断言应改为 true（即：已修复 → 请更新此用例）');
  assert.equal(/ensureWrite\(/.test(stripComments(extractFn(INDEX_SRC, 'saveProduct'))), false,
    '产品侧同样是既有缺口（一致性核对）');
  assert.equal(srv.canWrite(U({ parts: false }), 'parts'), false, '服务端硬闸必须拒绝（真实防线的在这一侧）');

  const ro = mkApp({ currentUser: READONLY });
  installDom(ro, { pj_id: 'LJ-GHOST', pj_name: '幽灵行', pj_unit: '个' });
  await ro.run('savePart(-1)');
  assert.equal(ro.run('parts.length'), 5, '（现状）客户端内存会被写入幽灵行');
  assert.equal(ro.recorder.txCount(), 1, '（现状）会发起一次注定被服务端 403 的事务');
  ro.dispose();
});

/* ================================================================
   §R 菜单与路由接线
   ================================================================ */

test('R1 菜单位置：零部件数据紧随产品主数据、零部件台账紧随调拨台账（共 12 项）', function () {
  const s = INDEX_SRC.indexOf('const NAV=[');
  const nav = INDEX_SRC.slice(s, INDEX_SRC.indexOf('];', s));
  const ids = (nav.match(/\{id:'[^']+'/g) || []).map(function (x) { return x.slice(5, -1); });
  assert.equal(ids.length, 12, '菜单共 12 项（README 同步声明 12 项），实际: ' + ids.join(','));
  const at = function (id) { const i = ids.indexOf(id); assert.ok(i >= 0, '菜单缺少 ' + id); return i; };
  assert.equal(at('parts'), at('product') + 1, '零部件数据必须**紧邻**产品主数据之后');
  assert.equal(at('partLogs'), at('transfers') + 1, '零部件台账必须**紧邻**调拨台账之后');
  assert.ok(nav.indexOf("label:'零部件数据'") >= 0 && nav.indexOf("label:'零部件台账'") >= 0, '菜单文案');
  /* README 的「共 12 项」必须与实现一致（文档漂移守卫） */
  assert.ok(README_SRC.indexOf('左侧菜单共 **12 项**') >= 0, 'README 菜单项数声明应为 12');
  /* 路由接线 + 分页 + 筛选栏启用 */
  const flat = stripComments(INDEX_SRC);
  assert.ok(/case 'parts':\s*c\.innerHTML=renderParts\(\);/.test(flat), 'renderContent 必须接 parts');
  assert.ok(/case 'partLogs':\s*c\.innerHTML=renderPartLogs\(\);/.test(flat), 'renderContent 必须接 partLogs');
  assert.ok(/PAGED_FORMS=\{[^}]*parts:1,partLogs:1\}/.test(flat), '两页都应启用分页（仿台账/列表）');
  assert.ok(/PARTS_COLS=\[[\s\S]*?\]/.test(flat) && (flat.match(/PARTS_COLS=\[/) || []).length === 1,
    '固定列定义恰 1 处（不接字段设置）');
  const cols = flat.slice(flat.indexOf('PARTS_COLS=['), flat.indexOf('];', flat.indexOf('PARTS_COLS=[')));
  assert.equal((cols.match(/\{key:/g) || []).length, 11, '列定义必须 11 列');
  ['编码', '名称', '规格', '型号', '单位', '最大库存量', '最小库存量', '库存', '已占用', '结余', '结余进度'].forEach(function (label, i) {
    const pos = cols.indexOf("label:'" + label + "'");
    assert.ok(pos >= 0, '缺少列: ' + label);
    if (i === 0) assert.ok(pos < cols.indexOf("label:'名称'"), '列顺序：编码必须最前');
  });
});

/* ================================================================
   §F 版本水印 8 锚点（缺一即 FAIL）
   ================================================================
   .159 QA 复核补注（「锚点到底几处」已经坑过两次，一次说清楚，别再浮）：
     · ①~⑧ 是**外部锚点**：index.html / build.js / 两个 independent / guide.js / README / layout；
     · 本文件自身的 `const BUILD/PREV`（上面那两行）是**第 9 处** —— 独立副本，故意留着手改；
     · `tests/parts.<NNN>.test.js` 这类 per-version 用例**不再是锚点**：
       .159 已把 `parts.159.test.js` C7 与 `parts.158.test.js` F1 改成**从 build.BUILD 派生**
       （前者吃 `buildMarkRe(build.BUILD)`，后者吃「日期段 + .NNN 段」并限定在文首）。
       它们不再持有字面量 ⇒ **下一版推进无需手改它们**，这是刻意的「一劳永逸」形态。
     · ⇒ **推进一版要手改的测试文件 = 5 个**（build.js + qa.ppshift + qa.prodplan-query +
       layout.scoped.independent + 本文件），外加 3 个产出入水口（index.html / guide.js / README）。
     · 谁再往任何 `tests/*.test.js` 里抄回版本字面量，会被
       `tests/qa.parts-ledger.validate.159.test.js §D3` 的**禁止持有**扫描当场抓住。
   ================================================================ */

test('F1 锚点① index.html 权威水印恰 1 处（当前 build ' + BUILD + '；上一版 ' + PREV + ' 应 0 处）', function () {
  assert.equal(countOcc(INDEX_SRC, '>build ' + BUILD + '<'), 1,
    '权威水印必须恰 1 处（deploy.sh 按此提取版本）');
  assert.equal(countOcc(INDEX_SRC, '>build ' + PREV + '<'), 0, '上一版本水印不得残留');
});

test('F2 锚点② tests/harness/build.js 的 BUILD/PREV 必须手写（不得从 index.html 反推）', function () {
  assert.ok(countOcc(BUILD_HARNESS_SRC, "const BUILD = '" + BUILD + "';") === 1,
    "build.js 必须手写 const BUILD = '" + BUILD + "';");
  assert.ok(countOcc(BUILD_HARNESS_SRC, "const PREV = '" + PREV + "';") === 1,
    "build.js 必须手写 const PREV = '" + PREV + "';");
  assert.ok(countOcc(BUILD_HARNESS_SRC, 'readFileSync') === 0, 'build.js 不得读 index.html 反推版本（会退化成恒真）');
  const mod = require('./harness/build');
  assert.equal(mod.BUILD, BUILD, '运行时 BUILD 值');
  assert.equal(mod.PREV, PREV, '运行时 PREV 值');
});

test('F3 锚点③④⑤：两个 independent 测试文件的硬编码字面量已同步', function () {
  assert.ok(PPSHIFT_SRC.indexOf("assert.equal(build.BUILD, '" + BUILD + "'") >= 0, '③ qa.ppshift-advance §E2 BUILD');
  assert.ok(PPSHIFT_SRC.indexOf("assert.equal(build.PREV, '" + PREV + "'") >= 0, '③ qa.ppshift-advance §E2 PREV');
  assert.ok(PRODPLAN_QUERY_SRC.indexOf("assert.equal(build.BUILD, '" + BUILD + "'") >= 0, '④ qa.prodplan-query §E2 BUILD');
  assert.ok(PRODPLAN_QUERY_SRC.indexOf("assert.equal(build.PREV, '" + PREV + "'") >= 0, '④ qa.prodplan-query §E2 PREV');
  assert.ok(PRODPLAN_QUERY_SRC.indexOf(BUILD_DATE + '（build .' + BUILD_NO + '）') >= 0,
    '⑤ qa.prodplan-query §E4 guide 版本行（应为 ' + BUILD_DATE + '（build .' + BUILD_NO + '））');
});

test('F4 锚点⑥⑦：guide.js 文首「更新」行 + README 当前版本', function () {
  const head = GUIDE_SRC.split('\n').slice(0, 8).join('\n');
  assert.ok(head.indexOf('更新：' + BUILD_DATE + '（build .' + BUILD_NO + '）') >= 0,
    '⑥ guide.js 文首更新行（前 8 行内，应为 更新：' + BUILD_DATE + '（build .' + BUILD_NO + '））');
  assert.ok(README_SRC.indexOf('当前版本：`build ' + BUILD + '`') >= 0, '⑦ README.md 当前版本');
});

test('F5 锚点⑧ layout.scoped.independent §C5 已同步', function () {
  assert.ok(LAYOUT_INDEP_SRC.indexOf('>build ' + String(BUILD).replace(/\./g, '\\.') + '<') >= 0,
    '⑧ §C5 水印断言（应为 >build ' + BUILD + '< 的转义正则）');
  assert.ok(LAYOUT_INDEP_SRC.indexOf("BUILD.BUILD, '" + BUILD + "'") >= 0, '⑧ §C5 BUILD 值');
  assert.ok(LAYOUT_INDEP_SRC.indexOf("BUILD.PREV, '" + PREV + "'") >= 0, '⑧ §C5 PREV 值');
});

test('F6 完整版本号除权威水印外不得出现在注释里（只许【build .NNN】短形态）', function () {
  assert.equal(countOcc(INDEX_SRC, BUILD), 1, 'index.html 中完整版本号 ' + BUILD + ' 必须恰 1 处（即水印）');
  assert.equal(countOcc(INDEX_SRC, 'build ' + BUILD), 1, '「build <完整版本号>」也只许 1 处');
  assert.equal(countOcc(GUIDE_SRC, BUILD), 0, 'guide.js 正文不得写完整版本号（只许 build .' + BUILD_NO + '）');
  /* 注释形态守卫（.160 起改用**版本无关**判据；判别力经 QA 变异注入复核，与理想判别力齐平）：
       · 原判据「历史注释里【build .<PREV>】应当很多」写成 `countOcc(...,'build .'+PREV_NO) >= 10`，
         它实际把 **.158 那一版的注释体量（29 处）** 当成了恒定不变量。.159 只新增 3 处注释，
         于是 PREV_NO 推进到 '159' 时该断言必然假失败（实测 count('build .159')=3 < 10）——
         这不是回归，是判据绑定了某一版的大小（与 .148「另有 N 处」同类坑）。
         补证：该 `>= 10` 是 **.159 那一版才加入的**（更早提交里没有），当时 PREV_NO='158' 恰有 29 处，
         它从诞生起就只有一版寿命。改判据，四条各守一件事：
         ① 非本版的「历史短形态标记」总量 >= 10 —— 旧注释被批量改写成新版本时总量会骤降，仍能抓住；
         ①b 历史标记的**版本多样性** >= 5 —— 批量改写会把多标签收敛成 1~2 个。
            补这一条的原因：只靠 ① 时，.158 的 29 处存量单独就满足「>= 10」（实测 29 >= 10），
            即便把其余历史版本全抹掉 ① 照样绿，抓不住「只留一版存量」；
         ② 上一版 PREV_NO 标记 >= 3 —— 见下方【常驻契约】说明；
         ③ 本版 BUILD_NO 标记 >= 3 —— 本次改动点必须留下版本标记（缺则说明注释没写/写成了完整版本号）。

       【常驻契约 · .160 起生效 —— ② 的 `>= 3` 不是碰巧值，请勿顺手调低】
         · 依据：由 ③ 归纳。③ 要求**每一版**的改动点至少留下 3 处【build .NNN】短形态标记；
           那么任一版 N 里的「上一版」= N-1，其标记数在 N-1 当时已被 ③ 要求 >= 3，
           且一版冻结后不会再被删（删了正是本节要抓的回归）⇒ PREV_NO 的标记数恒 >= 3。
           所以 `>= 3` 与版本号推进**无关**，不存在原判据「绑定某版体量」的问题。
         · 因此本判据的准确性**依赖 ③ 持续成立**。若将来某版确实只该留 1~2 处标记
           （例如纯文案订正、单点改动），**必须同步调整本判据并在注释里写明原因**，
           **不许**静默把阈值放宽（`>= 1` 会漏掉「3 处被删 2 处」这种真实回归 —— QA 已实测漏报）。
         · 反过来：若某版出现「上一版标记 < 3」，先别急着怀疑本判据 —— 按契约 ③ 它不该发生，
           优先查是不是上一版的注释被误删/被批量改写（那才是真回归）。 */
  const allShort = INDEX_SRC.match(/build \.\d{2,4}/g) || [];
  const historic = allShort.filter(function (s) { return s !== 'build .' + BUILD_NO; });
  assert.ok(historic.length >= 10,
    '历史注释（非本版）短形态标记应 >= 10 处（实际 ' + historic.length + ' 处）——旧注释不得被批量改写');
  assert.ok(Array.from(new Set(historic)).length >= 5,
    '历史注释应保留 >= 5 个不同版本标签（实际 ' + Array.from(new Set(historic)).length + '：' +
    Array.from(new Set(historic)).join(',') + '）——批量改写会把标签收敛成 1~2 个');
  assert.ok(countOcc(INDEX_SRC, 'build .' + PREV_NO) >= 3,
    '上一版【build .' + PREV_NO + '】标记不得被抹除（应 >= 3 处，实际 ' +
    countOcc(INDEX_SRC, 'build .' + PREV_NO) + ' 处）——阈值依据 ③ 的归纳，见上方【常驻契约】');
  assert.ok(countOcc(INDEX_SRC, 'build .' + BUILD_NO) >= 3,
    '本版新增注释应有【build .' + BUILD_NO + '】标记（实际 ' + countOcc(INDEX_SRC, 'build .' + BUILD_NO) + ' 处，至少 3）');
  /* ④ 结构性自检 —— **如实标注：本条恒真，不是守卫，拦不住回归**。
       · 改前的写法对一个**硬编码字符串字面量**（内容仅「只有旧版 build .152」，外面套了 C 块注释壳）求值，
         与 INDEX_SRC 完全无关，无论源码怎么变永远为真（QA 侧 8 个变异体实测全绿）；
       · 改后对 `_wiped`（= 把 INDEX_SRC 里本版标记全部替换成 .OLD）求值，因 split/join 必然抹净，
         `countOcc(_wiped,'build .'+BUILD_NO) >= 3` **必然为 false** ⇒ 本条**仍然恒真**。
         它比原版唯一的好处：证明「判据依赖的是 INDEX_SRC 的真实内容」，而不是一个孤立字面量
         （即：万一有人把上面几条改成对常量求值，这里的写法会立刻显得荒谬，可读性起到提醒作用）。
       · **真正的判别力证据不在这里**，而在本文件 §G 的变异注入，以及 QA 终验（.160）在隔离副本上
         做的反向验证：把 `num(v)>=0` 改回 `num(v)>0` 后本文件 §A1/§C1/§C3 必红；把 .159 的 3 处标记
         删掉 2 处后 ② 必红；把历史标签收敛成 1 个后 ①b 必红。
       · 请不要把本条当成「④ 已守住回归」的依据，也不要为它加计数/加阈值 —— 它守不了任何东西。 */
  const _wiped = INDEX_SRC.split('build .' + BUILD_NO).join('build .OLD');
  assert.equal(countOcc(_wiped, 'build .' + BUILD_NO) >= 3, false,
    '结构性自检（恒真，非守卫）：抹掉本版标记后 ③ 的判据必然判红 ⇒ 说明判据吃的是 INDEX_SRC 真实内容；' +
    '真实判别力见 §G 变异注入与 QA §六 反向验证');
});

/* ================================================================
   §G 变异注入：证明本文件的断言真的会红（注入未生效即报错）
   ================================================================ */

/** 单点替换：命中数必须恰 1，否则抛错（严禁静默通过）。用 indexOf+slice 避免 $ 转义坑。 */
function applyMutation(src, from, to, label) {
  const n = countOcc(src, from);
  if (n !== 1) throw new Error('[变异注入失败] ' + label + '：目标片段命中 ' + n + ' 处（必须恰 1 处）');
  const i = src.indexOf(from);
  const out = src.slice(0, i) + to + src.slice(i + from.length);
  if (out === src) throw new Error('[变异注入失败] ' + label + '：源码未发生变化');
  return out;
}

const M1_FROM = 'function partBalanceOf(p){return num(p&&p.stock)-num(p&&p.used);}';
const M1_TO = 'function partBalanceOf(p){return num(p&&p.stock)+num(p&&p.used);}';
const M2_FROM = "if((products||[]).some(function(x){return String(x&&x.id!=null?x.id:'').trim()===p.id;})){";
const M2_TO = "if(false&&(products||[]).some(function(x){return String(x&&x.id!=null?x.id:'').trim()===p.id;})){";
const M3_FROM = "if(q<0){alert('入库数量不能为负数（第 '+(k+1)+' 行为「'+raw+'」），本次入库未提交（所有零件库存均未变动）。');return;}";
const M3_TO = "if(q<0){parts[i].stock=num(parts[i].stock)+q;alert('入库数量不能为负数（已部分提交）');return;}";

test('G1 变异：partBalanceOf 改成 stock+used → §A 单源守卫必须红（且变异真的生效）', function () {
  const mutant = applyMutation(INDEX_SRC, M1_FROM, M1_TO, 'G1 partBalanceOf 改加法');
  /* ① 注入确实生效：行为已经变了（否则下面的红是假的） */
  const app = mkApp({}, { indexHtml: mutant });
  assert.equal(app.run('partBalanceOf({stock:10,used:3})'), 13, '变异后行为必须变成加法（证明装载的是变异体）');
  app.dispose();
  /* ② 行为级断言必须红 */
  assert.throws(function () {
    const a2 = mkApp({}, { indexHtml: mutant });
    try { assert.equal(a2.run('partBalanceOf({stock:10,used:3})'), 7, 'A1 语义'); } finally { a2.dispose(); }
  }, /A1 语义|Expected values/, 'A1 行为断言必须变红');
  /* ③ 源码单源守卫必须红 —— 但注意：加法形态**不命中**结余减法正则，
        故此处变红的是「恰 1 处」**漏检**方向：把减法改掉后命中数变 0，守卫必须报红而不是静默通过。 */
  assert.throws(function () {
    const a3 = mkApp({}, { indexHtml: mutant });
    /* 用变异体的源码跑同一套匹配式 */
    const saved = INDEX_SRC;
    try {
      const code = wsFree(stripComments(mutant));
      const hits = code.match(BAL_RE_NESTED) || [];
      const plainHits = code.match(BAL_RE_PLAIN) || [];
      assert.equal(hits.length, 1, '「恰 1 处」守卫：实际 ' + hits.length + ' 处');
      assert.equal(plainHits.length, 1, '交叉校验：实际 ' + plainHits.length + ' 处');
      void saved;
    } finally { a3.dispose(); }
  }, /恰 1 处|交叉校验/, 'G1：减法消失后单源守卫必须报红（0 处 → 失败）');
});

test('G2 变异：删掉 savePart 的跨表 products 查重 → §B2 必须红', async function () {
  const mutant = applyMutation(INDEX_SRC, M2_FROM, M2_TO, 'G2 删跨表查重');
  /* ① 变异生效：撞产品编码的零件会被写进去 */
  const probeApp = mkApp({}, { indexHtml: mutant });
  installDom(probeApp, { pj_id: 'P1', pj_name: '撞名', pj_unit: '个' });
  await probeApp.run('savePart(-1)');
  assert.equal(probeApp.run('parts.length'), 5, '变异后撞名零件必须被接受（证明注入生效）');
  probeApp.dispose();
  /* ② 我的 B2 探针必须红 */
  await assert.rejects(function () {
    return probeCrossTableDupRejected(mkApp({}, { indexHtml: mutant }));
  }, 'B2 探针在跨表查重被删后必须报红');
});

test('G3 变异：doPartIn 变成「边校验边累加」（部分提交）→ §C3 必须红', async function () {
  const mutant = applyMutation(INDEX_SRC, M3_FROM, M3_TO, 'G3 部分提交');
  /* ① 变异生效：负数行把 LJ-002 的库存 3 写成 0（部分提交），且没有事务 */
  const probeApp = mkApp({}, { indexHtml: mutant });
  const before = J(probeApp, 'parts').map(function (p) { return p.stock; });
  await runPartIn(probeApp, { 0: '100', 1: '-3' });
  assert.notEqual(J(probeApp, 'parts')[1].stock, before[1],
    '变异后非法行必须被部分提交（证明注入生效，before=' + before[1] + '）');
  assert.equal(probeApp.recorder.txCount(), 0, '变异后仍未发事务 → 内存与服务器不一致（正是要防的 D7 类缺陷）');
  probeApp.dispose();
  /* ② 我的 C3 探针必须红 */
  await assert.rejects(function () {
    return probeIllegalQtyRejectsWholeBatch(mkApp({}, { indexHtml: mutant }));
  }, 'C3 探针在部分提交变异下必须报红');
});

test('G4 变异基础设施自检：命中数 ≠ 1 时必须报错，绝不静默通过', function () {
  assert.throws(function () { applyMutation('abc', 'zzz', 'q', '不存在的片段'); }, /命中 0 处/, '命中 0 处必须报错');
  assert.throws(function () { applyMutation('abab', 'ab', 'q', '重复片段'); }, /命中 2 处/, '命中 2 处必须报错');
});

/* ---- §G5/G6：对「P1 提交重入锁」这道新防线本身做变异自证（新增防线必须有人守） ---- */
const M4_FROM = 'if(__piBusy)return;';
const M4_TO = 'if(false)return;';
const M5_FROM = '    __piBusy=false;\n    if(cbtn){cbtn.disabled=false;cbtn.innerHTML=cbtnTxt;}';
const M5_TO = '    if(cbtn){cbtn.disabled=false;cbtn.innerHTML=cbtnTxt;}';

test('G5 变异：删掉 doPartIn 的重入判断 → C12（双击只提交 1 次）必须红', async function () {
  const mutant = applyMutation(INDEX_SRC, M4_FROM, M4_TO, 'G5 删重入判断');
  /* ① 变异生效：同一 tick 两次点击真的发两次事务（必须装载**变异体**，否则证明的是生产线） */
  const probeApp = mkFakeServerApp([{ id: 'X1', name: '件', spec: '', model: '', unit: '个', stockMax: 100, stockMin: 0, stock: 10, used: 0 }], { indexHtml: mutant });
  probeApp.setGlobal('selRows', { parts: new Set(['0']) });
  await probeApp.run('openPartIn()');
  const q1 = probeApp.run('doPartIn()');
  const q2 = probeApp.run('doPartIn()');
  await Promise.all([q1, q2]);
  assert.equal(probeApp.fakeServer.txBodies.length, 2, '删掉锁后必须能看到两次提交（证明注入生效）');
  probeApp.dispose();
  /* ② 我的 C12 探针必须红（它断言只发 1 次） */
  const mutantApp = mkFakeServerApp([{ id: 'X1', name: '件', spec: '', model: '', unit: '个', stockMax: 100, stockMin: 0, stock: 10, used: 0 }], { indexHtml: mutant });
  await assert.rejects(function () { return probeConcurrentSubmitLocked(mutantApp); },
    'C12 探针在重入锁被删后必须报红');
  mutantApp.dispose();
});

test('G6 变异：把 finally 里的解锁改成空操作 → C13（10 条路径全解锁）必须红', async function () {  const mutant = applyMutation(INDEX_SRC, M5_FROM, M5_TO, 'G6 删解锁');
  /* ① 变异生效：一次失败后 __piBusy 永久为 true（按钮卡死） */
  const probeApp = mkApp({ selRows: { parts: new Set(['0']) } }, { indexHtml: mutant });
  installDom(probeApp, { pi_qty_0: '5' });
  await probeApp.run('openPartIn()');
  probeApp.recorder.failNext('tx', 'boom');
  await probeApp.run('doPartIn()');
  assert.equal(probeApp.run('__piBusy'), true, '删掉解锁后必须残留占锁状态（证明注入生效）');
  probeApp.dispose();
  /* ② 我的 C13 解锁断言必须红（同一个 assertUnlocked） */
  const mutantApp = mkApp({ selRows: { parts: new Set(['0']) } }, { indexHtml: mutant });
  installDom(mutantApp, { pi_qty_0: '5' });
  await mutantApp.run('openPartIn()');
  mutantApp.recorder.failNext('tx', 'boom');
  await mutantApp.run('doPartIn()');
  assert.throws(function () { assertUnlocked(mutantApp, '出口⑦事务失败（G6 变异体）'); },
    /必须已释放|永久卡死/, 'C13 的解锁断言在 finally 解锁被删后必须报红');
  mutantApp.dispose();
});

/* ---- G7：对 P2「批次归属快照」修复做变异自证（两种等价破法各证一次） ---- */
const M6_FROM = '    if(__piIdxs===myIdx){\n      __piIdxs=null;\n      closeModal();\n      clearSel(\'parts\');\n    }';
const M6_TO = '    __piIdxs=null;\n    closeModal();\n    clearSel(\'parts\');';
const M7_FROM = '    if(__piIdxs===myIdx){';
const M7_TO = '    if(true){';

test('G7 变异：破掉批次归属判断（两种等价破法）→ C13b 必须红', async function () {
  const cases = [
    { label: 'G7a 收尾改回无条件（整体还原旧写法）', from: M6_FROM, to: M6_TO },
    { label: 'G7b 守卫条件改成 if(true)', from: M7_FROM, to: M7_TO }
  ];
  for (const c of cases) {
    /* 命中数必须恰 1，否则 applyMutation 直接抛错（不静默通过） */
    const mutant = applyMutation(INDEX_SRC, c.from, c.to, c.label);
    const app = mkFakeServerApp(TWO_PARTS(), { indexHtml: mutant });
    const dom = installDom(app, {});
    let err = null;
    try { await probeReopenDuringFlight(app, dom); } catch (e) { err = e; }
    assert.ok(err && /不得关闭|不得被上一条提交置 null|数量必须还在/.test(String(err.message)),
      '[' + c.label + '] C13b 必须报红，实际: ' + (err ? err.message : '（没有报错）'));
    /* 注入生效的独立证据：变异体确实把在途期间新开的弹窗关掉了 */
    assert.equal(app.sandbox.document.getElementById('modalBg').classList.contains('show'), false,
      '[' + c.label + '] 变异体必须表现出「新弹窗被关」（证明注入生效）');
    app.dispose();
  }
});
