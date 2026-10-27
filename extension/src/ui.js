// UI injected into Amazon's page. Everything renders inside Shadow DOM so
// Amazon's CSS can't restyle it and ours can't break their layout.

const PeekUI = (() => {
  const BADGE_CSS = `
    :host { all: initial; display: block; margin: 6px 0 4px; }
    .box { font: 12px/1.35 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #0f1111;
      background: #f7fafa; border: 1px solid #d5d9d9; border-radius: 8px; padding: 6px 8px; }
    .row { display: flex; gap: 6px; align-items: baseline; margin: 2px 0; }
    .k { color: #565959; min-width: 64px; flex: none; }
    .v { flex: 1; overflow-wrap: anywhere; }
    .chip { display: inline-block; padding: 0 6px; border-radius: 9px; font-weight: 600; }
    .return { background: #e3f6e8; color: #0b6b2b; }
    .replacement { background: #fff4d6; color: #7a5200; }
    .none { background: #fde4e4; color: #a01818; }
    .unknown { background: #eceff1; color: #455a64; }
    .muted { color: #6f7373; }
    .err { color: #a01818; }
    .ask { border-top: 1px dashed #d5d9d9; margin-top: 4px; padding-top: 4px; }
    .ask .k { color: #6b3fa0; font-weight: 600; }
    .spin { display: inline-block; width: 9px; height: 9px; border: 2px solid #c7cccc; border-top-color: #6b3fa0;
      border-radius: 50%; animation: s .7s linear infinite; vertical-align: -1px; margin-right: 4px; }
    @keyframes s { to { transform: rotate(360deg); } }
  `;

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const spinner = (msg) => `<span class="spin"></span><span class="muted">${esc(msg)}</span>`;

  function returnsChip(facts, rules) {
    const type = facts?.returnType;
    const text = facts?.returnPolicy || rules?.returns ||
      (type === 'none' ? 'Non-returnable' : type ? `${facts.returnDays ? facts.returnDays + ' days ' : ''}${type}` : null);
    if (!text) return '<span class="chip unknown">Not stated</span>';
    const cls = type || (/non/i.test(text) ? 'none' : /replace/i.test(text) ? 'replacement' : /return/i.test(text) ? 'return' : 'unknown');
    return `<span class="chip ${cls}">${esc(text)}</span>`;
  }

  class Badge {
    constructor(card, point) {
      this.host = document.createElement('div');
      this.host.className = 'peek-badge';
      this.root = this.host.attachShadow({ mode: 'open' });
      this.root.innerHTML = `<style>${BADGE_CSS}</style><div class="box"><div class="main"></div><div class="ask" hidden></div></div>`;
      this.main = this.root.querySelector('.main');
      this.askEl = this.root.querySelector('.ask');
      point.parent.insertBefore(this.host, point.before);
      // Clicks inside the badge shouldn't open the product.
      this.host.addEventListener('click', (e) => e.stopPropagation());
    }

    loading(msg = 'Reading product page…') {
      this.main.innerHTML = spinner(msg);
    }

    error(msg) {
      this.main.innerHTML = `<span class="err">${esc(msg)}</span>`;
    }

    facts(facts, rules, fields, pending = false, note = null) {
      const rows = [];
      if (fields.returns) rows.push(['Returns', returnsChip(facts, rules)]);
      const add = (on, label, value) => on && rows.push([label, value ? esc(value) : '<span class="muted">Not stated</span>']);
      add(fields.bankOffers, 'Bank offer', facts?.bankOffers);
      add(fields.warranty, 'Warranty', facts?.warranty || rules?.warranty);
      add(fields.delivery, 'Delivery', facts?.delivery);
      add(fields.seller, 'Seller', facts?.seller);
      add(fields.highlights, 'Specs', facts?.highlights);
      this.main.innerHTML =
        rows.map(([k, v]) => `<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('') +
        (pending ? `<div class="row">${spinner('Asking AI…')}</div>` : '') +
        (note ? `<div class="row muted">${esc(note)}</div>` : '');
    }

    answer(question, state) {
      this.askEl.hidden = !question;
      if (!question) return;
      const body = state.loading
        ? spinner('Thinking…')
        : state.error
          ? `<span class="err">${esc(state.error)}</span>`
          : state.answer
            ? esc(state.answer)
            : '<span class="muted">Not mentioned on the product page</span>';
      const title = state.evidence ? ` title="${esc(state.evidence)}"` : '';
      this.askEl.innerHTML = `<div class="row"${title}><span class="k">${esc(question.slice(0, 24))}</span><span class="v">${body}</span></div>`;
    }
  }

  const HUD_CSS = `
    :host { all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; }
    .hud { font: 13px/1.3 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #0f1111; background: #fff;
      border: 1px solid #c9cccc; border-radius: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.18); padding: 10px; width: 300px; }
    .top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    b { color: #6b3fa0; }
    .stat { color: #565959; font-variant-numeric: tabular-nums; }
    form { display: flex; gap: 6px; }
    input { flex: 1; font: inherit; padding: 6px 8px; border: 1px solid #888c8c; border-radius: 8px; min-width: 0; }
    button { font: inherit; padding: 6px 10px; border: 0; border-radius: 8px; background: #6b3fa0; color: #fff; cursor: pointer; }
    button.ghost { background: none; color: #565959; padding: 2px 4px; }
    .warn { color: #a01818; margin-top: 6px; }
  `;

  class Hud {
    constructor({ onAsk }) {
      this.host = document.createElement('div');
      const root = this.host.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>${HUD_CSS}</style>
        <div class="hud">
          <div class="top"><b>Peek</b><span class="stat">starting…</span></div>
          <form><input placeholder="Ask every product… e.g. is it waterproof?" maxlength="200"><button>Ask</button></form>
          <div class="warn" hidden></div>
        </div>`;
      this.stat = root.querySelector('.stat');
      this.warnEl = root.querySelector('.warn');
      const input = root.querySelector('input');
      root.querySelector('form').addEventListener('submit', (e) => {
        e.preventDefault();
        onAsk(input.value.trim());
      });
      document.documentElement.appendChild(this.host);
    }

    progress(done, total, ms) {
      this.stat.textContent = `${done}/${total} · ${(ms / 1000).toFixed(1)}s`;
    }

    warn(msg) {
      this.warnEl.hidden = !msg;
      this.warnEl.textContent = msg || '';
    }
  }

  return { Badge, Hud };
})();
