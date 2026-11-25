'use strict';
/* ============================================================
   tests/qa.perm-qa-key.test.js —— 权限点 `qa`（质量管理）的服务端/前端一致性守卫
   ------------------------------------------------------------
   【build .163】为什么必须新建（设计 §1.2.6d）：`qa` 是本轮唯一新增的权限键。
   它的正确性依赖一条**很隐蔽的既有性质**：`formToKey('qa')` 未命中映射表时原样返回
   `'qa'`，于是 `canWriteKey('qa')` 直接查 `perms.qa` —— 也就是说**一行权限函数都不用改**。
   这条性质没有任何显式代码表达，一旦将来有人给 formToKey 加了兜底（比如返回 ''），
   质量系统的写权限会在一夜之间对所有人失效，且前端只会表现成"按钮点了没反应"。

   【build .164 读取目标变更（重要，别当成放宽尺度）】
   .164 把「员工管理」（含权限面板）从生产单页整体迁到独立页面 `admin/`：index.html 里
   的 `PERM_FORMS` 常量**已被删除**，权限清单的**权威副本**改为生产后端的
   `PERM_META`（`GET /api/perm-meta` 下发给管理员后台）。因此本文件里所有
   `PERM_FORMS` 断言改为读 `require('server/server.js').PERM_META`，
   「两处 UI 从 PERM_FORMS 派生」改为指向 `admin/admin-app.js` 从 `meta.forms` 派生。
   **判定尺度一条未降**：键集合/顺序、显示名、9 项、qa 追加在末尾、不得硬编码权限键清单
   等全部原样保留；`formToKey('qa')==='qa'`、`canWriteKey('qa')`、`canAct('qa.del')`
   等**生产侧判定一条未删**（这三者仍留在 index.html）。

   测什么（设计 T03 清单逐条）：
     · PERM_META.forms 含 qa:'质量管理'（第 9 项，排在 transfers 之后）
     · formToKey('qa') === 'qa'
     · 负向：PERM_META.acts 不注册 qa（本轮不注册动作键）
     · canWriteKey('qa')：perms.qa===true → true；perms={} → false；role==='admin' → true
     · 「qa 反查不到承载表单」⇒ 管理员后台右栏走"该表单无独立业务动作按钮"且三态函数不崩
     · canAct('qa.del') 的两种口径（宽松期放行 / acts 已固化则默认拒绝 = P1 的安全默认）
     · 管理员后台两处 UI 由 meta.forms 派生（左栏复选框、列表「表单写权限」列），不得硬编码
     · 服务端 STAFF_PERMS 不含 qa ⇒ 新建员工默认只读（与前端口径一致）

   运行：node --test tests/qa.perm-qa-key.test.js
   边界：只测权限判定与表单键映射；**不启动 HTTP 服务**。
        require 生产后端时数据/用户文件路径已指向仓库内临时目录（不读不写真实 server/*.json）。
   ============================================================ */

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { ROOT, createApp } = require('./harness/sandbox');

const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');
const ADMIN_APP_SRC = fs.readFileSync(path.join(ROOT, 'admin', 'admin-app.js'), 'utf8');

/* 【build .164】权限元数据的权威来源：生产后端导出 PERM_META。
   照 tests/server.canwrite.test.js 的隔离做法 —— 先把数据/用户文件指向仓库内临时目录再 require，
   确保本文件既不读也不写真实的 server/data.json · server/users.json。 */
const SRV_TMP = fs.mkdtempSync(path.join(ROOT, '.p1tmp-'));
process.env.PROD_DATA_FILE = path.join(SRV_TMP, 'data.json');
process.env.PROD_USERS_FILE = path.join(SRV_TMP, 'users.json');
fs.writeFileSync(process.env.PROD_USERS_FILE, JSON.stringify([
  { username: 'admin', name: '管理员', role: 'admin', status: 'active', salt: 's0', hash: 'h0', perms: {} }
]));
const srv = require(path.join(ROOT, 'server', 'server.js'));
const PERM_META = srv.PERM_META;

after(function () { fs.rmSync(SRV_TMP, { recursive: true, force: true }); });

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
   一、PERM_META.forms：键与显示名
   ============================================================ */
test('PERM_META.forms 含 qa:"质量管理"，且既有 8 项一名不改（权威来源改为生产后端）', function () {
  assert.ok(PERM_META && PERM_META.forms, 'server.js 必须导出 PERM_META.forms');
  assert.strictEqual(PERM_META.forms.qa, '质量管理');
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
    assert.strictEqual(PERM_META.forms[k], expected[k], 'PERM_META.forms[' + k + '] 显示名不符');
  });
  /* 键集合与顺序必须完全一致（qa 追加在末尾 ⇒ 管理员后台面板顺序与生产原实现一致） */
  assert.deepStrictEqual(Object.keys(PERM_META.forms), Object.keys(expected),
    '键集合与顺序必须完全一致（qa 追加在末尾）');
  assert.strictEqual(Object.keys(PERM_META.forms).length, 9, '权限点应为 9 个');
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
  /* 【build .164 新增】服务端 PERM_META.formKeys 必须与生产 formToKey 的映射表**逐键一致**
     （管理员后台用 formKeys 做权限键→表单键反查，两侧漂移会让后台与按钮 gate 说不同的话） */
  Object.keys(existing).forEach(function (k) {
    assert.strictEqual(PERM_META.formKeys[k], existing[k], 'PERM_META.formKeys[' + k + '] 与 formToKey 不一致');
  });
  assert.deepStrictEqual(Object.keys(PERM_META.formKeys), Object.keys(existing),
    'PERM_META.formKeys 的键集合必须与 formToKey 映射表完全一致（12 项）');
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
   三、负向：本轮不注册动作键 acts.qa
   ============================================================ */
test('PERM_META.acts 不得有 qa 承载（本轮不注册动作键，避免出现控制不了任何按钮的勾选框）', function () {
  /* 【build .164】生产 FORM_ACTS 仍留在 index.html（按钮 gate 运行时用），照旧断言； */
  const app = createApp({ installRecorder: false, quietConsole: true });
  assert.strictEqual(app.run("typeof FORM_ACTS['qa']"), 'undefined',
    'FORM_ACTS.qa 必须不存在；P1 上线删除功能时再加 { del:"删除异常记录" }');
  assert.strictEqual(app.run("Object.prototype.hasOwnProperty.call(FORM_ACTS,'qa')"), false);
  assert.strictEqual(app.run("typeof FORM_ACTS['prodPlan']"), 'object');
  assert.strictEqual(app.run("typeof FORM_ACTS['parts']"), 'object');

  /* 【build .164】再守权威副本：服务端 PERM_META.acts 也不得注册 qa（两侧必须同口径） */
  assert.strictEqual(Object.prototype.hasOwnProperty.call(PERM_META.acts, 'qa'), false,
    'PERM_META.acts 不得注册 qa 动作键');
  const actForms = Object.keys(PERM_META.acts);
  actForms.forEach(function (fk) {
    assert.ok(PERM_META.formKeys[fk], 'PERM_META.acts 的键必须是已知表单键：' + fk);
    assert.notStrictEqual(PERM_META.formKeys[fk], 'qa', 'qa 权限点不得挂动作键（实际由 ' + fk + ' 挂上）');
  });
});

test('qa 权限点反查不到承载表单 ⇒ 管理员后台右栏走「该表单无独立业务动作按钮」且三态函数不崩', function () {
  /* 【build .164 读取目标变更】原断言直接 `app.run("permFormKeyOf('qa')")`；
     permFormKeyOf 已随员工面板迁到 admin/admin-app.js（生产单页只剩按钮 gate，不需要它）。
     判定意图（qa 反查不到承载表单 ⇒ 后台右栏走兜底文案）不变，改为从**权威数据**验证：
     meta.acts 里没有任何表单键的 formKeys 映射到 qa。这比原来更硬 ——
     原判据只证明「当时那个函数返回 null」，新判据证明「数据层面就不可能反查到」。 */
  const actForms = Object.keys(PERM_META.acts);
  const hit = actForms.filter(function (fk) { return PERM_META.formKeys[fk] === 'qa'; });
  assert.deepStrictEqual(hit, [], 'qa 必须反查不到承载表单');
  /* 既有权限点仍能反查到承载表单（回归：别为了加 qa 把反查逻辑改坏） */
  const rev = {};
  actForms.forEach(function (fk) { rev[PERM_META.formKeys[fk]] = fk; });
  assert.strictEqual(rev.products, 'product');
  assert.strictEqual(rev.dailyPlans, 'prodPlan');
  assert.strictEqual(rev.parts, 'parts');
  /* 后台侧：两处三态函数必须真的存在（否则点 qa 就崩面板） */
  assert.ok(/function recomputePermTri\s*\(/.test(ADMIN_APP_SRC), 'admin-app.js 必须有 recomputePermTri');
  assert.ok(/function permTriToggle\s*\(/.test(ADMIN_APP_SRC), 'admin-app.js 必须有 permTriToggle');
  /* 且 recomputePermTri 对「反查不到承载表单」的权限点必须有早退守卫 */
  assert.ok(/if\s*\(!fm\)\s*return;/.test(ADMIN_APP_SRC), 'recomputePermTri 必须先判 fm 再动 DOM');
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
   四、单一来源：管理员后台两处 UI 必须从 meta.forms 派生，不得硬编码
   ============================================================ */
test('管理员后台两处 UI 均由 meta.forms 派生（加权限点不需要改任何渲染函数）', function () {
  /* 左栏：Object.keys(meta.forms).map → input[data-perm] */
  assert.ok(ADMIN_APP_SRC.indexOf('Object.keys(META.forms).map') >= 0
    || ADMIN_APP_SRC.indexOf('Object.keys(meta.forms).map') >= 0,
    '左栏复选框必须由 Object.keys(meta.forms).map 生成');
  /* 收集：querySelectorAll('#modal input[data-perm]') */
  assert.ok(ADMIN_APP_SRC.indexOf('input[data-perm]') >= 0,
    'saveUser 必须按 data-perm 统一收集，不得逐键取值');
  /* 列表「表单写权限」列：Object.keys(meta.forms).filter */
  assert.ok(/Object\.keys\(meta\.forms\)\.filter/.test(ADMIN_APP_SRC),
    '列表「表单写权限」列必须由 Object.keys(meta.forms).filter 生成');
  /* 负向：不得存在硬编码权限键清单（否则加权限点会漏渲染）。
     原判据 `/'products','parts','saleOrders'/` 指向 index.html；.164 起同一判定施加到
     管理员后台源码（页面级同款负向断言），并保留对 index.html 的原有负向断言。 */
  assert.strictEqual(/'products','parts','saleOrders'/.test(ADMIN_APP_SRC), false,
    '管理员后台不得硬编码权限键清单（必须从 meta.forms 派生）');
  assert.strictEqual(/'products','parts','saleOrders'/.test(INDEX_SRC), false,
    'index.html 不得硬编码权限键清单（历史上就禁止，本条原样保留）');
  /* 负向加强：后台源码里不得出现第二份权限清单字面量（如 forms:{...} 自建副本） */
  assert.strictEqual(/forms\s*:\s*\{\s*products\s*:/.test(ADMIN_APP_SRC), false,
    'admin-app.js 不得自建第二份权限清单字面量');
});

/* ============================================================
   五、服务端口径对齐：STAFF_PERMS 不含 qa ⇒ 新建员工默认只读
   ============================================================ */
test('管理员后台：qa 行显示「质量管理」，右栏走「该表单无独立业务动作按钮」兜底', function () {
  /* 左栏行标题取 META.forms[k]（单一来源 ⇒ 加 qa 自动出现第 9 行「质量管理」） */
  assert.ok(/\+\s*esc\(META\.forms\[k\]\)\s*\+/.test(ADMIN_APP_SRC), '左栏行标题必须取 META.forms[k]');
  /* 右栏兜底文案必须在，且由 fmKey 为空触发（qa 没有 acts 键 ⇒ 必然走这条） */
  assert.ok(ADMIN_APP_SRC.indexOf('该表单无独立业务动作按钮') >= 0,
    '右栏必须有「该表单无独立业务动作按钮」兜底文案');
  assert.ok(/var acts = fmKey \? Object\.keys\(META\.acts\[fmKey\]\) : \[\]/.test(ADMIN_APP_SRC),
    '右栏动作列表必须是「fmKey 存在才取 meta.acts」的三元兜底');
  /* 前提：qa 确实反查不到承载表单（否则兜底不成立） */
  const actForms = Object.keys(PERM_META.acts);
  assert.strictEqual(actForms.some(function (fk) { return PERM_META.formKeys[fk] === 'qa'; }), false,
    'qa 必须反查不到承载表单');
  /* 左栏「动作▸」角标对 qa 必须不出现（hasActs=false） */
  assert.ok(/var hasActs = !!fmKey/.test(ADMIN_APP_SRC), '左栏「动作▸」角标必须由 hasActs 决定');
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
