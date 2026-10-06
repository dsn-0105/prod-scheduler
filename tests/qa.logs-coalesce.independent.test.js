'use strict';
/* ================================================================
   tests/qa.logs-coalesce.independent.test.js
   —— 独立 QA 回归：build 2026-10-06.135「审计日志落盘同段合并」修复
   ================================================================
   立场：**证伪优先**。本文件不复述 tests/logs.coalesce.test.js 的口径，而是
   独立重写断言，并携带「变异实现对拍」（mutation test）证明每条断言**有判别力**
   —— 而不是恒真的虚设锚点。

   覆盖（对应派单 §一~§七）：
     §Q1 合并生效：同段 N 次 logOp → logs 落盘恰 1 次且内容不丢
         —— 对拍变异 OLD_IMPL（还原 .134 前逐次落盘）与 NO_DEDUP（去掉去重标志）
     §Q2 不得永久抑制：跨段（await 之后）再 logOp 必须再落盘
         —— 对拍变异 NO_RESET（删掉微任务体内复位）与 WRONG_PLACE（复位挪到函数开头）
     §Q3 `pushLogEntry` 不落盘 + `.125` 四个事务写入点零新增写
     §Q4 服务端 `logsAppendOK` 追加白名单兼容（未触顶 / 恰触顶 / 应拒绝形状）
     §Q5 `clearLogs` 交互（清空 + 紧随 logOp 不得写回旧内容）
     §Q6 截断 500 与存量语义（含与 §Q4 白名单的端到端对拍）
     §Q7 水印单一来源不虚设（tests/harness/build.js ⇄ index.html）
     §Q8 被调整的既有用例是否被削弱（写序不变量已被显式放弃）

   运行：node --test tests/qa.logs-coalesce.independent.test.js
   ⚠️ 必须用**文件**方式跑（勿用 `node -e` 驱动 vm，见 tests/harness/sandbox.js 顶部）
   ================================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createApp, ROOT } = require('./harness/sandbox');
const build = require('./harness/build');
const serverMod = require(path.join(ROOT, 'server', 'server.js'));

const LOG_MAX = serverMod.LOG_MAX;
const logsAppendOK = serverMod.logsAppendOK;

const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const LOGS_SRC = fs.readFileSync(path.join(ROOT, 'js', 'logs.js'), 'utf8');

/* ================================================================
   基础工具
   ================================================================ */

/** 排空微任务：logOp 的落盘自 .135 起推迟到一个微任务。
    用 setImmediate（宏任务）而非 `await Promise.resolve()`，确保连锁微任务全部跑完。 */
function drain() { return new Promise(function (r) { setImmediate(r); }); }

/** 跨 realm 纯值化（vm 返回对象的原型属于 vm realm） */
function plain(v) { return JSON.parse(JSON.stringify(v)); }

/** 该 app 上 logs 表的 save 调用序列（value + silent） */
function logsWrites(app) {
  return plain(
    app.recorder
      .of('save')
      .filter(function (c) { return c.key === 'logs'; })
      .map(function (c) { return { value: c.value, silent: c.silent }; })
  );
}

/** 用自建 spy 覆盖沙箱内全局 `save`，以便观察第 3 参 silent（recorder 不透传） */
function spyOnSave(app) {
  const calls = [];
  app.sandbox.save = function (k, v, silent) {
    calls.push({ k: k, v: JSON.parse(JSON.stringify(v)), silent: silent });
  };
  return calls;
}

/** 单段 logOp 的「最小可用」沙箱（日志相关代码不依赖其它表）。
    ⚠️ logs 必须传**深拷贝**：setGlobal 把宿主数组交给 vm 后，vm 内的
    `logs.unshift(...)` 会**原地改写宿主那份基准数组**（本文档最初就踩了这个坑，
    导致「旧值」基准被污染、白名单断言退化恒真）。 */
function mkLogsApp(seed) {
  const s = Object.assign({ logs: [] }, seed || {});
  s.logs = plain(s.logs);
  return createApp({ seed: s });
}

/** 花括号配平抽取源码函数体（含 async 前缀），用于静态形态断言 */
function extractFn(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(', 'g');
  const m = re.exec(src);
  if (!m) throw new Error('未找到函数: ' + name);
  let p = m.index + m[0].length;
  let d = 1;
  for (; p < src.length; p++) {
    if (src[p] === '(') d++;
    else if (src[p] === ')') { d--; if (d === 0) break; }
  }
  const i = src.indexOf('{', p);
  let j = i;
  d = 0;
  for (; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (d === 0) break; }
  }
  return src.slice(m.index, j + 1);
}

/* ================================================================
   §0 变异注入器（反虚设取证的地基）
   ------------------------------------------------------------
   每个变异都**先断言自己生效**（`mut !== src`），否则「对拍通过」会退化为
   「变异根本没注入」的假结论 —— 这是反虚设取证最容易翻车的地方。
   ================================================================ */

function mutateLogsSrc(kind) {
  const src = LOGS_SRC;
  const CALL_RE = /^[ \t]*scheduleLogFlush\(\);[ \t]*$/m;
  let out;
  switch (kind) {
    /* .134 及以前的实现：logOp 每次直接整表覆盖写（无合并） */
    case 'OLD_IMPL':
      out = src.replace(CALL_RE, "  save('logs',logs,true);");
      assert.notEqual(out, src, '变异 OLD_IMPL 未生效');
      /* 精确到函数体：logOp 内必须真的出现了直接落盘 */
      assert.match(extractFn(out, 'logOp'), /save\('logs',logs,true\)/,
        'OLD_IMPL 后 logOp 体内应直接落盘');
      assert.doesNotMatch(extractFn(out, 'logOp'), /scheduleLogFlush\s*\(/,
        'OLD_IMPL 后 logOp 不应再委托 scheduleLogFlush');
      return out;

    /* 去重标志「不置位」：每次 logOp 都排队一个微任务 → 合并在同段内失效 */
    case 'NO_DEDUP':
      out = src.replace(/[ \t]*if\(logFlushPending\)return;[ \t]*\n/, '');
      assert.notEqual(out, src, '变异 NO_DEDUP 未生效');
      return out;

    /* 删掉微任务体内的复位 → logFlushPending 永远为 true → 日志**从此再也写不出去** */
    case 'NO_RESET':
      out = src.replace(/logFlushPending\s*=\s*false\s*;\s*\n([ \t]*)save\(\s*'logs'/, '$1save(\'logs\'');
      assert.notEqual(out, src, '变异 NO_RESET 未生效');
      assert.doesNotMatch(extractFn(out, 'scheduleLogFlush'), /logFlushPending\s*=\s*false/,
        'NO_RESET 后 scheduleLogFlush 内不应再有复位');
      return out;

    /* 复位「写错位置」：挪到函数开头（去重判定之前）→ 早退分支恒不触发 → 去重失效 */
    case 'WRONG_PLACE':
      out = src.replace(/logFlushPending\s*=\s*false\s*;\s*\n([ \t]*)save\(\s*'logs'/, '$1save(\'logs\'');
      out = out.replace(/function scheduleLogFlush\(\)\{/, 'function scheduleLogFlush(){ logFlushPending=false;');
      assert.notEqual(out, src, '变异 WRONG_PLACE 未生效');
      assert.match(out, /function scheduleLogFlush\(\)\{\s*logFlushPending=false;/,
        'WRONG_PLACE 后复位应位于函数开头');
      return out;

    /* logOp 完全不落盘（模拟「漏改调用点」） */
    case 'NO_FLUSH':
      out = src.replace(CALL_RE, '  /* scheduleLogFlush 调用已被变异删除 */');
      assert.notEqual(out, src, '变异 NO_FLUSH 未生效');
      return out;

    default:
      throw new Error('未知变异: ' + kind);
  }
}

/** 以指定变异装载生产代码的沙箱（模块装载钩子，不去改磁盘文件） */
function mkMutantApp(kind, seed) {
  return createApp({
    transformModule: function (rel, code) {
      return rel === 'js/logs.js' ? mutateLogsSrc(kind) : code;
    },
    seed: Object.assign({ logs: [] }, seed || {}),
  });
}

/* ================================================================
   §Q1 合并生效 —— 同段 N 次 logOp → 恰 1 次落盘，内容不丢
   ================================================================ */

test('Q1-1 同段两次 logOp：logs 落盘恰 1 次，且一次写入即含两条（新→旧），silent 仍为 true', async () => {
  const app = mkLogsApp();
  const calls = spyOnSave(app);
  app.run("logOp('系统','A','第一条'); logOp('系统','B','第二条');");

  assert.equal(plain(app.getGlobal('logs')).length, 2, '两条须都入内存');
  assert.equal(calls.length, 0, '同步段内不得落盘（已推迟到微任务）');
  await drain();
  assert.equal(calls.length, 1, '同段 2 次 logOp 必须合并为恰 1 次落盘');
  assert.equal(calls[0].k, 'logs');
  assert.equal(calls[0].silent, true, 'silent=true 语义不变');
  assert.equal(calls[0].v.length, 2, '一次写入即含两条（内容不丢）');
  assert.deepEqual(calls[0].v.map(function (x) { return x.detail; }), ['第二条', '第一条']);
  app.dispose();
});

test('Q1-2 同段三次 logOp：仍恰 1 次落盘，三条全在', async () => {
  const app = mkLogsApp();
  app.run("logOp('系统','A','a1'); logOp('系统','B','b1'); logOp('系统','C','c1');");
  await drain();
  assert.equal(app.recorder.countOf('logs'), 1, '三次调用 → 恰 1 次落盘');
  const w = logsWrites(app)[0].value;
  assert.equal(w.length, 3, '三条全在一次写入里');
  assert.deepEqual(w.map(function (x) { return x.detail; }), ['c1', 'b1', 'a1']);
  app.dispose();
});

test('Q1-3【对拍·变异 OLD_IMPL】还原 .134 前「逐次落盘」→ 同段两次必然写 2 次（= 线上丢条的根因形状）', async () => {
  const app = mkMutantApp('OLD_IMPL');
  app.run("logOp('系统','A','第一条'); logOp('系统','B','第二条');");
  assert.equal(app.recorder.countOf('logs'), 2,
    'OLD_IMPL 下同段两次调用 = 2 次覆盖写（第二条携带过期 rev → 线上被 silent 静默吞掉）');
  /* 判别力证明：Q1-1 的「恰 1 次」断言在本变异下必然失败（2 !== 1） */
  assert.notEqual(app.recorder.countOf('logs'), 1, '本变异下 Q1-1 断言不可能通过 → 该断言有判别力');
  app.dispose();
});

test('Q1-4【对拍·变异 NO_DEDUP】去掉 logFlushPending 早退 → 同段两次写 2 次（去重标志是必需的）', async () => {
  const app = mkMutantApp('NO_DEDUP');
  app.run("logOp('系统','A','第一条'); logOp('系统','B','第二条');");
  await drain();
  assert.equal(app.recorder.countOf('logs'), 2, '无去重标志时每次 logOp 各自排队一个微任务 → 2 次写');
  assert.notEqual(app.recorder.countOf('logs'), 1, '本变异下 Q1-1 断言不可能通过');
  app.dispose();
});

/* ================================================================
   §Q1.5 线上事故的**本地等价复现**（模拟服务端乐观锁 rev）
   ------------------------------------------------------------
   为什么必须做：§Q1-1 只能证明「合并成 1 次」，不能证明「不合并就会丢条」。
   这里用「期望 rev / 当前 rev」模型复刻线上 `[冲突拦截] key=logs expectedRev=0 curRev=1`
   的判定链：本地 serverRevs 只在**响应回来后**刷新（与 index.html DB.set:403-430 一致）
   ⇒ 同一同步段内第二次写必然携带过期 rev ⇒ 409 ⇒ silent 吞掉。
   ================================================================ */

/** 装入「乐观锁服务器」桩：返回 { requests, applied, conflicts, alerts } */
function installRevServer(app) {
  const serverRevs = {};
  const localRevs = {};        /* 客户端本地版本号：仅在「响应回来后」刷新（复刻生产） */
  const requests = [];         /* 发到服务端的写请求（含 expectedRev） */
  const applied = [];          /* 服务端实际落盘的写 */
  const conflicts = [];        /* 被 409 拦截的写 */
  const notified = [];         /* 非 silent 的冲突提示 */

  app.sandbox.save = function (k, v, silent) {
    const expected = localRevs[k] || 0;
    requests.push({ k: k, expected: expected, details: (v || []).map(function (x) { return x.detail; }) });
    const cur = serverRevs[k] || 0;
    if (expected === cur) {
      serverRevs[k] = cur + 1;
      applied.push({ k: k, details: JSON.parse(JSON.stringify(v)).map(function (x) { return x.detail; }) });
    } else {
      conflicts.push({ k: k, expected: expected, cur: cur });
      if (!silent) notified.push(k);   /* silent=409 只刷新 revs、不提示（.124 口径） */
    }
    /* 响应异步到达 → 此刻才刷新本地 rev：这正是「同段第二条携带过期 rev」的根因 */
    Promise.resolve().then(function () { localRevs[k] = serverRevs[k]; });
    return v;
  };
  return { serverRevs: serverRevs, localRevs: localRevs, requests: requests, applied: applied, conflicts: conflicts, notified: notified };
}

test('Q1-5【事故复现】两次迁移同段各 logOp：.135 合并后 0 冲突、两条都在；OLD_IMPL 必丢 1 条（= 线上症状）', async () => {
  /* ---- A) 真实实现 ---- */
  const appA = mkLogsApp();
  const srvA = installRevServer(appA);
  appA.run("logOp('系统','交付计划','系统迁移：字段配置补齐「交付计划编号」'); logOp('系统','交付计划','系统迁移：存量交付计划回填交付计划编号 62 条');");
  await drain();
  assert.equal(srvA.requests.length, 1, '合并后只发 1 个写请求');
  assert.equal(srvA.conflicts.length, 0, '不应有任何乐观锁冲突');
  assert.equal(srvA.applied.length, 1);
  assert.deepEqual(srvA.applied[0].details,
    ['系统迁移：存量交付计划回填交付计划编号 62 条', '系统迁移：字段配置补齐「交付计划编号」'],
    '两条审计记录都在（.134 线上丢掉的「回填 62 条」这条必须回来）');
  assert.deepEqual(srvA.notified, [], 'silent 下不打扰用户');
  appA.dispose();

  /* ---- B) 变异 OLD_IMPL（.134 及以前）---- */
  const appB = mkMutantApp('OLD_IMPL');
  const srvB = installRevServer(appB);
  appB.run("logOp('系统','交付计划','系统迁移：字段配置补齐「交付计划编号」'); logOp('系统','交付计划','系统迁移：存量交付计划回填交付计划编号 62 条');");
  await drain();
  assert.equal(srvB.requests.length, 2, 'OLD_IMPL 下同段两次调用发 2 个写请求');
  assert.deepEqual(srvB.conflicts, [{ k: 'logs', expected: 0, cur: 1 }],
    '复刻线上 [冲突拦截] key=logs expectedRev=0 curRev=1');
  assert.equal(srvB.applied.length, 1, '只有第一条落盘');
  assert.deepEqual(srvB.applied[0].details, ['系统迁移：字段配置补齐「交付计划编号」']);
  assert.equal(srvB.applied[0].details.join('|').indexOf('62 条'), -1,
    '「回填 62 条」这条**永久丢失** —— 与线上实测完全一致（silent=true → 不提示、不重试）');
  assert.deepEqual(srvB.notified, [], 'silent=true 导致丢失无声无息');
  appB.dispose();
});

test('Q1-6【事故复现·第二个同源实例】全量多表单导入（同段 N 次 logOp）：.135 保住全部 N 条，OLD_IMPL 只保第 1 条', async () => {
  const N = 6;   /* js/import.js 的 plan.forEach：一次全量导入最多 6 个 sheet，全程无 await */

  const appA = mkLogsApp();
  const srvA = installRevServer(appA);
  appA.run("for(var i=0;i<" + N + ";i++)logOp('导入','sheet'+i,'全量导入 10 条记录');");
  await drain();
  assert.equal(srvA.requests.length, 1, '.135：N 次同段 logOp 合并为 1 个请求');
  assert.equal(srvA.conflicts.length, 0);
  assert.equal(srvA.applied[0].details.length, N, 'N 条导入审计记录全部落盘');
  appA.dispose();

  const appB = mkMutantApp('OLD_IMPL');
  const srvB = installRevServer(appB);
  appB.run("for(var i=0;i<" + N + ";i++)logOp('导入','sheet'+i,'全量导入 10 条记录');");
  await drain();
  assert.equal(srvB.requests.length, N);
  assert.equal(srvB.conflicts.length, N - 1, 'OLD_IMPL：第 2..N 个请求全部 409（本地 rev 尚未刷新）');
  assert.equal(srvB.applied.length, 1, '只有第 1 条导入日志活下来');
  assert.deepEqual(srvB.notified, []);
  appB.dispose();
});

/* ================================================================
   §Q2 不得永久抑制 —— 跨段必须再落盘
   ================================================================ */

test('Q2-1 跨段（await 之后）再 logOp：会**再**落盘一次，且第二次写入 = 新条目 + 存量', async () => {
  const app = mkLogsApp();
  app.run("logOp('系统','A','第一条');");
  await drain();
  assert.equal(app.recorder.countOf('logs'), 1, '第一段落盘 1 次');
  assert.equal(plain(app.getGlobal('logFlushPending')), false, '排空后去重标志必须已复位为 false');

  app.run("logOp('系统','B','第二条');");
  await drain();
  assert.equal(app.recorder.countOf('logs'), 2,
    '第二个同步段必须独立落盘（若仍为 1 → 标志未复位 → 审计日志被永久抑制）');
  const val = logsWrites(app)[1].value;
  assert.deepEqual(val.map(function (x) { return x.detail; }), ['第二条', '第一条'],
    '第二段落盘 = 新条目 + 存量（不得丢存量）');
  app.dispose();
});

test('Q2-2 连续 5 个同步段：落盘次数必须随段数线性增长（5），且每段都带全量内存', async () => {
  const app = mkLogsApp();
  for (let i = 1; i <= 5; i++) {
    app.run("logOp('系统','S','第" + i + "段');");
    await drain();
    assert.equal(app.recorder.countOf('logs'), i, '第 ' + i + ' 段后落盘次数应为 ' + i);
  }
  const last = logsWrites(app)[4].value;
  assert.deepEqual(last.map(function (x) { return x.detail; }),
    ['第5段', '第4段', '第3段', '第2段', '第1段'], '每段落盘都是当时最新全量（新→旧）');
  app.dispose();
});

test('Q2-3【对拍·变异 NO_RESET】删掉微任务体内复位 → 第二段起日志再也写不出去，Q2-1 必然失败', async () => {
  const app = mkMutantApp('NO_RESET');
  app.run("logOp('系统','A','第一条');");
  await drain();
  assert.equal(app.recorder.countOf('logs'), 1, '第一段仍能落盘 1 次');
  assert.equal(plain(app.getGlobal('logFlushPending')), true, '标志卡在 true（永久抑制）');

  app.run("logOp('系统','B','第二条');");
  await drain();
  assert.equal(app.recorder.countOf('logs'), 1,
    'NO_RESET 下第二段一字未落 —— 若此处真为 2，则说明本用例无判别力');
  assert.notEqual(app.recorder.countOf('logs'), 2, '本变异下 Q2-1 的「第二段 = 2」断言必然失败');
  app.dispose();
});

test('Q2-4【对拍·变异 WRONG_PLACE】复位挪到函数开头 → 去重失效（Q1-1 必然失败，Q2-1 仍通过）', async () => {
  const app = mkMutantApp('WRONG_PLACE');
  app.run("logOp('系统','A','第一条'); logOp('系统','B','第二条');");
  await drain();
  assert.equal(app.recorder.countOf('logs'), 2, 'WRONG_PLACE 下早退分支恒不触发 → 同段两次写 2 次');
  assert.notEqual(app.recorder.countOf('logs'), 1, '本变异下 Q1-1 断言必然失败（合并能力被破坏）');
  app.dispose();
});

/* ================================================================
   §Q3 pushLogEntry 不落盘 + .125 四个事务写入点
   ================================================================ */

test('Q3-1 pushLogEntry 只入内存、绝不落盘（否则会与事务写抢 rev）', async () => {
  const app = mkLogsApp();
  app.run("pushLogEntry(makeLogEntry('删除','X','p1')); pushLogEntry(makeLogEntry('删除','X','p2'));");
  await drain();
  assert.equal(app.recorder.writeCount(), 0, 'pushLogEntry 不得触发任何写入口（save/set/tx）');
  assert.equal(plain(app.getGlobal('logs')).length, 2, '两条仍须入内存，供调用方并入事务');
  app.dispose();
});

test('Q3-2 静态形态：pushLogEntry 源码内不含 save( / DB. / scheduleLogFlush(；且不调用 logOp', () => {
  const body = extractFn(LOGS_SRC, 'pushLogEntry');
  assert.doesNotMatch(body, /save\s*\(/, 'pushLogEntry 不得含 save(');
  assert.doesNotMatch(body, /scheduleLogFlush\s*\(/, 'pushLogEntry 不得含 scheduleLogFlush(');
  assert.doesNotMatch(body, /DB\s*\./, 'pushLogEntry 不得触碰 DB');
  assert.doesNotMatch(body, /logOp\s*\(/, 'pushLogEntry 不得反向调用 logOp');
  /* logOp 自身也不得直接落盘（根因守卫） */
  const logOpBody = extractFn(LOGS_SRC, 'logOp');
  assert.doesNotMatch(logOpBody, /save\s*\(/, 'logOp 本身不得直接落盘');
  assert.match(logOpBody, /scheduleLogFlush\s*\(/, 'logOp 必须委托 scheduleLogFlush');
});

test('Q3-3 confirmClear（.125 事务写入点）：日志随**同一次** DB.tx 落盘，logs 不经 save/set', async () => {
  const app = createApp({
    seed: {
      currentUser: { username: 'admin', name: '管理员', role: 'admin', perms: {} },
      logs: [{ time: '2026-10-01 10:00:00', action: '新增', target: 'A', user: 'admin', detail: '存量', field: '', oldv: '', newv: '' }],
      products: [{ id: 'P1' }], orders: [{ id: 'O1', items: [] }], deliveries: [], productionPlans: [],
      productionReports: [], processTemplates: [],
      renderAll: function () {}, renderContent: function () {},
    },
  });
  await app.run('confirmClear()');
  await drain();

  assert.equal(app.recorder.txCount(), 1, '必须恰 1 次事务（不得退化为分步写）');
  const tx = plain(app.recorder.lastTx());
  assert.ok(tx.keys.indexOf('logs') >= 0, '事务 ops 必须包含 logs');
  assert.equal(app.recorder.of('save').filter(function (c) { return c.key === 'logs'; }).length, 0,
    'confirmClear 路径不得出现 save(logs)');
  assert.equal(app.recorder.of('set').filter(function (c) { return c.key === 'logs'; }).length, 0,
    'confirmClear 路径不得出现 DB.set(logs)');
  const txLogs = tx.ops.filter(function (o) { return o.key === 'logs'; })[0].value;
  assert.equal(txLogs.length, 2, '事务里的 logs = 存量 + 本次「清空」条目');
  assert.equal(txLogs[0].action, '清空');
  assert.deepEqual(plain(app.getGlobal('logs')), txLogs, '事务写入值必须等于当时内存 logs');
  app.dispose();
});

test('Q3-4 静态形态：四个 .125 事务写入点均用 pushLogEntry + 单次 DB.tx，且都不调 logOp', () => {
  const names = ['bulkDelete', 'delProdPlan', 'confirmClear', 'restoreBackup'];
  names.forEach(function (name) {
    const body = extractFn(INDEX_SRC, name);
    assert.match(body, /pushLogEntry\s*\(/, name + ' 必须用 pushLogEntry 造日志条目');
    assert.doesNotMatch(body, /[^a-zA-Z]logOp\s*\(/, name + ' 不得调用 logOp（否则会与事务写抢 rev）');
    assert.match(body, /\{\s*key\s*:\s*'logs'\s*,\s*value\s*:\s*logs\s*\}/, name + ' 必须把 logs 并入同一事务');
  });
});

/* ================================================================
   §Q4 服务端「只追加」白名单 logsAppendOK（本轮最高风险项）
   ================================================================ */

function entry(tag, user) {
  return {
    time: '2026-10-06 12:00:00', action: '系统', target: 'T',
    user: user === undefined ? 'admin' : user, detail: 'd-' + tag, field: '', oldv: '', newv: '',
  };
}
function seq(n, prefix) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(entry((prefix || 'o') + i));
  return out;
}
/* 客户端合法形状：前插 K 条新条目（触发上限时旧尾滑出）= logOp 的 unshift + slice(0,500) */
function clientShape(newEntries, old) {
  return newEntries.concat(old).slice(0, LOG_MAX);
}

test('Q4-0 前置：LOG_MAX 与前端截断常数一致（500）', () => {
  assert.equal(LOG_MAX, 500);
  assert.match(LOGS_SRC, /logs\.length\s*>\s*500/, 'js/logs.js 的截断阈值须与 LOG_MAX 同为 500');
});

test('Q4-1 首次写入（old 空）放行', () => {
  assert.equal(logsAppendOK([], seq(3, 'n')), true);
  assert.equal(logsAppendOK(null, seq(3, 'n')), true, 'old 缺省视为空');
});

test('Q4-2 未触顶（old 长度 3）前插 1/2/3 条 —— 全部放行', () => {
  const old = seq(3, 'o');
  [1, 2, 3].forEach(function (k) {
    const neu = clientShape(seq(k, 'n'), old);
    assert.equal(neu.length, 3 + k, '前置：未触发截断');
    assert.equal(logsAppendOK(old, neu), true, '未触顶前插 ' + k + ' 条须放行');
  });
});

test('Q4-3 恰触顶（old 长度 500）前插 1/2/3 条 —— 全部放行（旧尾滑出）', () => {
  const old = seq(500, 'o');
  [1, 2, 3].forEach(function (k) {
    const neu = clientShape(seq(k, 'n'), old);
    assert.equal(neu.length, 500, '前置：恰触顶，长度保持 500');
    /* 前置自检：前 k 条恰为 k 条新条目（顺序不作断言，白名单只认「等价后缀」） */
    assert.deepEqual(
      neu.slice(0, k).map(function (x) { return x.detail; }).sort(),
      seq(k, 'n').map(function (x) { return x.detail; }).sort(),
      '前置：新条目必须在最前');
    assert.deepEqual(
      neu.slice(k).map(function (x) { return x.detail; }),
      old.slice(0, 500 - k).map(function (x) { return x.detail; }),
      '前置：旧尾滑出后剩余存量顺序不变');
    assert.equal(neu[neu.length - 1].detail, 'd-o' + (500 - k - 1), '前置：最旧的 ' + k + ' 条已滑出');
    assert.equal(logsAppendOK(old, neu), true, '恰触顶前插 ' + k + ' 条须放行');
  });
});

test('Q4-4 边界：old 长度 499 + 前插 2/3 条（客户端被截断到 500）—— 放行', () => {
  const old499 = seq(499, 'o');
  [2, 3].forEach(function (k) {
    const neu = clientShape(seq(k, 'n'), old499); /* 499+k > 500 → 截断 */
    assert.equal(neu.length, 500, '前置：已截断到 LOG_MAX');
    assert.equal(logsAppendOK(old499, neu), true, 'old=499 前插 ' + k + ' 条（截断）须放行');
  });
});

test('Q4-5【应拒绝】未触顶时净缩减 / 清空 —— 必须被拒', () => {
  const old = seq(5, 'o');
  assert.equal(logsAppendOK(old, []), false, '清空必须被拒（非 admin 的整表清空）');
  assert.equal(logsAppendOK(old, old.slice(0, 3)), false, '净缩减（未触顶）必须被拒');
  assert.equal(logsAppendOK(old, old.slice(1)), false, '删掉最新 1 条必须被拒');
});

test('Q4-6【应拒绝】恰触顶时「原地替换最新 1 条」/ 净缩减 —— 必须被拒（守卫未放水）', () => {
  const old = seq(500, 'o');
  /* 原地替换最新 1 条：丢 old[0]、保留 old[1..499]，长度仍 500（logOp 无此形状） */
  const replaceNewest = [entry('X')].concat(old.slice(1));
  assert.equal(replaceNewest.length, 500);
  assert.equal(logsAppendOK(old, replaceNewest), false, '触顶后原地替换最新 1 条必须被拒');

  /* 触顶后净缩减：截掉尾部（客户端不会产生，但守卫必须拦） */
  assert.equal(logsAppendOK(old, old.slice(0, 400)), false, '触顶后净缩减必须被拒');

  /* 触顶后清空 */
  assert.equal(logsAppendOK(old, []), false, '触顶后清空必须被拒');
});

test('Q4-7【应拒绝】只改中间一条 / 只改 user 字段 —— 必须被拒', () => {
  const old = seq(10, 'o');
  const tamperMid = old.slice();
  tamperMid[5] = entry('TAMPER');
  assert.equal(logsAppendOK(old, tamperMid), false, '原地篡改中间条目必须被拒');

  const tamperUser = old.map(function (e, i) { e = Object.assign({}, e); if (i === 3) e.user = 'hacker'; return e; });
  assert.equal(logsAppendOK(old, tamperUser), false, '只改 user 字段必须被拒（.125 已把 user 纳入 sameLog）');
});

test('Q4-8【应拒绝】非数组 / 超过 LOG_MAX', () => {
  assert.equal(logsAppendOK(seq(3, 'o'), 'not-an-array'), false);
  assert.equal(logsAppendOK(seq(3, 'o'), null), false);
  assert.equal(logsAppendOK(seq(3, 'o'), seq(501, 'n')), false, '超过 LOG_MAX 必须被拒');
});

/* ================================================================
   §Q5 clearLogs 交互
   ================================================================ */

test('Q5-1 admin 清空：清空写入 + 清空日志落盘，最终内容不含任何旧条目', async () => {
  const old = [entry('旧1'), entry('旧2')];
  const app = createApp({
    seed: {
      currentUser: { username: 'admin', name: '管理员', role: 'admin', perms: {} },
      logs: old,
      renderContent: function () {},
    },
  });
  app.run('clearLogs()');
  await drain();

  const mem = plain(app.getGlobal('logs'));
  assert.equal(mem.length, 1, '清空后内存仅剩「清空」这一条日志');
  assert.equal(mem[0].action, '清空');

  const writes = logsWrites(app);
  assert.ok(writes.length >= 1, '清空必须落盘');
  const last = writes[writes.length - 1].value;
  assert.equal(last.length, 1, '最后一次写入 = 仅「清空」条目');
  assert.equal(last[0].action, '清空');
  /* 关键：清空之后（含紧随的 logOp）不得把已清空的旧内容写回 */
  assert.equal(JSON.stringify(last).indexOf('d-旧1'), -1, '最后一次写入不得复活旧条目');
  assert.equal(JSON.stringify(last).indexOf('d-旧2'), -1, '最后一次写入不得复活旧条目');
  app.dispose();
});

test('Q5-2 同段「logOp + clearLogs」：合并后最后一次写入仍是清空态，旧内容不得复活', async () => {
  const app = createApp({
    seed: {
      currentUser: { username: 'admin', name: '管理员', role: 'admin', perms: {} },
      logs: [entry('旧1'), entry('旧2')],
      renderContent: function () {},
    },
  });
  app.run("logOp('新增','X','这条会被清空吞掉'); clearLogs();");
  await drain();

  const mem = plain(app.getGlobal('logs'));
  assert.equal(mem.length, 1, '清空后内存仅剩「清空」条目');
  assert.equal(mem[0].action, '清空');
  const last = logsWrites(app).slice(-1)[0].value;
  assert.equal(last.length, 1);
  assert.equal(last[0].action, '清空');
  assert.equal(JSON.stringify(last).indexOf('d-旧1'), -1, '旧内容不得复活');
  app.dispose();
});

test('Q5-3 非 admin 调 clearLogs：被拦（alert）、零写入、不消耗 confirm', async () => {
  const app = createApp({
    seed: {
      currentUser: { username: 'staff', name: '张三', role: 'staff', perms: {} },
      logs: [entry('旧1')],
      renderContent: function () {},
    },
  });
  app.run('clearLogs()');
  await drain();
  assert.equal(app.recorder.writeCount(), 0, '非 admin 清空必须零写入');
  assert.equal(plain(app.getGlobal('logs')).length, 1, '内存不得被改动');
  assert.equal(app.alerts.length, 1, '必须给出提示');
  assert.match(app.alerts[0], /仅管理员/);
  assert.equal(app.confirms.length, 0, '拦在 confirm 之前');
  app.dispose();
});

/* ================================================================
   §Q6 截断 500 与存量语义
   ================================================================ */

test('Q6-1 同段 501 次 logOp：内存恰 500、落盘恰 1 次、落盘内容同样 500 且最新在最前', async () => {
  const app = mkLogsApp();
  app.run("for(var i=0;i<501;i++)logOp('系统','X','n'+i);");
  assert.equal(plain(app.getGlobal('logs')).length, 500, '内存截断到 500');
  await drain();
  assert.equal(app.recorder.countOf('logs'), 1, '501 次调用合并为恰 1 次落盘');
  const v = logsWrites(app)[0].value;
  assert.equal(v.length, 500);
  assert.equal(v[0].detail, 'n500', '最新一条在最前');
  assert.equal(v[499].detail, 'n1', '第 500 条 = n1（n0 被截掉）');
  app.dispose();
});

test('Q6-2 存量不丢：seed 300 + 同段 300 次 logOp → 恰 500（新 300 + 旧最新 200），且被服务端白名单放行', async () => {
  const old = seq(300, 'old');
  const app = mkLogsApp({ logs: old });
  app.run("for(var i=0;i<300;i++)logOp('系统','X','new'+i);");
  await drain();

  assert.equal(app.recorder.countOf('logs'), 1, '恰 1 次落盘');
  const mem = plain(app.getGlobal('logs'));
  const v = logsWrites(app)[0].value;
  assert.equal(mem.length, 500);
  assert.deepEqual(v, mem, '落盘值必须等于当时内存 logs');
  assert.equal(v[0].detail, 'new299');
  assert.equal(v[299].detail, 'new0');
  assert.equal(v[300].detail, 'd-old0', '存量最新一条紧随新条目之后（存量未被丢）');
  assert.equal(v[499].detail, 'd-old199', '存量保留最新 200 条，最旧 100 条按截断语义滑出');

  /* 反虚设自检：宿主侧基准 `old` 必须**未被 vm 内 unshift 污染**（否则白名单断言会恒真） */
  assert.equal(old.length, 300, '基准 old 必须保持 300 条（未被 vm 内原地 unshift 污染）');
  assert.equal(old[0].detail, 'd-old0');

  /* 端到端：把（服务端旧值, 客户端新值）交给真实白名单函数 → 必须放行 */
  assert.equal(logsAppendOK(old, v), true, '合并后的真实写入形状必须被服务端放行');
  app.dispose();
});

test('Q6-3 恰触顶 + 存量：seed 500 + 同段 3 次 logOp → 500（滑出最旧 3），白名单放行', async () => {
  const old = seq(500, 'old');
  const app = mkLogsApp({ logs: old });
  app.run("logOp('系统','X','new0');logOp('系统','X','new1');logOp('系统','X','new2');");
  await drain();
  const v = logsWrites(app)[0].value;
  assert.equal(v.length, 500);
  assert.deepEqual(v.map(function (x) { return x.detail; }).slice(0, 3), ['new2', 'new1', 'new0']);
  assert.equal(v[3].detail, 'd-old0');
  assert.equal(v[499].detail, 'd-old496', '最旧 3 条（old497..old499）滑出');
  assert.equal(old.length, 500, '基准 old 必须保持 500 条（未被 vm 内原地 unshift 污染）');
  assert.equal(logsAppendOK(old, v), true, '恰触顶 + 前插 3 条必须被服务端放行');
  app.dispose();
});

test('Q6-4【潜在缺口·非回归】单段 ≥500 次 logOp 且服务端已有存量 → 白名单拒绝（该段审计条目全丢）', async () => {
  /* 这不是 .135 引入的回归（.134 的逐次落盘在紧循环里几乎全数 409），但属「合并后」的残留缺口：
     合并把 K 条新条目压成「全新数组」提交，一旦 K >= LOG_MAX 就把存量整体挤出 →
     白名单找不到任何「尾段 === 旧值前缀」的 p → 拒绝；而 logOp 是 silent 的 → 静默丢弃。 */
  const old = seq(1, 'o');            /* 服务端只要有 1 条存量即可（old 为宿主侧纯净基准） */
  const app = mkLogsApp({ logs: old });
  app.run("for(var i=0;i<500;i++)logOp('系统','X','burst'+i);");
  await drain();
  assert.equal(app.recorder.countOf('logs'), 1, '仍合并为 1 次落盘');
  const v = logsWrites(app)[0].value;
  assert.equal(v.length, 500);
  assert.equal(JSON.stringify(v).indexOf('d-o0'), -1, '前置：存量被整体挤出（客户端数组里已无旧条目）');
  assert.equal(logsAppendOK(old, v), false,
    '白名单拒绝该形状（守卫本身按设计工作）→ 若线上出现单段 ≥500 次 logOp，该段日志会静默全丢');

  /* 粘性：客户端内存已被替换成「全新 500 条」，此后每一段都继续被拒 —— 直到刷新页面重新 DB.get('logs') */
  app.run("logOp('系统','X','after-burst');");
  await drain();
  assert.equal(app.recorder.countOf('logs'), 2, '后续段落仍会独立落盘（客户端以为成功）');
  const v2 = logsWrites(app)[1].value;
  assert.equal(logsAppendOK(old, v2), false,
    '粘性失败：下一段同样被拒 —— 客户端内存里已不含服务端任何条目，刷新页面前每一次 logs 写都会静默失败');
  app.dispose();
});

test('Q6-5 上述缺口的**精确边界**：单段新条目 K=499 放行、K=500 拒绝（K = 段内 logOp 次数）', () => {
  const old = seq(1, 'o');
  [499, 500].forEach(function (K) {
    const neu = clientShape(seq(K, 'n'), old);   /* 真实客户端形状：unshift K 次 + slice(0,500) */
    const stockKept = JSON.stringify(neu).indexOf('d-o0') >= 0;
    assert.equal(neu.length, 500, '前置：K=' + K + ' 时落盘数组恒为 500');
    assert.equal(stockKept, K + 1 <= 500, '前置：K=' + K + ' 时存量是否存活应与 500 上限一致');
    const ok = logsAppendOK(old, neu);
    assert.equal(ok, K <= 499, 'K=' + K + ' 的放行结果应为 ' + (K <= 499) +
      '（K≥500 时客户端提交的是「全新 500 条」，白名单找不到任何等价后缀 → 拒绝）');
  });
});

/* ================================================================
   §Q7 水印单一来源不虚设
   ================================================================ */

test('Q7-1 harness BUILD 必须等于 index.html 的**实际**权威水印（反向守卫，不虚设）', () => {
  const m = INDEX_SRC.match(/>build (20\d\d-\d\d-\d\d\.\d+)</);
  assert.ok(m, 'index.html 必须存在权威水印 >build YYYY-MM-DD.N<');
  assert.equal(m[1], build.BUILD, 'tests/harness/build.js 的 BUILD 必须与 index.html 实际水印一致');
  assert.equal((INDEX_SRC.match(/>build 20\d\d-\d\d-\d\d\.\d+</g) || []).length, 1,
    '全文件权威水印形态只能 1 处（deploy.sh 精确计数口径）');
});

test('Q7-2 buildMarkRe / buildAnyRe 是**真实判别**函数：BUILD 命中 1、PREV 命中 0、伪版本命中 0', () => {
  assert.equal((INDEX_SRC.match(build.buildMarkRe(build.BUILD)) || []).length, 1);
  assert.equal((INDEX_SRC.match(build.buildMarkRe(build.PREV)) || []).length, 0,
    '上一版本权威形态应为 0 处');
  assert.equal((INDEX_SRC.match(build.buildAnyRe(build.PREV)) || []).length, 0,
    '上一版本任意形态应为 0 处');
  /* 反虚设：若有人把 BUILD 改成不存在的版本号，锚点断言（===1）必然失败 */
  assert.equal((INDEX_SRC.match(build.buildMarkRe('2026-10-06.999')) || []).length, 0,
    '伪版本 .999 命中 0 → 证明「===1」断言对错误 BUILD 有判别力');
  assert.notEqual((INDEX_SRC.match(build.buildMarkRe('2026-10-06.999')) || []).length, 1);
  /* 正则元字符转义守卫：版本号里的 '.' 必须被转义（否则 .999 会误匹配任意字符） */
  assert.equal(build.buildMarkRe('2026-10-06.135').source, '>build 2026\\-10\\-06\\.135<'.replace(/\\-/g, '-'));
  assert.equal((INDEX_SRC.match(build.buildMarkRe('2026-10-06X135')) || []).length, 0,
    '未转义时 "2026-10-06X135" 会命中实际水印 → 转义后必须 0');
});

test('Q7-3 deploy.sh 的提取口径与本仓水印一致（build YYYY-MM-DD.N< 恰 1 处）', () => {
  const hits = INDEX_SRC.match(/build [0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+</g) || [];
  assert.equal(hits.length, 1, 'deploy.sh 的 grep -oE 模式必须恰命中 1 处');
  assert.equal(hits[0], 'build ' + build.BUILD + '<', 'deploy.sh 提取结果必须等于 harness BUILD');
});

/* ================================================================
   §Q8 被调整的既有用例是否被削弱
   ================================================================ */

/* 复刻 tests/projection.sync.test.js 的夹具（独立重写，不引其私有函数） */
function invOrder(id, lines) {
  return { id: id, orderType: '库存订单', customer: '成品仓', contractNo: '', status: '执行中', items: lines };
}
function invLine(productId, deliveredQty, orderQty) {
  return { productId: productId, productName: productId, spec: '', model: '', orderQty: orderQty === undefined ? 100 : orderQty, deliveredQty: deliveredQty };
}

test('Q8-1 写序不变量已被放弃（可观测行为变更）：实际写序是 [orders, logs]，旧断言 [logs, orders] 今天必然失败', async () => {
  const app = createApp({
    seed: {
      currentUser: { username: 'tester', name: '测试员', role: 'admin', perms: {} },
      orders: [invOrder('O-DONE', [invLine('P1', 100, 100)])],
      products: [], transfers: [], productionPlans: [], productionReports: [], logs: [],
      renderContent: function () {}, renderAll: function () {},
    },
  });
  const n = await app.run('syncOrderAutoStatus()');
  assert.equal(n, 1, '前置：恰 1 单状态变更');

  const keys = plain(app.recorder.of('save').map(function (c) { return c.key; }));
  assert.deepEqual(keys, ['orders', 'logs'],
    '实际写序 = orders（同步）→ logs（微任务）—— 旧字面量 [logs, orders] 在此必然失败');
  assert.notDeepEqual(keys, ['logs', 'orders'], '旧断言已不再成立（这是可观测的行为变更）');
  assert.equal(app.recorder.countOf('logs'), 1, 'logs 恰 1 次');
  assert.equal(app.recorder.countOf('orders'), 1, 'orders 恰 1 次');
  app.dispose();
});

test('Q8-2【对拍·变异 NO_FLUSH】logOp 不落盘 → B5/C1/写序类断言全部必然失败（判别力未下降）', async () => {
  /* 模拟「把 js/logs.js 的 scheduleLogFlush 调用删掉」：日志彻底不落盘 */
  const app = mkMutantApp('NO_FLUSH', {
    deliveries: [{ id: 'K1', createdAt: '2026-08-23' }, { id: 'K2', createdAt: '2026-08-23' }],
    fields: { delivery: [{ key: 'orderId', label: '订单编号', type: 'text', required: true, locked: true }] },
  });
  app.run('migrateDeliveryPlanNo()');
  await drain();
  assert.equal(app.recorder.countOf('deliveries'), 1, '业务表仍落盘 1 次');
  assert.equal(app.recorder.countOf('logs'), 0,
    'NO_FLUSH 下 logs 一次都不落 → 既有 B5/C1 的「countOf(logs)===1」必然失败 ⇒ 判别力未下降');
  assert.notEqual(app.recorder.countOf('logs'), 1);

  /* 写序断言同样失效：logs 不再出现 */
  const app2 = mkMutantApp('NO_FLUSH', {
    currentUser: { username: 'tester', name: '测试员', role: 'admin', perms: {} },
    orders: [invOrder('O-DONE', [invLine('P1', 100, 100)])],
    renderContent: function () {}, renderAll: function () {},
  });
  await app2.run('syncOrderAutoStatus()');
  const keys = plain(app2.recorder.of('save').map(function (c) { return c.key; }));
  assert.deepEqual(keys, ['orders'], 'NO_FLUSH 下写序只剩 orders → 既有「各恰一次」断言必然失败');
  app.dispose();
  app2.dispose();
});

test('Q8-3【对拍·变异 OLD_IMPL】跨段两次 logOp 均落盘（合并能力丧失）—— 证明 Q1 组断言不是恒真', async () => {
  const app = mkMutantApp('OLD_IMPL');
  app.run("logOp('系统','A','第一条'); logOp('系统','B','第二条');");
  await drain();
  assert.equal(app.recorder.countOf('logs'), 2, 'OLD_IMPL 下同段 2 次 = 2 次落盘（无合并）');
  assert.notEqual(app.recorder.countOf('logs'), 1, '本变异下「恰 1 次」断言必然失败');
  app.dispose();
});

test('Q8-4 既有 .125 事务语义未被合并机制污染：confirmClear / delProdPlan 路径 txCount 仍为 1', async () => {
  const app = createApp({
    seed: {
      currentUser: { username: 'admin', name: '管理员', role: 'admin', perms: {} },
      productionPlans: [{ id: 'PP1', status: '待排产', orderId: 'O1', items: [{ productId: 'P1', planQty: 5, reports: [] }] }],
      orders: [{ id: 'O1', orderType: '库存订单', items: [{ productId: 'P1', orderQty: 5, deliveredQty: 0 }] }],
      products: [{ id: 'P1', stock: 0 }],
      logs: [], transfers: [], productionReports: [],
      renderContent: function () {}, renderAll: function () {},
    },
  });
  await app.run('delProdPlan(0)');
  await drain();
  assert.equal(app.recorder.txCount(), 1, 'delProdPlan 必须恰 1 次事务');
  assert.equal(app.recorder.of('save').length, 0, 'delProdPlan 路径不得出现独立 save（含 logs）');
  assert.equal(app.recorder.of('set').length, 0, 'delProdPlan 路径不得出现独立 DB.set');
  const tx = plain(app.recorder.lastTx());
  assert.ok(tx.keys.indexOf('logs') >= 0, 'delProdPlan 事务须包含 logs');
  app.dispose();
});
