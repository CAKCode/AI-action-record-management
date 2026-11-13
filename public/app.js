// --- Session credential auth (for embedded browsers without Basic Auth dialog) ---
const AUTH_STORAGE_KEY = 'codex-tasks-auth-v1';

function getStoredCredentials() {
  try {
    const raw = sessionStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed.user || !parsed.pass) return null;
    return parsed;
  } catch { return null; }
}

function getAuthHeader() {
  const c = getStoredCredentials();
  if (!c) return null;
  return `Basic ${btoa(`${c.user}:${c.pass}`)}`;
}

function storeCredentials(user, pass) {
  sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ user, pass }));
}

function clearCredentials() {
  sessionStorage.removeItem(AUTH_STORAGE_KEY);
}

function showAuthOverlay(message) {
  const overlay = document.getElementById('authOverlay');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  const err = document.getElementById('authError');
  if (err) err.textContent = message || '';
  const user = document.getElementById('authUser');
  if (user && !user.value) setTimeout(() => user.focus(), 50);
}

function hideAuthOverlay() {
  const overlay = document.getElementById('authOverlay');
  if (overlay) overlay.classList.add('hidden');
}

function initAuthForm() {
  const form = document.getElementById('authForm');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const user = document.getElementById('authUser').value.trim();
      const pass = document.getElementById('authPass').value;
      if (!user || !pass) return;
      const submit = form.querySelector('button[type="submit"]');
      if (submit) submit.disabled = true;
      storeCredentials(user, pass);
      try {
        await api('/api/auth/session', { method: 'POST' });
        document.getElementById('authPass').value = '';
        hideAuthOverlay();
        await initialize();
      } catch (error) {
        clearCredentials();
        showAuthOverlay(error.message || 'Authentication failed');
      } finally {
        if (submit) submit.disabled = false;
      }
    });
  }
  const logout = document.getElementById('authLogout');
  if (logout) {
    logout.addEventListener('click', async () => {
      try {
        await api('/api/auth/session', { method: 'DELETE' });
      } catch {}
      clearCredentials();
      showAuthOverlay();
    });
  }
}

function wsAuthPrefix() {
  const c = getStoredCredentials();
  if (!c) return '';
  return `${encodeURIComponent(c.user)}:${encodeURIComponent(c.pass)}@`;
}

function storedLanguage() {
  try {
    const value = localStorage.getItem('codex-tasks-lang-v1');
    return ['zh', 'en'].includes(value) ? value : 'zh';
  } catch {
    return 'zh';
  }
}

const FONT_SIZE_STORAGE_KEY = 'codex-tasks-font-size-v1';
const FONT_SIZE_PRESETS = Object.freeze({
  small: { scale: 1, labelKey: 'fontSizeSmall' },
  standard: { scale: 1.125, labelKey: 'fontSizeStandard' },
  large: { scale: 1.25, labelKey: 'fontSizeLarge' },
});

function storedFontSize() {
  try {
    const value = localStorage.getItem(FONT_SIZE_STORAGE_KEY);
    return FONT_SIZE_PRESETS[value] ? value : 'standard';
  } catch {
    return 'standard';
  }
}

const state = {
  lang: storedLanguage(),
  fontSize: storedFontSize(),
  view: 'overview',
  taskFilter: 'current',
  taskProjectFilter: '',
  taskTagFilter: '',
  taskTestTypeFilter: '',
  taskOriginFilter: '',
  releaseCycles: [],
  selectedReleaseCycleId: '',
  releaseCycleTasks: [],
  releaseCycleAnalysis: null,
  releaseCycleAnalysisLoading: false,
  overviewCycleModal: { cycleId: '', business: '', page: 0, pageSize: 12, tasks: [], hasMore: false, loading: false, analysis: null, analysisLoading: false },
  overviewCycleModalRequestVersion: 0,
  expandedTaskObjectives: new Set(),
  taskContextExpanded: false,
  detailTab: 'business-summary',
  dashboard: { stats: {}, runtime: {}, sessions: [], recentAudit: [] },
  skills: [],
  audit: [],
  bridgeInventory: { summary: {}, sessions: [] },
  bridgeInventoryController: null,
  bridgeInventoryLoading: false,
  bridgeInventoryLoaded: false,
  protectionStatus: null,
  protectionController: null,
  protectionLoading: false,
  protectionLoaded: false,
  protectionCheckedAt: '',
  protectionError: '',
  protectionFailureCount: 0,
  bridgeReclaimSubmitting: false,
  selectedBridgeSessionId: '',
  currentTaskId: '',
  editingTaskId: '',
  editingSkillId: '',
  editingExecutionId: '',
  currentExecutions: [],
  currentSkillReports: [],
  skillUsage: null,
  dashboardSignature: '',
  dashboardPromise: null,
  dashboardUnavailable: false,
  dashboardFailureCount: 0,
  consoleController: null,
  attemptOutputLoad: null,
  expandedAttemptOutputKey: '',
  taskTerminalAutoOpen: false,
  codexTerminalView: null,
  interactiveCodexTerminalTaskId: '',
  auditController: null,
  taskLimit: 100,
  taskLimitMax: 500,
  auditOffset: 0,
  auditPageSize: 50,
  auditHasOlder: false,
  detailOffset: 0,
  detailPageSize: 50,
  detailHasOlder: false,
};

const renderCache = new Map();
const dateTimeFormatters = new Map();
const RUN_INTENT_STORAGE_KEY = 'codex-task-run-intents-v1';
const RUN_INTENT_STORAGE_LIMIT = 100;
const runIntents = loadRunIntents();
const pendingTaskRecoveries = new Set();
const TASK_OPERATION_INTENT_STORAGE_KEY = 'codex-task-operation-intents-v1';
const TASK_OPERATION_INTENT_STORAGE_LIMIT = 100;
const TASK_OPERATIONS = new Set(['stop', 'complete', 'restore', 'reset', 'delete']);
const taskOperationIntents = loadTaskOperationIntents();
const releaseCycleDeleteIntents = new Map();
let releaseCyclesRequestVersion = 0;
let releaseCycleTasksRequestVersion = 0;
let dashboardPollTimer = null;
let bridgeInventoryPollTimer = null;
let protectionPollTimer = null;
const API_REQUEST_TIMEOUT_MS = 30000;
const DASHBOARD_REQUEST_TIMEOUT_MS = 8000;
const CASE_PROGRESS_POLL_INTERVAL_MS = 5000;
const INLINE_ATTEMPT_OUTPUT_MAX_BYTES = 5 * 1024 * 1024;
const CODEX_CLI_INITIAL_REPLAY_MAX_BYTES = 64 * 1024 * 1024;
const CODEX_CLI_SCROLLBACK_LINES = 100000;
const ATTEMPT_OUTPUT_CHUNK_BYTES = 256 * 1024;
const ATTEMPT_OUTPUT_POLL_INTERVAL_MS = 750;
const ATTEMPT_OUTPUT_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const EXTERNAL_ATTEMPT_TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'lost', 'cancelled']);
const TERMINAL_BACKGROUND_SCHEDULE_MESSAGE = 'Background execution reached a terminal state';
const attemptTerminalViewers = new Set();
const TERMINAL_THEME = Object.freeze({
  background: '#11111b', foreground: '#cdd6f4', cursor: '#f5e0dc', cursorAccent: '#11111b',
  selectionBackground: 'rgba(137, 180, 250, 0.3)', black: '#45475a', red: '#f38ba8',
  green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', magenta: '#cba6f7', cyan: '#94e2d5',
  white: '#bac2de', brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1',
  brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#cba6f7',
  brightCyan: '#94e2d5', brightWhite: '#a6adc8',
});
const PROTECTION_POLL_INTERVAL_MS = 30000;
const PROTECTION_ACTIVE_POLL_INTERVAL_MS = 2000;
const CODEX_TERMINAL_RECONNECT_BASE_MS = 500;
const CODEX_TERMINAL_RECONNECT_MAX_MS = 5000;
const MANAGED_CODEX_TERMINAL_COLUMNS = 120;
const MANAGED_CODEX_TERMINAL_ROWS = 40;
const ACTIVE_STATUSES = ['queued', 'running', 'recovering', 'stopping', 'waiting_scheduled'];
const REVIEW_STATUSES = ['waiting_review', 'waiting_input'];
const RUNTIME_REASON_KEYS = Object.freeze({
  dashboard_unavailable: 'runtimeDashboardUnavailable',
  unsupported_platform: 'runtimeUnsupportedPlatform',
  executor_unavailable: 'runtimeExecutorUnavailable',
  worker_unavailable: 'runtimeWorkerUnavailable',
  execution_user_unsafe: 'runtimeExecutionUserUnsafe',
  workspace_unavailable: 'runtimeWorkspaceUnavailable',
  storage_capacity_unavailable: 'runtimeStorageUnavailable',
  storage_capacity_low: 'runtimeStorageLow',
  execution_process_mismatch: 'runtimeProcessMismatch',
  web_supervisor_unavailable: 'runtimeSupervisorUnavailable',
  host_launcher_unavailable: 'runtimeLauncherUnavailable',
  platform_maintenance: 'runtimeMaintenance',
});

const messages = {
  zh: {
    sessionCloneWorkspace: '独立 Session 目录', sharedWorkspace: '共享工作目录',
    newReleaseCycle: '新建版本周期', releaseCycleCreated: '版本周期已创建。', cycleCreateRefreshFailed: '版本周期已创建，刷新列表失败，请刷新页面。', cycleName: '周期名称', cycleTaskName: 'Task 名称', cycleTaskNameDefault: '版本回归', cycleTaskObjective: '每次执行的任务指令', cycleFormNote: '创建周期用于组织独立 Task。代码拉取、部署和测试由每次 Task 按指令执行；可按需启用定时创建。', enableCycleSchedule: '启用定时创建 Task', cycleCron: 'Cron 表达式', cycleTimezone: '时区', cycleOverlap: '前一任务未结束时', cycleOverlapQueue: '排队等待', cycleOverlapSkip: '跳过本次', cycleOverlapParallel: '并行创建', cycleAdvanced: '高级设置', cycleId: '周期 ID', cycleWorkflow: '工作流标识', cycleSavedOnly: '创建周期',
    viewFullAnalysis: '查看完整分析', analysisReportHint: '逐条分类、预期与实际、证据和下一步',
    collapseReleaseCycle: '收起', deleteReleaseCycle: '删除周期及任务产物', releaseCycleDeleted: '版本周期及其关联 Task、产物已删除。', cycleDeletedRefreshFailed: '版本周期已删除，但刷新列表失败，请稍后刷新页面。',
    confirmDeleteReleaseCycle: '删除版本周期「{name}」及其所有关联 Task、报告、日志和音视频产物？运行中的关联 Task 会自动停止。',
    confirmCloseReleaseCycle: '结束版本周期「{name}」？只停止新 Task 创建，已有 Task 可继续运行，报告和产物保留。',
    cycleDeletionStarted: '已开始删除版本周期、关联 Task 和产物。', cycleDeleting: '删除中',
    cycleDeletionCompleted: '版本周期「{name}」及其关联 Task、产物已删除。',
    cycleDeletionProgress: '已删除 {deleted}/{total} 个 Task，正在清理剩余产物和运行环境。',
    cycleDeletionRetry: '清理正在重试，进度会自动更新。', cycleDeletionRefreshFailed: '删除已受理，刷新进度失败，请稍后查看。',
    cycleDeletionLegacy: '当前服务仍使用保留 Task 的旧删除逻辑，任务和产物尚未删除；请应用新版服务后继续清理。',
    cumulativeResults: '累计统计', includingReruns: '含重跑', finalCaseResults: '最终结果', rerunsReplaceEarlier: '重跑覆盖原结果', resultTotal: '总数', fullResultDetail: '展开完整结论', caseCountNotes: '总数包含 Skip 和 XFail；实际执行（不含 Skip）{count} 次。', resultCountsIncomplete: '部分报告尚不可统计，以下为当前已读取的结果。',
    expandInstruction: '展开输入', collapseInstruction: '收起输入', copyReportName: '复制文件名', reportNameCopied: '文件名已复制', copyReportNameFailed: '复制失败，请展开后手动复制文件名。',
    deleteTaskArtifacts: '删除任务及产物', taskArtifactsDeleted: '任务及平台产物已删除，Runtime 由后台回收。', reclaimRuntimeOnly: '仅回收 Runtime', taskStorageLabel: 'TASK STORAGE',
    taskStorageHeading: '任务与归档产物', taskStorageNote: '包含报告、视频、音频、日志、播放缓存和 Skill 快照。/data/jenkins/videos 源文件由你手动清理。',
    storageInventoryHeadline: '任务与 Runtime 占用', storageInventoryLabel: 'STORAGE INVENTORY', storageInventorySubtitle: '查看任务运行环境、归档产物及合计占用，回收 Runtime 或删除任务及产物。', reclaimableRuntimeBytes: 'Runtime 可释放',
    archivedStorage: '归档产物', otherTaskStorage: '日志与快照等', combinedStorage: '合计占用', platformTaskStorage: '平台任务产物',
    deleteAfterStop: '停止后可删除', deleteAfterArchive: '正在归档', noTaskStorage: '没有保留的任务产物。', storageEstimatePartial: '部分文件无法统计', taskChangedRefresh: '任务已变更，请刷新后再操作。',
    confirmDeleteTaskArtifacts: '删除任务「{name}」及其报告、视频、音频、日志、播放缓存和 Runtime？/data/jenkins/videos 源文件保留。',
    reportExecution: '执行信息', reportRelatedDetails: '阶段执行明细', unreportedExecutions: '尚未关联报告的执行',
    actualCommand: '实际执行的命令', rerunResults: 'Rerun 结果', rerunReportsCombined: '已合并 {count} 份重跑报告，展开查看各组结果。',
    workspaceTools: '工具与显示', workbenchGuide: '工作台说明', moreActions: '更多操作', taskReports: '报告', nextInstruction: '下一步指令',
    taskListDescription: '任务名称与目标', taskListCount: '{count} 个任务', taskObjective: '任务目标', taskCaseProgress: '用例进度', taskCaseProgressUnavailable: '暂无用例进度', taskCaseProgressUnknown: '已收集 {total} 个，结果待上报', taskCaseProgressCount: '{completed}/{total} 已完成', taskCasePassed: 'Pass {count}', taskCaseFailed: 'Fail {count}', taskCaseSkipped: 'Skip {count}', taskInitialProgress: '首轮 initial', taskRerun1Progress: '失败重跑 rerun-1',
    expandObjective: '展开', collapseObjective: '收起', showTaskContext: '任务信息', hideTaskContext: '收起信息',
    brandSubtitle: '持久任务工作台', navOverview: '总览', navTasks: '任务 Session', navReleaseCycles: '版本周期', navSkills: 'Skills', navAudit: '操作审计',
    releaseCyclesNote: '按提测版本查看手动和定时创建的独立 Task。关闭版本周期后只停止后续创建，不影响已运行任务。', refreshReleaseCycles: '刷新', releaseCycleTasksLabel: '版本 Task', closeReleaseCycle: '结束版本周期', releaseCycleActive: '进行中', releaseCycleClosed: '已结束', noReleaseCycles: '还没有提测版本周期。', releaseCycleTaskCount: '{count} 个 Task', taskCountLabel: 'Task 数量', nextRun: '下次创建', lastRun: '最近创建', releaseKey: '提测版本', releaseCycleAnalysis: '周期数据分析', releaseCycleAnalysisHint: '比较 initial 与 rerun-1 的 Pass/Fail 变化，按测试类型分组。', releaseCycleAnalysisLoading: '正在计算周期数据分析…', releaseCycleAnalysisUnavailable: '暂无可比较的 initial/rerun-1 结果。', analysisAll: '全部', analysisComparable: '可比较 Task', analysisPartial: '部分可比较', analysisPending: '待完成', analysisUnavailable: '不可统计', analysisInitialPass: 'initial 全量通过率', analysisTargetInitialPass: 'rerun 目标 initial 通过率', analysisTargetInitialFail: 'rerun 目标 initial 失败率', analysisRerunPass: 'rerun-1 通过率', analysisRecovered: 'Fail → Pass', analysisPersistent: '持续失败', analysisRegressed: 'Pass → Fail', analysisTrend: 'Pass/Fail 趋势', analysisChartHint: '每个 Task 分别显示 initial 与 rerun-1 的 Pass/Fail 比例', analysisPass: 'Pass', analysisFail: 'Fail', analysisTask: 'Task', analysisScheduled: '执行时间', analysisInitial: 'Initial', analysisRerun: 'Rerun-1', analysisTransitions: '状态变化', analysisNoTrend: '暂无完整的 rerun-1 数据。',
    fontSize: '文字大小', fontSizeSmall: '小号文字', fontSizeStandard: '标准文字', fontSizeLarge: '大号文字',
    export: '导出', import: '导入', syncRuntime: '同步 Runtime', newTask: '新建任务', executionMode: '执行模式',
    overviewHeadline: '任务即 Session，持续工作直到确认完成', overviewDescription: '每个任务拥有独立持久 Session；每轮结果可继续处理，确认完成后进入只读历史。', overviewCyclePage: '第 {page} 页 · 当前 {count} 个 Task', overviewCyclePrevious: '上一页', overviewCycleNext: '下一页', overviewCycleLoading: '正在加载版本周期 Task…',
    liveFloor: '当前任务', currentSessionsHeading: '任务 Sessions', recentActivity: '最近活动', recentOperations: '最近操作', viewAll: '查看全部',
    completedSessions: '已完成 Sessions', recentHistory: '最近完成记录', viewHistory: '查看历史', loadMore: '加载更多', newer: '较新记录', older: '更早记录',
    filterCurrent: '当前任务', filterRunning: '工作中', filterHistory: '历史记录', taskProjectFilter: '项目', taskTagFilter: '标签', taskTestTypeFilter: '测试类型', taskOriginFilter: 'Task 来源', allProjects: '全部项目', allTags: '全部标签', allTestTypes: '全部测试类型', allTaskOrigins: '全部来源', standaloneTask: '单次 Task', releaseCycleTask: '版本周期 Task', featureTest: 'Feature 测试', regressionTest: '回归测试', noFilteredTasks: '没有符合当前筛选条件的任务。',
    skillsNote: '任务首次启动时冻结平台 Skill 与 Codex Skill 快照，恢复时保持版本一致。', newSkill: '新建 Skill', importSkillZip: '导入 ZIP',
    taskId: '任务 ID', eventType: '事件类型', searchAudit: '搜索操作内容', filter: '筛选', persistentSession: '持久 Session',
    businessSummary: '任务摘要', agentRecords: 'Agent 记录', worklog: 'Agent 工作记录', skillInvocations: 'Skill 调用', noSkillInvocations: '本 Session 暂无自动记录的 Skill 调用。', taskTerminal: 'Codex CLI', commands: 'Agent 命令', background: '后台与调度', operations: '操作审计', continuePlaceholder: '输入启动或恢复这个任务的指令', overviewStandaloneHint: '未归属版本周期的任务', overviewCycleHint: '按版本周期查看任务', overviewMoreTasks: '还有 {count} 个单次 Task，请到任务页面查看全部。',
    cliConnecting: '正在连接', cliConnected: '已连接', cliDisconnected: '连接已断开', cliEnded: 'CLI 已结束', cliReconnect: '重新连接', cliInterrupt: '中断', cliClear: '清屏', cliTerminate: '结束 CLI', cliReadOnly: '只读', cliUnlockInput: '解锁输入', cliInputUnlocked: '允许输入',
    interactiveCliConflict: '该任务仍有正在运行的 Codex CLI。请在任务详情的「Codex CLI」页签点击「结束 CLI」，然后重新{operation}。', taskOperationRunning: '启动任务', taskOperationDeleting: '删除任务', taskOperationCompleting: '完成任务', taskOperationResetting: '重置上下文', taskOperationRetry: '执行此操作',
    businessCommands: '主要执行', businessExecution: '业务执行', executionRuns: '执行记录', repeatedRuns: '重复执行', primarySkill: '实际执行 Skill',
    businessTimeline: '业务轨迹', taskTimeline: '任务轨迹', businessResult: '业务结果', regressionCommands: 'pytest 回归命令', currentStage: '当前阶段', currentStatus: '当前状态', taskCreated: '任务已创建', structuredResult: '结构化结果', requestReceived: '收到提测报告', testExecutionStarted: '执行测试', deploymentStarted: '开始', deploymentFinished: '结束', deploymentCompleted: '部署完成', initialRegression: '首轮回归', regressionRerun: 'Rerun', followupBooked: '预约回查', initialCompleted: '首轮完成', rerunCompleted: 'Rerun 完成', failureAnalysis: 'Fail 分析', failureAnalysisCompleted: 'Fail 分析完成', failureAnalysisPending: '已检测到 analyze-failures 执行，等待结构化分析结论。', failureAnalysisUnreported: '已使用 analyze-failures，结构化分析结论尚未登记。', runInProgress: '第 {number} 次 pytest 正在执行。', finalResult: '最终结果', currentResult: '当前结果', waitingForTestResult: '等待业务测试结果', noPytestRuns: '暂无 pytest 回归记录', scheduledFor: '回查时间', startedAtShort: '开始', finishedAtShort: '结束', pytestCommand: 'PYTEST COMMAND', skillUsed: '使用 Skill', cicdDeployment: 'CI/CD 部署', gwDeployment: 'GW 部署', serviceDeployment: '服务部署', exitCodeSummary: '退出码 {code}', testRunNumber: '第 {number} 次回归',
    overviewTitle: '持久任务总览', overviewSubtitle: '一个任务对应一个独立、可恢复、可审计的 Codex Session。',
    tasksTitle: '任务 Session', tasksSubtitle: '每轮执行后等待确认；只有明确完成的 Session 才进入只读历史。', releaseCyclesTitle: '版本周期', releaseCyclesSubtitle: '按提测版本查看完整 Task 系列，并控制后续 Cron 创建。',
    skillsTitle: 'Skills 管理', skillsSubtitle: '管理平台 Skill，并查看当前 Codex Runtime 可发现的内置 Skills。',
    auditTitle: '操作审计', auditSubtitle: '按任务查看创建、启动、恢复、命令、错误和完成记录。',
    sessions: 'Session 总数', current: '当前任务', working: '工作中', history: '历史记录', skills: 'Skills', operationsCount: '操作记录',
    idle: '待启动', pending: '待执行', leased: '执行中', queued: '排队中', running: '工作中', recovering: '恢复中', stopping: '停止中', waiting_scheduled: '后台运行中', waiting_review: '待确认', waiting_input: '待输入', completed: '已完成', succeeded: '成功', failed: '失败', lost: '进程失联', cancelled: '已取消', interrupted: '已中断', stopped: '已停止', recoverable: '可恢复', disabled: '已禁用',
    open: '查看', terminal: '终端', start: '启动任务', recover: '恢复任务', restoreArchived: '恢复并继续', resetSession: '重置上下文', continueTask: '继续任务', reviewTask: '查看结果', complete: '确认完成', stop: '停止', edit: '编辑', delete: '删除', close: '关闭', save: '保存', cancel: '取消',
    noCurrentTasks: '当前没有任务。新建任务会创建一个独立 Session。', noHistory: '还没有已完成的 Session。', noAudit: '没有匹配的操作记录。', noSkills: '没有可用 Skill。',
    taskName: '任务名称', objective: '任务目标 / 首次指令', workingDir: '工作目录', notes: '备注', taskProject: '项目分类', taskTestType: '测试类型', taskTags: '标准标签（逗号分隔，最多6个）', taskTagsHint: '使用 scope:/mode:/env:/source:/exclude:/change:/version: 前缀；类型、项目和周期不重复写入标签。', enabled: '启用',
    maxRetries: '中断重试次数', autoResume: '服务重启后自动恢复', createAndStart: '创建并启动', updateTask: '更新任务', createTask: '新建任务 Session', editTask: '编辑任务',
    idHint: '只允许字母、数字、短横线和下划线', pathHint: '相对路径以任务工作区根目录为基准；绝对路径必须位于允许的根目录内。',
    taskContext: '任务上下文', sessionId: 'Session ID', status: '状态', runCount: '执行次数', recoveryAttempts: '自动恢复次数', createdAt: '创建时间', finishedAt: '完成时间', workspace: '工作区', workspaceMode: '工作区模式', sourceMode: '源码模式', sourceCommit: '源码 Commit', archiveState: '源码归档状态', sessionRoot: 'Session 根目录', nextCheck: '下次检查', activeBackground: '活动后台执行', activeSchedules: '活动定时检查',
    waitingStart: '创建后将立即启动独立 Session。', runningHint: '任务正在执行，日志会自动刷新。', scheduledHint: 'Codex 已释放；平台将在到点后恢复同一 Session，并创建新的 Turn 检查后台结果。', reviewHint: '检查本轮结果；可以继续发送指令，或确认完成并归档。', archivedHint: '该 Session 已完成并归档，不能再次运行。', recoverHint: '恢复会继续使用 Task 当前最新的持久 Session，不会创建新会话。', disabledHint: '任务已禁用，启用后才能启动或继续。',
    startTask: '启动任务', recoverTask: '恢复任务', taskStarted: '任务已排队', taskSaved: '任务已保存', taskDeleted: '任务已删除', taskCompleted: '任务已确认完成', taskRestored: '任务已恢复，可重新连接 Codex CLI', taskReset: '任务配置和历史已保留，后续运行将创建新的 Codex Session', stopRequested: '已请求停止任务', stopNotApplicable: '任务当前不需要停止', operationOutcomeUnknown: '请求结果暂时无法确认；系统已保留操作标识，重试不会重复执行',
    skillName: 'Skill 名称', category: '分类', description: '描述', tags: '标签（逗号分隔）', skillContent: 'SKILL.md 内容', createSkill: '新建 Skill', editSkill: '编辑 Skill', viewSkill: '查看 Skill',
    sourceCodex: 'Codex 内置', sourceManaged: '平台托管', readOnly: '只读', skillSaved: 'Skill 已保存', skillDeleted: 'Skill 已删除', skillEnabled: 'Skill 已启用', skillDisabled: 'Skill 已停用', enable: '启用', disable: '停用', files: '文件', skillZipImported: 'Skill 压缩包已导入', confirmOverwriteSkill: '存在同名平台 Skill，是否覆盖并生成新版本？', zipTooLarge: 'Skill ZIP 不能超过 8 MiB',
    runtimeReady: '执行服务已就绪', runtimeMissing: '执行服务不可用', runtimePaused: '任务执行已暂停', runtimeConnectionIssue: '平台连接异常', runtimeReconnecting: '正在重新连接', runtimeDashboardUnavailable: '平台状态无法刷新', dashboardRequestTimeout: 'Dashboard 请求超时', requestTimeout: '请求超时，结果未知；请刷新状态后再决定是否重试', runtimeUnsupportedPlatform: '当前平台不受支持', runtimeExecutorUnavailable: 'Codex 执行器不可用', runtimeWorkerUnavailable: 'Session Worker 不可用', runtimeExecutionUserUnsafe: '执行账户安全策略未满足', runtimeWorkspaceUnavailable: '任务工作区不可用', runtimeStorageUnavailable: '持久存储不可用', runtimeStorageLow: '持久存储空间不足', runtimeProcessMismatch: '执行进程身份校验失败', runtimeSupervisorUnavailable: 'Web Supervisor 监管中断', runtimeLauncherUnavailable: 'Host Launcher 监管中断', runtimeMaintenance: '平台正在维护', fullAccess: '最高权限', apiRequests: 'API 请求', logStreams: '日志流', synced: '运行状态已同步', imported: '配置已导入', confirmCompleteTask: '确认这个任务已经完成并归档吗？归档后仅保留只读记录，需要时可以显式恢复。', confirmRestoreTask: '恢复这个已归档任务并继续当前最新的 Codex Session 吗？', confirmResetTask: '重置当前 Codex 上下文吗？Task 配置、ID 和历史记录会保留；旧 Runtime 将被回收，后续运行创建新的 Session。', confirmDeleteTask: '确定删除这个 Session 及其全部工作日志吗？', confirmDeleteSkill: '确定删除这个平台 Skill 吗？',
    payload: '事件详情', actor: '操作者', requestId: '请求 ID', turnInput: '本轮指令', fullCommand: '完整命令', commandOutput: '执行输出', attempt: '执行尝试', exitCode: '退出码', pid: '进程 ID', signal: '退出信号', attemptError: '错误', configuredWorkingDir: '配置工作目录', runtimeWorkingDir: '实际执行目录', runtimeDirUnreported: '执行端未上报', noWorklog: '本 Session 暂无 Agent 工作记录。', noOperations: '本 Session 暂无控制面操作记录。', noAttempts: '任务终端正在等待输出。', noExecutions: '本 Session 暂无命令执行记录。', noBackground: '本 Session 暂无后台执行或定时检查。', externalExecution: '后台执行', scheduledCheck: '定时检查', generation: '代次', interval: '检查间隔', backgroundCommand: '后台完整命令', backgroundOutput: '业务进程输出', commandPath: '命令记录', viewFullLog: '查看完整原始输出', sessionStdout: 'Agent stdout', sessionStderr: 'Agent stderr', viewInlineOutput: '打开终端', hideInlineOutput: '收起终端', openRawOutput: '打开完整原始输出', loadingOutput: '正在连接实时终端...', liveOutput: '实时', reconnectingOutput: '重新连接', completeOutput: '已结束', inlineOutputLimit: '已达内嵌上限', emptyOutput: '（空输出）', outputBytes: '字节', logPath: '日志', donePath: '完成标记', statePath: '状态文件', lastObservation: '最近观察', archivePreservation: '日志托管', archiveBytes: '托管字节', archiveSha256: 'SHA-256', archiveError: '托管错误', task: '任务', unknown: '未知', loadFailed: '加载失败', actionFailed: '操作失败',
    checkNotNeeded: '无需检查', scheduleOutcome: '调度结果', backgroundAlreadyFinished: '后台任务已结束，定时检查无需再执行。业务结果请查看关联的后台执行。', backgroundPytestExecution: 'pytest 后台执行', processStartedAt: '实际开始', processFinishedAt: '实际结束', platformConfirmedAt: '平台确认', scheduledDueAt: '计划回查', scheduledFinishedAt: '回查完成', scheduleResolvedAt: '调度结束', linkedBackground: '关联后台', scheduleAttempts: '回查执行', logArchived: '已托管',
    businessReports: '结构化报告', noBusinessReports: '暂无结构化报告或主要执行记录。', reportRevision: '修订', reportObservedAt: '业务时间', reportPublishedAt: '上报时间', reportRawPayload: '原始报告', pytestHtmlReport: 'Pytest HTML 报告', failureAnalysisReport: 'Fail 分析报告', openHtmlReport: '打开报告', openMarkdownReport: '打开报告', artifactRegisteredRunning: '已登记 · 执行中', artifactRegisteredPending: '已登记 · 待归档', artifactUnavailable: '报告文件未生成或为空', reportStatusPending: '待开始', reportStatusRunning: '执行中', reportStatusSucceeded: '通过', reportStatusFailed: '失败', reportStatusPartial: '部分完成', reportStatusBlocked: '阻塞', reportStatusCancelled: '已取消', reportStatusUnknown: '未知',
    attributedSkills: '实际使用的 Skills', noAttributedSkills: '未声明使用 Skill', correctAttribution: '修正归因', attributionHistory: '归因与修正历史', runtimeDeclared: '运行时声明', operatorCorrection: '人工修正', linked: '关联', unlinked: '移除', correctionReason: '修正原因', correctionReasonHint: '说明为什么增加或移除这些 Skill，原因会永久进入审计记录。', saveCorrection: '保存修正', skillAttributionSaved: 'Skill 归因已保存', unresolvedSkills: '快照中不存在的声明', skillSnapshotOptions: '任务冻结快照中的 Skills', version: '版本', contentHash: '内容哈希', noSnapshotSkills: '该任务尚未冻结 Skill 快照。',
    navRuntime: '运行库存', runtimeInventoryTitle: '运行库存', runtimeInventorySubtitle: '检查平台数据保护状态，以及原生 Bridge Session Runtime 的占用、归属与安全分类。', nativeRuntime: '原生 Runtime', runtimeInventoryHeadline: '原生 Session 资源与归属', inventoryNotScanned: '尚未扫描', loadingInventory: '正在扫描 Runtime 库存...', inventoryScanned: '扫描于 {time}', refreshInventory: '刷新状态', inventoryTotal: 'Session 总数', inventoryReclaimable: '可回收', inventoryBytes: 'Runtime 占用', inventoryReclaimableBytes: '可释放空间', inventoryStateSummary: '{safe} 安全 · {queued} 回收中 · {unsafe} 需排查', noBridgeSessions: '没有保留的原生 Bridge Session Runtime。',
    bridgeCategoryTaskOwned: '任务占用', bridgeCategoryCompletedRetained: '已完成保留', bridgeCategoryOrphan: '孤立 Session', bridgeCategoryCleanupQueued: '回收中', bridgeCategoryCleanupInconsistent: '回收不一致', bridgeCategoryUnsafe: '不安全', taskOwner: '任务归属', noTaskOwner: '无任务归属', resourceRecord: 'Record', resourceCodexHome: 'Codex Home', resourceWorkspace: '工作区', resourceChatfile: 'Chatfile', resourceWorkspaceLock: '工作区锁', resourceSessionRunLock: '运行锁', lastRun: '最近运行', neverRun: '从未运行', resourcePresent: '存在', resourceMissing: '缺失', deleteReleaseRuntime: '删除并释放磁盘', confirmRuntimeReclaim: '确认删除并释放 Runtime', runtimeReclaimWarning: '原生 Session Runtime 删除后不可恢复；平台任务历史和审计记录会继续保留。', targetSession: '目标 Session', typeSessionId: '输入完整 Session ID', sessionIdConfirmation: 'session-0123456789abcdef', bridgeReclaimQueued: 'Runtime 删除作业已入队', bridgeReclaimCompleted: 'Runtime 已删除并释放', bridgeReclaimOutcomeUnknown: '删除请求结果未知；库存已重新核对，可使用同一 Session ID 安全重试。', bridgeSessionNoLongerReclaimable: '该 Session 已不存在或当前不可删除，请刷新库存。', bridgeReclaimInProgress: '已有 Runtime 删除请求正在提交，请等待结果。',
    dataProtection: '数据保护', dataProtectionHeading: '数据完整性与恢复保护', loadingProtection: '正在检查数据保护状态...', noProtectionStatus: '尚未检查数据保护状态。', protectionChecked: '检查于 {time}', protectionRefreshFailed: '状态刷新失败：{error}', platformStorage: '平台数据', databaseBackup: '在线数据库备份', recoveryCheckpoint: '平台恢复检查点', terminalLogArchive: '终态日志托管', protectionHealthy: '正常', protectionDegraded: '异常', protectionPending: '待建立', protectionInProgress: '进行中', protectionRotationPending: '待轮转', sqliteCheck: 'SQLite 检查', stateInvariants: '状态约束', storageHeadroom: '最低可用空间', lastSuccess: '最近成功', nextRun: '下次计划', packageRetention: '有效包 / 保留数', auditContinuity: '审计连续性', auditHealthy: '已持久化', auditPending: '{count} 条待写入', invariantIssues: '{count} 项异常', storageAvailable: '{percent}% · {bytes}', rotationPendingDetail: '超出 {count} 份，下次成功发布后轮转', schedulerError: '调度错误', unreadablePackages: '不可读取包', archiveCoverage: '托管覆盖', archiveCoverageDetail: '{archived} / {total} 条终态日志', archiveLastVerified: '最近完整校验', archiveFailures: '托管异常', archiveFailureDetail: '{count} 条需修复',
  },
  en: {
    sessionCloneWorkspace: 'Independent Session directory', sharedWorkspace: 'Shared working directory',
    newReleaseCycle: 'New release cycle', releaseCycleCreated: 'Release cycle created.', cycleCreateRefreshFailed: 'The release cycle was created, but the list could not be refreshed. Refresh the page.', cycleName: 'Cycle name', cycleTaskName: 'Task name', cycleTaskNameDefault: 'Release regression', cycleTaskObjective: 'Instructions for every Task', cycleFormNote: 'A cycle groups independent Tasks. Each Task fetches code, deploys and tests according to its instructions. Scheduled creation is optional.', enableCycleSchedule: 'Enable scheduled Task creation', cycleCron: 'Cron expression', cycleTimezone: 'Timezone', cycleOverlap: 'When the previous Task is still active', cycleOverlapQueue: 'Queue', cycleOverlapSkip: 'Skip this occurrence', cycleOverlapParallel: 'Create in parallel', cycleAdvanced: 'Advanced settings', cycleId: 'Cycle ID', cycleWorkflow: 'Workflow identifier', cycleSavedOnly: 'Create cycle',
    viewFullAnalysis: 'View full analysis', analysisReportHint: 'Classification, expected and actual behavior, evidence and next action',
    collapseReleaseCycle: 'Collapse', deleteReleaseCycle: 'Delete cycle, Tasks & artifacts', releaseCycleDeleted: 'Release cycle, associated Tasks and artifacts deleted.', cycleDeletedRefreshFailed: 'The release cycle was deleted, but the list could not be refreshed. Refresh the page later.',
    confirmDeleteReleaseCycle: 'Delete release cycle “{name}” and all associated Tasks, reports, logs and media? Running associated Tasks will be stopped automatically.',
    confirmCloseReleaseCycle: 'Close release cycle “{name}”? Only future Task creation stops. Existing Tasks continue and their reports and artifacts remain.',
    cycleDeletionStarted: 'Deleting release cycle, associated Tasks and artifacts.', cycleDeleting: 'Deleting',
    cycleDeletionCompleted: 'Release cycle “{name}”, associated Tasks and artifacts deleted.',
    cycleDeletionProgress: '{deleted}/{total} Tasks deleted. Cleaning remaining artifacts and runtime.',
    cycleDeletionRetry: 'Cleanup is retrying. Progress updates automatically.', cycleDeletionRefreshFailed: 'Deletion accepted, but progress could not be refreshed. Check again later.',
    cycleDeletionLegacy: 'The running service still retains Tasks on cycle deletion. Tasks and artifacts have not been deleted; apply the updated service before continuing cleanup.',
    cumulativeResults: 'Cumulative', includingReruns: 'Includes reruns', finalCaseResults: 'Final results', rerunsReplaceEarlier: 'Latest result per case', resultTotal: 'Total', fullResultDetail: 'Full conclusion', caseCountNotes: 'Totals include Skip and XFail; {count} executions excluding Skip.', resultCountsIncomplete: 'Some reports are not available for counting; these are the results read so far.',
    expandInstruction: 'Write a message', collapseInstruction: 'Collapse input', copyReportName: 'Copy filename', reportNameCopied: 'Filename copied', copyReportNameFailed: 'Copy failed. Expand the filename to copy it manually.',
    deleteTaskArtifacts: 'Delete task & artifacts', taskArtifactsDeleted: 'Task and managed artifacts deleted. Runtime reclamation runs in the background.', reclaimRuntimeOnly: 'Reclaim Runtime only', taskStorageLabel: 'TASK STORAGE',
    taskStorageHeading: 'Tasks & archived artifacts', taskStorageNote: 'Reports, video, audio, logs, playback caches and Skill snapshots. Source files in /data/jenkins/videos remain for manual cleanup.',
    storageInventoryHeadline: 'Task & Runtime usage', storageInventoryLabel: 'STORAGE INVENTORY', storageInventorySubtitle: 'Inspect Runtime and archived artifact usage, reclaim Runtime or delete a Task and its managed files.', reclaimableRuntimeBytes: 'Reclaimable Runtime',
    archivedStorage: 'Archived artifacts', otherTaskStorage: 'Logs, snapshots, etc.', combinedStorage: 'Combined usage', platformTaskStorage: 'Platform task files',
    deleteAfterStop: 'Stop before deleting', deleteAfterArchive: 'Archival in progress', noTaskStorage: 'No retained task artifacts.', storageEstimatePartial: 'Some files could not be measured', taskChangedRefresh: 'The task has changed. Refresh before continuing.',
    confirmDeleteTaskArtifacts: 'Delete task “{name}” together with its reports, video, audio, logs, playback caches and Runtime? Source files in /data/jenkins/videos remain.',
    reportExecution: 'Execution evidence', reportRelatedDetails: 'Stage execution details', unreportedExecutions: 'Executions without a linked report',
    actualCommand: 'Executed command', rerunResults: 'Rerun results', rerunReportsCombined: 'Combined {count} rerun reports. Expand to inspect each group.',
    workspaceTools: 'Tools & display', workbenchGuide: 'About this workbench', moreActions: 'More actions', taskReports: 'Reports', nextInstruction: 'Next instruction',
    taskListDescription: 'Task name & objective', taskListCount: '{count} tasks', taskObjective: 'Objective', taskCaseProgress: 'Case progress', taskCaseProgressUnavailable: 'No case progress yet', taskCaseProgressUnknown: '{total} cases collected; results pending', taskCaseProgressCount: '{completed}/{total} completed', taskCasePassed: 'Pass {count}', taskCaseFailed: 'Fail {count}', taskCaseSkipped: 'Skip {count}', taskInitialProgress: 'Initial run', taskRerun1Progress: 'Failed-case rerun · rerun-1',
    expandObjective: 'Expand', collapseObjective: 'Collapse', showTaskContext: 'Task info', hideTaskContext: 'Hide info',
    brandSubtitle: 'Persistent Task Desk', navOverview: 'Overview', navTasks: 'Task Sessions', navReleaseCycles: 'Release Cycles', navSkills: 'Skills', navAudit: 'Operation Audit',
    releaseCyclesNote: 'View independent manual and scheduled Tasks by release version. Closing a cycle stops future creation without affecting running Tasks.', refreshReleaseCycles: 'Refresh', releaseCycleTasksLabel: 'RELEASE TASKS', closeReleaseCycle: 'Close Release Cycle', releaseCycleActive: 'Active', releaseCycleClosed: 'Closed', noReleaseCycles: 'No release cycles yet.', releaseCycleTaskCount: '{count} Tasks', taskCountLabel: 'Task count', nextRun: 'Next run', lastRun: 'Last run', releaseKey: 'Release version', releaseCycleAnalysis: 'Cycle analytics', releaseCycleAnalysisHint: 'Compare initial and rerun-1 Pass/Fail results by test type.', releaseCycleAnalysisLoading: 'Calculating cycle analytics…', releaseCycleAnalysisUnavailable: 'No comparable initial/rerun-1 results yet.', analysisAll: 'All', analysisComparable: 'Comparable Tasks', analysisPartial: 'Partially comparable', analysisPending: 'Pending', analysisUnavailable: 'Unavailable', analysisInitialPass: 'Initial full pass rate', analysisTargetInitialPass: 'Rerun target initial pass rate', analysisTargetInitialFail: 'Rerun target initial fail rate', analysisRerunPass: 'Rerun-1 pass rate', analysisRecovered: 'Fail → Pass', analysisPersistent: 'Persistent failures', analysisRegressed: 'Pass → Fail', analysisTrend: 'Pass/Fail trend', analysisChartHint: 'Each Task shows its initial and rerun-1 Pass/Fail ratio', analysisPass: 'Pass', analysisFail: 'Fail', analysisTask: 'Task', analysisScheduled: 'Scheduled', analysisInitial: 'Initial', analysisRerun: 'Rerun-1', analysisTransitions: 'Transitions', analysisNoTrend: 'No complete rerun-1 data yet.',
    fontSize: 'Text size', fontSizeSmall: 'Small text', fontSizeStandard: 'Standard text', fontSizeLarge: 'Large text',
    export: 'Export', import: 'Import', syncRuntime: 'Sync Runtime', newTask: 'New Task', executionMode: 'Execution Mode',
    overviewHeadline: 'A task is a session that persists until completion', overviewDescription: 'Each task owns one persistent session. Review or continue every turn, then explicitly archive the completed task.', overviewCyclePage: 'Page {page} · {count} Tasks shown', overviewCyclePrevious: 'Previous', overviewCycleNext: 'Next', overviewCycleLoading: 'Loading release cycle Tasks…',
    liveFloor: 'Current Tasks', currentSessionsHeading: 'Task Sessions', recentActivity: 'Recent Activity', recentOperations: 'Recent Operations', viewAll: 'View All',
    completedSessions: 'Completed Sessions', recentHistory: 'Recent History', viewHistory: 'View History', loadMore: 'Load more', newer: 'Newer', older: 'Older',
    filterCurrent: 'Current', filterRunning: 'Running', filterHistory: 'History', taskProjectFilter: 'Project', taskTagFilter: 'Tag', taskTestTypeFilter: 'Test type', taskOriginFilter: 'Task origin', allProjects: 'All projects', allTags: 'All tags', allTestTypes: 'All test types', allTaskOrigins: 'All origins', standaloneTask: 'Standalone Task', releaseCycleTask: 'Release-cycle Task', featureTest: 'Feature test', regressionTest: 'Regression test', noFilteredTasks: 'No tasks match the current filters.',
    skillsNote: 'A versioned snapshot of managed and built-in Codex skills is frozen on the first task turn.', newSkill: 'New Skill', importSkillZip: 'Import ZIP',
    taskId: 'Task ID', eventType: 'Event type', searchAudit: 'Search operations', filter: 'Filter', persistentSession: 'Persistent Session',
    businessSummary: 'Task Summary', agentRecords: 'Agent Records', worklog: 'Agent Worklog', skillInvocations: 'Skill Invocations', noSkillInvocations: 'No automatically recorded Skill invocation exists for this Session.', taskTerminal: 'Codex CLI', commands: 'Agent Commands', background: 'Background & Schedule', operations: 'Operation Audit', continuePlaceholder: 'Enter instructions to start or recover this task', overviewStandaloneHint: 'Tasks outside a release cycle', overviewCycleHint: 'Tasks grouped by release cycle', overviewMoreTasks: '{count} more standalone Tasks are available in the Tasks view.',
    cliConnecting: 'Connecting', cliConnected: 'Connected', cliDisconnected: 'Disconnected', cliEnded: 'CLI ended', cliReconnect: 'Reconnect', cliInterrupt: 'Interrupt', cliClear: 'Clear', cliTerminate: 'End CLI', cliReadOnly: 'Read only', cliUnlockInput: 'Unlock input', cliInputUnlocked: 'Input enabled',
    interactiveCliConflict: 'This task has an active Codex CLI. Open the Codex CLI tab, select End CLI, then try to {operation} again.', taskOperationRunning: 'start the task', taskOperationDeleting: 'delete the task', taskOperationCompleting: 'complete the task', taskOperationResetting: 'reset the context', taskOperationRetry: 'perform this operation',
    businessCommands: 'Primary Executions', businessExecution: 'Business execution', executionRuns: 'Runs', repeatedRuns: 'Repeated', primarySkill: 'Executing Skill',
    businessTimeline: 'Business Timeline', taskTimeline: 'Task Timeline', businessResult: 'Business result', regressionCommands: 'pytest regression commands', currentStage: 'Current stage', currentStatus: 'Current status', taskCreated: 'Task created', structuredResult: 'Structured result', requestReceived: 'Test request received', testExecutionStarted: 'Test execution started', deploymentStarted: 'Started', deploymentFinished: 'Finished', deploymentCompleted: 'Deployment completed', initialRegression: 'Initial regression', regressionRerun: 'Rerun', followupBooked: 'Follow-up scheduled', initialCompleted: 'Initial run completed', rerunCompleted: 'Rerun completed', failureAnalysis: 'Failure analysis', failureAnalysisCompleted: 'Failure analysis completed', failureAnalysisPending: 'analyze-failures is active; waiting for the structured analysis result.', failureAnalysisUnreported: 'analyze-failures was used; no structured analysis result has been recorded yet.', runInProgress: 'pytest run #{number} is in progress.', finalResult: 'Final result', currentResult: 'Current result', waitingForTestResult: 'Waiting for business test result', noPytestRuns: 'No pytest regression recorded', scheduledFor: 'Check at', startedAtShort: 'Started', finishedAtShort: 'Finished', pytestCommand: 'PYTEST COMMAND', skillUsed: 'Skill', cicdDeployment: 'CI/CD deployment', gwDeployment: 'GW deployment', serviceDeployment: 'Service deployment', exitCodeSummary: 'Exit code {code}', testRunNumber: 'Regression #{number}',
    overviewTitle: 'Persistent Task Overview', overviewSubtitle: 'Each task owns one independent, recoverable, auditable Codex session.',
    tasksTitle: 'Task Sessions', tasksSubtitle: 'Every turn waits for review; only explicitly completed sessions become read-only history.', releaseCyclesTitle: 'Release Cycles', releaseCyclesSubtitle: 'View a complete Task series by release version and control future Cron creation.',
    skillsTitle: 'Skills', skillsSubtitle: 'Manage platform skills and inspect built-in skills discoverable by the Codex runtime.',
    auditTitle: 'Operation Audit', auditSubtitle: 'Inspect creation, start, recovery, commands, errors, and completion by task.',
    sessions: 'All Sessions', current: 'Current', working: 'Running', history: 'History', skills: 'Skills', operationsCount: 'Operations',
    idle: 'Ready', pending: 'Pending', leased: 'Running', queued: 'Queued', running: 'Running', recovering: 'Recovering', stopping: 'Stopping', waiting_scheduled: 'Background Running', waiting_review: 'Review', waiting_input: 'Needs Input', completed: 'Completed', succeeded: 'Succeeded', failed: 'Failed', lost: 'Process lost', cancelled: 'Cancelled', interrupted: 'Interrupted', stopped: 'Stopped', recoverable: 'Recoverable', disabled: 'Disabled',
    open: 'Open', terminal: 'Terminal', start: 'Start Task', recover: 'Recover Task', restoreArchived: 'Restore & Continue', resetSession: 'Reset Context', continueTask: 'Continue Task', reviewTask: 'Review Result', complete: 'Complete', stop: 'Stop', edit: 'Edit', delete: 'Delete', close: 'Close', save: 'Save', cancel: 'Cancel',
    noCurrentTasks: 'No current task. Create one to start an independent session.', noHistory: 'No completed session yet.', noAudit: 'No matching operation record.', noSkills: 'No skill is available.',
    taskName: 'Task name', objective: 'Task objective / initial instruction', workingDir: 'Working directory', notes: 'Notes', taskProject: 'Project classification', taskTestType: 'Test type', taskTags: 'Standard tags (comma separated, max 6)', taskTagsHint: 'Use scope:/mode:/env:/source:/exclude:/change:/version: prefixes; do not duplicate type, project, or cycle fields.', enabled: 'Enabled',
    maxRetries: 'Interruption retries', autoResume: 'Auto-recover after service restart', createAndStart: 'Create & Start', updateTask: 'Update Task', createTask: 'New Task Session', editTask: 'Edit Task',
    idHint: 'Letters, numbers, hyphens, and underscores only', pathHint: 'Relative paths resolve from the task workspace root; absolute paths must be under an allowed root.',
    taskContext: 'Task Context', sessionId: 'Session ID', status: 'Status', runCount: 'Runs', recoveryAttempts: 'Auto recoveries', createdAt: 'Created', finishedAt: 'Completed', workspace: 'Workspace', workspaceMode: 'Workspace mode', sourceMode: 'Source mode', sourceCommit: 'Source commit', archiveState: 'Source archive', sessionRoot: 'Session root', nextCheck: 'Next check', activeBackground: 'Active background runs', activeSchedules: 'Active scheduled checks',
    waitingStart: 'The independent session starts immediately after creation.', runningHint: 'The task is running. Logs refresh automatically.', scheduledHint: 'Codex has been released. The platform will resume this Session and create a new Turn when the durable check is due.', reviewHint: 'Review this turn, then continue the same session or complete and archive the task.', archivedHint: 'This Session is archived. Its complete Codex CLI transcript is read only; explicitly restore it to reconnect and continue.', recoverHint: "Recovery continues the Task's latest persistent Session and does not create a new one.", disabledHint: 'Enable this task before starting or continuing it.',
    startTask: 'Start Task', recoverTask: 'Recover Task', taskStarted: 'Task queued', taskSaved: 'Task saved', taskDeleted: 'Task deleted', taskCompleted: 'Task completed and archived', taskRestored: 'Task restored. You can reconnect to Codex CLI.', taskReset: 'Task configuration and history were retained. The next run will create a new Codex Session.', stopRequested: 'Stop requested', stopNotApplicable: 'This task does not need to be stopped', operationOutcomeUnknown: 'The result cannot be confirmed yet. The operation identity was retained, so retrying will not execute it twice.',
    skillName: 'Skill name', category: 'Category', description: 'Description', tags: 'Tags (comma separated)', skillContent: 'SKILL.md content', createSkill: 'New Skill', editSkill: 'Edit Skill', viewSkill: 'View Skill',
    sourceCodex: 'Codex built-in', sourceManaged: 'Managed', readOnly: 'Read only', skillSaved: 'Skill saved', skillDeleted: 'Skill deleted', skillEnabled: 'Skill enabled', skillDisabled: 'Skill disabled', enable: 'Enable', disable: 'Disable', files: 'files', skillZipImported: 'Skill archive imported', confirmOverwriteSkill: 'A managed Skill with the same name exists. Overwrite it as a new version?', zipTooLarge: 'Skill ZIP must not exceed 8 MiB',
    runtimeReady: 'Executor ready', runtimeMissing: 'Executor unavailable', runtimePaused: 'Task execution paused', runtimeConnectionIssue: 'Platform connection issue', runtimeReconnecting: 'Reconnecting', runtimeDashboardUnavailable: 'Platform status refresh failed', dashboardRequestTimeout: 'Dashboard request timed out', requestTimeout: 'Request timed out; outcome unknown. Refresh status before retrying.', runtimeUnsupportedPlatform: 'Current platform is unsupported', runtimeExecutorUnavailable: 'Codex executor unavailable', runtimeWorkerUnavailable: 'Session Worker unavailable', runtimeExecutionUserUnsafe: 'Execution account policy is unsafe', runtimeWorkspaceUnavailable: 'Task workspace unavailable', runtimeStorageUnavailable: 'Persistent storage unavailable', runtimeStorageLow: 'Persistent storage is low', runtimeProcessMismatch: 'Execution process identity mismatch', runtimeSupervisorUnavailable: 'Web Supervisor supervision lost', runtimeLauncherUnavailable: 'Host Launcher supervision lost', runtimeMaintenance: 'Platform maintenance in progress', fullAccess: 'Full access', apiRequests: 'API', logStreams: 'Logs', synced: 'Runtime status synchronized', imported: 'Configuration imported', confirmCompleteTask: 'Complete and archive this task? The Codex CLI will end and its transcript will remain available as read-only history.', confirmRestoreTask: 'Restore this archived task and continue its latest Codex Session?', confirmResetTask: 'Reset the current Codex context? The Task configuration, ID, and history remain; the old Runtime is reclaimed and the next run creates a new Session.', confirmDeleteTask: 'Delete this session and all of its worklogs?', confirmDeleteSkill: 'Delete this managed skill?',
    payload: 'Event details', actor: 'Actor', requestId: 'Request ID', turnInput: 'Turn input', fullCommand: 'Full command', commandOutput: 'Execution output', attempt: 'Attempt', exitCode: 'Exit code', pid: 'Process ID', signal: 'Exit signal', attemptError: 'Error', configuredWorkingDir: 'Configured working directory', runtimeWorkingDir: 'Runtime working directory', runtimeDirUnreported: 'Not reported by runtime', noWorklog: 'No Agent worklog has been recorded for this Session.', noOperations: 'No control-plane operation has been recorded for this Session.', noAttempts: 'Task Terminal is waiting for output.', noExecutions: 'No command execution has been recorded for this session.', noBackground: 'No background execution or scheduled check has been recorded for this Session.', externalExecution: 'Background execution', scheduledCheck: 'Scheduled check', generation: 'Generation', interval: 'Check interval', backgroundCommand: 'Full background command', backgroundOutput: 'Business process output', commandPath: 'Command record', viewFullLog: 'View full raw output', sessionStdout: 'Agent stdout', sessionStderr: 'Agent stderr', viewInlineOutput: 'Open terminal', hideInlineOutput: 'Collapse terminal', openRawOutput: 'Open complete raw output', loadingOutput: 'Connecting to live terminal...', liveOutput: 'Live', reconnectingOutput: 'Reconnecting', completeOutput: 'Finished', inlineOutputLimit: 'Inline limit reached', emptyOutput: '(empty output)', outputBytes: 'bytes', logPath: 'Log', donePath: 'Done marker', statePath: 'State file', lastObservation: 'Last observation', archivePreservation: 'Log preservation', archiveBytes: 'Preserved bytes', archiveSha256: 'SHA-256', archiveError: 'Preservation error', task: 'Task', unknown: 'Unknown', loadFailed: 'Load failed', actionFailed: 'Action failed',
    checkNotNeeded: 'No check needed', scheduleOutcome: 'Schedule outcome', backgroundAlreadyFinished: 'The background task has already finished, so this scheduled check did not need to run. See the linked background execution for the business result.', backgroundPytestExecution: 'pytest background execution', processStartedAt: 'Actually started', processFinishedAt: 'Actually finished', platformConfirmedAt: 'Platform confirmed', scheduledDueAt: 'Check planned', scheduledFinishedAt: 'Check completed', scheduleResolvedAt: 'Schedule resolved', linkedBackground: 'Linked execution', scheduleAttempts: 'Check attempts', logArchived: 'Preserved',
    businessReports: 'Structured Reports', noBusinessReports: 'No structured report or primary execution has been recorded.', reportRevision: 'Revision', reportObservedAt: 'Observed', reportPublishedAt: 'Published', reportRawPayload: 'Raw report', pytestHtmlReport: 'Pytest HTML report', failureAnalysisReport: 'Failure analysis report', openHtmlReport: 'Open report', openMarkdownReport: 'Open report', artifactRegisteredRunning: 'Registered · Running', artifactRegisteredPending: 'Registered · Awaiting archive', artifactUnavailable: 'Report file was not generated or is empty', reportStatusPending: 'Pending', reportStatusRunning: 'Running', reportStatusSucceeded: 'Passed', reportStatusFailed: 'Failed', reportStatusPartial: 'Partial', reportStatusBlocked: 'Blocked', reportStatusCancelled: 'Cancelled', reportStatusUnknown: 'Unknown',
    attributedSkills: 'Skills Actually Used', noAttributedSkills: 'No Skill declared', correctAttribution: 'Correct Attribution', attributionHistory: 'Attribution and Correction History', runtimeDeclared: 'Runtime declaration', operatorCorrection: 'Operator correction', linked: 'Linked', unlinked: 'Removed', correctionReason: 'Correction reason', correctionReasonHint: 'Explain why these Skills are added or removed. The reason becomes a permanent audit record.', saveCorrection: 'Save Correction', skillAttributionSaved: 'Skill attribution saved', unresolvedSkills: 'Declarations missing from snapshot', skillSnapshotOptions: 'Skills in the Frozen Task Snapshot', version: 'Version', contentHash: 'Content hash', noSnapshotSkills: 'This task does not have a frozen Skill snapshot yet.',
    navRuntime: 'Runtime Inventory', runtimeInventoryTitle: 'Runtime Inventory', runtimeInventorySubtitle: 'Inspect platform data protection and native Bridge Session Runtime usage, ownership, and safety.', nativeRuntime: 'Native Runtime', runtimeInventoryHeadline: 'Native Session Resources & Ownership', inventoryNotScanned: 'Not scanned yet', loadingInventory: 'Scanning Runtime inventory...', inventoryScanned: 'Scanned {time}', refreshInventory: 'Refresh Status', inventoryTotal: 'All Sessions', inventoryReclaimable: 'Reclaimable', inventoryBytes: 'Runtime Usage', inventoryReclaimableBytes: 'Releasable Space', inventoryStateSummary: '{safe} safe · {queued} reclaiming · {unsafe} need review', noBridgeSessions: 'No retained native Bridge Session Runtime.',
    bridgeCategoryTaskOwned: 'Task Owned', bridgeCategoryCompletedRetained: 'Completed Retained', bridgeCategoryOrphan: 'Orphan', bridgeCategoryCleanupQueued: 'Reclaiming', bridgeCategoryCleanupInconsistent: 'Cleanup Inconsistent', bridgeCategoryUnsafe: 'Unsafe', taskOwner: 'Task Owner', noTaskOwner: 'No Task Owner', resourceRecord: 'Record', resourceCodexHome: 'Codex Home', resourceWorkspace: 'Workspace', resourceChatfile: 'Chatfile', resourceWorkspaceLock: 'Workspace Lock', resourceSessionRunLock: 'Run Lock', lastRun: 'Last Run', neverRun: 'Never', resourcePresent: 'Present', resourceMissing: 'Missing', deleteReleaseRuntime: 'Delete & Release Disk', confirmRuntimeReclaim: 'Confirm Runtime Deletion', runtimeReclaimWarning: 'Native Session Runtime cannot be recovered after deletion. Platform task history and audit records remain.', targetSession: 'Target Session', typeSessionId: 'Enter the full Session ID', sessionIdConfirmation: 'session-0123456789abcdef', bridgeReclaimQueued: 'Runtime deletion queued', bridgeReclaimCompleted: 'Runtime deleted and released', bridgeReclaimOutcomeUnknown: 'Deletion outcome is unknown. Inventory was reconciled; retrying the same Session ID is safe.', bridgeSessionNoLongerReclaimable: 'This Session no longer exists or cannot be deleted. Refresh inventory.', bridgeReclaimInProgress: 'A Runtime deletion request is already being submitted. Wait for its result.',
    dataProtection: 'Data Protection', dataProtectionHeading: 'Data Integrity & Recovery Protection', loadingProtection: 'Checking data protection status...', noProtectionStatus: 'Data protection status has not been checked.', protectionChecked: 'Checked {time}', protectionRefreshFailed: 'Status refresh failed: {error}', platformStorage: 'Platform Data', databaseBackup: 'Online Database Backups', recoveryCheckpoint: 'Recovery Checkpoints', terminalLogArchive: 'Terminal Log Preservation', protectionHealthy: 'Healthy', protectionDegraded: 'Degraded', protectionPending: 'Pending', protectionInProgress: 'In Progress', protectionRotationPending: 'Rotation Pending', sqliteCheck: 'SQLite Check', stateInvariants: 'State Invariants', storageHeadroom: 'Lowest Free Space', lastSuccess: 'Last Success', nextRun: 'Next Run', packageRetention: 'Available / Retention', auditContinuity: 'Audit Continuity', auditHealthy: 'Persisted', auditPending: '{count} pending', invariantIssues: '{count} issues', storageAvailable: '{percent}% · {bytes}', rotationPendingDetail: '{count} excess; rotates after next successful publish', schedulerError: 'Scheduler Error', unreadablePackages: 'Unreadable Packages', archiveCoverage: 'Preservation Coverage', archiveCoverageDetail: '{archived} / {total} terminal logs', archiveLastVerified: 'Last Full Verification', archiveFailures: 'Preservation Failures', archiveFailureDetail: '{count} require repair',
  },
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const tr = (key) => messages[state.lang][key] || messages.zh[key] || key;

function trf(key, values = {}) {
  return tr(key).replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, name) => String(values[name] ?? ''));
}

function apiErrorMessage(data, fallback) {
  if (data?.code !== 'interactive_codex_cli_active') return data?.error || data || fallback;
  const operationKey = {
    running: 'taskOperationRunning',
    deleting: 'taskOperationDeleting',
    completing: 'taskOperationCompleting',
    resetting: 'taskOperationResetting',
  }[data.operation] || 'taskOperationRetry';
  return trf('interactiveCliConflict', { operation: tr(operationKey) });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function slugify(value) {
  return String(value || '').trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function formatTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  const locale = state.lang === 'zh' ? 'zh-CN' : 'en-US';
  if (!dateTimeFormatters.has(locale)) {
    dateTimeFormatters.set(locale, new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }));
  }
  return dateTimeFormatters.get(locale).format(date);
}

function formatTimelineTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  const locale = state.lang === 'zh' ? 'zh-CN' : 'en-US';
  const key = `timeline:${locale}`;
  if (!dateTimeFormatters.has(key)) {
    dateTimeFormatters.set(key, new Intl.DateTimeFormat(locale, {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }));
  }
  return dateTimeFormatters.get(key).format(date);
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value || 0));
  if (!Number.isFinite(bytes) || bytes === 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const amount = bytes / (1024 ** index);
  const locale = state.lang === 'zh' ? 'zh-CN' : 'en-US';
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: index === 0 ? 0 : 1 }).format(amount)} ${units[index]}`;
}

function renderHtml(key, target, html) {
  const element = typeof target === 'string' ? $(target) : target;
  if (renderCache.get(key) === html) return false;
  renderCache.set(key, html);
  element.innerHTML = html;
  return true;
}

async function api(path, options = {}) {
  const {
    timeoutMs: configuredTimeoutMs = API_REQUEST_TIMEOUT_MS,
    acceptedStatuses = [],
    ...requestOptions
  } = options;
  const timeoutMs = Number.isFinite(Number(configuredTimeoutMs)) && Number(configuredTimeoutMs) > 0
    ? Math.floor(Number(configuredTimeoutMs))
    : API_REQUEST_TIMEOUT_MS;
  const sourceSignal = requestOptions.signal || null;
  const controller = new AbortController();
  let timedOut = false;
  const abortFromSource = () => controller.abort();
  if (sourceSignal?.aborted) abortFromSource();
  else sourceSignal?.addEventListener('abort', abortFromSource, { once: true });
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const config = {
    ...requestOptions,
    credentials: requestOptions.credentials || 'same-origin',
    signal: controller.signal,
    headers: { ...(requestOptions.headers || {}) },
  };
  const authHeader = getAuthHeader();
  if (authHeader && !config.headers.Authorization && !config.headers.authorization) {
    config.headers.Authorization = authHeader;
  }
  const isBinaryBody = typeof Blob !== 'undefined' && config.body instanceof Blob;
  if (config.body && typeof config.body !== 'string' && !isBinaryBody) {
    config.headers['Content-Type'] = 'application/json';
    config.body = JSON.stringify(config.body);
  }
  try {
    const response = await fetch(path, config);
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json() : await response.text();
    const acceptedStatus = Array.isArray(acceptedStatuses) && acceptedStatuses.includes(response.status);
    if (response.status === 401) {
      showAuthOverlay(data?.error || 'Authentication required');
    }
    if (!response.ok && !acceptedStatus) {
      const error = new Error(apiErrorMessage(data, `${response.status}`));
      error.status = response.status;
      if (data?.code) error.code = data.code;
      throw error;
    }
    return data;
  } catch (error) {
    if (timedOut) {
      scheduleDashboardPoll(0);
      throw Object.assign(new Error(tr('requestTimeout')), { name: 'RequestTimeoutError' });
    }
    throw error;
  } finally {
    clearTimeout(timeoutTimer);
    sourceSignal?.removeEventListener('abort', abortFromSource);
  }
}

function taskRunBaseline(task) {
  const version = Number(task?.version);
  return {
    version: Number.isFinite(version) ? version : null,
    status: String(task?.status || ''),
    updatedAt: String(task?.updatedAt || ''),
    createdAt: String(task?.createdAt || ''),
  };
}

function normalizeStoredRunIntent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.taskId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.taskId)) return null;
  if (typeof value.inputHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.inputHash)) return null;
  if (typeof value.idempotencyKey !== 'string'
    || value.idempotencyKey.length < 1 || value.idempotencyKey.length > 256) return null;
  const baseline = value.baseline;
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) return null;
  const version = baseline.version === null ? null : Number(baseline.version);
  if (version !== null && (!Number.isSafeInteger(version) || version < 0)) return null;
  for (const field of ['status', 'updatedAt', 'createdAt']) {
    if (typeof baseline[field] !== 'string' || baseline[field].length > 128) return null;
  }
  return {
    taskId: value.taskId,
    inputHash: value.inputHash,
    idempotencyKey: value.idempotencyKey,
    baseline: {
      version,
      status: baseline.status,
      updatedAt: baseline.updatedAt,
      createdAt: baseline.createdAt,
    },
  };
}

function loadRunIntents() {
  const intents = new Map();
  try {
    const storage = globalThis.sessionStorage;
    const serialized = storage?.getItem(RUN_INTENT_STORAGE_KEY);
    if (!serialized) return intents;
    if (serialized.length > 128 * 1024) throw new Error('Stored run intents exceed the size limit');
    const entries = JSON.parse(serialized);
    if (!Array.isArray(entries)) throw new Error('Stored run intents must be an array');
    for (const entry of entries.slice(0, RUN_INTENT_STORAGE_LIMIT)) {
      const intent = normalizeStoredRunIntent(entry);
      if (intent) intents.set(intent.taskId, intent);
    }
    return intents;
  } catch {
    try { globalThis.sessionStorage?.removeItem(RUN_INTENT_STORAGE_KEY); } catch {}
    return intents;
  }
}

function persistRunIntents() {
  try {
    const storage = globalThis.sessionStorage;
    if (!storage) return;
    const entries = [...runIntents.values()]
      .filter((intent) => /^[a-f0-9]{64}$/.test(intent.inputHash || ''))
      .slice(-RUN_INTENT_STORAGE_LIMIT)
      .map((intent) => ({
        taskId: intent.taskId,
        inputHash: intent.inputHash,
        idempotencyKey: intent.idempotencyKey,
        baseline: intent.baseline,
      }));
    if (entries.length) storage.setItem(RUN_INTENT_STORAGE_KEY, JSON.stringify(entries));
    else storage.removeItem(RUN_INTENT_STORAGE_KEY);
  } catch {}
}

async function hashRunInput(input) {
  try {
    if (!globalThis.crypto?.subtle || typeof globalThis.TextEncoder !== 'function') return '';
    const bytes = new globalThis.TextEncoder().encode(String(input || ''));
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
  } catch {
    return '';
  }
}

function createClientIdempotencyKey(prefix) {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${prefix}${uuid || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
}

function createRunIdempotencyKey() {
  return createClientIdempotencyKey('web-run-');
}

async function getRunIntent(task, input) {
  const taskId = String(task.id);
  const normalizedInput = String(input || '');
  const inputHash = await hashRunInput(normalizedInput);
  const current = runIntents.get(taskId);
  const sameInput = current && (typeof current.input === 'string'
    ? current.input === normalizedInput
    : Boolean(inputHash) && current.inputHash === inputHash);
  if (sameInput && current.baseline.createdAt === String(task.createdAt || '')) {
    current.input = normalizedInput;
    return current;
  }
  const intent = {
    taskId,
    input: normalizedInput,
    inputHash,
    idempotencyKey: createRunIdempotencyKey(),
    baseline: taskRunBaseline(task),
  };
  if (!runIntents.has(taskId) && runIntents.size >= RUN_INTENT_STORAGE_LIMIT) {
    runIntents.delete(runIntents.keys().next().value);
  }
  runIntents.set(taskId, intent);
  persistRunIntents();
  return intent;
}

function clearRunIntent(taskId, idempotencyKey) {
  const current = runIntents.get(String(taskId));
  if (current?.idempotencyKey === idempotencyKey) {
    runIntents.delete(String(taskId));
    persistRunIntents();
  }
}

function hasUnknownRequestOutcome(error) {
  return error?.name === 'RequestTimeoutError'
    || (error?.name !== 'AbortError' && !Number.isFinite(Number(error?.status)));
}

async function queueTaskRun(task, input = '') {
  const intent = await getRunIntent(task, input);
  try {
    const result = await api(`/api/sessions/${encodeURIComponent(task.id)}/run`, {
      method: 'POST',
      body: { input: intent.input, idempotencyKey: intent.idempotencyKey },
    });
    clearRunIntent(intent.taskId, intent.idempotencyKey);
    return result;
  } catch (error) {
    if (!hasUnknownRequestOutcome(error)) clearRunIntent(intent.taskId, intent.idempotencyKey);
    throw error;
  }
}

function reconcileRunIntents(sessions) {
  if (!runIntents.size) return;
  const tasks = new Map((sessions || []).map((task) => [String(task.id), task]));
  let changed = false;
  for (const [taskId, intent] of runIntents) {
    const task = tasks.get(taskId);
    if (!task) continue;
    const observed = taskRunBaseline(task);
    if (observed.createdAt !== intent.baseline.createdAt
      || observed.version !== intent.baseline.version
      || observed.status !== intent.baseline.status
      || observed.updatedAt !== intent.baseline.updatedAt) {
      runIntents.delete(taskId);
      changed = true;
    }
  }
  if (changed) persistRunIntents();
}

function taskOperationIntentId(taskId, operation) {
  return `${operation}:${taskId}`;
}

function normalizeStoredTaskOperationIntent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.taskId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.taskId)) return null;
  if (!TASK_OPERATIONS.has(value.operation)) return null;
  if (typeof value.idempotencyKey !== 'string'
    || value.idempotencyKey.length < 1 || value.idempotencyKey.length > 256) return null;
  if (typeof value.taskCreatedAt !== 'string' || value.taskCreatedAt.length > 128) return null;
  return {
    taskId: value.taskId,
    operation: value.operation,
    idempotencyKey: value.idempotencyKey,
    taskCreatedAt: value.taskCreatedAt,
  };
}

function loadTaskOperationIntents() {
  const intents = new Map();
  try {
    const serialized = globalThis.sessionStorage?.getItem(TASK_OPERATION_INTENT_STORAGE_KEY);
    if (!serialized) return intents;
    if (serialized.length > 64 * 1024) throw new Error('Stored task operation intents exceed the size limit');
    const entries = JSON.parse(serialized);
    if (!Array.isArray(entries)) throw new Error('Stored task operation intents must be an array');
    for (const entry of entries.slice(0, TASK_OPERATION_INTENT_STORAGE_LIMIT)) {
      const intent = normalizeStoredTaskOperationIntent(entry);
      if (intent) intents.set(taskOperationIntentId(intent.taskId, intent.operation), intent);
    }
    return intents;
  } catch {
    try { globalThis.sessionStorage?.removeItem(TASK_OPERATION_INTENT_STORAGE_KEY); } catch {}
    return intents;
  }
}

function persistTaskOperationIntents() {
  try {
    const entries = [...taskOperationIntents.values()].slice(-TASK_OPERATION_INTENT_STORAGE_LIMIT);
    if (entries.length) {
      globalThis.sessionStorage?.setItem(TASK_OPERATION_INTENT_STORAGE_KEY, JSON.stringify(entries));
    } else {
      globalThis.sessionStorage?.removeItem(TASK_OPERATION_INTENT_STORAGE_KEY);
    }
  } catch {}
}

function taskOperationIntent(task, operation) {
  const taskId = String(task.id);
  const taskCreatedAt = String(task.createdAt || '');
  const intentId = taskOperationIntentId(taskId, operation);
  const current = taskOperationIntents.get(intentId);
  if (current?.taskCreatedAt === taskCreatedAt) return current;
  const intent = {
    taskId,
    operation,
    idempotencyKey: createClientIdempotencyKey(`web-${operation}-`),
    taskCreatedAt,
  };
  if (!taskOperationIntents.has(intentId)
    && taskOperationIntents.size >= TASK_OPERATION_INTENT_STORAGE_LIMIT) {
    taskOperationIntents.delete(taskOperationIntents.keys().next().value);
  }
  taskOperationIntents.set(intentId, intent);
  persistTaskOperationIntents();
  return intent;
}

function clearTaskOperationIntent(intent) {
  const intentId = taskOperationIntentId(intent.taskId, intent.operation);
  if (taskOperationIntents.get(intentId)?.idempotencyKey === intent.idempotencyKey) {
    taskOperationIntents.delete(intentId);
    persistTaskOperationIntents();
  }
}

function operationSucceededInState(intent, task) {
  if (task && String(task.createdAt || '') !== intent.taskCreatedAt) {
    return intent.operation === 'delete';
  }
  if (intent.operation === 'delete') return !task;
  if (!task) return false;
  if (intent.operation === 'complete') return task.status === 'completed';
  if (intent.operation === 'restore') return task.status === 'waiting_input';
  if (intent.operation === 'reset') return task.status === 'idle' && !task.persistentSessionKey;
  return ['stopping', 'stopped'].includes(task.status);
}

function reconcileTaskOperationIntents(sessions) {
  if (!taskOperationIntents.size) return;
  const tasks = new Map((sessions || []).map((task) => [String(task.id), task]));
  let changed = false;
  for (const [intentId, intent] of taskOperationIntents) {
    const task = tasks.get(intent.taskId);
    if (task && operationSucceededInState(intent, task)) {
      taskOperationIntents.delete(intentId);
      changed = true;
    }
  }
  if (changed) persistTaskOperationIntents();
}

async function reconcileTaskOperationOutcome(intent) {
  let task = null;
  try {
    task = await api(`/api/sessions/${encodeURIComponent(intent.taskId)}`, { timeoutMs: DASHBOARD_REQUEST_TIMEOUT_MS });
  } catch (error) {
    if (Number(error?.status) !== 404) return false;
  }
  return operationSucceededInState(intent, task);
}

async function reconcilePersistedTaskOperationIntents() {
  if (!taskOperationIntents.size) return;
  const visibleTasks = new Map((state.dashboard.sessions || []).map((task) => [String(task.id), task]));
  await Promise.all([...taskOperationIntents.values()].map(async (intent) => {
    const visibleTask = visibleTasks.get(intent.taskId);
    if (visibleTask) {
      if (operationSucceededInState(intent, visibleTask)) clearTaskOperationIntent(intent);
      return;
    }
    if (await reconcileTaskOperationOutcome(intent)) clearTaskOperationIntent(intent);
  }));
}

async function requestTaskOperation(task, operation) {
  const intent = taskOperationIntent(task, operation);
  const suffix = operation === 'delete' ? '' : `/${operation}`;
  try {
    const result = await api(`/api/sessions/${encodeURIComponent(task.id)}${suffix}`, {
      method: operation === 'delete' ? 'DELETE' : 'POST',
      headers: {
        'Idempotency-Key': intent.idempotencyKey,
        ...(intent.taskCreatedAt ? { 'X-Task-Created-At': intent.taskCreatedAt } : {}),
      },
    });
    if (operation === 'stop' && result?.ok !== true) {
      throw Object.assign(new Error(tr('stopNotApplicable')), { status: 409 });
    }
    clearTaskOperationIntent(intent);
    return result;
  } catch (error) {
    if (!hasUnknownRequestOutcome(error)) {
      clearTaskOperationIntent(intent);
      throw error;
    }
    if (await reconcileTaskOperationOutcome(intent)) {
      clearTaskOperationIntent(intent);
      if (operation === 'complete') return { id: task.id, status: 'completed' };
      if (operation === 'reset') return { id: task.id, status: 'idle', persistentSessionKey: '' };
      return { ok: true };
    }
    throw Object.assign(new Error(tr('operationOutcomeUnknown')), {
      name: error.name,
      cause: error,
    });
  }
}

function toast(message, level = 'info') {
  const element = $('#toast');
  const text = String(message || '');
  $('#toastMarker').textContent = level === 'error' ? '!' : 'i';
  $('#toastMessage').textContent = text;
  element.className = `toast ${level}`;
  clearTimeout(toast.timer);
  const duration = Math.min(12000, Math.max(4800, 2400 + (text.length * 35)));
  toast.timer = setTimeout(() => element.classList.add('hidden'), duration);
}

function terminalFontSize(baseSize) {
  return Math.round(baseSize * FONT_SIZE_PRESETS[state.fontSize].scale);
}

function updateOpenTerminalFontSizes() {
  for (const viewer of attemptTerminalViewers) {
    const view = viewer.attemptTerminalView;
    if (!view?.terminal?.options) continue;
    view.terminal.options.fontSize = terminalFontSize(14);
    fitAttemptTerminal(viewer);
  }
  const codexView = state.codexTerminalView;
  if (!codexView?.terminal?.options) return;
  codexView.terminal.options.fontSize = terminalFontSize(18);
  codexView.fitAddon?.fit();
  if (codexView.mode === 'interactive') {
    sendCodexTerminalControl('resize', {
      cols: codexView.terminal.cols,
      rows: codexView.terminal.rows,
    });
  }
}

function renderFontSizeControl() {
  const control = $('#fontSizeControl');
  control.setAttribute('aria-label', tr('fontSize'));
  $$('#fontSizeControl [data-font-size]').forEach((button) => {
    const selected = button.dataset.fontSize === state.fontSize;
    const label = tr(FONT_SIZE_PRESETS[button.dataset.fontSize].labelKey);
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
    button.setAttribute('aria-label', label);
    button.title = label;
  });
}

function applyFontSize() {
  document.documentElement.dataset.fontSize = state.fontSize;
  renderFontSizeControl();
  updateOpenTerminalFontSizes();
}

function setFontSize(value) {
  if (!FONT_SIZE_PRESETS[value] || value === state.fontSize) return;
  state.fontSize = value;
  try { localStorage.setItem(FONT_SIZE_STORAGE_KEY, value); } catch {}
  applyFontSize();
}

function applyTranslations() {
  document.documentElement.lang = state.lang === 'zh' ? 'zh-CN' : 'en';
  $$('[data-i18n]').forEach((element) => { element.textContent = tr(element.dataset.i18n); });
  $$('[data-i18n-placeholder]').forEach((element) => { element.placeholder = tr(element.dataset.i18nPlaceholder); });
  $('#langToggleBtn').textContent = state.lang === 'zh' ? 'EN' : '中文';
  renderFontSizeControl();
  updateViewHeading();
}

function updateViewHeading() {
  const map = {
    overview: ['overviewTitle', 'overviewSubtitle'],
    tasks: ['tasksTitle', 'tasksSubtitle'],
    'release-cycles': ['releaseCyclesTitle', 'releaseCyclesSubtitle'],
    skills: ['skillsTitle', 'skillsSubtitle'],
    runtime: ['runtimeInventoryTitle', 'storageInventorySubtitle'],
    audit: ['auditTitle', 'auditSubtitle'],
  };
  const [title, subtitle] = map[state.view];
  $('#viewTitle').textContent = tr(title);
  $('#viewSubtitle').textContent = tr(subtitle);
  $('#viewKicker').textContent = state.view === 'overview' ? 'SESSION OPERATIONS' : state.view.toUpperCase();
}

function statusLabel(task) {
  if (task.enabled === false && !isActiveTask(task)) return tr('disabled');
  if (task.recoveryState === 'recoverable' && task.status !== 'running') return tr('recoverable');
  return tr(task.status || 'idle');
}

function statusClass(task) {
  if (task.enabled === false && !isActiveTask(task)) return 'disabled';
  return task.recoveryState === 'recoverable' && task.status !== 'running' ? 'recoverable' : (task.status || 'idle');
}

function isActiveTask(task) {
  return ACTIVE_STATUSES.includes(task?.status);
}

function isReviewTask(task) {
  return REVIEW_STATUSES.includes(task?.status);
}

function needsTaskRecovery(task) {
  return ['failed', 'interrupted', 'stopped'].includes(task.status)
    || task.recoveryState === 'recoverable';
}

function taskClassification(task, { showProject = true } = {}) {
  const project = String(task?.project || 'cloudRecord').trim() || 'cloudRecord';
  const tags = Array.isArray(task?.tags) ? task.tags : [];
  const testType = task?.testType === 'feature' ? 'featureTest' : 'regressionTest';
  const origin = task?.taskOrigin === 'release-cycle' ? 'releaseCycleTask' : 'standaloneTask';
  return `<span class="task-classification">${showProject ? `<span class="task-project-badge">${escapeHtml(project)}</span>` : ''}<span class="task-origin-badge ${escapeHtml(task?.taskOrigin === 'release-cycle' ? 'release-cycle' : 'standalone')}">${escapeHtml(tr(origin))}</span><span class="task-test-type ${escapeHtml(task?.testType === 'feature' ? 'feature' : 'regression')}">${escapeHtml(tr(testType))}</span>${tags.map((tag) => `<span class="task-tag">${escapeHtml(tag)}</span>`).join('')}</span>`;
}

function taskClassificationValues() {
  const tasks = state.dashboard.sessions || [];
  const projects = [...new Set(tasks.map((task) => String(task.project || 'cloudRecord').trim() || 'cloudRecord'))]
    .sort((left, right) => left.localeCompare(right));
  const tags = [...new Set(tasks.flatMap((task) => (Array.isArray(task.tags) ? task.tags : [])))]
    .map((tag) => String(tag).trim()).filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  return { projects, tags };
}

function taskVersionTuple(task) {
  const taggedVersion = (task?.tags || []).find((tag) => /^version:\d+\.\d+\.\d+/i.test(String(tag || '')));
  const sources = [taggedVersion, task?.releaseKey, task?.releaseCycleName, task?.name, task?.id];
  for (const source of sources) {
    const match = String(source || '').match(/(?:^|[^\d])v?(\d+)\.(\d+)\.(\d+)(?=$|[^\d])/i);
    if (match) return [Number(match[1]), Number(match[2]), Number(match[3])];
  }
  return null;
}

function compareTaskDisplayOrder(left, right) {
  const createdDifference = Date.parse(right?.createdAt || 0) - Date.parse(left?.createdAt || 0);
  if (createdDifference) return createdDifference;
  const leftVersion = taskVersionTuple(left);
  const rightVersion = taskVersionTuple(right);
  if (leftVersion && rightVersion) {
    for (let index = 0; index < leftVersion.length; index += 1) {
      if (leftVersion[index] !== rightVersion[index]) return rightVersion[index] - leftVersion[index];
    }
  } else if (leftVersion || rightVersion) {
    return leftVersion ? -1 : 1;
  }
  return String(left?.id || '').localeCompare(String(right?.id || ''));
}

function sortTasksForDisplay(tasks) {
  return [...tasks].sort(compareTaskDisplayOrder);
}

function renderTaskClassificationFilters() {
  const projectSelect = $('#taskProjectFilter');
  const tagSelect = $('#taskTagFilter');
  const testTypeSelect = $('#taskTestTypeFilter');
  const originSelect = $('#taskOriginFilter');
  if (!projectSelect || !tagSelect || !testTypeSelect || !originSelect) return;
  const { projects, tags } = taskClassificationValues();
  if (state.taskProjectFilter && !projects.includes(state.taskProjectFilter)) state.taskProjectFilter = '';
  if (state.taskTagFilter && !tags.includes(state.taskTagFilter)) state.taskTagFilter = '';
  if (state.taskTestTypeFilter && !['feature', 'regression'].includes(state.taskTestTypeFilter)) state.taskTestTypeFilter = '';
  if (state.taskOriginFilter && !['standalone', 'release-cycle'].includes(state.taskOriginFilter)) state.taskOriginFilter = '';
  projectSelect.innerHTML = [`<option value="">${escapeHtml(tr('allProjects'))}</option>`, ...projects.map((project) => `<option value="${escapeHtml(project)}">${escapeHtml(project)}</option>`)].join('');
  tagSelect.innerHTML = [`<option value="">${escapeHtml(tr('allTags'))}</option>`, ...tags.map((tag) => `<option value="${escapeHtml(tag)}">${escapeHtml(tag)}</option>`)].join('');
  testTypeSelect.innerHTML = `<option value="">${escapeHtml(tr('allTestTypes'))}</option><option value="feature">${escapeHtml(tr('featureTest'))}</option><option value="regression">${escapeHtml(tr('regressionTest'))}</option>`;
  originSelect.innerHTML = `<option value="">${escapeHtml(tr('allTaskOrigins'))}</option><option value="standalone">${escapeHtml(tr('standaloneTask'))}</option><option value="release-cycle">${escapeHtml(tr('releaseCycleTask'))}</option>`;
  projectSelect.value = state.taskProjectFilter;
  tagSelect.value = state.taskTagFilter;
  testTypeSelect.value = state.taskTestTypeFilter;
  originSelect.value = state.taskOriginFilter;
}

function taskProgressRunHtml(labelKey, progress) {
  if (!progress?.available) {
    return `<div class="task-progress-run task-progress-run-empty"><span>${escapeHtml(tr(labelKey))}</span><strong>${escapeHtml(tr('taskCaseProgressUnavailable'))}</strong></div>`;
  }
  const total = Math.max(0, Number(progress.total || 0));
  if (progress.resultKnown === false || progress.status === 'unknown') {
    return `<div class="task-progress-run task-progress-run-empty"><span>${escapeHtml(tr(labelKey))}</span><strong>${escapeHtml(trf('taskCaseProgressUnknown', { total }))}</strong></div>`;
  }
  const completed = Math.min(total, Math.max(0, Number(progress.completed || 0)));
  const percent = Math.min(100, Math.max(0, Number(progress.percent || (total ? Math.round((completed / total) * 100) : 0))));
  return `<div class="task-progress-run ${escapeHtml(progress.status || 'partial')}">
    <div class="task-progress-head"><span>${escapeHtml(tr(labelKey))}</span><strong>${escapeHtml(trf('taskCaseProgressCount', { completed, total }))}</strong></div>
    <div class="task-progress-track" role="progressbar" aria-label="${escapeHtml(tr('taskCaseProgress'))}" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${completed}"><i style="--progress:${percent}%"></i></div>
    <div class="task-progress-meta"><span class="task-progress-pass">${escapeHtml(trf('taskCasePassed', { count: Number(progress.passed || 0) }))}</span><span class="task-progress-fail">${escapeHtml(trf('taskCaseFailed', { count: Number(progress.failed || 0) }))}</span>${Number(progress.skipped || 0) ? `<span class="task-progress-skip">${escapeHtml(trf('taskCaseSkipped', { count: Number(progress.skipped || 0) }))}</span>` : ''}</div>
  </div>`;
}

function taskTestProgressHtml(task) {
  const runs = task?.testProgress?.runs;
  if (!runs?.initial?.available && !runs?.rerun1?.available) {
    return `<div class="task-progress task-progress-empty"><span>${escapeHtml(tr('taskCaseProgress'))}</span><strong>${escapeHtml(tr('taskCaseProgressUnavailable'))}</strong></div>`;
  }
  return `<div class="task-progress"><div class="task-progress-runs">${taskProgressRunHtml('taskInitialProgress', runs.initial)}${taskProgressRunHtml('taskRerun1Progress', runs.rerun1)}</div></div>`;
}

function taskCard(task, layout = 'list') {
  const running = isActiveTask(task);
  const review = isReviewTask(task);
  const recover = !running && !review && task.status !== 'completed' && needsTaskRecovery(task);
  const recovering = pendingTaskRecoveries.has(task.id);
  const actionLabel = recovering ? tr('recovering')
    : (review ? tr('reviewTask') : (recover ? tr('recover') : tr('start')));
  const grid = layout === 'grid';
  const badge = `<span class="status-badge ${escapeHtml(statusClass(task))}">${escapeHtml(statusLabel(task))}</span>`;
  return `
    <article class="task-card${grid ? ' task-card-grid' : ''} ${escapeHtml(statusClass(task))}">
      ${grid ? `<button type="button" class="card-hit" data-action="open-task" data-id="${escapeHtml(task.id)}" aria-label="${escapeHtml(`${tr('open')} ${task.name}`)}"></button>` : ''}
      ${grid ? `<div class="task-card-overline"><span class="task-project-badge">${escapeHtml(task.project || 'cloudRecord')}</span>${badge}</div>` : ''}
      <div class="task-row-main">
        <div class="task-card-head">
          <div class="task-identity">
            <span class="session-symbol">S</span>
            <div><h3><button class="task-title-button" data-action="open-task" data-id="${escapeHtml(task.id)}">${escapeHtml(task.name)}</button></h3><code>${escapeHtml(task.id)}</code></div>
          </div>
        </div>
        ${taskClassification(task, { showProject: !grid })}
        ${grid ? taskTestProgressHtml(task) : ''}
        ${grid ? '' : `<details class="task-description" data-objective-id="${escapeHtml(task.id)}"${state.expandedTaskObjectives.has(task.id) ? ' open' : ''}>
          <summary><span class="task-objective-label">${escapeHtml(tr('taskObjective'))}</span><span class="task-objective-preview">${escapeHtml(task.objective || task.summary || '-')}</span><span class="objective-expand">${escapeHtml(tr('expandObjective'))}</span><span class="objective-collapse">${escapeHtml(tr('collapseObjective'))}</span></summary>
          <p class="task-objective">${escapeHtml(task.objective || task.summary || '-')}</p>
        </details>`}
      </div>
      <div class="task-row-status">
        ${grid ? '' : badge}
        <dl class="session-meta">
          <div><dt>${escapeHtml(tr('workspace'))}</dt><dd>${escapeHtml(task.workingDir || '.')}</dd></div>
          <div><dt>${escapeHtml(tr('runCount'))}</dt><dd>${Number(task.runCount || 0)}</dd></div>
          ${task.nextScheduledAt || grid ? `<div><dt>${escapeHtml(tr('nextCheck'))}</dt><dd>${task.nextScheduledAt ? escapeHtml(formatTime(task.nextScheduledAt)) : '-'}</dd></div>` : ''}
        </dl>
      </div>
      <div class="card-actions">
        <button class="button secondary small" data-action="open-task-reports" data-id="${escapeHtml(task.id)}">${escapeHtml(tr('taskReports'))}</button>
        <button class="button secondary small" data-action="open-task-terminal" data-id="${escapeHtml(task.id)}">${escapeHtml(tr('terminal'))}</button>
        ${running
          ? `<button class="button danger small" data-action="stop-task" data-id="${escapeHtml(task.id)}">${escapeHtml(tr('stop'))}</button>`
          : `<button class="button primary small" data-action="${recover ? 'recover-task' : 'open-task'}" data-id="${escapeHtml(task.id)}"${recover && (recovering || task.enabled === false) ? ' disabled' : ''}>${escapeHtml(actionLabel)}</button>`}
      </div>
    </article>`;
}

function historyRow(task) {
  return `
    <button class="history-row" data-action="open-task" data-id="${escapeHtml(task.id)}">
      <span class="history-mark">S</span>
      <span class="history-main"><strong>${escapeHtml(task.name)}</strong><small>${escapeHtml(task.summary || task.objective || '-')}</small>${taskClassification(task)}</span>
      <span class="history-session">${escapeHtml(task.id)}</span>
      <span class="history-time">${escapeHtml(formatTime(task.archivedAt || task.lastFinishedAt))}</span>
      <span class="status-badge completed">${escapeHtml(tr('completed'))}</span>
    </button>`;
}

function eventMetadata(event) {
  const parts = [];
  if (event.actor) parts.push(`${tr('actor')}: ${event.actor}`);
  if (event.requestId) parts.push(`${tr('requestId')}: ${event.requestId}`);
  if (event.sessionId) parts.push(`${tr('task')}: ${event.sessionId}`);
  else if (event.scope) parts.push(event.scope);
  return parts.join(' · ');
}

function eventList(events, emptyKey = 'noAudit') {
  if (!events.length) return `<div class="empty-state">${escapeHtml(tr(emptyKey))}</div>`;
  return events.map((event) => `
    <article class="event-item ${escapeHtml(event.level || 'info')}">
      <div class="event-rail"><span></span></div>
      <div class="event-content">
        <div class="event-top"><code>${escapeHtml(event.kind || 'event')}</code><time>${escapeHtml(formatTime(event.ts))}</time></div>
        <p>${escapeHtml(event.message || '-')}</p>
        ${commandExecutionDetail(event)}
        <div class="event-meta">${escapeHtml(eventMetadata(event))}</div>
        ${event.payload ? `<details><summary>${escapeHtml(tr('payload'))}</summary><pre>${escapeHtml(JSON.stringify(event.payload, null, 2))}</pre></details>` : ''}
      </div>
    </article>`).join('');
}

function commandExecutionDetail(event) {
  const item = event?.payload?.event?.item;
  if (!item || item.type !== 'command_execution') return '';
  const output = item.aggregated_output ?? item.output ?? item.stdout ?? '';
  return `<div class="command-audit">
    <span>${escapeHtml(tr('fullCommand'))}</span>
    <pre>${escapeHtml(item.command || '')}</pre>
    <span>${escapeHtml(tr('commandOutput'))}</span>
    <pre>${escapeHtml(output || '-')}</pre>
  </div>`;
}

function worklogEventList(events) {
  const finalReplies = new Map();
  events.forEach((event) => {
    if (event.kind === 'session.turn.result' && event.turnId) {
      finalReplies.set(event.turnId, String(event.message || ''));
    }
  });
  const visibleEvents = events.filter((event, index) => {
    const item = event?.payload?.event?.item;
    if (item?.type === 'command_execution') return false;
    if (item?.type === 'agent_message' && event.turnId
      && finalReplies.get(event.turnId) === String(event.message || '')) return false;
    const previous = events[index - 1];
    if (event.kind === 'runtime.turn.failed'
      && previous?.kind === 'runtime.error'
      && previous.turnId === event.turnId
      && String(previous.message || '') === String(event.message || '')) return false;
    return true;
  }).map((event) => {
    const item = event?.payload?.event?.item;
    const payloadRepeatsMessage = item?.type === 'agent_message'
      || ['runtime.error', 'runtime.turn.failed'].includes(event.kind)
      || (event.kind === 'session.turn.result'
        && String(event.payload?.result || '') === String(event.message || ''));
    return payloadRepeatsMessage ? { ...event, payload: null } : event;
  });
  return eventList(visibleEvents, 'noWorklog');
}

function reportStatusPresentation(status) {
  const values = {
    pending: ['reportStatusPending', 'neutral'],
    running: ['reportStatusRunning', 'info'],
    succeeded: ['reportStatusSucceeded', 'success'],
    failed: ['reportStatusFailed', 'danger'],
    partial: ['reportStatusPartial', 'warning'],
    blocked: ['reportStatusBlocked', 'warning'],
    cancelled: ['reportStatusCancelled', 'neutral'],
    unknown: ['reportStatusUnknown', 'neutral'],
  };
  const [label, tone] = values[status] || values.unknown;
  return { label: tr(label), tone };
}

function reportDisplayValue(value, format = 'text') {
  if (value == null || value === '') return '-';
  if (format === 'datetime') return formatTime(value);
  if (format === 'bytes') return formatBytes(value);
  return String(value);
}

function reportValueHtml(value, format = 'text', tone = 'neutral') {
  const display = escapeHtml(reportDisplayValue(value, format));
  return ['code', 'url'].includes(format)
    ? `<code class="report-value tone-${escapeHtml(tone)}">${display}</code>`
    : `<span class="report-value tone-${escapeHtml(tone)}">${display}</span>`;
}

function executionCommandDetails(command, preClass = 'business-command', key = '') {
  const identity = key ? ` data-detail-key="command:${escapeHtml(key)}"` : '';
  return `<details class="command-details"${identity}><summary>${escapeHtml(tr('actualCommand'))}</summary><pre class="${escapeHtml(preClass)}"><span aria-hidden="true">$</span> ${escapeHtml(command || '')}</pre></details>`;
}

function skillReportSection(section) {
  const description = section.description
    ? `<p class="report-section-description">${escapeHtml(section.description)}</p>`
    : '';
  let content = '';
  if (section.kind === 'fields') {
    content = `<dl class="report-fields">${(section.fields || []).map((field) => `
      <div><dt>${escapeHtml(field.label)}</dt><dd>${reportValueHtml(field.value, field.format, field.tone)}</dd></div>`).join('')}</dl>`;
  } else if (section.kind === 'list') {
    content = `<ul class="report-list">${(section.items || []).map((item) => `
      <li class="tone-${escapeHtml(item.tone || 'neutral')}">${item.label ? `<strong>${escapeHtml(item.label)}</strong>` : ''}<span>${escapeHtml(reportDisplayValue(item.value))}</span></li>`).join('')}</ul>`;
  } else if (section.kind === 'table') {
    content = `<div class="report-table-scroll"><table class="report-table"><thead><tr>${(section.columns || []).map((column) => `<th>${escapeHtml(column.label)}</th>`).join('')}</tr></thead><tbody>${(section.rows || []).map((row) => `<tr>${(section.columns || []).map((column) => `<td>${reportValueHtml(row[column.key], column.format)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  } else {
    content = `<pre class="report-json">${escapeHtml(JSON.stringify(section.data, null, 2))}</pre>`;
  }
  const expanded = section.defaultExpanded === true
    && section.sensitivity !== 'sensitive'
    && section.kind !== 'json'
    && !/(?:^|[-_\s])(?:command|execution)(?:$|[-_\s])|执行命令|实际执行.*命令/i.test(`${section.id || ''} ${section.title || ''}`);
  return `<details class="report-section priority-${escapeHtml(section.priority || 'supporting')} sensitivity-${escapeHtml(section.sensitivity || 'normal')}"${expanded ? ' open' : ''}>
    <summary><span>${escapeHtml(section.title)}</span><code>${escapeHtml(section.kind || 'fields')}</code></summary>
    <div class="report-section-body">${description}${content}</div>
  </details>`;
}

function reportArtifactNameFromPath(value) {
  const pathParts = String(value || '').split(/[\\/]/).filter(Boolean);
  const fileName = pathParts.at(-1) || '';
  if (/^result\.html?$/i.test(fileName) && pathParts.length >= 3 && pathParts.at(-2) === 'report') {
    return `${pathParts.at(-3)}.html`;
  }
  return fileName;
}

function reportArtifactDisplayName(artifact, declarations, fallbackLabel) {
  const fileName = String(artifact?.fileName || '').trim() || tr(fallbackLabel);
  const displayFileName = String(artifact?.displayFileName || '').trim();
  if (displayFileName) return displayFileName;
  const artifactKey = String(artifact?.key || '').trim();
  if (artifact?.kind !== 'pytest-html' || !/^result\.html?$/i.test(fileName)) return fileName;
  const declaration = (declarations || []).find((candidate) => (
    candidate?.kind === artifact.kind && String(candidate.key || '') === artifactKey
      && (!artifact.reportKey || candidate.reportKey === artifact.reportKey)
  ));
  return reportArtifactNameFromPath(declaration?.path) || (artifactKey ? `${artifactKey}.html` : fileName);
}

function reportArtifactIdentity(artifact) {
  return `${artifact.reportKey || ''}\0${artifact.kind}\0${artifact.key || artifact.fileName || artifact.id || ''}`;
}

function reportArtifactViewerUrl(artifactUrl, displayName) {
  const parameters = new URLSearchParams({ artifact: artifactUrl, title: displayName });
  return `/report-viewer.html?${parameters}`;
}

function reportFilenameCopyButton(displayName) {
  return `<button type="button" class="report-artifact-copy" data-action="copy-report-name" data-copy-text="${escapeHtml(displayName)}" title="${escapeHtml(tr('copyReportName'))}" aria-label="${escapeHtml(tr('copyReportName'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg></button>`;
}

function failureAnalysisReportLinks(reports) {
  const entries = new Map();
  for (const report of latestReportRevisions(reports)) {
    const add = (artifact, registered) => {
      if (!['failure-analysis-html', 'failure-analysis-markdown'].includes(artifact.kind)) return;
      const scoped = { ...artifact, reportKey: report.reportKey || report.id || '' };
      const key = reportArtifactIdentity(scoped);
      if (!entries.has(key)) entries.set(key, { artifact: scoped, report, registered });
    };
    for (const artifact of report.artifacts || []) add(artifact, false);
    for (const artifact of report.registeredArtifacts || []) add(artifact, true);
  }
  if (!entries.size) return '';
  return `<section class="failure-analysis-reports" aria-label="${escapeHtml(tr('failureAnalysisReport'))}">
    <div class="failure-analysis-reports-heading"><strong>${escapeHtml(tr('failureAnalysisReport'))}</strong><span>${escapeHtml(tr('analysisReportHint'))}</span></div>
    <div class="failure-analysis-report-list">${[...entries.values()].map(({ artifact, report, registered }) => {
      const name = reportArtifactDisplayName(artifact, report.artifactDeclarations || [], 'failureAnalysisReport');
      const available = artifact.url && artifact.available !== false;
      const detail = artifact.available === false ? tr('artifactUnavailable')
        : registered ? tr('artifactRegisteredPending') : formatBytes(artifact.bytes || 0);
      return `<div class="failure-analysis-report">
        <div class="failure-analysis-report-meta"><strong>${escapeHtml(report.title || name)}</strong><span><code>${escapeHtml(name)}</code><small>${escapeHtml(detail)}</small></span></div>
        <div class="failure-analysis-report-actions">${reportFilenameCopyButton(name)}${available ? `<a class="button primary small analysis-report-open" href="${escapeHtml(reportArtifactViewerUrl(artifact.url, name))}" target="_blank" rel="noopener">${escapeHtml(tr('viewFullAnalysis'))}<span aria-hidden="true">↗</span></a>` : ''}</div>
      </div>`;
    }).join('')}</div>
  </section>`;
}

function reportArtifactLinks(
  artifacts,
  registeredArtifacts = [],
  reportStatus = '',
  artifactDeclarations = [],
) {
  const groups = [
    { kind: 'pytest-html', label: 'pytestHtmlReport', action: 'openHtmlReport' },
    { kind: 'failure-analysis-html', label: 'failureAnalysisReport', action: 'viewFullAnalysis' },
    { kind: 'failure-analysis-markdown', label: 'failureAnalysisReport', action: 'openMarkdownReport' },
  ];
  const managed = artifacts || [];
  const managedKeys = new Set(managed.map(reportArtifactIdentity));
  const pending = (registeredArtifacts || []).filter((artifact) => (
    !managedKeys.has(reportArtifactIdentity(artifact))
  ));
  return groups.map((group) => {
    const reports = managed.filter((artifact) => artifact.kind === group.kind && artifact.url);
    const registrations = pending.filter((artifact) => artifact.kind === group.kind);
    if (!reports.length && !registrations.length) return '';
    const entries = [...reports.map(artifact => ({ artifact, registered: false })),
      ...registrations.map(artifact => ({ artifact, registered: true }))];
    return `<div class="report-artifacts">
      <div class="report-artifacts-heading"><span>${escapeHtml(tr(group.label))}</span><small>${entries.length}</small></div>
      <div class="report-artifact-list" role="list">${entries.map(({ artifact, registered }) => {
      const displayName = reportArtifactDisplayName(artifact, artifactDeclarations, group.label);
      const running = artifact.executionStatus === 'running' || reportStatus === 'running';
      const unavailable = registered && artifact.available === false;
      const stateClass = unavailable ? ' report-artifact-unavailable' : (registered ? ' report-artifact-pending' : '');
      const label = unavailable ? 'artifactUnavailable' : (running ? 'artifactRegisteredRunning' : 'artifactRegisteredPending');
      const detailKey = `${artifact.reportKey || ''}:${artifact.id || artifact.key || displayName}`;
      const open = artifact.url && !unavailable
        ? `<a class="report-artifact-open" href="${escapeHtml(reportArtifactViewerUrl(artifact.url, displayName))}" target="_blank" rel="noopener"><b>${escapeHtml(tr(group.action))}</b><span aria-hidden="true">↗</span></a>` : '';
      return `<div class="report-artifact-row${stateClass}" role="listitem">
        <span class="report-artifact-kind" aria-hidden="true">${group.kind === 'failure-analysis-markdown' ? 'MD' : 'HTML'}</span>
        <details class="report-artifact-name" data-detail-key="artifact-name:${escapeHtml(detailKey)}">
          <summary title="${escapeHtml(displayName)}"><strong>${escapeHtml(displayName)}</strong></summary>
          <code>${escapeHtml(displayName)}</code>
        </details>
        <small class="report-artifact-size">${registered ? escapeHtml(tr(label)) : escapeHtml(formatBytes(artifact.bytes || 0))}</small>
        ${reportFilenameCopyButton(displayName)}
        ${open}
      </div>`;
    }).join('')}</div></div>`;
  }).join('');
}

async function copyReportFilename(value) {
  try {
    let copied = false;
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(value); copied = true; } catch { /* Use selection copy in embedded browsers. */ }
    }
    if (!copied) {
      const selection = document.createElement('textarea');
      const active = document.activeElement;
      selection.value = value;
      selection.className = 'copy-buffer';
      selection.setAttribute('readonly', '');
      document.body.appendChild(selection);
      try { selection.select(); copied = document.execCommand('copy'); }
      finally { selection.remove(); active?.focus({ preventScroll: true }); }
    }
    if (!copied) throw new Error('Clipboard unavailable');
    toast(tr('reportNameCopied'));
  } catch { toast(tr('copyReportNameFailed'), 'error'); }
}

function artifactFileName(value) {
  return String(value || '').split(/[\\/]/).filter(Boolean).at(-1) || '';
}

function reportsWithRegisteredArtifacts(reports, externalAttempts) {
  const attemptsById = new Map((externalAttempts || []).map((attempt) => [attempt.id, attempt]));
  return (reports || []).map((report) => {
    const registered = new Map((report.registeredArtifacts || []).map((artifact) => [
      `${artifact.kind}\0${artifact.key || artifact.fileName || ''}`, artifact,
    ]));
    const externalAttemptId = String(report.executionEvidence?.externalAttemptId || '');
    const attempt = attemptsById.get(externalAttemptId);
    for (const artifact of attempt?.artifactDeclarations || []) {
      if (!['pytest-html', 'failure-analysis-html', 'failure-analysis-markdown'].includes(artifact?.kind)) continue;
      const key = String(artifact.key || '');
      const fileName = artifactFileName(artifact.path);
      if (!key || !fileName) continue;
      const identity = `${artifact.kind}\0${key}`;
      const existing = registered.get(identity);
      const displayFileName = reportArtifactNameFromPath(artifact.path);
      if (existing) {
        if (displayFileName && displayFileName !== existing.fileName) {
          registered.set(identity, { ...existing, displayFileName });
        }
      } else {
        registered.set(identity, {
          key,
          kind: artifact.kind,
          fileName,
          ...(displayFileName !== fileName ? { displayFileName } : {}),
          executionStatus: attempt.status,
        });
      }
    }
    return { ...report, registeredArtifacts: [...registered.values()] };
  });
}

function businessExecutionEvidenceScore(entry) {
  const status = normalizedExecutionStatus(entry.status, entry.exitCode);
  const terminal = !['pending', 'running'].includes(status);
  if (entry.evidenceSource === 'report') return terminal && status !== 'unknown' ? 500 : 250;
  if (terminal && entry.exitCode != null) return 400;
  if (terminal && !['unknown', 'failed'].includes(status)) return 350;
  if (['pending', 'running'].includes(status)) return 200;
  return 100;
}

function mergeBusinessExecutionEvidence(existing, candidate) {
  if (!existing) return candidate;
  const preferred = businessExecutionEvidenceScore(candidate) > businessExecutionEvidenceScore(existing)
    ? candidate
    : existing;
  const fallback = preferred === candidate ? existing : candidate;
  return {
    ...fallback,
    ...preferred,
    skillId: preferred.skillId || fallback.skillId,
    skillVersion: preferred.skillVersion || fallback.skillVersion,
    skillContentHash: preferred.skillContentHash || fallback.skillContentHash,
    workingDirectory: preferred.workingDirectory || fallback.workingDirectory,
  };
}

function sameExternalEvidence(left, right) {
  if (left.pid == null || right.pid == null || Number(left.pid) !== Number(right.pid)) return false;
  if (left.chainKey && right.chainKey && left.chainKey !== right.chainKey) return false;
  return ['logPath', 'donePath', 'statePath', 'metaPath'].every((key) => (
    String(left[key] || '') === String(right[key] || '')
  ));
}

function canonicalBusinessAttempts(externalAttempts) {
  const attempts = externalAttempts || [];
  return attempts.filter((attempt) => {
    const ignored = attempt.result?.ignoredStaleArtifacts;
    if (!Array.isArray(ignored) || ignored.length === 0) return true;
    const status = normalizedExecutionStatus(attempt.status, externalAttemptExitCode(attempt));
    if (!['failed', 'unknown'].includes(status) || externalAttemptExitCode(attempt) != null) return true;
    return !attempts.some((candidate) => candidate !== attempt
      && sameExternalEvidence(attempt, candidate)
      && externalAttemptExitCode(candidate) != null);
  });
}

function businessExecutionEntries(reports, externalAttempts) {
  const entries = new Map();
  const add = (entry) => {
    const command = String(entry.command || '').trim();
    if (!command) return;
    const key = String(entry.commandPath || '').trim() || command;
    const existing = entries.get(key);
    entries.set(key, mergeBusinessExecutionEvidence(existing, { ...entry, command }));
  };

  for (const attempt of canonicalBusinessAttempts(externalAttempts)) {
    add({
      id: attempt.id,
      evidenceSource: 'external',
      label: attempt.label || tr('businessExecution'),
      command: attempt.command,
      commandPath: attempt.commandPath,
      status: attempt.status,
      exitCode: externalAttemptExitCode(attempt),
      startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt || attempt.lastCheckedAt,
    });
  }
  for (const report of reports || []) {
    const execution = report.primaryExecution;
    if (!execution?.command) continue;
    add({
      id: report.id,
      evidenceSource: 'report',
      label: execution.label,
      command: execution.command,
      commandPath: execution.commandPath,
      workingDirectory: execution.workingDirectory,
      status: execution.status,
      exitCode: execution.exitCode,
      startedAt: execution.startedAt,
      finishedAt: execution.finishedAt,
      skillId: report.skillId,
      skillVersion: report.skillVersion,
      skillContentHash: report.skillContentHash,
    });
  }
  return [...entries.values()];
}

function businessExecutionList(reports, externalAttempts) {
  const entries = businessExecutionEntries(reports, externalAttempts);
  if (!entries.length) return '';
  return `<section class="business-executions">
    <div class="business-executions-heading"><span class="section-label">${escapeHtml(tr('businessCommands'))}</span><strong>${entries.length}</strong></div>
    <div class="business-execution-list">${entries.map((execution) => {
    const status = reportStatusPresentation(execution.status);
    const skill = execution.skillId
      ? `<span class="business-execution-skill"><span>${escapeHtml(tr('primarySkill'))}</span><strong>${escapeHtml(execution.skillId)}</strong>${execution.skillVersion ? `<code>v${Number(execution.skillVersion)}${execution.skillContentHash ? ` · ${escapeHtml(shortHash(execution.skillContentHash))}` : ''}</code>` : ''}</span>`
      : '';
    return `<article class="business-execution">
      <header class="business-execution-head">
        <div><span class="section-label">${escapeHtml(tr('businessExecution'))}</span><h3>${escapeHtml(execution.label || tr('businessExecution'))}</h3></div>
        <span class="status-badge ${escapeHtml(execution.status || 'unknown')}">${escapeHtml(status.label)}</span>
      </header>
      ${skill}
      ${executionCommandDetails(execution.command, 'business-command', execution.id || execution.commandPath)}
      <div class="business-execution-meta">
        ${execution.workingDirectory ? `<span>${escapeHtml(tr('runtimeWorkingDir'))} <code>${escapeHtml(execution.workingDirectory)}</code></span>` : ''}
        <span>${escapeHtml(tr('exitCode'))} <code>${execution.exitCode == null ? '-' : Number(execution.exitCode)}</code></span>
        ${execution.finishedAt || execution.startedAt ? `<time>${escapeHtml(formatTime(execution.finishedAt || execution.startedAt))}</time>` : ''}
        ${execution.commandPath ? `<span>${escapeHtml(tr('commandPath'))} <code>${escapeHtml(execution.commandPath)}</code></span>` : ''}
      </div>
    </article>`;
  }).join('')}</div>
  </section>`;
}

function isPytestCommand(command) {
  return /(^|[^A-Za-z0-9_])pytest([^A-Za-z0-9_]|$)/i.test(String(command || ''));
}

function directExecutionTarget(command) {
  let target = String(command || '').trim();
  const shellLauncher = target.match(/^(?:[^\s"']*\/)?(?:ba)?sh\s+-lc\s+([\s\S]+)$/);
  if (shellLauncher) {
    target = shellLauncher[1].trim();
    const quote = target[0];
    if ((quote === '"' || quote === "'") && target.endsWith(quote)) {
      target = target.slice(1, -1).trim();
    }
  }
  const skillWrapper = target.match(
    /^(?:[^\s"']*\/)?codex-skill-use\s+(?:[A-Za-z0-9][A-Za-z0-9._-]{0,127}\s+)+--\s+([\s\S]+)$/,
  );
  return (skillWrapper ? skillWrapper[1] : target).trim();
}

function isDirectPytestExecution(command) {
  const target = directExecutionTarget(command);
  return /^(?:exec\s+)?(?:(?:[^\s=]+=[^\s]+)\s+)*(?:(?:[^\s"']*\/)?pytest(?:\s|$)|(?:[^\s"']*\/)?python(?:3(?:\.\d+)*)?\s+(?:-[A-Za-z]+\s+)*-m\s+pytest(?:\s|$))/i.test(target);
}

function normalizedCommand(command) {
  return String(command || '').trim().replace(/\s+/g, ' ');
}

function normalizedExecutionStatus(status, exitCode) {
  const value = String(status || '').toLowerCase();
  if (['pending', 'running', 'succeeded', 'failed', 'partial', 'blocked', 'cancelled', 'unknown'].includes(value)) {
    return value;
  }
  if (['completed', 'finished'].includes(value)) return Number(exitCode) === 0 ? 'succeeded' : 'failed';
  if (['lost', 'interrupted', 'error'].includes(value)) return 'failed';
  if (exitCode != null) return Number(exitCode) === 0 ? 'succeeded' : 'failed';
  return 'unknown';
}

function executionSkillIds(execution) {
  return [...new Set((execution?.skills || [])
    .map((skill) => String(skill.skillId || '').trim())
    .filter(Boolean))];
}

function isBusinessTestExecution(execution) {
  if (!isDirectPytestExecution(execution?.command)) return false;
  return executionSkillIds(execution).some((skillId) => (
    /(^|[-_.])(test|smoke|regression)([-_.]|$)/i.test(skillId)
      && skillId !== 'analyze-failures'
  ));
}

function reportMetricSummary(report) {
  const preferred = new Set(['passed', 'failed', 'skipped', 'error', 'errors', 'total']);
  const metrics = (report?.metrics || []).filter((metric) => preferred.has(String(metric.key || '').toLowerCase()));
  return metrics.map((metric) => `${metric.label}: ${reportDisplayValue(metric.value)}`).join(' · ');
}

function reportFieldValue(report, labels) {
  const expected = new Set(labels.map((label) => String(label).trim().toLowerCase()));
  for (const section of report?.sections || []) {
    for (const field of section.fields || []) {
      if (expected.has(String(field.label || '').trim().toLowerCase())) return String(field.value ?? '').trim();
    }
  }
  return '';
}

function isReportedTestResult(report) {
  return !report?.relatedReportKeys?.length
    && String(report?.reportType || '').trim().toLowerCase() === 'test-result';
}

function reportedTestRun(report) {
  const exitCodeValue = reportFieldValue(report, ['Exit code']);
  const exitCode = /^-?\d+$/.test(exitCodeValue) ? Number(exitCodeValue) : null;
  return {
    id: report.id,
    report,
    command: reportFieldValue(report, ['Command']),
    commandPath: reportFieldValue(report, ['Command snapshot', 'Command path']),
    workingDirectory: reportFieldValue(report, ['Working directory']),
    startedAt: reportFieldValue(report, ['Started', 'Started at']) || report.observedAt || report.publishedAt,
    finishedAt: reportFieldValue(report, ['Finished', 'Finished at']) || report.observedAt || report.publishedAt,
    status: normalizedExecutionStatus(report.status, exitCode),
    exitCode,
    skillIds: [report.skillId].filter(Boolean),
    reportedOnly: true,
  };
}

function reportExecutionKey(report) {
  const execution = report.primaryExecution || {};
  const identity = String(execution.commandPath || '').trim()
    || normalizedCommand(execution.command)
    || report.reportKey;
  return `${identity}\n${execution.startedAt || report.reportKey}`;
}

function sameBusinessExecution(run, attempt) {
  const samePath = run.commandPath && attempt.commandPath && run.commandPath === attempt.commandPath;
  const sameCommand = normalizedCommand(run.command) === normalizedCommand(attempt.command);
  if (!samePath && !sameCommand) return false;
  if (!run.startedAt || !attempt.startedAt) return true;
  return Math.abs(Date.parse(run.startedAt) - Date.parse(attempt.startedAt)) < 10000;
}

function externalAttemptStartedAt(attempt) {
  const recorded = attempt?.result?.meta?.started_at || attempt?.result?.meta?.startedAt;
  return Number.isFinite(Date.parse(recorded || '')) ? recorded : attempt?.startedAt;
}

function sameBusinessExecutionTime(run, execution) {
  const pairs = [
    [run.startedAt, execution.startedAt],
    [run.finishedAt, execution.finishedAt],
  ];
  return pairs.some(([left, right]) => {
    const leftTime = Date.parse(left || '');
    const rightTime = Date.parse(right || '');
    return Number.isFinite(leftTime) && Number.isFinite(rightTime) && Math.abs(leftTime - rightTime) < 10000;
  });
}

function latestReportRevisions(reports) {
  const latest = new Map();
  (reports || []).forEach((report, index) => {
    const key = report.reportKey || report.id || `unkeyed:${index}`;
    const existing = latest.get(key);
    const revision = Number(report.revision) || 0;
    const existingRevision = Number(existing?.revision) || 0;
    const publishedAt = Date.parse(report.publishedAt || report.observedAt || 0);
    const existingPublishedAt = Date.parse(existing?.publishedAt || existing?.observedAt || 0);
    if (!existing || revision > existingRevision
      || (revision === existingRevision && publishedAt >= existingPublishedAt)) {
      latest.set(key, report);
    }
  });
  return [...latest.values()];
}

function explicitBusinessTestRuns(reports, externalAttempts, executions, steps) {
  const commandExecutions = new Map((executions || []).map((execution) => [execution.id, execution]));
  const reportsByRun = new Map();
  for (const report of reports || []) {
    if (!report.stepRunId) continue;
    if (!reportsByRun.has(report.stepRunId)) reportsByRun.set(report.stepRunId, []);
    reportsByRun.get(report.stepRunId).push(report);
  }
  const attemptsByRun = new Map();
  for (const attempt of canonicalBusinessAttempts(externalAttempts)) {
    if (!attempt.stepRunId) continue;
    if (!attemptsByRun.has(attempt.stepRunId)) attemptsByRun.set(attempt.stepRunId, []);
    attemptsByRun.get(attempt.stepRunId).push(attempt);
  }
  const result = [];
  for (const step of [...steps].sort((left, right) => left.ordinal - right.ordinal)) {
    for (const stepRun of [...(step.runs || [])].sort((left, right) => left.runNumber - right.runNumber)) {
      const runReports = reportsByRun.get(stepRun.id) || [];
      const report = latestReportRevisions(runReports).sort((left, right) => {
        const typePriority = Number(isReportedTestResult(left)) - Number(isReportedTestResult(right));
        return typePriority || Date.parse(left.publishedAt || 0) - Date.parse(right.publishedAt || 0);
      }).at(-1);
      const attempts = attemptsByRun.get(stepRun.id) || [];
      const externalAttempt = [...attempts].sort((left, right) => (
        Date.parse(left.createdAt || left.startedAt || 0) - Date.parse(right.createdAt || right.startedAt || 0)
      )).at(-1);
      const primary = report?.primaryExecution;
      const reported = report && isReportedTestResult(report) ? reportedTestRun(report) : null;
      const command = primary?.command || externalAttempt?.command || reported?.command || '';
      if (!isPytestCommand(command) && !isReportedTestResult(report)) continue;
      const linkedExecution = commandExecutions.get(externalAttempt?.sourceCommandExecutionId);
      const exitCode = primary?.exitCode ?? externalAttemptExitCode(externalAttempt) ?? reported?.exitCode ?? null;
      const reportStatus = report ? normalizedExecutionStatus(report.status, exitCode) : '';
      const runStatus = normalizedExecutionStatus(stepRun.status, exitCode);
      result.push({
        id: stepRun.id,
        step,
        stepRun,
        report,
        artifactReports: runReports,
        externalAttempt,
        command,
        commandPath: primary?.commandPath || externalAttempt?.commandPath || reported?.commandPath || '',
        workingDirectory: primary?.workingDirectory || reported?.workingDirectory || '',
        startedAt: primary?.startedAt || stepRun.startedAt || reported?.startedAt || externalAttemptStartedAt(externalAttempt),
        finishedAt: primary?.finishedAt || stepRun.finishedAt || reported?.finishedAt || externalAttempt?.finishedAt || '',
        status: reportStatus && !['pending', 'running', 'unknown'].includes(reportStatus)
          ? reportStatus
          : runStatus,
        exitCode,
        skillIds: [...new Set([
          ...runReports.map((item) => item.skillId).filter(Boolean),
          ...executionSkillIds(linkedExecution),
        ])],
        attemptGenerations: attempts.length,
      });
    }
  }
  return result;
}

function businessTestRuns(reports, externalAttempts, executions, steps = []) {
  if ((steps || []).length) {
    return explicitBusinessTestRuns(reports, externalAttempts, executions, steps);
  }
  const commandExecutions = new Map((executions || []).map((execution) => [execution.id, execution]));
  const runs = new Map();
  const reportHistory = new Map();
  for (const report of reports || []) {
    const key = report.reportKey || report.id;
    if (!reportHistory.has(key)) reportHistory.set(key, []);
    reportHistory.get(key).push(report);
  }
  const orderedReports = latestReportRevisions(reports).sort((left, right) => (
    Date.parse(left.publishedAt || left.observedAt || 0) - Date.parse(right.publishedAt || right.observedAt || 0)
  ));

  for (const report of orderedReports) {
    const primary = report.primaryExecution;
    const artifactReports = reportHistory.get(report.reportKey || report.id) || [report];
    if (!primary || !isPytestCommand(primary.command)) {
      if (isReportedTestResult(report)) {
        runs.set(`report:${report.reportKey || report.id}`, {
          ...reportedTestRun(report), artifactReports,
        });
      }
      continue;
    }
    const key = reportExecutionKey(report);
    const existing = runs.get(key) || {};
    runs.set(key, {
      ...existing,
      id: existing.id || report.id,
      report,
      artifactReports: [...(existing.artifactReports || []), ...artifactReports],
      command: primary.command,
      commandPath: primary.commandPath,
      workingDirectory: primary.workingDirectory,
      startedAt: primary.startedAt || existing.startedAt || report.publishedAt,
      finishedAt: primary.finishedAt || existing.finishedAt,
      status: normalizedExecutionStatus(primary.status || report.status, primary.exitCode),
      exitCode: primary.exitCode,
      skillIds: [report.skillId],
    });
  }

  const usedSourceExecutionIds = new Set();
  for (const attempt of canonicalBusinessAttempts(externalAttempts)) {
    if (!isPytestCommand(attempt.command)) continue;
    if (attempt.sourceCommandExecutionId) usedSourceExecutionIds.add(attempt.sourceCommandExecutionId);
    const linkedExecution = commandExecutions.get(attempt.sourceCommandExecutionId);
    const normalizedAttempt = { ...attempt, startedAt: externalAttemptStartedAt(attempt) };
    const existing = [...runs.values()].find((run) => (
      sameBusinessExecution(run, normalizedAttempt)
        || (run.reportedOnly && sameBusinessExecutionTime(run, normalizedAttempt))
    ));
    const attemptStatus = normalizedExecutionStatus(attempt.status, externalAttemptExitCode(attempt));
    const attemptIsTerminal = Boolean(attempt.finishedAt)
      && !['pending', 'running'].includes(attemptStatus);
    const reportIsTerminal = existing?.report
      && !['pending', 'running'].includes(existing.status);
    const value = {
      ...(existing || {}),
      id: existing?.id || attempt.id,
      externalAttempt: attempt,
      command: existing?.reportedOnly ? attempt.command : (existing?.command || attempt.command),
      commandPath: existing?.reportedOnly ? attempt.commandPath : (existing?.commandPath || attempt.commandPath),
      startedAt: existing?.startedAt || normalizedAttempt.startedAt || attempt.createdAt,
      finishedAt: existing?.finishedAt || attempt.finishedAt,
      status: reportIsTerminal || (existing?.report && !attemptIsTerminal)
        ? existing.status
        : attemptStatus,
      exitCode: existing?.exitCode ?? externalAttemptExitCode(attempt),
      skillIds: existing?.skillIds?.length ? existing.skillIds : executionSkillIds(linkedExecution),
      reportedOnly: false,
    };
    if (existing) {
      const key = [...runs.entries()].find(([, run]) => run === existing)?.[0];
      if (key) runs.set(key, value);
    } else {
      runs.set(`external:${attempt.id}`, value);
    }
  }

  for (const execution of executions || []) {
    if (usedSourceExecutionIds.has(execution.id) || !isBusinessTestExecution(execution)) continue;
    const command = normalizedCommand(execution.command);
    const reportedEntry = [...runs.entries()].find(([, run]) => (
      run.reportedOnly && sameBusinessExecutionTime(run, execution)
    ));
    if (reportedEntry) {
      const [key, run] = reportedEntry;
      runs.set(key, {
        ...run,
        command: execution.command,
        workingDirectory: execution.workingDirectory,
        startedAt: execution.startedAt || run.startedAt,
        finishedAt: execution.finishedAt || run.finishedAt,
        exitCode: execution.exitCode,
        skillIds: [...new Set([...run.skillIds, ...executionSkillIds(execution)])],
        reportedOnly: false,
      });
      continue;
    }
    const duplicate = [...runs.values()].some((run) => {
      const existing = normalizedCommand(run.command);
      return existing === command || existing.includes(command) || command.includes(existing);
    });
    if (duplicate) continue;
    runs.set(`command:${execution.id}`, {
      id: execution.id,
      command: execution.command,
      workingDirectory: execution.workingDirectory,
      startedAt: execution.startedAt || execution.finishedAt,
      finishedAt: execution.finishedAt,
      status: normalizedExecutionStatus(execution.status, execution.exitCode),
      exitCode: execution.exitCode,
      skillIds: executionSkillIds(execution),
    });
  }

  return [...runs.values()].sort((left, right) => (
    Date.parse(left.startedAt || 0) - Date.parse(right.startedAt || 0)
  ));
}

function deploymentCategory(value) {
  const source = [value?.skillId, value?.reportType, value?.reportKey, value?.title]
    .map((item) => String(item || '').toLowerCase()).join(' ');
  if (/(^|[^a-z0-9])(ci[-_. ]?cd|cicd)([^a-z0-9]|$)/.test(source)) return 'cicdDeployment';
  if (/(^|[^a-z0-9])gw([^a-z0-9]|$)/.test(source) && /deploy/.test(source)) return 'gwDeployment';
  if (/deploy/.test(source)) return 'serviceDeployment';
  return '';
}

function businessTimelineReports(reports) {
  reports = (reports || []).filter(report => !report.relatedReportKeys?.length);
  const deploymentGroups = groupedBy(
    (reports || []).filter((report) => deploymentCategory(report)),
    (report) => report.reportKey || report.id,
  );
  const deploymentReports = deploymentGroups.flatMap((group) => {
    const revisions = [...group].sort((left, right) => (
      (Number(left.revision) || 0) - (Number(right.revision) || 0)
      || Date.parse(left.publishedAt || 0) - Date.parse(right.publishedAt || 0)
    ));
    const first = revisions[0];
    const latest = revisions.at(-1);
    const firstIsTerminal = !['pending', 'running', 'unknown'].includes(first.status);
    const latestIsTerminal = !['pending', 'running', 'unknown'].includes(latest.status);
    if (firstIsTerminal) return [{ ...latest, deploymentBoundary: 'finished' }];
    if (first === latest) return [{ ...first, deploymentBoundary: 'started' }];
    return [
      { ...first, deploymentBoundary: 'started' },
      ...(latestIsTerminal ? [{ ...latest, deploymentBoundary: 'finished' }] : []),
    ];
  });
  const latestOtherReports = latestReportRevisions(reports)
    .filter((report) => !deploymentCategory(report));
  return [...latestOtherReports, ...deploymentReports].sort((left, right) => (
    (Date.parse(left.observedAt || left.publishedAt || 0)
      - Date.parse(right.observedAt || right.publishedAt || 0))
      || (Number(left.revision) || 0) - (Number(right.revision) || 0)
  ));
}

function deploymentTimelineTitle(report) {
  const category = deploymentCategory(report);
  const boundary = report.deploymentBoundary === 'finished' ? 'deploymentFinished' : 'deploymentStarted';
  return `${tr(category)} · ${tr(boundary)}`;
}

function isFailureAnalysisReport(report) {
  const source = `${report?.skillId || ''} ${report?.reportType || ''}`.toLowerCase();
  const hasFailureSection = (report?.sections || []).some((section) => (
    /(^|[-_. ])failure(?:[-_. ]|$)/i.test(`${section.id || ''} ${section.title || ''}`)
      && (
        /failure[-_. ]?analysis/i.test(`${section.id || ''} ${section.title || ''}`)
        || (section.fields || []).some((field) => /classification|分类/i.test(String(field.label || '')))
      )
  ));
  return source.includes('analyze-failures') || /failure[-_. ]?analysis/.test(source) || hasFailureSection;
}

function failureAnalysisSummary(report) {
  const section = (report?.sections || []).find((item) => (
    /(^|[-_. ])failure(?:[-_. ]?analysis)?($|[-_. ])/i.test(`${item.id || ''} ${item.title || ''}`)
  ));
  const classification = (section?.fields || []).find((field) => (
    /classification|分类/i.test(String(field.label || ''))
  ));
  return classification?.value ? String(classification.value) : report.summary;
}

function testRunSummary(run) {
  const reportStatus = normalizedExecutionStatus(run.report?.status);
  const externalResult = run.externalAttempt?.result || {};
  if (run.externalAttempt?.finishedAt && ['pending', 'running'].includes(reportStatus)) {
    if (externalResult.summary || externalResult.message) {
      return externalResult.summary || externalResult.message;
    }
    return trf('exitCodeSummary', { code: run.exitCode == null ? '-' : run.exitCode });
  }
  const metrics = reportMetricSummary(run.report);
  if (metrics) return metrics;
  if (run.report?.summary) return run.report.summary;
  if (externalResult.summary || externalResult.message) return externalResult.summary || externalResult.message;
  if (['pending', 'running'].includes(run.status)) return reportStatusPresentation(run.status).label;
  return trf('exitCodeSummary', { code: run.exitCode == null ? '-' : run.exitCode });
}

function businessRegressionTitle(runOrIndex, fallbackIndex = 0) {
  if (runOrIndex && typeof runOrIndex === 'object' && runOrIndex.stepRun) {
    const runTitle = isRerunRun(runOrIndex)
      ? `${tr('regressionRerun')} #${runOrIndex.stepRun.runNumber}`
      : tr('initialRegression');
    return runOrIndex.step?.label ? `${runOrIndex.step.label} · ${runTitle}` : runTitle;
  }
  const index = typeof runOrIndex === 'number' ? runOrIndex : Number(fallbackIndex);
  return index > 0 ? `${tr('regressionRerun')} #${index}` : tr('initialRegression');
}

function businessFinalSummary(runs) {
  return runs.map((run, index) => `${businessRegressionTitle(run, index)}: ${testRunSummary(run)}`).join(' · ');
}

function pytestResultSummaryHtml(summary) {
  if (!summary?.available) return '';
  const number = value => Number(value || 0).toLocaleString(state.lang === 'zh' ? 'zh-CN' : 'en-US');
  const rows = [
    ['cumulativeResults', 'includingReruns', summary.cumulative],
    ['finalCaseResults', 'rerunsReplaceEarlier', summary.final],
  ];
  return `<div class="final-result-statistics">
    ${!summary.complete ? `<p class="final-result-incomplete">${escapeHtml(tr('resultCountsIncomplete'))}</p>` : ''}
    ${rows.map(([title, note, counts]) => `<div class="final-result-row">
      <div class="final-result-row-title"><strong>${escapeHtml(tr(title))}</strong><span>${escapeHtml(tr(note))}</span></div>
      <div class="final-result-number"><span>${escapeHtml(tr('resultTotal'))}</span><strong>${number(counts.total)}</strong></div>
      <div class="final-result-number tone-success"><span>Pass</span><strong>${number(counts.passed)}</strong></div>
      <div class="final-result-number tone-danger"><span>Fail</span><strong>${number(counts.failed)}</strong></div>
      <div class="final-result-other">${[['Skip', 'skipped'], ['XFail', 'xfailed'], ['Error', 'error'], ['XPass', 'xpassed'], [tr('unknown'), 'unknown']]
        .filter(([, key]) => counts[key]).map(([label, key]) => `<span>${escapeHtml(label)} <b>${number(counts[key])}</b></span>`).join('')}</div>
    </div>`).join('')}
    <p class="final-result-count-note">${escapeHtml(trf('caseCountNotes', { count: number(summary.executed) }))}</p>
  </div>`;
}

function finalPytestStatus(summary) {
  if (!summary.complete) return 'unknown';
  if (summary.final.failed || summary.final.error) return summary.final.passed ? 'partial' : 'failed';
  return summary.final.passed ? 'succeeded' : 'unknown';
}

function reportedScheduledFollowUp(report) {
  const section = (report?.sections || []).find((item) => item.id === 'scheduled-follow-up');
  const data = section?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const createdAt = String(data.createdAt || '').trim();
  const dueAt = String(data.dueAt || '').trim();
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(dueAt))) return null;
  return {
    createdAt,
    dueAt,
    label: String(data.label || '').trim(),
  };
}

function isFailureAnalysisExecution(execution) {
  const skillIds = executionSkillIds(execution);
  if (!skillIds.includes('analyze-failures') || skillIds.includes('agent-worklog')) return false;
  const target = directExecutionTarget(execution?.command);
  return Boolean(target)
    && !/SKILL\.md(?:\s|$)/i.test(target)
    && !/(?:^|\/)codex-(?:skill-report|background-track)(?:\s|$)/i.test(target);
}

function formatTimelineDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  const locale = state.lang === 'zh' ? 'zh-CN' : 'en-US';
  const key = `timeline-date:${locale}`;
  if (!dateTimeFormatters.has(key)) {
    dateTimeFormatters.set(key, new Intl.DateTimeFormat(locale, {
      year: 'numeric', month: '2-digit', day: '2-digit',
    }));
  }
  return dateTimeFormatters.get(key).format(date);
}

function formatTimelineClock(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  const locale = state.lang === 'zh' ? 'zh-CN' : 'en-US';
  const key = `timeline-clock:${locale}`;
  if (!dateTimeFormatters.has(key)) {
    dateTimeFormatters.set(key, new Intl.DateTimeFormat(locale, {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }));
  }
  return dateTimeFormatters.get(key).format(date);
}

function timelineEventHtml(event) {
  const status = event.status ? reportStatusPresentation(event.status) : null;
  const skills = (event.skillIds || []).length
    ? `<div class="business-timeline-skills"><span>${escapeHtml(tr('skillUsed'))}</span>${event.skillIds.map((skillId) => `<code>${escapeHtml(skillId)}</code>`).join('')}</div>`
    : '';
  const target = event.targetAt
    ? `<div class="business-timeline-target"><span>${escapeHtml(tr('scheduledFor'))}</span><time datetime="${escapeHtml(event.targetAt)}">${escapeHtml(formatTimelineTime(event.targetAt))}</time></div>`
    : '';
  return `<li class="business-timeline-event tone-${escapeHtml(event.tone || status?.tone || 'neutral')}">
    <time class="business-timeline-time" datetime="${escapeHtml(event.at || '')}"><strong>${escapeHtml(formatTimelineClock(event.at))}</strong><span>${escapeHtml(formatTimelineDate(event.at))}</span></time>
    <span class="business-timeline-rail" aria-hidden="true"><i></i></span>
    <div class="business-timeline-content">
      <header><strong>${escapeHtml(event.title)}</strong>${status ? `<span class="report-status tone-${escapeHtml(status.tone)}">${escapeHtml(status.label)}</span>` : ''}</header>
      ${event.detail ? `<p>${escapeHtml(event.detail)}</p>` : ''}
      ${skills}${target}
    </div>
  </li>`;
}

function collapseConsecutiveFollowUps(events) {
  const collapsed = [];
  for (const event of events) {
    const previous = collapsed[collapsed.length - 1];
    if (event.kind === 'scheduled-follow-up' && previous?.kind === 'scheduled-follow-up-group') {
      previous.events.push(event);
      continue;
    }
    if (event.kind === 'scheduled-follow-up') {
      collapsed.push({
        kind: 'scheduled-follow-up-group',
        at: event.at,
        events: [event],
      });
      continue;
    }
    collapsed.push(event);
  }
  return collapsed;
}

function scheduledFollowUpGroupHtml(group) {
  const count = group.events.length;
  if (count === 1) return timelineEventHtml(group.events[0]);
  return `<li class="business-followup-group">
    <details>
      <summary><span>${escapeHtml(tr('followupBooked'))}</span><strong>${count}</strong></summary>
      <ol class="business-timeline business-followup-group-events">${group.events.map(timelineEventHtml).join('')}</ol>
    </details>
  </li>`;
}

function businessTimelineHtml(events) {
  return collapseConsecutiveFollowUps(events).map((event) => (
    event.kind === 'scheduled-follow-up-group' ? scheduledFollowUpGroupHtml(event) : timelineEventHtml(event)
  )).join('');
}

function businessRegressionHtml(run, index) {
  const status = reportStatusPresentation(run.status);
  const title = businessRegressionTitle(run, index);
  const skills = (run.skillIds || []).length
    ? `<div class="business-regression-skills"><span>${escapeHtml(tr('skillUsed'))}</span>${run.skillIds.map((skillId) => `<code>${escapeHtml(skillId)}</code>`).join('')}</div>`
    : '';
  const completion = run.finishedAt
    ? `<div class="business-regression-result"><strong>${escapeHtml(testRunSummary(run))}</strong><span>${escapeHtml(tr('finishedAtShort'))} <time datetime="${escapeHtml(run.finishedAt)}">${escapeHtml(formatTimelineTime(run.finishedAt))}</time></span></div>`
    : '';
  return `<article class="business-regression tone-${escapeHtml(status.tone)}">
    <header class="business-regression-head">
      <div><span class="business-regression-index">#${String(index + 1).padStart(2, '0')}</span><h4>${escapeHtml(title)}</h4></div>
      <span class="report-status tone-${escapeHtml(status.tone)}">${escapeHtml(status.label)}</span>
    </header>
    <div class="business-regression-meta"><span>${escapeHtml(tr('startedAtShort'))}</span><time datetime="${escapeHtml(run.startedAt || '')}">${escapeHtml(formatTimelineTime(run.startedAt))}</time>${skills}</div>
    ${completion}
    ${businessRunArtifactLinks(run)}
    <div class="business-regression-command">${executionCommandDetails(run.command, 'business-command', run.id)}</div>
  </article>`;
}

function isRerunKey(value) {
  return String(value || '').split(':').some(part => /^rerun(?:[-_. ]?\d+)?$/i.test(part));
}

function isRerunReport(report, runById = new Map()) {
  if (String(report?.reportType || '').toLowerCase() !== 'test-result') return false;
  const run = runById.get(report.stepRunId);
  if (run) return run.runKind === 'rerun' || isRerunKey(run.runKey);
  return isRerunKey(report.reportKey)
    || /(?:^|[\s:/-])rerun(?:[-_ ]?\d+)?(?=$|[\s:/-])|重跑/i.test(report.title || '');
}

function isRerunRun(run) {
  if (run?.stepRun) return run.stepRun.runKind === 'rerun' || isRerunKey(run.stepRun.runKey);
  return isRerunReport(run?.report);
}

function businessRegressionListHtml(runs) {
  const reruns = runs.filter(isRerunRun);
  const initial = runs.map((run, index) => isRerunRun(run) ? '' : businessRegressionHtml(run, index)).join('');
  if (!reruns.length) return initial;
  const statusKey = globalThis.CodexReportCards?.combinedStatus?.(reruns.map(run => run.status)) || 'unknown';
  const status = reportStatusPresentation(statusKey);
  const artifactReports = reruns.flatMap(run => run.artifactReports?.length ? run.artifactReports : [run.report].filter(Boolean));
  return initial + `<article class="business-regression business-rerun-group tone-${escapeHtml(status.tone)}">
    <header class="business-regression-head"><div><h4>${escapeHtml(tr('rerunResults'))}</h4><span class="business-regression-index">${reruns.length} ${escapeHtml(tr('executionRuns'))}</span></div><span class="report-status tone-${escapeHtml(status.tone)}">${escapeHtml(status.label)}</span></header>
    ${businessRunArtifactLinks({ artifactReports, report: { status: statusKey } })}
    <div class="business-rerun-list">${reruns.map(run => `<details class="business-rerun-entry" data-detail-key="rerun:${escapeHtml(run.id)}">
      <summary><span>${escapeHtml(run.step?.label || run.report?.title || tr('regressionRerun'))}${run.stepRun?.runKey ? ` · ${escapeHtml(run.stepRun.runKey)}` : ''}</span><span class="report-status tone-${escapeHtml(reportStatusPresentation(run.status).tone)}">${escapeHtml(reportStatusPresentation(run.status).label)}</span></summary>
      <div class="business-rerun-body"><p>${escapeHtml(testRunSummary(run))}</p>
      <div class="business-execution-meta"><span>${escapeHtml(tr('startedAtShort'))} <time>${escapeHtml(formatTimelineTime(run.startedAt))}</time></span><span>${escapeHtml(tr('finishedAtShort'))} <time>${escapeHtml(formatTimelineTime(run.finishedAt))}</time></span>${(run.skillIds || []).map(id => `<code>${escapeHtml(id)}</code>`).join('')}</div>
      ${executionCommandDetails(run.command, 'business-command', run.id)}${businessRunArtifactLinks(run)}
      </div></details>`).join('')}</div>
  </article>`;
}

function businessRunArtifactLinks(run) {
  const reports = run.artifactReports?.length ? run.artifactReports : [run.report].filter(Boolean);
  const artifacts = new Map();
  const registered = new Map();
  const declarations = new Map();
  for (const report of [...reports].sort((left, right) => (
    Date.parse(left.publishedAt || 0) - Date.parse(right.publishedAt || 0)
      || Number(left.revision || 0) - Number(right.revision || 0)
  ))) {
    const reportKey = report.reportKey || report.id || '';
    for (const artifact of report.artifacts || []) {
      const scopedArtifact = { ...artifact, reportKey };
      artifacts.set(reportArtifactIdentity(scopedArtifact), scopedArtifact);
    }
    for (const artifact of report.registeredArtifacts || []) {
      const scopedArtifact = { ...artifact, reportKey };
      registered.set(reportArtifactIdentity(scopedArtifact), scopedArtifact);
    }
    for (const artifact of report.artifactDeclarations || []) {
      const scopedArtifact = { ...artifact, reportKey };
      declarations.set(reportArtifactIdentity(scopedArtifact), scopedArtifact);
    }
  }
  return reportArtifactLinks(
    [...artifacts.values()], [...registered.values()], run.report?.status, [...declarations.values()],
  );
}

function businessRunIndexAt(runs, value) {
  const at = Date.parse(value || 0);
  let runIndex = -1;
  runs.forEach((run, index) => {
    if (Date.parse(run.startedAt || 0) <= at) runIndex = index;
  });
  return runIndex;
}

function failureAnalysisTitle(runIndex, completed = false, runs = []) {
  if (runIndex < 0) return tr(completed ? 'failureAnalysisCompleted' : 'failureAnalysis');
  const runTitle = businessRegressionTitle(runs[runIndex] || runIndex, runIndex);
  return `${runTitle} ${tr(completed ? 'failureAnalysisCompleted' : 'failureAnalysis')}`;
}

function businessSummaryStage(task, runs, analysisReports, analysisExecution) {
  const candidates = [];
  const latestRun = runs[runs.length - 1];
  if (latestRun) {
    const index = runs.length - 1;
    const running = ['pending', 'running'].includes(latestRun.status);
    candidates.push({
      at: latestRun.finishedAt || latestRun.startedAt,
      sortOrder: 10,
      title: businessRegressionTitle(latestRun, index),
      detail: running ? trf('runInProgress', { number: index + 1 }) : testRunSummary(latestRun),
      status: latestRun.status,
    });
  }
  const latestRunStartedAt = Date.parse(latestRun?.startedAt || 0);
  const analysisExecutionAt = Date.parse(analysisExecution?.startedAt || analysisExecution?.finishedAt || 0);
  if (analysisExecution && (!latestRun || analysisExecutionAt > latestRunStartedAt)) {
    const runIndex = businessRunIndexAt(runs, analysisExecution.startedAt || analysisExecution.finishedAt);
    candidates.push({
      at: analysisExecution.startedAt || analysisExecution.finishedAt,
      sortOrder: 20,
      title: failureAnalysisTitle(runIndex, false, runs),
      detail: tr('failureAnalysisPending'),
      status: ACTIVE_STATUSES.includes(task.status) ? 'running' : 'unknown',
    });
  }
  for (const report of analysisReports) {
    const at = report.publishedAt || report.observedAt;
    const runIndex = businessRunIndexAt(runs, at);
    candidates.push({
      at,
      sortOrder: 30,
      title: failureAnalysisTitle(runIndex, true, runs),
      detail: failureAnalysisSummary(report),
      status: normalizedExecutionStatus(report.status),
    });
  }
  const taskIsActive = ACTIVE_STATUSES.includes(task.status);
  if (!taskIsActive && latestRun?.finishedAt && !['pending', 'running'].includes(latestRun.status)) {
    return {
      title: tr('finalResult'),
      detail: businessFinalSummary(runs),
      status: latestRun.status,
    };
  }
  candidates.sort((left, right) => {
    const timeDifference = Date.parse(left.at || 0) - Date.parse(right.at || 0);
    return timeDifference || left.sortOrder - right.sortOrder;
  });
  return candidates[candidates.length - 1] || {
    title: tr('currentResult'), detail: tr('waitingForTestResult'), status: 'pending',
  };
}

function containsTestRequestDocument(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  const confluenceLink = /https?:\/\/[^\s"'<>]*(?:confluence|\/wiki\/(?:spaces|display|pages)\/|\/pages\/viewpage\.action)/i;
  if (confluenceLink.test(text)) return true;
  const requestLabel = /(?:提测(?:文档|报告|说明|申请单)|测试(?:申请|提测)(?:文档|报告|说明|单)?|test[- ]request(?:\s+(?:document|report|brief))?)/i;
  if (!requestLabel.test(text)) return false;
  return /(?:https?:\/\/\S+|(?:^|[\s"'(])(?:\/|\.\.?\/)?[^\s"'<>]+\.(?:md|pdf|docx?|xlsx?|pptx?|html?|txt|xmind)\b|(?:附件|attachment|文档|报告)\s*[:：]\s*\S+)/im.test(text);
}

function testRequestDocumentEvent(task, executions) {
  const taskText = [task?.name, task?.objective, task?.notes].filter(Boolean).join('\n');
  if (containsTestRequestDocument(taskText)) {
    return { at: task.createdAt, detail: task.name || task.objective || task.id };
  }
  const documentedExecution = [...(executions || [])]
    .filter((execution) => containsTestRequestDocument(execution.turnInput))
    .sort((left, right) => (
      Date.parse(left.startedAt || left.finishedAt || 0) - Date.parse(right.startedAt || right.finishedAt || 0)
    ))[0];
  if (!documentedExecution) return null;
  return {
    at: documentedExecution.startedAt || documentedExecution.finishedAt || task.createdAt,
    detail: task.name || task.objective || task.id,
  };
}

function scheduledFollowUpTimelineEvents(reports, externalAttempts, scheduledJobs) {
  const events = [];
  const attemptsById = new Map((externalAttempts || []).map((attempt) => [attempt.id, attempt]));
  const scheduledFollowUpKeys = new Set();
  for (const job of scheduledJobs || []) {
    const attempt = attemptsById.get(job.externalAttemptId);
    const label = attempt?.label || '';
    scheduledFollowUpKeys.add(`${label}\n${job.dueAt || ''}`);
    events.push({
      at: job.createdAt || job.updatedAt || job.dueAt,
      targetAt: job.dueAt,
      sortOrder: 40,
      title: tr('followupBooked'),
      detail: label,
      tone: 'info',
      kind: 'scheduled-follow-up',
    });
  }
  for (const report of latestReportRevisions(reports)) {
    const followUp = reportedScheduledFollowUp(report);
    if (!followUp) continue;
    const key = `${followUp.label}\n${followUp.dueAt}`;
    if (scheduledFollowUpKeys.has(key)) continue;
    scheduledFollowUpKeys.add(key);
    events.push({
      at: followUp.createdAt,
      targetAt: followUp.dueAt,
      sortOrder: 40,
      title: tr('followupBooked'),
      detail: followUp.label,
      tone: 'info',
      kind: 'scheduled-follow-up',
    });
  }
  return events;
}

function taskSummaryOutcome(task) {
  const outcomes = {
    idle: 'pending',
    queued: 'pending',
    running: 'running',
    recovering: 'running',
    stopping: 'running',
    waiting_scheduled: 'running',
    waiting_review: 'succeeded',
    waiting_input: 'blocked',
    completed: 'succeeded',
    failed: 'failed',
    interrupted: 'failed',
    stopped: 'cancelled',
  };
  return outcomes[task?.status] || 'unknown';
}

function taskSummaryDetail(task) {
  return String(task?.lastError || task?.summary || task?.objective || task?.notes || '-');
}

function generalTaskSummaryTimeline(task, reports, externalAttempts, scheduledJobs, executions) {
  const events = [{
    at: task.createdAt,
    sortOrder: 0,
    title: tr('taskCreated'),
    detail: task.name || task.id,
    tone: 'info',
  }];
  const executionsById = new Map((executions || []).map((execution) => [execution.id, execution]));
  const timelineReports = businessTimelineReports(reports);

  for (const report of timelineReports) {
    const category = deploymentCategory(report);
    events.push({
      at: report.observedAt || report.publishedAt || task.updatedAt,
      sortOrder: 30,
      title: category ? deploymentTimelineTitle(report) : (report.title || tr('structuredResult')),
      detail: report.summary || reportMetricSummary(report) || tr('structuredResult'),
      status: normalizedExecutionStatus(report.status, report.primaryExecution?.exitCode),
      skillIds: [report.skillId].filter(Boolean),
    });
  }

  for (const attempt of canonicalBusinessAttempts(externalAttempts)) {
    const exitCode = externalAttemptExitCode(attempt);
    const status = normalizedExecutionStatus(attempt.status, exitCode);
    const result = attempt.result && typeof attempt.result === 'object' ? attempt.result : {};
    const linkedExecution = executionsById.get(attempt.sourceCommandExecutionId);
    events.push({
      at: attempt.finishedAt || attempt.lastCheckedAt || externalAttemptStartedAt(attempt) || attempt.createdAt,
      sortOrder: 20,
      title: attempt.label || tr('externalExecution'),
      detail: result.summary || result.message || (exitCode == null
        ? reportStatusPresentation(status).label
        : trf('exitCodeSummary', { code: exitCode })),
      status,
      skillIds: executionSkillIds(linkedExecution),
    });
  }

  events.push(...scheduledFollowUpTimelineEvents(reports, externalAttempts, scheduledJobs));
  const resultDetail = String(task.lastError || task.summary || '').trim();
  if (resultDetail) {
    events.push({
      at: task.lastFinishedAt || task.updatedAt || task.lastRunAt || task.createdAt,
      sortOrder: 100,
      title: tr(task.status === 'completed' ? 'finalResult' : 'currentResult'),
      detail: resultDetail,
      status: taskSummaryOutcome(task),
    });
  }
  events.sort((left, right) => {
    const timeDifference = Date.parse(left.at || 0) - Date.parse(right.at || 0);
    return timeDifference || left.sortOrder - right.sortOrder;
  });

  return `<section class="business-summary general-task-summary">
    <header class="business-summary-head">
      <div><span class="section-label">${escapeHtml(tr('currentStatus'))}</span><h3>${escapeHtml(statusLabel(task))}</h3></div>
      <span class="status-badge ${escapeHtml(statusClass(task))}">${escapeHtml(statusLabel(task))}</span>
      ${failureAnalysisReportLinks(reports)}
      <p>${escapeHtml(taskSummaryDetail(task))}</p>
    </header>
    ${businessExecutionList(reports, externalAttempts)}
    <section class="business-milestones">
      <div class="business-summary-section-head"><span class="section-label">${escapeHtml(tr(timelineReports.some(deploymentCategory) ? 'businessTimeline' : 'taskTimeline'))}</span><strong>${events.length}</strong></div>
      <ol class="business-timeline">${businessTimelineHtml(events)}</ol>
    </section>
  </section>`;
}

function businessSummaryTimeline(task, reports, externalAttempts, scheduledJobs, executions, steps = [], pytestSummary = null) {
  reports = reportsWithRegisteredArtifacts(reports, externalAttempts);
  const runs = businessTestRuns(reports, externalAttempts, executions, steps);
  if (!runs.length) {
    return generalTaskSummaryTimeline(task, reports, externalAttempts, scheduledJobs, executions);
  }
  const events = [];
  const requestDocument = testRequestDocumentEvent(task, executions);
  if (requestDocument) {
    events.push({
      ...requestDocument,
      sortOrder: 0,
      title: tr('requestReceived'),
      tone: 'info',
    });
  }
  runs.forEach((run, index) => {
    if (!run.startedAt) return;
    events.push({
      at: run.startedAt,
      sortOrder: 30,
      title: tr('testExecutionStarted'),
      detail: businessRegressionTitle(run, index),
      tone: 'info',
      skillIds: run.skillIds,
    });
  });
  const deploymentReports = businessTimelineReports(reports)
    .filter((report) => deploymentCategory(report));
  for (const report of deploymentReports) {
    events.push({
      at: report.observedAt || report.publishedAt,
      sortOrder: 20,
      title: deploymentTimelineTitle(report),
      detail: report.summary,
      status: normalizedExecutionStatus(report.status),
      skillIds: [report.skillId],
    });
  }

  const deploymentReportSkills = new Set(deploymentReports.map((report) => report.skillId));
  for (const execution of executions || []) {
    const deploymentSkillIds = executionSkillIds(execution).filter((skillId) => deploymentCategory({ skillId }));
    if (!deploymentSkillIds.length || deploymentSkillIds.some((skillId) => deploymentReportSkills.has(skillId))) continue;
    events.push({
      at: execution.finishedAt || execution.startedAt,
      sortOrder: 20,
      title: tr(deploymentCategory({ skillId: deploymentSkillIds[0] })),
      detail: trf('exitCodeSummary', { code: execution.exitCode == null ? '-' : execution.exitCode }),
      status: normalizedExecutionStatus(execution.status, execution.exitCode),
      skillIds: deploymentSkillIds,
    });
  }

  runs.forEach((run, index) => {
    const rerun = run.stepRun ? run.stepRun.runKind === 'rerun' : index > 0;
    if (run.finishedAt) {
      events.push({
        at: run.finishedAt,
        sortOrder: 50,
        title: tr(rerun ? 'rerunCompleted' : 'initialCompleted'),
        detail: testRunSummary(run),
        status: run.status,
        skillIds: run.skillIds,
      });
    }
  });

  events.push(...scheduledFollowUpTimelineEvents(reports, externalAttempts, scheduledJobs));

  const latestAnalysisReports = new Map();
  for (const report of [...(reports || [])].sort((left, right) => (
    Date.parse(left.publishedAt || 0) - Date.parse(right.publishedAt || 0)
  ))) {
    if (isFailureAnalysisReport(report)) latestAnalysisReports.set(report.reportKey, report);
  }
  const analysisReports = [...latestAnalysisReports.values()];
  const analysisReportRunIndexes = new Set();
  for (const report of analysisReports) {
    const at = report.publishedAt || report.observedAt;
    const runIndex = businessRunIndexAt(runs, at);
    analysisReportRunIndexes.add(runIndex);
    events.push({
      at,
      sortOrder: 60,
      title: failureAnalysisTitle(runIndex, true, runs),
      detail: failureAnalysisSummary(report),
      status: normalizedExecutionStatus(report.status),
      skillIds: [report.skillId],
    });
  }
  const analysisExecutions = (executions || []).filter(isFailureAnalysisExecution).sort((left, right) => (
    Date.parse(left.startedAt || left.finishedAt || 0) - Date.parse(right.startedAt || right.finishedAt || 0)
  ));
  const latestAnalysisExecution = analysisExecutions[analysisExecutions.length - 1];
  const fallbackAnalysisExecutions = new Map();
  for (const execution of analysisExecutions) {
    const at = execution.startedAt || execution.finishedAt;
    const runIndex = businessRunIndexAt(runs, at);
    if (!analysisReportRunIndexes.has(runIndex) && !fallbackAnalysisExecutions.has(runIndex)) {
      fallbackAnalysisExecutions.set(runIndex, execution);
    }
  }
  for (const [runIndex, execution] of fallbackAnalysisExecutions) {
    events.push({
      at: execution.startedAt || execution.finishedAt,
      sortOrder: 60,
      title: failureAnalysisTitle(runIndex, false, runs),
      detail: tr('failureAnalysisUnreported'),
      tone: 'info',
      skillIds: ['analyze-failures'],
    });
  }

  const terminalRuns = runs.filter((run) => run.finishedAt && !['pending', 'running'].includes(run.status));
  const latestCompletedRun = terminalRuns[terminalRuns.length - 1];
  const taskIsActive = ACTIVE_STATUSES.includes(task.status);
  if (latestCompletedRun && latestCompletedRun === runs[runs.length - 1]) {
    events.push({
      at: taskIsActive
        ? latestCompletedRun.finishedAt
        : (task.lastFinishedAt || task.updatedAt || latestCompletedRun.finishedAt),
      sortOrder: 100,
      title: tr(taskIsActive ? 'currentResult' : 'finalResult'),
      detail: taskIsActive ? testRunSummary(latestCompletedRun) : businessFinalSummary(runs),
      status: !taskIsActive && pytestSummary?.available ? finalPytestStatus(pytestSummary) : latestCompletedRun.status,
      skillIds: latestCompletedRun.skillIds,
    });
  }

  events.sort((left, right) => {
    const timeDifference = Date.parse(left.at || 0) - Date.parse(right.at || 0);
    return timeDifference || left.sortOrder - right.sortOrder;
  });
  const stage = businessSummaryStage(task, runs, analysisReports, latestAnalysisExecution);
  const resultStatistics = stage.title === tr('finalResult') ? pytestResultSummaryHtml(pytestSummary) : '';
  if (resultStatistics) stage.status = finalPytestStatus(pytestSummary);
  const stageStatus = reportStatusPresentation(stage.status);
  return `<section class="business-summary">
    <header class="business-summary-head">
      <div><span class="section-label">${escapeHtml(tr('currentStage'))}</span><h3>${escapeHtml(stage.title)}</h3></div>
      <span class="report-status tone-${escapeHtml(stageStatus.tone)}">${escapeHtml(stageStatus.label)}</span>
      ${failureAnalysisReportLinks(reports)}
      ${resultStatistics || `<p>${escapeHtml(stage.detail)}</p>`}
      ${resultStatistics ? `<details class="business-final-detail" data-detail-key="final-conclusion"><summary>${escapeHtml(tr('fullResultDetail'))}</summary><p>${escapeHtml(stage.detail)}</p></details>` : ''}
    </header>
    <section class="business-regressions">
      <div class="business-summary-section-head"><span class="section-label">${escapeHtml(tr('regressionCommands'))}</span><strong>${runs.length}</strong></div>
      ${runs.length ? `<div class="business-regression-list">${businessRegressionListHtml(runs)}</div>` : `<div class="business-summary-empty">${escapeHtml(tr('noPytestRuns'))}</div>`}
    </section>
    <section class="business-milestones">
      <div class="business-summary-section-head"><span class="section-label">${escapeHtml(tr('businessTimeline'))}</span><strong>${events.length}</strong></div>
      <ol class="business-timeline">${businessTimelineHtml(events)}</ol>
    </section>
  </section>`;
}

function skillReportList(reports, steps = []) {
  if (!reports.length) return '';
  const runById = new Map(steps.flatMap(step => (step.runs || []).map(run => [run.id, run])));
  const groups = globalThis.CodexReportCards?.groupReports?.(reports, {
    rerunKeys: new Set(reports.filter(report => isRerunReport(report, runById)).map(report => report.reportKey || report.id)),
    rerunTitle: tr('rerunResults'), rerunSummary: count => trf('rerunReportsCombined', { count }),
  })
    || reports.map(report => ({ report, relatedReports: [] }));
  return `<section class="business-reports">
    <div class="business-reports-heading"><span class="section-label">${escapeHtml(tr('businessReports'))}</span><strong>${groups.length}</strong></div>
    <div class="business-report-list">${groups.map(({ report, relatedReports }) => {
    const status = reportStatusPresentation(report.status);
    const card = globalThis.CodexReportCards?.definition(report.reportType)
      || { id: 'business', labels: { zh: '业务结果', en: 'Business result' } };
    const observed = report.observedAt
      ? `<span>${escapeHtml(tr('reportObservedAt'))} <time>${escapeHtml(formatTime(report.observedAt))}</time></span>`
      : '';
    const metrics = (report.metrics || []).length
      ? `<div class="report-metrics">${report.metrics.map((metric) => `<div class="report-metric tone-${escapeHtml(metric.tone || 'neutral')}"><span>${escapeHtml(metric.label)}</span><strong>${escapeHtml(reportDisplayValue(metric.value))}</strong></div>`).join('')}</div>`
      : '';
    const analysisLinks = failureAnalysisReportLinks([report, ...relatedReports]);
    return `<article class="business-report report-card-${escapeHtml(card.id)} report-status-${escapeHtml(report.status)}" data-report-key="${escapeHtml(report.reportKey || report.id || '')}">
      <header class="business-report-head">
        <div><div class="report-card-kicker"><span class="report-card-type">${escapeHtml(card.labels[state.lang])}</span>${report.skillId ? `<span class="report-skill">${escapeHtml(report.skillId)} <code>v${Number(report.skillVersion || 0)}</code></span>` : ''}</div><h3>${escapeHtml(report.title)}</h3></div>
        <span class="report-status tone-${escapeHtml(status.tone)}">${escapeHtml(status.label)}</span>
      </header>
      ${analysisLinks}
      <p class="business-report-summary">${escapeHtml(report.summary)}</p>
      ${metrics}
      ${reportGroupArtifactLinks(report, relatedReports, analysisLinks ? ['pytest-html'] : null)}
      ${reportExecutionDetails(report)}
      <div class="report-sections">${(report.sections || []).map(skillReportSection).join('')}</div>
      ${relatedReportDetails(relatedReports, report.reportKey || report.id)}
      ${report.presentationGroup ? '' : `<details class="report-raw"><summary>${escapeHtml(tr('reportRawPayload'))}</summary><pre>${escapeHtml(JSON.stringify(report, null, 2))}</pre></details>`}
      <div class="business-report-meta">${report.presentationGroup ? '' : `<span>${escapeHtml(tr('reportRevision'))} #${Number(report.revision || 0)}</span>`}${observed}<span>${escapeHtml(tr('reportPublishedAt'))} <time>${escapeHtml(formatTime(report.publishedAt))}</time></span></div>
    </article>`;
  }).join('')}</div>
  </section>`;
}

function reportGroupArtifactLinks(report, relatedReports, kinds = null) {
  const members = [report, ...relatedReports];
  const tagged = field => members.flatMap(member => (member[field] || []).filter(artifact => !kinds || kinds.includes(artifact.kind)).map(artifact => ({
    ...artifact, reportKey: member.reportKey, executionStatus: artifact.executionStatus || member.status,
  })));
  const managed = tagged('artifacts');
  const managedKeys = new Set(managed.map(reportArtifactIdentity));
  const seenUrls = new Set();
  const unique = artifacts => artifacts.filter(artifact => {
    if (!artifact.url) return true;
    if (seenUrls.has(artifact.url)) return false;
    seenUrls.add(artifact.url);
    return true;
  });
  return reportArtifactLinks(unique(managed), unique(tagged('registeredArtifacts')
    .filter(artifact => !managedKeys.has(reportArtifactIdentity(artifact)))),
  relatedReports.length ? '' : report.status, tagged('artifactDeclarations'));
}

function relatedReportDetails(reports, groupKey = '') {
  if (!reports.length) return '';
  return `<details data-detail-key="related:${escapeHtml(groupKey)}" class="report-section report-related"><summary>${escapeHtml(tr('reportRelatedDetails'))} (${reports.length})</summary>
    <div class="report-section-body">${reports.map(report => `<details class="report-section" data-related-report-key="${escapeHtml(report.reportKey)}" data-detail-key="report:${escapeHtml(report.reportKey)}">
      <summary><span>${escapeHtml(report.title)}</span><code>${escapeHtml(reportStatusPresentation(report.status).label)}</code></summary>
      <div class="report-section-body"><p>${escapeHtml(report.summary)}</p><p>${escapeHtml(reportMetricSummary(report))}</p>
      ${reportExecutionDetails(report)}${(report.sections || []).map(skillReportSection).join('')}
      <details class="report-raw"><summary>${escapeHtml(tr('reportRawPayload'))}</summary><pre>${escapeHtml(JSON.stringify(report, null, 2))}</pre></details></div>
    </details>`).join('')}</div></details>`;
}

function reportExecutionDetails(report) {
  const execution = report.primaryExecution;
  if (!execution?.command) return '';
  const fields = [
    ['runtimeWorkingDir', execution.workingDirectory],
    ['commandPath', execution.commandPath],
    ['exitCode', execution.exitCode],
    ['startedAtShort', execution.startedAt ? formatTime(execution.startedAt) : ''],
    ['finishedAtShort', execution.finishedAt ? formatTime(execution.finishedAt) : ''],
  ].filter(([, value]) => value != null && value !== '');
  return `<details class="report-section report-execution" data-detail-key="execution:${escapeHtml(report.reportKey || report.id || '')}"><summary>${escapeHtml(tr('reportExecution'))}</summary><div class="report-section-body">
    <pre class="business-command">${escapeHtml(execution.command)}</pre>
    <dl class="report-fields">${fields.map(([key, value]) => `<div><dt>${escapeHtml(tr(key))}</dt><dd><code>${escapeHtml(String(value))}</code></dd></div>`).join('')}</dl>
  </div></details>`;
}

function reportCoversExecution(report, attempt) {
  const id = report.executionEvidence?.externalAttemptId;
  if (id) return id === attempt.id;
  const execution = report.primaryExecution;
  if (execution?.commandPath && execution.commandPath === attempt.commandPath) return true;
  return Boolean(execution?.startedAt && attempt.startedAt
    && execution.startedAt === attempt.startedAt && execution.command === attempt.command);
}

function businessReportPage(reports, externalAttempts, steps = []) {
  reports = reportsWithRegisteredArtifacts(reports, externalAttempts);
  const unreported = externalAttempts.filter(attempt => !reports.some(report => reportCoversExecution(report, attempt)));
  const executions = businessExecutionList([], unreported);
  const reportList = skillReportList(reports, steps);
  if (!executions && !reportList) {
    return `<div class="empty-state">${escapeHtml(tr('noBusinessReports'))}</div>`;
  }
  const remaining = executions
    ? `<section class="unreported-executions"><h3>${escapeHtml(tr('unreportedExecutions'))}</h3>${executions}</section>`
    : '';
  return `<div class="business-report-page">${reportList}${remaining}</div>`;
}

function operationAuditList(events) {
  const runtimeActors = new Set(['worker', 'codex-runtime', 'archive-worker']);
  return eventList(events.filter((event) => !runtimeActors.has(event.actor)), 'noOperations');
}

function shortHash(value) {
  const hash = String(value || '');
  return hash ? hash.slice(0, 12) : '-';
}

function skillChipsHtml(skills, showEmpty = false) {
  if (!skills?.length) {
    return showEmpty ? `<span class="attribution-empty">${escapeHtml(tr('noAttributedSkills'))}</span>` : '';
  }
  return skills.map((skill) => `<span class="attribution-chip" title="${escapeHtml(`${tr('contentHash')}: ${skill.contentHash || '-'}`)}"><strong>${escapeHtml(skill.skillId)}</strong><code>v${Number(skill.version || 0)} · ${escapeHtml(shortHash(skill.contentHash))}</code></span>`).join('');
}

function skillAttributionBlock(execution) {
  const skills = execution.skills || [];
  const history = execution.skillAttributionHistory || [];
  const unresolved = execution.unresolvedSkillIds || [];
  const chips = skillChipsHtml(skills, true);
  const unresolvedNotice = unresolved.length
    ? `<div class="attribution-warning"><span>${escapeHtml(tr('unresolvedSkills'))}</span><code>${escapeHtml(unresolved.join(', '))}</code></div>`
    : '';
  const historyRows = history.map((item) => `<li>
    <span class="attribution-action ${escapeHtml(item.action)}">${escapeHtml(tr(item.action))}</span>
    <code>${escapeHtml(item.skillId)} · v${Number(item.version)} · ${escapeHtml(shortHash(item.contentHash))}</code>
    <span>${escapeHtml(tr(item.source === 'runtime' ? 'runtimeDeclared' : 'operatorCorrection'))}</span>
    <time>${escapeHtml(formatTime(item.ts))}</time>
    <p>${escapeHtml(item.reason || '-')}</p>
  </li>`).join('');
  return `<section class="skill-attribution">
    <div class="attribution-head"><span>${escapeHtml(tr('attributedSkills'))}</span><button class="button secondary small" data-action="correct-execution-skills" data-id="${escapeHtml(execution.id)}">${escapeHtml(tr('correctAttribution'))}</button></div>
    <div class="attribution-chips">${chips}</div>
    ${unresolvedNotice}
    ${historyRows ? `<details><summary>${escapeHtml(tr('attributionHistory'))} (${history.length})</summary><ol class="attribution-history">${historyRows}</ol></details>` : ''}
  </section>`;
}

function groupedBy(items, keyFor) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFor(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.values()];
}

function commandExecutionRun(execution) {
  const runtimeDirectory = execution.workingDirectoryReported
    ? execution.workingDirectory
    : tr('runtimeDirUnreported');
  return `<article class="execution-item command-run">
    <div class="execution-head">
      <div><code>${escapeHtml(execution.runtimeItemId || execution.id)}</code><span>${escapeHtml(execution.status || '-')}</span></div>
      <time>${escapeHtml(formatTime(execution.finishedAt || execution.startedAt))}</time>
    </div>
    <div class="execution-meta">
      <span>${escapeHtml(tr('attempt'))} #${Number(execution.attemptNo || 0)} <code>${escapeHtml(execution.attemptId)}</code></span>
      <span>${escapeHtml(tr('exitCode'))} <code>${execution.exitCode == null ? '-' : Number(execution.exitCode)}</code></span>
      <span>${escapeHtml(tr('runtimeWorkingDir'))} <code>${escapeHtml(runtimeDirectory || '-')}</code></span>
    </div>
    ${skillAttributionBlock(execution)}
    <details class="command-output"><summary>${escapeHtml(tr('commandOutput'))}</summary><pre>${escapeHtml(execution.output || '-')}</pre></details>
    <details><summary>${escapeHtml(tr('payload'))}</summary><pre>${escapeHtml(JSON.stringify(execution.rawEvent || {}, null, 2))}</pre></details>
  </article>`;
}

function executionCommandGroup(executions) {
  const primary = executions[0];
  const repeated = executions.length > 1
    ? `<span class="command-repeat">${escapeHtml(tr('repeatedRuns'))} × ${executions.length}</span>`
    : '';
  return `<section class="execution-command-group">
    <div class="command-group-head"><span>${escapeHtml(tr('fullCommand'))}</span>${repeated}</div>
    ${executionCommandDetails(primary.command, 'execution-command', primary.id)}
    <div class="execution-run-list">${executions.map(commandExecutionRun).join('')}</div>
  </section>`;
}

function executionTurnGroup(executions) {
  const primary = executions[0];
  const commandGroups = groupedBy(
    executions,
    (execution) => String(execution.command || '').trim() || execution.id,
  );
  const configuredDirectories = [...new Set(executions
    .map((execution) => execution.configuredWorkingDirectory)
    .filter(Boolean))];
  return `<section class="execution-turn-group">
    <header class="execution-turn-head">
      <div><span>TURN #${Number(primary.turnSequence || 0)}</span><code>${escapeHtml(primary.turnId)}</code><strong>${executions.length} ${escapeHtml(tr('executionRuns'))}</strong></div>
      <p>${escapeHtml(primary.turnInput || '-')}</p>
      ${configuredDirectories.length ? `<div class="execution-turn-directory"><span>${escapeHtml(tr('configuredWorkingDir'))}</span><code>${escapeHtml(configuredDirectories.join('\n'))}</code></div>` : ''}
    </header>
    <div class="execution-command-list">${commandGroups.map(executionCommandGroup).join('')}</div>
  </section>`;
}

function executionList(executions) {
  if (!executions.length) return `<div class="empty-state">${escapeHtml(tr('noExecutions'))}</div>`;
  const turns = groupedBy(executions, (execution) => execution.turnId || execution.id);
  return `<div class="execution-turn-list">${turns.map(executionTurnGroup).join('')}</div>`;
}

function skillInvocationList(invocations) {
  if (!invocations.length) return `<div class="empty-state">${escapeHtml(tr('noSkillInvocations'))}</div>`;
  return `<div class="execution-list skill-invocation-list">${invocations.map((invocation) => `
    <article class="execution-item skill-invocation-item">
      <div class="execution-head">
        <div><code>${escapeHtml(invocation.id)}</code><span class="status-badge ${escapeHtml(invocation.status)}">${escapeHtml(tr(invocation.status))}</span></div>
        <time>${escapeHtml(formatTime(invocation.finishedAt || invocation.startedAt))}</time>
      </div>
      <div class="execution-meta">
        <span>${escapeHtml(tr('attempt'))} <code>${escapeHtml(invocation.attemptId || '-')}</code></span>
        <span>${escapeHtml(tr('exitCode'))} <code>${invocation.exitCode == null ? '-' : Number(invocation.exitCode)}</code></span>
        ${invocation.signal ? `<span>${escapeHtml(tr('signal'))} <code>${escapeHtml(invocation.signal)}</code></span>` : ''}
        ${invocation.commandName ? `<span>${escapeHtml(tr('fullCommand'))} <code>${escapeHtml(invocation.commandName)}</code></span>` : ''}
      </div>
      <div class="attribution-chips">${skillChipsHtml(invocation.skills, true)}</div>
    </article>`).join('')}</div>`;
}

function agentRecordsList(worklogEvents, executions, invocations = []) {
  return `<div class="agent-records">
    <section class="agent-record-section">
      <header class="agent-record-section-head"><h3>${escapeHtml(tr('worklog'))}</h3></header>
      <div class="event-list">${worklogEventList(worklogEvents)}</div>
    </section>
    <section class="agent-record-section">
      <header class="agent-record-section-head"><h3>${escapeHtml(tr('skillInvocations'))}</h3></header>
      ${skillInvocationList(invocations)}
    </section>
    <section class="agent-record-section">
      <header class="agent-record-section-head"><h3>${escapeHtml(tr('commands'))}</h3></header>
      ${executionList(executions)}
    </section>
  </div>`;
}

function attemptOutputUrl(attemptId, stream, taskId = state.currentTaskId) {
  return `/api/sessions/${encodeURIComponent(taskId)}/attempts/${encodeURIComponent(attemptId)}/${stream}`;
}

function attemptOutputWebSocketUrl(attemptId, stream, offset, taskId = state.currentTaskId) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const path = `${attemptOutputUrl(attemptId, stream, taskId)}/live?offset=${offset}`;
  return `${protocol}//${wsAuthPrefix()}${location.host}${path}`;
}

function externalOutputUrl(attemptId, taskId = state.currentTaskId) {
  return `/api/sessions/${encodeURIComponent(taskId)}/external-attempts/${encodeURIComponent(attemptId)}/log`;
}

function externalOutputWebSocketUrl(attemptId, offset, taskId = state.currentTaskId) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${wsAuthPrefix()}${location.host}${externalOutputUrl(attemptId, taskId)}/live?offset=${offset}`;
}

function terminalViewer({ outputKind, stream, streamLabel, status, url }) {
  const outputAttribute = outputKind === 'external'
    ? 'data-external-output="log"'
    : `data-attempt-output="${stream}"`;
  return `<section class="attempt-terminal hidden" ${outputAttribute}>
    <div class="attempt-terminal-head">
      <div class="terminal-title">
        <i class="terminal-session-dot" aria-hidden="true"></i>
        <strong>${escapeHtml(streamLabel)}</strong>
        <span class="attempt-live-status" data-attempt-live-status>${escapeHtml(status || '-')}</span>
      </div>
      <a class="terminal-raw-link" target="_blank" rel="noopener" href="${escapeHtml(url)}">${escapeHtml(tr('openRawOutput'))}</a>
    </div>
    <div class="attempt-terminal-host hidden" data-terminal-host role="region" aria-label="${escapeHtml(streamLabel)}"></div>
    <pre class="attempt-terminal-fallback" data-terminal-fallback tabindex="0"></pre>
  </section>`;
}

function attemptOutputControl(attempt, stream) {
  const available = Boolean(attempt[`${stream}Available`]);
  if (!available) return '';
  const bytes = Math.max(0, Number(attempt[`${stream}Bytes`] || 0));
  const url = attemptOutputUrl(attempt.id, stream);
  const streamLabel = tr(stream === 'stdout' ? 'sessionStdout' : 'sessionStderr');
  if (bytes > INLINE_ATTEMPT_OUTPUT_MAX_BYTES) {
    return `<a class="button secondary small" target="_blank" rel="noopener" href="${escapeHtml(url)}">${escapeHtml(tr('openRawOutput'))} · ${escapeHtml(streamLabel)} · ${escapeHtml(formatBytes(bytes))}</a>`;
  }
  return `<div class="attempt-output-control">
    <button class="terminal-stream-toggle" type="button" data-action="view-attempt-output" data-output-kind="attempt" data-id="${escapeHtml(attempt.id)}" data-stream="${stream}" data-view-label="${escapeHtml(tr('viewInlineOutput'))}" data-hide-label="${escapeHtml(tr('hideInlineOutput'))}" aria-expanded="false">${escapeHtml(tr('viewInlineOutput'))} · ${escapeHtml(streamLabel)} · ${escapeHtml(formatBytes(bytes))}</button>
    ${terminalViewer({ outputKind: 'attempt', stream, streamLabel, status: attempt.status, url })}
  </div>`;
}

function externalOutputControl(attempt) {
  const bytes = Math.max(0, Number(attempt.archivedLogBytes || 0));
  const url = externalOutputUrl(attempt.id);
  const streamLabel = `${tr('backgroundOutput')} · ${attempt.label || attempt.id}`;
  if (bytes > INLINE_ATTEMPT_OUTPUT_MAX_BYTES) {
    return `<a class="button secondary small" target="_blank" rel="noopener" href="${escapeHtml(url)}">${escapeHtml(tr('openRawOutput'))} · ${escapeHtml(streamLabel)} · ${escapeHtml(formatBytes(bytes))}</a>`;
  }
  return `<div class="attempt-output-control">
    <button class="terminal-stream-toggle" type="button" data-action="view-attempt-output" data-output-kind="external" data-id="${escapeHtml(attempt.id)}" data-stream="log" data-view-label="${escapeHtml(tr('viewInlineOutput'))}" data-hide-label="${escapeHtml(tr('hideInlineOutput'))}" aria-expanded="false">${escapeHtml(tr('viewInlineOutput'))} · ${escapeHtml(streamLabel)}${bytes ? ` · ${escapeHtml(formatBytes(bytes))}` : ''}</button>
    ${terminalViewer({ outputKind: 'external', stream: 'log', streamLabel, status: attempt.status, url })}
  </div>`;
}

function externalTerminalList(attempts) {
  return attempts.map((attempt) => {
    const exitCode = externalAttemptExitCode(attempt);
    return `
    <article class="execution-item tracking-item">
      <div class="execution-head">
        <div><strong>${escapeHtml(tr('backgroundOutput'))}</strong><code>${escapeHtml(attempt.id)}</code><span class="status-badge ${escapeHtml(attempt.status)}">${escapeHtml(attempt.status)}</span></div>
        <time>${escapeHtml(formatTime(attempt.finishedAt || attempt.lastCheckedAt || attempt.startedAt))}</time>
      </div>
      <div class="execution-meta">
        <span>${escapeHtml(tr('pid'))} <code>${attempt.pid == null ? '-' : Number(attempt.pid)}</code></span>
        <span>${escapeHtml(tr('exitCode'))} <code>${exitCode == null ? '-' : exitCode}</code></span>
        <span>${escapeHtml(tr('archivePreservation'))} <code>${escapeHtml(attempt.archiveStatus || 'pending')}</code></span>
      </div>
      ${attempt.command ? `<div class="command-audit">${executionCommandDetails(attempt.command, 'business-command', attempt.id)}</div>` : ''}
      <div class="attempt-output-links">${externalOutputControl(attempt)}</div>
    </article>`;
  }).join('');
}

function taskTerminalList(attempts, externalAttempts) {
  if (!attempts.length && !externalAttempts.length) {
    return `<div class="empty-state">${escapeHtml(tr('noAttempts'))}</div>`;
  }
  return `<div class="execution-list task-terminal-list">${attemptList(attempts)}${externalTerminalList(externalAttempts)}</div>`;
}

function attemptList(attempts) {
  if (!attempts.length) return `<div class="empty-state">${escapeHtml(tr('noAttempts'))}</div>`;
  return attempts.map((attempt) => `
    <article class="execution-item">
      <div class="execution-head">
        <div><code>${escapeHtml(attempt.id)}</code><span>${escapeHtml(attempt.status || '-')}</span></div>
        <time>${escapeHtml(formatTime(attempt.finishedAt || attempt.startedAt))}</time>
      </div>
      <div class="execution-meta">
        <span>TURN #${Number(attempt.turnSequence || 0)} <code>${escapeHtml(attempt.turnId)}</code></span>
        <span>${escapeHtml(tr('attempt'))} #${Number(attempt.attemptNo || 0)}</span>
        <span>${escapeHtml(tr('pid'))} <code>${attempt.pid == null ? '-' : Number(attempt.pid)}</code></span>
        <span>${escapeHtml(tr('exitCode'))} <code>${attempt.exitCode == null ? '-' : Number(attempt.exitCode)}</code></span>
        <span>${escapeHtml(tr('signal'))} <code>${escapeHtml(attempt.signal || '-')}</code></span>
      </div>
      <div class="execution-context"><span>${escapeHtml(tr('turnInput'))}</span><p>${escapeHtml(attempt.turnInput || '-')}</p></div>
      ${attempt.error && (!attempt.stdoutAvailable || Number(attempt.stdoutBytes || 0) > INLINE_ATTEMPT_OUTPUT_MAX_BYTES)
        ? `<div class="command-audit"><span>${escapeHtml(tr('attemptError'))}</span><pre>${escapeHtml(attempt.error)}</pre></div>`
        : ''}
      <div class="attempt-output-links">
        ${attemptOutputControl(attempt, 'stdout')}
        ${attemptOutputControl(attempt, 'stderr')}
      </div>
    </article>`).join('');
}

function defaultAttemptOutputKey(attempts, externalAttempts = []) {
  for (const requireContent of [true, false]) {
    for (const attempt of attempts) {
      for (const stream of ['stdout', 'stderr']) {
        const available = Boolean(attempt[`${stream}Available`]);
        const bytes = Math.max(0, Number(attempt[`${stream}Bytes`] || 0));
        if (available && bytes <= INLINE_ATTEMPT_OUTPUT_MAX_BYTES && (!requireContent || bytes > 0)) {
          return `attempt:${attempt.id}:${stream}`;
        }
      }
    }
  }
  for (const attempt of externalAttempts) {
    const bytes = Math.max(0, Number(attempt.archivedLogBytes || 0));
    if (attempt.archiveStatus !== 'failed' && bytes <= INLINE_ATTEMPT_OUTPUT_MAX_BYTES) {
      return `external:${attempt.id}:log`;
    }
  }
  return '';
}

async function showPreferredAttemptOutput(attempts, externalAttempts = []) {
  let outputKey = state.expandedAttemptOutputKey;
  if (!outputKey && state.taskTerminalAutoOpen) {
    outputKey = defaultAttemptOutputKey(attempts, externalAttempts);
  }
  state.taskTerminalAutoOpen = false;
  if (!outputKey) return;
  const button = $$('#taskConsoleOutput [data-action="view-attempt-output"]')
    .find((candidate) => `${candidate.dataset.outputKind || 'attempt'}:${candidate.dataset.id}:${candidate.dataset.stream}` === outputKey);
  if (!button) {
    state.expandedAttemptOutputKey = '';
    return;
  }
  await toggleAttemptOutput(button);
}

function abortAttemptOutputLoad() {
  const active = state.attemptOutputLoad;
  if (!active) return;
  state.attemptOutputLoad = null;
  clearTimeout(active.timer);
  active.resumePoll?.();
  active.controller.abort();
  try { active.socket?.close(1000, 'Viewer closed'); } catch {}
  active.finishSocketTail?.();
  if (!active.viewer.isConnected) return;
  active.viewer.classList.add('hidden');
  const fallback = active.viewer.querySelector('[data-terminal-fallback]') || active.viewer.querySelector('pre');
  if (fallback) fallback.textContent = '';
  delete active.viewer.dataset.loaded;
  disposeAttemptTerminal(active.viewer);
  active.button.setAttribute('aria-expanded', 'false');
  active.button.textContent = active.button.dataset.viewLabel;
}

function disposeAttemptTerminal(viewer) {
  const view = viewer?.attemptTerminalView;
  if (!view) return;
  view.disposed = true;
  clearTimeout(view.printTimer);
  view.printTimer = null;
  for (const resolve of view.idleResolvers) resolve();
  view.idleResolvers.clear();
  view.resizeObserver?.disconnect();
  view.terminal.dispose();
  delete viewer.attemptTerminalView;
  attemptTerminalViewers.delete(viewer);
  const host = viewer.querySelector?.('[data-terminal-host]');
  const fallback = viewer.querySelector?.('[data-terminal-fallback]') || viewer.querySelector?.('pre');
  host?.classList.add('hidden');
  fallback?.classList.remove('hidden');
}

function disposeAttemptTerminals() {
  for (const viewer of [...attemptTerminalViewers]) disposeAttemptTerminal(viewer);
}

function fitAttemptTerminal(viewer) {
  try {
    viewer?.attemptTerminalView?.fitAddon?.fit();
  } catch {
    // The plain-text fallback remains available when a hidden host cannot be measured.
  }
}

const ATTEMPT_TERMINAL_PRINT_INTERVAL_MS = 18;
const ATTEMPT_TERMINAL_PRINT_TARGET_FRAMES = 90;
const ATTEMPT_TERMINAL_PRINT_MIN_CHARS = 6;
const ATTEMPT_TERMINAL_PRINT_MAX_CHARS = 32 * 1024;

function resolveAttemptTerminalIdle(view) {
  if (view.disposed || view.printQueue.length || view.printing || view.printTimer) return;
  view.printFrame = 0;
  for (const resolve of view.idleResolvers) resolve();
  view.idleResolvers.clear();
}

function takeAttemptTerminalPrintChunk(view, size) {
  let remaining = size;
  let chunk = '';
  while (remaining > 0 && view.printQueue.length) {
    const current = view.printQueue[0];
    const take = Math.min(remaining, current.length);
    chunk += current.slice(0, take);
    view.pendingPrintChars -= take;
    remaining -= take;
    if (take === current.length) view.printQueue.shift();
    else view.printQueue[0] = current.slice(take);
  }
  return chunk;
}

function pumpAttemptTerminalPrint(viewer) {
  const view = viewer?.attemptTerminalView;
  if (!view || view.disposed || view.printing || view.printTimer || !view.printQueue.length) {
    if (view) resolveAttemptTerminalIdle(view);
    return;
  }

  const remainingFrames = Math.max(1, ATTEMPT_TERMINAL_PRINT_TARGET_FRAMES - view.printFrame);
  const chunkSize = Math.min(
    ATTEMPT_TERMINAL_PRINT_MAX_CHARS,
    Math.max(ATTEMPT_TERMINAL_PRINT_MIN_CHARS, Math.ceil(view.pendingPrintChars / remainingFrames)),
  );
  const chunk = takeAttemptTerminalPrintChunk(view, chunkSize);
  view.printFrame += 1;
  view.printing = true;
  try {
    view.terminal.write(chunk, () => {
      if (view.disposed) return;
      view.printing = false;
      fitAttemptTerminal(viewer);
      view.terminal.scrollToBottom();
      if (!view.printQueue.length) {
        resolveAttemptTerminalIdle(view);
        return;
      }
      view.printTimer = setTimeout(() => {
        view.printTimer = null;
        pumpAttemptTerminalPrint(viewer);
      }, ATTEMPT_TERMINAL_PRINT_INTERVAL_MS);
    });
  } catch {
    view.printing = false;
    disposeAttemptTerminal(viewer);
  }
}

function queueAttemptTerminalPrint(viewer, text) {
  const content = String(text || '');
  const view = viewer?.attemptTerminalView;
  if (!content || !view || view.disposed) return false;
  view.printQueue.push(content);
  view.pendingPrintChars += content.length;
  pumpAttemptTerminalPrint(viewer);
  return Boolean(viewer.attemptTerminalView);
}

function waitForAttemptTerminalIdle(viewer) {
  const view = viewer?.attemptTerminalView;
  if (!view || view.disposed || (!view.printQueue.length && !view.printing && !view.printTimer)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => view.idleResolvers.add(resolve));
}

function terminalTextBlock(value) {
  const text = String(value ?? '');
  return text && !text.endsWith('\n') ? `${text}\n` : text;
}

const TERMINAL_ANSI = Object.freeze({
  reset: '\x1b[0m',
  boldBlue: '\x1b[1;94m',
  blue: '\x1b[94m',
  green: '\x1b[92m',
  yellow: '\x1b[93m',
  red: '\x1b[91m',
  dim: '\x1b[2m',
});

function terminalColor(color, value) {
  return `${TERMINAL_ANSI[color]}${String(value)}${TERMINAL_ANSI.reset}`;
}

function plainTerminalText(value) {
  return String(value || '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

function formatCodexRuntimeEvent(event, formatter) {
  if (!event || typeof event !== 'object') return '';
  if (event.type === 'turn.started') {
    formatter.lastErrorMessage = '';
    return '';
  }
  if (['thread.started', 'turn.completed'].includes(event.type)) return '';

  const item = event.item;
  if (item?.type === 'agent_message' && event.type === 'item.completed') {
    const message = terminalTextBlock(item.text);
    return message ? `${terminalColor('boldBlue', 'Codex')}\n${message}\n` : '';
  }
  if (item?.type === 'command_execution') {
    const itemId = String(item.id || '');
    const command = String(item.command || '');
    if (event.type === 'item.started') {
      if (itemId) formatter.startedCommandIds.add(itemId);
      return command ? `${terminalColor('green', '$')} ${terminalTextBlock(command)}` : '';
    }
    if (event.type === 'item.completed') {
      const showCommand = command && (!itemId || !formatter.startedCommandIds.has(itemId));
      if (itemId) formatter.startedCommandIds.delete(itemId);
      const output = terminalTextBlock(item.aggregated_output ?? item.output ?? item.stdout ?? '');
      const exitCode = item.exit_code == null ? null : Number(item.exit_code);
      const exitLine = exitCode == null
        ? ''
        : `${terminalColor(exitCode === 0 ? 'green' : 'red', `[exit ${exitCode}]`)}\n`;
      return `${showCommand ? `${terminalColor('green', '$')} ${terminalTextBlock(command)}` : ''}${output}${exitLine}\n`;
    }
  }

  const errorMessage = event.type === 'turn.failed'
    ? event.error?.message
    : (event.type === 'error' ? event.message : '');
  if (errorMessage) {
    const message = String(errorMessage).trim();
    if (!message || formatter.lastErrorMessage === message) return '';
    formatter.lastErrorMessage = message;
    return `${terminalColor('red', '[Error]')} ${message}\n`;
  }
  if (typeof event.message === 'string' && event.message.trim()) {
    return `${terminalColor('dim', `[${event.type || 'runtime'}]`)} ${event.message.trim()}\n`;
  }
  return '';
}

function createAttemptOutputFormatter(format = 'raw') {
  if (format !== 'codex-jsonl') {
    return { push: (text) => String(text || '') };
  }
  const formatter = {
    buffer: '',
    startedCommandIds: new Set(),
    lastErrorMessage: '',
    push(text, final = false) {
      this.buffer += String(text || '');
      const lines = this.buffer.split('\n');
      this.buffer = final ? '' : (lines.pop() || '');
      let output = '';
      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '');
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch {
          output += `${line}\n`;
          continue;
        }
        if (!event || typeof event !== 'object' || !event.type) {
          output += `${line}\n`;
          continue;
        }
        output += formatCodexRuntimeEvent(event, this);
      }
      if (final && this.buffer) {
        output += `${this.buffer}\n`;
        this.buffer = '';
      }
      return output;
    },
  };
  return formatter;
}

function appendFormattedAttemptOutput(load, text, final = false) {
  const content = load.outputFormatter.push(text, final);
  appendAttemptTerminal(load.viewer, content);
}

function resetAttemptOutputFormatting(load) {
  load.decoder = new TextDecoder();
  load.outputFormatter = createAttemptOutputFormatter(load.outputFormat);
}

function renderAttemptTerminal(viewer, text, isError = false) {
  disposeAttemptTerminal(viewer);
  const fallback = viewer.querySelector?.('[data-terminal-fallback]') || viewer.querySelector?.('pre');
  const host = viewer.querySelector?.('[data-terminal-host]');
  const content = String(text || '');
  if (fallback) {
    fallback.textContent = plainTerminalText(content);
    if (isError) fallback.classList.add('error');
    else fallback.classList.remove('error');
    fallback.classList.remove('hidden');
  }
  if (isError || !host || typeof globalThis.Terminal !== 'function') return false;

  let terminal = null;
  try {
    terminal = new globalThis.Terminal({
      convertEol: true,
      cursorBlink: true,
      disableStdin: true,
      fontFamily: '"Courier New", "Noto Sans Mono CJK SC", monospace',
      fontSize: terminalFontSize(14),
      lineHeight: 1.3,
      scrollback: 20000,
      theme: TERMINAL_THEME,
    });
    const fitAddon = typeof globalThis.FitAddon?.FitAddon === 'function'
      ? new globalThis.FitAddon.FitAddon()
      : null;
    if (fitAddon) terminal.loadAddon(fitAddon);
    host.classList.remove('hidden');
    fallback?.classList.add('hidden');
    terminal.open(host);
    const resizeObserver = typeof globalThis.ResizeObserver === 'function'
      ? new globalThis.ResizeObserver(() => fitAttemptTerminal(viewer))
      : null;
    viewer.attemptTerminalView = {
      terminal,
      fitAddon,
      resizeObserver,
      disposed: false,
      printQueue: [],
      pendingPrintChars: 0,
      printFrame: 0,
      printTimer: null,
      printing: false,
      idleResolvers: new Set(),
    };
    attemptTerminalViewers.add(viewer);
    resizeObserver?.observe(host);
    fitAttemptTerminal(viewer);
    return !content || queueAttemptTerminalPrint(viewer, content);
  } catch {
    if (viewer.attemptTerminalView) disposeAttemptTerminal(viewer);
    else {
      terminal?.dispose();
      host.classList.add('hidden');
      fallback?.classList.remove('hidden');
    }
    return false;
  }
}

function appendAttemptTerminal(viewer, text) {
  const content = String(text || '');
  if (!content) return;
  const fallback = viewer.querySelector?.('[data-terminal-fallback]') || viewer.querySelector?.('pre');
  if (fallback) {
    fallback.textContent += plainTerminalText(content);
    fallback.scrollTop = fallback.scrollHeight;
  }
  const terminal = viewer.attemptTerminalView?.terminal;
  if (!terminal) return;
  queueAttemptTerminalPrint(viewer, content);
}

function updateAttemptOutputStatus(viewer, status, mode = '') {
  const statusElement = viewer.querySelector?.('[data-attempt-live-status]');
  if (!statusElement) return;
  statusElement.classList?.toggle?.('live', mode === 'live');
  statusElement.classList?.toggle?.('reconnecting', mode === 'reconnecting');
  const modeLabels = {
    live: 'liveOutput',
    reconnecting: 'reconnectingOutput',
    complete: 'completeOutput',
    inlineLimit: 'inlineOutputLimit',
  };
  statusElement.textContent = mode ? tr(modeLabels[mode]) : (status || '-');
}

function responseHeaderInteger(response, name, fallback) {
  const rawValue = response.headers.get(name);
  if (rawValue == null || rawValue === '') return fallback;
  const value = Number(rawValue);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

async function fetchAttemptOutputChunk(url, offset, signal) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromSource = () => controller.abort();
  if (signal.aborted) abortFromSource();
  else signal.addEventListener('abort', abortFromSource, { once: true });
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, API_REQUEST_TIMEOUT_MS);
  try {
    const separator = url.includes('?') ? '&' : '?';
    const limit = Math.min(ATTEMPT_OUTPUT_CHUNK_BYTES, INLINE_ATTEMPT_OUTPUT_MAX_BYTES - offset);
    const response = await fetch(`${url}${separator}offset=${offset}&limit=${limit}`, {
      signal: controller.signal,
      headers: { Accept: 'text/plain' },
    });
    if (!response.ok) {
      const contentType = response.headers.get('content-type') || '';
      const payload = contentType.includes('application/json') ? await response.json() : await response.text();
      const error = new Error(payload?.error || payload || String(response.status));
      error.status = response.status;
      throw error;
    }
    const buffer = typeof response.arrayBuffer === 'function'
      ? await response.arrayBuffer()
      : new TextEncoder().encode(await response.text()).buffer;
    const bytes = new Uint8Array(buffer);
    const actualOffset = responseHeaderInteger(response, 'x-log-offset', offset);
    return {
      bytes,
      offset: actualOffset,
      nextOffset: responseHeaderInteger(response, 'x-log-next-offset', actualOffset + bytes.byteLength),
      fileSize: responseHeaderInteger(response, 'x-log-file-size', actualOffset + bytes.byteLength),
      status: response.headers.get('x-attempt-status') || '',
    };
  } catch (error) {
    if (timedOut) throw Object.assign(new Error(tr('requestTimeout')), { name: 'RequestTimeoutError' });
    throw error;
  } finally {
    clearTimeout(timeoutTimer);
    signal.removeEventListener('abort', abortFromSource);
  }
}

function waitForAttemptOutputPoll(load, delay = ATTEMPT_OUTPUT_POLL_INTERVAL_MS) {
  return new Promise((resolve) => {
    if (load.controller.signal.aborted) {
      resolve();
      return;
    }
    load.resumePoll = () => {
      load.resumePoll = null;
      resolve();
    };
    load.timer = setTimeout(load.resumePoll, delay);
  });
}

async function tailAttemptOutput(load) {
  const { viewer, controller } = load;
  let initialized = false;
  let retryCount = 0;
  while (!controller.signal.aborted && viewer.isConnected) {
    try {
      const chunk = await fetchAttemptOutputChunk(load.url, load.offset, controller.signal);
      if (controller.signal.aborted || !viewer.isConnected) return;
      if (chunk.offset < load.offset || chunk.fileSize < load.offset) {
        load.decoder.decode();
        resetAttemptOutputFormatting(load);
        load.offset = 0;
        initialized = false;
        disposeAttemptTerminal(viewer);
        continue;
      }
      if (!initialized) {
        const fallback = viewer.querySelector('[data-terminal-fallback]') || viewer.querySelector('pre');
        if (fallback) fallback.textContent = '';
        renderAttemptTerminal(viewer, '');
        initialized = true;
      }
      appendFormattedAttemptOutput(load, load.decoder.decode(chunk.bytes, { stream: true }));
      load.offset = chunk.nextOffset;
      retryCount = 0;
      const terminalStatus = ATTEMPT_OUTPUT_TERMINAL_STATUSES.has(chunk.status);
      if (terminalStatus && load.offset >= chunk.fileSize) {
        appendFormattedAttemptOutput(load, load.decoder.decode(), true);
        await waitForAttemptTerminalIdle(viewer);
        if (controller.signal.aborted || !viewer.isConnected) return;
        const fallback = viewer.querySelector('[data-terminal-fallback]') || viewer.querySelector('pre');
        if (load.offset === 0 && fallback && !viewer.attemptTerminalView) fallback.textContent = tr('emptyOutput');
        viewer.dataset.loaded = 'true';
        updateAttemptOutputStatus(viewer, tr(chunk.status), 'complete');
        return;
      }
      if (load.offset >= INLINE_ATTEMPT_OUTPUT_MAX_BYTES) {
        appendFormattedAttemptOutput(load, load.decoder.decode(), true);
        await waitForAttemptTerminalIdle(viewer);
        if (controller.signal.aborted || !viewer.isConnected) return;
        viewer.dataset.loaded = 'true';
        updateAttemptOutputStatus(viewer, '', 'inlineLimit');
        return;
      }
      updateAttemptOutputStatus(viewer, chunk.status, 'live');
      if (load.offset < chunk.fileSize) continue;
      await waitForAttemptOutputPoll(load);
    } catch (error) {
      if (error.name === 'AbortError' || controller.signal.aborted || !viewer.isConnected) return;
      if ([400, 404].includes(error.status)) throw error;
      retryCount += 1;
      updateAttemptOutputStatus(viewer, '', 'reconnecting');
      await waitForAttemptOutputPoll(load, Math.min(5000, ATTEMPT_OUTPUT_POLL_INTERVAL_MS * retryCount));
    }
  }
}

function resetAttemptOutputTail(load) {
  resetAttemptOutputFormatting(load);
  load.offset = 0;
  delete load.viewer.dataset.loaded;
  disposeAttemptTerminal(load.viewer);
  const fallback = load.viewer.querySelector('[data-terminal-fallback]') || load.viewer.querySelector('pre');
  if (fallback) fallback.textContent = '';
  renderAttemptTerminal(load.viewer, '');
}

function tailAttemptOutputWebSocket(load) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let ending = false;
    let handshakeFailures = 0;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(load.timer);
      load.finishSocketTail = null;
      if (error) reject(error);
      else resolve();
    };
    load.finishSocketTail = () => finish();

    const fallBackToHttp = () => {
      if (settled || load.controller.signal.aborted) {
        finish();
        return;
      }
      settled = true;
      clearTimeout(load.timer);
      load.finishSocketTail = null;
      load.socket = null;
      resetAttemptOutputTail(load);
      tailAttemptOutput(load).then(resolve, reject);
    };

    const connect = () => {
      if (settled || load.controller.signal.aborted || !load.viewer.isConnected) {
        finish();
        return;
      }
      let opened = false;
      const socket = new globalThis.WebSocket(load.webSocketUrl(load.offset));
      load.socket = socket;
      socket.binaryType = 'arraybuffer';
      const finishAfterPrint = (status, mode, closeReason, showEmptyOutput = false) => {
        if (ending || settled) return;
        ending = true;
        try { socket.close(1000, closeReason); } catch {}
        waitForAttemptTerminalIdle(load.viewer).then(() => {
          if (settled) return;
          if (load.controller.signal.aborted || !load.viewer.isConnected) {
            finish();
            return;
          }
          const fallback = load.viewer.querySelector('[data-terminal-fallback]')
            || load.viewer.querySelector('pre');
          if (showEmptyOutput && load.offset === 0 && fallback && !load.viewer.attemptTerminalView) {
            fallback.textContent = tr('emptyOutput');
          }
          load.viewer.dataset.loaded = 'true';
          updateAttemptOutputStatus(load.viewer, status, mode);
          finish();
        });
      };
      const handshakeTimer = setTimeout(() => {
        if (!opened && socket.readyState < 2) {
          try { socket.close(); } catch {}
        }
      }, 5000);
      socket.onopen = () => {
        opened = true;
        handshakeFailures = 0;
        clearTimeout(handshakeTimer);
      };
      socket.onmessage = (event) => {
        if (settled || load.controller.signal.aborted) return;
        if (typeof event.data !== 'string') {
          const bytes = new Uint8Array(event.data);
          appendFormattedAttemptOutput(load, load.decoder.decode(bytes, { stream: true }));
          load.offset += bytes.byteLength;
          if (load.offset >= INLINE_ATTEMPT_OUTPUT_MAX_BYTES) {
            appendFormattedAttemptOutput(load, load.decoder.decode(), true);
            finishAfterPrint('', 'inlineLimit', 'Inline limit reached');
          }
          return;
        }
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.type === 'ready' || message.type === 'reset') {
          const serverOffset = Math.max(0, Number(message.offset || 0));
          if (message.type === 'reset' || serverOffset < load.offset) resetAttemptOutputTail(load);
          load.offset = serverOffset;
          updateAttemptOutputStatus(load.viewer, message.status, 'live');
          return;
        }
        if (message.type === 'status') {
          updateAttemptOutputStatus(load.viewer, message.status, 'live');
          return;
        }
        if (message.type === 'end') {
          appendFormattedAttemptOutput(load, load.decoder.decode(), true);
          finishAfterPrint(message.status, 'complete', 'Attempt completed', true);
          return;
        }
        if (message.type === 'error') {
          finish(new Error(message.message || tr('loadFailed')));
          socket.close(1011, 'Output stream failed');
        }
      };
      socket.onerror = () => {};
      socket.onclose = () => {
        clearTimeout(handshakeTimer);
        if (load.socket === socket) load.socket = null;
        if (ending) return;
        if (settled || load.controller.signal.aborted || !load.viewer.isConnected) {
          finish();
          return;
        }
        if (!opened) handshakeFailures += 1;
        if (handshakeFailures >= 3) {
          fallBackToHttp();
          return;
        }
        updateAttemptOutputStatus(load.viewer, '', 'reconnecting');
        load.timer = setTimeout(connect, ATTEMPT_OUTPUT_POLL_INTERVAL_MS);
      };
    };

    resetAttemptOutputTail(load);
    connect();
  });
}

async function toggleAttemptOutput(button) {
  const outputKind = button.dataset.outputKind || 'attempt';
  const stream = button.dataset.stream;
  if (outputKind === 'attempt' && !['stdout', 'stderr'].includes(stream)) return;
  if (outputKind === 'external' && stream !== 'log') return;
  if (!['attempt', 'external'].includes(outputKind)) return;
  const outputKey = `${outputKind}:${button.dataset.id}:${stream}`;
  const viewerSelector = outputKind === 'external'
    ? '[data-external-output="log"]'
    : `[data-attempt-output="${stream}"]`;
  const viewer = button.closest('.execution-item')?.querySelector(viewerSelector);
  if (!viewer) return;
  if (!viewer.classList.contains('hidden')) {
    if (state.expandedAttemptOutputKey === outputKey) state.expandedAttemptOutputKey = '';
    if (state.attemptOutputLoad?.viewer === viewer) abortAttemptOutputLoad();
    else {
      viewer.classList.add('hidden');
      button.setAttribute('aria-expanded', 'false');
      button.textContent = button.dataset.viewLabel;
    }
    return;
  }
  viewer.classList.remove('hidden');
  state.expandedAttemptOutputKey = outputKey;
  button.setAttribute('aria-expanded', 'true');
  button.textContent = button.dataset.hideLabel;
  if (viewer.dataset.loaded === 'true') {
    if (!viewer.attemptTerminalView) {
      const fallback = viewer.querySelector('[data-terminal-fallback]') || viewer.querySelector('pre');
      renderAttemptTerminal(viewer, fallback?.textContent || '', fallback?.classList.contains('error'));
    }
    fitAttemptTerminal(viewer);
    return;
  }

  abortAttemptOutputLoad();
  viewer.classList.remove('hidden');
  button.setAttribute('aria-expanded', 'true');
  button.textContent = button.dataset.hideLabel;
  const output = viewer.querySelector('[data-terminal-fallback]') || viewer.querySelector('pre');
  output.classList.remove('error');
  output.textContent = tr('loadingOutput');
  const controller = new AbortController();
  const load = {
    controller,
    viewer,
    button,
    url: outputKind === 'external'
      ? externalOutputUrl(button.dataset.id)
      : attemptOutputUrl(button.dataset.id, stream),
    webSocketUrl: outputKind === 'external'
      ? (offset) => externalOutputWebSocketUrl(button.dataset.id, offset)
      : (offset) => attemptOutputWebSocketUrl(button.dataset.id, stream, offset),
    offset: 0,
    timer: null,
    resumePoll: null,
    outputFormat: outputKind === 'attempt' && stream === 'stdout' ? 'codex-jsonl' : 'raw',
  };
  resetAttemptOutputFormatting(load);
  state.attemptOutputLoad = load;
  try {
    if (typeof globalThis.WebSocket === 'function') await tailAttemptOutputWebSocket(load);
    else await tailAttemptOutput(load);
  } catch (error) {
    if (error.name !== 'AbortError' && viewer.isConnected) {
      renderAttemptTerminal(viewer, error.message, true);
    }
  } finally {
    if (state.attemptOutputLoad === load) state.attemptOutputLoad = null;
  }
}

function managedCodexTerminalStream(task, attempts = [], externalAttempts = []) {
  if (task?.status === 'completed') return null;
  const runningAttempt = attempts.find((attempt) => attempt.status === 'running');
  const attempt = runningAttempt || attempts[0];
  if (attempt) {
    const outputFormat = attempt.stdoutFormat === 'codex-jsonl' ? 'codex-jsonl' : 'raw';
    const stdoutBytes = Math.max(0, Number(attempt.stdoutBytes || 0));
    return {
      kind: 'attempt',
      id: attempt.id,
      outputFormat,
      initialOffset: Math.max(0, stdoutBytes - CODEX_CLI_INITIAL_REPLAY_MAX_BYTES),
      ...(outputFormat === 'raw' ? {
        cols: MANAGED_CODEX_TERMINAL_COLUMNS,
        rows: MANAGED_CODEX_TERMINAL_ROWS,
      } : {}),
      webSocketUrl: (offset) => attemptOutputWebSocketUrl(attempt.id, 'stdout', offset, task.id),
    };
  }
  return { kind: 'waiting', id: '', outputFormat: 'raw', webSocketUrl: null };
}

function codexTerminalPage(managed = false) {
  const managedDisabled = managed ? ' disabled' : '';
  return `<section class="codex-cli-shell">
    <header class="codex-cli-toolbar">
      <div class="codex-cli-connection"><i aria-hidden="true"></i><span data-codex-cli-status>${escapeHtml(tr('cliConnecting'))}</span></div>
      <div class="codex-cli-actions">
        <label class="codex-cli-input-lock" title="${escapeHtml(tr('cliUnlockInput'))}">
          <span data-codex-cli-input-state>${escapeHtml(tr('cliReadOnly'))}</span>
          <input type="checkbox" role="switch" data-action="codex-cli-toggle-input" aria-label="${escapeHtml(tr('cliUnlockInput'))}"${managedDisabled}>
          <i aria-hidden="true"></i>
        </label>
        <button type="button" data-codex-cli-write-control data-action="codex-cli-interrupt" title="${escapeHtml(tr('cliInterrupt'))}" disabled>Ctrl+C</button>
        <button type="button" data-action="codex-cli-clear">${escapeHtml(tr('cliClear'))}</button>
        <button type="button" data-action="codex-cli-reconnect">${escapeHtml(tr('cliReconnect'))}</button>
        <button type="button" class="danger" data-codex-cli-write-control data-action="codex-cli-terminate" disabled>${escapeHtml(tr('cliTerminate'))}</button>
      </div>
    </header>
    <div class="codex-cli-terminal" data-codex-cli-host role="application" aria-label="Codex CLI"></div>
    <div class="codex-cli-error hidden" data-codex-cli-error role="status"></div>
  </section>`;
}

function codexTerminalSocketUrl(taskId, terminal) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams({ cols: terminal.cols, rows: terminal.rows });
  return `${protocol}//${wsAuthPrefix()}${location.host}/api/sessions/${encodeURIComponent(taskId)}/codex-terminal/live?${params}`;
}

function updateCodexTerminalStatus(view, stateName, text) {
  if (!view?.shell?.isConnected) return;
  const status = view.shell.querySelector('[data-codex-cli-status]');
  const error = view.shell.querySelector('[data-codex-cli-error]');
  view.shell.dataset.connection = stateName;
  if (status) status.textContent = text;
  if (error && stateName !== 'error') {
    error.textContent = '';
    error.classList.add('hidden');
  }
}

function disposeCodexTerminal() {
  const view = state.codexTerminalView;
  if (!view) return;
  state.codexTerminalView = null;
  clearTimeout(view.reconnectTimer);
  view.reconnectTimer = null;
  view.resizeObserver?.disconnect();
  try { view.socket?.close(1000, 'Terminal view closed'); } catch {}
  view.terminal?.dispose();
}

function sendCodexTerminalControl(type, data = {}) {
  const socket = state.codexTerminalView?.socket;
  if (socket?.readyState !== 1) return false;
  socket.send(JSON.stringify({ type, ...data }));
  return true;
}

function sendUnlockedCodexTerminalControl(type, data = {}) {
  if (!state.codexTerminalView?.inputUnlocked) return false;
  return sendCodexTerminalControl(type, data);
}

function setCodexTerminalInputUnlocked(view, unlocked) {
  if (!view) return;
  const managed = view.mode === 'managed';
  view.inputUnlocked = !managed && Boolean(unlocked);
  view.shell.dataset.inputMode = view.inputUnlocked ? 'unlocked' : 'readonly';
  if (view.terminal?.options) view.terminal.options.disableStdin = !view.inputUnlocked;
  const toggle = view.shell.querySelector('[data-action="codex-cli-toggle-input"]');
  if (toggle) {
    toggle.checked = view.inputUnlocked;
    toggle.disabled = managed;
  }
  const label = view.shell.querySelector('[data-codex-cli-input-state]');
  if (label) label.textContent = tr(view.inputUnlocked ? 'cliInputUnlocked' : 'cliReadOnly');
  view.shell.querySelectorAll('[data-codex-cli-write-control]').forEach((control) => {
    control.disabled = !view.inputUnlocked;
  });
  if (view.inputUnlocked) view.terminal?.focus();
}

function codexTerminalReconnectDelay(attempt) {
  return Math.min(
    CODEX_TERMINAL_RECONNECT_MAX_MS,
    CODEX_TERMINAL_RECONNECT_BASE_MS * (2 ** Math.min(4, Math.max(0, Number(attempt) || 0))),
  );
}

function scheduleCodexTerminalReconnect(view, task) {
  if (state.codexTerminalView !== view || view.ended || view.reconnectTimer || document.hidden) return;
  updateCodexTerminalStatus(view, 'connecting', tr('cliConnecting'));
  const delay = codexTerminalReconnectDelay(view.reconnectAttempts);
  view.reconnectAttempts += 1;
  view.reconnectTimer = setTimeout(() => {
    view.reconnectTimer = null;
    if (state.codexTerminalView === view && !view.ended && !document.hidden) {
      if (view.mode === 'managed') connectManagedCodexTerminalSocket(view, task);
      else connectCodexTerminalSocket(view, task);
    }
  }, delay);
}

function resetManagedCodexTerminalOutput(view) {
  view.decoder = new TextDecoder();
  view.outputFormatter = createAttemptOutputFormatter(view.managedStream.outputFormat);
  view.outputPositioned = false;
  if (typeof view.terminal.reset === 'function') view.terminal.reset();
  else view.terminal.clear?.();
}

function positionManagedCodexTerminalOutput(view) {
  if (view.outputPositioned) return;
  view.outputPositioned = true;
  view.terminal.scrollToBottom?.();
}

function writeManagedCodexTerminalOutput(view, text, final = false) {
  const output = view.outputFormatter.push(text, final);
  if (!output) return;
  view.terminal.write(output, () => positionManagedCodexTerminalOutput(view));
}

function finishManagedCodexTerminal(view) {
  if (view.decoder) writeManagedCodexTerminalOutput(view, view.decoder.decode(), true);
  view.ended = true;
  updateCodexTerminalStatus(view, 'ended', tr('cliEnded'));
}

function connectManagedCodexTerminalSocket(view, task) {
  if (state.codexTerminalView !== view || view.ended || document.hidden) return;
  if (!view.managedStream?.webSocketUrl) {
    updateCodexTerminalStatus(view, 'connecting', tr(task.status || 'queued'));
    return;
  }
  let socket;
  try {
    socket = new globalThis.WebSocket(view.managedStream.webSocketUrl(view.offset));
  } catch {
    scheduleCodexTerminalReconnect(view, task);
    return;
  }
  socket.binaryType = 'arraybuffer';
  view.socket = socket;
  socket.addEventListener('open', () => {
    if (state.codexTerminalView !== view || view.socket !== socket) return;
    view.reconnectAttempts = 0;
    updateCodexTerminalStatus(view, 'connected', tr('cliConnected'));
  });
  socket.addEventListener('message', (event) => {
    if (state.codexTerminalView !== view || view.socket !== socket) return;
    if (typeof event.data !== 'string') {
      const bytes = new Uint8Array(event.data);
      writeManagedCodexTerminalOutput(view, view.decoder.decode(bytes, { stream: true }));
      view.offset += bytes.byteLength;
      return;
    }
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'ready' || message.type === 'reset') {
      const serverOffset = Math.max(0, Number(message.offset || 0));
      if (message.type === 'reset' || serverOffset < view.offset) resetManagedCodexTerminalOutput(view);
      view.offset = serverOffset;
      updateCodexTerminalStatus(view, 'connected', tr('cliConnected'));
      return;
    }
    if (message.type === 'status') {
      updateCodexTerminalStatus(view, 'connected', tr('cliConnected'));
      return;
    }
    if (message.type === 'end') {
      finishManagedCodexTerminal(view);
      return;
    }
    if (message.type === 'error') {
      try { socket.close(1011, 'Managed output stream failed'); } catch {}
    }
  });
  socket.addEventListener('error', () => {});
  socket.addEventListener('close', () => {
    if (view.socket !== socket) return;
    view.socket = null;
    scheduleCodexTerminalReconnect(view, task);
  });
}

function connectCodexTerminalSocket(view, task) {
  if (state.codexTerminalView !== view || view.ended || document.hidden) return;
  let socket;
  try {
    socket = new globalThis.WebSocket(codexTerminalSocketUrl(task.id, view.terminal));
  } catch {
    scheduleCodexTerminalReconnect(view, task);
    return;
  }
  socket.binaryType = 'arraybuffer';
  view.socket = socket;
  socket.addEventListener('open', () => {
    if (state.codexTerminalView !== view || view.socket !== socket) return;
    view.reconnectAttempts = 0;
    updateCodexTerminalStatus(view, 'connected', tr('cliConnected'));
  });
  socket.addEventListener('message', (event) => {
    if (state.codexTerminalView !== view || view.socket !== socket) return;
    if (typeof event.data !== 'string') {
      view.terminal.write(new Uint8Array(event.data));
      return;
    }
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'error') {
      view.ended = true;
      if (state.interactiveCodexTerminalTaskId === task.id) state.interactiveCodexTerminalTaskId = '';
      updateCodexTerminalStatus(view, 'error', tr('cliDisconnected'));
      const error = view.shell.querySelector('[data-codex-cli-error]');
      error.textContent = message.message || tr('cliDisconnected');
      error.classList.remove('hidden');
    } else if (message.type === 'status') {
      view.ended = message.state === 'ended';
      if (view.ended && state.interactiveCodexTerminalTaskId === task.id) {
        state.interactiveCodexTerminalTaskId = '';
      }
      updateCodexTerminalStatus(
        view,
        message.state,
        message.state === 'ended' ? tr('cliEnded') : tr('cliConnected'),
      );
    }
  });
  socket.addEventListener('close', () => {
    if (view.socket !== socket) return;
    view.socket = null;
    scheduleCodexTerminalReconnect(view, task);
  });
}

function initializeCodexTerminal(task, managedStream = null) {
  const shell = $('#taskConsoleOutput .codex-cli-shell');
  const host = shell?.querySelector?.('[data-codex-cli-host]');
  if (!shell || !host || typeof globalThis.Terminal !== 'function' || typeof globalThis.WebSocket !== 'function') {
    const error = shell?.querySelector?.('[data-codex-cli-error]');
    if (error) {
      error.textContent = 'Interactive terminal is not supported by this browser';
      error.classList.remove('hidden');
    }
    return;
  }
  disposeCodexTerminal();
  const managed = Boolean(managedStream);
  const fixedReplay = managedStream?.outputFormat === 'raw';
  const terminalOptions = {
    theme: TERMINAL_THEME,
    fontFamily: '"Courier New", "Noto Sans Mono CJK SC", monospace',
    fontSize: terminalFontSize(18),
    lineHeight: fixedReplay ? 1 : 1.2,
    cursorBlink: !managed,
    disableStdin: true,
    convertEol: false,
    scrollback: CODEX_CLI_SCROLLBACK_LINES,
  };
  if (fixedReplay) {
    terminalOptions.cols = managedStream.cols;
    terminalOptions.rows = managedStream.rows;
  }
  const terminal = new globalThis.Terminal(terminalOptions);
  const fitAddon = !fixedReplay && typeof globalThis.FitAddon?.FitAddon === 'function'
    ? new globalThis.FitAddon.FitAddon()
    : null;
  if (fitAddon) terminal.loadAddon(fitAddon);
  terminal.open(host);
  fitAddon?.fit();
  shell.dataset.terminalMode = fixedReplay ? 'fixed-replay' : (managed ? 'managed' : 'interactive');
  const view = {
    taskId: task.id,
    mode: managed ? 'managed' : 'interactive',
    managedStream,
    fixedReplay,
    shell,
    terminal,
    fitAddon,
    socket: null,
    resizeObserver: null,
    ended: false,
    inputUnlocked: false,
    reconnectAttempts: 0,
    reconnectTimer: null,
    offset: managed ? Number(managedStream.initialOffset || 0) : 0,
    decoder: null,
    outputFormatter: null,
    outputPositioned: false,
  };
  state.codexTerminalView = view;
  setCodexTerminalInputUnlocked(view, false);
  terminal.onData((data) => sendUnlockedCodexTerminalControl('input', { data }));
  if (managed) {
    resetManagedCodexTerminalOutput(view);
    connectManagedCodexTerminalSocket(view, task);
  } else {
    connectCodexTerminalSocket(view, task);
  }
  const fitAndNotify = () => {
    if (state.codexTerminalView !== view) return;
    fitAddon?.fit();
    if (!managed) sendCodexTerminalControl('resize', { cols: terminal.cols, rows: terminal.rows });
  };
  view.resizeObserver = !fixedReplay && typeof globalThis.ResizeObserver === 'function'
    ? new globalThis.ResizeObserver(fitAndNotify)
    : null;
  view.resizeObserver?.observe(host);
  requestAnimationFrame(fitAndNotify);
}

function externalAttemptExitCode(attempt) {
  const value = attempt?.result?.exitCode;
  if (value == null || !Number.isInteger(Number(value))) return null;
  return Number(value);
}

function externalAttemptTiming(attempt) {
  const meta = attempt?.result?.meta || {};
  const startedAt = meta.started_at || meta.startedAt || attempt.startedAt || '';
  const finishedAt = meta.ended_at || meta.endedAt || meta.finished_at || meta.finishedAt
    || (attempt?.result?.terminal ? (attempt.finishedAt || attempt.lastCheckedAt || '') : '');
  const platformConfirmedAt = attempt.lastCheckedAt || attempt.finishedAt || '';
  return { startedAt, finishedAt, platformConfirmedAt };
}

function timestampsDiffer(left, right) {
  if (!left || !right) return false;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs)) return Math.abs(leftMs - rightMs) >= 1000;
  return String(left) !== String(right);
}

function trackingTime(label, value) {
  if (!value) return '';
  return `<span>${escapeHtml(label)}</span><time datetime="${escapeHtml(value)}">${escapeHtml(formatTimelineTime(value))}</time>`;
}

function scheduledJobPresentation(job, externalAttemptsById) {
  const externalAttempt = externalAttemptsById.get(job.externalAttemptId);
  const backgroundFinishedBeforeCheck = job.status === 'cancelled'
    && job.lastError === TERMINAL_BACKGROUND_SCHEDULE_MESSAGE
    && EXTERNAL_ATTEMPT_TERMINAL_STATUSES.has(externalAttempt?.status);
  if (backgroundFinishedBeforeCheck) {
    return {
      badgeClass: 'completed',
      statusLabel: tr('checkNotNeeded'),
      detailLabel: tr('scheduleOutcome'),
      detail: tr('backgroundAlreadyFinished'),
    };
  }
  return {
    badgeClass: job.status,
    statusLabel: tr(job.status),
    detailLabel: tr('attemptError'),
    detail: job.lastError,
  };
}

function backgroundTrackingList(externalAttempts, scheduledJobs) {
  if (!externalAttempts.length && !scheduledJobs.length) {
    return `<div class="empty-state">${escapeHtml(tr('noBackground'))}</div>`;
  }
  const externalAttemptsById = new Map(externalAttempts.map((attempt) => [attempt.id, attempt]));
  const jobsByExternalAttempt = new Map();
  const unlinkedJobs = [];
  scheduledJobs.forEach((job) => {
    if (!externalAttemptsById.has(job.externalAttemptId)) {
      unlinkedJobs.push(job);
      return;
    }
    const jobs = jobsByExternalAttempt.get(job.externalAttemptId) || [];
    jobs.push(job);
    jobsByExternalAttempt.set(job.externalAttemptId, jobs);
  });

  const scheduledJobHtml = (job) => {
    const presentation = scheduledJobPresentation(job, externalAttemptsById);
    const primaryTimeLabel = job.finishedAt
      ? tr(job.status === 'cancelled' ? 'scheduleResolvedAt' : 'scheduledFinishedAt')
      : tr('scheduledDueAt');
    const primaryTime = job.finishedAt || job.dueAt;
    return `
    <article class="execution-item tracking-item tracking-schedule-item">
      <div class="execution-head">
        <div><strong>${escapeHtml(tr('scheduledCheck'))}</strong><code>${escapeHtml(job.id)}</code><span class="status-badge ${escapeHtml(presentation.badgeClass)}">${escapeHtml(presentation.statusLabel)}</span></div>
        <div class="tracking-primary-time">${trackingTime(primaryTimeLabel, primaryTime)}</div>
      </div>
      <div class="execution-meta">
        ${job.externalAttemptId ? `<span>${escapeHtml(tr('linkedBackground'))} <code>${escapeHtml(job.externalAttemptId)}</code></span>` : ''}
        <span>${escapeHtml(tr('generation'))} #${Number(job.generation || 0)}.${Number(job.sequence || 0)}</span>
        <span>${escapeHtml(tr('scheduleAttempts'))} ${Number(job.attemptCount || 0)} / ${Number(job.maxAttempts || 0)}</span>
        ${job.finishedAt && job.dueAt ? `<span>${escapeHtml(tr('scheduledDueAt'))} <time datetime="${escapeHtml(job.dueAt)}">${escapeHtml(formatTimelineTime(job.dueAt))}</time></span>` : ''}
        ${job.commandId ? `<span>COMMAND <code>${escapeHtml(job.commandId)}</code></span>` : ''}
      </div>
      ${job.skills?.length ? `<div class="attribution-chips">${skillChipsHtml(job.skills)}</div>` : ''}
      ${presentation.detail ? `<div class="execution-context"><span>${escapeHtml(presentation.detailLabel)}</span><p>${escapeHtml(presentation.detail)}</p></div>` : ''}
    </article>`;
  };

  const attempts = externalAttempts.map((attempt) => {
    const exitCode = externalAttemptExitCode(attempt);
    const timing = externalAttemptTiming(attempt);
    const primaryTimeLabel = timing.finishedAt ? tr('processFinishedAt') : tr('processStartedAt');
    const primaryTime = timing.finishedAt || timing.startedAt;
    const platformConfirmation = timestampsDiffer(timing.finishedAt, timing.platformConfirmedAt)
      ? `<span>${escapeHtml(tr('platformConfirmedAt'))} <time datetime="${escapeHtml(timing.platformConfirmedAt)}">${escapeHtml(formatTimelineTime(timing.platformConfirmedAt))}</time></span>`
      : '';
    const executionTitle = isPytestCommand(attempt.command) ? tr('backgroundPytestExecution') : tr('externalExecution');
    const archiveStatus = attempt.archiveStatus === 'archived' ? tr('logArchived') : (attempt.archiveStatus || 'pending');
    const linkedJobs = (jobsByExternalAttempt.get(attempt.id) || []).map(scheduledJobHtml).join('');
    return `
    <section class="tracking-chain">
      <article class="execution-item tracking-item tracking-attempt-item">
        <div class="execution-head">
          <div><strong>${escapeHtml(executionTitle)}</strong><code>${escapeHtml(attempt.id)}</code><span class="status-badge ${escapeHtml(attempt.status)}">${escapeHtml(tr(attempt.status))}</span></div>
          <div class="tracking-primary-time">${trackingTime(primaryTimeLabel, primaryTime)}</div>
        </div>
        <div class="execution-meta">
          <span>${escapeHtml(tr('generation'))} #${Number(attempt.generation || 0)}</span>
          <span>${escapeHtml(tr('pid'))} <code>${attempt.pid == null ? '-' : Number(attempt.pid)}</code></span>
          <span>${escapeHtml(tr('exitCode'))} <code>${exitCode == null ? '-' : exitCode}</code></span>
          <span>${escapeHtml(tr('interval'))} ${Number(attempt.checkIntervalSeconds || 0)}s</span>
          <span>${escapeHtml(tr('archivePreservation'))} <code>${escapeHtml(archiveStatus)}</code></span>
          ${timing.finishedAt && timing.startedAt ? `<span>${escapeHtml(tr('processStartedAt'))} <time datetime="${escapeHtml(timing.startedAt)}">${escapeHtml(formatTimelineTime(timing.startedAt))}</time></span>` : ''}
          ${platformConfirmation}
        </div>
        ${attempt.skills?.length ? `<div class="attribution-chips">${skillChipsHtml(attempt.skills)}</div>` : ''}
        <div class="execution-context tracking-paths">
          <span>${escapeHtml(tr('commandPath'))}</span><code>${escapeHtml(attempt.commandPath || '-')}</code>
          <span>${escapeHtml(tr('logPath'))}</span><code>${escapeHtml(attempt.logPath || '-')}</code>
          <span>${escapeHtml(tr('donePath'))}</span><code>${escapeHtml(attempt.donePath || '-')}</code>
          <span>${escapeHtml(tr('statePath'))}</span><code>${escapeHtml(attempt.statePath || '-')}</code>
        </div>
        ${attempt.command ? `<div class="command-audit">${executionCommandDetails(attempt.command, 'business-command', attempt.id)}</div>` : ''}
        ${attempt.archivedLogSha256 ? `<div class="execution-context"><span>${escapeHtml(tr('archiveBytes'))}</span><code>${Number(attempt.archivedLogBytes || 0)}</code><span>${escapeHtml(tr('archiveSha256'))}</span><code>${escapeHtml(attempt.archivedLogSha256)}</code></div>` : ''}
        ${attempt.archiveError ? `<div class="execution-context"><span>${escapeHtml(tr('archiveError'))}</span><p>${escapeHtml(attempt.archiveError)}</p></div>` : ''}
        <a class="button secondary small tracking-log-link" target="_blank" rel="noopener" href="/api/sessions/${encodeURIComponent(state.currentTaskId)}/external-attempts/${encodeURIComponent(attempt.id)}/log">${escapeHtml(tr('viewFullLog'))}</a>
        ${attempt.lastObservation ? `<div class="execution-context"><span>${escapeHtml(tr('lastObservation'))}</span><p>${escapeHtml(attempt.lastObservation)}</p></div>` : ''}
      </article>
      ${linkedJobs}
    </section>`;
  }).join('');
  const jobs = unlinkedJobs.map(scheduledJobHtml).join('');
  return `<div class="execution-list tracking-list">${attempts}${jobs}</div>`;
}

function renderRuntime() {
  const runtime = state.dashboard.runtime || {};
  const backendReady = runtime.ready == null
    ? Boolean(runtime.bridgeAvailable && runtime.workerAvailable
      && runtime.executionUserSafe !== false && runtime.workspace?.available)
    : Boolean(runtime.ready);
  const ready = !state.dashboardUnavailable && backendReady;
  $('#runtimeDot').classList.toggle('ready', ready);
  $('#runtimeState').textContent = state.dashboardUnavailable
    ? tr('runtimeConnectionIssue')
    : (ready ? tr('runtimeReady') : tr('runtimeMissing'));
  const activeTasks = Number(runtime.workerActive || 0);
  const apiRequests = state.dashboard.apiRequests || {};
  const apiCapacity = apiRequests.maxConcurrency
    ? ` · ${tr('apiRequests')} ${apiRequests.active || 0}/${apiRequests.maxConcurrency}`
    : '';
  const logStreams = state.dashboard.logStreams || {};
  const logCapacity = logStreams.maxConcurrency
    ? ` · ${tr('logStreams')} ${logStreams.active || 0}/${logStreams.maxConcurrency}`
    : '';
  const permission = runtime.permissionMode === 'danger-full-access' ? ` · ${tr('fullAccess')}` : '';
  $('#runtimeMeta').textContent = state.dashboardUnavailable
    ? tr('runtimeReconnecting')
    : `Worker ${activeTasks} ${tr('working')} · ${runtime.skillsMounted || 0} Skills${apiCapacity}${logCapacity}${permission}`;
  const backendReasonCodes = Array.isArray(runtime.degradedReasons)
    ? [...new Set(runtime.degradedReasons.map((reason) => String(reason || '').trim()).filter(Boolean))]
    : [];
  const reasonCodes = state.dashboardUnavailable ? ['dashboard_unavailable'] : backendReasonCodes;
  const reasons = reasonCodes.length
    ? reasonCodes.map((code) => ({ code, label: tr(RUNTIME_REASON_KEYS[code] || code) }))
    : [{ code: '', label: tr('runtimeMissing') }];
  $('#runtimeMeta').title = ready ? '' : reasons.map((reason) => reason.label).join(' · ');
  $('#runtimeAlert').classList.toggle('hidden', ready);
  $('#runtimeAlert').classList.toggle('connection-lost', state.dashboardUnavailable);
  $('#runtimeAlertTitle').textContent = ready
    ? ''
    : tr(state.dashboardUnavailable ? 'runtimeConnectionIssue' : 'runtimePaused');
  renderHtml('runtimeReasons', '#runtimeReasons', ready ? '' : reasons.map((reason) => `
    <li><span>${escapeHtml(reason.label)}</span>${reason.code ? `<code>${escapeHtml(reason.code)}</code>` : ''}</li>`).join(''));
}

function renderMetrics() {
  const stats = state.dashboard.stats || {};
  const metrics = [
    ['current', stats.currentSessions || 0],
    ['working', stats.activeSessions || 0],
    ['history', stats.completedSessions || 0],
    ['skills', stats.skills || 0],
  ];
  renderHtml('metrics', '#metricGrid', metrics.map(([label, value]) => `
    <div class="metric"><span>${escapeHtml(tr(label))}</span><strong>${Number(value)}</strong></div>`).join(''));
}

function overviewBusinessHtml(business, tasks, standaloneLimit) {
  const standalone = tasks.filter((task) => task.taskOrigin !== 'release-cycle');
  const cycles = new Map();
  for (const task of tasks.filter((item) => item.taskOrigin === 'release-cycle')) {
    const key = task.releaseCycleId || task.releaseKey || 'cycle';
    if (!cycles.has(key)) cycles.set(key, { name: task.releaseCycleName || task.releaseKey || key, releaseKey: task.releaseKey || '', status: task.releaseCycleStatus || '', tasks: [] });
    cycles.get(key).tasks.push(task);
  }
  const featureCount = tasks.filter((task) => task.testType === 'feature').length;
  const regressionCount = tasks.length - featureCount;
  const standaloneHtml = standalone.length
    ? `<section class="overview-origin-section"><header class="overview-origin-head"><div><span class="section-label">${escapeHtml(tr('standaloneTask'))}</span><h3>${escapeHtml(tr('overviewStandaloneHint'))}</h3></div><span class="overview-section-count">${standalone.length}</span></header><div class="task-grid overview-task-group-grid">${standalone.slice(0, standaloneLimit).map((task) => taskCard(task, 'grid')).join('')}</div>${standalone.length > standaloneLimit ? `<p class="overview-more-note">${escapeHtml(trf('overviewMoreTasks', { count: standalone.length - standaloneLimit }))}</p>` : ''}</section>`
    : '';
  const cycleHtml = cycles.size
    ? `<section class="overview-origin-section"><header class="overview-origin-head"><div><span class="section-label">${escapeHtml(tr('releaseCycleTask'))}</span><h3>${escapeHtml(tr('overviewCycleHint'))}</h3></div><span class="overview-section-count">${cycles.size}</span></header><div class="overview-cycle-list">${[...cycles.values()].map((cycle) => {
      const cycleFeature = cycle.tasks.filter((task) => task.testType === 'feature').length;
      const cycleRegression = cycle.tasks.length - cycleFeature;
      const cycleId = cycle.tasks[0]?.releaseCycleId || cycle.releaseKey;
      return `<button type="button" class="overview-cycle-card" data-action="open-overview-cycle" data-cycle-id="${escapeHtml(cycleId)}" data-business="${escapeHtml(business)}"><span><strong>${escapeHtml(cycle.name)}</strong><code>${escapeHtml(cycle.releaseKey)}</code></span><span class="overview-cycle-stats"><span class="task-test-type feature">${escapeHtml(tr('featureTest'))} ${cycleFeature}</span><span class="task-test-type regression">${escapeHtml(tr('regressionTest'))} ${cycleRegression}</span><b>${cycle.tasks.length}</b></span><span class="overview-cycle-open">↗</span></button>`;
    }).join('')}</div></section>`
    : '';
  return `<section class="overview-business-group"><header class="overview-business-head"><div><span class="section-label">${escapeHtml(tr('businessResult'))}</span><h2>${escapeHtml(business)}</h2></div><div class="overview-business-stats"><span>${escapeHtml(tr('taskCountLabel'))} ${tasks.length}</span><span class="task-test-type feature">${escapeHtml(tr('featureTest'))} ${featureCount}</span><span class="task-test-type regression">${escapeHtml(tr('regressionTest'))} ${regressionCount}</span></div></header>${standaloneHtml}${cycleHtml}</section>`;
}

function overviewTaskGroupsHtml(tasks, limit) {
  const businesses = new Map();
  for (const task of tasks) {
    const business = String(task.project || 'cloudRecord');
    if (!businesses.has(business)) businesses.set(business, []);
    businesses.get(business).push(task);
  }
  return `<div class="overview-business-list">${[...businesses.entries()].map(([business, members]) => overviewBusinessHtml(business, members, limit)).join('')}</div>`;
}

function overviewCycleLocalTasks(cycleId, business) {
  return sortTasksForDisplay((state.dashboard.sessions || []).filter((task) => (
    task.taskOrigin === 'release-cycle'
      && String(task.project || 'cloudRecord') === String(business || '')
      && String(task.releaseCycleId || task.releaseKey || '') === String(cycleId || '')
  )));
}

function overviewCycleTaskTrend(tasks) {
  return tasks.flatMap((task, index) => {
    const initial = task.testProgress?.runs?.initial;
    const rerun = task.testProgress?.runs?.rerun1;
    if (!initial?.resultKnown || !rerun?.resultKnown) return [];
    const initialDenominator = Number(initial.passed || 0) + Number(initial.failed || 0);
    const rerunDenominator = Number(rerun.passed || 0) + Number(rerun.failed || 0);
    if (!initialDenominator || !rerunDenominator) return [];
    return [{
      taskId: task.id,
      name: task.name,
      testType: task.testType || 'regression',
      analysisStatus: 'comparable',
      seriesRunSequence: Number(task.seriesRunSequence || index + 1),
      scheduledFor: task.scheduledFor || task.createdAt,
      initialPassRate: Number(initial.passed || 0) / initialDenominator,
      initialFailRate: Number(initial.failed || 0) / initialDenominator,
      targetInitialPassRate: Number(initial.passed || 0) / initialDenominator,
      targetInitialFailRate: Number(initial.failed || 0) / initialDenominator,
      rerunPassRate: Number(rerun.passed || 0) / rerunDenominator,
      rerunFailRate: Number(rerun.failed || 0) / rerunDenominator,
    }];
  });
}

function overviewCycleAnalysisHtml(tasks, analysis, loading) {
  if (loading) return `<section class="overview-cycle-analysis-panel is-loading"><span class="section-label">${escapeHtml(tr('releaseCycleAnalysis'))}</span><p>${escapeHtml(tr('releaseCycleAnalysisLoading'))}</p></section>`;
  const serverTrend = Array.isArray(analysis?.trend) ? analysis.trend : [];
  const trend = serverTrend.length ? serverTrend : overviewCycleTaskTrend(tasks);
  const summary = analysis?.summary || {};
  const comparable = Number(summary.comparableTaskCount || trend.length);
  const chart = releaseCycleTrendChartHtml(trend);
  const initialPass = analysisRate(summary.initial?.passRate ?? (trend.length ? trend.reduce((sum, item) => sum + Number(item.initialPassRate || 0), 0) / trend.length : null));
  const rerunPass = analysisRate(summary.rerun?.passRate ?? (trend.length ? trend.reduce((sum, item) => sum + Number(item.rerunPassRate || 0), 0) / trend.length : null));
  return `<section class="overview-cycle-analysis-panel"><header class="overview-cycle-analysis-head"><div><span class="section-label">${escapeHtml(tr('releaseCycleAnalysis'))}</span><h3>${escapeHtml(tr('releaseCycleAnalysisHint'))}</h3></div><span class="status-badge ${trend.length ? 'completed' : 'pending'}">${comparable} ${escapeHtml(tr('analysisComparable'))}</span></header><div class="overview-cycle-analysis-metrics"><div><span>${escapeHtml(tr('analysisInitialPass'))}</span><strong>${initialPass}</strong></div><div><span>${escapeHtml(tr('analysisRerunPass'))}</span><strong>${rerunPass}</strong></div><div><span>${escapeHtml(tr('analysisRecovered'))}</span><strong>${analysis?.summary?.transitions?.recovered == null ? '-' : Number(analysis.summary.transitions.recovered)}</strong></div><div><span>${escapeHtml(tr('analysisPersistent'))}</span><strong>${analysis?.summary?.transitions?.persistent == null ? '-' : Number(analysis.summary.transitions.persistent)}</strong></div></div>${chart || `<p class="overview-cycle-analysis-empty">${escapeHtml(tr('analysisNoTrend'))}</p>`}</section>`;
}

function renderOverviewReleaseCycleModal() {
  const modal = state.overviewCycleModal;
  const body = $('#overviewReleaseCycleModalBody');
  if (!body) return;
  const tasks = modal.tasks || [];
  const first = tasks[0] || overviewCycleLocalTasks(modal.cycleId, modal.business)[0];
  if (first) $('#overviewReleaseCycleModalTitle').textContent = first.releaseCycleName || first.releaseKey || modal.cycleId;
  if (modal.loading) {
    body.innerHTML = `<p class="inline-note overview-release-cycle-loading">${escapeHtml(tr('overviewCycleLoading'))}</p>`;
    return;
  }
  if (!tasks.length) {
    body.innerHTML = `<div class="empty-state">${escapeHtml(tr('noCurrentTasks'))}</div>`;
    return;
  }
  const page = modal.page + 1;
  const pageControls = `<nav class="overview-release-cycle-pagination" aria-label="${escapeHtml(tr('releaseCycleTask'))}"><button class="button secondary small" type="button" data-action="overview-cycle-page" data-page="${modal.page - 1}"${modal.page === 0 ? ' disabled' : ''}>${escapeHtml(tr('overviewCyclePrevious'))}</button><span>${escapeHtml(trf('overviewCyclePage', { page, count: tasks.length }))}</span><button class="button secondary small" type="button" data-action="overview-cycle-page" data-page="${modal.page + 1}"${modal.hasMore ? '' : ' disabled'}>${escapeHtml(tr('overviewCycleNext'))}</button></nav>`;
  const featureCount = tasks.filter((task) => task.testType === 'feature').length;
  const regressionCount = tasks.length - featureCount;
  body.innerHTML = `<div class="overview-release-cycle-modal-summary"><span>${escapeHtml(first?.releaseKey || '')}</span><span class="task-test-type feature">${escapeHtml(tr('featureTest'))} ${featureCount}</span><span class="task-test-type regression">${escapeHtml(tr('regressionTest'))} ${regressionCount}</span></div>${overviewCycleAnalysisHtml(tasks, modal.analysis, modal.analysisLoading)}<div class="overview-cycle-task-section"><header class="overview-cycle-task-section-head"><div><span class="section-label">${escapeHtml(tr('releaseCycleTask'))}</span><h3>${escapeHtml(tr('overviewCycleHint'))}</h3></div><span class="overview-section-count">${tasks.length}</span></header><div class="task-grid overview-release-cycle-task-grid">${tasks.map((task) => taskCard(task, 'grid')).join('')}</div></div>${pageControls}`;
}

async function openOverviewReleaseCycle(cycleId, business, page = 0) {
  const normalizedPage = Math.max(0, Number(page) || 0);
  const pageSize = state.overviewCycleModal.pageSize;
  const requestVersion = ++state.overviewCycleModalRequestVersion;
  state.overviewCycleModal = {
    ...state.overviewCycleModal,
    cycleId: String(cycleId || ''), business: String(business || ''), page: normalizedPage,
    tasks: [], hasMore: false, loading: true, analysis: normalizedPage === 0 ? null : state.overviewCycleModal.analysis, analysisLoading: normalizedPage === 0,
  };
  openModal('overviewReleaseCycleModal');
  renderOverviewReleaseCycleModal();
  try {
    const [response, analysis] = await Promise.all([
      api(`/api/release-cycles/${encodeURIComponent(cycleId)}/tasks?limit=${pageSize + 1}&offset=${normalizedPage * pageSize}`),
      normalizedPage === 0
        ? api(`/api/release-cycles/${encodeURIComponent(cycleId)}/analysis?testType=all`).catch(() => null)
        : Promise.resolve(state.overviewCycleModal.analysis),
    ]);
    if (requestVersion !== state.overviewCycleModalRequestVersion) return;
    const tasks = Array.isArray(response) ? response : [];
    state.overviewCycleModal.tasks = tasks.slice(0, pageSize);
    state.overviewCycleModal.hasMore = tasks.length > pageSize;
    state.overviewCycleModal.analysis = analysis;
  } catch (error) {
    if (requestVersion !== state.overviewCycleModalRequestVersion) return;
    const localTasks = overviewCycleLocalTasks(cycleId, business);
    state.overviewCycleModal.tasks = localTasks.slice(normalizedPage * pageSize, (normalizedPage + 1) * pageSize);
    state.overviewCycleModal.hasMore = localTasks.length > (normalizedPage + 1) * pageSize;
    if (!state.overviewCycleModal.tasks.length) toast(error.message, 'error');
  } finally {
    if (requestVersion !== state.overviewCycleModalRequestVersion) return;
    state.overviewCycleModal.loading = false;
    state.overviewCycleModal.analysisLoading = false;
    renderOverviewReleaseCycleModal();
  }
}

function renderOverview() {
  const tasks = sortTasksForDisplay(state.dashboard.sessions || []);
  const current = tasks.filter((task) => task.status !== 'completed');
  const history = tasks.filter((task) => task.status === 'completed');
  renderHtml('overviewTasks', '#overviewTaskGrid', current.length
    ? overviewTaskGroupsHtml(current, 8)
    : `<div class="empty-state span-all">${escapeHtml(tr('noCurrentTasks'))}</div>`);
  renderHtml('overviewHistory', '#overviewHistoryList', history.length
    ? history.slice(0, 6).map(historyRow).join('')
    : `<div class="empty-state">${escapeHtml(tr('noHistory'))}</div>`);
  renderHtml('overviewAudit', '#overviewAuditList', eventList((state.dashboard.recentAudit || []).slice(0, 8)));
}

function filteredTasks() {
  const tasks = state.dashboard.sessions || [];
  return sortTasksForDisplay(tasks.filter((task) => {
    if (state.taskFilter === 'history' && task.status !== 'completed') return false;
    if (state.taskFilter === 'running' && !isActiveTask(task)) return false;
    if (state.taskFilter === 'current' && task.status === 'completed') return false;
    if (state.taskProjectFilter && (task.project || 'cloudRecord') !== state.taskProjectFilter) return false;
    if (state.taskTagFilter && !(task.tags || []).includes(state.taskTagFilter)) return false;
    if (state.taskTestTypeFilter && (task.testType || 'regression') !== state.taskTestTypeFilter) return false;
    if (state.taskOriginFilter && (task.taskOrigin || 'standalone') !== state.taskOriginFilter) return false;
    return true;
  }));
}

function renderTasks() {
  renderTaskClassificationFilters();
  const tasks = filteredTasks();
  $('#taskListCount').textContent = trf('taskListCount', { count: tasks.length });
  const historyMode = state.taskFilter === 'history';
  $('#taskGrid').classList.toggle('history-mode', historyMode);
  if (!tasks.length) {
    const emptyKey = state.taskProjectFilter || state.taskTagFilter || state.taskTestTypeFilter || state.taskOriginFilter
      ? 'noFilteredTasks' : (historyMode ? 'noHistory' : 'noCurrentTasks');
    renderHtml('tasks', '#taskGrid', `<div class="empty-state span-all">${escapeHtml(tr(emptyKey))}</div>`);
    $('#loadMoreTasksBtn').classList.add('hidden');
    return;
  }
  renderHtml('tasks', '#taskGrid', historyMode ? tasks.map(historyRow).join('') : tasks.map((task) => taskCard(task)).join(''));
  $('#loadMoreTasksBtn').classList.toggle('hidden', !(state.dashboard.taskPage?.hasMore) || state.taskLimit >= state.taskLimitMax);
}

function renderSkills() {
  if (!state.skills.length) {
    renderHtml('skills', '#skillGrid', `<div class="empty-state">${escapeHtml(tr('noSkills'))}</div>`);
    return;
  }
  renderHtml('skills', '#skillGrid', state.skills.map((skill) => `
    <article class="skill-card ${skill.enabled ? '' : 'disabled'}">
      <div class="skill-head"><span class="skill-glyph">S</span><div class="skill-badges"><span class="status-badge ${skill.enabled ? 'completed' : 'disabled'}">${escapeHtml(tr(skill.enabled ? 'enabled' : 'disabled'))}</span><span class="source-badge ${escapeHtml(skill.origin)}">${escapeHtml(tr(skill.origin === 'codex' ? 'sourceCodex' : 'sourceManaged'))}</span></div></div>
      <h3>${escapeHtml(skill.name)}</h3>
      <p>${escapeHtml(skill.description || '-')}</p>
      <div class="tag-row">${(skill.tags || []).slice(0, 4).map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>
      <div class="skill-meta"><code>${escapeHtml(skill.id)}</code><span>${Number(skill.fileCount || 1)} ${escapeHtml(tr('files'))} · v${Number(skill.version || 1)}</span></div>
      <div class="skill-foot">
        <button class="button secondary small" data-action="edit-skill" data-id="${escapeHtml(skill.id)}">${escapeHtml(skill.readOnly ? tr('open') : tr('edit'))}</button>
        <div class="skill-actions"><button class="button secondary small" data-action="toggle-skill" data-id="${escapeHtml(skill.id)}" data-enabled="${skill.enabled ? 'false' : 'true'}">${escapeHtml(tr(skill.enabled ? 'disable' : 'enable'))}</button>${skill.readOnly ? '' : `<button class="button danger small" data-action="delete-skill" data-id="${escapeHtml(skill.id)}">${escapeHtml(tr('delete'))}</button>`}</div>
      </div>
    </article>`).join(''));
}

function renderAudit() {
  renderHtml('audit', '#auditList', eventList(state.audit || []));
  $('#newerAuditBtn').classList.toggle('hidden', state.auditOffset === 0);
  $('#loadMoreAuditBtn').classList.toggle('hidden', !state.auditHasOlder);
}

function protectionCard(index, title, status, details) {
  return `<article class="protection-card ${status.className}">
    <div class="protection-head">
      <span class="protection-index">${String(index).padStart(2, '0')}</span>
      <h3>${escapeHtml(title)}</h3>
      <span class="protection-state">${escapeHtml(tr(status.label))}</span>
    </div>
    <dl>${details.map(([label, value]) => `<div><dt>${escapeHtml(tr(label))}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>
  </article>`;
}

function hasUnrecoveredProtectionError(value) {
  if (!value?.lastError) return false;
  const lastErrorAt = Date.parse(value.lastErrorAt || '');
  const lastSuccessAt = Date.parse(value.lastSuccessAt || '');
  return !Number.isFinite(lastErrorAt)
    || !Number.isFinite(lastSuccessAt)
    || lastErrorAt >= lastSuccessAt;
}

function protectionPackageStatus(value, countField, unreadableField) {
  const pendingAudit = Number(value?.unrecordedAuditEventCount || 0);
  const unreadable = Number(value?.[unreadableField] || 0);
  if (hasUnrecoveredProtectionError(value)
    || unreadable > 0 || pendingAudit > 0 || value?.auditQueueDurable === false) {
    return { className: 'error', label: 'protectionDegraded' };
  }
  if (value?.inProgress) return { className: 'warning', label: 'protectionInProgress' };
  if (Number(value?.retentionExcessCount || 0) > 0) {
    return { className: 'warning', label: 'protectionRotationPending' };
  }
  if (!value?.lastSuccessAt || Number(value?.[countField] || 0) === 0) {
    return { className: 'pending', label: 'protectionPending' };
  }
  return { className: 'healthy', label: 'protectionHealthy' };
}

function protectionPackageDetails(value, countField, unreadableField) {
  const count = Number(value?.[countField] || 0);
  const retention = Number(value?.retention || 0);
  const excess = Number(value?.retentionExcessCount || 0);
  const unreadable = Number(value?.[unreadableField] || 0);
  const pendingAudit = Number(value?.unrecordedAuditEventCount || 0);
  const auditError = String(value?.lastOutboxError || value?.lastAuditError || '');
  const packageParts = [`${count} / ${retention}`];
  if (excess > 0) packageParts.push(trf('rotationPendingDetail', { count: excess }));
  const details = [
    ['lastSuccess', formatTime(value?.lastSuccessAt)],
    ['nextRun', value?.inProgress ? tr('protectionInProgress') : formatTime(value?.nextRunAt)],
    ['packageRetention', packageParts.join(' · ')],
    ['auditContinuity', pendingAudit > 0 || value?.auditQueueDurable === false
      ? [trf('auditPending', { count: pendingAudit }), auditError].filter(Boolean).join(' · ')
      : tr('auditHealthy')],
  ];
  if (unreadable > 0) details.push(['unreadablePackages', String(unreadable)]);
  if (hasUnrecoveredProtectionError(value)) details.push(['schedulerError', String(value.lastError)]);
  return details;
}

function renderProtectionStatus() {
  const meta = $('#protectionMeta');
  const metaError = Boolean(state.protectionError);
  meta.textContent = metaError
    ? trf('protectionRefreshFailed', { error: state.protectionError })
    : (state.protectionCheckedAt
      ? trf('protectionChecked', { time: formatTime(state.protectionCheckedAt) })
      : (state.protectionLoading ? tr('loadingProtection') : tr('noProtectionStatus')));
  meta.classList.toggle('error', metaError);
  if (state.protectionLoading && !state.protectionLoaded) {
    renderHtml('protection', '#protectionGrid', `<div class="inventory-loading" role="status"><div class="loading-bar"></div><span>${escapeHtml(tr('loadingProtection'))}</span></div>`);
    updateRuntimeRefreshButton();
    return;
  }
  const health = state.protectionStatus;
  if (!state.protectionLoaded || !health) {
    renderHtml('protection', '#protectionGrid', `<div class="empty-state">${escapeHtml(tr('noProtectionStatus'))}</div>`);
    updateRuntimeRefreshButton();
    return;
  }
  const violations = Object.values(health.state?.violations || {})
    .reduce((total, value) => total + Number(value || 0), 0);
  const capacityTargets = Array.isArray(health.runtime?.storageCapacity?.targets)
    ? health.runtime.storageCapacity.targets.filter((target) => Number.isFinite(Number(target.availablePercent)))
    : [];
  const lowestCapacity = capacityTargets.sort((left, right) => Number(left.availablePercent) - Number(right.availablePercent))[0];
  const storageHealthy = health.storage?.ok === true
    && health.state?.ok === true
    && health.runtime?.storageCapacity?.ok !== false;
  const storageStatus = storageHealthy
    ? { className: 'healthy', label: 'protectionHealthy' }
    : { className: 'error', label: 'protectionDegraded' };
  const storageDetails = [
    ['sqliteCheck', String(health.storage?.quickCheck || '-')],
    ['stateInvariants', violations > 0 ? trf('invariantIssues', { count: violations }) : tr('protectionHealthy')],
    ['storageHeadroom', lowestCapacity
      ? trf('storageAvailable', {
        percent: Number(lowestCapacity.availablePercent).toLocaleString(state.lang === 'zh' ? 'zh-CN' : 'en-US', { maximumFractionDigits: 1 }),
        bytes: formatBytes(lowestCapacity.availableBytes),
      })
      : '-'],
  ];
  const archives = health.externalLogArchives || {};
  const archiveFailureCount = Number(
    archives.failures ?? Math.max(Number(archives.failed || 0), Number(archives.verificationFailed || 0)),
  );
  const archiveActive = Number(archives.archiving || 0) + Number(archives.verifying || 0);
  const archiveStatus = archiveFailureCount > 0 || archives.ok === false
    ? { className: 'error', label: 'protectionDegraded' }
    : (archiveActive > 0
      ? { className: 'progress', label: 'protectionInProgress' }
      : { className: 'healthy', label: 'protectionHealthy' });
  const archiveDetails = [
    ['archiveCoverage', trf('archiveCoverageDetail', {
      archived: Number(archives.archived || 0), total: Number(archives.total || 0),
    })],
    ['archiveLastVerified', archives.lastVerifiedAt ? formatTime(archives.lastVerifiedAt) : tr('protectionPending')],
    ['archiveFailures', archiveFailureCount > 0
      ? trf('archiveFailureDetail', { count: archiveFailureCount })
      : tr('protectionHealthy')],
  ];
  renderHtml('protection', '#protectionGrid', [
    protectionCard(1, tr('platformStorage'), storageStatus, storageDetails),
    protectionCard(2, tr('databaseBackup'), protectionPackageStatus(health.backups, 'backupCount', 'unreadableBackupCount'), protectionPackageDetails(health.backups, 'backupCount', 'unreadableBackupCount')),
    protectionCard(3, tr('recoveryCheckpoint'), protectionPackageStatus(health.recoveryCheckpoints, 'checkpointCount', 'unreadableCheckpointCount'), protectionPackageDetails(health.recoveryCheckpoints, 'checkpointCount', 'unreadableCheckpointCount')),
    protectionCard(4, tr('terminalLogArchive'), archiveStatus, archiveDetails),
  ].join(''));
  updateRuntimeRefreshButton();
}

function updateRuntimeRefreshButton() {
  $('#refreshBridgeInventoryBtn').disabled = state.bridgeInventoryLoading || state.protectionLoading;
}

function bridgeCategory(category) {
  const categories = {
    task_owned: ['bridgeCategoryTaskOwned', 'task-owned'],
    completed_retained: ['bridgeCategoryCompletedRetained', 'completed-retained'],
    orphan: ['bridgeCategoryOrphan', 'orphan'],
    cleanup_queued: ['bridgeCategoryCleanupQueued', 'cleanup-queued'],
    cleanup_inconsistent: ['bridgeCategoryCleanupInconsistent', 'cleanup-inconsistent'],
    unsafe: ['bridgeCategoryUnsafe', 'unsafe'],
  };
  return categories[category] || categories.unsafe;
}

function bridgeResourceList(resources = {}) {
  const definitions = [
    ['record', 'resourceRecord'],
    ['codexHome', 'resourceCodexHome'],
    ['workspace', 'resourceWorkspace'],
    ['chatfile', 'resourceChatfile'],
    ['workspaceLock', 'resourceWorkspaceLock'],
    ['sessionRunLock', 'resourceSessionRunLock'],
  ];
  return definitions.map(([field, label]) => {
    const present = resources[field] === true;
    return `<span class="inventory-resource ${present ? 'present' : 'missing'}" title="${escapeHtml(tr(present ? 'resourcePresent' : 'resourceMissing'))}"><i aria-hidden="true"></i>${escapeHtml(tr(label))}</span>`;
  }).join('');
}

function bridgeInventoryRow(session) {
  const [categoryLabel, categoryClass] = bridgeCategory(session.category);
  const taskStatus = session.taskStatus
    ? `<span class="status-badge ${escapeHtml(session.taskStatus)}">${escapeHtml(tr(session.taskStatus))}</span>`
    : '';
  const owner = session.taskId || tr('noTaskOwner');
  const lastRun = session.lastRunAt ? formatTime(session.lastRunAt) : tr('neverRun');
  return `
    <article class="inventory-row ${categoryClass}">
      <div class="inventory-identity">
        <span class="inventory-safety" aria-hidden="true"></span>
        <div><code>${escapeHtml(session.sessionId)}</code><span class="inventory-category ${categoryClass}">${escapeHtml(tr(categoryLabel))}</span>${session.error ? `<small class="inventory-error">${escapeHtml(session.error)}</small>` : ''}</div>
      </div>
      <div class="inventory-owner">
        <span class="inventory-label">${escapeHtml(tr('taskOwner'))}</span>
        <strong>${escapeHtml(owner)}</strong>
        ${taskStatus}
      </div>
      <div class="inventory-resources">${bridgeResourceList(session.resources)}</div>
      <div class="inventory-usage">
        <strong>${escapeHtml(formatBytes(session.bytes))}</strong>
        <span><b>${escapeHtml(tr('lastRun'))}</b>${escapeHtml(lastRun)}</span>
      </div>
      <div class="inventory-action">
        ${session.reclaimable ? `<button class="button secondary small" data-action="reclaim-bridge-session" data-id="${escapeHtml(session.sessionId)}"${state.bridgeReclaimSubmitting ? ' disabled' : ''}>${escapeHtml(tr('reclaimRuntimeOnly'))}</button>` : ''}
      </div>
    </article>`;
}

function taskStorageRow(task) {
  const measurements = [
    ['inventoryBytes', task.runtimeBytes], ['archivedStorage', task.archiveBytes],
    ['otherTaskStorage', task.otherBytes], ['combinedStorage', task.totalBytes],
  ];
  return `<article class="task-storage-row">
    <div class="task-storage-identity"><button class="task-title-button" data-action="open-task" data-id="${escapeHtml(task.taskId)}">${escapeHtml(task.name || task.taskId)}</button><code>${escapeHtml(task.taskId)}</code><span class="status-badge ${escapeHtml(task.taskStatus)}">${escapeHtml(tr(task.taskStatus))}</span>${task.unreadableEntries ? `<small>${escapeHtml(tr('storageEstimatePartial'))}</small>` : ''}</div>
    <dl class="task-storage-measurements">${measurements.map(([label, value]) => `<div><dt>${escapeHtml(tr(label))}</dt><dd>${escapeHtml(formatBytes(value))}</dd></div>`).join('')}</dl>
    <div class="task-storage-actions">${task.canDelete
      ? `<button class="button danger small" data-action="delete-task" data-id="${escapeHtml(task.taskId)}" data-task-created-at="${escapeHtml(task.taskCreatedAt || '')}">${escapeHtml(tr('deleteTaskArtifacts'))}</button>`
      : `<span class="inline-note">${escapeHtml(tr(task.deletionBlockedReason === 'archiving' ? 'deleteAfterArchive' : 'deleteAfterStop'))}</span>`}</div>
  </article>`;
}

function renderBridgeInventory() {
  const inventory = state.bridgeInventory || { summary: {}, sessions: [] };
  const summary = inventory.summary || {};
  const sessions = Array.isArray(inventory.sessions) ? inventory.sessions : [];
  const initialLoading = state.bridgeInventoryLoading && !state.bridgeInventoryLoaded;
  const metrics = [
    ['inventoryTotal', state.bridgeInventoryLoaded ? Number(summary.total || 0) : '-'],
    ['inventoryReclaimable', state.bridgeInventoryLoaded ? Number(summary.reclaimable || 0) : '-'],
    ['inventoryBytes', state.bridgeInventoryLoaded ? formatBytes(summary.totalBytes) : '-'],
    ['reclaimableRuntimeBytes', state.bridgeInventoryLoaded ? formatBytes(summary.reclaimableBytes) : '-'],
    ['platformTaskStorage', state.bridgeInventoryLoaded && summary.taskBytes != null ? formatBytes(summary.taskBytes) : '-'],
    ['combinedStorage', state.bridgeInventoryLoaded && summary.combinedBytes != null ? formatBytes(summary.combinedBytes) : '-'],
  ];
  renderHtml('bridgeInventoryMetrics', '#bridgeInventoryMetrics', metrics.map(([label, value]) => `
    <div class="metric"><span>${escapeHtml(tr(label))}</span><strong>${escapeHtml(value)}</strong></div>`).join(''));
  const listHtml = initialLoading
    ? `<div class="inventory-loading" role="status"><div class="loading-bar"></div><span>${escapeHtml(tr('loadingInventory'))}</span></div>`
    : (state.bridgeInventoryLoaded && sessions.length
      ? sessions.map(bridgeInventoryRow).join('')
      : `<div class="empty-state">${escapeHtml(tr(state.bridgeInventoryLoaded ? 'noBridgeSessions' : 'inventoryNotScanned'))}</div>`);
  renderHtml('bridgeInventoryList', '#bridgeInventoryList', listHtml);
  const taskStorage = Array.isArray(inventory.tasks) ? inventory.tasks : [];
  renderHtml('taskStorageList', '#taskStorageList', initialLoading
    ? `<div class="inventory-loading"><div class="loading-bar"></div></div>`
    : taskStorage.length ? taskStorage.map(taskStorageRow).join('')
      : `<div class="empty-state">${escapeHtml(tr(state.bridgeInventoryLoaded && Array.isArray(inventory.tasks) ? 'noTaskStorage' : 'inventoryNotScanned'))}</div>`);
  $('#bridgeInventoryScannedAt').textContent = initialLoading
    ? tr('loadingInventory')
    : (summary.scannedAt ? trf('inventoryScanned', { time: formatTime(summary.scannedAt) }) : tr('inventoryNotScanned'));
  const categories = summary.categories || {};
  $('#bridgeInventoryState').textContent = initialLoading
    ? tr('loadingInventory')
    : (state.bridgeInventoryLoaded ? trf('inventoryStateSummary', {
      safe: sessions.filter((session) => session.safe).length,
      queued: Number(categories.cleanup_queued || 0),
      unsafe: Number(categories.unsafe || 0) + Number(categories.cleanup_inconsistent || 0),
    }) : '');
  updateRuntimeRefreshButton();
}

function scheduleBridgeInventoryPoll() {
  clearTimeout(bridgeInventoryPollTimer);
  bridgeInventoryPollTimer = null;
  if (document.hidden || state.view !== 'runtime') return;
  const pending = (state.bridgeInventory.sessions || []).some((session) => session.category === 'cleanup_queued');
  if (!pending) return;
  bridgeInventoryPollTimer = setTimeout(() => {
    loadBridgeInventory().catch((error) => {
      if (error.name !== 'AbortError') toast(error.message, 'error');
    });
  }, 2000);
}

async function loadBridgeInventory() {
  if (state.bridgeInventoryController) state.bridgeInventoryController.abort();
  const controller = new AbortController();
  state.bridgeInventoryController = controller;
  state.bridgeInventoryLoading = true;
  renderBridgeInventory();
  try {
    const inventory = await api('/api/runtime/bridge-sessions', { signal: controller.signal });
    if (!controller.signal.aborted) {
      state.bridgeInventory = inventory;
      state.bridgeInventoryLoaded = true;
      renderBridgeInventory();
    }
    return inventory;
  } finally {
    if (state.bridgeInventoryController === controller) {
      state.bridgeInventoryController = null;
      state.bridgeInventoryLoading = false;
      renderBridgeInventory();
      scheduleBridgeInventoryPoll();
    }
  }
}

async function loadProtectionStatus() {
  clearTimeout(protectionPollTimer);
  protectionPollTimer = null;
  if (state.protectionController) state.protectionController.abort();
  const controller = new AbortController();
  state.protectionController = controller;
  state.protectionLoading = true;
  renderProtectionStatus();
  try {
    const health = await api('/api/health', { signal: controller.signal, acceptedStatuses: [503] });
    if (!controller.signal.aborted) {
      state.protectionStatus = health;
      state.protectionLoaded = true;
      state.protectionCheckedAt = new Date().toISOString();
      state.protectionError = '';
      state.protectionFailureCount = 0;
      renderProtectionStatus();
    }
    return health;
  } catch (error) {
    if (!controller.signal.aborted && state.protectionController === controller) {
      state.protectionError = String(error?.message || error);
      state.protectionFailureCount += 1;
      renderProtectionStatus();
    }
    throw error;
  } finally {
    if (state.protectionController === controller) {
      state.protectionController = null;
      state.protectionLoading = false;
      renderProtectionStatus();
      scheduleProtectionPoll();
    }
  }
}

function protectionPollDelay() {
  if (state.protectionError) {
    return Math.min(
      PROTECTION_POLL_INTERVAL_MS,
      PROTECTION_ACTIVE_POLL_INTERVAL_MS * (2 ** Math.min(4, Math.max(0, state.protectionFailureCount - 1))),
    );
  }
  const health = state.protectionStatus;
  return health?.backups?.inProgress || health?.recoveryCheckpoints?.inProgress
    || Number(health?.externalLogArchives?.archiving || 0) > 0
    || Number(health?.externalLogArchives?.verifying || 0) > 0
    ? PROTECTION_ACTIVE_POLL_INTERVAL_MS
    : PROTECTION_POLL_INTERVAL_MS;
}

function scheduleProtectionPoll() {
  clearTimeout(protectionPollTimer);
  protectionPollTimer = null;
  if (document.hidden || state.view !== 'runtime' || state.protectionLoading) return;
  protectionPollTimer = setTimeout(() => {
    loadProtectionStatus().catch((error) => {
      if (error.name !== 'AbortError') console.warn('Data protection status refresh failed');
    });
  }, protectionPollDelay());
}

function renderAll() {
  applyTranslations();
  renderRuntime();
  renderMetrics();
  renderOverview();
  renderTasks();
  renderReleaseCycles();
  renderSkills();
  renderProtectionStatus();
  renderBridgeInventory();
  renderAudit();
}

async function loadDashboard(options = {}) {
  if (state.dashboardPromise) return state.dashboardPromise;
  const controller = new AbortController();
  let timedOut = false;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, DASHBOARD_REQUEST_TIMEOUT_MS);
  state.dashboardPromise = api(`/api/dashboard?taskLimit=${state.taskLimit}`, { signal: controller.signal })
    .then((dashboard) => {
      reconcileRunIntents(dashboard.sessions);
      reconcileTaskOperationIntents(dashboard.sessions);
      const signature = JSON.stringify(dashboard);
      const changed = options.force || signature !== state.dashboardSignature;
      const connectionRecovered = state.dashboardUnavailable;
      state.dashboardUnavailable = false;
      state.dashboardFailureCount = 0;
      state.dashboard = dashboard;
      state.dashboardSignature = signature;
      if (changed) {
        renderRuntime();
        renderMetrics();
        renderOverview();
        renderTasks();
      } else if (connectionRecovered) {
        renderRuntime();
      }
      return changed;
    })
    .catch((error) => {
      const failure = timedOut && error.name === 'AbortError'
        ? Object.assign(new Error(tr('dashboardRequestTimeout')), { name: 'DashboardTimeoutError' })
        : error;
      if (failure.name !== 'AbortError') {
        state.dashboardUnavailable = true;
        state.dashboardFailureCount += 1;
        renderRuntime();
      }
      throw failure;
    })
    .finally(() => {
      clearTimeout(timeoutTimer);
      state.dashboardPromise = null;
    });
  return state.dashboardPromise;
}

async function loadSkills() {
  state.skills = await api('/api/skills');
  renderSkills();
}

function releaseCycleCard(cycle) {
  const active = cycle.status === 'active';
  const expanded = state.selectedReleaseCycleId === cycle.id;
  const deleting = Boolean(cycle.deletion);
  const schedule = (cycle.schedules || []).find((item) => item.enabled) || cycle.schedules?.[0];
  return `<article class="release-cycle-card ${active ? 'active' : 'closed'}">
    <div class="task-card-overline"><span class="task-project-badge">${escapeHtml(cycle.project || 'cloudRecord')}</span><span class="status-badge ${deleting ? 'stopping' : active ? 'running' : 'completed'}">${escapeHtml(tr(deleting ? 'cycleDeleting' : active ? 'releaseCycleActive' : 'releaseCycleClosed'))}</span></div>
    <h3>${escapeHtml(cycle.name)}</h3>
    <p><code>${escapeHtml(cycle.releaseKey)}</code></p>
    <dl class="release-cycle-meta">
      <div><dt>${escapeHtml(tr('taskCountLabel'))}</dt><dd>${trf('releaseCycleTaskCount', { count: Number(cycle.taskCount || 0) })}</dd></div>
      <div><dt>${escapeHtml(tr('nextRun'))}</dt><dd>${escapeHtml(schedule?.enabled ? formatTime(schedule.nextRunAt) : '-')}</dd></div>
      <div><dt>${escapeHtml(tr('lastRun'))}</dt><dd>${escapeHtml(cycle.lastTaskAt ? formatTime(cycle.lastTaskAt) : '-')}</dd></div>
      <div><dt>${escapeHtml(tr('cycleWorkflow'))}</dt><dd>${escapeHtml(cycle.workflow || '-')}</dd></div>
    </dl>
    ${deleting ? `<p role="status">${escapeHtml(trf('cycleDeletionProgress', { deleted: cycle.deletion.deletedTasks, total: cycle.deletion.totalTasks }))}${cycle.deletion.lastError ? ` ${escapeHtml(tr('cycleDeletionRetry'))}` : ''}</p>` : ''}
    <div class="release-cycle-actions"><button class="button secondary small" data-action="open-release-cycle" data-id="${escapeHtml(cycle.id)}" aria-expanded="${expanded}" aria-controls="releaseCycleTaskSection">${escapeHtml(tr(expanded ? 'collapseReleaseCycle' : 'open'))}</button>${active ? `<button class="button secondary small" data-action="close-release-cycle" data-id="${escapeHtml(cycle.id)}">${escapeHtml(tr('closeReleaseCycle'))}</button>` : ''}<button class="button danger small" data-action="delete-release-cycle" data-id="${escapeHtml(cycle.id)}"${deleting || releaseCycleDeleteIntents.get(cycle.id)?.running ? ' disabled' : ''}>${escapeHtml(tr(deleting ? 'cycleDeleting' : 'deleteReleaseCycle'))}</button></div>
  </article>`;
}

function openReleaseCycleEditor() {
  const form = $('#releaseCycleForm');
  delete form.dataset.createKey;
  delete form.dataset.createPayload;
  const id = createClientIdempotencyKey('cycle-');
  form.innerHTML = `
    <p class="cycle-form-note full">${escapeHtml(tr('cycleFormNote'))}</p>
    <label class="field"><span>${escapeHtml(tr('cycleName'))}</span><input name="name" required maxlength="160" placeholder="Cloud Recording v2.8.1"></label>
    <label class="field"><span>${escapeHtml(tr('releaseKey'))}</span><input name="releaseKey" required maxlength="200" placeholder="cloud-recording-v2.8.1"></label>
    <label class="field"><span>${escapeHtml(tr('taskProject'))}</span><input name="project" maxlength="100" value="cloudRecord"></label>
    <label class="field"><span>${escapeHtml(tr('taskTestType'))}</span><select name="testType"><option value="regression" selected>${escapeHtml(tr('regressionTest'))}</option><option value="feature">${escapeHtml(tr('featureTest'))}</option></select></label>
    <label class="field"><span>${escapeHtml(tr('cycleTaskName'))}</span><input name="taskName" required maxlength="160" value="${escapeHtml(tr('cycleTaskNameDefault'))}"></label>
    <label class="field full"><span>${escapeHtml(tr('cycleTaskObjective'))}</span><textarea name="objective" required maxlength="524288"></textarea></label>
    <label class="field"><span>${escapeHtml(tr('workspace'))}</span><input name="workingDir" value="." maxlength="4096"></label>
    <label class="field"><span>${escapeHtml(tr('workspaceMode'))}</span><select name="workspaceMode"><option value="session-clone">${escapeHtml(tr('sessionCloneWorkspace'))}</option><option value="shared">${escapeHtml(tr('sharedWorkspace'))}</option></select></label>
    <label class="check-field full"><input type="checkbox" name="scheduleEnabled" id="releaseCycleScheduleEnabled"><span>${escapeHtml(tr('enableCycleSchedule'))}</span></label>
    <fieldset class="cycle-schedule-fields full hidden" id="releaseCycleScheduleFields" disabled>
      <label class="field"><span>${escapeHtml(tr('cycleCron'))}</span><input name="cron" value="0 23 * * *" required></label>
      <label class="field"><span>${escapeHtml(tr('cycleTimezone'))}</span><input name="timezone" value="Asia/Shanghai" required></label>
      <label class="field full"><span>${escapeHtml(tr('cycleOverlap'))}</span><select name="overlapPolicy"><option value="queue">${escapeHtml(tr('cycleOverlapQueue'))}</option><option value="skip">${escapeHtml(tr('cycleOverlapSkip'))}</option><option value="parallel">${escapeHtml(tr('cycleOverlapParallel'))}</option></select></label>
    </fieldset>
    <details class="cycle-form-advanced full"><summary>${escapeHtml(tr('cycleAdvanced'))}</summary><div class="form-grid">
      <label class="field"><span>${escapeHtml(tr('cycleId'))}</span><input name="id" required maxlength="64" pattern="[a-z0-9][a-z0-9_-]{0,63}" value="${escapeHtml(id)}"></label>
      <label class="field"><span>${escapeHtml(tr('cycleWorkflow'))}</span><input name="workflow" value="full-release-regression"></label>
    </div></details>
    <div class="form-actions full"><button class="button secondary" type="button" data-close="releaseCycleEditorModal">${escapeHtml(tr('cancel'))}</button><button class="button primary" type="submit">${escapeHtml(tr('cycleSavedOnly'))}</button></div>`;
  $('#releaseCycleScheduleEnabled').addEventListener('change', event => {
    $('#releaseCycleScheduleFields').disabled = !event.target.checked;
    $('#releaseCycleScheduleFields').classList.toggle('hidden', !event.target.checked);
  });
  openModal('releaseCycleEditorModal');
}

function releaseCycleFormPayload(form) {
  const mode = form.get('workspaceMode') || 'session-clone';
  const payload = { id: String(form.get('id') || '').trim(), name: String(form.get('name') || '').trim(),
    releaseKey: String(form.get('releaseKey') || '').trim(), project: String(form.get('project') || 'cloudRecord').trim(),
    workflow: String(form.get('workflow') || 'full-release-regression').trim(),
    taskTemplate: { name: String(form.get('taskName') || '').trim(), objective: String(form.get('objective') || '').trim(), testType: String(form.get('testType') || 'regression').trim(),
      workingDir: String(form.get('workingDir') || '.').trim() || '.', workspaceMode: mode,
      sourceMode: mode === 'session-clone' ? 'session-clone' : 'shared-repo', autoResume: true, maxRetries: 2 } };
  if (form.get('scheduleEnabled') === 'on') payload.schedule = { cron: String(form.get('cron') || '').trim(),
    timezone: String(form.get('timezone') || 'Asia/Shanghai').trim(), overlapPolicy: form.get('overlapPolicy') || 'queue' };
  return payload;
}

async function saveReleaseCycle(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  if (button.disabled) return;
  const payload = releaseCycleFormPayload(new FormData(form));
  const serialized = JSON.stringify(payload);
  if (form.dataset.createPayload !== serialized) {
    form.dataset.createKey = createClientIdempotencyKey('release-cycle-create:');
    form.dataset.createPayload = serialized;
  }
  const key = form.dataset.createKey;
  button.disabled = true;
  let committed = false;
  try {
    const created = await api('/api/release-cycles', { method: 'POST', headers: { 'Idempotency-Key': key }, body: payload });
    committed = true;
    if (form.dataset.createKey === key) closeModal('releaseCycleEditorModal');
    toast(tr('releaseCycleCreated'));
    await loadReleaseCycles();
    if (state.releaseCycles.some(cycle => cycle.id === created.id)) await openReleaseCycle(created.id);
  } catch (error) {
    toast(committed ? tr('cycleCreateRefreshFailed') : error.message, committed ? 'info' : 'error');
  } finally { button.disabled = false; }
}

function analysisRate(value) {
  return value == null ? '-' : `${Math.round(Number(value) * 100)}%`;
}

function releaseCycleAnalysisGroupHtml(type, group) {
  const summary = group?.summary || {};
  const labelKey = type === 'feature' ? 'featureTest' : 'regressionTest';
  return `<article class="release-analysis-group"><header><h4>${escapeHtml(tr(labelKey))}</h4><span>${escapeHtml(trf('releaseCycleTaskCount', { count: summary.taskCount || 0 }))}</span></header><div class="release-analysis-metrics">
    <div><span>${escapeHtml(tr('analysisInitialPass'))}</span><strong>${analysisRate(summary.initial?.passRate)}</strong></div>
    <div><span>${escapeHtml(tr('analysisTargetInitialPass'))}</span><strong>${analysisRate(summary.targetInitial?.passRate)}</strong></div>
    <div><span>${escapeHtml(tr('analysisRerunPass'))}</span><strong>${analysisRate(summary.rerun?.passRate)}</strong></div>
    <div><span>${escapeHtml(tr('analysisRecovered'))}</span><strong>${Number(summary.transitions?.recovered || 0)}</strong></div>
    <div><span>${escapeHtml(tr('analysisPersistent'))}</span><strong>${Number(summary.transitions?.persistent || 0)}</strong></div>
    <div><span>${escapeHtml(tr('analysisRegressed'))}</span><strong>${Number(summary.transitions?.regressed || 0)}</strong></div>
  </div></article>`;
}

function releaseCycleTrendChartHtml(trend) {
  if (!trend.length) return '';
  const width = 760;
  const height = 360;
  const left = 42;
  const right = 16;
  const top = 34;
  const bottom = 40;
  const chartWidth = width - left - right;
  const panelHeight = 118;
  const panelGap = 42;
  const panels = [
    { id: 'pass', title: tr('analysisPass'), top, series: [
      ['initialPassRate', 'pass-initial', `${tr('analysisInitial')} ${tr('analysisPass')}`],
      ['targetInitialPassRate', 'pass-target', `${tr('analysisTargetInitialPass')} ${tr('analysisPass')}`],
      ['rerunPassRate', 'pass-rerun', `${tr('analysisRerun')} ${tr('analysisPass')}`],
    ] },
    { id: 'fail', title: tr('analysisFail'), top: top + panelHeight + panelGap, series: [
      ['initialFailRate', 'fail-initial', `${tr('analysisInitial')} ${tr('analysisFail')}`],
      ['targetInitialFailRate', 'fail-target', `${tr('analysisTargetInitialFail')}`],
      ['rerunFailRate', 'fail-rerun', `${tr('analysisRerun')} ${tr('analysisFail')}`],
    ] },
  ];
  const xStep = trend.length === 1 ? 0 : chartWidth / (trend.length - 1);
  const clampRate = (value) => Math.max(0, Math.min(1, Number(value || 0)));
  const lineFor = (panel, key, className, label) => {
    const points = trend.map((point, index) => ({
      x: trend.length === 1 ? left + chartWidth / 2 : left + index * xStep,
      y: panel.top + panelHeight * (1 - clampRate(point[key])),
    }));
    const path = points.map((point, index) => `${index ? 'L' : 'M'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');
    const markers = points.map((point, index) => {
      const partial = trend[index].analysisStatus === 'partial' ? ` · ${tr('analysisPartial')}` : '';
      return `<circle class="release-analysis-point ${className}" cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="3.5"><title>${escapeHtml(`${trend[index].name || trend[index].taskId}${partial} · ${label}: ${analysisRate(trend[index][key])}`)}</title></circle>`;
    }).join('');
    return `<path class="release-analysis-line ${className}" d="${path}"></path>${markers}`;
  };
  const panelHtml = panels.map((panel) => {
    const grid = [0, .5, 1].map((rate) => {
      const y = panel.top + panelHeight * (1 - rate);
      return `<line class="release-analysis-grid-line" x1="${left}" y1="${y.toFixed(2)}" x2="${width - right}" y2="${y.toFixed(2)}"></line><text class="release-analysis-axis-label" x="${left - 8}" y="${(y + 4).toFixed(2)}" text-anchor="end">${Math.round(rate * 100)}%</text>`;
    }).join('');
    const lines = panel.series.map(([key, className, label]) => lineFor(panel, key, className, label)).join('');
    return `<rect class="release-analysis-panel" x="${left}" y="${panel.top}" width="${chartWidth}" height="${panelHeight}" rx="10"></rect><text class="release-analysis-panel-title" x="${left + 12}" y="${panel.top + 20}">${escapeHtml(panel.title)}</text>${grid}${lines}`;
  }).join('');
  const labels = trend.map((point, index) => {
    if (index % Math.max(1, Math.ceil(trend.length / 8)) !== 0) return '';
    const x = trend.length === 1 ? left + chartWidth / 2 : left + index * xStep;
    return `<text class="release-analysis-axis-label" x="${x.toFixed(2)}" y="${height - 12}" text-anchor="middle">${escapeHtml(String(point.seriesRunSequence || index + 1))}</text>`;
  }).join('');
  const legend = [
    ['pass-initial', `${tr('analysisInitial')} ${tr('analysisPass')}`], ['pass-target', `${tr('analysisTargetInitialPass')}`], ['pass-rerun', `${tr('analysisRerun')} ${tr('analysisPass')}`],
    ['fail-initial', `${tr('analysisInitial')} ${tr('analysisFail')}`], ['fail-target', `${tr('analysisTargetInitialFail')}`], ['fail-rerun', `${tr('analysisRerun')} ${tr('analysisFail')}`],
  ].map(([className, label]) => `<span><i class="release-analysis-legend-swatch ${className}"></i>${escapeHtml(label)}</span>`).join('');
  return `<div class="release-analysis-chart" role="img" aria-label="${escapeHtml(tr('analysisChartHint'))}"><div class="release-analysis-chart-head"><span>${escapeHtml(tr('analysisChartHint'))}</span><span class="release-analysis-legend">${legend}</span></div><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><line class="release-analysis-axis" x1="${left}" y1="${top}" x2="${left}" y2="${height - bottom}"></line>${panelHtml}${labels}</svg></div>`;
}

function releaseCycleAnalysisHtml(analysis) {
  if (state.releaseCycleAnalysisLoading) return `<p class="inline-note">${escapeHtml(tr('releaseCycleAnalysisLoading'))}</p>`;
  if (!analysis) return '';
  const summary = analysis.summary || {};
  const trend = analysis.trend || [];
  const table = trend.length
    ? `<div class="release-analysis-table-wrap"><table class="release-analysis-table"><thead><tr><th>${escapeHtml(tr('analysisTask'))}</th><th>${escapeHtml(tr('analysisScheduled'))}</th><th>${escapeHtml(tr('analysisInitial'))}</th><th>${escapeHtml(tr('analysisRerun'))}</th><th>${escapeHtml(tr('analysisTransitions'))}</th></tr></thead><tbody>${trend.map((point) => `<tr><td><code>${escapeHtml(point.taskId)}</code><span class="task-test-type ${escapeHtml(point.testType)}">${escapeHtml(tr(point.testType === 'feature' ? 'featureTest' : 'regressionTest'))}</span>${point.analysisStatus === 'partial' ? `<span class="task-test-type partial">${escapeHtml(tr('analysisPartial'))}</span>` : ''}</td><td>${escapeHtml(formatTime(point.scheduledFor))}</td><td>${analysisRate(point.initialPassRate)} / ${analysisRate(point.initialFailRate)}</td><td>${analysisRate(point.rerunPassRate)} / ${analysisRate(point.rerunFailRate)}</td><td><span class="analysis-transition-good">${Number(point.recovered || 0)} ↑</span><span class="analysis-transition-bad">${Number(point.persistent || 0)} · ${Number(point.regressed || 0)} ↓</span></td></tr>`).join('')}</tbody></table></div>`
    : `<p class="inline-note">${escapeHtml(tr('analysisNoTrend'))}</p>`;
  return `<section class="release-analysis-card"><header class="release-analysis-head"><div><span class="section-label">${escapeHtml(tr('releaseCycleAnalysis'))}</span><h3>${escapeHtml(tr('releaseCycleAnalysisHint'))}</h3></div><span class="status-badge completed">${Number(summary.comparableTaskCount || 0)} ${escapeHtml(tr('analysisComparable'))}</span></header><div class="release-analysis-summary"><div><span>${escapeHtml(tr('analysisComparable'))}</span><strong>${Number(summary.comparableTaskCount || 0)}</strong></div><div><span>${escapeHtml(tr('analysisPartial'))}</span><strong>${Number(summary.partialTaskCount || 0)}</strong></div><div><span>${escapeHtml(tr('analysisPending'))}</span><strong>${Number(summary.pendingTaskCount || 0)}</strong></div><div><span>${escapeHtml(tr('analysisUnavailable'))}</span><strong>${Number(summary.unavailableTaskCount || 0)}</strong></div></div><div class="release-analysis-groups">${releaseCycleAnalysisGroupHtml('feature', analysis.groups?.feature)}${releaseCycleAnalysisGroupHtml('regression', analysis.groups?.regression)}</div><h4 class="release-analysis-subtitle">${escapeHtml(tr('analysisTrend'))}</h4>${releaseCycleTrendChartHtml(trend)}${table}</section>`;
}

function renderReleaseCycleTaskGroups(tasks) {
  const groups = {
    feature: tasks.filter((task) => (task.testType || 'regression') === 'feature'),
    regression: tasks.filter((task) => (task.testType || 'regression') === 'regression'),
  };
  for (const [type, target, countTarget] of [
    ['feature', '#releaseCycleFeatureTaskGrid', '#releaseCycleFeatureTaskCount'],
    ['regression', '#releaseCycleRegressionTaskGrid', '#releaseCycleRegressionTaskCount'],
  ]) {
    const members = groups[type];
    $(countTarget).textContent = String(members.length);
    renderHtml(`release-cycle-${type}-tasks`, target, members.length
      ? members.map((task) => taskCard(task)).join('')
      : `<div class="empty-state span-all">${escapeHtml(tr('noCurrentTasks'))}</div>`);
  }
}

function renderReleaseCycles() {
  const grid = $('#releaseCycleGrid');
  if (!grid) return;
  const sortedCycles = sortTasksForDisplay(state.releaseCycles);
  grid.innerHTML = state.releaseCycles.length
    ? sortedCycles.map(releaseCycleCard).join('')
    : `<div class="empty-state span-all">${escapeHtml(tr('noReleaseCycles'))}</div>`;
  const cycle = state.releaseCycles.find((item) => item.id === state.selectedReleaseCycleId);
  const section = $('#releaseCycleTaskSection');
  if (!section || !cycle) {
    section?.classList.add('hidden');
    if (section) {
      renderHtml('release-cycle-feature-tasks', '#releaseCycleFeatureTaskGrid', '');
      renderHtml('release-cycle-regression-tasks', '#releaseCycleRegressionTaskGrid', '');
      $('#releaseCycleFeatureTaskCount').textContent = '0';
      $('#releaseCycleRegressionTaskCount').textContent = '0';
    }
    if (section) renderHtml('release-cycle-analysis', '#releaseCycleAnalysis', '');
    return;
  }
  section.classList.remove('hidden');
  $('#releaseCycleTaskTitle').textContent = `${cycle.name} · ${cycle.releaseKey}`;
  $('#closeReleaseCycleBtn').classList.toggle('hidden', cycle.status !== 'active');
  $('#deleteReleaseCycleBtn').dataset.id = cycle.id;
  $('#deleteReleaseCycleBtn').disabled = Boolean(cycle.deletion || releaseCycleDeleteIntents.get(cycle.id)?.running);
  $('#deleteReleaseCycleBtn').textContent = tr(cycle.deletion ? 'cycleDeleting' : 'deleteReleaseCycle');
  renderHtml('release-cycle-analysis', '#releaseCycleAnalysis', releaseCycleAnalysisHtml(state.releaseCycleAnalysis));
  renderReleaseCycleTaskGroups(state.releaseCycleTasks);
}

async function loadReleaseCycles() {
  const previousDeletions = state.releaseCycles.filter(cycle => cycle.deletion);
  const version = ++releaseCyclesRequestVersion;
  const cycles = await api('/api/release-cycles');
  if (version !== releaseCyclesRequestVersion) return;
  state.releaseCycles = cycles;
  if (state.selectedReleaseCycleId && !state.releaseCycles.some((cycle) => cycle.id === state.selectedReleaseCycleId)) {
    state.selectedReleaseCycleId = '';
    state.releaseCycleTasks = [];
  }
  renderReleaseCycles();
  for (const old of previousDeletions) {
    if (!cycles.some(cycle => cycle.id === old.id && cycle.createdAt === old.createdAt)) {
      toast(trf('cycleDeletionCompleted', { name: old.name }));
    }
  }
  scheduleReleaseCycleDeletionPoll();
}

let releaseCycleDeletionPollTimer = null;
async function refreshDashboardAfterCycleDeletion() {
  // Fetch after any older poll so its response cannot revive deleted Task cards.
  try { if (state.dashboardPromise) await state.dashboardPromise; } catch {}
  await loadDashboard({ force: true });
}
function scheduleReleaseCycleDeletionPoll() {
  clearTimeout(releaseCycleDeletionPollTimer);
  releaseCycleDeletionPollTimer = null;
  if (document.hidden || state.view !== 'release-cycles' || !state.releaseCycles.some(cycle => cycle.deletion)) return;
  releaseCycleDeletionPollTimer = setTimeout(async () => {
    releaseCycleDeletionPollTimer = null;
    try {
      await loadReleaseCycles();
      await refreshDashboardAfterCycleDeletion();
      if (state.selectedReleaseCycleId) await openReleaseCycle(state.selectedReleaseCycleId);
    } catch (error) { if (error.name !== 'AbortError') console.warn('Release cycle deletion refresh failed'); }
    finally { scheduleReleaseCycleDeletionPoll(); }
  }, 2000);
}

async function openReleaseCycle(id) {
  const cycle = state.releaseCycles.find(item => item.id === id);
  if (!cycle) return;
  const version = ++releaseCycleTasksRequestVersion;
  if (state.selectedReleaseCycleId !== id) {
    state.releaseCycleTasks = [];
    state.releaseCycleAnalysis = null;
  }
  state.selectedReleaseCycleId = id;
  renderReleaseCycles();
  try {
    const tasks = await api(`/api/release-cycles/${encodeURIComponent(id)}/tasks?limit=500&offset=0`);
    if (version !== releaseCycleTasksRequestVersion || state.selectedReleaseCycleId !== id
      || !state.releaseCycles.some(item => item.id === id && item.createdAt === cycle.createdAt)) return;
    state.releaseCycleTasks = tasks;
    renderReleaseCycles();
  } catch (error) {
    if (version === releaseCycleTasksRequestVersion && state.selectedReleaseCycleId === id) throw error;
  }
  loadReleaseCycleAnalysis(id, version).catch((error) => {
    if (version === releaseCycleTasksRequestVersion && state.selectedReleaseCycleId === id) toast(error.message, 'error');
  });
}

async function loadReleaseCycleAnalysis(id, version = releaseCycleTasksRequestVersion) {
  if (state.selectedReleaseCycleId !== id) return;
  state.releaseCycleAnalysisLoading = true;
  renderReleaseCycles();
  try {
    const analysis = await api(`/api/release-cycles/${encodeURIComponent(id)}/analysis?testType=all`);
    if (version !== releaseCycleTasksRequestVersion || state.selectedReleaseCycleId !== id) return;
    state.releaseCycleAnalysis = analysis;
  } catch (error) {
    if (version === releaseCycleTasksRequestVersion && state.selectedReleaseCycleId === id) {
      state.releaseCycleAnalysis = null;
    }
    throw error;
  } finally {
    if (version === releaseCycleTasksRequestVersion && state.selectedReleaseCycleId === id) {
      state.releaseCycleAnalysisLoading = false;
      renderReleaseCycles();
    }
  }
}

function collapseReleaseCycle() {
  releaseCycleTasksRequestVersion++;
  state.selectedReleaseCycleId = '';
  state.releaseCycleTasks = [];
  state.releaseCycleAnalysis = null;
  state.releaseCycleAnalysisLoading = false;
  renderReleaseCycles();
}

async function toggleReleaseCycle(id) {
  if (state.selectedReleaseCycleId === id) { collapseReleaseCycle(); return; }
  try { await openReleaseCycle(id); }
  catch (error) { toast(error.message, 'error'); }
}

async function closeReleaseCycle(id) {
  const cycle = state.releaseCycles.find((item) => item.id === id);
  if (!cycle || cycle.status !== 'active') return;
  if (!window.confirm(trf('confirmCloseReleaseCycle', { name: cycle.name }))) return;
  try {
    await api(`/api/release-cycles/${encodeURIComponent(id)}/close`, { method: 'POST' });
    toast(tr('closeReleaseCycle'));
    await loadReleaseCycles();
  } catch (error) { toast(error.message, 'error'); }
}

async function deleteReleaseCycle(id) {
  const cycle = state.releaseCycles.find(item => item.id === id);
  if (!cycle || releaseCycleDeleteIntents.get(id)?.running) return;
  if (!window.confirm(trf('confirmDeleteReleaseCycle', { name: cycle.name }))) return;
  let intent = releaseCycleDeleteIntents.get(id);
  if (!intent || intent.createdAt !== cycle.createdAt) {
    intent = { createdAt: cycle.createdAt, key: createClientIdempotencyKey('release-cycle-delete:') };
    releaseCycleDeleteIntents.set(id, intent);
  }
  intent.running = true;
  renderReleaseCycles();
  let committed = false;
  let completed = false;
  try {
    const result = await api(`/api/release-cycles/${encodeURIComponent(id)}`, { method: 'DELETE',
      headers: { 'Idempotency-Key': intent.key, 'X-Release-Cycle-Created-At': intent.createdAt } });
    if (result.historyRetained || result.retainedTasks > 0) throw Object.assign(new Error(tr('cycleDeletionLegacy')), { status: 409 });
    committed = true;
    completed = result.deleted;
    if (releaseCycleDeleteIntents.get(id) === intent) releaseCycleDeleteIntents.delete(id);
    state.releaseCycles = state.releaseCycles.flatMap(item => {
      if (item.id !== id || item.createdAt !== intent.createdAt) return [item];
      return completed ? [] : [{ ...item, status: 'deleting', deletion: result }];
    });
    if (completed && state.selectedReleaseCycleId === id && !state.releaseCycles.some(item => item.id === id)) {
      state.selectedReleaseCycleId = '';
      state.releaseCycleTasks = [];
    }
    renderReleaseCycles();
    toast(tr(completed ? 'releaseCycleDeleted' : 'cycleDeletionStarted'));
    await loadReleaseCycles();
    await refreshDashboardAfterCycleDeletion();
  } catch (error) {
    if (committed) { toast(tr(completed ? 'cycleDeletedRefreshFailed' : 'cycleDeletionRefreshFailed')); return; }
    if (!hasUnknownRequestOutcome(error) && releaseCycleDeleteIntents.get(id) === intent) releaseCycleDeleteIntents.delete(id);
    toast(error.message, 'error');
    if (error.status === 409) {
      try { await loadReleaseCycles(); } catch (refreshError) { toast(refreshError.message, 'error'); }
    }
  } finally {
    intent.running = false;
    renderReleaseCycles();
    scheduleReleaseCycleDeletionPoll();
  }
}

async function loadAudit() {
  if (state.auditController) state.auditController.abort();
  const controller = new AbortController();
  state.auditController = controller;
  const params = new URLSearchParams();
  if ($('#auditSessionId').value.trim()) params.set('sessionId', $('#auditSessionId').value.trim());
  if ($('#auditKind').value.trim()) params.set('kind', $('#auditKind').value.trim());
  if ($('#auditQuery').value.trim()) params.set('q', $('#auditQuery').value.trim());
  params.set('limit', state.auditPageSize + 1);
  params.set('offset', state.auditOffset);
  try {
    const page = await api(`/api/audit?${params}`, { signal: controller.signal });
    state.auditHasOlder = page.length > state.auditPageSize;
    state.audit = page.slice(0, state.auditPageSize);
    if (!controller.signal.aborted) renderAudit();
  } finally {
    if (state.auditController === controller) state.auditController = null;
  }
}

function loadRuntimeView() {
  for (const promise of [loadBridgeInventory(), loadProtectionStatus()]) {
    promise.catch((error) => {
      if (error.name !== 'AbortError') toast(error.message, 'error');
    });
  }
}

function setView(view) {
  state.view = view;
  $('#topNewTaskBtn').classList.toggle('hidden', view === 'release-cycles');
  $$('.view').forEach((element) => element.classList.toggle('active', element.id === `view-${view}`));
  $$('.nav-item').forEach((element) => element.classList.toggle('active', element.dataset.view === view));
  updateViewHeading();
  if (view !== 'release-cycles') {
    clearTimeout(releaseCycleDeletionPollTimer);
    releaseCycleDeletionPollTimer = null;
  }
  if (view !== 'runtime') {
    clearTimeout(bridgeInventoryPollTimer);
    bridgeInventoryPollTimer = null;
    clearTimeout(protectionPollTimer);
    protectionPollTimer = null;
    if (state.bridgeInventoryController) state.bridgeInventoryController.abort();
    if (state.protectionController) state.protectionController.abort();
  }
  if (view === 'runtime') loadRuntimeView();
  if (view === 'release-cycles') loadReleaseCycles().catch((error) => toast(error.message, 'error'));
  if (view === 'audit') loadAudit().catch((error) => {
    if (error.name !== 'AbortError') toast(error.message, 'error');
  });
}

function openModal(id) {
  $(`#${id}`).classList.remove('hidden');
  document.body.classList.add('modal-open');
}

function closeModal(id) {
  $(`#${id}`).classList.add('hidden');
  if (id === 'taskDetailModal') {
    disposeCodexTerminal();
    abortAttemptOutputLoad();
    disposeAttemptTerminals();
    state.expandedAttemptOutputKey = '';
    state.taskTerminalAutoOpen = false;
    if (state.consoleController) {
      state.consoleController.abort();
      state.consoleController = null;
    }
  }
  if (id === 'skillEditorModal') {
    $('#skillForm').innerHTML = '';
    state.editingSkillId = '';
  }
  if (id === 'taskEditorModal') {
    $('#taskForm').innerHTML = '';
    delete $('#taskForm').dataset.createRunKey;
    state.editingTaskId = '';
  }
  if (id === 'releaseCycleEditorModal') {
    $('#releaseCycleForm').innerHTML = '';
    delete $('#releaseCycleForm').dataset.createKey;
    delete $('#releaseCycleForm').dataset.createPayload;
  }
  if (id === 'overviewReleaseCycleModal') {
    state.overviewCycleModalRequestVersion += 1;
    state.overviewCycleModal = { ...state.overviewCycleModal, cycleId: '', business: '', page: 0, tasks: [], hasMore: false, loading: false, analysis: null, analysisLoading: false };
    $('#overviewReleaseCycleModalBody').innerHTML = '';
  }
  if (id === 'skillAttributionModal') {
    $('#skillAttributionForm').innerHTML = '';
    state.editingExecutionId = '';
    state.skillUsage = null;
  }
  if (id === 'bridgeReclaimModal') {
    state.selectedBridgeSessionId = '';
    $('#bridgeReclaimTarget').textContent = '';
    $('#bridgeReclaimInput').value = '';
    $('#bridgeReclaimInput').disabled = false;
    $('#confirmBridgeReclaimBtn').disabled = true;
  }
  if (!$$('.modal:not(.hidden)').length) document.body.classList.remove('modal-open');
}

function findTask(id) {
  return (state.dashboard.sessions || []).find((task) => task.id === id) || null;
}

function upsertDashboardTask(task) {
  if (!task?.id) return;
  const sessions = state.dashboard.sessions || [];
  const index = sessions.findIndex((candidate) => candidate.id === task.id);
  if (index === -1) sessions.unshift(task);
  else sessions[index] = task;
  state.dashboard.sessions = sessions;
}

function openTaskEditor(task = null) {
  state.editingTaskId = task?.id || '';
  delete $('#taskForm').dataset.createRunKey;
  $('#taskEditorTitle').textContent = tr(task ? 'editTask' : 'createTask');
  $('#taskForm').innerHTML = `
    <label class="field"><span>${escapeHtml(tr('taskName'))}</span><input name="name" required maxlength="200" value="${escapeHtml(task?.name || '')}"></label>
    <label class="field"><span>ID</span><input name="id" required maxlength="64" ${task ? 'disabled' : ''} value="${escapeHtml(task?.id || '')}"><small>${escapeHtml(tr('idHint'))}</small></label>
    <label class="field full"><span>${escapeHtml(tr('objective'))}</span><textarea name="objective" required maxlength="262144">${escapeHtml(task?.objective || '')}</textarea></label>
    <label class="field full"><span>${escapeHtml(tr('notes'))}</span><textarea name="notes" maxlength="262144">${escapeHtml(task?.notes || '')}</textarea></label>
    <label class="field"><span>${escapeHtml(tr('taskProject'))}</span><input name="project" maxlength="100" value="${escapeHtml(task?.project || 'cloudRecord')}"></label>
    <label class="field"><span>${escapeHtml(tr('taskTestType'))}</span><select name="testType"><option value="regression"${task?.testType !== 'feature' ? ' selected' : ''}>${escapeHtml(tr('regressionTest'))}</option><option value="feature"${task?.testType === 'feature' ? ' selected' : ''}>${escapeHtml(tr('featureTest'))}</option></select></label>
    <label class="field"><span>${escapeHtml(tr('taskTags'))}</span><input name="tags" maxlength="10000" value="${escapeHtml((task?.tags || []).join(', '))}"><small>${escapeHtml(tr('taskTagsHint'))}</small></label>
    <label class="field"><span>${escapeHtml(tr('workspaceMode'))}</span><select name="workspaceMode"${task ? ' disabled' : ''}><option value="shared"${task?.workspaceMode !== 'session-clone' ? ' selected' : ''}>shared</option><option value="session-clone"${task?.workspaceMode === 'session-clone' ? ' selected' : ''}>session-clone</option></select>${task ? `<input type="hidden" name="workspaceMode" value="${escapeHtml(task.workspaceMode || 'shared')}">` : ''}</label>
    <label class="field"><span>${escapeHtml(tr('workingDir'))}</span><input name="workingDir" required maxlength="4096" value="${escapeHtml(task?.workingDir || '.')}"><small>${escapeHtml(tr('pathHint'))}</small></label>
    <label class="field"><span>${escapeHtml(tr('maxRetries'))}</span><input type="number" name="maxRetries" min="0" max="20" value="${Number(task?.maxRetries ?? 2)}"></label>
    <label class="check-field"><input type="checkbox" name="enabled" ${task?.enabled === false ? '' : 'checked'}><span>${escapeHtml(tr('enabled'))}</span></label>
    <label class="check-field"><input type="checkbox" name="autoResume" ${task?.autoResume === false ? '' : 'checked'}><span>${escapeHtml(tr('autoResume'))}</span></label>
    <div class="form-actions full"><button class="button secondary" type="button" data-close="taskEditorModal">${escapeHtml(tr('cancel'))}</button><button class="button primary" type="submit">${escapeHtml(tr(task ? 'updateTask' : 'createAndStart'))}</button></div>`;
  if (!task) {
    const nameInput = $('#taskForm [name="name"]');
    const idInput = $('#taskForm [name="id"]');
    nameInput.addEventListener('input', () => {
      if (!idInput.dataset.edited) idInput.value = slugify(nameInput.value);
    });
    idInput.addEventListener('input', () => { idInput.dataset.edited = 'true'; });
  }
  openModal('taskEditorModal');
}

async function saveTask(event) {
  event.preventDefault();
  const formElement = event.currentTarget;
  const submitButton = formElement.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  const form = new FormData(formElement);
  const isEditing = Boolean(state.editingTaskId);
  const id = state.editingTaskId || slugify(form.get('id'));
  const payload = {
    id,
    name: form.get('name'),
    objective: form.get('objective'),
    notes: form.get('notes'),
    project: form.get('project') || 'cloudRecord',
    testType: form.get('testType') || 'regression',
    tags: [...new Set(String(form.get('tags') || '').split(',').map((tag) => tag.trim()).filter(Boolean))],
    workspaceMode: form.get('workspaceMode') || 'shared',
    sourceMode: form.get('workspaceMode') === 'session-clone' ? 'session-clone' : 'shared-repo',
    workingDir: form.get('workingDir') || '.',
    maxRetries: Number(form.get('maxRetries') || 0),
    enabled: form.get('enabled') === 'on',
    autoResume: form.get('autoResume') === 'on',
  };
  try {
    let savedTask;
    if (isEditing) {
      savedTask = await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'PUT', body: payload });
      toast(tr('taskSaved'));
    } else {
      if (payload.enabled) {
        const idempotencyKey = formElement.dataset.createRunKey || createRunIdempotencyKey();
        formElement.dataset.createRunKey = idempotencyKey;
        savedTask = await api('/api/sessions/start', {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey },
          body: { ...payload, idempotencyKey },
        });
        delete formElement.dataset.createRunKey;
        toast(tr('taskStarted'));
      } else {
        delete formElement.dataset.createRunKey;
        savedTask = await api('/api/sessions', { method: 'POST', body: payload });
        toast(tr('taskSaved'));
      }
    }
    upsertDashboardTask(savedTask);
    closeModal('taskEditorModal');
    if (!isEditing) await openTaskDetail(savedTask?.id || id);
    loadDashboard({ force: true }).catch(() => scheduleDashboardPoll(0));
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    submitButton.disabled = false;
  }
}

function taskContext(task) {
  return `
    <h3>${escapeHtml(tr('taskContext'))}</h3>
    <p class="context-objective">${escapeHtml(task.objective || '-')}</p>
    <dl>
      <div><dt>${escapeHtml(tr('status'))}</dt><dd><span class="status-badge ${escapeHtml(statusClass(task))}">${escapeHtml(statusLabel(task))}</span></dd></div>
      <div><dt>${escapeHtml(tr('sessionId'))}</dt><dd><code>${escapeHtml(task.id)}</code></dd></div>
      <div><dt>${escapeHtml(tr('taskProject'))}</dt><dd>${escapeHtml(task.project || 'cloudRecord')}</dd></div>
      ${task.releaseKey ? `<div><dt>${escapeHtml(tr('releaseKey'))}</dt><dd><code>${escapeHtml(task.releaseKey)}</code></dd></div>` : ''}
      ${task.scheduledFor ? `<div><dt>${escapeHtml(tr('scheduledFor'))}</dt><dd>${escapeHtml(formatTime(task.scheduledFor))}</dd></div>` : ''}
      ${task.tags?.length ? `<div><dt>${escapeHtml(tr('taskTags'))}</dt><dd>${escapeHtml(task.tags.join(', '))}</dd></div>` : ''}
      <div><dt>${escapeHtml(tr('workspace'))}</dt><dd><code>${escapeHtml(task.workingDir || '.')}</code></dd></div>
      ${task.workspaceMode ? `<div><dt>${escapeHtml(tr('workspaceMode'))}</dt><dd><code>${escapeHtml(task.workspaceMode)}</code></dd></div>` : ''}
      ${task.sourceMode ? `<div><dt>${escapeHtml(tr('sourceMode'))}</dt><dd><code>${escapeHtml(task.sourceMode)}</code></dd></div>` : ''}
      ${task.sourceCommit ? `<div><dt>${escapeHtml(tr('sourceCommit'))}</dt><dd><code>${escapeHtml(task.sourceCommit)}</code></dd></div>` : ''}
      ${task.sourceCommit ? `<div><dt>${escapeHtml(tr('sourceMode'))}</dt><dd><a target="_blank" rel="noopener" href="/source-viewer.html?task=${encodeURIComponent(task.id)}">${state.lang === 'en' ? 'Browse test source' : '查看本次测试源码'}</a></dd></div>` : ''}
      ${task.archiveState && task.workspaceMode === 'session-clone' ? `<div><dt>${escapeHtml(tr('archiveState'))}</dt><dd><code>${escapeHtml(task.archiveState)}</code></dd></div>` : ''}
      ${task.sessionRoot ? `<div><dt>${escapeHtml(tr('sessionRoot'))}</dt><dd><code>${escapeHtml(task.sessionRoot)}</code></dd></div>` : ''}
      ${task.notes ? `<div><dt>${escapeHtml(tr('notes'))}</dt><dd>${escapeHtml(task.notes)}</dd></div>` : ''}
      <div><dt>${escapeHtml(tr('runCount'))}</dt><dd>${Number(task.runCount || 0)}</dd></div>
      <div><dt>${escapeHtml(tr('recoveryAttempts'))}</dt><dd>${Number(task.recoveryCount || 0)} / ${Number(task.maxRetries || 0)}</dd></div>
      ${task.activeExternalAttempts ? `<div><dt>${escapeHtml(tr('activeBackground'))}</dt><dd>${Number(task.activeExternalAttempts)}</dd></div>` : ''}
      ${task.activeScheduledJobs ? `<div><dt>${escapeHtml(tr('activeSchedules'))}</dt><dd>${Number(task.activeScheduledJobs)}</dd></div>` : ''}
      ${task.nextScheduledAt ? `<div><dt>${escapeHtml(tr('nextCheck'))}</dt><dd>${escapeHtml(formatTime(task.nextScheduledAt))}</dd></div>` : ''}
      <div><dt>${escapeHtml(tr('createdAt'))}</dt><dd>${escapeHtml(formatTime(task.createdAt))}</dd></div>
      ${task.status === 'completed' ? `<div><dt>${escapeHtml(tr('finishedAt'))}</dt><dd>${escapeHtml(formatTime(task.archivedAt || task.lastFinishedAt))}</dd></div>` : ''}
    </dl>
    `;
}

function setComposerExpanded(expanded, focusInput = false) {
  $('#continueTaskForm').dataset.expanded = String(expanded);
  $('#composerBody').classList.toggle('hidden', !expanded);
  $('#composerToggle').setAttribute('aria-expanded', String(expanded));
  const label = expanded ? 'collapseInstruction' : 'expandInstruction';
  $('#composerToggleHint').setAttribute('data-i18n', label);
  $('#composerToggleHint').textContent = tr(label);
  if (expanded && focusInput) $('#continueInput').focus();
}

function renderTaskDetail(task) {
  const archived = task.status === 'completed';
  const running = isActiveTask(task);
  const review = isReviewTask(task);
  const recover = !running && !review && !archived && Boolean(task.persistentSessionKey || task.bridgeSessionKey);
  const canReset = !running && (archived || Boolean(task.persistentSessionKey || task.bridgeSessionKey));
  $('#taskDetailModal').dataset.detailTab = state.detailTab;
  $('#taskDetailModal').dataset.contextExpanded = String(state.taskContextExpanded);
  renderHtml('taskDetailHead', '#taskDetailHead', `
    <div><div class="detail-title-line"><h2>${escapeHtml(task.name)}</h2><span class="status-badge ${escapeHtml(statusClass(task))}">${escapeHtml(statusLabel(task))}</span></div><div class="detail-subline"><code>${escapeHtml(task.id)}</code>${taskClassification(task)}</div></div>
    <div class="detail-actions">
      <button class="button secondary small" data-action="toggle-task-context" aria-controls="taskContext" aria-expanded="${state.taskContextExpanded}">${escapeHtml(tr(state.taskContextExpanded ? 'hideTaskContext' : 'showTaskContext'))}</button>
      ${archived ? `<button class="button primary small" data-action="restore-task" data-id="${escapeHtml(task.id)}">${escapeHtml(tr('restoreArchived'))}</button>` : ''}
      ${review ? `<button class="button primary small" data-action="complete-task" data-id="${escapeHtml(task.id)}">${escapeHtml(tr('complete'))}</button>` : ''}
      ${running && task.status !== 'stopping' ? `<button class="button danger small" data-action="stop-task" data-id="${escapeHtml(task.id)}">${escapeHtml(tr('stop'))}</button>` : ''}
      ${canReset || !running ? `<details class="toolbar-menu detail-tools"><summary class="button secondary small">${escapeHtml(tr('moreActions'))}<span aria-hidden="true">⌄</span></summary><div class="toolbar-menu-panel">
        ${!running && !archived ? `<button class="button secondary small" data-action="edit-task" data-id="${escapeHtml(task.id)}">${escapeHtml(tr('edit'))}</button>` : ''}
        ${canReset ? `<button class="button secondary small" data-action="reset-task" data-id="${escapeHtml(task.id)}">${escapeHtml(tr('resetSession'))}</button>` : ''}
        ${!running ? `<button class="button danger small" data-action="delete-task" data-id="${escapeHtml(task.id)}">${escapeHtml(tr('deleteTaskArtifacts'))}</button>` : ''}
      </div></details>` : ''}
      <button class="icon-button" data-close="taskDetailModal" aria-label="${escapeHtml(tr('close'))}">&#215;</button>
    </div>`);
  renderHtml('taskContext', '#taskContext', taskContext(task));
  $$('#detailTabs [data-tab]').forEach((button) => button.classList.toggle('active', button.dataset.tab === state.detailTab));
  const composer = $('#continueTaskForm');
  composer.classList.toggle('hidden', archived || state.detailTab === 'task-terminal');
  setComposerExpanded(composer.dataset.expanded === 'true');
  $('#continueInput').disabled = running || task.enabled === false;
  $('#continueTaskBtn').disabled = running || task.enabled === false;
  $('#continueTaskBtn').textContent = review ? tr('continueTask') : (recover ? tr('recoverTask') : tr('startTask'));
  $('#composerHint').textContent = archived
    ? tr('archivedHint')
    : (task.enabled === false
      ? tr('disabledHint')
      : (task.status === 'waiting_scheduled'
        ? tr('scheduledHint')
        : (running ? tr('runningHint') : (review ? tr('reviewHint') : (recover ? tr('recoverHint') : tr('waitingStart'))))));
}

function detailPage(content) {
  const pager = state.detailOffset > 0 || state.detailHasOlder
    ? `<div class="detail-pager">
        <button class="button secondary small${state.detailOffset > 0 ? '' : ' hidden'}" data-action="detail-newer">${escapeHtml(tr('newer'))}</button>
        <button class="button secondary small${state.detailHasOlder ? '' : ' hidden'}" data-action="detail-older">${escapeHtml(tr('older'))}</button>
      </div>`
    : '';
  return `${pager}${content}`;
}

function renderTaskConsoleHtml(output, html) {
  if (renderCache.get('taskConsole') === html) return false;
  const scope = `${state.currentTaskId || ''}:${state.detailTab}`;
  const expanded = new Map(output.dataset.detailScope === scope
    ? [...(output.querySelectorAll?.('details[data-detail-key]') || [])].map(node => [node.dataset.detailKey, node.open])
    : []);
  disposeCodexTerminal();
  abortAttemptOutputLoad();
  disposeAttemptTerminals();
  const changed = renderHtml('taskConsole', output, html);
  output.dataset.detailScope = scope;
  for (const node of output.querySelectorAll?.('details[data-detail-key]') || []) {
    if (expanded.has(node.dataset.detailKey)) node.open = expanded.get(node.dataset.detailKey);
  }
  return changed;
}

async function loadOptionalSkillReports(taskId, signal, options = {}) {
  const history = options.history ? '&history=1' : '';
  const limit = Number(options.limit || 100);
  const reports = await api(
    `/api/sessions/${encodeURIComponent(taskId)}/skill-reports?limit=${limit}&offset=0${history}`,
    { signal, acceptedStatuses: [404] },
  );
  return Array.isArray(reports) ? reports : [];
}

async function loadOptionalSkillInvocations(taskId, signal, options = {}) {
  const limit = Number(options.limit || 100);
  const offset = Number(options.offset || 0);
  const invocations = await api(
    `/api/sessions/${encodeURIComponent(taskId)}/skill-invocations?limit=${limit}&offset=${offset}`,
    { signal, acceptedStatuses: [404] },
  );
  return Array.isArray(invocations) ? invocations : [];
}

function updateBackgroundTabAvailability(externalAttempts, scheduledJobs) {
  const tab = $('#detailTabs [data-tab="background"]');
  if (!tab) return;
  if (!Array.isArray(externalAttempts) || !Array.isArray(scheduledJobs)) {
    tab.classList.remove('hidden');
    tab.disabled = false;
    return;
  }
  const available = externalAttempts.length > 0 || scheduledJobs.length > 0;
  tab.classList.toggle('hidden', !available);
  tab.disabled = !available;
}

async function loadTaskConsole(options = {}) {
  const task = findTask(state.currentTaskId);
  if (!task) return;
  if (state.consoleController) state.consoleController.abort();
  const controller = new AbortController();
  state.consoleController = controller;
  const taskId = task.id;
  const detailTab = state.detailTab;
  const output = $('#taskConsoleOutput');
  if (options.showLoading !== false && !renderCache.has('taskConsole')) {
    renderTaskConsoleHtml(output, '<div class="loading-bar"></div>');
  }
  try {
    if (detailTab === 'business-summary') {
      const [steps, externalAttempts, scheduledJobs, skillReports, executions, pytestSummary] = await Promise.all([
        api(`/api/sessions/${encodeURIComponent(taskId)}/steps`, { signal: controller.signal }),
        api(`/api/sessions/${encodeURIComponent(taskId)}/external-attempts?limit=500&offset=0`, { signal: controller.signal }),
        api(`/api/sessions/${encodeURIComponent(taskId)}/scheduled-jobs?limit=500&offset=0`, { signal: controller.signal }),
        loadOptionalSkillReports(taskId, controller.signal, { history: true, limit: 500 }),
        api(`/api/sessions/${encodeURIComponent(taskId)}/executions?limit=500&offset=0`, { signal: controller.signal }),
        api(`/api/sessions/${encodeURIComponent(taskId)}/pytest-summary`, { signal: controller.signal, acceptedStatuses: [404] })
          .catch(error => { if (error.name === 'AbortError') throw error; return null; }),
      ]);
      if (controller.signal.aborted || state.currentTaskId !== taskId || state.detailTab !== detailTab) return;
      state.detailHasOlder = false;
      state.currentSkillReports = skillReports;
      state.currentExecutions = executions;
      updateBackgroundTabAvailability(externalAttempts, scheduledJobs);
      renderTaskConsoleHtml(output, businessSummaryTimeline(
        task, skillReports, externalAttempts, scheduledJobs, executions, steps, pytestSummary,
      ));
      return;
    }
    if (detailTab === 'business-reports') {
      const [externalAttempts, skillReports, steps] = await Promise.all([
        api(`/api/sessions/${encodeURIComponent(taskId)}/external-attempts?limit=500&offset=0`, { signal: controller.signal }),
        loadOptionalSkillReports(taskId, controller.signal, { limit: 500 }),
        api(`/api/sessions/${encodeURIComponent(taskId)}/steps`, { signal: controller.signal }),
      ]);
      if (controller.signal.aborted || state.currentTaskId !== taskId || state.detailTab !== detailTab) return;
      state.detailHasOlder = false;
      state.currentSkillReports = skillReports;
      renderTaskConsoleHtml(output, businessReportPage(skillReports, externalAttempts, steps));
      return;
    }
    if (detailTab === 'operations') {
      const page = await api(`/api/audit?sessionId=${encodeURIComponent(taskId)}&limit=${state.detailPageSize + 1}&offset=${state.detailOffset}`, { signal: controller.signal });
      if (controller.signal.aborted || state.currentTaskId !== taskId || state.detailTab !== detailTab) return;
      state.detailHasOlder = page.length > state.detailPageSize;
      const events = page.slice(0, state.detailPageSize);
      renderTaskConsoleHtml(output, detailPage(`<div class="event-list">${operationAuditList(events)}</div>`));
      return;
    }
    if (detailTab === 'task-terminal') {
      state.detailHasOlder = false;
      let managedStream = null;
      const interactive = task.status !== 'completed'
        && state.interactiveCodexTerminalTaskId === taskId;
      if (task.status !== 'completed' && !interactive) {
        const [attempts, externalAttempts] = await Promise.all([
          api(`/api/sessions/${encodeURIComponent(taskId)}/attempts?limit=50&offset=0`, { signal: controller.signal }),
          api(`/api/sessions/${encodeURIComponent(taskId)}/external-attempts?limit=50&offset=0`, { signal: controller.signal }),
        ]);
        if (controller.signal.aborted || state.currentTaskId !== taskId || state.detailTab !== detailTab) return;
        managedStream = managedCodexTerminalStream(task, attempts, externalAttempts);
      }
      const changed = renderTaskConsoleHtml(output, codexTerminalPage(Boolean(managedStream)));
      const currentView = state.codexTerminalView;
      const streamChanged = currentView?.managedStream?.kind !== managedStream?.kind
        || currentView?.managedStream?.id !== managedStream?.id;
      if (changed || !currentView || currentView.taskId !== taskId
        || currentView.mode !== (managedStream ? 'managed' : 'interactive') || streamChanged) {
        initializeCodexTerminal(task, managedStream);
      }
      return;
    }
    if (detailTab === 'agent-records') {
      const [worklogPage, invocationPage, executionPage] = await Promise.all([
        api(`/api/sessions/${encodeURIComponent(taskId)}/worklogs?limit=${state.detailPageSize + 1}&offset=${state.detailOffset}`, { signal: controller.signal }),
        loadOptionalSkillInvocations(taskId, controller.signal, {
          limit: state.detailPageSize + 1,
          offset: state.detailOffset,
        }),
        api(`/api/sessions/${encodeURIComponent(taskId)}/executions?limit=${state.detailPageSize + 1}&offset=${state.detailOffset}`, { signal: controller.signal }),
      ]);
      if (controller.signal.aborted || state.currentTaskId !== taskId || state.detailTab !== detailTab) return;
      state.detailHasOlder = worklogPage.length > state.detailPageSize
        || invocationPage.length > state.detailPageSize
        || executionPage.length > state.detailPageSize;
      const worklogEvents = worklogPage.slice(-state.detailPageSize);
      const invocations = invocationPage.slice(0, state.detailPageSize);
      const executions = executionPage.slice(0, state.detailPageSize);
      state.currentExecutions = executions;
      renderTaskConsoleHtml(output, detailPage(agentRecordsList(worklogEvents, executions, invocations)));
      return;
    }
    if (detailTab === 'background') {
      const [externalAttempts, scheduledJobs] = await Promise.all([
        api(`/api/sessions/${encodeURIComponent(taskId)}/external-attempts?limit=${state.detailPageSize}&offset=0`, { signal: controller.signal }),
        api(`/api/sessions/${encodeURIComponent(taskId)}/scheduled-jobs?limit=${state.detailPageSize}&offset=0`, { signal: controller.signal }),
      ]);
      if (controller.signal.aborted || state.currentTaskId !== taskId || state.detailTab !== detailTab) return;
      state.detailHasOlder = false;
      updateBackgroundTabAvailability(externalAttempts, scheduledJobs);
      renderTaskConsoleHtml(output, backgroundTrackingList(externalAttempts, scheduledJobs));
      return;
    }
  } catch (error) {
    if (error.name !== 'AbortError') {
      renderTaskConsoleHtml(output, `<div class="empty-state">${escapeHtml(error.message)}</div>`);
    }
  } finally {
    if (state.consoleController === controller) state.consoleController = null;
  }
}

async function openTaskDetail(id, initialTab = 'business-summary') {
  if (state.currentTaskId !== id) {
    renderCache.delete('taskConsole');
    state.taskContextExpanded = false;
    setComposerExpanded(Boolean($('#continueInput').value.trim()));
  }
  state.currentTaskId = id;
  state.detailTab = initialTab;
  state.detailOffset = 0;
  state.detailHasOlder = false;
  state.currentSkillReports = [];
  state.expandedAttemptOutputKey = '';
  state.taskTerminalAutoOpen = false;
  updateBackgroundTabAvailability();
  let task = findTask(id);
  if (!task) {
    task = await api(`/api/sessions/${encodeURIComponent(id)}`);
    state.dashboard.sessions.push(task);
  }
  renderTaskDetail(task);
  openModal('taskDetailModal');
  await loadTaskConsole();
}

async function runOrRecoverTask(event) {
  event.preventDefault();
  const task = findTask(state.currentTaskId);
  if (!task || task.enabled === false || task.status === 'completed' || isActiveTask(task)) return;
  const input = $('#continueInput').value.trim();
  const submitButton = $('#continueTaskBtn');
  submitButton.disabled = true;
  try {
    await queueTaskRun(task, input);
    $('#continueInput').value = '';
    setComposerExpanded(false);
    toast(tr('taskStarted'));
    await loadDashboard();
    renderTaskDetail(findTask(task.id));
    await loadTaskConsole();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    const latest = findTask(task.id);
    submitButton.disabled = !latest || latest.enabled === false
      || latest.status === 'completed' || isActiveTask(latest);
  }
}

async function recoverTask(id) {
  const task = findTask(id);
  if (!task || task.enabled === false || isActiveTask(task) || isReviewTask(task)
    || task.status === 'completed' || !needsTaskRecovery(task) || pendingTaskRecoveries.has(id)) return;
  pendingTaskRecoveries.add(id);
  renderOverview();
  renderTasks();
  renderReleaseCycles();
  try {
    const queuedTask = { ...task, ...await queueTaskRun(task) };
    upsertDashboardTask(queuedTask);
    state.releaseCycleTasks = state.releaseCycleTasks.map(item => item.id === id
      ? { ...item, ...queuedTask } : item);
    toast(tr('taskStarted'));
  } catch (error) {
    toast(error.message, 'error');
    return;
  } finally {
    pendingTaskRecoveries.delete(id);
    renderOverview();
    renderTasks();
    renderReleaseCycles();
  }
  try { await openTaskDetail(id); }
  finally { scheduleDashboardPoll(0); }
}

async function stopTask(id) {
  const task = findTask(id);
  if (!task) return;
  try {
    await requestTaskOperation(task, 'stop');
    toast(tr('stopRequested'));
  } catch (error) {
    toast(error.message, 'error');
    return;
  }
  try {
    await loadDashboard({ force: true });
    if (state.currentTaskId === id && !$('#taskDetailModal').classList.contains('hidden')) renderTaskDetail(findTask(id));
  } catch { scheduleDashboardPoll(0); }
}

async function completeTask(id) {
  if (!window.confirm(tr('confirmCompleteTask'))) return;
  const task = findTask(id);
  if (!task) return;
  try {
    await requestTaskOperation(task, 'complete');
    toast(tr('taskCompleted'));
  } catch (error) {
    toast(error.message, 'error');
    return;
  }
  try {
    await loadDashboard({ force: true });
    if (state.currentTaskId === id && !$('#taskDetailModal').classList.contains('hidden')) renderTaskDetail(findTask(id));
  } catch { scheduleDashboardPoll(0); }
}

async function restoreArchivedTask(id) {
  if (!window.confirm(tr('confirmRestoreTask'))) return;
  const task = findTask(id);
  if (!task) return;
  try {
    await requestTaskOperation(task, 'restore');
    toast(tr('taskRestored'));
  } catch (error) {
    toast(error.message, 'error');
    return;
  }
  try {
    await loadDashboard({ force: true });
    if (state.currentTaskId === id && !$('#taskDetailModal').classList.contains('hidden')) {
      renderTaskDetail(findTask(id));
    }
  } catch { scheduleDashboardPoll(0); }
}

async function resetTask(id) {
  if (!window.confirm(tr('confirmResetTask'))) return;
  const task = findTask(id);
  if (!task) return;
  try {
    await requestTaskOperation(task, 'reset');
    disposeCodexTerminal();
    toast(tr('taskReset'));
  } catch (error) {
    toast(error.message, 'error');
    return;
  }
  try {
    await loadDashboard({ force: true });
    if (state.currentTaskId === id && !$('#taskDetailModal').classList.contains('hidden')) {
      renderTaskDetail(findTask(id));
      await loadTaskConsole();
    }
  } catch { scheduleDashboardPoll(0); }
}

async function deleteTask(id, expectedCreatedAt = '') {
  try {
    const task = findTask(id) || await api(`/api/sessions/${encodeURIComponent(id)}`);
    if (expectedCreatedAt && expectedCreatedAt !== task.createdAt) throw new Error(tr('taskChangedRefresh'));
    if (!window.confirm(trf('confirmDeleteTaskArtifacts', { name: task.name || task.id }))) return;
    await requestTaskOperation(task, 'delete');
    if (state.currentTaskId === id) {
      closeModal('taskDetailModal');
      state.currentTaskId = '';
    }
    state.dashboard.sessions = (state.dashboard.sessions || []).filter(item => item.id !== id);
    state.expandedTaskObjectives.delete(id);
    renderOverview();
    renderTasks();
    toast(tr('taskArtifactsDeleted'));
  } catch (error) {
    toast(error.message, 'error');
    return;
  }
  try {
    await loadDashboard({ force: true });
    if (state.view === 'runtime') await loadBridgeInventory();
  } catch { scheduleDashboardPoll(0); }
}

async function openSkillAttributionEditor(executionId) {
  const execution = state.currentExecutions.find((item) => item.id === executionId);
  if (!execution || !state.currentTaskId) return;
  try {
    const usage = await api(`/api/sessions/${encodeURIComponent(state.currentTaskId)}/skill-usage`);
    state.editingExecutionId = executionId;
    state.skillUsage = usage;
    const selected = new Set((execution.skills || []).map((skill) => skill.skillId));
    $('#skillAttributionTitle').textContent = tr('correctAttribution');
    const options = (usage.skills || []).map((skill) => `
      <label class="attribution-option">
        <input type="checkbox" name="skillIds" value="${escapeHtml(skill.id)}" ${selected.has(skill.id) ? 'checked' : ''}>
        <span><strong>${escapeHtml(skill.id)}</strong><small>${escapeHtml(skill.name || skill.id)}</small></span>
        <code>v${Number(skill.version)} · ${escapeHtml(shortHash(skill.contentHash))}</code>
      </label>`).join('');
    $('#skillAttributionForm').innerHTML = `
      <div class="attribution-command full"><span>${escapeHtml(tr('fullCommand'))}</span><code>${escapeHtml(execution.command || '-')}</code></div>
      <fieldset class="attribution-picker full"><legend>${escapeHtml(tr('skillSnapshotOptions'))}</legend>${options || `<p>${escapeHtml(tr('noSnapshotSkills'))}</p>`}</fieldset>
      <label class="field full"><span>${escapeHtml(tr('correctionReason'))}</span><textarea name="reason" required maxlength="2000" placeholder="${escapeHtml(tr('correctionReasonHint'))}"></textarea></label>
      <div class="form-actions full"><button class="button secondary" type="button" data-close="skillAttributionModal">${escapeHtml(tr('cancel'))}</button><button class="button primary" type="submit">${escapeHtml(tr('saveCorrection'))}</button></div>`;
    openModal('skillAttributionModal');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function saveSkillAttribution(event) {
  event.preventDefault();
  const submitButton = event.currentTarget.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  const form = new FormData(event.currentTarget);
  try {
    await api(`/api/sessions/${encodeURIComponent(state.currentTaskId)}/executions/${encodeURIComponent(state.editingExecutionId)}/skills`, {
      method: 'PUT',
      body: {
        skillIds: form.getAll('skillIds'),
        reason: form.get('reason'),
      },
    });
    closeModal('skillAttributionModal');
    toast(tr('skillAttributionSaved'));
    renderCache.delete('taskConsole');
    await loadTaskConsole({ showLoading: false });
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    submitButton.disabled = false;
  }
}

function openSkillEditor(skill = null) {
  state.editingSkillId = skill?.id || '';
  const readOnly = Boolean(skill?.readOnly);
  $('#skillEditorTitle').textContent = tr(readOnly ? 'viewSkill' : (skill ? 'editSkill' : 'createSkill'));
  $('#skillForm').innerHTML = `
    <label class="field"><span>${escapeHtml(tr('skillName'))}</span><input name="name" required maxlength="200" ${readOnly ? 'disabled' : ''} value="${escapeHtml(skill?.name || '')}"></label>
    <label class="field"><span>ID</span><input name="id" required maxlength="64" ${(skill || readOnly) ? 'disabled' : ''} value="${escapeHtml(skill?.id || '')}"></label>
    <label class="field"><span>${escapeHtml(tr('category'))}</span><input name="category" maxlength="100" ${readOnly ? 'disabled' : ''} value="${escapeHtml(skill?.category || 'General')}"></label>
    <label class="field"><span>${escapeHtml(tr('tags'))}</span><input name="tags" ${readOnly ? 'disabled' : ''} value="${escapeHtml((skill?.tags || []).join(', '))}"></label>
    <label class="field full"><span>${escapeHtml(tr('description'))}</span><textarea name="description" maxlength="4096" ${readOnly ? 'disabled' : ''}>${escapeHtml(skill?.description || '')}</textarea></label>
    <label class="check-field"><input type="checkbox" name="enabled" ${skill?.enabled === false ? '' : 'checked'} ${readOnly ? 'disabled' : ''}><span>${escapeHtml(tr('enabled'))}</span></label>
    <label class="field full"><span>${escapeHtml(tr('skillContent'))}</span><textarea class="code-input" name="content" maxlength="786432" ${readOnly ? 'disabled' : ''}>${escapeHtml(skill?.content || '# Skill\n')}</textarea></label>
    <div class="form-actions full">
      ${skill && !readOnly ? `<button class="button danger" type="button" data-action="delete-skill" data-id="${escapeHtml(skill.id)}">${escapeHtml(tr('delete'))}</button>` : '<span></span>'}
      <div><button class="button secondary" type="button" data-close="skillEditorModal">${escapeHtml(tr('close'))}</button>${readOnly ? '' : `<button class="button primary" type="submit">${escapeHtml(tr('save'))}</button>`}</div>
    </div>`;
  openModal('skillEditorModal');
}

async function saveSkill(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const id = state.editingSkillId || slugify(form.get('id'));
  const payload = {
    id,
    name: form.get('name'),
    category: form.get('category'),
    description: form.get('description'),
    tags: String(form.get('tags') || '').split(',').map((item) => item.trim()).filter(Boolean),
    enabled: form.get('enabled') === 'on',
    content: form.get('content'),
  };
  try {
    await api(state.editingSkillId ? `/api/skills/${encodeURIComponent(id)}` : '/api/skills', { method: state.editingSkillId ? 'PUT' : 'POST', body: payload });
    closeModal('skillEditorModal');
    toast(tr('skillSaved'));
    await Promise.all([loadSkills(), loadDashboard()]);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function deleteSkill(id) {
  if (!window.confirm(tr('confirmDeleteSkill'))) return;
  try {
    await api(`/api/skills/${encodeURIComponent(id)}`, { method: 'DELETE' });
    closeModal('skillEditorModal');
    toast(tr('skillDeleted'));
    await Promise.all([loadSkills(), loadDashboard()]);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function toggleSkill(id, enabled) {
  try {
    await api(`/api/skills/${encodeURIComponent(id)}/enabled`, {
      method: 'PATCH',
      body: { enabled },
    });
    toast(tr(enabled ? 'skillEnabled' : 'skillDisabled'));
    await Promise.all([loadSkills(), loadDashboard()]);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function uploadSkillZip(file, overwrite = false) {
  return api(`/api/skills/import?overwrite=${overwrite ? 'true' : 'false'}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/zip' },
    body: file,
  });
}

async function importSkillZip(file) {
  if (file.size > 8 * 1024 * 1024) {
    toast(tr('zipTooLarge'), 'error');
    return;
  }
  try {
    let result;
    try {
      result = await uploadSkillZip(file);
    } catch (error) {
      if (error.status !== 409 || !window.confirm(tr('confirmOverwriteSkill'))) throw error;
      result = await uploadSkillZip(file, true);
    }
    toast(`${tr('skillZipImported')}: ${Number(result.count || 0)}`);
    await Promise.all([loadSkills(), loadDashboard(), loadAudit()]);
  } catch (error) {
    toast(error.message, 'error');
  }
}

function exportBundle() {
  api('/api/export').then((bundle) => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
    link.download = `codex-task-sessions-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  }).catch((error) => toast(error.message, 'error'));
}

async function importBundle(file) {
  try {
    const bundle = JSON.parse(await file.text());
    await api('/api/import', { method: 'POST', body: { bundle, mode: 'merge' } });
    toast(tr('imported'));
    await Promise.all([loadDashboard(), loadSkills(), loadAudit()]);
  } catch (error) {
    toast(error.message, 'error');
  }
}

function findBridgeInventorySession(sessionId) {
  return (state.bridgeInventory.sessions || []).find((session) => session.sessionId === sessionId) || null;
}

function validateBridgeReclaimConfirmation() {
  const matches = Boolean(state.selectedBridgeSessionId)
    && !state.bridgeReclaimSubmitting
    && $('#bridgeReclaimInput').value === state.selectedBridgeSessionId;
  $('#confirmBridgeReclaimBtn').disabled = !matches;
  return matches;
}

function openBridgeReclaim(sessionId) {
  if (state.bridgeReclaimSubmitting) {
    toast(tr('bridgeReclaimInProgress'), 'error');
    return;
  }
  const session = findBridgeInventorySession(sessionId);
  if (!session?.reclaimable) {
    toast(tr('bridgeSessionNoLongerReclaimable'), 'error');
    return;
  }
  state.selectedBridgeSessionId = session.sessionId;
  $('#bridgeReclaimTarget').textContent = session.sessionId;
  $('#bridgeReclaimInput').value = '';
  $('#bridgeReclaimInput').disabled = false;
  $('#confirmBridgeReclaimBtn').disabled = true;
  openModal('bridgeReclaimModal');
}

async function reconcileBridgeReclaim(sessionId) {
  try {
    await loadBridgeInventory();
    const session = findBridgeInventorySession(sessionId);
    return !session || Boolean(session.cleanupJob);
  } catch {
    return false;
  }
}

async function submitBridgeReclaim(event) {
  event.preventDefault();
  if (state.bridgeReclaimSubmitting) return;
  const sessionId = state.selectedBridgeSessionId;
  if (!validateBridgeReclaimConfirmation()) return;
  const button = $('#confirmBridgeReclaimBtn');
  const input = $('#bridgeReclaimInput');
  state.bridgeReclaimSubmitting = true;
  button.disabled = true;
  input.disabled = true;
  renderBridgeInventory();
  try {
    const result = await api(`/api/runtime/bridge-sessions/${encodeURIComponent(sessionId)}/reclaim`, {
      method: 'DELETE',
      body: { confirmationSessionId: sessionId },
    });
    closeModal('bridgeReclaimModal');
    toast(tr(result?.job?.status === 'completed' ? 'bridgeReclaimCompleted' : 'bridgeReclaimQueued'));
    await loadBridgeInventory();
  } catch (error) {
    if (error.name === 'RequestTimeoutError') {
      const reconciled = await reconcileBridgeReclaim(sessionId);
      if (reconciled) {
        closeModal('bridgeReclaimModal');
        toast(tr('bridgeReclaimQueued'));
        return;
      }
      toast(tr('bridgeReclaimOutcomeUnknown'), 'error');
    } else {
      await loadBridgeInventory().catch(() => {});
      if (!findBridgeInventorySession(sessionId)?.reclaimable) closeModal('bridgeReclaimModal');
      toast(error.message, 'error');
    }
  } finally {
    state.bridgeReclaimSubmitting = false;
    renderBridgeInventory();
    if (state.selectedBridgeSessionId === sessionId) {
      input.disabled = false;
      validateBridgeReclaimConfirmation();
    }
  }
}

document.addEventListener('click', async (event) => {
  $$('.toolbar-menu[open]').forEach((menu) => {
    if (!menu.contains(event.target) || event.target.closest('[data-action]')) menu.open = false;
  });
  const nav = event.target.closest('[data-view]');
  if (nav) setView(nav.dataset.view);
  const close = event.target.closest('[data-close]');
  if (close) closeModal(close.dataset.close);
  const filter = event.target.closest('#taskFilters [data-status]');
  if (filter) {
    state.taskFilter = filter.dataset.status;
    $$('#taskFilters button').forEach((button) => button.classList.toggle('active', button === filter));
    renderTasks();
  }
  const tab = event.target.closest('#detailTabs [data-tab]');
  if (tab) {
    disposeCodexTerminal();
    abortAttemptOutputLoad();
    disposeAttemptTerminals();
    state.detailTab = tab.dataset.tab;
    $('#taskDetailModal').dataset.detailTab = state.detailTab;
    state.expandedAttemptOutputKey = '';
    state.taskTerminalAutoOpen = false;
    state.detailOffset = 0;
    state.detailHasOlder = false;
    renderCache.delete('taskConsole');
    $$('#detailTabs button').forEach((button) => button.classList.toggle('active', button === tab));
    const task = findTask(state.currentTaskId);
    if (task) renderTaskDetail(task);
    await loadTaskConsole();
  }
  const action = event.target.closest('[data-action]');
  if (!action) return;
  const id = action.dataset.id;
  if (action.dataset.action === 'toggle-composer') setComposerExpanded($('#continueTaskForm').dataset.expanded !== 'true', true);
  if (action.dataset.action === 'copy-report-name') await copyReportFilename(action.dataset.copyText || '');
  if (action.dataset.action === 'new-task') openTaskEditor();
  if (action.dataset.action === 'new-release-cycle') openReleaseCycleEditor();
  if (action.dataset.action === 'open-task') await openTaskDetail(id);
  if (action.dataset.action === 'open-task-terminal') {
    await openTaskDetail(id, 'task-terminal');
  }
  if (action.dataset.action === 'open-task-reports') {
    await openTaskDetail(id, 'business-reports');
  }
  if (action.dataset.action === 'open-release-cycle') await toggleReleaseCycle(id);
  if (action.dataset.action === 'open-overview-cycle') await openOverviewReleaseCycle(action.dataset.cycleId, action.dataset.business);
  if (action.dataset.action === 'overview-cycle-page') await openOverviewReleaseCycle(state.overviewCycleModal.cycleId, state.overviewCycleModal.business, action.dataset.page);
  if (action.dataset.action === 'collapse-release-cycle') collapseReleaseCycle();
  if (action.dataset.action === 'close-release-cycle') await closeReleaseCycle(id || state.selectedReleaseCycleId);
  if (action.dataset.action === 'delete-release-cycle') await deleteReleaseCycle(id || state.selectedReleaseCycleId);
  if (action.dataset.action === 'refresh-release-cycles') await loadReleaseCycles();
  if (action.dataset.action === 'toggle-task-context') {
    state.taskContextExpanded = !state.taskContextExpanded;
    const task = findTask(state.currentTaskId);
    if (task) renderTaskDetail(task);
  }
  if (action.dataset.action === 'edit-task') openTaskEditor(findTask(id));
  if (action.dataset.action === 'recover-task') await recoverTask(id);
  if (action.dataset.action === 'stop-task') await stopTask(id);
  if (action.dataset.action === 'complete-task') await completeTask(id);
  if (action.dataset.action === 'restore-task') await restoreArchivedTask(id);
  if (action.dataset.action === 'reset-task') await resetTask(id);
  if (action.dataset.action === 'delete-task') await deleteTask(id, action.dataset.taskCreatedAt);
  if (action.dataset.action === 'new-skill') openSkillEditor();
  if (action.dataset.action === 'edit-skill') {
    try {
      openSkillEditor(await api(`/api/skills/${encodeURIComponent(id)}`));
    } catch (error) {
      toast(error.message, 'error');
    }
  }
  if (action.dataset.action === 'delete-skill') await deleteSkill(id);
  if (action.dataset.action === 'toggle-skill') await toggleSkill(id, action.dataset.enabled === 'true');
  if (action.dataset.action === 'reclaim-bridge-session') openBridgeReclaim(id);
  if (action.dataset.action === 'correct-execution-skills') await openSkillAttributionEditor(id);
  if (action.dataset.action === 'view-attempt-output') await toggleAttemptOutput(action);
  if (action.dataset.action === 'codex-cli-toggle-input') {
    setCodexTerminalInputUnlocked(state.codexTerminalView, action.checked);
  }
  if (action.dataset.action === 'codex-cli-interrupt') sendUnlockedCodexTerminalControl('interrupt');
  if (action.dataset.action === 'codex-cli-clear') state.codexTerminalView?.terminal.clear();
  if (action.dataset.action === 'codex-cli-reconnect') {
    const task = findTask(state.currentTaskId);
    if (task) {
      if (isActiveTask(task)) {
        if (state.interactiveCodexTerminalTaskId === task.id) state.interactiveCodexTerminalTaskId = '';
        renderCache.delete('taskConsole');
        await loadTaskConsole({ showLoading: false });
      } else {
        if (task.status !== 'completed') state.interactiveCodexTerminalTaskId = task.id;
        disposeCodexTerminal();
        initializeCodexTerminal(task);
      }
    }
  }
  if (action.dataset.action === 'codex-cli-terminate') sendUnlockedCodexTerminalControl('terminate');
  if (action.dataset.action === 'detail-newer') {
    state.detailOffset = Math.max(0, state.detailOffset - state.detailPageSize);
    state.expandedAttemptOutputKey = '';
    state.taskTerminalAutoOpen = false;
    await loadTaskConsole();
  }
  if (action.dataset.action === 'detail-older') {
    state.detailOffset += state.detailPageSize;
    state.expandedAttemptOutputKey = '';
    state.taskTerminalAutoOpen = false;
    await loadTaskConsole();
  }
  if (action.dataset.action === 'go-audit') setView('audit');
  if (action.dataset.action === 'go-history') {
    state.taskFilter = 'history';
    $$('#taskFilters button').forEach((button) => button.classList.toggle('active', button.dataset.status === 'history'));
    setView('tasks');
    renderTasks();
  }
});

document.addEventListener('toggle', (event) => {
  const description = event.target;
  const id = description.dataset?.objectiveId;
  if (!id || !description.isConnected) return;
  if (description.open) state.expandedTaskObjectives.add(id);
  else state.expandedTaskObjectives.delete(id);
  $$('.task-description').forEach((element) => {
    if (element.dataset.objectiveId === id && element.open !== description.open) element.open = description.open;
  });
}, true);

$$('.modal').forEach((modal) => modal.addEventListener('click', (event) => {
  if (event.target === modal) closeModal(modal.id);
}));

$('#taskForm').addEventListener('submit', saveTask);
$('#releaseCycleForm').addEventListener('submit', saveReleaseCycle);
$('#taskProjectFilter').addEventListener('change', (event) => {
  state.taskProjectFilter = event.target.value;
  renderTasks();
});
$('#taskTagFilter').addEventListener('change', (event) => {
  state.taskTagFilter = event.target.value;
  renderTasks();
});
$('#taskTestTypeFilter').addEventListener('change', (event) => {
  state.taskTestTypeFilter = event.target.value;
  renderTasks();
});
$('#taskOriginFilter').addEventListener('change', (event) => {
  state.taskOriginFilter = event.target.value;
  renderTasks();
});
$('#skillForm').addEventListener('submit', saveSkill);
$('#skillAttributionForm').addEventListener('submit', saveSkillAttribution);
$('#bridgeReclaimForm').addEventListener('submit', submitBridgeReclaim);
$('#bridgeReclaimInput').addEventListener('input', validateBridgeReclaimConfirmation);
$('#continueTaskForm').addEventListener('submit', runOrRecoverTask);
$('#auditFilterForm').addEventListener('submit', (event) => {
  event.preventDefault();
  state.auditOffset = 0;
  loadAudit().catch((error) => toast(error.message, 'error'));
});
$('#langToggleBtn').addEventListener('click', () => {
  state.lang = state.lang === 'zh' ? 'en' : 'zh';
  try { localStorage.setItem('codex-tasks-lang-v1', state.lang); } catch {}
  renderCache.clear();
  renderAll();
  if (state.currentTaskId && !$('#taskDetailModal').classList.contains('hidden')) renderTaskDetail(findTask(state.currentTaskId));
});
$('#fontSizeControl').addEventListener('click', (event) => {
  const button = event.target.closest('[data-font-size]');
  if (button) setFontSize(button.dataset.fontSize);
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const openMenu = $$('.toolbar-menu[open]').at(-1);
  if (openMenu) {
    openMenu.open = false;
    openMenu.querySelector('summary').focus();
    return;
  }
  if (state.detailTab === 'task-terminal' && state.codexTerminalView) return;
  const modal = [...document.querySelectorAll('.modal:not(.hidden)')].at(-1);
  if (modal) closeModal(modal.id);
});
$('#topNewTaskBtn').addEventListener('click', () => openTaskEditor());
$('#loadMoreTasksBtn').addEventListener('click', async () => {
  state.taskLimit = Math.min(state.taskLimitMax, state.taskLimit + 100);
  await loadDashboard({ force: true });
});
$('#loadMoreAuditBtn').addEventListener('click', async () => {
  state.auditOffset += state.auditPageSize;
  await loadAudit();
});
$('#newerAuditBtn').addEventListener('click', async () => {
  state.auditOffset = Math.max(0, state.auditOffset - state.auditPageSize);
  await loadAudit();
});
$('#syncBtn').addEventListener('click', async () => {
  try {
    await api('/api/runtime/sync', { method: 'POST' });
    toast(tr('synced'));
    await Promise.all([loadDashboard(), loadSkills()]);
  } catch (error) { toast(error.message, 'error'); }
});
$('#refreshBridgeInventoryBtn').addEventListener('click', () => {
  loadRuntimeView();
});
$('#exportBtn').addEventListener('click', exportBundle);
$('#importBtn').addEventListener('click', () => $('#importInput').click());
$('#importInput').addEventListener('change', (event) => {
  if (event.target.files[0]) importBundle(event.target.files[0]);
  event.target.value = '';
});
$('#importSkillBtn').addEventListener('click', () => $('#skillZipInput').click());
$('#skillZipInput').addEventListener('change', (event) => {
  if (event.target.files[0]) importSkillZip(event.target.files[0]);
  event.target.value = '';
});

function dashboardPollDelay() {
  if (state.dashboardUnavailable) {
    return Math.min(30000, 1000 * (2 ** Math.min(5, state.dashboardFailureCount)));
  }
  const sessions = state.dashboard.sessions || [];
  if (sessions.some(isActiveTask)) return 2000;
  const progressPending = sessions.some((task) => (
    [task?.testProgress?.runs?.initial, task?.testProgress?.runs?.rerun1]
      .some((run) => run?.available && !['completed', 'unavailable'].includes(run.status))
  ));
  return progressPending ? CASE_PROGRESS_POLL_INTERVAL_MS : 10000;
}

function scheduleDashboardPoll(delay = dashboardPollDelay()) {
  clearTimeout(dashboardPollTimer);
  dashboardPollTimer = null;
  if (document.hidden) return;
  dashboardPollTimer = setTimeout(refreshDashboard, delay);
}

async function refreshDashboard() {
  if (document.hidden) return;
  const previousTask = findTask(state.currentTaskId);
  try {
    const changed = await loadDashboard();
    const task = findTask(state.currentTaskId);
    const detailOpen = task && !$('#taskDetailModal').classList.contains('hidden');
    const selectedTaskChanged = task && (!previousTask
      || task.version !== previousTask.version
      || task.updatedAt !== previousTask.updatedAt);
    if (detailOpen && changed && document.activeElement !== $('#continueInput')) renderTaskDetail(task);
    if (detailOpen && state.detailTab === 'task-terminal' && isActiveTask(task)
      && selectedTaskChanged && (state.codexTerminalView?.ended
        || state.codexTerminalView?.managedStream?.kind === 'waiting'
        || task.status !== previousTask?.status)) {
      renderCache.delete('taskConsole');
      await loadTaskConsole({ showLoading: false });
    } else if (detailOpen && ['business-summary', 'business-reports'].includes(state.detailTab)
      && state.detailOffset === 0) {
      await loadTaskConsole({ showLoading: false });
    } else if (detailOpen && state.detailTab !== 'task-terminal' && state.detailOffset === 0
      && (isActiveTask(task) || isActiveTask(previousTask))) {
      await loadTaskConsole({ showLoading: false });
    }
  } catch (error) {
    if (error.name !== 'AbortError') console.warn('Dashboard refresh failed');
  } finally {
    scheduleDashboardPoll();
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTimeout(releaseCycleDeletionPollTimer);
    releaseCycleDeletionPollTimer = null;
    clearTimeout(dashboardPollTimer);
    dashboardPollTimer = null;
    clearTimeout(bridgeInventoryPollTimer);
    bridgeInventoryPollTimer = null;
    clearTimeout(protectionPollTimer);
    protectionPollTimer = null;
    if (state.consoleController) state.consoleController.abort();
    disposeCodexTerminal();
    abortAttemptOutputLoad();
    disposeAttemptTerminals();
    if (state.bridgeInventoryController) state.bridgeInventoryController.abort();
    if (state.protectionController) state.protectionController.abort();
    return;
  }
  scheduleDashboardPoll(0);
  if (state.view === 'release-cycles') loadReleaseCycles().catch(() => {});
  if (state.view === 'runtime') loadRuntimeView();
  if (state.detailTab === 'task-terminal' && !$('#taskDetailModal').classList.contains('hidden')) {
    renderCache.delete('taskConsole');
    loadTaskConsole({ showLoading: false }).catch(() => {});
  }
});

window.addEventListener('pagehide', () => {
  clearTimeout(releaseCycleDeletionPollTimer);
  clearTimeout(dashboardPollTimer);
  clearTimeout(bridgeInventoryPollTimer);
  clearTimeout(protectionPollTimer);
  if (state.consoleController) state.consoleController.abort();
  disposeCodexTerminal();
  abortAttemptOutputLoad();
  disposeAttemptTerminals();
  if (state.auditController) state.auditController.abort();
  if (state.bridgeInventoryController) state.bridgeInventoryController.abort();
  if (state.protectionController) state.protectionController.abort();
}, { once: true });

async function initialize() {
  applyFontSize();
  applyTranslations();
  try {
    await Promise.all([loadDashboard({ force: true }), loadSkills()]);
    await reconcilePersistedTaskOperationIntents();
  } catch (error) {
    if (error?.status === 401) return;
    toast(`${tr('loadFailed')}: ${error.message}`, 'error');
  }
  scheduleDashboardPoll();
}

initAuthForm();
initialize();
