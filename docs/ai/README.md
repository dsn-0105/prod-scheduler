# AI 架构记忆手册（prod-scheduler / 辰微生产排产系统）

> **这是什么**：一份给 AI agent 与人类开发者共同使用的"架构地图"。它不是业务说明书，而是**结构化索引**——用于在改动代码之前，用最小 token 代价反查出"这次改动会牵连谁"。
>
> **为什么需要它**：本系统是单文件 Vanilla JS SPA（`index.html` 6125 行）+ 零依赖 Node 后端 + JSON 文件持久化。数据表之间的关联**不体现在文件结构里**，而是隐藏在全局数组、函数调用、隐含字段、多表保存顺序和 UI 同步逻辑中。历史上多次出现"改了 A 表数据，B 表关联数据没自动更新"的事故。本手册把那些隐式关联**显式化**。
>
> **生成日期**：2026-09-09　|　**对应 build**：2026-09-09.122　|　**维护人**：开发负责人（见「维护规则」）

---

## 一、给 AI agent 的读取协议

### 1.1 读取顺序（不要一次读完）

> **⚠️ 先纠正一个关键认知：这 5 份 YAML 是「索引」，不是「待通读的文档」。**
> 它们的体积是刻意做大的（合集约 160 KB / 约 60k token）——因为**一次加载后信息全，就不用反复 grep 源码**。
> 若把整份文件喂给模型，当然会爆预算；**正确用法是「按段取用」**：只读 `reverse_index` + 命中边，
> 需要细节时再按边上的 `file:行号` **直达源码**。下面给出**分层预算**（实测口径）。

#### 分层读取预算（按需要的精度递进，不是整文件读）

| 阶段 | 读什么 | 大致 token | 适用 |
|---|---|---|---|
| **① 反查（最常用）** | 只读 `dependency-map.yaml` 的 `reverse_index` 段 + 命中的边 | **≈ 1.5–3k** | 已知 changed id，只想拿到「牵连谁」 |
| **② 单领域深入** | ① + `domain-map.yaml` 相关实体/投影 + `flows.yaml` 相关命令的 `write_set` | **≈ 8–12k** | 要动某条保存流程 / 补一条边 |
| **③ 跨领域** | ② + `invariants.yaml` 相关条目 + `change-log.yaml` 相关迁移 | **≈ 15–20k** | 改口径 / 设计迁移 / 排查事故 |

> 参考：整文件读取的实测值远高于上表（单领域 58,953 token / 跨领域 84,789 token / 其他 70,878 token）——
> 这正是「不该整读」的证明，而不是「手册超预算」。**请按阶段取用，不要整文件读。**

#### 只读某一段的实操手法（省 token）

```bash
# 1) 只用 grep 把 reverse_index 段拉出来（约 35 行），不加载整个 YAML
grep -n -A40 '^reverse_index:' docs/ai/dependency-map.yaml

# 2) 拿到 changed id 对应的边 id 后，只拉这些边的定义
grep -n -A12 'id: E-042' docs/ai/dependency-map.yaml

# 3) 按边上的 file:行号 直达源码（不 grep 全仓库）
sed -n '2844,2847p' index.html
```

| 场景 | 起始文件 | 取哪一段 |
|---|---|---|
| **改前端 / UI / 表单字段** | `domain-map.yaml` + `dependency-map.yaml` | 相关实体段 + `reverse_index` 命中边 |
| **改数据结构 / 跨表逻辑** | 上述 + `invariants.yaml` + `flows.yaml` | 相关不变量 + 相关命令的 `write_set` |
| **排查数据不一致事故** | `invariants.yaml` + `flows.yaml` + `change-log.yaml` | 相关不变量 + 相关 `failure_behavior` |

**读取铁律**：
- **不要一次性读完全部 5 份 YAML + 本 README**（≈60k token）。先用 `dependency-map.yaml` 的 `reverse_index` 按 changed id 精确反查，**只展开命中的边和节点**（≈1.5–3k）。
- 定位代码时用 `file:行号` 锚点直接跳读，**不要 grep 全仓库**。
- 需要「系统里有什么」时才读 `domain-map.yaml` 的相关段；需要「按什么顺序写了哪些表」时才读 `flows.yaml` 的**那一条**命令。

**反查两条铁律（易漏，务必照做）**：
1. **「跨表命令」与「单表命令」都要查**。反查 `entities.orders.items.deliveredQty` 一类字段时，不要只看 `saveOrder` / `applyTransfers` / `writebackInbound` 这种跨表命令——**只写 orders 单表**的命令（`order.deliver` 销售交付、`order.return` 销售退货、`backfillInvDeliveredFromStock` 库存打通迁移、`system.*`）同样是写入方，且都会触发订单状态投影重算。历史教训：手册首版即漏登了这 3 条链路。
2. **投影重算函数要逐个交代调用点**。把 `syncStockFromInvOrders()` 与 `syncOrderAutoStatus()` 的**全部**调用点列出来，逐一归属到具体 flow/edge（清单见 `dependency-map.yaml` 的 `unverified.DUV-004`），不允许有未归属的调用点。

### 1.2 文件职责索引（一句话）

| 文件 | 一句话职责 | 何时读 |
|---|---|---|
| `README.md` | 入口：读取协议、变更闸门、维护规则 | 每次改动前 |
| `domain-map.yaml` | 领域 / 实体 / 投影 / 命令清单——回答"系统里有什么" | 改动前 |
| `dependency-map.yaml` | **依赖索引（最重要）**——回答"改 A 会牵连谁" | 改动前，按 changed id 反查 |
| `invariants.yaml` | 业务不变量——回答"哪些规则不能破" | 改动前 + 自测时 |
| `flows.yaml` | 关键命令流程——回答"一次操作按什么顺序写了哪些表" | 改动保存流程 / 排查不一致时 |
| `change-log.yaml` | 结构性变更记录——回答"以前改过什么、怎么迁移的" | 排查回归 / 设计新迁移时 |

> 附：`_tools/validate.py` —— 手册自校验工具（非业务代码，不参与部署）。跑法：`python docs/ai/_tools/validate.py`。

### 1.3 与 `docs/系统知识.md` 的分工（双维护）

| 文件 | 面向 | 内容形态 | 更新时机 |
|---|---|---|---|
| `docs/系统知识.md` | **人**（业务方 / 运维 / 新同事） | 业务口径、操作说明、部署运维、FAQ | 业务口径变化时 |
| `docs/ai/*` | **AI agent**（也供人快速反查） | 机器可读的 YAML 索引、`file:行号` 证据 | 代码结构/依赖/不变量变化时 |

**两者必须双维护**：只改一份会导致 AI 与人形成认知分歧。若两者冲突，**以代码为准**，并同时修正两份文档。

---

## 二、变更闸门（Change Gate）—— 强制流程

> ⚠️ **AI 在动手改代码之前，必须先输出一份 Impact Report，经用户确认后才能开始改。**

### Impact Report 格式（逐条填，填不出的写 `未核实`，禁止臆测）

```
changed:                <模块/实体/字段 id，例如 entities.orders.items.deliveredQty>
direct consumers:       <直接读取方，含 file:行号>
transitive consumers:   <间接影响方>
写集:                   <会被修改的持久化键，按实际写入顺序列出>
投影:                   <需要重算的派生数据>
同步性:                 <同步/异步；是否同事务；失败是否回滚>
不变量:                 <可能被破坏的业务规则，引用 invariants.yaml 的 id>
迁移/回滚:              <存量数据怎么办；如何回滚>
测试清单:               <要跑哪些验证>
```

### 硬性要求

1. `changed` 必须能在 `dependency-map.yaml` 的 `reverse_index` 里查到；查不到说明手册有缺口，**先补手册或明确声明按无依赖处理**。
2. `写集` 必须与 `flows.yaml` 中对应命令的 `write_set` 一致；不一致说明命令流程有变，**先更新 flows.yaml**。
3. `不变量` 至少要对照 `invariants.yaml`，并明确本次改动是否使某条从 `enforced` 退化为 `partial`/`gap`。
4. `迁移/回滚` 不允许留空——本系统**没有数据库事务**（见 `invariants.yaml` 的 `INV-020`），存量数据迁移必须显式设计。

---

## 三、系统速览（一句话架构）

```
浏览器（单页）
  index.html  6125 行 —— 路由/tab/表格引擎/表单引擎/业务命令（saveOrder/saveDelivery/saveProdPlan/applyReport…）
    ├─ <script src="js/logs.js">          logOp 操作日志（全系统 73 处调用）
    ├─ <script src="js/prodplan-core.js"> 排产单纯计算（步骤/计划/完成量）
    ├─ <script src="js/transfer.js">      applyTransfers 调拨执行器（唯一）+ 台账渲染
    ├─ <script src="js/import.js">        金蝶 xlsx 导入 kdDoImport
    └─ <script src="js/guide.js">         使用说明页
        │  fetch('/api/*?token=...')
        ▼
  server/server.js  241 行 —— 零依赖 Node HTTP
    ├─ 认证：token 内存 Map（重启失效）+ 默认凭据 admin123/123456
    ├─ /api/save：整键替换（data[key]=value），无 CAS / 无事务 / 无 rev 校验
    ├─ /api/revs：前端每 5 秒轮询 → 整量 pullAll() + 整量 renderContent()
    └─ 持久化：server/data.json（同步整文件覆写，rename 原子）
```

**当前实现的三个结构性特征（不是缺陷，是前提）**：
1. **整键替换**：`/api/save` 每次提交整张表的完整数组 → 前端"保存 A 表"本质是"用本地内存数组覆盖服务器该表"。
2. **轮询同步**：5 秒一轮，无 WebSocket / SSE → 多端并发写**后写覆盖先写**（lost update）。
3. **派生数据不落库**：库存、订单状态、已计划未交付、看板 KPI 均由投影函数实时重算（见 `domain-map.yaml#projections`）。

---

## 四、目录与关键锚点速查

| 路径 | 行数 | 说明 |
|---|---|---|
| `index.html` | 6125 | 单文件 SPA（含 HTML + CSS + 业务 JS） |
| `js/logs.js` | 58 | 操作日志 |
| `js/prodplan-core.js` | 147 | 排产单纯计算 |
| `js/transfer.js` | 600 | 调拨执行器 + 台账 |
| `js/import.js` | 542 | 金蝶导入 |
| `js/guide.js` | 108 | 使用说明 |
| `server/server.js` | 241 | 零依赖后端 |

高频锚点（改代码前先跳这里）：

| 锚点 | 位置 |
|---|---|
| `API_BASE` / `KEY` 常量 | `index.html:358-359` |
| `DB.get` / `DB.set` | `index.html:378-407` |
| `pollRevs()`（5 秒轮询）/ `startSync()` | `index.html:409-425` |
| `save(k,v)` / `load(k,def)` | `index.html:524-538` |
| `formToKey()` / `canWriteKey()` / `canAct()` / `needAct()` | `index.html:476-516` |
| `FORM_ACTS` 按钮级动作键 | `index.html:496-502` |
| `syncOrderAutoStatus()` | `index.html:2266` |
| `buildPlannedUndelMap()` | `index.html:2493` |
| `saleMaxCallable()`（销售交付行级上限） | `index.html:2748` |
| `saleDeliverDlg()` / `saleDeliverSave()`（销售交付） | `index.html:2751 / 2821` |
| `saleReturnDlg()` / `saleReturnSave()`（销售退货） | `index.html:2852 / 2874` |
| `saveOrder(idx)` | `index.html:3270` |
| `delOrder(idx)` | `index.html:3423` |
| `backfillInvDeliveredFromStock()`（库存打通迁移） | `index.html:3456` |
| `syncStockFromInvOrders()` | `index.html:3494` |
| `writebackInbound()` | `index.html:4569` |
| `applyReport()` | `index.html:4586` |
| `ppDelReport()`（删除单条报工） | `index.html:3856` |
| `saveProdPlan(idx)` | `index.html:4185` |
| `delProdPlan(i)` | `index.html:4293` |
| `saveDelivery(idx)` / `doSaveDelivery()` | `index.html:4766 / 4805` |
| `bootstrap()` / `initApp()` 迁移链 | `index.html:5953 / 5964` |
| `restoreBackup(e)`（恢复）/ `confirmClear()`（清空） | `index.html:5894 / 5940` |
| `applyTransfers()` | `js/transfer.js:308` |
| `kdDoImport()` | `js/import.js:456` |
| `logOp()` | `js/logs.js:2` |
| `DEFAULT_DATA` / `BIZ_KEYS` / `SYSTEM_KEYS` | `server/server.js:16-26` |

> 手册自校验工具：`docs/ai/_tools/validate.py`（跑法 `python docs/ai/_tools/validate.py`）——校验 5 份 YAML 可解析 + 跨文件边/索引自洽 + 证据齐备。改完手册请跑一遍。

---

## 五、维护规则

### 5.1 何时必须更新本手册

| 触发条件 | 必须更新的文件 |
|---|---|
| 新增/删除数据表、字段 | `domain-map.yaml` + `dependency-map.yaml` + `invariants.yaml` |
| 新增/修改保存流程、写多表的命令 | `flows.yaml` + `dependency-map.yaml` |
| 新增/修改派生数据（投影）计算口径 | `domain-map.yaml#projections` + `dependency-map.yaml` |
| 新增业务规则 / 状态机分支 | `invariants.yaml` |
| 存量数据迁移脚本 | `change-log.yaml`（`type: data-migration`） |
| 任何使某条不变量从 enforced 变 partial/gap 的改动 | `invariants.yaml`（status 降级）+ `change-log.yaml` |
| 修改了本 README 引用的锚点行号 | 本 README 的「关键锚点速查」表 |

### 5.2 谁来更新

- **AI agent**：完成任何结构性改动后，**必须**在同一个任务内更新对应文件，不得留到下一次。
- **人类开发者**：review 时把"手册是否同步"作为合并前提。
- **禁止**：只改代码不改手册；手册里写"建议/目标"而不标 `status: 目标` 或 `gap: true`。

### 5.3 编写铁律

1. **一切内容必须从真实代码推导**，每条边/不变量都带 `file:行号` 证据。
2. **明确区分"当前实现"与"目标/建议"**：描述现状用陈述句；标注待改为 `status: 现状缺陷` 或 `gap: true`。**绝不把建议写成现状**。
3. **代码与本手册冲突时以代码为准**，并立即修正手册。
4. 所有 YAML 必须能通过 `yaml.safe_load`。
5. 找不到证据的写 `status: 未核实`，**不编**。

---

## 六、当前已知的系统性风险（Top 7）

> 详细定义见 `invariants.yaml`（`status: gap`）与 `flows.yaml`（`known_defects`）。

| # | 风险 | 位置证据 | 级别 |
|---|---|---|---|
| 1 | **多表写入无事务**：`applyReport` 至少 3 次独立 `save`，`applyTransfers` 2 次独立网络写，任一步失败即不一致 | `index.html:4614/4628/4636`、`js/transfer.js:325/348` | 🔴 高 |
| 2 | **`/api/save` 无 CAS / 无 rev 校验**：5 秒轮询窗口内多端并发 = 后写覆盖先写 | `server/server.js:169-170`、`index.html:409` | 🔴 高 |
| 3 | **表注册遗漏即静默丢数据**：新表必须同时登记 `DEFAULT_DATA` + `BIZ_KEYS`/`SYSTEM_KEYS`（transfers 曾漏登记丢 103 条） | `server/server.js:16-26` | 🔴 高 |
| 4 | **订单编辑增删行后行索引漂移**：`orderLine` / `dlLine` / `directDelivered` 按行序补回，可能错位（`directDelivered` 仅存量行涉及，.130 起导入不再写入该字段） | `index.html:2660`（代码注释自陈）、`index.html:3590-3601` | 🟠 中 |
| 5 | **注释与代码矛盾**：`applyReport` 内 `index.html:4615` 注释写"销售/库存订单都回写"，实际 `4580` 行仅回写库存订单 | `index.html:4580` vs `:4615` | 🟡 低（误导性） |
| 6 | **默认凭据 + token 内存存储**：`admin123/123456` 默认账号；token 存内存 Map，重启全部失效 | `server/server.js:61-66`、`:95` | 🟠 中 |
| 7 | **「单表命令」易被反查遗漏**：`order.deliver`/`order.return`/`backfillInvDeliveredFromStock`/`system.*` 只写 `orders` 单表（不改库存），但都会改 `deliveredQty` 并触发状态投影重算——反查时若只盯跨表命令必漏 | `flows.yaml#order.deliver / order.return`、`dependency-map.yaml` 边 `E-042~E-060` | 🟠 中（手册完整性风险） |

---

## 七、快速上手：一个完整示例

**任务**："库存订单明细的 `deliveredQty` 想改成不允许负数。"

1. 打开 `dependency-map.yaml`，在 `reverse_index` 查 `entities.orders.items.deliveredQty` → 命中 `E-001, E-003, E-010, E-019, E-021, E-023, E-032, E-042, E-046, E-052, E-055, E-058, E-059…`
2. 展开这些边：发现 `E-001` 指向 `projections.products.stock`（`syncStockFromInvOrders`，只汇总库存订单行）；`E-003` 指向 `entities.transfers`（`applyTransfers` 允许负数=欠货）；`E-042/E-046` 是**销售交付/退货**（只写 `orders` 单表，**不改库存**）。
3. 打开 `invariants.yaml`：命中 `INV-002`（库存订单可为负）→ 本次改动会**推翻**该不变量，须标 `gap`；同时对照 `INV-029`（销售交付/退货不改库存）确认口径边界。
4. 打开 `flows.yaml#transfer.apply`：确认 `applyTransfers` 的 `write_set` 与 `known_defects`。
5. 打开 `change-log.yaml`：确认 `entities.transfers` 的存量 103 条记录中是否有负 `deliveredQty` 需要迁移。
6. 输出 Impact Report → 用户确认 → 开始改。

总计读取：3 份文件、约 4000 token，**无需扫全仓库**。
