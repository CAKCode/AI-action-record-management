# Codex Task Sessions

Codex Task Sessions 是一个面向 Codex 执行任务的持久化工作台。它把一次自然语言请求从排队、执行、后台测试、报告生成、失败重跑到归档串成一条可追溯的 Task 生命周期。

## 作品定位

项目解决的是长时间、易中断、需要留证据的自动化工作流问题。每个 Task 拥有持久 Session，可以连续执行多个 Turn；后台命令通过 PID、LOG、DONE、STATE、META 登记，Worker 在 Codex 退出后继续观察，终态时恢复同一 Session 收集结果。

平台同时提供 Web 控制面和 HTTP API，覆盖任务生命周期、版本周期、Skills、运行库存、报告、审计、备份和恢复检查点。执行结果以结构化报告卡呈现，pytest HTML、日志、视频、音频和 Video Check 结果可以在运行中预览，并在终态后进入受校验的托管归档。

## 核心能力

- **持久 Task 生命周期**：支持 New、Run、Stop、Reset、Restore 和 Complete，保留 Turn、Attempt、命令、审计和 Transcript。
- **可靠后台执行**：记录进程身份和进程组，支持幂等启动、技术重试、任务级恢复和独立的 External Attempt。
- **业务报告闭环**：统一展示测试结果、部署结果、失败分析、工作流进度和自定义业务报告；同一 Run 可以关联多份 HTML 报告和失败分析文档。
- **媒体归档与播放**：托管 pytest HTML 引用的 HLS、DASH、FLV、MP4、音频、日志和 Video Check 资源；资源有路径边界、SHA-256 和 Range 访问校验。
- **运行库存管理**：区分 Runtime、Task 归档、报告、媒体、播放缓存和 Skill 快照，支持回收 Runtime 或删除非活动 Task。
- **安全与可恢复性**：SQLite WAL、在线备份、平台恢复检查点、30 天媒体保留策略、幂等操作和审计记录共同保证故障后的可恢复性。
- **中文优先的操作界面**：总览、任务详情、结构化报告、Codex CLI、Agent 记录、后台调度和操作审计集中在同一个工作台中，同时适配桌面和移动端。

## 页面截图

### 任务摘要与最终结果

桌面端任务详情页把最终统计、回归命令、业务轨迹和报告入口放在同一视图中。截图中的真实验证数据包括累计 7,517 条、最终 7,437 条、6,750 通过和 25 条持续失败。

![桌面端任务摘要](screenshots/task-summary-desktop.png)

### 移动端任务详情

移动端保留任务状态、最终统计和操作入口，适合在企业微信等窄屏环境中快速查看结果。

![移动端任务摘要](screenshots/task-summary-mobile.png)

### 报告与产物

报告区域展示 HTML 报告的真实文件名、大小、状态和打开入口，支持展开完整路径、复制路径以及查看重跑结果。

![任务报告列表](screenshots/task-reports-desktop.png)

### 指令输入区

底部指令区支持查看下一步指令、展开输入框和保留草稿，避免在长任务执行期间丢失操作上下文。

![任务指令输入区](screenshots/task-composer-desktop.png)

## 验证结果

最近一次页面验证覆盖桌面端 `1440×1080` 和移动端 `390×844` 两个 viewport，确认了以下行为：

- 17 份报告和 25 个报告链接保留；
- 任务累计结果与最终重跑结果的统计一致；
- 文件名展开、路径复制、剪贴板降级和草稿保留均通过；
- 模拟提交不会产生真实任务变更；
- 两个 viewport 均无浏览器控制台错误。

仓库质量门禁：

```bash
npm run check
npm test
npm run audit:production
```

架构、API、部署、数据恢复、报告和媒体生命周期分别见 [`docs/ARCHITECTURE.md`](ARCHITECTURE.md)、[`docs/API.md`](API.md)、[`docs/OPERATIONS.md`](OPERATIONS.md)、[`docs/DATA_AND_RECOVERY.md`](DATA_AND_RECOVERY.md)、[`docs/SKILL_REPORTS.md`](SKILL_REPORTS.md) 和 [`docs/MEDIA_RETENTION.md`](MEDIA_RETENTION.md)。
