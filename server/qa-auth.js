/* ============================================================
   质量系统 · 鉴权代理层  server/qa-auth.js
   ------------------------------------------------------------
   【build .163】为什么必须代理而不能自校验：token 存在**生产进程内存 Map** 里，
   生产账号文件里只有 salt/hash、没有 token→username 映射 ⇒ 除了打一次
   `GET /api/me` 之外没有第二条路能回答「你是谁」（设计 §1.2.1a 的决定性理由）。

   因此本模块**唯一身份来源** = 生产 `GET /api/me`：
     · 不读生产账号文件（双权限源必然撕裂，设计 §1.2.1a / §9.1）
     · 不做第二权限源、不做自签 token

   缓存口径（设计 §1.2.1b）：
     · Key   = Authorization: Bearer 后的原始 token 串（token 是随机串不是密码，不做 hash）
     · Value = { user: {username,name,role,perms}, exp }，只缓存**白名单字段**，
               不缓存原始响应 JSON（防止意外透传 mustChangePwd 等字段）
     · TTL   = 60s；上限 500 条，超限按插入序淘汰最旧
     · 401 ⇒ 立即删缓存并透传 401（收权/停用最快收敛）
     · 写操作穿透由 qa-server 负责（"哪些是写操作"属路由层知识，不是本模块的职责）

   失败口径（设计 §1.2.1c）：生产 /api/me 不可达 ⇒ fail-closed 返回 503，绝不 fail-open。
   fail-open 会让台账在生产后端长时间故障时对任何能访问该 IP 的人开放读，属安全审计必拦场景。

   可测性（设计 §1.2.6e）：httpGet 由调用方注入 ⇒ 鉴权逻辑 100% 可单测、零网络。
   ============================================================ */
'use strict';

const http = require('http');

/* ---------- 缺省参数 ---------- */
const DEFAULT_TTL_MS = 60000;            /* PRD P0-6 指定 60s */
const DEFAULT_TIMEOUT_MS = 1500;         /* 本机 loopback 正常 <10ms；1500ms 保证远早于 nginx 30s 超时 */
const DEFAULT_CONNECT_TIMEOUT_MS = 800;  /* 覆盖生产后端 GC/JIT 抖动 */
const DEFAULT_MAX_ENTRIES = 500;         /* 10 人系统最多 10~20 个活 token，500 是防御性上限 */
const MAX_BODY_BYTES = 32 * 1024;        /* /api/me 响应极小；超出即视为异常响应 */

/** 数值参数归一：非法回落默认值，并夹到 >= min */
function toInt(v, def, min) {
  const n = Number(v);
  if (!isFinite(n)) return def;
  return n < min ? min : Math.floor(n);
}

/** 纯对象判定 */
function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 深拷贝（缓存命中也返回副本，避免调用方误改缓存内容） */
function clonePlain(v) {
  if (v === undefined) return undefined;
  return JSON.parse(JSON.stringify(v));
}

/**
 * 缺省 httpGet 实现：http.request + 连接超时 + 总超时。
 * 返回值形状与注入桩一致：Promise<{status:number, json:any, body:string}>
 * 任何网络/超时错误都 reject，由 verify() 统一转成 503（fail-closed）。
 * @param {string} url 目标 URL
 * @param {{headers: object, timeoutMs: number, connectTimeoutMs: number}=} opts
 * @returns {Promise<{status: number, json: any, body: string}>}
 */
function defaultHttpGet(url, opts) {
  const o = opts || {};
  const headers = isPlainObject(o.headers) ? o.headers : {};
  const timeoutMs = toInt(o.timeoutMs, DEFAULT_TIMEOUT_MS, 1);
  const connectTimeoutMs = toInt(o.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS, 1);

  return new Promise(function (resolve, reject) {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      reject(new Error('鉴权代理 URL 非法：' + url));
      return;
    }
    const req = http.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      method: 'GET',
      headers: headers,
      timeout: timeoutMs
    }, function (res) {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', function (chunk) {
        body += chunk;
        if (body.length > MAX_BODY_BYTES) req.destroy(new Error('鉴权代理响应体过大'));
      });
      res.on('end', function () {
        let json = null;
        try { json = JSON.parse(body); } catch (e) { json = null; }
        resolve({ status: res.statusCode, json: json, body: body });
      });
      res.on('error', reject);
    });
    /* 连接阶段单独计时：避免「TCP 握手就挂住」把整个请求拖到总超时 */
    req.on('socket', function (socket) {
      if (!socket.connecting) return;
      const timer = setTimeout(function () {
        req.destroy(new Error('连接鉴权服务超时（' + connectTimeoutMs + 'ms）'));
      }, connectTimeoutMs);
      const clear = function () { clearTimeout(timer); };
      socket.once('connect', clear);
      socket.once('close', clear);
    });
    req.setTimeout(timeoutMs, function () {
      req.destroy(new Error('鉴权代理请求超时（' + timeoutMs + 'ms）'));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * 从 /api/me 的响应体里提炼白名单字段。
 * 兼容两种形状：生产 /api/me 的扁平 publicUser，以及 {ok:true, user:{…}} 包裹形态。
 * 任何「读不出合法身份」的情况都返回 null（由 verify 转成 401，绝不猜测）。
 * @param {*} raw 响应 JSON
 * @returns {{username: string, name: string, role: string, perms: object}|null}
 */
function pickUser(raw) {
  if (!isPlainObject(raw)) return null;
  const src = isPlainObject(raw.user) ? raw.user : raw;
  const username = typeof src.username === 'string' ? src.username.trim() : '';
  if (!username) return null;
  /* 防御性：账号已停用时生产 /api/me 会 401，这里再兜一层（防止包裹形态漏判） */
  if (src.status !== undefined && src.status !== null && String(src.status) !== 'active') return null;
  return {
    username: username,
    name: typeof src.name === 'string' && src.name ? src.name : username,
    role: typeof src.role === 'string' && src.role ? src.role : 'staff',
    perms: isPlainObject(src.perms) ? clonePlain(src.perms) : {}
  };
}

/**
 * 创建鉴权器。
 * @param {{meUrl: string, ttlMs: number=, timeoutMs: number=, connectTimeoutMs: number=,
 *          maxEntries: number=, httpGet: function(string, object): Promise}=} opts
 * @returns {{verify: function(string): Promise<{status: string, user: (object|undefined)}>,
 *            invalidate: function(string): void,
 *            stats: function(): {size: number, hits: number, misses: number},
 *            clear: function(): void}}
 */
function createVerifier(opts) {
  const o = isPlainObject(opts) ? opts : {};
  const meUrl = typeof o.meUrl === 'string' && o.meUrl ? o.meUrl : 'http://127.0.0.1:3000/api/me';
  const ttlMs = toInt(o.ttlMs, DEFAULT_TTL_MS, 0);
  const timeoutMs = toInt(o.timeoutMs, DEFAULT_TIMEOUT_MS, 1);
  const connectTimeoutMs = toInt(o.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS, 1);
  const maxEntries = toInt(o.maxEntries, DEFAULT_MAX_ENTRIES, 1);
  const httpGet = typeof o.httpGet === 'function' ? o.httpGet : defaultHttpGet;

  const cache = new Map();                 /* token → {user, exp}，插入序即可用的淘汰顺序 */
  const stats = { hits: 0, misses: 0 };

  /** 归一化 token：非字符串/空白一律视为无 token */
  function normToken(token) {
    return typeof token === 'string' ? token.trim() : '';
  }

  /** 入缓存 + 超上限按插入序淘汰最旧（Map.keys().next() 一行搞定，无需 LRU 实现） */
  function remember(token, user) {
    cache.set(token, { user: user, exp: Date.now() + ttlMs });
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }

  /**
   * 校验 token。
   * @param {string} token Authorization: Bearer 后的原始串
   * @returns {Promise<{status: 'ok', user: object}|{status: '401'}|{status: '503'}>}
   *          '503' = /api/me 不可达（fail-closed，调用方必须拒绝请求）
   */
  function verify(token) {
    const t = normToken(token);
    if (!t) return Promise.resolve({ status: '401' });      /* 空 token 不查缓存、不计 miss */

    const now = Date.now();
    const hit = cache.get(t);
    if (hit && hit.exp > now) {
      stats.hits++;
      return Promise.resolve({ status: 'ok', user: clonePlain(hit.user) });
    }
    if (hit) cache.delete(t);                                /* 到期即清，避免脏留 */
    stats.misses++;

    return Promise.resolve()
      .then(function () {
        return httpGet(meUrl, {
          headers: { Authorization: 'Bearer ' + t },
          timeoutMs: timeoutMs,
          connectTimeoutMs: connectTimeoutMs
        });
      })
      .then(function (res) {
        const code = res && typeof res.status === 'number' ? res.status : 0;
        if (code === 200) {
          const user = pickUser(res && res.json);
          if (!user) return { status: '401' };               /* 200 但身份不可解析 ⇒ 视为未登录 */
          remember(t, user);
          return { status: 'ok', user: clonePlain(user) };
        }
        if (code === 401 || code === 403) {
          cache.delete(t);                                   /* 权限被收回/账号停用 ⇒ 立即收敛 */
          return { status: '401' };
        }
        /* 网络错误 / 超时 / 5xx / 其它非 2xx ⇒ fail-closed */
        return { status: '503' };
      }, function () {
        return { status: '503' };                            /* 请求本身失败（连不上/超时）⇒ fail-closed */
      });
  }

  /** 删缓存（写请求穿透后若得 401 也会调用；也可由运维手工调用） */
  function invalidate(token) {
    cache.delete(normToken(token));
  }

  /** 观测指标：排障时判断「是不是缓存害的」（health 端点暴露） */
  function stats_() {
    return { size: cache.size, hits: stats.hits, misses: stats.misses };
  }

  /** 清空缓存（测试/运维用；正常路径不调用） */
  function clear() {
    cache.clear();
  }

  return { verify: verify, invalidate: invalidate, stats: stats_, clear: clear };
}

module.exports = {
  createVerifier: createVerifier,
  defaultHttpGet: defaultHttpGet,
  pickUser: pickUser,
  DEFAULT_TTL_MS: DEFAULT_TTL_MS,
  DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
  DEFAULT_CONNECT_TIMEOUT_MS: DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_MAX_ENTRIES: DEFAULT_MAX_ENTRIES
};
