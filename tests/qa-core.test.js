'use strict';
/* ============================================================
   tests/qa-core.test.js —— 质量系统共享内核 quality/qa-core.js 直测
   ------------------------------------------------------------
   【build .163】为什么这个文件必须存在（设计 §1.2.6d）：
   编号是**全系统唯一不可事后修改**的数据。F5 单源发号必须有直测，
   否则重号要到线上才发现（而重号无法修：编号一旦发出去就不可改）。

   覆盖清单（逐条对应设计 §1.2.6d）：
     · nextQaNo：跨日发号 / max+1 / padStart(5) / while 去重兜底 / 同日不串号 / 乱序输入
     · isValidDate：2026-02-31 拒绝、2027-02-29 拒绝、闰年 2028-02-29 通过
     · buildNo / isValidNo / todayStr（本地时区，不用 toISOString）
     · sortRecords（日期 DESC、二级键恒 DESC、不改原数组）
     · paginate（越界夹紧、total=0 边界、size 白名单）
     · buildCsv（UTF-8 BOM 前缀、CRLF、引号转义）

   运行：node --test tests/qa-core.test.js
   边界：纯函数，零 IO、零网络、不 require 任何生产代码。
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const core = require(path.join(ROOT, 'quality', 'qa-core.js'));

/** 造一条只带 no 的最小记录（nextQaNo 只关心 no） */
function withNo(list) {
  return list.map(function (no) { return { no: no }; });
}

/* ============================================================
   1) 常量：UI 与后端共用的单一来源
   ============================================================ */
test('常量：NO_PREFIX / DEFAULT_PAGE_SIZE / PAGE_SIZES 与设计一致', function () {
  assert.strictEqual(core.NO_PREFIX, 'YC');
  assert.strictEqual(core.DEFAULT_PAGE_SIZE, 100);
  assert.deepStrictEqual(core.PAGE_SIZES, [10, 100, 1000]);
  assert.ok(core.NO_PATTERN instanceof RegExp, 'NO_PATTERN 应导出正则（前端做即时校验要用）');
});

/* ============================================================
   2) todayStr：必须按**本地时区**拼，不能用 toISOString().slice(0,10)
   ============================================================ */
test('todayStr：本地时区口径（23:30 与 00:10 都不得跨日）', function () {
  /* 用本地构造器造时刻：这些断言在任何时区下都成立；
     若实现改用 toISOString()，东八区 00:10 会算成前一天、UTC-x 的 23:30 会算成后一天 */
  assert.strictEqual(core.todayStr(new Date(2026, 10, 3, 23, 30, 0)), '2026-11-03');
  assert.strictEqual(core.todayStr(new Date(2026, 10, 3, 0, 10, 0)), '2026-11-03');
  assert.strictEqual(core.todayStr(new Date(2026, 0, 1, 0, 0, 0)), '2026-01-01');
  assert.strictEqual(core.todayStr(new Date(2026, 11, 31, 23, 59, 59)), '2026-12-31');
  /* 月/日必须两位补零（否则 '2026-1-1' 会破坏编号段） */
  assert.match(core.todayStr(new Date(2026, 0, 5)), /^\d{4}-01-05$/);
  /* 缺省参数 = 当前时刻，形状合法 */
  assert.match(core.todayStr(), /^\d{4}-\d{2}-\d{2}$/);
});

/* ============================================================
   3) buildNo：'YC-' + 日期去横线 + 5 位补零序号
   ============================================================ */
test('buildNo：padStart(5) 补零 / 超 5 位不截断 / 非法序号退化为 0', function () {
  assert.strictEqual(core.buildNo('2026-11-23', 1), 'YC-20261123-00001');
  assert.strictEqual(core.buildNo('2026-11-23', 5), 'YC-20261123-00005');
  assert.strictEqual(core.buildNo('2026-11-23', 42), 'YC-20261123-00042');
  assert.strictEqual(core.buildNo('2026-11-23', 99999), 'YC-20261123-99999');
  /* 超 5 位不得截断（截断会造成重号，是比格式不合法更严重的问题） */
  assert.strictEqual(core.buildNo('2026-11-23', 123456), 'YC-20261123-123456');
  assert.strictEqual(core.buildNo('2026-11-23', -3), 'YC-20261123-00000');
  assert.strictEqual(core.buildNo('2026-11-23', 'x'), 'YC-20261123-00000');
});

test('isValidNo：只认 /^YC-\\d{8}-\\d{5}$/', function () {
  assert.strictEqual(core.isValidNo('YC-20261123-00001'), true);
  assert.strictEqual(core.isValidNo('YC-20261123-00000'), true);
  assert.strictEqual(core.isValidNo('ZLWT-20261123-00001'), false, '前缀必须是大写 YC');
  assert.strictEqual(core.isValidNo('YC-2026-11-23-00001'), false, '日期段不得带横线');
  assert.strictEqual(core.isValidNo('YC-20261123-0001'), false, '序号必须 5 位');
  assert.strictEqual(core.isValidNo('YC-20261123-000011'), false, '序号超 6 位不合法');
  assert.strictEqual(core.isValidNo(' yc-20261123-00001'), false);
  assert.strictEqual(core.isValidNo('YC-20261123-00001 '), false);
  assert.strictEqual(core.isValidNo(null), false);
  assert.strictEqual(core.isValidNo(undefined), false);
  assert.strictEqual(core.isValidNo(20261123), false);
});

/* ============================================================
   4) isValidDate：格式 + 真实日历日往返校验
   ============================================================ */
test('isValidDate：真实日历日往返校验（拦格式对但日期不存在的输入）', function () {
  /* 合法 */
  assert.strictEqual(core.isValidDate('2026-11-23'), true);
  assert.strictEqual(core.isValidDate('2026-01-01'), true);
  assert.strictEqual(core.isValidDate('2026-12-31'), true);
  /* 设计 §1.2.6d 点名的三个 */
  assert.strictEqual(core.isValidDate('2026-02-31'), false, '2 月没有 31 日，必须拒绝');
  assert.strictEqual(core.isValidDate('2027-02-29'), false, '2027 不是闰年，必须拒绝');
  assert.strictEqual(core.isValidDate('2028-02-29'), true, '2028 是闰年，必须通过');
  /* 其它越界 */
  assert.strictEqual(core.isValidDate('2026-04-31'), false, '4 月只有 30 天');
  assert.strictEqual(core.isValidDate('2026-13-01'), false, '月份越界');
  assert.strictEqual(core.isValidDate('2026-00-10'), false, '月份 00 越界');
  assert.strictEqual(core.isValidDate('2026-11-00'), false, '日 00 越界');
  /* 格式类 */
  assert.strictEqual(core.isValidDate('2026-1-1'), false, '必须两位补零');
  assert.strictEqual(core.isValidDate('2026/11/23'), false);
  assert.strictEqual(core.isValidDate('2026-11-23T00:00:00'), false, '不接受带时间的串');
  assert.strictEqual(core.isValidDate(''), false);
  assert.strictEqual(core.isValidDate(null), false);
  assert.strictEqual(core.isValidDate(undefined), false);
  assert.strictEqual(core.isValidDate(20261123), false);
});

/* ============================================================
   5) nextQaNo：F5 单源发号（本文件最核心的一组）
   ============================================================ */
test('nextQaNo：空表 → 当日前缀 + 00001', function () {
  const now = new Date(2026, 10, 23, 10, 0, 0);
  assert.strictEqual(core.nextQaNo([], now), 'YC-20261123-00001');
  assert.strictEqual(core.nextQaNo(null, now), 'YC-20261123-00001', '非数组入参必须容忍');
  assert.strictEqual(core.nextQaNo(undefined, now), 'YC-20261123-00001');
});

test('nextQaNo：同日取 max+1（不是 count+1，也跳过空档）', function () {
  const now = new Date(2026, 10, 23, 10, 0, 0);
  assert.strictEqual(
    core.nextQaNo(withNo(['YC-20261123-00001', 'YC-20261123-00002']), now),
    'YC-20261123-00003');
  /* 有空档时仍取 max+1 —— 绝不回填空档（回填会与「删除后重号」混淆） */
  assert.strictEqual(
    core.nextQaNo(withNo(['YC-20261123-00002', 'YC-20261123-00007']), now),
    'YC-20261123-00008');
  /* 序号必须两位数以上时也正确补零 */
  assert.strictEqual(
    core.nextQaNo(withNo(['YC-20261123-00099']), now),
    'YC-20261123-00100');
});

test('nextQaNo：乱序输入结果与顺序无关', function () {
  const now = new Date(2026, 10, 23, 10, 0, 0);
  const shuffled = withNo([
    'YC-20261123-00003', 'YC-20261123-00001', 'YC-20261123-00009',
    'YC-20261123-00002', 'YC-20261123-00007', 'YC-20261123-00004',
    'YC-20261123-00006', 'YC-20261123-00005', 'YC-20261123-00008'
  ]);
  assert.strictEqual(core.nextQaNo(shuffled, now), 'YC-20261123-00010');
});

test('nextQaNo：跨日发号 —— 日期段取「发号当日」，与记录里的 date 无关', function () {
  const yesterday = withNo(['YC-20261122-00001', 'YC-20261122-00002', 'YC-20261122-00099']);
  const today = new Date(2026, 10, 23, 0, 1, 0);
  /* 库里只有昨天的号 ⇒ 今天从 00001 重新起（不是接着昨天的 00099 往下） */
  assert.strictEqual(core.nextQaNo(yesterday, today), 'YC-20261123-00001');
  /* 库里已有今天 3 条 + 昨天 99 条 ⇒ 今天取 00004（昨天的号不参与今天的 max） */
  const mixed = withNo([
    'YC-20261122-00001', 'YC-20261122-00099',
    'YC-20261123-00001', 'YC-20261123-00002', 'YC-20261123-00003'
  ]);
  assert.strictEqual(core.nextQaNo(mixed, today), 'YC-20261123-00004');
  /* 同一份数据、不同「发号时刻」⇒ 日期段不同：这就是跨零点的行为 */
  const midnight = new Date(2026, 10, 23, 23, 59, 59);
  const nextDay = new Date(2026, 10, 24, 0, 0, 1);
  assert.strictEqual(core.nextQaNo(mixed, midnight), 'YC-20261123-00004');
  assert.strictEqual(core.nextQaNo(mixed, nextDay), 'YC-20261124-00001');
});

test('nextQaNo：同日不串号 —— 同一快照连续调用必须返回同一个号', function () {
  const now = new Date(2026, 10, 23, 10, 0, 0);
  const list = withNo(['YC-20261123-00001', 'YC-20261123-00002']);
  const a = core.nextQaNo(list, now);
  const b = core.nextQaNo(list, now);
  assert.strictEqual(a, b, '函数必须是纯的：不发号、不改入参');
  assert.strictEqual(list.length, 2, '不得修改入参数组');
});

test('nextQaNo：while 去重兜底 —— 返回的号恒不在既有编号集合内', function () {
  /* 说明：max 扫描已覆盖所有合法同日编号，故 while 分支在正常数据下不可达，
     它是「文件被运维手工改过 / 未来实现漂移」的防御性兜底。
     这里用「乱序 + 重复 + 非法 no 混杂」的脏夹具断言**外部可观测契约**：绝不撞号。 */
  const now = new Date(2026, 10, 23, 10, 0, 0);
  const dirty = withNo([
    'YC-20261123-00005', 'YC-20261123-00005', 'garbage', '', 'YC-2026-11-23-00006',
    'YC-20261123-00004', null, 'YC-20261123-00001'
  ]);
  const got = core.nextQaNo(dirty, now);
  assert.strictEqual(got, 'YC-20261123-00006', '非法格式的 no 不参与 max（00005 重复仍算 max=5）');
  const usedSet = new Set(dirty.map(function (r) { return r && r.no; }));
  assert.strictEqual(usedSet.has(got), false, '返回的编号绝不能已在集合内');
});

test('nextQaNo：忽略非法格式的 no（脏数据不参与发号，也不阻塞发号）', function () {
  const now = new Date(2026, 10, 23, 10, 0, 0);
  const mixed = [
    { no: 'YC-20261123-00002' },
    { no: 'ZLWT-20261123-00999' },   /* 前缀不对 */
    { no: 'YC-20261122-00500' },     /* 日期不对（昨天） */
    { no: '' },
    { /* 根本没有 no */ },
    null,
    'string-record'
  ];
  assert.strictEqual(core.nextQaNo(mixed, now), 'YC-20261123-00003');
});

/* ============================================================
   6) sortRecords：日期 DESC，二级键恒 DESC，不改原数组
   ============================================================ */
const SORT_FIXTURE = [
  { id: 'a', no: 'YC-20261122-00002', date: '2026-11-22' },
  { id: 'b', no: 'YC-20261123-00001', date: '2026-11-23' },
  { id: 'c', no: 'YC-20261122-00001', date: '2026-11-22' },
  { id: 'd', no: 'YC-20261123-00003', date: '2026-11-23' },
  { id: 'e', no: 'YC-20261121-00009', date: '2026-11-21' }
];

test('sortRecords：缺省 date DESC + 二级键 no DESC', function () {
  const out = core.sortRecords(SORT_FIXTURE);
  assert.deepStrictEqual(out.map(function (r) { return r.id; }), ['d', 'b', 'a', 'c', 'e'],
    '日期倒序，同日按编号倒序');
  const out2 = core.sortRecords(SORT_FIXTURE, 'date', 'desc');
  assert.deepStrictEqual(out2.map(function (r) { return r.id; }), ['d', 'b', 'a', 'c', 'e']);
});

test('sortRecords：date ASC 时二级键仍恒为 DESC', function () {
  const out = core.sortRecords(SORT_FIXTURE, 'date', 'asc');
  assert.deepStrictEqual(out.map(function (r) { return r.id; }), ['e', 'a', 'c', 'd', 'b'],
    '日期正序，同日仍按编号倒序（二级键不随 dir 翻转）');
});

test('sortRecords：按 no 排序时二级键是 date DESC', function () {
  const out = core.sortRecords(SORT_FIXTURE, 'no', 'desc');
  assert.deepStrictEqual(out.map(function (r) { return r.no; }), [
    'YC-20261123-00003', 'YC-20261123-00001', 'YC-20261122-00002', 'YC-20261122-00001', 'YC-20261121-00009'
  ]);
  const asc = core.sortRecords(SORT_FIXTURE, 'no', 'asc');
  assert.strictEqual(asc[0].no, 'YC-20261121-00009');
});

test('sortRecords：返回新数组，入参顺序不变（防前端排序后表格错乱）', function () {
  const before = SORT_FIXTURE.map(function (r) { return r.id; }).join(',');
  const out = core.sortRecords(SORT_FIXTURE, 'date', 'asc');
  assert.notStrictEqual(out, SORT_FIXTURE, '必须是新数组');
  assert.strictEqual(SORT_FIXTURE.map(function (r) { return r.id; }).join(','), before, '入参不得被改动');
});

/* ============================================================
   7) paginate：越界夹紧，绝不返回空页
   ============================================================ */
function mkRows(n) {
  const out = [];
  for (let i = 1; i <= n; i++) out.push({ id: 'r' + i });
  return out;
}

test('paginate：total=0 边界 ⇒ {rows:[], page:1, pages:1}', function () {
  const r = core.paginate([], 1, 10);
  assert.deepStrictEqual(r, { rows: [], page: 1, pages: 1, total: 0 });
  /* 空表时任意 page 都夹到 1，不得出现 page=0 或 pages=0 */
  assert.deepStrictEqual(core.paginate([], 7, 100), { rows: [], page: 1, pages: 1, total: 0 });
  assert.deepStrictEqual(core.paginate(null, 3, 10), { rows: [], page: 1, pages: 1, total: 0 });
});

test('paginate：正常分页与最后一页不满页', function () {
  const rows = mkRows(25);
  const p1 = core.paginate(rows, 1, 10);
  assert.strictEqual(p1.page, 1);
  assert.strictEqual(p1.pages, 3);
  assert.strictEqual(p1.total, 25);
  assert.strictEqual(p1.rows.length, 10);
  assert.strictEqual(p1.rows[0].id, 'r1');
  const p3 = core.paginate(rows, 3, 10);
  assert.strictEqual(p3.rows.length, 5, '最后一页 5 条');
  assert.strictEqual(p3.rows[4].id, 'r25');
});

test('paginate：page 越界夹紧到 [1, pages]（不返回空页）', function () {
  const rows = mkRows(25);
  assert.strictEqual(core.paginate(rows, 99, 10).page, 3, 'page 超上限夹到 pages');
  assert.strictEqual(core.paginate(rows, 99, 10).rows.length, 5);
  assert.strictEqual(core.paginate(rows, 0, 10).page, 1, 'page=0 夹到 1');
  assert.strictEqual(core.paginate(rows, -5, 10).page, 1);
  assert.strictEqual(core.paginate(rows, NaN, 10).page, 1);
  assert.strictEqual(core.paginate(rows, 'abc', 10).page, 1);
  assert.strictEqual(core.paginate(rows, '2', 10).page, 2, '数字字符串应可用');
});

test('paginate：size 只认 10/100/1000，其余回落默认 100', function () {
  const rows = mkRows(250);
  assert.strictEqual(core.paginate(rows, 1, 1000).rows.length, 250);
  assert.strictEqual(core.paginate(rows, 1, 10).rows.length, 10);
  assert.strictEqual(core.paginate(rows, 1, 100).pages, 3);
  /* 非法 size 回落 DEFAULT_PAGE_SIZE */
  assert.strictEqual(core.paginate(rows, 1, 20).rows.length, 100);
  assert.strictEqual(core.paginate(rows, 1, 0).rows.length, 100);
  assert.strictEqual(core.paginate(rows, 1, undefined).rows.length, 100);
});

/* ============================================================
   8) buildCsv：UTF-8 BOM + CRLF + 转义
   ============================================================ */
test('buildCsv：首字符必须是 UTF-8 BOM（否则 Excel 打开乱码）', function () {
  const csv = core.buildCsv([{ date: '2026-11-23', no: 'YC-20261123-00001' }]);
  assert.strictEqual(csv.charCodeAt(0), 0xfeff, '首字符必须是 BOM');
  assert.strictEqual(csv.slice(0, 1), '\ufeff');
  assert.ok(csv.indexOf('\r\n') > 0, '必须用 CRLF 换行');
  assert.ok(csv.indexOf('\n') === -1 || csv.indexOf('\r\n') >= 0);
});

test('buildCsv：缺省列 = 日期 / 编号，且 date/no 原样输出', function () {
  const csv = core.buildCsv([
    { date: '2026-11-23', no: 'YC-20261123-00002' },
    { date: '2026-11-22', no: 'YC-20261122-00001' }
  ]);
  const lines = csv.replace(/^\ufeff/, '').split('\r\n').filter(function (l) { return l !== ''; });
  assert.deepStrictEqual(lines, ['日期,编号', '2026-11-23,YC-20261123-00002', '2026-11-22,YC-20261122-00001']);
  assert.ok(csv.indexOf('="') === -1, '不得给 date/no 加 ="…" 前缀（Excel 会显示公式痕迹）');
  assert.ok(csv.indexOf('\t') === -1, '不得用制表符分隔');
});

test('buildCsv：含逗号 / 双引号 / 换行的字段必须加引号并转义', function () {
  const cols = [{ key: 'date', label: '日期' }, { key: 'note', label: '备注', get: function (r) { return r.note; } }];
  const csv = core.buildCsv([
    { date: '2026-11-23', note: '带,逗号' },
    { date: '2026-11-23', note: '带"引号' },
    { date: '2026-11-23', note: '带\n换行' }
  ], cols);
  assert.ok(csv.indexOf('"带,逗号"') > 0, '含逗号需整体加引号');
  assert.ok(csv.indexOf('"带""引号"') > 0, '内部双引号需转义为两个双引号');
  assert.ok(csv.indexOf('"带\n换行"') > 0, '含换行需整体加引号');
});

test('buildCsv：空数组只出表头；null/undefined 字段输出空串', function () {
  const empty = core.buildCsv([]);
  assert.strictEqual(empty, '\ufeff日期,编号\r\n');
  const csv = core.buildCsv([{ date: '2026-11-23' }]);
  const lines = csv.replace(/^\ufeff/, '').split('\r\n');
  assert.strictEqual(lines[1], '2026-11-23,', '缺 no 时输出空串，不得出现 undefined');
  assert.ok(csv.indexOf('undefined') === -1);
});

/* ============================================================
   9) 前后端一致性契约：UMD 双形态（Node 侧）
   ============================================================ */
test('UMD：Node require 得到函数表，且不挂全局 window 依赖', function () {
  assert.strictEqual(typeof core.nextQaNo, 'function');
  assert.strictEqual(typeof core.todayStr, 'function');
  assert.strictEqual(typeof core.buildCsv, 'function');
  assert.strictEqual(typeof core.paginate, 'function');
  assert.strictEqual(typeof core.sortRecords, 'function');
  assert.strictEqual(typeof core.isValidDate, 'function');
  assert.strictEqual(typeof core.isValidNo, 'function');
  assert.strictEqual(typeof core.buildNo, 'function');
  /* 内核不得触碰 DOM：Node 环境下没有 document，能把所有函数跑通即证明无 DOM 依赖 */
  ['todayStr', 'buildNo', 'isValidNo', 'isValidDate', 'nextQaNo', 'sortRecords', 'paginate', 'buildCsv']
    .forEach(function (k) {
      assert.strictEqual(typeof core[k], 'function', k + ' 必须是纯函数');
    });
});
