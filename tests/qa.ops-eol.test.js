'use strict';
/* ============================================================
   tests/qa.ops-eol.test.js —— 部署文件行尾守卫（必须是纯 LF，不得有 CR）
   ------------------------------------------------------------
   【build .163】为什么必须存在：
   部署脚本 / nginx 片段 / systemd unit 一旦带 CRLF（\r\n），**部署时才会炸**，
   而且报错完全指不到真实原因：
     · deploy-qa.sh / rollback-qa.sh / ops/qa-backup.sh → `bash: $'\r': command not found`
     · ops/nginx-qa.conf  → `nginx -t` 报 `unexpected ";"` 之类（指令解析失败）
     · ops/*.service / *.timer → systemd `203/EXEC`（ExecStart 末尾带上 \r）
     · 备份定时器会**静默不工作**（最坏情况：以为有备份，其实没有）
   本机 git 是 core.autocrlf=true，任何人重新 checkout 都可能拿到 CRLF，故必须自动化守住。

   ★ 本文件刻意**不用 grep 做判定**，而是直接读字节数 0x0D：
     在本机 Git Bash 实测，`grep -c $'\r' <file>` 恒等于该文件的总行数
     （纯 LF 文件 deploy-qa.sh 得 383 = 总行数；含 CRLF 的探针同样得 2 = 总行数）
     ⇒ 那个写法**无法区分 LF 与 CRLF**，用它"验证通过"等于没验证。
     下面 §0 用合成 buffer 做了阳性/阴性对照，保证判定器本身有效。

   运行：node --test tests/qa.ops-eol.test.js
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** 必须保证纯 LF 的文件（会被 scp 到 Linux 上执行或解析） */
const DEPLOY_FILES = [
  'deploy-qa.sh',
  'rollback-qa.sh',
  'ops/nginx-current.conf',
  'ops/nginx-qa.conf',
  'ops/qa-server.service',
  'ops/qa-backup.sh',
  'ops/qa-backup.service',
  'ops/qa-backup.timer',
];

/**
 * 数一段字节里有多少个 CR（0x0D）。
 * @param {Buffer} buf
 * @returns {number}
 */
function countCR(buf) {
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0d) n++;
  }
  return n;
}

function readBuf(rel) {
  return fs.readFileSync(path.join(ROOT, rel));
}

/* ============================================================
   §0 判定器自检：必须能分辨 LF / CRLF（否则本文件是摆设）
   ============================================================ */
test('§0 判定器自检：LF 得 0、CRLF 得行数（证明它真的在校验字节）', function () {
  assert.strictEqual(countCR(Buffer.from('a\nb\nc\n', 'utf8')), 0, '纯 LF 必须得 0');
  assert.strictEqual(countCR(Buffer.from('a\r\nb\r\nc\r\n', 'utf8')), 3, 'CRLF 必须每行记 1 个 CR');
  assert.strictEqual(countCR(Buffer.from('a\rb\n', 'utf8')), 1, '孤立 CR 也必须被抓到');
  assert.strictEqual(countCR(Buffer.alloc(0)), 0, '空 buffer 得 0');
  /* 反假绿：判定器不能是"恒返回 0" */
  assert.notStrictEqual(countCR(Buffer.from('\r\n', 'utf8')), 0, '判定器不得恒返回 0');
});

/* ============================================================
   §1 部署文件：CR 必须为 0
   ============================================================ */
test('§1 部署脚本 / nginx 片段 / systemd unit：CR 字节数必须为 0（纯 LF）', function () {
  const bad = [];
  DEPLOY_FILES.forEach(function (rel) {
    const p = path.join(ROOT, rel);
    assert.ok(fs.existsSync(p), '部署文件不存在：' + rel);
    const buf = readBuf(rel);
    assert.ok(buf.length > 0, '部署文件为空：' + rel);
    const cr = countCR(buf);
    if (cr > 0) bad.push(rel + '：CR=' + cr + '（' + buf.length + ' bytes）');
  });
  assert.deepStrictEqual(bad, [],
    '以下部署文件含 CRLF，scp 到 Linux 后会报 $\'\\r\' / nginx 语法错 / systemd 203/EXEC：\n  '
    + bad.join('\n  '));
});

test('§1b 部署文件必须以 LF 结尾（末尾不得是 CR，也不得没有换行）', function () {
  DEPLOY_FILES.forEach(function (rel) {
    const buf = readBuf(rel);
    assert.strictEqual(buf[buf.length - 1], 0x0a, rel + ' 必须以下一个 LF(0x0A) 结尾');
    assert.notStrictEqual(buf[buf.length - 2], 0x0d, rel + ' 行尾不得是 CRLF');
  });
});

/* ============================================================
   §2 .gitattributes 必须覆盖这些文件（否则重新 checkout 又会变 CRLF）
   ============================================================ */
test('§2 .gitattributes 必须声明这些文件为 text eol=lf', function () {
  const gaPath = path.join(ROOT, '.gitattributes');
  assert.ok(fs.existsSync(gaPath), '缺 .gitattributes —— 重新 checkout 会把部署文件写成 CRLF');
  const src = fs.readFileSync(gaPath, 'utf8');
  /* 逐行解析：形如 "<pattern> text eol=lf" */
  const rules = src.split('\n')
    .map(function (l) { return l.replace(/#.*$/, '').trim(); })
    .filter(function (l) { return l !== ''; })
    .map(function (l) { const p = l.split(/\s+/); return { pattern: p[0], attrs: p.slice(1).join(' ') }; });
  assert.ok(rules.length > 0, '.gitattributes 里没有任何规则');

  function covered(rel) {
    return rules.some(function (r) {
      if (r.attrs.indexOf('eol=lf') < 0) return false;
      const pat = r.pattern;
      if (pat === rel) return true;
      if (pat.endsWith('/*')) {
        const dir = pat.slice(0, -1);           /* 'ops/*' → 'ops/' */
        return rel.indexOf(dir) === 0 && rel.slice(dir.length).indexOf('/') < 0;
      }
      return false;
    });
  }
  const missing = DEPLOY_FILES.filter(function (rel) { return !covered(rel); });
  assert.deepStrictEqual(missing, [], '以下文件未被 .gitattributes 的 eol=lf 规则覆盖：' + missing.join(', '));
  /* 反向：不得给 index.html / js / tests 加规则（会把现有行尾字节改掉，牵连指纹类用例） */
  assert.strictEqual(/^index\.html\s/m.test(src), false, '不得给 index.html 加行尾规则（H1/O1 按 md5 校验工作树==HEAD）');
  assert.strictEqual(/^tests\//m.test(src), false, '不得给 tests/ 加行尾规则');
  assert.strictEqual(/^js\//m.test(src), false, '不得给 js/ 加行尾规则');
});

/* ============================================================
   §3 可执行位（scp 之后仍要能直接跑）
   ============================================================ */
test('§3 脚本具备可执行位（rollback/deploy/backup 三者）', function () {
  ['deploy-qa.sh', 'rollback-qa.sh', 'ops/qa-backup.sh'].forEach(function (rel) {
    const p = path.join(ROOT, rel);
    let ok = true;
    try {
      fs.accessSync(p, fs.constants.X_OK);
    } catch (e) {
      ok = false;
    }
    assert.strictEqual(ok, true, rel + ' 缺少可执行位（部署后无法 bash 直接运行）');
  });
});

/* ============================================================
   §4 语法自证：纯 LF 状态下能被 bash 解析
   （注意：bash -n 对 CRLF 的容忍度高于实际执行，故它不能替代 §1）
   ============================================================ */
test('§4 三个 shell 脚本在纯 LF 状态下 bash -n 通过', function () {
  const cp = require('node:child_process');
  ['deploy-qa.sh', 'rollback-qa.sh', 'ops/qa-backup.sh'].forEach(function (rel) {
    const r = cp.spawnSync('bash', ['-n', path.join(ROOT, rel)], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, rel + ' bash -n 失败：' + (r.stderr || ''));
  });
});
