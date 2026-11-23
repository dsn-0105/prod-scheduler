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

   版本推进纪律（**本文件为主来源，但非唯一改动点**）：
     · BUILD 前移为新版本号；
     · PREV  记为上一个版本号（供「旧形态应 0 处」断言引用）；
     · 二者**必须手写**，严禁从 index.html 反推 —— 否则断言退化为恒真、失去守卫意义。
     · ⚠ **另有多处硬编码字面量副本必须同步**（.148 复核订正：原文为「1 处」，`.147` 新增
       `qa.prodplan-query` 后未同步计数，导致 `.148` 推进时该文件 §E2/§E4 会假失败；
       `.159` 再次复核，实际副本清单见下，**缺一处即回归 FAIL**）：
       ① `tests/qa.ppshift-advance.independent.test.js` §E2（两处 assert 直接写死 BUILD/PREV 字符串）；
       ② `tests/qa.prodplan-query.independent.test.js` —— §E2（同款 BUILD/PREV 字面量）
          **且** §E4（`js/guide.js` 文首「更新：YYYY-MM-DD（build .NNN）」行字面量）；
       ③ `tests/layout.scoped.independent.test.js` §C5（水印正则 + BUILD/PREV 字面量）；
       ④ `tests/qa.parts-ledger.independent.test.js`（.158 新增的 QA 资产：本文件 BUILD/PREV
          **以及** §F1/F3/F4/F5/F6 的版本字面量副本）。
       以上 4 处用于反向防「测了个寂寞」，均需**手改**。**漏改任一处 → 回归 FAIL**
       （.144、.148、.159 各复核确认一次）。
     · 📌 **`tests/parts.<NNN>.test.js` 这类 per-version 用例一律「派生」，不再手抄字面量。**
       .159 已把 `parts.159.test.js` C7（改吃 `build.buildMarkRe(build.BUILD)`）与
       `parts.158.test.js` F1（吃 `build.BUILD` 的日期段 + `.NNN` 段）改成派生写法。
       理由：per-version 文件每版都会新增一个，若各自抄字面量，**每新增一个就多一处「下一版必红」的锚点**
       （.144/.148 正是被这种漂移坑过）。故上面的「4 处」是**稳定值**，不会随新增 per-version 文件增长。
       写新 per-version 用例时请照抄这两种派生写法，不要把版本号写死。
   与 deploy.sh 的一致性：deploy.sh 用 `build [0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+<`
   从 index.html 提取版本，本文件的 BUILD 即该提取结果，二者必须相等（有测试锚点钉住）。
   ================================================================ */

const BUILD = '2026-11-23.163';
const PREV = '2026-11-20.162';

/* 生成「权威水印」正则：`>build <版本><`；`<` 是 deploy.sh 精确匹配的组成（防注释里同名文本误命中） */
function buildMarkRe(ver) {
  return new RegExp('>build ' + String(ver).replace(/\./g, '\\.') + '<', 'g');
}
/* 生成「任意形态出现次数」正则（不含 < 收尾），用于「旧版本残留应为 0」类断言 */
function buildAnyRe(ver) {
  return new RegExp('build ' + String(ver).replace(/\./g, '\\.'), 'g');
}

module.exports = { BUILD, PREV, buildMarkRe, buildAnyRe };
