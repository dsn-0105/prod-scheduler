'use strict';
/* ================================================================
   tests/overpushdel.142.test.js —— 2026-10-08.142「超排排产单清算」回归
   ================================================================
   用户诉求（2026-10-08 第 3 轮，原话）：「B，然后把超排的单子删了」——
     ① B＝「已计划未交付」去钳制（.141 已交付，本文件不重复覆盖，见 invbalance.139.test.js §A/§F）；
     ② 把超排的排产单删掉，使 Σ已下推排产计划 ≤ Σ交付计划本批计划（超排归零）。

   本轮经用户逐项确认的删除清单（**7 张**，全库超排恰 2 行）：
     · KCDD-20260821-00008 / C02.02.026：本批计划 500、Σ已下推 1400 → 超排 900
       删 2 张未完工（PSCD-20261007-001 120 + PSCD-20261006-007 280）＋ 3 张已完成
       （PSCD-20260829-015 / -014 / -013 各 200）＝ **1000 台**（能清掉 900 的最小已完成删除数）
       ⇒ 留存 PSCD-20260829-001/002（各 200）、Σ已下推 400 ≤ 500。
     · KCDD-20260821-00028 / C01.05.010：本批计划 704、Σ已下推 904 → 超排 200
       超排恰为两张**未完工**单（PSCD-20261005-002 生产中 100 + PSCD-20260930-021 待排产 100）⇒ 直接删。

   本文件钉死的口径：
     §A 前置校验：订单号 / 来源交付计划编号 / Σ计划量 任一不符 → 整项跳过 + 记日志（宁可不动也不猜）
     §B 00008 场景：删 5 张 → 排产单 7→2、报工 3→0、已交付 −200→−800、done 1000→400、
        已计划未交付 0→100、**结余恒 −700**、超排 900→0、库存投影 −200→−800
     §C 00028 场景：删 2 张未完工 → 零回退（已交付 99 / done 704 / 结余 99 / 库存 99 全不变）、超排 200→0
     §D 幂等 + 两行合并订正后全库自检 7 项全通过 + 恒等式逐行成立
     §E 静态守卫：水印 .142、函数与启动序挂载、DB.tx 原子 + meta 幂等、前置校验三条件在位

   ⚠ 判据提醒：**删「已完成」单不改变「结余」**（done↓q 与 已交付↓q 等量相抵），
     故「结余变没变」不能用来判删得对不对；本文件用**超排归零 + 恒等式**判。

   运行：node --test tests/overpushdel.142.test.js
   ================================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createApp, ROOT } = require('./harness/sandbox');
const build = require('./harness/build');

const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* ---------- 夹具（与 overpush.140.test.js 同款，保持风格一致） ---------- */
function mkInvOrder(id, rows) {
  return {
    id: id, orderType: '库存订单', customer: '内部库存', status: '执行中',
    startDate: '2026-08-20', deadline: '', contractNo: '',
    items: rows.map(function (r) {
      return {
        productId: r.pid, productName: r.pid, orderQty: r.qty, stockMax: r.qty, stockMin: 0,
        deliveredQty: (r.dv === undefined ? 0 : r.dv), calledQty: 0, lineNotes: '',
      };
    }),
  };
}
function mkDel(orderId, planNo, rows) {
  return {
    orderId: orderId, customer: '库存', createdAt: '2026-08-29', planNo: planNo,
    items: rows.map(function (r, i) {
      return {
        productId: r.pid, productName: r.pid, spec: '', model: '',
        orderQty: r.plan, deliveredQty: 0, planQty: r.plan,
        orderLine: (r.ol === undefined ? i : r.ol),
      };
    }),
  };
}
function mkPlan(id, orderId, deliveryIdx, dlNo, pid, planQty, doneQty, status) {
  return {
    id: id, deliveryIdx: deliveryIdx, deliveryPlanNo: dlNo || '', orderId: orderId,
    customer: '库存', finalDate: '', planDate: '2026-09-02', status: status || '已完成', notes: '',
    items: [{
      productId: pid, productName: pid, spec: '', model: '', unit: '台',
      planQty: planQty, doneQty: doneQty, dlLine: 0, steps: null, stepsDef: null,
    }],
  };
}
function mkRep(id, planId, pid, qty, step) {
  return {
    id: id, planId: planId, date: '2026-10-06', time: '16:10', worker: 'T',
    items: [{ productId: pid, step: step || 'inbound', label: '入库', qty: qty }],
  };
}
function mkProd(pid, name, stock) {
  return { id: pid, name: name, model: '', spec: '', unit: '台', stock: stock };
}
function boot(seed) {
  return createApp({
    quietConsole: true,
    seed: Object.assign({
      orders: [], products: [], deliveries: [], productionPlans: [],
      productionReports: [], transfers: [], processTemplates: [], logs: [], meta: { seq: 0 },
    }, seed || {}),
  });
}
const num = (v) => Number(v) || 0;
const j = (app, e) => JSON.parse(app.run('JSON.stringify(' + e + ')'));

/* ---------- 线上 00008 形态（7 张，超排 900） ---------- */
function seed00008(over) {
  const o = over || {};
  const orders = [mkInvOrder('KCDD-20260821-00008', [{ pid: 'C02.02.026', qty: 500, dv: -200 }])];
  const products = [mkProd('C02.02.026', '电子式', -200)];
  const deliveries = [mkDel('KCDD-20260821-00008', 'JFJH-20260829-00010', [{ pid: 'C02.02.026', plan: 500, ol: 0 }])];
  const D = 'JFJH-20260829-00010';
  const plans = [
    mkPlan('PSCD-20260829-001', 'KCDD-20260821-00008', 0, D, 'C02.02.026', 200, 200),
    mkPlan('PSCD-20260829-002', 'KCDD-20260821-00008', 0, D, 'C02.02.026', 200, 200),
    mkPlan('PSCD-20260829-013', 'KCDD-20260821-00008', 0, D, 'C02.02.026', 200, 200),
    mkPlan('PSCD-20260829-014', 'KCDD-20260821-00008', 0, D, 'C02.02.026', 200, 200),
    /* o.q15：把 -015 改成非 200，用于「Σ计划量不符」前置校验用例 */
    mkPlan('PSCD-20260829-015', 'KCDD-20260821-00008', 0, D, 'C02.02.026', (o.q15 === undefined ? 200 : o.q15), 200),
    mkPlan('PSCD-20261006-007', 'KCDD-20260821-00008', 0, D, 'C02.02.026', 280, 0, '生产中'),
    mkPlan('PSCD-20261007-001', 'KCDD-20260821-00008', 0, D, 'C02.02.026', 120, 0, '生产中'),
  ];
  const reports = [
    mkRep('REP-20261006-008', 'PSCD-20260829-001', 'C02.02.026', 200),
    mkRep('REP-20261006-009', 'PSCD-20260829-002', 'C02.02.026', 200),
    mkRep('REP-20261006-012', 'PSCD-20260829-013', 'C02.02.026', 200),
    mkRep('REP-20261006-022', 'PSCD-20260829-014', 'C02.02.026', 200),
    mkRep('REP-20261006-023', 'PSCD-20260829-015', 'C02.02.026', 200),
  ];
  return boot({ orders: orders, products: products, deliveries: deliveries, productionPlans: plans, productionReports: reports });
}

/* ---------- 线上 00028 形态（8 张，超排 200） ---------- */
function seed00028() {
  const orders = [mkInvOrder('KCDD-20260821-00028', [{ pid: 'C01.05.010', qty: 704, dv: 99 }])];
  const products = [mkProd('C01.05.010', '重合闸', 99)];
  const deliveries = [
    mkDel('KCDD-20260821-00028', 'JFJH-20260823-00007', [{ pid: 'C01.05.010', plan: 104, ol: 0 }]),
    mkDel('KCDD-20260821-00028', 'JFJH-20260827-00002', [{ pid: 'C01.05.010', plan: 100, ol: 0 }]),
    mkDel('KCDD-20260821-00028', 'JFJH-20260829-00007', [{ pid: 'C01.05.010', plan: 300, ol: 0 }]),
    mkDel('KCDD-20260821-00028', 'JFJH-20260922-00002', [{ pid: 'C01.05.010', plan: 100, ol: 0 }]),
    mkDel('KCDD-20260821-00028', 'JFJH-20261005-00002', [{ pid: 'C01.05.010', plan: 100, ol: 0 }]),
  ];
  const PID = 'C01.05.010', O = 'KCDD-20260821-00028';
  const plans = [
    mkPlan('PSCD-20260825-007', O, 0, 'JFJH-20260823-00007', PID, 104, 104),
    mkPlan('PSCD-20260827-002', O, 1, 'JFJH-20260827-00002', PID, 100, 100),
    mkPlan('PSCD-20260829-008', O, 2, 'JFJH-20260829-00007', PID, 100, 100),
    mkPlan('PSCD-20260829-011', O, 2, 'JFJH-20260829-00007', PID, 100, 100),
    mkPlan('PSCD-20260829-012', O, 2, 'JFJH-20260829-00007', PID, 100, 100),
    mkPlan('PSCD-20261006-006', O, 2, 'JFJH-20260829-00007', PID, 200, 200),
    mkPlan('PSCD-20261005-002', O, 4, 'JFJH-20261005-00002', PID, 100, 0, '生产中'),
    mkPlan('PSCD-20260930-021', O, 3, 'JFJH-20260922-00002', PID, 100, 0, '待排产'),
  ];
  /* 6 张已完成单的报工（与 done 一一对应；两张未完工单无报工）——缺了它们自检 ① 天然不成立 */
  const reports = [
    mkRep('REP-20260930-002', 'PSCD-20260825-007', PID, 104),
    mkRep('REP-20260930-003', 'PSCD-20260827-002', PID, 100),
    mkRep('REP-20260930-004', 'PSCD-20260829-008', PID, 100),
    mkRep('REP-20260930-005', 'PSCD-20260829-011', PID, 100),
    mkRep('REP-20260930-006', 'PSCD-20260829-012', PID, 100),
    mkRep('REP-20260930-007', 'PSCD-20261006-006', PID, 200),
  ];
  return boot({ orders: orders, products: products, deliveries: deliveries, productionPlans: plans, productionReports: reports });
}

/* 取值辅助：一律**经唯一入口**（invPuOf / invPlannedUndelOf / invBalanceOf / invOverPushOf），
   **不得手写字段名或公式**（.127 教训）；每个辅助都返回已解析对象，禁止互相嵌套拼接。 */
const Q = (s) => JSON.stringify(s);
const P = (app, id, li, pid) => j(app, 'invPuOf(buildPlannedUndelMap(),' + Q(id) + ',' + li + ',' + Q(pid) + ')');
const PS = (app, id, li, pid) => j(app, 'invPuOf(buildPpPushedMap(),' + Q(id) + ',' + li + ',' + Q(pid) + ')');
const OVER = (app, id, li, pid) => j(app, 'invOverPushOf(invPuOf(buildPlannedUndelMap(),' + Q(id) + ',' + li + ',' + Q(pid) +
  '),invPuOf(buildPpPushedMap(),' + Q(id) + ',' + li + ',' + Q(pid) + '))');
const UNDEL = (app, id, li, pid) => j(app, 'invPlannedUndelOf(invPuOf(buildPlannedUndelMap(),' + Q(id) + ',' + li + ',' + Q(pid) + '))');
const BAL = (app, id, li, pid) => j(app, 'invBalanceOf(orders[0].items[' + li + '].deliveredQty,invPuOf(buildPlannedUndelMap(),' + Q(id) + ',' + li + ',' + Q(pid) + '))');

/* ================================================================
   §A 前置校验（宁可不动也不猜）
================================================================ */
test('A-1) 来源交付计划编号与清单不符 → 整项跳过 + 记日志', async () => {
  const app = seed00008();
  try {
    /* 把 -015 的来源外键改错 → 该项应跳过（其余 4 项仍会撤，故单独用一个只含 -015 的种子更清晰） */
    app.run('productionPlans.forEach(function(p){if(p.id==="PSCD-20260829-015")p.deliveryPlanNo="JFJH-OTHER";});');
    await app.run('fixOverPushPlans20261008()');
    assert.ok(app.run('productionPlans.some(function(p){return p.id==="PSCD-20260829-015";})'),
      '来源计划不符的单必须原样保留');
    assert.ok(app.run('logs.some(function(x){return String(x.detail||"").indexOf("PSCD-20260829-015")>=0&&String(x.detail||"").indexOf("跳过")>=0;})'),
      '须记日志说明跳过原因（不得静默）');
  } finally { app.dispose(); }
});

test('A-2) Σ计划量与清单不符 → 该单跳过（不得按 id 硬删）', async () => {
  const app = seed00008({ q15: 150 });
  try {
    await app.run('fixOverPushPlans20261008()');
    assert.ok(app.run('productionPlans.some(function(p){return p.id==="PSCD-20260829-015";})'),
      'Σ计划量不符的单必须原样保留');
    assert.ok(app.run('logs.some(function(x){return String(x.detail||"").indexOf("Σ计划")>=0;})'), '须记日志');
  } finally { app.dispose(); }
});

/* ================================================================
   §B 00008 场景：删 5 张（1000 台）
================================================================ */
test('B-1) 00008：删 5 张 → 超排 900→0、结余恒 −700、恒等式成立', async () => {
  const app = seed00008();
  try {
    const before = {
      n: num(app.run('productionPlans.length')),
      rep: num(app.run('productionReports.length')),
      dq: num(app.run('orders[0].items[0].deliveredQty')),
      done: P(app, 'KCDD-20260821-00008', 0, 'C02.02.026').done,
      pu: P(app, 'KCDD-20260821-00008', 0, 'C02.02.026').plan,
      pushed: PS(app, 'KCDD-20260821-00008', 0, 'C02.02.026').pushed,
      over: num(OVER(app, 'KCDD-20260821-00008', 0, 'C02.02.026')),
      bal: num(BAL(app, 'KCDD-20260821-00008', 0, 'C02.02.026')),
    };
    assert.equal(before.n, 7);
    assert.equal(before.rep, 5);
    assert.equal(before.dq, -200);
    assert.equal(before.done, 1000);
    assert.equal(before.pu, 500);
    assert.equal(before.pushed, 1400);
    assert.equal(before.over, 900, '起点：超排 900');

    await app.run('fixOverPushPlans20261008()');

    assert.equal(num(app.run('productionPlans.length')), 2, '7→2（留存 -001/-002）');
    const alive = j(app, 'productionPlans.map(function(p){return p.id;})').sort();
    assert.deepEqual(alive, ['PSCD-20260829-001', 'PSCD-20260829-002'], '留存最早下推的两张已完成');
    assert.equal(num(app.run('productionReports.length')), 2, '5 条报工中 3 条随被撤单清理、留存单的 2 条不动');
    /* 回退量 = 3 张已完成各 200 = 600；2 张在产 done=0 不回退 */
    assert.equal(num(app.run('orders[0].items[0].deliveredQty')), -800, '已交付 −200→−800（回退 600）');
    assert.equal(P(app, 'KCDD-20260821-00008', 0, 'C02.02.026').done, 400, 'done 1000→400');
    assert.equal(PS(app, 'KCDD-20260821-00008', 0, 'C02.02.026').pushed, 400, 'Σ已下推 1400→400');
    assert.equal(num(OVER(app, 'KCDD-20260821-00008', 0, 'C02.02.026')), 0, '**超排必须归零**');
    /* 恒等式：已交付 + 已计划未交付 = 结余（一律经唯一入口取值） */
    const plannedUndel = UNDEL(app, 'KCDD-20260821-00008', 0, 'C02.02.026');
    const bal = BAL(app, 'KCDD-20260821-00008', 0, 'C02.02.026');
    assert.equal(plannedUndel, 100, '已计划未交付 0（钳制）→100');
    assert.equal(bal, -700, '**结余必须前后不变 −700**（.141 起不钳制）');
    assert.equal(num(app.run('orders[0].items[0].deliveredQty')) + plannedUndel, bal, '恒等式必须成立');
    assert.equal(num(app.run('products[0].stock')), -800, '库存投影 −200→−800（欠产加深，真实口径）');
    assert.equal(app.run('meta.fixOverPushPlans20261008'), true, '幂等标记置位');
    /* 自检：本行不再超排 */
    const c = j(app, 'auditInvInvariants().checks[6]');
    assert.equal(c.name, '超排核对');
    assert.equal(c.ok, true, '超排核对应通过：' + JSON.stringify(c.bad));
  } finally { app.dispose(); }
});

/* ================================================================
   §C 00028 场景：删 2 张未完工（200 台，零回退）
================================================================ */
test('C-1) 00028：删 2 张未完工 → 超排 200→0、已交付/结余/库存全不变', async () => {
  const app = seed00028();
  try {
    assert.equal(num(OVER(app, 'KCDD-20260821-00028', 0, 'C01.05.010')), 200, '起点：超排 200');
    assert.equal(num(app.run('productionPlans.length')), 8);
    const balBefore = num(BAL(app, 'KCDD-20260821-00028', 0, 'C01.05.010'));

    await app.run('fixOverPushPlans20261008()');

    assert.equal(num(app.run('productionPlans.length')), 6, '8→6');
    assert.ok(!app.run('productionPlans.some(function(p){return p.id==="PSCD-20261005-002"||p.id==="PSCD-20260930-021";})'),
      '两张未完工单必须删除');
    assert.equal(num(app.run('orders[0].items[0].deliveredQty')), 99, '**零回退**：已交付不变');
    assert.equal(P(app, 'KCDD-20260821-00028', 0, 'C01.05.010').done, 704, 'done 不变');
    assert.equal(num(OVER(app, 'KCDD-20260821-00028', 0, 'C01.05.010')), 0, '**超排归零**（904→704 = 本批计划）');
    assert.equal(num(BAL(app, 'KCDD-20260821-00028', 0, 'C01.05.010')), balBefore, '结余不变 99');
    assert.equal(num(app.run('products[0].stock')), 99, '库存投影不变');
  } finally { app.dispose(); }
});

/* ================================================================
   §D 幂等 + 两行合并订正 + 全库自检
================================================================ */
test('D-1) 幂等：标记已置 → 二次运行零变化', async () => {
  const app = seed00008();
  try {
    await app.run('fixOverPushPlans20261008()');
    const s1 = j(app, '(function(){return {n:productionPlans.length,rep:productionReports.length,dq:orders[0].items[0].deliveredQty,logs:logs.length};})()');
    await app.run('fixOverPushPlans20261008()');
    const s2 = j(app, '(function(){return {n:productionPlans.length,rep:productionReports.length,dq:orders[0].items[0].deliveredQty,logs:logs.length};})()');
    assert.deepEqual(s2, s1, '二次运行不得再改（含不得再记日志）');
  } finally { app.dispose(); }
});

test('D-2) 两行合并订正：超排全库归零 + 自检 7 项全通过 + 恒等式逐行成立', async () => {
  /* 把 00008 与 00028 放进同一份数据，一次订正全部处理 */
  const a = seed00008(), b = seed00028();
  const seed08 = j(a, '(function(){return {orders:orders,products:products,deliveries:deliveries,productionPlans:productionPlans,productionReports:productionReports};})()');
  const seed28 = j(b, '(function(){return {orders:orders,products:products,deliveries:deliveries,productionPlans:productionPlans,productionReports:productionReports};})()');
  a.dispose(); b.dispose();

  const app = boot({
    orders: seed08.orders.concat(seed28.orders),
    products: seed08.products.concat(seed28.products),
    deliveries: seed08.deliveries.concat(seed28.deliveries),
    productionPlans: seed08.productionPlans.concat(seed28.productionPlans),
    productionReports: seed08.productionReports.concat(seed28.productionReports),
  });
  try {
    assert.equal(num(app.run('productionPlans.length')), 15, '起点 7+8=15');
    assert.equal(num(app.run('productionReports.length')), 11, '起点 5+6=11');
    await app.run('fixOverPushPlans20261008()');
    assert.equal(num(app.run('productionPlans.length')), 8, '15→8（删 5+2）');
    assert.equal(num(app.run('productionReports.length')), 8, '11→8（仅随被撤单清理 3 条）');

    /* 全库超排归零 */
    const rows = j(app, '(function(){var out=[];var pm=buildPlannedUndelMap(),ps=buildPpPushedMap();' +
      '(orders||[]).forEach(function(o){orderItems(o).forEach(function(it,li){' +
      'var pu=invPuOf(pm,o.id,li,it.productId),p2=invPuOf(ps,o.id,li,it.productId);' +
      'out.push({id:o.id,over:invOverPushOf(pu,p2),' +
      'sum:num(it.deliveredQty)+invPlannedUndelOf(pu)-invBalanceOf(num(it.deliveredQty),pu)});});});return out;})()');
    assert.equal(rows.length, 2);
    rows.forEach(function (r) {
      assert.equal(r.over, 0, r.id + ' 超排必须归零');
      assert.equal(r.sum, 0, r.id + ' 恒等式 已交付+已计划未交付=结余 必须成立');
    });

    /* 全库自检 7 项全通过 */
    const audit = j(app, 'auditInvInvariants()');
    assert.equal(audit.checks.length, 7);
    assert.equal(audit.checks[6].name, '超排核对');
    assert.equal(audit.checks[6].ok, true, '超排核对应通过：' + JSON.stringify(audit.checks[6].bad));
    assert.equal(audit.checks[1].ok, true, '② 来源归属自洽应通过（删除后不得留下孤儿引用）');
    assert.equal(audit.checks[0].ok, true, '① 报工流水 ≡ 排产单完成量应通过（报工已随单清理）');

    /* 订正日志恰 1 条（一次事务、一次留痕） */
    const fixLogs = j(app, 'logs.filter(function(x){return String(x.detail||"").indexOf("超排排产单清算")>=0;}).map(function(x){return x.detail;})');
    assert.equal(fixLogs.length, 1, '订正日志恰 1 条，实际：' + JSON.stringify(fixLogs));
  } finally { app.dispose(); }
});

/* ================================================================
   §E 静态守卫
================================================================ */
test('E-1) 水印：.142 恰 1 处、.141 权威形态 0 处', () => {
  assert.equal((INDEX_SRC.match(build.buildMarkRe(build.BUILD)) || []).length, 1, '水印 .142 恰 1 处');
  assert.equal((INDEX_SRC.match(build.buildMarkRe(build.PREV)) || []).length, 0, '.141 权威形态应为 0 处');
});

test('E-2) 函数唯一 + 启动序挂载 + DB.tx 原子 + meta 幂等', () => {
  assert.equal((INDEX_SRC.match(/function fixOverPushPlans20261008\(/g) || []).length, 1, '清算函数唯一');
  assert.ok(/await fixOverPushPlans20261008\(\);/.test(INDEX_SRC), '必须在 initApp 启动序挂载');
  assert.ok(/meta\.fixOverPushPlans20261008/.test(INDEX_SRC), '必须用 meta 幂等标记');
  assert.ok(/const ok=await DB\.tx\(ops,true\);/.test(INDEX_SRC), '须一次事务原子提交（silent）');
  /* 与 .140 订正彼此独立：各自独立的 meta 幂等键，互不覆盖 */
  assert.ok(/meta\.fixOverPush20261008/.test(INDEX_SRC), '.140 订正标记仍在（两函数共存）');
  assert.ok((INDEX_SRC.match(/meta\.fixOverPushPlans20261008/g) || []).length >= 2,
    '清算标记须出现「判读 + 置位」（≥2 处：守卫读、置 true、失败置 false）');
});

test('E-3) 前置校验三条件在位：订单号 / 来源交付计划编号 / Σ计划量', () => {
  const body = INDEX_SRC.slice(INDEX_SRC.indexOf('async function fixOverPushPlans20261008('),
    INDEX_SRC.indexOf('function migrateOrderStatusData('));
  assert.ok(body.indexOf('String(p.orderId)!==t.orderId') >= 0, '必须校验订单号');
  assert.ok(body.indexOf("String(p.deliveryPlanNo||'')!==t.dlNo") >= 0, '必须校验来源交付计划编号');
  assert.ok(/const sum=ppItems\(p\)\.reduce\(\(s,it\)=>s\+ppPlanOf\(it\),0\);/.test(body), '必须校验 Σ计划量');
  assert.ok(/skipped\.push\(/.test(body) && /indexOf\("跳过"\)|'已跳过'|跳过：/.test(INDEX_SRC), '跳过必须留痕（记日志）');
});
