'use strict';
/* ================================================================
   tests/qa.table-standard.independent.test.js
   —— 质量系统「表格骨架标准」独立回归（【build .167】T02）
   ================================================================
   用户要求（PRD / SOP）：质量台账的表格必须与**生产订单管理列表**视觉与结构统一。
   `.166` 及以前，`quality/qa-app.js` 还是「单表 + thead」：
       <div class="table-wrap"><table><thead>…</thead><tbody>…</tbody></table></div>
   本版升级为生产同构的**双表结构**（生产做法见 index.html 订单列表，注释写明「借鉴金蝶」）：
       <div class="sticky-head"><div class="head-scroll"><table class="head-tbl">COLGROUP+THEAD</table></div></div>
       <div class="table-wrap"><table class="body-tbl">COLGROUP+TBODY</table></div>

   本文件守什么（**只守结构与调用关系**，不断言像素级宽度 —— DOM 里算不出来，
   宽度断言只能在真实浏览器里做，写在这里只会变成"恒真或恒假"的二选一）：
     §A 双表结构：两表各自带 colgroup、列数同源且 = 列数+1、表头循环仍在 tableHtml 内、
         `? sortTh(cols[c])` 恰 1 次（`qa.ledger-fields §B5` 的变异锚点依赖它）
     §B 列身份：表头走 `data-col`（**严禁** data-key），表体每格 data-col（与 §B2 同向）
     §C 空态：`emptyHtml` / `noMatchHtml` **不**渲染 `.sticky-head`
     §D 三个同步函数被 renderMain 调用，且语义与生产一致（逐条照抄来源）
     §E 滚动跟随：capture 委托 + resize 只注册一次，选择器收敛在 `#content`
     §F CSS / DOM 到位：`.table-wrap` 自身横条必须隐藏（否则双横条）、
        `.card .bulk-bar` 去 margin（否则表头间露缝）、底部滚动条节点存在
     §G 判别力：把源码变异成「单表 / 丢 colgroup / 丢 data-col」时，本文件的判据必须变红

   纪律：本文件**只读源码**，不执行 qa-app.js（它需要真实 DOM 与后端）。
   ================================================================ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const readRel = function (rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); };
const countOcc = function (hay, needle) { return String(hay).split(String(needle)).length - 1; };

const APP = readRel('quality/qa-app.js');
const HTML = readRel('quality/index.html');

/** 取本页内联 <style> 段（质量系统的样式全部内联在 quality/index.html） */
function cssBlock() {
  const a = HTML.indexOf('<style>');
  const b = HTML.indexOf('</style>');
  assert.ok(a > 0 && b > a, 'quality/index.html 必须含内联 <style> 段（本文件的 CSS 判据依赖它）');
  return HTML.slice(a, b);
}

/**
 * 字符串/正则感知的函数体提取：从 `decl`（如 'function tableHtml('）起，
 * 用花括号配平取出**完整函数**（含声明行）。
 * ⚠ 必须字符串感知：qa-app.js 里大量拼接 HTML 字符串，朴素计数器会被 `'{'`、`'}'` 带偏，
 *   一路吃到文件末尾 —— 那会让"函数体内含 X"这类断言彻底失真（本仓库已踩过）。
 * @param {string} src 源码
 * @param {string} decl 声明前缀（必须唯一命中）
 * @returns {string} 函数源码（含声明行）
 */
function fnBody(src, decl) {
  const i = String(src).indexOf(decl);
  assert.ok(i >= 0, '未在源码中定位到 ' + decl + '（结构已变请同步本文件）');
  const j = String(src).indexOf('{', i);
  assert.ok(j > i, decl + ' 之后找不到函数体起始花括号');
  let depth = 0;
  let state = null;          /* null | ' | " | ` | line | block | re */
  let prev = '{';
  for (let k = j; k < src.length; k++) {
    const ch = src[k];
    const nx = src[k + 1];
    if (state === null) {
      if (ch === "'" || ch === '"' || ch === '`') { state = ch; prev = ch; continue; }
      if (ch === '/' && nx === '/') { state = 'line'; k++; continue; }
      if (ch === '/' && nx === '*') { state = 'block'; k++; continue; }
      if (ch === '/') {
        if (!/[A-Za-z0-9_$)\]]/.test(prev)) { state = 're'; prev = '/'; continue; }
      }
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) return src.slice(i, k + 1); }
      if (!/\s/.test(ch)) prev = ch;
      continue;
    }
    if (state === 'line') { if (ch === '\n') state = null; continue; }
    if (state === 'block') { if (ch === '*' && nx === '/') { state = null; k++; } continue; }
    if (state === 're') {
      if (ch === '\\') { k++; continue; }
      if (ch === '[') { let m = k + 1; while (m < src.length && src[m] !== ']') { if (src[m] === '\\') m++; m++; } k = m; continue; }
      if (ch === '/') state = null;
      continue;
    }
    if (ch === '\\') { k++; continue; }
    if (ch === state) state = null;
  }
  assert.fail(decl + ' 的函数体未闭合（提取器失效）');
}

/* 复用型判据（§G 会把变异源码喂给它们，断言"确实变红"——
   「守卫存在但永远绿」比业务 bug 更危险，因为报告看起来全绿） */

/** 是否出现"单表 + thead"回潮（= 表头与表体又合回一张表） */
function badSingleTable(src) {
  const body = fnBody(src, 'function tableHtml(');
  return body.indexOf('sticky-head') < 0
    || body.indexOf('head-tbl') < 0
    || body.indexOf('body-tbl') < 0;
}

/** 表体表是否丢了 colgroup（丢了 ⇒ fixed 布局下列宽无法与表头对齐）
    判据：表体表的拼装语句必须紧跟 `+ colg + '<tbody>'`（colg 是两表同源的那份 colgroup） */
function badBodyColgroup(src) {
  const body = fnBody(src, 'function tableHtml(');
  const bodyIdx = body.indexOf('class="body-tbl"');
  if (bodyIdx < 0) return true;
  return !/\+\s*colg\s*\+\s*'<tbody>'/.test(body.slice(bodyIdx));
}

/** 表头是否丢了列身份（data-col） */
function badThIdentity(src) {
  const body = fnBody(src, 'function sortTh(');
  return !/data-col="' \+ esc\(key\) \+ '"/.test(body);
}

/* ================================================================
   §A 双表结构
================================================================ */

test('A1 契约：tableHtml 输出双表结构（.sticky-head>.head-scroll>table.head-tbl + .table-wrap>table.body-tbl）', function () {
  const body = fnBody(APP, 'function tableHtml(');
  /* 表头表：外层吸附容器 → 横向滚动容器 → 表，三层缺一不可
     （缺 .head-scroll 则表头无法跟随表体横滚；缺 table.head-tbl 则 syncHeadBody 取不到表头 th） */
  assert.ok(/<div class="sticky-head"><div class="head-scroll"><table class="head-tbl">/.test(body),
    '表头必须是 .sticky-head > .head-scroll > table.head-tbl 三层结构');
  assert.ok(body.indexOf('<thead><tr><th class="sel-col"></th>') >= 0,
    '表头表内必须有 thead > tr，且首列是勾选列（sel-col）');
  /* 表体表 */
  assert.ok(/<div class="table-wrap"><table class="body-tbl">/.test(body),
    '表体必须是 .table-wrap > table.body-tbl（表头与表体分离成两张表）');
  assert.ok(body.indexOf('<tbody>') >= 0, '表体表内必须有 tbody');
  /* 反假：不得再出现"同一张表里既有 thead 又有 tbody"的单表形态 */
  assert.strictEqual(/<table>(<colgroup>)?<thead>/.test(body), false,
    '不得残留单表形态 <table><thead>（表头必须已独立成表）');
  assert.strictEqual(badSingleTable(APP), false, '结构判据自检：当前源码必须是双表结构');
});

test('A2 契约：两张表各自带 colgroup，且列数同源 = tableCols().length + 1（勾选列）', function () {
  const body = fnBody(APP, 'function tableHtml(');
  /* 列数必须由 tableCols() 派生（禁止写死 9 / 10）——加字段时两张表一起变 */
  assert.ok(body.indexOf('tableCols()') >= 0, '列数必须由 tableCols() 派生（禁写死列数）');
  assert.ok(/var colN = cols\.length \+ 1;/.test(body),
    'colN 必须 = cols.length + 1（+1 是勾选列 sel-col）');
  /* colgroup 由 colN 生成，且同一个 colg 变量被拼进**两张**表（同源，不可能一多一少） */
  assert.ok(body.indexOf('colgroup') >= 0, '必须生成 colgroup');
  assert.ok(/for \(var g = 0; g < colN; g\+\+\) colg \+= '<col>';/.test(body),
    'colgroup 必须按 colN 逐个生成 <col>');
  const colgUses = countOcc(body, "' + colg");
  assert.strictEqual(colgUses, 2,
    'colg 必须恰被拼进两张表（实际 ' + colgUses + ' 处）—— 一表有一表没有会导致列宽 / 列数错位');
  /* 表头表与表体表各自的 colgroup 都必须落在表名之后（结构性检查） */
  const headIdx = body.indexOf('table class="head-tbl"');
  const bodyIdx = body.indexOf('table class="body-tbl"');
  assert.ok(headIdx >= 0 && bodyIdx >= 0, '两表名必须都在 tableHtml 内');
  assert.ok(body.indexOf('<colgroup>') > 0 && body.indexOf('<colgroup>') < headIdx,
    'colgroup 必须先于首次使用（拼进表头表）生成');
  assert.ok(body.indexOf("' + colg + '<tbody>'") >= 0,
    '表体表必须同样带 colgroup（与表头表同源）');
});

test('A3 契约：表头渲染循环仍在 tableHtml 内，且 `? sortTh(cols[c])` 恰 1 次（qa.ledger-fields §B5 变异锚点）', function () {
  const body = fnBody(APP, 'function tableHtml(');
  assert.ok(body.indexOf('for (var c = 0; c < cols.length; c++)') >= 0,
    '表头渲染循环必须留在 tableHtml 内（不得被抽到外部拼接函数里）');
  /* 该串同时是 qa.ledger-fields §B5 的变异锚点：它命中几次，那边的注入就撒到几处 */
  assert.strictEqual(countOcc(APP, '? sortTh(cols[c])'), 1,
    '`? sortTh(cols[c])` 全文件必须恰 1 次（qa.ledger-fields §B5 依赖其唯一性）');
  assert.ok(body.indexOf('cols[c].sortable') >= 0,
    '可排序判定必须来自列定义（cols[c].sortable），不得在渲染处另立白名单');
});

test('A4 契约：表头列身份走 data-col（严禁 data-key —— 本系统与生产用两套标识）', function () {
  assert.strictEqual(badThIdentity(APP), false, 'sortTh 必须给 th 打 data-col="<key>"');
  /* 红线：质量系统**统一** data-col。生产用 data-key，若这里也引入 data-key 属性，
     双表结构下"表头按 data-key、表体按 data-col"必然错位（设计已明确定为列身份契约）。
     ⚠ 判据看的是**属性形态** `data-key="`，不是注释里提没提到这个词 —— 注释里写"严禁 data-key"
     不该被判红（判据必须针对可执行代码，否则人人都学会绕注释）。 */
  assert.strictEqual(countOcc(APP, 'data-key="'), 0,
    'qa-app.js 不得出现 data-key 属性（本系统列身份统一 data-col）');
  /* 非可排序列的表头也必须带列身份（否则将来加普通列时该列没有身份） */
  const body = fnBody(APP, 'function tableHtml(');
  assert.ok(body.indexOf("data-col=\"' + esc(cols[c].key) + '\"") >= 0,
    '非可排序表头分支同样必须带 data-col');
});

/* ================================================================
   §B 表体列身份（与 qa.ledger-fields §B2 同向，此处只做"双表升级没把它改坏"的回归）
================================================================ */

test('B1 契约：cellHtml 仍给每格打 data-col，applyRowUpdate 仍按 data-col 定位', function () {
  const cell = fnBody(APP, 'function cellHtml(');
  assert.ok(cell.indexOf('data-col="\' + esc(col.key) + \'"') >= 0,
    'cellHtml 必须给 td 打 data-col（表体列身份，双表升级不得改坏）');
  const upd = fnBody(APP, 'function applyRowUpdate(');
  assert.ok(/\[data-col="/.test(upd), 'applyRowUpdate 必须按 [data-col=] 定位单元格');
  assert.strictEqual(/tds\s*\[\s*\d+\s*\]/.test(upd), false,
    'applyRowUpdate 不得用 td 下标（扩列后只会刷新前两列，属静默不一致）');
});

/* ================================================================
   §C 空态不渲染吸附表头
================================================================ */

test('C1 契约：两种空态都不渲染 .sticky-head（没有表体可对齐，挂表头会露出无落点的表头带）', function () {
  ['function emptyHtml(', 'function noMatchHtml('].forEach(function (decl) {
    const body = fnBody(APP, decl);
    assert.strictEqual(body.indexOf('sticky-head'), -1, decl + ' 不得渲染 .sticky-head');
    assert.strictEqual(body.indexOf('head-tbl'), -1, decl + ' 不得渲染表头表');
  });
  /* 结构性证据：tableHtml 在 rows 为空时**提前 return** 空态，不再往下拼双表
     （判据看的是"拼装表头的语句"，不是注释里有没有出现 sticky-head 这几个字） */
  const body = fnBody(APP, 'function tableHtml(');
  const retIdx = body.indexOf("return hasFilter() ? noMatchHtml() : emptyHtml();");
  const headIdx = body.indexOf('<div class="sticky-head">');
  assert.ok(retIdx > 0, 'tableHtml 必须保留「空行 → 空态」的提前返回');
  assert.ok(headIdx > 0, 'tableHtml 必须真的拼出 .sticky-head（否则本判据退化为恒真）');
  assert.ok(retIdx < headIdx, '空态 return 必须在拼双表**之前**（否则空页也会挂一条吸附表头）');
});

/* ================================================================
   §D 三个同步函数：被 renderMain 调用 + 语义与生产一致
================================================================ */

test('D1 契约：renderMain 在 el.innerHTML 之后依次调用 syncHeadBody / fixStickyHeadTop / syncBottomScrollbar', function () {
  const body = fnBody(APP, 'function renderMain(');
  const posHtml = body.indexOf('el.innerHTML = h');
  assert.ok(posHtml > 0, 'renderMain 必须仍有 el.innerHTML = h');
  ['syncHeadBody()', 'fixStickyHeadTop()', 'syncBottomScrollbar()'].forEach(function (call) {
    const p = body.indexOf(call);
    assert.ok(p > 0, 'renderMain 末尾必须调用 ' + call);
    assert.ok(p > posHtml,
      call + ' 必须在 el.innerHTML 之后调用 —— 提前调用拿到的是未布局的表头，宽度全 0');
  });
  assert.ok(body.indexOf('syncHeadBody()') < body.indexOf('syncBottomScrollbar()'),
    '三者的顺序必须是 列宽同步 → 吸附位置 → 底部条（底部条要按最终列宽算可滚距）');
});

test('D2 契约：syncHeadBody 用表头 th 的实测宽度写表体 colgroup，并令表体总宽 = 表头总宽', function () {
  const body = fnBody(APP, 'function syncHeadBody(');
  assert.ok(body.indexOf("querySelectorAll('#content .sticky-head')") >= 0,
    '必须遍历 #content 内的 .sticky-head（选择器收敛在内容区，不抓弹窗/侧栏）');
  assert.ok(body.indexOf('table.head-tbl') >= 0 && body.indexOf('table.body-tbl') >= 0,
    '必须分别取到表头表与表体表');
  assert.ok(body.indexOf('tHead.rows[0]') >= 0, '必须从表头表的 thead 首行取 th');
  assert.ok(/th\.offsetWidth/.test(body), '必须用 th 的**实测宽度**（offsetWidth），不得用配置值');
  assert.ok(/cols\[idx\]\.style\.width = w \+ 'px'/.test(body), '必须把实测宽度写回表体 colgroup 的 col');
  assert.ok(/bt\.style\.width = total \+ 'px'/.test(body), '必须令表体表总宽 = 表头表总宽（否则 fixed 下错位）');
  /* 结构性保险：表体容器必须是表头容器的**下一个兄弟**（双表结构的定位契约） */
  assert.ok(body.indexOf('hd.nextElementSibling') >= 0,
    '表体容器必须取 hd.nextElementSibling（结构契约：.sticky-head 紧跟 .table-wrap）');
});

test('D3 契约：fixStickyHeadTop 按 58/48 基准 + 操作栏实测高度，并把 .tbl-fbar 接进吸附带', function () {
  const body = fnBody(APP, 'function fixStickyHeadTop(');
  assert.ok(/window\.innerWidth <= 768 \? 48 : 58/.test(body),
    '吸附基准必须是 58px（移动端 ≤768px 用 48px），与生产逐字同口径');
  assert.ok(body.indexOf("classList.contains('bulk-bar')") >= 0, '必须向上找 .bulk-bar（操作栏）');
  assert.ok(/bb\.offsetHeight/.test(body), '必须加操作栏**实测高度**（操作栏换行时要自适应）');
  assert.ok(body.indexOf("classList.contains('tbl-fbar')") >= 0,
    '必须处理 .tbl-fbar 叠层段（有筛选条时表头不得与筛选条叠在同一个 top 互相遮挡）');
  assert.ok(/fbar\.style\.top = top \+ 'px'/.test(body), '筛选条也要写 top（接在同一条吸附带）');
  assert.ok(/hd\.style\.top = top \+ 'px'/.test(body), '最后必须把 top 写回 .sticky-head');
  assert.ok(/getComputedStyle\(bb\)\.marginBottom/.test(body),
    '必须计入操作栏下 margin（sticky top 是 margin box 顶）');
});

test('D4 契约：syncBottomScrollbar 用页面底部那一条统一驱动所有溢出表体', function () {
  const body = fnBody(APP, 'function syncBottomScrollbar(');
  assert.ok(body.indexOf("getElementById('bottomScrollbar')") >= 0, '必须取 #bottomScrollbar 容器');
  assert.ok(body.indexOf("getElementById('bottomScrollbarInner')") >= 0, '必须取 #bottomScrollbarInner 撑宽层');
  assert.ok(body.indexOf("querySelectorAll('#content .table-wrap')") >= 0,
    '横向溢出检测必须遍历 #content .table-wrap');
  assert.ok(/scrollWidth > w\.clientWidth \+ 2/.test(body),
    '溢出判定必须留 2px 容差（否则亚像素误差会让底部条时隐时现）');
  assert.ok(/inner\.style\.width = \(sb\.clientWidth \+ range\) \+ 'px'/.test(body),
    'inner 宽度必须 = 视口宽 + 最大可滚距（否则拖动比例与表格不一一对应）');
  assert.ok(body.indexOf('w.offsetParent === null') >= 0, '隐藏区块必须跳过（折叠表格不得参与）');
  /* 只绑一次：重复渲染不得重复绑定滚动事件 */
  assert.ok(body.indexOf('sb._barBound') >= 0, '底部条拖动事件必须只绑定一次（_barBound 守卫）');
});

test('D5 契约：restoreTableScroll 用双 rAF + 150ms 兜底恢复滚动位置', function () {
  const body = fnBody(APP, 'function restoreTableScroll(');
  assert.strictEqual(countOcc(body, 'requestAnimationFrame('), 2,
    '必须双层 requestAnimationFrame（等布局完全稳定后再设回滚动位置）');
  assert.ok(/setTimeout\(apply, 150\)/.test(body),
    '必须有 150ms 兜底（字体/图片延迟 reflow 后再校正一次）');
  assert.ok(/rec\.el\.scrollLeft = rec\.left/.test(body) && /rec\.el\.scrollTop = rec\.top/.test(body),
    '必须同时恢复横向与纵向滚动位置');
  assert.ok(/if \(!records \|\| !records\.length\) return;/.test(body), '空入参必须直接返回（幂等）');
  assert.ok(body.indexOf('syncBottomScrollbar()') >= 0,
    '恢复滚动后必须重算底部条（否则底部条位置与表体不一致）');
});

/* ================================================================
   §E 滚动跟随：capture 委托 + resize，只注册一次
================================================================ */

test('E1 契约：表体横滚 → 表头跟随 + 底部条回写，用 capture 委托且只注册一次', function () {
  const body = fnBody(APP, 'function bindTableScrollFollow(');
  assert.ok(/classList\.contains\('table-wrap'\)/.test(body),
    '委托必须只认 .table-wrap 的滚动（元素的 scroll 不冒泡，只能 capture 截获）');
  assert.ok(body.indexOf("querySelector('.head-scroll')") >= 0,
    '表体横滚后表头容器（.head-scroll）必须跟随（双表结构列对齐的唯一保证）');
  assert.ok(/hs\.scrollLeft !== t\.scrollLeft/.test(body), '跟随前必须比对，避免无意义写入引发回环');
  assert.ok(body.indexOf('bottomScrollbar') >= 0, '必须回写底部滚动条位置');
  /* capture 必须是 true（第三参）：冒泡阶段收不到元素自身的 scroll */
  assert.ok(/\}, true\);/.test(body), 'scroll 监听必须在**捕获阶段**（第三参 true）');
  /* resize 联动 */
  assert.ok(body.indexOf("addEventListener('resize'") >= 0, '窗口尺寸变化必须重算（吸附位置/列宽/底部条）');
  /* 只注册一次：注册点在 init() 内，renderMain 不得调用它（否则每次重渲染都多绑一套） */
  const initBody = fnBody(APP, 'function init(');
  assert.ok(initBody.indexOf('bindTableScrollFollow()') >= 0, 'bindTableScrollFollow 必须在 init() 内注册');
  assert.strictEqual(countOcc(APP, 'bindTableScrollFollow()'), 2,
    'bindTableScrollFollow() 只允许"定义 1 处 + init 调用 1 处"（实际 ' + countOcc(APP, 'bindTableScrollFollow()') + ' 处）');
  assert.strictEqual(fnBody(APP, 'function renderMain(').indexOf('bindTableScrollFollow'), -1,
    'renderMain 不得注册滚动监听（每次重渲染都绑一套 ⇒ 监听器泄漏、follow 抖动）');
});

/* ================================================================
   §F CSS / DOM
================================================================ */

test('F1 契约：表体自身横条必须隐藏（否则"表体一条 + 底部一条"双横条）', function () {
  const css = cssBlock();
  assert.ok(/\.table-wrap\{[^}]*scrollbar-width:none/.test(css),
    '.table-wrap 必须 scrollbar-width:none（Firefox 口径）');
  assert.ok(/\.table-wrap::-webkit-scrollbar\{display:none/.test(css),
    '.table-wrap::-webkit-scrollbar 必须 display:none（Chrome/Safari 口径）—— 缺这条会出现双横条');
});

test('F2 契约：双表结构样式齐全（sticky / head-scroll / fixed 布局 / 圆角拼接 / 移动端基准）', function () {
  const css = cssBlock();
  assert.ok(/\.sticky-head\{position:sticky;top:58px/.test(css), '.sticky-head 必须 sticky 且 top:58px');
  assert.ok(/\.head-scroll\{overflow-x:auto;scrollbar-width:none\}/.test(css),
    '.head-scroll 必须 overflow-x:auto 且隐藏自身横条');
  assert.ok(/\.head-scroll::-webkit-scrollbar\{display:none/.test(css),
    '.head-scroll::-webkit-scrollbar 必须隐藏（否则表头多出一条细横条）');
  assert.ok(/\.head-tbl,\.body-tbl\{table-layout:fixed\}/.test(css),
    '两张表都必须 table-layout:fixed（否则 colgroup 宽度不生效，列宽对齐失效）');
  assert.ok(/\.sticky-head\+\.table-wrap\{border-radius:0 0 8px 8px;border-top:none\}/.test(css),
    '吸附表头与表体必须拼成一个圆角块（否则顶部多一道边框 + 圆角断裂）');
  assert.ok(/@media\(max-width:768px\)\{\.sticky-head\{top:48px\}\}/.test(css),
    '移动端吸附基准必须 48px（与 fixStickyHeadTop 的 768 分支同口径）');
});

test('F3 契约：卡片内操作栏去阴影/圆角/下 margin（否则操作栏与吸附表头间露缝）', function () {
  const css = cssBlock();
  assert.ok(/\.card \.bulk-bar\{box-shadow:none;border-radius:0;margin-bottom:0\}/.test(css),
    '必须覆盖 .card .bulk-bar（生产 .14 踩过：不去下 margin，操作栏与表头之间露 6px 缝）');
});

test('F4 契约：底部固定滚动条节点与样式齐全', function () {
  const css = cssBlock();
  [
    '.bottom-scrollbar{position:fixed',
    '.bottom-scrollbar::-webkit-scrollbar{height:10px}',
    '.bottom-scrollbar::-webkit-scrollbar-thumb{',
    '.bottom-scrollbar::-webkit-scrollbar-track{'
  ].forEach(function (needle) {
    assert.ok(css.indexOf(needle) >= 0, 'CSS 必须含 ' + needle + '（照抄生产全套）');
  });
  /* DOM 节点（qa-app.js 靠这两个 id 工作） */
  assert.ok(HTML.indexOf('<div class="bottom-scrollbar" id="bottomScrollbar">') >= 0,
    'quality/index.html 必须有 #bottomScrollbar 节点');
  assert.ok(HTML.indexOf('id="bottomScrollbarInner"') >= 0,
    'quality/index.html 必须有 #bottomScrollbarInner 撑宽层');
  /* 节点必须在主内容容器**之外**（放进去会被内容区滚动容器裁掉/随内容滚走） */
  const sbIdx = HTML.indexOf('id="bottomScrollbar"');
  const contentIdx = HTML.indexOf('<div class="content" id="content"></div>');
  assert.ok(contentIdx > 0, 'quality/index.html 必须仍有主内容容器 #content');
  const mainClose = HTML.indexOf('</div>', contentIdx + 1);   /* 紧接着的这一层 = .main 的收尾 */
  assert.ok(mainClose > contentIdx, '必须能定位 .main 容器的收尾标签');
  assert.ok(sbIdx > mainClose, '#bottomScrollbar 必须在 .main 容器**之外**（放进去会被内容区滚动容器裁掉）');
});

/* ================================================================
   §G 判别力：把源码变异成回潮形态，判据必须变红
================================================================ */

test('G1 判别力：回退成单表 / 丢表体 colgroup / 丢 data-col ⇒ 本文件判据必须变红', function () {
  /* ① 回退成单表：把表头表与表体表合回一张 */
  const singleMut = APP
    .replace('<div class="sticky-head"><div class="head-scroll"><table class="head-tbl">', '<table>')
    .replace("'</tr></thead></table></div></div>'", "'</tr></thead>'");
  assert.notStrictEqual(singleMut, APP, '单表回潮变异必须注入生效');
  assert.strictEqual(badSingleTable(singleMut), true, '回退成单表后，结构判据必须变红');

  /* ② 丢表体 colgroup：表体表只拼 tbody */
  const cgMut = APP.replace("' + colg + '<tbody>'", "' + '<tbody>'");
  assert.notStrictEqual(cgMut, APP, '丢 colgroup 变异必须注入生效');
  assert.strictEqual(badBodyColgroup(cgMut), true, '表体丢 colgroup 后，判据必须变红');

  /* ③ 丢表头列身份：sortTh 不再打 data-col */
  const idNeedle = "+ ' data-col=\"' + esc(key) + '\"'";
  assert.strictEqual(countOcc(APP, idNeedle), 1, 'data-col 变异锚点必须命中恰 1 处');
  const idMut = APP.replace(idNeedle, '');
  assert.notStrictEqual(idMut, APP, '丢 data-col 变异必须注入生效');
  assert.strictEqual(badThIdentity(idMut), true, '丢掉 data-col 后，判据必须变红');

  /* 反假绿：未变异源码必须全部通过（否则上面三条"变红"毫无意义） */
  assert.strictEqual(badSingleTable(APP), false, '未变异源码不得被判为单表');
  assert.strictEqual(badBodyColgroup(APP), false, '未变异源码不得被判为丢 colgroup');
  assert.strictEqual(badThIdentity(APP), false, '未变异源码不得被判为丢 data-col');
});

test('G2 判别力：renderMain 少调任一同步函数 ⇒ 调用链判据必须变红', function () {
  const body = fnBody(APP, 'function renderMain(');
  ['syncHeadBody()', 'fixStickyHeadTop()', 'syncBottomScrollbar()'].forEach(function (call) {
    const mutated = APP.replace(body, body.replace(call, 'void 0'));
    assert.notStrictEqual(mutated, APP, '删除 ' + call + ' 的变异必须注入生效');
    const mutBody = fnBody(mutated, 'function renderMain(');
    assert.strictEqual(mutBody.indexOf(call), -1, '变异后 ' + call + ' 必须消失（注入自证）');
    assert.ok(mutBody.indexOf(call) < 0, '删除 ' + call + ' 后，D1 的调用链判据必然变红');
  });
});
