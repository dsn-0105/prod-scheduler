'use strict';
/* ================================================================
   tests/qa.invfilt.161.independent.test.js
   —— QA 独立回归：库存管理「结余进度」列语义筛选（本版 build）
   ================================================================
   定位：**独立复验**，不是 tests/invfilt.161.test.js 的复读机。
     · 不复用工程师的断言写法与数据构造：本文件自带行工厂 / 面板解析器 / 变异注入钩子；
     · 不采信其自述用例数，本文件独立给出自己的用例集；
     · 首选**差分**（上一版修订 vs 当前）与**变异注入**（改坏 → 守卫必须变红）作为判据，
       而不是「读源码里有没有某段字符串」这类易退化为恒真的写法。

   断言标记（.152 教训：把缺陷断言成正确行为最危险）：
     【契约】  = 断言需求/设计规定的行为，源码若不符 → 产品缺陷（应回退工程师）
     【现状】  = 断言**当前实现的实际行为**（可能是已知折衷），用于把折衷钉死、防悄悄改变，
                 不表示该行为就是理想行为。本文件仅在 §I 使用，逐条标注。
                （.162 起 §I 的已知折衷已修复，三条断言全部翻转为【契约】——见 §I 注释。）

   基线纪律（.152 教训：基线用 HEAD 会与自身对消）：
     · 上一版 index.html 由 **git 提交主题**反查修订号后 `git show <rev>:index.html` 取得，
       **不用 HEAD 当基线**，并带两条防抵消守卫：
         ① 两版 index.html 全文 md5 必须不同；
         ② 提取器必须对修订敏感（本版改动过的 thCol / applyFilt 两版必须不同，而 invStockLevel 必须相同）。
     · 与 §D3（qa.parts-ledger.validate.159）的「禁止持有版本字面量」兼容：
       本文件代码里**不写**完整版本号字面量，一律 `build.BUILD` / `build.PREV` 派生。

   ⚠️ 必须用文件方式运行：node --test tests/qa.invfilt.161.independent.test.js
      （勿用 node -e，见 tests/README §1：eval 宿主 realm 下 vm 内字符串会被破坏）

   §A 契约：语义档定义 / 单源红线 / invStockLevel 未改动
   §B 引擎：语义模式不得被静默跳过（反假守卫）
   §C 口径 A 的三类边界（含 .160 闭区间下界）
   §D 面板：选项、data-noval、fpModeChange 等价重构
   §E 日期列不被污染（fp_drange 双日期面板）
   §F 筛选条 chip 与清除全部
   §G 其他模块零回归（4 模块 × 筛选/排序/面板 全差分）
   §H 版本水印锚点（含「第 9 处」必要性裁决）
   §I applyFilt 残留值 / thCol 漏斗点亮（.161 为【现状】折衷与缺陷，.162 修复后翻转为【契约】）
   §J 变异注入：7 条，每条硬约束「锚点命中数恰 1」+「注入必须生效」
================================================================ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const { createApp, ROOT } = require('./harness/sandbox');
const build = require('./harness/build');

/* ================================================================
   §0 基础设施（本文件自带，不复用工程师测试文件的任何 helper）
================================================================ */

const readRel = function (rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); };
const md5 = function (s) { return crypto.createHash('md5').update(String(s), 'utf8').digest('hex'); };
const countOcc = function (hay, needle) { return String(hay).split(String(needle)).length - 1; };
const escRe = function (s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };

/** 去掉块注释与行注释（只用于「静态形态」判据；不影响运行时行为） */
function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** 按大括号配平提取函数源码（只认 `function name(` 形态；取不到必须报错，不得静默返回空） */
function extractFn(src, name) {
  const re = new RegExp('function\\s+' + escRe(name) + '\\s*\\(', 'g');
  const m = re.exec(src);
  if (!m) throw new Error('[QA] 源码中未找到函数 ' + name + '（提取器失效，禁止静默通过）');
  let p = src.indexOf('(', m.index);
  let d = 0;
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
  const out = src.slice(m.index, j + 1);
  if (out.length < 20) throw new Error('[QA] 函数 ' + name + ' 提取结果异常短（' + out.length + ' 字符），提取器失效');
  return out;
}

/* ---------- git 作为独立来源（权威指纹 / 修订反查） ---------- */

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    throw new Error('[QA] git 调用失败（本文件的指纹判据依赖 git，禁止降级为"跳过"）：' +
      args.join(' ') + ' → ' + String(e.message).slice(0, 200));
  }
}

/** 取某修订下的文件内容 */
function gitShow(rev, rel) { return git(['show', rev + ':' + rel]); }

/** 按提交**主题**反查「build <版本>」的修订号（不读 index.html，避免自我循环） */
function revOfBuild(ver) {
  const out = git(['log', '--format=%H%x09%s', '-n', '600']);
  const hits = out.split('\n').filter(function (l) {
    const s = l.indexOf('\t') >= 0 ? l.slice(l.indexOf('\t') + 1) : '';
    return s.indexOf('build ' + ver) === 0;
  });
  const revs = hits.map(function (l) { return l.slice(0, l.indexOf('\t')); });
  assert.equal(revs.length >= 1, true,
    '必须在提交主题中反查到 build ' + ver + ' 的修订（否则基线无法定位，判据不得静默跳过）');
  return revs[0]; /* 最新一条 */
}

const INDEX_SRC = readRel('index.html');
const HEAD = git(['rev-parse', 'HEAD']).trim();
const PREV_REV = revOfBuild(build.PREV);
const PREV_INDEX_SRC = gitShow(PREV_REV, 'index.html');
/* 【.163 同步·固定历史基线】下面 A4 的「提取器对修订敏感」探针需要一个**确实与相邻版不同**的参考系。
   原写法拿 build.PREV 当参考系，会随版本推进漂移：.163 没有改动 thCol / applyFilt ⇒ 与 .162 逐字相同，
   notEqual 恒红。故固定钉住 .161（.162 相对它确实改过这两个函数）——
   .161/.162 两个修订是**不可变历史**，往后任何版本推进都不会让这条探针失效，判别力一点没减。 */
const B161_REV = revOfBuild('2026-11-20.161');
const B161_INDEX_SRC = gitShow(B161_REV, 'index.html');

/* ---------- 沙箱装载 ---------- */

function boot(extra) {
  return createApp(Object.assign({ installRecorder: false, quietConsole: true }, extra || {}));
}

/* 固定种子数据（两版装载必须用**同一份**，否则差分无意义）。每次深拷贝，避免跨 app 串味。 */
const SEED = {
  products: [
    { id: 'P1', code: 'P1', name: '产品甲', model: 'M-甲', spec: 'S-甲', unit: '台', dailyCap: 10, stockQty: 5 },
    { id: 'P2', code: 'P2', name: '产品乙', model: 'M-乙', spec: 'S-乙', unit: '台', dailyCap: 20, stockQty: 0 },
    { id: 'P3', code: 'P3', name: '产品丙', model: '', spec: '', unit: '台', dailyCap: 0, stockQty: 7 }
  ],
  parts: [
    { id: 'A1', code: 'A1', name: '零件甲', spec: 's1', model: 'm1', unit: '个', stockMax: 100, stockMin: 10, stockQty: 50, takenQty: 0 },
    { id: 'A2', code: 'A2', name: '零件乙', spec: 's2', model: 'm2', unit: '个', stockMax: 0, stockMin: 0, stockQty: 0, takenQty: 0 }
  ],
  deliveries: [
    {
      id: 'D1', planNo: 'JFJH-20261120-00001', orderId: 'KC1', customer: '客户甲',
      createdAt: '2026-11-20', items: [{ orderLine: 0, productId: 'P1', productName: '产品甲', planQty: 50 }]
    }
  ]
};
const clone = function (v) { return JSON.parse(JSON.stringify(v)); };

/** 装载并注册 5 个真实模块的列定义（order_frame / order_inv / product / parts / delivery） */
function bootAll(extra) {
  const app = boot(extra);
  app.setGlobal('products', clone(SEED.products));
  app.setGlobal('parts', clone(SEED.parts));
  app.setGlobal('deliveries', clone(SEED.deliveries));
  app.run("renderProducts();renderParts();renderDelivery();" +
    "renderOrderTable('order_frame',[],{});renderOrderTable('order_inv',[],{});");
  return app;
}

/** 只注册 order_inv（多数语义筛选用例只需它） */
function bootInv(extra) {
  const app = boot(extra);
  app.run("renderOrderTable('order_inv',[],{});");
  return app;
}

/* ---------- 行工厂 / 筛选驱动 ---------- */

/** 造一行 order_inv 行模型（renderOrderTable 的行结构：{order,item,orderIdx,__li}） */
function invRow(id, item, li) {
  return {
    order: { id: id, orderType: '库存订单', customer: '客户' + id, startDate: '2026-11-01', status: '已完成' },
    item: Object.assign({ productId: 'PX', productName: '商品X', lineNotes: '' }, item),
    __li: li == null ? 0 : li
  };
}

/** 设置筛选态并跑 filterRows；rows 经沙箱中转（保证跨 realm 取值一致） */
function runFilter(app, m, rows, filters) {
  app.sandbox.__qaRows = rows;
  app.sandbox.__qaFilt = filters || {};
  try {
    return app.run('tState(' + JSON.stringify(m) + ').filters = __qaFilt;' +
      'filterRows(' + JSON.stringify(m) + ',__qaRows);');
  } finally {
    delete app.sandbox.__qaRows;
    delete app.sandbox.__qaFilt;
  }
}

/** filterRows 结果 → 稳定 id 序列（行模型不同模块取不同投影） */
function idsOf(res, proj) {
  return Array.prototype.map.call(res, proj || function (r) { return r.order.id; });
}

/** order_inv 语义模式的命中 id 集合 */
function semHitIds(app, rows, mode) {
  const f = {};
  f._balPct = { mode: mode, val: '' };
  return idsOf(runFilter(app, 'order_inv', rows, f));
}

/** 独立口径实现（不复用产品代码）：结余 = 已交付(无 pu 时) → 档位 → 红/黄 / 灰 */
function expectShort(bal, min, max) {
  const v = Number(bal), mn = Number(min == null || min === '' ? 0 : min), mx = Number(max == null || max === '' ? 0 : max);
  if (v < 0) return true;                                      /* red */
  if (v >= 0 && String(min) !== '' && mn > 0 && v < mn) return true; /* amber */
  return false;
}
function expectOver(bal, min, max) {
  const v = Number(bal), mx = Number(max == null || max === '' ? 0 : max);
  return String(max) !== '' && mx > 0 && v > mx;
}

/* ---------- 面板解析（独立解析器，不复用产品代码的拼串） ---------- */

/** 打开某列筛选面板，回传面板 innerHTML（沙箱 document 为 DOM 桩，openFilter 可求值） */
function panelHtml(app, m, key) {
  return app.run('(function(){var el=document.createElement("i");' +
    'el.getBoundingClientRect=function(){return {left:10,right:40,top:10,bottom:20,width:30,height:10};};' +
    'openFilter(el,' + JSON.stringify(m) + ',' + JSON.stringify(key) + ');' +
    'return filtPop?filtPop.innerHTML:"";})()');
}

/** 解析面板里的 <option>（value / data-noval / selected / 文案） */
function parseOptions(html) {
  const re = /<option value="([^"]*)"( data-noval="1")?( selected)?\s*>([^<]*)<\/option>/g;
  const out = [];
  let m;
  while ((m = re.exec(String(html))) !== null) {
    out.push({ value: m[1], noval: !!m[2], selected: !!m[3], label: m[4] });
  }
  return out;
}

/** 解析面板里 select 的 onchange 属性（无则 null） */
/** 驱动 applyFilt（伪 document 提供 fp_mode/fp_val；useChecks=false 故不碰 filtPop） */
function driveApplyFilt(app, m, key, mode, val) {
  const valEl = { value: val == null ? '' : String(val), style: { display: '' } };
  const sel = { value: mode, options: [{ value: mode, dataset: {} }], selectedIndex: 0 };
  const doc = app.sandbox.document;
  const orig = doc.getElementById;
  doc.getElementById = function (id) {
    if (id === 'fp_mode') return sel;
    if (id === 'fp_val') return valEl;
    return null;                       /* fp_drange 不存在 ⇒ 走「读 fp_val」分支 */
  };
  try {
    app.run("applyFilt(" + JSON.stringify(m) + "," + JSON.stringify(key) + ",false);");
  } finally {
    doc.getElementById = orig;
  }
}

function selectOnChange(html) {
  const m = /<select id="fp_mode"([^>]*)>/.exec(String(html));
  if (!m) return null;
  const a = /onchange="([^"]*)"/.exec(m[1]);
  return a ? a[1] : null;
}

/**
 * 用**真实面板产出的选项**驱动 fpModeChange，回传 fp_val 的 display。
 * 这样测的是「渲染处打标 ↔ 消费处读标」这条真实链路，而不是我手工捏的 dataset。
 */
function driveFpModeChange(app, options, idx) {
  const val = { style: { display: '__init__' } };
  const opts = options.map(function (o) {
    return { value: o.value, dataset: (o.noval ? { noval: '1' } : {}) };
  });
  const sel = { options: opts, selectedIndex: idx, value: opts[idx].value };
  const doc = app.sandbox.document;
  const orig = doc.getElementById;
  doc.getElementById = function (id) {
    if (id === 'fp_mode') return sel;
    if (id === 'fp_val') return val;
    return null;
  };
  try {
    app.run('fpModeChange();');
  } finally {
    doc.getElementById = orig;
  }
  return val.style.display;
}

/** 驱动 fpDateModeChange，回传 {val, drange} 的 display（日期三态显隐） */
function driveFpDateModeChange(app, mode) {
  const val = { style: { display: '__init__' } };
  const dr = { style: { display: '__init__' } };
  const sel = { value: mode };
  const doc = app.sandbox.document;
  const orig = doc.getElementById;
  doc.getElementById = function (id) {
    if (id === 'fp_mode') return sel;
    if (id === 'fp_val') return val;
    if (id === 'fp_drange') return dr;
    return null;
  };
  try {
    app.run('fpDateModeChange();');
  } finally {
    doc.getElementById = orig;
  }
  return { val: val.style.display, dr: dr.style.display };
}

/* ================================================================
   §A 契约：语义档定义 / 单源红线 / invStockLevel 未改动
================================================================ */

test('A1 契约：全工程 semFilters 声明恰 1 处，且零部件页两个 _balPct 列未加', function () {
  /* 静态：源码里 `semFilters:[` 恰 1 处（给零部件页加即超范围，用户本轮只要求库存管理页） */
  assert.equal(countOcc(stripComments(INDEX_SRC), 'semFilters:['), 1,
    'semFilters:[ 全工程必须恰 1 处（仅库存管理「结余进度」列）');

  /* 动态：注册 5 个真实模块后，声明了 semFilters 的列必须恰 1 个，且是 order_inv._balPct */
  const app = bootAll();
  const owners = app.run('(function(){var out=[];' +
    'Object.keys(TBL_SCHEMAS).forEach(function(m){(TBL_SCHEMAS[m]||[]).forEach(function(c){' +
    'if(c.semFilters&&c.semFilters.length)out.push(m+"."+c.key);});});return out;})()');
  assert.deepEqual(Array.from(owners), ['order_inv._balPct'],
    '声明了语义档的列必须恰为 order_inv._balPct，实际 ' + JSON.stringify(Array.from(owners)));

  /* 零部件页（parts）静态列定义里两个 _balPct/结余列均不得带语义档 */
  const partsSem = app.run('(TBL_SCHEMAS.parts||[]).filter(function(c){return !!c.semFilters;}).map(function(c){return c.key;})');
  assert.deepEqual(Array.from(partsSem), [], '零部件页列不得声明 semFilters（本轮范围外）');
  assert.equal(app.run("(TBL_SCHEMAS.parts||[]).filter(function(c){return c.key==='_balPct';}).length"), 1,
    '零部件页确实存在一个 key 为 _balPct 的列（本用例的前提），且它上面没有语义档');
  app.dispose();
});

test('A2 契约：语义档恰 2 个，mode/label 与需求文案逐字一致，test 均为函数', function () {
  const app = bootInv();
  const defs = app.run("(function(){return (TBL_SCHEMAS.order_inv.find(function(c){return c.key==='_balPct';}).semFilters||[])" +
    ".map(function(s){return {mode:s.mode,label:s.label,isFn:typeof s.test==='function'};});})()");
  const arr = Array.from(defs).map(function (d) { return { mode: d.mode, label: d.label, isFn: d.isFn }; });
  assert.deepEqual(arr, [
    { mode: 'inv_short', label: '低于最小库存量（红/黄警示）', isFn: true },
    { mode: 'inv_over', label: '超过最大库存量（积压/灰）', isFn: true }
  ], '两个语义档的 mode 与面板文案必须与用户拍板口径逐字一致');
  app.dispose();
});

test('A3 契约（单源红线）：语义档只比较 invStockLevel 的返回值，档位判定无第二份副本', function () {
  const app = bootInv();
  const orig = app.getGlobal('invStockLevel');
  const row = invRow('S1', { deliveredQty: 7, stockMin: '10', stockMax: '30' });
  app.sandbox.__qaRows = [row];

  const runTest = function (mode) {
    return app.run('(function(){var c=TBL_SCHEMAS.order_inv.find(function(x){return x.key==="' + '_balPct' + '";});' +
      'var s=c.semFilters.filter(function(x){return x.mode===' + JSON.stringify(mode) + ';})[0];' +
      'return s.test(__qaRows[0]);})()');
  };

  /* 把 invStockLevel 换成受控桩：语义档结果必须**完全跟随**桩返回值。
     若 invShortOf/invOverOf 里另写了一份阈值判定，本用例必然红（那才是 A4 红线被破）。 */
  const cases = [
    { lv: 'red', short: true, over: false },
    { lv: 'amber', short: true, over: false },
    { lv: 'green', short: false, over: false },
    { lv: 'gray', short: false, over: true }
  ];
  try {
    cases.forEach(function (c) {
      const stub = { calls: 0, args: null };
      app.setGlobal('invStockLevel', function (v, mn, mx) {
        stub.calls++;
        stub.args = [v, mn, mx];
        return c.lv;
      });
      try {
        assert.equal(runTest('inv_short'), c.short,
          'invStockLevel 返回 ' + c.lv + ' 时 inv_short 必须为 ' + c.short + '（档位必须取自共享函数）');
        assert.equal(runTest('inv_over'), c.over,
          'invStockLevel 返回 ' + c.lv + ' 时 inv_over 必须为 ' + c.over);
        assert.equal(stub.calls > 0, true, '共享 invStockLevel 必须被真正调用（否则说明另有一份判定）');
        assert.deepEqual(stub.args, [7, '10', '30'],
          '入参必须是（结余, 最小库存量, 最大库存量）三元组，实际 ' + JSON.stringify(stub.args));
      } finally {
        app.setGlobal('invStockLevel', orig);
      }
    });
  } finally {
    app.setGlobal('invStockLevel', orig);
    delete app.sandbox.__qaRows;
    app.dispose();
  }
});

test('A4 契约：invStockLevel 本体与上一版逐字相同（含两条防抵消守卫）', function () {
  /* 防抵消 ①：基线修订与当前工作树必须是**不同**文件 */
  assert.notEqual(md5(PREV_INDEX_SRC), md5(INDEX_SRC),
    '反抵消守卫：上一版与当前 index.html 必须不同（若相同则本用例比对的是同一份文件，恒真无意义）');
  /* 防抵消 ②：基线修订确实取到了上一版（用水印自证，而不是靠提交主题的字面推断） */
  assert.equal(countOcc(PREV_INDEX_SRC, '>build ' + build.PREV + '<'), 1,
    '基线修订的 index.html 必须自证为上一版水印（取错修订 → 本用例失效）');
  assert.equal(countOcc(INDEX_SRC, '>build ' + build.BUILD + '<'), 1,
    '当前 index.html 必须自证为本版水印');
  /* 防抵消 ③：基线修订不得等于 HEAD（.152 教训：拿 HEAD 当基线会与自身对消） */
  assert.notEqual(PREV_REV, HEAD, '基线修订不得是 HEAD（否则比对退化为自我对消）');

  const now = extractFn(INDEX_SRC, 'invStockLevel');
  const prev = extractFn(PREV_INDEX_SRC, 'invStockLevel');
  assert.equal(now, prev, 'invStockLevel 本体必须与上一版逐字相同（.160 的零值口径原样保留）');
  /* 提取非空守卫：确认抓到的确实是那个函数体，而不是空串/别处同名片段 */
  assert.ok(now.length > 150, '提取到的 invStockLevel 函数体过短（' + now.length + '），提取器可能失效');
  assert.ok(now.indexOf("return 'amber'") >= 0, 'invStockLevel 必须仍含 amber 分支');
  assert.ok(now.indexOf('num(min)>0') >= 0, '「最小=0/空 ⇒ 不设限」的守卫必须仍在（用户拍板第 2 点）');

  /* 防抵消 ④：提取器对修订必须敏感。
     【.163 同步·参考系固定】原探针用「上一版 vs 本版」证明敏感，但上一版是**会漂移的**：
     .163 未改动 thCol / applyFilt ⇒ 与 .162 逐字相同，notEqual 会恒红（且红点指不到真问题）。
     改为固定比对 .162↔.161 这一对（.162 确实改过这两个函数）：差异是不可变历史，永久有效。 */
  assert.notEqual(extractFn(PREV_INDEX_SRC, 'thCol'), extractFn(B161_INDEX_SRC, 'thCol'),
    '提取器必须对修订敏感（thCol 在 .162 被改 ⇒ .162 与 .161 必须不同；相同则说明提取/基线失效）');
  assert.notEqual(extractFn(PREV_INDEX_SRC, 'applyFilt'), extractFn(B161_INDEX_SRC, 'applyFilt'),
    '提取器必须对修订敏感（applyFilt 在 .162 被改：语义档写入前清脏值）');
});

test('A5 契约（单源红线静态面）：invShortOf/invOverOf 函数体零阈值运算', function () {
  const src = stripComments(INDEX_SRC);
  const shortFn = extractFn(src, 'invShortOf');
  const overFn = extractFn(src, 'invOverOf');
  [['invShortOf', shortFn], ['invOverOf', overFn]].forEach(function (pair) {
    const name = pair[0], body = pair[1];
    assert.equal(countOcc(body, 'invStockLevel('), 1, name + ' 必须恰好调用一次共享 invStockLevel');
    assert.equal(/[<>]/.test(body), false, name + ' 函数体不得出现 < 或 >（禁止另写阈值比较）：' + body);
    assert.equal(/num\s*\(/.test(body), false, name + ' 函数体不得出现 num(（说明在做数值运算）：' + body);
    assert.equal(/[0-9]/.test(body), false, name + ' 函数体不得出现数字字面量（阈值魔数）：' + body);
  });
  /* 语义档 test 本身也不得直接做阈值比较（只能透传给上面两个单源函数） */
  const balCol = INDEX_SRC.slice(INDEX_SRC.indexOf("semFilters:["));
  const seg = balCol.slice(0, balCol.indexOf(']}]'));
  assert.equal(/num\s*\(/.test(seg), false, '_balPct 的 semFilters 声明不得出现 num(（不得自行取数比较）');
  assert.ok(seg.indexOf('invShortOf(') >= 0 && seg.indexOf('invOverOf(') >= 0,
    '两个语义档必须分别透传给 invShortOf / invOverOf');
  assert.ok(seg.indexOf('invBalanceOf(') >= 0 && seg.indexOf('invPuOf(') >= 0,
    '语义档取数必须走 invBalanceOf + invPuOf（与「结余」列同源同入口）');
});

/* ================================================================
   §B 引擎：语义模式不得被静默跳过（反假守卫）
================================================================ */

/* 固定观测量：6 行覆盖 red / amber / green / gray / 未设限 五种形态 */
const CORE_ROWS = [
  invRow('R1', { deliveredQty: -5, stockMin: '', stockMax: '' }),   /* red  → short */
  invRow('R2', { deliveredQty: 0, stockMin: 10, stockMax: '' }),    /* amber → short */
  invRow('R3', { deliveredQty: 20, stockMin: 10, stockMax: 30 }),   /* green */
  invRow('R4', { deliveredQty: 40, stockMin: 10, stockMax: 30 }),   /* gray → over */
  invRow('R5', { deliveredQty: 5, stockMin: 0, stockMax: 0 }),      /* 未设限 → green */
  invRow('R6', { deliveredQty: 10, stockMin: 10, stockMax: '' })    /* 恰好=最小 → green */
];

test('B1 契约（反假守卫）：选中 inv_short 后行数必须真正减少，不得"选了但不生效"', function () {
  const app = bootInv();
  app.sandbox.__qaRowsA = CORE_ROWS;
  try {
    const all = idsOf(app.run("tState('order_inv').filters={};filterRows('order_inv',__qaRowsA)"));
    const short = semHitIds(app, CORE_ROWS, 'inv_short');
    const over = semHitIds(app, CORE_ROWS, 'inv_over');
    /* 三个断言缺一不可：
       ① 全量 = 6（数据前提，防数据造错导致后面的"减少"是假象）
       ② 命中数 < 全量（反假守卫的核心：若 filterRows 闸门顺序写错会被 continue 静默跳过 → 等于全量）
       ③ 命中数 > 0（防另一种假象：把全部筛掉也算"减少"） */
    assert.equal(all.length, 6, '数据前提：全量必须为 6 行');
    assert.ok(short.length < all.length,
      '反假守卫：inv_short 必须真正减少行数（实际 ' + short.length + '/' + all.length +
      ' —— 相等于全量说明语义模式被静默跳过）');
    assert.ok(short.length > 0, '反假守卫：inv_short 不得把全部行筛掉（实际 ' + short.length + '）');
    assert.ok(over.length < all.length, '反假守卫：inv_over 必须真正减少行数（实际 ' + over.length + '/' + all.length + '）');
    assert.ok(over.length > 0, '反假守卫：inv_over 不得把全部行筛掉');
  } finally {
    delete app.sandbox.__qaRowsA;
    app.dispose();
  }
});

test('B2 契约：inv_short 命中集合 == 独立口径（界面红/黄警示标）逐行一致', function () {
  const app = bootInv();
  const got = semHitIds(app, CORE_ROWS, 'inv_short').sort();
  const want = CORE_ROWS.filter(function (r) {
    return expectShort(r.item.deliveredQty, r.item.stockMin, r.item.stockMax);
  }).map(function (r) { return r.order.id; }).sort();
  assert.deepEqual(got, want, 'inv_short 命中集合必须与「红/黄三角标所见即所筛」一致');
  assert.deepEqual(want, ['R1', 'R2'], '口径前提：R1(红) + R2(黄) 必须入选，R3/R5/R6 不得入选');
  app.dispose();
});

test('B3 契约：inv_over 命中集合 == 独立口径（积压/灰标）逐行一致', function () {
  const app = bootInv();
  const got = semHitIds(app, CORE_ROWS, 'inv_over').sort();
  const want = CORE_ROWS.filter(function (r) {
    return expectOver(r.item.deliveredQty, r.item.stockMin, r.item.stockMax);
  }).map(function (r) { return r.order.id; }).sort();
  assert.deepEqual(got, want, 'inv_over 命中集合必须与「积压/灰标」一致');
  assert.deepEqual(want, ['R4'], '口径前提：只有结余>最大且最大>0 的 R4 入选');
  app.dispose();
});

test('B4 契约：未声明 semFilters 的列用语义模式时仍被跳过（既有语义不变）', function () {
  /* 这是「反假守卫」的对照组：语义模式**不是**"任何列都生效"。
     未声明该语义档 ⇒ 引擎必须视作无效筛选跳过，不得因缺省而放行成"筛掉全部"或"静默报错"。 */
  const app = bootAll();
  /* ① order_inv 的普通数值列（交付进度 _pct，无 semFilters） */
  const rowsInv = CORE_ROWS;
  const fPct = { _pct: { mode: 'inv_short', val: '' } };
  const r1 = idsOf(runFilter(app, 'order_inv', rowsInv, fPct));
  assert.deepEqual(r1.sort(), ['R1', 'R2', 'R3', 'R4', 'R5', 'R6'],
    '未声明 semFilters 的列 + 语义模式 ⇒ 必须跳过（返回全量），不得筛空/报错');

  /* ② 零部件页 _balPct（key 同名但未声明语义档）——同款 key 不同模块，必须不串味 */
  const partsRows = app.run('TBL_ROWS.parts').map(function (r) { return r; });
  const fParts = { _balPct: { mode: 'inv_short', val: '' } };
  const r2 = idsOf(runFilter(app, 'parts', Array.from(partsRows), fParts), function (r) { return r.id; });
  assert.deepEqual(r2.sort(), ['A1', 'A2'], '零部件页 _balPct 未声明语义档 ⇒ 语义模式必须被跳过（返回全量）');

  /* ③ 与「本模块未声明」对照：order_inv 的同名列则必须生效（否则上面两条可能是"全局都失效"的假绿） */
  const r3 = semHitIds(app, rowsInv, 'inv_short');
  assert.deepEqual(r3.sort(), ['R1', 'R2'], '对照组：库存管理页同名列必须真的生效，证明上面两条不是"全局失效"误判');
  app.dispose();
});

test('B5 契约：filters 指向不存在的列时不抛错、直接跳过', function () {
  const app = bootInv();
  const res = idsOf(runFilter(app, 'order_inv', CORE_ROWS, { __no_such_col: { mode: 'inv_short', val: '' } }));
  assert.deepEqual(res.sort(), ['R1', 'R2', 'R3', 'R4', 'R5', 'R6'], '未知列必须跳过（既有 continue 语义）');
  app.dispose();
});

test('B6 契约：val 缺省（undefined）与空串等价生效（语义档与列值无关）', function () {
  const app = bootInv();
  const a = semHitIds(app, CORE_ROWS, 'inv_short');
  const b = idsOf(runFilter(app, 'order_inv', CORE_ROWS, { _balPct: { mode: 'inv_short' } }));
  const c = idsOf(runFilter(app, 'order_inv', CORE_ROWS, { _balPct: { mode: 'inv_short', val: null } }));
  assert.deepEqual(b.sort(), a.sort(), 'val 缺省（undefined）时必须与 val="" 等效');
  assert.deepEqual(c.sort(), a.sort(), 'val=null 时必须与 val="" 等效');
  app.dispose();
});

test('B7 契约：语义模式与既有数值模式可叠加（交集，不是覆盖）', function () {
  const app = bootInv();
  const both = idsOf(runFilter(app, 'order_inv', CORE_ROWS, {
    _balPct: { mode: 'inv_short', val: '' },
    stockMin: { mode: 'gte', val: 10 }
  }));
  /* inv_short={R1,R2} 且 最小库存量>=10 ⇒ R2(10) 命中、R1(min 空→num=0) 不命中 */
  assert.deepEqual(both.sort(), ['R2'], '两个筛选键必须取交集（R1 的 stockMin 为空，num=0 不满足 >=10）');
  app.dispose();
});

test('B8 契约：结余取数与「结余」列同源（走 invPuOf 的交付计划量，不是只看已交付）', function () {
  /* 造一条交付计划：订单 KC1 第 0 行本批计划 50 台，无排产完成 ⇒ pu={plan:50,done:0}
     ⇒ 结余 = 已交付 + 50。若语义档绕开 invPuOf 只看 deliveredQty，本用例必红。 */
  const app = bootAll();
  const rows = [
    invRow('KC1', { deliveredQty: -60, stockMin: '', stockMax: '', productId: 'P1' }, 0) /* 结余 -10 ⇒ red */
  ];
  app.sandbox.__qaRow0 = rows[0];
  const bal = app.run('(function(){var c=TBL_SCHEMAS.order_inv.find(function(x){return x.key==="_balance";});return c.get(__qaRow0);})()');
  delete app.sandbox.__qaRow0;
  assert.equal(bal, -10, '前提：结余必须 = 已交付(-60) + 本批计划(50) = -10（走 invPuOf/invBalanceOf）');
  assert.deepEqual(semHitIds(app, rows, 'inv_short'), ['KC1'],
    '语义档必须用与「结余」列同一份结余（-10 < 0 ⇒ 红），不得只看已交付量');
  /* 对照：若只看已交付(-60) 也入选，无法区分；故再补一行「只看已交付会误判」的数据：
     已交付 0、本批计划 50 ⇒ 结余 50 > 0 绿；只看已交付则是 amber 会被误选 */
  app.dispose();

  const app2 = bootAll();
  const rows2 = [invRow('KC1', { deliveredQty: 0, stockMin: 30, stockMax: '', productId: 'P1' }, 0)];
  /* 结余 = 0 + 50 = 50 ≥ 最小 30 ⇒ green ⇒ 不得入选（若误用已交付 0 则会被判 amber 入选） */
  assert.deepEqual(semHitIds(app2, rows2, 'inv_short'), [],
    '结余 50 ≥ 最小 30 ⇒ 绿标，不得入选；若入选说明筛选用了已交付量而非结余');
  app2.dispose();
});

/* ================================================================
   §C 口径 A 的三类边界（用户否决「严格 结余<最小 且 最小>0」）
================================================================ */

const C_CASES = [
  { name: 'C1 结余=0 且 最小库存量>0（.160 起 amber 下界为闭区间）', item: { deliveredQty: 0, stockMin: 10, stockMax: '' }, short: true, over: false },
  { name: 'C2 结余<0 且**未设**最小库存量（红标，min 不参与 red 判定）', item: { deliveredQty: -3, stockMin: '', stockMax: '' }, short: true, over: false },
  { name: 'C3 结余<0 且 最小库存量=0（红标，min=0 视同不设限）', item: { deliveredQty: -1, stockMin: 0, stockMax: '' }, short: true, over: false },
  { name: 'C4 最小库存量=0 且 结余=0（不设限 ⇒ 绿，不入选）', item: { deliveredQty: 0, stockMin: 0, stockMax: 0 }, short: false, over: false },
  { name: 'C5 结余正好=最小库存量（amber 上界开区间 ⇒ 绿，不入选）', item: { deliveredQty: 10, stockMin: 10, stockMax: '' }, short: false, over: false },
  { name: 'C6 结余=最小-1（amber，入选 inv_short）', item: { deliveredQty: 9, stockMin: 10, stockMax: '' }, short: true, over: false },
  { name: 'C7 结余=最大+1 且 最大>0（灰，只入选 inv_over）', item: { deliveredQty: 31, stockMin: 10, stockMax: 30 }, short: false, over: true },
  { name: 'C8 结余正好=最大（gray 为严格 >，不入选）', item: { deliveredQty: 30, stockMin: 10, stockMax: 30 }, short: false, over: false },
  { name: 'C9 未设上限但结余为负（不得误判为 inv_over）', item: { deliveredQty: -8, stockMin: '', stockMax: '' }, short: true, over: false },
  /* C10：上下限配置矛盾（最大 3 < 最小 10）而结余 5 同时满足「<最小」与「>最大」。
     invStockLevel 是 if 链（red → amber → gray），amber 先命中即返回 ⇒ 界面画黄标、不画灰标。
     语义筛选必须与三角标一致（所见即所筛）⇒ 只入 inv_short。这是既有优先级，非本版引入。 */
  { name: 'C10 上下限矛盾(max<min)时按 invStockLevel 优先级：amber 先于 gray', item: { deliveredQty: 5, stockMin: 10, stockMax: 3 }, short: true, over: false }
];

test('C 契约：口径 A 的 10 个边界逐例断言（红/黄 → inv_short；灰 → inv_over）', function () {
  const app = bootInv();
  const fails = [];
  C_CASES.forEach(function (c) {
    const rows = [invRow('X1', c.item)];
    const gotShort = semHitIds(app, rows, 'inv_short').length === 1;
    const gotOver = semHitIds(app, rows, 'inv_over').length === 1;
    if (gotShort !== c.short || gotOver !== c.over) {
      fails.push(c.name + ' → 期望 short=' + c.short + '/over=' + c.over +
        '，实际 short=' + gotShort + '/over=' + gotOver);
    }
  });
  assert.deepEqual(fails, [], '边界用例不符（口径 A / 所见即所筛被破坏）：\n' + fails.join('\n'));
  app.dispose();
});

test('C11 契约：绝不能被实现成「严格 结余<最小 且 最小>0」（用户明确否决的口径）', function () {
  const app = bootInv();
  /* 关键反例：结余=-5、min=''（未设下限）。严格口径会漏掉它，但界面上它画着红三角。 */
  const rows = [invRow('N1', { deliveredQty: -5, stockMin: '', stockMax: '' })];
  assert.deepEqual(semHitIds(app, rows, 'inv_short'), ['N1'],
    '未设下限但结余为负的行必须入选（用户原话「红色和黄色警告标」；严格口径会漏掉这类行）');
  app.dispose();
});

/* ================================================================
   §D 面板：选项、data-noval、fpModeChange 等价重构
================================================================ */

test('D1 契约：结余进度列面板 = 原 4 模式 + 2 语义档，且仅语义档带 data-noval', function () {
  const app = bootInv();
  const html = panelHtml(app, 'order_inv', '_balPct');
  const opts = parseOptions(html);
  assert.equal(opts.length, 6, '结余进度列必须 6 个选项（4 原模式 + 2 语义档），实际 ' + opts.length);
  assert.deepEqual(opts.map(function (o) { return o.value; }),
    ['gte', 'lte', 'eq', 'neq', 'inv_short', 'inv_over'],
    '选项顺序：原 4 模式在前（逐字不变），语义档追加在后');
  assert.deepEqual(opts.map(function (o) { return o.label; }),
    ['大于等于', '小于等于', '等于', '不等于', '低于最小库存量（红/黄警示）', '超过最大库存量（积压/灰）']);
  assert.deepEqual(opts.map(function (o) { return o.noval; }),
    [false, false, false, false, true, true],
    '仅两个语义档需要 data-noval（它们不需要输入数值）');
  app.dispose();
});

test('D2 契约：数值列 select 已挂 onchange="fpModeChange()"（.161 新增，.162 起已成基线）', function () {
  const app = bootInv();
  const now = selectOnChange(panelHtml(app, 'order_inv', '_balPct'));
  assert.equal(now, 'fpModeChange()', '数值列模式下拉必须触发 fpModeChange 以显隐数值框');
  app.dispose();

  const old = boot({ indexHtml: PREV_INDEX_SRC });
  old.run("renderOrderTable('order_inv',[],{});");
  /* 【.162 同步】原断言「上一版没有 onchange」在版本推进到 .162 后不再成立（该标记已是基线）。
     改为断言两版一致 ⇒ 语义从「本版新增」变「本版未回归」（.161 已在其报告中证明过"新增"）。 */
  assert.equal(selectOnChange(panelHtml(old, 'order_inv', '_balPct')), 'fpModeChange()',
    '上一版（.161 基线）数值列 select 已有 onchange ⇒ 本版必须与之一致');
  old.dispose();
});

test('D3 契约（等价重构）：文本列「为空/不为空」仍隐藏输入框，其余模式仍显示，且与上一版逐模式一致', function () {
  const now = bootAll();
  const prev = boot({ indexHtml: PREV_INDEX_SRC });
  prev.setGlobal('products', clone(SEED.products));
  prev.setGlobal('parts', clone(SEED.parts));
  prev.setGlobal('deliveries', clone(SEED.deliveries));
  prev.run("renderProducts();renderParts();renderDelivery();renderOrderTable('order_frame',[],{});");

  /* 文本列覆盖两条渲染路径：增强 8 模式（order_frame.id）与普通 3 模式（若存在）。
     这里用 order_frame.id（ENH_FILT_MODES_LIST，含 is_empty/not_empty）。 */
  const htmlNow = panelHtml(now, 'order_frame', 'id');
  const htmlPrev = panelHtml(prev, 'order_frame', 'id');
  const oNow = parseOptions(htmlNow);
  const oPrev = parseOptions(htmlPrev);
  assert.equal(oNow.length, 8, '增强文本列必须 8 个模式');
  assert.deepEqual(oNow.map(function (o) { return o.value; }), oPrev.map(function (o) { return o.value; }),
    '文本列模式集合必须与上一版完全一致（等价重构，不得增删模式）');

  /* 逐模式驱动真实链路，并与上一版逐模式对拍 */
  const diffs = [];
  oNow.forEach(function (o, i) {
    const dispNow = driveFpModeChange(now, oNow, i);
    const dispPrev = driveFpModeChange(prev, oPrev, i);
    if (dispNow !== dispPrev) diffs.push(o.value + '：本版 ' + JSON.stringify(dispNow) + ' ≠ 上版 ' + JSON.stringify(dispPrev));
  });
  assert.deepEqual(diffs, [], 'fpModeChange 行为必须与上一版逐模式等价：\n' + diffs.join('\n'));

  /* 明确的契约面：is_empty / not_empty 隐藏；contains 显示 */
  const idx = function (list, v) { return list.map(function (x) { return x.value; }).indexOf(v); };
  assert.equal(driveFpModeChange(now, oNow, idx(oNow, 'is_empty')), 'none', '「为空」必须隐藏输入框');
  assert.equal(driveFpModeChange(now, oNow, idx(oNow, 'not_empty')), 'none', '「不为空」必须隐藏输入框');
  assert.equal(driveFpModeChange(now, oNow, idx(oNow, 'contains')), '', '「包含」必须显示输入框');
  now.dispose();
  prev.dispose();
});

test('D4 契约：语义档选中后 fp_val 必须隐藏（否则用户会以为要填数值）', function () {
  const app = bootInv();
  const opts = parseOptions(panelHtml(app, 'order_inv', '_balPct'));
  const at = function (v) { return opts.map(function (o) { return o.value; }).indexOf(v); };
  assert.equal(driveFpModeChange(app, opts, at('inv_short')), 'none', 'inv_short 选中后数值框必须隐藏');
  assert.equal(driveFpModeChange(app, opts, at('inv_over')), 'none', 'inv_over 选中后数值框必须隐藏');
  /* 原 4 模式必须仍然显示（否则用户没法填数值） */
  ['gte', 'lte', 'eq', 'neq'].forEach(function (v) {
    assert.equal(driveFpModeChange(app, opts, at(v)), '', '原模式 ' + v + ' 必须仍显示数值框');
  });
  app.dispose();
});

test('D5 契约：未声明语义档的数值列面板零污染（仍 4 选项、无 data-noval、无 onchange 变化）', function () {
  const app = bootInv();
  const nowHtml = panelHtml(app, 'order_inv', 'stockMin');
  const opts = parseOptions(nowHtml);
  assert.equal(opts.length, 4, '普通数值列必须仍只有 4 个模式，实际 ' + opts.length);
  assert.deepEqual(opts.map(function (o) { return o.noval; }), [false, false, false, false],
    '普通数值列不得带 data-noval');
  assert.equal(/inv_short|inv_over|低于最小库存量|超过最大库存量/.test(nowHtml), false,
    '普通数值列面板不得出现语义档文案');

  const prev = boot({ indexHtml: PREV_INDEX_SRC });
  prev.run("renderOrderTable('order_inv',[],{});");
  assert.deepEqual(parseOptions(panelHtml(prev, 'order_inv', 'stockMin')).map(function (o) { return [o.value, o.label]; }),
    opts.map(function (o) { return [o.value, o.label]; }),
    '普通数值列的选项内容必须与上一版完全一致');
  prev.dispose();
  app.dispose();
});

/* ================================================================
   §E 日期列不被污染（fp_drange 双日期面板）
================================================================ */

test('E1 契约：日期列 select 的 onchange 必须仍是 fpDateModeChange()，不得被换成 fpModeChange()', function () {
  const app = bootAll();
  /* 覆盖多个模块的日期列：order_frame.deadline / order_inv.startDate / delivery.createdAt */
  const targets = [['order_frame', 'deadline'], ['order_inv', 'startDate'], ['delivery', 'createdAt']];
  targets.forEach(function (t) {
    const html = panelHtml(app, t[0], t[1]);
    const oc = selectOnChange(html);
    assert.equal(oc, 'fpDateModeChange()', t[0] + '.' + t[1] + ' 日期列 onchange 必须仍为 fpDateModeChange()，实际 ' + oc);
    assert.equal(/fpModeChange\(\)/.test(html), false,
      t[0] + '.' + t[1] + ' 日期列面板不得出现 fpModeChange（会打乱双日期面板显隐）');
    assert.equal(/data-noval/.test(html), false, t[0] + '.' + t[1] + ' 日期面板不得出现 data-noval');
  });
  app.dispose();
});

test('E2 契约：日期三态显隐（range 双日期 / eq 单日期 / 快捷模式全隐）且与上一版逐模式一致', function () {
  const now = boot({ indexHtml: INDEX_SRC });
  now.run("renderOrderTable('order_frame',[],{});");
  const prev = boot({ indexHtml: PREV_INDEX_SRC });
  prev.run("renderOrderTable('order_frame',[],{});");

  const optsNow = parseOptions(panelHtml(now, 'order_frame', 'deadline'));
  assert.equal(optsNow.length, 8, '日期列必须 8 个快捷模式');
  assert.deepEqual(
    parseOptions(panelHtml(prev, 'order_frame', 'deadline')).map(function (o) { return o.value; }),
    optsNow.map(function (o) { return o.value; }), '日期模式集合必须与上一版一致');

  /* 逐模式差分（覆盖 range / eq / 快捷模式三类） */
  const diffs = [];
  optsNow.forEach(function (o) {
    const a = driveFpDateModeChange(now, o.value);
    const b = driveFpDateModeChange(prev, o.value);
    if (a.val !== b.val || a.dr !== b.dr) {
      diffs.push(o.value + '：本版 ' + JSON.stringify(a) + ' ≠ 上版 ' + JSON.stringify(b));
    }
  });
  assert.deepEqual(diffs, [], '日期显隐必须与上一版逐模式一致：\n' + diffs.join('\n'));

  /* 明确契约：range 显示双日期、隐藏单日期；eq 相反；快捷模式全隐 */
  const r = driveFpDateModeChange(now, 'range');
  assert.equal(r.dr, 'inline-flex', 'range 必须显示 fp_drange 双日期');
  assert.equal(r.val, 'none', 'range 必须隐藏 fp_val 单日期');
  const e = driveFpDateModeChange(now, 'eq');
  assert.equal(e.dr, 'none', 'eq 必须隐藏 fp_drange');
  assert.equal(e.val, '', 'eq 必须显示 fp_val 单日期');
  const q = driveFpDateModeChange(now, 'this_month');
  assert.equal(q.dr, 'none', '快捷模式必须隐藏 fp_drange');
  assert.equal(q.val, 'none', '快捷模式必须隐藏 fp_val');
  now.dispose();
  prev.dispose();
});

/* ================================================================
   §F 筛选条 chip 与清除全部
================================================================ */

test('F1 契约：语义模式必须产出 chip，文案=列名+档位名且不拼数值', function () {
  const app = bootInv();
  app.run("tState('order_inv').filters={_balPct:{mode:'inv_short',val:''}};");
  const bar = app.run("filterBar('order_inv')");
  assert.ok(bar.indexOf('fchip') >= 0, '语义筛选必须出现 chip（否则「筛了却看不到」）');
  assert.ok(bar.indexOf('结余进度') >= 0, 'chip 必须含列名');
  assert.ok(bar.indexOf('低于最小库存量') >= 0, 'chip 必须含档位文案');
  assert.ok(bar.indexOf('清除全部') >= 0, '筛有条必须提供「清除全部」入口');

  /* 不拼数值：即使残留 f.val（折衷遗留），chip 也不得把它拼进去 */
  app.run("tState('order_inv').filters={_balPct:{mode:'inv_short',val:'100'}};");
  const bar2 = app.run("filterBar('order_inv')");
  assert.equal(/100/.test(bar2), false, '语义档 chip 不得拼接数值（该档不看数值，拼上会误导）');
  app.dispose();
});

test('F2 契约：未声明语义档 + val 空的未知模式不产 chip（filterBar 既有语义不变）', function () {
  const app = bootInv();
  app.run("tState('order_inv').filters={_pct:{mode:'inv_short',val:''}};");
  assert.equal(app.run("filterBar('order_inv')"), '', '未声明的语义模式不得凭空产出 chip');
  app.dispose();
});

test('F3 契约：清除全部后筛选条消失且行数恢复全量', function () {
  const app = bootInv();
  /* clearAllFilt 内部会重渲染（DOM 桩不具备渲染能力）→ 用空实现替换 renderContent，
     本用例只断言「筛选态与筛选条」这一契约面，不涉渲染。 */
  app.run('renderContent=function(){};');
  app.sandbox.__qaRowsB = CORE_ROWS;
  try {
    app.run("tState('order_inv').filters={_balPct:{mode:'inv_short',val:''}};");
    const filtered = idsOf(app.run("filterRows('order_inv',__qaRowsB)"));
    assert.equal(filtered.length, 2, '前提：语义筛选后应为 2 行');
    assert.ok(app.run("filterBar('order_inv')").length > 0, '前提：应出现筛选条');

    app.run("clearAllFilt('order_inv')");
    assert.equal(app.run("filterBar('order_inv')"), '', '清除全部后筛选条必须消失');
    const restored = idsOf(app.run("filterRows('order_inv',__qaRowsB)"));
    assert.deepEqual(restored.sort(), ['R1', 'R2', 'R3', 'R4', 'R5', 'R6'], '清除全部后必须恢复全量');

    /* 单列清除（chip 上的 × 走 clearFilt） */
    app.run("tState('order_inv').filters={_balPct:{mode:'inv_over',val:''}};");
    app.run("clearFilt('order_inv','_balPct')");
    assert.deepEqual(app.run("Object.keys(tState('order_inv').filters)").length, 0, 'clearFilt 必须移除该列筛选');
  } finally {
    delete app.sandbox.__qaRowsB;
    app.dispose();
  }
});

test('F4 契约：既有模式 chip 文案零回归（与上一版逐字一致）', function () {
  const now = bootInv();
  const prev = boot({ indexHtml: PREV_INDEX_SRC });
  prev.run("renderOrderTable('order_inv',[],{});");
  now.run('renderContent=function(){};');
  prev.run('renderContent=function(){};');
  const states = [
    "{id:{mode:'contains',val:'KC'}}",
    "{stockMin:{mode:'gte',val:'10'}}",
    "{startDate:{mode:'range',from:'2026-01-01',to:'2026-12-31'}}",
    "{id:{mode:'is_empty',val:''}}",
    "{id:{vals:['KC1','KC2'],mode:'in'}}"
  ];
  const diffs = [];
  states.forEach(function (s) {
    now.run("tState('order_inv').filters=" + s + ';');
    prev.run("tState('order_inv').filters=" + s + ';');
    const a = now.run("filterBar('order_inv')");
    const b = prev.run("filterBar('order_inv')");
    if (a !== b) diffs.push(s + '\n  本版：' + a + '\n  上版：' + b);
  });
  assert.deepEqual(diffs, [], '既有模式的筛选条输出必须与上一版逐字一致：\n' + diffs.join('\n'));
  now.dispose();
  prev.dispose();
});

/* ================================================================
   §G 其他模块零回归（差分：上一版 vs 当前）
================================================================ */

/** 两版同种子装载，回传 {now, prev} */
function bootBoth() {
  const mk = function (html) {
    const app = boot({ indexHtml: html });
    app.setGlobal('products', clone(SEED.products));
    app.setGlobal('parts', clone(SEED.parts));
    app.setGlobal('deliveries', clone(SEED.deliveries));
    app.run("renderProducts();renderParts();renderDelivery();renderOrderTable('order_frame',[],{});");
    app.run('renderContent=function(){};');
    return app;
  };
  return { now: mk(INDEX_SRC), prev: mk(PREV_INDEX_SRC) };
}

/** 由真实 schema 生成筛选态电池（按列类型挑模式，保证覆盖所有模式分支） */
function filterBattery(app, m) {
  const cols = Array.from(app.run('(TBL_SCHEMAS[' + JSON.stringify(m) + ']||[]).map(function(c){return {key:c.key,type:c.type,bool:!!(c.semFilters&&c.semFilters.length)};})'));
  const pick = function (type) { return cols.filter(function (c) { return c.type === type; }); };
  const text = pick('text'), num = pick('number'), date = pick('date');
  const battery = [];
  if (text.length) {
    const k = text[0].key;
    [{ mode: 'contains', val: '甲' }, { mode: 'eq', val: '产品甲' }, { mode: 'neq', val: '产品甲' },
      { mode: 'startswith', val: '产' }, { mode: 'endswith', val: '甲' },
      { mode: 'is_empty', val: '' }, { mode: 'not_empty', val: '' }].forEach(function (f) {
      const o = {}; o[k] = f; battery.push(o);
    });
  }
  if (num.length) {
    const k = num[num.length - 1].key; /* 取靠后的数值列，尽量避开被本版改动的 _balPct */
    [{ mode: 'gte', val: 5 }, { mode: 'lte', val: 5 }, { mode: 'eq', val: 5 }, { mode: 'neq', val: 5 }].forEach(function (f) {
      const o = {}; o[k] = f; battery.push(o);
    });
    const o2 = {}; o2[k] = { vals: ['5', '10'], mode: 'in' }; battery.push(o2);
  }
  if (date.length) {
    const k = date[0].key;
    [{ mode: 'gte', val: '2026-01-01' }, { mode: 'lte', val: '2026-12-31' }, { mode: 'eq', val: '2026-11-20' },
      { mode: 'neq', val: '2026-11-20' }, { mode: 'today', val: '' }, { mode: 'this_week', val: '' },
      { mode: 'this_month', val: '' }, { mode: 'last_month', val: '' }, { mode: 'last_1m', val: '' },
      { mode: 'last_3m', val: '' }, { mode: 'range', from: '2026-01-01', to: '2026-12-31' }].forEach(function (f) {
      const o = {}; o[k] = f; battery.push(o);
    });
    const o3 = {}; o3[k] = { vals: ['2026-11-20'], mode: 'in' }; battery.push(o3);
  }
  return battery;
}

/** 各模块的行 id 投影（结果序列比较用） */
const PROJ = {
  order_frame: function (r) { return r.order.id + '#' + r.__li; },
  product: function (r) { return r.id; },
  parts: function (r) { return r.id; },
  delivery: function (r) { return r.d.planNo + '#' + r.li; }
};

/** 造 order_frame 行（销售订单行模型），日期覆盖今天/本月/去年，供快捷模式差分 */
function frameRows(app) {
  const today = app.run('todayStr()');
  const lm = app.run('addMonthsStr(todayStr(),-1)');
  const rows = [];
  const mk = function (id, li, deadline, startDate) {
    return {
      order: { id: id, orderType: '销售订单', customer: '客户' + id, deadline: deadline, startDate: startDate, status: '已完成' },
      item: { productId: 'P1', productName: '产品甲', orderQty: 100, deliveredQty: li * 10, calledQty: 0, lineNotes: '' },
      orderIdx: 0, __li: li
    };
  };
  rows.push(mk('XSDD-20261120-00001', 0, today, today));
  rows.push(mk('XSDD-20261120-00002', 0, lm, '2026-01-15'));
  rows.push(mk('XSDD-20261001-00001', 0, '', '2026-01-15'));
  rows.push(mk('XSDD-20261001-00001', 1, '', '2026-01-15'));
  return rows;
}

test('G1 契约（零回归）：4 个非 order_inv 模块的筛选结果与上一版逐例相同', function () {
  const p = bootBoth();
  const fails = [];
  /* order_frame 用自造行（可控日期）；product/parts/delivery 用真实 TBL_ROWS */
  const rowsFor = function (app, m) {
    if (m === 'order_frame') return frameRows(app);
    return Array.from(app.run('TBL_ROWS[' + JSON.stringify(m) + ']||[]'));
  };
  ['order_frame', 'product', 'parts', 'delivery'].forEach(function (m) {
    const battery = filterBattery(p.now, m);
    assert.ok(battery.length >= 10, m + ' 的筛选电池应覆盖 10+ 种模式（实际 ' + battery.length + '）');
    battery.forEach(function (f) {
      const a = idsOf(runFilter(p.now, m, rowsFor(p.now, m), f), PROJ[m]).join(',');
      const b = idsOf(runFilter(p.prev, m, rowsFor(p.prev, m), f), PROJ[m]).join(',');
      if (a !== b) fails.push(m + ' ' + JSON.stringify(f) + '\n  本版：' + a + '\n  上版：' + b);
    });
    /* 空筛选态必须一致（兜底） */
    const a0 = idsOf(runFilter(p.now, m, rowsFor(p.now, m), {}), PROJ[m]).join(',');
    const b0 = idsOf(runFilter(p.prev, m, rowsFor(p.prev, m), {}), PROJ[m]).join(',');
    if (a0 !== b0) fails.push(m + ' 空筛选\n  本版：' + a0 + '\n  上版：' + b0);
  });
  assert.deepEqual(fails, [], '非 order_inv 模块筛选结果出现回归：\n' + fails.join('\n'));
  p.now.dispose();
  p.prev.dispose();
});

test('G2 契约（零回归）：4 个非 order_inv 模块的排序结果与上一版逐例相同', function () {
  const p = bootBoth();
  const fails = [];
  const rowsFor = function (app, m) {
    if (m === 'order_frame') return frameRows(app);
    return Array.from(app.run('TBL_ROWS[' + JSON.stringify(m) + ']||[]'));
  };
  ['order_frame', 'product', 'parts', 'delivery'].forEach(function (m) {
    const keys = Array.from(p.now.run('(TBL_SCHEMAS[' + JSON.stringify(m) + ']||[]).map(function(c){return c.key;})'));
    assert.ok(keys.length >= 5, m + ' 列数异常');
    keys.forEach(function (k) {
      [1, -1].forEach(function (dir) {
        const run = function (app) {
          app.sandbox.__qaRowsS = rowsFor(app, m);
          try {
            return app.run('tState(' + JSON.stringify(m) + ').sort={key:' + JSON.stringify(k) + ',dir:' + dir + '};' +
              'applyTable(' + JSON.stringify(m) + ',__qaRowsS)');
          } finally {
            delete app.sandbox.__qaRowsS;
          }
        };
        const a = idsOf(run(p.now), PROJ[m]).join(',');
        const b = idsOf(run(p.prev), PROJ[m]).join(',');
        if (a !== b) fails.push(m + ' 排序 ' + k + ' dir=' + dir + '\n  本版：' + a + '\n  上版：' + b);
        p.now.run('tState(' + JSON.stringify(m) + ').sort=null;');
        p.prev.run('tState(' + JSON.stringify(m) + ').sort=null;');
      });
    });
  });
  assert.deepEqual(fails, [], '非 order_inv 模块排序结果出现回归：\n' + fails.join('\n'));
  p.now.dispose();
  p.prev.dispose();
});

test('G3 契约（零回归）：面板 HTML 差分 —— .162 未改面板渲染 ⇒ 两版逐列**原始逐字相同**', function () {
  /* 【.162 同步说明】本用例在 .161 时比较的是「剥掉 data-noval / 数值列 onchange 后逐字相同」，
     因为那两类标记是 .161 新增。版本推进到 .162 后，这些标记已进入基线（上一版也有），
     而本版（.162）**完全没有触碰 openFilter / fpModeOptsHtml 等面板渲染代码** ⇒
     判据升级为更强的形态：两版面板 HTML **原始逐字相同**（不再需要归一化，也就无法靠归一化掩盖差异）。 */
  const p = bootBoth();
  /* 追加 order_inv（本版唯一改动模块）以便逐列核对 */
  p.now.run("renderOrderTable('order_inv',[],{});");
  p.prev.run("renderOrderTable('order_inv',[],{});");
  const mods = ['order_frame', 'order_inv', 'product', 'parts', 'delivery'];

  /* 无需归一化：本版对面板 HTML 零改动（见用例头说明） */

  let compared = 0;
  mods.forEach(function (m) {
    const cols = Array.from(p.now.run('(TBL_SCHEMAS[' + JSON.stringify(m) + ']||[]).map(function(c){return {key:c.key,type:c.type};})'))
      .map(function (c) { return { key: c.key, type: c.type }; });
    /* 两版列集合必须完全一致（列定义本身零回归） */
    assert.deepEqual(
      cols.map(function (c) { return c.key + ':' + c.type; }),
      Array.from(p.prev.run('(TBL_SCHEMAS[' + JSON.stringify(m) + ']||[]).map(function(c){return c.key+":"+c.type;})')),
      m + ' 的列集合/列类型必须与上一版一致');

    cols.forEach(function (c) {
      const isSem = (m === 'order_inv' && c.key === '_balPct');
      const aRaw = panelHtml(p.now, m, c.key);
      const bRaw = panelHtml(p.prev, m, c.key);
      compared++;

      /* ① 原始逐字相同（＝本版对面板渲染零改动，任何差异都是回归） */
      assert.equal(aRaw, bRaw,
        m + '.' + c.key + ' 面板出现差异（.162 未改面板渲染）\n  本版：' + aRaw + '\n  上版：' + bRaw);

      /* ② 前提自证：data-noval 的存在性与上一版一致（.161 引入，非本版新增；语义列两版都带） */
      assert.equal(/data-noval/.test(bRaw), /data-noval/.test(aRaw),
        m + '.' + c.key + ' data-noval 标记的有无必须与上一版一致');

      /* ③ data-noval 只许打在「不需要填值」的模式上：语义档 或 为空/不为空 */
      parseOptions(aRaw).forEach(function (o) {
        if (!o.noval) return;
        assert.ok(['inv_short', 'inv_over', 'is_empty', 'not_empty'].indexOf(o.value) >= 0,
          m + '.' + c.key + ' 的模式 ' + o.value + ' 不该带 data-noval');
      });

      /* ④ 数值列 onchange 现已是基线（.161 引入），两版必须一致；日期列仍须是 fpDateModeChange */
      if (c.type === 'number') {
        assert.equal(selectOnChange(bRaw), 'fpModeChange()', m + '.' + c.key + ' 上一版数值列已有 onchange（基线）');
        assert.equal(selectOnChange(aRaw), 'fpModeChange()', m + '.' + c.key + ' 数值列必须挂 fpModeChange()');
      } else if (c.type === 'date') {
        assert.equal(selectOnChange(aRaw), 'fpDateModeChange()',
          m + '.' + c.key + ' 日期列 onchange 必须仍为 fpDateModeChange()（不得被污染）');
        assert.equal(selectOnChange(bRaw), 'fpDateModeChange()', m + '.' + c.key + ' 日期列 onchange 与上一版一致');
      } else {
        /* 文本列有两条渲染路径：增强模式下拉（fpModeChange）与复选多选面板（无 select，selectOnChange=null）。
           两条都必须与上一版一致即可。 */
        assert.equal(selectOnChange(aRaw), selectOnChange(bRaw),
          m + '.' + c.key + ' 文本/选择列 onchange 必须与上一版一致');
        assert.equal(/fpDateModeChange/.test(aRaw), false,
          m + '.' + c.key + ' 文本列面板不得出现 fpDateModeChange（日期专用）');
      }

      /* ⑤ 语义列确实存在（两版都是 6 选项）——防「isSem 命中不到列、整段变成空跑」 */
      if (isSem) {
        const oa = parseOptions(aRaw), ob = parseOptions(bRaw);
        assert.equal(ob.length, 6, '上一版该列已是 6 个模式（.161 基线自证）');
        assert.equal(oa.length, 6, '本版该列必须仍是 6 个模式（4 + 2 语义档）');
      }
    });
  });
  assert.ok(compared >= 30, '面板差分覆盖面异常（仅 ' + compared + ' 列）');
  p.now.dispose();
  p.prev.dispose();
});

/* ================================================================
   §H 版本水印锚点
================================================================ */

const BUILD_JS_SRC = readRel('tests/harness/build.js');
const PPSHIFT_SRC = readRel('tests/qa.ppshift-advance.independent.test.js');
const PRODPLAN_QUERY_SRC = readRel('tests/qa.prodplan-query.independent.test.js');
const LAYOUT_INDEP_SRC = readRel('tests/layout.scoped.independent.test.js');
const LEDGER_INDEP_SRC = readRel('tests/qa.parts-ledger.independent.test.js');
const GUIDE_SRC = readRel('js/guide.js');
const README_SRC = readRel('README.md');

const BUILD_NO = String(build.BUILD).split('.')[1];
const BUILD_DATE = String(build.BUILD).split('.')[0];
const PREV_NO = String(build.PREV).split('.')[1];

/** 水印判据本体（可被 §J 变异注入复用） */
function probeWatermark(src) {
  assert.equal(countOcc(src, '>build ' + build.BUILD + '<'), 1,
    'index.html 权威水印必须恰 1 处（deploy.sh 按此提取版本）');
  assert.equal(countOcc(src, '>build ' + build.PREV + '<'), 0, '上一版权威水印必须 0 处');
  assert.equal((src.match(build.buildAnyRe(build.PREV)) || []).length, 0, '上一版任意形态必须 0 处');
  assert.equal((src.match(build.buildMarkRe(build.BUILD)) || []).length, 1, 'buildMarkRe 必须恰命中 1 处');
  /* 反虚设：不存在的版本号必须命中 0（否则正则宽松到不可用） */
  assert.equal((src.match(build.buildMarkRe('2099-01-01.999')) || []).length, 0, '反虚设：伪版本应命中 0');
}

test('H1 契约：锚点① index.html 权威水印（并用水印自证工作树==已提交版本）', function () {
  probeWatermark(INDEX_SRC);
  assert.equal(md5(INDEX_SRC), md5(gitShow('HEAD', 'index.html')),
    '工作树 index.html 必须与 HEAD 一致（有未提交改动则本报告的指纹不可信）');
  /* BUILD 与 git 提交主题独立互证（不依赖 index.html，防自我循环） */
  const subjects = git(['log', '--format=%s', '-n', '50']).split('\n');
  assert.equal(subjects.filter(function (s) { return s.indexOf('build ' + build.BUILD) === 0; }).length, 1,
    '必须恰有一条提交主题以 build ' + build.BUILD + ' 开头（版本号与发布提交互证）');
  assert.notEqual(PREV_REV, HEAD, '上一版修订不得等于 HEAD');
});

test('H2 契约：锚点② harness/build.js 的 BUILD/PREV 为手写字面量且不得反推', function () {
  const code = stripComments(BUILD_JS_SRC);
  assert.equal(countOcc(code, "const BUILD = '" + build.BUILD + "';"), 1,
    'build.js 必须手写 const BUILD = <本版>');
  assert.equal(countOcc(code, "const PREV = '" + build.PREV + "';"), 1,
    'build.js 必须手写 const PREV = <上一版>');
  /* 禁止从 index.html 反推（否则断言退化为恒真） */
  assert.equal(/readFileSync|index\.html|require\s*\(/.test(code), false,
    'build.js 不得读取 index.html 或其他模块（BUILD 必须来自手写字面量）');
});

test('H3 契约：锚点③④ 两个 independent 测试的 §E2 字面量副本已同步', function () {
  assert.ok(PPSHIFT_SRC.indexOf("assert.equal(build.BUILD, '" + build.BUILD + "'") >= 0, '③ qa.ppshift §E2 BUILD');
  assert.ok(PPSHIFT_SRC.indexOf("assert.equal(build.PREV, '" + build.PREV + "'") >= 0, '③ qa.ppshift §E2 PREV');
  assert.ok(PRODPLAN_QUERY_SRC.indexOf("assert.equal(build.BUILD, '" + build.BUILD + "'") >= 0, '④ qa.prodplan-query §E2 BUILD');
  assert.ok(PRODPLAN_QUERY_SRC.indexOf("assert.equal(build.PREV, '" + build.PREV + "'") >= 0, '④ qa.prodplan-query §E2 PREV');
});

test('H4 契约：锚点④(§E4)+⑥（guide.js 文首）版本行同步', function () {
  const line = BUILD_DATE + '（build .' + BUILD_NO + '）';
  assert.ok(PRODPLAN_QUERY_SRC.indexOf(line) >= 0, '④ qa.prodplan-query §E4 必须断言 guide 版本行为 ' + line);
  const head = GUIDE_SRC.split('\n').slice(0, 8).join('\n');
  assert.ok(head.indexOf('更新：' + line) >= 0, '⑥ js/guide.js 文首必须为 更新：' + line);
  assert.equal(GUIDE_SRC.indexOf('更新：' + BUILD_DATE + '（build .' + PREV_NO + '）'), -1,
    'guide.js 不得残留上一版的更新行');
});

test('H5 契约：锚点⑤ layout.scoped §C5 与 ⑦ README.md 已同步', function () {
  assert.ok(LAYOUT_INDEP_SRC.indexOf('>build ' + String(build.BUILD).replace(/\./g, '\\.') + '<') >= 0,
    '⑤ layout.scoped §C5 水印正则未同步');
  assert.ok(LAYOUT_INDEP_SRC.indexOf("BUILD.BUILD, '" + build.BUILD + "'") >= 0, '⑤ §C5 BUILD 未同步');
  assert.ok(LAYOUT_INDEP_SRC.indexOf("BUILD.PREV, '" + build.PREV + "'") >= 0, '⑤ §C5 PREV 未同步');
  assert.ok(README_SRC.indexOf('build ' + build.BUILD) >= 0, '⑦ README.md 当前版本未同步');
});

test('H6 契约（版本纪律）：完整版本号只许出现在水印/构建常量处', function () {
  /* index.html：完整版本号全工程恰 1 处（即水印）；注释里只许 `build .NNN` 短令牌 */
  assert.equal(countOcc(INDEX_SRC, build.BUILD), 1,
    'index.html 中完整版本号必须恰 1 处（实际 ' + countOcc(INDEX_SRC, build.BUILD) + ' 处）');
  assert.equal(countOcc(INDEX_SRC, 'build ' + build.BUILD), 1,
    '「build <完整版本号>」也必许恰 1 处（注释里请用 build .NNN 短令牌）');
  /* 短令牌必须真的写在改动点（>=3 处）——否则说明注释没留版本标记 */
  assert.ok(countOcc(INDEX_SRC, 'build .' + BUILD_NO) >= 3,
    '本版改动点必须留 build .' + BUILD_NO + ' 短令牌（实际 ' + countOcc(INDEX_SRC, 'build .' + BUILD_NO) + ' 处）');
  /* guide.js 正文只许短令牌 */
  assert.equal(countOcc(GUIDE_SRC, build.BUILD), 0, 'guide.js 正文不得写完整版本号（只许 build .NNN）');
  /* 反虚设自检：把水印改掉后判据必须能红（见 §J M_G） */
});

test('H7 裁决：qa.parts-ledger 的「第 9 处锚点」同步是**必要**的（不是过度）', function () {
  /* 该文件的 const BUILD/PREV 被 §F1/F2/F3 等断言当作**输入**使用，
     例如 §F1 断言 `countOcc(INDEX_SRC, '>build '+BUILD+'<') === 1`。
     若不随版本推进更新：BUILD 仍是上一版 ⇒ 该断言值恒为 0 ⇒ 全量回归必然假失败。
     故它属于「持有副本 ⇒ 必须同步」的白名单成员，同步是必要的。 */
  assert.ok(LEDGER_INDEP_SRC.indexOf("const BUILD = '" + build.BUILD + "';") >= 0,
    'qa.parts-ledger 必须持有并同步本版 BUILD 字面量（其 §F1 断言以它为输入）');
  assert.ok(LEDGER_INDEP_SRC.indexOf("const PREV = '" + build.PREV + "';") >= 0,
    'qa.parts-ledger 必须持有并同步本版 PREV 字面量');
  /* 被用作输入的证据：文件里必须存在以 BUILD 为参数的水印断言 */
  assert.ok(LEDGER_INDEP_SRC.indexOf("'>build ' + BUILD + '<'") >= 0,
    'qa.parts-ledger 的水印断言必须以 const BUILD 为输入（这正是"必须同步"的依据）');
  /* 治理文档（validate.159 §D3）必须把该文件列进白名单，否则它会被「禁止持有」扫描判红 */
  const guard = readRel('tests/qa.parts-ledger.validate.159.test.js');
  assert.ok(guard.indexOf("'qa.parts-ledger.independent.test.js'") >= 0,
    'validate.159 §D3 的 ANCHOR_HOLDERS 必须包含 qa.parts-ledger（与上一条互证）');
});

/* ================================================================
   §I applyFilt 残留值 / thCol 漏斗点亮
   【.162 同步】本节 .161 时固化的是「缺陷/折衷（可延后）」；
   .162 修复后三条全部**翻转为契约**（原意与翻转依据逐条写在用例内，可追溯）。
================================================================ */

test('I1 契约：语义档写入时 applyFilt 必须清空残留 val（.161 为脏值折衷，.162 修复）', function () {
  const app = bootInv();
  app.run('renderContent=function(){};');
  /* ① 引擎面（.161 已成立、本版不变）：残留 val 不得影响结果集 —— 语义档只走 sem.test */
  const f = { _balPct: { mode: 'inv_short', val: '100' } };   /* 手工构造"先填 100 再切语义档"的脏状态 */
  const dirty = idsOf(runFilter(app, 'order_inv', CORE_ROWS, f)).sort();
  const clean = semHitIds(app, CORE_ROWS, 'inv_short').sort();
  assert.deepEqual(dirty, clean,
    '残留 val 不得影响结果集（引擎对语义档完全忽略 val）— 本版仍然成立（双保险）');

  /* ② 写入面（.162 新契约）：走真实 applyFilt 链路后 f.val 必须被清空 */
  app.run("tState('order_inv').filters={_balPct:{mode:'gte',val:'100'}};");
  assert.equal(app.run("tState('order_inv').filters._balPct.val"), '100', '前提：先有一个数值模式带 val');
  driveApplyFilt(app, 'order_inv', '_balPct', 'inv_short', 100);
  const st = app.run("JSON.stringify(tState('order_inv').filters._balPct)");
  assert.equal(JSON.parse(st).mode, 'inv_short', '模式必须切到 inv_short');
  assert.equal(JSON.parse(st).val, '',
    '【.162 契约】语义档写入后 f.val 必须为 \'\'（.161 会残留 100，二次打开面板时回显脏值）。实际：' + st);
  assert.equal(JSON.parse(st).from, undefined, '语义档不得残留 from（同类脏值一并清）');
  assert.equal(JSON.parse(st).to, undefined, '语义档不得残留 to（同类脏值一并清）');
  assert.equal(/100/.test(app.run("filterBar('order_inv')")), false, 'chip 不得拼残留数值');

  /* ③ 范围守卫：清脏值只对**语义档**生效，文本列「为空」的既有 val 行为不动 */
  app.run("tState('order_inv').filters={};renderOrderTable('order_inv',[],{});");
  driveApplyFilt(app, 'order_inv', 'id', 'is_empty', 'KC');
  assert.equal(app.run("tState('order_inv').filters.id.val"), 'KC',
    '文本列 is_empty 的 f.val 行为必须保持不变（本轮只清语义档，不动既有模式）');
  app.dispose();
});

test('I2 契约：语义档不再把残留值回显进隐藏的数值框（.162 翻转）', function () {
  const app = bootInv();
  app.run('renderContent=function(){};');
  /* .161 现状：手工灌 {mode:'inv_short',val:'100'} 时面板会把 100 回填进 fp_val。
     .162 起真实链路不会产生这种状态（applyFilt 已清 val），
     故此处改为：走真实链路后重开面板，fp_val 必须是空值。 */
  driveApplyFilt(app, 'order_inv', '_balPct', 'inv_short', 100);
  assert.equal(app.run("tState('order_inv').filters._balPct.val"), '', '前提：真实链路已清 val');
  const html = panelHtml(app, 'order_inv', '_balPct');
  assert.ok(/<input type="number" id="fp_val" value=""/.test(html),
    '重开面板时隐藏的数值框必须是空值（不得回显 100）');
  const opts = parseOptions(html);
  assert.equal(opts[opts.length - 2].selected, true, '面板应回显当前语义档为 selected（inv_short）');
  /* 「清除」路径不受影响 */
  app.run("clearFilt('order_inv','_balPct')");
  const html2 = panelHtml(app, 'order_inv', '_balPct');
  assert.ok(/<input type="number" id="fp_val" value=""/.test(html2), '清除后重开面板仍是干净空值');
  app.dispose();
});

test('I3 契约：语义筛选生效时列头漏斗图标必须点亮（.161 曾为缺陷，.162 修复后翻转）', function () {
  /* 【.161 曾为缺陷】filterBar 的 chip 放行与 thCol 的「漏斗点亮」是两份各自写的判据，
     只修了前者 ⇒ 语义档（val 恒空）下 chip 出现但图标不亮（用户看不出该列已有筛选）。
     【.162 修复】两处判据合并为单一来源 `isSemFiltMode`，本节断言随之翻转为契约：
     语义档生效（val 空）时图标**必须**点亮。 */
  const app = bootInv();
  const icoOn = function (filters) {
    app.run("tState('order_inv').filters=" + filters + ';');
    const th = app.run("(function(){var c=TBL_SCHEMAS.order_inv.find(function(x){return x.key==='_balPct';});" +
      "return thCol('order_inv',c);})()");
    return /filt-ico on/.test(th);
  };
  assert.equal(icoOn("{_balPct:{mode:'inv_short',val:''}}"), true,
    '【.162 契约】语义档 inv_short（val 空）必须点亮漏斗图标');
  assert.equal(icoOn("{_balPct:{mode:'inv_over',val:''}}"), true,
    '【.162 契约】语义档 inv_over（val 空）同样必须点亮');
  assert.equal(icoOn('{}'), false, '无筛选时不得点亮（反假守卫：防止 act 恒真）');
  assert.equal(icoOn("{_balPct:{mode:'gte',val:'100'}}"), true,
    '对照：普通数值模式的图标点亮逻辑未受影响');
  assert.equal(icoOn("{_balPct:{mode:'gte',val:''}}"), false,
    '对照：数值模式但 val 留空 = 未生效 ⇒ 仍不得点亮（既有语义不变）');
  app.dispose();
});

/* ================================================================
   §J 变异注入（硬约束：锚点命中数恰 1；注入必须生效；探针必须变红）
================================================================ */

/** 单次替换：锚点命中数必须恰 1，否则直接报错（禁止多命中取首、禁止命中 0 静默跳过） */
function replaceOnce(code, anchor, repl) {
  const n = countOcc(code, anchor);
  assert.equal(n, 1, '变异锚点必须恰命中 1 处（实际 ' + n + ' 处）；锚点=' + JSON.stringify(anchor));
  return code.replace(anchor, repl);
}

/** 用改写后的主内联脚本装载（transformMain 钩子） */
function bootMutated(mutFn) {
  return createApp({
    installRecorder: false,
    quietConsole: true,
    transformMain: mutFn
  });
}

/* ---- 可复用探针（干净版必须通过；变异版必须变红） ---- */

const PROBE = {};

/** B1：语义模式必须真正减少行数 */
PROBE.notSkipped = function (app) {
  app.run("renderOrderTable('order_inv',[],{});");
  app.sandbox.__qaRowsA = CORE_ROWS;
  try {
    const all = idsOf(app.run("tState('order_inv').filters={};filterRows('order_inv',__qaRowsA)"));
    const short = idsOf(app.run("tState('order_inv').filters={_balPct:{mode:'inv_short',val:''}};" +
      "filterRows('order_inv',__qaRowsA)"));
    assert.equal(all.length, 6, '数据前提：全量 6 行');
    assert.ok(short.length < all.length,
      '反假守卫：语义模式必须真正减少行数（实际 ' + short.length + '/' + all.length + '）');
    assert.deepEqual(short.sort(), ['R1', 'R2'], '命中集合必须为 R1+R2');
  } finally {
    delete app.sandbox.__qaRowsA;
  }
};

/** B2：命中集合必须与独立口径一致 */
PROBE.matchSpec = function (app) {
  app.run("renderOrderTable('order_inv',[],{});");
  app.sandbox.__qaRowsA = CORE_ROWS;
  try {
    const short = idsOf(app.run("tState('order_inv').filters={_balPct:{mode:'inv_short',val:''}};" +
      "filterRows('order_inv',__qaRowsA)")).sort();
    const want = CORE_ROWS.filter(function (r) {
      return expectShort(r.item.deliveredQty, r.item.stockMin, r.item.stockMax);
    }).map(function (r) { return r.order.id; }).sort();
    assert.deepEqual(short, want, 'inv_short 命中集合必须等于独立口径（红/黄标）');
  } finally {
    delete app.sandbox.__qaRowsA;
  }
};

/** C2 边界：结余<0 且未设最小库存量必须入选 */
PROBE.redWithoutMin = function (app) {
  app.run("renderOrderTable('order_inv',[],{});");
  app.sandbox.__qaRowC = [invRow('N1', { deliveredQty: -5, stockMin: '', stockMax: '' })];
  try {
    const got = idsOf(app.run("tState('order_inv').filters={_balPct:{mode:'inv_short',val:''}};" +
      "filterRows('order_inv',__qaRowC)"));
    assert.deepEqual(got, ['N1'],
      '结余为负且未设下限的行必须入选 inv_short（用户原话「红色和黄色警告标」）');
  } finally {
    delete app.sandbox.__qaRowC;
  }
};

/** F1：语义模式必须产出 chip */
PROBE.chip = function (app) {
  app.run("renderOrderTable('order_inv',[],{});");
  app.run("tState('order_inv').filters={_balPct:{mode:'inv_short',val:''}};");
  const bar = app.run("filterBar('order_inv')");
  assert.ok(bar.length > 0, '语义筛选必须产出 chip（否则「筛了却看不到、也清不掉」）');
  assert.ok(bar.indexOf('低于最小库存量') >= 0, 'chip 必须含档位文案');
};

/** D1：语义档必须带 data-noval（数值列） */
PROBE.dataNoval = function (app) {
  app.run("renderOrderTable('order_inv',[],{});");
  const html = panelHtml(app, 'order_inv', '_balPct');
  const opts = parseOptions(html);
  assert.equal(opts.length, 6, '结余进度列必须 6 个选项（实际 ' + opts.length + '）');
  const semOpts = opts.filter(function (o) { return o.value === 'inv_short' || o.value === 'inv_over'; });
  assert.equal(semOpts.length, 2, '必须存在两个语义档选项');
  assert.deepEqual(semOpts.map(function (o) { return o.noval; }), [true, true],
    '两个语义档选项必须带 data-noval="1"（否则选中后数值框不会隐藏）');
};

/** D4：语义档选中后 fp_val 必须隐藏 */
PROBE.semHidesVal = function (app) {
  app.run("renderOrderTable('order_inv',[],{});");
  const opts = parseOptions(panelHtml(app, 'order_inv', '_balPct'));
  const i = opts.map(function (o) { return o.value; }).indexOf('inv_short');
  assert.ok(i >= 0, '面板必须含 inv_short 选项');
  const disp = driveFpModeChange(app, opts, i);
  assert.equal(disp, 'none', '选中 inv_short 后 fp_val 必须隐藏（实际 display=' + JSON.stringify(disp) + '）');
};

test('J0 自检：6 个探针 + 水印探针在干净版本上必须全部通过（否则变异用例的红是假象）', function () {
  const clean = bootAll();
  assert.doesNotThrow(function () { PROBE.notSkipped(clean); }, '探针 notSkipped 在干净版必须通过');
  assert.doesNotThrow(function () { PROBE.matchSpec(clean); }, '探针 matchSpec 在干净版必须通过');
  assert.doesNotThrow(function () { PROBE.redWithoutMin(clean); }, '探针 redWithoutMin 在干净版必须通过');
  assert.doesNotThrow(function () { PROBE.chip(clean); }, '探针 chip 在干净版必须通过');
  assert.doesNotThrow(function () { PROBE.dataNoval(clean); }, '探针 dataNoval 在干净版必须通过');
  assert.doesNotThrow(function () { PROBE.semHidesVal(clean); }, '探针 semHidesVal 在干净版必须通过');
  assert.doesNotThrow(function () { probeWatermark(INDEX_SRC); }, '水印探针在干净版必须通过');
  clean.dispose();
});

const MUTATIONS = [
  {
    id: 'M_A',
    desc: '删掉 valFreeMode 的 ||!!sem（闸门恢复旧序）⇒ 语义模式被静默跳过',
    /* 【.167 同步】判据已收敛为单源 `isValFreeFiltMode(f)`（D11 修复），原锚点
       `||dateQuickMode(f)||!!sem;` 不再存在。新锚点仍在证明同一件事：
       去掉 `||!!sem` ⇒ 语义档在闸门处被静默跳过。 */
    anchor: 'isValFreeFiltMode(f)||!!sem;',
    repl: 'isValFreeFiltMode(f);',
    probe: 'notSkipped'
  },
  {
    id: 'M_B',
    desc: '把 sem.test(r) 短路掉（只看列被声明、不看行）⇒ 命中集合失真',
    anchor: 'if(sem){if(!sem.test(r))return false;continue;}',
    repl: 'if(sem){continue;}',
    probe: 'matchSpec'
  },
  {
    id: 'M_C',
    desc: 'invShortOf 改成「严格 结余<最小 且 最小>0」（用户明确否决的口径）',
    anchor: "function invShortOf(v,min,max){const lv=invStockLevel(v,min,max);return lv==='red'||lv==='amber';}",
    repl: 'function invShortOf(v,min,max){return num(v)<num(min)&&num(min)>0;}',
    probe: 'redWithoutMin'
  },
  {
    id: 'M_D',
    desc: 'filterBar 白名单不再按 semFilters 放行 ⇒ chip 与「清除全部」消失',
    anchor: 'return !!semModeOf(k,f.mode);',
    repl: 'return false;',
    probe: 'chip'
  },
  {
    id: 'M_E',
    desc: 'fpModeChange 回退为硬编码 is_empty/not_empty ⇒ 语义档不再隐藏数值框',
    anchor: "const o=m.options[m.selectedIndex];\n  v.style.display=(o&&o.dataset&&o.dataset.noval)?'none':'';",
    repl: "v.style.display=(m.value==='is_empty'||m.value==='not_empty')?'none':'';",
    probe: 'semHidesVal'
  },
  {
    id: 'M_F',
    desc: '数值列不再给语义档打 data-noval ⇒ 选中后数值框仍显示',
    anchor: 'const nNoVal={};semDefs.forEach(function(x){nNoVal[x.mode]=1;});',
    repl: 'const nNoVal={};',
    probe: 'dataNoval'
  }
];

MUTATIONS.forEach(function (mut) {
  test(titleOfMutation(mut), function () {
    /* 前提：干净版该探针必须通过（防“探针本来就红”导致变异用例白给） */
    const clean = bootAll();
    assert.doesNotThrow(function () { PROBE[mut.probe](clean); },
      '前提失败：干净版上探针 ' + mut.probe + ' 就已失败，变异结论不可信');
    clean.dispose();

    /* 注入：锚点命中数必须恰 1（replaceOnce 内部报错）；
       同时把改写后的源码留在闭包里，用于「注入必须生效」的独立校验 */
    let hits = null;
    let transformed = null;
    const mutated = bootMutated(function (code) {
      hits = countOcc(code, mut.anchor);
      transformed = replaceOnce(code, mut.anchor, mut.repl);
      return transformed;
    });
    assert.equal(hits, 1, mut.id + ' 锚点命中数必须恰为 1（实际 ' + hits + '）');
    /* 注入必须生效：改写后的源码里原锚点必须消失、且变异体确实出现
       （禁止「命中 0 静默跳过」或「改了但没落到装载的源码上」） */
    assert.equal(typeof transformed, 'string', mut.id + ' transformMain 必须真的执行过');
    assert.equal(countOcc(transformed, mut.anchor), 0, mut.id + ' 注入必须生效（原锚点不得残留）');
    assert.ok(countOcc(transformed, mut.repl) >= 1, mut.id + ' 变异体必须出现在装载的源码里');
    assert.equal(mutated.hasGlobal('TBL_SCHEMAS'), true, mut.id + ' 变异版必须能正常装载（语法未被破坏）');

    /* 断言探针变红（且失败原因来自探针断言，而不是装载异常） */
    let err = null;
    try {
      PROBE[mut.probe](mutated);
    } catch (e) {
      err = e;
    }
    assert.ok(err, mut.id + ' 注入后探针 ' + mut.probe + ' 必须变红（仍通过 ⇒ 该守卫是恒真的摆设）');
    assert.ok(err && err.name === 'AssertionError',
      mut.id + ' 失败必须来自断言（实际 ' + (err && err.name) + ': ' + (err && err.message) + '）');
    mutated.dispose();
  });
});

function titleOfMutation(mut) {
  return mut.id + ' 变异注入：' + mut.desc + ' → 探针 ' + mut.probe + ' 必须变红';
}

test('M_G 变异注入：把权威水印改回上一版 ⇒ 水印探针必须变红（含锚点唯一性约束）', function () {
  const anchor = '>build ' + build.BUILD + '<';
  const n = countOcc(INDEX_SRC, anchor);
  assert.equal(n, 1, 'M_G 锚点必须恰命中 1 处（实际 ' + n + '）');
  const mutatedHtml = INDEX_SRC.replace(anchor, '>build ' + build.PREV + '<');
  assert.equal(countOcc(mutatedHtml, anchor), 0, 'M_G 注入必须生效（原水印不得残留）');

  assert.doesNotThrow(function () { probeWatermark(INDEX_SRC); }, '前提：干净源码的水印探针必须通过');
  let err = null;
  try {
    probeWatermark(mutatedHtml);
  } catch (e) {
    err = e;
  }
  assert.ok(err && err.name === 'AssertionError', 'M_G 注入后水印探针必须变红（实际 ' + (err && err.name) + '）');

  /* 附加：变异后的 HTML 仍可被沙箱装载（证明变异落在水印而非破坏脚本） */
  const app = boot({ indexHtml: mutatedHtml });
  assert.equal(app.run('1+1'), 2, '变异后的 HTML 必须仍可装载（变异只落在水印 div 上）');
  app.dispose();
});
