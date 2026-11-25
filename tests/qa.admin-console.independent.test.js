'use strict';
/* ============================================================
   tests/qa.admin-console.independent.test.js
   —— 管理员后台（/admin/）· build .164 的**独立**回归与守卫
   ------------------------------------------------------------
   【为什么必须新建（不复用工程师的自证脚本）】
   .164 是本项目第一次把一整块业务功能（员工管理 + 权限面板）从生产单文件
   index.html **搬到独立页面**，同时新增一条「后台页面 → 生产后端」的
   跨文件契约（GET /api/perm-meta）。这类改动有三重风险，既有 50 个测试文件
   一个都覆盖不到：

     ① 搬错/漏搬：员工管理函数删了一半、`case 'users'` 留在 renderContent、
        NAV 里 users 项复活 —— 生产单页会出现「点了没反应」或「未知模块」，
        任何纯文本断言都看不见（因为函数被删了，语法照样通过）；
     ② 门禁失守：`.164` 之前「员工列表」与「权限面板」长在**已鉴权的生产页**里，
        角色判定只靠一行 renderNav 过滤；搬到独立页后，页面自己必须
        「非管理员一个管理员接口都不调」。这条一旦写错（例如先拉 /api/users
        再判角色），非管理员浏览器里就会出现员工名单 —— 文本级测试永远发现不了；
     ③ 双份权限清单漂移：index.html 的 PERM_FORMS/FORM_ACTS 与后端 PERM_META
        是**两份必须逐字一致**的副本，且 nav/guide/README/build.js 的版本锚点
        又各有副本。历史上 .144/.148/.159 都被这类漂移坑过。

   测什么（A~H 八组，逐条独立口径，全部由本文件自己实现判定）：
     A 后台页面结构（文本级）：单脚本、三件套、CSS 前提、水印、无改密入口
     B 三副本 SYSTEMS 一致（index.html / quality/qa-app.js / admin/admin-app.js）
     C 门禁行为（自建 DOM 桩 + 假 fetch，**真跑 boot 流程**）：
         非管理员 / 无 token / 管理员正常 / perm-meta 404 降级 / 401 清 token
     D 生产侧已下线（负向）：员工管理函数与 NAV 项不得复活；pwdModal 不得误删
     E 权限元数据一致性：形状 + 与 HEAD 版 PERM_FORMS 逐键 + 与运行时
       formToKey / FORM_ACTS 逐键；后台不得自建第二份清单
     F 服务端端点权限（真起临时 HTTP 服务，高位端口）
     G 部署资产（nginx 片段 / deploy-admin.sh 文本级 + bash -n）
     H 版本与文档锚点互证（全部派生，禁手抄字面量）

   断言标记（纪律要求逐条可辨）：
     【契约】= PRD / 设计 / 用户拍板规定的行为，不符即产品缺陷。
     【快照】= 当前实现的既定事实（数量、序号），随版本可能变，变了要人判断，
               不一定是缺陷 —— 但**不得**悄悄改成恒真。

   运行：node --test tests/qa.admin-console.independent.test.js
   边界：
     · 不启动浏览器、不跑 deploy-admin.sh（只做 `bash -n` 静态语法检查）、不访问网络；
     · require 生产后端时数据/用户文件路径已指向**仓库内临时目录**
       （不读不写真实 server/data.json · server/users.json，并在 §F4 用 md5 自证）；
     · 不修改任何产品代码；本文件只读产品源码 + 起一个 127.0.0.1 的临时 HTTP 服务。
   ============================================================ */

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const { ROOT, extractInlineScripts } = require('./harness/sandbox');
const domStub = require('./harness/dom-stub');
const build = require('./harness/build');

/* ============================================================
   通用工具（本文件独立实现，不复用工程师的任何临时脚本）
   ============================================================ */
const md5 = function (s) { return crypto.createHash('md5').update(String(s), 'utf8').digest('hex'); };
const readRel = function (rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); };
const countOcc = function (hay, needle) {
  const h = String(hay); const n = String(needle);
  if (!h || !n) return 0;
  let c = 0; let i = 0;
  while ((i = h.indexOf(n, i)) >= 0) { c++; i += n.length; }
  return c;
};
const countRe = function (hay, re) { return (String(hay).match(new RegExp(re.source, 'g')) || []).length; };
const plain = function (v) { return JSON.parse(JSON.stringify(v)); };
const git = function (args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
};
/* git show 取的 blob 恒为 LF，工作树可能是 CRLF —— 比内容时先归一化行尾 */
const normEol = function (s) { return String(s).replace(/\r\n/g, '\n'); };

/**
 * 去掉 HTML 注释（`<!-- … -->`）。用于「注释里允许提旧措辞、代码里不许」类断言。
 * @param {string} html
 * @returns {string}
 */
function stripHtmlComments(html) { return String(html).replace(/<!--[\s\S]*?-->/g, ''); }

/**
 * 字符串 / **正则字面量** 感知的 JS 注释剥离器（`//` 与 `/* *\/`）。
 * 为什么必须感知正则字面量：admin-app.js 的 esc() 里就有 `/[&<>"']/g` —— 朴素扫描器
 * 会把 `"` 当成字符串起点，从此与源码失同步，后面所有「注释里允许、代码里禁止」的
 * 判定都会静默失真（本文件首版实测到过：line 254 的注释被当成字符串内容吃掉了）。
 * 判定口径：`/` 的前一个**有效字符**属于 ( , = : [ ! & | ? { } ; + - * % ~ ^ < > 或前一个是
 * return/typeof/… 等关键字 → 视为正则字面量起点，否则视为除号。
 * 局限（明确声明）：不做完整语法分析；本文件只用它做**负向**断言（不得出现 X），
 * 正向断言另有独立兜底，故此局限不会造成漏报以外的风险。
 * @param {string} src
 * @returns {string}
 */
const REGEX_PREV_CHARS = '(,=:[!&|?{};+-*%~^<>[';
const REGEX_PREV_WORDS = ['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else', 'yield', 'await'];
function stripJsComments(src) {
  const s = String(src);
  let out = '';
  let i = 0;
  let state = null;
  let prevSig = '';
  let prevWord = '';
  while (i < s.length) {
    const ch = s[i];
    const nx = s[i + 1];
    if (state === null) {
      if (ch === '/' && nx === '/') { state = 'line'; i += 2; continue; }
      if (ch === '/' && nx === '*') { state = 'block'; i += 2; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { state = ch; out += ch; i++; continue; }
      if (ch === '/') {
        const isRegex = prevSig === '' || REGEX_PREV_CHARS.indexOf(prevSig) >= 0 || REGEX_PREV_WORDS.indexOf(prevWord) >= 0;
        if (isRegex) {
          out += ch; i++;
          let inClass = false;
          while (i < s.length) {
            const c = s[i];
            out += c;
            if (c === '\\') { if (s[i + 1] !== undefined) out += s[i + 1]; i += 2; continue; }
            if (c === '[') inClass = true;
            else if (c === ']') inClass = false;
            else if (c === '/' && !inClass) { i++; break; }
            i++;
          }
          prevSig = '/'; prevWord = '';
          continue;
        }
        out += ch; prevSig = ch; prevWord = ''; i++; continue;
      }
      out += ch;
      if (!/\s/.test(ch)) {
        prevSig = ch;
        prevWord = /[A-Za-z_$]/.test(ch) ? (prevWord + ch) : '';
      }
      i++;
      continue;
    }
    if (state === 'line') { if (ch === '\n') { state = null; out += ch; prevSig = '\n'; prevWord = ''; } i++; continue; }
    if (state === 'block') { if (ch === '*' && nx === '/') { state = null; i += 2; } else i++; continue; }
    if (ch === '\\') { out += ch + (nx === undefined ? '' : nx); i += 2; continue; }
    if (ch === state) state = null;
    out += ch; i++;
  }
  return out;
}

/**
 * HTML 的**可见文本 + 内联事件属性**（去掉 HTML 注释、<style>、<script> 内容）。
 * 用于「用户/浏览器看得见或能触发的东西」类断言 —— CSS 与注释里的同名词不参与判定。
 * @param {string} html
 * @returns {string}
 */
function htmlVisibleText(html) {
  return stripHtmlComments(String(html))
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '');
}

/**
 * 从 anchor 之后第一个 `{` 开始做**字符串感知**的大括号配平，返回整块文本。
 * @param {string} code 已剥注释的 JS
 * @param {string} anchor 锚点（如 'if (j.mustChangePwd)'）
 * @returns {{text:string, start:number, end:number}}
 */
function extractBracedBlock(code, anchor) {
  const at = String(code).indexOf(anchor);
  assert.ok(at >= 0, '必须能定位锚点：' + anchor);
  let i = code.indexOf('{', at);
  assert.ok(i > at, '锚点之后必须有大括号：' + anchor);
  const start = at;
  let depth = 0;
  let state = null;
  for (; i < code.length; i++) {
    const ch = code[i];
    if (state) {
      if (ch === '\\') { i++; continue; }
      if (ch === state) state = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { state = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return { text: code.slice(start, i + 1), start: start, end: i }; }
  }
  assert.fail('大括号未闭合：' + anchor);
}

/**
 * index.html 的**可执行面**：所有内联 <script> 代码 + 所有内联事件属性（on*="…"）。
 * 这是「不得存在可执行引用」类断言的判定对象（注释与样式一律不参与）。
 * @param {string} html
 * @returns {string}
 */
function executableSurface(html) {
  const codes = extractInlineScripts(html).map(function (b) { return b.code; }).join('\n;\n');
  const handlers = [];
  const re = /\son[a-z]+\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(String(html))) !== null) handlers.push(m[1]);
  return stripJsComments(codes + '\n;\n' + handlers.join('\n;\n'));
}

/* ---------- 产品源码（一次性读取） ---------- */
const INDEX_SRC = readRel('index.html');
const INDEX_SRC_LF = normEol(INDEX_SRC);
const QA_APP_SRC = readRel('quality/qa-app.js');
const ADMIN_HTML = readRel('admin/index.html');
const ADMIN_APP_SRC = readRel('admin/admin-app.js');
const GUIDE_SRC = readRel('js/guide.js');
const README_SRC = readRel('README.md');
const NGINX_SNIPPET = readRel('ops/nginx-admin.conf');
const DEPLOY_SH = readRel('deploy-admin.sh');
const BUILD_JS_SRC = readRel('tests/harness/build.js');

/* ============================================================
   生产后端（PERM_META 的唯一权威来源）—— 装载前把数据/用户文件
   指向仓库内临时目录，确保**不读不写**真实 server/*.json（§F4 用 md5 自证）。
   ============================================================ */
const REAL_DATA_FILE = path.join(ROOT, 'server', 'data.json');
const REAL_USERS_FILE = path.join(ROOT, 'server', 'users.json');
function md5OfFile(p) { try { return md5(fs.readFileSync(p)); } catch (e) { return null; } }
const REAL_MD5_BEFORE = { data: md5OfFile(REAL_DATA_FILE), users: md5OfFile(REAL_USERS_FILE) };

const SRV_TMP = fs.mkdtempSync(path.join(ROOT, '.qatmp-admin-'));
process.env.PROD_DATA_FILE = path.join(SRV_TMP, 'data.json');
process.env.PROD_USERS_FILE = path.join(SRV_TMP, 'users.json');
/* 两个夹具账号（密码自算 scrypt，与 server.js 的 hashPwd 同算法） */
const PWD_ADMIN = 'adminpw123';
const PWD_STAFF = 'pmcpw123';
function hashPwd(pwd, salt) { return crypto.scryptSync(String(pwd), salt, 32).toString('hex'); }
function fixtureUser(username, name, role, pwd, perms) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { username: username, name: name, role: role, status: 'active', salt: salt, hash: hashPwd(pwd, salt), perms: perms || {} };
}
fs.writeFileSync(process.env.PROD_USERS_FILE, JSON.stringify([
  fixtureUser('admin', '管理员', 'admin', PWD_ADMIN, {}),
  fixtureUser('pmc', 'PMC小张', 'staff', PWD_STAFF, { products: true })
]));
const srv = require(path.join(ROOT, 'server', 'server.js'));
const PERM_META = srv.PERM_META;
/* 临时 HTTP 服务句柄：全文件只起**一个**（高位随机端口），after 里连同空闲连接一起关掉，
   否则服务端 handle 会吊住事件循环，`node --test` 会停在本文件不退（实测过）。 */
let httpServer = null;
let httpPort = 0;
after(async function () {
  if (httpServer) {
    try { httpServer.closeAllConnections(); } catch (e) { /* 低版本 Node 无此方法 */ }
    await new Promise(function (r) { httpServer.close(function () { r(); }); });
    httpServer = null;
  }
  fs.rmSync(SRV_TMP, { recursive: true, force: true });
});

/* ============================================================
   A · 后台页面结构（文本级）
   ============================================================ */

test('A1【契约】admin/index.html 恰有 1 个 <script>，且只指向 admin-app.js（不引生产/质量系统脚本）', function () {
  const tags = ADMIN_HTML.match(/<script\b[^>]*>/gi) || [];
  assert.strictEqual(tags.length, 1, '后台页面必须恰有 1 个 <script> 标签，实际：' + tags.join(' | '));
  assert.match(tags[0], /\bsrc\s*=\s*"admin-app\.js"/, '<script> 必须指向同目录 admin-app.js');
  assert.strictEqual(/<link\b/i.test(ADMIN_HTML), false, '后台页面不得外链任何 css（样式全部内联）');

  /* 负向（判「可执行面」：去注释后的 HTML 可见文本 + 内联事件属性）：
     不得借用生产系统 index.html / js/*.js / quality/* 的任何资源或函数 */
  const surface = htmlVisibleText(ADMIN_HTML);
  assert.strictEqual(/["'(]\/?(\.\.\/)?index\.html/.test(surface), false, '后台不得引用生产 index.html');
  assert.strictEqual(/(?:src|href)\s*=\s*["'][^"']*\/?js\//i.test(surface), false, '后台不得引用 js/*.js');
  assert.strictEqual(/(?:src|href)\s*=\s*["'][^"']*quality\//i.test(surface), false, '后台不得引用 quality/*');
  /* 生产页函数一个都不许出现（后台必须自实现：表格/工具栏/弹窗/登录卡片） */
  const handlers = (ADMIN_HTML.match(/\son[a-z]+="[^"]*"/g) || []).join('\n');
  const touchable = stripJsComments(surface + '\n' + handlers);
  const prodFns = ['renderTable', 'showModal(', 'apiReq(', 'canWriteKey(', 'svgIcon('];
  prodFns.forEach(function (fn) {
    assert.strictEqual(countOcc(touchable, fn), 0, '后台页面不得调用生产系统函数：' + fn);
  });
  /* 前提自证：事件属性确实被采集到了（否则上面的负向断言会恒真） */
  assert.ok(handlers.indexOf('ADMIN_APP.') >= 0, '必须采集到后台自己的内联事件处理（前提校验）');
});

test('A2【契约】存在 #sysSwitch / #sysSwitchBtn / #sysMenu 三件套，触发器是 h1 且绑 onclick', function () {
  assert.ok(ADMIN_HTML.indexOf('id="sysSwitch"') >= 0, '缺 #sysSwitch 容器');
  assert.ok(ADMIN_HTML.indexOf('id="sysSwitchBtn"') >= 0, '缺 #sysSwitchBtn 触发器');
  assert.ok(ADMIN_HTML.indexOf('id="sysMenu"') >= 0, '缺 #sysMenu 面板');
  assert.ok(/<h1 class="sys-switch-trigger"[^>]*id="sysSwitchBtn"/.test(ADMIN_HTML)
    || /<h1[^>]*id="sysSwitchBtn"[^>]*class="sys-switch-trigger"/.test(ADMIN_HTML),
    '触发器必须是 <h1 class="sys-switch-trigger" id="sysSwitchBtn">（折叠态既有规则靠 h1 命中）');
  const at = ADMIN_HTML.indexOf('id="sysSwitchBtn"');
  const around = ADMIN_HTML.slice(at - 240, at + 420);
  assert.ok(/onclick="ADMIN_APP\.toggleSysMenu\(event\)"/.test(around),
    'h1 触发器必须绑 onclick="ADMIN_APP.toggleSysMenu(event)"（折叠态只剩图标，靠它打开面板）');
  /* 面板必须是 h1 的**兄弟**（.sys-switch 的子），否则会被「h1 内 span 隐藏」规则连带隐藏 */
  const h1Close = ADMIN_HTML.indexOf('</h1>', at);
  const menuAt = ADMIN_HTML.indexOf('id="sysMenu"');
  assert.ok(menuAt > h1Close, '#sysMenu 必须在 </h1> 之后（h1 的兄弟，不得嵌进 h1）');
});

test('A3【契约】.sidebar 规则不含 overflow；.sys-menu 用 absolute（非 fixed）；折叠态 left:calc(100% + 6px)', function () {
  const css = ADMIN_HTML.slice(ADMIN_HTML.indexOf('<style>'), ADMIN_HTML.indexOf('</style>'));
  const sidebarRules = css.split('\n').filter(function (l) { return /^\s*\.sidebar\s*\{/.test(l); });
  assert.ok(sidebarRules.length >= 1, '必须能定位 .sidebar 规则行');
  sidebarRules.forEach(function (l) {
    assert.strictEqual(/overflow/.test(l), false, '.sidebar 规则不得含 overflow（否则折叠态面板被裁切）：' + l.slice(0, 120));
  });
  const menuRule = /\.sys-menu\{[^}]*\}/.exec(css);
  assert.ok(menuRule, '必须能取出 .sys-menu 规则体');
  assert.ok(/position:absolute/.test(menuRule[0]), '.sys-menu 必须 position:absolute');
  assert.strictEqual(/position:fixed/.test(menuRule[0]), false, '.sys-menu 不得 position:fixed（移动端 transform 会成为包含块，行为相反）');
  assert.ok(/\.sidebar\.collapsed \.sys-menu\{left:calc\(100% \+ 6px\)/.test(css),
    '折叠态面板必须从 56px 侧边栏右侧浮出（left:calc(100% + 6px)）');
});

test('A4【契约】移动端（≤768px）折叠态面板必须改回 left:8px（否则面板跑到抽屉外）', function () {
  /* 依据同 qa.systems-switch §CSS 对生产页的判据：移动端 .sidebar 是 240px 抽屉，
     若折叠态仍用 left:calc(100% + 6px)=246px，面板整块落在抽屉右侧外面（不可见/需横向滚动）。
     生产 index.html 有这条覆盖，后台页面目前**没有** —— 本条即用来钉住它。 */
  const css = ADMIN_HTML.slice(ADMIN_HTML.indexOf('<style>'), ADMIN_HTML.indexOf('</style>'));
  assert.ok(/@media\(max-width:768px\)\{[\s\S]*?\.sidebar\.collapsed \.sys-menu\{left:8px/.test(css),
    '移动端必须有 .sidebar.collapsed .sys-menu{left:8px…} 覆盖（与生产页同款）');
});

test('A5【契约】水印 build 2026-11-25.001 恰 1 处（deploy-admin.sh 的 >…< 口径 + 可见 DOM 口径）', function () {
  const AVER = 'build 2026-11-25.001';
  /* ① deploy-admin.sh 用的口径：`>$AVER<` 恰 1 处（grep -cF 断言的就是这个） */
  assert.strictEqual(countOcc(ADMIN_HTML, '>' + AVER + '<'), 1, '后台水印（>build …< 口径）必须恰 1 处');
  /* ② 可见 DOM 口径：去掉 HTML 注释后必须恰 1 处（注释里可以写，但不许写进可见文本） */
  assert.strictEqual(countOcc(stripHtmlComments(ADMIN_HTML), AVER), 1,
    '去注释后水印必须恰 1 处（可见文本里不许有第二处）');
  /* ③ 水印日期/序号形态必须合法（三段式 + 三位序号），且不得写成生产版本号 */
  const m = /^build (\d{4})-(\d{2})-(\d{2})\.(\d{3})$/.exec(AVER);
  assert.ok(m, '水印形态必须为 build YYYY-MM-DD.NNN');
  assert.ok(ADMIN_HTML.indexOf('.build-mark') >= 0, '水印必须挂在 .build-mark 元素上（独立页自带水印）');
});

test('A6【契约】admin-app.js 全文不得出现生产完整版本号（后台与生产各自独立编号）', function () {
  assert.strictEqual(countOcc(ADMIN_APP_SRC, build.BUILD), 0,
    '后台逻辑不得抄生产完整版本号 ' + build.BUILD + '（后台自带 .001 独立序号）');
  assert.strictEqual(countOcc(ADMIN_APP_SRC, build.PREV), 0, '后台逻辑不得出现上一版生产版本号');
  /* 后台自己的水印令牌必须存在（便于排障时对齐前后端） */
  assert.ok(countOcc(ADMIN_APP_SRC, '2026-11-25.001') >= 1, 'admin-app.js 必须标注后台版本令牌');
});

test('A7【契约】顶栏不得有改密入口（改密留在生产系统，后台只保留「退出」）', function () {
  /* ① 页面：去掉注释与样式后不得出现「改密」二字（注释里解释「不搬改密」是允许的） */
  assert.strictEqual(countOcc(htmlVisibleText(ADMIN_HTML), '改密'), 0,
    '后台页面不得出现「改密」入口（注释以外）');
  /* ② 逻辑：不得存在改密函数/接口调用 */
  const code = stripJsComments(ADMIN_APP_SRC);
  assert.strictEqual(/pwdModal|change-pwd|changePwd/.test(code), false,
    'admin-app.js 不得有改密函数或 /api/change-pwd 调用');
  /* ③ 「改密」只允许出现在 mustChangePwd 的提示文本里（提示用户回生产系统改密） */
  const block = extractBracedBlock(code, 'if (j.mustChangePwd)');
  const hits = [];
  let i = 0;
  while ((i = code.indexOf('改密', i)) >= 0) { hits.push(i); i += 2; }
  assert.strictEqual(hits.length, 2, '「改密」在代码里应恰出现 2 次（提示句里两次），实际 ' + hits.length);
  hits.forEach(function (pos) {
    assert.ok(pos >= block.start && pos <= block.end,
      '「改密」只能出现在 mustChangePwd 提示块内，实际位置 offset=' + pos + '（块区间 ' + block.start + '~' + block.end + '）');
  });
  /* ④ 退出按钮必须仍在（后台唯一的会话出口），且顶栏动作区只有它一个按钮 */
  assert.ok(/id="logoutBtn"[^>]*onclick="ADMIN_APP\.logout\(\)"/.test(ADMIN_HTML), '顶栏必须有「退出」按钮');
  const topbar = /<div class="topbar-actions">([\s\S]*?)<\/div>/.exec(ADMIN_HTML);
  assert.ok(topbar, '必须能定位 .topbar-actions 顶栏动作区');
  const tbText = htmlVisibleText(topbar[1]);
  assert.strictEqual(countOcc(tbText, '<button'), 1,
    '顶栏动作区应恰有 1 个按钮（只有「退出」；多出来的很可能就是被搬进来的改密）');
  assert.strictEqual(countOcc(tbText, '改密'), 0,
    '顶栏动作区不得有「改密」按钮（注释里解释「改密留在生产系统」是允许的，故只判可见文本）');
});

/* ============================================================
   B · 三副本 SYSTEMS 一致（同标签页、无新窗口）
   ============================================================ */

/**
 * 从源码里取出 `var SYSTEMS = [...]` 字面量并在隔离 vm 中求值。
 * @param {string} src 源码
 * @param {string} label 出错时的定位提示
 * @returns {Array<{key:string,name:string,url:string,icon:string}>}
 */
function evalSystems(src, label) {
  const m = /var\s+SYSTEMS\s*=\s*(\[[\s\S]*?\n\s*\]|\s*\[[\s\S]*?\]);/.exec(src);
  assert.ok(m, label + '：必须能定位 var SYSTEMS = [...] 字面量');
  return plain(vm.runInNewContext('(' + m[1] + ')'));
}
const SYS_PROD = evalSystems(INDEX_SRC, 'index.html');
const SYS_QA = evalSystems(QA_APP_SRC, 'quality/qa-app.js');
const SYS_ADMIN = evalSystems(ADMIN_APP_SRC, 'admin/admin-app.js');

test('B1【契约】三副本 SYSTEMS 求值后 key 集合完全相同，且三项分别是 prod→/、qa→/quality/、admin→/admin/', function () {
  const copies = [['index.html', SYS_PROD], ['quality/qa-app.js', SYS_QA], ['admin/admin-app.js', SYS_ADMIN]];
  copies.forEach(function (c) {
    const name = c[0]; const arr = c[1];
    assert.ok(Array.isArray(arr), name + '：SYSTEMS 必须是数组');
    assert.strictEqual(arr.length, 3, name + '：SYSTEMS 必须恰 3 项（生产 / 质量 / 管理员后台）');
    /* 契约是「key 集合相同」；面板内的**排列先后**是各页自己的 UI 选择
       （质量系统把自己排在首位、生产页把生产排首位 —— .163 起如此，不属本轮契约），
       故此处按集合比较，另在下方向断言 url 映射逐 key 相等。 */
    assert.deepStrictEqual(arr.map(function (s) { return s.key; }).sort(), ['admin', 'prod', 'qa'],
      name + '：SYSTEMS 的 key 集合必须恰为 prod / qa / admin');
    arr.forEach(function (s) {
      assert.deepStrictEqual(Object.keys(s).sort(), ['icon', 'key', 'name', 'url'],
        name + '：每项必须且只能有 key/name/url/icon：' + JSON.stringify(s));
    });
  });
  /* url 逐 key 全等（跨副本） */
  const byKey = function (arr) { const o = {}; arr.forEach(function (s) { o[s.key] = s.url; }); return o; };
  const p = byKey(SYS_PROD); const q = byKey(SYS_QA); const a = byKey(SYS_ADMIN);
  assert.deepStrictEqual(q, p, 'quality/qa-app.js 的 SYSTEMS url 必须与生产页逐 key 一致');
  assert.deepStrictEqual(a, p, 'admin/admin-app.js 的 SYSTEMS url 必须与生产页逐 key 一致');
  /* 契约值（用户拍板的三套系统入口） */
  assert.strictEqual(p.prod, '/', '生产系统入口必须是 /');
  assert.strictEqual(p.qa, '/quality/', '质量系统入口必须带尾斜杠 /quality/');
  assert.strictEqual(p.admin, '/admin/', '管理员后台入口必须带尾斜杠 /admin/（否则相对资源 admin-app.js 解析失败白屏）');
  /* name 也必须一致（下拉面板文案三处同字） */
  const nameByKey = function (arr) { const o = {}; arr.forEach(function (s) { o[s.key] = s.name; }); return o; };
  assert.deepStrictEqual(nameByKey(SYS_QA), nameByKey(SYS_PROD), '质量系统副本的 name 必须与生产页一致');
  assert.deepStrictEqual(nameByKey(SYS_ADMIN), nameByKey(SYS_PROD), '后台副本的 name 必须与生产页一致');
});

test('B2【契约】三处副本区均不得用 window.open / target=_blank（sessionStorage 按标签页隔离）', function () {
  const copies = [['index.html', INDEX_SRC], ['quality/qa-app.js', QA_APP_SRC], ['admin/admin-app.js', ADMIN_APP_SRC]];
  copies.forEach(function (c) {
    const code = stripJsComments(c[1]);
    assert.strictEqual(countOcc(code, 'window.open'), 0, c[0] + '：不得用 window.open（新标签页必丢登录态）');
    assert.strictEqual(countOcc(code, 'target="_blank"'), 0, c[0] + '：不得 target="_blank"');
    assert.strictEqual(countOcc(code, "target='_blank'"), 0, c[0] + '：不得 target=_blank');
  });
  /* 正向：切换必须走同标签页跳转（location.href = …url） */
  const admCode = stripJsComments(ADMIN_APP_SRC);
  assert.ok(/location\.href\s*=\s*target\.url/.test(admCode), '后台切系统必须用 location.href = target.url');
  assert.ok(/location\.href\s*=\s*'\/'/.test(admCode), '「返回生产排单系统」必须 location.href = \'/\'');
});

test('B3【契约】后台下拉面板的「当前项」恒为 admin，且面板项点击走 pickSystem（不新窗口）', function () {
  const code = stripJsComments(ADMIN_APP_SRC);
  assert.ok(/s\.key === 'admin'/.test(code), '后台页的当前系统判断必须写死 admin（本页恒为管理员后台）');
  assert.ok(/ADMIN_APP\.pickSystem\(event/.test(code), '面板项必须绑 ADMIN_APP.pickSystem');
  assert.ok(/function pickSystem\s*\(/.test(code), 'admin-app.js 必须实现 pickSystem');
  /* 点当前系统不得跳转（否则刷新丢状态） */
  assert.ok(/if \(key === 'admin'\) return;/.test(code), 'pickSystem 点当前系统必须直接 return（不跳转）');
});

/* ============================================================
   C · 门禁行为（自建 DOM 桩 + 假 fetch，真跑 boot 流程）
   ------------------------------------------------------------
   为什么不用 harness/dom-stub 的 document：
     dom-stub 的 getElementById 恒返回 null（设计 §6.2 明确要求「无 DOM 保真」，见
     tests/harness/dom-stub.js 注释），而本组要断言的正是「#content 里渲染了什么」。
     故本文件在 dom-stub 之上**自建一个 id 注册表桩**（§makeHarness）：
       · getElementById 按 id 返回可控假元素（innerHTML 可读）；
       · document.body.appendChild 按元素 id 登记（登录卡片是在 body 上动态挂的）；
       · readyState='complete' ⇒ admin-app.js 求值后立即执行 init() → boot()（真跑启动流程）；
       · setTimeout 换成「记录但不触发」的假定时器（showLogin 里的 focus 延时不影响判定）。
     这属于**能力补齐**而非降级：5 条行为全部走真实的 boot → reloadAll 路径。
   ============================================================ */

/**
 * 造一个最小 DOM 环境（id 注册表 + body.appendChild 登记）。
 * @param {Object=} seedSession sessionStorage 初值
 * @returns {{browser:Object, reg:Object, created:Array, location:Object}}
 */
function makeHarness(seedSession) {
  function mkEl(id) {
    const classes = Object.create(null);
    return {
      id: id || '',
      tagName: 'DIV',
      innerHTML: '',
      textContent: '',
      value: '',
      style: {},
      dataset: {},
      classList: {
        add: function (c) { classes[c] = 1; },
        remove: function (c) { delete classes[c]; },
        toggle: function (c, v) {
          const want = (v === undefined) ? !classes[c] : !!v;
          if (want) classes[c] = 1; else delete classes[c];
          return want;
        },
        contains: function (c) { return !!classes[c]; },
      },
      appendChild: function () {},
      addEventListener: function () {},
      querySelector: function () { return null; },
      querySelectorAll: function () { return []; },
      focus: function () {},
      remove: function () {},
    };
  }
  const reg = Object.create(null);
  ['nav', 'content', 'pageTitle', 'mobileTitle', 'sysMenu', 'modal', 'modalBg', 'sidebar', 'overlay']
    .forEach(function (id) { reg[id] = mkEl(id); });

  const browser = domStub.createBrowserGlobals({ sessionStorage: seedSession || {} });
  const doc = browser.document;
  const created = [];
  doc.readyState = 'complete';                       /* ⇒ 求值后立即 init() */
  doc.getElementById = function (id) { return reg[id] || null; };
  doc.createElement = function (tag) {
    const el = mkEl('');
    el.tagName = String(tag || 'div').toUpperCase();
    created.push(el);
    return el;
  };
  doc.body.appendChild = function (el) {
    if (el && el.id) reg[el.id] = el;
    return el;
  };
  return { browser: browser, doc: doc, reg: reg, created: created, location: browser.window.location };
}

/**
 * 造一个假 fetch：按 url 精确匹配路由，并记录全部调用。
 * @param {Object} routes { '/api/me': {status?:number, body?:any} }
 * @returns {Function} 带 .calls / .paths() 的桩
 */
function makeFetch(routes) {
  const calls = [];
  function mkResp(status, body) {
    return {
      status: status,
      ok: status >= 200 && status < 300,
      headers: { get: function () { return null; } },
      json: async function () { return JSON.parse(JSON.stringify(body === undefined ? {} : body)); },
      text: async function () { return JSON.stringify(body === undefined ? {} : body); },
    };
  }
  const fn = async function (url, opts) {
    calls.push({ url: url, method: (opts && opts.method) || 'GET', headers: (opts && opts.headers) || {}, body: opts && opts.body });
    const spec = routes[url];
    if (!spec) return mkResp(404, { error: 'no route: ' + url });
    return mkResp(spec.status === undefined ? 200 : spec.status, spec.body);
  };
  fn.calls = calls;
  fn.paths = function () { return calls.map(function (c) { return c.url; }); };
  return fn;
}

/**
 * 装载 admin/admin-app.js 到一个隔离 vm（真浏览器桩），返回句柄。
 * @param {Object=} seedSession sessionStorage 初值
 * @param {Function} fetchImpl 假 fetch
 * @returns {{h:Object, app:Object, sandbox:Object, timers:Array}}
 */
function loadAdminApp(seedSession, fetchImpl) {
  const h = makeHarness(seedSession);
  const timers = [];
  const noop = function () { };
  const timerStub = function (fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; };
  const sandbox = Object.assign({}, h.browser.globals, {
    console: { log: noop, warn: noop, error: noop, info: noop, debug: noop },
    setTimeout: timerStub,
    clearTimeout: noop,
    setInterval: function () { return 0; },
    clearInterval: noop,
    fetch: fetchImpl,
  });
  h.browser.window.setTimeout = timerStub;
  h.browser.window.clearTimeout = noop;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(ADMIN_APP_SRC, ctx, { filename: 'admin/admin-app.js' });
  return { h: h, sandbox: sandbox, timers: timers, app: h.browser.window.ADMIN_APP };
}

/** 等某个条件成立（最多 ~200 个微任务轮次），超时即判失败 */
async function waitFor(fn, label) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise(function (r) { setImmediate(r); });
  }
  assert.fail('等待超时：' + label);
}

/** 后台 /api/me 的真实回包形态（扁平 publicUser —— server.js 实测） */
const ME_ADMIN = { username: 'admin', name: '管理员', role: 'admin', status: 'active', perms: {}, mustChangePwd: false };
const ME_STAFF = { username: 'pmc', name: 'PMC小张', role: 'staff', status: 'active', perms: { products: true }, mustChangePwd: false };
const USERS_BODY = {
  users: [
    { username: 'admin', name: '管理员', role: 'admin', status: 'active', perms: {}, mustChangePwd: false },
    { username: 'pmc', name: 'PMC小张', role: 'staff', status: 'active', perms: { products: true }, mustChangePwd: false }
  ]
};

test('C1【契约】无 token：进入登录卡片，一个接口都不发', async function () {
  const f = makeFetch({});
  const env = loadAdminApp({}, f);
  await waitFor(function () { return env.app.state.view !== 'boot'; }, 'boot 完成');
  await new Promise(function (r) { setImmediate(r); });

  assert.strictEqual(env.app.state.view, 'login', '无 token 必须进入 login 视图');
  assert.strictEqual(f.calls.length, 0, '无 token 时不得发出任何请求，实际：' + JSON.stringify(f.paths()));
  assert.strictEqual(env.h.reg.content.innerHTML, '', '未登录时 #content 必须为空');
  assert.strictEqual(env.h.reg.nav.innerHTML, '', '未登录时 #nav 必须为空（不留导航 DOM）');
  const box = env.h.reg.adminLoginBox;
  assert.ok(box, '必须动态创建登录卡片 #adminLoginBox');
  assert.strictEqual(box.style.display, 'flex', '登录卡片必须可见');
  assert.ok(box.innerHTML.indexOf('管理员后台') >= 0, '登录卡片必须标明「管理员后台」');
  assert.ok(box.innerHTML.indexOf('仅管理员账号可用') >= 0, '登录卡片必须说明仅管理员可用');
});

test('C2【契约·关键】非管理员：只发 /api/me 一个请求，绝不碰 /api/users 与 /api/perm-meta，渲染无权访问卡片', async function () {
  const f = makeFetch({ '/api/me': { body: ME_STAFF } });
  const env = loadAdminApp({ wb_cb_prod_token: 'tk-staff' }, f);
  await waitFor(function () { return env.app.state.view !== 'boot'; }, 'boot 完成');
  await new Promise(function (r) { setImmediate(r); });

  assert.deepStrictEqual(f.paths(), ['/api/me'],
    '非管理员只允许发 /api/me 一个请求（实测：' + JSON.stringify(f.paths()) + '）');
  assert.strictEqual(countOcc(f.paths().join(','), '/api/users'), 0, '非管理员绝不能请求 /api/users');
  assert.strictEqual(countOcc(f.paths().join(','), '/api/perm-meta'), 0, '非管理员绝不能请求 /api/perm-meta');
  assert.strictEqual(env.app.state.view, 'deny', '非管理员必须进入 deny 视图');
  assert.deepStrictEqual(plain(env.app.state.users), [], 'deny 态下 state.users 必须清空');
  assert.strictEqual(env.app.state.meta, null, 'deny 态下 state.meta 必须为 null');

  const html = env.h.reg.content.innerHTML;
  assert.ok(html.indexOf('无权访问') >= 0, '#content 必须含「无权访问」');
  assert.ok(html.indexOf('返回生产排单系统') >= 0, '#content 必须含「返回生产排单系统」按钮');
  assert.ok(/onclick="ADMIN_APP\.backToProd\(\)"/.test(html), '返回按钮必须绑 ADMIN_APP.backToProd()');
  /* 返回目标必须是生产系统根路径（用真调用来判定，不猜字符串） */
  env.app.backToProd();
  assert.strictEqual(env.h.location.href, '/', '返回按钮跳转目标必须是 /');
  /* 不得出现任何员工数据 DOM（表格 / 权限复选框 / 员工行标签 / 操作按钮）。
     注意：无权访问卡片**必须**显示「当前登录账号是谁」（契约：用户要知道自己是谁），
     所以「本人用户名/姓名」允许出现；被禁的是**员工列表数据**本身。 */
  assert.strictEqual(/<table/i.test(html), false, 'deny 态 #content 不得含表格');
  assert.strictEqual(/<td[\s>]/i.test(html), false, 'deny 态 #content 不得含表格单元格');
  assert.strictEqual(/data-perm=|data-act=/.test(html), false, 'deny 态 #content 不得含权限复选框');
  assert.strictEqual(/delUser\(|userModal\(/.test(html), false, 'deny 态 #content 不得含员工操作按钮');
  assert.strictEqual(/tag-blue|tag-red/.test(html), false, 'deny 态 #content 不得含角色标签（员工行特征）');
  assert.ok(html.indexOf('pmc') >= 0, '无权访问卡片必须显示当前登录账号（本人，契约）');
  assert.strictEqual(countOcc(html, 'PMC小张'), 1, '当前账号姓名只允许作为「本人」出现 1 次');
  assert.strictEqual(env.h.reg.nav.innerHTML, '', 'deny 态 #nav 必须为空（不留「员工管理」导航项）');
  assert.strictEqual(/nav-item/.test(env.h.reg.nav.innerHTML), false, 'deny 态不得渲染任何导航项');
});

test('C3【契约】管理员 + 正常 meta：拉到 /api/users 与 /api/perm-meta，渲染出员工行且新增/编辑可用', async function () {
  const f = makeFetch({
    '/api/me': { body: ME_ADMIN },
    '/api/users': { body: USERS_BODY },
    '/api/perm-meta': { body: { ok: true, meta: plain(PERM_META) } }
  });
  const env = loadAdminApp({ wb_cb_prod_token: 'tk-admin' }, f);
  await waitFor(function () { return env.app.state.view === 'ready'; }, '管理员 boot 完成');
  await new Promise(function (r) { setImmediate(r); });

  const paths = f.paths().sort();
  assert.deepStrictEqual(paths, ['/api/me', '/api/perm-meta', '/api/users'],
    '管理员必须恰拉 me / users / perm-meta 三个接口，实际：' + JSON.stringify(paths));
  assert.strictEqual(env.app.state.view, 'ready', '管理员必须进入 ready 视图');
  assert.strictEqual(env.app.state.users.length, 2, 'state.users 必须载入 2 个员工');
  assert.ok(env.app.state.meta && env.app.state.meta.forms, 'state.meta 必须载入权限元数据');

  const html = env.h.reg.content.innerHTML;
  assert.ok(/<table/i.test(html), 'ready 态 #content 必须渲染表格');
  assert.ok(html.indexOf('PMC小张') >= 0, '表格必须渲染出员工行（PMC小张）');
  assert.ok(html.indexOf('产品主数据') >= 0, '「表单写权限」列必须由 meta.forms 派生出「产品主数据」');
  assert.strictEqual(countOcc(html, '权限清单未就绪'), 0, 'meta 正常时不得出现降级提示');
  assert.strictEqual(/class="btn btn-primary btn-sm"[^>]*disabled/.test(html), false,
    'meta 正常时「新增员工」按钮不得禁用');
  assert.strictEqual(/disabled title="权限清单未就绪，暂不可编辑"/.test(html), false,
    'meta 正常时「编辑」按钮不得禁用');
  /* 管理员行不显示「删除」（服务端也拒删内置管理员/自己） */
  assert.strictEqual(/delUser\('admin'\)/.test(html), false, '管理员行不得出现删除按钮');
  assert.ok(/delUser\('pmc'\)/.test(html), '员工行必须有删除按钮');
  assert.strictEqual(env.h.reg.nav.innerHTML.indexOf('员工管理') >= 0, true, 'ready 态必须渲染「员工管理」导航项');
  assert.strictEqual(env.h.reg.pageTitle.textContent, '员工管理', '顶栏标题必须同步为「员工管理」');

  /* 系统切换面板必须真的渲染出 3 项，且「管理员后台」是当前项（由 SYSTEMS 派生，不是写死） */
  const menu = env.h.reg.sysMenu.innerHTML;
  assert.strictEqual(countRe(menu, /class="sys-menu-item/g), 3, '系统切换面板必须渲染 3 个系统项');
  ['生产排单系统', '质量系统', '管理员后台'].forEach(function (n) {
    assert.ok(menu.indexOf(n) >= 0, '系统切换面板必须含「' + n + '」');
  });
  assert.strictEqual(countOcc(menu, 'sys-menu-item cur'), 1, '面板里恰有 1 个当前项');
  assert.ok(/sys-menu-item cur[^>]*onclick="ADMIN_APP\.pickSystem\(event,'admin'\)"/.test(menu),
    '当前项必须是「管理员后台」（后台页恒为 admin）');
});

test('C4【契约】管理员 + perm-meta 404：不白屏不抛异常，降级提示出现，新增/编辑按钮禁用', async function () {
  const f = makeFetch({
    '/api/me': { body: ME_ADMIN },
    '/api/users': { body: USERS_BODY },
    '/api/perm-meta': { status: 404, body: { error: '接口不存在' } }
  });
  const env = loadAdminApp({ wb_cb_prod_token: 'tk-admin' }, f);
  await waitFor(function () { return env.app.state.view === 'ready'; }, '降级 boot 完成');
  await new Promise(function (r) { setImmediate(r); });

  assert.strictEqual(env.app.state.view, 'ready', 'perm-meta 失败不得把页面打成 login/deny（必须留在 ready 降级态）');
  assert.strictEqual(env.app.state.meta, null, 'meta 必须为 null（降级）');
  assert.ok(String(env.app.state.metaError).length > 0, 'metaError 必须记录降级原因（便于排障）');
  assert.deepStrictEqual(plain(env.h.browser.alerts), [], '降级路径不得弹 alert（不打扰用户）');

  const html = env.h.reg.content.innerHTML;
  assert.ok(html.length > 0, '降级态不得白屏（#content 必须有内容）');
  assert.ok(html.indexOf('权限清单未就绪') >= 0, '必须出现「权限清单未就绪」降级提示');
  assert.ok(/class="meta-warn"/.test(html), '降级提示必须挂在 .meta-warn 条上');
  assert.ok(/onclick="ADMIN_APP\.retryMeta\(\)"/.test(html), '降级提示条必须提供「重试」按钮');
  assert.ok(html.indexOf('PMC小张') >= 0, '降级态员工列表照常显示');
  /* 新增按钮禁用（判 disabled 出现在「新增员工」之前的同一个 <button> 上） */
  const addIdx = html.indexOf('新增员工');
  assert.ok(addIdx > 0, '必须仍有「新增员工」按钮');
  const addTagStart = html.lastIndexOf('<button', addIdx);
  assert.ok(/\bdisabled\b/.test(html.slice(addTagStart, addIdx)), '「新增员工」按钮必须禁用');
  /* 每个员工行的「编辑」也禁用（2 行 = 2 处） */
  assert.strictEqual(countOcc(html, 'disabled title="权限清单未就绪，暂不可编辑"'), 2,
    '两行员工的「编辑」按钮都必须禁用');
  /* 降级态不得出现删除按钮（删除没有 meta 也是不可用态） */
  assert.strictEqual(/delUser\('/.test(html), false, '降级态不得渲染删除按钮');
  /* 点「新增员工」也不该打开弹窗，而是提示先部署后端 */
  env.app.state.meta = null;
  env.app.userModal();
  assert.ok(String(env.h.browser.alerts.join('\n')).indexOf('权限清单未就绪') >= 0,
    '降级态点「新增员工」必须提示权限清单未就绪');
});

test('C5【契约】/api/me 返回 401：清空 sessionStorage token 并回到登录卡片', async function () {
  const f = makeFetch({ '/api/me': { status: 401, body: { error: '未登录或登录已过期' } } });
  const env = loadAdminApp({ wb_cb_prod_token: 'tk-expired' }, f);
  await waitFor(function () { return env.app.state.view === 'login'; }, '401 处理完成');
  await new Promise(function (r) { setImmediate(r); });

  assert.strictEqual(env.app.state.view, 'login', '401 必须回到 login 视图');
  assert.strictEqual(env.h.browser.storage.session.getItem('wb_cb_prod_token'), null,
    '401 必须清空 sessionStorage[wb_cb_prod_token]');
  assert.strictEqual(env.app.state.token, '', 'state.token 必须清空');
  assert.strictEqual(env.h.reg.content.innerHTML, '', '401 后 #content 必须清空（不留过期数据）');
  const box = env.h.reg.adminLoginBox;
  assert.ok(box, '必须弹出登录卡片');
  assert.strictEqual(box.style.display, 'flex', '登录卡片必须可见');
  assert.ok(f.paths().indexOf('/api/users') < 0, '401 后不得继续请求 /api/users');
  assert.ok(f.paths().indexOf('/api/perm-meta') < 0, '401 后不得继续请求 /api/perm-meta');
});

/* ============================================================
   D · 生产侧已下线（负向）
   ============================================================ */

test('D1【契约】index.html 可执行面里不得再有员工管理实现（函数/常量/缓存）', async function () {
  const surface = executableSurface(INDEX_SRC);
  ['renderUsers', 'loadUsers', 'userModal', 'delUser', 'saveUser', '__usersCache',
    'PERM_FORMS', 'permFormKeyOf', 'recomputePermTri', 'permTriToggle', 'permInitUI'].forEach(function (name) {
    assert.strictEqual(countOcc(surface, name), 0,
      'index.html 可执行面不得再引用 ' + name + '（员工管理已整体迁至 /admin/）');
  });
  /* 前提自证：可执行面提取器确实取到了主脚本（否则上面的负向断言会恒真） */
  assert.ok(surface.length > 100000, '可执行面长度异常（' + surface.length + '）—— 提取器可能失效');
  assert.ok(surface.indexOf('function renderContent') >= 0, '前提：可执行面必须包含 renderContent');
});

test('D2【契约】NAV 定义内无 users 项；renderContent 无 case \'users\'', function () {
  const navStart = INDEX_SRC.indexOf('const NAV=[');
  assert.ok(navStart > 0, '必须能定位 NAV 定义');
  const navDef = INDEX_SRC.slice(navStart, INDEX_SRC.indexOf('];', navStart));
  assert.strictEqual(/\{id:'users'/.test(navDef), false, 'NAV 不得再有 users 项');
  assert.strictEqual(countOcc(navDef, "label:'员工管理'"), 0, 'NAV 不得再有「员工管理」菜单项');
  const ids = (navDef.match(/\{id:'[^']+'/g) || []).map(function (x) { return x.slice(5, -1); });
  assert.strictEqual(ids.length, 11, 'NAV 项数应为 11（.164 起无 users），实际：' + ids.join(','));   /* 【快照】项数 */
  assert.ok(ids.indexOf('users') < 0, 'NAV id 列表里不得有 users');

  /* 判「可执行面」：注释里写「case 'users' 已删除」是允许的，代码里不许有 */
  const surface = executableSurface(INDEX_SRC);
  const rcAt = surface.indexOf('function renderContent');
  assert.ok(rcAt > 0, '必须能在可执行面里定位 renderContent');
  const rc = surface.slice(rcAt, rcAt + 4000);
  assert.strictEqual(/case\s*'users'/.test(rc), false, "renderContent 不得再有 case 'users'");
  /* renderNav 不得再按 users 过滤（原 ADMIN 专用项已不存在） */
  const rnAt = surface.indexOf('function renderNav');
  assert.ok(rnAt > 0, '必须能在可执行面里定位 renderNav');
  const rn = surface.slice(rnAt, rnAt + 1200);
  assert.strictEqual(/n\.id\s*===\s*'users'/.test(rn), false, 'renderNav 不得再按 users 过滤');
  /* 前提自证：renderContent 里确实还留着别的 case（否则上面的负向断言会恒真） */
  assert.ok(/case\s*'partLogs'/.test(rc), '前提：renderContent 仍应包含其它 case 分支');
});

test('D3【契约】全文（产品代码范围）不得再出现「未指路管理员后台」的「员工管理 →」文案', function () {
  /* 范围：产品代码 + 文档。明确排除历史快照类目录（docs / _diag / backups / .qatmp-*）
     与本机记忆库（.workbuddy）。判据：任何「员工管理 →」前必须紧跟「管理员后台 →」，
     否则用户会在生产系统左侧菜单里找不到入口（.164 之前的老措辞）。 */
  const targets = ['index.html', 'quality/qa-app.js', 'server/qa-server.js', 'server/server.js',
    'js/guide.js', 'README.md', 'admin/admin-app.js', 'admin/index.html'];
  targets.forEach(function (rel) {
    let src = readRel(rel);
    /* 注释剥离：注释里引述旧措辞（说明「原句只写…」）是允许的 */
    if (/\.js$/.test(rel)) src = stripJsComments(src);
    if (/\.html$/.test(rel)) src = stripJsComments(stripHtmlComments(src));
    const re = /员工管理\s*→/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const before = src.slice(Math.max(0, m.index - 12), m.index);
      assert.ok(/管理员后台\s*→\s*$/.test(before),
        rel + '：出现未指路管理员后台的「员工管理 →」（上下文：「' + src.slice(Math.max(0, m.index - 30), m.index + 20) + '」）');
    }
  });
});

test('D4【契约】NAV 之外的六处「员工管理」文案必须明确指向管理员后台', function () {
  /* 覆盖 .164 改过文案的 5 个落点（guide / qa-app 只读提示 / qa-server 403 / README / server 注释） */
  assert.ok(GUIDE_SRC.indexOf('管理员后台 → 员工管理') >= 0, 'guide.js 必须指路管理员后台');
  assert.ok(GUIDE_SRC.indexOf('员工管理已不在生产系统里') >= 0 || GUIDE_SRC.indexOf('整体迁到「管理员后台」') >= 0,
    'guide.js 必须说明员工管理已迁出生产系统');
  assert.ok(GUIDE_SRC.indexOf('### 员工管理（仅管理员 · 在「管理员后台」里）') >= 0,
    'guide.js 的员工管理章节标题必须标明在管理员后台');
  assert.ok(QA_APP_SRC.indexOf('管理员后台 → 员工管理 → 表单写权限') >= 0,
    'quality/qa-app.js 只读提示必须指路管理员后台');
  assert.ok(readRel('server/qa-server.js').indexOf('管理员后台 → 员工管理 → 表单写权限') >= 0,
    'server/qa-server.js 403 文案必须指路管理员后台');
  assert.ok(README_SRC.indexOf('整体迁至独立页面「管理员后台」') >= 0, 'README 必须声明员工管理已迁出');
  assert.ok(/~~员工管理~~/.test(README_SRC), 'README 的员工管理行必须标记为已迁出（删除线）');
  /* index.html 的 needAct 提示同样指路 */
  assert.ok(INDEX_SRC.indexOf('管理员后台 → 员工管理 → 表单写权限') >= 0,
    'index.html 的 needAct 兜底提示必须指路管理员后台');
});

test('D5【契约】改密没有跟着搬走：pwdModal / savePwd 必须仍在 index.html', function () {
  const surface = executableSurface(INDEX_SRC);
  assert.ok(/function pwdModal\s*\(/.test(surface), 'index.html 必须保留 function pwdModal()（改密留在生产系统）');
  assert.ok(/function savePwd\s*\(/.test(surface), 'index.html 必须保留 function savePwd()');
  assert.ok(surface.indexOf('change-pwd') >= 0, 'index.html 必须保留 /api/change-pwd 调用（改密入口未被误删）');
  /* 顶栏「改密」按钮的标记必须仍在（判 HTML 属性本体，不经可执行面） */
  assert.ok(INDEX_SRC.indexOf('id="pwdBtn"') >= 0, '顶栏改密按钮 #pwdBtn 必须仍在');
  assert.ok(INDEX_SRC.indexOf('onclick="pwdModal()"') >= 0, '改密按钮必须仍绑 onclick="pwdModal()"');
  /* 生产后端 change-pwd 路由不得被顺手删掉 */
  assert.ok(readRel('server/server.js').indexOf('/api/change-pwd') >= 0, '生产后端必须保留 /api/change-pwd');
});

/* ============================================================
   E · 权限元数据一致性（最关键的一组）
   ============================================================ */

test('E1【契约+快照】PERM_META 形状：forms 9 键 / formKeys 12 键 / acts 6 个表单键', function () {
  assert.ok(PERM_META, 'server.js 必须导出 PERM_META');
  assert.deepStrictEqual(Object.keys(PERM_META).sort(), ['acts', 'formKeys', 'forms'],
    'PERM_META 必须恰有 forms / formKeys / acts 三份');
  /* 【契约】9 个权限点（顺序即界面顺序，qa 追加在末尾） */
  assert.deepStrictEqual(Object.keys(PERM_META.forms),
    ['products', 'parts', 'saleOrders', 'invOrders', 'dailyPlans', 'deliveries', 'processTemplates', 'transfers', 'qa'],
    'PERM_META.forms 的键与顺序必须与 .163 版 PERM_FORMS 逐字一致（qa 在末尾）');
  /* 【契约】12 个表单键（formToKey 映射表全集） */
  assert.strictEqual(Object.keys(PERM_META.formKeys).length, 12, 'PERM_META.formKeys 必须 12 项');
  /* 【契约】6 个承载动作的表单键 */
  assert.deepStrictEqual(Object.keys(PERM_META.acts), ['product', 'order_frame', 'order_inv', 'delivery', 'prodPlan', 'parts'],
    'PERM_META.acts 必须恰为 6 个承载动作的表单键');
  /* 【快照】动作键总数 —— 注意：派单文档写的是「19 动作」，实测为 17（见回报 §4）。
     这里把**实测值**钉住（防悄悄增减），真正的契约在下一条（与 FORM_ACTS 逐键相等）。 */
  const actTotal = Object.keys(PERM_META.acts).reduce(function (n, fk) { return n + Object.keys(PERM_META.acts[fk]).length; }, 0);
  assert.strictEqual(actTotal, 17, '动作键总数当前为 17（派单文档的 19 与源码不符，详见回报）');
});

test('E2【契约】PERM_META.forms 与上一版（仍含 PERM_FORMS 的历史修订）逐键逐字对齐', function () {
  /* 合法基线：**最近一个仍含 PERM_FORMS 字面量的 index.html 历史修订**。
     为什么不能写死 `HEAD:index.html`：本轮改动提交前 HEAD 是 .163（含 PERM_FORMS），
     提交后 HEAD 就是 .164（已删除 PERM_FORMS）—— 写死 HEAD 会在「提交后」假失败，
     而「跳过不测」又会让这条最关键的守恒断言永远失效。故按 git 历史向前找，
     两种状态（已提交 / 未提交）都能取到真正的上一版。 */
  const revs = git(['log', '--format=%H', '-n', '40']).trim().split('\n').filter(Boolean);
  let base = null;
  for (let i = 0; i < revs.length; i++) {
    let txt = null;
    try { txt = normEol(git(['show', revs[i] + ':index.html'])); } catch (e) { continue; }
    const m = /const PERM_FORMS=\{[\s\S]*?\};/.exec(txt);
    if (!m) continue;
    const lit = m[0].replace(/^const PERM_FORMS=/, '').replace(/;\s*$/, '').replace(/\/\*[\s\S]*?\*\//g, '');
    base = { rev: revs[i], forms: plain(vm.runInNewContext('(' + lit + ')')) };
    break;
  }
  assert.ok(base, '必须在最近 40 个修订里找到一个仍含 PERM_FORMS 的 index.html（否则本断言无从校验）');
  assert.deepStrictEqual(plain(PERM_META.forms), base.forms,
    'PERM_META.forms 必须与历史权威版 PERM_FORMS 逐键逐字相同（基线修订 ' + base.rev.slice(0, 7) + '）');

  /* 显式清单（写死在本用例里的**独立第二口径**：即使历史被 rebase 掉，
     这条也能独立证明「9 个权限点、顺序、显示名」一个没变） */
  const EXPLICIT = {
    products: '产品主数据',
    parts: '零部件数据',
    saleOrders: '订单管理·销售订单',
    invOrders: '库存管理·库存订单',
    dailyPlans: '排产计划',
    deliveries: '交付计划',
    processTemplates: '工序模板',
    transfers: '调拨台账',
    qa: '质量管理'
  };
  Object.keys(EXPLICIT).forEach(function (k) {
    assert.strictEqual(PERM_META.forms[k], EXPLICIT[k], 'PERM_META.forms[' + k + '] 显示名不符');
  });
  assert.deepStrictEqual(Object.keys(PERM_META.forms), Object.keys(EXPLICIT), '键与顺序必须与显式清单一致');
  /* 反虚设：基线里 qa 的显示名必须真的取自历史文件（不是从当前值回填） */
  assert.strictEqual(base.forms.qa, '质量管理', '基线修订里 PERM_FORMS.qa 必须存在（否则取错了修订）');
});

test('E3【契约】PERM_META.formKeys 与当前生产仍在的 formToKey() 逐键运行时求值一致', function () {
  /* 用真实生产前端求值（harness 沙箱装载 index.html 主脚本），而不是比对文本 */
  const { createApp } = require('./harness/sandbox');
  const app = createApp({ installRecorder: false, quietConsole: true });
  const keys = Object.keys(PERM_META.formKeys);
  assert.strictEqual(keys.length, 12, 'PERM_META.formKeys 必须 12 项');
  keys.forEach(function (k) {
    assert.strictEqual(PERM_META.formKeys[k], app.run('formToKey(' + JSON.stringify(k) + ')'),
      'PERM_META.formKeys[' + k + '] 必须等于生产 formToKey(' + k + ')');
  });
  /* 反向：formToKey 的映射表不得有 PERM_META 未登记的表单键（含未知键原样返回的既有性质） */
  assert.strictEqual(app.run("formToKey('__unknown_form__')"), '__unknown_form__',
    'formToKey 对未知键必须原样返回（质量系统/后台写权限依赖这条性质）');
  /* 后台反查口径：acts 的键必须都能在 formKeys 里找到归属 */
  Object.keys(PERM_META.acts).forEach(function (fk) {
    assert.ok(Object.prototype.hasOwnProperty.call(PERM_META.formKeys, fk),
      'PERM_META.acts 的键 ' + fk + ' 必须是 formKeys 里已登记的表单键（否则后台反查不到权限点）');
  });
});

test('E4【契约】PERM_META.acts 与生产仍在的 FORM_ACTS JSON.stringify 全等', function () {
  const { createApp } = require('./harness/sandbox');
  const app = createApp({ installRecorder: false, quietConsole: true });
  const formActs = plain(app.run('FORM_ACTS'));
  assert.strictEqual(JSON.stringify(plain(PERM_META.acts)), JSON.stringify(formActs),
    'PERM_META.acts 必须与生产 FORM_ACTS 逐键逐字全等（否则后台勾选的按钮权限与按钮 gate 说不同的话）');
  /* qa 不得注册动作键（本轮无按钮级动作） */
  assert.strictEqual(Object.prototype.hasOwnProperty.call(PERM_META.acts, 'qa'), false,
    'PERM_META.acts 不得注册 qa（质量系统本期只有 CRUD）');
  /* forms / formKeys / acts 三份的自洽性：每个 acts 表单键的归属权限点必须存在于 forms */
  Object.keys(PERM_META.acts).forEach(function (fk) {
    const pk = PERM_META.formKeys[fk];
    assert.ok(Object.prototype.hasOwnProperty.call(PERM_META.forms, pk),
      'acts 表单键 ' + fk + ' 归属的权限点 ' + pk + ' 必须在 forms 里存在');
  });
});

test('E5【契约】admin/admin-app.js 不得自建第二份权限清单（必须从 /api/perm-meta 取）', function () {
  const code = stripJsComments(ADMIN_APP_SRC);
  /* ① 不得出现权限显示名清单（9 个显示名一个都不许写死在后台） */
  Object.keys(PERM_META.forms).forEach(function (k) {
    const display = PERM_META.forms[k];
    assert.strictEqual(countOcc(code, display), 0,
      'admin-app.js 不得写死权限显示名「' + display + '」（必须由 meta.forms 下发）');
  });
  /* ② 不得出现权限清单字面量结构 */
  assert.strictEqual(/forms\s*:\s*\{\s*products\s*:/.test(code), false, 'admin-app.js 不得自建 forms 字面量');
  assert.strictEqual(/'products'\s*,\s*'parts'\s*,\s*'saleOrders'/.test(code), false, '不得硬编码权限键清单');
  assert.strictEqual(/formKeys\s*:\s*\{/.test(code), false, 'admin-app.js 不得自建 formKeys 字面量');
  /* ③ 正向：必须真的从 /api/perm-meta 取，且三处 UI 全部由 meta 派生 */
  assert.ok(/apiGet\('\/perm-meta'\)/.test(code), "admin-app.js 必须调用 apiGet('/perm-meta')");
  assert.ok(/Object\.keys\(META\.forms\)\.map/.test(code), '左栏复选框/右栏动作必须由 Object.keys(META.forms).map 派生');
  assert.ok(/Object\.keys\(meta\.forms\)\.filter/.test(code), '列表「表单写权限」列必须由 Object.keys(meta.forms).filter 派生');
  assert.ok(/input\[data-perm\]/.test(code) && /input\[data-act\]/.test(code),
    'saveUser 必须按 data-perm / data-act 统一收集（不得逐键取值）');
  /* ④ 元数据结构非法时必须降级（不得把非法 meta 当真用） */
  assert.ok(/okShape/.test(code), 'loadMeta 必须有结构校验（forms/formKeys/acts 三份齐备才算就绪）');
  assert.ok(code.indexOf('权限元数据结构非法') >= 0, '结构非法必须有明确降级原因');
});

test('E6【契约】GET /api/perm-meta 路由位于管理员硬闸之后（单一闸门，不重复判角色）', function () {
  const src = normEol(readRel('server/server.js'));
  const gate = src.indexOf("if (user.role !== 'admin') return send(res, 403, { error: '无权限' })");
  const route = src.indexOf("if (p === '/api/perm-meta' && req.method === 'GET')");
  assert.ok(gate > 0, '必须能定位管理员硬闸那一行');
  assert.ok(route > 0, '必须存在 GET /api/perm-meta 路由');
  assert.ok(route > gate, '/api/perm-meta 必须写在管理员硬闸之后（否则非管理员可读权限元数据）');
  /* 端点本身不得再写第二份角色判断（单一闸门） */
  const seg = src.slice(route, route + 300);
  assert.strictEqual(/role\s*!==\s*'admin'/.test(seg), false, '端点内不得重复判角色（闸门在上方，重复实现会漂移）');
  assert.ok(/return send\(res, 200, \{ ok: true, meta: PERM_META \}\)/.test(seg), '端点必须原样下发 PERM_META');
  /* 导出清单必须带上 PERM_META（后台测试与运维排查都靠它） */
  assert.ok(/PERM_META\s*\/\*/.test(src.slice(src.indexOf('module.exports'))) || /PERM_META\s*$/.test(src.slice(src.indexOf('module.exports')).trim()),
    'module.exports 必须导出 PERM_META');
});

/* ============================================================
   F · 服务端端点权限（真起临时 HTTP 服务，高位端口）
   ============================================================ */

/**
 * 在 127.0.0.1 的随机高位端口起一个真实 HTTP 服务（复用生产 handleRequest）。
 * 幂等：全文件只起一个，后续用例复用同一端口（避免多份 handle 吊住事件循环）。
 * @returns {Promise<number>} 端口号
 */
async function ensureTempServer() {
  if (httpPort) return httpPort;
  await new Promise(function (resolve, reject) {
    const s = http.createServer(srv.handleRequest);
    s.on('error', reject);
    s.listen(0, '127.0.0.1', function () {
      httpServer = s;
      httpPort = s.address().port;
      resolve();
    });
  });
  return httpPort;
}

/**
 * 发一个真实 HTTP 请求（用 node:http 直连，不用全局 fetch：
 * undici 的 keep-alive 连接会在测试结束后仍持有 socket，把事件循环拖住）。
 * @param {number} port
 * @param {string} method
 * @param {string} p
 * @param {{token?:string, body?:object}=} opts
 * @returns {Promise<{status:number, json:object}>}
 */
function apiCall(port, method, p, opts) {
  const o = opts || {};
  return new Promise(function (resolve, reject) {
    const payload = o.body === undefined ? null : Buffer.from(JSON.stringify(o.body), 'utf8');
    const headers = { Connection: 'close' };
    if (o.token) headers.Authorization = 'Bearer ' + o.token;
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    const req = http.request({ host: '127.0.0.1', port: port, path: p, method: method, headers: headers }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { json = null; }
        resolve({ status: res.statusCode, json: json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 登录拿 token（真跑 /api/login，不伪造会话） */
async function login(port, username, password) {
  const r = await apiCall(port, 'POST', '/api/login', { body: { username: username, password: password } });
  assert.strictEqual(r.status, 200, '夹具账号 ' + username + ' 必须能登录（否则本组全假）');
  assert.ok(r.json && r.json.token, '登录必须返回 token');
  return r.json.token;
}

test('F1【契约】/api/perm-meta：admin 200（9 键）/ staff 403 {error:无权限} / 无 token 401', async function () {
  const port = await ensureTempServer();
  assert.ok(port > 1024 && port <= 65535, '必须是高位端口（实测 ' + port + '）');
  const tAdmin = await login(port, 'admin', PWD_ADMIN);
  const tStaff = await login(port, 'pmc', PWD_STAFF);

  /* ① 管理员：200 + 元数据 9 键，且与模块导出的 PERM_META 逐字相同 */
  const ok = await apiCall(port, 'GET', '/api/perm-meta', { token: tAdmin });
  assert.strictEqual(ok.status, 200, '管理员 GET /api/perm-meta 必须 200');
  assert.strictEqual(ok.json.ok, true, '回包必须有 ok:true');
  assert.deepStrictEqual(Object.keys(ok.json.meta.forms).length, 9, 'forms 必须 9 个权限点');
  assert.strictEqual(JSON.stringify(ok.json.meta), JSON.stringify(plain(PERM_META)),
    'HTTP 下发的 meta 必须与 server.js 导出的 PERM_META 逐字相同');

  /* ② 员工：403 + 固定文案（与 /api/users 同一句，前端只维护一份） */
  const denied = await apiCall(port, 'GET', '/api/perm-meta', { token: tStaff });
  assert.strictEqual(denied.status, 403, '非管理员 GET /api/perm-meta 必须 403');
  assert.deepStrictEqual(denied.json, { error: '无权限' }, '403 文案必须恰为 {error:"无权限"}');

  /* ③ 无 token：401（先鉴权、后 admin 闸门） */
  const anon = await apiCall(port, 'GET', '/api/perm-meta');
  assert.strictEqual(anon.status, 401, '无 token 必须 401');
  assert.ok(anon.json && anon.json.error, '401 必须有 error 文案');
});

test('F2【契约·回归】/api/users 既有闸门未被本次改动削弱：staff 403 / 无 token 401 / admin 200', async function () {
  const port = await ensureTempServer();
  const tAdmin = await login(port, 'admin', PWD_ADMIN);
  const tStaff = await login(port, 'pmc', PWD_STAFF);

  const denied = await apiCall(port, 'GET', '/api/users', { token: tStaff });
  assert.strictEqual(denied.status, 403, 'staff GET /api/users 必须 403（本轮的改动不得削弱既有闸门）');
  assert.deepStrictEqual(denied.json, { error: '无权限' }, '403 文案必须与 perm-meta 一致');

  const anon = await apiCall(port, 'GET', '/api/users');
  assert.strictEqual(anon.status, 401, '无 token GET /api/users 必须 401');

  const ok = await apiCall(port, 'GET', '/api/users', { token: tAdmin });
  assert.strictEqual(ok.status, 200, '管理员 GET /api/users 必须 200');
  assert.ok(Array.isArray(ok.json.users), '回包必须含 users 数组');
  /* 不得泄露 hash/salt（权限元数据是新增面，不得顺带泄露账号口令字段） */
  ok.json.users.forEach(function (u) {
    assert.strictEqual(u.hash, undefined, 'publicUser 不得泄露 hash');
    assert.strictEqual(u.salt, undefined, 'publicUser 不得泄露 salt');
  });
});

test('F3【契约】写入类端点仍拒绝 staff（越权面不得因新增 perm-meta 而扩大）', async function () {
  const port = await ensureTempServer();
  const tStaff = await login(port, 'pmc', PWD_STAFF);
  /* staff 不得增删改员工（管理面只在管理员手里） */
  const post = await apiCall(port, 'POST', '/api/users', {
    token: tStaff,
    body: { username: 'hacker', name: 'hacker', role: 'admin', status: 'active', perms: {} }
  });
  assert.strictEqual(post.status, 403, 'staff POST /api/users 必须 403');
  const del = await apiCall(port, 'DELETE', '/api/users?username=admin', { token: tStaff });
  assert.strictEqual(del.status, 403, 'staff DELETE /api/users 必须 403');
  /* 员工列表不得因越权 POST 而多出账号 */
  const tAdmin = await login(port, 'admin', PWD_ADMIN);
  const list = await apiCall(port, 'GET', '/api/users', { token: tAdmin });
  assert.strictEqual(list.json.users.filter(function (u) { return u.username === 'hacker'; }).length, 0,
    '越权 POST 不得真的创建账号');
});

test('F4【契约】本文件全程未读写真实 server/data.json · server/users.json（md5 自证）', function () {
  const after = { data: md5OfFile(REAL_DATA_FILE), users: md5OfFile(REAL_USERS_FILE) };
  assert.strictEqual(after.data, REAL_MD5_BEFORE.data,
    '真实 server/data.json 被改动了（本文件必须只用 PROD_DATA_FILE 指向的临时文件）');
  assert.strictEqual(after.users, REAL_MD5_BEFORE.users,
    '真实 server/users.json 被改动了（本文件必须只用 PROD_USERS_FILE 指向的临时文件）');
});

/* ============================================================
   G · 部署资产（文本级 + bash -n）
   ============================================================ */

test('G1【契约】ops/nginx-admin.conf：恰 1 条 /admin → 301 /admin/，marker 成对，不新增任何反代', function () {
  /* 判「生效配置」= 去掉 `#` 注释行后的部分（片段里大段注释解释「为什么不再加 location /」，
     注释中的字样不得参与判定 —— 否则会把说明文字当成配置） */
  const conf = normEol(NGINX_SNIPPET).split('\n')
    .filter(function (l) { return !/^\s*#/.test(l); }).join('\n');
  assert.ok(conf.indexOf('location = /admin {') >= 0, '必须含 location = /admin {');
  assert.strictEqual(countRe(conf, /location\s*=\s*\/admin\s*\{/), 1, '必须恰有 1 条 location = /admin {');
  assert.strictEqual(countRe(conf, /return 301 \/admin\/;/), 1, '必须恰有 1 条 return 301 /admin/;');
  /* marker 必须成对（deploy 的幂等替换靠它），且 BEGIN 在 END 之前 */
  const b = NGINX_SNIPPET.indexOf('# >>> admin-system BEGIN');
  const e = NGINX_SNIPPET.indexOf('# <<< admin-system END <<<');
  assert.ok(b >= 0, '缺 admin-system BEGIN marker');
  assert.ok(e > b, 'admin-system END marker 必须在 BEGIN 之后');
  assert.strictEqual(countRe(NGINX_SNIPPET, /admin-system BEGIN/), 1, 'BEGIN marker 必须恰 1 处');
  assert.strictEqual(countRe(NGINX_SNIPPET, /admin-system END/), 1, 'END marker 必须恰 1 处');
  /* 方案 A：纯静态页复用生产现有 location /api ⇒ 生效配置里不得出现任何反代/端口 */
  assert.strictEqual(/proxy_pass/.test(conf), false, '本片段不得含 proxy_pass（方案 A 不新增任何代理）');
  assert.strictEqual(/proxy_set_header/.test(conf), false, '本片段不得含 proxy_set_header');
  assert.strictEqual(/127\.0\.0\.1:\d+/.test(conf), false, '本片段不得出现后端端口');
  /* 不得顺手改生产根路由（不然一次部署把整站改了） */
  assert.strictEqual(/location\s*=\s*\/\s*\{/.test(conf), false, '本片段不得定义 location = /（生产首页）');
  assert.strictEqual(/location\s+\/\s*\{/.test(conf), false, '本片段不得定义 location /（生产根路由）');
  /* 生效配置里应恰有 1 条 location（只有 /admin 那条） */
  assert.strictEqual(countRe(conf, /\blocation\b/), 1, '生效配置里必须恰有 1 条 location 指令');
});

test('G2【契约】deploy-admin.sh：bash -n 通过；curl 一律 -k + https://127.0.0.1；不碰生产前端与后端进程', async function () {
  fs.chmodSync(path.join(ROOT, 'deploy-admin.sh'), 0o644);
  /* ① 语法必须能过（bash -n 只解析不执行 —— 本文件绝不运行部署脚本） */
  execFileSync('bash', ['-n', path.join(ROOT, 'deploy-admin.sh')], { cwd: ROOT, stdio: 'pipe' });

  const lines = normEol(DEPLOY_SH).split('\n');
  const code = lines.filter(function (l) { return !/^\s*#/.test(l); }).join('\n');

  /* ② 不得重启/触碰生产与质量系统的后端进程 */
  ['systemctl restart prod-server', 'systemctl stop prod-server', 'restart qa-server',
    'systemctl restart qa-server', 'systemctl stop qa-server'].forEach(function (bad) {
    assert.strictEqual(countOcc(code, bad), 0, 'deploy-admin.sh 不得执行：' + bad);
  });
  /* ③ 不得**写入**生产后端目录 / 生产前端文件（读 md5 / 提示文案里提到是允许的） */
  const WRITE_OP = /(\bscp\b|\bcp\b|\bmv\b|\brm\b|\btee\b|\btruncate\b|\bdd\b|\bsed\s+-i\b|>\s*\$?\{?(PROD_INDEX|WEB_DIR_REMOTE|CONF)\b)/;
  const optLines = lines.filter(function (l) { return l.indexOf('/opt/prod-server') >= 0 && !/^\s*#/.test(l); });
  optLines.forEach(function (l) {
    assert.strictEqual(WRITE_OP.test(l), false, 'deploy-admin.sh 不得对 /opt/prod-server/* 做写操作：' + l.trim());
  });
  /* 代码行里也不得出现针对 /opt/prod-server 的 ssh 写命令组合 */
  assert.strictEqual(/rsh[^\n]*\/opt\/prod-server/.test(code), false,
    'deploy-admin.sh 不得通过 rsh 触碰 /opt/prod-server');
  const prodIndexLines = lines.filter(function (l) { return l.indexOf('/var/www/html/index.html') >= 0; });
  assert.ok(prodIndexLines.length >= 1, '必须能定位对生产前端的 md5 读取（前后比对的判据）');
  prodIndexLines.forEach(function (l) {
    assert.strictEqual(/\b(scp|cp|mv|rm|tee|truncate)\b/.test(l), false,
      '不得对生产前端 index.html 做写操作：' + l.trim());
    assert.strictEqual(/^[^#]*>\s*\/var\/www\/html\/index\.html/.test(l), false, '不得重定向覆盖生产前端：' + l.trim());
  });
  assert.strictEqual(/scp[^\n]*\/var\/www\/html\/index\.html/.test(code), false,
    '不得 scp 覆盖生产前端 /var/www/html/index.html');
  /* ④ 必须有「生产前端 md5 前后一致」的硬断言（这是没碰生产的唯一硬证据） */
  assert.ok(/PROD_MD5_BEFORE/.test(code) && /PROD_MD5_AFTER/.test(code), '必须有 md5 前后基线');
  assert.ok(/\[\s*"\$PROD_MD5_BEFORE"\s*=\s*"\$PROD_MD5_AFTER"\s*\]/.test(code),
    '必须有「前后 md5 必须相等」的断言，不等即 die');
  /* ⑤ 所有 curl 一律 -k + https://127.0.0.1（线上 80 全 301 到 443，自签证书） */
  const curlLines = lines.filter(function (l) { return /\bcurl\b/.test(l) && !/^\s*#/.test(l); });
  assert.ok(curlLines.length >= 1, '必须能定位 curl 调用');
  curlLines.forEach(function (l) {
    assert.ok(/\bcurl\s+-[a-z]*k/.test(l), 'curl 必须带 -k（自签证书）：' + l.trim());
  });
  assert.ok(/SITE="https:\/\/127\.0\.0\.1"/.test(code), 'SITE 必须是 https://127.0.0.1');
  assert.strictEqual(/http:\/\/127\.0\.0\.1/.test(code), false, '不得用 http://127.0.0.1（80 会 301）');
  /* ⑥ 不得访问真实域名/远端用户数据文件 */
  assert.strictEqual(countOcc(code, 'users.json'), 0, 'deploy-admin.sh 不得触碰 users.json（员工数据一个字都不碰）');
  /* ⑦ nginx 变更必须有「失败即回滚 + 不 reload」的安全闸门 */
  assert.ok(/nginx -t/.test(code), '必须有 nginx -t 安全闸门');
  assert.ok(/cp -p "\$BAK" "\$CONF"/.test(code), 'nginx -t 失败必须用备份回滚');
});

test('G3【契约】admin/index.html 的水印能被 deploy-admin.sh 的提取式命中（部署闸门①的前提）', function () {
  const ver = normEol(DEPLOY_SH);
  /* 复刻脚本里的提取式：grep -oE 'build [0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+<' */
  const m = /build [0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+</.exec(ADMIN_HTML);
  assert.ok(m, 'admin/index.html 必须存在 build YYYY-MM-DD.NNN< 形态的水印（脚本靠它提取）');
  const aver = m[0].replace(/<$/, '');
  assert.ok(/\^build \[0-9\]\{4\}/.test(ver) || ver.indexOf('build [0-9]{4}-[0-9]{2}-[0-9]{2}') >= 0,
    'deploy-admin.sh 必须仍用同款提取式');
  /* 提取式的唯一性：全文该正则只命中 1 处（脚本取 head -1，但 2 处说明有脏水印） */
  assert.strictEqual((ADMIN_HTML.match(new RegExp('build [0-9]{4}-[0-9]{2}-[0-9]{2}\\.[0-9]+<', 'g')) || []).length, 1,
    '「build …<」形态的水印必须恰 1 处（' + aver + '）');
  assert.strictEqual(aver, 'build 2026-11-25.001', '后台水印提取结果必须与页面声明一致');
});

/* ============================================================
   H · 版本与文档锚点（全部派生，禁手抄字面量）
   ============================================================ */
const BUILD_DATE = String(build.BUILD).split('.')[0];
const BUILD_NO = String(build.BUILD).split('.')[1];
const PREV_NO = String(build.PREV).split('.')[1];

test('H1【契约】build.js 的 BUILD/PREV 与 index.html 水印 / README 版本行 / guide.js 文首 四处互证', function () {
  /* ① build.js 必须是**手写字面量**（不得从 index.html 反推，否则断言恒真） */
  const bjs = stripJsComments(BUILD_JS_SRC);
  assert.strictEqual(countOcc(bjs, "const BUILD = '" + build.BUILD + "';"), 1, 'build.js 必须手写 const BUILD');
  assert.strictEqual(countOcc(bjs, "const PREV = '" + build.PREV + "';"), 1, 'build.js 必须手写 const PREV');
  assert.strictEqual(/readFileSync|index\.html|require\s*\(/.test(bjs), false, 'build.js 不得反推版本号');

  /* ② index.html 的权威水印必须与 BUILD 双向一致（用 deploy.sh 的提取式独立求一次） */
  assert.strictEqual(countOcc(INDEX_SRC_LF, '>build ' + build.BUILD + '<'), 1,
    'index.html 权威水印必须恰 1 处且等于 build.js 的 BUILD');
  const extracted = /build [0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+</.exec(INDEX_SRC_LF);
  assert.ok(extracted, 'index.html 必须有 build …< 形态的水印');
  assert.strictEqual(extracted[0].replace(/<$/, ''), 'build ' + build.BUILD,
    'deploy.sh 提取出的水印必须等于 build.js 的 BUILD');

  /* ③ README 版本行 */
  assert.ok(README_SRC.indexOf('`build ' + build.BUILD + '`') >= 0, 'README 当前版本行必须等于 BUILD');

  /* ④ guide.js 文首「更新：YYYY-MM-DD（build .NNN）」 */
  const head = GUIDE_SRC.split('\n').slice(0, 8).join('\n');
  assert.ok(head.indexOf('更新：' + BUILD_DATE + '（build .' + BUILD_NO + '）') >= 0,
    'guide.js 文首更新行必须为 更新：' + BUILD_DATE + '（build .' + BUILD_NO + '）');
  /* 反向：上一版更新行必须 0 处 */
  assert.strictEqual(GUIDE_SRC.indexOf('更新：' + String(build.PREV).split('.')[0] + '（build .' + PREV_NO + '）'), -1,
    'guide.js 不得残留上一版更新行');
});

test('H2【契约】index.html 完整版本号恰 1 处；短令牌 build .164 至少 1 处（注释只许写短令牌）', function () {
  /* buildAnyRe 口径：完整版本号（含注释）全文必须恰 1 处 */
  assert.strictEqual((INDEX_SRC_LF.match(build.buildAnyRe(build.BUILD)) || []).length, 1,
    'index.html 完整版本号必须恰 1 处（.155 教训：注释里写完整版本号会被计数断言打成 2 处）');
  /* 上一版任意形态 0 处 */
  assert.strictEqual((INDEX_SRC_LF.match(build.buildAnyRe(build.PREV)) || []).length, 0,
    'index.html 不得残留上一版版本号（任意形态）');
  /* 短令牌 ≥ 1（版本沿革注释用短形态） */
  assert.ok(countRe(INDEX_SRC_LF, new RegExp('build \\.' + BUILD_NO + '(?![0-9])')) >= 1,
    'index.html 应至少出现 1 处短令牌 build .' + BUILD_NO);
  /* 反虚设：不存在的版本号必须命中 0 */
  assert.strictEqual((INDEX_SRC_LF.match(build.buildAnyRe('2099-01-01.999')) || []).length, 0,
    '反虚设：伪版本号必须命中 0（否则上面的「恰 1 处」可能只是正则失效）');
});

test('H3【契约】README 左侧菜单项数 = 11，且与 index.html 的 NAV 实际项数一致（文档漂移守卫）', function () {
  assert.ok(README_SRC.indexOf('左侧菜单共 **11 项**') >= 0,
    'README 必须声明「左侧菜单共 11 项」（.164 起员工管理迁出，原 12 项）');
  assert.strictEqual(README_SRC.indexOf('左侧菜单共 **12 项**'), -1, 'README 不得残留「12 项」');
  const navStart = INDEX_SRC.indexOf('const NAV=[');
  const navDef = INDEX_SRC.slice(navStart, INDEX_SRC.indexOf('];', navStart));
  const ids = (navDef.match(/\{id:'[^']+'/g) || []).map(function (x) { return x.slice(5, -1); });
  assert.strictEqual(ids.length, 11, 'NAV 实际项数必须与 README 声明一致（11）');
  /* README 的双系统声明必须扩为三系统（.164 起多了管理员后台） */
  assert.ok(/质量系统 `\/quality\/`/.test(README_SRC) && /管理员后台 `\/admin\/`/.test(README_SRC),
    'README 必须声明质量系统与管理员后台两套独立页面');
});

test('H4【契约】tests/check-syntax.js 已纳入 admin/admin-app.js（后台 JS 必须逐文件语法校验）', function () {
  const src = readRel('tests/check-syntax.js');
  assert.ok(src.indexOf("'admin/admin-app.js'") >= 0,
    'check-syntax.js 必须把 admin/admin-app.js 纳入 node --check 清单（否则语法错会直接白屏上线）');
  /* 前提：该文件确实是它自己的语法检查清单（不是注释里提一句） */
  const arr = /const files = \[([\s\S]*?)\];/.exec(src);
  assert.ok(arr, '必须能定位 check-syntax.js 的 files 清单');
  assert.ok(arr[1].indexOf("'admin/admin-app.js'") >= 0, 'admin/admin-app.js 必须在 files 清单内（非注释）');
});
