'use strict';
/* ================================================================
   tests/projection.sync.test.js —— 投影/回写「纯重算 vs 兼容包装」黄金样例
   ================================================================
   覆盖（P1-4 清单）：订单状态机（recomputeOrderAutoStatus）、库存同步（recomputeStockFromInvOrders）、
                     入库回写（writebackInboundMutation / writebackInbound）
   为什么值得单独钉死：T03 把这三个能力拆成了「纯重算（只改内存）+ 兼容包装（重算并落盘）」。
   拆分后**纯函数一旦偷偷写盘**，事务化写入点就会出现「tx 之外的第二次写」＝原子性被破坏；
   反过来**包装一旦不再落盘**，未迁移的旧调用点（saveProdPlan/delProdPlan）会静默丢数据。
   两侧都必须钉死：pure 零写盘、wrapper 照旧落盘。

   运行：node --test tests/projection.sync.test.js（**不要用 node -e**，见 README）
   ================================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('./harness/sandbox');

function plain(v) {
  return JSON.parse(JSON.stringify(v));
}

/* ---------------- 夹具 ---------------- */

function invOrder(id, lines) {
  return {
    id: id,
    orderType: '库存订单',
    customer: '成品仓',
    contractNo: '',
    status: '执行中',
    items: lines,
  };
}
function saleOrder(id, lines) {
  return {
    id: id,
    orderType: '销售订单',
    customer: '华东盘厂',
    contractNo: 'HT1',
    status: '执行中',
    items: lines,
  };
}
function invLine(productId, deliveredQty, orderQty) {
  return { productId: productId, productName: productId, spec: '', model: '', orderQty: orderQty === undefined ? 100 : orderQty, deliveredQty: deliveredQty };
}
function prod(id, stock) {
  return { id: id, name: id, spec: '', model: '', unit: '台', stock: stock, dailyCap: 0, status: '启用' };
}

/** 带记录器的沙箱（断言「纯函数零写盘 / 包装照旧落盘」） */
function recApp(seed) {
  const app = createApp({ installRecorder: true });
  app.setGlobals(
    Object.assign(
      {
        currentUser: { username: 'tester', name: '测试员', role: 'admin', perms: {} },
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

function savedKeys(app) {
  return plain(app.recorder.of('save').map((c) => c.key));
}

/* ================================================================
   库存投影 recomputeStockFromInvOrders / syncStockFromInvOrders
   ================================================================ */

test('库存投影：多张库存订单 × 多行聚合；没有库存订单的产品归零（全量对齐口径）', async () => {
  const app = recApp({
    orders: [
      invOrder('O-INV1', [invLine('P1', 10), invLine('P2', 5)]),
      invOrder('O-INV2', [invLine('P1', 3)]),
      saleOrder('O-SALE', [invLine('P1', 7)]), // 销售订单**不**参与库存投影
    ],
    products: [prod('P1', 0), prod('P2', 99), prod('P3', 42)],
  });

  assert.equal(await app.run('recomputeStockFromInvOrders()'), true, '存在差异 → true');
  assert.equal(await app.run('products[0].stock'), 13, 'P1 = 10 + 3（跨两张库存订单累加）');
  assert.equal(await app.run('products[1].stock'), 5, 'P2 = 5');
  assert.equal(await app.run('products[2].stock'), 0, 'P3 无库存订单 → 归零（全量对齐，不留脏值）');
  assert.equal(app.recorder.writeCount(), 0, '纯重算绝不写盘');
  app.dispose();
});

test('库存投影：无差异返回 false；连续调用幂等；始终零写盘', async () => {
  const app = recApp({
    orders: [invOrder('O-INV1', [invLine('P1', 10)])],
    products: [prod('P1', 10)],
  });
  assert.equal(await app.run('recomputeStockFromInvOrders()'), false, '已对齐 → false');
  assert.equal(await app.run('recomputeStockFromInvOrders()'), false, '再算一次仍 false（幂等）');
  assert.equal(app.recorder.writeCount(), 0);
  app.dispose();
});

test('库存投影：库存允许负数（调用超量 = 欠货），不小截断到 0', async () => {
  const app = recApp({
    orders: [invOrder('O-INV1', [invLine('P1', -15)])],
    products: [prod('P1', 0)],
  });
  assert.equal(await app.run('recomputeStockFromInvOrders()'), true);
  assert.equal(await app.run('products[0].stock'), -15, '欠货必须保留负值');
  app.dispose();
});

test('库存投影包装：有变化才落盘 products；无变化不写（避免无意义 rev 递增）', async () => {
  /* 有变化 */
  const app1 = recApp({
    orders: [invOrder('O-INV1', [invLine('P1', 10)])],
    products: [prod('P1', 0)],
  });
  await app1.run('syncStockFromInvOrders()');
  assert.deepEqual(savedKeys(app1), ['products'], '有变化 → 落盘 products');
  assert.equal(await app1.run('products[0].stock'), 10);
  app1.dispose();

  /* 无变化 */
  const app2 = recApp({
    orders: [invOrder('O-INV1', [invLine('P1', 10)])],
    products: [prod('P1', 10)],
  });
  await app2.run('syncStockFromInvOrders()');
  assert.deepEqual(savedKeys(app2), [], '已对齐 → 一字不写');
  app2.dispose();
});

/* ================================================================
   订单状态机 recomputeOrderAutoStatus / syncOrderAutoStatus
   ================================================================ */

test('订单状态机：全交付 → 已完成；有未交付 → 执行中；已取消/已暂停被跳过', async () => {
  const app = recApp({
    orders: [
      invOrder('O-DONE', [invLine('P1', 100, 100)]), // 未交付 0 → 已完成
      invOrder('O-OPEN', [invLine('P1', 10, 100)]), // 未交付 90 → 执行中（已是执行中，无变更）
      Object.assign(invOrder('O-CANCEL', [invLine('P1', 100, 100)]), { status: '已取消' }),
      Object.assign(invOrder('O-PAUSE', [invLine('P1', 100, 100)]), { status: '已暂停' }),
    ],
  });

  assert.equal(await app.run('recomputeOrderAutoStatus()'), 1, '仅 O-DONE 变更 → 返回 1');
  assert.equal(await app.run('orders[0].status'), '已完成');
  assert.equal(await app.run('orders[1].status'), '执行中', '未交付 > 0 → 执行中');
  assert.equal(await app.run('orders[2].status'), '已取消', '已取消不参与状态机（不被复活）');
  assert.equal(await app.run('orders[3].status'), '已暂停', '已暂停不参与状态机');
  app.dispose();
});

test('订单状态机：纯重算不写 orders（状态由调用方并入同一个 tx）；变更记日志走独立 silent 写', async () => {
  const app = recApp({ orders: [invOrder('O-DONE', [invLine('P1', 100, 100)])] });
  await app.run('recomputeOrderAutoStatus()');
  assert.deepEqual(savedKeys(app), ['logs'], '只写日志，绝不写 orders');
  assert.equal(app.recorder.txCount(), 0);
  app.dispose();
});

test('订单状态机：silent=true 时连日志都不记（存量初始化批量对齐用）', async () => {
  const app = recApp({ orders: [invOrder('O-DONE', [invLine('P1', 100, 100)])] });
  const n = await app.run('recomputeOrderAutoStatus(true)');
  assert.equal(n, 1, '仍返回变更数');
  assert.equal(await app.run('orders[0].status'), '已完成', '内存已对齐');
  assert.deepEqual(savedKeys(app), [], 'silent → 零写盘');
  app.dispose();
});

test('订单状态机包装：有变更落盘 orders，无变更一字不写', async () => {
  const app1 = recApp({ orders: [invOrder('O-DONE', [invLine('P1', 100, 100)])] });
  assert.equal(await app1.run('syncOrderAutoStatus()'), 1);
  assert.deepEqual(savedKeys(app1), ['logs', 'orders'], '日志先发（recompute 内），随后落盘 orders');
  app1.dispose();

  const app2 = recApp({ orders: [invOrder('O-OPEN', [invLine('P1', 10, 100)])] });
  assert.equal(await app2.run('syncOrderAutoStatus()'), 0);
  assert.deepEqual(savedKeys(app2), [], '无变更 → 一字不写');
  app2.dispose();
});

test('订单状态机：库存订单以 stockMax 为期初量（有 stockMax 时用 stockMax 而非 orderQty）', async () => {
  const app = recApp({
    orders: [invOrder('O-MAX', [Object.assign(invLine('P1', 50, 999), { stockMax: '50' })])],
  });
  assert.equal(await app.run('recomputeOrderAutoStatus()'), 1, 'stockMax=50 已交付 50 → 未交付 0 → 已完成');
  assert.equal(await app.run('orders[0].status'), '已完成');
  app.dispose();
});

/* ================================================================
   入库回写 writebackInboundMutation（纯） / writebackInbound（包装）
   ================================================================ */

test('入库回写纯变更器：库存订单累加已交付；销售订单不回写（.97 口径）；零写盘', async () => {
  const app = recApp({
    orders: [invOrder('O-INV', [invLine('P1', 10)]), saleOrder('O-SALE', [invLine('P1', 0)])],
  });

  assert.equal(await app.run('writebackInboundMutation("O-INV","P1",5,null)'), true);
  assert.equal(await app.run('orders[0].items[0].deliveredQty'), 15, '库存订单 +5');
  assert.equal(await app.run('writebackInboundMutation("O-SALE","P1",5,null)'), false, '销售订单不回写');
  assert.equal(await app.run('orders[1].items[0].deliveredQty'), 0, '销售订单已交付未被改动（由交付/退货驱动）');
  assert.equal(app.recorder.writeCount(), 0, '纯变更器绝不写盘');
  app.dispose();
});

test('入库回写纯变更器：delta=0 / 订单不存在 / 明细不存在 → false 且不改任何数据', async () => {
  const app = recApp({ orders: [invOrder('O-INV', [invLine('P1', 10)])] });
  assert.equal(await app.run('writebackInboundMutation("O-INV","P1",0,null)'), false, 'delta=0');
  assert.equal(await app.run('writebackInboundMutation("NO-SUCH","P1",5,null)'), false, '订单不存在');
  assert.equal(await app.run('writebackInboundMutation("O-INV","NO-SUCH",5,null)'), false, '明细不存在');
  assert.equal(await app.run('writebackInboundMutation("",  "P1",5,null)'), false, '空订单号');
  assert.equal(await app.run('writebackInboundMutation("O-INV","",  5,null)'), false, '空产品号');
  assert.equal(await app.run('orders[0].items[0].deliveredQty'), 10, '口径零改动');
  assert.equal(app.recorder.writeCount(), 0);
  app.dispose();
});

test('入库回写纯变更器：orderLine 指向的行 productId 不匹配 → 按 productId 兜底定位（不误伤同名字段）', async () => {
  const app = recApp({
    orders: [invOrder('O-INV', [invLine('P1', 1), invLine('P2', 2)])],
  });
  /* 传 orderLine=0 但 productId=P2 → 第 0 行是 P1，应回退为「按 productId 找行」 */
  assert.equal(await app.run('writebackInboundMutation("O-INV","P2",7,0)'), true);
  assert.equal(await app.run('orders[0].items[0].deliveredQty'), 1, '第 0 行（P1）未被误改');
  assert.equal(await app.run('orders[0].items[1].deliveredQty'), 9, '第 1 行（P2）2 + 7');
  app.dispose();
});

test('入库回写纯变更器：orderLine 正确命中时只改该行（同产品多行不合并）', async () => {
  const app = recApp({
    orders: [invOrder('O-INV', [invLine('P1', 1), invLine('P1', 2)])],
  });
  assert.equal(await app.run('writebackInboundMutation("O-INV","P1",5,1)'), true);
  assert.equal(await app.run('orders[0].items[0].deliveredQty'), 1, '第 0 行不变');
  assert.equal(await app.run('orders[0].items[1].deliveredQty'), 7, '第 1 行 +5');
  app.dispose();
});

test('入库回写纯变更器：允许把欠货（负值）向 0 方向回补', async () => {
  const app = recApp({ orders: [invOrder('O-INV', [invLine('P1', -10)])] });
  assert.equal(await app.run('writebackInboundMutation("O-INV","P1",4,null)'), true);
  assert.equal(await app.run('orders[0].items[0].deliveredQty'), -6);
  app.dispose();
});

test('入库回写兼容包装 writebackInbound：旧名旧行为（orders + products + logs 三次独立写）', async () => {
  const app = recApp({
    orders: [invOrder('O-INV', [invLine('P1', 10)])],
    products: [prod('P1', 10)],
  });
  await app.run('writebackInbound("O-INV","P1",5,null)');
  assert.equal(await app.run('orders[0].items[0].deliveredQty'), 15, '回写口径不变');
  assert.equal(await app.run('products[0].stock'), 15, '投影跟随');
  assert.equal(app.recorder.txCount(), 0, '旧路径本轮不迁移：仍走 save（非事务）');
  assert.deepEqual(
    savedKeys(app),
    ['orders', 'products', 'logs'],
    '旧路径 = save(orders) + save(products) + 日志（C2 残余风险，下一轮随 saveProdPlan/delProdPlan 迁移）'
  );
  app.dispose();
});

test('入库回写兼容包装：回写未命中（销售订单/不存在）时完全无写', async () => {
  const app = recApp({ orders: [saleOrder('O-SALE', [invLine('P1', 0)])] });
  await app.run('writebackInbound("O-SALE","P1",5,null)');
  assert.equal(app.recorder.writeCount(), 0, '未命中 → 不写 orders / 不投影 / 不记日志');
  assert.equal(await app.run('orders[0].items[0].deliveredQty'), 0);
  app.dispose();
});
