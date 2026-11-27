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

/** 合计行口径是否回潮成"当前页"（而非筛选+排序后的全量） */
function badSumInput(src) {
  const body = fnBody(src, 'function tableHtml(');
  if (body.indexOf('sumRowHtml(orderedRecords())') < 0) return true;
  return body.indexOf('sumRowHtml(pg.rows)') >= 0;
}

/** 单元格是否又用回了原生 title（会与 .cell-tip 双弹） */
function badCellTitle(src) {
  const body = fnBody(src, 'function cellHtml(');
  return body.indexOf('title="') >= 0;
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

/* ================================================================
   §B 【build .167 · T03】列布局引擎：拖宽 + 拖序 + 本地持久化
   ----------------------------------------------------------------
   本节尽量**真执行**被测函数，而不是只对源码做正则 —— 「只读代码的断言」极易变成
   "看着像测了、其实什么都没验证"。做法：用 §A 的 fnBody 取出函数源码，
   再把它的自由变量（colOf / localStorage / LAYOUT_KEY / tblLayout / normalizeLayout）
   作为参数注入，用 `new Function` 造一个最小沙箱执行。只有依赖真实 DOM/Canvas 的
   部分（拖拽、量宽）才退回静态断言，并在消息里写明为什么。
   ================================================================ */

/** 取出函数并包成可调用值（自由变量由调用方作为形参注入）
    用法：fnValue(src, 'function x(')            → 返回「无自由变量的工厂」，调用即得 x
          fnValue(src, 'function y(', ['a','b']) → 返回工厂，调用 f(a,b) 即得 y */
function fnValue(src, decl, params) {
  const body = 'return (' + fnBody(src, decl) + ');';
  return new Function((params || []).join(','), body);
}

/** 本系统的列 key 清单（从 QA_COLUMNS 源码里取，避免测试里抄一份列名） */
function columnKeys() {
  const block = APP.slice(APP.indexOf('var QA_COLUMNS = ['), APP.indexOf('\n  ];', APP.indexOf('var QA_COLUMNS = [')));
  const keys = [];
  const re = /\{\s*key:\s*'([A-Za-z][A-Za-z0-9]*)'/g;
  let m;
  while ((m = re.exec(block)) !== null) keys.push(m[1]);
  return keys;
}

/** 假的 colOf：只认 QA_COLUMNS 里的 key（与真实现同语义） */
function makeColOf(keys) {
  return function (k) { return keys.indexOf(k) >= 0 ? { key: k } : null; };
}

test('B1 契约（①拖序落库）：reorderKeys 真执行后长度恒等于列数；startColDrag 把结果写进 layoutOf(TBL_M).order', function () {
  /* ---- 行为侧：提取 reorderKeys 并真跑（纯函数，无 DOM 依赖） ---- */
  const reorderKeys = fnValue(APP, 'function reorderKeys(')();
  const cur = columnKeys();
  assert.ok(cur.length >= 9, '列清单异常（仅 ' + cur.length + ' 列）—— 扫描逻辑可能失效');

  /* 拖第 1 列到末列之后 */
  const toEnd = reorderKeys(cur, cur[0], { key: cur[cur.length - 1], before: false });
  assert.strictEqual(toEnd.length, cur.length, '拖序后长度必须仍等于列数（不得丢列/重复）');
  assert.deepStrictEqual(toEnd.slice().sort(), cur.slice().sort(), '拖序只能换位，不得增删列');
  assert.strictEqual(toEnd[toEnd.length - 1], cur[0], '「拖到末列之后」⇒ 被拖列必须落位到末尾');

  /* 拖末列到首列之前 */
  const toHead = reorderKeys(cur, cur[cur.length - 1], { key: cur[0], before: true });
  assert.strictEqual(toHead.length, cur.length, '拖到首位后长度不变');
  assert.strictEqual(toHead[0], cur[cur.length - 1], '「拖到首列之前」⇒ 被拖列必须落位到首位');
  assert.deepStrictEqual(toHead.slice(1), cur.slice(0, cur.length - 1), '其余列相对顺序必须保持不变');

  /* 拖到自身位置（同一列 before/after 自己）不得丢列 */
  const selfDrag = reorderKeys(cur, cur[2], { key: cur[2], before: true });
  assert.strictEqual(selfDrag.length, cur.length, '拖到自己身上也不得丢列');

  /* ---- 静态侧：拖拽收尾必须真把顺序写进 layout，并落盘 + 重排 + 同步列宽 ---- */
  const drag = fnBody(APP, 'function startColDrag(');
  assert.ok(drag.indexOf('layoutOf(TBL_M).order = reorderKeys(') >= 0,
    'startColDrag 收尾必须 `layoutOf(TBL_M).order = reorderKeys(...)`（拖序的唯一落库点）');
  ['saveLayoutLocal()', 'applyTableLayout()', 'syncHeadBody()', 'restoreTableScroll('].forEach(function (call) {
    assert.ok(drag.indexOf(call) >= 0, '拖序收尾必须调用 ' + call + '（否则拖完不持久化/不重排/不对齐）');
  });
  assert.ok(drag.indexOf('th.th-sort[data-col]') >= 0,
    '拖拽的候选列必须按 `th.th-sort[data-col]` 取（列身份契约）');
});

test('B2 契约（②归一化宽进严出）：字符串/数组/未知列 key/非数字 width 四类畸形各自回落 {} —— 真执行', function () {
  const keys = columnKeys();
  const isLayoutMap = fnValue(APP, 'function isLayoutMap(')();
  const normalizeLayout = fnValue(APP, 'function normalizeLayout(', ['colOf', 'isLayoutMap']);
  const norm = function (v) { return normalizeLayout(makeColOf(keys), isLayoutMap)(v); };
  const [A, B] = [keys[0], keys[1]];

  /* ① 字符串 */
  assert.deepStrictEqual(norm('abc'), {}, '字符串输入必须回落 {}');
  /* ② 数组（合法对象判定必须排除数组） */
  assert.deepStrictEqual(norm([]), {}, '数组输入必须回落 {}');
  assert.deepStrictEqual(norm([{ qaLog: {} }]), {}, '数组元素即使是对象也不得被当成布局');
  /* ③ 未知列 key（列被删 / 存储被手改） */
  assert.deepStrictEqual(norm({ qaLog: { order: ['__no_such_col__'], widths: {} } }), {},
    '未知列 key ⇒ 剔除后为空壳模块 ⇒ 整体回落 {}');
  /* ④ 非数字 width */
  assert.deepStrictEqual(norm({ qaLog: { order: [], widths: { [A]: '120px' } } }), {},
    '字符串宽度必须剔除；只剩空壳 ⇒ 回落 {}');
  assert.deepStrictEqual(norm({ qaLog: { order: [], widths: { [A]: NaN } } }), {}, 'NaN 宽度必须剔除');
  assert.deepStrictEqual(norm({ qaLog: { order: [], widths: { [A]: -5 } } }), {}, '负数宽度必须剔除');
  assert.deepStrictEqual(norm({ qaLog: { order: [], widths: { [A]: 0 } } }), {}, '0 宽度必须剔除');
  /* 其它标量/null 也不得抛错 */
  [null, undefined, 42, true].forEach(function (v) {
    assert.deepStrictEqual(norm(v), {}, JSON.stringify(v) + ' 必须回落 {}（不得抛错）');
  });

  /* 混合输入：坏项逐个剔除、好项保留（**不是**整份丢弃），并去重 */
  const mixed = norm({ v: 1, def: { qaLog: { order: [A, '__no_such_col__', B, A], widths: { [A]: 120, [B]: '90px', __no_such_col__: 50 } } } });
  assert.deepStrictEqual(mixed, { qaLog: { order: [A, B], widths: { [A]: 120 } } },
    '混合输入必须"逐项剔除 + 去重 + 保留好项"（整份丢弃会让用户一次手抖就丢光布局）');
  /* 兼容无 def 层的扁平形状（老数据/手工塞入） */
  assert.deepStrictEqual(norm({ qaLog: { order: [B], widths: {} } }), { qaLog: { order: [B], widths: {} } },
    '无 def 层的扁平形状也必须能读（宽进）');
  /* 深拷贝语义：归一结果与入参不得共享引用 */
  const input = { def: { qaLog: { order: [A], widths: { [A]: 100 } } } };
  const out1 = norm(input);
  out1.qaLog.order.push(B);
  out1.qaLog.widths[A] = 999;
  assert.deepStrictEqual(input.def.qaLog.order, [A], '归一结果必须与入参不共享引用（防污染基准）');
  assert.strictEqual(input.def.qaLog.widths[A], 100, '归一结果改宽度不得回写原对象');
});

test('B3 契约（③存储键名与形状）：恰写 wb_cb_qa_tblLayout_v1，形状 {v:1,def:{…}}，且能被 loadLayout 原样读回 —— 真执行', function () {
  /* 键名断言：源码常量必须是这个字面量（本地键统一 wb_cb_qa_ 前缀的硬约束） */
  assert.ok(APP.indexOf("var LAYOUT_KEY = 'wb_cb_qa_tblLayout_v1';") >= 0,
    '存储键必须恰为 wb_cb_qa_tblLayout_v1（常量 LAYOUT_KEY）');
  const LAYOUT_KEY = 'wb_cb_qa_tblLayout_v1';

  /* 造一个最小 localStorage */
  const store = {};
  const fakeLS = {
    setItem: function (k, v) { store[k] = String(v); },
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; }
  };
  const isLayoutMap = fnValue(APP, 'function isLayoutMap(')();
  const normalizeLayout = fnValue(APP, 'function normalizeLayout(', ['colOf', 'isLayoutMap']);
  const colOf = makeColOf(columnKeys());
  const saveLayoutLocal = fnValue(APP, 'function saveLayoutLocal(', ['localStorage', 'LAYOUT_KEY', 'tblLayout']);
  const loadLayout = fnValue(APP, 'function loadLayout(', ['localStorage', 'LAYOUT_KEY', 'normalizeLayout', 'tblLayout']);

  const mem = { qaLog: { order: [columnKeys()[0]], widths: { [columnKeys()[0]]: 120 } } };
  saveLayoutLocal(fakeLS, LAYOUT_KEY, mem)();

  assert.deepStrictEqual(Object.keys(store), [LAYOUT_KEY], '必须只写这一个键（不得顺手写别的键）');
  const parsed = JSON.parse(store[LAYOUT_KEY]);
  assert.deepStrictEqual(Object.keys(parsed).sort(), ['def', 'v'], '存储形状必须是 {v,def} 两键');
  assert.strictEqual(parsed.v, 1, '形状版本必须是 v:1');
  assert.deepStrictEqual(parsed.def, mem, '布局内容必须原样落在 def 层（与生产 v2 的 def 层同构）');

  /* 读回：loadLayout 必须归一后返回同一份布局 */
  const readBack = loadLayout(fakeLS, LAYOUT_KEY, normalizeLayout(colOf, isLayoutMap), {})();
  assert.deepStrictEqual(readBack, mem, 'loadLayout 必须能把刚写的布局原样读回');

  /* 读坏数据：解析失败 / 空 / 畸形都不得抛错，必须回落 {} */
  const badLS = { getItem: function () { return '{不是 JSON'; }, setItem: function () {} };
  assert.deepStrictEqual(loadLayout(badLS, LAYOUT_KEY, normalizeLayout(colOf, isLayoutMap), {})(), {},
    '损坏的存储必须回落 {}（绝不白屏）');
  const emptyLS = { getItem: function () { return null; }, setItem: function () {} };
  assert.deepStrictEqual(loadLayout(emptyLS, LAYOUT_KEY, normalizeLayout(colOf, isLayoutMap), {})(), {},
    '无存储时必须回落 {}');
});

test('B4 契约（④拖完不改排序）：sortBy 首句必须是 350ms 抑制，且早于任何排序逻辑', function () {
  const body = fnBody(APP, 'function sortBy(');
  const guard = 'if (Date.now() - (window.__colDragTS || 0) < 350) return;';
  assert.ok(body.indexOf(guard) >= 0, 'sortBy 必须含 350ms 拖拽抑制子句（照抄生产 toggleSort）');
  assert.ok(body.indexOf(guard) < body.indexOf('var col = colOf(key);'),
    '抑制必须在**任何**排序逻辑之前（否则先改了 sortKey 再 return，等于没抑制）');
  assert.ok(body.indexOf('__colDragTS') >= 0, '抑制必须读 window.__colDragTS（拖拽收尾写入的时间戳）');
  /* 写侧自证：拖序与调宽的收尾都必须写这个时间戳 */
  assert.ok(fnBody(APP, 'function startColDrag(').indexOf('window.__colDragTS = Date.now()') >= 0,
    '拖序收尾必须写 __colDragTS');
  assert.ok(fnBody(APP, 'function startColResize(').indexOf('window.__colDragTS = Date.now()') >= 0,
    '调宽收尾必须写 __colDragTS（调宽后紧跟的 click 同样会误触发排序）');
});

test('B5 契约（⑤漏斗不启动拖拽）：startColDrag 体内排除 .filt-ico（且调宽分支不受影响）', function () {
  const drag = fnBody(APP, 'function startColDrag(');
  assert.ok(drag.indexOf("closest('.filt-ico')") >= 0,
    'startColDrag 必须排除 .filt-ico（否则点漏斗图标会开始拖列，筛选面板根本打不开）');
  assert.ok(drag.indexOf("closest('.filt-ico')") < drag.indexOf('colDrag = {'),
    '排除必须在建立 colDrag 状态**之前**（否则已经污染了 colDrag）');
  /* 调宽分支必须先于拖拽分支被识别（.th-rs 手柄 → resize） */
  const bind = fnBody(APP, 'function bindColInteractions(');
  assert.ok(bind.indexOf("classList.contains('th-rs')") >= 0, '委托必须先识别 .th-rs 手柄 → startColResize');
  assert.ok(bind.indexOf("classList.contains('th-rs')") < bind.indexOf('startColDrag(e, th)'),
    '.th-rs 分支必须早于 startColDrag 分支（顺序颠倒 ⇒ 调宽手柄变成拖序）');
});

test('B6 契约（⑥重排按 data-col）：applyTableLayout 按 data-col 匹配整行重排、跳过 colspan 行、写列宽', function () {
  const body = fnBody(APP, 'function applyTableLayout(');
  assert.ok(body.indexOf("getAttribute('data-col')") >= 0,
    'applyTableLayout 必须按 data-col 匹配列（列身份契约）');
  assert.strictEqual(body.indexOf('data-key'), -1, 'applyTableLayout 内不得出现 data-key');
  assert.strictEqual(/row\.cells\[\s*\w+\s*\]/.test(body), false,
    '不得按下标移动单元格（扩列/拖序后会串列）');
  assert.ok(body.indexOf('row.appendChild(') >= 0, '必须按目标顺序 appendChild 重排（生产同款）');
  /* colspan 守卫（为将来小计行留路） */
  assert.ok(/getAttribute\('colspan'\)/.test(body), '必须保留「跳过含 colspan 的行」守卫');
  /* 列宽：saved 优先、下限 minThWidth、无 data-col 的勾选列保底 36 */
  assert.ok(body.indexOf('minThWidth(th)') >= 0, '列宽必须受 minThWidth 下限约束');
  assert.ok(body.indexOf("th.style.width = Math.max(36, cur) + 'px'") >= 0,
    '勾选列（无 data-col）必须按内容宽、保底 36px（生产同款）');
  assert.ok(body.indexOf('tableLayout = \'fixed\'') >= 0, '必须切 fixed 布局（否则 colgroup 宽度不生效）');
  /* 表体表也要重排：两张表都在 tables 里 */
  assert.ok(body.indexOf('var tables = bt ? [ht, bt] : [ht];') >= 0,
    '表头表与表体表都必须重排（只排表头 ⇒ 表体列序与表头错位）');
});

test('B7 契约（⑦最小宽度不含 locked）：minThWidth 无锁图标分支，常量来源可对账', function () {
  const body = fnBody(APP, 'function minThWidth(');
  assert.strictEqual(body.indexOf('locked'), -1, 'minThWidth 不得含 locked 分支（质量系统无锁定字段）');
  assert.strictEqual(body.indexOf("'.lock'"), -1, "minThWidth 不得查 .lock 元素（同上）");
  /* 常量逐项来源：19 = 筛选图标 12 + 左距 5 + padding 2；20 = th 左右 padding；4 = 余量 */
  assert.ok(/firstW \+ dotsW \+ sortW \+ 19 \+ 20 \+ 4/.test(body),
    '最小宽度公式必须是 firstW+dotsW+sortW+19+20+4（逐项来源见函数注释）');
  assert.ok(/if \(sortW < 6\) sortW = 9;/.test(body), '量不出 ⇅ 时必须有 9px 兜底');
  assert.ok(body.indexOf('return 60;') >= 0, '量宽异常必须兜底 60px（不得抛错中断渲染）');
});

test('B8 契约：重置列布局（按钮 + 导出 + 清空落盘重渲染）', function () {
  const reset = fnBody(APP, 'function resetLayout(');
  assert.ok(reset.indexOf('tblLayout = {};') >= 0, 'resetLayout 必须清空内存布局');
  assert.ok(reset.indexOf('saveLayoutLocal()') >= 0, 'resetLayout 必须落盘（否则刷新又回来）');
  assert.ok(reset.indexOf('renderMain()') >= 0, 'resetLayout 必须重渲染（否则界面不动）');
  assert.ok(fnBody(APP, 'function toolbarHtml(').indexOf('QA_APP.resetLayout()') >= 0,
    '工具栏必须有重置入口（否则用户找不到）');
  assert.ok(/resetLayout: resetLayout,/.test(APP), 'resetLayout 必须从 QA_APP 导出（内联 onclick 依赖它）');
});

test('B9 契约：表头 mousedown 委托只注册一次，选择器收敛在 #content 且要求 data-col', function () {
  const bind = fnBody(APP, 'function bindColInteractions(');
  assert.ok(bind.indexOf("'#content th.th-sort[data-col]'") >= 0,
    '委托选择器必须是 #content th.th-sort[data-col]（勾选列无 data-col ⇒ 天然不参与）');
  assert.ok(bind.indexOf('e.button !== 0') >= 0, '必须只响应左键');
  const initBody = fnBody(APP, 'function init(');
  assert.ok(initBody.indexOf('bindColInteractions()') >= 0, 'bindColInteractions 必须在 init() 内注册一次');
  assert.strictEqual(countOcc(APP, 'bindColInteractions()'), 2,
    'bindColInteractions 只允许「定义 1 处 + init 调用 1 处」（实际 ' + countOcc(APP, 'bindColInteractions()') + ' 处）');
  assert.strictEqual(fnBody(APP, 'function renderMain(').indexOf('bindColInteractions'), -1,
    'renderMain 不得注册表头委托（每次重渲染绑一套 ⇒ 拖一次跑 N 次）');
  /* 初始化顺序：先读布局再渲染（否则首屏按默认顺序画完才应用布局，会闪一下） */
  assert.ok(initBody.indexOf('loadLayout()') >= 0, 'init 必须调用 loadLayout()');
  assert.ok(initBody.indexOf('loadLayout()') < initBody.indexOf('boot()'), 'loadLayout 必须早于 boot()（首屏即应用布局）');
});

/* ================================================================
   §H 【build .167 · T04】合计行
   ----------------------------------------------------------------
   口径（红线）：筛选+排序后的**全量、分页前**；只合计 num 列；文本/日期列留空但必须输出 td；
   每个 td 带 data-col（`.112` 事故 = 合计行 td 无列身份 → 拖列后数字错位）；
   空表不渲染；不参与勾选。
   本节尽量**真执行** sumColKeys / sumRowHtml（注入 colOf / tableCols / sumLabelKey / esc）。
   ================================================================ */

/** 读某列的 type（直接扫 QA_COLUMNS 源码，避免测试里再抄一份类型表；
    刻意不用正则 —— 本文件的 heredoc/转义历史上被吞过反斜杠，纯字符串查找最稳） */
function columnTypeOf(k) {
  const at = APP.indexOf("key: '" + k + "'");
  assert.ok(at >= 0, 'QA_COLUMNS 里必须存在列 ' + k);
  const t = APP.indexOf("type: '", at);
  assert.ok(t > at, '列 ' + k + ' 必须声明 type');
  const start = t + "type: '".length;
  return APP.slice(start, APP.indexOf("'", start));
}

/** 造一个可控的 sumRowHtml 调用器（自由变量逐个注入，便于构造 order/列集） */
function makeSumRow(overrides) {
  const o = overrides || {};
  const keys = o.keys || columnKeys();
  const cols = keys.map(function (k, i) {
    /* 从源码里读每列的 type，别在测试里抄一份类型表 */
    const type = columnTypeOf(k);
    return { key: k, label: k, type: type, inTable: true };
  });
  const tableCols = function () { return cols; };
  const colOf = function (k) {
    for (let i = 0; i < cols.length; i++) if (cols[i].key === k) return cols[i];
    return null;
  };
  const esc = fnValue(APP, 'function esc(')();
  const SUM_SKIP_KEYS = {};
  const tableCols2 = tableCols;
  const sumColKeys = fnValue(APP, 'function sumColKeys(', ['tableCols', 'SUM_SKIP_KEYS'])(
    tableCols2, SUM_SKIP_KEYS);
  const order = o.order || [];
  const layoutOf = function () { return { order: order, widths: {} }; };
  const sumLabelKey = fnValue(APP, 'function sumLabelKey(', ['tableCols', 'colOf', 'layoutOf', 'TBL_M'])(
    tableCols2, colOf, layoutOf, 'qaLog');
  const sumNumOf = fnValue(APP, 'function sumNumOf(')();
  const sumFmt = fnValue(APP, 'function sumFmt(')();
  const sumRowHtml = fnValue(APP, 'function sumRowHtml(',
    ['tableCols', 'sumColKeys', 'sumLabelKey', 'esc', 'sumNumOf', 'sumFmt'])(
    tableCols2, sumColKeys, sumLabelKey, esc, sumNumOf, sumFmt);
  return { cols: cols, keys: keys, sumColKeys: sumColKeys, sumLabelKey: sumLabelKey, sumRowHtml: sumRowHtml, colOf: colOf };
}

test('H1 契约：sumColKeys() 由 QA_COLUMNS 派生，只含 num 列，且源码里没有写死列名', function () {
  const keys = columnKeys();
  const ctx = makeSumRow({ keys: keys });
  const numKeys = keys.filter(function (k) {
    return columnTypeOf(k) === 'num';
  });
  assert.ok(numKeys.length >= 3, '质量系统至少应有 3 个 num 列（实际 ' + numKeys.length + '）');
  assert.deepStrictEqual(ctx.sumColKeys(), numKeys,
    'sumColKeys() 必须恰为「type===num 且不在 SUM_SKIP_KEYS」的列（派生，非手写）');
  /* 静态：函数体必须走 tableCols() 派生，不得出现列名字面量 */
  const body = fnBody(APP, 'function sumColKeys(');
  assert.ok(body.indexOf('tableCols()') >= 0, 'sumColKeys 必须从 tableCols() 派生');
  assert.strictEqual(/'(totalQty|inspectedQty|defectQty)'/.test(body), false,
    'sumColKeys 内不得出现列名字面量（加字段即自动纳入）');
  /* 比率列登记机制保留（当前为空对象） */
  assert.ok(/var SUM_SKIP_KEYS = \{\};/.test(APP),
    'SUM_SKIP_KEYS 必须是空对象但保留机制（加比率列时在此登记）');
});

test('H2 契约：sumRowHtml 与数据行逐列同构 —— td 数 = 列数 + 勾选列，且每个 td 都带 data-col', function () {
  const ctx = makeSumRow();
  const rows = [{ totalQty: 10, inspectedQty: 8, defectQty: 2 }, { totalQty: 5, inspectedQty: 5, defectQty: 0 }];
  const html = ctx.sumRowHtml(rows);
  assert.ok(html.indexOf('<tr class="sum-row"') >= 0, '合计行必须带 .sum-row 类（样式与选择器都依赖它）');
  assert.strictEqual(countOcc(html, '<td'), ctx.cols.length + 1,
    'td 数必须 = 数据列数 + 1（首列勾选列）—— 少一个就整行错列');
  assert.strictEqual(countOcc(html, 'data-col="'), ctx.cols.length,
    '每个业务列 td 都必须带 data-col（`.112` 事故：合计行 td 无列身份 ⇒ 拖列后数字错位）');
  /* 数值：三列各自求和 */
  assert.ok(html.indexOf('>15<') >= 0, 'totalQty 合计应为 15（10+5）');
  assert.ok(html.indexOf('>13<') >= 0, 'inspectedQty 合计应为 13（8+5）');
  assert.ok(html.indexOf('>2<') >= 0, 'defectQty 合计应为 2（2+0）');
  /* 文本列留空但必须有 td */
  assert.ok(html.indexOf('data-col="date"></td>') >= 0 || html.indexOf('data-col="date"') >= 0,
    '文本/日期列必须输出（空）td');
  /* 数字 td 的排版：右对齐 + 等宽数字 */
  assert.ok(/data-col="totalQty" style="[^"]*text-align:right/.test(html),
    '数字列必须 text-align:right');
  assert.ok(/font-variant-numeric:tabular-nums/.test(html),
    '数字列必须 tabular-nums（等宽数字，否则合计与列内数字右对齐视觉不齐）');
  assert.ok(/font-weight:600/.test(html), '合计行必须加粗');
  assert.ok(/background:var\(--primary-light\)/.test(html), '合计行背景必须是 var(--primary-light)');
});

test('H3 契约：标签列 = 当前布局 order 里第一个非 num 列，且随 order 变化（拖列后标签跟着走）', function () {
  const keys = columnKeys();
  const textKeys = keys.filter(function (k) {
    return columnTypeOf(k) !== 'num';
  });
  assert.ok(textKeys.length >= 2, '至少要有 2 个非 num 列才能验证"跟着走"');

  /* 布局 A：默认（order 与 schema 一致） */
  const ctxA = makeSumRow({ keys: keys, order: keys.slice() });
  assert.strictEqual(ctxA.sumLabelKey(), textKeys[0],
    'order 与 schema 一致时，标签列 = 首个非 num 列');

  /* 布局 B：把第 2 个文本列拖到首位 ⇒ 标签必须跟着换 */
  const reordered = [textKeys[1]].concat(keys.filter(function (k) { return k !== textKeys[1]; }));
  const ctxB = makeSumRow({ keys: keys, order: reordered });
  assert.strictEqual(ctxB.sumLabelKey(), textKeys[1],
    '拖列后标签列必须跟着布局走（回落到 schema 首列就是 bug）');
  assert.notStrictEqual(ctxA.sumLabelKey(), ctxB.sumLabelKey(), '两种布局下的标签列必须不同（判别力自证）');

  /* 标签绝不能落在 num 列上 */
  assert.strictEqual(textKeys.indexOf(ctxB.sumLabelKey()) >= 0, true,
    '标签列必须是非 num 列（否则数字列被写死「合计」、该列合计值消失）');
  /* 行为侧：标签文字确实出现在该列的 td 上 */
  const html = ctxB.sumRowHtml([{ totalQty: 1 }]);
  assert.ok(new RegExp('data-col="' + ctxB.sumLabelKey() + '"[^>]*>合计<').test(html),
    '「合计」二字必须落在 sumLabelKey() 指定的那一列');
});

test('H4 契约：空数据不渲染合计行（返回空串）', function () {
  const ctx = makeSumRow();
  assert.strictEqual(ctx.sumRowHtml([]), '', '空数组必须返回空串（不得输出只有勾选列的空行）');
  assert.strictEqual(ctx.sumRowHtml(null), '', 'null 必须返回空串');
  assert.strictEqual(ctx.sumRowHtml(undefined), '', 'undefined 必须返回空串');
});

test('H5 契约：合计行入参是 orderedRecords()（筛选+排序后全量、分页前），绝不是当前页 pg.rows', function () {
  assert.strictEqual(badSumInput(APP), false,
    'tableHtml 必须用 sumRowHtml(orderedRecords()) —— 传 pg.rows 会让合计值随翻页跳变');
  const body = fnBody(APP, 'function tableHtml(');
  assert.ok(body.indexOf('sumRowHtml(orderedRecords())') >= 0, '入参必须是 orderedRecords()');
  assert.strictEqual(body.indexOf('sumRowHtml(pg.rows)'), -1, '严禁传当前页 pg.rows');
  /* 插入位置：紧贴表体表 </tbody> 之前（不用 tfoot） */
  const sumIdx = body.indexOf('sumRowHtml(orderedRecords())');
  const tbodyEnd = body.indexOf("'</tbody></table></div>'");
  assert.ok(sumIdx > 0 && tbodyEnd > sumIdx, '合计行必须拼在 </tbody> 之前');
  /* 判据看的是**拼接用的字面量**，不是注释里提没提到 tfoot 这个词 */
  assert.strictEqual(body.indexOf("'<tfoot>'"), -1, '不得用 tfoot 段落（fixed + 双表结构下会被排除在重排之外）');
});

test('H6 契约：合计行不参与勾选（首列是空 td，不含 checkbox）', function () {
  const ctx = makeSumRow();
  const html = ctx.sumRowHtml([{ totalQty: 3 }]);
  assert.strictEqual(/<input/.test(html), false, '合计行不得含任何 input（含 checkbox）');
  assert.ok(html.indexOf('<td class="sel-col"></td>') >= 0, '首列必须是空的 sel-col td');
});

/* ================================================================
   §I 【build .167 · T04】cell-tip 悬浮（退役原生 title）
   ================================================================ */

test('I1 契约：统一悬浮框已就位（创建 .cell-tip 节点，且只在 init 注册一次）', function () {
  const body = fnBody(APP, 'function bindCellTip(');
  assert.ok(body.indexOf("tip.className = 'cell-tip'") >= 0, '必须创建 .cell-tip 节点');
  assert.ok(body.indexOf('document.body.appendChild(tip)') >= 0, '必须挂到 body');
  const initBody = fnBody(APP, 'function init(');
  assert.ok(initBody.indexOf('bindCellTip()') >= 0, 'bindCellTip 必须在 init() 内注册');
  assert.strictEqual(countOcc(APP, 'bindCellTip()'), 2,
    'bindCellTip 只允许「定义 1 处 + init 调用 1 处」（实际 ' + countOcc(APP, 'bindCellTip()') + ' 处）');
});

test('I2 契约：cellHtml 不再输出原生 title（否则原生 + 自定义双 tooltip）', function () {
  assert.strictEqual(badCellTitle(APP), false, 'cellHtml 体内不得出现 title="');
  const body = fnBody(APP, 'function cellHtml(');
  assert.ok(body.indexOf('data-col="') >= 0, 'cellHtml 必须仍带 data-col（列身份不能因去 title 被删掉）');
  assert.ok(body.indexOf('col-clip') >= 0, 'long 列必须仍带 .col-clip（截断是 tip 的前提）');
});

test('I3 契约：tip 逻辑覆盖 data-tip 优先 / select 特判 / 控件排除 / 视口翻转 / mouseout 隐藏 / 临时 span 测宽', function () {
  const body = fnBody(APP, 'function bindCellTip(');
  assert.ok(body.indexOf("closest('[data-tip]')") >= 0, '必须优先处理 [data-tip] 元素');
  assert.ok(body.indexOf("closest('select')") >= 0, '必须有 select 特判');
  assert.ok(body.indexOf('document.activeElement') >= 0, 'select 聚焦时必须隐藏（正在选择时不该弹）');
  assert.ok(body.indexOf("querySelector('select,input,textarea,button')") >= 0,
    '控件单元格必须排除（否则下拉框被 tip 遮挡）');
  assert.ok(body.indexOf('window.innerWidth - 8') >= 0 && body.indexOf('window.innerHeight - 8') >= 0,
    '必须有视口翻转（右/下放不下就翻到左/上）');
  assert.ok(body.indexOf("addEventListener('mouseout'") >= 0, '必须有 mouseout 隐藏');
  assert.ok(body.indexOf('createElement(\'span\')') >= 0 || body.indexOf('createElement("span")') >= 0,
    '必须用临时 span 测宽（ellipsis 下 scrollWidth/Range 不可靠）');
  assert.ok(body.indexOf("closest('.table-wrap table td, .table-wrap table .th-label')") >= 0,
    '覆盖范围必须含 td 与表头 .th-label');
  assert.ok(body.indexOf('removeChild(probe)') >= 0, '临时 span 必须移除（否则每次悬停泄漏一个节点）');
});

test('I4 契约：quality/index.html 有 .cell-tip 样式，且 .col-clip 的 ellipsis 规则在（tip 的前提）', function () {
  const css = cssBlock();
  assert.ok(/\.cell-tip\{position:fixed;z-index:9999/.test(css), '.cell-tip 必须是 fixed 定位 + 高层级');
  assert.ok(/pointer-events:none/.test(css), '.cell-tip 必须 pointer-events:none（否则挡住鼠标、鼠标一移就闪）');
  assert.ok(/white-space:pre-wrap/.test(css), '.cell-tip 必须 pre-wrap（多行异常描述要换行显示）');
  assert.ok(/max-width:440px/.test(css), '.cell-tip 最大宽度必须 440px（与生产一致）');
  /* col-clip 的 ellipsis 是 truncated() 能测出"被省略"的前提 */
  assert.ok(/\.col-clip\{[^}]*overflow:hidden[^}]*text-overflow:ellipsis[^}]*white-space:nowrap/.test(css),
    '.col-clip 必须 overflow:hidden + text-overflow:ellipsis + white-space:nowrap');
});

/* ---- 判别力：回潮变异必须变红 ---- */

test('J1 判别力：把合计入参改成 pg.rows ⇒ 判据必须变红；把 title 加回 cellHtml ⇒ 判据必须变红', function () {
  /* (a) 合计口径回潮：全量 → 当前页 */
  const sumNeedle = 'sumRowHtml(orderedRecords())';
  assert.strictEqual(countOcc(APP, sumNeedle), 1, '合计入参锚点必须命中恰 1 处');
  const sumMut = APP.replace(sumNeedle, 'sumRowHtml(pg.rows)');
  assert.notStrictEqual(sumMut, APP, '合计口径变异必须注入生效');
  assert.strictEqual(badSumInput(sumMut), true,
    '改成 pg.rows 后判据必须变红（否则"合计口径=全量"这条是摆设）');

  /* (b) 双 tooltip 回潮：把原生 title 加回 long 列 */
  const cellNeedle = "'<td class=\"col-clip\"' + attr + '>'";
  assert.strictEqual(countOcc(APP, cellNeedle), 1, 'cellHtml long 分支锚点必须命中恰 1 处');
  const cellMut = APP.replace(cellNeedle, "'<td class=\"col-clip\"' + attr + ' title=\"' + esc(text) + '\">'");
  assert.notStrictEqual(cellMut, APP, 'title 回潮变异必须注入生效');
  assert.strictEqual(badCellTitle(cellMut), true,
    '把 title 加回 cellHtml 后判据必须变红（否则"退役原生 title"这条是摆设）');

  /* 反假绿：未变异源码必须全绿 */
  assert.strictEqual(badSumInput(APP), false, '未变异源码不得被判为"当前页合计"');
  assert.strictEqual(badCellTitle(APP), false, '未变异源码不得被判为"仍在用原生 title"');
});
