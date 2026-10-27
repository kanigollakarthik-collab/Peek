// Free providers rename and retire models often. This sends a small JSON
// request (like real extraction) to every configured key/model in .env. When a
// model fails, it tries the models that key can list and recommends the
// fastest one that actually answers.
// Run from server/:  npm run check:models
import { config, defaultExtraBody } from '../src/config.js';
import { parseJsonObject } from '../src/llm/prompts.js';

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

// Small, fast models suit this job best, so try those first.
const FAST = /(instant|flash|lite|mini|small|nano|haiku|scout|[1-9]b\b|1[0-9]b\b)/i;
// Listed models that can't do chat at all.
const NOT_CHAT = /(whisper|tts|guard|safety|embed|rerank|image|audio|orpheus|computer-use|vision|coder|codegemma|starcoder|fuyu|parse|ocr)/i;
const PROBE_LIMIT = 8;

const short = (s) => String(s).replace(/\s+/g, ' ').slice(0, 140);

async function tryModel(p, key, model) {
  const t0 = Date.now();
  const body = {
    model,
    messages: [
      { role: 'system', content: 'Reply with one JSON object only: {"ok": true}' },
      { role: 'user', content: 'Health check.' },
    ],
    max_tokens: 800,
    temperature: 0,
    ...(model === p.model ? p.extraBody : defaultExtraBody(model)),
  };
  if (p.jsonMode) body.response_format = { type: 'json_object' };
  try {
    const res = await fetch(`${p.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const ms = Date.now() - t0;
    if (!res.ok) return { status: res.status, ms, text: short(await res.text()) };
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? '';
    try {
      parseJsonObject(content);
      return { status: 200, ms };
    } catch {
      return { status: 'bad-json', ms, text: `replied without JSON: ${short(content) || '(empty)'}` };
    }
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
    ids = ids.filter((id) => id && id !== p.model && !NOT_CHAT.test(id));
    if (p.id === 'openrouter') ids = ids.filter((id) => id.endsWith(':free'));
    if (p.id === 'gemini') ids = ids.filter((id) => id.startsWith('gemini'));
    ids.sort((a, b) => Number(FAST.test(b)) - Number(FAST.test(a)) || a.localeCompare(b));
    return { ids };
  } catch (err) {
    return { error: err.message };
  }
}

async function probe(p, key) {
  const { ids, error } = await listModels(p, key);
  if (error) return console.log(`  could not list models: ${error}`);
  if (!ids.length) return console.log('  this key lists no other chat models');
  console.log(`  trying ${Math.min(PROBE_LIMIT, ids.length)} of ${ids.length} listed chat models:`);
  const working = [];
  for (const id of ids.slice(0, PROBE_LIMIT)) {
    const r = await tryModel(p, key, id);
    if (r.status === 200) {
      working.push({ id, ms: r.ms });
      console.log(`    works   ${String(r.ms).padStart(5)} ms  ${id}`);
    } else if (r.status === 429) {
      console.log(`    busy (rate limited, may work later)  ${id}`);
    } else {
      console.log(`    fails   ${id}  ${r.status} ${r.text}`);
    }
  }
  if (working.length) {
    working.sort((a, b) => a.ms - b.ms);
    console.log(`  -> recommended: ${ENV_NAME[p.id]}=${working[0].id}`);
  } else {
    console.log(`  -> nothing worked; leave this provider's keys empty or try again later`);
  }
}

if (!config.providers.length) {
  console.log('No providers configured: add keys to server/.env first.');
  process.exit(1);
}

let broken = 0;
for (const p of config.providers) {
  const extra = Object.keys(p.extraBody).length ? `  extra=${JSON.stringify(p.extraBody)}` : '';
  console.log(`\n${p.id}  (${ENV_NAME[p.id]}=${p.model})${extra}`);
  let probeKey = null;
  for (const [i, key] of p.keys.entries()) {
    const r = await tryModel(p, key, p.model);
    const label = `  key #${i + 1} …${key.slice(-4)}`;
    if (r.status === 200) {
      console.log(`${label}  OK  ${r.ms} ms`);
    } else if (r.status === 429) {
      console.log(`${label}  RATE LIMITED (key and model work, just slow down)  ${r.text}`);
    } else {
      broken++;
      console.log(`${label}  FAIL ${r.status || ''}  ${r.text}`);
      if ([400, 404, 410, 'bad-json'].includes(r.status)) probeKey ??= key;
    }
  }
  if (probeKey) await probe(p, probeKey);
}

console.log(
  broken
    ? `\n${broken} key(s) failing. 401/403 = bad key, 402 = no free credit, 404/410/bad JSON = use a recommended model.` +
        '\nEdit server/.env, rerun this, then: pm2 restart peek'
    : '\nAll keys working.',
);
