'use strict';
/* ================================================================
   tests/parts.159.test.js
   —— 零部件口径收紧两项（用户 2026-10-31 指示，build .159）
   ================================================================
   背景（QA 上轮实测发现的两个静默口径漏洞）：
     漏洞1 入库允许小数：弹窗填 0.5 → 库存从 10 变 **10.5**（零件按「件」计，小数无业务意义）。
     漏洞2 上下限可为负数：最大 = −5 / 最小 = −9 能保存成功（输入框虽写了 min=0，粘贴 / F12 可绕过）。
            后果是**静默错误显示**：partBalPctOf 分母为负 → 结余进度恒 0%，invStockLevel 四档恒绿。

   实现裁定（主理人给定，本文件按此钉死，防止日后有人「好心」改成自动纠正）：
     · **绝不静默改用户输入**：不四舍五入、不自动归零、不取绝对值；一律**拦截 + 明确提示**。
     · **存量数据不动**：历史负数上下限 / 带小数库存不回填、不迁移；只在保存 / 入库入口拦新输入。
     · 入库数量仍保持 `q===0` 跳过、留空跳过（既有语义），且仍是**整批校验 → 全批拒绝**（禁止部分提交）。

   覆盖结构：
     §A 入库数量必须是正整数（行为）  0.5 / 2.5 / "1e3" / 合法 100 / 0 与留空 / 多行混合整批拒
     §B 最大·最小库存量禁负（行为）  max=−5 / min=−1 / 0 合法 / 编辑存量负数记录被拦 / 正数通过
     §C 静态守卫                      Number.isInteger 单点且顺序正确 / savePart 两条 <0 / guide 口径 / 水印
     §D 回归红线                      partBalanceOf 单源 / __piBusy 与批次归属守卫仍在 / 弹窗体验层提示
   ================================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createApp, ROOT } = require('./harness/sandbox');
const build = require('./harness/build');

const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const GUIDE_SRC = fs.readFileSync(path.join(ROOT, 'js', 'guide.js'), 'utf8');
const JS_FILES = ['logs.js', 'import.js', 'transfer.js', 'guide.js', 'prodplan-core.js'];

const ADMIN = { username: 'pmc', name: 'PMC小张', role: 'admin', perms: {} };

/* ---------------- 源码工具（与 parts.158 同一套口径） ---------------- */
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

/* 让 getElementById 返回可读写的假元素（value 走 getter 直连 inputs → 测试可随时改输入） */
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
function hasAlert(app, needle) {
  return app.alerts.some(function (a) { return String(a).indexOf(needle) >= 0; });
}

/* ================================================================
   §A 入库数量必须是正整数（行为级）
   ================================================================ */

test('A1 填 0.5 → 整批拒绝：库存一字不动（不是 200.5）、台账 0 条、不发事务', function () {
  /* 缺陷原形（QA 实测）：入库弹窗填 0.5 → 库存 10 变 10.5。零件按「件」计，半件无业务意义；
     更糟的是它会污染结余 / 结余进度 / 台账（10.5 件无法对账）。
     口径：**拦截 + 明确提示**，绝不静默取整（否则用户以为 0.5 件按 1 件入库，账实同样对不上）。 */
  const app = mkApp();
  stubDom(app, { pi_qty_0: '0.5' });
  app.setGlobal('__piIdxs', [0]);
  return app.run('doPartIn()').then(function () {
    assert.ok(hasAlert(app, '必须是正整数'), '必须明确提示「必须是正整数」，实际 alerts=' + JSON.stringify(app.alerts));
    assert.ok(hasAlert(app, '第 1 行'), '提示必须按行号点名是第几行（与既有「非数字 / 负数」两条同款）');
    assert.ok(hasAlert(app, '0.5'), '提示必须带出原始输入，用户才知道该改哪一格');
    assert.ok(hasAlert(app, '本次入库未提交'), '提示必须交代后果：整批未提交、库存未变动（与既有两条风格一致）');
    const parts = J(app, 'parts');
    assert.equal(parts[0].stock, 200, '库存必须一字不动（不得出现 200.5）');
    assert.equal(J(app, 'partLogs').length, 0, '不得产生任何台账流水');
    assert.equal(app.recorder.txCount(), 0, '被拒时不得发起事务');
    assert.equal(app.counters.renderContent, 0, '被拒时不得渲染成成功态');
    app.dispose();
  });
});

test('A2 填 2.5 → 同样整批拒绝（小数不是「偶发」，是口径）', function () {
  const app = mkApp();
  stubDom(app, { pi_qty_0: '2.5' });
  app.setGlobal('__piIdxs', [0]);
  return app.run('doPartIn()').then(function () {
    assert.ok(hasAlert(app, '必须是正整数'), 'alerts=' + JSON.stringify(app.alerts));
    assert.equal(J(app, 'parts')[0].stock, 200);
    assert.equal(J(app, 'partLogs').length, 0);
    assert.equal(app.recorder.txCount(), 0);
    app.dispose();
  });
});

test('A3 科学计数 "1e3" = 1000 是整数 → 放行（**有意**行为，非漏网）', function () {
  /* 为什么断言「放行」而不是「拦截」：
     · 校验用的是 Number.isInteger(Number(raw))，"1e3" 经 Number 后就是整数 1000，不存在小数；
     · 入库框是 <input type="number">，浏览器本就允许 e 记法，硬禁会变成「同样一格，有的浏览器能填有的不能填」；
     · 真正要防的是**小数**（件不可分），而不是记法。故此处按实际行为断言，并写明这是**有意**的。 */
  const app = mkApp();
  stubDom(app, { pi_qty_0: '1e3' });
  app.setGlobal('__piIdxs', [0]);
  return app.run('doPartIn()').then(function () {
    assert.equal(app.alerts.length, 0, '整数输入不得有任何提示: ' + JSON.stringify(app.alerts));
    assert.equal(J(app, 'parts')[0].stock, 1200, '200 + 1000');
    const logs = J(app, 'partLogs');
    assert.equal(logs.length, 1);
    assert.equal(logs[0].qty, 1000, '台账数量按数值 1000 记录（不是字符串 "1e3"）');
    assert.equal(app.recorder.txCount(), 1);
    app.dispose();
  });
});

test('A4 合法整数 100 → 正常累加 + 台账前后库存快照 + 一次事务', function () {
  const app = mkApp();
  stubDom(app, { pi_qty_0: '100' });
  app.setGlobal('__piIdxs', [0]);
  return app.run('doPartIn()').then(function () {
    assert.equal(app.alerts.length, 0, '合法输入不得有提示: ' + JSON.stringify(app.alerts));
    assert.equal(J(app, 'parts')[0].stock, 300, '200 + 100');
    const logs = J(app, 'partLogs');
    assert.equal(logs.length, 1);
    assert.equal(logs[0].qty, 100);
    assert.equal(logs[0].stockBefore, 200);
    assert.equal(logs[0].stockAfter, 300);
    assert.equal(app.recorder.txCount(), 1);
    app.dispose();
  });
});

test('A5 填 0 / 留空 → 仍然跳过（既有语义不变：0 = 该行不入库），全部跳过才提示', function () {
  const app = mkApp();
  stubDom(app, { pi_qty_0: '0', pi_qty_1: '' });
  app.setGlobal('__piIdxs', [0, 1]);
  return app.run('doPartIn()').then(function () {
    assert.ok(hasAlert(app, '请至少填写一个入库数量'), 'alerts=' + JSON.stringify(app.alerts));
    assert.ok(!hasAlert(app, '必须是正整数'), '0 是整数，不得被新校验误伤（0 的语义是「本行不入库」）');
    assert.equal(J(app, 'parts')[0].stock, 200);
    assert.equal(J(app, 'parts')[1].stock, 0);
    assert.equal(app.recorder.txCount(), 0);
    app.dispose();
  });
});

test('A6 多行混合（第 1 行合法 100 / 第 2 行小数 0.5）→ 整批拒绝，合法那行也不得入库', function () {
  /* **本文件最关键的一条**：防「部分提交」回潮。新增一条校验时最容易破坏的就是
     「先全批校验、后统一累加」的顺序——若把累加写进校验循环，就会出现「填三行只成功两行」，
     库存与台账从此对不上（.125 起全项目的硬口径：要么全部生效，要么一字不写）。 */
  const app = mkApp();
  stubDom(app, { pi_qty_0: '100', pi_qty_1: '0.5' });
  app.setGlobal('__piIdxs', [0, 1]);
  return app.run('doPartIn()').then(function () {
    assert.ok(hasAlert(app, '必须是正整数'), 'alerts=' + JSON.stringify(app.alerts));
    assert.ok(hasAlert(app, '第 2 行'), '提示必须点名是第 2 行（第 1 行是合法行，不该被点名）');
    const parts = J(app, 'parts');
    assert.equal(parts[0].stock, 200, '合法行也不得被写入（整批拒绝）');
    assert.equal(parts[1].stock, 0);
    assert.equal(J(app, 'partLogs').length, 0, '不得产生半条流水');
    assert.equal(app.recorder.txCount(), 0, '不得发起事务');
    assert.equal(app.counters.renderContent, 0, '不得渲染成成功态');
    app.dispose();
  });
});

test('A7 负数仍报「不能为负数」原提示（新校验不得抢走既有文案：用户看到哪个原因更准先报哪个）', function () {
  const app = mkApp();
  stubDom(app, { pi_qty_0: '-3' });
  app.setGlobal('__piIdxs', [0]);
  return app.run('doPartIn()').then(function () {
    assert.ok(hasAlert(app, '不能为负数'), 'alerts=' + JSON.stringify(app.alerts));
    assert.ok(!hasAlert(app, '必须是正整数'), '负数（本身是整数）不应落到「正整数」提示，否则旧用例与用户预期都会漂');
    assert.equal(J(app, 'parts')[0].stock, 200);
    assert.equal(app.recorder.txCount(), 0);
    app.dispose();
  });
});

/* ================================================================
   §B 最大 / 最小库存量禁止负数（行为级）
   ================================================================ */

test('B1 最大库存量 = −5 → 拒绝保存；parts 长度不变、不发事务', function () {
  /* 缺陷原形（QA 实测）：max=−5 能保存成功 → partBalPctOf 分母为负 → 结余进度恒 0%、
     invStockLevel 四档恒绿（看着「一切正常」，其实是错数据）。输入框 min="0" 只是体验层，
     粘贴 / F12 可绕过，故硬闸必须在 savePart。 */
  const app = mkApp();
  stubDom(app, { pj_id: 'LJ-900', pj_name: '负上限件', pj_unit: '个', pj_stockMax: '-5', pj_stockMin: '0' });
  return app.run('savePart(-1)').then(function () {
    assert.ok(hasAlert(app, '最大库存量不能为负数'), 'alerts=' + JSON.stringify(app.alerts));
    assert.ok(hasAlert(app, '-5'), '提示必须带出当前值，用户才知道错在哪一格');
    assert.ok(hasAlert(app, '请填写 0 或正整数'), '提示必须给出可执行的正解（不是只说「不能为负」）');
    assert.equal(J(app, 'parts').length, 2, 'parts 长度不得变化（拒绝时一字不写）');
    assert.ok(!J(app, 'parts').some(function (p) { return p.id === 'LJ-900'; }), '新记录不得被写入');
    assert.equal(app.recorder.txCount(), 0, '被拒时不得发起事务');
    assert.equal(app.counters.renderContent, 0, '被拒时不得渲染成成功态');
    app.dispose();
  });
});

test('B2 最小库存量 = −1 → 拒绝保存（同上）', function () {
  const app = mkApp();
  stubDom(app, { pj_id: 'LJ-901', pj_name: '负下限件', pj_unit: '个', pj_stockMax: '100', pj_stockMin: '-1' });
  return app.run('savePart(-1)').then(function () {
    assert.ok(hasAlert(app, '最小库存量不能为负数'), 'alerts=' + JSON.stringify(app.alerts));
    assert.ok(hasAlert(app, '请填写 0 或正整数'));
    assert.equal(J(app, 'parts').length, 2);
    assert.equal(app.recorder.txCount(), 0);
    app.dispose();
  });
});

test('B3 两条同时为负 → 只拦第一条（最大在最小之前），提示不叠加、数据不动', function () {
  const app = mkApp();
  stubDom(app, { pj_id: 'LJ-902', pj_name: '双负件', pj_unit: '个', pj_stockMax: '-5', pj_stockMin: '-9' });
  return app.run('savePart(-1)').then(function () {
    assert.equal(app.alerts.length, 1, '逐条早退 → 只弹一条（不叠两条 alert 轰炸用户）: ' + JSON.stringify(app.alerts));
    assert.ok(hasAlert(app, '最大库存量不能为负数'));
    assert.equal(app.recorder.txCount(), 0);
    app.dispose();
  });
});

test('B4 0 合法（= 不设限制）→ 保存成功、一次事务、原样落库', function () {
  /* 0 是既有口径里的**合法值**：partBalPctOf 分母 0 → 0%（不除零、也不把「没设上限」显示成 100%），
     invStockLevel 按「不设限制」处理。故新校验只能拦负数，不能顺手把 0 也拦掉。 */
  const app = mkApp();
  stubDom(app, { pj_id: 'LJ-903', pj_name: '零上限件', pj_unit: '个', pj_stockMax: '0', pj_stockMin: '0' });
  return app.run('savePart(-1)').then(function () {
    assert.equal(app.alerts.length, 0, '0 不得被拦: ' + JSON.stringify(app.alerts));
    const arr = J(app, 'parts');
    assert.equal(arr.length, 3, '应新增 1 条');
    const p = arr[2];
    assert.equal(p.stockMax, 0);
    assert.equal(p.stockMin, 0);
    assert.equal(p.stock, 0, '新建库存从 0 起算');
    assert.equal(app.recorder.txCount(), 1);
    /* 0 上限的零件：结余进度按 0 显示（口径不变） */
    assert.equal(app.run('partBalPctOf({stock:50,used:0,stockMax:0})'), 0);
    app.dispose();
  });
});

test('B5 正数正常通过：max=2000 / min=50 原样落库', function () {
  const app = mkApp();
  stubDom(app, { pj_id: 'LJ-904', pj_name: '正常件', pj_unit: '个', pj_stockMax: '2000', pj_stockMin: '50' });
  return app.run('savePart(-1)').then(function () {
    assert.equal(app.alerts.length, 0, '正数不得被拦: ' + JSON.stringify(app.alerts));
    const p = J(app, 'parts')[2];
    assert.equal(p.stockMax, 2000);
    assert.equal(p.stockMin, 50);
    assert.equal(app.recorder.txCount(), 1);
    app.dispose();
  });
});

test('B6 编辑存量负数记录（历史脏数据）→ 即使只改别的字段也被拦（**期望行为**，不回填存量）', function () {
  /* 用户裁定：**存量数据不动**——历史已存成负数的记录不回填、不迁移（不得擅自修改用户既有数据）。
     于是产生一个「行为登记」：编辑这类记录、哪怕只改名称，保存也会被这条硬闸拦下。
     这是**期望行为**——提示里带出当前值，等于顺带告诉用户「这条历史数据是脏的，请改成 0 或正数」。
     本用例把它钉成契约，防止日后有人为了「编辑顺畅」把校验降级为「仅新增时校验」。 */
  const app = mkApp({
    parts: [
      { id: 'LJ-OLD', name: '历史负上限件', spec: '', model: '', unit: '个', stockMax: -5, stockMin: 0, stock: 10, used: 0 },
      { id: 'LJ-002', name: '外壳', spec: '白色', model: 'CW-A', unit: '个', stockMax: 0, stockMin: 0, stock: 0, used: 0 }
    ]
  });
  /* 弹窗会把存量值原样回填进输入框 → 桩里给同值，模拟用户「只改了名称」后点保存 */
  stubDom(app, { pj_id: 'LJ-OLD', pj_name: '历史负上限件改名', pj_unit: '个', pj_stockMax: '-5', pj_stockMin: '0' });
  return app.run('savePart(0)').then(function () {
    assert.ok(hasAlert(app, '最大库存量不能为负数'), '编辑存量负数记录必须被拦（期望行为）: ' + JSON.stringify(app.alerts));
    const p = J(app, 'parts')[0];
    assert.equal(p.name, '历史负上限件', '名称不得被写入（拒绝时内存一字不动）');
    assert.equal(p.stockMax, -5, '存量值也不得被系统擅自改成 0（用户裁定：不回填存量）');
    assert.equal(app.recorder.txCount(), 0, '被拒时不得发起事务');
    app.dispose();
  });

  /* 反向验证：用户按提示把该值改成 0 → 同一条记录可以正常保存（不会把人锁死） */
});

test('B6b 上条的反向：用户按提示把负数改成 0 → 同一条记录正常保存（不会把人锁死）', function () {
  const app = mkApp({
    parts: [
      { id: 'LJ-OLD', name: '历史负上限件', spec: '', model: '', unit: '个', stockMax: -5, stockMin: 0, stock: 10, used: 0 }
    ]
  });
  stubDom(app, { pj_id: 'LJ-OLD', pj_name: '历史负上限件', pj_unit: '个', pj_stockMax: '0', pj_stockMin: '0' });
  return app.run('savePart(0)').then(function () {
    assert.equal(app.alerts.length, 0, '改成 0 后不得再被拦: ' + JSON.stringify(app.alerts));
    const p = J(app, 'parts')[0];
    assert.equal(p.stockMax, 0, '存量负数由此被用户手工修正为 0（系统不代劳）');
    assert.equal(p.stock, 10, '库存原样保留（编辑不改库存）');
    assert.equal(app.recorder.txCount(), 1);
    app.dispose();
  });
});

/* ================================================================
   §C 静态守卫（源码级，防「改注释不改逻辑」与顺序回退）
   ================================================================ */

test('C1 doPartIn：Number.isInteger 恰 1 处，且位于「负数判断之后、plan.push 之前」', function () {
  /* 顺序断言全部用**位置比较**而非字面相邻：格式化 / 换行 / 加注释都不该让用例变红。 */
  const body = stripComments(extractFn(INDEX_SRC, 'doPartIn'));
  assert.equal(countOf(body, 'Number.isInteger'), 1,
    'doPartIn 内 Number.isInteger 必须恰 1 处（多写一处=两套口径，早晚漂移）');
  const pFinite = body.indexOf('!isFinite(q)');
  const pInt = body.indexOf('!Number.isInteger(q)');
  const pNeg = body.indexOf('if(q<0)');
  const pZero = body.indexOf('if(q===0)continue;');
  const pPush = body.indexOf('plan.push(');
  assert.ok(pFinite > 0, '既有「非数字」校验不得被删除');
  assert.ok(pNeg > 0, '既有「负数」校验不得被删除');
  assert.ok(pInt > pFinite, '整数校验必须在「非数字」校验之后（先判是否为数字，再判是否整数）');
  assert.ok(pInt > pNeg, '整数校验放在「负数」之后 → 负数仍报「不能为负数」（更贴近用户意图，且既有口径不变）');
  assert.ok(pInt < pZero, '整数校验必须在「填 0 跳过」之前（否则 0.5 会被当成 0 静默跳过）');
  assert.ok(pInt < pPush, '整数校验必须在 plan.push 之前（否则小数已进入累加计划）');
  assert.ok(hasAlertInBody(body, '必须是正整数'), '提示文案必须落在源码里');
});
function hasAlertInBody(body, needle) { return body.indexOf(needle) >= 0; }

test('C2 doPartIn：仍是「先全批校验 → 后统一累加」（plan.push 早于任何 p.stock 赋值）', function () {
  /* 防「部分提交」回潮的静态兜底：只要有人把累加搬进校验循环，这条立刻变红。 */
  const body = stripComments(extractFn(INDEX_SRC, 'doPartIn'));
  const pPush = body.indexOf('plan.push(');
  const pPlanLoop = body.indexOf('if(plan.length===0)');
  const pAssign = body.indexOf('p.stock=stockBefore+x.qty');
  assert.ok(pPush > 0 && pAssign > 0 && pPlanLoop > 0, '三处锚点都必须存在');
  assert.ok(pPush < pPlanLoop, '先把校验通过的项收进 plan，再判「一个都没填」');
  assert.ok(pPlanLoop < pAssign, '库存累加必须在「全批校验 + plan 非空」之后（禁止边校验边累加）');
  assert.equal(countOf(body, 'p.stock=stockBefore+x.qty'), 1, '库存累加点必须恰 1 处（单点可审计）');
});

test('C3 savePart：两条 <0 拦截都在，且都早于任何数组改动', function () {
  const body = stripComments(extractFn(INDEX_SRC, 'savePart'));
  assert.equal(countOf(body, 'p.stockMax<0'), 1, '最大库存量负数拦截恰 1 处');
  assert.equal(countOf(body, 'p.stockMin<0'), 1, '最小库存量负数拦截恰 1 处');
  const pMax = body.indexOf('p.stockMax<0');
  const pMin = body.indexOf('p.stockMin<0');
  const pRequired = body.indexOf("if(!p.unit)");
  const pDup = body.indexOf('const dup=parts.some');
  const pWrite = body.indexOf('parts[idx]=p');
  const pPush = body.indexOf('parts.push(p)');
  assert.ok(pMax > pRequired, '必填校验在前（用户先听到「名称没填」这种更基础的错）');
  assert.ok(pMax < pWrite && pMin < pWrite, '负数拦截必须早于 parts[idx]=p（编辑分支）');
  assert.ok(pMax < pPush && pMin < pPush, '负数拦截必须早于 parts.push（新增分支）');
  assert.ok(pDup > 0, '编码查重不得被删除');
  /* 只拦负数：源码里不得出现「静默纠正」的实现（取绝对值 / 归零 / 四舍五入） */
  assert.ok(!/Math\.abs\(\s*p\.stockM/.test(body), '禁止用 Math.abs 静默取绝对值（用户裁定：只拦不改）');
  assert.ok(!/p\.stockM(ax|in)\s*=\s*0\s*;/.test(body), '禁止静默归零（不得改用户输入）');
  assert.ok(!/Math\.round\(\s*p\.stockM/.test(body), '禁止四舍五入（件不可分，不该「悄悄变成别的数」）');
});

test('C4 doPartIn：同样不得「静默取整」——不存在 Math.round/floor/ceil 作用于 q', function () {
  const body = stripComments(extractFn(INDEX_SRC, 'doPartIn'));
  assert.ok(!/Math\.(round|floor|ceil)\(\s*q\s*\)/.test(body), '禁止把小数静默取整后入库（0.5 静默变 1 与变 0.5 一样错）');
  assert.ok(!/parseInt\(/.test(body), '禁止用 parseInt 静默截断（会把 0.5 变成 0 而无人知晓）');
});

test('C5 弹窗体验层：入库框 step=1 + title 说明正整数；上下限框 min=0 + 备注注明禁负', function () {
  /* 体验层（体验层可绕过，故只做「预先告知」，硬闸在函数侧 C1/C3）。 */
  const open = stripComments(extractFn(INDEX_SRC, 'openPartIn'));
  assert.match(open, /id="pi_qty_'\+i\+'" min="0" step="1"/, '入库框必须 step="1"（浏览器步进器不再给出小数）');
  assert.ok(open.indexOf('仅限正整数') >= 0, '入库框 / 列头必须有一句「仅限正整数（件）」，让用户预先知道');
  const modal = stripComments(extractFn(INDEX_SRC, 'partModal'));
  assert.match(modal, /type="number" id="pj_'\+f\.key\+'" min="0" step="1"/, '上下限框保持 min="0" step="1"');
  assert.ok(modal.indexOf('不得为负数') >= 0, '上下限字段备注必须写明「不得为负数（0 = 不设限制）」');
});

test('C6 guide.js：两条新口径文案在位，且正文不写完整版本号（只许 [build .NNN] 形态）', function () {
  assert.ok(GUIDE_SRC.indexOf('入库数量仅限正整数') >= 0, '使用说明必须写明入库仅限正整数');
  assert.ok(GUIDE_SRC.indexOf('最大 / 最小库存量不得为负数') >= 0, '使用说明必须写明上下限禁负');
  assert.ok(GUIDE_SRC.indexOf('留空或填 0 表示该行本次不入库') >= 0 || GUIDE_SRC.indexOf('留空或填 0') >= 0,
    '0 的语义（该行不入库）必须讲清楚，否则用户会以为 0 也被拦');
  assert.ok(GUIDE_SRC.indexOf('0 是合法值＝不设限制') >= 0, '必须讲清楚 0 合法（不设限制）');
  assert.ok(GUIDE_SRC.indexOf('不回填、不迁移') >= 0, '必须讲清楚存量脏数据不会被系统擅自修改');
  assert.equal((GUIDE_SRC.match(build.buildAnyRe(build.BUILD)) || []).length, 0,
    'guide.js 正文不得出现完整版本号（只许 build .NNN 短形态）');
  /* 文首「更新」行**不写死版本号**：吃掉单一来源 build.BUILD 的两段
     （日期段 + .NNN 段），据此拼出期望行 —— 与 parts.158.test.js F1 同一套写法，
     下一版推进时本用例无需手改（否则它自己就成了新的「必红锚点」）。 */
  const _bv = String(build.BUILD).split('.');
  assert.ok(GUIDE_SRC.indexOf('更新：' + _bv[0] + '（build .' + _bv[1] + '）') >= 0,
    '文首版本行必须是「更新：' + _bv[0] + '（build .' + _bv[1] + '）」（由 harness.BUILD 推出）');
});

test('C7 版本水印三件套：index.html 水印 + guide 文首行都吃 harness 单一来源；PREV 残留 0 处', function () {
  /* 【单一来源纪律·build .159 修订】
     本用例**不再**断言 `build.BUILD === '2026-10-31.NNN'` 这类字面量等式 ——
     那是把主来源（harness/build.js）再抄一遍，等于自己制造「下一版必红」的第 10 处锚点。
     改为**用单一来源校验产物**（两个产物 + 三处判别力兜底）：
       ① index.html 权威水印 === harness.BUILD（篡改 harness → 此处必红）
       ② guide.js 文首「更新：DATE（build .NO）」行同样由 BUILD 推出（**日期与位置一并钉**，
          只取 .NNN 会漏掉「日期写错」、全局 indexOf 会漏掉「写到了正文某处」）
       ③ 形态 / PREV≠BUILD / 伪版本命中 0 —— 防「正则写坏 → 断言恒真」。 */
  assert.equal((INDEX_SRC.match(build.buildMarkRe(build.BUILD)) || []).length, 1, '权威水印恰 1 处');
  assert.equal((INDEX_SRC.match(build.buildAnyRe(build.BUILD)) || []).length, 1,
    '全文「build <完整版本号>」必须恰 1 处 —— 注释里只许写短形态【build .NNN】');
  assert.equal((INDEX_SRC.match(build.buildMarkRe(build.PREV)) || []).length, 0, '上一版权威水印不得残留');
  assert.equal((INDEX_SRC.match(build.buildAnyRe(build.PREV)) || []).length, 0, '上一版任意形态也不得残留');
  /* ② guide 文首（与 parts.158 F1 同一套推导，两处都从 BUILD 取，不写字面量） */
  const _bv = String(build.BUILD).split('.');
  const _gHead = GUIDE_SRC.slice(0, 800);
  assert.ok(_gHead.indexOf('更新：' + _bv[0] + '（build .' + _bv[1] + '）') >= 0,
    'guide.js 文首（前 800 字符内）必须是「更新：' + _bv[0] + '（build .' + _bv[1] + '）」');
  assert.equal(countOf(GUIDE_SRC, '更新：'), 1, '版本行「更新：」全篇恰 1 处');
  /* ③ 判别力兜底 */
  assert.match(String(build.BUILD), /^\d{4}-\d{2}-\d{2}\.\d+$/, 'BUILD 形态必须是 YYYY-MM-DD.NNN（防手滑写错）');
  assert.match(String(build.PREV), /^\d{4}-\d{2}-\d{2}\.\d+$/, 'PREV 形态必须是 YYYY-MM-DD.NNN');
  assert.notEqual(build.PREV, build.BUILD, 'PREV 不得等于 BUILD（相同则「上一版形态 0 处」变成恒真守卫）');
  assert.equal((INDEX_SRC.match(build.buildMarkRe('2099-01-01.999')) || []).length, 0,
    '不存在的版本号必须命中 0（证明水印断言有判别力）');
});

test('C8 注释纪律：本版新增注释只用【build .159】形态（禁写完整版本号，qa.import-nodelivered 只容 1 处）', function () {
  const hits = INDEX_SRC.match(/【build \.159】/g) || [];
  assert.ok(hits.length >= 3, '本次三处改动（doPartIn / savePart / 口径注释）都应留【build .159】标记，实际 ' + hits.length);
});

/* ================================================================
   §D 回归红线（本版不得破坏既有不变量）
   ================================================================ */

test('D1 结余公式仍单源：stock 减 used 的减法全工程恰 1 处且在 partBalanceOf 内', function () {
  const re = /num\([^()]*\.stock\)\s*-\s*num\([^()]*\.used\)/g;
  const hits = [];
  const scan = function (name, src) {
    (stripComments(src).match(re) || []).forEach(function (x) { hits.push({ file: name, text: x }); });
  };
  scan('index.html', INDEX_SRC);
  JS_FILES.forEach(function (f) { scan('js/' + f, fs.readFileSync(path.join(ROOT, 'js', f), 'utf8')); });
  assert.equal(hits.length, 1, '减法形态必须恰 1 处，实际: ' + JSON.stringify(hits));
  assert.match(stripComments(extractFn(INDEX_SRC, 'partBalanceOf')), /num\(p&&p\.stock\)-num\(p&&p\.used\)/);
});

test('D2 0.5 被拒后：__piBusy 已释放、确认按钮可点、文案已还原（早退路径不得漏解锁）', function () {
  /* 新增的这条校验是**第 5 条函数级早退**——若它写错位置（在 try 之外 / 在 finally 覆盖不到的地方），
     入库按钮就会永久卡死（比原缺陷更糟）。故逐条验证锁与按钮状态。 */
  const app = mkApp();
  const dom = stubDom(app, { pi_qty_0: '0.5' });
  app.setGlobal('__piIdxs', [0]);
  return app.run('doPartIn()').then(function () {
    assert.equal(app.run('__piBusy'), false, '被拒后必须解锁（否则入库按钮永久卡死）');
    const b = dom.els['pi_confirm'];
    assert.ok(b, '确认按钮应已被取到（doPartIn 开头取 cbtn）');
    assert.equal(b.disabled, false, '被拒后确认按钮必须恢复可点');
    assert.notEqual(b.innerHTML, '入库中…', '被拒后按钮文案必须还原');
    /* 静态兜底：解锁点在 finally 内且恰 1 处 */
    const body = stripComments(extractFn(INDEX_SRC, 'doPartIn'));
    assert.match(body, /\}\s*finally\s*\{[\s\S]*__piBusy\s*=\s*false/, '解锁必须在 finally 内');
    assert.equal(countOf(body, '__piBusy=false'), 1, '__piBusy 复位点应恰 1 处');
    app.dispose();
  });
});

test('D3 批次归属守卫仍在（提交在途时新开弹窗不得被上一条提交关掉）', function () {
  const body = stripComments(extractFn(INDEX_SRC, 'doPartIn'));
  assert.match(body, /const myIdx=__piIdxs;/, '必须有批次归属快照');
  assert.match(body, /if\(__piIdxs===myIdx\)\{[\s\S]*?__piIdxs=null;/, '收尾必须按归属比对后再置空');
  assert.match(body, /if\(__piIdxs===myIdx\)\{[\s\S]*?clearSel\('parts'\);[\s\S]*?\}\s*renderContent\(\);/, 'renderContent 必须无条件执行');
});

test('D4 0.5 被拒不影响后续正常入库（勾选仍在、可直接重试，不用重开弹窗）', function () {
  const app = mkApp();
  app.setGlobal('selRows', { parts: new Set(['0']) });
  const dom = stubDom(app, { pi_qty_0: '0.5' });
  app.setGlobal('__piIdxs', [0]);
  const first = app.run('doPartIn()');
  return first.then(function () {
    assert.ok(hasAlert(app, '必须是正整数'));
    assert.equal(app.run("selSet('parts').size"), 1, '被拒不得清勾选（用户可原样重试）');
    assert.equal(J(app, 'parts')[0].stock, 200);
    dom.inputs['pi_qty_0'] = '8';          /* 用户按提示改成整数重试 */
    return app.run('doPartIn()');
  }).then(function () {
    assert.equal(app.recorder.txCount(), 1, '重试才发生 1 次事务（第一次被拒没发）');
    assert.equal(J(app, 'parts')[0].stock, 208, '200 + 8');
    assert.equal(J(app, 'partLogs').length, 1);
    assert.equal(app.run("selSet('parts').size"), 0, '成功后清空勾选');
    app.dispose();
  });
});
