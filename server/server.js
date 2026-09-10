#!/usr/bin/env node
/* ============================================================
   生产排单系统 - 轻量后端（零依赖 Node.js）
   功能：账号登录 / 员工管理 / 按表单写权限 / 数据存储 / 实时同步
   部署：node server.js  (端口 3000)，Nginx 反代 /api
   ============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const USERS_FILE = path.join(__dirname, 'users.json');

/* 【安全 P0·③】是否拒绝 URL query 形式的 token（默认关闭=保留兜底）。
   背景：token 走 query 会进入 nginx access log、浏览器历史、Referer 头，属泄露面。
   现状：前端已全部改为 Authorization 请求头（.123），但旧标签页/未刷新客户端仍可能带 query。
   关闭时机：前端新版全量上线并稳定 ≥1 周、确认服务端日志中 query token 请求归零后，
   在 systemd 环境变量里设 DEPRECATE_QUERY_TOKEN=1 即可硬关闭兜底。 */
const DEPRECATE_QUERY_TOKEN = process.env.DEPRECATE_QUERY_TOKEN === '1';

const DEFAULT_DATA = {
  products: [], orders: [], deliveries: [], productionPlans: [], productionReports: [], processTemplates: [],
  logs: [], fields: null, meta: { seq: 0 },
  fieldsAudit: 'audited', fieldsDraft: null, tblLayout: {},
  transfers: []
};

/* 业务数据表（受按表单写权限控制）；其余为系统 key（登录用户均可写）。
   .122：日排产模块（备货 dailyPlans/包装 dailyPkgs 表）整体移除——dailyPlans 仅余为排产计划页的权限键（见 STAFF_PERMS），不再是数据表 */
const BIZ_KEYS = ['products', 'orders', 'deliveries', 'productionPlans', 'processTemplates', 'fields'];
const SYSTEM_KEYS = ['logs', 'meta', 'tblLayout', 'fieldsAudit', 'fieldsDraft', 'transfers', 'productionReports'];

function load(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return def; }
}
function saveJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, file);
}
function hashPwd(pwd, salt) {
  return crypto.scryptSync(String(pwd), salt, 32).toString('hex');
}
function newUser(username, name, role, pwd, perms) {
  const salt = crypto.randomBytes(16).toString('hex');
  /* 【安全 P0·②】mustChangePwd=首次下发/重置后的弱口令标记：前端据此提示「请立即修改密码」，
     /api/change-pwd 成功或管理员在员工面板重置密码成功后清除（见下方路由）。
     仅新建用户时置 true；存量用户对象不含该字段（undefined 视为 false），故存量数据不受影响。 */
  return { username, name, role, status: 'active', salt, hash: hashPwd(pwd, salt), perms: perms || {}, mustChangePwd: true };
}
/* 【安全 P0·②】生成一次性可读随机密码（base64url 去掉易混字符，12 位），用于首次初始化。
   仅打印到 stdout（journalctl -u prod-server 可读），绝不落盘明文、绝不硬编码。 */
function genInitPwd() {
  return crypto.randomBytes(12).toString('base64url')
    .replace(/[+/=]/g, '')
    .slice(0, 12);
}
/* 【安全 P0·②】随机重置某存量账号密码（运维手动使用），返回新明文密码；用户不存在返回 null */
function resetUserPwd(username, newPwd) {
  const u = users.find(x => x.username === username);
  if (!u) return null;
  u.hash = hashPwd(newPwd, u.salt);
  u.mustChangePwd = true;   /* 重置后强制提示改密 */
  saveJson(USERS_FILE, users);
  return newPwd;
}

/* 数据 */
let data = load(DATA_FILE, null);
if (!data) { data = JSON.parse(JSON.stringify(DEFAULT_DATA)); saveJson(DATA_FILE, data); }
let dataBootChanged = false;
Object.keys(DEFAULT_DATA).forEach(k => { if (data[k] === undefined) { data[k] = DEFAULT_DATA[k]; dataBootChanged = true; } });
if (dataBootChanged) saveJson(DATA_FILE, data);
let revs = {};
Object.keys(data).forEach(k => revs[k] = 0);

/* 用户（兼容旧格式：补 name/status/perms） */
/* .122：日排产模块移除——dailyPkgs（包装排产）权限键删除；dailyPlans 权限键保留=「排产计划」页写权限（prodPlan 用） */
const STAFF_PERMS = { products: false, saleOrders: false, invOrders: false, dailyPlans: false, deliveries: false, processTemplates: false, fields: false, acts: {} };   /* .118：orders 拆为 saleOrders(销售)/invOrders(库存)；.119：acts=按钮级业务动作（空=仅 CRUD，由管理员在员工面板按动作授权） */
/* .119：按钮级动作键全集（与前端 FORM_ACTS 键一致，供存量员工迁移全开与前端逐键收敛） */
const ACT_KEYS = ['product.genOrder', 'order_frame.saleDeliver', 'order_frame.saleReturn', 'order_frame.kingdeeImport', 'order_frame.saleCall', 'order_frame.saleReturnStock', 'order_inv.invGenDelivery', 'order_inv.invCall', 'delivery.delPushPlan', 'prodPlan.ppEdit', 'prodPlan.ppLaunch', 'prodPlan.ppShift', 'prodPlan.ppReport', 'prodPlan.ppReportEdit', 'prodPlan.ppDel'];
let users = load(USERS_FILE, null);
if (!users || !Array.isArray(users)) {
  /* 【安全 P0·②】首次初始化分支（仅在 users.json 不存在/非法时进入）。
     密码来源优先级：
       1) 环境变量 PROD_INIT_PWD 已设置 → 所有初始账号统一用该密码（适合批量部署）
       2) 未设置 → 每个账号各自生成 12 位随机密码，并 console.log 打印到 stdout
          （部署后执行 journalctl -u prod-server 查看）
     已彻底移除硬编码 admin123 / 123456。
     ⚠️ 兼容性：线上已有 users.json 时会走下面的 else 分支，存量密码完全不受影响。 */
  const initPwd = process.env.PROD_INIT_PWD || '';
  const pwdOf = {};
  const initDefs = [
    { username: 'admin', name: '管理员', role: 'admin', perms: {} },
    { username: 'pmc', name: 'PMC', role: 'staff', perms: JSON.parse(JSON.stringify(STAFF_PERMS)) },
    { username: 'chejian', name: '车间', role: 'staff', perms: JSON.parse(JSON.stringify(STAFF_PERMS)) },
    { username: 'zongjingli', name: '总经理', role: 'staff', perms: JSON.parse(JSON.stringify(STAFF_PERMS)) }
  ];
  initDefs.forEach(d => { pwdOf[d.username] = initPwd || genInitPwd(); });
  users = initDefs.map(d => newUser(d.username, d.name, d.role, pwdOf[d.username], d.perms));
  saveJson(USERS_FILE, users);

  console.log('============================================================');
  console.log('[安全提示] 检测到首次初始化（users.json 不存在），已生成初始账号密码，请登录后立即修改！');
  if (initPwd) {
    console.log('  密码来源：环境变量 PROD_INIT_PWD（所有账号同一密码，已设置）');
  } else {
    console.log('  密码来源：随机生成（未设置 PROD_INIT_PWD；请立即抄录并登录后修改）');
  }
  initDefs.forEach(d => {
    console.log('  账号 ' + d.username.padEnd(12) + ' / 密码 ' + pwdOf[d.username] + '   （' + d.name + ' · ' + d.role + '）');
  });
  console.log('  手动重置密码：node server.js --reset-pwd <username> <newpassword>');
  console.log('============================================================');
} else {
  let changed = false;
  users.forEach(u => {
    if (u.name === undefined) { u.name = u.username; changed = true; }
    if (u.status === undefined) { u.status = 'active'; changed = true; }
    if (u.perms === undefined) { u.perms = u.role === 'admin' ? {} : JSON.parse(JSON.stringify(STAFF_PERMS)); changed = true; }
    /* .118：权限点拆分迁移——旧 orders 键(订单管理=销售+库存同权)拆为 saleOrders/invOrders；曾勾选过则双开保权限不缩水 */
    if (u.perms && 'orders' in u.perms) {
      const _lo = u.perms.orders; delete u.perms.orders;
      if (_lo === true) {
        if (u.perms.saleOrders === undefined) u.perms.saleOrders = true;
        if (u.perms.invOrders === undefined) u.perms.invOrders = true;
      }
      changed = true;
    }
    /* .119：按钮级动作权限迁移——存量员工无 perms.acts 时全键开启（升级后按钮显隐与 .118 一致不缩水）；
       管理员在员工面板重新保存该员工后 acts 固化，可逐键收敛（如车间只留投产/报工） */
    if (u.perms && u.perms.acts === undefined && u.role !== 'admin') {
      u.perms.acts = {};
      ACT_KEYS.forEach(k => { u.perms.acts[k] = true; });
      changed = true;
    }
    /* 【安全 P0·② 兜底补盐】异常存量用户缺 salt/hash 时补随机盐与随机密码。
       注意：本分支会 changed=true → 写回 users.json，故绝不能硬编码弱口令（否则等于静默把用户密码改成 123456）。
       密码改为每账号各自生成 12 位随机值，仅打印到 stdout（journalctl -u prod-server 可读），并置 mustChangePwd=true
       让用户下次登录被提示改密。正常存量数据均已有 salt/hash，本分支不触发。 */
    if (!u.salt || !u.hash) {
      const s = crypto.randomBytes(16).toString('hex');
      const p = genInitPwd();
      u.salt = s;
      u.hash = hashPwd(p, s);
      u.mustChangePwd = true;
      changed = true;
      console.log('[安全提示] 账号「' + u.username + '」缺少 salt/hash（异常存量数据），已补随机盐并重置密码为随机值，请登录后立即修改：'
        + '账号 ' + u.username + ' / 密码 ' + p);
    }
  });
  if (changed) saveJson(USERS_FILE, users);
}

/* 会话 */
const tokens = new Map();
const TOKEN_TTL = 7 * 24 * 3600 * 1000;

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readBody(req, cb) {
  let b = '';
  req.on('data', c => { b += c; if (b.length > 5e6) req.destroy(); });
  req.on('end', () => { try { cb(JSON.parse(b)); } catch (e) { cb(null); } });
}
/* 【安全 P0·③】token 优先从 Authorization: Bearer 请求头读取（不放 URL，避免进入 nginx access log /
   浏览器历史 / Referer 头）；query 形式保留为兜底，防止旧标签页/未刷新客户端立即失效。
   设 DEPRECATE_QUERY_TOKEN=1 后彻底拒绝 query token（见文件顶部说明与关闭时机）。 */
function auth(req) {
  let token = '';
  const ah = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(ah).trim());
  if (m) token = m[1].trim();
  if (!token && !DEPRECATE_QUERY_TOKEN) {
    const url = new URL(req.url, 'http://x');
    token = url.searchParams.get('token') || '';
  }
  if (!token) return null;
  const uname = tokens.get(token);
  if (!uname) return null;
  const u = users.find(x => x.username === uname);
  return u && u.status === 'active' ? u : null;
}
function canWrite(user, key) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (SYSTEM_KEYS.indexOf(key) >= 0) return true;
  /* .118：orders 表同时承载销售+库存两类订单——staff 写权限=两权限点任一开启；页面级隔离由前端 canWriteForm(order_frame/order_inv) 控制 */
  if (key === 'orders') return !!(user.perms && (user.perms.saleOrders === true || user.perms.invOrders === true || user.perms.orders === true));
  return !!(user.perms && user.perms[key] === true);
}
function publicUser(u) {
  /* 【安全 P0·②】额外返回 mustChangePwd 标记（存量用户无该字段 → undefined，前端按 false 处理），
     前端据此提示「当前为初始/重置密码，请尽快修改」。不泄露 hash/salt。 */
  return { username: u.username, name: u.name, role: u.role, status: u.status, perms: u.perms || {}, mustChangePwd: u.mustChangePwd === true };
}

/* 【安全 P0·②】运维入口：命令行重置账号密码（不启动服务，执行后立即退出）
   用法：node server.js --reset-pwd <username> <newpassword>
   用途：线上存量账号曾使用弱口令（admin123/123456）时，由运维手动逐个重置。
   重置后自动置 mustChangePwd=true，用户下次登录会被提示改密。 */
if (process.argv[2] === '--reset-pwd') {
  const uname = process.argv[3];
  const newPwd = process.argv[4];
  if (!uname || !newPwd) {
    console.error('用法：node server.js --reset-pwd <username> <newpassword>');
    process.exit(1);
  }
  if (String(newPwd).length < 6) {
    console.error('新密码至少 6 位');
    process.exit(1);
  }
  const usersFile = USERS_FILE;
  if (!users || !Array.isArray(users)) {
    console.error('用户文件不存在或非法，无法重置：' + usersFile);
    process.exit(1);
  }
  const target = users.find(x => x.username === uname);
  if (!target) {
    console.error('用户不存在：' + uname + '（现有账号：' + users.map(x => x.username).join(', ') + '）');
    process.exit(1);
  }
  resetUserPwd(uname, String(newPwd));
  console.log('已重置账号「' + uname + '」的密码（mustChangePwd=true，用户下次登录需强制改密提示）。');
  process.exit(0);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  /* 登录 */
  if (p === '/api/login' && req.method === 'POST') {
    return readBody(req, b => {
      if (!b || !b.username || !b.password) return send(res, 400, { error: '参数缺失' });
      const u = users.find(x => x.username === b.username);
      if (!u || u.hash !== hashPwd(b.password, u.salt)) return send(res, 401, { error: '用户名或密码错误' });
      if (u.status !== 'active') return send(res, 403, { error: '账号已停用，请联系管理员' });
      const token = crypto.randomBytes(24).toString('hex') + '.' + Date.now();
      tokens.set(token, u.username);
      send(res, 200, Object.assign({ token }, publicUser(u)));
    });
  }

  const user = auth(req);
  if (!user) return send(res, 401, { error: '未登录或登录已过期' });

  /* 当前登录用户信息（刷新页面恢复权限用） */
  if (p === '/api/me' && req.method === 'GET') return send(res, 200, publicUser(user));

  /* 全量数据 + 版本号 */
  if (p === '/api/data' && req.method === 'GET') return send(res, 200, { data, revs });
  /* 版本号轮询 */
  if (p === '/api/revs' && req.method === 'GET') return send(res, 200, { revs });
  /* 保存单表（业务表按表单权限；系统表放行）
     【安全 P0·④】revision 乐观锁：请求体可带 expectedRev。
       - expectedRev 存在且 !== 当前 rev → 409 冲突（前端提示刷新，不做自动合并）
       - expectedRev 不存在 → 行为与旧版完全一致（向后兼容，防止漏改调用点报错） */
  if (p === '/api/save' && req.method === 'POST') {
    return readBody(req, b => {
      if (!b || !b.key || b.value === undefined) return send(res, 400, { error: '参数缺失' });
      if (!(b.key in data)) {
        /* 加固：DEFAULT_DATA 已注册的表自动补键（兼容线上旧 data.json 缺键场景），真未知表才 400 */
        if (Object.prototype.hasOwnProperty.call(DEFAULT_DATA, b.key)) {
          data[b.key] = JSON.parse(JSON.stringify(DEFAULT_DATA[b.key]));
          revs[b.key] = 0;
        } else {
          return send(res, 400, { error: '未知数据表: ' + b.key });
        }
      }
      if (!canWrite(user, b.key)) return send(res, 403, { error: '无该表单的编辑权限' });
      const cur = revs[b.key] || 0;
      if (b.expectedRev !== undefined && b.expectedRev !== null && Number(b.expectedRev) !== cur) {
        console.log('[冲突拦截] key=' + b.key + ' user=' + user.username + ' expectedRev=' + b.expectedRev + ' curRev=' + cur);
        return send(res, 409, { error: '数据已被他人修改', rev: cur });
      }
      data[b.key] = b.value;
      revs[b.key] = cur + 1;
      saveJson(DATA_FILE, data);
      send(res, 200, { ok: true, rev: revs[b.key] });
    });
  }

  /* 本人修改密码
     【安全 P0·② 修复】此路由原位于下方 `if (user.role !== 'admin')` 管理员闸门之后（存量 bug），
     导致非管理员员工调用 /api/change-pwd 恒返回 403「无权限」——员工根本无法自助改密，
     与本项「初始/重置密码必须能立即修改」的要求直接冲突。故上移至管理员闸门之前：
     本人改自己的密码不需要管理员权限（仍需校验原密码）。 */
  if (p === '/api/change-pwd' && req.method === 'POST') {
    return readBody(req, b => {
      if (!b || !b.old || !b.new) return send(res, 400, { error: '参数缺失' });
      if (user.hash !== hashPwd(b.old, user.salt)) return send(res, 400, { error: '原密码错误' });
      if (String(b.new).length < 6) return send(res, 400, { error: '新密码至少6位' });
      user.hash = hashPwd(b.new, user.salt);
      delete user.mustChangePwd;   /* 【安全 P0·②】改密成功 → 清除「待改密」标记 */
      saveJson(USERS_FILE, users);
      send(res, 200, { ok: true });
    });
  }

  /* ============ 员工管理（仅管理员） ============ */
  if (user.role !== 'admin') return send(res, 403, { error: '无权限' });

  /* 员工列表 */
  if (p === '/api/users' && req.method === 'GET') {
    return send(res, 200, { users: users.map(publicUser) });
  }
  /* 新增员工 */
  if (p === '/api/users' && req.method === 'POST') {
    return readBody(req, b => {
      if (!b || !b.username || !b.password) return send(res, 400, { error: '参数缺失' });
      const uname = String(b.username).trim();
      if (!/^[a-zA-Z0-9_]{2,20}$/.test(uname)) return send(res, 400, { error: '用户名需为2-20位字母数字下划线' });
      if (users.some(x => x.username === uname)) return send(res, 400, { error: '用户名已存在' });
      users.push(newUser(uname, b.name || uname, b.role === 'admin' ? 'admin' : 'staff', String(b.password), b.perms || JSON.parse(JSON.stringify(STAFF_PERMS))));
      saveJson(USERS_FILE, users);
      send(res, 200, { ok: true });
    });
  }
  /* 更新员工（角色/姓名/状态/权限/重置密码） */
  if (p === '/api/users' && req.method === 'PUT') {
    return readBody(req, b => {
      if (!b || !b.username) return send(res, 400, { error: '参数缺失' });
      const u = users.find(x => x.username === b.username);
      if (!u) return send(res, 404, { error: '用户不存在' });
      if (u.username === 'admin' && b.role && b.role !== 'admin') return send(res, 400, { error: '不能降级内置管理员' });
      if (b.name !== undefined) u.name = b.name;
      if (b.role !== undefined) u.role = b.role === 'admin' ? 'admin' : 'staff';
      if (b.status !== undefined) u.status = b.status === 'active' ? 'active' : 'disabled';
      if (b.perms !== undefined && typeof b.perms === 'object') u.perms = b.perms;
      if (b.password) u.hash = hashPwd(b.password, u.salt);
      saveJson(USERS_FILE, users);
      send(res, 200, { ok: true });
    });
  }
  /* 删除员工 */
  if (p === '/api/users' && req.method === 'DELETE') {
    const uname = url.searchParams.get('username');
    const u = users.find(x => x.username === uname);
    if (!u) return send(res, 404, { error: '用户不存在' });
    if (u.username === 'admin') return send(res, 400, { error: '不能删除内置管理员' });
    if (u.username === user.username) return send(res, 400, { error: '不能删除自己' });
    users = users.filter(x => x.username !== uname);
    saveJson(USERS_FILE, users);
    send(res, 200, { ok: true });
  }
  send(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log('prod-scheduler server listening on port ' + PORT);
});
setInterval(() => {
  const now = Date.now();
  tokens.forEach((v, k) => { if (now - parseInt(k.split('.')[1] || 0, 10) > TOKEN_TTL) tokens.delete(k); });
}, 3600 * 1000);
