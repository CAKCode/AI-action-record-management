# 数据与恢复

## 数据布局

```text
data/
|-- codex-tasks.db
|-- codex-tasks.db-wal
|-- codex-tasks.db-shm
|-- backups/<backup-id>/database.db
|-- backups/<backup-id>/manifest.json
|-- sessions/<task-id>/latest.log
|-- sessions/<task-id>/attempt-output/<attempt-id>.stdout.log
|-- sessions/<task-id>/attempt-output/<attempt-id>.stderr.log
|-- sessions/<task-id>/external-attempt-output/<external-attempt-id>.log
|-- sessions/<task-id>/skill-report-artifacts/<report-id>/<artifact-id>.html
|-- sessions/<task-id>/skill-report-artifacts/<report-id>/<artifact-id>.resources/<resource-id>.<ext>
|-- sessions/<task-id>/interactive-cli/<transcript-id>.raw
|-- sessions/<task-id>/interactive-cli/<transcript-id>.json
`-- 旧版迁移来源
```

`codex-tasks.db` 是主数据源。WAL 和 SHM 是 SQLite 运行文件，服务运行时不能只复制主数据库文件。`data/agents/` 是只用于首次迁移的旧 Agent 配置来源；迁移完成后平台不再读取它，恢复检查点会明确排除该目录，避免外部遗留工具写入时破坏平台一致性快照。

运行状态目录保存平台管理的未完成任务状态和任务 Skill 快照，必须与数据目录一起备份。Bridge 创建的 Codex Session home 属于外部 CLI 的实时内部状态，不是平台恢复检查点的一致恢复源；检查点恢复后平台保留任务、Turn、审计和原始 transcript，并按 Task 当前最新的持久 Session 标识创建后续 Turn。

## 数据保留策略

任务执行数据和平台托管产物从 Task 明确完成归档时的 `archivedAt` 起保留 30 天。范围包括任务、Turn、Attempt、命令执行、工作日志、任务审计、Skill 报告、HTML/Fail 分析 artifact、HTML 独立托管的媒体子资源、Attempt 原始输出、交互式 CLI transcript、已托管后台日志和任务持有的 Runtime。运行中、失败、停止、等待输入、等待复核以及仍有后台执行或定时检查的 Task 不按创建时间或最后运行时间自动清理。

任务工作目录不参与并发互斥：多个 Task 和多个 pytest 允许在同一个目录同时执行。平台侧报告和媒体按 Task、报告、HTML artifact 分层隔离；业务测试写入原工作目录的日志、HTML、下载文件或临时文件仍必须使用每次运行唯一的名称或子目录，不能依赖固定文件名避免并发覆盖。

数据库备份和平台恢复检查点按各自配置的保留数量轮转，不复用任务数据的 30 天窗口。恢复介质在其生命周期内可能继续包含已经从在线存储清理的数据，因此访问控制和介质销毁必须覆盖整个备份保留周期。

## 分层备份策略

| 数据 | 策略 |
| --- | --- |
| SQLite、WAL、平台运行数据 | 使用平台现有在线数据库备份和恢复检查点；不把媒体目录混入数据库备份。 |
| 唯一媒体对象 | 使用外部按 SHA-256 内容寻址的增量备份；同一摘要只保留一份对象，清单保存原始路径和引用关系。 |
| 项目代码 | 使用 Git；生成的视频副本不进入代码备份。 |
| `videos/<run-id>` 临时目录 | 不进入长期备份，由独立 30 天清理任务处理；清理前先隔离 3 天。 |
| `standard_videos` 标准库 | 单独规划备份和保留周期，媒体清理任务永不处理。 |
| 平台已托管报告 | 使用平台从 `archivedAt` 起 30 天的保留策略；报告 artifact 资源不再被每个恢复检查点重复打包。 |

唯一媒体对象的增量备份必须在平台外部执行，并以对象摘要为幂等键；本仓库的清理脚本只负责临时 `videos` 目录的生命周期，不会伪装成媒体备份或删除标准库。

Worker 启动时及此后每小时执行一次保留检查，每批最多处理 50 个到期 Task。清理只在取得 `retention_cleanup` 平台维护租约后进行：任务文件先按创建代际原子改名暂存，SQLite 中该 Task、级联历史、任务审计和操作回执随后在事务内删除，提交成功后才清除暂存文件；Bridge Session record、Codex home、复制工作区、chatfile 和锁通过持久 `bridge_cleanup_jobs` 异步回收。文件暂存或事务失败会恢复原路径并保留任务；平台繁忙时延迟到下一轮。

## SQLite 数据

| 表 | 内容 |
| --- | --- |
| `tasks` | Session 配置、状态、租约和版本 |
| `turns` | 每次用户启动或继续产生的 Turn |
| `attempts` | Turn 的执行和重试记录 |
| `external_attempts` | PID/LOG/DONE/STATE/META、业务代次、观察和终态结果 |
| `scheduled_jobs` | 后续检查时间、完整上下文、generation、领取租约和派发命令 |
| `commands` | 幂等任务命令队列 |
| `command_executions` | 关联 Turn/Attempt 的完整命令、配置/执行端目录、输出、退出码和原始事件 |
| `command_skill_attributions` | 命令实际使用 Skill 的版本、哈希、运行时关联和追加式人工修正 |
| `skill_invocations` | `codex-skill-use` 自动记录的真实调用、冻结 Skill 身份、状态和退出结果 |
| `skill_reports` | Skill 发布的结构化业务报告、冻结归因、内容哈希和追加式修订 |
| `skill_report_artifacts` | HTML 和 Fail 分析报告等托管 artifact 的归属、摘要和文件元数据 |
| `skill_report_artifact_resources` | 每份 HTML 独立托管的媒体资源、清单依赖、摘要和文件元数据 |
| `skill_report_artifact_media_views` | 每份 pytest HTML 内按稳定媒体 key 共享的已查看状态；不记录查看人，随 artifact 级联删除 |
| `worklog_events` | 带任务连续序号的工作日志 |
| `audit_events` | 全局操作审计 |
| `bridge_cleanup_jobs` | Reset、普通删除、到期保留清理或手工回收 Runtime 时的 Bridge Session 资源回收、租约、重试和结果 |
| `skills` | Skill 目录和当前版本 |
| `skill_versions` | 平台 Skill 历史内容 |
| `skill_snapshots` | 任务冻结的 Skill 集合 |
| `skill_snapshot_entries` | 快照中的版本、来源和哈希 |

数据库启用 WAL、外键、忙等待和 `FULL` 同步模式。读后写操作使用 `IMMEDIATE` 事务，避免多进程快照写冲突；数据库、WAL、SHM 和日志在生产进程中使用仅服务账户可读写的权限。

Skill 报告按任务和 `reportKey` 维护追加式修订。立即重复发布相同内容返回已有修订；内容变化后再恢复为旧内容仍创建新修订，使 A -> B -> A 的业务时间线保持完整。每条修订冻结发布 Skill 的版本和内容哈希，并可关联当时的 Turn/Attempt。同一 Step Run 的后续修订会逐个复用声明及源文件 SHA-256 均未变化的 artifact，即使修订新增其他 artifact 也不重复复制原有媒体。任务确认完成后不能再发布；删除未归档任务时报告随任务级联删除，已完成任务则在 30 天窗口内作为只读历史保留。

`skill_reports`、`skill_report_artifacts` 和 `skill_report_artifact_resources` 属于在线数据库备份的新版表计数。报告正文只保存在 SQLite，不依赖 Attempt 日志或任务工作目录。External Attempt 登记路径及报告的 `registeredArtifacts` 只读投影会随数据库恢复，但运行中快照 URL 仍依赖原业务工作目录中的源文件；登记不会把源文件复制进备份，也不构成恢复保证。普通 Section 路径不会触发文件发现；平台只会在当前报告具备匹配 External Attempt/META 证据时补登记具体 pytest `--html` 输出。只有成功归档的 pytest HTML、Fail 分析 Markdown、超限时独立托管的日志文本及媒体子资源会复制到任务托管目录，登记大小和 SHA-256。由于这些报告已经由平台按 30 天策略托管，新的平台恢复检查点不再重复打包 `data/sessions/*/skill-report-artifacts`；恢复数据库中的历史报告若超过在线保留范围，按部分业务恢复处理。测试分析模式按原始证据保存摘要、主命令、指标、字段、JSON、HTML 和内嵌日志中的 AK、SK、Token、Authorization、Cookie、密码及其他凭据值；检测到这些内容不会触发脱敏或终止任务。`sensitivity` 只影响前端默认折叠，不代表脱敏或访问控制。报告、日志、备份和恢复包应按高敏感业务数据限制访问。

正常执行时，每个 Attempt 只启动一个交互式 `codex` / `codex resume` TUI，stdin/stdout/stderr 接入同一 PTY，并使用 inline 模式保留滚屏。PTY 原始字节先写入 Attempt stdout 和任务 transcript，再提供给实时终端；不经过 UTF-8 重编码、JSON 重组、摘要或截断，即使执行中断，已经写入的内容也保留。结构化审计不解析终端画面：runner 在隔离 `CODEX_HOME` 中记录启动前 rollout 大小，持续读取本次追加区间，以 `task_complete` / `turn_aborted` 作为 Turn 边界；TUI 结束后 Worker 再从同一区间恢复 Agent 回复和工具事件，并把命令输出写入 `command_executions.output`。Bridge 只负责创建/恢复会话和注入上下文。后台 pytest 的完整原始输出仍保留在 external attempt 登记的 `.log` 文件和“后台与调度”视图，不混入“Codex CLI”页签。旧版 `codex exec --json` Attempt 只在 UI 显示时做兼容格式化，原始文件保持不变。`latest.log` 只是每个 Turn 重置、最多 1 MiB 的事件尾部视图，不能替代 Attempt 原始输出。

External 终态后，Worker 把业务 `.log` 的原始字节复制到任务托管目录，并记录字节数和 SHA-256。托管副本每 24 小时限量复验，API 返回前也做完整校验；校验和响应读取共用同一个只读文件描述符，路径在两者之间被替换时不会流出替换内容。异常内容采用 fail-closed，不会作为日志证据流出。自动修复只允许使用仍匹配首次托管摘要的原业务 LOG，损坏副本保留在 `.quarantine/`。恢复检查点包含已成功托管的副本和隔离现场，但不能替代外部业务目录中尚未托管或修复失败的源证据。

原始 Attempt 和后台日志不设置破坏审计完整性的硬截断。平台因此在启动新任务前检查数据、运行状态和工作目录所在文件系统，默认要求至少同时保留 512 MiB 和 2% 可用空间。低于门槛时 readiness 降级，API 拒绝新执行，Worker 保留既有 `pending` 命令；正在运行的 Attempt 不会仅因告警被终止。若运行中仍发生写盘失败，runner 会把审计标记为不完整并使 Attempt 失败，已成功写入的原始字节继续保留。

Codex 主进程退出后，runner 最多等待 2 秒排空 PTY。若后代进程错误地继续持有 PTY，runner 会记录“审计输出不完整”，把原本成功的退出改为 `74` 并结束 Attempt，避免 Session 永久卡住。超时前已经落盘的终端字节仍然保留；该 Attempt 不能视为完整审计成功，必须结合工作日志和原始流检查原因。

## 状态与恢复

普通成功 Turn 进入 `waiting_review`，不会写入归档时间。Turn 启动了未结束后台执行时进入 `waiting_scheduled`：Codex 进程和 Worker 槽位已释放，但逻辑任务仍未结束。后台终态检查完成后才进入 `waiting_review`，用户确认后转为 `completed`。

每个托管 Attempt 结束时都会封存对应 PTY transcript；显式重连产生的交互 CLI 也写入同一任务归档。确认完成时，平台先终止仍在运行的显式交互 CLI，再封存遗留原件并复验全部 transcript，最后把任务标记为 `completed` 并写入 `archivedAt`。完成当下不会创建 `bridge_cleanup_jobs`；当前最新 Bridge Session 的 record、Codex home、复制工作区、chatfile 和锁在 30 天窗口内继续保留，以便操作者显式恢复该 Session。到期清理后历史和该 Session 都不可恢复。归档页面读取 transcript 时不访问该 Runtime，也不会启动或重连 Codex。

Reset 只允许非活动且没有后台执行、定时检查或运行时所有权的 Task。事务保留 Task 配置、ID、Skill 快照、Turn、Attempt、命令、工作日志、审计和全部 transcript，清空结果摘要、运行时间和当前 `persistentSessionKey`，并把旧 key 写入 `bridge_cleanup_jobs`；下一次 Run 再生成新的随机 key。Run、服务恢复、归档 Restore 和交互式 CLI 始终读取 Task 当前 key，恢复检查也只匹配该 key 的回收状态，因此旧 Session 的已完成或失败回收作业不会把恢复指向旧上下文，也不会阻断最新 Session。

Reset、删除未归档任务或手工回收已完成 Runtime 时，平台在 SQLite 事务中写入 `bridge_cleanup_jobs`。提交后 Worker 才回收对应 Bridge Session record、Codex home、复制工作区、chatfile 和锁；Reset 和手工回收不删除 Task 历史，但原 Session 此后不能恢复。回收不跨 SQLite 事务，Worker 中断后由 30 秒租约和指数退避继续；任务 ID 后续复用或同一 Task 建立新 Session 时，旧作业仍绑定原 `created_at` 和精确 Session key，不会删除最新资源。记录重复、损坏、字段不符、路径越界或符号链接时一律停止删除并保留现场，等待修复后重试。

升级前遗留的 Bridge Session 通过只读库存接口分类，不在启动、同步、备份或恢复流程中自动删除。库存只公开稳定 Session ID、资源存在性和估算字节，不公开 Session key 或主机路径。手工回收必须提供与 URL 相同的精确 Session ID，且事务重新确认记录仍为无任务引用的 `orphan` 或仅由一个 `completed` 任务代际引用的 `completed_retained`。请求只持久化 `bridge_cleanup_jobs`，实际删除仍由 Worker 重验并执行；重复请求复用同一作业。对 `completed_retained` 的回收不级联平台任务，因此 SQLite 中的任务历史、Turn、工作日志、Agent 回复、命令、Attempt 原始输出与交互式 CLI transcript 继续受备份和恢复流程保护。

Worker 为活动任务持有 15 秒租约，每 2 秒续期。Worker 心跳同时保存自身 PID、`/proc` 启动时钟、父进程、Session 和进程组。Web 读取心跳时会重新核验进程身份及父子关系；新鲜时间戳本身不足以证明 Worker 存活。活动执行的 Task/Attempt 身份还会在 readiness 查询时与 `/proc` 实时对照，失联会立即暴露，持久状态仍由租约到期恢复流程事务化收尾。

Worker 异常后：

- 租约过期任务转为 `interrupted`。
- `autoResume=true` 的任务重新入队。
- Task 当前最新的持久 Session 标识、工作目录和 Skill 快照保持不变。
- 新 Turn 和 Attempt 继续追加，不覆盖历史。
- 自动恢复达到 `maxRetries` 后停止排队，状态保留为 `interrupted`，恢复说明为 `retry_exhausted`。
- 停止请求期间发生 Worker 中断时，恢复流程会写入 `session.stopped` 终态事件，不丢失操作时间线。
- Worker 因未捕获异常执行强制退出时，先把内存中的活动执行标记为关机中断，再终止执行组；Turn、Attempt 和任务落为 `interrupted`，不会因 `SIGKILL` 的退出结果误记为普通失败。新 Worker 启动后沿用同一持久 Session 创建恢复 Turn。
- 定时检查使用独立 15 秒租约；派发前中断会重新领取，派发后的 Codex Turn 中断会关闭旧 Attempt 并把原检查重新排队。
- Turn 收尾先在事务内验证 Task、命令、Turn、Attempt 和 Worker 租约，再执行后台输出检测与状态对账；旧 Worker 的延迟回调即使携带合法 PID/LOG，也不能在租约恢复后写入后台记录或调度任务。
- 定时检查从 `dispatched` 到真正创建 Turn 之间发生启动失败时，失败命令会保留，调度记录清除旧 `command_id` 后退回 `pending`，任务释放租约并回到 `waiting_scheduled`。达到调度重试上限后，调度标记 `failed`、外部执行标记 `lost`，并保存最后命令、错误和重试次数，避免后台状态永久悬空。
- 启动恢复和 5 秒周期恢复会事务化扫描 `waiting_scheduled`。每个 running External 如果没有同 generation 的 `pending/leased/dispatched` 作业，平台立即创建一条新的持久检查并记录 `schedule.recovered`；同一规则重复运行不会创建重复作业。任务已经没有活动 External 和调度时转为 `waiting_review` 并记录 `tracking_state_recovered`。
- 每次检查恢复原 `persistentSessionKey`，但创建新的 Turn 和 Attempt，不覆盖之前的 PID、日志或观察记录。
- 活动 `external_attempts` 或 `scheduled_jobs` 会阻止归档。停止任务会将其标记为取消，防止重启后再次派发。

后台业务结果读取顺序为 `.done`、`.state`、`.meta`，META 支持 JSON 和官方后台脚本使用的 `key=value`。终态文件不能覆盖仍存活的受管运行时：平台使用 cgroup 路径/inode 和 PID 启动时钟、Session、进程组联合校验所有权；只要其中仍有进程或线程，External 与 Task 就保持活动状态。裸 PID 不参与该不变量，因为操作系统可能复用 PID。

每条后台记录保存来源命令或 Attempt 的开始时间作为证据下界。运行中先登记 PID/LOG 时可以暂用 Attempt 起点，Turn 收尾识别到真实启动命令后会收紧到命令起点；数据库启动检查会对已有来源关联执行同样修复。修改时间早于该下界的 DONE/STATE/META 属于旧 generation，平台会把文件名写入 `result.ignoredStaleArtifacts`，但不会据此结束当前执行。Step Run 与 chain 一一归属，同一 Step Run 同时只允许一个活动 generation；技术 Retry 在前一代终态后复用 `step_run_id` 和 chain 并增加 generation。业务 Rerun 则在原 Step 下创建新的 Step Run，不创建子 Task，也不与技术 Retry 混用。

停止任务先结束该任务由平台启动的显式交互 CLI，封存并复验 transcript，然后使用取消标记通知持有租约的 Worker。平台不根据模糊进程名称直接终止未知进程。

每次新建任务都记录新的创建代际。持久 Session 标识包含随机 UUID，因此删除未完成任务后即使复用相同 ID，也不会继续旧 Session。Worker 启动的本地门控器在收到监管 ACK 前不会执行 Bridge runner；Attempt 和 Task 会先事务化保存 PID、Linux `/proc` 启动时钟和进程组，监管进程再校验门控器确实是当前 Worker 的 Session/进程组 leader。Worker 在 ACK 前死亡时，门控器通过父进程死亡信号或 stdin EOF 退出；ACK 后死亡时由监管进程终止已登记执行组。

监管和普通收尾都不会只凭数据库旧 PID 强杀进程：进程 leader 存在时必须匹配启动时钟、Session ID 和进程组；leader 已退出但仍有同 Session/组的后代时才清理残留组。Attempt 正常关闭时先发送 `SIGTERM`，短暂等待后用 `SIGKILL`，避免普通子进程继续改写工作目录。按 `run-in-background` 规范启动的业务任务使用 `setsid` 创建独立 Session/进程组，因此不受上述清理影响，后续由 `external_attempts`、状态文件和持久调度继续跟踪。

真实 Session 启动会在一个事务中创建 Turn、首个 Attempt 并切换任务运行态，因此外部一旦看到 `running/recovering` 就一定存在可审计 Attempt。瞬时故障退避前也先创建下一 Attempt，保证整个活动期恰好存在一个 running Attempt；退避期间停止会把这个尚未放行的 Attempt 记为 `cancelled`。随后如果首条工作日志、Skill 挂载日志、Attempt 审计文件、进程身份登记或监管 ACK 失败，Worker 会立即移除对应内存执行槽并关闭门控器；命令失败事务关闭 Turn/Attempt、释放任务租约并记录失败。该路径不依赖 15 秒租约回收，停止请求也不能插入 Turn 与首个 Attempt 之间造成时间线缺口。

## Skill 快照

任务首轮执行时生成不可变快照，包含 Skill ID、来源、版本、内容和 SHA-256 哈希。快照写入运行状态目录，并在数据库中记录相同清单。

恢复和后续 Turn 使用原快照。升级平台 Skill 只影响尚未创建快照的新任务。每次物化都会核对清单、文件集合和 SHA-256；目录被篡改、文件缺失或出现额外文件时，从 SQLite 冻结内容原子重建。快照目录和文件分别使用只读执行权限 `0500`、`0400`。

命令 Skill 归因引用快照中的版本和哈希，但独立保存在 `command_skill_attributions`。每次运行时声明或人工修正都追加新行，不覆盖旧行；当前有效值按命令与 Skill 的最后一条 `linked/unlinked` 记录计算。删除未归档任务时归因随命令级联删除；已完成历史不能删除，但允许追加有原因、有操作者的归因修正。

`skill_invocations` 由 `codex-skill-use` 在本地调用边界自动写入，不等待 Agent 生成结构化报告。后台执行保存 invocation 关联，定时调度通过后台执行继承；记录随 Task 一起进入数据库备份、恢复检查点和 30 天归档保留生命周期。

## 旧数据迁移

首次打开数据库时执行一次迁移：

数据库结构创建、列升级和结构内数据回填在一个 SQLite `IMMEDIATE` 事务中完成；任一步骤失败会整体回滚，修复环境后再次启动会重新执行完整结构迁移，不会使用半初始化连接。
数据目录必须是普通私有目录；主数据库及已有 WAL、SHM、rollback journal 必须是普通文件，符号链接或其他文件类型会在 SQLite 打开前被拒绝。每次建立新数据库连接时，平台会把主数据目录内已有的普通目录和普通文件分别收紧为 `0700` 和 `0600`，但跳过且不跟随符号链接，也不删除迁移源。Session、Attempt 输出、Bridge 结果和 Skill 快照路径会逐级验证为真实目录；托管日志和结果文件使用 `O_NOFOLLOW` 描述符读写。存储预检发生在创建 Turn 前，路径异常不会留下孤立的运行中 Attempt。

Bridge runtime 同样在同步时递归收紧：普通目录为 `0700`，普通文件移除 group/other 权限并保留 owner 执行位；符号链接和特殊文件不会被跟随。此迁移只作用于平台配置的 Bridge runtime/chatfile 根，不修改 Bridge 源码仓库。

- `data/sessions/*/session.json` 迁移到 `tasks`。
- `worklog.ndjson` 迁移到 `worklog_events`。
- `data/audit.ndjson` 迁移到 `audit_events`。
- `data/skills` 迁移为平台 Skill 版本 1。
- 旧 `finished` 映射为 `completed`。
- 旧 `running` 映射为 `interrupted`，避免升级时重复执行。
- 旧 Agent、编排、Run 和模型事件不迁移。

迁移完成时间写入 `metadata`，后续启动不会重复导入。确认备份有效前不要删除旧文件。

## 在线数据库备份

平台默认每 24 小时调用 SQLite backup API 创建事务一致快照并只保留最新 1 份。可通过 `CODEX_DESK_BACKUP_DIR`、`CODEX_DB_BACKUP_INTERVAL_HOURS` 和 `CODEX_DB_BACKUP_RETENTION` 调整；间隔设为 `0` 只关闭自动调度，手动 API 仍可使用。

生成流程如下：

1. 检查备份文件系统在写入一个估算快照后仍满足容量门槛。
2. 在备份目录创建 `0700` 临时包，通过活动连接的 SQLite backup API 复制主库，包含当前 WAL 中已提交的数据。
3. 对临时 `database.db` 执行 `quick_check`、`foreign_key_check`、核心表计数和 SHA-256 校验。
4. 以 `0600` 写入数据库和 `manifest.json`，同步文件与临时目录。
5. 原子重命名整个目录发布，再同步父目录。
6. 只有发布成功后才删除超出保留数的最旧有效包。

手动操作：

```bash
node "${CODEX_HOME:-$HOME/.codex}/skills/codex-task-platform-api/scripts/codex_task_api.js" backup create
node "${CODEX_HOME:-$HOME/.codex}/skills/codex-task-platform-api/scripts/codex_task_api.js" backup list
node "${CODEX_HOME:-$HOME/.codex}/skills/codex-task-platform-api/scripts/codex_task_api.js" backup verify BACKUP_ID
```

API 不返回备份主机路径。复验同时检查包内只能包含数据库和清单、目录/文件权限、大小、SHA-256、SQLite 完整性、外键和表计数；SQLite 检查在私有临时副本上执行，不修改待验包。v1 读取器兼容早期已发布清单中后来新增的可选计数缺省情况，但始终要求最初发布的 10 个核心表计数、拒绝未知计数键，并逐项复验清单实际声明的所有计数；新生成的包仍声明完整当前计数。`ok=false` 的包不能用于恢复；复验失败会保留现场并写入审计。

在线数据库备份不包含 `data/sessions` 下的 Attempt 原始输出和后台日志，也不包含 `CODEX_DESK_RUNTIME_DIR` 的原生 Session 状态、Skill 快照或任务工作文件。它只能作为数据库级恢复源，不能证明完整业务恢复能力。

## 平台恢复检查点

平台恢复检查点用于保存可共同恢复的平台数据库、`CODEX_DESK_DATA_DIR` 附属文件和 `CODEX_DESK_RUNTIME_DIR`。默认每 24 小时自动创建并只保留最新 1 份，可分别通过 `CODEX_RECOVERY_CHECKPOINT_INTERVAL_HOURS=0..8760` 和 `CODEX_RECOVERY_CHECKPOINT_RETENTION=1..30` 调整；间隔设为 `0` 只关闭自动调度。它不替代每日数据库备份，在平台升级、Skill 批量变更或其他受控维护窗口仍可显式创建：

```bash
node "${CODEX_HOME:-$HOME/.codex}/skills/codex-task-platform-api/scripts/codex_task_api.js" recovery create
node "${CODEX_HOME:-$HOME/.codex}/skills/codex-task-platform-api/scripts/codex_task_api.js" recovery list
node "${CODEX_HOME:-$HOME/.codex}/skills/codex-task-platform-api/scripts/codex_task_api.js" recovery verify RECOVERY_ID
```

创建流程如下：

1. 在 SQLite 中取得带过期时间的持久维护租约，并在同一事务中确认活动 Task、Attempt、Command、Schedule、External 和已认领 Bridge cleanup 数量都为 0。
2. 维护期间新写入 API 返回 `503` 和 `Retry-After`；已提交的 Run、原子创建、停止、完成、恢复、重置和删除幂等键仍可读取原结果，但未命中的新键在任何写入前失败。任务配置、Skill 管理、配置导入、命令 Skill 归因、命令领取、到期调度领取和调度派发均在写事务内复查租约。Skill 查询继续返回已持久化快照，但不会在维护窗口内刷新来源。readiness 标记 `platform_maintenance`，进程异常退出后租约会在 `expiresAt` 自动失效。
3. 通过在线 backup API 创建已验证数据库，再复制到检查点并删除仅用于创建过程的 `platform_maintenance` 元数据，避免恢复后继承伪活动租约。
4. 清点并归档数据和 runtime。实时 SQLite/WAL/SHM、备份目录递归、Bridge Session lock、整个 Bridge Codex Session home（含 rollout、SQLite/WAL/SHM、tmp 和 CLI 内部配置）、符号链接、特殊文件和平台暂存目录不会进入归档。Bridge home 不受平台维护租约控制，不能与平台数据库一起构成可验证的一致快照。
5. 归档完成后逐项复核源文件的设备、inode、模式、大小、mtime 和 ctime 纳秒指纹；变化即放弃临时包。
6. 核对数据库完整性、外键、表计数、维护租约清理、归档路径/类型/数量/总字节、归档清单摘要和两个文件的 SHA-256。
7. `fsync` 后以目录重命名原子发布。只有发布成功才轮转旧有效包；失败不会删除最后一份有效包。

恢复检查点沿用 v1 清单的兼容规则：早期发布包可以缺少后来新增的数据库表计数或源排除计数，但必须保留最初发布的 10 个核心表计数和排除计数基线，不能出现未知键。复验逐项核对清单实际声明的全部计数，且不会放宽目录布局、私有权限、文件摘要、SQLite 完整性、维护租约清理或归档库存校验；新创建的检查点始终写入完整当前计数。

自动调度使用最近有效检查点的 `completedAt` 计算下一次到期时间，服务重启后不会从零计时或立即复制一份新包。手工成功创建数据库备份或恢复检查点时，对应调度器立即取消旧 timer 并按最新 `completedAt` 重排。没有有效检查点时，服务启动后会尽快尝试创建。到期时存在活动 Task、Attempt、Command、Schedule、External、已认领 Bridge cleanup，或数据库备份、其他检查点、平台维护正在进行时，本次标记为 deferred，15 分钟后重试；这不属于备份失败。其他错误同样在 15 分钟后重试，但会记录 `recovery.checkpoint.failed`。健康接口的 `recoveryCheckpoints.overdue`、`lastDeferredAt`、`lastDeferredReason` 和 `nextRunAt` 用于判断恢复点目标是否已超期及何时重试。

原子发布是创建成功边界。发布后的维护租约释放异常不会把有效包改报为失败；操作结果会标记 `maintenanceReleaseUnconfirmed`，记录告警审计，并保留租约最晚失效时间。该场景下先复验检查点，再等待 `runtime.maintenance.active=false`；不要按旧 owner 或直接改 SQLite 清理租约。

包发布与审计持久化也是两个结果。源数据库备份、恢复检查点及清理告警组成一个原子审计批次；任一 INSERT 失败时整批回滚，API 仍以 `201` 返回已发布包并设置 `auditRecorded=false`。待写批次先进入数据目录中的 `storage-audit-outbox.json`，服务启动、每 30 秒及下一次复验等同类审计都会使用稳定事件 ID 幂等补写。outbox 属于平台数据文件，会进入平台恢复检查点；恢复包本身仍是核心操作的事实来源，不能因审计暂时失败重新创建第二份包。

检查点目录位于 `CODEX_DESK_BACKUP_DIR/recovery-checkpoints/<recovery-id>/`，只含 `database.db`、`payload.tar.gz` 和 `manifest.json`。目录和文件分别固定为 `0700`、`0600`。API 只返回固定字段的校验摘要、计数和覆盖声明，不返回主机路径、归档目录项、文件内容或下载地址。

`payload.tar.gz` 内的 `data/` 和 `runtime/` 是逻辑恢复根。它包含 Attempt 原始 stdout/stderr、交互式 CLI transcript、已成功托管到 `data/sessions/<task>/external-attempt-output/` 的终态后台原始日志、原生 Codex rollout、Skill 快照以及 Session 级 `auth.json`。`auth.json` 可能含 `OPENAI_API_KEY`，整个检查点必须按高敏感凭据介质存储、传输和授权。SHA-256 只能发现非预期变化，不提供对拥有目录写权限主体的防篡改认证。

覆盖边界是固定且可机读的：

- `sqliteDatabase=true`、`platformDataFiles=true`、`platformRuntimeFiles=true`。
- `taskWorkingDirectories=false`：不包含 `CODEX_TASK_WORKSPACE_ROOTS` 下的平台外任务工作目录；运行中 `registeredArtifacts` 的可打开源文件也不在覆盖范围内。
- `externallyLocatedLogs=false`：不包含仍在 data/runtime 之外的活动日志、尚未归档或归档失败的 pytest 报告和其他业务产物；已经成功托管的终态 LOG 和运行证据在 `platformDataFiles` 内，但已托管报告 artifact 资源按 30 天在线保留，不重复进入恢复包。

因此它应称为“平台恢复检查点”，不能称为“全业务恢复包”。外部工作产物需要独立备份，并记录与检查点接近的时间和版本。

### 离线恢复平台检查点

1. 在源实例调用 `recovery verify`，必须得到 `ok=true`；记录 ID、数据库 SHA-256 和归档 SHA-256。
2. 将整个检查点目录复制到目标数据目录之外的受保护位置。默认检查点位于源数据目录内，不能一边删除目标数据目录一边从其中恢复。
3. 停止目标 Web 和 Worker，确认两类进程及其受监管执行进程均已退出。不得向运行中的 SQLite 或 runtime 覆盖文件。
4. 备份目标当前数据目录、runtime 和外部工作产物，作为回退点。
5. 在空的私有暂存目录解包 `payload.tar.gz`，确认只出现 `data/` 和 `runtime/` 普通文件/目录；不要以 root 对未经平台复验的包直接覆盖系统路径。
6. 将暂存的 `data/` 和 `runtime/` 分别作为新的目标 `CODEX_DESK_DATA_DIR` 和 `CODEX_DESK_RUNTIME_DIR`。把包内 `database.db` 放到新数据目录的 `codex-tasks.db`，设置服务账户和 `0600`，确认不存在旧 `codex-tasks.db-wal`、`-shm` 或 `-journal`。
7. 从独立备份恢复任务工作目录和平台外日志/报告，并恢复相同的 `CODEX_TASK_WORKSPACE_ROOTS` 配置。缺少外部产物时必须把恢复结果标记为部分业务恢复。
8. 恢复正确属主和最小权限后启动服务，检查 `/api/health` 的 `storage.quickCheck=ok`、外键违规为 0、`state.ok=true`，并确认 `runtime.maintenance.active=false`。
9. 抽查任务、Turn、Attempt 原始 stdout/stderr、完整 Agent 回复、命令输出、工作日志、审计、Skill 快照和原生 Session resume。对历史外部日志路径逐项确认存在性。
10. 先用非生产任务验证执行和恢复，再决定是否恢复 `interrupted` 或 `waiting_scheduled` 任务；不要根据旧 PID 操作进程。

## 数据库级恢复

1. 在源实例通过 `POST /api/backups/:id/verify` 确认 `ok=true`。
2. 停止目标 Web 和 Worker，并确认进程已经退出。
3. 备份目标环境当前数据目录和运行状态目录，避免覆盖后无法回退。
4. 将备份包中的 `database.db` 复制到数据目录的临时文件，设置为服务账户和 `0600`。
5. 删除目标旧 `codex-tasks.db-wal`、`codex-tasks.db-shm`，再把临时数据库原子重命名为 `codex-tasks.db`。
6. 启动服务，确认 `/api/health` 的 `storage.quickCheck=ok`、外键违规为 0、`state.ok=true`。
7. 抽查表计数、任务、Turn、Attempt、命令和审计；缺少对应文件目录时明确记录为部分恢复。

不要在服务运行时覆盖主数据库，也不要把备份包内验证连接可能产生的临时 WAL/SHM 当作恢复输入。

## 紧急离线备份

日常备份使用在线数据库备份和平台恢复检查点，不需要定期复制整个数据目录。只有在迁移或灾备演练等受控窗口，才执行一次离线副本：

1. 停止或完成所有活动任务，并停止 Web 服务和 Worker。
2. 复制 SQLite 主库、WAL/SHM（若存在）、平台运行状态和原始日志；排除 `sessions/*/skill-report-artifacts`，避免重复保存已托管报告。
3. 不复制 `CODEX_TASK_WORKSPACE_ROOTS` 下的项目工作目录和 `videos/<run-id>`；项目代码由 Git、唯一媒体对象由 SHA-256 增量备份、`standard_videos` 由独立备份负责。
4. 记录应用版本和非敏感环境配置，启动服务并执行健康检查。

页面导出不包含这些数据，不能替代在线数据库备份、恢复检查点或外部媒体备份。

## 完整恢复

1. 停止目标服务。
2. 保留目标环境现有目录的副本。
3. 恢复同一时间点的数据目录和运行状态目录。
4. 恢复相同工作目录路径和白名单配置。
5. 确认服务用户有读写权限。
6. 启动后检查 `/api/health`。
7. 抽查任务、Turn、Attempt stdout/stderr、工作日志、审计和 Skill 快照。
8. 对 `interrupted` 任务检查最后结果后再恢复。

如果旧版缓冲 runner 在任务中断时未把已产生的 Codex 事件写入 SQLite，但对应原生 rollout 仍存在，可离线回填：

```bash
node bin/recover-codex-rollout.js \
  --task TASK_ID \
  --turn TURN_ID \
  --attempt ATTEMPT_ID \
  --rollout /absolute/path/to/rollout.jsonl \
  --working-dir /absolute/runtime/cwd
```

工具只恢复 rollout 中 Assistant 输出与工具调用/输出，忽略系统提示、用户提示和 BridgeContext。可用 `--offset BYTE_OFFSET` 只恢复从完整 JSONL 记录边界开始的追加区间；正常托管执行会自动提供该偏移。每条恢复记录使用确定性 ID，重复执行不会重复写入；完成后追加 `runtime.rollout.recovered` 工作日志和 `session.rollout.recovered` 操作审计。

SQLite 文件不应放在跨主机共享文件系统上。多节点部署需要迁移到支持分布式并发的数据库。

删除和 `replace` 导入会先把任务文件移动到带任务代际的暂存目录。若进程在数据库事务前后异常退出，下次启动会以任务创建代际为准恢复同一任务的文件，或清理已经属于旧任务的文件，避免旧日志串入同 ID 新任务。
