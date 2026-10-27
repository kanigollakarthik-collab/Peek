import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { LlmRouter } from './llm/router.js';
import { factsTask, factsBatchTask, askTask, askBatchTask } from './llm/prompts.js';
import { createCache, normalizeQuestion } from './cache.js';
import { createStore, DuplicateError } from './store.js';
import {
  authMiddleware,
  checkPassword,
  createAttemptLimiter,
  hashPassword,
  InputError,
  signToken,
  validateCredentials,
} from './auth.js';
import { Batcher } from './batcher.js';

if (!config.auth.jwtSecret || config.auth.jwtSecret.length < 32) {
  console.error('JWT_SECRET must be set to a random string of at least 32 characters (see server/.env.example)');
  process.exit(1);
}

const router = new LlmRouter(config.providers, config.llm);
const cache = await createCache({ mongoUri: config.mongoUri, ttlHours: config.cacheTtlHours });
const store = await createStore({ useMongo: cache.kind === 'mongodb' });
const { requireUser, requireAdmin } = authMiddleware({ store, auth: config.auth });
const loginAttempts = createAttemptLimiter({ max: 10, windowMs: 15 * 60_000 });

// Recent requests for the dashboard (in memory only).
const recent = [];
const log = (entry) => {
  recent.unshift({ t: Date.now(), ...entry });
  if (recent.length > 300) recent.pop();
};

// Products arriving within 150 ms share one LLM call, up to BATCH_SIZE per
// call (default 1: one product per call, the most reliable).
const BATCH = { maxSize: config.batchSize, waitMs: config.batchSize > 1 ? 150 : 0 };

// Sent when every key stayed busy for the whole wait; the extension retries.
const BUSY = { error: 'All AI keys are busy', retry: true };
const OVER_LIMIT = { error: 'Hourly limit reached, try again later', limit: true };

// Each user may trigger a limited number of uncached AI answers per hour, so
// one account can't burn through the shared free-tier keys. Cached answers
// are free. Admins are not limited.
const usage = new Map(); // userId -> { hour, count }
function takeQuota(user) {
  if (user.role === 'admin') return true;
  const hour = Math.floor(Date.now() / 3_600_000);
  let u = usage.get(user.id);
  if (!u || u.hour !== hour) u = { hour, count: 0 };
  if (u.count >= config.auth.userHourlyLimit) return false;
  u.count++;
  usage.set(user.id, u);
  return true;
}

// One call for the whole group; any product the model skipped gets one retry
// on its own, so a partial reply never leaves a card empty.
async function runGrouped(items, batchTask, singleTask) {
  if (items.length === 1) return [await router.run(singleTask(items[0]))];
  let r;
  try {
    r = await router.run(batchTask(items));
  } catch (err) {
    return items.map(() => err);
  }
  return Promise.all(
    items.map(async (item, i) => {
      if (r.value[i]) return { ...r, value: r.value[i] };
      try {
        return await router.run(singleTask(item));
      } catch (err) {
        return err;
      }
    }),
  );
}

const extractBatcher = new Batcher({
  ...BATCH,
  runBatch: (products) => runGrouped(products, factsBatchTask, factsTask),
});

// One batcher per question, since a batched call answers a single question.
const askBatchers = new Map();
function askOne(question, product) {
  const key = normalizeQuestion(question);
  let batcher = askBatchers.get(key);
  if (!batcher) {
    batcher = new Batcher({
      ...BATCH,
      runBatch: (products) =>
        runGrouped(products, (group) => askBatchTask(question, group), (p) => askTask(question, p)),
    });
    askBatchers.set(key, batcher);
    if (askBatchers.size > 50) {
      for (const [k, b] of askBatchers) {
        if (!b.queue.length && k !== key) {
          askBatchers.delete(k);
          break;
        }
      }
    }
  }
  return batcher.add(product);
}

// Coalesce concurrent extractions of the same ASIN into one LLM call.
const pendingExtract = new Map();

async function extractOne(p) {
  if (pendingExtract.has(p.asin)) return pendingExtract.get(p.asin);
  const job = (async () => {
    const r = await extractBatcher.add(p);
    await cache.putProduct({
      _id: p.asin,
      title: p.title,
      text: p.text,
      rules: p.rules || null,
      facts: r.value,
      provider: r.slot,
    });
    return r;
  })();
  pendingExtract.set(p.asin, job);
  try {
    return await job;
  } finally {
    pendingExtract.delete(p.asin);
  }
}

// Writes one JSON object per line and flushes, so the extension can paint
// each product card the moment its answer is ready.
function ndjson(res) {
  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.flushHeaders();
  return (obj) => res.write(JSON.stringify(obj) + '\n');
}

// Wraps async route handlers so a thrown error reaches the error handler.
const route = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const app = express();
app.set('trust proxy', 1); // behind Caddy: req.ip is the real client address
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    providers: router.size,
    cache: cache.kind,
    signup: config.auth.signupCode ? 'code' : 'open',
  });
});

// ---------- accounts ----------

const authResponse = (user) => ({ token: signToken(user, config.auth), user });

app.post(
  '/api/auth/register',
  route(async (req, res) => {
    const { email, password } = validateCredentials(req.body);
    if (config.auth.signupCode && req.body?.code !== config.auth.signupCode) {
      return res.status(403).json({ error: 'Invalid signup code' });
    }
    const role = config.auth.adminEmails.includes(email) ? 'admin' : 'user';
    try {
      const user = await store.createUser({ email, passwordHash: await hashPassword(password), role });
      res.status(201).json(authResponse(user));
    } catch (err) {
      if (err instanceof DuplicateError) {
        return res.status(409).json({ error: 'An account with this email already exists. Sign in instead.' });
      }
      throw err;
    }
  }),
);

app.post(
  '/api/auth/login',
  route(async (req, res) => {
    const { email, password } = validateCredentials(req.body);
    const key = `${req.ip}|${email}`;
    if (loginAttempts.blocked(key)) {
      return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
    }
    const row = await store.findUserByEmail(email);
    // Same message for unknown email and wrong password: don't reveal which.
    if (!row || !(await checkPassword(password, row.passwordHash))) {
      loginAttempts.fail(key);
      return res.status(401).json({ error: 'Wrong email or password' });
    }
    loginAttempts.reset(key);
    await store.touchLogin(row._id);
    const role = config.auth.adminEmails.includes(email) ? 'admin' : row.role;
    res.json(authResponse({ id: String(row._id), email: row.email, role }));
  }),
);

app.get('/api/auth/me', requireUser, (req, res) => res.json({ user: req.user }));

// ---------- the user's question history ----------

app.get(
  '/api/me/questions',
  requireUser,
  route(async (req, res) => res.json({ questions: await store.listQuestions(req.user.id) })),
);

app.delete(
  '/api/me/questions',
  requireUser,
  route(async (req, res) => res.json({ deleted: await store.clearQuestions(req.user.id) })),
);

// ---------- product answers ----------

const validAsins = (list) =>
  (Array.isArray(list) ? list : []).filter((a) => typeof a === 'string' && /^[A-Z0-9]{10}$/.test(a));

// Which of these products are already cached? Lets the extension skip
// fetching Amazon pages entirely for known items.
app.post(
  '/api/lookup',
  requireUser,
  route(async (req, res) => {
    const asins = validAsins(req.body?.asins).slice(0, 60);
    const hits = await cache.getProducts(asins);
    const out = {};
    for (const [asin, row] of hits) out[asin] = { facts: row.facts, rules: row.rules, provider: row.provider };
    log({ route: 'lookup', n: asins.length, hits: hits.size });
    res.json({ hits: out });
  }),
);

app.post(
  '/api/extract',
  requireUser,
  route(async (req, res) => {
    const products = (Array.isArray(req.body?.products) ? req.body.products : [])
      .filter((p) => validAsins([p?.asin]).length && typeof p.text === 'string')
      .map((p) => ({ ...p, title: String(p.title || '').slice(0, 300), text: p.text.slice(0, 8000) }))
      .slice(0, 40);
    const send = ndjson(res);
    const cached = await cache.getProducts(products.map((p) => p.asin));

    await Promise.all(
      products.map(async (p) => {
        const t0 = Date.now();
        const hit = cached.get(p.asin);
        if (hit?.facts) {
          send({ asin: p.asin, facts: hit.facts, cached: true, ms: 0 });
          log({ route: 'extract', asin: p.asin, cached: true, ms: 0, ok: true });
          return;
        }
        if (!takeQuota(req.user)) {
          send({ asin: p.asin, ...OVER_LIMIT });
          return;
        }
        try {
          const r = await extractOne(p);
          send({ asin: p.asin, facts: r.value, provider: r.slot, ms: Date.now() - t0 });
          log({ route: 'extract', asin: p.asin, provider: r.slot, attempts: r.attempts, ms: Date.now() - t0, ok: true });
        } catch (err) {
          send({ asin: p.asin, ...BUSY });
          log({ route: 'extract', asin: p.asin, ms: Date.now() - t0, ok: false, error: err.message.slice(0, 300) });
        }
      }),
    );
    res.end();
  }),
);

app.post(
  '/api/ask',
  requireUser,
  route(async (req, res) => {
    const question = String(req.body?.question || '').trim().slice(0, 200);
    if (question.length < 3) return res.status(400).json({ error: 'Type a question of at least 3 characters' });
    const products = (Array.isArray(req.body?.products) ? req.body.products : [])
      .filter((p) => validAsins([p?.asin]).length)
      .slice(0, 40);
    store.recordQuestion(req.user.id, normalizeQuestion(question), question).catch((err) => {
      console.warn('could not save question history:', err.message);
    });
    const send = ndjson(res);
    const stored = await cache.getProducts(products.map((p) => p.asin));

    await Promise.all(
      products.map(async (p) => {
        const t0 = Date.now();
        try {
          const hit = await cache.getAnswer(p.asin, question);
          if (hit) {
            send({ asin: p.asin, answer: hit.answer, evidence: hit.evidence, cached: true, ms: Date.now() - t0 });
            log({ route: 'ask', asin: p.asin, cached: true, ms: Date.now() - t0, ok: true });
            return;
          }
          const row = stored.get(p.asin);
          const product = {
            title: String(p.title || row?.title || '').slice(0, 300),
            text: String(p.text || row?.text || '').slice(0, 8000),
          };
          if (!product.text) {
            send({ asin: p.asin, error: 'Product page not loaded yet', retry: true });
            return;
          }
          if (!takeQuota(req.user)) {
            send({ asin: p.asin, ...OVER_LIMIT });
            return;
          }
          const r = await askOne(question, product);
          await cache.putAnswer(p.asin, question, { ...r.value, provider: r.slot });
          send({ asin: p.asin, ...r.value, provider: r.slot, ms: Date.now() - t0 });
          log({ route: 'ask', asin: p.asin, provider: r.slot, attempts: r.attempts, ms: Date.now() - t0, ok: true });
        } catch (err) {
          send({ asin: p.asin, ...BUSY });
          log({ route: 'ask', asin: p.asin, ms: Date.now() - t0, ok: false, error: err.message.slice(0, 300) });
        }
      }),
    );
    res.end();
  }),
);

// ---------- admin: stats for the dev dashboard ----------

const percentile = (arr, q) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

app.get(
  '/api/stats',
  requireAdmin,
  route(async (_req, res) => {
    const llmMs = recent.filter((r) => r.ok && !r.cached && r.ms != null && r.route !== 'lookup').map((r) => r.ms);
    const done = recent.filter((r) => r.route !== 'lookup');
    res.json({
      uptimeS: Math.round(process.uptime()),
      users: await store.countUsers(),
      cache: { kind: cache.kind, ...(await cache.count()) },
      providers: router.snapshot(),
      latency: { p50: percentile(llmMs, 0.5), p95: percentile(llmMs, 0.95), n: llmMs.length },
      hitRate: done.length ? done.filter((r) => r.cached).length / done.length : null,
      recent: recent.slice(0, 100),
    });
  }),
);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// Serve the built React dashboard if present.
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../../dashboard/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// Errors always come back as JSON with a readable message.
app.use((err, _req, res, _next) => {
  if (err instanceof InputError) return res.status(400).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
  console.error(err);
  if (res.headersSent) return res.end();
  res.status(500).json({ error: 'Something went wrong on the server' });
});

app.listen(config.port, config.host, () => {
  console.log(
    `peek server on ${config.host}:${config.port} | cache=${cache.kind} | llm slots=${router.size} | batch=${config.batchSize}`,
  );
  for (const s of router.snapshot()) {
    console.log(`  ${s.id.padEnd(36)} prio ${s.priority}  ${s.rpm}/min  ${s.rpd}/day`);
  }
  if (!router.size) console.warn('  no LLM keys configured: fill server/.env');
  if (cache.kind === 'memory') console.warn('  no MONGODB_URI: accounts and cache are lost on restart');
});
