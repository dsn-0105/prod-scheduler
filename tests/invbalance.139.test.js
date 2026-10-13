'use strict';
/* ================================================================
   tests/invbalance.139.test.js —— 2026-10-07.139「结余口径 / 报工守恒守卫 / 一键自检 / 数据订正」回归
   ================================================================
   用户诉求（2026-10-07，原话）：
     ① 「已计划未交付在计算逻辑上不可能会出现负数，因为报工交付的数量永远是小于计划数量的，
         结余列需要用负数呈现欠产。」
     ② 「报工入库时，检查入库前后对应的『结余』是否有变化，无变化为正确，变化了为错误，
         错误时需要弹窗提醒并退回操作。」
     ③ 「并再加一个检查」（= 全库不变量一键自检）
   背景事故：C02.02.026 结余应 −700、实显 0。两处独立缺陷叠加——
     缺陷 1（口径，**已于 .141 废止**）：index.html 当时用 `Math.max(0, plan−done)` 钳制「已计划未交付」，
        本行 500−1000 = −500 被钳成 0；两列钳制规则不同 → 恒等式「已交付 + 已计划未交付 = 结余」破裂
        （用户 2026-10-08 追问「为什么加不起来」，遂拍板 B 方案：两列同规则、均不钳制）。
     缺陷 2（数据，孤例）：该行「已交付」虚增 +200（.134~.136 R2 修复前的回写残留；重放不可复现）。

   本文件钉死的口径（**§A / §B 的「恒非负」部分已于 .141 按用户拍板改写为不钳制**）：
     §A invPuOf / invPlannedUndelOf / invBalanceOf：唯一取值入口——两列**同规则不钳制**，
        恒等式 `已交付 + 已计划未交付 = 结余` 恒成立（超排 / 计划被削时为负数）。
     §B 展示层：库存页「结余」与「已计划未交付」列均可渲染负数；负结余 → 4 档警示红。
     §C 报工入库守恒守卫：适用范围（库存订单非独立单）+ 通过 / 失败退回（数据零变化）。
     §D fixInvDeliveredDrift20261007：一次性幂等 + 前置基线校验（不符则跳过不动手）。
     §E auditInvInvariants：九项检查（含缺陷检出）；E-5 采用「盲区形状」夹具
        （同订单行两张交付计划 ⇒ 订单行级看不出）实证 ⑧ 补的正是 ⑦ 的盲区。
     §F 静态守卫：结余/已计划未交付公式全工程只经唯一入口，不得残留裸钳制表达式。

   运行：node --test tests/invbalance.139.test.js（**不要用 node -e**，见 tests/README）
   ================================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createApp, ROOT } = require('./harness/sandbox');

const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* ---------- 夹具 ---------- */
/** 库存订单：rows = [{pid, qty(=最大库存量), dv}] */
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
/** 销售订单（用于验证守卫不适用） */
function mkSalesOrder(id, rows) {
  const o = mkInvOrder(id, rows);
  o.orderType = '销售订单';
  o.customer = '某客户';
  return o;
}
/** 交付计划：rows = [{pid, plan, ol}] */
function mkDel(orderId, planNo, rows) {
  return {
    orderId: orderId, customer: '库存', createdAt: '2026-08-20', planNo: planNo,
    items: rows.map(function (r, i) {
      return {
        productId: r.pid, productName: r.pid, spec: '', model: '',
        orderQty: r.plan, deliveredQty: 0, planQty: r.plan,
        orderLine: (r.ol === undefined ? i : r.ol),
      };
    }),
  };
}
/** 排产单（单行） */
function mkPlan(id, orderId, deliveryIdx, deliveryPlanNo, pid, planQty, doneQty, dlLine) {
  return {
    id: id, deliveryIdx: deliveryIdx, deliveryPlanNo: deliveryPlanNo || '', orderId: orderId,
    customer: '库存', finalDate: '', planDate: '2026-08-25', status: '生产中', notes: '',
    items: [{
      productId: pid, productName: pid, spec: '', model: '', unit: '台',
      planQty: planQty, doneQty: doneQty,
      dlLine: (dlLine === undefined ? 0 : dlLine), steps: null, stepsDef: null,
    }],
  };
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
function num(v) { return Number(v) || 0; }
/** 报工落地的收尾会 closeModal()+renderContent()（需要完整 DOM）；测试只关心数据与守卫，故打桩 */
function stubUi(app) { app.run('closeModal=function(){}; renderContent=function(){};'); }

/* ================================================================
   §A 口径（唯一入口）
================================================================ */
test('A-1) invPuOf：行级 key 优先，产品级 key 回退，空 map/nil 安全', () => {
  const app = boot();
  try {
    app.setGlobal('puMap', {
      'K1|L0': { plan: 100, done: 30 },
      'K1|PA': { plan: 5, done: 5 },
    });
    assert.deepEqual(JSON.parse(app.run('JSON.stringify(invPuOf(puMap,"K1",0,"PA"))')), { plan: 100, done: 30 });
    assert.deepEqual(JSON.parse(app.run('JSON.stringify(invPuOf(puMap,"K1",7,"PA"))')), { plan: 5, done: 5 }, '行级未命中 → 回退产品级');
    assert.equal(app.run('invPuOf(puMap,"K1",3,"PZ")'), null, '行级与产品级都未命中 → null');
    assert.equal(app.run('invPuOf(null,"K1",0,"PA")'), null);
  } finally { app.dispose(); }
});

test('A-2) invPlannedUndelOf：不钳制——超排 / 计划被削时呈负数（.141 用户拍板 B 方案）', () => {
  const app = boot();
  try {
    assert.equal(app.run('invPlannedUndelOf({plan:500,done:200})'), 300);
    assert.equal(app.run('invPlannedUndelOf({plan:500,done:1000})'), -500,
      '超排时必须呈负数（.139 曾钳为 0，.141 已废止——钳制会让恒等式破裂）');
    /* 与「结余」同规则：已交付 + 已计划未交付 = 结余 恒成立 */
    assert.equal(app.run('invPlannedUndelOf({plan:500,done:1000})+(-200)'),
      app.run('invBalanceOf(-200,{plan:500,done:1000})'), '两列相加必须严格等于结余');
    assert.equal(app.run('invPlannedUndelOf(null)'), 0);
  } finally { app.dispose(); }
});

test('A-3) invBalanceOf：结余不钳制，欠产以负数呈现（C02.02.026 真值 −700）', () => {
  const app = boot();
  try {
    /* 用户案例：plan=500 / done=1000 / 已交付 −200（+200 虚增订正后） */
    assert.equal(app.run('invBalanceOf(-200,{plan:500,done:1000})'), -700, '必须得到用户期望的 −700');
    /* 与「已计划未交付」（.141 起不钳制 = −500）相加 → 恒等 */
    assert.equal(app.run('invPlannedUndelOf({plan:500,done:1000})'), -500);
    assert.equal(app.run('invBalanceOf(0,{plan:500,done:1000})'), -500);
    /* 守恒性：报工 +q（done +q 且 已交付 +q）结余不变 */
    assert.equal(app.run('invBalanceOf(300,{plan:1000,done:300})'), app.run('invBalanceOf(500,{plan:1000,done:500})'));
    /* 增/删交付计划才改变结余 */
    assert.notEqual(app.run('invBalanceOf(300,{plan:1000,done:300})'), app.run('invBalanceOf(300,{plan:1500,done:300})'));
    assert.equal(app.run('invBalanceOf(0,null)'), 0);
  } finally { app.dispose(); }
});

/* ================================================================
   §B 展示层
================================================================ */
test('B-1) 库存页取值：结余为负、已计划未交付同为负（.141 不钳制）；负结余 → 4 档警示红', () => {
  const orders = [mkInvOrder('K1', [{ pid: 'PA', qty: 500, dv: -200 }])];
  const deliveries = [mkDel('K1', 'JFJH-1', [{ pid: 'PA', plan: 500, ol: 0 }])];
  const plans = [mkPlan('P1', 'K1', 0, 'JFJH-1', 'PA', 500, 1000, 0)];
  const app = boot({ orders: orders, deliveries: deliveries, productionPlans: plans });
  try {
    /* 与渲染层同一函数（TBL_SCHEMAS 的 get 与行渲染都调它们） */
    assert.equal(app.run('invPlannedUndelOf(invPuOf(buildPlannedUndelMap(),"K1",0,"PA"))'), -500,
      '已计划未交付：不钳制 → −500（.141）');
    assert.equal(app.run('invBalanceOf(-200,invPuOf(buildPlannedUndelMap(),"K1",0,"PA"))'), -700, '结余：欠产为负');
    /* 负结余 → 4 档警示红；正常区间 → 绿 */
    assert.equal(app.run('invStockLevel(-700,0,500)'), 'red');
    assert.equal(app.run('invStockLevel(400,0,500)'), 'green');
    /* 一句话总结须点明「结余为负」 */
    assert.ok(app.run('invRowSummary(-200,-700,0,500,invStockLevel(-200,0,500),invStockLevel(-700,0,500))').indexOf('结余') >= 0);
  } finally { app.dispose(); }
});

test('B-2) 库存页表格上下文真的渲染出负数结余（DOM 级）', () => {
  const orders = [mkInvOrder('K1', [{ pid: 'PA', qty: 500, dv: -200 }])];
  const products = [{ id: 'PA', name: 'PA', model: '', spec: '', unit: '台' }];
  const deliveries = [mkDel('K1', 'JFJH-1', [{ pid: 'PA', plan: 500, ol: 0 }])];
  const plans = [mkPlan('P1', 'K1', 0, 'JFJH-1', 'PA', 500, 1000, 0)];
  const app = boot({ orders: orders, products: products, deliveries: deliveries, productionPlans: plans });
  try {
    const r = JSON.parse(app.run('JSON.stringify((function(){'
      + 'var rows=[{o:orders[0],i:0}];'
      + 'var html=renderOrderTable("order_inv",rows,{});'
      + 'function cell(k){var m=html.match(new RegExp("<td data-key=\\""+k+"\\"[^>]*>([\\\\s\\\\S]*?)</td>"));return m?m[1]:null;}'
      + 'return {plan:cell("_plannedUndel"),bal:cell("_balance")};'
      + '})())'));
    assert.ok(r.bal !== null && r.bal.indexOf('-700') >= 0, '结余应显示 −700，实际：' + r.bal);
    assert.ok(r.plan !== null && r.plan.indexOf('-500') >= 0, '已计划未交付应显示 −500（.141 不钳制），实际：' + r.plan);
  } finally { app.dispose(); }
});

/* ================================================================
   §C 报工入库守恒守卫
================================================================ */
test('C-1) invBalGuardApplies：仅库存订单的「非独立排产单」适用', () => {
  const orders = [mkInvOrder('K1', [{ pid: 'PA', qty: 100 }]), mkSalesOrder('X1', [{ pid: 'PA', qty: 100 }])];
  const deliveries = [mkDel('K1', 'JFJH-1', [{ pid: 'PA', plan: 100 }]), mkDel('X1', 'JFJH-2', [{ pid: 'PA', plan: 100 }])];
  const plans = [
    mkPlan('P-INV', 'K1', 0, 'JFJH-1', 'PA', 100, 0),
    mkPlan('P-SALE', 'X1', 1, 'JFJH-2', 'PA', 100, 0),
    mkPlan('P-ALONE', 'K1', null, '', 'PA', 100, 0),
  ];
  const app = boot({ orders: orders, deliveries: deliveries, productionPlans: plans });
  try {
    assert.equal(app.run('invBalGuardApplies(productionPlans[0])'), true, '库存订单 + 非独立单 → 适用');
    assert.equal(app.run('invBalGuardApplies(productionPlans[1])'), false, '销售订单无结余列 → 不适用');
    assert.equal(app.run('invBalGuardApplies(productionPlans[2])'), false, '独立单（完成量不计入归集）→ 不适用');
    assert.equal(app.run('invBalGuardApplies(null)'), false);
  } finally { app.dispose(); }
});

test('C-2) 守卫通过：正常入库报工——结余前后不变，数据正确落盘', async () => {
  const orders = [mkInvOrder('K1', [{ pid: 'PA', qty: 1000, dv: 0 }])];
  const deliveries = [mkDel('K1', 'JFJH-1', [{ pid: 'PA', plan: 1000, ol: 0 }])];
  const plans = [mkPlan('P1', 'K1', 0, 'JFJH-1', 'PA', 1000, 0, 0)];
  const app = boot({ orders: orders, deliveries: deliveries, productionPlans: plans });
  try {
    stubUi(app);
    assert.equal(app.run('invBalanceOf(orders[0].items[0].deliveredQty,invPuOf(buildPlannedUndelMap(),"K1",0,"PA"))'), 1000, '报工前结余 1000');
    await app.run('applyReport(0,[{li:0,step:"inbound",qty:200}],ppItems(productionPlans[0]),"T")');
    assert.equal(app.alerts.length, 0, '不应弹窗：' + JSON.stringify(app.alerts));
    assert.equal(num(app.run('orders[0].items[0].deliveredQty')), 200, '已交付 +200');
    assert.equal(num(app.run('productionPlans[0].items[0].doneQty')), 200, '完成量 +200');
    assert.equal(app.run('invBalanceOf(orders[0].items[0].deliveredQty,invPuOf(buildPlannedUndelMap(),"K1",0,"PA"))'), 1000, '报工后结余仍为 1000');
    assert.equal(app.run('productionReports.length'), 1, '报工明细已落库');
  } finally { app.dispose(); }
});

test('C-3) 守卫拦截：回写目标缺失（订单里没有该商品行）→ 弹窗 + 整批退回，数据零变化', async () => {
  /* 订单只有 PA，排产单却是 PB —— 入库不会回写「已交付」→ 结余必然虚减 */
  const orders = [mkInvOrder('K1', [{ pid: 'PA', qty: 1000, dv: 0 }])];
  const deliveries = [mkDel('K1', 'JFJH-1', [{ pid: 'PB', plan: 1000, ol: 0 }])];
  const plans = [mkPlan('P1', 'K1', 0, 'JFJH-1', 'PB', 1000, 0, 0)];
  const app = boot({ orders: orders, deliveries: deliveries, productionPlans: plans });
  try {
    stubUi(app);
    const beforeBal = app.run('invBalanceOf(orders[0].items[0].deliveredQty,invPuOf(buildPlannedUndelMap(),"K1",0,"PA"))');
    await app.run('applyReport(0,[{li:0,step:"inbound",qty:200}],ppItems(productionPlans[0]),"T")');
    assert.equal(app.alerts.length, 1, '必须弹窗提醒');
    assert.ok(String(app.alerts[0]).indexOf('已退回') >= 0, '弹窗须说明已退回，实际：' + app.alerts[0]);
    assert.equal(num(app.run('orders[0].items[0].deliveredQty')), 0, '订单行「已交付」必须未变');
    assert.equal(num(app.run('productionPlans[0].items[0].doneQty')), 0, '排产单完成量必须回滚');
    assert.equal(app.run('productionPlans[0].items[0].steps'), null, 'steps 必须回滚为原值 null');
    assert.equal(app.run('productionPlans[0].status'), '生产中', '排产单状态必须回滚');
    assert.equal(app.run('productionReports.length'), 0, '报工明细不得落库');
    assert.equal(app.run('invBalanceOf(orders[0].items[0].deliveredQty,invPuOf(buildPlannedUndelMap(),"K1",0,"PA"))'), beforeBal);
  } finally { app.dispose(); }
});

test('C-4) 守卫函数本身：invBalGuardCheck 通过 / 报差异（含前后值）', () => {
  const orders = [mkInvOrder('K1', [{ pid: 'PA', qty: 1000, dv: 0 }])];
  const deliveries = [mkDel('K1', 'JFJH-1', [{ pid: 'PA', plan: 1000, ol: 0 }])];
  const plans = [mkPlan('P1', 'K1', 0, 'JFJH-1', 'PA', 1000, 0, 0)];
  const app = boot({ orders: orders, deliveries: deliveries, productionPlans: plans });
  try {
    /* 同一段脚本内完成「取快照 → 未改动比对 → 只改完成量比对」（避免跨 run 传递 vm 对象） */
    const r = JSON.parse(app.run('JSON.stringify((function(){'
      + 'var rows=invBalGuardRowsOfDeltas(productionPlans[0],[{productId:"PA",qty:200,orderLine:0}],buildPlannedUndelMap());'
      + 'var pass=invBalGuardCheck(rows,buildPlannedUndelMap()).length;'
      + 'productionPlans[0].items[0].doneQty=200;'               /* 模拟「回写丢失」：只增完成量、不增已交付 */
      + 'var bad=invBalGuardCheck(rows,buildPlannedUndelMap());'
      + 'return {n:rows.length,pass:pass,bad:bad};'
      + '})())'));
    assert.equal(r.n, 1);
    assert.equal(r.pass, 0, '未改动 → 通过');
    assert.equal(r.bad.length, 1);
    assert.equal(r.bad[0].before, 1000);
    assert.equal(r.bad[0].after, 800);
    assert.ok(r.bad[0].reason.indexOf('结余') >= 0);
  } finally { app.dispose(); }
});

/* ================================================================
   §D 一次性数据订正
================================================================ */
function driftSeed(dv) {
  const orders = [mkInvOrder('KCDD-20260821-00008', [{ pid: 'C02.02.026', qty: 500, dv: dv }])];
  const deliveries = [mkDel('KCDD-20260821-00008', 'JFJH-1', [{ pid: 'C02.02.026', plan: 500, ol: 0 }])];
  const plans = [mkPlan('P1', 'KCDD-20260821-00008', 0, 'JFJH-1', 'C02.02.026', 500, 1000, 0)];
  return boot({ orders: orders, deliveries: deliveries, productionPlans: plans, meta: { seq: 0 } });
}

test('D-1) 订正：已交付 0 → −200，结余恢复 −700，标记置位', async () => {
  const app = driftSeed(0);
  try {
    await app.run('fixInvDeliveredDrift20261007()');
    assert.equal(num(app.run('orders[0].items[0].deliveredQty')), -200);
    assert.equal(app.run('meta.fixInvDeliveredDrift20261007'), true);
    assert.equal(app.run('invBalanceOf(orders[0].items[0].deliveredQty,invPuOf(buildPlannedUndelMap(),"KCDD-20260821-00008",0,"C02.02.026"))'), -700);
  } finally { app.dispose(); }
});

test('D-2) 幂等：标记已置 → 二次运行不再改动', async () => {
  const app = driftSeed(-200);
  try {
    await app.run('fixInvDeliveredDrift20261007()');
    await app.run('fixInvDeliveredDrift20261007()');
    assert.equal(num(app.run('orders[0].items[0].deliveredQty')), -200, '不得二次扣减');
  } finally { app.dispose(); }
});

test('D-3) 前置基线校验：当前值 ≠ 预期基线（0）→ 跳过不改写（防二次伤害）', async () => {
  const app = driftSeed(50);
  try {
    await app.run('fixInvDeliveredDrift20261007()');
    assert.equal(num(app.run('orders[0].items[0].deliveredQty')), 50, '不符基线必须原样保留');
    assert.equal(app.run('meta.fixInvDeliveredDrift20261007'), true, '标记仍置位（一次性语义）');
    assert.ok(app.run('logs.some(function(x){return String(x.detail||"").indexOf("跳过")>=0;})'), '须记日志提示人工复核');
  } finally { app.dispose(); }
});

/* ================================================================
   §E 全库不变量自检
================================================================ */
test('E-1) 干净库 → 九项检查全通过（欠产清单为提示项）', () => {
  const orders = [mkInvOrder('K1', [{ pid: 'PA', qty: 1000, dv: 200 }])];
  const deliveries = [mkDel('K1', 'JFJH-1', [{ pid: 'PA', plan: 1000, ol: 0 }])];
  const plans = [mkPlan('P1', 'K1', 0, 'JFJH-1', 'PA', 1000, 400, 0)];
  const reports = [{ id: 'R1', planId: 'P1', date: '2026-09-01', time: '10:00', worker: 'T', items: [{ productId: 'PA', step: 'inbound', label: '入库', qty: 400 }] }];
  const app = boot({ orders: orders, deliveries: deliveries, productionPlans: plans, productionReports: reports });
  try {
    const r = JSON.parse(app.run('JSON.stringify(auditInvInvariants())'));
    assert.equal(r.ok, true, '不该有异常：' + JSON.stringify(r.checks.filter(function (c) { return !c.ok; })));
    /* .140：自检新增第 7 项「超排核对」（用户 2026-10-08 要求），项数 6 → 7 */
    /* .145：自检新增第 8 项「交付计划行级超排」+ 第 9 项「来源计划创建时序」，项数 7 → 9 */
    assert.equal(r.checks.length, 9);
    assert.equal(r.checks[5].info, true, '第 6 项为提示项（欠产清单）');
    assert.equal(r.checks[6].name, '超排核对', '第 7 项为超排核对（.140 新增）');
    assert.equal(r.checks[6].ok, true, '干净库（已下推=本批计划）不应有超排');
    assert.equal(r.checks[7].name, '交付计划行级超排', '第 8 项为交付计划行级超排（.145 新增）');
    assert.equal(r.checks[7].ok, true, '干净库（行级已排产=该行本批计划）不应有行级超排');
    assert.equal(r.checks[8].name, '来源计划创建时序', '第 9 项为来源计划创建时序（.145 新增）');
    assert.equal(r.checks[8].ok, true, '干净库不应有创建时序悖论');
  } finally { app.dispose(); }
});

test('E-2) 检出①报工流水 ≠ 完成量', () => {
  const orders = [mkInvOrder('K1', [{ pid: 'PA', qty: 1000, dv: 200 }])];
  const deliveries = [mkDel('K1', 'JFJH-1', [{ pid: 'PA', plan: 1000, ol: 0 }])];
  const plans = [mkPlan('P1', 'K1', 0, 'JFJH-1', 'PA', 1000, 400, 0)];
  const reports = [{ id: 'R1', planId: 'P1', date: '2026-09-01', time: '10:00', items: [{ productId: 'PA', step: 'inbound', qty: 600 }] }];
  const app = boot({ orders: orders, deliveries: deliveries, productionPlans: plans, productionReports: reports });
  try {
    const r = JSON.parse(app.run('JSON.stringify(auditInvInvariants())'));
    const c = r.checks[0];
    assert.equal(c.ok, false);
    assert.equal(c.bad.length, 1);
    assert.ok(c.bad[0].indexOf('报工流水') >= 0);
    assert.equal(r.ok, false);
  } finally { app.dispose(); }
});

test('E-3) 检出③来源编号缺失 + ⑤回写不可达 + ④完成量越界', () => {
  const orders = [mkInvOrder('K1', [{ pid: 'PA', qty: 1000, dv: 0 }])];
  const deliveries = [mkDel('K1', 'JFJH-1', [{ pid: 'PB', plan: 500, ol: 0 }])];
  const plans = [
    mkPlan('P1', 'K1', 0, '', 'PB', 500, 800, 0),   /* 无来源编号→③；回写不可达→⑤；done>plan→④ */
  ];
  const app = boot({ orders: orders, deliveries: deliveries, productionPlans: plans, productionReports: [] });
  try {
    const r = JSON.parse(app.run('JSON.stringify(auditInvInvariants())'));
    const byName = {};
    r.checks.forEach(function (c) { byName[c.name] = c; });
    assert.equal(byName['来源交付计划编号齐备'].ok, false, '③ 应检出');
    assert.equal(byName['完成量未越界'].ok, false, '④ 应检出');
    assert.equal(byName['入库回写可达'].ok, false, '⑤ 应检出');
    assert.equal(r.ok, false);
  } finally { app.dispose(); }
});

test('E-4) 归属错位（R1 复发）被检出②', () => {
  const orders = [mkInvOrder('K1', [{ pid: 'PA', qty: 1000, dv: 0 }]), mkInvOrder('K2', [{ pid: 'PZ', qty: 100 }])];
  const deliveries = [
    mkDel('K2', 'JFJH-A', [{ pid: 'PZ', plan: 100, ol: 0 }]),
    mkDel('K1', 'JFJH-B', [{ pid: 'PA', plan: 1000, ol: 0 }]),
  ];
  /* 排产单属 K1，却指向 K2 的交付计划（index 0） */
  const plans = [mkPlan('P1', 'K1', 0, 'JFJH-A', 'PA', 1000, 0, 0)];
  const app = boot({ orders: orders, deliveries: deliveries, productionPlans: plans, productionReports: [] });
  try {
    const r = JSON.parse(app.run('JSON.stringify(auditInvInvariants())'));
    const c = r.checks[1];
    assert.equal(c.ok, false, '② 应检出归属错位');
    assert.ok(c.bad[0].indexOf('K2') >= 0);
  } finally { app.dispose(); }
});

/* 注：清单原文把下面两条记作「E-4 / E-5」，但本文件 E-4 已被「归属错位（R1 复发）被检出②」占用，
   故顺延为 E-5 / E-6（用例内容与清单一致）。 */
test('E-5) ⑧ 交付计划行级超排：同一交付计划行被重复下推 → 检出（⑦ 订单行级看不出，⑧ 专补该盲区）', () => {
  /* 忠实复刻 .144 真实形状（JFJH-20260829-00007 / C01.05.010 重合闸，取 100/100/100/200 四张）：
     同一订单行挂**两张**交付计划（JFJH-1 与 JFJH-2 各 300，合计 600），把 4 张排产单
     （100+100+100+200=500，外键齐备、归属自洽、完成量不越界）全压在 JFJH-1 上：
       · JFJH-1 已排 500 > 本批 300（超 200）→ ⑧ 按「交付计划行」揪出；
       · 而**订单行级** Σ已下推 500 ≤ Σ本批计划 600 → ⑦ 超排核对**看不出**。
     这正是 ⑧ 存在的理由：⑦ 是订单行级聚合，同一订单行多张计划摊平后掩盖了单张计划被重复下推。
     （注：早先版本用「单张计划 300 挂两张各 200」的夹具，但那种形状 ⑦ 同样会检出，
       无法隔离 ⑧ 的独立价值，故改为上面的盲区形状。） */
  const orders = [mkInvOrder('K1', [{ pid: 'PA', qty: 600, dv: 0 }])];
  const deliveries = [
    mkDel('K1', 'JFJH-1', [{ pid: 'PA', plan: 300, ol: 0 }]),
    mkDel('K1', 'JFJH-2', [{ pid: 'PA', plan: 300, ol: 0 }]),
  ];
  const plans = [
    mkPlan('PSCD-20261005-001', 'K1', 0, 'JFJH-1', 'PA', 100, 0, 0),
    mkPlan('PSCD-20261005-002', 'K1', 0, 'JFJH-1', 'PA', 100, 0, 0),
    mkPlan('PSCD-20261005-003', 'K1', 0, 'JFJH-1', 'PA', 100, 0, 0),
    mkPlan('PSCD-20261005-004', 'K1', 0, 'JFJH-1', 'PA', 200, 0, 0),
  ];
  const app = boot({ orders: orders, deliveries: deliveries, productionPlans: plans, productionReports: [] });
  try {
    const r = JSON.parse(app.run('JSON.stringify(auditInvInvariants())'));
    const byName = {};
    r.checks.forEach(function (c) { byName[c.name] = c; });
    const c = byName['交付计划行级超排'];
    assert.equal(r.checks.length, 9);
    assert.equal(c.ok, false, 'JFJH-1 已排 500 > 本批计划 300 必须判负');
    assert.equal(c.bad.length, 1, '只有 JFJH-1 超排；JFJH-2（已排 0）不该被点名');
    assert.ok(c.bad[0].indexOf('JFJH-1') >= 0, '条目须点名该交付计划：' + c.bad[0]);
    assert.ok(c.bad[0].indexOf('500') >= 0 && c.bad[0].indexOf('300') >= 0 && c.bad[0].indexOf('超 200') >= 0,
      '条目须含已排 500 / 本批 300 / 超 200：' + c.bad[0]);
    assert.equal(byName['超排核对'].ok, true,
      '订单行级聚合（500 ≤ 600）看不出 → ⑦ 必须通过，实证 ⑧ 补的正是 ⑦ 的盲区');
    assert.equal(byName['来源计划创建时序'].ok, true, '本场景不涉时序悖论');
    assert.equal(r.ok, false, '有行级超排 → 总体必须判负');
  } finally { app.dispose(); }
});

test('E-6) ⑨ 来源计划创建时序：排产单(09-30)早于所属计划(10-05) → 检出（.144 PSCD-20260930-004 形态）', () => {
  const orders = [mkInvOrder('K1', [{ pid: 'PA', qty: 1000, dv: 0 }])];
  /* mkDel 固定 createdAt=2026-08-20，本用例需要「晚于排产单」的创建时间，故直接构造 */
  const deliveries = [{
    orderId: 'K1', customer: '库存', createdAt: '2026-10-05', planNo: 'JFJH-LATE',
    items: [{
      productId: 'PA', productName: 'PA', spec: '', model: '',
      orderQty: 1000, deliveredQty: 0, planQty: 1000, orderLine: 0,
    }],
  }];
  const plans = [mkPlan('PSCD-20260930-004', 'K1', 0, 'JFJH-LATE', 'PA', 1000, 0, 0)];
  const app = boot({ orders: orders, deliveries: deliveries, productionPlans: plans, productionReports: [] });
  try {
    const r = JSON.parse(app.run('JSON.stringify(auditInvInvariants())'));
    const byName = {};
    r.checks.forEach(function (c) { byName[c.name] = c; });
    const c = byName['来源计划创建时序'];
    assert.equal(r.checks.length, 9);
    assert.equal(c.ok, false, '排产单 09-30 早于所属计划 10-05 → 时间悖论必须判负');
    assert.equal(c.bad.length, 1);
    assert.ok(c.bad[0].indexOf('PSCD-20260930-004') >= 0 && c.bad[0].indexOf('20260930') >= 0,
      '条目须点名该排产单与其日期：' + c.bad[0]);
    assert.ok(c.bad[0].indexOf('JFJH-LATE') >= 0 && c.bad[0].indexOf('20261005') >= 0,
      '条目须点名所属计划与其创建日期：' + c.bad[0]);
    assert.equal(byName['交付计划行级超排'].ok, true, '本场景不涉行级超排（1000=1000）');
    assert.equal(r.ok, false, '有时间悖论 → 总体必须判负');
  } finally { app.dispose(); }
});

/* ================================================================
   §F 静态守卫：口径单源
================================================================ */
test('F-1) 结余公式只经唯一入口——index.html 不得残留裸钳制表达式', () => {
  assert.equal(/Math\.max\(\s*0\s*,\s*pu\.plan\s*-\s*pu\.done\s*\)/.test(INDEX_SRC), false,
    'index.html 中不得残留 `Math.max(0, pu.plan-pu.done)`（应走 invPlannedUndelOf / invBalanceOf）');
  assert.ok(INDEX_SRC.indexOf('function invPlannedUndelOf(') >= 0);
  assert.ok(INDEX_SRC.indexOf('function invBalanceOf(') >= 0);
  assert.ok(INDEX_SRC.indexOf('function invPuOf(') >= 0);
  /* 守卫与自检三点接线 */
  assert.ok(INDEX_SRC.indexOf('invBalGuardCheck(') >= 0);
  assert.ok(INDEX_SRC.indexOf('invBalGuardAlert(') >= 0);
  assert.ok(INDEX_SRC.indexOf('auditInvInvariants(') >= 0);
  assert.ok(INDEX_SRC.indexOf('fixInvDeliveredDrift20261007();') >= 0, '启动序须调用一次性订正');
  /* .141：两列必须**同规则不钳制**——不得把 max(0,·) 钳制加回「已计划未交付」 */
  assert.ok(/function invPlannedUndelOf\(pu\)\{return pu\?\(num\(pu\.plan\)-num\(pu\.done\)\):0;\}/.test(INDEX_SRC),
    'invPlannedUndelOf 必须为不钳制形态（.141 用户拍板 B 方案：恒等式 已交付 + 已计划未交付 = 结余）');
  assert.equal(/invPlannedUndelOf\(pu\)\{return pu\?Math\.max/.test(INDEX_SRC), false,
    '不得把 max(0,·) 钳制加回「已计划未交付」——否则恒等式「已交付 + 已计划未交付 = 结余」立刻破裂');
});
