'use strict';
/* ============================================================
   tests/qa-server.test.js —— qa-server HTTP 端到端 + 全错误码 + 并发不撞号
   ------------------------------------------------------------
   【build .163】为什么必须端到端测（设计 §1.2.6d / §8.3 第 5 条）：
     · 错误码契约是前端**唯一**依赖：401/403/400/404/405/409/413/503 每条都要真的打一遍，
       否则前端写好的分支只是「猜」。
     · 「并发 20 个 POST」直接验证写串行化队列（设计 §1.2.3f 的核心风险）：
       readBody 是异步的，若不做单写者串行化，两个 POST 会算出同一个号并互相覆盖。

   测试形态（照抄 tests/server.canwrite.test.js 的范式）：
     · 自建 `http.createServer(srv.handleRequest)`，端口 0（内核分配，绝不撞 3001）
     · 把 `QA_PROD_ME_URL` 打桩到本地假 `/api/me`（**不碰生产 3000 端口、不读 users.json**）
     · 数据文件走 `QA_DATA_FILE` 指向仓库内临时目录，绝不读写真实 data-qa.json
     · **不 require ../server/server.js**（会把生产内存数据与定时器拖进测试）

   为让断言完全确定，本文件把鉴权缓存 TTL 设为 0（每次读都回源 ⇒ 假后端的行为改动立即生效）。
   缓存命中/到期/淘汰的行为已在 tests/qa-backend.test.js 里逐条直测，这里不重复。

   运行：node --test tests/qa-server.test.js
   ============================================================ */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
/* 临时目录放在仓库工作区内（Windows 下 '/tmp' 会被解析成 D:\tmp），结束时清理 */
const TMP = fs.mkdtempSync(path.join(ROOT, '.qatmp-'));

let srv = null;          /* server/qa-server.js（延迟到 before 里 require） */
let store = null;        /* server/qa-store.js */
let server = null;       /* 被测 HTTP server */
let fake = null;         /* 假的生产 /api/me 后端 */
let PORT = 0;

/* ---------- 假 /api/me 的账号表（模拟生产 publicUser 形状） ---------- */
const USERS = {
  'tok-admin': { username: 'admin', name: '管理员', role: 'admin', status: 'active', perms: {}, mustChangePwd: false },
  'tok-qa': { username: 'zhangsan', name: '张三', role: 'staff', status: 'active', perms: { qa: true, acts: {} }, mustChangePwd: false },
  'tok-ro': { username: 'lisi', name: '李四', role: 'staff', status: 'active', perms: {}, mustChangePwd: false },
  'tok-off': { username: 'wangwu', name: '王五', role: 'staff', status: 'disabled', perms: { qa: true }, mustChangePwd: false }
};
let fakeMode = 'ok';     /* 'ok' | 'down'（500 ⇒ 应 503） | 'slow'（超过超时 ⇒ 应 503） */

const T_QA = 'tok-qa';
const T_RO = 'tok-ro';
const T_ADMIN = 'tok-admin';
const T_OFF = 'tok-off';

function fakeHandler(req, res) {
  /* 超时用例里客户端会先断开，写响应失败属预期，吞掉以免影响后续用例 */
  res.on('error', function () { /* ignore */ });
  function reply(code, obj) {
    if (res.writableEnded) return;
    try {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    } catch (e) { /* 客户端已断开 */ }
  }
  if (fakeMode === 'down') return reply(500, { error: 'boom' });
  if (fakeMode === 'slow') {
    setTimeout(function () { reply(200, USERS[T_ADMIN]); }, 400);
    return;
  }
  const url = String(req.url || '');
  if (url.indexOf('/api/me') !== 0) return reply(404, { error: 'not found' });
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || '').trim());
  const u = m ? USERS[String(m[1]).trim()] : null;
  if (!u) return reply(401, { error: '未登录或登录已过期' });
  if (u.status !== 'active') return reply(401, { error: '未登录或登录已过期' });
  /* 生产 /api/me 返回**扁平** publicUser（V21） */
  return reply(200, u);
}

before(async function () {
  /* ① 先起假后端拿到真实端口（ME_URL 在 require 时被读取，故必须先 listen） */
  fake = http.createServer(fakeHandler);
  await new Promise(function (r) { fake.listen(0, '127.0.0.1', r); });
  const fakePort = fake.address().port;

  /* ② 配好环境变量再 require（模块加载时读 env） */
  process.env.QA_PROD_ME_URL = 'http://127.0.0.1:' + fakePort + '/api/me';
  process.env.QA_DATA_FILE = path.join(TMP, 'data-qa.json');
  process.env.QA_AUTH_TTL_MS = '0';           /* 每次都回源，断言完全确定 */
  process.env.QA_AUTH_TIMEOUT_MS = '120';     /* 超时用例：假后端 400ms 才回 ⇒ 必然超时 */
  process.env.QA_AUTH_CONNECT_TIMEOUT_MS = '300';

  srv = require(path.join(ROOT, 'server', 'qa-server.js'));
  store = require(path.join(ROOT, 'server', 'qa-store.js'));

  /* ③ 自建被测 server（端口 0，绝不占用 3001） */
  server = srv.createServer();
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  PORT = server.address().port;
});

after(async function () {
  if (server) await new Promise(function (r) { server.close(r); });
  if (fake) await new Promise(function (r) { fake.close(r); });
  fs.rmSync(TMP, { recursive: true, force: true });
});

/* ---------- 工具 ---------- */

/** 每个用例一份全新数据文件（隔离，互不影响） */
function freshDb(tag) {
  const file = path.join(TMP, 'db-' + (tag || 'x') + '.json');
  try { fs.rmSync(file, { force: true }); } catch (e) { /* 不存在 */ }
  try { fs.rmSync(file + '.tmp', { force: true }); } catch (e) { /* 不存在 */ }
  const r = store.initFile(file, fs);
  assert.strictEqual(r.created, true, '夹具：初始化数据文件失败');
  const b = srv.bootstrap({ dataFile: file });
  assert.strictEqual(b.ok, true, '夹具：加载数据文件失败：' + (b.error && b.error.message));
  return file;
}

/**
 * 发一个 HTTP 请求到被测 server。
 * @param {string} method
 * @param {string} p 路径
 * @param {{token: string=, body: (object|string)=, headers: object=}=} opts
 * @returns {Promise<{status: number, headers: object, json: (object|null), body: string}>}
 */
function req(method, p, opts) {
  const o = opts || {};
  const headers = Object.assign({}, o.headers || {});
  let payload = null;
  if (o.body !== undefined) {
    payload = typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  if (o.token) headers.Authorization = 'Bearer ' + o.token;
  return new Promise(function (resolve, reject) {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method: method, headers: headers }, function (res) {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', function (c) { b += c; });
      res.on('end', function () {
        let json = null;
        try { json = JSON.parse(b); } catch (e) { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, json: json, body: b });
      });
    });
    r.on('error', reject);
    if (payload !== null) r.write(payload);
    r.end();
  });
}

/* ============================================================
   一、health：免鉴权、不泄露业务数据
   ============================================================ */
test('GET /api/qa/health：免鉴权 200，字段齐全且**不含任何业务数据**', async function () {
  freshDb('health');
  /* 先塞一条记录，若 health 泄露台账内容就会露馅 */
  const created = await req('POST', '/api/qa/exceptions', { token: T_QA, body: { date: '2026-11-23' } });
  assert.strictEqual(created.status, 201);

  const r = await req('GET', '/api/qa/health');
  assert.strictEqual(r.status, 200, 'health 必须免鉴权（deploy-qa.sh 与运维依赖它）');
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(typeof r.json.uptimeMs, 'number');
  assert.strictEqual(r.json.records, 1, 'records 只给计数');
  assert.strictEqual(r.json.rev, 1);
  assert.strictEqual(typeof r.json.version, 'string');
  assert.ok(r.json.auth && typeof r.json.auth.size === 'number'
    && typeof r.json.auth.hits === 'number' && typeof r.json.auth.misses === 'number',
    'health 必须暴露缓存指标 {size,hits,misses}');
  /* 最关键的负向断言：探活不得回吐台账内容 */
  assert.strictEqual(r.body.indexOf('YC-'), -1, 'health 绝不得包含编号等业务数据');
  assert.strictEqual(r.body.indexOf('zhangsan'), -1, 'health 绝不得包含账号');
  assert.strictEqual(r.json.records.length, undefined, 'records 必须是数字不是数组');
});

/* ============================================================
   二、/api/qa/me：唯一权限来源（canWrite 单一实现）
   ============================================================ */
test('GET /api/qa/me：无 token ⇒ 401；有 token ⇒ 200 + canWrite/canDel', async function () {
  freshDb('me');
  const noAuth = await req('GET', '/api/qa/me');
  assert.strictEqual(noAuth.status, 401);
  assert.strictEqual(noAuth.json.error, '未登录或登录已过期');

  const admin = await req('GET', '/api/qa/me', { token: T_ADMIN });
  assert.strictEqual(admin.status, 200);
  assert.strictEqual(admin.json.ok, true);
  assert.strictEqual(admin.json.canWrite, true, '管理员恒可写');
  assert.strictEqual(admin.json.canDel, false, '本轮 canDel 恒 false');
  assert.strictEqual(admin.json.user.username, 'admin');
  assert.deepStrictEqual(Object.keys(admin.json.user).sort(), ['name', 'perms', 'role', 'username']);
  assert.strictEqual(admin.json.user.mustChangePwd, undefined, '不得透传 mustChangePwd');

  const qa = await req('GET', '/api/qa/me', { token: T_QA });
  assert.strictEqual(qa.json.canWrite, true, 'perms.qa === true ⇒ 可写');

  const ro = await req('GET', '/api/qa/me', { token: T_RO });
  assert.strictEqual(ro.status, 200, '只读用户也必须能拿到 /me（否则进不了页面）');
  assert.strictEqual(ro.json.canWrite, false, '无 qa 键 ⇒ 只读');

  const off = await req('GET', '/api/qa/me', { token: T_OFF });
  assert.strictEqual(off.status, 401, '停用账号必须 401');
});

test('权限判定 only perms.qa：perms 里其它键、role==="staff" 均不得放行', async function () {
  freshDb('perm');
  /* 假后端返回什么就判什么：tok-ro 的 perms 是 {}；再把 qa 设成非 true 也必须是 false */
  USERS['tok-falsy'] = { username: 'falsy', name: 'F', role: 'staff', status: 'active', perms: { qa: 'yes', acts: {}, transfers: true } };
  try {
    const r = await req('GET', '/api/qa/me', { token: 'tok-falsy' });
    assert.strictEqual(r.json.canWrite, false, 'perms.qa 必须是严格 true 才可写（"yes" 不算）');
  } finally {
    delete USERS['tok-falsy'];
  }
});

/* ============================================================
   三、GET /api/qa/exceptions：全量列表
   ============================================================ */
test('GET /api/qa/exceptions：401 / 空表 / 有记录', async function () {
  const file = freshDb('list');
  const noAuth = await req('GET', '/api/qa/exceptions');
  assert.strictEqual(noAuth.status, 401);

  const empty = await req('GET', '/api/qa/exceptions', { token: T_RO });
  assert.strictEqual(empty.status, 200);
  assert.strictEqual(empty.json.ok, true);
  assert.deepStrictEqual(empty.json.records, []);
  assert.strictEqual(empty.json.total, 0);
  assert.strictEqual(empty.json.rev, 0);
  assert.strictEqual(empty.json.version, store.DATA_VERSION);

  await req('POST', '/api/qa/exceptions', { token: T_QA, body: { date: '2026-11-23' } });
  const one = await req('GET', '/api/qa/exceptions', { token: T_RO });
  assert.strictEqual(one.json.total, 1);
  assert.strictEqual(one.json.records[0].date, '2026-11-23');
  assert.match(one.json.records[0].no, /^YC-\d{8}-\d{5}$/);
  /* 列表接口不落盘、不改文件 */
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(onDisk[store.TABLE_KEY].length, 1);
});

/* ============================================================
   四、GET /api/qa/next-no：预生成编号
   ============================================================ */
test('GET /api/qa/next-no：403 无写权限 / 200 有写权限且格式正确', async function () {
  freshDb('nextno');
  const forbidden = await req('GET', '/api/qa/next-no', { token: T_RO });
  assert.strictEqual(forbidden.status, 403);
  assert.match(forbidden.json.error, /无「质量管理」编辑权限/);
  /* 【build .164】字面量同步为「管理员后台 → 员工管理 → 表单写权限」（员工管理已迁到 /admin/）；
     判定方式不变：仍是「文案必须指路」的匹配断言，只是把指路路径补全。 */
  assert.match(forbidden.json.error, /管理员后台 → 员工管理 → 表单写权限/, '文案必须指路，否则用户只会报障');

  const ok = await req('GET', '/api/qa/next-no', { token: T_QA });
  assert.strictEqual(ok.status, 200);
  assert.match(ok.json.no, /^YC-\d{8}-\d{5}$/);
  assert.strictEqual(ok.json.no.slice(-5), '00001');
  /* next-no 不发号、不落库：连调两次必须同一个号 */
  const again = await req('GET', '/api/qa/next-no', { token: T_QA });
  assert.strictEqual(again.json.no, ok.json.no, 'next-no 是纯预生成，不得推进序号');
});

/* ============================================================
   五、POST /api/qa/exceptions：201 + 全 4xx
   ============================================================ */
test('POST：401 无 token / 403 无写权限 / 201 正常', async function () {
  const file = freshDb('post');
  assert.strictEqual((await req('POST', '/api/qa/exceptions', { body: { date: '2026-11-23' } })).status, 401);
  assert.strictEqual((await req('POST', '/api/qa/exceptions', { token: T_RO, body: { date: '2026-11-23' } })).status, 403);

  const r = await req('POST', '/api/qa/exceptions', { token: T_QA, body: { date: '2026-11-23' } });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(r.json.rev, 1);
  const rec = r.json.record;
  assert.match(rec.id, /^e_\d{13}_[0-9a-f]{6}$/);
  assert.match(rec.no, /^YC-\d{8}-\d{5}$/);
  assert.strictEqual(rec.date, '2026-11-23');
  assert.strictEqual(rec.createdBy, 'zhangsan', 'createdBy 取 token 身份，不取 body');
  assert.strictEqual(rec.updatedBy, 'zhangsan');
  assert.match(rec.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'ISO 8601 UTC');
  assert.strictEqual(rec.createdAt, rec.updatedAt);

  /* 落盘验证（不是只改内存） */
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(onDisk[store.TABLE_KEY].length, 1);
  assert.strictEqual(onDisk[store.TABLE_KEY][0].no, rec.no);
  assert.strictEqual(onDisk.revs[store.TABLE_KEY], 1);
  assert.strictEqual(fs.existsSync(file + '.tmp'), false, '原子写不得留下 .tmp');
});

test('POST：400 —— date 缺失 / 非真实日期 / 非法 JSON / 请求体非对象 / 嵌套字段', async function () {
  freshDb('post400');
  const cases = [
    [{ date: undefined }, 'date 缺失'],
    [{}, 'body 空对象'],
    [{ date: '2026-02-31' }, '2 月 31 日'],
    [{ date: '2027-02-29' }, '非闰年 2 月 29 日'],
    [{ date: '2026-11-23', extra: { a: 1 } }, '未知键为对象'],
    [{ date: '2026-11-23', arr: [1, 2] }, '未知键为数组'],
    [{ date: '2026-11-23', no: 'YC-2026-11-23-1' }, 'no 格式非法']
  ];
  for (const [body, label] of cases) {
    const r = await req('POST', '/api/qa/exceptions', { token: T_QA, body: body });
    assert.strictEqual(r.status, 400, label + ' 应 400');
    assert.strictEqual(typeof r.json.error, 'string', label + ' 必须带中文错误消息');
  }
  /* 非法 JSON 原文 */
  const badJson = await req('POST', '/api/qa/exceptions', { token: T_QA, body: '{oops' });
  assert.strictEqual(badJson.status, 400);
  /* JSON 数组（合法 JSON 但不是对象） */
  const arrBody = await req('POST', '/api/qa/exceptions', { token: T_QA, body: '[1,2]' });
  assert.strictEqual(arrBody.status, 400);
});

test('POST：未知顶层标量键原样落库（P2 加字段不需要改后端）', async function () {
  freshDb('post-extra');
  const r = await req('POST', '/api/qa/exceptions', {
    token: T_QA,
    body: { date: '2026-11-23', abnormalType: '尺寸超差', qty: 5, urgent: false, remark: null }
  });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.json.record.abnormalType, '尺寸超差');
  assert.strictEqual(r.json.record.qty, 5);
  assert.strictEqual(r.json.record.urgent, false);
  assert.strictEqual(r.json.record.remark, null);
  /* 再读列表确认持久化 */
  const list = await req('GET', '/api/qa/exceptions', { token: T_QA });
  assert.strictEqual(list.json.records[0].abnormalType, '尺寸超差');
});

test('POST：409 编号冲突 + suggest（前端据此静默重提交一次）', async function () {
  freshDb('post409');
  const first = await req('POST', '/api/qa/exceptions', { token: T_QA, body: { date: '2026-11-23' } });
  assert.strictEqual(first.status, 201);
  const usedNo = first.json.record.no;

  const dup = await req('POST', '/api/qa/exceptions', { token: T_QA, body: { date: '2026-11-23', no: usedNo } });
  assert.strictEqual(dup.status, 409);
  assert.strictEqual(dup.json.error, '编号已被占用');
  assert.strictEqual(dup.json.conflict, true);
  assert.match(dup.json.suggest, /^YC-\d{8}-\d{5}$/);
  assert.notStrictEqual(dup.json.suggest, usedNo, 'suggest 必须是可用号');

  /* 用 suggest 重提交必须成功（正是前端的静默重试路径） */
  const retry = await req('POST', '/api/qa/exceptions', { token: T_QA, body: { date: '2026-11-23', no: dup.json.suggest } });
  assert.strictEqual(retry.status, 201);
  assert.strictEqual(retry.json.record.no, dup.json.suggest);
});

test('POST：413 —— body 超过 64KB', async function () {
  freshDb('post413');
  const big = { date: '2026-11-23', note: 'x'.repeat(70 * 1024) };
  const r = await req('POST', '/api/qa/exceptions', { token: T_QA, body: big });
  assert.strictEqual(r.status, 413);
  assert.strictEqual(r.json.error, '请求体过大');
  /* 413 不得写入任何记录 */
  const list = await req('GET', '/api/qa/exceptions', { token: T_QA });
  assert.strictEqual(list.json.total, 0);
});

/* ============================================================
   六、PUT /api/qa/exceptions/:id
   ============================================================ */
test('PUT：200 改日期 / 404 不存在 / 400 改编号 / 403 无权限', async function () {
  freshDb('put');
  const created = await req('POST', '/api/qa/exceptions', { token: T_QA, body: { date: '2026-11-23' } });
  const rec = created.json.record;

  const ok = await req('PUT', '/api/qa/exceptions/' + encodeURIComponent(rec.id), {
    token: T_QA, body: { date: '2026-11-22' }
  });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.json.ok, true);
  assert.strictEqual(ok.json.rev, 2, '每次写 rev +1');
  assert.strictEqual(ok.json.record.date, '2026-11-22');
  assert.strictEqual(ok.json.record.no, rec.no, '编号不变');
  assert.strictEqual(ok.json.record.createdAt, rec.createdAt, 'createdAt 不变');
  assert.strictEqual(ok.json.record.updatedBy, 'zhangsan');

  const missing = await req('PUT', '/api/qa/exceptions/e_nope', { token: T_QA, body: { date: '2026-11-22' } });
  assert.strictEqual(missing.status, 404);
  assert.strictEqual(missing.json.error, '记录不存在');

  const rename = await req('PUT', '/api/qa/exceptions/' + encodeURIComponent(rec.id), {
    token: T_QA, body: { date: '2026-11-22', no: 'YC-20261123-00099' }
  });
  assert.strictEqual(rename.status, 400);
  assert.strictEqual(rename.json.error, '编号不可修改');

  /* 提交原编号（幂等）必须放行 */
  const idem = await req('PUT', '/api/qa/exceptions/' + encodeURIComponent(rec.id), {
    token: T_QA, body: { date: '2026-11-21', no: rec.no }
  });
  assert.strictEqual(idem.status, 200);

  const forbidden = await req('PUT', '/api/qa/exceptions/' + encodeURIComponent(rec.id), {
    token: T_RO, body: { date: '2026-11-22' }
  });
  assert.strictEqual(forbidden.status, 403);

  assert.strictEqual((await req('PUT', '/api/qa/exceptions/' + encodeURIComponent(rec.id), { body: { date: '2026-11-22' } })).status, 401);

  /* 400：非法日期 */
  const badDate = await req('PUT', '/api/qa/exceptions/' + encodeURIComponent(rec.id), {
    token: T_QA, body: { date: '2026-02-30' }
  });
  assert.strictEqual(badDate.status, 400);
});

/* ============================================================
   七、DELETE / 未知路由
   ============================================================ */
test('DELETE /api/qa/exceptions/:id ⇒ 三档鉴权：无 token 401 / 无 qa 权限 403 / 有权 405', async function () {
  /* 【P2-4 修复】原来 DELETE 分支在 authenticate() 之前、恒回 405（免鉴权）。
     那条注释「P1 上线时把 405 换成 200 即可」一旦被照做，就会留下**免鉴权的删除接口**。
     现改为先鉴权再回 405 ⇒ 无 token 从 405 变 401，是本轮唯一的行为变更（发版说明已登记）。 */
  freshDb('delete');
  const created = await req('POST', '/api/qa/exceptions', { token: T_ADMIN, body: { date: '2026-11-23' } });
  const url = '/api/qa/exceptions/' + encodeURIComponent(created.json.record.id);

  /* ① 无 token ⇒ 401（此前是 405） */
  const noAuth = await req('DELETE', url);
  assert.strictEqual(noAuth.status, 401, '无 token 的 DELETE 必须先 401，不能直接 405');
  assert.strictEqual(noAuth.json.error, '未登录或登录已过期');

  /* ② 有 token 但无「质量管理」写权限 ⇒ 403，且文案与 POST/PUT 完全一致 */
  const forbidden = await req('DELETE', url, { token: T_RO });
  assert.strictEqual(forbidden.status, 403, '无写权限的 DELETE 必须 403');
  /* 【build .164】逐字相等断言，字面量随服务端常量同步补「管理员后台 →」前缀（判定方式不变） */
  assert.strictEqual(forbidden.json.error,
    '无「质量管理」编辑权限，请联系管理员在「管理员后台 → 员工管理 → 表单写权限」中授权',
    '403 文案必须与 POST/PUT 同一句（前端只维护一份）');

  /* ③ 有权限 ⇒ 405（功能本身本轮未开放） */
  const r = await req('DELETE', url, { token: T_ADMIN });
  assert.strictEqual(r.status, 405);
  assert.strictEqual(r.json.error, '本轮未开放删除功能');

  /* 三档都不得改数据（防「说了没开放其实删了」） */
  const list = await req('GET', '/api/qa/exceptions', { token: T_ADMIN });
  assert.strictEqual(list.json.total, 1, 'DELETE 的任何分支都不得真的删除记录');
});

test('未知路由 / 未知方法 ⇒ 404 {error:"not found"}', async function () {
  freshDb('404');
  const paths = ['/', '/api/qa', '/api/qa/nope', '/api/qa/exceptions/abc/extra', '/api/me'];
  for (const p of paths) {
    const r = await req('GET', p, { token: T_ADMIN });
    assert.strictEqual(r.status, 404, p + ' 应 404');
    assert.strictEqual(r.json.error, 'not found');
  }
  /* 已知路径 + 不支持的方法 ⇒ 也落 404（设计 §3.5 的 "* 其他"） */
  const postHealth = await req('POST', '/api/qa/health', { token: T_ADMIN, body: {} });
  assert.strictEqual(postHealth.status, 404);
  const delNoId = await req('DELETE', '/api/qa/exceptions', { token: T_ADMIN });
  assert.strictEqual(delNoId.status, 404);
});

/* ============================================================
   八、fail-closed：/api/me 不可达 ⇒ 503 + Retry-After
   ============================================================ */
test('503：鉴权代理 5xx ⇒ fail-closed（读写都拒绝，且带 Retry-After: 3）', async function () {
  freshDb('503');
  fakeMode = 'down';
  try {
    const read = await req('GET', '/api/qa/exceptions', { token: T_QA });
    assert.strictEqual(read.status, 503, '读请求也必须 fail-closed');
    assert.strictEqual(read.json.error, '鉴权服务暂不可用，请稍后重试');
    assert.strictEqual(read.headers['retry-after'], '3');

    const write = await req('POST', '/api/qa/exceptions', { token: T_QA, body: { date: '2026-11-23' } });
    assert.strictEqual(write.status, 503);
    /* 绝不 fail-open：503 期间不得产生任何记录 */
    fakeMode = 'ok';
    const after = await req('GET', '/api/qa/exceptions', { token: T_QA });
    assert.strictEqual(after.json.total, 0);
  } finally {
    fakeMode = 'ok';
  }
  /* health 在鉴权服务挂掉时仍须可用（探活不能被鉴权拖死） */
  const h = await req('GET', '/api/qa/health');
  assert.strictEqual(h.status, 200);
});

test('503：鉴权代理超时 ⇒ fail-closed（不是 500、更不是放行）', async function () {
  freshDb('timeout');
  fakeMode = 'slow';
  try {
    const r = await req('GET', '/api/qa/me', { token: T_QA });
    assert.strictEqual(r.status, 503, '超时必须 fail-closed');
    assert.strictEqual(r.headers['retry-after'], '3');
  } finally {
    fakeMode = 'ok';
  }
});

/* ============================================================
   九、写穿透缓存：权限被收回后写请求立即 403
   ============================================================ */
test('写穿透：撤销 perms.qa 后，写请求立即 403（不等缓存过期）', async function () {
  freshDb('穿透');
  USERS['tok-revoke'] = { username: 'revoke', name: 'R', role: 'staff', status: 'active', perms: { qa: true, acts: {} } };
  try {
    const before = await req('POST', '/api/qa/exceptions', { token: 'tok-revoke', body: { date: '2026-11-23' } });
    assert.strictEqual(before.status, 201, '撤销前应可写');
    USERS['tok-revoke'].perms = {};                   /* 管理员在员工面板里勾掉并保存 */
    const after = await req('POST', '/api/qa/exceptions', { token: 'tok-revoke', body: { date: '2026-11-23' } });
    assert.strictEqual(after.status, 403, '写操作必须穿透缓存，立即拒绝');
  } finally {
    delete USERS['tok-revoke'];
  }
});

/* ============================================================
   十、并发 20 个 POST：写队列的唯一有效验证（设计 §8.3 第 5 条）
   ============================================================ */
test('并发 20 个 POST：不撞号、不丢记录、记录数 = 20', async function () {
  const file = freshDb('concurrency');
  const N = 20;
  const tasks = [];
  for (let i = 0; i < N; i++) {
    tasks.push(req('POST', '/api/qa/exceptions', { token: T_QA, body: { date: '2026-11-23' } }));
  }
  const results = await Promise.all(tasks);

  results.forEach(function (r, i) {
    assert.strictEqual(r.status, 201, '第 ' + (i + 1) + ' 个并发请求必须成功');
    assert.strictEqual(r.json.ok, true);
  });
  const nos = results.map(function (r) { return r.json.record.no; });
  assert.strictEqual(new Set(nos).size, N, '20 个并发请求必须产生 20 个互不相同的编号');
  const ids = results.map(function (r) { return r.json.record.id; });
  assert.strictEqual(new Set(ids).size, N, '20 个并发请求必须产生 20 个互不相同的 id');
  /* rev 必须是严格 1..20 的完整序列（证明每个写都串行执行、无一被覆盖） */
  const revs = results.map(function (r) { return r.json.rev; }).sort(function (a, b) { return a - b; });
  assert.deepStrictEqual(revs, Array.from({ length: N }, function (_, i) { return i + 1; }),
    'rev 序列必须连续无重复（有重复即说明写被覆盖）');

  /* 内存列表 */
  const list = await req('GET', '/api/qa/exceptions', { token: T_QA });
  assert.strictEqual(list.json.total, N, '记录数必须等于 20（丢更新会让它小于 20）');
  assert.strictEqual(new Set(list.json.records.map(function (r) { return r.no; })).size, N);
  assert.strictEqual(list.json.rev, N);

  /* 磁盘文件：证明每个写都真的落盘了（并发下若发生「后写覆盖前写」，磁盘同样会少） */
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(onDisk[store.TABLE_KEY].length, N, '磁盘记录数必须等于 20');
  assert.strictEqual(new Set(onDisk[store.TABLE_KEY].map(function (r) { return r.no; })).size, N);
});

/* ============================================================
   十一、enqueueWrite：单写者串行化本身（直接验队列，不经过 HTTP）
   ============================================================ */
test('enqueueWrite：刻意异步的任务也必须严格串行（单写者）', async function () {
  const order = [];
  function mk(i) {
    return srv.enqueueWrite(function () {
      order.push('start' + i);
      return new Promise(function (res) {
        setTimeout(function () { order.push('end' + i); res(i); }, 5);
      });
    });
  }
  const out = await Promise.all([mk(1), mk(2), mk(3)]);
  assert.deepStrictEqual(out, [1, 2, 3], '返回值必须透传给调用方');
  assert.deepStrictEqual(order, ['start1', 'end1', 'start2', 'end2', 'start3', 'end3'],
    '任务必须一个结束再开始下一个（否则「读-改-写」会交错）');
});

test('enqueueWrite：前一个任务失败不得阻塞后续任务（both handlers）', async function () {
  const done = [];
  const bad = srv.enqueueWrite(function () { throw new Error('boom'); });
  const good1 = srv.enqueueWrite(function () { done.push('a'); return 'a'; });
  const good2 = srv.enqueueWrite(function () { done.push('b'); return 'b'; });
  await assert.rejects(bad, /boom/, '失败必须能被调用方感知');
  assert.deepStrictEqual(await Promise.all([good1, good2]), ['a', 'b']);
  assert.deepStrictEqual(done, ['a', 'b'], '后续任务必须照常执行');
});

/* ============================================================
   十二、启动拒绝：脏数据文件必须拒绝启动（CLI 路径，子进程验证）
   ============================================================ */
test('启动：数据文件损坏 ⇒ 子进程拒绝启动（exit 1）且原文件不被改动', function () {
  const childProcess = require('node:child_process');
  const badFile = path.join(TMP, 'broken.json');
  const broken = '{"qaLogs":[{';
  fs.writeFileSync(badFile, broken, 'utf8');

  const r1 = childProcess.spawnSync(process.execPath, [path.join(ROOT, 'server', 'qa-server.js')], {
    env: Object.assign({}, process.env, { QA_DATA_FILE: badFile, QA_PORT: '0' }),
    encoding: 'utf8',
    timeout: 20000
  });
  assert.strictEqual(r1.status, 1, '损坏文件必须拒绝启动（exit 1），stderr=' + r1.stderr);
  assert.match(String(r1.stderr), /❌/);
  assert.match(String(r1.stderr), /JSON 解析失败/);
  assert.strictEqual(fs.readFileSync(badFile, 'utf8'), broken, '拒绝启动不得改动原文件');

  /* 文件不存在 ⇒ 同样拒绝启动，且绝不「静默初始化」 */
  const missing = path.join(TMP, 'not-exists.json');
  const r2 = childProcess.spawnSync(process.execPath, [path.join(ROOT, 'server', 'qa-server.js')], {
    env: Object.assign({}, process.env, { QA_DATA_FILE: missing, QA_PORT: '0' }),
    encoding: 'utf8',
    timeout: 20000
  });
  assert.strictEqual(r2.status, 1, '缺文件必须拒绝启动');
  assert.match(String(r2.stderr), /不存在或不可读/);
  assert.match(String(r2.stderr), /--init/, '提示必须告诉运维怎么初始化');
  assert.strictEqual(fs.existsSync(missing), false, '拒绝启动绝不能创建文件');
});

test('启动：--init 幂等（创建一次，第二次「未改动」并 exit 0）', function () {
  const childProcess = require('node:child_process');
  const file = path.join(TMP, 'init-cli.json');
  const run = function () {
    return childProcess.spawnSync(process.execPath, [path.join(ROOT, 'server', 'qa-server.js'), '--init'], {
      env: Object.assign({}, process.env, { QA_DATA_FILE: file, QA_PORT: '0' }),
      encoding: 'utf8',
      timeout: 20000
    });
  };
  const r1 = run();
  assert.strictEqual(r1.status, 0, '--init 必须 exit 0，stderr=' + r1.stderr);
  assert.match(String(r1.stdout), /已初始化数据文件/);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(onDisk.version, store.DATA_VERSION);
  assert.deepStrictEqual(onDisk.revs, { qaLogs: 0 });
  assert.deepStrictEqual(onDisk.qaLogs, []);

  const bytes = fs.readFileSync(file, 'utf8');
  const r2 = run();
  assert.strictEqual(r2.status, 0, '重复 --init 必须仍 exit 0（幂等）');
  assert.match(String(r2.stdout), /已存在，未做任何改动/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), bytes, '幂等调用不得改动文件');
});
