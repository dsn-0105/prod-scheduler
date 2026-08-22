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

const DEFAULT_DATA = {
  products: [], orders: [], dailyPlans: [], dailyPkgs: [],
  deliveries: [], logs: [], fields: null, meta: { seq: 0 },
  fieldsAudit: 'audited', fieldsDraft: null, tblLayout: {}
};

/* 业务数据表（受按表单写权限控制）；其余为系统 key（登录用户均可写） */
const BIZ_KEYS = ['products', 'orders', 'dailyPlans', 'dailyPkgs', 'deliveries', 'fields'];
const SYSTEM_KEYS = ['logs', 'meta', 'tblLayout', 'fieldsAudit', 'fieldsDraft', 'transfers'];

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
  return { username, name, role, status: 'active', salt, hash: hashPwd(pwd, salt), perms: perms || {} };
}

/* 数据 */
let data = load(DATA_FILE, null);
if (!data) { data = JSON.parse(JSON.stringify(DEFAULT_DATA)); saveJson(DATA_FILE, data); }
Object.keys(DEFAULT_DATA).forEach(k => { if (data[k] === undefined) data[k] = DEFAULT_DATA[k]; });
let revs = {};
Object.keys(data).forEach(k => revs[k] = 0);

/* 用户（兼容旧格式：补 name/status/perms） */
const STAFF_PERMS = { products: false, orders: false, dailyPlans: false, dailyPkgs: false, deliveries: false, fields: false };
let users = load(USERS_FILE, null);
if (!users || !Array.isArray(users)) {
  users = [
    newUser('admin', '管理员', 'admin', 'admin123', {}),
    newUser('pmc', 'PMC', 'staff', '123456', JSON.parse(JSON.stringify(STAFF_PERMS))),
    newUser('chejian', '车间', 'staff', '123456', JSON.parse(JSON.stringify(STAFF_PERMS))),
    newUser('zongjingli', '总经理', 'staff', '123456', JSON.parse(JSON.stringify(STAFF_PERMS)))
  ];
  saveJson(USERS_FILE, users);
} else {
  let changed = false;
  users.forEach(u => {
    if (u.name === undefined) { u.name = u.username; changed = true; }
    if (u.status === undefined) { u.status = 'active'; changed = true; }
    if (u.perms === undefined) { u.perms = u.role === 'admin' ? {} : JSON.parse(JSON.stringify(STAFF_PERMS)); changed = true; }
    if (!u.salt || !u.hash) { const s = crypto.randomBytes(16).toString('hex'); u.salt = s; u.hash = hashPwd('123456', s); changed = true; }
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
function auth(req) {
  const url = new URL(req.url, 'http://x');
  const token = url.searchParams.get('token');
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
  return !!(user.perms && user.perms[key] === true);
}
function publicUser(u) {
  return { username: u.username, name: u.name, role: u.role, status: u.status, perms: u.perms || {} };
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
  /* 保存单表（业务表按表单权限；系统表放行） */
  if (p === '/api/save' && req.method === 'POST') {
    return readBody(req, b => {
      if (!b || !b.key || b.value === undefined) return send(res, 400, { error: '参数缺失' });
      if (!(b.key in data)) return send(res, 400, { error: '未知数据表: ' + b.key });
      if (!canWrite(user, b.key)) return send(res, 403, { error: '无该表单的编辑权限' });
      data[b.key] = b.value;
      revs[b.key] = (revs[b.key] || 0) + 1;
      saveJson(DATA_FILE, data);
      send(res, 200, { ok: true, rev: revs[b.key] });
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
  /* 本人修改密码 */
  if (p === '/api/change-pwd' && req.method === 'POST') {
    return readBody(req, b => {
      if (!b || !b.old || !b.new) return send(res, 400, { error: '参数缺失' });
      if (user.hash !== hashPwd(b.old, user.salt)) return send(res, 400, { error: '原密码错误' });
      user.hash = hashPwd(b.new, user.salt);
      saveJson(USERS_FILE, users);
      send(res, 200, { ok: true });
    });
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
