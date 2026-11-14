// Keep the application bundle behind the server's authentication boundary.
// This small bootstrap is intentionally public so an unauthenticated browser
// can show the existing login form without exposing task functionality.
(() => {
  const AUTH_STORAGE_KEY = 'codex-tasks-auth-v1';
  const PROTECTED_SCRIPTS = [
    '/vendor/xterm/xterm.js',
    '/vendor/xterm/addon-fit.js',
    '/report-cards.js',
    '/app.js',
  ];
  let applicationLoaded = false;

  globalThis.__CODEX_AUTH_BOOT__ = true;

  function credentials() {
    try {
      const raw = sessionStorage.getItem(AUTH_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed?.user && parsed?.pass ? parsed : null;
    } catch {
      return null;
    }
  }

  function setCredentials(user, pass) {
    sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ user, pass }));
  }

  function clearCredentials() {
    sessionStorage.removeItem(AUTH_STORAGE_KEY);
  }

  function basicHeader(auth) {
    return auth ? `Basic ${btoa(`${auth.user}:${auth.pass}`)}` : '';
  }

  function showLogin(message = '') {
    const overlay = document.getElementById('authOverlay');
    overlay?.classList.remove('hidden');
    const error = document.getElementById('authError');
    if (error) error.textContent = message;
    const user = document.getElementById('authUser');
    if (user && !user.value) setTimeout(() => user.focus(), 50);
  }

  function hideLogin() {
    document.getElementById('authOverlay')?.classList.add('hidden');
  }

  async function sessionProbe(auth = null) {
    const headers = {};
    const authorization = basicHeader(auth);
    if (authorization) headers.Authorization = authorization;
    const response = await fetch('/api/auth/session', {
      credentials: 'same-origin',
      headers,
    });
    let payload = {};
    try { payload = await response.json(); } catch {}
    return {
      authenticated: response.ok && payload.ok === true,
      required: response.headers.get('x-codex-auth-required') === '1',
    };
  }

  async function login(user, pass) {
    const response = await fetch('/api/auth/session', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Authorization: `Basic ${btoa(`${user}:${pass}`)}` },
    });
    if (!response.ok) {
      let payload = {};
      try { payload = await response.json(); } catch {}
      throw new Error(payload.error || 'Authentication failed');
    }
  }

  function loadScript(source) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = source;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Unable to load ${source}`));
      document.body.appendChild(script);
    });
  }

  async function loadApplication() {
    hideLogin();
    if (applicationLoaded) {
      await globalThis.__CODEX_REAUTH__?.();
      return;
    }
    for (const source of PROTECTED_SCRIPTS) await loadScript(source);
    applicationLoaded = true;
  }

  function bindLogin() {
    const form = document.getElementById('authForm');
    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const user = document.getElementById('authUser')?.value.trim() || '';
      const pass = document.getElementById('authPass')?.value || '';
      const submit = form.querySelector('button[type="submit"]');
      if (!user || !pass) return;
      if (submit) submit.disabled = true;
      setCredentials(user, pass);
      try {
        await login(user, pass);
        document.getElementById('authPass').value = '';
        await loadApplication();
      } catch (error) {
        clearCredentials();
        showLogin(error.message || 'Authentication failed');
      } finally {
        if (submit) submit.disabled = false;
      }
    });
  }

  async function bootstrap() {
    bindLogin();
    const stored = credentials();
    const probe = await sessionProbe(stored);
    if (!probe.required || probe.authenticated) {
      await loadApplication();
      return;
    }
    if (stored) {
      try {
        await login(stored.user, stored.pass);
        await loadApplication();
        return;
      } catch {
        clearCredentials();
      }
    }
    showLogin();
  }

  bootstrap().catch((error) => showLogin(error.message || 'Unable to initialize application'));
})();
