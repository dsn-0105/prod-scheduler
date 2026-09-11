'use strict';
/* ================================================================
   tests/transfer.helpers.test.js —— 调拨纯函数黄金样例
   ================================================================
   覆盖（P1-4 清单）：trRevType（冲销反向映射）、trSide（方向读取 + 旧结构防御推导）、
                     trSnapOf（台账快照直读 / 存量反查兜底）
   为什么值得单独钉死：这三个函数是**调拨方向模型（.115）的唯一口径来源**，
   被 applyTransfers / reverseTransfer / 台账渲染同时依赖；一旦反向映射或方向推导改了，
   冲销会把数量滚到错误的订单上（数据正确性事故），而这类 bug 在 UI 上不易被肉眼发现。

   运行：node --test tests/transfer.helpers.test.js（**不要用 node -e**，见 README）
   ================================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('./harness/sandbox');

/** 跨 realm 对象转成本 realm 纯对象（vm 返回的对象原型属于 vm realm） */
function plain(v) {
  return JSON.parse(JSON.stringify(v));
}

/** 只装载、不挂记录器的沙箱（这些是纯函数，不需要写集记录） */
function app0() {
  return createApp({ installRecorder: false });
}

/* ================================================================
   trRevType —— 冲销类型反向映射
   ================================================================ */

test('trRevType：6 类映射逐一正确，未知类型 → null', () => {
  const app = app0();
  const cases = [
    ['call', 'return'],
    ['return', 'call'],
    ['conv', 'conv_back'],
    ['conv_back', 'conv'],
    ['move', 'move_back'],
    ['move_back', 'move'],
    ['', null],
    ['unknown', null],
  ];
  for (const [input, expect] of cases) {
    assert.equal(app.run('trRevType(' + JSON.stringify(input) + ')'), expect, 'trRevType(' + JSON.stringify(input) + ')');
  }
  app.dispose();
});

test('trRevType：null/undefined 入参安全返回 null（不抛）', () => {
  const app = app0();
  assert.equal(app.run('trRevType(null)'), null);
  assert.equal(app.run('trRevType(undefined)'), null);
  app.dispose();
});

test('trRevType：二次冲销回到原类型（幂等反向）—— 冲销的冲销不会漂移', () => {
  const app = app0();
  ['call', 'return', 'conv', 'conv_back', 'move', 'move_back'].forEach((t) => {
    assert.equal(
      app.run('trRevType(trRevType(' + JSON.stringify(t) + '))'),
      t,
      t + ' 两次反向应回到自身'
    );
  });
  app.dispose();
});

/* ================================================================
   trSide —— 取记录某一侧（out=调出 / in=调入）
   ================================================================ */

test('trSide：新结构（out*/in*）直读，两侧互不串味', () => {
  const app = app0();
  const rec = {
    id: 'TR1',
    type: 'call',
    outOrderId: 'O-INV',
    outOrderType: 'inv',
    outLineIdx: 0,
    outProductId: 'P1',
    inOrderId: 'O-SALE',
    inOrderType: 'sales',
    inLineIdx: 1,
    inProductId: 'P2',
  };
  const out = plain(app.run('trSide(' + JSON.stringify(rec) + ',"out")'));
  const inn = plain(app.run('trSide(' + JSON.stringify(rec) + ',"in")'));
  assert.deepEqual(out, { orderId: 'O-INV', orderType: 'inv', lineIdx: 0, productId: 'P1' });
  assert.deepEqual(inn, { orderId: 'O-SALE', orderType: 'sales', lineIdx: 1, productId: 'P2' });
  app.dispose();
});

test('trSide：新结构但 lineIdx/productId 缺失 → 兜底 -1 / 空串（不产生 undefined 传染）', () => {
  const app = app0();
  const rec = { id: 'TR2', type: 'move', outOrderId: 'O-A', outOrderType: 'inv', inOrderId: 'O-B', inOrderType: 'inv' };
  const out = plain(app.run('trSide(' + JSON.stringify(rec) + ',"out")'));
  const inn = plain(app.run('trSide(' + JSON.stringify(rec) + ',"in")'));
  assert.deepEqual(out, { orderId: 'O-A', orderType: 'inv', lineIdx: -1, productId: '' });
  assert.deepEqual(inn, { orderId: 'O-B', orderType: 'inv', lineIdx: -1, productId: '' });
  app.dispose();
});

test('trSide：空/非法记录 → 安全默认值（不抛）', () => {
  const app = app0();
  const expected = { orderId: '', orderType: '', lineIdx: -1, productId: '' };
  assert.deepEqual(plain(app.run('trSide(null,"out")')), expected);
  assert.deepEqual(plain(app.run('trSide(undefined,"in")')), expected);
  assert.deepEqual(plain(app.run('trSide(0,"out")')), expected);
  app.dispose();
});

/* 旧结构（salesOrderId/invOrderId…）在 .115 迁移后仅剩未迁移记录的防御路径，
   但线上仍可能有存量记录走到这里 —— 推导方向错了会把货滚到反向订单，必须钉死。 */
const LEGACY = {
  id: 'TR-OLD',
  type: 'call',
  invOrderId: 'O-INV',
  invLineIdx: 1,
  invProductId: 'PI',
  salesOrderId: 'O-SALE',
  salesLineIdx: 2,
  productId: 'PS',
};

test('trSide：旧结构 type=call → 调出=库存侧、调入=销售侧', () => {
  const app = app0();
  const out = plain(app.run('trSide(' + JSON.stringify(LEGACY) + ',"out")'));
  const inn = plain(app.run('trSide(' + JSON.stringify(LEGACY) + ',"in")'));
  assert.deepEqual(out, { orderId: 'O-INV', orderType: 'inv', lineIdx: 1, productId: 'PI' }, 'call：货从库存流出');
  assert.deepEqual(inn, { orderId: 'O-SALE', orderType: 'sales', lineIdx: 2, productId: 'PS' }, 'call：货流入销售');
  app.dispose();
});

test('trSide：旧结构 type=return → 调出=销售侧、调入=库存侧（与 call 反向）', () => {
  const app = app0();
  const rec = Object.assign({}, LEGACY, { type: 'return' });
  const out = plain(app.run('trSide(' + JSON.stringify(rec) + ',"out")'));
  const inn = plain(app.run('trSide(' + JSON.stringify(rec) + ',"in")'));
  assert.deepEqual(out, { orderId: 'O-SALE', orderType: 'sales', lineIdx: 2, productId: 'PS' }, 'return：货从销售流出');
  assert.deepEqual(inn, { orderId: 'O-INV', orderType: 'inv', lineIdx: 1, productId: 'PI' }, 'return：货流入库存');
  app.dispose();
});

test('trSide：旧结构 call 与 return 的 out/in 恰好互换（方向模型自洽性）', () => {
  const app = app0();
  const callRec = LEGACY;
  const retRec = Object.assign({}, LEGACY, { type: 'return' });
  const callOut = plain(app.run('trSide(' + JSON.stringify(callRec) + ',"out")'));
  const retIn = plain(app.run('trSide(' + JSON.stringify(retRec) + ',"in")'));
  const callIn = plain(app.run('trSide(' + JSON.stringify(callRec) + ',"in")'));
  const retOut = plain(app.run('trSide(' + JSON.stringify(retRec) + ',"out")'));
  assert.deepEqual(callOut, retIn, 'call 的调出方 = return 的调入方');
  assert.deepEqual(callIn, retOut, 'call 的调入方 = return 的调出方');
  app.dispose();
});

/* ================================================================
   trSnapOf —— 台账快照（历史记录不随订单后续编辑变化）
   ================================================================ */

test('trSnapOf：新记录已带快照 → 直接取自身（不再反查订单）', () => {
  const app = app0();
  const rec = { id: 'TR3', type: 'call', customer: 'C1', contractNo: 'H1', productName: '甲', spec: 'S1', model: 'M1' };
  /* 新记录快照已存 → 原样返回**同一个对象**（不重建、不查 orders）。
     这里刻意把 orders 设为空数组：若实现走了反查兜底分支，字段会变成空值。 */
  app.setGlobal('orders', []);
  app.setGlobal('__rec', rec);
  const same = app.run('trSnapOf(__rec) === __rec');
  const snap = plain(app.run('trSnapOf(__rec)'));
  assert.equal(same, true, '已带快照的记录应原样返回自身（同一引用）');
  assert.equal(snap.customer, 'C1');
  assert.equal(snap.contractNo, 'H1');
  assert.equal(snap.productName, '甲');
  assert.equal(snap.spec, 'S1');
  assert.equal(snap.model, 'M1');
  app.dispose();
});

test('trSnapOf：空记录 → 全空快照（不抛）', () => {
  const app = app0();
  const snap = plain(app.run('trSnapOf(null)'));
  assert.deepEqual(snap, { customer: '', contractNo: '', productName: '', spec: '', model: '' });
  app.dispose();
});

test('trSnapOf：存量记录无快照 → 按「销售侧优先」反查订单兜底（call 取销售侧）', () => {
  const app = app0();
  app.setGlobals({
    orders: [
      {
        id: 'O-SALE',
        orderType: '销售订单',
        customer: '华东盘厂',
        contractNo: 'HT1',
        items: [
          { productId: 'P0', productName: '零', spec: '', model: '' },
          { productId: 'PS', productName: '销售甲', spec: 'SS', model: 'MS' },
        ],
      },
      {
        id: 'O-INV',
        orderType: '库存订单',
        customer: '成品仓',
        contractNo: '',
        items: [
          { productId: 'P0', productName: '零', spec: '', model: '' },
          { productId: 'PI', productName: '库存乙', spec: 'SI', model: 'MI' },
        ],
      },
    ],
  });
  const rec = { id: 'TR4', type: 'call', invOrderId: 'O-INV', invLineIdx: 1, invProductId: 'PI', salesOrderId: 'O-SALE', salesLineIdx: 1, productId: 'PS' };
  const snap = plain(app.run('trSnapOf(' + JSON.stringify(rec) + ')'));
  assert.deepEqual(snap, { customer: '华东盘厂', contractNo: 'HT1', productName: '销售甲', spec: 'SS', model: 'MS' }, '含销售订单 → 快照归属销售侧');
  app.dispose();
});

test('trSnapOf：纯库存互调（conv/move）→ 快照归属调入侧库存行', () => {
  const app = app0();
  app.setGlobals({
    orders: [
      {
        id: 'O-A',
        orderType: '库存订单',
        customer: '成品仓',
        contractNo: '',
        items: [{ productId: 'PA', productName: '甲料', spec: 'SA', model: 'MA' }],
      },
      {
        id: 'O-B',
        orderType: '库存订单',
        customer: '半成品仓',
        contractNo: '',
        items: [{ productId: 'PB', productName: '乙料', spec: 'SB', model: 'MB' }],
      },
    ],
  });
  const rec = { id: 'TR5', type: 'move', outOrderId: 'O-A', outOrderType: 'inv', outLineIdx: 0, outProductId: 'PA', inOrderId: 'O-B', inOrderType: 'inv', inLineIdx: 0, inProductId: 'PB' };
  const snap = plain(app.run('trSnapOf(' + JSON.stringify(rec) + ')'));
  assert.deepEqual(snap, { customer: '半成品仓', contractNo: '', productName: '乙料', spec: 'SB', model: 'MB' }, '两侧皆库存 → 取调入侧');
  app.dispose();
});

test('trSnapOf：订单已不存在（历史记录反查失败）→ 空快照而非抛错', () => {
  const app = app0();
  app.setGlobal('orders', []);
  const rec = { id: 'TR6', type: 'call', invOrderId: 'GONE-1', invLineIdx: 0, invProductId: 'PI', salesOrderId: 'GONE-2', salesLineIdx: 0, productId: 'PS' };
  const snap = plain(app.run('trSnapOf(' + JSON.stringify(rec) + ')'));
  assert.deepEqual(snap, { customer: '', contractNo: '', productName: '', spec: '', model: '' });
  app.dispose();
});

test('trSnapOf：订单存在但明细行越界 → 商品字段空、客户/合同仍取到', () => {
  const app = app0();
  app.setGlobals({
    orders: [{ id: 'O-SALE', orderType: '销售订单', customer: '华东盘厂', contractNo: 'HT1', items: [] }],
  });
  const rec = { id: 'TR7', type: 'call', invOrderId: 'O-INV', invLineIdx: 0, invProductId: 'PI', salesOrderId: 'O-SALE', salesLineIdx: 5, productId: 'PS' };
  const snap = plain(app.run('trSnapOf(' + JSON.stringify(rec) + ')'));
  assert.equal(snap.customer, '华东盘厂');
  assert.equal(snap.contractNo, 'HT1');
  assert.equal(snap.productName, '', '明细越界 → 商品名空（不抛）');
  app.dispose();
});
