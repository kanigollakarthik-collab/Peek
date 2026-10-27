// Exercises the LLM router against fake OpenAI-compatible providers:
// one rate-limited, one slow, one returning junk, one healthy.
// Run: npm run test:router
import http from 'node:http';
import assert from 'node:assert/strict';
import { LlmRouter } from '../src/llm/router.js';
import { factsTask } from '../src/llm/prompts.js';

const good = JSON.stringify({ returnType: 'replacement', returnDays: 10, returnPolicy: '10 days replacement' });

const server = http.createServer((req, res) => {
  const mode = req.url.split('/')[1];
  const reply = (status, content, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(status === 200 ? { choices: [{ message: { content } }] } : { error: 'x' }));
  };
  if (mode === 'limited') return reply(429, '', { 'retry-after': '20' });
  if (mode === 'gone') return reply(404, '');
  if (mode === 'junk') return reply(200, 'Sure! Here are the facts you asked for.');
  if (mode === 'slow') return setTimeout(() => reply(200, good), 2500);
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

// 6. All providers exhausted: a clean error, not a hang.
router = new LlmRouter([prov('limited', 1), prov('junk', 2)], opts);
await assert.rejects(router.run(factsTask(product)));
console.log('ok  exhaustion rejects cleanly');

server.close();
console.log('router smoke test passed');
