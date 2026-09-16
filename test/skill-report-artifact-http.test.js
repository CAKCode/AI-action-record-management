const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitFor(url, options = {}, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { ...options, method: 'HEAD' });
      if (response.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function stop(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

test('managed pytest HTML artifacts support HEAD without streaming a response body', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-artifact-head-'));
  const dataDir = path.join(root, 'data');
  const runtimeDir = path.join(root, 'runtime');
  const workspaceDir = path.join(root, 'workspace');
  const sourceHome = path.join(root, 'source-home');
  const workspaceSkills = path.join(root, 'workspace-skills');
  for (const directory of [dataDir, runtimeDir, workspaceDir, sourceHome, workspaceSkills]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const port = await availablePort();
  const taskId = 'artifact-head-task';
  const reportId = 'skill-report-artifact-head';
  const artifactId = 'report-artifact-head';
  const resourceId = 'report-resource-head';
  const playlistResourceId = 'report-resource-playlist-head';
  const playlistSegmentResourceId = 'report-resource-playlist-segment-head';
  const pairedPlaylistResourceId = 'report-resource-paired-playlist-head';
  const pairedMp4ResourceId = 'report-resource-paired-mp4-head';
  const imageResourceId = 'report-resource-image-head';
  const markdownArtifactId = 'failure-analysis-artifact-head';
  const externalAttemptId = 'external-artifact-head';
  const resourceApiPath = `/api/sessions/${taskId}/skill-reports/${reportId}`
    + `/artifacts/${artifactId}/resources/${resourceId}`;
  const playlistResourceApiPath = `/api/sessions/${taskId}/skill-reports/${reportId}`
    + `/artifacts/${artifactId}/resources/${playlistResourceId}`;
  const playlistSegmentResourceApiPath = `/api/sessions/${taskId}/skill-reports/${reportId}`
    + `/artifacts/${artifactId}/resources/${playlistSegmentResourceId}`;
  const pairedPlaylistResourceApiPath = `/api/sessions/${taskId}/skill-reports/${reportId}`
    + `/artifacts/${artifactId}/resources/${pairedPlaylistResourceId}`;
  const pairedMp4ResourceApiPath = `/api/sessions/${taskId}/skill-reports/${reportId}`
    + `/artifacts/${artifactId}/resources/${pairedMp4ResourceId}`;
  const imageResourceApiPath = `/api/sessions/${taskId}/skill-reports/${reportId}`
    + `/artifacts/${artifactId}/resources/${imageResourceId}`;
  const legacyViewedObserver = `  function restoreViewedLinks() {
    var map = loadViewedMap();
    var links = document.querySelectorAll('.vm_video_link');
    links.forEach(function(a){
      if (map[linkKey(a)]) {
        markLinkViewed(a);
      }
    });
  }
  function installRestoreObserver() {
    if (!window.MutationObserver || !document.body) {
      return;
    }
    var scheduled = false;
    var observer = new MutationObserver(function(mutations){
      var shouldRestore = false;
      mutations.forEach(function(mutation){
        if (mutation.addedNodes && mutation.addedNodes.length) {
          shouldRestore = true;
        }
      });
      if (!shouldRestore || scheduled) {
        return;
      }
      scheduled = true;
      window.requestAnimationFrame(function(){
        scheduled = false;
        restoreViewedLinks();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
`;
  const legacyLogFrameLoad = "if(frame){ frame.src = url; ov.style.display='flex'; }";
  const html = `<!doctype html><head><script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.15/dist/hls.min.js"></script><script src="https://cdn.jsdelivr.net/npm/flv.js@latest/dist/flv.min.js"></script><script src="https://cdn.jsdelivr.net/npm/dashjs@4.7.4/dist/dash.all.min.js"></script><script src="https://cdn.jsdelivr.net/npm/shaka-player@4.15.15/dist/shaka-player.compiled.js"></script><script>${legacyViewedObserver}${legacyLogFrameLoad}</script></head><body><title>Managed artifact</title><iframe src="${resourceApiPath}"></iframe><a class="vm_video_link" data-src="${resourceApiPath}" data-label="Sample">Video</a><a class="vm_video_link" data-src="${playlistResourceApiPath}" data-label="sample_h265.m3u8">HLS</a><a class="vm_video_link" data-src="${pairedPlaylistResourceApiPath}" data-label="sample_pair.m3u8">Paired HLS</a><img src="${imageResourceApiPath}" alt="sample"></body>`;
  const registeredLogReference = 'logs/sample.txt';
  const registeredVideoReference = '../videos/sample.mp4';
  const registeredPlaylistReference = '../videos/sample.m3u8';
  const registeredMpdReference = '../videos/sample.mpd';
  const registeredImageReference = 'assets/extra.png';
  const registeredBmpReference = 'assets/extra.bmp';
  const registeredImageData = JSON.stringify({
    tests: {
      sample: [{ extras: [{ format_type: 'image', content: registeredImageReference }] }],
    },
  }).replace(/&/g, '&amp;').replace(/"/g, '&#34;');
  const registeredHtml = `<!doctype html><head><link href="assets/style.css" rel="stylesheet" type="text/css"><script src="assets/app.js"></script></head><body><main id="running">Running artifact</main><iframe src="${registeredLogReference}"></iframe><a href="${registeredVideoReference}" data-src="${registeredVideoReference}">video</a><a href="${registeredPlaylistReference}" data-src="${registeredPlaylistReference}">playlist</a><a href="${registeredMpdReference}" data-src="${registeredMpdReference}">dash</a><img src="${registeredBmpReference}" alt="bmp"><div data-jsonblob="${registeredImageData}"></div></body>`;
  const registeredLog = 'registered artifact log\n';
  const registeredVideo = Buffer.from('registered video\n', 'utf8');
  const registeredPlaylist = '#EXTM3U\n#EXTINF:1,\nsample.ts\n';
  const registeredSegment = Buffer.from('registered segment\n', 'utf8');
  const registeredMpd = '<MPD><Period><Representation id="0"><SegmentTemplate initialization="sample_$RepresentationID$_init.webm" media="sample_$RepresentationID$_$Number%06d$.webm" /></Representation></Period></MPD>';
  const registeredMpdInit = Buffer.from('registered dash init\n', 'utf8');
  const registeredMpdSegment = Buffer.from('registered dash segment\n', 'utf8');
  const registeredImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const registeredFlv = Buffer.from('registered flv\n', 'utf8');
  const imageResource = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const managedSegment = Buffer.from('managed HLS segment\n', 'utf8');
  const pairedMp4 = Buffer.from('paired MP4 playback\n', 'utf8');
  const managedPlaylist = `#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:1,\n${playlistSegmentResourceApiPath}\n#EXT-X-ENDLIST\n`;
  const pairedPlaylist = `#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:1,\n${playlistSegmentResourceApiPath}\n#EXT-X-ENDLIST\n`;
  const media = Buffer.from('<!doctype html><style>body{color:white}</style><pre>0123456789</pre>', 'utf8');
  const markdown = '# Failure analysis\n\n- BUG: 1\n';
  const fakeFfmpegPath = path.join(root, 'fake-ffmpeg');
  const fakeFfmpegCalls = path.join(root, 'fake-ffmpeg-calls.txt');
  fs.writeFileSync(fakeFfmpegPath, [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    'const args = process.argv.slice(2);',
    "const inputIndex = args.indexOf('-i');",
    'const input = args[inputIndex + 1];',
    'const output = args[args.length - 1];',
    "const manifest = fs.readFileSync(input, 'utf8');",
    "if (!manifest.includes('file://')) process.exit(2);",
    "fs.appendFileSync(process.env.CODEX_TEST_FFMPEG_CALLS, 'called\\n');",
    "fs.writeFileSync(output, Buffer.from('remuxed HLS playback\\n'));",
  ].join('\n'), { mode: 0o700 });
  const setup = [
    "const crypto = require('crypto');",
    "const fs = require('fs');",
    "const path = require('path');",
    "const store = require('./src/store');",
    "const { getDatabase } = require('./src/database');",
    `const taskId = ${JSON.stringify(taskId)};`,
    `const reportId = ${JSON.stringify(reportId)};`,
    `const artifactId = ${JSON.stringify(artifactId)};`,
    `const resourceId = ${JSON.stringify(resourceId)};`,
    `const playlistResourceId = ${JSON.stringify(playlistResourceId)};`,
    `const playlistSegmentResourceId = ${JSON.stringify(playlistSegmentResourceId)};`,
    `const pairedPlaylistResourceId = ${JSON.stringify(pairedPlaylistResourceId)};`,
    `const pairedMp4ResourceId = ${JSON.stringify(pairedMp4ResourceId)};`,
    `const imageResourceId = ${JSON.stringify(imageResourceId)};`,
    `const markdownArtifactId = ${JSON.stringify(markdownArtifactId)};`,
    `const externalAttemptId = ${JSON.stringify(externalAttemptId)};`,
    `const html = ${JSON.stringify(html)};`,
    `const registeredHtml = ${JSON.stringify(registeredHtml)};`,
    `const registeredLog = ${JSON.stringify(registeredLog)};`,
    `const registeredVideo = Buffer.from(${JSON.stringify(registeredVideo.toString('base64'))}, 'base64');`,
    `const registeredPlaylist = ${JSON.stringify(registeredPlaylist)};`,
    `const registeredSegment = Buffer.from(${JSON.stringify(registeredSegment.toString('base64'))}, 'base64');`,
    `const registeredMpd = ${JSON.stringify(registeredMpd)};`,
    `const registeredMpdInit = Buffer.from(${JSON.stringify(registeredMpdInit.toString('base64'))}, 'base64');`,
    `const registeredMpdSegment = Buffer.from(${JSON.stringify(registeredMpdSegment.toString('base64'))}, 'base64');`,
    `const registeredImage = Buffer.from(${JSON.stringify(registeredImage.toString('base64'))}, 'base64');`,
    `const registeredFlv = Buffer.from(${JSON.stringify(registeredFlv.toString('base64'))}, 'base64');`,
    `const imageResource = Buffer.from(${JSON.stringify(imageResource.toString('base64'))}, 'base64');`,
    `const managedSegment = Buffer.from(${JSON.stringify(managedSegment.toString('base64'))}, 'base64');`,
    `const pairedMp4 = Buffer.from(${JSON.stringify(pairedMp4.toString('base64'))}, 'base64');`,
    `const managedPlaylist = ${JSON.stringify(managedPlaylist)};`,
    `const pairedPlaylist = ${JSON.stringify(pairedPlaylist)};`,
    `const media = Buffer.from(${JSON.stringify(media.toString('base64'))}, 'base64');`,
    `const markdown = ${JSON.stringify(markdown)};`,
    "store.saveSession(taskId, { name: taskId, objective: 'HTTP artifact contract.', workingDir: process.env.CODEX_TASK_WORKSPACE_ROOTS });",
    "const registeredTaskDir = path.join(process.env.CODEX_TASK_WORKSPACE_ROOTS, 'task');",
    "const registeredPath = path.join(registeredTaskDir, 'running.html');",
    "const missingPath = path.join(registeredTaskDir, 'missing.html');",
    "const registeredAssets = path.join(registeredTaskDir, 'assets');",
    "const registeredLogs = path.join(registeredTaskDir, 'logs');",
    "const registeredVideos = path.join(process.env.CODEX_TASK_WORKSPACE_ROOTS, 'videos');",
    "const metaPath = path.join(registeredTaskDir, 'run.meta');",
    "fs.mkdirSync(registeredTaskDir, { recursive: true, mode: 0o700 });",
    "fs.mkdirSync(registeredAssets, { recursive: true, mode: 0o700 });",
    "fs.mkdirSync(registeredLogs, { recursive: true, mode: 0o700 });",
    "fs.mkdirSync(registeredVideos, { recursive: true, mode: 0o700 });",
    "fs.writeFileSync(registeredPath, registeredHtml, { mode: 0o600 });",
    "fs.writeFileSync(path.join(registeredAssets, 'style.css'), '#running { color: rgb(1, 2, 3); }', { mode: 0o600 });",
    "fs.writeFileSync(path.join(registeredAssets, 'app.js'), 'window.__runningArtifactReady = true;', { mode: 0o600 });",
    "fs.writeFileSync(path.join(registeredAssets, 'extra.png'), registeredImage, { mode: 0o600 });",
    "fs.writeFileSync(path.join(registeredAssets, 'extra.bmp'), registeredImage, { mode: 0o600 });",
    "fs.writeFileSync(path.join(registeredLogs, 'sample.txt'), registeredLog, { mode: 0o600 });",
    "fs.writeFileSync(path.join(registeredVideos, 'sample.mp4'), registeredVideo, { mode: 0o600 });",
    "fs.writeFileSync(path.join(registeredVideos, 'sample.m3u8'), registeredPlaylist, { mode: 0o600 });",
    "fs.writeFileSync(path.join(registeredVideos, 'sample.ts'), registeredSegment, { mode: 0o600 });",
    "fs.writeFileSync(path.join(registeredVideos, 'sample.mpd'), registeredMpd, { mode: 0o600 });",
    "fs.writeFileSync(path.join(registeredVideos, 'sample_0_init.webm'), registeredMpdInit, { mode: 0o600 });",
    "fs.writeFileSync(path.join(registeredVideos, 'sample_0_000001.webm'), registeredMpdSegment, { mode: 0o600 });",
    "fs.writeFileSync(path.join(registeredVideos, 'sample.flv'), registeredFlv, { mode: 0o600 });",
    "fs.writeFileSync(metaPath, JSON.stringify({ work_dir: process.env.CODEX_TASK_WORKSPACE_ROOTS }), { mode: 0o600 });",
    "const artifactDir = path.join(process.env.CODEX_DESK_DATA_DIR, 'sessions', taskId, 'skill-report-artifacts', reportId);",
    "fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });",
    "const artifactPath = path.join(artifactDir, `${artifactId}.html`);",
    "const markdownPath = path.join(artifactDir, `${markdownArtifactId}.md`);",
    "const resourceDir = path.join(artifactDir, `${artifactId}.resources`);",
    "fs.mkdirSync(resourceDir, { recursive: true, mode: 0o700 });",
    "const resourcePath = path.join(resourceDir, `${resourceId}.html`);",
    "const playlistResourcePath = path.join(resourceDir, `${playlistResourceId}.m3u8`);",
    "const playlistSegmentResourcePath = path.join(resourceDir, `${playlistSegmentResourceId}.ts`);",
    "const pairedPlaylistResourcePath = path.join(resourceDir, `${pairedPlaylistResourceId}.m3u8`);",
    "const pairedMp4ResourcePath = path.join(resourceDir, `${pairedMp4ResourceId}.mp4`);",
    "const imageResourcePath = path.join(resourceDir, `${imageResourceId}.png`);",
    "fs.writeFileSync(artifactPath, html, { mode: 0o600 });",
    "fs.writeFileSync(markdownPath, markdown, { mode: 0o600 });",
    "fs.writeFileSync(resourcePath, media, { mode: 0o600 });",
    "fs.writeFileSync(playlistResourcePath, managedPlaylist, { mode: 0o600 });",
    "fs.writeFileSync(playlistSegmentResourcePath, managedSegment, { mode: 0o600 });",
    "fs.writeFileSync(pairedPlaylistResourcePath, pairedPlaylist, { mode: 0o600 });",
    "fs.writeFileSync(pairedMp4ResourcePath, pairedMp4, { mode: 0o600 });",
    "fs.writeFileSync(imageResourcePath, imageResource, { mode: 0o600 });",
    "const hash = crypto.createHash('sha256').update(html).digest('hex');",
    "const markdownHash = crypto.createHash('sha256').update(markdown).digest('hex');",
    "const mediaHash = crypto.createHash('sha256').update(media).digest('hex');",
    "const playlistResourceHash = crypto.createHash('sha256').update(managedPlaylist).digest('hex');",
    "const playlistSegmentResourceHash = crypto.createHash('sha256').update(managedSegment).digest('hex');",
    "const pairedPlaylistResourceHash = crypto.createHash('sha256').update(pairedPlaylist).digest('hex');",
    "const pairedMp4ResourceHash = crypto.createHash('sha256').update(pairedMp4).digest('hex');",
    "const imageResourceHash = crypto.createHash('sha256').update(imageResource).digest('hex');",
    "const now = new Date().toISOString();",
    "const db = getDatabase();",
    "db.prepare(`INSERT INTO external_attempts(id, task_id, chain_key, generation, label, status, log_path, meta_path, artifact_declarations_json, started_at, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 'running', ?, ?, ?, ?, ?, ?)` )",
    "  .run(externalAttemptId, taskId, 'artifact-http', 'Running report', path.join(registeredTaskDir, 'run.log'), metaPath, JSON.stringify([{ key: 'normal', kind: 'pytest-html', path: registeredPath }, { key: 'missing', kind: 'pytest-html', path: missingPath }]), now, now, now);",
    "db.prepare(`INSERT INTO skill_reports(id, task_id, turn_id, attempt_id, report_key, revision, report_hash, schema_version, skill_id, skill_version, skill_content_hash, report_type, status, title, summary, payload_json, published_at) VALUES (?, ?, NULL, NULL, ?, 1, ?, 1, ?, 1, ?, ?, ?, ?, ?, ?, ?)`)",
    "  .run(reportId, taskId, 'head', hash, 'report-skill', hash, 'test-result', 'succeeded', 'Artifact head', 'Artifact HTTP contract.', '{}', now);",
    "db.prepare(`INSERT INTO skill_report_artifacts(id, task_id, report_id, artifact_key, label, kind, file_name, media_type, managed_path, bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)",
    "  .run(artifactId, taskId, reportId, 'pytest-html', 'Pytest HTML report', 'pytest-html', 'artifact.html', 'text/html; charset=utf-8', artifactPath, Buffer.byteLength(html), hash, now);",
    "db.prepare(`INSERT INTO skill_report_artifacts(id, task_id, report_id, artifact_key, label, kind, file_name, media_type, managed_path, bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)",
    "  .run(markdownArtifactId, taskId, reportId, 'failure-analysis-markdown', 'Failure analysis report', 'failure-analysis-markdown', 'failure-analysis.md', 'text/markdown; charset=utf-8', markdownPath, Buffer.byteLength(markdown), markdownHash, now);",
    "db.prepare(`INSERT INTO skill_report_artifact_resources(id, task_id, report_id, artifact_id, resource_key, file_name, media_type, managed_path, bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)",
    "  .run(resourceId, taskId, reportId, artifactId, 'logs/sample.html', 'sample.html', 'text/html; charset=utf-8', resourcePath, media.length, mediaHash, now);",
    "db.prepare(`INSERT INTO skill_report_artifact_resources(id, task_id, report_id, artifact_id, resource_key, file_name, media_type, managed_path, bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)",
    "  .run(playlistResourceId, taskId, reportId, artifactId, 'videos/sample_h265.m3u8', 'sample_h265.m3u8', 'application/vnd.apple.mpegurl', playlistResourcePath, Buffer.byteLength(managedPlaylist), playlistResourceHash, now);",
    "db.prepare(`INSERT INTO skill_report_artifact_resources(id, task_id, report_id, artifact_id, resource_key, file_name, media_type, managed_path, bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)",
    "  .run(playlistSegmentResourceId, taskId, reportId, artifactId, 'videos/sample_h265.ts', 'sample_h265.ts', 'video/mp2t', playlistSegmentResourcePath, managedSegment.length, playlistSegmentResourceHash, now);",
    "db.prepare(`INSERT INTO skill_report_artifact_resources(id, task_id, report_id, artifact_id, resource_key, file_name, media_type, managed_path, bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)",
    "  .run(pairedPlaylistResourceId, taskId, reportId, artifactId, 'videos/sample_pair.m3u8', 'sample_pair.m3u8', 'application/vnd.apple.mpegurl', pairedPlaylistResourcePath, Buffer.byteLength(pairedPlaylist), pairedPlaylistResourceHash, now);",
    "db.prepare(`INSERT INTO skill_report_artifact_resources(id, task_id, report_id, artifact_id, resource_key, file_name, media_type, managed_path, bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)",
    "  .run(pairedMp4ResourceId, taskId, reportId, artifactId, 'videos/sample_pair_0.mp4', 'sample_pair_0.mp4', 'video/mp4', pairedMp4ResourcePath, pairedMp4.length, pairedMp4ResourceHash, now);",
    "db.prepare(`INSERT INTO skill_report_artifact_resources(id, task_id, report_id, artifact_id, resource_key, file_name, media_type, managed_path, bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)",
    "  .run(imageResourceId, taskId, reportId, artifactId, 'images/sample.png', 'sample.png', 'image/png', imageResourcePath, imageResource.length, imageResourceHash, now);",
    "require('./server');",
  ].join('\n');
  const child = spawn(process.execPath, ['-e', setup], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      CODEX_REQUIRE_HOST_LAUNCHER: '',
      CODEX_HOST_LAUNCHER_PID: '',
      CODEX_HOST_LAUNCHER_START_TICKS: '',
      CODEX_REQUIRE_WEB_SUPERVISOR: '',
      CODEX_WEB_SUPERVISOR_PID: '',
      CODEX_WEB_SUPERVISOR_START_TICKS: '',
      HOST: '127.0.0.1',
      PORT: String(port),
      CODEX_DESK_DATA_DIR: dataDir,
      CODEX_DESK_RUNTIME_DIR: runtimeDir,
      CODEX_TASK_WORKSPACE_ROOTS: workspaceDir,
      SOURCE_CODEX_HOME: sourceHome,
      WORKSPACE_CODEX_SKILLS_DIR: workspaceSkills,
      CODEX_ALLOW_ROOT_EXECUTION: '1',
      CODEX_DISABLE_WORKER: '1',
      CODEX_DB_BACKUP_INTERVAL_HOURS: '0',
      CODEX_RECOVERY_CHECKPOINT_INTERVAL_HOURS: '0',
      CODEX_DESK_AUTH_USER: 'artifact-user',
      CODEX_DESK_AUTH_PASSWORD: 'artifact-password',
      CODEX_REPORT_FFMPEG_PATH: fakeFfmpegPath,
      CODEX_TEST_FFMPEG_CALLS: fakeFfmpegCalls,
    },
    stdio: 'inherit',
  });
  const artifactUrl = `http://127.0.0.1:${port}/api/sessions/${taskId}/skill-reports/${reportId}/artifacts/${artifactId}`;
  const markdownUrl = `http://127.0.0.1:${port}/api/sessions/${taskId}/skill-reports/${reportId}/artifacts/${markdownArtifactId}`;
  const resourceUrl = `${artifactUrl}/resources/${resourceId}`;
  const registeredUrl = `http://127.0.0.1:${port}/api/sessions/${taskId}/external-attempts/${externalAttemptId}/artifacts/normal`;
  const registeredFlvUrl = `${registeredUrl}/resources/${encodeURIComponent('../videos/sample.flv')}`;
    const registeredStyleUrl = `${registeredUrl}/resources/assets/style.css`;
    const registeredScriptUrl = `${registeredUrl}/resources/assets/app.js`;
    const registeredLogUrl = `${registeredUrl}/resources/${registeredLogReference}`;
  const missingRegisteredUrl = `http://127.0.0.1:${port}/api/sessions/${taskId}/external-attempts/${externalAttemptId}/artifacts/missing`;
  const unknownRegisteredUrl = `http://127.0.0.1:${port}/api/sessions/${taskId}/external-attempts/${externalAttemptId}/artifacts/unknown`;
  const authorization = `Basic ${Buffer.from('artifact-user:artifact-password').toString('base64')}`;
  const authenticatedFetch = (url, options = {}) => fetch(url, {
    ...options,
    headers: { authorization, ...options.headers },
  });
  try {
    await waitFor(artifactUrl, { headers: { authorization } });
    const login = await fetch(`http://127.0.0.1:${port}/api/auth/session`, {
      method: 'POST',
      headers: { authorization },
    });
    assert.equal(login.status, 200);
    const sessionCookie = (login.headers.get('set-cookie') || '').split(';', 1)[0];
    assert.match(sessionCookie, /^codex_task_session=/);
    const sessionFetch = (url, options = {}) => fetch(url, {
      ...options,
      headers: { cookie: sessionCookie, ...options.headers },
    });
    const cookieArtifactHead = await sessionFetch(artifactUrl, { method: 'HEAD' });
    assert.equal(cookieArtifactHead.status, 200);
    const cookieRegisteredLog = await sessionFetch(registeredLogUrl);
    assert.equal(cookieRegisteredLog.status, 200);
    assert.equal(await cookieRegisteredLog.text(), registeredLog);
    const head = await authenticatedFetch(artifactUrl, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(head.headers.get('content-disposition'), 'inline; filename="artifact.html"');
    assert.equal(head.headers.get('cache-control'), 'private, no-store');
    assert.equal(head.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(head.headers.get('x-content-type-options'), 'nosniff');
    const contentSecurityPolicy = head.headers.get('content-security-policy');
    assert.match(contentSecurityPolicy, /sandbox allow-scripts/);
    assert.match(contentSecurityPolicy, /default-src 'none'/);
    assert.match(contentSecurityPolicy, /frame-src http: https: data:/);
    assert.doesNotMatch(contentSecurityPolicy, /allow-same-origin/);
    assert.match(contentSecurityPolicy, /media-src 'self'/);
    assert.match(contentSecurityPolicy, /connect-src 'self'/);
    assert.match(contentSecurityPolicy, /worker-src blob:/);
    assert.equal(head.headers.get('set-cookie'), null);
    assert.equal(await head.text(), '');

    const get = await authenticatedFetch(artifactUrl);
    assert.equal(get.status, 200);
    assert.equal(get.headers.get('content-length'), head.headers.get('content-length'));
    assert.equal(get.headers.get('content-security-policy'), contentSecurityPolicy);
    const servedHtml = await get.text();
    assert.notEqual(servedHtml, html);
    assert.match(servedHtml, /<title>artifact\.html<\/title>/);
    assert.match(servedHtml, /pytest-html-video-viewed-state/);
    assert.match(servedHtml, /pytest-html-video-viewed/);
    assert.match(servedHtml, /processAddedTree/);
    assert.match(servedHtml, /markViewed\(linkKey\(link\),link\)/);
    assert.match(servedHtml, /pendingRestoreRoots/);
    assert.match(servedHtml, /nextFrame=frame\.cloneNode\(false\)/);
    assert.match(servedHtml, /nextFrame\.removeAttribute\('src'\)/);
    assert.doesNotMatch(servedHtml, /if\(frame\)\{ frame\.src = url;/);
    assert.doesNotMatch(servedHtml, /var shouldRestore = false/);
    assert.doesNotMatch(servedHtml, /new MutationObserver\(restore\)/);
    assert.doesNotMatch(servedHtml, /<script\b[^>]*\bsrc="https:\/\/cdn\.jsdelivr\.net/);
    for (const player of ['hls', 'flv', 'dash', 'shaka']) {
      assert.match(servedHtml, new RegExp(`data-codex-pytest-player="${player}"`));
    }
    assert.match(servedHtml, /1\.7\.1/);
    const viewedAdapterConfig = JSON.parse(/var config=(\{[^;]+\});/.exec(servedHtml)?.[1] || 'null');
    assert.ok(viewedAdapterConfig);
    assert.deepEqual(viewedAdapterConfig.mediaKeys, []);
    assert.match(viewedAdapterConfig.endpoint, /\/viewed-media\?codex_report_viewed_access=/);
    const remuxPlayback = viewedAdapterConfig.playbackSources[playlistResourceId];
    assert.equal(remuxPlayback.format, 'mp4');
    assert.equal(remuxPlayback.fallbackOnly, true);
    const remuxPlaybackUrl = new URL(remuxPlayback.source, artifactUrl);
    assert.equal(remuxPlaybackUrl.pathname, `${playlistResourceApiPath}/playback`);
    assert.equal(remuxPlaybackUrl.hash, '#codex-media-format=.mp4');
    assert.match(
      remuxPlaybackUrl.searchParams.get('codex_report_resource_access'),
      /^[A-Za-z0-9_-]+$/,
    );
    const pairedPlayback = viewedAdapterConfig.playbackSources[pairedPlaylistResourceId];
    assert.equal(pairedPlayback.format, 'mp4');
    assert.equal(pairedPlayback.fallbackOnly, false);
    const pairedPlaybackUrl = new URL(pairedPlayback.source, artifactUrl);
    assert.equal(pairedPlaybackUrl.pathname, pairedMp4ResourceApiPath);
    assert.equal(pairedPlaybackUrl.hash, '#codex-media-format=.mp4');
    const signedResourcePath = /<iframe src="([^"]+)">/.exec(servedHtml)?.[1];
    assert.ok(signedResourcePath);
    const signedResourceUrl = new URL(signedResourcePath, artifactUrl);
    assert.equal(signedResourceUrl.pathname, resourceApiPath);
    assert.match(signedResourceUrl.searchParams.get('codex_report_resource_access'), /^[A-Za-z0-9_-]+$/);
    const signedPlaylistResourcePath = /data-src="([^"]+)" data-label="sample_h265\.m3u8"/.exec(servedHtml)?.[1];
    assert.ok(signedPlaylistResourcePath);
    const signedPlaylistResourceUrl = new URL(signedPlaylistResourcePath, artifactUrl);
    assert.equal(signedPlaylistResourceUrl.pathname, playlistResourceApiPath);
    assert.equal(signedPlaylistResourceUrl.hash, '#codex-media-format=.m3u8');
    assert.match(
      signedPlaylistResourceUrl.searchParams.get('codex_report_resource_access'),
      /^[A-Za-z0-9_-]+$/,
    );
    const playlistResourceResponse = await fetch(signedPlaylistResourceUrl);
    assert.equal(playlistResourceResponse.status, 200);
    assert.equal(
      playlistResourceResponse.headers.get('content-type'),
      'application/vnd.apple.mpegurl',
    );
    const firstPlaybackResponse = await fetch(remuxPlaybackUrl);
    assert.equal(firstPlaybackResponse.status, 200);
    assert.equal(firstPlaybackResponse.headers.get('content-type'), 'video/mp4');
    assert.equal(await firstPlaybackResponse.text(), 'remuxed HLS playback\n');
    const cachedPlaybackResponse = await fetch(remuxPlaybackUrl, {
      headers: { Range: 'bytes=8-10' },
    });
    assert.equal(cachedPlaybackResponse.status, 206);
    assert.equal(cachedPlaybackResponse.headers.get('content-range'), 'bytes 8-10/21');
    assert.equal(await cachedPlaybackResponse.text(), 'HLS');
    assert.equal(fs.readFileSync(fakeFfmpegCalls, 'utf8'), 'called\n');
    const pairedPlaybackResponse = await fetch(pairedPlaybackUrl);
    assert.equal(pairedPlaybackResponse.status, 200);
    assert.deepEqual(Buffer.from(await pairedPlaybackResponse.arrayBuffer()), pairedMp4);
    const signedImageResourcePath = /<img src="([^"]+)" alt="sample">/.exec(servedHtml)?.[1];
    assert.ok(signedImageResourcePath);
    const signedImageResourceUrl = new URL(signedImageResourcePath, artifactUrl);
    assert.equal(signedImageResourceUrl.pathname, imageResourceApiPath);
    assert.equal(signedImageResourceUrl.hash, '');
    const imageResourceResponse = await fetch(signedImageResourceUrl);
    assert.equal(imageResourceResponse.status, 200);
    assert.equal(imageResourceResponse.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await imageResourceResponse.arrayBuffer()), imageResource);
    assert.equal(head.headers.get('content-length'), String(Buffer.byteLength(servedHtml)));

    const viewedMediaUrl = `${artifactUrl}/viewed-media`;
    const initialViewed = await authenticatedFetch(viewedMediaUrl);
    assert.equal(initialViewed.status, 200);
    assert.deepEqual(await initialViewed.json(), {
      artifactId,
      mediaKeys: [],
      viewed: [],
    });
    const firstViewed = await authenticatedFetch(viewedMediaUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mediaKey: `resource:${resourceId}` }),
    });
    assert.equal(firstViewed.status, 201);
    const firstViewedPayload = await firstViewed.json();
    assert.equal(firstViewedPayload.mediaKey, `resource:${resourceId}`);
    assert.equal(firstViewedPayload.created, true);
    const repeatedViewed = await authenticatedFetch(viewedMediaUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mediaKey: `resource:${resourceId}` }),
    });
    assert.equal(repeatedViewed.status, 200);
    assert.deepEqual(await repeatedViewed.json(), { ...firstViewedPayload, created: false });

    const capabilityViewedUrl = new URL(viewedAdapterConfig.endpoint, artifactUrl);
    capabilityViewedUrl.searchParams.set('mediaKey', 'video:capability');
    const capabilityViewed = await fetch(capabilityViewedUrl, {
      method: 'POST',
      headers: { Origin: 'null' },
    });
    assert.equal(capabilityViewed.status, 201);
    assert.equal(capabilityViewed.headers.get('access-control-allow-origin'), '*');
    assert.equal((await capabilityViewed.json()).mediaKey, 'video:capability');
    const invalidCapabilityUrl = new URL(capabilityViewedUrl);
    invalidCapabilityUrl.searchParams.set('codex_report_viewed_access', 'invalid');
    assert.equal((await fetch(invalidCapabilityUrl, {
      method: 'POST',
      headers: { Origin: 'null' },
    })).status, 401);

    const viewedGet = await authenticatedFetch(artifactUrl);
    assert.equal(viewedGet.status, 200);
    const viewedHtml = await viewedGet.text();
    const viewedConfig = JSON.parse(/var config=(\{[^;]+\});/.exec(viewedHtml)?.[1] || 'null');
    assert.deepEqual(viewedConfig.mediaKeys.sort(), [
      `resource:${resourceId}`,
      'video:capability',
    ].sort());

    const registeredHead = await authenticatedFetch(registeredUrl, { method: 'HEAD' });
    assert.equal(registeredHead.status, 200);
    assert.equal(registeredHead.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(registeredHead.headers.get('content-disposition'), 'inline; filename="running.html"');
    assert.equal(registeredHead.headers.get('cache-control'), 'private, no-store');
    assert.match(registeredHead.headers.get('content-security-policy'), /sandbox allow-scripts/);
    assert.equal(await registeredHead.text(), '');
    const registeredGet = await authenticatedFetch(registeredUrl);
    assert.equal(registeredGet.status, 200);
    const registeredPreview = await registeredGet.text();
    assert.match(registeredPreview, /<title>running\.html<\/title>/);
    assert.doesNotMatch(registeredPreview, /<base\b/);
    assert.match(registeredPreview, /<style type="text\/css">#running/);
    assert.match(registeredPreview, /<script>window\.__runningArtifactReady = true;<\/script>/);
    const signedRegisteredLogPath = /<iframe src="([^"]+)">/.exec(registeredPreview)?.[1];
    assert.ok(signedRegisteredLogPath);
    const signedRegisteredLogUrl = new URL(signedRegisteredLogPath, registeredUrl);
    assert.equal(signedRegisteredLogUrl.pathname, new URL(registeredLogUrl).pathname);
    assert.match(
      signedRegisteredLogUrl.searchParams.get('codex_report_resource_access'),
      /^[A-Za-z0-9_-]+$/,
    );
    assert.equal(registeredHead.headers.get('content-length'), String(Buffer.byteLength(registeredPreview)));
    const signedRegisteredVideoPath = /href="([^\"]*resources\/[^\"]*%2Fvideos[^\"]*)"/.exec(registeredPreview)?.[1];
    assert.ok(signedRegisteredVideoPath);
    const signedRegisteredVideoUrl = new URL(signedRegisteredVideoPath, registeredUrl);
    assert.match(signedRegisteredVideoUrl.pathname, /resources\/\.\.%2Fvideos%2Fsample\.mp4$/);
    const registeredVideoResponse = await fetch(signedRegisteredVideoUrl);
    assert.equal(registeredVideoResponse.status, 200);
    assert.equal(await registeredVideoResponse.text(), registeredVideo.toString('utf8'));
    const signedRegisteredPlaylistPath = /href="([^\"]*resources\/[^\"]*%2Fvideos[^\"]*sample\.m3u8[^\"]*)"/.exec(registeredPreview)?.[1];
    assert.ok(signedRegisteredPlaylistPath);
    const signedRegisteredPlaylistUrl = new URL(signedRegisteredPlaylistPath, registeredUrl);
    const registeredPlaylistResponse = await fetch(signedRegisteredPlaylistUrl);
    assert.equal(registeredPlaylistResponse.status, 200);
    const servedPlaylist = await registeredPlaylistResponse.text();
    const signedSegmentPath = servedPlaylist.split(/\r?\n/).find((line) => line.includes('/resources/'));
    assert.ok(signedSegmentPath);
    const registeredSegmentResponse = await fetch(new URL(signedSegmentPath, registeredUrl));
    assert.equal(registeredSegmentResponse.status, 200);
    assert.equal(await registeredSegmentResponse.text(), registeredSegment.toString('utf8'));
    const signedRegisteredMpdPath = /href="([^\"]*resources\/[^\"]*%2Fvideos[^\"]*sample\.mpd(?:\?[^\"]*)?)"/.exec(registeredPreview)?.[1];
    assert.ok(signedRegisteredMpdPath);
    const registeredMpdResponse = await fetch(new URL(signedRegisteredMpdPath, registeredUrl));
    assert.equal(registeredMpdResponse.status, 200);
    const servedMpd = await registeredMpdResponse.text();
    assert.doesNotMatch(servedMpd, /\$RepresentationID\$|\$Number%06d\$/);
    const servedMpdInit = /initialization="([^\"]+)"/.exec(servedMpd)?.[1];
    const servedMpdMedia = /media="([^\"]+)"/.exec(servedMpd)?.[1];
    assert.ok(servedMpdInit);
    assert.ok(servedMpdMedia);
    const concreteMpdInit = servedMpdInit.replace(/%24RepresentationID%24/g, '0');
    assert.equal(
      await (await authenticatedFetch(new URL(concreteMpdInit, registeredUrl))).text(),
      registeredMpdInit.toString('utf8'),
    );
    const concreteMpdMedia = servedMpdMedia
      .replace(/%24RepresentationID%24/g, '0')
      .replace(/%24Number%2506d%24/g, '000001');
    assert.equal(
      await (await authenticatedFetch(new URL(concreteMpdMedia, registeredUrl))).text(),
      registeredMpdSegment.toString('utf8'),
    );
    const signedRegisteredImagePath = new RegExp(
      `${new URL(registeredUrl).pathname}/resources/assets/extra\\.png\\?codex_report_resource_access=[A-Za-z0-9_-]+`,
    ).exec(registeredPreview)?.[0];
    assert.ok(signedRegisteredImagePath);
    const registeredImageResponse = await fetch(new URL(signedRegisteredImagePath, registeredUrl));
    assert.equal(registeredImageResponse.status, 200);
    assert.equal(registeredImageResponse.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await registeredImageResponse.arrayBuffer()), registeredImage);
    const signedRegisteredBmpPath = new RegExp(
      `${new URL(registeredUrl).pathname}/resources/assets/extra\\.bmp\\?codex_report_resource_access=[A-Za-z0-9_-]+`,
    ).exec(registeredPreview)?.[0];
    assert.ok(signedRegisteredBmpPath);
    const registeredBmpResponse = await fetch(new URL(signedRegisteredBmpPath, registeredUrl));
    assert.equal(registeredBmpResponse.status, 200);
    assert.equal(registeredBmpResponse.headers.get('content-type'), 'image/bmp');
    const registeredFlvResponse = await authenticatedFetch(registeredFlvUrl);
    assert.equal(registeredFlvResponse.status, 200);
    assert.equal(registeredFlvResponse.headers.get('content-type'), 'video/x-flv');
    assert.deepEqual(Buffer.from(await registeredFlvResponse.arrayBuffer()), registeredFlv);
    const registeredStyle = await authenticatedFetch(registeredStyleUrl);
    assert.equal(registeredStyle.status, 200);
    assert.equal(registeredStyle.headers.get('content-type'), 'text/css; charset=utf-8');
    assert.equal(await registeredStyle.text(), '#running { color: rgb(1, 2, 3); }');
    const registeredScript = await authenticatedFetch(registeredScriptUrl);
    assert.equal(registeredScript.status, 200);
    assert.equal(registeredScript.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(await registeredScript.text(), 'window.__runningArtifactReady = true;');
    assert.equal((await fetch(registeredLogUrl)).status, 401);
    const registeredLogResponse = await fetch(signedRegisteredLogUrl);
    assert.equal(registeredLogResponse.status, 200);
    assert.equal(await registeredLogResponse.text(), registeredLog);
    const mismatchedRegisteredLogUrl = new URL(`${registeredLogUrl}.other`);
    mismatchedRegisteredLogUrl.search = signedRegisteredLogUrl.search;
    assert.equal((await fetch(mismatchedRegisteredLogUrl)).status, 401);
    assert.equal((await authenticatedFetch(missingRegisteredUrl)).status, 404);
    assert.equal((await authenticatedFetch(unknownRegisteredUrl)).status, 404);

    const markdownHead = await authenticatedFetch(markdownUrl, { method: 'HEAD' });
    assert.equal(markdownHead.status, 200);
    assert.equal(markdownHead.headers.get('content-type'), 'text/markdown; charset=utf-8');
    assert.equal(markdownHead.headers.get('content-disposition'), 'inline; filename="failure-analysis.md"');
    assert.doesNotMatch(markdownHead.headers.get('content-security-policy'), /sandbox/);
    const markdownGet = await authenticatedFetch(markdownUrl);
    assert.equal(markdownGet.status, 200);
    assert.equal(await markdownGet.text(), markdown);

    assert.equal((await fetch(resourceUrl)).status, 401);
    const resourceHead = await fetch(signedResourceUrl, { method: 'HEAD' });
    assert.equal(resourceHead.status, 200);
    assert.equal(resourceHead.headers.get('x-frame-options'), null);
    assert.match(resourceHead.headers.get('content-security-policy'), /sandbox allow-scripts/);
    assert.match(resourceHead.headers.get('content-security-policy'), /style-src 'self' 'unsafe-inline'/);
    assert.equal(resourceHead.headers.get('accept-ranges'), 'bytes');
    assert.equal(resourceHead.headers.get('content-length'), String(media.length));
    assert.equal(resourceHead.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(resourceHead.headers.get('content-disposition'), 'inline; filename="sample.html"');

    const partial = await fetch(signedResourceUrl, {
      headers: { Range: 'bytes=2-5' },
    });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-range'), `bytes 2-5/${media.length}`);
    assert.equal(partial.headers.get('content-length'), '4');
    assert.equal(await partial.text(), media.subarray(2, 6).toString('utf8'));

    const suffix = await fetch(signedResourceUrl, {
      headers: { Range: 'bytes=-3' },
    });
    assert.equal(suffix.status, 206);
    assert.equal(await suffix.text(), media.subarray(-3).toString('utf8'));

    const unsatisfied = await fetch(signedResourceUrl, {
      headers: { Range: 'bytes=99-100' },
    });
    assert.equal(unsatisfied.status, 416);
    assert.equal(unsatisfied.headers.get('content-range'), `bytes */${media.length}`);
    const unrelatedApiUrl = new URL('/api/health', artifactUrl);
    unrelatedApiUrl.search = signedResourceUrl.search;
    const unauthorizedApi = await fetch(unrelatedApiUrl);
    assert.equal(unauthorizedApi.status, 401);
    const mismatchedResourceUrl = new URL(`${resourceUrl}-other`);
    mismatchedResourceUrl.search = signedResourceUrl.search;
    assert.equal((await fetch(mismatchedResourceUrl)).status, 401);
  } finally {
    await stop(child);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
