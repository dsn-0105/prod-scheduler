'use strict';
/* ================================================================
   tests/harness/dom-stub.js —— 最小浏览器全局桩（零依赖，仅用 Node 内置）
   ================================================================
   设计依据：docs/P1地基轮设计-2026-09-11.md §6.2「桩的边界与局限」

   目标（唯一目标）：让生产脚本（js/*.js + index.html 主内联脚本）能装载成功
   且不抛错，并能被测试驱动其**纯逻辑**与**写集**。**不追求 DOM 行为保真**。

   能力边界（明确声明，勿误用）：
   - document.getElementById 一律返回 null；querySelector/querySelectorAll 返回 null/[]
     → 任何「以读取 DOM 输入为前提」的函数不可测（见设计 §6.4 不可测清单）。
   - createElement 返回「假节点」：只保证属性可读写、常用方法可调用且不抛错，
     没有布局、没有渲染、没有真实事件派发（addEventListener 不注册任何东西）。
   - localStorage/sessionStorage 是内存 Map 实现（写入不回读磁盘，跨 createApp 不共享）。
   - fetch 默认是「未打桩即报错」的桩，请用 createFetchStub() 注入。
   - alert/confirm/prompt 只记录调用，不阻塞。
   ================================================================ */

/** 创建一个内存 Storage（模拟 localStorage / sessionStorage）。 */
function createStorage(initial) {
  const map = new Map();
  if (initial && typeof initial === 'object') {
    Object.keys(initial).forEach(function (k) {
      map.set(String(k), String(initial[k]));
    });
  }
  return {
    getItem: function (k) {
      k = String(k);
      return map.has(k) ? map.get(k) : null;
    },
    setItem: function (k, v) {
      map.set(String(k), String(v));
    },
    removeItem: function (k) {
      map.delete(String(k));
    },
    clear: function () {
      map.clear();
    },
    key: function (i) {
      const keys = Array.from(map.keys());
      return i >= 0 && i < keys.length ? keys[i] : null;
    },
    get length() {
      return map.size;
    },
    /* 便于测试断言：暴露底层 Map（非标准，仅测试用） */
    _map: map,
  };
}

/** 创建一个「假节点」——属性可读写、常用方法可调用且不抛错。 */
function createFakeElement(tag) {
  const name = String(tag == null ? 'div' : tag).toLowerCase();
  const el = {
    /* --- 标识 / 结构 --- */
    tagName: name.toUpperCase(),
    nodeName: name.toUpperCase(),
    nodeType: 1,
    id: '',
    className: '',
    children: [],
    childNodes: [],
    parentElement: null,
    parentNode: null,
    firstChild: null,
    lastChild: null,
    nextSibling: null,
    previousSibling: null,
    ownerDocument: null,
    /* --- 内容 / 表单 --- */
    innerHTML: '',
    outerHTML: '',
    textContent: '',
    innerText: '',
    value: '',
    checked: false,
    disabled: false,
    hidden: false,
    readOnly: false,
    required: false,
    selectedIndex: -1,
    options: [],
    files: [],
    rows: 0,
    type: '',
    name: '',
    href: '',
    src: '',
    title: '',
    placeholder: '',
    /* --- 尺寸 / 布局（一律 0，勿用于断言真实布局） --- */
    offsetWidth: 0,
    offsetHeight: 0,
    offsetTop: 0,
    offsetLeft: 0,
    clientWidth: 0,
    clientHeight: 0,
    scrollWidth: 0,
    scrollHeight: 0,
    scrollTop: 0,
    scrollLeft: 0,
    /* --- 样式 / 类名 / 数据集 --- */
    style: {},
    dataset: {},
    classList: {
      add: function () {},
      remove: function () {},
      toggle: function () {
        return false;
      },
      contains: function () {
        return false;
      },
      toString: function () {
        return '';
      },
    },
    /* --- 方法（一律 no-op / 空集合） --- */
    appendChild: function (c) {
      el.children.push(c);
      el.childNodes.push(c);
      if (c && typeof c === 'object') {
        c.parentElement = el;
        c.parentNode = el;
      }
      return c;
    },
    removeChild: function (c) {
      const i = el.children.indexOf(c);
      if (i >= 0) el.children.splice(i, 1);
      const j = el.childNodes.indexOf(c);
      if (j >= 0) el.childNodes.splice(j, 1);
      return c;
    },
    insertBefore: function (c) {
      return el.appendChild(c);
    },
    replaceChild: function (c) {
      return c;
    },
    append: function () {},
    prepend: function () {},
    remove: function () {},
    cloneNode: function () {
      return createFakeElement(name);
    },
    contains: function () {
      return false;
    },
    closest: function () {
      return null;
    },
    matches: function () {
      return false;
    },
    querySelector: function () {
      return null;
    },
    querySelectorAll: function () {
      return [];
    },
    getElementsByTagName: function () {
      return [];
    },
    getElementsByClassName: function () {
      return [];
    },
    setAttribute: function (k, v) {
      el.dataset[k] = String(v);
    },
    getAttribute: function (k) {
      return Object.prototype.hasOwnProperty.call(el.dataset, k) ? el.dataset[k] : null;
    },
    removeAttribute: function (k) {
      delete el.dataset[k];
    },
    hasAttribute: function (k) {
      return Object.prototype.hasOwnProperty.call(el.dataset, k);
    },
    addEventListener: function () {},
    removeEventListener: function () {},
    dispatchEvent: function () {
      return true;
    },
    insertAdjacentHTML: function () {},
    focus: function () {},
    blur: function () {},
    click: function () {},
    select: function () {},
    scrollIntoView: function () {},
    animate: function () {
      return { cancel: function () {} };
    },
    getBoundingClientRect: function () {
      return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
    },
    normalize: function () {},
    /* --- 仅在少数路径被读到的属性 --- */
    contentEditable: 'false',
    isContentEditable: false,
    draggable: false,
    tabIndex: -1,
  };
  /* style 需要 cssText 可读写（生产代码多处 el.style.cssText='...'） */
  let cssText = '';
  Object.defineProperty(el.style, 'cssText', {
    get: function () {
      return cssText;
    },
    set: function (v) {
      cssText = String(v == null ? '' : v);
    },
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(el.style, 'setProperty', {
    value: function (k, v) {
      el.style[k] = v;
    },
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(el.style, 'getPropertyValue', {
    value: function (k) {
      return el.style[k] == null ? '' : String(el.style[k]);
    },
    enumerable: false,
    configurable: true,
  });
  return el;
}

/** 创建一个最小 document 桩。getElementById 恒为 null（设计 §6.2 明确要求）。 */
function createDocument() {
  const doc = {
    /* 设计 §6.2：getElementById 一律返回 null —— 这是「不可测边界」的来源，勿改 */
    getElementById: function () {
      return null;
    },
    querySelector: function () {
      return null;
    },
    querySelectorAll: function () {
      return [];
    },
    getElementsByTagName: function () {
      return [];
    },
    getElementsByClassName: function () {
      return [];
    },
    createElement: function (tag) {
      const el = createFakeElement(tag);
      el.ownerDocument = doc;
      return el;
    },
    createDocumentFragment: function () {
      return createFakeElement('#fragment');
    },
    createTextNode: function (t) {
      return { nodeType: 3, nodeName: '#text', textContent: String(t == null ? '' : t) };
    },
    addEventListener: function () {},
    removeEventListener: function () {},
    dispatchEvent: function () {
      return true;
    },
    /* --- 只读属性 --- */
    title: 'sandbox',
    referrer: '',
    URL: 'http://sandbox.local/',
    cookie: '',
    readyState: 'complete',
    visibilityState: 'visible',
    hidden: false,
    activeElement: null,
  };
  doc.documentElement = doc.createElement('html');
  doc.head = doc.createElement('head');
  doc.body = doc.createElement('body');
  return doc;
}

/** 假 FileReader（importXLSX 用到；测试不解析真实 xlsx）。 */
function FakeFileReader() {
  this.result = null;
  this.error = null;
  this.readyState = 0;
  this.onload = null;
  this.onerror = null;
  this.onloadend = null;
  this.onprogress = null;
  this.abort = function () {};
  this.readAsArrayBuffer = function () {
    throw new Error('[dom-stub] FileReader.readAsArrayBuffer 未打桩：沙箱不解析真实 xlsx（设计 §6.2）');
  };
  this.readAsText = function () {
    throw new Error('[dom-stub] FileReader.readAsText 未打桩：沙箱不解析真实 xlsx（设计 §6.2）');
  };
  this.readAsDataURL = function () {
    throw new Error('[dom-stub] FileReader.readAsDataURL 未打桩');
  };
}

/**
 * 创建 fetch 桩。
 * @param {Object|Function} routes
 *   - 函数：(fullPath, opts) => responseLike，完全自定义
 *   - 对象/map：{ '/api/tx': {status:200, body:{...}} | (path,opts)=>responseLike, ... }
 * @param {Object} [opts]
 *   - defaultResponse：未命中路由时的响应（默认 404 {error:'no route'}）
 * 记录：stub.calls = [{path, opts, body}]（body 为 opts.body 的 JSON.parse 结果，失败则原样）
 */
function createFetchStub(routes, opts) {
  const options = opts || {};
  const calls = [];
  const table = routes && typeof routes === 'object' ? routes : null;

  function toResponse(spec) {
    if (typeof spec === 'function') return spec();
    const s = spec || {};
    const status = typeof s.status === 'number' ? s.status : 200;
    const body = s.body === undefined ? {} : s.body;
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
      status: status,
      ok: status >= 200 && status < 300,
      statusText: String(status),
      headers: { get: function () { return null; } },
      text: async function () {
        return text;
      },
      json: async function () {
        return typeof body === 'string' ? JSON.parse(body) : JSON.parse(JSON.stringify(body));
      },
      _body: body,
    };
  }

  const stub = async function (path, reqOpts) {
    const entry = { path: path, opts: reqOpts || {}, body: undefined };
    if (reqOpts && typeof reqOpts.body === 'string') {
      try {
        entry.body = JSON.parse(reqOpts.body);
      } catch (e) {
        entry.body = reqOpts.body;
      }
    }
    calls.push(entry);

    if (typeof routes === 'function') return toResponse(routes(path, reqOpts));

    const spec = table && Object.prototype.hasOwnProperty.call(table, path) ? table[path] : undefined;
    if (spec === undefined) {
      return toResponse(options.defaultResponse || { status: 404, body: { error: 'no route: ' + path } });
    }
    return toResponse(spec);
  };
  stub.calls = calls;
  stub.callsTo = function (p) {
    return calls.filter(function (c) {
      return c.path === p;
    });
  };
  stub.reset = function () {
    calls.length = 0;
  };
  return stub;
}

/**
 * 创建一套最小浏览器全局桩。
 * @returns {{globals:Object, document:Object, window:Object, alerts:string[],
 *            confirms:string[], prompts:string[], storage:{local:Object, session:Object},
 *            setConfirmResult:Function, setPromptResult:Function, clearMessages:Function}}
 */
function createBrowserGlobals(opts) {
  const options = opts || {};
  const alerts = [];
  const confirms = [];
  const prompts = [];
  let confirmResult = options.confirmResult === undefined ? true : options.confirmResult;
  let promptResult = options.promptResult === undefined ? '' : options.promptResult;

  const document = createDocument();
  const localStorage = createStorage(options.localStorage);
  const sessionStorage = createStorage(options.sessionStorage);

  const location = {
    href: 'http://sandbox.local/',
    protocol: 'http:',
    host: 'sandbox.local',
    hostname: 'sandbox.local',
    port: '',
    pathname: '/',
    search: '',
    hash: '',
    origin: 'http://sandbox.local',
    reload: function () {},
    assign: function () {},
    replace: function () {},
    toString: function () {
      return 'http://sandbox.local/';
    },
  };

  const navigator = {
    userAgent: 'node-vm-sandbox (prod-scheduler tests)',
    platform: 'node',
    language: 'zh-CN',
    languages: ['zh-CN'],
    onLine: true,
    clipboard: null,
    sendBeacon: function () {
      return false;
    },
  };

  function getComputedStyle() {
    return {
      font: '',
      fontFamily: '',
      fontSize: '14px',
      fontWeight: '400',
      fontStyle: 'normal',
      letterSpacing: 'normal',
      textTransform: 'none',
      paddingLeft: '0px',
      paddingRight: '0px',
      display: 'block',
      visibility: 'visible',
      getPropertyValue: function () {
        return '';
      },
    };
  }

  /* 默认 fetch：未打桩即报错（避免测试误以为发过真实请求） */
  const defaultFetch = async function (path) {
    throw new Error('[dom-stub] fetch 未打桩：请在测试中调用 app.setFetch(createFetchStub({...}))。请求路径=' + path);
  };

  const window = {
    document: document,
    localStorage: localStorage,
    sessionStorage: sessionStorage,
    location: location,
    navigator: navigator,
    innerWidth: 1440,
    innerHeight: 900,
    outerWidth: 1440,
    outerHeight: 900,
    devicePixelRatio: 1,
    scrollX: 0,
    scrollY: 0,
    pageXOffset: 0,
    pageYOffset: 0,
    name: '',
    closed: false,
    addEventListener: function () {},
    removeEventListener: function () {},
    dispatchEvent: function () {
      return true;
    },
    getComputedStyle: getComputedStyle,
    matchMedia: function () {
      return {
        matches: false,
        media: '',
        addListener: function () {},
        removeListener: function () {},
        addEventListener: function () {},
        removeEventListener: function () {},
      };
    },
    requestAnimationFrame: function () {
      return 0;
    },
    cancelAnimationFrame: function () {},
    setTimeout: null /* 由 sandbox 用宿主定时器覆盖 */,
    alert: function (m) {
      alerts.push(String(m == null ? '' : m));
    },
    confirm: function (m) {
      confirms.push(String(m == null ? '' : m));
      return confirmResult;
    },
    prompt: function (m) {
      prompts.push(String(m == null ? '' : m));
      return promptResult;
    },
    scrollTo: function () {},
    open: function () {
      return null;
    },
    close: function () {},
    focus: function () {},
    print: function () {},
  };

  const globals = {
    window: window,
    self: window,
    /* 注意：不把 globalThis 别名给 window —— 见 sandbox.js 顶部注释（避免与 vm 全局互相污染） */
    document: document,
    localStorage: localStorage,
    sessionStorage: sessionStorage,
    location: location,
    navigator: navigator,
    alert: window.alert,
    confirm: window.confirm,
    prompt: window.prompt,
    getComputedStyle: getComputedStyle,
    matchMedia: window.matchMedia,
    requestAnimationFrame: window.requestAnimationFrame,
    cancelAnimationFrame: window.cancelAnimationFrame,
    FileReader: FakeFileReader,
    fetch: defaultFetch,
    /* 生成「未实现」错误提示的统一入口 */
  };

  return {
    globals: globals,
    document: document,
    window: window,
    alerts: alerts,
    confirms: confirms,
    prompts: prompts,
    storage: { local: localStorage, session: sessionStorage },
    defaultFetch: defaultFetch,
    setConfirmResult: function (v) {
      confirmResult = v;
    },
    setPromptResult: function (v) {
      promptResult = v;
    },
    clearMessages: function () {
      alerts.length = 0;
      confirms.length = 0;
      prompts.length = 0;
    },
  };
}

module.exports = {
  createStorage: createStorage,
  createFakeElement: createFakeElement,
  createDocument: createDocument,
  createBrowserGlobals: createBrowserGlobals,
  createFetchStub: createFetchStub,
  FakeFileReader: FakeFileReader,
};
