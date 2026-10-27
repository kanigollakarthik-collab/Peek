import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { LlmRouter } from './llm/router.js';
import { factsTask, factsBatchTask, askTask, askBatchTask } from './llm/prompts.js';
import { createCache, normalizeQuestion } from './cache.js';
import { Batcher } from './batcher.js';

const router = new LlmRouter(config.providers, config.llm);
const cache = await createCache({ mongoUri: config.mongoUri, ttlHours: config.cacheTtlHours });

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

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, providers: router.size, cache: cache.kind });
});

app.use('/api', (req, res, next) => {
  if (config.clientToken && req.get('x-api-key') !== config.clientToken) {
    return res.status(401).json({ error: 'bad x-api-key' });
  }
  next();
});

const validAsins = (list) =>
  (Array.isArray(list) ? list : []).filter((a) => typeof a === 'string' && /^[A-Z0-9]{10}$/.test(a));

// Which of these products are already cached? Lets the extension skip
// fetching Amazon pages entirely for known items.
app.post('/api/lookup', async (req, res) => {
  const asins = validAsins(req.body?.asins).slice(0, 60);
  const hits = await cache.getProducts(asins);
  const out = {};
  for (const [asin, row] of hits) out[asin] = { facts: row.facts, rules: row.rules, provider: row.provider };
  log({ route: 'lookup', n: asins.length, hits: hits.size });
  res.json({ hits: out });
});

app.post('/api/extract', async (req, res) => {
  const products = (req.body?.products || [])
    .filter((p) => validAsins([p?.asin]).length && typeof p.text === 'string')
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
});

app.post('/api/ask', async (req, res) => {
  const question = String(req.body?.question || '').trim().slice(0, 200);
  if (!question) return res.status(400).json({ error: 'question required' });
  const products = (req.body?.products || []).filter((p) => validAsins([p?.asin]).length).slice(0, 40);
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
        const product = { title: p.title || row?.title, text: p.text || row?.text };
        if (!product.text) {
          send({ asin: p.asin, error: 'product not loaded yet' });
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
});

const percentile = (arr, q) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

app.get('/api/stats', async (_req, res) => {
  const llmMs = recent.filter((r) => r.ok && !r.cached && r.ms != null && r.route !== 'lookup').map((r) => r.ms);
  const done = recent.filter((r) => r.route !== 'lookup');
  res.json({
    uptimeS: Math.round(process.uptime()),
    cache: { kind: cache.kind, ...(await cache.count()) },
    providers: router.snapshot(),
    latency: { p50: percentile(llmMs, 0.5), p95: percentile(llmMs, 0.95), n: llmMs.length },
    hitRate: done.length ? done.filter((r) => r.cached).length / done.length : null,
    recent: recent.slice(0, 100),
  });
});

// Serve the built React dashboard if present.
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../../dashboard/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.listen(config.port, () => {
  console.log(
    `peek server on :${config.port} | cache=${cache.kind} | llm slots=${router.size} | batch=${config.batchSize}`,
  );
  for (const s of router.snapshot()) {
    console.log(`  ${s.id.padEnd(36)} prio ${s.priority}  ${s.rpm}/min  ${s.rpd}/day`);
  }
  if (!router.size) console.warn('  no LLM keys configured: fill server/.env');
});
