// Shared by content script, background and popup.
const PEEK_DEFAULTS = {
  enabled: true,
  serverUrl: 'http://localhost:8080',
  token: '',
  concurrency: 8,      // product pages fetched in parallel
  maxProducts: 24,     // cards processed per search page
  fields: { returns: true, bankOffers: true, warranty: true, delivery: false, seller: false, highlights: false },
};

async function peekSettings() {
  const stored = await chrome.storage.sync.get(PEEK_DEFAULTS);
  return { ...PEEK_DEFAULTS, ...stored, fields: { ...PEEK_DEFAULTS.fields, ...stored.fields } };
}

if (typeof self !== 'undefined') self.peekSettings = peekSettings;
