'use strict';
/* ================================================================
   tests/harness/sandbox.js —— vm 沙箱装载器（测试地基核心）
   ================================================================
   设计依据：docs/P1地基轮设计-2026-09-11.md §6.1 / §6.2 / §6.3 / §6.4
   零依赖：只用 Node 内置 vm / fs / path（**不允许** 引入任何 npm 包，仓库无 package.json）

   做什么：
     1) 把 js/*.js 与 index.html 的**主内联 <script>** 装入同一个 vm 上下文，
        使 `sandbox.run('applyTransfers')` 能取到生产函数、`getGlobal('orders')` 能取到生产数据。
     2) 装载前**剥离主脚本末尾的 `bootstrap();` 自动执行点**（否则装载即触发 initApp 全链）。
     3) 注入最小浏览器全局桩（dom-stub）与可控的写集记录器（recorder）。

   如何理解「两个作用域」——**这是本 harness 最容易踩的坑，务必读**：
     - `function f(){}` / `var x` 顶层声明 → 成为 vm **全局对象属性**（globalThis.x）。
       因此可以直接用 app.sandbox.x 读写、覆盖（recorder 就是靠这个替换 save）。
     - `let x` / `const x` 顶层声明（如 orders/products/transfers/currentUser/DB/API_BASE）
       → 进入 vm 的**全局词法环境**，**不是**全局对象属性。
       因此：❌ `app.sandbox.orders = [...]` 会创建一个被词法绑定「遮蔽」的新属性，**静默无效**；
             ✅ 必须用 `app.setGlobal('orders', [...])`（内部用 runInContext 求值赋值）。
       读同理：❌ `app.sandbox.orders`（得到 undefined）→ ✅ `app.getGlobal('orders')`。

   能力边界（明确声明，勿误用；对应设计 §6.2 / §6.4）：
     - 无 DOM 布局、无渲染、无事件派发、无真实网络（fetch 默认未打桩即抛错）。
     - 不装载 index.html 的第 1 块（beacon IIFE）与第 3 块（单元格悬浮提示）内联脚本。
     - 不解析真实 xlsx（FileReader 未打桩）。
     - 装载成功 ≠ 逻辑正确：只证明「脚本可在隔离上下文求值」。

   ⚠️ 必须用**文件**方式运行测试（`node --test` / `node tests/xxx.test.js`）。
      **不要用 `node -e "..."` 或 `node --eval` 驱动本 harness** —— 本机 Node v24.14.0 实测：
      当宿主 realm 是 eval 脚本时，vm 上下文内的**字符串值**会被破坏
      （`vm.runInContext('JSON.stringify({k:"abc"})')` 得到 `{"k":{}}`，`({key:'orders'}).key`
      得到 RegExp `/orders/`），从而让写集断言全部失真。文件执行下完全正常（已实测）。
      这是执行环境的怪异行为，不是生产代码缺陷。
   ================================================================ */

const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const domStub = require('./dom-stub');
const { createRecorder } = require('./recorder');

/** 仓库根目录（tests/harness → ../..） */
const ROOT = path.resolve(__dirname, '..', '..');
const INDEX_FILE = 'index.html';

/** 与 index.html 中 <script src> 的**引入顺序严格一致**（guide.js 为纯数据，无副作用） */
const MODULE_FILES = ['js/guide.js', 'js/logs.js', 'js/import.js', 'js/prodplan-core.js', 'js/transfer.js'];

const SAFE_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/* ------------------------------------------------------------------
   内联脚本提取
------------------------------------------------------------------ */

/**
 * 提取 index.html 中的**内联** <script>（跳过带 src 的）。
 * @param {string} html
 * @returns {Array<{index:number, startLine:number, endLine:number, code:string, attrs:string}>}
 */
function extractInlineScripts(html) {
  if (typeof html !== 'string') throw new Error('[sandbox] extractInlineScripts 需要 HTML 字符串');
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  const out = [];
  let m;
  let i = 0;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue; // 外链脚本不在本沙箱装载范围内
    const openTagEnd = m.index + m[0].indexOf('>') + 1; // 代码起点（开标签 '>' 之后）
    const before = html.slice(0, openTagEnd);
    const startLine = before.split('\n').length; // 代码首行在 index.html 中的行号
    const code = m[2];
    const lines = code.split('\n').length;
    out.push({
      index: i++,
      startLine: startLine,
      endLine: startLine + lines - 1,
      code: code,
      attrs: attrs,
    });
  }
  return out;
}

/** 选出「主内联脚本」= 含 bootstrap() 自动执行点的最长块。 */
function findMainScript(scripts) {
  const cands = (scripts || []).filter(function (s) {
    return /(^|\n)[ \t]*bootstrap\(\)[ \t]*;/.test(s.code);
  });
  if (cands.length === 0) {
    throw new Error('[sandbox] 未在 index.html 内联脚本中找到 `bootstrap();` 自动执行点——index.html 结构可能已变，请更新 harness');
  }
  return cands.sort(function (a, b) {
    return b.code.length - a.code.length;
  })[0];
}

/**
 * 剥离主脚本末尾的 `bootstrap();`（唯一自动执行点）。
 * 用空行替换（保持后续行号与 index.html 一致，便于栈追踪定位）。
 * @returns {{code:string, stripped:boolean, line:number|null}}
 */
function stripBootstrap(code) {
  const lines = String(code).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t === '') continue; // 跳过尾随空行
    if (/^bootstrap\(\)[ \t]*;$/.test(t)) {
      lines[i] = '';
      return { code: lines.join('\n'), stripped: true, line: i + 1 };
    }
    break; // 末条非空语句不是 bootstrap(); → 不再向前找
  }
  return { code: String(code), stripped: false, line: null };
}

/* ------------------------------------------------------------------
   createApp
------------------------------------------------------------------ */

/**
 * 创建一个已装载生产代码的沙箱应用。
 * @param {Object} [opts]
 *   - root        仓库根（默认自动定位）
 *   - moduleFiles 要装载的模块脚本（默认 MODULE_FILES，顺序即引入顺序）
 *   - transformModule(rel, code) → code   模块源码改写钩子（默认恒等）
 *   - transformMain(code) → code          主内联脚本改写钩子（在 stripBootstrap 之后执行）
 *   - installRecorder 是否立即用 recorder 覆盖 save/DB.set/DB.tx（默认 true）
 *   - recorder    复用外部 recorder 实例
 *   - seed        {globalName: value}：装载后经 setGlobal 正确赋值（对 let/const 亦有效）
 *   - localStorage / sessionStorage 初始键值
 *   - confirmResult / promptResult     confirm()/prompt() 的固定返回值
 *   - quietConsole 用空实现替换 console（默认 false）
 *   - indexHtml   直接传入 HTML 文本（默认读磁盘 index.html）
 * @returns {Object} app
 */
function createApp(opts) {
  const options = opts || {};
  const root = options.root ? path.resolve(options.root) : ROOT;
  const indexHtmlPath = path.join(root, INDEX_FILE);
  const moduleFiles = options.moduleFiles || MODULE_FILES;

  /* ---------- 1) 浏览器全局桩 ---------- */
  const browser = domStub.createBrowserGlobals({
    localStorage: options.localStorage,
    sessionStorage: options.sessionStorage,
    confirmResult: options.confirmResult,
    promptResult: options.promptResult,
  });

  /* ---------- 2) 定时器（宿主实现 + unref，避免测试进程被挂住） ---------- */
  const timers = new Set();
  function track(t) {
    if (t && typeof t.unref === 'function') t.unref();
    timers.add(t);
    return t;
  }
  const timerGlobals = {
    setTimeout: function (fn, ms) {
      const extra = Array.prototype.slice.call(arguments, 2);
      return track(setTimeout(fn, ms, ...extra));
    },
    setInterval: function (fn, ms) {
      const extra = Array.prototype.slice.call(arguments, 2);
      return track(setInterval(fn, ms, ...extra));
    },
    clearTimeout: function (t) {
      timers.delete(t);
      clearTimeout(t);
    },
    clearInterval: function (t) {
      timers.delete(t);
      clearInterval(t);
    },
    queueMicrotask: function (fn) {
      queueMicrotask(fn);
    },
  };

  /* ---------- 3) 组装 sandbox ---------- */
  const log = options.quietConsole
    ? { log: function () {}, warn: function () {}, error: function () {}, info: function () {}, debug: function () {} }
    : console;

  const sandbox = Object.assign({}, browser.globals, timerGlobals, {
    console: log,
    /* 沙箱专用：setGlobal / installRecorder 的临时中转槽（每次用完即删） */
    __vmInject: undefined,
  });
  /* 刻意**不注入** Object/Array/JSON/Math/Date/Promise 等标准内建：vm 新上下文自带完整
     ECMAScript 内建，注入宿主版本会让上下文内的 `Array.isArray`/`instanceof` 变成跨 realm
     判定，制造假故障。只注入上下文确实缺失的东西（console / 定时器 / DOM 桩）。 */
  /* 让宿主定时器同时可从 window 访问（部分代码走 window.setTimeout） */
  browser.window.setTimeout = timerGlobals.setTimeout;
  browser.window.clearTimeout = timerGlobals.clearTimeout;
  browser.window.setInterval = timerGlobals.setInterval;
  browser.window.clearInterval = timerGlobals.clearInterval;
  browser.window.console = log;

  const ctx = vm.createContext(sandbox);

  /* ---------- 4) 装载 ---------- */
  const loaded = [];
  const compile = function (code, filename, lineOffset) {
    const scriptOpts = { filename: filename };
    if (lineOffset) scriptOpts.lineOffset = lineOffset;
    return new vm.Script(code, scriptOpts);
  };

  /* 4a) 模块脚本（js/*.js）——仓库相对路径，与 index.html 的 <script src> 同序 */
  for (const rel of moduleFiles) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) throw new Error('[sandbox] 模块脚本不存在: ' + rel);
    let code = fs.readFileSync(abs, 'utf8');
    if (typeof options.transformModule === 'function') code = options.transformModule(rel, code);
    compile(code, rel).runInContext(ctx);
    loaded.push({ file: rel, lines: code.split('\n').length, kind: 'module' });
  }

  /* 4b) index.html 主内联脚本（剥离 bootstrap();） */
  const html = options.indexHtml !== undefined ? options.indexHtml : fs.readFileSync(indexHtmlPath, 'utf8');
  const inlineScripts = extractInlineScripts(html);
  const main = findMainScript(inlineScripts);
  const strippedResult = stripBootstrap(main.code);
  if (!strippedResult.stripped) {
    throw new Error('[sandbox] 未能剥离主内联脚本末尾的 `bootstrap();`——拒绝装载（否则会触发 initApp 全链）');
  }
  let mainCode = strippedResult.code;
  if (typeof options.transformMain === 'function') mainCode = options.transformMain(mainCode);
  const mainFilename = INDEX_FILE + '#main';
  compile(mainCode, mainFilename, main.startLine - 1).runInContext(ctx);
  loaded.push({
    file: mainFilename,
    lines: mainCode.split('\n').length,
    kind: 'inline',
    startLine: main.startLine,
    endLine: main.endLine,
  });

  /* ---------- 5) app 句柄 ---------- */
  const app = {
    root: root,
    sandbox: sandbox,
    ctx: ctx,
    browser: browser,
    alerts: browser.alerts,
    confirms: browser.confirms,
    prompts: browser.prompts,
    localStorage: browser.storage.local,
    sessionStorage: browser.storage.session,
    loaded: loaded,
    inlineScripts: inlineScripts,
    mainScript: {
      filename: mainFilename,
      startLine: main.startLine,
      endLine: main.endLine,
      bootstrapLine: main.startLine + strippedResult.line - 1,
      stripped: true,
    },
    moduleFiles: moduleFiles.slice(),
    recorder: null,
    originals: null,
  };

  /** 在上下文内求值一段代码。 */
  app.run = function (code, filename) {
    return compile(String(code), filename || '<test>').runInContext(ctx);
  };

  /** 读取全局（对 let/const 词法绑定同样有效；未声明 → undefined）。 */
  app.getGlobal = function (name) {
    if (!SAFE_IDENT.test(String(name))) throw new Error('[sandbox] 非法全局名: ' + name);
    return app.run('typeof ' + name + ' === "undefined" ? undefined : ' + name);
  };

  /** 写入全局（对 let/const 词法绑定同样有效；对 const 赋值会抛 TypeError——属预期）。 */
  app.setGlobal = function (name, value) {
    if (!SAFE_IDENT.test(String(name))) throw new Error('[sandbox] 非法全局名: ' + name);
    sandbox.__vmInject = value;
    try {
      app.run(name + ' = __vmInject;');
    } finally {
      delete sandbox.__vmInject;
    }
    return value;
  };

  /** 批量 setGlobal */
  app.setGlobals = function (map) {
    Object.keys(map || {}).forEach(function (k) {
      app.setGlobal(k, map[k]);
    });
  };

  /** 判断某个全局是否已声明（含词法绑定） */
  app.hasGlobal = function (name) {
    if (!SAFE_IDENT.test(String(name))) return false;
    return app.run('typeof ' + name + ' !== "undefined"');
  };

  /** fetch 打桩入口（生产代码通过全局 fetch 发请求，故替换全局即可）。 */
  app.setFetch = function (fn) {
    if (typeof fn !== 'function') throw new Error('[sandbox] setFetch 需要函数');
    sandbox.fetch = fn;
    return fn;
  };

  /** 用记录器覆盖生产写入口 save / DB.set / DB.tx（函数/对象属性赋值，前后签名一致）。 */
  app.installRecorder = function (recorderOpts) {
    const rec = recorderOpts && typeof recorderOpts.save === 'function' && typeof recorderOpts.dbTx === 'function'
      ? recorderOpts
      : createRecorder(recorderOpts || {});
    const DBobj = app.getGlobal('DB');
    const hadTx = DBobj && typeof DBobj.tx === 'function';
    app.originals = {
      save: app.getGlobal('save'),
      DBset: DBobj ? DBobj.set : undefined,
      DBtx: hadTx ? DBobj.tx : undefined,
    };
    sandbox.__vmRecorder = { save: rec.save, dbSet: rec.dbSet, dbTx: rec.dbTx };
    try {
      app.run('save = __vmRecorder.save; DB.set = __vmRecorder.dbSet; DB.tx = __vmRecorder.dbTx;');
    } finally {
      delete sandbox.__vmRecorder;
    }
    app.recorder = rec;
    return rec;
  };

  /** 还原生产 save / DB.set / DB.tx（用于「零改动回归」类测试）。 */
  app.restoreOriginals = function () {
    if (!app.originals) return false;
    sandbox.__vmOriginal = app.originals;
    try {
      app.run('save = __vmOriginal.save; DB.set = __vmOriginal.DBset; DB.tx = __vmOriginal.DBtx;');
    } finally {
      delete sandbox.__vmOriginal;
    }
    return true;
  };

  /** 清理宿主定时器，避免测试进程被挂住。 */
  app.dispose = function () {
    timers.forEach(function (t) {
      clearTimeout(t);
      clearInterval(t);
    });
    timers.clear();
  };

  /* ---------- 6) seed ---------- */
  if (options.seed) app.setGlobals(options.seed);

  /* ---------- 7) 默认安装记录器 ---------- */
  if (options.recorder) {
    app.installRecorder(options.recorder);
  } else if (options.installRecorder !== false) {
    app.installRecorder({});
  }

  return app;
}

module.exports = {
  createApp: createApp,
  extractInlineScripts: extractInlineScripts,
  findMainScript: findMainScript,
  stripBootstrap: stripBootstrap,
  ROOT: ROOT,
  INDEX_FILE: INDEX_FILE,
  MODULE_FILES: MODULE_FILES,
};
