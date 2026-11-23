'use strict';
/* ============================================================
   tests/qa.perm-qa-key.test.js —— 权限点 `qa`（质量管理）的服务端/前端一致性守卫
   ------------------------------------------------------------
   【build .163】为什么必须新建（设计 §1.2.6d）：`qa` 是本轮唯一新增的权限键。
   它的正确性依赖一条**很隐蔽的既有性质**：`formToKey('qa')` 未命中映射表时原样返回
   `'qa'`，于是 `canWriteKey('qa')` 直接查 `perms.qa` —— 也就是说**一行权限函数都不用改**。
   这条性质没有任何显式代码表达，一旦将来有人给 formToKey 加了兜底（比如返回 ''），
   质量系统的写权限会在一夜之间对所有人失效，且前端只会表现成"按钮点了没反应"。

   测什么（设计 T03 清单逐条）：
     · PERM_FORMS 含 qa:'质量管理'
     · formToKey('qa') === 'qa'
     · PERM_FORMS['qa'] === '质量管理'
     · 负向：FORM_ACTS['qa'] === undefined（本轮不注册动作键）
     · canWriteKey('qa')：perms.qa===true → true；perms={} → false；role==='admin' → true

   另加（设计未列，但同属这条权限链的守卫）：
     · permFormKeyOf('qa') === null ⇒ 员工面板右栏显示"该表单无独立业务动作按钮"且三态函数不崩
     · canAct('qa.del') 的两种口径（宽松期放行 / acts 已固化则默认拒绝 = P1 的安全默认）
     · PERM_FORMS 是两处 UI（左栏复选框、列表「表单写权限」列）的**唯一**来源，不得硬编码 8 项
     · 服务端 STAFF_PERMS 不含 qa ⇒ 新建员工默认只读（与前端口径一致）

   运行：node --test tests/qa.perm-qa-key.test.js
   边界：只测权限判定与表单键映射；**不启动 HTTP 服务**、**不 require 生产后端**（只读其源码文本）。
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { ROOT, createApp } = require('./harness/sandbox');

const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');

/**
 * 造一个 currentUser 并装进沙箱（currentUser 是 let 词法绑定 ⇒ 必须用 setGlobal）。
 * @param {{role: string, perms: object}} u
 */
function appWith(u) {
  const app = createApp({ installRecorder: false, quietConsole: true });
  app.setGlobal('currentUser', {
    username: u.username || 'u1',
    name: u.name || '测试用户',
    role: u.role || 'staff',
    status: 'active',
    perms: u.perms || {},
  });
  return app;
}

/* ============================================================
   一、PERM_FORMS：键与显示名
   ============================================================ */
test('PERM_FORMS 含 qa:"质量管理"，且既有 8 项一名不改', function () {
  const app = createApp({ installRecorder: false, quietConsole: true });
  assert.strictEqual(app.run("PERM_FORMS['qa']"), '质量管理');
  const expected = {
    products: '产品主数据',
    parts: '零部件数据',
    saleOrders: '订单管理·销售订单',
    invOrders: '库存管理·库存订单',
    dailyPlans: '排产计划',
    deliveries: '交付计划',
    processTemplates: '工序模板',
    transfers: '调拨台账',
    qa: '质量管理',
  };
  Object.keys(expected).forEach(function (k) {
    assert.strictEqual(app.run('PERM_FORMS[' + JSON.stringify(k) + ']'), expected[k],
      'PERM_FORMS[' + k + '] 显示名不符');
  });
  const keys = JSON.parse(JSON.stringify(app.run('Object.keys(PERM_FORMS)')));
  assert.deepStrictEqual(keys, Object.keys(expected), '键集合与顺序必须完全一致（qa 追加在末尾）');
});

test('formToKey("qa") 原样返回 "qa" —— 这是「不改任何权限函数即可接入」的关键性质', function () {
  const app = createApp({ installRecorder: false, quietConsole: true });
  assert.strictEqual(app.run("formToKey('qa')"), 'qa');
  /* 关键：formToKey 对未知键必须原样返回（不是兜底成 '' 或 undefined） */
  assert.strictEqual(app.run("formToKey('__not_exists__')"), '__not_exists__',
    'formToKey 对未知键必须原样返回（质量系统写权限全靠这条）');
  /* 既有映射不受影响 */
  const existing = {
    product: 'products', order_frame: 'saleOrders', order_inv: 'invOrders',
    delivery: 'deliveries', prodPlan: 'dailyPlans', processTpl: 'processTemplates',
    fields: 'fields', report: 'report', logs: 'logs', transfers: 'transfers',
    parts: 'parts', partLogs: 'parts',
  };
  Object.keys(existing).forEach(function (k) {
    assert.strictEqual(app.run('formToKey(' + JSON.stringify(k) + ')'), existing[k], 'formToKey(' + k + ') 变了');
  });
});

/* ============================================================
   二、写权限判定 canWriteKey('qa')
   ============================================================ */
test('canWriteKey("qa")：perms.qa===true → true', function () {
  const app = appWith({ role: 'staff', perms: { qa: true } });
  assert.strictEqual(app.run("canWriteKey('qa')"), true);
  assert.strictEqual(app.run("canWriteForm('qa')"), true, 'canWriteForm 走 formToKey 后必须一致');
});

test('canWriteKey("qa")：perms 无 qa 键 → false（存量员工上线首日一律只读）', function () {
  const empty = appWith({ role: 'staff', perms: {} });
  assert.strictEqual(empty.run("canWriteKey('qa')"), false);
  assert.strictEqual(empty.run("canWriteForm('qa')"), false);

  /* 有其它权限但**没有** qa ⇒ 仍然只读（不得被其它键带开） */
  const other = appWith({
    role: 'staff',
    perms: { products: true, saleOrders: true, invOrders: true, dailyPlans: true, deliveries: true, transfers: true, parts: true },
  });
  assert.strictEqual(other.run("canWriteKey('qa')"), false, '其它权限点不得顺带开质量系统写权限');
  assert.strictEqual(other.run("canWriteKey('products')"), true, '前提：其它权限确实生效');
});

test('canWriteKey("qa")：role==="admin" → true（管理员恒放行）', function () {
  const admin = appWith({ role: 'admin', perms: {} });
  assert.strictEqual(admin.run("canWriteKey('qa')"), true);
  assert.strictEqual(admin.run("canWriteForm('qa')"), true);
});

test('canWriteKey("qa")：perms.qa 必须是严格 true（"yes"/1/"true" 一律不放行）', function () {
  ['"yes"', '1', '"true"', 'null', 'undefined'].forEach(function (v) {
    const app = appWith({ role: 'staff', perms: { qa: true } });
    app.setGlobal('currentUser', { username: 'u2', role: 'staff', status: 'active', perms: {} });
    /* 用 vm 内求值构造非严格布尔值，避免宿主/上下文对象互转 */
    app.run('currentUser.perms = { qa: ' + v + ' };');
    assert.strictEqual(app.run("canWriteKey('qa')"), false, 'perms.qa=' + v + ' 不得放行');
  });
  /* 未登录 ⇒ 一律 false */
  const anon = createApp({ installRecorder: false, quietConsole: true });
  anon.setGlobal('currentUser', null);
  assert.strictEqual(anon.run("canWriteKey('qa')"), false, '未登录必须 false');
});

/* ============================================================
   三、负向：本轮不注册动作键 FORM_ACTS.qa
   ============================================================ */
test('FORM_ACTS 不得有 qa 键（本轮不注册动作键，避免出现控制不了任何按钮的勾选框）', function () {
  const app = createApp({ installRecorder: false, quietConsole: true });
  assert.strictEqual(app.run("typeof FORM_ACTS['qa']"), 'undefined',
    'FORM_ACTS.qa 必须不存在；P1 上线删除功能时再加 { del:"删除异常记录" }');
  assert.strictEqual(app.run("Object.prototype.hasOwnProperty.call(FORM_ACTS,'qa')"), false);
  /* 既有动作键不受影响（抽查两个） */
  assert.strictEqual(app.run("typeof FORM_ACTS['prodPlan']"), 'object');
  assert.strictEqual(app.run("typeof FORM_ACTS['parts']"), 'object');
});

test('permFormKeyOf("qa") === null ⇒ 员工面板右栏走「该表单无独立业务动作按钮」且三态函数不崩', function () {
  const app = createApp({ installRecorder: false, quietConsole: true });
  assert.strictEqual(app.run("permFormKeyOf('qa')"), null);
  /* 既有权限点仍能反查到承载表单（回归：别为了加 qa 把反查逻辑改坏） */
  assert.strictEqual(app.run("permFormKeyOf('products')"), 'product');
  assert.strictEqual(app.run("permFormKeyOf('dailyPlans')"), 'prodPlan');
  assert.strictEqual(app.run("permFormKeyOf('parts')"), 'parts');
  /* 三态重算与勾选切换在 fm 为 null 时必须有守卫（否则点 qa 就崩面板） */
  assert.strictEqual(app.run('typeof recomputePermTri'), 'function');
  assert.strictEqual(app.run('typeof permTriToggle'), 'function');
});

test('canAct("qa.del")：宽松期放行 / acts 已固化则默认拒绝（P1 的安全默认）', function () {
  /* acts 未配置 ⇒ 既有宽松期口径放行（等价"管理员还没逐个收权"） */
  const lenient = appWith({ role: 'staff', perms: { qa: true } });
  assert.strictEqual(lenient.run("canAct('qa.del')"), true, 'acts 未配置时沿用宽松期口径');

  /* acts 已存在但没有 qa.del ⇒ false（管理员保存过权限面板后的既成事实）
     这是 P1 上线删除功能时的**安全默认**：已固化员工默认无删除权，需管理员重新勾选 */
  const fixed = appWith({ role: 'staff', perms: { qa: true, acts: { product: { genOrder: true } } } });
  assert.strictEqual(fixed.run("canAct('qa.del')"), false, 'acts 已固化但无 qa.del ⇒ 必须拒绝');

  /* 管理员恒 true */
  const admin = appWith({ role: 'admin', perms: { acts: {} } });
  assert.strictEqual(admin.run("canAct('qa.del')"), true);
});

/* ============================================================
   四、单一来源：两处 UI 必须从 PERM_FORMS 派生，不得硬编码
   ============================================================ */
test('员工面板两处 UI 均从 PERM_FORMS 派生（加 qa 不需要改任何渲染函数）', function () {
  /* 左栏：Object.keys(PERM_FORMS).map → input[data-perm] */
  assert.ok(INDEX_SRC.indexOf('Object.keys(PERM_FORMS).map') >= 0,
    '左栏复选框必须由 Object.keys(PERM_FORMS).map 生成');
  /* 收集：querySelectorAll('#modal input[data-perm]') */
  assert.ok(INDEX_SRC.indexOf("input[data-perm]") >= 0,
    'saveUser 必须按 data-perm 统一收集，不得逐键取值');
  /* 列表「表单写权限」列：Object.keys(PERM_FORMS).filter */
  assert.ok(/Object\.keys\(PERM_FORMS\)\.filter/.test(INDEX_SRC),
    '列表「表单写权限」列必须由 Object.keys(PERM_FORMS).filter 生成');
  /* 负向：不得存在硬编码 8 项的权限数组（否则加 qa 会漏渲染） */
  assert.strictEqual(/'products','parts','saleOrders'/.test(INDEX_SRC), false,
    '不得硬编码权限键清单（必须从 PERM_FORMS 派生）');
});

/* ============================================================
   五、服务端口径对齐：STAFF_PERMS 不含 qa ⇒ 新建员工默认只读
   ============================================================ */
test('员工面板：qa 行显示「质量管理」，右栏走「该表单无独立业务动作按钮」兜底', function () {
  /* 左栏行标题取 PERM_FORMS[k]（单一来源 ⇒ 加 qa 自动出现第 9 行「质量管理」） */
  assert.ok(/\+\s*PERM_FORMS\[k\]\s*\+/.test(INDEX_SRC), '左栏行标题必须取 PERM_FORMS[k]');
  /* 右栏兜底文案必须在，且由 fmKey 为空触发（qa 没有 FORM_ACTS 键 ⇒ 必然走这条） */
  assert.ok(INDEX_SRC.indexOf('该表单无独立业务动作按钮') >= 0, '右栏必须有「该表单无独立业务动作按钮」兜底文案');
  assert.ok(/const acts=fmKey\?Object\.keys\(FORM_ACTS\[fmKey\]\):\[\]/.test(INDEX_SRC),
    '右栏动作列表必须是「fmKey 存在才取 FORM_ACTS」的三元兜底');
  /* 前提：qa 确实反查不到承载表单（否则兜底不成立） */
  const app = createApp({ installRecorder: false, quietConsole: true });
  assert.strictEqual(app.run("permFormKeyOf('qa')"), null, 'qa 必须反查不到承载表单');
  /* 左栏「动作▸」角标对 qa 必须不出现（hasActs=false） */
  assert.ok(/const hasActs=!!fmKey/.test(INDEX_SRC), '左栏「动作▸」角标必须由 hasActs 决定');
});

test('server.js 的 STAFF_PERMS 不含 qa（新建员工默认只读，与前端口径一致）', function () {
  const m = /const\s+STAFF_PERMS\s*=\s*\{([\s\S]*?)\}/.exec(SERVER_SRC);
  assert.ok(m, '必须能在 server.js 中定位 STAFF_PERMS');
  const body = m[1];
  assert.strictEqual(/(^|[^A-Za-z_])qa([^A-Za-z_]|$)/.test(body), false,
    'STAFF_PERMS 不得含 qa：新员工默认只读，须管理员逐个勾选（PRD 7.1 上线操作）');
  /* 前提校验：STAFF_PERMS 确实存在且非空（否则上面的负向断言会变成恒真） */
  assert.ok(body.indexOf('products') >= 0, 'STAFF_PERMS 应含既有权限键（负向断言的前提）');
});
