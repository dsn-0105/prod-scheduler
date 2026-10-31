'use strict';
/* ================================================================
   tests/product-order-drag.156.test.js
   —— 产品主数据「长按整行拖拽」自定义显示顺序 + 库存订单跟随 + 删除守卫
      （.155 建立顺序契约，.156 由「排序规则」重构为「显式名单 + 拖拽」）
   ================================================================
   需求演进（用户 2026-10-20 ~ 10-21 四轮拍板）：
     R1 （.155）自定义默认排序，只能由管理员调整；配置点放**产品主数据**，库存订单**跟随**
     R2 （.155）有库存订单的产品禁止删除（历史单也算，提示改「停用」）
     R3 （.155）库存订单只能 1 行明细；批量生成改「一产品一张单」
     R4 （.156）**改成长按整行上下拖拽** —— 上一版「点列头 → 点按钮固化」实测不可用
   ----------------------------------------------------------------
   `.156` 为什么推翻 `.155` 的交互（**这是本条最重要的背景，勿删**）：
     `.155` 上线后用户报「排序操作无效」。线上核查三项铁证：
       · `data.json` 的 `uiDefaults` 恒为 `{}`（从未写入）
       · 操作日志「默认排序」命中 **0 条**（logOp 从未执行）
       · 日志最后一条停在 2026-09-16（新版上线后无任何写操作）
     ⇒ 不是代码错，而是**两步式交互**（先点列头排序、再点固化按钮）没被走通。
     用户随即要求改为拖拽 —— 拖完即生效，消灭"第二步"。
   ----------------------------------------------------------------
   `.156` 口径（用户选定，不得自行放宽）：
     D1 拖动时若当前不是「全部显示」→ 自动切 1000 条/页，拖完恢复原每页条数
     D2 有筛选时**禁止拖拽**（顺序只对筛选结果有意义，与全量名单对不上）
     D3 **只留拖拽**：原「设为默认排序 / 清除」按钮删除；列头排序仍可临时查看但不固化
     D4（沿用 .155）删除守卫只看**库存订单**，含已完成/已取消历史单
     D5（沿用 .155）未自定义顺序 → 产品按录入顺序、库存订单按单据编号升序（零回归）
   ----------------------------------------------------------------
   覆盖结构：
     §A normUiDefaults / prodOrderOf   名单归一（去空/去重/非法丢弃）与唯一取值点
     §B cmpByColDef                   列头排序的比较口径（.155 抽取，.156 仍被 sortRows 使用）
     §C productsSortedByOrder         名单排序 / 未自定义 / 名单不含新产品 / 不动 products
     §D sortInvRowsByProdRank         库存订单跟随 / 孤儿末尾 / 未自定义原样返回 / 不改入参
     §E guardProductDelByInvOrders    库存单拦 / 历史单也算 / 销售单不拦 / 未引用放行
     §F 静态守卫                       拖拽引擎结构 / 三口径落地 / 权限 / 接入口
   ================================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createApp, ROOT } = require('./harness/sandbox');

const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');

const ADMIN = { username: 'pmc', name: 'PMC小张', role: 'admin', perms: {} };

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

function prodFields() {
  return [
    { key: 'id', label: '产品编码', type: 'text', locked: true },
    { key: 'name', label: '产品名称', type: 'text', locked: true },
    { key: 'spec', label: '规格', type: 'text', locked: true },
    { key: 'model', label: '型号', type: 'text' },
    { key: 'unit', label: '单位', type: 'text' },
    { key: 'dailyCap', label: '日产能', type: 'number', locked: true },
    { key: 'stock', label: '库存/已交付数量', type: 'number', locked: true },
    { key: 'status', label: '状态', type: 'select' },
  ];
}
function fixtureProducts() {
  return [
    { id: 'P1', name: '甲', spec: '', model: 'M-a', unit: '台', stock: 5, dailyCap: 100, status: '启用' },
    { id: 'P2', name: '乙', spec: '', model: 'M-b', unit: '台', stock: 50, dailyCap: 20, status: '启用' },
    { id: 'P3', name: '丙', spec: '', model: 'M-c', unit: '台', stock: 1, dailyCap: 300, status: '停用' },
  ];
}
function fixtureOrders() {
  return [
    {
      id: 'KCDD-20260101-00001', orderType: '库存订单', customer: '库存', status: '执行中',
      items: [{ productId: 'P1', productName: '甲', stockMax: 10, deliveredQty: 0 }],
    },
    {
      id: 'KCDD-20260101-00002', orderType: '库存订单', customer: '库存', status: '已完成',
      items: [{ productId: 'P2', productName: '乙', stockMax: 10, deliveredQty: 10 }],
    },
    {
      id: 'XSDD-20260101-00001', orderType: '销售订单', customer: '某客户', status: '执行中',
      items: [{ productId: 'P3', productName: '丙', orderQty: 10, deliveredQty: 0 }],
    },
  ];
}

function mkApp(seed) {
  const counters = { renderContent: 0 };
  const app = createApp({ installRecorder: true });
  app.counters = counters;
  app.setGlobals(Object.assign(
    {
      currentUser: ADMIN,
      products: fixtureProducts(),
      orders: fixtureOrders(),
      deliveries: [],
      productionPlans: [],
      productionReports: [],
      processTemplates: [],
      transfers: [],
      logs: [],
      fields: { product: prodFields(), order: [] },
      fieldsAudit: 'audited',
      fieldsDraft: null,
      meta: { seq: 1, seeded: true },
      tblLayout: {},
      uiDefaults: { order: {} },
      renderAll: function () {},
      renderContent: function () { counters.renderContent++; },
    },
    seed || {}
  ));
  return app;
}
function J(app, expr) { return JSON.parse(app.run('JSON.stringify(' + expr + ')')); }

/* ================================================================
   §A normUiDefaults / prodOrderOf
   ================================================================ */

test('A1 非法输入一律归空（null / 数组 / 标量 / 无 order / order 非对象）', function () {
  const app = mkApp();
  ['null', '[]', '5', '"x"', '{}', '{order:null}', '{order:[]}', '{order:"x"}'].forEach(function (lit) {
    assert.deepEqual(J(app, 'normUiDefaults(' + lit + ')'), { order: {} }, 'normUiDefaults(' + lit + ') 应归空');
  });
  app.dispose();
});

test('A2 名单归一：去空、去重、非数组条目丢弃、数字 id 逐项 String 化', function () {
  const app = mkApp();
  const r = J(app, "normUiDefaults({order:{product:['P2','',null,'P1','P2',undefined,123,'P1'],bad:'x',bad2:[1,'2']}})");
  assert.deepEqual(r.order.product, ['P2', 'P1', '123'], '去空 + 保序去重 + 数字转字符串');
  assert.equal(r.order.bad, undefined, '非数组条目必须丢弃');
  assert.deepEqual(r.order.bad2, ['1', '2'], '数字数组也逐项 String 化');
  app.dispose();
});

test('A3 prodOrderOf 是唯一取值点：未自定义 → null；空数组也视为未自定义', function () {
  const app = mkApp();
  assert.equal(app.run('prodOrderOf()===null'), true, '未配置 → null');
  app.setGlobals({ uiDefaults: { order: { product: [] } } });
  assert.equal(app.run('prodOrderOf()===null'), true, '空名单等同未自定义（否则会清空所有人顺序还自称"已自定义"）');
  app.setGlobals({ uiDefaults: { order: { product: ['P3', 'P1', 'P2'] } } });
  assert.deepEqual(J(app, 'prodOrderOf()'), ['P3', 'P1', 'P2']);
  app.dispose();
});

test('A4 .155 旧结构 {sort:{...}} 必须被忽略（不崩、不误当名单）', function () {
  const app = mkApp();
  const r = J(app, "normUiDefaults({sort:{product:{key:'dailyCap',dir:-1}}})");
  assert.deepEqual(r, { order: {} }, '旧 sort 字段不再被识别（线上该键从未写入，无需迁移）');
  app.dispose();
});

/* ================================================================
   §B cmpByColDef：列头排序的比较口径（.155 抽取，.156 仍被 sortRows 使用）
   ================================================================ */

test('B1 数值列按数值比较（不得退化为字典序）——含 dir 反向', function () {
  const app = mkApp();
  const asc = J(app, "[{v:9},{v:100},{v:10}].sort(function(a,b){return cmpByColDef({key:'v',type:'number'},1,a,b);}).map(function(r){return r.v;})");
  assert.deepEqual(asc, [9, 10, 100], '升序 9 < 10 < 100（字典序会得 10,100,9）');
  const desc = J(app, "[{v:9},{v:100},{v:10}].sort(function(a,b){return cmpByColDef({key:'v',type:'number'},-1,a,b);}).map(function(r){return r.v;})");
  assert.deepEqual(desc, [100, 10, 9], '降序');
  app.dispose();
});

test('B2 文本列走 localeCompare(zh-CN)；日期列按先后 + dir 反向', function () {
  const app = mkApp();
  const t = J(app, "[{v:'B'},{v:'A'},{v:'C'}].sort(function(a,b){return cmpByColDef({key:'v',type:'text'},1,a,b);}).map(function(r){return r.v;})");
  assert.deepEqual(t, ['A', 'B', 'C']);
  const d = J(app, "[{v:'2026-01-02'},{v:'2026-01-01'},{v:'2026-01-03'}].sort(function(a,b){return cmpByColDef({key:'v',type:'date'},-1,a,b);}).map(function(r){return r.v;})");
  assert.deepEqual(d, ['2026-01-03', '2026-01-02', '2026-01-01']);
  app.dispose();
});

test('B3 列自定义 sort 权重函数优先于 type 分支', function () {
  const app = mkApp();
  const r = J(app, "[{v:'低'},{v:'高'}].sort(function(a,b){return cmpByColDef({key:'v',type:'text',sort:function(x){return x==='高'?2:0;}},1,a,b);}).map(function(r){return r.v;})");
  assert.deepEqual(r, ['低', '高'], '按权重（0 在前），未误走 text 拼音序');
  app.dispose();
});

test('B4 sortRows 必须复用 cmpByColDef（禁回退成内联比较副本）', function () {
  const body = stripComments(extractFn(INDEX_SRC, 'sortRows'));
  assert.ok(/cmpByColDef\(/.test(body), 'sortRows 必须调用 cmpByColDef');
  assert.ok(!/localeCompare/.test(body), 'sortRows 内不得再出现 localeCompare');
  assert.ok(!/col\.type===/.test(body), 'sortRows 内不得再出现 type 分支比较');
});

/* ================================================================
   §C productsSortedByOrder：按名单排序
   ================================================================ */

test('C1 未自定义顺序 → 返回录入顺序副本，且不是同一数组引用', function () {
  const app = mkApp();
  assert.deepEqual(J(app, "productsSortedByOrder().map(function(p){return p.id;})"), ['P1', 'P2', 'P3']);
  assert.equal(app.run('productsSortedByOrder()===products'), false, '必须返回副本');
  app.dispose();
});

test('C2 名单 [P3,P1,P2] → 严格按名单排', function () {
  const app = mkApp({ uiDefaults: { order: { product: ['P3', 'P1', 'P2'] } } });
  assert.deepEqual(J(app, "productsSortedByOrder().map(function(p){return p.id;})"), ['P3', 'P1', 'P2']);
  app.dispose();
});

test('C3 名单不含新产品 → 新产品排**末尾**，且相互间保持录入顺序', function () {
  /* 名单只有 P3、P1（P2 是后来新增、没进名单） */
  const app = mkApp({ uiDefaults: { order: { product: ['P3', 'P1'] } } });
  assert.deepEqual(J(app, "productsSortedByOrder().map(function(p){return p.id;})"), ['P3', 'P1', 'P2'],
    '名单内的在前（按名单），名单外的垫底（按录入序）');
  app.dispose();
});

test('C4 **不得改动 products 本身顺序**（顺序只影响展示副本）', function () {
  const app = mkApp({ uiDefaults: { order: { product: ['P3', 'P2', 'P1'] } } });
  app.run('productsSortedByOrder()');
  assert.deepEqual(J(app, 'products.map(function(p){return p.id;})'), ['P1', 'P2', 'P3'],
    'products 本体顺序必须原样（否则新增/编辑/索引类逻辑全乱）');
  app.dispose();
});

test('C5 名单里有已被删除的产品 id → 忽略它、其余照名单排（不崩）', function () {
  const app = mkApp({ uiDefaults: { order: { product: ['PX', 'P3', 'P1', 'P2'] } } });
  assert.deepEqual(J(app, "productsSortedByOrder().map(function(p){return p.id;})"), ['P3', 'P1', 'P2']);
  app.dispose();
});

/* ================================================================
   §D sortInvRowsByProdRank：库存订单跟随
   ================================================================ */

function invRowsLit(ids) {
  return '[' + ids.map(function (id, i) {
    return "{order:{id:'KCDD-" + i + "',orderType:'库存订单'},item:{productId:'" + id + "'}}";
  }).join(',') + ']';
}

test('D1 未自定义顺序 → **返回原数组引用**（调用方保持 .154「单据编号升序」，零回归）', function () {
  const app = mkApp();
  const lit = invRowsLit(['P3', 'P1', 'P2']);
  assert.equal(
    app.run('(function(){var r=' + lit + ';return sortInvRowsByProdRank(r)===r;})()'),
    true,
    '未自定义时必须返回原数组引用（零拷贝、零改动）'
  );
  const ids = J(app, 'sortInvRowsByProdRank(' + lit + ').map(function(r){return r.item.productId;})');
  assert.deepEqual(ids, ['P3', 'P1', 'P2'], '未自定义时不得改变顺序');
  app.dispose();
});

test('D2 名单 [P3,P1,P2] → 订单行按产品名次 P3 → P1 → P2', function () {
  const app = mkApp({ uiDefaults: { order: { product: ['P3', 'P1', 'P2'] } } });
  const ids = J(app, 'sortInvRowsByProdRank(' + invRowsLit(['P1', 'P2', 'P3']) + ').map(function(r){return r.item.productId;})');
  assert.deepEqual(ids, ['P3', 'P1', 'P2']);
  app.dispose();
});

test('D3 孤儿料号（产品主数据查不到）统一排**最后**，相互间保持原顺序', function () {
  const app = mkApp({ uiDefaults: { order: { product: ['P3', 'P1', 'P2'] } } });
  const ids = J(app, 'sortInvRowsByProdRank(' + invRowsLit(['ZZZ', 'P1', 'YYY', 'P3']) + ').map(function(r){return r.item.productId;})');
  assert.deepEqual(ids, ['P3', 'P1', 'ZZZ', 'YYY'], '已知料号按名次在前，孤儿保持原相对顺序垫底');
  app.dispose();
});

test('D4 名次相同（同一产品多行）按原下标升序 → 结果稳定', function () {
  const app = mkApp({ uiDefaults: { order: { product: ['P3', 'P1', 'P2'] } } });
  const lit = '[{order:{id:"A"},item:{productId:"P1"},tag:1},{order:{id:"B"},item:{productId:"P1"},tag:2},{order:{id:"C"},item:{productId:"P1"},tag:3}]';
  assert.deepEqual(J(app, 'sortInvRowsByProdRank(' + lit + ').map(function(r){return r.tag;})'), [1, 2, 3]);
  app.dispose();
});

test('D5 **不得原地排序入参数组**（只许产出副本，对齐 .153 纪律）', function () {
  const app = mkApp({ uiDefaults: { order: { product: ['P3', 'P1', 'P2'] } } });
  const r = J(app, '(function(){var rows=' + invRowsLit(['P1', 'P2', 'P3']) + ';sortInvRowsByProdRank(rows);return rows.map(function(r){return r.item.productId;});})()');
  assert.deepEqual(r, ['P1', 'P2', 'P3'], '入参数组顺序必须原样');
  app.dispose();
});

/* ================================================================
   §E guardProductDelByInvOrders：删除守卫（.155 口径，.156 不变）
   ================================================================ */

test('E1 被「执行中」库存订单引用 → 拦截，且提示里点出订单号与「停用」建议', function () {
  const app = mkApp();
  const blk = app.run("guardProductDelByInvOrders(['P1'])");
  assert.ok(blk && blk.length > 0, '必须返回受阻说明');
  assert.ok(blk.indexOf('KCDD-20260101-00001') >= 0, '提示须指出是哪张订单');
  assert.ok(blk.indexOf('停用') >= 0, '提示须给出替代做法');
  app.dispose();
});

test('E2 **已完成的历史单同样拦截**', function () {
  const app = mkApp();
  const blk = app.run("guardProductDelByInvOrders(['P2'])");
  assert.ok(blk && blk.indexOf('KCDD-20260101-00002') >= 0);
  app.dispose();
});

test('E3 只被**销售订单**引用 → 不拦（口径 D4：勿擅自扩大）', function () {
  const app = mkApp();
  assert.equal(app.run("guardProductDelByInvOrders(['P3'])"), null);
  app.dispose();
});

test('E4 无引用 / 空清单 → 放行', function () {
  const app = mkApp();
  assert.equal(app.run("guardProductDelByInvOrders(['P-NEW'])"), null);
  assert.equal(app.run('guardProductDelByInvOrders([])'), null);
  app.dispose();
});

test('E5 批量：有一个被引用就整批拒绝，并列出全部受阻产品', function () {
  const app = mkApp();
  const blk = app.run("guardProductDelByInvOrders(['P1','P2','P3'])");
  assert.ok(blk.indexOf('P1') >= 0 && blk.indexOf('P2') >= 0, 'P1/P2 都列出');
  assert.ok(blk.indexOf('P3') < 0, 'P3 只被销售订单引用，不应出现');
  app.dispose();
});

test('E6 守卫必须在 confirm **之前**（先拦后问），且只读', function () {
  const del = stripComments(extractFn(INDEX_SRC, 'delProduct'));
  const gi = del.indexOf('guardProductDelByInvOrders');
  const ci = del.indexOf('confirm(');
  assert.ok(gi >= 0 && ci >= 0 && gi < ci, 'delProduct：守卫在 confirm 之前');
  const bulk = stripComments(extractFn(INDEX_SRC, 'bulkDelete'));
  const bgi = bulk.indexOf('guardProductDelByInvOrders');
  const bci = bulk.indexOf("confirm('确认删除选中的");
  assert.ok(bgi >= 0 && bci >= 0 && bgi < bci, 'bulkDelete：守卫在 confirm 之前');

  const app = mkApp();
  const before = app.run('JSON.stringify([orders.length,products.length])');
  app.run("guardProductDelByInvOrders(['P1','P2'])");
  assert.equal(app.run('JSON.stringify([orders.length,products.length])'), before, '守卫不得改动数据');
  app.dispose();
});

/* ================================================================
   §F 静态守卫：拖拽引擎结构与三口径落地
   ================================================================ */

test('F1 拖拽用 Pointer Events 手写（非 HTML5 draggable），且有 500ms 长按门槛', function () {
  /* ⚠ 必须 stripComments 后再查：函数头注释里写着「为什么不用 <tr draggable="true">」，
     不剔注释会把**注释里的反例**当成真实用法误报（本用例开发时实测踩过一次）。 */
  assert.ok(!/draggable\s*=\s*["']true["']/.test(stripComments(INDEX_SRC)), '不得使用 HTML5 draggable=true（按下即拖，无法表达长按）');
  assert.match(INDEX_SRC, /const PD_LONG_PRESS_MS=500/, '长按门槛 500ms');
  const fn = stripComments(extractFn(INDEX_SRC, 'prodDragDown'));
  assert.match(fn, /setTimeout\(function\(\)\{ prodDragActivate\(st\); \},PD_LONG_PRESS_MS\)/, '按下后起长按计时');
  const mv = stripComments(extractFn(INDEX_SRC, '_pdMove'));
  assert.match(mv, /PD_MOVE_TOLERANCE\)prodDragAbort\(\)/, '长按期间超容差移动 ⇒ 判定为滚动并放弃');
});

test('F2 D1：拖拽前自动切 1000 条/页、结束后恢复原每页条数', function () {
  /* 【build .158 同步】引擎按 `st.form` 参数化（产品/零部件共用一套拖拽逻辑），
     故断言从「字面量 product」改为「缺省回落 product 的 fm 变量」——守的点完全不变：
     必须先判「全部显示」、必须切 1000、必须记住并恢复原每页条数。 */
  const act = stripComments(extractFn(INDEX_SRC, 'prodDragActivate'));
  assert.match(act, /const fm=st\.form\|\|'product'/, '表单键缺省回落 product（产品拖拽行为不变）');
  assert.match(act, /if\(!prodAllShown\(fm\)\)\{/, '必须先判断是否全部显示');
  assert.match(act, /size:1000/, '自动切 1000 条/页');
  assert.match(act, /st\.restoreSize=pageSizeOf\(fm\)/, '记住原每页条数以便恢复（按当前拖拽表单取值）');
  const rps = stripComments(extractFn(INDEX_SRC, 'prodRestorePageSize'));
  assert.match(rps, /form=form\|\|_pdLastForm\|\|'product'/, '恢复每页条数缺省回落 product');
  const fin = stripComments(extractFn(INDEX_SRC, 'prodDragFinish'));
  assert.match(fin, /if\(size\)prodRestorePageSize\(size\)/, '结束后恢复原每页条数');
  const ab = stripComments(extractFn(INDEX_SRC, 'prodDragAbort'));
  assert.match(ab, /if\(st\.restoreSize\)prodRestorePageSize\(st\.restoreSize\)/, '中途放弃也要恢复（否则每页条数会卡在 1000）');
});

test('F3 D2：有筛选时禁止拖拽，并给「清除筛选」的提示出口', function () {
  const down = stripComments(extractFn(INDEX_SRC, 'prodDragDown'));
  assert.match(down, /if\(prodFilterActive\(\)\)\{ st\.blocked=true; return; \}/, '筛选态不启动长按计时');
  const up = stripComments(extractFn(INDEX_SRC, '_pdUp'));
  assert.match(up, /if\(st\.blocked\)\{ prodDragAbort\(\); pdFilterHint\(\); return; \}/, '抬起时给提示');
  const hint = stripComments(extractFn(INDEX_SRC, 'pdFilterHint'));
  assert.match(hint, /clearProductFilters\(\)/, '提示里必须有「清除筛选」按钮');
  assert.match(hint, /8000/, '提示须节流，避免连点刷屏');
});

test('F4 D3：只留拖拽——旧「设为默认排序/清除」函数与按钮必须彻底移除', function () {
  ['setProductDefaultSort', 'clearProductDefaultSort', 'productsSortedByDefault', 'prodFieldLabelOf', 'defaultSortOf'].forEach(function (n) {
    assert.strictEqual(INDEX_SRC.indexOf(n), -1, '旧符号 ' + n + ' 必须已完全移除（无函数、无按钮、无调用）');
  });
  const rp = stripComments(extractFn(INDEX_SRC, 'renderProducts'));
  assert.match(rp, /onclick="resetProductOrder\(\)"/, '保留「恢复录入顺序」作为撤销出口');
});

test('F5 行绑定：data-pid + onpointerdown，且非管理员不挂可拖光标', function () {
  const rp = stripComments(extractFn(INDEX_SRC, 'renderProducts'));
  assert.match(rp, /data-pid="'\+esc\(String\(p\.id==null\?'':p\.id\)\)\+'"/, '行必须带 data-pid');
  assert.match(rp, /onpointerdown="prodDragDown\(event\)"/, '行必须绑定 pointerdown');
  assert.match(rp, /\(isSysAdmin\(\)\?' class="pd-draggable"':''\)/, '仅管理员显示可拖光标');
});

test('F6 拖拽结束后抑制一次行点击（否则松手会误勾选该行）', function () {
  assert.match(INDEX_SRC, /var _pdSuppressClick=0;/, '抑制时间戳变量存在');
  const fn = stripComments(extractFn(INDEX_SRC, 'selRowClick'));
  assert.match(fn, /if\(m==='product'&&Date\.now\(\)-\(_pdSuppressClick\|\|0\)<300\)return;/, '产品行点击须被抑制');
  const fin = stripComments(extractFn(INDEX_SRC, 'prodDragFinish'));
  assert.match(fin, /_pdSuppressClick=Date\.now\(\);/, '拖拽结束时打抑制时间戳');
});

test('F7 保存的是**全量名单**：DOM 行序 + 按当前生效顺序补齐不在 DOM 的产品', function () {
  /* 【build .158 同步】补齐用的排序与名单落库键都改为经「表单元数据」取（产品/零部件共用一套引擎），
     守的点不变：①读 tbody 真实行序 ②补齐全量时用**当前生效顺序**（不是录入顺序）
     ③落库的是名单数组且按表单分开存 ④必须写操作日志。 */
  const fin = stripComments(extractFn(INDEX_SRC, 'prodDragFinish'));
  assert.match(fin, /querySelectorAll\('tr\[data-pid\]'\)\)\.map\(r=>r\.dataset\.pid\)/, '读 tbody 实际行序');
  assert.match(fin, /const meta=pdMeta\(form\)/, '排序/日志目标由表单元数据提供');
  assert.match(fin, /meta\.sorted\(\)\.forEach/, '补齐用当前生效顺序（用录入顺序会把已有自定义序打乱）');
  assert.match(fin, /const patch=\{\};\s*patch\[form\]=ids;/, '名单按键分开存（product / parts 各一份，互不覆盖）');
  assert.match(fin, /saveUiDefaults\(patch\)/, '存的是名单数组');
  /* 表单元数据必须指回**同一套排序实现**（禁止各自复制一份排序逻辑）。 */
  const plain = stripComments(INDEX_SRC);
  assert.ok(plain.indexOf('sorted:productsSortedByOrder') >= 0, 'product 表单元数据指向 productsSortedByOrder');
  assert.ok(plain.indexOf('sorted:partsSortedByOrder') >= 0, 'parts 表单元数据指向 partsSortedByOrder');
  assert.ok(plain.indexOf('orderOf:prodOrderOf') >= 0 && plain.indexOf('orderOf:partsOrderOf') >= 0,
    '两张表各自的名单取值点都挂在元数据上');
  /* 写操作日志：`.155` 那次「排序无效」正是靠「日志命中 0 条」定性的，
     故拖拽保存必须留痕，否则下次再出问题同样无从判定用户有没有点成功。 */
  assert.match(fin, /logOp\('设置',meta\.target/, '拖拽保存必须写操作日志（目标名随表单）');
  assert.ok(plain.indexOf("orderLog:'调整产品显示顺序'") >= 0, '产品日志文案保持 .156 原文');
});

test('F8 拖拽必须过管理员守卫（非管理员连状态机都不启动）', function () {
  const down = stripComments(extractFn(INDEX_SRC, 'prodDragDown'));
  const gi = down.indexOf('if(!isSysAdmin())return;');
  const si = down.indexOf('setTimeout');
  assert.ok(gi >= 0, 'prodDragDown 必须判管理员');
  assert.ok(gi < si, '管理员判定必须在启动计时之前');
  const rst = stripComments(extractFn(INDEX_SRC, 'resetProductOrder'));
  assert.match(rst, /if\(!needSysAdmin\(\)\)return;/, '「恢复录入顺序」必须有函数级守卫');
});

test('F9 接入口与默认排序分支：initApp/rehydrate 加载 uiDefaults；库存订单走产品名次分支', function () {
  assert.ok(INDEX_SRC.indexOf("applyUiDefaults(await DB.get('uiDefaults',{}))") >= 0, 'initApp 必须加载 uiDefaults');
  assert.ok(INDEX_SRC.indexOf('applyUiDefaults(serverData.uiDefaults)') >= 0, 'rehydrateFromServer 必须回灌');
  const body = stripComments(extractFn(INDEX_SRC, 'renderOrderTable'));
  assert.match(body, /if\(prodOrderOf\(\)\)shown=sortInvRowsByProdRank\(shown\)/, '库存订单必须走产品名次');
  assert.match(body, /shown=\[\.\.\.shown\]\.sort\(\(a,b\)=>a\.order\.id\.localeCompare\(b\.order\.id,'zh-CN'\)\)/,
    '未自定义时的「单据编号升序」兜底必须保留（零回归）');
  const rp = stripComments(extractFn(INDEX_SRC, 'renderProducts'));
  assert.match(rp, /if\(!tState\('product'\)\.sort&&prodOrderOf\(\)\)_pBase=productsSortedByOrder\(\)/,
    '产品列表：未手动排序且有自定义顺序时才套用');
});

test('F10 排序/拖拽都必须早于分页（.80 教训）', function () {
  const body = stripComments(extractFn(INDEX_SRC, 'renderOrderTable'));
  const si = body.indexOf('sortInvRowsByProdRank(shown)');
  const pi = body.indexOf('slicePaged(formKey');
  assert.ok(si >= 0 && pi >= 0 && si < pi, '库存订单排序位置必须在 slicePaged 之前');
  const rp = stripComments(extractFn(INDEX_SRC, 'renderProducts'));
  const ri = rp.indexOf('productsSortedByOrder()');
  const rpi = rp.indexOf("slicePaged('product'");
  assert.ok(ri >= 0 && rpi >= 0 && ri < rpi, '产品自定义顺序必须在 slicePaged 之前');
});

test('F11 服务端：uiDefaults 已注册且非 admin 恒 false（.155 硬闸未回退）', function () {
  assert.match(SERVER_SRC, /uiDefaults:\s*\{\}/, 'DEFAULT_DATA 必须注册 uiDefaults');
  const fn = stripComments(extractFn(SERVER_SRC, 'canWrite'));
  const seg = fn.slice(fn.indexOf("case 'uiDefaults':"));
  assert.ok(seg.length > 0, 'canWrite 必须有 uiDefaults 分支');
  assert.match(seg.slice(0, 80), /return false;/, '非 admin 一律 false');
});
