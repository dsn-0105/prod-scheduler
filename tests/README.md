# tests/ —— 零依赖测试地基（辰微生产排产系统）

> 依据：`docs/P1地基轮设计-2026-09-11.md` §6（测试地基设计）
> 铁律：**零依赖** —— 本目录不引入任何 npm 包、不建 `package.json`。只用 Node 内置
> `node:test` / `node:assert` / `node:vm` / `node:fs` / `node:path` / `node:child_process`。

## 1. 怎么跑

```bash
# 全部测试（Node ≥ 20 自动发现 tests/**/*.test.js）
node --test

# 单个文件
node --test tests/write-points.test.js

# 只跑 server / harness 两组
node --test tests/server.tx.test.js tests/server.canwrite.test.js

# 真机 HTTP 端到端验收（**不是** node:test 用例，需手动执行；起真实 server 子进程 + 真实落盘）
node tests/e2e-http.verify.js     # 退出码 0=全绿 / 1=有断言失败 / 2=脚本异常

# 逐文件 + 逐内联块语法校验（只查语法，不查引用；引用靠 node --test 沙箱装载兜）
node tests/check-syntax.js        # 退出码 0=全绿 / 1=有语法错误
```

> ⚠️ `node --test tests/`（带尾斜杠的**目录**参数）在 Node v24.14.0 下会被当成模块去
> `require`，报 `MODULE_NOT_FOUND`。请用 `node --test`（自动发现）或显式列出 `*.test.js`。

### ⚠️ 执行环境限定：必须用「文件」运行，不要用 `node -e`

**不要**用 `node -e "..."` / `node --eval` 驱动本 harness。本机 Node v24.14.0 实测：
当宿主 realm 是 eval 脚本时，`vm` 上下文内的**字符串值**会被破坏，例如

```js
// node -e 里：
vm.runInContext('JSON.stringify({k:"abc"})', ctx)   // => '{"k":{}}'   ← 错
vm.runInContext('({key:"orders"})', ctx).key        // => /orders/    ← 错（RegExp)
// 换成文件就正常：
//   '{"k":"abc"}'  /  'orders'
```

它会让写集断言全部失真（ops 的 key 变成 RegExp 包装对象）。**这是该执行环境的怪异行为，
不是生产代码缺陷**；`node --test` 与 `node tests/xxx.test.js` 下一切正常（已实测）。

## 2. 目录与职责

```
tests/
├── README.md                  本文件：跑法 + 桩的能力边界 + 故意不测的清单
├── harness/
│   ├── sandbox.js             vm 沙箱装载器（核心）：装 js/*.js + index.html 主内联脚本（剥离 bootstrap）
│   ├── dom-stub.js            最小浏览器全局桩（document/window/storage/alert/fetch 桩/fake 节点）
│   └── recorder.js            写集记录器（save / DB.set / DB.tx 的调用记录 + 可控成功/失败）
├── harness.smoke.test.js      地基冒烟（沙箱可装载 / 桩契约 / 记录器）
├── db.tx.test.js              前端事务客户端 DB.tx / saveMulti / DB.set 零回归
├── write-points.test.js       三个写入点的「恰好一次 /api/tx」不变式（T03）
├── transfer.helpers.test.js   调拨纯函数：trRevType 冲销反向 / trSide 方向读取 / trSnapOf 台账快照
├── transfer.return-cap.test.js 「退回库存」上限口径（.129 = saleMaxCallable）：四类场景 / 单一来源委托 / 退回后不变量
├── projection.sync.test.js    投影与回写：订单状态机 / 库存同步 / 入库回写（纯重算 vs 兼容包装）
├── import.idempotent.test.js  金蝶导入：幂等（重复导入不增生）/ 决策分支 / 导入口径（.130：已交付不落库、不写 directDelivered）
├── parts.158.test.js          零部件数据 / 零部件台账（结余单源 / 编码唯一 / 入库整批 + 重入锁 / 批次归属 / 顺序键 / 静态守卫）
├── qa.parts-ledger.independent.test.js  零部件独立验证（QA 侧 51 条：口径 / 真实 DB.tx 双击 / 变异注入基础设施 / 八锚点）
├── server.tx.test.js          /api/tx 原子性、回滚、权限（服务端）
├── server.canwrite.test.js    canWrite 权限规则 / D1 修复回归（服务端）
├── e2e-http.verify.js         真机 HTTP 端到端验收脚本（T03 判据⑥，手动执行）
├── check-syntax.js            逐文件 + index.html 逐内联块 node --check（收尾兜底，手动执行）
└── .e2e-tmp/                  ↑ 该脚本的运行时隔离目录（自动生成，可随时删）
    ├── data.json / users.json   服务端子进程的隔离数据/用户文件（PROD_DATA_FILE / PROD_USERS_FILE）
    ├── verify-http.log          逐请求原始日志（HTTP→ / HTTP← 全文）
    └── verify-result.json       断言明细 + 各动作 /api/tx 次数
```

> **当前规模**：`node --test tests/*.test.js` → **829 tests / 827 pass / 0 fail / 2 skipped（既有 skip）**（`2026-10-31.158` 实测；`.157` 时为 739/737）。
> ⚠ 本条数字**只在收尾时手写更新**（变化频繁，不做断言），跑回归请用**显式文件列表**，勿用 `node --test tests/` 目录形式（会扫入 `_diag/before*` 造成假失败）。
>
> **三个「黄金样例」文件的存在理由**（不是凑覆盖率）：
> - `transfer.helpers.test.js` —— `trRevType`/`trSide` 是调拨方向模型（.115）的**唯一口径来源**；
>   反向映射或方向推导改错，冲销会把数量滚到**错误的订单**上，UI 上极难肉眼发现。
> - `projection.sync.test.js` —— T03 把状态机/库存投影/入库回写拆成「纯重算 + 兼容包装」后，
>   **纯函数一旦偷偷写盘**就突破了 tx 原子性，**包装一旦不再落盘**就会让未迁移的旧调用点
>   （`saveProdPlan`/`delProdPlan`）静默丢数据。两侧都必须钉死，故 pure 断言零写盘、wrapper 断言照旧落盘。
> - `import.idempotent.test.js` —— 金蝶导入是**唯一批量写入入口**，线上最典型误操作就是
>   「同一份文件点两次确认」；改造前 products/orders 分两次写，中途失败会留孤儿产品。

> **`e2e-http.verify.js` 与单元测试的分工**：`write-points.test.js` 用 fetch 桩证明
> 「一次业务动作 = 一次 `DB.tx`」；`e2e-http.verify.js` 把沙箱里的全局 `fetch` **桥接到真实
> HTTP**，跑到真实 `server/server.js` 并核对真实落盘的 `data.json`，因此它证明的是
> 「真实网络 + 真实服务端下，一次请求确实提交了多张表」。它**跑的是生产前端函数本身**
> （`applyTransfers` / `kdDoImport` / `applyReport` / `ppSaveReportEdits`），不是手写 payload。
> 它不碰 `server/data.json`、`server/users.json`，全部临时文件都关在 `.e2e-tmp/` 内。
（`transfer.helpers.test.js` / `projection.sync.test.js` / `import.idempotent.test.js` 为后续轮次的黄金样例文件，尚未建立。）

## 3. 沙箱怎么用（30 秒上手）

```js
const { createApp } = require('./harness/sandbox');
const app = createApp();                 // 已装载 js/*.js + index.html 主内联脚本；recorder 默认已挂

app.setGlobal('orders', [ /* 夹具 */ ]);  // ✅ 改 let/const 全局（内部求值赋值）
app.getGlobal('orders');                 // ✅ 读 let/const 全局
await app.run('applyTransfers("call", ' + JSON.stringify(moves) + ')');  // ✅ 调用生产函数（含 await）
app.recorder.txCount();                  // 事务次数（核心判据：一次业务动作 = 1）
app.recorder.lastTx().keys;              // 这次事务写了哪些表、什么顺序
```

### 3.1 两个作用域 —— 本 harness 最大的坑

| 生产声明 | 存放位置 | 正确读写方式 |
|---|---|---|
| `function f(){}`、`var x` | vm **全局对象属性** | `app.sandbox.x` 也可；`app.setGlobal` 亦可 |
| `let x`、`const x`（`orders` / `products` / `transfers` / `currentUser` / `DB` / `API_BASE` …） | vm **全局词法环境** | **只能用** `app.setGlobal('x', v)` / `app.getGlobal('x')` |

❌ `app.sandbox.orders = [...]` 会创建一个被词法绑定**遮蔽**的新属性 → **静默无效**（不报错、断言却永远不过）。
✅ 读同理：`app.sandbox.orders` 得到 `undefined`，必须 `app.getGlobal('orders')`。

对 `const` 用 `setGlobal` 会明确抛 `TypeError: Assignment to constant variable`（这是预期行为，不是 harness 坏了）。

### 3.2 常用 API

| API | 用途 |
|---|---|
| `createApp(opts)` | 建沙箱。`opts.transformMain(code)` 改主内联脚本源码（如把 `API_BASE` 改成 `''` 测本地模式）；`opts.installRecorder:false` 保留**生产** `DB.set/DB.tx` |
| `app.run(code)` | 在上下文里求值（返回值/ Promise 直接可用） |
| `app.getGlobal/setGlobal/setGlobals/hasGlobal` | 读写全局（含词法绑定） |
| `app.setFetch(fn)` | 替换全局 `fetch`（配 `dom-stub.createFetchStub({...})` 做 HTTP 层断言） |
| `app.installRecorder()` / `restoreOriginals()` | 挂载 / 还原 recorder（还原后走生产 `DB.set/DB.tx`） |
| `app.alerts` / `app.confirms` | 被记录的 `alert`/`confirm` 文案（断言「有没有打扰用户」） |
| `app.inlineScripts` / `mainScript` | index.html 的内联块与主块定位（收尾做「逐块 node --check」也用它） |
| `app.dispose()` | 清宿主定时器（`startSync` 之类被触发时用） |

### 3.3 recorder 断言一览

`calls` / `of(op)` / `txCount()` / `writeCount()` / `writeOrder()` / `countOf(key)` / `lastTx()` /
`setResult(op, v)` / `failNext(op, e)` / `failAlways(op, e)` / `reset()` / `store` / `lastError()`

## 4. 收尾动作：`node --check`（本项目固定动作）

`node --check` **只校验语法、不校验引用**（历史上有过「工具报成功但语法其实坏了」的教训）。
骨架校验（js/*.js 直接校验；index.html 的 **3 块内联 script 逐块提取**后分别校验）：

```js
const { extractInlineScripts, ROOT } = require('./tests/harness/sandbox');
const blocks = extractInlineScripts(require('node:fs').readFileSync(ROOT + '/index.html', 'utf8')); // 3 块
// 每块写临时文件后：node --check <tmp>
```
（主块 = 含 `bootstrap();` 自动执行点的那块；`findMainScript(blocks)` 可定位它。）

## 5. 桩的能力边界（明确声明，不硬凑）

- 桩是**内存**、**无 DOM 布局**、**无渲染**、**无事件派发**、**无真实网络**（`fetch` 默认未打桩即抛错）。
  它只验证**逻辑与写集**，不验证样式/布局/事件绑定。
- `document.getElementById` **一律返回 `null`**、`querySelectorAll` **一律返回 `[]`** —— 这是设计 §6.2 的
  刻意选择，也是「不可测边界」的来源。**任何以读取 DOM 输入为前提的函数在桩下不可测**。
- `createElement` 返回「假节点」：属性可读写、常用方法可调用且不抛错，但 `offsetWidth` 恒 0、
  无布局、无真实事件。**不要用它断言渲染结果**。
- `renderContent()` 在桩下会抛错（内部 `document.getElementById('content')` 为 `null` 后解引用），
  测业务逻辑时请先 `app.setGlobal('renderContent', function(){})` 打桩。
- `FileReader` 未打桩（调用即抛错）：**测试不解析真实 xlsx**；`kdDoImport` 请预置 `kdReport`/`kdState`。
- 沙箱**不装载** index.html 的第 1 块（beacon IIFE）与第 3 块（单元格悬浮提示）内联脚本。
- **装载成功 ≠ 逻辑正确**：只证明「脚本可在隔离上下文求值」。

## 6. 故意不测的清单（照搬设计 §6.4，防后来者误以为覆盖全了）

| 函数/模块 | 为何不可测 | 处理 |
|---|---|---|
| `renderContent/renderAll/renderTransfers/renderProdPlan/renderUsers/renderLogs` | 返回 HTML 字符串、依赖 DOM/CSS/事件 | **不测**；靠人工冒烟 |
| `productPickerModal` / `showModal` / `closeModal` | 纯 DOM 弹窗 | **不测** |
| `csSetInv/csWarn/csAutoFill/ivSet/ivWarn` | 读写 `.cs-inv-box`/`.iv-qty` 等 DOM 节点 | **不测** |
| `ppSaveReportEdits` 的「读取输入值」段（读 `rp_q_*`/`rp_w_*`） | 依赖真实表单输入 | **该段不测**；其纯计算（agg/超量校验）建议抽为 `computeReportEditAgg()` 后**可测** |
| `kdShowReport`（预检报告弹窗） | 生成大段 HTML + `showModal` | **不测** |
| `bootstrap/initApp` 迁移链 | 依赖 DOM + 大量迁移函数 | **不测**（`INV-031 顺序`可用源码静态断言守护） |
| 调拨/报工/导入的**按钮点击链路**（`doCallStock` 等读 `.cs-qty`/`.rp_qty` DOM 输入） | 依赖真实表单输入 | **不测**；其落库逻辑由 `write-points.test.js` 直调 `applyTransfers`/`applyReport`/`kdDoImport` 覆盖 |

## 7. 已知残留（测试能证明、但本轮不改）

1. **tx 失败后内存仍有乐观变更残留**：`DB.tx` 失败时 `pullAll()` 只刷新 `serverData`/`serverRevs` 缓存，
   **不**回灌业务内存全局（`orders` 等仅在 `initApp` 里由 `DB.get` 水合）。因此失败后内存里仍是
   乐观变更值，须靠提示用户 **F5 刷新**复原（沿用 `.123` 既有口径）。`write-points.test.js` 明确断言了这个残留
   （内存 = 乐观值；`serverData` = 服务器真值），以免被误读成「已自动回滚」。
2. **`transfers[i].reversed` 未随冲销当次落盘**（既有行为，非本轮引入）：`reverseTransfer` 在
   `applyTransfers` 返回后才把原记录标 `reversed=true`，而事务已提交 → 该标记要等**下一次**台账写入才持久化。
3. **`saveProdPlan` / `delProdPlan` 仍是「orders + productionPlans」两次独立写**（用户拍板本轮 D2 不迁），
   `writebackInbound` 旧名因此保留为兼容包装（非事务）。
