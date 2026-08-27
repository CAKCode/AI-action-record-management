# 部署与运维

## 功能范围

| 领域 | 当前行为 |
| --- | --- |
| Task 生命周期 | New 创建独立 Task；Reset 保留 Task 和历史但让下一次运行创建新 Session；Resume/Restore 始终继续 Task 最新 Session；显式 Complete 后进入 30 天保留期 |
| 并发 | 不限制活动 Task 数量，也不按 `workingDir` 串行化；同一目录允许多个 Task 或 pytest 并行，业务输出必须使用每次 Run 唯一的文件名或子目录 |
| Step 与 Run | Step 表示 `normal`、`long` 等稳定业务步骤；Rerun 是同一 Step 下的新 Run；技术 Retry 复用原 Run，只增加 External Attempt generation |
| 后台执行 | 外部命令登记 PID/LOG/DONE/STATE/META 后释放 Codex；Worker 持久调度后续 Turn，并每秒核对终态；操作员停止前会再次核对，避免把已经结束的 pytest 错标为取消 |
| 业务报告 | 每个 Run 使用稳定 `reportKey` 和自己的 `TRACKING_ID`；启动时可登记一份或多份 pytest HTML，运行中报告立即显示登记项，源文件生成后可打开只读快照；终态自动合并并切换到托管入口；Fail 分析 Markdown 使用相同 artifact 机制 |
| 报告可靠性 | 运行中快照使用认证、`private, no-store` 和 sandbox CSP，但依赖业务源文件且不代表归档完成；终态 artifact 归档使用持久任务、租约和退避重试，单份 HTML 无效不会阻止同报告其他文件归档 |
| 审计与恢复 | 保存 Turn、Attempt、命令、原始事件、Skill 版本和人工修正；支持 SQLite 在线备份、平台恢复检查点、受管日志完整性校验和服务重启恢复 |

平台不对旧 Task 猜测 Step/Run 或补录历史 artifact。升级后的运行中 HTML 快照、准确终态和自动托管入口都依赖新执行在启动时按当前协议登记。

## 运行要求

- Linux，提供可读 `/proc`。生产环境推荐 systemd；需要可靠清理后台全部后代时启用 cgroup v2 delegation。
- Node.js `20.17` 至 `26.x`，包含 npm。锁文件是唯一依赖版本来源，部署使用 `npm ci`。
- Python `3.11+`。Bridge runner 使用标准库 `tomllib`、PTY、`fcntl` 和 Linux 进程控制接口。
- 服务账户可执行且已配置可用的 Codex CLI。可用二进制通过 `CODEX_TASK_REAL_CODEX_BIN`、`CODEX_BIN` 或服务 `PATH` 解析。
- connect2cli Bridge 源目录，Python 必须能从该目录导入 `workspace_bridge`；非默认路径通过 `CODEX_TASK_BRIDGE_ROOT` 指定。
- data、backup、runtime 和 task workspace 目录可写，并且源码、data、runtime 互不重叠；任务目录不能位于前三者中。
- `better-sqlite3` 和 `node-pty` 是原生模块。没有匹配预编译包时，`npm ci` 还需要 Python 3、`make` 和 C/C++ 编译器。

`systemd`、cgroup v2、`curl` 和反向代理不是 Node 运行依赖：systemd/cgroup 用于生产监管和完整进程清理，`curl` 用于发布验证，反向代理用于非回环部署的 TLS 和网络控制。

### Node 包职责

| 依赖 | 作用 | 部署注意 |
| --- | --- | --- |
| `better-sqlite3` | SQLite WAL、事务、迁移、在线备份 | 原生模块，必须匹配目标 Node ABI 和操作系统 |
| `node-pty` | 浏览器交互 Codex 终端 | 原生模块，Linux 构建可能需要编译工具链 |
| `ws` | WebSocket 服务 | 承载任务事件和交互终端连接 |
| `@xterm/xterm`、`@xterm/addon-fit` | 浏览器终端渲染 | 前端静态依赖，不要求主机安装系统 xterm |
| `stream-json` | 流式解析 Codex 结构化事件 | 避免把大体积运行事件一次性读入内存 |
| `yaml` | Skill 元数据和配置解析 | 只使用锁文件固定版本 |
| `tar` | 平台恢复检查点打包与校验 | Node 包，不依赖主机 `tar` 命令 |
| `yauzl` | Skill ZIP 安全读取 | 运行依赖 |
| `node-gyp`、`yazl` | 原生模块构建兜底、测试 ZIP 生成 | 开发依赖；`npm ci --omit=dev` 不安装 |

具体版本以 [`package-lock.json`](../package-lock.json) 为准，不手工单独升级某个原生模块或在生产目录执行无锁 `npm install`。

## 首次部署

### 1. 检查运行时

以下检查必须以最终服务账户或等价环境执行：

```bash
node --version
npm --version
python3 --version
codex --version

CODEX_TASK_BRIDGE_ROOT=/opt/connect2cli-bridge \
  python3 -c 'import os, sys; sys.path.insert(0, os.environ["CODEX_TASK_BRIDGE_ROOT"]); import workspace_bridge; print("bridge ok")'
```

Node 必须满足 `>=20.17 <27`，Python 必须为 `3.11+`。`codex --version` 只证明二进制可执行；还要按组织的 Codex 配置方式确认服务账户具备实际创建 Session 所需的配置和网络访问。

### 2. 安装应用依赖

```bash
cd /opt/codex-task-sessions
npm ci
npm run check
npm run audit:production
npm test
```

源码和 `node_modules` 在运行期应对服务账户只读，data、backup、runtime 和 task workspace 才由服务账户写入。直接在生产主机验证时使用完整 `npm ci`；已经在相同 Node/OS/CPU 环境完成检查的发布包可用 `npm ci --omit=dev` 安装纯运行依赖。原生模块不能跨不兼容的 Node ABI 或操作系统直接复制。

### 3. 准备服务目录和配置

systemd 样例默认使用下列目录：

```bash
sudo useradd --system --home-dir /var/lib/codex-task-sessions \
  --shell /usr/sbin/nologin codex-task-sessions
sudo install -d -o codex-task-sessions -g codex-task-sessions -m 0700 \
  /var/lib/codex-task-sessions/data \
  /var/lib/codex-task-sessions/backups \
  /var/lib/codex-task-sessions/runtime \
  /var/lib/codex-task-workspaces
sudo install -o root -g codex-task-sessions -m 0640 /dev/null \
  /etc/codex-task-sessions.env
```

`/etc/codex-task-sessions.env` 至少补充 Codex 和 Bridge 的实际位置；路径只是示例：

```ini
CODEX_TASK_REAL_CODEX_BIN=/usr/local/bin/codex
CODEX_TASK_BRIDGE_ROOT=/opt/connect2cli-bridge
BRIDGE_PYTHON=/usr/bin/python3
SOURCE_CODEX_HOME=/var/lib/codex-task-sessions/source-codex-home
WORKSPACE_CODEX_SKILLS_DIR=/opt/codex-task-sessions/.codex/skills
CODEX_RELEASE_ID=2026.08.14-1
```

账户已存在时跳过 `useradd`，不同发行版按本机账户管理方式调整。`SOURCE_CODEX_HOME` 必须已经存在，包含需要发现的只读 `skills/`，并允许服务账户遍历读取。远程监听时还必须成对配置 `CODEX_DESK_AUTH_USER` 和 `CODEX_DESK_AUTH_PASSWORD`，并在外层启用 TLS。环境文件可能包含认证信息，不能放入仓库或普通部署日志。

### 4. 选择监管方式

无 systemd 的开发或受控主机可使用：

```bash
cd /path/to/connect2cli-web-management
export CODEX_TASK_REAL_CODEX_BIN=/usr/local/bin/codex
export CODEX_TASK_BRIDGE_ROOT=/path/to/connect2cli-bridge
export CODEX_TASK_WORKSPACE_ROOTS=/srv/codex-task-workspaces
sh start-supervised.sh
```

无 systemd 的主机应使用 `start-supervised.sh`。脚本以 `exec` 启动 Node Launcher；Launcher 和 Supervisor 分别用私有锁保证单实例，Launcher 监管 Supervisor，Supervisor 监管 Web，两层都按 1 秒至 30 秒指数退避重启，稳定运行 30 秒后重置退避。Web 每 500ms 校验必需的 Supervisor 身份，Supervisor 被强杀时会停止接收请求、让 Worker 持久化中断状态并退出，Launcher 保留这段诊断输出后重建完整服务树。健康检查也核验 Launcher 的 PID、Linux 启动时钟及其与 Supervisor 的父子关系；Launcher 意外消失时，仍存活的 Web 保留诊断能力，但 readiness 立即降级，避免把无法继续恢复的半监管服务树标记为可执行。重复启动脚本会立即以退出码 `78` 拒绝，不进入重试循环；强杀遗留的 Launcher 锁会按 PID 与启动时钟核验后自动回收，不需要手工删除。`server.js` 同时监管独立 `worker.js`，Worker 异常退出后会自动重启。`start.sh` 只直接启动 `server.js`，适合已经由其他可靠进程管理器监管 Web 的场景。

`start-supervised.sh` 默认把 Launcher、Supervisor、Web 和 Worker 的诊断输出写入 `CODEX_DESK_RUNTIME_DIR/web-supervisor.log`。每次接管会记录 Launcher PID 和它拉起的 Supervisor PID，Supervisor 自动恢复后也会记录新的 PID。当前文件和轮转文件均为 `0600`，运行目录为 `0700`；每个文件默认最多 5 MiB，另保留 3 个历史文件。轮转器先同步并关闭当前描述符，再按 `.1`、`.2`、`.3` 重命名后重开，不使用可能丢行的 `copytruncate`。systemd 样例直接运行 Supervisor，继续由 journald 管理输出，不额外创建这组受管日志。

### 受控滚动重启

更新无 systemd 的 Host Launcher 部署时，从同一部署目录和环境执行：

```bash
npm run restart:supervised
```

执行器先验证私有锁中的 Launcher/Supervisor PID、Linux 启动时钟、进程组、父子关系、工作目录及 data/runtime/backup 路径。新版 Launcher 把允许继承的部署参数写入私有 owner 文件；滚动重启从该白名单和当前执行环境重建替代树，不输出环境值，也不依赖目标进程的 `/proc` 环境。调用命令时必须使用与初次启动一致的自定义 Bridge 等外部依赖环境。持久维护租约在同一 SQLite 事务内确认 Task、Attempt、Command、Schedule、External、报告 artifact 归档和已认领 Bridge cleanup 均为零；随后与在线备份私有锁交叉校验，维护期间新写入返回 `503`，Worker 不再领取工作。旧树完整退出后，新 Launcher 以独立 Session 启动；只有 Launcher、Supervisor、Web、Worker 身份、存储、不变量及固定权限策略在维护态全部通过，才记录完成审计、释放租约并等待 `/api/ready` 恢复 `200`。

停服前发生错误或收到 `SIGINT`/`SIGTERM` 时，执行器记录失败并释放自己的租约，旧树继续服务。停服后尚未验证替代树时失败，不会提前解除保护；输出包含 `maintenanceExpiresAt`，租约最迟在该时间自动失效。不要手工删除运行锁或维护元数据，可在确认旧执行器已经退出后重新运行同一命令。该入口只适用于 `start-supervised.sh` 部署；systemd 部署使用 `systemctl restart codex-task-sessions` 并按服务管理器健康策略验证。

生产环境还需要由系统服务管理器监管 Web Supervisor 本身。仓库提供
[`deploy/codex-task-sessions.service.example`](../deploy/codex-task-sessions.service.example)，其默认约束包括：

- 使用专用 `codex-task-sessions` 非 root 账户。
- Web 退出后由 Supervisor 快速恢复；Supervisor 退出后由 systemd 自动重启。
- 停服时按控制组关闭 Web、Worker 和执行子进程。
- 数据、运行状态和任务工作目录由 systemd 创建并以 `0700` 管理。
- 不设置 `CODEX_ALLOW_ROOT_EXECUTION`。

部署前按实际安装位置调整 `WorkingDirectory` 和 `ExecStart`，并在
`/etc/codex-task-sessions.env` 配置部署环境所需的路径、运行时和认证参数。执行服务和只读 Skill
来源必须允许该服务账户访问。启用命令：

```bash
sudo install -m 0644 deploy/codex-task-sessions.service.example /etc/systemd/system/codex-task-sessions.service
sudo systemctl daemon-reload
sudo systemctl enable --now codex-task-sessions.service
sudo systemctl status codex-task-sessions.service
```

## 发布与升级

1. 在变更源码或依赖前确认没有活动 Task、Attempt、Schedule、External Attempt 或 artifact 归档。不要在 pytest 仍运行时覆盖仓库内的包装器。
2. 创建并复验一份数据库备份；需要完整平台恢复能力时再创建恢复检查点。任务工作目录和外部 pytest 产物不在恢复检查点内，应按业务要求单独备份。
3. 部署新源码并执行 `npm ci`。Node 主版本、操作系统或 CPU 架构变化时必须在目标环境重新安装原生模块。
4. 执行 `npm run check`、`npm run audit:production` 和 `npm test`，更新非敏感 `CODEX_RELEASE_ID`。
5. `start-supervised.sh` 部署执行 `npm run restart:supervised`；systemd 部署执行 `sudo systemctl restart codex-task-sessions.service`。
6. 同时检查 `/api/health` 和 `/api/ready`，确认 `release.releaseId` 是新值、`instanceId` 已变化、Web/Worker/Supervisor 身份通过。
7. 用一个非生产 Task 验证 New、Resume 最新 Session、后台终态刷新，以及至少一份 HTML artifact 的打开入口。

```bash
curl -fsS http://127.0.0.1:8091/api/health
curl -fsS http://127.0.0.1:8091/api/ready
npm run verify:data-protection
```

数据库迁移在新进程首次打开存储时执行。需要回滚到不理解新 schema 的旧版本时，不能只替换源码；停止服务后恢复升级前已复验的数据库或恢复检查点，并同步恢复所需的 data/runtime 和业务产物。先保留故障现场，禁止在运行中的 SQLite 上手工删列或修改迁移状态。

## 配置

| 环境变量 | 默认行为 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | HTTP 监听地址 |
| `PORT` | `8091` | HTTP 端口 |
| `CODEX_DESK_DATA_DIR` | 工作区下 `data` | SQLite 和原始日志 |
| `CODEX_DESK_BACKUP_DIR` | `<CODEX_DESK_DATA_DIR>/backups` | 私有数据库备份包目录 |
| `CODEX_DESK_RUNTIME_DIR` | 工作区外独立目录 | 持久 Session 状态和 Skill 快照 |
| `CODEX_TASK_WORKSPACE_ROOTS` | 独立任务根目录 | Linux 使用 `:` 分隔多个允许根目录 |
| `CODEX_API_MAX_CONCURRENCY` | `64` | 普通 API 响应槽上限，范围 `1..256`；Health/Ready 不占普通槽 |
| `CODEX_API_IDLE_TIMEOUT_MS` | `30000` | 非日志 API 请求体或响应无网络进展超时，范围 `1000..3600000` 毫秒 |
| `CODEX_LOG_STREAM_MAX_CONCURRENCY` | `8` | Attempt 与后台原始日志的并发下载数，范围 `1` 至 `64` |
| `CODEX_LOG_STREAM_IDLE_TIMEOUT_MS` | `60000` | 日志响应源流无传输进展超时，范围 `1000..3600000` 毫秒 |
| `CODEX_MIN_FREE_BYTES` | `536870912` | 数据、运行状态和任务工作盘允许启动新任务的最小可用字节数，设为 `0` 可关闭字节门槛 |
| `CODEX_MIN_FREE_PERCENT` | `2` | 上述文件系统允许启动新任务的最小可用百分比，范围 `0..100`，设为 `0` 可关闭百分比门槛 |
| `CODEX_DB_BACKUP_INTERVAL_HOURS` | `24` | 自动数据库备份间隔，整数小时；`0` 关闭自动调度 |
| `CODEX_DB_BACKUP_RETENTION` | `1` | 成功发布后保留的最新数据库备份数，范围 `1..365` |
| `CODEX_DB_BACKUP_MAX_DURATION_MINUTES` | `120` | 单次 SQLite 在线备份最长时间，范围 `1..1440`；超时或服务关停时取消并清理未发布临时包 |
| `CODEX_RECOVERY_CHECKPOINT_INTERVAL_HOURS` | `24` | 自动平台恢复检查点间隔，整数小时；`0` 关闭自动调度 |
| `CODEX_RECOVERY_CHECKPOINT_RETENTION` | `1` | 成功发布后保留的最新平台恢复检查点数，范围 `1..30` |
| `CODEX_RELEASE_ID` | 空 | 非敏感发布标识，使用 `1..128` 位字母、数字、点、下划线或连字符；滚动重启会保留并验证替代实例报告相同标识 |
| `CODEX_WEB_SUPERVISOR_LOG_MAX_BYTES` | `5242880` | `start-supervised.sh` 受管诊断日志的单文件字节上限，范围 `256..1073741824` |
| `CODEX_WEB_SUPERVISOR_LOG_RETENTION` | `3` | 受管诊断日志的历史文件数，范围 `1..20`，不含当前文件 |
| `CODEX_WEB_SUPERVISOR_LOG_STDIO` | 未启用 | 设为 `1` 时关闭 Launcher 的本地受管日志并恢复标准输出，供外部日志管理器接管 |
| `CODEX_ROLLING_RESTART_TIMEOUT_MS` | `60000` | 滚动重启等待旧树退出、新树启动和恢复 ready 的阶段上限，范围 `10000..300000` 毫秒 |
| `CODEX_ROLLING_RESTART_DRAIN_MS` | `500` | 取得维护租约后等待迟到请求进入事务门禁的排空时间，范围 `0..10000` 毫秒 |
| `CODEX_ALLOW_ROOT_EXECUTION` | 未启用 | 仅供本地开发验证；设为 `1` 才允许 root 进程执行任务，生产环境禁止配置 |
| `CODEX_TASK_REAL_CODEX_BIN` | 从服务 `PATH` 查找 `codex` | 真实 Codex CLI 绝对路径；平台包装器会固定追加最高权限参数 |
| `CODEX_TASK_BRIDGE_ROOT` | `/home/jenkins/connect2cli-bridge` | 包含 `workspace_bridge` Python 包的 Bridge 源目录；非默认部署必须显式配置 |
| `BRIDGE_PYTHON` | `python3` | 运行 Bridge runner 和 execution gate 的 Python `3.11+` 解释器 |
| `BRIDGE_RUNNER` | 仓库 `bin/bridge-stream-runner.py` | 自定义 Bridge runner；通常不需要覆盖 |
| `BRIDGE_RUNTIME_ROOT` | `<runtime>/bridge-sessions` | 平台管理的 Bridge Session runtime 根目录 |
| `BRIDGE_CHATFILE_ROOT` | `<runtime>/bridge-chatfiles` | 平台管理的 Bridge chatfile 根目录 |
| `CODEX_TASK_CGROUP_ROOT` | 从 `/proc/self/cgroup` 自动定位 | 可选的 cgroup v2 委派根；仅在自动定位不适用时覆盖 |
| `CODEX_INTERACTIVE_DISCONNECT_TIMEOUT_MS` | `900000` | 最后一个交互终端连接断开后的保留时间；`0` 表示禁用自动结束 |
| `CODEX_INTERACTIVE_REPLAY_BYTES` | `67108864` | 交互式 Codex CLI 断线重连的内存回放窗口，范围 `65536..134217728` 字节；完整历史仍由 transcript 保留 |
| `SOURCE_CODEX_HOME` | 部署环境提供 | Codex Skill 来源 |
| `WORKSPACE_CODEX_SKILLS_DIR` | `<项目>/.codex/skills` | 项目级 Codex Skill 来源 |
| `CODEX_DESK_AUTH_USER` | 空 | HTTP 基础认证用户名 |
| `CODEX_DESK_AUTH_PASSWORD` | 空 | HTTP 基础认证密码 |

监听非回环地址时，用户名和密码必须同时配置，否则服务拒绝启动。仍建议在外层配置 TLS 和网络访问控制。

认证用户名和密码必须成对设置，即使只监听回环地址也不允许空密码配置。`CODEX_LOG_STREAM_MAX_CONCURRENCY` 必须是 `1..64` 的整数，`CODEX_API_MAX_CONCURRENCY` 必须是 `1..256` 的整数，两个网络空闲超时必须是 `1000..3600000` 的整数；容量字节门槛必须是非负安全整数，百分比门槛必须在 `0..100`；数据库备份和恢复检查点间隔必须是 `0..8760` 的整数，对应保留数必须分别是 `1..365` 和 `1..30`；受管日志上限和保留数必须满足表中范围。非法端口、并发值、容量值、备份值、检查点值、日志值或认证配置会在启动服务树前直接报错退出并释放 Launcher 锁。

生产服务必须由专用、非 root、最小权限账户运行。以 root 启动时控制面仍可查询，但 `executionUserSafe=false` 且任务启动返回 `503`；`CODEX_ALLOW_ROOT_EXECUTION=1` 只用于隔离开发环境的临时验证。任务目录白名单不能替代 OS 沙箱，任务输入或 Skill 来源不可信时必须另加容器、虚拟机或等价隔离。

任务 Session 固定以 Codex `danger-full-access`、`approvalPolicy=never` 运行，不会弹出命令审批，也没有 Codex 文件系统沙箱。其最高权限等于 Web/Worker 服务账户的 OS 权限；若服务账户是 root，任务即可修改整台主机。生产环境必须将服务账户、工作目录和网络访问限制在可接受范围内，不能把平台直接暴露给不可信操作者。

## 健康检查

```bash
curl -fsS http://127.0.0.1:8091/api/health
```

在发布窗口中，Health/Ready 通过后执行一次完整的数据保护复验：

```bash
npm run verify:data-protection
```

该命令使用当前服务的本地监听地址和已配置的基础认证，枚举并逐个调用已托管数据库备份及恢复检查点的复验接口。它仅输出发布标识、包 ID、计数和验证结果，不输出主机路径、包内容或凭据；任何无效清单或完整性失败都会以退出码 `1` 结束。复验会写入对应的存储审计事件，因此应在受控发布窗口执行。

关键字段：

```json
{
  "ok": true,
  "ready": true,
  "runtime": {
    "runtimeMode": "bridge",
    "ready": true,
    "degradedReasons": [],
    "bridgeAvailable": true,
    "permissionMode": "danger-full-access",
    "approvalPolicy": "never",
    "fullAccessAvailable": true,
    "executionUserSafe": true,
    "rootExecutionOverride": false,
    "workerAvailable": true,
    "workerProcessVerified": true,
    "workerHeartbeatAgeMs": 350,
    "workerActive": 0,
    "workerReportedActive": 0,
    "workerMaxConcurrency": 0,
    "hostLauncher": {
      "mode": "process",
      "required": true,
      "processVerified": true
    },
    "webSupervisor": {
      "mode": "process",
      "required": true,
      "processVerified": true
    },
    "executionProcesses": {
      "ok": true,
      "tracked": 0,
      "verified": 0,
      "unverified": 0,
      "issues": []
    },
    "storageCapacity": {
      "ok": true,
      "minimumFreeBytes": 536870912,
      "minimumFreePercent": 2,
      "low": 0,
      "unavailable": 0,
      "targets": [
        { "role": "data", "status": "ok", "writable": true, "availableBytes": 1000000000, "totalBytes": 2000000000, "availablePercent": 50 }
      ]
    },
    "skillsMounted": 36,
    "workspace": { "configured": 1, "available": 1 }
  },
  "storage": {
    "ok": true,
    "quickCheck": "ok",
    "foreignKeyViolations": 0,
    "checkedAt": "2026-07-26T08:00:00.000Z",
    "cached": false
  },
  "state": {
    "ok": true,
    "violations": {
      "activeTasksWithoutSingleRunningAttempt": 0,
      "activeTasksWithoutLease": 0,
      "orphanRunningAttempts": 0,
      "activeProcessIdentityMismatches": 0,
      "unexpectedTaskLeases": 0,
      "completedTasksWithActiveCommands": 0,
      "completedTasksWithActiveSchedules": 0,
      "completedTasksWithActiveExternalAttempts": 0,
      "waitingExternalWithoutSchedule": 0,
      "emptyWaitingScheduledTasks": 0
    },
    "checkedAt": "2026-08-03T08:00:00.000Z"
  }
}
```

`/api/health` 是控制面 liveness：存储和持久状态正常时，即使执行器不可用也保持 `200`，此时 `ok=true`、`ready=false`。Web/API 可在 `bridgeAvailable=false` 时继续查询，但任务启动返回 `503`。

顶层 `apiRequests` 显示普通 API 的 `active/maxConcurrency/saturated/rejectedCount/idleTimeoutMs/idleTimeoutCount`。普通 API 槽从路由处理开始保持到处理函数结束且响应完成或连接关闭；达到上限的新请求返回 `429` 和 `Retry-After: 1`，半包上传或不再消费响应的连接在无网络活动超过阈值后关闭。客户端在长操作中途断开时，槽位仍保持到服务器内部操作结束，防止通过断线绕过并发限制；纯服务器计算阶段不计为空闲，备份和恢复复验不会因没有响应字节而被误中断。日志下载同时占普通 API 槽和独立日志槽，但继续由日志无进展计时器管理，不重复计入普通 API 空闲超时。Health/Ready 不占普通槽，因此容量耗尽时仍可诊断；Dashboard 返回的 `active` 已排除当前 Dashboard 请求本身。所有累计计数在 Web 重启后归零，短暂饱和不改变 Health/Ready 状态码。

顶层 `logStreams` 显示原始日志下载的 `active/maxConcurrency/saturated/idleTimeoutMs/idleTimeoutCount`。达到上限只让新的 Attempt stdout/stderr 或后台日志请求返回 `429` 与 `Retry-After: 1`，不影响 Health/Ready；断开的客户端以及连续无进展超过空闲阈值的响应都会关闭源流并立即释放槽位。`idleTimeoutCount` 是当前 Web 进程的累计值，滚动重启后归零。持续饱和时先检查下载客户端是否未消费响应，再按磁盘吞吐和 fd 预算调整并发或空闲阈值，不要通过提高上限掩盖客户端泄漏。

执行前和生产 readiness probe 使用：

```bash
curl -fsS http://127.0.0.1:8091/api/ready
```

`/api/ready` 只有执行能力完整时返回 `200`。通过 `start-supervised.sh` 启动时，`hostLauncher` 和 `webSupervisor` 都为 `mode=process`、`required=true`。平台分别实时核验 Launcher → Supervisor 和 Supervisor → Web/Worker 的 PID、Linux 启动时钟及祖先关系；前者失效时出现 `host_launcher_unavailable`，后者失效时出现 `web_supervisor_unavailable`，readiness 都返回 `503`。Launcher 失效不会立即关闭仍健康的 Web，因此 `/api/health` 可继续用于定位和有序停服，但此时不能接收新任务。systemd 样例直接监管 Supervisor，所以仅 `webSupervisor` 使用进程校验，`hostLauncher` 为 `mode=external`、`required=false`、`processVerified=null`。直接运行 `server.js` 时两个字段都为外部模式，外部进程管理器是否有效不由平台推断。

受控发布应设置非敏感的 `CODEX_RELEASE_ID`（例如镜像标签或流水线号）。部署后通过 `/api/ready` 的 `release.version/releaseId/startedAt/instanceId` 确认请求已进入新实例；不要仅以端口存活或源码目录更新判断发布成功。配置该值后，`bin/rolling-restart.js` 会保留它，并在维护期和恢复 readiness 时都要求替代进程报告完全一致的 `releaseId`；不一致会使重启失败并保留维护租约，供操作员检查。失败输出和 `platform.rolling_restart.failed` 审计会记录期望与实际的非敏感发布标识，便于区分代码未切换与其他启动故障。

`npm run restart:supervised` 只支持已经由新版 Launcher 启动的服务：其锁记录中必须包含受限白名单内的重启配置。对于升级前的 Launcher，若无法从 `/proc/<pid>/environ` 读取原始环境，命令会在关闭任何进程或申请维护租约之前安全退出。此时应通过原部署管理器在维护窗口执行一次受控停服和启动，携带原有环境与新的 `CODEX_RELEASE_ID`；不要手工终止 Launcher、Supervisor 或 Web 来绕过该预检。新 Launcher 成功运行一次后，后续版本可使用滚动重启。

测试分析模式不提供凭据清理维护流程：`npm run redact:report-artifacts` 和
`npm run redact:historical-reports` 仅保留旧版本兼容命令，执行只读完整性统计，`--apply` 也不会
改写 HTML、日志、报告正文、哈希或工作日志。报告中的 AK、SK、Token、Authorization、Cookie
和其他凭据是测试证据，应按高敏感数据授权访问、备份和传输。

显式交互 Codex CLI 在最后一个浏览器连接断开后默认等待 15 分钟再结束，避免失联进程长期占用资源。可通过 `CODEX_INTERACTIVE_DISCONNECT_TIMEOUT_MS=1000..86400000` 调整，或设为 `0` 禁用；该值会随 Launcher 重启配置保留。对值为 `0` 的部署应由外部操作规程确保断开终端得到显式结束。

`workerAvailable=false` 表示心跳超过约 10 秒、心跳进程已经消失、启动时钟不匹配或它不再是当前 Web 的 Worker 子进程。`executionProcesses.unverified>0` 表示活动任务登记的执行 leader 已消失或身份不匹配，应结合 `issues` 的任务和 Attempt 检查 Worker 日志与租约恢复。平台恢复检查点创建期间 `maintenance.active=true`，`degradedReasons` 包含 `platform_maintenance`，readiness 返回 `503`；租约意外未释放时最多在 `expiresAt` 后自行失效。

`storageCapacity` 按 `data`、`backup`、`runtime` 和 `workspace:N` 角色返回容量，不暴露主机路径。任一目标不可写或无法读取容量时出现 `storage_capacity_unavailable`；可用字节数或百分比低于任一配置门槛时出现 `storage_capacity_low`。这两种状态只暂停新入队和 Worker 领取，不终止正在运行的 Attempt。释放空间后无需重建任务，原 `pending` 命令会继续执行。

顶层 `backups` 返回自动调度是否启用、间隔、保留数、是否正在备份、最后成功/延迟/失败时间、下一次计划时间、可读取清单的包数量和清单不可读包数量，不返回主机目录。`retentionExcessCount>0` 或 `retentionSatisfied=false` 只表示有效包超过当前配置，页面显示“待轮转”；平台不会在启动或健康检查时主动删除旧包，下一份备份成功原子发布后才轮转。维护租约或已有备份操作导致的延期分别显示为 `lastDeferredReason=platform_maintenance` 或 `database_backup_in_progress`，并保留 `lastError`；`nextRunAt` 已是可供监控使用的重试时间。单次备份超过 `CODEX_DB_BACKUP_MAX_DURATION_MINUTES`，或服务收到关停信号时，会取消 SQLite backup 并清理未发布的 `.creating-*` 包；已发布备份不受影响。`unreadableBackupCount>0` 时应检查目录并逐个复验；数据库文件的后期损坏仍以 `backup verify` 结果为准。备份失败不伪装成 SQLite 损坏；检查 `database.backup.failed` 审计和服务日志定位原因。

顶层 `recoveryCheckpoints` 返回自动调度是否启用、间隔、保留数、是否正在创建、是否逾期、最后尝试/成功/延迟/失败时间、延迟原因、下一次计划时间、可读取检查点数和不可读取检查点数。`retentionExcessCount` 和 `retentionSatisfied` 与备份字段含义一致，超额检查点同样等下一份成功发布后轮转，不应手工删除。`overdue=true` 表示当前没有有效检查点，或最近有效检查点已超过配置间隔；繁忙延迟期间会保持为 true。它只返回固定的计数和状态，不返回主机路径、归档目录项或文件内容。

“运行库存”页面只在该视图可见时刷新数据保护状态：常态每 30 秒检查一次，数据库备份或恢复检查点进行中时每 2 秒检查一次。HTTP `503` 的完整健康响应仍作为诊断状态展示；连接失败或非健康接口响应会保留最后一次有效卡片、显示刷新错误，并按 2、4、8、16、30 秒退避重试。离开该视图、隐藏标签页或关闭页面会同时取消定时器和在途请求，不应形成后台探针负载。

顶层 `bridgeCleanup` 显示删除任务和手工 Runtime 回收的持久队列。正常完成不会入队，因为 `completed` 归档需要保留原 Bridge Session 以支持显式恢复。正常情况下 `queued=0`；Worker 正在删除时可以短暂为 1。`retrying>0` 时先按任务 ID 查询 `bridge.session.cleanup.retry` 审计。重复记录、损坏 JSON、路径字段不符、符号链接或越界路径会 fail closed，现场不会被部分删除；修复异常路径后等待 `nextAttemptAt` 自动重试。不要为了清零计数直接删除数据库作业。升级前已经没有平台任务行的旧 Bridge 孤儿不会自动批量回收，避免删除未确认的历史证据。

升级前 Bridge runtime 使用用户级全局 Skill 的只读库存命令盘点：

```bash
node "${CODEX_HOME:-$HOME/.codex}/skills/codex-task-platform-api/scripts/codex_task_api.js" bridge-session list
```

先保存列表并逐个核对 `sessionId/category/taskId/taskStatus/resources/bytes`。`task_owned`、`cleanup_inconsistent` 和 `unsafe` 不得回收；`cleanup_queued` 只观察原作业。只有明确确认不再需要恢复原 Codex Session 的 `completed_retained`，或确认无归属的 `orphan`，才执行 `bridge-session reclaim SESSION_ID --yes`，一次只处理一个 ID，然后观察返回 job、`bridgeCleanup` 健康计数及 `bridge.session.cleanup.*` 审计。回收 `completed_retained` 后平台历史和 CLI transcript 仍可查看，但 `/restore` 会返回 `409`。重复同一命令返回原作业，不会创建第二个回收任务。盘点和回收响应不含 Session key 与主机路径；需要修复不安全现场时从受保护的服务日志和本机 runtime 检查，不要直接删除数据库记录或批量 `rm`。

`backups` 和 `recoveryCheckpoints` 都包含 `auditFailureCount`、`unrecordedAuditEventCount`、`lastAuditErrorAt`、`lastAuditError`、`lastAuditRecoveryAt`，以及 outbox 的 `auditQueueDurable`、`outboxFailureCount`、`lastOutboxErrorAt`、`lastOutboxError`。创建/复验响应的 `auditRecorded=false` 表示核心操作已经完成，但审计事务暂未落库；不要重做核心操作。平台先把完整批次原子写入 `CODEX_DESK_DATA_DIR/storage-audit-outbox.json`，再每 30 秒、服务启动时以及下一次同类审计时幂等重放。待写数回到 0 后再确认审计记录；若 `auditQueueDurable=false`，说明 outbox 也未可靠落盘，应立即保护已发布包、数据库和服务日志。

outbox 固定为普通文件 `0600`，采用临时文件、`fsync`、重命名和父目录同步发布，最大 4 MiB、最多 10000 条事件。损坏、超限、符号链接或不支持格式会在监听前终止启动，避免静默丢弃待补审计。重放使用稳定事件 ID：同 ID 同内容视为已提交，同 ID 不同内容按冲突拒绝；因此断电发生在 SQLite 提交后、outbox 删除前也不会重复审计。

存储完整性检查缓存 30 秒。`storage.ok=false` 时健康接口返回 `503`，先停止写入并保留数据目录副本，再执行离线恢复；不要通过反复重启覆盖现场。

`state.ok=false` 同样返回 `503`。先查看非零 `violations`：活动 Task 必须恰好有一个 running Attempt 和有效租约；已登记 PID 必须与 Attempt 的启动时钟/进程组一致；非执行态 Task 不能残留租约，但 Worker 已领取同一任务 `processing` 命令后、创建 Turn 前的短暂 `queued` 状态除外；`completed` Task 不能残留活动 Command、Schedule 或 External；等待后台检查的 running External 必须有活动调度，空的 `waiting_scheduled` 也不应长期存在。Worker 每 5 秒可修复调度类孤儿，但已完成任务残留活动工作、进程身份或 Task/Attempt 不一致都应先保留数据目录副本并检查服务日志，不要直接改库或按旧 PID 杀进程。

`workerActive` 是当前执行中的 Task 数，`workerMaxConcurrency=0` 表示 Worker 不设活动 Task 并发上限。所有可运行 Task 都会被领取，同一规范化工作目录中的 Task 也可以并行；这是明确支持的执行模式，平台不会为工作目录创建互斥锁或隐式排队。并发执行会随任务数增加进程、内存、文件句柄和工作目录 I/O，调用方必须保证共享目录中的命令和输出路径能够并行，资源保护应通过主机或容器级配额完成，而不是让平台 Task 排队。

## 原文审计与访问控制

本工具面向受控环境内的复盘审计，任务指令、完整命令、命令输出和原始运行事件不会做字段级脱敏。这意味着 HTTP 查询、SQLite 备份和运维快照都可能包含高敏感业务内容。

- 非回环部署必须启用应用鉴权，并在外层使用 TLS 和网络访问控制。
- 仅向复盘人员授予页面、API、数据目录和备份读取权限。
- 不要把数据库、接口响应或页面截图直接投递到公共群、工单或普通日志平台。
- 访问凭据、备份介质和审计数据应分别授权，并设置与业务要求一致的保留期限。
- 本工具不负责对外分享时的二次脱敏；导出或转发前由操作者确认内容范围。
- 启动时平台会把数据目录和运行状态根目录收紧为 `0700`，并递归把主数据目录中的历史普通目录和普通文件收紧为 `0700`、`0600`；Bridge runtime/chatfile 目录也会移除 group/other 权限并保留 owner 执行位。符号链接会被跳过且不会跟随。数据库、WAL、SHM、Session 日志、Attempt 原始输出和临时结果文件均以私有权限管理。
- Session、Attempt 输出、Bridge 临时结果和 Skill 快照的托管目录不接受符号链接或特殊文件；日志与结果文件通过 `O_NOFOLLOW` 描述符访问。若执行存储预检失败，任务会在创建 Turn 前拒绝启动，先修复对应路径再重试。

## 常见故障

### 服务无法启动

1. 检查 `node --version` 和 `npm ci`。
2. 检查端口是否占用。
3. 检查数据目录是否可写。
4. 非回环监听时检查认证环境变量是否完整。
5. systemd 部署检查 `systemctl status codex-task-sessions.service` 和服务账户目录权限。
6. `host_launcher_unavailable` 表示 `start-supervised.sh` 的 Launcher 已消失或身份不匹配。Web 和 Supervisor 可能仍在运行，但下一次 Supervisor 故障无法自动恢复；停止残留 Supervisor 后，由受控入口重新启动 `start-supervised.sh`，不要继续接受新任务。
7. `web_supervisor_unavailable` 表示要求的平台内 Supervisor 已消失或身份不匹配。新版 Web 会立即进入优雅关机；systemd 按控制组恢复服务，`start-supervised.sh` 的 Launcher 则自动重建完整进程树。若超过 30 秒仍未恢复，检查 `CODEX_DESK_RUNTIME_DIR/web-supervisor.log` 及其轮转文件、Launcher 是否存活、端口占用和两个运行锁 owner；不要手工删除活动锁，也不要按历史 PID 强杀未知进程。

### 任务无法创建

1. 检查工作目录是否存在。
2. 检查目录是否位于 `CODEX_TASK_WORKSPACE_ROOTS`。
3. 检查符号链接解析后是否越界。
4. 禁止使用平台源码、数据或运行状态目录。

### 任务无法启动

1. 检查健康接口中的 `bridgeAvailable`、`workerAvailable` 和 `executionUserSafe`。
2. 查看任务工作日志和原始日志。
3. 检查部署环境权限和网络，不要输出凭据。

### 任务停在排队中

检查 Worker 心跳和 `runtime.degradedReasons`。API 使用命令队列，Worker 不可用或存储容量低时不会启动第二个内嵌执行器。恢复 Worker 或释放空间后，未领取命令继续执行。

### Worker 异常重启

监管进程会终止旧 Worker 已登记的执行组并重启 Worker。Worker 自身捕获到 fatal 异常、250ms 任务领取循环连续失败 20 次，或心跳、租约恢复、Bridge 回收控制循环连续抛异常 5 次时，会先执行强制中断持久化再退出；任意一次成功循环会清零对应连续失败计数，短暂故障不会触发重启。Bridge 回收作业返回的业务失败仍进入自身持久重试，不计为控制循环异常。活动 Turn 和 Attempt 会记录为 `interrupted`，启用自动恢复的任务随后在同一持久 Session 中新增恢复 Turn。检查服务日志中的 `worker:poll`、`worker:heartbeat`、`worker:recovery`、`worker:bridge-cleanup`，以及工作日志中的 `session.interrupted`、`session.resume.queued` 和后续 `session.waiting_review`；不要把基础设施中断直接改成业务失败或手工复用旧 PID。

### 任务停在后台运行中

1. 在“后台与调度”确认 `nextScheduledAt`、外部执行 generation 和调度状态。
2. `pending` 且未到时间是正常等待，不占用 Codex/Worker 槽位。
3. 长时间停留在 `leased` 时检查 Worker；15 秒租约到期后会自动恢复为 `pending`。
4. `dispatched` 表示已经生成同一 Session 的新 Turn；结合命令队列、Attempt 和 Worker 心跳检查。
5. DONE/STATE/META 表示业务终态；若受管 cgroup 或身份已校验的进程组仍有成员，任务继续保持后台运行。不要用裸 PID 判断，因为 PID 可能复用。
6. 需要终止跟踪时使用页面“停止”，不要直接改 SQLite。
7. `result.ignoredStaleArtifacts` 非空表示固定路径上存在早于当前来源执行的旧终态文件；不要手工修改数据库，应检查 Skill 是否复用了文件名，并等待当前 generation 写入新证据。
8. 登记提示“active background generation”时，说明同一 chain 或证据路径仍被活动代占用；不要覆盖原文件，独立重跑应使用新的任务级路径。
9. 外部执行为 `lost` 且含 `monitoringFailure` 时，表示定时检查连续无法启动并已耗尽重试，不代表业务进程被平台终止。按记录的 LOG/DONE/STATE/META 人工核验后，在原任务中新建 Turn 恢复检查或重新登记新的 generation。
10. 工作日志出现 `schedule.recovered` 且原因为 `missing_active_schedule`，表示平台发现并重建了缺失调度；无需人工重复运行。出现 `tracking_state_recovered` 表示后台已无活动记录，任务已自动移到待验收。
11. `archiveStatus=failed` 或工作日志出现 `external.log_archive.failed` 时，先按 `archiveError` 检查原 LOG 是否缺失、仍在变化或被替换为链接。不要手工复制后直接改 SQLite；保留原路径，Worker 会按 `archiveNextRetryAt` 退避重试。`archived` 必须同时具备字节数、64 位 SHA-256 和 `archivedAt`。
12. `archiveVerifyStatus=failed` 或出现 `external.log_archive.integrity_failed` 时，不要直接下载或信任托管副本。API 会返回 `409`，Health/Ready 返回 `503`。Worker 只会使用与原摘要完全一致的业务 LOG 自动修复，并把损坏副本放入 `.quarantine/`；出现 `external.log_archive.repaired` 后核对新 `archiveVerifiedAt` 和 SHA-256。若原 LOG 已缺失或摘要不同，先保留源文件、隔离副本、错误和审计记录，再从可信恢复检查点恢复，禁止手工改库掩盖故障。
13. 用户取消或网络中断大日志下载时，服务会取消仍在进行的哈希并关闭响应源流，不应出现 `external.log_archive.integrity_failed`。若 Web 进程 fd 持续增长，检查客户端是否反复断连、服务是否已部署中断传播版本，以及 `/proc/<web-pid>/fd` 中是否残留托管日志；不要通过删除正在打开的文件掩盖泄漏。
14. 日志下载返回 `429` 时检查 `/api/health` 的 `logStreams`。`active=maxConcurrency` 表示已有下载占满槽位；客户端遵守 `Retry-After`，运维侧确认慢连接会结束或主动关闭异常客户端。槽位在 Web 进程内计数，滚动重启会自然重置，但不应以重启代替连接原因排查。
15. `idleTimeoutCount` 增长表示客户端在阈值内没有继续消费日志，响应会因 `Content-Length` 未完成而在客户端表现为中断。先检查代理、浏览器或下载程序是否暂停读取；只有确认正常链路在该时长内确实可能没有任何进展时才提高 `CODEX_LOG_STREAM_IDLE_TIMEOUT_MS`。该计数不代表日志损坏，也不会使 Health/Ready 降级。
16. `apiRequests.rejectedCount` 增长表示普通 API 容量曾耗尽；结合 `active=maxConcurrency` 检查并发调用方、半包上传和慢客户端。`apiRequests.idleTimeoutCount` 增长表示平台已主动回收无网络活动的非日志 API 连接。调用方应遵守 `Retry-After`，不要通过并发重放写请求；只有确认合法长响应持续超过阈值且期间确实没有网络活动时才调整超时。

### pytest 已结束但状态未刷新或报告入口缺失

1. 先确认这是升级后新登记的 Run。平台不会为旧 Task 推断 Step/Run、扫描目录或补录历史 HTML。
2. 检查 `/api/health` 中 `workerAvailable=true`。Worker 每秒只对已登记且仍为 `running` 的 External Attempt 核对 DONE/STATE/META；Worker 不可用时，恢复后会继续核对。
3. DONE、STATE 和 META 必须由当前 generation 在 `startedAt` 之后写入。META 至少提供绝对 `work_dir`，终态应包含 `exit_code` 和结束时间；复用旧固定文件名会被识别为 stale evidence。
4. 每个已知 HTML 必须在启动登记时重复传入 `--artifact pytest-html:<stable-key>:<absolute-path>`。wrapper 是否直接包含 pytest `--html` 不再重要，但未登记路径不会从 `.cmd`、摘要或普通报告字段猜测。
5. 同一次执行产生多份 HTML 时，每份使用唯一 key 和绝对路径；多个独立 pytest 应各自登记 External Attempt、Step Run 和 `reportKey`。同一个工作目录允许并行，但 LOG/DONE/STATE/META/HTML 必须避免互相覆盖。
6. 适用的 Skill 必须先发布一份 `status=running`、含 `executionEvidence.externalAttemptId=TRACKING_ID` 且 `artifacts=[]` 的 Schema v2 报告。平台据此立即返回 `registeredArtifacts` 并显示登记文件；只有 External Attempt 文件路径而没有关联 Run 报告，不会凭空生成业务报告入口。终态核对时平台再发布兜底修订并合并、归档启动登记的 HTML。
7. 运行中登记项可打开请求开始时的只读快照；若文件尚未生成则返回 `404`。HTML 中可见的 `summary__reload__button` 表示 pytest-html 仍认为测试在运行，这不阻止查看快照，但平台会拒绝把它提前归档为终态 artifact。等待源文件完成写入，不要手工删除 reload 元素。
8. 工作日志中的 `skill.report.artifact.retry_scheduled` 表示终态托管时源文件暂缺、仍变化或依赖资源未就绪；运行中快照与终态托管是不同阶段，快照可打开不表示归档成功。已有的其他 artifact 仍可打开。`skill.report.artifact.failed` 表示重试耗尽，应保留源文件和错误证据后修复并重新运行新的 Run。
9. Fail 分析 Markdown 通常在终态分析后生成，应由终态报告显式追加 `failure-analysis-markdown` 声明；它和 HTML 都通过同一报告 artifact API 打开。

完整登记命令和报告 Schema 见[用户手册](USER_GUIDE.md#后台任务与定时检查)与[Skill 结构化报告](SKILL_REPORTS.md#发布)。

### Session 结束后仍有相关进程

1. 推荐使用仓库 systemd 样例中的 `Delegate=yes` 和 `ProtectControlGroups=false`。平台默认从 `/proc/self/cgroup` 定位服务已委派、可写的 cgroup v2 子目录；仅在需要覆盖时设置 `CODEX_TASK_CGROUP_ROOT`。已登记的独立后台任务会被迁入任务专属 cgroup；停止时平台校验保存的路径和 inode 后执行 `cgroup.kill`，覆盖其中全部后代。
2. 没有 cgroup delegation、迁入失败或 cgroup 身份不匹配时，平台回退到身份已校验的独立进程组：先发 `SIGTERM`，仍存在时再发 `SIGKILL`。
3. 工作日志出现 `session.runtime.residual_processes.terminated` 表示平台确实清理了同组残留，应检查对应命令为何未回收子进程。
4. 合法的长时间业务任务必须使用 `run-in-background`，其启动脚本通过 `setsid` 进入独立进程组，并登记 PID/LOG/DONE/STATE/META。
5. 不要把已登记的独立后台任务误判为 Session 孤儿；应在“后台与调度”按 generation 和状态文件核对。
6. 原始 stderr 出现 `stderr remained open for more than 2 seconds` 时，该 Attempt 会失败而不会继续挂起；检查是否绕过后台启动规范或有后代继承了 Codex stderr。
7. Session 启动工作日志中的 `processIdentity` 应包含 PID、进程组和启动时钟。监管 ACK 前 Bridge runner 不会被放行；出现 `execution process identity could not be established`、`registration was rejected` 或 ACK 超时，应检查 Linux `/proc`、Worker IPC 和 Web/Worker 是否由同一 `server.js` 监管，不要单独运行 `worker.js` 承载生产任务。

### 命令没有 Skill 归因

1. 在“Agent 命令”中确认完整命令是否以 `codex-skill-use <skill-id...> --` 开头；平台不会按命令关键字猜测。
2. 检查声明的 ID 是否存在于任务的冻结快照；无效 ID 会导致包装器在实际程序启动前退出。
3. converter 后台测试通常应同时声明 `converter-test` 和 `run-in-background`，具体以当次实际遵循的 Skill 为准。
4. 对历史误报或漏报，使用“修正归因”选择最终集合并填写原因；不要直接改 SQLite，避免丢失操作者和旧值。

## 备份与恢复

服务默认每 24 小时创建一份在线 SQLite 备份。服务启动 5 秒后检查最新成功备份：没有备份或已经超过间隔时立即执行，否则在到期时间执行。手动创建和复验：

```bash
node "${CODEX_HOME:-$HOME/.codex}/skills/codex-task-platform-api/scripts/codex_task_api.js" backup create
node "${CODEX_HOME:-$HOME/.codex}/skills/codex-task-platform-api/scripts/codex_task_api.js" backup list
node "${CODEX_HOME:-$HOME/.codex}/skills/codex-task-platform-api/scripts/codex_task_api.js" backup verify BACKUP_ID
```

每个备份是 `CODEX_DESK_BACKUP_DIR/<backup-id>/` 下的私有包，包含 `database.db` 和 `manifest.json`。平台先在临时目录调用 SQLite 在线 backup API，再执行 `quick_check`、外键检查、SHA-256、大小和核心表计数复验；文件 `fsync` 后才通过目录级原子重命名发布。只有新包发布成功才按 `CODEX_DB_BACKUP_RETENTION` 删除最旧有效包。单次备份默认最多运行 120 分钟，可通过 `CODEX_DB_BACKUP_MAX_DURATION_MINUTES` 配置；超时或服务关停会取消备份并删除未发布临时包。空间不足返回 `507`，已有备份不受影响。

在线数据库备份只保护 SQLite 中的任务、Turn、Attempt、命令、工作日志、审计和 Skill 元数据。它不包含 Attempt 原始 stdout/stderr 文件、后台 pytest 日志、持久 Session runtime、Skill 快照目录或任务工作文件，因此不是完整灾难恢复点。

平台恢复检查点补齐平台自身文件、已托管的终态后台日志和平台管理的 Session runtime。Bridge Codex Session home 是外部 CLI 的实时内部状态，检查点会完整排除它，不能用恢复包继续其内部上下文；平台任务、审计、Skill 快照和封存 transcript 保留，恢复后可创建新的后续 Turn：

```bash
node "${CODEX_HOME:-$HOME/.codex}/skills/codex-task-platform-api/scripts/codex_task_api.js" recovery create
node "${CODEX_HOME:-$HOME/.codex}/skills/codex-task-platform-api/scripts/codex_task_api.js" recovery list
node "${CODEX_HOME:-$HOME/.codex}/skills/codex-task-platform-api/scripts/codex_task_api.js" recovery verify RECOVERY_ID
```

创建前，持久维护租约会在同一 SQLite 事务中确认活动 Task、Attempt、Command、Schedule、External 和已认领 Bridge cleanup 数量都为 0。维护期间新写入 API 返回 `503` 和 `Retry-After`，Worker 不领取命令、到期调度或待回收作业，并停止写入心跳；读接口仍可用。Run、原子创建、停止、完成、恢复、重置和删除请求可以进入幂等检查，但只有 SQLite 已存在完全匹配的命令或回执时才返回原结果，未提交的新键仍在任何写入前返回 `503`。平台先在最长 10 分钟的静默窗口创建验证过的数据库快照，snapshot 期间不续写维护租约；若 snapshot 超时导致租约失效，检查点 fail closed，不会继续归档。该心跳静默只作用于恢复检查点，滚动重启的维护期仍会写心跳以验证替代 Worker。之后再归档 `CODEX_DESK_DATA_DIR` 的附属文件和合格的 `CODEX_DESK_RUNTIME_DIR` 内容，明确排除 `sessions/*/skill-report-artifacts`，核对归档前后的 inode、大小和纳秒时间指纹，最后验证包布局、权限、SHA-256、数据库完整性、表计数和归档清单后原子发布。发布失败不会覆盖旧包，成功后按 `CODEX_RECOVERY_CHECKPOINT_RETENTION` 轮转。

数据库备份和恢复检查点默认每 24 小时自动调度，并从各自最近有效包的 `completedAt` 续算，服务重启不会立即重复创建，也不会仅因当前有效包超过 retention 而删除任何包。健康状态中的 `nextRunAt` 会在调度器启动时直接恢复为下一次实际到期时间，不把内部启动检查计时暴露成业务截止时间。手工数据库备份或检查点成功后会立即把对应自动调度锚点移到新的 `completedAt`，无需等待旧 timer 到点自校正；该次成功发布也是执行保留数轮转的唯一时机。备份和检查点调度器重复初始化时会替换已有 timer；停止或重启前已进入异步阶段的旧回调不能恢复旧调度链，因此同一进程不会因重复启动调度器积累多条 timer。到期时若存在活动 Task、Attempt、Command、Schedule、External，或数据库备份、其他检查点、平台维护正在进行，本次记为 `recovery.checkpoint.deferred`，15 分钟后重试，不记为失败。真正的创建错误记为 `recovery.checkpoint.failed` 并按相同间隔重试；审计 payload 使用不含路径或业务文本的错误码，例如 `ENOSPC`、`EACCES`、`MAINTENANCE_LEASE_LOST`、`SNAPSHOT_INTEGRITY_FAILED` 或 `SOURCE_CHANGED_DURING_CHECKPOINT`。成功记为 `recovery.checkpoint.created`。同一连续延迟原因只写一次审计，避免轮询刷屏。可在受控变更窗口继续手工创建和复验；设置 `CODEX_RECOVERY_CHECKPOINT_INTERVAL_HOURS=0` 只关闭自动调度，不禁用手工 API。

若检查点已经原子发布，但最后释放维护租约时发生异常，创建仍按成功返回，因为该包的完整性不受清理结果影响；返回值包含 `maintenanceReleaseUnconfirmed=true` 和租约最晚失效时间，健康状态保留清理告警，并写入 `recovery.checkpoint.maintenance_release_unconfirmed`。此时先通过 `recovery verify` 确认包，再观察 `runtime.maintenance`；租约会在 `expiresAt` 自动失效，不要删除可能已经属于其他维护操作的元数据。

每个检查点目录仅包含 `database.db`、`payload.tar.gz` 和 `manifest.json`。目录为 `0700`，文件为 `0600`。归档包含 Session 级 `auth.json`，可能保存 `OPENAI_API_KEY`，必须按凭据介质管理；API 不提供下载、文件列表或内容接口。SHA-256 用于损坏检测而不是来源签名，拥有检查点目录写权限的主体仍属于信任边界。

平台恢复检查点不包含 `CODEX_TASK_WORKSPACE_ROOTS` 下的任务工作目录，也不包含 `data/sessions/*/skill-report-artifacts` 或位于平台数据和 runtime 之外的 pytest 日志、报告和其他业务产物。恢复包中的 `coverage.taskWorkingDirectories=false` 和 `coverage.externallyLocatedLogs=false` 是强制边界，不能把该包称为全业务备份。外部产物必须使用同一恢复点附近的独立备份；唯一媒体对象按 SHA-256 去重增量备份，`videos/<run-id>` 不进入长期备份，`standard_videos` 单独备份。

配置导出同样不是完整备份。日常保护边界为：SQLite/WAL/平台运行数据由在线数据库备份和恢复检查点负责；项目代码由 Git 负责；唯一媒体对象由 SHA-256 去重增量备份负责；`videos/<run-id>` 不进入长期备份；`standard_videos` 独立备份；已托管报告只按平台 30 天策略保留，不再次打包。需要离线副本时，按[紧急离线备份](DATA_AND_RECOVERY.md#紧急离线备份)执行，并明确排除已托管报告和临时视频目录。

恢复 SQLite 在线备份时也必须先停服，先保存目标环境现状，再把已复验包中的 `database.db` 恢复为数据目录的 `codex-tasks.db`，删除旧 `-wal/-shm`，设置 `0600` 后启动。若没有同步恢复对应原始日志和 runtime，历史中的文件引用可能缺失，只能作为数据库级恢复使用。恢复后检查健康接口、任务状态、历史、工作日志、审计和一个非生产任务。详细步骤见[数据与恢复](DATA_AND_RECOVERY.md)。

## 容量边界

| 项目 | 当前限制 |
| --- | --- |
| HTTP JSON 请求体 | 1 MiB |
| API `limit` | 最大 500 |
| 最新原始日志 | 约 1 MiB 尾部 |
| 结构化运行事件 | 流式解析并按原文入库，不使用 4 MiB 截断 |
| 非结构化标准输出回退 | 4 MiB；超限时记录明确的截断事件 |
| 单次结果文本 | 保留约 256 KiB 尾部到 Turn 和工作日志；任务列表摘要限制为约 280 字符 |
| 受管监管日志 | 默认每文件 5 MiB，当前文件加 3 个历史文件；降低保留数时自动清理高编号旧代 |
| Skill 发现缓存 | 约 15 秒 |
| Worker 心跳 | 2 秒 |
| 任务租约 | 15 秒 |
| 命令领取租约 | 15 秒 |
| 定时检查领取租约 | 15 秒 |
| 默认后台检查间隔 | 5 分钟；stress 自动使用 30 分钟，可显式覆盖 |

任务执行数据和平台托管产物的保留期为 30 天，从 Task 明确完成归档的 `archivedAt` 开始计算；活动任务、失败、停止、等待输入、等待复核和等待后台结果的任务不按创建时间清理。完整命令、命令输出、结构化日志和审计保存在 SQLite 并建立索引，大体积结构化命令输出会完整保存，容量规划必须以实际任务输出为准。

Worker 启动时及此后每小时自动检查一次，每批最多清理 50 个到期 Task。它先取得 `retention_cleanup` 维护租约；平台存在活动 Task、Attempt、Command、Schedule、External 或其他维护时，本轮记录延迟并留到下一次。执行时先按 Task 创建代际暂存托管文件，再在 SQLite 事务内删除 Task、级联历史、任务审计与操作回执，并把当前 Bridge Runtime 转入持久回收队列；暂存或事务失败会恢复文件并保留 Task。通过 `/api/health` 的 `taskRetention` 检查 `dueTasks`、`lastSuccessAt`、`lastDeferredReason`、`lastFailureCode` 和累计清理数。数据库备份和恢复检查点仍按各自的数量配置轮转；备份中包含的历史数据可能晚于在线数据清理时间，必须在备份保留周期结束后再销毁对应介质。

pytest 生成的 `videos/<run-id>` 由独立的 `codex-media-retention.timer` 每 30 天滚动执行一次。生产单元必须配置明确的 `videos` 根目录并使用 `--apply`；首次部署先执行 dry-run。任务只扫描直接子目录，保护数据库仍引用的运行目录，先移动到 `.retention-quarantine/`，隔离 3 天后才永久删除；它不会触碰 `standard_videos`、SQLite/WAL、备份、恢复检查点或平台已托管报告。部署步骤见[媒体保留](MEDIA_RETENTION.md)。
