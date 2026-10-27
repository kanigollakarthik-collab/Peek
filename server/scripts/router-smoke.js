// Exercises the LLM router against fake OpenAI-compatible providers:
// one rate-limited, one slow, one returning junk, one healthy.
// Run: npm run test:router
import http from 'node:http';
import assert from 'node:assert/strict';
import { LlmRouter, ParseError, estimateTokens } from '../src/llm/router.js';
import { factsTask, factsBatchTask } from '../src/llm/prompts.js';
import { Batcher } from '../src/batcher.js';

const good = JSON.stringify({ returnType: 'replacement', returnDays: 10, returnPolicy: '10 days replacement' });

const server = http.createServer(async (req, res) => {
  const mode = req.url.split('/')[1];
  let raw = '';
  for await (const c of req) raw += c;
  const raw429 = (body) => {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(body);
  };
  if (mode === 'retrydelay') return raw429('{"error":{"code":429,"details":[{"retryDelay":"7s"}]}}');
  if (mode === 'perday') return raw429('{"error":{"details":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}}');
  const reply = (status, content, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(status === 200 ? { choices: [{ message: { content } }] } : { error: 'x' }));
  };
  if (mode === 'limited') return reply(429, '', { 'retry-after': '20' });
  if (mode === 'gone') return reply(404, '');
  if (mode === 'junk') return reply(200, 'Sure! Here are the facts you asked for.');
  if (mode === 'slow') return setTimeout(() => reply(200, good), 2500);
  if (mode === 'delay300') return setTimeout(() => reply(200, good), 300);
  if (mode === 'nosystem') {
    // Like Gemma on the Gemini API: rejects system prompts and JSON mode.
    const body = JSON.parse(raw);
    if (body.messages.some((m) => m.role === 'system') || body.response_format) return reply(400, '');
    return reply(200, good);
  }
  if (mode === 'fenced') return reply(200, '```json\n' + good + '\n```');
  return reply(200, good);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const prov = (id, priority, extra = {}) => ({
  id, baseUrl: `${base}/${id}`, keys: ['test-key-0000'], model: 'fake', priority,
  rpm: 100, rpd: 1000, maxInflight: 4, jsonMode: false, ...extra,
});
const opts = { timeoutMs: 4000, hedgeMs: 800, maxAttempts: 4 };
const product = { title: 'Test phone', text: '10 days replacement' };

// 1. Rate-limited and junk providers are skipped; the healthy one answers.
let router = new LlmRouter([prov('limited', 1), prov('junk', 2), prov('fenced', 3)], opts);
let r = await router.run(factsTask(product));
assert.equal(r.provider, 'fenced');
assert.equal(r.value.returnDays, 10);
const limited = router.snapshot().find((s) => s.provider === 'limited');
assert.ok(limited.cooldownMs > 15000, '429 should put the slot on cooldown');
console.log(`ok  failover: answered by ${r.slot} after ${r.attempts} attempts in ${r.latencyMs}ms`);

// 2. Cooled-down slot is not retried on the next request.
r = await router.run(factsTask(product));
assert.equal(r.attempts, 2, 'limited slot should be skipped while cooling down');
console.log(`ok  cooldown respected: ${r.attempts} attempts`);

// 3. A slow first choice gets hedged by a faster one.
router = new LlmRouter([prov('slow', 1), prov('ok', 2)], opts);
r = await router.run(factsTask(product));
assert.equal(r.provider, 'ok');
assert.ok(r.latencyMs < 2000, `hedge should win before the slow reply (${r.latencyMs}ms)`);
console.log(`ok  hedging: ${r.slot} won in ${r.latencyMs}ms`);

// 4. rpm cap spreads load across keys.
router = new LlmRouter([prov('ok', 1, { keys: ['a-1111', 'b-2222'], rpm: 3 })], opts);
await Promise.all(Array.from({ length: 6 }, () => router.run(factsTask(product))));
const used = router.snapshot().map((s) => s.rpmUsed);
assert.deepEqual(used, [3, 3]);
console.log(`ok  rpm cap spreads load: ${used.join(' / ')}`);

// 5. A retired model (404) benches the slot for a long time, not 5 seconds.
router = new LlmRouter([prov('gone', 1), prov('ok', 2)], opts);
r = await router.run(factsTask(product));
assert.equal(r.provider, 'ok');
const gone = router.snapshot().find((s) => s.provider === 'gone');
assert.ok(gone.cooldownMs > 20 * 60_000, '404 should bench the slot for ~30 min');
console.log(`ok  retired model benched for ${Math.round(gone.cooldownMs / 60_000)} min`);

// 6. Tokens-per-minute cap: the second request goes elsewhere instead of
//    being sent to a key that would answer 429.
const est = estimateTokens(factsTask(product));
router = new LlmRouter([prov('ok', 1, { tpm: Math.round(est * 1.5) }), prov('fenced', 2)], opts);
const first = await router.run(factsTask(product));
const second = await router.run(factsTask(product));
assert.equal(first.provider, 'ok');
assert.equal(second.provider, 'fenced', 'tpm budget should push the 2nd call to another key');
console.log(`ok  tpm budget respected (~${est} tokens/call): ${first.slot} then ${second.slot}`);

// 7. Every key busy: requests wait for a free slot instead of failing.
router = new LlmRouter([prov('delay300', 1, { maxInflight: 1 })], opts);
const waited = await Promise.all([1, 2, 3].map(() => router.run(factsTask(product))));
assert.equal(waited.length, 3);
console.log(`ok  queued while busy: 3 calls on 1 slot, last in ${Math.max(...waited.map((w) => w.latencyMs))}ms`);

// 8. Batch replies map back to the right product, in any order.
const p2 = { title: 'Two', text: 'x' };
const parsed = factsBatchTask([product, p2, p2]).parse(
  '```json\n{"products":[{"n":2,"returnDays":7},{"n":1,"returnType":"none"}]}\n```',
);
assert.equal(parsed[0].returnType, 'none');
assert.equal(parsed[1].returnDays, 7);
assert.equal(parsed[2], null, 'a skipped product is null, not someone else\'s facts');
assert.throws(() => factsBatchTask([product]).parse('{"products":[]}'), ParseError);
console.log('ok  batch replies matched by product number');

// 9. Batcher groups requests that arrive together, up to maxSize.
const sizes = [];
const batcher = new Batcher({
  maxSize: 4,
  waitMs: 50,
  runBatch: async (items) => {
    sizes.push(items.length);
    return items.map((n) => (n === 3 ? new Error('skip') : n * 10));
  },
});
const results = await Promise.allSettled([1, 2, 3, 4, 5].map((n) => batcher.add(n)));
assert.deepEqual(sizes, [4, 1]);
assert.equal(results[2].status, 'rejected');
assert.equal(results[4].value, 50);
console.log(`ok  batcher grouped 5 requests as ${sizes.join(' + ')}`);

// 10. Models without system prompts get the instructions in the user message.
router = new LlmRouter([prov('nosystem', 1, { systemAsUser: true, jsonMode: false })], opts);
r = await router.run(factsTask(product));
assert.equal(r.provider, 'nosystem');
console.log('ok  system prompt folded into user message for Gemma-style models');

// 11. Gemini 429s: exact retryDelay is honoured; a daily quota benches for an hour.
router = new LlmRouter([prov('retrydelay', 1), prov('perday', 2), prov('ok', 3)], opts);
r = await router.run(factsTask(product));
assert.equal(r.provider, 'ok');
const snap = Object.fromEntries(router.snapshot().map((s) => [s.provider, s.cooldownMs]));
assert.ok(snap.retrydelay > 6000 && snap.retrydelay < 9000, `retryDelay 7s -> ${snap.retrydelay}ms`);
assert.ok(snap.perday > 50 * 60_000, `per-day quota -> ${snap.perday}ms`);
console.log(`ok  429 cooldowns: retryDelay ${Math.round(snap.retrydelay / 1000)}s, daily quota ${Math.round(snap.perday / 60_000)} min`);

// 12. All providers exhausted: a clean error, not a hang.
router = new LlmRouter([prov('limited', 1), prov('junk', 2)], opts);
await assert.rejects(router.run(factsTask(product)));
console.log('ok  exhaustion rejects cleanly');

server.close();
console.log('router smoke test passed');
