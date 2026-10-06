'use strict';
/* ================================================================
   tests/qa.delivery-planno.independent.test.js
   QA 独立回归 —— 交付计划「交付计划编号」planNo（2026-10-06.134 批次）
   ================================================================
   本文件由 QA（严过关）独立编写，**不复制也不依赖** tests/delivery.planno.test.js（工程师自测）。
   铁律：不采信工程师自述 —— 一切结论由本文件自行构造数据、自行驱动生产代码得出。

   覆盖（对应主理人下发的 V1–V11）：
     V3  内联块语法（in-process vm.Script 编译，绕开本机 spawnSync EBUSY 管道假失败）
     V5  线上真实形态 62 条 / 12 个日期的完整回填端到端（打印全量 + 逐日核对 + 唯一性 + 幂等 + 接续）
     V6  边界与负面（createdAt 异常 / 部分编号 / 同单同品 / 空白 planNo / 删最大号）
     V7  表单只读与编辑保全（真实渲染弹窗 HTML + 篡改注入）
     V8  导出与模板（真实调用 exportForm / downloadTemplate，捕获表头）
     V9  导入兜底（真实驱动 importXLSX 全流程：假 FileReader + 打桩 XLSX.parse）
     V10 线上真实 tblLayout 列序下的实际列位置 + rowspan 合并不破裂（真实跑 applyTableLayout）
     V11 水印锚点 / 残留 / git 工作树

   运行：node --test tests/qa.delivery-planno.independent.test.js
   ================================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { createApp, ROOT, extractInlineScripts } = require('./harness/sandbox');

const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const IMPORT_SRC = fs.readFileSync(path.join(ROOT, 'js', 'import.js'), 'utf8');

/** 编号格式（用户口径：JFJH-YYYYMMDD-XXXXX） */
const FMT = /^JFJH-\d{8}-\d{5}$/;
const ADMIN = { username: 'qa', name: 'QA严过关', role: 'admin', perms: {} };

function plain(v) {
  return JSON.parse(JSON.stringify(v));
}
/** 只装载、不挂记录器（纯逻辑断言） */
function app0(seed) {
  const o = { installRecorder: false };
  if (seed) o.seed = seed;
  return createApp(o);
}
/** 装载 + 记录器（断言写盘次数） */
function appR(seed) {
  const o = {};
  if (seed) o.seed = seed;
  return createApp(o);
}
function suffix(no) {
  return String(no).slice(-5);
}

/* ================================================================
   V3 语法：in-process 逐块编译（等价 node --check，绕开 EBUSY 管道）
   ================================================================ */

test('V3 index.html 3 个内联块 + 5 个外链模块均可编译（等价 node --check 的语法校验）', () => {
  const blocks = extractInlineScripts(INDEX_SRC);
  assert.equal(blocks.length, 3, 'index.html 应含 3 个内联 script 块');
  const bad = [];
  blocks.forEach((b, i) => {
    try {
      new vm.Script(b.code, { filename: 'index.html#inline' + i });
    } catch (e) {
      bad.push('inline#' + i + ': ' + e.message);
    }
  });
  ['js/logs.js', 'js/import.js', 'js/transfer.js', 'js/guide.js', 'js/prodplan-core.js'].forEach((rel) => {
    const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    try {
      new vm.Script(code, { filename: rel });
    } catch (e) {
      bad.push(rel + ': ' + e.message);
    }
  });
  assert.deepEqual(bad, [], '不得有语法错误；实际：' + bad.join(' | '));
  /* bootstrap() 自动执行点仍只在主块 */
  const hasBootstrap = blocks.map((b) => /(^|\n)[ \t]*bootstrap\(\)[ \t]*;/.test(b.code));
  assert.deepEqual(hasBootstrap, [false, true, false], '主块（#1）必须含 bootstrap() 自动执行点');
});

/* ================================================================
   V5 线上真实形态：62 条 / 12 个日期
   ================================================================ */

const REAL_DIST = {
  '2026-08-23': 15,
  '2026-08-25': 1,
  '2026-08-26': 1,
  '2026-08-27': 4,
  '2026-08-29': 10,
  '2026-08-30': 3,
  '2026-09-02': 1,
  '2026-09-21': 4,
  '2026-09-22': 2,
  '2026-09-29': 8,
  '2026-09-30': 11,
  '2026-10-05': 2,
};

/**
 * 自行构造等价于线上存量的 62 条交付计划。
 * 结构取自源码 deliveryItems() / doSaveDelivery 的落库形态：
 *   {orderId,customer,finalDate,firstDate,notes,items,orderTotal,delivered,undelivered,planQty,createdAt}
 * 刻意**跨日期轮转排列**（比真实更苛刻）：若实现依赖"数组下标"而非"同前缀 max+1"，必被击穿。
 */
function buildRealShapeSeed() {
  const quota = {};
  Object.keys(REAL_DIST).forEach((d) => { quota[d] = REAL_DIST[d]; });
  const dates = Object.keys(REAL_DIST);
  const out = [];
  let n = 0;
  let round = 0;
  while (Object.keys(quota).some((d) => quota[d] > 0)) {
    round++;
    if (round > 30) throw new Error('轮转生成失控');
    dates.forEach((date) => {
      if (quota[date] <= 0) return;
      quota[date]--;
      n++;
      out.push({
        orderId: 'KCDD-' + (1000 + n),
        customer: '客户' + n,
        finalDate: date,
        firstDate: date,
        notes: '',
        items: [{
          productId: 'P' + ((n % 7) + 1),
          productName: '产品' + ((n % 7) + 1),
          spec: '规格',
          model: '型号',
          orderQty: 10 + (n % 5),
          deliveredQty: n % 3,
          planQty: 5,
          lineNotes: '',
        }],
        orderTotal: 10 + (n % 5),
        delivered: n % 3,
        undelivered: 10 + (n % 5) - (n % 3),
        planQty: 5,
        createdAt: date,
      });
    });
  }
  return out;
}

test('V5 前置：构造数据集 = 62 条 / 12 个日期，且逐日条数与线上一致', () => {
  const seed = buildRealShapeSeed();
  assert.equal(seed.length, 62, '总数必须 62');
  const byDate = {};
  seed.forEach((d) => { byDate[d.createdAt] = (byDate[d.createdAt] || 0) + 1; });
  assert.deepEqual(byDate, REAL_DIST, '逐日条数必须与线上一致');
  assert.deepEqual(Object.keys(byDate).length, 12);
  assert.equal(seed.filter((d) => d.planNo).length, 0, '存量全部无编号（前置条件）');
  assert.equal(seed.filter((d) => Array.isArray(d.items) && d.items.length).length, 62, '全部含 items[]');
});

test('V5-1 完整回填：打印全量 62 条 + 逐日核对 00001..N + 格式合法 + 唯一', () => {
  const app = app0({ deliveries: buildRealShapeSeed() });
  app.run('migrateDeliveryPlanNo()');
  const got = plain(app.getGlobal('deliveries'));
  assert.equal(got.length, 62);

  console.log('---- V5 全量回填结果（62 条） ----');
  got.forEach((d, i) => {
    console.log(
      String(i + 1).padStart(3, ' ') + '  createdAt=' + String(d.createdAt) +
      '  planNo=' + String(d.planNo) + '  orderId=' + String(d.orderId)
    );
  });
  console.log('---- V5 打印结束 ----');

  /* 格式断言 */
  const badFmt = got.filter((d) => !FMT.test(String(d.planNo)));
  assert.deepEqual(badFmt.map((d) => d.planNo), [], '全部必须匹配 /^JFJH-\\d{8}-\\d{5}$/');

  /* 逐日核对：按 createdAt 分组、按数组顺序后缀从 1 递增 */
  Object.keys(REAL_DIST).forEach((date) => {
    const seq = got.filter((d) => d.createdAt === date).map((d) => Number(suffix(d.planNo)));
    const expect = Array.from({ length: REAL_DIST[date] }, (_, i) => i + 1);
    assert.deepEqual(seq, expect, date + ' 应为 00001..' + String(REAL_DIST[date]).padStart(5, '0'));
  });

  /* 编号日前缀必须与 createdAt 一致 */
  got.forEach((d) => {
    assert.equal(String(d.planNo).slice(5, 13), String(d.createdAt).replace(/-/g, ''), '前缀日期须等于 createdAt');
  });

  /* 唯一性穷举 */
  const set = new Set(got.map((d) => d.planNo));
  assert.equal(set.size, 62, 'new Set(planNo).size 必须 === 62');

  app.dispose();
});

test('V5-2 幂等：第二次回填逐字节相同，且零写盘', () => {
  const app = appR({ deliveries: buildRealShapeSeed() });
  app.run('migrateDeliveryPlanNo()');
  const after1 = plain(app.getGlobal('deliveries'));
  assert.equal(app.recorder.writeCount() > 0, true, '首次必有写盘');
  app.recorder.reset();
  app.run('migrateDeliveryPlanNo()');
  const after2 = plain(app.getGlobal('deliveries'));
  assert.deepEqual(after2, after1, '二次回填必须逐字节一致');
  assert.equal(app.recorder.writeCount(), 0, '二次回填不得产生任何写盘');
  app.dispose();
});

test('V5-3 回填后接续不撞号：09-30 新增 → 00012；10-06 新增 → 00001', () => {
  const app = app0({ deliveries: buildRealShapeSeed() });
  app.run('migrateDeliveryPlanNo()');
  app.setGlobals({ closeModal: function () {}, renderContent: function () {} });

  app.setGlobal('__a', { orderId: 'KCDD-NEW1', customer: '甲', createdAt: '2026-09-30', items: [{ productId: 'P1', planQty: 5 }] });
  app.run('doSaveDelivery(__a,-1)');
  assert.equal(plain(app.run('deliveries[deliveries.length-1]')).planNo, 'JFJH-20260930-00012');

  app.setGlobal('__b', { orderId: 'KCDD-NEW2', customer: '乙', createdAt: '2026-10-06', items: [{ productId: 'P1', planQty: 5 }] });
  app.run('doSaveDelivery(__b,-1)');
  assert.equal(plain(app.run('deliveries[deliveries.length-1]')).planNo, 'JFJH-20261006-00001');

  const all = plain(app.getGlobal('deliveries')).map((d) => d.planNo);
  assert.equal(all.length, 64);
  assert.equal(new Set(all).size, 64, '回填 + 新单必须全局唯一（64 条）');
  assert.equal(all.filter((x) => !FMT.test(String(x))).length, 0, '新单编号也须合法');
  app.dispose();
});

/* ================================================================
   V6 边界与负面
   ================================================================ */

test('V6-1 createdAt 为 ""/undefined/null → 兜底 2026-08-23 且格式合法', () => {
  const app = app0({
    deliveries: [
      { orderId: 'A', items: [], createdAt: '' },
      { orderId: 'B', items: [] },
      { orderId: 'C', items: [], createdAt: null },
    ],
  });
  app.run('migrateDeliveryPlanNo()');
  const got = plain(app.getGlobal('deliveries')).map((d) => d.planNo);
  assert.deepEqual(got, ['JFJH-20260823-00001', 'JFJH-20260823-00002', 'JFJH-20260823-00003'], '三条全部兜底到 08-23 并递增');
  got.forEach((x) => assert.match(String(x), FMT));
  app.dispose();
});

test('V6-2【第2轮·P-2 已修】createdAt 非法/缺失 → 一律进 2026-08-23 哨兵桶，编号格式恒合法', () => {
  /* 上一轮此处是「观测记录」锚点，钉住"非法日期原样入前缀"的旧行为。
     工程师 P-2 加了 /^\d{4}-\d{2}-\d{2}$/ 守卫后，本锚点**翻转** —— 翻转即证明修复生效。 */
  const app = app0({
    deliveries: [
      { orderId: 'A', items: [], createdAt: 'abc' },
      { orderId: 'B', items: [], createdAt: '2026-8-5' },
      { orderId: 'C', items: [], createdAt: '2026/08/23' },
      { orderId: 'D', items: [], createdAt: '20260823' },
      { orderId: 'E', items: [], createdAt: '2026-08-23T10:00:00' },
      { orderId: 'F', items: [], createdAt: '2026-08-23 ' },
      { orderId: 'G', items: [], createdAt: '   ' },
    ],
  });
  app.run('migrateDeliveryPlanNo()');
  const got = plain(app.getGlobal('deliveries')).map((d) => d.planNo);
  assert.deepEqual(got, [
    'JFJH-20260823-00001',
    'JFJH-20260823-00002',
    'JFJH-20260823-00003',
    'JFJH-20260823-00004',
    'JFJH-20260823-00005',   /* 带 T 的 ISO 由 fmtDate 截断 → 合法日期，同样落 08-23 桶 */
    'JFJH-20260823-00006',
    'JFJH-20260823-00007',
  ], '7 种非法/异常 createdAt 全部归一到哨兵桶并按序递增');
  assert.equal(got.filter((x) => !FMT.test(String(x))).length, 0, '全部必须匹配 /^JFJH-\\d{8}-\\d{5}$/');
  assert.equal(new Set(got).size, 7, '唯一性');
  app.dispose();

  /* 守卫覆盖 11 种输入（含 4 种"看起来像日期"的）：逐个验证落桶 + 长度 19 + 今天≠桶（证明不再用 todayStr） */
  const bad = ['', '   ', 'abc', '2026-8-5', '2026/08/23', '20260823', '2026-08-23 ', 'x2026-08-23',
    '2026-08-23T10:00:00', '2026-8-23', '2026-08-23-00'];
  const cases = ['undefined', 'null', ...bad.map((s) => JSON.stringify(s)), '"2026-09-30"'];
  const today = app0().run('todayStr()');
  cases.forEach((expr) => {
    const a = app0({ deliveries: [] });
    const v = String(a.run('nextDeliveryPlanNo(' + (expr === 'undefined' || expr === 'null' ? expr : expr) + ')'));
    assert.match(v, FMT, '输入 ' + expr + ' 必须产出合法编号，实际 ' + v);
    assert.equal(v.length, 19, '输入 ' + expr + ' 长度必须 19');
    if (expr === '"2026-09-30"') assert.equal(v, 'JFJH-20260930-00001', '合法日期必须用自身桶');
    else assert.equal(v, 'JFJH-20260823-00001', '输入 ' + expr + ' 必须落哨兵桶');
    a.dispose();
  });
  assert.notEqual(today, '2026-08-23', '（本机日期非哨兵日，故上式可区分"哨兵桶"与"当日桶"）');

  /* 口径变更·静态确认：函数体内已无 todayStr（不再回退当日） */
  const fnBody = INDEX_SRC.slice(INDEX_SRC.indexOf('function nextDeliveryPlanNo'));
  const fnOnly = fnBody.slice(0, fnBody.indexOf('\n}\n') + 3);
  assert.doesNotMatch(fnOnly.replace(/\/\*[\s\S]*?\*\//g, ''), /todayStr/, '不得再用 todayStr() 兜底');
  assert.match(fnOnly, /\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$/, '必须含 YYYY-MM-DD 格式守卫');
});

test('V6-2b【第2轮】哨兵桶接续：脏 createdAt 的新单不得另起 00001，须与同桶存量接续', () => {
  const app = app0({
    deliveries: [
      { orderId: 'A', createdAt: 'abc', planNo: 'JFJH-20260823-00001' },
      { orderId: 'B', createdAt: '2026-08-23', planNo: 'JFJH-20260823-00002' },
    ],
  });
  assert.equal(app.run('nextDeliveryPlanNo("2026-8-5")'), 'JFJH-20260823-00003',
    '归一化到哨兵桶后必须与同桶存量接续（否则会撞号）');
  assert.deepEqual(plain(app.run('normalizeImportedDeliveryPlanNo()')), { filled: 0, renumbered: 0 },
    '两条已有编号 → 导入归一化零改动');
  app.dispose();
});

test('V6-2c【第2轮·残余边界·登记】守卫只校验"形状"，不校验日期语义', () => {
  /* 守卫用 /^\d{4}-\d{2}-\d{2}$/：'2026-13-45'（13 月 45 日）、'0000-00-00' 均通过。
     结论：**不违反**用户声明的格式规则 /^JFJH-\d{8}-\d{5}$/（8 位数字日前缀成立），故不判缺陷。
     可达性：migrate 前置走 fmtDate（不校验语义）、import 传原始串；但 fields.delivery 无 createdAt 列 →
     导入无法带入 createdAt。故此边界仅"人工改库/未来新调用方"可达，低危，登记备查。 */
  const a = app0({ deliveries: [] });
  assert.equal(a.run('nextDeliveryPlanNo("2026-13-45")'), 'JFJH-20261345-00001');
  assert.equal(a.run('nextDeliveryPlanNo("0000-00-00")'), 'JFJH-00000000-00001');
  assert.match('JFJH-20261345-00001', FMT, '形状仍合法（8 位日前缀）');
  a.dispose();
});

test('V6-2d【第2轮·R3】todayStr 兜底移除无活路径回归：全工程调用点穷举，均显式传日期', () => {
  /* P-2 移除了 nextDeliveryPlanNo 内 `String(dateStr||todayStr())` 的当日兜底 → 非法/缺失一律哨兵。
     若存在"裸调用"（不传 dateStr），其行为会从"当日桶"漂移为"哨兵桶"，属活路径回归。此处穷举全工程调用点自证。 */
  const files = [['index.html', INDEX_SRC], ['js/import.js', IMPORT_SRC]]
    .concat(['logs.js', 'transfer.js', 'guide.js', 'prodplan-core.js'].map((f) => [f, fs.readFileSync(path.join(ROOT, 'js', f), 'utf8')]));
  const calls = [];
  files.forEach(([name, src]) => {
    src.split('\n').forEach((t, n) => {
      if (/nextDeliveryPlanNo\s*\(/.test(t) && !/function\s+nextDeliveryPlanNo\s*\(/.test(t) && !/^\s*(?:\/\*|\*)/.test(t)) {
        calls.push({ loc: name + ':' + (n + 1), line: t.trim() });
      }
    });
  });
  assert.equal(calls.length, 4, '当前全工程恰 4 个调用点（实际 ' + calls.length + '）：' + calls.map((c) => c.loc).join(', '));
  calls.forEach((c) => assert.match(c.line, /nextDeliveryPlanNo\s*\(\s*[^)\s]/, '调用点必须显式传参：' + c.loc + ' => ' + c.line));
  /* 三活路径实参来源保证非空：migrate=fmtDate||哨兵；新保存=todayStr()；编辑=原值||哨兵；import=createdAt||哨兵 */
  assert.match(INDEX_SRC, /d\.planNo=nextDeliveryPlanNo\(date\);/, 'migrate 传 date');
  assert.match(INDEX_SRC, /d\.planNo=nextDeliveryPlanNo\(d\.createdAt\);/, '新增保存传 d.createdAt');
  assert.match(IMPORT_SRC, /nextDeliveryPlanNo\(d\.createdAt\|\|'2026-08-23'\)/, 'import 传 createdAt||哨兵');
  assert.match(INDEX_SRC, /createdAt:\(idx>=0\)\?\(deliveries\[idx\]\.createdAt\|\|'2026-08-23'\):todayStr\(\)/,
    '唯一生产入口 saveDelivery 恒产出非空 createdAt（新增=todayStr，编辑=原值||哨兵）');
});

test('V6-3 同日已存在部分编号（仅 00003）→ 新增得 00004（max+1）', () => {
  const app = app0({
    deliveries: [
      { orderId: 'A', items: [], createdAt: '2026-08-23', planNo: 'JFJH-20260823-00003' },
      { orderId: 'B', items: [], createdAt: '2026-08-23' },
    ],
  });
  app.run('migrateDeliveryPlanNo()');
  const got = plain(app.getGlobal('deliveries')).map((d) => d.planNo);
  assert.deepEqual(got, ['JFJH-20260823-00003', 'JFJH-20260823-00004']);
  app.dispose();
});

test('V6-4 两条交付计划指向同一 orderId 同一产品 → 编号各自独立（不得去重合并）', () => {
  const app = app0({
    deliveries: [
      { orderId: 'KCDD-SAME', customer: '甲', items: [{ productId: 'P1', productName: '一型', orderQty: 10, deliveredQty: 0, planQty: 3, lineNotes: '' }], createdAt: '2026-09-30' },
      { orderId: 'KCDD-SAME', customer: '甲', items: [{ productId: 'P1', productName: '一型', orderQty: 10, deliveredQty: 0, planQty: 3, lineNotes: '' }], createdAt: '2026-09-30' },
    ],
  });
  app.run('migrateDeliveryPlanNo()');
  const got = plain(app.getGlobal('deliveries'));
  assert.equal(got.length, 2, '记录数不得被合并');
  assert.deepEqual(got.map((d) => d.planNo), ['JFJH-20260930-00001', 'JFJH-20260930-00002']);
  app.dispose();
});

test('V6-5【第2轮·P-3 已修】planNo 纯空白 / 空串 / null → 一律视为缺号并被真实编号覆盖', () => {
  /* 上一轮此处是「观测记录」锚点，钉住"空白串被当作已有编号而跳过、永久留存"的旧行为。
     工程师 P-3 把幂等判据改为 trim 后判空（迁移 + 导入两处同修）→ 本锚点**翻转**。 */
  const app = app0({
    deliveries: [
      { orderId: 'A', items: [], createdAt: '2026-08-23', planNo: '   ' },
      { orderId: 'B', items: [], createdAt: '2026-08-23', planNo: '' },
      { orderId: 'C', items: [], createdAt: '2026-08-23', planNo: null },
      { orderId: 'D', items: [], createdAt: '2026-08-23', planNo: '\t\n' },
    ],
  });
  app.run('migrateDeliveryPlanNo()');
  const got = plain(app.getGlobal('deliveries')).map((d) => d.planNo);
  assert.deepEqual(got, [
    'JFJH-20260823-00001',
    'JFJH-20260823-00002',
    'JFJH-20260823-00003',
    'JFJH-20260823-00004',
  ], '4 种空白形态（空格/空串/null/制表换行）全部被真实编号覆盖');
  assert.equal(got.filter((x) => !FMT.test(String(x))).length, 0, '不得残留任何空白编号');
  assert.equal(new Set(got).size, 4, '唯一性');
  /* 幂等：全部已有非空编号 → 二次运行零写盘 */
  const app2 = appR({ deliveries: [{ orderId: 'E', createdAt: '2026-08-23', planNo: '   ' }] });
  app2.run('migrateDeliveryPlanNo()');
  assert.equal(app2.recorder.countOf('deliveries'), 1, '首次须落盘（覆盖空白）');
  app2.recorder.reset();
  app2.run('migrateDeliveryPlanNo()');
  assert.equal(app2.recorder.writeCount(), 0, '二次不得再写盘');
  app2.dispose();
  app.dispose();
});

test('V6-5b【第2轮·I8 复核】迁移只清"纯空白"，不改写非空（含外围空白）编号 — 零写入', () => {
  /* 工程师 I8 主张：trim 清洗职责只在导入归一化，迁移对"非空但带外围空白"的编号一字不改。
     我独立复核后**认可该不变量**：迁移是"回填缺号"，不是"数据清洗器"；静默改写存量编号
     会造成不可追溯的变更（且 doSaveDelivery 编辑态也以原值为准）。 */
  const app = appR({
    deliveries: [
      { orderId: 'D', createdAt: '2026-08-23', planNo: '  JFJH-20260823-00042  ' },
      { orderId: 'E', createdAt: '2026-08-23', planNo: 'JFJH-20260824-00001' },   /* 前缀与 createdAt 不一致 → 也不得改写 */
    ],
  });
  app.run('migrateDeliveryPlanNo()');
  const got = plain(app.getGlobal('deliveries')).map((d) => d.planNo);
  assert.deepEqual(got, ['  JFJH-20260823-00042  ', 'JFJH-20260824-00001'], '非空编号一律原样保留');
  assert.equal(app.recorder.writeCount(), 0, '无缺号 → 必须零写入');
  app.dispose();
});

test('V6-8【第3轮·I8b 已修】读取侧 trim：带外围空白的存量编号被正确计入 → 同桶新单正确接续', () => {
  /* 本用例由 QA 提出（非工程师自测范围）。历史背景（I8b 修复前的旧行为，现已不可复现，仅留档）：
     修复前 nextDeliveryPlanNo 的 max 扫描用 `x.planNo.indexOf(prefix)===0` 精确前缀匹配，
     '  JFJH-…' 不以 'JFJH-…' 开头 → 不被计数；`used{}` 去重又以**原始串**为 key → 也不拦。
     旧危害推演：桶内已有 '  JFJH-20260823-00042  '（脏值）时，同桶新单会从 00001 起；
       待同桶长到第 42 条时，又会生成**干净的** JFJH-20260823-00042 →
       两条记录 trim 后编号完全相同（一条藏了空格），打穿用户「唯一」口径。
     I8b 修复后（读取侧 String(...).trim()）：脏值被正确计入 max 与去重集合，该推演的前提已被消除。
     写入侧零改动：migrateDeliveryPlanNo 仍只把「纯空白」判为缺号，非空含外围空白的既有编号一字不改。 */
  const app = app0({
    deliveries: [
      { orderId: 'D', createdAt: '2026-08-23', planNo: '  JFJH-20260823-00042  ' },
      { orderId: 'N', createdAt: '2026-08-23' },
    ],
  });
  /* ① 修复后：脏值 00042 被正确计数 → 新单接续 00043（旧行为是另起 00001） */
  assert.equal(app.run('nextDeliveryPlanNo("2026-08-23")'), 'JFJH-20260823-00043',
    '读取侧 trim 后，带外围空白存量被计入 max → 接续 00043');
  app.dispose();

  /* ② 唯一性后果复验：1 条脏值 + 42 条待补号 → 全部 trim 后必须唯一（旧"视觉重号"不再出现） */
  const seed = [{ orderId: 'D', createdAt: '2026-08-23', planNo: '  JFJH-20260823-00042  ' }];
  for (let i = 0; i < 42; i++) seed.push({ orderId: 'X' + i, createdAt: '2026-08-23' });
  const app2 = app0({ deliveries: seed });
  app2.run('migrateDeliveryPlanNo()');
  const nos = plain(app2.getGlobal('deliveries')).map((d) => d.planNo);
  const trimmed = nos.map((x) => String(x).trim());
  assert.equal(trimmed.length, 43, '1 脏 + 42 补 = 43 条');
  assert.equal(new Set(trimmed).size, 43, 'trim 归一化后全局唯一（I8b 前此处会塌缩出 1 对重号）');
  assert.equal(trimmed.filter((x) => x === 'JFJH-20260823-00042').length, 1, '...00042 仅脏值本身一条');
  assert.equal(nos.filter((x) => x === 'JFJH-20260823-00042').length, 0, '不再另生"干净"的 ...00042');
  assert.ok(trimmed.includes('JFJH-20260823-00043'), '新单从 00043 起接续（不另起 00001）');
  trimmed.forEach((x) => assert.match(x, FMT, '全部编号格式合法'));
  app2.dispose();
});

test('V6-6 删除当日最大号后再新增 → 复用该号（如实描述行为，不作缺陷判定）', () => {
  const app = app0({
    deliveries: [
      { orderId: 'A', items: [], createdAt: '2026-08-23', planNo: 'JFJH-20260823-00001' },
      { orderId: 'B', items: [], createdAt: '2026-08-23', planNo: 'JFJH-20260823-00002' },
    ],
  });
  app.setGlobals({ closeModal: function () {}, renderContent: function () {} });
  app.run('deliveries.splice(1,1)');   /* 删掉最大号 00002 */
  app.setGlobal('__n', { orderId: 'C', customer: '丙', createdAt: '2026-08-23', items: [{ productId: 'P1', planQty: 1 }] });
  app.run('doSaveDelivery(__n,-1)');
  const got = plain(app.getGlobal('deliveries')).map((d) => d.planNo);
  assert.deepEqual(got, ['JFJH-20260823-00001', 'JFJH-20260823-00002'], 'max+1 口径：被删最大号会被复用');
  assert.equal(new Set(got).size, got.length, '复用不破坏"当前数据唯一"');
  app.dispose();
});

test('V6-7 脏数组元素 / 非规范 planNo / 序号溢出 → 不抛错（①-③ 观测；④⑤ 为 P-3 修复后锚点）', () => {
  /* ① 脏元素（null / 字符串 / 数字）：迁移不得抛错（sloppy 模式下对原始值赋属性为静默失败） */
  const app = app0({ deliveries: [null, 'str', 123, { orderId: 'A', createdAt: '2026-08-23' }] });
  assert.doesNotThrow(() => app.run('migrateDeliveryPlanNo()'));
  assert.equal(plain(app.getGlobal('deliveries'))[3].planNo, 'JFJH-20260823-00001', '合法记录照常补号');
  app.dispose();

  /* ② 非规范后缀（ABCDE）不参与 max 计算，也不被改写 —— 新号仍从 00001 起（唯一性未破） */
  const app2 = app0({
    deliveries: [
      { orderId: 'A', createdAt: '2026-08-23', planNo: 'JFJH-20260823-ABCDE' },
      { orderId: 'B', createdAt: '2026-08-23' },
    ],
  });
  app2.run('migrateDeliveryPlanNo()');
  const g2 = plain(app2.getGlobal('deliveries')).map((d) => d.planNo);
  assert.deepEqual(g2, ['JFJH-20260823-ABCDE', 'JFJH-20260823-00001']);
  assert.equal(new Set(g2).size, 2, '唯一性未破');
  app2.dispose();

  /* ③ 序号溢出：当日已有 99999 → 新号变 100000（6 位，格式断言不通过）。
        现实性极低（需单日 10 万单），登记备查，不作缺陷。 */
  const app3 = app0({
    deliveries: [
      { orderId: 'A', createdAt: '2026-08-23', planNo: 'JFJH-20260823-99999' },
      { orderId: 'B', createdAt: '2026-08-23' },
    ],
  });
  app3.run('migrateDeliveryPlanNo()');
  assert.equal(plain(app3.getGlobal('deliveries'))[1].planNo, 'JFJH-20260823-100000');
  assert.equal(FMT.test('JFJH-20260823-100000'), false, '6 位序号不满足 5 位约定（超限后无保护）');
  app3.dispose();

  /* ④【第2轮·P-3 已修】导入路径：空白编号同样被覆盖（上一轮此处是"空白留存"观测锚点，已翻转） */
  const app4 = app0({ deliveries: [{ planNo: ' ' }, { planNo: '' }, { planNo: 'JFJH-20260823-00001' }] });
  assert.deepEqual(plain(app4.run('normalizeImportedDeliveryPlanNo()')), { filled: 2, renumbered: 0 });
  const g4 = plain(app4.getGlobal('deliveries')).map((d) => d.planNo);
  assert.deepEqual(g4, ['JFJH-20260823-00002', 'JFJH-20260823-00003', 'JFJH-20260823-00001'],
    '空白与空串均按缺号补号，不得留存空白');
  assert.equal(g4.filter((x) => !FMT.test(String(x))).length, 0, '不得残留空白编号');
  app4.dispose();

  /* ⑤【第2轮·P-3 已修】导入：非空但带外围空白 → trim 后落库，且参与去重（trim 后撞号须重编号） */
  const app5 = app0({ deliveries: [
    { planNo: '  JFJH-20260823-00007  ' },
    { planNo: 'JFJH-20260823-00007' },
    { planNo: 'JFJH-20260823-00007 ' },
  ] });
  assert.deepEqual(plain(app5.run('normalizeImportedDeliveryPlanNo()')), { filled: 0, renumbered: 2 });
  const g5 = plain(app5.getGlobal('deliveries')).map((d) => d.planNo);
  assert.deepEqual(g5, ['JFJH-20260823-00007', 'JFJH-20260823-00008', 'JFJH-20260823-00009'],
    '首条 trim 落库 + 后两条按重复重编号');
  assert.equal(new Set(g5).size, 3, '导入归一化后 Set.size === length（唯一性）');
  g5.forEach((x) => assert.equal(String(x), String(x).trim(), '落库值不得含外围空白'));
  app5.dispose();
});

/* ================================================================
   V7 表单只读与编辑保全
   ================================================================ */

/** 造一个足以驱动 showModal 的假 document（只支持 deliveryModal 需要的读写路径） */
function installModalProbe(app) {
  const nodes = {};
  const get = function (id) {
    if (!nodes[id]) {
      nodes[id] = {
        id: id,
        innerHTML: '',
        textContent: '',
        value: '',
        style: {},
        __wheelBound: false,
        classList: { add: function () {}, remove: function () {}, contains: function () { return false; } },
        addEventListener: function () {},
        querySelectorAll: function () { return []; },
        querySelector: function () { return null; },
      };
    }
    return nodes[id];
  };
  app.sandbox.document = Object.assign({}, app.sandbox.document, {
    getElementById: get,
    querySelectorAll: function () { return []; },
  });
  return nodes;
}

test('V7-1 真实渲染弹窗：编号格为 readonly input 且值正确（编辑态 = 原编号；新增态 = 提示语）', () => {
  const app = app0({
    currentUser: ADMIN,
    deliveries: [{
      orderId: 'KCDD-1', customer: '甲', createdAt: '2026-08-23', planNo: 'JFJH-20260823-00004',
      items: [{ productId: 'P1', productName: '一型', orderQty: 10, deliveredQty: 0, planQty: 5, lineNotes: '' }],
    }],
  });
  const nodes = installModalProbe(app);
  app.setGlobals({ closeModal: function () {}, recalcDeliveryTotals: function () {} });

  app.run('deliveryModal(0)');
  const editHtml = String(nodes.modal.innerHTML);
  assert.match(editHtml, /id="dl_planNo" readonly/, '编辑态必须有 readonly 展示格');
  assert.match(editHtml, /value="JFJH-20260823-00004"/, '编辑态展示原编号');
  assert.doesNotMatch(editHtml, /oninput="[^"]*dl_planNo/, '不得给编号格绑可编辑交互');

  nodes.modal.innerHTML = '';
  app.run('deliveryModal(-1,{})');
  const newHtml = String(nodes.modal.innerHTML);
  assert.match(newHtml, /id="dl_planNo" readonly/, '新增态同样 readonly');
  assert.match(newHtml, /value="（保存后自动生成）"/, '新增态提示保存后自动生成');
  app.dispose();
});

test('V7-2 编辑保存：表单未带编号 → 原编号保留；恶意注入编号 → 仍被原编号覆盖', () => {
  const app = appR({
    deliveries: [{
      orderId: 'KCDD-1', customer: '甲', createdAt: '2026-08-23', planNo: 'JFJH-20260823-00004',
      items: [{ productId: 'P1', orderQty: 10, deliveredQty: 0, planQty: 5 }],
    }],
  });
  app.setGlobals({ closeModal: function () {}, renderContent: function () {} });

  /* 情形 1：表单不带 planNo（saveDelivery 的真实产物） */
  app.setGlobal('__d1', { orderId: 'KCDD-1', customer: '改名', createdAt: '2026-08-23', items: [] });
  app.run('doSaveDelivery(__d1,0)');
  let got = plain(app.getGlobal('deliveries'));
  assert.equal(got.length, 1, '编辑不得新增记录');
  assert.equal(got[0].planNo, 'JFJH-20260823-00004', '必须保留原编号');
  assert.equal(got[0].customer, '改名', '其余字段照常更新');

  /* 情形 2：恶意注入一个篡改编号 → 必须被原编号覆盖（"不可手动修改"的强制点） */
  app.setGlobal('__d2', { orderId: 'KCDD-1', customer: '改名2', createdAt: '2026-08-23', items: [], planNo: 'JFJH-19990101-99999' });
  app.run('doSaveDelivery(__d2,0)');
  got = plain(app.getGlobal('deliveries'));
  assert.equal(got[0].planNo, 'JFJH-20260823-00004', '篡改注入必须被原编号覆盖');
  app.dispose();
});

test('V7-3 编辑老数据缺号 → 按同口径兜底补号（不留空）', () => {
  const app = app0({
    deliveries: [{ orderId: 'KCDD-1', customer: '甲', createdAt: '2026-09-30', items: [] }],
  });
  app.setGlobals({ closeModal: function () {}, renderContent: function () {} });
  app.setGlobal('__d', { orderId: 'KCDD-1', customer: '甲', createdAt: '2026-09-30', items: [] });
  app.run('doSaveDelivery(__d,0)');
  assert.equal(plain(app.getGlobal('deliveries'))[0].planNo, 'JFJH-20260930-00001');
  app.dispose();
});

/* ================================================================
   V8 导出与模板（真实调用生产函数，捕获 XLSX.build 的入参）
   ================================================================ */

/** 让 exportForm / downloadTemplate 可跑：打桩 XLSX.build 捕获表头，注入 Blob/URL */
function installExportProbe(app) {
  const captured = [];
  app.sandbox.XLSX.build = function (sheets) { captured.push(plain(sheets)); return [1, 2, 3]; };
  app.sandbox.Blob = function (parts) { this.parts = parts; };
  app.sandbox.URL = { createObjectURL: function () { return 'blob:x'; }, revokeObjectURL: function () {} };
  return captured;
}

test('V8-1 exportForm("delivery")：表头含「交付计划编号」且数据行取到 planNo 值', () => {
  const app = app0({
    currentUser: ADMIN,
    deliveries: [{
      orderId: 'KCDD-1', customer: '甲', createdAt: '2026-08-23', planNo: 'JFJH-20260823-00007',
      orderTotal: 10, delivered: 0, undelivered: 10, planQty: 5,
      items: [{ productId: 'P1', orderQty: 10, deliveredQty: 0, planQty: 5 }],
    }],
  });
  const cap = installExportProbe(app);
  app.run('exportForm("delivery")');
  assert.equal(cap.length, 1, 'XLSX.build 应被调用一次');
  const sheet = cap[0][0];
  assert.equal(sheet.name, '交付计划');
  assert.equal(sheet.headers[0], '交付计划编号', '表头第 1 列必须是交付计划编号');
  assert.ok(sheet.headers.includes('交付计划编号'), '表头必须含「交付计划编号」');
  const idx = sheet.headers.indexOf('交付计划编号');
  assert.equal(sheet.rows.length, 1);
  assert.equal(sheet.rows[0][idx], 'JFJH-20260823-00007', '数据行必须能取到 planNo 值');
  app.dispose();
});

test('V8-2 downloadTemplate("delivery")：「交付计划编号」表头红标必填（required:true 生效）', () => {
  const app = app0({ currentUser: ADMIN });
  const cap = installExportProbe(app);
  app.run('downloadTemplate("delivery")');
  assert.equal(cap.length, 1, 'XLSX.build 应被调用一次');
  const sheet = cap[0][0];
  assert.equal(sheet.rows.length, 0, '模板无数据行');
  const head = sheet.headers[0];
  assert.deepEqual(head, { t: '交付计划编号', red: true }, '首列表头必须 标红 + 必填');
  const planNoHeads = sheet.headers.filter((h) => h.t === '交付计划编号');
  assert.equal(planNoHeads.length, 1, '不得重复');
  app.dispose();
});

test('V8-3 机制证实：导出/模板零改动，靠持久化 fields.delivery 承接（迁移补齐）', () => {
  /* 导出列来源 = fields[formKey]；模板红标 = !!f.required —— 均为既有代码 */
  assert.match(INDEX_SRC, /var cols=\(formKey==='prodPlan'\)\?PP_EXPORT_COLS:\(fields\[cfg\.formKey\]\|\|\[\]\)\.map/, '导出列取自持久化 fields');
  assert.match(INDEX_SRC, /var headers=farr\.map\(function\(f\)\{return \{t:f\.label,red:!!f\.required\};\}\);/, '模板红标取自 f.required');
  /* 老库（fields.delivery 无 planNo）跑迁移后必须能拿到该列 */
  const app = app0({
    currentUser: ADMIN,
    fields: { delivery: [{ key: 'orderId', label: '订单编号', type: 'text', required: true, locked: true }] },
  });
  app.run('migrateDeliveryPlanNoField()');
  const f = plain(app.getGlobal('fields')).delivery;
  assert.equal(f[0].key, 'planNo');
  assert.equal(f[0].required, true);
  assert.equal(f[0].locked, true);
  app.dispose();
});

/* ================================================================
   V9 导入兜底（真实驱动 importXLSX 全流程）
   ================================================================ */

function installImportProbe(app, sheets) {
  app.sandbox.XLSX.parse = function () { return sheets; };
  function FR() {
    this.result = new ArrayBuffer(8);
    this.onload = null;
    this.readAsArrayBuffer = function () { if (this.onload) this.onload(); };
  }
  app.sandbox.FileReader = FR;
  app.sandbox.Blob = function (parts) { this.parts = parts; };
  app.sandbox.URL = { createObjectURL: function () { return 'blob:x'; }, revokeObjectURL: function () {} };
}

test('V9-1 真实导入流程：缺号补号 + 重复号保留首次并重分配，计数与提示文案正确', async () => {
  const app = appR({ currentUser: ADMIN, deliveries: [] });
  app.setGlobals({ renderAll: function () {}, renderContent: function () {} });
  installImportProbe(app, [{
    name: '交付计划',
    headers: ['交付计划编号', '订单编号', '客户名称', '本批计划'],
    rows: [
      ['', 'KCDD-1', '甲', 5],
      ['JFJH-20260823-00007', 'KCDD-2', '乙', 3],
      ['JFJH-20260823-00007', 'KCDD-3', '丙', 2],
      ['', 'KCDD-4', '丁', 1],
    ],
  }]);
  app.setGlobal('importFormKey', 'delivery');
  app.run('importXLSX({target:{files:[{}],value:""}})');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  const got = plain(app.getGlobal('deliveries'));
  assert.equal(got.length, 4, '4 行必须全部导入（不缺行）');
  const nos = got.map((d) => d.planNo);
  assert.deepEqual(nos, [
    'JFJH-20260823-00008',   /* 缺号 → 补（当时 max=7） */
    'JFJH-20260823-00007',   /* 首次出现 → 保留 */
    'JFJH-20260823-00009',   /* 重复 → 重分配 */
    'JFJH-20260823-00010',   /* 缺号 → 补 */
  ]);
  assert.equal(new Set(nos).size, 4, '归一化后必须全局唯一');
  nos.forEach((x) => assert.match(String(x), FMT));
  const alerts = app.alerts.join('\n');
  assert.match(alerts, /交付计划编号：补号 2 条，重编号 1 条/, '成功提示必须报告计数');
  const logs = plain(app.getGlobal('logs')).map((l) => String(l.detail)).join('\n');
  assert.match(logs, /补号 2 条 \/ 重编号 1 条/, '操作日志必须报告计数');
  app.dispose();
});

test('V9-2 导入：全部合法编号 → 一字不动；返回值 filled/renumbered 均为 0', () => {
  const app = app0({
    deliveries: [
      { createdAt: '2026-08-23', planNo: 'JFJH-20260823-00001' },
      { createdAt: '2026-08-23', planNo: 'JFJH-20260823-00005' },
      { createdAt: '2026-09-30', planNo: 'JFJH-20260930-00002' },
    ],
  });
  const before = plain(app.getGlobal('deliveries'));
  const r = plain(app.run('normalizeImportedDeliveryPlanNo()'));
  assert.deepEqual(r, { filled: 0, renumbered: 0 });
  assert.deepEqual(plain(app.getGlobal('deliveries')), before);
  app.dispose();
});

/* ----------------------------------------------------------------
   口径守卫基建（第3轮收紧）：把源码剥成「代码骨架」= 去注释 + 去字符串字面量，
   仅用于查「计算用编号公式副本」。文档/说明字符串（如 guide.js 的命名规则说明）不是违规。
---------------------------------------------------------------- */
/** 状态机逐字符剥离 块注释/行注释/单引号串/双引号串/模板串，返回代码骨架。 */
function stripStringsAndComments(src) {
  const s = String(src);
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    const c2 = s[i + 1];
    if (c === '/' && c2 === '*') { i += 2; while (i < n && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; out += ' '; continue; }
    if (c === '/' && c2 === '/') { i += 2; while (i < n && s[i] !== '\n') i++; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; i++;
      while (i < n) { if (s[i] === '\\') { i += 2; continue; } if (s[i] === q) { i++; break; } i++; }
      continue;
    }
    out += c; i++;
  }
  return out;
}
/** 在代码骨架里查「计算用编号公式副本」特征；返回命中列表（空 = 合规）。 */
function planNoFormulaCopyHits(skeleton) {
  const hits = [];
  const m1 = skeleton.match(/JFJH-/g); if (m1) hits.push('前缀 JFJH- x' + m1.length);
  const m2 = skeleton.match(/padStart\(\s*5\s*,/g); if (m2) hits.push('padStart(5, x' + m2.length);
  return hits;
}
/** 结构网：在「去注释但保留字符串」源码里查裸前缀字面量 'JFJH-' / "JFJH-"（真实公式才会这样写）；
    文档串里的 JFJH-YYYYMMDD-XXXXX 不是裸字面量，不匹配。 */
function barePrefixLiteralHits(commentStripped) {
  const m = String(commentStripped).match(/['"]JFJH-['"]/g);
  return m ? ['裸前缀字面量 x' + m.length] : [];
}

test('V9-3 导入接线：仅 delivery 门控；import.js 零编号公式副本；server.js 未被改动', () => {
  const noComment = IMPORT_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.equal((noComment.match(/function\s+nextDeliveryPlanNo\s*\(/g) || []).length, 0, 'import.js 不得自带编号函数');
  assert.equal((noComment.match(/JFJH-/g) || []).length, 0, 'import.js 正文不得出现前缀字面量');
  assert.equal((noComment.match(/padStart\(\s*5\s*,/g) || []).length, 0, 'import.js 正文不得自行补零');
  assert.match(noComment, /nextDeliveryPlanNo\s*\(/, 'import.js 必须经全局取号');
  assert.equal((noComment.match(/\?normalizeImportedDeliveryPlanNo\(\)/g) || []).length, 2, '调用点恰 2 处（单表单 + 全量）');
  assert.equal((noComment.match(/\(cfg\.formKey==='delivery'\)/g) || []).length, 1);
  assert.equal((noComment.match(/\(p\.cfg\.formKey==='delivery'\)/g) || []).length, 1);
  /* product / order 既有分支原文保留 */
  assert.match(noComment, /if\(cfg\.formKey==='order'\)newData=groupOrderRows\(newData\);/);
  assert.match(noComment, /if\(cfg2\.formKey==='order'\)nd=groupOrderRows\(nd\);/);
  /* 口径单源：全仓恰 1 处 function nextDeliveryPlanNo */
  const defsAll = [
    INDEX_SRC,
    ...['guide.js', 'logs.js', 'import.js', 'prodplan-core.js', 'transfer.js'].map((f) => fs.readFileSync(path.join(ROOT, 'js', f), 'utf8')),
  ].join('\n');
  assert.equal((defsAll.match(/function\s+nextDeliveryPlanNo\s*\(/g) || []).length, 1, '全工程恰 1 处定义');
  /* transfer.js 等外链模块零【计算用】编号公式副本 ——
     第3轮收紧：不再对原文直接查 /JFJH-/（会误伤 guide.js 的用户说明字符串 'JFJH-YYYYMMDD-XXXXX'），
     而是先剥成「去注释 + 去字符串字面量」的代码骨架，再查公式特征（前缀/5 位补零）。 */
  const MODULES = ['transfer.js', 'prodplan-core.js', 'logs.js', 'guide.js'];
  const modRaw = MODULES.map((f) => fs.readFileSync(path.join(ROOT, 'js', f), 'utf8')).join('\n');
  const modSkeleton = stripStringsAndComments(modRaw);
  assert.deepEqual(planNoFormulaCopyHits(modSkeleton), [],
    '外链模块【代码骨架】不得出现计算用编号公式副本（前缀字面量/5 位补零）；文档字符串不计');
  /* 结构网（保留字符串）：真实公式必以裸前缀字面量 'JFJH-' 形式出现；guide.js 的 JFJH-YYYYMMDD-XXXXX 不匹配 */
  const modNoComment = modRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.deepEqual(barePrefixLiteralHits(modNoComment), [],
    '外链模块不得出现计算用裸前缀字面量（文档串非违规）');
  /* 回填迁移必须调用而非自算 */
  const migStart = INDEX_SRC.indexOf('function migrateDeliveryPlanNo()');
  const migBody = INDEX_SRC.slice(migStart, INDEX_SRC.indexOf('/* 旧数据迁移', migStart));
  assert.match(migBody, /nextDeliveryPlanNo\s*\(/, '回填迁移必须复用全局取号函数');
  assert.doesNotMatch(migBody.replace(/\/\*[\s\S]*?\*\//g, ''), /JFJH-|padStart/, '回填迁移不得内联公式');
  app0().dispose();
});

test('V9-4【第3轮·反虚设】口径守卫：真公式副本必命中 / 仅文档字符串不命中', () => {
  /* 目的：证明 V9-3 收紧后的守卫**仍有判别力**（不放水），且不再误伤文档（不误伤）。
     只证明"没误报"是不够的——必须证明"真违规时抓得住"。 */
  /* 真违规①：前缀拼接 + 5 位补零（与生产 nextDeliveryPlanNo 同构）→ 代码骨架必须命中 */
  const realFormula = "function dup(d,n){const prefix='JFJH-'+d+'-';return prefix+String(n).padStart(5,'0');}";
  const h1 = planNoFormulaCopyHits(stripStringsAndComments(realFormula));
  assert.ok(h1.length >= 1, '真公式副本必须被【代码骨架】命中，实际 ' + JSON.stringify(h1));
  assert.ok(h1.some((x) => /padStart/.test(x)), '必须命中 5 位补零特征（跨字符串剥离仍存活于代码）');

  /* 真违规②：纯拼接、无 padStart（改用 slice 补零）→ 必须被结构网（裸前缀字面量）命中，
     防止"去字符串后 /JFJH-/ 恒为 0"造成守卫虚设。 */
  const concatOnly = "function dup(d,n){return 'JFJH-'+d+'-'+('00000'+n).slice(-5);}";
  assert.ok(barePrefixLiteralHits('/* c */\n' + concatOnly).length >= 1, '无 padStart 的拼接公式副本必须被结构网命中');

  /* 误伤反例：仅文档字符串内含编号样式 → 两条网都不得命中 */
  const docOnly = "GUIDE_MD += '编号规则：JFJH-YYYYMMDD-XXXXX（前 8 位=单据时间，末 5 位=当日流水号）';";
  assert.deepEqual(planNoFormulaCopyHits(stripStringsAndComments(docOnly)), [], '文档字符串不得被【代码骨架】命中');
  assert.deepEqual(barePrefixLiteralHits(docOnly), [], '文档串非裸前缀字面量，结构网不得命中');

  /* 自证「不命中」不是"没扫到"：确认去字符串确实抹掉了文档串里的 JFJH- */
  assert.doesNotMatch(stripStringsAndComments(docOnly), /JFJH-/, '去字符串后文档串里的 JFJH- 应已消失');
  /* 对照：去字符串对**真实公式的代码结构**（padStart(5,）无效——它不在字符串里，故仍在骨架中 */
  assert.match(stripStringsAndComments(realFormula), /padStart\(\s*5\s*,/, 'padStart(5, 属代码，剥离后仍在');

  console.log('---- V9-4 反虚设取证 ----');
  console.log('  真违规① [骨架] 命中 = ' + JSON.stringify(h1));
  console.log('  真违规② [结构网] 命中 = ' + JSON.stringify(barePrefixLiteralHits(concatOnly)));
  console.log('  仅文档串   [骨架] 命中 = ' + JSON.stringify(planNoFormulaCopyHits(stripStringsAndComments(docOnly))) +
    ' ; [结构网] 命中 = ' + JSON.stringify(barePrefixLiteralHits(docOnly)));
});

/* ================================================================
   V10 线上真实列布局场景（重点）：planNo 实际列位置 + rowspan 合并不破裂
   ================================================================ */

/** 线上 data.json 的 tblLayout.delivery.order 真实值（不含 planNo） */
const PROD_ORDER = ['createdAt', 'orderId', 'customer', 'productName', 'ppStatus', 'productId', 'spec',
  'model', 'lineNotes', '_planQty', '_ppPlanned', 'orderQty', 'deliveredQty', '_undel', 'firstDate', 'finalDate'];

/** 把渲染出的表格 HTML 解析成「假节点行」（只支持 applyTableLayout 需要的读/移动） */
function parseTableRows(tableHtml) {
  const rows = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = rowRe.exec(tableHtml)) !== null) {
    const html = m[1];
    const cells = [];
    const cellRe = /<(td|th)([^>]*)>([\s\S]*?)<\/\1>/g;
    let c;
    while ((c = cellRe.exec(html)) !== null) {
      const attrs = c[2] || '';
      const keyM = attrs.match(/data-key="([^"]+)"/);
      const spanM = attrs.match(/rowspan="(\d+)"/);
      const colM = attrs.match(/colspan="(\d+)"/);
      const cls = (attrs.match(/class="([^"]*)"/) || [, ''])[1];
      cells.push({
        key: keyM ? keyM[1] : null,
        text: String(c[3] || '').replace(/<[^>]*>/g, '').trim(),
        rowspan: spanM ? Number(spanM[1]) : 1,
        colspan: colM ? Number(colM[1]) : 1,
        cls: cls,
        style: {},
        offsetWidth: 0,
        classList: { contains: function () { return false; } },
        querySelector: function () { return null; },
        getAttribute: function (k) {
          if (k === 'data-key') return this.key;
          if (k === 'data-m') return 'delivery';
          if (k === 'rowspan') return String(this.rowspan);
          if (k === 'colspan') return String(this.colspan);
          if (k === 'class') return this.cls;
          return null;
        },
      });
    }
    const row = {
      cells: cells,
      appendChild: function (node) {
        const i = this.cells.indexOf(node);
        if (i >= 0) this.cells.splice(i, 1);
        this.cells.push(node);
        return node;
      },
      replaceChild: function (node, old) {
        const i = this.cells.indexOf(old);
        if (i >= 0) this.cells[i] = node;
        return old;
      },
    };
    rows.push(row);
  }
  return rows;
}

/** 渲染 → 返回 {headRows, bodyRows, sections}；并把假 document 装上，供 applyTableLayout 操作 */
function renderDeliveryWithProbe(app) {
  const html = String(app.run('renderDelivery()'));
  const parts = html.split('<div class="table-wrap">');
  assert.equal(parts.length, 2, '交付计划列表应为双表结构');
  const headRows = parseTableRows(parts[0].slice(parts[0].indexOf('<table class="head-tbl">')));
  const bodyRows = parseTableRows(parts[1]);

  const headTable = { tHead: { rows: [headRows[0]] }, rows: headRows, style: {}, closest: function () { return null; } };
  const headContainer = {
    classList: { contains: function (c) { return c === 'sticky-head'; } },
    querySelector: function (s) { return s === 'table.head-tbl' ? headTable : null; },
  };
  const wrap = { previousElementSibling: headContainer, classList: { contains: function (c) { return c === 'table-wrap'; } } };
  const bodyTable = { tHead: null, rows: bodyRows, style: {}, closest: function () { return wrap; } };
  app.sandbox.document = Object.assign({}, app.sandbox.document, {
    querySelectorAll: function (sel) { return sel === '#content table' ? [headTable, bodyTable] : []; },
    createElement: function () { return { style: {}, getContext: null, click: function () {} }; },
  });
  return { headTable: headTable, bodyTable: bodyTable, headRows: headRows, bodyRows: bodyRows };
}

/** HTML 表格行格算法：把「带 rowspan 的行序列」摆成二维网格，用于验证列对齐 */
function buildGrid(rows) {
  const grid = rows.map(function () { return []; });
  const occ = rows.map(function () { return new Set(); });
  rows.forEach(function (row, r) {
    let c = 0;
    row.cells.forEach(function (cell) {
      while (occ[r].has(c)) c++;
      for (let dr = 0; dr < cell.rowspan && r + dr < rows.length; dr++) {
        for (let dc = 0; dc < cell.colspan; dc++) {
          occ[r + dr].add(c + dc);
          grid[r + dr][c + dc] = (dr === 0 && dc === 0) ? { key: cell.key, primary: true } : { key: cell.key, primary: false };
        }
      }
      c += cell.colspan;
    });
  });
  return grid;
}

const PROD_SEED = [
  {
    orderId: 'KCDD-1', customer: '甲', createdAt: '2026-08-23', finalDate: '2026-08-30', firstDate: '2026-08-23',
    planNo: 'JFJH-20260823-00001',
    items: [
      { productId: 'P1', productName: '一型', spec: 'S1', model: 'M1', orderQty: 10, deliveredQty: 0, planQty: 5, lineNotes: 'a' },
      { productId: 'P2', productName: '二型', spec: 'S2', model: 'M2', orderQty: 20, deliveredQty: 0, planQty: 7, lineNotes: 'b' },
    ],
  },
  {
    orderId: 'KCDD-2', customer: '乙', createdAt: '2026-08-24', finalDate: '2026-08-31', firstDate: '2026-08-24',
    planNo: 'JFJH-20260824-00001',
    items: [{ productId: 'P3', productName: '三型', spec: 'S3', model: 'M3', orderQty: 30, deliveredQty: 1, planQty: 9, lineNotes: 'c' }],
  },
];

test('V10-1 无自定义布局（tblLayout 空）：planNo 位于勾选框之后第 1 列', () => {
  const app = app0({ deliveries: PROD_SEED, tblLayout: {} });
  const p = renderDeliveryWithProbe(app);
  app.run('applyTableLayout()');
  const first = p.bodyRows[0];
  const keys = first.cells.map((c) => c.key);
  assert.equal(keys[0], null, '第 0 格应为选择列（无 data-key）');
  assert.equal(keys[1], 'planNo', '选择列之后第 1 列必须是 planNo');
  assert.equal(keys.indexOf('planNo') + 1, 2, '1-based 可视列序 = 2（即最左数据列）');
  app.dispose();
});

test('V10-2 线上真实 tblLayout（order 不含 planNo）：planNo 被追加到最末列，不满足「第 1 列」需求', () => {
  const app = app0({ deliveries: PROD_SEED, tblLayout: { delivery: { order: PROD_ORDER.slice(), widths: {} } } });
  const p = renderDeliveryWithProbe(app);

  /* 渲染后（applyTableLayout 之前）DOM 顺序 = 源码顺序，planNo 在首位 */
  const beforeKeys = p.headRows[0].cells.map((c) => c.key).filter(Boolean);
  assert.equal(beforeKeys[0], 'planNo', '渲染原始 HTML 中 planNo 确在首位（工程师自测只覆盖到此处）');

  app.run('applyTableLayout()');

  const headKeys = p.headRows[0].cells.map((c) => c.key);
  const bodyKeys = p.bodyRows[0].cells.map((c) => c.key);
  console.log('---- V10 线上布局 applyTableLayout 后表头列序 ----');
  console.log(JSON.stringify(headKeys));
  console.log('---- V10 线上布局 applyTableLayout 后首个数据行列序 ----');
  console.log(JSON.stringify(bodyKeys));

  /* 【QA 结论·缺陷】已存 order 过滤仍存在的 + 新增列按当前顺序追加到末尾
     → planNo 被追加到最末，用户口径「第 1 列（最左）」在线上真实场景下不成立。 */
  assert.equal(headKeys.indexOf('planNo'), headKeys.length - 1, '当前行为：表头 planNo 落到最末列');
  assert.equal(bodyKeys.indexOf('planNo'), bodyKeys.length - 1, '当前行为：数据行 planNo 落到最末列');
  assert.notEqual(headKeys.indexOf('planNo'), 0, '当前行为：planNo 不是第 1 数据列');
  /* 已存列序整体保留（除 planNo 外，order 中 16 列按原顺序在前；首格 null = 选择列表头） */
  const headKeysNoSel = headKeys.filter(function (k) { return k !== null; });
  assert.deepEqual(headKeysNoSel.slice(0, 16), PROD_ORDER, '已存 16 列顺序必须完整保留');
  assert.equal(headKeysNoSel.length, 17, '16 已存列 + 1 新增列');
  assert.equal(headKeys.length, 18, '含选择列表头共 18 格');
  app.dispose();
});

test('V10-3 线上真实列序下 rowspan 合并不破裂（网格化验证列对齐）', () => {
  const app = app0({ deliveries: PROD_SEED, tblLayout: { delivery: { order: PROD_ORDER.slice(), widths: {} } } });
  const p = renderDeliveryWithProbe(app);
  app.run('applyTableLayout()');

  const rows = p.bodyRows.slice(0, -1); /* 去掉合计行 */
  assert.equal(rows.length, 3, '2 + 1 条明细 = 3 个数据行');
  const grid = buildGrid(rows);
  const width = grid[0].length;

  /* ① 网格必须稠密（无空洞）—— 空洞 = 列错位/表格破裂 */
  grid.forEach((r, i) => {
    for (let c = 0; c < width; c++) {
      assert.ok(r[c], '第 ' + i + ' 行第 ' + c + ' 列必须有格（出现空洞即 rowspan 断裂）');
    }
    assert.equal(r.length, width, '所有行列数必须一致');
  });
  /* ② 每一列的 key 在各行必须一致（真正的"列对齐"不变量） */
  for (let c = 0; c < width; c++) {
    const keys = grid.map((r) => (r[c] && r[c].key) || 'sel');
    const uniq = Array.from(new Set(keys));
    assert.equal(uniq.length, 1, '第 ' + c + ' 列跨行 key 必须唯一，实际 ' + JSON.stringify(uniq));
  }
  /* ③ 单据级 7 列在「2 明细行」的组首行必须 rowspan=2，且续行不重复输出
     （默认按 createdAt 降序，组序会变，故按 rowspan 定位目标组而不按下标 0 硬编码） */
  const HEAD7 = ['planNo', 'createdAt', 'orderId', 'customer', 'ppStatus', 'finalDate', 'firstDate'];
  const twoIdx = rows.findIndex(function (r) {
    return r.cells.some(function (c) { return c.key === 'planNo' && c.rowspan === 2; });
  });
  assert.ok(twoIdx >= 0, 'KCDD-1（2 个明细行）必须存在 rowspan=2 的分组首行');
  const groupFirst = rows[twoIdx];
  const cont = rows[twoIdx + 1];
  HEAD7.forEach(function (k) {
    const cell = groupFirst.cells.find(function (x) { return x.key === k; });
    assert.ok(cell, '组首行必须含单据级列 ' + k);
    assert.equal(cell.rowspan, 2, '单据级列 ' + k + ' 必须 rowspan=2');
  });
  HEAD7.forEach(function (k) {
    assert.equal(cont.cells.find(function (x) { return x.key === k; }), undefined, '续行不得重复输出单据格 ' + k);
  });
  /* 单据级 7 列在网格里的可视列索引必须两两不同（各自独占一列）；
     注意：线上自定义列序把行级列混排进来，单据级 7 列**必然不连续**（实测 cols=[17,1,2,3,5,16,15]），
     这是用户自定列序的自然结果，不构成缺陷 —— 故此处只断言"独占且跨行稳定"。 */
  const colsOfHead = HEAD7.map(function (k) {
    return grid[twoIdx].findIndex(function (cell) { return cell && cell.key === k; });
  });
  assert.equal(colsOfHead.filter(function (c) { return c < 0; }).length, 0, '单据级 7 列必须都能定位到列');
  assert.equal(new Set(colsOfHead).size, 7, '单据级 7 列必须各占不同列（无重叠）');
  console.log('---- V10 单据级 7 列的可视列索引（0-based，0=选择列）----');
  console.log(JSON.stringify(HEAD7.map(function (k, i) { return k + '@' + colsOfHead[i]; })));
  /* ④ 合计行逐列同构（每 schema 列一个 td） */
  const sumKeys = p.bodyRows[p.bodyRows.length - 1].cells.filter(function (c) { return c.key; }).map(function (c) { return c.key; });
  const schemaKeys = plain(app.run('TBL_SCHEMAS.delivery.map(function(c){return c.key})'));
  assert.deepEqual(sumKeys.sort(), schemaKeys.slice().sort(), '合计行必须与 schema 逐列同构');
  /* ⑤ 合计行逐列同构 + 标签落位：线上 order 首列 = createdAt → 「合计」应落 createdAt 列，
        planNo 列（最末）应为空。若无自定义布局则「合计」落 planNo 列（首列），故此处不作缺陷判定。 */
  const sumRow = p.bodyRows[p.bodyRows.length - 1];
  assert.equal(sumRow.cells.find(function (c) { return c.key === 'createdAt'; }).text, '合计',
    '线上列序下合计标签应落在 createdAt 列（layoutOf 首个非数值列）');
  assert.equal(sumRow.cells.find(function (c) { return c.key === 'planNo'; }).text, '',
    'planNo 列在合计行应为空（当前线上列序下标签不在此列）');
  app.dispose();
});

/* ================================================================
   V11 水印 / 残留 / 工作树
   ================================================================ */

test('V11-1 权威水印恰 1 处 >build 2026-10-06.134<；旧 .133 权威形态 0 处', () => {
  assert.equal((INDEX_SRC.match(/>build 2026-10-06\.134</g) || []).length, 1, '.134 权威形态应恰 1 处');
  assert.equal((INDEX_SRC.match(/>build 2026-09-21\.133</g) || []).length, 0, '旧 .133 权威形态应 0 处');
  /* deploy.sh 的提取口径：注释里的 build 字样不得带 '<' 后缀造成重复计数 */
  assert.equal((INDEX_SRC.match(/>build 20\d\d-\d\d-\d\d\.\d+</g) || []).length, 1, '全文件权威水印形态只能有 1 处');
});

test('V11-2 initApp 迁移接线顺序：createdAt → orderLine → planNoField → planNo', () => {
  const iCreated = INDEX_SRC.indexOf('migrateDeliveryCreatedAt();');
  const iLine = INDEX_SRC.indexOf('migrateDeliveryOrderLine();');
  const iField = INDEX_SRC.indexOf('migrateDeliveryPlanNoField();');
  const iNo = INDEX_SRC.indexOf('migrateDeliveryPlanNo();');
  [iCreated, iLine, iField, iNo].forEach((v, i) => assert.ok(v > 0, '锚点 ' + i + ' 必须在场'));
  assert.ok(iNo > iCreated, '编号回填不得早于 createdAt 兜底（否则分组日期错）');
  assert.ok(iNo > iLine);
  assert.ok(iNo > iField, '编号回填应在字段配置补齐之后');
  /* 迁移函数定义必须都在 initApp 调用点之前（提升即可，但定义必须在文件内存在） */
  assert.ok(INDEX_SRC.indexOf('function migrateDeliveryPlanNoField()') > 0);
  assert.ok(INDEX_SRC.indexOf('function migrateDeliveryPlanNo()') > 0);
});

test('V11-3 三处列集合一致性：TBL_SCHEMAS 前 7 / HEAD_COLS / headHtml 前 7 td 逐一对齐', () => {
  const app = app0({ deliveries: PROD_SEED });
  const html = String(app.run('renderDelivery()'));
  const schemaKeys = plain(app.run('TBL_SCHEMAS.delivery.map(function(c){return c.key})'));
  const headHtmlKeys = (html.match(/<td data-key="([^"]+)" rowspan=/g) || []).map((s) => s.match(/data-key="([^"]+)"/)[1]);
  const head7 = schemaKeys.slice(0, 7);
  assert.deepEqual(head7, ['planNo', 'createdAt', 'orderId', 'customer', 'ppStatus', 'finalDate', 'firstDate']);
  assert.equal(headHtmlKeys.length % 7, 0, '单据级 td 数必须是 7 的整数倍（每条记录 7 个）');
  assert.equal(headHtmlKeys.length, 14, '2 条记录 → 2 组单据级 td');
  /* 逐组校验：每条记录的单据级 td 顺序都必须与 schema 前 7 一致 */
  for (let g = 0; g < headHtmlKeys.length; g += 7) {
    assert.deepEqual(headHtmlKeys.slice(g, g + 7), head7, '第 ' + (g / 7 + 1) + ' 组单据级 td 序不符');
  }
  /* 表头 th 与 schema 全量一致 */
  const thKeys = (html.match(/<th[^>]*data-key="([^"]+)"/g) || []).map((s) => s.match(/data-key="([^"]+)"/)[1]);
  assert.deepEqual(thKeys, schemaKeys, '表头列序必须与 schema 全量一致');
  /* HEAD_COLS 源码值 */
  const m = INDEX_SRC.slice(INDEX_SRC.indexOf('function renderDelivery()')).match(/const HEAD_COLS=(\d+);/);
  assert.ok(m, 'renderDelivery 内应有 const HEAD_COLS=n;');
  assert.equal(Number(m[1]), 7, 'HEAD_COLS 必须为 7 且等于单据级列数');
  /* 单据级列必须都不是行级（有 get 取 r.it 的） */
  const isLine = plain(app.run('TBL_SCHEMAS.delivery.slice(0,7).map(function(c){return /r\\.it/.test(String(c.get));})'));
  assert.deepEqual(isLine, [false, false, false, false, false, false, false], '前 7 列不得取行级字段');
  app.dispose();
});
