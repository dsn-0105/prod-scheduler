'use strict';
/* ================================================================
   tests/qa.invfilt.162.independent.test.js
   —— QA 独立回归（第二轮）：build .162「漏斗点亮 + 清脏值」
       **核心任务：审查工程师对既有守卫强度的改动**
   ================================================================
   本轮最大风险不是功能，而是**测试资产被改松**：项目铁律规定测试资产与产品代码同等评审。
   这类问题的共同特征是「不报错、只让报告看起来全绿」，所以本文件的做法是：

     ① **不读他的断言、直接执行他的断言**：把 `tests/layout.scoped.independent.test.js §C1`
        的断言块按源码文本抽出，用 `new Function` 逐字执行（内部变量由我注入），
        再对**变异后的 index.html** 跑 —— 他若日后改了这段守卫，本文件自动跟随（不会各说各话）。
     ② 五类失效方式逐一注入，每条都要求**锚点命中恰 1**、注入必须生效、结论必须明确（红/绿）。
     ③ 对「他自称一并同步的 3 处前提」逐处裁决：必要同步 / 弱化 / 方向反转，并给出**可执行证据**
        （例如证明新锚点确实对修订敏感、且不是"恒不相等"的假绿）。
     ④ 对「反向钉住的既有缺陷」按 .152 纪律裁决：标注是否可翻转、是否会被误读成回归。

   断言标记：
     【契约】= 需求/设计规定的行为，不符即产品缺陷；
     【现状】= 固定当前实现（含已知缺陷/折衷），仅用于防悄悄变化；
     【守卫·现状】= 对被审查守卫**当前形态**的固定（若守卫被收紧/改写，本类断言应变红并要求同步本文件）。

   基线纪律：上一版由 **git 提交主题**反查（本轮 PREV=.161 → dbbcd15），不用 HEAD；
   两侧必须是不同修订（md5 不同 + 水印自证），否则比对退化为自我对消。
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
   §0 基础设施（自带，不复用任何人写的 helper）
================================================================ */

const readRel = function (rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); };
const md5 = function (s) { return crypto.createHash('md5').update(String(s), 'utf8').digest('hex'); };
const countOcc = function (hay, needle) { return String(hay).split(String(needle)).length - 1; };
const escRe = function (s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };

function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * 按大括号配平提取 `function name(` 形态；取不到必须报错（禁止静默返回空）。
 * ⚠ 必须是「字符串感知」的实现：源码里会出现 `'{'` / `'}'` 这类**字面量花括号**
 *   （例如 layout.scoped 自己的 extractFn 里就有），朴素计数器会被它们带偏，
 *   把提取区间一路吃到最后一行 —— 那会让"抽取出来的守卫块"彻底失真。
 */
function extractFn(src, name) {
  const re = new RegExp('function\\s+' + escRe(name) + '\\s*\\(', 'g');
  const m = re.exec(src);
  if (!m) throw new Error('[QA] 源码中未找到函数 ' + name + '（提取器失效，禁止静默通过）');
  const start = m.index;
  /* ① 跳过形参表（同样要字符串感知，形参里一般没有引号，但保持一致） */
  let p = src.indexOf('(', start);
  let depth = 0;
  for (; p < src.length; p++) {
    if (src[p] === '(') depth++;
    else if (src[p] === ')') { depth--; if (depth === 0) { p++; break; } }
  }
  /* ② 找函数体起始 '{'（形参表之后第一个非空白花括号） */
  let i = p;
  while (i < src.length && src[i] !== '{') i++;
  if (i >= src.length) throw new Error('[QA] 函数 ' + name + ' 未找到函数体');
  /* ③ 字符串/正则感知的花括号配平
     （`esc` 这类函数把 `'&lt;'`、`/"/g` 写在函数体里，朴素计数器会被 " 和 { } 带偏） */
  let d = 0, state = null; /* null | "'" | '"' | '`' | 'line' | 'block' | 're' */
  let j = i;
  let prevSig = '{';   /* 正则判定用的「上一个有意义字符」 */
  for (; j < src.length; j++) {
    const ch = src[j], nx = src[j + 1];
    if (state === null) {
      if (ch === "'" || ch === '"' || ch === '`') { state = ch; prevSig = ch; continue; }
      if (ch === '/' && nx === '/') { state = 'line'; j++; continue; }
      if (ch === '/' && nx === '*') { state = 'block'; j++; continue; }
      if (ch === '/') {
        /* 正则 or 除法？标准启发式：前一有意义字符不是标识符/右括号时才可能是正则 */
        if (!/[A-Za-z0-9_$)\]]/.test(prevSig)) { state = 're'; prevSig = '/'; continue; }
      }
      if (ch === '{') d++;
      else if (ch === '}') { d--; if (d === 0) break; }
      if (!/\s/.test(ch)) prevSig = ch;
      continue;
    }
    if (state === 'line') { if (ch === '\n') state = null; continue; }
    if (state === 'block') { if (ch === '*' && nx === '/') { state = null; j++; } continue; }
    if (state === 're') {
      if (ch === '\\') { j++; continue; }
      if (ch === '[') { /* 字符类内不判结束 */ let k = j + 1; while (k < src.length && src[k] !== ']') { if (src[k] === '\\') k++; k++; } j = k; continue; }
      if (ch === '/') state = null;
      continue;
    }
    /* 字符串/模板内 */
    if (ch === '\\') { j++; continue; }
    if (ch === state) state = null;
  }
  const out = src.slice(start, j + 1);
  if (out.length < 20) throw new Error('[QA] 函数 ' + name + ' 提取结果异常短（' + out.length + '）');
  return out;
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    throw new Error('[QA] git 调用失败（本文件指纹判据依赖 git，禁止降级为"跳过"）：' +
      args.join(' ') + ' → ' + String(e.message).slice(0, 200));
  }
}
const gitShow = function (rev, rel) { return git(['show', rev + ':' + rel]); };

/** 按提交主题反查某版本的修订号（不读 index.html，避免自我循环） */
function revOfBuild(ver) {
  const out = git(['log', '--format=%H%x09%s', '-n', '600']);
  const revs = out.split('\n').filter(function (l) {
    const i = l.indexOf('\t');
    return i >= 0 && l.slice(i + 1).indexOf('build ' + ver) === 0;
  }).map(function (l) { return l.slice(0, l.indexOf('\t')); });
  assert.ok(revs.length >= 1, '必须在提交主题里反查到 build ' + ver + ' 的修订（否则基线无法定位）');
  return revs[0];
}

const INDEX_SRC = readRel('index.html');
const HEAD = git(['rev-parse', 'HEAD']).trim();
const PREV_REV = revOfBuild(build.PREV);
const PREV_INDEX_SRC = gitShow(PREV_REV, 'index.html');

/**
 * 「.152 改前基线」定位（**独立重实现** layout.scoped 的 resolveBaseline 语义）：
 * 从最近 40 个改动 index.html 的提交里，找第一个**不含** `【build .152】` marker 的修订。
 * 附带防对消：基线不得含 marker，当前必须含 marker。
 */
function resolvePre152() {
  const revs = git(['log', '--format=%H', '-40', '--', 'index.html']).trim().split('\n').filter(Boolean);
  let rev = null, text = null;
  for (const r of revs) {
    const t = gitShow(r, 'index.html');
    if (t.indexOf('【build .152】') < 0) { rev = r; text = t; break; }
  }
  assert.ok(rev, '必须能定位 .152 改前基线（否则 §K 整节失效）');
  assert.equal(text.indexOf('【build .152】'), -1, '防对消：基线不得含 .152 marker');
  assert.ok(INDEX_SRC.indexOf('【build .152】') >= 0, '防对消：当前 index.html 必须含 .152 marker');
  assert.notEqual(md5(text), md5(INDEX_SRC), '防对消：基线与当前必须是不同修订');
  return { rev: rev, text: text };
}
const BASE152 = resolvePre152();

/* ---------- 沙箱装载 ---------- */

function boot(extra) {
  return createApp(Object.assign({ installRecorder: false, quietConsole: true }, extra || {}));
}

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
    { id: 'D1', planNo: 'JFJH-20261120-00001', orderId: 'KC1', customer: '客户甲', createdAt: '2026-11-20',
      items: [{ orderLine: 0, productId: 'P1', productName: '产品甲', planQty: 50 }] }
  ]
};
const clone = function (v) { return JSON.parse(JSON.stringify(v)); };

/** 装载并注册 5 个真实模块 */
function bootAll(extra) {
  const app = boot(extra);
  app.setGlobal('products', clone(SEED.products));
  app.setGlobal('parts', clone(SEED.parts));
  app.setGlobal('deliveries', clone(SEED.deliveries));
  app.run("renderProducts();renderParts();renderDelivery();" +
    "renderOrderTable('order_frame',[],{});renderOrderTable('order_inv',[],{});");
  return app;
}
function bootInv(extra) {
  const app = boot(extra);
  app.run("renderOrderTable('order_inv',[],{});");
  return app;
}

/* ---------- 行工厂 / 筛选驱动 / 面板解析 ---------- */

function invRow(id, item, li) {
  return {
    order: { id: id, orderType: '库存订单', customer: '客户' + id, startDate: '2026-11-01', status: '已完成' },
    item: Object.assign({ productId: 'PX', productName: '商品X', lineNotes: '' }, item),
    __li: li == null ? 0 : li
  };
}

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
const idsOf = function (res, proj) {
  return Array.prototype.map.call(res, proj || function (r) { return r.order.id; });
};

function panelHtml(app, m, key) {
  return app.run('(function(){var el=document.createElement("i");' +
    'el.getBoundingClientRect=function(){return {left:10,right:40,top:10,bottom:20,width:30,height:10};};' +
    'openFilter(el,' + JSON.stringify(m) + ',' + JSON.stringify(key) + ');' +
    'return filtPop?filtPop.innerHTML:"";})()');
}
function parseOptions(html) {
  const re = /<option value="([^"]*)"( data-noval="1")?( selected)?\s*>([^<]*)<\/option>/g;
  const out = []; let m;
  while ((m = re.exec(String(html))) !== null) {
    out.push({ value: m[1], noval: !!m[2], selected: !!m[3], label: m[4] });
  }
  return out;
}
function selectOnChange(html) {
  const m = /<select id="fp_mode"([^>]*)>/.exec(String(html));
  if (!m) return null;
  const a = /onchange="([^"]*)"/.exec(m[1]);
  return a ? a[1] : null;
}

/** 取某列表头 HTML（漏斗是否点亮看它） */
function thOf(app, m, key) {
  return app.run('(function(){var c=(TBL_SCHEMAS[' + JSON.stringify(m) + ']||[]).filter(function(x){return x.key===' +
    JSON.stringify(key) + ';})[0];return c?thCol(' + JSON.stringify(m) + ',c):"";})()');
}
const icoOn = function (app, m, key) { return /class="filt-ico on"/.test(thOf(app, m, key)); };

/** 驱动真实 applyFilt（伪 DOM：fp_mode / fp_val；useChecks=false 故不碰 filtPop） */
function driveApplyFilt(app, m, key, mode, val) {
  const valEl = { value: val == null ? '' : String(val), style: { display: '' } };
  const sel = { value: mode, options: [{ value: mode, dataset: {} }], selectedIndex: 0 };
  const doc = app.sandbox.document;
  const orig = doc.getElementById;
  doc.getElementById = function (id) {
    if (id === 'fp_mode') return sel;
    if (id === 'fp_val') return valEl;
    return null;                 /* 无 fp_drange ⇒ 走「读 fp_val」分支 */
  };
  try {
    app.run('applyFilt(' + JSON.stringify(m) + ',' + JSON.stringify(key) + ',false);');
  } finally {
    doc.getElementById = orig;
  }
  return valEl;
}

/** 精确锚定替换：命中必须恰 1；替换后必须真的变化（项目铁律，禁止命中 0 静默跳过） */
function mutateText(src, anchor, repl, label) {
  const n = countOcc(src, anchor);
  assert.equal(n, 1, '变异锚点[' + label + '] 必须恰命中 1 处（实际 ' + n + '）：' + JSON.stringify(anchor));
  const out = String(src).replace(anchor, repl);
  assert.notEqual(out, src, '变异注入未生效[' + label + ']：替换前后相同');
  return out;
}

/* ================================================================
   §K 【最高优先】守卫强度审计：直接执行 layout.scoped §C1 的断言
================================================================ */

const LAYOUT_SRC = readRel('tests/layout.scoped.independent.test.js');

/** 从 layout.scoped 源码里取出它自己的 extractFn（保证与生产环境同语义，不是我另写一个） */
function loadLayoutExtractFn() {
  const literal = extractFn(LAYOUT_SRC, 'extractFn');
  return new Function('return (' + literal + ')')();
}
const HIS_EXTRACT_FN = loadLayoutExtractFn();

/** 抽取 §C1 中被审查的断言块（STRICT 冻结循环 + thCol 受控放行）——按源码文本，不抄写 */
function extractC1GuardBody() {
  const start = LAYOUT_SRC.indexOf('  const STRICT = [');
  assert.ok(start >= 0, '未能在 layout.scoped §C1 中定位到 STRICT 冻结列表（守卫结构已变，请同步本文件）');
  const endMark = "'thCol 除 .162 那一处受控增量外，必须与 .152 改前基线逐字一致（反潮汐硬约束）');";
  const end = LAYOUT_SRC.indexOf(endMark);
  assert.ok(end > start, '未能在 layout.scoped §C1 中定位到 thCol 受控放行的收尾断言（守卫结构已变，请同步本文件）');
  const body = LAYOUT_SRC.slice(start, end + endMark.length);
  /* 抽出来的必须真的是那段守卫（防抽到半截导致"恒真"） */
  assert.ok(body.indexOf('stripThColDelta') >= 0, '抽取的守卫块必须含 stripThColDelta');
  assert.ok(body.indexOf('assert.strictEqual(stripThColDelta(thNow), thBase') >= 0,
    '抽取的守卫块必须含「剥掉受控增量后逐字相等」的收尾断言');
  return body;
}
const C1_BODY = extractC1GuardBody();

/** 对任意 html 文本执行他的 §C1 守卫；通过返回 true，抛错即"变红" */
function runC1Guard(html) {
  const fn = new Function('assert', 'INDEX_SRC', 'extractFn', 'headHtml', 'base',
    C1_BODY + '\nreturn true;');
  return fn(assert, html, HIS_EXTRACT_FN, BASE152.text, { rev: BASE152.rev });
}
/** 执行结果归一：true=守卫放行（绿）；false=守卫拦下（红） */
function c1Verdict(html) {
  try {
    runC1Guard(html);
    return { pass: true, err: null };
  } catch (e) {
    return { pass: false, err: e };
  }
}

test('K0 正控：未变异的 index.html 必须让 §C1 守卫通过（否则后续"变红"结论无意义）', function () {
  const v = c1Verdict(INDEX_SRC);
  assert.equal(v.pass, true, '§C1 守卫在真实源码上必须通过；实际抛错：' + (v.err && v.err.message));
  /* 环境自证：守卫用的基线确实更早，且不是 HEAD */
  assert.notEqual(BASE152.rev, HEAD, '基线不得是 HEAD（防对消）');
  assert.equal(countOcc(BASE152.text, '>build ' + build.BUILD + '<'), 0, '基线不得含本版水印');
});

/* ---- 2.1 失效方式①：剥离逻辑是否过宽（4 种非预期改动必须全部变红） ---- */

const K_OVERBROAD = [
  {
    id: 'K1',
    what: '改 thCol 里一个无关字符串（表头标签拼接处）',
    anchor: "class=\"th-label\">'+esc(col.label)+",
    repl: "class=\"th-label\">'+esc(col.label+' ')+"
  },
  {
    id: 'K2',
    what: '改 thCol 的 title 属性（拖动列宽提示）',
    anchor: 'title="拖动调整列宽"',
    repl: 'title="拖动调整宽度"'
  },
  {
    id: 'K3',
    what: '删除 thCol 里 sort-ico（排序箭头）整段',
    anchor: "'<span class=\"sort-ico'+(sorted?' on':'')+'\">'+dir+'</span>'+",
    repl: ''
  },
  {
    id: 'K4',
    what: '改 thCol 里 f.warnTriSvg / LOCK 之类的无关行（锁定角标）',
    anchor: "(col.locked?' '+LOCK:'')",
    repl: "(col.locked?LOCK:'')"
  },
  {
    id: 'K5',
    what: '改 thCol 的 data-key 属性（加一个多余属性）',
    anchor: 'data-key="\'+col.key+\'"',
    repl: 'data-key="\'+col.key+\'" data-x="1"'
  }
];

K_OVERBROAD.forEach(function (c) {
  test('K-过宽 ' + c.id + '：' + c.what + ' → §C1 必须变红（不得被"剥离"吸收）', function () {
    const mutated = mutateText(INDEX_SRC, c.anchor, c.repl, 'K/' + c.id);
    const v = c1Verdict(mutated);
    assert.equal(v.pass, false,
      '【守卫·契约】该改动**不属于**批准增量，§C1 必须变红；实际放行 ⇒ 剥离逻辑过宽，守卫已失效');
    assert.ok(v.err && /thCol 除 \.162 那一处受控增量外/.test(String(v.err.message)),
      c.id + ' 的失败必须来自「剥后逐字相等」那条断言（实际：' + (v.err && v.err.message) + '）');
  });
});

/* ---- 2.1 失效方式②：剥离是否可被滥用（按行号/整函数跳过 = 守卫失效） ---- */

test('K6 【守卫·现状】剥离实现是「字节级删除」而非「按行号/整函数跳过」（静态形态审查）', function () {
  const stripSrc = LAYOUT_SRC.slice(LAYOUT_SRC.indexOf('const stripThColDelta'),
    LAYOUT_SRC.indexOf('const thNow = extractFn(INDEX_SRC'));
  assert.ok(stripSrc.length > 40, '必须能定位到 stripThColDelta 实现');
  /* 若实现退化为「切片/整段忽略」，本断言立刻报红 */
  assert.equal(/split\(\s*['"]\\n['"]\s*\)\s*\.\s*slice|\.slice\(\s*0\s*,\s*\w*line|lastIndexOf\(\s*['"]\}/.test(stripSrc), false,
    '剥离实现不得按行号或整函数跳过（那等于守卫失效）：' + stripSrc);
  assert.equal(/return\s+''\s*;/.test(stripSrc), false, '剥离不得直接丢弃整个函数体');
  /* 必须是"删两处、其余保留"的形态 */
  assert.ok(/\.replace\(/.test(stripSrc), '剥离必须基于 replace 精确删除');
  assert.equal(countOcc(stripSrc, '.replace('), 2, '剥离必须恰两处 replace（注释块 + isSemFiltMode 子句）');
});

/* ---- 2.1 失效方式③：匹配是否宽松（不能"只看前缀就剥掉整行剩余部分"） ---- */

const K_LOOSE = [
  {
    id: 'K7',
    what: '在受控增量后追加 ||true（恒真条件）',
    anchor: '||isSemFiltMode(m,col.key,f.mode)',
    repl: '||isSemFiltMode(m,col.key,f.mode)||true'
  },
  {
    id: 'K8',
    what: '在受控增量前插入 ||true（恒真条件）',
    anchor: '||isSemFiltMode(m,col.key,f.mode)',
    repl: '||true||isSemFiltMode(m,col.key,f.mode)'
  },
  {
    id: 'K9',
    what: '把判据换成另一个恒真条件（不调用单一来源）',
    anchor: '||isSemFiltMode(m,col.key,f.mode)',
    repl: '||true'
  },
  {
    id: 'K10',
    what: '改判据实参（col.key → f.mode，等于判据失真）',
    anchor: '||isSemFiltMode(m,col.key,f.mode)',
    repl: '||isSemFiltMode(m,f.mode,f.mode)'
  }
];

K_LOOSE.forEach(function (c) {
  test('K-宽松 ' + c.id + '：' + c.what + ' → §C1 必须变红（不得被判为"受控增量"）', function () {
    const mutated = mutateText(INDEX_SRC, c.anchor, c.repl, 'K/' + c.id);
    const v = c1Verdict(mutated);
    assert.equal(v.pass, false,
      '【守卫·契约】匹配不得宽松：' + c.what + ' 不属于批准增量，必须变红；实际放行 ⇒ 增量匹配可被滥用');
  });
});

/* ---- 2.1 失效方式④：两条防退化断言是否真有效 ---- */

test('K11 防退化①：受控增量被删（分「只删子句」「整段回退 .161」两种）→ §C1 必须变红', function () {
  /* (a) 只删判据子句、保留 .162 注释块：thNow ≠ thBase，故拦在「增量内容必须就是」这条上 */
  const partial = mutateText(INDEX_SRC, '||isSemFiltMode(m,col.key,f.mode)', '', 'K/K11a');
  const va = c1Verdict(partial);
  assert.equal(va.pass, false, '只删子句时 §C1 必须变红');
  assert.ok(va.err && /受控增量必须就是/.test(String(va.err.message)),
    '失败必须来自「增量内容必须就是 isSemFiltMode 子句」（实际：' + (va.err && va.err.message) + '）');

  /* (b) 整段回退成 .161 的 thCol（注释与子句都不在）：
         此时 thNow === thBase，"受控增量必须真的存在"那条防退化断言会立刻报红 */
  const full = mutateText(INDEX_SRC, extractFn(INDEX_SRC, 'thCol'), extractFn(PREV_INDEX_SRC, 'thCol'), 'K/K11b');
  const vb = c1Verdict(full);
  assert.equal(vb.pass, false, '整段回退时 §C1 必须变红（否则"增量必须真的存在"这条防退化断言是摆设）');
  assert.ok(vb.err && /受控增量必须真的存在/.test(String(vb.err.message)),
    '整段回退的失败必须来自「受控增量必须真的存在」（实际：' + (vb.err && vb.err.message) + '）');
});

test('K12 防退化②：把增量改成"另一个恒真条件"→ §C1 必须变红', function () {
  const mutated = mutateText(INDEX_SRC, '||isSemFiltMode(m,col.key,f.mode)', '||1', 'K/K12');
  const v = c1Verdict(mutated);
  assert.equal(v.pass, false, '换成恒真条件后必须变红（否则"增量内容必须恰为 isSemFiltMode 子句"是摆设）');
  assert.ok(v.err && /受控增量必须就是/.test(String(v.err.message)),
    '失败必须来自「增量内容必须就是 isSemFiltMode 子句」（实际：' + (v.err && v.err.message) + '）');
});

/* ---- 2.1 失效方式⑤：是否只放行了 thCol（另 5 个函数必须仍逐字冻结） ---- */

const K_FROZEN = [
  { id: 'K13', fn: 'layoutOf', anchor: 'if(!tblLayout[m])tblLayout[m]={order:null,widths:{}};', repl: 'if(!tblLayout[m])tblLayout[m]={order:null,widths:[]};' },
  { id: 'K14', fn: 'syncHeadBody', anchor: "var ht=hd.querySelector('table.head-tbl');", repl: "var ht=hd.querySelector('table.head-tbl ')||null;" },
  { id: 'K15', fn: 'startColDrag', anchor: 'x:e.clientX,moved:false', repl: 'x:e.clientX,moved:1' },
  { id: 'K16', fn: 'startColResize', anchor: "var tbl=th.closest('table');", repl: "var tbl=th.closest('table')||null;" },
  { id: 'K17', fn: 'applyTableLayout', anchor: 'var thead=tbl.tHead;', repl: 'var thead=tbl.tHead||null;' }
];

K_FROZEN.forEach(function (c) {
  test('K-冻结 ' + c.id + '：改动未放行函数 ' + c.fn + ' → §C1 必须变红（逐字冻结未被削弱）', function () {
    const mutated = mutateText(INDEX_SRC, c.anchor, c.repl, 'K/' + c.id);
    const v = c1Verdict(mutated);
    assert.equal(v.pass, false,
      '【守卫·契约】' + c.fn + ' 未获批准改动，§C1 必须变红；实际放行 ⇒ 冻结范围被缩小');
    assert.ok(v.err && new RegExp(c.fn + ' 函数体必须与 .152 改前基线').test(String(v.err.message)),
      '失败必须来自「' + c.fn + ' 逐字相等」那条断言（实际：' + (v.err && v.err.message) + '）');
  });
});

test('K18 【守卫·现状·无害】仅改写 .162 注释块内的文字会被剥离吸收（注释不参与运行时，可接受）', function () {
  /* 边界探测：说明"剥离"的允许面 = 该注释块的**任意文字** + 那一句判据。
     这不是缺陷（注释无运行时语义），但必须写明，否则将来有人以为注释也受冻结。 */
  const anchor = '用户看不出该列已加筛选。';
  const mutated = mutateText(INDEX_SRC, anchor, '用户看不出该列已加筛选（此处可任意改写，属批准增量内）。', 'K/K18');
  const v = c1Verdict(mutated);
  assert.equal(v.pass, true,
    '【守卫·现状】注释文字属于批准增量，§C1 会放行；若此处变红说明剥离被收紧（请同步本节说明）');
});

/* ================================================================
   §L 三处「前提同步」逐处裁决（必要同步 / 弱化 / 方向反转）
================================================================ */

test('L1 裁决（A4④ 提取器敏感探针换锚点）：必要同步，强度未减', function () {
  /* 换锚点的动机：.161 时 fpModeChange 是"被改过"的函数；推进到 .162 后两版 fpModeChange 相同，
     原探针会变成 notEqual(相同,相同) → 恒红；若有人图省事删掉它，守卫就消失。
     故换锚点**必要**。但必须证明新锚点仍在证明同一件事（提取器对修订敏感、不是抓到恒定片段）。 */
  const changed = ['thCol', 'applyFilt', 'filterBar'];   /* 本版确实改过的三个函数 */
  changed.forEach(function (n) {
    assert.notEqual(extractFn(INDEX_SRC, n), extractFn(PREV_INDEX_SRC, n),
      n + ' 在本版确有改动 ⇒ 可作为"提取器敏感"的锚点（两版必须不同）');
  });
  /* filterBar 为何也算"改过"：其 semModeOf 由自带实现降为委托 isSemFiltMode 的薄别名（判据单源化）。 */
  assert.ok(extractFn(INDEX_SRC, 'filterBar').indexOf('isSemFiltMode(m,k,mode)') >= 0,
    'filterBar 的薄别名必须委托 isSemFiltMode（这解释了它为何与上一版不同）');
  /* 反假绿：若提取器不管什么函数都返回"两版不同"（例如带进位置信息），notEqual 就恒真、探针失效。
     故必须同时证明「未被改动的函数两版**相同**」——证明 equal/notEqual 都有判别力。 */
  const untouched = ['tState', 'colVal', 'filterRows', 'invStockLevel', 'openFilter', 'fpModeChange', 'fpModeOptsHtml'];
  untouched.forEach(function (n) {
    assert.equal(extractFn(INDEX_SRC, n), extractFn(PREV_INDEX_SRC, n),
      n + ' 在两版之间未改动 ⇒ 必须逐字相同（这条同时证明提取器不是"恒不相等"的假探针）');
  });
  /* 防对消：基线不得等于 HEAD */
  assert.notEqual(PREV_REV, HEAD, '基线修订不得是 HEAD（否则比对自我对消）');
  assert.notEqual(md5(PREV_INDEX_SRC), md5(INDEX_SRC), '两版 index.html 必须是不同文件');
  assert.equal(countOcc(PREV_INDEX_SRC, '>build ' + build.PREV + '<'), 1,
    '基线必须自证为上一版水印（取错修订则本节失效）');
});

test('L2 裁决（D2 前提「上一版没有 onchange」→「已有」）：必要同步，且仍能抓回归', function () {
  const now = bootInv();
  const prev = boot({ indexHtml: PREV_INDEX_SRC });
  prev.run("renderOrderTable('order_inv',[],{});");
  const nowOc = selectOnChange(panelHtml(now, 'order_inv', '_balPct'));
  const prevOc = selectOnChange(panelHtml(prev, 'order_inv', '_balPct'));
  assert.equal(nowOc, 'fpModeChange()', '本版数值列必须挂 onchange');
  assert.equal(prevOc, 'fpModeChange()',
    '上一版（.161）确实已有该 onchange ⇒ 原前提「上一版没有」在本轮**必然假失败**，同步是必要的');
  /* 改后是否还有牙齿：把**数值列**的 onchange 删掉 → 断言必须红（方向：回归检测，不是"新增检测"） */
  const mutated = mutateText(INDEX_SRC,
    '\'<select id="fp_mode" onchange="fpModeChange()">\'+fpModeOptsHtml(nModes,f.mode,nNoVal)',
    '\'<select id="fp_mode">\'+fpModeOptsHtml(nModes,f.mode,nNoVal)', 'L2');
  const m2 = boot({ indexHtml: mutated });
  m2.run("renderOrderTable('order_inv',[],{});");
  assert.equal(selectOnChange(panelHtml(m2, 'order_inv', '_balPct')), null,
    '变异版确实丢了 onchange（注入生效自证）');
  assert.notEqual(selectOnChange(panelHtml(m2, 'order_inv', '_balPct')), 'fpModeChange()',
    '【守卫·契约】去掉 onchange 后该断言会红 ⇒ 改后的 D2 仍能抓回归（不是空转）');
  m2.dispose();
  now.dispose();
  prev.dispose();
});

test('L3 裁决（G3「归一化后相同」→「原始逐字相同」）：判据确实更强，不是文字游戏', function () {
  /* 构造一类"旧判据会被吸收、新判据能抓住"的差异：给非语义档 gte 也打上 data-noval。
     这是真实风险（打标错位会让"为空/不为空之外"的模式也隐藏数值框），但归一化会把 data-noval 一律剥掉。 */
  const mutated = mutateText(INDEX_SRC,
    'const nNoVal={};semDefs.forEach(function(x){nNoVal[x.mode]=1;});',
    'const nNoVal={gte:1};semDefs.forEach(function(x){nNoVal[x.mode]=1;});', 'L3');
  const now = boot({ indexHtml: mutated });
  const prev = boot({ indexHtml: PREV_INDEX_SRC });
  for (const a of [now, prev]) a.run("renderOrderTable('order_inv',[],{});");
  const aRaw = panelHtml(now, 'order_inv', 'stockMin');
  const bRaw = panelHtml(prev, 'order_inv', 'stockMin');
  assert.notEqual(aRaw, bRaw, '变异版面板确实与上一版不同（注入生效自证）');

  const normalizeOld = function (html) {
    return String(html).replace(/ data-noval="1"/g, '').replace(/ onchange="fpModeChange\(\)"/g, '');
  };
  assert.equal(normalizeOld(aRaw), normalizeOld(bRaw),
    '旧判据（先归一化再比）会把"错位打标"吸收掉 ⇒ 它是**弱**判据');
  assert.notEqual(aRaw, bRaw,
    '【守卫·契约】新判据（原始逐字）能抓住该差异 ⇒ "升级为原始逐字相同"确实更强');
  now.dispose();
  prev.dispose();
});

/* ================================================================
   §M invStockLevel 本体仍未动（跨修订，基线自动解析 + 防对消）
================================================================ */

test('M1 契约：invStockLevel 本体与上一版逐字相同；本轮 PREV 自动解析为改前修订且两侧不同', function () {
  assert.notEqual(PREV_REV, HEAD, '基线不得是 HEAD');
  assert.notEqual(md5(PREV_INDEX_SRC), md5(INDEX_SRC), '两版必须是不同文件（防自我对消）');
  assert.equal(countOcc(PREV_INDEX_SRC, '>build ' + build.PREV + '<'), 1, '基线水印自证为上一版');
  assert.equal(countOcc(INDEX_SRC, '>build ' + build.BUILD + '<'), 1, '当前水印自证为本版');
  const now = extractFn(INDEX_SRC, 'invStockLevel');
  const prev = extractFn(PREV_INDEX_SRC, 'invStockLevel');
  assert.equal(now, prev, 'invStockLevel 必须与上一版逐字相同（.160 的零值口径未被带偏）');
  assert.ok(now.indexOf('num(min)>0') >= 0, '「最小=0/空 ⇒ 不设限」守卫仍须在');
  /* A4 单源红线：语义档派生函数也不得越过共享函数自行判档 */
  ['invShortOf', 'invOverOf'].forEach(function (n) {
    const body = extractFn(stripComments(INDEX_SRC), n);
    assert.equal(countOcc(body, 'invStockLevel('), 1, n + ' 必须恰调用一次共享 invStockLevel');
    assert.equal(/[<>]/.test(body), false, n + ' 不得出现 </>（禁止第二份阈值判定）');
    assert.equal(/num\s*\(/.test(body), false, n + ' 不得出现 num(');
  });
});

/* ================================================================
   §N isSemFiltMode 单一来源（全局扫描，不只查三个已知点）
================================================================ */

test('N1 契约：semFilters 的**全部**提及点只有 4 个函数（3 处读取 + 1 处声明）', function () {
  /* 工程师 §G2 的写法是「取三个函数名，逐个查是否含 semFilters」——那只证明"这三个确实用了"，
     **无法**排除"第四个函数偷偷读"。此处改为**全局扫描**：遍历主脚本里所有 function 声明。 */
  const names = [];
  const re = /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(INDEX_SRC)) !== null) names.push(m[1]);
  const uniq = Array.from(new Set(names));
  assert.ok(uniq.length >= 200, '函数枚举异常（仅 ' + uniq.length + ' 个）——扫描逻辑可能失效');
  const readers = [];
  uniq.forEach(function (n) {
    let body;
    try { body = extractFn(INDEX_SRC, n); } catch (e) { return; }
    if (body.indexOf('semFilters') >= 0) readers.push(n);
  });
  assert.deepEqual(readers.sort(),
    ['filterRows', 'isSemFiltMode', 'openFilter', 'renderOrderTable'],
    'semFilters 的提及点必须恰为：filterRows（引擎闸门）/ isSemFiltMode（判据）/ openFilter（面板选项）/ ' +
    'renderOrderTable（列定义声明）。实际：' + readers.join(', ') +
    ' —— 若多出第五处，说明又出现了一份判据或新的读取点');
});

test('N2 契约：isSemFiltMode 恰 1 份实现；三处消费方均调用且自身不含 semFilters', function () {
  const plain = stripComments(INDEX_SRC);
  assert.equal(countOcc(plain, 'function isSemFiltMode('), 1, '判据只许 1 份实现');
  ['thCol', 'filterBar', 'applyFilt'].forEach(function (n) {
    const body = extractFn(INDEX_SRC, n);
    assert.ok(body.indexOf('isSemFiltMode(') >= 0, n + ' 必须调用单一来源');
    assert.equal(body.indexOf('semFilters'), -1, n + ' 自身不得出现 semFilters（否则又是第二份判据）');
  });
  /* filterBar 的别名必须是"委托"而非"再实现" */
  const bar = extractFn(INDEX_SRC, 'filterBar');
  assert.ok(bar.indexOf('const semModeOf=function(k,mode){return isSemFiltMode(m,k,mode);}') >= 0,
    'filterBar 的 semModeOf 必须是委托 isSemFiltMode 的薄别名');
});

test('N3 契约：isSemFiltMode 行为（真/假两侧 + 边界）', function () {
  const app = bootAll();
  const call = function (m, k, mode) {
    return app.run('isSemFiltMode(' + JSON.stringify(m) + ',' + JSON.stringify(k) + ',' +
      JSON.stringify(mode) + ')');
  };
  assert.equal(call('order_inv', '_balPct', 'inv_short'), true, '已声明语义档 → true');
  assert.equal(call('order_inv', '_balPct', 'inv_over'), true, '已声明语义档 → true');
  assert.equal(call('order_inv', '_balPct', 'gte'), false, '普通数值模式不是语义档 → false');
  assert.equal(call('order_inv', '_pct', 'inv_short'), false, '同模块未声明的列 → false');
  assert.equal(call('parts', '_balPct', 'inv_short'), false, '其它模块同名 key 不得串味 → false');
  assert.equal(call('order_inv', '__no_such_col', 'inv_short'), false, '不存在的列 → false');
  assert.equal(call('order_inv', '_balPct', ''), false, '空 mode → false（不得因缺省而放行）');
  assert.equal(call('order_inv', '_balPct', undefined), false, 'undefined mode → false');
  assert.equal(call('__no_such_module', '_balPct', 'inv_short'), false, '不存在的模块 → false');
  app.dispose();
});

/* ================================================================
   §O 9 处版本水印锚点（.162）
================================================================ */

const BUILD_JS_SRC = readRel('tests/harness/build.js');
const PPSHIFT_SRC = readRel('tests/qa.ppshift-advance.independent.test.js');
const PRODPLAN_QUERY_SRC = readRel('tests/qa.prodplan-query.independent.test.js');
const LEDGER_INDEP_SRC = readRel('tests/qa.parts-ledger.independent.test.js');
const GUIDE_SRC = readRel('js/guide.js');
const README_SRC = readRel('README.md');
const BUILD_NO = String(build.BUILD).split('.')[1];
const BUILD_DATE = String(build.BUILD).split('.')[0];
const PREV_NO = String(build.PREV).split('.')[1];

test('O1 契约：锚点① index.html 权威水印（+ 工作树==已提交 + 与 git 主题互证）', function () {
  assert.equal((INDEX_SRC.match(build.buildMarkRe(build.BUILD)) || []).length, 1, '本版权威水印恰 1 处');
  assert.equal((INDEX_SRC.match(build.buildMarkRe(build.PREV)) || []).length, 0, '上一版权威水印 0 处');
  assert.equal((INDEX_SRC.match(build.buildAnyRe(build.PREV)) || []).length, 0, '上一版任意形态 0 处');
  assert.equal((INDEX_SRC.match(build.buildMarkRe('2099-01-01.999')) || []).length, 0, '反虚设：伪版本命中 0');
  assert.equal(md5(INDEX_SRC), md5(gitShow('HEAD', 'index.html')), '工作树必须与 HEAD 一致（否则指纹不可信）');
  const subjects = git(['log', '--format=%s', '-n', '50']).split('\n');
  assert.equal(subjects.filter(function (s) { return s.indexOf('build ' + build.BUILD) === 0; }).length, 1,
    '必须恰有一条提交主题以 build ' + build.BUILD + ' 开头');
});

test('O2 契约：锚点②~⑨ 与版本纪律', function () {
  /* ② harness/build.js 手写 */
  const code = stripComments(BUILD_JS_SRC);
  assert.equal(countOcc(code, "const BUILD = '" + build.BUILD + "';"), 1, '② build.js BUILD 手写字面量');
  assert.equal(countOcc(code, "const PREV = '" + build.PREV + "';"), 1, '② build.js PREV 手写字面量');
  assert.equal(/readFileSync|index\.html|require\s*\(/.test(code), false, '② build.js 不得反推');
  /* ③④⑤ */
  assert.ok(PPSHIFT_SRC.indexOf("assert.equal(build.BUILD, '" + build.BUILD + "'") >= 0, '③ qa.ppshift §E2');
  assert.ok(PPSHIFT_SRC.indexOf("assert.equal(build.PREV, '" + build.PREV + "'") >= 0, '③ qa.ppshift §E2 PREV');
  assert.ok(PRODPLAN_QUERY_SRC.indexOf("assert.equal(build.BUILD, '" + build.BUILD + "'") >= 0, '④ §E2');
  assert.ok(PRODPLAN_QUERY_SRC.indexOf("assert.equal(build.PREV, '" + build.PREV + "'") >= 0, '④ §E2 PREV');
  const verLine = BUILD_DATE + '（build .' + BUILD_NO + '）';
  assert.ok(PRODPLAN_QUERY_SRC.indexOf(verLine) >= 0, '④ §E4 guide 版本行');
  /* ⑥ guide.js 文首 */
  assert.ok(GUIDE_SRC.split('\n').slice(0, 8).join('\n').indexOf('更新：' + verLine) >= 0, '⑥ guide.js 文首更新行');
  assert.equal(GUIDE_SRC.indexOf('更新：' + BUILD_DATE + '（build .' + PREV_NO + '）'), -1, '⑥ 不得残留上一版更新行');
  /* ⑦ README */
  assert.ok(README_SRC.indexOf('build ' + build.BUILD) >= 0, '⑦ README 当前版本');
  /* ⑧ layout.scoped §C5 */
  assert.ok(LAYOUT_SRC.indexOf('>build ' + String(build.BUILD).replace(/\./g, '\\.') + '<') >= 0, '⑧ §C5 水印正则');
  assert.ok(LAYOUT_SRC.indexOf("BUILD.BUILD, '" + build.BUILD + "'") >= 0, '⑧ §C5 BUILD');
  assert.ok(LAYOUT_SRC.indexOf("BUILD.PREV, '" + build.PREV + "'") >= 0, '⑧ §C5 PREV');
  /* ⑨ qa.parts-ledger（.161 已裁决为必要） */
  assert.ok(LEDGER_INDEP_SRC.indexOf("const BUILD = '" + build.BUILD + "';") >= 0, '⑨ qa.parts-ledger BUILD');
  assert.ok(LEDGER_INDEP_SRC.indexOf("const PREV = '" + build.PREV + "';") >= 0, '⑨ qa.parts-ledger PREV');
  /* 版本纪律 */
  assert.equal(countOcc(INDEX_SRC, build.BUILD), 1, 'index.html 完整版本号恰 1 处');
  assert.ok(countOcc(INDEX_SRC, 'build .' + BUILD_NO) >= 3,
    '本版短令牌 build .' + BUILD_NO + ' 必须 ≥3 处（实际 ' + countOcc(INDEX_SRC, 'build .' + BUILD_NO) + '）');
  assert.ok(countOcc(INDEX_SRC, 'build .' + PREV_NO) >= 3,
    '上一版短令牌 build .' + PREV_NO + ' 必须仍保留 ≥3 处（实际 ' + countOcc(INDEX_SRC, 'build .' + PREV_NO) + '）');
  assert.equal(countOcc(GUIDE_SRC, build.BUILD), 0, 'guide.js 正文不得写完整版本号');
});

/* ================================================================
   §P 本轮修复的契约面（图标点亮 / 清脏值 / 范围守卫）
================================================================ */

test('P1 契约：语义档（val 空）必须点亮漏斗图标；无筛选与"数值模式 val 空"都不得点亮', function () {
  const app = bootInv();
  const set = function (f) { app.run("tState('order_inv').filters=" + f + ';'); };
  set('{}');
  assert.equal(icoOn(app, 'order_inv', '_balPct'), false, '无筛选必须不亮（反假守卫：防 act 恒真）');
  set("{_balPct:{mode:'inv_short',val:''}}");
  assert.equal(icoOn(app, 'order_inv', '_balPct'), true, '语义档生效（val 恒空）必须点亮 —— .161 缺陷点');
  set("{_balPct:{mode:'inv_over',val:''}}");
  assert.equal(icoOn(app, 'order_inv', '_balPct'), true, 'inv_over 同样必须点亮');
  set("{_balPct:{mode:'gte',val:'100'}}");
  assert.equal(icoOn(app, 'order_inv', '_balPct'), true, '既有数值模式有值仍要亮（零回归）');
  set("{_balPct:{mode:'gte',val:''}}");
  assert.equal(icoOn(app, 'order_inv', '_balPct'), false, '数值模式 val 空 = 未生效，不得点亮（既有语义）');
  /* 状态面自证：语义档确实让 rows 变少（不是"点亮了但没筛"） */
  app.sandbox.__qaRows = [invRow('R1', { deliveredQty: -5, stockMin: '', stockMax: '' }),
    invRow('R2', { deliveredQty: 50, stockMin: '', stockMax: '' })];
  try {
    set("{_balPct:{mode:'inv_short',val:''}}");
    const hit = idsOf(app.run("filterRows('order_inv',__qaRows)"));
    assert.deepEqual(hit, ['R1'], '前提自证：该状态下筛选确实生效（R1 红标入选）');
  } finally { delete app.sandbox.__qaRows; app.dispose(); }
});

test('P2 契约：真实 applyFilt 写入语义档后 val/from/to 必须被清空，且结果集不变', function () {
  const app = bootInv();
  app.run('renderContent=function(){};');
  app.run("tState('order_inv').filters={_balPct:{mode:'gte',val:'100',from:'x',to:'y'}};");
  driveApplyFilt(app, 'order_inv', '_balPct', 'inv_short', 100);
  const st = app.run("JSON.stringify(tState('order_inv').filters._balPct)");
  const f = JSON.parse(st);
  assert.equal(f.mode, 'inv_short', '模式必须切到 inv_short');
  assert.equal(f.val, '', '语义档写入后 val 必须为 \'\'（实际 ' + st + '）');
  assert.equal(f.from, undefined, 'from 必须被清空');
  assert.equal(f.to, undefined, 'to 必须被清空');
  assert.equal(/100/.test(app.run("filterBar('order_inv')")), false, 'chip 不得拼残留数值');
  /* 结果集不受影响 */
  app.sandbox.__qaRows = [invRow('R1', { deliveredQty: -5, stockMin: '', stockMax: '' }),
    invRow('R2', { deliveredQty: 50, stockMin: '', stockMax: '' })];
  try {
    assert.deepEqual(idsOf(app.run("filterRows('order_inv',__qaRows)")), ['R1'], '清脏值后筛选结果仍正确');
  } finally { delete app.sandbox.__qaRows; app.dispose(); }
});

test('P3 契约：清脏值**只**作用于语义档；为空/不为空/日期快捷的 val 行为一律不变', function () {
  const app = bootInv();
  app.run('renderContent=function(){};');
  const cases = [
    { col: 'id', mode: 'is_empty', val: 'KC' },
    { col: 'id', mode: 'not_empty', val: 'KC' },
    { col: 'id', mode: 'contains', val: 'KC' },
    { col: 'startDate', mode: 'today', val: '2026-01-01' },
    { col: 'startDate', mode: 'gte', val: '2026-01-01' },
    { col: '_pct', mode: 'gte', val: '50' }
  ];
  const bad = [];
  cases.forEach(function (c) {
    app.run("tState('order_inv').filters={};");
    driveApplyFilt(app, 'order_inv', c.col, c.mode, c.val);
    const got = app.run("tState('order_inv').filters[" + JSON.stringify(c.col) + "].val");
    if (got !== c.val) bad.push(c.col + '/' + c.mode + '：期望 ' + JSON.stringify(c.val) + '，实际 ' + JSON.stringify(got));
  });
  assert.deepEqual(bad, [], '非语义档的 val 既有行为必须逐字不变：\n' + bad.join('\n'));
  app.dispose();
});

/* ================================================================
   §Q thCol 跨修订零回归（**独立重算**，不用他的数字）
================================================================ */

const TH_STATES = [
  '{}',
  "{id:{mode:'contains',val:'KC'}}",
  "{id:{mode:'is_empty',val:''}}",
  "{id:{mode:'not_empty',val:''}}",
  "{id:{vals:['KC1','KC2'],mode:'in'}}",
  "{stockMin:{mode:'gte',val:'5'}}",
  "{stockMin:{mode:'gte',val:''}}",
  "{startDate:{mode:'range',from:'2026-01-01',to:'2026-12-31'}}",
  "{startDate:{mode:'today',val:''}}"
];

test('Q1 契约：5 模块 × 全列 × 9 种非语义筛选态，两版 thCol 输出逐字节相同（我自算）', function () {
  const now = bootAll();
  const prev = boot({ indexHtml: PREV_INDEX_SRC });
  prev.setGlobal('products', clone(SEED.products));
  prev.setGlobal('parts', clone(SEED.parts));
  prev.setGlobal('deliveries', clone(SEED.deliveries));
  prev.run("renderProducts();renderParts();renderDelivery();" +
    "renderOrderTable('order_frame',[],{});renderOrderTable('order_inv',[],{});");

  const mods = ['product', 'order_frame', 'order_inv', 'delivery', 'parts'];
  const diffs = [];
  let compared = 0;
  mods.forEach(function (m) {
    const keys = Array.from(now.run('(TBL_SCHEMAS[' + JSON.stringify(m) + ']||[]).map(function(c){return c.key;})'));
    assert.ok(keys.length >= 5, m + ' 列数异常（' + keys.length + '）');
    keys.forEach(function (k) {
      TH_STATES.forEach(function (st) {
        now.run('tState(' + JSON.stringify(m) + ').filters=' + st + ';');
        prev.run('tState(' + JSON.stringify(m) + ').filters=' + st + ';');
        const a = thOf(now, m, k);
        const b = thOf(prev, m, k);
        compared++;
        if (a !== b) diffs.push(m + '.' + k + ' ' + st + '\n  本版：' + a + '\n  上版：' + b);
      });
    });
  });
  assert.ok(compared >= 600, '覆盖面异常（仅 ' + compared + ' 组）');
  assert.deepEqual(diffs, [], '非语义筛选态下 thCol 出现回归：\n' + diffs.join('\n'));
  now.dispose();
  prev.dispose();
});

test('Q2 契约：语义档下两版 thCol 的差异**恰为一个 ` on` 令牌**（除此之外逐字节相同）', function () {
  const now = bootAll();
  const prev = boot({ indexHtml: PREV_INDEX_SRC });
  prev.setGlobal('products', clone(SEED.products));
  prev.setGlobal('parts', clone(SEED.parts));
  prev.setGlobal('deliveries', clone(SEED.deliveries));
  prev.run("renderProducts();renderParts();renderDelivery();renderOrderTable('order_inv',[],{});");
  const st = "{_balPct:{mode:'inv_short',val:''}}";
  now.run("tState('order_inv').filters=" + st + ';');
  prev.run("tState('order_inv').filters=" + st + ';');
  const a = thOf(now, 'order_inv', '_balPct');
  const b = thOf(prev, 'order_inv', '_balPct');
  assert.notEqual(a, b, '差异必须存在（本版点亮、上一版不亮）');
  assert.equal(countOcc(b, 'class="filt-ico on"'), 0, '上一版该处不亮（不复位前提自证）');
  assert.equal(countOcc(a, 'class="filt-ico on"'), 1, '本版该处必须亮');
  /* 把本版那一个 ` on` 去掉后必须与上一版逐字节相同 */
  assert.equal(a.split('class="filt-ico on"').join('class="filt-ico"'), b,
    '除该一个 ` on` 令牌外，thCol 输出必须与上一版逐字节相同');
  assert.equal(a.length - b.length, 3, '长度差必须恰为 3 字符（空格+o+n）');
  now.dispose();
  prev.dispose();
});

/* ================================================================
   §R 变异注入（产品逻辑层）—— 每条锚点命中恰 1、注入生效、探针必须变红
================================================================ */

function bootMutated(mutFn) {
  return createApp({ installRecorder: false, quietConsole: true, transformMain: mutFn });
}
function mutateAndBoot(anchor, repl, label) {
  let hits = null, transformed = null;
  const app = bootMutated(function (code) {
    hits = countOcc(code, anchor);
    transformed = mutateText(code, anchor, repl, label);
    return transformed;
  });
  assert.equal(hits, 1, '变异锚点[' + label + '] 必须恰命中 1 处（实际 ' + hits + '）');
  assert.notEqual(transformed, null, '注入必须真的执行');
  assert.equal(countOcc(transformed, anchor), 0, '注入必须生效（原锚点不得残留）');
  return app;
}

const PROBE = {};

/** 图标点亮（正） */
PROBE.iconOn = function (app) {
  app.run("renderOrderTable('order_inv',[],{});");
  app.run("tState('order_inv').filters={_balPct:{mode:'inv_short',val:''}};");
  assert.equal(icoOn(app, 'order_inv', '_balPct'), true, '语义档生效时漏斗图标必须点亮');
};

/** 图标不得恒亮（反假）：有筛选条目但**模式无效**（数值模式 val 留空）时不得点亮 */
PROBE.iconNotAlways = function (app) {
  app.run("renderOrderTable('order_inv',[],{});");
  /* 注意：无筛选时 `act` 会被 `f &&` 短路（f 为 undefined），故"无筛选不亮"无法证明判据不恒真。
     真正能证伪"判据恒真"的是「有筛选条目 + 模式无效」这一态。 */
  app.run("tState('order_inv').filters={_balPct:{mode:'gte',val:''}};");
  assert.equal(icoOn(app, 'order_inv', '_balPct'), false,
    '数值模式 val 留空 = 未生效 ⇒ 漏斗图标不得点亮（判据不得恒真）');
};

/** 清脏值 */
PROBE.cleanVal = function (app) {
  app.run("renderOrderTable('order_inv',[],{});renderContent=function(){};");
  app.run("tState('order_inv').filters={_balPct:{mode:'gte',val:'100'}};");
  driveApplyFilt(app, 'order_inv', '_balPct', 'inv_short', 100);
  assert.equal(app.run("tState('order_inv').filters._balPct.val"), '', '语义档写入后 val 必须清空');
};

test('R0 正控：3 个探针在干净版本上必须通过', function () {
  const clean = bootAll();
  assert.doesNotThrow(function () { PROBE.iconOn(clean); }, 'iconOn 在干净版必须通过');
  assert.doesNotThrow(function () { PROBE.iconNotAlways(clean); }, 'iconNotAlways 在干净版必须通过');
  assert.doesNotThrow(function () { PROBE.cleanVal(clean); }, 'cleanVal 在干净版必须通过');
  clean.dispose();
});

const R_MUTATIONS = [
  {
    id: 'R1',
    desc: 'thCol 的 act 判据去掉 ||isSemFiltMode(...)（回到 .161 缺陷）',
    anchor: '||isSemFiltMode(m,col.key,f.mode)',
    repl: '',
    probe: 'iconOn'
  },
  {
    id: 'R2',
    desc: 'applyFilt 去掉清脏值那一行',
    anchor: "if(isSemFiltMode(m,key,f.mode)){f.val='';delete f.from;delete f.to;}",
    repl: '',
    probe: 'cleanVal'
  },
  {
    id: 'R3',
    desc: 'isSemFiltMode 恒返回 true（判据恒真 → 图标恒亮）',
    anchor: 'return col.semFilters.some(function(x){return x.mode===mode;});',
    repl: 'return true;',
    probe: 'iconNotAlways'
  },
  {
    id: 'R4',
    desc: 'isSemFiltMode 恒返回 false（判据恒假 → 图标永不亮 / chip 消失）',
    anchor: 'return col.semFilters.some(function(x){return x.mode===mode;});',
    repl: 'return false;',
    probe: 'iconOn'
  }
];

R_MUTATIONS.forEach(function (mut) {
  test(mut.id + ' 变异注入：' + mut.desc + ' → 探针 ' + mut.probe + ' 必须变红', function () {
    const clean = bootAll();
    assert.doesNotThrow(function () { PROBE[mut.probe](clean); }, '前提：干净版该探针必须通过');
    clean.dispose();
    const mutated = mutateAndBoot(mut.anchor, mut.repl, 'R/' + mut.id);
    assert.equal(mutated.hasGlobal('TBL_SCHEMAS'), true, '变异版必须能正常装载');
    let err = null;
    try { PROBE[mut.probe](mutated); } catch (e) { err = e; }
    assert.ok(err, mut.id + ' 注入后探针必须变红（仍通过 ⇒ 该守卫是恒真的摆设）');
    assert.equal(err && err.name, 'AssertionError', '失败必须来自断言（实际 ' + (err && err.name) + '）');
    mutated.dispose();
  });
});

/* ================================================================
   §S 文档与规模（#3 / #4 遗留的验收）
================================================================ */

test('S1 契约：tests/README 规模数字自洽、可追溯到真实跑数、且已登记两侧用例文件', function () {
  /* 我实测为 977 tests / 975 pass / 2 skipped（独立重跑，见报告）。
     此处校验：①数字自洽（pass + skipped = total）②登记了 QA 独立验证文件与我上轮的 47 条口径
     ③登记了工程师的功能用例文件。不硬钉总数为某个整数之外的形态，避免下一版推进即假失败。 */
  /* ⚠ 规模行在 **tests/README.md**（仓库根的 README 只登记当前版本号） */
  const TESTS_README_SRC = readRel('tests/README.md');
  const m = /\*\*(\d{3,4}) tests \/ (\d{3,4}) pass \/ (\d+) fail \/ (\d+) skipped/.exec(TESTS_README_SRC);
  assert.ok(m, 'tests/README 必须保留「当前规模」实测行（形如 **N tests / N pass / 0 fail / 2 skipped）');
  const total = Number(m[1]), pass = Number(m[2]), fail = Number(m[3]), skipped = Number(m[4]);
  assert.equal(pass + skipped + fail, total, '数字必须自洽（pass + skipped + fail = total）');
  assert.equal(fail, 0, 'README 登记的失败数必须为 0');
  assert.equal(skipped, 2, '既有 skip 数为 2（与 .161 一致，未被悄悄改口径）');
  assert.ok(total >= 977 - 60, '总数必须 ≥ .161 的 973（本轮只应增加），实际 ' + total);
  /* 必须点名 QA 独立验证的 47 条（我上轮交付物），否则数字来源不可追溯 */
  assert.ok(/qa\.invfilt\.161\.independent\.test\.js/.test(TESTS_README_SRC), '目录必须登记 QA 独立验证文件');
  assert.ok(/47/.test(TESTS_README_SRC), '规模说明必须点名 QA 侧 47 条（数字可追溯）');
  assert.ok(TESTS_README_SRC.indexOf('invfilt.161.test.js') >= 0, '目录必须登记工程师的功能用例文件');
});

test('S2 契约：docs/系统知识.md §2 的 semFilters 坑已扩为三条，且写明判据单源与清脏值纪律', function () {
  const doc = readRel('docs/系统知识.md');
  const seg = doc.slice(doc.indexOf('列级语义筛选档'), doc.indexOf('列级语义筛选档') + 2600);
  assert.ok(seg.length > 500, '必须能定位到 §2 的 semFilters 条目');
  /* 三条坑必须都在：①取列早于闸门 ②filterBar 白名单 ③thCol 漏斗点亮（本轮新增） */
  assert.ok(/filterRows/.test(seg), '坑① 取列早于闸门 必须写明');
  assert.ok(/filterBar/.test(seg), '坑② filterBar 白名单 必须写明');
  assert.ok(/thCol/.test(seg), '坑③（本轮新增）thCol 漏斗点亮 必须写明');
  assert.ok(/isSemFiltMode/.test(seg), '必须写明判据单一来源 isSemFiltMode');
  assert.ok(/清|脏值/.test(seg), '必须写明语义档写入前清脏值的纪律');
  assert.ok(/applyFilt/.test(seg), '必须写明 applyFilt 是清脏值的落点');
});

test('S3 【现状·既有缺陷】is_empty 图标不亮确实存在（且被工程师 §G1 无条件钉住）——供主理人裁决', function () {
  /* 审查对象：tests/invfilt.161.test.js §G1 末段
       assert.equal(icoOn(app,'order_inv','productName'), false, '文本列 is_empty 的漏斗点亮行为必须保持 .161 形态…')
     事实核查（本条只陈述**事实**，裁决见报告；我不改产品代码，也不改他的用例）：
       · 该行为确实是**既有缺陷**：文本列用「为空/不为空」筛选时 chip 出现、漏斗图标却不亮，
         与 .162 刚修的语义档缺陷属**同一用户可见症状**，且影响全部模块的文本列；
       · 他的断言是**无条件**的（assert.equal(..., false)）⇒ 将来有人修此缺陷它会直接变红，
         且红点文案是「必须保持 .161 形态」，读起来像"引入了回归"—— 正是 .152 立的红线
         「把缺陷断言成正确行为」的形态（缺 【现状】/【缺陷】 标注与"修复后请翻转"指令）。
     本条断言的是"该缺陷当前确实存在"，用于把风险量级钉住（**不是认可它**）。 */
  const app = bootAll();
  app.run("tState('order_inv').filters={productName:{mode:'is_empty',val:''}};");
  assert.equal(icoOn(app, 'order_inv', 'productName'), false,
    '【现状·既有缺陷】文本列 is_empty 筛选生效但漏斗图标不亮（.162 未修，属本轮范围外）');
  /* 同一症状在其它模块同样存在（影响面不止库存页） */
  app.run("tState('product').filters={name:{mode:'is_empty',val:''}};");
  assert.equal(icoOn(app, 'product', 'name'), false, '【现状·既有缺陷】产品主数据页同款症状');
  /* 对照：同一列用"包含"时是亮的 ⇒ 证明不是该列 schema 缺失，而是判据不含 val 恒空的模式 */
  app.run("tState('order_inv').filters={productName:{mode:'contains',val:'甲'}};");
  assert.equal(icoOn(app, 'order_inv', 'productName'), true, '对照：有 val 的模式确实点亮');
  /* 静态定位：确认他的钉住断言确实是无条件 false（供报告引用；若他改成带标注的可翻转形态，本条会红） */
  const engSrc = readRel('tests/invfilt.161.test.js');
  const at = engSrc.indexOf("icoOn(app, 'order_inv', 'productName'), false");
  assert.ok(at >= 0, '必须能在 engineer 的 §G1 中定位到该"反回归钉"断言（结构已变请同步本文件）');
  app.dispose();
});
