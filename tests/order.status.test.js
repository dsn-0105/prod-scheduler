'use strict';
/* ================================================================
   tests/order.status.test.js —— build 2026-09-19.128 新增「调用状态 / 交付状态」整单级列
   ================================================================
   覆盖不变式（不做实现细节断言）：
     1) 列布局：销售订单两列位于「审核状态」之后、「合同号」之前；库存订单完全不出现这两列
     2) 判定口径：汇总占比（Σ已调用÷Σ数量、Σ已交付÷Σ数量）→ 未/部分/全部；
        含 A/B 分歧样本（Σ达 100% 但存在空行 → 仍判「全部」，证明取的是汇总口径而非行级全达标）
     3) 整单级合并：rowspan 单元格数 = 订单数；每单首行 td = 1 + 单据列数 + 行级列数，续行 td = 行级列数
     4) 排序：单据级列排序语义权重（未→部分→全部），并**回归锁定既有缺陷修复**
        （原实现按单据编号重排，会覆盖排序结果 → 单据编号/审核状态等升序降序均失效）
     5) 筛选：select 复选多选生效
     6) 底部合计：状态列不进合计，且与数据行同构（1 + schema 列数）
     7) HEAD_COLS 5→7 不回归 + **对照基线提交**：库存订单渲染逐字节零变化
   真值夹具（可选）：SNAP_JSON=<线上快照绝对路径> 时追加真实数据口径断言；
     期望值来自**独立实现** `_snap/stat-call-deliver.js`（输出 stat-out-20260919-1038.txt）。
   运行：node tests/order.status.test.js
         SNAP_JSON=.../data-online-20260919-1038.json node tests/order.status.test.js
   注：状态文本计数一律**只统计表体**——表头列名含「未交付」（_undel 列），全串计数会多算 1。
================================================================ */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createApp } = require('./harness/sandbox');

/* ---------- 夹具 ---------- */
function product(id, name, model, spec) {
  return { id: id, name: name, model: model, spec: spec, unit: '台', dailyCapacity: 10, stock: 0, stockMax: 0, stockMin: 0 };
}
function line(pid, qty, called, delivered, stockMax) {
  return {
    productId: pid, productName: pid + '名称', spec: 'S-' + pid, model: 'M-' + pid,
    orderQty: qty, stockMax: stockMax != null ? stockMax : '', stockMin: 0,
    deliveredQty: delivered, calledQty: called, lineNotes: '',
  };
}
function order(id, type, status, items) {
  return { id: id, customer: 'C-' + id, startDate: '2026-09-01', deadline: '2026-10-01', status: status, contractNo: 'HT-' + id, orderType: type, items: items };
}

/* O1 全未；O2 部分；O3 汇总 100% 但行不齐（A/B 分歧样本）；O4 全部；O5 数量=0 边界；O6 库存订单 */
const FIXTURE_ORDERS = [
  order('XSDD-1', '销售订单', '执行中', [line('P1', 100, 0, 0), line('P1', 100, 0, 0)]),
  order('XSDD-2', '销售订单', '执行中', [line('P1', 100, 100, 50), line('P2', 100, 0, 0)]),
  order('XSDD-3', '销售订单', '执行中', [line('P2', 100, 200, 0), line('P2', 100, 0, 0)]),
  order('XSDD-4', '销售订单', '已完成', [line('P3', 100, 100, 100)]),
  order('XSDD-5', '销售订单', '执行中', [line('P3', 0, 0, 0)]),
  order('KCDD-1', '库存订单', '执行中', [line('P1', 0, 0, 0, 200)]),
];
const FIXTURE_PRODUCTS = [product('P1', '一型', 'M1', 'S1'), product('P2', '二型', 'M2', 'S2'), product('P3', '三型', 'M3', 'S3')];

/* 销售订单 schema 期望列序（.128） */
const EXPECT_FRAME_KEYS = [
  'deadline', 'startDate', 'id', 'customer', 'status', 'callStatus', 'deliverStatus', 'contractNo',
  'productId', 'productName', 'model', 'spec', 'unit', 'orderQty',
  'deliveredQty', 'calledQty', '_undel', '_pct', 'lineNotes',
];
const HEAD_COLS_FRAME = 8;                                   /* 单据级列数（含两列新状态列） */
const LINE_KEYS_FRAME = EXPECT_FRAME_KEYS.slice(HEAD_COLS_FRAME);  /* 行级列键（11） */
const STATUS_WORDS = ['未调用', '部分调用', '全部调用', '未交付', '部分交付', '全部交付'];

/* ---------- 装载 ---------- */
const SNAP_JSON = process.env.SNAP_JSON || '';
function mount(orders, products, extra) {
  const seed = Object.assign({ orders: orders, products: products }, extra || {});
  const app = createApp({ seed: seed, quietConsole: true });
  app.sandbox.tblPage = { order_frame: { page: 1, size: 100000 }, order_inv: { page: 1, size: 100000 } };
  return app;
}
const RENDER_SRC = function (formKey, type) {
  return '(function(){' +
    'var prodMap={};products.forEach(function(p){prodMap[p.id]=p;});' +
    'var typeOrders=orders.map(function(o,i){return {o:o,i:i};}).filter(function(x){return orderTypeOf(x.o)===' + JSON.stringify(type) + ';});' +
    'return renderOrderTable(' + JSON.stringify(formKey) + ',typeOrders,prodMap);' +
    '})()';
};
function render(app, formKey, type) { return app.run(RENDER_SRC(formKey, type)); }

/* ---------- HTML 解析小工具（状态文本一律只算表体） ---------- */
const SPLIT = '<div class="table-wrap">';
function splitParts(html) { const i = html.indexOf(SPLIT); return { head: html.slice(0, i), body: html.slice(i + SPLIT.length) }; }
function headKeys(html) { return [...splitParts(html).head.matchAll(/data-key="([^"]+)"/g)].map(m => m[1]); }
function thCount(html) { return (splitParts(html).head.match(/<th[\s>]/g) || []).length; }
function rows(html) { return [...splitParts(html).body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m => m[1]); }
function tdCount(inner) { return (inner.match(/<td[\s>]/g) || []).length; }
function bodyTagCount(html, txt) { return (splitParts(html).body.match(new RegExp('>' + txt + '<', 'g')) || []).length; }
function rowspanOf(inner, key) {
  const m = inner.match(new RegExp('<td data-key="' + key + '" rowspan="(\\d+)"'));
  return m ? Number(m[1]) : 0;
}
function colSeq(html, key) {
  /* 只取数据行（末行为合计行，其状态格为空），并只保留真正含该 key 的行——续行为 rowspan 合并、不含首行单据格 */
  const data = rows(html).slice(0, -1);
  return data.map(r => {
    const m = r.match(new RegExp('<td[^>]*data-key="' + key + '"[^>]*>([\\s\\S]*?)</td>'));
    return m ? m[1].replace(/<[^>]*>/g, '').trim() : '';
  }).filter(v => v !== '');
}
function tdKeys(inner) { return [...inner.matchAll(/data-key="([^"]+)"/g)].map(m => m[1]); }
function cellKeysOfTd(inner) { return [...inner.matchAll(/data-key/g)].length; }
/* [基线零回归] 对照锚点 = .128（新增两列）之前的最后一次提交。
 * 必须是固定 hash，**不能用 HEAD**：本测试一旦随功能一起提交，HEAD 就变成了新版，
 * 会与自身对比而对消（2026-09-19 实测踩坑：提交后测试必失败）。
 * rebase / 历史改写导致该 hash 失效时，用 BASELINE_REF 环境变量覆盖，或降级为跳过。
 */
const BASELINE_REF = process.env.BASELINE_REF || '4bab983';
function baselineHtml() {
  const cands = [process.env.GIT_EXE, 'C:/Users/WINDOWS/.workbuddy/binaries/PortableGit/versions/1.2.0/mingw64/bin/git.exe', 'git'];
  for (const g of cands) {
    if (!g) continue;
    try {
      if (g !== 'git' && !fs.existsSync(g)) continue;
      return execFileSync(g, ['show', BASELINE_REF + ':index.html'], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch (e) { /* 换下一个候选 */ }
  }
  return null;
}

/* ================================================================
   1) 列布局
================================================================ */
test('1) 销售订单：两列紧随「审核状态」，且位于「合同号」之前；列数与 schema 一致', () => {
  const app = mount(FIXTURE_ORDERS, FIXTURE_PRODUCTS);
  try {
    const html = render(app, 'order_frame', '销售订单');
    assert.deepEqual(headKeys(html), EXPECT_FRAME_KEYS, '销售订单列序不符合预期');
    const k = headKeys(html);
    assert.equal(k.indexOf('callStatus'), k.indexOf('status') + 1, '「调用状态」应紧跟「审核状态」');
    assert.equal(k.indexOf('deliverStatus'), k.indexOf('status') + 2, '「交付状态」应在「调用状态」右侧');
    assert.equal(thCount(html), EXPECT_FRAME_KEYS.length + 1, '表头 th 数 = 选择列 1 + schema 列数');
  } finally { app.dispose(); }
});

test('2) 库存订单：完全不渲染「调用状态 / 交付状态」', () => {
  const app = mount(FIXTURE_ORDERS, FIXTURE_PRODUCTS);
  try {
    const html = render(app, 'order_inv', '库存订单');
    const k = headKeys(html);
    assert.equal(k.includes('callStatus'), false, '库存订单不应有「调用状态」');
    assert.equal(k.includes('deliverStatus'), false, '库存订单不应有「交付状态」');
    assert.equal(html.includes('调用状态'), false);
    assert.equal(html.includes('交付状态'), false);
  } finally { app.dispose(); }
});

/* ================================================================
   2) 判定口径
================================================================ */
test('3) 汇总占比口径：未 / 部分 / 全部 三态判定（含 A/B 分歧样本）', () => {
  const app = mount(FIXTURE_ORDERS, FIXTURE_PRODUCTS);
  try {
    const html = render(app, 'order_frame', '销售订单');
    assert.equal(bodyTagCount(html, '未调用'), 2, '未调用应为 O1/O5');
    assert.equal(bodyTagCount(html, '部分调用'), 1, '部分调用应为 O2');
    assert.equal(bodyTagCount(html, '全部调用'), 2, 'O3 汇总口径应判「全部调用」（行级口径会判部分→证明取汇总口径）');
    assert.equal(bodyTagCount(html, '未交付'), 3, '未交付应为 O1/O3/O5（O3 已调用达 100% 但已交付为 0）');
    assert.equal(bodyTagCount(html, '部分交付'), 1, '部分交付应为 O2');
    assert.equal(bodyTagCount(html, '全部交付'), 1, '全部交付应为 O4');
    /* 状态文本只出现在状态格（表头 0 次，避免与「未交付」列名混淆的回归） */
    assert.equal((splitParts(html).head.match(/>未交付</g) || []).length, 1, '表头「未交付」列名应恰好 1 次（计数须只取表体）');
    assert.equal(html.includes('KCDD-1'), false, '库存订单不应出现在销售订单表');
  } finally { app.dispose(); }
});

test('4) 状态判定函数直测（orderStatusOf 口径与数量来源）', () => {
  const app = mount(FIXTURE_ORDERS, FIXTURE_PRODUCTS);
  try {
    const r = app.run('(function(){var out={};orders.forEach(function(o){var s=orderStatusOf(o);out[o.id]=[s.qty,s.called,s.delivered,s.call,s.deliver];});return out;})()');
    assert.deepEqual(r['XSDD-3'], [200, 200, 0, '全部调用', '未交付'], 'O3 汇总 200/200 → 全部调用');
    assert.deepEqual(r['XSDD-2'], [200, 100, 50, '部分调用', '部分交付']);
    assert.deepEqual(r['XSDD-5'], [0, 0, 0, '未调用', '未交付'], 'Σ数量=0 边界不得抛错/误判全部');
    assert.deepEqual(r['KCDD-1'], [200, 0, 0, '未调用', '未交付'], '库存订单分母应取 stockMax（invQtyOf 同源）');
  } finally { app.dispose(); }
});

/* ================================================================
   3) 整单级合并与单元格守恒
================================================================ */
test('5) 整单合并：首行 td = 1 + 单据列 + 行级列；续行 td = 行级列；rowspan = 明细行数', () => {
  const app = mount(FIXTURE_ORDERS, FIXTURE_PRODUCTS);
  try {
    const html = render(app, 'order_frame', '销售订单');
    const sales = FIXTURE_ORDERS.filter(o => o.orderType !== '库存订单');
    const lines = sales.reduce((s, o) => s + o.items.length, 0);
    const rs = rows(html);
    const dataRows = rs.slice(0, rs.length - 1);            /* 末行 = 合计行 */
    assert.equal(dataRows.length, lines, '数据行数应等于明细行数');
    const expectFirst = 1 + HEAD_COLS_FRAME + LINE_KEYS_FRAME.length;
    const total = dataRows.reduce((s, r) => {
      const span = rowspanOf(r, 'callStatus');
      assert.equal(tdCount(r), span > 0 ? expectFirst : LINE_KEYS_FRAME.length, '单元格数不守恒 → rowspan 列占位错位');
      if (span > 0) assert.deepEqual(tdKeys(r), EXPECT_FRAME_KEYS, '首行键序应等于完整列序');
      else assert.deepEqual(tdKeys(r), LINE_KEYS_FRAME, '续行应只含行级列键');
      return s + tdCount(r);
    }, 0);
    assert.equal(total, sales.length * (1 + HEAD_COLS_FRAME) + lines * LINE_KEYS_FRAME.length, 'td 总数不守恒');
    /* 每单恰好 1 个 rowspan 状态格，且 rowspan = 该单明细行数 */
    for (const o of sales) {
      const first = dataRows.find(r => r.indexOf('>' + o.id + '<') >= 0);
      assert.equal(rowspanOf(first, 'callStatus'), o.items.length, o.id + ' 「调用状态」rowspan 应等于明细行数');
      assert.equal(rowspanOf(first, 'deliverStatus'), o.items.length, o.id + ' 「交付状态」rowspan 应等于明细行数');
    }
    const spans = dataRows.map(r => rowspanOf(r, 'callStatus')).filter(n => n > 0);
    assert.equal(spans.length, sales.length, 'rowspan 状态格数应等于订单数（每单恰好 1 个）');
  } finally { app.dispose(); }
});

/* ================================================================
   4) 排序
================================================================ */
test('6) 排序：单据级列排序生效（语义权重 + 修复「按单据编号重排覆盖排序」缺陷）', () => {
  const app = mount(FIXTURE_ORDERS, FIXTURE_PRODUCTS);
  try {
    app.sandbox.tblState = { order_frame: { sort: { key: 'callStatus', dir: 1 }, filters: {} } };
    assert.deepEqual(colSeq(render(app, 'order_frame', '销售订单'), 'callStatus'),
      ['未调用', '未调用', '部分调用', '全部调用', '全部调用'],
      '升序应为 未→部分→全部（字符串排序会得到「全部调用」在前）');
    app.sandbox.tblState = { order_frame: { sort: { key: 'callStatus', dir: -1 }, filters: {} } };
    assert.deepEqual(colSeq(render(app, 'order_frame', '销售订单'), 'callStatus'),
      ['全部调用', '全部调用', '部分调用', '未调用', '未调用'], '降序应反向');
    app.sandbox.tblState = { order_frame: { sort: { key: 'deliverStatus', dir: 1 }, filters: {} } };
    assert.deepEqual(colSeq(render(app, 'order_frame', '销售订单'), 'deliverStatus'),
      ['未交付', '未交付', '未交付', '部分交付', '全部交付'], '按交付状态升序应生效（O1/O3/O5 未交付）');
    /* 既有缺陷回归锁定：单据编号降序此前被「按单据编号升序重排」覆盖 */
    app.sandbox.tblState = { order_frame: { sort: { key: 'id', dir: -1 }, filters: {} } };
    assert.deepEqual(colSeq(render(app, 'order_frame', '销售订单'), 'id'),
      ['XSDD-5', 'XSDD-4', 'XSDD-3', 'XSDD-2', 'XSDD-1'], '单据编号降序应生效');
    app.sandbox.tblState = { order_frame: { sort: { key: 'id', dir: 1 }, filters: {} } };
    assert.deepEqual(colSeq(render(app, 'order_frame', '销售订单'), 'id'),
      ['XSDD-1', 'XSDD-2', 'XSDD-3', 'XSDD-4', 'XSDD-5'], '单据编号升序应生效');
  } finally { app.dispose(); }
});

/* ================================================================
   5) 筛选
================================================================ */
test('7) 筛选：复选多选（select 类列）生效', () => {
  const app = mount(FIXTURE_ORDERS, FIXTURE_PRODUCTS);
  try {
    app.sandbox.tblState = { order_frame: { sort: null, filters: { callStatus: { mode: 'in', vals: ['未调用'] } } } };
    let html = render(app, 'order_frame', '销售订单');
    assert.equal(bodyTagCount(html, '未调用'), 2);
    assert.equal(bodyTagCount(html, '部分调用'), 0);
    assert.equal(bodyTagCount(html, '全部调用'), 0);
    app.sandbox.tblState = { order_frame: { sort: null, filters: { deliverStatus: { mode: 'in', vals: ['全部交付', '部分交付'] } } } };
    html = render(app, 'order_frame', '销售订单');
    assert.equal(bodyTagCount(html, '全部交付'), 1);
    assert.equal(bodyTagCount(html, '部分交付'), 1);
    assert.equal(bodyTagCount(html, '未交付'), 0);
  } finally { app.dispose(); }
});

/* ================================================================
   6) 合计行
================================================================ */
test('8) 合计行：状态列不进合计，且与数据行同构（1 + schema 列数）', () => {
  const app = mount(FIXTURE_ORDERS, FIXTURE_PRODUCTS);
  try {
    const html = render(app, 'order_frame', '销售订单');
    const rs = rows(html);
    const sum = rs[rs.length - 1];
    assert.equal(tdCount(sum), EXPECT_FRAME_KEYS.length + 1, '合计行 td 数应为 1 + schema 列数');
    assert.equal(rowspanOf(sum, 'callStatus'), 0);
    assert.equal(STATUS_WORDS.some(w => sum.indexOf('>' + w + '<') >= 0), false, '合计行不得出现状态文本');
  } finally { app.dispose(); }
});

/* ================================================================
   7) HEAD_COLS 与基线零回归
================================================================ */
test('9) 按行级列排序 → 关闭整单合并；按单据级列排序 → 保留合并', () => {
  const app = mount(FIXTURE_ORDERS, FIXTURE_PRODUCTS);
  try {
    app.sandbox.tblState = { order_frame: { sort: { key: 'productName', dir: 1 }, filters: {} } };
    let html = render(app, 'order_frame', '销售订单');
    assert.equal(rowspanOf(rows(html)[0], 'callStatus'), 0, '行级列排序时应逐行渲染（无 rowspan）');
    assert.equal(splitParts(html).body.includes('rowspan'), false, '行级列排序时表体不应出现 rowspan');

    app.sandbox.tblState = { order_frame: { sort: { key: 'status', dir: 1 }, filters: {} } };
    html = render(app, 'order_frame', '销售订单');
    assert.ok(rowspanOf(rows(html)[0], 'callStatus') >= 1, '按「审核状态」（单据级列）排序应保留合并');

    app.sandbox.tblState = { order_frame: { sort: { key: 'deliverStatus', dir: 1 }, filters: {} } };
    html = render(app, 'order_frame', '销售订单');
    assert.ok(rowspanOf(rows(html)[0], 'deliverStatus') >= 1, '按新增单据级列排序应保留合并');
  } finally { app.dispose(); }
});

test('10) [基线零回归] 对照 .128 前基线提交（'+BASELINE_REF+'）：库存订单渲染逐字节不变；销售订单仅多 n 单 × 2 个状态格', () => {
  const headHtml = baselineHtml();
  if (!headHtml) { console.log('  (跳过：无法获取基线 '+BASELINE_REF+':index.html——该提交可能已不存在，可用 BASELINE_REF 覆盖)'); return; }
  const appOld = mount(FIXTURE_ORDERS, FIXTURE_PRODUCTS);
  const appNew = mount(FIXTURE_ORDERS, FIXTURE_PRODUCTS);
  /* 用基线版 index.html 重建旧沙箱（js/*.js 未改动，可共用） */
  const appBase = createApp({ indexHtml: headHtml, seed: { orders: FIXTURE_ORDERS, products: FIXTURE_PRODUCTS }, quietConsole: true });
  appBase.sandbox.tblPage = { order_frame: { page: 1, size: 100000 }, order_inv: { page: 1, size: 100000 } };
  try {
    const oldInv = render(appBase, 'order_inv', '库存订单');
    const newInv = render(appNew, 'order_inv', '库存订单');
    /* .139：工具栏会随版本新增动作按钮（本版加「不变量自检」），与本用例本意（新增**列**不应影响库存页）无关，
       故把工具栏段剥离后逐字节比较表头列与数据行（比较强度不变）。 */
    const stripBar = h => h.replace(/<div class="bulk-bar">[\s\S]*?<\/div>/, '<div class="bulk-bar"></div>');
    assert.equal(stripBar(newInv), stripBar(oldInv), '库存订单渲染必须与 HEAD 完全一致（表头列 + 数据行；工具栏按钮除外）');
    const oldFrame = render(appBase, 'order_frame', '销售订单');
    const newFrame = render(appNew, 'order_frame', '销售订单');
    assert.equal(headKeys(newFrame).filter(k => k !== 'callStatus' && k !== 'deliverStatus').join(','), headKeys(oldFrame).join(','), '销售订单列序只应新增两列');
    const sales = FIXTURE_ORDERS.filter(o => o.orderType !== '库存订单');
    const linesOf = h => rows(h).slice(0, -1);
    const oldTd = linesOf(oldFrame).reduce((s, r) => s + tdCount(r), 0);
    const newTd = linesOf(newFrame).reduce((s, r) => s + tdCount(r), 0);
    assert.equal(newTd - oldTd, sales.length * 2, '销售订单 td 增量应恰为「订单数 × 2」（每单 1 个状态格 × 2 列）');
    assert.equal(oldFrame.includes('调用状态'), false, '基线不应含「调用状态」（确认对比有效）');
  } finally { appBase.dispose(); appOld.dispose(); appNew.dispose(); }
});

/* ================================================================
   8) 真值夹具（线上快照，可选）
================================================================ */
test('11) [真值夹具] 线上快照口径复算：调用 70/7/14，交付 35/7/49', { skip: !SNAP_JSON ? '未提供 SNAP_JSON' : false }, () => {
  const raw = JSON.parse(fs.readFileSync(SNAP_JSON, 'utf8'));
  const data = (raw && raw.data && Array.isArray(raw.data.orders)) ? raw.data : raw;
  const app = mount(data.orders, data.products || [], {
    deliveries: data.deliveries || [], transfers: data.transfers || [],
    productionPlans: data.productionPlans || [], productionReports: data.productionReports || [],
    processTemplates: data.processTemplates || [],
  });
  try {
    const html = render(app, 'order_frame', '销售订单');
    /* 期望值来自独立实现 _snap/stat-call-deliver.js（stat-out-20260919-1038.txt） */
    assert.equal(bodyTagCount(html, '未调用'), 14);
    assert.equal(bodyTagCount(html, '部分调用'), 7);
    assert.equal(bodyTagCount(html, '全部调用'), 70);
    assert.equal(bodyTagCount(html, '未交付'), 49);
    assert.equal(bodyTagCount(html, '部分交付'), 7);
    assert.equal(bodyTagCount(html, '全部交付'), 35);
    const spans = rows(html).slice(0, -1).map(r => rowspanOf(r, 'callStatus')).filter(n => n > 0);
    assert.equal(spans.length, data.orders.filter(o => o.orderType !== '库存订单').length, 'rowspan 状态格数应等于销售订单数');
  } finally { app.dispose(); }
});
