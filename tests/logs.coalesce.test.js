'use strict';
/* ================================================================
   tests/logs.coalesce.test.js —— logOp「同段合并」落盘（build 2026-10-06.135）
   ================================================================
   背景（线上实测事故）：`js/logs.js` 的 `logOp` 原实现每次都 `save('logs',logs,true)`
   —— 对共享 `logs` 表**整表覆盖写**。同一次同步执行内两次调用 → 第二条携带**过期 rev**
   → 服务端乐观锁 409 冲突拦截 → 因 `silent=true` 被**静默吞掉** → 审计记录永久丢失。
   实证：
     · 2026-10-06 12:53:47 `[冲突拦截] key=logs user=admin expectedRev=0 curRev=1`
       —— 被吞掉的正是「存量交付计划回填交付计划编号 62 条」那条（**业务数据无损、仅日志缺条**），
       触发者＝`migrateDeliveryPlanNoField()` 与 `migrateDeliveryPlanNo()` 在同一次 initApp 内各 logOp 一次；
     · journal 保留期内 `logs` 表冲突累计 **195 次**（`orders` 1 / `productionPlans` 8，后两者非静默有提示）。

   修法：落盘推迟到一个**微任务**（`scheduleLogFlush`），期间到达的 logOp 只入内存（`pushLogEntry`），
        到点用**当时最新**的 logs 与 rev 落盘**一次**；`logFlushPending` 作同段去重标志。

   本文件钉死的口径：
     · 合并：同段 N 次 logOp → `logs` 落盘**恰 1 次**，且一次写入即含全部 N 条（内容不丢）；
     · 复位：跨段（await 之后）再次 logOp 会**再落盘一次** —— `logFlushPending` 必须是「同段」去重，
       绝不能被写成永久抑制（§L3 专钉该退化）；
     · 不动：`logOp` 签名、条目结构、`logUserName`、截断 500、`silent=true`、以及
       `pushLogEntry` 不触发落盘（`.125` 四个事务写入点靠它，§L8 专钉）；
     · 单点：js/logs.js 内 `save('logs'` 只允许出现在 `scheduleLogFlush` 内部（§L6 静态守卫）。
   ================================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createApp, ROOT } = require('./harness/sandbox');

const LOGS_SRC = fs.readFileSync(path.join(ROOT, 'js', 'logs.js'), 'utf8');
const LOGS_CODE = stripComments(LOGS_SRC);

/** 排空微任务：logOp 落盘推迟到一个微任务，异步断言前必须先排空。
    用 setImmediate（宏任务）而非 `await Promise.resolve()`，确保所有已排队微任务（含连锁）跑完。 */
function drain() { return new Promise(function (r) { setImmediate(r); }); }
/** 跨 context 结构比对：vm 里的对象/数组须转成宿主 realm 的纯值 */
function plain(v) { return JSON.parse(JSON.stringify(v)); }
/** 某表被写入的值序列（按发生顺序） */
function logsWrites(app) {
  return plain(app.recorder.of('save').filter(function (c) { return c.key === 'logs'; }).map(function (c) {
    return { value: c.value, silent: c.silent };
  }));
}
function mkApp(seed) { return createApp({ seed: seed || {} }); }

/* 本文件自带的源码分析小工具（与 delivery.planno.test.js / invcall-cap.test.js 同款；
   四个既有测试文件各自持有同名副本，属既有约定，未在本轮统一） */
function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}
/** 花括号配平抽取源码函数体 */
function extractFn(src, name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\(', 'g');
  const m = re.exec(src);
  if (!m) throw new Error('未在源码中找到函数: ' + name);
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
   §L1-L2 合并语义：同段多次 logOp → 恰 1 次落盘、内容不丢
   ================================================================ */

test('L1 同段两次 logOp：条目全入内存，logs 落盘恰 1 次（合并生效）', async () => {
  const app = mkApp({ logs: [] });
  app.run("logOp('系统','A','第一条'); logOp('系统','B','第二条');");
  assert.equal(plain(app.getGlobal('logs')).length, 2, '两条都须入内存');
  assert.equal(app.recorder.countOf('logs'), 0, '同步段内尚未落盘（已推迟到微任务）');
  await drain();
  assert.equal(app.recorder.countOf('logs'), 1, '同段 N 次调用必须合并为恰 1 次落盘');
  app.dispose();
});

test('L2 合并落盘用的是「当时最新」logs：一次写入即含全部新条目（新→旧）+ silent 仍为 true', async () => {
  const app = mkApp({ logs: [] });
  /* recorder 的 save 包装签名是 (k,v)、**不透传第 3 参**，故 silent 只能用自建 spy 观察：
     `save` 在 index.html 是顶层 function 声明 → vm 全局对象属性，可直接覆盖（recorder 同款手法）。 */
  const calls = [];
  app.sandbox.save = function (k, v, silent) {
    calls.push({ k: k, v: JSON.parse(JSON.stringify(v)), silent: silent });
  };
  app.run("logOp('系统','A','第一条'); logOp('系统','B','第二条');");
  assert.equal(calls.length, 0, '同步段内尚未落盘（已推迟到微任务）');
  await drain();
  assert.equal(calls.length, 1, '同段 N 次调用必须合并为恰 1 次落盘');
  assert.equal(calls[0].k, 'logs');
  assert.equal(calls[0].silent, true, 'silent 语义不变（best-effort，不得因 409 打扰用户）');
  assert.deepEqual(calls[0].v.map(function (x) { return x.detail; }), ['第二条', '第一条'],
    '一次写入即含两条（数组顺序新→旧）—— 证明落盘取的是「当时最新」的 logs');
  app.dispose();
});

/* ================================================================
   §L3 去重标志必须是「同段」而非「永久」——防退化为只记首条
   ================================================================ */

test('L3 跨段（await 后）再次 logOp：会再落盘一次（logFlushPending 已复位，非永久抑制）', async () => {
  const app = mkApp({ logs: [] });
  app.run("logOp('系统','A','第一条');");
  await drain();
  assert.equal(app.recorder.countOf('logs'), 1, '第一段落盘 1 次');

  app.run("logOp('系统','B','第二条');");
  await drain();
  assert.equal(app.recorder.countOf('logs'), 2, '第二个同步段应独立落盘（若为 1 则说明标志未复位 → 日志会永久丢失）');
  const last = logsWrites(app)[1].value;
  assert.deepEqual(last.map(function (x) { return x.detail; }), ['第二条', '第一条'], '第二段落盘含新条目 + 存量');
  app.dispose();
});

/* ================================================================
   §L4 单次调用不回归
   ================================================================ */

test('L4 单次 logOp：仍恰 1 次落盘、条目结构与既有口径一致（不回归）', async () => {
  const app = mkApp({ logs: [] });
  app.run("logOp('新增','交付计划','新增「D1」');");
  await drain();
  assert.equal(app.recorder.countOf('logs'), 1, '恰 1 次');
  const logs = plain(app.getGlobal('logs'));
  assert.equal(logs.length, 1);
  assert.equal(logs[0].action, '新增');
  assert.equal(logs[0].target, '交付计划');
  assert.equal(logs[0].detail, '新增「D1」');
  assert.match(String(logs[0].time), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, '固定时间格式不变');
  assert.equal(typeof logs[0].field, 'string');
  assert.equal(typeof logs[0].oldv, 'string');
  assert.equal(typeof logs[0].newv, 'string');
  app.dispose();
});

/* ================================================================
   §L5 事故复现钉：.134 线上丢条场景（两个迁移同段各 logOp 一次）
   ================================================================ */

test('L5 事故复现钉：连续两次迁移（各 logOp 一次）→ logs 恰 1 次落盘且两条都在', async () => {
  const app = createApp({
    seed: {
      logs: [],
      deliveries: [{ id: 'K1', createdAt: '2026-08-23' }, { id: 'K2', createdAt: '2026-08-23' }],
      fields: { delivery: [{ key: 'orderId', label: '订单编号', type: 'text', required: true, locked: true }] },
    },
  });
  app.run('migrateDeliveryPlanNoField(); migrateDeliveryPlanNo();');
  await drain();
  assert.equal(app.recorder.countOf('logs'), 1,
    '两次 logOp 必须合并为 1 次落盘 —— 若为 2 次，第二条会在线上被乐观锁 409 静默吞掉（即 .134 事故）');
  const details = plain(app.getGlobal('logs')).map(function (x) { return String(x.detail); });
  assert.equal(details.some(function (d) { return d.indexOf('字段配置补齐') >= 0; }), true, '字段配置迁移日志在');
  assert.equal(details.some(function (d) { return d.indexOf('存量交付计划回填交付计划编号 2 条') >= 0; }), true,
    '回填迁移日志也在（.134 线上丢掉的正是这条）');
  app.dispose();
});

/* ================================================================
   §L6-L7 源码形态守卫：单点落盘 + 微任务 + 去重标志
   ================================================================ */

test("L6 静态守卫：logOp 不得自行落盘；logs 落盘点仅 scheduleLogFlush（clearLogs 为清空语义、单列）", () => {
  /* logOp 本身绝不允许直接落盘 —— 这是「同段两次调用必丢一条」的根因所在 */
  const logOpBody = extractFn(LOGS_CODE, 'logOp');
  assert.doesNotMatch(logOpBody, /save\s*\(/, 'logOp 本身不得直接落盘（必须经 scheduleLogFlush）');
  assert.match(logOpBody, /scheduleLogFlush\s*\(/, 'logOp 必须委托 scheduleLogFlush');

  /* 合并落盘点恰 1 处，且在 scheduleLogFlush 内 */
  const flushBody = extractFn(LOGS_CODE, 'scheduleLogFlush');
  assert.equal((flushBody.match(/save\(\s*'logs'/g) || []).length, 1, "scheduleLogFlush 内须有且仅有 1 处 save('logs'");

  /* 全文件 logs 落盘点恰 2 处：scheduleLogFlush（合并追加）+ clearLogs（整表清空，
     语义上必须一次性覆盖写、且**非 silent**——清空失败要给用户提示，不属合并范围） */
  const all = LOGS_CODE.match(/save\(\s*'logs'/g) || [];
  assert.equal(all.length, 2, 'logs 落盘点全文件恰 2 处（合并追加 + 清空）');
  const clearBody = extractFn(LOGS_CODE, 'clearLogs');
  assert.equal((clearBody.match(/save\(\s*'logs'/g) || []).length, 1, 'clearLogs 的落盘点须在 clearLogs 内');
});

test('L7 源码形态：scheduleLogFlush 用 Promise.resolve().then 落盘（微任务），且 logFlushPending 复位', () => {
  const body = extractFn(LOGS_CODE, 'scheduleLogFlush');
  assert.match(body, /Promise\.resolve\(\)\.then/, '必须推迟到微任务（同段合并的前提）');
  assert.match(body, /logFlushPending/, '必须有同段去重标志（否则等于没合并）');
  /* 复位必须发生在微任务体内（若只在函数开头复位，标志会永久为 true → 此后永不落盘） */
  const thenIdx = body.indexOf('Promise.resolve().then');
  const resetIdx = body.indexOf('logFlushPending=false', thenIdx);
  assert.notEqual(resetIdx, -1, '微任务体内必须把 logFlushPending 复位为 false');
  /* 源码形态守卫：silent=true 必须随合并一并保留（行为侧由 §L2 的 spy 覆盖） */
  assert.match(body, /save\(\s*'logs'\s*,\s*logs\s*,\s*true\s*\)/, '合并落盘必须保持 silent=true（3 参形态）');
});

/* ================================================================
   §L8 pushLogEntry 不触发落盘 —— .125 四个事务写入点路径零新增写
   ================================================================ */

test('L8 pushLogEntry 不触发落盘：事务写入点（bulkDelete/confirmClear 等）路径零新增写', async () => {
  const app = mkApp({ logs: [] });
  app.run("pushLogEntry(makeLogEntry('删除','X','p1')); pushLogEntry(makeLogEntry('删除','X','p2'));");
  await drain();
  assert.equal(app.recorder.countOf('logs'), 0, 'pushLogEntry 只入内存、不经 scheduleLogFlush（事务路径自行并入 DB.tx）');
  assert.equal(plain(app.getGlobal('logs')).length, 2, '两条仍须入内存，供调用方并入事务');
  app.dispose();
});

/* ================================================================
   §L9-L10 截断与存量语义不变
   ================================================================ */

test('L9 截断 500 语义不变：同段 501 次 logOp → 内存恰 500 条、落盘恰 1 次、最新在最前', async () => {
  const app = mkApp({ logs: [] });
  app.run("for(var i=0;i<501;i++)logOp('系统','X','n'+i);");
  assert.equal(plain(app.getGlobal('logs')).length, 500, '截断 500 语义不变');
  await drain();
  assert.equal(app.recorder.countOf('logs'), 1, '501 次调用合并为恰 1 次落盘');
  const val = logsWrites(app)[0].value;
  assert.equal(val.length, 500, '落盘内容同样截断到 500');
  assert.equal(val[0].detail, 'n500', '最新一条在最前');
  app.dispose();
});

test('L10 存量 logs 不被丢弃：合并落盘 = 新条目 + 原有存量（保持追加语义）', async () => {
  const old = [
    { time: '2026-10-01 10:00:00', action: '新增', target: 'A', user: 'admin', detail: '旧1', field: '', oldv: '', newv: '' },
    { time: '2026-10-01 09:00:00', action: '新增', target: 'A', user: 'admin', detail: '旧2', field: '', oldv: '', newv: '' },
  ];
  const app = mkApp({ logs: old });
  app.run("logOp('系统','A','新1'); logOp('系统','B','新2');");
  await drain();
  const val = logsWrites(app)[0].value;
  assert.equal(val.length, 4, '新 2 + 旧 2（存量一条都不能少）');
  assert.deepEqual(val.map(function (x) { return x.detail; }), ['新2', '新1', '旧1', '旧2'], '新条目前插、存量后移');
  app.dispose();
});
