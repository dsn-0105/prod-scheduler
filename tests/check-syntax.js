'use strict';
/* ================================================================
   tests/check-syntax.js —— 逐文件 + 逐内联块语法校验（收尾动作）
   ================================================================
   为什么需要它：index.html 的 3 块内联 <script> **不经过 `node --check index.html`**，
   而历史上出现过「Edit 报告成功但磁盘未生效 / 漏改一处调用点」的事故。收尾时对
   「js/*.js 直接校验 + index.html 内联块逐块提取校验」是成本最低的兜底。

   ⚠️ 它只校验**语法**，不校验引用（未定义变量、拼写错都会被放过）——引用正确性靠
      `node --test` 的沙箱装载（装载即求值，未定义会立刻抛）。两者互补，都要跑。

   运行：node tests/check-syntax.js     退出码 0=全绿；1=有语法错误
   ================================================================ */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { extractInlineScripts, ROOT } = require('./harness/sandbox');

const files = ['js/logs.js', 'js/import.js', 'js/transfer.js', 'js/guide.js', 'js/prodplan-core.js'];
let fail = 0;

function checkFile(abs, label) {
  try {
    execFileSync(process.execPath, ['--check', abs], { stdio: 'pipe' });
    console.log('OK   ' + label);
    return true;
  } catch (e) {
    fail++;
    console.log('FAIL ' + label);
    console.log(String(e.stderr || e.message));
    return false;
  }
}

console.log('=== 1) js/*.js ===');
for (const rel of files) checkFile(path.join(ROOT, rel), rel);

console.log('');
console.log('=== 2) index.html 内联 script（逐块提取后 node --check） ===');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const blocks = extractInlineScripts(html);
console.log('inline <script> blocks found: ' + blocks.length);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inl-'));
blocks.forEach((b, i) => {
  const tmp = path.join(tmpDir, 'block' + i + '.js');
  fs.writeFileSync(tmp, b.code, 'utf8');
  checkFile(tmp, 'index.html inline #' + i + ' (lines ' + b.startLine + '-' + b.endLine + ', ' + b.code.split('\n').length + ' lines)');
});
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log('');
console.log('=== 3) 内联块 bootstrap() 自动执行点 ===');
blocks.forEach((b, i) => {
  const has = /(^|\n)[ \t]*bootstrap\(\)[ \t]*;/.test(b.code);
  console.log('inline #' + i + ' bootstrap()=' + has);
});

console.log('');
console.log(fail === 0 ? 'ALL SYNTAX OK' : 'SYNTAX FAILURES: ' + fail);
process.exit(fail === 0 ? 0 : 1);
