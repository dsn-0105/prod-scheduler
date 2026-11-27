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
    assert.ok(fr.indexOf('const valFreeMode=isValFreeFiltMode(f)||!!sem') >= 0,
      'valFreeMode 必须把语义档纳入（!!sem），且 val 恒空的既有三档改由单源 isValFreeFiltMode(f) 提供（【build .167】）');
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

/* ================================================================
   §G 【build .162】漏斗图标点亮 / 判据单源 / 清脏值 / thCol 跨修订零回归
   ----------------------------------------------------------------
   背景（QA 独立回归 I3 捉出的缺陷，与 .161 已修的 chip 放行属**同一类**）：
     判据原先在 filterBar 与 thCol **各写一份**，只修了 filterBar 侧 ⇒
     语义档（val 恒空）下「筛选生效但列头漏斗图标不亮」，用户看不出该列已有筛选。
   修复：判据提升为模块级单一来源 `isSemFiltMode(m,key,mode)`，filterBar / thCol / applyFilt 三处共用。
   ================================================================ */

/** 取某列的 thCol 表头 HTML（需先 renderInv 注册 schema） */
function thOf(app, m, key) {
  const raw = app.run(
    "(function(){var c=(TBL_SCHEMAS[" + JSON.stringify(m) + "]||[]).filter(function(x){return x.key===" +
    JSON.stringify(key) + ";})[0];return c?thCol(" + JSON.stringify(m) + ",c):'';})()"
  );
  assert.ok(raw && raw.length > 0, m + '.' + key + ' 的 thCol 输出为空（列未注册或 thCol 失效）');
  return raw;
}

/** 漏斗图标是否点亮 */
function icoOn(app, m, key) {
  return /filt-ico on/.test(thOf(app, m, key));
}

test('G1 thCol：语义档（val 空）必须点亮漏斗图标（.161 曾为缺陷）', function () {
  const app = boot({ orders: FIXTURES.map(function (x) { return mkInvOrder(x[0], x[1]); }) });
  try {
    renderInv(app);
    clearFilters(app);
    /* ⚠ 探针强度提示（QA 实测经验，见 docs/系统知识.md §2 测试纪律）：
       「无筛选 → 不点亮」这条**判别力很弱** —— `act = f && (...)` 有 `f &&` 短路，
       无筛选时任何判据都不会点亮，所以它抓不住「判据被改成恒真」。
       真正有效的反假探针是下方 **「有筛选条目但模式无效」（gte + val:''）** 那条。 */
    assert.equal(icoOn(app, 'order_inv', '_balPct'), false, '无筛选时不得点亮（弱探针，见上方注释）');

    setFilter(app, '_balPct', { mode: 'inv_short', val: '' });
    assert.equal(icoOn(app, 'order_inv', '_balPct'), true,
      'inv_short 生效（val 恒空）时漏斗图标必须点亮 —— .161 缺陷即此处不亮');
    assert.equal(filterIds(app).length, SHORT_IDS.length, '前提自证：该状态下筛选确实生效');

    setFilter(app, '_balPct', { mode: 'inv_over', val: '' });
    assert.equal(icoOn(app, 'order_inv', '_balPct'), true, 'inv_over 同样必须点亮');

    /* 零回归：既有数值模式照旧点亮；val 空（未生效）照旧不点亮 */
    setFilter(app, '_balPct', { mode: 'gte', val: 100 });
    assert.equal(icoOn(app, 'order_inv', '_balPct'), true, '数值模式 gte 有值 → 点亮（零回归）');
    /* ★ 反假守卫（有效探针）：**有筛选条目**但模式未生效 ⇒ 不得点亮。
       它绕过了 `f &&` 短路，能抓住「act 被改成恒真 / 恒 true」的变异。 */
    setFilter(app, '_balPct', { mode: 'gte', val: '' });
    assert.equal(icoOn(app, 'order_inv', '_balPct'), false,
      '有筛选条目但模式无效（gte + val 空）→ 不得点亮（有效反假守卫，绕过 f && 短路）');

    /* 【build .167】D11 已修复 ⇒ 原「现状钉」翻转为**契约**：
       · 历史事实（.152 ~ .166）：`act` 判据只认「vals 非空 / val 非空」，而 `is_empty` 的 val 恒空
         ⇒ 从不点亮；症状与 .162 所修缺陷同类，且跨**全部模块**的文本列与日期列。
       · 修复：thCol 的 act 判据改走单源 `filtOn(f)`（= vals 非空 ∨ val 非空 ∨ val 恒空模式），
         于是「为空 / 不为空 / 日期 7 个快捷模式（含 range）」一并纳入点亮。
       · 本条**不是**放宽：原断言是"缺陷现状"（false），现断言是"用户可见契约"（true）；
         若有人回退判据，本条立刻变红。 */
    app.run("tState('order_inv').filters={productName:{mode:'is_empty',val:''}};");
    assert.equal(icoOn(app, 'order_inv', 'productName'), true,
      'D11 已修：文本列 is_empty 筛选生效时漏斗图标必须点亮（.152~.166 曾不亮）');
    /* 前提自证：该状态下筛选确实生效（不是"点亮了但没筛"）。
       夹具 9 行的 productName 均为非空（= productId），故 is_empty 的结果应为 0 行。 */
    assert.equal(filterIds(app).length, 0,
      '前提：is_empty 确实在过滤（9 行 productName 全非空 ⇒ 0 行）；点亮必须与「已生效」同源');

    /* 「不为空」同样必须点亮（同一判据分支）；日期快捷模式亦然 */
    app.run("tState('order_inv').filters={productName:{mode:'not_empty',val:''}};");
    assert.equal(icoOn(app, 'order_inv', 'productName'), true, 'D11：not_empty 也必须点亮');
    app.run("tState('order_inv').filters={startDate:{mode:'today',val:''}};");
    assert.equal(icoOn(app, 'order_inv', 'startDate'), true, 'D11：日期快捷模式（today）也必须点亮');
    app.run("tState('order_inv').filters={startDate:{mode:'range',from:'2026-01-01',to:'2026-12-31'}};");
    assert.equal(icoOn(app, 'order_inv', 'startDate'), true, 'D11：日期「从…到…」（range）也必须点亮');
    /* 另一个模块的日期列同样点亮 —— 证明修复是**引擎级**，不是对某一列的特判 */
    app.run("renderOrderTable('order_frame',[],{});tState('order_frame').filters={deadline:{mode:'today',val:''}};");
    assert.equal(icoOn(app, 'order_frame', 'deadline'), true,
      'D11：order_frame.deadline + today 也必须点亮（跨模块，引擎级修复）');

    /* 反假守卫：判据不得退化成"恒亮" —— 未生效的筛选（val 空且非 val 恒空模式）仍不亮 */
    app.run("tState('order_inv').filters={productName:{mode:'contains',val:''}};");
    assert.equal(icoOn(app, 'order_inv', 'productName'), false,
      '为空/不为空/快捷模式之外的模式，val 空 ⇒ 未生效 ⇒ 不得点亮（D11 修复不得把 act 变成恒真）');
  } finally { app.dispose(); }
});

test('G2 判据单源：isSemFiltMode 恰 1 份实现，thCol / filterBar / applyFilt 三处共用；semFilters 提及点全局枚举恰 4 处', function () {
  const app = boot({ orders: [] });
  try {
    const plain = INDEX_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.equal(countOcc(plain, 'function isSemFiltMode('), 1,
      '语义档判据只许 1 份实现（.161 的根因正是 filterBar/thCol 各写一份）');

    /* ---- ① 判据的消费方：必须都调用单一来源，且自身不得出现 semFilters ---- */
    ['thCol', 'filterBar', 'applyFilt'].forEach(function (n) {
      const body = fnSrc(INDEX_SRC, n);
      assert.ok(body.indexOf('isSemFiltMode(') >= 0,
        n + ' 必须调用 isSemFiltMode（不得自己判 semFilters）');
      assert.equal(body.indexOf('semFilters'), -1,
        n + ' 源码内不得直接出现 semFilters —— 一旦出现就是「又写了一份判据」');
    });

    /* ---- ② semFilters 的**全部**提及点：全局扫描（两种独立方法互相校验） ----
       `semFilters` 的合法提及点恰 4 个函数：
         isSemFiltMode（判据本体，3 次）/ filterRows（引擎闸门）/ openFilter（面板选项）/
         renderOrderTable（列定义**声明**处，不是读取）。
       ⚠ 旧写法「先写死 3 个函数名再查它们是否包含」**排除不了第四处**
         （不在名单里的函数偷偷读取时永远绿）—— 故改为遍历全部 function 声明。 */
    const EXPECTED = ['filterRows', 'isSemFiltMode', 'openFilter', 'renderOrderTable'];

    /* 方法 A（枚举 + 函数体检查）：遍历主脚本所有 `function NAME(` 声明 */
    const declRe = /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
    const declNames = [];
    let dm;
    while ((dm = declRe.exec(INDEX_SRC)) !== null) declNames.push(dm[1]);
    const uniqNames = Array.from(new Set(declNames));
    assert.ok(uniqNames.length >= 200,
      '函数枚举异常（仅 ' + uniqNames.length + ' 个）—— 扫描逻辑可能已失效，不得静默通过');
    const readersA = [];
    uniqNames.forEach(function (n) {
      let body;
      try { body = fnSrc(INDEX_SRC, n); } catch (e) { return; }   /* 提取失败不掩盖：方法 B 兜底 */
      if (body.indexOf('semFilters') >= 0) readersA.push(n);
    });
    assert.deepEqual(readersA.sort(), EXPECTED,
      'semFilters 的提及点必须恰为 4 个函数（实际：' + readersA.join(', ') +
      '）—— 多出第五处即说明又出现了一份判据或新的读取点');

    /* 方法 B（位置归属，**不依赖**函数体提取成功）：把每一处 semFilters 归属到它前面最近的
       `function NAME(` 声明，再核对归属集合与总次数。这样即便某个函数体提取被字符串花括号截断、
       方法 A 漏看，本方法仍能定位到越界的那一处。 */
    const declPos = [];
    const declPosRe = /function\s+([A-Za-z_$][\w$]*)\s*\(/g;
    let pm;
    while ((pm = declPosRe.exec(plain)) !== null) declPos.push({ name: pm[1], at: pm.index });
    const owners = [];
    let idx = plain.indexOf('semFilters');
    while (idx >= 0) {
      const owner = declPos.filter(function (d) { return d.at < idx; }).pop();
      owners.push(owner ? owner.name : '<模块级/函数外>');
      idx = plain.indexOf('semFilters', idx + 1);
    }
    assert.equal(owners.length, 6,
      '去注释后 semFilters 应恰出现 6 次（isSemFiltMode 内 3 次 + filterRows/openFilter/renderOrderTable 各 1 次），实际 ' +
      owners.length + ' 次：' + owners.join(', '));
    assert.deepEqual(Array.from(new Set(owners)).sort(), EXPECTED,
      'semFilters 的归属函数集合必须恰为 4 个（位置归属扫描），实际：' + Array.from(new Set(owners)).join(', '));
    assert.equal(owners.filter(function (n) { return n === 'isSemFiltMode'; }).length, 3,
      'isSemFiltMode 内应恰有 3 次 semFilters 提及（判据本体）');
    assert.equal(owners.indexOf('<模块级/函数外>'), -1,
      '不得有 semFilters 出现在任何函数之外（模块级）');

    /* filterBar 的薄别名必须仍存在（保留 chip 侧的既有调用形态；逻辑零复制） */
    assert.ok(fnSrc(INDEX_SRC, 'filterBar').indexOf('const semModeOf=function(k,mode){return isSemFiltMode(m,k,mode);}') >= 0,
      'filterBar 的 semModeOf 必须是委托 isSemFiltMode 的薄别名（不得重新实现判定）');
  } finally { app.dispose(); }
});

test('G3 applyFilt：写入语义档前清空残留脏值（val/from/to），既有模式行为不动', function () {
  const app = boot({ orders: FIXTURES.map(function (x) { return mkInvOrder(x[0], x[1]); }) });
  try {
    renderInv(app);
    app.setGlobal('renderContent', function () {});   /* applyFilt 末尾会重渲染 */

    /** 驱动 applyFilt：临时替换 DOM 桩的 getElementById（供应 fp_mode / fp_val；无 fp_drange） */
    function applyFiltWith(m, key, mode, val) {
      const valEl = { value: val == null ? '' : String(val), style: { display: '' } };
      const sel = { value: mode, options: [{ value: mode, dataset: {} }], selectedIndex: 0 };
      const doc = app.sandbox.document;
      const orig = doc.getElementById;
      doc.getElementById = function (id) {
        if (id === 'fp_mode') return sel;
        if (id === 'fp_val') return valEl;
        return null;
      };
      try {
        app.run('applyFilt(' + JSON.stringify(m) + ',' + JSON.stringify(key) + ',false);');
      } finally {
        doc.getElementById = orig;
      }
    }

    /* ① 先设数值模式带 val，再切语义档 ⇒ val 必须被清空 */
    app.run("tState('order_inv').filters={_balPct:{mode:'gte',val:'100'}};");
    assert.equal(app.run("tState('order_inv').filters._balPct.val"), '100', '前提：先有一个带 val 的数值模式');
    applyFiltWith('order_inv', '_balPct', 'inv_short', 100);
    assert.equal(app.run("tState('order_inv').filters._balPct.mode"), 'inv_short', '模式必须切到 inv_short');
    assert.equal(app.run("tState('order_inv').filters._balPct.val"), '',
      '语义档写入后 f.val 必须为 \'\'（.161 会残留 100，导致二次打开面板回显脏值）');
    assert.equal(app.run("typeof tState('order_inv').filters._balPct.from"), 'undefined', '不得残留 from');
    assert.equal(app.run("typeof tState('order_inv').filters._balPct.to"), 'undefined', '不得残留 to');

    /* ② 语义档下筛选结果仍正确（清脏值不得影响判定） */
    assert.equal(filterIds(app).length, SHORT_IDS.length, '清脏值后筛选结果不变');

    /* ③ 范围守卫：文本列 is_empty 的 f.val 既有行为一律不动 */
    applyFiltWith('order_inv', 'productName', 'is_empty', 'KC');
    assert.equal(app.run("tState('order_inv').filters.productName.val"), 'KC',
      '文本列 is_empty 的 f.val 必须保持既有行为（本轮只清语义档，不动其它模式）');
  } finally { app.dispose(); }
});

test('G4 thCol 跨修订零回归：非 order_inv 模块逐字节不变；order_inv 语义档差异恰为「一个 on 令牌」', function () {
  const app = boot({ orders: [] });
  try {
    /* 上一版源码：由**提交主题**反查修订（不用 HEAD，避免自我对消）；取不到必须报错，禁止静默跳过 */
    const log = require('node:child_process').execFileSync('git', ['log', '--format=%H%x09%s', '-n', '600'],
      { cwd: ROOT, encoding: 'utf8' });
    const hit = log.split('\n').filter(function (l) {
      const i = l.indexOf('\t');
      return i >= 0 && l.slice(i + 1).indexOf('build ' + build.PREV) === 0;
    })[0];
    assert.ok(hit, '必须能在提交主题里反查到上一版 build ' + build.PREV + ' 的修订（否则本用例失效）');
    const prevRev = hit.slice(0, hit.indexOf('\t'));
    const prevSrc = require('node:child_process').execFileSync('git', ['show', prevRev + ':index.html'],
      { cwd: ROOT, encoding: 'utf8' });
    assert.ok(prevSrc.length > 100000, '上一版 index.html 提取异常短（' + prevSrc.length + '）');
    /* 自证基线形态：上一版的 thCol 是否已含 D11 修复（`filtOn(`）。
       版本推进后（PREV 变成含修复的那一版）本用例的 D11 分支自动降级为「两版逐字节相同」，
       否则下一版推进会无端变红 —— `.163` 已踩过同类坑（拿 PREV 当参考系而 PREV 已含改动）。 */
    const prevD11Fixed = fnSrc(prevSrc, 'thCol').indexOf('filtOn(') >= 0;

    /* 两版用**同一份**夹具装载 */
    const fixtures = {
      products: [
        { id: 'PA', name: '甲产品', spec: '', model: '', unit: '台', stock: 0, status: '启用' },
        { id: 'PB', name: '乙产品', spec: '', model: '', unit: '台', stock: 0, status: '启用' },
      ],
      parts: [{ id: 'A1', name: '零件甲', spec: 's1', model: 'm1', unit: '个', stock: 0, status: '启用' }],
      deliveries: [{ id: 'D1', planNo: 'JFJH-1', orderId: 'KC1', customer: '客户甲', createdAt: '2026-11-20', items: [] }],
      orders: [], productionPlans: [], productionReports: [], transfers: [], logs: [],
      /* 刻意**不**注入 fields：产品列 schema 由 fields.product 派生，注入空数组会让 product 表 0 列
         （既有默认 fields 来自应用初始化，绕过它反而失真） */
      meta: { seq: 0 },
      tblLayout: {}, uiDefaults: { order: {} }, tblPage: {}, tblState: {}, selRows: {}, lastRowIds: {},
    };
    const mk = function (html) {
      const a = createApp({ quietConsole: true, indexHtml: html, seed: JSON.parse(JSON.stringify(fixtures)) });
      a.run('renderProducts();renderParts();renderDelivery();' +
        "renderOrderTable('order_frame',[],{});renderOrderTable('order_inv',[],{});");
      return a;
    };
    const now = mk(INDEX_SRC);
    const prev = mk(prevSrc);
    try {
      /* 【build .167 拆分说明】原电池是「一份 9 态、两版逐字节相同」。D11 修复后
         「val 恒空模式」的分支**故意**变了（本版点亮、上一版不亮），若仍用同一份电池，
         本用例会从「零回归守卫」退化成「D11 修复的反对者」。故按**预期是否相同**拆两组：
           · STATES_SAME —— 不涉及 val 恒空模式 ⇒ 两版必须**逐字节相同**（真正的零回归面）；
           · STATES_D11  —— val 恒空模式 ⇒ 差异必须**恰为一个 ` on` 令牌**（受控增量面）。
         两组一起才能同时证明「该变的变了、不该变的没变」。 */
      const STATES_SAME = [
        '{}',
        "{id:{mode:'contains',val:'KC'}}",
        "{id:{vals:['KC1'],mode:'in'}}",
        "{stockMin:{mode:'gte',val:'5'}}",
        "{stockMin:{mode:'neq',val:'5'}}",
        "{startDate:{mode:'gte',val:'2026-01-01'}}"
      ];
      /* D11 修复面：为空 / 不为空 / 日期 7 个快捷模式（这里覆盖 today 与 range 两个代表） */
      const STATES_D11 = [
        "{id:{mode:'is_empty',val:''}}",
        "{id:{mode:'not_empty',val:''}}",
        "{startDate:{mode:'range',from:'2026-01-01',to:'2026-12-31'}}",
        "{startDate:{mode:'today',val:''}}"
      ];
      const MODULES = ['product', 'order_frame', 'order_inv', 'delivery', 'parts'];
      const diffs = [];
      let compared = 0;
      MODULES.forEach(function (m) {
        const keys = JSON.parse(now.run('JSON.stringify((TBL_SCHEMAS[' + JSON.stringify(m) + ']||[]).map(function(c){return c.key;}))'));
        assert.ok(keys.length >= 5, m + ' 列数异常（' + keys.length + '）');
        keys.forEach(function (k) {
          /* ---- ① 零回归面：逐字节相同 ---- */
          STATES_SAME.forEach(function (st) {
            now.run('tState(' + JSON.stringify(m) + ').filters=' + st + ';');
            prev.run('tState(' + JSON.stringify(m) + ').filters=' + st + ';');
            const a = thOf(now, m, k);
            const b = thOf(prev, m, k);
            compared++;
            if (a !== b) diffs.push(m + '.' + k + ' / ' + st + '\n  本版：' + a + '\n  上版：' + b);
          });
          /* ---- ② 受控增量面：差异恰为一个 ` on` 令牌（且必须真的点亮） ---- */
          STATES_D11.forEach(function (st) {
            now.run('tState(' + JSON.stringify(m) + ').filters=' + st + ';');
            prev.run('tState(' + JSON.stringify(m) + ').filters=' + st + ';');
            const a = thOf(now, m, k);
            const b = thOf(prev, m, k);
            compared++;
            if (prevD11Fixed) {
              /* 上一版已含修复 ⇒ 本组也退化为「逐字节相同」（版本推进后的零回归面） */
              if (a !== b) diffs.push(m + '.' + k + ' / ' + st + '\n  本版：' + a + '\n  上版：' + b);
              return;
            }
            if (a === b) {
              /* 该列不是被筛选的列 ⇒ 两版都不亮（自证：D11 修复没有波及其它列） */
              assert.equal(/filt-ico on/.test(a), false,
                '未被筛选的列不得点亮：' + m + '.' + k + ' / ' + st);
              return;
            }
            if (/filt-ico on/.test(b)) {
              diffs.push(m + '.' + k + ' / ' + st + '：上一版不该亮却亮了，无法归因为 D11\n  上版：' + b);
              return;
            }
            if (!/filt-ico on/.test(a)) {
              diffs.push(m + '.' + k + ' / ' + st + '：D11 未修（本版该亮却没亮）\n  本版：' + a);
              return;
            }
            if (a.replace('filt-ico on', 'filt-ico') !== b) {
              diffs.push(m + '.' + k + ' / ' + st + '：差异超出「一个 on 令牌」\n  本版：' + a + '\n  上版：' + b);
            }
          });
        });
      });
      assert.ok(compared >= 100, 'thCol 差分覆盖面异常（仅 ' + compared + ' 组）');
      assert.deepEqual(diffs, [], 'thCol 跨修订差分不符预期（零回归面必须逐字节相同 / D11 面必须恰一个 on）：\n' + diffs.join('\n'));

      /* 语义档是本版**唯一**预期差异：差异必须恰为多出一个 ` on` 令牌 */
      now.run("tState('order_inv').filters={_balPct:{mode:'inv_short',val:''}};");
      prev.run("tState('order_inv').filters={_balPct:{mode:'inv_short',val:''}};");
      const aSem = thOf(now, 'order_inv', '_balPct');
      const bSem = thOf(prev, 'order_inv', '_balPct');
      /* 自证基线形态：上一版的 thCol 是否已含本修复（下一版推进后本用例自动降级为「两版相同」） */
      const prevFixed = fnSrc(prevSrc, 'thCol').indexOf('isSemFiltMode') >= 0;
      if (prevFixed) {
        assert.equal(aSem, bSem, '上一版已含该修复 ⇒ 两版 thCol 输出必须相同（零回归）');
      } else {
        assert.equal(/filt-ico on/.test(bSem), false, '上一版该状态下漏斗图标不亮（= .161 缺陷，差异前提自证）');
        assert.equal(/filt-ico on/.test(aSem), true, '本版该状态下漏斗图标必须点亮');
        assert.equal(aSem.replace('filt-ico on', 'filt-ico'), bSem,
          '两版 thCol 的差异必须**恰为**一个 ` on` 令牌（除此之外逐字节相同）');
      }
    } finally {
      now.dispose();
      prev.dispose();
    }
  } finally { app.dispose(); }
});

/* ================================================================
   §G5 【build .167】判据单源化（D11 修复）的静态守卫
   ----------------------------------------------------------------
   为什么必须有本节：`.161`（chip 不出现）与 `.162`（漏斗不亮）两次缺陷的**同一根因**是
   「一条判据被抄成多份、只改了其中一份」。修 D11 时若又各写一份，等于把坑挖第三遍。
   故本节把「单源」这件事本身钉住：
     · 两个单源函数各恰 1 份实现；
     · 5 个消费方一律**委托**，自身不得再出现任何「val 恒空模式」的自判片段；
     · 单源函数本体的边界（不看值 / 不判语义档）不得被越界改写。
   ================================================================ */

/** 消费方清单（改判据时必须同步的 5 处；新增第 6 处前请先想清楚为什么不能复用 filtOn） */
const FILT_ON_CONSUMERS = ['filterRows', 'thCol', 'filterBar', 'prodFilterActive', 'maybeWarnHiddenOrder'];

test('G5 判据单源：isValFreeFiltMode / filtOn 各 1 份实现，5 个消费方一律委托且不再自判', function () {
  const app = boot({ orders: [] });
  try {
    const plain = INDEX_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    /* ---- ① 两个单源各恰 1 份实现 ---- */
    assert.equal(countOcc(plain, 'function isValFreeFiltMode('), 1,
      'val 恒空模式判据只许 1 份实现（isValFreeFiltMode）');
    assert.equal(countOcc(plain, 'function filtOn('), 1,
      '「筛选是否生效」判据只许 1 份实现（filtOn）');
    assert.equal(countOcc(plain, 'function dateQuickMode('), 1,
      '日期 7 个快捷模式的单一来源必须仍是 dateQuickMode（且仍恰 1 份）');

    /* ---- ② 5 个消费方必须委托，且自身不得出现「val 恒空模式」的自判片段 ---- */
    FILT_ON_CONSUMERS.forEach(function (n) {
      const body = fnSrc(plain, n);
      assert.ok(body && body.length > 20, n + ' 未抽出（守卫会退化为恒真）');
    });
    /* filterRows 用 isValFreeFiltMode（它只需要「是否 val 恒空」，语义档自己补 !!sem）；
       其余 4 处用 filtOn（「是否生效」的完整口径） */
    assert.ok(fnSrc(plain, 'filterRows').indexOf('isValFreeFiltMode(') >= 0,
      'filterRows 必须调用 isValFreeFiltMode（判据单源）');
    ['thCol', 'filterBar', 'prodFilterActive', 'maybeWarnHiddenOrder'].forEach(function (n) {
      const body = fnSrc(plain, n);
      assert.ok(body.indexOf('filtOn(') >= 0, n + ' 必须调用单源 filtOn（不得自带一份判据）');
      assert.equal(body.indexOf("f.mode==='is_empty'"), -1,
        n + ' 不得自判 is_empty（这正是 D11 的多份副本之一）');
      assert.equal(body.indexOf('dateQuickMode('), -1,
        n + ' 不得自判日期快捷模式（必须走单源）');
      assert.equal(body.indexOf('f.vals&&f.vals.length>0'), -1,
        n + ' 不得自带「vals 非空」判据');
      assert.equal(body.indexOf("f.val!==''&&f.val!=null"), -1,
        n + ' 不得自带「val 非空」判据');
    });

    /* ---- ②b 位置归属法（不依赖函数体提取成功）：is_empty / not_empty 字面量的
       归属函数集合必须恰为 {isValFreeFiltMode, filterRows} ——
       isValFreeFiltMode 是**判据本体**；filterRows 的两处是**行级取值判定**
       （`if(f.mode==='is_empty'&&!(v==null||v===''))return false;`），不是"是否生效"判据。 */
    const declPos = [];
    const declPosRe = /function\s+([A-Za-z_$][\w$]*)\s*\(/g;
    let pm;
    while ((pm = declPosRe.exec(plain)) !== null) declPos.push({ name: pm[1], at: pm.index });
    ['is_empty', 'not_empty'].forEach(function (mode) {
      const owners = [];
      let i = plain.indexOf("f.mode==='" + mode + "'");
      while (i >= 0) {
        const owner = declPos.filter(function (d) { return d.at < i; }).pop();
        owners.push(owner ? owner.name : '<模块级/函数外>');
        i = plain.indexOf("f.mode==='" + mode + "'", i + 1);
      }
      assert.deepEqual(Array.from(new Set(owners)).sort(), ['filterRows', 'isValFreeFiltMode'],
        mode + ' 字面量的归属函数必须恰为「判据本体 + filterRows 行级取值判定」两处，实际：' +
        Array.from(new Set(owners)).join(', ') + ' —— 多出第三处即又长了一份判据');
      assert.equal(owners.length, 2, mode + ' 去注释后应恰出现 2 次，实际 ' + owners.length + '：' + owners.join(', '));
      assert.equal(owners.indexOf('<模块级/函数外>'), -1, mode + ' 不得出现在任何函数之外（模块级）');
    });

    /* ---- ③ 单源函数的边界：不看值、不判语义档 ---- */
    const vf = fnSrc(plain, 'isValFreeFiltMode');
    assert.equal(vf.indexOf('vals'), -1, 'isValFreeFiltMode 只判「模式是否 val 恒空」，不得看 vals');
    assert.equal(vf.indexOf('f.val'), -1, 'isValFreeFiltMode 不得看 f.val（它判的就是「不需要值」）');
    const fo = fnSrc(plain, 'filtOn');
    assert.equal(fo.indexOf('isSemFiltMode'), -1,
      'filtOn 不得判语义档 —— f 上没有列信息，硬判必然要新增入参并由此长出第二套判据');
    assert.ok(fo.indexOf('isValFreeFiltMode(f)') >= 0, 'filtOn 必须复用 isValFreeFiltMode（不得自己再列一遍模式名）');

    /* ---- ④ 语义档在**调用处**补足的那两段必须还在（否则语义档会静默失效） ---- */
    assert.ok(fnSrc(plain, 'filterRows').indexOf('||!!sem') >= 0,
      'filterRows 必须保留 ||!!sem（语义档的 popcount 在调用处补足）');
    assert.ok(fnSrc(plain, 'thCol').indexOf('||isSemFiltMode(m,col.key,f.mode)') >= 0,
      'thCol 必须保留 ||isSemFiltMode(...)（漏斗点亮对语义档的那一段）');
    assert.ok(fnSrc(plain, 'filterBar').indexOf('isSemFiltMode(m,k,mode)') >= 0,
      'filterBar 的 semModeOf 薄别名必须仍委托 isSemFiltMode');
  } finally { app.dispose(); }
});
