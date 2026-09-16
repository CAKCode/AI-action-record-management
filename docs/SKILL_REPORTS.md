# Skill 结构化报告

Skill 结构化报告把业务结论与终端原始输出分开。Skill 负责生成领域内容，平台只校验并持久化通用 Schema，前端不识别 cloud recording、GW 或其他业务字段。

推荐展示顺序：

1. 主业务命令使用顶层 `primaryExecution`，在任务终端最上方默认展开。
2. 业务结果和当前状态使用 `priority=primary`、`defaultExpanded=true`。
3. 其余命令、日志、路径、容器详情和诊断证据使用 `supporting` 或 `debug`，默认折叠。
4. 原始 payload 使用 `kind=json`；服务端和前端都会强制折叠。
5. 可能包含内部信息的区块标记 `sensitivity=internal`；高敏感区块标记 `sensitive` 并强制折叠。

折叠只是展示策略，不是权限边界。测试分析模式按原始证据保存报告内容，API、报告页和 HTML artifact 都可以返回完整的 AK、SK、Token、Authorization、Cookie、密码及其他凭据值；这些值不会因为命中凭据特征而触发脱敏或中断。由于报告可能包含高敏感信息，部署环境必须限制报告、日志、备份和恢复包的访问范围。

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

每份报告都必须显式包含 `artifacts` 数组；没有文件时使用 `[]`。运行中和终态 Run 报告都把 `codex-background-track register` 返回的 `TRACKING_ID` 写入 `executionEvidence.externalAttemptId`；平台由此写入并返回 `stepRunId`。启动时已经知道的每份 HTML 应同时通过可重复的 `--artifact pytest-html:<stable-key>:<absolute-path>` 登记到 External Attempt。若运行中报告遗漏了这一步，平台会在 `primaryExecution.command` 含有具体 pytest `--html` 输出、且报告工作目录与 External Attempt 的 META 工作目录一致时安全补登记；不满足这些条件不会猜测文件。运行中报告发布后，平台立即以 `registeredArtifacts` 返回登记项的安全展示字段和受控快照 URL，不返回源路径；平台再把登记项自动合并进每一版终态报告并归档。终态才生成的 Fail Markdown 由终态报告显式追加。报告 revision、后台执行和 artifact 必须属于同一 Step Run。

`cloud-recording-test`、`cloud-recording-gw-deploy` 和 `rtsc-cicd-deploy` 在 Task 进入待审核状态时，如已有 `codex-skill-use` 自动 invocation 或旧命令归因、但最新报告仍是 `pending`、`running` 或 `unknown`，平台会生成一份 `platform-fallback:*` 终态报告，避免业务轨迹缺少结论。测试兜底使用关联的 External Attempt 状态；部署兜底优先使用该 Skill 最后的非 `codex-skill-report` invocation，旧数据再使用命令归因，避免后续 pytest 的退出码覆盖部署结果。该报告明确标注为兜底，只包含平台已经持久化的状态与退出码。CICD/GW 每个 `reportKey` 只要求开始和结束两个 revision；业务轨迹只投影首条开始和最后一条终态结束，历史中间 revision 仍保留用于审计但不再显示为业务节点。其他报告仍只投影最新 revision。

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
| `executionEvidence` | 有 artifact 时必填 | 本次后台执行的 `externalAttemptId` |
| `primaryExecution` | 可选对象 | 生成本报告的主业务执行，前端醒目展示 |
| `artifacts` | 必填数组，最多 32 项 | 需要托管的文件声明；没有文件时为 `[]` |
| `metrics` | 最多 12 项 | 顶部关键指标 |
| `sections` | 1..16 项 | 通用内容区块 |

`primaryExecution` 包含必填的 `label` 和原始 `command`，以及可选的
`workingDirectory`、`commandPath`、`status`、`exitCode`、`startedAt` 和
`finishedAt`。`command` 最长 32 KiB，保留实际参数和值以便测试分析。该字段只保存主业务命令；
辅助检查和 Agent 自身命令仍由命令审计记录保存。除上述严格的 pytest `--html` 补登记外，
`primaryExecution` 不授权或发现任意 artifact。

`artifacts` 每项包含唯一 `key`、`kind` 和绝对 `path`。当前 `kind` 支持
`pytest-html` 和 `failure-analysis-markdown`；前者必须使用 `.html`/`.htm`，后者必须使用
`.md`。同一报告不能重复 key 或规范化路径，`pending`/`running` 报告不能声明文件。
运行中的报告仍使用 `artifacts=[]`；其 `registeredArtifacts` 是平台根据同一 External Attempt
的显式登记或严格的 pytest `--html` 补登记生成的只读响应字段，不是 Skill 上报字段。每项只包含 `key`、`kind`、`fileName`、
`executionStatus` 和受认证 `url`。文件已经生成时，该 URL 打开请求开始时已有字节的
`private, no-store` 快照；文件未生成时返回 `404`。HTML 使用 sandbox CSP，且拒绝符号链接、
非普通文件和超过 64 MiB 的源文件。运行中快照依赖业务工作目录，不具备终态托管副本的
持久性或完整性摘要保证。

平台按 `executionEvidence.externalAttemptId` 精确查询当前 Task 已登记的后台执行，校验其原始
Turn/Attempt 归属、终态和 META 中的绝对工作目录。新 External Attempt 的每个 `pytest-html`
必须精确匹配启动登记时保存的 kind、key 和绝对路径，并位于 META 工作目录内；因此直接 pytest
和通过 `--report` 等参数传递路径的 wrapper 使用同一套证据格式。
`failure-analysis-markdown` 不要求出现在 pytest 命令中，但必须位于同一工作目录内。普通
Section 仍可展示路径，但不参与归档。每个不超过 64 MiB 的普通 HTML 或 Markdown 文件独立复制到任务
托管存储，`artifacts` 会为每份文件返回不同的 ID、稳定 key、文件名、大小、SHA-256 和
受控打开 URL，前端逐份显示打开入口。路径必须留在该执行目录内，不能使用环境变量、
命令替换或符号链接逃逸。某一候选缺失、超限或校验失败时，平台仍继续处理其余候选，
最后汇总返回错误；已经成功归档的文件保持可打开，重试不会重复登记。
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
`--html task/<run-id>/report/result.html --html-video-source-dir ../videos`；video 插件从源目录
复制到该 Run 的 `videos/`，平台只从这份项目副本归档。
资源必须是执行目录内的普通文件；某个资源已经丢失时，平台保留原链接并写入
`skill.report.artifact.media_partial` 工作日志，不阻塞 HTML 报告本体和其他可用资源归档。
每份 HTML 使用独立命名空间，即使同一 Task 的多个 pytest 在同一个工作目录并行执行、
生成同名媒体文件，各报告也不会在托管存储中互相覆盖。

对于遵循 `task/<run-id>/report/result.html` 布局的 Run，平台在 HTML 和全部媒体依赖归档成功、
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
