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

   版本推进纪律（**只改本文件**）：
     · BUILD 前移为新版本号；
     · PREV  记为上一个版本号（供「旧形态应 0 处」断言引用）；
     · 二者**必须手写**，严禁从 index.html 反推 —— 否则断言退化为恒真、失去守卫意义。
   与 deploy.sh 的一致性：deploy.sh 用 `build [0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+<`
   从 index.html 提取版本，本文件的 BUILD 即该提取结果，二者必须相等（有测试锚点钉住）。
   ================================================================ */

const BUILD = '2026-10-07.137';
const PREV = '2026-10-07.136';

/* 生成「权威水印」正则：`>build <版本><`；`<` 是 deploy.sh 精确匹配的组成（防注释里同名文本误命中） */
function buildMarkRe(ver) {
  return new RegExp('>build ' + String(ver).replace(/\./g, '\\.') + '<', 'g');
}
/* 生成「任意形态出现次数」正则（不含 < 收尾），用于「旧版本残留应为 0」类断言 */
function buildAnyRe(ver) {
  return new RegExp('build ' + String(ver).replace(/\./g, '\\.'), 'g');
}

module.exports = { BUILD, PREV, buildMarkRe, buildAnyRe };
