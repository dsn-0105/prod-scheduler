'use strict';
/* ================================================================
   tests/product-default-sort.155.test.js
   —— 2026-10-21.155「产品主数据默认排序 → 库存订单跟随」+ 两条硬限制 契约用例
   ================================================================
   需求（用户 2026-10-20 提出、2026-10-21 三次拍板）：
     R1 自定义默认排序**设产品主数据上**（仅管理员可调）
     R2 库存订单列表默认排序**直接跟随**产品主数据的排序
     R3 有库存订单的产品**禁止删除**（历史单也算，提示改「停用」）
     R4 库存订单**只能 1 行明细**；批量生成改为「一产品一张单」

   已拍板口径（**本节即验收基准，不得自行放宽**）：
     D1 跟随方式是「传座次」而不是「传字段名」—— 两表存在同名不同义的列
        （`id`：产品=产品编码 / 订单=订单编号；`status`：产品=启用停用 / 订单=执行中…），
        照搬字段名会静默排错。故只传递「产品在已排序列表中的位置」。
     D2 未配置默认排序 → 产品列表回落「录入顺序」、库存订单回落「单据编号升序」= .154 原行为（零回归）
     D3 查不到的料号（孤儿）统一排最后，相互间保持原顺序
     D4 删除守卫只看**库存订单**；销售订单引用不在本次拦截内（按用户口径逐字实现，勿擅自扩大）
     D5 批量生成：交互仍是一屏填完，**落库形态**拆成一产品一张单

   覆盖结构：
     §A normUiDefaults / defaultSortOf   归一与唯一取值点
     §B cmpByColDef                      .155 抽取的**共用比较口径**行为（含数值不按字典序）
     §C productsSortedByDefault          配置生效 / 未配置 / 字段被删 / 不动 products 顺序
     §D sortInvRowsByProdRank            座次排序 / 孤儿末尾 / 未配置原样 / 不改入参 / 稳定
     §E guardProductDelByInvOrders       库存单拦 / 历史单也算 / 销售单不拦 / 未引用放行
     §F 静态守卫                         1 行限制 / 弹窗入口收敛 / 批量拆单 / 权限硬闸

   为何 §B 必须存在：.155 把 sortRows 内联的比较逻辑抽成 cmpByColDef 供默认排序复用。
   这是**对全表共用的排序引擎做等价重构** —— 一旦口径漂移（例如把 localeCompare 的
   'zh-CN' 或 date 分支的 -dir 写错），所有表格的手动排序都会跟着错，且不会有任何用例报错
   （因为大多数用例只断言「排序生效」，不断言「按什么规则排」）。故此处逐条钉死。

   运行：node --test tests/product-default-sort.155.test.js
   ================================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createApp, ROOT } = require('./harness/sandbox');

const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');

const ADMIN = { username: 'pmc', name: 'PMC小张', role: 'admin', perms: {} };

/** 剔除注释（静态守卫用，避免注释里的措辞造成误判） */
function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}
/** 花括号配平抽取函数源码 */
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

/* ---------- 产品字段配置（默认 8 字段，与 defaultFields.product 同口径） ---------- */
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

/** 计数沙箱：renderContent 计数，防「失败却渲染成功态」 */
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
      uiDefaults: { sort: {} },
      renderAll: function () {},
      renderContent: function () { counters.renderContent++; },
    },
    seed || {}
  ));
  return app;
}
/** 通过 app.run 取 JSON 结构 */
function J(app, expr) { return JSON.parse(app.run('JSON.stringify(' + expr + ')')); }

/* ================================================================
   §A normUiDefaults / defaultSortOf：归一与唯一取值点
   ================================================================ */

test('A1 非法输入一律归空（null / 数组 / 标量 / 无 sort）', function () {
  const app = mkApp();
  ['null', '[]', '5', '"x"', '{}', '{sort:null}', '{sort:[]}'].forEach(function (lit) {
    const r = J(app, 'normUiDefaults(' + lit + ')');
    assert.deepEqual(r, { sort: {} }, 'normUiDefaults(' + lit + ') 应归空');
  });
  app.dispose();
});

test('A2 合法条目保留；key 为空的条目丢弃；dir 只认 ±1（其余按升序）', function () {
  const app = mkApp();
  const r = J(app, "normUiDefaults({sort:{product:{key:'dailyCap',dir:-1},bad1:{key:'',dir:1},bad2:{dir:1},bad3:null,weird:{key:'stock',dir:5}}})");
  assert.deepEqual(r.sort.product, { key: 'dailyCap', dir: -1 }, '合法条目逐字保留');
  assert.equal(r.sort.bad1, undefined, 'key 为空必须丢弃');
  assert.equal(r.sort.bad2, undefined, '缺 key 必须丢弃');
  assert.equal(r.sort.bad3, undefined, 'null 条目必须丢弃');
  assert.deepEqual(r.sort.weird, { key: 'stock', dir: 1 }, 'dir 非 -1 一律归 1（升序）');
  app.dispose();
});

test('A3 defaultSortOf 是唯一取值点：未配置返回 null，配置后返回该条目', function () {
  const app = mkApp();
  assert.equal(app.run("defaultSortOf('product')===null"), true, '未配置 → null（触发调用方回落既有默认）');
  assert.equal(app.run("defaultSortOf('order_inv')===null"), true, '其它表单未配置 → null');
  app.setGlobals({ uiDefaults: { sort: { product: { key: 'stock', dir: -1 } } } });
  assert.deepEqual(J(app, "defaultSortOf('product')"), { key: 'stock', dir: -1 });
  app.dispose();
});

/* ================================================================
   §B cmpByColDef：.155 抽取出的共用比较口径（全表手动排序 + 默认排序共用）
   ================================================================ */

test('B1 数值列按数值比较（不得退化为字典序）——含 dir 反向', function () {
  const app = mkApp();
  const rows = [{ v: 9 }, { v: 100 }, { v: 10 }];
  const asc = J(app, "[" + rows.map(function (r) { return JSON.stringify(r); }).join(',') + "].sort(function(a,b){return cmpByColDef({key:'v',type:'number'},1,a,b);}).map(function(r){return r.v;})");
  assert.deepEqual(asc, [9, 10, 100], '升序：9 < 10 < 100（字典序会得到 10,100,9）');
  const desc = J(app, "[" + rows.map(function (r) { return JSON.stringify(r); }).join(',') + "].sort(function(a,b){return cmpByColDef({key:'v',type:'number'},-1,a,b);}).map(function(r){return r.v;})");
  assert.deepEqual(desc, [100, 10, 9], '降序');
  app.dispose();
});

test('B2 数字样字符串在 number 列按数值走（num 归一），不受前导零/空值影响', function () {
  const app = mkApp();
  const rows = [{ v: '010' }, { v: '9' }, { v: '' }];
  const asc = J(app, "[" + rows.map(function (r) { return JSON.stringify(r); }).join(',') + "].sort(function(a,b){return cmpByColDef({key:'v',type:'number'},1,a,b);}).map(function(r){return r.v;})");
  assert.deepEqual(asc, ['', '9', '010'], "空值按 0 计，'9' 在 '010'(=10) 之前");
  app.dispose();
});

test('B3 文本列走 localeCompare(zh-CN)；日期列按字符串先后 + dir 反向', function () {
  const app = mkApp();
  const t = J(app, "[{v:'B'},{v:'A'},{v:'C'}].sort(function(a,b){return cmpByColDef({key:'v',type:'text'},1,a,b);}).map(function(r){return r.v;})");
  assert.deepEqual(t, ['A', 'B', 'C'], '文本升序');
  const d = J(app, "[{v:'2026-01-02'},{v:'2026-01-01'},{v:'2026-01-03'}].sort(function(a,b){return cmpByColDef({key:'v',type:'date'},-1,a,b);}).map(function(r){return r.v;})");
  assert.deepEqual(d, ['2026-01-03', '2026-01-02', '2026-01-01'], '日期降序');
  app.dispose();
});

test('B4 列自定义 sort 权重函数优先于 type 分支（语义排序不被 type 抢走）', function () {
  const app = mkApp();
  /* 权重：'高'=2 '低'=0 —— 若误走 text 分支，'低' 会排在 '高' 前面（'低' 拼音 di < '高' gao） */
  const r = J(app, "[{v:'低'},{v:'高'}].sort(function(a,b){return cmpByColDef({key:'v',type:'text',sort:function(x){return x==='高'?2:0;}},1,a,b);}).map(function(r){return r.v;})");
  assert.deepEqual(r, ['低', '高'], '按权重升序（0 在前）');
  app.dispose();
});

test('B5 sortRows 必须复用 cmpByColDef（禁回退成内联比较副本）', function () {
  const body = stripComments(extractFn(INDEX_SRC, 'sortRows'));
  assert.ok(/cmpByColDef\(/.test(body), 'sortRows 必须调用 cmpByColDef');
  assert.ok(!/localeCompare/.test(body), 'sortRows 内不得再出现 localeCompare（否则等于第二份比较实现）');
  assert.ok(!/col\.type===/.test(body), 'sortRows 内不得再出现 type 分支比较（否则等于第二份比较实现）');
});

/* ================================================================
   §C productsSortedByDefault：配置生效 / 未配置 / 字段被删
   ================================================================ */

test('C1 未配置默认排序 → 返回「录入顺序」副本，且不是同一数组引用', function () {
  const app = mkApp();
  assert.deepEqual(J(app, "productsSortedByDefault().map(function(p){return p.id;})"), ['P1', 'P2', 'P3']);
  assert.equal(app.run('productsSortedByDefault()===products'), false, '必须返回副本（不得把 products 本身交出去）');
  app.dispose();
});

test('C2 配置「日产能 降序」→ 产品按数值降序（P3:300 > P1:100 > P2:20）', function () {
  const app = mkApp({ uiDefaults: { sort: { product: { key: 'dailyCap', dir: -1 } } } });
  assert.deepEqual(J(app, "productsSortedByDefault().map(function(p){return p.id;})"), ['P3', 'P1', 'P2']);
  app.dispose();
});

test('C3 配置「库存 升序」→ P3:1 < P1:5 < P2:50', function () {
  const app = mkApp({ uiDefaults: { sort: { product: { key: 'stock', dir: 1 } } } });
  assert.deepEqual(J(app, "productsSortedByDefault().map(function(p){return p.id;})"), ['P3', 'P1', 'P2']);
  app.dispose();
});

test('C4 **不得改动 products 本身顺序**（默认排序只影响展示副本）', function () {
  const app = mkApp({ uiDefaults: { sort: { product: { key: 'dailyCap', dir: -1 } } } });
  app.run('productsSortedByDefault()');
  assert.deepEqual(J(app, 'products.map(function(p){return p.id;})'), ['P1', 'P2', 'P3'],
    'products 本体顺序必须原样（否则新增/编辑/索引类逻辑全乱）');
  app.dispose();
});

test('C5 配置的字段已被「字段设置」删除 → 回落录入顺序（不报错、不空排）', function () {
  const flds = prodFields().filter(function (f) { return f.key !== 'dailyCap'; });
  const app = mkApp({ fields: { product: flds, order: [] }, uiDefaults: { sort: { product: { key: 'dailyCap', dir: -1 } } } });
  assert.deepEqual(J(app, "productsSortedByDefault().map(function(p){return p.id;})"), ['P1', 'P2', 'P3'],
    '字段已删除 → 静默回落录入顺序');
  assert.equal(app.run('defaultSortOf("product")!==null'), true, '配置本身仍在（只是本字段不可用）');
  app.dispose();
});

/* ================================================================
   §D sortInvRowsByProdRank：库存订单按产品座次
   ================================================================ */

/** 构造订单行（{order,item,...} 包装，与 renderOrderTable 的 rows 同形） */
function invRowsLit(ids) {
  return '[' + ids.map(function (id, i) {
    return "{order:{id:'KCDD-" + i + "',orderType:'库存订单'},item:{productId:'" + id + "'}}";
  }).join(',') + ']';
}

test('D1 未配置默认排序 → 原样返回（调用方保持 .154「单据编号升序」，零回归）', function () {
  const app = mkApp();
  const lit = invRowsLit(['P3', 'P1', 'P2']);
  /* 未配置时必须是**同一引用原样返回**（零拷贝、零改动）——这才是「调用方行为完全不变」的强证据。
     ⚠ 此处刻意不写成 `assert(x || true)` 之类的恒真式：恒真断言等于没有断言（.152 教训）。 */
  assert.equal(
    app.run('(function(){var r=' + lit + ';return sortInvRowsByProdRank(r)===r;})()'),
    true,
    '未配置时必须返回原数组引用'
  );
  const ids = J(app, 'sortInvRowsByProdRank(' + lit + ').map(function(r){return r.item.productId;})');
  assert.deepEqual(ids, ['P3', 'P1', 'P2'], '未配置时不得改变顺序');
  app.dispose();
});

test('D2 配置「日产能 降序」→ 订单行按产品座次 P3 → P1 → P2', function () {
  const app = mkApp({ uiDefaults: { sort: { product: { key: 'dailyCap', dir: -1 } } } });
  const ids = J(app, 'sortInvRowsByProdRank(' + invRowsLit(['P1', 'P2', 'P3']) + ').map(function(r){return r.item.productId;})');
  assert.deepEqual(ids, ['P3', 'P1', 'P2'], '跟随产品座次（300 > 100 > 20）');
  app.dispose();
});

test('D3 孤儿料号（产品主数据查不到）统一排**最后**，相互间保持原顺序', function () {
  const app = mkApp({ uiDefaults: { sort: { product: { key: 'dailyCap', dir: -1 } } } });
  const ids = J(app, 'sortInvRowsByProdRank(' + invRowsLit(['ZZZ', 'P1', 'YYY', 'P3']) + ').map(function(r){return r.item.productId;})');
  assert.deepEqual(ids, ['P3', 'P1', 'ZZZ', 'YYY'], '已知料号按座次在前，孤儿保持原相对顺序垫底');
  app.dispose();
});

test('D4 同座次（同一产品多行）按原下标升序 → 结果稳定可预期', function () {
  const app = mkApp({ uiDefaults: { sort: { product: { key: 'dailyCap', dir: -1 } } } });
  const lit = '[{order:{id:"A"},item:{productId:"P1"},tag:1},{order:{id:"B"},item:{productId:"P1"},tag:2},{order:{id:"C"},item:{productId:"P1"},tag:3}]';
  const tags = J(app, 'sortInvRowsByProdRank(' + lit + ').map(function(r){return r.tag;})');
  assert.deepEqual(tags, [1, 2, 3], '同座次保持原顺序');
  app.dispose();
});

test('D5 **不得原地排序入参数组**（只许产出副本，对齐 .153 纪律）', function () {
  const app = mkApp({ uiDefaults: { sort: { product: { key: 'dailyCap', dir: -1 } } } });
  const r = J(app, '(function(){var rows=' + invRowsLit(['P1', 'P2', 'P3']) + ';sortInvRowsByProdRank(rows);return rows.map(function(r){return r.item.productId;});})()');
  assert.deepEqual(r, ['P1', 'P2', 'P3'], '入参数组顺序必须原样（原地 sort 会让调用方后续逻辑拿到错的顺序）');
  app.dispose();
});

/* ================================================================
   §E guardProductDelByInvOrders：有库存订单的产品禁止删除
   ================================================================ */

test('E1 被「执行中」库存订单引用 → 拦截，且提示里点出订单号', function () {
  const app = mkApp();
  const blk = app.run("guardProductDelByInvOrders(['P1'])");
  assert.ok(blk && blk.length > 0, '必须返回受阻说明');
  assert.ok(blk.indexOf('KCDD-20260101-00001') >= 0, '提示须指出是哪张订单（便于用户核对）');
  assert.ok(blk.indexOf('停用') >= 0, '提示须给出替代做法（改为停用）');
  app.dispose();
});

test('E2 **已完成的历史单同样拦截**（用户拍板：历史订单也算，用过就不能删）', function () {
  const app = mkApp();
  const blk = app.run("guardProductDelByInvOrders(['P2'])");
  assert.ok(blk && blk.indexOf('KCDD-20260101-00002') >= 0, '已完成订单引用也必须拦');
  app.dispose();
});

test('E3 只被**销售订单**引用 → 不拦（口径 D4：本次只按库存订单拦，勿擅自扩大）', function () {
  const app = mkApp();
  assert.equal(app.run("guardProductDelByInvOrders(['P3'])"), null, '销售订单引用不在本次拦截范围');
  app.dispose();
});

test('E4 完全没有引用的产品 → 放行（null）', function () {
  const app = mkApp();
  assert.equal(app.run("guardProductDelByInvOrders(['P-NEW'])"), null);
  assert.equal(app.run('guardProductDelByInvOrders([])'), null, '空清单不拦');
  app.dispose();
});

test('E5 批量删除：清单中只要有一个被引用就整批拒绝，并列出全部受阻产品', function () {
  const app = mkApp();
  const blk = app.run("guardProductDelByInvOrders(['P1','P2','P3'])");
  assert.ok(blk.indexOf('P1') >= 0, '列出 P1');
  assert.ok(blk.indexOf('P2') >= 0, '列出 P2（已完成单）');
  assert.ok(blk.indexOf('P3') < 0, 'P3 只被销售订单引用，不应出现在受阻清单');
  app.dispose();
});

test('E6 delProduct / bulkDelete 都把守卫放在 confirm **之前**（先拦后问）', function () {
  const del = stripComments(extractFn(INDEX_SRC, 'delProduct'));
  const gi = del.indexOf('guardProductDelByInvOrders');
  const ci = del.indexOf('confirm(');
  assert.ok(gi >= 0, 'delProduct 必须调用守卫');
  assert.ok(ci >= 0 && gi < ci, '守卫必须在 confirm 之前（否则用户白点一次确定）');

  const bulk = stripComments(extractFn(INDEX_SRC, 'bulkDelete'));
  const bgi = bulk.indexOf('guardProductDelByInvOrders');
  const bci = bulk.indexOf("confirm('确认删除选中的");
  assert.ok(bgi >= 0, 'bulkDelete 必须调用守卫');
  assert.ok(bci >= 0 && bgi < bci, '批量守卫必须在 confirm 之前');
});

test('E7 守卫是只读的（不改 orders / products）', function () {
  const app = mkApp();
  const before = app.run('JSON.stringify([orders.length,products.length])');
  app.run("guardProductDelByInvOrders(['P1','P2'])");
  const after = app.run('JSON.stringify([orders.length,products.length])');
  assert.equal(after, before, '守卫不得改动任何数据');
  app.dispose();
});

/* ================================================================
   §F 静态守卫：1 行限制 / 弹窗入口收敛 / 批量拆单 / 权限硬闸 / 接入口
   ================================================================ */

test('F1 saveOrder 有「库存订单只能 1 行」拦截，且批量模式走例外', function () {
  const body = stripComments(extractFn(INDEX_SRC, 'saveOrder'));
  assert.match(body, /o\.orderType==='库存订单'&&items\.length>1&&!__orderBulkGen/,
    '必须存在 1 行校验，且唯一例外是 __orderBulkGen');
  assert.match(body, /库存订单只能有 1 行产品明细/, '拦截文案须说明「一产品一张单」');
  assert.match(body, /saveBulkInvOrders\(o,items\)/, '批量模式须分流到拆单函数');
});

test('F2 库存订单弹窗不提供「批量选择产品 / 添加产品行」入口；销售订单不受影响', function () {
  const body = stripComments(extractFn(INDEX_SRC, 'orderModal'));
  assert.match(body, /\(locked\|\|_invModal\?'':/, '库存订单(_invModal)时必须隐藏两个加行入口');
  assert.ok(body.indexOf('batchPickProducts()') > 0, '销售订单入口仍在（只是条件里排除库存订单）');
});

test('F3 bulkGenOrder 传 {bulkGen:true}，且 orderModal 据此设置 __orderBulkGen（每次打开都重设）', function () {
  const bgen = stripComments(extractFn(INDEX_SRC, 'bulkGenOrder'));
  assert.match(bgen, /\{bulkGen:true\}/, 'bulkGenOrder 必须声明批量模式');
  const om = stripComments(extractFn(INDEX_SRC, 'orderModal'));
  assert.match(om, /__orderBulkGen=!!\(opts&&opts\.bulkGen\)/, 'orderModal 必须每次按 opts 重设开关（防残留）');
});

test('F4 saveBulkInvOrders：一产品一张单 + orders/logs 一次 DB.tx + 深拷贝', function () {
  const fn = stripComments(extractFn(INDEX_SRC, 'saveBulkInvOrders'));
  assert.match(fn, /one\.items=\[JSON\.parse\(JSON\.stringify\(it\)\)\]/, '每张单只带自己那一行，且必须深拷贝');
  assert.match(fn, /JSON\.parse\(JSON\.stringify\(head\)\)/, '单据头必须深拷贝（否则多张单共享引用互相串改）');
  assert.match(fn, /DB\.tx\(\[\{key:'orders',value:orders\},\{key:'logs',value:logs\}\]/, 'orders + logs 必须一次原子提交');
  assert.match(fn, /while\(orders\.some/, '单号必须防撞号');
});

test('F5 服务端：uiDefaults 已注册进 DEFAULT_DATA，且 canWrite 对非 admin 恒 false', function () {
  assert.match(SERVER_SRC, /uiDefaults:\s*\{\}/, 'DEFAULT_DATA 必须注册 uiDefaults（否则 /api/tx 报「未知数据表」400）');
  const fn = stripComments(extractFn(SERVER_SRC, 'canWrite'));
  const seg = fn.slice(fn.indexOf("case 'uiDefaults':"));
  assert.ok(seg.length > 0, 'canWrite 必须有 uiDefaults 分支');
  assert.match(seg.slice(0, 80), /return false;/, '非 admin 一律 false（admin 已在函数首行放行）');
  assert.match(SERVER_SRC, /if \(user\.role === 'admin'\) return true;/, 'admin 首行放行不变');
});

test('F6 前端接入口：initApp / rehydrateFromServer 均加载 uiDefaults；库存订单默认排序走座次分支', function () {
  assert.ok(INDEX_SRC.indexOf("applyUiDefaults(await DB.get('uiDefaults',{}))") >= 0, 'initApp 必须加载 uiDefaults');
  assert.ok(INDEX_SRC.indexOf('applyUiDefaults(serverData.uiDefaults)') >= 0, 'rehydrateFromServer 必须回灌 uiDefaults');
  const body = stripComments(extractFn(INDEX_SRC, 'renderOrderTable'));
  assert.match(body, /sortInvRowsByProdRank\(shown\)/, '库存订单默认排序必须走产品座次');
  /* 未配置时的原行为（单据编号升序）必须保留，否则 .154 老行为回归 */
  assert.match(body, /shown=\[\.\.\.shown\]\.sort\(\(a,b\)=>a\.order\.id\.localeCompare\(b\.order\.id,'zh-CN'\)\)/,
    '未配置默认排序时的「单据编号升序」兜底必须保留');
});

test('F7 产品列表只在「未手动排序」时套默认排序（手动排序优先，回落后不生效）', function () {
  const body = stripComments(extractFn(INDEX_SRC, 'renderProducts'));
  assert.match(body, /if\(!tState\('product'\)\.sort&&defaultSortOf\('product'\)\)_pBase=productsSortedByDefault\(\)/,
    '必须限定 !tState(...).sort 且已配置，才用默认排序');
});

test('F8 「设为默认排序 / 清除」必须过 needSysAdmin 守卫（防 F12 直调）', function () {
  ['setProductDefaultSort', 'clearProductDefaultSort'].forEach(function (name) {
    const body = stripComments(extractFn(INDEX_SRC, name));
    assert.match(body, /if\(!needSysAdmin\(\)\)return;/, name + ' 必须有函数级管理员守卫');
  });
});

test('F9 排序必须早于分页（.80 教训：写在分页后只排当前页）', function () {
  const body = stripComments(extractFn(INDEX_SRC, 'renderOrderTable'));
  const si = body.indexOf('sortInvRowsByProdRank(shown)');
  const pi = body.indexOf('slicePaged(formKey');
  assert.ok(si >= 0 && pi >= 0, '两处都必须存在');
  assert.ok(si < pi, '库存订单排序位置必须在 slicePaged 之前');
});
