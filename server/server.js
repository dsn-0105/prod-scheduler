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
/* 【P1·T02 测试/演练接缝】数据与用户文件路径支持环境变量覆盖（默认值完全不变，与既有 PORT / PROD_INIT_PWD 同风格）。
   用途：测试在隔离临时目录内加载本模块，确保不读不写真实 server/data.json · server/users.json；
        运维亦可在拷贝目录内做隔离演练。生产环境未设置这两个变量时行为与改造前逐字节一致。 */
const DATA_FILE = process.env.PROD_DATA_FILE || path.join(__dirname, 'data.json');
const USERS_FILE = process.env.PROD_USERS_FILE || path.join(__dirname, 'users.json');

/* 【P1·T02 常量】（设计 §8：常量单一来源）
   MAX_OPS  = POST /api/tx 单请求最多提交的数据表数
   LOG_MAX  = logs 上限，与前端 js/logs.js `if(logs.length>500) logs=logs.slice(0,500)` 对齐 */
const MAX_OPS = 20;
const LOG_MAX = 500;

/* 【安全 P0·③】是否拒绝 URL query 形式的 token（默认关闭=保留兜底）。
   背景：token 走 query 会进入 nginx access log、浏览器历史、Referer 头，属泄露面。
   现状：前端已全部改为 Authorization 请求头（.123），但旧标签页/未刷新客户端仍可能带 query。
   关闭时机：前端新版全量上线并稳定 ≥1 周、确认服务端日志中 query token 请求归零后，
   在 systemd 环境变量里设 DEPRECATE_QUERY_TOKEN=1 即可硬关闭兜底。 */
const DEPRECATE_QUERY_TOKEN = process.env.DEPRECATE_QUERY_TOKEN === '1';

const DEFAULT_DATA = {
  products: [], orders: [], deliveries: [], productionPlans: [], productionReports: [], processTemplates: [],
  logs: [], fields: null, meta: { seq: 0 },
  /* 【build .152】tblLayout 形状升级：v1 扁平（tblLayout[模块]={order,widths}）→ v2 分片
     { v:2, def:{模块:{order,widths}}, u:{用户名:{模块:{order,widths}}} }：
       · def = 全局初始布局（迁移时把原 v1 扁平内容逐字搬入）
       · u   = 按登录账号分片，u[username] 整体就是一份 v1 形状的扁平布局
     旧值仍可被 normalizeLayout() 幂等归一，前端永远只看到 v2。 */
  fieldsAudit: 'audited', fieldsDraft: null, tblLayout: { v: 2, def: {}, u: {} },
  /* 【build .155】全局展示偏好（**全公司共用一份，仅管理员可写**）。
     首个消费方 = 产品主数据「默认排序」{sort:{product:{key,dir}}}；库存订单列表按该排序派生的
     「产品座次」排（见 index.html sortInvRowsByProdRank）。
     与 tblLayout 的分工：tblLayout 是**按账号分片**的个人列序/列宽，本表是**全局唯一**的管理态配置，
     故不复用 tblLayout（否则「重置我的列布局」会深拷贝 def 把默认排序一起冻结进个人分片）。
     空对象 = 未配置 ⇒ 前端一律回落到各项既有默认行为（零回归）。 */
  uiDefaults: {},
  transfers: []
};

/* 业务数据表（受按表单写权限控制）；其余为系统 key（登录用户均可写）。
   .122：日排产模块（备货 dailyPlans/包装 dailyPkgs 表）整体移除——dailyPlans 仅余为排产计划页的权限键（见 STAFF_PERMS），不再是数据表 */
const BIZ_KEYS = ['products', 'orders', 'deliveries', 'productionPlans', 'processTemplates', 'fields'];
/* 系统键清单（保留作分类参考）。
   【P1·T02 变更】canWrite 起**不再对 SYSTEM_KEYS 一律放行**——transfers / productionReports / logs
   已按设计 §5.1 逐键收紧（原实现「任意登录用户可整表覆盖调拨台账」是线上实测到的真实越权）。
   本常量保留仅为「键分类」参考，判定逻辑见下方 canWrite 的 switch。 */
const SYSTEM_KEYS = ['logs', 'meta', 'tblLayout', 'fieldsAudit', 'fieldsDraft', 'transfers', 'productionReports', 'uiDefaults'];

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

/* 【build .152】启动期对 tblLayout 归一并落盘（幂等）：
   线上存量 data.json 的 tblLayout 是 v1 扁平（全公司共用一份）→ 逐字搬进 def 作为所有人的初始布局，
   u 置空（迁移前后各账号看到的排版不变）。已是 v2 时 normalizeLayout 原样返回、无需二次落盘。 */
(function migrateTblLayoutAtBoot() {
  const before = JSON.stringify(data.tblLayout);
  data.tblLayout = normalizeLayout(data.tblLayout);
  if (JSON.stringify(data.tblLayout) !== before) {
    saveJson(DATA_FILE, data);
    console.log('[.152 迁移] data.tblLayout 已归一为 v2（原全局布局 → def 初始布局，u 置空）');
  }
})();

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
/* ============================================================
   【P1·T02】权限判定单一入口 canWrite(user, key, ctx)（设计 §5.1）
   ------------------------------------------------------------
   ctx = { value, txOps, data }：
     · value 本次要写入的值（products / logs 守卫需要对比新旧值）
     · data  数据对象（缺省＝模块级 data；便于单测注入）
   必须被 /api/save 与 /api/tx **同时复用**，否则 /api/save 路径上的 products 投影调用点仍会 403。
   改造依据：原实现 `if (SYSTEM_KEYS.indexOf(key) >= 0) return true` 使任意登录用户可整表覆盖
   transfers / productionReports / logs（线上实测 zongjingli 越权 200）；且 productionPlans 误查
   perms['productionPlans']（线上 4 账号全无该键）而前端表单键是 dailyPlans → staff 报工/库存保存
   静默 403（D1 缺陷，本轮修复）。
   目标：只拦「越权的直接 API 写」，不拦任何「前端合法的业务动作」。
   ============================================================ */
function canWrite(user, key, ctx) {
  if (!user) return false;
  if (user.role === 'admin') return true;                 /* admin 恒放行 */
  const p = user.perms || {};
  const d = (ctx && ctx.data) || data;
  const nv = ctx ? ctx.value : undefined;
  switch (key) {
    /* 订单主表：销售/库存任一权限点（.118 拆分口径；保留旧 orders 键兼容） */
    case 'orders':
      return p.saleOrders === true || p.invOrders === true || p.orders === true;
    /* 调拨台账：写入方＝4 个调拨执行器（需订单权限）＋冲销（需 transfers）→ 并集
       （关闭 zongjingli 越权：其 perms 无 transfers/saleOrders/invOrders/orders → 403） */
    case 'transfers':
      return p.transfers === true || p.saleOrders === true || p.invOrders === true || p.orders === true;
    /* 排产计划／生产报表：前端表单键 prodPlan → 权限键 dailyPlans；并集 productionPlans 为兼容项
       （D1 修复关键：线上 pmc/chejian 的 dailyPlans=true 而 productionPlans 键从未配置） */
    case 'productionPlans':
    case 'productionReports':
      return p.productionPlans === true || p.dailyPlans === true;
    /* 操作日志：仅允许「追加」；缩减/清空仅 admin（见 logsAppendOK） */
    case 'logs':
      return logsAppendOK(d.logs || [], nv);
    /* 产品主数据（方案 α′·字段级纯投影守卫）：有 products 权限＝全字段可写；
       否则仅当持相关触发权限且本次写入「只变 stock」时放行（修好 D1 且不放大产品主数据写面） */
    case 'products': {
      if (p.products === true) return true;
      const trig = p.invOrders === true || p.saleOrders === true || p.orders === true || p.dailyPlans === true;
      if (!trig) return false;                            /* 零相关权限者不得触碰 products */
      return isPureStockProjection(d.products || [], nv);
    }
    /* 【D3·用户已拍板本轮不动】偏好/管理态数据保持放行 */
    case 'meta':
    case 'tblLayout':
    case 'fieldsAudit':
    case 'fieldsDraft':
      return true;
    /* 【build .155】全局展示偏好（产品主数据默认排序等）：**仅管理员可写**。
       admin 已在函数首行 `if (user.role === 'admin') return true` 放行，走到本例即非 admin
       ⇒ 一律 false。这是「只能由管理员调整」的**服务端硬闸**——前端按钮隐藏 + 函数级
       needSysAdmin() 只是体验层，F12 直调 /api/save 或 /api/tx 也必须被挡在此处。
       读路径不受限：/api/data 全量下发，前端只读消费（普通账号照常按管理员配的顺序显示）。 */
    case 'uiDefaults':
      return false;
    default:
      return p[key] === true;                             /* deliveries / processTemplates / fields */
  }
}

/* 日志记录等价判定（口径同设计 §5.2：time/action/target/detail/field）
   【build .125】user 纳入比较：logs 表新增「操作者」字段后，若此判定漏掉 user，
   则「整表把 user 改掉」的形状会被判为「逐条相同」而放行（等于该字段可被任意改写而不被察觉）。
   两缺省都以 '' 归并：历史条目无 user（undefined）与空串等价，不影响既有 append 白名单形状。 */
function sameLog(a, b) {
  if (!a || !b) return false;
  return a.time === b.time && a.action === b.action && a.target === b.target
    && a.detail === b.detail && (a.field || '') === (b.field || '')
    && (a.user || '') === (b.user || '');
}

/* logs「只追加」白名单（设计 §5.2.2 **v2**，最终冻结版）：允许前插若干条（触发上限时旧尾滑出）
   与等长同容；拒绝净缩减（未触顶）、清空、伪值覆盖，以及触顶后「原地替换最新 1 条」。
   ⚠️ 与设计 v1 伪代码的两处刻意差异（v1 报备项②已被 v2 决议取代）：
     ① 【硬化】v1 伪代码 `for(p=0..neu.length)` 在 p===neu.length 时 tail=[]、expect=[] 必然命中，
        会把「任意长度恰为 LOG_MAX 的数组」整表放行。此处跳过空尾部。
     ② 【删除 KR1 等价分支】v1 曾对「恰触顶且除首条外逐条相同」显式放行，理由是与「append 换出最旧」
        不可区分。v2 复核推翻该理由：合法触顶追加形状=`[新, ...old.slice(0,499)]`，即
        `neu[1..499]===old[0..498]`（丢最旧 old[499]），已由主循环 p=1 命中并放行；而该分支放行的形状是
        `neu[1..499]===old[1..499]`（丢最新 old[0]），**不存在产生它的合法客户端路径**（logOp 只有
        unshift+slice(0,500) 一种写法）。故按 §9.3 决议删除该分支：非 admin 无法伪造「最新 1 条」，
        对合法路径零功能代价。回归用例：tests/server.canwrite.test.js G20-5。 */
function logsAppendOK(oldArr, neu) {
  if (!Array.isArray(neu)) return false;
  if (neu.length > LOG_MAX) return false;
  const old = Array.isArray(oldArr) ? oldArr : [];
  if (old.length === 0) return true;                                  /* 首次写入：放行 */
  if (neu.length < old.length && old.length < LOG_MAX) return false;   /* 未触顶不得净缩减/清空 */
  for (let p = 0; p <= neu.length; p++) {
    const tail = neu.slice(p);
    const expect = old.slice(0, Math.min(old.length, LOG_MAX - p));
    if (tail.length !== expect.length) continue;
    if (tail.length === 0) continue;                                  /* 【硬化】跳过空尾部命中 */
    let ok = true;
    for (let i = 0; i < tail.length; i++) { if (!sameLog(tail[i], expect[i])) { ok = false; break; } }
    if (ok) return true;
  }
  return false;
}

/* 深度等价（对象键序无关）；用于 products 投影守卫的字段级比对 */
function deepEq(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const aArr = Array.isArray(a), bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) { if (!deepEq(a[i], b[i])) return false; }
    return true;
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    const k = ka[i];
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEq(a[k], b[k])) return false;
  }
  return true;
}

/* 方案 α′：纯库存投影守卫（设计 §5.1）。
   语义：新旧 products 必须「行数相同 + 逐行 id 一一对应相同 + 除 stock 外逐字段等价」；
        增行/删行/换 id/改其它任何字段/增删字段 → false。
   stock 是派生投影（= Σ 库存订单已交付）：任何后续库存订单/调拨/报工变更或页面重载
   （initApp→syncStockFromInvOrders）都会全量重算覆盖它，且 stock 不参与任何鉴权 → 允许其变化。
   行序即位置（逐行对齐）：products 的重排在本系统不会发生，重排一律拒绝（更严格，不放宽写面）。 */
function isPureStockProjection(oldArr, neu) {
  if (!Array.isArray(oldArr) || !Array.isArray(neu)) return false;
  if (oldArr.length !== neu.length) return false;                     /* 增/删行 → 拒 */
  for (let i = 0; i < oldArr.length; i++) {
    const a = oldArr[i], b = neu[i];
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    if (a.id !== b.id) return false;                                  /* 逐行 id 必须一一对应 */
    const ka = Object.keys(a), kb = Object.keys(b);
    for (let j = 0; j < ka.length; j++) {
      const k = ka[j];
      if (k === 'stock') continue;
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;  /* 删字段 → 拒 */
      if (!deepEq(a[k], b[k])) return false;                          /* 非 stock 字段变化 → 拒 */
    }
    for (let j = 0; j < kb.length; j++) {
      if (kb[j] === 'stock') continue;
      if (!Object.prototype.hasOwnProperty.call(a, kb[j])) return false; /* 新增字段 → 拒 */
    }
  }
  return true;
}

/* ============================================================
   【P1·T02】POST /api/tx 的纯净核心（不触碰 res，便于单测注入）
   ------------------------------------------------------------
   handleTx(data, revs, user, body, canWriteFn, saveJsonFn, defaultData) → { code, body }
   执行顺序（设计 §3.2）：①鉴权 ②校验 ops ③未知键 ④重复键 ⑤逐键 canWrite ⑥rev 全量校验
                        ⑦应用（快照→改内存→单次落盘→失败回滚）⑧返回
   语义铁律：400 / 403 / 409 / 500 一律「一字不写」——既不落盘，也不改内存 data / revs。
   原子性论据：
     A 校验全在应用之前 → 任一失败均未触内存、未触盘；
     B 应用段为**同步代码**（saveJson 是同步 fs），Node 单线程下无并发交错；
     C saveJson 抛错时按快照回滚 data / revs，使内存与盘保持一致。
   与 /api/save 的关系：/api/tx 是**增量通道**，/api/save 行为完全不变。
   ============================================================ */
function handleTx(data, revs, user, body, canWriteFn, saveJsonFn, defaultData) {
  /* ① 鉴权（路由已先行拦截，此处兜底，保证核心函数自洽可测） */
  if (!user) return { code: 401, body: { error: '未登录或登录已过期' } };
  /* ② 校验 ops */
  if (!body || !Array.isArray(body.ops) || body.ops.length === 0) return { code: 400, body: { error: '参数缺失' } };
  if (body.ops.length > MAX_OPS) return { code: 400, body: { error: '单次事务最多 ' + MAX_OPS + ' 个数据表' } };
  const DD = defaultData || DEFAULT_DATA;
  const ops = body.ops;
  /* ③④ 未知键 + 重复键（与 /api/save 一致：DEFAULT_DATA 已注册的表自动补键，真未知表 400）
     注意：自动补键推迟到 ⑦ 应用段执行 → 保证 400/403/409 失败路径连内存都不动。 */
  const seen = Object.create(null);
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (!op || typeof op !== 'object' || typeof op.key !== 'string' || op.key === '' || op.value === undefined) {
      return { code: 400, body: { error: '参数缺失' } };
    }
    if (!Object.prototype.hasOwnProperty.call(data, op.key) && !Object.prototype.hasOwnProperty.call(DD, op.key)) {
      return { code: 400, body: { error: '未知数据表: ' + op.key } };
    }
    if (seen[op.key]) return { code: 400, body: { error: '重复的表键: ' + op.key } };
    seen[op.key] = true;
  }
  /* ⑤ 权限：逐键过 canWrite（单一判定点，与 /api/save 共用；ctx.data 供 products/logs 守卫读旧值） */
  for (let i = 0; i < ops.length; i++) {
    if (!canWriteFn(user, ops[i].key, { value: ops[i].value, txOps: ops, data })) {
      return { code: 403, body: { error: '无该表单的编辑权限', key: ops[i].key } };
    }
  }
  /* ⑥ rev 全量校验：任一冲突即整体 409（此时未写任何东西） */
  const conflicts = [];
  for (let i = 0; i < ops.length; i++) {
    const cur = revs[ops[i].key] || 0;
    if (ops[i].expectedRev !== undefined && ops[i].expectedRev !== null && Number(ops[i].expectedRev) !== cur) {
      conflicts.push({ key: ops[i].key, expectedRev: ops[i].expectedRev, curRev: cur });
    }
  }
  if (conflicts.length) return { code: 409, body: { error: '数据已被他人修改', conflicts } };
  /* ⑦ 应用（原子区）：快照 → 改内存 → 单次 saveJson → 失败回滚 */
  const snapshot = ops.map(op => ({
    key: op.key,
    has: Object.prototype.hasOwnProperty.call(data, op.key),
    old: data[op.key],
    oldRev: revs[op.key]
  }));
  const newRevs = {};
  try {
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (!Object.prototype.hasOwnProperty.call(data, op.key)) {
        data[op.key] = JSON.parse(JSON.stringify(DD[op.key]));   /* 自动补键（线上旧 data.json 缺键兼容） */
        revs[op.key] = 0;
      }
      data[op.key] = op.value;
      revs[op.key] = (revs[op.key] || 0) + 1;
      newRevs[op.key] = revs[op.key];
    }
    saveJsonFn(DATA_FILE, data);        /* 单次 tmp 写入 + renameSync → 落盘原子 */
  } catch (e) {
    for (let i = 0; i < snapshot.length; i++) {
      const s = snapshot[i];
      if (s.has) { data[s.key] = s.old; revs[s.key] = s.oldRev; }
      else { delete data[s.key]; delete revs[s.key]; }
    }
    console.log('[tx 回滚] saveJson 失败（key=' + ops.map(o => o.key).join(',') + '）：' + (e && e.message));
    return { code: 500, body: { error: '持久化失败，已回滚' } };
  }
  /* ⑧ 成功 */
  return { code: 200, body: { ok: true, revs: newRevs } };
}

/* ============================================================
   【build .152】列布局（tblLayout）按账号隔离
   ------------------------------------------------------------
   v2 形状：{ v:2, def:{模块:{order,widths}}, u:{用户名:{模块:{order,widths}}} }
     · def = 全局初始布局（迁移时把原 v1 扁平内容逐字搬入，所有人共用）
     · u   = 按登录账号的用户名分片；u[username] 整体即一份 v1 形状的扁平布局
   设计动因：v1 全公司共用一份、并发拖列撞 /api/save 的 expectedRev 乐观锁报 409 且布局不落库。
   本中心函数**不走 expectedRev**（个人偏好分片天然无冲突），故新增独立端点 /api/layout。
   ============================================================ */

/* 「合法布局映射」判定：必须是**对象且不是数组** —— 布局是「模块 → {order,widths}」的映射，
   空对象 `{}` 合法（＝尚无任何已存布局），数组 / 标量 / null 一律非法。
   ⚠ 与 handleLayout 内 `L.def` / `L.u` 的守卫**同口径**（都拒绝数组）：否则 `def: []` 会经前端
     applyServerLayout 落到内存态 tblLayout 上，使 layoutOf() 在**数组实例**上挂属性；且
     normalizeLayout 的快通道也会把非法形状原样放行，前后端口径不自洽。 */
function isLayoutMap(v) {
  return !!(v && typeof v === 'object' && !Array.isArray(v));
}

/* 形状归一（幂等）：
   · v2 → **原样返回同一引用**（幂等最强形态）；但顶层 `def` / `u` 及 **`u` 的每个分片**非法时
     **就地净化** —— /api/save 对 tblLayout 仍放行任意值（用户拍板不防旧标签页），故 v2 也可能
     被伪造成非法形状，这里守住对外契约：「`def` 必为合法映射；`u` 的每个分片也必为合法映射」。
   · 否则（v1 扁平 / 空 / 标量 / 数组）→ 包成 v2，原内容**逐字**进 def（非法者归空）、u 置空。
   幂等等价：normalizeLayout(normalizeLayout(x)) 与 normalizeLayout(x) 深度相等。 */
function normalizeLayout(v) {
  if (v && typeof v === 'object' && v.v === 2) {
    if (!isLayoutMap(v.def)) v.def = {};
    if (isLayoutMap(v.u)) {
      /* 逐分片净化：非法分片**用 delete 删除该键**，不可归 `{}` ——
         `{}` 本身是「合法布局映射」，归空会被前端当成「该账号自己的（空）布局」⇒ 该账号看到的是
         **系统默认列序**；删除则表示「无有效自定义布局」⇒ 前端正确**回退到 def（初始布局）**。
         二者用户可见结果不同，故必须 delete。 */
      Object.keys(v.u).forEach(function (k) { if (!isLayoutMap(v.u[k])) delete v.u[k]; });
    } else {
      v.u = {};
    }
    return v;
  }
  return { v: 2, def: isLayoutMap(v) ? v : {}, u: {} };
}

/* ============================================================
   POST /api/layout 的纯净核心（不触碰 res，便于单测注入）
   handleLayout(data, revs, user, body, saveJsonFn) → { code, body }
     · !user                       → 401
     · body.action === 'resetAll'  → 仅 admin 可执行；语义 = data.tblLayout.u = {}
                                     （只清所有人的个人分片，绝不动 def）
     · body.action === 'reset'     → 删除自己的分片 delete data.tblLayout.u[user.username]
     · 默认（保存本人分片）        → body.layout 必须是对象 → data.tblLayout.u[user.username] = body.layout
   校验前置：400/403/401 一律**不触碰内存 data/revs、不落盘**（对齐 handleTx 的「一字不写」）。
   saveJsonFn 由调用方闭包注入（生产传 () => saveJson(DATA_FILE, data)）。
   ============================================================ */
function handleLayout(data, revs, user, body, saveJsonFn) {
  /* ① 鉴权（路由已先行拦截，此处兜底，保证核心函数自洽可测） */
  if (!user) return { code: 401, body: { error: '未登录或登录已过期' } };
  const action = body && body.action;
  /* ② 校验（失败路径不改内存、不落盘） */
  if (action === 'resetAll') {
    if (user.role !== 'admin') return { code: 403, body: { error: '无权限' } };
  } else if (action !== 'reset') {
    const lv = body ? body.layout : undefined;
    if (!lv || typeof lv !== 'object' || Array.isArray(lv)) return { code: 400, body: { error: '参数缺失' } };
  }
  /* ③ 应用（归一 → 写分片 → 单次落盘） */
  const L = normalizeLayout(data.tblLayout);
  data.tblLayout = L;
  if (!L.def || typeof L.def !== 'object' || Array.isArray(L.def)) L.def = {};
  if (!L.u || typeof L.u !== 'object' || Array.isArray(L.u)) L.u = {};
  if (action === 'resetAll') L.u = {};
  else if (action === 'reset') delete L.u[user.username];
  else L.u[user.username] = body.layout;
  saveJsonFn(DATA_FILE, data);
  revs.tblLayout = (revs.tblLayout || 0) + 1;
  /* ④ 成功 */
  return { code: 200, body: { ok: true, rev: revs.tblLayout, layout: data.tblLayout } };
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

/* ============================================================
   【P1·T02】运维入口：只读权限审计 CLI（回归护栏）
   用法：node server.js --audit-perms
   目的：打印各账号 username / role / perms，并给出「服务端 canWrite 实际判定」，
        用于回归确认 staff 报工/库存保存不再被误拦（D1），
        避免重演 .122 遗留的「staff 存 productionPlans 静默 403 却无人发现」。
   约束：**只读**——不打印 hash/salt、不修改任何数据、不启动 HTTP 服务。
   退出：使用 process.exitCode + return（而非 process.exit），避免管道下 stdout 被截断。
   ============================================================ */
if (process.argv[2] === '--audit-perms') {
  console.log('==== 权限审计（只读 · 不修改数据 · 不启动服务） ====');
  console.log('users 文件: ' + USERS_FILE);
  console.log('data  文件: ' + DATA_FILE);
  console.log('');
  if (!Array.isArray(users) || users.length === 0) {
    console.log('（无用户）');
    process.exitCode = 0;
    return;
  }
  /* 判定探针表的选取：用「当前数据的等值写」探针，
     products 探测「纯 stock 投影写」是否被放行（α′），logs 探测「追加」是否被放行。 */
  const PROBE = ['orders', 'transfers', 'productionPlans', 'productionReports', 'products', 'logs', 'deliveries', 'processTemplates', 'fields'];
  users.forEach((u, i) => {
    const perms = (u && u.perms) || {};
    const ks = Object.keys(perms).sort();
    console.log('[' + (i + 1) + '] ' + u.username + '  role=' + u.role + '  status=' + (u.status || 'active'));
    console.log('    perms = ' + (ks.length
      ? '{' + ks.map(k => JSON.stringify(k) + ':' + JSON.stringify(perms[k])).join(', ') + '}'
      : '{}'));
    const verdict = PROBE.map(k => {
      let probeValue;
      if (k === 'products') probeValue = Array.isArray(data.products) ? data.products.map(p => Object.assign({}, p)) : [];
      else probeValue = data[k];
      return k + '=' + (canWrite(u, k, { value: probeValue, data }) ? 'ALLOW' : 'DENY');
    });
    console.log('    canWrite(等值写探针) = ' + verdict.join(' '));
    console.log('');
  });
  console.log('说明：');
  console.log('  · admin 恒 ALLOW；staff 的 products=ALLOW 仅表示「纯 stock 投影写」被放行（α′ 守卫），改产品主数据仍需 perms.products=true。');
  console.log('  · logs=ALLOW 仅表示「追加」被放行；缩减/清空仅 admin。');
  console.log('  · 期望基线（线上真值）：pmc/chejian 的 productionPlans、productionReports、products 应为 ALLOW（D1 修复）；');
  console.log('    zongjingli 的 transfers、productionReports 应为 DENY（越权关闭）。');
  process.exitCode = 0;
  return;
}

function handleRequest(req, res) {
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

  /* 全量数据 + 版本号
     【build .152】返回前对 tblLayout 归一，保证前端**永远只看到 v2**（不落盘，幂等，不改变 revs）。 */
  if (p === '/api/data' && req.method === 'GET') {
    data.tblLayout = normalizeLayout(data.tblLayout);
    return send(res, 200, { data, revs });
  }
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
      /* 【P1·T02】canWrite 改为带 ctx 的新签名——与 /api/tx 复用同一判定点（单一入口）。
         ctx.value = 本次要写入的值（products 纯投影守卫 α′ / logs 追加白名单需要对比新旧值）；
         ctx.data  = 模块级 data（越权判定依据的基线快照）。 */
      if (!canWrite(user, b.key, { value: b.value, data })) return send(res, 403, { error: '无该表单的编辑权限' });
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

  /* ============ 多表原子事务 POST /api/tx（P1·T02 · 设计 §3）============
     一次请求提交 1..MAX_OPS 个数据表：全成功或全不变（400/403/409/500 一律「一字不写」）。
     与 /api/save 复用同一 canWrite 判定点；乐观锁 expectedRev 复用 revs[key]。
     失败码：400 参数/未知表/重复键 · 403 无权限 · 409 rev 冲突 · 500 落盘失败（已回滚内存）。
     纯净核心为 handleTx()（可单测注入），此处仅做 HTTP 适配。 */
  if (p === '/api/tx' && req.method === 'POST') {
    return readBody(req, b => {
      const r = handleTx(data, revs, user, b, canWrite, saveJson, DEFAULT_DATA);
      send(res, r.code, r.body);
    });
  }

  /* ============ 列布局分片写端点 POST /api/layout（build .152 新增）============
     与 /api/save、/api/tx 并列，位于统一鉴权之后。语义见 handleLayout：
       · 默认 {layout}          → 只写「本人」分片 data.tblLayout.u[user.username]
       · {action:'reset'}       → 只删本人分片
       · {action:'resetAll'}    → 仅 admin，清空所有人的分片（def 不动）
     **刻意不走 expectedRev 乐观锁**：个人偏好分片互不干扰，这正是要消除拖列 409 的原因。
     /api/save {key:'tblLayout'} 保持放行不变（用户已拍板旧标签页整表覆盖不做防御）。 */
  if (p === '/api/layout' && req.method === 'POST') {
    return readBody(req, b => {
      const r = handleLayout(data, revs, user, b, () => saveJson(DATA_FILE, data));
      send(res, r.code, r.body);
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
}
const server = http.createServer(handleRequest);

/* 【P1·T02】仅在「直接运行 node server.js」时监听端口与启后台清理。
   被测试 require 时（require.main !== module）不启服、不占端口、不挂 setInterval——
   这样单测可直接 require 本模块拿到 handleTx / canWrite 等纯净核心，且不泄漏句柄。 */
if (require.main === module) {
  server.listen(PORT, () => {
    console.log('prod-scheduler server listening on port ' + PORT);
  });
  setInterval(() => {
    const now = Date.now();
    tokens.forEach((v, k) => { if (now - parseInt(k.split('.')[1] || 0, 10) > TOKEN_TTL) tokens.delete(k); });
  }, 3600 * 1000);
}

/* 【P1·T02】测试/复用导出：/api/tx 纯净核心 + 权限判定 + HTTP 处理器 + 常量。
   不影响 `node server.js` 启动（上方 require.main 守卫保证）。 */
module.exports = {
  handleTx,                       /* (data, revs, user, body, canWriteFn, saveJsonFn, defaultData) → {code, body} */
  handleLayout,                   /* (data, revs, user, body, saveJsonFn) → {code, body}；build .152 列布局分片端点核心 */
  normalizeLayout,                /* (v) → {v:2, def, u}；幂等形状归一（v1 扁平 → v2 分片） */
  isLayoutMap,                    /* (v) → boolean；合法「布局映射」判定（对象且非数组；{} 合法＝尚无已存布局） */
  canWrite,                       /* (user, key, ctx) → boolean；/api/save 与 /api/tx 共用 */
  logsAppendOK,                   /* (oldArr, neu) → boolean；logs「只追加」白名单 */
  isPureStockProjection,          /* (oldArr, neu) → boolean；products 纯 stock 投影守卫 α′ */
  deepEq,                         /* (a, b) → boolean；键序无关深度等价 */
  handleRequest,                  /* (req, res) → void；HTTP 处理器（供端到端测试自建 server） */
  auth, publicUser,
  DEFAULT_DATA, MAX_OPS, LOG_MAX
};
