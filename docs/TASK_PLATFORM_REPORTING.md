# Task 平台登记与卡片使用指南

本文面向需要把测试、部署、失败分析或其他业务结果登记到 Task 平台的 Skill 作者和维护者。
平台登记由两部分组成：先登记真实执行，再发布结构化卡片。执行登记保存 PID、LOG、DONE、STATE、META
和 artifact 归属；结构化卡片负责展示状态、指标、业务结论和可展开详情。两者使用同一个真实执行身份
关联，不能用一个虚假的汇总执行代替多个真实执行。

平台卡片协议当前使用 **Card Templates v1 + Schema v2**。五种卡片类型决定展示方式，不限制业务 Skill
名称、项目名称或历史 `reportType`。固定字段和可运行示例见[固定上报卡片规范](REPORT_CARD_TEMPLATES.md)
和[字段参考](../skills/task-reporting/references/cards.md)。

## 一次登记的完整链路

托管 Task 中，业务 Skill 应按下面顺序执行：

```text
业务命令启动
  -> 登记 External Attempt、Step/Run 和已知 artifact
  -> 发布同一 reportKey 的 running 卡片
  -> 业务命令结束，Worker 核对 DONE/STATE/META
  -> 发布同一 reportKey 的 terminal 修订
  -> 平台归档已登记的 HTML、日志和媒体资源
```

一个逻辑 Run 使用一个稳定 `reportKey`。运行中和终态是同一张卡片的不同 revision；不要为终态另造
`final-result` 或 `final-evidence` 卡片。独立的业务重跑使用新的 Run 和新的 `reportKey`，技术重试仍是
同一个 Step Run 下的 External Attempt generation。

## 开始前的条件

业务 Skill 在托管 Task 中必须能读取这些平台变量：

| 变量 | 用途 |
| --- | --- |
| `CODEX_TASK_ID` | 当前 Task ID |
| `CODEX_TASK_TURN_ID` | 当前 Turn ID |
| `CODEX_TASK_ATTEMPT_ID` | 当前 Attempt ID |
| `CODEX_TASK_SKILL_SNAPSHOT` | 当前 Task 冻结的 Skill 快照 |
| `CODEX_TASK_WORKSPACE_MODE` | `shared` 或 `session-clone` |
| `CODEX_TASK_SESSION_ROOT` | Session 模式的 Task 根目录 |

所有平台 CLI 都应通过实际执行业务的 Skill 包装：

```bash
codex-skill-use <实际业务Skill> -- <平台CLI> ...
```

这样平台才能记录真正执行命令的 Skill、版本和内容哈希。没有托管 Task 上下文时，不要伪造
`externalAttemptId`、`commandExecutionId` 或 Task ID；业务结果可以正常完成，但跳过平台卡片发布并在业务回复中说明。

`shared` 模式使用业务项目的当前工作目录；`session-clone` 模式登记范围使用
`CODEX_TASK_SESSION_ROOT`，源代码和 Run 输出分别位于 Session 的 `source/` 与 `task/` 子树。两种模式都必须让
LOG、DONE、STATE、META、HTML 和其他可变输出使用本轮唯一的 Run 路径，避免并行 Run 覆盖文件。

平台保存 stdout、stderr、CLI transcript、后台日志和报告文件的原始内容。卡片是这些原始证据的结构化索引，
不能用卡片摘要替换日志，也不能为了页面展示改写或屏蔽原始日志。卡片字段只填写业务结论、指标和可展示的执行信息。

## 五种卡片怎么选

| 类型 | `reportType` | 适用场景 | 主要内容 |
| --- | --- | --- | --- |
| 测试结果 | `test-result` | pytest、接口验证、兼容性回归、重跑 | 用例/结果/说明、Pass/Fail/Skip/Error/XFail、HTML |
| 部署结果 | `deployment-result` | 服务、组件或镜像部署 | 目标、组件、版本、开始/结束时间、结果 |
| 失败分析 | `failure-analysis` | 对已完成执行做归因、聚类和下一步判断 | Finding、分类、证据、预期/实际、下一步 |
| 流程进度 | `workflow-progress` | 多阶段提测、发布流程、最终汇总 | 阶段、完成数、失败数、累计与最终结果 |
| 通用业务结果 | `business-result` | 覆盖率、代码交付、巡检或其他业务结果 | 业务自定义指标、范围、证据和结论 |

`rerun` 和 `final-summary` 是填写预设，不是新的 `reportType`：

- `--preset rerun` 继续使用 `test-result`，展示 selected、passed、failed、recovered、persistent。
- `--preset final-summary` 继续使用 `workflow-progress`，区分 cumulative 和 final 结果。
- 业务结果不适合其他四类时使用 `business-result`，不要为了套模板伪造测试数量。

### 测试结果卡片

一个逻辑 pytest Run 只发布一张 `test-result` 卡片。一次执行产生多份 HTML 时，在同一个 External Attempt
上重复 `--artifact` 登记，并把所有 HTML 放入这一张卡片；不要按 mark、HTML、collect-only 或归档检查拆卡。

建议固定使用：

- `reportKey`：`<业务前缀>:<run-key>`。
- 指标：`total`、`passed`、`failed`、`skipped`、`error`、`xfailed`、`duration`。
- 主表：`case`、`outcome`、`detail`。
- 运行中：`status=running`、`artifacts=[]`、`executionEvidence.externalAttemptId=<TRACKING_ID>`。
- 终态：保留同一个 `reportKey` 和 `externalAttemptId`，填写真实退出码、计数和 artifact。

### 部署结果卡片

部署 Skill 使用 `deployment-result`，每个真实部署阶段保留开始和结束事实。目标表至少包含 target、component、version、outcome；
部署到多个主机时仍可在一张卡片中展示一批目标。不要按主机创建多个没有业务意义的卡片，除非它们是独立的真实执行。

### 失败分析卡片

失败分析必须建立在已经完成的测试或业务执行之上。分析卡片的 `executionEvidence` 应指向生成分析文件的实际前台命令：

```json
{
  "executionEvidence": {"commandExecutionId": "execution-that-wrote-analysis"},
  "artifacts": [{
    "key": "full-analysis",
    "kind": "failure-analysis-html",
    "path": "/absolute/run/failure_analysis.html"
  }]
}
```

分析 HTML 用 `failure-analysis-html`，Markdown 用 `failure-analysis-markdown`，不要把分析文件伪装成
`pytest-html`。多个测试 Run 的分析可以关联多个来源，但应绑定实际生成分析文件的那条前台命令。

### 流程进度卡片

`workflow-progress` 用于阶段型流程和最终汇总。阶段卡展示 planned stages、completed、failed 和每阶段详情；
最终汇总使用稳定的 `<operation-id>:summary`，不要再创建第二张 final 卡片。

如果一个阶段包含多个独立 External Attempt：

- 每个真实执行保留自己的子报告、Skill、Step Run、External Attempt 和 artifact。
- 父阶段卡使用 `relatedReportKeys` 关联子报告。
- 父阶段卡保持 `artifacts: []`，不设置 `executionEvidence`，不把某个子执行的 HTML 复制到父卡片。

### 通用业务结果卡片

`business-result` 适用于覆盖率、代码交付、巡检、配置核对和其他没有测试/部署语义的结果。指标和 sections
可以按业务定义，但仍需填写真实 `title`、`summary`、`status` 和执行证据；不要用 `business-result` 隐藏缺少执行证据的问题。

## 标准登记命令

### 1. 登记后台执行和 artifact

后台命令使用 `run-in-background` 生成 PID、LOG、DONE、STATE、META 后，在同一托管 Turn 中登记：

```bash
codex-skill-use <实际业务Skill> -- codex-background-track register \
  --pid "$PID" \
  --log "$LOG" \
  --done "$DONE" \
  --state "$STATE" \
  --meta "$META" \
  --step-key <step-key> \
  --step-label '<业务阶段>' \
  --run-key <run-key> \
  --run-kind initial \
  --artifact pytest-html:<scope>:<run-key>:/absolute/path/to/report.html \
  --json
```

同一次执行产生多份 HTML 时重复 `--artifact`，每份使用不同的稳定 key：

```bash
--artifact pytest-html:group-a:<run-key>:/absolute/path/to/group-a.html \
--artifact pytest-html:group-b:<run-key>:/absolute/path/to/group-b.html
```

保存命令返回的 `STEP_ID`、`STEP_RUN_ID`、`TRACKING_ID` 和 artifact 数量到 Worklog。登记已存在时，先核对原
`STEP_RUN_ID`、`TRACKING_ID` 和 artifact 声明，再复用原登记；不要新建 Task、Run 或 artifact key。

### 2. 发布运行中卡片

运行中的卡片必须使用真实 `TRACKING_ID`，并保持 `artifacts: []`：

```bash
codex-skill-use <实际业务Skill> -- codex-skill-report template \
  --type test-result \
  --report-key <stable-report-key> \
  --status running \
  --external-attempt "$TRACKING_ID" \
  --data /absolute/run/observed-running.json \
  --output /absolute/run/report.json

codex-skill-use <实际业务Skill> -- codex-skill-report publish \
  --file /absolute/run/report.json
```

`template` 只生成 Schema v2 文件，不执行测试、不调用模型、不发布报告。实际业务 Skill 负责把真实状态、命令、计数和详情写入
`observed-running.json`，再由同一个 Skill 发布。

### 3. 发布终态修订

终态复用相同的 `reportKey` 和执行身份：

```bash
codex-skill-use <实际业务Skill> -- codex-skill-report template \
  --type test-result \
  --report-key <same-stable-report-key> \
  --status partial \
  --external-attempt "$TRACKING_ID" \
  --data /absolute/run/observed-terminal.json \
  --output /absolute/run/report-terminal.json

codex-skill-use <实际业务Skill> -- codex-skill-report publish \
  --file /absolute/run/report-terminal.json
```

终态状态按真实结果填写：`succeeded`、`failed`、`partial`、`cancelled` 或 `blocked`。不要因为平台登记失败就把业务测试结果改成失败；
登记失败单独写入 Worklog 和业务回复。

### 4. 前台分析文件

分析 HTML 由前台命令产生时，先查询当前 Task 的命令审计，选择真正写出该文件的 `commandExecutionId`：

```bash
codex-skill-use codex-task-platform-api -- node \
  "$CODEX_TASK_SKILL_SNAPSHOT/codex-task-platform-api/scripts/codex_task_api.js" \
  task executions "$CODEX_TASK_ID" --limit 100
```

然后通过分析 Skill 发布 `failure-analysis`，把该 ID 放进 `executionEvidence.commandExecutionId`，并把实际绝对路径放进
`failure-analysis-html` 或 `failure-analysis-markdown` artifact。只把文件路径写进普通 section 不会产生托管附件。

## 通用接入示例

下面的阶段划分适用于测试、部署、分析和覆盖率等不同类型的业务流程：

| 阶段 | 平台卡片 | 登记方式 |
| --- | --- | --- |
| 单个逻辑测试 Run | `test-result` | 一个 External Attempt；所有本轮 HTML 用多个 artifact 登记到同一张卡 |
| 多分组初始阶段 | 每个真实阶段一张 `test-result` | 子执行保留真实 Skill、Step Run、External Attempt |
| 失败重跑阶段 | `test-result` + `rerun` | `selected/passed/failed/recovered/persistent`，不把首轮和重跑简单相加 |
| 多阶段流程最终汇总 | `workflow-progress` + `final-summary` | `<operation-id>:summary` 贯穿整个流程 |
| 服务或组件部署 | `deployment-result` | 目标、组件、版本、结果和开始/结束时间 |
| 失败分析阶段 | `failure-analysis` | 使用生成分析文件的 `commandExecutionId` |
| 覆盖率或代码交付 | `business-result` | 记录分支、基线、验证范围和交付证据 |

一个全量 runner 即使产生多份 HTML，也只发布一张逻辑 `test-result` 卡片。多个独立 rerun 组由父流程用
`relatedReportKeys` 聚合；父卡片不接管子执行的 artifact。准备源码、collect-only、失败清单提取、轮询、归档核验和最终证据写入
阶段详情或 Worklog，不单独创建卡片。

## 报告字段最小要求

每张可见卡片至少应满足：

| 字段 | 要求 |
| --- | --- |
| `schemaVersion` | 固定为 `2` |
| `reportKey` | 同一逻辑报告的 running/terminal revision 保持不变 |
| `skillId` | 实际执行该业务的 Skill，不要写成 `task-reporting` |
| `reportType` | 五种标准类型之一，历史自定义值继续兼容 |
| `title` / `summary` | 写当前业务事实，不使用模板占位文本 |
| `status` | 写真实观测状态，不用平台 Task 状态代替业务结果 |
| `primaryExecution` | 实际命令、工作目录、开始/结束时间、退出码 |
| `executionEvidence` | 后台用 `externalAttemptId`，前台用 `commandExecutionId`；聚合父卡可为空 |
| `artifacts` | 运行中为 `[]`；终态只放已知且实际存在的文件 |
| `sections` | 业务事实、结果表、证据和下一步 |

未知数字省略，真实的零保留。首轮和重跑分别保留自己的结果范围；最终汇总使用 verified ledger 或
`GET /api/sessions/:id/pytest-summary` 的实际结果，不从失败子集推断全量结果。

## 接入新业务 Skill 的检查表

在业务 Skill 中新增平台登记时，逐项确认：

1. 明确一个业务阶段对应的 `step-key`、`step-label`、`run-key` 和 `reportKey` 规则。
2. 为每个后台执行生成唯一 LOG/DONE/STATE/META/HTML 路径。
3. 用 `codex-background-track register` 登记真实 PID 和所有已知 HTML。
4. 保存 `STEP_ID`、`STEP_RUN_ID`、`TRACKING_ID` 和 artifact key 到 Worklog。
5. 先发布 `status=running` 卡片，再在终态发布同一 `reportKey` 的修订。
6. 让 `executionEvidence` 与真实 External Attempt 或命令审计 ID 一致。
7. 多份 HTML 放在同一逻辑报告；多个独立执行使用子报告和 `relatedReportKeys`。
8. 分析文件使用实际生产该文件的 `commandExecutionId`。
9. 不创建预检、轮询、归档核验、最终证据等重复卡片。
10. 验证平台页面能看到 running、terminal、artifact URL、原始日志和 Worklog 之间的关联。

## 常见错误

| 错误 | 正确处理 |
| --- | --- |
| 终态重新生成一个 `reportKey` | 复用 running 的 `reportKey`，发布下一 revision |
| 运行中报告直接填写 HTML artifact | 运行中保持 `artifacts: []`，HTML 在启动登记时声明 |
| 一个 HTML 建一张卡 | 同一执行的多个 HTML 放入一张卡，使用不同 artifact key |
| 父阶段复制子执行的 HTML | 父卡保持 `artifacts: []`，用 `relatedReportKeys` 关联子卡 |
| 用 `.cmd`、日志或目录扫描补登记 | 在启动命令中显式重复 `--artifact`，平台不替你猜测文件 |
| 用 `pytest-html` 标记分析 HTML | 使用 `failure-analysis-html` 或 `failure-analysis-markdown` |
| 把平台登记失败改写成业务失败 | 分开记录平台登记错误和业务执行结果 |
| 把首轮和重跑数量相加 | 使用 rerun/final-summary 语义，按目标的最终结果计算 |

## 进一步阅读

- [固定上报卡片规范](REPORT_CARD_TEMPLATES.md)：卡片模板、指标和演示数据。
- [Skill 结构化报告](SKILL_REPORTS.md)：Schema、artifact 生命周期和归档边界。
- [task-reporting 字段参考](../skills/task-reporting/references/cards.md)：完整字段和前台分析 HTML 示例。
- 业务 Skill 的平台报告参考章节：应包含本 Skill 使用的卡片类型、阶段 key、External Attempt、artifact 和终态修订规则。
