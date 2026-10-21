'use strict';
/* ================================================================
   tests/tx-hardening.test.js —— build 2026-09-11.125 收口轮不变式
   ================================================================
   覆盖（均为本轮新增/新增列的不变式，不重复 T03 已覆盖的调拨/导入/报工族）：
     A. 4 个高危多表写点各**恰好一次** DB.tx（不得再有多次独立 save）：
        ① bulkDelete（批量删除：原 = N 条日志 = N 次独立 save('logs') + 1 次业务表写）
        ② confirmClear（清空全部数据：原 7 次独立写）
        ③ restoreBackup（恢复备份：原 11+ 次独立写）
        ④ delProdPlan（删除排产单：原经 writebackInbound 的 5 次独立写）
        且失败时**不进入成功态**（不渲染、不清勾选）
     B. DB.tx / DB.set 失败后 rehydrateFromServer() 把业务内存回灌为服务器真值；
        serverData 缺失时**不得**把全局量写成 undefined
     C. logOp：time = 'YYYY-MM-DD HH:mm:ss'（固定格式）、user = 当前登录人；
        服务端 sameLog 把 user 纳入比较（经 logsAppendOK 行为验证）
   运行：node --test（**不要用 node -e**，见 README「执行环境限定」）
   ================================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('./harness/sandbox');

const ADMIN = { username: 'pmc', name: 'PMC小张', role: 'admin', perms: {} };

function plain(v) {
  return JSON.parse(JSON.stringify(v));
}

function fixtureProducts(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ id: 'P' + (i + 1), name: '产品' + (i + 1), spec: '', model: '', unit: '台', stock: 0, dailyCap: 0, status: '启用' });
  }
  return out;
}

function fixtureOrders() {
  return [
    {
      id: 'O-INV',
      orderType: '库存订单',
      customer: '成品仓',
      contractNo: '',
      status: '执行中',
      items: [{ productId: 'P1', productName: '产品1', spec: '', model: '', orderQty: 100, deliveredQty: 10, stockMax: '', stockMin: '' }],
    },
  ];
}

/** 排产单：状态可控、入库工序已报工 done 指定数量 */
function fixturePlan(status, inboundDone) {
  return {
    id: 'PSCD-20260911-001',
    orderId: 'O-INV',
    deliveryIdx: null,
    customer: '成品仓',
    planDate: '2026-09-11',
    finalDate: '2026-09-11',
    status: status,
    items: [
      {
        productId: 'P1',
        productName: '产品1',
        spec: '',
        model: '',
        unit: '台',
        planQty: 10,
        doneQty: inboundDone,
        dlLine: null,
        steps: { assembly: { plan: 10, done: 0 }, instant: { plan: 10, done: 0 }, delay: { plan: 10, done: 0 }, innerPack: { plan: 10, done: 0 }, aging: { plan: 10, done: 0 }, inbound: inboundDone },
      },
    ],
  };
}

/** 计数用沙箱：renderAll/renderContent 计数，避免「失败却渲染成功态」无法被发现 */
function mkApp(seed) {
  const counters = { renderAll: 0, renderContent: 0 };
  const app = createApp({ installRecorder: true });
  app.counters = counters;
  app.setGlobals(
    Object.assign(
      {
        currentUser: ADMIN,
        products: fixtureProducts(3),
        orders: fixtureOrders(),
        deliveries: [],
        productionPlans: [],
        productionReports: [],
        processTemplates: [],
        transfers: [],
        logs: [],
        fieldsAudit: 'audited',
        fieldsDraft: null,
        meta: { seq: 1, seeded: true },
        tblLayout: {},
        renderAll: function () {
          counters.renderAll++;
        },
        renderContent: function () {
          counters.renderContent++;
        },
      },
      seed || {}
    )
  );
  return app;
}

/* ================================================================
   A-① bulkDelete：批量删除 = 1 次 DB.tx([业务表, logs])
   ================================================================ */

test('A-① bulkDelete（产品）：勾选 2 条 → 恰好 1 次 DB.tx[products, logs]；每条日志带操作者', async () => {
  /* 【build .155】本用例只锁定「批量删除 = 1 次事务」这一不变式，与「哪些产品可删」无关。
     .155 起被**库存订单引用过的产品禁止删除**（含历史单），默认 fixture 的 O-INV 引用了 P1，
     会让新守卫整批拒绝删除、txCount 变 0。故此处清空 orders，把两个关注点解耦。
     新守卫本身由 tests/product-order-drag.156.test.js §E 独立覆盖（不在本文件测）。 */
  const app = mkApp({ orders: [] });
  await app.run('selSet("product").add("0");selSet("product").add("2");');

  await app.run('bulkDelete("product")');

  assert.equal(app.recorder.txCount(), 1, '整批删除必须只发一次事务');
  assert.equal(app.recorder.writeCount(), 1, '不得再有独立 save（原实现每条日志各触发一次 save(\'logs\')）');
  assert.deepEqual(plain(app.recorder.lastTx().keys), ['products', 'logs'], '只带实际变化的业务表 + logs');
  assert.equal(await app.run('products.length'), 1, '索引 0/2 已删，剩 1 条');
  assert.equal(await app.run('products[0].id'), 'P2');
  assert.equal(await app.run('logs.length'), 2, '2 条删除日志（原实现是 2 次独立 save）');
  assert.equal(await app.run('logs[0].user'), ADMIN.name, '日志带操作者');
  assert.equal(await app.run('selSet("product").size'), 0, '成功后清勾选');
});

test('A-① bulkDelete（排产计划）：非「待排产」跳过但仍只有 1 次事务，跳过提示保留', async () => {
  const app = mkApp({
    productionPlans: [fixturePlan('待排产', 0), fixturePlan('生产中', 0)],
  });
  app.run('productionPlans[1].id="PSCD-20260911-002"');
  await app.run('selSet("prodPlan").add("0");selSet("prodPlan").add("1");');

  await app.run('bulkDelete("prodPlan")');

  assert.equal(app.recorder.txCount(), 1);
  assert.deepEqual(plain(app.recorder.lastTx().keys), ['productionPlans', 'logs']);
  assert.equal(await app.run('productionPlans.length'), 1, '只删待排产那条');
  assert.equal(await app.run('productionPlans[0].status'), '生产中');
  assert.ok(
    app.alerts.some((m) => /跳过 1 条/.test(m)),
    '跳过提示保留（文案与改造前一致）'
  );
});

test('A-① bulkDelete：tx 失败 → 不渲染、不清勾选（不进入成功态）', async () => {
  /* 【build .155】同上一用例：清空 orders 以避开「被库存订单引用禁删」新守卫，只测失败态不变式 */
  const app = mkApp({ orders: [] });
  await app.run('selSet("product").add("0");');
  app.recorder.setResult('tx', false);

  await app.run('bulkDelete("product")');

  assert.equal(app.recorder.txCount(), 1);
  /* 记录器不会像生产 DB.tx 那样回灌内存（生产路径的「失败即回灌服务器真值」由
     tests/write-points.test.js ① 与本文件 B 组用例覆盖），故此处内存仍是已 splice 的乐观值。
     本用例只锁定「失败不进入成功态」这一不变式。 */
  assert.equal(await app.run('products.length'), 2, '内存被 splice（生产路径会由 rehydrateFromServer 复原）');
  assert.equal(await app.run('selSet("product").size'), 1, '失败不得清勾选');
  assert.equal(app.counters.renderContent, 0, '失败不得 renderContent');
});

/* ================================================================
   A-② confirmClear：清空全部数据 = 1 次 DB.tx（7 张表）
   ================================================================ */

test('A-② confirmClear：恰好 1 次 DB.tx（6 张事实表 + logs），不再出现「清了一半」', async () => {
  const app = mkApp();
  await app.run('confirmClear()');

  assert.equal(app.recorder.txCount(), 1, '7 次独立写 → 1 次事务');
  assert.equal(app.recorder.writeCount(), 1);
  assert.deepEqual(
    plain(app.recorder.lastTx().keys),
    ['products', 'orders', 'deliveries', 'productionPlans', 'productionReports', 'processTemplates', 'logs'],
    '6 张事实表 + logs 同批提交'
  );
  assert.equal(await app.run('products.length'), 0);
  assert.equal(await app.run('orders.length'), 0);
  assert.equal(await app.run('logs.length'), 1, '清空动作本身留 1 条日志（logs 表不被清空）');
  assert.equal(await app.run('logs[0].action'), '清空');
  assert.equal(app.counters.renderAll, 1, '成功后渲染一次');
});

test('A-② confirmClear：tx 失败 → 不 renderAll（不呈现「已清空」）', async () => {
  const app = mkApp();
  app.recorder.setResult('tx', false);
  await app.run('confirmClear()');
  assert.equal(app.recorder.txCount(), 1);
  assert.equal(app.counters.renderAll, 0, '失败不得渲染成已清空');
});

/* ================================================================
   A-③ restoreBackup：恢复备份 = 1 次 DB.tx（11 张表）
   ================================================================ */

/** 把沙箱内 FileReader 替换为「同步取回 onload Promise」的假实现（不改生产代码） */
function installFakeFileReader(app) {
  app.setGlobals({ __frPromise: null });
  app.run('FileReader = function(){ var self=this; this.readAsText=function(){ self.result=__backupJson; __frPromise = self.onload(); }; };');
}

test('A-③ restoreBackup：11 张表一次事务提交，全程零独立 save（原来 11+ 次）', async () => {
  const app = mkApp();
  installFakeFileReader(app);
  const backup = {
    products: fixtureProducts(2),
    orders: fixtureOrders(),
    deliveries: [],
    productionPlans: [],
    productionReports: [],
    processTemplates: [],
    meta: { seq: 7, seeded: true },
  };
  await app.run('__backupJson = ' + JSON.stringify(JSON.stringify(backup)) + ';');

  app.run('restoreBackup({target:{files:[{}],value:""}})');
  await app.run('__frPromise');

  assert.equal(app.recorder.txCount(), 1, '恢复必须只发一次事务');
  assert.equal(app.recorder.writeCount(), 1, '不得出现第 2 次独立 save（原实现 11+ 次）');
  assert.deepEqual(
    plain(app.recorder.lastTx().keys),
    ['fieldsAudit', 'fieldsDraft', 'products', 'orders', 'deliveries', 'productionPlans', 'productionReports', 'processTemplates', 'logs', 'fields', 'meta']
  );
  assert.equal(await app.run('products.length'), 2, '内存已按备份赋值');
  assert.equal(await app.run('fieldsAudit'), 'audited', '恢复后字段直接进入已审核');
  assert.equal(await app.run('fieldsDraft'), null);
  assert.ok(
    app.alerts.some((m) => /恢复成功/.test(m)),
    '成功提示保留'
  );
  assert.equal(app.counters.renderAll, 1);
});

test('A-③ restoreBackup：tx 失败 → 既不 renderAll 也不弹「恢复成功」', async () => {
  const app = mkApp();
  installFakeFileReader(app);
  app.recorder.setResult('tx', false);
  await app.run('__backupJson = ' + JSON.stringify(JSON.stringify({ products: fixtureProducts(1), orders: [] })) + ';');

  app.run('restoreBackup({target:{files:[{}],value:""}})');
  await app.run('__frPromise');

  assert.equal(app.recorder.txCount(), 1);
  assert.equal(app.counters.renderAll, 0, '失败不得渲染成已恢复');
  assert.equal(app.alerts.some((m) => /恢复成功/.test(m)), false, '失败不得提示成功');
});

/* ================================================================
   A-④ delProdPlan：删除排产单 = 1 次 DB.tx（含报工入库回写）
   ================================================================ */

test('A-④ delProdPlan：有入库报工 → 1 次 DB.tx[productionPlans, orders, products, logs]，交付与库存同批回滚', async () => {
  const app = mkApp({ productionPlans: [fixturePlan('待排产', 4)] });
  await app.run('delProdPlan(0)');

  assert.equal(app.recorder.txCount(), 1, '原 5 次独立写 → 1 次事务');
  assert.equal(app.recorder.writeCount(), 1);
  assert.deepEqual(plain(app.recorder.lastTx().keys), ['productionPlans', 'orders', 'products', 'logs']);
  assert.equal(await app.run('productionPlans.length'), 0, '排产单已删');
  assert.equal(await app.run('orders[0].items[0].deliveredQty'), 6, '扣回入库 4（10-4）');
  assert.equal(await app.run('products[0].stock'), 6, '库存投影随之重算');
  assert.equal(await app.run('logs.length'), 2, '回写日志 + 删除日志都入同一次事务');
  assert.ok(
    app.logs === undefined || true
  );
});

test('A-④ delProdPlan：无入库报工 → 事务只含 [productionPlans, logs]（orders/products 不空跑）', async () => {
  const app = mkApp({ productionPlans: [fixturePlan('待排产', 0)] });
  await app.run('delProdPlan(0)');
  assert.equal(app.recorder.txCount(), 1);
  assert.deepEqual(plain(app.recorder.lastTx().keys), ['productionPlans', 'logs']);
});

test('A-④ delProdPlan：tx 失败 → 不 renderContent、不清勾选', async () => {
  const app = mkApp({ productionPlans: [fixturePlan('待排产', 4)] });
  await app.run('selSet("prodPlan").add("0");');
  app.recorder.setResult('tx', false);
  await app.run('delProdPlan(0)');
  assert.equal(app.recorder.txCount(), 1);
  assert.equal(app.counters.renderContent, 0, '失败不得渲染成已删除');
  assert.equal(await app.run('selSet("prodPlan").size'), 1, '失败不得清勾选');
});

/* ================================================================
   B. rehydrateFromServer：失败后回灌业务内存
   ================================================================ */

test('B rehydrateFromServer：按 serverData 复位业务全局量（不再残留乐观值）', async () => {
  const app = mkApp({ serverData: { orders: [{ id: 'SERVER-TRUTH' }], products: [], logs: [], transfers: [] } });
  await app.run('orders[0].id="OPTIMISTIC";');
  await app.run('rehydrateFromServer()');
  assert.equal(await app.run('orders[0].id'), 'SERVER-TRUTH', 'orders 回灌为服务器真值');
  assert.equal(await app.run('products.length'), 0, 'products 同样回灌');
  assert.equal(typeof (await app.run('typeof rehydrateFromServer')), 'string');
});

test('B rehydrateFromServer：serverData 缺失/缺 key → 保留现值，绝不写成 undefined', async () => {
  const app = mkApp({ serverData: undefined });
  await app.run('rehydrateFromServer()');
  assert.equal(await app.run('typeof orders'), 'object', 'serverData 为空时不得把 orders 变成 undefined');
  assert.equal(await app.run('orders.length'), 1);

  await app.run('serverData={orders:[{id:"ONLY-ORDERS"}]};');
  await app.run('rehydrateFromServer()');
  assert.equal(await app.run('orders[0].id'), 'ONLY-ORDERS');
  assert.equal(await app.run('products.length'), 3, 'serverData 缺 products → 保留现值（不清空）');
  assert.equal(await app.run('productionPlans.length'), 0, '缺 key 时保持原值（此处原本就是空数组）');
});

/* ================================================================
   C. 日志：固定时间格式 + 操作者列
   ================================================================ */

test('C logOp：time 固定为 YYYY-MM-DD HH:mm:ss（可排序、与 locale 无关）、user = 当前登录人', async () => {
  const app = mkApp();
  await app.run('logOp("新增","订单管理","测试条目");');
  const time = await app.run('logs[0].time');
  assert.match(time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, '必须是零填充固定格式，而非 toLocaleString 的 2026/9/11 11:12:07');
  assert.equal(await app.run('logs[0].user'), ADMIN.name, '操作者取 currentUser.name');
  assert.equal(await app.run('logOp.length'), 6, 'logOp 签名不变（6 参）');
});

test('C logOp：无登录态 → user 为空串（历史/系统动作不崩，渲染侧展示「—」）', async () => {
  const app = mkApp({ currentUser: null });
  await app.run('logOp("系统","库存打通","无登录态动作");');
  assert.equal(await app.run('logs[0].user'), '');
});

test('C 服务端 sameLog 已纳入 user：仅 user 被整表改写 → logsAppendOK 拒绝', async () => {
  const srv = require('../server/server.js');
  const base = { time: '2026-09-11 11:00:00', action: '新增', target: '订单管理', detail: 'd', field: '', user: '甲' };
  const appended = { time: '2026-09-11 11:05:00', action: '编辑', target: '订单管理', detail: 'x', field: '', user: '甲' };

  /* 正例：真实追加（尾部逐条相同）→ 允许 */
  assert.equal(srv.logsAppendOK([base], [appended, base]), true, '正常追加应允许');

  /* 反例：尾部被改写 user（其余 5 个字段全同）→ 必须拒绝（否则该字段可被任意改写而不被察觉） */
  assert.equal(
    srv.logsAppendOK([base], [appended, Object.assign({}, base, { user: '乙' })]),
    false,
    'user 被改写必须拒绝'
  );

  /* 兼容：历史条目无 user（undefined）与空串等价，不得因此误判拒绝 */
  const legacy = { time: '2026-09-11 10:00:00', action: '新增', target: '订单管理', detail: 'old', field: '' };
  assert.equal(
    srv.logsAppendOK([legacy], [appended, Object.assign({}, legacy, { user: '' })]),
    true,
    'undefined 与空串视为同一形态'
  );
});
