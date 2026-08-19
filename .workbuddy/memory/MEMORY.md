# 项目备忘（prod-scheduler 生产排单系统）

## 协作约定
- **推送由用户手动执行**（2026-08-19 确认）：助手只负责改代码 + 本地 git commit，不执行 push；每次改动后提示用户待推送的提交与推送命令。
- 仓库：`dsn-0105/prod-scheduler`（Public），Pages：`https://dsn-0105.github.io/prod-scheduler/`
- 推送命令（机器无 git PATH，用 PortableGit 完整路径）：
  ```powershell
  & "C:\Users\WINDOWS\.workbuddy\binaries\PortableGit\versions\1.2.0\cmd\git.exe" -C "C:\Users\WINDOWS\WorkBuddy\2026-08-18-16-59-26" push
  ```
- 版本号机制：`index.html` 中 `build X.Y` 为占位，push 后由 `.github/workflows/deploy.yml` 的 sed 自动注入 `日期.全局run_number`，源码无需手动改版本。

## 系统架构要点
- 单文件 HTML（`index.html`），零依赖 Vanilla JS + localStorage，自建 DB 抽象层（预留 API_BASE）。
- 表格引擎按 `formKey` 隔离状态：筛选/排序/批量选择（`selRows`、`lastRowIds`）各表单独立。
- 订单管理拆为「框架订单」「库存订单」两类可折叠区块，formKey `order_frame`/`order_inv`，`orderType` 字段区分，新增走 `addOrderOfType(type)` + `pendingOrderType` 兜底。
- 无「半成品库存」表单；库存记在产品主数据 `stock` 字段（关键字段），仪表盘缺货预警与库存快照均读产品 `stock`。
- 产品主数据产能字段为单一 `dailyCap`（日产能）。
