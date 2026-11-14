(() => {
  const AUTH_STORAGE_KEY = 'codex-tasks-auth-v1';

  function readCredentials() {
    try {
      const parsed = JSON.parse(sessionStorage.getItem(AUTH_STORAGE_KEY) || 'null');
      return parsed?.user && parsed?.pass ? parsed : null;
    } catch {
      return null;
    }
  }

  function storeCredentials(user, pass) {
    sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ user, pass }));
  }

  function clearCredentials() {
    sessionStorage.removeItem(AUTH_STORAGE_KEY);
  }

  async function probe() {
    const response = await fetch('/api/auth/session', { credentials: 'same-origin' });
    let payload = {};
    try { payload = await response.json(); } catch {}
    return {
      required: response.headers.get('x-codex-auth-required') === '1',
      authenticated: response.ok && payload.ok === true,
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

  function redirectToApplication() {
    globalThis.location.replace('/index.html');
  }

  async function initialize() {
    const state = await probe();
    if (!state.required || state.authenticated) {
      redirectToApplication();
      return;
    }
    const stored = readCredentials();
    if (!stored) return;
    try {
      await login(stored.user, stored.pass);
      redirectToApplication();
    } catch {
      clearCredentials();
    }
  }

  const form = document.getElementById('loginForm');
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const user = document.getElementById('loginUser').value.trim();
    const pass = document.getElementById('loginPass').value;
    const submit = form.querySelector('button[type="submit"]');
    const error = document.getElementById('loginError');
    if (!user || !pass) return;
    if (submit) submit.disabled = true;
    if (error) error.textContent = '';
    storeCredentials(user, pass);
    try {
      await login(user, pass);
      redirectToApplication();
    } catch (reason) {
      clearCredentials();
      if (error) error.textContent = reason.message || 'Authentication failed';
    } finally {
      if (submit) submit.disabled = false;
    }
  });

  initialize().catch((error) => {
    const target = document.getElementById('loginError');
    if (target) target.textContent = error.message || 'Unable to initialize login';
  });
})();
