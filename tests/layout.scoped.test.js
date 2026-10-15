'use strict';
/* ============================================================
   build 2026-10-15.152 · 列布局（tblLayout）按账号隔离 测试
   ------------------------------------------------------------
   需求：列布局由「全公司共用一份」改为「服务端按账号分片」，并消除并发拖列 /api/save 的 409。

   Part A · 服务端纯净核心（注入桩，直接调 handleLayout / normalizeLayout）：
     L1 未登录 → 401，一字不写
     L2 A 写自己的分片不影响 B 的分片（核心用例）
     L3 保存后 revs.tblLayout 自增、返回的 layout.u[me] 正确
     L4 action:'reset' 只删自己那条
     L5 action:'resetAll'：admin → 200 且 u 清空、def 不变；非 admin → 403 且一字不写
     L6 body.layout 非对象/缺省 → 400（一字不写）
     L7 v1→v2 归一幂等；v1 扁平内容逐字进 def、u 为空

   Part B · 前端静态守卫（读 index.html 源码文本断言）：
     F1 服务器模式下 saveLayout 不写整表（应改走 /api/layout 分片端点）
     F2 applyServerLayout 存在且含深拷贝（防与 def 共享引用）
     F3 resetTableLayout 不再含 needSysAdmin()（改为所有用户可用）
     F4 resetAllTableLayout 含 needSysAdmin() 函数级守卫
     F5 反潮汐守卫：layoutOf / applyTableLayout 既有形态未被改动（复用 J9 两行正则）
     F6 读入点已改写（initApp / rehydrateFromServer 均经 applyServerLayout）
     F7 顶栏按钮：重置=全员可见；重置所有人=管理员专属（data-admin-only 元素数仍为 8）

   运行：node --test tests/layout.scoped.test.js
   边界：不启动生产服务（require.main 守卫）；数据/用户文件指向隔离临时目录，校验完自动删除，
         绝不触碰真实 server/data.json · server/users.json。
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
process.env.PROD_DATA_FILE = path.join(TMP, 'data.json');
process.env.PROD_USERS_FILE = path.join(TMP, 'users.json');
/* 用户文件：admin + pmc（真实 scrypt 口令，供端到端登录；避免启动期初始化横幅） */
const PWD = 'layout-test-pwd';
function mkUser(username, name, role, pwd, perms) {
  const salt = crypto.randomBytes(8).toString('hex');
  return { username, name, role, status: 'active', salt, hash: crypto.scryptSync(String(pwd), salt, 32).toString('hex'), perms: perms || {} };
}
fs.writeFileSync(process.env.PROD_USERS_FILE, JSON.stringify([
  mkUser('admin', '管理员', 'admin', PWD),
  mkUser('pmc', 'PMC', 'staff', PWD)
]));

const srv = require(path.join(ROOT, 'server', 'server.js'));
const { handleLayout, normalizeLayout, isLayoutMap } = srv;

const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

/* ---------- 工具 ---------- */
function plain(v) { return JSON.parse(JSON.stringify(v)); }
/** 落盘桩：计数 + 记录最后一次写盘的文件与对象，用于断言「恰好一次 / 一字不写」 */
function mkSpy() {
  const sp = { count: 0, files: [], objs: [] };
  sp.fn = function (file, obj) { sp.count++; sp.files.push(file); sp.objs.push(obj); };
  return sp;
}
const PMC = { username: 'pmc', role: 'staff', perms: {} };
const ADMIN = { username: 'admin', role: 'admin', perms: {} };

/* ============================================================
   Part A · 服务端纯净核心
   ============================================================ */
test('L1 未登录 → 401，且一字不写（内存与盘均未触碰）', () => {
  const data = { tblLayout: { v: 2, def: {}, u: { pmc: { a: 1 } } } };
  const revs = { tblLayout: 3 };
  const sp = mkSpy();
  const before = JSON.stringify(data);
  const r = handleLayout(data, revs, null, { layout: { a: 2 } }, sp.fn);
  assert.strictEqual(r.code, 401);
  assert.strictEqual(r.body.error, '未登录或登录已过期');
  assert.strictEqual(sp.count, 0, '401 不落盘');
  assert.strictEqual(JSON.stringify(data), before, '401 不改内存');
  assert.strictEqual(revs.tblLayout, 3, '401 不动 revs');
});

test('L2 核心：A 写自己的分片不影响 B 的分片（互不覆盖）', () => {
  const adminSlice = { order_frame: { order: ['x'], widths: { x: 40 } } };
  const data = {
    tblLayout: {
      v: 2,
      def: { order_frame: { order: ['a'], widths: {} } },
      u: { admin: plain(adminSlice) }
    }
  };
  const revs = { tblLayout: 5 };
  const sp = mkSpy();
  const pmcSlice = { order_frame: { order: ['p1', 'p2'], widths: { p1: 100 } } };
  const r = handleLayout(data, revs, PMC, { layout: plain(pmcSlice) }, sp.fn);

  assert.strictEqual(r.code, 200);
  assert.ok(r.body.ok);
  assert.deepStrictEqual(data.tblLayout.u.pmc, pmcSlice, 'pmc 分片已写入');
  assert.deepStrictEqual(data.tblLayout.u.admin, adminSlice, 'admin 分片**逐字未变**');
  assert.deepStrictEqual(data.tblLayout.def, { order_frame: { order: ['a'], widths: {} } }, 'def 未被波及');
  assert.strictEqual(sp.count, 1, '恰好落盘 1 次');
  assert.strictEqual(sp.files[0], process.env.PROD_DATA_FILE, '落盘到 DATA_FILE');
});

test('L3 保存后 revs.tblLayout 自增，返回体 layout 形状为 v2 且 u[me] 正确', () => {
  const data = { tblLayout: { v: 2, def: { delivery: { order: ['d'], widths: {} } }, u: {} } };
  const revs = { tblLayout: 7 };
  const sp = mkSpy();
  const r = handleLayout(data, revs, PMC, { layout: { delivery: { order: ['d', 'e'], widths: { d: 1 } } } }, sp.fn);
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.rev, 8, 'revs.tblLayout 自增 → 8');
  assert.strictEqual(revs.tblLayout, 8, '内存 revs 同步');
  assert.strictEqual(r.body.layout.v, 2);
  assert.deepStrictEqual(r.body.layout.u.pmc, { delivery: { order: ['d', 'e'], widths: { d: 1 } } });
  assert.deepStrictEqual(r.body.layout.def, { delivery: { order: ['d'], widths: {} } }, 'def 不动');
  /* 缺 revs.tblLayout 时按 0 起步（兼容旧 data.json 无该 rev 的情形） */
  const revs2 = {};
  const r2 = handleLayout({ tblLayout: { v: 2, def: {}, u: {} } }, revs2, PMC, { layout: {} }, mkSpy().fn);
  assert.strictEqual(r2.body.rev, 1);
});

test("L4 action:'reset' 只删自己那条分片（他人分片与 def 不变）", () => {
  const data = {
    tblLayout: {
      v: 2,
      def: { m: { order: ['d'], widths: {} } },
      u: { pmc: { m: { order: ['p'], widths: {} } }, admin: { m: { order: ['a'], widths: {} } } }
    }
  };
  const revs = { tblLayout: 2 };
  const sp = mkSpy();
  const r = handleLayout(data, revs, PMC, { action: 'reset' }, sp.fn);
  assert.strictEqual(r.code, 200);
  assert.ok(!Object.prototype.hasOwnProperty.call(data.tblLayout.u, 'pmc'), 'pmc 分片被删除');
  assert.deepStrictEqual(data.tblLayout.u.admin, { m: { order: ['a'], widths: {} } }, 'admin 分片保留');
  assert.deepStrictEqual(data.tblLayout.def, { m: { order: ['d'], widths: {} } }, 'def 保留');
  assert.strictEqual(revs.tblLayout, 3);
  assert.strictEqual(sp.count, 1);
  /* 幂等：再删一次仍成功（删除不存在的键无害） */
  const r2 = handleLayout(data, revs, PMC, { action: 'reset' }, sp.fn);
  assert.strictEqual(r2.code, 200);
});

test("L5 action:'resetAll'：admin → 200 且 u 清空、def 不变；非 admin → 403 且一字不写", () => {
  /* 非 admin → 403 */
  const data = {
    tblLayout: { v: 2, def: { m: { order: ['d'], widths: {} } }, u: { pmc: { m: {} }, admin: { m: {} } } }
  };
  const revs = { tblLayout: 4 };
  const sp = mkSpy();
  const before = JSON.stringify(data);
  const rDeny = handleLayout(data, revs, PMC, { action: 'resetAll' }, sp.fn);
  assert.strictEqual(rDeny.code, 403);
  assert.strictEqual(sp.count, 0, '403 不落盘');
  assert.strictEqual(JSON.stringify(data), before, '403 不改内存（u 未被清空）');
  assert.strictEqual(revs.tblLayout, 4, '403 不动 revs');

  /* admin → 200 */
  const rOk = handleLayout(data, revs, ADMIN, { action: 'resetAll' }, sp.fn);
  assert.strictEqual(rOk.code, 200);
  assert.deepStrictEqual(data.tblLayout.u, {}, '所有人的分片被清空');
  assert.deepStrictEqual(data.tblLayout.def, { m: { order: ['d'], widths: {} } }, 'def（初始布局）绝不动');
  assert.strictEqual(revs.tblLayout, 5);
  assert.strictEqual(sp.count, 1);
});

test('L6 body.layout 非对象 / 缺省 → 400，且一字不写', () => {
  const cases = [
    {},                          /* 缺省 */
    { layout: undefined },
    { layout: null },
    { layout: 'abc' },
    { layout: 123 },
    { layout: true },
    { action: 'save' },          /* 未知 action 走默认分支 → 仍要求 layout 是对象 */
    { layout: [] }               /* 加固：数组不是合法布局（非「模块→{order,widths}」映射） */
  ];
  cases.forEach(function (body, i) {
    const data = { tblLayout: { v: 2, def: {}, u: { pmc: { keep: 1 } } } };
    const revs = { tblLayout: 1 };
    const sp = mkSpy();
    const before = JSON.stringify(data);
    const r = handleLayout(data, revs, PMC, body, sp.fn);
    assert.strictEqual(r.code, 400, '用例#' + i + ' 应 400（' + JSON.stringify(body) + '）');
    assert.strictEqual(sp.count, 0, '用例#' + i + ' 不落盘');
    assert.strictEqual(JSON.stringify(data), before, '用例#' + i + ' 不改内存');
    assert.strictEqual(revs.tblLayout, 1, '用例#' + i + ' 不动 revs');
  });
});

test('L7 归一幂等：v1 扁平 → {v:2,def:v1,u:{}}，内容逐字进 def；连跑两次结果 deepEqual', () => {
  const v1 = {
    order_frame: { order: ['a', 'b'], widths: { a: 10 } },
    delivery: { order: ['d'], widths: {} }
  };
  const n1 = normalizeLayout(v1);
  assert.strictEqual(n1.v, 2);
  assert.deepStrictEqual(n1.def, v1, 'v1 扁平内容逐字进 def');
  assert.deepStrictEqual(n1.u, {}, 'u 为空');
  /* 幂等：第二遍原样返回同一引用，序列化完全一致 */
  const n2 = normalizeLayout(n1);
  assert.strictEqual(n2, n1, 'v2 原样返回同一引用');
  assert.deepStrictEqual(plain(n2), plain(n1), '连跑两次 deepEqual');
  /* 已是 v2 的字面量原样返回 */
  const v2 = { v: 2, def: { x: 1 }, u: { admin: { y: 2 } } };
  assert.strictEqual(normalizeLayout(v2), v2);
  /* 空 / 非法 → 空 v2（不抛错） */
  assert.deepStrictEqual(normalizeLayout({}), { v: 2, def: {}, u: {} });
  assert.deepStrictEqual(normalizeLayout(null), { v: 2, def: {}, u: {} });
  assert.deepStrictEqual(normalizeLayout(0), { v: 2, def: {}, u: {} });
  assert.deepStrictEqual(normalizeLayout('x'), { v: 2, def: {}, u: {} });
  /* 数组不是「模块 → {order,widths}」合法映射 → def 归空（与 handleLayout 的 def 守卫同口径） */
  assert.deepStrictEqual(normalizeLayout([]), { v: 2, def: {}, u: {} });
  assert.deepStrictEqual(normalizeLayout([{ order: ['a'], widths: {} }]), { v: 2, def: {}, u: {} });
  /* 对象但缺 v：整体进 def（v1 兼容口径） */
  assert.deepStrictEqual(normalizeLayout({ v: 1, a: 1 }), { v: 2, def: { v: 1, a: 1 }, u: {} });
  /* 入参本身不得被就地改动 */
  const src1 = { delivery: { order: ['d'], widths: {} } };
  const snap = JSON.stringify(src1);
  normalizeLayout(src1);
  assert.strictEqual(JSON.stringify(src1), snap, 'normalizeLayout 不得就地改写入参');

  /* v2 快通道：合法 → 原样同一引用且逐字节不变 */
  const v2ok = { v: 2, def: { m: {} }, u: { pmc: {} }, extra: 'keep' };
  const snap2 = JSON.stringify(v2ok);
  assert.strictEqual(normalizeLayout(v2ok), v2ok, '合法 v2 原样返回同一引用');
  assert.strictEqual(JSON.stringify(v2ok), snap2, '合法 v2 不被就地改动');

  /* v2 快通道自愈：非法 def/u（数组/标量）→ 就地归空（/api/save 仍放行任意值，必须挡住） */
  assert.deepStrictEqual(normalizeLayout({ v: 2, def: [], u: [] }), { v: 2, def: {}, u: {} });
  assert.deepStrictEqual(normalizeLayout({ v: 2, def: 'x', u: null }), { v: 2, def: {}, u: {} });
  assert.deepStrictEqual(normalizeLayout({ v: 2 }), { v: 2, def: {}, u: {} });

  /* isLayoutMap：空对象合法（＝尚无已存布局），数组/标量/null 非法 */
  assert.strictEqual(isLayoutMap({}), true);
  assert.strictEqual(isLayoutMap({ m: {} }), true);
  assert.strictEqual(isLayoutMap([]), false);
  assert.strictEqual(isLayoutMap([{}]), false);
  assert.strictEqual(isLayoutMap(null), false);
  assert.strictEqual(isLayoutMap('x'), false);
  assert.strictEqual(isLayoutMap(0), false);
  assert.strictEqual(isLayoutMap(undefined), false);
});

test('L8 v1 存量数据经 handleLayout 保存后：原内容进 def，本人分片为本次提交', () => {
  /* 模拟线上旧 data.json：tblLayout 为 v1 扁平（全公司共用一份） */
  const legacy = { order_frame: { order: ['old'], widths: { old: 55 } } };
  const data = { tblLayout: plain(legacy) };
  const revs = {};
  const sp = mkSpy();
  const r = handleLayout(data, revs, PMC, { layout: { order_frame: { order: ['new'], widths: {} } } }, sp.fn);
  assert.strictEqual(r.code, 200);
  assert.strictEqual(data.tblLayout.v, 2, '已升级为 v2');
  assert.deepStrictEqual(data.tblLayout.def, legacy, '原全局布局逐字进 def（所有人初始值不变）');
  assert.deepStrictEqual(data.tblLayout.u.pmc, { order_frame: { order: ['new'], widths: {} } }, '本人分片=本次提交');
});

test('L9 逐分片净化：非法分片用 delete 删除（不可归 {}），合法分片逐字节保留', () => {
  /* 1) 标量分片 → 键**不存在**（delete 而非归 {}） */
  const d1 = { v: 2, def: {}, u: { pmc: 'x' } };
  const r1 = normalizeLayout(d1);
  assert.strictEqual(r1, d1, '归一原地生效（返回同一引用）');
  assert.ok(!('pmc' in r1.u), '标量分片必须被 delete（键不存在），而非归 {}');
  assert.deepStrictEqual(r1.u, {}, 'u 中不含该键');
  assert.deepStrictEqual(r1, { v: 2, def: {}, u: {} });

  /* 2) 数组分片 → 键不存在 */
  const r2 = normalizeLayout({ v: 2, def: {}, u: { pmc: [] } });
  assert.ok(!('pmc' in r2.u), '数组分片必须被 delete');
  assert.deepStrictEqual(r2.u, {});

  /* 3) 混合：合法分片逐字节保留、非法分片被删；def 与其余键不动 */
  const keep = { m: { order: [], widths: {} } };
  const d3 = { v: 2, def: {}, u: { pmc: keep, admin: 'x' } };
  const r3 = normalizeLayout(d3);
  assert.ok('pmc' in r3.u, '合法分片保留');
  assert.deepStrictEqual(r3.u.pmc, keep, '合法分片逐字节保留');
  assert.ok(!('admin' in r3.u), '非法分片被删');
  assert.deepStrictEqual(r3.u, { pmc: keep });
  assert.deepStrictEqual(r3.def, {}, 'def 不受影响');

  /* 3b) **合法分片一字不动**：已是合法 v2 ⇒ 归一为恒等（同一引用 + 逐字节不变） */
  const clean = { v: 2, def: {}, u: { pmc: { order_frame: { order: ['a'], widths: { a: 120 } } } } };
  const snap = JSON.stringify(clean);
  const rc = normalizeLayout(clean);
  assert.strictEqual(rc, clean, '已是合法 v2 → 返回同一引用');
  assert.strictEqual(JSON.stringify(clean), snap, '合法分片一字不动（逐字节不变）');
  assert.deepStrictEqual(rc.u.pmc, { order_frame: { order: ['a'], widths: { a: 120 } } });

  /* 4) 幂等：一次净化后即为合法 v2 ⇒ 二次调用结果 deepEqual 且**返回同一引用** */
  [r1, r2, r3].forEach(function (r, i) {
    const again = normalizeLayout(r);
    assert.strictEqual(again, r, '幂等#' + i + '：二次调用返回同一引用');
    assert.deepStrictEqual(plain(again), plain(r), '幂等#' + i + '：结果 deepEqual');
  });

  /* 5) u 整体非法（数组/标量）仍归 {}（与「顶层 u 非法」既有口径一致，不逐个 delete） */
  assert.deepStrictEqual(normalizeLayout({ v: 2, def: {}, u: [] }), { v: 2, def: {}, u: {} });
  assert.deepStrictEqual(normalizeLayout({ v: 2, def: {}, u: 'x' }), { v: 2, def: {}, u: {} });

  /* 6) 端到端口径：净化后的 u 再交给前端，非法分片已消失 ⇒ 前端走 def 回退（不是空布局） */
  const def1 = { m: { order: ['a'], widths: {} } };
  const dirty = { v: 2, def: plain(def1), u: { pmc: 'x', admin: { m: { order: ['z'], widths: {} } } } };
  const purified = normalizeLayout(dirty);
  assert.ok(!('pmc' in purified.u) && 'admin' in purified.u, '净化只删非法分片、保留合法分片');
  assert.deepStrictEqual(purified.def, def1, 'def 一字不动');
});

/* ============================================================
   Part B · 前端静态守卫（源码文本断言）
   ============================================================ */
/* 从源码抽出具名函数整体（含 async 前缀由调用方正则容忍） */
function extractFn(src, name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\(', 'g');
  const m = re.exec(src);
  if (!m) throw new Error('未找到函数: ' + name);
  let p = m.index + m[0].length, d = 1;
  for (; p < src.length; p++) { if (src[p] === '(') d++; else if (src[p] === ')') { d--; if (d === 0) break; } }
  const i = src.indexOf('{', p); let j = i; d = 0;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (d === 0) break; } }
  return src.slice(m.index, j + 1);
}

test('F1 服务器模式下 saveLayout 不再整表写 DB.set(tblLayout)（改走 /api/layout 分片端点）', () => {
  const body = extractFn(INDEX_SRC, 'saveLayout');
  assert.ok(!/DB\.set\(\s*'tblLayout'/.test(body),
    'saveLayout 本体不得出现整表写 DB.set(\'tblLayout\')（服务器模式路径不写整表）');
  assert.match(body, /API_BASE/, 'saveLayout 应区分服务器 / 本地模式');
  assert.ok(/postLayout\(|['"]\/layout['"]/.test(body), 'saveLayout 服务器分支应调用 /api/layout 通道');
  /* 全文件亦不得再出现整表写 DB.set('tblLayout')（最严格读法） */
  assert.ok(!/DB\.set\(\s*'tblLayout'/.test(INDEX_SRC),
    'index.html 全文不得再出现 DB.set(\'tblLayout\')');
  /* 本地模式行为保持：saveLayoutLocal 按原口径写 localStorage（KEY+'tblLayout'），且返回 Promise */
  const local = extractFn(INDEX_SRC, 'saveLayoutLocal');
  assert.match(local, /localStorage\.setItem\(KEY\+'tblLayout',JSON\.stringify\(tblLayout\)\)/,
    '本地模式保留原行为（localStorage 写整表）');
  /* 分片端点的 HTTP 调用确实落在 postLayout 内，且**不带 expectedRev** */
  const post = extractFn(INDEX_SRC, 'postLayout');
  assert.ok(/apiReq\(\s*['"]\/layout['"]/.test(post), 'postLayout 必须 POST /api/layout');
  assert.ok(!/expectedRev/.test(post), 'postLayout 不得携带 expectedRev（分片天然无冲突，这正是消除 409 的原因）');
});

test('F2 applyServerLayout 存在且深拷贝本人分片（防与 def 共享引用）', () => {
  const body = extractFn(INDEX_SRC, 'applyServerLayout');
  assert.ok(/JSON\.parse\(\s*JSON\.stringify\(/.test(body), 'applyServerLayout 必须深拷贝后再赋给 tblLayout');
  assert.ok(/r\.u&&currentUser\)\?r\.u\[currentUser\.username\]:undefined/.test(body),
    '取本人分片口径：u[currentUser.username]');
  assert.ok(/var mine=isLayoutMap\(raw\)\?raw:\(isLayoutMap\(r\.def\)\?r\.def:\{\}\);/.test(body),
    '非法/缺失分片一律视同「不存在」⇒ 回退 def（与「无分片」同口径）');
  assert.ok(!/mine=\{\}/.test(body),
    '反断言：非法分片不得落到空布局 {}（否则＝系统默认列序，而非初始布局 def）');
  /* layoutDef 镜像一并赋值（供「重置我的列布局」回退初始布局用） */
  assert.match(body, /layoutDef\s*=\s*r\.def/, 'applyServerLayout 必须同步 def 镜像到 layoutDef');
  /* 归一函数与 server 端同口径：v2 快通道 + 非法 def/u 就地归空 */
  const norm = extractFn(INDEX_SRC, 'normLayoutServer');
  assert.ok(/v\.v\s*===\s*2/.test(norm), 'normLayoutServer：v2 走快通道（原样返回）');
  assert.ok(/!\s*isLayoutMap\(v\.def\)\s*\)\s*v\.def\s*=\s*\{\}/.test(norm),
    'normLayoutServer：v2 的非法 def（数组等）必须就地归空自愈');
  assert.ok(/Object\.keys\(v\.u\)\.forEach\(function\(k\)\{if\(!isLayoutMap\(v\.u\[k\]\)\)delete v\.u\[k\];\}\);/.test(norm),
    'normLayoutServer：必须**逐分片**净化，非法分片用 delete 删除（与 server 端同口径）');
  assert.ok(/v\.u\s*=\s*\{\}/.test(norm), 'normLayoutServer：v2 的顶层 u 非法（数组/标量）仍归 {}');
  assert.ok(/isLayoutMap\(v\)\s*\?\s*v\s*:\s*\{\}/.test(norm),
    'normLayoutServer：v1 扁平逐字进 def，非法（含数组）归空');
  /* 前端 isLayoutMap 与 server 端同口径：对象且非数组 */
  const isMap = extractFn(INDEX_SRC, 'isLayoutMap');
  assert.ok(/typeof\s+v\s*===\s*'object'/.test(isMap) && /!Array\.isArray\(v\)/.test(isMap),
    '前端 isLayoutMap：对象且非数组（与 server 端同口径）');
});

test('F3 resetTableLayout 不再含 needSysAdmin()（所有用户可用，只重置自己）', () => {
  const body = extractFn(INDEX_SRC, 'resetTableLayout');
  assert.ok(!/needSysAdmin|isSysAdmin/.test(body), 'resetTableLayout 不得再含角色守卫');
  assert.ok(/resetTableLayout\s*\(/.test(INDEX_SRC));
  /* 语义：从 def 重新取本人基线（深拷贝），而非清零 */
  assert.ok(/layoutDef/.test(body), '重置必须回退到 def（初始布局），而非置空');
  assert.ok(/JSON\.parse\(\s*JSON\.stringify\(/.test(body), '回归基线必须深拷贝自 def');
  /* 按钮已去除 data-admin-only（全员可见） */
  assert.match(INDEX_SRC, /<button class="btn btn-sm" onclick="resetTableLayout\(\)"/,
    '「重置列布局」按钮不得带 data-admin-only');
});

test('F4 resetAllTableLayout 含 needSysAdmin() 函数级守卫 + 二次确认 + 管理员专属按钮', () => {
  const body = extractFn(INDEX_SRC, 'resetAllTableLayout');
  assert.match(body, /if\(\s*!needSysAdmin\(\)\s*\)\s*return\s*;/, '首句须为 needSysAdmin() 守卫（防 F12 绕过）');
  assert.ok(/confirm\(/.test(body), '执行前须二次 confirm');
  assert.ok(/apiReq\(\s*['"]\/layout['"]/.test(body) && /action\s*:\s*['"]resetAll['"]/.test(body),
    '须 POST /api/layout {action:\'resetAll\'}');
  assert.ok(/applyServerLayout\(/.test(body), '成功后须重新读回并落到内存');
  /* 按钮带 data-admin-only */
  assert.match(INDEX_SRC, /<button class="btn btn-sm" data-admin-only onclick="resetAllTableLayout\(\)"/,
    '「重置所有人的列布局」按钮必须带 data-admin-only');
});

test('F5 反潮汐守卫：layoutOf 与 applyTableLayout 既有形态未被改动（复用 J9 两行正则）', () => {
  /* layoutOf 逐字未变（内存态保持 v1 扁平） */
  assert.ok(INDEX_SRC.indexOf('function layoutOf(m){if(!tblLayout[m])tblLayout[m]={order:null,widths:{}};return tblLayout[m];}') >= 0,
    'layoutOf 签名与实现必须逐字不变');
  /* J9 的机制断言两行必须原样存在 */
  const body = extractFn(INDEX_SRC, 'applyTableLayout');
  assert.match(body,
    /var order=\(lo\.order\|\|\[\]\)\.filter\(function\(k\)\{return curKeys\.indexOf\(k\)>=0;\}\);/,
    'applyTableLayout 合并策略第 1 行（已存顺序过滤仍存在的）');
  assert.match(body,
    /curKeys\.forEach\(function\(k\)\{if\(order\.indexOf\(k\)<0\)order\.push\(k\);\}\);/,
    'applyTableLayout 合并策略第 2 行（新增列追加到末尾）');
  /* 内存态声明保持扁平 */
  assert.match(INDEX_SRC, /var tblLayout=\{\};\s+\/\/ tblLayout\[模块\]=\{order:\[key\.\.\.\],widths:\{key:px\}\}/,
    'tblLayout 内存态仍为 v1 扁平');
});

test('F6 读入点已改写：initApp 与 rehydrateFromServer 均经 applyServerLayout', () => {
  assert.match(INDEX_SRC, /applyServerLayout\(await DB\.get\('tblLayout',\{\}\)\)/,
    'initApp 读入点应改为 applyServerLayout(await DB.get(...))');
  assert.match(INDEX_SRC, /if\(serverData\.tblLayout!==undefined\)applyServerLayout\(serverData\.tblLayout\);/,
    'rehydrateFromServer 读入点应改为 applyServerLayout(serverData.tblLayout)');
  /* 旧写法必须 0 处残留 */
  assert.ok(!/tblLayout\s*=\s*await DB\.get\('tblLayout'/.test(INDEX_SRC), '旧 initApp 写法应已移除');
  assert.ok(!/tblLayout\s*=\s*serverData\.tblLayout\s*\|\|\s*\{\}/.test(INDEX_SRC), '旧 rehydrate 写法应已移除');
});

test('F7 顶栏按钮清单：重置=全员可见，重置所有人=管理员专属；data-admin-only 元素总数仍为 8', () => {
  const marked = INDEX_SRC.match(/<(button|span)[^>]*\sdata-admin-only/g) || [];
  assert.strictEqual(marked.length, 8, '带 data-admin-only 的 DOM 元素应恰 8 个（摘 1 加 1，可见性集合不变）');
  /* 两个按钮各自存在且标记正确 */
  const resetAllBtns = INDEX_SRC.match(/<button[^>]*onclick="resetAllTableLayout\(\)"[^>]*>/g) || [];
  assert.strictEqual(resetAllBtns.length, 1, '「重置所有人的列布局」按钮恰 1 个');
  assert.ok(/data-admin-only/.test(resetAllBtns[0]), '该按钮必须带 data-admin-only');
  const resetBtns = INDEX_SRC.match(/<button[^>]*onclick="resetTableLayout\(\)"[^>]*>/g) || [];
  assert.strictEqual(resetBtns.length, 1, '「重置列布局」按钮恰 1 个');
  assert.ok(!/data-admin-only/.test(resetBtns[0]), '该按钮不得带 data-admin-only（全员可用）');
  assert.ok(/title="重置我的列布局（恢复到初始布局）"/.test(resetBtns[0]), '按钮 title 须无歧义（重置我自己的）');
});

test('F8 版本锚点：index.html 权威水印恰 1 处 = harness.BUILD，PREV 形态 0 处', () => {
  const build = require('./harness/build');
  assert.strictEqual((INDEX_SRC.match(build.buildMarkRe(build.BUILD)) || []).length, 1,
    '权威水印 >build ' + build.BUILD + '< 应恰 1 处');
  assert.strictEqual((INDEX_SRC.match(build.buildAnyRe(build.PREV)) || []).length, 0, '上一版本任意形态应 0 处');
});

/* ============================================================
   Part C · 前端行为（vm 沙箱驱动生产代码）
   ------------------------------------------------------------
   C1 applyServerLayout 取本人分片并**深拷贝**（拖列不得污染 def —— 本设计最易踩的坑）
   C2 无本人分片 / 未登录（currentUser=null）→ 回退 def
   C3 resetTableLayout 回退到 def 基线（非置空），且服务器模式落 /api/layout
   C4 saveLayout 服务器模式打 /api/layout，绝不打 /api/save，且不带 expectedRev
   C5 resetAllTableLayout 非 admin → 函数级守卫拦截、零请求
   C6 resetAllTableLayout admin → POST /api/layout {action:'resetAll'} 并重新读回
   ============================================================ */
const { createApp } = require('./harness/sandbox');
const { createFetchStub } = require('./harness/dom-stub');

const DEF = { delivery: { order: ['a', 'b'], widths: { a: 10 } } };
/** 造一个已装载生产代码、服务器模式（API_BASE='/api'）的沙箱。
    renderContent 依赖完整 DOM（伪 DOM 不完备）→ 桩掉，只验证布局/请求逻辑。 */
function mkApp(fetchStub, confirmResult) {
  const app = createApp({ installRecorder: false, confirmResult: confirmResult === undefined ? true : confirmResult });
  if (fetchStub) app.setFetch(fetchStub);
  app.setGlobal('renderContent', function () {});
  return app;
}
function okLayout(def, u, rev) {
  return { status: 200, body: { ok: true, rev: rev || 1, layout: { v: 2, def: def, u: u || {} } } };
}

test('C1 applyServerLayout 取本人分片并深拷贝：拖列不污染 def（核心防坑）', () => {
  const app = mkApp();
  app.setGlobals({ currentUser: { username: 'pmc', role: 'staff', perms: {} } });
  const mine = { delivery: { order: ['b', 'a'], widths: { b: 42 } } };
  app.run('applyServerLayout(' + JSON.stringify({ v: 2, def: DEF, u: { pmc: mine } }) + ')');

  assert.deepStrictEqual(plain(app.getGlobal('tblLayout')), mine, '内存态 = 本人分片');
  assert.deepStrictEqual(plain(app.getGlobal('layoutDef')), DEF, 'layoutDef = 服务端 def 镜像');

  /* 模拟拖列/调宽就地改内存态 */
  app.run("tblLayout.delivery.widths.b=999; tblLayout.delivery.order=['x']; delete tblLayout.delivery;");
  assert.deepStrictEqual(plain(app.getGlobal('layoutDef')), DEF,
    'def（所有人初始布局）绝不能被本人拖列就地污染 —— 证明已深拷贝');
  app.dispose();
});

test('C2 无本人分片 / currentUser=null → 回退 def；v1 扁平输入亦被归一', () => {
  const app = mkApp();
  /* 有账号但服务器无该账号分片 → def */
  app.setGlobals({ currentUser: { username: 'chejian', role: 'staff', perms: {} } });
  app.run('applyServerLayout(' + JSON.stringify({ v: 2, def: DEF, u: { pmc: { delivery: { order: ['z'], widths: {} } } } }) + ')');
  assert.deepStrictEqual(plain(app.getGlobal('tblLayout')), DEF, '无本人分片 → 回落 def');

  /* currentUser=null（本地模式/未登录）→ def；且服务器传 v1 扁平也能工作 */
  app.setGlobals({ currentUser: null });
  app.run('applyServerLayout(' + JSON.stringify(DEF) + ')');
  assert.deepStrictEqual(plain(app.getGlobal('tblLayout')), DEF, 'v1 扁平 → 归一后取 def');
  assert.deepStrictEqual(plain(app.getGlobal('layoutDef')), DEF);
  app.dispose();
});

test('C3 resetTableLayout 回退到 def 基线（非置空），服务器模式落 /api/layout', async () => {
  const stub = createFetchStub({ '/api/layout': okLayout(DEF, {}) });
  const app = mkApp(stub);
  app.setGlobals({ currentUser: { username: 'pmc', role: 'staff', perms: {} } });
  app.run('applyServerLayout(' + JSON.stringify({ v: 2, def: DEF, u: { pmc: { delivery: { order: ['z'], widths: {} } } } }) + ')');
  app.run("tblLayout.delivery.order=['z']");           /* 本人已改过 */
  await app.run('resetTableLayout()');

  assert.deepStrictEqual(plain(app.getGlobal('tblLayout')), DEF, '重置 = 回到初始布局 def，而非清空');
  assert.deepStrictEqual(plain(app.getGlobal('layoutDef')), DEF, 'def 未被重置流程破坏');
  const posts = stub.callsTo('/api/layout');
  assert.strictEqual(posts.length, 1, '重置必须落 /api/layout 一次');
  assert.deepStrictEqual(posts[0].body.layout, DEF, '提交内容 = def 基线（本人分片被覆写为初始布局）');
  app.dispose();
});

test('C4 saveLayout 服务器模式打 /api/layout、不打 /api/save，且不带 expectedRev（消除 409）', async () => {
  const stub = createFetchStub({ '/api/layout': okLayout(DEF, {}) });
  const app = mkApp(stub);
  app.setGlobals({ currentUser: { username: 'pmc', role: 'staff', perms: {} } });
  app.run("tblLayout={delivery:{order:['z'],widths:{z:5}}}");
  await app.run('saveLayout()');

  assert.strictEqual(stub.callsTo('/api/layout').length, 1, '服务器模式写 /api/layout');
  assert.strictEqual(stub.callsTo('/api/save').length, 0, '服务器模式绝不再整表写 /api/save');
  const b = stub.callsTo('/api/layout')[0].body;
  assert.deepStrictEqual(b.layout, { delivery: { order: ['z'], widths: { z: 5 } } }, '提交本人扁平布局');
  assert.ok(!Object.prototype.hasOwnProperty.call(b, 'expectedRev'), '不带 expectedRev（分片无冲突，这正是消除 409 的原因）');
  assert.ok(!Object.prototype.hasOwnProperty.call(b, 'action'), '保存走默认分支（不带 action）');
  app.dispose();
});

test('C5 resetAllTableLayout 非 admin → 函数级守卫拦截、零请求', async () => {
  const stub = createFetchStub({});
  const app = mkApp(stub);
  app.setGlobals({ currentUser: { username: 'pmc', role: 'staff', perms: {} } });
  app.run('resetAllTableLayout()');   /* 守卫同步 return，不产生请求 */
  assert.strictEqual(stub.calls.length, 0, '非管理员不得发出任何请求');
  assert.ok(app.alerts.some(function (m) { return /仅管理员/.test(m); }), '应提示「仅管理员可用」');
  app.dispose();
});

test("C6 resetAllTableLayout admin → confirm 后 POST {action:'resetAll'} 并重新读回本人基线", async () => {
  const stub = createFetchStub({ '/api/layout': okLayout(DEF, {}) });
  const app = mkApp(stub, true);
  app.setGlobals({ currentUser: { username: 'admin', role: 'admin', perms: {} } });
  app.run('applyServerLayout(' + JSON.stringify({ v: 2, def: DEF, u: { admin: { delivery: { order: ['z'], widths: {} } } } }) + ')');
  await app.run('resetAllTableLayout()');

  const posts = stub.callsTo('/api/layout');
  assert.strictEqual(posts.length, 1, '管理员应发一次 /api/layout');
  assert.strictEqual(posts[0].body.action, 'resetAll', "请求体含 action:'resetAll'");
  assert.deepStrictEqual(plain(app.getGlobal('tblLayout')), DEF, '重置后本人布局回落 def');
  assert.ok(app.confirms.length >= 1, '执行前须二次确认');

  /* confirm 取消 → 不发请求 */
  const stub2 = createFetchStub({ '/api/layout': okLayout(DEF, {}) });
  const app2 = mkApp(stub2, false);
  app2.setGlobals({ currentUser: { username: 'admin', role: 'admin', perms: {} } });
  await app2.run('resetAllTableLayout()');
  assert.strictEqual(stub2.calls.length, 0, 'confirm 取消 → 零请求');
  app.dispose();
  app2.dispose();
});

test('C7 非法形状自愈：v2 的 def/u 为数组 → 归空；u[本人] 非法 → 回退 def（非空布局）', () => {
  const app = mkApp();
  app.setGlobals({ currentUser: { username: 'pmc', role: 'staff', perms: {} } });
  /* v2 的 def 是数组（可经仍放行的 /api/save 伪造）→ layoutDef 不得是数组、不崩 */
  app.run('applyServerLayout(' + JSON.stringify({ v: 2, def: [], u: {} }) + ')');
  assert.strictEqual(app.run('Array.isArray(layoutDef)'), false, 'def 为数组时 layoutDef 必须归空');
  assert.deepStrictEqual(plain(app.getGlobal('layoutDef')), {}, 'def 非法 → 归空');
  assert.deepStrictEqual(plain(app.getGlobal('tblLayout')), {}, 'def 非法且无分片 → 空映射');
  app.run("layoutOf('any')");   /* 不得抛错 */
  assert.ok(JSON.stringify(plain(app.getGlobal('tblLayout'))).indexOf('any') >= 0, 'layoutOf 仍能按模块建档');

  /* 关键口径修正：u[本人] 非法 ⇒ **视同「不存在」⇒ 回退 def**（**不是**空布局 {} ——
     {} 会被当成「该账号自己的空布局」⇒ 看到系统默认列序，与「无分片⇒初始布局」用户可见结果不同） */
  const DEF1 = { m: { order: ['a'], widths: {} } };
  [{ pmc: [] }, { pmc: 'x' }, { pmc: 0 }, { pmc: null }].forEach(function (u, i) {
    app.run('applyServerLayout(' + JSON.stringify({ v: 2, def: DEF1, u: u }) + ')');
    const got = plain(app.getGlobal('tblLayout'));
    assert.strictEqual(Array.isArray(got), false, '用例#' + i + '：内存态不得是数组');
    assert.deepStrictEqual(got, DEF1, '用例#' + i + '：非法分片必须回退 def');
    assert.notDeepStrictEqual(got, {}, '用例#' + i + '：非法分片**不得**落到空布局（否则＝系统默认列序）');
    assert.deepStrictEqual(plain(app.getGlobal('layoutDef')), DEF1, '用例#' + i + '：def 镜像保留供重置');
  });

  /* 反面对照：合法分片优先于 def；且**显式空分片 `{}` 是合法分片**（＝用户自己的空布局，不回落 def） */
  const MINE1 = { z: { order: ['z'], widths: {} } };
  app.run('applyServerLayout(' + JSON.stringify({ v: 2, def: DEF1, u: { pmc: MINE1 } }) + ')');
  assert.deepStrictEqual(plain(app.getGlobal('tblLayout')), MINE1, '合法分片优先于 def');
  app.run('applyServerLayout(' + JSON.stringify({ v: 2, def: DEF1, u: { pmc: {} } }) + ')');
  assert.deepStrictEqual(plain(app.getGlobal('tblLayout')), {}, '空对象是合法分片 → 不回落 def（与非法分片区分开）');
  app.dispose();
});

/* ============================================================
   Part D · 真实 HTTP 端到端（自建 server + handleRequest，隔离临时目录）
   ------------------------------------------------------------
   D1 路由接线 + 鉴权闸门：未登录 401；staff 可写本人分片 200
   D2 端到端隔离：pmc 写分片后 /api/data 的 u.pmc 正确、v=2、admin 分片不存在
   D3 resetAll：staff → 403；admin → 200 且 u 清空、def 不变
   D4 零回归：/api/save {key:'tblLayout'} 仍放行（用户已拍板不防旧标签页整表覆盖）
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
function disk() { return fs.readFileSync(process.env.PROD_DATA_FILE, 'utf8'); }

test('D1 未登录 POST /api/layout → 401；staff 保存本人分片 → 200 且落盘', async () => {
  const r401 = await api('POST', '/api/layout', null, { layout: { x: { order: [], widths: {} } } });
  assert.strictEqual(r401.status, 401, '未登录必须 401（路由位于统一鉴权之后）');
  assert.strictEqual(r401.body.error, '未登录或登录已过期');

  const pmc = await login('pmc');
  const slice = { delivery: { order: ['d1', 'd2'], widths: { d1: 60 } } };
  const r = await api('POST', '/api/layout', pmc, { layout: slice });
  assert.strictEqual(r.status, 200, 'staff 保存本人分片必须 200（非 admin 亦可用）');
  assert.strictEqual(r.body.ok, true);
  assert.deepStrictEqual(r.body.layout.u.pmc, slice);
  const onDisk = JSON.parse(disk());
  assert.strictEqual(onDisk.tblLayout.v, 2, '磁盘 tblLayout 已为 v2');
  assert.deepStrictEqual(onDisk.tblLayout.u.pmc, slice, '磁盘上本人分片已落盘');
});

test('D2 端到端隔离：pmc 的分片不写进 admin 分片；/api/data 永远只回 v2', async () => {
  const pmc = await login('pmc');
  const d = await api('GET', '/api/data', pmc);
  assert.strictEqual(d.body.data.tblLayout.v, 2, '/api/data 归一为 v2');
  assert.deepStrictEqual(d.body.data.tblLayout.u.pmc, { delivery: { order: ['d1', 'd2'], widths: { d1: 60 } } });
  assert.ok(!Object.prototype.hasOwnProperty.call(d.body.data.tblLayout.u, 'admin'), 'admin 未产生分片（未受 pmc 写入波及）');
  assert.deepStrictEqual(d.body.data.tblLayout.def, {}, 'def 仍为空初始布局（无人写过 def）');
});

test("D3 resetAll：staff → 403；admin → 200 且 u 清空、def 不变", async () => {
  const pmc = await login('pmc');
  const deny = await api('POST', '/api/layout', pmc, { action: 'resetAll' });
  assert.strictEqual(deny.status, 403, 'staff 不得重置所有人');
  const after = await api('GET', '/api/data', pmc);
  assert.ok(after.body.data.tblLayout.u.pmc, '403 后 pmc 分片仍在（一字不写）');

  const admin = await login('admin');
  const ok = await api('POST', '/api/layout', admin, { action: 'resetAll' });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(ok.body.layout.u, {}, 'admin 重置后全部分片清空');
  const after2 = await api('GET', '/api/data', admin);
  assert.deepStrictEqual(after2.body.data.tblLayout.u, {}, '磁盘/内存一致：u 为空');
  assert.deepStrictEqual(after2.body.data.tblLayout.def, {}, 'def 不变');
});

test('D4 零回归：/api/save {key:tblLayout} 仍放行 200（用户已拍板不做防御）', async () => {
  const pmc = await login('pmc');
  const r = await api('POST', '/api/save', pmc, { key: 'tblLayout', value: { order_frame: { order: ['legacy'], widths: {} } } });
  assert.strictEqual(r.status, 200, 'D3 守护：/api/save 上 tblLayout 保持放行（本轮不动）');
  /* 归一边界：旧形态整表写入后，下一次 /api/data 仍会把它归一为 v2（原内容进 def） */
  const d = await api('GET', '/api/data', pmc);
  assert.strictEqual(d.body.data.tblLayout.v, 2);
  assert.deepStrictEqual(d.body.data.tblLayout.def, { order_frame: { order: ['legacy'], widths: {} } },
    '旧标签页整表覆盖的扁平内容被逐字搬进 def');
});


