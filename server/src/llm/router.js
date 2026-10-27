// LLM API tree: one "slot" per (provider, key). Each request goes to the
// fastest healthy slot with quota left; failures fail over to the next slot,
// and a slow first attempt gets one hedged duplicate on another slot.
// When every slot is busy, requests wait for one to free up (until the
// task's deadline) instead of failing straight away.

const MINUTE = 60_000;

export class ParseError extends Error {}

// The chat-completions body for one provider. Models without system-prompt
// support (Gemma on the Gemini API) get the instructions folded into the
// first user message instead.
export function buildRequestBody(p, model, messages, maxTokens, extraBody = p.extraBody) {
  let msgs = messages;
  if (p.systemAsUser) {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    msgs = messages.filter((m) => m.role !== 'system');
    if (system && msgs.length) msgs = [{ ...msgs[0], content: `${system}\n\n${msgs[0].content}` }, ...msgs.slice(1)];
  }
  const body = { model, messages: msgs, max_tokens: maxTokens, temperature: 0, ...extraBody };
  if (p.jsonMode) body.response_format = { type: 'json_object' };
  return body;
}

// How long to bench a slot after a 429. Gemini says exactly when to retry
// ("retryDelay": "36s") and whether the per-day quota is used up.
function cooldownFor429(res, text) {
  if (/per\s?day|perday|daily/i.test(text)) return 60 * MINUTE;
  const retryDelay = text.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (retryDelay) return Math.ceil(Number(retryDelay[1]) * 1000) + 500;
  const retryAfter = Number(res.headers.get('retry-after'));
  return retryAfter > 0 ? retryAfter * 1000 : 30_000;
}

// Rough token count for budgeting: ~4 characters per token for the prompt,
// plus part of the reply budget (models rarely use all of it).
export function estimateTokens(task) {
  const chars = task.messages.reduce((n, m) => n + String(m.content).length, 0);
  return Math.ceil(chars / 4) + Math.round((task.maxTokens ?? 400) * 0.6);
}

class Slot {
  constructor(provider, key, index) {
    this.id = `${provider.id}#${index + 1}`;
    this.provider = provider;
    this.key = key;
    this.minuteHits = [];
    this.minuteTokens = []; // { t, n }
    this.dayCount = 0;
    this.day = new Date().toISOString().slice(0, 10);
    this.cooldownUntil = 0;
    this.inflight = 0;
    this.ok = 0;
    this.fail = 0;
    this.consecutiveFails = 0;
    this.latencyEwma = null;
    this.lastError = null;
  }

  refresh(now) {
    while (this.minuteHits.length && now - this.minuteHits[0] > MINUTE) this.minuteHits.shift();
    while (this.minuteTokens.length && now - this.minuteTokens[0].t > MINUTE) this.minuteTokens.shift();
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.dayCount = 0;
    }
  }

  tokensUsed() {
    return this.minuteTokens.reduce((n, e) => n + e.n, 0);
  }

  available(now, est) {
    this.refresh(now);
    const p = this.provider;
    return (
      now >= this.cooldownUntil &&
      this.inflight < p.maxInflight &&
      this.minuteHits.length < p.rpm &&
      this.dayCount < p.rpd &&
      (!p.tpm || this.tokensUsed() + est <= p.tpm)
    );
  }

  // Milliseconds until this slot could take this request (ignoring inflight).
  freesIn(now, est) {
    this.refresh(now);
    const p = this.provider;
    if (this.dayCount >= p.rpd || (p.tpm && est > p.tpm)) return Infinity;
    let wait = Math.max(0, this.cooldownUntil - now);
    if (this.minuteHits.length >= p.rpm) {
      wait = Math.max(wait, MINUTE - (now - this.minuteHits[0]));
    }
    if (p.tpm) {
      // Wait until enough of the last minute's tokens have aged out.
      let used = this.tokensUsed();
      for (const e of this.minuteTokens) {
        if (used + est <= p.tpm) break;
        used -= e.n;
        wait = Math.max(wait, MINUTE - (now - e.t));
      }
    }
    return wait;
  }

  score() {
    return (this.latencyEwma ?? 800) * (1 + this.inflight * 0.5);
  }
}

export class LlmRouter {
  constructor(providers, opts) {
    this.opts = opts;
    this.slots = providers.flatMap((p) => p.keys.map((k, i) => new Slot(p, k, i)));
  }

  get size() {
    return this.slots.length;
  }

  pick(exclude, est) {
    const now = Date.now();
    const candidates = this.slots.filter((s) => !exclude.has(s.id) && s.available(now, est));
    candidates.sort(
      (a, b) => a.provider.priority - b.provider.priority || a.score() - b.score(),
    );
    return candidates[0] || null;
  }

  nextFreeIn(exclude, est) {
    const now = Date.now();
    const waits = this.slots.filter((s) => !exclude.has(s.id)).map((s) => s.freesIn(now, est));
    return waits.length ? Math.min(...waits) : Infinity;
  }

  /**
   * Run a chat completion through the tree.
   * @param {object} task { messages, maxTokens, parse(content) -> value,
   *   optional timeoutMs, hedgeMs, deadlineMs to override the router defaults }
   * @returns {Promise<{ value, slot, latencyMs, attempts }>}
   */
  run(task) {
    const timeoutMs = task.timeoutMs ?? this.opts.timeoutMs;
    const hedgeMs = task.hedgeMs ?? this.opts.hedgeMs;
    const { maxAttempts } = this.opts;
    const started = Date.now();
    const deadline = started + (task.deadlineMs ?? this.opts.queueMs ?? timeoutMs * 2);
    const est = estimateTokens(task);
    const tried = new Set();
    const controllers = [];
    const errors = [];

    return new Promise((resolve, reject) => {
      let settled = false;
      let active = 0;
      let hedged = false;

      const finish = (err, result) => {
        if (settled) return;
        settled = true;
        for (const c of controllers) c.abort(new Error('superseded'));
        if (err) reject(err);
        else resolve(result);
      };

      const giveUp = () => {
        const e = new Error(errors.length ? errors.join(' | ') : 'no LLM provider available');
        e.attempts = errors.length;
        finish(e);
      };

      const launch = () => {
        if (settled) return;
        if (tried.size >= maxAttempts || Date.now() > deadline) {
          if (active === 0) giveUp();
          return;
        }
        const slot = this.pick(tried, est);
        if (!slot) {
          // Everything is busy or rate limited: wait for the first slot to
          // free up if that happens before the deadline.
          if (active === 0) {
            const wait = this.nextFreeIn(tried, est);
            if (Date.now() + wait < deadline) setTimeout(launch, Math.max(wait, 100));
            else giveUp();
          }
          return;
        }
        tried.add(slot.id);
        active++;
        const ctrl = new AbortController();
        controllers.push(ctrl);

        const hedgeTimer = hedged
          ? null
          : setTimeout(() => {
              hedged = true;
              launch();
            }, hedgeMs);

        this.callSlot(slot, task, ctrl.signal, est, timeoutMs).then(
          (value) => {
            active--;
            clearTimeout(hedgeTimer);
            finish(null, {
              value,
              slot: slot.id,
              provider: slot.provider.id,
              latencyMs: Date.now() - started,
              attempts: tried.size,
            });
          },
          (err) => {
            active--;
            clearTimeout(hedgeTimer);
            if (settled) return;
            errors.push(`${slot.id}: ${err.message}`);
            launch();
            if (!settled && active === 0 && tried.size >= maxAttempts) giveUp();
          },
        );
      };

      launch();
    });
  }

  async callSlot(slot, task, signal, est, timeoutMs) {
    const p = slot.provider;
    const now = Date.now();
    const tokens = { t: now, n: est };
    slot.minuteHits.push(now);
    slot.minuteTokens.push(tokens);
    slot.dayCount++;
    slot.inflight++;
    const t0 = now;
    try {
      const body = buildRequestBody(p, p.model, task.messages, task.maxTokens ?? 400);

      const res = await fetch(`${p.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${slot.key}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });

      if (!res.ok) {
        const fullText = await res.text().catch(() => '');
        const text = fullText.slice(0, 200);
        const err = new Error(`HTTP ${res.status} ${text}`.trim());
        if (res.status === 429) {
          slot.cooldownUntil = Date.now() + cooldownFor429(res, fullText);
        } else if (res.status === 401 || res.status === 403) {
          slot.cooldownUntil = Date.now() + 10 * MINUTE;
        } else if (res.status === 402 || res.status === 404 || res.status === 410) {
          // Out of credit, or the model was renamed or retired: retrying won't
          // help until .env is fixed, so bench the slot for half an hour.
          slot.cooldownUntil = Date.now() + 30 * MINUTE;
        } else {
          err.transient = true;
        }
        throw err;
      }

      const data = await res.json();
      // Replace the estimate with the real count when the provider reports it.
      if (data?.usage?.total_tokens) tokens.n = data.usage.total_tokens;
      const content = data?.choices?.[0]?.message?.content ?? '';
      const value = task.parse ? task.parse(content) : content;

      const ms = Date.now() - t0;
      slot.latencyEwma = slot.latencyEwma == null ? ms : slot.latencyEwma * 0.7 + ms * 0.3;
      slot.ok++;
      slot.consecutiveFails = 0;
      return value;
    } catch (err) {
      if (signal.aborted) throw err; // lost a hedge race, not the slot's fault
      slot.fail++;
      slot.consecutiveFails++;
      slot.lastError = err.name === 'TimeoutError' ? 'timeout' : err.message;
      if (!(err instanceof ParseError) && slot.cooldownUntil < Date.now()) {
        // Timeouts and 5xx: short pause, longer if the slot keeps failing.
        slot.cooldownUntil = Date.now() + (slot.consecutiveFails >= 3 ? MINUTE : 5_000);
      }
      throw err;
    } finally {
      slot.inflight--;
    }
  }

  snapshot() {
    const now = Date.now();
    return this.slots.map((s) => {
      s.refresh(now);
      return {
        id: s.id,
        provider: s.provider.id,
        model: s.provider.model,
        key: `…${s.key.slice(-4)}`,
        priority: s.provider.priority,
        rpmUsed: s.minuteHits.length,
        rpm: s.provider.rpm,
        tpmUsed: s.tokensUsed(),
        tpm: s.provider.tpm || null,
        dayUsed: s.dayCount,
        rpd: s.provider.rpd,
        inflight: s.inflight,
        ok: s.ok,
        fail: s.fail,
        latencyMs: s.latencyEwma == null ? null : Math.round(s.latencyEwma),
        cooldownMs: Math.max(0, s.cooldownUntil - now),
        lastError: s.lastError,
      };
    });
  }
}
