'use strict';
/* ================================================================
   tests/qa.prodplan-query.independent.test.js
   —— 交付计划列表新增操作按钮「排产查询」→ 跳转排产计划列表并按「交付计划编码」筛选
      build 2026-10-14.147
      **QA 独立回归 + 独立新增用例**（Edward／严过关，未参与本次编码，不采信工程师自述）
   ================================================================
   需求（用户原话）：
     「交付计划列表新增操作按钮『排产查询』，可选中一条交付计划点击操作，界面跳转到
      排产计划列表，筛选相应的『交付计划编码』」

   用户拍板的三条口径（本文件的**期望来源**，不读实现反推）：
     口径1 跳转后**强制切「总览」视图**（planView='all'）。
           理由：周/月视图是聚合自绘表 renderProdPlanAgg（index.html:5166）不走筛选引擎；
           日视图受 planDateFrom/planDateTo 日期范围限制。只有总览能完整承载筛选结果。
     口径2 按钮位于交付计划页 bulkBar 内、**紧跟「下推排产计划」之后**，处于 writable
           写权限块内，但**不挂 delivery.delPushPlan 动作键**（=「有写权限就有查询按钮」）。
     口径3 **无排产单时先弹提示且不跳转**（activeTab 不得变为 'prodPlan'）。

   本文件与工程师自测的**正交点**：
     §A 按钮存在性/位置/权限口径 —— 跑**生产 bulkBar() 本身**（非静态字符串）
     §B 跳转与筛选行为 —— 跑**生产 queryProdPlanOfDelivery() + 生产 filterRows()**（非推演）
     §C 拦截分支（空结果 / 0 条 / ≥2 条 / 缺编号 / 索引失效）—— 逐条行为验证
     §D 口径一致性守卫（筛选 key ≡ TBL_SCHEMAS.prodPlan 列 key；覆盖式赋值；强制总览）
     §E 版本推进 4 处（水印 / harness.build / §E2 字面量 / guide.js）
     §F **反向探针**（判别力自证）：用 harness 的 transformMain 就地改造源码副本，
        证明「若功能坏了，本文件 §B/§D 的断言会 FAIL」——不落任何磁盘痕迹

   运行：node --test tests/qa.prodplan-query.independent.test.js
        （**不要用 node -e / --eval**，见 tests/README.md §1：文件方式运行才能保证
          vm 内字符串不被宿主 realm 破坏）
   ================================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createApp, ROOT } = require('./harness/sandbox');
const build = require('./harness/build');

const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const GUIDE_SRC = fs.readFileSync(path.join(ROOT, 'js', 'guide.js'), 'utf8');
const PPSHIFT_TEST_SRC = fs.readFileSync(path.join(ROOT, 'tests', 'qa.ppshift-advance.independent.test.js'), 'utf8');
/* 穷举 js/ 目录（而不是只信 harness 的引入清单）：新函数不得藏进任何模块脚本 */
const JS_DIR = path.join(ROOT, 'js');
const JS_FILES = fs.readdirSync(JS_DIR).filter(function (f) { return /\.js$/.test(f); }).sort();
const MODULE_SRC = JS_FILES.map(function (f) {
  return { rel: 'js/' + f, src: fs.readFileSync(path.join(JS_DIR, f), 'utf8') };
});

const FN_NAME = 'queryProdPlanOfDelivery';
const FILTER_KEY = 'deliveryPlanNo';
const TARGET_NO = 'JFJH-20261014-00001';
const OTHER_NO = 'JFJH-20261014-00002';

/* ================================================================
   工具
   ================================================================ */

/** 跨 realm 对象 → 本 realm 纯对象/数组 */
function plain(v) { return JSON.parse(JSON.stringify(v)); }

/** 统计子串出现次数（静态断言用） */
function countOf(hay, needle) { return hay.split(needle).length - 1; }

/**
 * 从源码抽取顶层 `function NAME(...){...}` 完整文本（花括号配平）。
 * 目的：静态断言针对**源码里那段**，而非手抄副本（避免失同步）。
 */
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

/* 抽取即自证：这两个函数必须在 index.html 里存在且形态可解析 */
const FN_QUERY = extractFn(INDEX_SRC, FN_NAME);
const FN_BULKBAR = extractFn(INDEX_SRC, 'bulkBar');

/* ================================================================
   夹具
   ================================================================ */

/** 交付计划（只保留本用例相关字段） */
function mkDelivery(planNo, orderId) {
  return { planNo: planNo, orderId: orderId, customer: '库存', items: [] };
}
/** 排产单（单行明细；planQty 非 0 以便总览汇总卡有意义） */
function mkPlan(id, dlNo, opts) {
  const o = opts || {};
  return {
    id: id, deliveryIdx: (o.idx === undefined ? null : o.idx),
    deliveryPlanNo: (dlNo === undefined ? '' : dlNo),
    orderId: o.orderId || 'KCDD-1', customer: '库存',
    finalDate: '2026-10-20', planDate: o.planDate || '2026-10-14',
    status: o.status || '待排产', notes: '',
    items: [{
      productId: o.pid || ('P-' + id), productName: o.pid || ('P-' + id),
      spec: '', model: '', unit: '台', planQty: (o.qty === undefined ? 10 : o.qty),
      doneQty: 0, dlLine: 0, steps: null, stepsDef: null,
    }],
  };
}

const ADMIN = { username: 'qa', name: 'QA爱德华', role: 'admin', perms: {} };
/** 有「交付计划」表单写权限、但**未授权任何动作键**（canAct('delivery.delPushPlan')===false） */
const WRITE_NO_ACT = { username: 'pmc', name: 'PMC甲', role: 'user', perms: { deliveries: true, acts: {} } };
/** 无「交付计划」表单写权限 */
const READONLY = { username: 'vw', name: '只读乙', role: 'user', perms: { acts: {} } };

/* ================================================================
   驱动器
   ================================================================ */

/**
 * 建沙箱并注入夹具。
 * @param {Array} dels   deliveries 夹具
 * @param {Array} plans  productionPlans 夹具
 * @param {Object} [opts] { user, transformMain }
 */
function makeApp(dels, plans, opts) {
  const o = opts || {};
  const app = createApp({ installRecorder: true, transformMain: o.transformMain });
  const spy = { render: 0 };
  app.setGlobals({
    currentUser: (o.user === undefined ? ADMIN : o.user),
    products: [], orders: [],
    deliveries: dels || [], productionPlans: plans || [],
    productionReports: [], processTemplates: [], transfers: [], logs: [],
    renderContent: function () { spy.render++; },
  });
  /* switchTab 会写 pageTitle/mobileTitle.textContent；renderNav 会写 nav.innerHTML。
     dom-stub 的 getElementById 恒返回 null（设计 §6.2）→ 这里补一个「持久假元素」桩，
     使**生产 switchTab / renderNav / renderContent 原样可跑**（不替换它们，保持行为保真）。 */
  app.run('var __elm={};document.getElementById=function(id){if(!__elm[id])__elm[id]=document.createElement("div");return __elm[id];};');
  app.__spy = spy;
  return app;
}

/** 勾选交付计划（走生产 selSet，保证选择状态与生产同源；selRows 为 var 全局，可整体重置） */
function selectDelivery(app, idxs) {
  app.run('selRows={};');
  idxs.forEach(function (i) {
    app.run('selSet("delivery").add(' + JSON.stringify(String(i)) + ');');
  });
}

/** 预置一个**上一次残留**的筛选键（用于证明「整体覆盖」而非 merge） */
function seedResidualFilter(app, key, val) {
  app.run('tState("prodPlan").filters={' + JSON.stringify(key) + ':{mode:"eq",val:' + JSON.stringify(val) + '}};');
  return JSON.parse(app.run('JSON.stringify(tState("prodPlan").filters)'));
}

/** 调一次生产 queryProdPlanOfDelivery() 并返回全量可观测结果 */
function invoke(app) {
  app.run(FN_NAME + '();');
  return {
    activeTab: app.getGlobal('activeTab'),
    planView: app.getGlobal('planView'),
    filters: JSON.parse(app.run('JSON.stringify(tState("prodPlan").filters)')),
    alerts: app.alerts.slice(),
    renderCalls: app.__spy.render,
  };
}

/**
 * 注册 TBL_SCHEMAS.prodPlan 的**唯一注册点**是 renderProdPlanDay（index.html:5061）。
 * schema 注册（5061）与 TBL_ROWS 赋值（5083）都先于后续 HTML 拼装 → 即使桩内 DOM
 * 相关的装配段抛错，schema/TBL_ROWS 也已就位。这里容错但不吞掉「注册失败」。
 */
function loadProdPlanSchema(app) {
  app.run('try{renderProdPlanDay(true,true);}catch(e){}');
  const keys = JSON.parse(app.run('JSON.stringify(TBL_SCHEMAS.prodPlan.map(function(c){return c.key;}))'));
  assert.ok(keys.length > 0, '前置失败：TBL_SCHEMAS.prodPlan 未注册（renderProdPlanDay 结构可能已变）');
  const rowCount = app.run('TBL_ROWS.prodPlan.length');
  assert.ok(rowCount > 0, '前置失败：TBL_ROWS.prodPlan 未就位');
  return keys;
}

/** 走**生产筛选引擎**（filterRows）跑一次，返回筛出的排产单号列表 */
function filteredPlanIds(app) {
  return JSON.parse(app.run('JSON.stringify(filterRows("prodPlan",TBL_ROWS.prodPlan).map(function(r){return r.p.id;}))'));
}

/* 标准夹具：2 张交付计划 + 5 张排产单（含前缀陷阱单） */
function standardFixtures() {
  return {
    dels: [mkDelivery(TARGET_NO, 'KCDD-1'), mkDelivery(OTHER_NO, 'KCDD-2')],
    plans: [
      mkPlan('PSCD-A', TARGET_NO),          // ← 目标计划的排产单
      mkPlan('PSCD-B', TARGET_NO),          // ← 目标计划的排产单
      mkPlan('PSCD-C', OTHER_NO),           // 他计划
      mkPlan('PSCD-D', ''),                 // 独立单（无来源）
      mkPlan('PSCD-E', TARGET_NO + '0'),    // 前缀陷阱：只能被 contains/startswith 命中，eq 不得命中
    ],
    expectIds: ['PSCD-A', 'PSCD-B'],
  };
}

/* ================================================================
   §A 按钮存在性 / 位置 / 权限口径（行为级：跑生产 bulkBar 本身）
   ================================================================ */

test('A1 bulkBar("delivery") 产出「排产查询」，onclick 指向 '+FN_NAME+'()，且**紧邻**「下推排产计划」之后', function () {
  const f = standardFixtures();
  const app = makeApp(f.dels, f.plans);
  const html = app.run('bulkBar("delivery")');

  assert.equal(typeof html, 'string', 'bulkBar 必须返回 HTML 字符串');
  assert.ok(html.indexOf('<div class="bulk-bar">') === 0, '返回值必须即 bulkBar 容器（按钮位于 bulkBar 内）');
  assert.equal(countOf(html, '排产查询'), 1, '「排产查询」按钮应恰 1 个');
  assert.ok(html.indexOf('onclick="' + FN_NAME + '()"') >= 0, 'onclick 必须指向 ' + FN_NAME + '()');
  /* 位置：与「下推排产计划」按钮**逐字相邻**（中间无其它按钮） */
  assert.ok(html.indexOf('下推排产计划</button><button class="btn btn-sm" onclick="' + FN_NAME + '()"') >= 0,
    '「排产查询」必须紧跟「下推排产计划」之后（口径2）。实际片段：' +
    html.slice(Math.max(0, html.indexOf('下推排产计划') - 40), html.indexOf('排产查询') + 60));
  assert.ok(html.indexOf('genProdPlan()') < html.indexOf(FN_NAME + '()'), '「排产查询」必须排在 genProdPlan 之后');
  app.dispose();
});

test('A2 【口径2】有交付计划写权限但未授权 delivery.delPushPlan → 「下推排产计划」消失、「排产查询」仍在', function () {
  const f = standardFixtures();
  const app = makeApp(f.dels, f.plans, { user: WRITE_NO_ACT });
  assert.equal(app.run('canWriteForm("delivery")'), true, '前置：该账号必须有交付计划写权限');
  assert.equal(app.run('canAct("delivery.delPushPlan")'), false, '前置：该账号不得有 delPushPlan 动作键');

  const html = app.run('bulkBar("delivery")');
  assert.equal(countOf(html, '下推排产计划'), 0, '无 delPushPlan 动作键 → 「下推排产计划」必须不渲染');
  assert.equal(countOf(html, '排产查询'), 1, '「排产查询」不得依赖 delPushPlan（有写权限即显示）');
  assert.ok(html.indexOf('onclick="' + FN_NAME + '()"') >= 0, 'onclick 仍须正确');
  app.dispose();
});

test('A3 【口径2】无交付计划写权限 → 连「排产查询」也不显示（位于 writable 块内）', function () {
  const f = standardFixtures();
  const app = makeApp(f.dels, f.plans, { user: READONLY });
  assert.equal(app.run('canWriteForm("delivery")'), false, '前置：该账号无交付计划写权限');

  const html = app.run('bulkBar("delivery")');
  assert.equal(countOf(html, '排产查询'), 0, '只读账号不得出现「排产查询」');
  assert.equal(countOf(html, FN_NAME), 0, '只读账号工具栏不得引用该函数');
  app.dispose();
});

test('A4 其它表单工具栏不受影响：bulkBar("prodPlan") 不得出现「排产查询」', function () {
  const f = standardFixtures();
  const app = makeApp(f.dels, f.plans);
  const html = app.run('bulkBar("prodPlan")');
  assert.equal(countOf(html, '排产查询'), 0, '按钮仅属交付计划页（m==="delivery" 分支）');
  app.dispose();
});

/* ================================================================
   §B 跳转与筛选行为（行为级：跑生产函数 + 生产筛选引擎）
   ================================================================ */

test('B1 选中 1 条 → 强制总览 + 覆盖式筛选 + 切到排产计划页；生产 filterRows 只筛出本计划的排产单', function () {
  const f = standardFixtures();
  const app = makeApp(f.dels, f.plans);
  /* 前置：预置**残留**筛选键 + 非总览视图 → 证明「整体覆盖」而非 merge、且视图被强制 */
  const residual = seedResidualFilter(app, 'orderId', 'KCDD-2');
  assert.deepEqual(residual, { orderId: { mode: 'eq', val: 'KCDD-2' } }, '前置：残留筛选已就位');
  app.setGlobal('planView', 'week');
  app.setGlobal('activeTab', 'delivery');

  const schemaKeys = loadProdPlanSchema(app);
  selectDelivery(app, [0]);
  const o = invoke(app);

  assert.equal(o.activeTab, 'prodPlan', '必须切到排产计划页');
  assert.equal(o.planView, 'all', '【口径1】必须强制切「总览」视图');
  assert.deepEqual(o.filters, { deliveryPlanNo: { mode: 'eq', val: TARGET_NO } },
    '【口径1】filters 必须恰为该键（且**无残留** orderId → 覆盖而非 merge）');
  assert.equal(o.alerts.length, 0, '成功路径不得 alert');
  assert.ok(o.renderCalls >= 1, '切换页必须触发渲染');
  assert.equal(app.recorder.writeCount(), 0, '只读导航：不得产生任何写盘（save / DB.set / DB.tx 全为 0）');

  /* 运行时口径一致性：筛选 key 必须是 TBL_SCHEMAS.prodPlan 的真实列
     （防「key 写错 → filterRows 静默 continue → 表现为没筛」） */
  Object.keys(o.filters).forEach(function (k) {
    assert.ok(schemaKeys.indexOf(k) >= 0, '筛选 key「' + k + '」必须是 TBL_SCHEMAS.prodPlan 的真实列，实际列：' + JSON.stringify(schemaKeys));
  });

  /* 真实筛选引擎行为：前缀陷阱单 PSCD-E / 他计划单 PSCD-C / 独立单 PSCD-D 都必须被排除 */
  const ids = filteredPlanIds(app);
  assert.deepEqual(ids, f.expectIds, '只应筛出属于本计划的排产单（eq 严格相等，非 contains/startswith）');
  assert.ok(ids.indexOf('PSCD-E') < 0, '前缀陷阱单必须被排除（证明是 eq 而非 startswith/contains）');
  assert.ok(ids.indexOf('PSCD-D') < 0, '独立单（deliveryPlanNo 空）必须被排除');
  app.dispose();
});

test('B2 视图强制：原为 day / month 也必须被强制为 all（逐档对拍）', function () {
  const f = standardFixtures();
  ['day', 'week', 'month', 'all'].forEach(function (v) {
    const app = makeApp(f.dels, f.plans);
    app.setGlobal('planView', v);
    app.setGlobal('activeTab', 'delivery');
    selectDelivery(app, [0]);
    const o = invoke(app);
    assert.equal(o.planView, 'all', '原 planView=' + v + ' → 必须被强制为 all');
    app.dispose();
  });
});

test('B3 选第二张交付计划 → 筛条件随之改变（非写死第一张）', function () {
  const f = standardFixtures();
  const app = makeApp(f.dels, f.plans);
  loadProdPlanSchema(app);
  selectDelivery(app, [1]);
  const o = invoke(app);
  assert.deepEqual(o.filters, { deliveryPlanNo: { mode: 'eq', val: OTHER_NO } }, '必须按所选那张计划的编号筛选');
  assert.equal(o.planView, 'all', '仍强制总览');
  assert.deepEqual(filteredPlanIds(app), ['PSCD-C'], '应筛出另一张计划的排产单');
  app.dispose();
});

test('B4 无排产单的交付计划 → 提示后**不跳转**（口径3：含 filters/视图/渲染均不动）', function () {
  const f = standardFixtures();
  const app = makeApp(f.dels, f.plans);
  const residual = seedResidualFilter(app, 'orderId', 'KCDD-2');
  app.setGlobal('planView', 'day');
  app.setGlobal('activeTab', 'delivery');
  const renderBefore = app.__spy.render;

  /* 追加一张「尚未下推排产计划」的交付计划并选中它 */
  app.setGlobal('deliveries', [mkDelivery('JFJH-EMPTY-00009', 'KCDD-9')]);
  selectDelivery(app, [0]);
  const o = invoke(app);

  assert.equal(o.alerts.length, 1, '应恰 1 次 alert，实际：' + JSON.stringify(o.alerts));
  assert.ok(o.alerts[0].indexOf('尚未下推排产计划') >= 0, '提示必须说明无排产单，实际：' + JSON.stringify(o.alerts));
  assert.ok(o.alerts[0].indexOf('JFJH-EMPTY-00009') >= 0, '提示应含该交付计划编号，实际：' + JSON.stringify(o.alerts));
  assert.equal(o.activeTab, 'delivery', '【口径3】不得跳转（activeTab 必须仍为 delivery）');
  assert.equal(o.planView, 'day', '【口径3】不得改视图');
  assert.deepEqual(o.filters, residual, '【口径3】不得设置 filters（残留原样）');
  assert.equal(app.__spy.render, renderBefore, '【口径3】不得触发渲染');
  assert.equal(app.recorder.writeCount(), 0, '【口径3】拦截路径更不得写盘（零副作用）');
  app.dispose();
});

test('B5 用户可见面：筛选标签含本计划编号 + 可一键清除；清除后恢复全量', function () {
  const f = standardFixtures();
  const app = makeApp(f.dels, f.plans);
  loadProdPlanSchema(app);
  app.setGlobal('activeTab', 'delivery');
  selectDelivery(app, [0]);
  invoke(app);

  /* 生产 filterBar 产出的是用户实际看到的筛选标签（guide.js 承诺「顶部出现可一键清除的筛选标签」） */
  const bar = app.run('filterBar("prodPlan")');
  assert.ok(bar.indexOf('交付计划编号') >= 0, '筛选标签必须显示列名「交付计划编号」，实际：' + bar);
  assert.ok(bar.indexOf(TARGET_NO) >= 0, '筛选标签必须显示本交付计划编号，实际：' + bar);
  assert.ok(bar.indexOf("clearAllFilt('prodPlan')") >= 0, '必须提供「清除全部」入口');
  assert.ok(bar.indexOf("clearFilt('prodPlan','" + FILTER_KEY + "')") >= 0, '标签的 × 必须指向该筛选键');

  /* 一键清除（clearAllFilt 先置空 filters 再处理 DOM，故桩内即便后续抛错也不影响口径断言） */
  app.run('try{clearAllFilt("prodPlan");}catch(e){}');
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(tState("prodPlan").filters)')), {}, '清除后 filters 必须为空');
  assert.equal(filteredPlanIds(app).length, 5, '清除后应恢复全量 5 张排产单');
  app.dispose();
});

/* ================================================================
   §C 拦截分支
   ================================================================ */

test('C1 未勾选（0 条）→ alert 且不跳转、不筛选', function () {
  const f = standardFixtures();
  const app = makeApp(f.dels, f.plans);
  app.setGlobal('activeTab', 'delivery');
  app.setGlobal('planView', 'day');
  selectDelivery(app, []);
  const o = invoke(app);

  assert.equal(o.alerts.length, 1, '应恰 1 次 alert');
  assert.ok(o.alerts[0].indexOf('请先勾选 1 条交付计划') >= 0, '提示文案：' + JSON.stringify(o.alerts));
  assert.equal(o.activeTab, 'delivery', '不得跳转');
  assert.deepEqual(o.filters, {}, '不得设置 filters');
  app.dispose();
});

test('C2 勾选 ≥2 条 → alert 且不跳转、不筛选（当前已选 2 条）', function () {
  const f = standardFixtures();
  const app = makeApp(f.dels, f.plans);
  app.setGlobal('activeTab', 'delivery');
  app.setGlobal('planView', 'day');
  selectDelivery(app, [0, 1]);
  const o = invoke(app);

  assert.equal(o.alerts.length, 1, '应恰 1 次 alert');
  assert.ok(o.alerts[0].indexOf('只能选择 1 条') >= 0, '提示文案：' + JSON.stringify(o.alerts));
  assert.ok(o.alerts[0].indexOf('2') >= 0, '提示应含实际选中数量 2，实际：' + JSON.stringify(o.alerts));
  assert.equal(o.activeTab, 'delivery', '不得跳转');
  assert.deepEqual(o.filters, {}, '不得设置 filters');
  app.dispose();
});

test('C3 交付计划缺 planNo → alert 且不跳转/不筛选', function () {
  const app = makeApp([mkDelivery('', 'KCDD-1')], [mkPlan('PSCD-A', '')]);
  app.setGlobal('activeTab', 'delivery');
  app.setGlobal('planView', 'day');
  selectDelivery(app, [0]);
  const o = invoke(app);

  assert.equal(o.alerts.length, 1, '应恰 1 次 alert');
  assert.ok(o.alerts[0].indexOf('缺少') >= 0 && o.alerts[0].indexOf('交付计划编号') >= 0,
    '提示须说明缺编号，实际：' + JSON.stringify(o.alerts));
  assert.equal(o.activeTab, 'delivery', '不得跳转');
  assert.deepEqual(o.filters, {}, '不得设置 filters');
  app.dispose();
});

test('C4 勾选索引在 deliveries 中不存在 → alert「未找到交付计划」且不跳转', function () {
  const f = standardFixtures();
  const app = makeApp(f.dels, f.plans);
  app.setGlobal('activeTab', 'delivery');
  app.setGlobal('planView', 'day');
  selectDelivery(app, [99]);
  const o = invoke(app);

  assert.equal(o.alerts.length, 1, '应恰 1 次 alert');
  assert.ok(o.alerts[0].indexOf('未找到交付计划') >= 0, '提示文案：' + JSON.stringify(o.alerts));
  assert.equal(o.activeTab, 'delivery', '不得跳转');
  app.dispose();
});

test('C5 空结果判定口径与筛选口径同源：有排产单时**不得**弹「无排产单」提示', function () {
  const f = standardFixtures();
  const app = makeApp(f.dels, f.plans);
  selectDelivery(app, [0]);
  const o = invoke(app);
  assert.equal(o.alerts.length, 0, '有排产单时不得弹空结果提示（防「提示有单、跳过去空表」的反向错）');
  /* 同源复核：函数内的空结果判定用的就是筛选键 deliveryPlanNo */
  assert.ok(/p(\.|\[['"])deliveryPlanNo/.test(FN_QUERY), '空结果判定必须取稳定外键 deliveryPlanNo');
  app.dispose();
});

/* ================================================================
   §D 口径一致性静态守卫
   ================================================================ */

test('D1 筛选 key 与 TBL_SCHEMAS.prodPlan 的 deliveryPlanNo 列 key **逐字相同**（防 typo 静默跳过）', function () {
  const m = /filters\s*=\s*\{\s*['"]?([A-Za-z0-9_]+)['"]?\s*:/.exec(FN_QUERY);
  assert.ok(m, '必须能在函数体内定位 `filters={ <key>: ... }` 形态，实际函数体：' + FN_QUERY);
  assert.equal(m[1], FILTER_KEY, '筛选 key 必须逐字为 ' + FILTER_KEY + '（写错会被 filterRows 静默 continue → 表现为「没筛」）');

  /* 与 schema 注册点严格对齐（从 index.html 的 TBL_SCHEMAS.prodPlan 字面量取） */
  const schemaRe = new RegExp('\\{key:\'' + FILTER_KEY + '\',label:\'交付计划编号\',type:\'text\',get:r=>r\\.p\\.' + FILTER_KEY + '\\|\\|\'\'\\}');
  assert.ok(schemaRe.test(INDEX_SRC), 'TBL_SCHEMAS.prodPlan 必须注册 ' + FILTER_KEY + ' 列（label 交付计划编号 / type text）');

  /* 空结果判定必须与筛选同源（同一外键） */
  assert.ok(/p(\.|\[['"])deliveryPlanNo(['"]\])?\s*===\s*no/.test(FN_QUERY),
    '空结果判定必须与筛选口径同源（p.deliveryPlanNo===no 或 p[\'deliveryPlanNo\']===no）');
});

test('D2 必须是**整体覆盖式**赋值（非 merge / 非按键写入），且强制 planView=\'all\'', function () {
  assert.ok(/tState\('prodPlan'\)\.filters\s*=\s*\{/.test(FN_QUERY),
    '必须整体覆盖 tState(\'prodPlan\').filters={...}（否则上一次筛选残留会继续生效）');
  assert.equal(/Object\.assign\([^)]*filters/.test(FN_QUERY), false, '不得用 Object.assign 做 merge');
  assert.equal(/filters\s*\[/.test(FN_QUERY), false, '不得按键写入 filters（残留键会存活）');
  /* 视图与跳转 */
  assert.ok(/planView\s*=\s*'all'\s*;/.test(FN_QUERY), '【口径1】必须含 planView=\'all\' 强制语句');
  assert.ok(/switchTab\('prodPlan'\)/.test(FN_QUERY), '必须 switchTab(\'prodPlan\') 跳转排产计划页');
  /* 顺序：必须先 planView/filters 后 switchTab（否则跳转后渲染读到旧状态） */
  assert.ok(FN_QUERY.indexOf("planView='all'") < FN_QUERY.indexOf("switchTab('prodPlan')"),
    'planView 赋值必须早于 switchTab（保证切换即渲染已设视图）');
  assert.ok(FN_QUERY.indexOf('tState(\'prodPlan\').filters=') < FN_QUERY.indexOf("switchTab('prodPlan')"),
    'filters 赋值必须早于 switchTab');
});

test('D3 唯一入口：index.html 恰 2 处（定义 + 按钮 onclick），js/*.js 0 处', function () {
  assert.equal(countOf(INDEX_SRC, FN_NAME), 2,
    'index.html 应恰 2 处 ' + FN_NAME + '（函数定义 + bulkBar 按钮 onclick）');
  assert.equal(countOf(FN_BULKBAR, FN_NAME), 1, 'bulkBar 内应恰 1 处引用（避免多按钮重复）');
  assert.ok(JS_FILES.length >= 5, 'js/ 目录应至少 5 个模块（防扫描范围退化），实际：' + JSON.stringify(JS_FILES));
  MODULE_SRC.forEach(function (m) {
    assert.equal(countOf(m.src, FN_NAME), 0, m.rel + ' 不应引用 ' + FN_NAME);
  });
});

/* ================================================================
   §E 版本推进 4 处
   ================================================================ */

test('E1 水印：index.html 恰 1 处 >build <BUILD><，上一版本权威/任意形态 0 处', function () {
  assert.equal((INDEX_SRC.match(build.buildMarkRe(build.BUILD)) || []).length, 1, build.BUILD + ' 权威水印应恰 1 处');
  assert.equal((INDEX_SRC.match(build.buildMarkRe(build.PREV)) || []).length, 0, '上一版本权威形态应为 0 处');
  assert.equal((INDEX_SRC.match(build.buildAnyRe(build.PREV)) || []).length, 0, '上一版本任意形态应为 0 处');
});

test('E2 tests/harness/build.js 的 BUILD/PREV 为手写字面量，且与 index.html 双向一致', function () {
  assert.equal(build.BUILD, '2026-10-31.158', 'BUILD 必须手写为本次版本 .158');
  assert.equal(build.PREV, '2026-10-23.157', 'PREV 必须手写为上一版本 .157');
  /* 正向：BUILD 必须能在 index.html 中命中 */
  assert.equal((INDEX_SRC.match(build.buildMarkRe(build.BUILD)) || []).length, 1, 'BUILD 必须命中且恰 1 处');
  /* 反向：deploy.sh 的提取式从 index.html 抽出实际水印，必须 === BUILD */
  const m = INDEX_SRC.match(/build ([0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+)</);
  assert.ok(m, 'index.html 必须存在 build YYYY-MM-DD.NNN< 形态');
  assert.equal(m[1], build.BUILD, 'deploy.sh 提取结果必须等于 harness BUILD');
  /* 判别力反虚设：不存在的版本号必须命中 0 */
  assert.equal((INDEX_SRC.match(build.buildMarkRe('2026-10-14.999')) || []).length, 0, '伪版本 .999 应命中 0');
});

test('E3 §E2 字面量副本（qa.ppshift-advance）已同步为本次 BUILD/PREV', function () {
  assert.ok(PPSHIFT_TEST_SRC.indexOf("assert.equal(build.BUILD, '" + build.BUILD + "'") >= 0,
    '§E2 必须硬编码断言 BUILD = ' + build.BUILD);
  assert.ok(PPSHIFT_TEST_SRC.indexOf("assert.equal(build.PREV, '" + build.PREV + "'") >= 0,
    '§E2 必须硬编码断言 PREV = ' + build.PREV);
  /* 交叉自证：文件里的字面量必须与 harness 常量一致（任一侧漂移即 FAIL） */
  const lm = PPSHIFT_TEST_SRC.match(/assert\.equal\(build\.BUILD,\s*'([0-9.\-]+)'/);
  const lp = PPSHIFT_TEST_SRC.match(/assert\.equal\(build\.PREV,\s*'([0-9.\-]+)'/);
  assert.ok(lm && lp, '必须能抽出 §E2 两处字面量');
  assert.equal(lm[1], build.BUILD, '§E2 BUILD 字面量必须等于 harness.BUILD');
  assert.equal(lp[1], build.PREV, '§E2 PREV 字面量必须等于 harness.PREV');
});

test('E4 js/guide.js：版本标注同步 + 新增「排产查询」使用说明条目（运行时可见）', function () {
  assert.ok(GUIDE_SRC.indexOf('2026-10-31（build .158）') >= 0, 'guide.js 顶部「更新」行必须标注 2026-10-31（build .158）');
  assert.equal(countOf(GUIDE_SRC, '排产查询（.147）'), 1, 'guide.js 必须有恰 1 条「排产查询（.147）」使用说明条目');
  assert.ok(GUIDE_SRC.indexOf('强制切「总览」视图') >= 0, '说明条目必须写明「强制切总览视图」（口径1 的用户可见承诺）');

  /* 运行时可见：GUIDE_MD 真的能在沙箱里被求值且含该条目 */
  const app = createApp({ installRecorder: false });
  const md = app.run('GUIDE_MD');
  assert.equal(typeof md, 'string', 'GUIDE_MD 必须可求值为字符串');
  assert.ok(md.indexOf('排产查询（.147）') >= 0, '运行时 GUIDE_MD 必须含该条目');
  assert.ok(md.indexOf('交付计划编号') >= 0, '运行时 GUIDE_MD 条目须写明按「交付计划编号」筛选');
  app.dispose();
});

/* ================================================================
   §F 反向探针（判别力自证）——用 transformMain 就地改造源码副本
   ----------------------------------------------------------------
   目的：证明本文件的断言**不是测了个寂寞**。做法：把 §B/§D 期望的某一条从源码副本里
   改掉，然后用**同一套行为断言**去跑改造后的副本 —— 断言必须 FAIL。
   全部在内存中完成（transformMain 钩子），不落任何磁盘痕迹。
   ================================================================ */

/** 源码副本改造指令：逐条自证「确实改到了源码」（否则探针无效） */
const PROBE = (function buildProbes() {
  const out = {
    /* 1) 去掉强制总览 */
    dropPlanViewAll: FN_QUERY.replace("planView='all';", '/*QAPROBE:removed*/'),
    /* 2) 筛选 key 写成 typo（filterRows 会静默跳过 → 表现为「没筛」） */
    typoFilterKey: FN_QUERY.replace("'deliveryPlanNo':{mode:'eq',val:no}", "'deliveryPlanNoX':{mode:'eq',val:no}"),
    /* 3) eq 改成 contains（前缀陷阱单会被误纳入） */
    containsMode: FN_QUERY.replace("{mode:'eq',val:no}", "{mode:'contains',val:no}"),
    /* 4) 覆盖式赋值改成按键合并（上一次残留会存活） */
    mergeInsteadOfOverwrite: FN_QUERY.replace(
      "tState('prodPlan').filters={'deliveryPlanNo':{mode:'eq',val:no}};",
      "tState('prodPlan').filters.deliveryPlanNo={mode:'eq',val:no};"),
  };
  Object.keys(out).forEach(function (k) {
    assert.notEqual(out[k], FN_QUERY, '探针指令未命中源码（探针将无效，需同步更新）：' + k);
  });
  return out;
})();

/** 用改造后的源码副本建沙箱（其余装配与 makeApp 完全一致） */
function makeProbeApp(probeFn, dels, plans) {
  return makeApp(dels, plans, {
    transformMain: function (code) { return code.replace(FN_QUERY, probeFn); },
  });
}

test('F1 探针：删掉 planView=\'all\' → 视图不再被强制（B1/B2 的视图断言必 FAIL）', function () {
  const f = standardFixtures();
  const app = makeProbeApp(PROBE.dropPlanViewAll, f.dels, f.plans);
  app.setGlobal('planView', 'week');
  app.setGlobal('activeTab', 'delivery');
  selectDelivery(app, [0]);
  const o = invoke(app);

  assert.equal(o.activeTab, 'prodPlan', '探针只动视图：跳转仍应发生');
  assert.equal(o.planView, 'week', '【探针证据】去掉后视图保持原值 week');
  /* 把 B1/B2 的期望施加到探针副本上 —— 必须抛错，否则说明断言恒真、无效 */
  assert.throws(function () { assert.equal(o.planView, 'all', 'B1 期望'); });
  app.dispose();
});

test('F2 探针：筛选 key 写成 typo → filterRows 静默跳过（B1 的 filters/filterRows 断言必 FAIL）', function () {
  const f = standardFixtures();
  const app = makeProbeApp(PROBE.typoFilterKey, f.dels, f.plans);
  loadProdPlanSchema(app);
  app.setGlobal('planView', 'week');
  app.setGlobal('activeTab', 'delivery');
  selectDelivery(app, [0]);
  const o = invoke(app);

  assert.deepEqual(o.filters, { deliveryPlanNoX: { mode: 'eq', val: TARGET_NO } }, '【探针证据】写入的是 typo key');
  assert.equal(o.planView, 'all', '探针只动 key');
  /* 静默跳过：未知筛选 key 被 filterRows continue → 全部 5 张排产单都返回 */
  const ids = filteredPlanIds(app);
  assert.equal(ids.length, 5, '【探针证据】typo key 被静默跳过 → 一张都没筛出（返回全量 5 张），实际：' + JSON.stringify(ids));
  assert.throws(function () { assert.deepEqual(o.filters, { deliveryPlanNo: { mode: 'eq', val: TARGET_NO } }, 'B1 期望'); });
  assert.throws(function () { assert.deepEqual(ids, f.expectIds, 'B1 期望'); });
  app.dispose();
});

test('F3 探针：mode 由 eq 改 contains → 前缀陷阱单被误纳入（B1 的筛选结果断言必 FAIL）', function () {
  const f = standardFixtures();
  const app = makeProbeApp(PROBE.containsMode, f.dels, f.plans);
  loadProdPlanSchema(app);
  app.setGlobal('activeTab', 'delivery');
  selectDelivery(app, [0]);
  const o = invoke(app);

  assert.deepEqual(o.filters, { deliveryPlanNo: { mode: 'contains', val: TARGET_NO } }, '【探针证据】mode 已变为 contains');
  const ids = filteredPlanIds(app);
  assert.ok(ids.indexOf('PSCD-E') >= 0, '【探针证据】contains 会把前缀陷阱单 PSCD-E 一并纳入，实际：' + JSON.stringify(ids));
  assert.equal(ids.length, 3, '应为 3 张（PSCD-A/B + 陷阱单），实际：' + JSON.stringify(ids));
  assert.throws(function () { assert.deepEqual(ids, f.expectIds, 'B1 期望'); });
  app.dispose();
});

test('F4 探针：覆盖式赋值改成按键合并 → 上一次残留键存活（B1 的 filters deepEqual 必 FAIL）', function () {
  const f = standardFixtures();
  const app = makeProbeApp(PROBE.mergeInsteadOfOverwrite, f.dels, f.plans);
  seedResidualFilter(app, 'orderId', 'KCDD-2');
  app.setGlobal('activeTab', 'delivery');
  selectDelivery(app, [0]);
  const o = invoke(app);

  assert.deepEqual(Object.keys(o.filters).sort(), ['deliveryPlanNo', 'orderId'],
    '【探针证据】合并语义下残留 orderId 存活，实际：' + JSON.stringify(o.filters));
  assert.throws(function () { assert.deepEqual(o.filters, { deliveryPlanNo: { mode: 'eq', val: TARGET_NO } }, 'B1 期望'); });
  app.dispose();
});

test('F5 探针有效性自证：探针指令确实命中源码（若未命中，F1~F4 全是空测）', function () {
  Object.keys(PROBE).forEach(function (k) {
    assert.notEqual(PROBE[k], FN_QUERY, '探针 ' + k + ' 必须真的改动源码');
    assert.ok(PROBE[k].length > 0, '探针 ' + k + ' 不得产出空函数体');
  });
  /* 探针副本必须仍能被沙箱装载（否则 F1~F4 会因为语法/装载错误而"假 FAIL"） */
  const f = standardFixtures();
  const app = makeProbeApp(PROBE.dropPlanViewAll, f.dels, f.plans);
  assert.equal(typeof app.run('typeof ' + FN_NAME), 'string', '探针副本必须可装载');
  assert.equal(app.run('typeof ' + FN_NAME), 'function', '探针副本内函数仍须存在');
  app.dispose();
});
