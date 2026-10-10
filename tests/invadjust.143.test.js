'use strict';
/* ================================================================
   tests/invadjust.143.test.js
   —— 2026-10-10.143「库存管理 → 库存调整（盘盈/盘亏）」**QA 独立验收用例**
   ================================================================
   立场（QA 爱德华，独立验证）：**本文件不采信任何自述**，全部结论由本文件新写的
   沙箱驱动（装载生产 js/transfer.js + index.html 主内联脚本）实测得到；工程师的
   临时自测脚本已作废，不作为证据。

   验证基准 = 已拍板口径（不得自行放宽）：
     ① 仅库存订单；单选（0 / >1 拒绝）；「已取消 / 已暂停」拒绝
     ② 弹窗按明细行：每行「盘亏|盘盈」+ 数量，填 0 的行不动；顶部「调整原因」（选填）
     ③ 盘亏 = deliveredQty − qty（允许为负=欠货）；盘盈 = +qty
     ④ 复用既有执行器 applyTransfers（唯一台账写入器）；单边形态 = mv.out / mv.in 恰有一侧 null
     ⑤ 台账类型 adjust_out（红）/ adjust_in（绿）；缺省侧写 '' / null，台账显示「—」；qty 恒正
     ⑥ 台账新增「备注」列（remark）；空态 colspan=14
     ⑦ 调整后自动联动 recomputeStockFromInvOrders() + recomputeOrderAutoStatus()（仅 applyTransfers 内）
     ⑧ 支持冲销：trRevType 给出 adjust_out↔adjust_in；冲销生成反向单边 + reverseOf + (冲销)；
        原记录 reversed=true；重复冲销被拒；冲销的冲销回到原类型
     ⑨ 权限动作键 order_inv.invAdjust（默认 PMC）

   覆盖结构：
     §A 盘亏 / 盘盈单边（数据 + 台账字段 + trSide 安全 + 投影联动）
     §B 盘亏致负（欠货）
     §C 事务形状（1 次 /api/tx；ops 组成；失败整批未生效含内存复原）
     §D 冲销（单边反向 / reverseOf / reversed / 二次拒绝 / 幂等反向）
     §E 防御与校验层（双 null 零写；0/多选/非库存/已取消/已暂停 拒绝）
     §F 弹窗构建（openInvAdjust 全行 + 方向下拉 + 原因输入；doInvAdjust 单边 moves）
     §G 台账渲染 / 查询 / 筛选 / 排序（单边「—」、料号回退、cross 不误触发、备注列）
     §H 5 处 sales-only 过滤逻辑对单边记录的行为
     §I 防回归（call/return/conv/move 数量与台账字段逐项一致 + 旧结构 trSide）
     §J 静态守卫（三处类型表 / colspan / 备注列 / index.html 挂载 / guide / 公式单源）

   运行：node --test tests/invadjust.143.test.js   （**不要用 node -e / --eval**，见 tests/README）
   ================================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createApp, ROOT } = require('./harness/sandbox');
const { createFetchStub } = require('./harness/dom-stub');

const SRC_TRANSFER = fs.readFileSync(path.join(ROOT, 'js', 'transfer.js'), 'utf8');
const SRC_INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SRC_GUIDE = fs.readFileSync(path.join(ROOT, 'js', 'guide.js'), 'utf8');

const ADMIN = { username: 'pmc', name: 'PMC小张', role: 'admin', perms: {} };

/* ---------- 跨 realm 转义 / 取值辅助 ---------- */
function plain(v) {
  return JSON.parse(JSON.stringify(v));
}
/** vm 表达式 → 本 realm 纯对象 */
const gj = (app, expr) => plain(app.run(expr));
const J = (v) => JSON.stringify(v);

/* ================================================================
   夹具
   注意：createApp({seed}) 是**按引用注入**（setGlobal 直接赋值同一对象），
   故 boot() 必须先 JSON 深拷贝 —— 否则同一份 fixture 被多个 app 共享，
   第一个 app 的变更会污染后续 app 的初始态，制造「差异恒空」的假阴性。
   ================================================================ */

/** 库存订单（行：pid / 数量=最大库存量 / 已交付） */
function invOrder(id, rows, over) {
  return Object.assign(
    {
      id: id,
      orderType: '库存订单',
      customer: '内部库存',
      status: '执行中',
      startDate: '2026-08-20',
      deadline: '',
      contractNo: '',
      items: rows.map(function (r) {
        return {
          productId: r.pid,
          productName: r.pid,
          spec: r.spec || '',
          model: r.model || '',
          orderQty: r.qty,
          stockMax: r.qty,
          stockMin: 0,
          deliveredQty: r.dv === undefined ? 0 : r.dv,
          calledQty: 0,
          lineNotes: '',
        };
      }),
    },
    over || {}
  );
}

/** 销售订单 */
function saleOrder(id, rows, over) {
  return Object.assign(
    {
      id: id,
      orderType: '销售订单',
      customer: '华东盘厂',
      status: '执行中',
      startDate: '2026-08-20',
      deadline: '',
      contractNo: 'HT-' + id,
      items: rows.map(function (r) {
        return {
          productId: r.pid,
          productName: r.pid,
          spec: '', model: '',
          orderQty: r.qty,
          deliveredQty: r.dv === undefined ? 0 : r.dv,
          calledQty: r.cq === undefined ? 0 : r.cq,
          directDelivered: r.dd === undefined ? 0 : r.dd,
        };
      }),
    },
    over || {}
  );
}

function mkProd(pid, stock) {
  return { id: pid, name: pid, model: '', spec: '', unit: '台', stock: stock, dailyCap: 0, status: '启用' };
}

/** 带记录器的沙箱（写集断言用）。seed 深拷贝注入。 */
function boot(seed, extra) {
  const base = {
    orders: [],
    products: [],
    deliveries: [],
    productionPlans: [],
    productionReports: [],
    transfers: [],
    processTemplates: [],
    logs: [],
    meta: { seq: 0 },
  };
  const merged = Object.assign(base, seed || {});
  const deep = JSON.parse(JSON.stringify(merged));
  return createApp({
    quietConsole: true,
    seed: Object.assign(
      {
        currentUser: ADMIN,
        renderContent: function () {},
        renderAll: function () {},
      },
      deep,
      extra || {}
    ),
  });
}

/** 主夹具：1 张库存订单 2 行（L0 P-A 100/40、L1 P-B 50/20），产品投影一致 */
const OINV = 'KCDD-20260821-00001';
const OSALE = 'XSDD-20260821-00001';
function mainSeed() {
  return {
    orders: [
      invOrder(OINV, [{ pid: 'P-A', qty: 100, dv: 40 }, { pid: 'P-B', qty: 50, dv: 20 }]),
      saleOrder(OSALE, [{ pid: 'P-A', qty: 80, dv: 0, cq: 0 }]),
    ],
    products: [mkProd('P-A', 40), mkProd('P-B', 20)],
  };
}

/** 应用一批单边/双边 moves（异步：applyTransfers 返回 Promise<boolean>） */
function apply(app, type, moves, opts) {
  return app.run(
    'applyTransfers(' + (type === null ? 'null' : J(type)) + ',' + J(moves) + (opts ? ',' + J(opts) : '') + ')'
  );
}

/** 真实时间间隔：台账 id = 'TR'+Date.now()+'-'+idx（毫秒级）。
    相邻两次写入若落在同一毫秒会生成**同 id**（见 R2），故需要「按 id 定位第二条记录」的
    用例之间插入真实间隔，避免用例依赖时钟抖动。 */
const tick = (ms) => new Promise(function (r) { setTimeout(r, ms === undefined ? 10 : ms); });

/* ================================================================
   §A 盘亏 / 盘盈单边
   ================================================================ */

test('A1 盘亏单边：已交付↓、库存投影同步、台账 adjust_out 且缺省侧为空串/null、remark 落库、trSide 两侧读取安全', async () => {
  const app = boot(mainSeed());
  const moves = [
    { out: { orderId: OINV, orderType: 'inv', lineIdx: 0 }, in: null, qty: 30, type: 'adjust_out', remark: '盘点差异' },
  ];
  assert.equal(await apply(app, null, moves), true, '单边盘亏应整批落盘');

  /* 数量：40 − 30 = 10 */
  assert.equal(await app.run('orders[0].items[0].deliveredQty'), 10, '盘亏 = 已交付 − qty');
  /* 库存投影（Σ库存订单已交付）自动联动 */
  assert.equal(await app.run('products[0].stock'), 10, 'products 库存投影同步（P-A 40→10）');
  assert.equal(await app.run('products[1].stock'), 20, '未涉及行不变（P-B）');

  /* 台账：1 条、类型、存在侧=本单（out） */
  assert.equal(await app.run('transfers.length'), 1, '台账新增 1 条');
  assert.equal(await app.run('transfers[0].type'), 'adjust_out');
  assert.equal(await app.run('transfers[0].outOrderId'), OINV, '存在侧为调出订单（本单）');
  assert.equal(await app.run('transfers[0].outOrderType'), 'inv');
  assert.equal(await app.run('transfers[0].outLineIdx'), 0);
  assert.equal(await app.run('transfers[0].outProductId'), 'P-A', '存在侧料号取自订单行');
  assert.equal(await app.run('transfers[0].qty'), 30, 'qty 恒正');

  /* 缺省侧（in）：空串 / null —— 不得是 undefined */
  assert.equal(await app.run('transfers[0].inOrderId'), '', 'inOrderId 写空串');
  assert.equal(await app.run('transfers[0].inOrderType'), '', 'inOrderType 写空串');
  assert.equal(await app.run('transfers[0].inLineIdx'), null, 'inLineIdx 写 null');
  assert.equal(await app.run('transfers[0].inProductId'), '', 'inProductId 写空串');

  /* remark 落库 + 既有类型缺省空串（此处显式给了值） */
  assert.equal(await app.run('transfers[0].remark'), '盘点差异');
  assert.equal(await app.run('transfers[0].reversed'), false);
  assert.equal(await app.run('transfers[0].reverseOf'), null);

  /* 快照归属唯一存在侧（单边不得报错） */
  assert.equal(await app.run('transfers[0].productName'), 'P-A', '快照商品名 = 唯一存在侧订单行');
  assert.equal(await app.run('transfers[0].customer'), '内部库存');

  /* trSide 两侧均安全：缺省侧返回安全默认值 */
  assert.deepEqual(
    gj(app, 'trSide(transfers[0],"out")'),
    { orderId: OINV, orderType: 'inv', lineIdx: 0, productId: 'P-A' }
  );
  assert.deepEqual(
    gj(app, 'trSide(transfers[0],"in")'),
    { orderId: '', orderType: '', lineIdx: -1, productId: '' },
    '缺省侧必须返回 {orderId:"",orderType:"",lineIdx:-1,productId:""}（不得 undefined 传染）'
  );
  app.dispose();
});

test('A2 盘盈单边：反向全部成立（存在侧在 in、已交付↑、投影↑、缺省侧为空串/null）', async () => {
  const app = boot(mainSeed());
  const moves = [
    { out: null, in: { orderId: OINV, orderType: 'inv', lineIdx: 1 }, qty: 5, type: 'adjust_in', remark: '' },
  ];
  assert.equal(await apply(app, null, moves), true);

  assert.equal(await app.run('orders[0].items[1].deliveredQty'), 25, '盘盈 = 已交付 + qty（20→25）');
  assert.equal(await app.run('products[1].stock'), 25, '库存投影同步（P-B 20→25）');
  assert.equal(await app.run('products[0].stock'), 40, '未涉及行不变');

  assert.equal(await app.run('transfers[0].type'), 'adjust_in');
  assert.equal(await app.run('transfers[0].inOrderId'), OINV, '存在侧在调入订单');
  assert.equal(await app.run('transfers[0].inOrderType'), 'inv');
  assert.equal(await app.run('transfers[0].inLineIdx'), 1);
  assert.equal(await app.run('transfers[0].inProductId'), 'P-B');
  /* 缺省侧（out）空串 / null */
  assert.equal(await app.run('transfers[0].outOrderId'), '');
  assert.equal(await app.run('transfers[0].outOrderType'), '');
  assert.equal(await app.run('transfers[0].outLineIdx'), null);
  assert.equal(await app.run('transfers[0].outProductId'), '');
  /* remark 缺省空串（便于既有类型/未填原因一致） */
  assert.equal(await app.run('transfers[0].remark'), '');
  assert.deepEqual(gj(app, 'trSide(transfers[0],"out")'), { orderId: '', orderType: '', lineIdx: -1, productId: '' });
  assert.deepEqual(gj(app, 'trSide(transfers[0],"in")'), { orderId: OINV, orderType: 'inv', lineIdx: 1, productId: 'P-B' });
  app.dispose();
});

test('A3 一次调用多行混合（盘亏+盘盈）：只驱动填写的两侧，填 0 行不动', async () => {
  const app = boot(mainSeed());
  const moves = [
    { out: { orderId: OINV, orderType: 'inv', lineIdx: 0 }, in: null, qty: 10, type: 'adjust_out', remark: '混合' },
    { out: null, in: { orderId: OINV, orderType: 'inv', lineIdx: 1 }, qty: 7, type: 'adjust_in', remark: '混合' },
  ];
  assert.equal(await apply(app, null, moves), true);
  assert.equal(await app.run('orders[0].items[0].deliveredQty'), 30, 'L0 盘亏 40−10');
  assert.equal(await app.run('orders[0].items[1].deliveredQty'), 27, 'L1 盘盈 20+7');
  assert.equal(await app.run('products[0].stock'), 30);
  assert.equal(await app.run('products[1].stock'), 27);
  assert.equal(await app.run('transfers.length'), 2, '两行各产生 1 条单边台账');
  assert.deepEqual(gj(app, 'transfers.map(function(t){return t.type;})'), ['adjust_in', 'adjust_out'], 'unshift 顺序：后处理行在前');
  assert.equal(await app.run('transfers[0].remark'), '混合');
  assert.equal(await app.run('transfers[1].remark'), '混合');
  app.dispose();
});

/* ================================================================
   §B 盘亏致负（欠货）
   ================================================================ */

test('B1 盘亏致负：deliveredQty 为负（欠货）+ 投影随之下降 + 不抛错', async () => {
  const app = boot({
    orders: [invOrder(OINV, [{ pid: 'P-A', qty: 100, dv: 10 }])],
    products: [mkProd('P-A', 10)],
  });
  const moves = [
    { out: { orderId: OINV, orderType: 'inv', lineIdx: 0 }, in: null, qty: 30, type: 'adjust_out', remark: '盘亏超量' },
  ];
  assert.equal(await apply(app, null, moves), true, '盘亏允许超已交付（欠货）');
  assert.equal(await app.run('orders[0].items[0].deliveredQty'), -20, '10 − 30 = −20（欠货）');
  assert.equal(await app.run('products[0].stock'), -20, '库存投影可为负');
  assert.equal(await app.run('transfers[0].qty'), 30, 'qty 仍恒正（方向由 type 表达）');
  app.dispose();
});

test('B2 盘亏使「未交付 ≤ 0」→ 状态不变；盘盈使「未交付 ≤ 0」→ 自动置「已完成」', async () => {
  /* 盘盈补满：stockMax 30 / 已交付 20 → 盘盈 10 → 未交付 0 → 已完成 */
  const a = boot({ orders: [invOrder(OINV, [{ pid: 'P-A', qty: 30, dv: 20 }])], products: [mkProd('P-A', 20)] });
  assert.equal(await a.run('orders[0].status'), '执行中');
  assert.equal(await apply(a, null, [{ out: null, in: { orderId: OINV, orderType: 'inv', lineIdx: 0 }, qty: 10, type: 'adjust_in' }]), true);
  assert.equal(await a.run('orders[0].status'), '已完成', '盘盈补满后自动态规则置「已完成」');
  a.dispose();
});

/* ================================================================
   §C 事务形状
   ================================================================ */

test('B3 盘亏后 .141 恒等式「已交付 + 已计划未交付 = 结余」仍成立，且交付/排产侧（pu map）零扰动', async () => {
  const DL = 'JFJH-20260829-00001';
  const app = boot({
    orders: [invOrder(OINV, [{ pid: 'P-A', qty: 100, dv: 40 }])],
    products: [mkProd('P-A', 40)],
    deliveries: [
      {
        orderId: OINV, customer: '内部库存', createdAt: '2026-08-29', planNo: DL,
        items: [{ productId: 'P-A', productName: 'P-A', spec: '', model: '', orderQty: 60, deliveredQty: 0, planQty: 60, orderLine: 0 }],
      },
    ],
    productionPlans: [
      {
        id: 'PSCD-20260901-001', deliveryIdx: 0, deliveryPlanNo: DL, orderId: OINV,
        customer: '内部库存', finalDate: '', planDate: '2026-09-01', status: '已完成', notes: '',
        items: [{ productId: 'P-A', productName: 'P-A', spec: '', model: '', unit: '台', planQty: 60, doneQty: 40, dlLine: 0, steps: null, stepsDef: null }],
      },
    ],
  });
  const puBefore = gj(app, 'buildPlannedUndelMap()');
  const puOf = 'invPuOf(buildPlannedUndelMap(),' + J(OINV) + ',0,"P-A")';
  assert.equal(await app.run('invPlannedUndelOf(' + puOf + ')'), 20, '已计划未交付 = 计划 60 − 入库 40');
  assert.equal(
    await app.run('invBalanceOf(orders[0].items[0].deliveredQty,' + puOf + ')'),
    await app.run('num(orders[0].items[0].deliveredQty)+invPlannedUndelOf(' + puOf + ')'),
    '（前置）恒等式成立'
  );

  assert.equal(await apply(app, null, [{ out: { orderId: OINV, orderType: 'inv', lineIdx: 0 }, in: null, qty: 10, type: 'adjust_out' }]), true);

  const puAfter = gj(app, 'buildPlannedUndelMap()');
  assert.deepEqual(puAfter, puBefore, '盘亏不改变交付/排产侧（plan/done 零扰动）');
  assert.equal(await app.run('orders[0].items[0].deliveredQty'), 30, '已交付 40−10');
  assert.equal(await app.run('invPlannedUndelOf(' + puOf + ')'), 20, '已计划未交付不变');
  assert.equal(
    await app.run('invBalanceOf(orders[0].items[0].deliveredQty,' + puOf + ')'),
    await app.run('num(orders[0].items[0].deliveredQty)+invPlannedUndelOf(' + puOf + ')'),
    '盘亏后恒等式「已交付 + 已计划未交付 = 结余」仍严格成立'
  );
  assert.equal(await app.run('invBalanceOf(orders[0].items[0].deliveredQty,' + puOf + ')'), 50, '结余 30 + 20');
  app.dispose();
});

test('B4 行为记录：已完成的库存订单仍可继续盘亏，且盘亏后订单状态被自动规则改回「执行中」', async () => {
  /* 口径未禁止对「已完成」单做库存调整（只禁「已取消/已暂停」）；本用例**只记录实测行为**，
     供主理人判断是否符合业务预期（不擅自改代码）。 */
  const app = boot({ orders: [invOrder(OINV, [{ pid: 'P-A', qty: 30, dv: 30 }], { status: '已完成' })], products: [mkProd('P-A', 30)] });
  assert.equal(await apply(app, null, [{ out: { orderId: OINV, orderType: 'inv', lineIdx: 0 }, in: null, qty: 5, type: 'adjust_out' }]), true);
  assert.equal(await app.run('orders[0].items[0].deliveredQty'), 25, '已完成单未被拦截，可继续盘亏');
  assert.equal(await app.run('orders[0].status'), '执行中', '盘亏使未交付 > 0 → 自动规则把「已完成」改回「执行中」');
  assert.equal(app.alerts.length, 0, '全过程无拦截提示');
  app.dispose();
});


test('C1 盘亏一次调整 = 恰好 1 次 /api/tx，ops 含 orders + transfers（投影有变化 → 含 products）', async () => {
  const app = boot(mainSeed());
  assert.equal(await apply(app, null, [{ out: { orderId: OINV, orderType: 'inv', lineIdx: 0 }, in: null, qty: 5, type: 'adjust_out' }]), true);
  assert.equal(app.recorder.txCount(), 1, '恰好一次事务');
  assert.equal(app.recorder.writeCount(), 1, '不得出现任何独立 save/DB.set');
  assert.deepEqual(plain(app.recorder.lastTx().keys), ['orders', 'transfers', 'products'], '事实表 + 派生投影同批');
  app.dispose();
});

test('C2 投影无变化 → products 不进入事务（仅 [orders, transfers]）', async () => {
  const app = boot({ orders: [invOrder(OINV, [{ pid: 'P-A', qty: 100, dv: 40 }])], products: [] });
  assert.equal(await apply(app, null, [{ out: { orderId: OINV, orderType: 'inv', lineIdx: 0 }, in: null, qty: 6, type: 'adjust_out' }]), true);
  assert.equal(app.recorder.txCount(), 1);
  assert.deepEqual(plain(app.recorder.lastTx().keys), ['orders', 'transfers'], '无投影变化则不空跑 products');
  app.dispose();
});

test('C3 失败（/api/tx 500）→ 整批未生效、只有 1 次请求、业务内存回灌为服务器真值', async () => {
  const seed = mainSeed();
  const app = createApp({ installRecorder: false, quietConsole: true });
  const stub = createFetchStub({
    '/api/tx': { status: 500, body: { error: '持久化失败' } },
    '/api/save': { status: 200, body: { ok: true, rev: 2 } },
    '/api/data': {
      status: 200,
      body: { data: { orders: seed.orders, transfers: [], products: seed.products, logs: [] }, revs: { orders: 1, transfers: 1, products: 1 } },
    },
  });
  app.setFetch(stub);
  app.setGlobals(
    Object.assign({ currentUser: ADMIN, authToken: 'tok-1', serverData: {}, serverRevs: { orders: 1, transfers: 1, products: 1 }, renderContent: function () {}, renderAll: function () {} },
      JSON.parse(JSON.stringify(seed)))
  );
  const ok = await apply(app, null, [{ out: { orderId: OINV, orderType: 'inv', lineIdx: 0 }, in: null, qty: 15, type: 'adjust_out' }]);
  assert.equal(ok, false, '任一步失败必须返回 false');
  const txCalls = stub.callsTo('/api/tx');
  assert.equal(txCalls.length, 1, '整批只发一次 /api/tx（绝不拆分重发）');
  assert.deepEqual(plain(txCalls[0].body.ops.map(function (o) { return o.key; })), ['orders', 'transfers', 'products'], '一次请求携带全部 op');
  /* 失败后无事实表的独立 save */
  const factWrites = stub.calls.filter(function (c) { return c.path === '/api/save' && ['orders', 'transfers', 'products'].indexOf(c.body && c.body.key) >= 0; });
  assert.deepEqual(plain(factWrites), [], '失败后不得再有事实表独立写');
  /* 内存已回灌为服务器真值（不再残留乐观变更 25） */
  assert.equal(await app.run('orders[0].items[0].deliveredQty'), 40, '内存：已回灌为服务器真值 40');
  assert.equal(await app.run('transfers.length'), 0, '内存：台账未残留半条');
  assert.equal(app.alerts.length, 0, 'applyTransfers 自身静默（提示由调用方统一负责）');
  app.dispose();
});

/* ================================================================
   §D 冲销
   ================================================================ */

async function seedAdjustOut(app) {
  assert.equal(
    await apply(app, null, [{ out: { orderId: OINV, orderType: 'inv', lineIdx: 0 }, in: null, qty: 30, type: 'adjust_out', remark: '盘点差异' }]),
    true
  );
  await tick(); /* 使后续冲销记录的 id 与原记录不同（见 R2 说明） */
  return app.run('transfers[0].id');
}

test('D1 冲销单边：类型翻转 adjust_out→adjust_in、reverseOf 指向原记录、数量回滚、(冲销) 角标', async () => {
  const app = boot(mainSeed());
  const tid = await seedAdjustOut(app);
  app.recorder.reset();

  await app.run('reverseTransfer(' + J(tid) + ')');

  assert.equal(await app.run('transfers.length'), 2, '台账新增 1 条反向记录');
  const rev = gj(app, 'transfers.find(function(t){return t.reverseOf===' + J(tid) + ';})');
  assert.equal(rev.type, 'adjust_in', 'adjust_out 反向 = adjust_in');
  assert.equal(rev.inOrderId, OINV, '反向记录仍为单边（存在侧 in）');
  assert.equal(rev.outOrderId, '', '反向记录缺省侧为空串');
  assert.equal(rev.qty, 30, '反向数量相同');
  assert.equal(rev.remark, '盘点差异', '冲销沿用原记录备注');
  assert.equal(await app.run('transfers.find(function(t){return t.id===' + J(tid) + ';}).reversed'), true, '原记录 reversed=true');
  assert.equal(await app.run('orders[0].items[0].deliveredQty'), 40, '数量已回滚至 40');
  assert.equal(await app.run('products[0].stock'), 40, '投影随之回滚');
  assert.equal(app.recorder.txCount(), 1, '冲销同样只写一次事务');
  /* (冲销) 角标：renderTransfers 对带 reverseOf 的记录追加该角标 */
  const html = await app.run('renderTransfers()');
  assert.match(String(html), /\(冲销\)/, '反向记录渲染带 (冲销) 角标');
  app.dispose();
});

test('D2 重复冲销被拒：对已 reversed 的原记录再次冲销 → alert 且不新增记录、不改数量', async () => {
  const app = boot(mainSeed());
  const tid = await seedAdjustOut(app);
  await app.run('reverseTransfer(' + J(tid) + ')');
  const before = await app.run('transfers.length');
  app.alerts.length = 0;

  await app.run('reverseTransfer(' + J(tid) + ')');

  assert.equal(app.alerts.length, 1, '必须提示');
  assert.match(app.alerts[0], /已冲销/);
  assert.equal(await app.run('transfers.length'), before, '不得新增记录');
  assert.equal(await app.run('orders[0].items[0].deliveredQty'), 40, '数量不得二次变动');
  app.dispose();
});

test('D3 二次冲销幂等：冲销的冲销回到原类型（adjust_in → adjust_out）并再回滚一次', async () => {
  const app = boot(mainSeed());
  const tid = await seedAdjustOut(app);
  await app.run('reverseTransfer(' + J(tid) + ')');
  assert.equal(await app.run('orders[0].items[0].deliveredQty'), 40);

  const revId = await app.run('transfers.find(function(t){return t.reverseOf===' + J(tid) + ';}).id');
  await app.run('reverseTransfer(' + J(revId) + ')');

  assert.equal(await app.run('transfers.length'), 3, '生成第二条反向记录');
  assert.equal(await app.run('transfers[0].type'), 'adjust_out', '冲销的冲销类型回到 adjust_out');
  assert.equal(await app.run('transfers[0].reverseOf'), revId, 'reverseOf 指向被冲销的反向记录');
  assert.equal(await app.run('orders[0].items[0].deliveredQty'), 10, '10 → 40 → 10（幂等反向，不漂移）');
  assert.equal(await app.run('products[0].stock'), 10);
  assert.equal(await app.run('trRevType("adjust_out")'), 'adjust_in');
  assert.equal(await app.run('trRevType("adjust_in")'), 'adjust_out');
  assert.equal(await app.run('trRevType(trRevType("adjust_out"))'), 'adjust_out', '二次反向回原类型');
  app.dispose();
});

test('D4 冲销盘盈：adjust_in → adjust_out（存在侧从 in 翻到 out），数量回滚', async () => {
  const app = boot(mainSeed());
  assert.equal(await apply(app, null, [{ out: null, in: { orderId: OINV, orderType: 'inv', lineIdx: 1 }, qty: 5, type: 'adjust_in', remark: '找料补录' }]), true);
  assert.equal(await app.run('orders[0].items[1].deliveredQty'), 25);
  const tid = await app.run('transfers[0].id');
  await tick();

  await app.run('reverseTransfer(' + J(tid) + ')');

  const rev = gj(app, 'transfers.find(function(t){return t.reverseOf===' + J(tid) + ';})');
  assert.equal(rev.type, 'adjust_out');
  assert.equal(rev.outOrderId, OINV, '反向存在侧为 out');
  assert.equal(rev.inOrderId, '');
  assert.equal(await app.run('orders[0].items[1].deliveredQty'), 20, '盘盈已回滚');
  app.dispose();
});

/* ================================================================
   §E 防御与校验层
   ================================================================ */

test('E1 防御：moves 双侧皆 null → false 且零写入', async () => {
  const app = boot(mainSeed());
  const moves = [{ out: null, in: null, qty: 5, type: 'adjust_out' }];
  assert.equal(await apply(app, null, moves), false, '双边皆空 = 非法整批放弃');
  assert.equal(app.recorder.writeCount(), 0, '零写入');
  assert.equal(app.recorder.txCount(), 0);
  assert.equal(await app.run('transfers.length'), 0);
  assert.equal(await app.run('orders[0].items[0].deliveredQty'), 40, '内存未被改');
  assert.equal(app.alerts.length, 0, '底层静默');
  app.dispose();
});

test('E2 防御：空 moves 数组 → false 零写；存在侧订单/明细不存在 → false 零写', async () => {
  const app = boot(mainSeed());
  assert.equal(await apply(app, null, []), false);
  assert.equal(app.recorder.writeCount(), 0);
  assert.equal(await apply(app, null, [{ out: { orderId: 'NO-SUCH', orderType: 'inv', lineIdx: 0 }, in: null, qty: 1, type: 'adjust_out' }]), false);
  assert.equal(await apply(app, null, [{ out: null, in: { orderId: OINV, orderType: 'inv', lineIdx: 9 }, qty: 1, type: 'adjust_in' }]), false);
  assert.equal(app.recorder.writeCount(), 0, '校验失败必须一字不写');
  app.dispose();
});

/* ---- 校验层（openInvAdjust）：DOM/alert 依赖，用沙箱注入桩实测 ---- */

/** 让 selSet('order_inv') 指向指定行号（字符串索引） */
function selectInv(app, idxs) {
  app.run('selRows={order_inv:new Set(' + J(idxs.map(String)) + ')}');
}

test('E3 校验层：0 条选择 → 拒绝并提示，不打开弹窗', () => {
  const app = boot(mainSeed());
  const opens = [];
  app.setGlobal('showModal', function (t) { opens.push(t); });
  selectInv(app, []);
  app.run('openInvAdjust()');
  assert.equal(opens.length, 0, '不得打开弹窗');
  assert.equal(app.alerts.length, 1);
  assert.match(app.alerts[0], /请先勾选 1 张库存订单/);
  app.dispose();
});

test('E4 校验层：>1 条选择 → 拒绝（提示已选 N 张），不打开弹窗', () => {
  const app = boot({
    orders: [invOrder(OINV, [{ pid: 'P-A', qty: 10, dv: 1 }]), invOrder('KCDD-2', [{ pid: 'P-B', qty: 10, dv: 1 }])],
    products: [],
  });
  const opens = [];
  app.setGlobal('showModal', function (t) { opens.push(t); });
  selectInv(app, [0, 1]);
  app.run('openInvAdjust()');
  assert.equal(opens.length, 0);
  assert.equal(app.alerts.length, 1);
  assert.match(app.alerts[0], /只能选择 1 张库存订单/);
  assert.match(app.alerts[0], /2/);
  app.dispose();
});

test('E5 校验层：选中销售订单 → 拒绝（仅库存订单）', () => {
  const app = boot(mainSeed());
  const opens = [];
  app.setGlobal('showModal', function (t) { opens.push(t); });
  selectInv(app, [1]); /* index 1 = 销售订单 OSALE */
  app.run('openInvAdjust()');
  assert.equal(opens.length, 0);
  assert.equal(app.alerts.length, 1);
  assert.match(app.alerts[0], /仅适用于库存订单/);
  app.dispose();
});

test('E6 校验层：已取消 / 已暂停 订单 → 拒绝', () => {
  ['已取消', '已暂停'].forEach(function (st) {
    const app = boot({ orders: [invOrder(OINV, [{ pid: 'P-A', qty: 10, dv: 1 }], { status: st })], products: [] });
    const opens = [];
    app.setGlobal('showModal', function (t) { opens.push(t); });
    selectInv(app, [0]);
    app.run('openInvAdjust()');
    assert.equal(opens.length, 0, st + '：不得打开弹窗');
    assert.equal(app.alerts.length, 1);
    assert.match(app.alerts[0], new RegExp('已' + st + '，无法库存调整'));
    app.dispose();
  });
});

test('E7 校验层：无 invAdjust 动作权限的普通员工 → 被 needAct 拦下（不打开弹窗）', () => {
  const app = boot(mainSeed(), undefined);
  app.setGlobal('currentUser', { username: 'u1', name: '员工甲', role: 'employee', perms: { invOrders: true, acts: { invCall: true } } });
  const opens = [];
  app.setGlobal('showModal', function (t) { opens.push(t); });
  selectInv(app, [0]);
  app.run('openInvAdjust()');
  assert.equal(opens.length, 0, '无按钮权限不得打开弹窗');
  assert.equal(app.alerts.length, 1);
  assert.match(app.alerts[0], /无此按钮权限|按钮权限/);
  app.dispose();
});

/* ================================================================
   §F 弹窗构建（openInvAdjust / doInvAdjust）
   ================================================================ */

test('F1 openInvAdjust：列出全部明细行（含填 0 不动的行）、每行盘亏/盘盈下拉 + 数量输入、顶部「调整原因」、确认回调 doInvAdjust', () => {
  const app = boot(mainSeed());
  let cap = null;
  app.setGlobal('showModal', function (t, b, f) { cap = { t: t, b: b, f: f }; });
  selectInv(app, [0]);
  app.run('openInvAdjust()');

  assert.ok(cap, '应打开弹窗');
  assert.match(cap.t, /库存调整/);
  assert.match(cap.b, /P-A/);
  assert.match(cap.b, /P-B/, '第二条明细行也要列出（填 0 的行不动 ≠ 不列出）');
  assert.equal((cap.b.match(/class="ia-dir"/g) || []).length, 2, '每行一个方向下拉');
  assert.match(cap.b, /<option value="out">盘亏<\/option><option value="in">盘盈<\/option>/);
  assert.equal((cap.b.match(/class="ia-qty"/g) || []).length, 2, '每行一个数量输入');
  assert.match(cap.b, /id="iaRemark"/, '顶部调整原因输入存在');
  assert.match(cap.b, /调整原因/, '调整原因有标签');
  assert.match(cap.f, /doInvAdjust\(\)/, '确认按钮回调 doInvAdjust');
  assert.equal(app.alerts.length, 0);
  app.dispose();
});

/**
 * 为 doInvAdjust 注入最小 DOM：.ia-qty 输入集合 / .ia-dir 方向选择 / #iaRemark 文本框。
 * ⚠ 沙箱 document 的 getElementById/querySelector(All) 默认恒返回 null/[]（设计 §6.2 不可测边界），
 *    这里替换为测试桩，从而**真实驱动**生产 doInvAdjust 的 moves 组装逻辑（非静态断言降级）。
 */
function injectAdjustDom(app, rows, remark) {
  const doc = app.browser.document;
  doc.querySelectorAll = function (sel) {
    if (sel === '.ia-qty') return rows.map(function (r) { return { dataset: { li: String(r.li) }, value: String(r.qty) }; });
    return [];
  };
  doc.querySelector = function (sel) {
    const m = /\.ia-dir\[data-li="(\d+)"\]/.exec(sel);
    if (m) {
      const dir = rows.filter(function (r) { return String(r.li) === m[1]; })[0];
      return { value: (dir && dir.dir) || 'out' };
    }
    return null;
  };
  doc.getElementById = function (id) {
    if (id === 'iaRemark') return { value: remark === undefined ? '' : remark };
    return null; /* modalBg → closeModal 安全；本路径不调 showModal */
  };
}

test('F2 doInvAdjust：填 0 的行不产生 move；盘亏=仅 out、盘盈=仅 in；remark 写入台账', async () => {
  const app = boot(mainSeed());
  app.run('__iaOrder=orders[0];__iaLines=[{i:0},{i:1}];');
  injectAdjustDom(app, [{ li: 0, qty: 12, dir: 'out' }, { li: 1, qty: 0, dir: 'in' }], '季度盘点');
  await app.run('doInvAdjust()');

  assert.equal(await app.run('transfers.length'), 1, '填 0 的行不产生台账（只 1 条）');
  assert.equal(await app.run('transfers[0].type'), 'adjust_out');
  assert.equal(await app.run('transfers[0].qty'), 12);
  assert.equal(await app.run('transfers[0].remark'), '季度盘点');
  assert.equal(await app.run('orders[0].items[0].deliveredQty'), 28, '40−12');
  assert.equal(await app.run('orders[0].items[1].deliveredQty'), 20, '填 0 的行不动');
  assert.equal(app.recorder.txCount(), 1, '一次调整一次事务');
  app.dispose();
});

test('F3 doInvAdjust：盘盈方向（dir=in）→ 单边 in、已交付↑', async () => {
  const app = boot(mainSeed());
  app.run('__iaOrder=orders[0];__iaLines=[{i:0},{i:1}];');
  injectAdjustDom(app, [{ li: 0, qty: 3, dir: 'in' }, { li: 1, qty: 0, dir: 'out' }], '');
  await app.run('doInvAdjust()');
  assert.equal(await app.run('transfers[0].type'), 'adjust_in');
  assert.equal(await app.run('transfers[0].inOrderId'), OINV);
  assert.equal(await app.run('transfers[0].outOrderId'), '');
  assert.equal(await app.run('orders[0].items[0].deliveredQty'), 43, '40+3');
  app.dispose();
});

test('F4 doInvAdjust：全填 0 → alert「未填写任何调整数量」，零写入', async () => {
  const app = boot(mainSeed());
  app.run('__iaOrder=orders[0];__iaLines=[{i:0},{i:1}];');
  injectAdjustDom(app, [{ li: 0, qty: 0, dir: 'out' }, { li: 1, qty: 0, dir: 'in' }], '');
  await app.run('doInvAdjust()');
  assert.equal(app.recorder.writeCount(), 0, '零写入');
  assert.equal(app.alerts.length, 1);
  assert.match(app.alerts[0], /未填写任何调整数量/);
  app.dispose();
});

test('F5 doInvAdjust：负数数量 → alert 且整批不写（不半提交）', async () => {
  const app = boot(mainSeed());
  app.run('__iaOrder=orders[0];__iaLines=[{i:0},{i:1}];');
  injectAdjustDom(app, [{ li: 0, qty: 5, dir: 'out' }, { li: 1, qty: -3, dir: 'in' }], '');
  await app.run('doInvAdjust()');
  assert.equal(app.recorder.writeCount(), 0, '含非法行时整批不写');
  assert.equal(await app.run('transfers.length'), 0);
  assert.equal(await app.run('orders[0].items[0].deliveredQty'), 40, '合法行不得先落一半');
  assert.match(app.alerts[0], /不可为负/);
  app.dispose();
});

test('F6 弹窗不重复联动：applyTransfers 内部已联动，调用方不得再调（源码级）', () => {
  /* doInvAdjust 正文不得出现 recompute* 调用（联动只由 applyTransfers 内部完成） */
  function extractFn(src, name) {
    const re = new RegExp('function\\s+' + name + '\\s*\\(', 'g');
    const m = re.exec(src);
    if (!m) throw new Error('未找到函数: ' + name);
    let p = m.index + m[0].length, d = 1;
    for (; p < src.length; p++) { if (src[p] === '(') d++; else if (src[p] === ')') { d--; if (d === 0) break; } }
    const i = src.indexOf('{', p); let j = i; d = 0;
    for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (d === 0) break; } }
    return src.slice(m.index, j + 1);
  }
  [extractFn(SRC_TRANSFER, 'doInvAdjust'), extractFn(SRC_TRANSFER, 'doInvAdjust'), extractFn(SRC_TRANSFER, 'openInvAdjust')].forEach(function (body) {
    assert.doesNotMatch(body, /recomputeStockFromInvOrders|recomputeOrderAutoStatus|syncStockFromInvOrders|syncOrderAutoStatus/, '调用方不得重复联动');
  });
  assert.match(extractFn(SRC_TRANSFER, 'doInvAdjust'), /applyTransfers\s*\(\s*null\s*,/, '必须经 applyTransfers 落盘');
});

/* ================================================================
   §G 台账渲染 / 查询 / 筛选 / 排序
   ================================================================ */

/** 单边盘亏记录（新结构） + 一条真实跨料 conv 记录（对照，证明 cross 断言有判别力） */
function renderSeed() {
  return {
    orders: [
      invOrder(OINV, [{ pid: 'P-A', qty: 100, dv: 40 }]),
      invOrder('KCDD-INV-B', [{ pid: 'P-B', qty: 50, dv: 10 }]),
    ],
    products: [mkProd('P-A', 40), mkProd('P-B', 10)],
    transfers: [
      /* 盘亏：仅 out */
      {
        id: 'TR-A1', type: 'adjust_out', qty: 30, ts: '2026-10-10 10:00:00', user: 'PMC小张', reversed: false, reverseOf: null,
        outOrderId: OINV, outOrderType: 'inv', outLineIdx: 0, outProductId: 'P-A',
        inOrderId: '', inOrderType: '', inLineIdx: null, inProductId: '', remark: '盘点差异',
        customer: '内部库存', contractNo: '', productName: 'P-A', spec: '', model: '',
      },
      /* 盘盈：仅 in */
      {
        id: 'TR-A2', type: 'adjust_in', qty: 5, ts: '2026-10-10 10:05:00', user: 'PMC小张', reversed: false, reverseOf: null,
        outOrderId: '', outOrderType: '', outLineIdx: null, outProductId: '',
        inOrderId: OINV, inOrderType: 'inv', inLineIdx: 0, inProductId: 'P-A', remark: '找料补录',
        customer: '内部库存', contractNo: '', productName: 'P-A', spec: '', model: '',
      },
      /* 真实跨料 conv（对照） */
      {
        id: 'TR-C1', type: 'conv', qty: 3, ts: '2026-10-10 09:00:00', user: 'PMC小张', reversed: false, reverseOf: null,
        outOrderId: 'KCDD-INV-B', outOrderType: 'inv', outLineIdx: 0, outProductId: 'P-B',
        inOrderId: OINV, inOrderType: 'inv', inLineIdx: 0, inProductId: 'P-A', remark: '',
        customer: '内部库存', contractNo: '', productName: 'P-A', spec: '', model: '',
      },
    ],
  };
}

test('G1 renderTransfers：单边记录缺省侧显示「—」，存在侧显示订单号；料号回退存在侧；cross 红字不误触发', async () => {
  const app = boot(renderSeed());
  const html = String(await app.run('renderTransfers()'));

  /* 行切分：按 data-key 单元格提取，避免误伤表头 */
  const trs = html.split('<tr>').filter(function (r) { return r.indexOf('<td data-key="ts"') >= 0; });
  assert.equal(trs.length, 3, '3 条记录各 1 行');

  function cells(tr) {
    const out = {};
    const re = /<td data-key="([^"]+)"[^>]*>([\s\S]*?)<\/td>/g;
    let m;
    while ((m = re.exec(tr)) !== null) out[m[1]] = m[2];
    return out;
  }
  const a1 = cells(trs.filter(function (r) { return r.indexOf('TR-A1') >= 0; })[0]);
  const a2 = cells(trs.filter(function (r) { return r.indexOf('TR-A2') >= 0; })[0]);
  const c1 = cells(trs.filter(function (r) { return r.indexOf('TR-C1') >= 0; })[0]);

  assert.equal(a1.outOrderId, OINV, '盘亏：调出订单 = 本单');
  assert.equal(a1.inOrderId, '—', '盘亏：缺省调入订单显示「—」');
  assert.equal(a1.productId, 'P-A', '盘亏：料号回退调出侧');
  assert.doesNotMatch(a1.productId, /←调出/, '盘亏（单边）不得误触发跨料红字');

  assert.equal(a2.inOrderId, OINV, '盘盈：调入订单 = 本单');
  assert.equal(a2.outOrderId, '—', '盘盈：缺省调出订单显示「—」');
  assert.equal(a2.productId, 'P-A', '盘盈：料号回退存在侧（in）');
  assert.doesNotMatch(a2.productId, /←调出/, '盘盈（单边）不得误触发跨料红字');
  assert.match(a1.remark, /盘点差异/, '备注列渲染 remark');
  assert.match(a2.remark, /找料补录/);
  assert.match(a1.type, /tag-red/);
  assert.match(a2.type, /tag-green/);
  assert.match(a1.type, /盘亏/);
  assert.match(a2.type, /盘盈/);

  /* 判别力对照：真实跨料记录必须触发红字（否则上面的 doesNotMatch 是恒真） */
  assert.match(c1.productId, /←调出/, '跨料 conv 必须触发「←调出」红字（证明断言有判别力）');
  app.dispose();
});

test('G2 空态 colspan 与表头列数一致（= TBL_SCHEMAS.transfers.length + 1 操作列）', async () => {
  const app = boot({ orders: [], products: [], transfers: [] });
  const html = String(await app.run('renderTransfers()'));
  const n = await app.run('TBL_SCHEMAS.transfers.length');
  const thCount = (html.match(/<th[\s>]/g) || []).length;
  assert.equal(thCount, n + 1, '表头列数 = 台账列数 + 操作列');
  assert.match(html, new RegExp('colspan="' + (n + 1) + '"'), '空态 colspan 必须 = 表头列数');
  assert.equal(n + 1, 14, '口径：13 业务列 + 1 操作列 = 14');
  app.dispose();
});

test('G3 备注列已注册：TBL_SCHEMAS.transfers 含 {key:"remark",label:"备注"}，且顺序在「数量」与「操作人」之间', async () => {
  const app = boot({ orders: [], products: [], transfers: [] });
  await app.run('renderTransfers()');
  const keys = gj(app, 'TBL_SCHEMAS.transfers.map(function(c){return c.key;})');
  assert.deepEqual(keys, ['ts', 'type', 'outOrderId', 'inOrderId', 'customer', 'contractNo', 'productName', 'spec', 'model', 'productId', 'qty', 'remark', 'user']);
  assert.equal(await app.run('TBL_SCHEMAS.transfers.filter(function(c){return c.key==="remark";})[0].label'), '备注');
  app.dispose();
});

test('G4 表头筛选：按备注列 contains 过滤（新列参与筛选引擎，不抛错）', async () => {
  const app = boot(renderSeed());
  await app.run('renderTransfers()');
  app.run('tState("transfers").filters={remark:{mode:"contains",val:"盘点"}}');
  const rows = gj(app, 'applyTable("transfers",TBL_ROWS.transfers).map(function(r){return r.id;})');
  assert.deepEqual(rows, ['TR-A1'], '备注含「盘点」的只有盘亏记录');
  app.dispose();
});

test('G5 排序：按备注列排序不抛错且顺序正确（新列参与排序引擎）', async () => {
  const app = boot(renderSeed());
  await app.run('renderTransfers()');
  app.run('tState("transfers").filters={};tState("transfers").sort={key:"remark",dir:1}');
  const rows = gj(app, 'applyTable("transfers",TBL_ROWS.transfers).map(function(r){return r.id;})');
  assert.equal(rows.length, 3);
  /* 空备注 '' 排最前，其后 localeCompare('zh-CN')：「找料补录」vs「盘点差异」 */
  assert.equal(rows[0], 'TR-C1', '空备注排最前');
  assert.deepEqual(rows.slice(1).sort(), ['TR-A1', 'TR-A2'], '其余两条按备注本地化排序');
  app.dispose();
});

test('G6 调拨查询 scope：window.transferScopeId = 本单 → 单边记录（out 或 in 命中）被纳入；无关记录被排除', async () => {
  const app = boot(renderSeed());
  app.run('window.transferScopeId=' + J(OINV));
  const ids = gj(app, 'renderTransfers()').match(/TR-[A-Z0-9]+/g) || [];
  const uniq = ids.filter(function (v, i) { return ids.indexOf(v) === i; });
  assert.ok(uniq.indexOf('TR-A1') >= 0, '盘亏（out=本单）应命中');
  assert.ok(uniq.indexOf('TR-A2') >= 0, '盘盈（in=本单）应命中');
  assert.ok(uniq.indexOf('TR-C1') >= 0, 'conv（in=本单）应命中');
  /* 换一个本单：只剩与它相关的 */
  app.run('window.transferScopeId="KCDD-INV-B"');
  const ids2 = (gj(app, 'renderTransfers()').match(/TR-[A-Z0-9]+/g) || []);
  const uniq2 = ids2.filter(function (v, i) { return ids2.indexOf(v) === i; });
  assert.deepEqual(uniq2, ['TR-C1'], '仅 conv（out=KCDD-INV-B）命中，单边盘亏/盘盈不相关被排除');
  app.dispose();
});

test('G7 导出：transfers 无 bulkExport 入口（FORM_ACTIONS 未配置）——新增备注列不涉及导出改动', async () => {
  const app = boot(renderSeed());
  assert.equal(await app.run('typeof FORM_ACTIONS.transfers'), 'undefined', 'transfers 未接入 FORM_ACTIONS');
  app.alerts.length = 0;
  app.run('bulkExport("transfers")');
  assert.equal(app.alerts.length, 0, 'FORM_ACTIONS 无该模块 → bulkExport 静默 return（不抛错、不提示）');
  assert.equal(app.recorder.writeCount(), 0, '未产生任何写入');
  app.dispose();
});

/* ================================================================
   §H 5 处 sales-only 过滤逻辑对单边记录的行为
   ================================================================ */

test('H1 calledQtyNetMap：忽略 adjust_out / adjust_in（销售已调用净额不受影响）', async () => {
  const app = boot(renderSeed());
  const map = gj(app, 'calledQtyNetMap()');
  assert.deepEqual(map, {}, '单边调整记录不参与销售 calledQty 归集');
  app.dispose();
});

test('H2 buildCrossCallMap：忽略单边调整记录（不误报跨料替代）', async () => {
  const app = boot(renderSeed());
  const size = await app.run('buildCrossCallMap().size');
  assert.equal(size, 0, '仅未冲销 call 参与；本夹具无 call → 空 Map');
  /* 加一条真实跨料 call 后应命中 1（证明函数本体工作，而非恒空） */
  app.run(
    'transfers.push({id:"TR-CALLX",type:"call",qty:2,reversed:false,outOrderId:"KCDD-INV-B",outOrderType:"inv",outLineIdx:0,outProductId:"P-B",inOrderId:"XSDD-X",inOrderType:"sales",inLineIdx:0,inProductId:"P-A"});'
  );
  assert.equal(await app.run('buildCrossCallMap().size'), 1, '真实跨料 call 命中（函数本体有判别力）');
  app.dispose();
});

test('H3 guardRemovedOrderLines / remapOrderLineRefs：单边调整记录不阻塞行删除、不被重映射（不抛错）', async () => {
  const app = boot(renderSeed());
  const g = await app.run('guardRemovedOrderLines(orders[0],[])');
  assert.equal(g, null, '单边记录（orderType=inv）不计入销售行引用 → 不阻塞');
  const r = gj(app, 'remapOrderLineRefs(orders[0],[0])');
  assert.deepEqual(r, { oldToNew: { 0: 0 }, tr: 0, dl: 0 }, '不重映射、不抛错');
  app.dispose();
});

test('H4 repairOrphanTransferLineIdx：单边记录被安全跳过（不越界、不改行号、不抛错）', async () => {
  const app = boot(Object.assign(renderSeed(), { meta: {} }));
  const before = gj(app, 'transfers.map(function(t){return t.outLineIdx+"/"+t.inLineIdx;})');
  await app.run('repairOrphanTransferLineIdx()');
  const after = gj(app, 'transfers.map(function(t){return t.outLineIdx+"/"+t.inLineIdx;})');
  assert.deepEqual(after, before, '单边/库存侧记录的 lineIdx 不被改动');
  assert.equal(await app.run('transfers.filter(function(t){return t.reversed;}).length'), 0, '未被误标冲销');
  app.dispose();
});

/* ================================================================
   §I 防回归（既有 call / return / conv / move 逐项一致）
   ================================================================ */

test('I1 call：库存侧 deliveredQty −= q、销售侧 calledQty += q、台账两侧字段齐备、remark 缺省空串', async () => {
  const app = boot(mainSeed());
  const moves = [{ out: { orderId: OINV, orderType: 'inv', lineIdx: 0 }, in: { orderId: OSALE, orderType: 'sales', lineIdx: 0 }, qty: 15 }];
  assert.equal(await apply(app, 'call', moves), true);
  assert.equal(await app.run('orders[0].items[0].deliveredQty'), 25, '40 − 15');
  assert.equal(await app.run('orders[1].items[0].calledQty'), 15, '0 + 15');
  assert.equal(await app.run('orders[1].items[0].deliveredQty'), 0, '销售已交付不随调拨变动（.97）');
  const t = gj(app, 'transfers[0]');
  assert.equal(t.type, 'call');
  assert.equal(t.outOrderId, OINV);
  assert.equal(t.outOrderType, 'inv');
  assert.equal(t.outLineIdx, 0);
  assert.equal(t.outProductId, 'P-A');
  assert.equal(t.inOrderId, OSALE);
  assert.equal(t.inOrderType, 'sales');
  assert.equal(t.inLineIdx, 0);
  assert.equal(t.inProductId, 'P-A');
  assert.equal(t.remark, '', '既有类型 remark 缺省空串（不改变旧结构）');
  assert.equal(t.reverseOf, null);
  assert.equal(t.reversed, false);
  assert.equal(t.user, 'PMC小张');
  /* 快照销售侧优先（客户/合同来自销售订单） */
  assert.equal(t.customer, '华东盘厂');
  assert.equal(t.contractNo, 'HT-' + OSALE);
  app.dispose();
});

test('I2 return：销售侧 max(0, called − q)、库存侧 += q、快照仍销售侧优先', async () => {
  const app = boot(mainSeed());
  app.run('orders[1].items[0].calledQty=4');
  const moves = [{ out: { orderId: OSALE, orderType: 'sales', lineIdx: 0 }, in: { orderId: OINV, orderType: 'inv', lineIdx: 0 }, qty: 6 }];
  assert.equal(await apply(app, 'return', moves), true);
  assert.equal(await app.run('orders[1].items[0].calledQty'), 0, '4 − 6 → 下限 0（语义不变）');
  assert.equal(await app.run('orders[0].items[0].deliveredQty'), 46, '40 + 6');
  const t = gj(app, 'transfers[0]');
  assert.equal(t.type, 'return');
  assert.equal(t.outOrderType, 'sales');
  assert.equal(t.inOrderType, 'inv');
  assert.equal(t.customer, '华东盘厂', '含销售订单 → 快照归属销售侧');
  assert.equal(t.remark, '');
  app.dispose();
});

test('I3 conv（跨料）/ move（同料）：两侧皆库存，库存各加减、台账两侧字段齐备、remark 空串', async () => {
  const app = boot({
    orders: [
      invOrder('INV-A', [{ pid: 'P-A', qty: 100, dv: 100 }]),
      invOrder('INV-B', [{ pid: 'P-B', qty: 50, dv: 0 }]),
    ],
    products: [mkProd('P-A', 100), mkProd('P-B', 0)],
  });
  const conv = [{ out: { orderId: 'INV-A', orderType: 'inv', lineIdx: 0 }, in: { orderId: 'INV-B', orderType: 'inv', lineIdx: 0 }, qty: 30, type: 'conv' }];
  assert.equal(await apply(app, null, conv), true);
  assert.equal(await app.run('orders[0].items[0].deliveredQty'), 70, '调出 −30');
  assert.equal(await app.run('orders[1].items[0].deliveredQty'), 30, '调入 +30');
  assert.equal(await app.run('products[0].stock'), 70);
  assert.equal(await app.run('products[1].stock'), 30);
  let t = gj(app, 'transfers[0]');
  assert.equal(t.type, 'conv');
  assert.equal(t.outProductId, 'P-A');
  assert.equal(t.inProductId, 'P-B');
  assert.equal(t.remark, '');

  /* move：同料号 */
  const mv = [{ out: { orderId: 'INV-A', orderType: 'inv', lineIdx: 0 }, in: { orderId: 'INV-B', orderType: 'inv', lineIdx: 0 }, qty: 10, type: 'move' }];
  assert.equal(await apply(app, null, mv), true);
  t = gj(app, 'transfers[0]');
  assert.equal(t.type, 'move');
  assert.equal(t.remark, '');
  assert.equal(await app.run('orders[0].items[0].deliveredQty'), 60, '70 − 10');
  assert.equal(await app.run('orders[1].items[0].deliveredQty'), 40, '30 + 10');
  app.dispose();
});

/* ================================================================
   §R 独立验收发现的源码缺陷
   · R1 —— 真回归，断言「应有行为」。R1 复现后已由工程师修复
     （js/transfer.js:435-437 → `:(inMv?{o:oi,it:iit}:{o:oo,it:oit})`），
     本用例**保留为强制回归守卫**（不得弱化/跳过），修复后应恒 PASS。
   · R2 —— 既存遗留缺陷（HEAD 同写法），非 .143 引入，已登记 D10 → 本次 skip。
   ================================================================ */

test('R1【回归守卫】conv / move 台账快照必须取「调入侧」——防 .143 引入的「调出侧」误改再犯', async () => {
  /* 依据：applyTransfers 头部注释「台账快照：…纯库存互调→调入侧库存行」，
     且台账「产品/料号」列取的是**调入侧**料号（transfer.js:529）。
     旧实现：const snap=(mv.out.orderType==='sales')?{o:oo,it:oit}:{o:oi,it:iit};
     → conv/move（两侧皆 inv，无 sales）取 **in 侧**。
     .143 曾改为三段式后，两侧皆非 sales 时走 `(outMv?out:in)` → 取 **out 侧**（缺陷，已修复），
     导致台账「客户/商品名称/规格/型号」与「产品/料号」列描述的是**两个不同产品**（账实不符）。
     最小复现（缺陷态）：applyTransfers(null,[{out:{orderId:'INV-A',orderType:'inv',lineIdx:0},in:{orderId:'INV-B',orderType:'inv',lineIdx:0},qty:30,type:'conv'}])
                → transfers[0].productName = 'A品'（调出，错）；料号列 = 'P-B'（调入）→ 自相矛盾。
     HEAD 对照（同沙箱）：HEAD 与修复后均 = {customer:'仓B',productName:'B品',spec:'SB',model:'MB'}。 */
  const app = boot({
    orders: [
      invOrder('INV-A', [{ pid: 'P-A', qty: 100, dv: 100 }], { customer: '仓A' }),
      invOrder('INV-B', [{ pid: 'P-B', qty: 50, dv: 0 }], { customer: '仓B' }),
    ],
    products: [mkProd('P-A', 100), mkProd('P-B', 0)],
  });
  /* 让两侧商品名不同，便于判别取的是哪一侧 */
  app.run('orders[0].items[0].productName="A品";orders[0].items[0].spec="SA";orders[0].items[0].model="MA";');
  app.run('orders[1].items[0].productName="B品";orders[1].items[0].spec="SB";orders[1].items[0].model="MB";');
  const conv = [{ out: { orderId: 'INV-A', orderType: 'inv', lineIdx: 0 }, in: { orderId: 'INV-B', orderType: 'inv', lineIdx: 0 }, qty: 30, type: 'conv' }];
  assert.equal(await apply(app, null, conv), true);

  const t = gj(app, 'transfers[0]');
  const pidCol = await app.run('(function(r){return trSide(r,"in").productId||trSide(r,"out").productId;})(transfers[0])');
  assert.equal(pidCol, 'P-B', '（前置）台账「产品/料号」列 = 调入侧 P-B');
  assert.equal(t.customer, '仓B', '纯库存互调 → 快照客户应取调入侧');
  assert.equal(t.productName, 'B品', '纯库存互调 → 快照商品名应取调入侧');
  assert.equal(t.spec, 'SB');
  assert.equal(t.model, 'MB');
  app.dispose();
});

/* ================================================================
   R2【已登记遗留缺陷 · 本次不修 → skip】
   台账 id = 'TR'+Date.now()+'-'+idx（js/transfer.js:441）缺少唯一性保证：
   同一毫秒内两次 applyTransfers（idx 皆为 0）会得到**完全相同的 id**。
   reverseTransfer 用 transfers.find(x=>x.id===id) 定位 → id 重复时命中 unshift 到最前的新记录，
   原记录 reversed 永不置位、「重复冲销被拒」防线失效、数量可被滚到错误记录。
   性质：**HEAD 既存写法、非 .143 引入、UI 手点路径不可达**（有 confirm + 人手延迟 >> 1ms）。
   处置：已登记遗留待决策 **D10** 上报用户；按项目铁律「额外修正须先经用户同意」**本次不修**，
        故本条改为**带原因的 skip**（保留用例代码与最小复现说明，待 D10 拍板后再启用）。
   最小复现（确定性：固定 vm 内 Date.now 为常量，令两次写入必然同毫秒）：
     同一 tick 连续两次
     applyTransfers(null,[{out:{orderId,orderType:'inv',lineIdx:0},in:null,qty:N,type:'adjust_out'}])
     → transfers[0].id === transfers[1].id（实测 TR1750000000000-0 相同）。
   ================================================================ */
test(
  'R2【已登记遗留缺陷 D10 · skip】相邻两次台账写入不得依赖「不同毫秒」才拿到不同 id（id 唯一性未保证）',
  { skip: '既存缺陷（HEAD 同写法）、非 .143 引入、UI 手点路径不可达；已登记 D10 待用户拍板，本次不修' },
  async () => {
    const app = boot(mainSeed());
    app.run('Date.now=function(){return 1750000000000;};'); /* 固定时钟 → 保证同毫秒 */
    const one = [{ out: { orderId: OINV, orderType: 'inv', lineIdx: 0 }, in: null, qty: 1, type: 'adjust_out' }];
    const two = [{ out: { orderId: OINV, orderType: 'inv', lineIdx: 0 }, in: null, qty: 2, type: 'adjust_out' }];
    await apply(app, null, one);
    await apply(app, null, two);
    const ids = gj(app, 'transfers.map(function(t){return t.id;})');
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1], '两次台账写入必须得到不同 id（唯一性约定；当前实现只在跨毫秒时才成立）');
    app.dispose();
  }
);

test('I4 trSide 一字节未变：既有旧结构推导与新增单边安全默认值并存', async () => {
  const app = boot(mainSeed());
  /* 旧结构 call（无 out/in 方向字段）仍按 type 推导 */
  assert.deepEqual(
    gj(app, 'trSide({type:"call",invOrderId:"O-INV",invLineIdx:1,invProductId:"PI",salesOrderId:"O-SALE",salesLineIdx:2,productId:"PS"},"out")'),
    { orderId: 'O-INV', orderType: 'inv', lineIdx: 1, productId: 'PI' }
  );
  assert.deepEqual(
    gj(app, 'trSide({type:"return",invOrderId:"O-INV",invLineIdx:1,invProductId:"PI",salesOrderId:"O-SALE",salesLineIdx:2,productId:"PS"},"in")'),
    { orderId: 'O-INV', orderType: 'inv', lineIdx: 1, productId: 'PI' }
  );
  /* 空/非法记录安全默认值 */
  assert.deepEqual(gj(app, 'trSide(null,"out")'), { orderId: '', orderType: '', lineIdx: -1, productId: '' });
  /* 单边新结构：缺省侧空串 → 安全默认值（与新增行为一致） */
  assert.deepEqual(
    gj(app, 'trSide({type:"adjust_out",outOrderId:"O",outOrderType:"inv",outLineIdx:0,outProductId:"P",inOrderId:"",inOrderType:"",inLineIdx:null,inProductId:""},"in")'),
    { orderId: '', orderType: '', lineIdx: -1, productId: '' }
  );
  app.dispose();
});

test('I5 冲销既有类型回归：call 冲销 → return，台账/reverseOf 语义不变', async () => {
  const app = boot(mainSeed());
  assert.equal(await apply(app, 'call', [{ out: { orderId: OINV, orderType: 'inv', lineIdx: 0 }, in: { orderId: OSALE, orderType: 'sales', lineIdx: 0 }, qty: 8 }]), true);
  const tid = await app.run('transfers[0].id');
  await tick();
  await app.run('reverseTransfer(' + J(tid) + ')');
  assert.equal(await app.run('orders[0].items[0].deliveredQty'), 40, '库存已交付回滚');
  assert.equal(await app.run('orders[1].items[0].calledQty'), 0, '销售 calledQty 回滚');
  const rev = gj(app, 'transfers.find(function(t){return t.reverseOf===' + J(tid) + ';})');
  assert.equal(rev.type, 'return');
  assert.equal(rev.outOrderType, 'sales');
  assert.equal(rev.inOrderType, 'inv');
  assert.equal(await app.run('transfers.find(function(t){return t.id===' + J(tid) + ';}).reversed'), true);
  app.dispose();
});

/* ================================================================
   §J 静态守卫
   ================================================================ */

function extractFn(src, name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\(', 'g');
  const m = re.exec(src);
  if (!m) throw new Error('未找到函数: ' + name);
  let p = m.index + m[0].length, d = 1;
  for (; p < src.length; p++) { if (src[p] === '(') d++; else if (src[p] === ')') { d--; if (d === 0) break; } }
  const i = src.indexOf('{', p); let j = i; d = 0;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (d === 0) break; } }
  return src.slice(m.index, j + 1);
}

test('J1 三处类型表：TR_TYPE_LABEL / TR_TYPE_TAG / TR_TYPE_OPTIONS 均含 2 新键且长度一致', async () => {
  const app = boot({ orders: [], products: [], transfers: [] });
  const labelKeys = gj(app, 'Object.keys(TR_TYPE_LABEL)');
  const tagKeys = gj(app, 'Object.keys(TR_TYPE_TAG)');
  const labelVals = gj(app, 'Object.keys(TR_TYPE_LABEL).map(function(k){return TR_TYPE_LABEL[k];})');
  const opts = gj(app, 'TR_TYPE_OPTIONS.slice()');
  assert.equal(labelKeys.length, 8, '8 类（含 adjust_out / adjust_in）');
  assert.deepEqual(labelKeys, tagKeys, '三处键集合一致');
  assert.deepEqual(opts, labelVals, 'TR_TYPE_OPTIONS 与 TR_TYPE_LABEL 取值顺序一致');
  assert.equal(await app.run('TR_TYPE_LABEL.adjust_out'), '盘亏');
  assert.equal(await app.run('TR_TYPE_LABEL.adjust_in'), '盘盈');
  assert.equal(await app.run('TR_TYPE_TAG.adjust_out'), 'tag-red', '盘亏红');
  assert.equal(await app.run('TR_TYPE_TAG.adjust_in'), 'tag-green', '盘盈绿');
  assert.ok(opts.indexOf('盘亏') >= 0 && opts.indexOf('盘盈') >= 0);
  app.dispose();
});

test('J2 index.html：动作键 + 工具栏按钮在位（紧接「调用库存」之后）', () => {
  assert.match(SRC_INDEX, /order_inv:\{[^}]*invAdjust:'库存调整（盘盈\/盘亏）'[^}]*\}/, 'FORM_ACTS.order_inv 增 invAdjust');
  assert.match(SRC_INDEX, /canAct\('order_inv\.invAdjust'\)/, '按钮按动作键 gate');
  assert.match(SRC_INDEX, /onclick="openInvAdjust\(\)"/, '工具栏按钮 onclick 指向 openInvAdjust');
  assert.match(SRC_INDEX, />库存调整<\/button>/, '按钮文案「库存调整」');
  /* 位置：在「调用库存」按钮之后、「下推排产计划」之前 */
  const iCall = SRC_INDEX.indexOf('onclick="openInvCallStock()"');
  const iAdj = SRC_INDEX.indexOf('onclick="openInvAdjust()"');
  const iPush = SRC_INDEX.indexOf('onclick="genProdPlan()"');
  assert.ok(iCall >= 0 && iAdj > iCall && iPush > iAdj, '库存调整按钮紧接「调用库存」之后');
});

test('J3 transfer.js：正文无「可用量公式副本」（沿用既有 QA 静态守卫 B4-B6 要求）', () => {
  const code = SRC_TRANSFER.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(code, /calledQty[^\n]{0,60}-[^\n]{0,60}deliveredQty/, '不得复制 calledQty − deliveredQty 公式');
  assert.doesNotMatch(code, /deliveredQty[^\n]{0,60}-[^\n]{0,60}calledQty/, '不得复制 deliveredQty − calledQty 公式');
  assert.match(code, /saleMaxCallable\s*\(/, '必须经全局 saleMaxCallable 取口径');
  assert.match(code, /saleRemainCallable\s*\(/, '必须经全局 saleRemainCallable 取口径');
  /* applyTransfers 内不得出现任何可用量口径算式（单边只做 ±qty） */
  const at = extractFn(SRC_TRANSFER, 'applyTransfers').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(at, /saleMaxCallable|saleRemainCallable|orderQty\s*-/, 'applyTransfers 不做可用量口径计算');
});

test('J4 reverseTransfer：放宽为「至少一侧存在」，且单边反向传 null（非空侧对调）', () => {
  const body = extractFn(SRC_TRANSFER, 'reverseTransfer');
  assert.match(body, /const\s+hasOut=!!outS\.orderId\s*,\s*hasIn=!!inS\.orderId\s*;/, '以「orderId 非空」判定侧存在');
  assert.match(body, /if\(!hasOut&&!hasIn\)/, '两侧皆空才拒绝');
  assert.match(body, /hasIn\?\{orderId:inS\.orderId[^}]*\}:null/, '缺省侧传 null（revOut）');
  assert.match(body, /hasOut\?\{orderId:outS\.orderId[^}]*\}:null/, '缺省侧传 null（revIn）');
  assert.match(body, /trRevType\(t\.type\)/, '反向类型经 trRevType');
  assert.match(body, /remark:t\.remark\|\|''/, '冲销沿用原记录备注');
});

test('J5 applyTransfers：单边支持语义在位（双侧 null 拒绝 / 缺省侧写空串与 null）', () => {
  const body = extractFn(SRC_TRANSFER, 'applyTransfers');
  assert.match(body, /if\(!outMv&&!inMv\)return false;/, '双侧皆空整批放弃');
  assert.match(body, /outOrderId:outMv\?outMv\.orderId:''/, '缺省侧写空串');
  assert.match(body, /outLineIdx:outMv\?outMv\.lineIdx:null/, '缺省侧行号写 null');
  assert.match(body, /remark:\(mv\.remark\|\|\(opts&&opts\.remark\)\|\|''\)/, 'remark 优先级 mv > opts > 空串');
});

test('J6 guide.js：版本标注 .143 + 库存管理小节条目 + 业务规则要点表新增行', () => {
  assert.match(SRC_GUIDE, /更新：2026-10-10（build \.143）/, '版本标注推进到 .143');
  assert.match(SRC_GUIDE, /库存调整（\.143 新增）/, '库存管理小节有「库存调整」条目');
  assert.match(SRC_GUIDE, /\| 库存调整（\.143） \|/, '业务规则要点表有库存调整行');
  assert.match(SRC_GUIDE, /adjust_out`?（盘亏·红）/, '规则行说明盘亏 adjust_out·红标');
  assert.match(SRC_GUIDE, /adjust_in`?（盘盈·绿）/, '规则行说明盘盈 adjust_in·绿标');
});

test('J7 台账渲染源码：缺省侧「—」、料号回退、cross 需双侧料号', () => {
  const body = extractFn(SRC_TRANSFER, 'renderTransfers');
  assert.match(body, /trSide\(r,'out'\)\.orderId\|\|'—'/, '调出订单缺省显示「—」');
  assert.match(body, /trSide\(r,'in'\)\.orderId\|\|'—'/, '调入订单缺省显示「—」');
  assert.match(body, /trSide\(r,'in'\)\.productId\|\|trSide\(r,'out'\)\.productId/, '料号回退到存在侧');
  assert.match(body, /const\s+cross=!!\(inS\.productId&&outS\.productId&&/, 'cross 要求双侧料号皆有值（单边天然不触发）');
  assert.match(body, /colspan="14"/, '空态 14 列');
});

test('J8 调拨查询：queryTransfersOfOrder 预设 transferScopeId；renderTransfers 过滤经 trSide 双读（单边可命中）', () => {
  const q = extractFn(SRC_INDEX, 'queryTransfersOfOrder');
  assert.match(q, /window\.transferScopeId=o\.id/, '预设窗口级限定为本订单');
  assert.match(q, /switchTab\('transfers'\)/, '跳转调拨台账');
  const r = extractFn(SRC_TRANSFER, 'renderTransfers');
  assert.match(r, /const _o=trSide\(r,'out'\),_i=trSide\(r,'in'\)/, 'scope 过滤经 trSide 双读（单边缺省侧为空串亦安全）');
  assert.match(r, /return _o\.orderId===scopeId\|\|_i\.orderId===scopeId/, '调出或调入任一命中即纳入');
});

test('J9 列布局：新增列自动纳入（tblLayout 的合并策略：已存顺序过滤后追加当前新键）；remark 已在 schema', () => {
  /* 说明：applyTableLayout 依赖真实 DOM（document.querySelectorAll('#content table')），
     沙箱桩恒返回 []（dom-stub 设计 §6.2），故此处只做**机制级静态断言**（报告已注明）。 */
  const body = extractFn(SRC_INDEX, 'applyTableLayout');
  assert.match(
    body,
    /var order=\(lo\.order\|\|\[\]\)\.filter\(function\(k\)\{return curKeys\.indexOf\(k\)>=0;\}\);/,
    '已保存顺序先按仍存在的列过滤'
  );
  assert.match(
    body,
    /curKeys\.forEach\(function\(k\)\{if\(order\.indexOf\(k\)<0\)order\.push\(k\);\}\);/,
    '当前表头新增的列（如 remark）自动追加到顺序末尾 → 新列自动纳入'
  );
  /* remark 已在 schema → 会出现在 curKeys → 会被自动纳入 */
  assert.match(extractFn(SRC_TRANSFER, 'renderTransfers'), /key:'remark'/, 'remark 列已注册（参与 curKeys）');
});

/* ================================================================
   §K R1 修复的攻击性复核（防止「修 R1 引出新回归」）
   修复后语义：销售侧优先 → 两侧皆非销售取**调入侧** → in 缺失（单边盘亏）取**调出侧**兜底。
   ================================================================ */

/** 双 inv 夹具（两侧客户/商品名刻意不同，便于判别快照取的是哪一侧） */
function dualInvSeed() {
  return {
    orders: [
      invOrder('INV-A', [{ pid: 'P-A', qty: 100, dv: 100 }], { customer: '仓A' }),
      invOrder('INV-B', [{ pid: 'P-B', qty: 50, dv: 0 }], { customer: '仓B' }),
    ],
    products: [mkProd('P-A', 100), mkProd('P-B', 0)],
  };
}
function dualInvApp() {
  const app = boot(dualInvSeed());
  app.run('orders[0].items[0].productName="A品";orders[0].items[0].spec="SA";orders[0].items[0].model="MA";');
  app.run('orders[1].items[0].productName="B品";orders[1].items[0].spec="SB";orders[1].items[0].model="MB";');
  return app;
}
const SNAP = '({customer:transfers[0].customer,productName:transfers[0].productName,spec:transfers[0].spec,model:transfers[0].model})';

test('K1 修复①销售侧优先未变：call（销售在 in）/ return（销售在 out）仍取销售侧快照', async () => {
  const app = boot({
    orders: [
      invOrder(OINV, [{ pid: 'P-A', qty: 100, dv: 40 }], { customer: '内部库存' }),
      saleOrder(OSALE, [{ pid: 'P-A', qty: 80, dv: 0, cq: 0 }], { customer: '华东盘厂', contractNo: 'HT-1' }),
    ],
    products: [mkProd('P-A', 40)],
  });
  app.run('orders[0].items[0].productName="库品";orders[0].items[0].spec="SI";orders[0].items[0].model="MI";');
  app.run('orders[1].items[0].productName="销品";orders[1].items[0].spec="SS";orders[1].items[0].model="MS";');

  /* call：out=库存(inv)、in=销售(sales) → 必须取销售侧 */
  assert.equal(await apply(app, 'call', [{ out: { orderId: OINV, orderType: 'inv', lineIdx: 0 }, in: { orderId: OSALE, orderType: 'sales', lineIdx: 0 }, qty: 5 }]), true);
  assert.deepEqual(gj(app, SNAP), { customer: '华东盘厂', productName: '销品', spec: 'SS', model: 'MS' }, 'call → 销售侧优先（in）');
  app.dispose();

  /* return：out=销售(sales)、in=库存(inv) → 仍取销售侧（out） */
  const app2 = boot({
    orders: [
      invOrder(OINV, [{ pid: 'P-A', qty: 100, dv: 40 }], { customer: '内部库存' }),
      saleOrder(OSALE, [{ pid: 'P-A', qty: 80, dv: 0, cq: 9 }], { customer: '华东盘厂', contractNo: 'HT-1' }),
    ],
    products: [mkProd('P-A', 40)],
  });
  app2.run('orders[0].items[0].productName="库品";orders[0].items[0].spec="SI";orders[0].items[0].model="MI";');
  app2.run('orders[1].items[0].productName="销品";orders[1].items[0].spec="SS";orders[1].items[0].model="MS";');
  assert.equal(await apply(app2, 'return', [{ out: { orderId: OSALE, orderType: 'sales', lineIdx: 0 }, in: { orderId: OINV, orderType: 'inv', lineIdx: 0 }, qty: 4 }]), true);
  assert.deepEqual(gj(app2, SNAP), { customer: '华东盘厂', productName: '销品', spec: 'SS', model: 'MS' }, 'return → 销售侧优先（out）');
  app2.dispose();
});

test('K2 修复②单边快照：盘盈（仅 in）取 in 侧；盘亏（仅 out）取 out 侧（in 缺失兜底）', async () => {
  /* 盘盈：存在侧 = in → 快照取 in（INV-B/仓B/B品） */
  const ai = dualInvApp();
  assert.equal(await apply(ai, null, [{ out: null, in: { orderId: 'INV-B', orderType: 'inv', lineIdx: 0 }, qty: 7, type: 'adjust_in' }]), true);
  assert.deepEqual(gj(ai, SNAP), { customer: '仓B', productName: 'B品', spec: 'SB', model: 'MB' }, '盘盈 → 取 in 侧快照');
  ai.dispose();

  /* 盘亏：out 存在、in 缺失 → 必须兜底取 out（INV-A/仓A/A品），不得取到空 */
  const ao = dualInvApp();
  assert.equal(await apply(ao, null, [{ out: { orderId: 'INV-A', orderType: 'inv', lineIdx: 0 }, in: null, qty: 7, type: 'adjust_out' }]), true);
  assert.deepEqual(gj(ao, SNAP), { customer: '仓A', productName: 'A品', spec: 'SA', model: 'MA' }, '盘亏 → in 缺失兜底取 out 侧快照');
  ao.dispose();
});

test('K3 修复③trSnapOf 存量反查兜底未受影响（无内嵌快照的旧记录仍按侧推导）', async () => {
  const app = boot({
    orders: [
      invOrder('O-INV', [{ pid: 'PI', qty: 10, dv: 1 }], { customer: '成品仓', contractNo: '' }),
      saleOrder('O-SALE', [{ pid: 'PS', qty: 10, dv: 0 }], { customer: '华东盘厂', contractNo: 'HT1' }),
      invOrder('O-INV2', [{ pid: 'PB', qty: 10, dv: 0 }], { customer: '半成品仓', contractNo: '' }),
    ],
    products: [],
  });
  app.run('orders[0].items[0].productName="库存乙";orders[0].items[0].spec="SI";orders[0].items[0].model="MI";');
  app.run('orders[1].items[0].productName="销售甲";orders[1].items[0].spec="SS";orders[1].items[0].model="MS";');
  app.run('orders[2].items[0].productName="乙料";orders[2].items[0].spec="SB2";orders[2].items[0].model="MB2";');

  /* 旧结构 call（无 out/in 方向字段，无内嵌快照）→ 销售侧优先 → O-SALE/销售甲 */
  assert.deepEqual(
    gj(app, 'trSnapOf({id:"TR-OLD1",type:"call",invOrderId:"O-INV",invLineIdx:0,invProductId:"PI",salesOrderId:"O-SALE",salesLineIdx:0,productId:"PS"})'),
    { customer: '华东盘厂', contractNo: 'HT1', productName: '销售甲', spec: 'SS', model: 'MS' },
    '旧结构含销售订单 → 快照归属销售侧（兜底未变）'
  );
  /* 纯库存互调旧记录（无内嵌快照）→ 调入侧 → O-INV2/乙料 */
  assert.deepEqual(
    gj(app, 'trSnapOf({id:"TR-OLD2",type:"move",outOrderId:"O-INV",outOrderType:"inv",outLineIdx:0,outProductId:"PI",inOrderId:"O-INV2",inOrderType:"inv",inLineIdx:0,inProductId:"PB"})'),
    { customer: '半成品仓', contractNo: '', productName: '乙料', spec: 'SB2', model: 'MB2' },
    '纯库存互调 → 快照归属调入侧（兜底未变）'
  );
  /* 已带内嵌快照 → 原样返回自身（同一引用） */
  app.run('__r={id:"TR-NEW",customer:"X",contractNo:"",productName:"Y",spec:"",model:""};');
  assert.equal(await app.run('trSnapOf(__r)===__r'), true, '内嵌快照直取（同一引用）');
  app.dispose();
});

test('K4 修复④双 inv 的 conv / move / conv_back / move_back 快照均取「调入侧」（恢复 HEAD 行为）', async () => {
  const cases = [
    ['conv', { orderId: 'INV-A', orderType: 'inv', lineIdx: 0 }, { orderId: 'INV-B', orderType: 'inv', lineIdx: 0 }, '仓B', 'B品', 'SB', 'MB'],
    ['move', { orderId: 'INV-A', orderType: 'inv', lineIdx: 0 }, { orderId: 'INV-B', orderType: 'inv', lineIdx: 0 }, '仓B', 'B品', 'SB', 'MB'],
    /* 冲销反向：调用方（reverseTransfer）会**对调两侧**，故 in 侧 = 原调出方 INV-A */
    ['conv_back', { orderId: 'INV-B', orderType: 'inv', lineIdx: 0 }, { orderId: 'INV-A', orderType: 'inv', lineIdx: 0 }, '仓A', 'A品', 'SA', 'MA'],
    ['move_back', { orderId: 'INV-B', orderType: 'inv', lineIdx: 0 }, { orderId: 'INV-A', orderType: 'inv', lineIdx: 0 }, '仓A', 'A品', 'SA', 'MA'],
  ];
  for (const [type, out, inn, cust, name, spec, model] of cases) {
    const app = dualInvApp();
    assert.equal(await apply(app, null, [{ out: out, in: inn, qty: 30, type: type }]), true, type + ' 应落盘');
    assert.deepEqual(gj(app, SNAP), { customer: cust, productName: name, spec: spec, model: model }, type + ' → 快照取调入侧');
    /* 料号列（renderTransfers get）必须与快照同侧，不得自相矛盾 */
    const pid = await app.run('(function(r){return trSide(r,"in").productId||trSide(r,"out").productId;})(transfers[0])');
    assert.equal(pid, type === 'conv' || type === 'move' ? 'P-B' : 'P-A', type + ' 料号列与快照同侧');
    app.dispose();
  }
});

test('K5 修复④冲销全链：conv 冲销生成的 conv_back 快照同样取调入侧（与 §K4 直调一致）', async () => {
  const app = dualInvApp();
  assert.equal(await apply(app, null, [{ out: { orderId: 'INV-A', orderType: 'inv', lineIdx: 0 }, in: { orderId: 'INV-B', orderType: 'inv', lineIdx: 0 }, qty: 30, type: 'conv' }]), true);
  const tid = await app.run('transfers[0].id');
  await tick();
  await app.run('reverseTransfer(' + J(tid) + ')');
  const rev = gj(app, 'transfers.find(function(t){return t.reverseOf===' + J(tid) + ';})');
  assert.equal(rev.type, 'conv_back', 'conv 冲销 → conv_back');
  /* 反向记录 in 侧 = 原调出方 INV-A → 快照应取 INV-A */
  assert.equal(rev.inOrderId, 'INV-A');
  assert.equal(rev.customer, '仓A', 'conv_back 快照取调入侧（INV-A）');
  assert.equal(rev.productName, 'A品', '商品名称与料号列同侧（不再指向两个产品）');
  app.dispose();
});
