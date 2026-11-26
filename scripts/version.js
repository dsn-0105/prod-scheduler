#!/usr/bin/env node
'use strict';
/* ================================================================
   scripts/version.js —— 版本号「单一真源 + 脚本代笔」
   ================================================================
   为什么需要它：版本号此前散落在 8 个文件的 23 处字面量里（水印、README、
   harness 常量、4 个 independent 测试的字面量副本、guide.js 文首），每次发版
   靠人手工同步，**漏一处就出现「新源码 + 旧锚点」的假失败**（.144 / .148 /
   .159 各踩过一次，见 tests/harness/build.js 版本推进纪律）。

   真源：仓库根的 `VERSION` 文件（与 index.html **物理独立**）。
     BUILD = 本次版本号       形如 2026-11-25.164
     PREV  = 上一版本号       形如 2026-11-23.163

   ★ 与「严禁从 index.html 反推」的关系（这条禁令必须继续成立）：
     tests/harness/build.js 的原禁令本意是**禁止从被测对象（index.html）反推**
     BUILD/PREV —— 那样 `index.html 水印 == BUILD` 就退化成恒真断言，失去守卫意义。
     本脚本的写法**不违反**该禁令：BUILD/PREV 的唯一来源是 VERSION（独立物理文件），
     脚本只是把 VERSION 的值**代笔写进**各落点。因此
       · `index.html 水印 == harness.BUILD` 仍是**两个独立物理来源**的比对 → 仍是真守卫；
       · harness/build.js 仍是「手写字面量 + 不含 readFileSync / 不含 require」的形态
         （qa.parts-ledger.validate.159 §D3、qa.invfilt.161 §H2、qa.invfilt.162 §O2 三重钉住）。
     真正被废除的只是「人肉手抄」这一动作，不是「独立来源互证」这一语义。

   用法（三种口径，显式区分，不做隐式猜测）：
     node scripts/version.js check             只读比对**工作树**；不一致 → 打印清单并退出码 1
                                               （人工核对、scripts/release.sh 用这个）
     node scripts/version.js check --staged    只读比对**暂存区**（git commit 真正会提交的内容）
                                               （pre-commit 钩子必须用这个，否则可用「暂存坏的 +
                                                 工作树改回好的」绕过 —— 见下方「内容来源」注释）
     node scripts/version.js sync              把 VERSION 的值写回**工作树**全部落点，
                                               写完立刻自动再跑一次 check 自证；**绝不写暂存区**

   两种形态的派生规则（短形态用于注释 / 版本行，完整形态用于水印与常量）：
     完整形态 = BUILD 原样                     →  2026-11-25.164
     短形态   = 日期段 + （build . + NNN + ）   →  2026-11-25（build .164）
   ================================================================ */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/** 仓库根（本脚本所在目录的上一级），保证从任意 cwd 调用都能工作 */
const ROOT = path.resolve(__dirname, '..');
/** 版本号合法形态：YYYY-MM-DD.NNN */
const VER_SHAPE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+$/;

/* ---------------------------------------------------------------
   形态派生
   --------------------------------------------------------------- */

/**
 * 把完整版本号渲染为「短形态」：2026-11-25.164 -> 2026-11-25（build .164）
 * @param {string} ver 完整版本号（YYYY-MM-DD.NNN）
 * @returns {string} 短形态
 */
function shortForm(ver) {
  const parts = String(ver).split('.');
  const date = parts[0];
  const seq = parts[1];
  return date + '（build .' + seq + '）';
}

/* ---------------------------------------------------------------
   落点定义 —— 全部集中在这一个 TARGETS 数组里
   ---------------------------------------------------------------
   每项：
     file     相对仓库根的路径（只在这里出现一次，流程代码里不得散落路径）
     where    人类可读的位置提示（行号 + 原文形态），仅供报告/维护者核对
     pattern  带 g 标志的正则；**匹配到的整段文本就是版本 token 本身**
              故一律用「定长 lookbehind/lookahead 锁定上下文」，避免误伤同文件里的
              历史版本号（如 layout.scoped 里的 build 2026-10-15.152 与 .999 哨兵）
     expect   函数 (v) => 期望值数组，按**文件内出现顺序**逐项给出
              v = { build, prev }；数组长度即「该形态在本文件应恰有 N 处」
   --------------------------------------------------------------- */
const TARGETS = [
  /* ① index.html 末尾权威水印。两侧尖括号是 deploy.sh 精确提取的依据，必须保留。
        完整版本号在 index.html 全工程恰 1 处（qa.invfilt.161 §H6 / qa.admin-console §H2 钉住） */
  {
    file: 'index.html',
    where: '第 8946 行 · 末尾固定水印 >build <完整版本><',
    pattern: /(?<=>build )[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+(?=<)/g,
    expect: function (v) { return [v.build]; }
  },
  /* ② README.md 首屏「当前版本」（带反引号，layout.scoped §C5 ⑦ 断言含反引号形态） */
  {
    file: 'README.md',
    where: '第 5 行 · > 当前版本：`build <完整版本>`',
    pattern: /(?<=`build )[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+(?=`)/g,
    expect: function (v) { return [v.build]; }
  },
  /* ③④ tests/harness/build.js 的权威常量（必须保持「手写字面量」形态）
        注：行号刻意不写死 —— 该注释块长度会随维护更新浮动（如 .164 期间就变过一次），
        写死行号只会制造一条「注释与现状不符」的假信息。定位靠 pattern 的 `^const BUILD = '`。 */
  {
    file: 'tests/harness/build.js',
    where: '文件头 · const BUILD = \'<完整版本>\';（行号浮动，勿写死）',
    pattern: /(?<=^const BUILD = ')[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+(?=';$)/gm,
    expect: function (v) { return [v.build]; }
  },
  {
    file: 'tests/harness/build.js',
    where: '文件头 · const PREV = \'<完整版本>\';（行号浮动，勿写死）',
    pattern: /(?<=^const PREV = ')[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+(?=';$)/gm,
    expect: function (v) { return [v.prev]; }
  },
  /* ⑤⑥ tests/qa.ppshift-advance.independent.test.js §E2 两处字面量副本 */
  {
    file: 'tests/qa.ppshift-advance.independent.test.js',
    where: '第 827 / 828 行 · §E2 assert.equal(build.BUILD|PREV, \'<完整版本>\')',
    pattern: /(?<=assert\.equal\(build\.BUILD, ')[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+(?=')/g,
    expect: function (v) { return [v.build]; }
  },
  {
    file: 'tests/qa.ppshift-advance.independent.test.js',
    where: '第 827 / 828 行 · §E2 assert.equal(build.BUILD|PREV, \'<完整版本>\')',
    pattern: /(?<=assert\.equal\(build\.PREV, ')[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+(?=')/g,
    expect: function (v) { return [v.prev]; }
  },
  /* ⑦⑧⑨ tests/qa.prodplan-query.independent.test.js：§E2 两处 + §E4 短形态两处
        （§E4 同一行里 indexOf 实参与断言消息**各含一次**短形态，故期望 2 处） */
  {
    file: 'tests/qa.prodplan-query.independent.test.js',
    where: '第 507 / 508 行 · §E2 assert.equal(build.BUILD|PREV, \'<完整版本>\')',
    pattern: /(?<=assert\.equal\(build\.BUILD, ')[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+(?=')/g,
    expect: function (v) { return [v.build]; }
  },
  {
    file: 'tests/qa.prodplan-query.independent.test.js',
    where: '第 507 / 508 行 · §E2 assert.equal(build.BUILD|PREV, \'<完整版本>\')',
    pattern: /(?<=assert\.equal\(build\.PREV, ')[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+(?=')/g,
    expect: function (v) { return [v.prev]; }
  },
  {
    file: 'tests/qa.prodplan-query.independent.test.js',
    where: '第 533 行 · §E4 guide 版本行短形态 <日期>（build .<NNN>）〔indexOf 实参 + 断言消息各 1 处〕',
    pattern: /[0-9]{4}-[0-9]{2}-[0-9]{2}（build \.[0-9]+）/g,
    expect: function (v) { return [shortForm(v.build), shortForm(v.build)]; }
  },
  /* ⑩⑪ tests/qa.parts-ledger.independent.test.js：BUILD/PREV 手写常量
        （该文件的 BUILD_NO / BUILD_DATE / PREV_NO 由这两行派生，无需另设落点） */
  {
    file: 'tests/qa.parts-ledger.independent.test.js',
    where: '第 32 / 33 行 · const BUILD|PREV = \'<完整版本>\';',
    pattern: /(?<=^const BUILD = ')[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+(?=';$)/gm,
    expect: function (v) { return [v.build]; }
  },
  {
    file: 'tests/qa.parts-ledger.independent.test.js',
    where: '第 32 / 33 行 · const BUILD|PREV = \'<完整版本>\';',
    pattern: /(?<=^const PREV = ')[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+(?=';$)/gm,
    expect: function (v) { return [v.prev]; }
  },
  /* ⑫⑬ layout.scoped.independent.test.js §C5：BUILD/PREV 常量反查副本 */
  {
    file: 'tests/layout.scoped.independent.test.js',
    where: '第 790 / 791 行 · §C5 assert.strictEqual(BUILD.BUILD|PREV, \'<完整版本>\')',
    pattern: /(?<=BUILD\.BUILD, ')[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+(?=')/g,
    expect: function (v) { return [v.build]; }
  },
  {
    file: 'tests/layout.scoped.independent.test.js',
    where: '第 790 / 791 行 · §C5 assert.strictEqual(BUILD.BUILD|PREV, \'<完整版本>\')',
    pattern: /(?<=BUILD\.PREV, ')[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+(?=')/g,
    expect: function (v) { return [v.prev]; }
  },
  /* ⑭⑮ layout.scoped.independent.test.js §C5 ③④：断言「另两个测试文件源码里含 BUILD/PREV 字面量」 */
  {
    file: 'tests/layout.scoped.independent.test.js',
    where: '第 795 / 797 行 · §C5 ③④ pp|pq.indexOf("assert.equal(build.BUILD, \'<完整版本>\'")',
    pattern: /(?<=assert\.equal\(build\.BUILD, ')[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+(?=')/g,
    expect: function (v) { return [v.build, v.build]; }
  },
  {
    file: 'tests/layout.scoped.independent.test.js',
    where: '第 796 / 798 行 · §C5 ③④ pp|pq.indexOf("assert.equal(build.PREV, \'<完整版本>\'")',
    pattern: /(?<=assert\.equal\(build\.PREV, ')[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+(?=')/g,
    expect: function (v) { return [v.prev, v.prev]; }
  },
  /* ⑯ layout.scoped.independent.test.js §C5 ⑦：README 版本行 */
  {
    file: 'tests/layout.scoped.independent.test.js',
    where: '第 804 行 · §C5 ⑦ README_SRC.indexOf(\'build <完整版本>\')',
    pattern: /(?<=README_SRC\.indexOf\('build )[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+(?='\))/g,
    expect: function (v) { return [v.build]; }
  },
  /* ⑰ layout.scoped.independent.test.js §C5 ⑤⑥：短形态 3 处
        （⑤ pq §E4 版本行、⑥ guide.js 文首更新行 = BUILD；⑧ 文末「不得残留上一版更新行」= PREV，
          那一处断言结果为 -1，但字面量本身仍须随 PREV 前移，否则会退化成恒真断言） */
  {
    file: 'tests/layout.scoped.independent.test.js',
    where: '第 799 / 801 / 802 行 · 短形态 <日期>（build .<NNN>）〔799·801=BUILD，802=PREV〕',
    pattern: /[0-9]{4}-[0-9]{2}-[0-9]{2}（build \.[0-9]+）/g,
    expect: function (v) { return [shortForm(v.build), shortForm(v.build), shortForm(v.prev)]; }
  },
  /* ⑱ js/guide.js 文首「更新」行（必须在文件前 8 行内，qa.prodplan-query §E4 用 slice(0,8) 检查） */
  {
    file: 'js/guide.js',
    where: '第 5 行 · > 更新：<日期>（build .<NNN>）。系统功能升级后…',
    pattern: /[0-9]{4}-[0-9]{2}-[0-9]{2}（build \.[0-9]+）/g,
    expect: function (v) { return [shortForm(v.build)]; }
  }
];

/* ---------------------------------------------------------------
   真源读取
   --------------------------------------------------------------- */

/**
 * 打印错误并退出 1。
 * @param {string} msg
 * @returns {void}
 */
function die(msg) {
  console.error(msg);
  process.exit(1);
}

/* ---------------------------------------------------------------
   内容来源（工作树 / 暂存区）
   ---------------------------------------------------------------
   ★ 为什么需要两种口径（P2·D2 修复）：
     `git commit` 提交进库里的是**暂存区**的内容，不是工作树。以前钩子只校验工作树，
     于是存在真实绕过路径：
       ① 把某一落点改成错的 → `git add` 暂存坏的那份；
       ② 再把工作树改回正确（或干脆不再 `git add`）；
       ③ 钩子校验工作树 → 通过 → 提交进库的是**暂存区那份坏的**。
     守卫语义是「校验即将提交的内容」，故钩子必须走 `check --staged`（读索引）。
     而 `sync` 必须写**工作树**（写索引等于替人提交，绝不能做），人工/发布脚本用的
     无参 `check` 也保持读工作树。两者显式区分，不做隐式猜测。
   --------------------------------------------------------------- */

/** 单次 git 调用的输出上限：index.html 约 600KB，留足余量避免 maxBuffer 溢出假失败 */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * 读取索引（暂存区）里的文件内容，等价于「即将提交的那份」。
 * 用 `git show :<path>`（`:<path>` 是索引引用）；stdio 的 stdin 用 'ignore'
 * （本机环境创建 stdin 管道会 EBUSY，项目内其它脚本已有同样处理）。
 * @param {string} relPath 相对仓库根的路径
 * @returns {string|null} 内容；文件不在索引里（未暂存/未跟踪/非 git 仓库）时返回 null
 */
function readFromIndex(relPath) {
  try {
    return execFileSync('git', ['show', ':' + relPath], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: GIT_MAX_BUFFER
    });
  } catch (e) {
    return null;
  }
}

/**
 * 判断某个路径是否存在于 HEAD（用于区分「新建未暂存」与「被暂存删除」）。
 * @param {string} relPath 相对仓库根的路径
 * @returns {boolean} HEAD 里是否有该文件
 */
function existsInHead(relPath) {
  try {
    execFileSync('git', ['cat-file', '-e', 'HEAD:' + relPath], {
      cwd: ROOT,
      stdio: ['ignore', 'ignore', 'ignore']
    });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 读工作树里的文件；不存在则视为落点定义过期，直接报错退出。
 * @param {string} relPath 相对仓库根的路径
 * @param {string} hint 人类可读的位置提示
 * @returns {string} 文件全文
 */
function readWorktree(relPath, hint) {
  const abs = path.join(ROOT, relPath);
  if (!fs.existsSync(abs)) {
    die('[x] 读取失败：文件不存在 —— ' + relPath + '\n'
      + '    位置提示：' + hint + '\n'
      + '    TARGETS / VERSION 定义已过期，或文件被改名、删除；请先修正 scripts/version.js。');
  }
  return fs.readFileSync(abs, 'utf8');
}

/**
 * 构造一个「按指定口径读取文件」的读取器。
 *
 * staged=true 时优先读索引；若文件不在索引里（尚未 `git add`）**退回工作树并记录提示**
 * —— 既不静默通过（提示会打印出来），也不直接崩（否则首次提交前根本跑不了钩子）。
 * 但「HEAD 有、索引没有」= 落点文件被暂存删除，这属于真问题，直接报错退出。
 *
 * @param {boolean} staged 是否读暂存区
 * @param {string[]} notes 收集「退回工作树」的提示
 * @returns {(relPath: string, hint: string) => string} 读取器
 */
function makeReader(staged, notes) {
  return function read(relPath, hint) {
    if (!staged) return readWorktree(relPath, hint);
    const stagedText = readFromIndex(relPath);
    if (stagedText !== null) return stagedText;
    if (existsInHead(relPath)) {
      die('[x] 落点文件在暂存区里被删除了：' + relPath + '\n'
        + '    提交这份索引会删掉一个版本锚点（' + hint + '），已中止。\n'
        + '    若确实要删该文件，请同步修改 scripts/version.js 的 TARGETS 定义。');
    }
    notes.push(relPath + ' —— 未纳入暂存区（未 `git add`），按工作树内容校验');
    return readWorktree(relPath, hint);
  };
}

/**
 * 读取并校验 VERSION 文件（单一真源）。
 * @param {(relPath: string, hint: string) => string} read 内容读取器（决定工作树/暂存区口径）
 * @returns {{build: string, prev: string}} 版本对象
 */
function readVersions(read) {
  const reader = read || function (relPath, hint) { return readWorktree(relPath, hint); };
  const text = reader('VERSION', '版本单一真源（仓库根）：应为 BUILD=2026-11-25.164 / PREV=2026-11-23.163 两行');
  const vars = {};
  text.split('\n').forEach(function (raw) {
    const line = raw.replace(/\r$/, '').trim();
    if (line === '' || line.charAt(0) === '#') return;
    const i = line.indexOf('=');
    if (i < 0) die('[x] VERSION 第 ' + (Object.keys(vars).length + 1) + ' 行格式非法（应为 KEY=VALUE）：' + line);
    const key = line.slice(0, i).trim();
    const val = line.slice(i + 1).trim();
    if (key !== 'BUILD' && key !== 'PREV') die('[x] VERSION 出现未知键「' + key + '」（只允许 BUILD / PREV）');
    vars[key] = val;
  });
  if (!vars.BUILD) die('[x] VERSION 缺少 BUILD= 行');
  if (!vars.PREV) die('[x] VERSION 缺少 PREV= 行');
  if (!VER_SHAPE.test(vars.BUILD)) die('[x] VERSION 的 BUILD 形态非法：「' + vars.BUILD + '」（应为 YYYY-MM-DD.NNN）');
  if (!VER_SHAPE.test(vars.PREV)) die('[x] VERSION 的 PREV 形态非法：「' + vars.PREV + '」（应为 YYYY-MM-DD.NNN）');
  if (vars.BUILD === vars.PREV) die('[x] VERSION 的 BUILD 与 PREV 不能相同（PREV 必须是上一版，否则「旧形态 0 处」断言退化为恒真）');
  return { build: vars.BUILD, prev: vars.PREV };
}

/* ---------------------------------------------------------------
   落点扫描 / 比对 / 写回
   --------------------------------------------------------------- */

/**
 * 计算字符下标所在的 1 基行号。
 * @param {string} text 全文
 * @param {number} index 字符下标
 * @returns {number} 行号（1 基）
 */
function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n++;
  }
  return n;
}

/**
 * 在文本里收集某个落点形态的全部命中（按出现顺序）。
 * 正则每次克隆，避免带 g 标志的 RegExp 共享 lastIndex 造成漏扫。
 * @param {{pattern: RegExp}} target 落点定义
 * @param {string} text 全文
 * @returns {Array<{index: number, text: string, line: number}>} 命中列表
 */
function collect(target, text) {
  const re = new RegExp(target.pattern.source, target.pattern.flags);
  const hits = [];
  let m = re.exec(text);
  while (m !== null) {
    hits.push({ index: m.index, text: m[0], line: lineOf(text, m.index) });
    if (m[0].length === 0) re.lastIndex++; /* 空匹配防护，避免死循环 */
    m = re.exec(text);
  }
  return hits;
}

/**
 * 校验（只读）。返回问题清单与落点总数。
 * @param {{build: string, prev: string}} versions 版本对象
 * @param {(relPath: string, hint: string) => string} read 内容读取器（暂存区 / 工作树）
 * @returns {{problems: string[], total: number, files: number}} 结果
 */
function verify(versions, read) {
  const problems = [];
  let total = 0;
  TARGETS.forEach(function (target) {
    const text = read(target.file, target.where);
    const hits = collect(target, text);
    const want = target.expect(versions);
    total += want.length;

    if (hits.length !== want.length) {
      problems.push(target.file + ': 期望 ' + want.length + ' 处【' + target.where + '】，实际 ' + hits.length + ' 处'
        + (hits.length
          ? '；实际命中：' + hits.map(function (h) { return '第 ' + h.line + ' 行「' + h.text + '」'; }).join('、')
          : '；一处都没命中 —— 落点形态变了（或被删），请核对 scripts/version.js 的 TARGETS'));
    }
    const n = Math.min(hits.length, want.length);
    for (let i = 0; i < n; i++) {
      if (hits[i].text !== want[i]) {
        problems.push(target.file + ':' + hits[i].line
          + ' 期望 ' + want[i] + ' 实际 ' + hits[i].text
          + '（' + target.where + '，该形态第 ' + (i + 1) + '/' + want.length + ' 处）');
      }
    }
  });
  return { problems: problems, total: total, files: TARGETS.length };
}

/**
 * check 模式：只读比对，任何一处不符 → 打印清单 + 退出码 1。
 * @param {{build: string, prev: string}} versions 版本对象
 * @param {{staged: boolean, notes: string[]}} opts staged=校验暂存区；notes=退回工作树的提示
 * @returns {void}
 */
function runCheck(versions, opts) {
  const staged = Boolean(opts && opts.staged);
  const notes = (opts && opts.notes) || [];
  const read = makeReader(staged, notes);

  /* 先声明校验口径：两种口径的结论可能不同，不写清楚就会让人误判 */
  console.log(staged
    ? '[i] 校验口径：**暂存区**（git commit 真正会提交的内容；未暂存的文件退回工作树并逐条提示）'
    : '[i] 校验口径：工作树（当前磁盘内容）');

  const r = verify(versions, read);

  if (notes.length > 0) {
    notes.forEach(function (n) { console.log('[!] 未暂存，按工作树校验：' + n); });
  }

  if (r.problems.length === 0) {
    console.log('[ok] 版本一致：' + r.total + ' 处落点 / ' + r.files + ' 条规则（BUILD=' + versions.build + ' PREV=' + versions.prev + '）');
    return;
  }
  console.error('[x] 版本不一致：' + r.problems.length + ' 个问题（真源 VERSION：BUILD=' + versions.build + ' PREV=' + versions.prev + '）');
  console.error('');
  r.problems.forEach(function (p) { console.error('    ' + p); });
  console.error('');
  console.error('    修复方式（二选一）：');
  console.error('      a) 落点是笔误/漏改 → 执行  node scripts/version.js sync  由脚本代笔写回全部落点');
  console.error('      b) 落点形态真的变了（新增/删除/改写）→ 先改 scripts/version.js 的 TARGETS 定义，再 sync');
  console.error('    ⚠ 不要为了迁就现状去手改 VERSION，也不要手改落点 —— 手抄正是要消灭的失败来源。');
  if (staged) {
    console.error('    ⚠ 本口径读的是**暂存区**：sync 改的是工作树，改完还需 git add 落点文件，否则索引里仍是旧的。');
  }
  process.exit(1);
}

/**
 * sync 模式：把真源的值写回全部落点；写不动的地方一律报错，绝不猜测。
 * 写完立刻再跑一次 verify 自证（防止「写了个寂寞」）。
 * @param {{build: string, prev: string}} versions 版本对象
 * @returns {void}
 */
function runSync(versions) {
  const problems = [];
  /* ★ sync 一律读写**工作树**，绝不碰暂存区：写索引等于替人执行 git add / 替人决定提交内容，
     那会毁掉「人先审 diff 再提交」这条底线。故这里显式用工作树读取器，不受 --staged 影响。 */
  const readWorktreeOnly = function (relPath, hint) { return readWorktree(relPath, hint); };
  /* 按文件聚合：**同一文件可能被多条规则命中**（layout.scoped 有 6 条规则、23 处落点）。
     若每条规则各自 readFileSync + writeFileSync，后写的会覆盖前写的（实测踩过：
     sync 报「已写回 23 处」但自证只有 5 处生效）。故必须先全部收集、再按文件一次性写回。 */
  const byFile = new Map();

  TARGETS.forEach(function (target) {
    const text = readWorktreeOnly(target.file, target.where);
    const hits = collect(target, text);
    const want = target.expect(versions);
    if (hits.length !== want.length) {
      problems.push(target.file + ': 期望 ' + want.length + ' 处【' + target.where + '】，实际 ' + hits.length + ' 处'
        + '；结构不符时 sync 拒绝写入（否则会写错位置）');
      return;
    }
    let entry = byFile.get(target.file);
    if (!entry) {
      entry = { text: text, items: [] };
      byFile.set(target.file, entry);
    }
    hits.forEach(function (hit, i) {
      entry.items.push({
        index: hit.index,
        length: hit.text.length,
        from: hit.text,
        to: want[i],
        line: hit.line,
        where: target.where
      });
    });
  });

  if (problems.length > 0) {
    console.error('[x] sync 中止：落点结构与 TARGETS 定义不符，' + problems.length + ' 个问题');
    console.error('');
    problems.forEach(function (p) { console.error('    ' + p); });
    console.error('');
    console.error('    请先核对/更新 scripts/version.js 的 TARGETS，再重新执行 sync。');
    process.exit(1);
  }

  let written = 0;          /* 实际改写的 token 数 */
  let touchedFiles = 0;     /* 实际落盘的文件数 */
  const details = [];

  byFile.forEach(function (entry, file) {
    /* 同一文件内按位置升序；相邻区间不得重叠（重叠=规则定义互相打架，必须暴露而非猜测） */
    entry.items.sort(function (a, b) { return a.index - b.index; });
    for (let i = 1; i < entry.items.length; i++) {
      const prev = entry.items[i - 1];
      const cur = entry.items[i];
      if (prev.index + prev.length > cur.index) {
        console.error('[x] sync 中止：' + file + ' 的落点区间重叠（第 ' + prev.line + ' 行与第 ' + cur.line + ' 行），'
          + 'TARGETS 里有两条规则匹配到了同一段文本，请修正正则边界。');
        process.exit(1);
      }
    }

    let out = '';
    let cursor = 0;
    let changedHere = 0;
    entry.items.forEach(function (item) {
      out += entry.text.slice(cursor, item.index) + item.to;
      cursor = item.index + item.length;
      if (item.from !== item.to) {
        changedHere++;
        details.push(file + ':' + item.line + '  ' + item.from + ' -> ' + item.to);
      }
    });
    out += entry.text.slice(cursor);

    if (changedHere > 0) {
      fs.writeFileSync(path.join(ROOT, file), out, 'utf8');
      written += changedHere;
      touchedFiles++;
    }
  });

  if (written === 0) {
    console.log('[ok] 无需写回：' + TARGETS.length + ' 条规则覆盖的落点全部已是目标值（幂等）');
  } else {
    console.log('[ok] 已写回 ' + written + ' 处，涉及 ' + touchedFiles + ' 个文件：');
    details.forEach(function (d) { console.log('    ' + d); });
  }

  /* 自证：sync 之后必须 check 通过，否则立刻以 1 退出（绝不留下「sync 说成功但实际不一致」） */
  const r = verify(versions, readWorktreeOnly);
  if (r.problems.length > 0) {
    console.error('');
    console.error('[x] sync 后自证失败：仍有 ' + r.problems.length + ' 个与真源不符的落点');
    r.problems.forEach(function (p) { console.error('    ' + p); });
    process.exit(1);
  }
  console.log('[ok] 自证通过：' + r.total + ' 处落点全部等于真源（BUILD=' + versions.build + ' PREV=' + versions.prev + '）');
}

/* ---------------------------------------------------------------
   CLI
   --------------------------------------------------------------- */

const MODE = process.argv[2];
const FLAGS = process.argv.slice(3);

if (MODE === 'check') {
  /* `--staged`（pre-commit 钩子用）：校验**暂存区**，即 git commit 真正会提交的那份内容。
     不带参数（人工 / release.sh 用）：校验工作树。两种口径显式区分，不隐式猜测。 */
  const staged = FLAGS.indexOf('--staged') >= 0;
  const notes = [];
  runCheck(readVersions(makeReader(staged, notes)), { staged: staged, notes: notes });
} else if (MODE === 'sync') {
  runSync(readVersions());
} else if (MODE === 'list') {
  /* 辅助模式：打印落点清单（不读文件，纯定义自检，便于核对「落点有没有漏」）。
     顺带给出**权威的条数/处数**：tests/harness/build.js 的注释刻意不写死这两个数字
     （绝对计数会随新增测试文件腐化），改由本命令现算，供人工与文档引用。 */
  const PROBE = { build: '1970-01-01.1', prev: '1970-01-01.0' }; /* 仅用于数数组长度，值本身无关 */
  let totalHits = 0;
  const fileSet = new Set();
  console.log('落点规则共 ' + TARGETS.length + ' 条：');
  TARGETS.forEach(function (t, i) {
    const n = t.expect(PROBE).length;
    totalHits += n;
    fileSet.add(t.file);
    console.log('  ' + String(i + 1).padStart(2, '0') + '. ' + t.file + ' — ' + t.where + '  [' + n + ' 处]');
  });
  console.log('合计：' + totalHits + ' 处字面量 / ' + fileSet.size + ' 个文件 / ' + TARGETS.length + ' 条规则');
} else {
  console.error('用法：node scripts/version.js <check [--staged] | sync | list>');
  console.error('  check           只读比对全部落点（读**工作树**）；不一致则退出码 1');
  console.error('  check --staged  只读比对全部落点（读**暂存区**=即将提交的内容）；pre-commit 钩子用这个');
  console.error('  sync            把 VERSION 的值写回全部落点（写**工作树**），并自动再 check 一次自证');
  console.error('  list            打印落点清单（核对用，不读写任何落点文件）');
  process.exit(1);
}
