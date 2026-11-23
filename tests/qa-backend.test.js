'use strict';
/* ============================================================
   tests/qa-backend.test.js —— 数据层 qa-store.js + 鉴权层 qa-auth.js 直测
   ------------------------------------------------------------
   【build .163】为什么必须能在「无网络、无真实数据文件」下被测（设计 §1.2.6d）：
   这两个模块是「安全 + 数据完整性」的全部所在：
     · qa-store 决定「编号会不会撞、磁盘坏了会不会把内存写脏」
     · qa-auth  决定「/api/me 挂了会不会 fail-open 让台账裸奔」
   因此两者都做成依赖注入（fs / now / rand / httpGet），本文件全部用注入桩驱动：
   不读 server/users.json（身份单一来源是 /api/me 代理，设计 §1.2.1a）、
   不 require 生产 server.js（会把生产内存数据与定时器拖进测试）。

   覆盖清单（设计 §1.2.6d）：
     qa-store：加载校验（缺文件 / 坏 JSON / 结构非法 / 记录缺 id ⇒ 抛且**原文件未改动**）、
               applyCreate（编号终检、409 suggest）、
               applyUpdate（no 改名拒绝、未知字段透传、保护字段忽略）、
               原子写（.tmp + rename、写失败清理）
     qa-auth ：缓存命中 / 到期 / 超上限淘汰 / 401 清缓存 / 超时 ⇒ 503 fail-closed

   运行：node --test tests/qa-backend.test.js
   ============================================================ */

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const store = require(path.join(ROOT, 'server', 'qa-store.js'));
const auth = require(path.join(ROOT, 'server', 'qa-auth.js'));

/* 临时目录放在仓库工作区内（Windows 下 Node 会把 '/tmp' 解析成 D:\tmp 导致 ENOENT，
   与既有 tests/server.canwrite.test.js 同一处置方式），结束时清理 */
const TMP = fs.mkdtempSync(path.join(ROOT, '.qatmp-'));
after(function () {
  fs.rmSync(TMP, { recursive: true, force: true });
});

let fileSeq = 0;
/** 每个用例一个独立文件路径，避免用例间互相污染 */
function tmpFile(tag) {
  fileSeq += 1;
  return path.join(TMP, 'f' + fileSeq + '-' + (tag || 'x') + '.json');
}

const NOW = 1795396320000;                       /* 固定时刻 = 2026-11-23T01:12:00.000Z：id / createdAt 完全可预期 */
const RAND = function () { return 'a1b2c3'; };
const USER = { username: 'zhangsan', name: '张三', role: 'staff', perms: { qa: true } };
const USER_ADMIN = { username: 'admin', name: '管理员', role: 'admin', perms: {} };

/** 造一条合法记录 */
function rec(over) {
  return Object.assign({
    id: 'e_1795396320000_a1b2c3',
    no: 'YC-20261123-00001',
    date: '2026-11-23',
    createdBy: 'zhangsan',
    createdAt: '2026-11-23T01:12:00.000Z',
    updatedBy: 'zhangsan',
    updatedAt: '2026-11-23T01:12:00.000Z'
  }, over || {});
}

/** 造一份合法文档（revs 归零，便于断言自增） */
function mkDoc(records) {
  const d = store.emptyDoc();
  d[store.TABLE_KEY] = (records || []).slice();
  d.revs[store.TABLE_KEY] = 0;
  return d;
}

/** 注入式 fake fs：记录调用序列，可按需让某个方法抛错 */
function fakeFs(overrides) {
  const calls = [];
  const impl = Object.assign({
    readFileSync: function () { return ''; },
    writeFileSync: function () { },
    renameSync: function () { },
    existsSync: function () { return false; },
    unlinkSync: function () { }
  }, overrides || {});
  const out = {};
  Object.keys(impl).forEach(function (k) {
    out[k] = function () {
      calls.push(k);
      return impl[k].apply(null, arguments);
    };
  });
  out.calls = calls;
  return out;
}

/* ============================================================
   一、qa-store · 常量与 id 生成
   ============================================================ */
test('qa-store 常量：TABLE_KEY / PROTECTED_KEYS / DATA_VERSION 与设计一致', function () {
  assert.strictEqual(store.TABLE_KEY, 'qaLogs', '数据键名只允许这一处映射点');
  assert.deepStrictEqual(store.PROTECTED_KEYS,
    ['id', 'no', 'createdBy', 'createdAt', 'updatedBy', 'updatedAt']);
  assert.match(store.DATA_VERSION, /^qa-\d{4}-\d{2}-\d{2}\.\d+$/, '数据格式版本形态');
});

test('makeId：e_<13位时间戳>_<6位hex>，rand 注入后完全确定', function () {
  assert.strictEqual(store.makeId(NOW, RAND), 'e_1795396320000_a1b2c3');
  /* rand 不足 6 位补零、超长截断，恒为 6 位（否则 id 长度会漂） */
  assert.strictEqual(store.makeId(NOW, function () { return 'ab'; }), 'e_1795396320000_ab0000');
  assert.strictEqual(store.makeId(NOW, function () { return 'abcdef1234'; }), 'e_1795396320000_abcdef');
  assert.strictEqual(store.makeId(NOW, function () { return undefined; }), 'e_1795396320000_000000');
  /* 不注入时用 crypto 随机：只断言形状 */
  assert.match(store.makeId(NOW), /^e_1795396320000_[0-9a-f]{6}$/);
  /* 同一毫秒内两次调用必须不同（否则 id 会撞，PUT 会定位到错的记录） */
  assert.notStrictEqual(store.makeId(NOW), store.makeId(NOW));
  assert.match(store.makeId(new Date(NOW), RAND), /^e_1795396320000_/);
  /* rand 只被调用一次（确定性桩被调用两次会让同一个 id 变化） */
  let n = 0;
  store.makeId(NOW, function () { n += 1; return 'fff'; });
  assert.strictEqual(n, 1, 'rand 必须只被调用一次');
});

/* ============================================================
   二、qa-store · validateDoc
   ============================================================ */
test('validateDoc：合法文档通过且无返回值（契约是 void）', function () {
  assert.strictEqual(store.validateDoc(mkDoc([rec()])), undefined);
  assert.strictEqual(store.validateDoc(mkDoc([])), undefined, '空表合法');
  assert.strictEqual(store.validateDoc(store.emptyDoc()), undefined);
});

test('validateDoc：结构非法 ⇒ 抛 kind=STRUCT，消息含「qaLogs 必须为数组」', function () {
  assert.throws(function () { store.validateDoc(null); }, function (e) {
    assert.strictEqual(e.kind, 'STRUCT');
    assert.match(e.message, /顶层必须为 JSON 对象/);
    return true;
  });
  assert.throws(function () { store.validateDoc([]); }, /顶层必须为 JSON 对象/);
  assert.throws(function () { store.validateDoc('{}'); }, /顶层必须为 JSON 对象/);
  assert.throws(function () { store.validateDoc({ qaLogs: {} }); }, function (e) {
    assert.strictEqual(e.kind, 'STRUCT');
    assert.match(e.message, /qaLogs 必须为数组（实际 object）/);
    return true;
  });
  assert.throws(function () { store.validateDoc({}); }, /qaLogs 必须为数组（实际 undefined）/);
});

test('validateDoc：记录脏 ⇒ 抛 kind=RECORD（缺 id / 缺 no / 编号重复 / 格式非法）', function () {
  assert.throws(function () { store.validateDoc(mkDoc([rec({ id: '' })])); },
    /第 1 条记录缺少 id 或 no/);
  assert.throws(function () { store.validateDoc(mkDoc([rec({ id: null })])); },
    /第 1 条记录缺少 id 或 no/);
  assert.throws(function () { store.validateDoc(mkDoc([rec({ no: '' })])); },
    /第 1 条记录缺少 id 或 no/);
  assert.throws(function () { store.validateDoc(mkDoc([rec({ no: 123 })])); },
    /第 1 条记录缺少 id 或 no/);
  assert.throws(function () { store.validateDoc(mkDoc([rec({ no: 'BAD-1' })])); }, function (e) {
    assert.strictEqual(e.kind, 'RECORD');
    assert.match(e.message, /第 1 条记录编号格式非法/);
    return true;
  });
  /* 第 2 条重复（撞号说明文件被外部改过，必须拒绝启动） */
  assert.throws(function () {
    store.validateDoc(mkDoc([
      rec({ id: 'e_1_a', no: 'YC-20261123-00001' }),
      rec({ id: 'e_2_b', no: 'YC-20261123-00001' })
    ]));
  }, function (e) {
    assert.strictEqual(e.kind, 'RECORD');
    assert.match(e.message, /第 2 条记录编号重复/);
    return true;
  });
  /* 记录本身不是对象 */
  assert.throws(function () { store.validateDoc({ qaLogs: ['x'] }); }, /第 1 条记录不是对象/);
});

/* ============================================================
   三、qa-store · loadFromFile（加载失败 ⇒ 抛且**原文件/目录零改动**）
   ============================================================ */
test('loadFromFile：文件不存在 ⇒ 抛 kind=LOAD，且不创建任何文件（含 .tmp）', function () {
  const file = tmpFile('missing');
  const before = fs.readdirSync(TMP).length;
  assert.throws(function () { store.loadFromFile(file, fs); }, function (e) {
    assert.strictEqual(e.kind, 'LOAD');
    assert.match(e.message, /数据文件不存在或不可读/);
    assert.ok(e.message.indexOf(file) >= 0, '消息必须带绝对路径，否则运维不知道去哪看');
    return true;
  });
  assert.strictEqual(fs.existsSync(file), false, '绝不允许「静默初始化空文件」');
  assert.strictEqual(fs.existsSync(file + '.tmp'), false);
  assert.strictEqual(fs.readdirSync(TMP).length, before, '目录内容不得变化');
});

test('loadFromFile：JSON 解析失败 ⇒ 抛 kind=PARSE，且原文件字节未变', function () {
  const file = tmpFile('badjson');
  const broken = '{"version":"x","revs":{"qaLogs":0},"qaLogs":[{';
  fs.writeFileSync(file, broken, 'utf8');
  assert.throws(function () { store.loadFromFile(file, fs); }, function (e) {
    assert.strictEqual(e.kind, 'PARSE');
    assert.match(e.message, /JSON 解析失败/);
    return true;
  });
  assert.strictEqual(fs.readFileSync(file, 'utf8'), broken, '原文件必须逐字节保留');
  assert.strictEqual(fs.existsSync(file + '.tmp'), false);
});

test('loadFromFile：结构非法 / 记录脏 ⇒ 抛对应 kind，文件均不改动', function () {
  const f1 = tmpFile('struct');
  const body1 = JSON.stringify({ version: store.DATA_VERSION, revs: {}, qaLogs: 'nope' });
  fs.writeFileSync(f1, body1, 'utf8');
  assert.throws(function () { store.loadFromFile(f1, fs); }, function (e) {
    assert.strictEqual(e.kind, 'STRUCT');
    return true;
  });
  assert.strictEqual(fs.readFileSync(f1, 'utf8'), body1);

  const f2 = tmpFile('dirty');
  const body2 = JSON.stringify({ version: store.DATA_VERSION, revs: {}, qaLogs: [{ no: 'YC-20261123-00001' }] });
  fs.writeFileSync(f2, body2, 'utf8');
  assert.throws(function () { store.loadFromFile(f2, fs); }, function (e) {
    assert.strictEqual(e.kind, 'RECORD');
    assert.match(e.message, /缺少 id 或 no/);
    return true;
  });
  assert.strictEqual(fs.readFileSync(f2, 'utf8'), body2);
});

test('loadFromFile：合法文件 ⇒ 返回归一化文档（revs / version 缺省补齐）', function () {
  const file = tmpFile('ok');
  fs.writeFileSync(file, JSON.stringify({ qaLogs: [rec()] }), 'utf8');
  const doc = store.loadFromFile(file, fs);
  assert.strictEqual(doc[store.TABLE_KEY].length, 1);
  assert.strictEqual(doc[store.TABLE_KEY][0].no, 'YC-20261123-00001');
  assert.strictEqual(doc.version, store.DATA_VERSION, 'version 缺省补齐');
  assert.strictEqual(doc.revs[store.TABLE_KEY], 0, 'revs 缺省补 0');
});

test('loadFromFile：缺 fs 注入 ⇒ 明确报错（不静默降级）', function () {
  assert.throws(function () { store.loadFromFile(tmpFile('nofs'), {}); }, /缺少 fs 注入/);
});

/* ============================================================
   四、qa-store · initFile（幂等，永不覆盖）
   ============================================================ */
test('initFile：不存在则创建（形状 = version + revs + 空 qaLogs），已存在则未改动', function () {
  const file = tmpFile('init');
  const r1 = store.initFile(file, fs);
  assert.strictEqual(r1.created, true);
  assert.strictEqual(r1.path, file);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(onDisk.version, store.DATA_VERSION);
  assert.deepStrictEqual(onDisk.revs, { qaLogs: 0 });
  assert.deepStrictEqual(onDisk.qaLogs, []);
  assert.strictEqual(fs.existsSync(file + '.tmp'), false, '原子写必须清掉 .tmp');

  /* 幂等：第二次调用必须「未改动」 */
  const bytes = fs.readFileSync(file, 'utf8');
  const r2 = store.initFile(file, fs);
  assert.strictEqual(r2.created, false);
  assert.strictEqual(r2.doc, null);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), bytes, '已有文件绝不允许被覆盖');
});

test('initFile：绝不覆盖既有内容（哪怕内容是脏的）', function () {
  const file = tmpFile('init-dirty');
  const dirty = '{"qaLogs":[{"id":"x","no":"YC-20261123-00001"}]}';
  fs.writeFileSync(file, dirty, 'utf8');
  const r = store.initFile(file, fs);
  assert.strictEqual(r.created, false);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), dirty);
});

/* ============================================================
   五、qa-store · applyCreate
   ============================================================ */
test('applyCreate：成功 ⇒ 201，字段齐全，时间戳取注入 now，revs +1，入参文档不变', function () {
  const before = mkDoc([]);
  const snapshot = JSON.stringify(before);
  const out = store.applyCreate(before, { date: '2026-11-23' }, USER, NOW, RAND);
  assert.strictEqual(out.code, 201);
  assert.strictEqual(out.body.ok, true);
  assert.strictEqual(out.body.rev, 1);
  const r = out.body.record;
  assert.strictEqual(r.id, 'e_1795396320000_a1b2c3');
  assert.strictEqual(r.no, 'YC-20261123-00001', '缺省 no ⇒ 服务端按 F5 发号');
  assert.strictEqual(r.date, '2026-11-23');
  assert.strictEqual(r.createdBy, 'zhangsan');
  assert.strictEqual(r.updatedBy, 'zhangsan');
  assert.strictEqual(r.createdAt, '2026-11-23T01:12:00.000Z', 'createdAt 必须是 ISO UTC（Z 后缀）');
  assert.strictEqual(r.updatedAt, r.createdAt, '新建时 updatedAt === createdAt');
  assert.strictEqual(out.doc[store.TABLE_KEY].length, 1);
  assert.strictEqual(out.doc.revs[store.TABLE_KEY], 1);
  assert.strictEqual(JSON.stringify(before), snapshot, 'applyCreate 必须不可变（调用方决定是否提交）');
});

test('applyCreate：允许未来日期（PRD Q5），admin 也能写', function () {
  const out = store.applyCreate(mkDoc([]), { date: '2099-12-31' }, USER_ADMIN, NOW, RAND);
  assert.strictEqual(out.code, 201);
  assert.strictEqual(out.body.record.date, '2099-12-31');
  assert.strictEqual(out.body.record.createdBy, 'admin');
});

test('applyCreate：指定 no ⇒ 原样使用（前端预生成后提交）', function () {
  const out = store.applyCreate(mkDoc([]), { date: '2026-11-23', no: 'YC-20261123-00042' }, USER, NOW, RAND);
  assert.strictEqual(out.code, 201);
  assert.strictEqual(out.body.record.no, 'YC-20261123-00042');
});

test('applyCreate：no 冲突 ⇒ 409 + conflict:true + suggest（且 doc 为 null 不提交）', function () {
  const d = mkDoc([rec({ id: 'e_1_aaaaaa', no: 'YC-20261123-00001' })]);
  const out = store.applyCreate(d, { date: '2026-11-23', no: 'YC-20261123-00001' }, USER, NOW, RAND);
  assert.strictEqual(out.code, 409);
  assert.strictEqual(out.body.error, '编号已被占用');
  assert.strictEqual(out.body.conflict, true);
  assert.match(out.body.suggest, /^YC-\d{8}-\d{5}$/);
  assert.notStrictEqual(out.body.suggest, 'YC-20261123-00001', 'suggest 必须是没被占用的号');
  assert.strictEqual(out.doc, null);
});

test('applyCreate：400 —— date 缺失 / 非真实日期 / 请求体非对象', function () {
  assert.strictEqual(store.applyCreate(mkDoc([]), {}, USER, NOW, RAND).code, 400);
  assert.strictEqual(store.applyCreate(mkDoc([]), { date: '2026-02-31' }, USER, NOW, RAND).code, 400);
  assert.strictEqual(store.applyCreate(mkDoc([]), { date: '2026-11-23 ', }, USER, NOW, RAND).code, 400);
  assert.match(store.applyCreate(mkDoc([]), {}, USER, NOW, RAND).body.error, /日期格式不正确/);
  assert.strictEqual(store.applyCreate(mkDoc([]), [], USER, NOW, RAND).code, 400);
  assert.strictEqual(store.applyCreate(mkDoc([]), null, USER, NOW, RAND).code, 400);
  /* 数据文档本身非法 */
  assert.strictEqual(store.applyCreate({}, { date: '2026-11-23' }, USER, NOW, RAND).code, 500);
  /* 无身份 */
  assert.strictEqual(store.applyCreate(mkDoc([]), { date: '2026-11-23' }, null, NOW, RAND).code, 401);
});

test('applyCreate：400 —— no 格式非法', function () {
  const out = store.applyCreate(mkDoc([]), { date: '2026-11-23', no: 'YC-2026-11-23-1' }, USER, NOW, RAND);
  assert.strictEqual(out.code, 400);
  assert.match(out.body.error, /编号格式不正确/);
});

test('applyCreate：未知顶层**标量**键原样透传（为 P2 加字段留路，刻意不设白名单）', function () {
  const body = {
    date: '2026-11-23',
    abnormalType: '尺寸',
    qty: 3,
    urgent: true,
    remark: null
  };
  const out = store.applyCreate(mkDoc([]), body, USER, NOW, RAND);
  assert.strictEqual(out.code, 201);
  const r = out.body.record;
  assert.strictEqual(r.abnormalType, '尺寸');
  assert.strictEqual(r.qty, 3);
  assert.strictEqual(r.urgent, true);
  assert.strictEqual(r.remark, null);
  /* 落库后能被 validateDoc 接受（透传不得破坏文档结构） */
  assert.strictEqual(store.validateDoc(out.doc), undefined);
});

test('applyCreate：未知顶层**对象/数组/嵌套**键 ⇒ 400（禁止塞嵌套结构）', function () {
  const out = store.applyCreate(mkDoc([]), { date: '2026-11-23', extra: { a: 1 } }, USER, NOW, RAND);
  assert.strictEqual(out.code, 400);
  assert.match(out.body.error, /只支持标量值/);
  assert.ok(out.body.error.indexOf('extra') >= 0, '错误消息要点名是哪个字段');
  assert.strictEqual(store.applyCreate(mkDoc([]), { date: '2026-11-23', arr: [1] }, USER, NOW, RAND).code, 400);
});

test('applyCreate：保护字段被服务端权威覆盖（body 里的 id/createdBy/createdAt 一律忽略）', function () {
  const out = store.applyCreate(mkDoc([]), {
    date: '2026-11-23',
    id: 'HACKED',
    createdBy: 'hacker',
    createdAt: '1999-01-01T00:00:00.000Z',
    updatedBy: 'hacker',
    updatedAt: '1999-01-01T00:00:00.000Z'
  }, USER, NOW, RAND);
  assert.strictEqual(out.code, 201);
  const r = out.body.record;
  assert.strictEqual(r.id, 'e_1795396320000_a1b2c3');
  assert.strictEqual(r.createdBy, 'zhangsan');
  assert.strictEqual(r.createdAt, '2026-11-23T01:12:00.000Z');
  assert.strictEqual(r.updatedBy, 'zhangsan');
  assert.strictEqual(r.updatedAt, '2026-11-23T01:12:00.000Z');
});

/* ============================================================
   六、qa-store · applyUpdate
   ============================================================ */
test('applyUpdate：成功 ⇒ 200，只改 date，updatedBy/updatedAt 刷新，createdBy/createdAt 不变', function () {
  const d = mkDoc([rec()]);
  const r0 = d[store.TABLE_KEY][0];
  const out = store.applyUpdate(d, r0.id, { date: '2026-11-22' }, USER_ADMIN, NOW + 60000);
  assert.strictEqual(out.code, 200);
  assert.strictEqual(out.body.ok, true);
  assert.strictEqual(out.body.rev, 1);
  const r = out.body.record;
  assert.strictEqual(r.date, '2026-11-22');
  assert.strictEqual(r.updatedBy, 'admin');
  assert.strictEqual(r.updatedAt, '2026-11-23T01:13:00.000Z');
  assert.strictEqual(r.createdBy, 'zhangsan', 'createdBy 永不变');
  assert.strictEqual(r.createdAt, '2026-11-23T01:12:00.000Z', 'createdAt 永不变');
  assert.strictEqual(r.id, r0.id);
  assert.strictEqual(r.no, r0.no);
  /* 入参文档不可变 */
  assert.strictEqual(d[store.TABLE_KEY][0].date, '2026-11-23');
  assert.strictEqual(out.doc[store.TABLE_KEY][0].date, '2026-11-22');
});

test('applyUpdate：id 不存在 ⇒ 404 记录不存在', function () {
  const out = store.applyUpdate(mkDoc([rec()]), 'e_nope', { date: '2026-11-22' }, USER, NOW);
  assert.strictEqual(out.code, 404);
  assert.strictEqual(out.body.error, '记录不存在');
  assert.strictEqual(out.doc, null);
});

test('applyUpdate：no 改名 ⇒ 400「编号不可修改」；no 与原值相同 ⇒ 忽略放行（幂等）', function () {
  const d = mkDoc([rec()]);
  const id = d[store.TABLE_KEY][0].id;
  const bad = store.applyUpdate(d, id, { date: '2026-11-22', no: 'YC-20261123-00009' }, USER, NOW);
  assert.strictEqual(bad.code, 400);
  assert.strictEqual(bad.body.error, '编号不可修改');
  const ok = store.applyUpdate(d, id, { date: '2026-11-22', no: 'YC-20261123-00001' }, USER, NOW);
  assert.strictEqual(ok.code, 200);
  assert.strictEqual(ok.body.record.no, 'YC-20261123-00001');
});

test('applyUpdate：id / createdBy / createdAt 出现在 body ⇒ 静默忽略（服务端权威）', function () {
  const d = mkDoc([rec()]);
  const id = d[store.TABLE_KEY][0].id;
  const out = store.applyUpdate(d, id, {
    date: '2026-11-22',
    id: 'HACKED',
    createdBy: 'hacker',
    createdAt: '1999-01-01T00:00:00.000Z',
    updatedBy: 'hacker',
    updatedAt: '1999-01-01T00:00:00.000Z'
  }, USER, NOW);
  assert.strictEqual(out.code, 200);
  const r = out.body.record;
  assert.strictEqual(r.id, id);
  assert.strictEqual(r.createdBy, 'zhangsan');
  assert.strictEqual(r.createdAt, '2026-11-23T01:12:00.000Z');
  assert.strictEqual(r.updatedBy, 'zhangsan');
  assert.strictEqual(r.updatedAt, '2026-11-23T01:12:00.000Z');
});

test('applyUpdate：未知标量字段透传；未知对象字段 400', function () {
  const d = mkDoc([rec()]);
  const id = d[store.TABLE_KEY][0].id;
  const ok = store.applyUpdate(d, id, { date: '2026-11-22', remark: '已整改', qty: 2 }, USER, NOW);
  assert.strictEqual(ok.code, 200);
  assert.strictEqual(ok.body.record.remark, '已整改');
  assert.strictEqual(ok.body.record.qty, 2);
  const bad = store.applyUpdate(d, id, { date: '2026-11-22', extra: { a: 1 } }, USER, NOW);
  assert.strictEqual(bad.code, 400);
  assert.match(bad.body.error, /只支持标量值/);
});

test('applyUpdate：date 非法 / 请求体非对象 ⇒ 400', function () {
  const d = mkDoc([rec()]);
  const id = d[store.TABLE_KEY][0].id;
  assert.strictEqual(store.applyUpdate(d, id, {}, USER, NOW).code, 400);
  assert.strictEqual(store.applyUpdate(d, id, { date: '2027-02-29' }, USER, NOW).code, 400);
  assert.strictEqual(store.applyUpdate(d, id, [], USER, NOW).code, 400);
  assert.strictEqual(store.applyUpdate(d, id, null, USER, NOW).code, 400);
});

/* ============================================================
   七、qa-store · writeAtomic（原子写 + 失败清理）
   ============================================================ */
test('writeAtomic：写 .tmp → rename，落盘内容可解析且无 .tmp 残留', function () {
  const file = tmpFile('atomic');
  const d = mkDoc([rec()]);
  store.writeAtomic(file, d, fs);
  assert.strictEqual(fs.existsSync(file), true);
  assert.strictEqual(fs.existsSync(file + '.tmp'), false);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(onDisk[store.TABLE_KEY].length, 1);
  assert.strictEqual(onDisk[store.TABLE_KEY][0].no, 'YC-20261123-00001');
  /* 与生产 saveJson 同口径：JSON.stringify(obj, null, 1) */
  assert.ok(fs.readFileSync(file, 'utf8').indexOf('\n ') > 0, '缩进口径应为 1 空格');
});

test('writeAtomic：writeFileSync 失败 ⇒ 向上抛且清理 .tmp（磁盘满/权限场景）', function () {
  const f = fakeFs({
    writeFileSync: function () { throw new Error('ENOSPC: no space left on device'); }
  });
  assert.throws(function () { store.writeAtomic('/x/y.json', mkDoc([]), f); },
    /ENOSPC: no space left on device/);
  assert.deepStrictEqual(f.calls, ['writeFileSync', 'unlinkSync'], '失败后必须尝试清理 .tmp');
});

test('writeAtomic：renameSync 失败 ⇒ 向上抛且清理 .tmp', function () {
  const f = fakeFs({
    renameSync: function () { throw new Error('EXDEV: cross-device link'); }
  });
  assert.throws(function () { store.writeAtomic('/x/y.json', mkDoc([]), f); }, /EXDEV/);
  assert.deepStrictEqual(f.calls, ['writeFileSync', 'renameSync', 'unlinkSync']);
});

test('writeAtomic：缺 fs 注入 ⇒ 明确报错', function () {
  assert.throws(function () { store.writeAtomic('/x/y.json', mkDoc([]), {}); }, /缺少 fs 注入/);
});

/* ============================================================
   八、qa-auth · fail-closed 与缓存
   ============================================================ */
const ME_OK = {
  status: 200,
  json: {
    username: 'zhangsan', name: '张三', role: 'staff', status: 'active',
    perms: { qa: true, acts: {} }, mustChangePwd: false
  }
};

/** 统计调用次数的 httpGet 桩 */
function stubGet(fn) {
  const out = { calls: 0, last: null };
  out.fn = function (url, opts) {
    out.calls += 1;
    out.last = { url: url, opts: opts };
    return fn(url, opts);
  };
  return out;
}

test('createVerifier：空 token ⇒ 401 且**不发起任何请求**', async function () {
  const g = stubGet(function () { return Promise.resolve(ME_OK); });
  const v = auth.createVerifier({ meUrl: 'http://x/api/me', httpGet: g.fn });
  const cases = ['', '   ', null, undefined, 123];
  for (const t of cases) {
    const r = await v.verify(t);
    assert.strictEqual(r.status, '401', 'token=' + JSON.stringify(t) + ' 应 401');
  }
  assert.strictEqual(g.calls, 0, '空 token 绝不产生代理请求');
  assert.deepStrictEqual(v.stats(), { size: 0, hits: 0, misses: 0 });
});

test('verify：200 ⇒ ok，只保留白名单字段（不透传 mustChangePwd 等）', async function () {
  const g = stubGet(function () { return Promise.resolve(ME_OK); });
  const v = auth.createVerifier({ meUrl: 'http://x/api/me', httpGet: g.fn });
  const r = await v.verify('tok-1');
  assert.strictEqual(r.status, 'ok');
  assert.deepStrictEqual(Object.keys(r.user).sort(), ['name', 'perms', 'role', 'username']);
  assert.strictEqual(r.user.username, 'zhangsan');
  assert.deepStrictEqual(r.user.perms, { qa: true, acts: {} });
  /* token 只走 Authorization 头（安全基线 P0③：绝不拼进 URL） */
  assert.strictEqual(g.last.opts.headers.Authorization, 'Bearer tok-1');
  assert.strictEqual(g.last.url.indexOf('tok-1'), -1, 'token 绝不得出现在 URL 里');
});

test('verify：60s 内命中缓存不重复请求；到期后回源', async function () {
  const g = stubGet(function () { return Promise.resolve(ME_OK); });
  const v = auth.createVerifier({ meUrl: 'http://x/api/me', ttlMs: 60000, httpGet: g.fn });
  const realNow = Date.now;
  let clock = 1000000;
  Date.now = function () { return clock; };
  try {
    assert.strictEqual((await v.verify('t1')).status, 'ok');
    assert.strictEqual(g.calls, 1);
    clock += 59999;
    assert.strictEqual((await v.verify('t1')).status, 'ok');
    assert.strictEqual(g.calls, 1, '未到期必须命中缓存（读请求吃 60s 缓存）');
    assert.deepStrictEqual(v.stats(), { size: 1, hits: 1, misses: 1 });
    clock += 2;
    assert.strictEqual((await v.verify('t1')).status, 'ok');
    assert.strictEqual(g.calls, 2, '到期必须回源');
    assert.deepStrictEqual(v.stats(), { size: 1, hits: 1, misses: 2 });
  } finally {
    Date.now = realNow;
  }
});

test('verify：401/403 ⇒ 立刻清缓存并返回 401（收权/停用最快收敛）', async function () {
  let mode = 'ok';
  const g = stubGet(function () {
    if (mode === '401') return Promise.resolve({ status: 401, json: { error: '未登录或登录已过期' } });
    if (mode === '403') return Promise.resolve({ status: 403, json: { error: '账号已停用' } });
    return Promise.resolve(ME_OK);
  });
  const v = auth.createVerifier({ meUrl: 'http://x/api/me', ttlMs: 60000, httpGet: g.fn });
  assert.strictEqual((await v.verify('t2')).status, 'ok');
  assert.strictEqual(v.stats().size, 1);

  mode = '401';
  /* 缓存未到期时仍命中（读请求 60s 收敛窗口，设计 §1.2.1d 已接受）
     ⇒ 必须 invalidate 后才能观察到 401（写操作穿透正是这么做的） */
  v.invalidate('t2');
  assert.strictEqual((await v.verify('t2')).status, '401');
  assert.strictEqual(v.stats().size, 0, '401 必须删缓存');

  mode = '403';
  assert.strictEqual((await v.verify('t3')).status, '401', '403 也必须当 401 处理');
});

test('verify：fail-closed —— 网络错误 / 超时 / 5xx 一律 503（绝不 fail-open）', async function () {
  const cases = [
    ['reject', function () { return Promise.reject(new Error('ECONNREFUSED')); }],
    ['timeout', function () { return Promise.reject(new Error('鉴权代理请求超时（1500ms）')); }],
    ['500', function () { return Promise.resolve({ status: 500, json: null }); }],
    ['502', function () { return Promise.resolve({ status: 502, json: null }); }],
    ['no-status', function () { return Promise.resolve({}); }]
  ];
  for (const [label, fn] of cases) {
    const v = auth.createVerifier({ meUrl: 'http://x/api/me', httpGet: stubGet(fn).fn });
    const r = await v.verify('tok-' + label);
    assert.strictEqual(r.status, '503', label + ' 必须 fail-closed 返回 503');
    assert.strictEqual(r.user, undefined, label + ' 不得携带任何用户信息');
  }
});

test('verify：200 但身份不可解析 / 账号非 active ⇒ 401（绝不猜身份）', async function () {
  const bad = [
    { status: 200, json: {} },
    { status: 200, json: null },
    { status: 200, json: { username: '' } },
    { status: 200, json: { username: 'wangwu', status: 'disabled', perms: { qa: true } } },
    { status: 200, json: { username: 42 } }
  ];
  for (const res of bad) {
    const v = auth.createVerifier({ meUrl: 'http://x/api/me', httpGet: stubGet(function () { return Promise.resolve(res); }).fn });
    const r = await v.verify('tok');
    assert.strictEqual(r.status, '401', JSON.stringify(res) + ' 应判为未登录');
  }
  /* 兼容 {ok:true,user:{…}} 包裹形态（qa 侧自身 /me 形状） */
  const v2 = auth.createVerifier({
    meUrl: 'http://x/api/me',
    httpGet: stubGet(function () { return Promise.resolve({ status: 200, json: { ok: true, user: { username: 'lisi', role: 'admin' } } }); }).fn
  });
  const r2 = await v2.verify('tok');
  assert.strictEqual(r2.status, 'ok');
  assert.strictEqual(r2.user.username, 'lisi');
  assert.deepStrictEqual(r2.user.perms, {}, '缺 perms ⇒ 空对象（默认只读）');
});

test('verify：超上限按插入序淘汰最旧（maxEntries）', async function () {
  const g = stubGet(function () { return Promise.resolve(ME_OK); });
  const v = auth.createVerifier({ meUrl: 'http://x/api/me', ttlMs: 60000, maxEntries: 2, httpGet: g.fn });
  await v.verify('a');
  await v.verify('b');
  await v.verify('c');
  assert.strictEqual(v.stats().size, 2, '不得超过上限');
  const before = g.calls;
  await v.verify('c');
  await v.verify('b');
  assert.strictEqual(g.calls, before, '最近两条必须仍在缓存里');
  await v.verify('a');                       /* a 已被淘汰 ⇒ 必须回源 */
  assert.strictEqual(g.calls, before + 1, '最旧的 a 必须被淘汰');
});

test('invalidate：删缓存后必须回源（写操作穿透的基础）', async function () {
  const g = stubGet(function () { return Promise.resolve(ME_OK); });
  const v = auth.createVerifier({ meUrl: 'http://x/api/me', ttlMs: 60000, httpGet: g.fn });
  await v.verify('t');
  assert.strictEqual(g.calls, 1);
  await v.verify('t');
  assert.strictEqual(g.calls, 1, '未穿透则命中缓存');
  v.invalidate('t');
  await v.verify('t');
  assert.strictEqual(g.calls, 2, 'invalidate + verify 等价于强制真实校验');
  /* invalidate 不存在的 token 不得抛错 */
  v.invalidate('never-seen');
  v.invalidate('');
});

test('createVerifier：缺省参数与非法参数（不传 opts 也要能用）', function () {
  const v = auth.createVerifier();
  assert.strictEqual(typeof v.verify, 'function');
  assert.strictEqual(typeof v.invalidate, 'function');
  assert.strictEqual(typeof v.stats, 'function');
  assert.deepStrictEqual(v.stats(), { size: 0, hits: 0, misses: 0 });
  assert.doesNotThrow(function () { auth.createVerifier({}); });
  assert.doesNotThrow(function () { auth.createVerifier({ ttlMs: 'abc', timeoutMs: -5, maxEntries: 0 }); });
});

test('pickUser：白名单提炼（不泄露 hash/salt/mustChangePwd）', function () {
  const u = auth.pickUser({
    username: ' zhangsan ', name: '张三', role: 'staff', status: 'active',
    perms: { qa: true }, hash: 'h', salt: 's', mustChangePwd: true
  });
  assert.strictEqual(u.username, 'zhangsan', 'username 必须 trim');
  assert.strictEqual(u.hash, undefined);
  assert.strictEqual(u.salt, undefined);
  assert.strictEqual(u.mustChangePwd, undefined);
  assert.strictEqual(auth.pickUser(null), null);
  /* 缺 name/role 的兜底：name 回落 username、role 回落 staff（只读，安全默认） */
  const u2 = auth.pickUser({ username: 'x' });
  assert.strictEqual(u2.name, 'x');
  assert.strictEqual(u2.role, 'staff');
  assert.deepStrictEqual(u2.perms, {});
});
