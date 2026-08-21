#!/usr/bin/env node
/* ============================================================
   生产排单系统 - 轻量后端（零依赖 Node.js）
   功能：账号登录 / 数据存储(JSON文件) / 版本号实时同步
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
const DEFAULT_ADMIN = 'admin';
const DEFAULT_PWD = 'admin123';   // 首次启动生成，登录后请尽快在系统外修改 users.json

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

/* 数据与版本号 */
let data = load(DATA_FILE, null);
if (!data) { data = JSON.parse(JSON.stringify(DEFAULT_DATA)); saveJson(DATA_FILE, data); }
Object.keys(DEFAULT_DATA).forEach(k => { if (data[k] === undefined) data[k] = DEFAULT_DATA[k]; });
let revs = {};
Object.keys(DATA_FILE ? data : {}).forEach(k => revs[k] = 0);

/* 用户 */
let users = load(USERS_FILE, null);
if (!users) {
  const salt = crypto.randomBytes(16).toString('hex');
  users = [{ username: DEFAULT_ADMIN, salt: salt, hash: hashPwd(DEFAULT_PWD, salt), role: 'admin' }];
  saveJson(USERS_FILE, users);
}

/* 会话 */
const tokens = new Map();   // token -> username
const TOKEN_TTL = 7 * 24 * 3600 * 1000;   // 7 天

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
  return users.find(u => u.username === uname) || null;
}
function cleanupTokens() {
  const now = Date.now();
  tokens.forEach((v, k) => { if (!v || now - parseInt(k.split('.')[1] || 0, 10) > TOKEN_TTL) tokens.delete(k); });
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
      const token = crypto.randomBytes(24).toString('hex') + '.' + Date.now();
      tokens.set(token, u.username);
      send(res, 200, { token, username: u.username, role: u.role });
    });
  }

  /* 需要登录的接口 */
  const user = auth(req);
  if (!user) return send(res, 401, { error: '未登录或登录已过期' });

  /* 全量数据 + 版本号（首次加载用） */
  if (p === '/api/data' && req.method === 'GET') {
    return send(res, 200, { data, revs });
  }
  /* 版本号（轮询用，轻量） */
  if (p === '/api/revs' && req.method === 'GET') {
    return send(res, 200, { revs });
  }
  /* 保存单表 */
  if (p === '/api/save' && req.method === 'POST') {
    return readBody(req, b => {
      if (!b || !b.key || b.value === undefined) return send(res, 400, { error: '参数缺失' });
      if (!(b.key in data)) return send(res, 400, { error: '未知数据表: ' + b.key });
      data[b.key] = b.value;
      revs[b.key] = (revs[b.key] || 0) + 1;
      saveJson(DATA_FILE, data);
      send(res, 200, { ok: true, rev: revs[b.key] });
    });
  }
  send(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log('prod-scheduler server listening on port ' + PORT);
});
setInterval(cleanupTokens, 3600 * 1000);
