const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder, TextEncoder } = require('node:util');
const vm = require('node:vm');

const APP_SOURCE = fs.readFileSync(path.resolve(__dirname, '../public/app.js'), 'utf8');
const INDEX_SOURCE = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8');
const STYLES_SOURCE = fs.readFileSync(path.resolve(__dirname, '../public/styles.css'), 'utf8');

test('dashboard polling pauses when hidden, avoids stale health, and skips unchanged DOM writes', async () => {
  const elements = new Map();
  const documentListeners = new Map();
  const windowListeners = new Map();
  const timers = new Map();
  const requests = [];
  const requestDetails = [];
  const authenticatedWebSocketOrigin = 'ws://test-user:test-password@localhost';
  const sessionValues = new Map([
    ['codex-tasks-auth-v1', JSON.stringify({ user: 'test-user', pass: 'test-password' })],
  ]);
  const localValues = new Map();
  const warnings = [];
  let timerId = 0;
  let randomId = 0;
  let dashboardHang = false;
  let requestHangPath = '';
  let requestHangMethod = '';
  const responseOverrides = new Map();

  class FakeClassList {
    constructor(initial = []) { this.values = new Set(initial); }
    add(value) { this.values.add(value); }
    remove(value) { this.values.delete(value); }
    contains(value) { return this.values.has(value); }
    toggle(value, force) {
      const enabled = force === undefined ? !this.values.has(value) : Boolean(force);
      if (enabled) this.values.add(value);
      else this.values.delete(value);
      return enabled;
    }
  }

  class FakeElement {
    constructor(selector) {
      this.selector = selector;
      this.dataset = {};
      this.classList = new FakeClassList(selector === '#taskDetailModal' ? ['hidden'] : []);
      this.textContent = '';
      this.value = '';
      this.placeholder = '';
      this.disabled = false;
      this.scrollHeight = 0;
      this.scrollTop = 0;
      this.clientHeight = 0;
      this.writeCount = 0;
      this.html = '';
      this.attributes = {};
    }
    get innerHTML() { return this.html; }
    set innerHTML(value) { this.html = value; this.writeCount += 1; }
    addEventListener() {}
    closest() { return null; }
    click() {}
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
  }

  function element(selector) {
    if (!elements.has(selector)) elements.set(selector, new FakeElement(selector));
    return elements.get(selector);
  }

  const fontSizeButtons = ['small', 'standard', 'large'].map((value) => {
    const button = new FakeElement(`[data-font-size="${value}"]`);
    button.dataset.fontSize = value;
    return button;
  });

  const dashboard = {
    stats: { sessions: 0, currentSessions: 0, activeSessions: 0, completedSessions: 0, skills: 1 },
    runtime: {
      ready: true,
      bridgeAvailable: true,
      workerAvailable: true,
      skillsMounted: 1,
      permissionMode: 'danger-full-access',
      degradedReasons: [],
    },
    apiRequests: {
      active: 0,
      maxConcurrency: 64,
      saturated: false,
      rejectedCount: 0,
      idleTimeoutMs: 30000,
      idleTimeoutCount: 0,
    },
    logStreams: {
      active: 0,
      maxConcurrency: 8,
      saturated: false,
      idleTimeoutMs: 60000,
      idleTimeoutCount: 0,
    },
    sessions: [],
    activeSessions: [],
    recentAudit: [],
  };
  const bridgeInventory = {
    summary: {
      total: 3,
      reclaimable: 2,
      totalBytes: 1572864,
      reclaimableBytes: 1048576,
      categories: { task_owned: 1, orphan: 1, completed_retained: 1 },
      scannedAt: '2026-08-03T06:00:00.000Z',
    },
    sessions: [
      {
        sessionId: 'session-1111111111111111', category: 'task_owned', safe: true, reclaimable: false,
        bytes: 524288, resources: { record: true, codexHome: true, workspace: true, chatfile: true, workspaceLock: true, sessionRunLock: false },
        lastRunAt: '2026-08-03T05:59:00.000Z', taskId: 'active-task', taskStatus: 'waiting_review', cleanupJob: null, error: '',
      },
      {
        sessionId: 'session-2222222222222222', category: 'orphan', safe: true, reclaimable: true,
        bytes: 786432, resources: { record: true, codexHome: true, workspace: true, chatfile: true, workspaceLock: true, sessionRunLock: false },
        lastRunAt: '2026-08-03T05:58:00.000Z', taskId: '', taskStatus: '', cleanupJob: null, error: '',
      },
      {
        sessionId: 'session-3333333333333333', category: 'completed_retained', safe: true, reclaimable: true,
        bytes: 262144, resources: { record: true, codexHome: true, workspace: true, chatfile: false, workspaceLock: true, sessionRunLock: false },
        lastRunAt: '', taskId: 'completed-task', taskStatus: 'completed', cleanupJob: null, error: '',
      },
    ],
  };
  const health = {
    ok: true,
    ready: true,
    runtime: {
      storageCapacity: {
        ok: true,
        targets: [{ role: 'data', availablePercent: 82.5, availableBytes: 865075200 }],
      },
    },
    storage: { ok: true, quickCheck: 'ok' },
    state: { ok: true, violations: { orphanRunningAttempts: 0, waitingExternalWithoutSchedule: 0 } },
    backups: {
      retention: 14,
      backupCount: 10,
      retentionExcessCount: 0,
      retentionSatisfied: true,
      unreadableBackupCount: 0,
      lastSuccessAt: '2026-08-03T05:55:00.000Z',
      nextRunAt: '2026-08-04T05:55:00.000Z',
      lastError: '',
      unrecordedAuditEventCount: 0,
      auditQueueDurable: true,
    },
    recoveryCheckpoints: {
      retention: 3,
      checkpointCount: 4,
      retentionExcessCount: 1,
      retentionSatisfied: false,
      unreadableCheckpointCount: 0,
      lastSuccessAt: '2026-08-03T05:56:00.000Z',
      nextRunAt: '2026-08-04T05:56:00.000Z',
      lastError: '',
      unrecordedAuditEventCount: 0,
      auditQueueDurable: true,
    },
  };
  responseOverrides.set('GET /api/health', { payload: health });
  const document = {
    hidden: false,
    activeElement: null,
    documentElement: { lang: '', dataset: {} },
    body: { classList: new FakeClassList() },
    getElementById: (id) => element(`#${id}`),
    querySelector: element,
    querySelectorAll: (selector) => (selector === '#fontSizeControl [data-font-size]' ? fontSizeButtons : []),
    addEventListener: (name, listener) => documentListeners.set(name, listener),
    createElement: () => new FakeElement('created'),
  };
  const window = {
    confirm: () => true,
    addEventListener: (name, listener) => windowListeners.set(name, listener),
  };
  const fetch = async (url, options = {}) => {
    const requestUrl = String(url);
    const requestPath = requestUrl.split('?')[0];
    let body = options.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { /* Preserve non-JSON request bodies. */ }
    }
    requests.push(requestUrl);
    const method = options.method || 'GET';
    requestDetails.push({ url: requestUrl, method, body, headers: { ...(options.headers || {}) } });
    if ((requestUrl.startsWith('/api/dashboard') && dashboardHang)
      || (requestPath === requestHangPath && (!requestHangMethod || requestHangMethod === method))) {
      return new Promise((resolve, reject) => {
        const abort = () => {
          const error = new Error('request aborted');
          error.name = 'AbortError';
          reject(error);
        };
        if (options.signal?.aborted) abort();
        else options.signal?.addEventListener('abort', abort, { once: true });
      });
    }
    const configuredOverride = responseOverrides.get(`${method} ${requestUrl}`)
      || responseOverrides.get(requestUrl)
      || responseOverrides.get(`${method} ${requestPath}`)
      || responseOverrides.get(requestPath);
    const override = typeof configuredOverride === 'function'
      ? configuredOverride({ url: requestUrl, method, options })
      : configuredOverride;
    const status = Number(override?.status || 200);
    const payload = override
      ? override.payload
      : (requestUrl.startsWith('/api/dashboard') ? dashboard : []);
    const responseHeaders = Object.fromEntries(
      Object.entries(override?.headers || {}).map(([name, value]) => [name.toLowerCase(), String(value)]),
    );
    if (!responseHeaders['content-type']) responseHeaders['content-type'] = 'application/json';
    if (requestPath.includes('/attempts/') && !responseHeaders['x-attempt-status']) {
      responseHeaders['x-attempt-status'] = 'completed';
    }
    const responseText = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const responseBytes = payload instanceof Uint8Array
      ? payload
      : new TextEncoder().encode(responseText);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => responseHeaders[String(name).toLowerCase()] ?? null },
      json: async () => payload,
      text: async () => responseText,
      arrayBuffer: async () => responseBytes.buffer.slice(
        responseBytes.byteOffset,
        responseBytes.byteOffset + responseBytes.byteLength,
      ),
    };
  };
  const setTimeout = (callback, delay) => {
    const id = ++timerId;
    timers.set(id, { callback, delay });
    return id;
  };
  const clearTimeout = (id) => timers.delete(id);
  const localStorage = {
    getItem: (key) => localValues.get(key) ?? null,
    setItem: (key, value) => localValues.set(key, String(value)),
  };
  const sessionStorage = {
    getItem: (key) => sessionValues.get(key) ?? null,
    setItem: (key, value) => sessionValues.set(key, String(value)),
    removeItem: (key) => sessionValues.delete(key),
  };

  const context = vm.createContext({
    AbortController,
    Blob,
    btoa: (value) => Buffer.from(String(value), 'utf8').toString('base64'),
    crypto: {
      randomUUID: () => `test-${++randomId}`,
      subtle: {
        digest: async (_algorithm, data) => {
          const digest = nodeCrypto.createHash('sha256').update(Buffer.from(data)).digest();
          return digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.byteLength);
        },
      },
    },
    FormData,
    Intl,
    JSON,
    URL,
    URLSearchParams,
    console: { ...console, warn: (message) => warnings.push(String(message)) },
    document,
    fetch,
    localStorage,
    location: { protocol: 'http:', host: 'localhost' },
    sessionStorage,
    setTimeout,
    TextDecoder,
    TextEncoder,
    clearTimeout,
    window,
  });
  vm.runInContext(APP_SOURCE, context, { filename: 'public/app.js' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(document.documentElement.dataset.fontSize, 'standard');
  assert.equal(element('#fontSizeControl').getAttribute('aria-label'), '文字大小');
  assert.equal(fontSizeButtons.find((button) => button.dataset.fontSize === 'standard').classList.contains('active'), true);
  vm.runInContext("setFontSize('large')", context);
  assert.equal(document.documentElement.dataset.fontSize, 'large');
  assert.equal(localValues.get('codex-tasks-font-size-v1'), 'large');
  assert.equal(fontSizeButtons.find((button) => button.dataset.fontSize === 'large').getAttribute('aria-pressed'), 'true');
  vm.runInContext("setFontSize('standard')", context);

  assert.equal(requests.filter((url) => url === '/api/dashboard?taskLimit=100').length, 1);
  assert.equal(requests.filter((url) => url.startsWith('/api/audit')).length, 0);
  assert.equal(requests.filter((url) => url === '/api/runtime/bridge-sessions').length, 0);
  assert.equal(requests.filter((url) => url === '/api/health').length, 0);
  assert.equal(vm.runInContext('protectionPollTimer === null', context), true);
  assert.ok([...timers.values()].some((timer) => timer.delay === 10000));
  const initialWrites = [...elements.values()].reduce((total, item) => total + item.writeCount, 0);

  const idlePoll = [...timers.entries()].find(([, timer]) => timer.delay === 10000);
  timers.delete(idlePoll[0]);
  await idlePoll[1].callback();
  await new Promise((resolve) => setImmediate(resolve));
  const writesAfterUnchangedPoll = [...elements.values()].reduce((total, item) => total + item.writeCount, 0);
  assert.equal(requests.filter((url) => url === '/api/dashboard?taskLimit=100').length, 2);
  assert.equal(writesAfterUnchangedPoll, initialWrites);

  dashboardHang = true;
  const hangingRefresh = vm.runInContext('refreshDashboard()', context);
  await new Promise((resolve) => setImmediate(resolve));
  const requestTimeout = [...timers.entries()].find(([, timer]) => timer.delay === 8000);
  assert.ok(requestTimeout);
  timers.delete(requestTimeout[0]);
  requestTimeout[1].callback();
  await hangingRefresh;
  assert.equal(vm.runInContext('state.dashboardUnavailable', context), true);
  assert.equal(vm.runInContext('state.dashboardFailureCount', context), 1);
  assert.equal(element('#runtimeDot').classList.contains('ready'), false);
  assert.equal(element('#runtimeAlert').classList.contains('hidden'), false);
  assert.equal(element('#runtimeAlert').classList.contains('connection-lost'), true);
  assert.equal(element('#runtimeState').textContent, '平台连接异常');
  assert.equal(element('#runtimeMeta').textContent, '正在重新连接');
  assert.match(element('#runtimeReasons').innerHTML, /平台状态无法刷新/);
  assert.match(element('#runtimeReasons').innerHTML, /dashboard_unavailable/);
  assert.deepEqual(warnings, ['Dashboard refresh failed']);
  assert.equal([...timers.values()].some((timer) => timer.delay === 8000), false);
  assert.equal([...timers.values()].some((timer) => timer.delay === 30000), false);
  const reconnectPoll = [...timers.entries()].find(([, timer]) => timer.delay === 2000);
  assert.ok(reconnectPoll);
  dashboardHang = false;
  timers.delete(reconnectPoll[0]);
  await reconnectPoll[1].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(vm.runInContext('state.dashboardUnavailable', context), false);
  assert.equal(vm.runInContext('state.dashboardFailureCount', context), 0);
  assert.equal(element('#runtimeDot').classList.contains('ready'), true);
  assert.equal(element('#runtimeAlert').classList.contains('hidden'), true);
  assert.equal(element('#runtimeAlert').classList.contains('connection-lost'), false);

  requestHangPath = '/api/hang';
  const timedRequest = vm.runInContext("api('/api/hang').then(() => null, (error) => ({ name: error.name, message: error.message }))", context);
  await new Promise((resolve) => setImmediate(resolve));
  const apiTimeout = [...timers.entries()].find(([, timer]) => timer.delay === 30000);
  assert.ok(apiTimeout);
  timers.delete(apiTimeout[0]);
  apiTimeout[1].callback();
  const timeoutResult = await timedRequest;
  assert.equal(timeoutResult.name, 'RequestTimeoutError');
  assert.equal(timeoutResult.message, '请求超时，结果未知；请刷新状态后再决定是否重试');
  assert.equal([...timers.values()].some((timer) => timer.delay === 30000), false);
  assert.ok([...timers.values()].some((timer) => timer.delay === 0));

  requestHangPath = '/api/cancel';
  const cancelledRequest = vm.runInContext(`
    globalThis.testRequestController = new AbortController();
    api('/api/cancel', { signal: testRequestController.signal })
      .then(() => null, (error) => ({ name: error.name, message: error.message }));
  `, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok([...timers.values()].some((timer) => timer.delay === 30000));
  vm.runInContext('testRequestController.abort()', context);
  const cancelledResult = await cancelledRequest;
  assert.equal(cancelledResult.name, 'AbortError');
  assert.equal([...timers.values()].some((timer) => timer.delay === 30000), false);
  requestHangPath = '';

  responseOverrides.set('POST /api/sessions/cli-task/run', {
    status: 409,
    payload: {
      error: 'English fallback',
      code: 'interactive_codex_cli_active',
      operation: 'running',
    },
  });
  const localizedConflict = await vm.runInContext(`
    api('/api/sessions/cli-task/run', { method: 'POST' })
      .then(() => null, (error) => ({ code: error.code, message: error.message }));
  `, context);
  assert.equal(localizedConflict.code, 'interactive_codex_cli_active');
  assert.equal(
    localizedConflict.message,
    '该任务仍有正在运行的 Codex CLI。请在任务详情的「Codex CLI」页签点击「结束 CLI」，然后重新启动任务。',
  );

  assert.equal(
    vm.runInContext('[1, 2, 3, 4, 5].map((count) => { state.dashboardUnavailable = true; state.dashboardFailureCount = count; return dashboardPollDelay(); }).join(",")', context),
    '2000,4000,8000,16000,30000',
  );
  vm.runInContext('state.dashboardUnavailable = false; state.dashboardFailureCount = 0', context);

  vm.runInContext(`
    state.dashboard.sessions = [
      { id: 'review', status: 'waiting_review' },
      { id: 'queued', status: 'queued' },
      { id: 'done', status: 'completed' }
    ];
    state.taskFilter = 'history';
  `, context);
  assert.equal(vm.runInContext("filteredTasks().map((task) => task.id).join(',')", context), 'done');
  assert.equal(vm.runInContext('dashboardPollDelay()', context), 2000);
  assert.equal(vm.runInContext("formatTime('not-a-timestamp')", context), 'not-a-timestamp');
  assert.equal(vm.runInContext("statusLabel({ enabled: false, status: 'idle' })", context), '已禁用');
  assert.equal(vm.runInContext("statusClass({ enabled: false, status: 'idle' })", context), 'disabled');
  assert.equal(vm.runInContext("statusLabel({ enabled: true, status: 'waiting_scheduled' })", context), '后台运行中');
  assert.match(element('#runtimeMeta').textContent, /最高权限/);
  assert.match(element('#runtimeMeta').textContent, /API 请求 0\/64/);
  assert.match(element('#runtimeMeta').textContent, /日志流 0\/8/);
  vm.runInContext(`
    state.dashboard.runtime = {
      ...state.dashboard.runtime,
      ready: false,
      degradedReasons: ['host_launcher_unavailable', 'storage_capacity_low', 'host_launcher_unavailable']
    };
    renderRuntime();
  `, context);
  assert.equal(element('#runtimeDot').classList.contains('ready'), false);
  assert.equal(element('#runtimeAlert').classList.contains('hidden'), false);
  assert.equal(element('#runtimeAlertTitle').textContent, '任务执行已暂停');
  assert.match(element('#runtimeReasons').innerHTML, /Host Launcher 监管中断/);
  assert.match(element('#runtimeReasons').innerHTML, /host_launcher_unavailable/);
  assert.match(element('#runtimeReasons').innerHTML, /持久存储空间不足/);
  assert.equal((element('#runtimeReasons').innerHTML.match(/host_launcher_unavailable/g) || []).length, 1);
  assert.match(element('#runtimeMeta').title, /Host Launcher 监管中断/);
  vm.runInContext(`
    state.lang = 'en';
    renderCache.clear();
    renderRuntime();
  `, context);
  assert.equal(element('#runtimeAlertTitle').textContent, 'Task execution paused');
  assert.match(element('#runtimeReasons').innerHTML, /Host Launcher supervision lost/);
  assert.match(element('#runtimeMeta').textContent, /API 0\/64/);
  assert.match(element('#runtimeMeta').textContent, /Logs 0\/8/);
  vm.runInContext(`
    state.lang = 'zh';
    state.dashboard.runtime.degradedReasons = ['<img src=x onerror=alert(1)>'];
    renderCache.clear();
    renderRuntime();
  `, context);
  assert.doesNotMatch(element('#runtimeReasons').innerHTML, /<img/);
  assert.match(element('#runtimeReasons').innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
  vm.runInContext(`
    state.dashboard.runtime.ready = true;
    state.dashboard.runtime.degradedReasons = [];
    renderCache.clear();
    renderRuntime();
  `, context);
  assert.equal(element('#runtimeDot').classList.contains('ready'), true);
  assert.equal(element('#runtimeAlert').classList.contains('hidden'), true);
  assert.equal(element('#runtimeReasons').innerHTML, '');

  requestHangPath = '/api/runtime/bridge-sessions';
  vm.runInContext("setView('runtime')", context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.filter((url) => url === requestHangPath).length, 1);
  assert.equal(requests.filter((url) => url === '/api/health').length, 1);
  assert.equal(vm.runInContext('state.bridgeInventoryLoading', context), true);
  assert.equal(vm.runInContext('state.bridgeInventoryLoaded', context), false);
  assert.match(element('#bridgeInventoryList').innerHTML, /inventory-loading/);
  assert.match(element('#bridgeInventoryList').innerHTML, /正在扫描 Runtime 库存/);
  assert.match(element('#bridgeInventoryMetrics').innerHTML, /<strong>-<\/strong>/);
  assert.match(element('#protectionMeta').textContent, /检查于/);
  assert.equal(timers.get(vm.runInContext('protectionPollTimer', context)).delay, 30000);
  vm.runInContext("setView('overview')", context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(vm.runInContext('state.bridgeInventoryLoading', context), false);
  assert.equal(vm.runInContext('protectionPollTimer === null', context), true);
  assert.equal([...timers.values()].some((timer) => timer.delay === 2000), false);

  requestHangPath = '';
  responseOverrides.set('GET /api/runtime/bridge-sessions', { payload: bridgeInventory });
  vm.runInContext("setView('runtime')", context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.filter((url) => url === '/api/runtime/bridge-sessions').length, 2);
  assert.equal(vm.runInContext('state.bridgeInventoryLoaded', context), true);
  assert.equal(element('#refreshBridgeInventoryBtn').disabled, false);
  assert.match(element('#bridgeInventoryMetrics').innerHTML, /<strong>3<\/strong>/);
  assert.match(element('#bridgeInventoryMetrics').innerHTML, /1\.5 MiB/);
  assert.match(element('#bridgeInventoryMetrics').innerHTML, /1 MiB/);
  assert.match(element('#bridgeInventoryState').textContent, /3 安全/);
  assert.match(element('#protectionGrid').innerHTML, /平台数据/);
  assert.match(element('#protectionGrid').innerHTML, /在线数据库备份/);
  assert.match(element('#protectionGrid').innerHTML, /10 \/ 14/);
  assert.match(element('#protectionGrid').innerHTML, /平台恢复检查点/);
  assert.match(element('#protectionGrid').innerHTML, /待轮转/);
  assert.match(element('#protectionGrid').innerHTML, /4 \/ 3/);
  assert.match(element('#protectionGrid').innerHTML, /超出 1 份，下次成功发布后轮转/);
  assert.match(element('#protectionMeta').textContent, /检查于/);
  assert.match(element('#bridgeInventoryList').innerHTML, /session-1111111111111111/);
  assert.match(element('#bridgeInventoryList').innerHTML, /任务占用/);
  assert.match(element('#bridgeInventoryList').innerHTML, /孤立 Session/);
  assert.match(element('#bridgeInventoryList').innerHTML, /已完成保留/);
  assert.match(element('#bridgeInventoryList').innerHTML, /工作区锁/);
  assert.match(element('#bridgeInventoryList').innerHTML, /运行锁/);
  assert.equal((element('#bridgeInventoryList').innerHTML.match(/data-action="reclaim-bridge-session"/g) || []).length, 2);
  assert.doesNotMatch(
    vm.runInContext("bridgeInventoryRow(state.bridgeInventory.sessions.find((session) => session.category === 'task_owned'))", context),
    /reclaim-bridge-session/,
  );

  vm.runInContext("state.lang = 'en'; renderCache.clear(); renderBridgeInventory(); renderProtectionStatus()", context);
  assert.match(element('#bridgeInventoryList').innerHTML, /Task Owned/);
  assert.match(element('#bridgeInventoryList').innerHTML, /Reclaim Runtime/);
  assert.match(element('#bridgeInventoryState').textContent, /3 safe/);
  assert.match(element('#protectionGrid').innerHTML, /Data Integrity &amp; Recovery Protection|Platform Data/);
  assert.match(element('#protectionGrid').innerHTML, /Rotation Pending/);
  assert.match(element('#protectionGrid').innerHTML, /1 excess; rotates after next successful publish/);
  assert.match(element('#protectionMeta').textContent, /Checked/);
  vm.runInContext("state.lang = 'zh'; renderCache.clear(); renderBridgeInventory(); renderProtectionStatus()", context);

  const recoveredHealth = structuredClone(health);
  recoveredHealth.backups.lastError = 'historical scheduler outage';
  recoveredHealth.backups.lastErrorAt = '2026-08-03T05:54:00.000Z';
  responseOverrides.set('GET /api/health', { payload: recoveredHealth });
  await vm.runInContext('loadProtectionStatus()', context);
  assert.equal(vm.runInContext("protectionPackageStatus(state.protectionStatus.backups, 'backupCount', 'unreadableBackupCount').className", context), 'healthy');
  assert.doesNotMatch(element('#protectionGrid').innerHTML, /historical scheduler outage/);

  const degradedHealth = structuredClone(health);
  degradedHealth.ok = false;
  degradedHealth.ready = false;
  degradedHealth.backups.lastError = 'injected scheduler outage <unsafe>';
  degradedHealth.backups.lastErrorAt = '2026-08-03T05:57:00.000Z';
  degradedHealth.backups.unrecordedAuditEventCount = 2;
  degradedHealth.backups.auditQueueDurable = false;
  degradedHealth.backups.lastOutboxError = 'audit disk unavailable';
  responseOverrides.set('GET /api/health', { status: 503, payload: degradedHealth });
  await vm.runInContext('loadProtectionStatus()', context);
  assert.match(element('#protectionGrid').innerHTML, /protection-card error/);
  assert.match(element('#protectionGrid').innerHTML, /injected scheduler outage &lt;unsafe&gt;/);
  assert.match(element('#protectionGrid').innerHTML, /2 条待写入 · audit disk unavailable/);
  assert.doesNotMatch(element('#protectionGrid').innerHTML, /<unsafe>/);
  assert.equal(vm.runInContext('state.protectionFailureCount', context), 0);
  assert.equal(timers.get(vm.runInContext('protectionPollTimer', context)).delay, 30000);

  const activeProtectionHealth = structuredClone(health);
  activeProtectionHealth.backups.inProgress = true;
  responseOverrides.set('GET /api/health', { payload: activeProtectionHealth });
  await vm.runInContext('loadProtectionStatus()', context);
  assert.equal(timers.get(vm.runInContext('protectionPollTimer', context)).delay, 2000);
  const healthRequestsBeforeActivePoll = requests.filter((url) => url === '/api/health').length;
  responseOverrides.set('GET /api/health', { payload: health });
  const activePollTimerId = vm.runInContext('protectionPollTimer', context);
  const activePoll = timers.get(activePollTimerId);
  timers.delete(activePollTimerId);
  activePoll.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.filter((url) => url === '/api/health').length, healthRequestsBeforeActivePoll + 1);
  assert.equal(vm.runInContext('state.protectionFailureCount', context), 0);
  assert.equal(timers.get(vm.runInContext('protectionPollTimer', context)).delay, 30000);

  responseOverrides.set('GET /api/health', { status: 500, payload: { error: 'health unavailable <unsafe>' } });
  const firstProtectionFailure = await vm.runInContext(`
    loadProtectionStatus().then(() => null, (error) => ({ name: error.name, message: error.message }))
  `, context);
  assert.equal(firstProtectionFailure.message, 'health unavailable <unsafe>');
  assert.equal(vm.runInContext('state.protectionFailureCount', context), 1);
  assert.match(element('#protectionMeta').textContent, /状态刷新失败：health unavailable <unsafe>/);
  assert.equal(element('#protectionMeta').classList.contains('error'), true);
  assert.match(element('#protectionGrid').innerHTML, /4 \/ 3/);
  assert.equal(timers.get(vm.runInContext('protectionPollTimer', context)).delay, 2000);

  const firstRetryTimerId = vm.runInContext('protectionPollTimer', context);
  const firstRetry = timers.get(firstRetryTimerId);
  timers.delete(firstRetryTimerId);
  firstRetry.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(vm.runInContext('state.protectionFailureCount', context), 2);
  assert.equal(timers.get(vm.runInContext('protectionPollTimer', context)).delay, 4000);

  responseOverrides.set('GET /api/health', { payload: health });
  const secondRetryTimerId = vm.runInContext('protectionPollTimer', context);
  const secondRetry = timers.get(secondRetryTimerId);
  timers.delete(secondRetryTimerId);
  secondRetry.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(vm.runInContext('state.protectionFailureCount', context), 0);
  assert.equal(vm.runInContext('state.protectionError', context), '');
  assert.equal(element('#protectionMeta').classList.contains('error'), false);
  assert.match(element('#protectionMeta').textContent, /检查于/);
  assert.equal(timers.get(vm.runInContext('protectionPollTimer', context)).delay, 30000);

  requestHangPath = '/api/health';
  const cancelledProtection = vm.runInContext(`
    loadProtectionStatus().then(() => 'resolved', (error) => error.name)
  `, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(vm.runInContext('state.protectionLoading', context), true);
  vm.runInContext("setView('overview')", context);
  assert.equal(await cancelledProtection, 'AbortError');
  assert.equal(vm.runInContext('state.protectionLoading', context), false);
  assert.equal(vm.runInContext('state.protectionController === null', context), true);
  requestHangPath = '';
  vm.runInContext("setView('runtime')", context);
  await new Promise((resolve) => setImmediate(resolve));

  vm.runInContext("openBridgeReclaim('session-1111111111111111')", context);
  assert.equal(vm.runInContext('state.selectedBridgeSessionId', context), '');
  assert.match(element('#toastMessage').textContent, /当前不可回收/);
  vm.runInContext("openBridgeReclaim('session-2222222222222222')", context);
  assert.equal(vm.runInContext('state.selectedBridgeSessionId', context), 'session-2222222222222222');
  assert.equal(element('#bridgeReclaimTarget').textContent, 'session-2222222222222222');
  assert.equal(element('#confirmBridgeReclaimBtn').disabled, true);
  element('#bridgeReclaimInput').value = ' session-2222222222222222';
  assert.equal(vm.runInContext('validateBridgeReclaimConfirmation()', context), false);
  assert.equal(element('#confirmBridgeReclaimBtn').disabled, true);
  element('#bridgeReclaimInput').value = 'session-2222222222222222';
  assert.equal(vm.runInContext('validateBridgeReclaimConfirmation()', context), true);
  assert.equal(element('#confirmBridgeReclaimBtn').disabled, false);

  const reclaimedInventory = {
    summary: {
      ...bridgeInventory.summary,
      total: 2,
      reclaimable: 1,
      totalBytes: 786432,
      reclaimableBytes: 262144,
      categories: { task_owned: 1, completed_retained: 1 },
    },
    sessions: bridgeInventory.sessions.filter((session) => session.sessionId !== 'session-2222222222222222'),
  };
  responseOverrides.set('GET /api/runtime/bridge-sessions', { payload: reclaimedInventory });
  responseOverrides.set('POST /api/runtime/bridge-sessions/session-2222222222222222/reclaim', {
    payload: { job: { id: 'cleanup-1', status: 'pending' } },
  });
  const firstReclaim = vm.runInContext('submitBridgeReclaim({ preventDefault() {} })', context);
  const duplicateReclaim = vm.runInContext('submitBridgeReclaim({ preventDefault() {} })', context);
  await Promise.all([firstReclaim, duplicateReclaim]);
  const reclaimRequests = requestDetails.filter((request) => request.url === '/api/runtime/bridge-sessions/session-2222222222222222/reclaim');
  assert.equal(reclaimRequests.length, 1);
  assert.equal(reclaimRequests[0].method, 'POST');
  assert.deepEqual(reclaimRequests[0].body, { confirmationSessionId: 'session-2222222222222222' });
  assert.equal(element('#bridgeReclaimModal').classList.contains('hidden'), true);
  assert.equal(vm.runInContext('state.bridgeReclaimSubmitting', context), false);
  assert.doesNotMatch(element('#bridgeInventoryList').innerHTML, /session-2222222222222222/);
  assert.match(element('#toastMessage').textContent, /回收作业已入队/);
  vm.runInContext("setView('overview')", context);

  const requestCountBeforeDisabledRun = requests.length;
  vm.runInContext(`
    state.dashboard.sessions.push({ id: 'disabled', enabled: false, status: 'idle' });
    state.currentTaskId = 'disabled';
  `, context);
  await vm.runInContext('runOrRecoverTask({ preventDefault() {} })', context);
  assert.equal(requests.length, requestCountBeforeDisabledRun);

  const retryTask = {
    id: 'retry-task', enabled: true, status: 'waiting_review', version: 7,
    updatedAt: '2026-08-03T00:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z',
  };
  vm.runInContext(`state.dashboard.sessions.push(${JSON.stringify(retryTask)})`, context);
  requestHangPath = '/api/sessions/retry-task/run';
  const firstRun = vm.runInContext(`
    queueTaskRun(findTask('retry-task'), 'same input')
      .then(() => null, (error) => ({ name: error.name, message: error.message }));
  `, context);
  await new Promise((resolve) => setImmediate(resolve));
  const firstRunTimeout = [...timers.entries()].find(([, timer]) => timer.delay === 30000);
  assert.ok(firstRunTimeout);
  timers.delete(firstRunTimeout[0]);
  firstRunTimeout[1].callback();
  const firstRunResult = await firstRun;
  assert.equal(firstRunResult.name, 'RequestTimeoutError');
  const firstRunRequest = requestDetails.filter((request) => request.url === requestHangPath).at(-1);
  assert.equal(firstRunRequest.method, 'POST');
  assert.equal(firstRunRequest.body.input, 'same input');
  assert.match(firstRunRequest.body.idempotencyKey, /^web-run-/);
  assert.equal(vm.runInContext("runIntents.has('retry-task')", context), true);
  const storedRunIntents = sessionValues.get('codex-task-run-intents-v1');
  assert.ok(storedRunIntents);
  assert.doesNotMatch(storedRunIntents, /same input/);
  const [storedRunIntent] = JSON.parse(storedRunIntents);
  assert.equal(storedRunIntent.idempotencyKey, firstRunRequest.body.idempotencyKey);
  assert.equal(storedRunIntent.inputHash, nodeCrypto.createHash('sha256').update('same input').digest('hex'));
  assert.equal(Object.hasOwn(storedRunIntent, 'input'), false);

  vm.runInContext(`
    runIntents.clear();
    for (const [taskId, intent] of loadRunIntents()) runIntents.set(taskId, intent);
  `, context);
  assert.equal(vm.runInContext("runIntents.get('retry-task').input", context), undefined);

  requestHangPath = '';
  await vm.runInContext("queueTaskRun(findTask('retry-task'), 'same input')", context);
  const retriedRunRequest = requestDetails.filter((request) => request.url === '/api/sessions/retry-task/run').at(-1);
  assert.equal(retriedRunRequest.body.idempotencyKey, firstRunRequest.body.idempotencyKey);
  assert.equal(vm.runInContext("runIntents.has('retry-task')", context), false);
  assert.equal(sessionValues.has('codex-task-run-intents-v1'), false);

  sessionStorage.setItem('codex-task-run-intents-v1', '{invalid json');
  assert.equal(vm.runInContext('loadRunIntents().size', context), 0);
  assert.equal(sessionValues.has('codex-task-run-intents-v1'), false);

  requestHangPath = '/api/sessions/retry-task/run';
  const differentRun = vm.runInContext(`
    queueTaskRun(findTask('retry-task'), 'different input')
      .then(() => null, (error) => ({ name: error.name, message: error.message }));
  `, context);
  await new Promise((resolve) => setImmediate(resolve));
  const differentRunTimeout = [...timers.entries()].find(([, timer]) => timer.delay === 30000);
  assert.ok(differentRunTimeout);
  timers.delete(differentRunTimeout[0]);
  differentRunTimeout[1].callback();
  await differentRun;
  const differentRunRequest = requestDetails.filter((request) => request.url === requestHangPath).at(-1);
  assert.notEqual(differentRunRequest.body.idempotencyKey, firstRunRequest.body.idempotencyKey);
  assert.equal(vm.runInContext("runIntents.has('retry-task')", context), true);

  requestHangPath = '';
  dashboard.sessions = [{ ...retryTask, status: 'queued', version: 8, updatedAt: '2026-08-03T00:01:00.000Z' }];
  await vm.runInContext('loadDashboard({ force: true })', context);
  assert.equal(vm.runInContext("runIntents.has('retry-task')", context), false);
  assert.equal(sessionValues.has('codex-task-run-intents-v1'), false);

  const operationTask = {
    id: 'operation-task', enabled: true, status: 'running', version: 4,
    updatedAt: '2026-08-03T01:00:00.000Z', createdAt: '2026-08-03T00:30:00.000Z',
  };
  vm.runInContext(`state.dashboard.sessions.push(${JSON.stringify(operationTask)})`, context);
  requestHangPath = '/api/sessions/operation-task/stop';
  requestHangMethod = 'POST';
  responseOverrides.set('GET /api/sessions/operation-task', { payload: operationTask });
  const unknownStop = vm.runInContext(`
    requestTaskOperation(findTask('operation-task'), 'stop')
      .then(() => null, (error) => ({ name: error.name, message: error.message }));
  `, context);
  await new Promise((resolve) => setImmediate(resolve));
  const stopTimeout = [...timers.entries()].find(([, timer]) => timer.delay === 30000);
  assert.ok(stopTimeout);
  timers.delete(stopTimeout[0]);
  stopTimeout[1].callback();
  const unknownStopResult = await unknownStop;
  assert.equal(unknownStopResult.name, 'RequestTimeoutError');
  assert.match(unknownStopResult.message, /系统已保留操作标识/);
  assert.equal(vm.runInContext("taskOperationIntents.has('stop:operation-task')", context), true);
  const firstStopRequest = requestDetails
    .filter((request) => request.url === requestHangPath && request.method === 'POST').at(-1);
  assert.match(firstStopRequest.headers['Idempotency-Key'], /^web-stop-/);
  assert.equal(firstStopRequest.headers['X-Task-Created-At'], operationTask.createdAt);
  const storedOperationIntents = JSON.parse(sessionValues.get('codex-task-operation-intents-v1'));
  assert.equal(storedOperationIntents[0].idempotencyKey, firstStopRequest.headers['Idempotency-Key']);

  requestHangPath = '';
  requestHangMethod = '';
  responseOverrides.set('POST /api/sessions/operation-task/stop', { payload: { ok: true } });
  await vm.runInContext("requestTaskOperation(findTask('operation-task'), 'stop')", context);
  const retriedStopRequest = requestDetails
    .filter((request) => request.url === '/api/sessions/operation-task/stop' && request.method === 'POST').at(-1);
  assert.equal(retriedStopRequest.headers['Idempotency-Key'], firstStopRequest.headers['Idempotency-Key']);
  assert.equal(vm.runInContext("taskOperationIntents.has('stop:operation-task')", context), false);
  assert.equal(sessionValues.has('codex-task-operation-intents-v1'), false);

  const archivedTask = {
    id: 'archived-operation-task', enabled: true, status: 'completed', version: 7,
    updatedAt: '2026-08-03T01:10:00.000Z', createdAt: '2026-08-03T00:40:00.000Z',
    persistentSessionKey: 'single:archived-operation-task',
  };
  vm.runInContext(`state.dashboard.sessions.push(${JSON.stringify(archivedTask)})`, context);
  responseOverrides.set('POST /api/sessions/archived-operation-task/restore', {
    payload: { ...archivedTask, status: 'waiting_input', archivedAt: '' },
  });
  const restoredTask = await vm.runInContext(
    "requestTaskOperation(findTask('archived-operation-task'), 'restore')",
    context,
  );
  assert.equal(restoredTask.status, 'waiting_input');
  const restoreRequest = requestDetails
    .filter((request) => request.url === '/api/sessions/archived-operation-task/restore').at(-1);
  assert.match(restoreRequest.headers['Idempotency-Key'], /^web-restore-/);
  assert.equal(restoreRequest.headers['X-Task-Created-At'], archivedTask.createdAt);
  assert.equal(vm.runInContext("operationSucceededInState({ operation: 'restore', taskCreatedAt: '2026-08-03T00:40:00.000Z' }, { status: 'waiting_input', createdAt: '2026-08-03T00:40:00.000Z' })", context), true);
  vm.runInContext("renderTaskDetail(findTask('archived-operation-task'))", context);
  assert.match(elements.get('#taskDetailHead').innerHTML, /data-action="restore-task"/);

  const deleteTaskState = {
    id: 'delete-response-loss', enabled: true, status: 'stopped', version: 3,
    updatedAt: '2026-08-03T02:00:00.000Z', createdAt: '2026-08-03T01:30:00.000Z',
  };
  vm.runInContext(`state.dashboard.sessions.push(${JSON.stringify(deleteTaskState)})`, context);
  requestHangPath = '/api/sessions/delete-response-loss';
  requestHangMethod = 'DELETE';
  responseOverrides.set('GET /api/sessions/delete-response-loss', { status: 404, payload: { error: 'Not found' } });
  const reconciledDelete = vm.runInContext(
    "requestTaskOperation(findTask('delete-response-loss'), 'delete')",
    context,
  );
  await new Promise((resolve) => setImmediate(resolve));
  const deleteTimeout = [...timers.entries()].find(([, timer]) => timer.delay === 30000);
  assert.ok(deleteTimeout);
  timers.delete(deleteTimeout[0]);
  deleteTimeout[1].callback();
  assert.equal((await reconciledDelete).ok, true);
  assert.equal(vm.runInContext("taskOperationIntents.has('delete:delete-response-loss')", context), false);
  requestHangPath = '';
  requestHangMethod = '';

  responseOverrides.set('GET /api/sessions/reload-delete', { status: 404, payload: { error: 'Not found' } });
  vm.runInContext(`
    taskOperationIntents.set('delete:reload-delete', {
      taskId: 'reload-delete', operation: 'delete', idempotencyKey: 'web-delete-restored',
      taskCreatedAt: '2026-08-03T02:30:00.000Z'
    });
    persistTaskOperationIntents();
  `, context);
  await vm.runInContext('reconcilePersistedTaskOperationIntents()', context);
  assert.equal(vm.runInContext("taskOperationIntents.has('delete:reload-delete')", context), false);
  assert.equal(sessionValues.has('codex-task-operation-intents-v1'), false);

  assert.match(APP_SOURCE, /await api\('\/api\/sessions\/start'/);
  assert.doesNotMatch(APP_SOURCE, /queueTaskRun\(createdTask/);
  assert.match(APP_SOURCE, /await queueTaskRun\(task, input\)/);
  assert.match(APP_SOURCE, /requestTaskOperation\(task, 'complete'\)/);
  assert.match(APP_SOURCE, /requestTaskOperation\(task, 'restore'\)/);
  assert.match(APP_SOURCE, /Idempotency-Key/);
  assert.match(APP_SOURCE, /X-Task-Created-At/);
  assert.match(APP_SOURCE, /\/executions/);
  assert.match(APP_SOURCE, /\/attempts/);
  assert.match(APP_SOURCE, /\/external-attempts/);
  assert.match(APP_SOURCE, /\/scheduled-jobs/);
  assert.match(INDEX_SOURCE, /<button class="active" data-tab="business-summary"/);
  assert.match(INDEX_SOURCE, /data-tab="business-summary"[^>]*>任务摘要</);
  assert.match(INDEX_SOURCE, /data-tab="business-reports"[^>]*>结构化报告</);
  assert.match(INDEX_SOURCE, /data-tab="task-terminal"/);
  assert.match(INDEX_SOURCE, /data-tab="business-summary"[\s\S]*data-tab="business-reports"[\s\S]*data-tab="task-terminal"[\s\S]*data-tab="agent-records"/);
  assert.doesNotMatch(INDEX_SOURCE, /data-tab="(?:worklog|commands)"/);
  assert.match(INDEX_SOURCE, /data-tab="background"/);
  assert.doesNotMatch(INDEX_SOURCE, /data-tab="(?:attempts|executions|raw)"/);
  assert.doesNotMatch(APP_SOURCE, /filterAttention|Needs Attention|需处理/);
  assert.doesNotMatch(INDEX_SOURCE, /data-status="attention"|filterAttention|需处理/);
  assert.doesNotMatch(APP_SOURCE, /loadAllEventPages/);
  assert.match(APP_SOURCE, /detailPageSize:\s*50/);
  assert.match(APP_SOURCE, /auditPageSize:\s*50/);
  const executionHtml = vm.runInContext(`executionList([{
    id: 'execution-1', runtimeItemId: 'item-1', turnId: 'turn-1', attemptId: 'attempt-1',
    turnSequence: 2, turnInput: 'Review exact command', attemptNo: 1,
    configuredWorkingDirectory: '/tmp/configured-project', workingDirectory: '/tmp/runtime-project', workingDirectoryReported: true,
    command: "printf 'audit-sentinel'", output: 'line one\\nline two', exitCode: 0,
    status: 'completed', finishedAt: '2026-07-26T00:00:00.000Z', rawEvent: { type: 'item.completed' }
  }, {
    id: 'execution-2', runtimeItemId: 'item-2', turnId: 'turn-1', attemptId: 'attempt-2',
    turnSequence: 2, turnInput: 'Review exact command', attemptNo: 2,
    configuredWorkingDirectory: '/tmp/configured-project', workingDirectory: '/tmp/runtime-project', workingDirectoryReported: true,
    command: "printf 'audit-sentinel'", output: 'retry output', exitCode: 1,
    status: 'failed', finishedAt: '2026-07-26T00:01:00.000Z', rawEvent: { type: 'item.completed' }
  }])`, context);
  assert.match(executionHtml, /printf &#039;audit-sentinel&#039;/);
  assert.equal((executionHtml.match(/printf &#039;audit-sentinel&#039;/g) || []).length, 1);
  assert.equal((executionHtml.match(/Review exact command/g) || []).length, 1);
  assert.match(executionHtml, /重复执行 × 2/);
  assert.match(executionHtml, /line one\nline two/);
  assert.match(executionHtml, /attempt-1/);
  assert.match(executionHtml, /Review exact command/);
  assert.match(executionHtml, /\/tmp\/configured-project/);
  assert.match(executionHtml, /\/tmp\/runtime-project/);
  const agentRecordsHtml = vm.runInContext(`agentRecordsList([{
    id: 'worklog-1', kind: 'session.turn.result', turnId: 'turn-1',
    ts: '2026-07-26T00:02:00.000Z', message: 'Agent finished the requested check'
  }], [{
    id: 'execution-agent-record', runtimeItemId: 'item-agent-record', turnId: 'turn-1',
    attemptId: 'attempt-1', turnSequence: 1, turnInput: 'Run the check', attemptNo: 1,
    command: 'python3 -m pytest -v test_agent_record.py', output: '1 passed', exitCode: 0,
    status: 'completed', finishedAt: '2026-07-26T00:01:00.000Z', rawEvent: { type: 'item.completed' }
  }])`, context);
  assert.match(agentRecordsHtml, /Agent 工作记录/);
  assert.match(agentRecordsHtml, /Agent 命令/);
  assert.match(agentRecordsHtml, /Agent finished the requested check/);
  assert.match(agentRecordsHtml, /python3 -m pytest -v test_agent_record\.py/);
  const unreportedDirectoryHtml = vm.runInContext(`executionList([{
    id: 'execution-2', runtimeItemId: 'item-2', turnId: 'turn-1', attemptId: 'attempt-1',
    configuredWorkingDirectory: '/tmp/configured-only', workingDirectory: '', workingDirectoryReported: false,
    command: 'pwd', output: '', status: 'completed', rawEvent: { type: 'item.completed' }
  }])`, context);
  assert.match(unreportedDirectoryHtml, /\/tmp\/configured-only/);
  assert.match(unreportedDirectoryHtml, /执行端未上报/);
  const attemptHtml = vm.runInContext(`attemptList([{
    id: 'attempt-1', turnId: 'turn-1', turnSequence: 2, turnInput: 'Review exact command',
    attemptNo: 1, pid: 4321, exitCode: 1, signal: 'SIGTERM', status: 'interrupted',
    error: 'Execution stopped', startedAt: '2026-07-26T00:00:00.000Z', finishedAt: '2026-07-26T00:01:00.000Z'
  }])`, context);
  assert.match(attemptHtml, /attempt-1/);
  assert.match(attemptHtml, /Review exact command/);
  assert.match(attemptHtml, /SIGTERM/);
  assert.match(attemptHtml, /Execution stopped/);
  const taskTerminalHtml = vm.runInContext(`attemptList([{
    id: 'attempt-raw', turnId: 'turn-1', turnSequence: 1, attemptNo: 1, pid: 99,
    status: 'failed', error: 'stale command-shaped summary', stdoutAvailable: true, stdoutBytes: 42
  }])`, context);
  assert.match(taskTerminalHtml, /attempt-raw\/stdout/);
  assert.match(taskTerminalHtml, /data-action="view-attempt-output"/);
  assert.match(taskTerminalHtml, /data-attempt-output="stdout"/);
  assert.match(taskTerminalHtml, /data-terminal-host/);
  assert.match(taskTerminalHtml, /data-terminal-fallback/);
  assert.match(taskTerminalHtml, /terminal-session-dot/);
  assert.match(taskTerminalHtml, /terminal-raw-link/);
  assert.match(taskTerminalHtml, /打开完整原始输出/);
  assert.doesNotMatch(taskTerminalHtml, /stale command-shaped summary/);
  assert.match(INDEX_SOURCE, /data-tab="task-terminal"[^>]*>Codex CLI</);
  assert.doesNotMatch(INDEX_SOURCE, /data-tab="execution-log"|执行日志/);
  assert.match(INDEX_SOURCE, /data-tab="agent-records"[^>]*>Agent 记录</);
  assert.match(INDEX_SOURCE, /id="fontSizeControl"[^>]*role="group"/);
  assert.equal((INDEX_SOURCE.match(/data-font-size="(?:small|standard|large)"/g) || []).length, 3);
  assert.match(INDEX_SOURCE, /\/vendor\/xterm\/xterm\.css/);
  assert.match(INDEX_SOURCE, /\/vendor\/xterm\/xterm\.js/);
  assert.match(INDEX_SOURCE, /\/vendor\/xterm\/addon-fit\.js/);
  assert.doesNotMatch(INDEX_SOURCE, /cdn\.jsdelivr\.net\/npm\/xterm/);
  assert.match(APP_SOURCE, /new globalThis\.Terminal\(\{[\s\S]*disableStdin:\s*true[\s\S]*scrollback:\s*20000/);
  assert.match(APP_SOURCE, /disposeAttemptTerminals\(\)/);
  assert.doesNotMatch(APP_SOURCE, /execution-log|executionLog/);
  assert.match(APP_SOURCE, /async function openTaskDetail\(id, initialTab = 'business-summary'\)[\s\S]*state\.detailTab\s*=\s*initialTab/);
  assert.match(STYLES_SOURCE, /\.attempt-terminal-host\s*\{[^}]*height:\s*clamp\(360px, calc\(100vh - 410px\), 720px\)/s);
  assert.match(APP_SOURCE, /taskDetailModal'\)\.dataset\.detailTab\s*=\s*state\.detailTab/);
  assert.doesNotMatch(STYLES_SOURCE, /#taskDetailModal\[data-detail-tab="(?:business-summary|task-terminal)"\] \.task-detail-body\s*\{/s);
  assert.doesNotMatch(STYLES_SOURCE, /#taskDetailModal\[data-detail-tab="business-summary"\] \.task-context\s*\{[^}]*display:\s*none/s);
  assert.match(STYLES_SOURCE, /html\[data-font-size="small"\]\s*\{[^}]*--ui-root-font-size:\s*16px[^}]*\}[\s\S]*html\[data-font-size="standard"\]\s*\{[^}]*18px[^}]*\}[\s\S]*html\[data-font-size="large"\]\s*\{[^}]*20px/s);
  assert.match(STYLES_SOURCE, /@media \(max-width:\s*860px\)[\s\S]*\.app-shell\s*\{[^}]*max-width:\s*100vw;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  assert.match(STYLES_SOURCE, /@media \(max-width:\s*860px\)[\s\S]*\.nav\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*overflow-x:\s*auto/s);
  assert.match(STYLES_SOURCE, /\.task-console\s*\{[^}]*--detail-font-title:\s*1rem;[^}]*--detail-font-body:\s*\.9375rem;[^}]*--detail-font-section-title:\s*\.875rem;[^}]*--detail-font-command:\s*\.8125rem;[^}]*--detail-font-meta:\s*\.75rem;/s);
  assert.match(STYLES_SOURCE, /#taskDetailModal:not\(\[data-detail-tab="task-terminal"\]\) #taskConsoleOutput :where\(span, code, time, small, dt, summary, th, td\)\s*\{[^}]*font-size:\s*var\(--detail-font-meta\)/s);
  assert.match(STYLES_SOURCE, /\.business-summary-head h3\s*\{[^}]*font-size:\s*var\(--detail-font-title\)/s);
  assert.match(STYLES_SOURCE, /\.business-summary-head p\s*\{[^}]*font:\s*var\(--detail-font-body\)\/1\.5/s);
  assert.match(STYLES_SOURCE, /\.business-regression-command pre\s*\{[^}]*font:\s*var\(--detail-font-command\)\/1\.65/s);
  assert.match(STYLES_SOURCE, /\.business-timeline-content p\s*\{[^}]*font-size:\s*var\(--detail-font-body\)/s);
  assert.doesNotMatch(STYLES_SOURCE, /\.business-(?:summary|regression|timeline)[^{]*\{[^}]*(?:font-size|font):\s*(?:1[6-9]|[2-9][0-9])px/s);
  assert.match(STYLES_SOURCE, /@media \(max-width:\s*768px\)[\s\S]*#taskDetailModal\s*\{[^}]*padding:\s*0[\s\S]*#taskDetailModal\s+\.task-detail-modal\s*\{[^}]*height:\s*100dvh/s);
  assert.match(STYLES_SOURCE, /@media \(max-width:\s*768px\)[\s\S]*#taskDetailModal\[data-detail-tab="task-terminal"\][\s\S]*\.codex-cli-terminal\s*\{[^}]*padding:/s);
  assert.match(STYLES_SOURCE, /\.attempt-terminal-host \.xterm-rows\s*\{[^}]*font-family:\s*"Courier New"[^}]*white-space:\s*pre/s);
  assert.match(STYLES_SOURCE, /\.attempt-terminal-host \.xterm-fg-2[^}]*color:\s*#a6e3a1/s);
  assert.match(STYLES_SOURCE, /#taskDetailModal\[data-detail-tab="task-terminal"\] \.prompt-composer\s*\{[^}]*display:\s*none/s);
  assert.doesNotMatch(STYLES_SOURCE, /#taskDetailModal\[data-detail-tab="task-terminal"\] \.task-context/);
  assert.match(STYLES_SOURCE, /\.codex-cli-shell\s*\{[^}]*grid-template-rows:\s*42px minmax\(0, 1fr\) auto/s);
  assert.doesNotMatch(STYLES_SOURCE, /\.task-detail-modal:has\(\.codex-cli-shell\[data-terminal-mode="fixed-replay"\]\)/);
  assert.match(APP_SOURCE, /codex-terminal\/live/);
  const codexTerminalHtml = vm.runInContext('codexTerminalPage()', context);
  assert.match(codexTerminalHtml, /data-action="codex-cli-toggle-input"/);
  assert.match(codexTerminalHtml, /role="switch"/);
  assert.match(codexTerminalHtml, /data-codex-cli-input-state>只读</);
  assert.match(codexTerminalHtml, /data-action="codex-cli-interrupt"[^>]*disabled/);
  assert.match(codexTerminalHtml, /data-action="codex-cli-terminate" disabled/);
  const managedCodexTerminalHtml = vm.runInContext('codexTerminalPage(true)', context);
  assert.match(managedCodexTerminalHtml, /data-action="codex-cli-toggle-input"[^>]*disabled/);
  assert.equal(vm.runInContext(`managedCodexTerminalStream(
    { id: 'managed-task', status: 'running' },
    [
      { id: 'completed-attempt', status: 'completed' },
      { id: 'running-attempt', status: 'running' }
    ],
    [{ id: 'running-external', status: 'running' }]
  ).webSocketUrl(17)`, context), `${authenticatedWebSocketOrigin}/api/sessions/managed-task/attempts/running-attempt/stdout/live?offset=17`);
  assert.equal(vm.runInContext(`managedCodexTerminalStream(
    { id: 'managed-task', status: 'running' },
    [{ id: 'running-attempt', status: 'running' }],
    []
  ).outputFormat`, context), 'raw');
  assert.deepEqual(
    JSON.parse(vm.runInContext(`JSON.stringify((({ cols, rows }) => ({ cols, rows }))(
      managedCodexTerminalStream(
        { id: 'managed-task', status: 'running' },
        [{ id: 'running-attempt', status: 'running' }],
        []
      )
    ))`, context)),
    { cols: 120, rows: 40 },
  );
  assert.equal(vm.runInContext(`managedCodexTerminalStream(
    { id: 'legacy-task', status: 'waiting_review' },
    [{ id: 'legacy-attempt', status: 'completed', stdoutFormat: 'codex-jsonl' }],
    []
  ).outputFormat`, context), 'codex-jsonl');
  assert.equal(vm.runInContext(`managedCodexTerminalStream(
    { id: 'legacy-task', status: 'waiting_review' },
    [{ id: 'legacy-attempt', status: 'completed', stdoutFormat: 'codex-jsonl' }],
    []
  ).cols`, context), undefined);
  assert.equal(vm.runInContext(`managedCodexTerminalStream(
    { id: 'scheduled-task', status: 'waiting_scheduled' },
    [{ id: 'completed-attempt', status: 'completed' }],
    [{ id: 'running-external', status: 'running' }]
  ).webSocketUrl(23)`, context), `${authenticatedWebSocketOrigin}/api/sessions/scheduled-task/attempts/completed-attempt/stdout/live?offset=23`);
  assert.equal(vm.runInContext(`managedCodexTerminalStream(
    { id: 'scheduled-without-turn', status: 'waiting_scheduled' },
    [],
    [{ id: 'running-external', status: 'running' }]
  ).kind`, context), 'waiting');
  assert.equal(vm.runInContext(`managedCodexTerminalStream(
    { id: 'queued-task', status: 'queued' }, [], []
  ).kind`, context), 'waiting');
  assert.equal(vm.runInContext(`managedCodexTerminalStream(
    { id: 'review-task', status: 'waiting_review' },
    [{ id: 'review-attempt', status: 'completed' }], []
  ).webSocketUrl(31)`, context), `${authenticatedWebSocketOrigin}/api/sessions/review-task/attempts/review-attempt/stdout/live?offset=31`);
  assert.equal(vm.runInContext(`managedCodexTerminalStream(
    { id: 'archived-task', status: 'completed' }, [], []
  )`, context), null);
  assert.match(APP_SOURCE, /function initializeCodexTerminal[\s\S]*fontSize:\s*terminalFontSize\(18\)/);
  assert.match(APP_SOURCE, /openTaskDetail\(id, 'task-terminal'\)/);
  assert.match(APP_SOURCE, /detailTab === 'task-terminal'[\s\S]*\/attempts\?limit=50[\s\S]*\/external-attempts\?limit=50/);
  assert.match(APP_SOURCE, /new globalThis\.Terminal\(\{[\s\S]*disableStdin:\s*true[\s\S]*convertEol:\s*false/);
  assert.match(APP_SOURCE, /fixedReplay\s*=\s*managedStream\?\.outputFormat\s*===\s*'raw'/);
  assert.doesNotMatch(APP_SOURCE, /fitFixedCodexReplayWidth|MANAGED_CODEX_TERMINAL_(?:MIN|MAX)_FONT_SIZE|letterSpacing/);
  assert.match(APP_SOURCE, /view\.resizeObserver\s*=\s*!fixedReplay\s*&&\s*typeof globalThis\.ResizeObserver/);
  assert.doesNotMatch(STYLES_SOURCE, /data-terminal-mode="fixed-replay"[^}]*overflow:\s*auto/);
  assert.match(STYLES_SOURCE, /data-terminal-mode="fixed-replay"[^}]*overflow-x:\s*auto[^}]*overflow-y:\s*hidden/);
  assert.match(STYLES_SOURCE, /\.codex-cli-terminal \.xterm\s*\{\s*height:\s*100%/);
  assert.match(STYLES_SOURCE, /data-terminal-mode="fixed-replay"[^}]*\.xterm-screen\s*\{[^}]*min-width:\s*100%/);
  assert.match(STYLES_SOURCE, /\.codex-cli-terminal \.xterm-viewport\s*\{[^}]*background:\s*#11111b/);
  assert.match(APP_SOURCE, /function positionManagedCodexTerminalOutput[\s\S]*terminal\.scrollToBottom/);
  assert.doesNotMatch(APP_SOURCE, /function positionManagedCodexTerminalOutput[\s\S]*host\.scrollTop\s*=\s*host\.scrollHeight/);
  assert.match(APP_SOURCE, /terminal\.onData\(\(data\) => sendUnlockedCodexTerminalControl\('input'/);
  assert.match(STYLES_SOURCE, /\.codex-cli-input-lock input:checked \+ i::after\s*\{[^}]*transform:\s*translateX\(12px\)/s);
  vm.runInContext(`
    globalThis.codexLockControls = [{ disabled: false }, { disabled: false }];
    globalThis.codexLockToggle = { checked: true };
    globalThis.codexLockLabel = { textContent: '' };
    globalThis.codexLockView = {
      inputUnlocked: true,
      shell: {
        dataset: {},
        querySelector(selector) {
          if (selector === '[data-action="codex-cli-toggle-input"]') return codexLockToggle;
          if (selector === '[data-codex-cli-input-state]') return codexLockLabel;
          return null;
        },
        querySelectorAll() { return codexLockControls; }
      },
      terminal: { options: { disableStdin: false }, focus() { globalThis.codexLockFocused = true; } }
    };
    setCodexTerminalInputUnlocked(codexLockView, false);
  `, context);
  assert.equal(vm.runInContext('codexLockView.inputUnlocked', context), false);
  assert.equal(vm.runInContext('codexLockView.terminal.options.disableStdin', context), true);
  assert.equal(vm.runInContext('codexLockToggle.checked', context), false);
  assert.equal(vm.runInContext('codexLockLabel.textContent', context), '只读');
  assert.equal(vm.runInContext('codexLockControls.every((control) => control.disabled)', context), true);
  vm.runInContext('setCodexTerminalInputUnlocked(codexLockView, true)', context);
  assert.equal(vm.runInContext('codexLockView.terminal.options.disableStdin', context), false);
  assert.equal(vm.runInContext('codexLockLabel.textContent', context), '允许输入');
  assert.equal(vm.runInContext('codexLockControls.every((control) => !control.disabled)', context), true);
  assert.equal(vm.runInContext('codexLockFocused', context), true);
  vm.runInContext(`
    globalThis.managedStatus = { textContent: '' };
    globalThis.managedHost = { scrollTop: 0, scrollHeight: 73 };
    globalThis.managedError = {
      textContent: '',
      classList: { add() {}, remove() {} },
    };
    globalThis.managedToggle = { checked: true, disabled: false };
    globalThis.managedWriteControls = [{ disabled: false }, { disabled: false }];
    globalThis.managedShell = {
      isConnected: true,
      dataset: {},
      querySelector(selector) {
        if (selector === '[data-codex-cli-status]') return managedStatus;
        if (selector === '[data-codex-cli-error]') return managedError;
        if (selector === '[data-codex-cli-host]') return managedHost;
        if (selector === '[data-action="codex-cli-toggle-input"]') return managedToggle;
        if (selector === '[data-codex-cli-input-state]') return { textContent: '' };
        return null;
      },
      querySelectorAll() { return managedWriteControls; }
    };
    globalThis.managedWrites = [];
    globalThis.managedScrollToBottomCalls = 0;
    globalThis.managedSockets = [];
    globalThis.WebSocket = class {
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.listeners = new Map();
        managedSockets.push(this);
      }
      addEventListener(name, listener) { this.listeners.set(name, listener); }
      emit(name, event = {}) { this.listeners.get(name)?.(event); }
      close() { this.readyState = 3; this.emit('close'); }
    };
    globalThis.managedView = {
      mode: 'managed',
      managedStream: managedCodexTerminalStream(
        { id: 'live-managed-task', status: 'running' },
        [{ id: 'live-managed-attempt', status: 'running' }],
        []
      ),
      shell: managedShell,
      terminal: {
        options: { disableStdin: true },
        write(value, callback) { managedWrites.push(value); callback?.(); },
        scrollToBottom() { managedScrollToBottomCalls += 1; },
        reset() { managedWrites.length = 0; }
      },
      fixedReplay: true,
      socket: null,
      ended: false,
      inputUnlocked: false,
      reconnectAttempts: 0,
      reconnectTimer: null,
      offset: 0,
      decoder: null,
      outputFormatter: null,
      outputPositioned: false,
    };
    state.codexTerminalView = managedView;
    resetManagedCodexTerminalOutput(managedView);
    setCodexTerminalInputUnlocked(managedView, true);
    connectManagedCodexTerminalSocket(managedView, { id: 'live-managed-task', status: 'running' });
    managedSockets[0].readyState = 1;
    managedSockets[0].emit('open');
    managedSockets[0].emit('message', { data: JSON.stringify({ type: 'ready', offset: 0, status: 'running' }) });
    const managedEvent = '\\x1b[1;94mCodex\\x1b[0m\\r\\nLive managed output.\\r\\n';
    managedSockets[0].emit('message', { data: new TextEncoder().encode(managedEvent).buffer });
    managedSockets[0].emit('message', { data: JSON.stringify({ type: 'end', offset: managedEvent.length, status: 'completed' }) });
  `, context);
  assert.equal(vm.runInContext('managedToggle.disabled', context), true);
  assert.equal(vm.runInContext('managedView.inputUnlocked', context), false);
  assert.equal(vm.runInContext('managedWriteControls.every((control) => control.disabled)', context), true);
  assert.equal(vm.runInContext('managedHost.scrollTop', context), 0);
  assert.equal(vm.runInContext('managedScrollToBottomCalls', context), 1);
  vm.runInContext(`
    managedHost.scrollTop = 11;
    writeManagedCodexTerminalOutput(managedView, 'More live output.\\r\\n');
  `, context);
  assert.equal(vm.runInContext('managedHost.scrollTop', context), 11);
  assert.equal(vm.runInContext('managedScrollToBottomCalls', context), 1);
  assert.equal(
    vm.runInContext('managedSockets[0].url', context),
    `${authenticatedWebSocketOrigin}/api/sessions/live-managed-task/attempts/live-managed-attempt/stdout/live?offset=0`,
  );
  assert.doesNotMatch(vm.runInContext('managedSockets[0].url', context), /codex-terminal\/live/);
  assert.match(vm.runInContext("plainTerminalText(managedWrites.join(''))", context), /Codex\r?\nLive managed output\./);
  assert.equal(vm.runInContext('managedStatus.textContent', context), 'CLI 已结束');
  vm.runInContext('state.codexTerminalView = null; delete globalThis.WebSocket', context);
  vm.runInContext(`
    globalThis.codexReconnectStatus = { textContent: '' };
    globalThis.codexReconnectError = {
      textContent: '',
      classList: { add() {}, remove() {} },
    };
    globalThis.codexReconnectShell = {
      isConnected: true,
      dataset: {},
      querySelector(selector) {
        if (selector === '[data-codex-cli-status]') return codexReconnectStatus;
        if (selector === '[data-codex-cli-error]') return codexReconnectError;
        return null;
      }
    };
    globalThis.codexReconnectSockets = [];
    globalThis.WebSocket = class {
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.listeners = new Map();
        codexReconnectSockets.push(this);
      }
      addEventListener(name, listener) { this.listeners.set(name, listener); }
      emit(name, event = {}) { this.listeners.get(name)?.(event); }
      close() { this.readyState = 3; this.emit('close'); }
    };
    globalThis.codexReconnectView = {
      shell: codexReconnectShell,
      terminal: { cols: 100, rows: 30, write() {} },
      socket: null,
      ended: false,
      reconnectAttempts: 0,
      reconnectTimer: null,
    };
    state.codexTerminalView = codexReconnectView;
    connectCodexTerminalSocket(codexReconnectView, { id: 'reconnect-task' });
    codexReconnectSockets[0].readyState = 1;
    codexReconnectSockets[0].emit('open');
    codexReconnectSockets[0].readyState = 3;
    codexReconnectSockets[0].emit('close');
  `, context);
  assert.equal(vm.runInContext('codexReconnectStatus.textContent', context), '正在连接');
  const codexReconnectTimer = [...timers.entries()].find(([, timer]) => timer.delay === 500);
  assert.ok(codexReconnectTimer);
  timers.delete(codexReconnectTimer[0]);
  codexReconnectTimer[1].callback();
  assert.equal(vm.runInContext('codexReconnectSockets.length', context), 2);
  assert.equal(
    vm.runInContext('codexReconnectSockets[1].url', context),
    `${authenticatedWebSocketOrigin}/api/sessions/reconnect-task/codex-terminal/live?cols=100&rows=30`,
  );
  vm.runInContext(`
    codexReconnectSockets[1].readyState = 1;
    codexReconnectSockets[1].emit('open');
    codexReconnectSockets[1].emit('message', {
      data: JSON.stringify({ type: 'status', state: 'ended' })
    });
    codexReconnectSockets[1].readyState = 3;
    codexReconnectSockets[1].emit('close');
  `, context);
  assert.equal(vm.runInContext('codexReconnectStatus.textContent', context), 'CLI 已结束');
  assert.equal([...timers.values()].some((timer) => timer.delay === 500), false);
  vm.runInContext('state.codexTerminalView = null; delete globalThis.WebSocket', context);
  assert.match(STYLES_SOURCE, /\.terminal-title\s*\{[^}]*border-right:\s*1px solid #313244[^}]*background:\s*#11111b/s);
  assert.match(STYLES_SOURCE, /\.xterm-rows:not\(:has\(\.xterm-cursor\)\) > div:last-child::after/s);
  assert.match(STYLES_SOURCE, /\.task-terminal-list\s*>\s*\.execution-item\s*\{[^}]*border:\s*0/s);
  assert.match(STYLES_SOURCE, /\.command-audit\s*\{[^}]*min-width:\s*0/s);
  assert.match(STYLES_SOURCE, /\.command-audit pre\s*\{[^}]*width:\s*100%[^}]*max-width:\s*100%[^}]*overflow:\s*auto[^}]*white-space:\s*pre-wrap[^}]*overflow-wrap:\s*anywhere[^}]*word-break:\s*break-word/s);
  assert.match(STYLES_SOURCE, /\.execution-head > div\s*\{[^}]*min-width:\s*0[^}]*flex-wrap:\s*wrap/s);
  assert.match(STYLES_SOURCE, /\.execution-head time\s*\{[^}]*flex:\s*0 0 auto/s);
  assert.match(STYLES_SOURCE, /\.toast\s*\{[^}]*box-sizing:\s*border-box[^}]*width:\s*fit-content[^}]*min-width:\s*min\(18rem, calc\(100vw - 3rem\)\)[^}]*max-width:\s*min\(48rem, calc\(100vw - 3rem\)\)/s);
  assert.match(STYLES_SOURCE, /\.toast-message\s*\{[^}]*overflow-wrap:\s*anywhere[^}]*word-break:\s*break-word/s);
  const skillReports = [{
    id: 'skill-report-1', reportKey: 'cloud-recording:curated-3', revision: 1,
    skillId: 'cloud-recording-test', skillVersion: 4, reportType: 'test-result',
    title: 'Cloud recording <result>', status: 'partial',
    summary: 'Three cases: <strong>2 passed</strong> and 1 failed.',
    observedAt: '2026-08-04T12:14:20.000Z', publishedAt: '2026-08-04T12:15:00.000Z',
    primaryExecution: {
      label: 'Cloud recording pytest',
      command: 'python3 -m pytest -v test_cloud.py --ak <AK_FROM_ENV> --sk <SK_FROM_ENV>',
      workingDirectory: '/home/jenkins/premium_robot',
      commandPath: '/home/jenkins/premium_robot/task/cloud.cmd',
      status: 'partial', exitCode: 1,
      startedAt: '2026-08-04T12:11:56.000Z', finishedAt: '2026-08-04T12:14:20.000Z',
    },
    metrics: [
      { key: 'passed', label: 'Passed', value: 2, tone: 'success' },
      { key: 'failed', label: 'Failed', value: 1, tone: 'danger' },
    ],
    artifacts: [{
      id: 'pytest-html-artifact', key: 'normal', kind: 'pytest-html', fileName: 'pytest-result.html',
      bytes: 2048, url: '/api/sessions/report-task/skill-reports/skill-report-1/artifacts/pytest-html-artifact',
    }, {
      id: 'pytest-html-artifact-web', key: 'web', kind: 'pytest-html', fileName: 'pytest-web-result.html',
      bytes: 4096, url: '/api/sessions/report-task/skill-reports/skill-report-1/artifacts/pytest-html-artifact-web',
    }, {
      id: 'failure-analysis-artifact', key: 'analysis', kind: 'failure-analysis-markdown', fileName: 'failure-analysis.md',
      bytes: 1024, url: '/api/sessions/report-task/skill-reports/skill-report-1/artifacts/failure-analysis-artifact',
    }],
    registeredArtifacts: [{
      key: 'normal', kind: 'pytest-html', fileName: 'pytest-result.html', executionStatus: 'running',
    }, {
      key: 'pending', kind: 'pytest-html', fileName: 'pytest-pending.html', executionStatus: 'running',
    }],
    sections: [
      {
        id: 'business-result', title: 'Business result', kind: 'fields', priority: 'primary',
        sensitivity: 'normal', defaultExpanded: true,
        fields: [
          { label: 'Failed case', value: 'test_check_ncs[<mix>]', format: 'code', tone: 'danger' },
          { label: 'Expected / actual', value: 'serviceType=2 / serviceType=1', format: 'code', tone: 'danger' },
        ],
      },
      {
        id: 'current-state', title: 'Current state', kind: 'fields', priority: 'primary',
        sensitivity: 'normal', defaultExpanded: true,
        fields: [{ label: 'Execution', value: 'finished', format: 'status', tone: 'success' }],
      },
      {
        id: 'gw-deployment', title: 'GW deployment', kind: 'table', priority: 'supporting',
        sensitivity: 'internal', defaultExpanded: false,
        columns: [
          { key: 'component', label: 'Component', format: 'text' },
          { key: 'image', label: 'Image', format: 'code' },
        ],
        rows: [{ component: 'worker', image: 'registry/gw-worker:<v1>' }],
      },
      {
        id: 'runtime-evidence', title: 'Runtime evidence', kind: 'fields', priority: 'debug',
        sensitivity: 'internal', defaultExpanded: false,
        fields: [{ label: 'Log', value: '/tmp/<cloud>.log', format: 'code' }],
      },
      {
        id: 'raw-payload', title: 'Raw payload', kind: 'json', priority: 'debug',
        sensitivity: 'normal', defaultExpanded: true, data: { unsafe: '<script>alert(1)</script>' },
      },
      {
        id: 'credentials', title: 'Credential source', kind: 'fields', priority: 'debug',
        sensitivity: 'sensitive', defaultExpanded: true,
        fields: [{ label: 'Source', value: '<private-file>', format: 'text' }],
      },
    ],
  }];
  const skillReportHtml = vm.runInContext(`skillReportList(${JSON.stringify(skillReports)})`, context);
  assert.match(skillReportHtml, /Cloud recording &lt;result&gt;/);
  assert.match(skillReportHtml, /&lt;strong&gt;2 passed&lt;\/strong&gt;/);
  assert.match(skillReportHtml, /test_check_ncs\[&lt;mix&gt;\]/);
  assert.match(skillReportHtml, /registry\/gw-worker:&lt;v1&gt;/);
  assert.match(skillReportHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(skillReportHtml, /<script>|<strong>2 passed<\/strong>/);
  assert.match(skillReportHtml, /priority-primary sensitivity-normal" open>\s*<summary><span>Business result/);
  assert.match(skillReportHtml, /priority-primary sensitivity-normal" open>\s*<summary><span>Current state/);
  assert.match(skillReportHtml, /priority-supporting sensitivity-internal">\s*<summary><span>GW deployment/);
  assert.match(skillReportHtml, /priority-debug sensitivity-internal">\s*<summary><span>Runtime evidence/);
  assert.match(skillReportHtml, /priority-debug sensitivity-normal">\s*<summary><span>Raw payload/);
  assert.match(skillReportHtml, /priority-debug sensitivity-sensitive">\s*<summary><span>Credential source/);
  assert.match(skillReportHtml, /Pytest HTML 报告/);
  assert.match(skillReportHtml, /Fail 分析报告/);
  assert.match(skillReportHtml, /href="\/api\/sessions\/report-task\/skill-reports\/skill-report-1\/artifacts\/pytest-html-artifact" target="_blank" rel="noopener"/);
  assert.match(skillReportHtml, /href="\/api\/sessions\/report-task\/skill-reports\/skill-report-1\/artifacts\/pytest-html-artifact-web" target="_blank" rel="noopener"/);
  assert.match(skillReportHtml, /href="\/api\/sessions\/report-task\/skill-reports\/skill-report-1\/artifacts\/failure-analysis-artifact" target="_blank" rel="noopener"/);
  assert.match(skillReportHtml, /pytest-result\.html/);
  assert.match(skillReportHtml, /pytest-web-result\.html/);
  assert.match(skillReportHtml, /pytest-pending\.html/);
  assert.match(skillReportHtml, /已登记 · 执行中/);
  const visibleSkillReportHtml = skillReportHtml.split('<details class="report-raw">')[0];
  assert.equal((visibleSkillReportHtml.match(/pytest-result\.html/g) || []).length, 1);
  assert.match(skillReportHtml, /failure-analysis\.md/);
  assert.match(skillReportHtml, /2 KiB/);
  assert.match(skillReportHtml, /<details class="report-raw"><summary>/);
  const externallyRegisteredReport = {
    ...skillReports[0],
    artifacts: [],
    registeredArtifacts: [],
    executionEvidence: { externalAttemptId: 'external-running-report' },
  };
  const externallyRegisteredAttempt = {
    id: 'external-running-report',
    status: 'running',
    artifactDeclarations: [
      { key: 'normal', kind: 'pytest-html', path: '/home/jenkins/premium_robot/task/normal.html' },
      { key: 'long', kind: 'pytest-html', path: '/home/jenkins/premium_robot/task/long.html' },
      { key: 'restful', kind: 'pytest-html', path: '/home/jenkins/premium_robot/task/restful.html' },
    ],
  };
  const externallyRegisteredHtml = vm.runInContext(
    `skillReportList(reportsWithRegisteredArtifacts(
      ${JSON.stringify([externallyRegisteredReport])},
      ${JSON.stringify([externallyRegisteredAttempt])}
    ))`,
    context,
  );
  assert.match(externallyRegisteredHtml, /normal\.html/);
  assert.match(externallyRegisteredHtml, /long\.html/);
  assert.match(externallyRegisteredHtml, /restful\.html/);
  assert.equal((externallyRegisteredHtml.match(/已登记 · 执行中/g) || []).length, 3);
  const externallyRegisteredVisibleHtml = externallyRegisteredHtml.split('<details class="report-raw">')[0];
  assert.doesNotMatch(externallyRegisteredVisibleHtml, /\/home\/jenkins\//);
  const externallyRegisteredReports = vm.runInContext(
    `reportsWithRegisteredArtifacts(
      ${JSON.stringify([externallyRegisteredReport])},
      ${JSON.stringify([externallyRegisteredAttempt])}
    )`,
    context,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(externallyRegisteredReports[0].registeredArtifacts)),
    [
      { key: 'normal', kind: 'pytest-html', fileName: 'normal.html', executionStatus: 'running' },
      { key: 'long', kind: 'pytest-html', fileName: 'long.html', executionStatus: 'running' },
      { key: 'restful', kind: 'pytest-html', fileName: 'restful.html', executionStatus: 'running' },
    ],
  );
  const businessExecutionHtml = vm.runInContext(
    `businessExecutionList(${JSON.stringify(skillReports)}, [])`, context,
  );
  assert.match(businessExecutionHtml, /主要执行/);
  assert.match(businessExecutionHtml, /python3 -m pytest -v test_cloud\.py/);
  assert.match(businessExecutionHtml, /cloud-recording-test/);
  assert.match(businessExecutionHtml, /\$<\/span>/);
  const registeredFromAttemptHtml = vm.runInContext(
    `businessReportPage([{
      ...${JSON.stringify(skillReports[0])}, registeredArtifacts: [], artifacts: [],
      executionEvidence: { externalAttemptId: 'external-registered' }
    }], [{
      id: 'external-registered', status: 'running', command: 'pytest registered.py',
      artifactDeclarations: [{
        key: 'normal', kind: 'pytest-html', path: '/private/work/reports/registered.html'
      }]
    }])`, context,
  );
  assert.match(registeredFromAttemptHtml, /registered\.html/);
  assert.match(registeredFromAttemptHtml, /已登记 · 执行中/);
  const registeredFromAttemptVisibleHtml = registeredFromAttemptHtml.split('<details class="report-raw">')[0];
  assert.doesNotMatch(registeredFromAttemptVisibleHtml, /\/private\/work/);
  const deduplicatedBusinessExecutionHtml = vm.runInContext(
    `businessExecutionList(${JSON.stringify(skillReports)}, [{
      id: 'external-same-command', label: 'Detached pytest', status: 'failed',
      command: ${JSON.stringify(skillReports[0].primaryExecution.command)},
      commandPath: ${JSON.stringify(skillReports[0].primaryExecution.commandPath)},
      result: { exitCode: 1 }
    }])`, context,
  );
  assert.equal((deduplicatedBusinessExecutionHtml.match(/class="business-execution"/g) || []).length, 1);
  assert.match(deduplicatedBusinessExecutionHtml, /cloud-recording-test/);

  const summaryReports = [
    ...skillReports,
    {
      id: 'gw-report', reportKey: 'gw:release-20260804', revision: 1,
      skillId: 'cloud-recording-gw-deploy', reportType: 'deployment-result',
      title: 'Cloud recording GW deployment', status: 'succeeded',
      summary: 'GW release-20260804 deployed and verified.',
      observedAt: '2026-08-04T12:10:47.000Z', publishedAt: '2026-08-04T12:10:50.000Z',
      metrics: [], sections: [],
    },
    {
      id: 'analysis-report', reportKey: 'analysis:first-run', revision: 1,
      skillId: 'analyze-failures', reportType: 'failure-analysis',
      title: 'Failure analysis', status: 'succeeded', summary: 'product_bug_candidate',
      observedAt: '2026-08-04T12:20:14.000Z', publishedAt: '2026-08-04T12:20:15.000Z',
      metrics: [], sections: [],
    },
    {
      id: 'rerun-report', reportKey: 'cloud-recording:rerun-1', revision: 1,
      skillId: 'cloud-recording-test', reportType: 'test-result',
      title: 'Cloud recording rerun', status: 'succeeded', summary: '3 passed.',
      observedAt: '2026-08-04T12:26:08.000Z', publishedAt: '2026-08-04T12:26:09.000Z',
      primaryExecution: {
        label: 'Cloud recording pytest rerun', command: 'python3 -m pytest -v test_cloud.py::test_failed',
        status: 'succeeded', exitCode: 0, startedAt: '2026-08-04T12:23:42.000Z',
        finishedAt: '2026-08-04T12:26:08.000Z',
      },
      metrics: [{ key: 'passed', label: 'Passed', value: 3, tone: 'success' }], sections: [],
    },
  ];
  const summaryHtml = vm.runInContext(`businessSummaryTimeline(
    ${JSON.stringify({
      id: 'summary-task', name: 'Cloud recording test request', objective: 'Run regression',
      notes: '提测文档：https://example.atlassian.net/wiki/spaces/QA/pages/123456',
      status: 'waiting_review', createdAt: '2026-08-04T12:00:03.000Z',
  })},
    ${JSON.stringify(summaryReports)},
    [],
    ${JSON.stringify([{
    id: 'scheduled-1', externalAttemptId: '', status: 'completed',
    createdAt: '2026-08-04T12:15:09.000Z', dueAt: '2026-08-04T12:25:00.000Z',
  }])},
    ${JSON.stringify([{
    id: 'cicd-execution', command: 'deploy-cicd --build 1842', status: 'completed', exitCode: 0,
    startedAt: '2026-08-04T12:07:00.000Z', finishedAt: '2026-08-04T12:08:21.000Z',
    skills: [{ skillId: 'cloud-recording-cicd-deploy' }],
  }])}
  )`, context);
  assert.match(summaryHtml, /收到提测报告/);
  assert.match(summaryHtml, /执行测试/);
  assert.match(summaryHtml, /CI\/CD 部署/);
  assert.match(summaryHtml, /GW 部署/);
  assert.match(summaryHtml, /首轮回归/);
  assert.match(summaryHtml, /Rerun #1/);
  assert.match(summaryHtml, /预约回查/);
  assert.match(summaryHtml, /Fail 分析完成/);
  assert.match(summaryHtml, /最终结果/);
  assert.match(summaryHtml, /python3 -m pytest -v test_cloud\.py --ak &lt;AK_FROM_ENV&gt;/);
  assert.match(summaryHtml, /pytest-result\.html/);
  assert.match(summaryHtml, /python3 -m pytest -v test_cloud\.py::test_failed/);
  assert.match(summaryHtml, /cloud-recording-test/);
  assert.match(summaryHtml, /analyze-failures/);
  assert.match(summaryHtml, /12:00:03/);
  assert.match(summaryHtml, /12:25:00/);
  assert.doesNotMatch(summaryHtml, /deploy-cicd --build 1842/);
  assert.ok(summaryHtml.indexOf('首轮回归') < summaryHtml.indexOf('Rerun #1'));
  assert.ok(summaryHtml.indexOf('Rerun #1') < summaryHtml.lastIndexOf('最终结果'));

  const generalTaskReport = {
    id: 'implementation-report', reportKey: 'implementation:summary', revision: 1,
    skillId: 'clean-code', reportType: 'implementation-result',
    title: '管理后台优化完成', status: 'succeeded', summary: '通用任务摘要已经实现。',
    observedAt: '2026-08-04T13:20:00.000Z', publishedAt: '2026-08-04T13:20:01.000Z',
    primaryExecution: {
      label: '前端检查', command: 'npm run check', status: 'succeeded', exitCode: 0,
      startedAt: '2026-08-04T13:18:00.000Z', finishedAt: '2026-08-04T13:19:00.000Z',
    },
    metrics: [], sections: [],
  };
  const generalTaskHtml = vm.runInContext(`businessSummaryTimeline(
    ${JSON.stringify({
    id: 'general-task', name: '优化管理后台', objective: '扩展平台以支持任意 Codex 任务。',
    status: 'waiting_review', summary: '实现完成并通过检查。',
    createdAt: '2026-08-04T13:00:00.000Z', lastFinishedAt: '2026-08-04T13:21:00.000Z',
  })},
    ${JSON.stringify([generalTaskReport])},
    ${JSON.stringify([{
    id: 'build-attempt', label: '构建静态资源', command: 'npm run build',
    status: 'succeeded', result: { exitCode: 0, summary: '构建完成' },
    sourceCommandExecutionId: 'build-execution',
    startedAt: '2026-08-04T13:10:00.000Z', finishedAt: '2026-08-04T13:12:00.000Z',
  }])},
    [],
    ${JSON.stringify([{
    id: 'build-execution', command: 'npm run build', status: 'completed', exitCode: 0,
    skills: [{ skillId: 'clean-code' }],
  }])}
  )`, context);
  assert.match(generalTaskHtml, /general-task-summary/);
  assert.match(generalTaskHtml, /当前状态/);
  assert.match(generalTaskHtml, /待确认/);
  assert.match(generalTaskHtml, /主要执行/);
  assert.match(generalTaskHtml, /任务轨迹/);
  assert.match(generalTaskHtml, /任务已创建/);
  assert.match(generalTaskHtml, /管理后台优化完成/);
  assert.match(generalTaskHtml, /构建静态资源/);
  assert.match(generalTaskHtml, /clean-code/);
  assert.match(generalTaskHtml, /实现完成并通过检查。/);
  assert.doesNotMatch(generalTaskHtml, /pytest 回归命令|等待业务测试结果|首轮回归/);
  const documentRuleOnly = vm.runInContext(`testRequestDocumentEvent(${JSON.stringify({
    id: 'document-rule-only', name: 'Timeline behavior',
    objective: '只有给了 Confluence 或其他形式的提测文档才算收到提测报告。',
    createdAt: '2026-08-04T12:00:03.000Z',
  })}, [])`, context);
  assert.equal(documentRuleOnly, null);

  const helperExecution = {
    id: 'worklog-helper', status: 'completed', exitCode: 0,
    command: '/bin/bash -lc "codex-skill-use agent-worklog cloud-recording-test -- python3 append_task_event.py --command \'python3 -m pytest -v test_cloud.py\'"',
    skills: [{ skillId: 'agent-worklog' }, { skillId: 'cloud-recording-test' }],
  };
  const helperOnlyRuns = vm.runInContext(
    `businessTestRuns([], [], ${JSON.stringify([helperExecution])})`, context,
  );
  assert.equal(helperOnlyRuns.length, 0);
  const directPytestExecution = {
    id: 'direct-pytest', status: 'completed', exitCode: 0,
    command: '/bin/bash -lc "codex-skill-use cloud-recording-test -- python3 -m pytest -v test_cloud.py"',
    skills: [{ skillId: 'cloud-recording-test' }],
  };
  const directPytestRuns = vm.runInContext(
    `businessTestRuns([], [], ${JSON.stringify([directPytestExecution])})`, context,
  );
  assert.equal(directPytestRuns.length, 1);

  const explicitSteps = [{
    id: 'step-normal', key: 'normal', label: 'Normal group', ordinal: 1,
    runs: [{
      id: 'run-normal-initial', runKey: 'initial', runKind: 'initial', runNumber: 0,
      status: 'failed', startedAt: '2026-08-04T12:00:00.000Z', finishedAt: '2026-08-04T12:10:00.000Z',
    }, {
      id: 'run-normal-rerun-1', runKey: 'rerun-1', runKind: 'rerun', runNumber: 1,
      status: 'succeeded', startedAt: '2026-08-04T12:20:00.000Z', finishedAt: '2026-08-04T12:22:00.000Z',
    }],
  }, {
    id: 'step-long', key: 'long', label: 'Long group', ordinal: 2,
    runs: [{
      id: 'run-long-initial', runKey: 'initial', runKind: 'initial', runNumber: 0,
      status: 'succeeded', startedAt: '2026-08-04T12:30:00.000Z', finishedAt: '2026-08-04T12:40:00.000Z',
    }],
  }];
  const explicitAttempts = [{
    id: 'normal-initial-attempt', stepRunId: 'run-normal-initial',
    command: 'python3 -m pytest normal', status: 'failed', result: { exitCode: 1 },
    createdAt: '2026-08-04T12:00:00.000Z',
  }, {
    id: 'normal-rerun-attempt-1', stepRunId: 'run-normal-rerun-1',
    command: 'python3 -m pytest normal::failed', status: 'lost', result: {},
    createdAt: '2026-08-04T12:20:00.000Z',
  }, {
    id: 'normal-rerun-technical-retry', stepRunId: 'run-normal-rerun-1',
    command: 'python3 -m pytest normal::failed', status: 'succeeded', result: { exitCode: 0 },
    createdAt: '2026-08-04T12:21:00.000Z',
  }, {
    id: 'long-initial-attempt', stepRunId: 'run-long-initial',
    command: 'python3 -m pytest long', status: 'succeeded', result: { exitCode: 0 },
    createdAt: '2026-08-04T12:30:00.000Z',
  }];
  const explicitRuns = vm.runInContext(
    `businessTestRuns([], ${JSON.stringify(explicitAttempts)}, [], ${JSON.stringify(explicitSteps)})`,
    context,
  );
  assert.equal(explicitRuns.length, 3);
  assert.equal(explicitRuns[1].attemptGenerations, 2);
  assert.deepEqual(Array.from(vm.runInContext(
    `[${explicitRuns.map((run, index) => `businessRegressionTitle(${JSON.stringify(run)}, ${index})`).join(',')}]`,
    context,
  )), ['Normal group · 首轮回归', 'Normal group · Rerun #1', 'Long group · 首轮回归']);
  assert.doesNotMatch(vm.runInContext(
    `businessRegressionTitle(${JSON.stringify(explicitRuns[2])}, 2)`, context,
  ), /Rerun/);

  const reportOnlyTestResult = {
    id: 'report-only-result', reportKey: 'cloud-recording:report-only', revision: 1,
    skillId: 'cloud-recording-test', reportType: 'test-result', status: 'partial',
    title: 'Cloud recording curated three-case result',
    summary: 'Three cases completed: 2 passed and 1 failed.',
    observedAt: '2026-08-04T12:14:20.000Z', publishedAt: '2026-08-04T12:15:00.000Z',
    metrics: [
      { key: 'passed', label: 'Passed', value: 2, tone: 'success' },
      { key: 'failed', label: 'Failed', value: 1, tone: 'danger' },
    ],
    sections: [{
      id: 'current-state', title: 'Current state', kind: 'fields',
      fields: [
        { label: 'Exit code', value: '1' },
        { label: 'Started', value: '2026-08-04T12:11:56.000Z' },
        { label: 'Finished', value: '2026-08-04T12:14:20.000Z' },
      ],
    }, {
      id: 'runtime-evidence', title: 'Commands and runtime evidence', kind: 'fields',
      fields: [{ label: 'Command', value: 'Not embedded; retained in the command snapshot.' }],
    }, {
      id: 'failure', title: 'Expected versus actual failure', kind: 'fields',
      fields: [{ label: 'Classification', value: 'product_bug_candidate' }],
    }],
  };
  const reportOnlyRuns = vm.runInContext(
    `businessTestRuns(${JSON.stringify([reportOnlyTestResult])}, [], [])`, context,
  );
  assert.equal(reportOnlyRuns.length, 1);
  assert.equal(reportOnlyRuns[0].startedAt, '2026-08-04T12:11:56.000Z');
  assert.equal(reportOnlyRuns[0].finishedAt, '2026-08-04T12:14:20.000Z');
  assert.equal(reportOnlyRuns[0].command, 'Not embedded; retained in the command snapshot.');
  assert.equal(reportOnlyRuns[0].exitCode, 1);
  assert.equal(reportOnlyRuns[0].status, 'partial');
  const reportOnlySummaryHtml = vm.runInContext(`businessSummaryTimeline(
    ${JSON.stringify({
    id: 'report-only-task', name: 'Cloud recording curated result report',
    status: 'waiting_review', createdAt: '2026-08-04T12:00:00.000Z',
    lastFinishedAt: '2026-08-04T12:16:00.000Z',
  })}, ${JSON.stringify([reportOnlyTestResult])}, [], [], [])`, context);
  assert.match(reportOnlySummaryHtml, /最终结果/);
  assert.doesNotMatch(reportOnlySummaryHtml, /收到提测报告/);
  assert.match(reportOnlySummaryHtml, /执行测试/);
  assert.match(reportOnlySummaryHtml, /首轮回归/);
  assert.ok(reportOnlySummaryHtml.indexOf('执行测试') < reportOnlySummaryHtml.indexOf('首轮完成'));
  assert.match(reportOnlySummaryHtml, /Passed: 2 · Failed: 1/);
  assert.match(reportOnlySummaryHtml, /Not embedded; retained in the command snapshot\./);
  assert.equal((reportOnlySummaryHtml.match(/class="business-regression /g) || []).length, 1);

  const restoredReportCommand = {
    ...reportOnlyTestResult,
    id: 'report-only-result-revision-2',
    revision: 2,
    publishedAt: '2026-08-05T08:00:00.000Z',
    primaryExecution: {
      command: 'python3 -m pytest -v test_cloud.py',
      commandPath: '/tmp/report-only-result.cmd',
      workingDirectory: '/tmp',
      status: 'failed',
      exitCode: 1,
      startedAt: '2026-08-04T12:11:56.000Z',
      finishedAt: '2026-08-04T12:14:20.000Z',
    },
  };
  const revisedReportRuns = vm.runInContext(
    `businessTestRuns(${JSON.stringify([reportOnlyTestResult, restoredReportCommand])}, [], [])`,
    context,
  );
  assert.equal(revisedReportRuns.length, 1);
  assert.equal(revisedReportRuns[0].report.id, restoredReportCommand.id);
  assert.equal(revisedReportRuns[0].command, restoredReportCommand.primaryExecution.command);

  const historicalFollowUpReports = [
    reportOnlyTestResult,
    {
      ...restoredReportCommand,
      sections: [...restoredReportCommand.sections, {
        id: 'scheduled-follow-up', title: 'Scheduled follow-up', kind: 'json',
        data: {
          createdAt: '2026-08-04T15:46:23.000Z',
          dueAt: '2026-08-04T15:51:23.000Z',
          label: 'cloud_recording_curated3_20260804_154621_484265794',
        },
      }],
    },
    {
      id: 'historical-rerun', reportKey: 'cloud-recording:historical-rerun', revision: 1,
      skillId: 'cloud-recording-test', reportType: 'test-result', status: 'failed',
      summary: 'Passed: 0 - Failed: 1', observedAt: '2026-08-04T15:58:19.000Z',
      publishedAt: '2026-08-05T08:01:00.000Z', metrics: [],
      primaryExecution: {
        command: 'python3 -m pytest -v test_cloud.py::test_failed', status: 'failed', exitCode: 1,
        startedAt: '2026-08-04T15:57:39.000Z', finishedAt: '2026-08-04T15:58:19.000Z',
      },
      sections: [{
        id: 'scheduled-follow-up', title: 'Scheduled follow-up', kind: 'json',
        data: {
          createdAt: '2026-08-04T15:57:41.920Z',
          dueAt: '2026-08-04T16:02:41.920Z',
          label: 'cloud_recording_curated3_rerun_20260804_155739_703449334',
        },
      }],
    },
  ];
  const historicalFollowUpHtml = vm.runInContext(`businessSummaryTimeline(
    ${JSON.stringify({
    id: 'historical-follow-up-task', name: 'Historical follow-up task',
    status: 'waiting_review', createdAt: '2026-08-04T15:41:15.000Z',
  })}, ${JSON.stringify(historicalFollowUpReports)}, [], [], [])`, context);
  assert.equal((historicalFollowUpHtml.match(/class="business-regression /g) || []).length, 2);
  assert.doesNotMatch(historicalFollowUpHtml, /收到提测报告/);
  assert.equal((historicalFollowUpHtml.match(/执行测试/g) || []).length, 2);
  assert.ok(historicalFollowUpHtml.indexOf('执行测试') < historicalFollowUpHtml.indexOf('预约回查'));
  assert.match(historicalFollowUpHtml, /Rerun #1/);
  assert.doesNotMatch(historicalFollowUpHtml, /Rerun #2/);
  assert.equal((historicalFollowUpHtml.match(/预约回查/g) || []).length, 2);
  assert.match(historicalFollowUpHtml, /cloud_recording_curated3_20260804_154621_484265794/);
  assert.match(historicalFollowUpHtml, /cloud_recording_curated3_rerun_20260804_155739_703449334/);
  assert.match(historicalFollowUpHtml, /15:51:23/);
  assert.match(historicalFollowUpHtml, /16:02:41/);

  const collapsedFollowUpsHtml = vm.runInContext(`businessTimelineHtml(${JSON.stringify([
    { kind: 'scheduled-follow-up', at: '2026-08-04T16:00:00.000Z', targetAt: '2026-08-04T16:05:00.000Z', title: '预约回查', detail: 'first', tone: 'info' },
    { kind: 'scheduled-follow-up', at: '2026-08-04T16:00:01.000Z', targetAt: '2026-08-04T16:06:00.000Z', title: '预约回查', detail: 'second', tone: 'info' },
    { at: '2026-08-04T16:01:00.000Z', title: '首轮完成', detail: 'done', tone: 'success' },
  ])})`, context);
  assert.match(collapsedFollowUpsHtml, /class="business-followup-group"/);
  assert.match(collapsedFollowUpsHtml, /<summary><span>预约回查<\/span><strong>2<\/strong><\/summary>/);
  assert.match(collapsedFollowUpsHtml, /first/);
  assert.match(collapsedFollowUpsHtml, /second/);

  const analysisExecution = {
    id: 'analysis-command', status: 'completed', exitCode: 0,
    startedAt: '2026-08-04T12:20:14.000Z', finishedAt: '2026-08-04T12:20:15.000Z',
    command: '/bin/bash -lc "codex-skill-use analyze-failures -- python3 -c \'print(1)\'"',
    skills: [{ skillId: 'analyze-failures' }],
  };
  const analysisReportPublisher = {
    id: 'analysis-report-publisher', status: 'completed', exitCode: 0,
    startedAt: '2026-08-04T12:24:00.000Z', finishedAt: '2026-08-04T12:24:01.000Z',
    command: '/bin/bash -lc "codex-skill-use analyze-failures -- codex-skill-report publish --file result.json"',
    skills: [{ skillId: 'analyze-failures' }],
  };
  assert.equal(vm.runInContext(
    `isFailureAnalysisExecution(${JSON.stringify(analysisExecution)})`, context,
  ), true);
  assert.equal(vm.runInContext(
    `isFailureAnalysisExecution(${JSON.stringify(analysisReportPublisher)})`, context,
  ), false);
  const embeddedFailureReport = {
    skillId: 'cloud-recording-test', reportType: 'test-result', summary: '2 passed, 1 failed',
    sections: [{
      id: 'failure', title: 'Failure analysis',
      fields: [{ label: 'Classification', value: 'product_bug_candidate' }],
    }],
  };
  assert.equal(vm.runInContext(
    `isFailureAnalysisReport(${JSON.stringify(embeddedFailureReport)})`, context,
  ), true);
  assert.equal(vm.runInContext(
    `failureAnalysisSummary(${JSON.stringify(embeddedFailureReport)})`, context,
  ), 'product_bug_candidate');
  assert.equal(vm.runInContext(`isFailureAnalysisReport(${JSON.stringify({
    skillId: 'cloud-recording-test', reportType: 'test-result',
    sections: [{ id: 'failure', title: 'Expected versus actual', fields: [] }],
  })})`, context), false);

  const stagePriorityHtml = vm.runInContext(`businessSummaryTimeline(
    ${JSON.stringify({
    id: 'stage-priority', name: 'Stage priority', status: 'running',
    createdAt: '2026-08-04T12:00:03.000Z',
  })},
    ${JSON.stringify([{
    id: 'initial-report', reportKey: 'test:initial', revision: 1,
    skillId: 'cloud-recording-test', reportType: 'test-result', status: 'partial',
    summary: '2 passed, 1 failed', publishedAt: '2026-08-04T12:20:00.000Z',
    primaryExecution: {
      command: 'python3 -m pytest -v test_cloud.py', status: 'partial', exitCode: 1,
      startedAt: '2026-08-04T12:10:00.000Z', finishedAt: '2026-08-04T12:19:00.000Z',
    }, metrics: [], sections: [],
  }, {
    id: 'rerun-running-report', reportKey: 'test:rerun', revision: 1,
    skillId: 'cloud-recording-test', reportType: 'test-result', status: 'running',
    summary: 'Rerun launched', publishedAt: '2026-08-04T12:23:43.000Z',
    primaryExecution: {
      command: 'python3 -m pytest -v test_cloud.py::test_failed', status: 'running',
      startedAt: '2026-08-04T12:23:42.000Z', finishedAt: '',
    }, metrics: [], sections: [],
  }])},
    [], [],
    ${JSON.stringify([analysisExecution, analysisReportPublisher])}
  )`, context);
  assert.match(stagePriorityHtml, /<h3>Rerun #1<\/h3>/);
  assert.equal((stagePriorityHtml.match(/class="business-regression-command"/g) || []).length, 2);
  assert.equal((stagePriorityHtml.match(/Fail 分析/g) || []).length, 1);

  const staleRunningReport = {
    id: 'stale-running-report', reportKey: 'test:stale', revision: 1,
    skillId: 'cloud-recording-test', reportType: 'test-result', status: 'running',
    summary: 'Still running', publishedAt: '2026-08-04T12:10:01.000Z',
    primaryExecution: {
      command: 'python3 -m pytest -v stale.py', status: 'running', exitCode: null,
      startedAt: '2026-08-04T12:10:00.000Z', finishedAt: '',
    }, metrics: [{ key: 'started', label: 'Started', value: 1 }], sections: [],
  };
  const terminalExternalAttempt = {
    id: 'terminal-external', status: 'failed', command: 'python3 -m pytest -v stale.py',
    startedAt: '2026-08-04T12:10:00.000Z', finishedAt: '2026-08-04T12:11:00.000Z',
    result: { exitCode: 1, summary: '1 failed' },
  };
  const refreshedRun = vm.runInContext(
    `businessTestRuns(${JSON.stringify([staleRunningReport])}, ${JSON.stringify([terminalExternalAttempt])}, [])`,
    context,
  );
  assert.equal(refreshedRun[0].status, 'failed');
  assert.equal(refreshedRun[0].finishedAt, terminalExternalAttempt.finishedAt);
  assert.equal(vm.runInContext(`testRunSummary(${JSON.stringify(refreshedRun[0])})`, context), '1 failed');

  const finalReport = {
    id: 'final-report', reportKey: 'test:duplicate-tracker', revision: 2,
    skillId: 'cloud-recording-test', reportType: 'test-result', status: 'failed',
    summary: 'Passed: 0, Failed: 1', publishedAt: '2026-08-06T03:06:23.000Z',
    primaryExecution: {
      label: 'Cloud recording pytest', command: 'python3 -m pytest -v duplicate.py',
      commandPath: '/tmp/duplicate.cmd', status: 'failed', exitCode: 1,
      startedAt: '2026-08-06T02:52:48.000Z', finishedAt: '2026-08-06T02:52:51.000Z',
    },
    metrics: [{ key: 'failed', label: 'Failed', value: 1 }], sections: [],
  };
  const validAttempt = {
    id: 'valid-attempt', chainKey: 'same-chain', generation: 1, pid: 2560102,
    command: 'python3 -m pytest -v duplicate.py', commandPath: '/tmp/duplicate.cmd',
    logPath: '/tmp/duplicate.log', donePath: '/tmp/duplicate.done',
    statePath: '/tmp/duplicate.state', metaPath: '/tmp/duplicate.meta',
    status: 'failed', startedAt: '2026-08-06T02:49:05.000Z',
    finishedAt: '2026-08-06T02:56:52.000Z',
    result: { exitCode: 1, meta: { started_at: '2026-08-06T02:52:48.000Z' } },
  };
  const duplicateLostAttempt = {
    ...validAttempt,
    id: 'duplicate-lost-attempt', generation: 2, status: 'lost',
    startedAt: '2026-08-06T02:56:52.000Z', finishedAt: '2026-08-06T03:07:14.000Z',
    result: { exitCode: null, ignoredStaleArtifacts: ['done', 'state', 'meta'] },
  };
  const deduplicatedRuns = vm.runInContext(
    `businessTestRuns(${JSON.stringify([finalReport])}, ${JSON.stringify([duplicateLostAttempt, validAttempt])}, [])`,
    context,
  );
  assert.equal(deduplicatedRuns.length, 1);
  assert.equal(deduplicatedRuns[0].status, 'failed');
  assert.equal(deduplicatedRuns[0].exitCode, 1);
  assert.equal(deduplicatedRuns[0].report.id, finalReport.id);
  const preferredExecution = vm.runInContext(
    `businessExecutionEntries(${JSON.stringify([finalReport])}, ${JSON.stringify([duplicateLostAttempt, validAttempt])})`,
    context,
  );
  assert.equal(preferredExecution.length, 1);
  assert.equal(preferredExecution[0].status, 'failed');
  assert.equal(preferredExecution[0].exitCode, 1);
  assert.equal(preferredExecution[0].evidenceSource, 'report');
  assert.match(APP_SOURCE, /\['business-summary', 'business-reports'\]\.includes\(state\.detailTab\)/);

  vm.runInContext(`state.dashboard.sessions.push({
    id: 'summary-task', name: 'Summary Task', objective: 'Render business timeline first',
    workingDir: '.', enabled: true, status: 'waiting_review', createdAt: '2026-08-04T12:00:03.000Z'
  }); state.currentTaskId = 'summary-task'; state.detailTab = 'business-summary';`, context);
  responseOverrides.set('GET /api/sessions/summary-task/external-attempts', { payload: [] });
  responseOverrides.set('GET /api/sessions/summary-task/scheduled-jobs', { payload: [] });
  responseOverrides.set('GET /api/sessions/summary-task/skill-reports', { payload: summaryReports });
  responseOverrides.set('GET /api/sessions/summary-task/executions', { payload: [] });
  await vm.runInContext('loadTaskConsole({ showLoading: false })', context);
  assert.match(element('#taskConsoleOutput').innerHTML, /class="business-summary"/);
  assert.ok(requests.some((url) => url.includes('/api/sessions/summary-task/skill-reports?limit=500&offset=0&history=1')));

  responseOverrides.set('GET /api/sessions/summary-task/worklogs', { payload: [{
    id: 'combined-worklog', kind: 'session.turn.result', turnId: 'turn-combined',
    ts: '2026-08-04T12:30:00.000Z', message: 'Combined Agent record result',
  }] });
  responseOverrides.set('GET /api/sessions/summary-task/executions', { payload: [{
    id: 'combined-command', runtimeItemId: 'item-combined', turnId: 'turn-combined',
    attemptId: 'attempt-combined', turnSequence: 1, turnInput: 'Combined record request', attemptNo: 1,
    command: 'python3 -m pytest -v combined_record.py', output: '1 passed', exitCode: 0,
    status: 'completed', finishedAt: '2026-08-04T12:29:00.000Z', rawEvent: { type: 'item.completed' },
  }] });
  vm.runInContext("state.detailTab = 'agent-records'; renderCache.delete('taskConsole')", context);
  await vm.runInContext('loadTaskConsole({ showLoading: false })', context);
  const combinedAgentRecordsHtml = element('#taskConsoleOutput').innerHTML;
  assert.match(combinedAgentRecordsHtml, /Combined Agent record result/);
  assert.match(combinedAgentRecordsHtml, /python3 -m pytest -v combined_record\.py/);
  assert.ok(requests.some((url) => url.startsWith('/api/sessions/summary-task/worklogs?')));
  assert.ok(requests.some((url) => url.startsWith('/api/sessions/summary-task/executions?')));

  vm.runInContext(`state.dashboard.sessions.push({
    id: 'report-console-task', name: 'Report Console Task', objective: 'Render report first',
    workingDir: '.', enabled: true, status: 'waiting_review', createdAt: '2026-08-04T12:00:00.000Z'
  }); state.currentTaskId = 'report-console-task'; state.detailTab = 'business-reports';`, context);
  responseOverrides.set('GET /api/sessions/report-console-task/external-attempts', { payload: [] });
  responseOverrides.set('GET /api/sessions/report-console-task/skill-reports', { payload: skillReports });
  await vm.runInContext('loadTaskConsole({ showLoading: false })', context);
  const businessReportPageHtml = element('#taskConsoleOutput').innerHTML;
  assert.ok(requests.some((url) => url.startsWith('/api/sessions/report-console-task/skill-reports?')));
  assert.match(businessReportPageHtml, /Business result/);
  assert.match(businessReportPageHtml, /主要执行/);
  assert.ok(businessReportPageHtml.indexOf('business-executions')
    < businessReportPageHtml.indexOf('business-reports'));
  assert.doesNotMatch(businessReportPageHtml, /任务终端正在等待输出/);

  responseOverrides.set('GET /api/sessions/report-console-task/skill-reports', {
    status: 404, payload: { error: 'Not found' },
  });
  vm.runInContext("state.detailTab = 'business-reports'; renderCache.delete('taskConsole')", context);
  await vm.runInContext('loadTaskConsole({ showLoading: false })', context);
  const legacyBusinessReportHtml = element('#taskConsoleOutput').innerHTML;
  assert.match(legacyBusinessReportHtml, /暂无结构化报告或主要执行记录/);
  assert.doesNotMatch(legacyBusinessReportHtml, /Not found|任务终端正在等待输出/);
  assert.match(APP_SOURCE, /loadOptionalSkillReports[\s\S]*acceptedStatuses:\s*\[404\]/);
  assert.match(APP_SOURCE, /ATTEMPT_OUTPUT_POLL_INTERVAL_MS\s*=\s*750/);
  assert.match(APP_SOURCE, /decoder\.decode\(chunk\.bytes,\s*\{\s*stream:\s*true\s*\}\)/);
  assert.match(APP_SOURCE, /function pumpAttemptTerminalPrint[\s\S]*terminal\.write\(chunk[\s\S]*terminal\.scrollToBottom\(\)/);
  assert.match(APP_SOURCE, /await waitForAttemptTerminalIdle\(viewer\)[\s\S]*updateAttemptOutputStatus\(viewer/);
  assert.ok(fs.statSync(path.resolve(__dirname, '../public/vendor/xterm/xterm.js')).size > 100000);
  assert.ok(fs.statSync(path.resolve(__dirname, '../public/vendor/xterm/xterm.css')).size > 1000);
  assert.ok(fs.statSync(path.resolve(__dirname, '../public/vendor/xterm/addon-fit.js')).size > 1000);
  const largeAttemptOutputHtml = vm.runInContext(`attemptList([{
    id: 'attempt-large', turnId: 'turn-large', turnSequence: 1, attemptNo: 1,
    status: 'completed', stdoutAvailable: true, stdoutBytes: (5 * 1024 * 1024) + 1
  }])`, context);
  assert.match(largeAttemptOutputHtml, /attempt-large\/stdout/);
  assert.match(largeAttemptOutputHtml, /打开完整原始输出/);
  assert.doesNotMatch(largeAttemptOutputHtml, /data-action="view-attempt-output"/);
  assert.match(APP_SOURCE, /INLINE_ATTEMPT_OUTPUT_MAX_BYTES\s*=\s*5\s*\*\s*1024\s*\*\s*1024/);
  assert.match(APP_SOURCE, /CODEX_CLI_DISPLAY_MAX_BYTES\s*=\s*64\s*\*\s*1024\s*\*\s*1024/);
  assert.match(APP_SOURCE, /CODEX_CLI_SCROLLBACK_LINES\s*=\s*100000/);
  assert.match(APP_SOURCE, /abortAttemptOutputLoad\(\)[\s\S]*active\.controller\.abort\(\)/);
  responseOverrides.set('GET /api/sessions/inline-task/attempts/attempt-inline/stdout', { payload: 'raw session line\n' });
  vm.runInContext(`
    state.currentTaskId = 'inline-task';
    function outputClassList(initial = []) {
      const values = new Set(initial);
      return {
        add: (value) => values.add(value),
        remove: (value) => values.delete(value),
        contains: (value) => values.has(value)
      };
    }
    globalThis.testOutputPre = { textContent: '', classList: outputClassList(), scrollHeight: 0, scrollTop: 0 };
    globalThis.testOutputStatus = { textContent: '', classList: outputClassList() };
    globalThis.testOutputViewer = {
      classList: outputClassList(['hidden']), dataset: {}, isConnected: true,
      querySelector(selector) {
        if (selector === '[data-attempt-live-status]') return testOutputStatus;
        if (selector === '[data-terminal-fallback]' || selector === 'pre') return testOutputPre;
        return null;
      }
    };
    globalThis.testOutputButton = {
      dataset: { id: 'attempt-inline', stream: 'stdout', viewLabel: '直接查看', hideLabel: '收起输出' },
      textContent: '直接查看', attributes: {},
      closest: () => ({ querySelector: () => testOutputViewer }),
      setAttribute(name, value) { this.attributes[name] = String(value); }
    };
  `, context);
  await vm.runInContext('toggleAttemptOutput(testOutputButton)', context);
  assert.ok(requests.some((url) => url.startsWith('/api/sessions/inline-task/attempts/attempt-inline/stdout?offset=0&limit=')));
  assert.equal(vm.runInContext('testOutputPre.textContent', context), 'raw session line\n');
  assert.equal(vm.runInContext('testOutputViewer.dataset.loaded', context), 'true');
  assert.equal(vm.runInContext("testOutputButton.attributes['aria-expanded']", context), 'true');
  await vm.runInContext('toggleAttemptOutput(testOutputButton)', context);
  assert.equal(vm.runInContext("testOutputViewer.classList.contains('hidden')", context), true);

  requestHangPath = '/api/sessions/inline-task/attempts/attempt-hang/stdout';
  vm.runInContext(`
    globalThis.hangingOutputPre = { textContent: '', classList: outputClassList(), scrollHeight: 0, scrollTop: 0 };
    globalThis.hangingOutputStatus = { textContent: '', classList: outputClassList() };
    globalThis.hangingOutputViewer = {
      classList: outputClassList(['hidden']), dataset: {}, isConnected: true,
      querySelector(selector) {
        if (selector === '[data-attempt-live-status]') return hangingOutputStatus;
        if (selector === '[data-terminal-fallback]' || selector === 'pre') return hangingOutputPre;
        return null;
      }
    };
    globalThis.hangingOutputButton = {
      dataset: { id: 'attempt-hang', stream: 'stdout', viewLabel: '直接查看', hideLabel: '收起输出' },
      textContent: '直接查看', attributes: {},
      closest: () => ({ querySelector: () => hangingOutputViewer }),
      setAttribute(name, value) { this.attributes[name] = String(value); }
    };
  `, context);
  const hangingOutput = vm.runInContext('toggleAttemptOutput(hangingOutputButton)', context);
  await new Promise((resolve) => setImmediate(resolve));
  vm.runInContext('abortAttemptOutputLoad()', context);
  await hangingOutput;
  assert.equal(vm.runInContext("hangingOutputViewer.classList.contains('hidden')", context), true);
  assert.equal(vm.runInContext('state.attemptOutputLoad === null', context), true);
  requestHangPath = '';
  vm.runInContext(`
    globalThis.xtermWrites = [];
    globalThis.xtermTerminalDisposed = false;
    globalThis.xtermObserverDisconnected = false;
    globalThis.Terminal = class {
      constructor(options) { this.options = { ...options }; globalThis.xtermTerminalOptions = this.options; }
      loadAddon(addon) { globalThis.xtermLoadedAddon = addon; }
      open(host) { globalThis.xtermOpenedHost = host; }
      write(value, callback) { xtermWrites.push(value); if (callback) callback(); }
      scrollToBottom() { globalThis.xtermScrolled = true; }
      dispose() { globalThis.xtermTerminalDisposed = true; }
    };
    globalThis.FitAddon = { FitAddon: class { fit() { globalThis.xtermFitCount = (globalThis.xtermFitCount || 0) + 1; } } };
    globalThis.ResizeObserver = class {
      constructor(callback) { this.callback = callback; }
      observe(host) { globalThis.xtermObservedHost = host; }
      disconnect() { globalThis.xtermObserverDisconnected = true; }
    };
    globalThis.xtermHost = { classList: outputClassList(['hidden']) };
    globalThis.xtermFallback = { textContent: '', classList: outputClassList() };
    globalThis.xtermViewer = {
      querySelector(selector) {
        if (selector === '[data-terminal-host]') return xtermHost;
        if (selector === '[data-terminal-fallback]' || selector === 'pre') return xtermFallback;
        return null;
      }
    };
    renderAttemptTerminal(xtermViewer, '\\x1b[31mred\\x1b[0m\\rprogress');
  `, context);
  assert.equal(vm.runInContext('xtermTerminalOptions.disableStdin', context), true);
  assert.equal(vm.runInContext('xtermTerminalOptions.convertEol', context), true);
  assert.equal(vm.runInContext('xtermTerminalOptions.cursorBlink', context), true);
  assert.equal(vm.runInContext('xtermTerminalOptions.fontSize', context), 16);
  assert.equal(vm.runInContext('xtermTerminalOptions.theme.background', context), '#11111b');
  assert.equal(vm.runInContext('xtermTerminalOptions.theme.brightGreen', context), '#a6e3a1');
  assert.equal(vm.runInContext('xtermWrites[0].charCodeAt(0)', context), 27);
  assert.ok(vm.runInContext('xtermWrites.join(\'\').length', context) < '\x1b[31mred\x1b[0m\rprogress'.length);
  const firstTerminalPrintTimer = [...timers.entries()].find(([, timer]) => timer.delay === 18);
  assert.ok(firstTerminalPrintTimer);
  timers.delete(firstTerminalPrintTimer[0]);
  firstTerminalPrintTimer[1].callback();
  assert.ok(vm.runInContext('xtermWrites.length', context) > 1);
  while (true) {
    const printTimer = [...timers.entries()].find(([, timer]) => timer.delay === 18);
    if (!printTimer) break;
    timers.delete(printTimer[0]);
    printTimer[1].callback();
  }
  assert.equal(vm.runInContext('xtermWrites.join(\'\')', context), '\x1b[31mred\x1b[0m\rprogress');
  assert.equal(vm.runInContext("xtermHost.classList.contains('hidden')", context), false);
  assert.equal(vm.runInContext("xtermFallback.classList.contains('hidden')", context), true);
  assert.equal(vm.runInContext('attemptTerminalViewers.size', context), 1);
  const fitsBeforeTextResize = vm.runInContext('xtermFitCount', context);
  vm.runInContext("setFontSize('large')", context);
  assert.equal(vm.runInContext('xtermTerminalOptions.fontSize', context), 18);
  assert.ok(vm.runInContext('xtermFitCount', context) > fitsBeforeTextResize);
  vm.runInContext("setFontSize('standard')", context);
  vm.runInContext("appendAttemptTerminal(xtermViewer, 'cancel-this-pending-output')", context);
  assert.ok([...timers.values()].some((timer) => timer.delay === 18));
  vm.runInContext('disposeAttemptTerminals()', context);
  assert.equal([...timers.values()].some((timer) => timer.delay === 18), false);
  assert.equal(vm.runInContext('xtermTerminalDisposed', context), true);
  assert.equal(vm.runInContext('xtermObserverDisconnected', context), true);
  assert.equal(vm.runInContext('attemptTerminalViewers.size', context), 0);
  assert.equal(vm.runInContext("xtermFallback.classList.contains('hidden')", context), false);
  vm.runInContext('delete globalThis.Terminal; delete globalThis.FitAddon; delete globalThis.ResizeObserver', context);
  vm.runInContext(`
    const codexFormatter = createAttemptOutputFormatter('codex-jsonl');
    const codexEvents = [
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'Checking the task.' } },
      { type: 'item.started', item: { id: 'command-1', type: 'command_execution', command: 'npm test', status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'command-1', type: 'command_execution', command: 'npm test', aggregated_output: '1 passing\\n', exit_code: 0, status: 'completed' } },
      { result: 'ordinary JSON output' },
      { type: 'error', message: 'exceeded retry limit, last status: 429 Too Many Requests' },
      { type: 'turn.failed', error: { message: 'exceeded retry limit, last status: 429 Too Many Requests' } }
    ].map(JSON.stringify).join('\\n');
    const splitAt = codexEvents.indexOf('Checking') + 4;
    globalThis.formattedCodexOutput = codexFormatter.push(codexEvents.slice(0, splitAt))
      + codexFormatter.push(codexEvents.slice(splitAt), true);
  `, context);
  const formattedCodexOutput = vm.runInContext('formattedCodexOutput', context);
  const plainCodexOutput = vm.runInContext('plainTerminalText(formattedCodexOutput)', context);
  assert.match(plainCodexOutput, /Codex\nChecking the task\./);
  assert.match(plainCodexOutput, /\$ npm test\n1 passing\n\[exit 0\]/);
  assert.match(plainCodexOutput, /\{"result":"ordinary JSON output"\}/);
  assert.equal((plainCodexOutput.match(/\[Error\]/g) || []).length, 1);
  assert.doesNotMatch(plainCodexOutput, /"type"|turn\.failed|runtime\.error/);
  assert.match(formattedCodexOutput, /\x1b\[1;94mCodex\x1b\[0m/);
  assert.match(formattedCodexOutput, /\x1b\[92m\$\x1b\[0m npm test/);
  assert.match(formattedCodexOutput, /\x1b\[92m\[exit 0\]\x1b\[0m/);
  assert.match(formattedCodexOutput, /\x1b\[91m\[Error\]\x1b\[0m/);
  assert.equal(vm.runInContext(`defaultAttemptOutputKey([
    { id: 'latest', stdoutAvailable: true, stdoutBytes: (5 * 1024 * 1024) + 1, stderrAvailable: true, stderrBytes: 32 },
    { id: 'older', stdoutAvailable: true, stdoutBytes: 64 }
  ])`, context), 'attempt:latest:stderr');
  assert.equal(vm.runInContext(`defaultAttemptOutputKey([
    { id: 'empty', stdoutAvailable: true, stdoutBytes: 0 }
  ])`, context), 'attempt:empty:stdout');
  assert.equal(vm.runInContext(`defaultAttemptOutputKey([], [
    { id: 'pytest-live', status: 'running', archiveStatus: 'pending', archivedLogBytes: null }
  ])`, context), 'external:pytest-live:log');
  assert.equal(vm.runInContext(`defaultAttemptOutputKey([
    { id: 'agent-fallback', stdoutAvailable: true, stdoutBytes: 8 }
  ], [
    { id: 'missing-log', status: 'lost', archiveStatus: 'failed', archivedLogBytes: null }
  ])`, context), 'attempt:agent-fallback:stdout');
  responseOverrides.set('GET /api/sessions/inline-task/attempts/attempt-auto/stdout', { payload: 'automatic terminal\n' });
  vm.runInContext(`
    globalThis.autoOutputFallback = { textContent: '', classList: outputClassList(), scrollHeight: 0, scrollTop: 0 };
    globalThis.autoOutputStatus = { textContent: '', classList: outputClassList() };
    globalThis.autoOutputViewer = {
      classList: outputClassList(['hidden']), dataset: {}, isConnected: true,
      querySelector(selector) {
        if (selector === '[data-attempt-live-status]') return autoOutputStatus;
        if (selector === '[data-terminal-fallback]' || selector === 'pre') return autoOutputFallback;
        return null;
      }
    };
    globalThis.autoOutputButton = {
      dataset: { id: 'attempt-auto', stream: 'stdout', viewLabel: '直接查看', hideLabel: '收起输出' },
      textContent: '直接查看', attributes: {},
      closest: () => ({ querySelector: () => autoOutputViewer }),
      setAttribute(name, value) { this.attributes[name] = String(value); }
    };
    document.querySelectorAll = (selector) => selector.includes('view-attempt-output') ? [autoOutputButton] : [];
    state.currentTaskId = 'inline-task';
    state.expandedAttemptOutputKey = '';
    state.taskTerminalAutoOpen = true;
  `, context);
  await vm.runInContext(`showPreferredAttemptOutput([
    { id: 'attempt-auto', stdoutAvailable: true, stdoutBytes: 19 }
  ])`, context);
  assert.equal(vm.runInContext("autoOutputViewer.classList.contains('hidden')", context), false);
  assert.equal(vm.runInContext('autoOutputFallback.textContent', context), 'automatic terminal\n');
  assert.equal(vm.runInContext('state.expandedAttemptOutputKey', context), 'attempt:attempt-auto:stdout');
  assert.equal(vm.runInContext('state.taskTerminalAutoOpen', context), false);
  vm.runInContext('document.querySelectorAll = () => []', context);

  const completeLiveText = new TextEncoder().encode('line 1\n中\nline 2\n');
  const firstLiveBytes = completeLiveText.subarray(0, new TextEncoder().encode('line 1\n中').length - 1);
  let livePollCount = 0;
  responseOverrides.set('GET /api/sessions/inline-task/attempts/attempt-live/stdout', ({ url }) => {
    const offset = Number(new URL(url, 'http://localhost').searchParams.get('offset'));
    livePollCount += 1;
    if (offset === 0) {
      return {
        payload: firstLiveBytes,
        headers: {
          'content-type': 'text/plain',
          'x-log-offset': 0,
          'x-log-next-offset': firstLiveBytes.byteLength,
          'x-log-file-size': firstLiveBytes.byteLength,
          'x-attempt-status': 'running',
        },
      };
    }
    return {
      payload: completeLiveText.subarray(firstLiveBytes.byteLength),
      headers: {
        'content-type': 'text/plain',
        'x-log-offset': firstLiveBytes.byteLength,
        'x-log-next-offset': completeLiveText.byteLength,
        'x-log-file-size': completeLiveText.byteLength,
        'x-attempt-status': 'completed',
      },
    };
  });
  vm.runInContext(`
    globalThis.liveOutputFallback = { textContent: '', classList: outputClassList(), scrollHeight: 0, scrollTop: 0 };
    globalThis.liveOutputStatus = { textContent: '', classList: outputClassList() };
    globalThis.liveOutputViewer = {
      classList: outputClassList(['hidden']), dataset: {}, isConnected: true,
      querySelector(selector) {
        if (selector === '[data-attempt-live-status]') return liveOutputStatus;
        if (selector === '[data-terminal-fallback]' || selector === 'pre') return liveOutputFallback;
        return null;
      }
    };
    globalThis.liveOutputButton = {
      dataset: { id: 'attempt-live', stream: 'stdout', viewLabel: '直接查看', hideLabel: '收起输出' },
      textContent: '直接查看', attributes: {},
      closest: () => ({ querySelector: () => liveOutputViewer }),
      setAttribute(name, value) { this.attributes[name] = String(value); }
    };
  `, context);
  const liveOutputPromise = vm.runInContext('toggleAttemptOutput(liveOutputButton)', context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(vm.runInContext('liveOutputFallback.textContent', context), 'line 1\n');
  assert.equal(vm.runInContext('liveOutputStatus.textContent', context), '实时');
  const livePollTimer = [...timers.entries()].find(([, timer]) => timer.delay === 750);
  assert.ok(livePollTimer);
  timers.delete(livePollTimer[0]);
  livePollTimer[1].callback();
  await liveOutputPromise;
  assert.equal(vm.runInContext('liveOutputFallback.textContent', context), 'line 1\n中\nline 2\n');
  assert.equal(vm.runInContext('liveOutputStatus.textContent', context), '已结束');
  assert.equal(vm.runInContext('state.attemptOutputLoad === null', context), true);
  assert.equal(livePollCount, 2);

  vm.runInContext(`
    globalThis.webSocketInstances = [];
    globalThis.socketTerminalWrites = [];
    globalThis.Terminal = class {
      constructor() {}
      open() {}
      write(value, callback) { socketTerminalWrites.push(value); callback?.(); }
      scrollToBottom() {}
      dispose() {}
    };
    globalThis.WebSocket = class {
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        webSocketInstances.push(this);
      }
      close(code = 1000) {
        this.readyState = 3;
        this.onclose?.({ code });
      }
      emitOpen() { this.readyState = 1; this.onopen?.(); }
      emitText(payload) { this.onmessage?.({ data: JSON.stringify(payload) }); }
      emitBinary(bytes) { this.onmessage?.({ data: new Uint8Array(bytes).buffer }); }
    };
    globalThis.socketOutputFallback = { textContent: '', classList: outputClassList(), scrollHeight: 0, scrollTop: 0 };
    globalThis.socketOutputStatus = { textContent: '', classList: outputClassList() };
    globalThis.socketTerminalHost = { classList: outputClassList(['hidden']) };
    globalThis.socketOutputViewer = {
      classList: outputClassList(['hidden']), dataset: {}, isConnected: true,
      querySelector(selector) {
        if (selector === '[data-attempt-live-status]') return socketOutputStatus;
        if (selector === '[data-terminal-host]') return socketTerminalHost;
        if (selector === '[data-terminal-fallback]' || selector === 'pre') return socketOutputFallback;
        return null;
      }
    };
    globalThis.socketOutputButton = {
      dataset: { id: 'attempt-socket', stream: 'stdout', viewLabel: '直接查看', hideLabel: '收起输出' },
      textContent: '直接查看', attributes: {},
      closest: () => ({ querySelector: () => socketOutputViewer }),
      setAttribute(name, value) { this.attributes[name] = String(value); }
    };
  `, context);
  const socketOutputPromise = vm.runInContext('toggleAttemptOutput(socketOutputButton)', context);
  vm.runInContext(`
    webSocketInstances[0].emitOpen();
    webSocketInstances[0].emitText({ type: 'ready', offset: 0, fileSize: 12, status: 'running' });
    webSocketInstances[0].emitBinary([108, 105, 110, 101, 32, 49, 10, 228, 184]);
    webSocketInstances[0].emitBinary([173, 10]);
    webSocketInstances[0].emitText({ type: 'end', offset: 11, fileSize: 11, status: 'completed' });
  `, context);
  assert.equal(vm.runInContext('socketOutputStatus.textContent', context), '实时');
  assert.equal(vm.runInContext('socketOutputViewer.dataset.loaded', context), undefined);
  assert.ok(vm.runInContext('socketTerminalWrites.join(\'\').length', context) < 'line 1\n中\n'.length);
  while (true) {
    const printTimer = [...timers.entries()].find(([, timer]) => timer.delay === 18);
    if (!printTimer) break;
    timers.delete(printTimer[0]);
    printTimer[1].callback();
  }
  await socketOutputPromise;
  assert.equal(
    vm.runInContext('webSocketInstances[0].url', context),
    `${authenticatedWebSocketOrigin}/api/sessions/inline-task/attempts/attempt-socket/stdout/live?offset=0`,
  );
  assert.equal(vm.runInContext('socketOutputFallback.textContent', context), 'line 1\n中\n');
  assert.equal(vm.runInContext('socketOutputStatus.textContent', context), '已结束');
  assert.equal(vm.runInContext('state.attemptOutputLoad === null', context), true);
  assert.equal(vm.runInContext('socketTerminalWrites.join(\'\')', context), 'line 1\n中\n');
  vm.runInContext('disposeAttemptTerminals(); delete globalThis.Terminal; delete globalThis.WebSocket', context);

  const worklogHtml = vm.runInContext(`worklogEventList([
    { kind: 'runtime.item.completed', turnId: 'turn-1', message: 'step', payload: { event: { item: { type: 'agent_message' } } } },
    { kind: 'runtime.item.completed', turnId: 'turn-1', message: 'pytest output', payload: { event: { item: { type: 'command_execution' } } } },
    { kind: 'runtime.item.completed', turnId: 'turn-1', message: 'final reply', payload: { event: { item: { type: 'agent_message' } } } },
    { kind: 'session.turn.result', turnId: 'turn-1', message: 'final reply', payload: { result: 'final reply' } }
  ])`, context);
  assert.match(worklogHtml, /step/);
  assert.match(worklogHtml, /session\.turn\.result/);
  assert.equal((worklogHtml.match(/final reply/g) || []).length, 1);
  assert.doesNotMatch(worklogHtml, /pytest output/);
  const failedWorklogHtml = vm.runInContext(`worklogEventList([
    { kind: 'runtime.error', turnId: 'turn-failed', level: 'error', message: '429 Too Many Requests', payload: { event: { type: 'error', message: '429 Too Many Requests' } } },
    { kind: 'runtime.turn.failed', turnId: 'turn-failed', level: 'error', message: '429 Too Many Requests', payload: { event: { type: 'turn.failed', error: { message: '429 Too Many Requests' } } } }
  ])`, context);
  assert.equal((failedWorklogHtml.match(/429 Too Many Requests/g) || []).length, 1);
  assert.doesNotMatch(failedWorklogHtml, /turn\.failed|&quot;type&quot;/);
  const operationHtml = vm.runInContext(`operationAuditList([
    { kind: 'runtime.item.completed', actor: 'worker', message: 'duplicate agent reply' },
    { kind: 'command.skills.corrected', actor: 'operator', requestId: 'request-1', message: 'corrected attribution' },
    { kind: 'session.recovered', actor: 'system', message: 'recovered task' }
  ])`, context);
  assert.doesNotMatch(operationHtml, /duplicate agent reply/);
  assert.match(operationHtml, /corrected attribution/);
  assert.match(operationHtml, /request-1/);
  assert.match(operationHtml, /recovered task/);
  const backgroundHtml = vm.runInContext(`backgroundTrackingList([{
    id: 'external-1', generation: 2, status: 'running', pid: 1234,
    commandPath: '/tmp/converter.cmd', command: 'python3 -m pytest -v converter/test_smoke.py',
    logPath: '/tmp/converter.log', donePath: '/tmp/converter.done', statePath: '/tmp/converter.state',
    checkIntervalSeconds: 300, lastObservation: 'state=running pid=running', startedAt: '2026-07-26T00:00:00.000Z'
  }], [{
    id: 'scheduled-1', externalAttemptId: 'external-1', generation: 2, sequence: 3, status: 'pending', dueAt: '2026-07-26T00:05:00.000Z',
    attemptCount: 0, maxAttempts: 3, commandId: '', lastError: ''
  }])`, context);
  assert.match(backgroundHtml, /external-1/);
  assert.match(backgroundHtml, /scheduled-1/);
  assert.match(backgroundHtml, /pytest 后台执行/);
  assert.match(backgroundHtml, /关联后台/);
  assert.ok(backgroundHtml.indexOf('external-1') < backgroundHtml.indexOf('scheduled-1'));
  assert.match(backgroundHtml, /python3 -m pytest -v converter\/test_smoke\.py/);
  assert.match(backgroundHtml, /external-attempts\/external-1\/log/);
  assert.match(backgroundHtml, /\/tmp\/converter\.done/);
  vm.runInContext(`updateBackgroundTabAvailability([{ id: 'external-1' }], [])`, context);
  assert.equal(element('#detailTabs [data-tab="background"]').classList.contains('hidden'), false);

  const terminalBackgroundHtml = vm.runInContext(`backgroundTrackingList([{
    id: 'external-terminal', generation: 1, status: 'failed', pid: 2011449,
    result: { status: 'failed', terminal: true, exitCode: 1 },
    archiveStatus: 'archived', finishedAt: '2026-08-04T09:32:50.635Z'
  }], [{
    id: 'scheduled-terminal', externalAttemptId: 'external-terminal', generation: 1, sequence: 1,
    status: 'cancelled', dueAt: '2026-08-04T09:37:12.209Z', finishedAt: '2026-08-04T09:32:50.635Z',
    attemptCount: 0, maxAttempts: 3, commandId: '',
    lastError: 'Background execution reached a terminal state'
  }])`, context);
  assert.match(terminalBackgroundHtml, /退出码\s*<code>1<\/code>/);
  assert.match(terminalBackgroundHtml, /无需检查/);
  assert.match(terminalBackgroundHtml, /调度结果/);
  assert.match(terminalBackgroundHtml, /后台任务已结束/);
  assert.doesNotMatch(terminalBackgroundHtml, /Background execution reached a terminal state/);
  assert.match(terminalBackgroundHtml, /09:32/);
  assert.match(terminalBackgroundHtml, /计划回查/);
  assert.match(terminalBackgroundHtml, /09:37/);

  const delayedObservationHtml = vm.runInContext(`backgroundTrackingList([{
    id: 'external-2344', generation: 1, status: 'failed', pid: 2117182,
    command: 'python3 -u -m pytest -v test_check_ncs.py', checkIntervalSeconds: 300,
    result: {
      status: 'failed', terminal: true, exitCode: 1,
      meta: { started_at: '2026-08-04T15:57:39Z', ended_at: '2026-08-04T15:58:19Z', end_signal: 'EXIT' }
    },
    archiveStatus: 'archived', startedAt: '2026-08-04T15:57:39.698Z',
    lastCheckedAt: '2026-08-04T16:07:38.842Z', finishedAt: '2026-08-04T16:07:38.842Z'
  }], [{
    id: 'scheduled-5c59', externalAttemptId: 'external-2344', generation: 1, sequence: 1,
    status: 'completed', dueAt: '2026-08-04T16:02:41.920Z', finishedAt: '2026-08-04T16:07:38.828Z',
    attemptCount: 1, maxAttempts: 3, commandId: 'scheduled-command-1', lastError: ''
  }])`, context);
  assert.match(delayedObservationHtml, /pytest 后台执行/);
  assert.match(delayedObservationHtml, /实际结束/);
  assert.match(delayedObservationHtml, /15:58:19/);
  assert.match(delayedObservationHtml, /平台确认/);
  assert.match(delayedObservationHtml, /16:07:38/);
  assert.match(delayedObservationHtml, /回查完成/);
  assert.match(delayedObservationHtml, /计划回查/);
  assert.match(delayedObservationHtml, /16:02:41/);
  assert.match(delayedObservationHtml, /已托管/);
  assert.ok(delayedObservationHtml.indexOf('external-2344') < delayedObservationHtml.indexOf('scheduled-5c59'));

  const createdTask = {
    id: 'current-target-lifecycle', name: 'Current Target Lifecycle', objective: 'Verify async submit',
    notes: '', workingDir: '.', maxRetries: 2, enabled: true, autoResume: true,
    status: 'queued', createdAt: '2026-08-04T08:00:00.000Z', updatedAt: '2026-08-04T08:00:00.000Z',
  };
  responseOverrides.set('POST /api/sessions/start', { payload: createdTask });
  vm.runInContext(`
    globalThis.originalFormData = globalThis.FormData;
    globalThis.FormData = class {
      constructor(formElement) { this.values = formElement.formValues; }
      get(name) { return this.values[name] ?? null; }
    };
    globalThis.taskSubmitButton = { disabled: false };
    globalThis.taskSubmitForm = document.querySelector('#taskForm');
    taskSubmitForm.formValues = {
      id: 'current-target-lifecycle', name: 'Current Target Lifecycle',
      objective: 'Verify async submit', notes: '', workingDir: '.', maxRetries: '2',
      enabled: 'on', autoResume: 'on'
    };
    taskSubmitForm.querySelector = () => taskSubmitButton;
    globalThis.taskSubmitCurrentTarget = taskSubmitForm;
    globalThis.taskSubmitEvent = {
      preventDefault() {},
      get currentTarget() { return taskSubmitCurrentTarget; }
    };
    globalThis.openedTaskDetailId = '';
    openTaskDetail = async (id) => { openedTaskDetailId = id; };
    loadDashboard = async () => false;
    state.editingTaskId = '';
    globalThis.taskSubmitPromise = saveTask(taskSubmitEvent);
    taskSubmitCurrentTarget = null;
  `, context);
  await vm.runInContext('taskSubmitPromise', context);
  vm.runInContext('globalThis.FormData = originalFormData', context);
  assert.equal(vm.runInContext('openedTaskDetailId', context), createdTask.id);
  assert.equal(vm.runInContext('taskSubmitButton.disabled', context), false);
  const createdTaskRequest = requestDetails
    .filter((request) => request.url === '/api/sessions/start' && request.method === 'POST').at(-1);
  assert.equal(createdTaskRequest.body.id, createdTask.id);
  assert.ok(createdTaskRequest.headers['Idempotency-Key']);

  assert.match(APP_SOURCE, /savedTask\s*=\s*await api\('\/api\/sessions\/start'/);
  assert.match(APP_SOURCE, /function attemptOutputWebSocketUrl[\s\S]*\/live\?offset=/);
  assert.match(APP_SOURCE, /new globalThis\.WebSocket\(/);
  assert.match(APP_SOURCE, /socket\.binaryType\s*=\s*'arraybuffer'/);
  assert.match(APP_SOURCE, /tailAttemptOutput\(load\)\.then\(resolve, reject\)/);
  assert.match(APP_SOURCE, /upsertDashboardTask\(savedTask\)[\s\S]*await openTaskDetail\(savedTask\?\.id \|\| id\)/);
  assert.doesNotMatch(APP_SOURCE, /await loadDashboard\(\);\s*\n\s*if \(!isEditing\) openTaskDetail/);
  assert.doesNotMatch(APP_SOURCE, /status === 'finished'/);
  assert.match(STYLES_SOURCE, /\.task-detail-modal\s*\{[^}]*width:\s*min\(1680px, 100%\)[^}]*height:\s*calc\(100vh - 32px\)/s);
  assert.match(STYLES_SOURCE, /\.task-detail-head\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto/s);
  assert.match(STYLES_SOURCE, /\.detail-title-line h2\s*\{[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere[^}]*word-break:\s*break-word/s);
  assert.match(STYLES_SOURCE, /\.tabs\s*\{[^}]*height:\s*46px[^}]*flex-wrap:\s*nowrap[^}]*overflow-x:\s*auto/s);
  assert.match(STYLES_SOURCE, /\.tabs button\s*\{[^}]*width:\s*164px[^}]*min-width:\s*164px[^}]*flex:\s*0 0 164px/s);
  assert.match(STYLES_SOURCE, /\.toast\s*\{[^}]*height:\s*auto[^}]*max-height:\s*min\(12rem, calc\(100dvh - 3rem\)\)[^}]*grid-template-columns:\s*minmax\(0, 1fr\)[^}]*overflow-x:\s*hidden[^}]*overflow-y:\s*auto[^}]*padding:\s*1\.25rem 1\.5rem/s);
  assert.match(STYLES_SOURCE, /@media \(max-width:\s*860px\)[\s\S]*\.toast\s*\{[^}]*right:\s*0\.625rem[^}]*left:\s*0\.625rem[^}]*width:\s*auto[^}]*min-width:\s*0[^}]*height:\s*auto[^}]*max-height:\s*min\(10rem, calc\(100dvh - 1\.25rem\)\)[^}]*padding:\s*1rem 1\.125rem/s);
  assert.match(STYLES_SOURCE, /\.toast-message\s*\{[^}]*width:\s*auto[^}]*min-width:\s*0[^}]*white-space:\s*pre-wrap[^}]*overflow-wrap:\s*anywhere[^}]*word-break:\s*break-word/s);
  assert.match(INDEX_SOURCE, /data-view="runtime"[\s\S]*id="view-runtime"[\s\S]*id="bridgeInventoryList"/);
  assert.match(INDEX_SOURCE, /id="view-runtime"[\s\S]*id="protectionGrid"[\s\S]*id="bridgeInventoryList"/);
  assert.match(INDEX_SOURCE, /id="protectionMeta" role="status" aria-live="polite"/);
  assert.match(STYLES_SOURCE, /\.protection-grid\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(STYLES_SOURCE, /\.protection-meta\s*\{[^}]*min-height:\s*16px[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(STYLES_SOURCE, /@media \(max-width:\s*1120px\)[\s\S]*\.protection-grid\s*\{[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\)[\s\S]*@media \(max-width:\s*768px\)[\s\S]*\.protection-grid\s*\{[^}]*minmax\(0,\s*1fr\)/s);
  assert.match(INDEX_SOURCE, /id="bridgeReclaimModal"[\s\S]*id="bridgeReclaimInput"[\s\S]*id="confirmBridgeReclaimBtn"[^>]*disabled/);
  assert.match(STYLES_SOURCE, /\.inventory-row\s*\{[^}]*grid-template-columns:\s*minmax\(235px,[^}]*minmax\(170px,[^}]*minmax\(250px,/s);
  assert.match(STYLES_SOURCE, /@media \(max-width:\s*1120px\)[\s\S]*\.inventory-row\s*\{[^}]*grid-template-columns:[^}]*\}[\s\S]*@media \(max-width:\s*860px\)[\s\S]*\.inventory-row\s*\{[^}]*grid-template-columns:[^}]*\}[\s\S]*@media \(max-width:\s*768px\)[\s\S]*\.inventory-row\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
  assert.match(STYLES_SOURCE, /\.inventory-identity code\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(STYLES_SOURCE, /\.runtime-reasons\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(STYLES_SOURCE, /\.runtime-reasons li\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.doesNotMatch(STYLES_SOURCE, /\.detail-actions \.button\s*\{\s*display:\s*none/);
  assert.match(INDEX_SOURCE, /id="toast" role="status" aria-live="polite"[\s\S]*id="toastMessage"/);
  assert.match(INDEX_SOURCE, /id="runtimeAlert" role="status" aria-live="polite"/);

  vm.runInContext('clearTimeout(toast.timer)', context);
  document.hidden = true;
  documentListeners.get('visibilitychange')();
  assert.equal(timers.size, 0);
  assert.equal(vm.runInContext('protectionPollTimer === null', context), true);
  document.hidden = false;
  documentListeners.get('visibilitychange')();
  assert.ok([...timers.values()].some((timer) => timer.delay === 0));
  assert.ok(windowListeners.has('pagehide'));
});
