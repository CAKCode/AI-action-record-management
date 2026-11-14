# 固定上报卡片规范

模板版本：**Card Templates v1**。发布协议继续使用 **Schema v2**。

不同业务共用下面五类卡片，统一标题、状态、结论、指标、报告文件和可展开详情的顺序。
业务 Skill 提供真实结果，上报 Skill 提供固定格式；平台负责展示、修订和文件归档。

从后台命令登记到 running/terminal 卡片发布的完整接入流程见
[Task 平台登记与卡片使用指南](TASK_PLATFORM_REPORTING.md)。

## 卡片目录

| 卡片 | 类型 / 预设 | 固定主要内容 | 示例数据 |
| --- | --- | --- | --- |
| 测试结果 | `test-result` | 本轮总数、Pass、Fail、Skip、Error、XFail；用例 / 结果 / 说明 | [首轮示例](../skills/task-reporting/examples/test-result.data.json) |
| 测试结果：重跑 | `test-result` + `rerun` | 重跑用例、Pass、Fail、恢复、仍需处理；原执行与重跑范围 | [重跑示例](../skills/task-reporting/examples/rerun.data.json) |
| 部署结果 | `deployment-result` | 目标数、成功、失败、耗时；目标 / 组件 / 版本 / 结果；开始与结束时间 | [部署示例](../skills/task-reporting/examples/deployment-result.data.json) |
| 失败分析 | `failure-analysis` | 已分析、确认问题、待确认；用例 / 分类 / 证据 / 下一步 | [分析示例](../skills/task-reporting/examples/failure-analysis.data.json) |
| 流程进度 | `workflow-progress` | 阶段总数、已完成、失败；阶段 / 结果 / 说明 | [流程示例](../skills/task-reporting/examples/workflow-progress.data.json) |
| 流程进度：最终汇总 | `workflow-progress` + `final-summary` | 累计与最终两组总数、Pass、Fail；Skip、Error、XFail、XPass、未知与统计来源 | [最终汇总示例](../skills/task-reporting/examples/final-summary.data.json) |
| 通用业务结果 | `business-result` | 业务指标及结果字段；范围与证据 | [通用示例](../skills/task-reporting/examples/business-result.data.json) |

重跑和最终汇总是现有卡片的填写预设，未增加新的 `reportType`。表中示例都是演示数据，
实际登记时替换为本轮执行结果。完整字段定义见 [上报字段参考](../skills/task-reporting/references/cards.md)。

## 固定填写方式

1. **标题**写业务阶段或本轮执行名称；`reportKey` 固定标识这一逻辑报告。
2. **状态**写真实业务结果；任务“待确认”与测试 Pass/Fail 分开。
3. **结论**用一两句说明完成情况、主要结果和剩余工作。
4. **指标**使用上述固定 key 和顺序。未知指标不填，真实的零保留。
5. **报告文件**保留每份实际 HTML / 分析文件的稳定 key 和原始文件名。
6. **详情**放在固定主表、`context`、`evidence` 或扩展 `sections`；完整命令只放在 `primaryExecution`。

单个执行产生多份 HTML 时登记在同一逻辑报告中。同一阶段包含多个独立执行时，
用 `relatedReportKeys` 关联子报告，保留各自的 Skill、External Attempt 和文件归属。
预检、collect-only、定时检查、文件清单和归档核验写入阶段详情或 Worklog，不额外拆卡。
最终汇总继续使用一个稳定 key；此前阶段卡的引用写在详情中，避免把阶段卡折叠掉。

## 生成与发布

查看机器可读的目录和字段：

```bash
codex-skill-report cards
```

将真实统计、明细行和证据保存为结果数据文件，再生成固定格式：

```bash
codex-skill-use <实际测试Skill> -- codex-skill-report template \
  --type test-result --report-key <run-key> --data <run-dir>/results.json \
  --external-attempt <TRACKING_ID> --output <run-dir>/report.json

codex-skill-use <实际测试Skill> -- codex-skill-report publish \
  --file <run-dir>/report.json
```

重跑加 `--preset rerun`；最终汇总使用 `--preset final-summary`，无需另造卡片类型。
`--lang en` 生成英文标签，默认使用中文标签；业务标题、结论和证据保留输入原文。
生成器只组装文件，不调用模型、不启动任务、不自动发布。

前台分析的 `--data` 可包含 `executionEvidence: {"commandExecutionId":"execution-实际命令ID"}`，
模板会保留该关联和终态附件。默认分析 HTML 使用 `failure-analysis-html`；选择 Markdown 时使用
`failure-analysis-markdown`。文件分别使用 `.html`/`.htm` 和 `.md`，不需要冒用 `pytest-html`。

最终统计可直接使用 `GET /api/sessions/:id/pytest-summary` 的响应作为 `--data` 输入，
再提供本轮真实的标题、状态和简短结论：

```bash
codex-skill-use <实际工作流Skill> -- codex-skill-report template \
  --preset final-summary --report-key <workflow-key>:summary \
  --data <run-dir>/pytest-summary.json --status partial \
  --title '本轮最终汇总' --summary '重跑后仍有失败项，详见统计和分析。' \
  --output <run-dir>/final-report.json
```

示例中的 `partial` 和结论需按实际结果填写。`available=false` 时不把占位零值填入卡片；`complete=false` 时保留统计未完整这一事实，
不能用失败子集推断整轮通过。总数包含 Skip、XFail 等结果；累计包含重跑，最终以对应目标的
最新结果覆盖原结果。不要将首轮与重跑简单相加作为最终结果。

## 兼容与生效

- 标准目录的代码定义位于 [report-cards.js](../public/report-cards.js)，CLI 与页面共用。
- 历史报告、自定义类型和扩展业务区块继续保留；此规范不增加发布类型白名单。
- `running` 卡片保持 `artifacts: []`，预览入口来自启动时登记；终态继承 HTML 登记。
- 部署仍按原工作流登记开始和结束，不增加中间上报或定时模型调用。
- 源 Skill 更新用于后续新任务快照；已有任务的冻结快照保持原样。

发布协议和归档边界见 [Skill 结构化报告](SKILL_REPORTS.md)。
