'use strict';
/* ================================================================
   tests/write-points.test.js —— T03 三个写入点的「一次 /api/tx」不变式
   ================================================================
   依据：docs/P1地基轮设计-2026-09-11.md §4.1 调拨 / §4.2 金蝶导入 / §4.3 报工族 / §4.5
   核心判据（INV-NEW-1/2）：
     · 每个写入点**恰好一次** DB.tx（recorder.txCount()===1），不得再有多次独立 save
     · 事实表（transfers / productionReports / orders）**必然**在事务内
     · 派生投影 products **仅在真有变化时**作为伴随 op
     · tx 失败 → 返回 false、只有一次 /api/tx 请求（不得出现「写了一半」的第二次请求）
   边界：不解析真实 xlsx（直接预置 kdReport/kdState）；不测 DOM 渲染（renderContent 打桩）。
   运行：node --test（**不要用 node -e**，见 README「执行环境限定」）
   ================================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('./harness/sandbox');
const { createFetchStub } = require('./harness/dom-stub');

function plain(v) {
  return JSON.parse(JSON.stringify(v));
}
function j(v) {
  return JSON.stringify(v);
}

const ADMIN = { username: 'pmc', name: 'PMC小张', role: 'admin', perms: {} };

/* ---------------- 夹具 ---------------- */

/** 库存订单 O-INV（行 0：P1 已交付 10）+ 销售订单 O-SALE（行 0：P1 已调用 3） */
function fixtureOrders() {
  return [
    {
      id: 'O-INV',
      orderType: '库存订单',
      customer: '成品仓',
      contractNo: '',
      status: '执行中',
      items: [
        { productId: 'P1', productName: '甲', spec: '', model: '', orderQty: 100, deliveredQty: 10, stockMax: '', stockMin: '' },
      ],
    },
    {
      id: 'O-SALE',
      orderType: '销售订单',
      customer: '华东盘厂',
      contractNo: 'HT1',
      status: '执行中',
      items: [{ productId: 'P1', productName: '甲', spec: '', model: '', orderQty: 50, deliveredQty: 0, calledQty: 3 }],
    },
  ];
}

/** 库存与库存订单已交付一致（stock=10），避免无关的投影扰动 */
function fixtureProducts(stock) {
  return [{ id: 'P1', name: '甲', spec: '', model: '', unit: '台', stock: stock, dailyCap: 0, status: '启用' }];
}

/** 排产单 PP1（独立单，deliveryIdx=null）：入库工序待报 */
function fixturePlan(orderId, status, inboundDone) {
  return {
    id: 'PP1',
    orderId: orderId,
    deliveryIdx: null,
    customer: '成品仓',
    planDate: '2026-09-11',
    finalDate: '2026-09-11',
    status: status,
    items: [
      {
        productId: 'P1',
        productName: '甲',
        spec: '',
        model: '',
        unit: '台',
        planQty: 10,
        doneQty: inboundDone,
        dlLine: null,
        steps: {
          assembly: { plan: 10, done: 0 },
          instant: { plan: 10, done: 0 },
          delay: { plan: 10, done: 0 },
          innerPack: { plan: 10, done: 0 },
          aging: { plan: 10, done: 0 },
          inbound: inboundDone,
        },
      },
    ],
  };
}

function fixtureReport(qty) {
  return {
    id: 'REP-1',
    planId: 'PP1',
    date: '2026-09-11',
    time: '09:00',
    worker: '张三',
    createdAt: '2026-09-11T01:00:00.000Z',
    items: [{ productId: 'P1', productName: '甲', step: 'inbound', label: '入库', qty: qty, dlLine: null }],
  };
}

/** 带记录器的沙箱（断言写集用） */
function recApp(seed) {
  const app = createApp({ installRecorder: true });
  app.setGlobals(
    Object.assign(
      {
        currentUser: ADMIN,
        orders: fixtureOrders(),
        products: fixtureProducts(10),
        transfers: [],
        productionPlans: [],
        productionReports: [],
        processTemplates: [],
        deliveries: [],
        logs: [],
        renderContent: function () {},
        renderAll: function () {},
      },
      seed || {}
    )
  );
  return app;
}

/** 用**生产** DB 层 + fetch 桩的沙箱（断言 HTTP 层「一次请求」用） */
function prodApp(routes, seed) {
  const app = createApp({ installRecorder: false });
  const stub = createFetchStub(routes);
  app.setFetch(stub);
  app.setGlobals(
    Object.assign(
      {
        currentUser: ADMIN,
        authToken: 'tok-1',
        serverData: { orders: [], transfers: [], products: [], logs: [] },
        serverRevs: { orders: 1, transfers: 1, products: 1, logs: 1 },
        orders: fixtureOrders(),
        products: fixtureProducts(10),
        transfers: [],
        productionPlans: [],
        productionReports: [],
        processTemplates: [],
        deliveries: [],
        logs: [],
        renderContent: function () {},
        renderAll: function () {},
      },
      seed || {}
    )
  );
  return { app, stub };
}

const okRoutes = {
  '/api/tx': { status: 200, body: { ok: true, revs: { orders: 2, transfers: 2, products: 2 } } },
  '/api/save': { status: 200, body: { ok: true, rev: 2 } },
  '/api/data': { status: 200, body: { data: {}, revs: {} } },
};
const fail500Routes = {
  '/api/tx': { status: 500, body: { error: '持久化失败' } },
  '/api/save': { status: 200, body: { ok: true, rev: 2 } },
  '/api/data': {
    status: 200,
    body: { data: { orders: fixtureOrders(), transfers: [], products: fixtureProducts(10), logs: [] }, revs: { orders: 1, transfers: 1, products: 1 } },
  },
};

/* ================================================================
   ① 调拨（js/transfer.js applyTransfers）
   ================================================================ */

test('① 调拨：一次 DB.tx 提交 [orders, transfers, products]；数量口径不变（库存可负）', async () => {
  const app = recApp();
  const moves = [{ out: { orderId: 'O-INV', orderType: 'inv', lineIdx: 0 }, in: { orderId: 'O-SALE', orderType: 'sales', lineIdx: 0 }, qty: 15 }];
  const ok = await app.run('applyTransfers("call",' + j(moves) + ')');

  assert.equal(ok, true, 'applyTransfers 应返回 true（整批落盘）');
  assert.equal(app.recorder.txCount(), 1, '恰好一次事务');
  assert.equal(app.recorder.writeCount(), 1, '不得再出现任何独立 save/DB.set');
  assert.deepEqual(plain(app.recorder.lastTx().keys), ['orders', 'transfers', 'products']);

  /* 业务口径零改动（§4.1 前置校验 + 数量规则） */
  assert.equal(await app.run('orders[0].items[0].deliveredQty'), -5, '库存订单已交付可负（欠货）');
  assert.equal(await app.run('orders[1].items[0].calledQty'), 18, '销售订单 calledQty += qty');
  assert.equal(await app.run('products[0].stock'), -5, '库存投影 = Σ库存订单已交付');
  assert.equal(await app.run('transfers.length'), 1, '台账新增 1 条');
  assert.equal(await app.run('transfers[0].type'), 'call');
  assert.equal(await app.run('transfers[0].outOrderType'), 'inv');
  assert.equal(await app.run('transfers[0].inOrderType'), 'sales');
  assert.equal(await app.run('transfers[0].user'), 'PMC小张', '台账操作人取 currentUser.name');
});

test('① 调拨：投影无变化时 products 不进入事务（仅 [orders, transfers]）', async () => {
  /* products 为空 → 库存投影没有任何行可改 → stockChanged=false */
  const app = recApp({ products: [] });
  const moves = [{ out: { orderId: 'O-INV', orderType: 'inv', lineIdx: 0 }, in: { orderId: 'O-SALE', orderType: 'sales', lineIdx: 0 }, qty: 4 }];
  assert.equal(await app.run('applyTransfers("call",' + j(moves) + ')'), true);
  assert.equal(app.recorder.txCount(), 1);
  assert.deepEqual(plain(app.recorder.lastTx().keys), ['orders', 'transfers']);
});

test('① 调拨：前置校验失败 → 返回 false 且**零写**（不碰任何表）', async () => {
  const app = recApp();
  const moves = [{ out: { orderId: 'NO-SUCH', orderType: 'inv', lineIdx: 0 }, in: { orderId: 'O-SALE', orderType: 'sales', lineIdx: 0 }, qty: 1 }];
  assert.equal(await app.run('applyTransfers("call",' + j(moves) + ')'), false);
  assert.equal(app.recorder.writeCount(), 0, '校验失败必须一字不写');
  assert.equal(await app.run('orders[0].items[0].deliveredQty'), 10, '内存也不得被改');
});

test('① 调拨：tx 失败（500）→ 返回 false、只有一次 /api/tx、无第二次写请求（不出半状态）', async () => {
  const { app, stub } = prodApp(fail500Routes);
  const moves = [{ out: { orderId: 'O-INV', orderType: 'inv', lineIdx: 0 }, in: { orderId: 'O-SALE', orderType: 'sales', lineIdx: 0 }, qty: 15 }];
  const ok = await app.run('applyTransfers("call",' + j(moves) + ')');

  assert.equal(ok, false, '任一步失败必须返回 false');
  const txCalls = stub.callsTo('/api/tx');
  assert.equal(txCalls.length, 1, '整批只发一次 /api/tx（绝不拆分重发）');
  /* 这一次请求必须携带全部三个 op —— 证明没有「先写 orders 再写台账」的分步提交 */
  assert.deepEqual(plain(txCalls[0].body.ops.map((o) => o.key)), ['orders', 'transfers', 'products']);
  /* 失败后除 pullAll(/api/data) 与 best-effort 的 logs 外，不得再写事实表 */
  const factWrites = stub.calls.filter(
    (c) => c.path === '/api/save' && ['orders', 'transfers', 'products'].indexOf(c.body && c.body.key) >= 0
  );
  assert.deepEqual(plain(factWrites), [], '失败后不得再有事实表的独立 save');
  /* 设计 §4.1 ⑤：applyTransfers 用 silent=true，提示由**调用方**负责（doCallStock 等会调 alertTransferFailed） */
  assert.equal(app.alerts.length, 0, 'applyTransfers 自身静默（避免双重提示）');
  app.run('alertTransferFailed()');
  assert.equal(app.alerts.length, 1);
  assert.match(app.alerts[0], /整体未生效/);
  /* 残留风险（已在 README 登记）：DB.tx 的 pullAll 只刷新 serverData / serverRevs 缓存，
     并**不**回灌业务内存全局（orders 等仅在 initApp 里由 DB.get 水合）。
     故失败后内存仍是「乐观变更」值（10-15=-5），须靠 F5 / 下一次进页面重置。 */
  assert.equal(await app.run('orders[0].items[0].deliveredQty'), -5, '内存：乐观变更残留（prompt 用户刷新）');
  assert.equal(
    await app.run('serverData.orders[0].items[0].deliveredQty'),
    10,
    '缓存：pullAll 已刷成服务器真值（供刷新后渲染一致）'
  );
});

test('① 调拨：静默失败由调用方统一提示（alertTransferFailed 存在且不重复写）', async () => {
  const app = recApp();
  assert.equal(typeof app.getGlobal('alertTransferFailed'), 'function');
  app.recorder.setResult('tx', false);
  const moves = [{ out: { orderId: 'O-INV', orderType: 'inv', lineIdx: 0 }, in: { orderId: 'O-SALE', orderType: 'sales', lineIdx: 0 }, qty: 1 }];
  assert.equal(await app.run('applyTransfers("call",' + j(moves) + ')'), false);
  assert.equal(app.recorder.txCount(), 1, '失败也不得退化为多次独立写');
});

/* ================================================================
   ② 金蝶导入（js/import.js kdDoImport）
   ================================================================ */

function kdFixture(pm) {
  return {
    filename: 'kd-test.xlsx',
    totalOrders: 1,
    pm: pm,
    list: [
      {
        id: 'O-KD1',
        customer: '金蝶客户',
        startDate: '2026-09-01',
        deadline: '2026-10-01',
        contractNo: 'HT9',
        items: [{ productId: 'P1', productName: '甲', spec: '', model: '', unit: '台', orderQty: 20, deliveredQty: 0, lineNotes: '' }],
      },
    ],
    unknown: [],
    conflict: [],
  };
}

test('② 金蝶导入（已有产品）：一次 DB.tx 只含 [orders]（products 不参与）', async () => {
  const app = recApp({ orders: [], products: [] });
  app.setGlobals({ kdReport: kdFixture({ P1: { id: 'P1', name: '甲', spec: '', model: '', unit: '台' } }), kdState: { unknown: {}, conflict: {} } });
  await app.run('kdDoImport()');
  assert.equal(app.recorder.txCount(), 1, '恰好一次事务');
  assert.deepEqual(plain(app.recorder.lastTx().keys), ['orders']);
  assert.equal(await app.run('orders.length'), 1);
  assert.equal(await app.run('orders[0].id'), 'O-KD1');
  assert.equal(await app.run('orders[0].src'), 'kingdee');
});

test('② 金蝶导入（新建产品）：一次 DB.tx 提交 [products, orders]（不再有孤儿产品窗口）', async () => {
  const app = recApp({ orders: [], products: [] });
  app.setGlobals({ kdReport: kdFixture({}), kdState: { unknown: {}, conflict: {} } });
  await app.run('kdDoImport()');
  assert.equal(app.recorder.txCount(), 1);
  assert.deepEqual(plain(app.recorder.lastTx().keys), ['products', 'orders'], '新建成品主数据=事实，必须与 orders 同事务');
  assert.equal(await app.run('products.length'), 1);
  assert.equal(await app.run('products[0].id'), 'P1');
  assert.equal(await app.run('products[0].stock'), 0);
  assert.equal(await app.run('orders.length'), 1);
});

test('② 金蝶导入：tx 失败 → 返回前中止（不弹「导入完成」、无第二次写请求）', async () => {
  const { app, stub } = prodApp(fail500Routes, { orders: [], products: [] });
  app.setGlobals({ kdReport: kdFixture({}), kdState: { unknown: {}, conflict: {} } });
  await app.run('kdDoImport()');
  assert.equal(stub.callsTo('/api/tx').length, 1);
  const writes = stub.calls.filter(
    (c) => c.path === '/api/save' && ['orders', 'products'].indexOf(c.body && c.body.key) >= 0
  );
  assert.deepEqual(plain(writes), [], '失败后不得再有 orders/products 的独立 save');
  assert.equal(
    app.alerts.some((m) => m.indexOf('导入完成') >= 0),
    false,
    '失败时不得提示导入完成'
  );
  assert.equal(app.alerts.join('\n').includes('500'), true);
});

/* ================================================================
   ③ 报工族（index.html：applyReport / ppSaveReportEdits / ppDelReport）
   ================================================================ */

test('③ 报工：一次 DB.tx 提交 [productionPlans, productionReports, orders, products]', async () => {
  const app = recApp({ productionPlans: [fixturePlan('O-INV', '待排产', 0)] });
  await app.run('applyReport(0, [{li:0,step:"inbound",qty:5}], ppItems(productionPlans[0]), "张三")');

  assert.equal(app.recorder.txCount(), 1, '一次报工 = 一次事务（改造前 ≥5 次独立写）');
  assert.deepEqual(plain(app.recorder.lastTx().keys), [
    'productionPlans',
    'productionReports',
    'orders',
    'products',
  ]);
  /* 业务口径不变 */
  assert.equal(await app.run('productionPlans[0].status'), '生产中', '待排产 → 生产中');
  assert.equal(await app.run('productionPlans[0].items[0].steps.inbound'), 5);
  assert.equal(await app.run('productionPlans[0].items[0].doneQty'), 5);
  assert.equal(await app.run('productionReports.length'), 1, '报工明细 1 条');
  assert.equal(await app.run('productionReports[0].items[0].qty'), 5);
  assert.equal(await app.run('orders[0].items[0].deliveredQty'), 15, '入库回写库存订单已交付 +5');
  assert.equal(await app.run('products[0].stock'), 15, '库存投影跟随');
});

test('③ 报工：非库存订单/无入库 → orders 与 products 都不进入事务', async () => {
  /* 销售订单：writebackInboundMutation 口径不变地返回 false；products 为空故投影无变化 */
  const app = recApp({ orders: fixtureOrders(), products: [], productionPlans: [fixturePlan('O-SALE', '生产中', 0)] });
  await app.run('applyReport(0, [{li:0,step:"inbound",qty:5}], ppItems(productionPlans[0]), "张三")');
  assert.equal(app.recorder.txCount(), 1);
  assert.deepEqual(plain(app.recorder.lastTx().keys), ['productionPlans', 'productionReports']);
  assert.equal(await app.run('orders[1].items[0].deliveredQty'), 0, '销售订单已交付不由报工回写（.97 口径）');
});

test('③ 编辑报工：一次 DB.tx 提交 [productionPlans, productionReports]', async () => {
  const app = recApp({
    productionPlans: [fixturePlan('O-INV', '生产中', 5)],
    productionReports: [fixtureReport(5)],
  });
  /* DOM 读取（rp_w_0 / rp_q_0_0）在桩下取 null → 保留原数量；此处只断言「写集恰好一次事务」 */
  await app.run('ppSaveReportEdits("PP1")');
  assert.equal(app.recorder.txCount(), 1, '编辑报工 = 一次事务');
  assert.deepEqual(plain(app.recorder.lastTx().keys), ['productionPlans', 'productionReports']);
  assert.equal(await app.run('productionReports.length'), 1);
  assert.equal(await app.run('productionReports[0].items[0].qty'), 5, '数量未被 DOM 桩改坏');
});

test('③ 删除报工：一次 DB.tx 提交 [productionPlans, productionReports, orders, products]', async () => {
  const app = recApp({
    productionPlans: [fixturePlan('O-INV', '生产中', 5)],
    productionReports: [fixtureReport(5)],
    orders: (function () {
      const o = fixtureOrders();
      o[0].items[0].deliveredQty = 15;
      return o;
    })(),
    products: fixtureProducts(15),
  });
  await app.run('ppDelReport("REP-1")');
  assert.equal(app.recorder.txCount(), 1, '删除报工 = 一次事务');
  assert.deepEqual(plain(app.recorder.lastTx().keys), [
    'productionPlans',
    'productionReports',
    'orders',
    'products',
  ]);
  assert.equal(await app.run('productionReports.length'), 0, '明细已删');
  assert.equal(await app.run('productionPlans[0].items[0].doneQty'), 0, '累计已回退');
  assert.equal(await app.run('orders[0].items[0].deliveredQty'), 10, '已交付扣回');
  assert.equal(await app.run('products[0].stock'), 10);
});

test('③ 报工：tx 失败（500）→ 返回 false、只有一次 /api/tx、无第二次写请求', async () => {
  const { app, stub } = prodApp(fail500Routes, { productionPlans: [fixturePlan('O-INV', '待排产', 0)] });
  await app.run('applyReport(0, [{li:0,step:"inbound",qty:5}], ppItems(productionPlans[0]), "张三")');
  const txCalls = stub.callsTo('/api/tx');
  assert.equal(txCalls.length, 1, '三次表写必须合并为一次请求');
  assert.deepEqual(plain(txCalls[0].body.ops.map((o) => o.key)), [
    'productionPlans',
    'productionReports',
    'orders',
    'products',
  ]);
  const writes = stub.calls.filter(
    (c) =>
      c.path === '/api/save' &&
      ['productionPlans', 'productionReports', 'orders', 'products'].indexOf(c.body && c.body.key) >= 0
  );
  assert.deepEqual(plain(writes), [], '失败后不得再有事实表的独立 save');
  assert.equal(app.alerts.join('\n').includes('500'), true);
});

/* ================================================================
   ④ 兼容包装回归（本轮**不迁移**的调用点必须照旧可用）
   ================================================================ */

test('④ writebackInbound 旧名仍可用（saveProdPlan/delProdPlan 依赖）；仍是非事务的 2 次独立写', async () => {
  const app = recApp();
  await app.run('writebackInbound("O-INV","P1",5,null)');
  assert.equal(await app.run('orders[0].items[0].deliveredQty'), 15, '回写口径不变');
  assert.equal(await app.run('products[0].stock'), 15, '投影跟随');
  assert.equal(app.recorder.txCount(), 0, '旧路径本轮不迁移：仍走 save（非事务），这是设计登记在案的残余风险');
  assert.deepEqual(
    plain(app.recorder.of('save').map((c) => c.key)),
    ['orders', 'products', 'logs'],
    '旧路径 = save(orders) + save(products) + 日志（C2：saveProdPlan/delProdPlan 下一轮迁移）'
  );
  /* writebackInboundMutation 是纯函数：不写盘 */
  app.recorder.reset();
  assert.equal(await app.run('writebackInboundMutation("O-INV","P1",1,null)'), true);
  assert.equal(app.recorder.writeCount(), 0, '纯变更器绝不写盘');
  assert.equal(await app.run('orders[0].items[0].deliveredQty'), 16);
});

test('④ 投影函数已是纯重算：recompute* 只改内存，sync* 兼容包装照旧落盘', async () => {
  const app = recApp();

  /* --- 纯重算：只改内存、零写盘、幂等 --- */
  app.recorder.reset();
  assert.equal(await app.run('recomputeStockFromInvOrders()'), false, '无变化 → false');
  assert.equal(app.recorder.writeCount(), 0, '纯重算不写盘');
  await app.run('orders[0].items[0].deliveredQty=99;');
  assert.equal(await app.run('recomputeStockFromInvOrders()'), true, '投影变化 → true');
  assert.equal(app.recorder.writeCount(), 0, 'recompute 仍不写盘');
  assert.equal(await app.run('products[0].stock'), 99, '内存已重算');
  assert.equal(await app.run('recomputeStockFromInvOrders()'), false, '再算一次无变化 → false（幂等）');

  /* --- 兼容包装 syncStockFromInvOrders：把脏内存落盘 products --- */
  app.recorder.reset();
  await app.run('orders[0].items[0].deliveredQty=88; syncStockFromInvOrders();');
  assert.equal(await app.run('products[0].stock'), 88);
  assert.deepEqual(plain(app.recorder.of('save').map((c) => c.key)), ['products']);

  /* --- recomputeOrderAutoStatus：纯（只改内存 + 独立 logs），orders 由调用方落盘 --- */
  app.recorder.reset();
  await app.run('orders[1].items[0].deliveredQty=50;'); /* 销售整单未交付=0 → 应自动「已完成」 */
  assert.equal(await app.run('recomputeOrderAutoStatus()'), 1);
  assert.equal(await app.run('orders[1].status'), '已完成');
  assert.equal(app.recorder.txCount(), 0);
  assert.equal(
    plain(app.recorder.of('save').every((c) => c.key === 'logs')),
    true,
    'recomputeOrderAutoStatus 本身不写 orders（状态由调用方并入同一 tx）'
  );

  /* --- 兼容包装 syncOrderAutoStatus：变化时落盘 orders（日志由 recompute 先发，两表互不影响） --- */
  app.recorder.reset();
  await app.run('orders[1].status="执行中"; syncOrderAutoStatus();');
  assert.deepEqual(plain(app.recorder.of('save').map((c) => c.key)), ['logs', 'orders']);
  assert.equal(await app.run('orders[1].status'), '已完成');
});
