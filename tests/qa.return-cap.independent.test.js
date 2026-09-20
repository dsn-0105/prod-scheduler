'use strict';
/* ================================================================
   tests/qa.return-cap.independent.test.js
   —— 「退回库存」上限口径（2026-09-20.129）**QA 独立回归用例**
   ================================================================
   立场：本文件由 QA（Edward）在对工程师 `transfer.return-cap.test.js` 的**同一修复**
   做独立验收时另写，刻意选取**与之正交**的角度，避免「同一份用例自己证明自己」：

     §A 动态口径（沙箱装载**生产函数**执行）
        A1 真实线上错退现场的**精确形态**（来自只读快照，见下）——旧口径放行、新口径拦截
        A2 饱和性/幂等性：退回 cap 后 cap 必须为 0，再退 1 台在正确口径下无空间
        A3 cap 只依赖销售行四值（与目标库存行/料号无关）——跨料号退回不得改变上限
        A4 单调性与边界：随 已调用 单调不减；随「超出期初基数的已交付」单调不增
        A5 `directDelivered` 字段**缺省/空串/undefined** 时退化为 .100 公式（旧销售行普遍无该字段）
     §B 源码静态守卫（防"改回去"与"口径双源"）
        B1 `doReturnStock` 硬校验必须走 `csReturnCap`，不得残留「超过销售已交付」旧提示
        B2 `openReturnStock` 行过滤必须是 `csReturnCap(l)>0`，不得是 `l.deliveredQty>0`
        B3 `csReturnCap` 函数体必须**只**委托 `saleMaxCallable`（不得内联公式）
        B4 `js/transfer.js` 不得出现 `calledQty` 的公式副本（口径单源硬约束）
        B5 退回三处 UI 入口（csWarn 的 max / csAutoFill 的 cap / csFillByOrder 的 cap）都用 `csReturnCap`
        B6 **调用（call）分支不得被本次修复波及**：仍为 `line.orderQty - line.deliveredQty`
     §C 既有行为回归（修复不得破坏）
        C1 `applyTransfers('return')`：销售侧 `max(0, called − q)`、库存侧 `deliveredQty += q`（可负）
        C2 `applyTransfers('call')`：销售侧 `calledQty += q`、库存侧 `deliveredQty −= q`
        C3 `trRevType` 反向映射不变（call↔return）
        C4 一次业务动作 = 一次 `DB.tx`

   真实线上错退现场（只读快照 line-data-snap-20260920.json，2026-09-20 10:35）：
     销售行 XSDD-20260918-00002 行0：orderQty=1 / calledQty=0 / deliveredQty=1 / directDelivered=1
     两条 type=return 台账（TR1789871065432-0 qty=1、TR1789871072779-0 qty=1）在 calledQty=0 时被写入，
     销售侧被 `Math.max(0,…)` 静默吞掉 → 该行 calledQty 最终虚增 +2（A1 即钉死这个形态不被再放行）。

   运行：node --test tests/qa.return-cap.independent.test.js   （**不要用 node -e**，见 tests/README）
   ================================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createApp } = require('./harness/sandbox');

const ROOT = path.join(__dirname, '..');
const SRC_TRANSFER = fs.readFileSync(path.join(ROOT, 'js', 'transfer.js'), 'utf8');
const SRC_INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/** 跨 realm 对象 → 本 realm 纯对象 */
function plain(v) {
  return JSON.parse(JSON.stringify(v));
}

/* ---------- 源码函数抽取（花括号配平；不手写字段名/公式，保证"测的就是源码里那段"） ---------- */
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

const FN = {
  csReturnCap: extractFn(SRC_TRANSFER, 'csReturnCap'),
  csWarn: extractFn(SRC_TRANSFER, 'csWarn'),
  csAutoFill: extractFn(SRC_TRANSFER, 'csAutoFill'),
  csFillByOrder: extractFn(SRC_TRANSFER, 'csFillByOrder'),
  openReturnStock: extractFn(SRC_TRANSFER, 'openReturnStock'),
  doReturnStock: extractFn(SRC_TRANSFER, 'doReturnStock'),
  saleMaxCallable: extractFn(SRC_INDEX, 'saleMaxCallable'),
};

/* ================================================================
   夹具
   ================================================================ */

const ADMIN = { username: 'qa', name: 'QA爱德华', role: 'admin', perms: {} };

/** 与 openReturnStock 里 lines 元素同形（.129 起带 calledQty/directDelivered） */
function lineOf(calledQty, deliveredQty, directDelivered) {
  return {
    i: 0, productId: 'P1', productName: '甲', spec: '', model: '',
    orderQty: 100, deliveredQty: deliveredQty, calledQty: calledQty, directDelivered: directDelivered,
  };
}

function fixtureOrders(calledQty, deliveredQty, directDelivered) {
  return [
    {
      id: 'O-INV', orderType: '库存订单', customer: '成品仓', contractNo: '', status: '执行中',
      items: [{ productId: 'P1', productName: '甲', spec: '', model: '', orderQty: 100, deliveredQty: 10, stockMax: '', stockMin: '' }],
    },
    {
      id: 'O-SALE', orderType: '销售订单', customer: '华东盘厂', contractNo: 'HT1', status: '执行中',
      items: [{ productId: 'P1', productName: '甲', spec: '', model: '', orderQty: 100, deliveredQty, calledQty, directDelivered }],
    },
  ];
}

function recApp(calledQty, deliveredQty, directDelivered) {
  const app = createApp({ installRecorder: true });
  app.setGlobals({
    currentUser: ADMIN,
    orders: fixtureOrders(calledQty, deliveredQty, directDelivered),
    products: [{ id: 'P1', name: '甲', spec: '', model: '', unit: '台', stock: 10, dailyCap: 0, status: '启用' }],
    transfers: [], productionPlans: [], productionReports: [], processTemplates: [], deliveries: [], logs: [],
    renderContent: function () {}, renderAll: function () {},
  });
  return app;
}

/** 口径类断言用（不需要写集记录） */
function app0() {
  return createApp({ installRecorder: false });
}

/* ================================================================
   §A 动态口径
   ================================================================ */

test('A1 真实线上错退现场形态：calledQty=0/已交付=1/期初=1 → 可退=0（旧口径会放行 1 台）', () => {
  const app = app0();
  /* 快照 line-data-snap-20260920.json：XSDD-20260918-00002 行0 四值 */
  app.setGlobal('__bug', lineOf(0, 1, 1));
  assert.equal(app.run('csReturnCap(__bug)'), 0, '新口径：已调用 0 → 可退回量必为 0（与已交付取值无关）');
  assert.equal(app.run('saleMaxCallable(__bug)'), 0, '与全局 .108 交付口径同源恒等');
  /* 旧口径 = 已交付 = 1：正是这条把 1 台放行、进而在销售侧被 Math.max(0,…) 吞掉 */
  assert.equal(app.run('num(__bug.deliveredQty)'), 1, '旧口径上限 = 已交付 = 1（Bug 现场：放行了 1 台）');
  assert.equal(app.run('csReturnCap(__bug) < num(__bug.deliveredQty)'), true, '新口径必须严于旧口径');
  app.dispose();
});

test('A2 饱和性：退回 cap 后台账口径归 0，再退 1 台无空间（不应被任何入口放行）', async () => {
  const app = recApp(10, 4, 0);
  const cap = await app.run('csReturnCap(orders[1].items[0])');
  assert.equal(cap, 6, '前置 cap = 10 − 4 = 6');
  const moves = [{ out: { orderId: 'O-SALE', orderType: 'sales', lineIdx: 0 }, in: { orderId: 'O-INV', orderType: 'inv', lineIdx: 0 }, qty: cap }];
  assert.equal(await app.run('applyTransfers("return",' + JSON.stringify(moves) + ')'), true, '整批落盘');
  assert.equal(await app.run('csReturnCap(orders[1].items[0])'), 0, '退满后 cap 饱和为 0');
  /* 此时若再退 1 台：D2 的"数据不变量"必须已无空间（已交付−期初 ≤ 已调用 取等号） */
  assert.equal(await app.run('saleMaxCallable(orders[1].items[0])'), 0, '再无可退（幂等饱和）');
  assert.equal(
    await app.run('Math.max(0,num(orders[1].items[0].deliveredQty)-num(orders[1].items[0].directDelivered))<=num(orders[1].items[0].calledQty)'),
    true,
    '不变量取等号，未被推坏'
  );
  app.dispose();
});

test('A3 cap 只由销售行四值决定：目标库存行/料号/可用量变化不得改变上限', () => {
  const app = app0();
  app.setGlobal('__line', lineOf(7, 2, 0));
  const base = app.run('csReturnCap(__line)');
  assert.equal(base, 5, '前置 cap = 7 − 2 = 5');
  /* 同一销售行对象、换一个"库存侧上下文"，cap 必须不变（口径与调入方无关） */
  app.setGlobal('__invLine', { productId: 'P9', orderQty: 999, deliveredQty: -123 });
  assert.equal(app.run('csReturnCap(__line)'), base, '换库存行后 cap 不变');
  app.setGlobal('__line2', lineOf(7, 2, 0));
  assert.equal(app.run('csReturnCap(__line2)'), base, '同值新对象 cap 不变（纯函数、无隐藏状态）');
  app.dispose();
});

test('A4 单调性与边界：随已调用单调不减、随"超出期初的已交付"单调不增、恒 ≥ 0', () => {
  const app = app0();
  const caps = [];
  for (let c = 0; c <= 12; c++) {
    app.setGlobal('__l', lineOf(c, 4, 0));
    caps.push(app.run('csReturnCap(__l)'));
  }
  for (let i = 1; i < caps.length; i++) {
    assert.equal(caps[i] >= caps[i - 1], true, '已调用 ↑ 时 cap 不得下降：' + caps);
  }
  assert.equal(caps[0], 0, '已调用 0 → cap 0');
  assert.equal(caps[12], 8, '已调用 12/已交付 4 → cap 8');

  const caps2 = [];
  for (let d = 0; d <= 12; d++) {
    app.setGlobal('__l', lineOf(10, d, 0));
    caps2.push(app.run('csReturnCap(__l)'));
  }
  for (let i = 1; i < caps2.length; i++) {
    assert.equal(caps2[i] <= caps2[i - 1], true, '超额已交付 ↑ 时 cap 不得上升：' + caps2);
  }
  caps2.concat(caps).forEach((v, k) => assert.equal(v >= 0, true, '样本' + k + ' 不得为负'));
  app.dispose();
});

test('A5 directDelivered 缺省/空串/undefined → 退化为 .100 公式（旧销售行普遍无该字段）', () => {
  const app = app0();
  const cases = [
    ['{calledQty:3,deliveredQty:10}', 0, '字段整体缺失：max(0,10−0)=10 > 3 → 0'],
    ['{calledQty:10,deliveredQty:4,directDelivered:undefined}', 6, 'undefined → num()=0'],
    ['{calledQty:10,deliveredQty:4,directDelivered:""}', 6, '空串 → num()=0'],
    ['{calledQty:10,deliveredQty:4,directDelivered:null}', 6, 'null → num()=0'],
    ['{calledQty:10,deliveredQty:4,directDelivered:"2"}', 8, '字符串数字 → 10−max(0,4−2)=8'],
  ];
  cases.forEach(([expr, want, msg]) => {
    assert.equal(app.run('csReturnCap(' + expr + ')'), want, msg);
    assert.equal(app.run('saleMaxCallable(' + expr + ')'), want, msg + '（与全局口径一致）');
  });
  app.dispose();
});

test('A6 固定样本集：csReturnCap 与 saleMaxCallable 逐例恒等且均为有限数字', () => {
  const app = app0();
  const samples = [
    [0, 0, 0], [10, 0, 0], [10, 0, 5], [3, 10, 0], [3, 10, 8], [0, 5, 5],
    [-5, 3, 0], [5, -3, 0], [-1, -1, -1], [0.5, 0.25, 0], [1e9, 0, 0],
    ['abc', 'x', 'y'], [null, null, null], [undefined, undefined, undefined], [7, 7, 7],
  ];
  app.setGlobal('__samples', samples.map(s => lineOf(s[0], s[1], s[2])));
  const a = plain(app.run('__samples.map(function(l){return csReturnCap(l);})'));
  const b = plain(app.run('__samples.map(function(l){return saleMaxCallable(l);})'));
  assert.equal(a.length, samples.length);
  a.forEach((v, k) => {
    assert.equal(Object.is(v, b[k]), true, '样本' + k + ' csReturnCap 必须恒等 saleMaxCallable');
    assert.equal(Number.isFinite(v), true, '样本' + k + ' 必须是有限数字（实际 ' + v + '）');
    assert.equal(v >= 0, true, '样本' + k + ' 不得为负（实际 ' + v + '）');
  });
  app.dispose();
});

/* ================================================================
   §B 源码静态守卫（防回退 / 防口径双源）
   ================================================================ */

test('B1 doReturnStock 硬校验走 csReturnCap，且不残留"超过销售已交付"旧提示', () => {
  const body = FN.doReturnStock;
  assert.match(body, /csReturnCap\s*\(/, '硬校验必须调用 csReturnCap');
  assert.match(body, /q\s*>\s*cap/, '必须以 cap 做上界比较');
  assert.doesNotMatch(body, /超过销售已交付/, '不得残留旧口径提示文案');
  assert.doesNotMatch(body, /q\s*>\s*line\.deliveredQty/, '不得再以 line.deliveredQty 作为上界');
});

test('B2 openReturnStock 行过滤用 csReturnCap>0，不再用 deliveredQty>0', () => {
  const body = FN.openReturnStock;
  assert.match(body, /csReturnCap\s*\(\s*l\s*\)\s*>\s*0/, '行过滤必须是 csReturnCap(l)>0');
  assert.doesNotMatch(body, /l\.deliveredQty\s*>\s*0/, '不得再按 deliveredQty>0 过滤');
  /* 行上限与提示也应带四值（可复核的用户可见口径） */
  assert.match(body, /csReturnCap\s*\(\s*l\s*\)/, '行 input max / 提示应使用 csReturnCap');
  assert.match(body, /可退/, 'UI 文案应体现"可退"口径');
});

test('B3 csReturnCap 函数体只委托全局 saleMaxCallable（不得内联公式副本）', () => {
  const body = FN.csReturnCap.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.match(body, /return\s+saleMaxCallable\s*\(/, '必须 return saleMaxCallable(...)');
  assert.doesNotMatch(body, /calledQty/, '不得在本地出现 calledQty（即不得复制公式）');
  assert.doesNotMatch(body, /deliveredQty/, '不得在本地出现 deliveredQty');
  assert.doesNotMatch(body, /directDelivered/, '不得在本地出现 directDelivered');
});

test('B4 js/transfer.js 内不得出现"退回上限"公式副本（口径单源硬约束）', () => {
  /* 剔除注释后，逐行检查「calledQty 与 deliveredQty 之间存在减号」这种**公式形态**。
     注意：UI 文案行里两者相邻出现是合法的（'…已调用 '+l.calledQty+' · 已交付 '+l.deliveredQty），
     其中间只有字符串拼接、**不含减号**；而复制公式必然写成 `calledQty - … - deliveredQty`。 */
  const code = SRC_TRANSFER.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(code, /calledQty[^\n]{0,60}-[^\n]{0,60}deliveredQty/, '不得复制 calledQty − deliveredQty 形式的退回上限公式');
  assert.doesNotMatch(code, /deliveredQty[^\n]{0,60}-[^\n]{0,60}calledQty/, '不得复制 deliveredQty − calledQty 形式的退回上限公式');
  assert.match(code, /saleMaxCallable\s*\(/, 'transfer.js 必须经由全局 saleMaxCallable 取得口径');
});

test('B5 退回三处 UI 入口（csWarn.max / csAutoFill.cap / csFillByOrder.cap）均用 csReturnCap', () => {
  assert.match(FN.csWarn, /qinp\.max\s*=\s*max/, 'csWarn 仍写 qinp.max');
  assert.match(FN.csWarn, /csReturnCap\s*\(\s*line\s*\)/, 'csWarn 的退回分支必须用 csReturnCap(line)');
  assert.match(FN.csAutoFill, /csReturnCap\s*\(\s*line\s*\)/, 'csAutoFill 的退回分支必须用 csReturnCap(line)');
  assert.match(FN.csFillByOrder, /csReturnCap\s*\(\s*line\s*\)/, 'csFillByOrder 的退回分支必须用 csReturnCap(line)');
  [FN.csWarn, FN.csAutoFill, FN.csFillByOrder].forEach((b, k) => {
    assert.doesNotMatch(b, /:\s*line\.deliveredQty/, '第' + k + ' 处不得再以 line.deliveredQty 作为退回上限');
  });
});

test('B6 调用（call）分支不得被本次修复波及：仍为 orderQty − deliveredQty', () => {
  assert.match(FN.csWarn, /__csMode\s*===\s*'call'\s*\?\s*\(\s*line\.orderQty\s*-\s*line\.deliveredQty\s*\)/, 'csWarn 的 call 分支保持原式');
  assert.match(FN.csAutoFill, /__csMode\s*===\s*'call'\s*\?\s*\(\s*line\.orderQty\s*-\s*line\.deliveredQty\s*\)/, 'csAutoFill 的 call 分支保持原式');
  assert.match(FN.csFillByOrder, /__csMode\s*===\s*'call'\s*\?\s*\(\s*line\.orderQty\s*-\s*line\.deliveredQty\s*\)/, 'csFillByOrder 的 call 分支保持原式');
  assert.match(FN.doReturnStock, /applyTransfers\s*\(\s*'return'/, '退回仍以 return 类型落盘');
});

/* ================================================================
   §C 既有行为回归
   ================================================================ */

test('C1 applyTransfers("return")：销售侧 max(0,called−q)、库存侧 += q（可负）', async () => {
  /* 超量退回（q > called）——口径层不应再出现，但**底层语义**（下限 0）必须保持原样，
     否则会改变历史数据解释口径；此处只钉"底层语义未变"。 */
  const app = recApp(3, 10, 0);
  const moves = [{ out: { orderId: 'O-SALE', orderType: 'sales', lineIdx: 0 }, in: { orderId: 'O-INV', orderType: 'inv', lineIdx: 0 }, qty: 5 }];
  assert.equal(await app.run('applyTransfers("return",' + JSON.stringify(moves) + ')'), true);
  assert.equal(await app.run('orders[1].items[0].calledQty'), 0, '销售侧 3 − 5 → 下限 0（Math.max 语义不变）');
  assert.equal(await app.run('orders[1].items[0].deliveredQty'), 10, '退回不动销售已交付（.97 口径不变）');
  assert.equal(await app.run('orders[0].items[0].deliveredQty'), 15, '库存侧全额 +5（无上限）');
  /* 库存侧允许负（欠货）语义 */
  const app2 = recApp(3, 10, 0);
  await app2.run('orders[0].items[0].deliveredQty=-2');
  const mv2 = [{ out: { orderId: 'O-SALE', orderType: 'sales', lineIdx: 0 }, in: { orderId: 'O-INV', orderType: 'inv', lineIdx: 0 }, qty: 7 }];
  assert.equal(await app2.run('applyTransfers("return",' + JSON.stringify(mv2) + ')'), true);
  assert.equal(await app2.run('orders[0].items[0].deliveredQty'), 5, '库存侧无上下限（−2 + 7 = 5）');
  app.dispose(); app2.dispose();
});

test('C2 applyTransfers("call")：销售侧 += q、库存侧 −= q（行为不变）', async () => {
  const app = recApp(2, 4, 0);
  const moves = [{ out: { orderId: 'O-INV', orderType: 'inv', lineIdx: 0 }, in: { orderId: 'O-SALE', orderType: 'sales', lineIdx: 0 }, qty: 3 }];
  assert.equal(await app.run('applyTransfers("call",' + JSON.stringify(moves) + ')'), true);
  assert.equal(await app.run('orders[1].items[0].calledQty'), 5, '销售侧 2 + 3');
  assert.equal(await app.run('orders[0].items[0].deliveredQty'), 7, '库存侧 10 − 3');
  assert.equal(await app.run('orders[1].items[0].deliveredQty'), 4, '调用不动销售已交付');
  app.dispose();
});

test('C3 trRevType 冲销反向映射不变（call↔return / conv↔conv_back / move↔move_back）', () => {
  const app = app0();
  assert.equal(app.run('trRevType("call")'), 'return');
  assert.equal(app.run('trRevType("return")'), 'call');
  assert.equal(app.run('trRevType("conv")'), 'conv_back');
  assert.equal(app.run('trRevType("conv_back")'), 'conv');
  assert.equal(app.run('trRevType("move")'), 'move_back');
  assert.equal(app.run('trRevType("move_back")'), 'move');
  assert.equal(app.run('trRevType("nope")'), null);
  app.dispose();
});

test('C4 一次退回业务动作 = 一次 DB.tx，写集含 orders/transfers', async () => {
  const app = recApp(10, 4, 0);
  const moves = [{ out: { orderId: 'O-SALE', orderType: 'sales', lineIdx: 0 }, in: { orderId: 'O-INV', orderType: 'inv', lineIdx: 0 }, qty: 6 }];
  assert.equal(await app.run('applyTransfers("return",' + JSON.stringify(moves) + ')'), true);
  assert.equal(app.recorder.txCount(), 1, '恰好一次 /api/tx');
  const keys = plain(app.recorder.lastTx().keys);
  assert.equal(keys.includes('orders'), true, '写集含 orders：' + JSON.stringify(keys));
  assert.equal(keys.includes('transfers'), true, '写集含 transfers：' + JSON.stringify(keys));
  app.dispose();
});
