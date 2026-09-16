# API 参考

## 调用约定

- Base URL：`http://127.0.0.1:8091`。
- JSON 请求必须使用 `Content-Type: application/json`，请求体最大 1 MiB。
- 时间字段使用 UTC ISO 8601，例如 `2026-07-26T06:36:57.177Z`。
- 错误响应格式为 `{"error":"错误说明"}`。
- 每个响应包含 `X-Request-Id`；调用方也可以传入该请求头用于链路定位。
- 写操作会把 `X-Request-Id` 和当前认证用户名写入审计；未配置认证时操作者记为 `operator`。
- 配置 HTTP Basic Authentication 后，所有请求都必须携带认证信息。浏览器可先用 Basic Auth 调用 `POST /api/auth/session` 建立 12 小时的 HttpOnly 会话 Cookie，之后 artifact、iframe、媒体资源和 WebSocket 会自动复用 Cookie；命令行仍可直接使用 Basic Auth。
- 带 `Origin` 的写请求必须与当前 Host 同源。
- 平台不接受或保存 Agent、模型或编排配置。
- 任务指令、执行命令、命令输出和运行事件按执行端返回的原文保存，不做字段级脱敏。

文档示例使用以下地址：

```bash
BASE_URL=http://127.0.0.1:8091
```

用户级全局 Codex Skill `${CODEX_HOME:-$HOME/.codex}/skills/codex-task-platform-api` 封装了本文全部接口，可从不同项目调用。其脚本默认连接上述地址，也可通过 `CODEX_TASK_API_URL`、`CODEX_TASK_API_USER` 和 `CODEX_TASK_API_PASSWORD` 配置远端地址及 HTTP Basic Authentication；完整子命令见该 Skill 的 `references/api.md`。

常见状态码：

| 状态码 | 含义 |
| --- | --- |
| `200` | 查询、更新、停止、确认完成或恢复归档成功 |
| `201` | 任务或 Skill 创建成功 |
| `202` | 任务运行命令或受控 runtime 回收作业已进入队列 |
| `400` | 参数、JSON 或工作目录不合法 |
| `401` | 未通过 HTTP Basic Authentication 或浏览器会话认证 |
| `403` | 写请求来源不合法 |
| `404` | 资源或接口不存在 |
| `408` | 非日志 API 请求体在空闲阈值内没有传输进展 |
| `409` | 状态冲突、ID 冲突或只读资源被修改 |
| `413` | 请求体超过 1 MiB |
| `415` | 有请求体但 `Content-Type` 不是 `application/json` |
| `429` | 普通 API 或日志下载并发容量已满；按 `Retry-After` 重试 |
| `503` | 执行能力或 Worker 当前不可用 |

主要字符串字段上限：任务名称 200 字符，目标和备注各 256 KiB，工作目录 4096 字符，Turn 输入 512 KiB，幂等键 256 字符；Skill 名称 200 字符、分类 100 字符、描述 4096 字符、内容 768 KiB。请求体总上限仍为 1 MiB。

## 浏览器会话认证

远程部署仍以 HTTP Basic Authentication 作为凭据校验和命令行兼容方式。浏览器登录覆盖层会用一次 Basic Auth 请求建立 HttpOnly、`SameSite=Strict` 的 `codex_task_session` Cookie，有效期为 12 小时；密码不会写入 Cookie。会话 Cookie 可用于 API、原生 artifact 导航、HTML iframe、媒体资源和 WebSocket。

### `POST /api/auth/session`

请求必须携带有效 Basic Auth 或现有会话 Cookie。成功返回 `200` 并下发新的浏览器会话 Cookie；平台维护期间仍允许该登录请求。

### `GET /api/auth/session`

检查当前会话是否有效，返回 `{"ok":true}` 或 `{"ok":false}`。

### `DELETE /api/auth/session`

清除当前浏览器会话 Cookie。Basic Auth 客户端不受影响。

## 任务接口

任务在 API 中沿用 `/api/sessions` 路径。一个 Task 保存一个当前最新 Session 指针，Session 可以包含多个 Turn；创建任务不会自动启动，需另外调用 `/run`。`POST /api/sessions` 或 `/start` 是 New，创建独立 Task；`/reset` 保留 Task 并替换上下文；Run、Restore 和 Codex CLI 只解析当前最新 Session。

### 任务字段

创建和更新时使用以下字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 创建必填 | 必须匹配 `^[a-z0-9][a-z0-9_-]{0,63}$` |
| `name` | string | 创建必填 | 任务显示名称 |
| `objective` | string | 创建必填 | 任务目标、边界和验收条件 |
| `workingDir` | string | 否 | 默认 `.`；相对第一个任务根目录解析，也可使用白名单内绝对路径 |
| `notes` | string | 否 | 操作备注，不作为本轮运行指令 |
| `maxRetries` | number | 否 | 瞬时错误重试和中断自动恢复的上限，默认 `2`，范围 `0..20` |
| `autoResume` | boolean | 否 | Worker 中断或服务重启后是否自动恢复，默认 `true` |
| `enabled` | boolean | 否 | 配置是否启用，默认 `true` |

查询响应还包含以下主要字段：

| 字段 | 说明 |
| --- | --- |
| `status` | 当前任务状态 |
| `summary` | 最近一轮结果摘要 |
| `runCount` | 已启动的 Turn 数量 |
| `persistentSessionKey` | Task 当前最新的持久 Session 标识，首次运行后生成；Reset 后先清空，下一次运行生成新标识；删除后复用同一任务 ID 也不会接入旧标识 |
| `skillSnapshotId` | 首次运行时冻结的 Skill 快照 ID |
| `lastRunAt` / `lastFinishedAt` | 最近一轮启动和结束时间 |
| `archivedAt` | 显式确认完成的归档时间，未归档时为空字符串 |
| `lastError` | 最近一次错误，没有错误时为空字符串 |
| `recoveryState` | 恢复状态说明 |
| `retryCount` | 当前轮已经发生的重试次数 |
| `recoveryCount` | 当前恢复周期已经发生的服务中断自动恢复次数 |
| `activeExternalAttempts` | 尚未终止的外部后台执行数 |
| `activeScheduledJobs` | 未完成的持久化检查数 |
| `nextScheduledAt` | 最近一次待执行检查时间，没有时为空字符串 |
| `version` | 配置和状态变更版本号 |
| `createdAt` / `updatedAt` | 创建和最后更新时间 |

主要状态：

| 状态 | 含义 |
| --- | --- |
| `idle` | 已创建，尚未启动 |
| `queued` | 运行命令已排队 |
| `running` | 正在执行 |
| `recovering` | 正在恢复或重试 |
| `stopping` | 已请求停止，等待执行退出 |
| `waiting_scheduled` | Codex 已释放，但任务拥有的后台进程仍在运行并等待后续检查 |
| `waiting_review` | 本轮成功，等待继续任务或确认完成 |
| `waiting_input` | 需要调用方补充信息 |
| `failed` | 本轮失败，可人工恢复 |
| `interrupted` | Worker 或服务中断，可恢复 |
| `stopped` | 操作者停止，可恢复 |
| `completed` | 已确认完成的只读归档；保留 Runtime 时可显式 Restore 最新 Session，也可 Reset 后以相同 Task 配置建立新 Session |

### 创建任务

`POST /api/sessions`

```bash
curl -fsS "$BASE_URL/api/sessions" \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "verify-release",
    "name": "验证发布版本",
    "objective": "运行测试并汇总结果。",
    "workingDir": "project-a",
    "maxRetries": 2,
    "autoResume": true
  }'
```

成功返回 `201` 和完整任务对象：

```json
{
  "id": "verify-release",
  "name": "验证发布版本",
  "objective": "运行测试并汇总结果。",
  "workingDir": "project-a",
  "status": "idle",
  "summary": "",
  "runCount": 0,
  "persistentSessionKey": "",
  "autoResume": true,
  "maxRetries": 2,
  "retryCount": 0,
  "recoveryState": "idle",
  "skillSnapshotId": "",
  "version": 1,
  "createdAt": "2026-07-26T08:00:00.000Z",
  "updatedAt": "2026-07-26T08:00:00.000Z"
}
```

`id` 已存在时返回 `409`。工作目录不存在、超出白名单、经过符号链接越界，或与平台源码、数据、运行目录重叠时返回 `400`。

### 原子创建并启动

`POST /api/sessions/start`

新任务需要立即执行时应使用该接口，不要先创建再单独调用 Run：

```bash
curl -fsS -X POST "$BASE_URL/api/sessions/start" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: verify-release-create' \
  -d '{
    "id": "verify-release",
    "name": "验证发布版本",
    "objective": "运行测试并汇总结果。",
    "workingDir": "project-a",
    "maxRetries": 2,
    "autoResume": true
  }'
```

任务记录、`session.created` 审计、首条 Run 命令、`queued` 状态和排队工作日志在一个 SQLite `IMMEDIATE` 事务内提交。首次成功返回 `202` 和状态为 `queued` 的完整任务；同一请求重放返回 `200` 和已有任务，不会新增命令。即使客户端刷新后丢失原键，只要任务 ID、完整创建参数和首轮指令一致，重放仍返回原任务；同一 ID 对应不同参数或指令时返回 `409`。执行器未就绪、维护中或事务失败时不会留下只创建未启动的 `idle` 任务。

### 查询任务列表

`GET /api/sessions?limit=100&offset=0&status=waiting_review,failed`

```bash
curl -fsS "$BASE_URL/api/sessions?limit=100&offset=0&status=waiting_review,failed"
```

返回按 `updatedAt` 倒序排列的完整任务对象数组。`limit` 默认 `100`、最大 `500`，`offset` 默认 `0`；`status` 可传逗号分隔的已定义状态列表，包含未知状态时返回 `400`。不传 `status` 时查询全部状态。如只需首页统计，使用 `GET /api/dashboard`。

```json
[
  {
    "id": "verify-release",
    "name": "验证发布版本",
    "status": "waiting_review",
    "summary": "测试通过",
    "runCount": 1,
    "persistentSessionKey": "single:verify-release-550e8400-e29b-41d4-a716-446655440000",
    "skillSnapshotId": "snapshot-verify-release-example",
    "version": 6,
    "createdAt": "2026-07-26T08:00:00.000Z",
    "updatedAt": "2026-07-26T08:02:00.000Z"
  }
]
```

### 查询任务详情

`GET /api/sessions/:id`

```bash
curl -fsS "$BASE_URL/api/sessions/verify-release"
```

成功返回 `200` 和完整任务对象；ID 不存在时返回 `404`。

### 更新任务

`PUT /api/sessions/:id`

请求体只需提供需要修改的字段：

```bash
curl -fsS -X PUT "$BASE_URL/api/sessions/verify-release" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "验证发布候选版本",
    "maxRetries": 1,
    "autoResume": false
  }'
```

成功返回更新后的完整任务对象。`queued`、`running`、`recovering`、`stopping`、`waiting_scheduled` 或 `completed` 状态不可更新，返回 `409`。修改 `workingDir` 时会重新执行工作目录校验。

### 启动、继续或恢复任务

`POST /api/sessions/:id/run`

```bash
curl -fsS -X POST "$BASE_URL/api/sessions/verify-release/run" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: verify-release-turn-1' \
  -d '{"input":"运行测试并汇总失败项。"}'
```

首次成功入队返回 `202`，响应是状态已变为 `queued` 的任务对象。`input` 是本轮指令；为空时使用任务目标或上次指令。幂等重放同样返回 `202`，但响应反映任务当前状态，可能已经是 `running`、`waiting_review` 或其他后续状态。

同一个任务使用相同 `Idempotency-Key` 重试请求不会创建第二个 Turn。已提交键的识别先于执行 readiness、任务可变状态和维护门控：原请求入队后即使任务后来完成或禁用，或者 Worker、执行器、工作区、平台维护暂时不可用，重放仍返回原任务；门控只阻止新命令。任务已有活动命令时，新幂等键返回 `409`；不同任务复用同一幂等键也返回 `409`。尚未提交的新请求在执行能力、Worker 不可用或服务正在关闭时返回 `503`，`completed` 任务的新请求返回 `409`。

瞬时故障在单个 Turn 内生成新的 Attempt；服务中断恢复次数由 `recoveryCount` 记录。达到 `maxRetries` 后任务保留为 `interrupted`，`recoveryState` 为 `retry_exhausted`，等待人工检查和恢复。人工启动新 Turn 时恢复计数重新开始。

### 停止任务

`POST /api/sessions/:id/stop`

```bash
curl -fsS -X POST "$BASE_URL/api/sessions/verify-release/stop" \
  -H 'Idempotency-Key: verify-release-stop-1' \
  -H 'X-Task-Created-At: 2026-08-03T08:00:00.000Z'
```

```json
{"ok":true}
```

若该任务有平台启动的显式交互式 Codex CLI，服务先请求其退出、等待 PTY 结束并复验 transcript；退出超时、写入失败或完整性失败时停止请求失败，任务状态不改变。随后排队任务会取消待处理命令；运行中或有受管后台进程的任务先进入 `stopping`，只有任务 cgroup 的进程/线程以及身份已校验的进程组全部清空后才转为 `stopped`。已登记且保存了 PID 启动 tick 与独立进程组身份的后台执行会收到 `SIGTERM`，两秒后仍存活才发送 `SIGKILL`；旧记录或身份不匹配的进程不会仅凭 PID 被终止。任务不处于可停止状态时仍返回 `200`，但结果为 `{"ok":false}`。

`Idempotency-Key` 建议由调用方为一次逻辑操作生成并在超时重试时复用；已提交的响应与停止状态在同一 SQLite 事务内保存，重放不会重复写停止日志。`X-Task-Created-At` 可选，值取任务的 `createdAt`，用于阻止旧页面或旧脚本操作同 ID 的新任务代际。两个头也适用于确认完成、恢复归档、重置和删除。

平台恢复检查点持有维护租约时，已存在的 Run、原子创建、停止、完成、恢复、重置和删除幂等键仍可只读重放；没有对应命令或回执的新键返回 `503` 和 `Retry-After`，不会修改任务、文件或工作日志。

### 确认完成

`POST /api/sessions/:id/complete`

```bash
curl -fsS -X POST "$BASE_URL/api/sessions/verify-release/complete" \
  -H 'Idempotency-Key: verify-release-complete-1' \
  -H 'X-Task-Created-At: 2026-08-03T08:00:00.000Z'
```

`waiting_review` 或 `waiting_input` 且没有活动后台执行/定时检查的任务会转为 `completed`，响应为带 `archivedAt` 的完整任务对象。若交互式 Codex CLI 仍在运行，服务先请求其退出并等待 PTY 结束；每段 PTY 输出在发送到浏览器前已追加到任务私有 transcript，退出后执行 `fsync`、记录字节数和 SHA-256，并在状态事务前复验全部 transcript。退出超时、写入失败或完整性失败时归档失败，任务不会被标记为 `completed`。

完成后保留 Task 当前最新的 Bridge Runtime，Codex 进程已经终止但该 Session 仍可恢复。重复确认同一个 `completed` 任务是幂等操作，不会重复写完成事件。其他状态返回 `409`。

### 恢复已归档任务

`POST /api/sessions/:id/restore`

```bash
curl -fsS -X POST "$BASE_URL/api/sessions/verify-release/restore" \
  -H 'Idempotency-Key: verify-release-restore-1' \
  -H 'X-Task-Created-At: 2026-08-03T08:00:00.000Z'
```

仅 `completed` 任务可恢复。平台按 Task 当前 `persistentSessionKey` 确认最新 Bridge Runtime 仍存在后，把任务转为 `waiting_input`、清空 `archivedAt`，并追加 `session.restored` 工作日志和审计；恢复操作本身不启动 Codex。随后打开 Codex CLI 或提交新 Turn 时继续使用这个最新 key 对应的 Codex thread 和冻结 Skill 快照。Reset 前旧 key 的回收作业不参与本次恢复判断。相同幂等键重试返回同一次恢复结果，不重复写恢复事件。

当前 Runtime 已被手工回收、缺少可恢复 Session 或正在回收时返回 `409`。旧版本已经自动回收 Runtime 的历史任务仍可查看平台审计和已有 CLI transcript，但不能恢复该 Session。

### 重置当前 Session

`POST /api/sessions/:id/reset`

```bash
curl -fsS -X POST "$BASE_URL/api/sessions/verify-release/reset" \
  -H 'Idempotency-Key: verify-release-reset-1' \
  -H 'X-Task-Created-At: 2026-08-03T08:00:00.000Z'
```

Reset 保留 Task 的 ID、名称、目标、工作目录、备注、启停与重试配置、冻结 Skill 快照，以及已有 Turn、Attempt、命令、报告、工作日志、审计和 transcript；它清空当前结果与运行状态，把 Task 转为 `idle`，并原子清空 `persistentSessionKey`。旧 key 在同一事务中进入持久 Runtime 回收队列，下一次 `/run` 才创建新 key 和新 Codex Session。`runCount` 和历史记录不归零。

活动 Task、有待处理 Run 命令、后台执行、定时检查、运行时所有权或活动交互 CLI 时返回 `409`，应先停止并等待资源释放。Reset 可用于已归档 Task；它与 Restore 不同，Restore 继续最新 Session，Reset 放弃当前上下文。相同幂等键重放返回第一次 Reset 的响应，不会再次轮换 Session 或重复写 `session.reset`。

### 交互式 Codex CLI 与归档回放

`WS /api/sessions/:id/codex-terminal/live?cols=100&rows=30`

托管 Turn 直接把唯一的交互式 `codex` / `codex resume` TUI 进程接入 PTY；“Codex CLI”页签通过当前 Attempt 的只读输出 WebSocket 跟随同一 PTY，不会启动第二个 Codex 进程，也不会用 JSON 事件或后台 pytest 日志替代 CLI 内容。PTY 输出同时写入 Attempt stdout 和任务 transcript。runner 只从隔离 `CODEX_HOME` 的本次 rollout 增量读取结构化 `task_complete` / `turn_aborted` 事件作为 Turn 边界，并自动结束 TUI；Worker 随后从相同增量恢复 thread、Agent 消息和命令审计。显式交互 CLI 的最后一个浏览器连接断开后，默认保留 15 分钟供重连，随后自动结束；可用 `CODEX_INTERACTIVE_DISCONNECT_TIMEOUT_MS` 设置为 1000 至 86400000 毫秒，或设为 `0` 禁用自动结束。内存回放窗口默认 64 MiB，可用 `CODEX_INTERACTIVE_REPLAY_BYTES` 调整到 64 KiB 至 128 MiB；已结束任务的 transcript 不受该窗口限制，按完整字节校验后回放。

托管 Turn 已结束且操作者显式点击“重连”后，页面才连接本端点并恢复任务绑定的 Codex thread；二进制帧是原始终端输出，文本控制帧用于 `status/error`，客户端文本消息支持现有的 `input/resize/interrupt/terminate` 操作。一个任务在任一时刻只允许一个 Codex CLI 进程，页面重连复用同一进程和内存回放窗口。首次打开超大 Attempt 输出时从最新 64 MiB 开始追赶，随后持续消费全部新输出并保留最新 100,000 行滚动缓存；超过后由终端淘汰最旧行，不会关闭 WebSocket 或停止后续输出。服务端 stdout 和 transcript 始终保存完整输出。

每个 Task 的 Codex 进程使用独立的 `CODEX_HOME`，认证和基础配置从服务启动时固定的
`CODEX_SOURCE_HOME`（默认 `$HOME/.codex`）复制。服务不会把当前 Shell 中继承的旧任务级
`CODEX_HOME` 当作认证源。若连接返回 `Sign in with ChatGPT`，说明隔离 Home 中没有可用认证，
应检查启动环境并重启服务；若返回 `The task Codex Home has expired`，说明该 Task 的旧
Runtime 已回收，应先提交新的 Turn 重新创建 Runtime，再重连。两种情况都不需要把 API key
写入任务目录。

`completed` 任务连接同一地址时只从 `data/sessions/<task>/interactive-cli/` 顺序校验并回放已封存 transcript，不解析 Bridge Runtime，也不会启动或重连 Codex；每个文件在发送首个字节前先按 manifest 完整校验，回放结束发送 `state=ended`。每个进程对应一个 `0600` 原始文件和一个 `0600` manifest，父目录为 `0700`。客户端中途断开会停止后续归档读取。需要继续执行时必须先显式调用 `/restore`。

### 查询 Turn

`GET /api/sessions/:id/turns?limit=100&offset=0`

```bash
curl -fsS "$BASE_URL/api/sessions/verify-release/turns?limit=20&offset=0"
```

`limit` 默认 `100`，范围 `1` 至 `500`；`offset` 默认 `0`。结果按 Turn 序号倒序：

```json
[
  {
    "id": "turn-example",
    "sessionId": "verify-release",
    "sequence": 1,
    "input": "运行测试并汇总失败项。",
    "status": "completed",
    "result": "测试通过",
    "createdAt": "2026-07-26T08:01:00.000Z",
    "startedAt": "2026-07-26T08:01:00.000Z",
    "finishedAt": "2026-07-26T08:02:00.000Z"
  }
]
```

### 查询 Attempt

`GET /api/sessions/:id/attempts?limit=100&offset=0&turnId=:turnId`

Attempt 表示某个 Turn 的一次实际进程尝试；瞬时错误重试会在同一 Turn 下产生多个 Attempt。

```bash
curl -fsS "$BASE_URL/api/sessions/verify-release/attempts?limit=100&offset=0"
```

`limit` 默认 `100`、最大 `500`；`offset` 默认 `0`。`turnId` 可选，用于限定单个 Turn。结果按启动时间倒序：

```json
[
  {
    "id": "attempt-example",
    "sessionId": "verify-release",
    "turnId": "turn-example",
    "turnSequence": 1,
    "turnInput": "运行测试并汇总失败项。",
    "attemptNo": 1,
    "workerId": "worker-example",
    "status": "completed",
    "pid": 12345,
    "pidStartTicks": "987654321",
    "processGroupId": 12345,
    "exitCode": 0,
    "signal": "",
    "error": "",
    "startedAt": "2026-07-26T08:01:00.000Z",
    "finishedAt": "2026-07-26T08:02:00.000Z",
    "stdoutAvailable": true,
    "stdoutBytes": 18422,
    "stderrAvailable": true,
    "stderrBytes": 0
  }
]
```

### 查询 Attempt 原始 Codex CLI 输出

`GET /api/sessions/:id/attempts/:attemptId/:stream`

`:stream` 只能是 `stdout` 或 `stderr`。接口直接流式返回该 Attempt 的原始字节：stdout 是唯一托管交互式 Codex TUI PTY 合并后的真实终端输出，包含 ANSI 控制序列；stderr 只保存 runner 自身的审计完整性诊断，Codex 的 stdout/stderr 都属于同一 PTY。文件在 Attempt 启动前创建，运行中即可读取；中断、重试和服务恢复不会覆盖其他 Attempt 的文件。响应不做 JSON 重组、摘要、尾部截断或字段替换，并使用 `Content-Length` 返回本次响应的字节数。

不带查询参数时返回请求开始时文件的完整快照。实时终端可使用 `offset` 和 `limit` 增量读取；两者按原始字节计数，`offset` 默认 `0`，`limit` 默认且最大为 `1048576`。只要提供其中任意一个参数，响应就包含 `X-Log-Offset`、`X-Log-Next-Offset`、`X-Log-File-Size` 和 `X-Attempt-Status`。客户端应把 `X-Log-Next-Offset` 用作下一次游标；文件发生截断时，返回游标可能小于请求游标，客户端应从 `0` 重新显示。负数、小数、超出安全整数的 `offset`，以及不在 `1..1048576` 范围内的 `limit` 返回 `400`。

实时查看优先使用只读 WebSocket：

`WS /api/sessions/:id/attempts/:attemptId/:stream/live?offset=:byteOffset`

`offset` 是已接收的原始字节数，默认 `0`。服务端先发送 JSON 文本控制帧 `ready`，随后以二进制帧发送未经重编码的日志增量；状态或文件长度变化时发送 `status`，文件截断或游标越过新文件尾时发送 `reset`，终态文件稳定后发送 `end` 并以关闭码 `1000` 结束连接。控制帧包含 `offset`、`fileSize` 和 Attempt `status`。客户端断线后应携带最后确认的字节游标重连，并使用流式 UTF-8 解码器处理跨帧字符。该端点不接受客户端输入，收到消息后以策略关闭码 `1008` 断开。

WebSocket 使用与 HTTP API 相同的 Basic Auth、同源和任务归属校验，并与 HTTP 原始输出共用日志流并发上限。浏览器连续无法建立 WebSocket 时可降级到上述 HTTP `offset/limit` 接口；当前页面使用 750 毫秒轮询间隔作为降级路径。

Attempt stdout/stderr 与后台完整原始输出共用进程内日志流并发上限。槽位从文件打开或完整性校验前一直持有到源文件流关闭；达到 `CODEX_LOG_STREAM_MAX_CONCURRENCY` 时立即返回 `429` 和 `Retry-After: 1`，客户端应稍后重试，不应并发重放。响应源流连续 `CODEX_LOG_STREAM_IDLE_TIMEOUT_MS` 毫秒没有读取数据或解除下游背压时，服务会中断该响应并释放槽位；这是无进展超时，不限制持续传输的大文件总时长。静态资源和普通 JSON API 不占用该上限。

```bash
curl -fsS "$BASE_URL/api/sessions/verify-release/attempts/attempt-example/stdout"
curl -fsS "$BASE_URL/api/sessions/verify-release/attempts/attempt-example/stderr"
curl -fsS -D - "$BASE_URL/api/sessions/verify-release/attempts/attempt-example/stdout?offset=0&limit=262144"
```

命令的可读原文和解码后的完整执行输出仍应查询 `/executions`；后台 pytest 等脱离 Codex 进程继续运行的输出应查询 external attempt 的 `/log`。三类记录共同保留 Session、Codex 命令和后台业务进程的完整证据链。

### 查询业务 Step 与 Run

`GET /api/sessions/:id/steps`

返回 Task 的显式业务执行层级，按 Step `ordinal` 和 Run `runNumber` 排序。新执行使用以下定义：

- Step 是稳定业务范围，例如 `normal`、`long`、`restful-whiteboard-webrecord`。
- Run 是该 Step 的一次业务执行；`runKind=initial` 的 `runNumber` 为 `0`。
- Rerun 是同 Step 下的新 Run，`runKind=rerun`，并通过 `sourceRunId/sourceRunKey` 指向来源 Run。
- Retry 是同 Run 的技术重试，不创建新 Run；每个 Run 固定使用一条 External Attempt chain，`generation` 递增。

```json
[
  {
    "id": "step-example",
    "sessionId": "verify-release",
    "key": "normal",
    "label": "Normal group",
    "ordinal": 1,
    "status": "running",
    "runs": [
      {
        "id": "step-run-initial",
        "runKey": "initial",
        "runKind": "initial",
        "runNumber": 0,
        "sourceRunId": "",
        "selectionMode": "group",
        "targetCount": 974,
        "status": "failed",
        "externalAttemptIds": ["external-initial"],
        "reportIds": ["skill-report-initial"]
      },
      {
        "id": "step-run-rerun-1",
        "runKey": "rerun-1",
        "runKind": "rerun",
        "runNumber": 1,
        "sourceRunId": "step-run-initial",
        "sourceRunKey": "initial",
        "selectionMode": "failed-from-source",
        "targetCount": 7,
        "status": "running",
        "externalAttemptIds": ["external-rerun-generation-1", "external-rerun-generation-2"],
        "reportIds": []
      }
    ]
  }
]
```

```bash
curl -fsS "$BASE_URL/api/sessions/verify-release/steps"
```

不同 Step 可以在同一个 `workingDir` 并行。调用方必须为每个 Run 的 LOG、DONE、STATE、META、HTML 和其他可变产物使用唯一文件名或子目录。新模型不对旧 Task 做 Step/Run 猜测或数据回填；旧记录的 `stepRunId` 可以为空。

### 查询后台执行

`GET /api/sessions/:id/external-attempts?limit=100&offset=0&status=running`

返回该任务登记的外部执行代次。主要字段包括 `stepRunId`、`originTurnId`、`originAttemptId`、`skillInvocationId`、`skills`、`generation`、`status`、`pid`、`commandPath`、`command`、`logPath`、`donePath`、`statePath`、`metaPath`、`artifactDeclarations`、`lastObservation` 和结构化 `result`。`skills` 优先来自登记时正在执行的 `codex-skill-use` invocation；旧记录使用 `executionEvidence.externalAttemptId` 精确关联的 Skill Report，其次使用已经绑定的来源命令归因，不按名称、路径或命令关键字猜测。`artifactDeclarations` 包含启动时登记的稳定 key、kind 和源路径；页面只从中提取文件名，并通过按 key 寻址的受控端点打开文件，不把路径作为 URL 参数。终态日志托管信息位于 `archiveStatus`、`archivedLogPath`、`archivedLogBytes`、`archivedLogSha256`、`archivedAt`、`archiveAttemptCount`、`archiveNextRetryAt` 和 `archiveError`；周期校验信息位于 `archiveVerifyStatus`、`archiveVerifyError`、`archiveVerifyCount`、`archiveVerifiedAt` 和 `archiveVerifyNextAt`。`command` 从后台 runner 生成的普通 `.cmd` 文件读取，不进行改写。DONE/STATE/META 提供业务终态；受管 cgroup 或身份已校验的进程组仍有成员时，记录继续保持 `running`。META 同时支持 JSON 和 `key=value`。

`startedAt` 是当前 generation 的证据时间下界。后台启动输出与显式登记关联到唯一的来源命令后，该下界会收紧到来源命令的开始时间；服务启动时也会修复已有来源关联。DONE/STATE/META 修改时间早于该值时不会被当作当前结果，文件名会出现在 `result.ignoredStaleArtifacts`。一个 Step Run 只能属于一条 chain，一条 chain 也不能跨 Step Run；同一 Step Run 同时只允许一个活动 generation。技术 Retry 使用 `--step-run-id` 复用 Run 和 chain，业务 Rerun 则用 `--run-kind rerun --source-run-key <key>` 创建同 Step 下的新 Run。冲突登记返回 `409`。

```bash
curl -fsS "$BASE_URL/api/sessions/verify-release/external-attempts?limit=100"
```

### 查询后台完整原始输出

`GET /api/sessions/:id/external-attempts/:attemptId/log`

该接口直接流式返回后台执行登记的普通 `.log` 文件，内容不做摘要、尾部截断、编码转换或字段替换。终态日志已经托管时只读取 `data/sessions/<task>/external-attempt-output/<attempt>.log`：平台用 `O_NOFOLLOW` 打开只读文件描述符，在该描述符上计算完整字节数和 SHA-256，确认路径指纹仍指向同一 inode 后，再从同一个已校验描述符输出响应，不会在校验后重新按路径打开。副本缺失、路径不符或摘要不符时拒绝返回可疑内容，记录工作日志并返回 `409`。托管尚未完成且尚无既有摘要时读取原业务路径，也从已验证类型和路径指纹的同一描述符输出。普通缺失返回 `404`。

不带查询参数时返回请求开始时文件的完整快照。Task 终端可使用 `offset` 和 `limit` 增量读取；参数、响应游标头和校验规则与 Attempt stdout/stderr 接口相同，均按原始字节计数。客户端应使用 `X-Log-Next-Offset` 继续读取，并以 `X-Attempt-Status` 判断后台执行状态。

实时查看优先使用只读 WebSocket：

`WS /api/sessions/:id/external-attempts/:attemptId/log/live?offset=:byteOffset`

服务端在连接建立时完成一次路径及托管副本完整性校验，随后持续读取同一个只读文件描述符，避免运行中的业务日志被路径替换。协议与 Attempt 输出 WebSocket 相同：先发送 `ready` 控制帧，以二进制帧发送原始日志字节，变化时发送 `status`，文件截断时发送 `reset`；后台执行进入 `succeeded`、`failed`、`lost` 或 `cancelled` 且文件大小稳定后发送 `end`，再以关闭码 `1000` 结束。断线重连时携带最后收到的字节数作为 `offset`。端点不接受客户端输入，并与其他原始日志接口共用认证、同源校验、日志流并发上限和空闲超时。

客户端在完整性计算期间断开时，服务会在下一个 1 MiB 读取边界取消哈希并关闭描述符；响应流期间断开时会主动销毁源文件流，不会让大日志以暂停状态长期占用 fd 或继续无效读取。客户端中断不记为托管损坏，不改变 `archiveStatus`、Health 或 Ready。

该接口也受共享日志流并发上限和无进展超时约束。完整 SHA-256 校验和向客户端传输属于同一个槽位生命周期；饱和时返回 `429` 与 `Retry-After: 1`，传输空闲超时会关闭不再读取的客户端连接，两者都不会被记为归档完整性故障。

### 打开后台执行已登记的报告

`GET|HEAD /api/sessions/:id/external-attempts/:attemptId/artifacts/:artifactKey`

按后台执行明确登记的 artifact key 返回私有、只读的文件快照；客户端不能提交文件系统路径。运行中的 HTML 使用与托管报告相同的 CSP sandbox，并以 `private, no-store` 返回。每次请求只读取打开瞬间已有的字节，pytest 后续追加内容不会进入当前响应；刷新页面可获取更新。HTML 会注入只读受控资源基址，因此同目录的 CSS、脚本、字体、图片、case log 和媒体仍按 pytest 原始加载顺序工作。

`GET|HEAD /api/sessions/:id/external-attempts/:attemptId/artifacts/:artifactKey/resources/:resourcePath`

只返回上述 HTML 使用的同目录相对资源。服务会校验 Task、Attempt、artifact key、相对路径、真实路径和普通文件类型，拒绝符号链接、目录逃逸和超过 64 MiB 的资源；媒体资源支持单段 `Range`。文件尚未生成、key 未登记或资源不存在时返回 `404`。终态托管完成后，结构化报告会改用带完整性校验的正式 artifact URL。

终态托管由 Worker 每次限量领取一条记录完成。复制使用源文件前后指纹校验、私有临时文件、`fsync` 和同目录不覆盖式原子发布；字节数与 SHA-256 在同一状态事务中入库。发布后进程中断时，下一 Worker 会复验并补记已存在副本。源文件缺失、变化或类型不安全不会静默忽略，会写入工作日志和审计，并通过 `archiveNextRetryAt` 退避重试。

Worker 对已托管日志按 `archiveVerifyNextAt` 每 24 小时渐进执行一次完整 SHA-256 校验，每轮最多处理一条，不在启动路径做无界扫描。校验租约丢失只表示另一个 Worker 接管，不会记为内容损坏。真正的完整性失败会令 Health/Ready 返回 `503`，并触发归档修复队列：仅当原业务 LOG 仍与首次托管的字节数和 SHA-256 完全一致时，平台才把损坏副本移入同任务 `.quarantine/` 后原子重建；源证据缺失或不匹配时保持失败，不用新内容覆盖原记录。

```bash
curl -fsS "$BASE_URL/api/sessions/verify-release/external-attempts/external-example/log"
curl -fsS -D - "$BASE_URL/api/sessions/verify-release/external-attempts/external-example/log?offset=0&limit=262144"
```

### 查询定时检查

`GET /api/sessions/:id/scheduled-jobs?limit=100&offset=0&status=pending,dispatched`

返回持久化调度记录，包括 `generation`、`sequence`、`dueAt`、`status`、`attemptCount`、`maxAttempts`、`commandId`、`lastError` 和继承自关联后台执行的 `skills`。`payload` 保存恢复同一 Session 所需的自包含检查上下文。调度器自身不是业务 Skill，不创建伪造的 Skill 调用记录。

```bash
curl -fsS "$BASE_URL/api/sessions/verify-release/scheduled-jobs?limit=100"
```

### 查询命令执行明细

`GET /api/sessions/:id/executions?limit=100&offset=0&turnId=:turnId`

该接口是命令级复盘的主查询接口。每条记录对应一次实际命令执行，并关联 Session、Turn 和 Attempt。`limit` 默认 `100`、最大 `500`；`offset` 默认 `0`；`turnId` 可选。`command`、stdout/stderr 聚合后的完整 `output` 与 `rawEvent` 按 Codex 执行端事件原文保存，不做摘要、截断或字段替换。

```bash
curl -fsS "$BASE_URL/api/sessions/verify-release/executions?limit=100&offset=0"
```

```json
[
  {
    "id": "execution-example",
    "sessionId": "verify-release",
    "turnId": "turn-example",
    "turnSequence": 1,
    "turnInput": "运行测试并汇总失败项。",
    "attemptId": "attempt-example",
    "attemptNo": 1,
    "runtimeItemId": "item-example",
    "command": "npm test -- --runInBand",
    "configuredWorkingDirectory": "/srv/tasks/project-a",
    "workingDirectory": "/srv/runtime/task-workfile",
    "workingDirectoryReported": true,
    "output": "tests 12\npass 12\n",
    "exitCode": 0,
    "status": "completed",
    "startedAt": "2026-07-26T08:01:10.000Z",
    "finishedAt": "2026-07-26T08:01:20.000Z",
    "declaredSkillIds": ["converter-test", "run-in-background"],
    "unresolvedSkillIds": [],
    "skills": [
      {
        "skillId": "converter-test",
        "version": 3,
        "contentHash": "b4f7...64位SHA-256",
        "action": "linked",
        "source": "runtime",
        "reason": "Declared by codex-skill-use",
        "actor": "codex-runtime",
        "ts": "2026-07-26T08:01:10.000Z"
      }
    ],
    "skillAttributionHistory": [
      {
        "skillId": "converter-test",
        "version": 3,
        "contentHash": "b4f7...64位SHA-256",
        "action": "linked",
        "source": "runtime",
        "reason": "Declared by codex-skill-use",
        "actor": "codex-runtime",
        "ts": "2026-07-26T08:01:10.000Z"
      }
    ],
    "rawEvent": {
      "type": "item.completed",
      "item": { "type": "command_execution" }
    }
  }
]
```

同一执行项的开始和完成事件使用运行项 ID 合并，完成记录保留完整命令、执行端聚合输出、退出码和最终原始事件。运行尚未完成时，`finishedAt` 和 `exitCode` 可以为空；Attempt 结束时仍未收到完成事件的执行项会随 Attempt 关闭，不会永久显示为运行中。

`configuredWorkingDirectory` 是平台交给执行适配器的规范化任务目录。`workingDirectory` 只在原始运行事件明确上报 `cwd`（或等价字段）时填写，此时 `workingDirectoryReported` 为 `true`；执行端未上报时该字段为空且布尔值为 `false`。两者不会互相冒充，复盘时应结合完整命令和 `rawEvent` 判断命令内部的 `cd` 等目录切换。

`declaredSkillIds` 来自命令开头的 `codex-skill-use` 显式声明；`skills` 是考虑人工修正后的当前有效归因；`skillAttributionHistory` 按新到旧返回所有运行时关联和人工修正。每条归因都冻结 Skill 版本和完整内容哈希。`unresolvedSkillIds` 表示命令声明了任务快照中不存在的 ID；此类包装器调用会在执行前失败，平台不会将无效 ID 记为有效 Skill。

### 查询自动 Skill 调用

`GET /api/sessions/:id/skill-invocations?limit=100&offset=0&turnId=:turnId`

返回 `codex-skill-use` 在本地执行子进程前后自动写入的调用记录。每条记录包含 `id`、Task/Turn/Attempt、父调用、冻结的 Skill ID/版本/内容哈希、可执行文件名、状态、退出码、信号和起止时间。记录由包装器直接写入 SQLite，不依赖 Agent 生成报告，也不解析 Codex 外层工具事件，因此不会增加模型调用或新的 Turn。

```bash
curl -fsS "$BASE_URL/api/sessions/verify-release/skill-invocations?limit=100&offset=0"
```

### 查询任务 Skill 使用情况

`GET /api/sessions/:id/skill-usage`

返回任务冻结快照和当前有效 Skill 使用汇总。快照中的每个 Skill 包含 `version`、`contentHash`、`commandCount`、`invocationCount`、`lastUsedAt` 和 `correctionCount`；`attributedCommandCount` 是至少关联一个有效 Skill 的命令数，顶层 `invocationCount` 是包装器自动记录的调用总数。任务首次运行前尚无快照时，`snapshot` 为 `null`。

```bash
curl -fsS "$BASE_URL/api/sessions/verify-release/skill-usage"
```

### 修正命令 Skill 归因

`PUT /api/sessions/:id/executions/:executionId/skills`

请求体给出修正后的最终 Skill ID 集合和必填原因。ID 必须存在于该任务的冻结快照。该接口允许修正已归档任务，因为修正只追加审计记录，不改变命令、输出、运行时原始声明或 Skill 快照。

```bash
curl -fsS -X PUT "$BASE_URL/api/sessions/verify-release/executions/execution-example/skills" \
  -H 'Content-Type: application/json' \
  -d '{
    "skillIds":["converter-test","run-in-background"],
    "reason":"确认该命令同时遵循业务测试和后台执行流程。"
  }'
```

平台对新增关联追加 `linked`，对移除关联追加 `unlinked`，来源均为 `operator`。旧记录不会覆盖或删除；发生变化时同时生成 `command.skills.corrected` 工作日志和全局审计事件。缺少原因、传入非数组、使用快照外 Skill 或命令不属于该任务时分别返回 `400` 或 `404`。

### 查询 Skill 结构化报告

`GET /api/sessions/:id/skill-reports?limit=100&offset=0&history=0`

返回任务中每个 `reportKey` 的最新修订，按发布时间倒序排列。`limit` 默认 `100`、最大 `500`，`offset` 默认 `0`。传入 `history=1` 时返回所有历史修订；同一报告的修订号从 `1` 开始递增，旧修订不会覆盖。

```bash
curl -fsS "$BASE_URL/api/sessions/verify-release/skill-reports?limit=100&offset=0"
```

每条记录包含报告所属的 `sessionId`、`stepRunId`、`turnId`、`attemptId`，冻结的 `skillId`、`skillVersion`、`skillContentHash`，以及 `reportKey`、`revision`、`reportHash`、`reportType`、状态、摘要、指标和通用区块。`observedAt` 是业务结果的观察时间，`publishedAt` 是平台持久化时间。所有新报告使用 Schema v2，必须显式提交 `artifacts` 数组；运行中和终态 Run 报告都提交 `executionEvidence.externalAttemptId`，平台由此绑定 `stepRunId`。同一 `reportKey` 的 revision 不能跨 Step Run。API 用 `artifactDeclarations` 返回该报告正文的原始声明；用只读 `registeredArtifacts` 返回关联 External Attempt 已登记文件的 `key`、`kind`、`fileName`、`executionStatus` 和受控快照 `url`，不返回源路径；用 `artifacts` 返回已经成功托管的文件元数据、摘要和正式打开 URL。

平台只消费显式声明，或在当前报告发布时从具体 pytest `--html` 输出做受约束的补登记；不会从摘要、普通 Section 字段或旧 Task 猜测文件。自动补登记要求 External Attempt 属于当前 Task、具备有效 Turn/Attempt 来源，并且报告工作目录与 META 权威工作目录一致且路径在其中。运行中即可投影登记项，只有终态归档阶段才要求 External Attempt 已终态并使用 META 的权威工作目录完成证据校验。每个已知 pytest HTML 仍应在 `codex-background-track register` 时通过可重复的 `--artifact pytest-html:<stable-key>:<absolute-path>` 登记，平台立即显示登记项并在源文件生成后提供只读快照，随后自动合并到终态报告；这同时支持直接 pytest 和 wrapper。同一执行可登记多份 HTML，终态报告还可追加 Fail 分析 Markdown。`codex-skill-report` 在发布事务中取得新 artifact 作业的租约并同步归档，Worker 不会并发复制同一批媒体；发布进程退出后 Worker 可在租约到期时接管，复制和摘要校验期间持续续租。单个文件缺失、超过 64 MiB、目录清理失败或校验失败不会覆盖已经成功托管的文件，持久化作业会重试并保留失败证据。相同 Step Run 的后续修订会逐个复用声明和源文件 SHA-256 均未变化的 artifact；新增失败分析等其他 artifact 不会让原有媒体重新归档，同路径内容变化时仍正常生成新归档。多个独立 pytest 应使用各自的 external attempt 和 `reportKey`，允许在同一目录并行；不同报告及其同名媒体使用隔离的托管命名空间。旧 Task 不做历史 artifact 补录。

报告引用的本地 `logs/*.txt` 在总量未超过 64 MiB artifact 上限时以内嵌只读文本形式归档；若内嵌全部唯一日志会使 HTML 超限，HTML 报告本体仍会归档并可打开，日志改为该 artifact 下的独立受认证文本资源，链接不会降级为 `Log omitted: artifact size limit` 占位。独立日志资源不占用媒体清单和分片的 10,000 项额度，因此大型并发报告不会因视频资源先达到上限而漏掉后续 case 日志。`cloud-recording-test`、`cloud-recording-gw-deploy` 或 `rtsc-cicd-deploy` 已实际执行但最新报告仍为非终态时，平台会在 Task 进入待审核状态时写入一份标记为 fallback 的终态报告；测试兜底使用 External Attempt，部署兜底优先使用该 Skill 最后的非发布命令，避免后续 pytest 退出码污染部署状态。CICD/GW 上报契约只要求开始和结束两个 revision；业务轨迹只投影每个 `reportKey` 的首条开始和最后一条终态结束，已有中间 revision 继续保留在历史 API 中但不显示为业务节点。其他类型报告仍只投影最新 revision。

```json
[
  {
    "id": "skill-report-example",
    "sessionId": "verify-release",
    "stepRunId": "step-run-initial",
    "turnId": "turn-example",
    "attemptId": "attempt-example",
    "reportKey": "cloud-recording:curated-3",
    "revision": 2,
    "schemaVersion": 2,
    "skillId": "cloud-recording-test",
    "skillVersion": 4,
    "reportType": "test-result",
    "status": "partial",
    "title": "Cloud recording result",
    "summary": "Three cases completed: 2 passed and 1 failed.",
    "observedAt": "2026-08-04T12:14:20.000Z",
    "executionEvidence": {"externalAttemptId":"external-cloud-recording-20260804"},
    "artifactDeclarations": [
      {"key":"normal","kind":"pytest-html","path":"/protected/task/cloud-recording-normal.html"},
      {"key":"long","kind":"pytest-html","path":"/protected/task/cloud-recording-long.html"}
    ],
    "registeredArtifacts": [
      {"key":"normal","kind":"pytest-html","fileName":"cloud-recording-normal.html","executionStatus":"succeeded","url":"/api/sessions/verify-release/external-attempts/external-cloud-recording-20260804/artifacts/normal"},
      {"key":"long","kind":"pytest-html","fileName":"cloud-recording-long.html","executionStatus":"succeeded","url":"/api/sessions/verify-release/external-attempts/external-cloud-recording-20260804/artifacts/long"}
    ],
    "metrics": [
      {"key":"passed","label":"Passed","value":2,"tone":"success"},
      {"key":"failed","label":"Failed","value":1,"tone":"danger"}
    ],
    "sections": [
      {
        "id":"business-result",
        "title":"Business result",
        "kind":"fields",
        "priority":"primary",
        "sensitivity":"normal",
        "defaultExpanded":true,
        "description":"",
        "fields":[{"label":"Outcome","value":"2 passed / 1 failed","format":"status","tone":"warning"}]
      }
    ],
    "artifacts": [
      {"id":"report-artifact-normal","key":"normal","kind":"pytest-html","fileName":"cloud-recording-normal.html","bytes":2048,"sha256":"example","url":"/api/sessions/verify-release/skill-reports/skill-report-example/artifacts/report-artifact-normal"}
    ],
    "publishedAt": "2026-08-04T12:14:22.000Z"
  }
]
```

`GET|HEAD /api/sessions/:id/skill-reports/:reportId/artifacts/:artifactId`

该端点以内联方式返回已经归档并通过完整性校验的报告 artifact，任务完成归档后仍可打开。pytest HTML 使用 CSP sandbox，不从原 pytest 工作目录读取；归档时已将安全的 pytest `logs/*.txt` 相对引用内嵌为文本数据，并把本地播放器脚本内嵌到 HTML，因此报告中的 `loc` 和媒体播放器不依赖原脚本目录。Fail 分析报告以 `text/markdown; charset=utf-8` 返回。`HEAD` 执行相同的归属和完整性校验，返回与 `GET` 一致的类型、长度、内联处置和安全响应头，但不读取或发送正文。托管文件缺失、路径归属不符或摘要不一致时返回 `409`。

平台还会把历史 pytest-html video 报告中精确匹配的 jsDelivr HLS、FLV、DASH 和 Shaka
脚本替换为平台随代码托管并经 SHA-256 校验的兼容内联资源；旧 HLS.js 1.5.15 URL 使用
支持 HEVC MPEG-TS 解析的 1.7.1 资源。HTML CSP 允许这些内联脚本、
媒体 Blob 以及播放器 Blob Worker，但不允许任意第三方脚本，因此播放不依赖客户端访问 CDN。

`GET|HEAD /api/sessions/:id/skill-reports/:reportId/artifacts/:artifactId/resources/:resourceId`

返回该 HTML artifact 归档的本地媒体子资源。HTML 中普通或 entity 编码的 `href`、`src`、
`data-src` 会改写到此端点；MP4、MP3、M3U8、TS、M4S、FLV、WebM、MPD 等资源分别保留
正确媒体类型。AVIF、BMP、GIF、JPEG、PNG、SVG、WebP 图片链接和 pytest-html
`data-jsonblob` 中结构化 `extras.image` 本地文件也会归档并改写。M3U8 的本地依赖和 MPD
显式引用也使用同一 artifact 的资源 URL。端点先校验
Task、报告、artifact、资源四级归属和文件摘要，支持 HEAD、完整 GET、单段 `Range: bytes=...`
及 `206 Content-Range`；无效或不可满足的 Range 返回 `416`。每个 HTML artifact 拥有独立
资源命名空间，同一 Task 多个 pytest/HTML 即使来自同一工作目录并使用同名文件也不会覆盖。
平台读取历史 pytest-html logtxt 报告时，会把复用 iframe 的旧 Log 按钮精确升级为每次打开
替换 iframe browsing context；新日志加载期间不会继续显示上一 case 的正文，归档文件本身不变。
Audio、AV、Video M3U8 同时挂载时，共享的子清单和分片按解析后的真实路径去重；M3U8 标签中
单双引号形式的本地 `URI=` 都会归档和改写。平台在托管 HTML 中为 M3U8、MPD 和 FLV 资源
URL 附加格式 fragment；fragment 不进入 HTTP 请求和鉴权签名，仅用于兼容按 URL 后缀选择
HLS、DASH 或 FLV 引擎的历史 pytest-html video 播放器。

托管 pytest HTML 打开时，平台还会为每个顶层 M3U8 计算浏览器播放源。同一资源目录中存在
同基名 MP4（优先精确基名，其次 `_0.mp4`）时直接复用该 MP4，不创建媒体副本；否则使用
`GET|HEAD /api/sessions/:id/skill-reports/:reportId/artifacts/:artifactId/resources/:resourceId/playback`
先使用原 HLS；仅在浏览器实际检测到首段视频缓冲缺失并跳到非零时间后，才通过
`playback` 端点调用 FFmpeg，以 `-c copy` 无重新编码地封装成 MP4。生成结果按 M3U8 SHA-256 在当前 Task 的
隐藏播放缓存中只保留一份，支持 HTTP Range，并随 Task 的删除或 30 天保留清理一起删除。
原 M3U8、分片及报告展示名称保持不变；该兼容层也适用于已经归档的历史报告。

`GET|POST /api/sessions/:id/skill-reports/:reportId/artifacts/:artifactId/viewed-media`

读取或登记该 pytest HTML artifact 的共享视频已查看状态。`GET` 批量返回 `mediaKeys` 和包含
`mediaKey`、`viewedAt` 的 `viewed` 数组；`POST` 接受 `{ "mediaKey": "..." }`，首次登记返回
`201`，重复登记幂等返回 `200` 并保留首次 `viewedAt`。平台不记录查看人。归档 HTML 响应会
注入平台适配器，在 sandbox 中通过当前 artifact 专属的写入能力令牌登记点击，并在打开或刷新
报告时恢复所有电脑共享的 `(viewed)` 状态；能力令牌不能读取报告或修改其他 artifact。
适配器优先使用 video 插件提供的 `data-media-key`，旧报告则回退到归档资源 ID。
`pytest-html-video-viewed`、`pytest-html-video-request-viewed-state` 和
`pytest-html-video-viewed-state` CustomEvent 构成后续 video 插件的低耦合交互协议。
初次加载会恢复全部已查看链接；后续 DOM 变化只处理新增元素子树，标题、Loading 文本和播放器
状态变化不会重新扫描整份报告。平台还会在读取时精确替换已知旧版 video Observer，使历史归档
获得相同的增量行为，而不改写归档文件。
状态保存在 SQLite，删除 artifact、报告或 Session 时通过外键级联清理。

`sensitive` 区块和 `json` 区块在服务端规范化时会强制 `defaultExpanded=false`，前端也会再次强制折叠。这只是展示策略：API 仍返回完整内容，不提供字段级脱敏或访问隔离。测试分析模式会保留报告和 artifact 中的完整 AK、SK、Token、Authorization、Cookie、密码等测试证据，也不会因命中凭据特征而中断任务。部署方必须限制这些接口及备份数据的访问。报告生产规范和完整 Schema 见 [Skill 结构化报告](SKILL_REPORTS.md)。

### 查询结构化工作日志

`GET /api/sessions/:id/worklogs?limit=500&offset=0&q=keyword`

```bash
curl -fsS "$BASE_URL/api/sessions/verify-release/worklogs?limit=100&offset=0&q=test"
```

`limit` 默认 `500`，范围 `1` 至 `500`；`offset` 默认 `0`。`q` 可选，对事件类型、消息和结构化详情执行不区分大小写的全文匹配。分页从最新事件向前取，单页响应最终按任务内 `sequence` 正序返回。命令事件的 `payload.turnId`、`payload.attemptId` 和 `payload.event` 分别保存关联 ID 与完整运行事件。

```json
[
  {
    "id": "worklog-example",
    "ts": "2026-07-26T08:02:00.000Z",
    "sessionId": "verify-release",
    "turnId": "turn-example",
    "sequence": 12,
    "level": "info",
    "kind": "session.waiting_review",
    "message": "本轮执行完成，等待确认",
    "payload": null
  }
]
```

### 查询实时日志尾部

`GET /api/sessions/:id/latest-log`

```bash
curl -fsS "$BASE_URL/api/sessions/verify-release/latest-log"
```

返回 `text/plain`，最多 1 MiB。该接口供页面实时查看最近事件，每个新 Turn 会重置，不是完整审计原件；完整 Codex CLI 输出使用 Attempt 的 `/stdout` 和 `/stderr` 接口。任务存在但尚无运行日志时返回空文本；任务不存在时返回 `404`。

### 删除任务

`DELETE /api/sessions/:id`

```bash
curl -fsS -X DELETE "$BASE_URL/api/sessions/verify-release" \
  -H 'Idempotency-Key: verify-release-delete-1' \
  -H 'X-Task-Created-At: 2026-08-03T08:00:00.000Z'
```

```json
{"ok":true}
```

只能删除非活动且未归档的任务。删除会级联清除该任务的 Turn、Attempt、命令、命令执行明细和结构化工作日志，并删除该任务的原始日志及 Skill 快照目录；全局审计仍保留删除操作。文件先移动到删除暂存名，数据库事务同时保存 Bridge runtime 回收作业，提交后 Worker 再释放原生 Session、Codex home、复制工作区、chatfile 和锁。回收失败不会把已经成功的删除误报为失败，作业会持久重试并写审计。活动任务和 `completed` 历史返回 `409`，任务不存在返回 `404` 和 `{"ok":false}`。

带幂等键的成功删除会保留独立操作回执，因此任务行已经消失后仍可用同一个键重放并得到 `200 {"ok":true}`。该回执绑定操作类型、任务 ID 和可选任务创建时间；同键改做其他操作返回 `409`，旧删除键也不会删除后来复用同 ID 创建的新任务。

## 健康与总览

### `GET /api/health`

返回控制面、Worker、执行能力、Skill、工作根目录和存储状态。顶层 `ok` 表示控制面、SQLite、持久状态不变量和终态日志托管完整性健康；顶层 `ready` 表示当前还具备接收执行任务的条件。`release` 返回应用版本、可选的 `CODEX_RELEASE_ID`、标识是否已配置、启动时间和随机实例 ID，用于发布后确认请求已到达替代进程；发布 ID 必须是非敏感的 1-128 位字母、数字、点、下划线或连字符。`externalLogArchives` 返回 `total/archived/pending/archiving/verifying/failures`、最近完整校验和最近异常；`failures` 按记录去重，任何持久归档或完整性失败都会使 Health/Ready 返回 `503`。`apiRequests` 返回 `active/maxConcurrency/saturated/rejectedCount/idleTimeoutMs/idleTimeoutCount`，统计普通 API 响应槽、容量拒绝和非日志 API 空闲回收；Health/Ready 不占普通槽，Dashboard 的 `active` 排除当前 Dashboard 请求。`logStreams` 返回 `active/maxConcurrency/saturated/idleTimeoutMs/idleTimeoutCount`，统计当前 Web 进程中的 Attempt 与后台原始日志下载；日志请求同时占普通 API 槽，但由独立日志计时器管理。两类累计计数都在 Web 重启后归零，饱和或空闲超时是可恢复容量状态，不改变 Health/Ready 状态码。`bridgeCleanup` 返回 Reset、删除任务和手工 Runtime 回收作业的 `queued/pending/processing/retrying/completed` 计数及最近一次失败；短暂待回收不阻断任务执行，持续 `retrying>0` 时应检查对应 `bridge.session.cleanup.retry` 审计和文件安全错误。`taskRetention` 返回固定 30 天策略、批量大小、cutoff、到期 Task 数、是否执行中、最近成功/延迟/失败及累计清理数；Worker 启动时和此后每小时执行检查。`workerActive` 是数据库中的当前活动执行数，`workerReportedActive` 是已验证 Worker 心跳报告的内存活动数；兼容字段 `workerMaxConcurrency` 固定为 `0`，表示不限制活动 Task 并发。同一个 `workingDir` 不是互斥资源，多个 Task 或 pytest 可以在同一目录并行执行；需要避免输出冲突的业务命令必须为日志、HTML、下载文件和其他可变产物使用每次运行唯一的文件名或子目录。任务固定使用 `permissionMode=danger-full-access` 和 `approvalPolicy=never`；`fullAccessAvailable=false` 时执行能力不可用。`executionUserSafe=false` 表示服务以根用户运行且执行已被保护性禁用；`rootExecutionOverride=true` 表示显式启用了仅供开发验证使用的根用户例外。

```bash
curl -fsS "$BASE_URL/api/health"
```

Attempt 的 `pidStartTicks` 是 Linux `/proc/:pid/stat` 启动时钟，`processGroupId` 是平台执行进程组。它们与 PID 一起构成进程身份，供崩溃清理和审计使用；不能单独根据历史 PID 操作进程。退避重试中预先创建但尚未放行的 Attempt 可以没有 PID。

`storage` 包含 `ok`、`quickCheck`、`foreignKeyViolations`、`checkedAt` 和 `cached`。完整性检查结果缓存 30 秒，避免高频健康探针反复扫描数据库。

`state` 包含 `ok`、`checkedAt` 和 `violations`。`violations` 的计数项为 `activeTasksWithoutSingleRunningAttempt`、`activeTasksWithoutLease`、`orphanRunningAttempts`、`activeProcessIdentityMismatches`、`unexpectedTaskLeases`、`completedTasksWithActiveCommands`、`completedTasksWithActiveSchedules`、`completedTasksWithActiveExternalAttempts`、`waitingExternalWithoutSchedule` 和 `emptyWaitingScheduledTasks`。`unexpectedTaskLeases` 不包含 Worker 已领取同一任务 `processing` 命令后、创建 Turn 前的正常 `queued` 瞬态。`storage.ok=false` 或 `state.ok=false` 时接口返回 `503`。

`runtime.ready` 与顶层 `ready` 在存储健康时一致。`runtime.hostLauncher` 和 `runtime.webSupervisor` 都返回 `mode`、`required` 和 `processVerified`。使用 `start-supervised.sh` 时两者均为 `mode=process`、`required=true`：Launcher 只有 PID、Linux 启动时钟以及它与 Supervisor 的直接父子关系匹配时才通过；Supervisor 还会核验它与当前 Web/Worker 的祖先关系。Launcher 丢失时 Web 继续提供 liveness 和诊断查询，但 `hostLauncher.processVerified=false`、readiness 返回 `503`，因为下一次 Supervisor 故障已没有自动恢复保证。systemd 样例直接监管 Supervisor，因此 `hostLauncher` 为 `mode=external`、`required=false`、`processVerified=null`；直接运行 Web 时两个监管字段都为外部模式。`workerProcessVerified` 要求新鲜心跳中的 PID/启动时钟仍指向当前 Web 的 Worker 子进程；仅伪造时间戳或遇到 PID 复用不会通过。`executionProcesses` 对每个已登记活动 PID 实时核验 `/proc` 启动时钟、Session 和进程组，返回 `tracked`、`verified`、`unverified` 和最多 20 条 `issues`。`storageCapacity` 按角色返回数据、运行状态和任务工作文件系统的可写性、剩余字节和百分比，不返回主机路径。`degradedReasons` 可包含 `unsupported_platform`、`executor_unavailable`、`worker_unavailable`、`execution_user_unsafe`、`workspace_unavailable`、`storage_capacity_unavailable`、`storage_capacity_low`、`execution_process_mismatch`、`web_supervisor_unavailable`、`host_launcher_unavailable` 和 `platform_maintenance`。`runtime.maintenance` 在维护期返回 `active`、`kind`、`startedAt` 和 `expiresAt`，不暴露租约 owner。

`backups` 返回在线数据库备份的调度状态：`enabled`、`intervalHours`、`retention`、`inProgress`、`lastSuccessAt`、`lastAttemptAt`、`lastDeferredAt`、`lastDeferredReason`、`lastErrorAt`、`lastError`、`nextRunAt`、`backupCount`、`retentionExcessCount`、`retentionSatisfied` 和 `unreadableBackupCount`，不返回备份主机路径。`retentionExcessCount=max(0, backupCount-retention)`，`retentionSatisfied` 表示该值是否为 0；超额表示待轮转，不属于健康故障。平台不会在启动或读取状态时删除超额包，只有下一份新包成功原子发布后才按保留数轮转。`lastDeferredReason` 为 `platform_maintenance` 或 `database_backup_in_progress`；延迟不计为失败，也不会覆盖 `lastError`。`nextRunAt` 是下一次实际到期、延迟重试或失败重试时间；调度器会先发布该时间再触发结果回调，进程重启时从最新有效包的 `completedAt` 立即恢复，不会短暂显示内部启动检查时间。单次备份受 `CODEX_DB_BACKUP_MAX_DURATION_MINUTES` 限制（默认 120 分钟），超时或服务关停会取消备份并清理未发布临时包。它还返回审计持久化状态：`auditFailureCount`、`unrecordedAuditEventCount`、`lastAuditErrorAt`、`lastAuditError`、`lastAuditRecoveryAt`、`auditQueueDurable`、`outboxFailureCount`、`lastOutboxErrorAt` 和 `lastOutboxError`。

`recoveryCheckpoints` 返回 `enabled`、`intervalHours`、`retention`、`inProgress`、`overdue`、`lastSuccessAt`、`lastAttemptAt`、`lastDeferredAt`、`lastDeferredReason`、`lastErrorAt`、`lastError`、`nextRunAt`、`checkpointCount`、`retentionExcessCount`、`retentionSatisfied`、`unreadableCheckpointCount` 和 `sensitive=true`，不返回检查点主机路径或内容。两个 retention 字段与备份含义一致；超额检查点也只在下一份检查点成功发布后轮转。`lastDeferredReason` 为 `platform_activity`、`checkpoint_in_progress`、`database_backup_in_progress` 或 `platform_maintenance`；到期但延迟时 `overdue` 保持为 true。它也返回与备份状态相同的九个审计和 outbox 持久化字段。

### `GET /api/ready`

返回与 `/api/health` 相同的结构，但只有顶层 `ok=true` 且 `runtime.ready=true` 时返回 `200`，否则返回 `503`。任务执行前或容器 readiness probe 应使用该接口；只检测 Web/存储 liveness 时使用 `/api/health`。

```bash
curl -fsS "$BASE_URL/api/ready"
```

### `GET /api/dashboard`

返回统计、运行状态、任务首页、活动任务和最近审计。`taskLimit` 默认 `100`、最大 `500`；`taskPage` 返回当前数量、总数和 `hasMore`。

```bash
curl -fsS "$BASE_URL/api/dashboard?taskLimit=100"
```

### `POST /api/runtime/sync`

刷新 Skill 发现和运行状态，不启动任务。

## Bridge Session 库存与受控回收

### `GET /api/runtime/bridge-sessions`

只读盘点平台专用 Bridge bot 当前仍存在的原生 Session runtime：

```bash
curl -fsS "$BASE_URL/api/runtime/bridge-sessions"
```

响应包含 `summary` 和 `sessions`。`summary` 返回总数、可回收数、总字节、可回收字节、分类计数和扫描时间；每个 Session 返回 `sessionId`、分类、安全性、是否可回收、资源存在标记、估算字节数、Bridge 时间、关联任务状态、已有回收作业和安全错误。接口不返回 Session key、工作目录、Codex home、chatfile 或其他主机路径，也不会自动创建回收作业。

| 分类 | 含义 | 可手工回收 |
| --- | --- | --- |
| `task_owned` | 仍由未完成平台任务引用 | 否 |
| `completed_retained` | 已完成归档保留可恢复 runtime | 是 |
| `orphan` | 没有平台任务引用 | 是 |
| `cleanup_queued` | 已有 pending/processing/retry 回收作业 | 不重复入队 |
| `cleanup_inconsistent` | 作业已完成但 Session record 仍存在 | 否，先保留现场排查 |
| `unsafe` | 记录重复、损坏、字段不符或路径不安全 | 否 |

字节数是扫描时估算值；与 Worker 并发回收时资源可以在扫描中消失，此时接口继续返回安全快照，不把正常竞态误报为平台故障。

### `POST /api/runtime/bridge-sessions/:sessionId/reclaim`

为单个精确 Session 创建持久回收作业。请求体只能包含与 URL 完全相同的确认值：

```bash
curl -fsS -X POST \
  "$BASE_URL/api/runtime/bridge-sessions/session-0123456789abcdef/reclaim" \
  -H 'Content-Type: application/json' \
  -d '{"confirmationSessionId":"session-0123456789abcdef"}'
```

Session ID 必须匹配 `session-<16 lowercase hex>`。只有当前重新盘点后仍为 `completed_retained` 或 `orphan` 的记录可以入队；事务会再次检查任务引用和维护租约。首次入队返回 `202` 与持久 `job`，已有同一作业时直接返回原作业，已完成作业返回 `200`。确认值错误返回 `400`，记录不存在返回 `404`，活动引用、歧义、不一致或不安全记录返回 `409`。

Worker 领取后仍会重新验证 Session record、任务代际和全部目标路径，再按原回收租约与重试机制执行。`completed_retained` 只释放原生 Bridge record、Codex home、复制工作区、chatfile 和锁；平台中的已完成任务、Turn、工作日志、Agent 完整回复、命令、Skill 归因、审计、Attempt stdout/stderr 和交互式 CLI transcript 保持不变。回收后 `/restore` 返回 `409`，因为原 Codex Session 已不存在。该接口不会批量回收，也不会自动处理库存。

## 数据库备份

### `GET /api/backups`

返回自动备份状态和已原子发布的备份清单。清单包含创建/完成时间、耗时、大小、SHA-256、`quickCheck`、外键违规数、页信息和核心表计数，不包含文件系统路径。手工备份成功后会立即以新的 `completedAt` 重排自动 timer，`lastSuccessAt` 和 `nextRunAt` 不会继续显示旧调度锚点。

### `POST /api/backups`

在线创建 SQLite 一致性快照。平台先在临时目录备份并验证，`fsync` 数据库和清单后原子发布；成功返回 `201`。已有备份正在执行时返回 `409`，预计写入后低于存储门槛时返回 `507`。单次运行超过 `CODEX_DB_BACKUP_MAX_DURATION_MINUTES` 或服务关停时取消，未发布临时包会被清理。成功发布后才执行保留数轮转，并写入 `database.backup.created` 审计。响应中的 `auditRecorded` 表示本次审计是否已经落库；若为 false，备份仍已成功发布，事件进入待写队列，不应通过重试创建来补审计。

```bash
curl -fsS -X POST "$BASE_URL/api/backups"
```

### `POST /api/backups/:id/verify`

重新计算包布局、权限、大小、SHA-256、SQLite `quick_check`、外键和表计数。验证操作成功时返回 `200`；`ok=false` 表示包已损坏或不再与清单一致，平台保留该包供排查并写入 `database.backup.verification_failed` 审计。响应同样包含 `auditRecorded`。ID 不合法返回 `400`，不存在返回 `404`，清单无效返回 `409`。

## 平台恢复检查点

### `GET /api/recovery-checkpoints`

返回自动调度状态和已原子发布的清单。默认间隔为 24 小时；设置 `CODEX_RECOVERY_CHECKPOINT_INTERVAL_HOURS=0` 可关闭自动调度。调度从最近有效检查点的完成时间续算；手工检查点成功后立即以新的 `completedAt` 重排下一次自动运行，到期时平台繁忙会延迟 15 分钟重试。每条记录只包含 ID、时间、耗时、敏感标记、数据库/归档校验摘要、表计数、源计数、排除项计数和固定覆盖声明。API 不返回主机路径、归档文件名列表、文件内容或下载地址。清单不可解析的目录仅以 `{id,status:"invalid"}` 返回。

### `POST /api/recovery-checkpoints`

仅在活动 Task、Attempt、Command、Schedule、External 和已认领 Bridge cleanup 数量均为 0 时创建平台恢复检查点，否则返回 `409`。同一进程已有创建操作或另一个持久维护租约时也返回 `409`；预计写入后低于容量门槛返回 `507`。成功返回 `201`，并通过 `auditRecorded` 区分包发布结果和审计落库结果。

创建期间平台持有可过期的 SQLite 维护租约，readiness 返回 `503`；除本创建入口、普通只读请求以及已提交幂等操作的只读重放外，写请求返回 `503`、`Retry-After: <seconds>` 以及不含 owner 的维护时间。Run、原子创建、停止、完成、恢复、重置和删除只有在 SQLite 中已存在完全匹配的命令或回执时才能穿过 HTTP 门控；新键会在事务内再次检查租约并在任何写入前失败。Worker 的命令领取、到期调度领取、派发和心跳写入同时暂停。SQLite snapshot 在最长 10 分钟的初始维护窗口内进行，期间不续写租约以保证静默；若窗口到期，创建 fail closed，不会继续归档。这里的心跳暂停仅适用于恢复检查点，滚动重启仍保留心跳以验证替换 Worker。租约到期后自动恢复，不需要人工清理元数据。

返回的 `coverage` 固定声明数据库、平台数据文件和平台 runtime 已包含，而任务工作目录及平台外日志未包含。包内可能包含 Session `auth.json` 和 `OPENAI_API_KEY`，因此 `sensitive=true`；这不是全业务备份，也不能通过 API 下载。

检查点原子发布后才释放维护租约。若发布成功但租约释放抛错，接口仍返回 `201` 和可复验检查点，同时附加 `maintenanceReleaseUnconfirmed=true`、`maintenanceLeaseExpiresAt`，并写入告警审计；这不会被误报为创建失败。写请求可能继续被维护门槛暂时阻塞，直到租约成功释放或在该时间自动失效。

### `POST /api/recovery-checkpoints/:id/verify`

重新验证私有包只能包含 `database.db`、`payload.tar.gz` 和 `manifest.json`，检查目录/文件权限、数据库与归档大小和 SHA-256、SQLite 完整性/外键/表计数、维护租约已清理，以及归档路径、类型、条目数、总字节和清单摘要。成功执行返回 `200`；必须以 `ok=true` 才能用于离线恢复。响应包含 `auditRecorded`。ID 不合法返回 `400`，不存在返回 `404`，清单结构不合法返回 `409`。复验失败保留现场并写入 `recovery.checkpoint.verification_failed` 审计。

备份和恢复检查点的审计批次在同一个 SQLite 事务中写入。检查点创建涉及的源数据库备份和检查点事件不会只成功一半。审计事务失败不会改变已经原子发布的包或把核心操作改报为 500；事件先以稳定 ID 和时间写入数据目录中的私有原子 outbox，再每 30 秒、服务启动时及下一次同类审计时幂等重试。`auditQueueDurable=true` 表示待写事件已落入 outbox；`unrecordedAuditEventCount=0` 且 `lastAuditRecoveryAt` 已更新表示待写事件已补齐。outbox 自身写入失败时 `auditQueueDurable=false`，必须立即检查 `lastOutboxError` 和数据盘。

## Skill 接口

### `GET /api/skills`

返回轻量摘要，不包含 `content` 和源路径。

### `POST /api/skills`

创建平台 Skill。`id` 和 `name` 必填，内容首次保存为版本 1。`enabled` 必须是布尔值；`tags` 可为字符串数组或逗号分隔字符串，最多 100 项，每项最多 100 字符。

### `GET /api/skills/:id`

返回完整内容、当前版本和内容哈希。

### `PUT /api/skills/:id`

更新平台 Skill。内容变化时版本递增；只读 Codex Skill 返回 `409`。

### `POST /api/skills/import?overwrite=false`

请求体为原始 ZIP 二进制，`Content-Type` 使用 `application/zip`、`application/x-zip-compressed` 或 `application/octet-stream`。压缩包可包含一个或多个 Skill 目录，每个目录必须符合 Codex Skill 规范：包含带 `name`、`description` YAML frontmatter 和 Markdown 指令正文的 `SKILL.md`，目录名与 `name` 相同；可同时包含 `agents/openai.yaml`、`scripts/`、`references/` 和 `assets/`。

默认遇到同 ID 平台 Skill 返回 `409`；只有显式设置 `overwrite=true` 才会覆盖并生成新版本。Codex 来源 Skill 始终不能被覆盖。整个压缩包先校验、后在单个事务中导入，任一 Skill 失败时不会写入其他 Skill。

安全限制：压缩包最大 8 MiB，解压后最大 16 MiB，最多 256 个条目，单文件最大 4 MiB；拒绝加密条目、符号链接、绝对路径、反斜杠、路径穿越、重复路径、Skill 目录外文件和嵌套 Skill 根。

### `PATCH /api/skills/:id/enabled`

请求体为 `{"enabled":true}` 或 `{"enabled":false}`。平台 Skill 和只读 Codex Skill 都可以在平台层启用或停用；状态变化写入操作审计。停用项不会进入尚未生成快照的任务，已有任务快照不变。

### `DELETE /api/skills/:id`

删除平台 Skill，包括 ZIP 导入的 Skill；只读 Codex Skill 返回 `409`，不会修改 Codex Home 中的源文件。已冻结任务快照不受删除影响。

## 审计接口

### `GET /api/audit`

参数：`limit`、`offset`、`sessionId`、`kind`、`q`。`limit` 默认 `300`、最大 `500`。结果按时间倒序。每条记录包含 `actor`、`requestId`、事件类型、时间、Session 关联和未改写的结构化详情；Session 和事件类型筛选使用索引，全文条件会扫描匹配内容。

```bash
curl -fsS "$BASE_URL/api/audit?sessionId=verify-release&limit=100&offset=0"
```

## 导入导出

### `GET /api/export`

导出 `codex-ops-bundle` 版本 4，只包含平台 Skill 和未完成任务的可移植配置，不包含已完成历史、状态、Session 标识、Turn、Attempt、日志或审计。多文件 Skill 使用 Base64 文件清单保留二进制资源和脚本执行位。导出操作本身写入审计。

### `POST /api/import`

```json
{
  "bundle": {
    "format": "codex-ops-bundle",
    "version": 4,
    "skills": [],
    "sessions": []
  },
  "mode": "merge"
}
```

活动任务存在时返回 `409`。`merge` 合并配置；`replace` 删除现有未完成任务和平台 Skill 后导入，但始终保留处于 `completed` 状态的历史。导入任务 ID 与已完成历史冲突时返回 `409`。Bundle 版本必须是数字 `3` 或 `4`；版本 3 用于兼容旧单文件包，版本 4 可保留完整 Skill 文件树。`skills` 和 `sessions` 必须是数组，所有字段执行与创建接口一致的严格类型、长度和目录校验。完整校验和写入位于同一事务中，任务文件先按代际暂存，事务失败或进程重启时自动恢复或清理，不会把旧日志挂到同 ID 新任务上。

成功响应包含 `result` 和 `runtimeSync`。导入事务成功但后续运行状态刷新失败时仍返回 `200`、`ok=true`，同时 `runtimeSync.ok=false`；调用方不应因此重复导入，应先修复运行环境再调用 `/api/runtime/sync`。
