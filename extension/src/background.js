// Relays content-script requests to the Peek server with the signed-in user's
// token. The token never touches the Amazon page itself.

importScripts('settings.js');

class AuthError extends Error {}

async function callServer(path, body, signal) {
  const [settings, auth] = await Promise.all([peekSettings(), peekAuth()]);
  if (!auth) throw new AuthError('Sign in to Peek to see answers');
  let res;
  try {
    res = await fetch(peekServerBase(settings) + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.token}` },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new Error("Can't reach the Peek server");
  }
  if (res.status === 401) {
    const data = await res.json().catch(() => ({}));
    await peekClearAuth();
    throw new AuthError(data.error || 'Session expired, sign in again');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Server error (${res.status})`);
  }
  return res;
}

async function streamLines(res, onLine) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onLine(JSON.parse(line));
    }
  }
  if (buf.trim()) onLine(JSON.parse(buf));
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'peek') return;
  const inflight = new Set();
  const post = (msg) => {
    try {
      port.postMessage(msg);
    } catch {
      /* tab navigated away */
    }
  };
  port.onDisconnect.addListener(() => inflight.forEach((c) => c.abort()));

  port.onMessage.addListener(async (msg) => {
    const ctrl = new AbortController();
    inflight.add(ctrl);
    try {
      if (msg.type === 'lookup') {
        const res = await callServer('/api/lookup', { asins: msg.asins }, ctrl.signal);
        const data = await res.json();
        post({ type: 'lookup', id: msg.id, hits: data.hits || {} });
      } else if (msg.type === 'extract') {
        const res = await callServer('/api/extract', { products: msg.products }, ctrl.signal);
        await streamLines(res, (line) => post({ type: 'facts', ...line }));
      } else if (msg.type === 'ask') {
        const res = await callServer('/api/ask', { question: msg.question, products: msg.products }, ctrl.signal);
        await streamLines(res, (line) => post({ type: 'answer', question: msg.question, ...line }));
      }
    } catch (err) {
      if (ctrl.signal.aborted) return;
      if (err instanceof AuthError) post({ type: 'auth', error: err.message });
      if (msg.type === 'lookup') {
        post({ type: 'lookup', id: msg.id, hits: {}, error: err.message, auth: err instanceof AuthError });
      } else {
        post({ type: 'error', kind: msg.type, message: err.message, asins: msg.products.map((p) => p.asin) });
      }
    } finally {
      inflight.delete(ctrl);
    }
  });
});
