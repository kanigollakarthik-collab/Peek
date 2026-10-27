// Free providers rename and retire models often. This sends a tiny request to
// every configured key/model in .env and, when one fails, lists the models
// that key can actually use so you can update the *_MODEL line.
// Run from server/:  npm run check:models
import { config } from '../src/config.js';

const ENV_NAME = {
  groq: 'GROQ_MODEL',
  cerebras: 'CEREBRAS_MODEL',
  gemini: 'GEMINI_MODEL',
  sambanova: 'SAMBANOVA_MODEL',
  mistral: 'MISTRAL_MODEL',
  cloudflare: 'CLOUDFLARE_MODEL',
  nvidia: 'NVIDIA_MODEL',
  github: 'GITHUB_MODELS_MODEL',
  openrouter: 'OPENROUTER_MODEL',
};

// Small, fast models suit this job best, so list those first.
const FAST = /(instant|flash|lite|mini|small|nano|haiku|scout|[1-9]b\b|1[0-9]b\b)/i;

async function tryChat(p, key) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${p.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: p.model,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        max_tokens: 5,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    return { status: res.status, ms: Date.now() - t0, text: text.slice(0, 160).replace(/\s+/g, ' ') };
  } catch (err) {
    return { status: 0, ms: Date.now() - t0, text: err.name === 'TimeoutError' ? 'timeout' : err.message };
  }
}

async function listModels(p, key) {
  try {
    const res = await fetch(`${p.baseUrl}/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const data = await res.json();
    let ids = (data.data || data.models || []).map((m) => String(m.id || m.name || '').replace(/^models\//, ''));
    ids = ids.filter(Boolean);
    if (p.id === 'openrouter') ids = ids.filter((id) => id.endsWith(':free'));
    if (p.id === 'gemini') ids = ids.filter((id) => id.startsWith('gemini'));
    ids.sort((a, b) => Number(FAST.test(b)) - Number(FAST.test(a)) || a.localeCompare(b));
    return { ids };
  } catch (err) {
    return { error: err.message };
  }
}

if (!config.providers.length) {
  console.log('No providers configured: add keys to server/.env first.');
  process.exit(1);
}

let broken = 0;
for (const p of config.providers) {
  console.log(`\n${p.id}  (${ENV_NAME[p.id]}=${p.model})`);
  let needsList = null;
  for (const [i, key] of p.keys.entries()) {
    const r = await tryChat(p, key);
    const label = `  key #${i + 1} …${key.slice(-4)}`;
    if (r.status === 200) {
      console.log(`${label}  OK  ${r.ms} ms`);
    } else if (r.status === 429) {
      console.log(`${label}  RATE LIMITED (key and model work, just slow down)  ${r.text}`);
    } else {
      broken++;
      console.log(`${label}  FAIL ${r.status || ''}  ${r.text}`);
      if ([400, 404, 410].includes(r.status)) needsList ??= key;
    }
  }
  if (needsList) {
    const { ids, error } = await listModels(p, needsList);
    if (error) {
      console.log(`  could not list models: ${error}`);
    } else if (!ids.length) {
      console.log('  this key has no usable models listed');
    } else {
      console.log(`  models this key can use (fast ones first, ${ids.length} total):`);
      for (const id of ids.slice(0, 12)) console.log(`    ${id}`);
      console.log(`  -> set ${ENV_NAME[p.id]}=<one of these> in server/.env`);
    }
  }
}

console.log(
  broken
    ? `\n${broken} key(s) failing. 401/403 = bad key, 402 = no free credit, 404/410 = pick a model from the list above.` +
        '\nEdit server/.env, rerun this, then: pm2 restart peek'
    : '\nAll keys working.',
);
