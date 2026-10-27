import { ParseError } from './router.js';

const MAX_TEXT = 4000;

// Pull the first JSON object out of a model reply, tolerating ```json fences
// and chatter around it (some free providers have no strict JSON mode).
export function parseJsonObject(content) {
  const text = String(content).replace(/```(?:json)?/gi, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new ParseError('no JSON object in reply');
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new ParseError('invalid JSON in reply');
  }
}

const str = (v) => (typeof v === 'string' && v.trim() && !/^(null|n\/a|none|unknown)$/i.test(v.trim()) ? v.trim() : null);

const FACTS_SCHEMA = `{
  "returnType": "return" | "replacement" | "none" | null,
  "returnDays": number | null,
  "returnPolicy": string | null,   // e.g. "10 days replacement only", "Non-returnable"
  "bankOffers": string | null,     // best bank/card discount, e.g. "10% off up to ₹1,500 on HDFC cards"
  "otherOffers": string | null,    // cashback, no-cost EMI, partner offers
  "warranty": string | null,       // e.g. "1 year manufacturer warranty"
  "delivery": string | null,       // e.g. "Free delivery Tue, 28 Oct"
  "seller": string | null,
  "highlights": string | null      // the 3 most important specs, comma separated
}`;

function normalizeFacts(o) {
  const returnType = ['return', 'replacement', 'none'].includes(o.returnType) ? o.returnType : null;
  const days = Number(o.returnDays);
  return {
    returnType,
    returnDays: Number.isFinite(days) && days > 0 ? days : null,
    returnPolicy: str(o.returnPolicy),
    bankOffers: str(o.bankOffers),
    otherOffers: str(o.otherOffers),
    warranty: str(o.warranty),
    delivery: str(o.delivery),
    seller: str(o.seller),
    highlights: str(o.highlights),
  };
}

const productBlock = (p) => `Title: ${p.title || ''}\n\n${String(p.text || '').slice(0, MAX_TEXT)}`;

export function factsTask(product) {
  return {
    maxTokens: 800, // room for reasoning models; others stop early
    messages: [
      {
        role: 'system',
        content:
          'You extract shopping facts from Amazon.in product page text. ' +
          `Reply with one JSON object only, exactly this shape:\n${FACTS_SCHEMA}\n` +
          'Each string at most 12 words. Use null when the text does not say. Never guess.',
      },
      { role: 'user', content: productBlock(product) },
    ],
    parse(content) {
      return normalizeFacts(parseJsonObject(content));
    },
  };
}

// Several products in one call: free tiers cap requests per minute, so
// batching multiplies how many products each key can handle.
// parse() returns one entry per product, null where the model skipped one.
function batchReply(content, count, normalize) {
  const o = parseJsonObject(content);
  if (!Array.isArray(o.products)) throw new ParseError('reply has no products array');
  const out = new Array(count).fill(null);
  o.products.forEach((item, i) => {
    if (!item || typeof item !== 'object') return;
    const n = Number(item.n);
    const idx = Number.isInteger(n) && n >= 1 && n <= count ? n - 1 : i;
    if (idx < count && out[idx] == null) out[idx] = normalize(item);
  });
  if (out.every((v) => v == null)) throw new ParseError('reply matched no products');
  return out;
}

const numbered = (products) =>
  products.map((p, i) => `### Product ${i + 1}\n${productBlock(p)}`).join('\n\n');

export function factsBatchTask(products) {
  return {
    maxTokens: 250 * products.length + 400,
    messages: [
      {
        role: 'system',
        content:
          'You extract shopping facts from Amazon.in product page text. ' +
          `You get ${products.length} products, each starting with "### Product N". ` +
          'Reply with one JSON object only: {"products": [ ... ]} with exactly one entry per product, ' +
          `in order. Each entry is {"n": N, ...} plus exactly these fields:\n${FACTS_SCHEMA}\n` +
          'Each string at most 12 words. Use null when that product\'s text does not say. Never guess, ' +
          'and never mix up facts between products.',
      },
      { role: 'user', content: numbered(products) },
    ],
    parse: (content) => batchReply(content, products.length, normalizeFacts),
  };
}

const normalizeAnswer = (o) => ({ answer: str(o.answer), evidence: str(o.evidence) });

export function askBatchTask(question, products) {
  return {
    maxTokens: 120 * products.length + 400,
    messages: [
      {
        role: 'system',
        content:
          'Answer a shopper\'s question about each product using ONLY that product\'s page text. ' +
          `You get ${products.length} products, each starting with "### Product N". ` +
          'Reply with one JSON object only: {"products": [{"n": N, "answer": string | null, "evidence": string | null}, ...]} ' +
          'with exactly one entry per product, in order. answer: at most 15 words. ' +
          'evidence: a short quote from that product\'s text. If its text does not contain the answer, use null for both.',
      },
      { role: 'user', content: `Question: ${question}\n\n${numbered(products)}` },
    ],
    parse: (content) => batchReply(content, products.length, normalizeAnswer),
  };
}

export function askTask(question, product) {
  return {
    maxTokens: 400,
    messages: [
      {
        role: 'system',
        content:
          'Answer a shopper\'s question about one product using ONLY the given product page text. ' +
          'Reply with one JSON object only: {"answer": string | null, "evidence": string | null}. ' +
          'answer: at most 15 words. evidence: a short quote from the text. ' +
          'If the text does not contain the answer, use null for both.',
      },
      {
        role: 'user',
        content:
          `Question: ${question}\n\nTitle: ${product.title || ''}\n\n` +
          String(product.text || '').slice(0, MAX_TEXT),
      },
    ],
    parse(content) {
      return normalizeAnswer(parseJsonObject(content));
    },
  };
}
