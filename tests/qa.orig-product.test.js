'use strict';
/* ================================================================
   tests/qa.orig-product.test.js —— QA 独立验收（.131「金蝶替换行原单物料号警示」）

   用户冻结口径（逐条对应下方用例）：
     1) 触发范围：**仅**「替换」行挂 origProduct；新建（__NEW__）/编码本已存在/忽视（__SKIP__）行**不得**有该 key
     2) 落库形状：items[].origProduct = {productId,productName,model,spec}，四值均为 String(...==null?'':...).trim()
     3) 取值口径：型号/规格取**金蝶 Excel 原行原值**（it.model / it.spec），不是替换后目标主数据的型号/规格
     4) 渲染：订单管理「商品编码」单元格，黄色感叹图标置于编码文字**左侧**，悬停复用既有 [data-tip]→.cell-tip
     5) 弹窗文案：单行「原单：编码 X ｜ 名称 Y ｜ 型号 Z ｜ 规格 W」，空项整段省略，四项全空 → 空串（不画图标）
     6) 存量零回归：无 origProduct 行 → 单元格与改前**逐字符一致**（零 svg、零属性差异）；零迁移零回填
     7) 范围纪律：只改 js/import.js 与 index.html；其它页面 productId 渲染与商品编码列 schema 不得变

   本文件与工程师用例的分工：工程师测「实现对不对」；本文件从源码取证 + 用真实 Excel 网格端到端驱动
   （importKingdeeXLSX → kdPrecheckAndShow → kdDoImport → renderOrderTable），断言只依据冻结口径与源码事实。

   项目纪律：**生产函数一律从源码抽取/装载后执行，不手写副本**；只新增测试文件，不改任何生产代码。

   运行：node --test tests/qa.orig-product.test.js   （**不要 node -e**，见 tests/README.md）
   ================================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createApp } = require('./harness/sandbox');

const ROOT = path.join(__dirname, '..');
const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const IMPORT_SRC = fs.readFileSync(path.join(ROOT, 'js', 'import.js'), 'utf8');
/* 「改前」参照物：P1 批次备份（2026-09-11，早于本轮 .131 改动）——用于逐字符零回归比对 */
const BACKUP_HTML = path.join(ROOT, 'backups', 'index.html.bak-20260911_0945-pre-p1tx');

function plain(v) {
  return JSON.parse(JSON.stringify(v));
}

/* ================================================================
   0. 源码抽取工具（不手写任何生产函数副本）
   ================================================================ */

/**
 * 从源码里抽出 `function name(...){...}` 的**原文**（花括号配平；跳过字符串/模板串/注释/正则字面量）。
 * 用途：让用例执行的是 index.html 里那一份真实函数，而非测试里重写的等价物。
 */
function extractFunction(src, name) {
  const sig = 'function ' + name + '(';
  const at = src.indexOf(sig);
  assert.notEqual(at, -1, '源码中未找到函数 ' + name);
  let i = src.indexOf('{', at);
  assert.notEqual(i, -1, name + ' 未找到函数体');
  let depth = 0;
  let mode = null; // null | sq | dq | tpl | line | block
  let lastSig = ''; // 最近一个有意义的字符（用于判定 `/` 是除号还是正则起始）
  for (; i < src.length; i++) {
    const c = src[i];
    const d = src[i + 1];
    if (mode === 'line') {
      if (c === '\n') mode = null;
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && d === '/') { mode = null; i++; }
      continue;
    }
    if (mode) {
      if (c === '\\') { i++; continue; }
      if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"') || (mode === 'tpl' && c === '`')) mode = null;
      continue;
    }
    if (c === '/' && d === '/') { mode = 'line'; i++; continue; }
    if (c === '/' && d === '*') { mode = 'block'; i++; continue; }
    if (c === '/') {
      /* 正则起始判定：上一有效字符是运算符/开括号/分号等 → 正则字面量；否则当普通字符 */
      if (lastSig === '' || /[({[,;:=!&|?+\-*%~^<>]/.test(lastSig)) {
        i++;
        let inClass = false;
        for (; i < src.length; i++) {
          const rc = src[i];
          if (rc === '\n') break;
          if (rc === '\\') { i++; continue; }
          if (rc === '[') inClass = true;
          else if (rc === ']') inClass = false;
          else if (rc === '/' && !inClass) break;
        }
        lastSig = '/';
        continue;
      }
    }
    if (c === "'" || c === '"' || c === '`') {
      mode = c === "'" ? 'sq' : c === '"' ? 'dq' : 'tpl';
      lastSig = c;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
    if (!/\s/.test(c)) lastSig = c;
  }
  assert.fail('花括号未配平：' + name);
}

/** 抽出包含指定片段的**整行原文**（可指定起始搜索位置，用于区分同形不同处的行）。 */
function extractLine(src, needle, fromIndex) {
  const at = src.indexOf(needle, fromIndex || 0);
  assert.notEqual(at, -1, '源码中未找到片段：' + needle);
  const s = src.lastIndexOf('\n', at) + 1;
  let e = src.indexOf('\n', at);
  if (e === -1) e = src.length;
  return src.slice(s, e);
}

/* 三个真实函数原文（执行体） */
const FN_ESC = extractFunction(INDEX_SRC, 'esc');
const FN_WARN = extractFunction(INDEX_SRC, 'warnTriSvg');
const FN_ORIG = extractFunction(INDEX_SRC, 'kdOrigTip');

/** 在沙箱内以「抽取到的源码原文」求值（函数体自带，不依赖生产全局，证明抽取结果自洽）。 */
function evalWithFns(app, expr) {
  const code = '(function(){\n' + FN_ESC + '\n' + FN_WARN + '\n' + FN_ORIG + '\nreturn (' + expr + ');\n})()';
  return app.run(code);
}

/* 渲染端模板（订单管理 renderOrderTable 内，按「函数内首次出现」精确定位） */
const AT_RENDER = INDEX_SRC.indexOf('function renderOrderTable(');
assert.notEqual(AT_RENDER, -1, 'index.html 未找到 renderOrderTable');
const L_TIP = extractLine(INDEX_SRC, "const _origTip=it.origProduct?kdOrigTip(it.origProduct):'';", AT_RENDER).trim();
const L_TRI = extractLine(INDEX_SRC, "const origTri=_origTip?warnTriSvg('#f59e0b',_origTip):'';", AT_RENDER).trim();
const L_CELL = extractLine(INDEX_SRC, "'<td data-key=\"productId\">'+origTri+esc(it.productId)+'</td>'+", AT_RENDER).trim();
assert.equal(L_CELL.endsWith("'</td>'+"), true, '商品编码单元格模板行应以 + 结尾（拼接后继列）');
const EXPR_CELL_NEW = L_CELL.slice(0, -1); /* 去掉末位 + → 独立表达式 */

/* 「改前」模板（备份文件里同一函数内的那一行） */
const BACKUP_SRC = fs.existsSync(BACKUP_HTML) ? fs.readFileSync(BACKUP_HTML, 'utf8') : null;
let L_CELL_OLD = null;
if (BACKUP_SRC) {
  const atOld = BACKUP_SRC.indexOf('function renderOrderTable(');
  if (atOld >= 0) {
    L_CELL_OLD = extractLine(BACKUP_SRC, "'<td data-key=\"productId\">'+esc(it.productId)+'</td>'+", atOld).trim();
  }
}

/** 用「改前」模板求值单元格（改前模板不含 origTri，仅依赖 it 与 esc 即可自洽） */
function cellOld(app, it) {
  const expr = L_CELL_OLD.slice(0, -1);
  return app.run('(function(it){return (' + expr + ');})(' + JSON.stringify(it) + ')');
}

/** 用「当前」模板求值单元格（IIFE 内执行真实源码行，不手写副本） */
function cellNew(app, it) {
  const code = '(function(it){\n' + L_TIP + '\n' + L_TRI + '\nreturn (' + EXPR_CELL_NEW + ');\n})(' + JSON.stringify(it) + ')';
  return app.run(code);
}

/* ================================================================
   1. 夹具与驱动
   ================================================================ */

/** 金蝶引出表表头（列映射见 js/import.js kdMapHeader） */
const HEADERS = ['单据编号', '客户', '单据日期', '预计交货日期', '商品编码', '商品名称', '规格', '型号', '数量'];

function sheetOf(headers, rows) {
  return { name: '销售订单', headers: headers, rows: rows, merges: [] };
}

function newApp(seed) {
  const app = createApp({ installRecorder: true });
  app.setGlobals(
    Object.assign(
      {
        currentUser: { username: 'pmc', name: 'PMC小张', role: 'admin', perms: {} },
        orders: [],
        products: [{ id: 'P001', name: '目标产品', model: 'M-T', spec: 'S-T', unit: '台', stock: 0, status: '启用' }],
        deliveries: [],
        transfers: [],
        productionPlans: [],
        productionReports: [],
        logs: [],
        renderContent: function () {},
        renderAll: function () {},
      },
      seed || {}
    )
  );
  return app;
}

/**
 * 真驱动 importKingdeeXLSX 的解析链：桩 XLSX.parse 给一张表、桩 FileReader 触发 onload。
 * 解析完成后 kdReport / kdState 已由生产代码 kdPrecheckAndShow 写好（调用前读，落库后 kdReport 会被置 null）。
 * @returns {{cap:{title:string,body:string}, pending:Array<Promise>}}
 */
async function driveParse(app, sheet) {
  const cap = { title: '', body: '' };
  const pending = [];
  app.setGlobal('XLSX', { parse: async function () { return [sheet]; } });
  app.setGlobal('FileReader', function () {
    const self = this;
    self.result = null;
    self.onload = null;
    self.onerror = null;
    self.readyState = 0;
    self.abort = function () {};
    self.readAsArrayBuffer = function () { pending.push(self.onload()); };
  });
  app.setGlobal('showModal', function (t, b) { cap.title = t; cap.body = b; });
  await app.run('importKingdeeXLSX(' + JSON.stringify({ target: { files: [{ name: 'kd-qa.xlsx' }], value: '' } }) + ')');
  for (const p of pending) await p;
  return { cap: cap, pending: pending };
}

/** 解析 → 预置决策 → 落库（kdDoImport 成功后 kdReport/kdState 会被置 null，故用前先取值） */
async function excelThenImport(app, sheet, decisions) {
  const drive = await driveParse(app, sheet);
  app.setGlobal('kdState', { conflict: {}, unknown: decisions || {} });
  await app.run('kdDoImport()');
  return drive;
}

/* ================================================================
   2. 文案函数（口径 5）—— 源码抽取执行
   ================================================================ */

test('V2-a kdOrigTip 矩阵：单行文案 / 空项整段省略 / 四项全空返回空串 / 无连续分隔符', async () => {
  const app = newApp({});
  const T = function (op) { return evalWithFns(app, 'kdOrigTip(' + JSON.stringify(op) + ')'); };

  const cases = [
    [{ productId: '6010001', productName: '框架断路器', model: 'DW45-2000', spec: '2000A/3P' },
      '原单：编码 6010001 ｜ 名称 框架断路器 ｜ 型号 DW45-2000 ｜ 规格 2000A/3P'],
    [{ productId: '6010001', productName: '框架断路器', model: '', spec: '' },
      '原单：编码 6010001 ｜ 名称 框架断路器'],
    [{ productId: '6010001', productName: '', model: '', spec: '' },
      '原单：编码 6010001'],
    [{ productId: '', productName: '', model: '', spec: '' }, ''],
    [{ productId: '', productName: '', model: 'DW45-2000', spec: '' },
      '原单：型号 DW45-2000'],
    [{ productId: '', productName: '框架断路器', model: '', spec: '2000A/3P' },
      '原单：名称 框架断路器 ｜ 规格 2000A/3P'],
    [{ productId: '6010001', productName: '', model: 'DW45-2000', spec: '' },
      '原单：编码 6010001 ｜ 型号 DW45-2000'],
  ];

  for (const [op, expect] of cases) {
    const got = T(op);
    assert.equal(got, expect, 'kdOrigTip(' + JSON.stringify(op) + ') 实际得到 ' + JSON.stringify(got));

    /* 分隔符守卫：任何空项组合下都不得出现连续 ｜ / 首尾多余分隔符 / 空标签 */
    assert.doesNotMatch(got, /｜\s*｜/, '不得出现连续分隔符');
    assert.doesNotMatch(got, /^｜|｜$/, '不得以分隔符开头或结尾');
    assert.doesNotMatch(got, /(编码|名称|型号|规格)\s*(｜|$)\s*(?=｜|$)/, '不得出现空标签');
    assert.doesNotMatch(got, /编码\s*｜|名称\s*(｜|$)|型号\s*(｜|$)|规格\s*$/, '不得出现「标签+空值」');
    if (got) {
      assert.equal(got.indexOf('原单：'), 0, '非空文案须以「原单：」开头');
      assert.equal(got.indexOf('\n'), -1, '文案必须单行（不得含换行）');
    }
  }

  /* 字段名契约：kdOrigTip 读的四个键，必须与 js/import.js 落库时写的四个键一致（不靠人肉假设） */
  const assign = /_orig=\{([^}]*)\}/.exec(IMPORT_SRC);
  assert.notEqual(assign, null, 'import.js 未找到 _orig={...} 落库赋值');
  const importKeys = (assign[1].match(/([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g) || [])
    .map(function (s) { return s.replace(/\s*:$/, ''); })
    .sort();
  assert.deepEqual(importKeys, ['model', 'productId', 'productName', 'spec'], 'import.js 快照键集合');
  for (const k of importKeys) {
    assert.match(FN_ORIG, new RegExp('op\\.' + k + '\\b'), 'kdOrigTip 必须读 op.' + k + '（与落库键同名）');
  }
  app.dispose();
});

test('V2-b 特殊字符安全面：<img onerror>、&、"、\' → data-tip 属性不得被撑破、不得注入标签', async () => {
  const app = newApp({});
  const tipOf = function (op) { return evalWithFns(app, 'kdOrigTip(' + JSON.stringify(op) + ')'); };
  const svgOf = function (op) {
    return evalWithFns(app, "warnTriSvg('#f59e0b',kdOrigTip(" + JSON.stringify(op) + '))');
  };
  const escOf = function (s) { return evalWithFns(app, 'esc(' + JSON.stringify(s) + ')'); };
  const unesc = function (s) {
    return String(s).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  };

  const evil = [
    { productId: 'X&Y', productName: '<img src=x onerror=1>', model: 'a"b', spec: "c'd" },
    { productId: '<script>alert(1)</script>', productName: '&<>"\'', model: '"', spec: "'" },
    { productId: 'A', productName: '"><svg onload=1>', model: '', spec: '' },
  ];

  for (const op of evil) {
    const tip = tipOf(op);
    const svg = svgOf(op);

    /* 1) 属性边界：data-tip 的内容必须恰为 esc(tip)，且内部无裸 " → 属性不会被撑破 */
    const m = /^<svg viewBox="0 0 24 24" style="width:14px;height:14px;vertical-align:-2px;margin-right:3px;cursor:help" data-tip="([^"]*)">/.exec(svg);
    assert.notEqual(m, null, 'SVG 前段结构变了 / data-tip 属性未闭合：' + svg.slice(0, 160));
    assert.equal(m[1], escOf(tip), 'data-tip 必须恰为 esc(tip)');
    assert.equal(m[1].indexOf('"'), -1, 'data-tip 值内不得残留裸双引号（否则属性被截断）');

    /* 2) 标签注入：最终 HTML 中不得出现未转义的 <img / <script */
    assert.equal(svg.indexOf('<img'), -1, '不得出现未转义 <img');
    assert.equal(svg.indexOf('<script'), -1, '不得出现未转义 <script');
    assert.equal(/data-tip="[^"]*"\s+onerror/.test(svg), false, '不得把 onerror 注入 svg 标签');
    if (op.productName.indexOf('<') >= 0) {
      assert.ok(svg.indexOf('&lt;') >= 0, '尖括号须被转义为 &lt;');
    }

    /* 3) 往返：浏览器 getAttribute 取回后还原为原文案（悬浮框按 textContent 渲染 → 安全） */
    assert.equal(unesc(m[1]), tip, '转义须可无损还原');

    /* 4) 单元格整体：图标在编码文字左侧；只有 1 个 data-tip；无未转义 <img */
    const cell = cellNew(app, { productId: 'P001', origProduct: op });
    assert.equal(cell.indexOf('<svg'), '<td data-key="productId">'.length, '图标必须紧贴 <td> 之后（编码文字左侧）');
    assert.ok(cell.endsWith('</svg>' + escOf('P001') + '</td>'), '编码文字必须在图标之后');
    assert.equal((cell.match(/data-tip=/g) || []).length, 1, '单元格内恰 1 个 data-tip');
    assert.equal(cell.indexOf('<img'), -1, '单元格内不得出现未转义 <img');
  }
  app.dispose();
});

/* ================================================================
   3. 写入端（口径 1 / 2 / 3）—— 真跑 Excel → 解析 → 决策 → 落库
   ================================================================ */

test('V3 端到端：替换行挂 origProduct（取 Excel 原值）；新建/已存在编码行 key 不存在；忽视行不导入', async () => {
  const rows = [
    /* A 单 5 行：li0 替换 / li1 新建 / li2 编码本就存在 / li3 替换(带空白) / li4 忽视 */
    ['XSDD-KD-A', '金蝶客户', '2026-09-01', '2026-10-01', 'ZZZ-OLD', '老名称', 'OLD-S', 'OLD-M', 10],
    ['XSDD-KD-A', '金蝶客户', '2026-09-01', '2026-10-01', 'ZZZ-NEW', '新名称', 'NEW-S', 'NEW-M', 5],
    ['XSDD-KD-A', '金蝶客户', '2026-09-01', '2026-10-01', 'P001', '系统名', 'S-T', 'M-T', 3],
    ['XSDD-KD-A', '金蝶客户', '2026-09-01', '2026-10-01', ' ZZZ-PAD ', ' 老名称2 ', ' PAD-S ', ' PAD-M ', 2],
    ['XSDD-KD-A', '金蝶客户', '2026-09-01', '2026-10-01', 'ZZZ-SKIP', '忽视名', 'SK-S', 'SK-M', 1],
    /* B 单 1 行且被忽视 → 整单不导入 */
    ['XSDD-KD-B', '金蝶客户', '2026-09-01', '2026-10-01', 'ZZZ-SKIP2', '忽视名2', 'SK2-S', 'SK2-M', 4],
  ];
  const app = newApp({});
  const drive = await driveParse(app, sheetOf(HEADERS, rows));

  /* 0) 解析侧连通：未知行恰为 A 单 li0/li1/li3/li4 + B 单 li0（li2 编码 P001 本就存在 → 不进未知表）；
        该顺序决定 kdState.unknown 的 idx 映射（idx0/1/2/3 属 A 单，idx4 属 B 单） */
  const unk = plain(await app.run('kdReport.unknown.map(function(u){return {id:u.o.id,li:u.li,pid:u.pid};})'));
  assert.deepEqual(unk, [
    { id: 'XSDD-KD-A', li: 0, pid: 'ZZZ-OLD' },
    { id: 'XSDD-KD-A', li: 1, pid: 'ZZZ-NEW' },
    { id: 'XSDD-KD-A', li: 3, pid: 'ZZZ-PAD' },
    { id: 'XSDD-KD-A', li: 4, pid: 'ZZZ-SKIP' },
    { id: 'XSDD-KD-B', li: 0, pid: 'ZZZ-SKIP2' },
  ], '未知行集合 / 所属订单 / 行号');
  assert.match(drive.cap.body, /未知产品编码/, '预检报告应列出未知产品编码段');

  app.setGlobal('kdState', { conflict: {}, unknown: { 0: 'P001', 1: '__NEW__', 2: 'P001', 3: '__SKIP__', 4: '__SKIP__' } });
  await app.run('kdDoImport()');

  /* 1) 订单层面：B 单因唯一明细被忽视 → 整单不导入 */
  assert.equal(await app.run('orders.length'), 1, 'B 单（唯一行被忽视）不得落库');
  assert.equal(await app.run('orders[0].id'), 'XSDD-KD-A', '只应有 A 单');
  assert.equal(await app.run('orders[0].items.length'), 4, 'A 单 5 行中忽视 1 行 → 落库 4 行');

  const items = plain(await app.run('orders[0].items'));

  /* 2) a) 替换行：productId 已改写为目标编码，origProduct 保留金蝶原单四值（Excel 原值） */
  assert.equal(items[0].productId, 'P001', '替换行 productId 改写为目标的已有产品编码');
  assert.deepEqual(items[0].origProduct,
    { productId: 'ZZZ-OLD', productName: '老名称', model: 'OLD-M', spec: 'OLD-S' },
    'origProduct 必须逐字段等于 Excel 原行原值');
  for (const k of ['productId', 'productName', 'model', 'spec']) {
    assert.equal(typeof items[0].origProduct[k], 'string', 'origProduct.' + k + ' 必须是字符串');
  }

  /* 口径 3 反证：落库行的型号/规格来自目标产品主数据，origProduct 来自 Excel —— 两者必须不同 */
  assert.equal(items[0].model, 'M-T', '落库行 model 仍以目标产品主数据为准（既有行为不变）');
  assert.equal(items[0].spec, 'S-T', '落库行 spec 仍以目标产品主数据为准（既有行为不变）');
  assert.notEqual(items[0].origProduct.model, items[0].model, 'origProduct.model 不得被目标主数据覆盖');
  assert.notEqual(items[0].origProduct.spec, items[0].spec, 'origProduct.spec 不得被目标主数据覆盖');

  /* 3) b) 新建行：key 必须**不存在**（用 in 证明，而非取值为 undefined） */
  assert.equal(items[1].productId, 'ZZZ-NEW', '新建行落库新编码');
  assert.equal('origProduct' in items[1], false, '新建（__NEW__）行不得出现 origProduct key');
  assert.equal(Object.prototype.hasOwnProperty.call(items[1], 'origProduct'), false, '新建行不得有 own property origProduct');

  /* 4) c) 编码本就存在（无需决策）的行：key 必须不存在 */
  assert.equal(items[2].productId, 'P001', '已存在编码行照常落库');
  assert.equal('origProduct' in items[2], false, '编码本就存在的行不得出现 origProduct key');
  assert.equal(Object.prototype.hasOwnProperty.call(items[2], 'origProduct'), false, '已存在行不得有 own property origProduct');

  /* 5) 替换行 + 空白：四值须 trim 归一（Excel 原值带前后空格） */
  assert.equal(items[3].productId, 'P001', '带空白的替换行亦改写为目标编码');
  assert.deepEqual(items[3].origProduct,
    { productId: 'ZZZ-PAD', productName: '老名称2', model: 'PAD-M', spec: 'PAD-S' },
    'origProduct 四值必须是 trim 后的字符串');

  /* 6) d) 忽视行确实没进 items */
  assert.equal(items.some(function (x) { return x.productId === 'ZZZ-SKIP' || x.productId === 'ZZZ-SKIP2'; }), false,
    '被忽视（__SKIP__）的明细不得落库');

  /* 7) 产品主数据：仅新建 1 个（替换目标已存在，不应重复建） */
  assert.deepEqual(plain(await app.run('products.map(function(p){return p.id;})')).sort(), ['P001', 'ZZZ-NEW'],
    '替换不新建产品；__NEW__ 才新建');

  /* 8) 提示语：确认忽视与跳过被如实统计 */
  const done = app.alerts.filter(function (m) { return m.indexOf('导入完成') >= 0; }).join('\n');
  assert.match(done, /忽视 2 行/, '应统计忽视 2 行，实际：' + done);
  assert.match(done, /跳过 1 单/, 'B 单应被跳过，实际：' + done);

  /* 9) 顺带确认既有口径未被破坏：落库 deliveredQty 恒 0 */
  assert.deepEqual(items.map(function (x) { return x.deliveredQty; }), [0, 0, 0, 0], '已交付仍不导入');
  app.dispose();
});

test('V3-e 未决策行：kdDoImport 直接中止，整单不落库', async () => {
  const app = newApp({});
  await driveParse(app, sheetOf(HEADERS, [
    ['XSDD-KD-U', '金蝶客户', '2026-09-01', '2026-10-01', 'ZZZ-OLD', '老名称', 'OLD-S', 'OLD-M', 10],
  ]));
  assert.equal(await app.run('kdReport.unknown.length'), 1, '应有 1 条未知编码待决策');

  app.setGlobal('kdState', { conflict: {}, unknown: {} }); /* 不决策 */
  await app.run('kdDoImport()');

  assert.equal(await app.run('orders.length'), 0, '未决策 → 不得落库任何订单');
  assert.equal(await app.run('products.map(function(p){return p.id;}).length'), 1, '未决策 → 不得新建产品（仍只有原 P001）');
  assert.equal(app.alerts.some(function (m) { return m.indexOf('未决策') >= 0; }), true,
    '应提示存在未决策行，实际提示：' + JSON.stringify(app.alerts));
  app.dispose();
});

/* ================================================================
   4. 解析侧连通性（口径 3 的取证点）
   ================================================================ */

test('V4 解析侧：it.model / it.spec 确实来自 Excel 两列；仅「规格型号」一列时 型号段为空（如实记录现状）', async () => {
  /* A) 有独立「型号」列 —— 两列各自进 it.model / it.spec */
  const appA = newApp({});
  await driveParse(appA, sheetOf(HEADERS, [
    ['XSDD-KD-A', '金蝶客户', '2026-09-01', '2026-10-01', 'ZZZ-OLD', '老名称', 'OLD-S', 'OLD-M', 10],
  ]));
  assert.equal(await appA.run('kdReport.list[0].items[0].spec'), 'OLD-S', 'Excel「规格」列 → it.spec');
  assert.equal(await appA.run('kdReport.list[0].items[0].model'), 'OLD-M', 'Excel「型号」列 → it.model');

  /* B) 金蝶常见引出格式：只有「规格型号」一列（无独立型号列） */
  const H2 = ['单据编号', '客户', '单据日期', '预计交货日期', '商品编码', '商品名称', '规格型号', '数量'];
  const appB = newApp({});
  await driveParse(appB, sheetOf(H2, [
    ['XSDD-KD-C', '金蝶客户', '2026-09-01', '2026-10-01', 'ZZZ-OLD', '老名称', 'DW45-2000/2000A/3P', 9],
  ]));
  assert.equal(await appB.run('kdReport.list[0].items[0].model'), '', '「规格型号」单列时 it.model 为空（既有列映射口径所致）');
  assert.equal(await appB.run('kdReport.list[0].items[0].spec'), 'DW45-2000/2000A/3P', '整列合体值落在 it.spec');

  const tip = evalWithFns(appB, 'kdOrigTip(' + JSON.stringify({
    productId: 'ZZZ-OLD', productName: '老名称', model: '', spec: 'DW45-2000/2000A/3P',
  }) + ')');
  assert.equal(tip, '原单：编码 ZZZ-OLD ｜ 名称 老名称 ｜ 规格 DW45-2000/2000A/3P',
    '现状：型号段整段省略，规格段承载「规格型号」合体值');

  /* 该行为并非本轮引入：既有列映射顺序（规格型号 先于 型号 匹配）决定 */
  assert.match(extractLine(IMPORT_SRC, "[/规格型号|规格/, 'spec']").trim(), /\[\/规格型号\|规格\/, 'spec'\]/, '既有列映射：规格型号 → spec');
  assert.ok(IMPORT_SRC.indexOf("[/型号/, 'model']") > IMPORT_SRC.indexOf("[/规格型号|规格/, 'spec']"),
    '既有列映射顺序：规格型号 先匹配，故单列「规格型号」不会进 model');

  appA.dispose();
  appB.dispose();
});

/* ================================================================
   5. 渲染端（口径 4 / 6）—— 真跑 renderOrderTable
   ================================================================ */

/** 造一张订单；第二行是否带 origProduct（key 是否存在）由参数控制 */
function orderFixture(withOrig) {
  const base = { productId: 'P001', productName: '目标产品', spec: 'S-T', model: 'M-T', orderQty: 10, deliveredQty: 0, lineNotes: '' };
  const row2 = Object.assign({}, base, { orderQty: 5 });
  if (withOrig) {
    row2.origProduct = { productId: 'ZZZ-OLD', productName: '老名称', model: 'OLD-M', spec: 'OLD-S' };
  }
  return {
    id: 'XSDD-1', orderType: '销售订单', status: '执行中', customer: '金蝶客户',
    startDate: '2026-09-01', deadline: '2026-10-01', contractNo: 'HT1',
    items: [Object.assign({}, base), row2],
  };
}

/** 真跑 renderOrderTable，返回所有 **完整** 的 <td data-key="productId">…</td> 片段 */
async function renderCells(withOrig) {
  const app = newApp({ orders: [orderFixture(withOrig)] });
  const html = await renderHtml(app);
  const out = [];
  const re = /<td data-key="productId">[\s\S]*?<\/td>/g;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[0]);
  app.dispose();
  return out;
}

/** 取单元格内层 HTML（便于断言「内容仅 esc(productId)」等） */
function innerOf(td) {
  const open = '<td data-key="productId">';
  assert.equal(td.indexOf(open), 0, '单元格前缀变了：' + td.slice(0, 60));
  assert.equal(td.endsWith('</td>'), true, '单元格后缀变了：' + td.slice(-20));
  return td.slice(open.length, -'</td>'.length);
}

/** 真跑 renderOrderTable（返回整张表 HTML） */
async function renderHtml(app) {
  const prodMap = await app.run('(function(){var m={};products.forEach(function(p){m[p.id]=p;});return m;})()');
  app.setGlobal('__prodMap', prodMap);
  return app.run('renderOrderTable("order_frame",[{o:orders[0],i:0}],__prodMap)');
}

test('V5 渲染：无 origProduct 行零回归（与改前模板逐字符一致）；有 origProduct 行图标在编码左侧且 tip 正确', async (t) => {
  const cells = await renderCells(true);
  assert.equal(cells.length, 3, '2 行明细 + 1 行合计 → 3 个商品编码单元格，实际 ' + cells.length);
  const plainCell = cells[0];   /* 第一行：无 origProduct（完整 <td>…</td>） */
  const tipCell = cells[1];     /* 第二行：有 origProduct */
  const sumCell = cells[2];     /* 合计行 */
  const plainInner = innerOf(plainCell);
  const tipInner = innerOf(tipCell);
  const sumInner = innerOf(sumCell);

  const app = newApp({});
  const it = { productId: 'P001' };

  /* 1) 零回归：无 origProduct → 单元格与「改前」模板输出逐字符一致 */
  if (L_CELL_OLD !== null) {
    assert.equal(plainCell, cellOld(app, it), '无 origProduct 行必须与改前逐字符一致');
  } else {
    t.diagnostic('改前备份不可用，跳过「逐字符」比对（其余断言照跑）');
  }
  assert.equal(plainCell, cellNew(app, it), '当前模板在无 origProduct 时输出应与渲染结果一致');

  /* 2) 零回归：无 svg / 无 data-tip / 内容仅 esc(productId) */
  assert.equal(plainCell.indexOf('<svg'), -1, '不得出现任何 svg');
  assert.equal(plainCell.indexOf('data-tip'), -1, '不得新增 data-tip 属性');
  assert.equal(plainInner, 'P001', '内容应恰为 esc(productId)');
  assert.equal(sumInner, '', '合计行商品编码单元格仍为空');
  assert.equal(sumCell.indexOf('<svg'), -1, '合计行不得出现 svg');

  /* 3) 有 origProduct → 恰 1 个 svg、黄色、data-tip 文案正确、图标在文字左侧 */
  assert.equal((tipInner.match(/<svg/g) || []).length, 1, '恰 1 个 svg');
  assert.equal((tipInner.match(/#f59e0b/g) || []).length, 1, '告警色必须是 #f59e0b（黄）');
  assert.equal(tipInner.indexOf('<svg'), 0, '图标必须位于单元格内容最前（即编码文字左侧）');
  assert.equal(tipInner.indexOf('</svg>'), tipInner.lastIndexOf('</svg>'), '只应有一个图标');
  assert.equal(tipInner.slice(tipInner.indexOf('</svg>') + '</svg>'.length), 'P001', 'svg 之后应恰为编码文字');
  assert.match(tipInner, /data-tip="原单：编码 ZZZ-OLD ｜ 名称 老名称 ｜ 型号 OLD-M ｜ 规格 OLD-S"/,
    'data-tip 文案须为单行四项，实际：' + tipInner);

  /* 4) 复用既有 [data-tip] → .cell-tip 机制：无新增 CSS、无新增监听 */
  const cssNow = extractLine(INDEX_SRC, '.cell-tip{position:fixed').trim();
  assert.equal((INDEX_SRC.match(/\.cell-tip\{position:fixed/g) || []).length, 1, '.cell-tip 样式规则仍恰 1 条（无新增 CSS）');
  if (BACKUP_SRC) {
    assert.equal(cssNow, extractLine(BACKUP_SRC, '.cell-tip{position:fixed').trim(), '.cell-tip 样式与改前逐字符一致');
  }
  assert.match(FN_WARN, /data-tip="/, 'warnTriSvg 仍按 data-tip 输出（既有机制）');
  assert.equal((INDEX_SRC.match(/closest\('\[data-tip\]'\)/g) || []).length, 1, '悬停监听仍是既有那一处（无新增监听）');

  app.dispose();
});

test('V5-b 范围纪律：其它页面 productId 单元格未接入 origTri；商品编码列 schema 未变；数据文件零回填', () => {
  /* 1) 全仓 origTri 仅出现在订单管理 renderOrderTable（注释 1 + 定义 1 + 使用 1） */
  assert.equal((INDEX_SRC.match(/origTri/g) || []).length, 3, 'origTri 应仅 3 处');

  /* 2) 所有 data-key="productId" 的行里，只有订单管理那一行含 origTri */
  const prodIdLines = INDEX_SRC.split('\n').filter(function (l) { return l.indexOf('data-key="productId"') >= 0; });
  assert.ok(prodIdLines.length >= 5, '应能定位到多个 productId 单元格（订单表 / 交付计划 / …），实际 ' + prodIdLines.length);
  const withOrig = prodIdLines.filter(function (l) { return l.indexOf('origTri') >= 0; });
  assert.equal(withOrig.length, 1, '只有一处 productId 单元格可接入 origTri，实际 ' + withOrig.length);
  assert.equal(withOrig[0].trim(), L_CELL, '且必须是 renderOrderTable 内的那一行');

  /* 3) 商品编码列 schema 未变（与改前备份逐字符一致） */
  const schemaNow = extractLine(INDEX_SRC, "{key:'productId',label:'商品编码',type:'text'").trim();
  assert.equal(schemaNow, "{key:'productId',label:'商品编码',type:'text',get:r=>r.item.productId},",
    '商品编码列 schema 不得改动，实际：' + schemaNow);
  if (BACKUP_SRC) {
    const schemaOld = extractLine(BACKUP_SRC, "{key:'productId',label:'商品编码',type:'text'").trim();
    assert.equal(schemaNow, schemaOld, '商品编码列 schema 与改前逐字符一致');
  }

  /* 4) index.html 正文里「读」origProduct 只有渲染层一处（无其它页面接入） */
  assert.equal((INDEX_SRC.match(/origProduct\?/g) || []).length, 1, 'index.html 只有一处「读」origProduct（渲染层判空）');
  assert.equal(INDEX_SRC.split('\n').filter(function (l) { return l.indexOf('it.origProduct') >= 0; }).length, 1,
    '只有一行代码读 it.origProduct（同一行内两次取值，仍属同一处接入点）');
  const firstAt = INDEX_SRC.indexOf('origProduct');
  const lineStart = INDEX_SRC.lastIndexOf('\n', firstAt) + 1;
  assert.match(INDEX_SRC.slice(lineStart, firstAt), /^\s*入参 = 落库行上的 $/,
    'origProduct 首次出现须在 kdOrigTip 注释内（无其它页面提前接入），实际前缀：' +
    JSON.stringify(INDEX_SRC.slice(lineStart, firstAt)));

  /* 5) import.js：只有替换分支挂 key，且是条件挂 key（非恒有 key） */
  assert.equal((IMPORT_SRC.match(/_impItem\.origProduct/g) || []).length, 1, '恰 1 处挂 key');
  assert.equal(extractLine(IMPORT_SRC, 'if(_orig)_impItem.origProduct=_orig;').trim(), 'if(_orig)_impItem.origProduct=_orig;',
    '必须是条件挂 key（新建/已存在行不出现该 key）');
  assert.ok(IMPORT_SRC.indexOf('_orig={productId:') > IMPORT_SRC.indexOf("if(u&&u!=='__NEW__'){"),
    '_orig 构造必须位于替换分支内（u 非空且非 __NEW__）');
  assert.match(extractLine(IMPORT_SRC, "if(u==='__SKIP__')").trim(), /return;/, '忽视分支必须提前 return（不落库）');
  /* 全仓唯一一处 origProduct= 赋值，且就是那条被 if(_orig) 守卫的语句 */
  assert.equal((IMPORT_SRC.match(/origProduct=/g) || []).length, 1, 'import.js 只允许一处 origProduct= 赋值');
  const atAssign = IMPORT_SRC.indexOf('origProduct=');
  assert.equal(IMPORT_SRC.slice(atAssign - 'if(_orig)_impItem.'.length, atAssign + 'origProduct='.length),
    'if(_orig)_impItem.origProduct=', '该赋值必须由 if(_orig) 守卫');
  assert.equal(INDEX_SRC.indexOf('origProduct='), -1, 'index.html 不得有任何 origProduct 赋值（渲染层只读）');

  /* 6) 零迁移 / 零回填：数据文件不得出现 origProduct */
  const dataJson = path.join(ROOT, 'server', 'data.json');
  if (fs.existsSync(dataJson)) {
    assert.equal(fs.readFileSync(dataJson, 'utf8').indexOf('origProduct'), -1,
      'server/data.json 不得含 origProduct（零迁移、零回填）');
  }
  /* 7) 存量单（无该字段）渲染时 origTri 恒为空串 —— 源码层判空即零改动 */
  assert.equal(L_TIP, "const _origTip=it.origProduct?kdOrigTip(it.origProduct):'';", '渲染层必须以字段「是否存在」判空');
});

/* ================================================================
   6. 全链路：Excel → 替换决策 → 落库 → 订单管理单元格（口径 4 的最终证明）
   ================================================================ */

test('全链路：Excel 原编码 ZZZ-OLD「替换」为 P001 → 订单管理单元格出现黄色原单警示（文案取自 Excel 原行）', async () => {
  const app = newApp({});
  await excelThenImport(app, sheetOf(HEADERS, [
    ['XSDD-KD-A', '金蝶客户', '2026-09-01', '2026-10-01', 'ZZZ-OLD', '老名称', 'OLD-S', 'OLD-M', 10],
    ['XSDD-KD-A', '金蝶客户', '2026-09-01', '2026-10-01', 'P001', '系统名', 'S-T', 'M-T', 3],
  ]), { 0: 'P001' });

  const stored = plain(await app.run('orders[0].items[0]'));
  assert.equal(stored.productId, 'P001', '替换后落库编码为目标编码');
  assert.deepEqual(stored.origProduct, { productId: 'ZZZ-OLD', productName: '老名称', model: 'OLD-M', spec: 'OLD-S' },
    '落库快照 = Excel 原行原值');

  /* 把真实落库数据喂给真实渲染函数 */
  const html = await renderHtml(app);
  const tds = [];
  const re = /<td data-key="productId">[\s\S]*?<\/td>/g;
  let m;
  while ((m = re.exec(html)) !== null) tds.push(m[0]);
  const cells = tds.map(innerOf);

  assert.equal(cells.length, 3, '2 行明细 + 1 合计');
  assert.match(cells[0], /^<svg [^>]*data-tip="原单：编码 ZZZ-OLD ｜ 名称 老名称 ｜ 型号 OLD-M ｜ 规格 OLD-S">/,
    '替换行单元格 = 黄色警示图标 + 原单文案，实际：' + cells[0].slice(0, 220));
  assert.match(cells[0], /#f59e0b/, '黄色 #f59e0b');
  assert.equal(cells[0].slice(cells[0].indexOf('</svg>') + '</svg>'.length), 'P001', '编码文字在图标之后');
  assert.equal(cells[1], 'P001', '同单「编码本就存在」行 → 无图标（与改前一致）');
  assert.equal(cells[2], '', '合计行无图标');
  app.dispose();
});
