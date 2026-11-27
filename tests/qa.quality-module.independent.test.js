'use strict';
/* ================================================================
   tests/qa.quality-module.independent.test.js
   —— QA 独立验收（.163 质量系统模块）
   ================================================================
   本文件只做三类事，全部来自**实测发现**，不复述任何人的说法：

   §A/§B  基线「防对消」守卫 + 变异判别力
      T05 把 4 个用例的参考系从 build.PREV 改成固定历史修订 .161。
      他给 PREV 加了 3 条防对消守卫（不得等于 HEAD / md5 不同 / 水印自证），
      **新引入的 B161 基线一条都没有** —— 一旦 .161 解析错，比对会自我对消、断言恒真而不报错。
      本节补齐这三条，并正向证明「改参考系是恢复判别力，不是削弱断言」：
        .162 的 thCol 与当前**逐字相同** ⇒ 原写法必然失效；.161 才是有差异的那一版。

   §C     渲染契约：ico() 产出的 svg 必须自带固有尺寸（totality 不变量）
   §D     渲染契约：#sysMenu 不得是有 span 隐藏规则的容器（h1 / .sub）的后代，
          且必须是触发器的兄弟（与生产页同构）

   §C/§D 的由来：这两个缺陷漏过了 1135 条测试，因为既有断言只查 DOM 文本与结构、
   从不查渲染尺寸与可见性。§C 用「totality 不变量」把这一类问题变成**不可能发生**
   （每个 svg 都自带宽高 ⇒ 任何漏加 CSS 约束的新容器都不会再爆）；
   §D 用「祖先链结构断言」把 CSS 选择器串味这一类变成可查。

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
/* 行尾归一化：`git show` 取出的 blob 恒为 LF，而工作树在 core.autocrlf=true 的机器上
   可能是 CRLF。本文件比较的是**代码内容**而非行尾，故两侧一律归一化，
   避免换个 checkout 就假失败（行尾纪律由 tests/qa.ops-eol.test.js 专管）。 */
const normEol = function (s) { return String(s).replace(/\r\n/g, '\n'); };

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
const gitShow = function (rev, rel) { return git(['show', rev + ':' + rel]); };

/**
 * 按提交主题反查修订（主题必须以 "build <ver>" 开头，防前缀误配）。
 * @param {string} ver 版本号
 * @returns {string} git 修订号
 */
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

/**
 * 去掉 HTML 注释、<style>、<script> 内容，只留可解析的标签结构。
 * 必须先剥：注释里会出现 `<h1>`、CSS/JS 里会出现标记字符串，都会污染标签栈。
 * @param {string} html 原始文本
 * @returns {string} 纯结构文本
 */
function structuralHtml(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '');
}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr']);

/**
 * 求某个带指定属性的元素在文档中的**祖先链**（由外到内）。
 * 只做结构解析、不依赖 DOM；不闭合标签按标准算法弹栈，噪声只会让链更长不会更短，
 * 因此「祖先链里不得出现 X」这类断言是保守的（不会漏报）。
 * @param {string} html 原始 HTML
 * @param {string} marker 定位标记，如 'id="sysMenu"'
 * @returns {Array<{name: string, attrs: string}>} 祖先链
 */
function ancestorChainOf(html, marker) {
  const src = structuralHtml(html);
  const pos = src.indexOf(marker);
  assert.ok(pos >= 0, '未能定位标记 ' + marker + '（结构已变，请同步本文件）');
  const stack = [];
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let m;
  while ((m = tagRe.exec(src)) !== null && m.index < pos) {
    /* 若这个标签自身跨过了 marker 位置，它就是**目标元素本身**，不能算进祖先链（否则
       触发器 #sysSwitchBtn 所在的那个 <h1> 会被误当成它自己的祖先）。 */
    if (m.index + m[0].length > pos) break;
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    const selfClose = m[4] === '/';
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].name === name) { stack.length = i; break; }
      }
    } else if (!selfClose && !VOID_TAGS.has(name)) {
      stack.push({ name: name, attrs: m[3] || '' });
    }
  }
  return stack;
}

/** 祖先链签名（用于"同一父容器"判定） */
function chainSig(chain) {
  return chain.map(function (e) { return e.name + '|' + e.attrs.replace(/\s+/g, ' ').trim(); }).join('/');
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

test(`A3【契约·关键】${build.PREV} 与 .161 的 thCol **都**与当前不同 ⇒ 本版 PREV 参考系重新具备判别力`, function () {
  /* 【.167 同步·必要同步（非放宽）】本条原为「.162 的 thCol 与当前**逐字相同**」，用来论证
     "拿 PREV 当参考系会恒红"。`.167` 修 D11 改了 thCol（判据并入单源 `filtOn`）⇒ 该前提被推翻。
     事实先于辩解：改成本版的真实形态 —— PREV 与 .161 **都**与当前不同。
     为防止改成自证式空断言（"两个都不是 HEAD 就绿"），本节保留三重判别力自证：
       ① 三侧都必须提取成功且足够长（否则"不同"可能只是提取失败）；
       ② 当前 thCol 必须含本版新增的 `filtOn(` 子句（证明差异确实来自 .167 的改动）；
       ③ 末尾显式**反向执行**同一逻辑：把"当前"当基线喂进去必须报错 ⇒ notEqual 不是恒真。
     【.167 补】文案改为 `${build.PREV}` 动态生成：本条断言本身参数化于 `build.PREV`，但此前 message
     写死「.165」⇒ 每次推进后标题与文案都会陈旧误导（断言仍绿）。**只动文案与标题，断言逻辑一字未改**。 */
  const now = extractFn(normEol(INDEX_SRC), 'thCol');
  const b162 = extractFn(normEol(B162_SRC), 'thCol');
  const b161 = extractFn(normEol(B161_SRC), 'thCol');

  /* 自证提取器有效（否则"不同"可能是两边都提取失败了） */
  assert.ok(now.indexOf('isSemFiltMode(m,col.key,f.mode)') >= 0, '当前 thCol 必须含语义筛选判据子句');
  assert.ok(now.indexOf('filtOn(') >= 0, '当前 thCol 必须含 .167 的单源判据 filtOn（本版改动自证）');
  assert.ok(now.length > 200 && b162.length > 200 && b161.length > 200,
    '三侧 thCol 提取结果都必须足够长（防提取失败伪装成"不同"）');

  assert.notEqual(b162, now,
    `${build.PREV} 的 thCol 与当前必须不同 —— .167 修 D11 改了判据，故 PREV 参考系在本版**重新具备**判别力；`
    + '（原断言为 equal：当时 .163~.166 未动 thCol，两侧确实逐字相同）');
  assert.notEqual(b161, now,
    '.161 的 thCol 必须与当前不同（它是「漏斗不亮」的那一版），否则新参考系没有判别力');
  assert.notEqual(b162, b161,
    `${build.PREV} 与 .161 的 thCol 也必须不同（.162 的修复曾改动 thCol）—— 三者互不相同`);

  /* ③ 改后仍会红（防恒真自证）：把"当前"当基线喂进同一套断言逻辑，必须抛错 */
  const assertDiffersFrom = function (base, label) {
    assert.notEqual(base, now, label + '：基线与当前相同 ⇒ 该断言会红（判别力自证）');
    return true;
  };
  assert.throws(function () { assertDiffersFrom(now, '自证'); },
    /基线与当前相同 ⇒ 该断言会红/,
    '把当前版当基线时必须报错 ⇒ 上面两条 notEqual 有判别力（不是恒真）');
});

test('A4【契约】新参考系的语义正确：.161 无 isSemFiltMode 子句、当前有（不是随便找了版不同的）', function () {
  const now = extractFn(normEol(INDEX_SRC), 'thCol');
  const b161 = extractFn(normEol(B161_SRC), 'thCol');
  assert.equal(b161.indexOf('isSemFiltMode(m,col.key,f.mode)'), -1,
    '.161 的 thCol 必须**不含** isSemFiltMode 判据子句（这正是"回退它 ⇒ §C1 必须变红"的前提）');
  assert.ok(now.indexOf('isSemFiltMode(m,col.key,f.mode)') >= 0, '当前 thCol 必须含该子句');
});

/* ================================================================
   §B 变异判别力：独立复现「整段回退 thCol」这个变异
================================================================ */

test('B1【契约·关键】变异「回退到 .161 的 thCol」必须真的改变文本（该参考系可判别）', function () {
  const src = normEol(INDEX_SRC);
  const now = extractFn(src, 'thCol');
  const b161 = extractFn(normEol(B161_SRC), 'thCol');
  assert.equal(countOcc(src, now), 1, 'thCol 原文必须恰命中 1 处（否则变异会撒到别处）');
  const mutated = src.replace(now, b161);
  assert.notEqual(mutated, src, '回退到 .161 后文本必须发生变化（变异生效）');
  assert.equal(countOcc(mutated, 'isSemFiltMode(m,col.key,f.mode)'), 0,
    '回退后 isSemFiltMode 判据子句必须消失（这才是"增量被整段删掉"）');
});

test(`B2【契约·关键】变异「回退到 ${build.PREV} 的 thCol」是**真变异**（本版 PREV 参考系重新有判别力）`, function () {
  /* 【.167 同步·必要同步（方向反转，强度不减）】本条原断言「回退到 PREV 的 thCol 与当前完全相同 ⇒ no-op」，
     用于论证"PREV 参考系没有判别力"。`.167` 改了 thCol ⇒ 回退到 ${build.PREV} **不再是 no-op**。
     方向反转但仍是可观测硬断言：必须真的改文本、且 .167 的 act 判据行必须消失。
     （若哪天有人把 thCol 改回与 ${build.PREV} 逐字相同，本条会立刻变红并提示重新评估参考系。） */
  const src = normEol(INDEX_SRC);
  const now = extractFn(src, 'thCol');
  const b162 = extractFn(normEol(B162_SRC), 'thCol');
  assert.equal(countOcc(src, now), 1, 'thCol 原文必须恰命中 1 处（否则变异会撒到别处）');
  assert.notEqual(now, b162,
    `回退到 ${build.PREV} **必须**改变文本（.167 改了 thCol ⇒ 该变异不再是 no-op）`);
  const mutated = src.replace(now, b162);
  assert.notEqual(mutated, src,
    '替换前后必须不同 —— 本版 PREV 参考系有判别力（原 no-op 结论已随 .167 失效）');
  assert.equal(countOcc(mutated, 'const act=f&&(filtOn(f)||isSemFiltMode(m,col.key,f.mode));'), 0,
    '回退后 .167 的 act 判据行必须消失（这才是"整段回退"，不是局部改写）');
  assert.equal(countOcc(mutated, '||isSemFiltMode(m,col.key,f.mode)'), 1,
    `回退到 ${build.PREV} 后 .162 的语义档子句必须**仍在**（这正是 ${build.PREV} 与 .161 的区别，证明回退的是 .167 那一层）`);
});

/* ================================================================
   §C 渲染契约：ico() 产出的 svg 必须自带固有尺寸（totality 不变量）
   —— 修 P0（图标 956×956 把整页撑坏）的根因防线
================================================================ */

/**
 * 取出 ico() 返回的那个 <svg ...> 开标签的属性串。
 * ⚠ 必须先剥掉 stroke-width：否则 /width\s*=/ 会被 `stroke-width="2"` 命中，
 *   断言退化成恒真（本文件第一版就踩了这个坑，实测"永远绿"）。
 * @param {string} qApp quality/qa-app.js 源码
 * @returns {string} <svg> 开标签的属性部分
 */
function icoSvgAttrs(qApp) {
  const body = extractFn(qApp, 'ico').replace(/stroke-width\s*=\s*["'][^"']*["']/g, '');
  const m = /<svg\b((?:[^>"']|"[^"]*"|'[^']*')*)>/.exec(body);
  assert.ok(m, 'ico() 必须直接返回 <svg ...> 字面量（结构已变，请同步本文件）');
  return m[1];
}

test('C1【契约·根因】ico() 产出的 <svg> 必须自带 width 与 height 固有尺寸', function () {
  const attrs = icoSvgAttrs(readRel('quality/qa-app.js'));
  const w = /(?:^|\s)width\s*=\s*["']?\d/.exec(attrs);
  const h = /(?:^|\s)height\s*=\s*["']?\d/.exec(attrs);
  assert.ok(w, 'ico() 的 <svg> 必须带 width 属性：没有固有尺寸的 svg 会按容器 100% 撑开'
    + '（实测曾渲染成 956×956，把 .card 顶到 1841px、工具栏推到首屏外）。'
    + '这是在**产出侧**一次性封死整类问题：任何漏加 CSS 约束的新容器都不会再爆。');
  assert.ok(h, 'ico() 的 <svg> 必须带 height 属性（只写 width 时高度仍会按宽高比/容器撑开）');
  /* 取值合理性：0 或负数等于没有尺寸 */
  const wn = Number(/(?:^|\s)width\s*=\s*["']?(\d+)/.exec(attrs)[1]);
  const hn = Number(/(?:^|\s)height\s*=\s*["']?(\d+)/.exec(attrs)[1]);
  assert.ok(wn >= 12 && hn >= 12 && wn <= 64 && hn <= 64,
    'svg 固有尺寸必须在 [12,64] 内（实际 ' + wn + '×' + hn + '）；过大同样会撑坏布局，过小不可读');
});

test('C2【契约·纵深防御】.card-title svg 必须有一条 CSS 尺寸规则', function () {
  const qHtml = readRel('quality/index.html');
  const ok = /\.card-title\s+svg\s*\{[^}]*width\s*:\s*\d+px[^}]*\}/i.test(qHtml)
    || /\.card-title\s+svg\s*\{[^}]*height\s*:\s*\d+px[^}]*\}/i.test(qHtml);
  assert.ok(ok, '即使 ico() 已自带尺寸，`.card-title svg` 仍应有一条 CSS 规则显式钉住：'
    + 'presentation attribute 的优先级最低，任何后续 CSS 都能覆盖它；'
    + '显式规则让"卡片标题图标就是这么大"成为不可争的事实，而不是"取决于 ico 的实现"。');
});

/* ================================================================
   §D 渲染契约：折叠态不得隐藏面板文字
   —— 修 P1（折叠后下拉一个字都没有）的结构防线
================================================================ */

test('D1【契约】#sysMenu 的祖先链里不得出现 h1 或 .sub（折叠态会把它们的 span 一起隐藏）', function () {
  const qHtml = readRel('quality/index.html');
  const chain = ancestorChainOf(qHtml, 'id="sysMenu"');
  const names = chain.map(function (e) {
    const cls = /(?:^|\s)class\s*=\s*"([^"]*)"/.exec(e.attrs);
    return e.name + (cls ? '.' + cls[1].trim().split(/\s+/).join('.') : '');
  });

  const bad = chain.filter(function (e) {
    if (e.name === 'h1') return true;
    const cls = /(?:^|\s)class\s*=\s*"([^"]*)"/.exec(e.attrs);
    const list = cls ? cls[1].trim().split(/\s+/) : [];
    return list.indexOf('sub') >= 0;
  }).map(function (e) { return e.name; });

  assert.deepStrictEqual(bad, [],
    '#sysMenu 的祖先链里出现了 ' + JSON.stringify(bad) + '（完整链：' + names.join(' > ') + '）。'
    + '原因：既有规则 `.sidebar.collapsed .sidebar-header h1 span{display:none}` 与 '
    + '`.sidebar.collapsed .sidebar-header .sub{display:none}` 会在折叠态隐藏其内部**所有** span，'
    + '面板项的系统名与 ✓ 会被一并吞掉 —— 实测面板 innerText 退化成空串，切换入口失效。'
    + '面板必须是触发器的**兄弟**节点（与生产 index.html 同构），祖先后代关系一概不允许。');
});

test('D2【契约】#sysMenu 与触发器必须是**兄弟**（同一父容器），与生产页同构', function () {
  const qHtml = readRel('quality/index.html');
  const menuChain = ancestorChainOf(qHtml, 'id="sysMenu"');
  assert.ok(menuChain.length >= 1, '#sysMenu 必须有父容器');
  const trigChain = ancestorChainOf(qHtml, 'id="sysSwitchBtn"');
  assert.equal(chainSig(menuChain), chainSig(trigChain),
    '#sysMenu 与触发器 #sysSwitchBtn 必须同父（兄弟关系）。实际面板父链：' + chainSig(menuChain)
    + '；触发器父链：' + chainSig(trigChain));
});

test('D3【契约+守卫·现状】折叠态面板必须浮到侧边栏右侧（left≠0 是契约；写法 calc(100%) 是现状固定）', function () {
  /* 分级说明（沿用项目既有标记口径）：
       · 「left 不得为 0」= 【契约】：为 0 时面板整块压在 56px 侧边栏上、还伸出视口左边缘，
         实测 x=-4，违反 P0-3「向右浮出、不被裁切」。
       · 「left 必须是 calc(100%…)」= 【守卫·现状】：这是当前**已知正确**的写法。
         换成另一种正确写法（如固定 62px）本文件会红，按提示同步即可 ——
         此处刻意选择「宁可误红，也不放过 left:8px 这类仍然压在侧边栏上的回归」。 */
  const qHtml = readRel('quality/index.html');
  const m = /\.sidebar\.collapsed\s+\.sys-menu\s*\{([^}]*)\}/.exec(qHtml);
  assert.ok(m, '折叠态必须有 .sidebar.collapsed .sys-menu 定位规则');
  const left = /left\s*:\s*([^;}]+)/.exec(m[1]);
  assert.ok(left, '折叠态 .sys-menu 规则必须显式声明 left（不要依赖默认定位）');
  const val = left[1].trim();
  assert.notEqual(val, '0', '折叠态面板 left 不得为 0：实测 x=-4，整块压在 56px 侧边栏上、'
    + '左边缘还伸出视口 4px。P0-3 要求「面板向右浮出、不被裁切」，应改为 left:calc(100% + 6px)');
  assert.ok(/calc\(\s*100%/.test(val),
    '【守卫·现状】折叠态面板 left 应基于 100% 计算（浮到容器右侧，实测 61px ≥ 侧边栏 56px）。'
    + '若确属有意的布局重设计，请同步本断言；不要为了让它变绿而改成 left:8px 之类的值 ——'
    + '那样面板仍会压在侧边栏上。');

  /* 生产页必须同口径（PRD 5.2「折叠态与 5.1 同规则」）—— 防止两页各自漂移 */
  const pHtml = readRel('index.html');
  const pm = /\.sidebar\.collapsed\s+\.sys-menu\s*\{([^}]*)\}/.exec(pHtml);
  assert.ok(pm, '生产页也必须有折叠态 .sys-menu 规则（两页同口径）');
  assert.ok(/calc\(\s*100%/.test(/left\s*:\s*([^;}]+)/.exec(pm[1])[1]),
    '生产页折叠态面板同样必须浮到右侧（两页口径一致）');
});
