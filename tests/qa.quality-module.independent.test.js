'use strict';
/* ================================================================
   tests/qa.quality-module.independent.test.js
   —— QA 独立验收（.163 质量系统模块）· 补「工程师未覆盖」的两类守卫
   ================================================================
   本文件只做三件事，全部来自**实测发现**，不复述任何人的说法：

   §A 基线「防对消」守卫（补工程师缺的那一条）
      T05 把 4 个用例的参考系从 build.PREV 改成固定历史修订 revOfBuild('2026-11-20.161')。
      他给 PREV 加了「基线不得等于 HEAD / 两版 md5 必须不同 / 基线必须自证水印」三条防对消，
      **却完全没有给新的 B161 基线加同类守卫** —— 一旦 .161 解析不到或解析错，
      比对就会自我对消、断言退化为恒真。本节把这三条补齐。
      同时**正向证明这次改动是「恢复判别力」而非「削弱断言」**：
       .162 的 thCol 与当前**逐字相同** ⇒ 原来拿 PREV 当参考系必然失效；.161 才是有差异的那一版。

   §B 变异判别力（独立复现 K11(b) 的语义，不看他的断言）
      「把当前 thCol 整段换回 X 版」这个变异：
        · X = .161 ⇒ 文本真的变了（变异生效，可判别）
        · X = .162 ⇒ 文本没变（变异是 no-op，参考系无判别力）
      这一对就是「参考系必须固定在 .161」的直接证据。

   §C/§D 质量页渲染契约守卫（真实浏览器实测发现的 2 个缺陷）
      自动化断言只查 DOM 文本与结构，查不出「渲染出来是 956px 大的图标」，
      故这里用**静态契约**把两条渲染不变量固定住。

   断言标记：【契约】= 需求/设计规定的行为，不符即产品缺陷。
   ================================================================ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

/* 版本号一律从 harness 派生（tests/qa.parts-ledger.validate.159 §D3② 禁止其他测试文件
   硬编码当前/上一版的完整版本字面量，否则下一版必红）。 */
const build = require('./harness/build');

const ROOT = path.resolve(__dirname, '..');
const md5 = function (s) { return crypto.createHash('md5').update(String(s), 'utf8').digest('hex'); };
const countOcc = function (h, n) { return String(h).split(String(n)).length - 1; };
const readRel = function (rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); };

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
const gitShow = function (rev, rel) { return git(['show', rev + ':' + rel]); };

/** 按提交主题反查修订（主题必须以 "build <ver>" 开头，防前缀误配） */
function revOfBuild(ver) {
  const out = git(['log', '--format=%H%x09%s', '-n', '600']);
  const revs = out.split('\n').filter(function (l) {
    const i = l.indexOf('\t');
    return i >= 0 && l.slice(i + 1).indexOf('build ' + ver) === 0;
  }).map(function (l) { return l.slice(0, l.indexOf('\t')); });
  assert.ok(revs.length >= 1, '必须在提交主题里反查到 build ' + ver + ' 的修订');
  return revs[0];
}

/**
 * 字符串/注释感知的大括号配平提取器（独立实现，不复用其它测试文件的 helper）。
 * 提取不到或结果过短一律抛错 —— 禁止静默返回空导致断言恒真。
 * @param {string} src 源码
 * @param {string} name 函数名
 * @returns {string} 函数体文本
 */
function extractFn(src, name) {
  const re = new RegExp('function\\s+' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(', 'g');
  const m = re.exec(src);
  if (!m) throw new Error('[QA] 未找到函数 ' + name);
  const start = m.index;
  let depth = 0, i = m.index, state = null;
  for (; i < src.length; i++) {
    const ch = src[i], nx = src[i + 1];
    if (state === null) {
      if (ch === '/' && nx === '/') { state = 'line'; i++; continue; }
      if (ch === '/' && nx === '*') { state = 'block'; i++; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { state = ch; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) break; }
      continue;
    }
    if (state === 'line') { if (ch === '\n') state = null; continue; }
    if (state === 'block') { if (ch === '*' && nx === '/') { state = null; i++; } continue; }
    if (ch === '\\') { i++; continue; }
    if (ch === state) state = null;
  }
  const out = src.slice(start, i + 1);
  assert.ok(out.length > 60, '函数 ' + name + ' 提取结果异常短（' + out.length + '）—— 提取器失效');
  return out;
}

/* 四个坐标：当前工作树 / 本版发布修订 / 上一版 / 上上一版（.161 是不可变历史，写死反而更稳） */
const INDEX_SRC = readRel('index.html');
const HEAD = git(['rev-parse', 'HEAD']).trim();
const B163_REV = revOfBuild(build.BUILD);
const B162_REV = revOfBuild(build.PREV);
const B161_REV = revOfBuild('2026-11-20.161');
const B162_SRC = gitShow(B162_REV, 'index.html');
const B161_SRC = gitShow(B161_REV, 'index.html');

/* ================================================================
   §A 基线防对消守卫（工程师只给 PREV 加了，B161 一条都没有）
================================================================ */

test('A1【契约】固定历史基线 .161 确实解析到独立修订（不得等于 HEAD、不得等于 .162）', function () {
  assert.notEqual(B161_REV, HEAD, 'B161 基线不得是 HEAD（否则比对自我对消、断言恒真）');
  assert.notEqual(B161_REV, B162_REV, 'B161 基线不得与 .162 是同一修订（否则"两版差异"恒假）');
  assert.match(B161_REV, /^[0-9a-f]{40}$/, '.161 必须解析出一个真实 git 修订号');
});

test('A2【契约】固定历史基线 .161 用水印自证（取错修订则全部比对失效）', function () {
  assert.equal(countOcc(B161_SRC, '>build 2026-11-20.161<'), 1,
    '.161 基线必须自证水印恰 1 处（取错修订 ⇒ 后面的"两版不同"结论不可信）');
  assert.equal(countOcc(B162_SRC, '>build ' + build.PREV + '<'), 1, '.162 基线必须自证水印恰 1 处');
  assert.notEqual(md5(B161_SRC), md5(INDEX_SRC), '.161 与当前 index.html 必须是不同文件');
});

test('A3【契约·关键】.162 的 thCol 与当前**逐字相同** ⇒ 原「拿 PREV 当参考系」的写法必然失效（改动是必要的）', function () {
  const now = extractFn(INDEX_SRC, 'thCol');
  const b162 = extractFn(B162_SRC, 'thCol');
  const b161 = extractFn(B161_SRC, 'thCol');

  /* 自证提取器有效（否则"相同"可能是两边都提取失败了） */
  assert.ok(now.indexOf('isSemFiltMode(m,col.key,f.mode)') >= 0, '当前 thCol 必须含语义筛选判据子句');
  assert.ok(now.length > 200 && b161.length > 200, '两侧 thCol 提取结果都必须足够长');

  assert.equal(b162, now,
    '.162 的 thCol 与当前必须逐字相同 —— 这正是「原断言 notEqual(当前, PREV) 会恒红」的根因；'
    + '工程师把参考系改到 .161 是**必要**的，不改则用例必然失效');
  assert.notEqual(b161, now,
    '.161 的 thCol 必须与当前不同（它是「漏斗不亮」的那一版），否则新参考系没有判别力');
});

test('A4【契约】新参考系的语义正确：.161 无 isSemFiltMode 子句、当前有（不是随便找了版不同的）', function () {
  const now = extractFn(INDEX_SRC, 'thCol');
  const b161 = extractFn(B161_SRC, 'thCol');
  assert.equal(b161.indexOf('isSemFiltMode(m,col.key,f.mode)'), -1,
    '.161 的 thCol 必须**不含** isSemFiltMode 判据子句（这正是"回退它 ⇒ §C1 必须变红"的前提）');
  assert.ok(now.indexOf('isSemFiltMode(m,col.key,f.mode)') >= 0,
    '当前 thCol 必须含该子句');
});

/* ================================================================
   §B 变异判别力：独立复现「整段回退 thCol」这个变异
================================================================ */

test('B1【契约·关键】变异「回退到 .161 的 thCol」必须真的改变文本（该参考系可判别）', function () {
  const now = extractFn(INDEX_SRC, 'thCol');
  const b161 = extractFn(B161_SRC, 'thCol');
  assert.equal(countOcc(INDEX_SRC, now), 1, 'thCol 原文必须恰命中 1 处（否则变异会撒到别处）');
  const mutated = INDEX_SRC.replace(now, b161);
  assert.notEqual(mutated, INDEX_SRC, '回退到 .161 后文本必须发生变化（变异生效）');
  assert.equal(countOcc(mutated, 'isSemFiltMode(m,col.key,f.mode)'), 0,
    '回退后 isSemFiltMode 判据子句必须消失（这才是"增量被整段删掉"）');
});

test('B2【契约·关键】变异「回退到 .162 的 thCol」是 no-op ⇒ 证明 PREV 参考系没有判别力', function () {
  const now = extractFn(INDEX_SRC, 'thCol');
  const b162 = extractFn(B162_SRC, 'thCol');
  /* 这正是工程师在 K11(b) 里踩的坑：用 PREV(=.162) 时 anchor === repl，
     变异注入的"必须真的变化"守卫会立刻报「变异注入未生效」，用例变成不可能通过。 */
  assert.equal(now, b162, '回退到 .162 与当前完全相同 ⇒ 变异是 no-op');
  const mutated = INDEX_SRC.replace(now, b162);
  assert.equal(mutated, INDEX_SRC,
    '这正是"no-op 变异"：替换前后一模一样 —— 若参考系仍用 PREV，本类防退化用例必然失效');
});

/* ================================================================
   §C 质量页渲染契约：卡片标题图标必须有尺寸约束
   （真实浏览器实测：无约束时该 svg 渲染成 956×956，把整页撑坏）
================================================================ */

test('C1【契约】质量页 .card-title 内的 svg 必须有尺寸约束', function () {
  const qHtml = readRel('quality/index.html');
  const qApp = readRel('quality/qa-app.js');

  /* 允许两种修法（断言"不变量"而不是某一种实现）：
     ① CSS 里加 .card-title svg{width:..;height:..}
     ② ico() 产出的 svg 自带 width/height 或行内 style */
  const cssRule = /\.card-title\s+svg\s*\{[^}]*width\s*:\s*\d+px[^}]*height\s*:\s*\d+px/i.test(qHtml)
    || /\.card-title\s+svg\s*\{[^}]*height\s*:\s*\d+px[^}]*width\s*:\s*\d+px/i.test(qHtml);
  /* ⚠ 必须先剥掉 stroke-width：否则 /width\s*=/ 会被 `stroke-width="2"` 命中，
     本断言退化成恒真（本文件第一版就踩了这个坑，实测"永远绿"）。 */
  const icoFn = extractFn(qApp, 'ico').replace(/stroke-width\s*=\s*["'][^"']*["']/g, '');
  /* 只认「width=数字」或行内 style 里的 width:，且不得是 stroke-width（已剥离） */
  const inlineSized = /(?:^|[^-\w])width\s*=\s*["']?\d/.test(icoFn)
    || /style\s*=\s*["'][^"']*(?:^|[^-\w])width\s*:/.test(icoFn);

  assert.ok(cssRule || inlineSized,
    '质量页 .card-title 的 svg 必须受尺寸约束：无约束时 SVG 按容器 100% 撑开'
    + '（实测渲染成 956×956px，卡片高 1841px，工具栏被推到首屏外）。'
    + '请在 quality/index.html 加 `.card-title svg{width:18px;height:18px;flex-shrink:0}`，'
    + '或让 ico() 产出带 width/height 的 svg。');
});

test('C2【契约】质量页里每个「无尺寸约束的 svg 使用点」都必须有对应 CSS 规则', function () {
  const qHtml = readRel('quality/index.html');
  const qApp = readRel('quality/qa-app.js');
  /* 只对 ico() 产出的 svg 做检查：它在哪些容器里被用，哪些容器就有 svg 尺寸规则 */
  const containers = ['card-title', 'btn', 'nav-item', 'sys-menu-item', 'empty'];
  const used = containers.filter(function (c) {
    return new RegExp('[\'"]' + c + '[\'"]').test(qApp) || new RegExp('class="' + c + '"').test(qApp);
  });
  const missing = used.filter(function (c) {
    if (c === 'sys-menu-item') return !/\.sys-menu-item\s+svg\s*\{[^}]*width/.test(qHtml);
    if (c === 'card-title') {
      /* card-title 允许走 ico() 行内尺寸那条路，由 C1 兜底；这里只在两边都没有时报错 */
      const css = /\.card-title\s+svg\s*\{[^}]*width\s*:\s*\d+px/i.test(qHtml);
      const icoBare = extractFn(qApp, 'ico').replace(/stroke-width\s*=\s*["'][^"']*["']/g, '');
      const inlineSized = /(?:^|[^-\w])width\s*=\s*["']?\d/.test(icoBare)
        || /style\s*=\s*["'][^"']*(?:^|[^-\w])width\s*:/.test(icoBare);
      return !(css || inlineSized);
    }
    return !new RegExp('\\.' + c + '\\s+svg\\s*\\{[^}]*width').test(qHtml);
  });
  assert.deepStrictEqual(missing, [],
    '以下容器内会渲染 ico() 产出的无尺寸 svg，但缺少对应的 svg 尺寸规则：' + missing.join(', '));
});

/* ================================================================
   §D 质量页折叠态系统切换面板：不得隐藏文字、不得压在侧边栏上
   （真实浏览器实测：面板里一个字都没有）
================================================================ */

test('D1【契约】#sysMenu 不得嵌在系统切换的 `h1` 内（折叠态 h1 span{display:none} 会吞掉面板文字）', function () {
  const qHtml = readRel('quality/index.html');
  const btnIdx = qHtml.indexOf('id="sysSwitchBtn"');
  assert.ok(btnIdx >= 0, '未能定位质量页系统切换触发器 #sysSwitchBtn（结构已变，请同步本文件）');
  const h1Open = qHtml.lastIndexOf('<h1', btnIdx);
  const h1Close = qHtml.indexOf('</h1>', btnIdx);
  assert.ok(h1Open >= 0 && h1Close > h1Open, '未能定位触发器所在的 <h1> 边界（结构已变，请同步本文件）');
  const h1Block = qHtml.slice(h1Open, h1Close + 5);

  assert.equal(h1Block.indexOf('id="sysMenu"'), -1,
    '#sysMenu 必须移出 <h1>：折叠态规则 `.sidebar.collapsed .sidebar-header h1 span{display:none}`'
    + ' 会把面板里所有 <span>（系统名与 ✓）一并隐藏，实测面板变成"只有两个图标、一个字都没有"。'
    + '生产系统把 #sysMenu 放在 h1 的兄弟位置，所以生产页没有这个问题。');
  /* 正向：面板必须仍然存在，且位于该 h1 之后（= 兄弟节点，而不是被挪到别处或删掉） */
  const menuIdx = qHtml.indexOf('id="sysMenu"');
  assert.ok(menuIdx >= 0, '#sysMenu 必须存在（不得用删除面板的方式绕过）');
  assert.ok(menuIdx > h1Close, '#sysMenu 必须位于触发器 <h1> 之后（作为兄弟节点）');
});

test('D2【契约】折叠态面板必须向侧边栏右侧浮出（left 不得为 0）', function () {
  const qHtml = readRel('quality/index.html');
  const m = /\.sidebar\.collapsed\s+\.sys-menu\s*\{([^}]*)\}/.exec(qHtml);
  assert.ok(m, '折叠态必须有 .sidebar.collapsed .sys-menu 定位规则');
  const left = /left\s*:\s*([^;}]+)/.exec(m[1]);
  assert.ok(left, '折叠态 .sys-menu 规则必须显式声明 left（不要依赖默认定位）');
  const val = left[1].trim();
  assert.notEqual(val, '0', '折叠态面板 left 不得为 0：实测 x=-4，整块压在 56px 侧边栏上、左边缘还伸出视口 4px。'
    + 'P0-3 要求"面板向右浮出、不被裁切"，应改为 left:calc(100% + 6px)（与生产页一致）');
});
