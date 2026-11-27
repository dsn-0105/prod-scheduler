'use strict';
/* ================================================================
   tests/harness/build.js —— 权威水印单一来源（build 2026-10-06.135 新增）
   ================================================================
   背景：index.html 末尾的权威水印 `<div …>build YYYY-MM-DD.NNN</div>` 被多处测试断言，
        此前每个测试文件各自**硬编码字面量**（如 `>build 2026-10-06.134<`）。每次版本推进
        都要在多处手工同步，漏改一处就出现「新源码 + 旧测试锚点」的中间态假失败
        （.133→.134 已发生过一次）。故抽出本文件作**单一来源**。

   用法：
     const { BUILD, PREV } = require('./harness/build');
     assert.equal((INDEX_SRC.match(new RegExp('>build '+BUILD.replace('.','\\.')+'<','g'))||[]).length, 1);

   版本推进纪律（**值来自单一真源；不要手改下面两行常量**）：
     · 真源 = 仓库根 `VERSION`（`BUILD=` / `PREV=` 行），与 index.html **物理独立**；改版本只改它，
       再执行 `node scripts/version.js sync` 由脚本代笔写回全部落点（写完自动 `check` 自证，钩子也拦）。
     · `PREV` 记为上一个版本号（供「旧形态应 0 处」断言引用）。
     · ★ **仍然严禁从 index.html 反推 BUILD**（原禁令的内核继续有效，不是被自动化废掉）：若 BUILD
       取自 index.html，`index.html 水印 == BUILD` 就退化成恒真断言、失去守卫意义。代笔**不违反**这条
       —— 值来自独立的 `VERSION`，脚本只负责搬运，两处物理来源的比对关系完整保留
       （`qa.parts-ledger.validate.159 §D3`、`qa.invfilt.161 §H2`、`qa.invfilt.162 §O2` 仍钉
       「本文件不得读盘取版本 / 不得 require 其它模块」，请勿破坏）。
     · ⚠ **除本文件外还有多处字面量副本**（.148 复核订正：原文为「1 处」，`.147` 新增
       `qa.prodplan-query` 后未同步计数，导致 `.148` 推进时该文件 §E2/§E4 会假失败；`.159`
       再次复核，实际副本清单见下，**缺一处即回归 FAIL**）：
       ① `tests/qa.ppshift-advance.independent.test.js` §E2（两处 assert 写死 BUILD/PREV）；
       ② `tests/qa.prodplan-query.independent.test.js` §E2 同款字面量**且** §E4（`js/guide.js`
          文首「更新：YYYY-MM-DD（build .NNN）」行）；③ `tests/layout.scoped.independent.test.js`
          §C5（水印正则 + BUILD/PREV 字面量）；④ `tests/qa.parts-ledger.independent.test.js`
          （.158 新增 QA 资产：本文件 BUILD/PREV**以及** §F1/F3/F4/F5/F6 的版本字面量副本）。
       以上 4 处用于反向防「测了个寂寞」，**一律由 `node scripts/version.js sync` 代笔，勿手改**（该脚本的
       `TARGETS` 数组是全仓库落点的唯一定义处，覆盖 `index.html` 水印、`README.md` 首屏、`js/guide.js`
       文首以及上述 4 个测试文件；**具体条数/处数请跑 `node scripts/version.js list`，本注释刻意不写死数字**
       —— 绝对计数会随新增测试文件腐化，.144/.148/.159 三次假失败都源于此）。**漏一处 → 回归 FAIL**（各版复核过）。
     · 📌 **`tests/parts.<NNN>.test.js` 这类 per-version 用例一律「派生」，不再手抄字面量**：.159 已把
       `parts.159.test.js` C7（吃 `build.buildMarkRe(build.BUILD)`）与 `parts.158.test.js` F1 改成派生写法。
       理由：per-version 文件每版新增一个，各自抄字面量＝每新增一个就多一处「下一版必红」的锚点（.144/.148 踩过）。
   ================================================================ */

const BUILD = '2026-11-27.167';
const PREV = '2026-11-27.166';

/* 生成「权威水印」正则：`>build <版本><`；`<` 是 deploy.sh 精确匹配的组成（防注释里同名文本误命中） */
function buildMarkRe(ver) {
  return new RegExp('>build ' + String(ver).replace(/\./g, '\\.') + '<', 'g');
}
/* 生成「任意形态出现次数」正则（不含 < 收尾），用于「旧版本残留应为 0」类断言 */
function buildAnyRe(ver) {
  return new RegExp('build ' + String(ver).replace(/\./g, '\\.'), 'g');
}

module.exports = { BUILD, PREV, buildMarkRe, buildAnyRe };
