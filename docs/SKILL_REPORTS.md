# Skill 结构化报告

`workspaceMode=session-clone` 的完整提测使用相同的 HTML/Markdown 声明、报告 API 和资源 URL，
但 `storageMode=in-place`：媒体直接登记 Session 原文件与摘要，不再复制到第二个 artifact 目录。
HTML、Markdown、case 日志、源码 JS 与清单等文本在原目录保存按内容摘要命名的隐藏
`.snapshot` 版本，API 仍返回原始文件名和媒体类型。这使已发布报告不受后续测试报告后处理影响；
同目录同内容复用一个版本，视频和音频保持原地引用。文本版本随 Task 的原地封存及删除一起处理。
源 HTML 保留原相对链接，服务读取时完成本地资产内嵌和媒体、日志、Video Check 链接转换；
HLS/DASH 等少量显示转换数据保存在 SQLite，视频和音频不存入数据库。任务收尾后 Worker
生成逐文件清单并冻结 Session；详情页可查看本次源码。此模式不会执行项目 `videos` 副本清理，
唯一媒体随 Session 保留。下面的复制归档和副本清理说明适用于兼容的 shared 模式。

Skill 结构化报告把业务结论与终端原始输出分开。Skill 负责生成领域内容，平台只校验并持久化通用 Schema，前端不识别 cloud recording、GW 或其他业务字段。

平台、工作流 Skill 与 pytest 插件的职责以及预览、归档、播放之间的区别见[功能与能力边界](CAPABILITIES.md)。报告发布成功只表示结构化内容已持久化；文件托管结果仍需查看返回的 artifact 和归档作业状态。

推荐展示顺序：

1. 主业务命令使用顶层 `primaryExecution`，实际命令默认收起，点击展开后显示完整内容。
2. 业务结果和当前状态使用 `priority=primary`、`defaultExpanded=true`。
3. 其余命令、日志、路径、容器详情和诊断证据使用 `supporting` 或 `debug`，默认折叠。
4. 原始 payload 使用 `kind=json`；服务端和前端都会强制折叠。
5. 可能包含内部信息的区块标记 `sensitivity=internal`；高敏感区块标记 `sensitive` 并强制折叠。

折叠只是展示策略，不是权限边界。测试分析模式按原始证据保存报告内容，API、报告页和 HTML artifact 都可以返回完整的 AK、SK、Token、Authorization、Cookie、密码及其他凭据值；这些值不会因为命中凭据特征而触发脱敏或中断。由于报告可能包含高敏感信息，部署环境必须限制报告、日志、备份和恢复包的访问范围。

## 固定登记卡片

固定内容、生成命令、重跑/最终汇总预设和七份完整数据示例统一见
[固定上报卡片规范](REPORT_CARD_TEMPLATES.md)（Card Templates v1）。
`codex-skill-report cards` 可读取同一目录；`template --data` 从真实结果文件填充固定指标与明细。

模板生成器对 `pending`、`running` 统一输出 `artifacts=[]`，即使输入数据中带有附件也留待终态发布；执行证据和原输入数据保持不变。

各业务共用五类卡片，类型使用现有 `reportType`，不用新增上报协议：

| 卡片 | `reportType` | 主要内容 |
| --- | --- | --- |
| 测试结果 | `test-result` | 每轮指标、用例结果、HTML 报告 |
| 部署结果 | `deployment-result` | 目标、组件、版本、开始/结束和结论 |
| 失败分析 | `failure-analysis` | 判断、预期/实际、证据和下一步 |
| 流程进度 | `workflow-progress` | 业务定义的阶段、当前进度和最终结果 |
| 通用业务结果 | `business-result` | 其余业务的结果和详情 |

同一业务阶段展示一张卡。单个执行产生多份 HTML 时，将所有 HTML 放在同一逻辑报告中；
阶段包含多个独立执行时，阶段卡用可选 `relatedReportKeys` 引用这些执行的报告。
平台把引用报告的 HTML 入口和可展开明细合并到阶段卡中，不再并列展示碎片卡。
该字段只组织展示，原报告的 Skill、Step Run、执行证据和归档 URL 保持各自归属；
阶段汇总不能把多个执行的文件挂到同一个 `executionEvidence` 下。
阶段卡的总数由业务填写，平台不把阶段汇总当作额外一次测试或重复累计计数。
历史报告未提供关联时，平台根据 Step Run 和明确的 rerun 标识把重跑结果汇总为一张展示卡；
各原始报告、命令、HTML、状态和归属均保留在明细中，不改写登记记录，也不重复累计测试数量。
未到达或无法解析的引用不会隐藏已有报告。

云录制完整提测默认按实际执行的 GW 部署、CICD 部署、GW51 首轮、GW53 首轮、
Rerun 结果和最终汇总展示；多组件 CICD 和多组 rerun 的执行明细归入对应阶段。
源码准备、collect-only、失败清单提取、归档核验和最终证据不单独新增卡片。
未执行的阶段在最终汇总中说明跳过；无失败时说明无需重跑。独立业务 Skill 仍可按自身阶段组织。

卡片统一按标题/状态、结论、指标、报告文件、执行信息、业务详情、原始数据排列。
任务摘要把各组 rerun 收进一张结果卡，展开查看每组执行和报告文件。
结构化报告把主命令等执行信息收进对应报告的可展开区域；
已经按 External Attempt 关联到报告的执行不再额外展示一张重复执行卡。
未关联报告的执行仍保留。历史和自定义类型使用通用卡片，服务端不增加类型白名单。

共用 Skill 的版本化源码在 [task-reporting](../skills/task-reporting/SKILL.md)，
登记字段见其 [cards.md](../skills/task-reporting/references/cards.md)。安装到用户级
Skill 目录后，新 Task 的 Skill 快照可以发现它；业务 Skill 继续作为真实发布者。

使用平台 helper 直接生成骨架，不需要额外调用模型：

```bash
codex-skill-use cloud-recording-test -- codex-skill-report template \
  --type test-result --report-key <logical-run-key> --status running \
  --external-attempt <TRACKING_ID> --output <run-dir>/report.json
```

`--type` 也接受 `test`、`deployment`、`analysis`、`workflow`、`business` 简写。
`--title`、`--summary`、`--command`、`--working-dir` 填入已有事实；未知指标保持空数组，
业务结果由执行 Skill 填入。省略 `--output` 时输出 JSON，生成不会触发发布或数据库写入。
模板生成可在本地执行；实际 `publish` 继续使用现有平台上下文。部署仍只登记开始和结束。

## 发布

报告必须在受管任务的 Skill 快照中，通过 `codex-skill-use` 声明真实发布者：

```bash
codex-skill-use cloud-recording-test -- \
  codex-skill-report publish --file /absolute/task/report.json
```

`codex-skill-use` 会自行解析平台内置的 `codex-skill-report`。即使受管登录 Shell
重新生成了 `PATH`，上面的短命令也能工作；发布器仍不得脱离 Skill 包装器直接调用。

发布要求当前环境包含 `CODEX_TASK_ID`、`CODEX_TASK_TURN_ID`、`CODEX_TASK_ATTEMPT_ID` 和 `CODEX_TASK_SKILL_SNAPSHOT`。报告的 `skillId` 必须是当前 `codex-skill-use` 声明的 Skill，且存在于任务冻结快照；Skill 不能冒用另一个 Skill 的身份。

同一任务内，`reportKey` 是一个 Step Run 的逻辑报告稳定标识，不能跨 Run 复用。一个任务执行多个相互独立的 pytest 时，每个 Run 使用不同且稳定的 `reportKey`；同一 Run 产生多份 HTML 时，可以由一份报告统一声明。紧邻的相同内容重试返回原报告并标记幂等；内容变化会追加修订，A -> B -> A 对应修订 `1`、`2`、`3`。任务完成后报告不可再发布。

每份报告都必须显式包含 `artifacts` 数组；没有文件时使用 `[]`。运行中和终态 Run 报告都把 `codex-background-track register` 返回的 `TRACKING_ID` 写入 `executionEvidence.externalAttemptId`；平台由此写入并返回 `stepRunId`。启动时已经知道的每份 HTML 应同时通过可重复的 `--artifact pytest-html:<stable-key>:<absolute-path>` 登记到 External Attempt。若运行中报告遗漏了这一步，平台会在 `primaryExecution.command` 含有具体 pytest `--html` 输出、且报告工作目录与 External Attempt 的 META 工作目录一致时安全补登记；不满足这些条件不会猜测文件。运行中报告发布后，平台立即以 `registeredArtifacts` 返回登记项的安全展示字段和受控快照 URL，不返回源路径；平台再把登记项自动合并进每一版终态报告并归档。终态才生成的分析 HTML / Markdown 由终态报告显式追加。后台报告 revision、后台执行和 artifact 必须属于同一 Step Run；前台分析使用下文的 commandExecutionId。

`cloud-recording-test`、`cloud-recording-gw-deploy` 和 `rtsc-cicd-deploy` 在 Task 进入待审核状态时，如已有 `codex-skill-use` 自动 invocation 或旧命令归因、但最新报告仍是 `pending`、`running` 或 `unknown`，平台会生成一份 `platform-fallback:*` 终态报告，避免业务轨迹缺少结论。测试兜底使用关联的 External Attempt 状态；部署兜底优先使用该 Skill 最后的非 `codex-skill-report` invocation，旧数据再使用命令归因，避免后续 pytest 的退出码覆盖部署结果。该报告明确标注为兜底，只包含平台已经持久化的状态与退出码。CICD/GW 每个 `reportKey` 只要求开始和结束两个 revision；业务轨迹只投影首条开始和最后一条终态结束，历史中间 revision 仍保留用于审计但不再显示为业务节点。其他报告仍只投影最新 revision。

### Skill 接入与更新

1. 为每个独立 Run 分配稳定 `reportKey`，登记时重复传入每份已知 HTML 的 `--artifact`，保存返回的 `STEP_RUN_ID` 和 `TRACKING_ID`。
2. 启动后发布 Schema v2 的 `running` 修订，使用 `artifacts=[]`，并把 `TRACKING_ID` 写入 `executionEvidence.externalAttemptId`。`registeredArtifacts` 由平台返回，Skill 不提交该字段；在运行中报告顶层声明 HTML 会得到 `pending or running reports cannot declare artifacts`。
3. 终态结果收集后发布同 Run 的最终修订。平台合并该 External Attempt 已登记的 HTML；后生成的分析 HTML / Markdown 等文件由 Skill 显式追加。
4. 多份报告必须都关联同一真实 Run，不能用另一个 Run 的登记、文件或退出码凑齐。Task 摘要汇总同 Run 多份报告的 artifact，身份按 `reportKey + kind + key` 区分，托管入口优先于同身份的登记入口。

源 Skill 仍使用 Schema v1 示例，或要求 `running.artifacts` 列出文件时，应同步为上述契约；只重启平台不能修正 Skill 的旧模板。任务首轮冻结 Skill，更新源 Skill 只影响后续新快照，不能改写已创建任务的不可变快照。

Codex 来源的 Skill 从实际 `SOURCE_CODEX_HOME/skills`（默认 `/home/jenkins/.codex/skills`）读取；
仓库的 `skills/task-reporting` 是维护副本，修改后还需同步实际源目录。平台读取 Skill 列表时刷新源版本，
后续新 Task 冻结更新后的版本，无需重启。失败分析直接把 `failure-analysis-html` 放入分析卡的
`artifacts`，关联生成 HTML 的前台 `commandExecutionId`；跨多个测试 Run 的输入不需要绑定为单个后台执行。
完整查询、模板和发布示例见 [前台分析 HTML 挂载](../skills/task-reporting/references/cards.md#foreground-analysis-html)。

已登记的 `cloud-recording-test` 后台执行到达终态后，如果在 Task 最终进入待确认时仍没有关联的 Run 报告，平台会按原 Skill、External Attempt、Step Run 和显式 HTML 声明生成每个执行的兜底报告。初始轮已有报告不代表后续 rerun 的报告齐全；父阶段通过 `relatedReportKeys` 引用子报告。兜底直接使用已记录的执行终态，详细用例统计以 HTML 为准，不增加模型轮次或测试执行。

同一 Step Run、同一执行链中，失败的技术 generation 已被后续成功 generation 替代时，按文件保留实际生成的非空 HTML 和已有的托管副本，未产出的旧 HTML 不再加入归档作业。旧执行原始声明和已发布修订保持不变；已经排队的旧作业再次处理时也会跳过这些未产出文件，并记录 `skill.report.artifacts.superseded_missing`。最新执行或没有成功后继的失败执行仍按原声明归档，不忽略缺文件错误。兜底报告键采用有界 Run 名称和执行摘要，支持 128 字符的 Run 名称；单个历史执行的登记异常记入 `skill.report.execution_fallback_failed`，其他执行继续补齐。

归档期间失去作业归属时立即中止，提交文件和资源索引前再次核验归属；该异常不会降级成缺媒体警告后继续发布。历史原地归档若遗漏日志索引，可按 Task 与 artifact 调用 `repairInPlaceSkillReportArtifactLogs` 补建日志资源和链接映射，保留 HTML 原字节、摘要及现有视频资源。

原地 HTML 摘要正确不代表媒体索引完整。归档重试和跨修订复用会核对 HTML 引用、HLS/DASH 分片及 Video Check 的资源映射。历史缺失可按 Task 与 artifact 调用 `repairInPlaceSkillReportArtifactResources`：优先复用同 Task、同源 HTML 路径和摘要下已保留的完整索引，并改写资源归属；没有可用索引时从原文件重建。修复不复制视频、不改 HTML 原字节或 viewed 状态，返回新增资源数及未解决引用数，并记录 `skill.report.artifact.resources_repaired`。报告 GET 不触发修复。

## Schema v2

顶层对象最大为规范化后 256 KiB：

| 字段 | 约束 | 含义 |
| --- | --- | --- |
| `schemaVersion` | 必须为 `2` | Schema 版本 |
| `reportKey` | 1..128 字符的标识 | 任务内逻辑报告 ID |
| `skillId` | 1..128 字符的 Skill ID | 发布者，必须匹配活动 Skill |
| `reportType` | 1..128 字符的标识 | 通用业务类型，如 `test-result`、`deployment-result` |
| `title` | 1..160 字符 | 报告标题 |
| `status` | 枚举 | `pending`、`running`、`succeeded`、`failed`、`partial`、`blocked`、`cancelled`、`unknown` |
| `summary` | 1..2000 字符 | 可独立理解的业务结论 |
| `observedAt` | 可选 ISO 时间 | 业务结果观察时间 |
| `executionEvidence` | 有 artifact 时必填 | 后台执行的 `externalAttemptId`，或前台命令的 `commandExecutionId`，二选一 |
| `primaryExecution` | 可选对象 | 生成本报告的主业务执行，前端醒目展示 |
| `artifacts` | 必填数组，最多 32 项 | 需要托管的文件声明；没有文件时为 `[]` |
| `relatedReportKeys` | 可选报告 key 数组 | 同 Task、同阶段内归入本卡的执行报告；不改变文件归档归属 |
| `metrics` | 最多 12 项 | 顶部关键指标 |
| `sections` | 1..16 项 | 通用内容区块 |

`primaryExecution` 包含必填的 `label` 和原始 `command`，以及可选的
`workingDirectory`、`commandPath`、`status`、`exitCode`、`startedAt` 和
`finishedAt`。`command` 最长 32 KiB，保留实际参数和值以便测试分析。该字段只保存主业务命令；
辅助检查和 Agent 自身命令仍由命令审计记录保存。除上述严格的 pytest `--html` 补登记外，
`primaryExecution` 不授权或发现任意 artifact。

`artifacts` 每项包含唯一 `key`、`kind` 和绝对 `path`。当前 `kind` 支持
`pytest-html`、`failure-analysis-html` 和 `failure-analysis-markdown`；两个 HTML 类型使用
`.html`/`.htm`，Markdown 使用 `.md`。同一报告不能重复 key 或规范化路径，`pending`/`running` 报告不能声明文件。
运行中的报告仍使用 `artifacts=[]`；其 `registeredArtifacts` 是平台根据同一 External Attempt
的显式登记或严格的 pytest `--html` 补登记生成的只读响应字段，不是 Skill 上报字段。每项包含 `key`、`kind`、`fileName`、
`executionStatus` 和受认证 `url`；终态 HTML 源文件不可用时还返回 `available=false` 和
`availabilityReason`。尚无托管版本且 HTML 已有文档结构时，该 URL 返回请求开始时已有字节的
`private, no-store` 快照，允许保留可见的 `summary__reload__button`；刷新读取后续写入，不主动推送页面更新。
External 已终态、归档排队、处理中或重试时，预览仍可打开；归档本身继续要求 HTML 完整且没有活动刷新按钮。
该份 HTML 与依赖在同一事务发布后，原登记 URL 以 `307` 转到正式托管版本并保留查询参数，
无需等报告内其他文件全部归档。原预览页面的日志、视频和分片 URL 也会转到对应托管资源，
重新签发资源访问凭据，因此项目视频副本清理后，已打开的页面仍可使用旧链接。
文件未生成时返回 `404`；空文件或缺少文档结构返回 `409`。HTML 使用 sandbox CSP，且拒绝符号链接、
非普通文件和超过 64 MiB 的源文件。运行中快照依赖业务工作目录，不具备终态托管副本的
持久性或完整性摘要保证。

前台分析、构建等命令可使用 `executionEvidence: {"commandExecutionId":"execution-..."}`，关联当前
Task 命令审计中实际存在的终态记录。平台核对其 Task、Turn、Attempt 归属，并使用记录的工作目录；
Session 模式允许产物位于自有 Session 目录内，不必把前台命令登记成后台 pytest。该关联不会创建
External Attempt 或绑定无关 Step Run。`template --data` 保留该前台执行关联；显式传入
`--external-attempt` 时以该后台执行为准。完整分析 HTML 使用 `kind: "failure-analysis-html"`，
用户选择 Markdown 时使用 `kind: "failure-analysis-markdown"`。

失败分析 HTML 和 Markdown 都会在任务摘要顶部和结构化报告卡片顶部提供“查看完整分析”入口；最终汇总
通过 `relatedReportKeys` 引用分析卡时同样提供入口。这里只加载文件元数据，点击后才读取完整正文。

分析 HTML 按问题提供可展开的完整 NodeID 列表，保留参数化和 profile/组对应。
Jira 创建预填与外部链接在独立标签页打开；报告查看器兼容旧 HTML 的链接写法，
并允许新标签页使用正常的 Jira 登录与表单流程。页内问题索引继续在当前报告跳转。

平台按 `executionEvidence.externalAttemptId` 精确查询当前 Task 已登记的后台执行，校验其原始
Turn/Attempt 归属、终态和 META 中的绝对工作目录。新 External Attempt 的每个 `pytest-html`
必须精确匹配启动登记时保存的 kind、key 和绝对路径，并位于 META 工作目录内；因此直接 pytest
和通过 `--report` 等参数传递路径的 wrapper 使用同一套证据格式。
`failure-analysis-html` 和 `failure-analysis-markdown` 不要求出现在 pytest 命令中，沿用对应执行的
目录归属规则。分析 HTML 按独立文档归档和打开，不执行 pytest 资源改写或视频 viewed 状态适配。普通
Section 仍可展示路径，但不参与归档。每个不超过 64 MiB 的普通 HTML 或 Markdown 文件独立复制到任务
托管存储，`artifacts` 会为每份文件返回不同的 ID、稳定 key、文件名、大小、SHA-256 和
受控打开 URL，前端逐份显示打开入口。路径必须留在该执行目录内，不能使用环境变量、
命令替换或符号链接逃逸。某一候选缺失、超限或校验失败时，平台仍继续处理其余候选，
最后汇总返回错误；已经成功归档的文件保持可打开，重试不会重复登记。
原地归档 Session 中，同一 `reportKey` 的最新修订完整归档后，Worker 会终止旧修订尚未成功的归档重试。
旧修订保留失败状态、原错误和已归档文件，并写入替代修订的审计记录；不再阻塞 Session 封存。
仅发布新修订、或新修订尚未完整归档时，不会终止旧重试。
终态登记项对应的源文件为空、只有标题占位内容或缺少 HTML 文档结构时，
页面标记为“报告文件未生成或为空”并隐藏该登记项的打开链接；对应 External Attempt 日志仍保留用于定位测试提前失败的原因。
这是登记项的源文件可用性检查，不等于完整归档校验；已有托管 artifact 仍可从正式 URL 打开。
任务摘要和结构化报告会分别显示 HTML 与 Fail 分析报告的“打开报告”入口；任务归档后继续从
托管副本读取，不依赖原 pytest 文件。报告中的
`logs/<name>.txt` pytest logtxt 相对引用会在归档时复制为只读托管资源并改写为受控 URL，
查看不依赖原任务目录；该日志同样必须是执行目录内的普通文件，单文件不得超过 64 MiB。
同一日志被重复引用时只归档一份，避免大规模失败报告将日志重复内嵌后超过 HTML 上限。
若内嵌全部唯一日志会使 HTML 超过 64 MiB，平台将日志作为该 HTML artifact 的独立受认证
文本资源归档并改写链接，而不是写入 `Log omitted: artifact size limit` 占位。独立日志资源
不占用媒体清单和分片的 10,000 项额度，媒体达到上限也不会使后续 case 日志退回项目相对路径。
Log 弹窗每次打开都会替换 iframe browsing context，再加载当前 case 的日志；这避免慢响应期间
短暂显示上一 case 的 iframe 内容。平台也会在读取时升级已归档报告中的旧按钮，无需重新归档。

HTML 中 `href`、`src` 或 `data-src` 引用的本地 MP4、MP3、M3U8、TS、M4S、FLV、WebM、
MPD，以及 AVIF、BMP、GIF、JPEG、PNG、SVG、WebP 图片会复制到该 HTML artifact 独有的
资源命名空间，并改写为受控资源 URL；pytest-html `data-jsonblob` 中经过 HTML entity 编码的
链接和结构化 `extras.image` 本地文件引用也会处理。本地播放器脚本会内嵌到
托管 HTML；历史报告中精确匹配受支持版本的 jsDelivr HLS、FLV、DASH 和 Shaka 脚本也会由
平台内置、摘要校验的兼容资源替换，不依赖查看报告的电脑访问外网。旧 HLS.js 1.5.15 URL
使用支持 HEVC MPEG-TS 解析的 1.7.1 资源；最终 HEVC 解码仍取决于客户端浏览器和系统。

pytest-html 的 `data-case-source` 引用作为独立 JavaScript 源码快照资源归档，预览和归档
页面均转换为对应资源 URL。源码不内嵌进 HTML，不占用媒体分片额度；仅在视频窗口中
点击“查看源码”时加载一个函数。shared 模式保留托管副本，Session 模式直接引用原文件。

启用 Video Check 的报告还会归档 `videoCheck.source` 指向的 `results.js`、同一 Run 的
最终快照和结果脚本引用的 `details/*.js`，以及这些文件已有的 `.json` 配套结果。
平台改写归档副本中的结果和详情链接；展开详情只读取该 HTML artifact 的托管资源，
无需访问项目目录或检查服务。运行中预览使用当前 Run 的实时资源，可继续获取检查更新。
归档按报告引用收集文件，不复制 checker 的 `config.json`、队列或运行进程文件。
各 Run 的检查资源相互隔离，随 Task 的归档产物一并统计和删除；缺失资源会记录
`media_partial`，其余检查结果和 HTML 仍可使用。源 HTML 和检查目录保持原样。

M3U8 清单及其本地子清单、分片、初始化段和密钥会递归归档；MPD 中显式列出的
本地资源会归档。资源端点支持 HEAD 和单段 HTTP Range，浏览器可以拖动和按需读取媒体。
Audio、AV 和 Video M3U8 可以同时作为 HTML 顶层链接；同一路径又被其他清单引用时，每个
artifact 只归档一份唯一资源。M3U8 标签内单双引号形式的本地 `URI=` 都会递归解析和改写。
托管 HTML 返回时会根据资源登记信息为 M3U8、MPD 和 FLV 链接附加不参与 HTTP 请求的格式
fragment，使依赖原文件后缀选择播放器的历史报告继续进入 HLS、DASH 或 FLV 播放分支；新版
video 插件同时使用独立的 `data-media-format`，不再依赖托管 URL 的命名形式。
平台服务托管 HTML 时会为 M3U8 注入浏览器兼容播放源：同一资源目录存在同基名 MP4 时直接
复用已有 MP4；没有配套 MP4 时先使用原 HLS，仅当浏览器检测到首段视频缓冲缺失并自动跳到
非零时间后，才由 FFmpeg 使用 stream copy 按需封装一份 MP4。封装结果按
原 M3U8 SHA-256 缓存在当前 Task 的 `skill-report-artifacts/.playback-cache`，并发请求共享同一
生成任务，后续请求复用同一文件。缓存不写入 SQLite、不作为新的报告资源或长期媒体副本，
会随 Task 删除和 30 天保留清理一起移除。此逻辑在读取时注入，因此历史归档不需要重新发布。
如果 HTML 因测试包装器或平台命名规范被硬链接到别名目录，平台先按 HTML 声明目录解析，
仅在引用文件不存在时，回退到与该 HTML 具有相同 inode 的真实目录；回退仍只归档引用图中的
清单和分片，不扫描或复制整个 `videos` 目录。为避免歧义，测试插件应让 HTML、`videos/` 和
`logs/` 位于同一 Run 根目录，并登记最终真实 HTML 路径。推荐调用方式为
`--html task/<run-id>/report/<run-id>.html --html-video-source-dir ../videos`；video 插件从源目录
复制到该 Run 的 `videos/`，平台只从这份项目副本归档。
资源必须是执行目录内的普通文件；某个资源已经丢失时，平台保留原链接并写入
`skill.report.artifact.media_partial` 工作日志，不阻塞 HTML 报告本体和其他可用资源归档。
每份 HTML 使用独立命名空间，即使同一 Task 的多个 pytest 在同一个工作目录并行执行、
生成同名媒体文件，各报告也不会在托管存储中互相覆盖。

对于遵循 `task/<run-id>/report/<filename>.html` 布局的 Run，平台在 HTML 和全部媒体依赖归档成功、
没有 `media_partial` 警告，并确认 `videos` 中每个文件都已登记为同一 Step Run 的托管资源后，
删除该 Run 的项目临时目录 `task/<run-id>/videos`。未挂载文件会让整个目录保留并产生
`skill.report.project_media_cleanup_deferred` 工作日志。这只删除项目本地副本；平台不从此路径
推导或删除 `/data/jenkins/videos` 等源目录。目录检查或删除失败由 artifact 作业按原租约重试；
不符合该布局的历史报告不自动清理项目文件。

`codex-skill-report` 在发布新报告的同一事务中取得其 artifact 作业租约并完成归档，Worker 不会
并发复制同一份媒体；发布进程异常退出后，Worker 在租约到期时接管。相同 `reportKey` 的后续
修订中的每个 artifact 如果 Step Run、key、kind、绝对路径和源文件 SHA-256 与历史修订一致，
会直接复用最近一次完整归档的 artifact URL；即使本次修订新增失败分析等其他 artifact，
未变化的 HTML 和媒体也不会重复归档。相同路径的 HTML 内容发生变化时仍创建新的独立归档。

平台托管报告的 video viewed 状态以 HTML artifact 为作用域存入 SQLite，不区分查看人。任意
电脑点击后，其他电脑重新打开或刷新同一 artifact 即会显示 `(viewed)`。平台适配器兼容旧版
`.vm_video_link`，并约定新版 video 插件为链接提供稳定 `data-media-key`，点击时发送
`pytest-html-video-viewed` CustomEvent；平台通过 `pytest-html-video-viewed-state` 批量回传状态。
Viewed 状态初次恢复后，平台和新版 video 插件都只检查新增 DOM 子树；播放器标题和加载文字
变化不会触发全报告链接扫描。平台在服务历史 artifact 时会精确替换已知旧版 video Observer，
因此旧报告无需重归档。
直接打开本地 HTML 仍由插件自己的浏览器存储处理，不依赖平台接口。

平台提供 HTML 时会按客户端的 `Accept-Encoding` 协商 gzip，解压后的内容和原有报告一致；
HEAD 返回对应编码的长度，媒体资源及 Range 响应保持原有字节语义。
Video Check 展示只读取和改写 JSON 中的检查描述符，不再反复解析整个用例数据集。
对精确匹配的历史 pytest-html 渲染脚本，超过 200 个用例时先展示首批结果，后台分批准备其余行，
合并插入以减少重复布局；加载期间显示进度，排序、筛选和详情操作会取消上一轮尚未完成的渲染。
无原生图片/视频 extras 的用例使用轻量模板，不创建隐藏播放器；有原生媒体的用例保留画廊。
排序及折叠复用内容未变化的行，筛选掉的行会释放并停止其原生媒体，避免每次操作重建整份报告。
Video Check 以格式化文本缓存最近 32 份详情，并限制缓存预算为 8 MiB；超预算响应仍完整展示。
读完脚本后释放全局载荷，关闭详情后清除大段展示文本；
再次打开已淘汰详情时重新加载。该缓存策略不限制用例或文件访问。
较大的 Video Check JSON 详情仅绘制滚动窗口内的行，可滚动查看全部数据、全文查找和复制完整
JSON，避免一次排版数十万行；小详情保留普通文本展示。关闭详情时回收窗口及其文本引用。
支持 Popover 的浏览器还可点击“放大结果”，在固定窗口阅读同一份完整 JSON。
全部用例和字段都会保留，未匹配的脚本继续使用原渲染逻辑。这些转换只作用于 HTTP 展示，
不修改归档原件、摘要或用户本地 HTML，不需要重新发布历史报告。
页面仍保存当前筛选结果的全部行和报告数据，内存随结果规模变化；本功能不提供固定内存上限。

Viewed 仅记录同 artifact 的链接被点击，不验证播放成功、观看时长或身份。运行中登记快照没有此托管 artifact 作用域，不承诺共享 Viewed；托管资源可读取也不保证客户端能解码 HEVC 等格式。

同一 Task 的多个独立后台 pytest 应先登记为明确的 Step Run，再分别使用各自的 `TRACKING_ID` 和 `reportKey` 上报，可以在同一目录并行执行。Step 是 `normal`、`long` 等稳定范围；Rerun 是同 Step 下的新 Run；技术 Retry 复用 `STEP_RUN_ID`，只增加 External Attempt generation。一个受控后台命令内连续执行多个 pytest，或一次执行产生多个 HTML 时，启动登记重复提交 `--artifact`，终态报告统一继承。不同报告和不同 HTML artifact 的托管目录相互隔离。

归档会保留 HTML 主体和 pytest 日志的原始字节（仅为内嵌本地 CSS、改写托管资源链接和平台兼容脚本而生成托管副本），不会改写凭据值，也不会修改原始业务文件。历史维护命令不再执行凭据清理，只做完整性校验和只读统计；报告内容一旦发布即作为测试证据保留。

新上报契约不兼容旧 Task 的历史补录。旧报告仍可读取其已经托管的 artifact；平台只在当前报告发布时，且拥有匹配的 External Attempt 和 META 工作目录证据时，补登记具体 pytest `--html` 输出。

Metric 包含唯一 `key`、`label`、标量 `value` 和 `tone`。`tone` 可为 `neutral`、`info`、`success`、`warning` 或 `danger`。

所有 Section 都包含：

| 字段 | 值 |
| --- | --- |
| `id` / `title` | 报告内唯一 ID 和标题 |
| `kind` | `fields`、`list`、`table` 或 `json` |
| `priority` | `primary`、`supporting` 或 `debug` |
| `sensitivity` | `normal`、`internal` 或 `sensitive` |
| `defaultExpanded` | 是否默认展开；`sensitive` 和 `json` 会被强制改为 `false` |
| `description` | 可选说明，最多 1000 字符 |

`fields` 最多 48 项，每项有 `label`、标量 `value`、`format` 和 `tone`。`list` 最多 100 项。`table` 需要 1..12 列、最多 200 行。`json` 的 `data` 必须可序列化。显示格式可为 `text`、`code`、`status`、`datetime`、`duration`、`bytes` 或 `url`。

## Cloud Recording 示例

```json
{
  "schemaVersion": 2,
  "reportKey": "cloud-recording:curated-3",
  "skillId": "cloud-recording-test",
  "reportType": "test-result",
  "title": "Cloud recording result",
  "status": "partial",
  "summary": "Three cases completed: 2 passed and 1 failed.",
  "observedAt": "2026-08-04T12:14:20.000Z",
  "executionEvidence": {
    "externalAttemptId": "external-cloud-recording-20260804"
  },
  "artifacts": [
    {"key":"normal","kind":"pytest-html","path":"/protected/task/cloud-recording-normal.html"},
    {"key":"long","kind":"pytest-html","path":"/protected/task/cloud-recording-long.html"},
    {"key":"failure-analysis","kind":"failure-analysis-markdown","path":"/protected/task/failure-analysis.md"}
  ],
  "primaryExecution": {
    "label": "Cloud recording pytest",
    "command": "python3 -m pytest -v test_cloud_recording.py --ak <AK_FROM_ENV> --sk <SK_FROM_ENV> --html /protected/task/cloud-recording-normal.html && python3 -m pytest -v -m long --html /protected/task/cloud-recording-long.html",
    "workingDirectory": "/home/jenkins/premium_robot",
    "commandPath": "/protected/task/cloud-recording.cmd",
    "status": "partial",
    "exitCode": 1,
    "startedAt": "2026-08-04T12:11:56.000Z",
    "finishedAt": "2026-08-04T12:14:20.000Z"
  },
  "metrics": [
    {"key":"passed","label":"Passed","value":2,"tone":"success"},
    {"key":"failed","label":"Failed","value":1,"tone":"danger"},
    {"key":"duration","label":"Duration","value":"2m 23s","tone":"neutral"}
  ],
  "sections": [
    {
      "id":"business-result",
      "title":"Business result",
      "kind":"fields",
      "priority":"primary",
      "defaultExpanded":true,
      "fields":[
        {"label":"Outcome","value":"2 passed / 1 failed","format":"status","tone":"warning"},
        {"label":"Failed case","value":"test_check_ncs[live-uploaded-mix]","format":"code","tone":"danger"},
        {"label":"Expected","value":"serviceType=2","format":"code","tone":"neutral"},
        {"label":"Actual","value":"serviceType=1","format":"code","tone":"danger"}
      ]
    },
    {
      "id":"current-state",
      "title":"Current state",
      "kind":"fields",
      "priority":"primary",
      "defaultExpanded":true,
      "fields":[
        {"label":"Execution","value":"finished","format":"status","tone":"success"},
        {"label":"Exit code","value":1,"format":"code","tone":"danger"}
      ]
    },
    {
      "id":"runtime-evidence",
      "title":"Runtime evidence",
      "kind":"fields",
      "priority":"debug",
      "defaultExpanded":false,
      "fields":[
        {"label":"Log","value":"/protected/task/cloud-recording.log","format":"code","tone":"neutral"}
      ]
    },
    {
      "id":"raw-payload",
      "title":"Raw payload",
      "kind":"json",
      "priority":"debug",
      "defaultExpanded":false,
      "data":{"classification":"product_bug_candidate"}
    }
  ]
}
```

Skill 应在启动后台执行后发布 `status=running` 的首个修订，并在获准收集结果后发布 `succeeded`、`partial`、`failed` 或 `cancelled` 的最终修订。

## GW 部署示例

```json
{
  "schemaVersion": 2,
  "reportKey": "cloud-recording-gw:release-20260804",
  "skillId": "cloud-recording-gw-deploy",
  "reportType": "deployment-result",
  "title": "Cloud recording GW deployment",
  "status": "succeeded",
  "summary": "Requested components are running with the expected images.",
  "artifacts": [],
  "metrics": [
    {"key":"verified","label":"Verified","value":3,"tone":"success"},
    {"key":"failed","label":"Failed","value":0,"tone":"success"}
  ],
  "sections": [
    {
      "id":"deployment-summary",
      "title":"Deployment summary",
      "kind":"fields",
      "priority":"primary",
      "defaultExpanded":true,
      "fields":[
        {"label":"Result","value":"succeeded","format":"status","tone":"success"},
        {"label":"Version","value":"release-20260804","format":"code","tone":"neutral"}
      ]
    },
    {
      "id":"component-verification",
      "title":"Component verification",
      "kind":"table",
      "priority":"primary",
      "defaultExpanded":true,
      "columns":[
        {"key":"component","label":"Component","format":"text"},
        {"key":"state","label":"State","format":"status"},
        {"key":"image","label":"Image","format":"code"}
      ],
      "rows":[
        {"component":"daemon","state":"running","image":"registry/example/daemon:release-20260804"},
        {"component":"guard","state":"running","image":"registry/example/guard:release-20260804"}
      ]
    },
    {
      "id":"worker-containers",
      "title":"Worker container detail",
      "kind":"table",
      "priority":"supporting",
      "defaultExpanded":false,
      "columns":[
        {"key":"name","label":"Container","format":"code"},
        {"key":"imageId","label":"Image ID","format":"code"}
      ],
      "rows":[{"name":"gw_worker_1","imageId":"sha256:example"}]
    },
    {
      "id":"commands",
      "title":"Commands and raw evidence",
      "kind":"json",
      "priority":"debug",
      "sensitivity":"internal",
      "defaultExpanded":false,
      "data":{"commands":["pull_tag.sh release-20260804"],"skipped":[]}
    }
  ]
}
```

前端按 Schema 的 `kind` 渲染字段、列表、表格和 JSON，不应为某个业务类型增加硬编码字段。需要扩展表达能力时应升级 Schema 和验证器，而不是把领域判断放进页面。
