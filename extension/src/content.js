// Runs on amazon.in. Pipeline per search page:
//   cards found -> server cache lookup -> fetch missing product pages in parallel
//   (same-origin, user's own session) -> clean to ~5 KB text -> server LLM tree
//   -> answers streamed back into each card.

(async () => {
  let settings = await peekSettings();
  if (!settings.enabled) return;

  const products = new Map(); // asin -> entry
  const run = { t0: 0, total: 0, done: 0, timer: 0 };
  let question = '';
  let hud = null;

  // ---------- background connection ----------
  let port = null;
  let reqSeq = 0;
  const pendingLookups = new Map();

  function getPort() {
    if (port) return port;
    port = chrome.runtime.connect({ name: 'peek' });
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => (port = null));
    return port;
  }
  const send = (msg) => getPort().postMessage(msg);

  function lookup(asins) {
    const id = ++reqSeq;
    return new Promise((resolve) => {
      pendingLookups.set(id, resolve);
      send({ type: 'lookup', id, asins });
    });
  }

  function onMessage(msg) {
    if (msg.type === 'lookup') {
      pendingLookups.get(msg.id)?.(msg.hits || {});
      pendingLookups.delete(msg.id);
      if (msg.error) hud?.warn(`Server unreachable: ${msg.error}`);
    } else if (msg.type === 'facts') {
      const e = products.get(msg.asin);
      if (!e) return;
      e.t.server = performance.now();
      e.provider = msg.provider || (msg.cached ? 'cache' : null);
      if (msg.error) {
        e.factsError = msg.error;
      } else {
        e.facts = msg.facts;
      }
      render(e);
      finish(e);
      if (question && !e.answer) ask([e]);
    } else if (msg.type === 'answer') {
      const e = products.get(msg.asin);
      if (!e || msg.question !== question) return;
      e.answer = msg.error ? { error: msg.error } : { answer: msg.answer, evidence: msg.evidence };
      renderAnswer(e);
    } else if (msg.type === 'error') {
      hud?.warn(`Server error: ${msg.message}`);
      for (const asin of msg.asins || []) {
        const e = products.get(asin);
        if (!e) continue;
        if (msg.kind === 'ask') {
          e.answer = { error: 'Server error' };
          renderAnswer(e);
        } else {
          e.factsError = 'Server error';
          render(e);
          finish(e);
        }
      }
    }
  }

  // ---------- rendering ----------
  function render(e) {
    for (const b of e.badges) {
      if (e.factsError && !e.facts) b.error(e.factsError);
      else if (e.facts || e.rules) b.facts(e.facts, e.rules, settings.fields, !e.facts);
      else b.loading(e.status || 'Reading product page…');
    }
  }

  function renderAnswer(e) {
    for (const b of e.badges) b.answer(question, e.answer || { loading: true });
  }

  function finish(e) {
    if (e.done) return;
    e.done = true;
    e.t.end = performance.now();
    run.done++;
    hud?.progress(run.done, run.total, performance.now() - run.t0);
    if (run.done === run.total) {
      clearInterval(run.timer);
      run.timer = 0;
      report();
    }
  }

  // Timing breakdown for the latency spike: console + chrome.storage for the popup.
  function report() {
    const rows = [...products.values()].map((e) => ({
      asin: e.asin,
      source: e.provider || (e.factsError ? 'error' : '?'),
      fetchMs: e.t.fetched ? Math.round(e.t.fetched - e.t.fetch0) : null,
      cleanMs: e.t.cleaned ? Math.round(e.t.cleaned - e.t.fetched) : null,
      llmMs: e.t.server && e.t.cleaned ? Math.round(e.t.server - e.t.cleaned) : null,
      totalMs: Math.round(e.t.end - run.t0),
      chars: e.text?.length ?? null,
    }));
    const totalMs = Math.round(performance.now() - run.t0);
    console.log(`[peek] ${rows.length} products in ${totalMs} ms`);
    console.table(rows);
    chrome.storage.local.set({ lastRun: { at: Date.now(), url: location.href, totalMs, rows } });
  }

  // ---------- product page fetch queue ----------
  const queue = [];
  let active = 0;
  let concurrency = settings.concurrency;
  let pausedUntil = 0;

  function pump() {
    const wait = pausedUntil - Date.now();
    if (wait > 0) return void setTimeout(pump, wait);
    while (active < concurrency && queue.length) {
      const e = queue.shift();
      active++;
      fetchProduct(e).finally(() => {
        active--;
        pump();
      });
    }
  }

  async function fetchProduct(e) {
    e.t.fetch0 = performance.now();
    try {
      const res = await fetch(Amazon.productUrl(e.asin), {
        credentials: 'include',
        signal: AbortSignal.timeout(10_000),
      });
      const html = await res.text();
      e.t.fetched = performance.now();

      if (Amazon.isBlocked(res.status, html)) {
        // Back off: halve parallelism, pause briefly, retry up to twice.
        concurrency = Math.max(2, Math.floor(concurrency / 2));
        pausedUntil = Date.now() + 3000;
        hud?.warn('Amazon is throttling, slowing down');
        e.retries = (e.retries || 0) + 1;
        if (e.retries <= 2) {
          e.status = 'Amazon throttled, retrying…';
          render(e);
          queue.unshift(e);
        } else {
          e.factsError = 'Amazon blocked this request, try again later';
          render(e);
          finish(e);
        }
        return;
      }

      const { text, rules } = Amazon.clean(html);
      e.t.cleaned = performance.now();
      e.text = text;
      e.rules = rules;
      render(e);
      bufferExtract({ asin: e.asin, title: e.title, text, rules });
    } catch (err) {
      e.factsError = err.name === 'TimeoutError' ? 'Product page timed out' : 'Could not load product page';
      render(e);
      finish(e);
    }
  }

  // Batch cleaned products into few HTTP requests (Chrome allows only ~6
  // parallel connections per host); the server streams answers back per item.
  let extractBuf = [];
  let flushTimer = 0;
  function bufferExtract(p) {
    extractBuf.push(p);
    if (extractBuf.length >= 6) flushExtract();
    else if (!flushTimer) flushTimer = setTimeout(flushExtract, 60);
  }
  function flushExtract() {
    clearTimeout(flushTimer);
    flushTimer = 0;
    if (!extractBuf.length) return;
    send({ type: 'extract', products: extractBuf });
    extractBuf = [];
  }

  // ---------- custom questions ----------
  function ask(entries) {
    if (!question || !entries.length) return;
    for (const e of entries) {
      e.answer = null;
      renderAnswer(e);
    }
    const ready = entries.filter((e) => e.text || e.facts);
    if (!ready.length) return;
    send({
      type: 'ask',
      question,
      products: ready.map((e) => ({ asin: e.asin, title: e.title, text: e.text })),
    });
  }

  function onAsk(q) {
    question = q;
    const all = [...products.values()];
    if (!q) {
      for (const e of all) renderAnswer(e);
      return;
    }
    ask(all);
  }

  // ---------- discovery ----------
  async function discover() {
    const fresh = [];
    for (const card of Amazon.getCards()) {
      if (card.dataset.peek) continue;
      card.dataset.peek = '1';
      const asin = card.dataset.asin;
      let e = products.get(asin);
      if (!e) {
        if (products.size >= settings.maxProducts) continue;
        e = { asin, title: Amazon.getTitle(card), badges: [], t: {} };
        products.set(asin, e);
        fresh.push(e);
      }
      // The same ASIN can appear twice (sponsored + organic): badge both.
      e.badges.push(new PeekUI.Badge(card, Amazon.injectionPoint(card)));
      render(e);
      if (question) renderAnswer(e);
    }
    if (!fresh.length) return;

    if (!hud) hud = new PeekUI.Hud({ onAsk });
    if (!run.timer) {
      if (run.done === run.total) {
        run.t0 = performance.now();
        run.done = 0;
        run.total = 0;
      }
      run.timer = setInterval(() => hud.progress(run.done, run.total, performance.now() - run.t0), 200);
    }
    run.total += fresh.length;

    for (const e of fresh) e.status = 'Checking cache…';
    const hits = await lookup(fresh.map((e) => e.asin));
    for (const e of fresh) {
      const hit = hits[e.asin];
      if (hit?.facts) {
        e.facts = hit.facts;
        e.rules = hit.rules;
        e.provider = 'cache';
        e.t.server = performance.now();
        render(e);
        finish(e);
      } else {
        e.status = 'Reading product page…';
        render(e);
        queue.push(e);
      }
    }
    pump();
  }

  let discoverTimer = 0;
  new MutationObserver(() => {
    clearTimeout(discoverTimer);
    discoverTimer = setTimeout(discover, 50);
  }).observe(document.body, { childList: true, subtree: true });

  chrome.storage.onChanged.addListener(async (_changes, area) => {
    if (area !== 'sync') return;
    settings = await peekSettings();
    for (const e of products.values()) render(e);
  });

  discover();
})();
