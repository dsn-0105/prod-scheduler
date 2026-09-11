'use strict';
/* ================================================================
   tests/e2e-http.verify.js —— T03「真机 HTTP 验证」（完成判据第 6 条）
   ================================================================
   这不是单元测试（文件名不以 .test.js 结尾，`node --test tests/*.test.js` 不会收录它），
   而是**可按需执行的端到端验收脚本**：单元测试用 fetch 桩证明「一次业务动作 = 一次 /api/tx」，
   本脚本进一步用 **真实 HTTP → 真实 server/server.js → 真实落盘** 复核三件事：

     1) 生产前端函数（applyTransfers / kdDoImport / applyReport / ppSaveReportEdits）
        确实只发出 **1 次** POST /api/tx；
     2) 该单次请求体的 ops 含 **多张表**（事实表齐全、派生投影按需并入）；
     3) 服务端真把这几张表一起写进 data.json —— 即「一次请求提交多表」是真落盘，不是自证。

   做法：把 vm 沙箱里的全局 fetch 桥接到本机真实 HTTP（createApp + setFetch），
        因而 **跑的是生产代码本身**，不是手写 payload。额外复核 409 / 403 的「一字不写」。

   隔离：全部临时文件写在本文件同级的 `.e2e-tmp/`（经 PROD_DATA_FILE / PROD_USERS_FILE 覆盖），
        服务端子进程用 PROD_INIT_PWD 初始化独立账号库，**绝不触碰** server/data.json、
        server/users.json 与任何线上数据。

   运行：node tests/e2e-http.verify.js
   产物：tests/.e2e-tmp/verify-http.log（原始逐请求日志）
         tests/.e2e-tmp/verify-result.json（断言明细）
   退出码：0=全绿；1=有断言失败；2=脚本异常
   ================================================================ */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { createApp } = require('./harness/sandbox');

const ROOT = path.resolve(__dirname, '..');
const SERVER_JS = path.join(ROOT, 'server', 'server.js');
const TMP_DIR = path.join(__dirname, '.e2e-tmp');
const DATA_FILE = path.join(TMP_DIR, 'data.json');
const USERS_FILE = path.join(TMP_DIR, 'users.json');
const LOG_FILE = path.join(TMP_DIR, 'verify-http.log');
const RESULT_FILE = path.join(TMP_DIR, 'verify-result.json');

const PORT = Number(process.env.T3_PORT || 34117);
const HOST = '127.0.0.1';
const INIT_PWD = 'T3check#2026';

const out = [];
function log(s) {
  out.push(s);
  console.log(s);
}
function hr(title) {
  log('');
  log('='.repeat(72));
  log(title);
  log('='.repeat(72));
}

/* ------------------------------------------------------------------
   真实 HTTP 基础件
------------------------------------------------------------------ */

/** 发一次真实 HTTP 请求，返回 { status, raw, json }。 */
function httpRequest(method, pathName, bodyText, headers) {
  return new Promise(function (resolve, reject) {
    const body = bodyText || '';
    const h = Object.assign({}, headers || {});
    if (body) h['Content-Length'] = Buffer.byteLength(body);
    const req = http.request(
      { host: HOST, port: PORT, method: method || 'GET', path: pathName, headers: h },
      function (res) {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', function (c) {
          raw += c;
        });
        res.on('end', function () {
          let j = null;
          try {
            j = JSON.parse(raw);
          } catch (_e) {}
          resolve({ status: res.statusCode, raw: raw, json: j, headers: res.headers });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** 读磁盘 data.json（服务端落盘真值）。 */
function diskData() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

/* ------------------------------------------------------------------
   ① 起真实 server 子进程（隔离数据/用户文件 + 独立端口）
------------------------------------------------------------------ */
function startServer() {
  return new Promise(function (resolve, reject) {
    const child = spawn(process.execPath, [SERVER_JS], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(PORT),
        PROD_DATA_FILE: DATA_FILE,
        PROD_USERS_FILE: USERS_FILE,
        PROD_INIT_PWD: INIT_PWD,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    const to = setTimeout(function () {
      reject(new Error('服务端 10s 内未监听端口，输出：\n' + buf));
    }, 10000);
    function onChunk(c) {
      buf += String(c);
      if (buf.indexOf('listening on port') >= 0) {
        clearTimeout(to);
        resolve({ child, stdout: buf });
      }
    }
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('exit', function (code) {
      clearTimeout(to);
      reject(new Error('服务端提前退出 code=' + code + '，输出：\n' + buf));
    });
  });
}

/* ------------------------------------------------------------------
   ② 前端 fetch 桥：沙箱内 fetch → 真实 HTTP（逐次记录）
------------------------------------------------------------------ */
let NET = []; // 本轮动作的全部真实网络请求记录

function makeBridge(token) {
  return async function bridgeFetch(url, opts) {
    const o = opts || {};
    const pathName = String(url); // 生产代码里即 '/api/tx' | '/api/data' | '/api/save'
    const bodyText = o.body || '';
    const headers = Object.assign({}, o.headers || {});
    if (token && !headers['Authorization']) headers['Authorization'] = 'Bearer ' + token;
    const rec = { method: o.method || 'GET', path: pathName, body: bodyText, headers: headers };
    NET.push(rec);
    log('  [HTTP→] ' + rec.method + ' ' + pathName + (bodyText ? '  body=' + bodyText : ''));
    const r = await httpRequest(rec.method, pathName, bodyText, headers);
    rec.status = r.status;
    log('  [HTTP←] ' + pathName + ' → ' + r.status + '  ' + r.raw.slice(0, 260));
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers: { get: function () { return null; } },
      text: async function () {
        return r.raw;
      },
      json: async function () {
        return JSON.parse(r.raw);
      },
    };
  };
}

/* ------------------------------------------------------------------
   夹具（与 tests/write-points.test.js 同源，保证测的是同一业务口径）
------------------------------------------------------------------ */
const ADMIN = { username: 'admin', name: '管理员', role: 'admin', perms: {} };

function fixtureOrders() {
  return [
    {
      id: 'O-INV',
      orderType: '库存订单',
      customer: '成品仓',
      contractNo: '',
      status: '执行中',
      items: [
        { productId: 'P1', productName: '甲', spec: '', model: '', orderQty: 100, deliveredQty: 10, stockMax: '', stockMin: '' },
      ],
    },
    {
      id: 'O-SALE',
      orderType: '销售订单',
      customer: '华东盘厂',
      contractNo: 'HT1',
      status: '执行中',
      items: [{ productId: 'P1', productName: '甲', spec: '', model: '', orderQty: 50, deliveredQty: 0, calledQty: 3 }],
    },
  ];
}
function fixtureProducts(stock) {
  return [{ id: 'P1', name: '甲', spec: '', model: '', unit: '台', stock: stock, dailyCap: 0, status: '启用' }];
}
function fixturePlan(orderId, status, inboundDone) {
  return {
    id: 'PP1',
    orderId: orderId,
    deliveryIdx: null,
    customer: '成品仓',
    planDate: '2026-09-11',
    finalDate: '2026-09-11',
    status: status,
    items: [
      {
        productId: 'P1', productName: '甲', spec: '', model: '', unit: '台',
        planQty: 10, doneQty: inboundDone, dlLine: null,
        steps: { assembly: { plan: 10, done: 0 }, instant: { plan: 10, done: 0 }, delay: { plan: 10, done: 0 }, innerPack: { plan: 10, done: 0 }, aging: { plan: 10, done: 0 }, inbound: inboundDone },
      },
    ],
  };
}
function fixtureReport(qty) {
  return {
    id: 'REP-1', planId: 'PP1', date: '2026-09-11', time: '09:00', worker: '张三',
    createdAt: '2026-09-11T01:00:00.000Z',
    items: [{ productId: 'P1', productName: '甲', step: 'inbound', label: '入库', qty: qty, dlLine: null }],
  };
}
function kdFixture(pm) {
  return {
    filename: 'kd-test.xlsx', totalOrders: 1, pm: pm,
    list: [
      {
        id: 'O-KD1', customer: '金蝶客户', startDate: '2026-09-01', deadline: '2026-10-01', contractNo: 'HT9',
        items: [{ productId: 'P1', productName: '甲', spec: '', model: '', unit: '台', orderQty: 20, deliveredQty: 0, lineNotes: '' }],
      },
    ],
    unknown: [], conflict: [],
  };
}

/** 造一个「生产 DB 层 + 真实 HTTP 桥」的沙箱，并把 revs 对齐到服务器真值。 */
async function realApp(token, seed) {
  const app = createApp({
    installRecorder: false, // 用生产 DB 层，才走真实 fetch
    sessionStorage: { wb_cb_prod_token: token },
  });
  app.setFetch(makeBridge(token));
  app.setGlobals(
    Object.assign(
      {
        currentUser: ADMIN,
        orders: fixtureOrders(),
        products: fixtureProducts(10),
        transfers: [],
        productionPlans: [],
        productionReports: [],
        processTemplates: [],
        deliveries: [],
        logs: [],
        renderContent: function () {},
        renderAll: function () {},
      },
      seed || {}
    )
  );
  /* 关键：先用真实 GET /api/data 把 serverRevs 对齐（否则乐观锁 409） */
  await app.run('pullAll()');
  return app;
}

/* ------------------------------------------------------------------
   断言小工具
------------------------------------------------------------------ */
const CHECKS = [];
function check(name, cond, detail) {
  const ok = !!cond;
  CHECKS.push({ name: name, ok: ok, detail: detail === undefined ? '' : String(detail) });
  log('  [' + (ok ? '✓' : '✗') + '] ' + name + (detail !== undefined ? '   ' + detail : ''));
  return ok;
}
function txCalls() {
  return NET.filter(function (r) {
    return r.path === '/api/tx';
  });
}
function saveCalls() {
  return NET.filter(function (r) {
    return r.path === '/api/save';
  });
}
function keysOf(rec) {
  const b = JSON.parse(rec.body);
  return b.ops.map(function (o) {
    return o.key;
  });
}
function begin() {
  NET = [];
}

/* ================================================================
   主流程
================================================================ */
(async function main() {
  hr('T03 真机 HTTP 验证 —— ' + new Date().toISOString());
  log('仓库根   : ' + ROOT);
  log('服务端   : ' + SERVER_JS);
  log('隔离目录 : ' + TMP_DIR);
  log('监听端口 : ' + HOST + ':' + PORT);

  fs.mkdirSync(TMP_DIR, { recursive: true });
  /* 清掉上次残留（保证可重复运行） */
  [DATA_FILE, USERS_FILE].forEach(function (f) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  });

  let child = null;
  const allResults = {};
  try {
    /* ---------- 起服务（真实子进程） ---------- */
    hr('步骤 0 · 启动真实服务端子进程（隔离数据/用户文件，PROD_INIT_PWD 统一初始密码）');
    const st = await startServer();
    child = st.child;
    st.stdout.split('\n').forEach(function (l) {
      if (l.trim()) log('  [server] ' + l);
    });
    check('子进程已监听端口', true, HOST + ':' + PORT);
    check('隔离 users.json 由服务端首次初始化生成', fs.existsSync(USERS_FILE));
    check('隔离 data.json 由服务端首次初始化生成', fs.existsSync(DATA_FILE));

    /* ---------- 真实登录 ---------- */
    hr('步骤 1 · 真实登录 POST /api/login');
    const loginRes = await httpRequest(
      'POST', '/api/login', JSON.stringify({ username: 'admin', password: INIT_PWD }),
      { 'Content-Type': 'application/json' }
    );
    log('  [HTTP←] /api/login → ' + loginRes.status + '  ' + loginRes.raw.slice(0, 200));
    check('登录 200 且返回 token', loginRes.status === 200 && loginRes.json && !!loginRes.json.token, 'role=' + (loginRes.json && loginRes.json.role));
    const token = loginRes.json.token;

    /* ================================================================
       ① 调拨（js/transfer.js applyTransfers）
       ================================================================ */
    hr('① 真实 HTTP · 调拨 applyTransfers("call", …)');
    {
      begin();
      const app = await realApp(token);
      log('  [seed] orders=2 单 / products stock=10  （serverRevs 已由真实 GET /api/data 对齐）');
      NET = []; // 不计入统计：上面的对齐 GET
      const moves = [{ out: { orderId: 'O-INV', orderType: 'inv', lineIdx: 0 }, in: { orderId: 'O-SALE', orderType: 'sales', lineIdx: 0 }, qty: 15 }];
      const ok = await app.run('applyTransfers("call",' + JSON.stringify(moves) + ')');
      const tx = txCalls();
      const keys = tx.length ? keysOf(tx[0]) : [];
      log('  [返回] applyTransfers → ' + ok);
      check('业务返回 true', ok === true);
      check('真实 HTTP：恰好 1 次 POST /api/tx', tx.length === 1, '实际 ' + tx.length + ' 次');
      check('该单次请求含多张表', keys.length >= 2, JSON.stringify(keys));
      check('事实表 orders + transfers 同请求', keys.indexOf('orders') >= 0 && keys.indexOf('transfers') >= 0, JSON.stringify(keys));
      check('派生投影 products 一并提交（确有变化）', keys.indexOf('products') >= 0, JSON.stringify(keys));
      check('无独立 /api/save 事实表写入', saveCalls().filter(function (c) { return ['orders', 'transfers', 'products'].indexOf(JSON.parse(c.body).key) >= 0; }).length === 0);
      const d = diskData();
      check('磁盘 data.json：transfers 落盘 1 条', Array.isArray(d.transfers) && d.transfers.length === 1, 'len=' + (d.transfers || []).length);
      check('磁盘 data.json：orders 已交付 10→-5 落盘', d.orders[0].items[0].deliveredQty === -5, '值=' + d.orders[0].items[0].deliveredQty);
      check('磁盘 data.json：products 库存投影落盘 -5', d.products[0].stock === -5, '值=' + d.products[0].stock);
      check('三张表在**同一次请求**中一起落盘（非分步提交）', d.transfers.length === 1 && d.orders[0].items[0].deliveredQty === -5 && d.products[0].stock === -5);
      allResults.transfer = { txCount: tx.length, keys: keys, ok: ok };
      app.dispose();
    }

    /* ================================================================
       ② 金蝶导入（js/import.js kdDoImport）—— 新建成品主数据
       ================================================================ */
    hr('② 真实 HTTP · 金蝶导入 kdDoImport()（含新建产品，事实+主数据同事务）');
    {
      begin();
      const app = await realApp(token, { orders: [], products: [] });
      app.setGlobals({ kdReport: kdFixture({}), kdState: { unknown: {}, conflict: {} } });
      log('  [seed] orders=[] / products=[] / kdReport 1 单含未知产品 P1');
      NET = [];
      await app.run('kdDoImport()');
      const tx = txCalls();
      const keys = tx.length ? keysOf(tx[0]) : [];
      log('  [返回] kdDoImport 完成；orders.length=' + (await app.run('orders.length')) + ' products.length=' + (await app.run('products.length')));
      check('真实 HTTP：恰好 1 次 POST /api/tx', tx.length === 1, '实际 ' + tx.length + ' 次');
      check('该单次请求含多张表（products + orders）', keys.indexOf('products') >= 0 && keys.indexOf('orders') >= 0, JSON.stringify(keys));
      const d = diskData();
      check('磁盘 data.json：新建成品 P1 与订单 O-KD1 同时落盘', d.products.length === 1 && d.orders.length === 1 && d.orders[0].id === 'O-KD1', 'products=' + d.products.length + ' orders=' + d.orders.length);
      allResults.importNewProduct = { txCount: tx.length, keys: keys };
      app.dispose();
    }

    /* ================================================================
       ③ 报工（index.html applyReport）
       ================================================================ */
    hr('③ 真实 HTTP · 报工 applyReport(0, [入库 5], …)');
    {
      begin();
      const app = await realApp(token, {
        orders: fixtureOrders(),
        products: fixtureProducts(10),
        productionPlans: [fixturePlan('O-INV', '待排产', 0)],
      });
      log('  [seed] 排产单 PP1 待排产 / 库存订单 O-INV 已交付 10 / 报工入库 5');
      NET = [];
      await app.run('applyReport(0, [{li:0,step:"inbound",qty:5}], ppItems(productionPlans[0]), "张三")');
      const tx = txCalls();
      const keys = tx.length ? keysOf(tx[0]) : [];
      log('  [返回] 排产单状态=' + (await app.run('productionPlans[0].status')) + ' 已交付=' + (await app.run('orders[0].items[0].deliveredQty')));
      check('真实 HTTP：恰好 1 次 POST /api/tx（改造前为 ≥5 次独立写）', tx.length === 1, '实际 ' + tx.length + ' 次');
      check('该单次请求含 4 张表', keys.length === 4, JSON.stringify(keys));
      check('事实表齐备 productionPlans + productionReports + orders', keys.indexOf('productionPlans') >= 0 && keys.indexOf('productionReports') >= 0 && keys.indexOf('orders') >= 0, JSON.stringify(keys));
      check('派生投影 products 一并提交', keys.indexOf('products') >= 0, JSON.stringify(keys));
      const d = diskData();
      check('磁盘 data.json：报工明细落盘 1 条', d.productionReports.length === 1, 'len=' + d.productionReports.length);
      check('磁盘 data.json：排产单已入库 5 落盘', d.productionPlans[0].items[0].steps.inbound === 5, '值=' + d.productionPlans[0].items[0].steps.inbound);
      check('磁盘 data.json：订单已交付 10→15 落盘', d.orders[0].items[0].deliveredQty === 15, '值=' + d.orders[0].items[0].deliveredQty);
      check('磁盘 data.json：库存投影 10→15 落盘', d.products[0].stock === 15, '值=' + d.products[0].stock);
      check('四张表在**同一次请求**中一起落盘', d.productionReports.length === 1 && d.productionPlans[0].items[0].steps.inbound === 5 && d.orders[0].items[0].deliveredQty === 15 && d.products[0].stock === 15);
      allResults.report = { txCount: tx.length, keys: keys };
      app.dispose();
    }

    /* ================================================================
       ④ 编辑报工（index.html ppSaveReportEdits）
       ================================================================ */
    hr('④ 真实 HTTP · 编辑报工 ppSaveReportEdits("PP1")');
    {
      begin();
      const app = await realApp(token, {
        productionPlans: [fixturePlan('O-INV', '生产中', 5)],
        productionReports: [fixtureReport(5)],
      });
      log('  [seed] 报工明细 REP-1 数量 5（DOM 桩下取不到输入框 → 保留原值）');
      NET = [];
      await app.run('ppSaveReportEdits("PP1")');
      const tx = txCalls();
      const keys = tx.length ? keysOf(tx[0]) : [];
      check('真实 HTTP：恰好 1 次 POST /api/tx', tx.length === 1, '实际 ' + tx.length + ' 次');
      check('该单次请求含多张表（排产单 + 报工明细）', keys.indexOf('productionPlans') >= 0 && keys.indexOf('productionReports') >= 0, JSON.stringify(keys));
      const d = diskData();
      check('磁盘 data.json：报工明细数量未被 DOM 桩改坏（仍为 5）', d.productionReports[0].items[0].qty === 5, '值=' + d.productionReports[0].items[0].qty);
      allResults.reportEdit = { txCount: tx.length, keys: keys };
      app.dispose();
    }

    /* ================================================================
       ⑤ 真机原子性：坏 rev 的整批 409 —— 一字不写
       ================================================================ */
    hr('⑤ 真实 HTTP · 原子性复核：一次 tx 中任一键 rev 冲突 → 整批 409「一字不写」');
    {
      const before = diskData();
      const txRaw = await httpRequest(
        'POST', '/api/tx',
        JSON.stringify({
          ops: [
            { key: 'orders', value: [{ id: 'SHOULD-NOT-LAND', items: [] }] },
            { key: 'transfers', value: [{ id: 'SHOULD-NOT-LAND' }], expectedRev: 999999 },
          ],
        }),
        { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }
      );
      log('  [HTTP←] /api/tx → ' + txRaw.status + '  ' + txRaw.raw.slice(0, 260));
      const after = diskData();
      check('返回 409', txRaw.status === 409);
      check('第一个合法键也未落盘（orders 未被污染）', after.orders[0].id === before.orders[0].id, 'orders[0].id=' + after.orders[0].id);
      check('第二键未落盘（transfers 未出现 SHOULD-NOT-LAND）', JSON.stringify(after.transfers).indexOf('SHOULD-NOT-LAND') < 0);
      allResults.atomicity409 = { status: txRaw.status, wroteNothing: after.orders[0].id === before.orders[0].id };
    }

    /* ================================================================
       ⑥ 真机原子性：越权 403 —— 一字不写
       ================================================================ */
    hr('⑥ 真实 HTTP · 越权复核：无调拨权限账号提交 transfers → 403「一字不写」');
    {
      /* zongjingli 的 perms 全 false（P1 权限收紧后 transfers 应 403） */
      const lr = await httpRequest(
        'POST', '/api/login', JSON.stringify({ username: 'zongjingli', password: INIT_PWD }),
        { 'Content-Type': 'application/json' }
      );
      check('zongjingli 可登录', lr.status === 200 && lr.json && !!lr.json.token, 'status=' + lr.status);
      const before = diskData();
      const r = await httpRequest(
        'POST', '/api/tx',
        JSON.stringify({ ops: [{ key: 'transfers', value: [] }] }),
        { 'Content-Type': 'application/json', Authorization: 'Bearer ' + lr.json.token }
      );
      log('  [HTTP←] /api/tx(zongjingli,transfers) → ' + r.status + '  ' + r.raw.slice(0, 200));
      const after = diskData();
      check('返回 403', r.status === 403, 'status=' + r.status);
      check('磁盘未被改动', JSON.stringify(after.transfers) === JSON.stringify(before.transfers));
      allResults.atomicity403 = { status: r.status };
    }

    /* ---------- 汇总 ---------- */
    hr('汇总');
    const failed = CHECKS.filter(function (c) { return !c.ok; });
    log('断言总数 : ' + CHECKS.length);
    log('通过     : ' + (CHECKS.length - failed.length));
    log('失败     : ' + failed.length);
    if (failed.length) {
      log('');
      log('失败明细：');
      failed.forEach(function (c) {
        log('  ✗ ' + c.name + (c.detail ? '   ' + c.detail : ''));
      });
    }
    log('');
    log('真机 /api/tx 次数（各动作）：');
    log('  ① 调拨         : ' + allResults.transfer.txCount + ' 次 → ' + JSON.stringify(allResults.transfer.keys));
    log('  ② 导入(新建品) : ' + allResults.importNewProduct.txCount + ' 次 → ' + JSON.stringify(allResults.importNewProduct.keys));
    log('  ③ 报工         : ' + allResults.report.txCount + ' 次 → ' + JSON.stringify(allResults.report.keys));
    log('  ④ 编辑报工     : ' + allResults.reportEdit.txCount + ' 次 → ' + JSON.stringify(allResults.reportEdit.keys));

    fs.writeFileSync(RESULT_FILE, JSON.stringify({ checks: CHECKS, results: allResults }, null, 2), 'utf8');
    log('');
    log('结果 JSON : ' + RESULT_FILE);
    log(failed.length ? 'VERDICT: FAIL' : 'VERDICT: PASS');
    process.exitCode = failed.length ? 1 : 0;
  } catch (e) {
    log('');
    log('!! 验证脚本异常：' + (e && e.stack ? e.stack : e));
    process.exitCode = 2;
  } finally {
    if (child) {
      try {
        child.kill();
      } catch (_e) {}
    }
    fs.writeFileSync(LOG_FILE, out.join('\n'), 'utf8');
    console.log('\n[log written] ' + LOG_FILE);
  }
})();
