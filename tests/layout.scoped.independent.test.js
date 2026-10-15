'use strict';
/* ============================================================
   tests/layout.scoped.independent.test.js
   QA 独立回归 · build 2026-10-15.152「列布局按账号隔离」
   ------------------------------------------------------------
   ⚠ 本文件由 QA 独立编写，**刻意不复用** tests/layout.scoped.test.js 的任何用例：
      · 服务端探针直接注入桩，覆盖工程师报告里**未提**的边界
        （expectedRev 错误值仍 200 / 空分片 {} 合法 / 旧客户端整表覆盖后 u 的去向）
      · 迁移幂等改为**子进程真实启动**探针（落盘与否用「紧凑 vs 缩进」字节判别）
      · 反潮汐改为与「.152 改前基线」（git 取源，**禁 HEAD 防对消**）**逐字**比对（非正则形态断言）
      · 端到端改为**真实子进程 + 重启读回**（非进程内自建 server）
      · 另加「前端先行 / 旧后端」真实探针（用 git 取 HEAD 的 server.js 起真服务）
   运行：node --test tests/layout.scoped.independent.test.js
   隔离：数据/用户文件指向临时目录；不启动生产服务、不触碰真实 server/data.json。
   ============================================================ */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER_JS = path.join(ROOT, 'server', 'server.js');

/* 临时目录：放在系统 temp 下（仓库内新建会被 _diag/自动发现扫到） */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qa152-indep-'));
process.env.PROD_DATA_FILE = path.join(TMP, 'data.json');
process.env.PROD_USERS_FILE = path.join(TMP, 'users.json');

const PWD = 'indep-qa-pwd';
function mkUser(username, name, role) {
  const salt = crypto.randomBytes(8).toString('hex');
  return {
    username, name, role, status: 'active', salt,
    hash: crypto.scryptSync(String(PWD), salt, 32).toString('hex'), perms: {},
  };
}
const SEED_USERS = [mkUser('admin', '管理员', 'admin'), mkUser('pmc', 'PMC', 'staff'), mkUser('chejian', '车间', 'staff')];
fs.writeFileSync(process.env.PROD_USERS_FILE, JSON.stringify(SEED_USERS));

const srv = require(SERVER_JS);
const { handleLayout, normalizeLayout } = srv;

const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const GUIDE_SRC = fs.readFileSync(path.join(ROOT, 'js', 'guide.js'), 'utf8');
const README_SRC = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const BUILD = require('./harness/build');

/* ---------- 通用工具 ---------- */
/** 去 realm：把 vm 上下文对象变回宿主 realm 的纯数据（否则 deepStrictEqual 会因原型不同假失败） */
function host(v) { return JSON.parse(JSON.stringify(v)); }
/** 落盘桩：计数 + 记录入参，用于断言「恰好 1 次 / 一字不写」 */
function spy() { const s = { n: 0, files: [], objs: [] }; s.fn = (f, o) => { s.n++; s.files.push(f); s.objs.push(o); }; return s; }
const PMC = { username: 'pmc', role: 'staff', perms: {} };
const CHE = { username: 'chejian', role: 'staff', perms: {} };
const ADMIN = { username: 'admin', role: 'admin', perms: {} };

/** 从源码文本抽取具名函数整体（含 async 前缀），返回 null 表示未找到 */
function extractFn(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(', 'g');
  const m = re.exec(src);
  if (!m) return null;
  let p = m.index + m[0].length, depth = 1;
  for (; p < src.length; p++) { if (src[p] === '(') depth++; else if (src[p] === ')') { depth--; if (!depth) break; } }
  const open = src.indexOf('{', p);
  if (open < 0) return null;
  let q = open, d2 = 0;
  for (; q < src.length; q++) { if (src[q] === '{') d2++; else if (src[q] === '}') { d2--; if (!d2) break; } }
  return src.slice(m.index, q + 1);
}
/** 取指定修订的文件文本 */
function gitShowAt(rev, rel) {
  return execFileSync('git', ['show', rev + ':' + rel], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
}
/** 从 HEAD 往回找**最近一个不含 marker 的提交**（自维护，避免硬编码 hash 随 rebase 失效）。
    用途：反潮汐/旧后端探针需要「.152 之前」的基线。
    ⚠ 绝不能用 HEAD 作基线：本文件已随 .152 一并提交，用 HEAD 会与自身对比而**对消**、
     守卫退化为恒真。tests/order.status.test.js:103-108 已记录过同一踩坑。 */
function findPreChangeRev(rel, marker) {
  const revs = execFileSync('git', ['log', '--format=%H', '-40', '--', rel], { cwd: ROOT, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  for (const r of revs) {
    try { if (gitShowAt(r, rel).indexOf(marker) < 0) return r; } catch (e) { /* 该修订无此文件，继续 */ }
  }
  return null;
}
/** 解析「改前基线」并执行**防对消守卫**：基线必须真实不含 marker，当前版本必须真实含有。
    @returns {{rev:string, text:string}} */
function resolveBaseline(rel, marker, what) {
  const rev = process.env.BASELINE_REF || findPreChangeRev(rel, marker);
  assert.ok(rev, '无法定位「' + what + '」之前的基线提交；请显式设置 BASELINE_REF');
  const text = gitShowAt(rev, rel);
  assert.strictEqual(text.indexOf(marker), -1,
    '防对消守卫：基线 ' + rev + ':' + rel + ' 仍含「' + marker + '」→ 说明基线选错（等于当前版本），守卫会退化为恒真');
  const now = rel === 'index.html' ? INDEX_SRC : fs.readFileSync(path.join(ROOT, rel), 'utf8');
  assert.ok(now.indexOf(marker) >= 0,
    '防对消守卫：当前 ' + rel + ' 必须含「' + marker + '」→ 否则两侧是同一修订，比对无意义');
  return { rev: rev, text: text };
}
/** 语义化别名：找最近一个**不含** marker 的提交（与 findPreChangeRev 同一实现） */
const findRevLacking = findPreChangeRev;

/** 精确锚定替换（主理人裁定口径，两条硬约束缺一不可）：
      ① 匹配数必须**恰为 1** —— 0 次报「锚点未命中，请同步本用例」；≥2 次报「锚点不唯一，无法安全注入」；
      ② 替换后字符串必须**确实变化**（否则变异没打进去、守卫空转）。
    **禁止**静默跳过 / 宽松匹配 / 多命中取首：那会让守卫静默退化为恒真。
    「脆但可控」优于「静默通过」—— 源码变更时本函数会**大声失败**并要求同步锚点。 */
function injectOnce(src, needle, repl, label) {
  assert.ok(needle && needle.length > 0, '锚点[' + label + ']不得为空串');
  const hits = src.split(needle).length - 1;
  assert.strictEqual(hits, 1, '锚点问题[' + label + ']：命中 ' + hits + ' 次（必须恰 1 次）→ '
    + (hits === 0 ? '锚点未命中，请同步本用例' : '锚点不唯一，无法安全注入'));
  const out = src.split(needle).join(repl);
  assert.notStrictEqual(out, src, '变异注入未生效[' + label + ']：替换前后字符串相同');
  return out;
}

/* ============================================================
   【build .152 补丁】源码锚点片段（**关键片段定位**，不再整函数全文）
   ------------------------------------------------------------
   背景：本文件第一版用**整函数全文**作变异注入锚点，源码每微调一次就失效。
   2026-10-15 主理人裁定：允许改用关键片段，但必须满足 injectOnce 的两条硬约束。
   ⚠ 这些片段若在源码中命中 0 次或 ≥2 次，本文件会**报错并要求同步** —— 这是设计意图，不是缺陷。
   ============================================================ */
const A_BE_SLICE = '      Object.keys(v.u).forEach(function (k) { if (!isLayoutMap(v.u[k])) delete v.u[k]; });\n';
const A_FE_SLICE = '\n      Object.keys(v.u).forEach(function(k){if(!isLayoutMap(v.u[k]))delete v.u[k];});';
const A_FE_PICK = 'var raw=(r.u&&currentUser)?r.u[currentUser.username]:undefined;\n  var mine=isLayoutMap(raw)?raw:(isLayoutMap(r.def)?r.def:{});';
/** 旧版（.152 补丁前）前端分片守卫 —— 仅用于在**旧修订**上复核「旧结论当时为真」 */
const A_OLD_FE_GUARD = '\n  if(!isLayoutMap(mine))mine={};';

/** 退回后端逐分片净化 */
const revertBackendSlice = (txt) => injectOnce(txt, A_BE_SLICE, '', '后端 normalizeLayout 逐分片 delete 行');
/** 退回前端 normLayoutServer 的逐分片净化 */
const revertFrontNormSlice = (main) => injectOnce(main, A_FE_SLICE, '', '前端 normLayoutServer 逐分片 delete 行');
/** 退回前端 applyServerLayout 的「取分片 + 非法回退 def」逻辑（回到补丁前的 `||r.def||{}` 形态） */
const revertFrontPick = (main) => injectOnce(main, A_FE_PICK,
  'var mine=(r.u&&currentUser&&r.u[currentUser.username])||r.def||{};', '前端 applyServerLayout 分片取值/回退');
/** 退回**前端两层** */
const revertFrontBoth = (main) => revertFrontPick(revertFrontNormSlice(main));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
/** 起一个真实 server 子进程；@param serverJsPath 可指向「旧后端」副本 */
async function startServer(serverJsPath, dataFile, usersFile) {
  const port = await freePort();
  const args = [serverJsPath];
  const proc = spawn(process.execPath, args, {
    env: Object.assign({}, process.env, {
      PORT: String(port), PROD_DATA_FILE: dataFile, PROD_USERS_FILE: usersFile,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', d => { out += d; });
  proc.stderr.on('data', d => { out += d; });
  const base = 'http://127.0.0.1:' + port;
  const deadline = Date.now() + 15000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error('server 提前退出: ' + out);
    try {
      await fetch(base + '/api/me');
      break;
    } catch (e) {
      if (Date.now() > deadline) { proc.kill(); throw new Error('server 启动超时: ' + out); }
      await new Promise(r => setTimeout(r, 80));
    }
  }
  const api = async (method, p, token, body) => {
    const opt = { method, headers: {} };
    if (token) opt.headers['Authorization'] = 'Bearer ' + token;
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const r = await fetch(base + p, opt);
    let j = null; try { j = await r.json(); } catch (e) { /* 非 JSON */ }
    return { status: r.status, body: j };
  };
  const login = async (u) => {
    const r = await api('POST', '/api/login', null, { username: u, password: PWD });
    assert.strictEqual(r.status, 200, '登录失败 ' + u + ': ' + JSON.stringify(r.body));
    return r.body.token;
  };
  const stop = () => new Promise(res => {
    if (proc.exitCode !== null) return res();
    proc.once('exit', () => res());
    proc.kill();
  });
  return { proc, base, api, login, stop, output: () => out };
}
/** 写一个「只 require 目标模块、不监听端口」的启动器，用于启动期行为探针 */
function writeLauncher(file, targetJs) {
  fs.writeFileSync(file, "'use strict';\nrequire(" + JSON.stringify(targetJs) + ");\n");
  return file;
}
const DEFAULT_KEYS = Object.keys(srv.DEFAULT_DATA);

/* 供「深拷贝」判别的服务端 v2 布局：def 与本人分片**故意不同** */
const DEF_LAY = { alpha: { order: ['a1', 'a2'], widths: { a1: 11 } }, beta: { order: ['b1'], widths: {} } };
const MINE_LAY = { alpha: { order: ['a2', 'a1'], widths: { a2: 22 } } };

/* ============================================================
   Part A · 服务端核心 —— 分片语义 / 边界（独立探针）
   ============================================================ */
test('A1 隔离性：A 保存分片后，B 的分片逐字节不变；u 同时含两者', () => {
  const data = {
    tblLayout: { v: 2, def: host(DEF_LAY), u: { chejian: host(MINE_LAY) } },
  };
  const revs = { tblLayout: 10 };
  const s = spy();
  const cheBefore = JSON.stringify(data.tblLayout.u.chejian);
  const defBefore = JSON.stringify(data.tblLayout.def);

  const pmcSlice = { alpha: { order: ['p1'], widths: { p1: 7 } } };
  const r = handleLayout(data, revs, PMC, { layout: host(pmcSlice) }, s.fn);

  assert.strictEqual(r.code, 200);
  assert.strictEqual(JSON.stringify(data.tblLayout.u.chejian), cheBefore, 'chejian 分片必须逐字节不变');
  assert.strictEqual(JSON.stringify(data.tblLayout.def), defBefore, 'def 必须逐字节不变');
  assert.deepStrictEqual(data.tblLayout.u.pmc, pmcSlice, 'pmc 分片写入正确');
  assert.deepStrictEqual(Object.keys(data.tblLayout.u).sort(), ['chejian', 'pmc'], 'u 同时含两者');
  assert.strictEqual(s.n, 1, '恰好落盘 1 次');
});

test('A2 revs.tblLayout 每次自增恰 1；缺省 rev 从 0 起（兼容旧 data.json）', () => {
  const data = { tblLayout: { v: 2, def: {}, u: {} } };
  const revs = { tblLayout: 41 };
  handleLayout(data, revs, PMC, { layout: { m: {} } }, spy().fn);
  assert.strictEqual(revs.tblLayout, 42);
  handleLayout(data, revs, CHE, { layout: { m: {} } }, spy().fn);
  assert.strictEqual(revs.tblLayout, 43, '他人保存亦推进全局 rev（用于前端轮询感知）');

  const revs2 = {};
  const r = handleLayout({ tblLayout: { v: 2, def: {}, u: {} } }, revs2, PMC, { layout: {} }, spy().fn);
  assert.strictEqual(r.body.rev, 1);
});

/* --- A3/A4：409 消除 + expectedRev 确实未被读取（工程师报告未覆盖的边界） --- */
test('A3 同一账号连续两次保存均 200（不因 rev 变化被乐观锁拒绝）', () => {
  const data = { tblLayout: { v: 2, def: {}, u: {} } };
  const revs = { tblLayout: 0 };
  const r1 = handleLayout(data, revs, PMC, { layout: { m: { order: ['x'], widths: {} } } }, spy().fn);
  const r2 = handleLayout(data, revs, PMC, { layout: { m: { order: ['x', 'y'], widths: { y: 3 } } } }, spy().fn);
  assert.strictEqual(r1.code, 200);
  assert.strictEqual(r2.code, 200, '第二次保存必须 200（这正是消除拖列 409 的诉求）');
  assert.strictEqual(r1.body.rev, 1);
  assert.strictEqual(r2.body.rev, 2);
  assert.deepStrictEqual(data.tblLayout.u.pmc, { m: { order: ['x', 'y'], widths: { y: 3 } } }, '后写覆盖自己的分片（预期：最后写入胜）');
});

test('A4 expectedRev 确实未被使用：故意带错误 expectedRev 仍 200（不是「碰巧 rev 相等」）', () => {
  const data = { tblLayout: { v: 2, def: {}, u: {} } };
  const revs = { tblLayout: 5 };
  const slice = { m: { order: ['z'], widths: {} } };
  /* 用远大于/远小于当前 rev 的错误值，若实现里存在任何 expectedRev 比较必然 409 */
  const bad = [0, 4, 6, 999999, -1, 'abc', null];
  bad.forEach(v => {
    const r = handleLayout(data, revs, PMC, { layout: host(slice), expectedRev: v }, spy().fn);
    assert.strictEqual(r.code, 200, 'expectedRev=' + JSON.stringify(v) + ' 时仍须 200（证明真没走乐观锁）');
  });
  assert.strictEqual(revs.tblLayout, 5 + bad.length, bad.length + ' 次保存各推进 1（无一次被乐观锁拦截）');

  /* 判别力对照：**老通道** /api/save 的 expectedRev 语义确实会 409（见 server.tx/canwrite 既有用例，
     故「带错误 expectedRev 却 200」是 /api/layout 的特有行为，不是环境碰巧）。 */
  const src = fs.readFileSync(SERVER_JS, 'utf8');
  assert.ok(/b\.expectedRev\s*!==\s*undefined/.test(src), '对照前提：/api/save 确有 expectedRev 乐观锁实现');
});

test('A5 400 边界：layout 非法一律 400 且一字不写；layout={} 为合法空分片 → 200', () => {
  const bad = [
    undefined, null, '', 'abc', 0, 1, true, false, [], [1], NaN,
  ];
  bad.forEach((lv, i) => {
    const data = { tblLayout: { v: 2, def: {}, u: { pmc: { keep: 1 } } } };
    const revs = { tblLayout: 3 };
    const s = spy();
    const before = JSON.stringify(data);
    const r = handleLayout(data, revs, PMC, { layout: lv }, s.fn);
    assert.strictEqual(r.code, 400, '用例#' + i + ' layout=' + String(lv) + ' 应 400');
    assert.strictEqual(s.n, 0, '用例#' + i + ' 不落盘');
    assert.strictEqual(JSON.stringify(data), before, '用例#' + i + ' 不改内存');
    assert.strictEqual(revs.tblLayout, 3, '用例#' + i + ' 不动 revs');
  });

  /* 空对象：合法（= 「我的布局为空」，回落系统默认列序） */
  const data = { tblLayout: { v: 2, def: {}, u: { pmc: { keep: 1 } } } };
  const revs = { tblLayout: 0 };
  const s = spy();
  const r = handleLayout(data, revs, PMC, { layout: {} }, s.fn);
  assert.strictEqual(r.code, 200, 'layout={} 必须 200（空分片合法）');
  assert.deepStrictEqual(data.tblLayout.u.pmc, {}, '本人分片被置为空对象');
  assert.strictEqual(s.n, 1);

  /* body 为 null / 缺省 / 未知 action：均不得抛错且须 400 */
  [{}, null, { action: 'save' }, { action: 'RESET' }].forEach((b, i) => {
    const d = { tblLayout: { v: 2, def: {}, u: {} } };
    const rr = handleLayout(d, { tblLayout: 0 }, PMC, b, spy().fn);
    assert.strictEqual(rr.code, 400, 'body 用例#' + i + ' 应 400 而非 500');
  });
});

test('A6 未登录 → 401，且内存/盘/revs 均未触碰（含非法 body 也不得先写后判）', () => {
  [{ layout: { m: {} } }, { action: 'reset' }, { action: 'resetAll' }, {}, null].forEach((b, i) => {
    const data = { tblLayout: { v: 2, def: { d: 1 }, u: { pmc: { p: 1 }, admin: { a: 1 } } } };
    const revs = { tblLayout: 9 };
    const s = spy();
    const before = JSON.stringify(data);
    const r = handleLayout(data, revs, null, b, s.fn);
    assert.strictEqual(r.code, 401, 'body 用例#' + i);
    assert.strictEqual(s.n, 0);
    assert.strictEqual(JSON.stringify(data), before);
    assert.strictEqual(revs.tblLayout, 9);
  });
});

test('A7 reset 只删自己那条；他人分片与 def 逐字节不变', () => {
  const data = { tblLayout: { v: 2, def: host(DEF_LAY), u: { pmc: { p: 1 }, chejian: { c: 2 } } } };
  const revs = { tblLayout: 1 };
  const s = spy();
  const defBefore = JSON.stringify(data.tblLayout.def);
  const cheBefore = JSON.stringify(data.tblLayout.u.chejian);

  const r = handleLayout(data, revs, PMC, { action: 'reset' }, s.fn);
  assert.strictEqual(r.code, 200);
  assert.ok(!Object.prototype.hasOwnProperty.call(data.tblLayout.u, 'pmc'), '本人分片被删');
  assert.strictEqual(JSON.stringify(data.tblLayout.u.chejian), cheBefore, '他人分片不变');
  assert.strictEqual(JSON.stringify(data.tblLayout.def), defBefore, 'def 不变');
  assert.strictEqual(s.n, 1);

  /* 幂等：再删一次仍 200（键不存在无害），且仍落盘一次 */
  const r2 = handleLayout(data, revs, PMC, { action: 'reset' }, s.fn);
  assert.strictEqual(r2.code, 200);
  assert.strictEqual(s.n, 2);
});

test('A8 resetAll：非 admin → 403 且数据对象一字不改；admin → 200 清空 u 而 def 逐字节不变', () => {
  const data = { tblLayout: { v: 2, def: host(DEF_LAY), u: { pmc: { p: 1 }, chejian: { c: 2 }, admin: { a: 3 } } } };
  const revs = { tblLayout: 7 };
  const s = spy();
  const before = JSON.stringify(data);

  const deny = handleLayout(data, revs, PMC, { action: 'resetAll' }, s.fn);
  assert.strictEqual(deny.code, 403);
  assert.strictEqual(s.n, 0, '403 不落盘');
  assert.strictEqual(JSON.stringify(data), before, '403 内存一字不改（u 未被清空）');
  assert.strictEqual(revs.tblLayout, 7, '403 不动 revs');

  const deny2 = handleLayout(data, revs, CHE, { action: 'resetAll' }, s.fn);
  assert.strictEqual(deny2.code, 403, '另一 staff 账号同样 403');
  assert.strictEqual(JSON.stringify(data), before);

  const defBefore = JSON.stringify(data.tblLayout.def);
  const ok = handleLayout(data, revs, ADMIN, { action: 'resetAll' }, s.fn);
  assert.strictEqual(ok.code, 200);
  assert.deepStrictEqual(data.tblLayout.u, {}, 'u 清空');
  assert.strictEqual(JSON.stringify(data.tblLayout.def), defBefore, 'def 逐字节不变（初始布局绝不被清）');
  assert.strictEqual(s.n, 1);
});

/* --- A9：迁移幂等（含「已是 v2 时形态与内容不变」的精确定义） --- */
test('A9 normalizeLayout 幂等：v1→v2 内容逐字进 def、u={}；v2 原样同一引用；连跑两次 deepEqual', () => {
  const v1 = { order_inv: { order: ['a', 'b'], widths: { a: 120 } }, delivery: { order: [], widths: {} } };
  const v1snap = JSON.stringify(v1);
  const n1 = normalizeLayout(host(v1));
  assert.strictEqual(n1.v, 2);
  assert.deepStrictEqual(n1.def, v1, 'v1 扁平内容逐字进 def');
  assert.deepStrictEqual(n1.u, {}, 'u 为空');
  assert.strictEqual(JSON.stringify(v1), v1snap, '入参本身未被就地改动');

  const n2 = normalizeLayout(n1);
  assert.strictEqual(n2, n1, 'v2 原样返回同一引用（幂等的最强形态）');
  assert.deepStrictEqual(host(n2), host(n1), '连跑两次 deepEqual');
  assert.strictEqual(JSON.stringify(n2), JSON.stringify(n1));

  /* 已是 v2：形态与内容必须不变（含 u 里的分片也要原封不动） */
  const v2 = { v: 2, def: host(DEF_LAY), u: { pmc: host(MINE_LAY) }, extra: 'keep' };
  const v2snap = JSON.stringify(v2);
  const n3 = normalizeLayout(v2);
  assert.strictEqual(n3, v2, 'v2 原样同一引用');
  assert.strictEqual(JSON.stringify(n3), v2snap, 'v2 形态与内容逐字节不变');

  /* 空/非法/标量 → 空 v2（不抛错、不把标量当 def） */
  [undefined, null, 0, '', 'x', true].forEach((x, i) => {
    assert.deepStrictEqual(host(normalizeLayout(x)), { v: 2, def: {}, u: {} }, '非法入参#' + i);
  });
  /* 对象但缺 v：整体进 def（与 server 端注释「原内容逐字放进 def」同口径） */
  assert.deepStrictEqual(host(normalizeLayout({ v: 1, a: 1 })), { v: 2, def: { v: 1, a: 1 }, u: {} });

  /* ---- 数组入参：必须与「空/非法」同口径 → def 归空 ----
     QA 探针在 14:40 前的版本上实测到不对称：`normalizeLayout([])` 当时返回 `def: []`（数组），
     而 handleLayout 内的 def 守卫把数组视为非法并归空 → 两处口径不一致，
     且前端 applyServerLayout 会把 `def:[]` 落到内存态 tblLayout，使 layoutOf() 在**数组实例**上挂属性。
     现源码已引入 isLayoutMap(v) 收敛；下面这条不变量正是当时能抓住它的断言。 */
  [ [], [1, 2], { a: 1 }, { v: 2 } ].forEach((x, i) => {
    const got = host(normalizeLayout(x));
    if (Array.isArray(x)) {
      assert.deepStrictEqual(got, { v: 2, def: {}, u: {} }, '数组入参#' + i + ' 必须与空/非法同口径');
      assert.deepStrictEqual(got, host(normalizeLayout({})), '数组与 {} 归一结果必须一致（口径统一不变量）');
    }
  });
  if (typeof srv.isLayoutMap === 'function') {
    assert.strictEqual(srv.isLayoutMap([]), false, 'isLayoutMap([]) 必须为 false（数组不是布局映射）');
    assert.strictEqual(srv.isLayoutMap(null), false);
    assert.strictEqual(srv.isLayoutMap('x'), false);
    /* 注意：源码注释写作「非空对象且非数组」，但实现并未判空 —— {} 返回 true。
       这与实际需要一致（空映射是合法的「无已存布局」），故仅记为文档措辞小瑕疵。 */
    assert.strictEqual(srv.isLayoutMap({}), true, '{} 被接受为空布局映射（注释「非空」为措辞不严）');
  }

  /* 兜底 1：/api/layout 拒绝数组入参 → 400（不会把数组分片写进 u） */
  const dArr = { tblLayout: { v: 2, def: {}, u: {} } };
  assert.strictEqual(handleLayout(dArr, { tblLayout: 0 }, PMC, { layout: [] }, spy().fn).code, 400);
  /* 兜底 2：若存量 data.tblLayout 本身是数组，handleLayout 会把 def 守卫归空（不会把 [] 当合法 def 传下去） */
  const dCorrupt = { tblLayout: [] };
  const rCorrupt = handleLayout(dCorrupt, { tblLayout: 0 }, PMC, { layout: { m: {} } }, spy().fn);
  assert.strictEqual(rCorrupt.code, 200);
  assert.deepStrictEqual(host(dCorrupt.tblLayout.def), {}, 'guard 把数组 def 归空 → 形状被自愈');
  assert.strictEqual(Array.isArray(dCorrupt.tblLayout.def), false);
});

/* ---- A9b：畸形布局的「不崩 + 自愈 + 幂等」不变量 ----
   刻意断言**不变量**而非实现细节：源码在 .152 交付期间仍在加固（isLayoutMap 的引入与 v2 直通净化
   都是在我探针之后落地的），断言不变量才能让本用例在实现演进中保持判别力。 */
test('A9b 畸形布局不变量：normalizeLayout 不抛错且幂等、handleLayout 自愈、前端退化为默认列序', () => {
  const malformed = [
    [], [1, 2], {}, { v: 2 }, { v: 2, def: [] }, { v: 2, u: [] },
    { v: 2, def: [], u: { pmc: [] } }, { v: 1, a: 1 }, 'x', 0, true, null, undefined,
    { v: 2, def: { m: { order: 'not-an-array', widths: null } }, u: {} },
    { v: 2, def: { m: {} }, u: { pmc: 'not-an-object' } },
  ];

  malformed.forEach((x, i) => {
    const tag = '畸形入参#' + i + ' (' + JSON.stringify(x) + ')';

    /* 1) 纯函数：不抛错；输出恒为 v2、def/u 恒为非数组对象；幂等 */
    let a;
    assert.doesNotThrow(() => { a = normalizeLayout(x === undefined ? undefined : host(x)); }, tag + ' 不得抛错');
    assert.strictEqual(a.v, 2, tag + ' v 恒为 2');
    assert.strictEqual(Array.isArray(a.def), false, tag + ' def 不得是数组');
    assert.strictEqual(Array.isArray(a.u), false, tag + ' u 不得是数组');
    const again = normalizeLayout(host(a));
    assert.deepStrictEqual(host(again), host(a), tag + ' 必须幂等');

    /* 2) 服务端 handleLayout：畸形存量不得 500；写入后形状必须被修正（自愈） */
    const d = { tblLayout: x === undefined ? undefined : host(x) };
    const revs = { tblLayout: 0 };
    let r;
    assert.doesNotThrow(() => { r = handleLayout(d, revs, PMC, { layout: { m: {} } }, spy().fn); }, tag + ' handleLayout 不得抛错');
    assert.strictEqual(r.code, 200, tag + ' handleLayout 应 200');
    assert.strictEqual(Array.isArray(d.tblLayout.def), false, tag + ' 写入后 def 被修正');
    assert.strictEqual(Array.isArray(d.tblLayout.u), false, tag + ' 写入后 u 被修正');
    assert.deepStrictEqual(host(d.tblLayout.u.pmc), { m: {} }, tag + ' 本人分片为本次提交');

    /* 3) 前端：不抛错，且 layoutOf 恒可用（退化为默认列序，不崩） */
    const app = mkApp();
    app.setGlobals({ currentUser: { username: 'pmc', role: 'staff', perms: {} } });
    assert.doesNotThrow(
      () => app.run('applyServerLayout(' + JSON.stringify(x) + ')'),
      tag + ' 前端 applyServerLayout 不得抛错'
    );
    app.run("layoutOf('zz')");
    const lo = host(JSON.parse(app.run("JSON.stringify(layoutOf('zz'))")));
    assert.ok(lo && 'widths' in lo && 'order' in lo, tag + ' layoutOf 必须返回可用的 {order,widths} 形状');
    app.dispose();
  });

  /* 可达性判定：正常 UI 路径不可达（/api/layout 拒数组 → 400；handleLayout 每次写入都自愈）。
     唯一可达路径是**刻意保留**的 `/api/save {key:'tblLayout'}` 整表覆盖（见 D6）。
     这里直接调用导出的 canWrite 判定，比正则更硬（G22-6 同口径）。 */
  assert.strictEqual(
    srv.canWrite({ username: 'pmc', role: 'staff', perms: {} }, 'tblLayout', { value: {}, data: {} }),
    true,
    'canWrite(tblLayout) 对 staff 仍放行 —— 旧标签页整表覆盖通道保留（用户已拍板不做防御）'
  );
  assert.strictEqual(
    srv.canWrite({ username: 'chejian', role: 'staff', perms: {} }, 'tblLayout', { value: {}, data: {} }),
    true
  );
});

/* --- A10：启动期「只在变化时写盘」—— 子进程真实启动 + 字节判别 --- */
test('A10 启动期迁移：v1 存量 → 真实落盘为 v2；已是 v2 → 数据文件逐字节不变（不空写盘）', () => {
  const launcher = writeLauncher(path.join(TMP, 'boot-launcher.js'), SERVER_JS);
  const usersFile = path.join(TMP, 'boot-users.json');
  fs.writeFileSync(usersFile, JSON.stringify(SEED_USERS));

  const baseData = () => {
    const d = {};
    DEFAULT_KEYS.forEach(k => { d[k] = JSON.parse(JSON.stringify(srv.DEFAULT_DATA[k])); });
    return d;
  };

  /* 情形 1：线上存量 v1 扁平 —— 用 **紧凑** JSON 写盘，便于识别「是否被重写」（saveJson 用缩进 1） */
  const c1 = path.join(TMP, 'data-v1.json');
  const legacy = { order_inv: { order: ['a', 'b'], widths: { a: 120 } } };
  const d1 = baseData(); d1.tblLayout = legacy;
  fs.writeFileSync(c1, JSON.stringify(d1));
  const size1 = fs.statSync(c1).size;

  const run1 = require('node:child_process').spawnSync(process.execPath, [launcher], {
    env: Object.assign({}, process.env, { PROD_DATA_FILE: c1, PROD_USERS_FILE: usersFile }),
    encoding: 'utf8',
  });
  assert.strictEqual(run1.status, 0, '启动器应正常退出: ' + run1.stderr);
  const after1 = JSON.parse(fs.readFileSync(c1, 'utf8'));
  assert.strictEqual(after1.tblLayout.v, 2, 'v1 被归一为 v2');
  assert.deepStrictEqual(after1.tblLayout.def, legacy, '原全局布局逐字搬进 def');
  assert.deepStrictEqual(after1.tblLayout.u, {}, 'u 置空');
  const raw1 = fs.readFileSync(c1, 'utf8');
  assert.ok(raw1.indexOf('\n ') >= 0, '文件已被 saveJson 重写（缩进 1）——证明「变化时确会落盘」');
  assert.notStrictEqual(raw1.length, size1);

  /* 情形 2：已是 v2 —— 必须**一次都不写盘**（内容与格式都逐字节不变） */
  const c2 = path.join(TMP, 'data-v2.json');
  const d2 = baseData();
  d2.tblLayout = { v: 2, def: host(DEF_LAY), u: { pmc: host(MINE_LAY) } };
  fs.writeFileSync(c2, JSON.stringify(d2));
  const bytes2 = fs.readFileSync(c2);

  const run2 = require('node:child_process').spawnSync(process.execPath, [launcher], {
    env: Object.assign({}, process.env, { PROD_DATA_FILE: c2, PROD_USERS_FILE: usersFile }),
    encoding: 'utf8',
  });
  assert.strictEqual(run2.status, 0, '启动器应正常退出: ' + run2.stderr);
  assert.deepStrictEqual(fs.readFileSync(c2), bytes2, '已是 v2 → 启动期绝不重写数据文件（字节级）');
  assert.strictEqual(run2.stdout.indexOf('.152 迁移'), -1, '不应打印迁移日志');

  /* 情形 3：迁移后再启动一次 —— 仍应零写盘（幂等的端到端形态） */
  const bytes3 = fs.readFileSync(c1);
  const run3 = require('node:child_process').spawnSync(process.execPath, [launcher], {
    env: Object.assign({}, process.env, { PROD_DATA_FILE: c1, PROD_USERS_FILE: usersFile }),
    encoding: 'utf8',
  });
  assert.strictEqual(run3.status, 0);
  assert.deepStrictEqual(fs.readFileSync(c1), bytes3, '第二次启动不得再改写（幂等）');
});

/* ============================================================
   Part B · 前端行为 —— 深拷贝铁证 / 请求通道（vm 沙箱驱动生产代码）
   ============================================================ */
const { createApp } = require('./harness/sandbox');
const { createFetchStub } = require('./harness/dom-stub');

function mkApp(stub, confirmResult) {
  const app = createApp({ installRecorder: false, confirmResult: confirmResult === undefined ? true : confirmResult });
  if (stub) app.setFetch(stub);
  app.setGlobal('renderContent', function () {});
  return app;
}
function jsonOf(app, expr) { return app.run('JSON.stringify(' + expr + ')'); }

test('B1 深拷贝铁证（判别性用例）：回落 def 后拖列/调宽**绝不**污染 def；且不与他人分片共享引用', () => {
  const app = mkApp();
  app.setGlobals({ currentUser: { username: 'pmc', role: 'staff', perms: {} } });

  /* 判别前提：本人**无**分片 → 走 def 回落分支。若实现是 `tblLayout = r.def`（无拷贝），
     则下面的就地改动会直接改到 def 本体，本用例必然失败。 */
  app.run('applyServerLayout(' + JSON.stringify({ v: 2, def: host(DEF_LAY), u: { chejian: host(MINE_LAY) } }) + ')');
  assert.strictEqual(jsonOf(app, 'tblLayout'), JSON.stringify(DEF_LAY), '无本人分片 → 回落 def');
  assert.strictEqual(app.run('tblLayout===layoutDef'), false, 'tblLayout 与 layoutDef 不得是同一对象');
  assert.strictEqual(app.run('tblLayout.alpha===layoutDef.alpha'), false, '同名模块对象也不得共享引用');

  const defSnap = jsonOf(app, 'layoutDef');
  /* 模拟拖列/调宽/删模块（生产 drag 引擎做的就是就地改 layoutOf(m)） */
  app.run("layoutOf('alpha').order.push('NEW');layoutOf('alpha').widths.a1=999;layoutOf('beta').widths.b1=1;delete tblLayout.beta;tblLayout.gamma={order:['g'],widths:{}};");
  assert.strictEqual(jsonOf(app, 'layoutDef'), defSnap, 'def（所有人的初始布局）必须逐字节不变 —— 深拷贝铁证');
  assert.deepStrictEqual(host(app.getGlobal('layoutDef')), DEF_LAY);

  /* 另一半判别：本人**有**分片时，个人改动不得污染 layoutDef，亦不得污染 layoutDef 的模块对象 */
  const app2 = mkApp();
  app2.setGlobals({ currentUser: { username: 'pmc', role: 'staff', perms: {} } });
  app2.run('applyServerLayout(' + JSON.stringify({ v: 2, def: host(DEF_LAY), u: { pmc: host(MINE_LAY) } }) + ')');
  assert.strictEqual(jsonOf(app2, 'tblLayout'), JSON.stringify(MINE_LAY), '内存态 = 本人分片');
  const defSnap2 = jsonOf(app2, 'layoutDef');
  app2.run("layoutOf('alpha').widths.a2=777;tblLayout.alpha.order.push('X');");
  assert.strictEqual(jsonOf(app2, 'layoutDef'), defSnap2, '有分片时同样不得污染 def');
  assert.strictEqual(app2.run('layoutOf("alpha")===layoutDef.alpha'), false, '本人模块对象与 def 模块对象非同一引用');

  /* 无账号（本地模式/未登录）→ def；v1 扁平入参亦被归一后取 def */
  const app3 = mkApp();
  app3.setGlobals({ currentUser: null });
  app3.run('applyServerLayout(' + JSON.stringify(host(DEF_LAY)) + ')');
  assert.strictEqual(jsonOf(app3, 'tblLayout'), JSON.stringify(DEF_LAY));
  assert.strictEqual(jsonOf(app3, 'layoutDef'), JSON.stringify(DEF_LAY));

  app.dispose(); app2.dispose(); app3.dispose();
});

test('B2 saveLayout 服务器模式：只打 /api/layout、绝不打 /api/save、绝不带 expectedRev/action', async () => {
  const stub = createFetchStub({ '/api/layout': { status: 200, body: { ok: true, rev: 3, layout: { v: 2, def: {}, u: {} } } } });
  const app = mkApp(stub);
  app.setGlobals({ currentUser: { username: 'pmc', role: 'staff', perms: {} } });
  app.run("tblLayout={order_inv:{order:['z'],widths:{z:5}}}");
  await app.run('saveLayout()');

  assert.strictEqual(stub.callsTo('/api/layout').length, 1);
  assert.strictEqual(stub.callsTo('/api/save').length, 0, '服务器模式绝不再整表写 /api/save');
  const b = stub.callsTo('/api/layout')[0].body;
  assert.deepStrictEqual(b.layout, { order_inv: { order: ['z'], widths: { z: 5 } } });
  assert.ok(!('expectedRev' in b), '不带 expectedRev（这正是消除 409 的原因）');
  assert.ok(!('action' in b), '保存走默认分支');
  app.dispose();
});

test('B3 重置（本人）：回落到 def 基线并落 /api/layout；非管理员零角色拦截', async () => {
  const stub = createFetchStub({ '/api/layout': { status: 200, body: { ok: true, rev: 1, layout: { v: 2, def: host(DEF_LAY), u: {} } } } });
  const app = mkApp(stub);
  app.setGlobals({ currentUser: { username: 'pmc', role: 'staff', perms: {} } });
  app.run('applyServerLayout(' + JSON.stringify({ v: 2, def: host(DEF_LAY), u: { pmc: host(MINE_LAY) } }) + ')');
  await app.run('resetTableLayout()');

  assert.strictEqual(jsonOf(app, 'tblLayout'), JSON.stringify(DEF_LAY), '重置 = 回到初始布局 def');
  const posts = stub.callsTo('/api/layout');
  assert.strictEqual(posts.length, 1);
  assert.deepStrictEqual(posts[0].body.layout, DEF_LAY, '落盘内容 = def 基线');
  /* staff 也必须能重置自己（不被任何角色拦截、不弹「仅管理员」） */
  assert.strictEqual(app.alerts.filter(m => /仅管理员/.test(m)).length, 0, 'staff 重置自己不得被角色守卫拦截');
  app.dispose();
});

test('B4 重置所有人：非 admin → 函数级守卫拦截且零请求；admin → confirm 后 POST {action:resetAll}', async () => {
  const stub1 = createFetchStub({});
  const app1 = mkApp(stub1);
  app1.setGlobals({ currentUser: { username: 'pmc', role: 'staff', perms: {} } });
  app1.run('resetAllTableLayout()');
  assert.strictEqual(stub1.calls.length, 0, '非管理员零请求');
  assert.ok(app1.alerts.some(m => /仅管理员/.test(m)));

  const stub2 = createFetchStub({});
  const app2 = mkApp(stub2, false);   /* confirm 取消 */
  app2.setGlobals({ currentUser: { username: 'admin', role: 'admin', perms: {} } });
  await app2.run('resetAllTableLayout()');
  assert.strictEqual(stub2.calls.length, 0, 'confirm 取消 → 零请求');
  assert.ok(app2.confirms.length >= 1, '执行前有二次确认');

  const stub3 = createFetchStub({ '/api/layout': { status: 200, body: { ok: true, rev: 9, layout: { v: 2, def: host(DEF_LAY), u: {} } } } });
  const app3 = mkApp(stub3, true);
  app3.setGlobals({ currentUser: { username: 'admin', role: 'admin', perms: {} } });
  app3.run('applyServerLayout(' + JSON.stringify({ v: 2, def: host(DEF_LAY), u: { admin: host(MINE_LAY) } }) + ')');
  await app3.run('resetAllTableLayout()');
  const posts = stub3.callsTo('/api/layout');
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].body.action, 'resetAll');
  assert.strictEqual(jsonOf(app3, 'tblLayout'), JSON.stringify(DEF_LAY), '重置后本人布局回落 def');
  assert.strictEqual(jsonOf(app3, 'layoutDef'), JSON.stringify(DEF_LAY), 'def 镜像未被破坏');

  app1.dispose(); app2.dispose(); app3.dispose();
});

test('B5 同一账号多标签页：后写覆盖自己（无 409、无合并）—— 记录为已知残余风险', () => {
  const data = { tblLayout: { v: 2, def: {}, u: {} } };
  const revs = { tblLayout: 0 };
  const tabA = { order_inv: { order: ['a'], widths: {} } };
  const tabB = { order_inv: { order: ['b'], widths: {} } };
  /* 两个标签页各自持有的是同一账号、且都**不**带 rev → 都要 200 */
  const rA = handleLayout(data, revs, PMC, { layout: host(tabA) }, spy().fn);
  const rB = handleLayout(data, revs, PMC, { layout: host(tabB) }, spy().fn);
  assert.strictEqual(rA.code, 200);
  assert.strictEqual(rB.code, 200);
  assert.deepStrictEqual(data.tblLayout.u.pmc, tabB, '最后写入者胜（无合并、无冲突提示）');
});

/* ============================================================
   Part C · 静态守卫（自己提取源码，不抄工程师断言）
   ============================================================ */
test('C1 反潮汐：6 个既有函数体与 .152 **改前基线**逐字相同（不是形态正则）', () => {
  const base = resolveBaseline('index.html', 'build 2026-10-15.152', '.152 列布局改造');
  const headHtml = base.text;
  assert.notStrictEqual(base.rev, '', '基线修订必须解析成功');
  const names = ['layoutOf', 'applyTableLayout', 'startColDrag', 'startColResize', 'syncHeadBody', 'thCol'];
  names.forEach(n => {
    const a = extractFn(INDEX_SRC, n);
    const b = extractFn(headHtml, n);
    assert.ok(a && a.length > 60, n + ' 在当前 index.html 中未抽出（守卫会退化为恒真，必须修）');
    assert.ok(b && b.length > 60, n + ' 在基线中未抽出（守卫会退化为恒真，必须修）');
    assert.strictEqual(a, b, n + ' 函数体必须与 .152 改前基线（' + base.rev.slice(0, 7) + '）逐字一致（反潮汐硬约束）');
  });
  /* 基线确实来自更早的修订（防对消的第二重证据：基线内联脚本长度与当前不同） */
  assert.notStrictEqual(headHtml.length, INDEX_SRC.length, '基线与当前必须是不同修订');
  /* J9 的两行合并策略正则必须原样存在（invadjust.143 J9 依赖） */
  const atl = extractFn(INDEX_SRC, 'applyTableLayout');
  assert.ok(atl.indexOf('var order=(lo.order||[]).filter(function(k){return curKeys.indexOf(k)>=0;});') >= 0, 'J9 第 1 行');
  assert.ok(atl.indexOf('curKeys.forEach(function(k){if(order.indexOf(k)<0)order.push(k);});') >= 0, 'J9 第 2 行');
});

test('C1b 防对消守卫自检：基线与 HEAD 必须是不同修订，且守卫能拦住「拿 HEAD 当基线」', () => {
  const marker = 'build 2026-10-15.152';
  const headRev = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const headIdx = gitShowAt('HEAD', 'index.html');
  assert.ok(headIdx.indexOf(marker) >= 0, '前提：HEAD 已含 .152 标记（.152 已提交，故 HEAD 不可作基线）');

  const base = resolveBaseline('index.html', marker, '.152 列布局改造');
  assert.strictEqual(base.text.indexOf(marker), -1, '解析出的基线必须不含 .152 标记');
  assert.notStrictEqual(base.rev, headRev, '基线修订必须 ≠ HEAD（若相等 → 与自身对比，守卫失效）');

  /* 反向自检：把「含标记的文本」套用守卫条件，必须判为「不可作基线」 */
  assert.strictEqual(headIdx.indexOf(marker) < 0, false,
    '守卫条件套在 HEAD 文本上必须得出「含标记 → 不可作基线」；若为 true 则守卫逻辑本身有问题');
});

test('C2 服务器模式路径不再整表落库：DB.set(\'tblLayout\' 全仓 0 处', () => {
  const files = ['index.html', 'js/guide.js', 'js/logs.js', 'js/import.js', 'js/prodplan-core.js', 'js/transfer.js'];
  let hits = 0;
  files.forEach(f => {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const m = s.match(/DB\.set\(\s*['"]tblLayout['"]/g) || [];
    hits += m.length;
  });
  assert.strictEqual(hits, 0, '不得再出现 DB.set(\'tblLayout\', …) 整表落库调用');
  const sl = extractFn(INDEX_SRC, 'saveLayout');
  assert.ok(sl.indexOf('postLayout') >= 0 && sl.indexOf('API_BASE') >= 0, 'saveLayout 必须分支到 /api/layout');
  assert.ok(sl.indexOf("DB.set('tblLayout'") < 0);
  /* 本地兜底仍保留 localStorage 整表写（口径与旧 DB.set 本地分支一致） */
  const local = extractFn(INDEX_SRC, 'saveLayoutLocal');
  assert.ok(/localStorage\.setItem\(KEY\+'tblLayout'/.test(local));
});

test('C3 角色守卫分布正确：resetTableLayout 无守卫；resetAllTableLayout 有守卫 + confirm', () => {
  const r1 = extractFn(INDEX_SRC, 'resetTableLayout');
  assert.ok(r1, 'resetTableLayout 必须存在');
  assert.ok(r1.indexOf('needSysAdmin') < 0, 'resetTableLayout 内不得有 needSysAdmin（全员可用）');
  assert.ok(r1.indexOf('isSysAdmin') < 0);
  assert.ok(r1.indexOf('layoutDef') >= 0, '必须回落 def 而非清零');
  assert.ok(r1.indexOf('JSON.parse(JSON.stringify') >= 0, '回落基线必须深拷贝');

  const r2 = extractFn(INDEX_SRC, 'resetAllTableLayout');
  assert.ok(r2, 'resetAllTableLayout 必须存在');
  assert.ok(/if\s*\(\s*!needSysAdmin\(\)\s*\)\s*return\s*;/.test(r2), '首句须为函数级 needSysAdmin 守卫（防 F12）');
  assert.ok(r2.indexOf('confirm(') >= 0, '须二次 confirm');
  assert.ok(/action\s*:\s*['"]resetAll['"]/.test(r2), '须提交 action:resetAll');
});

test('C4 顶栏按钮：重置=全员可见；重置所有人=admin-only；applyTopbarPerm 选择器无需改动即可覆盖', () => {
  const all = INDEX_SRC.match(/<(?:button|span)[^>]*\sdata-admin-only/g) || [];
  assert.strictEqual(all.length, 8, '带 data-admin-only 的元素总数应为 8（摘 1 加 1，集合不变）');

  const resetAll = (INDEX_SRC.match(/<button[^>]*onclick="resetAllTableLayout\(\)"[^>]*>/g) || []);
  assert.strictEqual(resetAll.length, 1);
  assert.ok(/data-admin-only/.test(resetAll[0]), '重置所有人按钮必须 data-admin-only');

  const reset = (INDEX_SRC.match(/<button[^>]*onclick="resetTableLayout\(\)"[^>]*>/g) || []);
  assert.strictEqual(reset.length, 1);
  assert.ok(!/data-admin-only/.test(reset[0]), '重置我的按钮不得 data-admin-only');

  /* 选择器未被「特化」——仍是通配的 [data-admin-only]，故新按钮自动被覆盖 */
  ['resetTopbarPerm', 'applyTopbarPerm'].forEach(fn => {
    const body = extractFn(INDEX_SRC, fn);
    assert.ok(body.indexOf("querySelectorAll('[data-admin-only]')") >= 0, fn + ' 必须仍用通配选择器');
  });
  /* 且这两个函数体与 .152 改前基线逐字一致（.152 未改动顶栏权限机制） */
  const base = resolveBaseline('index.html', 'build 2026-10-15.152', '.152 列布局改造');
  assert.strictEqual(extractFn(INDEX_SRC, 'applyTopbarPerm'), extractFn(base.text, 'applyTopbarPerm'),
    'applyTopbarPerm 相对改前基线（' + base.rev.slice(0, 7) + '）逐字不变');
});

test('C5 水印 7 锚点齐全；.152 权威水印恰 1 处、.151 水印 0 处（逐条解释 .151 残留）', () => {
  /* ① index.html 权威水印 */
  assert.strictEqual((INDEX_SRC.match(/>build 2026-10-15\.152</g) || []).length, 1, '① index.html >build …< 恰 1 处');
  assert.strictEqual((INDEX_SRC.match(/build 2026-10-14\.151/g) || []).length, 0, 'index.html 不得残留 .151 权威水印');
  /* ② harness/build.js */
  assert.strictEqual(BUILD.BUILD, '2026-10-15.152');
  assert.strictEqual(BUILD.PREV, '2026-10-14.151');
  /* ③④⑤ 两个测试文件的字面量副本 */
  const pp = fs.readFileSync(path.join(ROOT, 'tests', 'qa.ppshift-advance.independent.test.js'), 'utf8');
  const pq = fs.readFileSync(path.join(ROOT, 'tests', 'qa.prodplan-query.independent.test.js'), 'utf8');
  assert.ok(pp.indexOf("assert.equal(build.BUILD, '2026-10-15.152'") >= 0, '③ §E2 BUILD');
  assert.ok(pp.indexOf("assert.equal(build.PREV, '2026-10-14.151'") >= 0, '③ §E2 PREV');
  assert.ok(pq.indexOf("assert.equal(build.BUILD, '2026-10-15.152'") >= 0, '④ §E2 BUILD');
  assert.ok(pq.indexOf("assert.equal(build.PREV, '2026-10-14.151'") >= 0, '④ §E2 PREV');
  assert.ok(pq.indexOf('2026-10-15（build .152）') >= 0, '⑤ §E4 guide 版本行');
  /* ⑥ js/guide.js 文首 */
  assert.ok(GUIDE_SRC.indexOf('更新：2026-10-15（build .152）') >= 0, '⑥ guide.js 文首更新行');
  assert.strictEqual(GUIDE_SRC.indexOf('更新：2026-10-14（build .151）'), -1, 'guide.js 不得残留 .151');
  /* ⑦ README.md */
  assert.ok(README_SRC.indexOf('build 2026-10-15.152') >= 0, '⑦ README.md 当前版本');

  /* .151 残留逐条解释：index.html 中每一处 .151 都必须落在注释内（历史沿革注释，非水印） */
  const lines = INDEX_SRC.split('\n');
  const res = [];
  lines.forEach((ln, i) => { if (ln.indexOf('.151') >= 0) res.push({ n: i + 1, ln: ln }); });
  assert.ok(res.length > 0, '应存在（合理数量的）.151 历史注释');
  res.forEach(r => {
    assert.ok(r.ln.indexOf('/*') >= 0 || r.ln.trim().indexOf('*') === 0,
      'index.html:' + r.n + ' 的 .151 必须位于注释内，实为: ' + r.ln.trim().slice(0, 120));
    assert.ok(r.ln.indexOf('build 2026-10-14.151') < 0, 'index.html:' + r.n + ' 不得是 .151 权威水印');
  });
});

test('C6 设计契约落点：handleLayout / normalizeLayout 与路由行号与文档一致', () => {
  const src = fs.readFileSync(SERVER_JS, 'utf8');
  const lines = src.split('\n');
  const lineNo = (needle) => { const i = lines.findIndex(l => l.indexOf(needle) >= 0); return i < 0 ? -1 : i + 1; };
  assert.ok(lineNo('function normalizeLayout(v)') > 0, 'normalizeLayout 存在');
  assert.ok(lineNo('function handleLayout(data, revs, user, body, saveJsonFn)') > 0, 'handleLayout 存在');
  assert.ok(lineNo("if (p === '/api/layout' && req.method === 'POST')") > 0, 'POST /api/layout 路由存在');
  /* 路由位于统一鉴权之后（否则未登录可写） */
  assert.ok(lineNo('const user = auth(req);') < lineNo("if (p === '/api/layout' && req.method === 'POST')"),
    '/api/layout 必须位于统一鉴权之后');
  /* handleLayout 内绝不写 def（唯一写入是「def 非法 → 归空」的守卫） */
  const fn = extractFn(src, 'handleLayout');
  const defWrites = fn.split('\n').map(l => l.trim()).filter(l => /(^|[^.\w])L\.def\s*=\s*/.test(l));
  assert.strictEqual(defWrites.length, 1, 'def 赋值点应恰 1 处，实际: ' + JSON.stringify(defWrites));
  assert.ok(/^if\s*\(/.test(defWrites[0]) && /L\.def\s*=\s*\{\}/.test(defWrites[0]),
    '该唯一赋值点必须是「def 非法时归空」的守卫，实际: ' + defWrites[0]);
  assert.ok(!/L\.def\s*=\s*body|L\.def\s*=\s*[a-zA-Z]/.test(fn), 'def 绝不接受任何外部入参');
  assert.ok(fn.indexOf('expectedRev') < 0, 'handleLayout 内不得出现 expectedRev');
});

/* ============================================================
   Part D · 真实 HTTP 端到端（真实子进程 + 重启读回）
   ============================================================ */
let live, liveData, liveUsers;

before(async () => {
  liveData = path.join(TMP, 'live-data.json');
  liveUsers = path.join(TMP, 'live-users.json');
  fs.writeFileSync(liveUsers, JSON.stringify(SEED_USERS));
  /* 造线上形态的存量：v1 扁平（走启动期迁移路径） */
  const d = {};
  DEFAULT_KEYS.forEach(k => { d[k] = JSON.parse(JSON.stringify(srv.DEFAULT_DATA[k])); });
  d.tblLayout = { order_inv: { order: ['a', 'b'], widths: { a: 120 } } };
  fs.writeFileSync(liveData, JSON.stringify(d));
  live = await startServer(SERVER_JS, liveData, liveUsers);
});

after(async () => {
  if (live) await live.stop();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('D1 未登录 → 401；staff 保存本人分片 → 200 且**真落盘**；重启后读回一致', async () => {
  const r401 = await live.api('POST', '/api/layout', null, { layout: { x: { order: [], widths: {} } } });
  assert.strictEqual(r401.status, 401);
  assert.strictEqual(r401.body.error, '未登录或登录已过期');

  const pmc = await live.login('pmc');
  const slice = { order_inv: { order: ['b', 'a'], widths: { b: 44 } } };
  const r = await live.api('POST', '/api/layout', pmc, { layout: slice });
  assert.strictEqual(r.status, 200, 'staff 保存本人分片必须 200');
  assert.deepStrictEqual(r.body.layout.u.pmc, slice);

  /* 启动期迁移痕迹：def = 原 v1 扁平内容 */
  assert.deepStrictEqual(r.body.layout.def, { order_inv: { order: ['a', 'b'], widths: { a: 120 } } },
    '启动期迁移：原全局布局进 def（所有人初始值不变）');

  const onDisk = JSON.parse(fs.readFileSync(liveData, 'utf8'));
  assert.strictEqual(onDisk.tblLayout.v, 2);
  assert.deepStrictEqual(onDisk.tblLayout.u.pmc, slice, '磁盘上已有该分片');

  /* 重启读回 */
  await live.stop();
  live = await startServer(SERVER_JS, liveData, liveUsers);
  const pmc2 = await live.login('pmc');
  const d1 = await live.api('GET', '/api/data', pmc2);
  assert.strictEqual(d1.status, 200);
  assert.deepStrictEqual(d1.body.data.tblLayout.u.pmc, slice, '重启后本人分片仍在（真持久化）');
  assert.deepStrictEqual(d1.body.data.tblLayout.def, { order_inv: { order: ['a', 'b'], widths: { a: 120 } } });
});

test('D2 跨账号隔离（真实 HTTP）：pmc 写分片不影响 admin；/api/data 只回 v2 且 u 含多账号', async () => {
  const pmc = await live.login('pmc');
  const che = await live.login('chejian');
  const admin = await live.login('admin');

  const rp = await live.api('POST', '/api/layout', pmc, { layout: { order_inv: { order: ['p'], widths: {} } } });
  const rc = await live.api('POST', '/api/layout', che, { layout: { order_inv: { order: ['c'], widths: {} } } });
  assert.strictEqual(rp.status, 200);
  assert.strictEqual(rc.status, 200);

  const d = await live.api('GET', '/api/data', admin);
  assert.strictEqual(d.body.data.tblLayout.v, 2, '/api/data 永远只回 v2');
  assert.deepStrictEqual(d.body.data.tblLayout.u.pmc, { order_inv: { order: ['p'], widths: {} } });
  assert.deepStrictEqual(d.body.data.tblLayout.u.chejian, { order_inv: { order: ['c'], widths: {} } });
  assert.ok(!Object.prototype.hasOwnProperty.call(d.body.data.tblLayout.u, 'admin'), 'pmc/chejian 的写入不产生 admin 分片');

  /* 无 expectedRev 亦 200；故意带错误 expectedRev 仍 200（真实 HTTP 复核 A4） */
  const rBad = await live.api('POST', '/api/layout', pmc, { layout: { order_inv: { order: ['p2'], widths: {} } }, expectedRev: 123456 });
  assert.strictEqual(rBad.status, 200, '带错误 expectedRev 的真实 HTTP 也必须 200');
});

test('D3 真实 HTTP：同一账号连续保存均 200；两账号交叉保存均 200（409 消除）', async () => {
  const pmc = await live.login('pmc');
  const che = await live.login('chejian');
  const seq = [
    ['pmc', pmc], ['pmc', pmc], ['chejian', che], ['pmc', pmc], ['chejian', che],
  ];
  for (let i = 0; i < seq.length; i++) {
    const r = await live.api('POST', '/api/layout', seq[i][1], { layout: { m: { order: ['k' + i], widths: {} } } });
    assert.strictEqual(r.status, 200, '第 ' + (i + 1) + ' 次（' + seq[i][0] + '）必须 200');
  }
});

test('D4 真实 HTTP：resetAll staff → 403（一字不写）；admin → 200（u 清空、def 不变）', async () => {
  const pmc = await live.login('pmc');
  const che = await live.login('chejian');
  const admin = await live.login('admin');

  const before = (await live.api('GET', '/api/data', admin)).body.data.tblLayout;
  assert.ok(Object.keys(before.u).length > 0, '前提：此时 u 非空');

  const deny = await live.api('POST', '/api/layout', pmc, { action: 'resetAll' });
  assert.strictEqual(deny.status, 403);
  const deny2 = await live.api('POST', '/api/layout', che, { action: 'resetAll' });
  assert.strictEqual(deny2.status, 403);

  const after1 = (await live.api('GET', '/api/data', admin)).body.data.tblLayout;
  assert.deepStrictEqual(after1, before, '403 后数据一字未改');

  const ok = await live.api('POST', '/api/layout', admin, { action: 'resetAll' });
  assert.strictEqual(ok.status, 200);
  const after2 = (await live.api('GET', '/api/data', admin)).body.data.tblLayout;
  assert.deepStrictEqual(after2.u, {}, 'u 清空');
  assert.deepStrictEqual(after2.def, before.def, 'def 逐字节不变');
});

/* 单账号重置（真实 HTTP）：只影响自己 */
test('D5 真实 HTTP：reset 只清本人分片，他人分片保留', async () => {
  const pmc = await live.login('pmc');
  const che = await live.login('chejian');
  const admin = await live.login('admin');
  await live.api('POST', '/api/layout', pmc, { layout: { m: { order: ['p'], widths: {} } } });
  await live.api('POST', '/api/layout', che, { layout: { m: { order: ['c'], widths: {} } } });
  const before = (await live.api('GET', '/api/data', admin)).body.data.tblLayout;
  assert.deepStrictEqual(before.u.pmc, { m: { order: ['p'], widths: {} } }, '前提：本人分片存在');
  assert.deepStrictEqual(before.u.chejian, { m: { order: ['c'], widths: {} } }, '前提：他人分片存在');
  const defSnap = JSON.stringify(before.def);

  const r = await live.api('POST', '/api/layout', pmc, { action: 'reset' });
  assert.strictEqual(r.status, 200);
  const t = (await live.api('GET', '/api/data', admin)).body.data.tblLayout;
  assert.ok(!Object.prototype.hasOwnProperty.call(t.u, 'pmc'), '本人分片已删');
  assert.deepStrictEqual(t.u.chejian, { m: { order: ['c'], widths: {} } }, '他人分片保留');
  assert.strictEqual(JSON.stringify(t.def), defSnap, 'def 逐字节不变');
});

/* --- D6：零回归 + 旧客户端整表覆盖后 u 的去向（已拍板接受的遗留） --- */
test('D6 零回归：/api/save {key:tblLayout} 仍 200；随后 /api/data 为 v2，且 u 被清空、扁平内容成为 def', async () => {
  const pmc = await live.login('pmc');
  const che = await live.login('chejian');
  const admin = await live.login('admin');

  /* 先把两个账号的分片铺好，才能观察「旧标签页整表覆盖」的爆炸半径 */
  await live.api('POST', '/api/layout', pmc, { layout: { m: { order: ['p'], widths: {} } } });
  await live.api('POST', '/api/layout', che, { layout: { m: { order: ['c'], widths: {} } } });
  const pre = (await live.api('GET', '/api/data', admin)).body.data.tblLayout;
  assert.ok(pre.u.pmc && pre.u.chejian, '前提：两人都有分片');

  /* 模拟 .152 之前的旧标签页：整表覆盖 tblLayout 为 v1 扁平 */
  const legacyFlat = { order_inv: { order: ['legacy1', 'legacy2'], widths: { legacy1: 88 } } };
  const r = await live.api('POST', '/api/save', pmc, { key: 'tblLayout', value: legacyFlat });
  assert.strictEqual(r.status, 200, '零回归：canWrite(tblLayout) 仍放行 → 200');

  /* 响应体/内存态：已归一为 v2 */
  const d = await live.api('GET', '/api/data', admin);
  assert.strictEqual(d.body.data.tblLayout.v, 2, '归一生效：前端仍只看到 v2');
  assert.deepStrictEqual(d.body.data.tblLayout.def, legacyFlat, '旧扁平内容逐字成为新的 def');
  assert.deepStrictEqual(d.body.data.tblLayout.u, {},
    '【已拍板接受的遗留】u 被整体清空 —— 所有人的个人分片丢失（旧标签页仍可整表覆盖）');

  /* 磁盘形态（QA 独立发现）：/api/data 的归一**刻意不落盘**（源码注释明示），
     故旧标签页整表覆盖后，data.json 上该字段仍是 v1 扁平，直到下一次 /api/layout 写入或下次启动迁移。
     每次读取都会重新归一 → 无功能影响；但「运维直接看 data.json」会看到 v1 形态。 */
  const onDisk = JSON.parse(fs.readFileSync(liveData, 'utf8'));
  assert.deepStrictEqual(onDisk.tblLayout, legacyFlat,
    '磁盘上仍是旧标签页写入的 v1 扁平（归一不落盘）—— 已核实为设计选择，非缺陷');

  /* 自愈：任意一次 /api/layout 写入即把磁盘形态带回 v2 */
  const heal = await live.api('POST', '/api/layout', pmc, { layout: { m: { order: ['h'], widths: {} } } });
  assert.strictEqual(heal.status, 200);
  const onDisk2 = JSON.parse(fs.readFileSync(liveData, 'utf8'));
  assert.strictEqual(onDisk2.tblLayout.v, 2, '下一次分片写入即自愈为 v2 落盘');
  assert.deepStrictEqual(onDisk2.tblLayout.def, legacyFlat, 'def 保持被旧标签页覆盖后的内容');
  assert.deepStrictEqual(Object.keys(onDisk2.tblLayout.u), ['pmc'], 'u 从空重新累积，仅含本次写入者');

  /* 旧标签页的**乐观锁**通道依然存在（本轮明确不做旧客户端防御）：
     带过期 expectedRev 的整表覆盖仍 409 —— 这正是 .152 为新客户端消除的现象，旧标签页仍会遇到。 */
  const stale = await live.api('POST', '/api/save', che, { key: 'tblLayout', value: { x: 1 }, expectedRev: 0 });
  assert.strictEqual(stale.status, 409, '旧标签页带过期 expectedRev → 仍 409（未做旧客户端防御，已拍板）');
  const after409 = (await live.api('GET', '/api/data', admin)).body.data.tblLayout;
  assert.deepStrictEqual(after409.def, legacyFlat, '409 一字不写：def 未被这次覆盖改动');
});

/* --- D7：部署顺序风险 —— 前端先行（旧后端）真实探针 --- */
test('D7 前端先行（旧后端）真实探针：/api/layout 不存在 → staff 403 / admin 404；业务数据不丢不改', async () => {
  /* 「旧后端」= .152 之前的真实 server.js（由 git 取源，非自造桩）；禁对消守卫见 resolveBaseline */
  const oldBase = resolveBaseline('server/server.js', '/api/layout', '.152 列布局改造');
  const oldJs = path.join(TMP, 'old-server.js');
  fs.writeFileSync(oldJs, oldBase.text);
  assert.strictEqual(fs.readFileSync(oldJs, 'utf8').indexOf('/api/layout'), -1,
    '前提：改前基线后端（' + oldBase.rev.slice(0, 7) + '）确无 /api/layout 路由');

  const oldData = path.join(TMP, 'old-data.json');
  const oldUsers = path.join(TMP, 'old-users.json');
  fs.writeFileSync(oldUsers, JSON.stringify(SEED_USERS));
  const d = {};
  DEFAULT_KEYS.forEach(k => { d[k] = JSON.parse(JSON.stringify(srv.DEFAULT_DATA[k])); });
  d.tblLayout = { order_inv: { order: ['a'], widths: {} } };   /* 旧后端只认 v1 扁平 */
  fs.writeFileSync(oldData, JSON.stringify(d));
  const before = fs.readFileSync(oldData);

  const old = await startServer(oldJs, oldData, oldUsers);
  try {
    const pmc = await old.login('pmc');
    const admin = await old.login('admin');
    const rp = await old.api('POST', '/api/layout', pmc, { layout: { m: {} } });
    const ra = await old.api('POST', '/api/layout', admin, { layout: { m: {} } });
    assert.strictEqual(rp.status, 403, '旧后端：staff 落到「员工非管理员」闸门 → 403（**不是 404**）');
    assert.strictEqual(ra.status, 404, '旧后端：admin 落到末尾 not found → 404');
    assert.ok(rp.body && rp.body.error, '403 带可读错误，前端 alert 可展示');
    /* 业务不受影响：/api/data 仍 200 且业务表完整 */
    const dd = await old.api('GET', '/api/data', pmc);
    assert.strictEqual(dd.status, 200, '旧后端 /api/data 正常');
    assert.ok(Array.isArray(dd.body.data.products) && Array.isArray(dd.body.data.orders), '业务表结构完整');
    assert.deepStrictEqual(dd.body.data.tblLayout, { order_inv: { order: ['a'], widths: {} } }, '布局未被写坏');
    /* 布局不落库：数据文件逐字节不变 */
    assert.deepStrictEqual(fs.readFileSync(oldData), before, '失败请求一字不写（布局不落库、业务数据不动）');
  } finally {
    await old.stop();
  }
});

/* ============================================================
   Part E · 残余风险复核（可执行证据）
   ============================================================ */
test('E1 部署顺序：新前端打旧后端的失败被前端自消化（alert + return false，不写业务表）', () => {
  const post = extractFn(INDEX_SRC, 'postLayout');
  assert.ok(post.indexOf("apiReq('/layout'") >= 0, 'postLayout 走 /api/layout');
  assert.ok(!/save\(|DB\.set|DB\.tx/.test(post), '失败路径不得退化为整表写业务/系统表');
  assert.ok(/alert\(/.test(post) && /return false/.test(post), '失败须 alert 并 return false（不静默丢失）');
  assert.ok(post.indexOf('expectedRev') < 0, 'postLayout 不带 expectedRev');
  /* 401 由 apiReq 统一 showLogin()，postLayout 不得重复弹窗 */
  assert.ok(/unauthorized/.test(post), '401 分支须识别 unauthorized 以免重复提示');
});

test('E2 def 无 UI 修改入口：前端从不上传 def；服务端 def 仅由迁移/守卫写入', () => {
  /* 前端提交体只有两种：{layout:<本人扁平>} 与 {action:'resetAll'} —— 都不含 def */
  const sl = extractFn(INDEX_SRC, 'saveLayout');
  assert.ok(sl.indexOf('postLayout({layout:tblLayout})') >= 0, 'saveLayout 只提交 {layout:tblLayout}');
  const r2 = extractFn(INDEX_SRC, 'resetAllTableLayout');
  assert.ok(r2.indexOf("JSON.stringify({action:'resetAll'})") >= 0, "resetAll 只提交 {action:'resetAll'}");
  /* postLayout 只把入参 body 原样 JSON 化（不做任何 def 注入） */
  const post = extractFn(INDEX_SRC, 'postLayout');
  assert.ok(/JSON\.stringify\(body\|\|\{\}\)/.test(post), 'postLayout 只序列化入参，不自造 body');
  assert.ok(!/\bdef\b\s*:/.test(post), 'postLayout 内不得构造 def 字段');
  /* 服务端：def 的写入点仅「非法时归空」守卫（另有启动期迁移与 /api/save 遗留通道，见 D6/D7） */
  const src = fs.readFileSync(SERVER_JS, 'utf8');
  const defAssign = src.split('\n').map(l => l.trim())
    .filter(l => /(^|[^.\w])L\.def\s*=/.test(l));
  assert.strictEqual(defAssign.length, 1, '服务端 def 赋值点应恰 1 处，实际: ' + JSON.stringify(defAssign));
  assert.ok(/L\.def\s*=\s*\{\}/.test(defAssign[0]));
});

test('E3 resetTableLayout 的 m 形参在线上无调用点（死分支，仅作将来扩展）', () => {
  /* 排除函数定义行本身，只看调用点 */
  const calls = (INDEX_SRC.match(/(?<!function\s)resetTableLayout\s*\([^)]*\)/g) || []);
  const withArg = calls.filter(c => c.replace(/\s/g, '') !== 'resetTableLayout()');
  assert.deepStrictEqual(withArg, [], '线上没有传 m 的调用点（若将来接入单模块重置，需补测 def[m] 分支）');
});

test('E4 临时目录与夹具自清理确认', () => {
  /* TMP 在 after() 中删除；此处仅断言本次探针产出的中间文件都在 TMP 内（不污染仓库） */
  assert.ok(fs.existsSync(TMP), 'TMP 在测试运行期间存在');
  const entries = fs.readdirSync(TMP);
  assert.ok(entries.includes('data-v1.json') && entries.includes('data-v2.json'), '启动期探针文件均在 TMP 内');
  /* 仓库根不得出现本文件新建的临时目录 */
  const leaked = fs.readdirSync(ROOT).filter(n => n.indexOf('qa152-indep-') === 0);
  assert.deepStrictEqual(leaked, [], '仓库根不得残留 qa152-indep-* 临时目录');
});

/* ============================================================
   Part F · 追加必查项（前后端归一口径 / 可达攻击面 / 加固必要性）
   ============================================================ */

/* ---------- F1：前后端归一口径一致性矩阵 ----------
   本轮最大结构性风险：`normLayoutServer`（前端）与 `normalizeLayout`+`isLayoutMap`（后端）
   是**两个运行时各写一份同口径函数**。这里对同一批输入逐项对拍，产出必须逐字段相同。 */
test('F1 前后端归一口径一致性矩阵：18 类输入前后端产出必须一致且形状恒合法（+ 回退语义对照）', () => {
  const cases = [
    ['① 空数组 []', []],
    ['② 空对象 {}', {}],
    ['③ 字符串 "x"', 'x'],
    ['④ 数字 0', 0],
    ['⑤ null', null],
    ['⑥ undefined', undefined],
    ['⑦ 合法 v2 {v:2,def:{},u:{}}', { v: 2, def: {}, u: {} }],
    ['⑧ 合法 v1 扁平 {order_frame:{order:[],widths:{}}}', { order_frame: { order: [], widths: {} } }],
    ['⑨ 半成品 v2 {v:2}', { v: 2 }],
    ['⑩ 半成品 v2 {v:2,def:[]}', { v: 2, def: [] }],
    ['⑪ 半成品 v2 {v:2,u:[]}', { v: 2, u: [] }],
    ["⑫ v 是别的东西 {v:3}", { v: 3, def: {}, u: {} }],
    ["⑬ v 是别的东西 {v:'2'}", { v: '2', def: {}, u: {} }],
    ["⑭ 分片非法 {v:2,def:{},u:{pmc:'x'}}", { v: 2, def: {}, u: { pmc: 'x' } }],
    ['⑮ 分片非法 {v:2,def:{},u:{pmc:[]}}', { v: 2, def: {}, u: { pmc: [] } }],
    /* ⑯⑰⑱：build .152 补丁（逐分片净化）新增的对拍面 */
    ["⑯ 混合分片（非法删 + 合法留）{v:2,def:{},u:{pmc:'x',chejian:<合法>}}",
      { v: 2, def: {}, u: { pmc: 'x', chejian: { m: { order: [], widths: {} } } } }],
    ['⑰ 合法空对象分片 {v:2,def:{},u:{pmc:{}}}（**不得**被净化误删）',
      { v: 2, def: {}, u: { pmc: {} } }],
    ['⑱ 合法分片 {v:2,def:{},u:{pmc:{m:{order:[],widths:{}}}}}',
      { v: 2, def: {}, u: { pmc: { m: { order: [], widths: {} } } } }],
  ];

  const app = mkApp();
  app.setGlobals({ currentUser: { username: 'pmc', role: 'staff', perms: {} } });

  cases.forEach(c => {
    const label = c[0], x = c[1];
    /* 后端：normalizeLayout(x)；前端：normLayoutServer(x)（两者都含就地改动，故各喂全新字面量） */
    const back = host(normalizeLayout(x === undefined ? undefined : host(x)));
    const front = host(JSON.parse(app.run('JSON.stringify(normLayoutServer(' + JSON.stringify(x) + '))')));

    assert.deepStrictEqual(front, back,
      '【口径失配】' + label + '\n  前端=' + JSON.stringify(front) + '\n  后端=' + JSON.stringify(back));
    [['后端', back], ['前端', front]].forEach(p => {
      assert.strictEqual(p[1].v, 2, label + ' ' + p[0] + ' v 恒为 2');
      assert.strictEqual(Array.isArray(p[1].def), false, label + ' ' + p[0] + ' def 不得为数组');
      assert.strictEqual(Array.isArray(p[1].u), false, label + ' ' + p[0] + ' u 不得为数组');
      assert.ok(p[1].def && typeof p[1].def === 'object', label + ' ' + p[0] + ' def 必须是对象');
      assert.ok(p[1].u && typeof p[1].u === 'object', label + ' ' + p[0] + ' u 必须是对象');
    });

    /* 关键：把归一结果交给 applyServerLayout 后，内存态必须**恒为合法布局映射**
       （数组/字符串/数字/null 都不允许 —— 否则 layoutOf 会在非对象上挂属性） */
    app.run('applyServerLayout(' + JSON.stringify(back) + ')');
    assert.strictEqual(app.run('Array.isArray(tblLayout)'), false, label + ' 内存态不得为数组');
    assert.strictEqual(app.run("typeof tblLayout==='object'&&tblLayout!==null"), true,
      label + ' 内存态必须是对象（实际 typeof=' + app.run('typeof tblLayout') + '）');
    assert.strictEqual(app.run("typeof layoutDef==='object'&&layoutDef!==null&&!Array.isArray(layoutDef)"), true,
      label + ' def 镜像必须是对象');
    /* layoutOf 必须始终能给出可用的 {order,widths}（不抛错、不返回 null/undefined） */
    app.run("layoutOf('probe')");
    assert.strictEqual(app.run("typeof layoutOf('probe')==='object'&&layoutOf('probe')!==null"), true,
      label + ' layoutOf 必须返回对象');
  });

  /* ---------- ⑲「delete vs 落 `{}`」的回退语义对照（用户可见差别，必须钉住）----------
     补丁要求非法分片**删键**而非归 `{}`：`{}` 本身是合法布局映射，会被当成「该账号自己的空布局」
     ⇒ 看到**系统默认列序**；删键 = 「无有效自定义布局」⇒ 回退 **def 初始布局**。二者用户可见结果不同。 */
  const DEFC = { alpha: { order: ['a1'], widths: {} } };
  const probe = (u) => {
    app.run('applyServerLayout(' + JSON.stringify({ v: 2, def: host(DEFC), u: u }) + ')');
    return jsonOf(app, 'tblLayout');
  };
  assert.strictEqual(probe({ pmc: 'x' }), JSON.stringify(DEFC), '非法分片(字符串) → 回退 def（**不是** {}）');
  assert.strictEqual(probe({ pmc: [] }), JSON.stringify(DEFC), '非法分片(数组) → 回退 def');
  assert.strictEqual(probe({}), JSON.stringify(DEFC), '无本人分片 → 回退 def');
  assert.strictEqual(probe({ pmc: {} }), '{}', '合法**空对象**分片 → 取本人（**不**回退 def）');
  assert.strictEqual(probe({ pmc: { m: { order: null, widths: {} } } }), '{"m":{"order":null,"widths":{}}}',
    '合法分片 → 取本人');
  assert.notStrictEqual(probe({ pmc: [] }), '{}',
    '钉死差别：非法分片的结果**不得**等于「合法空布局」的结果（否则用户会从初始布局掉到默认列序）');
  app.dispose();
});

/* ---------- F2：畸形 v2 经 /api/save 灌入（真实 HTTP 可达攻击面）----------
   /api/save {key:'tblLayout'} 刻意放行任意值 → 这是**唯一**能把任意形状灌进全局布局的通道。
   build .152 补丁后服务端 `normalizeLayout` **逐分片净化**（非法分片用 delete 删键）。
   本用例断言**新契约**：非法分片键被删除、**合法分片与空对象 `{}` 不得被误删**、前端内存态恒合法。
   📌 本文件早先版本此处断言的是「服务端未按账号净化」（把缺陷当作正确行为），缺陷修复后已按新契约改写。 */
test('F2 攻击面：畸形 v2 经 /api/save → 服务端按分片净化（非法删键；合法与 `{}` 保留）', async () => {
  const pmc = await live.login('pmc');
  const admin = await live.login('admin');

  /* ---------- 第 1 段：非法分片必须被**服务端**删键（本次补丁的目标） ---------- */
  const r1 = await live.api('POST', '/api/save', pmc, { key: 'tblLayout', value: { v: 2, def: [], u: { pmc: 'x' } } });
  assert.strictEqual(r1.status, 200, '/api/save 上 tblLayout 放行（可达前提；零回归不变）');

  const t1 = (await live.api('GET', '/api/data', admin)).body.data.tblLayout;
  assert.strictEqual(t1.v, 2);
  assert.strictEqual(Array.isArray(t1.def), false, '① 顶层 def 被服务端净化为非数组');
  assert.deepStrictEqual(t1.def, {}, '① def 归空');
  assert.ok(!('pmc' in t1.u), '① 服务端已按账号分片净化：非法分片键 u.pmc 被**删除**');
  assert.strictEqual(t1.u.pmc, undefined, '① delete 语义：u.pmc 必须为 undefined（而非归 `{}`）');
  assert.strictEqual(Array.isArray(t1.u), false, '① u 本身仍是非数组对象');

  /* ---------- 第 2 段：净化**不得误伤** —— 合法分片逐字节保留、空对象 `{}` 保留 ---------- */
  const legal = { order_frame: { order: ['a'], widths: { a: 120 } } };
  const r2 = await live.api('POST', '/api/save', pmc, {
    key: 'tblLayout',
    value: { v: 2, def: {}, u: { pmc: host(legal), chejian: {}, admin: 'x' } },
  });
  assert.strictEqual(r2.status, 200);
  const t2 = (await live.api('GET', '/api/data', admin)).body.data.tblLayout;
  assert.deepStrictEqual(t2.u.pmc, legal, '② 合法分片必须**逐字节保留**（防过度净化）');
  assert.ok('chejian' in t2.u,
    '② 合法**空对象**分片 `{}` 必须保留 —— 它是合法布局映射，误删会把该账号从「自己的空布局」推去「回退 def」，用户可见语义改变');
  assert.deepStrictEqual(t2.u.chejian, {}, '② 空对象分片内容仍为 {}');
  assert.ok(!('admin' in t2.u), '② 非法分片 admin 被删除（与合法分片并存时逐键判断）');

  /* ---------- 第 3 段：前端内存态 —— 非法分片回退 def；合法分片取本人 ---------- */
  const DEFC = { alpha: { order: ['a1'], widths: {} } };
  const payload = { v: 2, def: host(DEFC), u: { pmc: 'x', chejian: {} } };
  const app = mkApp();
  app.setGlobals({ currentUser: { username: 'admin', role: 'admin', perms: {} } });
  app.run('applyServerLayout(' + JSON.stringify(payload) + ')');
  assert.strictEqual(app.run('Array.isArray(tblLayout)'), false, '③ 内存态不得为数组');
  assert.strictEqual(app.run("typeof tblLayout==='string'"), false, '③ 内存态不得为字符串');
  assert.strictEqual(jsonOf(app, 'tblLayout'), JSON.stringify(DEFC), '③ admin 无有效分片 → 回退 def 初始布局');
  app.setGlobals({ currentUser: { username: 'chejian', role: 'staff', perms: {} } });
  app.run('applyServerLayout(' + JSON.stringify(payload) + ')');
  assert.strictEqual(jsonOf(app, 'tblLayout'), '{}',
    '③ chejian 的合法**空**分片 → 取本人 `{}`（**不**回退 def）—— 与非法分片的可见差别');
  app.run("layoutOf('delivery')");
  assert.strictEqual(app.run("typeof layoutOf('delivery')==='object'&&layoutOf('delivery')!==null"), true,
    '③ layoutOf 必须仍能给出可用记录（不在非对象上挂属性）');
  app.dispose();

  /* 清理：把分片改回合法值，避免影响后续用例 */
  await live.api('POST', '/api/layout', pmc, { layout: { m: { order: ['ok'], widths: {} } } });
});

/* ============================================================
   F3 · 加固必要性判定（变异注入）—— **新旧两版结论并列**
   ------------------------------------------------------------
   设计在 .152 补丁（后端逐分片 delete + 前端镜像）前后发生变化，旧结论的部分前提已失效。
   两版并列如下，并各自用变异注入验证（**不把旧结论套到新设计上**）：

   旧结论（补丁前源码 = 修订 findRevLacking('index.html', A_FE_SLICE)）
     · 前端 `applyServerLayout` 的 `if(!isLayoutMap(mine))mine={};` 是**唯一防线**：
       单独退回它即可复现「内存态变字符串、layoutOf 返回 undefined」。
     · 当时为真 —— 由 N1_old 在**旧修订**上复现，故不是"事后诸葛"。

   新结论（当前源码）
     · 后端 `normalizeLayout` 逐分片 delete 承担**主要防线**（同时保证 /api/data 形状纯度）；
     · 前端两层（`normLayoutServer` 删键 + `applyServerLayout` 非法分片回退 def）**互为冗余**
       ⇒ 单独退回任一层**不再复现**（N1b_new / N1c_new）；
     · 「整套」仍必要：全退才复现非法内存态（N3_new）。

   变异注入锚点统一走 injectOnce()：**命中必须恰 1 次 + 替换必须确实生效**，否则本用例
   大声失败并要求同步锚点（防止守卫静默退化为恒真 —— 本文件 C1/C4/D7 曾因基线选取不当
   退化为恒真，同一失效模式不重复发生）。
   ============================================================ */
test('F3 加固必要性（新旧并列）：N1_old 旧版单层即复现 / N1b、N1c 新版单层已冗余 / N2 后端保形状 / N3 全退复现', async () => {
  const BAD = { v: 2, def: { alpha: 1 }, u: { pmc: 'x' } };

  /* ---------- N1_old：在**补丁前修订**上退回当时唯一的守卫 → 复现（证明旧结论当时为真）---------- */
  const oldRev = findRevLacking('index.html', A_FE_SLICE);
  assert.ok(oldRev, '未能定位「无前端逐分片净化」的修订（防对消：不可用 HEAD 代替）');
  const oldHtml = gitShowAt(oldRev, 'index.html');
  assert.strictEqual(oldHtml.indexOf(A_FE_SLICE), -1, '前提：该旧修订不含前端逐分片净化');
  assert.ok(oldHtml.indexOf(A_OLD_FE_GUARD) >= 0, '前提：该旧修订含旧版 mine 守卫');
  assert.strictEqual(INDEX_SRC.indexOf(A_OLD_FE_GUARD), -1, '前提：当前源码已无旧版 mine 守卫（两侧必须是不同修订）');

  const appOld = createApp({
    installRecorder: false, indexHtml: oldHtml,
    transformMain: (m) => injectOnce(m, A_OLD_FE_GUARD, '', '旧版 applyServerLayout mine 守卫'),
  });
  appOld.setGlobal('renderContent', function () {});
  appOld.setGlobals({ currentUser: { username: 'pmc', role: 'staff', perms: {} } });
  appOld.run('applyServerLayout(' + JSON.stringify(BAD) + ')');
  assert.strictEqual(appOld.run("typeof tblLayout==='string'"), true,
    'N1_old：旧修订上退回该守卫 → 内存态真的变成字符串 ⇒ **旧结论（唯一防线）当时为真**');
  assert.strictEqual(appOld.run("layoutOf('d')===undefined"), true,
    'N1_old 佐证危害：字符串上挂属性静默失败 → layoutOf 返回 undefined（下游取值即 TypeError）');
  appOld.dispose();

  /* ---------- N1b_new：只退前端「回退 def」逻辑（保留后端 + 前端删键）→ 不再复现 ---------- */
  const appN1b = createApp({ installRecorder: false, transformMain: revertFrontPick });
  appN1b.setGlobal('renderContent', function () {});
  appN1b.setGlobals({ currentUser: { username: 'pmc', role: 'staff', perms: {} } });
  appN1b.run('applyServerLayout(' + JSON.stringify(BAD) + ')');
  assert.strictEqual(appN1b.run("typeof tblLayout==='string'"), false,
    'N1b_new：只退「回退 def」逻辑 → 不再复现（前端删键已把非法分片摘掉）⇒ 该层单独已冗余');
  assert.strictEqual(jsonOf(appN1b, 'tblLayout'), JSON.stringify(BAD.def),
    'N1b_new：结果回退到 def（合法基线，不崩）');
  appN1b.dispose();

  /* ---------- N1c_new：只退前端「逐分片删键」→ 由「回退 def」兜住，不再复现 ---------- */
  const appN1c = createApp({ installRecorder: false, transformMain: revertFrontNormSlice });
  appN1c.setGlobal('renderContent', function () {});
  appN1c.setGlobals({ currentUser: { username: 'pmc', role: 'staff', perms: {} } });
  appN1c.run('applyServerLayout(' + JSON.stringify(BAD) + ')');
  assert.strictEqual(appN1c.run("typeof tblLayout==='string'"), false,
    'N1c_new：只退前端删键 → 「回退 def」兜住，不再复现 ⇒ 两层互为冗余（纵深防御）');
  appN1c.dispose();

  /* ---------- N1d_new：前端**两层同时**退回 → 复现（前端的防护集合仍是必要的）---------- */
  const appN1d = createApp({ installRecorder: false, transformMain: revertFrontBoth });
  appN1d.setGlobal('renderContent', function () {});
  appN1d.setGlobals({ currentUser: { username: 'pmc', role: 'staff', perms: {} } });
  appN1d.run('applyServerLayout(' + JSON.stringify(BAD) + ')');
  assert.strictEqual(appN1d.run("typeof tblLayout==='string'"), true,
    'N1d_new：前端两层同退 → 非法内存态复现 ⇒ 前端这对防护作为**集合**仍是必要的');
  appN1d.dispose();

  /* ---------- N2_new / N3_new：后端逐分片 delete 的作用（真实子进程）---------- */
  const mutServer = path.join(TMP, 'no-be-slice-server.js');
  fs.writeFileSync(mutServer, revertBackendSlice(fs.readFileSync(SERVER_JS, 'utf8')));
  const beData = path.join(TMP, 'be-data.json');
  const beUsers = path.join(TMP, 'be-users.json');
  fs.writeFileSync(beUsers, JSON.stringify(SEED_USERS));
  const seed = {};
  DEFAULT_KEYS.forEach(k => { seed[k] = JSON.parse(JSON.stringify(srv.DEFAULT_DATA[k])); });
  seed.tblLayout = { v: 2, def: {}, u: {} };
  fs.writeFileSync(beData, JSON.stringify(seed));

  const mut = await startServer(mutServer, beData, beUsers);
  try {
    const tok = await mut.login('pmc');
    await mut.api('POST', '/api/save', tok, { key: 'tblLayout', value: { v: 2, def: {}, u: { pmc: 'x' } } });
    const t = (await mut.api('GET', '/api/data', tok)).body.data.tblLayout;
    assert.strictEqual(t.u.pmc, 'x',
      'N2_new：退掉后端逐分片 delete → /api/data **真的**吐出非法分片 u.pmc="x" ⇒ 该层对**形状纯度**必要');

    const appSafe = mkApp();
    appSafe.setGlobals({ currentUser: { username: 'pmc', role: 'staff', perms: {} } });
    appSafe.run('applyServerLayout(' + JSON.stringify(host(t)) + ')');
    assert.strictEqual(appSafe.run("typeof tblLayout==='string'"), false,
      'N2_new：硬化前端独立兜底 → 内存态仍合法 ⇒ 后端该层对「不崩」并非唯一防线（互为纵深）');
    appSafe.dispose();

    const appBad = createApp({ installRecorder: false, transformMain: revertFrontBoth });
    appBad.setGlobal('renderContent', function () {});
    appBad.setGlobals({ currentUser: { username: 'pmc', role: 'staff', perms: {} } });
    appBad.run('applyServerLayout(' + JSON.stringify(host(t)) + ')');
    assert.strictEqual(appBad.run("typeof tblLayout==='string'"), true,
      'N3_new：后端 + 前端两层**全退** → 非法内存态复现 ⇒ **整套加固是必要的**');
    appBad.run("layoutOf('d')");
    assert.strictEqual(appBad.run("layoutOf('d')===undefined"), true, 'N3_new 佐证危害同 N1_old');
    appBad.dispose();
  } finally {
    await mut.stop();
  }
});

/* ---------- F4：锚定守卫自检（证明 injectOnce 本身不恒真）----------
   主理人裁定的两条硬约束若自身失效，整套变异注入就会静默变成恒真。
   这里**反向**验证：未命中 / 多命中 / 替换未生效 三种情况都必须**报错**。 */
test('F4 锚定守卫自检：injectOnce 对「未命中/多命中/替换未生效」必须报错，且现用锚点各命中恰 1 次', () => {
  assert.throws(() => injectOnce('abc', 'NOT_THERE', '', '未命中'), /锚点未命中，请同步本用例/,
    '命中 0 次必须报错（不得静默跳过）');
  assert.throws(() => injectOnce('xAyAz', 'A', '', '多命中'), /锚点不唯一，无法安全注入/,
    '命中 ≥2 次必须报错（不得取首个）');
  assert.throws(() => injectOnce('abc', 'abc', 'abc', '替换未生效'), /变异注入未生效/,
    '替换后字符串未变化必须报错（防"以为注入成功、其实空转"）');
  assert.strictEqual(injectOnce('x A y', 'A', 'B', '正常'), 'x B y', '恰 1 命中且确实变化 → 正常替换');

  /* 现用锚点必须各命中恰 1 次（否则本条自身也会报错，属有意设计） */
  const serverSrc = fs.readFileSync(SERVER_JS, 'utf8');
  [['index.html', INDEX_SRC, A_FE_SLICE], ['index.html', INDEX_SRC, A_FE_PICK],
    ['server/server.js', serverSrc, A_BE_SLICE]].forEach(p => {
    assert.strictEqual(p[1].split(p[2]).length - 1, 1, p[0] + ' 锚点必须命中恰 1 次');
  });
  /* 防对消：旧版守卫锚点不得出现在当前源码（它只应存在于旧修订上） */
  assert.strictEqual(INDEX_SRC.split(A_OLD_FE_GUARD).length - 1, 0,
    'A_OLD_FE_GUARD 不应出现在当前 index.html（否则 N1_old 会与当前版本对消）');
});
