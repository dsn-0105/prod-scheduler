'use strict';
/* ================================================================
   tests/invfilt.161.test.js —— 库存管理「结余进度」列的**语义筛选档**回归（【build .161】）
   ================================================================
   需求（用户 2026-11-20 拍板，原话要点）：
     库存管理页（NAV 'inv' → renderInvOrders，formKey='order_inv'）表格中「结余进度」列的
     列头漏斗面板里，新增两个筛选项：
       · inv_short「低于最小库存量（红/黄警示）」= 界面画着红三角或黄三角的行
       · inv_over 「超过最大库存量（积压/灰）」  = 界面画着灰标的行
     口径 = **所见即所筛**：档位一律取自 invStockLevel（全工程唯一 4 档判定），
     **不得**改写成「严格 结余<最小 且 最小>0」——那会漏掉「未设下限（min 空/0）但结余<0」的红标行。

   本文件守什么（每条都写明「坏了会怎么红」）：
     §A 引擎级行为：两个语义档只筛出各自该筛的行；与 invStockLevel 逐行交叉校验（= 所见即所筛）
     §B 边界与判别力：结余=0 且 min>0 入选 / 结余<0 且未设 min 入选 / min=0 或空 且 结余≥0 不入选；
        **语义模式不得被静默跳过**（val 恒空也要真的过滤；且未知模式仍必须被跳过，防「什么都放行」）
     §C 零回归：_balPct 上既有 4 种数值模式（gte/lte/eq/neq）结果不变
     §D 面板：漏斗下拉真的出现两个新选项（带 data-noval）；其余数值列/t 文本列选项数不变；
        fpModeChange 的 data-noval 等价重构（为空/不为空仍隐藏输入框）
     §E 筛选条：chip 含新模式名、可清除、清除后恢复全量
     §F 静态守卫：档位单源（`return 'red'` 等各恰 1 处）、语义函数只委托不自判、
        filterRows 的「先取列再判有效性」顺序、语义档声明范围（只 _balPct 一处）

   运行（显式文件，勿用 node -e，见 tests/README §1）：
     node --test tests/invfilt.161.test.js
   ================================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createApp, ROOT } = require('./harness/sandbox');
/* 版本号只从单一来源派生（本文件是 per-version 用例，**禁止**硬编码版本字面量：
   否则每推进一版就多一处「下一版必红」的锚点，见 tests/harness/build.js 版本推进纪律）。 */
const build = require('./harness/build');

const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* ================================================================
   夹具
   ----------------------------------------------------------------
   库存订单：pu（已计划未交付）恒 0（本夹具不造交付计划/排产单）⇒ **结余 = 已交付**，
   于是「结余」完全由 deliveredQty 单独决定，档位断言不含糊。
   每张单 1 行（.155：库存订单只能有 1 行明细），与线上形态一致。
   ================================================================ */

/**
 * 造一张库存订单（单行明细）。
 * @param {string} id 单据编号
 * @param {{pid:string,qty:number,min:*,max:*,dv:number}} r 明细行
 * @returns {Object} 订单
 */
function mkInvOrder(id, r) {
  return {
    id: id, orderType: '库存订单', customer: '内部库存', status: '执行中',
    startDate: '2026-11-20', deadline: '', contractNo: '',
    items: [{
      productId: r.pid, productName: r.pid, spec: '', model: '', unit: '台',
      orderQty: r.qty,
      stockMax: r.max,
      stockMin: r.min,
      deliveredQty: r.dv,
      calledQty: 0, lineNotes: '',
    }],
  };
}

/* 9 行覆盖 4 档 + 3 类边界。orderQty 统一 100 ⇒ 结余进度(%) = 结余 数值本身。
   id  →  dv   min   max   期望档位      期望入选
   T01 →  100   50   100   green        无（正常区间）
   T02 →   10   50   100   amber        inv_short（未达下限）
   T03 →   -5   50   100   red          inv_short（欠货）
   T04 →  200   50   100   gray         inv_over （超上限）
   T05 →    0   50   100   amber        inv_short（**边界 A**：结余=0 且下限>0 —— .160 起判黄）
   T06 →  -10   ''   100   red          inv_short（**边界 B**：未设下限但结余<0，界面仍是红标）
   T07 →   50    0     0   green        无（上下限=0 即不设限）
   T08 →   50   ''    ''   green        无（上下限留空即不设限）
   T09 →  120   50   100   gray         inv_over （超上限，第二个灰行） */
const FIXTURES = [
  ['T01', { pid: 'PA', qty: 100, min: 50, max: 100, dv: 100 }],
  ['T02', { pid: 'PA', qty: 100, min: 50, max: 100, dv: 10 }],
  ['T03', { pid: 'PA', qty: 100, min: 50, max: 100, dv: -5 }],
  ['T04', { pid: 'PA', qty: 100, min: 50, max: 100, dv: 200 }],
  ['T05', { pid: 'PB', qty: 100, min: 50, max: 100, dv: 0 }],
  ['T06', { pid: 'PB', qty: 100, min: '', max: 100, dv: -10 }],
  ['T07', { pid: 'PB', qty: 100, min: 0, max: 0, dv: 50 }],
  ['T08', { pid: 'PB', qty: 100, min: '', max: '', dv: 50 }],
  ['T09', { pid: 'PC', qty: 100, min: 50, max: 100, dv: 120 }],
];

const TOTAL = FIXTURES.length;
const SHORT_IDS = ['T02', 'T03', 'T05', 'T06'];
const OVER_IDS = ['T04', 'T09'];

/**
 * 装载沙箱并注入夹具（其余全局给空默认，避免「未注入的全局在渲染途中 undefined」噪声）。
 * @param {Object} [seed] 追加/覆盖的全局
 * @returns {Object} app（调用方须 dispose）
 */
function boot(seed) {
  return createApp({
    quietConsole: true,
    seed: Object.assign({
      products: [
        { id: 'PA', name: '甲产品', spec: '', model: '', unit: '台', stock: 0, status: '启用' },
        { id: 'PB', name: '乙产品', spec: '', model: '', unit: '台', stock: 0, status: '启用' },
        { id: 'PC', name: '丙产品', spec: '', model: '', unit: '台', stock: 0, status: '启用' },
      ],
      parts: [], partLogs: [],
      deliveries: [], productionPlans: [], productionReports: [],
      processTemplates: [], transfers: [], logs: [],
      fields: { product: [], order: [] }, fieldsAudit: 'audited', fieldsDraft: null,
      meta: { seq: 0 }, tblLayout: {}, uiDefaults: { order: {} },
      tblPage: {}, tblState: {}, selRows: {}, lastRowIds: {},
    }, seed || {}),
  });
}

/** 渲染库存管理页（顺带注册 TBL_SCHEMAS['order_inv'] / TBL_ROWS['order_inv']） */
function renderInv(app) {
  app.run('renderInvOrders()');
  assert.equal(app.run("Array.isArray(TBL_ROWS['order_inv'])?TBL_ROWS['order_inv'].length:-1"), TOTAL,
    '夹具应有 ' + TOTAL + ' 行（renderOrderTable 未注册 TBL_ROWS）');
}

/**
 * 按当前筛选态跑一次 filterRows，回传命中的单据编号（跨 realm 安全：走 JSON）。
 * @param {Object} app 沙箱
 * @returns {string[]} 命中行 id（保持行序）
 */
function filterIds(app) {
  return JSON.parse(app.run(
    "JSON.stringify(filterRows('order_inv',TBL_ROWS['order_inv']).map(function(r){return r.order.id;}))"
  ));
}

/**
 * 设置某列的筛选状态（整体覆盖，不 merge）。
 * @param {Object} app 沙箱
 * @param {string} key 列 key
 * @param {Object} f 筛选态 {mode,val?,vals?}
 */
function setFilter(app, key, f) {
  app.run("tState('order_inv').filters={" + JSON.stringify(key) + ':' + JSON.stringify(f) + '}');
}

/** 清空筛选态（模拟 clearFilt/clearAllFilt 的状态效果） */
function clearFilters(app) {
  app.run("tState('order_inv').filters={}");
}

/** 取函数源码（按大括号配平；仅用于本文件涉及的纯函数） */
function fnSrc(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, '未找到函数 ' + name + '（被删除或改名）');
  let d = 1;
  let p = src.indexOf('{', i) + 1;
  for (; p < src.length; p++) {
    if (src[p] === '{') d++;
    else if (src[p] === '}') { d--; if (d === 0) return src.slice(i, p + 1); }
  }
  throw new Error('函数 ' + name + ' 大括号不配平');
}

/** 出现次数（字面量） */
function countOcc(src, needle) {
  let n = 0, i = 0;
  for (;;) { const k = src.indexOf(needle, i); if (k < 0) return n; n++; i = k + needle.length; }
}

/* ================================================================
   §A 引擎级：两个语义档的筛选结果（行为级，不经 UI）
   ================================================================ */

test('A1 inv_short 只筛出红/黄行，绿/灰被排除', function () {
  const app = boot({ orders: FIXTURES.map(function (x) { return mkInvOrder(x[0], x[1]); }) });
  try {
    renderInv(app);
    assert.deepEqual(filterIds(app), FIXTURES.map(function (x) { return x[0]; }), '未设筛选时应为全量 ' + TOTAL + ' 行');
    setFilter(app, '_balPct', { mode: 'inv_short', val: '' });
    assert.deepEqual(filterIds(app), SHORT_IDS,
      'inv_short 应只命中 red(T03,T06)+amber(T02,T05)；green(T01,T07,T08)/gray(T04,T09) 必须被排除');
  } finally { app.dispose(); }
});

test('A2 inv_over 只筛出灰行（超上限）', function () {
  const app = boot({ orders: FIXTURES.map(function (x) { return mkInvOrder(x[0], x[1]); }) });
  try {
    renderInv(app);
    setFilter(app, '_balPct', { mode: 'inv_over', val: '' });
    assert.deepEqual(filterIds(app), OVER_IDS, 'inv_over 应只命中 gray(T04,T09)；红/黄/绿必须被排除');
  } finally { app.dispose(); }
});

test('A3 所见即所筛：筛选结果与 invStockLevel 逐行判定完全一致（不掺第二套阈值）', function () {
  const app = boot({ orders: FIXTURES.map(function (x) { return mkInvOrder(x[0], x[1]); }) });
  try {
    renderInv(app);
    /* 用**界面同一个** 4 档判定（invStockLevel）独立算一遍期望集合，不复用 invShortOf/invOverOf */
    const expectShort = JSON.parse(app.run(
      "(function(){var o=[];TBL_ROWS['order_inv'].forEach(function(r){var lv=invStockLevel(r.item.deliveredQty,r.item.stockMin,r.item.stockMax);" +
      "if(lv==='red'||lv==='amber')o.push(r.order.id);});return JSON.stringify(o);})()"
    ));
    const expectOver = JSON.parse(app.run(
      "(function(){var o=[];TBL_ROWS['order_inv'].forEach(function(r){var lv=invStockLevel(r.item.deliveredQty,r.item.stockMin,r.item.stockMax);" +
      "if(lv==='gray')o.push(r.order.id);});return JSON.stringify(o);})()"
    ));
    assert.deepEqual(expectShort, SHORT_IDS, '夹具期望集自检（红的/黄的应为 ' + SHORT_IDS.join(',') + '）');
    assert.deepEqual(expectOver, OVER_IDS, '夹具期望集自检（灰的应为 ' + OVER_IDS.join(',') + '）');

    setFilter(app, '_balPct', { mode: 'inv_short', val: '' });
    assert.deepEqual(filterIds(app), expectShort, 'inv_short 结果必须等于「界面判为 red/amber」的行集合');
    setFilter(app, '_balPct', { mode: 'inv_over', val: '' });
    assert.deepEqual(filterIds(app), expectOver, 'inv_over 结果必须等于「界面判为 gray」的行集合');
  } finally { app.dispose(); }
});

/* ================================================================
   §B 边界口径与判别力
   ================================================================ */

test('B1 边界 A：结余=0 且 最小库存量>0 → 入选 inv_short（.160 起该行是黄标）', function () {
  const app = boot({ orders: FIXTURES.map(function (x) { return mkInvOrder(x[0], x[1]); }) });
  try {
    renderInv(app);
    /* 先钉死单行判定，避免「整表筛选碰巧对」 */
    assert.equal(app.run("invShortOf(0,50,100)"), true, '结余 0 + 下限 50 → 必须算「低于最小库存量」（黄标）');
    setFilter(app, '_balPct', { mode: 'inv_short', val: '' });
    assert.ok(filterIds(app).indexOf('T05') >= 0, 'T05（结余 0、下限 50）必须入选 inv_short');
    /* 反向：若口径被改成「严格 结余<最小」，0 会被漏掉 ⇒ 本条必红 */
    assert.ok(filterIds(app).length > 0, '不得为空集');
  } finally { app.dispose(); }
});

test('B2 边界 B：结余<0 且**未设**最小库存量 → 仍是红标，必须入选 inv_short', function () {
  const app = boot({ orders: FIXTURES.map(function (x) { return mkInvOrder(x[0], x[1]); }) });
  try {
    renderInv(app);
    assert.equal(app.run("invStockLevel(-10,'',100)"), 'red', '未设下限 + 结余<0 → 界面是红标');
    assert.equal(app.run("invShortOf(-10,'',100)"), true, '红标必须算作「低于最小库存量」档');
    setFilter(app, '_balPct', { mode: 'inv_short', val: '' });
    assert.ok(filterIds(app).indexOf('T06') >= 0,
      'T06（结余 -10、下限留空）必须入选 —— 「严格 结余<最小 且 最小>0」的写法会漏掉它');
  } finally { app.dispose(); }
});

test('B3 边界 C：最小库存量=0/空 且 结余≥0 → 不入选 inv_short；也未超上限 ⇒ 两个档都不入选', function () {
  const app = boot({ orders: FIXTURES.map(function (x) { return mkInvOrder(x[0], x[1]); }) });
  try {
    renderInv(app);
    assert.equal(app.run("invShortOf(50,0,0)"), false, '下限=0 即不设限 → 结余 50 不得算缺货');
    assert.equal(app.run("invShortOf(50,'','')"), false, '下限留空 → 同上');
    setFilter(app, '_balPct', { mode: 'inv_short', val: '' });
    const s = filterIds(app);
    assert.equal(s.indexOf('T07'), -1, 'T07（下限=0、结余 50）不得入选 inv_short');
    assert.equal(s.indexOf('T08'), -1, 'T08（下限留空、结余 50）不得入选 inv_short');
    setFilter(app, '_balPct', { mode: 'inv_over', val: '' });
    const o = filterIds(app);
    assert.equal(o.indexOf('T07'), -1, 'T07（上限=0）不得入选 inv_over');
    assert.equal(o.indexOf('T08'), -1, 'T08（上限留空）不得入选 inv_over');
  } finally { app.dispose(); }
});

test('B4 语义模式不得被静默跳过（val 恒空也必须真的过滤）', function () {
  const app = boot({ orders: FIXTURES.map(function (x) { return mkInvOrder(x[0], x[1]); }) });
  try {
    renderInv(app);
    /* 专防 filterRows 的旧顺序坑：先判 hasVals/hasVal/isEmptyMode 才取列 ⇒ 语义模式（val 恒空）
       在 continue 处被静默跳过，表现为「面板里选中了、表格却没筛」。 */
    setFilter(app, '_balPct', { mode: 'inv_short', val: '' });
    const withEmptyVal = filterIds(app);
    assert.equal(withEmptyVal.length, SHORT_IDS.length, 'val=\'\' 时必须真的过滤（旧顺序会返回全量 ' + TOTAL + '）');
    assert.ok(withEmptyVal.length < TOTAL, '结果数必须小于全量，实际 ' + withEmptyVal.length + '/' + TOTAL);

    /* 无 val 字段（undefined）同样生效 —— applyFilt 在其它入口可能不写该字段 */
    setFilter(app, '_balPct', { mode: 'inv_over' });
    assert.equal(filterIds(app).length, OVER_IDS.length, 'val 缺失时也必须生效');

    /* 反假守卫：随便一个**未声明**的模式仍然必须被跳过（否则说明 valFreeMode 变成了「什么都放行」） */
    setFilter(app, '_balPct', { mode: 'bogus_mode', val: '' });
    assert.equal(filterIds(app).length, TOTAL, '未声明的模式应被跳过（返回全量），不得把所有行筛掉或误放行');
  } finally { app.dispose(); }
});

test('B5 语义档与列值无关：_balPct 的数值（百分比）不影响判定，只看结余与上下限', function () {
  const app = boot({ orders: FIXTURES.map(function (x) { return mkInvOrder(x[0], x[1]); }) });
  try {
    renderInv(app);
    /* T03 结余 -5 ⇒ 结余进度 -5%；T04 结余 200 ⇒ 200%；两者百分比都不在「正常 0~100」内，
       但档位仍应分别由「结余<0」与「结余>上限」决定 —— 若有人把判定改到百分比上，
       T01（100%→green）与 T09（120%→gray）会互换，本节即红。 */
    assert.equal(app.run("invStockLevel(120,50,100)"), 'gray', '结余 120 > 上限 100 → gray');
    assert.equal(app.run("invStockLevel(100,50,100)"), 'green', '结余 100 = 上限 → green（不是 > 上限）');
    setFilter(app, '_balPct', { mode: 'inv_over', val: '' });
    assert.deepEqual(filterIds(app), OVER_IDS, 'inv_over 结果不受「结余进度百分比」影响');
  } finally { app.dispose(); }
});

/* ================================================================
   §C 零回归：_balPct 上既有 4 种数值模式
   ================================================================ */

test('C1 既有数值模式 gte/lte/eq/neq 对 _balPct 行为不变', function () {
  const app = boot({ orders: FIXTURES.map(function (x) { return mkInvOrder(x[0], x[1]); }) });
  try {
    renderInv(app);
    /* 百分比 = 结余 ÷ invQtyOf(=stockMax，库存订单分母是**最大库存量**)：
       T01=100 T02=10 T03=-5 T04=200 T05=0 T06=-10 T07=0（stockMax=0 ⇒ 分母 0 ⇒ 按既有口径落 0）
       T08=50（stockMax 留空 ⇒ 回退 orderQty 100）T09=120 */
    setFilter(app, '_balPct', { mode: 'gte', val: 100 });
    assert.deepEqual(filterIds(app), ['T01', 'T04', 'T09'], 'gte 100 → ≥100% 的行');
    setFilter(app, '_balPct', { mode: 'lte', val: 0 });
    assert.deepEqual(filterIds(app), ['T03', 'T05', 'T06', 'T07'], 'lte 0 → ≤0% 的行（含 -5 / 0 / -10 / 0）');
    setFilter(app, '_balPct', { mode: 'eq', val: 50 });
    assert.deepEqual(filterIds(app), ['T08'], 'eq 50 → 恰 50% 的行');
    setFilter(app, '_balPct', { mode: 'neq', val: 50 });
    assert.equal(filterIds(app).length, TOTAL - 1, 'neq 50 → 除 T08 外全部');
    /* 数值模式仍受 hasVal 约束：val 留空 ⇒ 该筛选不生效（语义档才允许空 val） */
    setFilter(app, '_balPct', { mode: 'gte', val: '' });
    assert.equal(filterIds(app).length, TOTAL, '数值模式 val 为空时应保持旧行为（不筛）');
  } finally { app.dispose(); }
});

/* ================================================================
   §D 面板：漏斗下拉选项 + fpModeChange 的 data-noval 等价重构
   ================================================================ */

/**
 * 打开某列漏斗面板并回传面板 innerHTML（DOM 桩下 openFilter 可求值）。
 * @param {Object} app 沙箱
 * @param {string} key 列 key
 * @returns {string} 面板 HTML
 */
function panelHtml(app, key) {
  return app.run(
    "(function(){var el=document.createElement('i');openFilter(el,'order_inv'," + JSON.stringify(key) + ");" +
    "return filtPop?filtPop.innerHTML:'';})()"
  );
}

test('D1 面板选项：「结余进度」下拉 = 原 4 模式 + 2 语义档，语义档带 data-noval', function () {
  const app = boot({ orders: FIXTURES.map(function (x) { return mkInvOrder(x[0], x[1]); }) });
  try {
    renderInv(app);
    const html = panelHtml(app, '_balPct');
    assert.ok(html.indexOf('结余进度') >= 0, '面板标题应为「结余进度」');
    ['gte', 'lte', 'eq', 'neq'].forEach(function (m) {
      assert.ok(html.indexOf('value="' + m + '"') >= 0, '原数值模式 ' + m + ' 不得消失（零回归）');
    });
    assert.ok(html.indexOf('value="inv_short"') >= 0, '必须出现 inv_short 选项');
    assert.ok(html.indexOf('value="inv_over"') >= 0, '必须出现 inv_over 选项');
    assert.ok(html.indexOf('低于最小库存量（红/黄警示）') >= 0, 'inv_short 文案必须是「低于最小库存量（红/黄警示）」');
    assert.ok(html.indexOf('超过最大库存量（积压/灰）') >= 0, 'inv_over 文案必须是「超过最大库存量（积压/灰）」');
    assert.equal(countOcc(html, '<option'), 6, '选项总数 = 4 原模式 + 2 语义档，实际 ' + countOcc(html, '<option'));
    assert.equal(countOcc(html, 'data-noval="1"'), 2, '恰两个语义档带 data-noval（决定是否隐藏数值框）');
    assert.ok(html.indexOf('onchange="fpModeChange()"') >= 0, '数值列下拉改变时须触发 fpModeChange 以显隐数值框');
    assert.ok(html.indexOf('id="fp_val"') >= 0, '数值输入框仍须存在（语义模式之外的 4 模式要用它）');
  } finally { app.dispose(); }
});

test('D2 面板回归：未声明 semFilters 的数值列（最大库存量）选项仍只有 4 个、无 data-noval', function () {
  const app = boot({ orders: FIXTURES.map(function (x) { return mkInvOrder(x[0], x[1]); }) });
  try {
    renderInv(app);
    const html = panelHtml(app, 'stockMax');
    assert.equal(countOcc(html, '<option'), 4, '其它数值列必须是原 4 模式（语义档只挂在 _balPct 上）');
    assert.equal(countOcc(html, 'data-noval'), 0, '其它数值列不得出现 data-noval');
  } finally { app.dispose(); }
});

test('D3 面板回归：文本列 8 模式不变，其中「为空/不为空」恰 2 个带 data-noval', function () {
  const app = boot({ orders: FIXTURES.map(function (x) { return mkInvOrder(x[0], x[1]); }) });
  try {
    renderInv(app);
    const html = panelHtml(app, 'productName');
    assert.equal(countOcc(html, '<option'), 8, 'order_inv 文本列应为金蝶式 8 模式（零回归）');
    assert.equal(countOcc(html, 'data-noval="1"'), 2, '只有「为空/不为空」需要隐藏关键字输入框');
    assert.ok(html.indexOf('value="is_empty" data-noval="1"') >= 0, '为空选项须带 data-noval');
    assert.ok(html.indexOf('value="not_empty" data-noval="1"') >= 0, '不为空选项须带 data-noval');
    assert.ok(html.indexOf('value="contains"  ') >= 0 || html.indexOf('value="contains"') >= 0, '包含选项仍在');
  } finally { app.dispose(); }
});

/**
 * 在沙箱内造一个假 document，驱动 fpModeChange 并回传输入框的 display。
 * @param {Object} app 沙箱
 * @param {Array<Object>} opts 选项数组（含 value 与可选 dataNoval 标记）
 * @param {number} idx 选中的下标
 * @returns {string} fp_val 的 style.display
 */
function fpDisplayWith(app, opts, idx) {
  const optionList = opts.map(function (o) {
    return o.dataNoval ? { value: o.value, dataset: { noval: '1' } } : { value: o.value, dataset: {} };
  });
  const script = [
    'var __val={style:{display:"INIT"}};',
    'var __sel={value:' + JSON.stringify(opts[idx].value) + ',options:' + JSON.stringify(optionList) + ',selectedIndex:' + idx + '};',
    'document={getElementById:function(id){if(id==="fp_mode")return __sel;if(id==="fp_val")return __val;return null;},' +
      'createElement:function(){return {style:{},dataset:{},appendChild:function(){},addEventListener:function(){}};},' +
      'body:{appendChild:function(){}},addEventListener:function(){}};',
    'fpModeChange();',
    '__val.style.display;',
  ].join('\n');
  return app.run(script);
}

test('D4 fpModeChange 等价重构：无 data-noval 的模式显示输入框，带 data-noval 的隐藏', function () {
  const app = boot({ orders: [] });
  try {
    const TEXT_MODES = [
      { value: 'contains' }, { value: 'eq' }, { value: 'neq' },
      { value: 'is_empty', dataNoval: true }, { value: 'not_empty', dataNoval: true },
    ];
    assert.equal(fpDisplayWith(app, TEXT_MODES, 0), '', '「包含」须显示关键字输入框（不能因重构被误隐藏）');
    assert.equal(fpDisplayWith(app, TEXT_MODES, 1), '', '「等于」须显示');
    assert.equal(fpDisplayWith(app, TEXT_MODES, 3), 'none', '「为空」须隐藏输入框');
    assert.equal(fpDisplayWith(app, TEXT_MODES, 4), 'none', '「不为空」须隐藏输入框');

    const NUM_MODES = [
      { value: 'gte' }, { value: 'eq' }, { value: 'inv_short', dataNoval: true }, { value: 'inv_over', dataNoval: true },
    ];
    assert.equal(fpDisplayWith(app, NUM_MODES, 0), '', '「大于等于」须显示数值框');
    assert.equal(fpDisplayWith(app, NUM_MODES, 2), 'none', '语义档 inv_short 须隐藏数值框（不需要填数）');
    assert.equal(fpDisplayWith(app, NUM_MODES, 3), 'none', '语义档 inv_over 须隐藏数值框');
  } finally { app.dispose(); }
});

/* ================================================================
   §E 筛选条（chip）与清除
   ================================================================ */

test('E1 filterBar：语义筛选必须产出 chip（含新模式名），否则「筛了却看不到、也清不掉」', function () {
  const app = boot({ orders: FIXTURES.map(function (x) { return mkInvOrder(x[0], x[1]); }) });
  try {
    renderInv(app);
    clearFilters(app);
    assert.equal(app.run("filterBar('order_inv')"), '', '未设筛选时不显示筛选条');

    setFilter(app, '_balPct', { mode: 'inv_short', val: '' });
    const bar1 = app.run("filterBar('order_inv')");
    assert.ok(bar1.indexOf('低于最小库存量') >= 0, '筛选条须含「低于最小库存量」，实际：' + bar1);
    assert.ok(bar1.indexOf('结余进度') >= 0, '筛选条须点明是哪一列（结余进度）');
    assert.ok(bar1.indexOf('清除全部') >= 0, '筛选条须带「清除全部」入口');

    setFilter(app, '_balPct', { mode: 'inv_over', val: '' });
    const bar2 = app.run("filterBar('order_inv')");
    assert.ok(bar2.indexOf('超过最大库存量') >= 0, '筛选条须含「超过最大库存量」，实际：' + bar2);
  } finally { app.dispose(); }
});

test('E2 清除筛选后恢复全量；chip 的 × 与「清除全部」共用同一状态键', function () {
  const app = boot({ orders: FIXTURES.map(function (x) { return mkInvOrder(x[0], x[1]); }) });
  try {
    app.setGlobal('renderContent', function () {});
    renderInv(app);
    setFilter(app, '_balPct', { mode: 'inv_short', val: '' });
    assert.equal(filterIds(app).length, SHORT_IDS.length, '先确认筛选生效');

    app.run("clearFilt('order_inv','_balPct')");
    assert.equal(filterIds(app).length, TOTAL, 'clearFilt 后必须恢复全量 ' + TOTAL + ' 行');
    assert.equal(app.run("filterBar('order_inv')"), '', 'clearFilt 后筛选条必须消失');

    setFilter(app, '_balPct', { mode: 'inv_over', val: '' });
    assert.equal(filterIds(app).length, OVER_IDS.length, '再次设置仍生效');
    app.run("clearAllFilt('order_inv')");
    assert.equal(filterIds(app).length, TOTAL, 'clearAllFilt 后必须恢复全量');
    assert.deepEqual(JSON.parse(app.run("JSON.stringify(tState('order_inv').filters)")), {}, '筛选态须被清空');
  } finally { app.dispose(); }
});

/* ================================================================
   §F 静态守卫（单源 / 范围 / 引擎顺序）
   ================================================================ */

test('F1 档位单源：red/amber/gray/green 各恰 1 处 return（语义函数不得产出档位）', function () {
  const app = boot({ orders: [] });
  try {
    const plain = INDEX_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.equal(countOcc(plain, "return 'red'"), 1, "「return 'red'」只许由 invStockLevel 产出一次");
    assert.equal(countOcc(plain, "return 'amber'"), 1, "「return 'amber'」只许一次");
    assert.equal(countOcc(plain, "return 'gray'"), 1, "「return 'gray'」只许一次");
    assert.equal(countOcc(plain, "return 'green'"), 1, "「return 'green'」只许一次");

    /* invStockLevel 本体零改动（本轮只加筛选，不改档位阈值 —— .160 的零值口径必须原样在场） */
    const lv = fnSrc(INDEX_SRC, 'invStockLevel');
    assert.ok(lv.indexOf("num(v)>=0&&min!=null&&min!==''&&num(min)>0&&num(v)<num(min)") >= 0,
      '.160 的 amber 档（0 ≤ v < 最小 且 最小>0）必须原样保留');
    assert.equal(lv.indexOf('num(v)>0&&min!=null'), -1, '.160 已废止的旧口径不得复活');

    /* 语义函数只委托、不自判（A4 单源守卫红线）：不得出现阈值运算 */
    const shortFn = fnSrc(INDEX_SRC, 'invShortOf');
    const overFn = fnSrc(INDEX_SRC, 'invOverOf');
    assert.ok(shortFn.indexOf('invStockLevel(v,min,max)') >= 0, 'invShortOf 必须委托 invStockLevel');
    assert.ok(overFn.indexOf('invStockLevel(v,min,max)') >= 0, 'invOverOf 必须委托 invStockLevel');
    [shortFn, overFn].forEach(function (f) {
      assert.equal(f.indexOf('num('), -1, '语义函数内不得出现数值运算（阈值必须来自 invStockLevel）：' + f);
      assert.equal(f.indexOf('stockMin'), -1, '语义函数内不得直接读上下限：' + f);
    });
  } finally { app.dispose(); }
});

test('F2 引擎顺序：filterRows 必须先取列、再判「是否有效筛选」，语义档再行级判定', function () {
  const app = boot({ orders: [] });
  try {
    const fr = fnSrc(INDEX_SRC, 'filterRows');
    const iCol = fr.indexOf("const col=schema.find(c=>c.key===key)");
    const iSem = fr.indexOf('const sem=(col.semFilters||[])');
    const iGate = fr.indexOf('if(!hasVals&&!hasVal&&!valFreeMode)continue;');
    const iTest = fr.indexOf('if(sem){if(!sem.test(r))return false;continue;}');
    assert.ok(iCol > 0, 'filterRows 必须取列定义');
    assert.ok(iSem > iCol, '语义档解析必须在取列之后（semFilters 挂在列上）');
    assert.ok(iGate > iSem, '「是否有效筛选」的闸门必须在语义档解析之后 —— 否则 val 恒空的语义模式会被静默跳过');
    assert.ok(iTest > iGate, '语义档的行级判定必须在闸门之后');
    assert.ok(fr.indexOf("valFreeMode=f.mode==='is_empty'||f.mode==='not_empty'||dateQuickMode(f)||!!sem") >= 0,
      'valFreeMode 必须把语义档纳入（!!sem），且保留既有三档');
  } finally { app.dispose(); }
});

test('F3 范围守卫：语义档只声明在库存管理的 _balPct（零部件页两列本轮不加）', function () {
  const app = boot({ orders: [] });
  try {
    const plain = INDEX_SRC.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal(countOcc(plain, 'semFilters:['), 1, '语义档声明只许 1 处（_balPct）；给零部件页加即超范围');
    assert.equal(countOcc(plain, "mode:'inv_short'"), 1, 'inv_short 声明 1 处');
    assert.equal(countOcc(plain, "mode:'inv_over'"), 1, 'inv_over 声明 1 处');
    /* 列 get 口径不变：结余进度仍是百分比数值（本轮不动列值语义）。
       注意 `key:'_balPct'` 在文件里出现多处（零部件页两列在**更靠前**的位置），故以 semFilters 声明处定位。 */
    const iSem = INDEX_SRC.indexOf('semFilters:[');
    assert.ok(iSem > 0, '必须存在语义档声明');
    const col = INDEX_SRC.slice(Math.max(0, iSem - 600), iSem + 600);
    assert.ok(col.indexOf("key:'_balPct'") >= 0, '语义档必须挂在「结余进度」(_balPct) 列上');
    assert.ok(col.indexOf('Math.round(bal/t*100)') >= 0, '_balPct 的 get 仍返回百分比数值（列值语义未变）');
    assert.ok(col.indexOf('label:') >= 0, '列定义结构完整');
  } finally { app.dispose(); }
});

test('F4 版本纪律：完整版本号只在权威水印出现 1 次；本版短标记 >= 3 处', function () {
  const app = boot({ orders: [] });
  try {
    assert.equal(countOcc(INDEX_SRC, build.BUILD), 1,
      'index.html 中完整版本号 ' + build.BUILD + ' 必须恰 1 处（即右下角水印）；注释里只许写【build .NNN】短形态');
    const no = String(build.BUILD).split('.')[1];
    assert.ok(countOcc(INDEX_SRC, 'build .' + no) >= 3, '本版改动点须留下 >= 3 处【build .' + no + '】短标记（实际 ' +
      countOcc(INDEX_SRC, 'build .' + no) + ' 处）');
    assert.equal(countOcc(INDEX_SRC, build.PREV), 0, '上一版完整版本号不得残留');
  } finally { app.dispose(); }
});
