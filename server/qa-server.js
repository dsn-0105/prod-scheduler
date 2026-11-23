#!/usr/bin/env node
/* ============================================================
   质量系统 · HTTP 入口  server/qa-server.js
   ------------------------------------------------------------
   【build .163】只做 HTTP 接线：路由分发 / readBody / send / 写串行化队列 /
   启动校验 / --init CLI。业务与鉴权逻辑全在 qa-store.js · qa-auth.js · qa-core.js。

   三层可测结构（设计 §1.2.6e，照抄生产 server.js 事后才补上的最终形态）：
     qa-store.js  纯数据层（fs / now / rand 注入，不 require http）
     qa-auth.js   纯鉴权层（httpGet 注入）
     qa-server.js 接线层（本文件）
   `if (require.main === module)` 守卫：被 require 时**不启服、不占端口、不 exit**，
   这样单测可以直接 `createServer()` 自建 server 打端到端。

   ★ 并发写入的原子性（设计 §1.2.3f）：
     readBody 是异步的，两个 POST 的「读-改-写」会交错 ⇒ 撞号 + 丢更新。
     解法三层：① 内存单一副本 QA_DATA；② enqueueWrite 串行化队列；③ 编号终检在队列内。
     队列内的 fn 必须**全程同步**（同步读 QA_DATA → 同步算 → 同步落盘），
     因为 Node 单线程只保证「单次同步执行不被打断」。只读 GET 不进队列。

   ★ 权限单一实现：canWrite(user)。前端只读 /api/qa/me 返回的布尔，不自己判。
   ★ 写操作强制穿透缓存：invalidate(token) + verify(token)，让收权立即生效。
   ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const qaStore = require('./qa-store.js');
const qaAuth = require('./qa-auth.js');
const core = require('../quality/qa-core.js');

/* ---------- 常量 ---------- */

/** URL 资源名 → 数据键名的**唯一**映射点（URL 用 exceptions，数据文件用 qaLogs） */
const TABLE_KEY = qaStore.TABLE_KEY;

const MAX_BODY_BYTES = 64 * 1024;          /* 设计 §1.2.3d：body > 64KB ⇒ 413 */
const RETRY_AFTER_SEC = '3';               /* 503 时告知前端 3 秒后自动重试一次 */

/** 403 文案与前端 alert 文案逐字一致（PRD 7.3） */
const WRITE_FORBIDDEN_TEXT = '无「质量管理」编辑权限，请联系管理员在「员工管理 → 表单写权限」中授权';

/* 数值型 env 归一：非法回落默认值（运维手滑写错不该让服务起不来） */
function envInt(v, def, min) {
  const n = Number(v);
  if (!isFinite(n)) return def;
  return n < min ? min : Math.floor(n);
}

const PORT = envInt(process.env.QA_PORT || process.env.PORT, 3001, 0);
/* 数据文件路径走环境变量，与生产 server.js 的 PROD_DATA_FILE 同风格：
   测试/演练可在拷贝目录内跑，绝不读写线上文件（设计 §1.2.4e / §9.1） */
let DATA_FILE = process.env.QA_DATA_FILE || path.join(__dirname, 'data-qa.json');
const ME_URL = process.env.QA_PROD_ME_URL || 'http://127.0.0.1:3000/api/me';
const AUTH_TTL_MS = envInt(process.env.QA_AUTH_TTL_MS, 60000, 0);
const AUTH_TIMEOUT_MS = envInt(process.env.QA_AUTH_TIMEOUT_MS, 1500, 1);
const AUTH_CONNECT_TIMEOUT_MS = envInt(process.env.QA_AUTH_CONNECT_TIMEOUT_MS, 800, 1);
const AUTH_MAX_ENTRIES = envInt(process.env.QA_AUTH_MAX_ENTRIES, 500, 1);

const STARTED_AT = Date.now();
const SERVER_VERSION = qaStore.DATA_VERSION;

/* ---------- 模块级状态 ---------- */

/** 内存单一副本：启动加载一次，之后所有读写都对这个对象，绝不在请求处理中重新读文件 */
let QA_DATA = null;
let LOAD_ERROR = null;

/** 鉴权器单例（httpGet 用缺省实现；测试通过 QA_PROD_ME_URL 打桩到本地假 /api/me） */
const verifier = qaAuth.createVerifier({
  meUrl: ME_URL,
  ttlMs: AUTH_TTL_MS,
  timeoutMs: AUTH_TIMEOUT_MS,
  connectTimeoutMs: AUTH_CONNECT_TIMEOUT_MS,
  maxEntries: AUTH_MAX_ENTRIES
});

/* ---------- 写入串行化队列 ---------- */

let writeChain = Promise.resolve();

/**
 * 把「读-改-写」整体投递到单写者队列上串行执行。
 * 前一个任务失败也要继续（then 的 both handlers），并吞掉 rejection 防未捕获告警。
 * @param {function(): object} fn 必须**全程同步**的任务体，返回值透传给调用方
 * @returns {Promise<object>}
 */
function enqueueWrite(fn) {
  const p = writeChain.then(fn, fn);
  writeChain = p.then(function () { /* 吞掉成功值 */ }, function () { /* 吞掉失败，防未捕获 */ });
  return p;
}

/* ---------- HTTP 小工具 ---------- */

/**
 * 发送 JSON 响应。
 * @param {http.ServerResponse} res
 * @param {number} code 状态码
 * @param {object} obj 响应体（成功 {ok:true,…} / 失败 {error:'中文消息'}）
 * @param {object=} extraHeaders 额外响应头（如 503 的 Retry-After）
 * @returns {undefined}
 */
function sendJson(res, code, obj, extraHeaders) {
  if (!res || res.writableEnded || res.headersSent) return;
  const headers = Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  }, extraHeaders || {});
  res.writeHead(code, headers);
  res.end(JSON.stringify(obj));
}

/**
 * 读取请求体（限 64KB）。
 * 回调形状：`{json, parseError, tooLarge, error, raw}` —— 四选一必有一个为真语义，
 * 由调用方映射到 413 / 400 / 500。**不在回调里直接 res.end**，保证错误码集中在一处。
 * @param {http.IncomingMessage} req
 * @param {function(object): void} cb
 * @returns {undefined}
 */
function readBody(req, cb) {
  let buf = '';
  let size = 0;
  let settled = false;

  function finish(payload) {
    if (settled) return;
    settled = true;
    cb(payload);
  }

  req.on('data', function (chunk) {
    if (settled) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      /* 立刻回 413，并把剩余流量排空，避免 keep-alive 连接被挂死 */
      if (typeof req.resume === 'function') req.resume();
      finish({ tooLarge: true, json: null, parseError: null, error: null, raw: '' });
      return;
    }
    buf += chunk;
  });
  req.on('end', function () {
    if (settled) return;
    let json = null;
    let perr = null;
    try {
      json = JSON.parse(buf);
    } catch (e) {
      perr = e;
    }
    finish({ tooLarge: false, json: json, parseError: perr, error: null, raw: buf });
  });
  req.on('error', function (e) {
    finish({ tooLarge: false, json: null, parseError: null, error: e, raw: '' });
  });
}

/** 从请求头取 Bearer token（token 绝不走 URL query —— 安全基线 P0③） */
function extractToken(req) {
  const raw = String((req && req.headers && req.headers['authorization']) || '').trim();
  const m = /^Bearer\s+(.+)$/i.exec(raw);
  return m ? m[1].trim() : '';
}

/**
 * 鉴权闸门。
 * 写请求（非 GET/HEAD）先 invalidate 再 verify ⇒ **强制穿透缓存**，收权立即生效。
 * /api/me 不可达 ⇒ 503 + Retry-After: 3（fail-closed，任何情况下不得 fail-open）。
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {function(object, string): void} onOk 鉴权通过回调（user, token）
 * @returns {Promise<void>}
 */
function authenticate(req, res, onOk) {
  const token = extractToken(req);
  const method = String((req && req.method) || 'GET').toUpperCase();
  const isWrite = method !== 'GET' && method !== 'HEAD';

  const task = isWrite
    ? Promise.resolve().then(function () {
      verifier.invalidate(token);           /* 写操作：先失效缓存，再真实校验 */
      return verifier.verify(token);
    })
    : verifier.verify(token);

  /* 分两段 then：第一段只兜「校验过程本身炸了」（→ 503 fail-closed），
     第二段才进业务回调，这样业务异常不会被误报成「鉴权服务不可用」。 */
  return task
    .then(function (r) { return r; }, function () { return { status: '503' }; })
    .then(function (r) {
      if (!r || r.status === '503') {
        return sendJson(res, 503, { error: '鉴权服务暂不可用，请稍后重试' }, { 'Retry-After': RETRY_AFTER_SEC });
      }
      if (r.status !== 'ok' || !r.user) {
        return sendJson(res, 401, { error: '未登录或登录已过期' });
      }
      return onOk(r.user, token);
    })
    .catch(function (e) {
      /* 兜底：响应已发出时 sendJson 自身会忽略；未发出则给 500，绝不让 rejection 逃逸到进程级 */
      sendJson(res, 500, { error: '服务内部错误：' + (e && e.message ? e.message : '未知错误') });
    });
}

/* ---------- 权限（单一实现） ---------- */

/**
 * 是否可写质量台账。**全工程唯一实现** —— 前端只读 /api/qa/me 返回的布尔。
 * 口径（PRD 7.2）：管理员恒可写；员工需 perms.qa === true。
 * @param {object} user 已鉴权用户（来自 /api/me，含 perms）
 * @returns {boolean}
 */
function canWrite(user) {
  if (!user || typeof user !== 'object') return false;
  if (user.role === 'admin') return true;
  const p = user.perms;
  return !!p && typeof p === 'object' && p.qa === true;
}

/**
 * 本轮恒 false（占位）：P1 接 perms.acts['qa.del'] 后改为真实判定。
 * @param {object} user
 * @returns {boolean}
 */
function canDel(user) {
  return false;
}

/** 对外暴露的用户白名单字段（不泄露 token / hash / 内部标记） */
function publicQaUser(user) {
  const u = user || {};
  return {
    username: typeof u.username === 'string' ? u.username : '',
    name: typeof u.name === 'string' ? u.name : '',
    role: typeof u.role === 'string' ? u.role : 'staff',
    perms: (u.perms && typeof u.perms === 'object') ? u.perms : {}
  };
}

/* ---------- 数据访问小工具 ---------- */

/** 当前 rev（缺省 0） */
function revOf(doc) {
  return doc && doc.revs ? qaStore.readRev(doc.revs) : 0;
}

/** 当前记录数组（数据未加载时为空数组） */
function recordsOf(doc) {
  return (doc && Array.isArray(doc[TABLE_KEY])) ? doc[TABLE_KEY] : [];
}

/** 数据未加载时的错误文案（把启动失败的原因透出来，避免运维只看 500） */
function notLoadedText() {
  if (LOAD_ERROR && LOAD_ERROR.message) return '数据未加载：' + LOAD_ERROR.message;
  return '数据未加载：请先执行 node qa-server.js --init 或修复数据文件后重启';
}

/** 探活响应体（设计 §3.5：**不泄露业务数据**，只给计数与鉴权缓存指标） */
function healthBody() {
  const st = verifier.stats();
  return {
    ok: true,
    version: QA_DATA ? QA_DATA.version : SERVER_VERSION,
    uptimeMs: Date.now() - STARTED_AT,
    records: recordsOf(QA_DATA).length,
    rev: revOf(QA_DATA),
    auth: { size: st.size, hits: st.hits, misses: st.misses }
  };
}

/** 随机段实现（id 的后 6 位 hex），注入给 qa-store.makeId */
function randHex(len) {
  const n = Math.max(1, Math.ceil(Number(len) / 2));
  return crypto.randomBytes(n).toString('hex').slice(0, Number(len) || 6);
}

/* ---------- 路由 ---------- */

/**
 * 单个请求的完整分发。
 * 路由表（设计 §3.5）：
 *   GET    /api/qa/health           无鉴权
 *   GET    /api/qa/me               token
 *   GET    /api/qa/exceptions       token
 *   GET    /api/qa/next-no          token + canWrite
 *   POST   /api/qa/exceptions       token + canWrite
 *   PUT    /api/qa/exceptions/:id   token + canWrite
 *   DELETE /api/qa/exceptions/:id   405（本轮未开放）
 *   *      其他                     404 {error:'not found'}
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @returns {void}
 */
function handleRequest(req, res) {
  let pathname = '';
  try {
    pathname = new URL(String((req && req.url) || '/'), 'http://qa.local').pathname;
  } catch (e) {
    return sendJson(res, 400, { error: '非法请求路径' });
  }
  const method = String((req && req.method) || 'GET').toUpperCase();

  /* ① 探活：免鉴权（deploy-qa.sh 与运维排障依赖它） */
  if (pathname === '/api/qa/health' && method === 'GET') {
    return sendJson(res, 200, healthBody());
  }

  /* ② 当前用户 + 派生权限（前端唯一权限来源） */
  if (pathname === '/api/qa/me' && method === 'GET') {
    return authenticate(req, res, function (user) {
      sendJson(res, 200, {
        ok: true,
        user: publicQaUser(user),
        canWrite: canWrite(user),
        canDel: canDel(user)
      });
    });
  }

  /* ③ 全量列表（服务端不分页：1~3 人、一年数百条，分页只引入边界 bug） */
  if (pathname === '/api/qa/exceptions' && method === 'GET') {
    return authenticate(req, res, function () {
      if (!QA_DATA) return sendJson(res, 500, { error: notLoadedText() });
      const records = recordsOf(QA_DATA);
      sendJson(res, 200, {
        ok: true,
        records: records,
        total: records.length,
        rev: revOf(QA_DATA),
        version: QA_DATA.version
      });
    });
  }

  /* ④ 预生成编号（弹窗打开时调；只是「给用户看的预生成值」，权威值在 POST 队列内重算） */
  if (pathname === '/api/qa/next-no' && method === 'GET') {
    return authenticate(req, res, function (user) {
      if (!canWrite(user)) return sendJson(res, 403, { error: WRITE_FORBIDDEN_TEXT });
      if (!QA_DATA) return sendJson(res, 500, { error: notLoadedText() });
      sendJson(res, 200, { ok: true, no: core.nextQaNo(recordsOf(QA_DATA), new Date()) });
    });
  }

  /* ⑤ 新增（写操作：进串行化队列） */
  if (pathname === '/api/qa/exceptions' && method === 'POST') {
    return authenticate(req, res, function (user) {
      if (!canWrite(user)) return sendJson(res, 403, { error: WRITE_FORBIDDEN_TEXT });
      return readBody(req, function (rb) {
        if (rb.tooLarge) return sendJson(res, 413, { error: '请求体过大' });
        if (rb.error) return sendJson(res, 400, { error: '请求体读取失败' });
        if (rb.parseError) return sendJson(res, 400, { error: '请求体不是合法 JSON' });
        if (!rb.json || typeof rb.json !== 'object' || Array.isArray(rb.json)) {
          return sendJson(res, 400, { error: '请求体必须为 JSON 对象' });
        }
        return commitWrite(res, function () {
          const out = qaStore.applyCreate(QA_DATA, rb.json, user, Date.now(), randHex);
          if (out.code !== 201) return out;                 /* 400/409 直接透传 */
          return persist(out, 201);
        });
      });
    });
  }

  /* ⑥ 编辑单条（写操作：进串行化队列） */
  const putMatch = /^\/api\/qa\/exceptions\/([^/]+)$/.exec(pathname);
  if (putMatch && method === 'PUT') {
    let id = putMatch[1];
    try { id = decodeURIComponent(id); } catch (e) { id = putMatch[1]; }
    return authenticate(req, res, function (user) {
      if (!canWrite(user)) return sendJson(res, 403, { error: WRITE_FORBIDDEN_TEXT });
      return readBody(req, function (rb) {
        if (rb.tooLarge) return sendJson(res, 413, { error: '请求体过大' });
        if (rb.error) return sendJson(res, 400, { error: '请求体读取失败' });
        if (rb.parseError) return sendJson(res, 400, { error: '请求体不是合法 JSON' });
        if (!rb.json || typeof rb.json !== 'object' || Array.isArray(rb.json)) {
          return sendJson(res, 400, { error: '请求体必须为 JSON 对象' });
        }
        return commitWrite(res, function () {
          const out = qaStore.applyUpdate(QA_DATA, id, rb.json, user, Date.now());
          if (out.code !== 200) return out;                 /* 400/404 直接透传 */
          return persist(out, 200);
        });
      });
    });
  }

  /* ⑦ 删除：本轮不实现。P1 上线时把 405 换成 200 即可，路由结构零改动 */
  if (putMatch && method === 'DELETE') {
    return sendJson(res, 405, { error: '本轮未开放删除功能' });
  }

  /* ⑧ 兜底 */
  sendJson(res, 404, { error: 'not found' });
}

/**
 * 在写队列内执行任务并把结果发回前端。
 * 任务体抛出异常时统一 500，绝不让异常冒到 process 级（否则单次请求能打挂进程）。
 * @param {http.ServerResponse} res
 * @param {function(): {code: number, body: object}} task 全程同步
 * @returns {Promise<void>}
 */
function commitWrite(res, task) {
  return enqueueWrite(function () {
    if (!QA_DATA) return { code: 500, body: { error: notLoadedText() } };
    return task();
  }).then(function (out) {
    sendJson(res, out.code, out.body);
  }, function (e) {
    sendJson(res, 500, { error: '保存失败：' + (e && e.message ? e.message : '未知错误') });
  });
}

/**
 * 提交内存副本并落盘：**先写盘成功，再提交内存**。
 * 顺序反过来就会出现「内存已改、磁盘没改」的撕裂；这样写则写盘失败时内存原样保留，
 * 天然实现设计 §1.2.3f 要求的「回滚内存快照」。
 * @param {{code: number, body: object, doc: object}} out qa-store 的不可变结果
 * @param {number} okCode 成功码（201 / 200）
 * @returns {{code: number, body: object}}
 */
function persist(out, okCode) {
  try {
    qaStore.writeAtomic(DATA_FILE, out.doc, fs);
  } catch (e) {
    return { code: 500, body: { error: '保存失败：' + (e && e.message ? e.message : '未知错误') } };
  }
  QA_DATA = out.doc;                 /* 只有落盘成功才提交，失败即回滚 */
  return { code: okCode, body: out.body };
}

/* ---------- 启动 / 拒绝启动 ---------- */

/** 把 qa-store 的 kind 翻译成「拒绝启动」的完整人话提示（设计 §1.2.4e 原文口径） */
function startupFailText(e) {
  const msg = e && e.message ? e.message : '未知错误';
  const kind = e && e.kind ? e.kind : 'STRUCT';
  if (kind === 'LOAD') {
    return '❌ ' + msg + '。首次部署请执行 node qa-server.js --init；若为误删，请从 /opt/qa-server/backups/ 取最近一份恢复。'
      + '**已拒绝启动，未创建任何文件。**';
  }
  if (kind === 'PARSE') {
    return '❌ ' + msg + '。**原文件已保留未做任何改动**。请从 backups/ 恢复或手工修复后重启。';
  }
  if (kind === 'RECORD') {
    return '❌ ' + msg + '。**已拒绝启动**（带脏数据运行会把错误越写越多）。';
  }
  return '❌ ' + msg + '。**已拒绝启动，原文件未改动。**';
}

/**
 * 加载数据文件到内存单一副本。
 * @param {{dataFile: string=, exitOnError: boolean=}=} opts
 *        dataFile 覆盖路径（测试用）；exitOnError=true 时失败即 console.error + exit(1)
 * @returns {{ok: boolean, doc: (object|undefined), error: (Error|undefined)}}
 */
function bootstrap(opts) {
  const o = opts || {};
  if (typeof o.dataFile === 'string' && o.dataFile) DATA_FILE = o.dataFile;
  try {
    QA_DATA = qaStore.loadFromFile(DATA_FILE, fs);
    LOAD_ERROR = null;
    if (QA_DATA.version !== SERVER_VERSION) {
      /* 版本不一致只告警不拒绝（向前兼容优先，设计 §10 A5）；结构非法已在 validateDoc 拦下 */
      console.warn('[qa-server] 数据文件 version=' + QA_DATA.version + '，当前支持 ' + SERVER_VERSION
        + '（仅告警，不拒绝启动）');
    }
    return { ok: true, doc: QA_DATA, error: undefined };
  } catch (e) {
    QA_DATA = null;
    LOAD_ERROR = e;
    if (o.exitOnError) {
      console.error(startupFailText(e));
      process.exit(1);
    }
    return { ok: false, doc: undefined, error: e };
  }
}

/**
 * `--init`：仅在目标文件**不存在**时创建空台账；已存在则「未改动」。
 * 幂等，可无条件重复调用；永不覆盖既有文件（设计 §1.2.4e）。
 * @param {string=} file 目标路径，缺省 DATA_FILE
 * @returns {{created: boolean, path: string, doc: (object|null)}}
 */
function runInit(file) {
  const target = file || DATA_FILE;
  const r = qaStore.initFile(target, fs);
  if (r.created) {
    console.log('✅ 已初始化数据文件：' + target + '（version ' + qaStore.DATA_VERSION + '，qaLogs 为空）');
  } else {
    console.log('ℹ️ 数据文件已存在，未做任何改动：' + target);
  }
  return r;
}

/** 建 server（不 listen，便于测试注入到自己的端口上） */
function createServer() {
  return http.createServer(handleRequest);
}

/**
 * CLI 主入口：--init / 正常启动。
 * @param {string[]=} argv 命令行参数（缺省 process.argv.slice(2)）
 * @returns {http.Server|null} --init 时返回 null（不启动服务）
 */
function main(argv) {
  const args = Array.isArray(argv) ? argv : process.argv.slice(2);
  if (args.indexOf('--init') >= 0) {
    runInit(DATA_FILE);
    process.exitCode = 0;              /* 幂等成功；不启动服务 */
    return null;
  }
  bootstrap({ exitOnError: true });
  const server = http.createServer(handleRequest);
  server.listen(PORT, function () {
    console.log('qa-server listening on port ' + PORT);
    console.log('  data file  : ' + DATA_FILE);
    console.log('  data ver   : ' + (QA_DATA ? QA_DATA.version : '(unknown)'));
    console.log('  auth proxy : ' + ME_URL);
  });
  return server;
}

/* ---------- 入口守卫 ---------- */
if (require.main === module) {
  /* 直接运行：main() 内负责「拒绝启动就 exit(1)」与 listen */
  main(process.argv.slice(2));
} else {
  /* 被 require（测试 / 复用）：不启服、不占端口、不 exit。
     仅**尝试**加载 env 指定的数据文件（失败只记录，由请求返回 500 说明原因），
     测试可随后用 bootstrap({dataFile}) 切到自己的临时文件。 */
  bootstrap();
}

module.exports = {
  /* 设计 §4.6 要求的 5 个导出 + 测试/运维所需的只读访问器 */
  handleRequest: handleRequest,
  createServer: createServer,
  enqueueWrite: enqueueWrite,
  canWrite: canWrite,
  canDel: canDel,
  TABLE_KEY: TABLE_KEY,
  readBody: readBody,
  sendJson: sendJson,
  send: sendJson,                       /* 与设计文档 §4.6 的命名对齐（同义别名） */
  authenticate: authenticate,
  publicQaUser: publicQaUser,
  healthBody: healthBody,
  bootstrap: bootstrap,
  runInit: runInit,
  main: main,
  getData: function () { return QA_DATA; },
  getLoadError: function () { return LOAD_ERROR; },
  getDataFile: function () { return DATA_FILE; },
  getVerifier: function () { return verifier; },
  MAX_BODY_BYTES: MAX_BODY_BYTES,
  PORT: PORT,
  DATA_VERSION: SERVER_VERSION
};
