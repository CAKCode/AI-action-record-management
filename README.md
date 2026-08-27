# Codex Task Sessions

面向 Codex 的持久任务平台。一个 Task 始终指向一个当前最新的 Session，可以连续执行多个 Turn；中断或归档恢复只继续这个最新 Session。需要清空上下文时可 Reset 并保留 Task 配置、ID 和历史，需要完全独立的任务时使用 New 创建新 Task。

## 核心能力

- 持久任务：排队、执行、继续、停止、恢复、重置上下文、待确认和完成归档。
- 明确生命周期：New 创建独立 Task；Reset 保留 Task 并让下次运行创建新 Session；Resume/Restore 始终解析 Task 当前最新 Session，不会回到 reset 前的 Runtime。
- 并行执行：不同 Task 相互独立，同一规范化工作目录中的多个 Task 也允许并行，平台不会按目录串行化。
- 数据保留：Task 明确完成归档后，执行数据、审计和平台托管产物从 `archivedAt` 起保留 30 天，再由 Worker 通过受控清理流程删除。
- 稳定执行：Web Supervisor、独立 Worker、任务租约、心跳、幂等命令和服务重启恢复。
- 容量保护：数据、运行状态或任务工作盘空间不足时暂停领取新任务，恢复后原队列继续执行。
- 在线备份：SQLite 一致性快照经过完整性、外键、SHA-256 和表计数复验后原子发布，支持定时执行与保留数轮转。
- 平台恢复检查点：任务完全空闲时冻结写入，将已验证数据库、平台数据文件和平台管理的 Session runtime 原子打包并复验；外部 Codex Session home 不作为一致恢复源，默认只保留最新 1 份。
- 媒体分层：项目代码使用 Git；唯一媒体对象按 SHA-256 做外部增量去重备份；`videos/<run-id>` 每 30 天清理；`standard_videos` 独立备份；已托管报告不重复进入恢复检查点。
- 后台续跑：PID/LOG/DONE/STATE/META 自动登记，Codex 释放后由持久化调度恢复同一 Session 创建新 Turn。
- Step/Run 语义：业务步骤保持稳定；Rerun 是同一 Step 下的新 Run，技术 Retry 只增加同一 Run 的 External Attempt generation，避免把任务中的不同步骤误显示成 Rerun。
- 准确终态：Worker 每秒核对后台 DONE/STATE/META，停止前再同步核对一次；已经结束的 pytest 保留真实 `succeeded/failed`，不会因为取消后续回查被改成 `cancelled`。
- 统一报告：启动时显式登记每份 pytest HTML；若运行报告遗漏登记但提供了与 External Attempt META 一致的具体 `--html` 输出，平台会安全补登记。运行中立即显示并可打开 `no-store` 只读快照；终态报告自动继承并持久化归档，同一次执行支持多份 HTML，Fail 分析 Markdown 使用同一报告入口，归档失败可恢复重试。
- 直接执行：任务固定使用 Codex 最高权限模式，不启用命令审批或 Codex 沙箱。
- 原文复盘：按 Session、Turn 和 Attempt 查询完整命令、配置/执行端目录、对应输出、退出码及原始运行事件。
- 通用任务摘要：根据持久化执行证据自动展示通用任务或 pytest 专用摘要，不要求现有 Task 迁移或预先选择类型。
- Skill 追溯：命令显式声明实际使用的一个或多个 Skill，冻结版本和哈希，并保留可人工修正的追加式历史。
- 事务存储：SQLite WAL 保存任务、Turn、Attempt、外部执行、定时检查、命令执行、工作日志和审计。
- Skill 管理：递归发现 Codex Skill，支持平台级启停、ZIP 安全导入、删除与版本管理，任务首轮冻结完整目录快照。
- API Skill：用户级全局 Skill `${CODEX_HOME:-$HOME/.codex}/skills/codex-task-platform-api` 可通过类型化 CLI 跨项目管理任务、日志、审计和 Skill。
- 安全边界：任务工作目录白名单、控制面与执行面隔离、远程访问认证，以及生产环境非 root 执行保护。
- 多语言：默认中文，可切换英文。

平台只支持 Codex，不提供 Agent、其他后端或模型配置。任务始终使用部署环境提供的默认 Codex Session 能力。

## 部署依赖

| 类别 | 要求 | 用途 |
| --- | --- | --- |
| 操作系统 | Linux，提供 `/proc`；生产环境推荐 systemd 和 cgroup v2 delegation | 进程身份校验、进程组/cgroup 清理与服务监管 |
| Node.js | `20.17` 至 `26.x`，包含 npm | Web、Worker、SQLite 和运维命令 |
| Python | Python `3.11+` | Bridge runner、PTY 和执行前进程身份门控；使用标准库 `tomllib` |
| Codex | 服务账户可执行并已配置的 Codex CLI | 创建、继续和恢复 Codex Session |
| Bridge | 可导入 `workspace_bridge` 的 connect2cli Bridge 目录 | 构建持久 Session 运行环境；用 `CODEX_TASK_BRIDGE_ROOT` 指定非默认位置 |
| 原生构建工具 | Python 3、`make`、C/C++ 编译器，仅在 npm 无可用预编译包时需要 | 编译 `better-sqlite3` 和 `node-pty` |
| 可写存储 | 互不重叠的 data、runtime、backup 和 task workspace 目录 | SQLite、Session runtime、托管报告、备份和业务工作文件 |

浏览器只需要支持现代 JavaScript、WebSocket 和 xterm。`curl` 用于部署验证，不是服务运行依赖。生产部署必须使用专用非 root 服务账户；Codex CLI 和 Bridge 依赖必须对该账户可用。

## 快速启动

要求 Node.js `20.17` 至 `26.x`。首次部署先安装依赖：

```bash
cd /path/to/connect2cli-web-management
node --version
python3 --version
codex --version
npm ci
export CODEX_TASK_BRIDGE_ROOT=/path/to/connect2cli-bridge
export CODEX_TASK_WORKSPACE_ROOTS=/srv/codex-task-workspaces
sh start-supervised.sh
```

Python 必须是 `3.11+`，`CODEX_TASK_BRIDGE_ROOT` 下必须能导入 `workspace_bridge`。真实部署路径、服务账户、目录权限、`/etc/codex-task-sessions.env` 示例和 systemd 步骤见[部署与运维](docs/OPERATIONS.md)。

无 systemd 的主机使用 `start-supervised.sh`，Web 或 Supervisor 异常退出后会按退避策略自动重建完整服务树；平台会验证 Launcher 身份，Launcher 丢失时 readiness 降级。该入口默认把整棵服务树的诊断输出保存为私有、有限轮转的 `CODEX_DESK_RUNTIME_DIR/web-supervisor.log`。systemd 部署使用仓库服务样例，由 systemd 监管 Supervisor 并通过 journald 管理输出；`start.sh` 只适合已有外部监管器直接管理 Web 的场景。

更新 `start-supervised.sh` 部署时使用 `npm run restart:supervised`。该入口用持久维护租约原子确认没有活动 Task、Attempt、Command、Schedule、External、报告 artifact 归档或在线备份，阻止新写入，并从 Launcher 私有 owner 文件中的应用配置白名单、当前调用环境和部署根目录重建替代进程树；自定义 Bridge 路径等外部依赖必须与初次启动保持一致。新格式不读取目标进程的 `/proc` 环境、cwd 或命令行，可适配 ptrace/hidepid 受限主机。旧 Launcher 缺少该记录且 `/proc` 不可读时，先按新版本启动一次服务后再使用滚动重启。systemd 部署仍由 systemd 执行重启。

默认地址：<http://127.0.0.1:8091>

```bash
curl http://127.0.0.1:8091/api/health
curl -fsS http://127.0.0.1:8091/api/ready
```

## 质量检查

提交或部署前执行以下门禁：

```bash
npm run check
npm run audit:production
npm test
```

仓库的 GitHub Actions CI 使用 Node 20.19.2 与 22.x 按同一顺序执行这些检查。`check` 只校验平台 Node 源文件；运行期工作目录和非 Node 脚本不纳入该检查。

## 配置与敏感数据

真实账号、密码、Token、API Key 和私钥必须通过部署环境或仓库外的私有配置文件注入，不得写入源码或文档。运行期的 `data/`、runtime、日志、数据库、pytest 报告和恢复包也不属于源码发布物；这些内容可能按原始证据保留凭据和业务数据。

根目录 `.gitignore` 排除了常见本地状态和密钥文件，但提交前仍应检查暂存文件和差异。远程监听必须启用 Basic Auth，生产环境必须使用专用非 root 服务账户。完整要求见[安全说明](SECURITY.md)。

### Codex 认证源与任务隔离

`CODEX_SOURCE_HOME` 是任务隔离 Codex Home 的认证和配置来源，默认是服务账户的
`$HOME/.codex`。`start-supervised.sh` 会把 `CODEX_HOME` 固定为该来源，避免把启动
Shell 中遗留的任务级路径继承给新服务。每个 Task 仍会在
`BRIDGE_RUNTIME_ROOT/.bridge-codex-home/sessions/<session-id>/` 使用独立的 Codex Home，
并以私有权限复制认证文件；不同 Task 不直接共享 rollout、SQLite 或临时文件。

如果 Codex CLI 显示登录页面，先检查服务是否已经重启并加载正确的 `CODEX_SOURCE_HOME`，
不要在任务 Home 中手工写入密钥。旧任务的 Codex Home 已被清理时，提交一次新的 Task Turn
会重新创建 Runtime；原有 Attempt 输出和 transcript 仍可只读查看。

## 文档

| 文档 | 内容 |
| --- | --- |
| [用户手册](docs/USER_GUIDE.md) | Task、Session、后台执行、状态和日常操作 |
| [部署与运维](docs/OPERATIONS.md) | 运行依赖、目录权限、配置、升级、健康检查和故障处理 |
| [架构设计](docs/ARCHITECTURE.md) | 组件职责、状态机、不变量和一致性策略 |
| [API 参考](docs/API.md) | HTTP API、请求约束、响应字段和操作语义 |
| [Skill 结构化报告](docs/SKILL_REPORTS.md) | 报告 Schema、发布协议和 artifact 规则 |
| [数据与恢复](docs/DATA_AND_RECOVERY.md) | 数据布局、保留、备份、检查点和恢复步骤 |
| [媒体保留](docs/MEDIA_RETENTION.md) | pytest 生成视频的 30 天隔离清理与恢复点去重 |
| [安全说明](SECURITY.md) | 漏洞报告、凭据管理和部署安全边界 |
| [systemd 服务样例](deploy/codex-task-sessions.service.example) | 生产服务单元参考 |
| [媒体清理 systemd 样例](deploy/codex-media-retention.timer.example) | 30 天滚动媒体清理定时器 |

## 核心配置

| 环境变量 | 默认行为 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | HTTP 监听地址 |
| `PORT` | `8091` | HTTP 监听端口 |
| `CODEX_DESK_DATA_DIR` | `./data` | SQLite、原始日志和迁移来源 |
| `CODEX_DESK_BACKUP_DIR` | `<data>/backups` | 原子数据库备份包 |
| `CODEX_DB_BACKUP_INTERVAL_HOURS` | `24` | 自动数据库备份间隔；`0` 表示关闭自动调度 |
| `CODEX_DB_BACKUP_RETENTION` | `1` | 成功发布后保留的最新数据库备份数 |
| `CODEX_RECOVERY_CHECKPOINT_INTERVAL_HOURS` | `24` | 自动平台恢复检查点间隔；`0` 表示关闭自动调度 |
| `CODEX_RECOVERY_CHECKPOINT_RETENTION` | `1` | 成功发布后保留的最新平台恢复检查点数，范围 `1..30` |
| `CODEX_MEDIA_CLEANUP_ROOTS` | 未配置 | 冒号分隔的明确 `videos` 目录；不允许使用 `/data/jenkins`、平台 data/runtime/backup 或 `standard_videos` |
| `CODEX_MEDIA_RETENTION_DAYS` | `30` | 生成媒体目录保留天数 |
| `CODEX_MEDIA_QUARANTINE_DAYS` | `3` | 清理前隔离天数 |
| `CODEX_WEB_SUPERVISOR_LOG_MAX_BYTES` | `5242880` | 受管诊断日志单文件上限；默认另保留 3 个历史文件 |
| `CODEX_WEB_SUPERVISOR_LOG_RETENTION` | `3` | 受管诊断日志历史文件数，范围 `1..20` |
| `CODEX_WEB_SUPERVISOR_LOG_STDIO` | 未启用 | 设为 `1` 后由外部日志管理器接管标准输出 |
| `CODEX_ROLLING_RESTART_TIMEOUT_MS` | `60000` | 受管滚动重启每阶段等待上限，范围 `10000..300000` 毫秒 |
| `CODEX_ROLLING_RESTART_DRAIN_MS` | `500` | 取得维护租约后停服前的排空时间，范围 `0..10000` 毫秒 |
| `CODEX_DESK_RUNTIME_DIR` | 平台目录外的独立目录 | Session 运行状态和 Skill 快照 |
| `CODEX_TASK_WORKSPACE_ROOTS` | 平台旁的独立任务目录 | 允许使用的工作目录根路径，Linux 使用 `:` 分隔多个目录 |
| `CODEX_ALLOW_ROOT_EXECUTION` | 未启用 | 仅供隔离开发验证，生产环境禁止配置 |
| `CODEX_TASK_REAL_CODEX_BIN` | 从 `PATH` 查找 `codex` | 真实 Codex CLI 的绝对路径 |
| `CODEX_SOURCE_HOME` | `$HOME/.codex` | 任务隔离 Codex Home 的认证/配置来源；服务启动时不会继承外部任务级 `CODEX_HOME` |
| `CODEX_TASK_BRIDGE_ROOT` | `/home/jenkins/connect2cli-bridge` | 包含 `workspace_bridge` 的 Bridge 源目录 |
| `BRIDGE_PYTHON` | `python3` | Python `3.11+` 解释器 |
| `CODEX_TASK_CGROUP_ROOT` | 自动定位 | 可选的 cgroup v2 委派根 |
| `CODEX_API_MAX_CONCURRENCY` | `64` | 普通 API 同时占用的响应槽数，范围 `1..256`；Health/Ready 使用独立诊断通道 |
| `CODEX_API_IDLE_TIMEOUT_MS` | `30000` | 非日志 API 请求体或响应无网络进展超时，范围 `1000..3600000` 毫秒 |
| `CODEX_INTERACTIVE_REPLAY_BYTES` | `67108864` | 交互式 Codex CLI 断线重连的内存回放窗口，范围 `65536..134217728` 字节；完整历史仍从 transcript 回放 |
| `SOURCE_CODEX_HOME` | 部署环境的 Codex Home | 只读发现 Codex Skill |
| `WORKSPACE_CODEX_SKILLS_DIR` | `<项目>/.codex/skills` | 只读发现项目级 Codex Skill |
| `CODEX_DESK_AUTH_USER` | 空 | 远程监听时必填 |
| `CODEX_DESK_AUTH_PASSWORD` | 空 | 远程监听时必填 |

默认任务工作根目录会自动创建。任务工作目录不能位于平台源码、数据目录或运行状态目录中，也不能通过符号链接越过白名单。

生产环境必须使用专用、非 root、最小权限服务账户。目录白名单不是 OS 沙箱；不可信任务需要额外容器或虚拟机隔离。

旧版 `data/sessions`、`data/skills` 和 `data/audit.ndjson` 会在首次启动时一次性迁移到 `data/codex-tasks.db`。旧版 Agent、编排和 Run 数据不会加载。
