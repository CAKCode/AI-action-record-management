# 用户手册

## 基本规则

- 一个 Task 保存一个当前最新 Session；正常继续、服务恢复和归档恢复都只使用这个最新 Session。
- 一个 Session 可以连续执行多个 Turn。
- “新建任务”创建独立 Task；“重置上下文”保留现有 Task 配置、ID 和历史，但让下一次运行创建新 Session。
- 每轮成功后进入“待确认”，可以继续任务或确认完成。
- 确认完成后进入只读历史；需要继续该任务时必须显式恢复它当前最新的 Session，不能改作其他任务。
- 平台不设置 Agent 和模型。
- 平台执行后端只支持 Codex，不提供其他 Agent 后端或模型选择。
- Session 使用最高权限直接执行，不启用 Codex 命令审批或文件系统沙箱；实际权限等于平台服务账户的操作系统权限。

## 打开平台

默认地址为 <http://127.0.0.1:8091>。首次打开显示中文，右上角可切换 English，选择保存在浏览器中。

页面包含总览、任务 Session、Skills 和操作审计四个视图。

### Codex CLI 登录提示

Task 平台为每个 Session 使用独立的 Codex Home，认证文件由服务启动时配置的
`CODEX_SOURCE_HOME` 复制，不直接共用其他任务或当前 Shell 的 `CODEX_HOME`。看到 Codex
登录页面时，通常是服务尚未加载新的认证源；先让当前任务结束，再按运维文档重启服务，
不要在任务目录手工保存 API key。

如果页面提示 `The task Codex Home has expired`，说明该任务的旧 Runtime 已按保留策略回收。
对任务提交一次新的 Turn 会重新建立 Runtime；原有 Attempt 输出和 transcript 仍可查看。

当平台仍可查询但暂时不能执行任务时，主内容顶部会显示“任务执行已暂停”告警。每个故障项同时显示当前语言的诊断名称和后端原始状态码，例如 `host_launcher_unavailable`、`worker_unavailable` 或 `storage_capacity_low`，便于与健康接口和运维文档对应。Dashboard 请求失败或超过 8 秒没有返回时，页面不会保留上一次的绿色状态，而是显示 `dashboard_unavailable` 并自动退避重连。桌面端和移动端都会显示告警；连接或执行能力恢复后自动消失。

其他页面操作请求超过 30 秒未完成时会主动中止，避免按钮或加载状态永久卡住。超时不等于服务端没有提交：页面会明确显示“结果未知”，立即刷新 Dashboard 对账；同一任务、同一输入在结果确认前重试时复用原幂等键，不会创建重复 Turn。原请求已经提交后，即使执行器暂时不可用，安全重放仍会返回任务当前状态，只有新命令会被暂停。待对账意图保存在当前标签页的会话存储中，刷新页面后仍能恢复；运行意图只保存输入的 SHA-256 摘要，不含原始指令。Dashboard 观察到任务版本、状态或更新时间变化后会确认请求已经生效并清除待对账意图。停止、确认完成、恢复归档、重置和删除也使用持久幂等键并绑定任务创建代际；请求超时后页面会查询单任务状态，已能证明成功时按成功处理，否则保留原键供安全重试。关闭任务详情产生的主动取消仍按取消处理，不会误报为请求超时。

## 创建任务

点击“新建任务”，填写：

| 字段 | 说明 |
| --- | --- |
| 任务名称 | 页面显示名称 |
| ID | 唯一 ID，只使用小写字母、数字、短横线或下划线 |
| 任务目标 | 目标、边界和验收条件 |
| 工作目录 | 相对任务根目录的路径，或白名单内的绝对路径 |
| 备注 | 仅供操作记录，不会作为执行指令发送 |
| 中断重试次数 | 短暂连接错误的自动重试次数 |
| 自动恢复 | Worker 或服务重启后是否自动继续 |
| 启用 | 关闭后任务仍可查看和编辑，但不能启动或继续 |

点击“创建并启动”后，任务创建、首条运行命令和排队日志在一个事务内提交，任务直接进入“排队中”，由 Worker 领取后变为“工作中”。网络重试不会重复创建 Turn；执行器不可用或事务失败时也不会留下只创建未启动的任务。工作目录不存在、越过白名单或与平台目录重叠时，创建会被拒绝。

### New、Reset 与 Resume

| 操作 | Task 配置与 ID | Task 历史 | Codex 上下文 |
| --- | --- | --- | --- |
| 新建任务（New） | 创建新的 | 独立记录 | 创建独立 Session |
| 重置上下文（Reset） | 保留 | 保留 Turn、Attempt、日志、审计和 transcript | 放弃当前 Session；下一次运行创建新 Session |
| 继续/恢复（Resume/Restore） | 保留 | 继续追加 | 只恢复 Task 当前最新 Session |

Reset 只在任务处于非活动状态且没有后台执行、定时检查或活动 Codex CLI 时可用。它不会把旧 Session 留作可恢复分支：旧 Runtime 会进入异步回收，页面历史仍可复盘；新 Turn 建立后，后续所有 Resume/Restore 都跟随新 Session。Task 的冻结 Skill 快照也会保留；需要使用最新 Skill 配置时应创建 New Task。

## 处理每轮结果

任务成功返回结果后进入“待确认”，不会自动归档。打开任务后可以：

- 在“任务摘要”查看当前状态、主要执行、结构化结果和关键时间线；测试任务会继续显示 pytest、Rerun 和 Fail 分析专用视图。
- 在“Agent 工作记录”查看工作步骤、生命周期和完整回复。
- 打开任务即进入“任务终端”，实时查看该 Task 当前执行的 stdout/stderr。
- 在“Agent 命令”查看完整命令、命令输出和 Skill 归因。
- 在“后台与调度”查看外部执行、状态文件、下次检查和每次调度结果。
- 输入下一条指令，继续使用同一 Session。
- 点击“确认完成”，把任务转为历史。

确认完成前应检查任务结果和验证记录。确认时平台会先结束正在运行的交互式 Codex CLI，再封存终端内容并归档。完成后任务不能直接继续、编辑或删除，但在 30 天保留窗口内仍可查看任务、Turn、日志和完整 Codex CLI transcript；只读查看不会重新连接 Codex。窗口从确认完成时的 `archivedAt` 起计算，到期后平台自动删除历史和托管 Runtime。

需要重新执行已归档任务时，点击“恢复并继续”。恢复只把任务转回“待输入”，不会立即启动 Codex；再次打开 Codex CLI 或提交新 Turn 时才恢复 Task 当前最新 Session。Reset 前旧 Session 的回收记录不会被当成当前 Session。若已手工回收当前 Runtime，审计与 transcript 仍可查看，但该 Session 不能再恢复；此时仍可 Reset 并用相同 Task 配置建立新 Session。

## 停止与恢复

运行中点击“停止”后，任务先显示“停止中”，进程退出后显示“已停止”。失败、中断和已停止任务均可输入恢复指令继续当前最新 Session。

短暂连接错误按配置自动重试。普通执行失败不会无限重试，应先查看最后错误再恢复。

## 后台任务与定时检查

converter 等 Skill 会通过 `run-in-background` 返回 `PID`、`LOG`、`DONE`、`STATE` 和 `META`。平台识别该协议后：

1. 当前 Codex Turn 结束，Codex 进程和 Worker 执行槽释放。
2. 逻辑任务进入“后台运行中”，不会进入历史，也不能确认完成。
3. 到达检查时间后，Worker 恢复 Task 当前持久 Session，并新增一个 Turn 检查状态文件和业务结果。
4. 仍在运行时保存观察并安排下一次检查；终止后汇总最终结果并进入“待确认”。如果后台命令在启动 Turn 返回前已经结束，平台会把首次结果收集提前到立即执行，而不是取消检查；pytest 失败时，适用的测试 Skill 会继续执行 `analyze-failures` 并登记结构化结论。
5. 终态后 Worker 将原始 `.log` 字节托管到任务目录；“后台与调度”可查看托管状态、字节数、SHA-256、最近完整校验和失败原因。平台每 24 小时渐进复验，读取时也会校验；异常日志不会返回，并在原业务 LOG 仍匹配原摘要时自动隔离损坏副本和修复。

启动后台进程后，Codex 必须按平台提示显式执行：

```bash
codex-background-track register \
  --pid <PID> --log <LOG> --done <DONE> --state <STATE> --meta <META> \
  --step-key normal --step-label "Normal group" \
  --run-key initial --run-kind initial --target-count 974 \
  --artifact pytest-html:normal:/absolute/task/normal.html \
  --artifact pytest-html:long:/absolute/task/long.html \
  --check-after-seconds 300 --interval-seconds 300
```

平台按 `Task -> Step -> Run -> External Attempt generation` 记录业务执行：

- Step 是稳定业务范围，例如 `normal`、`long`、`restful-whiteboard-webrecord`。
- Run 是 Step 的一次业务执行；首轮使用 `run-kind=initial`。
- Rerun 是同一 Step 下的新 Run，使用新的 `run-key`、`run-kind=rerun` 和 `source-run-key`，不能创建子 Task 代替。
- Retry 是同一 Run 的技术重试。上一 generation 终态后，使用登记返回的 `STEP_RUN_ID` 和 `--step-run-id <ID>` 再次登记；它不会在界面上增加 Rerun。

不同 Step 可以在同一个工作目录并行执行 pytest。每个 Run 必须使用唯一的 LOG、DONE、STATE、META、HTML、下载文件或输出子目录，避免业务进程互相覆盖。

状态判断以 DONE/STATE/META 为准，PID 只是辅助。Worker 每秒执行轻量终态核对；点击“停止”前也会先核对一次，已经结束的执行保留真实的 succeeded/failed 状态，只取消仍在运行的跟踪。每个已知 HTML 在启动登记时使用可重复的 `--artifact kind:key:absolute-path` 声明，并在运行中 Skill Report 通过 `executionEvidence.externalAttemptId` 关联该登记。任务摘要和结构化报告会立即显示文件名；文件已经生成时可打开请求开始时的只读快照，刷新可查看后续写入，尚未生成时返回 `404`。终态后平台自动归档并把同一条目切换为正式托管入口，不要求 wrapper 的 `.cmd` 直接包含 pytest `--html`。

运行中入口读取业务工作目录中的登记文件，不等同于已归档证据：响应不缓存并使用 HTML sandbox，但源 HTML 的本地日志、媒体或其他相对依赖可能尚未托管。终态入口从平台托管副本读取，包含已归档并改写的可用依赖，任务完成后仍可访问。

一次后台业务执行及其检查使用同一任务 Session。每天、每小时等周期性业务不是一条 Session 永久复用：每次周期应创建新的任务 Session，使每次结果独立归档和审计。

## 状态说明

| 状态 | 含义 |
| --- | --- |
| 待启动 | 已创建，未入队 |
| 排队中 | 等待 Worker |
| 工作中 | 正在执行当前 Turn |
| 恢复中 | 正在恢复或重试 |
| 停止中 | 已请求停止，等待退出 |
| 后台运行中 | Codex 已释放，但任务拥有的后台进程仍运行；平台将在到点后恢复同一 Session 创建新 Turn |
| 待确认 | 当前 Turn 成功，等待继续或确认完成 |
| 待输入 | Session 需要补充信息 |
| 失败 | 当前 Turn 失败，可恢复 |
| 已中断 | Worker 租约中断，可自动或手动恢复 |
| 已停止 | 操作者停止，可恢复 |
| 已完成 | 已确认完成的只读历史；可显式恢复当前最新 Session，或 Reset 后以原 Task 配置创建新 Session |

## Skills

Skills 页面展示：

- Codex Skill：递归发现用户级和项目级 Skill，包括系统 Skill；内容只读，可在平台层启用或停用。
- 平台 Skill：可创建、编辑、启停、删除和自动版本化。
- ZIP Skill：可一次导入一个或多个官方目录格式的 Skill；同名项默认拒绝，确认覆盖后生成新版本。

所有 Skill 都可以单独启用或停用；停用项不会进入新任务的 Skill 快照。Codex Skill 的停用仅保存在平台，不修改 Codex Home 源文件；Codex Skill 也不能由平台删除。已冻结快照不受后续开关、内容修改或删除影响。

用户级全局目录 `${CODEX_HOME:-$HOME/.codex}/skills/codex-task-platform-api` 提供平台 API Skill，可从不同项目触发。Codex 使用其类型化 CLI 查询或操作任务、Turn、Attempt、后台执行、定时检查、命令、工作日志、审计和 Skill；连接地址与认证通过环境变量提供，敏感密码不会作为命令行参数传递。

ZIP 目录遵循 Codex 官方格式：目录名与 frontmatter `name` 一致，必须包含带 `name`、`description` 和 Markdown 指令的 `SKILL.md`；可以包含 `agents/openai.yaml`、`scripts/`、`references/` 和 `assets/`。参考 [Codex Skills 官方文档](https://developers.openai.com/codex/skills/)。

ZIP 最大 8 MiB，解压后最大 16 MiB，最多 256 个条目，单文件最大 4 MiB。平台拒绝加密、符号链接、绝对路径、反斜杠、路径穿越、重复路径、目录外文件和嵌套 Skill 根。压缩包在单个事务中导入，任一项失败时全部回滚。

任务第一次执行时冻结 Skill 的完整目录快照，包括二进制资源和脚本执行位。此后修改平台 Skill 不会改变正在进行的任务，新任务会使用新版本。任务工作日志会记录快照 ID、版本和哈希。

### 命令与 Skill 追溯

“任务可用 Skill”和“命令实际使用 Skill”是两类记录：

- Skill 快照证明某个版本在任务中可用，不表示每条命令都使用了它。
- 命令归因只记录 Codex 在命令开头显式声明的 Skill，并冻结该 Skill 的版本和 SHA-256 内容哈希。

平台向 Codex 提供以下命令声明协议：

```bash
codex-skill-use <skill-id> [skill-id ...] -- <executable> [args ...]
```

例如 converter 测试同时遵循业务测试与后台执行 Skill 时：

```bash
codex-skill-use converter-test run-in-background -- python3 -m pytest path/to/test_converter.py
```

`codex-skill-use` 是本平台的审计包装器，不是 Codex CLI 的内置 `/` 命令。它先校验所有 ID 都存在于当前任务的冻结快照，再原样启动后面的程序并传递输出和退出码。包含管道、重定向等 shell 语法时，应把显式 shell 作为被执行程序，例如 `-- sh -lc 'command | tee output.log'`。

converter 场景中，一条命令可以同时关联 `converter-test`、`run-in-background` 等多个 Skill。平台不使用命令关键字猜测 Skill，避免把普通 `pytest`、日志查看或同名脚本误判为 Skill 使用。

## 审计

操作审计支持任务 ID、事件类型和全文关键字筛选。任务详情中的“操作记录”自动限定当前任务。

每个 Task 自带一个“任务终端”。通过 API 或页面创建并启动任务后，页面直接进入该终端并自动连接当前或最新 Attempt；如果 Worker 稍后才创建 Attempt，Dashboard 状态变化会触发终端重新挂接，不需要操作者寻找单独的 Session 输出入口。终端同时展示 Turn 输入、进程 ID、状态、退出码、退出信号、错误和起止时间，并提供未经摘要或截断的 Codex CLI stdout/stderr；即使该 Attempt 尚未执行任何命令也会保留。运行中的输出通过只读 WebSocket 实时追加到同一个 xterm 并自动滚动到底部，断线后携带原始字节游标继续回放；连续无法建立 WebSocket 时自动降级为每 750 毫秒增量读取。积压超过单次窗口时会连续追平，不等待下一轮。UTF-8 解码器会跨数据帧保留不完整字符，避免中文在字节边界处乱码。Attempt 进入终态且日志稳定后自动停止连接；切换辅助 Tab、收起终端、关闭详情、页面转入后台或离开页面都会中止请求并释放终端资源。

5 MiB 以上的单个输出流使用“打开完整原始输出”，避免自动把大日志载入页面；实时查看期间达到该上限时也会停止内嵌追加，完整内容继续由原始入口提供。内嵌视图使用本地加载的只读 xterm.js，支持 ANSI 样式、回车覆盖和终端滚动，不能向 Session 发送输入；浏览器不支持终端组件时自动退回纯文本。两种入口读取的是同一份 Attempt 原始文件，xterm 视图按 UTF-8 展示，原始入口保持服务器保存的完整字节流。

“Codex CLI”页签是 Codex 终端的唯一入口。托管 Turn 运行时，它实时跟随该 Turn 唯一的交互式 `codex` / `codex resume` TUI PTY，不会启动第二个 Codex 进程，也不会显示 Attempt JSON 或后台 pytest 日志。runner 只按 rollout 的结构化 Turn 完成事件自动结束 TUI，不解析终端文字。托管进程退出后显示只读终端历史；只有操作者显式点击“重连”才会再次恢复同一 Codex Session。任务完成后再次打开该页签只校验并回放全部托管/交互 transcript，不启动 Codex，也不解析或连接原 Runtime；要重新执行已归档任务，必须先显式恢复任务，再重连或提交新 Turn。页面最多追加 64 MiB、保留 100,000 行滚动缓存；超过页面上限时，Attempt 的“打开完整原始输出”入口仍可读取服务器保存的完整字节流。

“任务摘要”根据已经持久化的执行证据自动选择展示方式，不新增任务类型字段，也不要求迁移现有 Task。存在 pytest 命令、`test-result` 报告或对应 Step/Run 证据时，继续按业务时间显示回归、部署、预约回查和最终结果；其他任务则显示当前任务状态、目标或最近结果、主要后台执行、任意类型的结构化报告和任务时间线。判断不依赖任务名称或工作目录，因此代码修改、文档、排障、部署和其他 Codex 工作都可以使用同一套 Task、Session 和 Turn 生命周期。

测试摘要中，时间排序后连续出现的多个“预约回查”会合并为一个可展开组；组内仍保留每一条预约的名称和计划回查时间。回归、部署或其他里程碑插在两个预约之间时不会跨越合并。每个 pytest 回归卡片会显示其对应报告显式上报并已托管的 HTML 报告入口，包括 Rerun；存在显式上报的 `analyze-failures` Markdown 时，同一处还会显示“Fail 分析报告”入口。“结构化报告”页签保留所有报告及主要执行记录。平台不从旧 Task 的名称、命令说明或普通字段推断、补录遗漏的 artifact。

“Agent 命令”按执行项列出：

- 该命令所属的 Turn 和 Attempt。
- 执行端返回的完整命令。
- 平台配置的任务目录，以及执行端明确上报时的实际执行目录；未上报时会直接标明，不用配置值代替。
- 对应输出、退出码、开始时间和结束时间。
- 可展开查看的原始运行事件。
- Codex 显式声明并经快照校验的 Skill ID、版本、内容哈希和归因来源。
- 运行时原始归因以及后续所有人工增加、移除记录。

发现归因错误时，在命令卡片点击“修正归因”，从该任务冻结快照中重新勾选最终 Skill 集合，并填写修正原因。已完成历史也允许修正归因。修正采用追加记录：运行时声明、旧值、操作者、时间和原因都不会被覆盖；Agent 工作记录和全局操作审计会同步产生 `command.skills.corrected` 事件。

任务指令、命令、输出和原始运行事件按收到的内容保存，不做字段级脱敏。它们可能包含凭据、业务数据或文件内容，因此只能向被授权的复盘人员开放；共享截图、导出查询结果或备份前应由操作者自行判断披露范围。

“Agent 工作记录”保留生命周期、工作步骤和完整回复；Task 进程事件在“任务终端”展示，命令事件只在“Agent 命令”展示，最终回复在同一 Turn 内只显示一次。“后台与调度”保存脱离 Codex 进程运行的业务任务及后续检查。“操作审计”只显示 operator、system 和恢复工具等控制面记录，Worker、Codex runtime 和归档 Worker 的执行事件不再重复展示；底层审计原件不删除，仍可通过审计 API 查询。列表每页显示 50 条，可向前翻页。需要逐字节复盘时，使用对应 Attempt 的 stdout/stderr，而不是实时尾部日志。

## 导入导出

导出包包含未完成 Session 的可移植配置和平台 Skill；多文件 Skill 的资源会以 Base64 文件清单保留。不包含已完成历史、Turn、日志、审计或持久运行状态。

导入要求所有活动任务已经停止。`merge` 合并同 ID 配置；`replace` 会删除现有未完成任务和平台 Skill 后导入，但保留已完成历史。导入任务 ID 与已完成历史冲突时会被拒绝。导入会先完整校验并在一个事务中执行，失败不会留下半导入状态。

完整备份见[数据与恢复](DATA_AND_RECOVERY.md)。
