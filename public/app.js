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
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const user = document.getElementById('authUser').value.trim();
      const pass = document.getElementById('authPass').value;
      if (!user || !pass) return;
      storeCredentials(user, pass);
      hideAuthOverlay();
      initialize();
    });
  }
  const logout = document.getElementById('authLogout');
  if (logout) {
    logout.addEventListener('click', () => {
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
const TASK_OPERATION_INTENT_STORAGE_KEY = 'codex-task-operation-intents-v1';
const TASK_OPERATION_INTENT_STORAGE_LIMIT = 100;
const TASK_OPERATIONS = new Set(['stop', 'complete', 'restore', 'reset', 'delete']);
const taskOperationIntents = loadTaskOperationIntents();
let dashboardPollTimer = null;
let bridgeInventoryPollTimer = null;
let protectionPollTimer = null;
const API_REQUEST_TIMEOUT_MS = 30000;
const DASHBOARD_REQUEST_TIMEOUT_MS = 8000;
const INLINE_ATTEMPT_OUTPUT_MAX_BYTES = 5 * 1024 * 1024;
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
    brandSubtitle: '持久任务工作台', navOverview: '总览', navTasks: '任务 Session', navSkills: 'Skills', navAudit: '操作审计',
    fontSize: '文字大小', fontSizeSmall: '小号文字', fontSizeStandard: '标准文字', fontSizeLarge: '大号文字',
    export: '导出', import: '导入', syncRuntime: '同步 Runtime', newTask: '新建任务', executionMode: '执行模式',
    overviewHeadline: '任务即 Session，持续工作直到确认完成', overviewDescription: '每个任务拥有独立持久 Session；每轮结果可继续处理，确认完成后进入只读历史。',
    liveFloor: '当前任务', currentSessionsHeading: '任务 Sessions', recentActivity: '最近活动', recentOperations: '最近操作', viewAll: '查看全部',
    completedSessions: '已完成 Sessions', recentHistory: '最近完成记录', viewHistory: '查看历史', loadMore: '加载更多', newer: '较新记录', older: '更早记录',
    filterCurrent: '当前任务', filterRunning: '工作中', filterHistory: '历史记录',
    skillsNote: '任务首次启动时冻结平台 Skill 与 Codex Skill 快照，恢复时保持版本一致。', newSkill: '新建 Skill', importSkillZip: '导入 ZIP',
    taskId: '任务 ID', eventType: '事件类型', searchAudit: '搜索操作内容', filter: '筛选', persistentSession: '持久 Session',
    businessSummary: '任务摘要', agentRecords: 'Agent 记录', worklog: 'Agent 工作记录', taskTerminal: 'Codex CLI', commands: 'Agent 命令', background: '后台与调度', operations: '操作审计', continuePlaceholder: '输入启动或恢复这个任务的指令',
    cliConnecting: '正在连接', cliConnected: '已连接', cliDisconnected: '连接已断开', cliEnded: 'CLI 已结束', cliReconnect: '重新连接', cliInterrupt: '中断', cliClear: '清屏', cliTerminate: '结束 CLI', cliReadOnly: '只读', cliUnlockInput: '解锁输入', cliInputUnlocked: '允许输入',
    interactiveCliConflict: '该任务仍有正在运行的 Codex CLI。请在任务详情的「Codex CLI」页签点击「结束 CLI」，然后重新{operation}。', taskOperationRunning: '启动任务', taskOperationDeleting: '删除任务', taskOperationCompleting: '完成任务', taskOperationResetting: '重置上下文', taskOperationRetry: '执行此操作',
    businessCommands: '主要执行', businessExecution: '业务执行', executionRuns: '执行记录', repeatedRuns: '重复执行', primarySkill: '实际执行 Skill',
    businessTimeline: '业务轨迹', taskTimeline: '任务轨迹', businessResult: '业务结果', regressionCommands: 'pytest 回归命令', currentStage: '当前阶段', currentStatus: '当前状态', taskCreated: '任务已创建', structuredResult: '结构化结果', requestReceived: '收到提测报告', testExecutionStarted: '执行测试', deploymentCompleted: '部署完成', initialRegression: '首轮回归', regressionRerun: 'Rerun', followupBooked: '预约回查', initialCompleted: '首轮完成', rerunCompleted: 'Rerun 完成', failureAnalysis: 'Fail 分析', failureAnalysisCompleted: 'Fail 分析完成', failureAnalysisPending: '已检测到 analyze-failures 执行，等待结构化分析结论。', failureAnalysisUnreported: '已使用 analyze-failures，结构化分析结论尚未登记。', runInProgress: '第 {number} 次 pytest 正在执行。', finalResult: '最终结果', currentResult: '当前结果', waitingForTestResult: '等待业务测试结果', noPytestRuns: '暂无 pytest 回归记录', scheduledFor: '回查时间', startedAtShort: '开始', finishedAtShort: '结束', pytestCommand: 'PYTEST COMMAND', skillUsed: '使用 Skill', cicdDeployment: 'CI/CD 部署', gwDeployment: 'GW 部署', serviceDeployment: '服务部署', exitCodeSummary: '退出码 {code}', testRunNumber: '第 {number} 次回归',
    overviewTitle: '持久任务总览', overviewSubtitle: '一个任务对应一个独立、可恢复、可审计的 Codex Session。',
    tasksTitle: '任务 Session', tasksSubtitle: '每轮执行后等待确认；只有明确完成的 Session 才进入只读历史。',
    skillsTitle: 'Skills 管理', skillsSubtitle: '管理平台 Skill，并查看当前 Codex Runtime 可发现的内置 Skills。',
    auditTitle: '操作审计', auditSubtitle: '按任务查看创建、启动、恢复、命令、错误和完成记录。',
    sessions: 'Session 总数', current: '当前任务', working: '工作中', history: '历史记录', skills: 'Skills', operationsCount: '操作记录',
    idle: '待启动', pending: '待执行', leased: '执行中', queued: '排队中', running: '工作中', recovering: '恢复中', stopping: '停止中', waiting_scheduled: '后台运行中', waiting_review: '待确认', waiting_input: '待输入', completed: '已完成', succeeded: '成功', failed: '失败', lost: '进程失联', cancelled: '已取消', interrupted: '已中断', stopped: '已停止', recoverable: '可恢复', disabled: '已禁用',
    open: '查看', terminal: '终端', start: '启动任务', recover: '恢复任务', restoreArchived: '恢复并继续', resetSession: '重置上下文', continueTask: '继续任务', reviewTask: '查看结果', complete: '确认完成', stop: '停止', edit: '编辑', delete: '删除', close: '关闭', save: '保存', cancel: '取消',
    noCurrentTasks: '当前没有任务。新建任务会创建一个独立 Session。', noHistory: '还没有已完成的 Session。', noAudit: '没有匹配的操作记录。', noSkills: '没有可用 Skill。',
    taskName: '任务名称', objective: '任务目标 / 首次指令', workingDir: '工作目录', notes: '备注', enabled: '启用',
    maxRetries: '中断重试次数', autoResume: '服务重启后自动恢复', createAndStart: '创建并启动', updateTask: '更新任务', createTask: '新建任务 Session', editTask: '编辑任务',
    idHint: '只允许字母、数字、短横线和下划线', pathHint: '相对路径以任务工作区根目录为基准；绝对路径必须位于允许的根目录内。',
    taskContext: '任务上下文', sessionId: 'Session ID', status: '状态', runCount: '执行次数', recoveryAttempts: '自动恢复次数', createdAt: '创建时间', finishedAt: '完成时间', workspace: '工作区', nextCheck: '下次检查', activeBackground: '活动后台执行', activeSchedules: '活动定时检查',
    waitingStart: '创建后将立即启动独立 Session。', runningHint: '任务正在执行，日志会自动刷新。', scheduledHint: 'Codex 已释放；平台将在到点后恢复同一 Session，并创建新的 Turn 检查后台结果。', reviewHint: '检查本轮结果；可以继续发送指令，或确认完成并归档。', archivedHint: '该 Session 已完成并归档，不能再次运行。', recoverHint: '恢复会继续使用 Task 当前最新的持久 Session，不会创建新会话。', disabledHint: '任务已禁用，启用后才能启动或继续。',
    startTask: '启动任务', recoverTask: '恢复任务', taskStarted: '任务已排队', taskSaved: '任务已保存', taskDeleted: '任务已删除', taskCompleted: '任务已确认完成', taskRestored: '任务已恢复，可重新连接 Codex CLI', taskReset: '任务配置和历史已保留，后续运行将创建新的 Codex Session', stopRequested: '已请求停止任务', stopNotApplicable: '任务当前不需要停止', operationOutcomeUnknown: '请求结果暂时无法确认；系统已保留操作标识，重试不会重复执行',
    skillName: 'Skill 名称', category: '分类', description: '描述', tags: '标签（逗号分隔）', skillContent: 'SKILL.md 内容', createSkill: '新建 Skill', editSkill: '编辑 Skill', viewSkill: '查看 Skill',
    sourceCodex: 'Codex 内置', sourceManaged: '平台托管', readOnly: '只读', skillSaved: 'Skill 已保存', skillDeleted: 'Skill 已删除', skillEnabled: 'Skill 已启用', skillDisabled: 'Skill 已停用', enable: '启用', disable: '停用', files: '文件', skillZipImported: 'Skill 压缩包已导入', confirmOverwriteSkill: '存在同名平台 Skill，是否覆盖并生成新版本？', zipTooLarge: 'Skill ZIP 不能超过 8 MiB',
    runtimeReady: '执行服务已就绪', runtimeMissing: '执行服务不可用', runtimePaused: '任务执行已暂停', runtimeConnectionIssue: '平台连接异常', runtimeReconnecting: '正在重新连接', runtimeDashboardUnavailable: '平台状态无法刷新', dashboardRequestTimeout: 'Dashboard 请求超时', requestTimeout: '请求超时，结果未知；请刷新状态后再决定是否重试', runtimeUnsupportedPlatform: '当前平台不受支持', runtimeExecutorUnavailable: 'Codex 执行器不可用', runtimeWorkerUnavailable: 'Session Worker 不可用', runtimeExecutionUserUnsafe: '执行账户安全策略未满足', runtimeWorkspaceUnavailable: '任务工作区不可用', runtimeStorageUnavailable: '持久存储不可用', runtimeStorageLow: '持久存储空间不足', runtimeProcessMismatch: '执行进程身份校验失败', runtimeSupervisorUnavailable: 'Web Supervisor 监管中断', runtimeLauncherUnavailable: 'Host Launcher 监管中断', runtimeMaintenance: '平台正在维护', fullAccess: '最高权限', apiRequests: 'API 请求', logStreams: '日志流', synced: '运行状态已同步', imported: '配置已导入', confirmCompleteTask: '确认这个任务已经完成并归档吗？归档后仅保留只读记录，需要时可以显式恢复。', confirmRestoreTask: '恢复这个已归档任务并继续当前最新的 Codex Session 吗？', confirmResetTask: '重置当前 Codex 上下文吗？Task 配置、ID 和历史记录会保留；旧 Runtime 将被回收，后续运行创建新的 Session。', confirmDeleteTask: '确定删除这个 Session 及其全部工作日志吗？', confirmDeleteSkill: '确定删除这个平台 Skill 吗？',
    payload: '事件详情', actor: '操作者', requestId: '请求 ID', turnInput: '本轮指令', fullCommand: '完整命令', commandOutput: '执行输出', attempt: '执行尝试', exitCode: '退出码', pid: '进程 ID', signal: '退出信号', attemptError: '错误', configuredWorkingDir: '配置工作目录', runtimeWorkingDir: '实际执行目录', runtimeDirUnreported: '执行端未上报', noWorklog: '本 Session 暂无 Agent 工作记录。', noOperations: '本 Session 暂无控制面操作记录。', noAttempts: '任务终端正在等待输出。', noExecutions: '本 Session 暂无命令执行记录。', noBackground: '本 Session 暂无后台执行或定时检查。', externalExecution: '后台执行', scheduledCheck: '定时检查', generation: '代次', interval: '检查间隔', backgroundCommand: '后台完整命令', backgroundOutput: '业务进程输出', commandPath: '命令记录', viewFullLog: '查看完整原始输出', sessionStdout: 'Agent stdout', sessionStderr: 'Agent stderr', viewInlineOutput: '打开终端', hideInlineOutput: '收起终端', openRawOutput: '打开完整原始输出', loadingOutput: '正在连接实时终端...', liveOutput: '实时', reconnectingOutput: '重新连接', completeOutput: '已结束', inlineOutputLimit: '已达内嵌上限', emptyOutput: '（空输出）', outputBytes: '字节', logPath: '日志', donePath: '完成标记', statePath: '状态文件', lastObservation: '最近观察', archivePreservation: '日志托管', archiveBytes: '托管字节', archiveSha256: 'SHA-256', archiveError: '托管错误', task: '任务', unknown: '未知', loadFailed: '加载失败', actionFailed: '操作失败',
    checkNotNeeded: '无需检查', scheduleOutcome: '调度结果', backgroundAlreadyFinished: '后台任务已结束，定时检查无需再执行。业务结果请查看关联的后台执行。', backgroundPytestExecution: 'pytest 后台执行', processStartedAt: '实际开始', processFinishedAt: '实际结束', platformConfirmedAt: '平台确认', scheduledDueAt: '计划回查', scheduledFinishedAt: '回查完成', scheduleResolvedAt: '调度结束', linkedBackground: '关联后台', scheduleAttempts: '回查执行', logArchived: '已托管',
    businessReports: '结构化报告', noBusinessReports: '暂无结构化报告或主要执行记录。', reportRevision: '修订', reportObservedAt: '业务时间', reportPublishedAt: '上报时间', reportRawPayload: '原始报告', pytestHtmlReport: 'Pytest HTML 报告', failureAnalysisReport: 'Fail 分析报告', openHtmlReport: '打开报告', openMarkdownReport: '打开报告', artifactRegisteredRunning: '已登记 · 执行中', artifactRegisteredPending: '已登记 · 待归档', reportStatusPending: '待开始', reportStatusRunning: '执行中', reportStatusSucceeded: '通过', reportStatusFailed: '失败', reportStatusPartial: '部分完成', reportStatusBlocked: '阻塞', reportStatusCancelled: '已取消', reportStatusUnknown: '未知',
    attributedSkills: '实际使用的 Skills', noAttributedSkills: '未声明使用 Skill', correctAttribution: '修正归因', attributionHistory: '归因与修正历史', runtimeDeclared: '运行时声明', operatorCorrection: '人工修正', linked: '关联', unlinked: '移除', correctionReason: '修正原因', correctionReasonHint: '说明为什么增加或移除这些 Skill，原因会永久进入审计记录。', saveCorrection: '保存修正', skillAttributionSaved: 'Skill 归因已保存', unresolvedSkills: '快照中不存在的声明', skillSnapshotOptions: '任务冻结快照中的 Skills', version: '版本', contentHash: '内容哈希', noSnapshotSkills: '该任务尚未冻结 Skill 快照。',
    navRuntime: '运行库存', runtimeInventoryTitle: '运行库存', runtimeInventorySubtitle: '检查平台数据保护状态，以及原生 Bridge Session Runtime 的占用、归属与安全分类。', nativeRuntime: '原生 Runtime', runtimeInventoryHeadline: '原生 Session 资源与归属', inventoryNotScanned: '尚未扫描', loadingInventory: '正在扫描 Runtime 库存...', inventoryScanned: '扫描于 {time}', refreshInventory: '刷新状态', inventoryTotal: 'Session 总数', inventoryReclaimable: '可回收', inventoryBytes: 'Runtime 占用', inventoryReclaimableBytes: '可回收空间', inventoryStateSummary: '{safe} 安全 · {queued} 回收中 · {unsafe} 需排查', noBridgeSessions: '没有保留的原生 Bridge Session Runtime。',
    bridgeCategoryTaskOwned: '任务占用', bridgeCategoryCompletedRetained: '已完成保留', bridgeCategoryOrphan: '孤立 Session', bridgeCategoryCleanupQueued: '回收中', bridgeCategoryCleanupInconsistent: '回收不一致', bridgeCategoryUnsafe: '不安全', taskOwner: '任务归属', noTaskOwner: '无任务归属', resourceRecord: 'Record', resourceCodexHome: 'Codex Home', resourceWorkspace: '工作区', resourceChatfile: 'Chatfile', resourceWorkspaceLock: '工作区锁', resourceSessionRunLock: '运行锁', lastRun: '最近运行', neverRun: '从未运行', resourcePresent: '存在', resourceMissing: '缺失', reclaimRuntime: '回收 Runtime', confirmRuntimeReclaim: '确认回收 Runtime', runtimeReclaimWarning: '原生 Session Runtime 删除后不可恢复；平台任务历史和审计记录会继续保留。', targetSession: '目标 Session', typeSessionId: '输入完整 Session ID', sessionIdConfirmation: 'session-0123456789abcdef', bridgeReclaimQueued: 'Runtime 回收作业已入队', bridgeReclaimCompleted: 'Runtime 已回收', bridgeReclaimOutcomeUnknown: '回收请求结果未知；库存已重新核对，可使用同一 Session ID 安全重试。', bridgeSessionNoLongerReclaimable: '该 Session 已不存在或当前不可回收，请刷新库存。', bridgeReclaimInProgress: '已有 Runtime 回收请求正在提交，请等待结果。',
    dataProtection: '数据保护', dataProtectionHeading: '数据完整性与恢复保护', loadingProtection: '正在检查数据保护状态...', noProtectionStatus: '尚未检查数据保护状态。', protectionChecked: '检查于 {time}', protectionRefreshFailed: '状态刷新失败：{error}', platformStorage: '平台数据', databaseBackup: '在线数据库备份', recoveryCheckpoint: '平台恢复检查点', terminalLogArchive: '终态日志托管', protectionHealthy: '正常', protectionDegraded: '异常', protectionPending: '待建立', protectionInProgress: '进行中', protectionRotationPending: '待轮转', sqliteCheck: 'SQLite 检查', stateInvariants: '状态约束', storageHeadroom: '最低可用空间', lastSuccess: '最近成功', nextRun: '下次计划', packageRetention: '有效包 / 保留数', auditContinuity: '审计连续性', auditHealthy: '已持久化', auditPending: '{count} 条待写入', invariantIssues: '{count} 项异常', storageAvailable: '{percent}% · {bytes}', rotationPendingDetail: '超出 {count} 份，下次成功发布后轮转', schedulerError: '调度错误', unreadablePackages: '不可读取包', archiveCoverage: '托管覆盖', archiveCoverageDetail: '{archived} / {total} 条终态日志', archiveLastVerified: '最近完整校验', archiveFailures: '托管异常', archiveFailureDetail: '{count} 条需修复',
  },
  en: {
    brandSubtitle: 'Persistent Task Desk', navOverview: 'Overview', navTasks: 'Task Sessions', navSkills: 'Skills', navAudit: 'Operation Audit',
    fontSize: 'Text size', fontSizeSmall: 'Small text', fontSizeStandard: 'Standard text', fontSizeLarge: 'Large text',
    export: 'Export', import: 'Import', syncRuntime: 'Sync Runtime', newTask: 'New Task', executionMode: 'Execution Mode',
    overviewHeadline: 'A task is a session that persists until completion', overviewDescription: 'Each task owns one persistent session. Review or continue every turn, then explicitly archive the completed task.',
    liveFloor: 'Current Tasks', currentSessionsHeading: 'Task Sessions', recentActivity: 'Recent Activity', recentOperations: 'Recent Operations', viewAll: 'View All',
    completedSessions: 'Completed Sessions', recentHistory: 'Recent History', viewHistory: 'View History', loadMore: 'Load more', newer: 'Newer', older: 'Older',
    filterCurrent: 'Current', filterRunning: 'Running', filterHistory: 'History',
    skillsNote: 'A versioned snapshot of managed and built-in Codex skills is frozen on the first task turn.', newSkill: 'New Skill', importSkillZip: 'Import ZIP',
    taskId: 'Task ID', eventType: 'Event type', searchAudit: 'Search operations', filter: 'Filter', persistentSession: 'Persistent Session',
    businessSummary: 'Task Summary', agentRecords: 'Agent Records', worklog: 'Agent Worklog', taskTerminal: 'Codex CLI', commands: 'Agent Commands', background: 'Background & Schedule', operations: 'Operation Audit', continuePlaceholder: 'Enter instructions to start or recover this task',
    cliConnecting: 'Connecting', cliConnected: 'Connected', cliDisconnected: 'Disconnected', cliEnded: 'CLI ended', cliReconnect: 'Reconnect', cliInterrupt: 'Interrupt', cliClear: 'Clear', cliTerminate: 'End CLI', cliReadOnly: 'Read only', cliUnlockInput: 'Unlock input', cliInputUnlocked: 'Input enabled',
    interactiveCliConflict: 'This task has an active Codex CLI. Open the Codex CLI tab, select End CLI, then try to {operation} again.', taskOperationRunning: 'start the task', taskOperationDeleting: 'delete the task', taskOperationCompleting: 'complete the task', taskOperationResetting: 'reset the context', taskOperationRetry: 'perform this operation',
    businessCommands: 'Primary Executions', businessExecution: 'Business execution', executionRuns: 'Runs', repeatedRuns: 'Repeated', primarySkill: 'Executing Skill',
    businessTimeline: 'Business Timeline', taskTimeline: 'Task Timeline', businessResult: 'Business result', regressionCommands: 'pytest regression commands', currentStage: 'Current stage', currentStatus: 'Current status', taskCreated: 'Task created', structuredResult: 'Structured result', requestReceived: 'Test request received', testExecutionStarted: 'Test execution started', deploymentCompleted: 'Deployment completed', initialRegression: 'Initial regression', regressionRerun: 'Rerun', followupBooked: 'Follow-up scheduled', initialCompleted: 'Initial run completed', rerunCompleted: 'Rerun completed', failureAnalysis: 'Failure analysis', failureAnalysisCompleted: 'Failure analysis completed', failureAnalysisPending: 'analyze-failures is active; waiting for the structured analysis result.', failureAnalysisUnreported: 'analyze-failures was used; no structured analysis result has been recorded yet.', runInProgress: 'pytest run #{number} is in progress.', finalResult: 'Final result', currentResult: 'Current result', waitingForTestResult: 'Waiting for business test result', noPytestRuns: 'No pytest regression recorded', scheduledFor: 'Check at', startedAtShort: 'Started', finishedAtShort: 'Finished', pytestCommand: 'PYTEST COMMAND', skillUsed: 'Skill', cicdDeployment: 'CI/CD deployment', gwDeployment: 'GW deployment', serviceDeployment: 'Service deployment', exitCodeSummary: 'Exit code {code}', testRunNumber: 'Regression #{number}',
    overviewTitle: 'Persistent Task Overview', overviewSubtitle: 'Each task owns one independent, recoverable, auditable Codex session.',
    tasksTitle: 'Task Sessions', tasksSubtitle: 'Every turn waits for review; only explicitly completed sessions become read-only history.',
    skillsTitle: 'Skills', skillsSubtitle: 'Manage platform skills and inspect built-in skills discoverable by the Codex runtime.',
    auditTitle: 'Operation Audit', auditSubtitle: 'Inspect creation, start, recovery, commands, errors, and completion by task.',
    sessions: 'All Sessions', current: 'Current', working: 'Running', history: 'History', skills: 'Skills', operationsCount: 'Operations',
    idle: 'Ready', pending: 'Pending', leased: 'Running', queued: 'Queued', running: 'Running', recovering: 'Recovering', stopping: 'Stopping', waiting_scheduled: 'Background Running', waiting_review: 'Review', waiting_input: 'Needs Input', completed: 'Completed', succeeded: 'Succeeded', failed: 'Failed', lost: 'Process lost', cancelled: 'Cancelled', interrupted: 'Interrupted', stopped: 'Stopped', recoverable: 'Recoverable', disabled: 'Disabled',
    open: 'Open', terminal: 'Terminal', start: 'Start Task', recover: 'Recover Task', restoreArchived: 'Restore & Continue', resetSession: 'Reset Context', continueTask: 'Continue Task', reviewTask: 'Review Result', complete: 'Complete', stop: 'Stop', edit: 'Edit', delete: 'Delete', close: 'Close', save: 'Save', cancel: 'Cancel',
    noCurrentTasks: 'No current task. Create one to start an independent session.', noHistory: 'No completed session yet.', noAudit: 'No matching operation record.', noSkills: 'No skill is available.',
    taskName: 'Task name', objective: 'Task objective / initial instruction', workingDir: 'Working directory', notes: 'Notes', enabled: 'Enabled',
    maxRetries: 'Interruption retries', autoResume: 'Auto-recover after service restart', createAndStart: 'Create & Start', updateTask: 'Update Task', createTask: 'New Task Session', editTask: 'Edit Task',
    idHint: 'Letters, numbers, hyphens, and underscores only', pathHint: 'Relative paths resolve from the task workspace root; absolute paths must be under an allowed root.',
    taskContext: 'Task Context', sessionId: 'Session ID', status: 'Status', runCount: 'Runs', recoveryAttempts: 'Auto recoveries', createdAt: 'Created', finishedAt: 'Completed', workspace: 'Workspace', nextCheck: 'Next check', activeBackground: 'Active background runs', activeSchedules: 'Active scheduled checks',
    waitingStart: 'The independent session starts immediately after creation.', runningHint: 'The task is running. Logs refresh automatically.', scheduledHint: 'Codex has been released. The platform will resume this Session and create a new Turn when the durable check is due.', reviewHint: 'Review this turn, then continue the same session or complete and archive the task.', archivedHint: 'This Session is archived. Its complete Codex CLI transcript is read only; explicitly restore it to reconnect and continue.', recoverHint: "Recovery continues the Task's latest persistent Session and does not create a new one.", disabledHint: 'Enable this task before starting or continuing it.',
    startTask: 'Start Task', recoverTask: 'Recover Task', taskStarted: 'Task queued', taskSaved: 'Task saved', taskDeleted: 'Task deleted', taskCompleted: 'Task completed and archived', taskRestored: 'Task restored. You can reconnect to Codex CLI.', taskReset: 'Task configuration and history were retained. The next run will create a new Codex Session.', stopRequested: 'Stop requested', stopNotApplicable: 'This task does not need to be stopped', operationOutcomeUnknown: 'The result cannot be confirmed yet. The operation identity was retained, so retrying will not execute it twice.',
    skillName: 'Skill name', category: 'Category', description: 'Description', tags: 'Tags (comma separated)', skillContent: 'SKILL.md content', createSkill: 'New Skill', editSkill: 'Edit Skill', viewSkill: 'View Skill',
    sourceCodex: 'Codex built-in', sourceManaged: 'Managed', readOnly: 'Read only', skillSaved: 'Skill saved', skillDeleted: 'Skill deleted', skillEnabled: 'Skill enabled', skillDisabled: 'Skill disabled', enable: 'Enable', disable: 'Disable', files: 'files', skillZipImported: 'Skill archive imported', confirmOverwriteSkill: 'A managed Skill with the same name exists. Overwrite it as a new version?', zipTooLarge: 'Skill ZIP must not exceed 8 MiB',
    runtimeReady: 'Executor ready', runtimeMissing: 'Executor unavailable', runtimePaused: 'Task execution paused', runtimeConnectionIssue: 'Platform connection issue', runtimeReconnecting: 'Reconnecting', runtimeDashboardUnavailable: 'Platform status refresh failed', dashboardRequestTimeout: 'Dashboard request timed out', requestTimeout: 'Request timed out; outcome unknown. Refresh status before retrying.', runtimeUnsupportedPlatform: 'Current platform is unsupported', runtimeExecutorUnavailable: 'Codex executor unavailable', runtimeWorkerUnavailable: 'Session Worker unavailable', runtimeExecutionUserUnsafe: 'Execution account policy is unsafe', runtimeWorkspaceUnavailable: 'Task workspace unavailable', runtimeStorageUnavailable: 'Persistent storage unavailable', runtimeStorageLow: 'Persistent storage is low', runtimeProcessMismatch: 'Execution process identity mismatch', runtimeSupervisorUnavailable: 'Web Supervisor supervision lost', runtimeLauncherUnavailable: 'Host Launcher supervision lost', runtimeMaintenance: 'Platform maintenance in progress', fullAccess: 'Full access', apiRequests: 'API', logStreams: 'Logs', synced: 'Runtime status synchronized', imported: 'Configuration imported', confirmCompleteTask: 'Complete and archive this task? The Codex CLI will end and its transcript will remain available as read-only history.', confirmRestoreTask: 'Restore this archived task and continue its latest Codex Session?', confirmResetTask: 'Reset the current Codex context? The Task configuration, ID, and history remain; the old Runtime is reclaimed and the next run creates a new Session.', confirmDeleteTask: 'Delete this session and all of its worklogs?', confirmDeleteSkill: 'Delete this managed skill?',
    payload: 'Event details', actor: 'Actor', requestId: 'Request ID', turnInput: 'Turn input', fullCommand: 'Full command', commandOutput: 'Execution output', attempt: 'Attempt', exitCode: 'Exit code', pid: 'Process ID', signal: 'Exit signal', attemptError: 'Error', configuredWorkingDir: 'Configured working directory', runtimeWorkingDir: 'Runtime working directory', runtimeDirUnreported: 'Not reported by runtime', noWorklog: 'No Agent worklog has been recorded for this Session.', noOperations: 'No control-plane operation has been recorded for this Session.', noAttempts: 'Task Terminal is waiting for output.', noExecutions: 'No command execution has been recorded for this session.', noBackground: 'No background execution or scheduled check has been recorded for this Session.', externalExecution: 'Background execution', scheduledCheck: 'Scheduled check', generation: 'Generation', interval: 'Check interval', backgroundCommand: 'Full background command', backgroundOutput: 'Business process output', commandPath: 'Command record', viewFullLog: 'View full raw output', sessionStdout: 'Agent stdout', sessionStderr: 'Agent stderr', viewInlineOutput: 'Open terminal', hideInlineOutput: 'Collapse terminal', openRawOutput: 'Open complete raw output', loadingOutput: 'Connecting to live terminal...', liveOutput: 'Live', reconnectingOutput: 'Reconnecting', completeOutput: 'Finished', inlineOutputLimit: 'Inline limit reached', emptyOutput: '(empty output)', outputBytes: 'bytes', logPath: 'Log', donePath: 'Done marker', statePath: 'State file', lastObservation: 'Last observation', archivePreservation: 'Log preservation', archiveBytes: 'Preserved bytes', archiveSha256: 'SHA-256', archiveError: 'Preservation error', task: 'Task', unknown: 'Unknown', loadFailed: 'Load failed', actionFailed: 'Action failed',
    checkNotNeeded: 'No check needed', scheduleOutcome: 'Schedule outcome', backgroundAlreadyFinished: 'The background task has already finished, so this scheduled check did not need to run. See the linked background execution for the business result.', backgroundPytestExecution: 'pytest background execution', processStartedAt: 'Actually started', processFinishedAt: 'Actually finished', platformConfirmedAt: 'Platform confirmed', scheduledDueAt: 'Check planned', scheduledFinishedAt: 'Check completed', scheduleResolvedAt: 'Schedule resolved', linkedBackground: 'Linked execution', scheduleAttempts: 'Check attempts', logArchived: 'Preserved',
    businessReports: 'Structured Reports', noBusinessReports: 'No structured report or primary execution has been recorded.', reportRevision: 'Revision', reportObservedAt: 'Observed', reportPublishedAt: 'Published', reportRawPayload: 'Raw report', pytestHtmlReport: 'Pytest HTML report', failureAnalysisReport: 'Failure analysis report', openHtmlReport: 'Open report', openMarkdownReport: 'Open report', artifactRegisteredRunning: 'Registered · Running', artifactRegisteredPending: 'Registered · Awaiting archive', reportStatusPending: 'Pending', reportStatusRunning: 'Running', reportStatusSucceeded: 'Passed', reportStatusFailed: 'Failed', reportStatusPartial: 'Partial', reportStatusBlocked: 'Blocked', reportStatusCancelled: 'Cancelled', reportStatusUnknown: 'Unknown',
    attributedSkills: 'Skills Actually Used', noAttributedSkills: 'No Skill declared', correctAttribution: 'Correct Attribution', attributionHistory: 'Attribution and Correction History', runtimeDeclared: 'Runtime declaration', operatorCorrection: 'Operator correction', linked: 'Linked', unlinked: 'Removed', correctionReason: 'Correction reason', correctionReasonHint: 'Explain why these Skills are added or removed. The reason becomes a permanent audit record.', saveCorrection: 'Save Correction', skillAttributionSaved: 'Skill attribution saved', unresolvedSkills: 'Declarations missing from snapshot', skillSnapshotOptions: 'Skills in the Frozen Task Snapshot', version: 'Version', contentHash: 'Content hash', noSnapshotSkills: 'This task does not have a frozen Skill snapshot yet.',
    navRuntime: 'Runtime Inventory', runtimeInventoryTitle: 'Runtime Inventory', runtimeInventorySubtitle: 'Inspect platform data protection and native Bridge Session Runtime usage, ownership, and safety.', nativeRuntime: 'Native Runtime', runtimeInventoryHeadline: 'Native Session Resources & Ownership', inventoryNotScanned: 'Not scanned yet', loadingInventory: 'Scanning Runtime inventory...', inventoryScanned: 'Scanned {time}', refreshInventory: 'Refresh Status', inventoryTotal: 'All Sessions', inventoryReclaimable: 'Reclaimable', inventoryBytes: 'Runtime Usage', inventoryReclaimableBytes: 'Reclaimable Space', inventoryStateSummary: '{safe} safe · {queued} reclaiming · {unsafe} need review', noBridgeSessions: 'No retained native Bridge Session Runtime.',
    bridgeCategoryTaskOwned: 'Task Owned', bridgeCategoryCompletedRetained: 'Completed Retained', bridgeCategoryOrphan: 'Orphan', bridgeCategoryCleanupQueued: 'Reclaiming', bridgeCategoryCleanupInconsistent: 'Cleanup Inconsistent', bridgeCategoryUnsafe: 'Unsafe', taskOwner: 'Task Owner', noTaskOwner: 'No Task Owner', resourceRecord: 'Record', resourceCodexHome: 'Codex Home', resourceWorkspace: 'Workspace', resourceChatfile: 'Chatfile', resourceWorkspaceLock: 'Workspace Lock', resourceSessionRunLock: 'Run Lock', lastRun: 'Last Run', neverRun: 'Never', resourcePresent: 'Present', resourceMissing: 'Missing', reclaimRuntime: 'Reclaim Runtime', confirmRuntimeReclaim: 'Confirm Runtime Reclaim', runtimeReclaimWarning: 'Native Session Runtime cannot be recovered after deletion. Platform task history and audit records remain.', targetSession: 'Target Session', typeSessionId: 'Enter the full Session ID', sessionIdConfirmation: 'session-0123456789abcdef', bridgeReclaimQueued: 'Runtime reclaim job queued', bridgeReclaimCompleted: 'Runtime reclaimed', bridgeReclaimOutcomeUnknown: 'Reclaim outcome is unknown. Inventory was reconciled; retrying the same Session ID is safe.', bridgeSessionNoLongerReclaimable: 'This Session no longer exists or is not reclaimable. Refresh inventory.', bridgeReclaimInProgress: 'A Runtime reclaim request is already being submitted. Wait for its result.',
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
    signal: controller.signal,
    headers: { ...(requestOptions.headers || {}) },
  };
  const authHeader = getAuthHeader();
  if (authHeader) config.headers['Authorization'] = authHeader;
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

function createRunIdempotencyKey() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `web-run-${uuid}`;
  return `web-run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
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
  const uuid = globalThis.crypto?.randomUUID?.();
  const suffix = uuid || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const intent = {
    taskId,
    operation,
    idempotencyKey: `web-${operation}-${suffix}`,
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
    skills: ['skillsTitle', 'skillsSubtitle'],
    runtime: ['runtimeInventoryTitle', 'runtimeInventorySubtitle'],
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

function taskCard(task) {
  const running = isActiveTask(task);
  const review = isReviewTask(task);
  const attention = ['failed', 'interrupted', 'stopped'].includes(task.status) || task.recoveryState === 'recoverable';
  const actionLabel = review ? tr('reviewTask') : (attention ? tr('recover') : tr('start'));
  return `
    <article class="task-card ${escapeHtml(statusClass(task))}">
      <button class="card-hit" data-action="open-task" data-id="${escapeHtml(task.id)}" aria-label="${escapeHtml(tr('open'))}"></button>
      <div class="task-card-head">
        <div class="task-identity">
          <span class="session-symbol">S</span>
          <div><h3>${escapeHtml(task.name)}</h3><code>${escapeHtml(task.id)}</code></div>
        </div>
        <span class="status-badge ${escapeHtml(statusClass(task))}">${escapeHtml(statusLabel(task))}</span>
      </div>
      <div class="task-activity" aria-hidden="true"><span></span></div>
      <p class="task-objective">${escapeHtml(task.objective || task.summary || '-') }</p>
      <dl class="session-meta">
        <div><dt>SESSION</dt><dd>${escapeHtml(task.id)}</dd></div>
        <div><dt>${escapeHtml(tr('workspace'))}</dt><dd>${escapeHtml(task.workingDir || '.')}</dd></div>
        <div><dt>${escapeHtml(task.nextScheduledAt ? tr('nextCheck') : tr('runCount'))}</dt><dd>${task.nextScheduledAt ? escapeHtml(formatTime(task.nextScheduledAt)) : Number(task.runCount || 0)}</dd></div>
      </dl>
      <div class="card-actions">
        <button class="button secondary small" data-action="open-task-terminal" data-id="${escapeHtml(task.id)}">${escapeHtml(tr('terminal'))}</button>
        ${running
          ? `<button class="button danger small" data-action="stop-task" data-id="${escapeHtml(task.id)}">${escapeHtml(tr('stop'))}</button>`
          : `<button class="button primary small" data-action="open-task" data-id="${escapeHtml(task.id)}">${escapeHtml(actionLabel)}</button>`}
      </div>
    </article>`;
}

function historyRow(task) {
  return `
    <button class="history-row" data-action="open-task" data-id="${escapeHtml(task.id)}">
      <span class="history-mark">S</span>
      <span class="history-main"><strong>${escapeHtml(task.name)}</strong><small>${escapeHtml(task.summary || task.objective || '-')}</small></span>
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
    && section.kind !== 'json';
  return `<details class="report-section priority-${escapeHtml(section.priority || 'supporting')} sensitivity-${escapeHtml(section.sensitivity || 'normal')}"${expanded ? ' open' : ''}>
    <summary><span>${escapeHtml(section.title)}</span><code>${escapeHtml(section.kind || 'fields')}</code></summary>
    <div class="report-section-body">${description}${content}</div>
  </details>`;
}

function reportArtifactLinks(artifacts, registeredArtifacts = [], reportStatus = '') {
  const groups = [
    { kind: 'pytest-html', label: 'pytestHtmlReport', action: 'openHtmlReport' },
    { kind: 'failure-analysis-markdown', label: 'failureAnalysisReport', action: 'openMarkdownReport' },
  ];
  const managed = artifacts || [];
  const managedKeys = new Set(managed.map((artifact) => `${artifact.kind}\0${artifact.key || artifact.fileName || ''}`));
  const pending = (registeredArtifacts || []).filter((artifact) => (
    !managedKeys.has(`${artifact.kind}\0${artifact.key || artifact.fileName || ''}`)
  ));
  return groups.map((group) => {
    const reports = managed.filter((artifact) => artifact.kind === group.kind && artifact.url);
    const registrations = pending.filter((artifact) => artifact.kind === group.kind);
    if (!reports.length && !registrations.length) return '';
    return `<div class="report-artifacts">
      <span>${escapeHtml(tr(group.label))}</span>
      ${reports.map((artifact) => `<a href="${escapeHtml(artifact.url)}" target="_blank" rel="noopener"><strong>${escapeHtml(artifact.fileName || tr(group.label))}</strong><small>${escapeHtml(formatBytes(artifact.bytes || 0))}</small><b>${escapeHtml(tr(group.action))}</b></a>`).join('')}
      ${registrations.map((artifact) => {
    const running = artifact.executionStatus === 'running' || reportStatus === 'running';
    const content = `<strong>${escapeHtml(artifact.fileName || tr(group.label))}</strong><b>${escapeHtml(tr(running ? 'artifactRegisteredRunning' : 'artifactRegisteredPending'))}</b>`;
    return artifact.url
      ? `<a class="report-artifact-pending" href="${escapeHtml(artifact.url)}" target="_blank" rel="noopener">${content}</a>`
      : `<div class="report-artifact-pending">${content}</div>`;
  }).join('')}
    </div>`;
  }).join('');
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
      if (!['pytest-html', 'failure-analysis-markdown'].includes(artifact?.kind)) continue;
      const key = String(artifact.key || '');
      const fileName = artifactFileName(artifact.path);
      if (!key || !fileName) continue;
      const identity = `${artifact.kind}\0${key}`;
      if (!registered.has(identity)) {
        registered.set(identity, {
          key,
          kind: artifact.kind,
          fileName,
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
      <pre class="business-command"><span aria-hidden="true">$</span> ${escapeHtml(execution.command)}</pre>
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
  return String(report?.reportType || '').trim().toLowerCase() === 'test-result';
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
  for (const report of latestReportRevisions(reports)) {
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
      const report = [...runReports].sort((left, right) => {
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
  const orderedReports = latestReportRevisions(reports).sort((left, right) => (
    Date.parse(left.publishedAt || left.observedAt || 0) - Date.parse(right.publishedAt || right.observedAt || 0)
  ));

  for (const report of orderedReports) {
    const primary = report.primaryExecution;
    if (!primary || !isPytestCommand(primary.command)) {
      if (isReportedTestResult(report)) runs.set(`report:${report.reportKey || report.id}`, reportedTestRun(report));
      continue;
    }
    const key = reportExecutionKey(report);
    const existing = runs.get(key) || {};
    runs.set(key, {
      ...existing,
      id: existing.id || report.id,
      report,
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
    const runTitle = runOrIndex.stepRun.runKind === 'rerun'
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
    ? `<div class="business-regression-result"><span>${escapeHtml(tr('finishedAtShort'))} <time datetime="${escapeHtml(run.finishedAt)}">${escapeHtml(formatTimelineTime(run.finishedAt))}</time></span><strong>${escapeHtml(testRunSummary(run))}</strong></div>`
    : '';
  return `<article class="business-regression tone-${escapeHtml(status.tone)}">
    <header class="business-regression-head">
      <div><span class="business-regression-index">#${String(index + 1).padStart(2, '0')}</span><h4>${escapeHtml(title)}</h4></div>
      <span class="report-status tone-${escapeHtml(status.tone)}">${escapeHtml(status.label)}</span>
    </header>
    <div class="business-regression-meta"><span>${escapeHtml(tr('startedAtShort'))}</span><time datetime="${escapeHtml(run.startedAt || '')}">${escapeHtml(formatTimelineTime(run.startedAt))}</time>${skills}</div>
    <div class="business-regression-command"><span>${escapeHtml(tr('pytestCommand'))}</span><pre><b aria-hidden="true">$</b> ${escapeHtml(run.command)}</pre></div>
    ${reportArtifactLinks(run.report?.artifacts, run.report?.registeredArtifacts, run.report?.status)}
    ${completion}
  </article>`;
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

  for (const report of latestReportRevisions(reports).sort((left, right) => (
    Date.parse(left.observedAt || left.publishedAt || 0) - Date.parse(right.observedAt || right.publishedAt || 0)
  ))) {
    events.push({
      at: report.observedAt || report.publishedAt || task.updatedAt,
      sortOrder: 30,
      title: report.title || tr('structuredResult'),
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
      <p>${escapeHtml(taskSummaryDetail(task))}</p>
    </header>
    ${businessExecutionList(reports, externalAttempts)}
    <section class="business-milestones">
      <div class="business-summary-section-head"><span class="section-label">${escapeHtml(tr('taskTimeline'))}</span><strong>${events.length}</strong></div>
      <ol class="business-timeline">${businessTimelineHtml(events)}</ol>
    </section>
  </section>`;
}

function businessSummaryTimeline(task, reports, externalAttempts, scheduledJobs, executions, steps = []) {
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
  const latestDeploymentReports = new Map();
  for (const report of [...(reports || [])].sort((left, right) => (
    Date.parse(left.publishedAt || 0) - Date.parse(right.publishedAt || 0)
  ))) {
    if (deploymentCategory(report)) latestDeploymentReports.set(report.reportKey, report);
  }
  for (const report of latestDeploymentReports.values()) {
    events.push({
      at: report.observedAt || report.publishedAt,
      sortOrder: 20,
      title: tr(deploymentCategory(report)),
      detail: report.summary,
      status: normalizedExecutionStatus(report.status),
      skillIds: [report.skillId],
    });
  }

  const deploymentReportSkills = new Set([...latestDeploymentReports.values()].map((report) => report.skillId));
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
      status: latestCompletedRun.status,
      skillIds: latestCompletedRun.skillIds,
    });
  }

  events.sort((left, right) => {
    const timeDifference = Date.parse(left.at || 0) - Date.parse(right.at || 0);
    return timeDifference || left.sortOrder - right.sortOrder;
  });
  const stage = businessSummaryStage(task, runs, analysisReports, latestAnalysisExecution);
  const stageStatus = reportStatusPresentation(stage.status);
  return `<section class="business-summary">
    <header class="business-summary-head">
      <div><span class="section-label">${escapeHtml(tr('currentStage'))}</span><h3>${escapeHtml(stage.title)}</h3></div>
      <span class="report-status tone-${escapeHtml(stageStatus.tone)}">${escapeHtml(stageStatus.label)}</span>
      <p>${escapeHtml(stage.detail)}</p>
    </header>
    <section class="business-regressions">
      <div class="business-summary-section-head"><span class="section-label">${escapeHtml(tr('regressionCommands'))}</span><strong>${runs.length}</strong></div>
      ${runs.length ? `<div class="business-regression-list">${runs.map(businessRegressionHtml).join('')}</div>` : `<div class="business-summary-empty">${escapeHtml(tr('noPytestRuns'))}</div>`}
    </section>
    <section class="business-milestones">
      <div class="business-summary-section-head"><span class="section-label">${escapeHtml(tr('businessTimeline'))}</span><strong>${events.length}</strong></div>
      <ol class="business-timeline">${businessTimelineHtml(events)}</ol>
    </section>
  </section>`;
}

function skillReportList(reports) {
  if (!reports.length) return '';
  return `<section class="business-reports">
    <div class="business-reports-heading"><span class="section-label">${escapeHtml(tr('businessReports'))}</span><strong>${reports.length}</strong></div>
    <div class="business-report-list">${reports.map((report) => {
    const status = reportStatusPresentation(report.status);
    const observed = report.observedAt
      ? `<span>${escapeHtml(tr('reportObservedAt'))} <time>${escapeHtml(formatTime(report.observedAt))}</time></span>`
      : '';
    const metrics = (report.metrics || []).length
      ? `<div class="report-metrics">${report.metrics.map((metric) => `<div class="report-metric tone-${escapeHtml(metric.tone || 'neutral')}"><span>${escapeHtml(metric.label)}</span><strong>${escapeHtml(reportDisplayValue(metric.value))}</strong></div>`).join('')}</div>`
      : '';
    return `<article class="business-report report-status-${escapeHtml(report.status)}">
      <header class="business-report-head">
        <div><span class="report-skill">${escapeHtml(report.skillId)} <code>v${Number(report.skillVersion || 0)}</code></span><h3>${escapeHtml(report.title)}</h3></div>
        <span class="report-status tone-${escapeHtml(status.tone)}">${escapeHtml(status.label)}</span>
      </header>
      <p class="business-report-summary">${escapeHtml(report.summary)}</p>
      ${metrics}
      <div class="business-report-meta"><span>${escapeHtml(tr('reportRevision'))} #${Number(report.revision || 0)}</span>${observed}<span>${escapeHtml(tr('reportPublishedAt'))} <time>${escapeHtml(formatTime(report.publishedAt))}</time></span></div>
      ${reportArtifactLinks(report.artifacts, report.registeredArtifacts, report.status)}
      <div class="report-sections">${(report.sections || []).map(skillReportSection).join('')}</div>
      <details class="report-raw"><summary>${escapeHtml(tr('reportRawPayload'))}</summary><pre>${escapeHtml(JSON.stringify(report, null, 2))}</pre></details>
    </article>`;
  }).join('')}</div>
  </section>`;
}

function businessReportPage(reports, externalAttempts) {
  reports = reportsWithRegisteredArtifacts(reports, externalAttempts);
  const executions = businessExecutionList(reports, externalAttempts);
  const reportList = skillReportList(reports);
  if (!executions && !reportList) {
    return `<div class="empty-state">${escapeHtml(tr('noBusinessReports'))}</div>`;
  }
  return `<div class="business-report-page">${executions}${reportList}</div>`;
}

function operationAuditList(events) {
  const runtimeActors = new Set(['worker', 'codex-runtime', 'archive-worker']);
  return eventList(events.filter((event) => !runtimeActors.has(event.actor)), 'noOperations');
}

function shortHash(value) {
  const hash = String(value || '');
  return hash ? hash.slice(0, 12) : '-';
}

function skillAttributionBlock(execution) {
  const skills = execution.skills || [];
  const history = execution.skillAttributionHistory || [];
  const unresolved = execution.unresolvedSkillIds || [];
  const chips = skills.length
    ? skills.map((skill) => `<span class="attribution-chip" title="${escapeHtml(`${tr('contentHash')}: ${skill.contentHash}`)}"><strong>${escapeHtml(skill.skillId)}</strong><code>v${Number(skill.version)} · ${escapeHtml(shortHash(skill.contentHash))}</code></span>`).join('')
    : `<span class="attribution-empty">${escapeHtml(tr('noAttributedSkills'))}</span>`;
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
    <pre class="execution-command">${escapeHtml(primary.command || '')}</pre>
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

function agentRecordsList(worklogEvents, executions) {
  return `<div class="agent-records">
    <section class="agent-record-section">
      <header class="agent-record-section-head"><h3>${escapeHtml(tr('worklog'))}</h3></header>
      <div class="event-list">${worklogEventList(worklogEvents)}</div>
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
      ${attempt.command ? `<div class="command-audit"><span>${escapeHtml(tr('backgroundCommand'))}</span><pre>${escapeHtml(attempt.command)}</pre></div>` : ''}
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
    return {
      kind: 'attempt',
      id: attempt.id,
      outputFormat,
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
      const remaining = Math.max(0, INLINE_ATTEMPT_OUTPUT_MAX_BYTES - view.offset);
      const accepted = bytes.subarray(0, remaining);
      if (accepted.byteLength) {
        writeManagedCodexTerminalOutput(view, view.decoder.decode(accepted, { stream: true }));
        view.offset += accepted.byteLength;
      }
      if (accepted.byteLength < bytes.byteLength || view.offset >= INLINE_ATTEMPT_OUTPUT_MAX_BYTES) {
        writeManagedCodexTerminalOutput(view, view.decoder.decode(), true);
        view.ended = true;
        updateCodexTerminalStatus(view, 'ended', tr('inlineOutputLimit'));
        try { socket.close(1000, 'Inline output limit reached'); } catch {}
      }
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
    scrollback: 20000,
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
    offset: 0,
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
        <div class="execution-context tracking-paths">
          <span>${escapeHtml(tr('commandPath'))}</span><code>${escapeHtml(attempt.commandPath || '-')}</code>
          <span>${escapeHtml(tr('logPath'))}</span><code>${escapeHtml(attempt.logPath || '-')}</code>
          <span>${escapeHtml(tr('donePath'))}</span><code>${escapeHtml(attempt.donePath || '-')}</code>
          <span>${escapeHtml(tr('statePath'))}</span><code>${escapeHtml(attempt.statePath || '-')}</code>
        </div>
        ${attempt.command ? `<div class="command-audit"><span>${escapeHtml(tr('backgroundCommand'))}</span><pre>${escapeHtml(attempt.command)}</pre></div>` : ''}
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

function renderOverview() {
  const tasks = state.dashboard.sessions || [];
  const current = tasks.filter((task) => task.status !== 'completed');
  const history = tasks.filter((task) => task.status === 'completed');
  renderHtml('overviewTasks', '#overviewTaskGrid', current.length
    ? current.slice(0, 8).map(taskCard).join('')
    : `<div class="empty-state span-all">${escapeHtml(tr('noCurrentTasks'))}</div>`);
  renderHtml('overviewHistory', '#overviewHistoryList', history.length
    ? history.slice(0, 6).map(historyRow).join('')
    : `<div class="empty-state">${escapeHtml(tr('noHistory'))}</div>`);
  renderHtml('overviewAudit', '#overviewAuditList', eventList((state.dashboard.recentAudit || []).slice(0, 8)));
}

function filteredTasks() {
  const tasks = state.dashboard.sessions || [];
  if (state.taskFilter === 'history') return tasks.filter((task) => task.status === 'completed');
  if (state.taskFilter === 'running') return tasks.filter(isActiveTask);
  return tasks.filter((task) => task.status !== 'completed');
}

function renderTasks() {
  const tasks = filteredTasks();
  const historyMode = state.taskFilter === 'history';
  $('#taskGrid').classList.toggle('history-mode', historyMode);
  if (!tasks.length) {
    renderHtml('tasks', '#taskGrid', `<div class="empty-state span-all">${escapeHtml(tr(historyMode ? 'noHistory' : 'noCurrentTasks'))}</div>`);
    $('#loadMoreTasksBtn').classList.add('hidden');
    return;
  }
  renderHtml('tasks', '#taskGrid', historyMode ? tasks.map(historyRow).join('') : tasks.map(taskCard).join(''));
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
        ${session.reclaimable ? `<button class="button danger small" data-action="reclaim-bridge-session" data-id="${escapeHtml(session.sessionId)}"${state.bridgeReclaimSubmitting ? ' disabled' : ''}>${escapeHtml(tr('reclaimRuntime'))}</button>` : ''}
      </div>
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
    ['inventoryReclaimableBytes', state.bridgeInventoryLoaded ? formatBytes(summary.reclaimableBytes) : '-'],
  ];
  renderHtml('bridgeInventoryMetrics', '#bridgeInventoryMetrics', metrics.map(([label, value]) => `
    <div class="metric"><span>${escapeHtml(tr(label))}</span><strong>${escapeHtml(value)}</strong></div>`).join(''));
  const listHtml = initialLoading
    ? `<div class="inventory-loading" role="status"><div class="loading-bar"></div><span>${escapeHtml(tr('loadingInventory'))}</span></div>`
    : (state.bridgeInventoryLoaded && sessions.length
      ? sessions.map(bridgeInventoryRow).join('')
      : `<div class="empty-state">${escapeHtml(tr(state.bridgeInventoryLoaded ? 'noBridgeSessions' : 'inventoryNotScanned'))}</div>`);
  renderHtml('bridgeInventoryList', '#bridgeInventoryList', listHtml);
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
  $$('.view').forEach((element) => element.classList.toggle('active', element.id === `view-${view}`));
  $$('.nav-item').forEach((element) => element.classList.toggle('active', element.dataset.view === view));
  updateViewHeading();
  if (view !== 'runtime') {
    clearTimeout(bridgeInventoryPollTimer);
    bridgeInventoryPollTimer = null;
    clearTimeout(protectionPollTimer);
    protectionPollTimer = null;
    if (state.bridgeInventoryController) state.bridgeInventoryController.abort();
    if (state.protectionController) state.protectionController.abort();
  }
  if (view === 'runtime') loadRuntimeView();
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
      <div><dt>${escapeHtml(tr('workspace'))}</dt><dd><code>${escapeHtml(task.workingDir || '.')}</code></dd></div>
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

function renderTaskDetail(task) {
  const archived = task.status === 'completed';
  const running = isActiveTask(task);
  const review = isReviewTask(task);
  const recover = !running && !review && !archived && Boolean(task.persistentSessionKey || task.bridgeSessionKey);
  const canReset = !running && (archived || Boolean(task.persistentSessionKey || task.bridgeSessionKey));
  $('#taskDetailModal').dataset.detailTab = state.detailTab;
  renderHtml('taskDetailHead', '#taskDetailHead', `
    <div><span class="section-label">${escapeHtml(task.id)}</span><div class="detail-title-line"><h2>${escapeHtml(task.name)}</h2><span class="status-badge ${escapeHtml(statusClass(task))}">${escapeHtml(statusLabel(task))}</span></div></div>
    <div class="detail-actions">
      ${!running && !archived ? `<button class="button secondary small" data-action="edit-task" data-id="${escapeHtml(task.id)}">${escapeHtml(tr('edit'))}</button>` : ''}
      ${archived ? `<button class="button primary small" data-action="restore-task" data-id="${escapeHtml(task.id)}">${escapeHtml(tr('restoreArchived'))}</button>` : ''}
      ${canReset ? `<button class="button secondary small" data-action="reset-task" data-id="${escapeHtml(task.id)}">${escapeHtml(tr('resetSession'))}</button>` : ''}
      ${review ? `<button class="button primary small" data-action="complete-task" data-id="${escapeHtml(task.id)}">${escapeHtml(tr('complete'))}</button>` : ''}
      ${running && task.status !== 'stopping' ? `<button class="button danger small" data-action="stop-task" data-id="${escapeHtml(task.id)}">${escapeHtml(tr('stop'))}</button>` : ''}
      ${!running && !archived ? `<button class="button danger small" data-action="delete-task" data-id="${escapeHtml(task.id)}">${escapeHtml(tr('delete'))}</button>` : ''}
      <button class="icon-button" data-close="taskDetailModal" aria-label="${escapeHtml(tr('close'))}">&#215;</button>
    </div>`);
  renderHtml('taskContext', '#taskContext', taskContext(task));
  $$('#detailTabs [data-tab]').forEach((button) => button.classList.toggle('active', button.dataset.tab === state.detailTab));
  const composer = $('#continueTaskForm');
  composer.classList.toggle('hidden', archived || state.detailTab === 'task-terminal');
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
  disposeCodexTerminal();
  abortAttemptOutputLoad();
  disposeAttemptTerminals();
  return renderHtml('taskConsole', output, html);
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
      const [steps, externalAttempts, scheduledJobs, skillReports, executions] = await Promise.all([
        api(`/api/sessions/${encodeURIComponent(taskId)}/steps`, { signal: controller.signal }),
        api(`/api/sessions/${encodeURIComponent(taskId)}/external-attempts?limit=500&offset=0`, { signal: controller.signal }),
        api(`/api/sessions/${encodeURIComponent(taskId)}/scheduled-jobs?limit=500&offset=0`, { signal: controller.signal }),
        loadOptionalSkillReports(taskId, controller.signal, { history: true, limit: 500 }),
        api(`/api/sessions/${encodeURIComponent(taskId)}/executions?limit=500&offset=0`, { signal: controller.signal }),
      ]);
      if (controller.signal.aborted || state.currentTaskId !== taskId || state.detailTab !== detailTab) return;
      state.detailHasOlder = false;
      state.currentSkillReports = skillReports;
      state.currentExecutions = executions;
      updateBackgroundTabAvailability(externalAttempts, scheduledJobs);
      renderTaskConsoleHtml(output, businessSummaryTimeline(
        task, skillReports, externalAttempts, scheduledJobs, executions, steps,
      ));
      return;
    }
    if (detailTab === 'business-reports') {
      const [externalAttempts, skillReports] = await Promise.all([
        api(`/api/sessions/${encodeURIComponent(taskId)}/external-attempts?limit=500&offset=0`, { signal: controller.signal }),
        loadOptionalSkillReports(taskId, controller.signal, { limit: 500 }),
      ]);
      if (controller.signal.aborted || state.currentTaskId !== taskId || state.detailTab !== detailTab) return;
      state.detailHasOlder = false;
      state.currentSkillReports = skillReports;
      renderTaskConsoleHtml(output, businessReportPage(skillReports, externalAttempts));
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
      const [worklogPage, executionPage] = await Promise.all([
        api(`/api/sessions/${encodeURIComponent(taskId)}/worklogs?limit=${state.detailPageSize + 1}&offset=${state.detailOffset}`, { signal: controller.signal }),
        api(`/api/sessions/${encodeURIComponent(taskId)}/executions?limit=${state.detailPageSize + 1}&offset=${state.detailOffset}`, { signal: controller.signal }),
      ]);
      if (controller.signal.aborted || state.currentTaskId !== taskId || state.detailTab !== detailTab) return;
      state.detailHasOlder = worklogPage.length > state.detailPageSize
        || executionPage.length > state.detailPageSize;
      const worklogEvents = worklogPage.slice(-state.detailPageSize);
      const executions = executionPage.slice(0, state.detailPageSize);
      state.currentExecutions = executions;
      renderTaskConsoleHtml(output, detailPage(agentRecordsList(worklogEvents, executions)));
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
  if (state.currentTaskId !== id) renderCache.delete('taskConsole');
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

async function deleteTask(id) {
  if (!window.confirm(tr('confirmDeleteTask'))) return;
  const task = findTask(id);
  if (!task) return;
  try {
    await requestTaskOperation(task, 'delete');
    closeModal('taskDetailModal');
    toast(tr('taskDeleted'));
  } catch (error) {
    toast(error.message, 'error');
    return;
  }
  try { await loadDashboard({ force: true }); } catch { scheduleDashboardPoll(0); }
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
      method: 'POST',
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
  if (action.dataset.action === 'new-task') openTaskEditor();
  if (action.dataset.action === 'open-task') await openTaskDetail(id);
  if (action.dataset.action === 'open-task-terminal') {
    await openTaskDetail(id, 'task-terminal');
  }
  if (action.dataset.action === 'edit-task') openTaskEditor(findTask(id));
  if (action.dataset.action === 'stop-task') await stopTask(id);
  if (action.dataset.action === 'complete-task') await completeTask(id);
  if (action.dataset.action === 'restore-task') await restoreArchivedTask(id);
  if (action.dataset.action === 'reset-task') await resetTask(id);
  if (action.dataset.action === 'delete-task') await deleteTask(id);
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

$$('.modal').forEach((modal) => modal.addEventListener('click', (event) => {
  if (event.target === modal) closeModal(modal.id);
}));

$('#taskForm').addEventListener('submit', saveTask);
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
  return (state.dashboard.sessions || []).some(isActiveTask) ? 2000 : 10000;
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
  if (state.view === 'runtime') loadRuntimeView();
  if (state.detailTab === 'task-terminal' && !$('#taskDetailModal').classList.contains('hidden')) {
    renderCache.delete('taskConsole');
    loadTaskConsole({ showLoading: false }).catch(() => {});
  }
});

window.addEventListener('pagehide', () => {
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
  if (!getStoredCredentials()) {
    showAuthOverlay();
    return;
  }
  applyFontSize();
  applyTranslations();
  try {
    await Promise.all([loadDashboard({ force: true }), loadSkills()]);
    await reconcilePersistedTaskOperationIntents();
  } catch (error) {
    toast(`${tr('loadFailed')}: ${error.message}`, 'error');
  }
  scheduleDashboardPoll();
}

initAuthForm();
initialize();
