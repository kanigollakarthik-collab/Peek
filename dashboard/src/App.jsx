import { useEffect, useState } from 'react';

const TOKEN_KEY = 'peek-token';

function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

function useStats(token) {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const res = await fetch('/api/stats', { headers: { 'x-api-key': token } });
        if (!res.ok) throw new Error(res.status === 401 ? 'Wrong token' : `HTTP ${res.status}`);
        const data = await res.json();
        if (alive) {
          setStats(data);
          setError('');
        }
      } catch (err) {
        if (alive) setError(err.message);
      }
    }
    tick();
    const id = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [token]);

  return { stats, error };
}

const ms = (v) => (v == null ? '–' : v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${v}ms`);
const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
};

function Tile({ label, value, hint }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {hint && <div className="tile-hint">{hint}</div>}
    </div>
  );
}

function Meter({ used, max }) {
  const pct = Math.min(100, (used / max) * 100);
  return (
    <div className="meter" title={`${used} / ${max}`}>
      <div className={`meter-fill ${pct > 85 ? 'hot' : ''}`} style={{ width: `${pct}%` }} />
      <span>
        {used}/{max}
      </span>
    </div>
  );
}

function slotState(s) {
  if (s.cooldownMs > 0) return <span className="pill warn">cooldown {Math.ceil(s.cooldownMs / 1000)}s</span>;
  if (s.inflight > 0) return <span className="pill busy">{s.inflight} in flight</span>;
  return <span className="pill ok">ready</span>;
}

export default function App() {
  const [token, setToken] = useState(readToken);
  const { stats, error } = useStats(token);

  const saveToken = (v) => {
    setToken(v);
    try {
      localStorage.setItem(TOKEN_KEY, v);
    } catch {
      /* storage unavailable */
    }
  };

  return (
    <main>
      <header>
        <h1>
          Peek <span>LLM API tree &amp; cache</span>
        </h1>
        <input
          type="password"
          placeholder="ADMIN_TOKEN"
          value={token}
          onChange={(e) => saveToken(e.target.value)}
        />
      </header>

      {error && <p className="error">{error}</p>}
      {!stats && !error && <p className="muted">Loading…</p>}

      {stats && (
        <>
          <section className="tiles">
            <Tile label="LLM p50" value={ms(stats.latency.p50)} hint={`${stats.latency.n} calls`} />
            <Tile label="LLM p95" value={ms(stats.latency.p95)} />
            <Tile
              label="Cache hit rate"
              value={stats.hitRate == null ? '–' : `${Math.round(stats.hitRate * 100)}%`}
            />
            <Tile
              label="Cached"
              value={stats.cache.products}
              hint={`${stats.cache.answers} answers · ${stats.cache.kind}`}
            />
            <Tile label="Keys live" value={`${stats.providers.filter((p) => p.cooldownMs === 0).length}/${stats.providers.length}`} />
          </section>

          <section>
            <h2>Providers</h2>
            {stats.providers.length === 0 ? (
              <p className="muted">No API keys configured in server/.env.</p>
            ) : (
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Slot</th>
                      <th>Model</th>
                      <th>Prio</th>
                      <th>State</th>
                      <th>Per minute</th>
                      <th>Tokens/min</th>
                      <th>Today</th>
                      <th className="num">OK</th>
                      <th className="num">Fail</th>
                      <th className="num">Latency</th>
                      <th>Last error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.providers.map((s) => (
                      <tr key={s.id}>
                        <td>
                          <b>{s.id}</b> <span className="muted">{s.key}</span>
                        </td>
                        <td className="muted">{s.model}</td>
                        <td>{s.priority}</td>
                        <td>{slotState(s)}</td>
                        <td>
                          <Meter used={s.rpmUsed} max={s.rpm} />
                        </td>
                        <td>
                          {s.tpm ? (
                            <Meter used={s.tpmUsed} max={s.tpm} />
                          ) : (
                            <span className="muted">{s.tpmUsed ? s.tpmUsed : '–'}</span>
                          )}
                        </td>
                        <td>
                          <Meter used={s.dayUsed} max={s.rpd} />
                        </td>
                        <td className="num">{s.ok}</td>
                        <td className="num">{s.fail}</td>
                        <td className="num">{ms(s.latencyMs)}</td>
                        <td className="muted clip" title={s.lastError || ''}>
                          {s.lastError || ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section>
            <h2>Recent requests</h2>
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Route</th>
                    <th>ASIN</th>
                    <th>Served by</th>
                    <th className="num">Attempts</th>
                    <th className="num">Time</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.recent.map((r, i) => (
                    <tr key={`${r.t}-${i}`}>
                      <td className="muted">{ago(r.t)}</td>
                      <td>{r.route}</td>
                      <td>{r.asin || (r.route === 'lookup' ? `${r.hits}/${r.n} hits` : '')}</td>
                      <td>{r.cached ? <span className="pill ok">cache</span> : r.provider || ''}</td>
                      <td className="num">{r.attempts ?? ''}</td>
                      <td className="num">{r.ms != null ? ms(r.ms) : ''}</td>
                      <td className={r.ok === false ? 'error clip' : 'clip'} title={r.error || ''}>
                        {r.ok === false ? r.error : r.ok ? 'ok' : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </main>
  );
}
