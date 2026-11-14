'use strict';
/* ================================================================
   tests/invlevel.160.test.js —— 库存管理「结余=0 且 最小库存量>0」必须黄色警示（【build .160】）
   ================================================================
   用户报障（2026-11-14，原话要点）：
     库存管理列表（NAV 'inv' → renderInvOrders，formKey='order_inv'）的「结余」列，
     数值为 0 且该行「最小库存量」> 0 时**没有**黄色警告标志，应当有。
   根因（已定位，本文件不复盘）：
     共享函数 invStockLevel 的 amber 档条件写成 `num(v)>0 && …`，把 v=0 排除在外 ——
     0 直接落到 green（无三角、无着色）。这是**旧口径**（>0 且<最小才黄色）。
   用户拍板的需求（逐字实现）：
     · A 方案：只改共享函数 invStockLevel 的阈值（一处改动，全局单源）；
     · 「已交付」列（lvD）在 已交付=0 且 最小>0 时**也要**一起变黄 —— 不为结余列单独开分支；
     · 结余=0 且「最小库存量」为 0 或留空（不设限）→ **维持绿色**，不设限语义不变。
   新口径：**0 ≤ v < 最小库存量 且 最小>0 → amber**。

   本文件守什么（每条都写明「若功能坏了会怎么红」）：
     §A 档位矩阵：核心（0/min>0 → amber）+ 不设限不回归（min=0 / min='' / min=null → green）
        + 优先级不回归（red 优先于 amber、gray 档不变、1<min 仍 amber）
     §B 一句话总结文案：结余=0 且 amber 时**不得**短路成「…，排产合理」（旧口径下 lvB=green 会短路）
     §C 渲染级：renderInvOrders() 对「结余=0 且 stockMin>0」的行必须在**「结余」单元格**里画出
        黄色三角 `#f59e0b`；对「结余=0 且 stockMin=0」的行整张表不得出现 `#f59e0b`
     §D 单源守卫：档位判定全工程恰 1 处、调用点不复制判据、旧口径片段零残留
     §E 判别力自证（变异注入）：把阈值改回 `num(v)>0` 的源码副本上，§A/§C 的核心断言必须变红

   运行（显式文件，勿用 node -e，见 tests/README §1）：
     node --test tests/invlevel.160.test.js
   ================================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createApp, ROOT } = require('./harness/sandbox');
/* 版本号只从单一来源派生（本文件是 per-version 用例，**禁止**硬编码版本字面量：
   否则每推进一版就多一处「下一版必红」的锚点，见 tests/harness/build.js 版本推进纪律）。 */
const build = require('./harness/build');

const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* ================================================================
   夹具与沙箱装载（照抄既有约定：createApp + seed，与 invbalance.139 同款）
   ================================================================ */

/**
 * 库存订单夹具。
 * @param {string} id 订单号
 * @param {Array<{pid:string,qty:number,min:*,max?:number,dv?:number}>} rows 明细行
 * @returns {Object} 订单对象
 */
function mkInvOrder(id, rows) {
  return {
    id: id, orderType: '库存订单', customer: '内部库存', status: '执行中',
    startDate: '2026-11-10', deadline: '', contractNo: '',
    items: rows.map(function (r) {
      return {
        productId: r.pid, productName: r.pid, spec: '', model: '', unit: '台',
        orderQty: r.qty,
        stockMax: (r.max === undefined ? r.qty : r.max),
        stockMin: r.min,
        deliveredQty: (r.dv === undefined ? 0 : r.dv),
        calledQty: 0, lineNotes: '',
      };
    }),
  };
}

/**
 * 装载沙箱并注入最小数据（orders / products / deliveries / productionPlans 均给空默认，
 * 避免「没注入的全局在渲染途中 undefined」这类与本次修复无关的噪声）。
 * @param {Object} [seed] 追加/覆盖的全局
 * @param {Object} [opts] createApp 选项（如 indexHtml / transformMain）
 * @returns {Object} app（需调用方 dispose）
 */
function boot(seed, opts) {
  return createApp(Object.assign({
    quietConsole: true,
    seed: Object.assign({
      orders: [], products: [], deliveries: [], productionPlans: [],
      productionReports: [], transfers: [], processTemplates: [], logs: [],
      meta: { seq: 0 },
    }, seed || {}),
  }, opts || {}));
}

/** 取 invStockLevel 的判定结果（字符串：red/amber/green/gray） */
function lv(app, v, min, max) {
  return app.run('invStockLevel(' + JSON.stringify(v) + ',' + JSON.stringify(min) + ',' + JSON.stringify(max) + ')');
}

/** 去注释（行/块）：源码扫描前先剥注释，避免注释里的示例文本误命中 */
function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** 取顶层函数体（含签名），用于「调用点形态未变」类断言 */
function extractFn(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(', 'g');
  const m = re.exec(src);
  if (!m) throw new Error('[invlevel.160] 未找到函数: ' + name);
  let p = m.index + m[0].length, d = 1;
  for (; p < src.length; p++) {
    if (src[p] === '(') d++;
    else if (src[p] === ')') { d--; if (d === 0) break; }
  }
  const i = src.indexOf('{', p);
  let j = i; d = 0;
  for (; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (d === 0) break; }
  }
  return src.slice(m.index, j + 1);
}

/* ================================================================
   §A 档位矩阵（单元级）
   ================================================================ */

test('A1 核心修复：结余=0 且 最小库存量>0 → amber（旧口径落 green，用户报障点）', function () {
  const app = boot();
  try {
    assert.equal(lv(app, 0, 50, 100), 'amber',
      '0 低于下限 50 就是缺货 → 必须 amber（时间：.160 起口径为 0 ≤ v < 最小）');
    /* 字符串形态（表单/存量数据里 stockMin 常是 '50'）也必须同判 */
    assert.equal(lv(app, 0, '50', 100), 'amber', 'stockMin 为字符串 "50" 时同样必须 amber');
    assert.equal(lv(app, '0', 50, 100), 'amber', 'v 为字符串 "0" 时同样必须 amber');
    /* 边界紧邻：下限上方一位仍是 amber，等于下限才落 green */
    assert.equal(lv(app, 1, 50, 100), 'amber', '1 < 50 → amber（原有区间不回归）');
    assert.equal(lv(app, 49, 50, 100), 'amber', '49 < 50 → amber');
    assert.equal(lv(app, 50, 50, 100), 'green', '等于下限即「达到最小库存」→ green');
  } finally { app.dispose(); }
});

test('A2 不设限语义不变：最小=0 / 留空 / null → 0 仍落 green（用户拍板第 2 点）', function () {
  const app = boot();
  try {
    assert.equal(lv(app, 0, 0, 100), 'green', '最小=0 = 不设限 → 0 仍 green');
    assert.equal(lv(app, 0, '', 100), 'green', '最小留空 = 不设限 → 0 仍 green');
    assert.equal(lv(app, 0, null, null), 'green', '上下限均为 null → green');
    assert.equal(lv(app, 0, undefined, undefined), 'green', '上下限均缺失 → green');
    /* 存量脏数据（.159 前允许存负数下限）：num(min)>0 守卫必须继续兜住，否则 0 会被误判 amber */
    assert.equal(lv(app, 0, -5, 100), 'green', '最小为负数（存量脏数据）→ 不视为设限 → green');
    /* 上下限都为 0（都不设限）→ green */
    assert.equal(lv(app, 0, 0, 0), 'green', '上下限都是 0 → green');
  } finally { app.dispose(); }
});

test('A3 优先级与其余两档不回归：red 优先于 amber；gray 判定不变', function () {
  const app = boot();
  try {
    assert.equal(lv(app, -1, 50, 100), 'red', '负数结余恒 red（red 优先于 amber）');
    assert.equal(lv(app, -0.5, 50, 100), 'red', '小数负值也恒 red');
    assert.equal(lv(app, 200, 50, 100), 'gray', '超上限 → gray（判定不变）');
    assert.equal(lv(app, 100, 50, 100), 'green', '等于上限 → green（不是 > 上限）');
    assert.equal(lv(app, 10, 5, 100), 'green', '正常区间 → green');
    /* 上限为 0 / 空 = 不设上限，不得产生 gray */
    assert.equal(lv(app, 999, 50, 0), 'green', '上限=0（不设限）→ 不得 gray');
    assert.equal(lv(app, 999, 50, ''), 'green', '上限留空（不设限）→ 不得 gray');
  } finally { app.dispose(); }
});

/* ================================================================
   §B 一句话总结文案（三角警示的悬浮说明）
   ================================================================ */

test('B1 已交付绿 + 结余 amber（=本次修复后的典型形态）→ 文案须含「未来仍不足」，不得短路成「排产合理」', function () {
  const app = boot();
  try {
    /* 场景：已交付 100（落在上 50~100 区间 → green），结余 0（< 下限 50 → amber）。
       旧口径下 lvB 也判 green ⇒ 命中 `lvD==='green'&&lvB==='green'` 短路 → 返回「…，排产合理」，
       与「结余 0 件、低于下限 50」的事实直接矛盾。 */
    const t = app.run('invRowSummary(100,0,50,100,"green","amber")');
    assert.ok(t.indexOf('未来仍不足') >= 0, '必须给出「未来仍不足」提示，实际：' + t);
    assert.equal(t.indexOf('排产合理'), -1, '不得短路成「排产合理」（结余 0 明显不达标），实际：' + t);
    assert.ok(t.indexOf('低于下限') >= 0, '必须点明「低于下限」，实际：' + t);
  } finally { app.dispose(); }
});

test('B2 结余 amber 的文案不得随「已交付」档位丢失（lvD 四档各判一次）', function () {
  const app = boot();
  try {
    ['red', 'amber', 'green', 'gray'].forEach(function (lvD) {
      const t = app.run('invRowSummary(0,0,50,100,"' + lvD + '","amber")');
      assert.ok(t.indexOf('未来仍不足') >= 0, 'lvD=' + lvD + ' 时结余警示不得被吞掉，实际：' + t);
    });
    /* 绿/绿 短路本身仍须保留（本次不改这条），否则「排产合理」这条既有文案会整体消失 */
    const g = app.run('invRowSummary(100,80,50,100,"green","green")');
    assert.ok(g.indexOf('排产合理') >= 0, '绿/绿 仍应走「排产合理」（本次只改阈值，不改短路规则），实际：' + g);
  } finally { app.dispose(); }
});

/* ================================================================
   §C 渲染级（renderInvOrders → orderSection → renderOrderTable）
   ----------------------------------------------------------------
   取值链（未改动）：invPuOf(puMap,…) → invPlannedUndelOf → invBalanceOf → invStockLevel(balance,it.stockMin,it.stockMax)
   本用例不造交付计划/排产单：pu=null ⇒ 已计划未交付 0 ⇒ 结余 = 已交付。
   这样「结余=0」由 deliveredQty=0 单独决定，夹具最小、断言最不含糊。
   ================================================================ */

/** 在 vm 内渲染库存管理页并回传关键单元格（跨 realm 安全：走 JSON 字符串） */
const RENDER_SCRIPT = [
  '(function(){',
  '  var html=renderInvOrders();',
  '  function cell(k){',
  '    var re=new RegExp("<td data-key=\\""+k+"\\"[^>]*>([\\\\s\\\\S]*?)</td>");',
  '    var m=html.match(re);',
  '    return m?m[1]:null;',
  '  }',
  '  return JSON.stringify({',
  '    tri:(html.match(/#f59e0b/g)||[]).length,',
  '    bal:cell("_balance"),',
  '    dq:cell("deliveredQty")',
  '  });',
  '})()',
].join('\n');

/**
 * 渲染库存管理页。
 * @param {Object} app 沙箱
 * @returns {{tri:number,bal:?string,dq:?string}} tri=整张表 #f59e0b 出现次数
 */
function renderInv(app) {
  const raw = app.run(RENDER_SCRIPT);
  assert.equal(typeof raw, 'string', 'renderInvOrders() 必须可求值（vm 内返回 JSON 字符串）');
  return JSON.parse(raw);
}

test('C1 渲染级：结余=0 且 stockMin>0 → 「结余」单元格必须含黄色三角 #f59e0b', function () {
  const app = boot({ orders: [mkInvOrder('KCDD-20261110-00001', [{ pid: 'PA', qty: 100, min: 50, dv: 0 }])] });
  try {
    const r = renderInv(app);
    assert.notEqual(r.bal, null, '「结余」列必须渲染出来（renderInvOrders 输出缺该 <td>）');
    assert.ok(r.bal.indexOf('#f59e0b') >= 0, '结余=0 且最小库存 50 → 黄色三角必须出现在「结余」单元格，实际：' + r.bal);
    /* 用户拍板第 1 点：已交付=0 同时<最小 50 → 「已交付」列也一起变黄（同一个 invStockLevel，不另开分支） */
    assert.notEqual(r.dq, null, '「已交付」列必须渲染出来');
    assert.ok(r.dq.indexOf('#f59e0b') >= 0, '「已交付」列（lvD）在 已交付=0 且最小>0 时也必须一起变黄，实际：' + r.dq);
    /* 两处三角（已交付 + 结余）即恰好 2 次；多于 2 次说明别处误加了黄标 */
    assert.equal(r.tri, 2, '整张表应恰有 2 个黄色三角（已交付 + 结余），实际 ' + r.tri);
  } finally { app.dispose(); }
});

test('C2 渲染级：结余=0 且 stockMin=0（不设限）→ 该行不得出现黄色三角', function () {
  const app = boot({ orders: [mkInvOrder('KCDD-20261110-00002', [{ pid: 'PB', qty: 100, min: 0, dv: 0 }])] });
  try {
    const r = renderInv(app);
    assert.notEqual(r.bal, null, '「结余」列必须渲染出来');
    assert.equal(r.bal.indexOf('#f59e0b'), -1, '最小库存=0 即不设限 → 结余 0 不得黄标，实际：' + r.bal);
    assert.equal(r.dq.indexOf('#f59e0b'), -1, '「已交付」列同样不得黄标（不设限），实际：' + r.dq);
    assert.equal(r.tri, 0, '整张表不应出现任何黄色三角，实际 ' + r.tri);
  } finally { app.dispose(); }
});

test('C3 渲染级对照：同一次渲染里「最小=50」行黄标、「最小=0」行不黄标（排除「整表统一着色」的假通过）', function () {
  const app = boot({
    orders: [
      mkInvOrder('KCDD-20261110-00003', [{ pid: 'PA', qty: 100, min: 50, dv: 0 }]),
      mkInvOrder('KCDD-20261110-00004', [{ pid: 'PB', qty: 100, min: 0, dv: 0 }]),
    ],
  });
  try {
    const r = renderInv(app);
    assert.equal(r.tri, 2, '两行中只有「最小=50」那一行该画 2 个黄三角，实际 ' + r.tri);
    const bals = r.bal === null ? [] : [r.bal];
    assert.ok(bals.length === 1, '「结余」列应至少渲染一行（本断言取第一行=最小 50 的那行）');
    assert.ok(bals[0].indexOf('#f59e0b') >= 0, '第一行（最小 50）必须黄标，实际：' + bals[0]);
  } finally { app.dispose(); }
});

/* ================================================================
   §D 单源守卫（不得出现第二份档位判定 / 旧口径残留）
   ================================================================ */

test('D1 档位判定全工程恰 1 处；旧口径片段 `num(v)>0&&min!=null` 零残留', function () {
  const plain = stripComments(INDEX_SRC);
  assert.equal((plain.match(/function\s+invStockLevel\s*\(/g) || []).length, 1,
    '档位判定只许有 invStockLevel 一个实现（严禁第二份）');
  assert.equal((plain.match(/return\s*'amber'/g) || []).length, 1,
    "「return 'amber'」只许由 invStockLevel 产出一次");
  assert.equal((plain.match(/return\s*'red'/g) || []).length, 1, "「return 'red'」只许一次");
  assert.equal((plain.match(/return\s*'gray'/g) || []).length, 1, "「return 'gray'」只许一次");
  assert.equal((plain.match(/return\s*'green'/g) || []).length, 1, "「return 'green'」只许一次");
  /* 新口径在场、旧口径清场（两条一起才说明「改对了」而不是「两套并存」） */
  assert.ok(plain.indexOf('num(v)>=0&&min!=null') >= 0, '新口径 num(v)>=0 必须存在');
  assert.equal(plain.indexOf('num(v)>0&&min!=null'), -1, '旧口径 num(v)>0 不得残留（否则 0 仍会落 green）');
  /* 「最小=0/空即不设限」守卫必须保留 */
  assert.ok(plain.indexOf('num(min)>0') >= 0, 'num(min)>0 守卫必须保留（不设限语义不可丢）');
});

test('D2 调用点形态未变：两列仍各自直接调 invStockLevel，不复制判据', function () {
  const rt = extractFn(INDEX_SRC, 'renderOrderTable');
  assert.ok(rt.indexOf('invStockLevel(dq,it.stockMin,it.stockMax)') >= 0,
    '「已交付」列必须仍直接调 invStockLevel(dq,it.stockMin,it.stockMax)');
  assert.ok(rt.indexOf('invStockLevel(balance,it.stockMin,it.stockMax)') >= 0,
    '「结余」列必须仍直接调 invStockLevel(balance,it.stockMin,it.stockMax)');
  /* 反假守卫：调用点若自己写了一套「=0 就 amber」的副本判定，这里必须报红 */
  assert.equal(/lv[DB]\s*=\s*[^;?]*===\s*0\s*\?/.test(rt), false,
    '调用点不得自行判定档位（必须全部来自 invStockLevel）');
});

/* ================================================================
   §E 判别力自证（变异注入）——证明 §A/§C 的核心断言真的会红
   ----------------------------------------------------------------
   做法：在**内存**里把源码副本的阈值改回旧口径（`num(v)>=0` → `num(v)>0`），
   用同一套断言去跑改造后的副本，必须得到「0 → green」。不落任何磁盘痕迹。
   ================================================================ */

const SNIP_FROM = 'num(v)>=0&&min!=null';
const SNIP_TO = 'num(v)>0&&min!=null';

/** 把 index.html 源码副本改成旧口径（命中数必须恰 1，否则抛错而非静默通过） */
function legacyIndexHtml(src) {
  const n = String(src).split(SNIP_FROM).length - 1;
  if (n !== 1) throw new Error('[变异注入失败] 旧口径改造锚点命中 ' + n + ' 处（必须恰 1 处）');
  const out = String(src).replace(SNIP_FROM, SNIP_TO);
  if (out === src) throw new Error('[变异注入失败] 旧口径改造后源码未变化');
  return out;
}

test('E1 变异：阈值改回 num(v)>0 → 0 落 green；渲染也不再黄标（证明 §A1/§C1 不是测了个寂寞）', function () {
  const mutantHtml = legacyIndexHtml(INDEX_SRC);
  /* ① 单元级：变异后核心断言必须翻转 */
  const m1 = boot({}, { indexHtml: mutantHtml });
  try {
    assert.equal(lv(m1, 0, 50, 100), 'green',
      '变异（旧口径）下 0 必须落 green —— 这正是用户报障的形态，说明 §A1 的 amber 断言有判别力');
  } finally { m1.dispose(); }
  /* ② 渲染级：变异后「结余=0 且最小>0」的行不得再有黄三角 */
  const m2 = boot({ orders: [mkInvOrder('KCDD-20261110-00009', [{ pid: 'PA', qty: 100, min: 50, dv: 0 }])] },
    { indexHtml: mutantHtml });
  try {
    const r = renderInv(m2);
    assert.notEqual(r.bal, null, '变异副本里「结余」列仍应渲染');
    assert.equal(r.bal.indexOf('#f59e0b'), -1,
      '变异（旧口径）下不得出现黄三角 —— 说明 §C1 的断言真的在守本次修复');
  } finally { m2.dispose(); }
});

/* ================================================================
   §F 版本派生守卫（不持字面量：全部从 tests/harness/build.js 派生）
   ================================================================ */

test('F1 本版水印与 harness.BUILD 一致；上一版任意形态零残留（纯派生，不写字面量）', function () {
  assert.equal((INDEX_SRC.match(build.buildMarkRe(build.BUILD)) || []).length, 1,
    'index.html 权威水印必须恰 1 处且等于 harness.BUILD');
  assert.equal((INDEX_SRC.match(build.buildAnyRe(build.PREV)) || []).length, 0,
    '上一版任意形态不得残留');
  /* 本文件守卫的这处改动必须在源码里留下本版短形态标记（只许 build .NNN，不许完整版本号） */
  const no = String(build.BUILD).split('.')[1];
  assert.ok(INDEX_SRC.indexOf('build .' + no) >= 0,
    '本次改动点必须留下【build .' + no + '】短形态标记（缺则说明注释没写或写成了完整版本号）');
});
