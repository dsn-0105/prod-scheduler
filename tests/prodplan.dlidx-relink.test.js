'use strict';
/* ================================================================
   tests/prodplan.dlidx-relink.test.js —— 2026-10-07.137 事故修复回归
   ================================================================
   事故：报工后「已计划未交付」严重失真（用户报告 C04.03.008 显示 0 实际剩 200；
        C02.02.026 数据全错）。只读定性分析（_diag/报工回写与已计划未交付-失真分析-2026-10-07.md）
        定位两层根因：
     R1 **交付计划索引漂移**：deliveries 删除只做 splice，全工程无任何地方重排
        productionPlans[].deliveryIdx → 删一张交付计划，后续排产单引用集体前移一位，
        指向别人的交付计划（线上 85 张排产单中 59 张已错位）。
     R2 **done 归集不校验产品**：buildPlannedUndelMap 按 dlLine 取交付行时不比对 productId，
        随即用该行的 orderLine 生成归集 key → 别产品的完成量灌进本行（放大器）。

   本文件钉死的口径：
     §A R2：dlLine 取到的交付行产品与本排产行不一致 → 视为无行，不得用它的 orderLine 生成 key。
     §B ppDlIdxOf：排产单 → 交付计划索引的**唯一解析入口**（外键优先 / 独立单恒 null /
        越界 null / 无外键回退索引）。
     §C 归属判定与聚合一律经 ppDlIdxOf（外键优先，抗漂移）。
     §D relinkProdPlanDeliveryIdx：删除交付计划后按外键重排；目标已删 → 索引与外键一并清空；无外键单保持原样。
     §E 静态守卫：外键写入/清空点 + 删除后重排接线 + 行解析口径单源（不得在 index.html 二次实现）。
     §F （.138）ppDlRowOf / ppDoneKeyOf：行解析与归集 key 的**唯一口径**。
     §G （.138）ppDlLinkDecide：外键 / 自洽 / 唯一候选 / 归集等价多候选 / 无线索 → 保持原样。
     §H （.138）rebindProdPlanDlIdx：一次性幂等迁移（写集、标记、失败复位、留人工不动、独立单不参与、
        重绑后「已计划未交付」按本订单归集）。

   运行：node --test tests/prodplan.dlidx-relink.test.js（**不要用 node -e**，见 tests/README）
   ================================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createApp, ROOT } = require('./harness/sandbox');

const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CORE_SRC = fs.readFileSync(path.join(ROOT, 'js', 'prodplan-core.js'), 'utf8');

/** 跨 realm 对象转成本 realm 纯对象（vm 返回的对象原型属于 vm realm） */
function plain(v) { return JSON.parse(JSON.stringify(v)); }

/* ---------- 夹具 ---------- */
/** 交付计划：rows = [{pid, plan, ol}]（ol 缺省取行号） */
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
    customer: '库存', finalDate: '', planDate: '2026-08-25', status: '已完成', notes: '',
    items: [{
      productId: pid, productName: pid, spec: '', model: '', unit: '台',
      planQty: planQty, doneQty: doneQty,
      dlLine: (dlLine === undefined ? 0 : dlLine), steps: null, stepsDef: null,
    }],
  };
}
function boot(deliveries, productionPlans) {
  return createApp({
    quietConsole: true,
    seed: {
      deliveries: deliveries, productionPlans: productionPlans,
      orders: [], products: [], productionReports: [], transfers: [], processTemplates: [],
    },
  });
}
function puMapOf(app) {
  return JSON.parse(app.run('JSON.stringify(buildPlannedUndelMap())'));
}
function doneAt(m, key) { return (m[key] && m[key].done) || 0; }

/* ================================================================
   §A R2：dlLine 命中的交付行产品不符 → 不得串料
   ================================================================ */
test('§A-1 R2：dlLine 命中行产品不符 → 不用它的 orderLine 生成 key（不串料）', () => {
  const D = [
    mkDel('O-A', 'JFJH-20260820-00001', [{ pid: 'PA', plan: 100 }]),
    mkDel('O-B', 'JFJH-20260820-00002', [{ pid: 'PB', plan: 50 }]),
  ];
  /* 排产单属 O-B/产品 PB，但 deliveryIdx 错位指向 D[0]（O-A），dlLine=0 命中 O-A 的 PA 行。
     修复前：用 PA 行的 orderLine=0 生成 key 'O-A|L0' → PB 的 50 被灌进 PA 行（串料）。
     修复后：产品不符 → 视为无行 → 退化为产品级 key 'O-A|PB'（该 key 无 plan，不影响任何行）。 */
  const P = [mkPlan('PSCD-20260825-001', 'O-B', 0, '', 'PB', 50, 50, 0)];
  const app = boot(D, P);
  const m = puMapOf(app);
  app.dispose();

  assert.equal(doneAt(m, 'O-A|L0'), 0, 'O-A|L0 不得被别订单/别产品的完成量污染（修复前=50）');
  assert.equal(doneAt(m, 'O-A|PB'), 50, 'PB 的 done 应退化为产品级 key 兜底，且不误算进 O-A 的行级 key');
});

test('§A-2 R2：产品一致时 dlLine 命中行仍照常归行级（零行为变化）', () => {
  const D = [
    mkDel('O-A', 'JFJH-20260820-00001', [{ pid: 'PA', plan: 100 }, { pid: 'PA', plan: 60 }]),
  ];
  /* 第二行（dlLine=1、orderLine=1）与排产行同产品 → 必须照旧归到 'O-A|L1' */
  const P = [mkPlan('PSCD-20260825-001', 'O-A', 0, '', 'PA', 60, 60, 1)];
  const app = boot(D, P);
  const m = puMapOf(app);
  app.dispose();
  assert.equal(doneAt(m, 'O-A|L1'), 60, '产品一致时按 dlLine → orderLine 归行级（原口径不变）');
  assert.equal(doneAt(m, 'O-A|L0'), 0, '不得误入另一行');
});

test('§A-3 R2：dlLine 越界 → 退化为唯一同产品行匹配（原有 .54 兜底不变）', () => {
  const D = [mkDel('O-A', 'JFJH-20260820-00001', [{ pid: 'PA', plan: 100 }])];
  const P = [mkPlan('PSCD-20260825-001', 'O-A', 0, '', 'PA', 100, 40, 9)];
  const app = boot(D, P);
  const m = puMapOf(app);
  app.dispose();
  assert.equal(doneAt(m, 'O-A|L0'), 40, '越界 dlLine 应回退「唯一同产品行」并归行级');
});

/* ================================================================
   §B ppDlIdxOf：唯一解析入口
   ================================================================ */
test('§B ppDlIdxOf：外键优先 / 独立单恒 null / 越界 null / 无外键回退索引', () => {
  const D = [
    mkDel('O-A', 'JFJH-20260820-00001', [{ pid: 'PA', plan: 100 }]),
    mkDel('O-B', 'JFJH-20260820-00002', [{ pid: 'PB', plan: 50 }]),
  ];
  const P = [
    mkPlan('PSCD-20260825-001', 'O-B', 0, 'JFJH-20260820-00002', 'PB', 50, 0),   // 外键指向 D1，索引指向 D0
    mkPlan('PSCD-20260825-002', 'O-B', null, 'JFJH-20260820-00002', 'PB', 50, 0), // 独立单 + 误带外键
    mkPlan('PSCD-20260825-003', 'O-B', 99, '', 'PB', 50, 0),                      // 越界索引、无外键
    mkPlan('PSCD-20260825-004', 'O-B', 1, '', 'PB', 50, 0),                       // 存量无外键 → 回退索引
    mkPlan('PSCD-20260825-005', 'O-B', 0, 'JFJH-99999999-99999', 'PB', 50, 0),    // 外键查不到 → 回退索引
  ];
  const app = boot(D, P);
  const got = JSON.parse(app.run('JSON.stringify(productionPlans.map(function(p){return ppDlIdxOf(p);}))'));
  app.dispose();

  assert.equal(got[0], 1, '外键优先：即使索引指向 D0 也应解析到 D1');
  assert.equal(got[1], null, '独立单（deliveryIdx=null）恒为 null——不占额度，独立单清空外键是配套硬约束');
  assert.equal(got[2], null, '越界索引且无外键 → null');
  assert.equal(got[3], 1, '存量无外键 → 回退存储索引');
  assert.equal(got[4], 0, '外键查不到 → 回退存储索引');
});

test('§B-2 存量（无外键）行为与改造前逐字一致：解析结果 == deliveryIdx', () => {
  const D = [
    mkDel('O-A', 'JFJH-20260820-00001', [{ pid: 'PA', plan: 100 }]),
    mkDel('O-B', 'JFJH-20260820-00002', [{ pid: 'PB', plan: 50 }]),
  ];
  /* 模拟线上存量形态：全部无 deliveryPlanNo（该字段本轮才引入） */
  const P = [
    mkPlan('PSCD-20260825-001', 'O-A', 0, '', 'PA', 100, 100, 0),
    mkPlan('PSCD-20260825-002', 'O-B', 1, '', 'PB', 50, 50, 0),
    mkPlan('PSCD-20260825-003', 'O-A', null, '', 'PA', 10, 0, 0),
  ];
  const app = boot(D, P);
  const got = JSON.parse(app.run('JSON.stringify(productionPlans.map(function(p){return ppDlIdxOf(p);}))'));
  app.dispose();
  assert.deepEqual(got, [0, 1, null], '存量侧零行为变化（已用线上 85 张排产单实测 A/B 解析 0 张不同）');
});

/* ================================================================
   §C 归属判定与聚合经 ppDlIdxOf（外键优先）
   ================================================================ */
test('§C-1 归集归属走外键：错误索引不再把完成量算到别人账上', () => {
  const D = [
    mkDel('O-A', 'JFJH-20260820-00001', [{ pid: 'PA', plan: 100 }]),
    mkDel('O-B', 'JFJH-20260820-00002', [{ pid: 'PB', plan: 50 }]),
  ];
  /* 排产单属 O-B、产品 PB、外键指向 D1；索引错位指向 D0。
     修复前：以 deliveryIdx 判归属 → 进 di=0 循环 → dlLine=0 命中 PA 行 → 'O-A|L0' += 50（串料）。 */
  const P = [mkPlan('PSCD-20260825-001', 'O-B', 0, 'JFJH-20260820-00002', 'PB', 50, 50, 0)];
  const app = boot(D, P);
  const m = puMapOf(app);
  app.dispose();
  assert.equal(doneAt(m, 'O-A|L0'), 0, '外键优先 → 不得记入 O-A');
  assert.equal(doneAt(m, 'O-B|L0'), 50, '应记入外键所指交付计划（D1 → O-B）的行级 key');
});

test('§C-2 ppPlannedOfLine / ppPlannedTotal：已排产额度按外键归属计算', () => {
  const D = [
    mkDel('O-A', 'JFJH-20260820-00001', [{ pid: 'PA', plan: 100 }]),
    mkDel('O-B', 'JFJH-20260820-00002', [{ pid: 'PB', plan: 50 }, { pid: 'PA', plan: 30 }]),
  ];
  /* 排产单属 O-B（D1 行0=PB），索引错位指 0 */
  const P = [mkPlan('PSCD-20260825-001', 'O-B', 0, 'JFJH-20260820-00002', 'PB', 50, 0, 0)];
  const app = boot(D, P);
  const got = JSON.parse(app.run(`JSON.stringify({
    plannedD1: ppPlannedOfLine(1, 0, 'PB', null),
    plannedD0: ppPlannedOfLine(0, 0, 'PA', null),
    totalD1: ppPlannedTotal(1),
    totalD0: ppPlannedTotal(0)
  })`));
  app.dispose();
  assert.equal(got.plannedD1, 50, 'D1 行0 的「已排产」应含本单 50（外键归属）');
  assert.equal(got.plannedD0, 0, 'D0 的「已排产」不得被外键指向他处的单占用');
  assert.equal(got.totalD1, 50, 'D1 已下推合计 = 50');
  assert.equal(got.totalD0, 0, 'D0 已下推合计 = 0');
});

/* ================================================================
   §D relinkProdPlanDeliveryIdx：删除交付计划后重排
   ================================================================ */
test('§D-1 删除交付计划后按外键重排引用；无外键的存量单保持原样', () => {
  const D = [
    mkDel('O-0', 'JFJH-20260820-00001', [{ pid: 'P0', plan: 10 }]),
    mkDel('O-1', 'JFJH-20260820-00002', [{ pid: 'P1', plan: 20 }]),
    mkDel('O-2', 'JFJH-20260820-00003', [{ pid: 'P2', plan: 30 }]),
  ];
  const P = [
    mkPlan('PSCD-20260825-001', 'O-1', 1, 'JFJH-20260820-00002', 'P1', 20, 0),
    mkPlan('PSCD-20260825-002', 'O-2', 2, 'JFJH-20260820-00003', 'P2', 30, 0),
    mkPlan('PSCD-20260825-003', 'O-1', 1, '', 'P1', 20, 0),   // 存量无外键
  ];
  const app = boot(D, P);
  /* 删除 D[0]：D1→0、D2→1 */
  const n = app.run('(function(){deliveries.splice(0,1);return relinkProdPlanDeliveryIdx();})()');
  const idx = JSON.parse(app.run('JSON.stringify(productionPlans.map(function(p){return p.deliveryIdx;}))'));
  app.dispose();

  assert.equal(n, 2, '两张带外键的排产单应被重排');
  assert.deepEqual(idx, [0, 1, 1], '带外键的按编号重定位；无外键（第 3 张）保持原索引不动');
});

test('§D-2 目标交付计划被删 → deliveryIdx 置 null（退化为不占额度的独立单）', () => {
  const D = [
    mkDel('O-1', 'JFJH-20260820-00002', [{ pid: 'P1', plan: 20 }]),
    mkDel('O-2', 'JFJH-20260820-00003', [{ pid: 'P2', plan: 30 }]),
  ];
  const P = [
    mkPlan('PSCD-20260825-001', 'O-1', 0, 'JFJH-20260820-00002', 'P1', 20, 0),
    mkPlan('PSCD-20260825-002', 'O-2', 1, 'JFJH-20260820-00003', 'P2', 30, 0),
  ];
  const app = boot(D, P);
  /* 删除 D[0]（PSCD-20260825-001 的目标） */
  const n = app.run('(function(){deliveries.splice(0,1);return relinkProdPlanDeliveryIdx();})()');
  const got = JSON.parse(app.run('JSON.stringify(productionPlans.map(function(p){return {idx:p.deliveryIdx,res:ppDlIdxOf(p)};}))'));
  app.dispose();
  assert.equal(n, 2);
  assert.equal(got[0].idx, null, '目标已删 → 置 null（与其 plan/done 同时退出归集，语义自洽）');
  assert.equal(got[0].res, null, '解析结果同为 null');
  assert.equal(got[1].idx, 0, '另一张按编号重定位到 0');
});

/* ================================================================
   §E 静态守卫
   ================================================================ */
test('§E-1 prodplan-core.js：归属比较一律经 ppDlIdxOf（无直读 deliveryIdx 的比较残留）', () => {
  const body = CORE_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.match(body, /function\s+ppDlIdxOf\s*\(/, '必须存在唯一解析入口 ppDlIdxOf');
  assert.ok(!/p\.deliveryIdx\s*!==\s*deliveryIdx/.test(body),
    '不得残留 `p.deliveryIdx!==deliveryIdx` 直读比较（口径单源：一律经 ppDlIdxOf）');
  assert.ok(!/p\.deliveryIdx\s*===\s*deliveryIdx/.test(body), '不得残留 === 形态直读比较');
  /* 独立单语义必须保留在 ppDlIdxOf 内（deliveryIdx==null → null） */
  assert.match(body, /function\s+ppDlIdxOf\s*\(p\)\s*\{\s*if\s*\(\s*!p\s*\|\|\s*p\.deliveryIdx\s*==\s*null\s*\)\s*return\s+null;/,
    'ppDlIdxOf 必须保留「独立单恒 null」的前置判定');
});

test('§E-2 index.html：外键写入 9 处（创建/继承/刷新/复制清空/重绑写/悬空清空 + .144 订正 3 处）+ 迁移与重排的写/清各 1 处', () => {
  /* 口径单源：新增任何 deliveryPlanNo 写入点都必须同步更新本断言 */
  const writes = INDEX_SRC.match(/deliveryPlanNo\s*[:=]/g) || [];
  assert.equal(writes.length, 9, '应恰 9 处 deliveryPlanNo 写入/清空（下推、拆单、编辑刷新、复制清空、重绑迁移写、悬空清空、' +
    '.144 订正改绑 1 处 + 复原快照常量 2 处），实际 ' + writes.length);
  assert.match(INDEX_SRC, /deliveryPlanNo:\(deliveries\[di\]&&deliveries\[di\]\.planNo\)\|\|''/, '下推应写入外键（取自交付计划编号）');
  assert.match(INDEX_SRC, /deliveryPlanNo:p\.deliveryPlanNo\|\|''/, '拆单应继承外键');
  assert.match(INDEX_SRC, /c\.deliveryPlanNo=''/, '复制单（独立排产）必须清空外键');
  assert.match(INDEX_SRC, /p\.deliveryPlanNo=no;/, '重绑迁移应写入外键');
  assert.match(INDEX_SRC, /if\(i<0&&p\.deliveryPlanNo\)\{p\.deliveryPlanNo=null;ch=true;\}/, '目标已删 → 悬空外键一并清空（且必须计数，否则内存改了不落盘）');
  /* 2026-10-12.144：存量订正脚本改绑时**索引与外键必须一并写**（缺外键则解析不到，缺索引则回退路径取错目标） */
  assert.match(INDEX_SRC, /p\.deliveryIdx=to;p\.deliveryPlanNo=cfg\[2\];/, '.144 订正改绑必须索引 + 外键一并写');
  assert.match(INDEX_SRC, /meta\.fixMisboundProdPlans20261012/, '.144 订正必须有幂等标记');
  /* 单条删除：splice 后必须重排，且与 deliveries 同事务 */
  assert.match(INDEX_SRC, /deliveries\.splice\(idx,1\);\s*\n\s*const rl=relinkProdPlanDeliveryIdx\(\);/,
    'delDelivery 删除后必须立即按外键重排');
  /* 批量删除：delivery 分支也要重排 */
  assert.match(INDEX_SRC, /idxs\.forEach\(i=>deliveries\.splice\(i,1\)\);\s*\n\s*dataOp=\{key:'deliveries',value:deliveries\};\s*\n[\s\S]{0,200}?relinkProdPlanDeliveryIdx\(\)/,
    '批量删除交付计划后也必须重排');
});

test('§E-3 行解析口径单源：index.html 只委托 ppDoneKeyOf，产品校验落在 prodplan-core.js', () => {
  /* .138：产品校验从 index.html 内联迁到核心纯函数 ppDoneKeyOf/ppDlRowOf —— index.html 不得再留一份 */
  assert.match(INDEX_SRC, /const k=ppDoneKeyOf\(d,y\);/, '归集必须委托 ppDoneKeyOf（口径单源）');
  assert.ok(!/_rows\.filter\(function\(x\)\{return String\(x\.productId\)===String\(y\.productId\);\}\)/.test(INDEX_SRC),
    'index.html 不得残留行解析副本（撤回 .137 内联实现）');
  const core = CORE_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.match(core, /function\s+ppDlRowOf\s*\(d,y\)\{[\s\S]{0,400}?String\(c\.productId\)===String\(y\.productId\)/,
    'ppDlRowOf 必须校验 productId（R2 修复点，防串料）');
  assert.match(core, /function\s+ppDoneKeyOf\s*\(d,y\)\{[\s\S]{0,200}?ppDlRowOf\(d,y\)/,
    'ppDoneKeyOf 必须经 ppDlRowOf 取行（不得直读 dlLine）');
  /* 报工回写订单行同源：ppOrderLineOf 也必须经 ppDlRowOf */
  assert.match(INDEX_SRC, /const drow=ppDlRowOf\(dl,it\);/, 'ppOrderLineOf 必须经 ppDlRowOf（回写行号同源）');
});

/* ================================================================
   §F ppDlRowOf / ppDoneKeyOf —— 行解析与归集 key 的唯一口径
   ================================================================ */
function keyAt(app, pi, yIdx) {
  return app.run('(function(){var p=productionPlans[' + pi + '];var i=ppDlIdxOf(p);' +
    'return JSON.stringify(ppDoneKeyOf(i==null?null:deliveries[i],ppItems(p)[' + yIdx + ']));})()');
}

test('§F-1 行解析：dlLine 命中且产品一致 → 行级 key；越界 → 产品唯一匹配', () => {
  const D = [mkDel('O-A', 'JFJH-20260820-00001', [{ pid: 'PA', plan: 100 }, { pid: 'PB', plan: 20 }])];
  const P = [
    mkPlan('PSCD-20260825-001', 'O-A', 0, '', 'PB', 20, 0, 1),   // dlLine=1 → PB 行 → orderLine 1
    mkPlan('PSCD-20260825-002', 'O-A', 0, '', 'PA', 100, 0, 9),  // dlLine 越界 → 产品唯一匹配 PA → orderLine 0
  ];
  const app = boot(D, P);
  assert.equal(JSON.parse(keyAt(app, 0, 0)), 'O-A|L1');
  assert.equal(JSON.parse(keyAt(app, 1, 0)), 'O-A|L0');
  app.dispose();
});

test('§F-2 行解析：dlLine 命中但产品不符且无同产品行 → 退化产品级 key（不串料）', () => {
  const D = [
    mkDel('O-A', 'JFJH-20260820-00001', [{ pid: 'PA', plan: 100 }]),
    mkDel('O-B', 'JFJH-20260820-00002', [{ pid: 'PB', plan: 50 }]),
  ];
  /* 排产行 PB 但归属被解析到 D0（O-A / PA）：产品不符 + 无同产品行 → 产品级 key，不落别人的行级 key */
  const P = [mkPlan('PSCD-20260825-001', 'O-A', 0, '', 'PB', 50, 0, 0)];
  const app = boot(D, P);
  assert.equal(JSON.parse(keyAt(app, 0, 0)), 'O-A|PB');
  app.dispose();
});

test('§F-3 行解析：同产品多行 → 歧义返回 null（退化产品级 key，不猜行）', () => {
  const D = [mkDel('O-A', 'JFJH-20260820-00001', [{ pid: 'PA', plan: 100 }, { pid: 'PA', plan: 60 }])];
  const P = [mkPlan('PSCD-20260825-001', 'O-A', 0, '', 'PA', 60, 0, 7)];   // dlLine 越界 + 两行同产品
  const app = boot(D, P);
  assert.equal(JSON.parse(keyAt(app, 0, 0)), 'O-A|PA', '多行歧义 → 不取任何行号（宁可退化也不误算）');
  app.dispose();
});

test('§F-4 行解析：交付行无 orderLine（存量）→ 产品级 key（.33 行为不变）', () => {
  const D = [{ orderId: 'O-A', planNo: 'JFJH-20260820-00001', items: [{ productId: 'PA', planQty: 100 }] }];
  const P = [mkPlan('PSCD-20260825-001', 'O-A', 0, '', 'PA', 100, 0, 0)];
  const app = boot(D, P);
  assert.equal(JSON.parse(keyAt(app, 0, 0)), 'O-A|PA');
  app.dispose();
});

/* ================================================================
   §G ppDlLinkDecide —— 来源绑定判定（纯函数）
   ================================================================ */
function decide(app, i) {
  return JSON.parse(app.run('JSON.stringify(ppDlLinkDecide(productionPlans[' + i + ']))'));
}

test('§G-1 外键命中 → keep（即使存储索引指向别处）；外键目标已删 → set null', () => {
  const D = [
    mkDel('O-A', 'JFJH-1', [{ pid: 'PA', plan: 100 }]),
    mkDel('O-A', 'JFJH-2', [{ pid: 'PA', plan: 100 }]),
  ];
  const P = [
    mkPlan('PSCD-20260825-001', 'O-A', 0, 'JFJH-2', 'PA', 100, 0),
    mkPlan('PSCD-20260825-002', 'O-A', 1, 'JFJH-GONE', 'PA', 100, 0),
  ];
  const app = boot(D, P);
  const a = decide(app, 0), b = decide(app, 1);
  app.dispose();
  assert.equal(a.act, 'keep');
  assert.equal(a.to, 1, '外键优先 → 编号 JFJH-2 的索引 1');
  assert.equal(b.act, 'set');
  assert.equal(b.to, null, '外键目标已删 → 解绑（置 null）');
});

test('§G-2 无外键且当前索引自洽 → keep（只回填外键，不改索引）', () => {
  const D = [mkDel('O-A', 'JFJH-1', [{ pid: 'PA', plan: 100 }])];
  const P = [mkPlan('PSCD-20260825-001', 'O-A', 0, '', 'PA', 100, 0)];
  const app = boot(D, P);
  const r = decide(app, 0);
  app.dispose();
  assert.equal(r.act, 'keep');
  assert.equal(r.level, '当前索引自洽');
});

test('§G-3 索引指向别订单 + 唯一候选 → set 到候选', () => {
  const D = [
    mkDel('O-B', 'JFJH-1', [{ pid: 'PB', plan: 50 }]),
    mkDel('O-A', 'JFJH-2', [{ pid: 'PA', plan: 100 }]),
  ];
  const P = [mkPlan('PSCD-20260825-001', 'O-A', 0, '', 'PA', 100, 0)];   // 索引 0 指向 O-B（错位）
  const app = boot(D, P);
  const r = decide(app, 0);
  app.dispose();
  assert.equal(r.act, 'set');
  assert.equal(r.to, 1);
  assert.match(r.level, /唯一候选/);
});

test('§G-4 多候选且归集口径等价 → set 最小位移候选（结果对结余无差别）', () => {
  const D = [
    mkDel('O-A', 'JFJH-1', [{ pid: 'PA', plan: 100 }]),
    mkDel('O-A', 'JFJH-2', [{ pid: 'PA', plan: 100 }]),
    mkDel('O-A', 'JFJH-3', [{ pid: 'PA', plan: 100 }]),
    mkDel('O-B', 'JFJH-9', [{ pid: 'PB', plan: 50 }]),
  ];
  const P = [mkPlan('PSCD-20260825-001', 'O-A', 3, '', 'PA', 100, 0)];   // 索引指向 O-B；候选 0/1/2 等价
  const app = boot(D, P);
  const r = decide(app, 0);
  app.dispose();
  assert.equal(r.act, 'set');
  assert.equal(r.cands.length, 3);
  assert.equal(r.to, 2, '最小位移：|2-3|=1 < |0-3| / |1-3|');
  assert.match(r.level, /等价/);
});

test('§G-5 零候选 → manual（保持原样，不猜）', () => {
  const D = [
    mkDel('O-A', 'JFJH-1', [{ pid: 'PX', plan: 100 }]),
    mkDel('O-B', 'JFJH-9', [{ pid: 'PB', plan: 50 }]),
  ];
  const P = [mkPlan('PSCD-20260825-001', 'O-A', 1, '', 'PA', 100, 0)];   // 本单无含 PA 的交付计划
  const app = boot(D, P);
  const r = decide(app, 0);
  app.dispose();
  assert.equal(r.act, 'manual');
  assert.equal(r.level, '无候选');
});

test('§G-6 候选时序过滤：交付计划创建晚于排产单 → 不入选（宁可留人工）', () => {
  const D = [
    mkDel('O-B', 'JFJH-9', [{ pid: 'PB', plan: 50 }]),
    { orderId: 'O-A', planNo: 'JFJH-LATE', createdAt: '2026-09-30',
      items: [{ productId: 'PA', planQty: 100, orderLine: 0 }] },
  ];
  const P = [mkPlan('PSCD-20260825-001', 'O-A', 0, '', 'PA', 100, 0)];   // 排产单 08-25 < 交付计划 09-30
  const app = boot(D, P);
  const r = decide(app, 0);
  app.dispose();
  assert.equal(r.act, 'manual', '时序不可能成立 → 不绑（保守）');
});

test('§G-7 行容量不足（候选计划量 < 排产量）→ 不入选', () => {
  const D = [
    mkDel('O-B', 'JFJH-9', [{ pid: 'PB', plan: 50 }]),
    mkDel('O-A', 'JFJH-1', [{ pid: 'PA', plan: 30 }]),   // 容量 30 < 排产 100
  ];
  const P = [mkPlan('PSCD-20260825-001', 'O-A', 0, '', 'PA', 100, 0)];
  const app = boot(D, P);
  const r = decide(app, 0);
  app.dispose();
  assert.equal(r.act, 'manual');
});

test('§G-8 独立单（deliveryIdx=null）→ skip（不参与绑定，恒不占额度）', () => {
  const D = [mkDel('O-A', 'JFJH-1', [{ pid: 'PA', plan: 100 }])];
  const P = [mkPlan('PSCD-20260825-001', 'O-A', null, '', 'PA', 100, 0)];
  const app = boot(D, P);
  const r = decide(app, 0);
  app.dispose();
  assert.equal(r.act, 'skip');
});

/* ================================================================
   §H rebindProdPlanDlIdx —— 一次性幂等迁移
   ================================================================ */
function bootMig(deliveries, productionPlans, meta) {
  return createApp({
    quietConsole: true,
    seed: {
      deliveries: deliveries, productionPlans: productionPlans, orders: [], products: [],
      productionReports: [], transfers: [], processTemplates: [], logs: [], meta: meta || { seq: 0 },
    },
  });
}

test('§H-1 迁移：错位单重绑 + 外键回填，一次事务只写 productionPlans；标记置真', async () => {
  const D = [
    mkDel('O-B', 'JFJH-1', [{ pid: 'PB', plan: 50 }]),
    mkDel('O-A', 'JFJH-2', [{ pid: 'PA', plan: 100 }]),
  ];
  const P = [
    mkPlan('PSCD-20260825-001', 'O-A', 0, '', 'PA', 100, 100),   // 错位（指向 O-B）→ 应重绑到 1
    mkPlan('PSCD-20260825-002', 'O-B', 0, '', 'PB', 50, 50),     // 自洽 → 只回填外键
    mkPlan('PSCD-20260825-003', 'O-A', null, '', 'PA', 10, 0),   // 独立单 → skip，不写外键
  ];
  const app = bootMig(D, P);
  await app.run('rebindProdPlanDlIdx()');
  const got = JSON.parse(app.run('JSON.stringify(productionPlans.map(function(p){return {idx:p.deliveryIdx,no:p.deliveryPlanNo};}))'));
  assert.deepEqual(got, [{ idx: 1, no: 'JFJH-2' }, { idx: 0, no: 'JFJH-1' }, { idx: null, no: '' }]);
  assert.equal(app.recorder.txCount(), 1, '一次事务提交');
  assert.deepEqual(plain(app.recorder.lastTx().keys), ['productionPlans'], '只写事实表 productionPlans');
  assert.equal(plain(app.getGlobal('meta')).fixProdPlanDlIdx20261007, true, '一次性标记必须落盘');
  app.dispose();
});

test('§H-2 迁移幂等：清标记后二次运行零变更、不发事务', async () => {
  const D = [
    mkDel('O-B', 'JFJH-1', [{ pid: 'PB', plan: 50 }]),
    mkDel('O-A', 'JFJH-2', [{ pid: 'PA', plan: 100 }]),
  ];
  const P = [mkPlan('PSCD-20260825-001', 'O-A', 0, '', 'PA', 100, 100)];
  const app = bootMig(D, P);
  await app.run('rebindProdPlanDlIdx()');
  const snap1 = app.run('JSON.stringify(productionPlans)');
  app.recorder.reset();
  app.setGlobal('__m', plain(app.getGlobal('meta')));
  app.run('meta=__m;meta.fixProdPlanDlIdx20261007=false;');
  await app.run('rebindProdPlanDlIdx()');
  assert.equal(app.run('JSON.stringify(productionPlans)'), snap1, '二次运行不得再改任何字段');
  assert.equal(app.recorder.txCount(), 0, '无变更不发事务');
  app.dispose();
});

test('§H-3 迁移：事务失败 → 标记复位（下次启动幂等重试）', async () => {
  const D = [
    mkDel('O-B', 'JFJH-1', [{ pid: 'PB', plan: 50 }]),
    mkDel('O-A', 'JFJH-2', [{ pid: 'PA', plan: 100 }]),
  ];
  const P = [mkPlan('PSCD-20260825-001', 'O-A', 0, '', 'PA', 100, 100)];
  const app = bootMig(D, P);
  app.recorder.failNext('tx', 'boom');
  await app.run('rebindProdPlanDlIdx()');
  assert.equal(plain(app.getGlobal('meta')).fixProdPlanDlIdx20261007, false, '失败必须复位标记（否则永久漏修）');
  app.dispose();
});

test('§H-4 迁移：无法唯一确定（零候选）→ 保持原样并记日志', async () => {
  const D = [mkDel('O-B', 'JFJH-1', [{ pid: 'PB', plan: 50 }])];
  const P = [mkPlan('PSCD-20260825-001', 'O-A', 0, '', 'PA', 100, 100)];
  const app = bootMig(D, P);
  await app.run('rebindProdPlanDlIdx()');
  const got = JSON.parse(app.run('JSON.stringify(productionPlans.map(function(p){return p.deliveryIdx;}))'));
  assert.deepEqual(got, [0], '歧义/无候选 → 索引原样保留，交人工核对');
  const logsTxt = app.run(`logs.map(function(x){return String(x.detail||'');}).join(' ')`);
  assert.match(logsTxt, /无法唯一确定/, '必须记日志点名待人工核对的排产单');
  app.dispose();
});

test('§H-5 迁移后：完成量按本订单归集（不再串料）', async () => {
  /* 事故形态：O-A 的单索引前移到 O-B 的交付计划上（C04.03.008 形态）。
     R2 已修（产品不符不落别人的行级 key），但完成量仍落在**本订单的幽灵产品级 key** 上，
     本行「已计划未交付」不减少 → 这正是重绑要修的存量。 */
  const D = [
    mkDel('O-B', 'JFJH-1', [{ pid: 'PB', plan: 200 }]),
    mkDel('O-A', 'JFJH-2', [{ pid: 'PA', plan: 300 }]),
  ];
  const P = [
    mkPlan('PSCD-20260825-001', 'O-A', 0, '', 'PA', 200, 200),   // 错位指向 O-B 的交付计划
    mkPlan('PSCD-20260825-002', 'O-B', 0, '', 'PB', 200, 200),
  ];
  const app = bootMig(D, P);
  const before = JSON.parse(app.run('JSON.stringify(buildPlannedUndelMap())'));
  await app.run('rebindProdPlanDlIdx()');
  const after = JSON.parse(app.run('JSON.stringify(buildPlannedUndelMap())'));
  app.dispose();
  /* 迁移前：O-A 的完成量落在幽灵 key（O-B|PA，无 plan）→ O-A 行「已计划未交付」虚高 300 */
  assert.deepEqual(before['O-A|L0'], { plan: 300, done: 0 });
  assert.deepEqual(before['O-B|PA'], { plan: 0, done: 200 });
  /* 迁移后：完成量回归本订单 → 未交付 300−200 = 100；幽灵 key 消失 */
  assert.deepEqual(after['O-A|L0'], { plan: 300, done: 200 });
  assert.equal(after['O-B|PA'], undefined, '幽灵产品级 key 必须消失（完成量回到行级）');
  assert.deepEqual(after['O-B|L0'], { plan: 200, done: 200 }, 'O-B 不受牵连');
});

