// LLM API tree: one "slot" per (provider, key). Each request goes to the
// fastest healthy slot with quota left; failures fail over to the next slot,
// and a slow first attempt gets one hedged duplicate on another slot.

const MINUTE = 60_000;

export class ParseError extends Error {}

class Slot {
  constructor(provider, key, index) {
    this.id = `${provider.id}#${index + 1}`;
    this.provider = provider;
    this.key = key;
    this.minuteHits = [];
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
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.dayCount = 0;
    }
  }

  available(now) {
    this.refresh(now);
    const p = this.provider;
    return (
      now >= this.cooldownUntil &&
      this.inflight < p.maxInflight &&
      this.minuteHits.length < p.rpm &&
      this.dayCount < p.rpd
    );
  }

  // Milliseconds until this slot could take a request again (ignoring inflight).
  freesIn(now) {
    this.refresh(now);
    if (this.dayCount >= this.provider.rpd) return Infinity;
    let wait = Math.max(0, this.cooldownUntil - now);
    if (this.minuteHits.length >= this.provider.rpm) {
      wait = Math.max(wait, MINUTE - (now - this.minuteHits[0]));
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

  pick(exclude) {
    const now = Date.now();
    const candidates = this.slots.filter((s) => !exclude.has(s.id) && s.available(now));
    candidates.sort(
      (a, b) => a.provider.priority - b.provider.priority || a.score() - b.score(),
    );
    return candidates[0] || null;
  }

  nextFreeIn(exclude) {
    const now = Date.now();
    const waits = this.slots.filter((s) => !exclude.has(s.id)).map((s) => s.freesIn(now));
    return waits.length ? Math.min(...waits) : Infinity;
  }

  /**
   * Run a chat completion through the tree.
   * @param {object} task { messages, maxTokens, parse(content) -> value }
   * @returns {Promise<{ value, slot, latencyMs, attempts }>}
   */
  run(task) {
    const { timeoutMs, hedgeMs, maxAttempts } = this.opts;
    const started = Date.now();
    const deadline = started + timeoutMs * 2;
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
        const slot = this.pick(tried);
        if (!slot) {
          // Everything is busy or rate limited; wait briefly if a slot frees soon.
          const wait = this.nextFreeIn(tried);
          if (active === 0) {
            if (wait < 1500 && Date.now() + wait < deadline) setTimeout(launch, wait + 10);
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

        this.callSlot(slot, task, ctrl.signal).then(
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

  async callSlot(slot, task, signal) {
    const p = slot.provider;
    const now = Date.now();
    slot.minuteHits.push(now);
    slot.dayCount++;
    slot.inflight++;
    const t0 = now;
    try {
      const body = {
        model: p.model,
        messages: task.messages,
        max_tokens: task.maxTokens ?? 400,
        temperature: 0,
      };
      if (p.jsonMode) body.response_format = { type: 'json_object' };

      const res = await fetch(`${p.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${slot.key}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.opts.timeoutMs)]),
      });

      if (!res.ok) {
        const text = (await res.text().catch(() => '')).slice(0, 200);
        const err = new Error(`HTTP ${res.status} ${text}`.trim());
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get('retry-after'));
          slot.cooldownUntil = Date.now() + (retryAfter > 0 ? retryAfter * 1000 : 30_000);
        } else if (res.status === 401 || res.status === 403) {
          slot.cooldownUntil = Date.now() + 10 * MINUTE;
        } else {
          err.transient = true;
        }
        throw err;
      }

      const data = await res.json();
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
