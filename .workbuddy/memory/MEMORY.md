# 项目备忘（prod-scheduler 生产排单系统）

## 协作约定
- **推送由用户手动执行**（2026-08-19 确认）：助手只负责改代码 + 本地 git commit，不执行 push；每次改动后提示用户待推送的提交与推送命令。
- **腾讯云服务器部署：SSH 密钥免密，助手直接部署**（2026-08-21 确认）：用户提需求→助手改代码+commit→助手运行 `bash deploy.sh`（本地脚本，scp 免密上传+nginx reload+验证），不再需要密码/GitHub/MCP 通道。服务器：`111.231.167.192`（Ubuntu 24.04，Nginx，站点 `/var/www/html/`，2C2G4M，上海 ap-shanghai-5，实例 lhins-b7zhktnw）。本地密钥 `~/.ssh/id_ed25519`（无口令），公钥已装 `/root/.ssh/authorized_keys`。服务器已开 `PermitRootLogin yes` + `PasswordAuthentication yes`（root 密码登录也可用，但日常走密钥）。deploy.sh / deploy.bat 含服务器信息，**不入 git**（仓库 Public）。
- 仓库：`dsn-0105/prod-scheduler`（Public），Pages：`https://dsn-0105.github.io/prod-scheduler/`
- 推送命令（机器无 git PATH，用 PortableGit 完整路径）：
  ```powershell
  & "C:\Users\WINDOWS\.workbuddy\binaries\PortableGit\versions\1.2.0\cmd\git.exe" -C "C:\Users\WINDOWS\WorkBuddy\2026-08-18-16-59-26" push
  ```
- 版本号机制：`index.html` 中 `build X.Y` 为占位，push 后由 `.github/workflows/deploy.yml` 的 sed 自动注入 `日期.全局run_number`，源码无需手动改版本。**注意**：免密 scp 上传的是本地源码占位版本号（如 `2026-08-19.20`），GitHub Pages 才是注入后的 `日期.run_number`。
- **每次更新后需告知最新 build 版本**（2026-08-19 确认）：助手在每次改动提交后，告知当前源码占位版本；用户 push 后可用 GitHub API 查询最新 run_number 得出线上真实版本（`https://api.github.com/repos/dsn-0105/prod-scheduler/actions/workflows/deploy.yml/runs?per_page=1`，线上 build = `日期.run_number`）。参考：线上当前 build `2026-08-20.20`（run#20，8/20 推送）。

## 系统架构要点
- 单文件 HTML（`index.html`），零依赖 Vanilla JS，自建 DB 异步抽象层。
- **多员工在线模式（2026-08-21 上线）**：`API_BASE='/api'`（服务器模式），数据存服务器，多设备实时共享；本地单机可把 API_BASE 改 '' 回退 localStorage。
  - 后端：`server/server.js`（零依赖 Node，端口 3000），部署于服务器 `/opt/prod-server/`，systemd 服务 `prod-server`；Nginx 反代 `location /api → 127.0.0.1:3000`。
  - 数据文件：`/opt/prod-server/data.json`（JSON 持久化），用户文件 `users.json`（scrypt 哈希）；初始账号 `admin/admin123`（**提醒用户尽快改密码**——改法：编辑服务器 users.json 或后续加改密接口）。
  - 认证：`POST /api/login` 返回 token（内存会话，7 天有效）；接口：`GET /api/data`、`GET /api/revs`、`POST /api/save`。
  - **员工与权限（2026-08-21 上线）**：角色 admin/staff；初始账号 4 个——admin(管理员)/admin123、pmc(PMC)/123456、chejian(车间)/123456、zongjingli(总经理)/123456；员工默认**全部表单只读**（perms 全 false）。
  - **按表单写权限**：业务 key（products/orders/dailyPlans/dailyPkgs/deliveries/fields）受 perms 控制，admin 全放行，系统 key（logs/meta/tblLayout/fieldsAudit/fieldsDraft）登录用户均可写；save 后端强制校验（403）。
  - 员工管理：`GET/POST/PUT/DELETE /api/users`（仅 admin）+ `POST /api/change-pwd`（本人）；前端「员工管理」导航仅 admin 可见，按表单勾选开启写权限；顶栏「改密」所有人可用。
  - 版本：`build 2026-08-21.2`。
  - 实时同步：前端每 5 秒轮询 `/api/revs`，版本号变化则拉全量刷新（`pollRevs`/`pullAll`/`startSync`）。
  - 登录 UI：`showLogin`/`doLogin`/`logout`；顶栏「退出」按钮（服务器模式显示）。
  - 版本：`build 2026-08-21.1`。
- 表格引擎按 `formKey` 隔离状态：筛选/排序/批量选择（`selRows`、`lastRowIds`）各表单独立。
- 订单管理拆为「框架订单」「库存订单」两类可折叠区块，formKey `order_frame`/`order_inv`，`orderType` 字段区分，新增走 `addOrderOfType(type)` + `pendingOrderType` 兜底。
- 无「半成品库存」表单；库存记在产品主数据 `stock` 字段（关键字段），仪表盘缺货预警与库存快照均读产品 `stock`。
- 产品主数据产能字段为单一 `dailyCap`（日产能）。
