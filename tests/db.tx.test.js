'use strict';
/* ================================================================
   tests/db.tx.test.js —— 前端事务客户端 DB.tx / saveMulti / DB.set 零回归（T01）
   ================================================================
   被测：**生产** index.html 的 DB 层（不用 recorder，用真 DB.tx + fetch 桩），覆盖设计 §3.1 / §3.4：
     200 → 返回 true、用响应 revs 刷新 serverRevs、同步 serverData
     409 → pullAll + alert + 返回 false（**不做自动合并/自动重试**，.123 口径）
     403 / 400 / 500 → pullAll 或提示 + 返回 false
     网络异常 → 提示 + false；401 → apiReq 内置 showLogin，DB.tx 不重复提示
     空 ops → true 且不发请求；本地模式（API_BASE=''）→ 落 localStorage 且不崩
   另含 DB.set 零回归（T01 承诺 DB.set 一字未改：单键 /save + expectedRev 409 语义）。
   运行：node --test（**不要用 node -e**，见 README「执行环境限定」）
   ================================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('./harness/sandbox');
const { createFetchStub } = require('./harness/dom-stub');

function plain(v) {
  return JSON.parse(JSON.stringify(v));
}

/** 建一个用生产 DB 层的沙箱（不挂 recorder），并注入 fetch 桩 */
function makeApp(routes, opts) {
  const options = opts || {};
  const app = createApp({
    installRecorder: false,
    transformMain: options.transformMain,
  });
  const stub = createFetchStub(routes);
  app.setFetch(stub);
  app.setGlobals({
    authToken: 'tok-1',
    serverData: options.serverData === undefined ? { orders: [{ id: 'OLD' }] } : options.serverData,
    serverRevs: options.serverRevs || { orders: 3, transfers: 7 },
  });
  return { app, stub };
}

test('DB.tx 200：一次 POST /api/tx、带 Bearer 头、按响应 revs 刷新本地 rev、同步 serverData', async () => {
  const { app, stub } = makeApp({
    '/api/tx': { status: 200, body: { ok: true, revs: { orders: 4, transfers: 8, products: 1 } } },
  });
  app.setGlobals({ orders: [{ id: 'NEW' }], transfers: [{ id: 'TR1' }], products: [] });

  const ok = await app.run(
    'DB.tx([{key:"orders",value:orders},{key:"transfers",value:transfers},{key:"products",value:products}], true)'
  );
  assert.equal(ok, true);
  assert.equal(stub.calls.length, 1, '必须只有一次请求');
  assert.equal(stub.calls[0].path, '/api/tx');
  assert.equal(stub.calls[0].opts.method, 'POST');
  /* 鉴权只走 Authorization 头，不得拼 ?token=（.123 已废止） */
  assert.equal(stub.calls[0].opts.headers['Authorization'], 'Bearer tok-1');
  assert.equal(/token=/.test(stub.calls[0].path), false);
  assert.equal(stub.calls[0].opts.headers['Content-Type'], 'application/json');
  /* ops 与 expectedRev（缺省取本地 serverRevs） */
  assert.deepEqual(plain(stub.calls[0].body.ops.map((o) => o.key)), ['orders', 'transfers', 'products']);
  assert.deepEqual(plain(stub.calls[0].body.ops.map((o) => o.expectedRev)), [3, 7, 0]);
  /* revs 刷新（否则下一次提交会立刻误报 409） */
  assert.deepEqual(plain(app.getGlobal('serverRevs')), { orders: 4, transfers: 8, products: 1 });
  /* serverData 同步 */
  assert.deepEqual(plain(app.getGlobal('serverData').orders), [{ id: 'NEW' }]);
});

test('DB.tx 空 ops / 非法输入：无有效 op 时不发请求；有则过滤掉非法项后照常提交', async () => {
  const { app, stub } = makeApp({
    '/api/tx': { status: 200, body: { ok: true, revs: { orders: 4 } } },
  });
  assert.equal(await app.run('DB.tx([], true)'), true);
  assert.equal(await app.run('DB.tx(null, true)'), true);
  assert.equal(await app.run('DB.tx("nope", true)'), true);
  assert.equal(await app.run('DB.tx([{value:1},null,{key:""}], true)'), true);
  assert.equal(stub.calls.length, 0, '无有效 op 不得发请求');
  /* 混合输入：非法项被过滤，仅提交合法 op */
  assert.equal(await app.run('DB.tx([{value:1},{key:"orders",value:2}], true)'), true);
  assert.equal(stub.calls.length, 1);
  assert.deepEqual(plain(stub.calls[0].body.ops), [{ key: 'orders', value: 2, expectedRev: 3 }]);
});

test('DB.tx 409：pullAll 复原 + alert + 返回 false（不做自动重试）', async () => {
  const { app, stub } = makeApp({
    '/api/tx': { status: 409, body: { error: 'rev conflict', conflicts: ['orders'] } },
    '/api/data': { status: 200, body: { data: { orders: [{ id: 'SERVER' }] }, revs: { orders: 9, transfers: 7 } } },
  });
  app.setGlobals({ orders: [{ id: 'DIRTY' }] });

  const ok = await app.run('DB.tx([{key:"orders",value:orders}], false)');
  assert.equal(ok, false);
  assert.deepEqual(
    plain(stub.calls.map((c) => c.path)),
    ['/api/tx', '/api/data'],
    '失败后必须 pullAll（仅一次，且不得自动重发 tx）'
  );
  assert.equal(app.alerts.length, 1);
  assert.match(app.alerts[0], /数据已被他人修改/);
  assert.match(app.alerts[0], /未生效/);
  /* pullAll 已把服务器真值刷进缓存与 revs */
  assert.deepEqual(plain(app.getGlobal('serverRevs')), { orders: 9, transfers: 7 });
  assert.deepEqual(plain(app.getGlobal('serverData').orders), [{ id: 'SERVER' }]);
});

test('DB.tx 403：pullAll + alert + false', async () => {
  const { app, stub } = makeApp({
    '/api/tx': { status: 403, body: { error: 'no permission' } },
    '/api/data': { status: 200, body: { data: {}, revs: { orders: 1 } } },
  });
  assert.equal(await app.run('DB.tx([{key:"transfers",value:[]}], false)'), false);
  assert.deepEqual(plain(stub.calls.map((c) => c.path)), ['/api/tx', '/api/data']);
  assert.equal(app.alerts.length, 1);
  assert.match(app.alerts[0], /权限/);
});

test('DB.tx 400：提示服务端 error + false（未知表）', async () => {
  const { app } = makeApp({
    '/api/tx': { status: 400, body: { error: '未知数据表' } },
    '/api/data': { status: 200, body: { data: {}, revs: {} } },
  });
  assert.equal(await app.run('DB.tx([{key:"nope",value:1}], false)'), false);
  assert.equal(app.alerts.length, 1);
  assert.match(app.alerts[0], /400/);
  assert.match(app.alerts[0], /未知数据表/);
});

test('DB.tx 500：pullAll + 提示 + false（落盘失败一字不写）', async () => {
  const { app, stub } = makeApp({
    '/api/tx': { status: 500, body: { error: '持久化失败' } },
    '/api/data': { status: 200, body: { data: { orders: [{ id: 'SERVER' }] }, revs: { orders: 2 } } },
  });
  app.setGlobals({ orders: [{ id: 'DIRTY' }] });
  assert.equal(await app.run('DB.tx([{key:"orders",value:orders}], false)'), false);
  assert.deepEqual(plain(stub.calls.map((c) => c.path)), ['/api/tx', '/api/data']);
  assert.equal(app.alerts.length, 1);
  assert.match(app.alerts[0], /500/);
  assert.deepEqual(plain(app.getGlobal('serverRevs')), { orders: 2 });
});

test('DB.tx 网络异常：提示「网络异常」+ false', async () => {
  const { app } = makeApp(function (path) {
    throw new Error('ECONNREFUSED');
  });
  assert.equal(await app.run('DB.tx([{key:"orders",value:[]}], false)'), false);
  assert.equal(app.alerts.length >= 1, true);
  assert.match(app.alerts.join('\n'), /网络异常/);
});

test('DB.tx silent=true：失败不弹窗（避免「主业务已成功」时的假告警）', async () => {
  const { app } = makeApp({
    '/api/tx': { status: 409, body: {} },
    '/api/data': { status: 200, body: { data: {}, revs: { orders: 5 } } },
  });
  assert.equal(await app.run('DB.tx([{key:"orders",value:[]}], true)'), false);
  assert.equal(app.alerts.length, 0, 'silent 下不得弹窗');
  assert.deepEqual(plain(app.getGlobal('serverRevs')), { orders: 5 }, 'silent 仍须 pullAll 刷新 rev');
});

test('DB.tx 401：apiReq 已弹登录框，DB.tx 返回 false 且不重复提示', async () => {
  const { app } = makeApp({ '/api/tx': { status: 401, body: { error: 'unauthorized' } } });
  const ok = await app.run('DB.tx([{key:"orders",value:[]}], false)');
  assert.equal(ok, false);
  assert.equal(app.alerts.length, 0, '401 由 showLogin 处理，不应再有 alert');
  /* showLogin 会向 document.body 挂登录框（dom-stub 下 getElementById 返回 null，故走新建分支） */
  assert.equal(app.browser.document.body.children.length >= 1, true, 'showLogin 应被触发');
});

test('DB.tx 本地模式（API_BASE=\'\'）：落 localStorage 且返回 true，不发请求', async () => {
  const { app, stub } = makeApp({}, {
    transformMain: (code) => code.replace("const API_BASE='/api';", "const API_BASE='';"),
  });
  assert.equal(app.getGlobal('API_BASE'), '', '本地模式改写应生效');
  const ok = await app.run('DB.tx([{key:"orders",value:[{id:"L1"}]},{key:"transfers",value:[]}], true)');
  assert.equal(ok, true);
  assert.equal(stub.calls.length, 0);
  assert.deepEqual(JSON.parse(app.localStorage.getItem('wb_cb_prod_orders')), [{ id: 'L1' }]);
  assert.deepEqual(JSON.parse(app.localStorage.getItem('wb_cb_prod_transfers')), []);
});

test('saveMulti：[[k,v],...] 恰好转成一次 DB.tx 的 ops', async () => {
  const { app, stub } = makeApp({
    '/api/tx': { status: 200, body: { ok: true, revs: { orders: 4, products: 1 } } },
  });
  app.setGlobals({ orders: [{ id: 'A' }], products: [{ id: 'P', stock: 5 }] });
  const ok = await app.run('saveMulti([["orders",orders],["products",products]], false)');
  assert.equal(ok, true);
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].path, '/api/tx');
  assert.deepEqual(plain(stub.calls[0].body.ops.map((o) => o.key)), ['orders', 'products']);
  assert.deepEqual(plain(stub.calls[0].body.ops.map((o) => o.expectedRev)), [3, 0]);
  /* 非法项被忽略（key 缺失 / 只有 1 个元素） */
  stub.reset();
  assert.equal(await app.run('saveMulti([["orders",orders],[null,"x"],["",1]], true)'), true);
  assert.equal(stub.calls.length, 1);
  assert.deepEqual(plain(stub.calls[0].body.ops.map((o) => o.key)), ['orders']);
});

test('DB.set 零回归：单键走 /api/save、携带 expectedRev、409 语义不变', async () => {
  const { app, stub } = makeApp({
    '/api/save': { status: 200, body: { ok: true, rev: 4 } },
  });
  app.setGlobals({ orders: [{ id: 'X' }] });
  assert.equal(await app.run('DB.set("orders", orders, false)'), true);
  assert.equal(stub.calls[0].path, '/api/save');
  assert.deepEqual(plain(stub.calls[0].body), { key: 'orders', value: [{ id: 'X' }], expectedRev: 3 });
  assert.equal(app.getGlobal('serverRevs').orders, 4, '用服务端返回 rev 刷新本地');

  /* 409：pullAll + alert + false（.123 原有行为，T01 未改动） */
  const b = makeApp({
    '/api/save': { status: 409, body: {} },
    '/api/data': { status: 200, body: { data: { orders: [{ id: 'SERVER' }] }, revs: { orders: 3 } } },
  });
  assert.equal(await b.app.run('DB.set("orders", [{id:"DIRTY"}], false)'), false);
  assert.deepEqual(plain(b.stub.calls.map((c) => c.path)), ['/api/save', '/api/data']);
  assert.equal(b.app.alerts.length, 1);
  assert.match(b.app.alerts[0], /数据已被他人修改/);

  /* silent 409：不弹窗 */
  const c = makeApp({
    '/api/save': { status: 409, body: {} },
    '/api/data': { status: 200, body: { data: {}, revs: {} } },
  });
  assert.equal(await c.app.run('DB.set("logs", [], true)'), false);
  assert.equal(c.app.alerts.length, 0);
});

test("logOp 已改走 silent 写：logs 落盘失败不再弹「本次保存未生效」假告警（T03 1 行修复）", async () => {
  const { app } = makeApp({
    '/api/save': { status: 409, body: {} },
    '/api/data': { status: 200, body: { data: {}, revs: { logs: 12 } } },
  });
  app.setGlobals({ currentUser: { username: 'admin', name: '管理员', role: 'admin', perms: {} } });
  const before = plain(app.getGlobal('logs')).length;
  app.run('logOp("新增","订单管理","测试")');
  await new Promise((r) => setTimeout(r, 50)); /* save 是 fire-and-forget，等一次微/宏任务 */
  assert.equal(plain(app.getGlobal('logs')).length, before + 1, '日志条目仍写入内存');
  assert.equal(app.alerts.length, 0, 'logs 409 不得打扰用户');
  assert.deepEqual(plain(app.getGlobal('serverRevs')), { logs: 12 }, '409 仍触发 pullAll 刷新 rev');
});
