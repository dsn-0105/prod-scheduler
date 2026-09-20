'use strict';
/* ================================================================
   tests/qa.import-nodelivered.test.js
   QA 独立验收（fresh eyes，不复用工程师用例）：.130「金蝶导入不带入已交付数量」

   需求原话（用户）：
     「当我引入金蝶订单时，如果引入订单存在已交付的数量，会填入到系统的已交付数量之中，
       这时如果我想要删除订单，由于已交付的存在无法删除… 所以现在改成导入金蝶订单时
       不带入已交付的数量」
   用户额外拍板：**只改未来导入，不动任何存量单**（存量 87 张 / 209 行中 93 行带已交付全部原样）。

   本文件与 tests/import.idempotent.test.js 的分工：
     · import.idempotent.test.js —— 幂等/决策/新口径的常规回归（工程师写）
     · 本文件 —— QA 从「用户真实目标」反向造场景（可删除性 / 存量零漂移 / 边界值矩阵 /
       预检计数与转义 / 源码静态守卫），断言只依据 PRD 与源码事实，不参考工程师的断言。

   运行：node --test tests/qa.import-nodelivered.test.js   （**不要 node -e**，见 tests/README.md）
   ================================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createApp } = require('./harness/sandbox');

const ROOT = path.join(__dirname, '..');
const IMPORT_JS = path.join(ROOT, 'js', 'import.js');
const INDEX_HTML = path.join(ROOT, 'index.html');

/* ================================================================
   0. 工具与夹具
   ================================================================ */

/** 跨 realm 取纯数据（vm 上下文里的对象 protot漂移，deepEqual 会跨 realm 失败） */
function plain(v) {
  return JSON.parse(JSON.stringify(v));
}

/**
 * 剥离 JS 注释（保留字符串字面量内容），用于「代码零写入」的静态证明：
 * 注释里出现 directDelivered 是文档、不是写入，必须区分开。
 */
function stripComments(src) {
  let out = '';
  let mode = null; // null | sq | dq | tpl | line | block
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const d = src[i + 1];
    if (mode === null) {
      if (c === '/' && d === '*') { mode = 'block'; out += ' '; i++; continue; }
      if (c === '/' && d === '/') { mode = 'line'; out += ' '; i++; continue; }
      if (c === "'") mode = 'sq';
      else if (c === '"') mode = 'dq';
      else if (c === '`') mode = 'tpl';
      out += c;
      continue;
    }
    if (mode === 'block') { if (c === '*' && d === '/') { mode = null; i++; } continue; }
    if (mode === 'line') { if (c === '\n') { mode = null; out += '\n'; } continue; }
    if (c === '\\') { out += c + (i + 1 < src.length ? src[i + 1] : ''); i++; continue; }
    if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"') || (mode === 'tpl' && c === '`')) mode = null;
    out += c;
  }
  return out;
}

const IMPORT_SRC = fs.readFileSync(IMPORT_JS, 'utf8');
const IMPORT_CODE = stripComments(IMPORT_SRC);
const INDEX_SRC = fs.readFileSync(INDEX_HTML, 'utf8');

/**
 * 造一条预检明细行。deliveredQty 按**原值**传入（不预先 0 化）——
 * 这样才能证明「Excel 给什么值，落库都是 0」。
 */
function item(productId, orderQty, deliveredQty, extra) {
  const it = { productId: productId, productName: '甲', spec: '', model: '', unit: '台', orderQty: orderQty, lineNotes: '' };
  if (deliveredQty !== undefined) it.deliveredQty = deliveredQty;
  return Object.assign(it, extra || {});
}

function kdOrder(id, items, extra) {
  return Object.assign(
    { id: id, customer: '金蝶客户', startDate: '2026-09-01', deadline: '2026-10-01', contractNo: 'HT-9', items: items },
    extra || {}
  );
}

/** 预检报告夹具（字段与 kdPrecheckAndShow 产出的 kdReport 同形） */
function report(list, opts) {
  const o = opts || {};
  return {
    filename: o.filename || 'kd-qa.xlsx',
    totalOrders: list.length,
    pm: o.pm || { P1: { id: 'P1', name: '甲' } },
    list: list,
    unknown: o.unknown || [],
    conflict: o.conflict || [],
    emptyText: [],
    dateMissing: [],
    lineSkip: [],
    noOrderId: 0,
    issuesCount: 0,
    threshold: 50,
    blocked: false,
    dvLines: 0,
    dvTotal: 0,
    dvOrderIds: [],
  };
}

function newApp(seed) {
  const app = createApp({ installRecorder: true });
  app.setGlobals(
    Object.assign(
      {
        currentUser: { username: 'pmc', name: 'PMC小张', role: 'admin', perms: {} },
        orders: [],
        products: [{ id: 'P1', name: '甲', spec: '', model: '', unit: '台', stock: 0, status: '启用' }],
        deliveries: [],
        transfers: [],
        productionPlans: [],
        productionReports: [],
        logs: [],
        renderContent: function () {},
        renderAll: function () {},
      },
      seed || {}
    )
  );
  return app;
}

/** 跑真实 kdPrecheckAndShow（showModal 用桩捕获 HTML），返回 {app, cap, R(kdReport)} */
async function precheck(list, pm, filename) {
  const app = newApp({ products: [] });
  const cap = { title: '', body: '' };
  app.setGlobal('showModal', function (t, b) {
    cap.title = t;
    cap.body = b;
  });
  await app.run(
    'kdPrecheckAndShow(' +
      JSON.stringify(list) + ',' +
      JSON.stringify(pm) + ',' +
      JSON.stringify(filename || 'kd-qa.xlsx') + ',0)'
  );
  return { app: app, cap: cap, R: await app.run('kdReport') };
}

/* ================================================================
   1. 落库口径：Excel「已交付」取任何值 → 落库 deliveredQty 恒 0、且对象**不存在** directDelivered 键
   ================================================================ */

const DV_MATRIX = [
  ['正整数 5', 5],
  ['零 0', 0],
  ['空字符串 ""', ''],
  ['null', null],
  ['键缺失（undefined）', undefined],
  ['负数 -3', -3],
  ['小数 2.5', 2.5],
  ['字符串数字 "3"', '3'],
  ['超大值 1e15', 1e15],
  ['非数字字符串 "abc"', 'abc'],
  ['布尔 true', true],
  ['对象 {}', {}],
];

test('落库口径矩阵：Excel deliveredQty 任意取值 → 落库恒 0、无 directDelivered 键、不抛异常', async (t) => {
  for (const [name, dv] of DV_MATRIX) {
    await t.test('deliveredQty = ' + name, async () => {
      const o = kdOrder('O-KD1', [item('P1', 20, dv)]);
      const app = newApp({});
      app.setGlobals({ kdReport: report([o]), kdState: { unknown: {}, conflict: {} } });
      await app.run('kdDoImport()');

      assert.equal(await app.run('orders.length'), 1, '订单应落库（' + name + '）');
      const it = plain(await app.run('orders[0].items[0]'));

      assert.equal(it.deliveredQty, 0, '落库 deliveredQty 必须恒为 0（输入 ' + name + '）');
      assert.equal(typeof it.deliveredQty, 'number', 'deliveredQty 字段保留且为数字（只改值不删字段）');
      assert.equal(
        Object.prototype.hasOwnProperty.call(it, 'directDelivered'),
        false,
        'directDelivered 键必须**不存在**（不是 undefined 值，而是根本没这个键）'
      );
      assert.equal(it.orderQty, 20, '数量照常导入（不得连带丢单）');
      assert.equal(
        app.alerts.some(function (m) { return m.indexOf('导入失败') >= 0; }),
        false,
        '不得因该值抛异常/提示失败'
      );
      app.dispose();
    });
  }
});

test('落库口径：同一行带 calledQty>0（旧 .108 会据此豁免期初基数）→ 新口径同样 deliveredQty=0、无 directDelivered', async () => {
  for (const cq of [3, '7']) {
    const o = kdOrder('O-KD1', [item('P1', 20, 5, { calledQty: cq })]);
    const app = newApp({});
    app.setGlobals({ kdReport: report([o]), kdState: { unknown: {}, conflict: {} } });
    await app.run('kdDoImport()');
    const it = plain(await app.run('orders[0].items[0]'));
    assert.equal(it.deliveredQty, 0, 'calledQty=' + cq + ' 时已交付仍恒 0');
    assert.equal(Object.prototype.hasOwnProperty.call(it, 'directDelivered'), false, 'calledQty=' + cq + ' 时无 directDelivered');
    assert.equal(Object.prototype.hasOwnProperty.call(it, 'calledQty'), false, '导入不落 calledQty（与现状一致，未被本轮改动）');
    app.dispose();
  }
});

test('落库口径：一行数量为 0（空数量按 0）也照旧落库，不被当空行丢弃', async () => {
  const o = kdOrder('O-KD1', [item('P1', '', 5)]);
  const app = newApp({});
  app.setGlobals({ kdReport: report([o]), kdState: { unknown: {}, conflict: {} } });
  await app.run('kdDoImport()');
  const it = plain(await app.run('orders[0].items[0]'));
  assert.equal(it.orderQty, 0, '数量空 → 0（既有口径不变）');
  assert.equal(it.deliveredQty, 0, '已交付不导入');
  app.dispose();
});

/* ================================================================
   2. 覆盖 / 跳过：只清「本次覆盖的新行」，绝不「顺手」改旧行
   ================================================================ */

/** 一张「存量导入单」：带已交付 9 与期初基数 9，另有已调用 4 */
function legacyImportedOrder(id) {
  return {
    id: id,
    orderType: '销售订单',
    status: '执行中',
    src: 'kingdee',
    srcFile: 'old-import.xlsx',
    customer: '老客户',
    startDate: '2026-09-01',
    deadline: '2026-10-01',
    contractNo: 'OLD-1',
    items: [
      { productId: 'P1', productName: '甲', spec: '', model: '', orderQty: 20, deliveredQty: 9, directDelivered: 9, calledQty: 4, lineNotes: '', stockMax: '', stockMin: '' },
    ],
  };
}

test('覆盖导入（overwrite）：同一 id 二次导入 → 新行 deliveredQty=0，且**不从旧行继承**旧已交付/期初基数/已调用', async () => {
  const app = newApp({ orders: [legacyImportedOrder('O-KD1')] });
  const o = kdOrder('O-KD1', [item('P1', 20, 5)]);
  app.setGlobals({
    kdReport: report([o], { conflict: [{ idx: 0, id: 'O-KD1' }] }),
    kdState: { unknown: {}, conflict: { 0: 'overwrite' } },
  });
  await app.run('kdDoImport()');

  assert.equal(await app.run('orders.length'), 1, '覆盖 → 仍是 1 单（不增生）');
  const it = plain(await app.run('orders[0].items[0]'));
  assert.equal(it.deliveredQty, 0, '覆盖后新行已交付=0');
  assert.equal(Object.prototype.hasOwnProperty.call(it, 'directDelivered'), false, '覆盖后不得继承旧 directDelivered');
  assert.equal(Object.prototype.hasOwnProperty.call(it, 'calledQty'), false, '覆盖后不得继承旧 calledQty');
  assert.equal(await app.run('orders[0].customer'), '金蝶客户', '确认这一行确实是被新单替换（而非旧单残留）');
  assert.equal(await app.run('orders[0].srcFile'), 'kd-qa.xlsx', 'srcFile 随新文件更新');
  app.dispose();
});

test('跳过导入（skip）：旧单**原样保留**——不得被新口径「顺手清零」', async () => {
  const app = newApp({ orders: [legacyImportedOrder('O-KD1')] });
  const o = kdOrder('O-KD1', [item('P1', 20, 5)]);
  app.setGlobals({
    kdReport: report([o], { conflict: [{ idx: 0, id: 'O-KD1' }] }),
    kdState: { unknown: {}, conflict: { 0: 'skip' } },
  });
  await app.run('kdDoImport()');

  assert.equal(await app.run('orders.length'), 1, '跳过 → 不生成新单');
  const before = plain(legacyImportedOrder('O-KD1').items[0]);
  const after = plain(await app.run('orders[0].items[0]'));
  assert.deepEqual(after, before, '跳过单的明细行必须逐字段逐值不变（deliveredQty=9 / directDelivered=9 / calledQty=4）');
  assert.equal(await app.run('orders[0].customer'), '老客户', '旧单头也未被触碰');
  assert.equal(
    app.alerts.some(function (m) { return m.indexOf('跳过') >= 0; }),
    true,
    '应提示跳过了 1 单'
  );
  app.dispose();
});

test('不可覆盖保护（已取消/已暂停）：带已交付的存量单不被新口径改写', async () => {
  for (const st of ['已取消', '已暂停']) {
    const old = legacyImportedOrder('O-KD1');
    old.status = st;
    const app = newApp({ orders: [old] });
    const o = kdOrder('O-KD1', [item('P1', 20, 5)]);
    app.setGlobals({
      kdReport: report([o], { conflict: [{ idx: 0, id: 'O-KD1' }] }),
      kdState: { unknown: {}, conflict: { 0: 'overwrite' } },
    });
    await app.run('kdDoImport()');
    const it = plain(await app.run('orders[0].items[0]'));
    assert.equal(await app.run('orders.length'), 1, st + '：未新增');
    assert.equal(await app.run('orders[0].status'), st, st + '：状态未被复活');
    assert.equal(it.deliveredQty, 9, st + '：存量已交付保持 9');
    assert.equal(it.directDelivered, 9, st + '：存量期初基数保持 9');
    app.dispose();
  }
});

/* ================================================================
   3. 「只改未来导入、不动存量」——运行时强验证
   ================================================================ */

test('存量零漂移：一次导入（含 1 单覆盖 + 1 单新增）后，其余存量单逐字段不变', async () => {
  const seed = [
    legacyImportedOrder('O-KD1'), // 本次被覆盖
    legacyImportedOrder('O-KD2'), // 本次完全无关
    (function () {
      const o = legacyImportedOrder('O-KD3');
      o.src = undefined;
      o.srcFile = undefined;
      o.items[0].deliveredQty = 20; // 存量「全量已交付」历史单（线上 93 行那类）
      o.items[0].directDelivered = 20;
      o.items[0].calledQty = 0;
      return o;
    })(),
  ];
  const snapshot = plain(seed);

  const app = newApp({ orders: seed });
  const list = [kdOrder('O-KD1', [item('P1', 20, 5)]), kdOrder('O-KD9', [item('P1', 7, 7)])];
  app.setGlobals({
    kdReport: report(list, { conflict: [{ idx: 0, id: 'O-KD1' }] }),
    kdState: { unknown: {}, conflict: { 0: 'overwrite' } },
  });
  await app.run('kdDoImport()');

  const after = plain(await app.run('orders'));
  assert.equal(after.length, 4, '存量 3 单：覆盖 1 单（原地替换，不增生）+ 新增 1 单 → 4 单');
  /* O-KD2 与本次导入完全无关 → 必须逐字段不变（含 deliveredQty 与 directDelivered） */
  assert.deepEqual(after.find((x) => x.id === 'O-KD2'), snapshot[1], 'O-KD2 逐字段不变');
  /* O-KD3（线上 93 行那类「全量已交付」存量单）：
     数量侧字段必须逐值不变；status 是导入时全量重算的**派生投影**（HEAD :494 既有行为，非本轮改动） */
  const a3 = after.find((x) => x.id === 'O-KD3');
  const s3 = snapshot[2];
  assert.deepEqual(Object.assign({}, a3, { status: s3.status }), s3, 'O-KD3：除派生 status 外逐字段不变');
  assert.equal(a3.items[0].deliveredQty, 20, '存量已交付 20 未被清零');
  assert.equal(a3.items[0].directDelivered, 20, '存量期初基数 20 未被删除/改写');
  assert.equal(a3.items[0].calledQty, 0, '存量已调用未被触碰');
  assert.equal(a3.status, '已完成', '（既有投影）导入会全量重算状态：已交付填满的存量单 执行中 → 已完成');
  /* 新增单按新口径 */
  const n = after.find((x) => x.id === 'O-KD9').items[0];
  assert.equal(n.deliveredQty, 0, '新增单已交付=0');
  assert.equal(Object.prototype.hasOwnProperty.call(n, 'directDelivered'), false, '新增单无 directDelivered');
  app.dispose();
});

test('存量零漂移：全量重算只是「派生投影」，不改任何存量数量字段（逐单逐行核对 deliveredQty/directDelivered）', async () => {
  /* 复刻线上结构：多张存量导入单（含 93 行那类带已交付的） */
  const seed = [
    legacyImportedOrder('O-KD1'),
    legacyImportedOrder('O-KD2'),
    legacyImportedOrder('O-KD3'),
  ];
  const before = plain(seed).map(function (o) {
    return { id: o.id, items: o.items };
  });
  const app = newApp({ orders: seed });
  const o = kdOrder('O-NEW1', [item('P1', 3, 3)]);
  app.setGlobals({ kdReport: report([o]), kdState: { unknown: {}, conflict: {} } });
  await app.run('kdDoImport()');

  const after = plain(await app.run('orders'));
  for (const b of before) {
    const a = after.find(function (x) { return x.id === b.id; });
    assert.deepEqual(a.items, b.items, b.id + ' 明细行逐字段不变（数量/期初基数/已调用全保留）');
  }
  /* 导入结束后，存量单仍「有业务痕迹」→ 仍不可删（历史保护未被削弱） */
  assert.equal(await app.run('JSON.stringify(saleOrderTrace(orders.find(function(x){return x.id==="O-KD1";})))'), '{"dv":9,"ck":4}', '存量单业务痕迹判定不变');
  app.dispose();
});

test('源码静态证明：全仓不存在针对导入单的存量迁移/清洗路径', () => {
  /* a) import.js 正文（去注释）里 deliveredQty 只有 5 类出现：:140 列名映射(1)、:239 解析取值(1)、
        :241 解析归一化(2)、:275 预检统计(1)、:504 落库常量(1) —— 任何新增出现都需人工复核 */
  const hits = (IMPORT_CODE.match(/deliveredQty/g) || []).length;
  assert.equal(hits, 6, 'import.js 正文 deliveredQty 出现次数应为 6，实际 ' + hits);

  /* b) 落库处必须是字面量 0，不得是任何变量/表达式/可绕过形式 */
  const landLines = IMPORT_CODE.split('\n').filter(function (l) {
    return l.indexOf('_impItem={') >= 0;
  });
  assert.equal(landLines.length, 1, '应恰有一处落库行对象字面量');
  const land = landLines[0];
  assert.match(land, /deliveredQty:0,/, '落库必须写死 deliveredQty:0');
  assert.doesNotMatch(land, /deliveredQty:(?!0,)/, '落库不得写任何非 0 值');
  assert.doesNotMatch(land, /directDelivered/, '落库行对象不得含 directDelivered 键');
  assert.doesNotMatch(land, /_impDq/, '落库不得引用 _impDq');
  assert.doesNotMatch(IMPORT_CODE, /deliveredQty\s*:\s*num\(/, '落库不得做 num(it.deliveredQty) 之类的取值');

  /* c) 存量迁移/清洗：不得出现「遍历已有 orders 改 deliveredQty」的写法 */
  assert.equal(IMPORT_CODE.indexOf('orders.forEach'), -1, 'import.js 不得遍历存量 orders（更不得改其 deliveredQty）');
  assert.doesNotMatch(IMPORT_CODE, /deliveredQty\s*=\s*0\s*;/, '不得存在 deliveredQty=0 赋值语句（会连存量一起清零）');
  assert.doesNotMatch(IMPORT_CODE, /deliveredQty\s*(\+=|-=|\*=)/, '不得有任何 deliveredQty 的存量增减');

  /* d) 全仓（index.html 正文）也不存在「清零式」写入 */
  const indexCode = stripComments(INDEX_SRC);
  const zeroAssign = (indexCode.match(/deliveredQty\s*=\s*0/g) || []).length;
  assert.equal(zeroAssign, 0, 'index.html 正文不存在 deliveredQty=0（存量不会被任何迁移清零）');

  /* e) 已调用侧未被牵连 */
  assert.doesNotMatch(IMPORT_CODE, /calledQty\s*:/, '本轮回填不得新增 calledQty 落库键');
});

/* ================================================================
   4. 预检报告：统计口径（计数 / 合计 / 涉及订单）与边界
   ================================================================ */

test('预检统计：无已交付行 → dvLines/dvTotal/dvOrderIds 全空', async () => {
  const o = kdOrder('O-KD1', [item('P1', 20, 0), item('P1', 5, '')]);
  const r = await precheck([o], { P1: { id: 'P1' } });
  assert.equal(r.R.dvLines, 0, '无行 > 0');
  assert.equal(r.R.dvTotal, 0, '合计 0');
  assert.deepEqual(plain(r.R.dvOrderIds), [], '不涉及任何订单');
  r.app.dispose();
});

test('预检统计：混合场景（0 / 正数 / 空串 / 负数）→ 行数与合计只算 >0 的行，负数不计入也不致 NaN', async () => {
  const o1 = kdOrder('O-KD1', [item('P1', 20, 0), item('P1', 10, 5), item('P1', 3, '')]);
  const o2 = kdOrder('O-KD2', [item('P1', 9, 2.5), item('P1', 4, 0.5), item('P1', 6, -4)]);
  const o3 = kdOrder('O-KD3', [item('P1', 6, -4), item('P1', 2, 0)]); // 只有非正数 → 不涉及
  const r = await precheck([o1, o2, o3], { P1: { id: 'P1' } });

  assert.equal(r.R.dvLines, 3, '>0 的明细行：o1 的 5、o2 的 2.5 与 0.5 = 3 行');
  assert.equal(r.R.dvTotal, 8, '合计 = 5+2.5+0.5 = 8（负数/0/空串不计入）');
  assert.deepEqual(plain(r.R.dvOrderIds), ['O-KD1', 'O-KD2'], '只有含 >0 行的订单才进涉及列表（O-KD3 被排除）');
  assert.match(r.cap.body, /本次文件有 <b>3<\/b> 行明细带已交付数量（合计 <b>8<\/b>）/, 'HTML 汇总与统计一致');
  assert.notEqual(plain(r.R.dvTotal), null);
  assert.equal(Number.isNaN(plain(r.R.dvTotal)), false, '合计不得是 NaN');
  r.app.dispose();
});

test('预检统计：浮点噪声（0.1+0.2）→ 显示用 kdNumTxt 收敛到 3 位以内，不出现 0.30000000000000004', async () => {
  const o = kdOrder('O-KD1', [item('P1', 20, 0.1), item('P1', 20, 0.2)]);
  const r = await precheck([o], { P1: { id: 'P1' } });
  assert.match(r.cap.body, /合计 <b>0\.3<\/b>/, '浮点噪声已收敛');
  assert.doesNotMatch(r.cap.body, /0\.30000000/, '不得把浮点噪声展示给同事');
  r.app.dispose();
});

test('kdNumTxt 单元：最多 3 位小数 / 非有限值归 0（预检显示专用纯函数）', async () => {
  const app = newApp({});
  const cases = [
    [5, '5'],
    [2.5, '2.5'],
    [2.0004, '2'],
    ['3', '3'],
    [0.1 + 0.2, '0.3'],
    [1e15, '1000000000000000'],
    [Number.NaN, '0'],
    [Infinity, '0'],
    [-Infinity, '0'],
    [null, '0'],
    ['abc', '0'],
  ];
  for (const [input, expect] of cases) {
    const arg = typeof input === 'number' && Number.isNaN(input) ? 'NaN' : JSON.stringify(input);
    const got = await app.run('kdNumTxt(' + arg + ')');
    assert.equal(got, expect, 'kdNumTxt(' + arg + ') → ' + expect + '（实际 ' + got + '）');
  }
  assert.equal(await app.run('kdNumTxt(undefined)'), '0', 'undefined → 0');
  app.dispose();
});

/* ================================================================
   5. 预检提示文案：固定提示 / 汇总句 / 10 与 11 张边界 / HTML 转义
   ================================================================ */

test('预检提示：固定提示恒显示（与文件内容无关）；无已交付行时**不出现**汇总句', async () => {
  const o = kdOrder('O-KD1', [item('P1', 20, 0)]);
  const r = await precheck([o], { P1: { id: 'P1' } }, 'kd-nodv.xlsx');

  assert.match(r.cap.title, /金蝶订单导入/, '仍是金蝶预检报告');
  assert.match(r.cap.body, /已交付数量不导入系统/, '固定提示恒显示');
  assert.match(r.cap.body, /一律从 <b>0<\/b> 起算/, '固定提示须说明「从 0 起算」');
  assert.match(r.cap.body, /可直接删除/, '固定提示须说明「可删除」（对应用户诉求）');
  assert.doesNotMatch(r.cap.body, /行明细带已交付数量/, '无已交付行 → 不得出现汇总句');
  assert.doesNotMatch(r.cap.body, /涉及订单：/, '无已交付行 → 不得出现涉及订单列表');
  r.app.dispose();
});

test('预检提示：恰好 10 张带已交付 → 全列 10 个，**不出现**「等 K 张」', async () => {
  const list = [];
  for (let i = 1; i <= 10; i++) list.push(kdOrder('O-KD' + i, [item('P1', 20, 1)]));
  const r = await precheck(list, { P1: { id: 'P1' } }, 'kd-10.xlsx');

  const ids = [];
  for (let i = 1; i <= 10; i++) ids.push('O-KD' + i);
  assert.match(r.cap.body, new RegExp('涉及订单：' + ids.join('、') + '。'), '10 张全部列出且无后缀');
  assert.doesNotMatch(r.cap.body, /等 \d+ 张/, '恰好 10 张不得出现「等 K 张」');
  assert.match(r.cap.body, /本次文件有 <b>10<\/b> 行明细带已交付数量（合计 <b>10<\/b>）/, '行数/合计正确');
  r.app.dispose();
});

test('预检提示：11 张及以上 → 只列前 10 个 + 追加「等 K 张」，正文不得出现第 11 个订单号', async () => {
  for (const total of [11, 12, 25]) {
    const list = [];
    for (let i = 1; i <= total; i++) list.push(kdOrder('O-KD' + i, [item('P1', 20, i)]));
    const r = await precheck(list, { P1: { id: 'P1' } }, 'kd-many.xlsx');

    assert.match(r.cap.body, new RegExp('O-KD10 等 ' + total + ' 张'), total + ' 张 → 应追加「等 ' + total + ' 张」');
    assert.doesNotMatch(r.cap.body, /O-KD11/, total + ' 张 → 正文不得出现第 11 个订单号');
    assert.match(r.cap.body, /涉及订单：O-KD1、O-KD2、/, '前 10 个照常列出');
    assert.equal(plain(r.R.dvOrderIds).length, total, '统计侧仍记录全部涉及订单（便于核对）');
    r.app.dispose();
  }
});

test('预检提示：订单号含 & / < / > 等特殊字符 → 必须 HTML 转义（注入防护）', async () => {
  const list = [
    kdOrder('KD&A<1>', [item('P1', 20, 5)]),
    kdOrder('<img src=x onerror=alert(1)>', [item('P1', 20, 7)]),
  ];
  const r = await precheck(list, { P1: { id: 'P1' } }, 'kd-esc.xlsx');

  assert.match(r.cap.body, /KD&amp;A&lt;1&gt;/, '& 与 <> 均被转义');
  assert.match(r.cap.body, /&lt;img src=x onerror=alert\(1\)&gt;/, '恶意单号被转为文本');
  assert.doesNotMatch(r.cap.body, /<img/, '不得生成真实 <img> 标签（无注入）');
  assert.doesNotMatch(r.cap.body, /KD&A/, '未经转义的原始 & 序列不得出现');
  assert.equal(plain(r.R.dvOrderIds)[0], 'KD&A<1>', '统计侧保留原始单号（只在渲染时转义）');
  r.app.dispose();
});

test('预检提示：旧文案与旧口径痕迹零残留（防回潮守卫）', () => {
  /* 旧底部文案「数量 / 已交付数量 为空时按 0 导入」的核心片段 */
  assert.doesNotMatch(IMPORT_SRC, /已交付数量 为空时按/, '旧文案「已交付数量 为空时按」不得残留');

  /* 旧口径的落库表达式与中间变量 */
  assert.doesNotMatch(IMPORT_SRC, /_impDq/, '_impDq 变量必须零残留');
  assert.doesNotMatch(IMPORT_CODE, /directDelivered/, 'import.js **代码**（去注释）中 directDelivered 出现次数必须为 0');
  assert.doesNotMatch(IMPORT_CODE, /\.directDelivered\s*=/, '不得有任何 directDelivered 赋值');
  assert.doesNotMatch(IMPORT_CODE, /directDelivered\s*:/, '不得有任何 directDelivered 键写入');
  assert.equal((IMPORT_SRC.match(/directDelivered/g) || []).length, 2, 'import.js 里 directDelivered 仅允许出现在注释中（2 处）');
});

test('水印锚点：index.html 恰 1 处 build 2026-09-20.130、0 处 .129', () => {
  assert.equal((INDEX_SRC.match(/build 2026-09-20\.130/g) || []).length, 1, '.130 应恰 1 处');
  assert.equal((INDEX_SRC.match(/build 2026-09-20\.129/g) || []).length, 0, '旧 .129 应 0 处');
});

/* ================================================================
   6. 用户真实目标端到端：导入单现在**真的能删**
   （saleOrderTrace 未改动 + 新口径不产生业务痕迹）
   ================================================================ */

test('saleOrderTrace 口径未改动（.111 禁删规则原文保留）', () => {
  assert.match(INDEX_SRC, /function saleOrderTrace\(o\)\{/, '函数仍在');
  assert.match(INDEX_SRC, /if\(orderTypeOf\(o\)!=='销售订单'\)return null;/, '非销售订单恒 null（库存订单删除语义不变）');
  assert.match(INDEX_SRC, /const dv=orderDeliveredOf\(o\);/, '已交付合计取值未改');
  assert.match(INDEX_SRC, /return \(dv>0\|\|ck>0\)\?\{dv:dv,ck:ck\}:null;/, '禁删判据（已交付>0 或 已调用>0）原文未改');
  assert.match(INDEX_SRC, /已交付合计>0 或 已调用合计>0/, '.111 注释原文保留');
});

test('端到端：Excel 全量已交付（20/20）导入后 → 无业务痕迹、可直接删除（用户诉求达成）', async () => {
  const o = kdOrder('O-KD1', [item('P1', 20, 20)]); // 金蝶侧「已全部出库」
  const app = newApp({});
  app.setGlobals({ kdReport: report([o]), kdState: { unknown: {}, conflict: {} } });
  await app.run('kdDoImport()');

  assert.equal(await app.run('orderDeliveredOf(orders[0])'), 0, '导入单已交付合计 = 0（关键）');
  assert.equal(await app.run('orderItems(orders[0]).reduce(function(s,i){return s+num(i.calledQty);},0)'), 0, '导入单已调用合计 = 0');
  assert.equal(await app.run('JSON.stringify(saleOrderTrace(orders[0]))'), 'null', 'saleOrderTrace = null → 判定为「无业务痕迹，可删」');

  /* 真的删一次（confirm 桩默认返回 true） */
  app.confirms.length = 0;
  await app.run('delOrder(0)');
  assert.equal(await app.run('orders.length'), 0, '订单被成功删除');
  assert.equal(
    app.confirms.some(function (m) { return m.indexOf('确认删除订单') >= 0; }),
    true,
    '走到了删除确认（未被禁删分支提前 return）'
  );
  assert.equal(
    app.alerts.some(function (m) { return m.indexOf('不能删除') >= 0; }),
    false,
    '不得弹出「有业务记录不能删除」'
  );
  app.dispose();
});

test('对照（存量历史单）：已交付 20 > 0 的老单仍被禁删 —— 证明「只改未来」而非放宽禁删规则', async () => {
  const legacy = {
    id: 'XSDD-20260520-00001',
    orderType: '销售订单',
    status: '执行中',
    customer: '老客户',
    contractNo: '',
    startDate: '2026-05-20',
    deadline: '2026-06-20',
    items: [{ productId: 'P1', productName: '甲', orderQty: 20, deliveredQty: 20, directDelivered: 20, calledQty: 0 }],
  };
  const app = newApp({ orders: [legacy] });

  assert.equal(await app.run('JSON.stringify(saleOrderTrace(orders[0]))'), '{"dv":20,"ck":0}', '存量单仍被判定为有业务痕迹');

  app.confirms.length = 0;
  await app.run('delOrder(0)');
  assert.equal(await app.run('orders.length'), 1, '存量单不可删（禁删规则未被本轮放宽）');
  assert.equal(
    app.alerts.some(function (m) { return m.indexOf('不能删除') >= 0; }),
    true,
    '应提示「不能删除」'
  );
  assert.equal(app.confirms.length, 0, '未进入删除确认步骤');
  app.dispose();
});

/* ================================================================
   7. 行为副产物（预期，记录而非缺陷）：导入单状态恒「执行中」
   ================================================================ */

test('副产物：导入单 deliveredQty=0 → recomputeOrderAutoStatus 判「执行中」（不再出现「Excel 全量已交付 → 已完成」）', async () => {
  const app = newApp({});
  const o = kdOrder('O-KD1', [item('P1', 20, 20)]); // 旧口径下 undel=0 → 自动「已完成」
  app.setGlobals({ kdReport: report([o]), kdState: { unknown: {}, conflict: {} } });
  await app.run('kdDoImport()');

  assert.equal(await app.run('orders[0].status'), '执行中', '新口径下导入单恒为「执行中」');
  assert.equal(await app.run('orderUndelTotal(orders[0])'), 20, '整单未交付合计 = 20（>0 → 执行中，逻辑自洽）');
  app.dispose();
});

test('副产物对照：存量/系统内交付把已交付填满 → 仍自动「已完成」（状态机本身未改）', async () => {
  const app = newApp({
    orders: [
      { id: 'XSDD-X', orderType: '销售订单', status: '执行中', customer: 'C', contractNo: '', items: [{ productId: 'P1', orderQty: 20, deliveredQty: 20 }] },
    ],
  });
  await app.run('recomputeOrderAutoStatus(true)');
  assert.equal(await app.run('orders[0].status'), '已完成', '系统内交付填满 → 已完成（.25.3 规则未变）');
  app.dispose();
});

/* ================================================================
   8. 解析侧可见性保留：Excel 列映射与明细解析仍在（预检才拿得到数字）
   ================================================================ */

test('解析侧未动：kdMapHeader 仍把「已出库数量/已交付/发货数量/出库数量/行已执行已出库数量」映射为 deliveredQty', async () => {
  const app = newApp({});
  for (const h of ['已出库数量', '已交付', '已交付数量', '发货数量', '出库数量', '行已执行已出库数量', ' 已出库 数量 ']) {
    assert.equal(await app.run('kdMapHeader(' + JSON.stringify(h) + ')'), 'deliveredQty', h + ' 仍应映射为 deliveredQty');
  }
  /* .130 之后该列只服务预检：落库侧不读它 —— 用「同名列存在时落库仍为 0」收口 */
  const app2 = newApp({});
  const o = kdOrder('O-KD1', [item('P1', 20, 99)]);
  app2.setGlobals({ kdReport: report([o]), kdState: { unknown: {}, conflict: {} } });
  await app2.run('kdDoImport()');
  assert.equal(await app2.run('orders[0].items[0].deliveredQty'), 0, '解析得到 99，落库仍为 0');
  app2.dispose();
  app.dispose();
});
