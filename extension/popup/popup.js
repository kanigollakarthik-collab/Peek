const $ = (id) => document.getElementById(id);

async function load() {
  const s = await peekSettings();
  $('enabled').checked = s.enabled;
  $('serverUrl').value = s.serverUrl;
  $('token').value = s.token;
  $('concurrency').value = s.concurrency;
  $('maxProducts').value = s.maxProducts;
  for (const box of document.querySelectorAll('[data-field]')) box.checked = !!s.fields[box.dataset.field];

  const { lastRun } = await chrome.storage.local.get('lastRun');
  if (lastRun) renderRun(lastRun);
}

function renderRun(run) {
  const median = (xs) => {
    const s = xs.filter((x) => x != null).sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : '–';
  };
  const col = (k) => run.rows.map((r) => r[k]);
  const cached = run.rows.filter((r) => r.source === 'cache').length;
  $('lastRun').innerHTML = `
    <div><b>${run.rows.length}</b> products in <b>${(run.totalMs / 1000).toFixed(2)}s</b> (${cached} from cache)</div>
    <table>
      <tr><th>median</th><th>fetch</th><th>clean</th><th>LLM</th><th>chars</th></tr>
      <tr><td>ms</td><td>${median(col('fetchMs'))}</td><td>${median(col('cleanMs'))}</td><td>${median(col('llmMs'))}</td><td>${median(col('chars'))}</td></tr>
    </table>`;
}

function save() {
  const fields = {};
  for (const box of document.querySelectorAll('[data-field]')) fields[box.dataset.field] = box.checked;
  chrome.storage.sync.set({
    enabled: $('enabled').checked,
    serverUrl: $('serverUrl').value.trim(),
    token: $('token').value.trim(),
    concurrency: Math.max(1, Math.min(24, Number($('concurrency').value) || 8)),
    maxProducts: Math.max(1, Math.min(60, Number($('maxProducts').value) || 24)),
    fields,
  });
}

document.addEventListener('change', save);

$('test').addEventListener('click', async () => {
  save();
  const out = $('testResult');
  out.textContent = '…';
  out.className = '';
  try {
    const base = $('serverUrl').value.trim().replace(/\/+$/, '');
    const health = await (await fetch(`${base}/api/health`)).json();
    const auth = await fetch(`${base}/api/lookup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': $('token').value.trim() },
      body: JSON.stringify({ asins: [] }),
    });
    if (!auth.ok) throw new Error('token rejected');
    out.textContent = ` ok · ${health.providers} LLM keys · ${health.cache} cache`;
    out.className = 'ok';
  } catch (err) {
    out.textContent = ` ${err.message}`;
    out.className = 'bad';
  }
});

load();
