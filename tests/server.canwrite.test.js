'use strict';
/* ============================================================
   P1 · T02 单元测试：canWrite 审计边界收紧（设计 §5.1 / §5.2）
   ------------------------------------------------------------
   覆盖黄金样例：
     G20  logs「只追加」白名单矩阵（§5.2 覆盖矩阵逐行）
     G21  products 字段级纯投影守卫 α′（仅 stock 变 / 改 name / 增删行 → 三态）
     G22  D1 修复回归（线上真值 perms 镜像：pmc / chejian / zongjingli / admin）
   另含：meta/tblLayout/fieldsAudit/fieldsDraft 保持放行（D3 不动）的守护断言。

   运行：node --test tests/server.canwrite.test.js
   边界：只测服务端纯函数判定；**不启动 HTTP 服务**（require.main 守卫）、
         **不读不写真实** server/data.json · server/users.json（路径经环境变量指向临时目录）。
   ============================================================ */
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
/* 临时目录放在仓库工作区内（Windows 下 Node 会把 '/tmp' 解析成 D:\tmp 导致 ENOENT） */
const TMP = fs.mkdtempSync(path.join(ROOT, '.p1tmp-'));
process.env.PROD_DATA_FILE = path.join(TMP, 'data.json');
process.env.PROD_USERS_FILE = path.join(TMP, 'users.json');
/* 写一个干净的用户文件（仅 admin，避免启动期迁移向临时文件写入 / 打印初始化横幅） */
fs.writeFileSync(process.env.PROD_USERS_FILE, JSON.stringify([
  { username: 'admin', name: '管理员', role: 'admin', status: 'active', salt: 's0', hash: 'h0', perms: {} }
]));

const srv = require(path.join(ROOT, 'server', 'server.js'));
const { canWrite, logsAppendOK, isPureStockProjection } = srv;

after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

/* ---------- 线上真实 perms（设计 §5.3 真值表，主理人隔离环境实测） ---------- */
const TRUTH = {
  admin: { role: 'admin', perms: {} },
  pmc: { role: 'staff', perms: { products: false, saleOrders: true, invOrders: true, dailyPlans: true, deliveries: true, processTemplates: true, transfers: true } },
  chejian: { role: 'staff', perms: { products: false, dailyPlans: true, deliveries: true, processTemplates: true, transfers: true } },
  zongjingli: { role: 'staff', perms: { products: false, dailyPlans: false, deliveries: true, fields: true } }
};
function U(name) {
  const t = TRUTH[name];
  if (!t) throw new Error('未知账号: ' + name);
  return { username: name, name: name, role: t.role, status: 'active', perms: JSON.parse(JSON.stringify(t.perms)) };
}
function clone(x) { return JSON.parse(JSON.stringify(x)); }

/* ---------- products 夹具（字段覆盖前端全字段名） ---------- */
const PRODS = [
  { id: 'P1', name: '甲产品', spec: 'S1', model: 'M1', unit: '台', dailyCap: 10, stockMin: 0, stockMax: 99, processTplId: null, status: '启用', stock: 3 },
  { id: 'P2', name: '乙产品', spec: 'S2', model: 'M2', unit: '台', dailyCap: 5, stockMin: 1, stockMax: 50, processTplId: 'T1', status: '启用', stock: 0 }
];
function ctxData(products, logs) { return { products: products, logs: logs || [], orders: [], transfers: [], productionPlans: [], productionReports: [] }; }

/* ---------- logs 夹具 ---------- */
function mkLogs(n, prefix) {
  const a = [];
  for (let i = 0; i < n; i++) a.push({ time: 'T' + i, action: '新增', target: '订单', detail: prefix + '-' + i, field: '' });
  return a;
}
const LOG_A = { time: 'A', action: '新增', target: '订单', detail: 'a', field: '' };
const LOG_B = { time: 'B', action: '编辑', target: '订单', detail: 'b', field: '' };
const LOG_C = { time: 'C', action: '删除', target: '订单', detail: 'c', field: '' };
const LOG_D = { time: 'D', action: '导入', target: '订单', detail: 'd', field: '' };

/* ============================================================
   G20 · logs「只追加」白名单（设计 §5.2 覆盖矩阵逐行）
   ============================================================ */
test('G20-1 logsAppendOK：正常追加 / 等长同容 / 触顶滑窗 允许', () => {
  assert.strictEqual(logsAppendOK([LOG_A, LOG_B, LOG_C], [LOG_D, LOG_A, LOG_B, LOG_C]), true, '正常前插应允许');
  assert.strictEqual(logsAppendOK([LOG_A, LOG_B], [LOG_A, LOG_B]), true, '等长同容应允许');
  assert.strictEqual(logsAppendOK([LOG_A], [LOG_B, LOG_A]), true, '单条前插应允许');

  const old500 = mkLogs(500, 'old');
  const slide = [LOG_D].concat(old500.slice(0, 499));            /* 触顶：前插 1 条 + 旧尾滑出 */
  assert.strictEqual(logsAppendOK(old500, slide), true, '触顶滑窗应允许');
  assert.strictEqual(logsAppendOK(old500, clone(old500)), true, '触顶等长同容应允许');
});

test('G20-2 logsAppendOK：清空 / 截断头部 / 伪值覆盖 拒绝', () => {
  assert.strictEqual(logsAppendOK([LOG_A, LOG_B, LOG_C], []), false, '清空应拒绝');
  assert.strictEqual(logsAppendOK([LOG_A, LOG_B, LOG_C], [LOG_A]), false, '截断头部（净缩减）应拒绝');
  assert.strictEqual(logsAppendOK([LOG_A, LOG_B, LOG_C], [{ time: 'x', action: '新增', target: '订单', detail: 'x', field: '' },
                                                          { time: 'y', action: '新增', target: '订单', detail: 'y', field: '' },
                                                          { time: 'z', action: '新增', target: '订单', detail: 'z', field: '' }]), false, '伪值覆盖应拒绝');
  const tampered = { time: 'B', action: '编辑', target: '订单', detail: '被篡改', field: '' };
  assert.strictEqual(logsAppendOK([LOG_A, LOG_B, LOG_C], [LOG_A, tampered, LOG_C]), false, '同长度但中间条目被改应拒绝');
  assert.strictEqual(logsAppendOK([LOG_A, LOG_B, LOG_C], [LOG_A, LOG_B]), false, '未触顶净缩减应拒绝');
  const old500 = mkLogs(500, 'old');
  assert.strictEqual(logsAppendOK(old500, []), false, '触顶后清空亦应拒绝（仅 admin 可清空）');
  assert.strictEqual(logsAppendOK(old500, old500.slice(0, 400)), false, '触顶后大幅截断应拒绝');
});

test('G20-3 logsAppendOK：非数组 / 超过上限 拒绝；首次写入允许', () => {
  assert.strictEqual(logsAppendOK([], [LOG_A]), true, '首次写入应允许');
  assert.strictEqual(logsAppendOK([], []), true, '首次空写入应允许');
  assert.strictEqual(logsAppendOK([LOG_A], null), false, '非数组应拒绝');
  assert.strictEqual(logsAppendOK([LOG_A], 'oops'), false, '非数组应拒绝');
  assert.strictEqual(logsAppendOK(null, [LOG_A]), true, '旧值为 null 视为首次写入');
  assert.strictEqual(logsAppendOK([LOG_A], mkLogs(501, 'over')), false, '超过 500 上限应拒绝');
  assert.strictEqual(logsAppendOK(mkLogs(500, 'old'), mkLogs(501, 'over')), false, '超过 500 上限应拒绝');
});

test('G20-4 logs 硬化：任意「长度恰为 500」的整表覆盖必须被拒绝（§5.2 伪代码洞）', () => {
  /* 设计 §5.2 伪代码在 p=neu.length 时空尾部必然命中 → 任意 500 长数组被整表放行。
     这里断言硬化后的行为：只有「前插 / 等长同容（除首条外逐条相同）」才放行。 */
  assert.strictEqual(logsAppendOK(mkLogs(1, 'old'), mkLogs(500, 'evil')), false, 'old=1 条 + neu=500 条任意内容 → 拒');
  assert.strictEqual(logsAppendOK(mkLogs(3, 'old'), mkLogs(500, 'evil')), false, 'old=3 条 + neu=500 条任意内容 → 拒');
  assert.strictEqual(logsAppendOK(mkLogs(500, 'old'), mkLogs(500, 'evil')), false, 'old=500 条 + neu=500 条任意内容 → 拒');
  assert.strictEqual(logsAppendOK(mkLogs(400, 'old'), mkLogs(499, 'evil')), false, '未触顶净增长但内容无关 → 拒');
});

test('G20-5 logs KR1 等价分支：恰好触顶时「替换最新 1 条」仍放行（设计 §9.3-KR1 已登记接受）', () => {
  const old500 = mkLogs(500, 'old');
  const forged = [{ time: 'Z', action: '删除', target: '订货单', detail: '伪造', field: '' }].concat(old500.slice(1));
  assert.strictEqual(forged.length, 500);
  assert.strictEqual(logsAppendOK(old500, forged), true, '触顶替换最新 1 条（除首条外逐条相同）应放行 —— 与合法 append 服务端不可区分');
  /* 但「触顶且除首条外也不同」必须拒绝 */
  const forgedBad = [{ time: 'Z', action: '删除', target: '订货单', detail: '伪造', field: '' }].concat(mkLogs(499, 'evil'));
  assert.strictEqual(logsAppendOK(old500, forgedBad), false);
});

test('G20-6 canWrite(logs)：非 admin 可追加、不可清空/缩减；admin 恒可', () => {
  const cj = U('chejian');
  const old = [LOG_A, LOG_B, LOG_C];
  assert.strictEqual(canWrite(cj, 'logs', { value: [LOG_D].concat(old), data: ctxData(PRODS, old) }), true, '追加应放行');
  assert.strictEqual(canWrite(cj, 'logs', { value: [], data: ctxData(PRODS, old) }), false, '清空应 403');
  assert.strictEqual(canWrite(cj, 'logs', { value: [LOG_A], data: ctxData(PRODS, old) }), false, '缩减应 403');
  assert.strictEqual(canWrite(cj, 'logs', { value: null, data: ctxData(PRODS, old) }), false, '非数组应 403');
  assert.strictEqual(canWrite(U('zongjingli'), 'logs', { value: [], data: ctxData(PRODS, old) }), false, 'zongjingli 清空应 403');
  assert.strictEqual(canWrite(U('admin'), 'logs', { value: [], data: ctxData(PRODS, old) }), true, 'admin 清空应放行（唯一）');
  assert.strictEqual(canWrite(U('admin'), 'logs', { value: null, data: ctxData(PRODS, old) }), true, 'admin 恒放行');
});

/* ============================================================
   G21 · products 字段级纯投影守卫（方案 α′）
   ============================================================ */
test('G21-1 仅 stock 变化 → 放行（无 perms.products 的 pmc / chejian）', () => {
  const only = clone(PRODS);
  only[0].stock = 88;
  only[1].stock = -5;                        /* 库存允许为负 */
  assert.strictEqual(isPureStockProjection(PRODS, only), true);
  assert.strictEqual(canWrite(U('pmc'), 'products', { value: only, data: ctxData(PRODS) }), true);
  assert.strictEqual(canWrite(U('chejian'), 'products', { value: only, data: ctxData(PRODS) }), true);
  assert.strictEqual(canWrite(U('zongjingli'), 'products', { value: only, data: ctxData(PRODS) }), false, 'zongjingli 无相关触发权限 → 403');
});

test('G21-2 改 name → 拒绝；改 spec/model/unit/dailyCap/status 同样拒绝', () => {
  const renamed = clone(PRODS); renamed[0].name = '甲产品改';
  assert.strictEqual(isPureStockProjection(PRODS, renamed), false);
  assert.strictEqual(canWrite(U('pmc'), 'products', { value: renamed, data: ctxData(PRODS) }), false);
  const spec = clone(PRODS); spec[1].spec = 'S2X';
  assert.strictEqual(canWrite(U('chejian'), 'products', { value: spec, data: ctxData(PRODS) }), false);
  const cap = clone(PRODS); cap[0].dailyCap = 99;
  assert.strictEqual(canWrite(U('pmc'), 'products', { value: cap, data: ctxData(PRODS) }), false);
  const st = clone(PRODS); st[0].status = '停用';
  assert.strictEqual(canWrite(U('pmc'), 'products', { value: st, data: ctxData(PRODS) }), false);
  const mixed = clone(PRODS); mixed[0].stock = 5; mixed[1].name = '乙改';
  assert.strictEqual(canWrite(U('pmc'), 'products', { value: mixed, data: ctxData(PRODS) }), false, 'stock+name 混合变更应拒绝');
});

test('G21-3 增行 / 删行 → 拒绝', () => {
  const add = clone(PRODS); add.push({ id: 'P3', name: '丙', stock: 0 });
  assert.strictEqual(isPureStockProjection(PRODS, add), false);
  assert.strictEqual(canWrite(U('pmc'), 'products', { value: add, data: ctxData(PRODS) }), false);
  assert.strictEqual(canWrite(U('chejian'), 'products', { value: add, data: ctxData(PRODS) }), false);
  const del = clone(PRODS).slice(0, 1);
  assert.strictEqual(isPureStockProjection(PRODS, del), false);
  assert.strictEqual(canWrite(U('pmc'), 'products', { value: del, data: ctxData(PRODS) }), false);
  assert.strictEqual(canWrite(U('pmc'), 'products', { value: [], data: ctxData(PRODS) }), false, '清空产品表应拒绝');
});

test('G21-4 换 id / 增删字段 / 行序变动 / 非数组 → 拒绝', () => {
  const idc = clone(PRODS); idc[0].id = 'P9';
  assert.strictEqual(canWrite(U('pmc'), 'products', { value: idc, data: ctxData(PRODS) }), false);
  const nf = clone(PRODS); nf[0].newField = 1;
  assert.strictEqual(canWrite(U('pmc'), 'products', { value: nf, data: ctxData(PRODS) }), false, '新增字段应拒绝');
  const df = clone(PRODS); delete df[0].model;
  assert.strictEqual(canWrite(U('pmc'), 'products', { value: df, data: ctxData(PRODS) }), false, '删字段应拒绝');
  const reorder = [clone(PRODS[1]), clone(PRODS[0])];
  assert.strictEqual(canWrite(U('pmc'), 'products', { value: reorder, data: ctxData(PRODS) }), false, '行序变动应拒绝（逐行对齐，比伪代码更严）');
  assert.strictEqual(canWrite(U('pmc'), 'products', { value: null, data: ctxData(PRODS) }), false, '非数组应拒绝');
  assert.strictEqual(canWrite(U('pmc'), 'products', { value: 'x', data: ctxData(PRODS) }), false, '非数组应拒绝');
  assert.strictEqual(isPureStockProjection('x', PRODS), false, '旧值非数组应拒绝');
  assert.strictEqual(isPureStockProjection(null, null), false);
});

test('G21-5 持 perms.products=true → 全字段可写（放行改主数据）', () => {
  const boss = { username: 'boss', role: 'staff', perms: { products: true } };
  const add = clone(PRODS); add.push({ id: 'P3', name: '丙' });
  add[0].name = '改名';
  assert.strictEqual(canWrite(boss, 'products', { value: add, data: ctxData(PRODS) }), true);
  assert.strictEqual(canWrite(boss, 'products', { value: [], data: ctxData(PRODS) }), true);
  assert.strictEqual(canWrite(boss, 'products', { value: null, data: ctxData(PRODS) }), true);
});

test('G21-6 零相关权限者不得触碰 products（即便只改 stock）', () => {
  const nobody = { username: 'nobody', role: 'staff', perms: { deliveries: true } };
  const only = clone(PRODS); only[0].stock = 42;
  assert.strictEqual(canWrite(nobody, 'products', { value: only, data: ctxData(PRODS) }), false);
  assert.strictEqual(canWrite(nobody, 'products', { value: PRODS, data: ctxData(PRODS) }), false);
});

/* ============================================================
   G22 · D1 修复回归（线上真值镜像）
   ============================================================ */
test('G22-1 D1 修复：pmc / chejian 的 productionPlans / productionReports / products(纯投影) → 200（原 403）', () => {
  const plans = [{ id: 'PP1', productId: 'P1', qty: 3 }];
  const only = clone(PRODS); only[0].stock = 12;
  const d = ctxData(PRODS, [LOG_A]);
  ['pmc', 'chejian'].forEach(who => {
    const u = U(who);
    assert.strictEqual(canWrite(u, 'productionPlans', { value: plans, data: d }), true, who + ' 写 productionPlans 应放行（D1 修复）');
    assert.strictEqual(canWrite(u, 'productionReports', { value: [{ id: 'R1' }], data: d }), true, who + ' 写 productionReports 应放行（并集 dailyPlans）');
    assert.strictEqual(canWrite(u, 'products', { value: only, data: d }), true, who + ' 写 products 纯 stock 投影应放行（D1 修复）');
  });
});

test('G22-2 不得放宽产品主数据：pmc / chejian 改 name / 增删行 → 403', () => {
  const renamed = clone(PRODS); renamed[0].name = 'X';
  const add = clone(PRODS); add.push({ id: 'P3', name: '丙' });
  ['pmc', 'chejian'].forEach(who => {
    const u = U(who);
    assert.strictEqual(canWrite(u, 'products', { value: renamed, data: ctxData(PRODS) }), false, who + ' 改 name 应 403');
    assert.strictEqual(canWrite(u, 'products', { value: add, data: ctxData(PRODS) }), false, who + ' 增行应 403');
    assert.strictEqual(canWrite(u, 'products', { value: [], data: ctxData(PRODS) }), false, who + ' 清空应 403');
  });
});

test('G22-3 zongjingli 越权关闭：transfers / productionReports → 403（原 transfers 实测 200）', () => {
  const u = U('zongjingli');
  const d = ctxData(PRODS, [LOG_A]);
  assert.strictEqual(canWrite(u, 'transfers', { value: [{ id: 'T1' }], data: d }), false, 'transfers 越权必须关闭');
  assert.strictEqual(canWrite(u, 'productionReports', { value: [{ id: 'R1' }], data: d }), false, 'productionReports 必须收口');
  assert.strictEqual(canWrite(u, 'productionPlans', { value: [], data: d }), false, 'productionPlans 亦应拒绝（dailyPlans=false 且无 productionPlans）');
  assert.strictEqual(canWrite(u, 'orders', { value: [], data: d }), false);
  /* 其本有权限的键不受影响（零误伤） */
  assert.strictEqual(canWrite(u, 'deliveries', { value: [], data: d }), true, 'deliveries 应保持放行');
  assert.strictEqual(canWrite(u, 'fields', { value: {}, data: d }), true, 'fields 应保持放行');
});

test('G22-4 并入集命中与保持项：orders / transfers / deliveries / processTemplates', () => {
  const d = ctxData(PRODS, [LOG_A]);
  assert.strictEqual(canWrite(U('pmc'), 'orders', { value: [], data: d }), true, 'pmc 有 saleOrders/invOrders');
  assert.strictEqual(canWrite(U('chejian'), 'orders', { value: [], data: d }), false, 'chejian 无订单权限 → 保持 403');
  assert.strictEqual(canWrite(U('pmc'), 'transfers', { value: [], data: d }), true, '并集命中 transfers');
  assert.strictEqual(canWrite(U('chejian'), 'transfers', { value: [], data: d }), true, '线上真值 chejian.transfers=true（§5.4 已自述「有 transfers 权限但无入口」）');
  assert.strictEqual(canWrite(U('pmc'), 'processTemplates', { value: [], data: d }), true);
  assert.strictEqual(canWrite(U('zongjingli'), 'processTemplates', { value: [], data: d }), false, '未授权键应 403');
  assert.strictEqual(canWrite(U('zongjingli'), 'products', { value: clone(PRODS), data: d }), false);
});

test('G22-5 admin 恒放行；未登录（null）一律拒绝', () => {
  const d = ctxData(PRODS, [LOG_A]);
  ['orders', 'transfers', 'productionPlans', 'productionReports', 'logs', 'products', 'deliveries', 'processTemplates', 'fields', 'meta', 'tblLayout', 'fieldsAudit', 'fieldsDraft'].forEach(k => {
    assert.strictEqual(canWrite(U('admin'), k, { value: null, data: d }), true, 'admin 应放行 ' + k);
    assert.strictEqual(canWrite(null, k, { value: null, data: d }), false, '未登录应拒绝 ' + k);
  });
});

test('G22-6 D3 守护：meta / tblLayout / fieldsAudit / fieldsDraft 对 staff 保持放行（本轮不动）', () => {
  const d = ctxData(PRODS, [LOG_A]);
  ['meta', 'tblLayout', 'fieldsAudit', 'fieldsDraft'].forEach(k => {
    ['pmc', 'chejian', 'zongjingli'].forEach(who => {
      assert.strictEqual(canWrite(U(who), k, { value: { any: 1 }, data: d }), true, who + ' 的 ' + k + ' 应保持放行（D3）');
    });
  });
});

test('G22-7 旧签名兼容：不传 ctx 时按模块级 data 判定（不抛错）', () => {
  assert.strictEqual(canWrite(U('pmc'), 'productionPlans'), true);
  assert.strictEqual(canWrite(U('zongjingli'), 'transfers'), false);
  assert.strictEqual(canWrite(U('admin'), 'anything'), true);
});
