'use strict';
/* ================================================================
   tests/harness.smoke.test.js —— 测试地基冒烟（T01）
   ================================================================
   目的：证明「零依赖 Node 内置 test runner + vm 沙箱」这套地基可用：
     ① js/*.js + index.html 主内联脚本能装进隔离上下文且不抛错（bootstrap 已剥离）
     ② 生产函数/数据全局在装载后可被取到（function 走全局对象；let/const 走全局词法环境）
     ③ dom-stub 契约（getElementById→null / querySelectorAll→[] / createElement 假节点）
     ④ recorder 能记录写集并返回可控结果
   边界：不测渲染/DOM 布局/真实网络（见 tests/README.md 与设计 §6.4）。
   运行：node --test（**不要用 node -e**，见 README「执行环境限定」）
   ================================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createApp,
  extractInlineScripts,
  findMainScript,
  stripBootstrap,
  ROOT,
} = require('./harness/sandbox');
const domStub = require('./harness/dom-stub');
const { createRecorder } = require('./harness/recorder');

/** 跨 realm 归一化：把上下文对象转成宿主普通对象，便于 deepEqual 断言 */
function plain(v) {
  return JSON.parse(JSON.stringify(v));
}

test('沙箱：能装载 js/*.js 与 index.html 主内联脚本，且 bootstrap() 未被自动执行', () => {
  const app = createApp();
  assert.equal(app.mainScript.stripped, true, '主内联脚本必须剥离 bootstrap()');
  assert.equal(
    app.mainScript.bootstrapLine > 0,
    true,
    '应能定位到 bootstrap() 在 index.html 中的真实行号'
  );
  /* 生产脚本确实有 bootstrap();（我们只是没执行它） */
  assert.equal(typeof app.getGlobal('bootstrap'), 'function');
  /* 关键证据：bootDone 仍为 false → 说明自动执行点真的被剥掉了（否则 initApp 全链会跑） */
  assert.equal(app.getGlobal('bootDone'), false);
  assert.equal(app.getGlobal('activeTab'), 'order');
  /* 装载清单：5 个模块脚本 + 1 个主内联脚本 */
  assert.equal(app.loaded.length, 6);
});

test('沙箱：生产函数与数据全局可被取到（含 let/const 词法绑定）', () => {
  const app = createApp();
  /* function 声明 → 全局对象属性 */
  const fns = [
    'applyTransfers',
    'alertTransferFailed',
    'syncStockFromInvOrders',
    'recomputeStockFromInvOrders',
    'syncOrderAutoStatus',
    'recomputeOrderAutoStatus',
    'writebackInbound',
    'writebackInboundMutation',
    'inboundTargetOf',
    'applyReport',
    'ppSaveReportEdits',
    'ppDelReport',
    'saveReport',
    'renderTransfers',
    'trRevType',
    'trSide',
    'ppItems',
    'kdDoImport',
    'logOp',
    'clearLogs',
    'canClearLogs',
    'save',
    'saveMulti',
  ];
  fns.forEach((n) => {
    assert.equal(typeof app.getGlobal(n), 'function', n + ' 应为可调用的全局函数');
  });
  /* let/const 声明 → 全局词法环境（app.getGlobal 内部用 runInContext 求值，可穿透） */
  assert.equal(Array.isArray(app.getGlobal('orders')), true);
  assert.equal(Array.isArray(app.getGlobal('transfers')), true);
  assert.equal(Array.isArray(app.getGlobal('products')), true);
  assert.equal(Array.isArray(app.getGlobal('productionReports')), true);
  /* const DB 对象 */
  const DB = app.getGlobal('DB');
  assert.equal(typeof DB.get, 'function');
  assert.equal(typeof DB.set, 'function');
  assert.equal(typeof DB.tx, 'function', 'T01 新增的 DB.tx 应存在');
});

test('沙箱：setGlobal 能改 let/const 全局（直接写 sandbox 属性会被词法绑定遮蔽＝陷阱）', () => {
  const app = createApp();
  app.setGlobal('orders', [{ id: 'O1' }, { id: 'O2' }]);
  assert.deepEqual(plain(app.run('orders.map(function(o){return o.id})')), ['O1', 'O2']);
  /* 陷阱演示：直接挂 sandbox 属性**不会**生效（词法绑定优先） */
  app.sandbox.orders = [{ id: 'GHOST' }];
  assert.deepEqual(plain(app.run('orders.map(function(o){return o.id})')), ['O1', 'O2']);
  /* 对 const 赋值应明确抛错（而不是静默无效果） */
  assert.throws(() => app.setGlobal('DB', {}), /constant/i);
});

test('内联脚本提取：找到 3 块，主块=含 bootstrap() 的最长块', () => {
  const app = createApp({ installRecorder: false });
  assert.equal(app.inlineScripts.length, 3);
  app.inlineScripts.forEach((b) => {
    assert.equal(b.startLine > 0, true);
    assert.equal(b.endLine >= b.startLine, true);
  });
  /* extractInlineScripts/findMainScript 可独立复用（收尾动作里做「逐块 node --check」） */
  const html = require('node:fs').readFileSync(require('node:path').join(ROOT, 'index.html'), 'utf8');
  const blocks = extractInlineScripts(html);
  assert.equal(blocks.length, 3);
  const main = findMainScript(blocks);
  assert.equal(/(^|\n)[ \t]*bootstrap\(\)[ \t]*;/.test(main.code), true);
  assert.equal(main.code.length, Math.max.apply(null, blocks.map((b) => b.code.length)));
  /* 带 src 的外链脚本不得被当作内联块（index.html 有 5 个 <script src>） */
  assert.equal(blocks.some((b) => /\bsrc\s*=/.test(b.attrs)), false);
});

test('stripBootstrap：只剥末尾自动执行点，其余源码逐字不变', () => {
  const code = 'function f(){}\nbootstrap();\n';
  const r = stripBootstrap(code);
  assert.equal(r.stripped, true);
  assert.equal(/bootstrap\(\)/.test(r.code), false);
  assert.equal(r.line, 2);
  /* 行数保持不变（错误栈行号可与 index.html 对齐） */
  assert.equal(r.code.split('\n').length, code.split('\n').length);
  /* 找不到自动执行点时不得谎报成功 */
  assert.equal(stripBootstrap('function f(){}\n').stripped, false);
  /* 非末尾的 bootstrap(); 不得被删 */
  assert.equal(stripBootstrap('bootstrap();\nfunction f(){}\n').stripped, false);
});

test('dom-stub 契约：getElementById 恒 null、querySelectorAll 恒 []、createElement 假节点可用', () => {
  const doc = domStub.createDocument();
  assert.equal(doc.getElementById('anything'), null, '设计 §6.2：getElementById 一律 null');
  assert.deepEqual(doc.querySelectorAll('.x'), [], 'querySelectorAll 一律 []');
  assert.equal(doc.querySelector('.x'), null);
  const el = doc.createElement('div');
  assert.equal(el.tagName, 'DIV');
  assert.equal(typeof el.appendChild, 'function');
  assert.equal(typeof el.addEventListener, 'function');
  el.style.cssText = 'color:red';
  assert.equal(el.style.cssText, 'color:red');
  el.setAttribute('data-k', 'v');
  assert.equal(el.getAttribute('data-k'), 'v');
  assert.equal(el.closest('tr'), null);
  assert.equal(el.querySelectorAll('td').length, 0);
  /* 假节点只保证「不抛错」，不保证布局（勿用其断言渲染结果） */
  assert.equal(el.offsetWidth, 0);
  assert.equal(el.getBoundingClientRect().width, 0);
  assert.equal(typeof doc.body.appendChild, 'function');
});

test('dom-stub：alert/confirm/prompt 只记录不阻塞；storage 是内存实现', () => {
  const b = domStub.createBrowserGlobals({ confirmResult: false, promptResult: 'p' });
  b.globals.alert('boom');
  assert.equal(b.globals.confirm('ok?'), false);
  assert.equal(b.globals.prompt('val?'), 'p');
  assert.deepEqual(b.alerts, ['boom']);
  assert.deepEqual(b.confirms, ['ok?']);
  const ls = b.globals.localStorage;
  ls.setItem('a', '1');
  assert.equal(ls.getItem('a'), '1');
  assert.equal(ls.getItem('nope'), null);
  assert.equal(ls.length, 1);
  ls.removeItem('a');
  assert.equal(ls.getItem('a'), null);
  /* sessionStorage 与 localStorage 相互独立 */
  assert.equal(b.globals.sessionStorage.getItem('a'), null);
});

test('recorder：记录写集（顺序/次数/keys）并支持注入失败', async () => {
  const rec = createRecorder({});
  rec.save('logs', [1]);
  await rec.dbSet('orders', [], true);
  await rec.dbTx([{ key: 'orders', value: [] }, { key: 'transfers', value: [] }], true);

  assert.deepEqual(
    plain(rec.all().map((c) => c.op)),
    ['save', 'set', 'tx']
  );
  assert.equal(rec.txCount(), 1);
  assert.equal(rec.writeCount(), 3);
  assert.deepEqual(plain(rec.writeOrder()), ['logs', 'orders', 'orders', 'transfers']);
  assert.equal(rec.countOf('orders'), 2);
  assert.deepEqual(plain(rec.lastTx().keys), ['orders', 'transfers']);

  /* 可控失败：失败时不得写入 store（保证「一字不写」断言可用） */
  rec.failAlways('tx', new Error('boom'));
  const ok = await rec.dbTx([{ key: 'products', value: [9] }], false);
  assert.equal(ok, false);
  assert.equal(rec.store.products, undefined);
  assert.equal(rec.lastError().message, 'boom');

  /* 恢复后可写 */
  rec.clearFailures();
  assert.equal(await rec.dbTx([{ key: 'products', value: [9] }], false), true);
  assert.deepEqual(plain(rec.store.products), [9]);
  rec.reset();
  assert.equal(rec.writeCount(), 0);
});

test('recorder 已挂进沙箱：生产 save/DB.set/DB.tx 被替换为记录器', async () => {
  const app = createApp();
  app.setGlobals({ orders: [], transfers: [], products: [] });
  app.run('save("logs", logs)');
  await app.run('DB.set("orders", orders, true)');
  await app.run('DB.tx([{key:"orders",value:orders},{key:"transfers",value:transfers}], true)');
  assert.deepEqual(
    plain(app.recorder.all().map((c) => c.op)),
    ['save', 'set', 'tx']
  );
  assert.equal(app.recorder.txCount(), 1);
  /* 还原生产实现后，save 不再是记录器（供「零改动回归」类测试使用） */
  assert.equal(app.restoreOriginals(), true);
  app.run('save("logs", logs)');
  assert.equal(app.recorder.writeCount(), 3, '还原后不应再记录到 recorder');
});
