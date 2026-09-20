'use strict';
/* ================================================================
   tests/import.idempotent.test.js —— 金蝶导入黄金样例（幂等 / 决策 / 口径）
   ================================================================ */
/* 覆盖（P1-4 清单）：金蝶导入幂等 —— 同一份金蝶文件重复导入不得产生重复订单/重复产品，
   以及决策分支（新建 / 选已有 / 忽视 / 跳过 / 重命名）与导入口径。
   .130 起口径：Excel「已交付 / 已出库数量」**不落库**（落库 deliveredQty 恒 0、不写 directDelivered），
   该数字仅进预检报告提示；原 .108「落 directDelivered 期初基数」用例随之替换（见「.130 导入口径」节）。

   为什么值得单独钉死：导入是**唯一的批量写入入口**，线上最典型的误操作就是「同一份文件
   点两次确认」。改造前 products 与 orders 分两次写，重复导入时一旦中途失败就留下孤儿产品；
   T03 把两者并入同一个 /api/tx，本文件把「重复导入不增生」这个语义钉死。

   边界：不解析真实 xlsx（直接预置 kdReport/kdState），只驱动 kdDoImport 的决策与落库逻辑。
   运行：node --test tests/import.idempotent.test.js（**不要用 node -e**，见 README）
   ================================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('./harness/sandbox');
const { createFetchStub } = require('./harness/dom-stub');

function plain(v) {
  return JSON.parse(JSON.stringify(v));
}

/* ---------------- 金蝶预检报告夹具 ---------------- */

function kdItem(productId, orderQty, deliveredQty, extra) {
  return Object.assign(
    { productId: productId, productName: '甲', spec: '', model: '', unit: '台', orderQty: orderQty, deliveredQty: deliveredQty || 0, lineNotes: '' },
    extra || {}
  );
}
function kdOrder(id, items) {
  return { id: id, customer: '金蝶客户', startDate: '2026-09-01', deadline: '2026-10-01', contractNo: 'HT9', items: items };
}
/** 造一份 km 预检报告：opts = { pm, unknown, conflict, filename } */
function kdReport(order, opts) {
  const o = opts || {};
  return {
    filename: o.filename || 'kd-a.xlsx',
    totalOrders: 1,
    pm: o.pm || {},
    list: [order],
    unknown: o.unknown || [],
    conflict: o.conflict || [],
  };
}
/** 未知编码的预检条目：{idx, o(所属订单), li(行号)} */
function kdUnknown(idx, order, li) {
  return { idx: idx, o: order, li: li };
}

/** 带记录器的沙箱（断言写集与「一次事务」） */
function recApp(seed) {
  const app = createApp({ installRecorder: true });
  app.setGlobals(
    Object.assign(
      {
        currentUser: { username: 'pmc', name: 'PMC小张', role: 'admin', perms: {} },
        orders: [],
        products: [],
        transfers: [],
        productionPlans: [],
        productionReports: [],
        logs: [],
        renderContent: function () {},
        renderAll: function () {},
      },
      seed || {}
    )
  );
  return app;
}

/** 用生产 DB 层 + fetch 桩的沙箱（断言 HTTP 层「一次请求」） */
function prodApp(routes, seed) {
  const app = createApp({ installRecorder: false });
  const stub = createFetchStub(routes);
  app.setFetch(stub);
  app.setGlobals(
    Object.assign(
      {
        currentUser: { username: 'pmc', name: 'PMC小张', role: 'admin', perms: {} },
        authToken: 'tok-1',
        serverData: { orders: [], products: [], logs: [] },
        serverRevs: { orders: 1, products: 1, logs: 1 },
        orders: [],
        products: [],
        transfers: [],
        productionPlans: [],
        productionReports: [],
        logs: [],
        renderContent: function () {},
        renderAll: function () {},
      },
      seed || {}
    )
  );
  return { app: app, stub: stub };
}

function savedKeys(app) {
  return plain(app.recorder.of('save').map(function (c) {
    return c.key;
  }));
}

/* ================================================================
   幂等性：同一份文件导入两次
   ================================================================ */

test('导入幂等：同一份金蝶文件导入两次 → 订单不增生、产品不增生（第二次走覆盖）', async () => {
  const app = recApp({ orders: [], products: [] });

  /* 第一次：产品 P1 未知 → 决策「新建」 */
  const o1 = kdOrder('O-KD1', [kdItem('P1', 20, 0)]);
  app.setGlobals({
    kdReport: kdReport(o1, { pm: {}, unknown: [kdUnknown(0, o1, 0)] }),
    kdState: { unknown: { 0: '__NEW__' }, conflict: {} },
  });
  await app.run('kdDoImport()');

  assert.equal(await app.run('orders.length'), 1, '第一次导入生成 1 单');
  assert.equal(await app.run('products.length'), 1, '新建成品 1 个');
  assert.equal(app.recorder.txCount(), 1, '一次事务');
  assert.deepEqual(plain(app.recorder.lastTx().keys), ['products', 'orders'], '产品与订单同事务（无孤儿产品窗口）');

  /* 第二次：同一份文件（产品已存在）→ 覆盖，不得增生 */
  const o2 = kdOrder('O-KD1', [kdItem('P1', 20, 0)]);
  app.recorder.reset();
  app.setGlobals({
    kdReport: kdReport(o2, { pm: { P1: { id: 'P1', name: '甲', spec: '', model: '', unit: '台' } }, unknown: [] }),
    kdState: { unknown: {}, conflict: {} },
  });
  await app.run('kdDoImport()');

  assert.equal(await app.run('orders.length'), 1, '重复导入不得产生第二张订单');
  assert.equal(await app.run('products.length'), 1, '不得产生重复产品');
  assert.equal(app.recorder.txCount(), 1, '仍是一次事务');
  assert.deepEqual(plain(app.recorder.lastTx().keys), ['orders'], '产品未新建 → 不参与本次事务');
  /* 写入口总数 = 1 次 DB.tx + 1 次 logs（logOp 是设计授权的 best-effort 独立通道，silent 写）。
     关键：**事实表不得再有独立 save** —— 否则就是「拆成多次写」。 */
  assert.equal(app.recorder.writeCount(), 2, '1 次事务 + 1 次日志（无第三个写入口）');
  assert.deepEqual(savedKeys(app), ['logs'], '唯一的独立 save 只允许是 logs（事实表 orders/products 不得单独写）');
  assert.equal(
    savedKeys(app).filter(function (k) {
      return k === 'orders' || k === 'products';
    }).length,
    0,
    '事实表零独立写：重复导入同样走单次原子提交'
  );
  app.dispose();
});

test('导入幂等：三连导入仍只有一张订单（覆盖语义稳定，不累积）', async () => {
  const app = recApp({ orders: [], products: [] });
  const pmHost = function () {
    return { P1: { id: 'P1', name: '甲', spec: '', model: '', unit: '台' } };
  };

  /* 第一次新建产品 */
  const o0 = kdOrder('O-KD1', [kdItem('P1', 20, 0)]);
  app.setGlobals({
    kdReport: kdReport(o0, { pm: {}, unknown: [kdUnknown(0, o0, 0)] }),
    kdState: { unknown: { 0: '__NEW__' }, conflict: {} },
  });
  await app.run('kdDoImport()');

  for (let i = 0; i < 3; i++) {
    const o = kdOrder('O-KD1', [kdItem('P1', 20, 0)]);
    app.setGlobals({
      kdReport: kdReport(o, { pm: pmHost(), unknown: [] }),
      kdState: { unknown: {}, conflict: {} },
    });
    await app.run('kdDoImport()');
  }
  assert.equal(await app.run('orders.length'), 1, '四次导入后仍只有 1 单');
  assert.equal(await app.run('products.length'), 1, '产品也只有 1 个');
  app.dispose();
});

/* ================================================================
   覆盖保护：已取消 / 已暂停订单不可被导入复活
   ================================================================ */

test('导入覆盖保护：已取消订单不可被覆盖（防绕过状态机复活）', async () => {
  const app = recApp({
    orders: [{ id: 'O-KD1', orderType: '销售订单', status: '已取消', customer: '旧客户', contractNo: '', items: [kdItem('P1', 5, 0)] }],
    products: [{ id: 'P1', name: '甲', spec: '', model: '', unit: '台', stock: 0, status: '启用' }],
  });
  const o = kdOrder('O-KD1', [kdItem('P1', 20, 0)]);
  app.setGlobals({
    kdReport: kdReport(o, { pm: { P1: { id: 'P1', name: '甲' } }, unknown: [] }),
    kdState: { unknown: {}, conflict: {} },
  });
  await app.run('kdDoImport()');

  assert.equal(await app.run('orders.length'), 1, '未新增订单');
  assert.equal(await app.run('orders[0].status'), '已取消', '状态未被覆盖复活');
  assert.equal(await app.run('orders[0].customer'), '旧客户', '原单未被替换');
  assert.equal(
    app.alerts.some(function (m) {
      return m.indexOf('不可覆盖') >= 0;
    }),
    true,
    '提示中应说明跳过了不可覆盖的订单'
  );
  app.dispose();
});

test('导入覆盖保护：已暂停订单同样不可被覆盖', async () => {
  const app = recApp({
    orders: [{ id: 'O-KD1', orderType: '销售订单', status: '已暂停', customer: '旧客户', contractNo: '', items: [kdItem('P1', 5, 0)] }],
    products: [{ id: 'P1', name: '甲', spec: '', model: '', unit: '台', stock: 0, status: '启用' }],
  });
  const o = kdOrder('O-KD1', [kdItem('P1', 20, 0)]);
  app.setGlobals({
    kdReport: kdReport(o, { pm: { P1: { id: 'P1', name: '甲' } }, unknown: [] }),
    kdState: { unknown: {}, conflict: {} },
  });
  await app.run('kdDoImport()');
  assert.equal(await app.run('orders[0].status'), '已暂停', '已暂停不被覆盖');
  assert.equal(await app.run('orders.length'), 1);
  app.dispose();
});

/* ================================================================
   决策分支
   ================================================================ */

test('导入决策：未知产品未决策 → 拒绝导入且一字不写（不半途落数据）', async () => {
  const app = recApp({ orders: [], products: [] });
  const o = kdOrder('O-KD1', [kdItem('P1', 20, 0)]);
  app.setGlobals({
    kdReport: kdReport(o, { pm: {}, unknown: [kdUnknown(0, o, 0)] }),
    kdState: { unknown: {}, conflict: {} }, // 未决策
  });
  await app.run('kdDoImport()');

  assert.equal(app.recorder.writeCount(), 0, '未决策 → 拒不导入，零写盘');
  assert.equal(await app.run('orders.length'), 0);
  assert.equal(await app.run('products.length'), 0);
  assert.equal(
    app.alerts.some(function (m) {
      return m.indexOf('未决策') >= 0;
    }),
    true
  );
  app.dispose();
});

test('导入决策：未知产品选「忽视(__SKIP__)」→ 该明细被丢弃，整单无有效行则计为跳过', async () => {
  const app = recApp({ orders: [], products: [] });
  const o = kdOrder('O-KD1', [kdItem('P1', 20, 0)]);
  app.setGlobals({
    kdReport: kdReport(o, { pm: {}, unknown: [kdUnknown(0, o, 0)] }),
    kdState: { unknown: { 0: '__SKIP__' }, conflict: {} },
  });
  await app.run('kdDoImport()');

  assert.equal(await app.run('orders.length'), 0, '唯一明细被忽视 → 不生成订单');
  assert.equal(await app.run('products.length'), 0, '不新建产品');
  assert.equal(
    app.alerts.some(function (m) {
      return m.indexOf('跳过 1 单') >= 0;
    }),
    true,
    '提示应含「跳过 1 单」'
  );
  app.dispose();
});

test('导入决策：未知产品选「已有的产品编码」→ 行产品改写为所选 id，不新建产品', async () => {
  const app = recApp({ orders: [], products: [{ id: 'P9', name: '既有品', spec: '', model: '', unit: '台', stock: 0, status: '启用' }] });
  const o = kdOrder('O-KD1', [kdItem('P1', 20, 0)]);
  app.setGlobals({
    kdReport: kdReport(o, { pm: { P9: { id: 'P9', name: '既有品', spec: '', model: '', unit: '台' } }, unknown: [kdUnknown(0, o, 0)] }),
    kdState: { unknown: { 0: 'P9' }, conflict: {} },
  });
  await app.run('kdDoImport()');

  assert.equal(await app.run('orders[0].items[0].productId'), 'P9', '明细产品编码改写为所选既有产品');
  assert.equal(await app.run('products.length'), 1, '未新建产品');
  assert.deepEqual(plain(app.recorder.lastTx().keys), ['orders'], 'products 不参与本次事务');
  app.dispose();
});

test('导入决策：冲突订单选「跳过(skip)」→ 不导入该单', async () => {
  const app = recApp({ orders: [], products: [{ id: 'P1', name: '甲', spec: '', model: '', unit: '台', stock: 0, status: '启用' }] });
  const o = kdOrder('O-KD1', [kdItem('P1', 20, 0)]);
  app.setGlobals({
    kdReport: kdReport(o, { pm: { P1: { id: 'P1', name: '甲' } }, conflict: [{ idx: 0, id: 'O-KD1' }] }),
    kdState: { unknown: {}, conflict: { 0: 'skip' } },
  });
  await app.run('kdDoImport()');
  assert.equal(await app.run('orders.length'), 0, '跳过 → 不生成订单');
  app.dispose();
});

test('导入决策：冲突订单选「变更单号(rename)」→ 原单保留、生成不冲突的新单号', async () => {
  const app = recApp({
    orders: [{ id: 'O-KD1', orderType: '销售订单', status: '执行中', customer: '原客户', contractNo: '', items: [kdItem('P1', 5, 0)] }],
    products: [{ id: 'P1', name: '甲', spec: '', model: '', unit: '台', stock: 0, status: '启用' }],
  });
  const o = kdOrder('O-KD1', [kdItem('P1', 20, 0)]);
  app.setGlobals({
    kdReport: kdReport(o, { pm: { P1: { id: 'P1', name: '甲' } }, conflict: [{ idx: 0, id: 'O-KD1' }] }),
    kdState: { unknown: {}, conflict: { 0: 'rename' } },
  });
  await app.run('kdDoImport()');

  assert.equal(await app.run('orders.length'), 2, '原单保留 + 新单追加');
  assert.equal(await app.run('orders[0].id'), 'O-KD1', '原单未被删除');
  assert.equal(await app.run('orders[1].id'), 'O-KD1_2', '新单号 = kdRenameId 不冲突后缀');
  app.dispose();
});

test('导入决策：商品编码为空的行被跳过（不产生空产品行）', async () => {
  const app = recApp({ orders: [], products: [] });
  const o = kdOrder('O-KD1', [kdItem('', 20, 0)]);
  app.setGlobals({
    kdReport: kdReport(o, { pm: {}, unknown: [] }),
    kdState: { unknown: {}, conflict: {} },
  });
  await app.run('kdDoImport()');
  assert.equal(await app.run('orders.length'), 0, '全为空编码行 → 不生成订单');
  app.dispose();
});

/* ================================================================
   .130 导入口径：已交付数量不再导入
   （本节替换原 .108「落 directDelivered 期初基数」用例——口径已由用户拍板变更：
     Excel「已交付 / 已出库数量」仅进预检提示，不落库；directDelivered 不再写入）
   ================================================================ */

test('导入口径（.130）：Excel deliveredQty=5 → 落库恒为 0，且不落 directDelivered', async () => {
  const app = recApp({ orders: [], products: [{ id: 'P1', name: '甲', spec: '', model: '', unit: '台', stock: 0, status: '启用' }] });
  const o = kdOrder('O-KD1', [kdItem('P1', 20, 5)]);
  app.setGlobals({
    kdReport: kdReport(o, { pm: { P1: { id: 'P1', name: '甲' } }, unknown: [] }),
    kdState: { unknown: {}, conflict: {} },
  });
  await app.run('kdDoImport()');

  assert.equal(await app.run('orders[0].items[0].deliveredQty'), 0, '.130：已交付不导入 → 落库恒 0');
  assert.equal(await app.run('typeof orders[0].items[0].deliveredQty'), 'number', 'deliveredQty 字段必须保留（只改值，不删字段）');
  assert.equal(await app.run('orders[0].items[0].directDelivered'), undefined, '.130：不再写 directDelivered');
  app.dispose();
});

test('导入口径（.130）：原会落 directDelivered 的两类场景（无 / 有 calledQty）现在都不落', async () => {
  for (const extra of [{}, { calledQty: 2 }]) {
    const app = recApp({ orders: [], products: [{ id: 'P1', name: '甲', spec: '', model: '', unit: '台', stock: 0, status: '启用' }] });
    const o = kdOrder('O-KD1', [kdItem('P1', 20, 5, extra)]);
    app.setGlobals({
      kdReport: kdReport(o, { pm: { P1: { id: 'P1', name: '甲' } }, unknown: [] }),
      kdState: { unknown: {}, conflict: {} },
    });
    await app.run('kdDoImport()');
    const tag = 'calledQty=' + (extra.calledQty || 0);
    assert.equal(await app.run('orders[0].items[0].deliveredQty'), 0, '已交付恒 0（' + tag + '）');
    assert.equal(await app.run('orders[0].items[0].directDelivered'), undefined, 'directDelivered 不再出现（' + tag + '）');
    app.dispose();
  }
});

test('导入口径（.130）回归：orderQty / 产品主数据回填 / 行备注等其余字段不受影响', async () => {
  const app = recApp({ orders: [], products: [{ id: 'P1', name: '主数据名', spec: 'S1', model: 'M1', unit: '台', stock: 0, status: '启用' }] });
  const o = kdOrder('O-KD1', [kdItem('P1', 20, 5, { lineNotes: '急件' })]);
  app.setGlobals({
    kdReport: kdReport(o, { pm: { P1: { id: 'P1', name: '主数据名', spec: 'S1', model: 'M1', unit: '台' } }, unknown: [] }),
    kdState: { unknown: {}, conflict: {} },
  });
  await app.run('kdDoImport()');

  const it = plain(await app.run('orders[0].items[0]'));
  assert.equal(it.orderQty, 20, '数量照常导入');
  assert.equal(it.productName, '主数据名', '产品名称以主数据为准回填');
  assert.equal(it.spec, 'S1', '规格回填不变');
  assert.equal(it.model, 'M1', '型号回填不变');
  assert.equal(it.lineNotes, '急件', '行备注照常导入');
  assert.equal(it.stockMax, '', '销售订单 stockMax 仍为空串');
  assert.equal(it.stockMin, '', '销售订单 stockMin 仍为空串');
  assert.equal(Object.prototype.hasOwnProperty.call(it, 'directDelivered'), false, '落库对象不再带 directDelivered 键');
  app.dispose();
});

/* ================================================================
   预检提示（.130）：已交付数字仅进预检报告
   预检报告本身是 HTML 字符串 + showModal；沙箱里用 showModal 桩捕获字符串，
   即可对「提示文案」做断言（不依赖真实 DOM，见 README §5 不可测边界）
   ================================================================ */

/** 跑真实 kdPrecheckAndShow → 返回 kdShowReport 交给 showModal 的字符串 */
async function precheckBody(listFixture, pm, filename) {
  const app = createApp({ installRecorder: true });
  app.setGlobals({
    orders: [],
    products: [],
    renderContent: function () {},
    renderAll: function () {},
  });
  const cap = { title: '', body: '' };
  app.setGlobal('showModal', function (title, body) {
    cap.title = title;
    cap.body = body;
  });
  await app.run(
    'kdPrecheckAndShow(' + JSON.stringify(listFixture) + ',' + JSON.stringify(pm) + ',' + JSON.stringify(filename) + ',0)'
  );
  return { app: app, cap: cap };
}

test('预检提示（.130）：固定提示恒显示；有已交付行时追加汇总（行数 / 合计 / 涉及订单）', async () => {
  const o1 = kdOrder('O-KD1', [kdItem('P1', 20, 5), kdItem('P1', 10, 0)]);
  const o2 = kdOrder('O-KD2', [kdItem('P1', 8, 3)]);
  const r = await precheckBody([o1, o2], { P1: { id: 'P1', name: '甲' } }, 'kd-dv.xlsx');

  assert.match(r.cap.title, /金蝶订单导入/, '仍是金蝶预检报告弹窗');
  assert.match(r.cap.body, /已交付数量不导入系统/, '固定提示恒显示');
  assert.match(r.cap.body, /本次文件有 <b>2<\/b> 行明细带已交付数量（合计 <b>8<\/b>）/, '汇总受影响明细行数与合计数量');
  assert.match(r.cap.body, /涉及订单：O-KD1、O-KD2/, '列出涉及订单号（无已交付行的行不计入）');
  assert.match(r.cap.body, /金蝶已交付数量不导入系统/, '底部提示文案已随 .130 口径更新');
  assert.doesNotMatch(r.cap.body, /已交付数量 为空时按/, '旧文案「已交付数量 为空时按 0 导入」不得残留');
  r.app.dispose();
});

test('预检提示（.130）：涉及订单超过 10 张 → 只列前 10 个并追加「等 N 张」', async () => {
  const list = [];
  for (let i = 1; i <= 12; i++) list.push(kdOrder('O-KD' + i, [kdItem('P1', 20, i)]));
  const r = await precheckBody(list, { P1: { id: 'P1', name: '甲' } }, 'kd-many.xlsx');

  assert.match(r.cap.body, /涉及订单：O-KD1、O-KD2、O-KD3、O-KD4、O-KD5、O-KD6、O-KD7、O-KD8、O-KD9、O-KD10 等 12 张/, '最多列 10 个 + 「等 N 张」');
  assert.doesNotMatch(r.cap.body, /O-KD11/, '第 11 张之后不再逐个列出');
  r.app.dispose();
});

test('预检提示（.130）：本次文件无已交付行 → 仅固定提示，不出现汇总', async () => {
  const o1 = kdOrder('O-KD1', [kdItem('P1', 20, 0)]);
  const r = await precheckBody([o1], { P1: { id: 'P1', name: '甲' } }, 'kd-nodv.xlsx');

  assert.match(r.cap.body, /已交付数量不导入系统/, '固定提示仍在（与本次文件内容无关）');
  assert.doesNotMatch(r.cap.body, /行明细带已交付数量/, '无已交付行 → 不出汇总');
  r.app.dispose();
});

/* ================================================================
   失败路径与检索元数据
   ================================================================ */

test('导入失败（500）：只有一次 /api/tx、无第二次写请求、不弹「导入完成」', async () => {
  const fail500 = {
    '/api/tx': { status: 500, body: { error: '持久化失败' } },
    '/api/save': { status: 200, body: { ok: true, rev: 2 } },
    '/api/data': { status: 200, body: { data: { orders: [], products: [], logs: [] }, revs: { orders: 1, products: 1 } } },
  };
  const a = prodApp(fail500, { orders: [], products: [] });
  const o = kdOrder('O-KD1', [kdItem('P1', 20, 0)]);
  a.app.setGlobals({
    kdReport: kdReport(o, { pm: {}, unknown: [kdUnknown(0, o, 0)] }),
    kdState: { unknown: { 0: '__NEW__' }, conflict: {} },
  });
  await a.app.run('kdDoImport()');

  const txCalls = a.stub.callsTo('/api/tx');
  assert.equal(txCalls.length, 1, '整批只发一次 /api/tx（绝不拆分重发）');
  assert.deepEqual(plain(txCalls[0].body.ops.map(function (op) { return op.key; })), ['products', 'orders'], '一次请求携带两张表');
  const factWrites = a.stub.calls.filter(function (c) {
    return c.path === '/api/save' && ['orders', 'products'].indexOf(c.body && c.body.key) >= 0;
  });
  assert.deepEqual(plain(factWrites), [], '失败后不得再有事实表的独立 save（不出半状态）');
  assert.equal(
    a.app.alerts.some(function (m) {
      return m.indexOf('导入完成') >= 0;
    }),
    false,
    '失败时不得提示导入完成'
  );
  assert.equal(a.app.alerts.join('\n').indexOf('500') >= 0, true, '应提示 500');
  a.app.dispose();
});

test('导入元数据：订单带 src/srcFile；成功日志汇总单数/行数/新建产品数', async () => {
  const app = recApp({ orders: [], products: [] });
  const o = kdOrder('O-KD1', [kdItem('P1', 20, 0)]);
  app.setGlobals({
    kdReport: kdReport(o, { pm: {}, unknown: [kdUnknown(0, o, 0)], filename: 'kd-meta.xlsx' }),
    kdState: { unknown: { 0: '__NEW__' }, conflict: {} },
  });
  await app.run('kdDoImport()');

  assert.equal(await app.run('orders[0].src'), 'kingdee', '来源标记');
  assert.equal(await app.run('orders[0].srcFile'), 'kd-meta.xlsx', '来源文件名');
  assert.equal(await app.run('orders[0].orderType'), '销售订单', '金蝶导入恒为销售订单');
  assert.equal(await app.run('orders[0].status'), '执行中', '审核状态默认执行中');

  const logs = plain(app.getGlobal('logs'));
  assert.equal(logs.length, 1, '记 1 条操作日志');
  assert.equal(logs[0].action, '导入');
  assert.equal(logs[0].target, '订单管理');
  assert.match(logs[0].detail, /1 单 \/ 1 行/, '汇总单数/行数');
  assert.match(logs[0].detail, /新建产品 1 个/, '汇总新建产品数');
  assert.match(logs[0].detail, /kd-meta\.xlsx/, '带来源文件名');
  app.dispose();
});

test('导入元数据：导入完成后清空 kdReport/kdState（防同一份报告被二次确认）', async () => {
  const app = recApp({ orders: [], products: [] });
  const o = kdOrder('O-KD1', [kdItem('P1', 20, 0)]);
  app.setGlobals({
    kdReport: kdReport(o, { pm: {}, unknown: [kdUnknown(0, o, 0)] }),
    kdState: { unknown: { 0: '__NEW__' }, conflict: {} },
  });
  await app.run('kdDoImport()');
  assert.equal(await app.run('kdReport'), null, '成功后置空');
  assert.equal(await app.run('kdState'), null);

  /* 已置空 → 再点一次确认应直接 return（不再重复导入） */
  app.recorder.reset();
  await app.run('kdDoImport()');
  assert.equal(app.recorder.writeCount(), 0, 'kdReport 已空 → 二次确认零写');
  assert.equal(await app.run('orders.length'), 1, '订单数不变');
  app.dispose();
});

test('导入元数据：无 kdReport 时直接 return（不抛、不写）', async () => {
  const app = recApp({ orders: [], products: [] });
  app.setGlobals({ kdReport: null, kdState: null });
  await app.run('kdDoImport()');
  assert.equal(app.recorder.writeCount(), 0);
  app.dispose();
});
