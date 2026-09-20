'use strict';
/* ================================================================
   tests/transfer.return-cap.test.js —— 「退回库存」上限口径（2026-09-20.129 修正）
   ================================================================
   背景（用户报告的 Bug）：订单管理 → 退回库存 的数量上限与校验应「以已调用为准」，
   现状却按「已交付」判——业务口径错误。

   唯一正确口径（.129 用户拍板）：
     可退回量 = saleMaxCallable(it)
              = max(0, 已调用 − max(0, 已交付 − 期初直接交付基数 directDelivered))
     语义 = 调用进来、尚未发给客户、还压在手上可退回库存的量
            （期初直接交付 = 金蝶导入/历史迁移带入、无调用支撑的已交付，不占调用额度）。

   为什么值得单独钉死：
     · 这是**业务规则**，错了会拦住合法退回（已调用 10/已交付 0 却不可退）或放行非法退回
       （已调用 3/已交付 10 却可退 10，把 calledQty 打到 0 —— 见本文件 ④ 反例）。
     · 本项目**明令禁止口径双源**：transfer.js 只能经 `csReturnCap()` 委托全局 `saleMaxCallable`，
       不得复制公式。⑤ 号用例专门钉「委托」这件事（把全局换成哨兵，csReturnCap 必须跟着变）。
     · 不变量：任何合法的退回操作之后都必须满足
       `max(0, 已交付 − 期初直接交付) ≤ 已调用`（退回只是把这条不等式推紧，绝不能推坏）。

   覆盖（对应用户验收 4 条）：① 已调用>0 且 已交付=0 → 可退=已调用
                              ② 已交付>已调用（期初基数覆盖）→ 可退=0
                              ③ 部分交付（已交付<已调用，期初=0）→ 可退=已调用−已交付
                              ④ 任何情况下可退 ≥ 0，且退回后不变量成立
   边界：不测 DOM 弹窗本身（`openReturnStock`/`csWarn`/`csAutoFill` 读 `.cs-inv-box`/`.cs-qty`，
         按 tests/README §6 属「不可测边界」）；本文件测的是它们**共同依赖的那一个上限口径**
         与退回后的数据不变量（经生产函数 `applyTransfers` 真实执行）。
   运行：node --test tests/transfer.return-cap.test.js（**不要用 node -e**，见 README）
   ================================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('./harness/sandbox');

const ADMIN = { username: 'mgr', name: '经理小李', role: 'admin', perms: {} };

/** 跨 realm 对象转成本 realm 纯对象（vm 返回的对象原型属于 vm realm） */
function plain(v) {
  return JSON.parse(JSON.stringify(v));
}
function j(v) {
  return JSON.stringify(v);
}

/** 退回不变量：已交付超出期初直接交付基数的部分，必须由已调用支撑 */
const INVAR =
  'Math.max(0,num(orders[1].items[0].deliveredQty)-num(orders[1].items[0].directDelivered))<=num(orders[1].items[0].calledQty)';

/** 与 `openReturnStock` 里 lines 的构造**完全同形**（.129 起补 calledQty/directDelivered） */
function lineOf(calledQty, deliveredQty, directDelivered) {
  return {
    i: 0,
    productId: 'P1',
    productName: '甲',
    spec: '',
    model: '',
    orderQty: 100,
    deliveredQty: deliveredQty,
    calledQty: calledQty,
    directDelivered: directDelivered,
  };
}

/** 库存订单 O-INV（行 0：P1 已交付 10） + 销售订单 O-SALE（行 0 按入参定制） */
function fixtureOrders(calledQty, deliveredQty, directDelivered) {
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
      items: [
        {
          productId: 'P1',
          productName: '甲',
          spec: '',
          model: '',
          orderQty: 100,
          deliveredQty: deliveredQty,
          calledQty: calledQty,
          directDelivered: directDelivered,
        },
      ],
    },
  ];
}

function fixtureProducts(stock) {
  return [{ id: 'P1', name: '甲', spec: '', model: '', unit: '台', stock: stock, dailyCap: 0, status: '启用' }];
}

/** 只装载、不挂记录器的沙箱（口径类断言不需要写集记录） */
function app0() {
  return createApp({ installRecorder: false });
}

/** 带记录器的沙箱（端到端退回断言写集用） */
function recApp(calledQty, deliveredQty, directDelivered) {
  const app = createApp({ installRecorder: true });
  app.setGlobals({
    currentUser: ADMIN,
    orders: fixtureOrders(calledQty, deliveredQty, directDelivered),
    products: fixtureProducts(10),
    transfers: [],
    productionPlans: [],
    productionReports: [],
    processTemplates: [],
    deliveries: [],
    logs: [],
    renderContent: function () {},
    renderAll: function () {},
  });
  return app;
}

/* ================================================================
   ① 已调用 > 0 且 已交付 = 0 → 可退回量 = 已调用
   ================================================================ */

test('① 已调用>0 且 已交付=0 → 可退回量 = 已调用（旧口径「已交付」会误判为 0 不可退）', () => {
  const app = app0();
  app.setGlobal('__line', lineOf(10, 0, 0));
  assert.equal(app.run('csReturnCap(__line)'), 10, '可退回量 = 已调用 − 0 = 10');
  assert.equal(app.run('saleMaxCallable(__line)'), 10, '与全局 saleMaxCallable 恒等');
  /* 反向对照：旧口径（已交付）在本场景为 0 → 合法退回会被错误拦住，即用户报告的 Bug 形态之一 */
  assert.equal(app.run('num(__line.deliveredQty)'), 0, '旧口径上限 = 已交付 = 0（Bug：合法退回被拦）');
  app.dispose();
});

/* ================================================================
   ② 已交付 > 已调用（期初基数覆盖）→ 可退回量 = 0
   ================================================================ */

test('② 已交付>已调用 → 可退回量 = 0（期初直接交付基数豁免不占调用额度）', () => {
  const app = app0();
  /* ②-1 未调用 + 期初已交付 5：旧口径会误判「可退 5」，新口径 0 */
  app.setGlobal('__a', lineOf(0, 5, 5));
  assert.equal(app.run('csReturnCap(__a)'), 0, '已调用 0 → 无可退回');
  /* ②-2 已调用 3 < 已交付 10 且期初 0：超出期初基数的已交付（10）无调用支撑 → 0 */
  app.setGlobal('__b', lineOf(3, 10, 0));
  assert.equal(app.run('csReturnCap(__b)'), 0, 'max(0,10−0)=10 > 已调用 3 → 0');
  /* ②-3 部分期初：已调用 3、已交付 10、期初 8 → 超额已交付 2 → 3−2 = 1 */
  app.setGlobal('__c', lineOf(3, 10, 8));
  assert.equal(app.run('csReturnCap(__c)'), 1, '只有超出期初基数的那 2 件消耗调用额度');
  app.dispose();
});

/* ================================================================
   ③ 部分交付（已交付 < 已调用，期初 = 0）→ 可退回量 = 已调用 − 已交付
   ================================================================ */

test('③ 部分交付（已交付<已调用，期初=0）→ 可退回量 = 已调用 − 已交付', () => {
  const app = app0();
  app.setGlobal('__a', lineOf(10, 4, 0));
  assert.equal(app.run('csReturnCap(__a)'), 6, '10 − 4 = 6');
  /* 期初基数只豁免「基数以内」的已交付：已调用 10 / 已交付 6 / 期初 2 → 10 − (6−2) = 6 */
  app.setGlobal('__b', lineOf(10, 6, 2));
  assert.equal(app.run('csReturnCap(__b)'), 6, '10 − max(0,6−2) = 6');
  /* 期初 > 已交付 → max(0, 已交付 − 期初) = 0，全部已交付都由期初解释 → 可退 = 已调用 */
  app.setGlobal('__c', lineOf(10, 0, 99));
  assert.equal(app.run('csReturnCap(__c)'), 10, '期初大于已交付时 max() 夹到 0');
  app.dispose();
});

/* ================================================================
   ④ 任何情况下 可退回量 ≥ 0；且退回后不变量成立
   ================================================================ */

test('④ 边界样本：任何情况下 可退回量 ≥ 0，且与全局 saleMaxCallable 逐例恒等', () => {
  const app = app0();
  const samples = [
    [0, 0, 0],
    [10, 0, undefined],
    [3, 10, undefined],
    [-5, 3, 0],
    [5, -3, 0],
    [-1, -1, -1],
    ['abc', 'x', 'y'],
    [NaN, 5, 0],
    [10, NaN, NaN],
    [0.5, 0.25, 0],
    [1e9, 0, 0],
    [3, 10, 8],
  ];
  samples.forEach(([c, d, dd], k) => {
    app.setGlobal('__line', lineOf(c, d, dd));
    const cap = app.run('csReturnCap(__line)');
    assert.equal(typeof cap, 'number', '样本' + k + ' 应返回数字');
    assert.equal(cap >= 0, true, '样本' + k + ' 可退回量不得为负（cap=' + cap + '）');
    assert.equal(cap, app.run('saleMaxCallable(__line)'), '样本' + k + ' 必须与全局口径逐例恒等');
  });
  app.dispose();
});

test('④ 端到端：按可退回量退回后不变量成立（已交付 − 期初 ≤ 已调用），且 cap 饱和为 0', async () => {
  /* 场景：已调用 10、已交付 4、期初 0 → cap = 6 */
  const app = recApp(10, 4, 0);
  const cap = app.run('saleMaxCallable(orders[1].items[0])');
  assert.equal(cap, 6, '前置：cap = 10 − 4 = 6');

  const moves = [
    { out: { orderId: 'O-SALE', orderType: 'sales', lineIdx: 0 }, in: { orderId: 'O-INV', orderType: 'inv', lineIdx: 0 }, qty: cap },
  ];
  assert.equal(await app.run('applyTransfers("return",' + j(moves) + ')'), true, '整批落盘');

  assert.equal(app.recorder.txCount(), 1, '一次业务动作 = 一次 DB.tx');
  assert.deepEqual(plain(app.recorder.lastTx().keys), ['orders', 'transfers', 'products'], '事实表 + 库存投影同事务');
  assert.equal(await app.run('orders[1].items[0].calledQty'), 4, '销售已调用 ↓ cap（.115 起销售侧动 calledQty）');
  assert.equal(await app.run('orders[0].items[0].deliveredQty'), 16, '库存订单已交付 ↑ cap');
  assert.equal(await app.run('orders[1].items[0].deliveredQty'), 4, '退回不动销售已交付（.97 口径）');
  assert.equal(await app.run('transfers.length'), 1);
  assert.equal(await app.run('transfers[0].type'), 'return');
  assert.equal(await app.run('transfers[0].outOrderType'), 'sales', '退回：货从销售流出');
  assert.equal(await app.run('transfers[0].inOrderType'), 'inv', '退回：货流入库存');

  assert.equal(await app.run(INVAR), true, '不变量成立：已交付 − 期初 ≤ 已调用');
  assert.equal(await app.run('saleMaxCallable(orders[1].items[0])'), 0, '退满后 cap = 0（已饱和，参数为紧）');
  app.dispose();
});

test('④ 反例：旧「已交付」口径会放行超量退回并破坏不变量（= 本 Bug 的危害现场）', async () => {
  /* 场景：已调用 3、已交付 10、期初 0 → 新口径 cap = 0（10 件已交付全无调用支撑） */
  const app = recApp(3, 10, 0);
  assert.equal(await app.run('csReturnCap({calledQty:3,deliveredQty:10,directDelivered:0})'), 0, '新口径：不可退');
  const legacyCap = await app.run('num(orders[1].items[0].deliveredQty)');
  assert.equal(legacyCap, 10, '旧口径上限 = 已交付 = 10（错误放行）');

  const moves = [
    { out: { orderId: 'O-SALE', orderType: 'sales', lineIdx: 0 }, in: { orderId: 'O-INV', orderType: 'inv', lineIdx: 0 }, qty: legacyCap },
  ];
  assert.equal(await app.run('applyTransfers("return",' + j(moves) + ')'), true, '旧口径放行的这笔退回会真的落盘');

  assert.equal(await app.run('orders[1].items[0].calledQty'), 0, 'calledQty 触底 0（下限保护）');
  assert.equal(await app.run('orders[1].items[0].deliveredQty'), 10, '销售已交付仍为 10');
  assert.equal(await app.run(INVAR), false, '不变量被破坏：已交付 10 − 期初 0 > 已调用 0');
  app.dispose();
});

/* ================================================================
   ⑤ 单一来源硬约束：transfer.js 必须委托全局 saleMaxCallable，不得自留副本
   ================================================================ */

test('⑤ 单一来源：把全局 saleMaxCallable 换成哨兵 → csReturnCap 必须跟着变（未复制公式）', () => {
  const app = app0();
  app.setGlobal('__line', lineOf(10, 4, 0));
  assert.equal(app.run('csReturnCap(__line)'), 6, '前置：真实口径 = 6');

  const orig = app.getGlobal('saleMaxCallable');
  assert.equal(typeof orig, 'function');
  app.setGlobal('saleMaxCallable', function () {
    return 424242;
  });
  assert.equal(app.run('csReturnCap(__line)'), 424242, 'csReturnCap 完全委托全局函数（若自留副本则不会变）');

  app.setGlobal('saleMaxCallable', orig);
  assert.equal(app.run('csReturnCap(__line)'), 6, '还原全局口径后回到 6');
  app.dispose();
});
