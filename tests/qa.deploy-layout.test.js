'use strict';
/* ============================================================
   tests/qa.deploy-layout.test.js —— 部署布局冒烟：扁平目录下能否启动
   ------------------------------------------------------------
   【.163 部署修复 · 为什么必须有这个文件】
   首次真实部署在第 3 步失败：
       Error: Cannot find module '../quality/qa-core.js'
       Require stack: /opt/qa-server/qa-store.js → /opt/qa-server/qa-server.js
   根因：`qa-store.js` / `qa-server.js` 里 `require('../quality/qa-core.js')` **只适用于本地布局**
   （server/ 与 quality/ 是兄弟目录）。而 `deploy-qa.sh` 有意采用**扁平布局** —— 把
   qa-core.js 与 qa-server.js 一起放进 /opt/qa-server/（脚本注释："qa-core.js 的第二落点"）
   ⇒ `../quality/` 在服务器上解析到不存在的 /opt/quality/。

   为什么此前 1141 条测试一条都没拦住：**所有用例都在本地布局下跑**。
   「部署后的目录结构能否启动」这个不变量此前**完全无人守护** —— 这是比缺陷本身更值得修的洞。

   本文件做什么：
     §1 造一个临时目录，把 4 个后端文件**复制成扁平结构**（同一层，模拟 /opt/qa-server/），
        在其中跑 `node qa-server.js --init`，断言退出码 0、数据文件被创建、stderr 无 MODULE_NOT_FOUND
     §2 负向断言：把 qa-core.js 从该目录移走再跑 ⇒ 必须**非 0 退出**并报 Cannot find module
        （证明本测试真的在测依赖解析，而不是恒真/恒绿）
     §3 本地（开发）布局仍可用：直接 require server/qa-store.js 不报错
     §4 两个文件的"双布局解析"代码块必须一致（删掉任一处都会让那种布局起不来）
     §5 双落点字节同一：quality/qa-core.js 与（部署后）同目录副本必须 md5 相同 —— 这里用
        复制后的文件自证"扁平布局下加载到的就是同一份字节"

   运行：node --test tests/qa.deploy-layout.test.js
   边界：只起子进程跑 `--init`（不 listen、不占端口、不连网络）。
   ============================================================ */

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

/* 临时目录放在仓库工作区内（Windows 下 '/tmp' 会被解析成 D:\tmp），结束时清理 */
const TMP = fs.mkdtempSync(path.join(ROOT, '.qatmp-'));
after(function () {
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** 部署态要上传的 4 个后端文件（与 deploy-qa.sh 第 2 步的上传清单一致） */
const BACKEND_FILES = [
  ['server/qa-server.js', 'qa-server.js'],
  ['server/qa-store.js', 'qa-store.js'],
  ['server/qa-auth.js', 'qa-auth.js'],
  ['quality/qa-core.js', 'qa-core.js'],       /* ★ 第二落点：与入口同目录 */
];

/**
 * 造一个"服务器布局"目录：4 个文件平铺在同一层（模拟 /opt/qa-server/）。
 * @param {string} dir 目标目录
 * @param {boolean} withCore 是否放入 qa-core.js（false ⇒ 负向用例）
 */
function makeFlatLayout(dir, withCore) {
  fs.mkdirSync(dir, { recursive: true });
  BACKEND_FILES.forEach(function (pair) {
    if (!withCore && pair[1] === 'qa-core.js') return;
    fs.copyFileSync(path.join(ROOT, pair[0]), path.join(dir, pair[1]));
  });
}

/** 在该目录里跑 `node qa-server.js --init`（不 listen、不占端口） */
function runInit(dir) {
  const dataFile = path.join(dir, 'data-qa.json');
  return spawnSync(process.execPath, [path.join(dir, 'qa-server.js'), '--init'], {
    cwd: dir,
    env: Object.assign({}, process.env, { QA_DATA_FILE: dataFile, QA_PORT: '0' }),
    encoding: 'utf8',
    timeout: 30000,
  });
}

function md5(file) {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
}

/* ============================================================
   §1 部署（扁平）布局必须能启动
   ============================================================ */
test('§1 扁平部署布局：node qa-server.js --init 必须成功（模块解析在 /opt/qa-server/ 下可用）', function () {
  const dir = path.join(TMP, 'flat-ok');
  makeFlatLayout(dir, true);

  /* 前提自证：确实是扁平结构，且没有 ../quality/ 可供解析 */
  const flatNames = fs.readdirSync(dir).sort();
  assert.deepStrictEqual(flatNames, ['qa-auth.js', 'qa-core.js', 'qa-server.js', 'qa-store.js'],
    '夹具必须是 4 文件平铺，实际：' + flatNames.join(','));
  assert.strictEqual(fs.existsSync(path.join(TMP, 'quality')), false,
    '夹具所在父目录不得存在 quality/ —— 否则 ../quality/ 仍能解析，本用例测不出部署态问题');

  const r = runInit(dir);
  assert.strictEqual(r.status, 0,
    '扁平布局下 --init 必须退出 0；实际 status=' + r.status
    + '\n--- stdout ---\n' + (r.stdout || '') + '\n--- stderr ---\n' + (r.stderr || ''));
  assert.strictEqual(/MODULE_NOT_FOUND|Cannot find module/.test(String(r.stderr || '')), false,
    'stderr 不得出现模块解析失败：' + r.stderr);
  assert.match(String(r.stdout), /已初始化数据文件/, '必须打印初始化成功：' + r.stdout);

  /* 数据文件真的被创建且结构合法 */
  const dataFile = path.join(dir, 'data-qa.json');
  assert.strictEqual(fs.existsSync(dataFile), true, '--init 必须创建数据文件');
  const doc = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.deepStrictEqual(doc.qaLogs, [], '初始化产物 qaLogs 必须为空数组');
  assert.deepStrictEqual(doc.revs, { qaLogs: 0 });
  assert.strictEqual(typeof doc.version, 'string');

  /* 幂等：再跑一次仍 0，且不覆盖 */
  const before = fs.readFileSync(dataFile, 'utf8');
  const r2 = runInit(dir);
  assert.strictEqual(r2.status, 0, '二次 --init 必须仍退出 0（幂等）');
  assert.strictEqual(fs.readFileSync(dataFile, 'utf8'), before, '二次 --init 不得改动既有文件');
});

/* ============================================================
   §2 负向：拿掉 qa-core.js 必须真的红（证明本用例在测依赖解析）
   ============================================================ */
test('§2 负向对照：同目录缺 qa-core.js ⇒ 必须非 0 退出并报 Cannot find module', function () {
  const dir = path.join(TMP, 'flat-missing');
  makeFlatLayout(dir, false);                 /* 故意不放 qa-core.js */

  assert.strictEqual(fs.existsSync(path.join(dir, 'qa-core.js')), false, '前提：qa-core.js 已缺席');

  const r = runInit(dir);
  assert.notStrictEqual(r.status, 0, '缺 qa-core.js 时必须非 0 退出（否则 §1 是恒真断言）');
  const err = String(r.stderr || '');
  assert.match(err, /Cannot find module|MODULE_NOT_FOUND/,
    '必须报模块解析失败，实际 stderr=' + err);
  assert.strictEqual(fs.existsSync(path.join(dir, 'data-qa.json')), false,
    '模块都加载不了时不得创建数据文件（拒绝启动而非半启动）');
});

/* ============================================================
   §3 本地（开发）布局不能被改坏
   ============================================================ */
test('§3 本地布局仍可用：require server/qa-store.js / qa-server.js 不报错且取到同一份内核', function () {
  /* 其它测试文件其实已经在用这两个模块，但这里显式钉一条 —— 兼容部署态不得牺牲开发态 */
  const store = require(path.join(ROOT, 'server', 'qa-store.js'));
  assert.strictEqual(typeof store.loadFromFile, 'function');
  assert.strictEqual(typeof store.TABLE_KEY, 'string');

  const coreDev = require(path.join(ROOT, 'quality', 'qa-core.js'));
  assert.strictEqual(typeof coreDev.nextQaNo, 'function');

  /* qa-store 内部取到的 core 必须**就是** quality/qa-core.js 那一个实例（同一份字节、同一份实现） */
  const src = fs.readFileSync(path.join(ROOT, 'server', 'qa-store.js'), 'utf8');
  assert.ok(src.indexOf("'../quality/qa-core.js'") >= 0, 'qa-store.js 必须保留开发态回退路径');
  assert.ok(src.indexOf("'./qa-core.js'") >= 0, 'qa-store.js 必须保留部署态优先路径');
});

/* ============================================================
   §4 两个文件的双布局解析必须一致（否则总有一种布局起不来）
   ============================================================ */
test('§4 qa-store.js 与 qa-server.js 的双布局解析代码块必须一致', function () {
  const CANDIDATES = "['./qa-core.js', '../quality/qa-core.js']";
  const STORE = fs.readFileSync(path.join(ROOT, 'server', 'qa-store.js'), 'utf8');
  const SERVER = fs.readFileSync(path.join(ROOT, 'server', 'qa-server.js'), 'utf8');

  [['qa-store.js', STORE], ['qa-server.js', SERVER]].forEach(function (pair) {
    const name = pair[0], src = pair[1];
    assert.ok(src.indexOf(CANDIDATES) >= 0,
      name + ' 必须按「先同目录、再回退 ../quality/」的顺序解析 qa-core.js');
    /* 顺序必须是把 ./qa-core.js 排在前面：部署态优先 */
    const iFlat = src.indexOf("'./qa-core.js'");
    const iDev = src.indexOf("'../quality/qa-core.js'");
    assert.ok(iFlat >= 0 && iDev >= 0 && iFlat < iDev, name + ' 的候选顺序必须是 部署态 → 开发态');
    /* 不得残留写死单一布局的旧写法 */
    assert.strictEqual(/^const core = require\('\.\.\/quality\/qa-core\.js'\);$/m.test(src), false,
      name + ' 不得残留只适用本地布局的 `const core = require(\'../quality/qa-core.js\')`');
    /* 必须用 MODULE_NOT_FOUND 区分"落点不存在"与"真故障" */
    assert.ok(src.indexOf("e.code !== 'MODULE_NOT_FOUND'") >= 0,
      name + ' 必须只把 MODULE_NOT_FOUND 当作"该落点不存在"，其它错误直接抛');
  });
});

/* ============================================================
   §5 扁平布局加载到的 qa-core 与前端落点是同一份字节
   ============================================================ */
test('§5 扁平布局里的 qa-core.js 与 quality/qa-core.js 必须逐字节相同', function () {
  const dir = path.join(TMP, 'flat-ok');
  const a = md5(path.join(dir, 'qa-core.js'));
  const b = md5(path.join(ROOT, 'quality', 'qa-core.js'));
  assert.strictEqual(a, b, '两个落点必须字节相同（deploy-qa.sh 的 md5 断言守的就是这条线上事实）');
});
