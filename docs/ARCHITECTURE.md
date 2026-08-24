# 架构设计

## 目标

平台以 Task 作为稳定生命周期对象，并在 Task 上保存当前最新的持久 Session 指针。Session 可以包含多个 Turn；Reset 会保留 Task 配置、ID 和历史，但清除当前指针并让下一次运行建立新 Session。New 则创建完全独立的 Task。

```text
systemd / Host Launcher
          |
    Web Supervisor
          |
 中文/英文 Web UI + HTTP API
          |
  SQLite WAL + 命令队列
          |-- 持久化调度队列
          |
    Session Worker
          |
  持久 Session 执行适配器
```

执行适配器由部署环境提供。平台只依赖其外部执行结果，不配置 Agent、模型或底层认证信息。

## 组件职责

| 组件 | 职责 |
| --- | --- |
| Host Launcher | 无 systemd 时监管并退避重启 Web Supervisor；持有有限轮转诊断日志；向 Web 传递可核验身份；重复实例立即拒绝 |
| Web Supervisor | 独占运行锁、Web 进程身份传递、异常退出退避重启和残留进程组清理 |
| Web UI | 任务、结果确认、日志、审计、Skill 和中英文切换 |
| HTTP API | 参数校验、状态约束、幂等命令、目录白名单和访问控制 |
| SQLite | 任务、Turn、Attempt、外部执行、定时检查、命令执行、租约、Skill、日志和审计事务 |
| Worker | 命令和到期检查领取、租约心跳、Session 执行、重试、停止和恢复 |
| 文件存储 | 原始日志、持久运行状态、不可变 Skill 快照、原子数据库备份包和平台恢复检查点 |

Web 控制面不依赖执行适配器启动。执行能力不可用时，页面和健康接口仍可访问，启动任务返回 `503`。

## 固定设计决策

- 任务执行数据和平台托管产物从 Task 明确完成归档时的 `archivedAt` 起保留 30 天。运行中、失败、停止、等待输入、等待复核或等待后台结果的 Task 不因创建时间或最后运行时间超过 30 天而自动清理。数据库备份和平台恢复检查点继续使用各自的数量保留配置，不与任务数据保留窗口混用。
- 不同 Task 之间不按工作目录互斥。同一规范化工作目录中的多个 Task 允许并行执行，这是有意支持的行为；平台只保证单个 Task 的租约和状态一致性，不负责串行化目录内的文件访问。调用方应确保并行命令、输出路径和外部工具能够安全共享该目录。
- Worker 启动时及此后每小时检查一次到期数据，每批最多清理 50 个 Task。清理先取得 `retention_cleanup` 平台维护租约，再按任务代际暂存托管文件、删除 SQLite 任务数据和任务审计，并把 Bridge Runtime 转入持久回收队列；任一步失败都会保留原任务和文件并在健康状态中记录失败。平台繁忙时本轮延迟，不会中断活动任务来满足清理时间。

## 不变量

- 一个任务任一时刻只能绑定一个当前 Session 标识。Reset 原子清除旧标识并把旧 Runtime 转入回收队列，下一次运行生成带随机 UUID 的新标识；删除后重新创建同 ID Task 也不能接入旧 Session。
- Run、服务中断恢复、归档 Restore 和交互式 CLI 都只读取 Task 当前的 Session 标识；旧 Session 回收记录按其自身 key 隔离，不能阻止或替代最新 Session 的恢复。
- 一个任务同时只能有一个有效 Worker 租约。
- 一次成功执行只完成一个 Turn，不自动完成整个任务。
- Codex Turn 结束后可以释放执行进程，同时让逻辑任务停留在 `waiting_scheduled`。
- 有 `running` 外部执行或 `pending/leased/dispatched` 定时检查时，任务不能完成或归档。
- 只有 `waiting_review` 或 `waiting_input` 可以显式转为 `completed`。
- `completed` 是不可直接运行、编辑或删除的只读归档态；显式 Restore 可转回 `waiting_input` 并继续最新 Session，显式 Reset 可保留 Task 历史但放弃该 Session 并回到 `idle`。
- 完成会终止交互式 CLI、封存并校验 transcript，但保留 Bridge Runtime；Task 删除、Reset 或手工回收会释放对应原生运行资源。
- Task 的 Skill 快照在首轮执行时冻结，恢复、Reset 后的新 Session 和后续 Turn 都使用同一快照；需要最新 Skill 集合时创建 New Task。
- Skill 驱动的命令通过 `codex-skill-use` 显式声明一个或多个快照 Skill；平台不按命令关键字推断。
- 命令 Skill 归因采用追加事件模型。运行时声明和人工 `linked/unlinked` 修正全部保留，当前值由每个命令与 Skill 的最后一条事件决定。
- 工作目录必须在允许根目录内，并与平台源码、数据和运行状态隔离。
- 所有执行事件同时写入任务工作日志和全局审计。
- 命令执行明细与工作日志在同一事务中写入，并关联 Session、Turn 和 Attempt。
- 配置工作目录与执行端实际上报目录分列保存；执行端未上报时不推测实际目录。
- 任务指令、命令、输出和原始运行事件按执行端原文存储，不做字段级脱敏。

## 状态机

```text
idle -> queued -> running -> waiting_review -> completed
                    |              |
                    |              `-> queued -> running
                    |-> waiting_scheduled -> queued -> running
                    |-> failed ----------> queued
                    |-> stopped ---------> queued
                    `-> interrupted -----> queued

completed --restore--> waiting_input
inactive  --reset----> idle
```

`recovering` 表示恢复或自动重试正在执行，`stopping` 表示停止请求已发出。`waiting_scheduled` 表示 Codex 和 Worker 槽位已经释放，但外部业务进程仍在运行或存在后续检查。Restore 继续 Task 当前最新 Session；Reset 只允许在 Task 非活动且没有后台执行、定时检查或运行时所有权时执行，清空当前上下文后由下一次 Run 建立新 Session。服务重启后，普通过期租约任务转为 `interrupted`；定时检查的过期租约重新进入持久化调度队列。

## 后台执行与定时检查

- 新业务执行使用 `Task -> task_steps -> step_runs -> external_attempts` 层级。Step 表示 `normal`、`long` 等稳定业务范围；首轮和 Rerun 是同 Step 下不同 Run；技术 Retry 复用 Run，只增加 External Attempt generation。`skill_reports.step_run_id` 由 `executionEvidence.externalAttemptId` 推导，报告 revision 不允许跨 Run。
- `run-in-background` 命令返回 `PID/LOG/DONE/STATE/META` 后，Codex 用 `codex-background-track register` 显式登记 Step/Run 身份，并用可重复的 `--artifact` 同步登记已知 HTML 输出。运行中 Skill Report 通过 External Attempt 身份取得不含源路径的 `registeredArtifacts` 投影；Web 只按 task、attempt 和 artifact key 打开同一只读文件描述符，并把响应限制为打开瞬间的字节长度。不同 Step 允许在同一工作目录并行；各 Run 的可变输出必须使用唯一名字或子目录。Worker 每秒轻量核对 DONE/STATE/META，`stop` 前再同步核对一次；终态会自动发布兜底修订并通过持久化任务归档 HTML。服务获得 cgroup v2 delegation 时，平台默认从 `/proc/self/cgroup` 定位其委派根；也可用 `CODEX_TASK_CGROUP_ROOT` 显式指定。登记会把身份已校验的独立后台进程组迁入该任务的专属 cgroup，并保存受限路径和 cgroup inode。
- 运行中 artifact URL 是源文件的临时观察通道：要求登记 key 精确匹配、任务归属正确、路径没有符号链接且文件为普通文件，响应使用 `private, no-store` 和 HTML sandbox。它不生成摘要，也不进入恢复检查点。终态归档完成后，同一 UI 条目切换到 `skill_report_artifacts` 的托管 URL；该路径使用字节数和 SHA-256 完整性校验，并可拥有隔离的日志与媒体资源。
- `.done`、`.state` 和 `.meta` 提供业务终态，但不能覆盖仍存活的受管运行时。只要保存的 cgroup 路径/inode 中仍有进程或线程，或 PID 启动时钟、Session 和进程组身份仍匹配，External 保持 `running`，Task 保持后台运行态；裸 PID 不作为身份依据。
- 每条外部执行按 `chain_key + generation` 隔离；Step Run 与 chain 一一归属，同一 chain 同时只允许一个活动 generation，避免跨 Run 混用 chain 或两代进程共用 LOG/DONE/STATE/META。前一代终态后可创建新 generation，旧 generation 的未派发回调失效。
- 后台证据起点先取 Attempt 的开始时间；自动识别真实启动命令后收紧到该命令的开始时间，服务启动时也会修复已有来源关联。DONE/STATE/META 的修改时间早于该起点时记入 `ignoredStaleArtifacts` 并忽略，防止固定路径重用后旧终态误归属新任务。同一活动记录只能绑定一条启动命令。
- META 同时支持 JSON 和官方 `run-in-background` 的 `key=value` 格式，后者的 `ended_at`、`exit_code` 和 `end_signal` 可直接恢复终态。
- 每次到期检查从 `scheduled_jobs` 领取，恢复同一持久 Session，并创建新 Turn 和 Attempt。检查结束后 Codex 进程再次释放。
- 后台任务仍运行时，平台追加观察并创建下一条一次性检查；只有业务终态证据已出现且受管 cgroup/进程组都为空时才停止续排，结果收集完成后任务进入 `waiting_review`。若启动 Turn 收尾时已经观察到 External 终态，平台保留并立即到期首次结果收集作业，使快速失败仍能执行失败分析和结构化报告发布。
- External 进入终态后，独立归档租约把原始 LOG 按字节托管到 `data/sessions/<task>/external-attempt-output/`。复制前后校验设备、inode、大小、mtime、ctime 和链接数，拒绝符号链接；临时文件 `fsync` 并原子发布后，SQLite 保存字节数、SHA-256、时间和错误状态。旧终态记录由 Worker 每轮一条渐进回填，不在服务启动路径执行无界 I/O。
- 托管日志按 24 小时周期由独立租约渐进复验，API 读取前也执行完整字节数和 SHA-256 校验。API 的哈希计算、inode/路径指纹确认和响应流共用一个 `O_NOFOLLOW` 只读文件描述符，消除校验完成后按路径重开被替换文件的竞态。校验失败采用 fail-closed：不返回可疑日志，Health/Ready 降级并保留工作日志和审计证据。同一记录的归档和校验异常在健康统计中只计一次。
- HTTP 请求中断会传播到托管日志哈希循环和所有文件响应流。哈希每处理 1 MiB 检查取消信号，流阶段监听响应关闭并销毁源流；中断只释放请求资源，不会被误记为归档完整性故障。
- 普通 API 使用 Web 进程内有界响应槽，从路由进入保持到处理函数结束且响应完成或连接关闭；请求体按收到字节刷新空闲计时，纯服务器计算阶段不计时，响应开始后由 socket 网络活动续期。客户端在长操作中途断开只结束响应侧，槽位仍保持到内部操作完成，避免断线绕过并发上限。容量耗尽立即返回带 `Retry-After` 的 `429`，不排队、不执行写事务。Health/Ready 走独立诊断通道，Dashboard 状态排除当前探针自身，确保过载时仍可观察真实占用。
- Attempt stdout/stderr 与后台原始日志共用 Web 进程内的有界下载槽。槽位覆盖文件打开、后台日志 SHA-256 校验和完整响应源流生命周期；饱和请求即时返回可重试的 `429`，不进入排队，也不阻断 Health/Ready。响应源流用可配置空闲计时器防止慢客户端永久占槽，数据读取和下游 `drain` 都会刷新计时器，因此限制的是持续无进展时间而不是文件总下载时长。静态资源不占槽。
- 自动修复以首次托管摘要为信任基线，只接受仍完全匹配该摘要的原业务 LOG；损坏副本先原子移入任务内 `.quarantine/`，再以不覆盖式原子发布重建。原证据缺失、不匹配或文件类型不安全时不覆盖现场。
- 已派发的定时检查如果在创建 Turn 前因执行器、工作目录或启动错误失败，会在同一事务中释放任务租约并退回 `waiting_scheduled`，按调度自身的 `maxAttempts` 退避重试。重试耗尽后调度转为 `failed`，对应外部执行转为 `lost`，不会留下无后续作业的伪 `running` 状态。
- 调度消息保存完整 PID、状态文件路径和检查指令，不依赖短期对话文本。
- 操作者停止任务会先结束该任务由平台启动的显式交互 CLI，封存并复验 transcript，再取消未完成检查和后台跟踪记录；平台不会仅凭 PID 强杀未知外部进程。
- 周期性业务执行不是同一任务的长期复用：每个周期创建新的任务 Session；这里只复用一次业务执行的状态检查链。

## 一致性策略

- 新建并启动通过单个事务提交任务、创建审计、首条命令、`queued` 状态和排队工作日志；失败时整体回滚。任务 ID 与完整创建参数也参与重放校验，因此客户端丢失响应甚至丢失原幂等键都不会产生第二条首轮命令。
- API 入队使用绑定任务、命令类型和完整输入的幂等键；HTTP 维护门控允许候选重放进入 Store，但事务先识别已提交键，再对新命令应用任务状态、readiness 与维护门控。任务后来完成、禁用，或执行器、工作区、维护状态后续变化，都不会把安全重放误报成未提交；新键仍在任何写入前失败。相同请求重放不会创建第二次执行，同一键对应不同输入时返回冲突而不会静默吞掉指令。Web UI 在运行请求超时或断网后保留该幂等意图，并通过 Dashboard 的任务版本、状态和更新时间完成结果对账。意图以任务 ID、输入 SHA-256、基线和幂等键保存到当前标签页的 `sessionStorage`，页面刷新不会丢失未知结果状态，也不会把原始指令写入浏览器存储。
- 停止、完成、恢复、重置和删除把成功响应写入独立的 `session_operation_receipts`，回执与状态变更位于同一个 SQLite 事务，且不随普通任务删除级联清理。回执绑定操作、任务 ID 和任务创建代际；响应丢失后可精确重放，旧删除键不会作用到同 ID 的新任务。每次完成/恢复归档循环会清理上一循环的相反操作回执，30 天保留清理会删除到期任务代际的全部回执以及已经脱离任务超过 30 天的旧回执。维护期间先查回执，未命中时在任务文件暂存和状态更新前再次检查维护租约。Web UI 同样在当前标签页持久化这些操作意图，超时后先查询单任务状态，能够证明终态时显示成功，无法证明时保留原键并明确提示结果未知。
- 托管 Turn 的唯一 Codex 进程和显式重连的交互 CLI 都使用 PTY，并先持久化输出再提供给浏览器；每个进程写入任务私有的 raw transcript。CLI 退出后 `fsync` 原件并原子发布包含字节数与 SHA-256 的 manifest。结构化审计从该 Turn 的 rollout 增量恢复，不解析 PTY 画面。完成请求必须依次等待 CLI 退出、封存未完成原件、复验全部 transcript，再提交 `completed` 状态；任一步失败都不归档。已归档任务的同一 WebSocket 只做完整性校验和分块回放，不解析 Bridge Runtime 或启动 Codex。
- Reset、普通删除、30 天保留清理和手工 Runtime 回收都会使用代际及 Session key 绑定的 `bridge_cleanup_jobs`。Reset 在同一事务内先登记旧 key 的 deletion 作业再清空 Task 当前指针；保留清理若遇到尚未执行的手工 completed 回收作业，会先把它转换为 deletion 作业再删除任务，避免任务引用消失后原作业永久失败。Worker 用独立租约在事务提交后删除确定的 Bridge record、Codex home、工作区、chatfile 和锁；文件操作失败只更新持久重试，不回滚或伪装已提交的业务结果。记录/path 全量校验在任何删除前完成，Worker 中断后的重复执行幂等。
- Bridge runtime 库存是只读实时分类，不在扫描时修改文件或自动回收升级前 Session。手工回收只接受精确 Session ID 确认，且只允许 `orphan` 与 `completed_retained`；入队事务重新核对任务引用，Worker 执行前再次核对 record、任务代际和全部路径。公开结果省略 Session key 与主机路径，已完成任务的审计历史不属于 runtime 回收目标。
- Worker 在 SQLite `IMMEDIATE` 事务中领取命令；Turn 创建和 `queued -> running` 状态转换也在一个条件事务中完成。
- 真实 Worker 启动时，首个 Attempt 与 Turn、`queued -> running/recovering` 在同一事务创建；API 一旦观察到运行态，就一定能查询到对应 Attempt。停止请求不能插入两者之间造成审计缺口。
- 租约由 Worker 每 2 秒续期，过期后才能由其他 Worker 恢复。
- 调度领取也使用 15 秒租约；Worker 在派发前崩溃时，租约到期后由新 Worker 重新领取。
- 后台日志归档和完整性复验分别使用独立 30 秒租约，复制进度会续租；Worker 中断后新 Worker 可采用已经发布但尚未入库的托管副本或接管过期校验。租约竞争不标记为数据损坏。归档复制和复验都属于平台维护活动，恢复检查点、配置替换和任务文件删除不会与其并发。
- 工作日志使用任务内连续序号，事务保证多进程写入不冲突。
- Turn 结束时，Attempt、Turn、Task、命令、租约和终态事件在一个事务中提交。
- 自动识别 `run-in-background` 输出、后台状态对账和 Turn 终态提交受同一个 Worker 所有权事务保护；租约已转移的旧 Worker 不能新增 `external_attempts` 或定时检查。
- 配置导入先完整校验，再在单个事务中合并或替换；任务文件按创建代际暂存并在启动时自愈。
- 大型原始输出保存在有界文件中，结构化事件进入 SQLite。
- 人工停止和服务关机的终态优先于执行进程退出码，避免返回码 `0` 覆盖停止或中断事实。
- Worker 遇到未捕获异常进入强制关机时，会在发送 `SIGKILL` 前标记所有活动 Attempt 为关机中断；关闭回调因此提交 `interrupted`，新 Worker 可继续按 Task 当前 Session 自动恢复，而不会把基础设施故障误记为业务失败。
- Attempt 结束、重试或租约失效时，同一 Attempt 下未结束的命令执行记录同步关闭。
- 定时检查执行中断时，原 Turn/Attempt 关闭，调度记录重新排队；不会因 Codex 进程退出而丢失外部执行跟踪。
- Worker 启动时及每 5 秒恢复周期都会校验 `waiting_scheduled`：running External 缺少活动调度时立即重建且保持单例；External 和调度都已终结时自动转入 `waiting_review`，修复断电或旧版本遗留的逻辑孤儿。
- Worker 先启动只等待单字节放行信号的本地执行门控器；Attempt/Task 的 PID、Linux 启动时钟和进程组事务化登记完成，且 Web 监管进程校验父进程、Session leader 并返回 ACK 后，门控器才 `exec` Bridge runner。Worker 在 ACK 前退出时，父进程死亡信号或 stdin EOF 会关闭门控器，因此不存在“执行已开始但监管尚未知晓”的窗口。
- 监管进程按 Attempt ID 保存执行身份；Worker 异常退出时只终止启动时钟、Session ID 和进程组仍匹配的遗留执行，数据库中的旧 PID 不会被直接用于强杀，避免 PID 复用误伤无关进程。
- Attempt 正常关闭时，Worker 同样清理原执行进程组中的残留后代；`run-in-background` 通过 `setsid` 创建的独立业务进程组不受影响，并继续由持久调度跟踪。
- Codex 主进程退出后 stderr 最多排空 2 秒；后代错误持管道时 Attempt 以审计不完整失败结束，不会无限占用 Worker 槽位。
- Worker 不按活动 Task 数或工作目录限制并发；这是明确的执行策略，而不是遗漏的目录锁。每个可运行 Task 独立持有任务租约，同一目录中的多个 Task 也可同时执行。每轮命令领取使用固定批量大小约束单次数据库事务，剩余命令在后续轮询继续领取，不构成持续并发上限。
- Session 启动占用内存槽后，首条工作日志、Skill 挂载日志和执行进程启动位于同一异常清理边界；任一步失败都会立即释放槽位，再由命令失败事务关闭 Turn 和任务租约。
- `/api/health` 除 SQLite 完整性外还检查活动 Task/Attempt/租约、非执行态残留租约、Task/Attempt 进程身份、已完成 Task 的活动 Command/Schedule/External，以及 `waiting_scheduled`/External/调度之间的十类状态不变量；任何不变量失败都返回 `503`。Worker 已领取匹配的 `processing` 命令后、创建 Turn 前的 `queued` 租约是显式允许的启动瞬态。
- 平台内 Host Launcher 和 Web Supervisor 分别用私有 `0700` 锁目录和 `0600` owner 文件保证单实例，owner 同时保存 PID 与 Linux 启动时钟以抵抗 PID 复用；已失效锁可原子隔离后回收。Web 以独立 Session/进程组启动，异常退出后按有上限的指数退避重启，并仅按已验证身份清理残留组。
- 无 systemd 启动时，Host Launcher 持有 Supervisor/Web/Worker 的统一诊断输出通道。日志按严格字节上限同步关闭、重命名和重开，当前文件与有限历史代均为 `0600`；因此 Supervisor 被强杀后 Web 的降级退出诊断仍可写入，且长期重启不会无界占满磁盘。systemd 直接监管 Supervisor 时输出仍交给 journald。
- Supervisor 和 Host Launcher 身份通过环境传给 Web，但健康检查不会只信任环境值：Launcher 必须同时匹配 PID、启动时钟和 Supervisor 直接父进程关系，Supervisor 必须匹配 PID、启动时钟和当前 Web/Worker 祖先关系。平台内监管被要求却失效时 readiness 分别以 `host_launcher_unavailable` 或 `web_supervisor_unavailable` 降级；直接由外部服务管理器监管的层级报告 `mode=external`，不伪造外部监管健康。
- Web 在平台内监管模式下周期校验 Supervisor 身份；父 Supervisor 消失时复用正常停服链，先关闭监听并要求 Worker 持久化活动 Attempt 的中断状态，再退出。无 systemd 的 Host Launcher 观察到 Supervisor 退出后退避重启。Launcher 自身失效时 Web 保留 liveness 供诊断，但 readiness 立即失败，因为服务树已失去下一层自动恢复能力；运维入口需停止残留 Supervisor 并重建完整链路。
- Worker 心跳携带 PID 与 Linux 启动时钟；Web 只接受仍属于自身子进程的匹配身份，避免重启后旧心跳或 PID 复用被当作可用 Worker。`/api/ready` 还实时核验所有活动执行 leader，执行器、Worker、工作区、权限或进程身份任一降级即返回 `503`；`/api/health` 保留控制面 liveness 语义。
- readiness 同时检查数据目录、运行状态目录和所有可用任务工作根目录的可写性与剩余空间。容量不足时 API 不再入队，Worker 不领取已排队命令；命令保持 `pending`，空间恢复后继续执行。活动 Attempt 不会仅因容量告警被强杀，其真实写盘错误仍按审计不完整失败记录。
- 在线数据库备份使用 SQLite backup API 从活动 WAL 数据库取得事务一致快照，在私有临时目录执行 `quick_check`、外键、SHA-256、大小和核心表计数校验；数据库与清单落盘并 `fsync` 后，通过目录重命名一次性发布。新包成功发布后才轮转旧包，失败或崩溃不会覆盖最后一份有效备份。
- 数据库备份调度与 Session Worker 解耦，不占用任务执行槽。启动时从最新有效备份的完成时间直接恢复真实到期时间；调度器使用进程内世代号约束 timer，重复初始化会先替换旧 timer，停止或重启前已经进入异步阶段的旧回调可以完成当前备份，但不能重新挂回旧调度链。它只保护 SQLite 事务数据；Attempt 原始输出、后台日志、Session runtime 和工作文件仍由完整数据恢复流程保护。
- 平台恢复检查点使用 SQLite 持久维护租约建立跨 Web/Worker 的静默窗口。租约取得事务独立核对活动 Task、Attempt、Command、Schedule、External 和已认领 Bridge cleanup；队列、命令领取、到期调度领取、派发与回收认领都在各自写事务内复查租约，Worker 心跳仅在恢复检查点维护中保持只读。SQLite snapshot 使用最多 10 分钟的初始窗口且暂停租约续写，超时后 fail closed；快照完成后恢复正常续租。
- 任务配置、Skill 管理、配置导入和命令 Skill 归因同样在各自 `IMMEDIATE` 写事务内复查维护租约；维护期间 Skill 查询复用已持久化来源快照，不因 GET 触发来源发现写入。这样长请求即使在租约建立前进入 HTTP 层，也不能在租约建立后提交。
- Host Launcher 滚动重启复用同一持久租约，并采用“备份文件锁后查租约、重启租约后查备份锁”的固定交叉顺序，消除在线备份与停服并发竞态。新 Launcher 继承旧进程环境但只公开 PID 结果，替代树在维护态通过身份、Worker、存储和状态不变量检查后才释放租约。
- 恢复检查点调度从最近有效检查点的完成时间续算，不依赖进程内计时存续。重复初始化只保留本世代的一条 timer 链，旧世代异步回调不能覆盖新 `nextRunAt` 或恢复已停止的调度。到期但平台繁忙时标记为 deferred 并短间隔重试，既不打断业务任务，也不把预期竞争记为恢复失败。
- 检查点先生成已验证数据库快照并移除仅用于创建窗口的维护元数据，再归档平台数据附属文件和完整 runtime。源清单在归档前后按 inode、大小、模式、mtime/ctime 纳秒指纹复核；数据库和归档通过哈希、布局、权限及内容清单验证后才原子发布。
- 检查点以原子发布为成功边界；发布后的租约释放异常作为独立清理告警返回和审计，不会把已存在的有效包误报为创建失败。未确认释放的租约仍由到期时间兜底，且不会按旧 owner 删除后续维护租约。
- 数据库备份和恢复检查点将“包发布”与“审计持久化”分开判定。多条存储审计在一个事务中提交，失败时核心 API 仍返回已发布结果和 `auditRecorded=false`；完整事件批次先通过 `fsync + rename` 进入私有 outbox，再由启动恢复、定时器或下一次同类审计幂等重试，避免调用方因 500 重建重复包，也避免进程重启丢失待补事件。
- outbox 事件在首次提交前获得稳定 ID 和时间。重放事务会逐条验证已存在 ID 的完整规范化内容，完全一致时视为成功，不一致时拒绝，因此 SQLite 已提交但 outbox 尚未清理时断电不会产生重复或静默覆盖。
- 检查点是平台状态边界，不覆盖任务工作根目录或外置日志。覆盖声明随清单固定返回；Session runtime 中可能存在认证信息，因此 API 只公开白名单校验摘要，不提供内容读取或下载。
- 每个任务 Session 固定使用 Codex `danger-full-access` 且不进行交互式审批；健康状态和 Attempt 工作日志记录实际权限策略。

## Skill 策略

- Codex Skill 使用完整来源键去重，只读展示。
- 发现过程递归扫描所有普通子目录，不跟随符号链接。
- 同名来源不会静默覆盖；冲突项获得限定 ID。
- Codex 来源的启停状态按来源键持久化，刷新发现不会重置。
- 平台 Skill 每次完整文件树变化生成新版本；ZIP 导入在一个事务中提交。
- 首轮执行生成任务完整 Skill 目录快照、文件清单和内容哈希。
- 执行时记录实际快照 ID、Skill 版本和哈希，便于审计复现。
- 命令执行明细保存显式声明、当前有效归因和完整修正历史；人工修正不改写命令或原始运行事件。
- 每次使用快照前校验清单、文件集合和内容哈希；发现篡改、缺失或多余文件时，从 SQLite 中的冻结内容原子重建。
- 物化快照目录使用 `0500`，普通文件使用 `0400`，可执行脚本使用 `0500`。

## 部署边界

当前实现面向单机或共享 SQLite 文件的单节点部署。独立 Worker 已使用租约避免重复执行，但 SQLite 不适合跨主机共享文件系统。需要多节点横向扩展时，应把同一数据模型迁移到 PostgreSQL，并使用数据库锁或队列系统领取命令。

运行时分为三层依赖：Node.js `20.17..26` 承载 Web、Worker、SQLite 和监管器；Python `3.11+` 承载 Bridge runner、PTY 和执行门控；外部 connect2cli Bridge 与真实 Codex CLI 提供持久 Session 能力。`better-sqlite3` 和 `node-pty` 是目标平台相关的原生 Node 模块，发布包不能跨不兼容的 Node ABI、操作系统或 CPU 架构直接复用。Bridge 源目录和 Codex CLI 必须对最终服务账户可读/可执行并完成运行配置，不能只在部署操作者账户下可用。

源码和 `node_modules` 属于只读发布面；data、backup、runtime 与 task workspace 属于可写状态面，并且源码、data、runtime 不能重叠。systemd 是推荐的生产监管边界，cgroup v2 delegation 用于可靠终止后台完整后代树；没有 delegation 时只回退到经过 PID 启动时钟校验的独立进程组。详细依赖、目录权限和发布步骤见[部署与运维](OPERATIONS.md)。

工作目录白名单和符号链接检查是路径边界，不是操作系统沙箱。生产环境必须使用专用、非 root、最小权限服务账户，并只允许可信操作者创建任务或提供执行指令；如需承载不可信输入，还必须在平台外增加容器、虚拟机或等价的 OS 级隔离。
