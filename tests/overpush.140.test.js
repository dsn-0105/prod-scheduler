'use strict';
/* ================================================================
   tests/overpush.140.test.js —— 2026-10-08.140「超排订正 / 排产单解封 / 超排角标与自检」回归
   ================================================================
   用户诉求（2026-10-08，原话）：
     ① 报障 C01.03.009「已交付 20 / 已计划未交付 200 / 结余 220」→ 证实重复下推（两张各 200 均已报工）；
     ② 决策「D1.A。D2.A。D3.B。D4.可。D5.可。D6.可」——
        D1 撤销 C01.03.009 多出的 200；D2 订正系统重复下推的行；D3 清除孤儿报工；
        D4 修复排产单被锁死；D5 加超排角标；D6 自检加超排项。

   本文件钉死的口径：
     §A buildPpPushedMap：Σ已下推排产计划量（排除已取消），键口径与 done 同源
     §B invOverPushOf：超排 = Σ已下推 − Σ本批计划（>0 才成立）
     §C invOverPushTip：多行文案（含单号），无超排为空串
     §D 自检第 7 项「超排核对」
     §E fixOverPush20261008：删重复单 + 回退已交付（结余不变）+ 清报工；前置校验跳过；幂等
     §F D4 排产单解封（静态守卫：编辑上限放宽公式，且旧严格形态零残留）
     §G 静态守卫：水印、超排入口唯一

   运行：node --test tests/overpush.140.test.js
   ================================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createApp, ROOT } = require('./harness/sandbox');
const build = require('./harness/build');

const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* ---------- 夹具 ---------- */
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

/* ================================================================
   §A buildPpPushedMap
================================================================ */
function pushedSeed() {
  const orders = [mkInvOrder('K1', [{ pid: 'PA', qty: 1000, dv: 20 }])];
  const deliveries = [mkDel('K1', 'JFJH-1', [{ pid: 'PA', plan: 200, ol: 0 }])];
  const plans = [
    mkPlan('P-A', 'K1', 0, 'JFJH-1', 'PA', 200, 200),
    mkPlan('P-B', 'K1', 0, 'JFJH-1', 'PA', 200, 200),
    mkPlan('P-C', 'K1', 0, 'JFJH-1', 'PA', 50, 0, '已取消'),
  ];
  return boot({ orders: orders, deliveries: deliveries, productionPlans: plans });
}

test('A-1) Σ已下推排产计划量：累加非取消单，键与 done 同源', () => {
  const app = pushedSeed();
  try {
    const m = j(app, 'buildPpPushedMap()');
    assert.equal(m['K1|L0'].pushed, 400, '两张各 200（P-C 已取消不计）');
    assert.equal(m['K1|L0'].list.length, 2);
    assert.equal(m['K1|L0'].list[0].id, 'P-A');
    assert.equal(m['K1|L1'], undefined, '不存在的行不产生键');
  } finally { app.dispose(); }
});

test('A-2) 与 buildPlannedUndelMap 键口径同源（pushed 的键必在 puMap 中）', () => {
  const app = pushedSeed();
  try {
    const pm = j(app, 'buildPpPushedMap()');
    const pu = j(app, 'buildPlannedUndelMap()');
    Object.keys(pm).forEach(function (k) {
      assert.ok(pu[k], 'pushed 键 ' + k + ' 必须同源存在于 puMap');
      assert.equal(pu[k].done, pm[k].list.reduce(function (s, x) { return s + x.plan; }, 0),
        '同键下 done 与 pushed 明细合计均为 400（本场景两单均完成）');
    });
  } finally { app.dispose(); }
});

test('A-3) 独立单（deliveryIdx=null）与未绑定单不参与超排归集', () => {
  const app = boot({
    orders: [mkInvOrder('K1', [{ pid: 'PA', qty: 100, dv: 0 }])],
    deliveries: [mkDel('K1', 'JFJH-1', [{ pid: 'PA', plan: 100, ol: 0 }])],
    productionPlans: [mkPlan('P-X', 'K1', null, '', 'PA', 100, 0)],
  });
  try {
    assert.deepEqual(j(app, 'buildPpPushedMap()'), {}, '独立单不占交付计划额度');
    assert.equal(app.run('invOverPushOf(invPuOf(buildPlannedUndelMap(),"K1",0,"PA"),invPuOf(buildPpPushedMap(),"K1",0,"PA"))'), 0);
  } finally { app.dispose(); }
});

test('A-4) 外键目标已删且索引越界（解析为 null）的单不参与', () => {
  const app = boot({
    orders: [mkInvOrder('K1', [{ pid: 'PA', qty: 100, dv: 0 }])],
    deliveries: [mkDel('K1', 'JFJH-1', [{ pid: 'PA', plan: 100, ol: 0 }])],
    /* 外键查不到 → 回退存储索引 99（越界）→ ppDlIdxOf 返回 null */
    productionPlans: [mkPlan('P-X', 'K1', 99, 'JFJH-已删', 'PA', 100, 0)],
  });
  try {
    assert.deepEqual(j(app, 'buildPpPushedMap()'), {}, '解析为 null 即不占额度、不计入');
  } finally { app.dispose(); }
});

test('A-5) 外键查不到但存储索引有效 → 按既有回退口径参与（防误判）', () => {
  const app = boot({
    orders: [mkInvOrder('K1', [{ pid: 'PA', qty: 100, dv: 0 }])],
    deliveries: [mkDel('K1', 'JFJH-1', [{ pid: 'PA', plan: 100, ol: 0 }])],
    productionPlans: [mkPlan('P-X', 'K1', 0, 'JFJH-已删', 'PA', 100, 0)],
  });
  try {
    assert.equal(j(app, 'buildPpPushedMap()')['K1|L0'].pushed, 100, '回退 stored 索引命中 → 参与');
  } finally { app.dispose(); }
});

/* ================================================================
   §B / §C 超排判定与文案
================================================================ */
test('B-1) invOverPushOf：下推 400 > 本批计划 200 → 超排 200', () => {
  const app = pushedSeed();
  try {
    assert.equal(app.run('invOverPushOf({plan:200,done:400},{pushed:400,list:[]})'), 200);
    assert.equal(app.run('invOverPushOf({plan:200},{pushed:200,list:[]})'), 0, '相等不算超排');
    assert.equal(app.run('invOverPushOf({plan:200},{pushed:150,list:[]})'), 0, '未达不算超排');
    assert.equal(app.run('invOverPushOf(null,{pushed:1,list:[]})'), 0, '缺参安全');
    assert.equal(app.run('invOverPushOf({plan:1},null)'), 0, '缺参安全');
  } finally { app.dispose(); }
});

test('C-1) invOverPushTip：无超排 → 空串（调用方据此不画图标）', () => {
  const app = boot();
  try {
    assert.equal(app.run('invOverPushTip({plan:200,done:100},{pushed:200,list:[]})'), '');
    assert.equal(app.run('invOverPushTip({plan:200,done:100},{pushed:100,list:[]})'), '');
  } finally { app.dispose(); }
});

test('C-2) invOverPushTip：有超排 → 含超排量、单号、处置指引', () => {
  const app = pushedSeed();
  try {
    const t = app.run('invOverPushTip(invPuOf(buildPlannedUndelMap(),"K1",0,"PA"),invPuOf(buildPpPushedMap(),"K1",0,"PA"))');
    assert.ok(t.indexOf('超排 200') >= 0, '须含超排量：' + t);
    assert.ok(t.indexOf('P-A') >= 0 && t.indexOf('P-B') >= 0, '须列名下排产单：' + t);
    assert.ok(t.indexOf('已计划未交付') >= 0, '须说明「已计划未交付」为何为负');
    assert.ok(t.indexOf('负数') >= 0, '须点明该列此时为负数（.141 起不钳制，不再被掩盖成 0）');
  } finally { app.dispose(); }
});

/* ================================================================
   §D 自检第 7 项
================================================================ */
test('D-1) 自检第 7 项：超排场景被检出（ok=false 且项名与条目正确）', () => {
  const app = pushedSeed();
  try {
    const r = j(app, 'auditInvInvariants()');
    const c = r.checks[6];
    assert.equal(r.checks.length, 7);
    assert.equal(c.name, '超排核对');
    assert.equal(c.ok, false, '下推 400 > 本批计划 200 必须判负');
    assert.equal(c.bad.length, 1);
    assert.ok(c.bad[0].indexOf('超排 200') >= 0, '条目须含超排量：' + c.bad[0]);
  } finally { app.dispose(); }
});

test('D-2) 自检第 7 项：正常单通过', () => {
  const app = boot({
    orders: [mkInvOrder('K1', [{ pid: 'PA', qty: 1000, dv: 20 }])],
    deliveries: [mkDel('K1', 'JFJH-1', [{ pid: 'PA', plan: 200, ol: 0 }])],
    productionPlans: [mkPlan('P-A', 'K1', 0, 'JFJH-1', 'PA', 200, 100)],
  });
  try {
    const c = j(app, 'auditInvInvariants().checks[6]');
    assert.equal(c.ok, true, JSON.stringify(c.bad));
  } finally { app.dispose(); }
});

/* ================================================================
   §E fixOverPush20261008 订正
================================================================ */
/** 线上 C01.03.009 形态：本批计划 200，名下两张各 200 均已报工 */
function fixSeed(dlNo) {
  const orders = [mkInvOrder('KCDD-20260821-00027', [{ pid: 'C01.03.009', qty: 300, dv: 220 }])];
  const deliveries = [mkDel('KCDD-20260821-00027', 'JFJH-20260829-00009', [{ pid: 'C01.03.009', plan: 200, ol: 0 }])];
  const plans = [
    mkPlan('PSCD-20260829-005', 'KCDD-20260821-00027', 0, dlNo === undefined ? 'JFJH-20260829-00009' : dlNo, 'C01.03.009', 200, 200),
    mkPlan('PSCD-20260829-007', 'KCDD-20260821-00027', 0, 'JFJH-20260829-00009', 'C01.03.009', 200, 200),
  ];
  const reports = [
    mkRep('REP-20261006-015', 'PSCD-20260829-005', 'C01.03.009', 200),
    mkRep('REP-20261006-020', 'PSCD-20260829-007', 'C01.03.009', 200),
  ];
  return boot({ orders: orders, deliveries: deliveries, productionPlans: plans, productionReports: reports });
}

test('E-1) 订正：删重复单 200 台 → 已交付 220→20、done 400→200、结余不变、超排归零', async () => {
  const app = fixSeed();
  try {
    const before = {
      dq: num(app.run('orders[0].items[0].deliveredQty')),
      bal: app.run('invBalanceOf(orders[0].items[0].deliveredQty,invPuOf(buildPlannedUndelMap(),"KCDD-20260821-00027",0,"C01.03.009"))'),
      over: app.run('invOverPushOf(invPuOf(buildPlannedUndelMap(),"KCDD-20260821-00027",0,"C01.03.009"),invPuOf(buildPpPushedMap(),"KCDD-20260821-00027",0,"C01.03.009"))'),
      n: num(app.run('productionPlans.length')),
      rep: num(app.run('productionReports.length')),
    };
    assert.equal(before.dq, 220);
    assert.equal(before.over, 200, '订正前超排 200');
    assert.equal(before.n, 2);

    await app.run('fixOverPush20261008()');

    assert.equal(num(app.run('orders[0].items[0].deliveredQty')), 20, '已交付 220→20（回退重复单的 200）');
    assert.equal(num(app.run('productionPlans.length')), 1, '只剩保留的那张');
    assert.equal(app.run('productionPlans[0].id'), 'PSCD-20260829-007', '保留 -007（清单指定删 -005）');
    assert.equal(num(app.run('productionReports.length')), 1, '被撤单的报工流水一并清理');
    assert.equal(app.run('productionReports[0].id'), 'REP-20261006-020');
    assert.equal(app.run('invOverPushOf(invPuOf(buildPlannedUndelMap(),"KCDD-20260821-00027",0,"C01.03.009"),invPuOf(buildPpPushedMap(),"KCDD-20260821-00027",0,"C01.03.009"))'), 0, '超排归零');
    assert.equal(app.run('invBalanceOf(orders[0].items[0].deliveredQty,invPuOf(buildPlannedUndelMap(),"KCDD-20260821-00027",0,"C01.03.009"))'), before.bal,
      '**结余必须前后不变**（报工撤销：done↓ 与 已交付↓ 等量）');
    assert.equal(app.run('meta.fixOverPush20261008'), true, '幂等标记置位');
  } finally { app.dispose(); }
});

test('E-2) 前置校验：来源计划外键与清单不符 → 整项跳过（宁可不动也不猜）', async () => {
  const app = fixSeed('JFJH-OTHER');
  try {
    await app.run('fixOverPush20261008()');
    assert.equal(num(app.run('productionPlans.length')), 2, '归属不符必须原样保留');
    assert.equal(num(app.run('orders[0].items[0].deliveredQty')), 220, '已交付不得改动');
    assert.ok(app.run('logs.some(function(x){return String(x.detail||"").indexOf("跳过")>=0;})'), '须记日志说明跳过原因');
  } finally { app.dispose(); }
});

test('E-3) 幂等：标记已置 → 二次运行零变化', async () => {
  const app = fixSeed();
  try {
    await app.run('fixOverPush20261008()');
    const after1 = j(app, '(function(){return {dq:orders[0].items[0].deliveredQty,n:productionPlans.length,rep:productionReports.length};})()');
    await app.run('fixOverPush20261008()');
    const after2 = j(app, '(function(){return {dq:orders[0].items[0].deliveredQty,n:productionPlans.length,rep:productionReports.length};})()');
    assert.deepEqual(after2, after1, '二次运行不得再改');
  } finally { app.dispose(); }
});

test('E-4) D3：白名单孤儿报工被清除；白名单外/仍有主的记录不动', async () => {
  const orders = [mkInvOrder('K1', [{ pid: 'PA', qty: 100, dv: 0 }])];
  const deliveries = [mkDel('K1', 'JFJH-1', [{ pid: 'PA', plan: 100, ol: 0 }])];
  const plans = [mkPlan('P-ALIVE', 'K1', 0, 'JFJH-1', 'PA', 100, 0)];
  const reports = [
    mkRep('REP-20260824-001', 'PSCD-20260824-002', 'PA', 50, 'assembly'),   // 孤儿 + 白名单 → 删
    mkRep('REP-20260824-002', 'PSCD-20260824-002', 'PA', 10, 'assembly'),   // 孤儿 + 白名单 → 删
    mkRep('REP-OTHER-ORPHAN', 'PSCD-已不存在', 'PA', 5, 'assembly'),        // 孤儿但不在白名单 → 保留
    mkRep('REP-ALIVE-1', 'P-ALIVE', 'PA', 30),                              // 有主 → 保留
  ];
  const app = boot({ orders: orders, deliveries: deliveries, productionPlans: plans, productionReports: reports });
  try {
    await app.run('fixOverPush20261008()');
    const ids = j(app, 'productionReports.map(function(r){return r.id;})');
    assert.deepEqual(ids, ['REP-OTHER-ORPHAN', 'REP-ALIVE-1'], '仅白名单孤儿被清除');
  } finally { app.dispose(); }
});

/* ================================================================
   §F D4 排产单解封（静态守卫——harness 的 getElementById 恒为 null，saveProdPlan 属不可测边界）
================================================================ */
test('F-1) 编辑已有单的上限放宽公式在位（max(未排产, 本行当前计划量)）', () => {
  assert.ok(/const cap=\(remain!=null\)\?\(\(idx>=0\)\?Math\.max\(remain,ppPlanOf\(it\)\):remain\):null;/.test(INDEX_SRC),
    'saveProdPlan 必须含编辑解封公式');
  assert.ok(/if\(cap!=null&&q>cap\)\{/.test(INDEX_SRC), '拦截须改用放宽后的上限');
  assert.ok(/const capIn=\(remain!=null\)\?\(isNew\?remain:Math\.max\(remain,ppPlanOf\(it\)\)\):null;/.test(INDEX_SRC),
    '弹窗输入框 max 须同步放宽');
});

test('F-2) 旧严格形态零残留（下推仍严格 ≤ 未排产）', () => {
  assert.equal(/if\(remain!=null&&q>remain\)\{/.test(INDEX_SRC), false, '旧的严格拦截形态必须已移除');
  assert.equal(/remain!=null\?\(\'max="\'\+remain/.test(INDEX_SRC), false, '旧的严格 max 形态必须已移除');
  /* 下推分支仍用 remain（未放宽）——判别力：若把 isNew 判断删了，本断言与 F-1 同时失效 */
  assert.ok(/isNew\?remain:Math\.max\(remain,ppPlanOf\(it\)\)/.test(INDEX_SRC), 'isNew（下推）分支必须保持 remain');
});

/* ================================================================
   §G 静态守卫
================================================================ */
test('G-1) 水印：.140 权威形态恰 1 处，.139 零残留', () => {
  assert.equal((INDEX_SRC.match(build.buildMarkRe(build.BUILD)) || []).length, 1, '水印 .140 恰 1 处');
  assert.equal((INDEX_SRC.match(build.buildMarkRe(build.PREV)) || []).length, 0, '.139 权威形态应为 0 处');
});

test('G-2) 超排入口唯一：buildPpPushedMap / invOverPushOf / invOverPushTip 各恰 1 处定义', () => {
  assert.equal((INDEX_SRC.match(/function buildPpPushedMap\(/g) || []).length, 1);
  assert.equal((INDEX_SRC.match(/function invOverPushOf\(/g) || []).length, 1);
  assert.equal((INDEX_SRC.match(/function invOverPushTip\(/g) || []).length, 1);
  /* 计算列不得被改写：超排只用于提示与自检，不参与 invPlannedUndelOf / invBalanceOf */
  assert.equal(/invPlannedUndelOf[\s\S]{0,80}pushed/.test(INDEX_SRC), false, '「已计划未交付」不得掺入 pushed');
  assert.equal(/invBalanceOf[\s\S]{0,120}pushed/.test(INDEX_SRC), false, '「结余」不得掺入 pushed');
});

test('G-3) 订正函数挂载且幂等标记就位', () => {
  assert.ok(/await fixOverPush20261008\(\);/.test(INDEX_SRC), '必须在 initApp 启动序挂载');
  assert.ok(/meta\.fixOverPush20261008/.test(INDEX_SRC), '必须用 meta 幂等标记');
  assert.ok(/ppDoneOf\(it\)[\s\S]{0,200}writebackInboundMutation\(p\.orderId,it\.productId,-d,ppOrderLineOf\(p,it\)\)/.test(INDEX_SRC),
    '回退须走既有 writebackInboundMutation + ppOrderLineOf（口径单源）');
});
