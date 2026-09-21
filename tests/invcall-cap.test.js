'use strict';
/* ================================================================
   tests/invcall-cap.test.js —— 「调用库存」剩余可调用量口径（2026-09-21.133 修正）
   ================================================================
   背景（用户报告的 Bug）：销售订单「调用库存」的数量上限未扣减「已调用 calledQty」，
   导致累计超调。实测订单 XSDD-20260919-00002（订单数量 38）：第一次调用 5 只 → calledQty=5；
   第二次弹窗点「按订单数量填充」填入 38（**应为 33**），确认被放行 → 累计 43 > 38。

   根因（.133 前）：调用侧上限沿用「未交付 = orderQty − deliveredQty」，未扣掉仍压在手上、
   已调用但还没发给客户的部分；而退回侧（.129）与交付侧（.108）早已按 saleMaxCallable 收敛。

   唯一正确口径（.133 用户拍板，对称口径）：
     可调用余量 = saleRemainCallable(it)
               = max(0, 未交付 − saleMaxCallable(it))
      其中 未交付 = max(0, orderQty − deliveredQty)
           saleMaxCallable(it) = max(0, calledQty − max(0, deliveredQty − directDelivered))（.108）
     语义 = 客户还要的（未交付） − 已调用但还没发出去的（在库未交付）。
   验证：orderQty=38 / deliveredQty=0 / calledQty=5 → 33 ✓；
         calledQty=45 → 0（已超调不可再调）；
         orderQty=38 / deliveredQty=20 / directDelivered=20 / calledQty=5 → 13 ✓。

   为什么值得单独钉死：
     · 这是**业务规则**，错了会放行累计超调（同一批货重复调用，订单被超额履行）。
     · 本项目**明令禁止口径双源**：调用弹窗三处填充 + 确认校验必须统一委托全局
       `saleRemainCallable`（定义在 index.html），transfer.js 不得复制公式——
       §S2 专门钉「委托 + 无副本」，§⑤ 用哨兵证明「换了全局函数会跟着变」。

   覆盖：① saleRemainCallable 纯函数三组边界（用户案例 33 / 超调归零 / 期初直接交付豁免 13）
         ② 静态守卫（三处 call 分支均委托 saleRemainCallable、无公式副本、退回分支仍 csReturnCap）
         ③ 单一来源（哨兵替换全局 saleMaxCallable）
   边界：**不仿真 DOM 弹窗**——`openCallStock`/`doCallStock` 读 `.cs-qty`/`.cs-inv-box` 表单输入，
         按 tests/README §6 属「不可测边界」（document.querySelectorAll 恒返回 []）；
         故仅做 ①②（对「它们共同依赖的那一个上限口径」做动态 + 源码静态双重钉死）。
   运行：node --test tests/invcall-cap.test.js（**不要用 node -e**，见 README）
   ================================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createApp } = require('./harness/sandbox');

const ROOT = path.join(__dirname, '..');
const SRC_TRANSFER = fs.readFileSync(path.join(ROOT, 'js', 'transfer.js'), 'utf8');
const SRC_INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/** 跨 realm 对象转成本 realm 纯对象（vm 返回的对象原型属于 vm realm） */
function plain(v) {
  return JSON.parse(JSON.stringify(v));
}

/* ---------- 源码函数抽取（花括号配平；测的就是源码里那段） ---------- */
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

/** 剔除注释后的正文（静态守卫用；避免注释里的口径算式造成误判） */
function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const FN = {
  saleRemainCallable: extractFn(SRC_INDEX, 'saleRemainCallable'),
  csWarn: extractFn(SRC_TRANSFER, 'csWarn'),
  csAutoFill: extractFn(SRC_TRANSFER, 'csAutoFill'),
  csFillByOrder: extractFn(SRC_TRANSFER, 'csFillByOrder'),
  openCallStock: extractFn(SRC_TRANSFER, 'openCallStock'),
  doCallStock: extractFn(SRC_TRANSFER, 'doCallStock'),
};

/* ================================================================
   夹具
   ================================================================ */

/** 与 `openCallStock` 里 lines 元素同形（.133 起携带 it:it item 引用） */
function lineOf(calledQty, deliveredQty, directDelivered, orderQty) {
  return {
    i: 0,
    it: { productId: 'P1', orderQty: orderQty, deliveredQty: deliveredQty, calledQty: calledQty, directDelivered: directDelivered },
    productId: 'P1', productName: '甲', spec: '', model: '',
    orderQty: orderQty, deliveredQty: deliveredQty,
  };
}

/** 只装载、不挂记录器的沙箱（口径类断言不需要写集记录） */
function app0() {
  return createApp({ installRecorder: false });
}

/* ================================================================
   ① 纯函数：用户案例（33）
   ================================================================ */

test('① 用户案例：orderQty=38 / deliveredQty=0 / calledQty=5 → 剩余可调用量 33（旧口径会填 38）', () => {
  const app = app0();
  app.setGlobal('__it', { productId: 'P1', orderQty: 38, deliveredQty: 0, calledQty: 5, directDelivered: 0 });
  assert.equal(app.run('saleRemainCallable(__it)'), 33, '未交付 38 − 已调用未发出 5 = 33');
  /* 反向对照：旧口径「未交付」在本场景 = 38 —— 正是把 38 放行、造成累计 43 > 38 的错误来源 */
  assert.equal(app.run('Math.max(0,num(__it.orderQty)-num(__it.deliveredQty))'), 38, '旧口径上限 = 未交付 = 38（Bug：超调）');
  assert.equal(app.run('saleRemainCallable(__it) < Math.max(0,num(__it.orderQty)-num(__it.deliveredQty))'), true, '新口径必须严于旧口径');
  app.dispose();
});

/* ================================================================
   ② 纯函数：超调归零
   ================================================================ */

test('② 超调归零：calledQty ≥ 未交付 → 剩余可调用量 = 0（已超调不可再调）', () => {
  const app = app0();
  app.setGlobal('__a', { orderQty: 38, deliveredQty: 0, calledQty: 45, directDelivered: 0 });
  assert.equal(app.run('saleRemainCallable(__a)'), 0, '已调用 45 > 未交付 38 → 0');
  app.setGlobal('__b', { orderQty: 38, deliveredQty: 0, calledQty: 38, directDelivered: 0 });
  assert.equal(app.run('saleRemainCallable(__b)'), 0, '恰好调用满 → 0');
  app.setGlobal('__c', { orderQty: 38, deliveredQty: 0, calledQty: 50, directDelivered: 0 });
  assert.equal(app.run('saleRemainCallable(__c)'), 0, '严重超调 → 0（不得为负）');
  /* 尚未调用满：仍留有余量 */
  app.setGlobal('__d', { orderQty: 38, deliveredQty: 0, calledQty: 33, directDelivered: 0 });
  assert.equal(app.run('saleRemainCallable(__d)'), 5, '已调用 33 → 还可调用 5');
  app.dispose();
});

/* ================================================================
   ③ 纯函数：期初直接交付豁免（13）
   ================================================================ */

test('③ 期初直接交付豁免：orderQty=38 / deliveredQty=20 / directDelivered=20 / calledQty=5 → 13', () => {
  const app = app0();
  app.setGlobal('__it', { orderQty: 38, deliveredQty: 20, directDelivered: 20, calledQty: 5 });
  /* 未交付 = 38 − 20 = 18；期初直接交付（.130 前金蝶/历史带入、无调用支撑）不占额度 → saleMaxCallable = 5；
     剩余可调用量 = 18 − 5 = 13 */
  assert.equal(app.run('saleRemainCallable(__it)'), 13, '18 − 5 = 13');
  assert.equal(app.run('saleMaxCallable(__it)'), 5, '与 .108 交付侧同源（期初基数豁免）');
  app.dispose();
});

/* ================================================================
   ④ 纯函数：边界样本（≥0 / 单调 / 与定义式恒等）
   ================================================================ */

test('④ 边界样本：恒 ≥0，随已调用单调不增，且与 max(0, 未交付 − saleMaxCallable) 恒等', () => {
  const app = app0();
  /* 随已调用单调不增：calledQty 越大，剩余可调用量越小（saleMaxCallable 单调不减） */
  const rems = [];
  for (let c = 0; c <= 40; c += 5) {
    app.setGlobal('__l', { orderQty: 38, deliveredQty: 0, calledQty: c, directDelivered: 0 });
    rems.push(app.run('saleRemainCallable(__l)'));
  }
  for (let i = 1; i < rems.length; i++) {
    assert.equal(rems[i] <= rems[i - 1], true, '已调用 ↑ 时剩余可调用量不得上升：' + rems);
  }
  assert.equal(rems[0], 38, '未调用 → 可调用 = 未交付 = 38');
  /* 固定样本集：恒等定义式 + 非负有限（含缺省字段 / 越界 / 负值 / 字符串，验证 num() 兜底） */
  const samples = [
    { orderQty: 38, deliveredQty: 0, calledQty: 5, directDelivered: 0 },
    { orderQty: 38, deliveredQty: 0, calledQty: 45, directDelivered: 0 },
    { orderQty: 38, deliveredQty: 20, directDelivered: 20, calledQty: 5 },
    { orderQty: 0, deliveredQty: 0, calledQty: 0, directDelivered: 0 },
    { orderQty: -5, deliveredQty: 3, calledQty: 2, directDelivered: 0 },
    { orderQty: 10, deliveredQty: -3, calledQty: 4, directDelivered: 0 },
    { orderQty: '38', deliveredQty: '', calledQty: '5', directDelivered: undefined },
    { orderQty: 38, deliveredQty: 20, calledQty: 5 },
    { orderQty: 1e9, deliveredQty: 0, calledQty: 1e9, directDelivered: 0 },
  ];
  app.setGlobal('__samples', samples);
  const got = plain(app.run('__samples.map(function(o){return saleRemainCallable(o);})'));
  const want = plain(
    app.run('__samples.map(function(o){return Math.max(0,Math.max(0,num(o.orderQty)-num(o.deliveredQty))-saleMaxCallable(o));})')
  );
  assert.equal(got.length, samples.length);
  got.forEach((v, k) => {
    assert.equal(Number.isFinite(v), true, '样本' + k + ' 必须有限（实际 ' + v + '）');
    assert.equal(v >= 0, true, '样本' + k + ' 不得为负（实际 ' + v + '）');
    assert.equal(v, want[k], '样本' + k + ' 必须恒等定义式（实际 ' + v + ' vs ' + want[k] + '）');
  });
  app.dispose();
});

/* ================================================================
   ⑤ 单一来源：委托全局 saleMaxCallable（未复制公式）
   ================================================================ */

test('⑤ 单一来源：把全局 saleMaxCallable 换成哨兵 → saleRemainCallable 必须跟着变', () => {
  const app = app0();
  app.setGlobal('__it', { orderQty: 38, deliveredQty: 0, calledQty: 0, directDelivered: 0 });
  assert.equal(app.run('saleRemainCallable(__it)'), 38, '前置：未调用 → 可调用 = 未交付 = 38');
  const orig = app.getGlobal('saleMaxCallable');
  assert.equal(typeof orig, 'function');
  app.setGlobal('saleMaxCallable', function () {
    return 7;
  });
  assert.equal(app.run('saleRemainCallable(__it)'), 31, '38 − 7 = 31（若自留副本则不会变）');
  app.setGlobal('saleMaxCallable', orig);
  assert.equal(app.run('saleRemainCallable(__it)'), 38, '还原全局口径后回到 38');
  app.dispose();
});

/* ================================================================
   §S 源码静态守卫（防回退 / 防口径双源）
   ================================================================ */

test('S1 transfer.js 三处 call 分支均委托 saleRemainCallable(line.it)，退回分支仍为 csReturnCap(line)', () => {
  [['csWarn', FN.csWarn], ['csAutoFill', FN.csAutoFill], ['csFillByOrder', FN.csFillByOrder]].forEach(([name, body]) => {
    assert.match(body, /__csMode\s*===\s*'call'\s*\?\s*saleRemainCallable\s*\(\s*line\.it\s*\)/, name + ' 的 call 分支须委托 saleRemainCallable(line.it)');
    assert.match(body, /:\s*csReturnCap\s*\(\s*line\s*\)/, name + ' 的退回分支必须原样保留 csReturnCap(line)');
    assert.doesNotMatch(body, /__csMode\s*===\s*'call'\s*\?\s*\(\s*line\.orderQty\s*-\s*line\.deliveredQty\s*\)/, name + ' 不得再内联旧调用上限算式');
  });
  /* .129 的退回三处入口守卫不被破坏（csReturnCap 仍在） */
  assert.match(FN.csWarn, /qinp\.max\s*=\s*max/, 'csWarn 仍写 qinp.max');
});

test('S2 调用侧无公式副本：transfer.js 不定义 saleRemainCallable，index.html 全工程仅定义一次', () => {
  const code = stripComments(SRC_TRANSFER);
  assert.doesNotMatch(code, /function\s+saleRemainCallable/, 'transfer.js 不得自带 saleRemainCallable 副本（口径单源）');
  assert.match(code, /saleRemainCallable\s*\(/, 'transfer.js 必须经由全局 saleRemainCallable 取口径');
  /* 旧式内联调用上限算式（含 orderQty 与 deliveredQty 相减）必须已从 call 分支移除 */
  assert.doesNotMatch(code, /__csMode\s*===\s*'call'\s*\?\s*\(?\s*line\.orderQty/, 'call 分支不得再出现 line.orderQty 内联算式');
  const defs = (SRC_INDEX.match(/function\s+saleRemainCallable\s*\(/g) || []).length;
  assert.equal(defs, 1, 'index.html 中 saleRemainCallable 必须恰好定义一次（实际 ' + defs + '）');
  assert.match(stripComments(SRC_INDEX), /function\s+saleRemainCallable\s*\(/, 'index.html 必须提供全局 saleRemainCallable');
});

test('S3 doCallStock 硬校验走 saleRemainCallable 且提示四数；openCallStock 过滤/行对象/说明已同步', () => {
  /* 确认校验：委托全局口径，不再以「销售未交付」为界 */
  assert.match(FN.doCallStock, /saleRemainCallable\s*\(\s*line\.it\s*\)/, '硬校验须委托 saleRemainCallable(line.it)');
  assert.doesNotMatch(FN.doCallStock, /q\s*>\s*undel/, '不得再以 undel 作上界');
  assert.doesNotMatch(FN.doCallStock, /超过销售未交付/, '不得残留旧口径提示文案');
  /* 提示带出四个数 */
  ['订单数量', '已交付', '已调用', '剩余可调用量'].forEach((kw) => {
    assert.match(FN.doCallStock, new RegExp(kw), 'doCallStock 提示应含「' + kw + '」');
  });
  /* 行过滤用 saleRemainCallable(it)>0；行对象携带 it 引用；弹窗说明写清上限口径 */
  assert.match(FN.openCallStock, /saleRemainCallable\s*\(\s*l\.it\s*\)\s*>\s*0/, '行过滤必须是 saleRemainCallable(l.it)>0');
  assert.match(FN.openCallStock, /it\s*:\s*it/, '行对象应携带 item 引用（it:it）');
  assert.match(FN.openCallStock, /剩余可调用量/, '弹窗说明应写清「剩余可调用量」口径');
  /* 行提示补「已调用 … · 可调用 …」三个数（与 .129 退回行提示风格一致） */
  assert.match(FN.openCallStock, /已调用/, 'openCallStock 行提示应含「已调用」');
  assert.match(FN.openCallStock, /可调用/, 'openCallStock 行提示应含「可调用」');
  /* 退回侧行对象构造（openReturnStock）不受影响：仍带 calledQty/directDelivered 且以 csReturnCap 过滤 */
  const openReturn = extractFn(SRC_TRANSFER, 'openReturnStock');
  assert.match(openReturn, /csReturnCap\s*\(\s*l\s*\)\s*>\s*0/, 'openReturnStock 过滤仍为 csReturnCap(l)>0（未被本次改动波及）');
});
