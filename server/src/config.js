import 'dotenv/config';

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

// Every provider here speaks the OpenAI chat-completions format, so one adapter
// covers the whole tree. rpm/rpd are conservative guesses of each free tier;
// the router also learns from 429s, so being slightly off is fine.
const providerDefs = [
  {
    id: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keys: list(process.env.GROQ_API_KEYS),
    model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
    priority: 1, rpm: 30, rpd: 14000, maxInflight: 6, jsonMode: true,
  },
  {
    id: 'cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    keys: list(process.env.CEREBRAS_API_KEYS),
    model: process.env.CEREBRAS_MODEL || 'llama3.1-8b',
    priority: 1, rpm: 30, rpd: 14000, maxInflight: 6, jsonMode: true,
  },
  {
    id: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keys: list(process.env.GEMINI_API_KEYS),
    model: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
    priority: 2, rpm: 15, rpd: 1000, maxInflight: 5, jsonMode: true,
  },
  {
    id: 'sambanova',
    baseUrl: 'https://api.sambanova.ai/v1',
    keys: list(process.env.SAMBANOVA_API_KEYS),
    model: process.env.SAMBANOVA_MODEL || 'Meta-Llama-3.1-8B-Instruct',
    priority: 2, rpm: 20, rpd: 5000, maxInflight: 4, jsonMode: false,
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
    model: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
    priority: 5, rpm: 20, rpd: 50, maxInflight: 2, jsonMode: false,
  },
];

// Reasoning models "think" before answering and that thinking counts against
// max_tokens; for short extraction work, ask them to keep it brief.
export function defaultExtraBody(model) {
  if (/gpt-oss/i.test(model)) return { reasoning_effort: 'low' };
  return {};
}

// <PROVIDER>_EXTRA_BODY in .env (JSON) overrides the extra request fields,
// e.g. GROQ_EXTRA_BODY={"reasoning_effort":"low"}
function extraBodyFor(p) {
  const name = `${p.id.toUpperCase()}_EXTRA_BODY`;
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
  clientToken: process.env.CLIENT_TOKEN || '',
  mongoUri: process.env.MONGODB_URI || '',
  cacheTtlHours: num(process.env.CACHE_TTL_HOURS, 48),
  llm: {
    timeoutMs: num(process.env.LLM_TIMEOUT_MS, 4000),
    hedgeMs: num(process.env.LLM_HEDGE_MS, 1500),
    maxAttempts: num(process.env.LLM_MAX_ATTEMPTS, 4),
  },
  providers: providerDefs
    .filter((p) => p.baseUrl && p.keys.length > 0)
    .map((p) => ({ ...p, extraBody: extraBodyFor(p) })),
};
