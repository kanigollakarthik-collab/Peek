const $ = (id) => document.getElementById(id);
let mode = 'login'; // or 'register'

// ---------- talking to the server ----------

async function api(path, { method = 'GET', body, auth } = {}) {
  const base = peekServerBase(await peekSettings());
  const headers = { 'content-type': 'application/json' };
  if (auth) headers.authorization = `Bearer ${auth.token}`;
  let res;
  try {
    res = await fetch(base + path, { method, headers, body: body && JSON.stringify(body) });
  } catch {
    throw new Error("Can't reach the Peek server. Check your internet connection, or the server address under Advanced.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Server error (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function showMessage(el, text, kind = 'error') {
  el.textContent = text || '';
  el.className = `message ${text ? kind : ''}`;
}

// ---------- signed out ----------

function setMode(next) {
  mode = next;
  for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('active', tab.dataset.mode === mode);
  $('authSubmit').textContent = mode === 'login' ? 'Sign in' : 'Create account';
  $('password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('passwordHint').hidden = mode === 'login';
  $('codeRow').hidden = !(mode === 'register' && $('codeRow').dataset.required === 'yes');
  showMessage($('authMessage'), '');
}

async function showSignedOut(message) {
  $('signedIn').hidden = true;
  $('signedOut').hidden = false;
  if (message) showMessage($('authMessage'), message);
  $('email').focus();
  // Ask the server whether sign-up needs a code (hidden if it doesn't).
  try {
    const health = await api('/api/health');
    $('codeRow').dataset.required = health.signup === 'code' ? 'yes' : 'no';
    setMode(mode);
    if (message) showMessage($('authMessage'), message);
  } catch (err) {
    showMessage($('authMessage'), err.message);
  }
}

$('authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('email').value.trim();
  const password = $('password').value;
  if (!email || !email.includes('@')) return showMessage($('authMessage'), 'Enter a valid email address');
  if (password.length < 8) return showMessage($('authMessage'), 'Password must be at least 8 characters');

  const button = $('authSubmit');
  button.disabled = true;
  showMessage($('authMessage'), mode === 'login' ? 'Signing in…' : 'Creating your account…', 'ok');
  try {
    const body = { email, password };
    if (mode === 'register' && !$('codeRow').hidden) body.code = $('code').value.trim();
    const data = await api(mode === 'login' ? '/api/auth/login' : '/api/auth/register', { method: 'POST', body });
    await peekSetAuth({ token: data.token, email: data.user.email, role: data.user.role });
    $('password').value = '';
    await showSignedIn();
  } catch (err) {
    showMessage($('authMessage'), err.message);
  } finally {
    button.disabled = false;
  }
});

for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => setMode(tab.dataset.mode));

// ---------- signed in ----------

async function showSignedIn() {
  const auth = await peekAuth();
  $('signedOut').hidden = true;
  $('signedIn').hidden = false;
  $('userEmail').textContent = auth.email;
  await loadQuestions();
}

async function loadQuestions() {
  const auth = await peekAuth();
  const list = $('questions');
  try {
    const { questions } = await api('/api/me/questions', { auth });
    list.replaceChildren(
      ...questions.map((q) => {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.title = 'Ask this on the open Amazon tab';
        btn.textContent = q.question;
        const count = document.createElement('span');
        count.className = 'count';
        count.textContent = q.timesAsked > 1 ? `×${q.timesAsked}` : '';
        btn.append(count);
        btn.addEventListener('click', () => askAgain(q.question));
        li.append(btn);
        return li;
      }),
    );
    $('questionsEmpty').hidden = questions.length > 0;
    $('clearQuestions').hidden = questions.length === 0;
    showMessage($('questionsMessage'), '');
  } catch (err) {
    if (err.status === 401) {
      await peekClearAuth();
      return showSignedOut('Your session expired. Sign in again.');
    }
    showMessage($('questionsMessage'), err.message);
  }
}

async function askAgain(question) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith('https://www.amazon.in/')) {
    return showMessage($('questionsMessage'), 'Open an Amazon.in search page first, then pick a question.');
  }
  await chrome.storage.local.set({ askNow: { question, at: Date.now() } });
  window.close();
}

$('clearQuestions').addEventListener('click', async () => {
  try {
    await api('/api/me/questions', { method: 'DELETE', auth: await peekAuth() });
    await loadQuestions();
  } catch (err) {
    showMessage($('questionsMessage'), err.message);
  }
});

$('signOut').addEventListener('click', async () => {
  await peekClearAuth();
  showSignedOut('Signed out.');
});

// ---------- settings ----------

function renderRun(run) {
  const median = (xs) => {
    const s = xs.filter((x) => x != null).sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : '–';
  };
  const col = (k) => run.rows.map((r) => r[k]);
  const cached = run.rows.filter((r) => r.source === 'cache').length;
  $('lastRun').innerHTML = `
    <div><b>${run.rows.length}</b> products in <b>${(run.totalMs / 1000).toFixed(1)}s</b> (${cached} from cache)</div>
    <table>
      <tr><th>median ms</th><th>fetch</th><th>clean</th><th>AI</th></tr>
      <tr><td></td><td>${median(col('fetchMs'))}</td><td>${median(col('cleanMs'))}</td><td>${median(col('llmMs'))}</td></tr>
    </table>`;
}

async function loadSettings() {
  const s = await peekSettings();
  $('enabled').checked = s.enabled;
  $('serverUrl').value = s.serverUrl;
  $('concurrency').value = s.concurrency;
  $('maxProducts').value = s.maxProducts;
  for (const box of document.querySelectorAll('[data-field]')) box.checked = !!s.fields[box.dataset.field];
  const { lastRun } = await chrome.storage.local.get('lastRun');
  if (lastRun?.rows?.length) renderRun(lastRun);
}

function saveSettings() {
  const fields = {};
  for (const box of document.querySelectorAll('[data-field]')) fields[box.dataset.field] = box.checked;
  return chrome.storage.sync.set({
    enabled: $('enabled').checked,
    serverUrl: $('serverUrl').value.trim() || PEEK_DEFAULTS.serverUrl,
    concurrency: Math.max(1, Math.min(24, Number($('concurrency').value) || 8)),
    maxProducts: Math.max(1, Math.min(60, Number($('maxProducts').value) || 24)),
    fields,
  });
}

for (const el of [$('enabled'), $('serverUrl'), $('concurrency'), $('maxProducts'), ...document.querySelectorAll('[data-field]')]) {
  el.addEventListener('change', saveSettings);
}

$('test').addEventListener('click', async () => {
  await saveSettings();
  const out = $('testResult');
  out.textContent = ' testing…';
  out.className = 'small';
  try {
    const health = await api('/api/health');
    out.textContent = ` connected · ${health.providers} AI slots`;
    out.className = 'small ok';
  } catch (err) {
    out.textContent = ` ${err.message}`;
    out.className = 'small bad';
  }
});

// ---------- start ----------

(async () => {
  await loadSettings();
  const auth = await peekAuth();
  if (!auth) return showSignedOut();
  // Confirm the saved session is still valid before showing the signed-in view.
  try {
    await api('/api/auth/me', { auth });
    await showSignedIn();
  } catch (err) {
    if (err.status === 401) {
      await peekClearAuth();
      return showSignedOut(err.message);
    }
    // Server unreachable: still show the account, with the error.
    await showSignedIn();
    showMessage($('questionsMessage'), err.message);
  }
})();
