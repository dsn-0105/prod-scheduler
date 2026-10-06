'use strict';
/* ================================================================
   tests/delivery.planno.test.js —— 交付计划「交付计划编号」planNo（2026-10-06.134）
   ================================================================
   需求：为「交付计划」新增单据头字段「交付计划编号」planNo
     · 格式 JFJH-YYYYMMDD-XXXXX：JFJH 固定前缀 / YYYYMMDD = 单据时间 createdAt 去横线 /
       XXXXX = 当日 5 位序号（左补零，从 00001 起）
     · 必填 · 全局唯一 · 不可手动修改（表单只读）
     · 生成时机：库存管理勾选库存订单点「生成交付计划」下推 → 保存时自动生成
     · 编辑交付计划时保留原编号不变
     · 存量历史交付计划需回填（按 createdAt 分组、组内按 deliveries 数组顺序递增；createdAt 缺失兜底 '2026-08-23'）

   本文件钉死的口径（**口径单源**硬约束）：
     · 取号一律经 index.html 的全局 nextDeliveryPlanNo（同前缀 max+1 + 去重兜底，与既有 nextOrderNo 同款）；
       存量回填迁移 / 导入补号**不得**复制第二份编号公式（§I 静态守卫，参照 invcall-cap.test.js §S2 写法）。
     · 列表列序三处一致：TBL_SCHEMAS.delivery 前 7 项 ↔ HEAD_COLS=7 ↔ headHtml 前 7 个 <td>（§G）。

   已知边界（口径已与用户确认，非缺陷，登记备查）：
     「删除后编号不复用」在**同前缀 max+1**口径下仅对被删非最大号的场景成立——删除当日**最后一条**
     后再新增，会重新取到被删编号（与既有 nextOrderNo 完全同款行为）。如需彻底禁止需引入持久化水位，
     不在本次确认范围内；§F 对该边界做显式登记（防静默漂移）。

   运行：node --test tests/delivery.planno.test.js（**不要用 node -e**，见 tests/README）

   ---- 2026-10-06.134 返工批次（QA 严过关独立回归提出的 2 个健壮性缺口）----
   【P-2】nextDeliveryPlanNo 日期守卫：dateStr 不匹配 /^\d{4}-\d{2}-\d{2}$/（undefined/null/''/'abc'/
        '2026-8-5'/'2026/08/23'/带时间…）一律兜底为哨兵值 '2026-08-23'，杜绝 JFJH-abc-00001 与
        JFJH-202685-00001（后者形似合法、语义是「2026 年 85 月」，更具欺骗性）。A4-A6 钉之。
        ⚠️ 口径变化：`nextDeliveryPlanNo()` 不再回退 todayStr()（原 A4 已改写）——所有活调用方
            （doSaveDelivery / migrateDeliveryPlanNo / normalizeImportedDeliveryPlanNo）均显式传日期。
   【P-3】空白 planNo 被当「已有编号」：判据改 trim 后判空（index.html 迁移 + import.js 归一化两处同修）；
        迁移中空白值被真实编号**覆盖**，导入处另把 trim 后的干净值写回。B7-B9 / H5-H7 / I7-I8 钉之。
   【任务3】tests/check-syntax.js 的 stdio 由 'pipe' 改为 ['ignore','pipe','pipe']（本机创建 stdin 管道
        报 EBUSY → 8 个检查假失败）；I9 静态守卫防回归。
   【I8b·用户批准纳入】nextDeliveryPlanNo 读取侧容错：max 扫描与去重集合在比较前先 String(...).trim()，
        使带外围空白的存量编号（'  JFJH-…-00042  '）被正确计数，规避「同桶长到第 42 条时生成
        trim 后与存量完全相同的可见重号」。⚠️ 只容错读取路径：**不 trim 存量数据、不改迁移清洗口径**，
        非空（含外围空白）的既有编号在迁移中仍一字不改、零写入。I8b-1…I8b-6 钉之，I8b-5 为「不蔓延到
        写入侧」的回归守卫，I8b-6 为「正常路径零变化」守卫；原 I8 断言保持不变。
        I8b-4 为静态断言（恰 2 处读取侧 trim + 旧未 trim 形态零复现）；I8b-7 为**反虚设守卫**：
        把未 trim 的旧读取实现注入沙箱与生产实现同夹具对拍，实测证明 I8b-1 / I8b-2(第二夹具) /
        I8b-3 的夹具在旧实现下必然给出更差结果（00001 / 00008 / 00001），即具备真判别力。
   ================================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createApp, ROOT } = require('./harness/sandbox');
/* 【.135】权威水印单一来源：BUILD/PREV 只在 tests/harness/build.js 维护，本文件不再写字面量 */
const { BUILD, PREV, buildMarkRe, buildAnyRe } = require('./harness/build');

const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* 【.135】排空微任务：js/logs.js 的 logOp 落盘自 .135 起**推迟到一个微任务**（同段合并），
   故「同步段内调用 → 立刻断言落盘次数」的用例必须先排空。用 setImmediate 而非
   `await Promise.resolve()`，确保所有已排队微任务（含连锁）全部跑完再断言。 */
function drain() { return new Promise(function (r) { setImmediate(r); }); }
const IMPORT_SRC = fs.readFileSync(path.join(ROOT, 'js', 'import.js'), 'utf8');

/** 跨 realm 值转成本 realm 纯值（vm 返回的对象原型属于 vm realm） */
function plain(v) {
  return JSON.parse(JSON.stringify(v));
}
/** 剔除注释后的正文（静态守卫用；避免注释里的口径算式/格式串造成误判） */
function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}
/** 花括号配平抽取源码函数体（与 invcall-cap.test.js 同款） */
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

const IMPORT_CODE = stripComments(IMPORT_SRC);
const INDEX_CODE = stripComments(INDEX_SRC);

/** 只装载、不挂记录器的沙箱 */
function app0(seed) {
  const opts = { installRecorder: false };
  if (seed) opts.seed = seed;
  return createApp(opts);
}
/** 造一条交付计划记录 */
function dl(orderId, createdAt, items, extra) {
  return Object.assign({
    orderId: orderId,
    customer: '客户-' + orderId,
    createdAt: createdAt,
    items: items || [{ productId: 'P1', productName: '一型', orderQty: 10, deliveredQty: 0, planQty: 5, lineNotes: '' }],
  }, extra || {});
}

/* ================================================================
   §A nextDeliveryPlanNo —— 格式与同前缀递增（口径唯一来源）
   ================================================================ */

test('A1 nextDeliveryPlanNo：空库 → JFJH-YYYYMMDD-00001（去横线 + 5 位左补零）', () => {
  const app = app0({ deliveries: [] });
  assert.equal(app.run('nextDeliveryPlanNo("2026-08-23")'), 'JFJH-20260823-00001');
  assert.equal(app.run('nextDeliveryPlanNo("2026-10-06")'), 'JFJH-20261006-00001');
  assert.equal(app.run('nextDeliveryPlanNo("2026-08-23")').length, 19, '长度：JFJH-(5)+YYYYMMDD(8)+-(1)+XXXXX(5) = 19');
  app.dispose();
});

test('A2 nextDeliveryPlanNo：同日期递增（00001 → 00002 → 00003），跨日期各自从 00001 起', () => {
  const app = app0({ deliveries: [] });
  const a = app.run('nextDeliveryPlanNo("2026-08-23")');
  app.run('deliveries.push({createdAt:"2026-08-23",planNo:' + JSON.stringify(a) + '})');
  const b = app.run('nextDeliveryPlanNo("2026-08-23")');
  app.run('deliveries.push({createdAt:"2026-08-23",planNo:' + JSON.stringify(b) + '})');
  const c = app.run('nextDeliveryPlanNo("2026-08-23")');
  assert.deepEqual([a, b, c], ['JFJH-20260823-00001', 'JFJH-20260823-00002', 'JFJH-20260823-00003']);
  /* 跨日期互不干扰 */
  assert.equal(app.run('nextDeliveryPlanNo("2026-08-24")'), 'JFJH-20260824-00001');
  assert.equal(app.run('nextDeliveryPlanNo("2026-08-22")'), 'JFJH-20260822-00001');
  app.dispose();
});

test('A3 nextDeliveryPlanNo：去重兜底 —— 脏数据（非连续/重复）下仍不撞号', () => {
  const app = app0({
    deliveries: [
      { createdAt: '2026-08-23', planNo: 'JFJH-20260823-00001' },
      { createdAt: '2026-08-23', planNo: 'JFJH-20260823-00001' },   /* 脏：重复 */
      { createdAt: '2026-08-23', planNo: 'JFJH-20260823-00009' },
      { createdAt: '2026-08-23', planNo: 'JFJH-20260823-00010' },   /* 脏：被占用 */
    ],
  });
  const n = app.run('nextDeliveryPlanNo("2026-08-23")');
  assert.equal(n, 'JFJH-20260823-00011', '同前缀 max=10 → 00011');
  app.run('deliveries.push({createdAt:"2026-08-23",planNo:' + JSON.stringify(n) + '})');
  assert.equal(app.run('nextDeliveryPlanNo("2026-08-23")'), 'JFJH-20260823-00012', '再次取号继续递增');
  app.dispose();
});

test('A4【返工 P-2】日期守卫：非 YYYY-MM-DD 的 dateStr 一律兜底 2026-08-23，编号恒匹配 /^JFJH-\\d{8}-\\d{5}$/', () => {
  const app = app0({ deliveries: [] });
  const cases = [
    ['不传参（undefined）', 'nextDeliveryPlanNo()'],
    ['null', 'nextDeliveryPlanNo(null)'],
    ["''（空串）", 'nextDeliveryPlanNo("")'],
    ["'   '（纯空白）", 'nextDeliveryPlanNo("   ")'],
    ["'abc'", 'nextDeliveryPlanNo("abc")'],
    ["'2026-8-5'（未补零）", 'nextDeliveryPlanNo("2026-8-5")'],
    ["'2026/08/23'（斜杠分隔）", 'nextDeliveryPlanNo("2026/08/23")'],
    ["'20260823'（无分隔）", 'nextDeliveryPlanNo("20260823")'],
    ["'2026-08-23T10:00:00'（带时间）", 'nextDeliveryPlanNo("2026-08-23T10:00:00")'],
    ["'2026-08-23 10:00'（带空格时间）", 'nextDeliveryPlanNo("2026-08-23 10:00")'],
  ];
  cases.forEach(function (c) {
    const v = String(app.run(c[1]));
    assert.match(v, /^JFJH-\d{8}-\d{5}$/, c[0] + ' 必须产出合法编号格式（实际 ' + v + '）');
    assert.equal(v.slice(0, 14), 'JFJH-20260823-',
      c[0] + ' 必须落入项目「未知单据时间」哨兵桶 2026-08-23（实际 ' + v + '）');
  });
  /* 合法值不受守卫影响（正常路径零变化） */
  assert.equal(app.run('nextDeliveryPlanNo("2026-08-23")'), 'JFJH-20260823-00001');
  assert.equal(app.run('nextDeliveryPlanNo("2026-10-06")'), 'JFJH-20261006-00001');
  /* 返工原因（旧实现产物）必须已不可能再现：无 '/' + 非 8 位日 + '-' 组成的脏前缀 */
  app.dispose();
});

test('A5【返工 P-2】静态守卫：函数内不再以 todayStr() 兜底（改为格式守卫 + 2026-08-23 哨兵）', () => {
  const body = stripComments(extractFn(INDEX_SRC, 'nextDeliveryPlanNo'));
  assert.match(body, /\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//, '必须含 YYYY-MM-DD 格式守卫正则');
  assert.match(body, /'2026-08-23'/, '非法规格必须兜底为哨兵值 2026-08-23');
  assert.doesNotMatch(body, /dateStr\s*\|\|\s*todayStr\(\)/, '不得再用 todayStr() 兜底（否则 undefined → 当日前缀，与哨兵口径不一致）');
  assert.doesNotMatch(stripComments(INDEX_CODE), /JFJH-abc/, '不得残留脏编号产物的痕迹');
});

test('A6【返工 P-2】守卫不影响既有存量识别：哨兵桶 2026-08-23 的编号仍被同桶取号扫描到', () => {
  const app = app0({
    deliveries: [
      { createdAt: 'abc', planNo: 'JFJH-20260823-00001' },     /* 脏 createdAt，但编号已落哨兵桶 */
      { createdAt: '2026-08-23', planNo: 'JFJH-20260823-00002' },
    ],
  });
  assert.equal(app.run('nextDeliveryPlanNo("2026-8-5")'), 'JFJH-20260823-00003',
    '脏 createdAt 归一化到哨兵桶后，必须与同桶存量接续，不得另起 00001');
  app.dispose();
});

/* ================================================================
   §B migrateDeliveryPlanNo —— 存量回填（分组递增 / createdAt 兜底 / 幂等）
   ================================================================ */

test('B1 回填：按 createdAt 分组、组内按 deliveries 数组顺序从 00001 递增（createdAt 缺失兜底 2026-08-23）', () => {
  const app = app0({
    deliveries: [
      dl('K1', '2026-08-23'),                 /* 组 08-23：第 1 条 → 00001 */
      dl('K2', '2026-08-24'),                 /* 组 08-24：第 1 条 → 00001 */
      dl('K3', '2026-08-23'),                 /* 组 08-23：第 2 条 → 00002 */
      dl('K4', undefined),                    /* createdAt 缺失 → 兜底 08-23：第 3 条 → 00003 */
      dl('K5', '2026-08-24'),                 /* 组 08-24：第 2 条 → 00002 */
    ],
  });
  app.run('migrateDeliveryPlanNo()');
  const got = plain(app.getGlobal('deliveries')).map(function (d) { return d.planNo; });
  assert.deepEqual(got, [
    'JFJH-20260823-00001',
    'JFJH-20260824-00001',
    'JFJH-20260823-00002',
    'JFJH-20260823-00003',
    'JFJH-20260824-00002',
  ]);
  app.dispose();
});

test('B2 回填幂等：跑两次结果完全一致（已有编号一律跳过）', () => {
  const app = app0({
    deliveries: [dl('K1', '2026-08-23'), dl('K2', '2026-08-23'), dl('K3', '2026-08-25'), dl('K4', '2026-08-25')],
  });
  app.run('migrateDeliveryPlanNo()');
  const after1 = plain(app.getGlobal('deliveries'));
  app.run('migrateDeliveryPlanNo()');
  const after2 = plain(app.getGlobal('deliveries'));
  assert.deepEqual(after2, after1, '二次运行必须逐字节一致');
  assert.deepEqual(after1.map(function (d) { return d.planNo; }), [
    'JFJH-20260823-00001', 'JFJH-20260823-00002', 'JFJH-20260825-00001', 'JFJH-20260825-00002',
  ]);
  app.dispose();
});

test('B3 回填：混合存量（部分已有编号）→ 只补缺号的，已有编号原样保留', () => {
  const app = app0({
    deliveries: [
      dl('K1', '2026-08-23', null, { planNo: 'JFJH-20260823-00007' }),   /* 已有（人为跳号）→ 不动 */
      dl('K2', '2026-08-23'),                                            /* 缺号 → max+1 = 00008 */
      dl('K3', '2026-08-23'),                                            /* 缺号 → 00009 */
    ],
  });
  app.run('migrateDeliveryPlanNo()');
  assert.deepEqual(plain(app.getGlobal('deliveries')).map(function (d) { return d.planNo; }),
    ['JFJH-20260823-00007', 'JFJH-20260823-00008', 'JFJH-20260823-00009']);
  app.dispose();
});

test('B4 回填：全部已有编号 / 空库 → 零写入（不落盘、不写日志）', () => {
  const app = createApp({
    seed: { deliveries: [dl('K1', '2026-08-23', null, { planNo: 'JFJH-20260823-00001' })] },
  });
  app.run('migrateDeliveryPlanNo()');
  assert.equal(app.recorder.writeCount(), 0, '无缺号 → 不得写盘');
  app.dispose();

  const app2 = createApp({ seed: { deliveries: [] } });
  app2.run('migrateDeliveryPlanNo()');
  assert.equal(app2.recorder.writeCount(), 0, '空库 → 不得写盘');
  app2.dispose();
});

test('B5 回填：有改动时恰好写 1 次 deliveries + 1 次 logs，日志文案含条数', async () => {
  const app = createApp({ seed: { deliveries: [dl('K1', '2026-08-23'), dl('K2', '2026-08-23')] } });
  app.run('migrateDeliveryPlanNo()');
  /* 【.135】日志条目在同步段内已入内存，落盘推迟到微任务；排空后再断言（仍是「恰 1 次」口径） */
  await drain();
  assert.equal(app.recorder.countOf('deliveries'), 1, '一次落盘');
  assert.equal(app.recorder.countOf('logs'), 1, '一条迁移日志（.135 同段合并后仍恰 1 次）');
  const logs = plain(app.getGlobal('logs'));
  assert.match(String(logs[0].detail), /系统迁移：存量交付计划回填交付计划编号 2 条/, '日志须写明回填条数');
  app.dispose();
});

test('B6 回填后新单不撞号：回填号与新单号同源（nextDeliveryPlanNo）', () => {
  const app = app0({ deliveries: [dl('K1', '2026-08-23'), dl('K2', '2026-08-23')] });
  app.run('migrateDeliveryPlanNo()');
  /* 回填后新增一单（同 createdAt）→ 必须接续 00003，而非与存量撞号 */
  const next = app.run('nextDeliveryPlanNo("2026-08-23")');
  assert.equal(next, 'JFJH-20260823-00003');
  const all = plain(app.getGlobal('deliveries')).map(function (d) { return d.planNo; }).concat([next]);
  assert.equal(new Set(all).size, all.length, '编号必须全局唯一（回填 + 新单同源）');
  app.dispose();
});

test('B7【返工 P-3】空白 planNo 不算「已有编号」：被真实编号覆盖，不留空白、不并存 00001', () => {
  const app = createApp({
    seed: { deliveries: [
      dl('K1', '2026-08-23', null, { planNo: 'JFJH-20260823-00007' }),   /* 真实编号 → 跳过 */
      dl('K2', '2026-08-23', null, { planNo: '   ' }),                    /* 纯空白 → 必须赋号（旧实现放过） */
      dl('K3', '2026-08-23', null, { planNo: '' }),                       /* 空串（既有行为）→ 赋号 */
      dl('K4', '2026-08-23', null, { planNo: null }),                     /* null（既有行为）→ 赋号 */
      dl('K5', '2026-08-23', null, { planNo: '\t\n ' }),                   /* 其它空白字符 → 赋号 */
    ] },
  });
  app.run('migrateDeliveryPlanNo()');
  const nos = plain(app.getGlobal('deliveries')).map(function (d) { return d.planNo; });
  assert.deepEqual(nos, [
    'JFJH-20260823-00007',
    'JFJH-20260823-00008',
    'JFJH-20260823-00009',
    'JFJH-20260823-00010',
    'JFJH-20260823-00011',
  ], '空白/空/缺号一律被真实编号覆盖，并与既有 00007 同桶接续');
  nos.forEach(function (v, i) {
    assert.equal(typeof v, 'string');
    assert.match(v, /^JFJH-\d{8}-\d{5}$/, '第 ' + i + ' 条落库编号必须合法（实际 ' + JSON.stringify(v) + '）');
    assert.equal(String(v).trim(), v, '第 ' + i + ' 条不得含外围空白');
  });
  assert.equal(new Set(nos).size, nos.length, '全局唯一');
  assert.equal(app.recorder.countOf('deliveries'), 1, '一次落盘');
  app.dispose();
});

test('B8【返工 P-3】空白 planNo 修复后仍幂等：连跑两次零改动、零写入', () => {
  const app = createApp({
    seed: { deliveries: [dl('K1', '2026-08-23', null, { planNo: '   ' }), dl('K2', '2026-08-23')] },
  });
  app.run('migrateDeliveryPlanNo()');
  const after1 = plain(app.getGlobal('deliveries'));
  const w1 = app.recorder.writeCount();
  app.run('migrateDeliveryPlanNo()');
  assert.deepEqual(plain(app.getGlobal('deliveries')), after1, '二次运行必须逐字节一致');
  assert.equal(app.recorder.writeCount(), w1, '第二次不得再写盘');
  assert.deepEqual(after1.map(function (d) { return d.planNo; }),
    ['JFJH-20260823-00001', 'JFJH-20260823-00002']);
  app.dispose();
});

test('B9【返工 P-2/P-3】脏 createdAt + 空白 planNo 叠加：落库编号仍合法且入哨兵桶', () => {
  const app = createApp({
    seed: { deliveries: [dl('K1', 'abc', null, { planNo: '  ' }), dl('K2', '2026-8-5')] },
  });
  app.run('migrateDeliveryPlanNo()');
  const nos = plain(app.getGlobal('deliveries')).map(function (d) { return d.planNo; });
  assert.deepEqual(nos, ['JFJH-20260823-00001', 'JFJH-20260823-00002'],
    '异常 createdAt 一律归一化到 2026-08-23，并在同桶递增');
  nos.forEach(function (v) { assert.match(v, /^JFJH-\d{8}-\d{5}$/); });
  app.dispose();
});

/* ================================================================
   §C migrateDeliveryPlanNoField —— 持久化字段配置补齐（导出/模板列的前提）
   ================================================================ */
test('C1 老库 fields.delivery 缺 planNo → unshift 到首位，并落盘 fields', async () => {
  const app = createApp({
    seed: { fields: { delivery: [
      { key: 'orderId', label: '订单编号', type: 'text', required: true, locked: true },
      { key: 'planQty', label: '本批计划', type: 'number', required: true, locked: false },
    ] } },
  });
  app.run('migrateDeliveryPlanNoField()');
  /* 【.135】排空微任务后再断言 logs 落盘次数（logOp 落盘已改为同段合并） */
  await drain();
  const f = plain(app.getGlobal('fields')).delivery;
  assert.deepEqual(f.map(function (x) { return x.key; }), ['planNo', 'orderId', 'planQty'], 'planNo 必须在第 1 位');
  assert.deepEqual(f[0], { key: 'planNo', label: '交付计划编号', type: 'text', required: true, locked: true },
    '必须与 defaultFields.delivery[0] 定义一致（required=true → 导入模板标红；locked=true → 不可删除）');
  assert.equal(app.recorder.countOf('fields'), 1, '一次落盘 fields');
  assert.equal(app.recorder.countOf('logs'), 1, '一条迁移日志（.135 同段合并后仍恰 1 次）');
  app.dispose();
});

test('C2 幂等：已是新库 → 一字不动、零写入', () => {
  const app = createApp({
    seed: { fields: { delivery: [
      { key: 'planNo', label: '交付计划编号', type: 'text', required: true, locked: true },
      { key: 'orderId', label: '订单编号', type: 'text', required: true, locked: true },
    ] } },
  });
  const before = plain(app.getGlobal('fields'));
  app.run('migrateDeliveryPlanNoField()');
  assert.deepEqual(plain(app.getGlobal('fields')), before);
  assert.equal(app.recorder.writeCount(), 0, '二次运行不得写盘');
  app.dispose();
});

test('C3 已存在但定义漂移（改名/非必填/未锁定/被挪位）→ 逐项纠正并回首位', () => {
  const app = createApp({
    seed: { fields: { delivery: [
      { key: 'orderId', label: '订单编号', type: 'text', required: true, locked: true },
      { key: 'planNo', label: '计划号', type: 'text', required: false, locked: false },   /* 漂移 */
    ] } },
  });
  app.run('migrateDeliveryPlanNoField()');
  const f = plain(app.getGlobal('fields')).delivery;
  assert.deepEqual(f.map(function (x) { return x.key; }), ['planNo', 'orderId']);
  assert.equal(f[0].label, '交付计划编号');
  assert.equal(f[0].required, true);
  assert.equal(f[0].locked, true);
  app.dispose();
});

test('C4 fields.delivery 非法（非数组 / 缺失）→ 直接返回，不抛错', () => {
  const app = createApp({ seed: { fields: {} } });
  app.run('migrateDeliveryPlanNoField()');
  assert.equal(app.recorder.writeCount(), 0);
  app.dispose();
});

/* ================================================================
   §D 字段定义：defaultFields.delivery[0] 与 HARD_FIELDS.delivery
   ================================================================ */

test('D1 defaultFields.delivery 首位 = planNo，且 required/locked/type/label 符合口径', () => {
  const app = app0();
  const d = plain(app.getGlobal('defaultFields')).delivery;
  assert.equal(d[0].key, 'planNo', '必须置首位（与列表第 1 列列序一致）');
  assert.equal(d[0].label, '交付计划编号');
  assert.equal(d[0].type, 'text');
  assert.equal(d[0].required, true, '必填 → 导入模板表头标红');
  assert.equal(d[0].locked, true, '系统字段 → 不可在字段设置里删除');
  assert.equal(d.filter(function (x) { return x.key === 'planNo'; }).length, 1, '不得重复定义');
  app.dispose();
});

test('D2 HARD_FIELDS.delivery 含 planNo（字段级日志完整）', () => {
  const app = app0();
  const h = plain(app.getGlobal('HARD_FIELDS')).delivery;
  const hit = h.filter(function (x) { return x.key === 'planNo'; });
  assert.equal(hit.length, 1, 'planNo 必须纳入字段级日志对比');
  assert.equal(hit[0].label, '交付计划编号');
  app.dispose();
});

/* ================================================================
   §E doSaveDelivery —— 新增自动生成 / 编辑保留原编号
   ================================================================ */

/** 屏蔽模态与渲染副作用（本组只钉编号口径） */
function noSideEffects(app) {
  app.setGlobals({ closeModal: function () {}, renderContent: function () {} });
}

test('E1 新增（idx<0）：保存时自动生成编号（当天 → 00001）', () => {
  const app = createApp({ seed: { deliveries: [] } });
  noSideEffects(app);
  const today = app.run('todayStr()');
  app.setGlobal('__d', { orderId: 'KCDD-9', customer: '甲', createdAt: today, items: [{ productId: 'P1', planQty: 5 }] });
  app.run('doSaveDelivery(__d,-1)');
  const got = plain(app.getGlobal('deliveries'));
  assert.equal(got.length, 1);
  assert.equal(got[0].planNo, 'JFJH-' + String(today).replace(/-/g, '') + '-00001');
  assert.equal(app.recorder.countOf('deliveries'), 1, '恰好一次落盘');
  const logs = plain(app.getGlobal('logs'));
  assert.match(String(logs[0].detail), /编号 JFJH-\d{8}-00001/, '新增日志须带编号');
  app.dispose();
});

test('E2 新增：连续两次新增同一天 → 00001 / 00002（不撞号）', () => {
  const app = createApp({ seed: { deliveries: [] } });
  noSideEffects(app);
  const today = app.run('todayStr()');
  app.setGlobal('__a', { orderId: 'KCDD-1', customer: '甲', createdAt: today, items: [] });
  app.run('doSaveDelivery(__a,-1)');
  app.setGlobal('__b', { orderId: 'KCDD-2', customer: '乙', createdAt: today, items: [] });
  app.run('doSaveDelivery(__b,-1)');
  assert.deepEqual(plain(app.getGlobal('deliveries')).map(function (d) { return d.planNo; }),
    ['JFJH-' + String(today).replace(/-/g, '') + '-00001', 'JFJH-' + String(today).replace(/-/g, '') + '-00002']);
  app.dispose();
});

test('E3 编辑（idx>=0）：表单未带 planNo → 原编号一律保留（不可手动修改）', () => {
  const app = createApp({
    seed: { deliveries: [dl('KCDD-1', '2026-08-23', null, { planNo: 'JFJH-20260823-00004' })] },
  });
  noSideEffects(app);
  /* 表单提交出的 d 故意**不含** planNo（只读展示格不参与提交）→ 保存后编号必须还在 */
  app.setGlobal('__d', { orderId: 'KCDD-1', customer: '客户改名', createdAt: '2026-08-23', items: [] });
  app.run('doSaveDelivery(__d,0)');
  const got = plain(app.getGlobal('deliveries'));
  assert.equal(got.length, 1, '编辑不得新增记录');
  assert.equal(got[0].planNo, 'JFJH-20260823-00004', '编辑必须保留原编号');
  assert.equal(got[0].customer, '客户改名', '其余字段照常更新');
  app.dispose();
});

test('E4 编辑：编号不变 → 不产生编号噪音日志（HARD_FIELDS 无假变更）', () => {
  const app = createApp({
    seed: { deliveries: [dl('KCDD-1', '2026-08-23', null, { planNo: 'JFJH-20260823-00001' })] },
  });
  noSideEffects(app);
  app.setGlobal('__d', { orderId: 'KCDD-1', customer: '客户改名', createdAt: '2026-08-23', items: [] });
  app.run('doSaveDelivery(__d,0)');
  const logs = plain(app.getGlobal('logs'));
  assert.equal(logs.filter(function (l) { return l.field === '交付计划编号'; }).length, 0, '编号未变 → 不得产生字段级日志');
  assert.equal(logs.filter(function (l) { return l.field === '客户'; }).length, 1, '客户变了 → 照常留痕');
  app.dispose();
});

test('E5 编辑：老数据万一缺号 → 按同一口径兜底补号（不留空）', () => {
  const app = createApp({ seed: { deliveries: [dl('KCDD-1', '2026-08-23')] } });
  noSideEffects(app);
  app.setGlobal('__d', { orderId: 'KCDD-1', customer: '甲', createdAt: '2026-08-23', items: [] });
  app.run('doSaveDelivery(__d,0)');
  assert.equal(plain(app.getGlobal('deliveries'))[0].planNo, 'JFJH-20260823-00001', '缺号兜底补号（口径单源）');
  app.dispose();
});

/* ================================================================
   §F 删除后不复用（被删非最大号）+ 已知边界登记
   ================================================================ */

test('F1 删除当日**中间**一条后新增 → 不复用被删编号，继续递增到 00004', () => {
  const app = createApp({
    seed: { deliveries: [
      dl('K1', '2026-08-23', null, { planNo: 'JFJH-20260823-00001' }),
      dl('K2', '2026-08-23', null, { planNo: 'JFJH-20260823-00002' }),
      dl('K3', '2026-08-23', null, { planNo: 'JFJH-20260823-00003' }),
    ] },
  });
  noSideEffects(app);
  app.run('delDelivery(1)');                                     /* 删掉 00002 */
  assert.equal(app.alerts.length, 0, 'delDelivery 前有确认弹层，非报错');
  const left = plain(app.getGlobal('deliveries')).map(function (d) { return d.planNo; });
  assert.deepEqual(left, ['JFJH-20260823-00001', 'JFJH-20260823-00003'], '已删除的记录不再占号');
  app.setGlobal('__n', { orderId: 'K4', customer: '丁', createdAt: '2026-08-23', items: [] });
  app.run('doSaveDelivery(__n,-1)');
  const nos = plain(app.getGlobal('deliveries')).map(function (d) { return d.planNo; });
  assert.equal(nos[2], 'JFJH-20260823-00004', '新单接续到 00004');
  assert.equal(nos.indexOf('JFJH-20260823-00002'), -1, '被删编号不复用');
  assert.equal(new Set(nos).size, nos.length, '全局唯一');
  app.dispose();
});

test('F2 已知边界（口径已确认，登记备查）：删除当日**最大号**后新增 → max+1 口径下会复用该编号', () => {
  const app = createApp({
    seed: { deliveries: [
      dl('K1', '2026-08-23', null, { planNo: 'JFJH-20260823-00001' }),
      dl('K2', '2026-08-23', null, { planNo: 'JFJH-20260823-00002' }),
    ] },
  });
  noSideEffects(app);
  app.run('delDelivery(1)');                                     /* 删掉最大号 00002 */
  app.setGlobal('__n', { orderId: 'K3', customer: '丙', createdAt: '2026-08-23', items: [] });
  app.run('doSaveDelivery(__n,-1)');
  const nos = plain(app.getGlobal('deliveries')).map(function (d) { return d.planNo; });
  /* 与既有 nextOrderNo 完全同款的「同前缀 max+1」= 用户确认口径（不得擅自加持久化水位）。
     此处显式钉住该行为：若未来要「彻底不复用」，须同步改本用例 + nextDeliveryPlanNo + 口径说明。 */
  assert.equal(nos[1], 'JFJH-20260823-00002', 'max+1 口径：删除最大号后新单取回该号（已知边界，需用户拍板方可变更）');
  assert.equal(app.run('deliveries.length'), 2);
  app.dispose();
});

/* ================================================================
   §G 列表列序三处一致：TBL_SCHEMAS.delivery 前 7 项 ↔ HEAD_COLS ↔ headHtml 7 个 <td>
   ================================================================ */

const HEAD7 = ['planNo', 'createdAt', 'orderId', 'customer', 'ppStatus', 'finalDate', 'firstDate'];

test('G1 TBL_SCHEMAS.delivery 前 7 项列序 = [planNo, createdAt, orderId, customer, ppStatus, finalDate, firstDate]', () => {
  const app = app0({ deliveries: [dl('KCDD-1', '2026-08-23', null, { planNo: 'JFJH-20260823-00001' })] });
  app.run('renderDelivery()');
  const keys = plain(app.run('TBL_SCHEMAS.delivery.map(function(c){return c.key})'));
  assert.deepEqual(keys.slice(0, 7), HEAD7, '第 1 列必须是 planNo');
  assert.equal(keys[0], 'planNo', '防列序回退：首列 key 必须为 planNo');
  assert.equal(plain(app.run('TBL_SCHEMAS.delivery[0].label')), '交付计划编号');
  app.dispose();
});

test('G2 源码 HEAD_COLS 必须是 7（renderDelivery 内）且与 schema 单据级列数一致', () => {
  const body = extractFn(INDEX_SRC, 'renderDelivery');
  const m = body.match(/const HEAD_COLS\s*=\s*(\d+)\s*;/);
  assert.ok(m, 'renderDelivery 内应有 const HEAD_COLS=<n>;');
  assert.equal(Number(m[1]), 7, 'HEAD_COLS 必须为 7（本次由 6 → 7）');
  const app = app0({ deliveries: [dl('KCDD-1', '2026-08-23', null, { planNo: 'JFJH-20260823-00001' })] });
  app.run('renderDelivery()');
  assert.equal(plain(app.run('TBL_SCHEMAS.delivery.length > 7')), true, '行级列必须仍有内容');
  app.dispose();
});

test('G3 headHtml 前 7 个 <td> 的 data-key 与 schema 前 7 项逐一对应（rowspan 合并不破裂）', () => {
  const app = app0({
    deliveries: [
      /* 一条记录 2 个明细行（验证单据级列 rowspan=2 + 续行不含单据格） */
      dl('KCDD-1', '2026-08-23', [
        { productId: 'P1', productName: '一型', orderQty: 10, deliveredQty: 0, planQty: 5, lineNotes: 'a' },
        { productId: 'P2', productName: '二型', orderQty: 20, deliveredQty: 0, planQty: 7, lineNotes: 'b' },
      ], { planNo: 'JFJH-20260823-00001' }),
      dl('KCDD-2', '2026-08-24', null, { planNo: 'JFJH-20260824-00001' }),
    ],
  });
  const html = app.run('renderDelivery()');
  const parts = String(html).split('<div class="table-wrap">');
  assert.equal(parts.length, 2, '双表结构（sticky 表头 + 表体）');
  /* 表头：th 的 data-key 序列（跳过选择列 th） */
  const thKeys = [...parts[0].matchAll(/<th[^>]*data-key="([^"]+)"/g)].map(function (m) { return m[1]; });
  assert.deepEqual(thKeys, HEAD7.concat(plain(app.run('TBL_SCHEMAS.delivery.map(function(c){return c.key})')).slice(7)),
    '表头列序必须与 schema 全量列序一致');
  assert.equal(thKeys.slice(0, 7).join(','), HEAD7.join(','), '表头前 7 列 = 单据级 7 列');

  const bodyRows = [...parts[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(function (m) { return m[1]; });
  const sumRow = bodyRows[bodyRows.length - 1];
  const dataRows = bodyRows.slice(0, -1);
  assert.equal(dataRows.length, 3, '合计行之外应有 3 个数据行（2 + 1）');

  const KEY = function (row, k) {
    const m = row.match(new RegExp('<td[^>]*data-key="' + k + '"[^>]*>([\\s\\S]*?)</td>'));
    return m ? m[1] : null;
  };
  const TDS = function (row) { return (row.match(/<td[\s>]/g) || []).length; };
  /* 按「是否含单据格」切分组（首列 planNo 存在=组首行；不存在=rowspan 合并的续行）。
     不依赖展示顺序：renderDelivery 默认按 createdAt 降序聚集，顺序会随数据变化。 */
  const groups = [];
  dataRows.forEach(function (r) {
    if (KEY(r, 'planNo') !== null) groups.push({ planNo: KEY(r, 'planNo'), rows: [r] });
    else groups[groups.length - 1].rows.push(r);
  });
  assert.equal(groups.length, 2, '两条交付计划 → 两个 rowspan 分组');
  const g2items = groups.find(function (g) { return g.planNo === 'JFJH-20260823-00001'; });
  const g1item = groups.find(function (g) { return g.planNo === 'JFJH-20260824-00001'; });
  assert.ok(g2items && g1item, '两组编号必须各自正确渲染（planNo 值）');

  /* 组 A（2 个明细行）：7 个单据格 rowspan=2 + 行级 10 格 + 选择格 1 = 18 */
  const a0 = g2items.rows[0];
  assert.equal(g2items.rows.length, 2, 'rowspan=2 的组应有 2 行');
  assert.equal(TDS(a0), 18, '组首行 td 总数 = 1(选择) + 7(单据) + 10(行级)');
  HEAD7.forEach(function (k) {
    assert.match(a0, new RegExp('<td data-key="' + k + '" rowspan="2"'), '单据级列 ' + k + ' 必须 rowspan=2');
  });
  assert.equal(KEY(a0, 'planNo'), 'JFJH-20260823-00001', '首列值 = 交付计划编号');
  /* 续行：单据格与选择格均已 rowspan 合并 → 只剩行级 10 格 */
  const a1 = g2items.rows[1];
  assert.equal(TDS(a1), 10, '续行 td 总数 = 0(选择,已合并) + 0(单据,已合并) + 10(行级)');
  HEAD7.forEach(function (k) { assert.equal(KEY(a1, k), null, '续行不得重复输出单据格 ' + k); });

  /* 组 B（1 个明细行）：rowspan=1 */
  const b0 = g1item.rows[0];
  assert.equal(g1item.rows.length, 1);
  assert.equal(TDS(b0), 18, '单明细行组的 td 总数');
  HEAD7.forEach(function (k) {
    assert.match(b0, new RegExp('<td data-key="' + k + '" rowspan="1"'), '单据级列 ' + k + ' 必须 rowspan=1');
  });
  assert.equal(KEY(b0, 'planNo'), 'JFJH-20260824-00001');

  /* 合计行：所有 schema 列各一个 td（带 data-key），前 7 列随列布局对齐 */
  const sumKeys = [...sumRow.matchAll(/data-key="([^"]+)"/g)].map(function (m) { return m[1]; });
  assert.deepEqual(sumKeys, plain(app.run('TBL_SCHEMAS.delivery.map(function(c){return c.key})')), '合计行逐列同构');
  assert.equal(KEY(sumRow, 'planNo'), '合计', '合计标签落在首列（标签随列布局首列）');
  app.dispose();
});

test('G4 空数据：仍渲染 7 个单据级表头（列集合不因无数据而少列）', () => {
  const app = app0({ deliveries: [] });
  const html = String(app.run('renderDelivery()'));
  assert.match(html, /暂无交付计划/);
  assert.doesNotMatch(html, /暂无交付计划[\s\S]*data-key="planNo"/, '空态不渲染表格');
  app.dispose();
});

/* ================================================================
   §H 导入兜底：缺号补号 / 重复号重分配
   ================================================================ */

test('H1 导入兜底：缺号自动补、重复号保留首次并重新分配新号、跨日期各自从 00001 起', () => {
  const app = app0({
    deliveries: [
      { createdAt: '2026-08-23' },                                   /* 缺号 → 补 */
      { createdAt: '2026-08-23', planNo: 'JFJH-20260823-00001' },     /* 首次出现 → 保留 */
      { createdAt: '2026-08-23', planNo: 'JFJH-20260823-00001' },     /* 重复 → 重编号 */
      { createdAt: '2026-08-24' },                                    /* 缺号（另一日）→ 00001 */
    ],
  });
  const r = plain(app.run('normalizeImportedDeliveryPlanNo()'));
  assert.deepEqual(r, { filled: 2, renumbered: 1 });
  const nos = plain(app.getGlobal('deliveries')).map(function (d) { return d.planNo; });
  assert.deepEqual(nos, [
    'JFJH-20260823-00002',
    'JFJH-20260823-00001',
    'JFJH-20260823-00003',
    'JFJH-20260824-00001',
  ]);
  assert.equal(new Set(nos).size, nos.length, '归一化后必须全局唯一');
  app.dispose();
});

test('H2 导入兜底：全部合法（有号且唯一）→ 一字不动，计数为 0', () => {
  const app = app0({
    deliveries: [
      { createdAt: '2026-08-23', planNo: 'JFJH-20260823-00001' },
      { createdAt: '2026-08-23', planNo: 'JFJH-20260823-00005' },
      { createdAt: '2026-08-24', planNo: 'JFJH-20260824-00001' },
    ],
  });
  const before = plain(app.getGlobal('deliveries'));
  const r = plain(app.run('normalizeImportedDeliveryPlanNo()'));
  assert.deepEqual(r, { filled: 0, renumbered: 0 });
  assert.deepEqual(plain(app.getGlobal('deliveries')), before, '不得改动已合法的导入编号');
  app.dispose();
});

test('H3 导入兜底：空库 / 非数组 → 零计数且不抛错', () => {
  const app = app0({ deliveries: [] });
  assert.deepEqual(plain(app.run('normalizeImportedDeliveryPlanNo()')), { filled: 0, renumbered: 0 });
  app.dispose();
});

test('H4 导入兜底：缺 createdAt 时编号日期兜底 2026-08-23（与回填口径一致）', () => {
  const app = app0({ deliveries: [{ planNo: '' }] });
  app.run('normalizeImportedDeliveryPlanNo()');
  assert.equal(plain(app.getGlobal('deliveries'))[0].planNo, 'JFJH-20260823-00001');
  app.dispose();
});

test('H5【返工 P-3】导入：planNo = 纯空白 → 计入「补号」并被真实编号覆盖（不得留存空白编号）', () => {
  const app = app0({
    deliveries: [
      { createdAt: '2026-08-23', planNo: '   ' },                    /* 空白 → 补号（旧实现视为已有而放过） */
      { createdAt: '2026-08-23', planNo: 'JFJH-20260823-00001' },     /* 合法唯一 → 保留 */
    ],
  });
  const r = plain(app.run('normalizeImportedDeliveryPlanNo()'));
  assert.deepEqual(r, { filled: 1, renumbered: 0 }, '空白必须计入补号');
  const nos = plain(app.getGlobal('deliveries')).map(function (d) { return d.planNo; });
  assert.deepEqual(nos, ['JFJH-20260823-00002', 'JFJH-20260823-00001']);
  nos.forEach(function (v) {
    assert.match(v, /^JFJH-\d{8}-\d{5}$/, '不得留存空白编号（实际 ' + JSON.stringify(v) + '）');
    assert.equal(String(v).trim(), v);
  });
  assert.equal(new Set(nos).size, nos.length);
  app.dispose();
});

test('H6【返工 P-3】导入：外围空白被归一化（干净值落库），且 trim 后仍参与去重', () => {
  const app = app0({
    deliveries: [
      { createdAt: '2026-08-24', planNo: '  JFJH-20260824-00003  ' },  /* 脏包裹 → 写回干净值，不算补号/重编号 */
      { createdAt: '2026-08-24', planNo: 'JFJH-20260824-00003' },      /* trim 后与上条重复 → 重编号 */
    ],
  });
  const r = plain(app.run('normalizeImportedDeliveryPlanNo()'));
  assert.deepEqual(r, { filled: 0, renumbered: 1 }, '空白包裹不算补号；紧随的重复号算重编号');
  const nos = plain(app.getGlobal('deliveries')).map(function (d) { return d.planNo; });
  assert.deepEqual(nos, ['JFJH-20260824-00003', 'JFJH-20260824-00004']);
  nos.forEach(function (v) {
    assert.equal(String(v).trim(), v, '落库必须为 trim 后的干净值');
    assert.match(v, /^JFJH-\d{8}-\d{5}$/);
  });
  app.dispose();
});

test('H7【返工 P-2】导入：脏 createdAt（abc / 2026-8-5）→ 补出的编号进 2026-08-23 哨兵桶且格式合法', () => {
  const app = app0({
    deliveries: [
      { createdAt: 'abc' },
      { createdAt: '2026-8-5' },
      { createdAt: null },
    ],
  });
  const r = plain(app.run('normalizeImportedDeliveryPlanNo()'));
  assert.deepEqual(r, { filled: 3, renumbered: 0 });
  const nos = plain(app.getGlobal('deliveries')).map(function (d) { return d.planNo; });
  assert.deepEqual(nos, ['JFJH-20260823-00001', 'JFJH-20260823-00002', 'JFJH-20260823-00003']);
  nos.forEach(function (v) { assert.match(v, /^JFJH-\d{8}-\d{5}$/); });
  app.dispose();
});

/* ================================================================
   §I 静态守卫：口径单源 / 接线到位 / 版本水印
   ================================================================ */

test('I1 口径单源：index.html 恰 1 处定义 nextDeliveryPlanNo；import.js 零公式副本', () => {
  const defs = (INDEX_SRC.match(/function\s+nextDeliveryPlanNo\s*\(/g) || []).length;
  assert.equal(defs, 1, 'index.html 中 nextDeliveryPlanNo 必须恰好定义一次（实际 ' + defs + '）');
  assert.doesNotMatch(IMPORT_CODE, /function\s+nextDeliveryPlanNo\s*\(/, 'import.js 不得自带编号函数副本');
  assert.doesNotMatch(IMPORT_CODE, /JFJH-/, 'import.js **代码**（去注释）不得出现编号前缀常量（防公式副本）');
  assert.doesNotMatch(IMPORT_CODE, /padStart\(\s*5\s*/, 'import.js 不得自行拼 5 位序号（防公式副本）');
  assert.match(IMPORT_CODE, /nextDeliveryPlanNo\s*\(/, 'import.js 必须经全局 nextDeliveryPlanNo 取号');
  /* 存量回填迁移同样不得自造公式：只调用，不拼前缀 */
  const mig = extractFn(INDEX_SRC, 'migrateDeliveryPlanNo');
  assert.match(mig, /nextDeliveryPlanNo\s*\(/, '回填迁移必须复用 nextDeliveryPlanNo（口径单源）');
  assert.doesNotMatch(stripComments(mig), /JFJH-/, '回填迁移不得内联前缀常量');
  assert.doesNotMatch(stripComments(mig), /padStart/, '回填迁移不得内联补零逻辑');
});

test('I2 接线：initApp 中迁移已调用，且顺序在三处锚点之后（createdAt 已兜底）', () => {
  const iCreated = INDEX_SRC.indexOf('migrateDeliveryCreatedAt();');
  const iLine = INDEX_SRC.indexOf('migrateDeliveryOrderLine();');
  const iField = INDEX_SRC.indexOf('migrateDeliveryPlanNoField();');
  const iNo = INDEX_SRC.indexOf('migrateDeliveryPlanNo();');
  assert.ok(iCreated > 0, 'migrateDeliveryCreatedAt(); 必须在场');
  assert.ok(iLine > 0, 'migrateDeliveryOrderLine(); 必须在场');
  assert.ok(iField > 0, 'migrateDeliveryPlanNoField(); 必须在 initApp 中调用');
  assert.ok(iNo > 0, 'migrateDeliveryPlanNo(); 必须在 initApp 中调用');
  assert.ok(iField > iLine, '字段配置迁移应在 orderLine 迁移之后');
  assert.ok(iNo > iField, '编号回填应在字段配置迁移之后');
  assert.ok(iNo > iCreated, '编号回填必须晚于 createdAt 兜底回填（依赖其回填结果）');
});

test('I3 导入接线：仅 delivery 分支触发归一化；product/order 既有分支零改动', () => {
  assert.equal((IMPORT_CODE.match(/function\s+normalizeImportedDeliveryPlanNo\s*\(/g) || []).length, 1, '归一化函数恰定义一次');
  assert.equal((IMPORT_CODE.match(/\?normalizeImportedDeliveryPlanNo\(\)/g) || []).length, 2,
    '调用点恰 2 处（单表单 + 全量导入），且均以 formKey===\'delivery\' 三元门控');
  assert.equal((IMPORT_CODE.match(/\(cfg\.formKey==='delivery'\)/g) || []).length, 1, '单表单分支用 cfg');
  assert.equal((IMPORT_CODE.match(/\(p\.cfg\.formKey==='delivery'\)/g) || []).length, 1, '全量分支用 p.cfg');
  /* 既有订单聚合分支原文保留（本次不得触碰 product / order 行为） */
  assert.match(IMPORT_CODE, /if\(cfg\.formKey==='order'\)newData=groupOrderRows\(newData\);/, '销售/库存订单聚合分支原文保留');
  assert.match(IMPORT_CODE, /if\(cfg2\.formKey==='order'\)nd=groupOrderRows\(nd\);/, '全量订单聚合分支原文保留');
  assert.match(IMPORT_CODE, /alert\('导入成功！共导入 '\+newData\.length\+' 条记录到「'\+cfg\.sheet\+'」。'/, '成功提示保留');
  assert.match(IMPORT_CODE, /if\(!pm\[pid\]\)/, '金蝶导入既有分支原文保留');
});

test('I4 导出/模板：planNo 经持久化 fields.delivery 自然纳入（导出列 + 模板必填标红）', () => {
  /* 导出列 = fields[formKey]；模板表头 red = !!f.required —— 故只需保证持久化配置补齐（§C 已钉）。 */
  assert.match(INDEX_SRC, /var headers=farr\.map\(function\(f\)\{return \{t:f\.label,red:!!f\.required\};\}\);/, '模板标红取 f.required，口径未变');
  const app = app0();
  assert.equal(plain(app.getGlobal('defaultFields')).delivery[0].required, true, 'planNo 必填 → 标红');
  /* 交付计划在导出/导入的 sheet 配置中仍注册着 */
  assert.match(INDEX_SRC, /\{sheet:'交付计划',varName:'deliveries',formKey:'delivery'\}/, '交付计划表单注册未变');
  app.dispose();
});

test('I5 水印：权威水印恰 1 处 build '+BUILD+'，且注释里无同名带 < 形态（deploy.sh 精确匹配）', () => {
  assert.equal((INDEX_SRC.match(buildMarkRe(BUILD)) || []).length, 1, '权威水印应恰 1 处');
  assert.equal((INDEX_SRC.match(buildAnyRe(PREV)) || []).length, 0, '上一版本 '+PREV+' 应 0 处');
});

test('I6 表单只读：交付计划编号在弹窗内为 readonly（“不可手动修改”）', () => {
  const body = extractFn(INDEX_SRC, 'deliveryModal');
  assert.match(body, /id="dl_planNo"/, '弹窗须有编号展示格');
  assert.match(body, /<input type="text" id="dl_planNo" readonly/, '必须是 readonly');
  assert.match(body, /系统生成，不可修改/, '须有小字提示');
  assert.match(body, /保存后自动生成/, '新增态须提示保存后自动生成');
  /* 表单不提交该字段（saveDelivery 不从 DOM 读 planNo）→ 不可篡改 */
  const save = extractFn(INDEX_SRC, 'saveDelivery');
  assert.doesNotMatch(save, /dl_planNo/, 'saveDelivery 不得从表单读编号（只读字段不参与提交）');
  assert.doesNotMatch(save, /planNo/, 'saveDelivery 不得写编号（编号只在 doSaveDelivery 生成/保留）');
});

test('I7【返工 P-3】静态守卫：两处判空均为 trim 后判空（同一口径同修，防回归）', () => {
  const mig = stripComments(extractFn(INDEX_SRC, 'migrateDeliveryPlanNo'));
  assert.match(mig, /String\(d\.planNo\)\.trim\(\)/, 'index.html 迁移必须 trim 后判空');
  assert.doesNotMatch(mig, /if\(!d\|\|d\.planNo\)return/, '不得回到「真值判空」（空白会漏网）');
  assert.match(IMPORT_CODE, /var no=d\.planNo==null\?'':String\(d\.planNo\)\.trim\(\)/, 'import.js 必须同源 trim 后判空');
  assert.match(IMPORT_CODE, /if\(no!==d\.planNo\)d\.planNo=no;/, 'import.js 必须把 trim 后的干净值写回');
  assert.doesNotMatch(IMPORT_CODE, /var no=d\.planNo\?String\(d\.planNo\):''/, '不得回到未 trim 的取值（同源同病）');
});

test('I8【返工 P-3】行为锚点：迁移只把「空白」判为缺号 —— 非空（含外围空白）编号不改写、零写入', () => {
  const app = createApp({
    seed: { deliveries: [dl('K1', '2026-08-23', null, { planNo: '  JFJH-20260823-00042  ' })] },
  });
  app.run('migrateDeliveryPlanNo()');
  const d = plain(app.getGlobal('deliveries'))[0];
  assert.equal(app.recorder.writeCount(), 0, '非空编号不得被改写（含外围空白场景）→ 零写入');
  assert.equal(d.planNo, '  JFJH-20260823-00042  ',
    '迁移只负责「空白 → 赋号」；trim 清洗职责在导入归一化（避免误改线上存量）');
  app.dispose();
});

/* ---- I8b（2026-10-06.134 · 用户批准纳入）：读取侧 trim 容错 ----
   ⚠️ 判别力登记（防「虚设绿」——修复前必须红的用例才叫真守卫）：
     · I8b-1（脏值持最高号）、I8b-2 第二夹具（脏值持最高号）、I8b-3（全脏桶）：
       在「未 trim 的旧读取路径」下产出不同结果 → **真判别**，由 I8b-7 反虚设守卫逐条实测证明。
     · I8b-2 第一夹具为用户指定夹具（旧路径恰好同值 00010），保留以固化用户口径，不承担判别职责。
     · I8b-4 为**静态断言**（恰 2 处读取侧 trim + 旧未 trim 形态不得复现）：不依赖夹具巧合，恒判别。
     · I8b-5 是「修复不得越界蔓延到写入侧」的回归守卫（不判别读取侧修复本身）。
     · I8b-6 是「正常路径零变化」守卫（按设计不判别，防误伤）。 */

test('I8b-1【I8b 修复后】桶内仅存带外围空白的「  JFJH-…-00042  」→ 新单必须接续 00043（不再另起 00001）', () => {
  const app = createApp({
    seed: { deliveries: [dl('K1', '2026-08-23', null, { planNo: '  JFJH-20260823-00042  ' })] },
  });
  assert.equal(app.run('nextDeliveryPlanNo("2026-08-23")'), 'JFJH-20260823-00043',
    'max 扫描必须在比较前 trim：否则不被计数 → 会发 00001');
  app.dispose();
});

test('I8b-2【I8b 修复后】桶内存「  JFJH-…-00007  」与「JFJH-…-00009」→ 两者都计入，新单得 00010', () => {
  const app = createApp({
    seed: { deliveries: [
      dl('K1', '2026-08-23', null, { planNo: '  JFJH-20260823-00007  ' }),
      dl('K2', '2026-08-23', null, { planNo: 'JFJH-20260823-00009' }),
    ] },
  });
  assert.equal(app.run('nextDeliveryPlanNo("2026-08-23")'), 'JFJH-20260823-00010',
    '两端（干净 + 带空白）都要计数，取 max=9 → 00010');
  app.dispose();

  /* 反向夹具（**判别方向**）：让脏包裹的那条持最高号 —— 未 trim 的旧实现只看得到干净的 00007 →
     会发 00008，与存量 00009 语义撞车；修复后 max=9 → 00010。（I8b-7 实测旧实现得 00008） */
  const app2 = createApp({
    seed: { deliveries: [
      dl('K1', '2026-08-23', null, { planNo: 'JFJH-20260823-00007' }),
      dl('K2', '2026-08-23', null, { planNo: '  JFJH-20260823-00009  ' }),   /* 脏包裹持最高号 */
    ] },
  });
  assert.equal(app2.run('nextDeliveryPlanNo("2026-08-23")'), 'JFJH-20260823-00010',
    '脏包裹的最高号也必须计入 → 00010（旧实现只数到 7 → 会误发 00008）');
  app2.dispose();
});

test('I8b-3【I8b 修复后】去重兜底：存量里已有（含外围空白的）00001 → 生成结果不得是 00001', () => {
  /* 夹具取「全脏桶」（存量编号**全部**被空白包裹）：此时未 trim 的旧实现 max 扫描一条都数不到 →
     候选 00001，且旧去重集合里存的是「  JFJH-…-00001  」原文，与候选字符串不等 → **旧实现会发 00001**，
     制造 trim 后与存量完全相同的可见重号。修复后 max=2 → 00003。（I8b-7 实测旧实现得 00001） */
  const app = createApp({
    seed: { deliveries: [
      dl('K1', '2026-08-23', null, { planNo: '  JFJH-20260823-00001  ' }),   /* 脏包裹的 00001 */
      dl('K2', '2026-08-23', null, { planNo: '  JFJH-20260823-00002  ' }),
    ] },
  });
  const v = String(app.run('nextDeliveryPlanNo("2026-08-23")'));
  assert.notEqual(v, 'JFJH-20260823-00001', 'trim 后等值必须被拦住 —— 绝不可重发已被占用的 00001');
  assert.match(v, /^JFJH-\d{8}-\d{5}$/, '格式仍必须合法');
  assert.equal(v, 'JFJH-20260823-00003', 'max=2（两条脏包裹都计入）→ 00003');
  app.dispose();
});

test('I8b-4【I8b 静态断言·恒判别】nextDeliveryPlanNo 恰有 2 处读取侧 trim，且旧未 trim 形态不得复现', () => {
  /* 为什么用静态断言而不是动态夹具：只要 max 扫描已 trim，「去重兜底」在可构造的干净/脏数据下
     都取不到差异（候选 = max+1，凡是 trim 后等于候选的存量值必然已被 trim 后的扫描计入 max，
     从而 max ≥ 该号 → 候选必 > 该号 —— 故去重路径的 trim 无法用行为夹具判别）。
     要钉住「去重集合也必须 trim」，只能直接断言源码形态。 */
  const body = stripComments(extractFn(INDEX_SRC, 'nextDeliveryPlanNo'));
  const trims = body.match(/String\([^)]*\.planNo[^)]*\)\.trim\(\)/g) || [];
  assert.equal(trims.length, 2, '读取侧 trim 必须恰 2 处（max 扫描 + 去重集合），实际 ' + trims.length);
  assert.equal((body.match(/\.trim\(\)/g) || []).length, 2,
    '函数内 .trim() 总数必须恰 2 —— 多一处即意味着容错逻辑扩散（越界）');
  /* 逐处锚定形态（防「换了别处凑数」） */
  assert.match(body, /const v=\(x&&x\.planNo!=null\)\?String\(x\.planNo\)\.trim\(\):'';/,
    '第 1 处：max 扫描侧必须先 trim 再比较/解析');
  assert.match(body, /const v=String\(x\.planNo\)\.trim\(\);if\(v\)used\[v\]=1;/,
    '第 2 处：去重集合必须按 trim 后的值构建');
  /* 旧（未 trim）形态必须 0 处复现 */
  assert.doesNotMatch(body, /x\.planNo\.indexOf\(prefix\)===0/, '不得回到未 trim 的前缀比较');
  assert.doesNotMatch(body, /x\.planNo\.slice\(prefix\.length\)/, '不得回到未 trim 的序号解析');
  assert.doesNotMatch(body, /used\[x\.planNo\]/, '不得回到未 trim 的去重集合构建');
  /* 写入侧零蔓延：函数内不得出现任何「回写 planNo / 写库」动作（读取侧只读） */
  assert.doesNotMatch(body, /\.planNo\s*=[^=]/, 'nextDeliveryPlanNo 不得回写存量 planNo（只读容错）');
  assert.doesNotMatch(body, /\bsave\s*\(/, 'nextDeliveryPlanNo 不得触发写库');
});

test('I8b-5【回归守卫·写入侧不被蔓延】同一夹具下：扫描计入脏包裹编号，但迁移仍对非空编号零写入', () => {
  const app = createApp({
    seed: { deliveries: [dl('K1', '2026-08-23', null, { planNo: '  JFJH-20260823-00042  ' })] },
  });
  /* 读取侧：已容错（I8b-1 同款） */
  assert.equal(app.run('nextDeliveryPlanNo("2026-08-23")'), 'JFJH-20260823-00043');
  /* 写入侧：迁移仍一字不改、零写入（读取侧 trim 不得蔓延成存量清洗） */
  app.run('migrateDeliveryPlanNo()');
  assert.equal(app.recorder.writeCount(), 0, '迁移对非空（含外围空白）编号必须仍然零写入');
  assert.equal(plain(app.getGlobal('deliveries'))[0].planNo, '  JFJH-20260823-00042  ',
    '存量值一字不改（不 trim 数据、不改清洗口径）');
  app.dispose();
});

test('I8b-6【正常路径零变化】全干净编号下行为与修复前完全一致（max+1 / 5 位补零 / 同桶跨桶）', () => {
  const app = createApp({
    seed: { deliveries: [
      dl('K1', '2026-08-23', null, { planNo: 'JFJH-20260823-00001' }),
      dl('K2', '2026-08-23', null, { planNo: 'JFJH-20260823-00002' }),
      dl('K3', '2026-08-24', null, { planNo: 'JFJH-20260824-00001' }),
      dl('K4', '2026-08-23', null, { planNo: 'JFJH-20260822-00001' }),   /* 跨桶不干扰 */
    ] },
  });
  assert.equal(app.run('nextDeliveryPlanNo("2026-08-23")'), 'JFJH-20260823-00003');
  assert.equal(app.run('nextDeliveryPlanNo("2026-08-24")'), 'JFJH-20260824-00002');
  assert.equal(app.run('nextDeliveryPlanNo("2026-08-25")'), 'JFJH-20260825-00001');
  assert.equal(app.run('nextDeliveryPlanNo("2026-08-23")').length, 19, '格式长度不变');
  app.dispose();
});

/* ------------------------------------------------------------------
   I8b-7 反虚设（anti-vacuity）：把「未 trim 的旧读取实现」原样注入沙箱并与生产实现同夹具对拍。
   目的：证明 I8b-1 / I8b-2(第二夹具) / I8b-3 的夹具**真的具备判别力**（旧实现必须给出不同、且更差的
   结果）；否则那几条只是「虚设绿」。同时，若将来有人把生产源码退回旧实现，本用例会立刻指出
   「夹具仍具判别力而 I8b-1/2/3 已变红」，给出明确的归因线索。
   ⚠️ 本用例内联的旧实现只存在于**测试文件**中，不构成生产代码的「口径副本」（§I1 只扫 index.html / import.js）。
------------------------------------------------------------------- */
test('I8b-7【反虚设守卫】未 trim 的旧读取实现在同一夹具下产出更差结果 → 证明 I8b-1/2/3 夹具具判别力', () => {
  /* 旧实现（I8b 修复前原样）：与生产 nextDeliveryPlanNo 的差异仅在读取侧不 trim */
  const LEGACY_SRC = [
    'function legacyPlanNoRead(dateStr){',
    '  const _ds=String(dateStr==null?"":dateStr);',
    '  const d=(/^\\d{4}-\\d{2}-\\d{2}$/.test(_ds)?_ds:"2026-08-23").replace(/-/g,"");',
    '  const prefix="JFJH-"+d+"-";',
    '  let max=0;',
    '  (deliveries||[]).forEach(x=>{',
    '    if(x&&x.planNo&&typeof x.planNo==="string"&&x.planNo.indexOf(prefix)===0){',
    '      const n=parseInt(x.planNo.slice(prefix.length),10);',
    '      if(!isNaN(n)&&n>max)max=n;',
    '    }',
    '  });',
    '  let n=max+1;',
    '  const used={};',
    '  (deliveries||[]).forEach(x=>{if(x&&x.planNo)used[x.planNo]=1;});',
    '  while(used[prefix+String(n).padStart(5,"0")])n++;',
    '  return prefix+String(n).padStart(5,"0");',
    '}',
  ].join('\n');

  /** 同一夹具分别跑「生产实现」与「旧实现」并返回两者结果（夹具每侧深拷贝，避免相互污染） */
  function duel(deliveries) {
    const app = createApp({ seed: { deliveries: JSON.parse(JSON.stringify(deliveries)) } });
    app.run(LEGACY_SRC);
    const prod = String(app.run('nextDeliveryPlanNo("2026-08-23")'));
    const old = String(app.run('legacyPlanNoRead("2026-08-23")'));
    app.dispose();
    return { prod: prod, old: old };
  }

  /* 夹具 A ＝ I8b-1：桶内仅存脏包裹的 00042 */
  const a = duel([dl('K1', '2026-08-23', null, { planNo: '  JFJH-20260823-00042  ' })]);
  assert.equal(a.old, 'JFJH-20260823-00001', '旧实现确实会另起 00001（夹具 A 的判别力证据）');
  assert.equal(a.prod, 'JFJH-20260823-00043', '生产实现接续 00043');
  assert.notEqual(a.prod, a.old, 'I8b-1 具备判别力：修复前后结果不同');

  /* 夹具 B ＝ I8b-2 第二夹具：脏包裹值持最高号 00009，干净值 00007 */
  const b = duel([
    dl('K1', '2026-08-23', null, { planNo: 'JFJH-20260823-00007' }),
    dl('K2', '2026-08-23', null, { planNo: '  JFJH-20260823-00009  ' }),
  ]);
  assert.equal(b.old, 'JFJH-20260823-00008', '旧实现只数到 7 → 会误发 00008（与存量 00009 语义撞车）');
  assert.equal(b.prod, 'JFJH-20260823-00010', '生产实现 max=9 → 00010');
  assert.notEqual(b.prod, b.old, 'I8b-2 第二夹具具备判别力');

  /* 夹具 C ＝ I8b-3：全脏桶（00001 + 00002 均被空白包裹） */
  const c = duel([
    dl('K1', '2026-08-23', null, { planNo: '  JFJH-20260823-00001  ' }),
    dl('K2', '2026-08-23', null, { planNo: '  JFJH-20260823-00002  ' }),
  ]);
  assert.equal(c.old, 'JFJH-20260823-00001', '旧实现 scan 全数落空 → 直接重发可见重号 00001');
  assert.equal(c.prod, 'JFJH-20260823-00003', '生产实现 max=2 → 00003');
  assert.notEqual(c.prod, c.old, 'I8b-3 具备判别力');

  /* 反虚设的另一半：I8b-2 第一夹具（用户指定）在旧实现下同值 —— 如实登记，避免误以为它也是守卫 */
  const d = duel([
    dl('K1', '2026-08-23', null, { planNo: '  JFJH-20260823-00007  ' }),
    dl('K2', '2026-08-23', null, { planNo: 'JFJH-20260823-00009' }),
  ]);
  assert.equal(d.old, 'JFJH-20260823-00010');
  assert.equal(d.prod, 'JFJH-20260823-00010', '用户指定夹具新旧同值 → 不承担判别职责（已在 I8b 头部登记）');

  /* 正常路径（编号全干净）下新→旧实现结果必须完全一致：证明修复零副作用 */
  const e = duel([
    dl('K1', '2026-08-23', null, { planNo: 'JFJH-20260823-00001' }),
    dl('K2', '2026-08-23', null, { planNo: 'JFJH-20260823-00002' }),
  ]);
  assert.equal(e.prod, e.old, '干净数据下新旧实现必须同值（I8b 零副作用）');
  assert.equal(e.prod, 'JFJH-20260823-00003');
});

test('I9【返工·任务3】tests/check-syntax.js 的 stdio 已修为 [\'ignore\',\'pipe\',\'pipe\']（防 EBUSY 假失败回归）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tests', 'check-syntax.js'), 'utf8');
  assert.match(src, /execFileSync\(process\.execPath,\s*\['--check',\s*abs\],\s*\{\s*stdio:\s*\['ignore',\s*'pipe',\s*'pipe'\]\s*\}\s*\)/,
    '必须用三元素数组 stdio（未改名/未改参数）');
  assert.doesNotMatch(src, /stdio:\s*'pipe'\s*\}/, "不得回到 stdio:'pipe'（会创建 stdin 管道 → EBUSY）");
  assert.match(src, /\['--check',\s*abs\]/, '仍对每个文件跑 node --check（逻辑零变化）');
});
