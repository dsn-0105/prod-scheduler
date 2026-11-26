'use strict';
/* ================================================================
   tests/qa.ledger-fields.independent.test.js
   —— 异常台账「字段扩展」独立守卫（产品名称/规格型号/总数量/检测数量/
      异常数量/异常描述/原因分析）
   ================================================================
   本文件只做三件事，全部是可判定的**契约**（不是复述实现）：

   §A  列定义是**唯一真源**：9 个 key、顺序、类型、可排序列白名单
   §B  五个消费者必须从列定义派生（表头 / 表体 / CSV / 行内更新 / 表单）
       —— 这条是本次扩展的**根因防线**：加字段之前这五处各写一份硬编码，
          `applyRowUpdate` 更用 `tds[1]`/`tds[2]` 取单元格，多一列就静默只刷新
          前两格（不报错、不抛异常，只是用户以为没存上）。守卫必须能抓回潮，
          故 §B4 做**变异注入**并断言「注入生效 + 守卫确实变红」。
   §C  空值语义（1A 决策）：新增空值不落键 / 编辑空值发 null 才能清空
       —— 后者不是洁癖：`qa-store.applyUpdate` 是 `Object.assign({}, rec, extras)`，
          不传键 ⇒ 旧值原样保留，用户清空数量后保存会「看起来没生效」。

   为什么 §C 直接调 qa-store 而不是读源码：空值语义是**数据层行为**，
   源码里写没写注释不算数，得看落库结果。
   ================================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'quality', 'qa-app.js'), 'utf8');
const qaStore = require(path.join(ROOT, 'server', 'qa-store.js'));

/* 用户确认的字段顺序（PRD 原始两列先行，新增 7 列按需求原话顺序追加） */
const EXPECT_KEYS = [
  'date', 'no',
  'productName', 'specModel',
  'totalQty', 'inspectedQty', 'defectQty',
  'defectDesc', 'causeAnalysis'
];

const NEW_KEYS = ['productName', 'specModel', 'totalQty', 'inspectedQty', 'defectQty', 'defectDesc', 'causeAnalysis'];
const NUM_KEYS = ['totalQty', 'inspectedQty', 'defectQty'];

/** 取 `var QA_COLUMNS = [` … `  ];` 这一段（列定义块） */
function columnsBlock() {
  const a = APP.indexOf('var QA_COLUMNS = [');
  assert.ok(a > 0, 'qa-app.js 必须仍有 QA_COLUMNS 列定义（全工程唯一一份）');
  const end = APP.indexOf('\n  ];', a);
  assert.ok(end > a, '无法定位 QA_COLUMNS 数组结尾');
  return APP.slice(a, end);
}

/** 按顶层对象切出每条列定义（`{ key: 'x', …}`），返回 [{key, raw}] */
function columnEntries() {
  const block = columnsBlock();
  const re = /\{\s*key:\s*'([A-Za-z][A-Za-z0-9]*)'/g;
  const out = [];
  let m;
  while ((m = re.exec(block)) !== null) out.push({ key: m[1], at: m.index });
  /* 每条定义的原文 = 本条起点到下一段注释/下一条起点 */
  return out.map(function (e, i) {
    const stop = (i + 1 < out.length) ? out[i + 1].at : block.length;
    return { key: e.key, raw: block.slice(e.at, stop) };
  });
}

/** 取函数体（从签名到下一个 2 空格缩进的 `}` —— 本文件统一 2 空格缩进） */
function fnBody(src, signature) {
  const i = src.indexOf(signature);
  assert.ok(i > 0, '找不到 ' + signature);
  const rest = src.slice(i);
  const end = rest.indexOf('\n  }');
  assert.ok(end > 0, '无法定位 ' + signature + ' 的函数体结尾');
  return rest.slice(0, end);
}

/** 出现次数（用于变异注入的「命中数恰 1」断言） */
function countOcc(hay, needle) {
  return String(hay).split(String(needle)).length - 1;
}

/* ================================================================
   §A 列定义完整性
   ================================================================ */

test('§A1 列定义恰好 9 列，key 与顺序逐字等于用户需求（少一列=漏字段，多一列=擅自加字段）', function () {
  const keys = columnEntries().map(function (e) { return e.key; });
  assert.deepStrictEqual(keys, EXPECT_KEYS,
    'QA_COLUMNS 的 key/顺序与需求不一致。需求顺序：日期、编号、产品名称、规格型号、总数量、检测数量、异常数量、异常描述、原因分析');
});

test('§A2 三个数量字段落库类型必须是 number 控件（1A：存 number，不是 string）', function () {
  const entries = columnEntries();
  NUM_KEYS.forEach(function (k) {
    const e = entries.filter(function (x) { return x.key === k; })[0];
    assert.ok(e, '缺少数量字段 ' + k);
    assert.strictEqual(/type:\s*'num'/.test(e.raw), true, k + ' 的表格类型必须是 num（右对齐）');
    assert.strictEqual(/formKind:\s*'number'/.test(e.raw), true, k + ' 的表单控件必须是 number');
  });
});

test('§A3 两个长文本字段必须是 long + textarea（3A：表格截断悬浮，弹窗多行输入）', function () {
  const entries = columnEntries();
  ['defectDesc', 'causeAnalysis'].forEach(function (k) {
    const e = entries.filter(function (x) { return x.key === k; })[0];
    assert.ok(e, '缺少长文本字段 ' + k);
    assert.strictEqual(/type:\s*'long'/.test(e.raw), true, k + ' 的表格类型必须是 long（截断+悬浮）');
    assert.strictEqual(/formKind:\s*'textarea'/.test(e.raw), true, k + ' 的表单控件必须是 textarea');
  });
});

test('§A4 可排序列只能是 date/no（qa-core.sortRecords 只认这两个键，多标一个=点了没反应）', function () {
  const sortable = columnEntries()
    .filter(function (e) { return /sortable:\s*true/.test(e.raw); })
    .map(function (e) { return e.key; })
    .sort();
  assert.deepStrictEqual(sortable, ['date', 'no'],
    'sortable 白名单必须是 [date, no]：qa-core.js 是前后端共享同一份字节，'
    + 'sortRecords 只认这两个键；给数量列标 sortable 会渲染出排序图标但点击无效（4A 明确本批不扩排序）');
});

/* ================================================================
   §B 单源守卫：五个消费者不得各自手写字段
   ----------------------------------------------------------------
   每个判据都写成**可复用的纯函数**（badXxx(src) ⇒ boolean），
   这样 §B5 能把「变异回潮的源码」喂给同一条判据、断言它确实变红 ——
   「守卫存在但永远绿」是本项目最贵的失败模式（比业务 bug 危险，因为报告看起来全绿）。
   ================================================================ */

/** 表头回潮形态：不取列定义 / 出现 sortTh('字面量') */
function badTableHeader(src) {
  const body = fnBody(src, 'function tableHtml(');
  return body.indexOf('tableCols()') < 0 || /sortTh\(\s*'/.test(body);
}

/** 表体回潮形态：用 td 下标定位（tds[N] 或 querySelectorAll('td')[N]）/ 丢了 data-col */
function badRowLocate(src) {
  const upd = fnBody(src, 'function applyRowUpdate(');
  const indexed = /tds\s*\[\s*\d+\s*\]/.test(upd)
    || /querySelectorAll\(\s*['"]td['"]\s*\)\s*\[/.test(upd);
  return indexed || !/\[data-col="/.test(upd);
}

/** CSV 回潮形态：不取列定义 / 手写 label 字面量 */
function badCsvCols(src) {
  const body = fnBody(src, 'function exportSelected(');
  return body.indexOf('tableCols()') < 0 || /label:\s*'[^']*'/.test(body);
}

test('§B1 表头由 tableCols() 派生，不得再出现 sortTh(\'date\') 之类硬编码', function () {
  assert.strictEqual(badTableHeader(APP), false,
    'tableHtml 必须从 tableCols() 取列，且不得出现 sortTh(\'字面量\')：'
    + '列名与 key 必须来自 QA_COLUMNS（否则加字段必漏表头）');
});

test('§B2 表体每格必须带 data-col，且 applyRowUpdate 不得用 td 下标定位', function () {
  const render = fnBody(APP, 'function cellHtml(');
  assert.ok(render.indexOf('data-col="') >= 0, 'cellHtml 必须给 td 打 data-col 标记');

  assert.strictEqual(badRowLocate(APP), false,
    'applyRowUpdate 不得用 td 下标取单元格 —— 旧写法 tds[1]/tds[2] 在扩到 9 列后'
    + '只会刷新日期与编号，新字段保存后界面纹丝不动（静默不一致）');
  assert.ok(fnBody(APP, 'function applyRowUpdate(').indexOf('cellText(') >= 0,
    'applyRowUpdate 的取值必须复用 cellText()（与表格/CSV 同源）');
});

test('§B3 CSV 导出列由 tableCols() 派生，不得手写 label 字面量', function () {
  assert.strictEqual(badCsvCols(APP), false,
    'exportSelected 必须从 tableCols() 取列，且不得出现 label: \'字面量\''
    + '（否则「界面有列、导出没列」的漂移必复发）');
  assert.ok(fnBody(APP, 'function exportSelected(').indexOf('cellText(') >= 0,
    'CSV 取值必须复用 cellText()（与界面同源）');
});

test('§B4 表单由 formCols() 派生，字段 id 统一为 qa_f_<key>', function () {
  const form = fnBody(APP, 'function recordFormHtml(');
  assert.ok(form.indexOf('formCols()') >= 0, 'recordFormHtml 必须从 formCols() 取字段');
  assert.strictEqual(/qa_f_/.test(form), false, 'recordFormHtml 内不得手写 qa_f_* id（由 formFieldHtml 统一生成）');

  const field = fnBody(APP, 'function formFieldHtml(');
  assert.ok(field.indexOf("'qa_f_' + col.key") >= 0, 'formFieldHtml 必须用 qa_f_ + col.key 生成 id');
});

test('§B5 变异注入判别力：三处回潮形态必须都能让 §B1/§B2/§B3 的判据变红', function () {
  /* ① 表头回退成硬编码 sortTh */
  const thNeedle = '? sortTh(cols[c].key, cols[c].label)';
  assert.strictEqual(countOcc(APP, thNeedle), 1, '表头变异锚点必须命中恰 1 处');
  const thMut = APP.replace(thNeedle, "? sortTh('date', '日期')");
  assert.notStrictEqual(thMut, APP, '表头变异注入必须生效');
  assert.strictEqual(badTableHeader(thMut), true, '表头回退成硬编码后，§B1 判据必须变红');

  /* ② 行定位回退成 td 下标 */
  const rowNeedle = "tr.querySelector('td[data-col=\"' + cols[j].key + '\"]')";
  assert.strictEqual(countOcc(APP, rowNeedle), 1, '行定位变异锚点必须命中恰 1 处');
  const rowMut = APP.replace(rowNeedle, "tr.querySelectorAll('td')[j + 1]");
  assert.notStrictEqual(rowMut, APP, '行定位变异注入必须生效');
  assert.strictEqual(badRowLocate(rowMut), true, '回退成 td 下标后，§B2 判据必须变红');

  /* ③ CSV 列回退成手写 label */
  const csvNeedle = 'var cols = tableCols().map(function (c) {';
  assert.strictEqual(countOcc(APP, csvNeedle), 1, 'CSV 变异锚点必须命中恰 1 处');
  const csvMut = APP.replace(csvNeedle, "var cols = [{ key: 'date', label: '日期' }].map(function (c) {");
  assert.notStrictEqual(csvMut, APP, 'CSV 变异注入必须生效');
  assert.strictEqual(badCsvCols(csvMut), true, 'CSV 列回退成手写后，§B3 判据必须变红');
});

/* ================================================================
   §C 空值语义与后端透传（行为级，直接跑数据层）
   ================================================================ */

/** 造一个最小可用 doc（不走 fs） */
function emptyDoc() {
  const doc = { version: qaStore.DATA_VERSION, revs: {} };
  doc[qaStore.TABLE_KEY] = [];
  doc.revs[qaStore.TABLE_KEY] = 0;
  return doc;
}

/** 用 applyUpdate 改一条，返回更新后的记录 */
function updateVia(doc, id, patch) {
  const out = qaStore.applyUpdate(doc, id, patch, { username: 'u1' }, 1764000000000);
  assert.strictEqual(out.code, 200, 'applyUpdate 应成功，实际 ' + out.code + ' ' + JSON.stringify(out.body));
  return out.body.record;
}

test('§C1 后端无需改动即可接收 7 个新字段（qa-store 刻意透传未知顶层标量键）', function () {
  const doc = emptyDoc();
  const body = {
    date: '2026-11-26',
    productName: '框架断路器',
    specModel: 'DW45-2000/3P',
    totalQty: 500,
    inspectedQty: 50,
    defectQty: 2,
    defectDesc: '触头银点偏位',
    causeAnalysis: '装配工装未校零'
  };
  const out = qaStore.applyCreate(doc, body, { username: 'u1' }, 1764000000000, function () { return 'abc123'; });
  assert.strictEqual(out.code, 201, 'applyCreate 应成功，实际 ' + out.code + ' ' + JSON.stringify(out.body));

  const rec = out.body.record;
  NEW_KEYS.forEach(function (k) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(rec, k), true,
      '新字段 ' + k + ' 必须原样落库（这是 PRD「加字段不改后端」的契约）');
  });
  NUM_KEYS.forEach(function (k) {
    assert.strictEqual(typeof rec[k], 'number', k + ' 落库必须是 number（1A），实际 ' + typeof rec[k]);
    assert.strictEqual(rec[k], body[k]);
  });
  assert.strictEqual(rec.productName, '框架断路器');
  assert.strictEqual(rec.defectDesc, '触头银点偏位');

  /* 落库后仍必须过启动校验（透传不得破坏文档结构） */
  assert.doesNotThrow(function () { qaStore.validateDoc(out.doc); });
});

test('§C2 新增时空值不落键（未填 ≠ 0），记录里不应出现这些键', function () {
  const doc = emptyDoc();
  const out = qaStore.applyCreate(doc, { date: '2026-11-26' }, { username: 'u1' }, 1764000000000, function () { return 'abc123'; });
  assert.strictEqual(out.code, 201);
  NEW_KEYS.forEach(function (k) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(out.body.record, k), false,
      '新增空值必须**不落该键**（未填与 0 语义不同）；' + k + ' 不该出现');
  });
});

test('§C3 编辑时传 null 才能清空（不传键 ⇒ applyUpdate 会保留旧值）', function () {
  const doc = emptyDoc();
  const created = qaStore.applyCreate(doc, {
    date: '2026-11-26', totalQty: 10, defectDesc: '划伤'
  }, { username: 'u1' }, 1764000000000, function () { return 'abc123'; });
  assert.strictEqual(created.code, 201);
  const id = created.body.record.id;

  /* ① 不传键：旧值必须原样保留 —— 这正是「清空必须显式发 null」的根因证明 */
  const keep = updateVia(created.doc, id, { date: '2026-11-26' });
  assert.strictEqual(keep.totalQty, 10, '不传键时 applyUpdate 会保留旧值（故清空必须发 null）');
  assert.strictEqual(keep.defectDesc, '划伤');

  /* ② 传 null：键被清空，且结构仍合法 */
  const cleared = updateVia(created.doc, id, { date: '2026-11-26', totalQty: null, defectDesc: null });
  assert.strictEqual(cleared.totalQty, null, '发 null 才能清空（前端 collectFormBody 的编辑分支据此实现）');
  assert.strictEqual(cleared.defectDesc, null);
  assert.doesNotThrow(function () { qaStore.validateDoc(created.doc); });
});

test('§C4 编号绝不进请求体（服务端会 400「编号不可修改」）', function () {
  const body = fnBody(APP, 'function collectFormBody(');
  assert.ok(/formKind === 'readonly'/.test(body),
    'collectFormBody 必须跳过 readonly 字段（编号）；否则编辑保存必 400');
});
