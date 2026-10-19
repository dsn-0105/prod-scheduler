'use strict';
/* ================================================================
   tests/subst-rank.153.test.js
   —— 2026-10-19.153「调用库存 → 选择库存订单：历史替换推荐排序」契约用例
   ================================================================
   需求（用户 2026-10-19 提出）：订单管理 → 调用库存 → 弹窗「选择库存订单」，
   最上方优先排列"推荐物料号"，推荐依据 = 历史替换。

   已拍板口径（**本节即验收基准，不得自行放宽**）：
     D1 同料号**永远第一**（替换料号即便次数再多也不压过同料号）
     D2 欠货（可用量 < 0）的推荐料号**不降级**，仍按次数顶在最前（用户明示）
     D3 只改「调用库存」弹窗（退回库存弹窗、选择调出库存订单、产品选择器 一律不变）
     D4 弹窗默认预填（同料号最大可用）**不改**
     D5 只统计**未撤销**的跨料号调用（call），按次数降序、次数相同看**最近时间**降序

   覆盖结构：
     §A buildSubstRankMap 归集与排序（同料不计 / 已冲销不计 / 单边调整不计 / 旧结构兼容 /
        空调出料号不计 / 次数降序 / 同次数按最近 —— 含「跨月字典序陷阱」判别力用例）
     §B csRankCands 排序（同料号恒第一 / 推荐在其它之前 / 其它按可用量递减 / **不改动入参数组** /
        零历史退化 / 入参 null 防御）
     §C 契约与静态守卫（仅 call 模式生效 / 禁原地 sort __csCands / data-ci 仍按 __csCands 下标 /
        判定单源 trCrossCallSides / 弹窗 note 默认不渲染）
     §D 回归（buildCrossCallMap 行为零变化）

   为何 §B-4 与 §C-3 必须存在（本用例最关键的守卫）：
     `.cs-inv-box[data-ci]` 存的是候选在 `__csCands` 里的**下标**，csWarn / csAutoFill /
     doCallStock 全部经由它取候选。若在图省事在 csPickInv 里 `__csCands.sort(...)`，
     弹窗打开时已写入的 data-ci 会全部错位 → 静默取到**错的库存订单**（把货调错、且不报错）。
     故：排序只允许产出副本，__csCands 顺序恒不变。

   运行：node --test tests/subst-rank.153.test.js   （**不要用 node -e / --eval**，见 tests/README）
   ================================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createApp, ROOT } = require('./harness/sandbox');

const SRC_TRANSFER = fs.readFileSync(path.join(ROOT, 'js', 'transfer.js'), 'utf8');
const SRC_INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const ADMIN = { username: 'pmc', name: 'PMC小张', role: 'admin', perms: {} };

/** vm → 本 realm 纯对象 */
function plain(v) {
  return JSON.parse(JSON.stringify(v));
}
/** 剔除注释后的正文（静态守卫用，避免注释里的措辞造成误判） */
function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}
/** 花括号配平抽取函数源码 */
function extractFn(src, name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\(', 'g');
  const m = re.exec(src);
  if (!m) throw new Error('未在源码中找到函数: ' + name);
  let p = m.index + m[0].length;
  let d = 1;
  for (; p < src.length; p++) {
    if (src[p] === '(') d++;
    else if (src[p] === ')') { d--; if (d === 0) break; }
  }
  const i = src.indexOf('{', p);
  let j = i;
  d = 0;
  for (; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (d === 0) break; }
  }
  return src.slice(m.index, j + 1);
}

/* ---------- 沙箱 ---------- */
function boot(seed) {
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
      { currentUser: ADMIN, renderContent: function () {}, renderAll: function () {} },
      deep
    ),
  });
}

/** 新结构 call（.115 方向模型）：out=库存行（替代料），in=销售行（被履行的料号） */
function callRec(id, invPid, salesPid, ts, over) {
  return Object.assign(
    {
      id: id, type: 'call', qty: 1, ts: ts, reversed: false,
      outOrderId: 'KCDD-1', outOrderType: 'inv', outLineIdx: 0, outProductId: invPid,
      inOrderId: 'XSDD-1', inOrderType: 'sales', inLineIdx: 0, inProductId: salesPid,
    },
    over || {}
  );
}
/** 旧结构 call（.115 前）：只有 salesOrderId / invOrderId 等，trSide 需按 type 推导 */
function legacyCall(id, invPid, salesPid, ts, over) {
  return Object.assign(
    {
      id: id, type: 'call', qty: 1, ts: ts, reversed: false,
      salesOrderId: 'XSDD-1', salesLineIdx: 0, productId: salesPid,
      invOrderId: 'KCDD-1', invLineIdx: 0, invProductId: invPid,
    },
    over || {}
  );
}
/** 取推荐索引（Map → {销售料号: [{code,cnt,last}]}） */
function rankOf(app) {
  const json = app.run('JSON.stringify(Array.from(buildSubstRankMap()))');
  const pairs = JSON.parse(json);
  const out = {};
  pairs.forEach(function (p) { out[p[0]] = p[1]; });
  return out;
}
/** 候选排序结果的料号序列 */
function rankCands(app, cands, pid, recs) {
  const expr =
    'JSON.stringify(csRankCands(' + JSON.stringify(cands) + ',' + JSON.stringify(pid) + ',' +
    JSON.stringify(recs || []) + ').map(function(c){return c.productId;}))';
  return JSON.parse(app.run(expr));
}

/* ================================================================
   §A buildSubstRankMap：归集与排序
   ================================================================ */

test('A1 空台账 → 空 Map（不抛错）', function () {
  const app = boot({ transfers: [] });
  assert.deepEqual(rankOf(app), {}, '无台账时推荐索引为空');
  app.dispose();
});

test('A2 跨料号 call 计入；同料号 call 不计（否则等于推荐自己）', function () {
  const app = boot({
    transfers: [
      callRec('T1', 'P-SUB', 'P-A', '2026/9/1 10:00:00'),   /* 跨料 → 计入 */
      callRec('T2', 'P-A', 'P-A', '2026/9/1 11:00:00'),     /* 同料 → 不计 */
    ],
  });
  const r = rankOf(app);
  assert.deepEqual(Object.keys(r), ['P-A'], '只有 P-A 有替换史');
  assert.equal(r['P-A'].length, 1, '同料号调用不得进入推荐清单');
  assert.equal(r['P-A'][0].code, 'P-SUB');
  assert.equal(r['P-A'][0].cnt, 1);
  app.dispose();
});

test('A3 已冲销（reversed）的 call 不计入', function () {
  const app = boot({
    transfers: [
      callRec('T1', 'P-SUB', 'P-A', '2026/9/1 10:00:00'),
      callRec('T2', 'P-SUB', 'P-A', '2026/9/2 10:00:00', { reversed: true }),
    ],
  });
  const r = rankOf(app);
  assert.equal(r['P-A'][0].cnt, 1, 'reversed=true 的调用必须被剔除');
  app.dispose();
});

test('A4 单边调整（盘亏/盘盈）与退回记录不产生替换推荐（不误报）', function () {
  const app = boot({
    transfers: [
      /* 单边盘亏：只有 out 侧（.143 形态：缺省侧写 '' / null） */
      { id: 'ADJ1', type: 'adjust_out', qty: 3, reversed: false, ts: '2026/9/1 10:00:00',
        outOrderId: 'KCDD-1', outOrderType: 'inv', outLineIdx: 0, outProductId: 'P-X',
        inOrderId: '', inOrderType: '', inLineIdx: null, inProductId: '' },
      /* 退回：销售→库存，方向语义相反，不是"替换" */
      { id: 'RT1', type: 'return', qty: 2, reversed: false, ts: '2026/9/2 10:00:00',
        outOrderId: 'XSDD-1', outOrderType: 'sales', outLineIdx: 0, outProductId: 'P-A',
        inOrderId: 'KCDD-1', inOrderType: 'inv', inLineIdx: 0, inProductId: 'P-SUB' },
    ],
  });
  assert.deepEqual(rankOf(app), {}, '盘亏/盘盈/退回均不得进入替换推荐（仅 call 且跨料）');
  app.dispose();
});

test('A5 旧结构 call（无 outOrderId/inOrderId）照样归集 —— trSide 推导兜底', function () {
  const app = boot({ transfers: [legacyCall('T-OLD', 'P-SUB', 'P-A', '2026/8/1 10:00:00')] });
  const r = rankOf(app);
  assert.ok(r['P-A'], '旧结构记录必须能识别（线上存量含大量旧结构 call）');
  assert.equal(r['P-A'][0].code, 'P-SUB', '方向推导：in=sales(P-A) / out=inv(P-SUB)');
  app.dispose();
});

test('A6 空调出料号的 call 不入推荐（无料号无法作为替代料），但仍算跨料记录', function () {
  const app = boot({
    transfers: [callRec('T1', '', 'P-A', '2026/9/1 10:00:00')],
  });
  assert.deepEqual(rankOf(app), {}, '空料号不构成可推荐的替代料');
  /* 判别力：同一份台账在 .127 跨料警示里仍应命中（原行为不变，见 D1） */
  assert.equal(plain(app.run('buildCrossCallMap().size')), 1, '跨料警示口径不受推荐实现影响');
  app.dispose();
});

test('A7 次数降序：3 次的排在 2 次之前', function () {
  const app = boot({
    transfers: [
      callRec('T1', 'P-A', 'P-T', '2026/9/1 10:00:00'),
      callRec('T2', 'P-B', 'P-T', '2026/9/2 10:00:00'),
      callRec('T3', 'P-A', 'P-T', '2026/9/3 10:00:00'),
      callRec('T4', 'P-B', 'P-T', '2026/9/4 10:00:00'),
      callRec('T5', 'P-A', 'P-T', '2026/9/5 10:00:00'),
    ],
  });
  const r = rankOf(app)['P-T'];
  assert.deepEqual(r.map(function (x) { return x.code + ':' + x.cnt; }), ['P-A:3', 'P-B:2']);
  app.dispose();
});

test('A8 次数相同 → 最近一次更近的在前（**跨月字典序陷阱**，tsRankOf 必须有判别力）', function () {
  /* 两个替代料各 2 次；P-OLD 的最后一次是 9/7，P-NEW 的最后一次是 10/6（更近）。
     台账 ts 为 toLocaleString('zh-CN')：月份不补零 → 直接字符串比较会得到
     '2026/9/7' > '2026/10/6'，把更旧的 P-OLD 排到前面（错的）。 */
  const app = boot({
    transfers: [
      callRec('T1', 'P-OLD', 'P-T', '2026/9/6 15:03:03'),
      callRec('T2', 'P-OLD', 'P-T', '2026/9/7 10:00:00'),
      callRec('T3', 'P-NEW', 'P-T', '2026/10/6 09:00:00'),
      callRec('T4', 'P-NEW', 'P-T', '2026/10/6 10:00:00'),
    ],
  });
  const r = rankOf(app)['P-T'];
  assert.deepEqual(r.map(function (x) { return x.code; }), ['P-NEW', 'P-OLD'],
    '次数相同必须按真实时间比较（10/6 比 9/7 更近），不得用字符串字典序');
  assert.equal(r[0].cnt, r[1].cnt, '前提：两者次数相同');
  /* 判别力自证：字典序比较确实会给出相反结论（证明本用例不是空转） */
  assert.ok('2026/9/7 10:00:00' > '2026/10/6 10:00:00', '字典序陷阱成立（故必须用 tsRankOf）');
  app.dispose();
});

/* ================================================================
   §B csRankCands：排序契约
   ================================================================ */

const CANDS = [
  { uid: 'I1#0', productId: 'P-C', available: 90 },
  { uid: 'I2#0', productId: 'P-SUB', available: -600 },   /* 推荐且欠货 */
  { uid: 'I3#0', productId: 'P-A', available: 5 },        /* 同料号，可用量很小 */
  { uid: 'I4#0', productId: 'P-D', available: 300 },
  { uid: 'I5#0', productId: 'P-E', available: 10 },
];

test('B1 同料号恒第一（即便可用量最小、即便推荐料号次数更多）', function () {
  const app = boot({});
  const recs = [{ code: 'P-SUB', cnt: 24, last: '2026/9/6 15:03:03' }];
  const seq = rankCands(app, CANDS, 'P-A', recs);
  assert.equal(seq[0], 'P-A', 'D1：同料号永远第一（不被替换料号压过）');
  app.dispose();
});

test('B2 推荐料号排在「其它」之前，且欠货不降级（D2）', function () {
  const app = boot({});
  const recs = [{ code: 'P-SUB', cnt: 24, last: '2026/9/6 15:03:03' }];
  const seq = rankCands(app, CANDS, 'P-A', recs);
  assert.equal(seq[1], 'P-SUB', 'D2：推荐料号紧随同料号（可用量 -600 也不降级）');
  assert.deepEqual(seq.slice(2), ['P-D', 'P-C', 'P-E'], '其它按可用量降序 300 > 90 > 10');
  app.dispose();
});

test('B3 多个推荐按推荐索引次序（= 次数/最近），不按可用量', function () {
  const app = boot({});
  const recs = [
    { code: 'P-SUB', cnt: 24, last: '2026/9/6 15:03:03' },
    { code: 'P-E', cnt: 3, last: '2026/9/9 10:00:00' },
  ];
  const seq = rankCands(app, CANDS, 'P-A', recs);
  assert.deepEqual(seq.slice(1, 3), ['P-SUB', 'P-E'],
    '推荐区次序取自 buildSubstRankMap（次数多的在前），与各自可用量无关');
  app.dispose();
});

test('B4 **入参数组不得被改动**（顺序与元素引用都不变）—— 防 data-ci 下标错位', function () {
  const app = boot({});
  const before = CANDS.map(function (c) { return c.uid; });
  const recs = [{ code: 'P-SUB', cnt: 24, last: '2026/9/6 15:03:03' }];
  /* 在 vm 内执行，直接观察生产数组是否被原地改动 */
  const out = app.run(
    '(function(){var cands=' + JSON.stringify(CANDS) + ';var before=cands.map(function(c){return c.uid;});' +
    'csRankCands(cands,"P-A",' + JSON.stringify(recs) + ');' +
    'return JSON.stringify({before:before,after:cands.map(function(c){return c.uid;})});})()'
  );
  const r = JSON.parse(out);
  assert.deepEqual(r.after, r.before, 'csRankCands 必须返回新数组，绝不能原地 sort 入参');
  assert.deepEqual(r.after, before, '入参顺序应与构造时一致');
  app.dispose();
});

test('B5 零历史退化：同料号第一 + 其余按可用量降序（顺序可复现，不随机）', function () {
  const app = boot({});
  const seq = rankCands(app, CANDS, 'P-Z', []);
  assert.deepEqual(seq, ['P-D', 'P-C', 'P-E', 'P-A', 'P-SUB'],
    '无历史时按可用量降序（300/90/10/5/-600），完全确定');
  app.dispose();
});

test('B6 入参 null / 空数组不抛错', function () {
  const app = boot({});
  assert.deepEqual(plain(app.run('csRankCands(null,"P-A",[])')), [], 'null → 空数组');
  assert.deepEqual(plain(app.run('csRankCands([],"P-A",null)')), [], '空数组 → 空数组');
  app.dispose();
});

/* ================================================================
   §C 契约与静态守卫
   ================================================================ */

test('C1 推荐排序**仅**在「调用库存」模式生效（退回库存弹窗不变，D3）', function () {
  const fn = stripComments(extractFn(SRC_TRANSFER, 'csPickInv'));
  assert.match(fn, /__csMode\s*===\s*'call'/, '必须以 __csMode==="call" 分支隔离推荐排序');
  assert.match(fn, /isCall\?csRankCands\(__csCands,pid,recs\):__csCands/,
    '非 call 模式必须原样传 __csCands（退回弹窗零变化）');
  /* 退回弹窗不得出现 note / 推荐标记 */
  assert.match(fn, /isCall\?\(buildSubstRankMap\(\)\.get\(pid\)\|\|\[\]\):\[\]/,
    '推荐索引只在 call 模式构建');
});

test('C2 禁止原地排序 __csCands（本需求最高危的退化路径）', function () {
  const body = stripComments(SRC_TRANSFER);
  assert.equal(/__csCands\s*\.\s*sort\s*\(/.test(body), false, 'transfer.js 正文不得出现 __csCands.sort(');
  assert.equal(/__csCands\s*=\s*csRankCands\s*\(/.test(body), false,
    '不得把排序结果写回 __csCands（会让已写入的 data-ci 全部错位）');
  assert.match(body, /const rows=isCall\?csRankCands\(__csCands,pid,recs\):__csCands/,
    '排序结果必须只经局部变量 rows 传给弹窗');
});

test('C3 data-ci 仍以 __csCands 下标定位（排序不得改变下标语义）', function () {
  const setInv = stripComments(extractFn(SRC_TRANSFER, 'csSetInv'));
  assert.match(setInv, /__csCands\.indexOf\(c\)/, 'csSetInv 必须按 __csCands.indexOf 写 data-ci');
  const warn = stripComments(extractFn(SRC_TRANSFER, 'csWarn'));
  assert.match(warn, /__csCands\[ci\]/, 'csWarn 必须按 __csCands[data-ci] 取候选');
  const pick = stripComments(extractFn(SRC_TRANSFER, 'csPickInv'));
  assert.match(pick, /__csCands\.find\(function\(x\)\{return x\.uid===ids\[0\];\}\)/,
    '弹窗回填必须按 uid 回查 __csCands（而非按行号）');
});

test('C4 跨料判定单源：buildCrossCallMap 与 buildSubstRankMap 共用 trCrossCallSides', function () {
  const cross = stripComments(extractFn(SRC_INDEX, 'buildCrossCallMap'));
  const subst = stripComments(extractFn(SRC_INDEX, 'buildSubstRankMap'));
  const shared = stripComments(extractFn(SRC_INDEX, 'trCrossCallSides'));
  assert.match(cross, /trCrossCallSides\(t\)/, 'buildCrossCallMap 必须委托共享判定器');
  assert.match(subst, /trCrossCallSides\(t\)/, 'buildSubstRankMap 必须委托同一判定器');
  /* 判定条件不得在调用方复制（只允许出现在 trCrossCallSides 内） */
  [cross, subst].forEach(function (b, i) {
    assert.equal(b.indexOf("type!=='call'"), -1, '判定条件不得复制到调用方#' + i);
    assert.equal(b.indexOf('reversed'), -1, 'reversed 判定不得复制到调用方#' + i);
  });
  assert.match(shared, /t\.type!=='call'\|\|t\.reversed/, '共享判定器必须包含 call + 未冲销条件');
  assert.match(shared, /outPid===inPid/, '共享判定器必须包含「同料号不算替代」');
});

test('C5 弹窗顶部说明行默认不渲染（不影响其它 3 个选择器调用点）', function () {
  const modal = stripComments(extractFn(SRC_INDEX, 'productPickerModal'));
  assert.match(modal, /opts\.note\?/, 'note 必须是可选参数（三元判断，不是无条件插入）');
  /* 除「调用库存」外，其它调用点不得传 note */
  const callSites = (stripComments(SRC_INDEX) + stripComments(SRC_TRANSFER)).split('productPickerModal(').slice(1);
  const withNote = callSites.filter(function (s) { return s.slice(0, 600).indexOf('note:') >= 0; });
  assert.equal(withNote.length, 1, '全工程只有「调用库存」弹窗（csPickInv）传 note，实为 ' + withNote.length + ' 处');
});

/* ================================================================
   §D 回归：.127 跨料警示行为零变化
   ================================================================ */

test('D1 buildCrossCallMap：跨料命中 / 同料不命中 / 已冲销不命中', function () {
  const app = boot({
    transfers: [
      callRec('T1', 'P-SUB', 'P-A', '2026/9/1 10:00:00'),
      callRec('T2', 'P-A', 'P-A', '2026/9/2 10:00:00'),
      callRec('T3', 'P-SUB2', 'P-A', '2026/9/3 10:00:00', { reversed: true }),
    ],
  });
  const size = plain(app.run('buildCrossCallMap().size'));
  assert.equal(size, 1, '仅未冲销的跨料 call 命中（同料/已冲销不计）');
  const recs = JSON.parse(app.run('JSON.stringify(Array.from(buildCrossCallMap().values())[0])'));
  assert.equal(recs.length, 1, '该销售行只有 1 条替代记录');
  assert.equal(recs[0].code, 'P-SUB');
  assert.equal(recs[0].src, 'KCDD-1', '来源库存订单号保持原口径');
  app.dispose();
});

test('D2 buildCrossCallMap 的 code 回退口径不变（空 outProductId 时取订单行商品编码）', function () {
  const app = boot({
    orders: [
      { id: 'KCDD-1', orderType: '库存订单', customer: '内部库存', status: '执行中',
        items: [{ productId: 'P-FB', productName: '甲', spec: 's', model: 'm', orderQty: 10, deliveredQty: 10 }] },
    ],
    products: [{ id: 'P-FB', name: '甲', model: 'm', spec: 's', unit: '台', stock: 10, dailyCap: 0, status: '启用' }],
    transfers: [callRec('T1', '', 'P-A', '2026/9/1 10:00:00')],
  });
  const recs = JSON.parse(app.run('JSON.stringify(Array.from(buildCrossCallMap().values())[0])'));
  assert.equal(recs[0].code, 'P-FB', '空调出料号时仍按订单行商品编码兜底（.127 原口径）');
  app.dispose();
});
