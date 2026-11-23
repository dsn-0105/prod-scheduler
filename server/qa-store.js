/* ============================================================
   质量系统 · 数据层  server/qa-store.js
   ------------------------------------------------------------
   【build .163】职责：文档校验 / 记录增改 / 编号唯一性终检 /
   原子落盘 / --init 建文件。**只做纯数据操作，不碰 HTTP**（不 require http）。

   可测性设计（设计 §1.2.6e）：
     · fs 由调用方注入（本模块只用 fs.readFileSync / writeFileSync / renameSync /
       unlinkSync / existsSync 五个方法）⇒ 单测可用 fake fs 制造 EACCES / 磁盘满
     · now / rand 为入参 ⇒ 记录 id 与时间戳完全可预期，测试无需 mock 全局时钟
     · applyCreate / applyUpdate **不可变**：返回新 doc，是否提交由调用方（写队列）决定
       ⇒ 落盘失败时只要不提交，内存天然不撕裂（设计 §1.2.3f 第 3 层）

   数据键名映射：URL 用 exceptions，数据文件用 qaLogs；全工程**只有** TABLE_KEY 这一处写死
   'qaLogs' 字面量（qa-server.js 与测试都引用本常量）。
   ============================================================ */
'use strict';

const crypto = require('crypto');
const core = require('../quality/qa-core.js');

/* ---------- 对外常量 ---------- */

/** 数据文件顶层的台账表名（设计 §1.2.3b：URL↔数据键唯一映射点） */
const TABLE_KEY = 'qaLogs';

/** 数据格式版本（与生产 build 号解耦；不一致只告警不拒绝启动，见设计 §1.2.4a） */
const DATA_VERSION = 'qa-2026-11-23.1';

/**
 * 受服务端保护的字段（设计 §1.2.4d 保护名单）：
 *   id / createdBy / createdAt ⇒ body 里出现一律**静默忽略**
 *   no                         ⇒ body 里出现且 ≠ 原值 ⇒ 400「编号不可修改」
 *   updatedBy / updatedAt      ⇒ 由服务端覆盖写入
 * 其余顶层**标量**键原样落库（为 P2 加字段留路；这是刻意为之，不要加白名单）
 */
const PROTECTED_KEYS = ['id', 'no', 'createdBy', 'createdAt', 'updatedBy', 'updatedAt'];

/** 记录的标准字段全集（未知键 = 不在其中的键 ⇒ 标量透传 / 对象拒绝） */
const BASE_KEYS = ['id', 'no', 'date', 'createdBy', 'createdAt', 'updatedBy', 'updatedAt'];

/* ---------- 内部工具 ---------- */

/** 构造带 kind 标记的错误，供 qa-server 决定打印哪一条「拒绝启动」提示 */
function mkError(kind, message) {
  const e = new Error(message);
  e.kind = kind;
  return e;
}

/** 值的类型中文名（写进错误消息，便于运维定位） */
function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (v === undefined) return 'undefined';
  return typeof v;
}

/** 纯对象判定（排除 null / 数组） */
function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 深拷贝（数据量小，JSON 往返最省事且不会引入引用共享） */
function cloneDoc(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/** 归一化入参 now 为毫秒时间戳 */
function nowMs(now) {
  if (now instanceof Date) return isNaN(now.getTime()) ? Date.now() : now.getTime();
  const n = Number(now);
  return isFinite(n) ? n : Date.now();
}

/** 归一化入参 now 为 Date（供 qa-core.nextQaNo 使用） */
function nowDate(now) {
  return new Date(nowMs(now));
}

/** ISO 8601 UTC 时间戳（设计 §1.2.4b：统一 Z 后缀，展示时前端转本地） */
function nowIso(now) {
  return new Date(nowMs(now)).toISOString();
}

/** 从 user 里取 username（身份只来自 /api/me 代理，本模块不做任何鉴权判断） */
function usernameOf(user) {
  if (!user || typeof user !== 'object') return '';
  const u = typeof user.username === 'string' ? user.username.trim() : '';
  return u;
}

/** 失败结果统一形状（与成功一样带 doc 槽位，便于调用方统一处理） */
function fail(code, message) {
  return { code: code, body: { error: message }, doc: null };
}

/** revs 自增（保留 revs 里其它键，向前兼容未来新增表） */
function bumpRev(revs) {
  const next = Object.assign({}, isPlainObject(revs) ? revs : {});
  const cur = typeof next[TABLE_KEY] === 'number' && isFinite(next[TABLE_KEY]) ? next[TABLE_KEY] : 0;
  next[TABLE_KEY] = cur + 1;
  return next;
}

/** 取当前 rev（缺省 0） */
function readRev(revs) {
  const cur = revs && typeof revs[TABLE_KEY] === 'number' && isFinite(revs[TABLE_KEY]) ? revs[TABLE_KEY] : 0;
  return cur;
}

/** 归一化文档形状（只改内存副本，绝不写盘） */
function normalizeDoc(obj) {
  const doc = obj;
  if (typeof doc.version !== 'string' || !doc.version) doc.version = DATA_VERSION;
  if (!isPlainObject(doc.revs)) doc.revs = {};
  if (typeof doc.revs[TABLE_KEY] !== 'number' || !isFinite(doc.revs[TABLE_KEY])) doc.revs[TABLE_KEY] = 0;
  return doc;
}

/**
 * 收集 body 中的「未知顶层键」。
 * 标量（string / number / boolean / null）原样透传落库；对象 / 数组 ⇒ 记入 bad（由调用方返 400，
 * 禁止把嵌套结构塞进扁平台账 —— 否则「字段在哪」会变成两种情况）。
 */
function collectExtras(body) {
  const extras = {};
  const bad = [];
  Object.keys(body).forEach(function (k) {
    if (BASE_KEYS.indexOf(k) >= 0) return;         /* 标准字段不参与透传 */
    const v = body[k];
    if (v !== null && typeof v === 'object') { bad.push(k); return; }
    extras[k] = v;
  });
  return { extras: extras, bad: bad };
}

/* ---------- 对外纯函数 ---------- */

/**
 * 生成记录内部主键：'e_<13位时间戳>_<6位随机hex>'。
 * rand 注入以便测试确定性；缺省用 crypto.randomBytes（零依赖、无需 npm）。
 * @param {number|Date} now 时刻（毫秒或 Date）
 * @param {function(number): string=} rand 入参为需要的十六进制字符数
 * @returns {string}
 */
function makeId(now, rand) {
  const ts = nowMs(now);
  const gen = typeof rand === 'function' ? rand : defaultRand;
  const raw = gen(6);                                  /* 只调用一次：注入函数可能是确定性桩 */
  let r = (raw === undefined || raw === null) ? '' : String(raw);
  r = (r + '000000').slice(0, 6);                      /* 不足补 0、超长截断，恒为 6 位 */
  return 'e_' + ts + '_' + r;
}

/** 缺省随机段实现（3 字节 → 6 位 hex） */
function defaultRand(len) {
  const n = Math.max(1, Math.ceil(Number(len) / 2));
  return crypto.randomBytes(n).toString('hex');
}

/**
 * 文档结构校验。任一不过即抛带中文诊断的 Error（设计 §1.2.4e 启动校验清单）。
 * 刻意**不校验** date 字段：历史脏数据不该阻止启动，date 由写入路径的 isValidDate 把关。
 * @param {*} obj 待校验对象
 * @returns {undefined} 通过时无返回；失败时抛 Error（e.kind ∈ STRUCT / RECORD）
 */
function validateDoc(obj) {
  if (!isPlainObject(obj)) {
    throw mkError('STRUCT', '数据文件结构非法：顶层必须为 JSON 对象（实际 ' + typeName(obj) + '）');
  }
  if (!Array.isArray(obj[TABLE_KEY])) {
    throw mkError('STRUCT', '数据文件结构非法：qaLogs 必须为数组（实际 ' + typeName(obj[TABLE_KEY]) + '）');
  }
  const seen = Object.create(null);
  obj[TABLE_KEY].forEach(function (r, i) {
    const n = i + 1;
    if (!isPlainObject(r)) {
      throw mkError('RECORD', '数据文件第 ' + n + ' 条记录不是对象（实际 ' + typeName(r) + '）');
    }
    if (typeof r.id !== 'string' || !r.id) {
      throw mkError('RECORD', '数据文件第 ' + n + ' 条记录缺少 id 或 no');
    }
    if (typeof r.no !== 'string' || !r.no) {
      throw mkError('RECORD', '数据文件第 ' + n + ' 条记录缺少 id 或 no');
    }
    if (!core.isValidNo(r.no)) {
      throw mkError('RECORD', '数据文件第 ' + n + ' 条记录编号格式非法：' + r.no);
    }
    if (seen[r.no]) {
      throw mkError('RECORD', '数据文件第 ' + n + ' 条记录编号重复：' + r.no);
    }
    seen[r.no] = true;
  });
}

/**
 * 从磁盘加载并校验文档。
 * **不写盘、不改名、不创建任何文件** —— 加载失败就是失败，绝不做任何「自愈」动作，
 * 否则一次挂载丢失就会把全部台账抹成空文件（设计 §1.2.4e 的裁定理由）。
 * @param {string} file 数据文件路径
 * @param {object} fsImpl 注入的 fs（需 readFileSync）
 * @returns {object} 归一化后的文档（内存副本）
 */
function loadFromFile(file, fsImpl) {
  if (!fsImpl || typeof fsImpl.readFileSync !== 'function') {
    throw mkError('LOAD', 'loadFromFile 缺少 fs 注入（需 readFileSync）：' + file);
  }
  let raw;
  try {
    raw = fsImpl.readFileSync(file, 'utf8');
  } catch (e) {
    const code = e && e.code ? String(e.code) : (e && e.message ? String(e.message) : '未知错误');
    throw mkError('LOAD', '数据文件不存在或不可读：' + file + '（' + code + '）');
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw mkError('PARSE', '数据文件 JSON 解析失败：' + file);
  }
  validateDoc(obj);            /* 失败时抛 STRUCT / RECORD，kind 已带好 */
  return normalizeDoc(obj);
}

/** 空文档（--init 产物；revs 只含 TABLE_KEY 一项，不预留任何计数器） */
function emptyDoc() {
  const doc = { version: DATA_VERSION, revs: {} };
  doc[TABLE_KEY] = [];         /* 用计算键写入，保持 TABLE_KEY 是唯一字面量点 */
  doc.revs[TABLE_KEY] = 0;
  return doc;
}

/**
 * 幂等初始化：文件**不存在**才创建；已存在一律返回 {created:false} 且不做任何改动。
 * 与生产 `node server.js --reset-pwd` 同构：初始化这件危险动作必须由人显式触发。
 * @param {string} file 数据文件路径
 * @param {object} fsImpl 注入的 fs（需 existsSync / writeFileSync / renameSync）
 * @returns {{created: boolean, path: string, doc: object|null}}
 */
function initFile(file, fsImpl) {
  if (!fsImpl || typeof fsImpl.writeFileSync !== 'function') {
    throw new Error('initFile 缺少 fs 注入（需 writeFileSync / renameSync）：' + file);
  }
  if (typeof fsImpl.existsSync === 'function' && fsImpl.existsSync(file)) {
    return { created: false, path: file, doc: null };     /* 幂等：**永不覆盖** */
  }
  const doc = emptyDoc();
  writeAtomic(file, doc, fsImpl);
  return { created: true, path: file, doc: doc };
}

/**
 * 原子落盘：写 `<file>.tmp` → rename 到目标。同目录 rename 在同一文件系统内原子
 * （与生产 server.js 的 saveJson 同口径）。失败时尽力清掉 .tmp 后向上抛，
 * 由调用方（qa-server 写队列）决定不提交内存副本 ⇒ 内存与磁盘不撕裂。
 * @param {string} file 目标路径
 * @param {object} doc 完整文档
 * @param {object} fsImpl 注入的 fs
 * @returns {undefined}
 */
function writeAtomic(file, doc, fsImpl) {
  if (!fsImpl || typeof fsImpl.writeFileSync !== 'function' || typeof fsImpl.renameSync !== 'function') {
    throw new Error('writeAtomic 缺少 fs 注入（需 writeFileSync / renameSync）：' + file);
  }
  const tmp = file + '.tmp';
  try {
    fsImpl.writeFileSync(tmp, JSON.stringify(doc, null, 1));
    fsImpl.renameSync(tmp, file);
  } catch (e) {
    if (typeof fsImpl.unlinkSync === 'function') {
      try { fsImpl.unlinkSync(tmp); } catch (e2) { /* .tmp 可能根本没建成，忽略 */ }
    }
    throw e;
  }
}

/**
 * 新增一条台账记录（不可变风格：返回新 doc，调用方决定是否提交）。
 * 契约要点（设计 §3.3）：
 *   · date 必填且必须是真实日历日（允许未来日期，PRD Q5）
 *   · no 缺省 ⇒ 服务端按 F5 单源发号（不可能冲突）
 *   · no 提供 ⇒ 先校验格式，再在**调用方已串行化的写区**内做唯一性终检（冲突 409 + suggest）
 *   · 未知顶层标量键原样落库；对象 / 数组 ⇒ 400
 * @param {object} doc 当前文档（不会被修改）
 * @param {object} body 请求体
 * @param {object} user 已鉴权用户（取 username 作 createdBy / updatedBy）
 * @param {number|Date} now 写入时刻
 * @param {function(number): string=} rand 随机段注入
 * @returns {{code: number, body: object, doc: object|null}}
 */
function applyCreate(doc, body, user, now, rand) {
  if (!isPlainObject(doc) || !Array.isArray(doc[TABLE_KEY])) {
    return fail(500, '数据文档非法：qaLogs 必须为数组');
  }
  if (!isPlainObject(body)) {
    return fail(400, '请求体必须为 JSON 对象');
  }
  const who = usernameOf(user);
  if (!who) return fail(401, '未登录或登录已过期');

  if (!core.isValidDate(body.date)) {
    return fail(400, '日期格式不正确，应为 YYYY-MM-DD 且必须是真实存在的日期');
  }
  const ex = collectExtras(body);
  if (ex.bad.length) {
    return fail(400, '以下字段只支持标量值（字符串/数字/布尔/null）：' + ex.bad.join(', '));
  }

  const list = doc[TABLE_KEY];
  let no;
  if (body.no === undefined || body.no === null || body.no === '') {
    no = core.nextQaNo(list, nowDate(now));            /* 缺省 ⇒ 发号，不可能冲突 */
  } else {
    if (!core.isValidNo(body.no)) {
      return fail(400, '编号格式不正确，应为 YC-YYYYMMDD-XXXXX');
    }
    const dup = list.some(function (r) { return r && r.no === body.no; });
    if (dup) {
      /* 409 是**防御性兜底**（正常路径已被写队列消掉）；前端拿到 suggest 静默重提交一次 */
      return {
        code: 409,
        body: { error: '编号已被占用', conflict: true, suggest: core.nextQaNo(list, nowDate(now)) },
        doc: null
      };
    }
    no = body.no;
  }

  const ts = nowIso(now);
  const record = Object.assign({
    id: makeId(now, rand),
    no: no,
    date: body.date,
    createdBy: who,
    createdAt: ts,
    updatedBy: who,
    updatedAt: ts
  }, ex.extras);                    /* extras 不含标准字段（collectExtras 已跳过），不会覆盖上面 */

  const nextDoc = cloneDoc(doc);
  nextDoc[TABLE_KEY] = list.concat([record]);
  nextDoc.revs = bumpRev(doc.revs);
  return { code: 201, body: { ok: true, rev: readRev(nextDoc.revs), record: record }, doc: nextDoc };
}

/**
 * 编辑一条记录（本轮只允许改 date + 未知顶层标量键）。
 *   · id 不存在 ⇒ 404
 *   · body.no 出现且 ≠ 原值 ⇒ 400「编号不可修改」；等于原值 ⇒ 忽略放行（幂等）
 *   · id / createdBy / createdAt 出现 ⇒ 静默忽略（服务端权威）
 *   · updatedBy / updatedAt ⇒ 服务端覆盖
 * @param {object} doc 当前文档（不会被修改）
 * @param {string} id 记录内部主键
 * @param {object} body 请求体
 * @param {object} user 已鉴权用户
 * @param {number|Date} now 写入时刻
 * @returns {{code: number, body: object, doc: object|null}}
 */
function applyUpdate(doc, id, body, user, now) {
  if (!isPlainObject(doc) || !Array.isArray(doc[TABLE_KEY])) {
    return fail(500, '数据文档非法：qaLogs 必须为数组');
  }
  if (!isPlainObject(body)) {
    return fail(400, '请求体必须为 JSON 对象');
  }
  const who = usernameOf(user);
  if (!who) return fail(401, '未登录或登录已过期');

  const list = doc[TABLE_KEY];
  let idx = -1;
  for (let i = 0; i < list.length; i++) {
    if (list[i] && list[i].id === id) { idx = i; break; }
  }
  if (idx < 0) return fail(404, '记录不存在');
  const rec = list[idx];

  if (Object.prototype.hasOwnProperty.call(body, 'no') && body.no !== rec.no) {
    return fail(400, '编号不可修改');
  }
  if (!core.isValidDate(body.date)) {
    return fail(400, '日期格式不正确，应为 YYYY-MM-DD 且必须是真实存在的日期');
  }
  const ex = collectExtras(body);
  if (ex.bad.length) {
    return fail(400, '以下字段只支持标量值（字符串/数字/布尔/null）：' + ex.bad.join(', '));
  }

  const updated = Object.assign({}, rec, ex.extras, {
    date: body.date,
    updatedBy: who,
    updatedAt: nowIso(now)
  });
  /* 服务端权威字段：无论 extras 里混进什么，最终以此为准（数据结构层面永不变） */
  updated.id = rec.id;
  updated.no = rec.no;
  updated.createdBy = rec.createdBy;
  updated.createdAt = rec.createdAt;

  const nextDoc = cloneDoc(doc);
  nextDoc[TABLE_KEY] = list.slice();
  nextDoc[TABLE_KEY][idx] = updated;
  nextDoc.revs = bumpRev(doc.revs);
  return { code: 200, body: { ok: true, rev: readRev(nextDoc.revs), record: updated }, doc: nextDoc };
}

module.exports = {
  TABLE_KEY: TABLE_KEY,
  DATA_VERSION: DATA_VERSION,
  PROTECTED_KEYS: PROTECTED_KEYS,
  BASE_KEYS: BASE_KEYS,
  makeId: makeId,
  validateDoc: validateDoc,
  loadFromFile: loadFromFile,
  initFile: initFile,
  emptyDoc: emptyDoc,
  writeAtomic: writeAtomic,
  applyCreate: applyCreate,
  applyUpdate: applyUpdate,
  cloneDoc: cloneDoc,
  readRev: readRev
};
