'use strict';
/* ================================================================
   tests/qa.ppshift-advance.independent.test.js
   —— 排产计划「提前」取消「不得早于今天」下限（build 2026-10-07.136 / commit 435e3a8）
      **QA 独立回归 + 独立新增用例**（Edward，未参与本次编码，不接受自述结论）
   ================================================================
   需求（用户原话）：
     「排产计划列表，选中条目进行提前操作时，会提示『已提前 1 条；1 条已提前到今天
      （原计划日期早于今天）：PSCD-20261006-021』，现在要求取消调整的时间不能早于
      原计划时间的这个设定。」
   拍板口径（作为本文件的**期望来源**，而非读取实现反推）：
     1) 提前 N 天 = 原计划日期 − N 天，**允许直接落到今天之前的过去日期**；
     2) 本次需求核心：无跳过项时**零 alert**（静默刷新）；
     3) 已完成 / 已取消 / planDate 非法 → 跳过（不改写 planDate）且提示保留（恰 1 次、列全单号）；
     4) 延后（delay）分支口径不变：+N 天；
     5) logOp 仍记录「原日期 → 新日期」（过去日期也如实入日志）。

   本文件与工程师自测的**正交点**（避免「同一份用例自己证明自己」）：
     §A 改动闭合性（源码静态）：clamped/todayStr/钳制语句 0 残留 + 全仓唯一入口复核
     §B 行为验证（跑**生产函数本身**，非回读源码手工推演）
     §C **反例判别力对拍**：把 .135 旧实现注入隔离副本，证明本文件断言对旧行为**必判负**
        （若断言在旧实现上同样通过 → 断言恒真、无效）
     §D 零改动面回归（ppShiftCustom 1~365 / needAct 权限守卫 / .64 幽灵勾选清理 /
        save+renderContent / 按钮与菜单渲染）
     §E 水印一致性（单一来源 tests/harness/build.js）

   运行：node --test tests/qa.ppshift-advance.independent.test.js
        （**不要用 node -e**，见 tests/README.md §1；文件方式运行才能保证 vm 内字符串不被破坏）
   ================================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createApp } = require('./harness/sandbox');
const build = require('./harness/build');

const ROOT = path.join(__dirname, '..');
const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const { MODULE_FILES } = require('./harness/sandbox');
/* 穷举 js/ 目录（而不是只信 harness 的引入清单）——「js/*.js 无 planDate」这一结论必须覆盖全部文件 */
const JS_DIR = path.join(ROOT, 'js');
const JS_FILES = fs.readdirSync(JS_DIR).filter(function (f) { return /\.js$/.test(f); }).sort();
const MODULE_SRC = JS_FILES.map(function (f) {
  return { rel: 'js/' + f, src: fs.readFileSync(path.join(JS_DIR, f), 'utf8') };
});

/* ================================================================
   工具：跨 realm 转换 / 源码函数抽取（花括号配平）
   ================================================================ */

/** 跨 realm 对象 → 本 realm 纯对象/数组 */
function plain(v) {
  return JSON.parse(JSON.stringify(v));
}

/**
 * 从源码中抽取一个顶层 `function NAME(...){...}` 的完整文本（花括号配平）。
 * 目的：断言「测的就是源码里那段」，而不是手抄一份可能失同步的副本。
 */
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
  ppShiftDays: extractFn(INDEX_SRC, 'ppShiftDays'),
  ppShiftCustom: extractFn(INDEX_SRC, 'ppShiftCustom'),
  ppShiftBtnHtml: extractFn(INDEX_SRC, 'ppShiftBtnHtml'),
  ppToggleShiftMenu: extractFn(INDEX_SRC, 'ppToggleShiftMenu'),
  clearHiddenProdPlanSel: extractFn(INDEX_SRC, 'clearHiddenProdPlanSel'),
  prodPlanRowVisibleInDom: extractFn(INDEX_SRC, 'prodPlanRowVisibleInDom'),
  needAct: extractFn(INDEX_SRC, 'needAct'),
  canAct: extractFn(INDEX_SRC, 'canAct'),
};

/** 统计子串出现次数（源码静态断言用） */
function countOf(hay, needle) {
  return hay.split(needle).length - 1;
}

/**
 * 为源码每一行标注「所属的顶层函数名」（本仓库风格：顶层函数声明在第 0 列、闭合 `}` 亦在第 0 列）。
 * 用于把每个 `.setDate(` 调用点归到它所在的函数上，从而回答
 * 「除 ppShiftDays 外，还有谁在动日期？」这一「唯一入口」问题。
 */
function topLevelFnOwners(src) {
  const lines = src.split('\n');
  const owners = new Array(lines.length).fill(null);
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^function\s+([A-Za-z0-9_$]+)\s*\(/.exec(lines[i]);
    if (m) cur = m[1];
    owners[i] = cur;
    if (lines[i] === '}') cur = null; /* 顶层函数闭合（本仓库无 4 空格缩进的顶层裸块） */
  }
  return owners;
}

/* ================================================================
   工具：独立日期算术（期望值来自「原计划日期 ∓ N 天」的需求口径，
         与生产实现无关；本机为中国时区、无夏令时，故与生产 setDate 口径一致）
   ================================================================ */

function ymd(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** isoShift('2026-10-07', -1) === '2026-10-06' */
function isoShift(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return ymd(d);
}

/* ================================================================
   夹具与驱动器
   ================================================================ */

const ADMIN = { username: 'qa', name: 'QA爱德华', role: 'admin', perms: {} };
/** 有账号但**未授权** prodPlan.ppShift 动作（acts 已配置且为空 → canAct 返回 false） */
const NO_PERM_ACT = { username: 'w1', name: '车间甲', role: 'user', perms: { forms: { prodPlan: true }, acts: {} } };

/** 与 productionPlans 元素同形（只保留本用例相关字段） */
function plan(id, planDate, status) {
  return {
    id: id, deliveryIdx: null, orderId: 'XSDD-20260918-00002', customer: '华东盘厂',
    finalDate: planDate, planDate: planDate, status: status || '待排产', notes: '', items: [],
  };
}

/**
 * 建沙箱并注入夹具。
 * @param {Array} plans productionPlans 夹具
 * @param {Object} [opts] { user, transformMain }
 */
function makeApp(plans, opts) {
  const o = opts || {};
  const app = createApp({ installRecorder: true, transformMain: o.transformMain });
  const spy = { render: 0 };
  app.setGlobals({
    currentUser: o.user === undefined ? ADMIN : o.user,
    orders: [], products: [], deliveries: [], productionReports: [], processTemplates: [],
    productionPlans: plans,
    logs: [],
    renderContent: function () { spy.render++; },
  });
  app.__renderSpy = spy;
  return app;
}

/** 勾选（走生产 selSet，保证选择状态与生产同源；selRows 为 var 全局，可整体重置） */
function select(app, idxs) {
  app.run('selRows={};');
  idxs.forEach(function (i) {
    app.run('selSet("prodPlan").add(' + JSON.stringify(String(i)) + ');');
  });
}

/** 调一次生产 ppShiftDays 并返回全量可观测结果 */
function observe(app, type, days) {
  app.run('ppShiftDays(' + JSON.stringify(type) + ',' + String(days) + ');');
  return {
    planDates: plain(app.getGlobal('productionPlans')).map(function (p) { return p.planDate; }),
    plans: plain(app.getGlobal('productionPlans')),
    alerts: app.alerts.slice(),
    renderCalls: app.__renderSpy.render,
    savedTables: app.recorder.writeOrder(),
    logs: plain(app.getGlobal('logs')),
    selection: plain(app.run('[...selSet("prodPlan")]')),
  };
}

const CLAMP_TXT_RE = /已提前到今天|原计划日期早于今天/;

/* ================================================================
   §A 改动闭合性（源码静态）
   ================================================================ */

test('A1 ppShiftDays 内 clamped / clampedIds / todayStr 使用次数必须为 0（钳制已彻底删除）', function () {
  assert.equal(/\bclamped\b/.test(FN.ppShiftDays), false, '不得残留 clamped 计数');
  assert.equal(/clampedIds/.test(FN.ppShiftDays), false, '不得残留 clampedIds 数组');
  assert.equal(/todayStr\s*\(/.test(FN.ppShiftDays), false, '钳制取消后函数内不应再引用 todayStr()');
  assert.equal(/(^|[^A-Za-z0-9_$])today([^A-Za-z0-9_$]|$)/.test(FN.ppShiftDays.replace(/todayStr/g, '')), false, '不得残留 today 局部变量');
});

test('A2 提前分支不再有任何下限改写：无 nd<today / nd=today，且 const nd 已收敛', function () {
  assert.equal(/\bnd\s*<\s*[A-Za-z_$]/.test(FN.ppShiftDays), false, '不得存在 nd < today 之类的下限比较');
  assert.equal(/nd\s*=\s*today\b/.test(FN.ppShiftDays), false, '不得把 nd 改写为今天');
  assert.equal(/\blet\s+nd\b/.test(FN.ppShiftDays), false, 'nd 不应再是 let（说明可能残留二次赋值）');
  assert.ok(/const\s+nd\s*=\s*fmtDate\(d\)/.test(FN.ppShiftDays), 'nd 必须是 const nd=fmtDate(d)（单次赋值）');
  /* 唯一的方向搬运必须仍是 dir*days（dir：delay=+1 / advance=-1） */
  assert.ok(/d\.setDate\(d\.getDate\(\)\s*\+\s*dir\s*\*\s*days\)/.test(FN.ppShiftDays), '日期搬运必须仍是 dir*days');
  assert.ok(/const\s+dir\s*=\s*type\s*===\s*'delay'\s*\?\s*1\s*:\s*-1/.test(FN.ppShiftDays), 'dir 口径必须不变');
});

test('A3 提示分支只剩「跳过」：alert 恰 3 处，且全文件 0 处钳制文案', function () {
  assert.equal((FN.ppShiftDays.match(/alert\(/g) || []).length, 3, 'alert 应为 3 处：空选 / 全不可 / 有跳过');
  assert.ok(/if\s*\(\s*skipped\s*>\s*0\s*\)\s*alert\s*\(\s*msg\s*\)/.test(FN.ppShiftDays), '必须只剩 if(skipped>0)alert(msg)');
  assert.equal(/skipped\s*>\s*0\s*\|\|\s*clamped/.test(FN.ppShiftDays), false, '不得残留 skipped>0||clamped>0');
  assert.equal(INDEX_SRC.indexOf('已提前到今天'), -1, 'index.html 不得再出现「已提前到今天」');
  assert.equal(INDEX_SRC.indexOf('原计划日期早于今天'), -1, 'index.html 不得再出现「原计划日期早于今天」');
  assert.equal(INDEX_SRC.indexOf('clamped'), -1, 'index.html 不得再出现 clamped 标识符');
});

test('A4 全仓复核：js/*.js 完全不涉及 planDate；index.html 内无任何 planDate×today 的下限比较', function () {
  /* (0) 扫描范围自证：js/ 目录被穷举，且 harness 引入清单被覆盖（防「只扫了自己记得的那几个文件」） */
  assert.ok(JS_FILES.length >= 5, 'js/ 目录应至少 5 个模块，实际：' + JSON.stringify(JS_FILES));
  MODULE_FILES.forEach(function (rel) {
    assert.ok(JS_FILES.indexOf(rel.replace(/^js\//, '')) >= 0, 'harness 引入的 ' + rel + ' 必须在本用例扫描范围内');
  });
  /* (1) 拆出的模块脚本里一个 planDate 都没有 → 提前/延后逻辑不可能藏在 js/ 内 */
  MODULE_SRC.forEach(function (m) {
    assert.equal(m.src.indexOf('planDate'), -1, m.rel + ' 不应出现 planDate（提前逻辑不在此模块）');
  });
  /* (2) index.html 中所有「写 planDate」的站点逐行取出，断言无一带 today 下限 */
  const lines = INDEX_SRC.split('\n');
  const writeSites = [];
  lines.forEach(function (ln, i) {
    if (/\.planDate\s*=/.test(ln)) writeSites.push({ n: i + 1, text: ln });
  });
  assert.ok(writeSites.length >= 3, '至少应枚举到 ppShiftDays / saveProdPlan / copyProdPlan 三类写入点，实际：' + JSON.stringify(writeSites));
  writeSites.forEach(function (s) {
    assert.equal(/[<>]=?[^=]/.test(s.text) && /today/i.test(s.text), false,
      'index.html:' + s.n + ' 不得是「planDate 与 today 的比较/钳制」：' + s.text.trim());
  });
  /* (3) 不存在整体的「日期与今天比较后再回写」形态（跨行也要挡住） */
  assert.equal(/nd\s*<\s*today/.test(INDEX_SRC), false, '全文件不得出现 nd<today');
  assert.equal(/planDate\s*[<>]=?\s*todayStr\(\)/.test(INDEX_SRC), false, '全文件不得出现 planDate 与 todayStr() 比较');
  /* 反向自证：writeSites 抽取自身是活的（应能命中 ppShiftDays 的 p.planDate=nd） */
  assert.ok(writeSites.some(function (s) { return /p\.planDate\s*=\s*nd/.test(s.text); }), 'writeSites 抽取必须命中 ppShiftDays');
  assert.equal(lines.length > 6000, true, 'index.html 行数正常（防止抽错文件）');
});

test('A5 ppShiftDays 是「批量提前」唯一入口：全仓仅 5 处引用，js/*.js 0 处', function () {
  assert.equal(countOf(INDEX_SRC, 'ppShiftDays'), 5, 'index.html 应恰 5 处：3 个按钮 onclick + ppShiftCustom 委托 + 定义');
  MODULE_SRC.forEach(function (m) {
    assert.equal(countOf(m.src, 'ppShiftDays'), 0, m.rel + ' 不应引用 ppShiftDays');
  });
  /* 3 个按钮入口 + 1 个自定义委托 + 1 个定义，逐项点名（防被换成另一个函数悄悄接管） */
  assert.ok(FN.ppShiftBtnHtml.indexOf("ppShiftDays(\\'") >= 0, 'ppShiftBtnHtml 必须以 ppShiftDays 作为唯一点击入口');
  assert.equal(countOf(FN.ppShiftBtnHtml, 'ppShiftDays('), 3, '按钮组应恰 3 个入口：±1 / 3 天 / 7 天');
  assert.ok(FN.ppShiftCustom.indexOf('ppShiftDays(type,v)') >= 0, 'ppShiftCustom 必须委托 ppShiftDays');
  /* 除 ppShiftDays 外，不得存在第二个「用 setDate 改排产计划 planDate」的函数 */
  const owners = topLevelFnOwners(INDEX_SRC);
  const lines = INDEX_SRC.split('\n');
  const setDateSites = [];
  lines.forEach(function (ln, i) {
    if (/\.setDate\s*\(/.test(ln)) setDateSites.push({ n: i + 1, fn: owners[i], text: ln.trim() });
  });
  assert.ok(setDateSites.length >= 6, '应枚举到日历/视图/批量三类 setDate 站点，实际：' + JSON.stringify(setDateSites));
  /* 每个 setDate 站点必须能归属到某个函数（否则定位失效，断言将失效——先自证） */
  setDateSites.forEach(function (s) {
    assert.ok(s.fn, 'index.html:' + s.n + ' 的 setDate 无法归属到顶层函数，定位工具失效');
  });
  /* 「同时引用 productionPlans 且调用 setDate」的函数必须**只有** ppShiftDays */
  const touching = [];
  setDateSites.forEach(function (s) {
    if (touching.indexOf(s.fn) < 0) touching.push(s.fn);
  });
  const movesPlanDate = touching.filter(function (fn) { return /productionPlans/.test(extractFn(INDEX_SRC, fn)); });
  assert.deepStrictEqual(movesPlanDate, ['ppShiftDays'],
    '唯一用 setDate 搬运排产计划日期的函数必须是 ppShiftDays，实际：' + JSON.stringify(movesPlanDate) +
    '（全部 setDate 归属：' + JSON.stringify(setDateSites) + '）');
  /* 视图日期导航 ppShiftDate 只移动 planDateFrom/planDateTo/planViewDate，不碰排产计划 */
  const FN_VIEW_NAV = extractFn(INDEX_SRC, 'ppShiftDate');
  assert.equal(/productionPlans/.test(FN_VIEW_NAV), false, 'ppShiftDate 不得触碰 productionPlans');
  assert.equal(/\.planDate\b/.test(FN_VIEW_NAV), false, 'ppShiftDate 不得写 p.planDate');
  assert.ok(/planDateFrom|planDateTo|planViewDate/.test(FN_VIEW_NAV), 'ppShiftDate 应只改视图参照日');
  /* dir*days 这一「批量搬运」形态必须全仓唯一 */
  assert.equal(countOf(INDEX_SRC, 'd.setDate(d.getDate()+dir*days)'), 1, 'dir*days 形态必须唯一（= ppShiftDays）');
});

/* ================================================================
   §B 行为验证（跑生产函数 ppShiftDays 本身）
   ================================================================ */

test('B1 【用户原话现场】原计划=今天，提前 1 天 → 落到昨天（过去日期），且零 alert', function () {
  const app = makeApp([plan('PSCD-20261007-001', '2026-10-07', '待排产')]);
  const today = app.run('todayStr()');
  select(app, [0]);
  const o = observe(app, 'advance', 1);

  assert.equal(o.planDates[0], '2026-10-06', '必须是字面量 2026-10-06（提前 1 天 = 原值 −1）');
  assert.equal(o.planDates[0] < today, true, '结果必须早于今天（= 今天时被要求落到过去日期）；today=' + today);
  assert.equal(o.plans[0].planDate, '2026-10-06', '对象字段确实被改写');
  assert.equal(o.alerts.length, 0, '【需求核心】无跳过项 → alert 调用次数必须为 0，实际：' + JSON.stringify(o.alerts));
  assert.equal(o.renderCalls, 1, '静默刷新＝仍调用一次 renderContent()');
  assert.equal(app.recorder.countOf('productionPlans'), 1, '仍落盘一次 productionPlans');
  app.dispose();
});

test('B2 原计划 = 今天−1，提前 1 天 → 今天−2（连续兑现，不受今天闸门影响）', function () {
  const app = makeApp([]);
  const today = app.run('todayStr()');
  const start = isoShift(today, -1);
  const want = isoShift(today, -2);
  app.setGlobal('productionPlans', [plan('PSCD-A', start, '待排产')]);
  select(app, [0]);
  const o = observe(app, 'advance', 1);

  assert.equal(o.planDates[0], want, '期望 ' + want + '（原 ' + start + ' −1 天）');
  assert.equal(o.planDates[0] < today, true, '必须留在过去');
  assert.equal(o.alerts.length, 0, '零 alert');
  app.dispose();
});

test('B3 字面量金样例：2026-10-06 提前 1 天 = 2026-10-05；2026-10-07 提前 1 天 = 2026-10-06', function () {
  const app = makeApp([plan('PSCD-20261006-021', '2026-10-06', '待排产'), plan('PSCD-20261007-002', '2026-10-07', '待排产')]);
  select(app, [0, 1]);
  const o = observe(app, 'advance', 1);

  assert.equal(o.planDates[0], '2026-10-05', '2026-10-06 −1 → 2026-10-05');
  assert.equal(o.planDates[1], '2026-10-06', '2026-10-07 −1 → 2026-10-06');
  assert.equal(o.alerts.length, 0, '零 alert');
  app.dispose();
});

test('B4 提前 30 天跨月 → 2026-09-07 类过去日期（不越月界不报错）', function () {
  const app = makeApp([plan('PSCD-20261007-003', '2026-10-07', '待排产')]);
  select(app, [0]);
  const o = observe(app, 'advance', 30);

  assert.equal(o.planDates[0], '2026-09-07', '2026-10-07 −30 → 2026-09-07');
  assert.equal(/^\d{4}-\d{2}-\d{2}$/.test(o.planDates[0]), true, '格式必须合法（非 Invalid Date / NaN）');
  assert.equal(o.alerts.length, 0, '零 alert');
  app.dispose();
});

test('B5 跨年提前：2026-01-05 提前 10 天 → 2025-12-26，不越界不报错', function () {
  const app = makeApp([plan('PSCD-20260105-001', '2026-01-05', '待排产')]);
  select(app, [0]);
  const o = observe(app, 'advance', 10);

  assert.equal(o.planDates[0], '2025-12-26', '2026-01-05 −10 → 2025-12-26');
  assert.equal(o.alerts.length, 0, '零 alert');
  /* 极端跨度：提前 365 天也不得抛错 / 产生 NaN */
  app.setGlobal('productionPlans', [plan('PSCD-20260105-002', '2026-01-05', '待排产')]);
  app.browser.clearMessages();
  select(app, [0]);
  const o2 = observe(app, 'advance', 365);
  assert.equal(o2.planDates[0], isoShift('2026-01-05', -365), '提前 365 天须为纯算术结果');
  assert.equal(/^\d{4}-\d{2}-\d{2}$/.test(o2.planDates[0]), true, '不得为 Invalid Date');
  app.dispose();
});

test('B6 零 alert 显式断言：成功路径不得包含任何钳制文案（逐条扫描全部 alert）', function () {
  const app = makeApp([plan('PSCD-A', '2026-10-07', '待排产'), plan('PSCD-B', '2026-10-06', '生产中')]);
  select(app, [0, 1]);
  const o = observe(app, 'advance', 3);

  assert.equal(o.alerts.length, 0, 'alert 次数必须为 0');
  o.alerts.forEach(function (m) {
    assert.equal(CLAMP_TXT_RE.test(m), false, '任何 alert 都不得含钳制文案：' + m);
  });
  /* 双保险：即使有人把 alert 换成别的提示通道，文案也不得出现 */
  assert.equal(CLAMP_TXT_RE.test(JSON.stringify(o)), false, '整轮可观测结果内不得出现钳制文案');
  app.dispose();
});

test('B7 延后（delay）分支口径不变：+N 天，跨日后仍严格递增', function () {
  const app = makeApp([plan('PSCD-D1', '2026-10-07', '待排产'), plan('PSCD-D2', '2026-10-31', '待排产'), plan('PSCD-D3', '2026-12-31', '待排产')]);
  select(app, [0, 1, 2]);
  const o = observe(app, 'delay', 1);

  assert.equal(o.planDates[0], '2026-10-08', '2026-10-07 +1 → 2026-10-08');
  assert.equal(o.planDates[1], '2026-11-01', '2026-10-31 +1 → 2026-11-01（跨月）');
  assert.equal(o.planDates[2], '2027-01-01', '2026-12-31 +1 → 2027-01-01（跨年）');
  assert.equal(o.alerts.length, 0, '零 alert');
  /* 延后 7 天 */
  app.browser.clearMessages();
  app.setGlobal('productionPlans', [plan('PSCD-D4', '2026-10-07', '待排产')]);
  select(app, [0]);
  const o2 = observe(app, 'delay', 7);
  assert.equal(o2.planDates[0], '2026-10-14', '2026-10-07 +7 → 2026-10-14');
  app.dispose();
});

test('B8 跳过项：已完成 / 已取消 / planDate 非法 → planDate 不被改写，且提示恰 1 次并列全单号', function () {
  const app = makeApp([
    plan('PSCD-DONE-001', '2026-10-07', '已完成'),
    plan('PSCD-CANCEL-002', '2026-10-07', '已取消'),
    plan('PSCD-BADATE-003', '', '待排产'),
    plan('PSCD-OK-004', '2026-10-07', '待排产'),
  ]);
  select(app, [0, 1, 2, 3]);
  const o = observe(app, 'advance', 1);

  assert.equal(o.planDates[0], '2026-10-07', '已完成：planDate 不得被改写');
  assert.equal(o.planDates[1], '2026-10-07', '已取消：planDate 不得被改写');
  assert.equal(o.planDates[2], '', 'planDate 非法：不得被改写（仍为空串）');
  assert.equal(o.planDates[3], '2026-10-06', '唯一可操作项正常提前到过去日期');
  assert.equal(o.alerts.length, 1, '有跳过项 → 恰 1 次 alert');
  assert.ok(/已提前 1 条/.test(o.alerts[0]), '提示须含成功条数：' + o.alerts[0]);
  assert.ok(/跳过 3 条（已完成\/已取消）/.test(o.alerts[0]), '提示须含跳过条数：' + o.alerts[0]);
  ['PSCD-DONE-001', 'PSCD-CANCEL-002', 'PSCD-BADATE-003'].forEach(function (id) {
    assert.ok(o.alerts[0].indexOf(id) >= 0, '提示须列全被跳过的单号：' + id);
  });
  assert.equal(CLAMP_TXT_RE.test(o.alerts[0]), false, '跳过提示中不得夹带钳制文案');
  assert.equal(o.renderCalls, 1, '成功 + 跳过混合仍只渲染一次');
  app.dispose();
});

test('B9 混合场景（1 条落过去 + 1 条已完成跳过）→ 提示只含「跳过 1 条」，绝无「已提前到今天」字样', function () {
  const app = makeApp([
    plan('PSCD-20261006-021', '2026-10-06', '待排产'),
    plan('PSCD-DONE-777', '2026-10-07', '已完成'),
  ]);
  select(app, [0, 1]);
  const o = observe(app, 'advance', 1);

  assert.equal(o.planDates[0], '2026-10-05', '可操作项落到 2026-10-05（过去）');
  assert.equal(o.planDates[1], '2026-10-07', '已完成项不动');
  assert.equal(o.alerts.length, 1, '恰 1 次 alert（跳过提示）');
  assert.ok(/已提前 1 条；跳过 1 条（已完成\/已取消）：PSCD-DONE-777/.test(o.alerts[0]),
    '提示文案应与 .136 期望完全一致，实际：' + o.alerts[0]);
  assert.equal(/已提前到今天/.test(o.alerts[0]), false, '绝不出现「已提前到今天」');
  assert.equal(/原计划日期早于今天/.test(o.alerts[0]), false, '绝不出现「原计划日期早于今天」');
  app.dispose();
});

test('B10 多条同选（4 条）逐条核对 planDate 与 done 计数（3 成功 + 1 跳过）', function () {
  const today = '2026-10-07';
  const app = makeApp([
    plan('PSCD-M1', '2026-10-07', '待排产'),
    plan('PSCD-M2', '2026-10-20', '生产中'),
    plan('PSCD-M3', '2026-11-15', '待排产'),
    plan('PSCD-M4', '2026-10-07', '已取消'),
    plan('PSCD-M5', '2026-12-31', '生产中'),
  ]);
  select(app, [0, 1, 2, 3, 4]);
  const o = observe(app, 'advance', 5);

  assert.equal(o.planDates[0], isoShift('2026-10-07', -5), 'M1 逐条核对');
  assert.equal(o.planDates[1], isoShift('2026-10-20', -5), 'M2 逐条核对');
  assert.equal(o.planDates[2], isoShift('2026-11-15', -5), 'M3 逐条核对');
  assert.equal(o.planDates[3], '2026-10-07', 'M4（已取消）保持原值');
  assert.equal(o.planDates[4], isoShift('2026-12-31', -5), 'M5 逐条核对（跨年）');
  /* done 计数：3 成功（M1/M2/M3/M5 中 3 条待排产/生产中 + 1 条已取消 → 实际 4 成功 1 跳过） */
  assert.equal(o.alerts.length, 1, '有 1 条跳过 → 恰 1 次 alert');
  assert.ok(/已提前 4 条/.test(o.alerts[0]), 'done 计数须为 4：' + o.alerts[0]);
  assert.ok(/跳过 1 条（已完成\/已取消）：PSCD-M4/.test(o.alerts[0]), '跳过项须点名 M4：' + o.alerts[0]);
  /* 每条日志逐条核对 */
  assert.equal(o.logs.length, 4, '4 条成功 → 4 条操作日志');
  assert.equal(CLAMP_TXT_RE.test(JSON.stringify(o.logs)), false, '日志不得含钳制文案');
  assert.ok(today.length === 10, 'sanity');
  app.dispose();
});

test('B11 logOp 仍记录「原日期 → 新日期」，过去日期如实入日志（action=提前 / target=排产计划）', function () {
  const app = makeApp([plan('PSCD-20261006-021', '2026-10-06', '待排产')]);
  select(app, [0]);
  const o = observe(app, 'advance', 1);

  assert.equal(o.logs.length, 1, '恰 1 条日志');
  assert.equal(o.logs[0].action, '提前', 'action 必须为「提前」');
  assert.equal(o.logs[0].target, '排产计划', 'target 必须为「排产计划」');
  assert.equal(o.logs[0].detail, '排产单「PSCD-20261006-021」计划日期 2026-10-06 → 2026-10-05',
    '日志须如实记录 原日期 → 新日期（过去日期不得被抹成今天）');
  app.dispose();
});

test('B12 未勾选任何条目：口径不变，提示并提前返回（不写盘不渲染）', function () {
  const app = makeApp([plan('PSCD-A', '2026-10-07', '待排产')]);
  select(app, []);
  const o = observe(app, 'advance', 1);

  assert.equal(o.alerts.length, 1, '应提示一次');
  assert.equal(o.alerts[0], '请先勾选要提前的排产计划', '文案口径不变');
  assert.equal(o.planDates[0], '2026-10-07', 'planDate 不变');
  assert.equal(app.recorder.countOf('productionPlans'), 0, '未落盘');
  assert.equal(o.renderCalls, 0, '未渲染');
  app.dispose();
});

test('B13 所选全部不可提前（done===0）：提示列全单号并 return（不落盘不渲染）', function () {
  const app = makeApp([plan('PSCD-D1', '2026-10-07', '已完成'), plan('PSCD-D2', '2026-10-07', '已取消')]);
  select(app, [0, 1]);
  const o = observe(app, 'advance', 1);

  assert.equal(o.alerts.length, 1, '应提示一次');
  assert.ok(/所选排产计划均不可提前（需为「待排产」或「生产中」）/.test(o.alerts[0]), '文案口径不变：' + o.alerts[0]);
  assert.ok(o.alerts[0].indexOf('PSCD-D1') >= 0 && o.alerts[0].indexOf('PSCD-D2') >= 0, '须列全单号');
  assert.equal(o.planDates[0], '2026-10-07', 'planDate 不变');
  assert.equal(o.planDates[1], '2026-10-07', 'planDate 不变');
  assert.equal(app.recorder.countOf('productionPlans'), 0, '不落盘');
  assert.equal(o.renderCalls, 0, '不渲染');
  assert.equal(o.logs.length, 0, '无成功项 → 无日志');
  app.dispose();
});

/* ================================================================
   §C 反例判别力对拍：把 .135 旧实现注入隔离副本
      若本文件的断言在旧实现上「同样通过」，则断言恒真、无效 → 必须重写。
   ================================================================ */

/**
 * 由**当前** ppShiftDays 反向施加 commit 435e3a8 记录的 3 组删除，还原出 .135 旧实现。
 * 每一步都断言替换真的生效，确保「变异体」不是空操作（否则对拍无意义）。
 */
function revToOld135Impl(fnText) {
  let t = fnText;
  const steps = [];

  /* (1) 还原 const today=todayStr();、clamped/clampedIds 计数 */
  const a1 = "  const act=type==='delay'?'延后':'提前';\n  let done=0,skipped=0;\n  const skippedIds=[];";
  const b1 = "  const act=type==='delay'?'延后':'提前';\n  const today=todayStr();\n  let done=0,skipped=0,clamped=0;\n  const skippedIds=[],clampedIds=[];";
  steps.push([a1, b1]);

  /* (2) 还原「提前不低于今天」的钳制改写，并把 const nd 退回 let nd */
  const a2 = '    const nd=fmtDate(d);\n    p.planDate=nd;';
  const b2 = "    let nd=fmtDate(d);\n    if(type==='advance'&&nd<today){nd=today;clamped++;clampedIds.push(p.id);}\n    p.planDate=nd;";
  steps.push([a2, b2]);

  /* (3) 还原「M 条已提前到今天」提示与 alert 触发条件 */
  const a3 = "  if(skipped>0)msg+='；跳过 '+skipped+' 条（已完成/已取消）：'+skippedIds.join('、');\n  if(skipped>0)alert(msg);";
  const b3 = "  if(skipped>0)msg+='；跳过 '+skipped+' 条（已完成/已取消）：'+skippedIds.join('、');\n  if(clamped>0)msg+='；'+clamped+' 条已'+act+'到今天（原计划日期早于今天）：'+clampedIds.join('、');\n  if(skipped>0||clamped>0)alert(msg);";
  steps.push([a3, b3]);

  steps.forEach(function (s, i) {
    const before = t;
    t = t.replace(s[0], s[1]);
    if (t === before) throw new Error('变异注入失败：第 ' + (i + 1) + ' 组替换未生效（源码形态已变，请同步本用例）');
  });
  return t;
}

/** 本文件「§B 核心断言」的判定器：返回未通过项列表（空数组 = 通过） */
function judgeCoreAdvance(obs, today) {
  const fails = [];
  const want = isoShift(today, -1);
  if (obs.planDates[0] !== want) fails.push('日期应为' + want + '，实际' + obs.planDates[0]);
  if (!(obs.planDates[0] < today)) fails.push('结果未落在过去日期（today=' + today + '）');
  if (obs.alerts.length !== 0) fails.push('不应有 alert，实际 ' + obs.alerts.length + ' 次');
  obs.alerts.forEach(function (m) {
    if (CLAMP_TXT_RE.test(m)) fails.push('出现钳制文案：' + m);
  });
  return fails;
}

/** 混合场景（1 成功落过去 + 1 已完成跳过）的判定器 */
function judgeMixedAdvance(obs) {
  const fails = [];
  if (obs.planDates[0] !== '2026-10-05') fails.push('可操作项应为 2026-10-05，实际 ' + obs.planDates[0]);
  if (obs.planDates[1] !== '2026-10-07') fails.push('已完成项不应被改写，实际 ' + obs.planDates[1]);
  if (obs.alerts.length !== 1) fails.push('应恰 1 次 alert，实际 ' + obs.alerts.length);
  else if (!/已提前 1 条；跳过 1 条（已完成\/已取消）：PSCD-DONE-777/.test(obs.alerts[0])) {
    fails.push('提示文案不符：' + obs.alerts[0]);
  }
  obs.alerts.forEach(function (m) {
    if (CLAMP_TXT_RE.test(m)) fails.push('出现钳制文案：' + m);
  });
  return fails;
}

function runCoreScenario(app) {
  /* 2026-10-08.140 修复（测试自身的时间耦合缺陷，与业务代码无关）：
     场景日期/单号原为硬编码 '2026-10-07' / 'PSCD-20261007-001'，而 judgeCoreAdvance 以
     「今天 −1 天」为期望 → **跨日即失败**（10-08 实测报「日期应为 2026-10-07，实际 2026-10-06」：
     场景日期 10-07 变成了「昨天」，减 1 天得 10-06，而期望始终是 today−1）。
     改为按运行时「今天」构造，断言与实现同源 → 任何日期运行恒真。 */
  const t = app.run('todayStr()');
  const id = 'PSCD-' + t.replace(/-/g, '') + '-001';
  app.setGlobal('productionPlans', [plan(id, t, '待排产')]);
  app.browser.clearMessages();
  select(app, [0]);
  return observe(app, 'advance', 1);
}

function runMixedScenario(app) {
  app.setGlobal('productionPlans', [
    plan('PSCD-20261006-021', '2026-10-06', '待排产'),
    plan('PSCD-DONE-777', '2026-10-07', '已完成'),
  ]);
  app.browser.clearMessages();
  select(app, [0, 1]);
  return observe(app, 'advance', 1);
}

test('C1 变异注入本身可信：还原出的 .135 实现确实含钳制三要素，且与当前实现不同', function () {
  const OLD = revToOld135Impl(FN.ppShiftDays);
  assert.notEqual(OLD, FN.ppShiftDays, '变异体必须与当前实现不同');
  assert.ok(/const\s+today\s*=\s*todayStr\(\)/.test(OLD), '旧实现必须有 today 取值');
  assert.ok(/let\s+done=0,skipped=0,clamped=0/.test(OLD), '旧实现必须有 clamped 计数');
  assert.ok(/if\(type==='advance'&&nd<today\)\{nd=today;clamped\+\+;clampedIds\.push\(p\.id\);\}/.test(OLD), '旧实现必须有钳制语句');
  assert.ok(/clamped\+\+/.test(OLD), '旧实现必须有 clamped++');
  assert.ok(/条已'\+act\+'到今天（原计划日期早于今天）/.test(OLD), '旧实现必须有钳制提示');
  assert.ok(/if\(skipped>0\|\|clamped>0\)alert\(msg\)/.test(OLD), '旧实现 alert 条件必须含 clamped');
  /* 反向：当前实现这些都不许有 */
  assert.equal(/clamped/.test(FN.ppShiftDays), false);
  assert.equal(/nd<today/.test(FN.ppShiftDays), false);
  assert.equal(CLAMP_TXT_RE.test(FN.ppShiftDays), false);
  /* 体量差异应恰为「删除 3 行 / 新增 0 行」级（不追求精确，但必须是同一函数的小改） */
  assert.equal(Math.abs(OLD.length - FN.ppShiftDays.length) < 400, true, '变异体应是同一函数的小改，非替换整段');
});

test('C2 【对拍】同一输入：新实现 → 过去日期且 0 alert；旧实现 → 钳制到今天且弹「已提前到今天」', function () {
  const OLD = revToOld135Impl(FN.ppShiftDays);

  /* 新实现（生产实况） */
  const newApp = makeApp([]);
  const today = newApp.run('todayStr()');
  const newObs = runCoreScenario(newApp);

  /* 旧实现（隔离副本：仅把主脚本里的 ppShiftDays 换成 .135 版，其余代码一字不动） */
  let injected = false;
  const oldApp = makeApp([], {
    transformMain: function (code) {
      if (code.indexOf(FN.ppShiftDays) < 0) throw new Error('变异注入失败：主脚本内未找到当前 ppShiftDays');
      const out = code.replace(FN.ppShiftDays, OLD);
      if (out === code) throw new Error('变异注入失败：替换未生效');
      injected = true;
      return out;
    },
  });
  assert.equal(injected, true, '旧实现确实被注入（否则对拍是假的）');
  assert.equal(oldApp.run('todayStr()'), today, '两副本的「今天」必须一致');
  const oldObs = runCoreScenario(oldApp);

  /* ---- 原始输出（供报告引用） ---- */
  const raw = {
    today: today,
    new: { planDate: newObs.planDates[0], alertCount: newObs.alerts.length, alerts: newObs.alerts },
    old: { planDate: oldObs.planDates[0], alertCount: oldObs.alerts.length, alerts: oldObs.alerts },
  };
  assert.equal(typeof raw.new.planDate, 'string');

  /* 核心对拍：本文件的 §B 断言（judgeCoreAdvance）在新实现上判 PASS、在旧实现上必须判 FAIL */
  const newFails = judgeCoreAdvance(newObs, today);
  const oldFails = judgeCoreAdvance(oldObs, today);
  assert.equal(newFails.length, 0, '新实现必须通过本文件断言：' + JSON.stringify({ raw: raw, fails: newFails }));
  assert.ok(oldFails.length > 0,
    '【判别力自证】旧实现必须被本文件断言判负，否则断言恒真无效；raw=' + JSON.stringify(raw));

  /* 旧实现的精确形态 = 用户报告原话 */
  assert.equal(oldObs.planDates[0], today, '旧实现：日期被钳制为「今天」');
  assert.equal(oldObs.alerts.length, 1, '旧实现：必有 1 次 alert');
  assert.ok(/已提前到今天（原计划日期早于今天）/.test(oldObs.alerts[0]),
    '旧实现：提示应精确复现用户原话，实际：' + oldObs.alerts[0]);
  assert.ok(oldObs.alerts[0].indexOf('PSCD-' + today.replace(/-/g, '') + '-001') >= 0, '旧实现：提示应列单号');

  /* 新旧结果必须不同（同输入不同输出 = 行为确实改变） */
  assert.notEqual(newObs.planDates[0], oldObs.planDates[0], '新旧实现结果必须不同');
  assert.notEqual(newObs.alerts.length, oldObs.alerts.length, '新旧实现 alert 次数必须不同（0 vs 1）');

  newApp.dispose();
  oldApp.dispose();
});

test('C3 【对拍】混合场景：新实现提示只含「跳过 1 条」，旧实现额外夹带「已提前到今天」', function () {
  const OLD = revToOld135Impl(FN.ppShiftDays);

  const newApp = makeApp([]);
  const newObs = runMixedScenario(newApp);

  const oldApp = makeApp([], {
    transformMain: function (code) {
      const out = code.replace(FN.ppShiftDays, OLD);
      if (out === code) throw new Error('变异注入失败：替换未生效');
      return out;
    },
  });
  const oldObs = runMixedScenario(oldApp);

  const newFails = judgeMixedAdvance(newObs);
  const oldFails = judgeMixedAdvance(oldObs);
  assert.equal(newFails.length, 0, '新实现必须通过混合场景断言：' + JSON.stringify({ newObs: newObs, fails: newFails }));
  assert.ok(oldFails.length > 0, '【判别力自证】旧实现必须判负：' + JSON.stringify({ oldObs: oldObs }));

  /* 旧实现：1 条「落今天」被 clamp → 提示里多出钳制片段；新实现：只有跳过片段 */
  assert.equal(newObs.alerts.length, 1, '新实现：恰 1 次 alert（纯跳过提示）');
  assert.equal(CLAMP_TXT_RE.test(newObs.alerts[0]), false, '新实现：无钳制文案');
  assert.ok(/已提前到今天/.test(oldObs.alerts[0]), '旧实现：提示夹带「已提前到今天」');
  assert.ok(/原计划日期早于今天/.test(oldObs.alerts[0]), '旧实现：提示夹带「原计划日期早于今天」前因');
  assert.equal(oldObs.planDates[0], newApp.run('todayStr()'), '旧实现：可操作项被钳制到今天');
  assert.notEqual(oldObs.planDates[0], newObs.planDates[0], '新旧可操作项结果必须不同');

  newApp.dispose();
  oldApp.dispose();
});

/* ================================================================
   §D 零改动面回归
   ================================================================ */

test('D1 ppShiftCustom 仍校验 1~365：0 / 366 / 非数字 被拦截；1 与 365 放行', function () {
  assert.ok(/v<1\|\|v>365/.test(FN.ppShiftCustom), '源码必须保留 1~365 校验');
  assert.ok(FN.ppShiftCustom.indexOf('请输入 1~365 的整数天数') >= 0, '提示文案不变');

  const app = makeApp([plan('PSCD-C1', '2026-10-07', '待排产')]);
  let focused = 0;
  const inp = { value: '0', focus: function () { focused++; } };
  app.setGlobal('__inp', inp);
  select(app, [0]);

  /* 越界：0 / 366 / abc / '' 全部拦截，且不落盘不渲染 */
  ['0', '366', 'abc', ''].forEach(function (bad) {
    app.browser.clearMessages();
    inp.value = bad;
    app.run('ppShiftCustom("advance", __inp);');
    assert.equal(app.alerts.length, 1, '非法值 ' + JSON.stringify(bad) + ' 应恰 1 次提示');
    assert.equal(app.alerts[0], '请输入 1~365 的整数天数', '非法值 ' + JSON.stringify(bad) + ' 提示文案');
    assert.equal(plain(app.getGlobal('productionPlans'))[0].planDate, '2026-10-07', '非法值不得改写 planDate');
    assert.equal(app.recorder.countOf('productionPlans'), 0, '非法值不得落盘');
    assert.equal(app.__renderSpy.render, 0, '非法值不得渲染');
  });
  assert.equal(focused, 4, '每次非法输入都应 focus 回输入框');

  /* 合法上界 365 放行 */
  app.browser.clearMessages();
  inp.value = '365';
  app.run('ppShiftCustom("advance", __inp);');
  assert.equal(app.alerts.length, 0, '365 合法：零 alert');
  assert.equal(plain(app.getGlobal('productionPlans'))[0].planDate, isoShift('2026-10-07', -365), '365 天须真正生效');
  assert.equal(app.__renderSpy.render, 1, '合法值渲染一次');

  /* 合法下界 1 放行，且落到 2026-10-06 */
  app.browser.clearMessages();
  app.setGlobal('productionPlans', [plan('PSCD-C2', '2026-10-07', '待排产')]);
  select(app, [0]);
  inp.value = '1';
  app.run('ppShiftCustom("advance", __inp);');
  assert.equal(app.alerts.length, 0, '1 合法：零 alert');
  assert.equal(plain(app.getGlobal('productionPlans'))[0].planDate, '2026-10-06', '1 天须真正生效');
  app.dispose();
});

test('D2 needAct("prodPlan.ppShift") 权限守卫仍在且是第一条语句：无权限 → 提示 + 零副作用', function () {
  assert.ok(/^function\s+ppShiftDays\s*\([^)]*\)\s*\{\s*\n\s*if\(!needAct\('prodPlan\.ppShift'\)\)return;/.test(FN.ppShiftDays),
    'ppShiftDays 首句必须是 needAct 守卫');
  assert.ok(FN.needAct.indexOf('canAct(key)') >= 0, 'needAct 必须仍委托 canAct');

  const app = makeApp([plan('PSCD-P1', '2026-10-07', '待排产')], { user: NO_PERM_ACT });
  assert.equal(app.run('canAct("prodPlan.ppShift")'), false, '前置：该账号确无 ppShift 动作权限');
  select(app, [0]);
  const o = observe(app, 'advance', 1);

  assert.equal(o.alerts.length, 1, '应提示无权限');
  assert.ok(/无此按钮权限/.test(o.alerts[0]), '提示应为权限文案，实际：' + o.alerts[0]);
  assert.equal(o.planDates[0], '2026-10-07', '无权限不得改写 planDate');
  assert.equal(app.recorder.countOf('productionPlans'), 0, '无权限不得落盘');
  assert.equal(o.renderCalls, 0, '无权限不得渲染');
  assert.equal(o.logs.length, 0, '无权限不得记日志');
  app.dispose();
});

test('D3 .64 幽灵勾选清理仍在：成功调整后隐藏行（桩内 DOM 恒不可见）自动取消勾选', function () {
  assert.ok(/clearHiddenProdPlanSel/.test(FN.ppShiftDays), 'ppShiftDays 必须仍调用 clearHiddenProdPlanSel');
  assert.ok(/prodPlanRowVisibleInDom/.test(FN.ppShiftDays), 'ppShiftDays 必须仍以 prodPlanRowVisibleInDom 判定可见性');
  assert.ok(/selSet\('prodPlan'\)\.delete/.test(FN.clearHiddenProdPlanSel), 'clearHiddenProdPlanSel 必须仍从 selSet 删除');
  assert.ok(/data-key="id"/.test(FN.prodPlanRowVisibleInDom), 'prodPlanRowVisibleInDom 必须仍按 data-key="id" 查找');

  const app = makeApp([plan('PSCD-G1', '2026-10-07', '待排产')]);
  select(app, [0]);
  assert.equal(app.run('selCount("prodPlan")'), 1, '前置：已勾选 1 条');
  const o = observe(app, 'advance', 1);

  /* 桩内 querySelectorAll 恒返回 [] → 行恒「不可见」→ .64 路径必然触发 */
  assert.equal(o.selection.length, 0, '成功调整后勾选应被清空（.64 路径生效）');
  assert.equal(app.run('selCount("prodPlan")'), 0, 'selSet 内不得残留幽灵勾选');
  app.dispose();
});

test('D4 成功路径仍 save("productionPlans") + renderContent()；全跳过路径两者都不发生', function () {
  const app = makeApp([plan('PSCD-S1', '2026-10-07', '待排产')]);
  select(app, [0]);
  const o = observe(app, 'advance', 1);
  assert.equal(app.recorder.countOf('productionPlans'), 1, '成功路径恰写一次 productionPlans');
  assert.equal(o.renderCalls, 1, '成功路径恰渲染一次');
  assert.equal(o.savedTables.indexOf('productionPlans'), 0, 'productionPlans 应是首个落盘项');

  app.browser.clearMessages();
  app.setGlobal('productionPlans', [plan('PSCD-S2', '2026-10-07', '已完成')]);
  select(app, [0]);
  const o2 = observe(app, 'advance', 1);
  assert.equal(app.recorder.countOf('productionPlans'), 1, '全跳过路径不得新增落盘（计数仍是 1）');
  assert.equal(o2.renderCalls, 1, '全跳过路径不得新增渲染（计数仍是 1）');
  app.dispose();
});

test('D5 按钮渲染 ppShiftBtnHtml / 菜单 ppToggleShiftMenu 未变（3 入口 + 1~365 输入 + 互斥菜单 id）', function () {
  const h = FN.ppShiftBtnHtml;
  assert.ok(h.indexOf("ppShiftDays(\\'") >= 0, '主按钮/下拉项必须调用 ppShiftDays');
  assert.ok(h.indexOf("+act+' 3 天") >= 0, '下拉应有「3 天」项');
  assert.ok(h.indexOf("+act+' 7 天") >= 0, '下拉应有「7 天」项');
  assert.ok(h.indexOf("min=\"1\" max=\"365\"") >= 0, '自定义输入仍限 1~365');
  assert.ok(h.indexOf("ppShiftCustom(\\'") >= 0, '自定义按钮仍调 ppShiftCustom');
  assert.ok(h.indexOf("ppToggleShiftMenu(\\'") >= 0, '▾ 箭头仍调 ppToggleShiftMenu');
  assert.ok(/const\s+act\s*=\s*type==='delay'\?'延后':'提前'/.test(h), 'act 口径不变');
  assert.ok(h.indexOf('ppDelayWrap') >= 0 && h.indexOf('ppAdvanceWrap') >= 0, '两个 wrap id 不变');
  assert.ok(/plain\?'position:relative;display:inline-flex/.test(h), 'plain 白底样式分支不变');

  const m = FN.ppToggleShiftMenu;
  assert.ok(m.indexOf("['delay','advance']") >= 0, '菜单互斥须遍历 delay/advance');
  assert.ok(m.indexOf('ppDelayMenu') >= 0 && m.indexOf('ppAdvanceMenu') >= 0, '两个菜单 id 不变');
  /* 工具栏门控：延迟/提前按钮仍受 prodPlan.ppShift 约束 */
  assert.ok(/canAct\('prodPlan\.ppShift'\)/.test(INDEX_SRC), '工具栏按钮仍须经 canAct(prodPlan.ppShift) 门控');
});

/* ================================================================
   §E 水印一致性
   ================================================================ */

test('E1 水印：index.html 恰 1 处 >build '+build.BUILD+'<，上一版本 '+build.PREV+' 权威形态 0 处', function () {
  assert.equal((INDEX_SRC.match(build.buildMarkRe(build.BUILD)) || []).length, 1, build.BUILD + ' 权威水印应恰 1 处');
  assert.equal((INDEX_SRC.match(build.buildMarkRe(build.PREV)) || []).length, 0, '上一版本权威形态应为 0 处');
  assert.equal((INDEX_SRC.match(build.buildAnyRe(build.PREV)) || []).length, 0, '上一版本任意形态应为 0 处');
});

test('E2 harness 常量与 index.html 实际水印双向一致（防「测了个寂寞」）', function () {
  assert.equal(build.BUILD, '2026-10-14.151', 'BUILD 必须手写为本次版本');
  assert.equal(build.PREV, '2026-10-14.150', 'PREV 必须手写为上一版本');
  /* 正向：build.js 的 BUILD 必须能在 index.html 中命中 */
  assert.equal((INDEX_SRC.match(build.buildMarkRe(build.BUILD)) || []).length, 1, 'BUILD 必须命中且恰 1 处');
  /* 反向：用 deploy.sh 的提取式从 index.html 抽出实际水印，必须 === BUILD */
  const m = INDEX_SRC.match(/build ([0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+)</);
  assert.ok(m, 'index.html 必须存在 build YYYY-MM-DD.NNN< 形态');
  assert.equal(m[1], build.BUILD, 'deploy.sh 提取结果必须等于 harness BUILD');
  /* 判别力反虚设：不存在的版本号必须命中 0 */
  assert.equal((INDEX_SRC.match(build.buildMarkRe('2026-10-07.999')) || []).length, 0, '伪版本 .999 应命中 0');
});
