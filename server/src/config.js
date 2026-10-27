import 'dotenv/config';

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

// Every provider here speaks the OpenAI chat-completions format, so one adapter
// covers the whole tree. rpm/rpd are conservative guesses of each free tier;
// the router also learns from 429s, so being slightly off is fine.
// Lower priority numbers are tried first.
const providerDefs = [
  {
    id: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keys: list(process.env.GROQ_API_KEYS),
    model: process.env.GROQ_MODEL || 'openai/gpt-oss-20b',
    // Groq's free tier also caps tokens per minute (8000 for gpt-oss-20b).
    priority: 2, rpm: 30, rpd: 14000, tpm: 8000, maxInflight: 6, jsonMode: true,
  },
  {
    id: 'cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    keys: list(process.env.CEREBRAS_API_KEYS),
    model: process.env.CEREBRAS_MODEL || 'llama3.1-8b',
    priority: 2, rpm: 30, rpd: 14000, maxInflight: 6, jsonMode: true,
  },
  {
    id: 'sambanova',
    baseUrl: 'https://api.sambanova.ai/v1',
    keys: list(process.env.SAMBANOVA_API_KEYS),
    model: process.env.SAMBANOVA_MODEL || 'Meta-Llama-3.3-70B-Instruct',
    priority: 3, rpm: 20, rpd: 5000, maxInflight: 4, jsonMode: false,
  },
  {
    id: 'mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    keys: list(process.env.MISTRAL_API_KEYS),
    model: process.env.MISTRAL_MODEL || 'mistral-small-latest',
    priority: 3, rpm: 60, rpd: 50000, maxInflight: 1, jsonMode: true,
  },
  {
    id: 'cloudflare',
    baseUrl: process.env.CLOUDFLARE_ACCOUNT_ID
      ? `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`
      : '',
    keys: process.env.CLOUDFLARE_ACCOUNT_ID ? list(process.env.CLOUDFLARE_API_TOKENS) : [],
    model: process.env.CLOUDFLARE_MODEL || '@cf/meta/llama-3.1-8b-instruct-fast',
    priority: 3, rpm: 60, rpd: 3000, maxInflight: 4, jsonMode: false,
  },
  {
    id: 'nvidia',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    keys: list(process.env.NVIDIA_API_KEYS),
    model: process.env.NVIDIA_MODEL || 'meta/llama-3.1-8b-instruct',
    priority: 3, rpm: 40, rpd: 5000, maxInflight: 4, jsonMode: false,
  },
  {
    id: 'github',
    baseUrl: 'https://models.github.ai/inference',
    keys: list(process.env.GITHUB_MODELS_TOKENS),
    model: process.env.GITHUB_MODELS_MODEL || 'openai/gpt-4.1-mini',
    priority: 4, rpm: 15, rpd: 150, maxInflight: 2, jsonMode: true,
  },
  {
    id: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keys: list(process.env.OPENROUTER_API_KEYS),
    model: process.env.OPENROUTER_MODEL || 'google/gemma-4-31b-it:free',
    priority: 5, rpm: 20, rpd: 50, maxInflight: 2, jsonMode: false,
  },
];

// Gemini's free tier limits each model separately, per Google Cloud project.
// So every (key, model) pair is its own slot, and adding models multiplies the
// quota. Keys made inside the same project share limits: use one key per project.
// Limits below are from the AI Studio rate-limit page (Oct 2026).
const GEMINI_LIMITS = [
  [/^gemini-3\.5-flash-lite/, { priority: 1, rpm: 15, rpd: 500 }],
  [/^gemini-3\.1-flash-lite/, { priority: 1, rpm: 15, rpd: 500 }],
  // Gemma on the Gemini API has no system prompt or JSON mode, and a low
  // tokens-per-minute cap, but a large daily allowance.
  [/^gemma-4/, { priority: 2, rpm: 30, rpd: 14400, tpm: 16000, jsonMode: false, systemAsUser: true }],
  [/^gemini-2\.5-flash-lite/, { priority: 2, rpm: 10, rpd: 20 }],
  // Full Flash models: only 20 requests a day each, so they are a last resort.
  [/flash/, { priority: 3, rpm: 5, rpd: 20 }],
];
const GEMINI_FALLBACK_LIMITS = { priority: 3, rpm: 5, rpd: 20 };

const DEFAULT_GEMINI_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemma-4-31b-it',
  'gemma-4-26b-a4b-it',
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-3-flash-preview',
].join(',');

const geminiKeys = list(process.env.GEMINI_API_KEYS);
const geminiDefs = list(process.env.GEMINI_MODELS || DEFAULT_GEMINI_MODELS).map((model) => ({
  id: `gemini:${model}`,
  envName: 'GEMINI',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  keys: geminiKeys,
  model,
  maxInflight: 3,
  jsonMode: true,
  ...(GEMINI_LIMITS.find(([re]) => re.test(model))?.[1] ?? GEMINI_FALLBACK_LIMITS),
}));

// Reasoning models "think" before answering and that thinking counts against
// max_tokens; for short extraction work, ask them to keep it brief.
export function defaultExtraBody(model) {
  if (/gpt-oss/i.test(model)) return { reasoning_effort: 'low' };
  // Full Gemini Flash models think by default; Flash Lite and Gemma don't.
  if (/^gemini-.*flash/i.test(model) && !/lite/i.test(model)) return { reasoning_effort: 'low' };
  return {};
}

const envPrefix = (p) => p.envName ?? p.id.toUpperCase();

// <PROVIDER>_EXTRA_BODY in .env (JSON) overrides the extra request fields,
// e.g. GROQ_EXTRA_BODY={"reasoning_effort":"low"}
function extraBodyFor(p) {
  const name = `${envPrefix(p)}_EXTRA_BODY`;
  const raw = process.env[name];
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      console.warn(`ignoring ${name}: not valid JSON`);
    }
  }
  return defaultExtraBody(p.model);
}

export const config = {
  port: num(process.env.PORT, 8080),
  // 127.0.0.1 behind a reverse proxy (Caddy) so only HTTPS reaches the app.
  host: process.env.HOST || '0.0.0.0',
  mongoUri: process.env.MONGODB_URI || '',
  auth: {
    // Signs login tokens. Long random string; the server won't start without it.
    jwtSecret: process.env.JWT_SECRET || '',
    tokenDays: num(process.env.TOKEN_DAYS, 30),
    // Optional: if set, creating an account requires this code.
    signupCode: process.env.SIGNUP_CODE || '',
    // Accounts with these emails get the admin role (stats dashboard).
    adminEmails: list(process.env.ADMIN_EMAILS).map((e) => e.toLowerCase()),
    // Lets the dev dashboard read /api/stats without an account. Never put it
    // in the extension. CLIENT_TOKEN is the old name, still accepted.
    adminToken: process.env.ADMIN_TOKEN || process.env.CLIENT_TOKEN || '',
    // Uncached AI answers each user may request per hour (protects free keys).
    userHourlyLimit: num(process.env.USER_HOURLY_LIMIT, 300),
  },
  cacheTtlHours: num(process.env.CACHE_TTL_HOURS, 48),
  // Products per LLM call. 1 is the most reliable (no chance of the model
  // mixing up products); raise it to stretch per-minute limits further.
  batchSize: Math.max(1, num(process.env.BATCH_SIZE, 1)),
  llm: {
    timeoutMs: num(process.env.LLM_TIMEOUT_MS, 15000),
    hedgeMs: num(process.env.LLM_HEDGE_MS, 6000),
    maxAttempts: num(process.env.LLM_MAX_ATTEMPTS, 8),
    // How long a request may wait for a free key before giving up.
    queueMs: num(process.env.LLM_QUEUE_MS, 60000),
  },
  providers: [...geminiDefs, ...providerDefs]
    .filter((p) => p.baseUrl && p.keys.length > 0)
    .map((p) => ({
      ...p,
      // <PROVIDER>_TPM in .env sets or overrides a tokens-per-minute cap.
      tpm: num(process.env[`${envPrefix(p)}_TPM`], p.tpm ?? 0),
      extraBody: extraBodyFor(p),
    })),
};
