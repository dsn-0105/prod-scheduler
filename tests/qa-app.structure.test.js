'use strict';
/* ============================================================
   tests/qa-app.structure.test.js —— 质量页「CSS/结构类」缺陷的源码级守卫
   ------------------------------------------------------------
   【build .163 · P0-1 / P1-2 复盘产物】
   QA 用真实浏览器抓到两个**过了全部 1135 条自动化测试**的缺陷，都属于
   「源码/DOM 文本全对、只有渲染几何或 CSS 层叠才暴露」的类别：
     P0-1  `ico()` 产出的 svg 没有 width/height ⇒ `.card-title svg` 按容器 100% 撑成
           956×956，卡片高 1841px，工具栏被推到 y=1051（首屏 900px 完全看不见）
     P1-2  `#sysMenu` 放在 `<h1>` 内部 ⇒ 既有规则
           `.sidebar.collapsed .sidebar-header h1 span{display:none}` 在折叠态把面板项
           文字与 ✓ 一起隐藏（innerText 变空串）
   这两条的**根因都是纯静态可判的**（缺尺寸约束 / 结构挂错父节点），只是此前没人写断言。
   本文件把根因钉死，让同类缺陷不必等到真浏览器才发现。

   ⚠️ 本文件**不替代**真浏览器几何量测：它能守住"根因存在与否"，但守不住
      "某人给 .card-title 加了 width:calc(...)" 这类新的布局事故。
      布局类的最终判据仍是真浏览器（QA 侧 gate）。运行：node --test tests/qa-app.structure.test.js
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'quality', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'quality', 'qa-app.js'), 'utf8');

/** 取 <style> 段（本页样式全部内联） */
function cssBlock() {
  const a = HTML.indexOf('<style>');
  const b = HTML.indexOf('</style>');
  assert.ok(a > 0 && b > a, 'quality/index.html 必须含内联 <style> 段');
  return HTML.slice(a, b);
}

/** 取 `ico()` 函数体源码（从 `function ico(` 到下一个顶层 `}` 结束的近似切片） */
function icoBody() {
  const i = APP.indexOf('function ico(');
  assert.ok(i > 0, 'qa-app.js 必须仍有 ico() 图标工厂');
  const rest = APP.slice(i);
  const end = rest.indexOf('\n  }');
  assert.ok(end > 0, '无法定位 ico() 函数体结尾');
  return rest.slice(0, end);
}

/* ============================================================
   §1 P0-1：ico() 产出的 svg 必须自带 width/height
   ============================================================ */
test('§1 ico() 必须输出 width/height presentation 属性（否则 svg 会按容器 100% 撑开）', function () {
  const body = icoBody();
  /* 反假绿：确认拿到的确实是那个拼 svg 字符串的函数体 */
  assert.ok(body.indexOf("'<svg") >= 0 || body.indexOf('"<svg') >= 0, 'ico() 必须拼接 <svg 字符串');
  assert.ok(/<svg[^>]*\swidth="\d+"/.test(body),
    'ico() 输出的 <svg 必须带 width="…"（P0-1 根因：无尺寸的 svg 会撑满容器）');
  assert.ok(/<svg[^>]*\sheight="\d+"/.test(body),
    'ico() 输出的 <svg> 必须带 height="…"');
  /* 必须是 presentation attribute 而非写死 style：CSS 类规则要能覆盖它 */
  assert.strictEqual(/<svg[^>]*style="[^"]*width/.test(body), false,
    '不得用行内 style 定尺寸（行内 style 会盖掉 .btn svg / .empty svg 等既有类规则）');
});

test('§1b 所有承载 ico() 图标的容器都必须有 svg 尺寸规则（本页没有行内 style 兜底）', function () {
  const css = cssBlock();
  /* 这些类的 svg 都可能由 ico() 注入（见 qa-app.js 的调用点） */
  const NEED = ['.card-title svg', '.nav-item svg', '.btn svg', '.empty svg', '.sys-menu-item svg'];
  const missing = NEED.filter(function (sel) {
    const re = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{[^}]*width\\s*:\\s*\\d');
    return !re.test(css);
  });
  assert.deepStrictEqual(missing, [],
    '以下选择器缺 width 约束（生产页靠行内 style 兜底，本页没有）⇒ ' + missing.join(', '));
});

/* ============================================================
   §2 P1-2：系统切换面板不能挂在 <h1> 里
   ============================================================ */
test('§2 #sysMenu 必须是 .sys-switch 的直接子节点，且**不是** <h1> 的后代', function () {
  const swStart = HTML.indexOf('id="sysSwitch"');
  assert.ok(swStart > 0, '必须存在 .sys-switch 容器 #sysSwitch');
  const swOpen = HTML.lastIndexOf('<div', swStart);
  const swClose = HTML.indexOf('</div>', HTML.indexOf('id="sysMenu"'));
  assert.ok(swOpen > 0 && swClose > swOpen, '无法确定 .sys-switch 容器范围');
  const container = HTML.slice(swOpen, swClose);

  /* 面板必须在容器内 */
  assert.ok(container.indexOf('id="sysMenu"') >= 0, '#sysMenu 必须在 .sys-switch 容器内');

  /* 关键：面板出现的位置不能落在 <h1 …> … </h1> 之间 */
  const h1a = container.indexOf('<h1');
  const h1b = container.indexOf('</h1>');
  const menuAt = container.indexOf('id="sysMenu"');
  assert.ok(h1a >= 0 && h1b > h1a, '.sys-switch 内必须有 <h1> 触发器');
  assert.ok(menuAt > h1b,
    '#sysMenu 必须是 <h1> 的**兄弟**而不是后代（放在 h1 里会被折叠态规则 '
    + '`.sidebar.collapsed .sidebar-header h1 span{display:none}` 连同文字一起隐藏 —— P1-2 根因）');

  /* 触发器仍必须绑 toggle，折叠态只靠它开面板 */
  assert.ok(/<h1[^>]*onclick="QA_APP\.toggleSysMenu\(event\)"/.test(container),
    '<h1> 触发器必须绑定 QA_APP.toggleSysMenu(event)');
});

test('§2b 折叠态面板必须从侧边栏右侧浮出（left 不得为 0）', function () {
  const css = cssBlock();
  const m = /\.sidebar\.collapsed \.sys-menu\{([^}]*)\}/.exec(css);
  assert.ok(m, '必须存在 .sidebar.collapsed .sys-menu 折叠态规则');
  const body = m[1];
  assert.ok(/left:\s*calc\(100%\s*\+\s*\d+px\)/.test(body),
    '折叠态面板必须 left:calc(100% + Npx)（从 56px 侧边栏右侧浮出）；'
    + '旧写法 left:0 配 .sys-switch 的负 margin 会跑到 x=-4、并整块压在侧边栏上 —— P1-2 根因。实际：' + body);
  assert.strictEqual(/left:\s*0\b/.test(body), false, '折叠态 left 不得为 0');
});

test('§2c 折叠态触发器要有 36×36 命中区（折叠后 h1 内只剩 20px 图标）', function () {
  const css = cssBlock();
  const m = /\.sidebar\.collapsed \.sys-switch-trigger\{([^}]*)\}/.exec(css);
  assert.ok(m, '必须存在 .sidebar.collapsed .sys-switch-trigger 规则');
  assert.ok(/width:\s*36px/.test(m[1]) && /height:\s*36px/.test(m[1]),
    '折叠态命中区必须是 36×36（与 .hamburger 同尺寸）：' + m[1]);
});

/* ============================================================
   §3 回归护栏：既有容器尺寸规则未被误改
   ============================================================ */
test('§3 既有 svg 尺寸规则保持不变（presentation 属性不得把它们带偏）', function () {
  const css = cssBlock();
  const EXPECT = {
    '.sys-switch-icon': '20px',
    '.sys-menu-item svg': '16px',
    '.btn svg': '15px',
    '.empty svg': '40px',
    '.card-title svg': '18px',
  };
  Object.keys(EXPECT).forEach(function (sel) {
    const re = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{[^}]*width\\s*:\\s*([\\d.]+px)');
    const m = re.exec(css);
    assert.ok(m, sel + ' 必须有 width 规则');
    assert.strictEqual(m[1], EXPECT[sel], sel + ' 的 width 应为 ' + EXPECT[sel] + '，实际 ' + m[1]);
  });
});
