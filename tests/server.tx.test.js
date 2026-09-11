'use strict';
/* ============================================================
   P1 · T02 测试：POST /api/tx 原子事务（设计 §3）
   ------------------------------------------------------------
   Part A 纯净核心（注入依赖，直接调 handleTx）：
     G15 正常 → 200，data/revs 前进，saveJson 恰好 1 次
     G16 rev 冲突 → 409，data/revs 完全未变（含未冲突的那个 op）
     G17 权限不足 → 403，一字不写
     G18 未知表 / 重复键 / 参数缺失 → 400，一字不写
     G19 落盘失败 → 500，内存 data/revs 回滚到提交前
   Part B 真实 HTTP 端到端（自建 server + handleRequest）：
     /api/tx 正常提交（含 D1 修复：pmc 写 productionPlans / products 纯投影）
     /api/tx rev 冲突 409 且内存+磁盘一字不写
     /api/tx 权限 403 且一字不写
     /api/save 零回归（单键保存 / expectedRev 409 语义 / 400 / 403 / 系统键）
   运行：node --test tests/server.tx.test.js
   边界：不启动生产服务（require.main 守卫）；数据/用户文件指向隔离临时目录，
         校验完自动删除，绝不触碰真实 server/data.json · server/users.json。
   ============================================================ */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
/* 临时目录放在仓库工作区内（Windows 下 Node 会把 '/tmp' 解析成 D:\tmp 导致 ENOENT） */
const TMP = fs.mkdtempSync(path.join(ROOT, '.p1tmp-'));
const DATA_PATH = path.join(TMP, 'data.json');
const USERS_PATH = path.join(TMP, 'users.json');
process.env.PROD_DATA_FILE = DATA_PATH;
process.env.PROD_USERS_FILE = USERS_PATH;

/* ---------- fixtures：线上真实 perms 镜像（设计 §5.3 真值表） ---------- */
const PWD = 'p1-test-pwd';
const PERMS = {
  admin: {},
  pmc: { products: false, saleOrders: true, invOrders: true, dailyPlans: true, deliveries: true, processTemplates: true, transfers: true },
  chejian: { products: false, dailyPlans: true, deliveries: true, processTemplates: true, transfers: true },
  zongjingli: { products: false, dailyPlans: false, deliveries: true, fields: true }
};
function mkUser(username, name, role, pwd, perms) {
  const salt = crypto.randomBytes(8).toString('hex');
  return { username, name, role, status: 'active', salt, hash: crypto.scryptSync(String(pwd), salt, 32).toString('hex'), perms };
}
const DATA_FIXTURE = {
  products: [
    { id: 'P1', name: '甲产品', spec: 'S1', model: 'M1', unit: '台', dailyCap: 10, stockMin: 0, stockMax: 99, processTplId: null, status: '启用', stock: 0 },
    { id: 'P2', name: '乙产品', spec: 'S2', model: 'M2', unit: '台', dailyCap: 5, stockMin: 1, stockMax: 50, processTplId: null, status: '启用', stock: 3 }
  ],
  orders: [{ id: 'O1', orderType: '销售订单', status: '执行中', items: [{ productId: 'P1', qty: 10, deliveredQty: 2, calledQty: 0 }] }],
  deliveries: [], productionPlans: [], productionReports: [], processTemplates: [],
  logs: [], fields: null, meta: { seq: 0 }, fieldsAudit: 'audited', fieldsDraft: null, tblLayout: {}, transfers: []
};
fs.writeFileSync(USERS_PATH, JSON.stringify([
  mkUser('admin', '管理员', 'admin', PWD, PERMS.admin),
  mkUser('pmc', 'PMC', 'staff', PWD, PERMS.pmc),
  mkUser('chejian', '车间', 'staff', PWD, PERMS.chejian),
  mkUser('zongjingli', '总经理', 'staff', PWD, PERMS.zongjingli)
]));
fs.writeFileSync(DATA_PATH, JSON.stringify(DATA_FIXTURE));

const srv = require(path.join(ROOT, 'server', 'server.js'));

/* ============================================================
   Part A · handleTx 纯净核心
   ============================================================ */
const ADMIN = { username: 'admin', role: 'admin', perms: {} };
const PMC = { username: 'pmc', role: 'staff', perms: PERMS.pmc };
const CHEJIAN = { username: 'chejian', role: 'staff', perms: PERMS.chejian };
const ZONGJINGLI = { username: 'zongjingli', role: 'staff', perms: PERMS.zongjingli };
/* 车间型账号（真值去掉 transfers）= G17 的「无权账号」；线上真值 chejian 实际持有 transfers:true（§5.4 自述「有权限无入口」） */
const CHEJIAN_NO_TX = { username: 'chejian_no_tx', role: 'staff', perms: { products: false, dailyPlans: true, deliveries: true, processTemplates: true } };

function freshState() {
  const data = JSON.parse(JSON.stringify(srv.DEFAULT_DATA));
  const revs = {};
  Object.keys(data).forEach(k => { revs[k] = 0; });
  return { data, revs };
}
function clone(x) { return JSON.parse(JSON.stringify(x)); }
function spySave() { const calls = []; return { calls, fn: (file, obj) => { calls.push({ file, json: JSON.stringify(obj) }); } }; }

test('G15 /api/tx 正常：2 个合法 op → 200；data/revs 前进；saveJson 恰好 1 次', () => {
  const { data, revs } = freshState();
  revs.orders = 12; revs.transfers = 5;
  const orders = [{ id: 'O1-new' }];
  const transfers = [{ id: 'T1', type: 'call' }];
  const sp = spySave();
  const r = srv.handleTx(data, revs, ADMIN, { requestId: 'req-1（本轮预留，服务端忽略）', ops: [
    { key: 'orders', value: orders, expectedRev: 12 },
    { key: 'transfers', value: transfers, expectedRev: 5 }
  ] }, srv.canWrite, sp.fn, srv.DEFAULT_DATA);

  assert.strictEqual(r.code, 200);
  assert.deepStrictEqual(r.body, { ok: true, revs: { orders: 13, transfers: 6 } });
  assert.strictEqual(sp.calls.length, 1, 'saveJson 必须恰好调用 1 次（单次原子落盘）');
  assert.strictEqual(data.orders, orders, '内存引用替换语义与 /api/save 一致');
  assert.strictEqual(data.transfers, transfers);
  assert.strictEqual(revs.orders, 13);
  assert.strictEqual(revs.transfers, 6);
  assert.ok(sp.calls[0].json.indexOf('O1-new') >= 0 && sp.calls[0].json.indexOf('T1') >= 0, '落盘内容应同时含两张表的新值');
});

test('G15b /api/tx 不带 expectedRev → 与 /api/save 一致：不做 CAS，直接提交', () => {
  const { data, revs } = freshState();
  const sp = spySave();
  const r = srv.handleTx(data, revs, PMC, { ops: [{ key: 'productionPlans', value: [{ id: 'PP1' }] }] }, srv.canWrite, sp.fn, srv.DEFAULT_DATA);
  assert.strictEqual(r.code, 200, 'pmc 写 productionPlans 应放行（D1 修复）');
  assert.strictEqual(revs.productionPlans, 1);
  assert.strictEqual(sp.calls.length, 1);
});

test('G16 rev 冲突：op2 的 expectedRev 过期 → 409；data/revs 完全未变（含 op1）', () => {
  const { data, revs } = freshState();
  revs.orders = 12; revs.transfers = 5;
  const before = JSON.stringify({ data, revs });
  const sp = spySave();
  const r = srv.handleTx(data, revs, ADMIN, { ops: [
    { key: 'orders', value: [{ id: 'SHOULD-NOT-WRITE' }], expectedRev: 12 },
    { key: 'transfers', value: [{ id: 'SHOULD-NOT-WRITE' }], expectedRev: 4 }
  ] }, srv.canWrite, sp.fn, srv.DEFAULT_DATA);

  assert.strictEqual(r.code, 409);
  assert.strictEqual(r.body.error, '数据已被他人修改');
  assert.deepStrictEqual(r.body.conflicts, [{ key: 'transfers', expectedRev: 4, curRev: 5 }]);
  assert.strictEqual(JSON.stringify({ data, revs }), before, '失败必须一字不写（含 op1 的内存）');
  assert.deepStrictEqual(data.orders, [], 'op1 也不许写');
  assert.strictEqual(revs.orders, 12);
  assert.strictEqual(sp.calls.length, 0, '失败路径不得落盘');
});

test('G16b 多键同时冲突 → conflicts 全量返回', () => {
  const { data, revs } = freshState();
  revs.orders = 1; revs.transfers = 2;
  const r = srv.handleTx(data, revs, ADMIN, { ops: [
    { key: 'orders', value: [], expectedRev: 9 },
    { key: 'transfers', value: [], expectedRev: 9 }
  ] }, srv.canWrite, () => {}, srv.DEFAULT_DATA);
  assert.strictEqual(r.code, 409);
  assert.strictEqual(r.body.conflicts.length, 2);
});

test('G17 权限不足 → 403 一字不写（无权 op 在首位/末位均整体拒绝）', () => {
  /* ① 无调拨权的车间型账号 + transfers → 403 */
  let st = freshState();
  let before = JSON.stringify(st);
  let sp = spySave();
  let r = srv.handleTx(st.data, st.revs, CHEJIAN_NO_TX, { ops: [
    { key: 'transfers', value: [{ id: 'X' }], expectedRev: 0 },
    { key: 'productionPlans', value: [{ id: 'OK' }], expectedRev: 0 }
  ] }, srv.canWrite, sp.fn, srv.DEFAULT_DATA);
  assert.strictEqual(r.code, 403);
  assert.strictEqual(r.body.error, '无该表单的编辑权限');
  assert.strictEqual(r.body.key, 'transfers');
  assert.strictEqual(JSON.stringify(st), before, '403 一字不写（合法的 productionPlans 也不许写）');
  assert.strictEqual(sp.calls.length, 0);

  /* ② 无权 op 在末位 → 同样整体 403 */
  st = freshState(); before = JSON.stringify(st); sp = spySave();
  r = srv.handleTx(st.data, st.revs, CHEJIAN_NO_TX, { ops: [
    { key: 'productionPlans', value: [{ id: 'OK' }], expectedRev: 0 },
    { key: 'transfers', value: [{ id: 'X' }], expectedRev: 0 }
  ] }, srv.canWrite, sp.fn, srv.DEFAULT_DATA);
  assert.strictEqual(r.code, 403);
  assert.strictEqual(r.body.key, 'transfers');
  assert.strictEqual(JSON.stringify(st), before);
  assert.strictEqual(sp.calls.length, 0);

  /* ③ 线上真实 zongjingli 越权键 → 403（§5.3 实测原 200） */
  st = freshState(); before = JSON.stringify(st);
  r = srv.handleTx(st.data, st.revs, ZONGJINGLI, { ops: [{ key: 'transfers', value: [{ id: 'X' }], expectedRev: 0 }] }, srv.canWrite, () => {}, srv.DEFAULT_DATA);
  assert.strictEqual(r.code, 403);
  assert.strictEqual(r.body.key, 'transfers');
  assert.strictEqual(JSON.stringify(st), before);
});

test('G17b 并集命中：线上真值 chejian 持有 transfers → 放行（§5.4「有 transfers 权限但无入口」）', () => {
  const { data, revs } = freshState();
  const sp = spySave();
  const r = srv.handleTx(data, revs, CHEJIAN, { ops: [{ key: 'transfers', value: [{ id: 'T-ok' }], expectedRev: 0 }] }, srv.canWrite, sp.fn, srv.DEFAULT_DATA);
  assert.strictEqual(r.code, 200, 'chejian.transfers=true（线上真值）→ 并集命中，允许');
  assert.strictEqual(sp.calls.length, 1);
});

test('G17c products 非纯投影：pmc 经 /api/tx 改产品主数据 → 403（不得放宽）', () => {
  const { data, revs } = freshState();
  data.products = [{ id: 'P1', name: '甲', stock: 1 }];
  const before = JSON.stringify({ data, revs });
  const sp = spySave();
  const r = srv.handleTx(data, revs, PMC, { ops: [
    { key: 'orders', value: [{ id: 'OK' }], expectedRev: 0 },
    { key: 'products', value: [{ id: 'P1', name: '甲改名', stock: 2 }], expectedRev: 0 }
  ] }, srv.canWrite, sp.fn, srv.DEFAULT_DATA);
  assert.strictEqual(r.code, 403);
  assert.strictEqual(r.body.key, 'products');
  assert.strictEqual(JSON.stringify({ data, revs }), before, '403 一字不写（orders 也不许写）');
  assert.strictEqual(sp.calls.length, 0);

  /* 同一批只改 stock → 200 且一次落盘 */
  const st2 = freshState();
  st2.data.products = [{ id: 'P1', name: '甲', stock: 1 }];
  const sp2 = spySave();
  const r2 = srv.handleTx(st2.data, st2.revs, PMC, { ops: [
    { key: 'orders', value: [{ id: 'OK' }], expectedRev: 0 },
    { key: 'products', value: [{ id: 'P1', name: '甲', stock: 9 }], expectedRev: 0 }
  ] }, srv.canWrite, sp2.fn, srv.DEFAULT_DATA);
  assert.strictEqual(r2.code, 200, '纯 stock 投影写应放行（D1 修复）');
  assert.strictEqual(sp2.calls.length, 1);
});

test('G18 未知表 / 重复键 / 参数缺失 / 非法 op → 400 且一字不写', () => {
  const st = freshState();
  const before = JSON.stringify(st);
  const sp = spySave();
  const f = body => srv.handleTx(st.data, st.revs, ADMIN, body, srv.canWrite, sp.fn, srv.DEFAULT_DATA);

  let r = f({ ops: [{ key: 'nope', value: [] }] });
  assert.strictEqual(r.code, 400);
  assert.strictEqual(r.body.error, '未知数据表: nope');

  r = f({ ops: [{ key: 'orders', value: [] }, { key: 'orders', value: [] }] });
  assert.strictEqual(r.code, 400);
  assert.strictEqual(r.body.error, '重复的表键: orders');

  r = f({ ops: [{ key: 'orders' }] });
  assert.strictEqual(r.code, 400, '缺 value 应 400（与 /api/save 一致）');

  r = f({ ops: [{ nokey: 1, value: [] }] });
  assert.strictEqual(r.code, 400);

  r = f({ ops: 'x' });
  assert.strictEqual(r.code, 400);

  r = f(null);
  assert.strictEqual(r.code, 400);

  assert.strictEqual(JSON.stringify(st), before, '400 路径一字不写');
  assert.strictEqual(sp.calls.length, 0, '400 路径不得落盘');
});

test('G18b 边界：ops 长度 1..20 合法、21 → 400；未登录 → 401', () => {
  const dd = {};
  for (let i = 0; i < 21; i++) dd['k' + i] = [];
  const data = clone(dd), revs = {};
  Object.keys(data).forEach(k => { revs[k] = 0; });
  const permit = () => true, save = () => {};
  const mk = n => Array.from({ length: n }, (_, i) => ({ key: 'k' + i, value: [] }));

  assert.strictEqual(srv.handleTx(data, revs, ADMIN, { ops: mk(21) }, permit, save, dd).code, 400, '超过 MAX_OPS 应 400');
  assert.strictEqual(srv.handleTx(data, revs, ADMIN, { ops: mk(20) }, permit, save, dd).code, 200, '恰好 20 个应 200');
  assert.strictEqual(srv.handleTx(data, revs, ADMIN, { ops: mk(1) }, permit, save, dd).code, 200, '1 个应 200');
  assert.strictEqual(srv.handleTx(data, revs, null, { ops: mk(1) }, permit, save, dd).code, 401, '未登录应 401');
  assert.strictEqual(srv.handleTx(data, revs, ADMIN, { ops: [] }, permit, save, dd).code, 400, '空 ops 应 400');
  assert.strictEqual(srv.MAX_OPS, 20);
  assert.strictEqual(srv.LOG_MAX, 500);
});

test('G19 落盘失败：注入抛错 saveJson → 500；内存 data/revs 回滚到提交前', () => {
  const st = freshState();
  st.revs.orders = 3; st.revs.transfers = 1;
  /* 先放一点真实内容，验证回滚恢复的是「旧值对象」而非 default */
  st.data.orders = [{ id: 'OLD-O' }];
  st.data.transfers = [{ id: 'OLD-T' }];
  const oldOrders = st.data.orders, oldTransfers = st.data.transfers;
  const before = JSON.stringify(st);
  const boom = () => { throw new Error('disk full (注入桩)'); };

  const r = srv.handleTx(st.data, st.revs, ADMIN, { ops: [
    { key: 'orders', value: [{ id: 'NEW-O' }], expectedRev: 3 },
    { key: 'transfers', value: [{ id: 'NEW-T' }], expectedRev: 1 }
  ] }, srv.canWrite, boom, srv.DEFAULT_DATA);

  assert.strictEqual(r.code, 500);
  assert.strictEqual(r.body.error, '持久化失败，已回滚');
  assert.strictEqual(JSON.stringify(st), before, '内存 data/revs 应回滚到提交前（逐字节）');
  assert.strictEqual(st.data.orders, oldOrders, '回滚应还原原对象引用');
  assert.strictEqual(st.data.transfers, oldTransfers);
  assert.strictEqual(st.revs.orders, 3);
  assert.strictEqual(st.revs.transfers, 1);
});

test('G19b 自动补键（DEFAULT_DATA 已注册但缺键）：成功则生效，失败则连补键一起回滚', () => {
  /* 失败路径：不许在内存里留下残键 */
  const data = { orders: [] }, revs = { orders: 0 };
  let r = srv.handleTx(data, revs, ADMIN, { ops: [{ key: 'fields', value: { a: 1 } }] }, srv.canWrite, () => { throw new Error('boom'); }, srv.DEFAULT_DATA);
  assert.strictEqual(r.code, 500);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(data, 'fields'), false, '失败后不得残留自动补的键');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(revs, 'fields'), false);

  /* 成功路径：自动补键 + rev 从 0 起算 → 1 */
  const data2 = { orders: [] }, revs2 = { orders: 0 }, sp = spySave();
  r = srv.handleTx(data2, revs2, ADMIN, { ops: [{ key: 'fields', value: { a: 1 } }] }, srv.canWrite, sp.fn, srv.DEFAULT_DATA);
  assert.strictEqual(r.code, 200);
  assert.deepStrictEqual(data2.fields, { a: 1 });
  assert.strictEqual(revs2.fields, 1);
  assert.strictEqual(sp.calls.length, 1);

  /* 真未知键（DEFAULT_DATA 未注册）→ 400 */
  const data3 = { orders: [] }, revs3 = { orders: 0 };
  r = srv.handleTx(data3, revs3, ADMIN, { ops: [{ key: 'zzz', value: [] }] }, srv.canWrite, () => {}, srv.DEFAULT_DATA);
  assert.strictEqual(r.code, 400);
});

/* ============================================================
   Part B · 真实 HTTP 端到端（隔离临时目录）
   ============================================================ */
let server, base;
before(async () => {
  server = http.createServer(srv.handleRequest);
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
  base = 'http://127.0.0.1:' + server.address().port;
});
after(async () => {
  if (server) await new Promise(r => server.close(r));
  fs.rmSync(TMP, { recursive: true, force: true });
});

async function login(username) {
  const resp = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PWD }) });
  const j = await resp.json();
  assert.strictEqual(resp.status, 200, '登录失败: ' + JSON.stringify(j));
  return j.token;
}
async function api(method, p, token, body) {
  const opt = { method, headers: {} };
  if (token) opt.headers['Authorization'] = 'Bearer ' + token;
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const resp = await fetch(base + p, opt);
  let j = null;
  try { j = await resp.json(); } catch (e) { j = null; }
  return { status: resp.status, body: j };
}
function disk() { return fs.readFileSync(DATA_PATH, 'utf8'); }

test('E2E-1 /api/tx 正常提交（pmc：productionPlans + products 纯 stock 投影）→ 200 且落盘', async () => {
  const token = await login('pmc');
  const d0 = await api('GET', '/api/data', token);
  const plans = clone(d0.body.data.productionPlans);
  plans.push({ id: 'PP1', productId: 'P1', qty: 4, status: '待开始', processes: [] });
  const prods = clone(d0.body.data.products);
  prods[0].stock = 7;                                   /* 仅 stock 变化 */

  const r = await api('POST', '/api/tx', token, { ops: [
    { key: 'productionPlans', value: plans, expectedRev: d0.body.revs.productionPlans || 0 },
    { key: 'products', value: prods, expectedRev: d0.body.revs.products || 0 }
  ] });
  assert.strictEqual(r.status, 200, 'D1：pmc 经 /api/tx 写 productionPlans + products 投影必须 200（改造前 403）');
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.revs.productionPlans, (d0.body.revs.productionPlans || 0) + 1);
  assert.strictEqual(r.body.revs.products, (d0.body.revs.products || 0) + 1);

  const d1 = await api('GET', '/api/data', token);
  assert.strictEqual(d1.body.data.productionPlans.length, plans.length);
  assert.strictEqual(d1.body.data.products[0].stock, 7);
  const onDisk = JSON.parse(disk());
  assert.strictEqual(onDisk.products[0].stock, 7, '磁盘已原子落盘');
  assert.strictEqual(onDisk.productionPlans.length, plans.length);
});

test('E2E-2 /api/tx rev 冲突 → 409，内存与磁盘一字不写', async () => {
  const token = await login('pmc');
  const d0 = await api('GET', '/api/data', token);
  const beforeData = JSON.stringify(d0.body.data);
  const beforeDisk = disk();
  const r = await api('POST', '/api/tx', token, { ops: [
    { key: 'orders', value: [{ id: 'SHOULD-NOT-WRITE' }], expectedRev: (d0.body.revs.orders || 0) + 99 },
    { key: 'productionPlans', value: d0.body.data.productionPlans, expectedRev: d0.body.revs.productionPlans || 0 }
  ] });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.error, '数据已被他人修改');
  assert.ok(Array.isArray(r.body.conflicts) && r.body.conflicts.length === 1);
  assert.strictEqual(r.body.conflicts[0].key, 'orders');

  const d1 = await api('GET', '/api/data', token);
  assert.strictEqual(JSON.stringify(d1.body.data), beforeData, '内存 data 一字未写');
  assert.strictEqual(JSON.stringify(d1.body.revs), JSON.stringify(d0.body.revs), 'revs 一字未写');
  assert.strictEqual(disk(), beforeDisk, '磁盘一字未写');
});

test('E2E-3 /api/tx 权限不足 → 403，内存与磁盘一字不写', async () => {
  const token = await login('zongjingli');            /* 线上真值：无 transfers 权限（改造前可 200 覆盖台账） */
  const d0 = await api('GET', '/api/data', token);
  const beforeData = JSON.stringify(d0.body.data);
  const beforeDisk = disk();
  const r = await api('POST', '/api/tx', token, { ops: [
    { key: 'transfers', value: [{ id: 'UNAUTH' }], expectedRev: d0.body.revs.transfers || 0 }
  ] });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.body.error, '无该表单的编辑权限');
  assert.strictEqual(r.body.key, 'transfers');
  const d1 = await api('GET', '/api/data', token);
  assert.strictEqual(JSON.stringify(d1.body.data), beforeData, '403 一字不写');
  assert.strictEqual(disk(), beforeDisk, '403 未落盘');
});

test('E2E-4 /api/tx 未知表 400 / 重复键 400 / 未登录 401', async () => {
  const token = await login('admin');
  let r = await api('POST', '/api/tx', token, { ops: [{ key: 'nope', value: [] }] });
  assert.strictEqual(r.status, 400);
  assert.match(String(r.body.error), /未知数据表/);
  r = await api('POST', '/api/tx', token, { ops: [{ key: 'logs', value: [] }, { key: 'logs', value: [] }] });
  assert.strictEqual(r.status, 400);
  assert.match(String(r.body.error), /重复的表键/);
  r = await api('POST', '/api/tx', null, { ops: [{ key: 'logs', value: [] }] });
  assert.strictEqual(r.status, 401);
});

test('E2E-5 /api/save 零回归：单键保存 / expectedRev 409 语义 / 400 / 403 不变', async () => {
  const admin = await login('admin');
  const d0 = await api('GET', '/api/data', admin);

  /* (a) 单键保存（不带 expectedRev）→ 200 { ok, rev }，rev +1
     注意：logs 前端语义为「最新在前」（js/logs.js `logs.unshift(entry)`），故追加＝前插。 */
  const logs1 = [{ time: 'T1', action: '新增', target: '测试', detail: 'd', field: '' }].concat(d0.body.data.logs);
  let r = await api('POST', '/api/save', admin, { key: 'logs', value: logs1 });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.rev, (d0.body.revs.logs || 0) + 1);

  /* (b) expectedRev 过期 → 409 { error, rev }（响应形状与改造前一致） */
  r = await api('POST', '/api/save', admin, { key: 'logs', value: logs1, expectedRev: d0.body.revs.logs || 0 });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.error, '数据已被他人修改');
  assert.strictEqual(typeof r.body.rev, 'number');

  /* (c) expectedRev 命中 → 200 */
  const d2 = await api('GET', '/api/data', admin);
  r = await api('POST', '/api/save', admin, { key: 'logs', value: logs1, expectedRev: d2.body.revs.logs });
  assert.strictEqual(r.status, 200);

  /* (d) 未知表 → 400；缺 value → 400 */
  r = await api('POST', '/api/save', admin, { key: 'nope', value: [] });
  assert.strictEqual(r.status, 400);
  assert.match(String(r.body.error), /未知数据表/);
  r = await api('POST', '/api/save', admin, { key: 'logs' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.error, '参数缺失');

  /* (e) 改造前就是 403 的用例，改造后必须仍 403：chejian 存 orders */
  const cj = await login('chejian');
  r = await api('POST', '/api/save', cj, { key: 'orders', value: [] });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.body.error, '无该表单的编辑权限');

  /* (f) 系统键 logs 追加对 staff 仍放行（不变）——追加＝前插（最新在前） */
  const dc = await api('GET', '/api/data', cj);
  const logs2 = [{ time: 'T2', action: '报工', target: '排产', detail: 'd2', field: '' }].concat(dc.body.data.logs);
  r = await api('POST', '/api/save', cj, { key: 'logs', value: logs2 });
  assert.strictEqual(r.status, 200, 'staff 追加日志应放行（与改造前一致）');
  /* 反向对照：把日志追加到尾部（非前端语义）应被拒 —— 证明白名单确实在做「前插」校验 */
  const logs2tail = dc.body.data.logs.concat([{ time: 'T3', action: '报工', target: '排产', detail: 'd3', field: '' }]);
  r = await api('POST', '/api/save', cj, { key: 'logs', value: logs2tail });
  assert.strictEqual(r.status, 403, '尾部追加（非前端语义）应被拒，证明白名单非空放行');

  /* (g) 【有意收敛·预期行为变更】staff 清空 logs → 403 */
  r = await api('POST', '/api/save', cj, { key: 'logs', value: [] });
  assert.strictEqual(r.status, 403, 'M5：非 admin 清空日志由「全放行」收敛为 403');

  /* (h) D3：meta / tblLayout 对 staff 仍放行（本轮不动） */
  r = await api('POST', '/api/save', cj, { key: 'tblLayout', value: { logs: { page: 2 } } });
  assert.strictEqual(r.status, 200, 'D3：tblLayout 保持放行');
  r = await api('POST', '/api/save', cj, { key: 'meta', value: { seq: 1 } });
  assert.strictEqual(r.status, 200, 'D3：meta 保持放行');
});

test('E2E-6 /api/save 上 D1 修复同时生效（单一判定点：pmc 存 productionPlans / products 投影）', async () => {
  const pmc = await login('pmc');
  const d0 = await api('GET', '/api/data', pmc);
  const plans = clone(d0.body.data.productionPlans);
  plans.push({ id: 'PP2', productId: 'P2', qty: 1, status: '待开始', processes: [] });
  let r = await api('POST', '/api/save', pmc, { key: 'productionPlans', value: plans });
  assert.strictEqual(r.status, 200, 'D1：pmc 经 /api/save 存 productionPlans 应 200（改造前 403）');

  const d1 = await api('GET', '/api/data', pmc);
  const prods = clone(d1.body.data.products);
  prods[1].stock = 11;
  r = await api('POST', '/api/save', pmc, { key: 'products', value: prods });
  assert.strictEqual(r.status, 200, 'D1：pmc 经 /api/save 写 products 纯 stock 投影应 200（改造前 403）');

  /* 产品主数据字段不放宽 */
  const d2 = await api('GET', '/api/data', pmc);
  const bad = clone(d2.body.data.products);
  bad[0].name = '擅改';
  r = await api('POST', '/api/save', pmc, { key: 'products', value: bad });
  assert.strictEqual(r.status, 403, '改产品 name 仍 403（不得放宽产品主数据）');
});
