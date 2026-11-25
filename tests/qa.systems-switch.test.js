'use strict';
/* ============================================================
   tests/qa.systems-switch.test.js —— 生产系统「系统切换下拉」的源码级守卫
   ------------------------------------------------------------
   【build .163】为什么必须新建（设计 §1.2.6d）：这是本轮对生产单文件
   index.html 的**唯一侵入面**（4 类 / 6 个落点）。没有守卫，下一次有人
   "顺手重构一下标题" 就可能把「折叠态图标可点」「同标签页跳转」「不接入 tab」
   这三个前提之一改坏，而这类破坏在浏览器里只表现为"点不动"，很难被回归发现。

   【build .164】第三个系统「管理员后台」(/admin/) 接入同一个下拉。本轮变化：
     · SYSTEMS 由 2 项变 3 项（生产 index.html / quality/qa-app.js / admin/admin-app.js **三处副本**）
     · url 正则从「/ 或 /quality/」扩为「/ 或 /quality/ 或 /admin/」
     · 「两处副本 key 一致」扩为「三处副本 key 与 url 全一致」
     · 原 §四 的 PERM_FORMS 断言改为读服务端 PERM_META.forms（员工管理已迁出 index.html），
       并保留「不得硬编码权限键清单」这条**判定意图**（指向 admin/admin-app.js）

   测什么（逐条照设计 §1.2.6d 清单）：
     · SYSTEMS 数组存在且 key/name/url/icon 四字段齐全；含 prod + qa + admin；qa.url === '/quality/'
     · 下拉 DOM 结构：#sysSwitch / #sysSwitchBtn / #sysMenu
     · `▾` 在 <span> 内（折叠态才被既有规则自动隐藏）
     · 无 window.open / target=_blank（sessionStorage 按标签页隔离，新窗口必掉登录态）
     · SYSTEMS 未接入 activeTab（负向：禁止把 'qa' 塞进 TABS/NAV）
     · PERM_META.forms 含 qa:'质量管理'；formToKey('qa') === 'qa'
     · .sidebar 规则行内不含 overflow（守护「absolute 可逃逸 56px」这个前提）

   另加两条本文件自己的交叉守卫（设计未列，但三套 SYSTEMS 副本无其它守护）：
     · index.html / quality/qa-app.js / admin/admin-app.js 的 SYSTEMS **key 集合与 url 全一致**
     · 新增的内联块内**不得**出现主脚本末尾那个自动执行调用（否则 harness 定位漂移）

   运行：node --test tests/qa.systems-switch.test.js
   边界：文本级 + 隔离 vm 求值；不启动浏览器、不启动后端（require 生产后端时路径已指向临时目录）。
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { ROOT, createApp, extractInlineScripts, findMainScript } = require('./harness/sandbox');
const domStub = require('./harness/dom-stub');

const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const QA_APP_SRC = fs.readFileSync(path.join(ROOT, 'quality', 'qa-app.js'), 'utf8');
const ADMIN_APP_SRC = fs.readFileSync(path.join(ROOT, 'admin', 'admin-app.js'), 'utf8');

/* 【build .164】PERM_META 的权威来源：生产后端导出（隔离临时目录，不读不写真实 server/*.json） */
const SRV_TMP = fs.mkdtempSync(path.join(ROOT, '.p1tmp-'));
process.env.PROD_DATA_FILE = path.join(SRV_TMP, 'data.json');
process.env.PROD_USERS_FILE = path.join(SRV_TMP, 'users.json');
fs.writeFileSync(process.env.PROD_USERS_FILE, JSON.stringify([
  { username: 'admin', name: '管理员', role: 'admin', status: 'active', salt: 's0', hash: 'h0', perms: {} }
]));
const srv = require(path.join(ROOT, 'server', 'server.js'));
const PERM_META = srv.PERM_META;
test.after(function () { fs.rmSync(SRV_TMP, { recursive: true, force: true }); });

/** 跨 realm 归一化 */
function plain(v) {
  return JSON.parse(JSON.stringify(v));
}

/** 统计子串出现次数 */
function countOcc(hay, needle) {
  if (!hay || !needle) return 0;
  let n = 0;
  let i = 0;
  while ((i = hay.indexOf(needle, i)) >= 0) { n++; i += needle.length; }
  return n;
}

/** 取出「系统切换下拉」那个内联块的源码（以 var SYSTEMS 为锚点） */
function sysSwitchBlock() {
  const blocks = extractInlineScripts(INDEX_SRC);
  const found = blocks.filter(function (b) { return b.code.indexOf('var SYSTEMS') >= 0; });
  assert.strictEqual(found.length, 1, 'index.html 必须恰有一个含 var SYSTEMS 的内联块');
  return found[0];
}

/** 在隔离 vm 里求值该块，拿到真实的 SYSTEMS 数组（比字符串匹配强得多） */
function evalSysSwitchBlock() {
  const block = sysSwitchBlock();
  const browser = domStub.createBrowserGlobals();
  const sandbox = Object.assign({}, browser.globals, {
    console: { log: function () { }, warn: function () { }, error: function () { }, info: function () { }, debug: function () { } },
  });
  const ctx = vm.createContext(sandbox);
  vm.runInContext(block.code, ctx, { filename: 'index.html#sysSwitch' });
  return { systems: plain(vm.runInContext('SYSTEMS', ctx)), ctx: ctx, browser: browser, block: block };
}

/* ============================================================
   一、SYSTEMS 常量
   ============================================================ */
test('SYSTEMS：数组存在、四字段齐全、含 prod + qa + admin、qa.url === "/quality/"', function () {
  const r = evalSysSwitchBlock();
  const SYSTEMS = r.systems;
  assert.ok(Array.isArray(SYSTEMS), 'SYSTEMS 必须是数组');
  assert.strictEqual(SYSTEMS.length, 3, '本轮恰三个系统（生产 / 质量 / 管理员后台）');

  SYSTEMS.forEach(function (s) {
    assert.deepStrictEqual(Object.keys(s).sort(), ['icon', 'key', 'name', 'url'],
      '每项必须且只能有 key/name/url/icon 四个字段：' + JSON.stringify(s));
    assert.ok(typeof s.key === 'string' && s.key, 'key 必须是非空字符串');
    assert.ok(typeof s.name === 'string' && s.name, 'name 必须是非空字符串');
    assert.ok(/^\/(quality\/|admin\/)?$/.test(s.url), 'url 必须是站内绝对路径（同标签页跳转）：' + s.url);
    assert.ok(typeof s.icon === 'string' && s.icon, 'icon 必须是非空字符串');
  });

  const byKey = {};
  SYSTEMS.forEach(function (s) { byKey[s.key] = s; });
  assert.ok(byKey.prod, '必须含 prod');
  assert.ok(byKey.qa, '必须含 qa');
  assert.ok(byKey.admin, '必须含 admin（.164 新增管理员后台）');
  assert.strictEqual(byKey.prod.url, '/', '生产系统根路径');
  assert.strictEqual(byKey.qa.url, '/quality/', '质量系统必须带尾斜杠（否则多一次 301）');
  assert.strictEqual(byKey.admin.url, '/admin/', '管理员后台必须带尾斜杠（否则相对资源 admin-app.js 解析失败白屏）');
  assert.strictEqual(byKey.prod.name, '生产排单系统');
  assert.strictEqual(byKey.qa.name, '质量系统');
  assert.strictEqual(byKey.admin.name, '管理员后台');
  /* icon 键必须真的在 ICONS 表里有对应 path（漏加 ⇒ 面板项渲染成空图标） */
  const ICONS_BLOCK = INDEX_SRC.slice(INDEX_SRC.indexOf('var ICONS='), INDEX_SRC.indexOf('function svgIcon'));
  assert.ok(ICONS_BLOCK.indexOf('gear:') >= 0, 'index.html 的 ICONS 必须增加 gear（管理员后台图标）');
});

test('SYSTEMS：用 var 声明（禁 const —— 重复声明会让整页白屏）', function () {
  const block = sysSwitchBlock();
  assert.ok(/var\s+SYSTEMS\s*=/.test(block.code), '必须用 var 声明 SYSTEMS');
  assert.strictEqual(/const\s+SYSTEMS\s*=/.test(block.code), false, '不得用 const 声明 SYSTEMS');
  assert.strictEqual(/let\s+SYSTEMS\s*=/.test(block.code), false, '不得用 let 声明 SYSTEMS');
});

test('SYSTEMS：三处同构副本（index.html / quality/qa-app.js / admin/admin-app.js）key 与 url 全一致', function () {
  /* 三处各自维护副本（PRD P0-2 明文不做跨文件共享）⇒ 只能靠断言守住一致性。
     【build .164】由「两处」扩为「三处」：管理后台也有一份下拉清单，缺一处即互相跳不过去。 */
  const r = evalSysSwitchBlock();
  const prodKeys = r.systems.map(function (s) { return s.key; }).sort();
  const byKeyProd = {};
  r.systems.forEach(function (s) { byKeyProd[s.key] = s.url; });

  /* ① 质量系统副本 */
  assert.ok(QA_APP_SRC.indexOf('var SYSTEMS') >= 0, 'qa-app.js 必须有同构副本');
  const m = /var SYSTEMS = (\[[\s\S]*?\]);/.exec(QA_APP_SRC);
  assert.ok(m, 'qa-app.js 的 SYSTEMS 字面量必须可解析');
  const qaSystems = plain(vm.runInNewContext('(' + m[1] + ')'));
  assert.deepStrictEqual(qaSystems.map(function (s) { return s.key; }).sort(), prodKeys,
    '质量系统副本的 key 集合必须与生产一致');
  qaSystems.forEach(function (s) {
    assert.strictEqual(s.url, byKeyProd[s.key], '系统 ' + s.key + ' 质量系统副本 url 必须一致');
  });

  /* ② 管理员后台副本 */
  assert.ok(ADMIN_APP_SRC.indexOf('var SYSTEMS =') >= 0, 'admin-app.js 必须有同构副本');
  const m2 = /var SYSTEMS = (\[[\s\S]*?\]);/.exec(ADMIN_APP_SRC);
  assert.ok(m2, 'admin-app.js 的 SYSTEMS 字面量必须可解析');
  const adminSystems = plain(vm.runInNewContext('(' + m2[1] + ')'));
  assert.deepStrictEqual(adminSystems.map(function (s) { return s.key; }).sort(), prodKeys,
    '管理员后台副本的 key 集合必须与生产一致');
  adminSystems.forEach(function (s) {
    assert.strictEqual(s.url, byKeyProd[s.key], '系统 ' + s.key + ' 管理员后台副本 url 必须一致');
  });
});

/* ============================================================
   二、下拉 DOM 结构与折叠态前提
   ============================================================ */
test('DOM：存在 #sysSwitch / #sysSwitchBtn / #sysMenu 三件套', function () {
  assert.ok(INDEX_SRC.indexOf('id="sysSwitch"') >= 0, '缺 #sysSwitch 容器');
  assert.ok(INDEX_SRC.indexOf('id="sysSwitchBtn"') >= 0, '缺 #sysSwitchBtn（h1 触发器）');
  assert.ok(INDEX_SRC.indexOf('id="sysMenu"') >= 0, '缺 #sysMenu 面板');
  /* h1 仍必须是 h1：.sidebar-header h1 与折叠态规则全靠它命中 */
  assert.ok(/<h1 class="sys-switch-trigger"[^>]*id="sysSwitchBtn"/.test(INDEX_SRC)
    || /<h1[^>]*id="sysSwitchBtn"[^>]*class="sys-switch-trigger"/.test(INDEX_SRC),
    '触发器必须是 <h1 class="sys-switch-trigger" id="sysSwitchBtn">');
  /* 触发器必须绑 onclick（折叠态只剩图标，靠它打开面板） */
  const trigger = INDEX_SRC.slice(INDEX_SRC.indexOf('id="sysSwitchBtn"') - 200, INDEX_SRC.indexOf('id="sysSwitchBtn"') + 400);
  assert.ok(trigger.indexOf('onclick="toggleSysMenu(event)"') >= 0, 'h1 必须绑定 onclick="toggleSysMenu(event)"');
  /* 原 svg 与标题文字必须逐字节保留（不得为了改造而重画图标/改文案） */
  assert.ok(INDEX_SRC.indexOf('<path d="M2 20h20M5 20V8l7-5 7 5v12M9 20v-6h6v6"/>') >= 0, '原房子 svg path 必须保留');
  assert.ok(INDEX_SRC.indexOf('<span>生产排单系统</span>') >= 0, '原标题文字必须原样保留');
  /* 面板必须是 h1 的兄弟（.sys-switch 的子），否则会被「h1 内 span 隐藏」规则误伤 */
  const swIdx = INDEX_SRC.indexOf('id="sysSwitch"');
  const menuIdx = INDEX_SRC.indexOf('id="sysMenu"');
  assert.ok(swIdx > 0 && menuIdx > swIdx, '#sysMenu 必须在 #sysSwitch 之后');
});

test('DOM：▾ 必须包在 <span> 内（折叠态才随既有规则一起隐藏）', function () {
  /* 既有规则：.sidebar.collapsed .sidebar-header h1 span{display:none}
     ⇒ 只有把 ▾ 放进 <span>，折叠态才会自动隐藏箭头，无需另写"折叠时隐藏"的规则 */
  assert.ok(INDEX_SRC.indexOf('<span class="sys-switch-caret">▾</span>') >= 0,
    '▾ 必须在 <span class="sys-switch-caret"> 内');
  const h1Start = INDEX_SRC.indexOf('<h1 class="sys-switch-trigger"');
  const h1End = INDEX_SRC.indexOf('</h1>', h1Start);
  const h1 = INDEX_SRC.slice(h1Start, h1End);
  assert.ok(h1.indexOf('▾') >= 0, '▾ 必须在 h1 内');
  assert.ok(h1.indexOf('<span class="sys-switch-caret">') >= 0, '▾ 必须在 h1 内的 span 里');
  /* svg 不得在 span 内 —— 否则折叠态连图标一起被隐藏，图标就点不到了 */
  const caretIdx = h1.indexOf('<span class="sys-switch-caret">');
  const svgIdx = h1.indexOf('<svg');
  assert.ok(svgIdx >= 0 && svgIdx < caretIdx, 'svg 必须在 caret 之前且不在 caret 的 span 内');
});

test('.sidebar 规则行内不得含 overflow（守护「absolute 面板可逃逸 56px」的前提）', function () {
  /* 面板折叠态要浮到 56px 侧边栏之外，全靠 .sidebar 没有 overflow 裁切。
     若有人给 .sidebar 加 overflow:hidden/auto，面板会被切掉一半 —— 视觉上表现为"点不开"。 */
  const lines = INDEX_SRC.split('\n');
  const hits = lines.filter(function (l) {
    return /^\s*\.sidebar\s*\{/.test(l) || /^\s*\.sidebar\{/.test(l);
  });
  assert.ok(hits.length >= 1, '必须能定位 .sidebar 规则行');
  hits.forEach(function (l) {
    assert.strictEqual(/overflow/.test(l), false, '.sidebar 规则不得含 overflow：' + l.slice(0, 120));
  });
});

test('CSS：9 条以上 .sys-switch*/.sys-menu* 新规则 + 折叠态/移动端覆盖，且不改既有规则', function () {
  const cssStart = INDEX_SRC.indexOf('<style>');
  const cssEnd = INDEX_SRC.indexOf('</style>');
  const css = INDEX_SRC.slice(cssStart, cssEnd);
  assert.ok(css.indexOf('.sys-switch{position:relative}') >= 0, '缺 .sys-switch 定位上下文');
  assert.ok(css.indexOf('.sys-menu{') >= 0, '缺 .sys-menu 基础规则');
  assert.ok(css.indexOf('.sys-menu.show{display:block}') >= 0, '缺 .sys-menu.show 显示规则');
  assert.ok(css.indexOf('.sys-menu-item{') >= 0, '缺 .sys-menu-item 规则');
  assert.ok(css.indexOf('.sys-menu-item.cur') >= 0, '缺当前项高亮规则');
  assert.ok(/\.sidebar\.collapsed \.sys-menu\{left:calc\(100% \+ 6px\)/.test(css),
    '折叠态面板必须在侧边栏右侧浮出（left:calc(100% + 6px)）');
  assert.ok(/@media\(max-width:768px\)\{\.sidebar\.collapsed \.sys-menu\{left:8px/.test(css),
    '移动端抽屉内必须改回向下展开');
  /* 既有规则不得被改：折叠态隐藏 h1 内 span 的那一行必须原样存在 */
  assert.ok(css.indexOf('.sidebar.collapsed .sidebar-header h1 span,.sidebar.collapsed .sidebar-header .sub{display:none}') >= 0,
    '既有折叠态隐藏规则必须逐字节保留');
  /* 不得出现 position:fixed 做面板（移动端 transform 会成为 fixed 包含块，行为相反） */
  const menuRule = /\.sys-menu\{[^}]*\}/.exec(css);
  assert.ok(menuRule, '必须能取出 .sys-menu 规则体');
  assert.strictEqual(/position:fixed/.test(menuRule[0]), false, '.sys-menu 不得用 position:fixed');
  assert.ok(/position:absolute/.test(menuRule[0]), '.sys-menu 必须用 position:absolute');
});

/* ============================================================
   三、交互红线（负向断言）
   ============================================================ */
test('红线：新增块内不得有 window.open / target=_blank（同标签页跳转）', function () {
  const block = sysSwitchBlock();
  assert.strictEqual(countOcc(block.code, 'window.open'), 0, '块内禁 window.open');
  assert.strictEqual(countOcc(block.code, 'target="_blank"'), 0, '块内禁 target=_blank');
  assert.strictEqual(countOcc(block.code, "target='_blank'"), 0, '块内禁 target=_blank');
  assert.ok(block.code.indexOf('location.href=SYSTEMS[i].url') >= 0,
    '必须用 location.href 做同标签页跳转');
});

test('红线：SYSTEMS 未接入 activeTab / TABS / NAV（禁止把质量系统拖进生产单页）', function () {
  const block = sysSwitchBlock();
  assert.strictEqual(countOcc(block.code, 'activeTab'), 0, 'SYSTEMS 块内不得出现 activeTab');
  assert.strictEqual(countOcc(block.code, 'renderContent'), 0, 'SYSTEMS 块内不得出现 renderContent');
  /* 全文负向：不得出现 activeTab==='qa' 这类分支 */
  assert.strictEqual(/activeTab\s*===\s*['"]qa['"]/.test(INDEX_SRC), false, '禁止 activeTab===\'qa\'');
  assert.strictEqual(/activeTab\s*==\s*['"]qa['"]/.test(INDEX_SRC), false, '禁止 activeTab==\'qa\'');
  /* TABS/NAV 定义里不得出现 qa */
  const navStart = INDEX_SRC.indexOf('const NAV=[');
  assert.ok(navStart > 0, '必须能定位 NAV 定义');
  const navEnd = INDEX_SRC.indexOf('];', navStart);
  const navDef = INDEX_SRC.slice(navStart, navEnd);
  assert.strictEqual(/(^|[^A-Za-z_])qa([^A-Za-z_]|$)/.test(navDef), false,
    'NAV 定义里不得出现 qa：' + navDef.slice(0, 200));
});

test('红线：新增内联块内不得出现主脚本的自动执行调用（harness 靠它定位主块）', function () {
  const block = sysSwitchBlock();
  assert.strictEqual(/bootstrap\s*\(\s*\)\s*;/.test(block.code), false,
    'SYSTEMS 块内不得出现自动执行调用');
  /* 全文该调用必须仍恰 1 处（只在主脚本末尾） */
  assert.strictEqual(countOcc(INDEX_SRC, 'bootstrap();'), 1, 'index.html 必须恰有 1 处 bootstrap();');
  /* 主块仍可被正确识别，且仍是那个最长块 */
  const blocks = extractInlineScripts(INDEX_SRC);
  const main = findMainScript(blocks);
  assert.strictEqual(main.code.length, Math.max.apply(null, blocks.map(function (b) { return b.code.length; })),
    '主块仍必须是含自动执行调用的最长块');
  assert.notStrictEqual(main.startLine, block.startLine, '主块不得被认成 SYSTEMS 块');
});

/* ============================================================
   四、权限点（PERM_META.forms.qa）—— 与 qa.perm-qa-key.test.js 互补
   ============================================================ */
test('PERM_META.forms：qa:"质量管理"（第 9 项，排在 transfers 之后）', function () {
  /* 【build .164 读取目标变更】原断言用 createApp().run('PERM_FORMS') 读 index.html 里的常量；
     PERM_FORMS 已随「员工管理」迁出 index.html（该功能整体搬到 admin/），权限清单的权威副本
     改为生产后端 PERM_META（GET /api/perm-meta）。判定尺度**一条未降**：
     仍是「9 个权限点 / qa 在末尾 / 显示名逐字 / 既有 8 项一名不改」，只换了读取来源。 */
  assert.ok(PERM_META && PERM_META.forms, 'server.js 必须导出 PERM_META.forms');
  const forms = Object.keys(PERM_META.forms);
  assert.strictEqual(forms.length, 9, '权限点应为 9 个：' + forms.join(','));
  assert.strictEqual(forms[forms.length - 1], 'qa', 'qa 必须追加在末尾（不打乱既有面板顺序）');
  assert.strictEqual(PERM_META.forms['qa'], '质量管理', '显示名必须是「质量管理」');
  /* 既有 8 项一个都不能少、名字不能变 */
  const expected = {
    products: '产品主数据', parts: '零部件数据', saleOrders: '订单管理·销售订单',
    invOrders: '库存管理·库存订单', dailyPlans: '排产计划', deliveries: '交付计划',
    processTemplates: '工序模板', transfers: '调拨台账', qa: '质量管理',
  };
  Object.keys(expected).forEach(function (k) {
    assert.strictEqual(PERM_META.forms[k], expected[k], k + ' 显示名被改');
  });
});

test('formToKey：qa 原样返回 "qa"（无需改任何权限函数即可接入）', function () {
  const app = createApp({ installRecorder: false });
  assert.strictEqual(app.run("formToKey('qa')"), 'qa');
  /* 既有映射不得被影响 */
  assert.strictEqual(app.run("formToKey('product')"), 'products');
  assert.strictEqual(app.run("formToKey('partLogs')"), 'parts');
  assert.strictEqual(app.run("formToKey('prodPlan')"), 'dailyPlans');
});
