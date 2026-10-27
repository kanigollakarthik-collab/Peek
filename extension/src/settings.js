// Shared by content script, background and popup.

// The Peek server this build talks to. Set it to your deployed HTTPS address
// before zipping the extension for testers; it can also be changed in the
// popup under "Advanced".
const PEEK_SERVER_URL = 'https://peekshopping.duckdns.org';

const PEEK_DEFAULTS = {
  enabled: true,
  serverUrl: PEEK_SERVER_URL,
  concurrency: 8,      // product pages fetched in parallel
  maxProducts: 24,     // cards processed per search page
  fields: { returns: true, bankOffers: true, warranty: true, delivery: false, seller: false, highlights: false },
};

async function peekSettings() {
  const stored = await chrome.storage.sync.get(PEEK_DEFAULTS);
  return { ...PEEK_DEFAULTS, ...stored, fields: { ...PEEK_DEFAULTS.fields, ...stored.fields } };
}

const peekServerBase = (settings) => String(settings.serverUrl || PEEK_SERVER_URL).trim().replace(/\/+$/, '');

// The signed-in session ({ token, email, role }). Kept in storage.local, so
// it stays on this computer and is never synced to other devices.
async function peekAuth() {
  const { auth } = await chrome.storage.local.get('auth');
  return auth && auth.token ? auth : null;
}
const peekSetAuth = (auth) => chrome.storage.local.set({ auth });
const peekClearAuth = () => chrome.storage.local.remove('auth');

if (typeof self !== 'undefined') {
  Object.assign(self, { peekSettings, peekServerBase, peekAuth, peekSetAuth, peekClearAuth });
}
