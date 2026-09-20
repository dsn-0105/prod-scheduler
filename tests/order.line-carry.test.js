'use strict';
/* ================================================================
   tests/order.line-carry.test.js —— 订单明细「内部字段保全 + 行号漂移」守卫
   ================================================================
   事故（2026-09-20 线上）：订单管理列表 XSDD-20260829-00002 / XSDD-20260827-00006，
   删除未调用行后「已调用」数量变 0、调拨台账仍有记录、刷新后部分恢复。根因四步：

     ① 老库 fields.order **没有 calledQty**（.35 只写进 defaultFields 模板，漏了存量配置迁移）
     ② 弹窗列取 orderLineFields() → 不渲染「已调用」cell → 它不是表单字段
     ③ saveOrder 按表单 .oi_field **重建 items** → 未渲染的字段一律丢（仅 directDelivered 有
        「索引+料号一致」补丁，删前面行时索引漂移 → 连它也不命中）
     ④ 刷新跑 migrateOrderCalledQty() 按 orderId|lineIdx 回填 → 索引未漂移的行恢复（00006），
        漂移的行恢复不到且台账指向越界行（00002），该记录连 UI 冲销都做不了

   本文件钉死 .132 的四处修复：
     · migrateOrderCalledQtyField   ①配置补齐（幂等）
     · matchOrderLines              保序匹配新旧行号
     · carryInternalLineFields      ③内部字段回带（不再依赖「索引恰好相等」）
     · guardRemovedOrderLines       被删行仍有引用 → 拒存并给出清零路径（不静默丢值）
     · remapOrderLineRefs           ④台账 out/inLineIdx + 交付计划行 orderLine 随行号重映射
     · repairOrphanTransferLineIdx  存量孤儿行号一次性修复（唯一候选才对，按口径净额重算）

   运行：node --test tests/order.line-carry.test.js（**不要用 node -e**，见 README）
   ================================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('./harness/sandbox');

/** 跨 realm 对象转成本 realm 纯对象（vm 返回的对象原型属于 vm realm） */
function plain(v) {
  return JSON.parse(JSON.stringify(v));
}

function app0(seed) {
  return createApp(seed ? { seed: seed } : {});
}

/** 调 3 参纯函数：fn(old, items/new, src) */
function call3(app, expr, a, b, c) {
  app.setGlobals({ __a: a, __b: b, __c: c });
  return app.run(expr);
}

/** 造一条销售订单（items[].productId 决定行身份） */
function order(id, lines) {
  return {
    id: id,
    customer: '客户X',
    orderType: '销售订单',
    status: '执行中',
    items: lines.map(function (l) {
      return Object.assign({ productId: '', productName: '', orderQty: 0, deliveredQty: 0 }, l);
    }),
  };
}

/* ================================================================
   matchOrderLines —— 新旧明细行保序匹配（行号漂移的唯一入口）
   ================================================================ */

test('matchOrderLines：删首行 → 存活行上移，旧行号仍可追溯（00002 场景）', () => {
  const app = app0();
  const src = plain(
    call3(app, 'matchOrderLines(__a,__b)',
      [{ productId: 'A' }, { productId: 'B' }],
      [{ productId: 'B' }])
  );
  assert.deepEqual(src, [1], '新0行来自旧1行（删掉的是旧0行 A）');
  app.dispose();
});

test('matchOrderLines：删末行 → 前置行号不变（00006 场景，故刷新能自愈）', () => {
  const app = app0();
  const src = plain(
    call3(app, 'matchOrderLines(__a,__b)',
      [{ productId: 'A' }, { productId: 'B' }, { productId: 'C' }],
      [{ productId: 'A' }, { productId: 'B' }])
  );
  assert.deepEqual(src, [0, 1]);
  app.dispose();
});

test('matchOrderLines：删中间行 / 插行 / 重复料号 → 保序推进', () => {
  const app = app0();
  const del = plain(call3(app, 'matchOrderLines(__a,__b)',
    [{ productId: 'A' }, { productId: 'B' }, { productId: 'C' }], [{ productId: 'A' }, { productId: 'C' }]));
  assert.deepEqual(del, [0, 2], '删中间行');

  const ins = plain(call3(app, 'matchOrderLines(__a,__b)',
    [{ productId: 'A' }, { productId: 'B' }], [{ productId: 'A' }, { productId: 'C' }, { productId: 'B' }]));
  assert.deepEqual(ins, [0, -1, 1], '插行：新中间行无来源');

  const dup = plain(call3(app, 'matchOrderLines(__a,__b)',
    [{ productId: 'A' }, { productId: 'A' }, { productId: 'B' }], [{ productId: 'A' }, { productId: 'B' }]));
  assert.deepEqual(dup, [0, 2], '重复料号按出现顺序一一对应');
  app.dispose();
});

test('matchOrderLines：换品改码 / 空料号 / 无旧行 → 一律 -1（不臆造来源）', () => {
  const app = app0();
  const chg = plain(call3(app, 'matchOrderLines(__a,__b)',
    [{ productId: 'A' }, { productId: 'B' }], [{ productId: 'A' }, { productId: 'X' }]));
  assert.deepEqual(chg, [0, -1], '改码行无来源');

  const empty = plain(call3(app, 'matchOrderLines(__a,__b)',
    [{ productId: '' }], [{ productId: '' }]));
  assert.deepEqual(empty, [-1], '空料号不参与匹配');

  const noOld = plain(call3(app, 'matchOrderLines(__a,__b)',
    [], [{ productId: 'A' }]));
  assert.deepEqual(noOld, [-1]);

  const none = plain(call3(app, 'matchOrderLines(__a,__b)',
    [{ productId: 'A' }], []));
  assert.deepEqual(none, []);
  app.dispose();
});

test('matchOrderLines：整体倒序不视为同一行（保序约束下的已知边界，宁缺勿错）', () => {
  const app = app0();
  const src = plain(call3(app, 'matchOrderLines(__a,__b)',
    [{ productId: 'A' }, { productId: 'B' }], [{ productId: 'B' }, { productId: 'A' }]));
  assert.deepEqual(src, [1, -1], 'B 命中旧1；A 在旧1 之后无 A → 无来源（不会把 A 的字段错挂到 B 上）');
  app.dispose();
});

/* ================================================================
   carryInternalLineFields —— 内部字段回带（根因 ③）
   ================================================================ */

test('carryInternalLineFields：表单未带 → 从来源旧行回带（calledQty/directDelivered/origProduct）', () => {
  const app = app0();
  const oldLines = [
    { productId: 'A', calledQty: 0 },
    { productId: 'B', calledQty: 240, directDelivered: 60, origProduct: { productId: 'B0', productName: '原单名', model: 'M', spec: 'S' } },
  ];
  const items = [{ productId: 'B' }];
  const n = call3(app, 'carryInternalLineFields(__a,__b,__c)', oldLines, items, [1]);
  assert.equal(n, 3, 'calledQty + directDelivered + origProduct 共 3 个键');
  assert.deepEqual(plain(items[0]), {
    productId: 'B',
    calledQty: 240,
    directDelivered: 60,
    origProduct: { productId: 'B0', productName: '原单名', model: 'M', spec: 'S' },
  });
  app.dispose();
});

test('carryInternalLineFields：表单已带值 → 以表单为准（A 迁移后 calledQty 是只读表单列，不回带覆盖）', () => {
  const app = app0();
  const oldLines = [{ productId: 'B', calledQty: 240 }];
  const items = [{ productId: 'B', calledQty: 999 }];
  const n = call3(app, 'carryInternalLineFields(__a,__b,__c)', oldLines, items, [0]);
  assert.equal(n, 0);
  assert.equal(items[0].calledQty, 999, '表单值优先，回带不得覆盖');
  app.dispose();
});

test('carryInternalLineFields：无来源（-1）/ 旧行无该键 → 不写入空键（不污染落库形状）', () => {
  const app = app0();
  const oldLines = [{ productId: 'A' }];
  const items = [{ productId: 'X' }, { productId: 'A' }];
  call3(app, 'carryInternalLineFields(__a,__b,__c)', oldLines, items, [-1, 0]);
  assert.equal('calledQty' in items[0], false, '无来源的新行不得凭空出现内部字段');
  assert.equal('calledQty' in items[1], false, '旧行本就没有该键 → 不回带');
  app.dispose();
});

/* ================================================================
   remapOrderLineRefs —— 台账 / 交付计划行号随行号重映射（根因 ④）
   ================================================================ */

function seedDocs() {
  return {
    orders: [order('XSDD-1', [{ productId: 'A', productName: '甲' }, { productId: 'B', productName: '乙' }])],
    transfers: [
      /* 新结构（.115 方向模型）：call 销售在调入侧 */
      { id: 'TR-NEW', type: 'call', qty: 240, reversed: false,
        outOrderId: 'KCDD-1', outOrderType: 'inv', outLineIdx: 0, outProductId: 'B',
        inOrderId: 'XSDD-1', inOrderType: 'sales', inLineIdx: 1, inProductId: 'B' },
      /* 旧结构：销售恒在 salesOrderId/salesLineIdx */
      { id: 'TR-OLD', type: 'call', qty: 100, reversed: false,
        salesOrderId: 'XSDD-1', salesLineIdx: 1, productId: 'B' },
      /* 别的订单：不得被牵连 */
      { id: 'TR-OTHER', type: 'call', qty: 5, reversed: false,
        outOrderId: 'KCDD-9', outOrderType: 'inv', outLineIdx: 1, outProductId: 'Z',
        inOrderId: 'XSDD-9', inOrderType: 'sales', inLineIdx: 1, inProductId: 'Z' },
    ],
    deliveries: [
      { id: 'D1', orderId: 'XSDD-1', items: [{ productId: 'B', orderQty: 10, orderLine: 1 }] },
      { id: 'D2', orderId: 'XSDD-9', items: [{ productId: 'Z', orderQty: 10, orderLine: 1 }] },
    ],
  };
}

test('remapOrderLineRefs：删首行后，台账（新/旧结构）与交付计划行号一起 1→0，别的订单不动', async () => {
  const seed = seedDocs();
  const app = app0(seed);
  const src = plain(call3(app, 'matchOrderLines(__a,__b)', plain(app.getGlobal('orders'))[0].items, [{ productId: 'B' }]));
  assert.deepEqual(src, [1]);

  app.setGlobals({ __o: plain(app.getGlobal('orders'))[0], __s: src });
  const rm = plain(app.run('remapOrderLineRefs(__o,__s)'));
  assert.equal(rm.tr, 2, '两条台账（新结构 + 旧结构）都被改指');
  assert.equal(rm.dl, 1, '交付计划 1 行被改指');
  assert.deepEqual(rm.oldToNew, { 1: 0 });

  const trs = plain(app.getGlobal('transfers'));
  assert.equal(trs[0].inLineIdx, 0, '新结构：调入侧行号 1→0');
  assert.equal(trs[1].salesLineIdx, 0, '旧结构：salesLineIdx 1→0');
  assert.equal(trs[2].inLineIdx, 1, '别的订单不动');

  const dls = plain(app.getGlobal('deliveries'));
  assert.equal(dls[0].items[0].orderLine, 0);
  assert.equal(dls[1].items[0].orderLine, 1, '别的订单的交付计划不动');
  app.dispose();
});

test('remapOrderLineRefs：行号未变（删末行）→ 一条都不改', async () => {
  const seed = seedDocs();
  const app = app0(seed);
  const src = plain(call3(app, 'matchOrderLines(__a,__b)',
    plain(app.getGlobal('orders'))[0].items, [{ productId: 'A' }, { productId: 'B' }]));
  assert.deepEqual(src, [0, 1]);
  app.setGlobals({ __o: plain(app.getGlobal('orders'))[0], __s: src });
  const rm = plain(app.run('remapOrderLineRefs(__o,__s)'));
  assert.equal(rm.tr, 0);
  assert.equal(rm.dl, 0);
  app.dispose();
});

/* ================================================================
   guardRemovedOrderLines —— 被删行仍有引用 → 拒存（不静默丢值）
   ================================================================ */

test('guardRemovedOrderLines：被删行有未冲销台账 → 拒存，文案含订单号/条数/清零路径', () => {
  const seed = seedDocs();
  const app = app0(seed);
  app.setGlobals({ __o: plain(app.getGlobal('orders'))[0], __s: [0] });   /* 删掉旧1行（B，有台账） */
  const msg = app.run('guardRemovedOrderLines(__o,__s)');
  assert.equal(typeof msg, 'string', '必须返回拒存文案');
  assert.match(msg, /XSDD-1/);
  assert.match(msg, /未冲销调拨台账 2 条/);
  assert.match(msg, /冲销/, '必须给出可执行的清零路径');
  assert.match(msg, /（B）/, '按料号点名，避免行号在删行后歧义');
  app.dispose();
});

test('guardRemovedOrderLines：台账已全部冲销 → 放行（reversed 记录数量口径为 0，不拦）', () => {
  const seed = seedDocs();
  seed.transfers = seed.transfers.map(function (t) { return Object.assign({}, t, { reversed: true }); });
  seed.deliveries = [];   /* 本用例只验「台账已冲销」，交付计划引用另有用例 */
  const app = app0(seed);
  app.setGlobals({ __o: plain(app.getGlobal('orders'))[0], __s: [0] });
  assert.equal(app.run('guardRemovedOrderLines(__o,__s)'), null);
  app.dispose();
});

test('guardRemovedOrderLines：被删行被交付计划行引用 → 拒存', () => {
  const seed = seedDocs();
  seed.transfers = [];
  const app = app0(seed);
  app.setGlobals({ __o: plain(app.getGlobal('orders'))[0], __s: [0] });
  const msg = app.run('guardRemovedOrderLines(__o,__s)');
  assert.match(msg, /交付计划行 1 条/);
  app.dispose();
});

test('guardRemovedOrderLines：无引用 → 放行（正常删行不受影响）', () => {
  const app = app0({ orders: [order('XSDD-1', [{ productId: 'A' }, { productId: 'B' }])], transfers: [], deliveries: [] });
  app.setGlobals({ __o: plain(app.getGlobal('orders'))[0], __s: [0] });
  assert.equal(app.run('guardRemovedOrderLines(__o,__s)'), null);
  app.dispose();
});

/* ================================================================
   migrateOrderCalledQtyField —— 字段配置补齐（根因 ①，幂等）
   ================================================================ */

test('migrateOrderCalledQtyField：老库配置缺 calledQty → 紧随 deliveredQty 插入，并落盘 fields', () => {
  const app = app0({
    fields: { order: [
      { key: 'id', label: '订单编号', type: 'text', level: 'head' },
      { key: 'deliveredQty', label: '已交付数量', type: 'number', level: 'line' },
      { key: 'lineNotes', label: '商品行备注', type: 'text', level: 'line' },
    ] },
    fieldsDraft: null,
  });
  app.run('migrateOrderCalledQtyField()');
  const f = plain(app.getGlobal('fields')).order;
  assert.deepEqual(f.map(function (x) { return x.key; }), ['id', 'deliveredQty', 'calledQty', 'lineNotes']);
  const def = f.find(function (x) { return x.key === 'calledQty'; });
  assert.equal(def.label, '已调用');
  assert.equal(def.type, 'number');
  assert.equal(def.level, 'line', '必须是行级字段，否则不进弹窗明细');
  assert.equal(def.locked, true, '系统字段：不可在字段设置里删除（防再次踩坑）');
  assert.equal(app.recorder.countOf('fields'), 1);
  app.dispose();
});

test('migrateOrderCalledQtyField：幂等 —— 二次运行零写入、零改动', () => {
  const app = app0({
    fields: { order: [{ key: 'deliveredQty', label: '已交付数量', type: 'number', level: 'line' }] },
    fieldsDraft: null,
  });
  app.run('migrateOrderCalledQtyField()');
  const after1 = plain(app.getGlobal('fields'));
  const w1 = app.recorder.writeCount();
  app.run('migrateOrderCalledQtyField()');
  assert.deepEqual(plain(app.getGlobal('fields')), after1);
  assert.equal(app.recorder.writeCount(), w1, '第二次不得再写 fields');
  app.dispose();
});

test('migrateOrderCalledQtyField：fieldsDraft 同步补齐（字段草稿态同样丢列）', () => {
  const app = app0({
    fields: { order: [{ key: 'deliveredQty', label: '已交付数量', type: 'number', level: 'line' }] },
    fieldsDraft: { order: [{ key: 'deliveredQty', label: '已交付数量', type: 'number', level: 'line' }] },
  });
  app.run('migrateOrderCalledQtyField()');
  assert.deepEqual(plain(app.getGlobal('fieldsDraft')).order.map(function (x) { return x.key; }), ['deliveredQty', 'calledQty']);
  assert.equal(app.recorder.countOf('fieldsDraft'), 1);
  app.dispose();
});

test('migrateOrderCalledQtyField：已是新库（含该字段）→ 一字不动、零写入', () => {
  const app = app0({
    fields: { order: [{ key: 'deliveredQty', label: '已交付数量', type: 'number', level: 'line' }, { key: 'calledQty', label: '已调用', type: 'number', level: 'line' }] },
  });
  app.run('migrateOrderCalledQtyField()');
  assert.equal(app.recorder.writeCount(), 0);
  app.dispose();
});

/* ================================================================
   repairOrphanTransferLineIdx —— 存量孤儿行号一次性修复（00002 永久 0 的那条）
   ================================================================ */

test('repairOrphanTransferLineIdx：越界行号唯一候选 → 对齐 + 按台账净额重算已调用，一次事务', async () => {
  const app = app0({
    orders: [order('XSDD-20260829-00002', [{ productId: 'C02.02.026', productName: '乙', orderQty: 240, calledQty: 0, deliveredQty: 0 }])],
    transfers: [{ id: 'TR1787983127680-0', type: 'call', qty: 240, reversed: false, ts: 't', user: 'u',
      outOrderId: 'KCDD-1', outOrderType: 'inv', outLineIdx: 0, outProductId: 'C02.02.026',
      inOrderId: 'XSDD-20260829-00002', inOrderType: 'sales', inLineIdx: 1, inProductId: 'C02.02.026' }],
    deliveries: [],
    meta: { seq: 0 },
  });
  await app.run('repairOrphanTransferLineIdx()');

  const trs = plain(app.getGlobal('transfers'));
  assert.equal(trs[0].inLineIdx, 0, '越界行号 1 → 唯一候选 0');
  const it = plain(app.getGlobal('orders'))[0].items[0];
  assert.equal(it.calledQty, 240, 'calledQty 按台账净额重算（call 240）');
  assert.equal(app.recorder.txCount(), 1, 'orders+transfers 一次事务提交');
  assert.deepEqual(plain(app.recorder.lastTx().keys), ['orders', 'transfers']);
  app.dispose();
});

test('repairOrphanTransferLineIdx：多候选 → 一律不动并记日志（宁可不动也不猜）', async () => {
  const app = app0({
    orders: [order('XSDD-1', [{ productId: 'B', calledQty: 0 }, { productId: 'B', calledQty: 0 }])],
    transfers: [{ id: 'TR-X', type: 'call', qty: 5, reversed: false,
      outOrderId: 'KCDD-1', outOrderType: 'inv', outLineIdx: 0, outProductId: 'B',
      inOrderId: 'XSDD-1', inOrderType: 'sales', inLineIdx: 9, inProductId: 'B' }],
    deliveries: [],
    meta: { seq: 0 },
  });
  await app.run('repairOrphanTransferLineIdx()');
  assert.equal(plain(app.getGlobal('transfers'))[0].inLineIdx, 9, '歧义 → 保持原样');
  assert.equal(plain(app.getGlobal('orders'))[0].items[0].calledQty, 0, 'calledQty 不动');
  assert.equal(app.recorder.txCount(), 0, '无改动不发事务');
  app.dispose();
});

test('repairOrphanTransferLineIdx：行号本就正确 → 零改动；且只跑一次（meta 标记）', async () => {
  const app = app0({
    orders: [order('XSDD-1', [{ productId: 'B', calledQty: 5 }])],
    transfers: [{ id: 'TR-OK', type: 'call', qty: 5, reversed: false,
      outOrderId: 'KCDD-1', outOrderType: 'inv', outLineIdx: 0, outProductId: 'B',
      inOrderId: 'XSDD-1', inOrderType: 'sales', inLineIdx: 0, inProductId: 'B' }],
    deliveries: [],
    meta: { seq: 0 },
  });
  await app.run('repairOrphanTransferLineIdx()');
  assert.equal(app.recorder.txCount(), 0);
  assert.equal(plain(app.getGlobal('meta')).fixOrphanLineIdx20260920, true, '一次性标记必须落盘');
  const w = app.recorder.writeCount();
  await app.run('repairOrphanTransferLineIdx()');
  assert.equal(app.recorder.writeCount(), w, '标记已置 → 第二次直接返回');
  app.dispose();
});

test('repairOrphanTransferLineIdx：事务失败 → 标记复位（下次启动幂等重试，不留半成品）', async () => {
  const app = app0({
    orders: [order('XSDD-1', [{ productId: 'B', calledQty: 0 }])],
    transfers: [{ id: 'TR-X', type: 'call', qty: 5, reversed: false,
      outOrderId: 'KCDD-1', outOrderType: 'inv', outLineIdx: 0, outProductId: 'B',
      inOrderId: 'XSDD-1', inOrderType: 'sales', inLineIdx: 7, inProductId: 'B' }],
    deliveries: [],
    meta: { seq: 0 },
  });
  app.recorder.setResult('tx', false);
  await app.run('repairOrphanTransferLineIdx()');
  assert.equal(plain(app.getGlobal('meta')).fixOrphanLineIdx20260920, false, '失败必须复位标记');
  app.dispose();
});

/* ================================================================
   calledQtyNetMap —— 口径唯一来源（migrateOrderCalledQty 与孤儿修复共用）
   ================================================================ */

test('calledQtyNetMap：call 加 / return 减 / 已冲销不计 / conv·move 不参与 / 旧结构可读', () => {
  const app = app0({
    transfers: [
      { id: 'a', type: 'call', qty: 240, reversed: false, outOrderId: 'K1', outOrderType: 'inv', outLineIdx: 0, inOrderId: 'S1', inOrderType: 'sales', inLineIdx: 0 },
      { id: 'b', type: 'return', qty: 40, reversed: false, outOrderId: 'S1', outOrderType: 'sales', outLineIdx: 0, inOrderId: 'K1', inOrderType: 'inv', inLineIdx: 0 },
      { id: 'c', type: 'call', qty: 999, reversed: true, outOrderId: 'K1', outOrderType: 'inv', outLineIdx: 0, inOrderId: 'S1', inOrderType: 'sales', inLineIdx: 0 },
      { id: 'd', type: 'move', qty: 77, reversed: false, outOrderId: 'K2', outOrderType: 'inv', outLineIdx: 0, inOrderId: 'K3', inOrderType: 'inv', inLineIdx: 0 },
      { id: 'e', type: 'call', qty: 5, reversed: false, salesOrderId: 'S1', salesLineIdx: 2, productId: 'P' },
    ],
  });
  const map = plain(app.run('calledQtyNetMap()'));
  assert.equal(map['S1|0'], 200, '240 − 40；已冲销的 999 不计');
  assert.equal(map['S1|2'], 5, '旧结构（salesOrderId/salesLineIdx）同样可读');
  assert.equal(Object.keys(map).length, 2, '纯库存 move 不产生销售侧键');
  app.dispose();
});
