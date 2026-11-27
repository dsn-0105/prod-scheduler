'use strict';
/* ================================================================
   tests/qa.ledger-filter-sort.independent.test.js
   —— 异常台账「全列排序 + 全列筛选」（【build .166】）独立守卫
   ================================================================
   需求（用户 Q1A~Q5A 拍板）：仿照生产系统订单管理列表，9 列全部可排序、可筛选，
   且**漏斗大小与可视化风格与订单管理一致**。

   四类断言：
   §A  排序引擎：类型感知（num 按值 / text 按拼音 / date 按串）、**空值恒沉底**、
       不传 types 时与 .165 逐字等价（向后兼容，qa-core.test.js 那 25 条不能红）
   §B  筛选引擎：文本 8 模式 / 数字 6 模式（生产 4 + 为空/不为空）/ 日期 8 快捷模式逐条判定
   §C  多列 AND、无有效筛选返回全量、未声明列忽略
   §D  单源与「风格统一」：漏斗 SVG 与生产**逐字节对拍**、CSS 规则与生产**逐字对拍**、
       模式清单只来自 qa-core、筛选收尾只有一个入口（含变异注入验红）

   §D 为什么敢直接读生产 index.html：用户要求的是「跟订单管理一样」，
   这件事只有把两个文件放在一起比才算数；写成文本断言后，将来任一侧改动都会立刻红，
   逼人明确回答「是同步，还是放弃统一」——而不是靠谁的记性。
   ================================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const core = require(path.join(ROOT, 'quality', 'qa-core.js'));
const APP = fs.readFileSync(path.join(ROOT, 'quality', 'qa-app.js'), 'utf8');
const QA_HTML = fs.readFileSync(path.join(ROOT, 'quality', 'index.html'), 'utf8');
const PROD_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* 固定「今天」，避免用例随真实日期漂移 */
const TODAY = '2026-11-26';

/* ================================================================
   §A 排序引擎
   ================================================================ */

const SORT_FIXTURE = [
  { id: 'a', no: 'YC-20261126-00001', date: '2026-11-26', totalQty: 500, productName: '框架断路器' },
  { id: 'b', no: 'YC-20261126-00002', date: '2026-11-25', totalQty: 30, productName: '塑壳断路器' },
  { id: 'c', no: 'YC-20261126-00003', date: '2026-11-24' },                       /* totalQty / productName 均缺 */
  { id: 'd', no: 'YC-20261126-00004', date: '2026-11-23', totalQty: 5000, productName: '框架断路器' }
];
const NUM_TYPES = { totalQty: 'num' };
const ids = function (rows) { return rows.map(function (r) { return r.id; }); };

test('§A1 向后兼容：不传 types 时排 date/no 的老行为逐字不变（qa-core.test.js 25 条不许红）', function () {
  const out = core.sortRecords(SORT_FIXTURE, 'date', 'desc');
  assert.deepStrictEqual(ids(out), ['a', 'b', 'c', 'd'], '日期降序');
  const asc = core.sortRecords(SORT_FIXTURE, 'date', 'asc');
  assert.deepStrictEqual(ids(asc), ['d', 'c', 'b', 'a'], '日期升序');
});

test('§A2 未声明类型的 key 一律回落 date 白名单（传错 key 不该变成"静默按字符串排"）', function () {
  /* 不传 types 却传 totalQty ⇒ 必须按老规则当 date 处理（而不是按 totalQty 的字符串值） */
  const out = core.sortRecords(SORT_FIXTURE, 'totalQty', 'desc');
  assert.deepStrictEqual(ids(out), ['a', 'b', 'c', 'd'], '缺 types 时应回落 date DESC');
});

test('§A3 数字列按**数值**比较，不是字典序（否则 9 会排在 5000 后面）', function () {
  const out = core.sortRecords(SORT_FIXTURE, 'totalQty', 'asc', NUM_TYPES);
  assert.deepStrictEqual(ids(out), ['b', 'a', 'd', 'c'], '30 < 500 < 5000，缺值沉底；实际 ' + JSON.stringify(ids(out)));
});

test('§A4 空值**恒沉底**：升序降序都在最后（空≠0，不可被当成最小值）', function () {
  const asc = core.sortRecords(SORT_FIXTURE, 'totalQty', 'asc', NUM_TYPES);
  const desc = core.sortRecords(SORT_FIXTURE, 'totalQty', 'desc', NUM_TYPES);
  assert.strictEqual(asc[asc.length - 1].id, 'c', '升序空值应在末尾，实际 ' + JSON.stringify(ids(asc)));
  assert.strictEqual(desc[desc.length - 1].id, 'c', '降序空值应在末尾，实际 ' + JSON.stringify(ids(desc)));
  /* 反向自检：若哪天有人把空值当 0，降序时空值会跑到**最前** */
  assert.notStrictEqual(desc[0].id, 'c', '降序首行不得是空值记录（空值被当 0 的典型症状）');
});

test('§A5 文本列按 zh-CN 拼音序（与生产 cmpByColDef 同口径：框 kuang 在 塑 su 之前）', function () {
  const out = core.sortRecords(SORT_FIXTURE, 'productName', 'asc', { productName: 'text' });
  /* 同值「框架断路器」两条按二级键 no DESC ⇒ 00004(d) 在 00001(a) 之前；缺值 c 沉底 */
  assert.deepStrictEqual(ids(out), ['d', 'a', 'b', 'c'],
    '框架×2 应在塑壳之前、缺值沉底；实际 ' + JSON.stringify(ids(out)));
});

test('§A6 同值时二级键恒为 no DESC（全序稳定，翻页不会跳行）', function () {
  const out = core.sortRecords(SORT_FIXTURE, 'productName', 'asc', { productName: 'text' });
  assert.deepStrictEqual(ids(out).slice(0, 2), ['d', 'a'],
    '同为「框架断路器」时 no DESC：YC-…-00004 在 YC-…-00001 之前');
  /* 反向自检：升序主键 + 降序二级键，若有人把二级键也乘了 dir，顺序会翻成 a,d */
  assert.notDeepStrictEqual(ids(out).slice(0, 2), ['a', 'd'], '二级键不得随主键方向翻转');
});

test('§A7 排序返回新数组，绝不改入参顺序', function () {
  const before = ids(SORT_FIXTURE);
  core.sortRecords(SORT_FIXTURE, 'totalQty', 'asc', NUM_TYPES);
  assert.deepStrictEqual(ids(SORT_FIXTURE), before, '原数组顺序必须不变');
});

test('§A8 前端排序是三态循环：升 → 降 → 取消回默认（源码守卫）', function () {
  const body = fnBody(APP, 'function sortBy(');
  assert.ok(/state\.sortKey\s*!==\s*key/.test(body), 'sortBy 必须按「换了列」进入第一态');
  assert.ok(/state\.sortDir\s*===\s*'asc'/.test(body), 'sortBy 必须按 asc→desc 进入第二态');
  assert.ok(/'date'/.test(body) && /'desc'/.test(body), '第三态必须回到默认 date desc（不是清空 sortKey 让表格乱序）');
});

/* ================================================================
   §B 筛选引擎（单列逐条）
   ================================================================ */

test('§B1 文本 8 模式逐条判定（生产 ENH_FILT_MODES_LIST 同集）', function () {
  const v = '框架断路器 DW45';
  const cases = [
    ['contains', '断路器', true], ['contains', '塑壳', false],
    ['not_contains', '塑壳', true], ['not_contains', '断路器', false],
    ['eq', '框架断路器 DW45', true], ['eq', '框架', false],
    ['neq', '框架', true], ['neq', '框架断路器 DW45', false],
    ['startswith', '框架', true], ['startswith', '断路器', false],
    ['endswith', 'DW45', true], ['endswith', '框架', false]
  ];
  cases.forEach(function (c) {
    assert.strictEqual(core.matchFilter(v, 'text', { mode: c[0], val: c[1] }, TODAY), c[2],
      c[0] + '(' + c[1] + ') 应为 ' + c[2]);
  });
  /* 为空/不为空用**原始值**判：'0' 与 0 都算有值 */
  assert.strictEqual(core.matchFilter('', 'text', { mode: 'is_empty' }, TODAY), true);
  assert.strictEqual(core.matchFilter(null, 'text', { mode: 'is_empty' }, TODAY), true);
  assert.strictEqual(core.matchFilter('0', 'text', { mode: 'is_empty' }, TODAY), false, "'0' 不算空");
  assert.strictEqual(core.matchFilter('x', 'text', { mode: 'not_empty' }, TODAY), true);
});

test('§B2 数字 6 模式逐条判定（Q2A：生产 4 模式 + 为空/不为空）', function () {
  assert.strictEqual(core.matchFilter(500, 'num', { mode: 'gte', val: '100' }, TODAY), true);
  assert.strictEqual(core.matchFilter(50, 'num', { mode: 'gte', val: '100' }, TODAY), false);
  assert.strictEqual(core.matchFilter(50, 'num', { mode: 'lte', val: '100' }, TODAY), true);
  assert.strictEqual(core.matchFilter(500, 'num', { mode: 'lte', val: '100' }, TODAY), false);
  assert.strictEqual(core.matchFilter('500', 'num', { mode: 'eq', val: 500 }, TODAY), true, '字符串数字要按数值比');
  assert.strictEqual(core.matchFilter(500, 'num', { mode: 'neq', val: '500' }, TODAY), false);
  /* Q2A 的核心用途：台账数量列经常空着，要能筛出「还没填检测数」的记录 */
  assert.strictEqual(core.matchFilter(undefined, 'num', { mode: 'is_empty' }, TODAY), true);
  assert.strictEqual(core.matchFilter('', 'num', { mode: 'is_empty' }, TODAY), true);
  assert.strictEqual(core.matchFilter(0, 'num', { mode: 'is_empty' }, TODAY), false, '0 是有值，不是空');
  assert.strictEqual(core.matchFilter(500, 'num', { mode: 'not_empty' }, TODAY), true);
  /* 脏值 'abc' 视为空 */
  assert.strictEqual(core.matchFilter('abc', 'num', { mode: 'is_empty' }, TODAY), true, '非数字脏值按空处理');
});

test('§B3 日期 8 快捷模式（今天/本周/本月/上月/过去1月/过去3月/区间/等于）', function () {
  assert.strictEqual(core.matchFilter(TODAY, 'date', { mode: 'today' }, TODAY), true);
  assert.strictEqual(core.matchFilter('2026-11-25', 'date', { mode: 'today' }, TODAY), false);
  /* TODAY=2026-11-26 是周四 ⇒ 本周一 = 11-23 */
  assert.strictEqual(core.matchFilter('2026-11-23', 'date', { mode: 'this_week' }, TODAY), true, '周一属于本周');
  assert.strictEqual(core.matchFilter('2026-11-22', 'date', { mode: 'this_week' }, TODAY), false, '上周日不属于本周');
  assert.strictEqual(core.matchFilter('2026-11-01', 'date', { mode: 'this_month' }, TODAY), true);
  assert.strictEqual(core.matchFilter('2026-10-31', 'date', { mode: 'this_month' }, TODAY), false);
  assert.strictEqual(core.matchFilter('2026-10-15', 'date', { mode: 'last_month' }, TODAY), true);
  assert.strictEqual(core.matchFilter('2026-11-01', 'date', { mode: 'last_month' }, TODAY), false);
  assert.strictEqual(core.matchFilter('2026-10-27', 'date', { mode: 'last_1m' }, TODAY), true);
  assert.strictEqual(core.matchFilter('2026-10-25', 'date', { mode: 'last_1m' }, TODAY), false, '过去一个月下界=2026-10-26');
  assert.strictEqual(core.matchFilter('2026-08-27', 'date', { mode: 'last_3m' }, TODAY), true);
  assert.strictEqual(core.matchFilter('2026-08-26', 'date', { mode: 'last_3m' }, TODAY), true, '下界本身包含在内（>=）');
  assert.strictEqual(core.matchFilter('2026-08-25', 'date', { mode: 'last_3m' }, TODAY), false, '过去三个月下界=2026-08-26');
  assert.strictEqual(core.matchFilter('2026-11-10', 'date', { mode: 'range', from: '2026-11-01', to: '2026-11-15' }, TODAY), true);
  assert.strictEqual(core.matchFilter('2026-11-20', 'date', { mode: 'range', from: '2026-11-01', to: '2026-11-15' }, TODAY), false);
  assert.strictEqual(core.matchFilter('2026-11-10', 'date', { mode: 'eq', val: '2026-11-10' }, TODAY), true);
});

test('§B4 无效筛选（mode 缺失 / 需要值但值为空）⇒ 一律放行，不得把整表筛没', function () {
  assert.strictEqual(core.filtActive(null), false);
  assert.strictEqual(core.filtActive({ mode: 'contains', val: '' }), false, '空关键字不算筛选');
  assert.strictEqual(core.filtActive({ mode: 'is_empty' }), true, '为空模式无需值也有效');
  assert.strictEqual(core.filtActive({ mode: 'range', from: '', to: '' }), false, '区间缺端点不算筛选');
  assert.strictEqual(core.matchFilter('任意', 'text', { mode: 'contains', val: '' }, TODAY), true);
});

/* ================================================================
   §C 多列 AND
   ================================================================ */

test('§C1 多列筛选取交集（AND），无有效筛选时返回全量', function () {
  const schema = [
    { key: 'totalQty', type: 'num' },
    { key: 'productName', type: 'text' },
    { key: 'date', type: 'date' }
  ];
  const only = core.applyFilters(SORT_FIXTURE, schema, { totalQty: { mode: 'gte', val: '100' } }, TODAY);
  assert.deepStrictEqual(ids(only), ['a', 'd']);

  const and = core.applyFilters(SORT_FIXTURE, schema, {
    totalQty: { mode: 'gte', val: '100' },
    productName: { mode: 'contains', val: '框架' }
  }, TODAY);
  assert.deepStrictEqual(ids(and), ['a', 'd'], '两列都满足才留');

  const none = core.applyFilters(SORT_FIXTURE, schema, {
    totalQty: { mode: 'gte', val: '99999' }
  }, TODAY);
  assert.deepStrictEqual(ids(none), [], '无交集返回空数组');

  const all = core.applyFilters(SORT_FIXTURE, schema, {}, TODAY);
  assert.deepStrictEqual(ids(all), ['a', 'b', 'c', 'd'], '无筛选返回全部');
  assert.notStrictEqual(all, SORT_FIXTURE, '必须返回新数组（调用方会排序，不能污染原数组）');
});

test('§C2 筛选条件里的未知列 key 被忽略（脏筛选不得把整表清空）', function () {
  const schema = [{ key: 'totalQty', type: 'num' }];
  const out = core.applyFilters(SORT_FIXTURE, schema, { notAColumn: { mode: 'eq', val: 'x' } }, TODAY);
  assert.deepStrictEqual(ids(out), ['a', 'b', 'c', 'd']);
});

test('§C3 筛选 + 排序组合（先筛后排）与界面展示顺序一致', function () {
  const schema = [{ key: 'totalQty', type: 'num' }];
  const filtered = core.applyFilters(SORT_FIXTURE, schema, { totalQty: { mode: 'gte', val: '100' } }, TODAY);
  const sorted = core.sortRecords(filtered, 'totalQty', 'desc', { totalQty: 'num' });
  assert.deepStrictEqual(ids(sorted), ['d', 'a'], '筛选后降序：5000 在 500 前');
});

/* ================================================================
   §D 单源与「视觉统一」（与生产系统对拍）
   ================================================================ */

test('§D1 漏斗 SVG 与生产订单管理列表**逐字节一致**（含 12×12 行内尺寸）', function () {
  const re = /var FILT_SVG\s*=\s*'([^']+)'/;
  const qa = re.exec(APP);
  const prod = /var FILT_SVG\s*=\s*'([^']+)'/.exec(PROD_HTML);
  assert.ok(qa, 'quality/qa-app.js 必须定义 FILT_SVG');
  assert.ok(prod, '生产 index.html 必须仍有 FILT_SVG（本用例以它为视觉基准）');
  assert.strictEqual(qa[1], prod[1],
    '漏斗 SVG 必须与生产逐字节相同（用户要求「漏斗大小跟订单管理一样」）');
  assert.ok(/style="width:12px;height:12px"/.test(qa[1]), '尺寸必须是行内 12×12（不靠 CSS 兜底）');
  assert.ok(/stroke-width="2"/.test(qa[1]), '描边粗细与生产一致');
});

/** 提取单个 CSS 规则体（只匹配**单选择器**写法，多选择器规则另测） */
function cssRule(html, sel) {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(esc + '\\s*\\{([^}]*)\\}').exec(html);
  return m ? m[1].trim() : null;
}

test('§D2 筛选相关 CSS 规则体与生产**逐字相同**（统一视觉风格的可执行契约）', function () {
  const need = ['.filt-ico', '.filt-ico:hover', '.filt-ico.on', '.filt-pop', '.tbl-fbar', '.fchip',
    '.th-sort .th-flex', '.th-sort .th-label'];
  const bad = [];
  need.forEach(function (sel) {
    const q = cssRule(QA_HTML, sel);
    const p = cssRule(PROD_HTML, sel);
    assert.ok(p, '生产侧应有 ' + sel + ' 规则（视觉基准）');
    if (q !== p) bad.push(sel + ' 质量页=' + q + ' / 生产=' + p);
  });
  assert.deepStrictEqual(bad, [], '以下规则的样式与生产不一致 ⇒ ' + bad.join(' | '));
});

test('§D3 筛选模式清单只有一份（qa-app 不得自写模式字面量）', function () {
  /* qa-app 里可以出现模式名的地方只有「按类型取清单」的调用与少量判断，
     真正的清单与中文名一律来自 qa-core。这里守「不得新增一份清单数组」。 */
  assert.strictEqual(/'not_contains'\s*,\s*'不包含'/.test(APP), false,
    'qa-app.js 不得内联模式清单（必须用 CORE.filtModesOf）');
  assert.ok(APP.indexOf('CORE.filtModesOf(') >= 0, 'qa-app 必须从 CORE.filtModesOf 取模式清单');
  assert.ok(APP.indexOf('CORE.FILT_MODE_NAME') >= 0, 'chips 文案必须用 CORE.FILT_MODE_NAME（与面板同一份措辞）');
  assert.ok(APP.indexOf('CORE.modeNeedsVal(') >= 0, '输入框显隐判据必须用 CORE.modeNeedsVal（与 filtActive 同源）');
});

test('§D4 筛选收尾只有一个入口 afterFiltChange（关浮层→清隐藏选中→回第1页）', function () {
  const body = fnBody(APP, 'function afterFiltChange(');
  assert.ok(body.indexOf('closeFilt()') >= 0, '收尾必须先关浮层');
  assert.ok(body.indexOf('pruneSelToVisible()') >= 0, '收尾必须清掉被筛掉的勾选（Q4A）');
  assert.ok(body.indexOf('state.page = 1') >= 0, '收尾必须回第 1 页');

  /* 三个入口都必须走它，不许自己拼步骤 */
  ['function clearFilt(', 'function clearAllFilt(', 'function applyFilt('].forEach(function (sig) {
    const b = fnBody(APP, sig);
    assert.ok(b.indexOf('afterFiltChange()') >= 0, sig + ' 必须调 afterFiltChange() 收尾');
  });

  /* 排序不改变可见集合 ⇒ 不许顺手清选中（清了会让"排个序勾选全丢"） */
  const sb = fnBody(APP, 'function sortBy(');
  assert.strictEqual(sb.indexOf('pruneSelToVisible'), -1, 'sortBy 不得清选中');
});

test('§D5 漏斗点亮判据与筛选有效性同源（禁在 sortTh 里另写一套）', function () {
  const body = fnBody(APP, 'function sortTh(');
  assert.ok(body.indexOf('CORE.filtActive(') >= 0,
    'thCol 等价物 sortTh 必须用 CORE.filtActive 判定点亮 —— 生产 .161 就栽在'
    + '「筛选条放行」与「漏斗点亮」各写一份，出现「筛了但图标不亮」');
  assert.strictEqual(/\.val\s*!==\s*''/.test(body), false, 'sortTh 内不得手写 val 非空判断（那是第二份判据）');
});

test('§D6 9 列全部可排序（用户要求"所有字段都能排序"）', function () {
  const block = APP.slice(APP.indexOf('var QA_COLUMNS = ['), APP.indexOf('\n  ];', APP.indexOf('var QA_COLUMNS = [')));
  const keys = (block.match(/\{\s*key:\s*'([A-Za-z]+)'/g) || []).map(function (s) {
    return s.replace(/\{\s*key:\s*'/, '').replace(/'$/, '');
  });
  assert.strictEqual(keys.length, 9, '应有 9 列，实际 ' + keys.length);
  const notSortable = keys.filter(function (k) {
    const at = block.indexOf("key: '" + k + "'");
    const seg = block.slice(at, block.indexOf('\n', at));
    return seg.indexOf('sortable: true') < 0;
  });
  assert.deepStrictEqual(notSortable, [], '以下列缺 sortable: true ⇒ ' + notSortable.join(','));
});

test('§D7 变异注入：删掉 afterFiltChange 里的 pruneSelToVisible，§D4 判据必须变红', function () {
  const needle = '    pruneSelToVisible();                   /* Q4A：被筛掉的行不得继续处于选中态 */';
  assert.strictEqual(countOcc(APP, needle), 1, '变异锚点必须命中恰 1 处');
  const mutated = APP.replace(needle, '    /* 注入：故意去掉清选中 */');
  assert.notStrictEqual(mutated, APP, '变异注入必须生效');
  const body = fnBody(mutated, 'function afterFiltChange(');
  assert.strictEqual(body.indexOf('pruneSelToVisible()') >= 0, false,
    '注入后判据必须能识别（否则 §D4 是「写了但永远绿」）');
});

/* ================================================================
   小工具
   ================================================================ */

/** 取函数体（从签名到下一个 2 空格缩进的 `}`） */
function fnBody(src, signature) {
  const i = src.indexOf(signature);
  assert.ok(i > 0, '找不到 ' + signature);
  const rest = src.slice(i);
  const end = rest.indexOf('\n  }');
  assert.ok(end > 0, '无法定位 ' + signature + ' 的函数体结尾');
  return rest.slice(0, end);
}

function countOcc(hay, needle) {
  return String(hay).split(String(needle)).length - 1;
}
